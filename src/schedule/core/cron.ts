/**
 * Scheduled tasks — tz-aware cron core (docs/dev/scheduled-reports/plan.md r3 §4.4, S1).
 *
 * Pure, pi-free, node-free (only `Intl`). Shared by the agent writer (claims, sweeps, `missedLog`
 * counts) and the hub (projection `next`, observation clock, reconciliation) — the hub imports it
 * directly, so its import closure is pinned by `tests/web-hub/boundary.test.ts`.
 *
 * Semantics (frozen with the plan):
 *   - 5-field cron (minute hour day-of-month month day-of-week) evaluated in the task's IANA `tz`;
 *     the process time zone never matters. Fields: numbers, `*`, `a-b`, `x/n` steps, lists, month
 *     and weekday names (jan…dec / sun…sat, case-insensitive), weekday 7 = Sunday. Vixie rule:
 *     when BOTH day fields are restricted (neither starts with `*`) a day matches if EITHER does,
 *     otherwise both must match.
 *   - Enumeration is field-wise (allowed month → matching day → hour → minute) — never a scan over
 *     every minute. Each local wall-clock minute is resolved to UTC through `Intl.DateTimeFormat`:
 *       · non-existent local time (spring-forward gap) ⇒ NO occurrence;
 *       · ambiguous local time (fall-back overlap) ⇒ only the EARLIER instant.
 *     Hence every local wall time maps to at most one instant and occurrences are strictly
 *     ascending (pinned by tests).
 *   - `countOccurrences(c, a, b)` counts `(a, b]`, capped at SCHED_COUNT_CAP (`capped:true` ⇔ at
 *     least one more occurrence ≤ b exists). It is THE counter: `MissedEntry.count` and the hub's
 *     reconciliation both use it, on the same definition.
 *   - `nextOccurrence` looks ≤ 400 days ahead and evaluates ≤ 50 000 candidates (days visited +
 *     minute tuples tried); beyond either ⇒ `undefined` (the caller marks the task `degraded:never`).
 *
 * No module-level mutable state: every `CompiledWhen` owns its own `Intl.DateTimeFormat`.
 */
import { SCHED_COUNT_CAP, SCHED_NEXT_CANDIDATE_BUDGET, SCHED_NEXT_HORIZON_MS, type ScheduleWhen } from "./spec.js";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Real-world UTC offsets lie within [-12h, +14h]; this bounds where a wall time's instant can be. */
const OFFSET_SPAN_MS = 14 * HOUR_MS;
/** Safety bound on day steps for counts over absurd ranges (corrupt `from`): ~2 700 years. */
const COUNT_STEP_BUDGET = 1_000_000;

export const CRON_EXPR_MAX_CHARS = 128;
export const TZ_MAX_CHARS = 64;

// ----------------------------------------------------------------- parsing

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  /** 0–6, Sunday = 0. */
  dow: number[];
  domStar: boolean;
  dowStar: boolean;
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  namesBase?: number;
}
const FIELD_SPECS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES, namesBase: 0 },
];

function parseAtom(text: string, spec: FieldSpec): number | undefined {
  if (/^[0-9]{1,2}$/.test(text)) {
    const n = Number(text);
    return n >= spec.min && n <= spec.max ? n : undefined;
  }
  if (spec.names !== undefined && /^[A-Za-z]{3}$/.test(text)) {
    const i = spec.names.indexOf(text.toLowerCase());
    return i < 0 ? undefined : i + (spec.namesBase ?? 0);
  }
  return undefined;
}

