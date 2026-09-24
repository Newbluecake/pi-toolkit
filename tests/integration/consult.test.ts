import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeConfig, AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { ConsultExpertRef } from "../../src/core/types.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import type { SessionHandle } from "../../src/runtime/session-driver.js";
import { buildFleetViewModel } from "../../src/ui/fleet-panel.js";

/**
 * consult plan §6 包 E — 集成验收 (T-13/T-14/T-17/T-18/T-19). Real
 * `buildSessionStack` (real SpawnService + RuntimeRunner + real
 * `wireConsult`/fork-store operating on real tmp files), only
 * `PiSessionDriver.create/resume/bind` are faked — no LLM is ever invoked;
 * the consult tool's `execute()` is called directly to simulate "the model
 * decided to call consult", matching the harness `tests/integration/
 * consult-wiring.test.ts` already established for package D.
 *
 * T-2..T-12 (unit-level gate/nack/success/failure/fork/admission/cap-watcher
 * surfaces) are covered in tests/consult/*, tests/service/*-consult*,
 * tests/runtime/runner-consult-reap.test.ts, tests/tools/agent-tool-experts.test.ts —
 * see docs/dev/consult/plan.md §9 for the full T-id → file map (also
 * summarized in the package E delivery report).
 */

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  vi.restoreAllMocks();
  homeSandbox?.restore();
  homeSandbox = undefined;
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "consult-e2e-"));
  tempDirs.push(d);
  return d;
}

function budget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 300,
    startupMs: 300,
    bindMs: 300,
    firstEventMs: 200,
    idleMs: 1_000,
    modelTurnMs: 1_000,
    toolMs: 1_000,
    totalMs: 3_000,
    totalGraceMs: 0,
    abortGraceMs: 50,
    steerMs: 20,
    reapMs: 100,
    retrySlackMs: 20,
  };
}

type Entry = { type: string; customType?: string; data?: unknown };

function harness(entries: Entry[] = []) {
  const appended: Entry[] = [];
  const sent: Array<{ message: { customType?: string; content?: string; details?: unknown }; opts?: unknown }> = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      appended.push(entry);
    },
    sendMessage(message: { customType?: string; content?: string; details?: unknown }, opts?: unknown) {
      sent.push({ message, opts });
    },
    registerEntryRenderer() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: () => () => undefined, emit: () => undefined },
    setModel: () => undefined,
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "consult-e2e" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    hasUI: false,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  return { pi, ctx, appended, sent };
}

const dispatcherType: AgentTypeConfig = {
  name: "dispatcher",
  description: "dispatches",
  systemPrompt: "You dispatch.",
  promptMode: "append",
};
const expertType: AgentTypeConfig = {
  name: "explorer",
  description: "explores",
  systemPrompt: "You explore.",
  promptMode: "append",
};

const types = {
  get: (name: string) => (name === "dispatcher" ? dispatcherType : name === "explorer" ? expertType : undefined),
  list: () => [dispatcherType, expertType],
  reload: async () => ({ types: [dispatcherType, expertType], errors: [] }),
} as unknown as AgentTypeRegistry;

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    budget: budget(),
    fleetWidget: false,
    fabric: { ...DEFAULT_SETTINGS.fabric, enabled: false },
    workflow: { ...DEFAULT_SETTINGS.workflow, enabled: false },
    quota: { ...DEFAULT_SETTINGS.quota, enabled: false },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false, adaptiveEnabled: false },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    consult: { ...DEFAULT_SETTINGS.consult, enabled: true, timeoutMs: 5_000 },
    ...overrides,
  };
}

/** A real, pi-openable expert session (real SessionManager, real tmp dir): F2's
 *  "source untouched" assertion needs a real file, not a handwritten fixture. */
function realExpertSession(label: string): { file: string; cwd: string } {
  const cwd = tempDir();
  const srcDir = join(cwd, "sessions");
  const mgr = SessionManager.create(cwd, srcDir);
  mgr.appendMessage({ role: "user", content: [{ type: "text", text: `expert task ${label}` }] });
  mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: `expert investigated ${label}` }] });
  const file = mgr.getSessionFile();
  if (!file) throw new Error("expert session fixture failed to persist");
  return { file, cwd };
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function fakeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}

type SpecLike = { customTools?: unknown[] };
interface DriverCall {
  kind: "create" | "resume";
  file?: string;
  spec: SpecLike;
}

/** Same seam as tests/integration/consult-wiring.test.ts (no driver-override
 *  parameter on buildSessionStack) — extended with per-call handle factories
 *  so a test can give the DISPATCHER run and the forked CONSULT run distinct
 *  (and distinctly timed) fake behaviors. */
