/** Agent-owned PTY transport. Production factory has no shell/env/cwd override wire surface.
 * A reservation must already exist before constructing a backend. */
import { writePhysicalReceipt, type TerminalReceiptContext } from "../../protocol/terminal-local.js";
import type { TerminalLocalReference } from "../../protocol/terminal.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { systemClock, type TimerHandle } from "../../../core/clock.js";
import { clampSpanMs } from "../../../core/deadline.js";
import {
  TERMINAL_LIMITS as L,
  canonicalBase64Bytes,
  type TerminalAgentDisplayMetadata,
} from "../../protocol/terminal.js";
import {
  assertTerminalFixture,
  cleanTerminalEnvironment,
  terminalDisplayMetadata,
  TerminalBackendError,
  type TerminalTestFixture,
} from "./environment.js";
import { TERMINAL_PYTHON_HELPER } from "./python-helper.js";
import {
  readTerminalIdentity,
  sameTerminalProcess,
  scanTerminalSession,
  terminalIdentitiesGone,
  type ManagedIdentity,
} from "./reaper.js";

export interface TerminalBackendOptions {
  cwd: string;
  cols: number;
  rows: number;
  inputIdleMs: number;
  maxLifetimeMs: number;
  /** Trusted host snapshot; not request data. */
  environment?: Readonly<Record<string, unknown>>;
  receiptContext?: TerminalReceiptContext;
  onData(bytes: Buffer): void;
  onManaged?(): void;
}
export interface TerminalPhysicalResult {
  receipt?: TerminalLocalReference;
  outcome: "reaped" | "reap_incomplete";
  spawnSettled: boolean;
  ptyClosed: boolean;
  helperReaped: boolean;
  managedGroupsGone: boolean;
  identitiesChecked: ManagedIdentity[];
  waited: number[];
  exitCode?: number;
  signal?: "SIGHUP" | "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGQUIT";
}
/** Body-free startup evidence, internal only; never a terminal wire/result field. */
export interface TerminalBackendDiagnostic {
  capable: boolean;
  ready: boolean;
  failure?: string;
  closing?: string;
  reap?: {
    invalid: boolean;
    helperReaped: boolean;
    spawnSettled: boolean;
    report: string;
    ptyClosed: boolean;
    groupsProven: boolean;
    identitiesGone: boolean;
  };
}
export interface TerminalBackend {
  readonly diagnostic?: TerminalBackendDiagnostic;
  readonly ready: Promise<void>;
  readonly done: Promise<TerminalPhysicalResult>;
  readonly managed: readonly ManagedIdentity[];
  readonly display?: TerminalAgentDisplayMetadata;
  readonly spawnSettled: boolean;
  input(seq: number, bytes: Buffer, kind: "user" | "terminal_response"): Promise<void>;
  resize(seq: number, cols: number, rows: number, redraw?: boolean): Promise<void>;
  close(): void;
  /** Identity-checked fallback; success only with a full local helper receipt + actual wait. */
  retryReap(): Promise<TerminalPhysicalResult>;
}
function pythonPath(): string {
  if (process.platform !== "linux") throw new TerminalBackendError("E_BACKEND_CAPABILITY");
  for (const path of ["/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"]) {
    try {
      const p = realpathSync(path);
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* controlled candidates only */
    }
  }
  throw new TerminalBackendError("E_BACKEND_CAPABILITY");
}
export function createTerminalBackend(options: TerminalBackendOptions): TerminalBackend {
  return new PythonTerminalBackend(options);
}
/** Internal fixture factory: all fixture paths/uid validated BEFORE spawning anything.
 * Not exported from agent/index or any production settings/HTTP API. */
