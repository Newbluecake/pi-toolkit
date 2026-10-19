/** F8 ask_user third race channel. Authority lives in bound one-shot nonces, never form fields. */
import { randomBytes } from "node:crypto";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import type { DialogWire, DialogClosedWire, DialogAnswerWire } from "../../protocol/messages.js";
import type { FeishuState, FeishuDialogCard, FeishuBinding, FeishuNonce } from "./state.js";
import type { FeishuAdmission, FeishuIdentityContext, FeishuInstallation } from "./admission.js";
import type { FeishuMessage } from "./inbound.js";
import { feishuBindingKey } from "./sessions.js";
import { feishuKey, object } from "./runtime.js";
import { neutralizeMarkdown } from "./render.js";
import type { OutboxTarget } from "./outbox.js";
import { systemFeishuClock, type FeishuClock } from "./http.js";

export interface FeishuDialogsDeps {
  state: FeishuState;
  admission: Pick<FeishuAdmission, "dispatch" | "authorize">;
  installation(): FeishuInstallation | undefined;
  clock?: FeishuClock;
  session(agentKey: string): string | undefined;
  target(binding: FeishuBinding): OutboxTarget | undefined;
  operator(binding: FeishuBinding): string | undefined;
  link(agentKey: string): string;
  sendCard(
    id: string,
    target: OutboxTarget,
    card: string,
    lane: string,
  ): Promise<{ messageId: string; chatId: string } | undefined>;
  patch(messageId: string, card: string): Promise<unknown>;
  notice(binding: FeishuBinding, text: string): Promise<unknown>;
}
export const feishuDialogEpoch = (epoch: string): number =>
  parseInt(Buffer.from(feishuKey(epoch), "base64url").subarray(0, 4).toString("hex"), 16);
export function validateFeishuAnswers(dialog: DialogWire, answers: DialogAnswerWire[]): boolean {
  return (
    dialog.questions.length <= 8 &&
    answers.length === dialog.questions.length &&
    answers.every((answer, i) => {
      const q = dialog.questions[i]!;
      if (
        !Array.isArray(answer.selected) ||
        answer.selected.length > q.options.length ||
        new Set(answer.selected).size !== answer.selected.length ||
        answer.selected.some((label) => !q.options.some((o) => o.label === label))
      )
        return false;
      if (!q.multiSelect && answer.selected.length > 1) return false;
      if (
        answer.other !== null &&
        (typeof answer.other !== "string" || Buffer.byteLength(answer.other) > 4_096 || q.allowOther === false)
      )
        return false;
      return answer.skipped === true
        ? answer.selected.length === 0 && !answer.other
        : answer.selected.length > 0 || !!answer.other;
    })
  );
}
const closedCard = (text: string) =>
  JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: { elements: [{ tag: "markdown", content: neutralizeMarkdown(text) }] },
  });
