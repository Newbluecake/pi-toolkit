/**
 * child-context-switch plan.md §7 P3 — T-S3: dedicated fake-ExtensionAPI coverage of
 * `wireChildContextSwitch`'s `turn_end`/`context` handler LOGIC in isolation, complementing
 * (not duplicating) the two heavier suites that already exist:
 *   - tests/context-switch/boundary.test.ts (T-S1): `buildChildSwitchDrafts` V1-V6 in isolation,
 *     including the 5k-entry replay timing guard — not repeated here.
 *   - tests/integration/child-switch-runner.test.ts (T-S7-lite): full round-trip through a REAL
 *     `AgentSession` + faux provider, including the context-event self-check settling to
 *     `verified` and the real pi commit.
 *
 * Here we drive the handlers the module registers directly (a fake `pi: ExtensionAPI`, capturing
 * `registerTool`/`on`/`appendEntry`/`sendMessage`), against a REAL (non-persisted) `SessionManager`
 * — same "bypass the private constructor at the JS runtime level" trick `boundary.test.ts` uses
 * (vitest transpiles test files without type-checking, so the TS-only `private constructor` never
 * applies) — so `buildChildSwitchDrafts`'s real pi-runtime calls (`SessionManager.inMemory`, etc.)
 * see structurally valid entries without needing a full `AgentSession`/model round-trip.
 *
 * Because we never feed the handler's RETURNED drafts back into a real pi commit (there is no
 * real `AgentSession` here), a "committed" switch in these tests never actually lands on the real
 * `SessionManager`'s branch — which is exactly the shape needed to exercise the context handler's
 * self-check "uncommitted" path without a colliding extension: our OWN commit event's fictional
 * assumption ("this draft will be committed") simply never comes true, the same observable
 * surface as another handler poisoning the turn (already covered end-to-end in
 * child-switch-runner.test.ts's T-D2/T-C2-style suite).
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { getChildSwitchCapability, resetChildSwitchCapabilityForTests } from "../../src/context-switch/capability.js";
import {
  SWITCH_CAPABILITY_CUSTOM_TYPE,
  SWITCH_NOTICE_CUSTOM_TYPE,
  SWITCH_REJECTED_CUSTOM_TYPE,
  wireChildContextSwitch,
} from "../../src/context-switch/child.js";

const CWD = "/tmp/child-switch-wiring-test";

function makeSession(): SessionManager {
  return new (
    SessionManager as unknown as new (cwd: string, sessionDir: string, x: unknown, persist: boolean) => SessionManager
  )(CWD, "test-session-dir", undefined, false);
}

function appendUserAssistantTurn(sm: SessionManager, i: number): void {
  sm.appendMessage({ role: "user", content: [{ type: "text", text: `turn ${i}` }], timestamp: Date.now() });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `reply ${i}` }],
    api: "chat",
    provider: "test",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "endTurn",
    timestamp: Date.now(),
  });
}

function appendAssistantWithToolCall(sm: SessionManager, toolCallId: string, name = "switch_context"): string {
  return sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "calling tool" },
      { type: "toolCall", id: toolCallId, name, arguments: { goal: "g" } },
    ],
    api: "chat",
    provider: "test",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolCalls",
    timestamp: Date.now(),
  });
}

function appendToolResult(sm: SessionManager, toolCallId: string, name = "switch_context", isError = false): string {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: name,
    content: [{ type: "text", text: isError ? "boom" : "ok" }],
    isError,
    timestamp: Date.now(),
  });
}

/** A realistic scenario: a few filler turns, then a final turn calling switch_context. */
function buildScenario(options: { fillerTurns?: number; toolCallId?: string } = {}) {
  const sm = makeSession();
  const fillerTurns = options.fillerTurns ?? 2;
  for (let i = 0; i < fillerTurns; i++) appendUserAssistantTurn(sm, i);
  const toolCallId = options.toolCallId ?? "call-switch";
  const messageEntryId = appendAssistantWithToolCall(sm, toolCallId);
  const toolResultEntryId = appendToolResult(sm, toolCallId);
  return { sm, messageEntryId, toolResultEntryId, toolCallId };
}

const HANDOFF_ARGS = {
  goal: "Ship the T-S3 handler-level coverage for the child-context-switch package.",
  progress: "Wired a fake ExtensionAPI + a real, non-persisted SessionManager as the harness.",
  next_steps: "Run the full gate and report back.",
  keep_recent: false,
};

type FakeToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: "text"; text: string }[];
  isError: boolean;
  timestamp: number;
  details?: unknown;
};

function toolResultFor(toolCallId: string, details: unknown, isError = false): FakeToolResult {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "switch_context",
    content: [{ type: "text", text: isError ? "boom" : "ok" }],
    isError,
    timestamp: Date.now(),
    details,
  };
}

interface FakeTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: unknown; details: unknown; isError?: boolean }>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, FakeTool>();
  const appended: { customType: string; data: unknown }[] = [];
  const sent: { message: unknown; options: unknown }[] = [];
  const pi = {
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    getActiveTools: () => ["switch_context"],
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi, handlers, tools, appended, sent };
}

function makeCtx(sm: SessionManager, overrides: { sessionFile?: string | undefined } = {}) {
  const sessionFile = "sessionFile" in overrides ? overrides.sessionFile : "/tmp/fake-child-switch.jsonl";
  return {
    cwd: CWD,
    sessionManager: {
      getBranch: () => sm.getBranch(),
      getHeader: () => sm.getHeader(),
      buildSessionProjection: () => sm.buildSessionProjection(),
      getSessionFile: () => sessionFile,
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
    mode: "print",
  };
}

/** Drives the capability state machine directly to `ready` (skips L2's real probe/context-event
 *  round-trip — that path is exhaustively covered by capability.test.ts and the T-S7-lite
 *  integration suite; here we only need "some way to reach `ready`" so the handler's commit path
 *  is reachable). */
function forceReady(): void {
  const capability = getChildSwitchCapability();
  capability.noteL0({ ok: true });
  capability.noteL1({ ok: true });
  capability.noteL2({ ok: true });
}
function forceVerified(): void {
  forceReady();
  const capability = getChildSwitchCapability();
  capability.tryBeginVerification();
  capability.noteL3({ ok: true });
}

beforeEach(() => resetChildSwitchCapabilityForTests());
afterEach(() => resetChildSwitchCapabilityForTests());

describe("wireChildContextSwitch turn_end handler (T-S3)", () => {
  it("same-turn toolCallId match ⇒ [compaction, ...prior, resume], never a `continue` field, event.entries preserved", async () => {
    forceReady();
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);

    const tool = tools.get("switch_context")!;
    const result = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);
    expect((result.details as { ok?: boolean }).ok).toBe(true);

    const priorEntry = { type: "custom_message" as const, customType: "other:thing", content: "x", display: false };
    const turnEnd = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [priorEntry],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, result.details)],
    };

    const turnEndHandlers = handlers.get("turn_end") ?? [];
    expect(turnEndHandlers).toHaveLength(1);
    const returned = turnEndHandlers[0]!(turnEnd, ctx) as { entries: unknown[] } | undefined;
    expect(returned).toBeDefined();
    expect(returned && "continue" in returned).toBe(false);
    const entries = returned!.entries as { type: string; customType?: string }[];
    expect(entries[0]!.type).toBe("compaction");
    expect(entries.some((e) => e === priorEntry)).toBe(true);
    expect(entries[entries.length - 1]!.type).toBe("custom_message");
    expect(entries[entries.length - 1]!.customType).toBe("subagent:switch-context-resume");
  });

  it("outcome !== completed ⇒ returns undefined and the staged switch is discarded (never resurrected)", async () => {
    forceReady();
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);
    const tool = tools.get("switch_context")!;
    const result = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);

    const turnEndHandler = handlers.get("turn_end")![0]!;
    const abortedTurn = {
      outcome: "aborted",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, result.details)],
    };
    const returned = turnEndHandler(abortedTurn, ctx);
    expect(returned).toBeUndefined();

    // A LATER turn_end that (implausibly) still references the same toolCallId must not
    // resurrect the discarded stage — the store was already cleared unconditionally.
    const laterTurn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, result.details)],
    };
    const laterReturned = turnEndHandler(laterTurn, ctx) as { entries: unknown[] } | undefined;
    const laterEntries = (laterReturned?.entries ?? []) as { type: string }[];
    expect(laterEntries.some((e) => e.type === "compaction")).toBe(false);
  });

  it("a toolCallId not present in this turn's toolResults is discarded permanently, not carried to the next turn", async () => {
    forceReady();
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);
    const tool = tools.get("switch_context")!;
    const result = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);

    const turnEndHandler = handlers.get("turn_end")![0]!;
    // Turn N: toolResults reference a DIFFERENT toolCallId (our staged one is not "in this turn").
    const mismatchedTurn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor("some-other-call", { ok: true })],
    };
    turnEndHandler(mismatchedTurn, ctx);

    // Turn N+1: NOW toolResults do reference our original toolCallId — it must still be gone.
    const laterTurn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, result.details)],
    };
    const returned = turnEndHandler(laterTurn, ctx) as { entries: unknown[] } | undefined;
    const entries = (returned?.entries ?? []) as { type: string }[];
    expect(entries.some((e) => e.type === "compaction")).toBe(false);
  });

  it("store freshness is structural, not time-based: a long-running tool call in between still commits", async () => {
    forceReady();
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);
    const tool = tools.get("switch_context")!;
    const result = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);
    // ChildSwitchStore has NO TTL at all (unlike the legacy PendingHandoffStore's 120s window,
    // plan §2.1: "不用 120s TTL"), so a turn_end arriving long after staging (e.g. a 700s blocking
    // bash/nested-Agent tool call in between) must still commit. We assert the ABSENCE of any
    // time-based gate by driving the store's underlying clock reference point far into the
    // future via `Date.now` — the store never reads it at all, so nothing here can fail on
    // account of elapsed time.
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 700_000;
      const turnEndHandler = handlers.get("turn_end")![0]!;
      const turn = {
        outcome: "completed",
        context: { canContinue: true },
        entries: [],
        messageEntryId,
        toolResultEntryIds: [toolResultEntryId],
        toolResults: [toolResultFor(toolCallId, result.details)],
      };
      const returned = turnEndHandler(turn, ctx) as { entries: unknown[] } | undefined;
      const entries = (returned?.entries ?? []) as { type: string }[];
      expect(entries.some((e) => e.type === "compaction")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("handler exceptions never escape (a throwing sessionManager.getBranch inside the real-commit step degrades to undefined, not a throw)", async () => {
    forceReady();
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const realBranch = sm.getBranch();
    let getBranchCalls = 0;
    const ctx = {
      cwd: CWD,
      sessionManager: {
        // L1's OWN check (checkTurnEndShape) calls getBranch() once and must see a valid branch
        // (it needs to find messageEntryId there) so capability reaches `ready`'s commit path in
        // the first place; the SECOND call — inside the real-commit block below — throws. Both
        // calls happen inside the same turn_end handler invocation, inside its top-level
        // try/catch (plan §2.1 step 3: "handler 的任何异常都在 handler 内 catch 后走这条路，
        // 绝不外抛").
        getBranch: () => {
          getBranchCalls += 1;
          // Call #1 happens inside the tool's OWN `execute()` (its childMaxSwitches count check);
          // call #2 is L1's own presence check (must see a valid branch to reach `ready`'s commit
          // path); call #3 is the real-commit block's own getBranch() — THAT one throws.
          if (getBranchCalls > 2) throw new Error("boom");
          return realBranch;
        },
        getHeader: () => sm.getHeader(),
        buildSessionProjection: () => sm.buildSessionProjection(),
        getSessionFile: () => "/tmp/fake.jsonl",
      },
      getContextUsage: () => undefined,
      mode: "print",
    };
    const tool = tools.get("switch_context")!;
    const staged = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);
    const turnEndHandler = handlers.get("turn_end")![0]!;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, staged.details)],
    };
    let returned: unknown;
    expect(() => {
      returned = turnEndHandler(turn, ctx);
    }).not.toThrow();
    expect(returned).toBeUndefined(); // degrades cleanly, no draft — never a half-built commit.
    expect(getBranchCalls).toBeGreaterThan(2); // sanity: we actually reached (and tripped) the throwing call.
  });

  it("V1-V6 structural rejection (order violation) appends a rejected diagnostic entry AND a model-visible failure notice, never a compaction", async () => {
    forceReady();
    const { pi, handlers, tools, appended } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);
    const tool = tools.get("switch_context")!;
    const result = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);

    const turnEndHandler = handlers.get("turn_end")![0]!;
    // V2 "order": messageEntryId is real (L1's own presence check must pass), but the
    // toolResultEntryIds entry we hand in points at a REAL, EARLIER branch entry (one of the
    // filler turns) instead of the actual tool-result entry — violating "located after
    // messageEntryId, strictly increasing" without violating V1's length check.
    const earlierEntryId = sm.getBranch()[0]!.id;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [earlierEntryId],
      toolResults: [toolResultFor(toolCallId, result.details)],
    };
    const returned = turnEndHandler(turn, ctx) as {
      entries: { type: string; details?: { reason?: string } }[];
    };
    expect(returned.entries.some((e) => e.type === "compaction")).toBe(false);
    const notice = returned.entries.find((e) => e.type === "custom_message");
    expect(notice?.details?.reason).toBe("order");
    const rejectedNotice = appended.find((e) => e.customType === SWITCH_REJECTED_CUSTOM_TYPE);
    expect(rejectedNotice?.data).toEqual({ reason: "order" });
  });

  it('"unpersisted": a not-ok tool result appends a rejected diagnostic entry with reason "unpersisted"', async () => {
    forceReady();
    const { pi, handlers, tools, appended } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);
    const tool = tools.get("switch_context")!;
    await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);

    const turnEndHandler = handlers.get("turn_end")![0]!;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      // The tool result itself reports failure — `details.ok` is not `true`.
      toolResults: [toolResultFor(toolCallId, { ok: false, reason: "in_flight" })],
    };
    const returned = turnEndHandler(turn, ctx) as {
      entries: { type: string; details?: { reason?: string } }[];
    };
    expect(returned.entries.some((e) => e.type === "compaction")).toBe(false);
    const rejectedNotice = appended.find((e) => e.customType === SWITCH_REJECTED_CUSTOM_TYPE);
    expect(rejectedNotice?.data).toEqual({ reason: "unpersisted" });
  });
});