function parseField(text: string, spec: FieldSpec): Set<number> | string {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "") return `${spec.name}: empty list item`;
    const slash = item.split("/");
    if (slash.length > 2) return `${spec.name}: bad step in ${JSON.stringify(item)}`;
    const base = slash[0]!;
    let step = 1;
    if (slash.length === 2) {
      if (!/^[0-9]{1,2}$/.test(slash[1]!)) return `${spec.name}: bad step in ${JSON.stringify(item)}`;
      step = Number(slash[1]);
      if (step < 1) return `${spec.name}: step must be ≥ 1`;
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.name === "day-of-week" ? 6 : spec.max;
    } else {
      const dash = base.split("-");
      if (dash.length > 2) return `${spec.name}: bad range ${JSON.stringify(item)}`;
      const a = parseAtom(dash[0]!, spec);
      if (a === undefined) return `${spec.name}: bad value ${JSON.stringify(item)}`;
      lo = a;
      if (dash.length === 2) {
        const b = parseAtom(dash[1]!, spec);
        if (b === undefined) return `${spec.name}: bad value ${JSON.stringify(item)}`;
        hi = b;
      } else {
        // `a/n` = from a to the field max (Vixie); a bare `a` is just a.
        hi = slash.length === 2 ? spec.max : a;
      }
      if (lo > hi) return `${spec.name}: reversed range ${JSON.stringify(item)}`;
    }
    for (let n = lo; n <= hi; n += step) out.add(spec.name === "day-of-week" && n === 7 ? 0 : n);
  }
  return out;
}

export function parseCron(expr: string): CronParse {
  if (typeof expr !== "string" || expr.length > CRON_EXPR_MAX_CHARS) return { ok: false, error: "cron: too long" };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") return { ok: false, error: "cron: need exactly 5 fields" };
  const sets: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i]!, FIELD_SPECS[i]!);
    if (typeof r === "string") return { ok: false, error: `cron: ${r}` };
    if (r.size === 0) return { ok: false, error: `cron: ${FIELD_SPECS[i]!.name} matches nothing` };
    sets.push([...r].sort((x, y) => x - y));
  }
  return {
    ok: true,
    fields: {
      minute: sets[0]!,
      hour: sets[1]!,
      dom: sets[2]!,
      month: sets[3]!,
      dow: sets[4]!,
      domStar: parts[2]!.startsWith("*"),
      dowStar: parts[4]!.startsWith("*"),
    },
  };
}

// ----------------------------------------------------------------- time zones

const TZ_SHAPE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*)*$/;

function makeFormatter(tz: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return undefined;
  }
}

/** IANA-shaped name (no raw `±hh:mm` offsets) that this runtime's Intl accepts. */
export function isValidTimeZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length <= TZ_MAX_CHARS && TZ_SHAPE_RE.test(tz) && makeFormatter(tz) !== undefined;
}

interface Civil {
  y: number;
  m: number; // 1–12
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

/** Wall clock as if it were UTC (ms). */
function wallMs(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ----------------------------------------------------------------- compiled schedule

export interface CompiledWhen {
  readonly kind: "cron" | "once";
  readonly tz: string;
  /** cron only. */
  readonly fields?: CronFields;
  /** once only: the resolved UTC instant. */
  readonly at?: number;
  /** @internal per-instance formatter (no module cache). */
  readonly fmt: Intl.DateTimeFormat;
}

export type CompileResult = { ok: true; when: CompiledWhen } | { ok: false; error: string };

function civilOf(fmt: Intl.DateTimeFormat, t: number): Civil {
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(t))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, m: out.month!, d: out.day!, hh: out.hour!, mm: out.minute!, ss: out.second! };
}

/** UTC offset (ms, local − UTC) in effect at instant `t`, second precision. */
function offsetAt(fmt: Intl.DateTimeFormat, t: number): number {
  const base = Math.floor(t / 1000) * 1000;
  const c = civilOf(fmt, base);
  return wallMs(c.y, c.m, c.d, c.hh, c.mm, c.ss) - base;
}

/**
 * Resolve a wall time (as-if-UTC ms) to the EARLIEST instant whose local time equals it, or
 * `undefined` when it does not exist. The instant lies in [w − 14h, w + 14h]; with at most one
 * transition in that window the two candidate offsets are the ones at its two ends.
 */
