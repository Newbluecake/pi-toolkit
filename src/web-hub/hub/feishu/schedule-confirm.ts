/** #61 F2: owner-only schedule approval cards. Authority lives in the existing nonce table,
 * never in client values or an absent offer. No pi imports, ledger writes or dispatch bypasses.
 * All waits are bounded; physical IO slots follow the real promise (including zombies).
 */
import { FEISHU_CAPS, FEISHU_REPLY_LIMITS } from "../../protocol/feishu.js";
import {
  SCHED_CONFIRM_TTL_MS,
  SCHED_HASH_RE,
  SCHED_REQ_ID_RE,
  SCHED_SESSION_ID_RE,
  SCHED_TASK_ID_RE,
} from "../../protocol/schedule.js";
import type { FeishuIdentityContext, FeishuInstallation, FeishuAdmission } from "./admission.js";
import type { FeishuClock, FeishuResult } from "./http.js";
import { safeFeishuLink } from "./link.js";
import type { OutboxTarget } from "./outbox.js";
import { neutralizeMarkdown, sanitizeLabel } from "./render.js";
import { bounded, feishuKey, object } from "./runtime.js";
import type {
  FeishuSchedulePort,
  FeishuScheduleOfferRow,
  FeishuScheduleOfferClosed,
  ScheduleDecideResult,
} from "./schedule.js";
import type { FeishuBinding, FeishuNonce, FeishuState } from "./state.js";

const ANCHOR = "sched-card";
const OK = "sched-ok";
const NO = "sched-no";
const NONCE_BUDGET = FEISHU_CAPS.nonces - FEISHU_CAPS.noncesReservedForOthers;
export const SCHEDULE_CONFIRM_CARDS_GLOBAL = 16;
export const SCHEDULE_CONFIRM_CARDS_SESSION = 4;
const isOurs = (n: FeishuNonce): boolean => [ANCHOR, OK, NO].includes(n.action);

export interface ScheduleConfirmStatePort {
  commit(): Promise<boolean>;
  persistFailed(): boolean;
  nonces: Pick<FeishuState["nonces"], "issue" | "get" | "list" | "purge" | "size">;
  bindings: Pick<FeishuState["bindings"], "get" | "list">;
  allowList: Pick<FeishuState["allowList"], "has">;
  tenant: Pick<FeishuState["tenant"], "get">;
}
export interface ScheduleConfirmDeps {
  state: ScheduleConfirmStatePort;
  port: FeishuSchedulePort;
  installation(): FeishuInstallation | undefined;
  /** Independent proof: lastRequest(binding)?.senderOpenId === owner, NEVER a fallback. */
  provenOwner(binding: FeishuBinding): boolean;
  admission: Pick<FeishuAdmission, "callback">;
  ready(): boolean;
  link(sessionId: string): string | undefined;
  sendCard(
    id: string,
    target: OutboxTarget,
    card: string,
    lane: string,
  ): Promise<{ messageId: string; chatId: string } | undefined>;
  patch(messageId: string, card: string): Promise<FeishuResult<void>>;
  deleteMessage(messageId: string): Promise<FeishuResult<void>>;
  notice(target: OutboxTarget, text: string, lane: string): Promise<unknown>;
  clock: FeishuClock;
  count(reason: string): void;
}
interface AnchorTarget {
  sid: string;
  offerId: string;
  taskId: string;
  defHash: string;
  bindingKey: string;
}
interface Card {
  id: string;
  target: AnchorTarget;
  anchor: FeishuNonce;
  timer: unknown;
  terminal: boolean;
  lastText?: string;
}
function parse(record: FeishuNonce): (AnchorTarget & { anchor?: string }) | undefined {
  try {
    const v = object(JSON.parse(record.target));
    if (
      !v ||
      typeof v["sid"] !== "string" ||
      !SCHED_SESSION_ID_RE.test(v["sid"]) ||
      typeof v["offerId"] !== "string" ||
      !SCHED_REQ_ID_RE.test(v["offerId"]) ||
      typeof v["taskId"] !== "string" ||
      !SCHED_TASK_ID_RE.test(v["taskId"]) ||
      typeof v["defHash"] !== "string" ||
      !SCHED_HASH_RE.test(v["defHash"]) ||
      typeof v["bindingKey"] !== "string" ||
      v["bindingKey"] !== `p2p:${record.chatId}`
    )
      return undefined;
    return {
      sid: v["sid"],
      offerId: v["offerId"],
      taskId: v["taskId"],
      defHash: v["defHash"],
      bindingKey: v["bindingKey"],
      ...(typeof v["anchor"] === "string" ? { anchor: v["anchor"] } : {}),
    };
  } catch {
    return undefined;
  }
}
const cardId = (t: AnchorTarget): string => `fsc${feishuKey(`${t.sid}:${t.offerId}:${t.defHash}:${t.bindingKey}`)}`;
const closedText = (c: FeishuScheduleOfferClosed, mine: boolean, taskId: string): string => {
  if (c.outcome === "approved") return mine ? "已通过飞书批准" : "已在其他端批准";
  if (c.outcome === "rejected") return mine ? "已通过飞书拒绝（已删除 / 已恢复修改前定义）" : "已在其他端拒绝";
  if (c.outcome === "superseded") return "定义已变更，本卡作废";
  if (c.outcome === "expired") return `已过期，请在终端 /schedule approve ${taskId}`;
  return "确认请求已撤回，请在 web 或终端查看";
};
const statusCard = (text: string): string =>
  JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: { elements: [{ tag: "markdown", content: text }] },
  });

