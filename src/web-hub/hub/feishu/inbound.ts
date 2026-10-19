/** F6: schema-2 event decoder, identity/tenant consistency, durable dedup and nonce admission. */
import { createHash } from "node:crypto";
import {
  FEISHU_CAPS,
  FEISHU_NONCE_RE,
  FEISHU_OPEN_ID_RE,
  normalizeCreateTimeMs,
  sanitizeHeaderField,
} from "../../protocol/feishu.js";
import type { FeishuAdmission, FeishuIdentityContext, FeishuInstallation } from "./admission.js";
import type { FeishuNonce, FeishuState } from "./state.js";

export interface FeishuMessage {
  eventId: string;
  senderOpenId: string;
  senderDisplay: string;
  senderType: string;
  tenantKey: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatLabel: string;
  threadId?: string;
  createdAt: number | undefined;
  messageType: string;
  content: Record<string, unknown>;
  text: string;
  mentions: Array<{ key: string; openId?: string; unionId?: string }>;
}
export interface FeishuCallback {
  eventId: string;
  senderOpenId: string;
  tenantKey: string;
  chatId: string;
  messageId: string;
  nonce: string;
  /** Dialog form/select data, never authority or log fields; F8 validates its own schema. */
  action: Readonly<Record<string, unknown>>;
  createdAt: number | undefined;
}
export type FeishuInboundIntent =
  | {
      type: "approval-request";
      ownerOpenId: string;
      senderOpenId: string;
      senderDisplay: string;
      installGen: number;
      tenantKey: string;
    }
  | {
      type: "action";
      record: FeishuNonce;
      identity: FeishuIdentityContext;
      eventId: string;
      action: Readonly<Record<string, unknown>>;
    }
  | { type: "approval-decided"; senderOpenId: string; allowed: boolean; messageId: string };
export interface FeishuPreparedInbound {
  /** Silent/no-effect result, e.g. revocation during asynchronous file staging. */
  drop?: true;
  /** Called ONLY after payload+dedup commit true. Must not throw or start unowned promises. */
  durable?(): void;
}
export interface FeishuInboundDeps {
  state: FeishuState;
  installation(): FeishuInstallation | undefined;
  admission: Pick<FeishuAdmission, "callback" | "authorize">;
  allowGroups: boolean;
  staleMessageS: number;
  now(): number;
  /** May stage+pin uploads asynchronously, but must NOT execute commands/send cards before durable(). */
  prepare(
    message: FeishuMessage,
    identity: FeishuIdentityContext,
  ): FeishuPreparedInbound | Promise<FeishuPreparedInbound>;
  emit(intent: FeishuInboundIntent): void;
  onHealth?(event: {
    degraded: true;
    reason: "undecodable-events" | "pending-expired" | "pending-full" | "persist-failed" | "background-failed";
    eventType?: string;
    code?: string;
    messageType?: string;
  }): void;
  audit?(record: {
    eventType: string;
    senderHash?: string;
    chatType?: string;
    messageId?: string;
    messageType?: string;
    reason: string;
  }): void;
}
export type FeishuInboundResult = { ack: boolean; reason: string };
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown, max = 256): v is string =>
  typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const tenant = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const eventId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);

/** Structural bounds for post rich text (the raw payload is already bounded by chunk transport caps). */
export const FEISHU_POST_LIMITS = { locales: 16, paragraphs: 256, tags: 256, textBytes: 64 * 1024 } as const;
const POST_LOCALE_PREFERENCE: readonly string[] = ["zh_cn", "zh-CN", "en_us", "en-US"];

/**
 * message_type "post" content (`{<locale>: {title?, content: [[tag…]]}}`) → plain text; `undefined` = malformed
 * (caller drops content-invalid), never throws. Extraction rules:
 * - locale: first of zh_cn/zh-CN/en_us/en-US present, else the first remaining locale key (≤16 keys scanned);
 *   a present-but-malformed preferred locale is a drop, never a silent fall-through;
 * - `title`, when a non-empty string, becomes the first line (one blank line before the body);
 * - paragraphs join with "\n"; tags inside a paragraph concatenate directly; empty paragraphs are dropped;
 * - `text` → its text (required string); `a` → display text, else href, else `text (href)` when both differ;
 * - `at`/`img`/`media`/`emotion`/unknown tags contribute NOTHING (mention keys are stripped by the caller,
 *   exactly like text messages; files/images are extracted separately by files.ts);
 * - consequence: a post with a non-empty title can never start with a `/command`, same as any leading text.
 */
