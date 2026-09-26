/**
 * child-context-switch plan.md §7 P3 — T-D1/T-D2/T-D3/T-D5: capability degrade paths at the
 * WIRING layer (`wireChildContextSwitch`), distinct from:
 *   - tests/context-switch/capability.test.ts (T-L1): the pure state-machine transition matrix.
 *   - tests/context-switch/boundary-runtime-guard.test.ts: `buildChildSwitchDrafts`'s own
 *     namespace-import defensive checks (a DIFFERENT module, `boundary.ts`).
 *   - tests/context-switch/child.test.ts (T-S3): the turn_end/context handler's own logic with
 *     capability already forced to `ready`/`verified`.
 *   - tests/integration/child-switch-runner.test.ts / tests/runtime/runner-switch-selfcheck.test.ts:
 *     real-AgentSession / real-runner RunOutcome assertions for the "run still completes" and
 *     "self-check-fatal" cases respectively.
 *
 * T-D5 (L0) needs `@earendil-works/pi-coding-agent` itself to look degraded — `wireChildContextSwitch`
 * probes the REAL namespace import, so we use the same `vi.doMock` + `vi.resetModules()` + dynamic
 * re-import convention `boundary-runtime-guard.test.ts` already established, kept in its own
 * `describe` so it never contaminates the other (non-mocked) tests' module instances in this file.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { getChildSwitchCapability, resetChildSwitchCapabilityForTests } from "../../src/context-switch/capability.js";
import {
  SWITCH_CAPABILITY_CUSTOM_TYPE,
  SWITCH_NOTICE_CUSTOM_TYPE,
  SWITCH_REJECTED_CUSTOM_TYPE,
  wireChildContextSwitch,
} from "../../src/context-switch/child.js";

const CWD = "/tmp/child-switch-degrade-test";

function makeSession(): SessionManager {
  return new (
    SessionManager as unknown as new (cwd: string, sessionDir: string, x: unknown, persist: boolean) => SessionManager
  )(CWD, "test-session-dir", undefined, false);
}

function appendAssistantWithToolCall(sm: SessionManager, toolCallId: string, name = "bash"): string {
  return sm.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: {} }],
    api: "chat",
    provider: "test",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolCalls",
    timestamp: Date.now(),
  });
}
function appendToolResult(sm: SessionManager, toolCallId: string, name = "bash"): string {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  });
}

const HANDOFF_ARGS = {
  goal: "Ship T-D1-D5 degrade-path coverage for the child-context-switch package.",
  progress: "Wiring layer drives the capability state machine into each failure layer.",
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

function makeCtx(sm: SessionManager, sessionFile: string | undefined = "/tmp/fake-degrade.jsonl") {
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

beforeEach(() => resetChildSwitchCapabilityForTests());
afterEach(() => resetChildSwitchCapabilityForTests());

describe("T-D1: 0.86-shaped turn_end (no boundary fields) ⇒ L1 fails", () => {
  it('disabled:l1-event-shape, tool stays "not_ready" (never registered as unavailable — L0 passed), no throw, no headless hint', async () => {
    const capability = getChildSwitchCapability();
    capability.noteL0({ ok: true }); // L0 passes (real pi has every export) — only L1 must fail here.
    const { pi, handlers, tools, appended, sent } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    expect(tools.has("switch_context")).toBe(true); // L0 already passed, so the tool IS registered.

    const sm = makeSession();
    const ctx = makeCtx(sm);
    // A 0.86-shaped event: no `context` field at all (plan §1.6: 0.86's TurnEndEvent only has
    // type/turnIndex/message/toolResults), so `event.context?.canContinue` is `undefined`, not a
    // boolean — checkTurnEndShape's L1 check must fail on exactly that.
    const legacyShapedEvent = { entries: [], messageEntryId: "does-not-matter", toolResultEntryIds: [] };
    const turnEndHandler = handlers.get("turn_end")![0]!;
    expect(() => turnEndHandler(legacyShapedEvent, ctx)).not.toThrow();

    const status = capability.get();
    expect(status.state).toBe("disabled");
    if (status.state === "disabled") expect(status.reason).toBe("l1-event-shape");
    expect(
      appended.some(
        (e) =>
          e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE && (e.data as { reason?: string }).reason === "l1-event-shape",
      ),
    ).toBe(true);
    // No headless compact-hint tick/hint/demand — the capability gate is checked before it runs.
    expect(sent).toHaveLength(0);

    // The tool itself now reports unavailable (capability_disabled), matching the sticky state.
    const tool = tools.get("switch_context")!;
    const result = await tool.execute("tc1", HANDOFF_ARGS, undefined, undefined, ctx);
    expect((result.details as { ok?: boolean; reason?: string }).reason).toBe("capability_disabled");
  });
});

describe("T-D2: L2 zero-impact commit probe never lands on the branch", () => {
  it("disabled:l2-drafts-ignored — no real switch was ever accepted before this", () => {
    const capability = getChildSwitchCapability();
    capability.noteL0({ ok: true });
    capability.noteL1({ ok: true }); // now `observed` — L2's probe path in turn_end is reachable.
    const { pi, handlers, appended } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);

    const sm = makeSession();
    const toolCallId = "bash-1";
    const messageEntryId = appendAssistantWithToolCall(sm, toolCallId);
    const toolResultEntryId = appendToolResult(sm, toolCallId);
    const ctx = makeCtx(sm);

    const turnEndHandler = handlers.get("turn_end")![0]!;
    const turn = {
      outcome: "completed",
      context: { canContinue: true },
      entries: [],
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: [
        {
          role: "toolResult",
          toolCallId,
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };
    const returned = turnEndHandler(turn, ctx) as { entries: { type: string; customType?: string }[] } | undefined;
    // The handler DID append the zero-impact probe draft to its return value...
    expect(returned?.entries.some((e) => e.type === "custom" && e.customType === "subagent:boundary-probe")).toBe(true);
    expect(getChildSwitchCapability().get().state).toBe("observed"); // no conclusion yet.

    // ...but because this harness never feeds it back into a real pi commit, the REAL branch
    // (sm) never actually gains that probe entry — exactly the "runtime silently drops turn_end's
    // return value" failure mode the L2 probe exists to catch (plan §3.1 failure-mode table).
    expect(sm.getBranch().some((e) => e.type === "custom")).toBe(false);

    const contextHandler = handlers.get("context")![0]!;
    contextHandler({ messages: [] }, ctx);

    const status = getChildSwitchCapability().get();
    expect(status.state).toBe("disabled");
    if (status.state === "disabled") expect(status.reason).toBe("l2-drafts-ignored");
    expect(
      appended.some(
        (e) =>
          e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE &&
          (e.data as { reason?: string }).reason === "l2-drafts-ignored",
      ),
    ).toBe(true);
  });
});

describe("T-D3: L3(c) — committed, but the next context event still shows dropped content", () => {
  /** Drives a real switch through the wiring, then MANUALLY replays the handler's returned draft
   *  onto the real `sm` (mirroring what pi's own `_commitBoundaryDrafts` would do) so
   *  `findCommittedCompaction` on the real branch actually succeeds — the only way to reach an
   *  L3(c)-specific failure (as opposed to L3(a)'s "uncommitted", already covered elsewhere). */
  async function commitRealSwitch(
    sm: SessionManager,
    pi: ReturnType<typeof fakePi>["pi"],
    tools: Map<string, FakeTool>,
    handlers: Map<string, Handler[]>,
  ) {
    const toolCallId = "call-switch";
    const messageEntryId = appendAssistantWithToolCall(sm, toolCallId, "switch_context");
    const toolResultEntryId = appendToolResult(sm, toolCallId, "switch_context");
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
    const returned = turnEndHandler(turn, ctx) as {
      entries: {
        type: string;
        summary?: string;
        firstKeptEntryId?: string | null;
        details?: unknown;
        customType?: string;
        content?: string;
        display?: boolean;
      }[];
    };
    const compaction = returned.entries.find((e) => e.type === "compaction")!;
    const resume = returned.entries.find((e) => e.type === "custom_message")!;
    // Replay onto the REAL branch, exactly like pi's finishTurn would.
    sm.appendCompaction(compaction.summary!, compaction.firstKeptEntryId ?? null, 0, compaction.details, true);
    sm.appendCustomMessageEntry(resume.customType!, resume.content!, resume.display ?? false, {});
    return { ctx, expectedSummary: compaction.summary! };
  }

  it('a `verified`-state single L3(c) recheck failure ("c3-summary-mismatch") records rejected + notifies, WITHOUT disabling', async () => {
    const capability = getChildSwitchCapability();
    capability.noteL0({ ok: true });
    capability.noteL1({ ok: true });
    capability.noteL2({ ok: true });
    capability.tryBeginVerification();
    capability.noteL3({ ok: true }); // now `verified`.
    const { pi, handlers, tools, appended, sent } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const sm = makeSession();
    const { ctx } = await commitRealSwitch(sm, pi, tools, handlers);

    // Deliberately a MISMATCHED summary as the first non-system message — c3 fails even though
    // the compaction really is on the branch this time (unlike T-D2/child.test.ts's "uncommitted").
    const contextHandler = handlers.get("context")![0]!;
    contextHandler({ messages: [{ role: "compactionSummary", summary: "totally different text", timestamp: 1 }] }, ctx);

    expect(getChildSwitchCapability().get().state).toBe("verified"); // single failure ⇒ not disabled.
    const rejectedNotice = appended.find((e) => e.customType === SWITCH_REJECTED_CUSTOM_TYPE);
    expect(rejectedNotice?.data).toEqual({ reason: "c3-summary-mismatch" });
    expect(appended.some((e) => e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE)).toBe(false);
    expect(sent.some((s) => (s.message as { customType?: string })?.customType === SWITCH_NOTICE_CUSTOM_TYPE)).toBe(
      true,
    );
  });

  it("two CONSECUTIVE `verified`-state L3(c) recheck failures ⇒ disabled:repeat-uncommitted", async () => {
    const capability = getChildSwitchCapability();
    capability.noteL0({ ok: true });
    capability.noteL1({ ok: true });
    capability.noteL2({ ok: true });
    capability.tryBeginVerification();
    capability.noteL3({ ok: true });
    // Two DIFFERENT child sessions (fresh `wireChildContextSwitch` + store each, exactly like two
    // separate subagent runs would be) failing consecutively — capability is process-wide, so
    // this is the realistic shape of "two consecutive failures" rather than reusing one store
    // across both (which would trip its own 60s cooldown on the second `execute()` call).
    const first = fakePi();
    wireChildContextSwitch(first.pi as never, DEFAULT_SETTINGS);
    const sm1 = makeSession();
    const { ctx: ctx1 } = await commitRealSwitch(sm1, first.pi, first.tools, first.handlers);
    const contextHandler1 = first.handlers.get("context")![0]!;
    contextHandler1({ messages: [{ role: "compactionSummary", summary: "wrong 1", timestamp: 1 }] }, ctx1);
    expect(getChildSwitchCapability().get().state).toBe("verified"); // 1st failure: still verified.

    const second = fakePi();
    wireChildContextSwitch(second.pi as never, DEFAULT_SETTINGS);
    const sm2 = makeSession();
    const { ctx: ctx2 } = await commitRealSwitch(sm2, second.pi, second.tools, second.handlers);
    const contextHandler2 = second.handlers.get("context")![0]!;
    contextHandler2({ messages: [{ role: "compactionSummary", summary: "wrong 2", timestamp: 1 }] }, ctx2);

    const status = getChildSwitchCapability().get();
    expect(status.state).toBe("disabled"); // 2nd CONSECUTIVE failure: disabled.
    if (status.state === "disabled") expect(status.reason).toBe("repeat-uncommitted");
    expect(
      second.appended.some(
        (e) =>
          e.customType === SWITCH_CAPABILITY_CUSTOM_TYPE &&
          (e.data as { reason?: string }).reason === "repeat-uncommitted",
      ),
    ).toBe(true);
  });

  it("the FIRST verification window disables immediately on the same L3(c) failure (stricter than a post-verified recheck)", async () => {
    const capability = getChildSwitchCapability();
    capability.noteL0({ ok: true });
    capability.noteL1({ ok: true });
    capability.noteL2({ ok: true }); // `ready`, NOT verified yet.
    const { pi, handlers, tools } = fakePi();
    wireChildContextSwitch(pi as never, DEFAULT_SETTINGS);
    const sm = makeSession();
    const { ctx } = await commitRealSwitch(sm, pi, tools, handlers);
    expect(getChildSwitchCapability().get().state).toBe("verifying");

    const contextHandler = handlers.get("context")![0]!;
    contextHandler({ messages: [{ role: "compactionSummary", summary: "wrong", timestamp: 1 }] }, ctx);

    const status = getChildSwitchCapability().get();
    expect(status.state).toBe("disabled");
    if (status.state === "disabled") expect(status.reason).toBe("c3-summary-mismatch");
  });
});

