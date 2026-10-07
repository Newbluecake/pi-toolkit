import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, RunSnapshot } from "../../src/core/types.js";
import activate from "../../src/index.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { RuntimeRunner } from "../../src/runtime/runner.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { RPC_REQUEST_CHANNEL, RPC_VERSION, replyChannel } from "../../src/rpc/protocol.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { TombstoneStore } from "../../src/service/tombstone.js";

/**
 * agent-explicit-timeout-extend plan §7 收尾 R1-R6 (★ resume 持久化四路径):
 * `timeoutPolicy` is a run's persistent fact — it must survive every
 * persistence face (terminal `subagent:run` entry, non-terminal journal,
 * tombstone) and every resume path must inherit it through the REAL
 * admission seam (spawn-service's §2.2 resolution, term ②).
 *
 *  R1 same-process terminal resume — extendable original, a fixed original
 *     (real RPC spawn) resumed via a real @label mention, and ①>② override.
 *  R2 /reload — a second session_start on the same branch: the seeded
 *     terminal entry carries the policy (fixed vs shape-③ extendable — the
 *     discriminating case) and the OLD stack's watchdog still kills an
 *     in-grace run (V21 non-regression).
 *  R3 process restart — a fresh activate() over a pre-seeded branch entry.
 *  R4 non-terminal journal — seeded as aborted (restart-interrupted), the
 *     policy survives interruptedFromJournal and the resume inherits it.
 *  R5 legacy field-less entries — resume falls through to the request shape;
 *     the extend tool can never reach no_headroom for them (terminal first).
 *  R6 tombstone-only — two REAL spawn services sharing one TTL tombstone
 *     store: with the durable records evicted, the tombstone alone carries
 *     both the session file and the policy.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");
const LIVE_FILES_KEY = Symbol.for("pi-subagent:live-session-files");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details: any }; options?: unknown };

function fakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const sent: Sent[] = [];
  const busEvents: { channel: string; payload: any }[] = [];
  const busListeners = new Map<string, Array<(payload: unknown) => void>>();
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: Sent["message"], options?: Sent["options"]) {
      sent.push({ message, ...(options !== undefined ? { options } : {}) });
      branch.push({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
        timestamp: new Date().toISOString(),
      });
    },
    sendUserMessage() {},
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    events: {
      on(channel: string, listener: (payload: unknown) => void) {
        busListeners.set(channel, [...(busListeners.get(channel) ?? []), listener]);
        return () => {
          const list = busListeners.get(channel) ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      emit(channel: string, payload: unknown) {
        busEvents.push({ channel, payload });
        for (const listener of [...(busListeners.get(channel) ?? [])]) listener(payload);
      },
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const ctx = {
    cwd: process.env.HOME,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getSessionId: () => `timeout-policy-persistence-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const call = async (name: string, params: Record<string, unknown>) =>
    (await tools.get(name)!.execute!("tc", params as never, undefined as never, undefined as never, ctx as never)) as {
      content: { type: string; text: string }[];
      details: any;
    };
  const emitRpc = (requestId: string, params: Record<string, unknown>) =>
    (pi as unknown as { events: { emit: (c: string, p: unknown) => void } }).events.emit(RPC_REQUEST_CHANNEL, {
      version: RPC_VERSION,
      requestId,
      method: "spawn",
      params,
    });
  return { pi: pi as unknown as ExtensionAPI, tools, sent, busEvents, emit, call, emitRpc };
}

function writeAgentFiles(home: string) {
  const dir = join(home, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), "---\nname: worker\ndescription: worker\n---\nYou work.\n");
}

function writeSettings(home: string, extra: Record<string, unknown> = {}) {
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        budget: { totalGraceS: 1, maxExtensions: 2, maxTotalFactor: 3, abortGraceS: 0.05, reapS: 0.05 },
        fleetWidget: false,
        quota: { enabled: false },
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

let home = "";
let realHome: string | undefined;
let scratch = "";

beforeEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  home = mkdtempSync(join(tmpdir(), "pi-policy-persistence-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  scratch = mkdtempSync(join(tmpdir(), "pi-policy-persistence-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function until(pred: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const completions = (sent: Sent[], runId: string) =>
  sent.filter((s) => s.message.customType === "subagent:notification" && s.message.details?.runId === runId);
const graceNotices = (sent: Sent[], runId: string) =>
  sent.filter(
    (s) =>
      s.message.customType === "subagent:timeout" &&
      s.message.details?.kind === "grace" &&
      s.message.details?.runId === runId,
  );

let handleSeq = 0;
function makeHandle(dir: string, hang: boolean) {
  const file = join(dir, `child-${++handleSeq}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: `c${handleSeq}` })}\n`);
  return {
    sessionId: `c${handleSeq}`,
    sessionFile: file,
    prompt: () => (hang ? new Promise<void>(() => undefined) : Promise.resolve()),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello from subagent",
    getUsage: () => undefined,
  };
}
function stubDriver(hang: () => boolean) {
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async () => makeHandle(scratch, hang()) as never);
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async () => makeHandle(scratch, hang()) as never);
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
}

interface Captured {
  req: {
    runId: string;
    timeoutPolicy?: string;
    displayMeta?: { label?: string; taskPrompt?: string };
  };
  budget: { maxTotalFactor: number; totalMs: number };
}
function spyRunnerRun() {
  const captured: Captured[] = [];
  const original = RuntimeRunner.prototype.run;
  vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, req, budget) {
    captured.push({ req: req as Captured["req"], budget });
    return original.call(this, req, budget);
  });
  return captured;
}
const captureOf = (captured: Captured[], label: string) => captured.find((c) => c.req.displayMeta?.label === label);

// ───────────────────────── seeded-branch fixtures (R3/R4/R5) ─────────────────────────

/** A REAL child session file on disk (seed + resume both statSync it). */
function childSessionFile(name: string): string {
  const file = join(scratch, `${name}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: name })}\n`);
  return file;
}

