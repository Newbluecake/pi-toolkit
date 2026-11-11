/**
 * fabric-thread arch r3 §4.2/§8 (P2) — the hub-side thread module.
 *
 * What lives here (everything the §8 rules need BEYOND the request state machine, which stays
 * in `requests.ts`, and the run tracker, which stays in `runs.ts`):
 *   - the Thread handle mint (§3.1 D2: `fs:` + HMAC-SHA256(installSecret, bindingKey)[0:12]) and
 *     the §4.2 `cmd.thread` attach gate (pure: hub-config gate + agent `thr.v1` cap + group
 *     topic + `bypass` derived from `thb:`/`main:` synthetic member ids — NO new request fields);
 *   - the §8.1 routed-result wire validation (`parseThreadRoutedResult` mirrors the frozen
 *     `ThreadRoutedResultSchema`; format-invalid ⇒ the caller treats the result as a plain ok);
 *   - the §8.2 retention ledger: `accepted{thr:routed}` retention timers (re-checked before
 *     every migration — first executor wins vs. handback), the 32-request / 512 KiB caps
 *     (over-limit ⇒ the NEW event finalizes `replied{thread-routed}` immediately, never
 *     retained), restart re-arm, unbind/rebind finalization + best-effort `thr_closed` push;
 *   - the §8.1 step-3 receipts (first event per subscription ⇒ text, later ⇒ emoji reaction,
 *     capability-denied ⇒ back to text) and Typing cleanup;
 *   - the §6.8 Worker replies (`thr_req{op:"post"}`): per-thread rate limits, `postId` dedup,
 *     `<会话名> · @label（run_id）` header, thread-topic targeting;
 *   - the rebind-plan r3 ops (P1): `thr_req{op:"rebind"}` (holder-only ownership + fromRev CAS +
 *     §4.6 selector ladder + per-h 3/min+20/h rate limit + dedupKey replay, writing through the
 *     shared `bindings-transfer` op with `notifyLifecycle:true`) and `thr_req{op:"acquire"}`
 *     (`{owned:true,label,rev}` iff the caller still holds the binding) — both self-gate on
 *     `feishuBot.threads.rebind`; a rebind-off hub owes E_THR_STATE (§4.1); the §4.10
 *     retention-expiry generation recheck routes to `requests.closedByRebind`;
 *   - the `/cur` projection of the agent-side `status.threads` slot (cached per agentKey;
 *     a hub without `thr.v1` never populates it — §7.1).
 *
 * The §8.3 handback itself lives in `requests.ts` (`requests.handback`) — it needs the raw
 * state receive/park machinery; this module only owns its display half (the §5.5.3 note line).
 *
 * Timers all go through the injected `FeishuClock` (system clock unrefs — I5). No module-scope
 * mutable state (I4): everything is per-instance, rebuilt with each runtime.
 */
import { createHmac } from "node:crypto";
import { THREAD_CAP, THREAD_REBIND_CAP } from "../../protocol/version.js";
import {
  THREAD_LABEL_CP_RE,
  THREAD_RUN_ID_RE,
  THREAD_SUBS_MAX,
  clampThreadWindowParams,
  type ThreadCloseReason,
  type ThreadMeta,
  type ThreadRunRef,
  type ThreadRoutedResult,
  type ThreadStatusSlotWire,
  type ThreadWindowParams,
} from "../../protocol/thread.js";
import type {
  ThrAcquireReqFrame,
  ThrClosedFrame,
  ThrRebindReqFrame,
  ThrReqFrame,
  ThrResFrame,
} from "../../protocol/thread.js";
import {
  FEISHU_RECEIVED_BODY_MAX_BYTES,
  sanitizeHeaderField,
  type FeishuThreadsHubConfig,
} from "../../protocol/feishu.js";
import type { FeishuClock } from "./http.js";
import type { BindingTransfer } from "./bindings-transfer.js";
import { selectSession } from "./session-selector.js";
import type { FeishuSessionView } from "./sessions.js";
import type { FeishuRequestRecord, FeishuState, FeishuBinding, RequestState } from "./state.js";
import type { FeishuInstallation } from "./admission.js";
import type { EnqueueNoticeInput, EnqueueResult, OutboxTarget } from "./outbox.js";
import { renderNotice } from "./render.js";

// ----------------------------------------------------------------- pure helpers (§3.1, §4.2, §8.1)

/** §3.1 D2: opaque, restart-stable, never exposes chatId; a `setup --replace` secret rotation
 *  invalidates every old handle by design. */
export function feishuThreadHandle(installSecret: string, bindingKey: string): string {
  return `fs:${createHmac("sha256", installSecret).update(bindingKey).digest("base64url").slice(0, 12)}`;
}

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * §8.1 step 1 validation of `cmd_result.data.thread` — mirrors the frozen
 * `ThreadRoutedResultSchema` field-for-field (including the code-point-exact label pattern).
 * Format-invalid ⇒ `undefined` ⇒ the caller treats the result as a plain ok (conservative
 * unattributed path, §7.3). `data.op` must be `"prompt"` — anything else is not a prompt reply.
 */
