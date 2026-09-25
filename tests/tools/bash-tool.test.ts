import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashJobManager, type BashJobManager, type CreatedJob } from "../../src/bash/manager.js";
import { createJobStore } from "../../src/bash/job-store.js";
import type { HostRunView } from "../../src/bash/child-registry.js";
import type { JobRecord } from "../../src/bash/types.js";
import type {
  JobExit,
  KillJobTreeOptions,
  KillOutcome,
  PidIdentity,
  PidOwnership,
  ProcessPort,
  SpawnedJob,
} from "../../src/bash/process.js";
import { FakeClock } from "../../src/core/clock.js";
import {
  BashToolParams,
  createBashTool,
  formatDescriptionSuffix,
  type BashBackgroundDetails,
} from "../../src/tools/bash-tool.js";

/**
 * §10 T1-T9 for the bash override tool.
 *
 * The process boundary is faked (`tests/bash/process.test.ts` owns the real
 * spawn contract) but the job store, the log files and pi's *real* bash tool
 * definition are all genuine: T1's whole point is that the foreground path is
 * the built-in tool's own code, so proving it against a reimplementation would
 * prove nothing.
 */

const HUGE_THRESHOLD_MS = 10 * 60_000;

class FakeProc {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private settleExit!: (exit: JobExit) => void;
  private settleDrain!: (result: { exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }) => void;
  private lastExit: JobExit | undefined;
  readonly processExitPromise = new Promise<JobExit>((resolve) => {
    this.settleExit = resolve;
  });
  readonly drainedPromise = new Promise<{ exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }>((resolve) => {
    this.settleDrain = resolve;
  });
  constructor(readonly pid: number) {}

  get spawned(): SpawnedJob {
    return {
      pid: this.pid,
      pgid: this.pid,
      stdout: this.stdout,
      stderr: this.stderr,
      processExitPromise: this.processExitPromise,
      drainedPromise: this.drainedPromise,
    };
  }

  write(text: string): void {
    this.stdout.write(Buffer.from(text, "utf8"));
  }

  exitOnly(exit: Partial<JobExit> = {}): void {
    if (this.lastExit) return;
    this.lastExit = { exitCode: 0, signal: null, ...exit };
    this.settleExit(this.lastExit);
  }

  drain(stop: "ended" | "idle" | "capped" | "error" = "ended"): void {
    if (!this.lastExit) this.exitOnly();
    this.stdout.end();
    this.stderr.end();
    this.settleDrain({ exit: this.lastExit!, stop });
  }

  exit(exit: Partial<JobExit> = {}): void {
    this.exitOnly(exit);
    this.drain();
  }
}

class FakePort implements ProcessPort {
  readonly procs: FakeProc[] = [];
  readonly spawns: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  readonly killCalls: { pid: number; options?: KillJobTreeOptions }[] = [];
  nextPid = 7000;
  /** Runs right after a spawn resolves; drives the scripted output/exit. */
  script?: (proc: FakeProc) => void | Promise<void>;

  async spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob> {
    this.spawns.push({ command, cwd, ...(env !== undefined ? { env } : {}) });
    const proc = new FakeProc(this.nextPid++);
    this.procs.push(proc);
    if (this.script) setImmediate(() => void this.script?.(proc));
    return proc.spawned;
  }

  async killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome> {
    this.killCalls.push({ pid, ...(options !== undefined ? { options } : {}) });
    // A real kill ends the process; the tee/exit path must run identically.
    this.procs.find((proc) => proc.pid === pid)?.exit({ exitCode: null, signal: "SIGTERM" });
    return "terminated";
  }

  probePid(): boolean {
    return true;
  }
  readProcStartTime(): string | undefined {
    return undefined;
  }
  checkPidOwnership(identity: PidIdentity): PidOwnership {
    return identity.pid === undefined ? "dead" : "alive";
  }

  last(): FakeProc {
    const proc = this.procs[this.procs.length - 1];
    if (!proc) throw new Error("no fake process spawned");
    return proc;
  }
}