export function createTerminalTestBackend(
  options: TerminalBackendOptions,
  fixture: TerminalTestFixture,
): TerminalBackend {
  assertTerminalFixture(fixture);
  if (options.cwd !== fixture.cwd) throw new TerminalBackendError("E_BAD_REQUEST");
  return new PythonTerminalBackend(options, fixture);
}
class PythonTerminalBackend implements TerminalBackend {
  readonly ready: Promise<void>;
  readonly done: Promise<TerminalPhysicalResult>;
  readonly diagnostic: TerminalBackendDiagnostic = { capable: false, ready: false };
  private readyResolve!: () => void;
  private readyReject!: (error: TerminalBackendError) => void;
  private doneResolve!: (result: TerminalPhysicalResult) => void;
  private child: ChildProcessWithoutNullStreams;
  private known = new Map<string, ManagedIdentity>();
  private timers = new Set<TimerHandle>();
  private startup: TimerHandle | undefined;
  private probe: TimerHandle | undefined;
  private heartbeat: TimerHandle | undefined;
  private silence: TimerHandle | undefined;
  private closed = false;
  private childReaped = false;
  private settled = false;
  private readySettled = false;
  private report: Record<string, unknown> | undefined;
  private stdout = "";
  private invalid = false;
  private result: TerminalPhysicalResult | undefined;
  private receipt: TerminalLocalReference | undefined;
  private receiptWork: Promise<void> | undefined;
  private reapDeadlineAt: number | undefined;
  private metadata: TerminalAgentDisplayMetadata = {};
  private resizeActive = false;
  private resizeQueued:
    | {
        seq: number;
        cols: number;
        rows: number;
        redraw: boolean;
        promise: Promise<void>;
        resolve(): void;
        reject(e: unknown): void;
      }
    | undefined;
  get display(): TerminalAgentDisplayMetadata {
    return { ...this.metadata };
  }
  private controls = new Map<
    string,
    { resolve(): void; reject(error: TerminalBackendError): void; timer: TimerHandle }
  >();
  get managed(): readonly ManagedIdentity[] {
    return [...this.known.values()];
  }
  get spawnSettled(): boolean {
    return this.settled;
  }
  constructor(
    private readonly options: TerminalBackendOptions,
    fixture?: TerminalTestFixture,
  ) {
    if (
      !options.cwd ||
      options.cwd.includes("\0") ||
      !Number.isInteger(options.cols) ||
      !Number.isInteger(options.rows) ||
      options.cols < 2 ||
      options.cols > 500 ||
      options.rows < 1 ||
      options.rows > 200
    )
      throw new TerminalBackendError("E_BAD_REQUEST");
    const inputIdleMs = clampSpanMs(options.inputIdleMs),
      maxLifetimeMs = clampSpanMs(options.maxLifetimeMs);
    if (inputIdleMs === undefined || maxLifetimeMs === undefined || inputIdleMs === 0 || maxLifetimeMs === 0)
      throw new TerminalBackendError("E_BAD_REQUEST");
    const env = cleanTerminalEnvironment(options.environment ?? process.env);
    const python = pythonPath();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Owner may be closing before it starts awaiting; never create unhandled rejections.
    void this.ready.catch(() => undefined);
    this.done = new Promise((resolve) => {
      this.doneResolve = resolve;
    });
    this.child = spawn(python, ["-I", "-S", "-B", "-u", "-c", TERMINAL_PYTHON_HELPER], {
      env,
      stdio: "pipe",
      detached: true,
    });
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as typeof stream & { unref?(): void }).unref?.();
      stream.on("error", () => this.close());
    }
    this.child.on("spawn", () => {
      if (this.child.pid)
        void readTerminalIdentity(this.child.pid, "helper").then(
          (i) => {
            if (i) this.remember([i]);
            else this.invalid = true;
          },
          () => {
            this.invalid = true;
            this.close();
          },
        );
      if (this.closed) this.write({ op: "close" });
    });
    this.child.on("error", () => {
      this.diagnostic.failure ??= "child-error";
      this.invalid = true;
      this.failReady("E_BACKEND_CAPABILITY");
      this.close();
    });
    this.child.on("close", () => {
      if (!this.diagnostic.ready) this.diagnostic.failure ??= "child-close-before-ready";
      this.childReaped = true;
      this.settled = true; // OS child wait completed; no further fork/exec can occur.
      this.clearAll();
      this.failReady("E_BACKEND_CAPABILITY");
      for (const c of this.controls.values()) c.reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
      this.controls.clear();
      void this.finish();
    });
    this.child.stdout.on("data", (b: Buffer) => this.receive(b));
    // Fixed, body-free diagnostics only. No traceback or forwarded stderr.
    this.child.stderr.on("data", (b: Buffer) => {
      if (b.length) {
        this.diagnostic.failure ??= "helper-stderr";
        this.invalid = true;
        this.close();
      }
    });
    this.probe = this.timer(L.probeMs, () => {
      this.diagnostic.failure ??= "capability-deadline";
      this.failReady("E_BACKEND_CAPABILITY");
      this.close();
    });
    this.startup = this.timer(L.startupMs, () => {
      this.diagnostic.failure ??= "startup-deadline";
      this.failReady("E_DEADLINE");
      this.close();
    });
    this.write({
      op: "start",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      inputIdleMs,
      maxLifetimeMs,
      ...(fixture
        ? {
            fixture: {
              uid: fixture.uid,
              gid: fixture.gid,
              home: fixture.home,
              shell: fixture.shell,
              shellKind: fixture.shellKind,
              startDelayMs: fixture.startDelayMs,
              execDelayMs: fixture.execDelayMs,
            },
          }
        : {}),
    });
    this.beat();
  }
  private timer(ms: number, fn: () => void): TimerHandle {
    const h = systemClock.setTimer(clampSpanMs(ms) ?? 0, () => {
      this.timers.delete(h);
      fn();
    });
    this.timers.add(h);
    return h;
  }
  private clear(h: TimerHandle | undefined): void {
    if (h) {
      systemClock.clearTimer(h);
      this.timers.delete(h);
    }
  }
  private clearAll(): void {
    for (const h of this.timers) systemClock.clearTimer(h);
    this.timers.clear();
  }
  private beat(): void {
    if (this.closed) return;
    this.write({ op: "heartbeat" });
    this.heartbeat = this.timer(L.heartbeatMs, () => this.beat());
  }
  private failReady(code: TerminalBackendError["code"]): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyReject(new TerminalBackendError(code));
  }
  private remember(raw: unknown[]): void {
    for (const row of raw) {
      if (!row || typeof row !== "object") {
        this.invalid = true;
        continue;
      }
      const i = row as ManagedIdentity;
      if (
        !Number.isInteger(i.pid) ||
        i.pid <= 0 ||
        !/^\d+$/.test(i.starttime) ||
        typeof i.bootId !== "string" ||
        i.uid !== process.getuid?.() ||
        !Number.isInteger(i.sid) ||
        !Number.isInteger(i.pgid)
      ) {
        this.invalid = true;
        continue;
      }
      // A PID can legitimately move between job-control groups/roles. Inventory and
      // immutable receipts must retain every previously advertised observation.
      const key = JSON.stringify([i.bootId, i.pid, i.starttime, i.uid, i.sid, i.pgid, i.role]);
      if (!this.known.has(key) && this.known.size >= 256) {
        this.invalid = true;
        this.close();
        return;
      }
      this.known.set(key, { ...i });
      if (this.known.size > 256) {
        this.invalid = true;
        this.close();
        return;
      }
    }
    try {
      this.options.onManaged?.();
    } catch {
      this.invalid = true;
      this.close();
    }
  }
  private receive(bytes: Buffer): void {
    // Base64/control is ASCII. One bounded decoder buffer; never log frames.
    this.stdout += bytes.toString("ascii");
    if (this.stdout.length > L.helperPendingBytes) {
      this.invalid = true;
      this.close();
      return;
    }
    let end: number;
    while ((end = this.stdout.indexOf("\n")) >= 0) {
      const line = this.stdout.slice(0, end);
      this.stdout = this.stdout.slice(end + 1);
      if (line.length > L.frameBytes) {
        this.invalid = true;
        this.close();
        return;
      }
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.invalid = true;
        this.close();
        return;
      }
      this.clear(this.silence);
      this.silence = this.timer(L.helperSilenceMs, () => this.close());
      if (Array.isArray(f.managed)) this.remember(f.managed);
      switch (f.t) {
        case "capable":
          this.diagnostic.capable = true;
          if (f.version !== 1 || f.subreaper !== true || f.adoptionExit !== 23) {
            this.invalid = true;
            this.close();
          }
          this.clear(this.probe);
          break;
        case "ready":
          this.diagnostic.ready = true;
          this.metadata = terminalDisplayMetadata(f.display, this.options.cwd);
          this.settled = true;
          if (!this.closed && !this.readySettled) {
            this.readySettled = true;
            this.clear(this.startup);
            this.readyResolve();
          } else this.close();
          break;
        case "spawn":
        case "managed":
          break;
        case "closing":
          if (
            [
              "identity-unavailable",
              "spawn-failed",
              "unsupported-shell",
              "startup-deadline",
              "requested",
              "exec-failed",
            ].includes(String(f.reason))
          )
            this.diagnostic.closing = String(f.reason);
          break;
        case "data": {
          if (typeof f.bytesB64 !== "string" || (canonicalBase64Bytes(f.bytesB64) ?? Infinity) > L.outputChunkBytes) {
            this.invalid = true;
            this.close();
            break;
          }
          if (!this.closed) {
            try {
              this.options.onData(Buffer.from(f.bytesB64, "base64"));
            } catch {
              this.close();
            }
          }
          break;
        }
        case "input":
        case "resized": {
          const key = `${f.t}:${f.seq}`;
          const c = this.controls.get(key);
          if (c) {
            this.controls.delete(key);
            this.clear(c.timer);
            c.resolve();
          }
          break;
        }
        case "reaped":
        case "incomplete":
          this.report = f;
          break;
        case "error":
          this.diagnostic.failure ??= [
            "scan-vanished",
            "scan-denied",
            "scan-budget",
            "scan-invalid",
            "subreaper",
          ].includes(String(f.reason))
            ? String(f.reason)
            : "helper-error";
          this.failReady("E_BACKEND_CAPABILITY");
          this.close();
          break;
        default:
          this.invalid = true;
          this.close();
      }
    }
  }
  private write(frame: object): boolean {
    if (this.childReaped || this.child.stdin.destroyed) return false;
    const line = JSON.stringify(frame) + "\n";
    if (
      Buffer.byteLength(line) > L.frameBytes ||
      this.child.stdin.writableLength + Buffer.byteLength(line) > L.inputPendingBytes
    )
      return false;
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }
  private control(key: string, frame: object): Promise<void> {
    if (this.closed || this.controls.size >= 2) return Promise.reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
    return new Promise((resolve, reject) => {
      const timer = this.timer(L.controlMs, () => {
        this.controls.delete(key);
        reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
        this.close();
      });
      this.controls.set(key, { resolve, reject, timer });
      if (!this.write(frame)) {
        this.clear(timer);
        this.controls.delete(key);
        reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
        this.close();
      }
    });
  }
  input(seq: number, bytes: Buffer, kind: "user" | "terminal_response"): Promise<void> {
    if (!bytes.length) return Promise.resolve();
    if (bytes.length > L.inputBytes) return Promise.reject(new TerminalBackendError("E_BAD_REQUEST"));
    return this.control(`input:${seq}`, { op: "input", seq, bytesB64: bytes.toString("base64"), kind });
  }
  resize(seq: number, cols: number, rows: number, redraw = false): Promise<void> {
    if (this.closed) return Promise.reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
    if (this.resizeQueued) {
      Object.assign(this.resizeQueued, { seq, cols, rows, redraw });
      return this.resizeQueued.promise;
    }
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.resizeQueued = { seq, cols, rows, redraw, promise, resolve, reject };
    if (!this.resizeActive) this.timer(75, () => this.flushResize());
    return promise;
  }
  private flushResize(): void {
    if (this.resizeActive || !this.resizeQueued) return;
    const batch = this.resizeQueued;
    this.resizeQueued = undefined;
    if (this.closed) {
      batch.reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
      return;
    }
    this.resizeActive = true;
    void this.control(`resized:${batch.seq}`, {
      op: "resize",
      seq: batch.seq,
      cols: batch.cols,
      rows: batch.rows,
      redraw: batch.redraw,
    })
      .then(batch.resolve, batch.reject)
      .finally(() => {
        this.resizeActive = false;
        if (this.resizeQueued) this.timer(75, () => this.flushResize());
      });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reapDeadlineAt = systemClock.now() + L.reapMs;
    this.metadata = {};
    if (this.childReaped) return;
    this.resizeQueued?.reject(new TerminalBackendError("E_UNKNOWN_EFFECT"));
    this.resizeQueued = undefined;
    this.failReady("E_DEADLINE");
    this.clear(this.heartbeat);
    this.clear(this.probe);
    this.clear(this.startup);
    this.clear(this.silence);
    this.write({ op: "close" });
    // EOF is an independent cleanup signal if the command was backpressured.
    this.child.stdin.end();
    this.timer(L.reapMs, () => {
      this.resolveIncomplete(); // The 5s caller budget ends here; it never releases a slot.
      void this.fallbackKill("SIGKILL");
      // Destroy pipes after the bounded drain; child close will resolve done after actual wait.
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.timer(250, () => {
        if (!this.childReaped) this.resolveIncomplete();
      });
    });
  }
  private async fallbackKill(signal: NodeJS.Signals): Promise<void> {
    const shell = [...this.known.values()].find((i) => i.role === "shell");
    if (shell) {
      const found = await scanTerminalSession(shell.sid, this.managed);
      if (!found) this.invalid = true;
      else this.remember(found);
    }
    for (const i of this.known.values()) {
      try {
        const current = await readTerminalIdentity(i.pid);
        if (!current || !sameTerminalProcess(i, current)) continue;
        process.kill(i.pid, "SIGCONT");
        process.kill(i.pid, signal);
      } catch {
        this.invalid = true;
      }
    }
    if (this.child.pid && !this.known.size) {
      // Node's child handle still refers to its own unreaped child, not an arbitrary PID.
      this.child.kill(signal);
    }
  }
  private resolveIncomplete(): void {
    if (this.result) return;
    this.result = {
      outcome: "reap_incomplete",
      spawnSettled: this.settled,
      ptyClosed: false,
      helperReaped: this.childReaped,
      managedGroupsGone: false,
      identitiesChecked: [...this.managed],
      waited: [],
    };
    this.doneResolve(this.result);
  }
  private async finish(): Promise<void> {
    // Child close is not the end of the existing physical-proof budget. A loaded
    // filesystem may need >250ms for real /proc checks; keep the SAME close deadline.
    const deadline = this.timer(
      Math.max(0, (this.reapDeadlineAt ?? systemClock.now() + L.reapMs) - systemClock.now()),
      () => {
        this.diagnostic.failure ??= "reap-proof-deadline";
        this.resolveIncomplete();
      },
    );
    try {
      const r = await this.retryReap();
      if (!this.result) {
        this.result = r;
        this.doneResolve(r);
      }
    } finally {
      this.clear(deadline);
    }
  }
  async retryReap(): Promise<TerminalPhysicalResult> {
    if (!this.childReaped || this.report?.t !== "reaped") await this.fallbackKill("SIGKILL");
    const report = this.report;
    const gone = await terminalIdentitiesGone(this.managed);
    const proven =
      !this.invalid &&
      this.childReaped &&
      this.settled &&
      report?.t === "reaped" &&
      report.ptyClosed === true &&
      report.spawnSettled === true &&
      report.managedGroupsGone === true &&
      gone;
    this.diagnostic.reap = {
      invalid: this.invalid,
      helperReaped: this.childReaped,
      spawnSettled: this.settled,
      report: report?.t === "reaped" ? "reaped" : report?.t === "incomplete" ? "incomplete" : "missing",
      ptyClosed: report?.ptyClosed === true,
      groupsProven: report?.managedGroupsGone === true,
      identitiesGone: gone,
    };
    const signal = report?.signal;
    if (proven && this.options.receiptContext && !this.receipt) {
      this.receiptWork ??= writePhysicalReceipt(this.options.receiptContext, {
        outcome: "reaped",
        spawnSettled: true,
        ptyClosed: true,
        helperReaped: true,
        managedGroupsGone: true,
        identitiesChecked: [...this.managed],
        waited: Array.isArray(report?.waited) ? (report.waited as number[]) : [],
      })
        .then(
          (reference) => {
            this.receipt = reference;
          },
          () => {},
        )
        .finally(() => {
          this.receiptWork = undefined;
        });
      await this.receiptWork;
    }
    return {
      outcome: proven && (!this.options.receiptContext || this.receipt) ? "reaped" : "reap_incomplete",
      ...(this.receipt ? { receipt: { ...this.receipt } } : {}),
      spawnSettled: this.settled,
      ptyClosed: report?.ptyClosed === true,
      helperReaped: this.childReaped,
      managedGroupsGone: gone && proven,
      identitiesChecked: [...this.managed],
      waited: Array.isArray(report?.waited) ? (report.waited as number[]) : [],
      ...(typeof report?.exitCode === "number" ? { exitCode: report.exitCode } : {}),
      ...(typeof signal === "string" && ["SIGHUP", "SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"].includes(signal)
        ? { signal: signal as NonNullable<TerminalPhysicalResult["signal"]> }
        : {}),
    };
  }
}
