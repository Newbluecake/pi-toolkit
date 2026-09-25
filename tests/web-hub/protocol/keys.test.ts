import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS, type WireEntry, type WireMessage } from "../../../src/web-hub/protocol/messages.js";
import {
  customKey,
  diffAppended,
  entryKey,
  messageKey,
  projectSessionEntry,
  reconcileRecent,
  truncateText,
} from "../../../src/web-hub/protocol/keys.js";

const FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/web-hub/session-sample.jsonl", import.meta.url));

function loadFixture(): unknown[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("messageKey", () => {
  it("keys the four timestamped roles", () => {
    expect(messageKey({ role: "user", timestamp: 1790342521100 })).toBe("user:1790342521100");
    expect(messageKey({ role: "assistant", timestamp: 1790342523472 })).toBe("assistant:1790342523472");
    expect(messageKey({ role: "system", timestamp: 1790342449757 })).toBe("system:1790342449757");
    expect(messageKey({ role: "toolResult", timestamp: 1790342523900, toolCallId: "call_1" })).toBe(
      "toolResult:1790342523900:call_1",
    );
  });

  it("keys custom by content, not timestamp", () => {
    const k1 = messageKey({ role: "custom", customType: "probe:custom", content: "hello", timestamp: 1 });
    const k2 = messageKey({ role: "custom", customType: "probe:custom", content: "hello", timestamp: 2 });
    expect(k1).toBe(k2);
    expect(k1).toBe(customKey("probe:custom", "hello"));
  });
});

describe("customKey", () => {
  it("is deterministic across key order (canonical json)", () => {
    expect(customKey("t", { a: 1, b: [2, { c: 3 }] })).toBe(customKey("t", { b: [2, { c: 3 }], a: 1 }));
  });

  it("differs for different customType or payload", () => {
    expect(customKey("a", { x: 1 })).not.toBe(customKey("b", { x: 1 }));
    expect(customKey("a", { x: 1 })).not.toBe(customKey("a", { x: 2 }));
  });

  it("both custom forms of the same payload get the same key (content vs data)", () => {
    // custom_message (content) 与 custom (data) 对同载荷得同 customKey
    const payload = { v: 1, sections: { a: 1 } };
    const customMessageEntry = projectSessionEntry({
      type: "custom_message",
      customType: "probe:custom",
      content: payload,
      id: "e1",
      parentId: null,
      timestamp: "2026-09-25T13:21:25.409Z",
    });
    const customEntry = projectSessionEntry({
      type: "custom",
      customType: "probe:custom",
      data: payload,
      id: "e2",
      parentId: null,
      timestamp: "2026-09-25T13:21:26.409Z",
    });
    expect(customMessageEntry).toBeDefined();
    expect(customEntry).toBeDefined();
    expect(entryKey(customMessageEntry!)).toBe(entryKey(customEntry!));
    expect(entryKey(customMessageEntry!)).toBe(customKey("probe:custom", payload));
    // 不同 type 不同键
    expect(entryKey(customMessageEntry!)).not.toBe(customKey("other:custom", payload));
  });
});

describe("projectSessionEntry over the fixture", () => {
  const projected = loadFixture().map((raw) => projectSessionEntry(raw));

  it("drops the session header", () => {
    expect(projected[0]).toBeUndefined();
  });

  it("projects model_change / thinking_level_change bare", () => {
    expect(projected[1]).toEqual({
      id: "32b5dd7e",
      parentId: null,
      type: "model_change",
      timestamp: "2026-09-25T13:16:24.316Z",
    });
    expect(projected[2]).toEqual({
      id: "14b6d8a0",
      parentId: "32b5dd7e",
      type: "thinking_level_change",
      timestamp: "2026-09-25T13:16:24.316Z",
    });
  });

  it("projects custom(data) as non-rendering entry with precomputed dataKey, dropping data", () => {
    const e = projected[3]!;
    expect(e.type).toBe("custom");
    expect(e.customType).toBe("subagent:prompt-sections");
    expect(e.display).toBe(false);
    expect("data" in e).toBe(false);
    expect(e.dataKey).toBe(
      customKey("subagent:prompt-sections", {
        v: 1,
        sections: { pi_project_memory: { snapshot: "", sentCount: 0, sentBytes: 0 } },
      }),
    );
  });

  it("projects custom_message(content) with display and no details", () => {
    const e = projected[4]!;
    expect(e).toEqual({
      id: "a7842bcd",
      parentId: "d998d67f",
      type: "custom_message",
      timestamp: "2026-09-25T13:21:25.409Z",
      customType: "probe:custom",
      content: "hello",
      display: true,
    });
  });

  it("projects the three messages with their timestamps intact", () => {
    expect(projected[5]!.message).toMatchObject({ role: "user", timestamp: 1790342521100 });
    expect(projected[6]!.message).toMatchObject({
      role: "assistant",
      timestamp: 1790342523472,
      usage: { cost: { total: 0.000321 } },
    });
    expect(projected[7]!.message).toMatchObject({ role: "toolResult", timestamp: 1790342523900, toolCallId: "call_1" });
    // fixture timestamps are entry-level ISO only for custom forms; messages keep numeric ms
    expect(messageKey(projected[7]!.message!)).toBe("toolResult:1790342523900:call_1");
  });

  it("projects compaction with summary + firstKeptEntryId", () => {
    expect(projected[8]).toEqual({
      id: "9599fb40",
      parentId: "7f2a9c04",
      type: "compaction",
      timestamp: "2026-09-25T13:24:07.179Z",
      summary: "## Goal\n- Summarize package.json for the user in one line.",
      firstKeptEntryId: "9599fb40",
    });
  });

  it("drops label / session_info / usage / context_edit / unknown types and malformed input", () => {
    expect(
      projectSessionEntry({ type: "label", id: "l1", parentId: null, timestamp: "t", targetId: "x", label: "y" }),
    ).toBeUndefined();
    expect(
      projectSessionEntry({ type: "session_info", id: "s1", parentId: null, timestamp: "t", name: "n" }),
    ).toBeUndefined();
    expect(projectSessionEntry({ type: "usage", id: "u1", parentId: null, timestamp: "t", kind: "k" })).toBeUndefined();
    expect(
      projectSessionEntry({ type: "context_edit", id: "c1", parentId: null, timestamp: "t", targetId: "x" }),
    ).toBeUndefined();
    expect(
      projectSessionEntry({ type: "message", id: "m1", timestamp: "t", message: { role: "user" } }),
    ).toBeUndefined(); // no parentId
    expect(projectSessionEntry("junk")).toBeUndefined();
    expect(projectSessionEntry(null)).toBeUndefined();
    expect(projectSessionEntry([1])).toBeUndefined();
  });

  it("truncates oversized text and marks truncated", () => {
    const big = "x".repeat(LIMITS.textTruncateBytes + 100);
    const e = projectSessionEntry({
      type: "custom_message",
      customType: "t",
      content: big,
      id: "e",
      parentId: null,
      timestamp: "t",
    })!;
    expect(e.truncated).toBe(true);
    expect((e.content as string).length).toBe(LIMITS.textTruncateBytes);
    expect(Buffer.byteLength(e.content as string)).toBe(LIMITS.textTruncateBytes);

    const small = projectSessionEntry({
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: "fine", timestamp: 1, thinking: "y".repeat(LIMITS.textTruncateBytes + 5) },
    })!;
    expect(small.truncated).toBe(true);
    expect((small.message!.thinking as string).length).toBe(LIMITS.textTruncateBytes);

    const ok = projectSessionEntry({
      type: "message",
      id: "e3",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: "fine", timestamp: 1 },
    })!;
    expect(ok.truncated).toBeUndefined();
  });
});