interface Harness {
  dir: string;
  port: FakePort;
  manager: BashJobManager;
  warnings: string[];
  ctx: ExtensionContext;
}

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function makeHarness(options: { maxBackgroundJobs?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-tool-"));
  const clock = new FakeClock(1_000);
  const store = createJobStore({ dir, retentionMs: 60_000, clock });
  const port = new FakePort();
  const warnings: string[] = [];
  const manager = createBashJobManager({
    store,
    processPort: port,
    clock,
    sessionId: "session-1",
    warn: (message) => warnings.push(message),
    ...(options.maxBackgroundJobs !== undefined ? { maxBackgroundJobs: options.maxBackgroundJobs } : {}),
  });
  disposers.push(() => {
    manager.dispose();
    return rm(dir, { recursive: true, force: true });
  });
  return { dir, port, manager, warnings, ctx: makeCtx(dir) };
}

function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
    model: { provider: "test", id: "test-model" },
    thinkingLevel: undefined,
  } as unknown as ExtensionContext;
}

/** Drain microtasks/immediates so stream + fs callbacks land. */
async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Every step of the manager's create path is a real filesystem round-trip, so
 * assertions wait for the observable effect rather than a fixed number of
 * event-loop turns (and `setImmediate` is never faked here, so this works with
 * `vi.useFakeTimers` too).
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function toolFor(harness: Harness, autoBackgroundMs: number) {
  return createBashTool({
    manager: () => harness.manager,
    autoBackgroundMs: () => autoBackgroundMs,
    warn: (message) => harness.warnings.push(message),
  });
}

// ── T1: golden equivalence with the built-in bash tool ─────────────────────

interface Scenario {
  name: string;
  chunks: string[];
  /** `undefined` for the abort/timeout paths (the process never exits cleanly). */
  exitCode?: number | null;
  kind?: "abort" | "timeout";
  timeout?: number;
}

const BIG_OUTPUT = `${Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n")}\n`;

const SCENARIOS: Scenario[] = [
  { name: "success with output", chunks: ["hello\n", "world\n"], exitCode: 0 },
  { name: "no output", chunks: [], exitCode: 0 },
  { name: "non-zero exit", chunks: ["boom\n"], exitCode: 3 },
  { name: "signal death (exitCode null)", chunks: ["partial\n"], exitCode: null },
  { name: "truncated output", chunks: [BIG_OUTPUT], exitCode: 0 },
  { name: "abort", chunks: ["before abort\n"], kind: "abort" },
  { name: "timeout", chunks: ["slow\n"], kind: "timeout", timeout: 0.05 },
];

/** Normalizes the per-run temp file path so two independent runs can be compared. */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) =>
      typeof raw === "string" ? raw.replace(/\/[^\s"]*pi-bash[^\s"\]]*/g, "<tmp>") : raw,
    ),
  );
}

type Captured = { ok: true; result: unknown } | { ok: false; message: string };

async function capture(run: () => Promise<unknown>): Promise<Captured> {
  try {
    return { ok: true, result: normalize(await run()) };
  } catch (error) {
    return { ok: false, message: (error as Error).message.replace(/\/[^\s"]*pi-bash[^\s"\]]*/g, "<tmp>") };
  }
}