describe("T-D5: L0 static probe fails (mocked pi namespace missing an export)", () => {
  afterEach(() => {
    vi.doUnmock("@earendil-works/pi-coding-agent");
    vi.resetModules();
  });

  it("wireChildContextSwitch registers ZERO tools/handlers, never throws, and disables the process-wide capability", async () => {
    resetChildSwitchCapabilityForTests();
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      // Strip SessionManager.inMemory (0.86-shaped export, plan §1.6) — probeBoundaryStatic's L0
      // check must catch this before any registerTool/pi.on call ever happens.
      return { ...actual, SessionManager: {} };
    });
    const { wireChildContextSwitch: wireDegraded } = await import("../../src/context-switch/child.js");
    const { getChildSwitchCapability: getCapDegraded, resetChildSwitchCapabilityForTests: resetDegraded } =
      await import("../../src/context-switch/capability.js");
    resetDegraded();
    const { pi, handlers, tools } = fakePi();
    expect(() => wireDegraded(pi as never, DEFAULT_SETTINGS)).not.toThrow();
    expect(tools.size).toBe(0);
    expect(handlers.size).toBe(0);
    const status = getCapDegraded().get();
    expect(status.state).toBe("disabled");
    if (status.state === "disabled") expect(status.reason.startsWith("l0-")).toBe(true);
    resetDegraded();
  });
});