export function createFeishuDialogs(deps: FeishuDialogsDeps) {
  const clock = deps.clock ?? systemFeishuClock;
  const live = new Map<string, { epoch: string; open: DialogWire[] }>();
  const drafts = new Map<string, { at: number; answers: DialogAnswerWire[] }>();
  const timers = new Map<string, unknown>();
  const sending = new Set<string>();
  let disposed = false;
  function current(card: FeishuDialogCard) {
    const source = live.get(card.agentKey);
    return source && feishuDialogEpoch(source.epoch) === card.epoch
      ? { epoch: source.epoch, dialog: source.open.find((d) => d.dialogId === card.dialogId) }
      : undefined;
  }
  async function close(card: FeishuDialogCard, status: "answered" | "closed" | "expired" | "unknown", text: string) {
    deps.state.dialogCards.update(card.id, { status });
    if (!(await deps.state.commit()) || disposed) return;
    if (card.messageId !== "pending") await deps.patch(card.messageId, closedCard(text));
  }
  async function refresh(card: FeishuDialogCard, error?: string) {
    if (disposed || card.messageId === "pending") return;
    const binding = deps.state.bindings.get(card.bindingKey),
      source = current(card),
      install = deps.installation(),
      tenantKey = deps.state.tenant.get();
    const operator = binding && deps.operator(binding);
    if (
      !binding ||
      !source?.dialog ||
      !install?.active ||
      !tenantKey ||
      !operator ||
      !deps.state.allowList.has(operator)
    )
      return;
    const dialog = source.dialog;
    if (dialog.questions.length > 8) {
      await deps.patch(card.messageId, closedCard(`请到 web 作答：${deps.link(card.agentKey)}`));
      return;
    }
    const issue = (action: object) =>
      deps.state.nonces.issue(
        {
          installGen: install.gen,
          tenantKey,
          operatorOpenId: operator,
          chatId: card.chatId,
          messageId: card.messageId,
          action: "dialog",
          target: JSON.stringify({ card: card.id, epoch: source.epoch, ...action }),
        },
        Math.max(1, card.expiresAt - clock.now()),
      );
    const elements: object[] = [
      {
        tag: "markdown",
        content: `${card.shortCode} ${error ? neutralizeMarkdown(error) + "\n" : ""}${dialog.questions.map((q, i) => `${i + 1}. ${neutralizeMarkdown(q.question)}\n${q.options.map((o, n) => `${n + 1}. ${neutralizeMarkdown(o.label)}`).join("\n")}`).join("\n\n")}\n${dialog.questions.length === 1 ? `文字回答：${card.shortCode} 1 / ${card.shortCode} 1,3 / ${card.shortCode} text` : "多问题表单请在卡片中作答"}\n或到 web：${deps.link(card.agentKey)}`,
      },
    ];
    const buttons: object[] = [];
    if (dialog.questions.length === 1 && !dialog.questions[0]!.multiSelect) {
      for (const [i, option] of dialog.questions[0]!.options.entries()) {
        const nonce = issue({ op: "option", option: i });
        if (nonce.ok)
          buttons.push({
            tag: "button",
            text: { tag: "plain_text", content: option.label },
            behaviors: [{ type: "callback", value: { n: nonce.value.nonce } }],
          });
      }
    }
    const submit = issue({ op: "submit" });
    if (submit.ok) {
      const formElements: object[] = [];
      for (const [i, q] of dialog.questions.entries()) {
        formElements.push({
          tag: q.multiSelect ? "multi_select_static" : "select_static",
          name: `q${i}`,
          options: [
            ...q.options.map((o, n) => ({ text: { tag: "plain_text", content: o.label }, value: String(n) })),
            { text: { tag: "plain_text", content: "跳过" }, value: "skip" },
          ],
        });
        if (q.allowOther !== false)
          formElements.push({
            tag: "input",
            name: `o${i}`,
            placeholder: { tag: "plain_text", content: "其他（可选）" },
            max_length: 4_096,
          });
      }
      formElements.push({
        tag: "button",
        name: "submit",
        action_type: "form_submit",
        text: { tag: "plain_text", content: "提交" },
        behaviors: [{ type: "callback", value: { n: submit.value.nonce } }],
      });
      elements.push({ tag: "form", name: "answers", elements: formElements });
    }
    if (dialog.allowCancel) {
      const n = issue({ op: "cancel" });
      if (n.ok)
        buttons.push({
          tag: "button",
          text: { tag: "plain_text", content: "取消" },
          behaviors: [{ type: "callback", value: { n: n.value.nonce } }],
        });
    }
    if (buttons.length)
      elements.push({
        tag: "column_set",
        columns: buttons.map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] })),
      });
    if (!(await deps.state.commit()) || disposed) return;
    const cardJson = JSON.stringify({ schema: "2.0", config: { update_multi: true }, body: { elements } });
    await deps.patch(
      card.messageId,
      Buffer.byteLength(cardJson) <= 20_000 ? cardJson : closedCard(`请到 web 作答：${deps.link(card.agentKey)}`),
    );
  }
  async function answer(
    card: FeishuDialogCard,
    identity: FeishuIdentityContext,
    answers: DialogAnswerWire[],
    cancel: boolean,
    id: string,
  ) {
    const source = current(card),
      binding = deps.state.bindings.get(card.bindingKey);
    if (!source?.dialog || !binding?.sessionId || card.status !== "open" || (cancel && !source.dialog.allowCancel)) {
      await close(card, "closed", "对话已关闭 / E_DIALOG_CLOSED");
      return;
    }
    if (!cancel && !validateFeishuAnswers(source.dialog, answers)) {
      await refresh(card, "答案无效，请重新作答");
      return;
    }
    const result = await deps.admission.dispatch({
      ...identity,
      id,
      sessionId: binding.sessionId,
      bindingKey: binding.key,
      bindingRev: binding.rev,
      expectedAgentKey: card.agentKey,
      cmd: cancel
        ? { op: "dialog_cancel", dialogId: card.dialogId, epoch: source.epoch }
        : { op: "dialog_answer", dialogId: card.dialogId, epoch: source.epoch, answers },
    });
    if (result.ok && result.result.ok) {
      drafts.delete(`${card.id}:${identity.senderOpenId}`);
      await close(card, cancel ? "closed" : "answered", cancel ? "已取消" : "已通过飞书作答");
    } else if (result.ok && !result.result.ok && result.result.code === "E_BAD_ANSWER")
      await refresh(card, "答案无效，请重新作答");
    else if (result.ok && !result.result.ok && result.result.code === "E_DIALOG_CLOSED")
      await close(card, "closed", "对话已由 TUI/web 关闭");
    else await refresh(card, "提交未确认，请到 web 查看状态");
  }
  return {
    async reconcile(agentKey: string, epoch: string, open: DialogWire[], closed: DialogClosedWire[]) {
      if (disposed || (!live.has(agentKey) && live.size >= 512)) return;
      clock.clearTimeout(timers.get(agentKey));
      timers.delete(agentKey);
      live.set(agentKey, { epoch, open: open.slice(0, 64) });
      for (const card of deps.state.dialogCards
        .list()
        .filter((c) => c.agentKey === agentKey && (c.status === "open" || c.status === "unknown"))) {
        const done = closed.find((d) => d.dialogId === card.dialogId);
        if (done)
          await close(card, done.outcome === "answered" ? "answered" : "closed", `${done.outcome} via ${done.by}`);
        else if (card.epoch !== feishuDialogEpoch(epoch) || !open.some((d) => d.dialogId === card.dialogId))
          await close(card, "expired", "对话已过期");
        else if (card.messageId !== "pending") {
          if (card.status === "unknown") deps.state.dialogCards.update(card.id, { status: "open" });
          await refresh(deps.state.dialogCards.get(card.id)!);
        }
      }
      const sessionId = deps.session(agentKey);
      if (!sessionId) return;
      for (const binding of deps.state.bindings
        .list()
        .filter((b) => b.sessionId === sessionId && b.offline === undefined))
        for (const dialog of open.slice(0, 64)) {
          // Not answerable from Feishu (refresh() renders > 8 questions as a web-only pointer) ⇒
          // send nothing (user ruling 2026-10-19).
          if (dialog.questions.length > 8) continue;
          const id = `fd${feishuKey(`${agentKey}:${epoch}:${dialog.dialogId}:${binding.key}`)}`;
          if (deps.state.dialogCards.get(id) || sending.has(id)) continue;
          const target = deps.target(binding);
          if (!target) continue;
          const card = deps.state.dialogCards.add({
            id,
            agentKey,
            dialogId: dialog.dialogId,
            epoch: feishuDialogEpoch(epoch),
            bindingKey: binding.key,
            chatId: binding.chatId,
            messageId: "pending",
            shortCode: `#${randomBytes(3).toString("hex")}`,
          });
          // No card could be recorded (cap / budget / invalid / unavailable) ⇒ the dialog cannot be
          // answered from Feishu either; push nothing.
          if (!card.ok) continue;
          sending.add(id);
          try {
            if (!(await deps.state.commit()) || disposed) continue;
            const sent = await deps.sendCard(
              id,
              target,
              closedCard(
                `${card.value.shortCode} 等待作答（${dialog.questions.length === 1 ? "可用文字回答" : "请在卡片中作答"}）\n${deps.link(agentKey)}`,
              ),
              binding.chatId,
            );
            if (!sent || disposed) {
              await close(card.value, "unknown", "状态未知 — 在 web 查看");
              continue;
            }
            deps.state.dialogCards.update(id, { messageId: sent.messageId });
            await deps.state.commit();
            await refresh(deps.state.dialogCards.get(id)!);
          } finally {
            sending.delete(id);
          }
        }
    },
    async delivered(id: string, messageId: string | undefined) {
      const card = deps.state.dialogCards.get(id);
      if (!card || disposed) return;
      if (messageId) {
        deps.state.dialogCards.update(id, { messageId });
        if (await deps.state.commit()) await refresh(deps.state.dialogCards.get(id)!);
      } else await close(card, "unknown", `状态未知 — 在 web 查看：${deps.link(card.agentKey)}`);
    },
    disconnected(agentKey: string) {
      live.delete(agentKey);
      if (timers.has(agentKey) || timers.size >= 512) return;
      timers.set(
        agentKey,
        clock.setTimeout(() => {
          timers.delete(agentKey);
          for (const card of deps.state.dialogCards
            .list()
            .filter((c) => c.agentKey === agentKey && c.status === "open"))
            void close(card, "unknown", "状态未知 — 在 web 查看").catch(() => {});
        }, 30_000),
      );
    },
    async callback(
      record: FeishuNonce,
      identity: FeishuIdentityContext,
      eventId: string,
      action: Readonly<Record<string, unknown>>,
    ) {
      if (disposed || record.action !== "dialog") return;
      let target: Record<string, unknown> | undefined;
      try {
        target = object(JSON.parse(record.target));
      } catch {
        return;
      }
      const card = typeof target?.["card"] === "string" ? deps.state.dialogCards.get(target["card"]) : undefined;
      if (!target || !card || current(card)?.epoch !== target?.["epoch"]) return;
      const source = current(card)!;
      if (!source.dialog) return;
      if (target["op"] === "cancel") {
        await answer(card, identity, [], true, `fc${feishuKey(eventId)}`);
        return;
      }
      let answers: DialogAnswerWire[];
      if (target["op"] === "option" && typeof target["option"] === "number" && source.dialog.questions.length === 1) {
        const label = source.dialog.questions[0]!.options[target["option"]]?.label;
        if (!label) return;
        answers = [{ selected: [label], other: null }];
      } else {
        const form = object(action["form_value"]);
        if (!form) {
          await refresh(card, "请填写表单");
          return;
        }
        answers = source.dialog.questions.map((q, i) => {
          const value = form[`q${i}`],
            list = Array.isArray(value) ? value : value === undefined ? [] : [value];
          const other = form[`o${i}`];
          return {
            selected: list
              .filter((v) => v !== "skip")
              .map((v) =>
                typeof v === "string" && /^\d+$/.test(v) ? (q.options[Number(v)]?.label ?? "invalid") : "invalid",
              ),
            other: typeof other === "string" && other ? other : null,
            ...(list.includes("skip") ? { skipped: true } : {}),
          };
        });
      }
      if (!validateFeishuAnswers(source.dialog, answers)) {
        await refresh(card, "答案无效，请重新作答");
        return;
      }
      for (const [key, draft] of drafts) if (clock.now() - draft.at >= FEISHU_CAPS.askDraftTtlMs) drafts.delete(key);
      const key = `${card.id}:${identity.senderOpenId}`;
      if (drafts.has(key) || drafts.size < FEISHU_CAPS.askDrafts) drafts.set(key, { at: clock.now(), answers });
      else {
        await refresh(card, "暂时繁忙，请到 web 作答");
        return;
      }
      await answer(card, identity, answers, false, `fc${feishuKey(eventId)}`);
    },
    async text(message: FeishuMessage, identity: FeishuIdentityContext): Promise<boolean> {
      const key = feishuBindingKey(message.chatType, message.chatId, message.threadId);
      const cards = deps.state.dialogCards.list().filter((c) => c.bindingKey === key && c.status === "open");
      if (!cards.length) return false;
      const addressed = /^(#[a-f0-9]{6})\s+([\s\S]*)$/.exec(message.text);
      const card = addressed
        ? cards.find((c) => c.shortCode === addressed[1])
        : cards.length === 1
          ? cards[0]
          : undefined;
      const binding = key ? deps.state.bindings.get(key) : undefined;
      if (!card) {
        if (binding) await deps.notice(binding, "有多个对话，请用卡片短码 #xxxxxx 指定答案");
        return true;
      }
      if (!binding || deps.operator(binding) !== identity.senderOpenId) return true;
      const source = current(card);
      if (!source?.dialog) {
        if (binding) await deps.notice(binding, `状态未知 — 在 web 查看：${deps.link(card.agentKey)}`);
        return true;
      }
      if (source.dialog.questions.length !== 1) {
        if (binding) await deps.notice(binding, "请在卡片中作答");
        return true;
      }
      const text = addressed?.[2] ?? message.text,
        q = source.dialog.questions[0]!;
      const numeric = /^\d+(?:\s*,\s*\d+)*$/.test(text.trim());
      const indices = numeric ? text.split(",").map((n) => Number(n.trim())) : [];
      const validIndices = numeric && indices.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= q.options.length);
      // Numeric Other (e.g. age 42) must remain expressible without a special syntax.
      const answerValue: DialogAnswerWire = validIndices
        ? { selected: indices.map((n) => q.options[n - 1]!.label), other: null }
        : !numeric || q.allowOther !== false
          ? { selected: [], other: text }
          : { selected: ["invalid"], other: null };
      await answer(card, identity, [answerValue], false, `ft${feishuKey(message.eventId)}`);
      return true;
    },
    async sweep() {
      for (const card of deps.state.dialogCards.list())
        if (card.status === "open" && card.expiresAt - clock.now() <= 60_000)
          await close(card, "expired", "卡片已过期 — 在 web 查看");
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clock.clearTimeout(timer);
      timers.clear();
      live.clear();
      drafts.clear();
      sending.clear();
    },
  };
}
export type FeishuDialogs = ReturnType<typeof createFeishuDialogs>;
