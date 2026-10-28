/**
 * bash-jobs-panel plan §3.4 (包 A): the `StatusInfo.bashJobs` projection — selection (D1), row
 * content (D2/D2a), the light fingerprint (D3-1) and the byte budget (D6) — all pure functions,
 * zero pi imports (only `import type JobRecord` + `isTerminalJobStatus` from `../../bash/types.js`,
 * which is itself pi-free).
 *
 * Selection (D1): the viewed session process's own `BashJobManager.list()` — foreground rows
 * (`backgroundedAt === undefined`) never cross the wire; terminal rows older than the store's
 * retention window are filtered with the SAME formula `job-store.ts`'s `pruneExpired` uses
 * (`now - (endedAt ?? createdAt) >= retentionMs`, `retentionMs <= 0` = off), because retention
 * only prunes disk — `list()` happily returns expired terminal records forever. Non-terminal
 * rows sort first (createdAt desc), then terminal (endedAt ?? createdAt desc); 20 rows total,
 * ≤12 terminal, the rest counted into `omitted`.
 *
 * Archive-aware `omitted` (2026-10-28 rework): `omitted` counts only terminal rows that are
 * neither in `rows` NOR archived — archiving is display-only hiding, so an archived row must
 * stop counting as "omitted" the moment the user archives it (otherwise the `(+N more)` line
 * never goes away and the button is a no-op from the user's point of view). Running rows pushed
 * out by the 20-row cap / the byte budget are counted separately in `rowsOverflowRunning`
 * (they are not archivable, so they must never inflate `omitted`).
 *
 * Budget (D6): the budget object is ONLY the `BashJobsWire` slot value, measured by
 * `bashJobsWireBytes` (`JSON.stringify` byte length, escape inflation included) — the same
 * function the unit tests and the conformance suite assert with. Five-pass trim ladder, see
 * `fitBudget`.
 */
import { isTerminalJobStatus, type JobRecord } from "../../bash/types.js";
import { truncateText } from "../protocol/keys.js";
import type { BashJobRowWire, BashJobsWire } from "../protocol/messages.js";
import { capTailText, redactCommand, TAIL_MAX_LINES, TAIL_READ_WINDOW_BYTES } from "./redact.js";

/** D1: max rows in the wire (schema headroom is 64). */
export const BASH_JOBS_MAX_ROWS = 20;
/** D1: max terminal rows within those 20. */
export const BASH_JOBS_MAX_TERMINAL_ROWS = 12;
/** D6: hard byte budget of the `bashJobs` slot value (24 KiB). */
export const BASH_JOBS_WIRE_BUDGET_BYTES = 24 << 10;
/** D6 per-field caps. */
export const BASH_JOBS_ID_MAX_BYTES = 32;
export const BASH_JOBS_STATUS_MAX_BYTES = 32;
/** D6 budget ladder: tail shrink target (last 3 lines / ≤256 B, passes ① and ③). */
const BUDGET_TAIL_SHRINK_LINES = 3;
const BUDGET_TAIL_SHRINK_BYTES = 256;

/** `selectJobs`'s result: the capped, ranked rows plus full-population counts over the
 *  retention-filtered set (never trimmed by the row caps — wire `total`/`running`/`failed`). */
export interface SelectedBashJobs {
  readonly rows: readonly JobRecord[];
  readonly total: number;
  readonly running: number;
  readonly failed: number;
  /** Terminal jobIds neither in `rows` nor archived, in wire order. `omitted` is its length —
   *  the two are computed from ONE source so they can never drift. Byte-budget drops (D6 ⑤)
   *  happen AFTER selection and are added by `projectBashJobsDetail`. */
  readonly omittedIds: readonly string[];
  readonly omitted: number;
  /** Running rows the caps/budget pushed out (never part of `omitted` — not archivable). */
  readonly rowsOverflowRunning: number;
}

/**
 * D1 selection over the manager's in-memory snapshot. Pure and total: `retentionMs <= 0` keeps
 * every terminal row, mirroring `job-store.ts`'s retention-off semantics. Ties break by jobId so
 * the row order (and therefore the fingerprint) is deterministic under test.
 */
