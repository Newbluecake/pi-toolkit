/**
 * Archive state model for the web-hub fleet drawer's Agents/Bash lists
 * (docs/dev/web-hub/archive-report.md). Pure, pi-free — no I/O, no timers;
 * `control.ts` owns the wiring and persistence.
 *
 * Model (todo-archive's full-snapshot-per-change precedent, `src/todo/`):
 * - `entries`: the currently-archived items (kind run|bash). Presence = archived;
 *   `auto` marks a sweep-archived item so the UI can badge it.
 * - `horizon` (#91): a per-kind monotone settled-epoch-ms watermark. Terminal
 *   items settled at/below their kind's horizon are IMPLICITLY archived — never
 *   selected by the sweep, not counted toward keep. The watermark only moves up
 *   (`raiseHorizon`): every LIVE entry evicted by `trimToCap` raises its kind's
 *   horizon to the victim's settledAt, so an evicted live item can never be
 *   re-selected (no resurrect flip-flop, by construction). It is absent until
 *   the first live eviction, so sessions that never overflow write snapshots
 *   byte-identical to the pre-#91 shape.
 * - `held`: items the user explicitly UNARCHIVED. They are exempt from
 *   auto-archive forever (otherwise a 31-minute-old run unarchived at 12:31
 *   would be re-archived by the very next sweep — the unarchive would be a
 *   no-op). Re-archiving manually (or a fresh archive of the same id) clears
 *   the hold. A hold also beats the horizon: held items still count toward
 *   keep and stay visible even when settled below the watermark.
 *
 * The whole state is persisted as one `subagent:archive` session entry per
 * change (`pi.appendEntry`), read back through `getBranch()` taking the LAST
 * valid candidate — the exact todo/prompt-sections discipline. /reload and
 * cross-browser consistency fall out of "the session file is the truth".
 * A commit whose content equals the last PERSISTED snapshot writes nothing
 * (`sameArchiveState` vs the control's per-instance baseline, #89 A1).
 */
export type ArchiveKind = "run" | "bash";

/** One archived item. `auto` ⇔ archived by the after-N-minutes sweep. */
export interface ArchiveEntry {
  kind: ArchiveKind;
  id: string;
  /** Epoch-ms archive instant (agent clock). */
  at: number;
  auto?: true;
}

/** A user-unarchived item: exempt from auto-archive. */
export interface ArchiveHold {
  kind: ArchiveKind;
  id: string;
  at: number;
}

export interface ArchiveState {
  entries: ArchiveEntry[];
  held: ArchiveHold[];
  /** #91 monotone settled watermark per kind; absent ⇔ −∞ for both kinds
   *  (exactOptionalPropertyTypes: the key is simply not written). */
  horizon?: ArchiveHorizon;
}

/** Epoch-ms settled watermark per kind; an absent key ⇔ −∞. Monotone non-decreasing. */
export interface ArchiveHorizon {
  run?: number;
  bash?: number;
}

/** FIFO caps. 256 archived rows is already far beyond what the drawer can show. */
export const ARCHIVE_ENTRIES_CAP = 256;
export const ARCHIVE_HELD_CAP = 256;

export const ARCHIVE_ENTRY_TYPE = "subagent:archive";

export function emptyArchiveState(): ArchiveState {
  return { entries: [], held: [] };
}

/** The kind's watermark, −∞ when unset (compare with `<=` on the caller side). */
export function horizonOf(state: ArchiveState, kind: ArchiveKind): number {
  const h = state.horizon?.[kind];
  return typeof h === "number" && Number.isFinite(h) ? h : -Infinity;
}

/** Monotone raise: `horizon[kind] = max(current, settledAt)`, the other kind untouched. */
export function raiseHorizon(h: ArchiveHorizon | undefined, kind: ArchiveKind, settledAt: number): ArchiveHorizon {
  if (kind === "run") {
    const cur = h?.run;
    return { ...h, run: cur !== undefined && cur >= settledAt ? cur : settledAt };
  }
  const cur = h?.bash;
  return { ...h, bash: cur !== undefined && cur >= settledAt ? cur : settledAt };
}

export function sameItem(a: { kind: ArchiveKind; id: string }, b: { kind: ArchiveKind; id: string }): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// ---------------------------------------------------------------------------
// sanitize / read-back
// ---------------------------------------------------------------------------

const KINDS: readonly ArchiveKind[] = ["run", "bash"];