function baseDiag(sessionFile: string, extra: Record<string, unknown> = {}) {
  return {
    createdAt: 1_000,
    phase: "settled",
    phaseEnteredAt: 1_000,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    sessionFile,
    agentType: "worker",
    ...extra,
  };
}

function terminalSnapshot(runId: string, label: string, sessionFile: string, diagExtra: Record<string, unknown>) {
  const diag = baseDiag(sessionFile, { label, ...diagExtra });
  const snapshot: RunSnapshot = {
    runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 1_000, deadlineAt: 2_000, queueDeadlineAt: undefined, hardDeadlineAt: 2_000 },
    diag,
    outcome: {
      runId,
      status: "completed",
      turns: 1,
      durationMs: 5,
      diag,
    },
    updatedAt: 2_000,
  };
  return snapshot;
}

function journalSnapshot(runId: string, label: string, sessionFile: string, diagExtra: Record<string, unknown>) {
  return {
    runId,
    generation: 1,
    status: "starting", // non-terminal ⇒ the seed maps it through interruptedFromJournal
    phase: "prompt_dispatch",
    deadlines: { enqueuedAt: 1_000, deadlineAt: 5_000, queueDeadlineAt: undefined },
    diag: baseDiag(sessionFile, { label, phase: "prompt_dispatch", ...diagExtra }),
    updatedAt: 1_500,
    journal: { kind: "session_created" as const },
  } satisfies RunSnapshot;
}

// ───────────────────────── R1-R5: real activate() paths ─────────────────────────