export function selectJobs(
  records: readonly JobRecord[],
  now: number,
  retentionMs: number,
  archived?: ReadonlySet<string>,
): SelectedBashJobs {
  const ranked = rankJobs(records, now, retentionMs);
  const { nonTerminal, terminal } = ranked;
  const rows: JobRecord[] = [];
  let terminalCount = 0;
  let runningCount = 0;
  for (const r of nonTerminal) {
    if (rows.length >= BASH_JOBS_MAX_ROWS) break;
    rows.push(r);
    runningCount += 1;
  }
  for (const r of terminal) {
    if (rows.length >= BASH_JOBS_MAX_ROWS || terminalCount >= BASH_JOBS_MAX_TERMINAL_ROWS) break;
    rows.push(r);
    terminalCount += 1;
  }
  const cappedOmittedIds = terminal
    .slice(terminalCount)
    .filter((r) => archived?.has(r.jobId) !== true)
    .map((r) => r.jobId);
  return {
    rows,
    total: ranked.total,
    running: nonTerminal.length,
    failed: terminal.filter((r) => r.status !== "completed").length,
    omittedIds: cappedOmittedIds,
    omitted: cappedOmittedIds.length,
    rowsOverflowRunning: nonTerminal.length - runningCount,
  };
}

/**
 * The wire's ranking, extracted so `selectJobs` and `omittedTerminalJobIds` can never drift:
 * retention-filtered population split into non-terminal (createdAt desc) and terminal
 * ((endedAt ?? createdAt) desc), both tie-broken by jobId.
 */
function rankJobs(
  records: readonly JobRecord[],
  now: number,
  retentionMs: number,
): { readonly nonTerminal: readonly JobRecord[]; readonly terminal: readonly JobRecord[]; readonly total: number } {
  const selected = records.filter(
    (r) =>
      r.backgroundedAt !== undefined &&
      (!isTerminalJobStatus(r.status) || retentionMs <= 0 || now - (r.endedAt ?? r.createdAt) < retentionMs),
  );
  const nonTerminal = selected
    .filter((r) => !isTerminalJobStatus(r.status))
    .sort((a, b) => b.createdAt - a.createdAt || (a.jobId < b.jobId ? -1 : 1));
  const terminal = selected
    .filter((r) => isTerminalJobStatus(r.status))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt) || (a.jobId < b.jobId ? -1 : 1));
  return { nonTerminal, terminal, total: selected.length };
}

/**
 * 2026-10-28 (fleet bash 「(+N more)」 either shows or archives): the ids behind the wire's
 * `omitted` count, in wire order — terminal jobs that are neither on the wire nor archived. Its
 * length is ALWAYS `projectBashJobs(...)?.omitted ?? 0` for the same inputs: it is literally the
 * `omittedIds` half of the one projection pass, so the cap stage (20 rows / 12 terminal) and the
 * D6 ⑤ byte budget are both covered and the two can never drift. Running rows are never included
 * (not archivable: they are reported as `rowsOverflowRunning`).
 *
 * `tails` must be the same tail cache the projection is given — the byte ladder's drops depend on
 * tail sizes, so omitting it computes the answer for a tail-less wire.
 */
export function omittedTerminalJobIds(
  records: readonly JobRecord[],
  now: number,
  retentionMs: number,
  archived?: ReadonlySet<string>,
  tails?: BashJobsTails,
): string[] {
  return [...projectBashJobsDetail(records, tails, now, retentionMs, archived).omittedIds];
}

/** D3-1's per-row fingerprint tuple, as a stable string (also the wiring's changed-id diff unit). */
export function bashJobsRowSignature(record: JobRecord, now: number): string {
  const terminal = isTerminalJobStatus(record.status);
  const elapsedBucket = terminal ? 0 : Math.floor(elapsedMsOf(record, now) / 60_000);
  return JSON.stringify([
    record.jobId,
    record.status,
    record.exitCode ?? null,
    record.endedAt ?? null,
    record.deadline?.graceUntil !== undefined,
    elapsedBucket,
    terminal ? record.logBytes : -1, // running logBytes / second-level elapsed stay OUT
  ]);
}

/**
 * D3-1 light fingerprint: synchronous, computed per tick over the `selectJobs` RESULT (a
 * retention expiry changes the selection and therefore the fingerprint). Terminal rows carry
 * their `logBytes` (R3-2: after terminal only the footer patch moves it — bounded); running rows
 * do NOT carry logBytes and only the MINUTE bucket of their elapsed time, so a busy job's
 * per-second growth cannot flap the 1Hz gate.
 */
