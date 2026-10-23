/**
 * web-hub-preview-windows plan r2 §4.5 (评审 #11, W1): the GLOBAL cross-window history
 * snapshot byte budget. Every navigation snapshot a window pushes onto its own 64-deep stack
 * is registered here; once the running total exceeds `maxBytes` the OLDEST entries are
 * demoted to "stubs" (`{stub:{path, dir}}`) through the owning machine's callback — the
 * snapshot's memory is released and `back()` refetches the path instead of restoring it.
 *
 * Pure class, no DOM/Vue/timers: the manager (`usePreviewWindows`) owns exactly one instance
 * for all windows (single-window `usePreview` never wires one — behavior unchanged). Entries
 * are identified by `(winId, token)` because tokens are per-machine counters; `stub(token)`
 * is handed back to the machine that registered the entry, so it stays meaningful inside
 * that machine's own stack.
 *
 * Byte estimation (§4.5): image → `dataUrl.length`; text → the demoted stream's chunk char
 * counts (no stream ⇒ `text.length`); dir → `entries.length × 128`. `estimateSnapshotBytes`
 * is structural (no UI-type imports — the logic layer stays DOM-free).
 *
 * Budgets: desktop 96 MiB, touch (coarse) 32 MiB. The per-window DEPTH cap stays
 * `PREVIEW_NAV_STACK_MAX` (64) — this ledger only bounds bytes, never depth.
 */

/** Desktop (fine pointer) history budget — plan §4.5. */
export const PREVIEW_HISTORY_BUDGET_DESKTOP = 96 * 1024 * 1024;
/** Touch (coarse pointer) history budget — plan §4.5. */
export const PREVIEW_HISTORY_BUDGET_TOUCH = 32 * 1024 * 1024;

export function historyBudgetFor(coarse: boolean): number {
  return coarse ? PREVIEW_HISTORY_BUDGET_TOUCH : PREVIEW_HISTORY_BUDGET_DESKTOP;
}

/** One registered snapshot. `stub` is the owning machine's demote callback (idempotent). */
export interface PreviewHistoryEntry {
  readonly winId: number;
  readonly token: number;
  readonly bytes: number;
  readonly stub: (token: number) => void;
}

export class PreviewHistoryBudget {
  private readonly entries: PreviewHistoryEntry[] = []; // index 0 = oldest (FIFO)
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** Current registered total (post-eviction) — tests and telemetry only. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Number of live (non-demoted, non-removed) entries. */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Register a snapshot, then evict from the OLDEST end while over budget. The just-added
   * entry is not privileged: a single entry larger than the whole budget demotes itself.
   */
  add(e: PreviewHistoryEntry): void {
    this.entries.push(e);
    this.totalBytes += e.bytes;
    while (this.totalBytes > this.maxBytes && this.entries.length > 0) {
      const oldest = this.entries.shift()!;
      this.totalBytes -= oldest.bytes;
      try {
        oldest.stub(oldest.token); // never let a misbehaving machine break the ledger
      } catch {
        // swallowed on purpose — the entry is already gone from the ledger
      }
    }
  }

  /** The entry left the stack legitimately (back() popped it / FIFO shift / clear). */
  remove(winId: number, token: number): void {
    const i = this.entries.findIndex((e) => e.winId === winId && e.token === token);
    if (i < 0) return;
    const gone = this.entries.splice(i, 1)[0]!; // i just found ⇒ exactly one removed
    this.totalBytes -= gone.bytes;
  }

  /** Every entry of one window — its stack was cleared / the window closed. No stub calls. */
  dropWindow(winId: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.winId === winId) {
        const gone = this.entries.splice(i, 1)[0]!;
        this.totalBytes -= gone.bytes;
      }
    }
  }
}

/** The structural slice `estimateSnapshotBytes` needs (assignable from `PreviewViewDir`). */
export type PreviewHistorySnapshot =
  | { readonly phase: "image"; readonly dataUrl: string }
  | { readonly phase: "text"; readonly text: string; readonly stream?: { chunks: readonly string[] } }
  | { readonly phase: "dir"; readonly listing: { entries: readonly unknown[] } };

/** §4.5's byte estimation — call AFTER `demoteStream` (the text branch then counts one chunk). */
export function estimateSnapshotBytes(v: PreviewHistorySnapshot): number {
  if (v.phase === "image") return v.dataUrl.length;
  if (v.phase === "text") {
    if (v.stream !== undefined) {
      let n = 0;
      for (const c of v.stream.chunks) n += c.length;
      return n;
    }
    return v.text.length;
  }
  return v.listing.entries.length * 128;
}