export function parseThreadRoutedResult(data: unknown): ThreadRoutedResult | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (d["op"] !== "prompt") return undefined;
  const thread = d["thread"];
  if (thread === null || typeof thread !== "object" || Array.isArray(thread)) return undefined;
  const t = thread as Record<string, unknown>;
  const runs = t["runs"];
  if (t["outcome"] !== "routed" || !Array.isArray(runs) || runs.length < 1 || runs.length > THREAD_SUBS_MAX)
    return undefined;
  const parsed: ThreadRunRef[] = [];
  for (const run of runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) return undefined;
    const { runId, label } = run as Record<string, unknown>;
    if (!isString(runId) || !THREAD_RUN_ID_RE.test(runId)) return undefined;
    if (!isString(label) || !THREAD_LABEL_CP_RE.test(label)) return undefined;
    parsed.push({ runId, label });
  }
  return { outcome: "routed", runs: parsed };
}

/**
 * §4.2 attach decision (pure): ALL of hub-config gate (module exists ⇔ `feishuBot.threads`
 * key present), target agent's hello caps ∋ `thr.v1`, `chatType==="group"` with a threadId —
 * else `undefined` ⇒ the frame stays byte-identical (G2b). `bypass` is DERIVED from synthetic
 * member ids (`thb:` handback / `main:`) and never persisted onto the request record.
 */
export function feishuThreadMetaFor(input: {
  record: FeishuRequestRecord;
  agentKey: string | undefined;
  installSecret: string | undefined;
  agentCaps: readonly string[] | undefined;
  /** rebind-plan r3 §6 实施要点 4 (P0b): the HUB-side rebind gate (`feishuBot.threads.rebind
   *  === true`). `rev` rides the meta ONLY when this AND the agent's `thr.rebind.v1` cap both
   *  hold — an old agent's closed schema would drop the whole cmd frame otherwise (R4).
   *  Unset/false ⇒ byte-identical `cmd.thread` (A16). */
  rebind?: boolean;
}): ThreadMeta | undefined {
  const { record } = input;
  if (record.chatType !== "group" || record.threadId === undefined) return undefined;
  if (input.installSecret === undefined || input.agentKey === undefined) return undefined;
  if (input.agentCaps === undefined || !input.agentCaps.includes(THREAD_CAP)) return undefined;
  const bypass = (record.payload?.messageIds ?? []).some((m) => m.startsWith("thb:") || m.startsWith("main:"));
  return {
    h: feishuThreadHandle(input.installSecret, record.bindingKey),
    label: sanitizeHeaderField(record.chatLabel),
    sentAt: Math.max(0, record.sourceCreatedAt ?? record.createdAt),
    ...(bypass ? { bypass: true as const } : {}),
    // §4.7 trusted-source #1: the binding rev observed for this prompt (dual-end cap gate).
    ...(input.rebind === true && input.agentCaps.includes(THREAD_REBIND_CAP) ? { rev: record.bindingRev } : {}),
  };
}

// ----------------------------------------------------------------- §8.2 retention budgets (pure)

export const THREAD_RETAIN_MAX_REQUESTS = 32;
export const THREAD_RETAIN_MAX_BYTES = 512 * 1024;

/** §8.1 finishRun 守卫 (pure, second line of defence behind the pre-commit detach): a retained
 *  `accepted{thr:}` record is never overwritten with unattributed by a lingering tracker or a
 *  late finish. Threads-UNDEFINED (feature off / old-hub rollback) keeps the legacy sweep —
 *  nothing else would ever finalize the record (§8.4③). */
export function threadFinishGuarded(state: RequestState, code: string | undefined, threadsOn: boolean): boolean {
  return threadsOn && state === "accepted" && code !== undefined && code.startsWith("thr:");
}
/** §8.1 step 3 receipt emoji for non-first routed events (「之后只加回执表情」). */
export const THREAD_RECEIPT_EMOJI = "DONE";
/** §7.3 postId dedup window (10 minutes, in-memory). */
export const THREAD_POST_DEDUP_MS = 10 * 60_000;
/** rebind-plan r3 §4.5 (D8): per-thread rebind rate limit — hub CONSTANTS, deliberately NOT in
 *  `FeishuThreadsHubConfig` (its whitelist rebuild would give one key two generations of
 *  semantics). Successes AND post-validation failures both count; the bucket Map is LRU-64 and
 *  fully independent from the `post` `replyPerThread*` buckets. */
export const THREAD_REBIND_RATE_PER_MIN = 3;
export const THREAD_REBIND_RATE_PER_HOUR = 20;
/** §4.4 request dedup: `rebindSeen` capacity (LRU). */
export const THREAD_REBIND_SEEN_MAX = 128;

/** All currently retained `accepted{thr:routed}` records (payload still present). */
export function threadRetainedRequests(state: FeishuState): FeishuRequestRecord[] {
  return state.requests.list({ states: ["accepted"] }).filter((r) => r.code === "thr:routed");
}

export function threadRetainBytes(requests: readonly FeishuRequestRecord[]): number {
  let n = 0;
  for (const r of requests) n += Buffer.byteLength(r.payload?.body ?? "");
  return n;
}