describe("bash override tool — T1 built-in golden equivalence", () => {
  it("keeps the hand-written schema in sync with pi's bash schema (R7 drift guard)", () => {
    const inner = createBashToolDefinition(process.cwd());
    const innerProps = (inner.parameters as unknown as { properties: Record<string, { description?: string }> })
      .properties;
    expect(Object.keys(BashToolParams.properties)).toEqual(["command", "timeout", "run_in_background"]);
    expect(BashToolParams.properties.command.description).toBe(innerProps.command?.description);
    expect(BashToolParams.properties.timeout.description).toBe(innerProps.timeout?.description);
    // The override's static surface is pi's own, plus the threshold paragraph.
    const tool = createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 });
    expect(tool.name).toBe("bash");
    expect(tool.description.startsWith(inner.description)).toBe(true);
    expect(tool.promptSnippet).toBe(inner.promptSnippet);
    expect(tool.promptGuidelines).toEqual(inner.promptGuidelines);
  });

  it("documents the one-shot timer pattern with its guardrails", () => {
    const suffix = formatDescriptionSuffix(120_000);
    // Recipe: explicit background sleep whose notification is the wake-up.
    expect(suffix).toContain("One-shot timer");
    expect(suffix).toContain("sleep <seconds> && echo");
    expect(suffix).toMatch(/run_in_background: true — its completion notification wakes you/);
    // Guardrails: no polling, portable seconds, cancellable, not restart-safe.
    expect(suffix).toContain("never for polling");
    expect(suffix).toContain("no `date -d`");
    expect(suffix).toContain('bash_job(action: "kill"');
    expect(suffix).toContain("/reload may drop a sleeping timer");
    // The run_in_background param no longer claims fire-and-forget is its ONLY use.
    expect(BashToolParams.properties.run_in_background.description).toContain("one-shot timer");
  });

  for (const scenario of SCENARIOS) {
    it(`matches the built-in result for: ${scenario.name}`, async () => {
      const harness = await makeHarness();
      const params = {
        command: "run-it",
        ...(scenario.timeout !== undefined ? { timeout: scenario.timeout } : {}),
      };

      // (a) the built-in definition driven by fake operations.
      const builtinOps: BashOperations = {
        exec: async (_command, _cwd, options) => {
          if (options.signal?.aborted) throw new Error("aborted");
          for (const chunk of scenario.chunks) options.onData(Buffer.from(chunk, "utf8"));
          if (scenario.kind === "abort") {
            await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
            throw new Error("aborted");
          }
          if (scenario.kind === "timeout") {
            await new Promise((resolve) => setTimeout(resolve, (options.timeout ?? 0) * 1000 + 20));
            throw new Error(`timeout:${options.timeout}`);
          }
          return { exitCode: scenario.exitCode ?? 0 };
        },
      };
      const builtin = createBashToolDefinition(harness.dir, { operations: builtinOps });
      const builtinAbort = new AbortController();
      const builtinRun = capture(() =>
        builtin.execute("call-1", params as never, builtinAbort.signal, undefined, harness.ctx),
      );
      if (scenario.kind === "abort") {
        await settle(5);
        builtinAbort.abort();
      }
      const builtinResult = await builtinRun;

      // (b) the override tool over a process port scripted to the same bytes.
      harness.port.script = (proc) => {
        for (const chunk of scenario.chunks) proc.write(chunk);
        if (scenario.kind === undefined) proc.exit({ exitCode: scenario.exitCode ?? 0, signal: null });
      };
      const tool = toolFor(harness, HUGE_THRESHOLD_MS);
      const overrideAbort = new AbortController();
      const overrideRun = capture(() => tool.execute("call-2", params, overrideAbort.signal, undefined, harness.ctx));
      if (scenario.kind === "abort") {
        await settle(5);
        overrideAbort.abort();
      }
      const overrideResult = await overrideRun;

      expect(overrideResult).toEqual(builtinResult);
    });
  }
});

// ── T2-T9: auto-background behaviour ───────────────────────────────────────