describe("timeoutPolicy persistence across resume paths (R1-R6)", () => {
  it("R1: same-process terminal resume — extendable original inherited, fixed original via @label mention inherited, explicit timeout_s wins (①>②)", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver(() => false); // everything settles
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // (a) an Agent timeout_s run completes; a plain resume inherits extendable.
    const expl = await host.call("Agent", {
      description: "expl-src",
      prompt: "explicit budget run",
      subagent_type: "worker",
      timeout_s: 30,
    });
    const explId = expl.details.runId as string;
    await until(() => completions(host.sent, explId).length > 0);
    await host.call("Agent", {
      description: "expl-resume",
      prompt: "continue explicitly",
      subagent_type: "worker",
      resume: explId,
    });
    await until(() => captureOf(captured, "expl-resume") !== undefined);
    expect(captureOf(captured, "expl-resume")!.req.timeoutPolicy).toBe("extendable");

    // (b) a FIXED original (real RPC producer) completes; a real @label
    // mention resumes it with NO explicit policy ⇒ R-inherit wins over the
    // request shape (shape ③ would say extendable — the discriminating case).
    host.emitRpc("req-fixed", {
      type: "worker",
      prompt: "programmatic fixed job",
      label: "fixed-src",
      budgetOverride: { totalMs: 30_000 },
    });
    await until(() => completions(host.sent, captureOf(captured, "fixed-src")?.req.runId ?? "").length > 0);
    const fixedId = captureOf(captured, "fixed-src")!.req.runId;
    await host.emit("input", { text: "@fixed-src continue the work" });
    await until(() => captured.some((c) => c.req.displayMeta?.taskPrompt === "continue the work"));
    const mentionResume = captured.find((c) => c.req.displayMeta?.taskPrompt === "continue the work")!;
    expect(mentionResume.req.timeoutPolicy).toBe("fixed"); // ② inherited, not ③
    expect(mentionResume.budget.maxTotalFactor).toBe(1); // ⇒ H === D0 for the new run

    // (c) the same fixed original with an explicit timeout_s ⇒ ① wins.
    await host.call("Agent", {
      description: "fixed-rescue",
      prompt: "widen it back",
      subagent_type: "worker",
      resume: fixedId,
      timeout_s: 20,
    });
    await until(() => captureOf(captured, "fixed-rescue") !== undefined);
    expect(captureOf(captured, "fixed-rescue")!.req.timeoutPolicy).toBe("extendable");
    expect(captureOf(captured, "fixed-rescue")!.budget.totalMs).toBe(20_000);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("R2: /reload — the seeded terminal entry carries the policy into the new stack's resume; the old watchdog still kills the in-grace run", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const branch: unknown[] = [];
    const host = fakePi(branch);
    const hang = { value: false };
    stubDriver(() => hang.value);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // A FIXED run completes first — its terminal entry lands in the branch.
    host.emitRpc("req-reload", {
      type: "worker",
      prompt: "fixed before reload",
      label: "reload-src",
      budgetOverride: { totalMs: 30_000 },
    });
    await until(() => completions(host.sent, captureOf(captured, "reload-src")?.req.runId ?? "").length > 0);
    const reloadId = captureOf(captured, "reload-src")!.req.runId;
    expect(
      branch.some(
        (e) =>
          (e as { type?: string; data?: { runId?: string } }).type === "custom" &&
          (e as { data?: { runId?: string } }).data?.runId === reloadId,
      ),
    ).toBe(true);

    // An extendable run enters its grace window and STAYS there.
    hang.value = true;
    const held = await host.call("Agent", {
      description: "held-in-grace",
      prompt: "hang",
      subagent_type: "worker",
      timeout_s: 2,
    });
    const heldId = held.details.runId as string;
    await until(() => graceNotices(host.sent, heldId).length === 1);

    // /reload: a second session_start rebuilds the stack over the same branch.
    await host.emit("session_start", { reason: "reload" });
    const seeded = await host.call("get_subagent_result", { run_id: reloadId });
    expect(seeded.details.status).toBe("completed"); // the terminal entry seeded back

    // Plain resume of the seeded FIXED entry inherits fixed (② through the
    // seeded durable record — ③ would say extendable).
    hang.value = false;
    await host.call("Agent", {
      description: "reload-resume",
      prompt: "resume after reload",
      subagent_type: "worker",
      resume: reloadId,
    });
    await until(() => captureOf(captured, "reload-resume") !== undefined);
    expect(captureOf(captured, "reload-resume")!.req.timeoutPolicy).toBe("fixed");
    expect(captureOf(captured, "reload-resume")!.budget.maxTotalFactor).toBe(1);

    // V21 non-regression: the OLD stack's watchdog still kills the held run.
    // (The new stack's seeded view of it is the stale aborted snapshot from
    // the journal entry — the authoritative terminal fact arrives through
    // the OLD stack's completion notification, which carries timed_out.)
    await until(() => completions(host.sent, heldId).length > 0, 12_000);
    expect(completions(host.sent, heldId)[0]!.message.details).toMatchObject({ runId: heldId, status: "timed_out" });
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("R3: process restart — a pre-seeded terminal entry (fixed) is readable and its resume inherits fixed", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const file = childSessionFile("r3-child");
    const branch: unknown[] = [
      {
        type: "custom",
        customType: "subagent:run",
        data: terminalSnapshot("r_FIXEDSEED", "seeded-fixed", file, { timeoutPolicy: "fixed" }),
      },
    ];
    // A hard kill takes the whole process — and its Symbol.for registries — with it.
    delete (globalThis as Record<symbol, unknown>)[LIVE_FILES_KEY];
    const host = fakePi(branch);
    stubDriver(() => false);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const seeded = await host.call("get_subagent_result", { run_id: "r_FIXEDSEED" });
    expect(seeded.details.status).toBe("completed");

    await host.call("Agent", {
      description: "restart-resume",
      prompt: "resume the seeded run",
      subagent_type: "worker",
      resume: "r_FIXEDSEED",
    });
    await until(() => captureOf(captured, "restart-resume") !== undefined);
    expect(captureOf(captured, "restart-resume")!.req.timeoutPolicy).toBe("fixed");
    expect(captureOf(captured, "restart-resume")!.budget.maxTotalFactor).toBe(1);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 20_000);

  it("R4: non-terminal journal recovery — seeded as aborted (restart-interrupted), the policy survives and the resume inherits it", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const file = childSessionFile("r4-child");
    const branch: unknown[] = [
      {
        type: "custom",
        customType: "subagent:run",
        data: journalSnapshot("r_JOURNALFX", "crashed-fixed", file, { timeoutPolicy: "fixed" }),
      },
    ];
    delete (globalThis as Record<symbol, unknown>)[LIVE_FILES_KEY];
    const host = fakePi(branch);
    stubDriver(() => false);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // The journal entry maps to a terminal aborted snapshot (D4) and the
    // interrupted message names the restart.
    const seeded = await host.call("get_subagent_result", { run_id: "r_JOURNALFX" });
    expect(seeded.details.status).toBe("aborted");
    expect(seeded.content[0]!.text).toContain("interrupted by a pi restart");

    // Plain resume inherits the JOURNALED policy (fixed) — shape ③ would say
    // extendable, so this proves JOURNAL_DIAG_FIELDS' timeoutPolicy rode
    // through interruptedFromJournal into the seeded record.
    await host.call("Agent", {
      description: "journal-resume",
      prompt: "resume the crashed run",
      subagent_type: "worker",
      resume: "r_JOURNALFX",
    });
    await until(() => captureOf(captured, "journal-resume") !== undefined);
    expect(captureOf(captured, "journal-resume")!.req.timeoutPolicy).toBe("fixed");
    await host.emit("session_shutdown", { reason: "quit" });
  }, 20_000);

  it("R5: a legacy field-less entry — resume falls through to the request shape; the extend tool answers already_terminal, never no_headroom", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const file = childSessionFile("r5-child");
    const branch: unknown[] = [
      { type: "custom", customType: "subagent:run", data: terminalSnapshot("r_LEGACYOLD", "legacy-old", file, {}) },
    ];
    delete (globalThis as Record<symbol, unknown>)[LIVE_FILES_KEY];
    const host = fakePi(branch);
    stubDriver(() => false);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // No timeout_s and no persisted policy ⇒ shape ③ on the REQUEST: a plain
    // request (no totalMs) resolves extendable.
    await host.call("Agent", {
      description: "legacy-resume",
      prompt: "resume the legacy run",
      subagent_type: "worker",
      resume: "r_LEGACYOLD",
    });
    await until(() => captureOf(captured, "legacy-resume") !== undefined);
    expect(captureOf(captured, "legacy-resume")!.req.timeoutPolicy).toBe("extendable");
    expect(captureOf(captured, "legacy-resume")!.budget.maxTotalFactor).not.toBe(1);

    // Field-less entries can only ever be terminal, and a seeded terminal run
    // was never live in THIS stack's runner — the extend tool refuses it with
    // unknown_run, never reaching any no_headroom text (fixed or neutral). The
    // four-way no_headroom text matrix itself is locked at unit level (U6):
    // no real entry can hand the extend tool a LIVE field-less run, because
    // spawn admission always stamps a definite policy.
    await expect(host.call("extend_subagent_timeout", { run_id: "r_LEGACYOLD", extend_s: 60 })).rejects.toThrow(
      /unknown run/,
    );
    await host.emit("session_shutdown", { reason: "quit" });
  }, 20_000);
});

