/** F8 ask_user third race channel. Authority lives in bound one-shot nonces, never form fields. */
import { randomBytes } from "node:crypto";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import type { DialogWire, DialogClosedWire, DialogAnswerWire } from "../../protocol/messages.js";
import { FEISHU_DIALOG_ANSWER_CMD_IDS_MAX } from "./state.js";
import type { FeishuState, FeishuDialogCard, FeishuBinding, FeishuNonce } from "./state.js";
import type { FeishuAdmission, FeishuIdentityContext, FeishuInstallation } from "./admission.js";
import type { FeishuMessage } from "./inbound.js";
import { feishuBindingKey } from "./sessions.js";
import { bounded, feishuKey, object } from "./runtime.js";
import { neutralizeMarkdown } from "./render.js";
import { createFeishuDiagnostics, type FeishuDiagnostic } from "./diagnostics.js";
import type { OutboxTarget } from "./outbox.js";
import { systemFeishuClock, type FeishuClock, type FeishuResult } from "./http.js";

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
  patch(messageId: string, card: string): Promise<FeishuResult<void>>;
  log?(event: FeishuDiagnostic): void;
  deleteMessage(messageId: string): Promise<FeishuResult<void>>;
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
  const diagnose = createFeishuDiagnostics(deps.log, clock.now);
  const skip = (reason: string) => diagnose({ event: "dialog-refresh-skipped", reason });
  function answerCard(card: FeishuDialogCard, dialog: DialogWire): string {
    const hint =
      dialog.questions.length === 1
        ? `文字回答：${card.shortCode} 1 / ${card.shortCode} 1,3 / ${card.shortCode} text`
        : "文字回答仅支持单问题；多问题请到 web 作答";
    const tail = `\n${hint}\n或到 web：${deps.link(card.agentKey)}`;
    // Preserve full questions/options normally; shrink individual fields only for the JSON byte cap.
    for (const limit of [4_096, 512, 128, 32]) {
      const clip = (s: string) => (Array.from(s).length > limit ? Array.from(s).slice(0, limit).join("") + "…" : s);
      const text = `${card.shortCode} 等待作答\n${dialog.questions
        .map(
          (q, i) =>
            `${i + 1}. ${clip(q.question)}\n${q.options.map((o, n) => `${n + 1}. ${clip(o.label)}${o.description ? ` — ${clip(o.description)}` : ""}`).join("\n")}`,
        )
        .join("\n\n")}${tail}`;
      const json = closedCard(text);
      if (Buffer.byteLength(json) <= 20_000) return json;
    }
    return closedCard(`${card.shortCode} 问题/选项过多，请到 web 查看完整内容。${tail}`);
  }
  const live = new Map<string, { epoch: string; open: DialogWire[]; closed: DialogClosedWire[] }>();
  const drafts = new Map<string, { at: number; answers: DialogAnswerWire[] }>();
  const timers = new Map<string, unknown>();
  const sending = new Set<string>();
  const answering = new Set<string>();
  let disposed = false;
  function current(card: FeishuDialogCard) {
    const source = live.get(card.agentKey);
    return source && feishuDialogEpoch(source.epoch) === card.epoch
      ? { epoch: source.epoch, dialog: source.open.find((d) => d.dialogId === card.dialogId) }
      : undefined;
  }
  const ownAnswerCmdIds = (card: FeishuDialogCard) => [
    ...new Set([...(card.answerCmdIds ?? []), ...(card.answerCmdId ? [card.answerCmdId] : [])]),
  ];
  const terminal = (card: FeishuDialogCard) => card.status !== "open" && card.status !== "unknown";
  const elsewhereText = (card: FeishuDialogCard) =>
    card.status === "answered" ? "已在其他端作答" : card.status === "expired" ? "对话已过期" : "已取消";
  async function patchClosed(card: FeishuDialogCard, text: string, json = closedCard(text)) {
    if (!disposed && card.messageId !== "pending")
      await bounded(deps.patch(card.messageId, json), 8_000, clock).catch(() => {});
  }
  async function recall(card: FeishuDialogCard) {
    // Claim synchronously, then durably, before the API call. Reconcile/delivery may overlap; a
    // restart after this commit must NOT repeat a DELETE whose effect could already have landed.
    const latest = deps.state.dialogCards.get(card.id);
    if (disposed || latest?.recall !== "pending" || latest.messageId === "pending") return;
    deps.state.dialogCards.update(card.id, { recall: "attempted" });
    if (!(await deps.state.commit()) || disposed) return;
    try {
      const result = await bounded(deps.deleteMessage(latest.messageId), 8_000, clock);
      if (result.ok) return;
    } catch {
      // A permission/age/API/transport/deadline failure gets one neutral PATCH, never a retry loop.
    }
    await patchClosed(latest, elsewhereText(latest));
  }
  async function close(
    card: FeishuDialogCard,
    status: "answered" | "closed" | "expired" | "unknown",
    text: string,
    elsewhere = false,
  ) {
    const latest = deps.state.dialogCards.get(card.id);
    if (disposed || !latest || terminal(latest)) return;
    deps.state.dialogCards.update(card.id, { status, ...(elsewhere ? { recall: "pending" } : {}) });
    if (!(await deps.state.commit()) || disposed) return;
    const updated = deps.state.dialogCards.get(card.id)!;
    if (elsewhere) await recall(updated);
    else await patchClosed(updated, text);
  }
  async function reconcileCard(card: FeishuDialogCard) {
    if (card.recall === "pending") return recall(card);
    if (terminal(card)) return;
    const source = live.get(card.agentKey);
    if (!source) return; // A disconnect is not evidence that the dialog settled elsewhere.
    const done = source.closed.find((d) => d.dialogId === card.dialogId);
    if (done) {
      // The wire has no by:"feishu": the agent encodes ALL remote answers as by:"web".
      const mine = done.by === "web" && !!done.cmdId && ownAnswerCmdIds(card).includes(done.cmdId);
      // Older peers may omit cmdId. Let our in-flight result decide before treating it as foreign.
      if (done.by === "web" && !done.cmdId && answering.has(card.id)) return;
      await close(
        card,
        done.outcome === "answered" ? "answered" : "closed",
        done.outcome === "answered" ? "已通过飞书作答" : "已取消",
        !mine,
      );
    } else if (
      card.epoch !== feishuDialogEpoch(source.epoch) ||
      !source.open.some((d) => d.dialogId === card.dialogId)
    ) {
      if (!answering.has(card.id)) await close(card, "expired", "对话已过期", true);
    } else if (card.messageId !== "pending") {
      if (card.status === "unknown") deps.state.dialogCards.update(card.id, { status: "open" });
      await refresh(deps.state.dialogCards.get(card.id)!);
    }
  }
  async function delivered(id: string, messageId: string | undefined) {
    const card = deps.state.dialogCards.get(id);
    if (!card || disposed) return;
    if (!messageId) {
      await close(card, "unknown", `状态未知 — 在 web 查看：${deps.link(card.agentKey)}`);
      return;
    }
    // A repeated outbox delivery must not patch a successfully recalled card or re-delete it.
    if (card.messageId === messageId && terminal(card) && card.recall !== "pending") return;
    deps.state.dialogCards.update(id, { messageId });
    if (!(await deps.state.commit()) || disposed) return;
    const updated = deps.state.dialogCards.get(id)!;
    if (updated.recall) await recall(updated);
    else if (terminal(updated)) await patchClosed(updated, updated.status === "answered" ? "已通过飞书作答" : "已取消");
    else await reconcileCard(updated);
  }
  async function refresh(card: FeishuDialogCard, error?: string) {
    if (disposed) return skip("disposed");
    if (card.messageId === "pending") return skip("message-pending");
    if (terminal(deps.state.dialogCards.get(card.id) ?? card)) return skip("terminal");
    const binding = deps.state.bindings.get(card.bindingKey),
      source = current(card),
      install = deps.installation(),
      tenantKey = deps.state.tenant.get();
    const operator = binding && deps.operator(binding);
    if (!binding) return skip("binding-missing");
    if (binding.sessionId !== deps.session(card.agentKey)) return skip("binding-session-mismatch");
    if (!source) return skip(live.has(card.agentKey) ? "epoch-mismatch" : "source-missing");
    if (!source.dialog) return skip("dialog-missing");
    if (!install?.active) return skip("installation-inactive");
    if (!tenantKey) return skip("tenant-missing");
    if (!operator) return skip("operator-missing");
    if (!deps.state.allowList.has(operator)) return skip("operator-denied");
    const dialog = source.dialog;
    const fallback = () => patchClosed(card, "", answerCard(card, dialog));
    if (dialog.questions.length > 8 || dialog.questions.some((q) => q.options.length > 99)) {
      skip("interactive-limits");
      await fallback();
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
    if (
      dialog.questions.length === 1 &&
      !dialog.questions[0]!.multiSelect &&
      dialog.questions[0]!.options.length <= 8
    ) {
      for (const [i, option] of dialog.questions[0]!.options.entries()) {
        const nonce = issue({ op: "option", option: i });
        if (nonce.ok)
          buttons.push({
            tag: "button",
            text: { tag: "plain_text", content: Array.from(option.label).slice(0, 40).join("") },
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
            ...q.options.map((o, n) => ({
              text: { tag: "plain_text", content: Array.from(o.label).slice(0, 80).join("") },
              value: String(n),
            })),
            { text: { tag: "plain_text", content: "跳过" }, value: "skip" },
          ],
        });
        if (q.allowOther !== false)
          formElements.push({
            tag: "input",
            name: `o${i}`,
            placeholder: { tag: "plain_text", content: "其他（可选）" },
            // Schema 2.0 input limit, verified against the tenant (230099 / 11310 above 1000).
            max_length: 1_000,
          });
      }
      formElements.push({
        tag: "button",
        name: "submit",
        // action_type:"form_submit" is the legacy schema; v2 otherwise rejects the whole card (300123).
        form_action_type: "submit",
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
    for (let i = 0; i < buttons.length; i += 3)
      elements.push({
        tag: "column_set",
        columns: buttons
          .slice(i, i + 3)
          .map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] })),
      });
    if (!(await deps.state.commit())) return skip("commit-failed");
    if (disposed || terminal(deps.state.dialogCards.get(card.id) ?? card)) return skip("settled-during-commit");
    const cardJson = JSON.stringify({ schema: "2.0", config: { update_multi: true }, body: { elements } });
    if (Buffer.byteLength(cardJson) > 20_000) {
      skip("interactive-bytes");
      await fallback();
      return;
    }
    let result: FeishuResult<void>;
    try {
      result = await bounded(deps.patch(card.messageId, cardJson), 8_000, clock);
    } catch {
      result = { ok: false, kind: "timeout", reason: "patch-unconfirmed", retryable: false, effect: "unknown" };
      diagnose({ event: "dialog-patch-failed", reason: "patch-unconfirmed" });
    }
    if (!result.ok && !result.capabilityDenied && !disposed && !terminal(deps.state.dialogCards.get(card.id) ?? card)) {
      diagnose({ event: "dialog-text-fallback", reason: result.kind });
      await fallback();
    }
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
      // Local availability/permission checks do not prove settlement. Keep reconciliation live
      // so only a later authoritative closure/list/expiry can trigger recall.
      await close(card, "unknown", "状态未知 — 在 web 查看");
      return;
    }
    if (!cancel && !validateFeishuAnswers(source.dialog, answers)) {
      await refresh(card, "答案无效，请重新作答");
      return;
    }
    if (answering.has(card.id)) return;
    answering.add(card.id);
    try {
      const ownIds = ownAnswerCmdIds(deps.state.dialogCards.get(card.id) ?? card);
      if (!ownIds.includes(id)) {
        // Do not evict an uncertain dispatch's proof: it may still land after many retry clicks.
        if (ownIds.length >= FEISHU_DIALOG_ANSWER_CMD_IDS_MAX) {
          await refresh(card, "提交次数已达上限，请到 web 查看状态");
          return;
        }
        ownIds.push(id);
      }
      if (!deps.state.dialogCards.update(card.id, { answerCmdIds: ownIds })) return;
      if (!(await deps.state.commit()) || disposed) return;
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
        await close(card, "closed", "已取消", true);
      else await refresh(card, "提交未确认，请到 web 查看状态");
    } finally {
      answering.delete(card.id);
      const latest = deps.state.dialogCards.get(card.id);
      const liveSource = live.get(card.agentKey);
      if (
        !disposed &&
        latest &&
        !terminal(latest) &&
        liveSource &&
        (liveSource.closed.some((d) => d.dialogId === card.dialogId) ||
          latest.epoch !== feishuDialogEpoch(liveSource.epoch) ||
          !liveSource.open.some((d) => d.dialogId === card.dialogId))
      )
        await reconcileCard(latest);
    }
  }
  return {
    async reconcile(agentKey: string, epoch: string, open: DialogWire[], closed: DialogClosedWire[]) {
      if (disposed || (!live.has(agentKey) && live.size >= 512)) return;
      clock.clearTimeout(timers.get(agentKey));
      timers.delete(agentKey);
      live.set(agentKey, { epoch, open: open.slice(0, 64), closed: closed.slice(-64) });
      for (const card of deps.state.dialogCards.list().filter((c) => c.agentKey === agentKey))
        await reconcileCard(card);
      const sessionId = deps.session(agentKey);
      if (!sessionId) return skip("session-missing");
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
            const sent = await deps.sendCard(id, target, answerCard(card.value, dialog), binding.chatId);
            await delivered(id, sent?.messageId);
          } finally {
            sending.delete(id);
          }
        }
    },
    delivered,
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
        if (card.recall === "pending") await recall(card);
        else if (card.status === "open" && card.expiresAt - clock.now() <= 60_000)
          await close(card, "expired", "对话已过期", true);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clock.clearTimeout(timer);
      timers.clear();
      live.clear();
      drafts.clear();
      sending.clear();
      answering.clear();
    },
  };
}
export type FeishuDialogs = ReturnType<typeof createFeishuDialogs>;