describe("bash override tool — auto-background", () => {
  it("T2: downgrades to a job once the threshold expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("still working\n");
    const updates: unknown[] = [];
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "npm run build" }, undefined, (u) => updates.push(u), harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    await settle();
    const updatesBefore = updates.length;
    expect(harness.port.spawns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    const result = await run;

    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const details = result.details as BashBackgroundDetails;
    expect(details.background).toBe(true);
    expect(details.autoBackgrounded).toBe(true);
    expect(details.jobId).toMatch(/^b_[0-9A-Z]{8}$/);
    expect(details.pid).toBe(harness.port.last().pid);
    expect(details.logPath).toContain(details.jobId);
    expect(text).toContain(details.jobId);
    expect(text).toContain("NOT killed");
    expect(text).toContain('bash_job(action: "status"');
    // Change A: no `output` action — the log is a plain file the model reads.
    expect(text).not.toContain('bash_job(action: "output"');
    expect(text).toMatch(/plain file/);
    expect(text).toMatch(/tail\/grep\/awk/);
    expect(text).toContain('bash_job(action: "kill"');
    // The process was not touched and the job is now notification-eligible.
    expect(harness.port.killCalls).toHaveLength(0);
    expect(harness.manager.get(details.jobId)?.status).toBe("running");
    expect(harness.manager.get(details.jobId)?.backgroundedAt).toBeDefined();

    // The update gate is closed: further output no longer reaches the caller.
    harness.port.last().write("late output\n");
    await settle();
    expect(updates.length).toBe(updatesBefore);
  });

  it("T3: a caller abort after backgrounding never reaches the process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("working\n");
    const controller = new AbortController();
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "sleep 900" }, controller.signal, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    const details = (await run).details as BashBackgroundDetails;

    controller.abort();
    await settle();
    expect(harness.port.killCalls).toHaveLength(0);
    expect(harness.manager.get(details.jobId)?.status).toBe("running");
  });

  it("T4: a caller abort before the threshold kills the tree and throws like the built-in", async () => {
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("partial\n");
    const controller = new AbortController();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);
    const run = tool.execute("call-1", { command: "sleep 900" }, controller.signal, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    controller.abort();

    // Byte-identical to the built-in: accumulated output, blank line, status.
    await expect(run).rejects.toThrow(/^partial\n+Command aborted$/);
    expect(harness.port.killCalls).toHaveLength(1);
    const job = harness.manager.list()[0]!;
    expect(job.status).toBe("killed");
  });

  it("T5: an already-aborted signal throws before anything spawns", async () => {
    const harness = await makeHarness();
    const controller = new AbortController();
    controller.abort();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);

    await expect(
      tool.execute("call-1", { command: "echo hi" }, controller.signal, undefined, harness.ctx),
    ).rejects.toThrow("Command aborted");
    expect(harness.port.spawns).toHaveLength(0);
    expect(harness.manager.list()).toHaveLength(0);
  });

  it("T6: aborting after a normal return has no effect (listener detached)", async () => {
    const harness = await makeHarness();
    harness.port.script = (proc) => {
      proc.write("done\n");
      proc.exit({ exitCode: 0, signal: null });
    };
    const controller = new AbortController();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);
    const result = await tool.execute("call-1", { command: "echo done" }, controller.signal, undefined, harness.ctx);
    expect(result.content[0]).toEqual({ type: "text", text: "done\n" });

    controller.abort();
    await settle();
    expect(harness.port.killCalls).toHaveLength(0);
  });

  it("T7: run_in_background returns immediately, and throws when the cap is full", async () => {
    const harness = await makeHarness({ maxBackgroundJobs: 1 });
    harness.port.script = (proc) => proc.write("bg\n");
    const tool = toolFor(harness, 120_000);

    const result = await tool.execute(
      "call-1",
      { command: "npm test", run_in_background: true },
      undefined,
      undefined,
      harness.ctx,
    );
    const details = result.details as BashBackgroundDetails;
    expect(details.background).toBe(true);
    expect(details.autoBackgrounded).toBeUndefined();
    expect(details.pid).toBe(harness.port.last().pid);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain(details.jobId);
    expect(text).toContain("NOT killed");
    expect(harness.manager.backgroundJobCount()).toBe(1);

    // Slot full → config error, raised *before* a second process is spawned.
    await expect(
      tool.execute("call-2", { command: "npm run build", run_in_background: true }, undefined, undefined, harness.ctx),
    ).rejects.toThrow(/all 1 background job slots are in use/);
    expect(harness.port.spawns).toHaveLength(1);
  });

  it("T8: the threshold expires but every slot is taken → keep waiting in the foreground", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness({ maxBackgroundJobs: 1 });
    harness.port.script = (proc) => proc.write("occupied\n");
    // Occupy the only slot with an already backgrounded job.
    const occupier = await harness.manager.create({ command: "sleep 900", cwd: harness.dir });
    await harness.manager.markBackgrounded(occupier.jobId);

    harness.port.script = (proc) => proc.write("slow\n");
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 2, "the foreground job to spawn");
    await vi.advanceTimersByTimeAsync(120_000);
    await waitFor(
      () => harness.warnings.some((line) => line.includes("stayed in the foreground")),
      "the capacity warning",
    );

    // Still foreground: no background details, the job is not marked.
    const foregroundJob = harness.manager.list().find((record) => record.jobId !== occupier.jobId)!;
    expect(foregroundJob.backgroundedAt).toBeUndefined();
    expect(harness.warnings.some((line) => line.includes("stayed in the foreground"))).toBe(true);

    harness.port.last().exit({ exitCode: 0, signal: null });
    const result = await run;
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("slow");
    expect(text).toContain("background job slots");
    expect((result.details as BashBackgroundDetails | undefined)?.background).toBeUndefined();
  });

  it("T9: a post-background inner rejection lands in finalText without an unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const harness = await makeHarness();
      harness.port.script = (proc) => proc.write("failing\n");
      const tool = toolFor(harness, 120_000);
      const run = tool.execute("call-1", { command: "false" }, undefined, undefined, harness.ctx);
      await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
      await vi.advanceTimersByTimeAsync(120_000);
      const details = (await run).details as BashBackgroundDetails;

      harness.port.last().exit({ exitCode: 1, signal: null });
      await waitFor(
        () => harness.manager.get(details.jobId)?.finalText !== undefined,
        "the inner result to reach finalText",
      );

      const record = harness.manager.get(details.jobId)!;
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
      expect(record.finalText).toContain("Command exited with code 1");
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("passes straight through to pi when the feature is off (no manager / zero threshold)", async () => {
    const harness = await makeHarness();
    const offTool = createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 });
    const result = await offTool.execute("call-1", { command: "echo passthrough" }, undefined, undefined, harness.ctx);
    expect(result.content[0]).toEqual({ type: "text", text: "passthrough\n" });
    // Nothing was routed through the manager.
    expect(harness.port.spawns).toHaveLength(0);

    const zeroTool = toolFor(harness, 0);
    const zero = await zeroTool.execute("call-2", { command: "echo zero" }, undefined, undefined, harness.ctx);
    expect(zero.content[0]).toEqual({ type: "text", text: "zero\n" });
    expect(harness.port.spawns).toHaveLength(0);
  });
});

