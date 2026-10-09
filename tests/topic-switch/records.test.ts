import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ENTRY_TYPE,
  PAYLOAD_IMAGE_BYTES_CAP,
  TRANSFER_RELOAD_WINDOW_MS,
  digestOfPayload,
  makePayload,
  parseRecord,
  planRecovery,
  userMessageDigest,
} from "../../src/topic-switch/records.js";
import type { EntryLike, HeldPayload, ImageLike, TransferLike } from "../../src/topic-switch/types.js";

const IMG: ImageLike = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const IMG2: ImageLike = { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" };

function custom(data: unknown): EntryLike {
  return { type: "custom", customType: ENTRY_TYPE, data };
}

function userEntry(content: unknown): EntryLike {
  return { type: "message", message: { role: "user", content } };
}

describe("makePayload / digest", () => {
  it("digest = sha256(text ‖ 每图 mimeType+data) — stable and order-sensitive", () => {
    const a = makePayload("写一首诗", [IMG, IMG2]);
    const b = makePayload("写一首诗", [IMG, IMG2]);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(
      createHash("sha256")
        .update("写一首诗")
        .update("image/png")
        .update("aGVsbG8=")
        .update("image/jpeg")
        .update("d29ybGQ=")
        .digest("hex"),
    );
    expect(a.digest).not.toBe(makePayload("写一首诗", [IMG2, IMG]).digest);
    expect(a.digest).not.toBe(makePayload("写另一首诗", [IMG, IMG2]).digest);
    expect(makePayload("纯文本", undefined).digest).toBe(createHash("sha256").update("纯文本").digest("hex"));
  });

  it("empty image list is omitted; undefined and [] both yield text-only payloads", () => {
    expect(makePayload("x", undefined).images).toBeUndefined();
    expect(makePayload("x", []).images).toBeUndefined();
    expect(makePayload("x", []).imagesOmitted).toBeUndefined();
  });

  it("images over the byte cap are omitted and counted; digest still covers them (delivery parity)", () => {
    const big: ImageLike = { type: "image", data: "z".repeat(PAYLOAD_IMAGE_BYTES_CAP + 1), mimeType: "image/png" };
    const payload = makePayload("看图", [IMG, big]);
    expect(payload.images).toEqual([IMG]);
    expect(payload.imagesOmitted).toBe(1);
    expect(payload.digest).toBe(digestOfPayload("看图", [IMG, big]));
    // 恰好在 cap 上 ⇒ 保留（> cap 才省略）
    const atCap: ImageLike = { type: "image", data: "z".repeat(PAYLOAD_IMAGE_BYTES_CAP), mimeType: "image/png" };
    expect(makePayload("看图", [atCap]).images).toEqual([atCap]);
    expect(makePayload("看图", [atCap]).imagesOmitted).toBeUndefined();
  });

  it("payload images are defensive copies", () => {
    const source: ImageLike[] = [IMG];
    const payload = makePayload("x", source);
    source.push(IMG2);
    expect(payload.images).toEqual([IMG]);
  });
});

describe("parseRecord · strictness", () => {
  it("round-trips every valid kind", () => {
    const samples: unknown[] = [
      { v: 1, kind: "cooldown", at: 123, tokens: 456 },
      { v: 1, kind: "outcome", at: 123, holdId: "h1", outcome: "switched", estUsd: 0.82, prefixK: 200 },
      {
        v: 1,
        kind: "outcome",
        at: 123,
        holdId: "h1",
        outcome: "related",
        estUsd: 0.82,
        prefixK: 200,
        judgeMs: 9,
        confidence: 0.9,
      },
      { v: 1, kind: "pending", at: 123, holdId: "h1", payload: makePayload("text", [IMG]) },
      { v: 1, kind: "pending", at: 123, holdId: "h1", payload: makePayload("text"), reason: "reload" },
      { v: 1, kind: "handoff", at: 123, holdId: "h1", payload: makePayload("text") },
      { v: 1, kind: "delivering", at: 123, holdId: "h1" },
      { v: 1, kind: "resolved", at: 123, holdId: "h1", how: "observed" },
      { v: 1, kind: "resolved", at: 123, holdId: "h1", how: "noticed" },
      { v: 1, kind: "resolved", at: 123, holdId: "h1", how: "manual" },
    ];
    for (const sample of samples) {
      expect(parseRecord(sample)).toEqual(sample);
    }
  });

  it("unknown v / kind ⇒ undefined", () => {
    expect(parseRecord({ v: 2, kind: "cooldown", at: 1, tokens: 1 })).toBeUndefined();
    expect(parseRecord({ v: 1, kind: "mystery", at: 1 })).toBeUndefined();
    expect(parseRecord(null)).toBeUndefined();
    expect(parseRecord("x")).toBeUndefined();
    expect(parseRecord(undefined)).toBeUndefined();
  });

  it("bad fields ⇒ undefined (never partially accepted)", () => {
    expect(parseRecord({ v: 1, kind: "cooldown", at: "x", tokens: 1 })).toBeUndefined();
    expect(parseRecord({ v: 1, kind: "cooldown", at: 1, tokens: Number.NaN })).toBeUndefined();
    expect(
      parseRecord({ v: 1, kind: "outcome", at: 1, holdId: "", outcome: "switched", estUsd: 1, prefixK: 1 }),
    ).toBeUndefined();
    expect(
      parseRecord({ v: 1, kind: "outcome", at: 1, holdId: "h", outcome: "nope", estUsd: 1, prefixK: 1 }),
    ).toBeUndefined();
    expect(
      parseRecord({
        v: 1,
        kind: "outcome",
        at: 1,
        holdId: "h",
        outcome: "switched",
        estUsd: 1,
        prefixK: 1,
        judgeMs: "x",
      }),
    ).toBeUndefined();
    expect(parseRecord({ v: 1, kind: "resolved", at: 1, holdId: "h", how: "other" })).toBeUndefined();
    expect(
      parseRecord({ v: 1, kind: "pending", at: 1, holdId: "h", payload: { text: "x", digest: "zz" } }),
    ).toBeUndefined();
    expect(
      parseRecord({ v: 1, kind: "pending", at: 1, holdId: "h", payload: makePayload("x"), reason: "later" }),
    ).toBeUndefined();
  });

  it("payload validation: images array entries must be well-formed images", () => {
    expect(
      parseRecord({
        v: 1,
        kind: "pending",
        at: 1,
        holdId: "h",
        payload: { text: "x", digest: "a".repeat(64), images: [{ type: "text", text: "y" }] },
      }),
    ).toBeUndefined();
    expect(
      parseRecord({
        v: 1,
        kind: "pending",
        at: 1,
        holdId: "h",
        payload: { text: "x", digest: "a".repeat(64), imagesOmitted: -1 },
      }),
    ).toBeUndefined();
  });
});

describe("userMessageDigest", () => {
  it("string content, array content with text+image blocks, both match makePayload digests", () => {
    expect(userMessageDigest(userEntry("写一首诗"))).toBe(makePayload("写一首诗").digest);
    expect(userMessageDigest(userEntry([{ type: "text", text: "看" }, { type: "text", text: "图" }, { ...IMG }]))).toBe(
      makePayload("看图", [IMG]).digest,
    );
  });
  it("non-user roles / non-message types / malformed message ⇒ undefined", () => {
    expect(userMessageDigest({ type: "message", message: { role: "assistant", content: "x" } })).toBeUndefined();
    expect(userMessageDigest({ type: "compaction" })).toBeUndefined();
    expect(userMessageDigest({ type: "message" })).toBeUndefined();
    expect(userMessageDigest({ type: "message", message: null })).toBeUndefined();
  });
});

describe("planRecovery", () => {
  const PAYLOAD = makePayload("上次截留的请求", [IMG]);
  const SESSION = "s-1";

  function transfer(overrides: Partial<TransferLike> = {}): TransferLike {
    return {
      holdId: "h1",
      payload: PAYLOAD,
      fromSessionId: SESSION,
      reason: "switch",
      state: "pending",
      at: 1_000,
      ...overrides,
    };
  }

  it("rule 1: reload + same session + within 60s ⇒ deliver", () => {
    expect(
      planRecovery({
        branch: [],
        transfer: transfer(),
        sessionId: SESSION,
        reason: "reload",
        now: 1_000 + TRANSFER_RELOAD_WINDOW_MS,
      }),
    ).toEqual([{ a: "deliver", holdId: "h1", payload: PAYLOAD }]);
  });

  it("rule 1 boundaries: other session / past the window / non-pending transfer / startup ⇒ nothing from transfer", () => {
    expect(
      planRecovery({
        branch: [],
        transfer: transfer({ fromSessionId: "s-2" }),
        sessionId: SESSION,
        reason: "reload",
        now: 1_060_000,
      }),
    ).toEqual([]);
    expect(
      planRecovery({
        branch: [],
        transfer: transfer(),
        sessionId: SESSION,
        reason: "reload",
        now: 1_000 + TRANSFER_RELOAD_WINDOW_MS + 1,
      }),
    ).toEqual([]);
    expect(
      planRecovery({
        branch: [],
        transfer: transfer({ state: "delivering" }),
        sessionId: SESSION,
        reason: "reload",
        now: 1_060_000,
      }),
    ).toEqual([]);
    expect(
      planRecovery({
        branch: [],
        transfer: transfer({ state: "manual" }),
        sessionId: SESSION,
        reason: "reload",
        now: 1_060_000,
      }),
    ).toEqual([]);
    expect(
      planRecovery({ branch: [], transfer: transfer(), sessionId: SESSION, reason: "startup", now: 1_060_000 }),
    ).toEqual([]);
  });

  it("rule 2: new/resume/fork ⇒ editor with text only (images recoverable via /topic-switch last --send)", () => {
    for (const reason of ["new", "resume", "fork"] as const) {
      expect(planRecovery({ branch: [], transfer: transfer(), sessionId: "s-2", reason, now: 9_999_999 })).toEqual([
        { a: "editor", holdId: "h1", text: PAYLOAD.text },
      ]);
    }
  });

  it("rule 3: delivering observed — first user message after it has the matching digest ⇒ resolve", () => {
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD, reason: "reload" }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
      userEntry([{ type: "text", text: "上次截留的请求" }, { ...IMG }]),
    ];
    expect(planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "startup", now: 5 })).toEqual([
      { a: "resolve", holdId: "h1" },
    ]);
  });

  it("rule 3: digest mismatch or no user message ⇒ notice (never re-deliver, never editor)", () => {
    const mismatch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
      userEntry("用户后来发的别的消息"),
    ];
    expect(
      planRecovery({ branch: mismatch, transfer: undefined, sessionId: SESSION, reason: "startup", now: 5 }),
    ).toEqual([{ a: "notice", holdId: "h1", preview: PAYLOAD.text.slice(0, 120) }]);
    const noMessage: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
    ];
    expect(
      planRecovery({ branch: noMessage, transfer: undefined, sessionId: SESSION, reason: "reload", now: 5 }),
    ).toEqual([{ a: "notice", holdId: "h1", preview: PAYLOAD.text }]);
  });

  it("rule 3: a user message BEFORE the delivering record does not count", () => {
    const branch: EntryLike[] = [
      userEntry("上次截留的请求"),
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
    ];
    expect(planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "startup", now: 5 })).toEqual([
      { a: "notice", holdId: "h1", preview: PAYLOAD.text },
    ]);
  });

  it("rule 3: already-resolved delivering produces no action", () => {
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
      userEntry([{ type: "text", text: "上次截留的请求" }]),
      custom({ v: 1, kind: "resolved", at: 3, holdId: "h1", how: "observed" }),
    ];
    expect(planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "reload", now: 5 })).toEqual([]);
  });

  it("rule 4: unresolved pending without delivering (crash) ⇒ notice; with delivering elsewhere in branch ⇒ covered by rule 3", () => {
    const crash: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h9", payload: PAYLOAD, reason: "quit" }),
    ];
    expect(
      planRecovery({ branch: crash, transfer: undefined, sessionId: SESSION, reason: "resume", now: 9_999_999 }),
    ).toEqual([{ a: "notice", holdId: "h9", preview: PAYLOAD.text }]);
    // pending + delivering（跨 reload 视角：delivering 已写、观测未定）⇒ 只有 rule 3 的一条动作
    const withDelivering: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h9", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h9" }),
    ];
    const actions = planRecovery({
      branch: withDelivering,
      transfer: undefined,
      sessionId: SESSION,
      reason: "reload",
      now: 5,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.a).toBe("notice");
  });

  it("rule 5: handoff records never trigger any action", () => {
    const branch: EntryLike[] = [custom({ v: 1, kind: "handoff", at: 1, holdId: "h7", payload: PAYLOAD })];
    expect(planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "resume", now: 9_999_999 })).toEqual(
      [],
    );
  });

  it("combined: transfer deliver + branch notice coexist in order", () => {
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h2", payload: makePayload("旧的一条") }),
    ];
    expect(
      planRecovery({
        branch,
        transfer: transfer({ holdId: "h1", at: 500 }),
        sessionId: SESSION,
        reason: "reload",
        now: 530,
      }),
    ).toEqual([
      { a: "deliver", holdId: "h1", payload: PAYLOAD },
      { a: "notice", holdId: "h2", preview: "旧的一条" },
    ]);
  });

  it("preview clips to 120 code points; missing payload lookup yields empty preview", () => {
    const long = "字".repeat(300);
    const payload: HeldPayload = makePayload(long);
    const branch: EntryLike[] = [custom({ v: 1, kind: "delivering", at: 1, holdId: "h1" })]; // 无 pending ⇒ 无 payload
    expect(planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "reload", now: 5 })).toEqual([
      { a: "notice", holdId: "h1", preview: "" },
    ]);
    const branch2: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
    ];
    const actions = planRecovery({
      branch: branch2,
      transfer: undefined,
      sessionId: SESSION,
      reason: "reload",
      now: 5,
    });
    expect((actions[0] as { preview: string }).preview.length).toBe(120);
  });

  it("each holdId yields at most one action (dedupe across rules 3/4)", () => {
    const branch: EntryLike[] = [
      custom({ v: 1, kind: "pending", at: 1, holdId: "h1", payload: PAYLOAD }),
      custom({ v: 1, kind: "delivering", at: 2, holdId: "h1" }),
      custom({ v: 1, kind: "pending", at: 3, holdId: "h2", payload: PAYLOAD }),
    ];
    const actions = planRecovery({ branch, transfer: undefined, sessionId: SESSION, reason: "startup", now: 5 });
    expect(actions).toHaveLength(2);
    expect(actions.map((x) => x.holdId)).toEqual(["h1", "h2"]);
  });
});