describe("reconcileRecent", () => {
  const recentCustom = (seq: number): { seq: number; message: WireMessage } => ({
    seq,
    message: { role: "custom", customType: "probe:custom", content: "hello" },
  });
  const customEntry = (id: string): WireEntry =>
    projectSessionEntry({
      type: "custom_message",
      customType: "probe:custom",
      content: "hello",
      id,
      parentId: null,
      timestamp: `2026-09-25T13:21:2${id.length}.409Z`,
    })!;

  it("keeps consecutive identical customs: 0/1/2 persisted → 2/1/0 appended", () => {
    const recent = [recentCustom(5), recentCustom(6)];
    expect(reconcileRecent([], recent).length).toBe(2);
    expect(reconcileRecent([customEntry("a")], recent).length).toBe(1);
    expect(reconcileRecent([customEntry("a"), customEntry("b")], recent).length).toBe(0);
    // 补尾的是未命中的后一条（出现序对账）
    const oneLeft = reconcileRecent([customEntry("a")], recent);
    expect(oneLeft).toEqual([recent[1]]);
  });

  it("hits timestamped messages by role:timestamp(+toolCallId)", () => {
    const tail = loadFixture()
      .map(projectSessionEntry)
      .filter((e): e is WireEntry => e !== undefined);
    const userRecent = { seq: 1, message: { role: "user", content: "…", timestamp: 1790342521100 } as WireMessage };
    const toolRecent = {
      seq: 2,
      message: { role: "toolResult", timestamp: 1790342523900, toolCallId: "call_1" } as WireMessage,
    };
    const missRecent = { seq: 3, message: { role: "assistant", timestamp: 999 } as WireMessage };
    const out = reconcileRecent(tail, [userRecent, toolRecent, missRecent]);
    expect(out).toEqual([missRecent]);
  });

  it("never appends when the event stream is blind (idle custom only in tail)", () => {
    const tail = [customEntry("a")];
    expect(reconcileRecent(tail, [])).toEqual([]);
  });
});