describe("wireChildContextSwitch context handler self-check recheck (T-S3)", () => {
  it('a `verified`-state single self-check failure ("uncommitted") reports rejected + notifies, WITHOUT disabling capability', async () => {
    forceVerified();
    const { pi, handlers, tools, appended, sent } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario({ toolCallId: "call-verify" });
    const ctx = makeCtx(sm);

    const tool = tools.get("switch_context")!;
    const staged = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);
    const turnEndHandler = handlers.get("turn_end")![0]!;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, staged.details)],
    };
    // Commits successfully from the WIRING's point of view (pendingCommit gets armed) — but,
    // because this harness never feeds the returned draft back into a real pi commit, the
    // REAL branch (sm) never actually gains a compaction entry. The next `context` event's
    // self-check therefore genuinely fails to find it — "uncommitted", by construction.
    const returnedTurn = turnEndHandler(turn, ctx) as { entries: { type: string }[] };
    expect(returnedTurn.entries.some((e) => e.type === "compaction")).toBe(true); // handler DID stage a commit…
    expect(sm.getBranch().some((e) => e.type === "compaction")).toBe(false); // …but it never landed on the real branch.

    const contextHandler = handlers.get("context")![0]!;
    contextHandler({ messages: [] }, ctx);

    expect(getChildSwitchCapability().get().state).toBe("verified"); // single failure ⇒ not disabled
    const rejectedNotice = appended.find((e) => e.customType === SWITCH_REJECTED_CUSTOM_TYPE);
    expect(rejectedNotice?.data).toEqual({ reason: "uncommitted" });
    expect(appended.some((e) => e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE)).toBe(false);
    expect(sent.some((s) => (s.message as { customType?: string })?.customType === SWITCH_NOTICE_CUSTOM_TYPE)).toBe(
      true,
    );
  });

  it('the FIRST verification window ("ready" → "verifying") disables on the same self-check failure (stricter than a post-verified recheck)', async () => {
    forceReady();
    const { pi, handlers, tools, appended } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const { sm, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const ctx = makeCtx(sm);

    const tool = tools.get("switch_context")!;
    const staged = await tool.execute(toolCallId, HANDOFF_ARGS, undefined, undefined, ctx);
    const turnEndHandler = handlers.get("turn_end")![0]!;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [toolResultFor(toolCallId, staged.details)],
    };
    turnEndHandler(turn, ctx);
    expect(getChildSwitchCapability().get().state).toBe("verifying");

    const contextHandler = handlers.get("context")![0]!;
    contextHandler({ messages: [] }, ctx);

    const status = getChildSwitchCapability().get();
    expect(status.state).toBe("disabled");
    if (status.state === "disabled") expect(status.reason).toBe("uncommitted");
    expect(appended.some((e) => e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE)).toBe(true);
    expect(appended.some((e) => e.customType === SWITCH_REJECTED_CUSTOM_TYPE)).toBe(true);
  });
});
