import { describe, expect, it } from "vitest";
import {
  checkSwitchSelfCheck,
  computeDroppedFingerprints,
  fingerprintMessage,
  type FingerprintableMessage,
} from "../../src/context-switch/selfcheck.js";

/** Minimal branch entry shape `computeDroppedFingerprints` needs. */
interface FakeEntry {
  id: string;
  type: string;
  message?: FingerprintableMessage;
  summary?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

/** Mimics pi's `sessionEntryToContextMessages` closely enough for the four expandable types. */
function toContextMessages(entry: FakeEntry): FingerprintableMessage[] {
  if (entry.type === "message" && entry.message) return [entry.message];
  if (entry.type === "custom_message") {
    return [
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: entry.timestamp,
      },
    ];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [{ role: "branchSummary", summary: entry.summary, fromId: null, timestamp: entry.timestamp }];
  }
  if (entry.type === "compaction") {
    return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: 0, timestamp: entry.timestamp }];
  }
  return [];
}

describe("fingerprintMessage", () => {
  it("is deterministic for identical messages and differs for different content", () => {
    const a: FingerprintableMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "hi" }] };
    const b: FingerprintableMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "hi" }] };
    const c: FingerprintableMessage = { role: "user", timestamp: 1, content: [{ type: "text", text: "bye" }] };
    expect(fingerprintMessage(a)).toBe(fingerprintMessage(b));
    expect(fingerprintMessage(a)).not.toBe(fingerprintMessage(c));
  });

  it("folds toolCallId into the fingerprint so two toolResults with the same content differ", () => {
    const a: FingerprintableMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      timestamp: 1,
      content: [{ type: "text", text: "ok" }],
    };
    const b: FingerprintableMessage = { ...a, toolCallId: "call-2" };
    expect(fingerprintMessage(a)).not.toBe(fingerprintMessage(b));
  });

  it("falls back to `summary` for compactionSummary/branchSummary messages (no `content` field)", () => {
    const m: FingerprintableMessage = { role: "compactionSummary", summary: "s1", tokensBefore: 0, timestamp: 1 };
    const same: FingerprintableMessage = { role: "compactionSummary", summary: "s1", tokensBefore: 999, timestamp: 1 };
    const different: FingerprintableMessage = {
      role: "compactionSummary",
      summary: "s2",
      tokensBefore: 0,
      timestamp: 1,
    };
    expect(fingerprintMessage(m)).toBe(fingerprintMessage(same));
    expect(fingerprintMessage(m)).not.toBe(fingerprintMessage(different));
  });
});

describe("computeDroppedFingerprints", () => {
  const branch: FakeEntry[] = [
    { id: "e0", type: "message", message: { role: "user", timestamp: 1, content: "turn 0" } },
    {
      id: "e1",
      type: "message",
      message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "r0" }] },
    },
    { id: "e2", type: "custom", customType: "not-expandable" }, // plain custom: not in the expandable set
    {
      id: "e3",
      type: "message",
      message: { role: "toolResult", toolCallId: "call-x", timestamp: 3, content: [{ type: "text", text: "ok" }] },
    },
  ];

  it("collects the entry id set and the message fingerprints only for expandable entry types", () => {
    const result = computeDroppedFingerprints(branch, 0, 3, (e) => toContextMessages(e as FakeEntry));
    expect(result.entryIds).toEqual(new Set(["e0", "e1", "e2", "e3"]));
    // e2 is type "custom" (not in {message, custom_message, branch_summary, compaction}) so it
    // contributes an id but no fingerprint.
    expect(result.fingerprints.size).toBe(3);
  });

  it("clamps the range and skips system messages", () => {
    const withSystem: FakeEntry[] = [
      { id: "s0", type: "message", message: { role: "system", timestamp: 1, content: "sys" } },
      ...branch,
    ];
    const result = computeDroppedFingerprints(withSystem, -5, 999, (e) => toContextMessages(e as FakeEntry));
    expect(result.entryIds.has("s0")).toBe(true);
    // system messages never contribute fingerprints (they are always excluded from the compare).
    const systemFp = fingerprintMessage({ role: "system", timestamp: 1, content: "sys" });
    expect(result.fingerprints.has(systemFp)).toBe(false);
  });

  it("a throwing expansion is skipped rather than propagated (best-effort, never crashes the self-check)", () => {
    const result = computeDroppedFingerprints(branch, 0, 3, (e) => {
      if (e.id === "e1") throw new Error("boom");
      return toContextMessages(e as FakeEntry);
    });
    expect(result.entryIds.has("e1")).toBe(true); // id is still recorded
    expect(result.fingerprints.size).toBe(2); // just e0 and e3's fingerprints, e1's expansion was skipped
  });
});

