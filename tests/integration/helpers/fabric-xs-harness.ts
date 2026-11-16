import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Startup is a liveness barrier, not a latency benchmark. Keep one 30s total boot
 * budget (ready + live) for loaded runners; ordinary RPC/event budgets stay 12s. */
const BOOT_MS = 30_000;

/** Diagnostic hygiene for inherited-env children. Redact BEFORE applying the byte cap. */
export function sanitizeDiagnostic(text: string): string {
  const clean = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]")
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(
      /((?:[\w-]*(?:token|api[-_]?key|secret|password)[\w-]*)["']?\s*[:=]\s*)["']?[^\s,;"'\r\n}]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:[a-f0-9]{32,}|[A-Za-z0-9+/_-]{48,}={0,2})\b/gi, "[REDACTED]")
    // Whole secret-named identifiers can be echoed by parsers without a key=value context.
    .replace(
      /[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|cookie|credential|bearer)[A-Za-z0-9_.-]*/gi,
      (word) => (word.length >= 12 || /[_-]/.test(word) ? "[REDACTED]" : word),
    );
  const bytes = Buffer.from(clean);
  if (bytes.length <= 12_000) return clean;
  // Keep lifecycle fields at the head AND recent stderr, without splitting UTF-8.
  const marker = "\n...[truncated]...\n";
  let headEnd = 1_000;
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  let tailStart = bytes.length - (12_000 - headEnd - Buffer.byteLength(marker));
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  return bytes.subarray(0, headEnd).toString("utf8") + marker + bytes.subarray(tailStart).toString("utf8");
}

export function bounded<T>(p: Promise<T>, label: string, ms = 12_000, diagnostic = () => ""): Promise<T> {
  const started = performance.now();
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              sanitizeDiagnostic(
                `timeout: ${label}; waited=${Math.round(performance.now() - started)}ms budget=${ms}ms ${diagnostic()}`,
              ),
            ),
          ),
        ms,
      );
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  options: { timeoutMs?: number; diagnostic?: () => string } = {},
): Promise<T> {
  const ms = options.timeoutMs ?? 12_000;
  const started = performance.now();
  const end = started + ms;
  let last: T | undefined;
  const diagnostic = () => `last=${JSON.stringify(last)} ${options.diagnostic?.() ?? ""}`;
  do {
    // An individual RPC must not extend the enclosing barrier's total budget.
    last = await bounded(read(), label, Math.max(0, end - performance.now()), diagnostic);
    if (accept(last)) return last;
    await new Promise<void>((r) => {
      const timer = setTimeout(r, Math.min(30, Math.max(0, end - performance.now())));
      timer.unref();
    });
  } while (performance.now() < end);
  throw new Error(
    sanitizeDiagnostic(
      `timeout: ${label}; waited=${Math.round(performance.now() - started)}ms budget=${ms}ms ${diagnostic()}`,
    ),
  );
}
export interface Peer {
  child: ChildProcess;
  rpc<T = any>(op: string, extra?: Record<string, unknown>): Promise<T>;
  event(name: string): Promise<any>;
  kill(): Promise<void>;
}
export class XsHarness {
  readonly home = mkdtempSync(join(tmpdir(), "xw-"));
  readonly peers: Peer[] = [];
  private seq = 0;
  constructor(private readonly options: { processFile?: string; execPath?: string; bootMs?: number } = {}) {}
  async boot(
    role: "hub" | "agent",
    name: string = role,
    sessionFile?: string,
    xsEnabled = true,
    autoJoin = false,
    extraEnv: Record<string, string> = {},
  ): Promise<Peer> {
    const bootStarted = performance.now();
    const cwd = join(this.home, "project");
    mkdirSync(cwd, { recursive: true });
    const child = spawn(
      this.options.execPath ?? process.execPath,
      ["--import", "tsx", this.options.processFile ?? resolve("tests/integration/helpers/fabric-xs-process.ts"), role],
      {
        cwd: resolve("."),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          HOME: this.home,
          XDG_RUNTIME_DIR: "",
          PI_CODING_AGENT_DIR: join(this.home, `agent-${name}-${++this.seq}`),
          XW_NAME: name,
          XW_AUTO_JOIN: autoJoin ? "1" : "0",
          XW_XS_OFF: xsEnabled ? "0" : "1",
          ...extraEnv,
          ...(sessionFile ? { XW_SESSION_FILE: sessionFile } : {}),
        },
      },
    );
    let stderr = "";
    child.stderr!.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-12_000);
    });
    const diagnostic = () =>
      sanitizeDiagnostic(
        `${role}:${name} pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode} connected=${child.connected} stderr=${stderr}`,
      );
    const exited = new Promise<void>((r) => child.once("close", () => r()));
    const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
    const events = new Map<string, Array<(value: any) => void>>();
    let ready!: () => void;
    let failReady!: (e: Error) => void;
    const started = new Promise<void>((r, j) => {
      ready = r;
      failReady = j;
    });
    child.on("message", (m: any) => {
      if (m.ready) ready();
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
      }
      if (m.event) for (const f of events.get(m.event)?.splice(0) ?? []) f(m);
    });
    child.on("error", (error) => {
      const failure = new Error(sanitizeDiagnostic(`child error: ${error.message}; ${diagnostic()}`));
      failReady(failure);
      for (const p of pending.values()) p.reject(failure);
      pending.clear();
    });
    child.on("close", (code) => {
      const error = new Error(sanitizeDiagnostic(`child close code=${code}; ${diagnostic()}`));
      failReady(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    });
    let rid = 0;
    const peer: Peer = {
      child,
      rpc: (op, extra = {}) => {
        const id = ++rid;
        return bounded(
          new Promise<any>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ ...extra, id, op });
          }),
          `${role}:${op}`,
          12_000,
          diagnostic,
        ).finally(() => pending.delete(id));
      },
      event: (name) =>
        bounded(
          new Promise((r) => {
            events.set(name, [...(events.get(name) ?? []), r]);
          }),
          `${role}:${name}`,
          12_000,
          diagnostic,
        ),
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(exited, `${role} exit`);
      },
    };
    this.peers.push(peer);
    await bounded(
      started,
      `${role} ready`,
      Math.max(0, (this.options.bootMs ?? BOOT_MS) - (performance.now() - bootStarted)),
      diagnostic,
    );
    if (role === "agent")
      await until(
        () => peer.rpc("inspect"),
        (s) => s.conn?.state === "live",
        "socket live",
        { timeoutMs: Math.max(0, (this.options.bootMs ?? BOOT_MS) - (performance.now() - bootStarted)), diagnostic },
      );
    return peer;
  }
  async close(): Promise<void> {
    await Promise.all(this.peers.map((p) => p.kill()));
    rmSync(this.home, { recursive: true, force: true });
  }
}
export const list = (peer: Peer) => peer.rpc("tool", { name: "list_sessions" });
export const send = (peer: Peer, to: string, text: string, wake?: boolean) =>
  peer.rpc("tool", {
    name: "message_session",
    params: { to, text, ...(wake === undefined ? {} : { wake }) },
  });
export async function joinedPair(h: XsHarness): Promise<{ hub: Peer; a: Peer; b: Peer; aid: string; bid: string }> {
  const hub = await h.boot("hub");
  const [a, b] = await Promise.all([h.boot("agent", "alpha"), h.boot("agent", "beta")]);
  await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
  const aid = (await a.rpc("inspect")).sessionId,
    bid = (await b.rpc("inspect")).sessionId;
  await until(
    () => list(a),
    (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
    "membership publish",
  );
  return { hub, a, b, aid, bid };
}