// ----------------------------------------------------------------- §5.5.3/§8.3.4 handback note line

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The §5.5.3 host annotation line (co-subscriber acknowledgement rides the agent-supplied
 *  `note` — the wire frame carries no separate co-subscriber field). The note is neutralized
 *  (control/format chars collapsed) before it ever reaches a prompt. */
export function feishuHandbackNote(args: {
  by: ThreadRunRef | "system";
  sourceCreatedAt: number | undefined;
  note: string;
}): string {
  const who = args.by === "system" ? "system" : `@${args.by.label}（run_id: ${args.by.runId}）`;
  const at = args.sourceCreatedAt === undefined ? "未知时间" : hhmm(args.sourceCreatedAt);
  return `[thread handback · ${who} · 原事件 ${at} · 原因: ${sanitizeHeaderField(args.note)}]`;
}

/** §8.3 step 4: note line + source body; when the combined body would exceed the receive
 *  budget the NOTE is truncated (the source body is never cut — it is the re-delivered event). */
export function feishuHandbackBody(noteLine: string, sourceBody: string): string {
  if (Buffer.byteLength(`${noteLine}\n${sourceBody}`) <= FEISHU_RECEIVED_BODY_MAX_BYTES)
    return `${noteLine}\n${sourceBody}`;
  const room = FEISHU_RECEIVED_BODY_MAX_BYTES - Buffer.byteLength(sourceBody) - 1;
  if (room <= 8) return sourceBody; // degenerate: a max-size source leaves no room at all
  let note = noteLine;
  while (note.length > 0 && Buffer.byteLength(note) > room) note = note.slice(0, -1);
  return note.length > 0 ? `${note}\n${sourceBody}` : sourceBody;
}

// ----------------------------------------------------------------- runtime module

/** registry seams injected post-construction by hub.ts (getCaps for the dual-end `thr.v1`
 *  check, send for best-effort `thr_closed`; both optional — tests inject fakes). */
export interface FeishuThreadTransport {
  getCaps(agentKey: string): readonly string[] | undefined;
  send(agentKey: string, frame: ThrClosedFrame): boolean;
}

/** The `createFeishuRequests` gate surface (§4.2 attach + §8.1 validation + §8.2 caps). */
export interface FeishuThreadGate {
  metaFor(record: FeishuRequestRecord, agentKey: string | undefined): ThreadMeta | undefined;
  routedResultOk(data: unknown, agentKey: string | undefined): ThreadRoutedResult | undefined;
  retainWouldExceed(excludeId: string, candidateBytes: number): boolean;
}

export interface FeishuThreadsDeps {
  clock: FeishuClock;
  config: FeishuThreadsHubConfig;
  state: FeishuState;
  installation(): FeishuInstallation | undefined;
  transport(): FeishuThreadTransport | undefined;
  /** The agent currently serving a session (thr_closed push target); best-effort. */
  agentForSession(sessionId: string): string | undefined;
  /** §7.3: the given agent's CURRENT live session (thr_req sessionId recheck). */
  sessionOf(agentKey: string): string | undefined;
  /** rebind-plan r3 §4.6 (P1): the live session views the `to` selector ladder resolves over.
   *  Absent ⇒ rebind answers E_THR_STATE even with `config.rebind` on (miswired host). */
  sessionViews?(): readonly FeishuSessionView[];
  /** §4.6: hub-held cross-session alias lookup (xs relay store; absent when xs/alias is off). */
  aliasOf?(sessionId: string): string | undefined;
  /** §4.4 D1: the shared binding write op. A GETTER because the transfer is built after this
   *  module (it takes `threads` for the `notifyLifecycle:true` path) — late-bound by the host. */
  transfer?(): BindingTransfer | undefined;
  /** §4.10 (P1): retention-expiry generation recheck routes to `requests.closedByRebind`
   *  (late-bound — requests is built after this module). */
  closedByRebind?(id: string): void;
  /** service notice plumbing (receipts / posts). */
  notice(target: OutboxTarget, text: string, lane: string): Promise<void>;
  enqueueNotice(input: EnqueueNoticeInput): Promise<EnqueueResult>;
  /** §8.1 step 3: add the receipt emoji; false ⇒ the caller falls back to a text receipt. */
  addReceiptReaction(messageId: string): Promise<boolean>;
  reactionsDenied(): boolean;
  deleteTypingReaction(request: FeishuRequestRecord): Promise<void>;
  /** bounded async runner (the runtime work queue — I1: nothing unbounded here). */
  run(task: () => Promise<void>): void;
  label(sessionId: string): string;
  targetFor(r: { chatType: "p2p" | "group"; threadId?: string; triggerMessageId: string }): OutboxTarget;
  log(event: string, reason?: string): void;
}

/** `thr_req` business results (§7.3): success data or the open error vocabulary with effect. */
export type FeishuThrOpResult =
  | { ok: true; data: { queued: true } | { requestId: string; dup?: true } }
  | { ok: false; code: string; effect: "none" | "unknown" };