function resolveWall(fmt: Intl.DateTimeFormat, w: number): number | undefined {
  const cands = new Set([offsetAt(fmt, w - OFFSET_SPAN_MS), offsetAt(fmt, w + OFFSET_SPAN_MS)]);
  let best: number | undefined;
  for (const o of cands) {
    const u = w - o;
    if (offsetAt(fmt, u) === o && (best === undefined || u < best)) best = u;
  }
  return best;
}

/** A single constant offset covering every wall time of local day `w0` (+24h), if there is one. */
function constantDayOffset(fmt: Intl.DateTimeFormat, w0: number): number | undefined {
  const a = offsetAt(fmt, w0 - OFFSET_SPAN_MS);
  const b = offsetAt(fmt, w0 + 12 * HOUR_MS);
  const c = offsetAt(fmt, w0 + DAY_MS + OFFSET_SPAN_MS);
  return a === b && b === c ? a : undefined;
}

const ONCE_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function compileWhen(when: ScheduleWhen): CompileResult {
  if (when === null || typeof when !== "object") return { ok: false, error: "when: not an object" };
  if (!isValidTimeZone(when.tz))
    return { ok: false, error: `when.tz: unsupported time zone ${JSON.stringify(when.tz)}` };
  const fmt = makeFormatter(when.tz)!;
  if (when.kind === "cron") {
    const p = parseCron(when.expr);
    if (!p.ok) return { ok: false, error: p.error };
    return { ok: true, when: { kind: "cron", tz: when.tz, fields: p.fields, fmt } };
  }
  if (when.kind === "once") {
    const m = typeof when.at === "string" ? ONCE_AT_RE.exec(when.at) : null;
    if (m === null) return { ok: false, error: 'when.at: expected "YYYY-MM-DDTHH:mm"' };
    const [y, mo, d, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mi > 59) {
      return { ok: false, error: "when.at: not a calendar date/time" };
    }
    const at = resolveWall(fmt, wallMs(y, mo, d, hh, mi));
    if (at === undefined) return { ok: false, error: "when.at: local time does not exist in tz (DST gap)" };
    return { ok: true, when: { kind: "once", tz: when.tz, at, fmt } };
  }
  return { ok: false, error: "when.kind: expected cron|once" };
}

// ----------------------------------------------------------------- enumeration

function dayMatches(f: CronFields, y: number, m: number, d: number): boolean {
  const domHit = f.dom.includes(d);
  const dowHit = f.dow.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  return f.domStar || f.dowStar ? domHit && dowHit : domHit || dowHit;
}

interface IterBudget {
  /** Remaining steps (days visited + tuples tried); exhausted ⇒ iteration stops, `exhausted=true`. */
  steps: number;
  exhausted: boolean;
}

/**
 * Ascending occurrences `t` with `after < t ≤ until`, at most `limit` of them. Stops early (and
 * sets `budget.exhausted`) when the step budget runs out.
 */