// ── T15 (bash-timeout-grace §3.6): two-layer race, R, latch ────────────────

/**
 * Minimal deadline-aware manager stand-in implementing the plan-frozen P3
 * surface (`reserve` / `cancelReserve` / `markBackgroundedSync` / `extend`,
 * §3.6/§2.3) over fully controllable `started` / `exit` promises. The inner
 * tool layer only ever calls those four plus `setFinalText` / capacity reads.
 */
interface FakeReservation {
  readonly jobId: string;
  readonly logPath: string;
  readonly record: JobRecord;
  readonly init: { command: string; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
  resolveStarted: (
    outcome:
      | {
          ok: true;
          job: CreatedJob;
        }
      | { ok: false; error: Error },
  ) => void;
  readonly started: Promise<{ ok: true; job: CreatedJob } | { ok: false; error: Error }>;
  readonly exit: Promise<JobRecord>;
  resolveExit: (record: JobRecord) => void;
  cancelled: boolean;
  backgroundedSync: number;
}

function fakeRecord(jobId: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    v: 1,
    jobId,
    command: "run-it",
    cwd: "/repo",
    sessionId: "session-1",
    hostPid: 4242,
    pid: 7001,
    status: "running",
    createdAt: NOW_MS,
    spawnedAt: NOW_MS,
    exitCode: null,
    logPath: `/tmp/${jobId}.log`,
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    ...over,
  };
}

const NOW_MS = 1_000_000;

class FakeDeadlineHarness {
  readonly reservations: FakeReservation[] = [];
  readonly cancelled: string[] = [];
  readonly finalTexts: { jobId: string; text: string }[] = [];
  readonly returns: { toolCallId: string; at: number }[] = [];
  readonly warnings: string[] = [];
  capacity = true;
  private n = 0;
  readonly manager: BashJobManager;

