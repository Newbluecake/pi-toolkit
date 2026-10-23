/**
 * web-hub-preview-windows plan r2 §8.2 (W3): the tab-scoped HTML capability ledger — a pure,
 * DOM/Vue-free lower-bound SIMULATION of the hub's per-principal capability FIFO
 * (`hub/preview/html-cap.ts`: `PV_CAPS_PER_PRINCIPAL` live caps, evicted FIFO by mint order,
 * eviction aborts in-flight requests, no release endpoint in the first version — user 拍板 1).
 *
 * Why a simulation at all: an old rendered window A can be silently evicted by 8 later mints
 * in the same login (other windows' 「重新加载」, source↔render toggles — even in other tabs).
 * The hub cannot tell the UI, so the UI keeps its own account: deterministic for this tab's
 * own mints, blind to other tabs (a false "maybe" is acceptable; the notice always says
 * 「可能」). All TTL/cap constants are imported from `@protocol/preview-html.js`, never
 * re-typed here.
 *
 * Model:
 * - `minted(token, now)` — first EXPIRES entries (any entry at `mintedAt + PV_HARD_TTL_MS`;
 *   unmounted entries at `unmountedAt + PV_IDLE_TTL_MS` — an unmounted preview still occupies
 *   a hub slot because the hub does not know it closed), then, while `live ≥
 *   PV_CAPS_PER_PRINCIPAL`, marks the OLDEST live entry `evicted` (exactly the hub's mint-time
 *   eviction), then enqueues the new entry (fresh mints are never evicted — 重新加载 clears
 *   the notice because it IS a new token).
 * - `unmounted(token, now)` — records `unmountedAt`; the entry KEEPS occupying its slot until
 *   the idle TTL above cleans it.
 * - `evictedOf(token)` — `true` only while the recorded entry is flagged evicted; an
 *   expired-cleaned entry answers `false` (the cap is dead by TTL and PreviewHtml's own
 *   「链接已过期」 banner already covers that).
 */
import { PV_CAPS_PER_PRINCIPAL, PV_HARD_TTL_MS, PV_IDLE_TTL_MS } from "@protocol/preview-html.js";

interface HtmlCapEntry {
  readonly token: string;
  readonly mintedAt: number;
  unmountedAt: number | null;
  evicted: boolean;
}

/** Diagnostics/tests: a frozen view of one entry. */
export interface HtmlCapLedgerEntry {
  readonly token: string;
  readonly mintedAt: number;
  readonly unmountedAt: number | null;
  readonly evicted: boolean;
}

export class HtmlCapLedger {
  /** Every live (non-evicted, non-expired) entry, in mint order — the FIFO the cap guards. */
  private readonly fifo: HtmlCapEntry[] = [];
  /** Every token ever seen, including evicted ones (kept only so `evictedOf` keeps answering). */
  private readonly byToken = new Map<string, HtmlCapEntry>();

  constructor(
    private readonly cap: number = PV_CAPS_PER_PRINCIPAL,
    private readonly idleTtlMs: number = PV_IDLE_TTL_MS,
    private readonly hardTtlMs: number = PV_HARD_TTL_MS,
  ) {}

  minted(token: string, now: number): void {
    this.expireUpTo(now);
    // A repeated token (transport defect / a test) replaces its own record instead of
    // double-occupying the FIFO.
    const prev = this.byToken.get(token);
    if (prev !== undefined) {
      const i = this.fifo.indexOf(prev);
      if (i >= 0) this.fifo.splice(i, 1);
      this.byToken.delete(token);
    }
    while (this.fifo.length >= this.cap) {
      const oldest = this.fifo.shift();
      if (oldest === undefined) break;
      oldest.evicted = true;
    }
    const entry: HtmlCapEntry = { token, mintedAt: now, unmountedAt: null, evicted: false };
    this.byToken.set(token, entry);
    this.fifo.push(entry);
  }

  unmounted(token: string, now: number): void {
    const entry = this.byToken.get(token);
    if (entry === undefined) return;
    entry.unmountedAt = now;
  }

  evictedOf(token: string): boolean {
    return this.byToken.get(token)?.evicted === true;
  }

  /** Live (occupying) entries in mint order — includes unmounted-but-not-yet-idle-expired. */
  liveEntries(): readonly HtmlCapLedgerEntry[] {
    return this.fifo.map((e) => ({ ...e }));
  }

  liveCount(): number {
    return this.fifo.length;
  }

  /** Drop entries past either TTL; called from `minted` (the hub only re-evaluates on mints). */
  private expireUpTo(now: number): void {
    for (let i = this.fifo.length - 1; i >= 0; i--) {
      const e = this.fifo[i];
      if (e === undefined) continue;
      const idleDead = e.unmountedAt !== null && now >= e.unmountedAt + this.idleTtlMs;
      const hardDead = now >= e.mintedAt + this.hardTtlMs;
      if (!idleDead && !hardDead) continue;
      this.fifo.splice(i, 1);
      this.byToken.delete(e.token);
    }
  }
}