function sanitizeEntry(input: unknown): ArchiveEntry | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const e = input as { kind?: unknown; id?: unknown; at?: unknown; auto?: unknown };
  if (e.kind !== "run" && e.kind !== "bash") return undefined;
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 128) return undefined;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return undefined;
  return e.auto === true ? { kind: e.kind, id: e.id, at: e.at, auto: true } : { kind: e.kind, id: e.id, at: e.at };
}

function sanitizeHold(input: unknown): ArchiveHold | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const h = input as { kind?: unknown; id?: unknown; at?: unknown };
  if (h.kind !== "run" && h.kind !== "bash") return undefined;
  if (typeof h.id !== "string" || h.id.length === 0 || h.id.length > 128) return undefined;
  if (typeof h.at !== "number" || !Number.isFinite(h.at)) return undefined;
  return { kind: h.kind, id: h.id, at: h.at };
}

/** #91: a bad horizon loses only its own field(s), never the snapshot; both kinds
 *  invalid/absent ⇒ the `horizon` key is not written (pre-#91 snapshots read back
 *  byte-identical). */
function sanitizeHorizon(input: unknown): ArchiveHorizon | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as { run?: unknown; bash?: unknown };
  const out: ArchiveHorizon = {};
  if (typeof raw.run === "number" && Number.isFinite(raw.run)) out.run = raw.run;
  if (typeof raw.bash === "number" && Number.isFinite(raw.bash)) out.bash = raw.bash;
  return out.run !== undefined || out.bash !== undefined ? out : undefined;
}

/** Validate a persisted snapshot; `undefined` ⇒ not a valid candidate (skip it). */
export function sanitizeArchiveState(input: unknown): ArchiveState | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const raw = input as { entries?: unknown; held?: unknown };
  if (!Array.isArray(raw.entries)) return undefined;
  const entries: ArchiveEntry[] = [];
  for (const item of raw.entries) {
    const e = sanitizeEntry(item);
    if (e === undefined) continue; // tolerate a single bad row, keep the snapshot
    entries.push(e);
  }
  const held: ArchiveHold[] = Array.isArray(raw.held)
    ? (raw.held.map(sanitizeHold).filter((h): h is ArchiveHold => h !== undefined) as ArchiveHold[])
    : [];
  const horizon = sanitizeHorizon((raw as { horizon?: unknown }).horizon);
  return {
    entries: entries.slice(-ARCHIVE_ENTRIES_CAP) as ArchiveEntry[],
    held: held.slice(-ARCHIVE_HELD_CAP) as ArchiveHold[],
    ...(horizon !== undefined ? { horizon } : {}),
  };
}

/** Read the archive state off a session branch (`getBranch()`): the LAST valid
 * `subagent:archive` entry wins, same as todo's replay. Unknown shapes ⇒ empty. */
export function readArchiveState(branch: readonly unknown[]): ArchiveState {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry?.type !== "custom" || entry.customType !== ARCHIVE_ENTRY_TYPE) continue;
    const clean = sanitizeArchiveState(entry.data);
    if (clean !== undefined) return clean;
  }
  return emptyArchiveState();
}

// ---------------------------------------------------------------------------
// mutations (pure: return the NEXT state, or undefined when nothing changed)
// ---------------------------------------------------------------------------

function capTail<T>(list: readonly T[], cap: number): readonly T[] {
  return list.length > cap ? list.slice(list.length - cap) : list;
}

export interface ArchiveMutation {
  kind: ArchiveKind;
  id: string;
  /** `true` ⇒ sweep-archived (badged `auto` in the UI); manual archives pass `false`. */
  auto: boolean;
  now: number;
}

/** Fold ONE archive into the state. `cap` (default the snapshot cap) bounds the
 *  entries tail; the sweep and the manual paths pass `Infinity` and let
 *  `trimToCap` (sweep.ts) own eviction, so capacity is decided in exactly one
 *  place (#91). The horizon passes through untouched (a manual archive of an
 *  implicitly-archived id is allowed and harmless). */
