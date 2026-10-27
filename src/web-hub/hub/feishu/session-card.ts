/**
 * `/list` one-click session-switch card (docs/dev/feishu-bot/session-card-plan.md r3 + gates G1–G4).
 * Pi-free. Authority is ALWAYS the server-side nonce record (the client only echoes `{n}`); the card is
 * reusable — a successful click consumes one button nonce and the controller re-issues exactly one.
 *
 * Invariants:
 * - **Anchor record**: each card owns one `action:"session-card"` nonce (never rendered); the card is
 *   open ⇔ the anchor exists and is unexpired. Anchor + all button nonces are committed (`barrier()`)
 *   BEFORE any button is PATCHed onto the card, so no click can precede persistence.
 * - **Per-button mapping**: `active(0|1) + pending == 1` for every shown button while the card is open
 *   (`pending` = a redeemed, queued, not-yet-executed click). Re-issue happens iff `active+pending == 0`.
 * - **Fence**: `fence: Map<"${operator}\n${bindingKey}", {epoch, ctl?}>` doubles as the open-card quota
 *   (16 global / 4 per operator). The slot is pre-claimed synchronously BEFORE `sendCard`; every await
 *   in the creation flow re-verifies the epoch. Supersede reuses the slot with a fresh epoch.
 * - **PATCH ownership (N3)**: physical IO slots live in a dedicated `createFeishuWork` pool (cap
 *   `listCardPatchIoMax`) and follow the REAL promise lifetime; the 8 s logical deadline is an
 *   independent unref'd clock timer that freezes the card without waiting for IO. A second PATCH is
 *   never started while `ioInFlight` is unsettled.
 * - **Barrier (N4)**: every persistence step checks `(await commit()) === true && !persistFailed()`;
 *   `false` ⇒ the card goes `degraded` (no close claim, no PATCH) and is only compensated by
 *   `onPersistRecovered()` (G3: success branches re-send their receipt with the original stable key,
 *   failure branches never invent a success receipt).
 * - **Revocation (G4)**: `revokeOperator` marks the controller revoked, clears its timers and aborts its
 *   IO controller; every late settle/recovery side effect checks `revoked`/`disposed` first. Physical
 *   pool slots are still held until the real promise settles.
 */
import { FEISHU_CAPS, FEISHU_REPLY_LIMITS, sanitizeHeaderField } from "../../protocol/feishu.js";
import type { FeishuIdentityContext, FeishuInstallation } from "./admission.js";
import type { FeishuClock, FeishuResult } from "./http.js";
import type { OutboxTarget } from "./outbox.js";
import { neutralizeMarkdown } from "./render.js";
import { createFeishuWork, feishuKey } from "./runtime.js";
import { feishuBindingKey, type FeishuSessionRow, type FeishuSessions } from "./sessions.js";
import type { FeishuNonce, FeishuState } from "./state.js";

const ACTION_ANCHOR = "session-card";
const ACTION_PICK = "session-pick";
/** §2: queued redeemed clicks per card. A queue-full click has its token consumed and heals on reconcile. */
const QUEUE_MAX = 16;
/** §2: recently closed card message ids (bounded; older ones fall back to the anchor lookup). */
const CLOSED_RECENT_MAX = 64;
/** §5: logical PATCH deadline — independent of the physical IO promise. */
const PATCH_DEADLINE_MS = 8_000;
/** F5: session-card nonces (anchor + buttons) never consume the last reserve slots of the table. */
const NONCE_BUDGET = FEISHU_CAPS.nonces - FEISHU_CAPS.noncesReservedForOthers;

/** The state subset this module persists through (the real `FeishuState` satisfies it structurally). */
export interface SessionCardStatePort {
  commit(): Promise<boolean>;
  persistFailed(): boolean;
  readonly nonces: Pick<FeishuState["nonces"], "issue" | "get" | "list" | "purge">;
  readonly bindings: Pick<FeishuState["bindings"], "get" | "set">;
  readonly allowList: Pick<FeishuState["allowList"], "has">;
  readonly tenant: Pick<FeishuState["tenant"], "get">;
}

export interface SessionCardListMessage {
  senderOpenId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string | undefined;
}

export interface SessionCardListInput {
  message: SessionCardListMessage;
  /** the router's list generation id (keeps `/use n` working in every fallback) */
  generation: number;
  rows: readonly FeishuSessionRow[];
  /** same target the legacy text list would have gone to */
  target: OutboxTarget;
}

export interface SessionCardDeps {
  state: SessionCardStatePort;
  sessions: Pick<FeishuSessions, "rows" | "resolve">;
  installation(): FeishuInstallation | undefined;
  authorize(identity: FeishuIdentityContext): { ok: boolean };
  /** `caps.cards === "denied"` ⇒ today's plain-text list */
  cardsDenied(): boolean;
  sendCard(
    id: string,
    target: OutboxTarget,
    card: string,
    lane: string,
  ): Promise<{ messageId: string; chatId: string; threadId?: string } | undefined>;
  patchCard(params: {
    messageId: string;
    card: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<FeishuResult<void>>;
  notice(target: OutboxTarget, text: string, lane?: string, key?: string): Promise<unknown>;
  capability(name: "cards", ok: boolean): void;
  clock: FeishuClock;
  /** work-pool error sink (service maps it to `health("background-failed")`) */
  onError(): void;
  log?(event: string, reason?: string): void;
}

// ---------------------------------------------------------------------------
// rendering (§1)
// ---------------------------------------------------------------------------

const cpLength = (s: string): number => [...s].length;
const truncateCp = (s: string, max: number): string => {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max)).join("");
};

/** `名称 · @alias` (alias only when held; sid never shown). */
const rowTitle = (row: FeishuSessionRow, nameMax?: number): string =>
  `${nameMax === undefined ? row.name : truncateCp(row.name, nameMax)}${row.alias === undefined ? "" : ` · @${row.alias}`}`;

/** The pre-card plain text list (D2: text is the base). The bound session is marked ✅. */
export function renderListText(rows: readonly FeishuSessionRow[], currentSessionId?: string): string {
  return (
    rows
      .map((r, i) => `${i + 1}. ${rowTitle(r)} [${r.state}/${r.mode}]${r.sessionId === currentSessionId ? " ✅" : ""}`)
      .join("\n") || "没有可用会话"
  );
}