describe("checkSwitchSelfCheck (plan §3.1 L3(c), v3.1 condition 1)", () => {
  function fp(...messages: FingerprintableMessage[]): Set<string> {
    return new Set(messages.map((m) => fingerprintMessage(m)));
  }

  const droppedMessage: FingerprintableMessage = {
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "dropped turn" }],
  };
  const droppedToolResult: FingerprintableMessage = {
    role: "toolResult",
    toolCallId: "call-dropped",
    timestamp: 2,
    content: [{ type: "text", text: "dropped result" }],
  };
  const summaryMessage: FingerprintableMessage = {
    role: "compactionSummary",
    summary: "our handoff",
    tokensBefore: 1000,
    timestamp: 3,
  };
  const resumeMessage: FingerprintableMessage = {
    role: "custom",
    customType: "subagent:switch-context-resume",
    content: "resume",
    timestamp: 4,
  };

  it("passes (c1/c2/c3 all satisfied) when the request only carries the summary + resume, no dropped content", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(["e0", "e1"]), fingerprints: fp(droppedMessage, droppedToolResult) },
      contextMessages: [{ role: "system", timestamp: 0, content: "sys" }, summaryMessage, resumeMessage],
      projectionSourceEntryIds: new Set(["compaction-entry", "resume-entry"]),
      expectedSummary: "our handoff",
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.tokensDecreased).toBe(true);
  });

  it("c1 fails: a dropped message's fingerprint is still present in the request, even though total tokens dropped", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(["e0", "e1"]), fingerprints: fp(droppedMessage, droppedToolResult) },
      contextMessages: [summaryMessage, droppedToolResult, resumeMessage],
      projectionSourceEntryIds: new Set(["compaction-entry"]),
      expectedSummary: "our handoff",
      tokensBefore: 1000,
      tokensAfter: 200, // T-D3 v3.1: token total decreased, must still fail — it's a weak check only.
    });
    expect(result).toMatchObject({ ok: false, reason: "c1-dropped-in-request" });
    expect(result.tokensDecreased).toBe(true);
  });

  it("c2 fails: the projection still carries a dropped source entry id even when fingerprints look clean", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(["e0", "e1"]), fingerprints: fp(droppedMessage) },
      contextMessages: [summaryMessage, resumeMessage],
      projectionSourceEntryIds: new Set(["compaction-entry", "e1"]),
      expectedSummary: "our handoff",
    });
    expect(result).toMatchObject({ ok: false, reason: "c2-dropped-in-projection" });
  });

  it("c3 fails: the first non-system message is not our compactionSummary", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(), fingerprints: new Set() },
      contextMessages: [{ role: "user", timestamp: 5, content: "not a handoff" }, resumeMessage],
      projectionSourceEntryIds: new Set(),
      expectedSummary: "our handoff",
    });
    expect(result).toMatchObject({ ok: false, reason: "c3-summary-mismatch" });
  });

  it("c3 fails: first message IS compactionSummary but its text doesn't match (e.g. a stale/other switch)", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(), fingerprints: new Set() },
      contextMessages: [
        { role: "compactionSummary", summary: "someone else's summary", tokensBefore: 0, timestamp: 1 },
      ],
      projectionSourceEntryIds: new Set(),
      expectedSummary: "our handoff",
    });
    expect(result).toMatchObject({ ok: false, reason: "c3-summary-mismatch" });
  });

  it("accepts pi's own later summary as the expected text once the caller has confirmed (a) — pi compacted after us", () => {
    // The caller is responsible for confirming fact (a) (a compaction after ours exists) before
    // passing pi's new summary text as `expectedSummary`; this function only compares strings.
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(), fingerprints: new Set() },
      contextMessages: [{ role: "compactionSummary", summary: "pi's merged summary", tokensBefore: 0, timestamp: 1 }],
      projectionSourceEntryIds: new Set(),
      expectedSummary: "pi's merged summary",
    });
    expect(result.ok).toBe(true);
  });

  it("tokensDecreased is undefined (not false) when before/after aren't both supplied — it never gates the result", () => {
    const result = checkSwitchSelfCheck({
      dropped: { entryIds: new Set(), fingerprints: new Set() },
      contextMessages: [summaryMessage],
      projectionSourceEntryIds: new Set(),
      expectedSummary: "our handoff",
    });
    expect(result.ok).toBe(true);
    expect(result.tokensDecreased).toBeUndefined();
  });
});