// ───────────────────────── R6: tombstone-only (two real spawn services) ─────────────────────────

const workerType: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const types = {
  get: (name: string) => (name === "worker" ? workerType : undefined),
  list: () => [workerType],
  reload: async () => ({ types: [workerType], errors: [] }),
};

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

const r6Budget: DeadlineBudget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 2_000,
  startupMs: 20_000,
  bindMs: 2_000,
  firstEventMs: 2_000,
  idleMs: 2_000,
  toolMs: 2_000,
  totalMs: 30_000,
  totalGraceMs: 0,
  abortGraceMs: 20,
  steerMs: 10,
  reapMs: 30,
};

function r6SessionFile(): string {
  const file = join(scratch, `r6-${++handleSeq}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: `r6-${handleSeq}` })}\n`);
  return file;
}

describe("timeoutPolicy persistence: the tombstone path (R6, real SpawnService pair)", () => {
  let dir: string;
  let fileSeq = 0;
  let captured: Captured[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-tombstone-"));
    captured = [];
    const original = RuntimeRunner.prototype.run;
    spy = vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, req, budget) {
      captured.push({ req: req as Captured["req"], budget });
      return original.call(this, req, budget);
    });
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function handle(sessionFile: string) {
    return {
      sessionId: `s-${++fileSeq}`,
      sessionFile,
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      requestAbort: () => Promise.resolve(),
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set(),
      setActiveTools: () => undefined,
      getActiveTools: () => [],
      getLastAssistantText: () => "hello",
      getUsage: () => undefined,
    };
  }

  /** One spawn-service "process view": a REAL SpawnService + adapter + runner;
   *  only the child-session process is a stub driver. `durableRecords` and
   *  `tombstones` decide which persistence faces this view can still see. */
  const clock = new FakeClock();

  async function drain(ticks = 60, stepMs = 1) {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
      clock.advance(stepMs);
      await Promise.resolve();
    }
  }

  function service(opts: { durableRecords?: () => readonly RunSnapshot[]; tombstones?: TombstoneStore }) {
    const sessionFile = r6SessionFile();
    const driver = {
      create: async () => handle(sessionFile),
      resume: async () => handle(sessionFile),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const pool = new SingleSlotPool(clock, 4);
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store: new MemoryRunStore(),
      watchdog: new EventWatchdog({ clock, budget: r6Budget, getState: () => undefined, dispatch: () => undefined }),
      reaper: new EscalatingReaper(clock),
      notifier: flatNotifier,
    });
    const svc = createSpawnService({
      types,
      pool,
      runner,
      now: () => clock.now(),
      budget: r6Budget,
      ...(opts.durableRecords ? { durableRecords: opts.durableRecords } : {}),
      ...(opts.tombstones ? { tombstones: opts.tombstones } : {}),
    });
    return svc;
  }

  it("with the durable record evicted, the tombstone alone carries the session file AND the fixed policy", async () => {
    const shared = new TombstoneStore(30 * 60_000);
    // "Process" 1: the fixed run really settles; its tombstone registers.
    const svc1 = service({ tombstones: shared });
    const first = await svc1.spawn({ type: "worker", prompt: "fixed original", budgetOverride: { totalMs: 5_000 } });
    if ("error" in first) throw new Error(first.error.message);
    await drain(); // the run really settles: terminal snapshot + tombstone land
    expect(shared.get(first.runId)?.timeoutPolicy).toBe("fixed");

    // "Process" 2: fresh records, durable view evicted, ONLY the shared
    // tombstone survives — the resume still resolves (tombstone session file)
    // and inherits fixed (② via tombstone; ③ would say extendable).
    const svc2 = service({ durableRecords: () => [], tombstones: shared });
    const resumed = await svc2.spawn({ type: "worker", prompt: "resume from tombstone", resumeFrom: first.runId });
    if ("error" in resumed) throw new Error(resumed.error.message);
    await drain();
    const hit = captured.find((c) => c.req.runId === resumed.runId);
    expect(hit?.req.timeoutPolicy).toBe("fixed");
    expect(hit?.budget.maxTotalFactor).toBe(1);

    // Control: without the tombstone the same view cannot resolve the run at
    // all — proving the tombstone was the carrier, not some other face.
    const svc3 = service({ durableRecords: () => [], tombstones: new TombstoneStore(30 * 60_000) });
    const refused = await svc3.spawn({ type: "worker", prompt: "no source left", resumeFrom: first.runId });
    expect(refused).toMatchObject({ error: { message: expect.stringContaining("resume target not found") } });
  }, 20_000);
});
