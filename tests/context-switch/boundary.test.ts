import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildChildSwitchDrafts, CHILD_SWITCH_RESUME_CUSTOM_TYPE } from "../../src/context-switch/boundary.js";

const CWD = "/tmp/child-switch-boundary-test";

function makeSession(): SessionManager {
  return new SessionManager(CWD, "test-session-dir", undefined, false);
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

function appendAssistantWithToolCall(sm: SessionManager, toolCallId: string, toolName = "switch_context"): string {
  return sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "calling tool" },
      { type: "toolCall", id: toolCallId, name: toolName, arguments: { goal: "g" } },
    ],
    api: "chat",
    provider: "test",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolCalls",
    timestamp: Date.now(),
  });
}

function appendToolResult(
  sm: SessionManager,
  toolCallId: string,
  toolName = "switch_context",
  isError = false,
): string {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: isError ? "boom" : "ok" }],
    isError,
    timestamp: Date.now(),
  });
}

/** A realistic scenario built through real SessionManager appends: a few filler turns (so
 *  keepRecent has somewhere non-trivial to land) then a final turn calling switch_context. */
function buildScenario(options: { fillerTurns?: number; toolCallId?: string } = {}) {
  const sm = makeSession();
  const header = sm.getHeader();
  const fillerTurns = options.fillerTurns ?? 3;
  for (let i = 0; i < fillerTurns; i++) appendUserAssistantTurn(sm, i);
  const toolCallId = options.toolCallId ?? "call-switch";
  const messageEntryId = appendAssistantWithToolCall(sm, toolCallId);
  const toolResultEntryId = appendToolResult(sm, toolCallId);
  const branch = sm.getBranch();
  return { sm, header, branch, messageEntryId, toolResultEntryId, toolCallId };
}

function toolResultsFor(toolCallId: string) {
  return [
    {
      role: "toolResult" as const,
      toolCallId,
      toolName: "switch_context",
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    },
  ];
}