export function archiveItem(
  state: ArchiveState,
  mut: ArchiveMutation,
  cap: number = ARCHIVE_ENTRIES_CAP,
): ArchiveState | undefined {
  if (mut.id.length === 0 || mut.id.length > 128) return undefined;
  const existing = state.entries.find((e) => sameItem(e, mut));
  if (existing !== undefined) {
    const sameAuto = (existing.auto === true) === mut.auto;
    if (sameAuto) return undefined; // idempotent — no entry, no persist
  }
  const entries: ArchiveEntry[] = state.entries.filter((e) => !sameItem(e, mut));
  entries.push(
    mut.auto ? { kind: mut.kind, id: mut.id, at: mut.now, auto: true } : { kind: mut.kind, id: mut.id, at: mut.now },
  );
  // A manual/auto (re-)archive lifts the auto-exemption hold.
  const held = state.held.filter((h) => !sameItem(h, mut));
  return {
    entries: capTail(entries, cap) as ArchiveEntry[],
    held: capTail(held, ARCHIVE_HELD_CAP) as ArchiveHold[],
    ...(state.horizon !== undefined ? { horizon: state.horizon } : {}),
  };
}

export function unarchiveItem(
  state: ArchiveState,
  item: { kind: ArchiveKind; id: string },
  now: number,
): ArchiveState | undefined {
  if (!state.entries.some((e) => sameItem(e, item))) return undefined;
  const entries = state.entries.filter((e) => !sameItem(e, item));
  const held = state.held.filter((h) => !sameItem(h, item));
  held.push({ kind: item.kind, id: item.id, at: now });
  return {
    entries: capTail(entries, ARCHIVE_ENTRIES_CAP) as ArchiveEntry[],
    held: capTail(held, ARCHIVE_HELD_CAP) as ArchiveHold[],
    ...(state.horizon !== undefined ? { horizon: state.horizon } : {}),
  };
}

// ---------------------------------------------------------------------------
// equality
// ---------------------------------------------------------------------------

/** Ordered, field-by-field equality of two archive states — the #89 A1 write-dedup
 *  guard: a commit whose content equals the last PERSISTED snapshot must not append
 *  again. Plain comparison on purpose, no hash: 256×4 scalars is microsecond-level,
 *  and hashing would need a canonicalize pass first (the explore report's `canonicalJson`
 *  hotspot). `at` PARTICIPATES — this compares what the snapshot would literally contain,
 *  not "the same ids"; an at-only rewrite (the 998dce27 form) is NOT suppressed here, it
 *  is outlawed by tests/archive/write-rate.test.ts, because the honest fix for it is
 *  convergence (cd57bdf9), not silent dedup. `auto` is compared as truthiness, so an
 *  absent flag equals an explicit `false`/`undefined` (sanitize normalizes to absent).
 *  `horizon` participates too (#91): it IS semantic state (a horizon-only change is a
 *  real write, e.g. the one-shot post-upgrade first sweep), with undefined == undefined
 *  per kind. */
export function sameArchiveState(a: ArchiveState, b: ArchiveState): boolean {
  if (a.entries.length !== b.entries.length || a.held.length !== b.held.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i]!;
    const y = b.entries[i]!;
    if (x.kind !== y.kind || x.id !== y.id || x.at !== y.at) return false;
    if ((x.auto === true) !== (y.auto === true)) return false;
  }
  for (let i = 0; i < a.held.length; i++) {
    const x = a.held[i]!;
    const y = b.held[i]!;
    if (x.kind !== y.kind || x.id !== y.id || x.at !== y.at) return false;
  }
  if (a.horizon?.run !== b.horizon?.run || a.horizon?.bash !== b.horizon?.bash) return false;
  return true;
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

export function archivedSetOf(state: ArchiveState, kind: ArchiveKind): Set<string> {
  const ids = new Set<string>();
  for (const e of state.entries) if (e.kind === kind) ids.add(e.id);
  return ids;
}

export function isArchived(state: ArchiveState, item: { kind: ArchiveKind; id: string }): boolean {
  return state.entries.some((e) => sameItem(e, item));
}

/** A terminal item auto-archive-eligible NOW? (terminal + past the threshold +
 *  not archived + not held + settled ABOVE the kind's horizon — implicitly-archived
 *  items are never re-selected). The caller supplies terminality and the settle
 *  instant — the state layer only knows archives, holds and horizons. */
export function autoArchiveDue(
  state: ArchiveState,
  item: { kind: ArchiveKind; id: string },
  settledAt: number,
  now: number,
  afterMs: number,
): boolean {
  if (afterMs <= 0) return false;
  if (isArchived(state, item)) return false;
  if (state.held.some((h) => sameItem(h, item))) return false;
  if (settledAt <= horizonOf(state, item.kind)) return false;
  return now - settledAt >= afterMs;
}
