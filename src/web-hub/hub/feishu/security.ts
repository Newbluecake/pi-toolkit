/**
 * LAN security r2 §4.3 + §5.7 (package E): Feishu-side high-risk alerts and the Feishu login
 * approval port.
 *
 * - `createNoticeBudget` (#14) is the per-runtime shared notice budget extracted verbatim from
 *   `notify.ts`'s `reserve` — notify and security share ONE instance so the global 20/min cap
 *   and the 1024-key gap map are truly shared.
 * - `createFeishuSecurity` subscribes the hub `SecurityEventBus` and turns events into bounded,
 *   coalesced, cooldown-deduped owner notices. All state is closure-local; every timer runs on
 *   the injected clock (unref'd in production); `dispose()` unsubscribes and clears everything.
 * - `createLoginApprovalPort` implements the frozen `LoginApprovalPort` + the §5.7 fence, the
 *   sibling-nonce callback and the card caps. No module-scope mutable state.
 */
import { createHash, randomBytes } from "node:crypto";
import type { LoginApprovalPort, LoginApprovalCloseReason } from "../ports.js";
import type { SecurityEvent, SecurityEventBus } from "../security-events.js";
import type { FeishuClock } from "./http.js";
import type { FeishuState } from "./state.js";
import type { FeishuNotifyDeps } from "./notify.js";
import { renderNotice } from "./render.js";
import { bounded } from "./runtime.js";
import { FEISHU_NOTIFY_LIMITS } from "../../protocol/feishu.js";
import { LAN_2FA_LIMITS } from "../../protocol/lan-2fa.js";

// ---------------------------------------------------------------------------
// shared notice budget (#14)
// ---------------------------------------------------------------------------

/**
 * F1 (§7.3): admission lanes over the ONE shared per-minute cap G (`FEISHU_NOTIFY_LIMITS.globalPerMin`).
 * `critical` (security alerts, 2FA / approvals) and `normal` (done / failed / owner notices — the default)
 * may each use all of G; `schedule` must leave {@link CRITICAL_RESERVE_PER_MIN} spare and may take at most
 * `max(1, G − reserve − 2)` per minute, so a scheduled-task flood can never starve the other lanes.
 */
export type NoticeLane = "critical" | "normal" | "schedule";
export const CRITICAL_RESERVE_PER_MIN = 5;
export interface NoticeBudget {
  /** `opts` absent ⇒ lane "normal": byte-identical to the legacy two-argument interface. */
  reserve(key: string, gapMs: number, opts?: { lane?: NoticeLane }): boolean;
  /** Spare global quota left in the current minute window (read-only; visibility and tests). */
  remaining(): number;
  dispose(): void;
}