function baseInput(overrides: Partial<Parameters<typeof buildChildSwitchDrafts>[0]> = {}) {
  const { header, branch, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
  return {
    header,
    branch,
    cwd: CWD,
    turn: {
      messageEntryId,
      toolResultEntryIds: [toolResultEntryId],
      toolResults: toolResultsFor(toolCallId),
      priorDrafts: [],
    },
    staged: {
      toolCallId,
      core: "core text ".repeat(20),
      keepRecent: true,
      seq: 1,
      nonce: "nonce-1",
    },
    keepRecentTokens: 50,
    facts: {},
    tokensBefore: 1000,
    ...overrides,
  };
}

describe("buildChildSwitchDrafts (plan §2.1, V1-V6)", () => {
  it("keep_recent:false -> firstKeptEntryId:null, drops everything before the turn", () => {
    const input = baseInput({ staged: { ...baseInput().staged, keepRecent: false } });
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compaction = result.entries[0] as { type: string; firstKeptEntryId: string | null; details: unknown };
    expect(compaction.type).toBe("compaction");
    expect(compaction.firstKeptEntryId).toBeNull();
    expect(result.diag.keepRecent).toBe(false);
    expect(result.diag.dropped.entries).toBeGreaterThan(0);
  });

  it("keep_recent:true -> equals findCutPoint result, kept segment never starts with a toolResult", () => {
    const input = baseInput();
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compaction = result.entries[0] as { firstKeptEntryId: string | null };
    expect(compaction.firstKeptEntryId).not.toBeNull();
    const kept = input.branch.find((e) => e.id === compaction.firstKeptEntryId) as
      { type: string; message?: { role?: string } } | undefined;
    expect(kept).toBeDefined();
    expect(kept?.type === "message" && kept.message?.role === "toolResult").toBe(false);
  });

  it("appendix carries session file / todos / file lists through facts + fileListsFromBranch", () => {
    const scenario = buildScenario();
    // Inject a read + a write tool call inside the dropped range so fileListsFromBranch has something to find.
    scenario.sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "/tmp/read-me.ts" } },
      ],
      api: "chat",
      provider: "test",
      model: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "toolCalls",
      timestamp: Date.now(),
    });
    // Re-derive the switch turn AFTER the read call so it lands inside the dropped (pre-cut) range.
    const toolCallId = "call-switch-2";
    const messageEntryId = appendAssistantWithToolCall(scenario.sm, toolCallId);
    const toolResultEntryId = appendToolResult(scenario.sm, toolCallId);
    const branch = scenario.sm.getBranch();
    const input = {
      header: scenario.header,
      branch,
      cwd: CWD,
      turn: {
        messageEntryId,
        toolResultEntryIds: [toolResultEntryId],
        toolResults: toolResultsFor(toolCallId),
        priorDrafts: [],
      },
      staged: { toolCallId, core: "core text ".repeat(20), keepRecent: false, seq: 2, nonce: "nonce-2" },
      keepRecentTokens: 50,
      facts: { sessionFile: "/tmp/session.jsonl", todos: ["#1 do the thing [pending]"] },
      tokensBefore: 1000,
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compaction = result.entries[0] as { summary: string };
    expect(compaction.summary).toContain("/tmp/session.jsonl");
    expect(compaction.summary).toContain("do the thing");
    expect(compaction.summary).toContain("/tmp/read-me.ts");
  });

  it("details carry source/seq/nonce/dropped", () => {
    const input = baseInput();
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compaction = result.entries[0] as { details: Record<string, unknown> };
    expect(compaction.details.source).toBe("pi-toolkit:switch_context");
    expect(compaction.details.seq).toBe(1);
    expect(compaction.details.nonce).toBe("nonce-1");
    expect(compaction.details.dropped).toBeDefined();
  });

  it("details.dropped carries tokensAfterEstimate (persisted, plan §2.1 ~L171) and it matches the diag copy", () => {
    const input = baseInput();
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compaction = result.entries[0] as { details: { dropped: Record<string, unknown> } };
    expect(typeof compaction.details.dropped.tokensAfterEstimate).toBe("number");
    expect(compaction.details.dropped.tokensAfterEstimate).toBeGreaterThan(0);
    // Persisted details.dropped and the returned diag.dropped must agree — same underlying object.
    expect(compaction.details.dropped).toEqual(result.diag.dropped);
  });

  it("keep_recent:false drops through the turn's last entry (plan §2.1: 'to turn 末条'), matching the last toolResultEntryId", () => {
    const input = baseInput({ staged: { ...baseInput().staged, keepRecent: false } });
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diag.dropped.toEntryId).toBe(input.turn.toolResultEntryIds[input.turn.toolResultEntryIds.length - 1]);
  });

  it("keep_recent:false also drops a custom entry another extension appended after the last toolResult", () => {
    const { sm, header, messageEntryId, toolResultEntryId, toolCallId } = buildScenario();
    const trailingId = sm.appendCustomEntry("other-ext:marker", { n: 1 });
    const base = baseInput();
    const input = {
      ...base,
      header,
      branch: sm.getBranch(),
      turn: { ...base.turn, messageEntryId, toolResultEntryIds: [toolResultEntryId] },
      staged: { ...base.staged, toolCallId, keepRecent: false },
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diag.dropped.toEntryId).toBe(trailingId);
    expect(result.commitProof.entryIds.has(trailingId)).toBe(true);
  });

  it("returns commitProof (v3.1 condition 1, L3(c) material): dropped entry ids and message fingerprints for the dropped range", () => {
    const input = baseInput({ staged: { ...baseInput().staged, keepRecent: false } });
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitProof.entryIds.size).toBeGreaterThan(0);
    expect(result.commitProof.fingerprints.size).toBeGreaterThan(0);
    // keep_recent:false drops everything through the turn's own message/toolResult (nothing is
    // kept, plan §2.1's "droppedEverything") — both are inside the dropped range.
    expect(result.commitProof.entryIds.has(input.turn.messageEntryId)).toBe(true);
    expect(result.commitProof.entryIds.has(input.turn.toolResultEntryIds[0]!)).toBe(true);
  });

  it("V1 unpersisted: toolResultEntryIds/toolResults length mismatch is rejected", () => {
    const input = baseInput();
    input.turn = { ...input.turn, toolResultEntryIds: [] };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "unpersisted" });
  });

  it("V2 order: a toolResultEntryId not found in the branch is rejected", () => {
    const input = baseInput();
    input.turn = { ...input.turn, toolResultEntryIds: ["does-not-exist"] };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "order" });
  });

  it("V2 order: messageEntryId itself missing from the branch is rejected", () => {
    const input = baseInput();
    input.turn = { ...input.turn, messageEntryId: "missing-message-id" };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "order" });
  });

  it("V3 concurrent-compaction: a compaction after messageEntryId is rejected", () => {
    const scenario = buildScenario();
    scenario.sm.appendCompaction("someone else compacted", scenario.branch[0]!.id, 10, undefined, true);
    const branch = scenario.sm.getBranch();
    const input = {
      header: scenario.header,
      branch,
      cwd: CWD,
      turn: {
        messageEntryId: scenario.messageEntryId,
        toolResultEntryIds: [scenario.toolResultEntryId],
        toolResults: toolResultsFor(scenario.toolCallId),
        priorDrafts: [],
      },
      staged: { toolCallId: scenario.toolCallId, core: "core text ".repeat(20), keepRecent: true, seq: 1, nonce: "n" },
      keepRecentTokens: 50,
      facts: {},
      tokensBefore: 1000,
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "concurrent-compaction" });
  });

  it("V4 boundary-conflict: priorDrafts containing context_edit is rejected", () => {
    const input = baseInput();
    input.turn = {
      ...input.turn,
      priorDrafts: [{ type: "context_edit", targetId: "x", replacement: null }] as never,
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "boundary-conflict" });
  });

  it("V4: priorDrafts containing a custom_message is accepted and placed after our compaction", () => {
    const input = baseInput();
    input.turn = {
      ...input.turn,
      priorDrafts: [{ type: "custom_message", customType: "other:audit", content: "hi", display: false }] as never,
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.entries[0] as { type: string }).type).toBe("compaction");
    expect((result.entries[1] as { customType: string }).customType).toBe("other:audit");
    expect((result.entries[2] as { customType: string }).customType).toBe(CHILD_SWITCH_RESUME_CUSTOM_TYPE);
  });

  it("V5 cut-point: a computed cut index landing past messageEntryId is rejected", () => {
    // Hand-crafted branch: an assistant message right after messageEntryId, before the toolResult,
    // forces findCutPoint (keepRecentTokens:0) to land past messageEntryId — real pi's own turn shape
    // can never produce this (results always follow immediately), this only exercises the guard.
    const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: CWD } as never;
    const branch = [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-switch", name: "switch_context", arguments: {} }],
          api: "chat",
          provider: "test",
          model: "m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "toolCalls",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "interleaved" }],
          api: "chat",
          provider: "test",
          model: "m",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "endTurn",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call-switch",
          toolName: "switch_context",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      },
    ] as never;
    const input = {
      header,
      branch,
      cwd: CWD,
      turn: {
        messageEntryId: "m1",
        toolResultEntryIds: ["m3"],
        toolResults: toolResultsFor("call-switch"),
        priorDrafts: [],
      },
      staged: { toolCallId: "call-switch", core: "core text ".repeat(20), keepRecent: true, seq: 1, nonce: "n" },
      keepRecentTokens: 0,
      facts: {},
      tokensBefore: 1000,
    };
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "cut-point" });
  });

  it("V6 preview-invalid: missing session header is rejected before any preview replay", () => {
    const input = baseInput({ header: undefined });
    const result = buildChildSwitchDrafts(input as never);
    expect(result).toEqual({ ok: false, reason: "preview-invalid" });
  });

  it("predicted 5k-entry branch replay stays fast (bounded, T-S3 style scale guard)", () => {
    const sm = makeSession();
    const header = sm.getHeader();
    for (let i = 0; i < 2500; i++) appendUserAssistantTurn(sm, i);
    const toolCallId = "call-switch-scale";
    const messageEntryId = appendAssistantWithToolCall(sm, toolCallId);
    const toolResultEntryId = appendToolResult(sm, toolCallId);
    const branch = sm.getBranch();
    const input = {
      header,
      branch,
      cwd: CWD,
      turn: {
        messageEntryId,
        toolResultEntryIds: [toolResultEntryId],
        toolResults: toolResultsFor(toolCallId),
        priorDrafts: [],
      },
      staged: { toolCallId, core: "core text ".repeat(20), keepRecent: false, seq: 1, nonce: "n" },
      keepRecentTokens: 50,
      facts: {},
      tokensBefore: 100_000,
    };
    const start = Date.now();
    const result = buildChildSwitchDrafts(input as never);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});