/** Q4: only prompt is clipped; hash and both buttons always survive the UTF-8 JSON budget. */
export function renderScheduleConfirmCard(
  row: FeishuScheduleOfferRow,
  url: string | undefined,
  buttons?: { approve: string; reject: string },
): string {
  const task = row.task;
  const link = safeFeishuLink(url);
  const when = task.when.kind === "cron" ? `cron ${task.when.expr}` : `once ${task.when.at}`;
  const build = (prompt: string, clipped: boolean): string =>
    JSON.stringify({
      schema: "2.0",
      config: { update_multi: true },
      header: {
        title: {
          tag: "plain_text",
          content: `定时任务待确认 · ${sanitizeLabel(row.sessionLabel).slice(0, 80)} · ${row.sessionId.slice(0, 6)}`,
        },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: neutralizeMarkdown(
              `名称：${task.name}\nwhen：${when}\ntz：${task.when.tz}\nform：${task.form}\nfeishu：${task.feishu}\nenabled：${task.enabled}\nownerCwd：${task.ownerCwd}\nbg：${JSON.stringify(task.bg ?? null)}`,
            ),
          },
          // Prevent a user-authored backtick fence from escaping the quoted prompt.
          {
            tag: "markdown",
            content: `prompt：\n\n\`\`\`\n${neutralizeMarkdown(prompt).replace(/`/g, "ˋ")}\n\`\`\`${clipped ? "\n\n完整内容见 web（prompt 已截断；按钮绑定完整定义）" : ""}`,
          },
          {
            tag: "markdown",
            content: `hash：${row.defHash.slice(0, 8)}\n过期时间：${new Date(row.expiresAt).toISOString()}\n${link === "web 会话页面" ? link : `[在 web 中打开](${link})`}`,
          },
          ...(buttons
            ? [
                {
                  tag: "column_set",
                  horizontal_spacing: "large",
                  columns: [
                    {
                      tag: "column",
                      width: "weighted",
                      weight: 1,
                      elements: [
                        {
                          tag: "button",
                          type: "danger_filled",
                          text: { tag: "plain_text", content: "拒绝" },
                          behaviors: [{ type: "callback", value: { n: buttons.reject } }],
                        },
                      ],
                    },
                    {
                      tag: "column",
                      width: "weighted",
                      weight: 1,
                      elements: [
                        {
                          tag: "button",
                          type: "primary_filled",
                          text: { tag: "plain_text", content: "批准" },
                          behaviors: [{ type: "callback", value: { n: buttons.approve } }],
                        },
                      ],
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    });
  const full = build(task.prompt, false);
  if (Buffer.byteLength(full) <= FEISHU_REPLY_LIMITS.maxCardBytes) return full;
  const chars = [...task.prompt];
  let lo = 0,
    hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(build(chars.slice(0, mid).join(""), true)) <= FEISHU_REPLY_LIMITS.maxCardBytes) lo = mid;
    else hi = mid - 1;
  }
  return build(chars.slice(0, lo).join(""), true);
}

export function createFeishuScheduleConfirm(deps: ScheduleConfirmDeps) {
  let disposed = false;
  const cards = new Map<string, Card>();
  const creating = new Map<string, string>(); // synchronous quota reservation (id → sid)
  const attempted = new Map<string, number>(); // unknown send dedup, bounded by offer TTL
  const inFlight = new Set<string>(); // set BEFORE the first await in a callback
  const physical = new Set<Promise<unknown>>();
  const patchBusy = new Set<string>();
  const pendingPatch = new Map<string, string>(); // one terminal PATCH owed after a physical buttons PATCH
  const sessions = new Map<string, { promise: Promise<void>; again: boolean }>();
  const count = (reason: string): void => {
    try {
      deps.count(`sched-confirm-${reason}`);
    } catch {
      /* diagnostics */
    }
  };
  const install = () => {
    const i = deps.installation();
    return !disposed && i?.active && !deps.state.persistFailed() ? i : undefined;
  };
  async function io<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
    if (disposed || physical.size >= 32) {
      count("io-cap");
      return undefined;
    }
    const p = Promise.resolve().then(() => (disposed ? undefined : work()));
    physical.add(p);
    void p.finally(() => physical.delete(p)).catch(() => {});
    try {
      return await bounded(p, ms, deps.clock);
    } catch {
      return undefined;
    }
  }
  async function barrier(): Promise<boolean> {
    return (await io(() => deps.state.commit(), 1_500)) === true && !deps.state.persistFailed() && !disposed;
  }
  function inventory(): void {
    if (disposed) return;
    for (const [id, expiresAt] of attempted) if (expiresAt <= deps.clock.now()) attempted.delete(id);
    for (const n of deps.state.nonces.list((n) => n.action === ANCHOR)) {
      const target = parse(n);
      if (!target) continue;
      const id = cardId(target);
      if (cards.has(id)) continue;
      const c: Card = { id, target, anchor: n, terminal: false, timer: undefined };
      cards.set(id, c);
      c.timer = deps.clock.setTimeout(
        () => {
          void reconcile(target.sid);
        },
        Math.max(0, Math.min(SCHED_CONFIRM_TTL_MS, n.expiresAt - deps.clock.now())),
      );
    }
    // Keep a bounded recent terminal set for delayed second clicks; durable anchor inventory is authoritative.
    for (const [id, c] of cards) {
      if (cards.size <= 64) break;
      if (c.terminal && !inFlight.has(id)) cards.delete(id);
    }
  }
  function rowOf(t: AnchorTarget): FeishuScheduleOfferRow | undefined {
    return deps.port
      .offers?.()
      .find(
        (r) => r.sessionId === t.sid && r.offerId === t.offerId && r.task.id === t.taskId && r.defHash === t.defHash,
      );
  }
  function closedOf(t: AnchorTarget): FeishuScheduleOfferClosed | undefined {
    return deps.port.closedOffers?.(t.sid).find((r) => r.sessionId === t.sid && r.offerId === t.offerId);
  }
  /** Positive same-hash approval evidence only. A missing list row is NOT proof of deletion. */
  function ledgerText(t: AnchorTarget): string | undefined {
    const r = deps.port.list().find((r) => r.sessionId === t.sid && r.taskId === t.taskId);
    return r?.defHash === t.defHash && r.approved ? "已批准" : undefined;
  }
  const replyTarget = (n: FeishuNonce): OutboxTarget => ({ scope: "p2p", via: "reply", messageId: n.messageId });
  async function notice(n: FeishuNonce, text: string): Promise<void> {
    await io(() => deps.notice(replyTarget(n), text, n.chatId), 8_000);
  }
  function patchSettled(c: Card): void {
    patchBusy.delete(c.id);
    const text = pendingPatch.get(c.id);
    pendingPatch.delete(c.id);
    if (text !== undefined && !disposed) void patch(c, text);
  }
  async function patch(c: Card, text: string): Promise<void> {
    if (disposed || c.lastText === text) return;
    if (patchBusy.has(c.id)) {
      pendingPatch.set(c.id, text);
      return;
    }
    if (physical.size >= 32) {
      count("io-cap");
      return;
    }
    c.lastText = text;
    patchBusy.add(c.id);
    const p = Promise.resolve().then(() => (disposed ? undefined : deps.patch(c.anchor.messageId, statusCard(text))));
    // Physical slot, not the logical deadline, owns serialization on this message.
    try {
      await io(() => p, 8_000);
    } finally {
      void p.finally(() => patchSettled(c)).catch(() => {});
    }
  }
  function purge(c: Card): void {
    deps.state.nonces.purge((n) => n.messageId === c.anchor.messageId && isOurs(n));
  }
  async function settle(c: Card, text: string, recall: boolean): Promise<void> {
    if (disposed || c.terminal) return;
    // Recall claim is the persisted removal of anchor + buttons. A restart never repeats DELETE.
    purge(c);
    if (!(await barrier())) return;
    c.terminal = true;
    deps.clock.clearTimeout(c.timer);
    if (recall) {
      const result = await io(() => deps.deleteMessage(c.anchor.messageId), 8_000);
      if (result?.ok) return;
    }
    await patch(c, text);
  }
  function validBinding(c: Card): boolean {
    const i = install(),
      b = deps.state.bindings.get(c.target.bindingKey);
    return (
      i !== undefined &&
      i.gen === c.anchor.installGen &&
      deps.state.tenant.get() === c.anchor.tenantKey &&
      i.ownerOpenId === c.anchor.operatorOpenId &&
      deps.state.allowList.has(i.ownerOpenId) &&
      b?.sessionId === c.target.sid &&
      b.chatType === "p2p" &&
      b.offline === undefined &&
      deps.provenOwner(b)
    );
  }
  function issue(c: Card, action: string): FeishuNonce | undefined {
    const a = c.anchor;
    const r = deps.state.nonces.issue(
      {
        installGen: a.installGen,
        tenantKey: a.tenantKey,
        operatorOpenId: a.operatorOpenId,
        chatId: a.chatId,
        messageId: a.messageId,
        action,
        target: JSON.stringify({ ...c.target, anchor: a.nonce }),
      },
      undefined,
      { maxTotal: NONCE_BUDGET, expiresAt: a.expiresAt },
    );
    return r.ok ? r.value : undefined;
  }
  async function buttons(c: Card, row: FeishuScheduleOfferRow): Promise<void> {
    if (!validBinding(c) || c.terminal || inFlight.has(c.id) || c.anchor.expiresAt <= deps.clock.now()) return;
    const existing = deps.state.nonces.list(
      (n) =>
        n.messageId === c.anchor.messageId && (n.action === OK || n.action === NO) && n.expiresAt > deps.clock.now(),
    );
    const ok = existing.find((n) => n.action === OK) ?? issue(c, OK);
    const no = existing.find((n) => n.action === NO) ?? issue(c, NO);
    if (!ok || !no) {
      count("nonce-cap");
      return;
    }
    if (!(await barrier()) || !validBinding(c) || c.terminal || closedOf(c.target) || !rowOf(c.target)) return;
    if (existing.length === 2 && c.lastText === "buttons") return;
    if (disposed || patchBusy.has(c.id) || physical.size >= 32) return;
    patchBusy.add(c.id);
    const p = Promise.resolve().then(() =>
      disposed || c.terminal || !validBinding(c)
        ? undefined
        : deps.patch(
            c.anchor.messageId,
            renderScheduleConfirmCard(row, deps.link(row.sessionId), { approve: ok.nonce, reject: no.nonce }),
          ),
    );
    try {
      const result = await io(() => p, 8_000);
      if (result?.ok && !c.terminal) c.lastText = "buttons";
    } finally {
      void p.finally(() => patchSettled(c)).catch(() => {});
    }
  }
  async function create(row: FeishuScheduleOfferRow, binding: FeishuBinding): Promise<void> {
    const i = install(),
      tenant = deps.state.tenant.get();
    if (!i || !tenant || !deps.ready()) return;
    const t: AnchorTarget = {
      sid: row.sessionId,
      offerId: row.offerId,
      taskId: row.task.id,
      defHash: row.defHash,
      bindingKey: binding.key,
    };
    const id = cardId(t);
    if (cards.has(id) || creating.has(id) || attempted.has(id)) return;
    const open = [...cards.values()].filter((c) => !c.terminal);
    if (
      open.length + creating.size >= SCHEDULE_CONFIRM_CARDS_GLOBAL ||
      open.filter((c) => c.target.sid === t.sid).length +
        [...creating.values()].filter((sid) => sid === t.sid).length >=
        SCHEDULE_CONFIRM_CARDS_SESSION
    ) {
      count("card-cap");
      return;
    }
    if (deps.state.nonces.size + 3 > NONCE_BUDGET) {
      count("nonce-cap");
      return;
    }
    // Never evict safety/dedup records to admit a new send.
    if (attempted.size >= 2048) {
      count("send-cap");
      return;
    }
    creating.set(id, t.sid);
    attempted.set(id, row.expiresAt);
    try {
      const sent = await io(
        () =>
          deps.sendCard(
            id,
            { scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: binding.chatId },
            statusCard("定时任务待确认 — 状态未知，在 web 查看"),
            binding.chatId,
          ),
        31_000,
      );
      if (
        !sent ||
        disposed ||
        sent.chatId !== binding.chatId ||
        install()?.gen !== i.gen ||
        row.expiresAt <= deps.clock.now()
      )
        return;
      const issued = deps.state.nonces.issue(
        {
          installGen: i.gen,
          tenantKey: tenant,
          operatorOpenId: i.ownerOpenId,
          chatId: sent.chatId,
          messageId: sent.messageId,
          action: ANCHOR,
          target: JSON.stringify(t),
        },
        undefined,
        { maxTotal: NONCE_BUDGET, expiresAt: row.expiresAt },
      );
      if (!issued.ok) {
        count("nonce-cap");
        return;
      }
      inventory();
      const c = cards.get(id);
      if (!c) return;
      // Both button nonces are part of the FIRST barrier; no interactive card before durable authority.
      issue(c, OK);
      issue(c, NO);
      if (!(await barrier())) return;
      await inspect(c);
    } finally {
      creating.delete(id);
    }
  }
  async function inspect(c: Card): Promise<void> {
    if (c.terminal || inFlight.has(c.id) || disposed) return;
    const closed = closedOf(c.target);
    if (closed) {
      const mine = closed.by === "feishu" && closed.offerId === c.target.offerId;
      await settle(c, closedText(closed, mine, c.target.taskId), !mine);
      return;
    }
    // r2 #6: before recall/missing-offer decisions consult positive ledger evidence.
    const ledger = ledgerText(c.target);
    if (ledger) {
      await settle(c, ledger, false);
      return;
    }
    if (c.anchor.expiresAt <= deps.clock.now()) {
      await settle(c, "已过期", false);
      return;
    }
    if (!validBinding(c)) {
      await settle(c, "绑定或授权已变更，本卡作废", true);
      return;
    }
    const row = rowOf(c.target);
    if (row) await buttons(c, row);
    // Missing offer / offline / unreadable ledger => retain anchor, never invent a close.
  }
  async function pass(sid: string): Promise<void> {
    if (!install()) return;
    inventory();
    for (const c of cards.values()) if (c.target.sid === sid) await inspect(c);
    if (!deps.ready()) return;
    const rows = (deps.port.offers?.() ?? [])
      .filter((r) => r.sessionId === sid && r.online && r.expiresAt > deps.clock.now())
      .sort((a, b) => a.expiresAt - b.expiresAt);
    const targets = deps.state.bindings
      .list()
      .filter((b) => b.sessionId === sid && b.chatType === "p2p" && b.offline === undefined);
    for (const row of rows) {
      if (closedOf({ sid, offerId: row.offerId, taskId: row.task.id, defHash: row.defHash, bindingKey: "" })) continue;
      for (const b of targets) {
        const i = install();
        if (!i || !deps.state.allowList.has(i.ownerOpenId) || !deps.provenOwner(b)) {
          count("no-owner");
          continue;
        }
        await create(row, b);
      }
    }
  }
  /** Coalesced, bounded session inventory; at most two passes per tap (new taps are not lost). */
  function reconcile(sid: string): Promise<void> {
    if (disposed) return Promise.resolve();
    const pending = sessions.get(sid);
    if (pending) {
      pending.again = true;
      return pending.promise;
    }
    if (sessions.size >= 256) {
      count("reconcile-cap");
      return Promise.resolve();
    }
    const slot = { promise: Promise.resolve(), again: false };
    sessions.set(sid, slot);
    slot.promise = Promise.resolve()
      .then(async () => {
        await pass(sid);
        if (slot.again) {
          slot.again = false;
          await pass(sid);
        }
      })
      .catch(() => {
        count("reconcile-failed");
      })
      .finally(() => sessions.delete(sid));
    return slot.promise;
  }
  function reconcileAll(maxSessions = 256): void {
    inventory();
    const sids = new Set([
      ...deps.state.bindings.list().flatMap((b) => (b.sessionId ? [b.sessionId] : [])),
      ...[...cards.values()].filter((c) => !c.terminal).map((c) => c.target.sid),
    ]);
    for (const sid of [...sids].slice(0, maxSessions)) void reconcile(sid);
  }
  /** Inbound already redeemed/committed the one-shot nonce. This entry reserves inFlight synchronously. */
  async function callback(record: FeishuNonce, identity: FeishuIdentityContext, eventId: string): Promise<void> {
    if (disposed || (record.action !== OK && record.action !== NO)) return;
    const auth = deps.admission.callback(identity),
      i = install();
    if (
      !auth.ok ||
      !i ||
      identity.senderOpenId !== i.ownerOpenId ||
      identity.installGen !== record.installGen ||
      record.installGen !== i.gen ||
      identity.tenantKey !== record.tenantKey ||
      record.tenantKey !== deps.state.tenant.get() ||
      record.operatorOpenId !== i.ownerOpenId ||
      !deps.state.allowList.has(i.ownerOpenId)
    )
      return;
    const t = parse(record);
    if (!t) return;
    inventory();
    const id = cardId(t),
      c = cards.get(id);
    if (inFlight.has(id)) {
      await notice(record, "处理中，请稍候");
      return;
    }
    if (!c || c.terminal || t.anchor !== c.anchor.nonce || !deps.state.nonces.get(c.anchor.nonce)) {
      // r2 #10: second click after settle re-reads CURRENT outcome before PATCH.
      if (c) {
        const closed = closedOf(t),
          text = closed?.outcome === "approved" || ledgerText(t) ? "已批准" : "已在其他端处理";
        await patch(c, text);
      }
      await notice(record, "卡片已失效");
      return;
    }
    if (!validBinding(c)) {
      await notice(record, "卡片已失效");
      return;
    }
    inFlight.add(id);
    try {
      const row = rowOf(t);
      if (!row || c.anchor.expiresAt <= deps.clock.now()) {
        await notice(record, "卡片已失效");
        return;
      }
      let result: ScheduleDecideResult;
      if (!row.online) result = { kind: "offline" };
      else
        result = (await io(
          () =>
            deps.port.decide?.({
              reqId: `fs${feishuKey(eventId)}`,
              sessionId: t.sid,
              offerId: t.offerId,
              taskId: t.taskId,
              defHash: t.defHash,
              decision: record.action === OK ? "approve" : "reject",
            }) ?? Promise.resolve({ kind: "unavailable" } as const),
          12_000,
        )) ?? { kind: "timeout" };
      if (disposed || install()?.gen !== record.installGen) return;
      if (result.kind === "approved" || result.kind === "rejected") {
        await settle(
          c,
          result.kind === "approved" ? "已通过飞书批准" : "已通过飞书拒绝（已删除 / 已恢复修改前定义）",
          false,
        );
      } else if (result.kind === "refused") {
        const closed = closedOf(t),
          ledger = ledgerText(t); // ALWAYS re-read before deciding wording/recall
        if (closed?.outcome === "approved" || ledger) await settle(c, "已批准", false);
        else if (result.reason === "E_REV" || result.reason === "offer-gone")
          await settle(c, "定义已变更，本卡作废", true);
        else await settle(c, "已在其他端处理", false);
      } else {
        await patch(c, result.kind === "offline" ? "会话离线，未处理" : "未确认是否生效，请在 web 或终端查看");
        // Keep authority; consumed buttons heal on the next reconcile/attach. No automatic retry of decide.
        if (result.kind === "offline") await notice(record, "会话离线，未处理");
      }
    } finally {
      inFlight.delete(id);
      void reconcile(t.sid);
    }
  }
  return {
    reconcile,
    reconcileAll,
    callback(record: FeishuNonce, identity: FeishuIdentityContext, eventId: string): Promise<void> {
      return callback(record, identity, eventId).catch(() => {
        count("callback-failed");
      });
    },
    /** setup --replace purges old-generation nonces AFTER bot.stop(); retain only coordinates for a neutral close. */
    revoked(records: readonly FeishuNonce[]): void {
      if (disposed) return;
      for (const anchor of records) {
        const target = parse(anchor);
        if (!target || anchor.action !== ANCHOR) continue;
        const id = cardId(target);
        if (!cards.has(id)) cards.set(id, { id, target, anchor, timer: undefined, terminal: false });
        void reconcile(target.sid);
      }
    },
    dispose(): void {
      disposed = true;
      for (const c of cards.values()) deps.clock.clearTimeout(c.timer);
      cards.clear();
      creating.clear();
      attempted.clear();
      pendingPatch.clear();
    },
  };
}