/** E extracts notify.ts's existing reserve into this shared factory, one per runtime. */
export function createNoticeBudget(clock: Pick<FeishuClock, "now">): NoticeBudget {
  const last = new Map<string, number>();
  let windowAt = clock.now();
  let count = 0;
  let scheduleCount = 0;
  let disposed = false;
  const G = FEISHU_NOTIFY_LIMITS.globalPerMin;
  const roll = (): void => {
    const now = clock.now();
    if (now - windowAt >= 60_000) {
      windowAt = now;
      count = 0;
      scheduleCount = 0;
    }
  };
  return {
    remaining() {
      if (disposed) return 0;
      roll();
      return Math.max(0, G - count);
    },
    reserve(key, gapMs, opts) {
      if (disposed) return false;
      const now = clock.now();
      roll();
      if (count >= G) return false;
      const lane = opts?.lane;
      if (lane === "schedule") {
        if (G - (count + 1) < CRITICAL_RESERVE_PER_MIN) return false;
        if (scheduleCount >= Math.max(1, G - CRITICAL_RESERVE_PER_MIN - 2)) return false;
      }
      // Only gap-gated keys occupy the 1024-slot dedup map; a burst of unique gap-0 keys must
      // never starve a gap-gated key out of a slot. Every admitted reserve still counts toward
      // the global per-minute limit below.
      if (gapMs > 0) {
        if (now - (last.get(key) ?? -Infinity) < gapMs) return false;
        if (!last.has(key) && last.size >= 1_024) return false;
        last.set(key, now);
      }
      count++;
      if (lane === "schedule") scheduleCount++;
      return true;
    },
    dispose() {
      disposed = true;
      last.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// security notifier (§4.3)
// ---------------------------------------------------------------------------

export interface FeishuSecurityDeps {
  security: SecurityEventBus;
  clock: FeishuClock;
  owner(): string | undefined;
  budget: NoticeBudget;
  send: FeishuNotifyDeps["send"];
}

export interface FeishuSecurity {
  onEvent(event: SecurityEvent): void;
  dispose(): void;
}

/** Exposed so tests can observe the bounded, dropped counters without widening the frozen surface. */
export interface FeishuSecurityStats {
  pending: number;
  dropped: number;
}

const SECURITY_COALESCE_MS = 5_000;
const SECURITY_MAX_KEYS = 128;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** Per-kind cooldowns (plan §4.3 table). `0` ⇒ every event sends its own unique-key message. */
const COOLDOWNS: Readonly<Record<string, number>> = {
  spawn: 10 * MINUTE_MS,
  proxy: 30 * MINUTE_MS,
  "login-success": DAY_MS,
  lockout: 15 * MINUTE_MS,
  burst: HOUR_MS,
  tightened: HOUR_MS,
  saturated: HOUR_MS,
  allowlist: HOUR_MS,
  challenge: 0,
  denied: 0,
  recovery: 0,
  "2fa": 0,
  passwd: 0,
};

const SPAWN_MODE_LABEL: Readonly<Record<"new" | "resume" | "fork" | "relaunch", string>> = {
  new: "新建",
  resume: "恢复",
  fork: "派生",
  relaunch: "重启",
};

const LOGIN_METHOD_LABEL: Readonly<Record<string, string>> = {
  password: "密码",
  totp: "TOTP",
  recovery: "恢复码",
  feishu: "飞书审批",
};

/** Classify an event into its alert kind / discriminator / cooldown; `undefined` ⇒ not alerted. */
function classify(event: SecurityEvent): { kind: string; disc: string; cooldown: number; text: string } | undefined {
  switch (event.type) {
    case "lan-spawn": {
      const dir = event.dirTail !== undefined ? `，目录 ${event.dirTail}` : "";
      return {
        kind: "spawn",
        disc: event.ip,
        cooldown: COOLDOWNS["spawn"]!,
        text: `检测到局域网会话${SPAWN_MODE_LABEL[event.mode]}：${event.ip}${dir}`,
      };
    }
    case "proxy-open":
      return {
        kind: "proxy",
        disc: `${event.host}:${event.port}`,
        cooldown: COOLDOWNS["proxy"]!,
        text: `局域网代理已开启：${event.host}:${event.port}（来源 ${event.ip}）`,
      };
    case "login-success":
      if (!event.newIp) return undefined; // a known-IP login is not a high-risk alert
      return {
        kind: "login-success",
        disc: event.ip,
        cooldown: COOLDOWNS["login-success"]!,
        text: `检测到新 IP 登录：${event.ip}，方式 ${LOGIN_METHOD_LABEL[event.method] ?? event.method}，设备 ${event.device}`,
      };
    case "login-2fa-challenge":
      if (event.cardSent) return undefined; // the card is the alert
      return {
        kind: "challenge",
        disc: event.ip,
        cooldown: COOLDOWNS["challenge"]!,
        text: `需要二次验证：${event.ip}（设备 ${event.device}）`,
      };
    case "login-2fa-denied":
      return { kind: "denied", disc: event.ip, cooldown: COOLDOWNS["denied"]!, text: `二次验证被拒绝：${event.ip}` };
    case "login-2fa-burst":
      return {
        kind: "burst",
        disc: event.kind,
        cooldown: COOLDOWNS["burst"]!,
        text: `验证尝试过于频繁（${event.kind === "totp" ? "TOTP" : "恢复码"}）`,
      };
    case "recovery-used":
      return {
        kind: "recovery",
        disc: "",
        cooldown: COOLDOWNS["recovery"]!,
        text: `恢复码已被使用，剩余 ${event.left} 个`,
      };
    case "2fa-changed":
      return { kind: "2fa", disc: event.op, cooldown: COOLDOWNS["2fa"]!, text: `两步验证配置已变更（${event.op}）` };
    case "passwd":
      return { kind: "passwd", disc: "", cooldown: COOLDOWNS["passwd"]!, text: "局域网登录密码已修改" };
    case "login-lockout":
      return {
        kind: "lockout",
        disc: event.ip,
        cooldown: COOLDOWNS["lockout"]!,
        text: `登录已锁定：${event.ip}（连续 ${event.failures} 次失败，锁定 ${Math.round(event.lockMs / 1000)} 秒）`,
      };
    case "login-tightened":
      return { kind: "tightened", disc: "", cooldown: COOLDOWNS["tightened"]!, text: "登录失败过多，安全策略已收紧" };
    case "login-saturated":
      return { kind: "saturated", disc: "", cooldown: COOLDOWNS["saturated"]!, text: "登录限流器已饱和" };
    case "allowlist-burst":
      return {
        kind: "allowlist",
        disc: "",
        cooldown: COOLDOWNS["allowlist"]!,
        text: `客户端访问被拒绝 ${event.count} 次（最后 ${event.lastIp}）`,
      };
  }
}

/** `hash12(disc)`: a stable, non-leaking key component for the outbox dedup key. */
function hash12(disc: string): string {
  return createHash("sha256").update(disc).digest("base64url").slice(0, 12);
}

interface PendingEntry {
  kind: string;
  disc: string;
  cooldown: number;
  count: number;
  baseText: string;
  firstAt: number;
  /** number of events already reported (initial flush included) */
  sentCount: number;
  /** coalesce timer, then the cooldown-end aggregate timer (never both at once) */
  timer: unknown;
}

export function createFeishuSecurity(deps: FeishuSecurityDeps): FeishuSecurity & { stats(): FeishuSecurityStats } {
  const { clock, budget } = deps;
  const pending = new Map<string, PendingEntry>();
  let disposed = false;
  let dropped = 0;
  let seq = 0;

  const unsubscribe = deps.security.subscribe((event) => onEvent(event));

  function computeKey(kind: string, disc: string, cooldown: number, now: number): string {
    if (cooldown > 0) return `sec-${kind}-${hash12(disc)}-${Math.floor(now / cooldown)}`;
    return `sec-${kind}-${seq++}-${randomBytes(6).toString("base64url")}`;
  }

  function sendNow(entry: PendingEntry, text: string, key: string): boolean {
    const owner = deps.owner();
    if (owner === undefined) return false;
    if (!budget.reserve(key, 0, { lane: "critical" })) {
      dropped++;
      return false;
    }
    void Promise.resolve(
      deps.send({
        target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: owner },
        message: renderNotice({ label: "security", text }),
        key,
        laneKey: owner,
      }),
    ).catch(() => {
      /* a failed send is the outbox's own concern; never block the notifier */
    });
    return true;
  }

  function flushInitial(entry: PendingEntry, mapKey: string): void {
    entry.timer = undefined;
    const total = entry.count;
    const suffix = total > 1 ? `（${total} 次）` : "";
    const sent = sendNow(
      entry,
      `${entry.baseText}${suffix}`,
      computeKey(entry.kind, entry.disc, entry.cooldown, entry.firstAt),
    );
    if (sent) entry.sentCount = total;
    if (entry.cooldown > 0) {
      const window = Math.floor(entry.firstAt / entry.cooldown);
      const end = (window + 1) * entry.cooldown;
      entry.timer = clock.setTimeout(() => flushAggregate(entry, mapKey), Math.max(0, end - clock.now()));
    } else {
      pending.delete(mapKey);
    }
  }

  function flushAggregate(entry: PendingEntry, mapKey: string): void {
    entry.timer = undefined;
    const delta = entry.count - entry.sentCount;
    if (delta > 0) {
      const suffix = `（另有 ${delta} 次）`;
      sendNow(entry, `${entry.baseText}${suffix}`, computeKey(entry.kind, entry.disc, entry.cooldown, clock.now()));
    }
    pending.delete(mapKey);
  }

  function onEvent(event: SecurityEvent): void {
    if (disposed) return;
    if (deps.owner() === undefined) return;
    const parsed = classify(event);
    if (parsed === undefined) return;
    const mapKey = `${parsed.kind}\u0000${parsed.disc}`;
    const existing = pending.get(mapKey);
    if (existing !== undefined) {
      existing.count++;
      return; // the coalesce timer (or the cooldown-end aggregate timer) already owns the flush
    }
    if (pending.size >= SECURITY_MAX_KEYS) {
      dropped++;
      return;
    }
    const entry: PendingEntry = {
      kind: parsed.kind,
      disc: parsed.disc,
      cooldown: parsed.cooldown,
      count: 1,
      baseText: parsed.text,
      firstAt: clock.now(),
      sentCount: 0,
      timer: undefined,
    };
    pending.set(mapKey, entry);
    entry.timer = clock.setTimeout(() => flushInitial(entry, mapKey), SECURITY_COALESCE_MS);
  }

  return {
    onEvent,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [, entry] of pending) if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
      pending.clear();
    },
    stats() {
      return { pending: pending.size, dropped };
    },
  };
}

