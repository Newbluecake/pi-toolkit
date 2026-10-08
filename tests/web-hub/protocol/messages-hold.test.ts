/**
 * web-hub-steer-recall plan §4.1 (P-protocol): the frozen S2/S2' wire surface — the `recall` cmd
 * op, the held-row status fields, the new ctl states/reasons, and the `RecallResultDataSchema`
 * typed boundary. Everything here is decode-level: strict schemas (additionalProperties:false on
 * the nested/new parts) and byte-identity of pre-feature frames (the coexistence invariant — a
 * frame without the new fields must decode exactly as it did before the feature existed).
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { decodeAgentFrame, decodeHubFrame, RecallResultDataSchema } from "../../../src/web-hub/protocol/messages.js";
import { HELD_CLIP_CHARS, HELD_WIRE_MAX_ITEMS, RECALL_TEXT_MAX_BYTES } from "../../../src/web-hub/protocol/messages.js";

const origin = { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" } as const;
const TARGET = "t".repeat(16);

function recallCmd(cmd: Record<string, unknown>): unknown {
  return { t: "cmd", rid: "r1", id: "a".repeat(16), deadlineMs: 5_000, origin, cmd };
}

describe("steer-recall §2.3 S2': recall joins the CLOSED CmdSchema union", () => {
  it("decodeHubFrame accepts a well-formed recall cmd", () => {
    const raw = recallCmd({ op: "recall", target: TARGET });
    expect(decodeHubFrame(raw)).toEqual(raw);
  });

  it("rejects an expect field on the recall op (identify by target only)", () => {
    expect(decodeHubFrame(recallCmd({ op: "recall", target: TARGET, expect: { sessionId: "s1" } }))).toBeUndefined();
  });

  it("rejects unknown extra keys on the recall op", () => {
    expect(decodeHubFrame(recallCmd({ op: "recall", target: TARGET, text: "hi" }))).toBeUndefined();
    expect(decodeHubFrame(recallCmd({ op: "recall", target: TARGET, junk: 1 }))).toBeUndefined();
  });

  it("rejects an invalid target (short / bad charset / non-string)", () => {
    expect(decodeHubFrame(recallCmd({ op: "recall", target: "short" }))).toBeUndefined();
    expect(decodeHubFrame(recallCmd({ op: "recall", target: "bad target chars!!" }))).toBeUndefined();
    expect(decodeHubFrame(recallCmd({ op: "recall", target: 42 }))).toBeUndefined();
    expect(decodeHubFrame(recallCmd({ op: "recall" }))).toBeUndefined();
  });
});

describe("steer-recall §2.3 S2': ctl item schema — new op/state/reason literals", () => {
  function ctl(item: Record<string, unknown>): unknown {
    return { t: "ctl", epoch: "e1", sessionId: "s1", items: [{ cmdId: "c".repeat(16), at: 1, updatedAt: 2, ...item }] };
  }

  it("accepts each new state literal (held / recalled / returned)", () => {
    for (const state of ["held", "recalled", "returned"] as const) {
      const raw = ctl({ op: "prompt", state });
      expect(decodeAgentFrame(raw), state).toEqual(raw);
    }
  });

  it("accepts each new reason literal (aborted / reload / stale — session already existed)", () => {
    for (const reason of ["aborted", "session", "reload", "stale"] as const) {
      const raw = ctl({ op: "prompt", state: "returned", reason });
      expect(decodeAgentFrame(raw), reason).toEqual(raw);
    }
  });

  it("accepts a recall-op ctl item; unknown literals still reject", () => {
    const ok = ctl({ op: "recall", state: "recalled" });
    expect(decodeAgentFrame(ok)).toEqual(ok);
    expect(decodeAgentFrame(ctl({ op: "recall", state: "held", reason: "bogus" }))).toBeUndefined();
    expect(decodeAgentFrame(ctl({ op: "prompt", state: "held", behavior: "wrong" }))).toBeUndefined();
  });
});

describe("steer-recall §2.3 S2': status held rows", () => {
  const status = { leafId: null, busy: true, pending: false } as const;

  function heldItem(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      cmdId: "h".repeat(16),
      text: "x".repeat(HELD_CLIP_CHARS),
      deliver: "steer",
      state: "held",
      sessionId: "sess-1",
      at: 1790000000000,
      ...over,
    };
  }

  it("accepts a well-formed held snapshot with heldRev/heldEpoch (held + returned rows)", () => {
    const raw = {
      t: "status",
      ...status,
      held: [heldItem(), heldItem({ state: "returned", reason: "aborted", text: "r", deliver: "followUp" })],
      heldRev: 7,
      heldEpoch: "epoch-2",
    };
    const decoded = decodeAgentFrame(raw);
    expect(decoded).toEqual(raw);
  });

  it("rejects over-cap arrays, over-long text and non-strict row keys", () => {
    expect(
      decodeAgentFrame({ t: "status", ...status, held: new Array(HELD_WIRE_MAX_ITEMS + 1).fill(heldItem()) }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "status", ...status, held: [heldItem({ text: "x".repeat(HELD_CLIP_CHARS + 1) })] }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, held: [heldItem({ extra: 1 })] })).toBeUndefined();
    // (the reason⇔returned tie is a producer contract (P-agent's projection), deliberately NOT
    // encoded in the frozen schema — a held row carrying a reason still decodes)
    expect(decodeAgentFrame({ t: "status", ...status, held: [heldItem({ reason: "aborted" })] })).toBeDefined();
    expect(decodeAgentFrame({ t: "status", ...status, held: [heldItem({ cmdId: "short" })] })).toBeUndefined();
  });

  it("rejects malformed heldRev / heldEpoch companions", () => {
    expect(decodeAgentFrame({ t: "status", ...status, heldRev: -1 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, heldRev: 1.5 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, heldEpoch: "" })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, heldEpoch: "e".repeat(129) })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, heldRev: 3 })).toBeDefined(); // bare companions pass (open top level)
  });
});

describe("steer-recall §2.3 S2': RecallResultDataSchema (hub-side typed boundary)", () => {
  it("accepts both branches", () => {
    expect(
      Value.Check(RecallResultDataSchema, {
        op: "recall",
        outcome: "recalled",
        from: "held",
        deliver: "steer",
        text: "full body",
      }),
    ).toBe(true);
    expect(
      Value.Check(RecallResultDataSchema, {
        op: "recall",
        outcome: "recalled",
        from: "returned",
        deliver: "followUp",
        text: "x".repeat(RECALL_TEXT_MAX_BYTES),
      }),
    ).toBe(true); // 48 KiB exactly is IN bounds (the hub rejects only >)
    expect(Value.Check(RecallResultDataSchema, { op: "recall", outcome: "too_late" })).toBe(true);
  });

  it("rejects extra keys, empty text, wrong literals", () => {
    expect(
      Value.Check(RecallResultDataSchema, {
        op: "recall",
        outcome: "recalled",
        from: "held",
        deliver: "steer",
        text: "ok",
        extra: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(RecallResultDataSchema, {
        op: "recall",
        outcome: "recalled",
        from: "held",
        deliver: "steer",
        text: "",
      }),
    ).toBe(false);
    expect(Value.Check(RecallResultDataSchema, { op: "recall", outcome: "recalled" })).toBe(false); // missing fields
    expect(Value.Check(RecallResultDataSchema, { op: "recall", outcome: "too_late", text: "why" })).toBe(false);
    expect(Value.Check(RecallResultDataSchema, { op: "prompt", delivery: "held" })).toBe(false); // not a recall result
  });
});

describe("steer-recall coexistence: pre-feature frames decode byte-identically", () => {
  it("a status frame without the new fields round-trips through the exact pre-feature fixture bytes", () => {
    const fixture =
      '{"t":"status","leafId":null,"busy":true,"pending":false,"costUsd":0.12,"queue":[{"id":"q1","text":"hi","deliver":"steer","source":"web","cmdId":"c1","at":1}]}';
    const decoded = decodeAgentFrame(JSON.parse(fixture));
    expect(decoded).toBeDefined();
    expect(JSON.stringify(decoded)).toBe(fixture);
    expect((decoded as { held?: unknown }).held).toBeUndefined();
  });

  it("a ctl frame without the new literals round-trips through the exact pre-feature fixture bytes", () => {
    const fixture =
      '{"t":"ctl","epoch":"e1","sessionId":"s1","items":[{"cmdId":"c1","op":"prompt","state":"consumed","behavior":"steer","at":1,"updatedAt":2}]}';
    const decoded = decodeAgentFrame(JSON.parse(fixture));
    expect(decoded).toBeDefined();
    expect(JSON.stringify(decoded)).toBe(fixture);
  });

  it("a pre-feature cmd frame (no recall) is untouched by the union extension", () => {
    const fixture = `{"t":"cmd","rid":"r9","id":"${"a".repeat(16)}","deadlineMs":1000,"origin":{"listener":"loopback","ip":"127.0.0.1","reqId":"0123456789abcdef"},"cmd":{"op":"prompt","text":"hi","deliver":"steer"}}`;
    const decoded = decodeHubFrame(JSON.parse(fixture));
    expect(JSON.stringify(decoded)).toBe(fixture);
  });
});