export function feishuPostText(content: Record<string, unknown>): string | undefined {
  const keys = Object.keys(content).slice(0, FEISHU_POST_LIMITS.locales);
  const ordered = [
    ...POST_LOCALE_PREFERENCE.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !POST_LOCALE_PREFERENCE.includes(k)),
  ];
  const boundedText = (v: unknown): v is string =>
    typeof v === "string" && Buffer.byteLength(v) <= FEISHU_POST_LIMITS.textBytes;
  for (const key of ordered) {
    const locale = rec(content[key]);
    if (locale === undefined) continue;
    const title = locale["title"],
      paragraphs = locale["content"];
    if (title !== undefined && !boundedText(title)) return undefined;
    if (!Array.isArray(paragraphs) || paragraphs.length > FEISHU_POST_LIMITS.paragraphs) return undefined;
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph) || paragraph.length > FEISHU_POST_LIMITS.tags) return undefined;
      let line = "";
      for (const value of paragraph) {
        const tag = rec(value);
        if (tag === undefined || typeof tag["tag"] !== "string") return undefined;
        if (tag["tag"] === "text") {
          if (!boundedText(tag["text"])) return undefined;
          line += tag["text"];
        } else if (tag["tag"] === "a") {
          if (
            (tag["text"] !== undefined && !boundedText(tag["text"])) ||
            (tag["href"] !== undefined && !boundedText(tag["href"]))
          )
            return undefined;
          const text = typeof tag["text"] === "string" ? tag["text"] : "",
            href = typeof tag["href"] === "string" ? tag["href"] : "";
          line += text !== "" && href !== "" && text !== href ? `${text} (${href})` : text || href;
        }
      }
      if (line !== "") lines.push(line);
    }
    const body = lines.join("\n");
    const head = typeof title === "string" && title.trim() !== "" ? title : "";
    return [head, body].filter((s) => s !== "").join("\n\n");
  }
  return undefined;
}

export type FeishuDecodedEvent =
  | { kind: "message"; message: FeishuMessage }
  | { kind: "callback"; callback: FeishuCallback }
  | {
      kind: "drop";
      reason: string;
      /** Allowlist-mapped type for the PERSISTED undecodable ring (unsubscribed types stay "unknown"). */
      eventType: string;
      /** Sanitized printable-ASCII header event_type (≤80 chars) for logs/diagnostics, never persisted. */
      diagType: string;
      /** Sanitized message_type (≤40 chars) when the envelope carried one; never content values. */
      messageType?: string;
    };
/**
 * Drop reasons that may page the owner (debounced per reason by F8). `unsupported-event`
 * (a type we never subscribed to) and `stale` (expected redelivery after a restart) are
 * deliberately absent: they are counted/logged only.
 */