describe("diffAppended", () => {
  const idleCustom = (id: string): WireEntry =>
    projectSessionEntry({
      type: "custom_message",
      customType: "subagent:todo",
      content: "wrote one line",
      id,
      parentId: null,
      timestamp: "2026-09-25T13:30:00.000Z",
    })!;

  it("returns exactly the one blind idle custom (event-blind spot, spike K7④)", () => {
    const tail = [idleCustom("t1")];
    const delivered = [`user:1790342521100`];
    expect(diffAppended(delivered, tail)).toEqual([tail[0]]);
  });

  it("returns both consecutive identical idle customs (multiset, not set)", () => {
    const a = idleCustom("t1");
    const b = idleCustom("t2");
    const out = diffAppended([], [a, b]);
    expect(out).toEqual([a, b]);
    expect(out.length).toBe(2);
  });

  it("subtracts delivered counts (delivered once, tail twice → append once)", () => {
    const a = idleCustom("t1");
    const b = idleCustom("t2");
    const key = entryKey(a)!;
    expect(diffAppended([key], [a, b])).toEqual([b]);
    expect(diffAppended([key, key], [a, b])).toEqual([]);
  });

  it("skips non-keyable entries (compaction etc.)", () => {
    const compaction = projectSessionEntry({
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: "t",
      summary: "s",
      firstKeptEntryId: "c1",
    })!;
    expect(entryKey(compaction)).toBeUndefined();
    expect(diffAppended([], [compaction])).toEqual([]);
  });
});

describe("truncateText", () => {
  it("passes short strings untouched", () => {
    expect(truncateText("hello", 100)).toEqual({ text: "hello", truncated: false });
    expect(truncateText("", 100)).toEqual({ text: "", truncated: false });
  });

  it("truncates by bytes without splitting a code point", () => {
    expect(truncateText("你好", 6)).toEqual({ text: "你好", truncated: false });
    expect(truncateText("你好", 5)).toEqual({ text: "你", truncated: true });
    expect(truncateText("你好", 3)).toEqual({ text: "你", truncated: true });
    expect(truncateText("你好", 2)).toEqual({ text: "", truncated: true });
    expect(truncateText("aé", 2)).toEqual({ text: "a", truncated: true });
    expect(truncateText("aé", 3)).toEqual({ text: "aé", truncated: false });
  });

  it("handles maxBytes 0", () => {
    expect(truncateText("x", 0)).toEqual({ text: "", truncated: true });
    expect(truncateText("", 0)).toEqual({ text: "", truncated: false });
  });
});