  constructor() {
    const harness = this;
    this.manager = {
      dir: "/tmp/bash-jobs",
      maxBackgroundJobs: 8,
      async recover() {
        throw new Error("unused");
      },
      async create() {
        throw new Error("deadline-aware fake: create() must not be called");
      },
      get: (jobId) => harness.reservations.find((r) => r.jobId === jobId)?.record ?? undefined,
      async load(jobId) {
        return harness.reservations.find((r) => r.jobId === jobId)?.record ?? undefined;
      },
      list: () => [...harness.reservations.values()].map((r) => r.record),
      resolve(handle) {
        const trimmed = handle.trim();
        const exact = harness.reservations.find((r) => r.jobId === trimmed);
        if (exact) return exact.jobId;
        const matches = harness.reservations.filter((r) => r.jobId.startsWith(trimmed));
        if (matches.length === 1) return matches[0]!.jobId;
        throw new Error(`bash job not found: ${trimmed}`);
      },
      async markBackgrounded(jobId) {
        const r = harness.reservations.find((x) => x.jobId === jobId);
        return r?.record;
      },
      async setFinalText(jobId, finalText) {
        harness.finalTexts.push({ jobId, text: finalText });
        return undefined;
      },
      noteTermination() {},
      async readOutput() {
        throw new Error("unused");
      },
      async kill(jobId) {
        harness.cancelled.push(jobId);
        throw new Error("unused");
      },
      async waitExit() {
        return undefined;
      },
      backgroundJobCount() {
        return 0;
      },
      hasBackgroundCapacity() {
        return harness.capacity;
      },
      exportLocalJobs() {
        return [];
      },
      hasOpenLocalHandle() {
        return false;
      },
      adoptLocalJobs() {},
      async drain() {},
      dispose() {},
      // ── the frozen §3.6 surface ──────────────────────────────────────────
      reserve(init: { command: string; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): {
        jobId: string;
        logPath: string;
        started: Promise<unknown>;
      } {
        const jobId = `b_FAKEn${++harness.n}`.replace("n", "");
        let resolveStarted: FakeReservation["resolveStarted"] = () => {};
        const started = new Promise<{ ok: true; job: CreatedJob } | { ok: false; error: Error }>((resolve) => {
          resolveStarted = resolve;
        });
        let resolveExit: (record: JobRecord) => void = () => {};
        const exit = new Promise<JobRecord>((resolve) => {
          resolveExit = resolve;
        });
        const record = fakeRecord(jobId);
        const reservation: FakeReservation = {
          jobId,
          logPath: record.logPath,
          init,
          resolveStarted,
          started,
          exit,
          resolveExit,
          cancelled: false,
          backgroundedSync: 0,
          get record() {
            return record;
          },
        } as FakeReservation;
        harness.reservations.push(reservation);
        return { jobId, logPath: record.logPath, started };
      },
      cancelReserve(jobId: string): void {
        const r = harness.reservations.find((x) => x.jobId === jobId);
        if (r) r.cancelled = true;
        harness.cancelled.push(jobId);
      },
      markBackgroundedSync(jobId: string): void {
        const r = harness.reservations.find((x) => x.jobId === jobId);
        if (r) r.backgroundedSync += 1;
      },
      extend() {
        return { ok: false, reason: "no_timeout" as const };
      },
    } as unknown as BashJobManager;
  }

  lastReservation(): FakeReservation {
    const r = this.reservations[this.reservations.length - 1];
    if (!r) throw new Error("no reservation");
    return r;
  }

  /** Resolve `started` with a running job at the given fake-time offset. */
  startJob(offsetMs: number, pid = 7001): void {
    const r = this.lastReservation();
    setTimeout(() => {
      const job: CreatedJob = {
        jobId: r.jobId,
        record: fakeRecord(r.jobId, { pid }),
        pid,
        pgid: pid,
        logPath: r.logPath,
        exit: r.exit,
      };
      r.resolveStarted({ ok: true, job });
    }, offsetMs);
  }

  exitJob(offsetMs: number, over: Partial<JobRecord> = {}): void {
    const r = this.lastReservation();
    setTimeout(() => r.resolveExit(fakeRecord(r.jobId, { status: "completed", exitCode: 0, ...over })), offsetMs);
  }
}

interface ChildToolOptions {
  thresholdMs?: number;
  /** `undefined` = the view answers "no D" (§3.6 "D 未定义"). */
  dueAt?: () => number | undefined;
  toolBudgetMs?: () => number | undefined;
}

function childTool(harness: FakeDeadlineHarness, options: ChildToolOptions = {}): ReturnType<typeof createBashTool> {
  const view: HostRunView = {
    runId: "run-1",
    watchdogDueAt: () => options.dueAt?.(),
    hardDeadlineAt: () => undefined,
    maxExtensions: () => 3,
    stopping: () => false,
    noteToolReturn: (toolCallId, at) => harness.returns.push({ toolCallId, at }),
  };
  return createBashTool({
    manager: () => harness.manager,
    autoBackgroundMs: () => options.thresholdMs ?? 120_000,
    host: () => view,
    ...(options.toolBudgetMs !== undefined ? { toolBudgetMs: options.toolBudgetMs } : {}),
    now: () => FAKE_NOW,
    warn: (message) => harness.warnings.push(message),
  });
}

function mainTool(harness: FakeDeadlineHarness, thresholdMs = 10 * 60_000): ReturnType<typeof createBashTool> {
  return createBashTool({
    manager: () => harness.manager,
    autoBackgroundMs: () => thresholdMs,
    warn: (message) => harness.warnings.push(message),
  });
}

/**
 * Deterministic T15 clock: the tool's `now` is pinned, so R = min(threshold,
 * D − 3s) lands on exact fake-timer boundaries instead of real Date.now() ms
 * jitter (two real Date.now() calls can straddle a ms tick and shift R by 1).
 */
const FAKE_NOW = 1_729_000_000_000;
const D8S = () => FAKE_NOW + 8_000;
const D20S = () => FAKE_NOW + 20_000;

describe("bash override tool — T15 two-layer race (§3.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("R ample: the threshold still governs when D is far away", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: () => FAKE_NOW + 300_000 });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(119_999);
    const pending = await Promise.race([run.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    expect((result.details as BashBackgroundDetails).background).toBe(true);
    expect((result.details as BashBackgroundDetails).pid).toBe(7001);
  });

  it("toolMs ≤ MARGIN_RETURN (D−3s ≤ now): returns synchronously with `pid starting`", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: () => FAKE_NOW + 3_000 });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    // No timer advance at all — the latch fired during the call itself.
    const result = await run;
    const details = result.details as BashBackgroundDetails;
    const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(details.background).toBe(true);
    expect(details.pid).toBeUndefined();
    expect(body).toContain("pid starting");
    expect(body).toContain(details.jobId);
    expect(harness.lastReservation().backgroundedSync).toBe(1);
    expect(harness.cancelled).toEqual([]);
    expect(harness.returns).toHaveLength(1);
    expect(harness.returns[0]!.toolCallId).toBe("call-1");
  });

  it("D undefined (watchdogDueAt → undefined): no truncation, threshold governs", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: () => undefined });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const pending = await Promise.race([run.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run).details).toMatchObject({ background: true });
  });

  it("no host view attached: static D = start + toolBudget, warned once", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = createBashTool({
      manager: () => harness.manager,
      autoBackgroundMs: () => 120_000,
      host: () => undefined,
      toolBudgetMs: () => 8_000,
      now: () => FAKE_NOW,
      warn: (message) => harness.warnings.push(message),
    });
    const first = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(4_999);
    const pending = await Promise.race([first.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(harness.warnings.filter((line) => line.includes("no host view attached"))).toHaveLength(1);
    // A second call does not warn again (once per tool instance).
    const second = tool.execute("call-2", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(harness.warnings.filter((line) => line.includes("no host view attached"))).toHaveLength(1);
  });

  it("R spans the whole call ①: `started` never settles → background at D−3s with `starting`", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test", timeout: 30 }, undefined, undefined, makeCtx("/repo"));
    // The reservation (and its timeoutMs) is visible immediately (E33).
    expect(harness.reservations).toHaveLength(1);
    expect(harness.lastReservation().init.timeoutMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(4_999);
    const pending = await Promise.race([run.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(body).toContain("pid starting");
    expect((result.details as BashBackgroundDetails).pid).toBeUndefined();
    // Nobody cancelled: the reservation keeps waiting for its staged persist.
    expect(harness.cancelled).toEqual([]);
    expect(harness.lastReservation().backgroundedSync).toBe(1);
    expect(harness.returns).toHaveLength(1);
  });

  it("R spans the whole call ②: started resolved, command still running → background at D−3s with the pid", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    harness.exitJob(60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await run;
    expect((result.details as BashBackgroundDetails).pid).toBe(7001);
    expect(harness.lastReservation().backgroundedSync).toBe(1);
    // The command finishing later lands in finalText via adoptInnerPromise (§2.3).
    await vi.advanceTimersByTimeAsync(55_000);
    await waitFor(() => harness.finalTexts.length === 1, "the adopted final text");
    expect(harness.finalTexts[0]!.jobId).toBe(harness.lastReservation().jobId);
    // pi's own foreground text for a clean exit with no output — adopted (§2.3).
    expect(harness.finalTexts[0]!.text).toBe("(no output)");
  });

  it("toolMs = 20s: R = D − 3s = 17s", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D20S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(16_999);
    const pending = await Promise.race([run.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect((await run).details).toMatchObject({ background: true });
  });

  it("job.exit first: the foreground result is pi's own, not a background hand-back", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1);
    harness.exitJob(500);
    await vi.advanceTimersByTimeAsync(600);
    const result = await run;
    expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
    expect((result.details as BashBackgroundDetails | undefined)?.background).toBeUndefined();
    expect(harness.lastReservation().backgroundedSync).toBe(0);
    expect(harness.returns).toEqual([]);
  });

  it("same tick (exit just before R): exactly one branch runs — foreground wins", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1);
    harness.exitJob(4_999); // 1ms before the R timer
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;
    expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
    expect(harness.lastReservation().backgroundedSync).toBe(0);
    expect(harness.returns).toEqual([]);
    expect(harness.finalTexts).toEqual([]); // foreground: nothing adopted
  });

  it("same tick (exit scheduled exactly at R): exactly one branch runs — the latch picks background", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1);
    harness.exitJob(5_000); // the same tick as the R timer
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;
    const details = result.details as BashBackgroundDetails;
    // Exactly one winner: background text, exactly one markBackgroundedSync.
    expect(details.background).toBe(true);
    expect(harness.lastReservation().backgroundedSync).toBe(1);
    // The foreground delivery never ran on top of it.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("moved to the background");
  });

  it("main session, store hang: foreground throws started's error at its 30s bound", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = mainTool(harness, 10 * 60_000);
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    const reservation = harness.lastReservation();
    const expectation = expect(run).rejects.toThrow("bash job store did not persist the staged record within 30s");
    setTimeout(
      () =>
        reservation.resolveStarted({
          ok: false,
          error: new Error("bash job store did not persist the staged record within 30s"),
        }),
      30_000,
    );
    await vi.advanceTimersByTimeAsync(29_999);
    const pending = await Promise.race([
      run.then(
        () => "done",
        () => "failed",
      ),
      Promise.resolve("pending"),
    ]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).rejects.toThrow("bash job store did not persist the staged record within 30s");
    expect(harness.lastReservation().backgroundedSync).toBe(0);
  });

  it("main session, Esc at 2s: aborts at once, cancelReserve called, nothing spawned", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = mainTool(harness, 10 * 60_000);
    const controller = new AbortController();
    const run = tool.execute("call-1", { command: "npm test" }, controller.signal, undefined, makeCtx("/repo"));
    const jobId = harness.lastReservation().jobId;
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await expect(run).rejects.toThrow("Command aborted");
    expect(harness.cancelled).toEqual([jobId]);
  });

  it("parallel batch: a second bash in the same tool phase returns by the same D−3s", async () => {
    const harness = new FakeDeadlineHarness();
    const due = FAKE_NOW + 8_000;
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: () => due });
    const first = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    const second = tool.execute("call-2", { command: "npm run build" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first).details).toMatchObject({ background: true });
    expect((await second).details).toMatchObject({ background: true });
    expect(harness.reservations).toHaveLength(2);
  });

  it("child session with full background slots still converts (C2 over-quota)", async () => {
    const harness = new FakeDeadlineHarness();
    harness.capacity = false;
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: () => FAKE_NOW + 300_000 });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    harness.startJob(1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await run;
    expect((result.details as BashBackgroundDetails).background).toBe(true);
    expect(harness.warnings.some((line) => line.includes("stayed in the foreground"))).toBe(false);
  });

  it("run_in_background in a child session: the latch fires right after reserve, before the pid", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { dueAt: () => FAKE_NOW + 300_000 });
    const run = tool.execute(
      "call-1",
      { command: "npm test", run_in_background: true },
      undefined,
      undefined,
      makeCtx("/repo"),
    );
    const result = await run;
    const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect((result.details as BashBackgroundDetails).background).toBe(true);
    expect((result.details as BashBackgroundDetails).autoBackgrounded).toBeUndefined();
    expect(body).toContain("started in the background");
    expect(body).toContain("pid starting");
  });

  it("run_in_background against a full table is still rejected before spawn (both modes)", async () => {
    const harness = new FakeDeadlineHarness();
    harness.capacity = false;
    const tool = childTool(harness, { dueAt: () => FAKE_NOW + 300_000 });
    await expect(
      tool.execute("call-1", { command: "npm test", run_in_background: true }, undefined, undefined, makeCtx("/repo")),
    ).rejects.toThrow(/all 8 background job slots are in use/);
    expect(harness.reservations).toHaveLength(0);
  });

  it("foreground started.ok=false in child mode: throws the original error (no background rescue)", async () => {
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 120_000, dueAt: () => FAKE_NOW + 300_000 });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    const reservation = harness.lastReservation();
    // Attach the handler before the rejection fires (the fake-timer flush
    // would otherwise briefly leave the rejected promise unobserved).
    const expectation = expect(run).rejects.toThrow("spawn refused: no such shell");
    setTimeout(
      () => reservation.resolveStarted({ ok: false, error: new Error("spawn refused: no such shell") }),
      1_000,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    expect(harness.lastReservation().backgroundedSync).toBe(0);
  });

  it("B-LOOP budget: the R timer fires exactly at D − MARGIN_RETURN, leaving the margin for the return path", async () => {
    // toolMs = 8s ⇒ R = 5s: a 1s event-loop block + a 1s tool_result hook
    // after the return still lands tool_end at 7s < D = 8s. (The 4s-block
    // boundary-warning path is host-side lag telemetry, P5/T32; this test
    // pins the tool-side budget that makes the arithmetic possible.)
    const harness = new FakeDeadlineHarness();
    const tool = childTool(harness, { thresholdMs: 290_000, dueAt: D8S });
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, makeCtx("/repo"));
    await vi.advanceTimersByTimeAsync(4_999);
    const pending = await Promise.race([run.then(() => "done"), Promise.resolve("pending")]);
    expect(pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await run;
    // The host needs the exact R instant to compute tool_end − R (B-LOOP).
    expect(harness.returns).toHaveLength(1);
    expect(harness.returns[0]).toEqual({ toolCallId: "call-1", at: FAKE_NOW });
  });
});
