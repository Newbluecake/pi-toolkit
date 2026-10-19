import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuDialogs, validateFeishuAnswers } from "../../../../src/web-hub/hub/feishu/dialogs.js";
import { cleanupF6, f6Rig, OWNER, normalizedMessage, NOW } from "../../../fixtures/feishu/f6.js";
import { eventually } from "../../../fixtures/feishu/f8.js";
import type { DialogWire } from "../../../../src/web-hub/protocol/messages.js";
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
async function rig(multi = false) {
  const r = await f6Rig(),
    patches: string[] = [];
  const patch = vi.fn(async (_messageId: string, card: string) => {
    patches.push(card);
  });
  const notice = vi.fn(async (_binding: unknown, _text: string) => {});
  const sendCard = vi.fn(async () => ({ messageId: "card", chatId: "chat" }));
  const dialogs = createFeishuDialogs({
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
    notice,
  });
  const open = dialog(multi);
  await dialogs.reconcile("agent-1", "epoch", [open], []);
  const record = r.state.dialogCards.list()[0]!;
  function nonce(op: string): FeishuNonce {
    const n = [...patches.at(-1)!.matchAll(/"n":"([A-Za-z0-9_-]{22})"/g)]
      .map((m) => r.state.nonces.get(m[1]!))
      .find((n) => n && JSON.parse(n.target).op === op);
    if (!n) throw new Error(`missing ${op}`);
    return n;
  }
  return { ...r, dialogs, open, record, patch, patches, notice, sendCard, nonce };
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
    expect(r.patches.at(-1)).toContain("飞书");
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
    expect(r.patches.at(-1)).toContain("answered via tui");
    r.dialogs.dispose();
  });
  it("authoritative absent card is expired and 24h TTL is patched before state sweep deletes it", async () => {
    const r = await rig();
    await r.dialogs.reconcile("agent-1", "epoch", [], []);
    expect(r.state.dialogCards.get(r.record.id)?.status).toBe("expired");
    r.dialogs.dispose();
    const expiry = await rig();
    expiry.clock.advance(24 * 3_600_000 - 30_000);
    await expiry.dialogs.sweep();
    expect(expiry.patches.at(-1)).toContain("卡片已过期");
    expiry.dialogs.dispose();
  });
});
