import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuDialogs, validateFeishuAnswers } from "../../../../src/web-hub/hub/feishu/dialogs.js";
import { cleanupF6, f6Rig, OWNER, normalizedMessage, NOW } from "../../../fixtures/feishu/f6.js";
import { eventually } from "../../../fixtures/feishu/f8.js";
import type { DialogWire } from "../../../../src/web-hub/protocol/messages.js";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import type { FeishuDialogsDeps } from "../../../../src/web-hub/hub/feishu/dialogs.js";
import { systemFeishuClock, type FeishuResult } from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuNonce } from "../../../../src/web-hub/hub/feishu/state.js";
afterEach(cleanupF6);
const dialog = (multi = false): DialogWire => ({
  dialogId: "dialog",
  source: "ask_user",
  toolCallId: "tool",
  questions: [
    { question: "Choose", options: [{ label: "A" }, { label: "B" }], multiSelect: multi },
    ...(multi ? [{ question: "Second", options: [{ label: "C" }] }] : []),
  ],
  allowCancel: true,
  openedAt: NOW,
});
async function rig(multi = false, start = true) {
  const r = await f6Rig(),
    patches: string[] = [];
  const patch = vi.fn(async (_messageId: string, card: string) => {
    patches.push(card);
  });
  const notice = vi.fn(async (_binding: unknown, _text: string) => {});
  const sendCard = vi.fn<FeishuDialogsDeps["sendCard"]>(async () => ({ messageId: "card", chatId: "chat" }));
  const deleteMessage = vi.fn(async (_messageId: string): Promise<FeishuResult<void>> => ({
    ok: true,
    data: undefined,
  }));
  const deps: FeishuDialogsDeps = {
    state: r.state,
    admission: r.admission,
    installation: r.install,
    clock: r.clock,
    session: () => "session-1",
    target: () => ({ scope: "p2p", via: "reply", messageId: "trigger" }),
    operator: () => OWNER,
    link: () => "http://localhost/#/session",
    sendCard,
    patch,
    deleteMessage,
    notice,
  };
  const dialogs = createFeishuDialogs(deps);
  const open = dialog(multi);
  if (start) await dialogs.reconcile("agent-1", "epoch", [open], []);
  const record = r.state.dialogCards.list()[0]!;
  function nonce(op: string): FeishuNonce {
    const n = [...patches.at(-1)!.matchAll(/"n":"([A-Za-z0-9_-]{22})"/g)]
      .map((m) => r.state.nonces.get(m[1]!))
      .find((n) => n && JSON.parse(n.target).op === op);
    if (!n) throw new Error(`missing ${op}`);
    return n;
  }
  return { ...r, dialogs, open, record, patch, patches, notice, sendCard, deleteMessage, nonce, deps };
}
describe("F8 ask_user bridge", () => {
  it("validates multi-select/Other/skip byte caps locally", () => {
    const d = dialog(true);
    expect(
      validateFeishuAnswers(d, [
        { selected: ["A", "B"], other: null },
        { selected: [], other: null, skipped: true },
      ]),
    ).toBe(true);
    expect(
      validateFeishuAnswers(d, [
        { selected: ["A", "A"], other: null },
        { selected: ["C"], other: null },
      ]),
    ).toBe(false);
    expect(
      validateFeishuAnswers(d, [
        { selected: ["invalid"], other: null },
        { selected: ["C"], other: null },
      ]),
    ).toBe(false);
    expect(
      validateFeishuAnswers(d, [
        { selected: [], other: "中".repeat(2_000) },
        { selected: ["C"], other: null },
      ]),
    ).toBe(false);
    expect(
      validateFeishuAnswers(d, [
        { selected: ["A"], other: null, skipped: true },
        { selected: ["C"], other: null },
      ]),
    ).toBe(false);
  });
  it("a dialog that cannot be answered from Feishu (> 8 questions) sends no card and no notice", async () => {
    const r = await rig();
    const sentBefore = r.sendCard.mock.calls.length;
    const nine: DialogWire = {
      ...dialog(),
      dialogId: "dialog-9",
      questions: Array.from({ length: 9 }, (_, i) => ({ question: `Q${i}`, options: [{ label: "A" }] })),
    };
    await r.dialogs.reconcile("agent-2", "epoch", [nine], []);
    expect(r.sendCard.mock.calls.length).toBe(sentBefore);
    expect(r.notice).not.toHaveBeenCalled();
    expect(r.state.dialogCards.list().some((c) => c.dialogId === "dialog-9")).toBe(false);
  });
  it("form submits valid multi-question answers through the existing dialog_answer command", async () => {
    const r = await rig(true);
    await r.dialogs.callback(r.nonce("submit"), r.identity, "cb1", { form_value: { q0: ["0", "1"], q1: "skip" } });
    expect(r.request.mock.calls[0]![0].cmd).toEqual({
      op: "dialog_answer",
      dialogId: "dialog",
      epoch: "epoch",
      answers: [
        { selected: ["A", "B"], other: null },
        { selected: [], other: null, skipped: true },
      ],
    });
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("answered");
    expect(r.patches.at(-1)).toContain("已通过飞书作答");
    expect(r.deleteMessage).not.toHaveBeenCalled();
    r.dialogs.dispose();
  });
  it("invalid form never dispatches, patches validation hint with fresh one-shot nonces", async () => {
    const r = await rig(true),
      original = r.nonce("submit").nonce;
    await r.dialogs.callback(r.nonce("submit"), r.identity, "bad", { form_value: { q0: "99", q1: "0" } });
    expect(r.request).not.toHaveBeenCalled();
    expect(r.patches.at(-1)).toContain("答案无效");
    expect(r.nonce("submit").nonce).not.toBe(original);
    r.dialogs.dispose();
  });
  it("cancel exists only with allowCancel and maps to dialog_cancel", async () => {
    const r = await rig();
    await r.dialogs.callback(r.nonce("cancel"), r.identity, "cancel", {});
    expect(r.request.mock.calls[0]![0].cmd).toEqual({ op: "dialog_cancel", dialogId: "dialog", epoch: "epoch" });
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("closed");
    r.dialogs.dispose();
  });
  it("single-question addressed text supports option indices; multi-question text never becomes a prompt", async () => {
    const r = await rig();
    const m = normalizedMessage("answer", `${r.record.shortCode} 2`);
    expect(await r.dialogs.text(m, r.identity)).toBe(true);
    expect(r.request.mock.calls[0]![0].cmd).toMatchObject({
      op: "dialog_answer",
      answers: [{ selected: ["B"], other: null }],
    });
    r.dialogs.dispose();
    const multi = await rig(true);
    expect(await multi.dialogs.text(normalizedMessage("answer", "1"), multi.identity)).toBe(true);
    expect(multi.request).not.toHaveBeenCalled();
    expect(multi.notice.mock.calls[0]![1]).toBe("请在卡片中作答");
    multi.dialogs.dispose();
  });
  it("a different allow-listed operator cannot answer another sender's text dialog", async () => {
    const r = await rig();
    r.state.allowList.add("ou_other");
    await r.dialogs.text(normalizedMessage("answer", "1"), { ...r.identity, senderOpenId: "ou_other" });
    expect(r.request).not.toHaveBeenCalled();
    r.dialogs.dispose();
  });
  it.each(["42", "0", "999999999999999999999999999999"])(
    "out-of-range numeric text %s is an Other answer when allowed",
    async (text) => {
      const r = await rig();
      await r.dialogs.text(normalizedMessage("numeric-other", `${r.record.shortCode} ${text}`), r.identity);
      expect(r.request).toHaveBeenCalledTimes(1);
      expect(r.request.mock.calls[0]![0].cmd).toMatchObject({
        op: "dialog_answer",
        answers: [{ selected: [], other: text }],
      });
      expect(r.state.dialogCards.get(r.record.id)?.status).toBe("answered");
      r.dialogs.dispose();
    },
  );
  it("out-of-range numeric Other is still refused when allowOther=false", async () => {
    const r = await rig();
    r.open.questions[0]!.allowOther = false;
    await r.dialogs.reconcile("agent-1", "epoch", [r.open], []);
    await r.dialogs.text(normalizedMessage("numeric-refused", "42"), r.identity);
    expect(r.request).not.toHaveBeenCalled();
    expect(r.patches.at(-1)).toContain("答案无效");
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("open");
    r.dialogs.dispose();
  });
  it.each(["missing-session", "unknown", "cancel-disallowed"] as const)(
    "local inference (%s) only patches, then authoritative closure can still recall",
    async (reason) => {
      const r = await rig();
      const nonce = r.nonce(reason === "cancel-disallowed" ? "cancel" : "option");
      if (reason === "missing-session")
        r.state.bindings.set(r.record.bindingKey, { chatId: "chat", chatType: "p2p", sessionId: null });
      else if (reason === "unknown") r.state.dialogCards.update(r.record.id, { status: "unknown" });
      else r.open.allowCancel = false;
      r.patch.mockClear();
      await r.dialogs.callback(nonce, r.identity, `local-${reason}`, {});
      expect(r.request).not.toHaveBeenCalled();
      expect(r.deleteMessage).not.toHaveBeenCalled();
      expect(r.patch).toHaveBeenCalledTimes(1);
      expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining("状态未知"));
      expect(r.state.dialogCards.get(r.record.id)).toMatchObject({ status: "unknown" });
      expect(r.state.dialogCards.get(r.record.id)).not.toHaveProperty("recall");
      await r.dialogs.reconcile(
        "agent-1",
        "epoch",
        [],
        [{ dialogId: "dialog", by: "web", outcome: "answered", at: NOW }],
      );
      expect(r.deleteMessage).toHaveBeenCalledTimes(1);
      expect(r.deleteMessage).toHaveBeenCalledWith("card");
      r.dialogs.dispose();
    },
  );
  it("a disconnected callback supplies no settlement evidence and never recalls", async () => {
    const r = await rig();
    const nonce = r.nonce("option");
    r.dialogs.disconnected("agent-1");
    await r.dialogs.callback(nonce, r.identity, "disconnected", {});
    expect(r.request).not.toHaveBeenCalled();
    expect(r.deleteMessage).not.toHaveBeenCalled();
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("open");
    r.dialogs.dispose();
  });
  it.each([false, true])("a retry preserves the first cmdId, including after restart=%s", async (restart) => {
    const r = await rig();
    r.request.mockImplementation(async (frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_DEADLINE",
      retryable: false,
      effect: "unknown",
    }));
    await r.dialogs.callback(r.nonce("option"), r.identity, "first-unconfirmed", {});
    expect(r.patches.at(-1)).toContain("提交未确认");
    await r.dialogs.callback(r.nonce("option"), r.identity, "retry-unconfirmed", {});
    expect(r.request).toHaveBeenCalledTimes(2);
    const firstId = r.request.mock.calls[0]![0].id;
    const secondId = r.request.mock.calls[1]![0].id;
    expect(firstId).not.toBe(secondId);
    expect(r.state.dialogCards.get(r.record.id)?.answerCmdIds).toEqual([firstId, secondId]);
    let state = r.state;
    let dialogs = r.dialogs;
    if (restart) {
      r.dialogs.dispose();
      state = createFeishuState({ dir: r.dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: r.clock.now } });
      await state.load();
      dialogs = createFeishuDialogs({ ...r.deps, state });
    }
    r.patch.mockClear();
    try {
      await dialogs.reconcile(
        "agent-1",
        "epoch",
        [],
        [{ dialogId: "dialog", by: "web", cmdId: firstId, outcome: "answered", at: NOW }],
      );
      expect(r.deleteMessage).not.toHaveBeenCalled();
      expect(r.patch).toHaveBeenCalledTimes(1);
      expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining("已通过飞书作答"));
      expect(state.dialogCards.get(r.record.id)?.status).toBe("answered");
    } finally {
      dialogs.dispose();
      if (restart) state.dispose();
    }
  });
  it("a legacy single cmdId is retained when a new retry is dispatched", async () => {
    const r = await rig();
    r.state.dialogCards.update(r.record.id, { answerCmdId: "legacy-first" });
    r.request.mockImplementationOnce(async (frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_DEADLINE",
      retryable: false,
      effect: "unknown",
    }));
    await r.dialogs.callback(r.nonce("option"), r.identity, "legacy-retry", {});
    expect(r.state.dialogCards.get(r.record.id)?.answerCmdIds).toEqual([
      "legacy-first",
      r.request.mock.calls[0]![0].id,
    ]);
    await r.dialogs.reconcile(
      "agent-1",
      "epoch",
      [],
      [{ dialogId: "dialog", by: "web", cmdId: "legacy-first", outcome: "answered", at: NOW }],
    );
    expect(r.deleteMessage).not.toHaveBeenCalled();
    expect(r.patches.at(-1)).toContain("已通过飞书作答");
    r.dialogs.dispose();
  });
  it("eight unconfirmed dispatches are retained; the ninth click never evicts old proof", async () => {
    const r = await rig();
    r.request.mockImplementation(async (frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_DEADLINE",
      retryable: false,
      effect: "unknown",
    }));
    for (let i = 0; i < 8; i++) await r.dialogs.callback(r.nonce("option"), r.identity, `retry-${i}`, {});
    const savedNonce = r.nonce("option");
    await r.dialogs.callback(savedNonce, r.identity, "retry-9", {});
    expect(r.request).toHaveBeenCalledTimes(8);
    expect(r.patches.at(-1)).toContain("提交次数已达上限");
    const ids = r.request.mock.calls.map(([frame]) => frame.id);
    expect(r.state.dialogCards.get(r.record.id)?.answerCmdIds).toEqual(ids);
    await r.dialogs.reconcile(
      "agent-1",
      "epoch",
      [],
      [{ dialogId: "dialog", by: "web", cmdId: ids[0]!, outcome: "answered", at: NOW }],
    );
    expect(r.deleteMessage).not.toHaveBeenCalled();
    expect(r.patches.at(-1)).toContain("已通过飞书作答");
    r.dialogs.dispose();
  });
  it("web/TUI race loss closes card, not a failed run or a retry", async () => {
    const r = await rig();
    r.request.mockImplementationOnce(async (f) => ({
      t: "cmd_result",
      rid: f.rid,
      id: f.id,
      ok: false,
      code: "E_DIALOG_CLOSED",
      message: "closed",
      retryable: false,
      effect: "none",
    }));
    await r.dialogs.callback(r.nonce("option"), r.identity, "race", {});
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("closed");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.deleteMessage).toHaveBeenCalledWith("card");
    r.dialogs.dispose();
  });
  it("reconnect waits for authoritative open list; after 30s unknown, never guessed answered/expired", async () => {
    const r = await rig();
    r.dialogs.disconnected("agent-1");
    r.clock.advance(29_999);
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("open");
    r.clock.advance(1);
    await eventually(() => expect(r.state.dialogCards.get(r.record.id)?.status).toBe("unknown"));
    expect(r.patches.every((p) => !p.includes("answered via"))).toBe(true);
    r.dialogs.dispose();
  });
  it("authoritative list cancels unknown timer and reconciles TUI closed semantics", async () => {
    const r = await rig();
    r.dialogs.disconnected("agent-1");
    await r.dialogs.reconcile("agent-1", "epoch", [r.open], []);
    r.clock.advance(30_000);
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("open");
    await r.dialogs.reconcile(
      "agent-1",
      "epoch",
      [],
      [{ dialogId: "dialog", by: "tui", outcome: "answered", at: NOW }],
    );
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("answered");
    expect(r.deleteMessage).toHaveBeenCalledWith("card");
    expect(r.patches.at(-1)).not.toContain("answered via tui");
    r.dialogs.dispose();
  });
  it("authoritative absent card and 24h expiry are recalled before state sweep deletes them", async () => {
    const r = await rig();
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("expired");
    r.dialogs.dispose();
    const expiry = await rig();
    expiry.clock.advance(24 * 3_600_000 - 30_000);
    await expiry.dialogs.sweep();
    expect(expiry.deleteMessage).toHaveBeenCalledWith("card");
    expiry.dialogs.dispose();
  });
  it.each(["web", "tui", "background", "abort", "session", "error"] as const)(
    "%s closure recalls without patching and repeated reconciliation never retries",
    async (by) => {
      const r = await rig();
      r.patch.mockClear();
      const closed = [{ dialogId: "dialog", by, outcome: "answered" as const, at: NOW }];
      await Promise.all([
        r.dialogs.reconcile("agent-1", "epoch", [], closed),
        r.dialogs.reconcile("agent-1", "epoch", [], closed),
      ]);
      await r.dialogs.reconcile("agent-1", "epoch", [], closed);
      expect(r.deleteMessage).toHaveBeenCalledTimes(1);
      expect(r.deleteMessage).toHaveBeenCalledWith("card");
      expect(r.patch).not.toHaveBeenCalled();
      expect(r.state.dialogCards.get(r.record.id)).toMatchObject({ status: "answered", recall: "attempted" });
      r.dialogs.dispose();
    },
  );
  it.each([
    ["answered", "已在其他端作答"],
    ["cancelled", "已取消"],
    ["aborted", "已取消"],
  ] as const)("failed recall after %s patches only neutral Chinese once", async (outcome, text) => {
    const r = await rig();
    r.patch.mockClear();
    r.deleteMessage.mockResolvedValue({
      ok: false,
      kind: "api",
      reason: "api-code-230099",
      retryable: false,
      effect: "none",
    });
    const closed = [{ dialogId: "dialog", by: "web" as const, outcome, at: NOW }];
    await r.dialogs.reconcile("agent-1", "epoch", [], closed);
    await r.dialogs.reconcile("agent-1", "epoch", [], closed);
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining(text));
    expect(r.patches.at(-1)).not.toMatch(/via|answered|aborted/);
    r.dialogs.dispose();
  });
  it("a never-settling delete hits the 8s deadline and falls back once", async () => {
    const r = await rig();
    r.deleteMessage.mockImplementation(() => new Promise(() => {}));
    r.patch.mockClear();
    const closing = r.dialogs.reconcile("agent-1", "epoch", [], []);
    await eventually(() => expect(r.deleteMessage).toHaveBeenCalledTimes(1));
    r.clock.advance(8_000);
    await closing;
    expect(r.patch).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining("对话已过期"));
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    r.dialogs.dispose();
  });
  it("network throws also fall back without reopening or retrying", async () => {
    const r = await rig();
    r.deleteMessage.mockRejectedValue(new Error("network"));
    r.patch.mockClear();
    await r.dialogs.reconcile("agent-1", "new-epoch", [], []);
    expect(r.patch).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining("对话已过期"));
    r.dialogs.dispose();
  });
  it.each([true, false])(
    "pending send settles elsewhere then delivery (inline=%s) recalls immediately",
    async (inline) => {
      const r = await rig(false, false);
      let finish!: (v: { messageId: string; chatId: string } | undefined) => void;
      r.sendCard.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const sending = r.dialogs.reconcile("agent-1", "epoch", [r.open], []);
      await eventually(() => expect(r.sendCard).toHaveBeenCalledTimes(1));
      const card = r.state.dialogCards.list()[0]!;
      await r.dialogs.reconcile(
        "agent-1",
        "epoch",
        [],
        [{ dialogId: "dialog", by: "web", outcome: "answered", at: NOW }],
      );
      expect(r.state.dialogCards.get(card.id)).toMatchObject({
        messageId: "pending",
        recall: "pending",
        status: "answered",
      });
      expect(r.deleteMessage).not.toHaveBeenCalled();
      finish(inline ? { messageId: "late", chatId: "chat" } : undefined);
      await sending;
      if (!inline) await r.dialogs.delivered(card.id, "late");
      await r.dialogs.delivered(card.id, "late");
      expect(r.deleteMessage).toHaveBeenCalledTimes(1);
      expect(r.deleteMessage).toHaveBeenCalledWith("late");
      expect(r.patch).not.toHaveBeenCalled();
      r.dialogs.dispose();
    },
  );
  it.each([true, false])("restart never re-deletes after an attempted recall (ok=%s)", async (success) => {
    const r = await rig();
    if (!success) r.deleteMessage.mockRejectedValue(new Error("network"));
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    r.dialogs.dispose();
    const state = createFeishuState({
      dir: r.dir,
      groupCommitMs: 0,
      clock: { ...systemFeishuClock, now: r.clock.now },
    });
    await state.load();
    const restarted = createFeishuDialogs({ ...r.deps, state });
    r.patch.mockClear();
    try {
      await restarted.reconcile("agent-1", "epoch", [], []);
      await restarted.delivered(r.record.id, "card");
      await restarted.sweep();
      expect(r.deleteMessage).toHaveBeenCalledTimes(1);
      expect(r.patch).not.toHaveBeenCalled();
      expect(state.dialogCards.get(r.record.id)?.recall).toBe("attempted");
    } finally {
      restarted.dispose();
      state.dispose();
    }
  });
  it.each([true, false])("Feishu closure published before command result (cmdId=%s) is kept", async (withCmdId) => {
    const r = await rig();
    r.request.mockImplementationOnce(async (frame) => {
      await r.dialogs.reconcile(
        "agent-1",
        "epoch",
        [],
        [{ dialogId: "dialog", by: "web", outcome: "answered", at: NOW, ...(withCmdId ? { cmdId: frame.id } : {}) }],
      );
      return { t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: {} as never };
    });
    await r.dialogs.callback(r.nonce("option"), r.identity, "own", {});
    expect(r.deleteMessage).not.toHaveBeenCalled();
    expect(r.patches.at(-1)).toContain("已通过飞书作答");
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("answered");
    r.dialogs.dispose();
  });
  it("restart preserves pending recall intent and cleans up late outbox delivery", async () => {
    const r = await rig(false, false);
    // The outbox waiter times out, but its logical send may still complete after restart.
    r.sendCard.mockResolvedValueOnce(undefined);
    await r.dialogs.reconcile("agent-1", "epoch", [r.open], []);
    const card = r.state.dialogCards.list()[0]!;
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    r.dialogs.dispose();
    const state = createFeishuState({
      dir: r.dir,
      groupCommitMs: 0,
      clock: { ...systemFeishuClock, now: r.clock.now },
    });
    await state.load();
    const restarted = createFeishuDialogs({ ...r.deps, state });
    r.patch.mockClear();
    try {
      expect(state.dialogCards.get(card.id)).toMatchObject({
        status: "expired",
        recall: "pending",
        messageId: "pending",
      });
      await restarted.delivered(card.id, "after-restart");
      await restarted.delivered(card.id, "after-restart");
      expect(r.deleteMessage).toHaveBeenCalledTimes(1);
      expect(r.deleteMessage).toHaveBeenCalledWith("after-restart");
      expect(r.patch).not.toHaveBeenCalled();
    } finally {
      restarted.dispose();
      state.dispose();
    }
  });
  it("restart uses the persisted winning cmdId to keep a Feishu answer even before its ACK", async () => {
    const r = await rig();
    r.state.dialogCards.update(r.record.id, { answerCmdId: "own-before-crash" });
    await r.state.commit();
    r.dialogs.dispose();
    const state = createFeishuState({
      dir: r.dir,
      groupCommitMs: 0,
      clock: { ...systemFeishuClock, now: r.clock.now },
    });
    await state.load();
    const restarted = createFeishuDialogs({ ...r.deps, state });
    r.patch.mockClear();
    try {
      await restarted.reconcile(
        "agent-1",
        "epoch",
        [],
        [{ dialogId: "dialog", by: "web", cmdId: "own-before-crash", outcome: "answered", at: NOW }],
      );
      expect(r.deleteMessage).not.toHaveBeenCalled();
      expect(r.patch).toHaveBeenCalledTimes(1);
      expect(r.patch).toHaveBeenCalledWith("card", expect.stringContaining("已通过飞书作答"));
    } finally {
      restarted.dispose();
      state.dispose();
    }
  });
  it("a different web cmdId is not mistaken for this Feishu card's answer", async () => {
    const r = await rig();
    r.state.dialogCards.update(r.record.id, { answerCmdId: "own" });
    r.patch.mockClear();
    await r.dialogs.reconcile(
      "agent-1",
      "epoch",
      [],
      [{ dialogId: "dialog", by: "web", cmdId: "other-web", outcome: "answered", at: NOW }],
    );
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.patch).not.toHaveBeenCalled();
    r.dialogs.dispose();
  });
  it("failed fallback patch is terminal too, not retried on reconcile or sweep", async () => {
    const r = await rig();
    r.deleteMessage.mockRejectedValue(new Error("network"));
    r.patch.mockClear();
    r.patch.mockRejectedValue(new Error("patch network"));
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    await r.dialogs.sweep();
    expect(r.deleteMessage).toHaveBeenCalledTimes(1);
    expect(r.patch).toHaveBeenCalledTimes(1);
    r.dialogs.dispose();
  });
});