export const FEISHU_UNDECODABLE_NOTIFY_REASONS: readonly string[] = [
  "envelope-invalid",
  "message-invalid",
  "content-invalid",
  "mentions-invalid",
  "callback-invalid",
  "app-mismatch",
  "tenant-invalid",
  "tenant-mismatch",
];
/** Never trusts user_id (probe: null), action.target, or an origin supplied in the payload. */
export function decodeFeishuEvent(raw: unknown, appId: string): FeishuDecodedEvent {
  const root = rec(raw),
    header = rec(root?.["header"]),
    event = rec(root?.["event"]);
  const type = typeof header?.["event_type"] === "string" ? header["event_type"].slice(0, 80) : "unknown";
  const diagType = /^[\x21-\x7e]{1,80}$/.test(type) ? type : "unknown";
  const drop = (reason: string, messageType?: string): FeishuDecodedEvent => ({
    kind: "drop",
    reason,
    eventType: ["im.message.receive_v1", "card.action.trigger", "im.chat.member.bot.added_v1"].includes(type)
      ? type
      : "unknown",
    diagType,
    ...(messageType !== undefined ? { messageType } : {}),
  });
  if (root?.["schema"] !== "2.0" || !header || !event || !eventId(header["event_id"])) return drop("envelope-invalid");
  if (header["app_id"] !== appId) return drop("app-mismatch");
  const tenantKey = header["tenant_key"];
  if (!tenant(tenantKey)) return drop("tenant-invalid");
  // Optional evidence is never ignored when supplied, even on an otherwise unsupported event.
  for (const r of [event, rec(event["sender"]), rec(event["operator"])]) {
    if (r?.["tenant_key"] !== undefined && r["tenant_key"] !== tenantKey) return drop("tenant-mismatch");
    if (r?.["app_id"] !== undefined && r["app_id"] !== appId) return drop("app-mismatch");
  }
  if (type === "im.message.receive_v1") {
    const sender = rec(event["sender"]),
      senderId = rec(sender?.["sender_id"]),
      message = rec(event["message"]);
    const rawMessageType = message?.["message_type"];
    const messageType = str(rawMessageType, 40) ? rawMessageType : undefined;
    const dropMessage = (reason: string): FeishuDecodedEvent => drop(reason, messageType);
    const openId = senderId?.["open_id"];
    if (
      typeof openId !== "string" ||
      !FEISHU_OPEN_ID_RE.test(openId) ||
      !message ||
      !str(sender?.["sender_type"]) ||
      !eventId(message["message_id"]) ||
      !str(message["chat_id"]) ||
      (message["chat_type"] !== "p2p" && message["chat_type"] !== "group") ||
      !str(message["message_type"])
    )
      return dropMessage("message-invalid");
    if (message["thread_id"] !== undefined && !str(message["thread_id"])) return dropMessage("message-invalid");
    let content = rec(message["content"]);
    if (typeof message["content"] === "string") {
      try {
        content = rec(JSON.parse(message["content"]));
      } catch {
        return dropMessage("content-invalid");
      }
    }
    if (!content) return dropMessage("content-invalid");
    if (message["message_type"] === "text" && typeof content["text"] !== "string")
      return dropMessage("content-invalid");
    const mentions: FeishuMessage["mentions"] = [];
    if (message["mentions"] !== undefined) {
      if (!Array.isArray(message["mentions"]) || message["mentions"].length > 256)
        return dropMessage("mentions-invalid");
      for (const value of message["mentions"]) {
        const m = rec(value),
          id = rec(m?.["id"]);
        if (!str(m?.["key"])) return dropMessage("mentions-invalid");
        mentions.push({
          key: m["key"],
          ...(typeof id?.["open_id"] === "string" ? { openId: id["open_id"] } : {}),
          ...(typeof id?.["union_id"] === "string" ? { unionId: id["union_id"] } : {}),
        });
      }
    }
    let text: string;
    if (message["message_type"] === "post") {
      const extracted = feishuPostText(content);
      if (extracted === undefined) return dropMessage("content-invalid");
      text = extracted;
    } else text = typeof content["text"] === "string" ? content["text"] : "";
    for (const m of mentions) text = text.split(m.key).join("");
    text = text.replace(/@_user_\d+/g, "");
    if (mentions.length > 0) text = text.trim();
    return {
      kind: "message",
      message: {
        eventId: header["event_id"],
        senderOpenId: openId,
        senderDisplay: sanitizeHeaderField(sender["name"] ?? openId),
        senderType: sender["sender_type"] as string,
        tenantKey,
        messageId: message["message_id"],
        chatId: message["chat_id"],
        chatType: message["chat_type"],
        chatLabel: message["chat_type"] === "p2p" ? "私聊" : "群聊",
        ...(typeof message["thread_id"] === "string" ? { threadId: message["thread_id"] } : {}),
        createdAt: normalizeCreateTimeMs(message["create_time"]),
        messageType: message["message_type"],
        content,
        text,
        mentions,
      },
    };
  }
  if (type === "card.action.trigger") {
    const operator = rec(event["operator"]),
      context = rec(event["context"]),
      action = rec(event["action"]),
      value = rec(action?.["value"]);
    const openId = operator?.["open_id"];
    if (
      typeof openId !== "string" ||
      !FEISHU_OPEN_ID_RE.test(openId) ||
      event["host"] !== "im_message" ||
      !str(context?.["open_chat_id"]) ||
      !str(context?.["open_message_id"]) ||
      !action ||
      !value ||
      Object.keys(value).length !== 1 ||
      typeof value["n"] !== "string" ||
      !FEISHU_NONCE_RE.test(value["n"])
    )
      return drop("callback-invalid");
    return {
      kind: "callback",
      callback: {
        eventId: header["event_id"],
        senderOpenId: openId,
        tenantKey,
        chatId: context["open_chat_id"],
        messageId: context["open_message_id"],
        nonce: value["n"],
        action,
        createdAt: normalizeCreateTimeMs(header["create_time"]),
      },
    };
  }
  return drop("unsupported-event");
}
/** Effect-free delivery suppression is disposable bookkeeping, NEVER an admission gate. */
export const FEISHU_INBOUND_TRANSIENT = {
  dropMax: 1_024,
  dropTtlMs: 60_000,
  pendingMax: 256,
  pendingTtlMs: 60_000,
} as const;
export class FeishuDropCache {
  private readonly entries = new Map<string, number>();
  constructor(private readonly now: () => number) {}
  private sweep(): void {
    for (const [key, until] of this.entries) if (until <= this.now()) this.entries.delete(key);
  }
  has(key: string): boolean {
    this.sweep();
    return this.entries.has(key);
  }
  remember(key: string): void {
    this.sweep();
    this.entries.delete(key);
    if (this.entries.size >= FEISHU_INBOUND_TRANSIENT.dropMax) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, this.now() + FEISHU_INBOUND_TRANSIENT.dropTtlMs);
  }
  get size(): number {
    this.sweep();
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
}
export function createFeishuInbound(deps: FeishuInboundDeps) {
  const inflight = new Map<string, Promise<FeishuInboundResult>>();
  const state = deps.state;
  const pending = new Map<string, { keys: string[]; expiresAt: number; run(): void }>();
  const drops = new FeishuDropCache(deps.now);
  let disposed = false;
  function health(
    reason: "undecodable-events" | "pending-expired" | "pending-full" | "persist-failed" | "background-failed",
    eventType?: string,
    code?: string,
    messageType?: string,
  ): void {
    try {
      deps.onHealth?.({
        degraded: true,
        reason,
        ...(eventType ? { eventType } : {}),
        ...(code ? { code } : {}),
        ...(messageType ? { messageType } : {}),
      });
    } catch {
      /* Diagnostics must not block ACK or cleanup. */
    }
  }
  function sweepPending(): void {
    for (const entry of new Set(pending.values()))
      if (entry.expiresAt <= deps.now()) {
        for (const key of entry.keys) pending.delete(key);
        health("pending-expired");
      }
  }
  function firePending(keys: readonly string[]): void {
    sweepPending();
    const entry = keys.map((k) => pending.get(k)).find((e) => e !== undefined);
    if (entry === undefined) return;
    for (const key of entry.keys) pending.delete(key);
    try {
      entry.run();
    } catch {
      health("background-failed");
    }
  }
  function audit(
    eventType: string,
    reason: string,
    m?: { senderOpenId: string; messageId: string; chatType?: string },
    messageType?: string,
  ): void {
    deps.audit?.({
      eventType,
      reason,
      ...(messageType ? { messageType } : {}),
      ...(m
        ? {
            senderHash: createHash("sha256").update(m.senderOpenId).digest("hex").slice(0, 8),
            messageId: m.messageId,
            ...(m.chatType ? { chatType: m.chatType } : {}),
          }
        : {}),
    });
  }
  async function handle(raw: unknown): Promise<FeishuInboundResult> {
    sweepPending();
    const install = deps.installation();
    if (disposed || !install?.active || !state.connectorMayStart() || state.persistFailed())
      return { ack: false, reason: "unavailable" };
    const decoded = decodeFeishuEvent(raw, install.appId);
    if (decoded.kind === "drop") {
      // unsupported-event / stale are expected noise (unsubscribed types, post-restart redelivery):
      // they never record undecodable evidence and never page the owner — F8 counts/logs them.
      if (FEISHU_UNDECODABLE_NOTIFY_REASONS.includes(decoded.reason)) {
        state.undecodable.record({ reason: `${decoded.eventType}:${decoded.reason}`.slice(0, 64) });
        health("undecodable-events", decoded.diagType, decoded.reason, decoded.messageType);
      }
      audit(decoded.diagType, decoded.reason, undefined, decoded.messageType);
      return { ack: await state.commit(), reason: decoded.reason };
    }
    const m = decoded.kind === "message" ? decoded.message : decoded.callback;
    const type = decoded.kind === "message" ? "im.message.receive_v1" : "card.action.trigger";
    const keys = [
      state.dedup.keyFor("event", m.eventId),
      ...(decoded.kind === "message" ? [state.dedup.keyFor("message", m.messageId)] : []),
    ];
    if (keys.some((k) => k === undefined)) return { ack: false, reason: "dedup-invalid" };
    const pinned = state.tenant.get();
    if (pinned !== undefined && pinned !== m.tenantKey) {
      audit(type, "tenant-mismatch", m);
      return { ack: await state.commit(), reason: "tenant-mismatch" };
    }
    if (pinned === undefined) {
      if (
        m.senderOpenId !== install.ownerOpenId ||
        (decoded.kind === "message" && decoded.message.senderType !== "user")
      )
        return { ack: await state.commit(), reason: "tenant-unpinned" };
      if (!["pinned", "same"].includes(state.tenant.pin(m.tenantKey)))
        return { ack: false, reason: "tenant-pin-failed" };
    }
    if (keys.some((k) => state.dedup.has(k!))) {
      const ack = await state.commit();
      if (ack) firePending(keys as string[]);
      return { ack, reason: "duplicate" };
    }
    const dropKey = JSON.stringify([install.gen, m.tenantKey, m.senderOpenId, ...keys]);
    const addressed =
      decoded.kind === "message" &&
      decoded.message.senderType === "user" &&
      (decoded.message.chatType === "p2p" ||
        (deps.allowGroups &&
          decoded.message.mentions.some(
            (x) =>
              (install.botOpenId !== undefined && x.openId === install.botOpenId) ||
              (install.botUnionId !== undefined && x.unionId === install.botUnionId),
          )));
    // Only consult disposable suppression AFTER current authorization/addressing classification.
    // Allowing this sender later immediately bypasses its old stranger/drop cache entries.
    const effectFreeCandidate =
      decoded.kind === "message"
        ? !addressed || !state.allowList.has(m.senderOpenId)
        : !state.allowList.has(m.senderOpenId);
    if (effectFreeCandidate && drops.has(dropKey)) return { ack: await state.commit(), reason: "duplicate-drop" };
    const ctx = { installGen: install.gen, tenantKey: m.tenantKey, senderOpenId: m.senderOpenId };
    const intents: FeishuInboundIntent[] = [];
    let prepared: FeishuPreparedInbound | undefined;
    let reason = "received";
    let durableDedup = false;
    if (m.createdAt === undefined || deps.now() - m.createdAt > deps.staleMessageS * 1_000) {
      // Stale after downtime/redelivery is expected: ACK, count and audit-log only — never a chat notice.
      reason = "stale";
    } else if (decoded.kind === "message") {
      const msg = decoded.message;
      const mentioned = msg.mentions.some(
        (x) =>
          (x.openId === install.botOpenId && install.botOpenId !== undefined) ||
          (x.unionId === install.botUnionId && install.botUnionId !== undefined),
      );
      if (msg.senderType !== "user") reason = "sender-not-user";
      else if (msg.chatType === "group" && (!deps.allowGroups || !mentioned)) reason = "group-not-addressed";
      else if (!state.allowList.has(msg.senderOpenId)) {
        reason = "stranger";
        const asked = state.approvals.ask(msg.senderOpenId, msg.senderDisplay);
        if (asked.ok)
          intents.push({
            type: "approval-request",
            ownerOpenId: install.ownerOpenId,
            senderOpenId: msg.senderOpenId,
            senderDisplay: msg.senderDisplay,
            installGen: install.gen,
            tenantKey: msg.tenantKey,
          });
      } else {
        prepared = await deps.prepare(msg, ctx);
        if (prepared.drop || !state.allowList.has(msg.senderOpenId)) {
          prepared = undefined;
          reason = "sender-denied";
        } else durableDedup = true;
      }
    } else {
      const cb = decoded.callback;
      const admitted = deps.admission.callback(ctx);
      if (!admitted.ok) reason = admitted.code;
      else {
        const redeemed = state.nonces.redeem({
          nonce: cb.nonce,
          operatorOpenId: cb.senderOpenId,
          chatId: cb.chatId,
          messageId: cb.messageId,
          tenantKey: cb.tenantKey,
          installGen: install.gen,
        });
        if (!redeemed.ok) reason = `nonce-${redeemed.reason}`;
        else if (redeemed.record.action === "approval-allow" || redeemed.record.action === "approval-ignore") {
          durableDedup = true;
          const approval = state.approvals.get(redeemed.record.target);
          // A nonce is not authority: re-read the live owner, approval TTL, and allow-list cap.
          if (
            deps.installation()?.ownerOpenId !== cb.senderOpenId ||
            approval?.state !== "pending" ||
            approval.expiresAt <= deps.now()
          )
            reason = "approval-invalid";
          else {
            const allow = redeemed.record.action === "approval-allow";
            const added = allow ? state.allowList.add(approval.senderOpenId) : { ok: true };
            if (!added.ok) reason = "allow-list-full";
            else {
              // Retain the closed throttle marker for the full 24h even after Allow.
              // The live allowList, not the marker name, is the source of authorization.
              state.approvals.resolve(approval.senderOpenId, "ignored");
              intents.push({
                type: "approval-decided",
                senderOpenId: approval.senderOpenId,
                allowed: allow,
                messageId: cb.messageId,
              });
            }
          }
        } else {
          durableDedup = true;
          intents.push({
            type: "action",
            record: redeemed.record,
            identity: ctx,
            eventId: cb.eventId,
            action: cb.action,
          });
        }
      }
    }
    // prepare may have staged files; authorization is rechecked before any deferred effects.
    if (deps.installation()?.gen !== install.gen || !deps.installation()?.active)
      return { ack: false, reason: "installation-changed" };
    const deferred = {
      keys: keys as string[],
      expiresAt: deps.now() + FEISHU_INBOUND_TRANSIENT.pendingTtlMs,
      run() {
        if (disposed || deps.installation()?.gen !== install.gen || !deps.installation()?.active) return;
        for (const intent of intents) deps.emit(intent);
        prepared?.durable?.();
      },
    };
    if (intents.length > 0 || prepared?.durable !== undefined) {
      if (
        !keys.some((key) => pending.has(key!)) &&
        new Set(pending.values()).size >= FEISHU_INBOUND_TRANSIENT.pendingMax
      ) {
        health("pending-full");
        return { ack: false, reason: "pending-full" };
      }
      if (!keys.some((key) => pending.has(key!))) for (const key of keys) pending.set(key!, deferred);
    }
    if (durableDedup)
      for (const key of keys) if (!state.dedup.add(key!).ok) return { ack: false, reason: "dedup-full" };
    const committed = await state.commit();
    if (!committed) {
      health("persist-failed");
      return { ack: false, reason: "persist-failed" };
    }
    firePending(keys as string[]);
    if (!durableDedup) drops.remember(dropKey);
    audit(type, reason, m, decoded.kind === "message" ? decoded.message.messageType : undefined);
    return { ack: true, reason };
  }
  return {
    handle(raw: unknown): Promise<FeishuInboundResult> {
      const root = rec(raw),
        header = rec(root?.["header"]),
        event = rec(root?.["event"]),
        message = rec(event?.["message"]);
      // Coalesce in-flight copies BEFORE any async staging; no duplicate can ACK half a payload.
      const prefix = JSON.stringify([
        header?.["app_id"],
        header?.["tenant_key"],
        rec(event?.["sender"])?.["sender_type"],
      ]);
      const key = eventId(message?.["message_id"])
        ? `${prefix}:m:${message["message_id"]}`
        : eventId(header?.["event_id"])
          ? `${prefix}:e:${header["event_id"]}`
          : undefined;
      const decoded = decodeFeishuEvent(raw, deps.installation()?.appId ?? "");
      const track =
        decoded.kind === "message"
          ? decoded.message.senderType === "user" &&
            state.allowList.has(decoded.message.senderOpenId) &&
            (decoded.message.chatType === "p2p" ||
              (deps.allowGroups &&
                decoded.message.mentions.some(
                  (m) =>
                    (m.openId !== undefined && m.openId === deps.installation()?.botOpenId) ||
                    (m.unionId !== undefined && m.unionId === deps.installation()?.botUnionId),
                )))
          : decoded.kind === "callback" && state.allowList.has(decoded.callback.senderOpenId);
      if (track && key !== undefined && inflight.has(key)) return inflight.get(key)!;
      if (track && inflight.size >= FEISHU_CAPS.requestsNonTerminal)
        return Promise.resolve({ ack: false, reason: "inflight-full" });
      const p = handle(raw).catch((): FeishuInboundResult => {
        health("background-failed");
        return { ack: false, reason: "prepare-failed" };
      });
      if (track && key !== undefined) {
        inflight.set(key, p);
        void p
          .then(() => {
            inflight.delete(key);
          })
          .catch(() => {
            health("background-failed");
          });
      }
      return p;
    },
    /** F8 sends a button-less placeholder first; then calls this and PATCHes {n} buttons. */
    async attachApproval(input: {
      senderOpenId: string;
      chatId: string;
      messageId: string;
      installGen: number;
      tenantKey: string;
    }) {
      const install = deps.installation();
      const approval = state.approvals.get(input.senderOpenId);
      if (
        !install?.active ||
        install.gen !== input.installGen ||
        state.tenant.get() !== input.tenantKey ||
        approval?.state !== "pending" ||
        approval.expiresAt <= deps.now()
      )
        return { ok: false as const, code: "approval-invalid" };
      if (approval.cardMessageId !== undefined) {
        const allow = approval.nonce ? state.nonces.get(approval.nonce) : undefined;
        const ignore = approval.ignoreNonce ? state.nonces.get(approval.ignoreNonce) : undefined;
        const matches = (n: FeishuNonce | undefined, action: string) =>
          n !== undefined &&
          n.action === action &&
          n.target === input.senderOpenId &&
          n.installGen === install.gen &&
          n.operatorOpenId === install.ownerOpenId &&
          n.tenantKey === input.tenantKey &&
          n.chatId === input.chatId &&
          n.messageId === input.messageId &&
          n.expiresAt > deps.now();
        if (
          approval.cardMessageId !== input.messageId ||
          !matches(allow, "approval-allow") ||
          !matches(ignore, "approval-ignore")
        )
          return { ok: false as const, code: "approval-attached" };
        if (!(await state.commit())) return { ok: false as const, code: "persist-failed" };
        if (deps.installation()?.gen !== install.gen || !deps.installation()?.active)
          return { ok: false as const, code: "installation-changed" };
        return { ok: true as const, allow: { n: allow!.nonce }, ignore: { n: ignore!.nonce } };
      }
      const base = {
        installGen: install.gen,
        tenantKey: input.tenantKey,
        operatorOpenId: install.ownerOpenId,
        chatId: input.chatId,
        messageId: input.messageId,
        target: input.senderOpenId,
      };
      const allow = state.nonces.issue({ ...base, action: "approval-allow" }, approval.expiresAt - deps.now());
      const ignore = state.nonces.issue({ ...base, action: "approval-ignore" }, approval.expiresAt - deps.now());
      if (!allow.ok || !ignore.ok) {
        // Neither orphan nonce is exposed by a failed attachment.
        for (const issued of [allow, ignore])
          if (issued.ok)
            state.nonces.redeem({
              nonce: issued.value.nonce,
              installGen: install.gen,
              tenantKey: input.tenantKey,
              operatorOpenId: install.ownerOpenId,
              chatId: input.chatId,
              messageId: input.messageId,
            });
        await state.commit();
        return { ok: false as const, code: "nonce-full" };
      }
      state.approvals.attach(input.senderOpenId, {
        nonce: allow.value.nonce,
        ignoreNonce: ignore.value.nonce,
        cardMessageId: input.messageId,
      });
      if (!(await state.commit())) return { ok: false as const, code: "persist-failed" };
      if (deps.installation()?.gen !== install.gen || !deps.installation()?.active)
        return { ok: false as const, code: "installation-changed" };
      return { ok: true as const, allow: { n: allow.value.nonce }, ignore: { n: ignore.value.nonce } };
    },
    stats() {
      sweepPending();
      return { pending: new Set(pending.values()).size, drops: drops.size, inflight: inflight.size };
    },
    dispose() {
      disposed = true;
      inflight.clear();
      pending.clear();
      drops.clear();
    },
  };
}
export type FeishuInbound = ReturnType<typeof createFeishuInbound>;