function enumerate(c: CompiledWhen, after: number, until: number, limit: number, budget: IterBudget): number[] {
  const out: number[] = [];
  if (!(until > after) || limit <= 0) return out;
  if (c.kind === "once") {
    if (c.at! > after && c.at! <= until) out.push(c.at!);
    return out;
  }
  const f = c.fields!;
  // Start one local day early: in a fall-back overlap an instant after `after` can carry an
  // earlier wall time (≤ 1h, so ≤ one day).
  const start = civilOf(c.fmt, after);
  const startDay = new Date(Date.UTC(start.y, start.m - 1, start.d) - DAY_MS);
  const endCivil = civilOf(c.fmt, until);
  const endW = wallMs(endCivil.y, endCivil.m, endCivil.d) + DAY_MS; // inclusive bound on local day starts
  let y = startDay.getUTCFullYear();
  let m = startDay.getUTCMonth() + 1;
  let d = startDay.getUTCDate();
  for (;;) {
    if (wallMs(y, m, 1) > endW) return out;
    if (!f.month.includes(m)) {
      // Jump to the next allowed month (no per-day work).
      const nm = f.month.find((x) => x > m);
      if (nm === undefined) {
        y += 1;
        m = f.month[0]!;
      } else m = nm;
      d = 1;
      if (--budget.steps < 0) return exhaust(budget, out);
      continue;
    }
    const dim = daysInMonth(y, m);
    for (; d <= dim; d++) {
      const w0 = wallMs(y, m, d);
      if (w0 > endW) return out;
      if (--budget.steps < 0) return exhaust(budget, out);
      if (!dayMatches(f, y, m, d)) continue;
      const constOff = constantDayOffset(c.fmt, w0);
      for (const hh of f.hour) {
        for (const mm of f.minute) {
          if (--budget.steps < 0) return exhaust(budget, out);
          const w = w0 + hh * HOUR_MS + mm * MIN_MS;
          const t = constOff !== undefined ? w - constOff : resolveWall(c.fmt, w);
          if (t === undefined || t <= after) continue;
          if (t > until) return out;
          out.push(t);
          if (out.length >= limit) return out;
        }
      }
    }
    d = 1;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

function exhaust(budget: IterBudget, out: number[]): number[] {
  budget.exhausted = true;
  return out;
}

export interface NextOpts {
  horizonMs?: number;
  candidateBudget?: number;
}

/** Smallest occurrence `t > after` within the horizon/budget, else `undefined`. */
export function nextOccurrence(c: CompiledWhen, after: number, opts: NextOpts = {}): number | undefined {
  const horizon = opts.horizonMs ?? SCHED_NEXT_HORIZON_MS;
  const budget: IterBudget = { steps: opts.candidateBudget ?? SCHED_NEXT_CANDIDATE_BUDGET, exhausted: false };
  return enumerate(c, after, after + horizon, 1, budget)[0];
}

export interface OccurrenceCount {
  /** min(true count, SCHED_COUNT_CAP). */
  count: number;
  /** True ⇔ the true count exceeds `count` (cap reached with more left, or a pathological range). */
  capped: boolean;
}

/** Number of occurrences in `(a, b]` — THE shared counter (§4.4). */
export function countOccurrences(c: CompiledWhen, a: number, b: number): OccurrenceCount {
  const budget: IterBudget = { steps: COUNT_STEP_BUDGET, exhausted: false };
  const got = enumerate(c, a, b, SCHED_COUNT_CAP + 1, budget);
  if (got.length > SCHED_COUNT_CAP) return { count: SCHED_COUNT_CAP, capped: true };
  return { count: got.length, capped: budget.exhausted };
}

/** Ascending occurrences in `(a, b]`, at most `limit` (bounded by the same step budget as counts). */
export function occurrencesBetween(c: CompiledWhen, a: number, b: number, limit: number): number[] {
  return enumerate(c, a, b, limit, { steps: COUNT_STEP_BUDGET, exhausted: false });
}

/** True iff `t` is an occurrence of `c` (the EARLIER instance of an ambiguous wall time only). */
export function isOccurrence(c: CompiledWhen, t: number): boolean {
  if (!Number.isSafeInteger(t)) return false;
  if (c.kind === "once") return t === c.at;
  if (t % MIN_MS !== 0) return false;
  return enumerate(c, t - 1, t, 1, { steps: 10_000, exhausted: false })[0] === t;
}

/** Local wall time `YYYY-MM-DD HH:mm` of `t` in the schedule's tz (display only). */
export function formatLocal(c: CompiledWhen, t: number): string {
  const v = civilOf(c.fmt, t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${v.y}-${p(v.m)}-${p(v.d)} ${p(v.hh)}:${p(v.mm)}`;
}

export type WhenValidation = { ok: true; when: CompiledWhen; next: number } | { ok: false; error: string };

/** Create-time check (§4.4): parses, tz supported, and at least one hit within 400 days of `now`. */
export function validateWhen(when: ScheduleWhen, now: number): WhenValidation {
  const r = compileWhen(when);
  if (!r.ok) return r;
  const next = nextOccurrence(r.when, now);
  if (next === undefined) return { ok: false, error: "when: no occurrence within 400 days" };
  return { ok: true, when: r.when, next };
}
