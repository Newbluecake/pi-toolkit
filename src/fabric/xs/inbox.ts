import { systemClock, type Clock } from "../../core/clock.js";

/**
 * fabric phase-2 X4 (phase2-plan §8.4, review #7): the receiver's cross-session inbox
 * accounting — COMPLETELY INDEPENDENT of the tree-internal `FabricRouter.rootInbox()` counter
 * (which counts outbox records and stays byte-for-byte untouched; the cross test in
 * `tests/fabric/xs-inbox.test.ts` pins the independence both ways).
 *
 * Every accepted message (`applied`, or `unknown{queued|start_deferred}` — i.e. every message
 * that may have entered the session) records one entry `{xid, acceptedAt, mode}`. Release rule
 * (§8.4, the ONE sentence): an entry releases when its message is provably inside some run's
 * context AND that run has ended:
 *
 *   - `appended` (idle deliver-only; pi appended synchronously, Fpi7): released when a run
 *     that started AFTER acceptance ends.
 *   - `queued` (deliver-only while streaming; pi keeps it in the in-memory flush queue, Fpi7):
 *     same mechanics — `onRunStart` marks entries with `acceptedAt < runStartAt` as in-context,
 *     that run's `onRunSettled` releases the marked ones.
 *   - `trigger` (Controller dispatch): released when the Controller returns to idle
 *     (`releaseTrigger()`); a trigger run also passes through onRunStart/onRunSettled like any
 *     other run, which releases it as soon as its own run-end evidence arrives.
 *
 * `session_start ⇒ clear` (new stack): the XW assembly calls `clear()`; entries never persist.
 * Per-stack memory only, cap `inboxCap` (1..64, default 12) — full ⇒ the receiver refuses with
 * `none{inbox_full}` (§8.4 stage 6). Pi-free; no timers (nothing here is time-driven).
 */

export type XsInboxMode = "appended" | "queued" | "trigger";

export interface XsInboxEntry {
  readonly xid: string;
  readonly acceptedAt: number;
  readonly mode: XsInboxMode;
  /** Marked at `before_agent_start` once the entry predates the run start (§8.4 queued rule). */
  readonly inContext: boolean;
  readonly released: boolean;
}

export class XsInbox {
  private readonly entries: XsInboxEntry[] = [];

  constructor(
    readonly cap: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError("invalid xs inbox cap");
  }

  /** Entries not yet released (what `inboxCap` counts against). */
  get occupied(): number {
    return this.entries.filter((e) => !e.released).length;
  }

  isFull(): boolean {
    return this.occupied >= this.cap;
  }

  /**
   * Record an accepted message (§8.4 stage 8 accounting). Returns false when the inbox is
   * already full — the receiver checks `isFull()` at stage 6, so a false here is a defensive
   * signal (the caller decides; the entry is NOT recorded).
   */
  accept(xid: string, mode: XsInboxMode): boolean {
    if (this.isFull()) return false;
    this.entries.push({ xid, acceptedAt: this.clock.now(), mode, inContext: false, released: false });
    return true;
  }

  /**
   * `before_agent_start` for a run that started at `runStartAt`: every unreleased entry
   * accepted strictly before that instant is now inside the run's context (§8.4) — the run's
   * context is built from the session branch, which contains the appended/flushed message.
   */
  onRunStart(runStartAt: number = this.clock.now()): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (!entry.released && !entry.inContext && entry.acceptedAt < runStartAt) {
        this.entries[i] = { ...entry, inContext: true };
      }
    }
  }

  /**
   * `agent_settled`: release every in-context entry — the run whose context contained it has
   * ended, which is the release proof for `appended`/`queued` (and for a `trigger` entry whose
   * run-end evidence arrives here). Returns how many released.
   */
  onRunSettled(): number {
    let released = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (!entry.released && entry.inContext) {
        this.entries[i] = { ...entry, released: true };
        released++;
      }
    }
    this.compact();
    return released;
  }

  /**
   * Controller back to idle: release remaining `trigger` entries (the wake run ended — proof is
   * the Controller's own idle evidence, which can lag `agent_settled`). XW wires this to the
   * controller's idle transition; safe to call repeatedly.
   */
  releaseTrigger(): number {
    let released = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (!entry.released && entry.mode === "trigger") {
        this.entries[i] = { ...entry, released: true };
        released++;
      }
    }
    this.compact();
    return released;
  }

  /** `session_start` ⇒ fresh stack, fresh accounting (§8.4). */
  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): readonly XsInboxEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Keep the array bounded: drop released entries wherever they sit (an unreleased entry
   * must never pin released ones behind it — a wedged controller could otherwise accumulate
   * them for the whole session). */
  private compact(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.released) this.entries.splice(i, 1);
    }
  }
}
