import { spawn, type ChildProcess } from "node:child_process";

/** Per independent boot; ready/live share this budget, concurrent boots use the critical path. */
export const PROCESS_STARTUP_MS = 30_000;
/** Setup + post-ready protocol/exit allowance. Individual event limits are NOT changed. */
export const STARTUP_MARGIN_MS = 30_000;
export function startupBudget(serialBoots: number, perBootMs = PROCESS_STARTUP_MS): number {
  return serialBoots * perBootMs;
}

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

/** One monotonic budget for spawn + ready + live. Not a latency benchmark;
 * post-start protocol/assertion budgets must remain separate. Observe every
 * contender: singleton losers may exit while the winner is still booting. */
export class ProcessStartup {
  private readonly started = performance.now();
  readonly children: ChildProcess[] = [];
  private readonly changed = new Set<() => void>();
  private readonly ended: Array<() => boolean> = [];
  private readonly diagnostics: Array<() => string> = [];

  constructor(private readonly budgetMs = PROCESS_STARTUP_MS) {}

  observe(child: ChildProcess, label = "child"): ChildProcess {
    this.children.push(child);
    this.ended.push(() => child.exitCode !== null || child.signalCode !== null);
    let stderr = "";
    let error = "";
    let partial = "";
    child.stderr?.on("data", (b: Buffer) => {
      // Keep partial lines together (secrets can straddle stream chunks).
      const lines = (partial + b.toString()).split("\n");
      partial = lines.pop()!;
      stderr = sanitizeDiagnostic(stderr + lines.join("\n") + (lines.length ? "\n" : ""));
      if (partial.length > 64_000) partial = sanitizeDiagnostic(partial);
    });
    child.on("error", (e) => {
      error = sanitizeDiagnostic(e.message);
      for (const changed of this.changed) changed();
    });
    child.on("exit", () => {
      for (const changed of this.changed) changed();
    });
    this.diagnostics.push(() =>
      sanitizeDiagnostic(
        `${label} pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode} error=${error} stderr=${stderr}${partial}`,
      ),
    );
    return child;
  }

  /** Preserve production args/env/detachment; only open stderr for diagnostics. */
  readonly spawn: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
    this.observe(spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] }))) as typeof spawn;

  /** For managed grandchildren, use the hub's persisted lifecycle (never signal a
   * pid found on disk). Missing records are not evidence of process death. */
  observeManaged(
    read: () => { pid?: number; state?: string; exit?: { code: number | null; signal: string | null } } | undefined,
    stderr: () => string,
    label: string,
  ): void {
    this.ended.push(() => ["failed", "exited"].includes(read()?.state ?? ""));
    this.diagnostics.push(() => {
      const r = read();
      return sanitizeDiagnostic(
        `${label} pid=${r?.pid} exit=${r?.exit ? r.exit.code : "unknown"} signal=${r?.exit ? r.exit.signal : "unknown"} state=${r?.state} stderr=${stderr()}`,
      );
    });
  }

  diagnostic(): string {
    return this.diagnostics.map((d) => d()).join("\n");
  }

  async wait<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
    const end = this.started + this.budgetMs;
    let last: T | undefined;
    const failure = (reason: string) =>
      new Error(
        `${sanitizeDiagnostic(`${reason}: ${label}; waited=${Math.round(performance.now() - this.started)}ms budget=${this.budgetMs}ms last=${JSON.stringify(last)}`)}\n${this.diagnostic()}`,
      );
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let tick: NodeJS.Timeout | undefined;
    let changed: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("startup timeout")), Math.max(0, end - performance.now()));
      timer.unref();
    });
    // Also monitor while an async readiness read is outstanding. A dead child
    // must never leave an unresolved IPC read consuming the whole boot budget.
    const exited = new Promise<never>((_, reject) => {
      changed = () => {
        if (this.ended.length > 0 && this.ended.every((done) => done())) {
          reject(new Error("all children exited before ready"));
        }
      };
      this.changed.add(changed);
      poll = setInterval(changed, 25);
      poll.unref();
    });
    try {
      for (;;) {
        if (performance.now() >= end) throw new Error("startup timeout");
        last = await Promise.race([Promise.resolve().then(read), deadline, exited]);
        if (accept(last)) return last;
        await Promise.race([
          new Promise<void>((r) => {
            tick = setTimeout(r, 25);
            tick.unref();
          }),
          deadline,
          exited,
        ]);
      }
    } catch (e) {
      // Errors thrown by an IPC read can contain inherited-env stderr too.
      throw failure(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(tick);
      if (changed) this.changed.delete(changed);
    }
  }
}