// ---------------------------------------------------------------------------
// Feishu login approval (§5.7)
// ---------------------------------------------------------------------------

export interface LoginApprovalDeps {
  state: FeishuState;
  clock: FeishuClock;
  /** Real work slot lives until sendCard settles (not the 5s logical timeout). */
  work: { run(task: () => Promise<unknown>): boolean };
  installation(): { gen: number; ownerOpenId: string; tenantKey: string } | undefined;
  sendCard(input: {
    owner: string;
    ip: string;
    device: string;
    user: string;
    expiresAt: number;
  }): Promise<{ chatId: string; messageId: string } | undefined>;
  patchCard(
    messageId: string,
    state: "pending" | "approved" | "denied" | "expired",
    nonces?: { approve: string; deny: string },
  ): Promise<unknown>;
  onDecision(challengeId: string, allowed: boolean, gen: number): void;
}

export interface FeishuLoginApproval extends LoginApprovalPort {
  /** Called only AFTER inbound's existing redeem chain; E rechecks install + owner + sibling. */
  onDecision(input: {
    challengeId: string;
    allowed: boolean;
    gen: number;
    operatorOpenId: string;
    installGen: number;
  }): void;
  dispose(): void;
}

/** The nonce `target` encodes both the challenge id and the challenge gen so the gen can round-trip. */
export function encodeApprovalTarget(challengeId: string, gen: number): string {
  return JSON.stringify({ c: challengeId, g: gen });
}

