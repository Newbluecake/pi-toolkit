import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ASK_USER_MARKER } from "../../../src/ask-user/channel-handler.js";
import { createDialogBridge } from "../../../src/web-hub/agent/dialogs.js";
import type { DialogClosedWire, DialogsFrame } from "../../../src/web-hub/protocol/messages.js";

const question = { question: "Q", header: "Q", options: [{ label: "A" }, { label: "B" }], allowOther: true };

function make(over: { hubCaps?: () => readonly string[] } = {}) {
  const slots: unknown[] = [];
  let now = 1_000;
  const bridge = createDialogBridge({
    enabled: true,
    epoch: "epoch-1",
    isAttached: () => true,
    now: () => now,
    setSlot: (_kind, frame) => slots.push(frame),
    ...(over.hubCaps === undefined ? {} : { hubCaps: over.hubCaps }),
  });
  return {
    bridge,
    slots,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The `DialogClosedSchema.by` union as every hub built BEFORE ask-user-async P3 validates it —
 *  the compat matrix's "old hub" side. A degraded `by:"abort"` frame must pass THIS schema,
 *  because an old hub drops the whole dialogs frame on any unknown `by` value. */
const OLD_HUB_DIALOG_CLOSED_BY = Type.Union([
  Type.Literal("tui"),
  Type.Literal("web"),
  Type.Literal("abort"),
  Type.Literal("session"),
  Type.Literal("error"),
]);

describe("dialog bridge", () => {
  it("keeps an open slot and closes it with the winning web cmd id", () => {
    const { bridge, slots } = make();
    const session = bridge.open({ toolCallId: "tool-1", questions: [question], allowCancel: true })!;
    let outcome: unknown;
    session.setOnRemote((value) => {
      outcome = value;
      return true;
    });
    const result = bridge.answer(
      "ask:tool-1",
      [{ selected: ["A"], other: null }],
      "alice@10.0.0.1",
      "cmd-1",
      "epoch-1",
    );
    expect(result).toEqual({ ok: true, data: { op: "dialog_answer" } });
    expect(outcome).toEqual({ kind: "answer", answers: { Q: "A" }, origin: "alice@10.0.0.1" });
    expect(bridge.frame()).toMatchObject({ epoch: "epoch-1", open: [], closed: [{ by: "web", cmdId: "cmd-1" }] });
    expect(slots.length).toBeGreaterThan(0);
  });

  it("does not claim on bad answers or stale epochs", () => {
    const { bridge } = make();
    const session = bridge.open({ toolCallId: "tool-1", questions: [question], allowCancel: true })!;
    let calls = 0;
    session.setOnRemote(() => {
      calls += 1;
      return true;
    });
    expect(bridge.answer("ask:tool-1", [{ selected: ["missing"], other: null }], "web", "a", "epoch-1")).toMatchObject({
      ok: false,
      code: "E_BAD_ANSWER",
    });
    expect(bridge.answer("ask:tool-1", [{ selected: ["A"], other: null }], "web", "b", "old")).toMatchObject({
      ok: false,
      code: "E_DIALOG_CLOSED",
    });
    expect(calls).toBe(0);
    expect(bridge.frame().open).toHaveLength(1);
  });

  it("rejects the loser and supports cancellation and detach", () => {
    const { bridge } = make();
    const first = bridge.open({ toolCallId: "one", questions: [question], allowCancel: true })!;
    first.setOnRemote(() => true);
    expect(bridge.cancel("ask:one", "web", "cancel-1", "epoch-1")).toMatchObject({ ok: true });
    expect(bridge.cancel("ask:one", "web", "cancel-2", "epoch-1")).toMatchObject({
      ok: false,
      code: "E_DIALOG_CLOSED",
    });
    bridge.open({ toolCallId: "two", questions: [question], allowCancel: true });
    bridge.detachAll();
    expect(bridge.frame().open).toHaveLength(0);
    expect(bridge.frame().closed.at(-1)).toMatchObject({ by: "session", outcome: "aborted" });
  });

  it("attributes custom and RPC marker prompts once and sanitizes the marker", () => {
    const { bridge } = make();
    bridge.open({ toolCallId: "tool-1", questions: [question], allowCancel: true });
    const custom = bridge.attributePrompt({ type: "ui_prompt_start", kind: "custom" });
    expect(custom).toMatchObject({ dialogId: "ask:tool-1", kind: "custom" });
    const staleMarker = bridge.attributePrompt({ type: "ui_prompt_start", kind: "select", title: ASK_USER_MARKER });
    expect(staleMarker.title).toBe("ask_user");
  });
});

describe("dialog bridge — background close passthrough / old-hub downgrade (ask-user-async §7.2, P3)", () => {
  it('hub with dialog.bg.v1: close("background","aborted") is passed through on the wire (frame + published slot)', () => {
    const { bridge, slots } = make({ hubCaps: () => ["dialog.v1", "dialog.bg.v1"] });
    const session = bridge.open({ toolCallId: "bg-1", questions: [question], allowCancel: true })!;
    session.close("background", "aborted");
    expect(bridge.frame().closed).toEqual([{ dialogId: "ask:bg-1", by: "background", outcome: "aborted", at: 1_000 }]);
    const published = slots.at(-1) as DialogsFrame;
    expect(published.closed[0]).toMatchObject({ by: "background", outcome: "aborted" });
  });

  it('hub WITHOUT dialog.bg.v1 (old hub): the wire record degrades to by:"abort" and passes the old hub schema', () => {
    const { bridge } = make({ hubCaps: () => ["dialog.v1"] });
    const session = bridge.open({ toolCallId: "bg-2", questions: [question], allowCancel: true })!;
    session.close("background", "aborted");
    const entry = bridge.frame().closed[0] as DialogClosedWire;
    expect(entry.by).toBe("abort");
    expect(entry.outcome).toBe("aborted");
    // The exact compat invariant: an old hub's 5-literal runtime schema must accept the frame —
    // an unknown `by` there drops the WHOLE dialogs frame and freezes the web dialog list.
    expect(Value.Check(OLD_HUB_DIALOG_CLOSED_BY, entry.by)).toBe(true);
    expect(Value.Check(OLD_HUB_DIALOG_CLOSED_BY, "background")).toBe(false);
  });

  it("absent hubCaps option degrades too (fail-safe default keeps dialogs frames flowing)", () => {
    const { bridge } = make();
    const session = bridge.open({ toolCallId: "bg-3", questions: [question], allowCancel: true })!;
    session.close("background", "aborted");
    expect((bridge.frame().closed[0] as DialogClosedWire).by).toBe("abort");
  });

  it('hub upgrade mid-record: the internal record keeps "background" and re-emits it once the cap appears', () => {
    let caps: readonly string[] = ["dialog.v1"];
    const { bridge } = make({ hubCaps: () => caps });
    const session = bridge.open({ toolCallId: "bg-4", questions: [question], allowCancel: true })!;
    session.close("background", "aborted");
    expect((bridge.frame().closed[0] as DialogClosedWire).by).toBe("abort");
    caps = ["dialog.v1", "dialog.bg.v1"]; // hub upgraded + reconnected with the cap advertised
    expect((bridge.frame().closed[0] as DialogClosedWire).by).toBe("background");
  });

  it("web answer and background close in the same tick: first finisher wins, the loser is inert", () => {
    const { bridge } = make({ hubCaps: () => ["dialog.v1", "dialog.bg.v1"] });
    const won = bridge.open({ toolCallId: "race-win", questions: [question], allowCancel: true })!;
    won.setOnRemote(() => true);
    expect(bridge.answer("ask:race-win", [{ selected: ["A"], other: null }], "web", "cmd-1", "epoch-1")).toMatchObject({
      ok: true,
    });
    won.close("background", "aborted"); // same tick, after the web finish — must not overwrite
    expect(bridge.frame().closed[0]).toMatchObject({ by: "web", outcome: "answered", cmdId: "cmd-1" });

    const lost = bridge.open({ toolCallId: "race-lose", questions: [question], allowCancel: true })!;
    lost.close("background", "aborted"); // background interrupted first
    expect(bridge.answer("ask:race-lose", [{ selected: ["A"], other: null }], "web", "cmd-2", "epoch-1")).toMatchObject(
      {
        ok: false,
        code: "E_DIALOG_CLOSED",
      },
    );
    expect(bridge.frame().closed.at(-1)).toMatchObject({ by: "background", outcome: "aborted" });
  });
});