export function createFeishuThreads(deps: FeishuThreadsDeps) {
  const clock = deps.clock;
  // §8.2 非法组合处理 (hub side): re-clamp with the SAME pure function, log-only — the agent
  // already clamped, so a change here means a corrupted/forged config, never a user typo.
  const clamped = clampThreadWindowParams(deps.config);
  for (const change of clamped.changes)
    deps.log("thread-clamp", `${change.key} ${change.from} -> ${change.to} (${change.reason})`);
  const params: ThreadWindowParams & { replyPerThreadPerMin: number; replyPerThreadPerHour: number } = {
    ...clamped.value,
    replyPerThreadPerMin: deps.config.replyPerThreadPerMin,
    replyPerThreadPerHour: deps.config.replyPerThreadPerHour,
  };
  let disposed = false;
  const retainTimers = new Map<string, unknown>();
  /** `${h}|${runId}` subscriptions that already got their first-event text receipt. */
  const receiptSeen = new Map<string, true>();
  /** agentKey → last `status.threads` slot (only ever sent under the cap — §7.3). */
  const statusThreads = new Map<string, ThreadStatusSlotWire[]>();
  /** agentKeys we have EVER seen a threads slot from (post admission enforces only these). */
  const threadsCapSeen = new Set<string>();
  /** One ledger owns post dedup: only confirmed durable enqueue is `queued`. Pending and
   * unknown entries are pinned (no TTL/eviction), since losing one could resend an effective
   * post. At capacity new work fails closed; known queued entries keep the §7.3 10m window.
   * Instance/restart loss remains the documented §7.3 boundary. */
  const postSeen = new Map<string, { at: number; state: "pending" | "queued" | "unknown" }>();
  const postBuckets = new Map<string, { min: number[]; hour: number[] }>();
  /** §4.5: per-h rebind buckets (3/min + 20/h) — a SEPARATE Map from postBuckets. */
  const rebindBuckets = new Map<string, { min: number[]; hour: number[] }>();
  /** §4.4 rebind request dedup: dedupKey = `h\0sessionId\0to\0fromRev`; `pending` ⇒ a duplicate
   *  gets E_THR_PENDING/unknown, `done` replays the stored receipt (P2 recovery, §4.9). */
  const rebindSeen = new Map<string, { state: "pending" | "done"; res?: ThrResFrame }>();
  /** rebind-plan r3 §4.4 R7 / D2: exactly-once close notification per `(key, before.rev)` — the
   *  `/use` inbound durable hook and the shared transfer op (`notifyLifecycle:true`, rebind
   *  package) may BOTH fire for the same write; the second hit is a no-op. The store-wide rev
   *  counter strictly increases on every change, so distinct writes never collide. Instance-level
   *  (I4), FIFO at 64. */
  const closedSeen = new Set<string>();

  const RETAIN_MS = params.retainMin * 60_000;

  function agentHasCap(agentKey: string | undefined): boolean {
    if (agentKey === undefined) return false;
    return deps.transport()?.getCaps(agentKey)?.includes(THREAD_CAP) ?? false;
  }

  // --------------------------------------------------------------- retention (§8.1 step 4, §8.2)

  /** Idempotent: the callback re-checks state before migrating (§8.2 — first executor wins
   *  against a handback that may have finalized the source in the meantime). */
  function armRetention(record: FeishuRequestRecord): void {
    if (disposed || record.code !== "thr:routed") return;
    const existing = retainTimers.get(record.id);
    if (existing !== undefined) clock.clearTimeout(existing);
    const fireAt = record.stateAt + RETAIN_MS;
    const handle = clock.setTimeout(
      () => {
        retainTimers.delete(record.id);
        const current = deps.state.requests.get(record.id);
        if (current === undefined || current.state !== "accepted" || current.code !== "thr:routed") return;
        // rebind-plan r3 §4.10 (P1): a binding-generation mismatch at expiry means the thread
        // was rebound out from under this retained request — finalize via closedByRebind
        // (terminal `replied{thread-closed}`), NEVER `thread-routed`.
        const binding = deps.state.bindings.get(current.bindingKey);
        if (binding?.rev !== current.bindingRev || binding.sessionId !== current.sessionId) {
          deps.closedByRebind?.(current.id);
          return;
        }
        if (deps.state.requests.transition(record.id, "replied", { code: "thread-routed" }).ok)
          deps.run(async () => {
            await deps.state.commit();
          });
      },
      Math.max(0, fireAt - clock.now()),
    );
    retainTimers.set(record.id, handle);
  }

  function finalizeRetained(
    match: (r: FeishuRequestRecord) => boolean,
    code: "thread-closed" | "thread-revoked",
  ): void {
    for (const r of threadRetainedRequests(deps.state)) {
      if (!match(r)) continue;
      const timer = retainTimers.get(r.id);
      if (timer !== undefined) {
        clock.clearTimeout(timer);
        retainTimers.delete(r.id);
      }
      if (deps.state.requests.transition(r.id, "replied", { code }).ok) deps.log("thread-finalized", `${r.id}:${code}`);
    }
    deps.run(async () => {
      await deps.state.commit();
    });
  }

  /** §5.4: binding removed/rebound — finalize its retained requests and push `thr_closed`. */
  function onBindingClosed(key: string, before: FeishuBinding, reason: "unbound" | "rebound"): void {
    const secret = deps.installation()?.installSecret;
    if (secret === undefined) return; // a no-secret invocation is a no-op; it consumes nothing
    const dedupKey = `${key}\u0000${before.rev}`;
    if (closedSeen.has(dedupKey)) return;
    if (closedSeen.size >= 64) closedSeen.delete(closedSeen.keys().next().value!);
    closedSeen.add(dedupKey);
    const h = feishuThreadHandle(secret, key);
    finalizeRetained((r) => r.bindingKey === key, "thread-closed");
    if (before.sessionId !== undefined) {
      const agentKey = deps.agentForSession(before.sessionId);
      if (agentKey !== undefined && agentHasCap(agentKey))
        deps.transport()?.send(agentKey, { t: "thr_closed", h, reason });
    }
  }

  /** §5.4 setup --replace/reset: best-effort close notice for every retained thread (the state
   *  cleanup itself is the existing installation-changed sweep — §8.2 换安装代). */
  function pushInstallReset(): void {
    if (disposed) return;
    const secret = deps.installation()?.installSecret;
    if (secret === undefined) return;
    for (const r of threadRetainedRequests(deps.state)) {
      if (r.sessionId === undefined) continue;
      const agentKey = deps.agentForSession(r.sessionId);
      if (agentKey !== undefined && agentHasCap(agentKey))
        deps.transport()?.send(agentKey, {
          t: "thr_closed",
          h: feishuThreadHandle(secret, r.bindingKey),
          reason: "reset",
        });
    }
  }

  // --------------------------------------------------------------- routed event (§8.1 step 3)

  function receiptText(runs: readonly ThreadRunRef[]): string {
    return `已转交 ${runs.map((r) => `@${r.label}（run_id: ${r.runId}）`).join("、")}`;
  }

  async function receipt(request: FeishuRequestRecord, runs: readonly ThreadRunRef[]): Promise<void> {
    const secret = deps.installation()?.installSecret;
    const h = secret === undefined ? "" : feishuThreadHandle(secret, request.bindingKey);
    const firsts = runs.filter((r) => !receiptSeen.has(`${h}|${r.runId}`));
    for (const r of runs) {
      const key = `${h}|${r.runId}`;
      if (receiptSeen.size >= 128 && !receiptSeen.has(key)) receiptSeen.delete(receiptSeen.keys().next().value!);
      receiptSeen.set(key, true);
    }
    const target = deps.targetFor(request);
    try {
      if (firsts.length > 0) {
        await deps.notice(target, receiptText(firsts), request.chatId);
        return;
      }
      if (!deps.reactionsDenied() && (await deps.addReceiptReaction(request.triggerMessageId))) return;
      // 「表情能力被拒时退回文字」— full subscriber list on the fallback.
      await deps.notice(target, receiptText(runs), request.chatId);
    } catch {
      /* a receipt is best-effort; the routed outcome never depends on it */
    }
  }

  /** §8.1 step 3 (service side of the `routed` event): Typing cleanup + receipt + retention. */
  function onRouted(event: {
    request: FeishuRequestRecord;
    runs: ThreadRunRef[];
    retained: boolean;
    recovered: boolean;
  }): void {
    if (disposed) return;
    deps.run(() => deps.deleteTypingReaction(event.request));
    if (event.retained) armRetention(event.request);
    if (!event.recovered) deps.run(() => receipt(event.request, event.runs));
  }

  /** §8.1 恢复与竞争: hub restart — re-arm from the remaining time; already expired ⇒ finalize. */
  function onRestartRetained(record: FeishuRequestRecord): void {
    if (disposed) return;
    if (clock.now() >= record.stateAt + RETAIN_MS) {
      if (deps.state.requests.transition(record.id, "replied", { code: "thread-routed" }).ok)
        deps.run(async () => {
          await deps.state.commit();
        });
      return;
    }
    armRetention(record);
  }

  // --------------------------------------------------------------- status cache (§7.3, /cur)

  function onStatus(agentKey: string, status: { threads?: ThreadStatusSlotWire[] }): void {
    if (disposed || status.threads === undefined) return;
    threadsCapSeen.add(agentKey);
    if (statusThreads.size >= 64 && !statusThreads.has(agentKey))
      statusThreads.delete(statusThreads.keys().next().value!);
    statusThreads.set(agentKey, status.threads);
  }

  function threadLinesFor(agentKey: string): string[] {
    const slots = statusThreads.get(agentKey);
    if (slots === undefined || slots.length === 0) return [];
    return [
      "话题订阅：",
      ...slots.map((s) => `· ${s.h} · ${s.subs.map((r) => `@${r.label}（run_id: ${r.runId}）`).join("、")}`),
    ];
  }

  // --------------------------------------------------------------- thr_req{op:"post"} (§6.8)

  function rateLimited(h: string, now: number): boolean {
    const bucket = postBuckets.get(h) ?? { min: [], hour: [] };
    bucket.min = bucket.min.filter((t) => now - t < 60_000);
    bucket.hour = bucket.hour.filter((t) => now - t < 3_600_000);
    if (bucket.min.length >= params.replyPerThreadPerMin || bucket.hour.length >= params.replyPerThreadPerHour)
      return true;
    bucket.min.push(now);
    bucket.hour.push(now);
    if (postBuckets.size >= 64 && !postBuckets.has(h)) postBuckets.delete(postBuckets.keys().next().value!);
    postBuckets.set(h, bucket);
    return false;
  }

  /** Only a proven pre-effect refusal releases the reservation. Unknowns keep their quota. */
  function refundPostRate(h: string, at: number): void {
    const bucket = postBuckets.get(h);
    if (bucket === undefined) return;
    for (const times of [bucket.min, bucket.hour]) {
      const index = times.indexOf(at);
      if (index !== -1) times.splice(index, 1);
    }
  }

  async function post(input: {
    agentKey: string;
    h: string;
    sessionId: string;
    by: ThreadRunRef;
    postId: string;
    text: string;
  }): Promise<FeishuThrOpResult> {
    const now = clock.now();
    for (const [id, entry] of postSeen)
      if (entry.state === "queued" && now - entry.at > THREAD_POST_DEDUP_MS) postSeen.delete(id);
    const seen = postSeen.get(input.postId);
    if (seen !== undefined)
      return seen.state === "queued"
        ? { ok: true, data: { queued: true } }
        : { ok: false, code: seen.state === "pending" ? "E_THR_PENDING" : "E_THR_STATE", effect: "unknown" };
    // Never evict unresolved posts (nor queued posts still inside the dedup window).
    if (postSeen.size >= 256) return { ok: false, code: "E_THR_STATE", effect: "none" };
    const secret = deps.installation()?.installSecret;
    if (secret === undefined) return { ok: false, code: "E_THR_STATE", effect: "none" };
    const binding = deps.state.bindings.list().find((b) => feishuThreadHandle(secret, b.key) === input.h);
    if (binding === undefined || binding.threadId === undefined)
      return { ok: false, code: "E_THR_UNKNOWN", effect: "none" };
    // §6.8: the binding must still point at THIS session and not be offline.
    if (binding.sessionId === undefined || binding.offline !== undefined)
      return { ok: false, code: "E_THR_STATE", effect: "none" };
    if (binding.sessionId !== input.sessionId) return { ok: false, code: "E_THR_REBOUND", effect: "none" };
    // §6.8: only a thread this run actively subscribes to — enforced whenever the hub has seen
    // a threads slot from this agent (fail-open before the first status, fail-closed after).
    if (threadsCapSeen.has(input.agentKey)) {
      const slot = statusThreads.get(input.agentKey)?.find((s) => s.h === input.h);
      if (slot === undefined || !slot.subs.some((r) => r.runId === input.by.runId))
        return { ok: false, code: "E_THR_UNKNOWN", effect: "none" };
    }
    const last = deps.state.requests
      .list()
      .filter((r) => r.bindingKey === binding.key && r.state !== "merged" && r.threadId === binding.threadId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (last === undefined) return { ok: false, code: "E_THR_UNKNOWN", effect: "none" };
    let notice: EnqueueNoticeInput;
    try {
      // Pure preparation is outside the side-effect boundary. A failure here cannot enqueue.
      notice = {
        target: deps.targetFor(last),
        message: renderNotice({
          label: `${deps.label(binding.sessionId)} · @${input.by.label}（run_id: ${input.by.runId}）`,
          text: input.text,
        }),
        key: `thr-post-${input.postId}`,
        laneKey: binding.chatId,
      };
    } catch {
      return { ok: false, code: "E_THR_STATE", effect: "none" };
    }
    if (rateLimited(input.h, now)) return { ok: false, code: "E_THR_RATE", effect: "none" };
    const entry: { at: number; state: "pending" | "queued" | "unknown" } = { at: now, state: "pending" };
    postSeen.set(input.postId, entry); // synchronous claim BEFORE invoking enqueue; duplicates cannot race it
    try {
      const result = await deps.enqueueNotice(notice);
      if (!result.ok && result.refused !== "unavailable") {
        // outbox.ts explicit refusals validate/rollback before commit/pump. `unavailable`
        // is DIFFERENT: enqueueNotice's outer catch can hide a throw AFTER store.add/index.
        postSeen.delete(input.postId);
        refundPostRate(input.h, now);
        return { ok: false, code: "E_THR_STATE", effect: "none" };
      }
      if (result.ok && result.durable) {
        entry.at = clock.now(); // the dedup window begins at confirmation, not while pending
        entry.state = "queued";
        return { ok: true, data: { queued: true } };
      }
      // durable:false already has in-memory intent and may later send. Never refund/resubmit.
    } catch {
      // A thrown enqueue port can fail before OR after committing/sending. Catch is not proof
      // of zero effect; retain the sole ledger entry, not a fabricated queued receipt.
    }
    entry.state = "unknown";
    return { ok: false, code: "E_THR_STATE", effect: "unknown" };
  }

  // --------------------------------------------------------------- thr_req{op:"rebind"/"acquire"} (rebind-plan r3 §4.4–§4.6, P1)

  function rebindRateLimited(h: string): boolean {
    const now = clock.now();
    const bucket = rebindBuckets.get(h) ?? { min: [], hour: [] };
    bucket.min = bucket.min.filter((t) => now - t < 60_000);
    bucket.hour = bucket.hour.filter((t) => now - t < 3_600_000);
    const limited =
      bucket.min.length >= THREAD_REBIND_RATE_PER_MIN || bucket.hour.length >= THREAD_REBIND_RATE_PER_HOUR;
    if (!limited) {
      bucket.min.push(now);
      bucket.hour.push(now);
    }
    if (rebindBuckets.size >= 64 && !rebindBuckets.has(h)) rebindBuckets.delete(rebindBuckets.keys().next().value!);
    rebindBuckets.delete(h); // LRU touch: re-insert so the existing key moves to the end (§4.5)
    rebindBuckets.set(h, bucket);
    return limited;
  }

  /** §5.4/§4.5: the thread-bearing binding behind `h` (same handle mint as `post`). */
  function bindingForHandle(secret: string, h: string): FeishuBinding | undefined {
    const binding = deps.state.bindings.list().find((b) => feishuThreadHandle(secret, b.key) === h);
    return binding?.threadId === undefined ? undefined : binding;
  }

  /** §3.2 step 3 / §4.5: ownership (holder-only) → freshness CAS → target resolution → rate
   *  limit → `transfer(..., notifyLifecycle:true)`. The dedup table is consulted FIRST (a P2
   *  retry must replay the original receipt, not trip E_THR_NO_OWNER on the moved binding). */
  async function rebind(agentKey: string, frame: ThrRebindReqFrame, reply: (res: ThrResFrame) => void): Promise<void> {
    const fail = (code: string, effect: "none" | "unknown"): void => {
      reply({ t: "thr_res", rid: frame.rid, ok: false, code, effect });
    };
    // §4.1: a rebind-off hub does not recognize the op.
    if (deps.config.rebind !== true) return fail("E_THR_STATE", "none");
    const dedupKey = `${frame.h}\u0000${frame.sessionId}\u0000${frame.to}\u0000${String(frame.fromRev)}`;
    const seen = rebindSeen.get(dedupKey);
    if (seen !== undefined) {
      // LRU touch.
      rebindSeen.delete(dedupKey);
      rebindSeen.set(dedupKey, seen);
      if (seen.state === "done" && seen.res !== undefined) {
        // §4.9 P2: replay the ORIGINAL receipt — re-stamped with the CURRENT rid so a retry
        // that minted a fresh rid still correlates (the dedup key deliberately excludes rid).
        reply({ ...seen.res, rid: frame.rid });
        return;
      }
      return fail("E_THR_PENDING", "unknown");
    }
    if (rebindSeen.size >= THREAD_REBIND_SEEN_MAX) rebindSeen.delete(rebindSeen.keys().next().value!);
    const entry: { state: "pending" | "done"; res?: ThrResFrame } = { state: "pending" };
    rebindSeen.set(dedupKey, entry);
    const finish = (res: ThrResFrame): void => {
      entry.state = "done";
      entry.res = res;
      reply(res);
    };
    const secret = deps.installation()?.installSecret;
    const binding = secret === undefined ? undefined : bindingForHandle(secret, frame.h);
    if (secret === undefined)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_STATE", effect: "none" });
    if (binding === undefined)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_NOT_BOUND", effect: "none" });
    // §4.5 #2: only the CURRENT holder may transfer this binding.
    if (binding.sessionId !== frame.sessionId)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_NO_OWNER", effect: "none" });
    // §4.5 #3 / §4.4 R3: the caller's trusted observation must still be fresh.
    if (frame.fromRev !== binding.rev)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_STALE", effect: "none" });
    const views = deps.sessionViews?.();
    const transfer = deps.transfer?.();
    if (views === undefined || transfer === undefined)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_STATE", effect: "none" });
    // §4.5 #4 / §4.6: the `to` selector resolves through the ONE ladder.
    const target = selectSession(frame.to, views, (sid) => deps.aliasOf?.(sid));
    if (!target.ok) return finish({ t: "thr_res", rid: frame.rid, ok: false, code: target.code, effect: "none" });
    // §4.5 限速 (D8/D10): per-h 3/min + 20/h, AFTER validation — every attempt that reaches the
    // write op counts, success or failure. A rate-limited request never executed, so it is NOT
    // cached as `done` (a post-window retry with the same key must be free to run).
    if (rebindRateLimited(frame.h)) {
      rebindSeen.delete(dedupKey);
      return fail("E_THR_RATE", "none");
    }
    const result = await transfer.transfer({
      key: binding.key,
      target: { sessionId: target.sessionId, label: target.label, agentKey: target.agentKey },
      expect: { sessionId: frame.sessionId, rev: frame.fromRev },
      reason: "rebound",
      notifyLifecycle: true,
    });
    if (!result.ok)
      return finish({ t: "thr_res", rid: frame.rid, ok: false, code: result.code, effect: result.effect });
    finish({
      t: "thr_res",
      rid: frame.rid,
      ok: true,
      data: {
        rebound: true,
        h: frame.h,
        sessionId: result.binding.sessionId ?? target.sessionId,
        rev: result.binding.rev,
        changed: result.changed,
        label: sanitizeHeaderField(result.binding.label ?? target.label),
      },
    });
  }

  /** §3.2 step 7 / §4.7: the ONLY trusted directory (re)entry — `{owned:true, label, rev}` iff
   *  the caller's CURRENT session holds the binding; anything else (missing binding included)
   *  is E_THR_NO_OWNER, so a former holder can never reopen its closed directory entry. */
  function acquire(frame: ThrAcquireReqFrame, reply: (res: ThrResFrame) => void): void {
    const fail = (code: string, effect: "none" | "unknown"): void => {
      reply({ t: "thr_res", rid: frame.rid, ok: false, code, effect });
    };
    if (deps.config.rebind !== true) return fail("E_THR_STATE", "none");
    const secret = deps.installation()?.installSecret;
    if (secret === undefined) return fail("E_THR_STATE", "none");
    const binding = bindingForHandle(secret, frame.h);
    if (binding === undefined || binding.sessionId !== frame.sessionId) return fail("E_THR_NO_OWNER", "none");
    reply({
      t: "thr_res",
      rid: frame.rid,
      ok: true,
      data: {
        owned: true,
        h: frame.h,
        label: sanitizeHeaderField(binding.label ?? deps.label(frame.sessionId)),
        rev: binding.rev,
      },
    });
  }

  // --------------------------------------------------------------- agent frame entry (§7.3)

  /** The agent-server interception target. Session/install rechecks happen here (§7.3 note);
   *  `handback` itself is `requests.handback` (state machine ownership). */
  async function thrReq(agentKey: string, frame: ThrReqFrame, write: (reply: ThrResFrame) => void): Promise<void> {
    const reply = (res: ThrResFrame): void => {
      try {
        write(res);
      } catch {
        /* a broken socket fails the request; nothing to clean up hub-side */
      }
    };
    if (disposed) {
      reply({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_STATE", effect: "none" });
      return;
    }
    // §7.3: the frame's sessionId must equal the agent's CURRENT live session.
    const current = deps.sessionOf(agentKey);
    if (current === undefined || current !== frame.sessionId) {
      reply({ t: "thr_res", rid: frame.rid, ok: false, code: "E_THR_STATE", effect: "none" });
      return;
    }
    if (frame.op === "post") {
      const result = await post({
        agentKey,
        h: frame.h,
        sessionId: frame.sessionId,
        by: frame.by,
        postId: frame.postId,
        text: frame.text,
      });
      reply(
        result.ok
          ? { t: "thr_res", rid: frame.rid, ok: true, data: result.data }
          : { t: "thr_res", rid: frame.rid, ok: false, code: result.code, effect: result.effect },
      );
      return;
    }
    // rebind-plan r3 §3.1/§4.4 (P1): the two rebind ops land here via the service op routing
    // (§6 实施要点 2). Both self-gate on `config.rebind` — a rebind-off hub answers E_THR_STATE.
    if (frame.op === "rebind") {
      await rebind(agentKey, frame, reply);
      return;
    }
    if (frame.op === "acquire") {
      acquire(frame, reply);
      return;
    }
    // §8.3 handback is routed by the service to requests.handback (state-machine ownership), so
    // it never lands here.
    reply({
      t: "thr_res",
      rid: frame.rid,
      ok: false,
      code: "E_THR_STATE",
      effect: "none",
    });
  }

  return {
    // FeishuThreadGate surface (used by requests.ts)
    metaFor(record: FeishuRequestRecord, agentKey: string | undefined): ThreadMeta | undefined {
      return feishuThreadMetaFor({
        record,
        agentKey,
        installSecret: deps.installation()?.installSecret,
        agentCaps: agentKey === undefined ? undefined : (deps.transport()?.getCaps(agentKey) ?? undefined),
        // rebind-plan r3 §6 实施要点 4 (P0b): the hub-side half of the rev gate.
        rebind: deps.config.rebind === true,
      });
    },
    routedResultOk(data: unknown, agentKey: string | undefined): ThreadRoutedResult | undefined {
      const parsed = parseThreadRoutedResult(data);
      if (parsed === undefined || !agentHasCap(agentKey)) return undefined;
      return parsed;
    },
    retainWouldExceed(excludeId: string, candidateBytes: number): boolean {
      const others = threadRetainedRequests(deps.state).filter((r) => r.id !== excludeId);
      return (
        others.length >= THREAD_RETAIN_MAX_REQUESTS ||
        threadRetainBytes(others) + candidateBytes > THREAD_RETAIN_MAX_BYTES
      );
    },
    thrReq,
    onRouted,
    onRestartRetained,
    onBindingClosed,
    pushInstallReset,
    onStatus,
    threadLinesFor,
    dispose() {
      disposed = true;
      for (const t of retainTimers.values()) clock.clearTimeout(t);
      retainTimers.clear();
      closedSeen.clear();
      receiptSeen.clear();
      statusThreads.clear();
      postSeen.clear();
      postBuckets.clear();
      rebindBuckets.clear();
      rebindSeen.clear();
    },
    get retainedCount(): number {
      return retainTimers.size;
    },
  };
}

export type FeishuThreads = ReturnType<typeof createFeishuThreads>;