/** Parse the §5.7 nonce `target`; `undefined` on any malformed value (never throws). */
export function parseApprovalTarget(target: string): { challengeId: string; gen: number } | undefined {
  try {
    const v: unknown = JSON.parse(target);
    if (v !== null && typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (typeof r["c"] === "string" && typeof r["g"] === "number" && Number.isSafeInteger(r["g"])) {
        return { challengeId: r["c"], gen: r["g"] };
      }
    }
  } catch {
    /* malformed target is never authority */
  }
  return undefined;
}

const APPROVAL_MAX_ENTRIES = 64;
/** §5.7 per-IP card map hygiene: FIFO cap on distinct IPs (DoS bound); expired-IP keys are pruned. */
const APPROVAL_MAX_CARD_IPS = 256;

interface ApprovalEntry {
  challengeId: string;
  gen: number;
  ip: string;
  closed: boolean;
  messageId?: string;
  chatId?: string;
  nonces?: { approve: string; deny: string };
  expireTimer?: unknown;
  resolve?: (value: "sent" | "unavailable") => void;
}

export function createLoginApprovalPort(deps: LoginApprovalDeps): FeishuLoginApproval {
  const { state, clock } = deps;
  const entries = new Map<string, ApprovalEntry>();
  const cardAt: number[] = []; // global card timestamps (≤6 / 10 min)
  const cardAtByIp = new Map<string, number[]>(); // per-IP card timestamps (≤3 / 10 min)
  let disposed = false;

  function pruneCardTimestamps(list: number[], now: number, windowMs: number): number[] {
    const kept = list.filter((t) => now - t < windowMs);
    return kept.length === list.length ? list : kept;
  }

  /** §5.7 card map hygiene: drop IPs whose whole window lapsed, then FIFO-cap distinct IPs. */
  function pruneCardIps(now: number): void {
    for (const [ip, list] of cardAtByIp) {
      if (list.every((t) => now - t >= LAN_2FA_LIMITS.cardWindowMs)) cardAtByIp.delete(ip);
    }
    while (cardAtByIp.size > APPROVAL_MAX_CARD_IPS) {
      cardAtByIp.delete(cardAtByIp.keys().next().value!);
    }
  }

  /** §5.7 card caps: 1 per challenge, ≤3 per IP per 10 min, ≤6 global per 10 min. */
  function admitCard(challengeId: string, ip: string, now: number): boolean {
    if (entries.has(challengeId)) return false;
    pruneCardIps(now);
    const global = pruneCardTimestamps(cardAt, now, LAN_2FA_LIMITS.cardWindowMs);
    if (global.length >= LAN_2FA_LIMITS.cardsGlobal) return false;
    const perIp = pruneCardTimestamps(cardAtByIp.get(ip) ?? [], now, LAN_2FA_LIMITS.cardWindowMs);
    if (perIp.length >= LAN_2FA_LIMITS.cardsPerIp) return false;
    global.push(now);
    perIp.push(now);
    cardAt.length = 0;
    cardAt.push(...global);
    cardAtByIp.set(ip, perIp);
    return true;
  }

  /** Redeem a nonce by its record (no throw; the redeem already checks gen/tenant/chat/message). */
  function redeemNonce(nonce: string, entry: ApprovalEntry): void {
    if (entry.messageId === undefined || entry.chatId === undefined) return;
    const install = deps.installation();
    if (install === undefined) return;
    state.nonces.redeem({
      nonce,
      installGen: install.gen,
      tenantKey: install.tenantKey,
      operatorOpenId: install.ownerOpenId,
      chatId: entry.chatId,
      messageId: entry.messageId,
    });
  }

  function dropEntry(entry: ApprovalEntry): void {
    if (entry.expireTimer !== undefined) clock.clearTimeout(entry.expireTimer);
    entries.delete(entry.challengeId);
  }

  function patchCard(entry: ApprovalEntry, cardState: "pending" | "approved" | "denied" | "expired"): void {
    if (entry.messageId === undefined) return;
    void Promise.resolve(
      deps.patchCard(
        entry.messageId,
        cardState,
        cardState === "pending" && entry.nonces !== undefined ? entry.nonces : undefined,
      ),
    ).catch(() => {
      /* best-effort card patch */
    });
  }

  function close(challengeId: string, _why: LoginApprovalCloseReason): void {
    const entry = entries.get(challengeId);
    if (entry === undefined) return;
    entry.closed = true;
    if (entry.nonces !== undefined) {
      redeemNonce(entry.nonces.approve, entry);
      redeemNonce(entry.nonces.deny, entry);
      void state.commit().catch(() => false);
    }
    if (entry.messageId !== undefined) patchCard(entry, "expired");
    dropEntry(entry);
  }

  return {
    async request(c) {
      if (disposed) return "unavailable";
      const install = deps.installation();
      if (install === undefined) return "unavailable";
      const now = clock.now();
      if (!admitCard(c.challengeId, c.ip, now)) return "unavailable";
      if (entries.size >= APPROVAL_MAX_ENTRIES) return "unavailable";
      const entry: ApprovalEntry = { challengeId: c.challengeId, gen: c.gen, ip: c.ip, closed: false };
      entries.set(c.challengeId, entry);
      // Defensive expiry: the core drives `close()`, but a challenge the core never closes must
      // not leak an entry (or its card). Unref'd via the clock.
      entry.expireTimer = clock.setTimeout(
        () => close(c.challengeId, "expire"),
        Math.max(0, c.expiresAt - clock.now()),
      );
      const settled = new Promise<"sent" | "unavailable">((resolve) => {
        entry.resolve = resolve;
      });
      const accepted = deps.work.run(async () => {
        try {
          const card = await deps.sendCard({
            owner: install.ownerOpenId,
            ip: c.ip,
            device: c.device,
            user: c.user,
            expiresAt: c.expiresAt,
          });
          if (card !== undefined) {
            entry.messageId = card.messageId;
            entry.chatId = card.chatId;
          }
          // Late (5s fence fired) or a generation change: never issue nonces for a dead challenge.
          if (entry.closed || entry.gen !== c.gen || card === undefined) {
            if (entry.messageId !== undefined) patchCard(entry, "expired");
            if (entry.closed) return; // the fence already resolved "unavailable"
            entry.resolve?.("unavailable");
            dropEntry(entry);
            return;
          }
          const ttlMs = Math.max(0, c.expiresAt - clock.now());
          const base = {
            installGen: install.gen,
            tenantKey: install.tenantKey,
            operatorOpenId: install.ownerOpenId,
            chatId: card.chatId,
            messageId: card.messageId,
            target: encodeApprovalTarget(c.challengeId, c.gen),
          };
          const approve = state.nonces.issue({ ...base, action: "login-approve" }, ttlMs);
          const deny = state.nonces.issue({ ...base, action: "login-deny" }, ttlMs);
          if (!approve.ok || !deny.ok) {
            for (const issued of [approve, deny]) {
              if (issued.ok)
                state.nonces.redeem({
                  nonce: issued.value.nonce,
                  installGen: install.gen,
                  tenantKey: install.tenantKey,
                  operatorOpenId: install.ownerOpenId,
                  chatId: card.chatId,
                  messageId: card.messageId,
                });
            }
            void state.commit().catch(() => false);
            patchCard(entry, "expired");
            entry.closed = true;
            entry.resolve?.("unavailable");
            dropEntry(entry);
            return;
          }
          entry.nonces = { approve: approve.value.nonce, deny: deny.value.nonce };
          if (!(await state.commit())) {
            entry.closed = true;
            entry.resolve?.("unavailable");
            dropEntry(entry);
            return;
          }
          // Late arrival: the 5s fence fired (or the challenge was closed/re-generated) while
          // commit was in flight. Redeem both nonces, expire the card — never patch "pending".
          if (entry.closed || entry.gen !== c.gen) {
            redeemNonce(entry.nonces.approve, entry);
            redeemNonce(entry.nonces.deny, entry);
            void state.commit().catch(() => false);
            patchCard(entry, "expired");
            dropEntry(entry);
            return;
          }
          patchCard(entry, "pending");
          entry.resolve?.("sent");
        } catch {
          entry.closed = true;
          if (entry.nonces !== undefined) {
            redeemNonce(entry.nonces.approve, entry);
            redeemNonce(entry.nonces.deny, entry);
            void state.commit().catch(() => false);
          }
          entry.resolve?.("unavailable");
          dropEntry(entry);
        }
      });
      if (!accepted) {
        dropEntry(entry);
        return "unavailable";
      }
      let outcome: "sent" | "unavailable";
      try {
        outcome = await bounded(settled, LAN_2FA_LIMITS.approvalSendMs, clock);
      } catch {
        outcome = "unavailable";
      }
      if (outcome === "sent") {
        entry.closed = false; // the send settled in time; the entry stays open for the decision
        return "sent";
      }
      // Fence (#13): the logical 5s timeout fired (or the send failed). Mark closed so the late
      // sendCard — still holding its work slot — issues no nonces and patches 「已失效」 instead.
      entry.closed = true;
      return "unavailable";
    },

    close,

    onDecision(input) {
      const entry = entries.get(input.challengeId);
      if (entry === undefined || entry.closed) return; // ignored unless live
      const install = deps.installation();
      if (install === undefined || install.gen !== input.installGen || install.ownerOpenId !== input.operatorOpenId)
        return;
      if (entry.gen !== input.gen) return; // stale gen — never authorize a different challenge
      // Redeem the sibling (the clicked nonce was already consumed by inbound's redeem chain).
      if (entry.nonces !== undefined) redeemNonce(input.allowed ? entry.nonces.deny : entry.nonces.approve, entry);
      entry.closed = true;
      patchCard(entry, input.allowed ? "approved" : "denied");
      dropEntry(entry);
      deps.onDecision(input.challengeId, input.allowed, input.gen);
    },

    dispose() {
      disposed = true;
      for (const entry of [...entries.values()]) {
        entry.closed = true;
        if (entry.nonces !== undefined) {
          redeemNonce(entry.nonces.approve, entry);
          redeemNonce(entry.nonces.deny, entry);
        }
        if (entry.messageId !== undefined) patchCard(entry, "expired");
        dropEntry(entry);
      }
      cardAt.length = 0;
      cardAtByIp.clear();
    },
  };
}

export type { LoginApprovalPort, LoginApprovalCloseReason };
