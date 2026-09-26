import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Millis } from "../core/types.js";
import type { JournalEntry } from "./types.js";

/**
 * replay-verify plan D4 (§6 P2 tests 9-10, 13): the load-time snapshot probe
 * ("校验分支后回放") and the terminal parallel-with-flush recheck — both
 * built on the same bounded, single-settle, port-agnostic primitive
 * (`runBoundedProbe`) so a hung/SIGTERM-resistant `git` can never wedge a
 * workflow run (D4.3/D10: the guarantee is "this module's own await returns
 * on time", never "the underlying process is already dead when it does" —
 * that is `pi.exec`'s own SIGTERM→5s→SIGKILL contract, out of this file's
 * control).
 */

/** replay-verify plan D4.1/D4.2: the port `ChildSpawner.probeAgentBranches` implements — stack.ts wires it to a single `git for-each-ref`. */
export type ProbeAgentBranchesFn = (
  branches: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs: Millis; readonly signal: AbortSignal },
) => Promise<
  { readonly ok: true; readonly tips: ReadonlyMap<string, string> } | { readonly ok: false; readonly error: string }
>;

/** D4.2: at most this many distinct branches are ever probed in one `for-each-ref` call — the rest are treated as unverified without a wasted RPC. */
export const MAX_PROBE_BRANCHES = 256;

const REF_OBJECT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** D4.2: defensive parse cap — a `for-each-ref` stream this large (or this many lines) is never trusted, even before individual line parsing. */
const MAX_PARSE_BYTES = 1024 * 1024;
const MAX_PARSE_LINES = 4096;

/**
 * D4.2 step 4: parses `git for-each-ref --format=%(refname) %(objectname)`
 * output, keeping only lines whose refname is one of `wanted` (already
 * regex-validated branch names by the caller) and whose objectname looks
 * like a real sha — anything else (a garbled line, an unexpected ref, a
 * malformed hex string) is silently dropped rather than trusted.
 */
export function parseForEachRef(stdout: string, wanted: ReadonlySet<string>): ReadonlyMap<string, string> {
  const tips = new Map<string, string>();
  if (Buffer.byteLength(stdout, "utf8") > MAX_PARSE_BYTES) return tips;
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length && i < MAX_PARSE_LINES; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const idx = line.lastIndexOf(" ");
    if (idx === -1) continue;
    const refname = line.slice(0, idx);
    const objectname = line.slice(idx + 1);
    if (!wanted.has(refname)) continue; // only exact matches for a ref we actually asked about
    if (!REF_OBJECT_RE.test(objectname)) continue;
    tips.set(refname, objectname);
  }
  return tips;
}

/** D4.2 step 3: the deduplicated, capped branch list to probe for a set of `committed` isolated candidates. */
export function collectProbeBranches(
  candidates: readonly JournalEntry[],
  cap: number = MAX_PROBE_BRANCHES,
): { readonly branches: readonly string[]; readonly truncated: number } {
  const seen = new Set<string>();
  for (const entry of candidates) {
    if (entry.worktree?.state === "committed") seen.add(entry.worktree.branch);
  }
  const all = [...seen];
  return { branches: all.slice(0, cap), truncated: Math.max(0, all.length - cap) };
}

export type BoundedProbeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "timeout" | "error"; readonly error?: string };

/**
 * D4.3 (evidence #5, v2.1 #2): triple protection around one probe call —
 * `AbortSignal` fired at `timeoutMs` (so a `pi.exec`-shaped port can SIGTERM
 * its child), the same `timeoutMs` handed to the port's own timeout, and an
 * outer `withDeadline(timeoutMs + 500, ...)` that returns on schedule no
 * matter how uncooperative `run` is. Single settlement (`withDeadline`'s own
 * `done` flag) — a `run` that resolves/rejects after the outer deadline is
 * swallowed, never produces a second callback and never becomes an
 * unhandled rejection. The guarantee is bounded *return*, not bounded
 * *process lifetime* — a SIGTERM-resistant child may still be alive when
 * this resolves; it is `pi.exec`'s own SIGKILL fallback (~5s later) that
 * eventually reaps it (D4.3/D10).
 */