const CLICKABLE = new Set(["busy", "idle", "waiting"]);
const isClickable = (row: FeishuSessionRow): boolean => CLICKABLE.has(row.state);

export interface ListCardButton {
  sessionId: string;
  nonce: string;
  label: string;
}

/** `名称 · @alias · 状态` (no alias ⇒ `名称 · 状态`), the name truncated by code points (surrogate-safe); alias/state never truncated. */
export function listButtonLabel(row: FeishuSessionRow): string {
  const suffix = `${row.alias === undefined ? "" : ` · @${row.alias}`} · ${row.state}`;
  const name = truncateCp(row.name, Math.max(1, FEISHU_CAPS.listButtonLabelMax - cpLength(suffix)));
  return `${name}${suffix}`;
}

function cardJson(content: string, buttons: readonly ListCardButton[], currentSessionId?: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        { tag: "markdown", content: neutralizeMarkdown(content) },
        ...buttons.map((b) => ({
          tag: "button",
          text: { tag: "plain_text", content: b.label },
          // The bound session's button is highlighted.
          ...(b.sessionId === currentSessionId ? { type: "primary" } : {}),
          behaviors: [{ type: "callback", value: { n: b.nonce } }],
        })),
      ],
    },
  });
}

/**
 * Card body: every row (≤`listCardMaxRows`) as a numbered compact line `名称(≤16cp) · @alias · 状态` (alias omitted when none),
 * a tail line for the overflow, and a `/use` hint once not every clickable row gets a button.
 * `undefined` when even the reduced (20-line) card exceeds the byte budget ⇒ caller degrades to text.
 */
export function renderListCard(
  rows: readonly FeishuSessionRow[],
  buttons: readonly ListCardButton[],
  currentSessionId?: string,
): string | undefined {
  const build = (lineCap: number): string => {
    const shown = rows.slice(0, Math.min(lineCap, FEISHU_CAPS.listCardMaxRows));
    const lines = shown.map(
      (r, i) => `${i + 1}. ${rowTitle(r, 16)} · ${r.state}${r.sessionId === currentSessionId ? " ✅" : ""}`,
    );
    const hints: string[] = [];
    if (rows.length > shown.length) hints.push(`另有 ${rows.length - shown.length} 个未显示`);
    if (rows.filter(isClickable).length > FEISHU_CAPS.listCardMaxButtons)
      hints.push(`更多会话：/use <序号|@别名|名称>`);
    if (rows.length > 0) hints.push(`切换会话：点击按钮，或 /use <序号|@别名|名称>`);
    // Blank line before the hint block: Feishu markdown merges a plain line right after an ordered
    // list item INTO that item (live-acceptance 2026-10-19: the hint fused with the last row).
    if (hints.length > 0) lines.push("", ...hints);
    return cardJson(lines.join("\n") || "没有可用会话", buttons, currentSessionId);
  };
  let card = build(FEISHU_CAPS.listCardMaxRows);
  if (Buffer.byteLength(card) > FEISHU_REPLY_LIMITS.maxCardBytes) card = build(20);
  return Buffer.byteLength(card) > FEISHU_REPLY_LIMITS.maxCardBytes ? undefined : card;
}

const renderClosedCard = (text: string): string => cardJson(text, []);

// ---------------------------------------------------------------------------
// target / key helpers
// ---------------------------------------------------------------------------

