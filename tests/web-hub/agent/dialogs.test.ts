import { describe, expect, it } from "vitest";
import { ASK_USER_MARKER } from "../../../src/ask-user/channel-handler.js";
import { createDialogBridge } from "../../../src/web-hub/agent/dialogs.js";

const question = { question: "Q", header: "Q", options: [{ label: "A" }, { label: "B" }], allowOther: true };

function make() {
  const slots: unknown[] = [];
  let now = 1_000;
  const bridge = createDialogBridge({
    enabled: true,
    epoch: "epoch-1",
    isAttached: () => true,
    now: () => now,
    setSlot: (_kind, frame) => slots.push(frame),
  });
  return {
    bridge,
    slots,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

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