export async function runBoundedProbe<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: { readonly timeoutMs: Millis; readonly clock: Clock },
): Promise<BoundedProbeOutcome<T>> {
  const controller = new AbortController();
  const abortTimer = opts.clock.setTimer(opts.timeoutMs, () => controller.abort());
  let started: Promise<T>;
  try {
    started = run(controller.signal);
  } catch (e) {
    opts.clock.clearTimer(abortTimer);
    return { ok: false, reason: "error", error: e instanceof Error ? e.message : String(e) };
  }
  const result = await withDeadline(started, opts.timeoutMs + 500, opts.clock, "isolation_verify_probe");
  opts.clock.clearTimer(abortTimer);
  if (result.ok) return { ok: true, value: result.value };
  if (result.reason === "timeout") return { ok: false, reason: "timeout" };
  return { ok: false, reason: "error", error: result.error.message };
}

export interface VerifyIsolationResult {
  /** entry.digest of every candidate that verified (exact branch-tip match). */
  readonly verified: ReadonlySet<string>;
  readonly stats: { readonly probed: number; readonly verified: number; readonly unverified: number };
  readonly probeError?: string;
}

/**
 * D4.2: the load-time snapshot probe — zero git calls when there is nothing
 * to check (`candidates` empty or `probe` absent, e.g. `off` mode/an older
 * `ChildSpawner`/`worktreeAvailable() !== true`, all decided by the caller
 * via whether it passes a `probe` at all). `probed` always equals
 * `candidates.length` (every committed candidate is judged one way or the
 * other) even when the probe itself fails — those simply land in
 * `unverified`, never `verified` (fail-closed to live).
 */
export async function verifyIsolatedEntries(
  candidates: readonly JournalEntry[],
  probe: ProbeAgentBranchesFn | undefined,
  opts: { readonly cwd: string; readonly timeoutMs: Millis; readonly clock: Clock },
): Promise<VerifyIsolationResult> {
  const total = candidates.length;
  if (total === 0 || !probe) {
    return { verified: new Set(), stats: { probed: total, verified: 0, unverified: total } };
  }
  const { branches } = collectProbeBranches(candidates);
  const outcome = await runBoundedProbe(
    (signal) => probe(branches, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal }),
    { timeoutMs: opts.timeoutMs, clock: opts.clock },
  );
  const verified = new Set<string>();
  let probeError: string | undefined;
  if (!outcome.ok) {
    probeError = outcome.reason === "timeout" ? "isolation verify probe timed out" : (outcome.error ?? "probe failed");
  } else if (!outcome.value.ok) {
    probeError = outcome.value.error;
  } else {
    const tips = outcome.value.tips;
    for (const entry of candidates) {
      if (entry.worktree?.state !== "committed") continue;
      if (tips.get(`refs/heads/${entry.worktree.branch}`) === entry.worktree.commit) verified.add(entry.digest);
    }
  }
  return {
    verified,
    stats: { probed: total, verified: verified.size, unverified: total - verified.size },
    ...(probeError !== undefined ? { probeError } : {}),
  };
}

export interface RecheckTarget {
  readonly branch: string;
  readonly commit: string;
}

/**
 * D4.4: the terminal diagnostic-only recheck — never throws, never
 * annotates anything on a probe failure/timeout ("不标注（未知），也不
 * hang"). Runs concurrently with `flushJournal`, never gates it.
 */
export async function recheckBranches(
  targets: readonly RecheckTarget[],
  probe: ProbeAgentBranchesFn | undefined,
  opts: { readonly cwd: string; readonly timeoutMs: Millis; readonly clock: Clock },
): Promise<ReadonlyMap<string, "gone" | "moved">> {
  const out = new Map<string, "gone" | "moved">();
  if (targets.length === 0 || !probe) return out;
  const branches = [...new Set(targets.map((t) => t.branch))].slice(0, MAX_PROBE_BRANCHES);
  try {
    const outcome = await runBoundedProbe(
      (signal) => probe(branches, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal }),
      { timeoutMs: opts.timeoutMs, clock: opts.clock },
    );
    if (!outcome.ok || !outcome.value.ok) return out;
    const tips = outcome.value.tips;
    for (const t of targets) {
      const tip = tips.get(`refs/heads/${t.branch}`);
      if (tip === undefined) out.set(t.branch, "gone");
      else if (tip !== t.commit) out.set(t.branch, "moved");
    }
  } catch {
    // D4.4: a defect in the port itself must not fail the terminal decision — unknown, not annotated.
  }
  return out;
}