function spyOnDriver(
  opts: {
    onCreate?: (spec: SpecLike) => SessionHandle | Promise<SessionHandle>;
    onResume?: (file: string, spec: SpecLike) => SessionHandle | Promise<SessionHandle>;
  } = {},
): { calls: DriverCall[] } {
  const calls: DriverCall[] = [];
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async (spec) => {
    const s = spec as SpecLike;
    calls.push({ kind: "create", spec: s });
    return ((await opts.onCreate?.(s)) ?? fakeHandle()) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (file, spec) => {
    const s = spec as SpecLike;
    calls.push({ kind: "resume", file, spec: s });
    return ((await opts.onResume?.(file, s)) ?? fakeHandle({ sessionFile: file })) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
  return { calls };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3_000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

interface ConsultToolLike {
  name: string;
  execute(
    toolCallId: string,
    params: { expert: string; question: string },
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown>; usage?: unknown }>;
}

function findConsultTool(spec: SpecLike): ConsultToolLike {
  const tool = (spec.customTools ?? []).find((t) => (t as { name?: string }).name === "consult");
  if (!tool) throw new Error("consult tool was not injected into the dispatcher's SessionSpec");
  return tool as ConsultToolLike;
}

describe("consult integration: end-to-end (§9 T-13)", () => {
  it("dispatch with experts → consult → answer returns; the expert is reached via driver.resume with a forked file, never a fresh create", async () => {
    const expert = realExpertSession("myexpert");
    const beforeHash = sha256(expert.file);
    const { calls } = spyOnDriver({
      onResume: async (file) => fakeHandle({ sessionFile: file, getLastAssistantText: () => "expert answer: 42" }),
    });
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    const expertRef: ConsultExpertRef = {
      runId: "r_EXPERT1",
      label: "myexpert",
      sessionFile: expert.file,
      agentType: "explorer",
    };
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult the expert",
      consultExperts: [expertRef],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await waitUntil(() => calls.some((c) => c.kind === "create"));
    const tool = findConsultTool(calls.find((c) => c.kind === "create")!.spec);

    const result = await tool.execute("call-1", { expert: "r_EXPERT1", question: "what did you find?" });
    expect(result.details.outcome).toBe("completed");
    expect(result.content[0]!.text).toContain("expert answer: 42");

    const resumeCall = calls.find((c) => c.kind === "resume");
    expect(resumeCall).toBeDefined();
    expect(resumeCall!.file).toBeDefined();
    expect(resumeCall!.file!).toContain("consult-sessions"); // consultSessionDir(), not the expert's own dir
    expect(resumeCall!.file!).not.toBe(expert.file); // a FORK, not the original
    expect(calls.filter((c) => c.kind === "create")).toHaveLength(1); // only the dispatcher; the expert copy is `resume`d, never freshly `create`d

    expect(sha256(expert.file)).toBe(beforeHash); // F2: source byte-for-byte unchanged

    // Runner reap → onReaped → wireConsult.onReaped → removeForkFile.
    await waitUntil(() => !existsSync(resumeCall!.file!));
  });
});

describe("consult integration: concurrency (§9 T-14)", () => {
  it("two concurrent consults of the same expert get independent forks, independent answers, and leave the source untouched", async () => {
    const expert = realExpertSession("sharedexpert");
    const beforeHash = sha256(expert.file);
    const { calls } = spyOnDriver({
      onResume: async (file) => fakeHandle({ sessionFile: file, getLastAssistantText: () => `answer for ${file}` }),
    });
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    const expertRef: ConsultExpertRef = { runId: "r_EXPERT1", sessionFile: expert.file, agentType: "explorer" };
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult twice",
      consultExperts: [expertRef],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await waitUntil(() => calls.some((c) => c.kind === "create"));
    const tool = findConsultTool(calls.find((c) => c.kind === "create")!.spec);

    const [r1, r2] = await Promise.all([
      tool.execute("call-1", { expert: "r_EXPERT1", question: "q1" }),
      tool.execute("call-2", { expert: "r_EXPERT1", question: "q2" }),
    ]);

    const resumeCalls = calls.filter((c) => c.kind === "resume");
    expect(resumeCalls).toHaveLength(2);
    const [f1, f2] = resumeCalls.map((c) => c.file!);
    expect(f1).not.toBe(f2); // each consult forks its own copy

    const expectedTexts = new Set([`answer for ${f1}`, `answer for ${f2}`]);
    expect(expectedTexts.has(r1.content[0]!.text)).toBe(true);
    expect(expectedTexts.has(r2.content[0]!.text)).toBe(true);
    expect(r1.content[0]!.text).not.toBe(r2.content[0]!.text);

    expect(sha256(expert.file)).toBe(beforeHash); // F2 holds under concurrency too
    await waitUntil(() => resumeCalls.every((c) => !existsSync(c.file!)));
  });
});

describe("consult integration: asker abort (§9 T-17)", () => {
  it("aborting the asker run cascades to the in-flight consult run; the tool nacks aborted and the fork is cleaned up", async () => {
    const expert = realExpertSession("abortexpert");
    const { calls } = spyOnDriver({
      // The dispatcher's own turn is "in the middle of calling consult" — its
      // prompt() never resolves on its own (we drive everything by hand).
      onCreate: async () => fakeHandle({ prompt: () => new Promise<void>(() => undefined) }),
      // The forked expert copy is likewise mid-turn when the abort lands.
      onResume: async (file) => fakeHandle({ sessionFile: file, prompt: () => new Promise<void>(() => undefined) }),
    });
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    const expertRef: ConsultExpertRef = { runId: "r_EXPERT1", sessionFile: expert.file, agentType: "explorer" };
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult then get aborted",
      consultExperts: [expertRef],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    const dispatcherRunId = spawned.runId;

    await waitUntil(() => calls.some((c) => c.kind === "create"));
    const tool = findConsultTool(calls.find((c) => c.kind === "create")!.spec);

    const resultPromise = tool.execute("call-1", { expert: "r_EXPERT1", question: "q" });
    await waitUntil(() => calls.some((c) => c.kind === "resume"));
    const forkFile = calls.find((c) => c.kind === "resume")!.file!;
    expect(existsSync(forkFile)).toBe(true);

    await waitUntil(() => stack.query.list({ parentRunId: dispatcherRunId }).length > 0);
    const consultSnap = stack.query.list({ parentRunId: dispatcherRunId })[0]!;
    // The fake resume() handle never fires a turn_start event, so the state
    // machine has no reason to advance past "starting" — the point being
    // tested here is liveness + correct parentRunId threading, not phase
    // progression (that belongs to the runner-level tests).
    expect(["starting", "running"]).toContain(consultSnap.status);

    await stack.spawn.abort(dispatcherRunId);

    const result = await resultPromise;
    expect(result.details.outcome).toBe("aborted");
    expect(result.content[0]!.text.length).toBeGreaterThan(0);

    await waitUntil(() => !existsSync(forkFile));
  });
});

describe("consult integration: fleet + notifications (§9 T-18/T-19)", () => {
  it("the consult run's fleet row is nested under the asker (T-18), and zero subagent:notification messages are ever sent for it (T-19)", async () => {
    const expert = realExpertSession("fleetexpert");
    const { calls } = spyOnDriver({
      onResume: async (file) => fakeHandle({ sessionFile: file, getLastAssistantText: () => "fleet answer" }),
    });
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    const expertRef: ConsultExpertRef = { runId: "r_EXPERT1", sessionFile: expert.file, agentType: "explorer" };
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult for fleet check",
      consultExperts: [expertRef],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    const dispatcherRunId = spawned.runId;

    await waitUntil(() => calls.some((c) => c.kind === "create"));
    const tool = findConsultTool(calls.find((c) => c.kind === "create")!.spec);

    // Snapshot the fleet row WHILE the consult run is still active (T-18
    // cares about a live nested row, not just the terminal one).
    const resultPromise = tool.execute("call-1", { expert: "r_EXPERT1", question: "q" });
    await waitUntil(() => stack.query.list({ parentRunId: dispatcherRunId }).length > 0);
    const liveConsultSnap = stack.query.list({ parentRunId: dispatcherRunId })[0]!;
    const liveModel = buildFleetViewModel(stack.query.list(), { now: Date.now() });
    const liveRow = liveModel.rows.find((r) => r.runId === liveConsultSnap.runId);
    expect(liveRow).toBeDefined();
    expect(liveRow!.nested).toBe(true);
    expect(liveRow!.parentRunId).toBe(dispatcherRunId);

    await resultPromise;

    // Post-settlement: the terminal row keeps the same nesting facts.
    const finalModel = buildFleetViewModel(stack.query.list({}), { now: Date.now(), recentTerminal: 20 });
    const finalRow = finalModel.rows.find((r) => r.runId === liveConsultSnap.runId);
    expect(finalRow).toBeDefined();
    expect(finalRow!.nested).toBe(true);
    expect(finalRow!.parentRunId).toBe(dispatcherRunId);

    // T-19: consult is expectAck-based (the tool itself waits on the
    // outcome) — it must never surface through the notification outbox. The
    // ASKER's own top-level completion notification (a normal, unrelated
    // subagent:run wrap-up — the asker was never itself acked here) is
    // expected and out of scope; only the CONSULT run's own notification
    // path is under test, identified by its own runId/label.
    const consultRunId = liveConsultSnap.runId;
    const notificationSends = h.sent.filter(
      (s) =>
        s.message.customType === "subagent:notification" &&
        (s.message.details as { runId?: string } | undefined)?.runId === consultRunId,
    );
    expect(notificationSends).toEqual([]);
    const triggerTurnSends = h.sent.filter(
      (s) =>
        (s.opts as { triggerTurn?: boolean } | undefined)?.triggerTurn === true &&
        (s.message.details as { runId?: string } | undefined)?.runId === consultRunId,
    );
    expect(triggerTurnSends).toEqual([]);
  });
});