export function bashJobsLightFingerprint(selected: SelectedBashJobs, now: number): string {
  return JSON.stringify({
    rows: selected.rows.map((r) => bashJobsRowSignature(r, now)),
    count: selected.rows.length,
    omitted: selected.omitted,
    rowsOverflowRunning: selected.rowsOverflowRunning,
  });
}

/** `BashJobsWire`'s byte cost — the ONE metric the projection, unit tests and conformance share (D6). */
export function bashJobsWireBytes(w: BashJobsWire): number {
  return Buffer.byteLength(JSON.stringify(w) ?? "", "utf8");
}

/** One sampled tail, as the sampler's cache exposes it (already sanitized; `logBytes` = file size
 *  the sample itself saw — the footer-race sentinel, D3-2). `at` is absent on an
 *  unavailable-only entry (read failures ×`maxRetries`, no good sample ever landed). */
export interface BashJobsTailSample {
  readonly text?: string;
  readonly logBytes: number;
  /** Agent clock when the sample was taken. */
  readonly at?: number;
  /** Stable-mismatch settle (D3-2): file size ≠ record for `settleRounds` consecutive reads ⇒
   *  treated as current; re-read only once `record.logBytes` moves again. */
  readonly settled?: true;
  /** The read gave up (×`maxRetries` failures) at this `record.logBytes`; never `tailCurrent`. */
  readonly unavailableAtLogBytes?: number;
}

export type BashJobsTails = ReadonlyMap<string, BashJobsTailSample>;