interface AnchorTarget {
  c: string;
  k: string;
}
interface PickTarget extends AnchorTarget {
  s: string;
}
const targetOf = (record: FeishuNonce): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(record.target);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
function parseAnchorTarget(record: FeishuNonce): AnchorTarget | undefined {
  const v = targetOf(record);
  return typeof v?.["c"] === "string" && typeof v["k"] === "string" ? { c: v["c"], k: v["k"] } : undefined;
}
function parsePickTarget(record: FeishuNonce): PickTarget | undefined {
  const v = targetOf(record);
  return typeof v?.["c"] === "string" && typeof v["k"] === "string" && typeof v["s"] === "string"
    ? { c: v["c"], k: v["k"], s: v["s"] }
    : undefined;
}
/** Chat coordinates come from the server-stored key, NEVER from a (possibly absent) binding. */
function keyChat(k: string): { chatType: "p2p" | "group"; chatId: string; threadId?: string } | undefined {
  if (k.startsWith("p2p:")) {
    const chatId = k.slice(4);
    return chatId ? { chatType: "p2p", chatId } : undefined;
  }
  if (k.startsWith("grp:")) {
    const rest = k.slice(4);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return undefined; // a group key must carry its threadId
    return { chatType: "group", chatId: rest.slice(0, sep), threadId: rest.slice(sep + 1) };
  }
  return undefined;
}
/** Receipt target, same shape as the relaunch receipt. */
function replyTarget(messageId: string, parsed: { chatType: "p2p" | "group" }): OutboxTarget {
  return parsed.chatType === "p2p" ? { scope: "p2p", via: "reply", messageId } : { scope: "topic", messageId };
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

interface PickEntry {
  record: FeishuNonce;
  identity: FeishuIdentityContext;
  eventId: string;
}
interface Slot {
  nonce?: string | undefined;
  pending: number;
}
type CtlState = "open" | "frozen" | "closed" | "degraded";
interface Ctl {
  /** logical id, stable before send: `fl<feishuKey(...)>` (also the sendCard requestId) */
  cardId: string;
  /** platform message id of the card */
  messageId: string;
  operator: string;
  key: string;
  installGen: number;
  tenantKey: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string | undefined;
  epoch: number;
  expiresAt: number;
  state: CtlState;
  slots: Map<string, Slot>;
  queue: PickEntry[];
  tail: Promise<void>;
  expiryTimer: unknown;
  ioInFlight: Promise<void> | undefined;
  ioController: AbortController | undefined;
  /** the closing PATCH happens at most once per card */
  finalPatchUsed: boolean;
  revoked: boolean;
  /** a buttons-bearing PATCH provably landed at least once */
  buttonsAttached: boolean;
  degradedFrom: { kind: "success"; eventId: string; sessionId: string } | { kind: "failure" } | undefined;
  recoverAttempted: boolean;
}

type PatchOutcome = { ok: true } | { ok: false; effect: "none" | "unknown"; denied?: boolean };

export function createFeishuSessionCard(deps: SessionCardDeps) {
  const clock = deps.clock;
  const work = createFeishuWork(clock, deps.onError, FEISHU_CAPS.listCardPatchIoMax);
  let disposed = false;
  let seq = 0;
  const fence = new Map<string, { epoch: number; ctl?: Ctl }>();
  const ctls = new Map<string, Ctl>(); // by card messageId
  const closedRecent: string[] = [];
  const tracked = new Set<Promise<unknown>>();

  const fenceKeyOf = (operator: string, key: string) => `${operator}\n${key}`;
  const pickKey = (eventId: string) => `fp${feishuKey(`pick:${eventId}`)}`;
  const gateKey = (messageId: string) => `fq${feishuKey(`pickq:${messageId}`)}`;

  function track(p: Promise<unknown>): void {
    tracked.add(p);
    void p.finally(() => tracked.delete(p)).catch(() => {});
  }
  /** N4: an in-memory fact is only evidence once commit() said true. Never throws. */
  async function barrier(): Promise<boolean> {
    try {
      return (await deps.state.commit()) === true && !deps.state.persistFailed();
    } catch {
      return false;
    }
  }
  const isCardNonce = (n: FeishuNonce, messageId: string) =>
    n.messageId === messageId && (n.action === ACTION_ANCHOR || n.action === ACTION_PICK);
  const purgeCardNonces = (messageId: string): number => deps.state.nonces.purge((n) => isCardNonce(n, messageId));

  function issueNonce(
    ctl: Pick<Ctl, "installGen" | "tenantKey" | "operator" | "chatId" | "messageId" | "expiresAt">,
    action: string,
    target: object,
  ): FeishuNonce | undefined {
    const issued = deps.state.nonces.issue(
      {
        installGen: ctl.installGen,
        tenantKey: ctl.tenantKey,
        operatorOpenId: ctl.operator,
        chatId: ctl.chatId,
        messageId: ctl.messageId,
        action,
        target: JSON.stringify(target),
      },
      undefined,
      // absolute expiry, pinned inside issue()'s own clock read: re-issues never extend it, not even by 1 ms
      { maxTotal: NONCE_BUDGET, expiresAt: ctl.expiresAt },
    );
    return issued.ok ? issued.value : undefined;
  }

  function epochMine(ctl: Ctl): boolean {
    return fence.get(fenceKeyOf(ctl.operator, ctl.key))?.epoch === ctl.epoch;
  }
  function releaseFence(ctl: Ctl): void {
    const fk = fenceKeyOf(ctl.operator, ctl.key);
    if (fence.get(fk)?.ctl === ctl || fence.get(fk)?.epoch === ctl.epoch) {
      if (fence.get(fk)?.ctl !== undefined && fence.get(fk)?.ctl !== ctl) return; // a newer card owns it
      fence.delete(fk);
    }
  }
  function markClosed(ctl: Ctl): void {
    if (!closedRecent.includes(ctl.messageId)) closedRecent.push(ctl.messageId);
    while (closedRecent.length > CLOSED_RECENT_MAX) {
      const evicted = closedRecent.shift();
      if (evicted !== undefined) ctls.delete(evicted);
    }
  }

  /** The session currently bound to the card's chat/topic (undefined when unbound). */
  const currentSid = (key: string): string | undefined => deps.state.bindings.get(key)?.sessionId ?? undefined;

  function buttonsOf(ctl: Ctl): ListCardButton[] {
    const rows = deps.sessions.rows();
    const out: ListCardButton[] = [];
    const seen = new Set<string>();
    // clickable rows first, in rows() order (§1)
    for (const row of rows.filter(isClickable).slice(0, FEISHU_CAPS.listCardMaxButtons)) {
      const slot = ctl.slots.get(row.sessionId);
      if (slot?.nonce !== undefined) {
        out.push({ sessionId: row.sessionId, nonce: slot.nonce, label: listButtonLabel(row) });
        seen.add(row.sessionId);
      }
    }
    // surviving slots whose session is not clickable RIGHT NOW (e.g. agents still reconnecting after a
    // hub restart): keep their buttons live — a click re-checks live state and gates on its own
    for (const [sid, slot] of ctl.slots) {
      if (seen.has(sid) || slot.nonce === undefined) continue;
      const row = rows.find((r) => r.sessionId === sid);
      out.push({
        sessionId: sid,
        nonce: slot.nonce,
        label: row ? listButtonLabel(row) : "未知会话 · unknown",
      });
    }
    return out;
  }

  /**
   * N5 reconcile (sync, in-memory only): recompute the expected button set from the CURRENT rows;
   * purge nonces of vanished sessions; re-issue exactly one nonce for a button with active+pending==0.
   * A slot whose nonce vanished from the table (consumed but never enqueued — e.g. a commit failure
   * between redeem and emit) counts as active=0 and heals here.
   */
  function reconcile(ctl: Ctl, opts?: { keepVanished?: boolean }): { changed: boolean; issued: string[] } {
    let changed = false;
    const issued: string[] = [];
    const rows = deps.sessions.rows().filter(isClickable).slice(0, FEISHU_CAPS.listCardMaxButtons);
    const wanted = new Set(rows.map((r) => r.sessionId));
    for (const [sid, slot] of [...ctl.slots]) {
      if (wanted.has(sid)) continue;
      if (opts?.keepVanished === true) {
        // Boot adoption: rows() is empty until agents reconnect — never purge survivors for that.
        if (slot.nonce !== undefined && deps.state.nonces.get(slot.nonce) === undefined) {
          slot.nonce = undefined;
          changed = true;
        }
        continue;
      }
      if (slot.nonce !== undefined) {
        const nonce = slot.nonce;
        deps.state.nonces.purge((n) => n.nonce === nonce);
        changed = true;
      }
      if (slot.pending === 0) ctl.slots.delete(sid);
      else slot.nonce = undefined; // a queued click owes this slot its dequeue bookkeeping
    }
    for (const row of rows) {
      let slot = ctl.slots.get(row.sessionId);
      if (slot === undefined) {
        slot = { pending: 0 };
        ctl.slots.set(row.sessionId, slot);
      }
      if (slot.nonce !== undefined && deps.state.nonces.get(slot.nonce) === undefined) slot.nonce = undefined;
      if (slot.nonce === undefined && slot.pending === 0) {
        const nonce = issueNonce(ctl, ACTION_PICK, { c: ctl.cardId, k: ctl.key, s: row.sessionId });
        if (nonce !== undefined) {
          slot.nonce = nonce.nonce;
          issued.push(nonce.nonce);
          changed = true;
        }
      }
    }
    return { changed, issued };
  }

  // ----- PATCH: physical IO pool + independent logical deadline (N3) -------

  /** Late-settle hook: a frozen card gets its single closing PATCH once the real promise settles. */
  function onPatchSettled(ctl: Ctl): void {
    if (disposed || ctl.revoked || ctl.state !== "frozen") return;
    closingPatch(ctl, "已停用，请重新 /list");
    void (ctl.ioInFlight ?? Promise.resolve()).then(() => {
      if (ctl.state === "frozen") {
        ctl.state = "closed";
        markClosed(ctl);
      }
    });
  }

  /** Best-effort terminal PATCH, pool-owned, own 8 s deadline, at most once per card, never concurrent. */
  function closingPatch(ctl: Ctl, text: string): void {
    if (disposed || ctl.revoked || ctl.finalPatchUsed) return;
    if (ctl.ioInFlight !== undefined) {
      // supersede/close while a PATCH is in flight: serialize after the real settle, never concurrent
      void ctl.ioInFlight.then(() => closingPatch(ctl, text));
      return;
    }
    ctl.finalPatchUsed = true;
    const controller = new AbortController();
    ctl.ioController = controller;
    let notify!: () => void;
    const io = new Promise<void>((res) => (notify = res));
    ctl.ioInFlight = io;
    const launched = work.run(async () => {
      try {
        await deps.patchCard({
          messageId: ctl.messageId,
          card: renderClosedCard(text),
          signal: controller.signal,
          timeoutMs: PATCH_DEADLINE_MS,
        });
      } catch {
        /* best effort */
      } finally {
        notify();
        if (ctl.ioInFlight === io) {
          ctl.ioInFlight = undefined;
          ctl.ioController = undefined;
        }
      }
    });
    if (!launched) {
      // pool full of zombies: give up (the card keeps its previous content; disclosed residual)
      ctl.ioInFlight = undefined;
      ctl.ioController = undefined;
      return;
    }
    track(io);
  }

  /** Logical deadline path: freeze the card without waiting for the IO promise. */
  function freeze(ctl: Ctl): void {
    if (ctl.state !== "open") return;
    ctl.state = "frozen";
    ctl.ioController?.abort();
    purgeCardNonces(ctl.messageId);
    releaseFence(ctl);
    clock.clearTimeout(ctl.expiryTimer);
    track(
      (async () => {
        if (!(await barrier())) enterDegraded(ctl, ctl.degradedFrom ?? { kind: "failure" });
      })(),
    );
  }

  function patchTracked(ctl: Ctl, card: string, hasButtons: boolean): Promise<PatchOutcome> {
    if (disposed || ctl.revoked || ctl.state !== "open") return Promise.resolve({ ok: false, effect: "none" });
    if (ctl.ioInFlight !== undefined) return Promise.resolve({ ok: false, effect: "none" });
    const controller = new AbortController();
    ctl.ioController = controller;
    let settled = false;
    let result: FeishuResult<void> | undefined;
    let notify!: () => void;
    const io = new Promise<void>((res) => (notify = res));
    ctl.ioInFlight = io;
    const launched = work.run(async () => {
      try {
        result = await deps.patchCard({
          messageId: ctl.messageId,
          card,
          signal: controller.signal,
          timeoutMs: PATCH_DEADLINE_MS,
        });
      } catch {
        result = { ok: false, kind: "unreachable", reason: "threw", retryable: false, effect: "unknown" };
      } finally {
        settled = true;
        notify();
        if (ctl.ioInFlight === io) {
          ctl.ioInFlight = undefined;
          ctl.ioController = undefined;
        }
        onPatchSettled(ctl);
      }
    });
    if (!launched) {
      // NOT initiated (pool full / zombie): provably no effect
      ctl.ioInFlight = undefined;
      ctl.ioController = undefined;
      return Promise.resolve({ ok: false, effect: "none" });
    }
    track(io);
    return new Promise<PatchOutcome>((resolve) => {
      const timer = clock.setTimeout(() => {
        if (settled) return;
        freeze(ctl);
        resolve({ ok: false, effect: "unknown" });
      }, PATCH_DEADLINE_MS);
      void io.then(() => {
        clock.clearTimeout(timer);
        if (disposed || ctl.revoked || result === undefined) {
          resolve({ ok: false, effect: "none" });
          return;
        }
        const r = result;
        if (r.ok) {
          deps.capability("cards", true);
          if (hasButtons) ctl.buttonsAttached = true;
          resolve({ ok: true });
        } else {
          if (r.capabilityDenied) deps.capability("cards", false);
          resolve({ ok: false, effect: r.effect, ...(r.capabilityDenied ? { denied: true } : {}) });
        }
      });
    });
  }

  // ----- state transitions -------------------------------------------------

  function enterDegraded(
    ctl: Ctl,
    origin: { kind: "success"; eventId: string; sessionId: string } | { kind: "failure" },
  ): void {
    if (disposed || ctl.revoked) return;
    if (ctl.state !== "degraded") {
      ctl.state = "degraded";
      ctl.degradedFrom = origin;
    }
    releaseFence(ctl);
    clock.clearTimeout(ctl.expiryTimer);
    // Best-effort honest notice (never a success/close claim); exceptions swallowed.
    const parsed = keyChat(ctl.key);
    if (parsed)
      track(
        Promise.resolve(
          deps.notice(
            replyTarget(ctl.messageId, parsed),
            "状态保存失败，请稍后重试 /list",
            ctl.chatId,
            gateKey(ctl.messageId),
          ),
        ).catch(() => {}),
      );
  }

  /** D5 failure gate (authorized click hit offline/ambiguous/read-only/expired): close the whole card. */
  async function gateClose(ctl: Ctl, text: string): Promise<void> {
    if (disposed || ctl.revoked || ctl.state !== "open") return;
    ctl.state = "closed";
    releaseFence(ctl);
    clock.clearTimeout(ctl.expiryTimer);
    purgeCardNonces(ctl.messageId);
    if (!(await barrier())) {
      enterDegraded(ctl, { kind: "failure" });
      return;
    }
    const parsed = keyChat(ctl.key);
    if (parsed)
      await deps.notice(replyTarget(ctl.messageId, parsed), text, ctl.chatId, gateKey(ctl.messageId)).catch(() => {});
    if (ctl.state === "closed") closingPatch(ctl, text);
    markClosed(ctl);
  }

  async function expireCard(ctl: Ctl): Promise<void> {
    if (disposed || ctl.revoked || ctl.state !== "open") return;
    ctl.state = "closed";
    releaseFence(ctl);
    purgeCardNonces(ctl.messageId);
    if (!(await barrier())) {
      enterDegraded(ctl, { kind: "failure" });
      return;
    }
    closingPatch(ctl, "卡片已过期，请重新 /list");
    markClosed(ctl);
  }

  function armExpiry(ctl: Ctl): void {
    ctl.expiryTimer = clock.setTimeout(
      () => {
        track(expireCard(ctl));
      },
      Math.max(1, ctl.expiresAt - clock.now()),
    );
  }

  /** PATCH failure after the card was sent (first attach or refresh). Only called while still `open`. */
  async function handlePatchFailure(ctl: Ctl, outcome: { effect: "none" | "unknown" }): Promise<void> {
    if (disposed || ctl.revoked || ctl.state !== "open") return; // freeze() owns the unknown-in-flight path
    const wasAttached = ctl.buttonsAttached;
    ctl.state = "closed"; // stop accepting clicks BEFORE purging
    releaseFence(ctl);
    clock.clearTimeout(ctl.expiryTimer);
    purgeCardNonces(ctl.messageId);
    if (!(await barrier())) {
      enterDegraded(ctl, { kind: "failure" });
      return;
    }
    if (outcome.effect === "none" && !wasAttached) {
      // First-attach refusal: the PATCH provably never applied, the card simply stays a text card.
      markClosed(ctl);
      return;
    }
    if (outcome.effect === "none") {
      // Refresh refusal: stale buttons remain visible ⇒ honest notice + best-effort closing PATCH.
      const parsed = keyChat(ctl.key);
      if (parsed)
        await deps
          .notice(
            replyTarget(ctl.messageId, parsed),
            "卡片刷新失败，已停用，请重新 /list",
            ctl.chatId,
            gateKey(ctl.messageId),
          )
          .catch(() => {});
    }
    // unknown (already settled): buttons may be live with now-purged nonces ⇒ close.
    closingPatch(ctl, "已停用，请重新 /list");
    markClosed(ctl);
  }

  /** The closed-card receipt: at most one per card (the `fq` key dedups), target parsed from the key. */
  async function replyClosed(record: FeishuNonce): Promise<void> {
    if (disposed) return;
    const target = parseAnchorTarget(record) ?? parsePickTarget(record);
    const parsed = target ? keyChat(target.k) : undefined;
    if (!parsed || parsed.chatId !== record.chatId) return;
    await deps
      .notice(
        replyTarget(record.messageId, parsed),
        "卡片已关闭，请重新 /list",
        record.chatId,
        gateKey(record.messageId),
      )
      .catch(() => {});
  }

  // ----- pick (G1: controller-owned synchronous enqueue) --------------------

  /**
   * The closed-card receipt is for AUTHORIZED users only (N6): a denied/foreign/stale-install sender
   * gets nothing at all — not even a "closed" hint — so the sync pick path re-checks authorization first.
   */
  function closedReply(record: FeishuNonce, identity: FeishuIdentityContext): void {
    if (
      !deps.state.allowList.has(identity.senderOpenId) ||
      !deps.authorize(identity).ok ||
      identity.senderOpenId !== record.operatorOpenId
    )
      return;
    track(replyClosed(record));
  }

  function adoptLazy(anchor: FeishuNonce): Ctl | undefined {
    const target = parseAnchorTarget(anchor);
    const parsed = target ? keyChat(target.k) : undefined;
    if (!target || !parsed) return undefined;
    const fk = fenceKeyOf(anchor.operatorOpenId, target.k);
    const existing = fence.get(fk);
    if (existing?.ctl !== undefined && existing.ctl.messageId !== anchor.messageId) return undefined; // superseded
    if (existing === undefined) {
      if (fence.size >= FEISHU_CAPS.listCardsOpenGlobal) return undefined;
      let mine = 0;
      for (const k of fence.keys()) if (k.startsWith(`${anchor.operatorOpenId}\n`)) mine++;
      if (mine >= FEISHU_CAPS.listCardsOpenPerOperator) return undefined;
    }
    const ctl = buildCtl(anchor, target, parsed, existing?.epoch ?? ++seq);
    if (existing === undefined) fence.set(fk, { epoch: ctl.epoch, ctl });
    else existing.ctl = ctl;
    ctls.set(ctl.messageId, ctl);
    armExpiry(ctl);
    return ctl;
  }

  function buildCtl(
    anchor: FeishuNonce,
    target: AnchorTarget,
    parsed: { chatType: "p2p" | "group"; chatId: string; threadId?: string },
    epoch: number,
  ): Ctl {
    const now = clock.now();
    const slots = new Map<string, Slot>();
    for (const n of deps.state.nonces.list(
      (x) => x.messageId === anchor.messageId && x.action === ACTION_PICK && x.expiresAt > now,
    )) {
      const bt = parsePickTarget(n);
      if (bt?.s !== undefined && bt.c === target.c && bt.k === target.k)
        slots.set(bt.s, { nonce: n.nonce, pending: 0 });
    }
    return {
      cardId: target.c,
      messageId: anchor.messageId,
      operator: anchor.operatorOpenId,
      key: target.k,
      installGen: anchor.installGen,
      tenantKey: anchor.tenantKey,
      chatId: anchor.chatId,
      chatType: parsed.chatType,
      threadId: parsed.threadId,
      epoch,
      expiresAt: anchor.expiresAt,
      state: "open",
      slots,
      queue: [],
      tail: Promise.resolve(),
      expiryTimer: undefined,
      ioInFlight: undefined,
      ioController: undefined,
      finalPatchUsed: false,

      revoked: false,
      buttonsAttached: true, // an adopted card had its buttons PATCHed before the restart (unknown ⇒ assume)
      degradedFrom: undefined,
      recoverAttempted: false,
    };
  }

  function kick(ctl: Ctl): void {
    ctl.tail = ctl.tail
      .then(() => drain(ctl))
      .catch((e: unknown) => {
        deps.log?.("session-card", "drain-error");
        void e;
      });
    track(ctl.tail);
  }

  /**
   * Synchronous entry point (G1): service calls this DIRECTLY from the inbound emit — never through the
   * generic work pool — so a saturated pool can never drop a redeemed click. Slot bookkeeping (clear
   * `slot.nonce`, `pending++`) happens before the first await; execution serializes on `ctl.tail`.
   */
  function pick(record: FeishuNonce, identity: FeishuIdentityContext, eventId: string): void {
    if (disposed) return;
    const target = parsePickTarget(record);
    if (!target) return;
    let ctl = ctls.get(record.messageId);
    if (ctl === undefined) {
      const anchor = deps.state.nonces
        .list((n) => n.action === ACTION_ANCHOR && n.messageId === record.messageId)
        .find((n) => n.expiresAt > clock.now());
      if (anchor !== undefined) ctl = adoptLazy(anchor);
      if (ctl === undefined) {
        closedReply(record, identity);
        return;
      }
    }
    if (ctl.revoked || ctl.state !== "open") {
      closedReply(record, identity);
      return;
    }
    const slot = ctl.slots.get(target.s);
    if (slot === undefined || slot.nonce !== record.nonce) return; // stale/foreign click: silent
    if (ctl.queue.length >= QUEUE_MAX) {
      slot.nonce = undefined; // token already consumed; the next reconcile re-issues
      return;
    }
    slot.nonce = undefined;
    slot.pending++;
    ctl.queue.push({ record, identity, eventId });
    kick(ctl);
  }

  async function drain(ctl: Ctl): Promise<void> {
    while (ctl.queue.length > 0) {
      if (disposed || ctl.revoked) {
        ctl.queue.length = 0;
        return;
      }
      const entry = ctl.queue.shift()!;
      try {
        await execPick(ctl, entry);
      } catch {
        deps.log?.("session-card", "pick-error");
      }
    }
  }

  async function execPick(ctl: Ctl, entry: PickEntry): Promise<void> {
    const { record, identity, eventId } = entry;
    const target = parsePickTarget(record);
    const slot = target ? ctl.slots.get(target.s) : undefined;
    if (slot !== undefined && slot.pending > 0) slot.pending--;
    if (disposed || ctl.revoked) return;
    // ① authorization FIRST — any failure is fully silent (no reply, no cleanup side effects)
    if (!deps.state.allowList.has(identity.senderOpenId)) {
      revokeOperator(identity.senderOpenId); // a deny revokes the operator's cards silently
      return;
    }
    if (!deps.authorize(identity).ok) return;
    if (identity.senderOpenId !== ctl.operator || identity.installGen !== ctl.installGen) return;
    if (target === undefined || target.c !== ctl.cardId || target.k !== ctl.key) return;
    // ② card state
    if (ctl.state !== "open") {
      await replyClosed(record);
      return;
    }
    // ③ absolute expiry
    if (record.expiresAt <= clock.now()) {
      await gateClose(ctl, "卡片已过期，请重新 /list");
      return;
    }
    // ④ supersede fence
    if (!epochMine(ctl)) return;
    // ⑤ key consistency (recomputed from the server-stored key; never falls back to p2p)
    const parsed = keyChat(target.k);
    if (parsed === undefined || parsed.chatId !== record.chatId) {
      deps.log?.("session-card", "key-mismatch");
      return;
    }
    const existing = deps.state.bindings.get(target.k);
    if (
      existing !== undefined &&
      (existing.chatType !== parsed.chatType ||
        existing.chatId !== parsed.chatId ||
        existing.threadId !== parsed.threadId)
    ) {
      deps.log?.("session-card", "binding-mismatch");
      return;
    }
    // ⑥ live resolution — failure closes the whole card (D5)
    const resolution = deps.sessions.resolve(target.s);
    if (!resolution.ok) {
      const row = deps.sessions.rows().find((r) => r.sessionId === target.s);
      await gateClose(
        ctl,
        `${row?.label ?? target.s.slice(0, 6)} 不可用（${resolution.code}），卡片已关闭，请重新 /list`,
      );
      return;
    }
    // ⑦ success — in-memory binding change first (D6: later bindings.set wins; same session is a no-op)
    const row = deps.sessions.rows().find((r) => r.sessionId === target.s);
    const sameSession = existing?.sessionId === target.s && existing.offline === undefined;
    let bound = true;
    if (!sameSession) {
      const set = deps.state.bindings.set(target.k, {
        chatId: parsed.chatId,
        chatType: parsed.chatType,
        ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
        sessionId: target.s,
        label: sanitizeHeaderField(row?.name ?? target.s.slice(0, 6)),
        offline: null,
      });
      bound = set.ok;
    }
    const step = reconcile(ctl); // re-issue the consumed button iff active+pending==0 (idempotent)
    if (!(await barrier())) {
      // Roll back THIS step's fresh nonces; the binding stays changed in memory but is never claimed.
      const issued = new Set(step.issued);
      if (issued.size > 0) deps.state.nonces.purge((n) => issued.has(n.nonce));
      enterDegraded(ctl, { kind: "success", eventId, sessionId: target.s });
      return;
    }
    if (disposed || ctl.revoked || ctl.state !== "open" || !epochMine(ctl)) return;
    const label = row?.label ?? target.s.slice(0, 6);
    await deps
      .notice(
        replyTarget(record.messageId, parsed),
        !bound
          ? "绑定已满，无法切换，请 /unbind 后重试"
          : sameSession
            ? `已绑定：${label}（未变化）`
            : `已绑定：${label}`,
        record.chatId,
        pickKey(eventId),
      )
      .catch(() => {});
    if (disposed || ctl.revoked || ctl.state !== "open") return;
    const card = renderListCard(deps.sessions.rows(), buttonsOf(ctl), currentSid(ctl.key));
    if (card === undefined) {
      await handlePatchFailure(ctl, { effect: "none" });
      return;
    }
    const patched = await patchTracked(ctl, card, true);
    if (!patched.ok && ctl.state === "open") await handlePatchFailure(ctl, patched);
  }

  // ----- /list (card creation with slot pre-claim + supersede) --------------

  async function sendList(input: SessionCardListInput): Promise<void> {
    const m = input.message;
    if (disposed) return;
    const key = feishuBindingKey(m.chatType, m.chatId, m.threadId);
    if (key === undefined) return; // router guarantees a key; defense only
    const textDegrade = async (): Promise<void> => {
      await deps
        .notice(
          input.target,
          renderListText(input.rows, currentSid(key)),
          m.chatId,
          `fx${feishuKey(`listtext:${input.generation}:${m.messageId}`)}`,
        )
        .catch(() => {});
    };
    if (
      deps.cardsDenied() ||
      work.size >= FEISHU_CAPS.listCardPatchIoMax ||
      input.rows.filter(isClickable).length === 0
    ) {
      await textDegrade();
      return;
    }
    const operator = m.senderOpenId;
    const fk = fenceKeyOf(operator, key);
    const existing = fence.get(fk);
    if (existing === undefined) {
      if (fence.size >= FEISHU_CAPS.listCardsOpenGlobal) {
        await textDegrade();
        return;
      }
      let mine = 0;
      for (const k of fence.keys()) if (k.startsWith(`${operator}\n`)) mine++;
      if (mine >= FEISHU_CAPS.listCardsOpenPerOperator) {
        await textDegrade();
        return;
      }
    }
    // Synchronous slot pre-claim — before sendCard, so concurrent /list can never oversell (N2).
    const epoch = ++seq;
    const oldCtl = existing?.ctl;
    fence.set(fk, { epoch });
    const releaseSlot = () => {
      if (fence.get(fk)?.epoch === epoch && fence.get(fk)?.ctl === undefined) fence.delete(fk);
    };
    const install = deps.installation();
    const tenantKey = deps.state.tenant.get();
    if (!install?.active || tenantKey === undefined) {
      releaseSlot();
      await textDegrade();
      return;
    }
    const mine = () => fence.get(fk)?.epoch === epoch;
    const cardId = `fl${feishuKey(`list:${input.generation}:${operator}:${m.messageId}`)}`;
    if (oldCtl !== undefined) purgeCardNonces(oldCtl.messageId); // supersede: old nonces die first
    if (!(await barrier())) {
      if (oldCtl !== undefined) enterDegraded(oldCtl, { kind: "failure" });
      releaseSlot();
      await textDegrade();
      return;
    }
    if (oldCtl !== undefined) {
      // A frozen old card keeps its own pending closing PATCH as the single closing text;
      // the supersede chain skips its 「已被新列表取代」PATCH for it.
      const wasFrozen = oldCtl.state === "frozen";
      oldCtl.state = "closed";
      clock.clearTimeout(oldCtl.expiryTimer);
      if (!wasFrozen) closingPatch(oldCtl, "已被新列表取代");
      markClosed(oldCtl);
    }
    if (disposed || !mine()) return;
    const card = renderListCard(input.rows, [], currentSid(key));
    if (card === undefined) {
      releaseSlot();
      await textDegrade();
      return;
    }
    const sent = await deps.sendCard(cardId, input.target, card, m.chatId);
    if (disposed || !mine()) return; // late sendCard: a nonce-free text card is all that remains
    if (sent === undefined) {
      releaseSlot();
      await textDegrade();
      return;
    }
    const expiresAt = clock.now() + FEISHU_CAPS.nonceTtlMs;
    const parsed = keyChat(key)!;
    // The card is always a reply to the /list message, i.e. it lives in THAT chat (never trust the
    // transport-reported chat over the server-side key): callbacks bind open_chat_id to this value.
    const base = {
      installGen: install.gen,
      tenantKey,
      operator,
      chatId: parsed.chatId,
      messageId: sent.messageId,
      expiresAt,
    };
    const anchor = issueNonce(base, ACTION_ANCHOR, { c: cardId, k: key });
    if (anchor === undefined) {
      releaseSlot(); // anchor refused ⇒ the whole card stays textual
      return;
    }
    const ctl: Ctl = {
      cardId,
      messageId: sent.messageId,
      operator,
      key,
      installGen: install.gen,
      tenantKey,
      chatId: base.chatId,
      chatType: parsed.chatType,
      threadId: parsed.threadId,
      epoch,
      expiresAt,
      state: "open",
      slots: new Map(),
      queue: [],
      tail: Promise.resolve(),
      expiryTimer: undefined,
      ioInFlight: undefined,
      ioController: undefined,
      finalPatchUsed: false,

      revoked: false,
      buttonsAttached: false,
      degradedFrom: undefined,
      recoverAttempted: false,
    };
    fence.set(fk, { epoch, ctl });
    ctls.set(ctl.messageId, ctl);
    armExpiry(ctl);
    const step = reconcile(ctl); // issues every button nonce (fresh rows), anchor already issued first
    if (step.issued.length === 0 && deps.sessions.rows().some(isClickable)) {
      // Not a single button could be issued: drop the anchor, the card stays text-only.
      purgeCardNonces(ctl.messageId);
      await barrier().catch(() => false);
      ctl.state = "closed";
      ctls.delete(ctl.messageId);
      releaseFence(ctl);
      clock.clearTimeout(ctl.expiryTimer);
      return;
    }
    if (!(await barrier())) {
      // Roll back this step's nonces; the sent card stays text-only and the slot is released.
      purgeCardNonces(ctl.messageId);
      ctl.state = "closed";
      ctls.delete(ctl.messageId);
      releaseFence(ctl);
      clock.clearTimeout(ctl.expiryTimer);
      return;
    }
    if (disposed || !mine() || ctl.revoked) {
      // Superseded during the barrier: our nonces must not outlive the fence loss.
      purgeCardNonces(ctl.messageId);
      track(barrier());
      ctls.delete(ctl.messageId);
      ctl.state = "closed";
      clock.clearTimeout(ctl.expiryTimer);
      return;
    }
    const full = renderListCard(deps.sessions.rows(), buttonsOf(ctl), currentSid(ctl.key));
    if (full === undefined) {
      await handlePatchFailure(ctl, { effect: "none" });
      return;
    }
    const patched = await patchTracked(ctl, full, true);
    if (!patched.ok && ctl.state === "open") await handlePatchFailure(ctl, patched);
  }

  // ----- recovery / revocation / lifecycle -----------------------------------

  /** G3: compensate degraded cards once persistence is healthy again (one attempt per event, in-tail). */
  function onPersistRecovered(): void {
    if (disposed) return;
    for (const ctl of [...ctls.values()]) {
      if (ctl.state !== "degraded" || ctl.recoverAttempted || ctl.revoked) continue;
      ctl.recoverAttempted = true;
      ctl.tail = ctl.tail.then(() => recoverDegraded(ctl)).catch(() => {});
      track(ctl.tail);
    }
  }

  async function recoverDegraded(ctl: Ctl): Promise<void> {
    if (disposed || ctl.revoked || ctl.state !== "degraded") return;
    purgeCardNonces(ctl.messageId);
    if (!(await barrier())) return; // stays degraded until the next recovery event (no timer retry)
    if (disposed || ctl.revoked || ctl.state !== "degraded") return;
    // Only a success branch whose receipt was never confirmed gets its (original stable key) receipt.
    const origin = ctl.degradedFrom;
    if (origin?.kind === "success") {
      const parsed = keyChat(ctl.key);
      if (parsed) {
        const label =
          deps.sessions.rows().find((r) => r.sessionId === origin.sessionId)?.label ?? origin.sessionId.slice(0, 6);
        await deps
          .notice(replyTarget(ctl.messageId, parsed), `已绑定：${label}`, ctl.chatId, pickKey(origin.eventId))
          .catch(() => {});
      }
    }
    ctl.state = "closed";
    releaseFence(ctl);
    closingPatch(ctl, "已停用，请重新 /list");
    markClosed(ctl);
  }

  /** G4: real revocation — mark, clear timers, abort IO; late settles/recoveries check the flag. */
  function revokeOperator(openId: string): void {
    for (const ctl of [...ctls.values()]) {
      if (ctl.operator !== openId || ctl.revoked) continue;
      ctl.revoked = true;
      clock.clearTimeout(ctl.expiryTimer);
      ctl.ioController?.abort();
      ctl.queue.length = 0;
      releaseFence(ctl);
      ctls.delete(ctl.messageId); // silent: no PATCH, no notice (nonces were purged by purgeOperator)
    }
    // Also drop bare pre-claimed slots; in-flight creations stop at their next epoch re-check.
    for (const [fk] of [...fence]) if (fk.startsWith(`${openId}\n`)) fence.delete(fk);
  }

  /** Boot adoption (G2): runs to completion BEFORE the connector starts accepting events. */
  async function start(): Promise<void> {
    if (disposed) return;
    const now = clock.now();
    const anchors = deps.state.nonces
      .list((n) => n.action === ACTION_ANCHOR)
      .filter((n) => n.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
    const keep: { anchor: FeishuNonce; target: AnchorTarget }[] = [];
    const seen = new Set<string>();
    const dropIds = new Set<string>();
    for (const anchor of anchors) {
      const target = parseAnchorTarget(anchor);
      const fk = target ? fenceKeyOf(anchor.operatorOpenId, target.k) : undefined;
      if (target === undefined || fk === undefined || seen.has(fk) || keep.length >= FEISHU_CAPS.listCardsOpenGlobal)
        dropIds.add(anchor.messageId);
      else {
        seen.add(fk);
        keep.push({ anchor, target });
      }
    }
    if (dropIds.size > 0) {
      deps.state.nonces.purge((n) => dropIds.has(n.messageId) && isCardNonce(n, n.messageId));
      await barrier(); // defensive cleanup is best-effort; a false commit stays on disk until TTL
    }
    for (const { anchor, target } of keep) {
      if (disposed) return;
      const parsed = keyChat(target.k);
      if (parsed === undefined) continue;
      const fk = fenceKeyOf(anchor.operatorOpenId, target.k);
      if (fence.get(fk)?.ctl !== undefined) continue; // impossible post-dedup; defense
      const epoch = ++seq;
      const ctl = buildCtl(anchor, target, parsed, epoch);
      fence.set(fk, { epoch, ctl });
      ctls.set(ctl.messageId, ctl);
      armExpiry(ctl);
      const step = reconcile(ctl, { keepVanished: true }); // boot: agents reconnect AFTER adoption
      if (!step.changed) continue; // all slots intact ⇒ no refresh PATCH
      if (!(await barrier())) {
        const issued = new Set(step.issued);
        if (issued.size > 0) deps.state.nonces.purge((n) => issued.has(n.nonce));
        enterDegraded(ctl, { kind: "failure" });
        continue;
      }
      if (disposed || ctl.revoked || ctl.state !== "open") continue;
      // Agents reconnect AFTER adoption: rows() may still miss a surviving slot's session — render it
      // as an offline line instead of wiping the card body to “没有可用会话”.
      const live = deps.sessions.rows();
      const known = new Set(live.map((r) => r.sessionId));
      const displayRows: FeishuSessionRow[] = [...live];
      for (const [sid] of ctl.slots)
        if (!known.has(sid))
          displayRows.push({
            sessionId: sid,
            name: sid.slice(0, 6),
            label: sid.slice(0, 6),
            cwd: "",
            mode: "rpc",
            state: "offline",
          });
      const card = renderListCard(displayRows, buttonsOf(ctl), currentSid(ctl.key));
      if (card === undefined) {
        await handlePatchFailure(ctl, { effect: "none" });
        continue;
      }
      const patched = await patchTracked(ctl, card, true); // serial: ≤16 cards, one PATCH at a time
      if (!patched.ok && ctl.state === "open") await handlePatchFailure(ctl, patched);
    }
  }

  /** Memory teardown only: anchors stay on disk for TTL / the next boot adoption (release condition). */
  function dispose(): void {
    disposed = true;
    for (const ctl of ctls.values()) {
      clock.clearTimeout(ctl.expiryTimer);
      ctl.ioController?.abort();
      ctl.queue.length = 0;
    }
    ctls.clear();
    fence.clear();
    work.close();
  }

  return {
    sendList,
    pick,
    revokeOperator,
    onPersistRecovered,
    start,
    dispose,
    /** test/diagnostic introspection (never used on the hot path) */
    snapshot() {
      return {
        open: [...ctls.values()].filter((c) => c.state === "open").length,
        fenceSlots: fence.size,
        patchIo: work.size,
        states: [...ctls.values()].map((c) => ({ messageId: c.messageId, state: c.state, buttons: c.slots.size })),
      };
    },
  };
}
export type FeishuSessionCard = ReturnType<typeof createFeishuSessionCard>;
