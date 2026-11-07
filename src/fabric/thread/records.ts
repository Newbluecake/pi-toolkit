/**
 * fabric-thread P1 (arch r3 §3.1/§6.7, review #9): EventRecord — ONE event's event-level
 * aggregate across ALL its subscribers — plus the bounded table that owns dedup and retention.
 *
 * The record is the DEDUP SLOT (§6.5: “入队的同一个同步步骤里先创建 EventRecord，占住去重位”) and
 * the auto-return ledger. It deliberately does NOT track whether the hub still retains the
 * original — that fact is decided only by the hub at handback time (r3-7).
 *
 * Retention (§6.7): a record stays until judged (all per-sub outcomes determined) AND the
 * handback window (H from `deliveredAt`) has passed; UNDETERMINED records are never evicted; the
 * table holds at most 64 and a full table sends new events down the R5 native path.
 */
import type { HandbackState, Outcome, ThreadEventId, ThreadHandle } from "./types.js";
import { outcomeDetermined } from "./outcome.js";

export const THREAD_EVENT_RECORDS_MAX = 64;

export interface EventRecord {
  readonly eventId: ThreadEventId;
  readonly h: ThreadHandle;
  /** §6.5 帧到达 — the R0–R5 synchronous pass moment. */
  readonly receivedAt: number;
  /** §6.5 absolute deadline (lane wait + per-run wait + steer share it). */
  readonly deadlineAt: number;
  /** subId → Outcome. An ABSENT entry means “not yet handed to that subscriber” (lane-owned). */
  readonly perSub: Map<string, Outcome>;
  /** all present outcomes determined (§6.7 判定完成). */
  judged: boolean;
  /** first hub reply sent (routed or fallback). */
  replied: boolean;
  replyKind: "routed" | "fallback" | undefined;
  /** routed-reply time — the H window anchor (§5.5) and the S buffer-TTL anchor (§6.5). */
  deliveredAt: number | undefined;
  /** §3.1 handback state for the (explicit or system) attempt on this event. */
  handback: HandbackState | undefined;
  /** at-most-once latch for the system auto-return (§6.7 — property-pinned). */
  autoReturned: boolean;
  /** §6.5 晚到结果 display upgrade: a late `queued` settle after `unknown`. Audit-only. */
  displayUpgradedTo: "queued" | undefined;
}

export class EventRecordTable {
  private readonly table = new Map<ThreadEventId, EventRecord>();

  constructor(
    readonly capacity: number = THREAD_EVENT_RECORDS_MAX,
    private readonly handbackWindowMs: number = 10 * 60_000,
  ) {}

  get size(): number {
    return this.table.size;
  }

  get(eventId: ThreadEventId): EventRecord | undefined {
    return this.table.get(eventId);
  }

  has(eventId: ThreadEventId): boolean {
    return this.table.has(eventId);
  }

  /** §6.7 evictable: judged ∧ (never routed ∨ handback window passed). Insertion-ordered. */
  private isEvictable(record: EventRecord, now: number): boolean {
    if (!record.judged) return false;
    if (record.deliveredAt === undefined) return true;
    return now - record.deliveredAt >= this.handbackWindowMs;
  }

  evictableCount(now: number): number {
    let n = 0;
    for (const r of this.table.values()) if (this.isEvictable(r, now)) n++;
    return n;
  }

  /** Can a new event be admitted without evicting? (§6.3 R5 input — same sweep as insert.) */
  canInsert(now: number): boolean {
    if (this.table.size < this.capacity) return true;
    return this.evictableCount(now) > 0;
  }

  /** Create the dedup slot. Sweeps evictable records first; returns `undefined` when the table
   *  is full with nothing evictable ⇒ the caller takes the R5 native path (§6.7). */
  insert(
    eventId: ThreadEventId,
    h: ThreadHandle,
    receivedAt: number,
    deadlineAt: number,
    now: number,
  ): EventRecord | undefined {
    if (this.table.has(eventId)) return undefined; // callers pre-check; defensive double-guard
    if (!this.canInsert(now)) return undefined;
    if (this.table.size >= this.capacity) {
      for (const [id, r] of this.table) {
        if (this.isEvictable(r, now)) {
          this.table.delete(id);
          if (this.table.size < this.capacity) break;
        }
      }
    }
    const record: EventRecord = {
      eventId,
      h,
      receivedAt,
      deadlineAt,
      perSub: new Map(),
      judged: false,
      replied: false,
      replyKind: undefined,
      deliveredAt: undefined,
      handback: undefined,
      autoReturned: false,
      displayUpgradedTo: undefined,
    };
    this.table.set(eventId, record);
    return record;
  }

  /** §6.7 判定完成: every present outcome determined (an empty perSub is NOT judged — the
   *  engine fills it at dispatch or at the lane-wait deadline). */
  static refreshJudged(record: EventRecord): boolean {
    if (record.perSub.size === 0) {
      record.judged = false;
      return false;
    }
    record.judged = true;
    for (const o of record.perSub.values()) {
      if (!outcomeDetermined(o)) {
        record.judged = false;
        break;
      }
    }
    return record.judged;
  }

  list(): EventRecord[] {
    return [...this.table.values()];
  }
}