/** Wall-clock life of a job (spawn → exit, or → now while it runs) — `stack.ts`'s formula. */
function elapsedMsOf(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

/**
 * D2/D6 projection: `records` = the current manager snapshot, `tails` = the sampler's cache for
 * the CURRENT source generation (the wiring guarantees row set and tails share one generation,
 * D3-4 ④). `archived` = this session's archived bash ids (`ArchiveControl.view().bash`) — a
 * PURELY display-side input: archived rows still occupy their wire slot (the drawer's「已归档」
 * fold needs their content to render and to un-archive), they only stop counting into `omitted`.
 * Absent ⇒ byte-identical to the pre-archive-aware projection.
 * No selected rows ⇒ `undefined` ⇒ the `bashJobs` field stays absent (byte-equal to the
 * pre-feature status shape, D5).
 */
export function projectBashJobs(
  records: readonly JobRecord[],
  tails: BashJobsTails | undefined,
  now: number,
  retentionMs: number,
  archived?: ReadonlySet<string>,
): BashJobsWire | undefined {
  return projectBashJobsDetail(records, tails, now, retentionMs, archived).wire;
}

/** `projectBashJobs`'s full result: the wire plus the two archive-side facts the command handler
 *  needs to act on exactly what the browser counted. */
export interface BashJobsProjectionDetail {
  readonly wire: BashJobsWire | undefined;
  /** Every jobId the wire's `omitted` counts (cap-stage tail + D6 ⑤ budget drops), terminal and
   *  unarchived only. `omittedIds.length === wire.omitted` ALWAYS — the `archive_omitted` op
   *  archives THIS list, not a re-derived approximation, so a click is never a no-op. */
  readonly omittedIds: readonly string[];
  /** Running rows the caps/budget pushed out; 0 ⇒ the wire carries no `rowsOverflowRunning`. */
  readonly rowsOverflowRunning: number;
}

/** `projectBashJobs` with the omitted id set attached (the same single selection pass — the
 *  projection and the op can never disagree about what `omitted` means). */
export function projectBashJobsDetail(
  records: readonly JobRecord[],
  tails: BashJobsTails | undefined,
  now: number,
  retentionMs: number,
  archived?: ReadonlySet<string>,
): BashJobsProjectionDetail {
  const selected = selectJobs(records, now, retentionMs, archived);
  if (selected.rows.length === 0) {
    return { wire: undefined, omittedIds: [], rowsOverflowRunning: selected.rowsOverflowRunning };
  }
  const terminalFlags = selected.rows.map((r) => isTerminalJobStatus(r.status));
  const rowIds = selected.rows.map((r) => r.jobId);
  const rows = selected.rows.map((record) => projectRow(record, tails, now));
  // The pre-ladder wire carries the CAP-stage counts; `fitBudget` re-derives both counters from
  // these same numbers (it can only add to them), so a no-drop projection is byte-identical to
  // the pre-archive-aware shape when nothing is omitted.
  const wire: BashJobsWire = {
    rows,
    total: selected.total,
    running: selected.running,
    failed: selected.failed,
    ...(selected.omitted > 0 ? { omitted: selected.omitted } : {}),
    ...(selected.rowsOverflowRunning > 0 ? { rowsOverflowRunning: selected.rowsOverflowRunning } : {}),
    sampledAt: now,
  };
  const fitted = fitBudget(
    wire,
    selected.total,
    terminalFlags,
    rowIds,
    archived,
    selected.omittedIds,
    selected.rowsOverflowRunning,
  );
  const omittedIds = [...selected.omittedIds, ...fitted.droppedTerminalIds];
  return {
    wire: fitted.wire,
    omittedIds,
    rowsOverflowRunning: fitted.wire.rowsOverflowRunning ?? 0,
  };
}

function projectRow(record: JobRecord, tails: BashJobsTails | undefined, now: number): BashJobRowWire {
  const cmd = redactCommand(record.command);
  const row: BashJobRowWire = {
    id: truncateText(record.jobId, BASH_JOBS_ID_MAX_BYTES).text,
    cmd: cmd.text,
    ...(cmd.truncated ? { cmdTruncated: true as const } : {}),
    status: truncateText(record.status, BASH_JOBS_STATUS_MAX_BYTES).text,
    exitCode: record.exitCode,
    createdAt: record.createdAt,
    elapsedMs: elapsedMsOf(record, now),
    logBytes: record.logBytes,
  };
  if (record.endedAt !== undefined) row.endedAt = record.endedAt;
  // The tail read window is 1 KiB: a record this large means any tail view starts mid-file.
  if (record.logBytes > TAIL_READ_WINDOW_BYTES) row.logTruncated = true;
  if (record.deadline?.graceUntil !== undefined) row.grace = true;

  const sample = tails?.get(record.jobId);
  if (sample !== undefined) {
    const terminal = isTerminalJobStatus(record.status);
    // D3-3 freshness is AGENT-judged: the UI must not compare clocks itself.
    let current = false;
    if (sample.unavailableAtLogBytes === undefined && sample.at !== undefined) {
      if (terminal) {
        current =
          sample.settled === true ||
          (sample.at >= (record.endedAt ?? record.createdAt) && sample.logBytes === record.logBytes);
      } else {
        current = true; // running row: any sample exists ⇒ current
      }
    }
    if (sample.text !== undefined && sample.text !== "") {
      // sanitizeTail already ran in the sampler; this cap is the projection-side defense (D6).
      row.tail = capTailText(sample.text, TAIL_MAX_LINES, TAIL_READ_WINDOW_BYTES);
    }
    if (sample.at !== undefined) {
      row.tailAt = sample.at;
      row.tailBytes = sample.logBytes;
    }
    if (sample.unavailableAtLogBytes !== undefined) row.tailUnavailable = true;
    if (current) row.tailCurrent = true;
  }
  return row;
}

const TAIL_FIELDS = ["tail", "tailAt", "tailBytes", "tailUnavailable", "tailCurrent"] as const;

/**
 * D6 five-pass trim ladder over the wire (each pass only runs while still over budget):
 *  ① oldest terminal row first — shrink tail to last 3 lines / ≤256 B;
 *  ② oldest terminal row first — delete the tail block entirely;
 *  ③ oldest running row first — shrink tail to ≤256 B;
 *  ④ oldest running row first — delete the tail block;
 *  ⑤ drop terminal rows from the tail end, then running rows.
 * Rows are sorted non-terminal (newest first) then terminal (newest first), so walking the array
 * BACKWARDS visits oldest-first within each class and popping from the end drops exactly the
 * rows the ladder names. `cmd` is never trimmed (≤600 B per-row bound already). `total` stays the
 * pre-cap full-population count.
 *
 * A ⑤ drop is ATTRIBUTED, not blindly counted (2026-10-28 rework): a dropped terminal row that is
 * not archived joins `omittedIds` (so the browser's `(+N more)` — and the `archive_omitted` op —
 * see exactly the rows this pass removed); a dropped terminal row that IS archived counts as
 * nothing (the user already hid it — it must not resurrect a `(+N more)` line); a dropped running
 * row joins `droppedRunning` (`rowsOverflowRunning` on the wire — never archivable, so never
 * `omitted`). `capOmittedIds` / `capOverflowRunning` are the caller's cap-stage counts, which this
 * pass can only add to.
 *
 * Byte note: pass ⑤ drops archived rows at the same rate as unarchived ones (the budget measures
 * the wire, and an archived row occupies a slot exactly like any other) — the fold simply shows
 * fewer rows under extreme byte pressure. That is the same ladder that ran before this change.
 */
function fitBudget(
  wire: BashJobsWire,
  total: number,
  terminalFlags: readonly boolean[],
  rowIds: readonly string[],
  archived: ReadonlySet<string> | undefined,
  capOmittedIds: readonly string[],
  capOverflowRunning: number,
): { wire: BashJobsWire; droppedTerminalIds: readonly string[]; droppedRunning: number } {
  const build = (
    rs: Array<Record<string, unknown>>,
    droppedTerminal: readonly string[],
    droppedRunning: number,
  ): BashJobsWire => {
    const omitted = capOmittedIds.length + droppedTerminal.length;
    const overflow = capOverflowRunning + droppedRunning;
    return {
      rows: rs as unknown as BashJobRowWire[],
      total,
      running: wire.running,
      failed: wire.failed,
      ...(omitted > 0 ? { omitted } : {}),
      ...(overflow > 0 ? { rowsOverflowRunning: overflow } : {}),
      sampledAt: wire.sampledAt,
    };
  };
  const initial = build(wire.rows as unknown as Array<Record<string, unknown>>, [], 0);
  if (bashJobsWireBytes(initial) <= BASH_JOBS_WIRE_BUDGET_BYTES) {
    return { wire: initial, droppedTerminalIds: [], droppedRunning: 0 };
  }
  const rows = wire.rows.map((r) => ({ ...r })) as Array<Record<string, unknown>>;
  const live = [...rowIds];
  const dropped: string[] = [];
  let droppedRunning = 0;
  const fits = (): boolean => bashJobsWireBytes(build(rows, dropped, droppedRunning)) <= BASH_JOBS_WIRE_BUDGET_BYTES;

  const terminalIdx: number[] = [];
  const runningIdx: number[] = [];
  rows.forEach((_r, i) => (terminalFlags[i] ? terminalIdx : runningIdx).push(i));

  const shrinkTail = (i: number): void => {
    const r = rows[i]!;
    if (typeof r["tail"] === "string")
      r["tail"] = capTailText(r["tail"] as string, BUDGET_TAIL_SHRINK_LINES, BUDGET_TAIL_SHRINK_BYTES);
  };
  const dropTail = (i: number): void => {
    for (const f of TAIL_FIELDS) delete rows[i]![f];
  };

  for (const i of [...terminalIdx].reverse()) {
    if (fits()) break;
    shrinkTail(i);
  }
  for (const i of [...terminalIdx].reverse()) {
    if (fits()) break;
    dropTail(i);
  }
  for (const i of [...runningIdx].reverse()) {
    if (fits()) break;
    shrinkTail(i);
  }
  for (const i of [...runningIdx].reverse()) {
    if (fits()) break;
    dropTail(i);
  }
  // ⑤: drop terminal rows from the array tail first, then running rows. `term` and `live` are
  // spliced in lockstep with `rows` so the flags/ids never misalign after a drop.
  const term = [...terminalFlags];
  while (rows.length > 0 && !fits()) {
    let dropAt = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (term[i] === true) {
        dropAt = i;
        break;
      }
    }
    const wasTerminal = dropAt >= 0;
    if (!wasTerminal) dropAt = rows.length - 1; // no terminal rows left ⇒ oldest running (array tail)
    const droppedId = live[dropAt];
    if (!wasTerminal) droppedRunning += 1;
    else if (droppedId !== undefined && archived?.has(droppedId) !== true) dropped.push(droppedId);
    rows.splice(dropAt, 1);
    term.splice(dropAt, 1);
    live.splice(dropAt, 1);
  }
  return { wire: build(rows, dropped, droppedRunning), droppedTerminalIds: dropped, droppedRunning };
}
