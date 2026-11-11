/** #50 P1, factory-only. I1 must call this ONCE from the existing natural
 * session_start, after scopes has observed the actual context. No hook/owner is
 * created here; no provider, budget, auto, repair or recovery dependency.
 *
 * Read-only EXCEPT the original directory lock's transient metadata. The budget
 * is cooperative: synchronous syscalls cannot be preempted. Directory identity
 * checks do not form a transaction against hostile same-uid writers.
 */
import { join } from "node:path";
import { clampSpanMs } from "../../core/deadline.js";
import { dirFormat } from "../blocks/naming.js";
import type { MemoryWriteGate } from "../contracts.js";
import type { RevisionRecoveryDiagnostic } from "../jev/contracts.js";
import { withMemoryDirLock } from "../lock.js";
import { canonicalDir, inspectDirSecurityNoFollow } from "../safe-fs.js";
import type { MemoryOwnerRuntime } from "../scopes/owner.js";
import type { MemorySettings } from "../settings.js";
import { createRevisionAuditPort, REVISION_SCAN_ACTION_LIMIT } from "./revision-audit.js";

export const REVISION_STARTUP_BUDGET_MS = 1_000;
export const REVISION_STARTUP_SAMPLE_LIMIT = 8;
const STATES = [
  "prepared",
  "proposed",
  "committed",
  "skipped",
  "failed",
  "commit-unknown",
  "restored",
  "corrupted",
  "unavailable",
] as const;
type State = (typeof STATES)[number];
type Runtime = Pick<MemoryOwnerRuntime, "owner" | "manager" | "signal" | "current" | "capability">;

export interface RevisionStartupDiagnosticsInput {
  /** Host-resolved CURRENT project directory (including its worktree-origin mapping).
   * Never pass a root to enumerate projects. No missing directory is created. */
  readonly memoryDir: string;
  readonly actualContext: {
    readonly mode?: string;
    readonly hasUI: boolean;
    readonly sessionManager: unknown;
    readonly webInvocation?: unknown;
  };
  readonly settings: Pick<MemorySettings, "enabled" | "scopes">;
  readonly isChildSession: boolean;
  readonly domain: "plain" | "secure" | "locked";
  /** Existing scopes.current, not an owner factory or cached fallback. */
  readonly scopes?: { current(): Runtime | undefined };
  readonly gate: MemoryWriteGate;
  /** Original host session/reload lifetime, independent of model attempts. */
  readonly signal: AbortSignal;
  /** Existing host epoch/current-cwd predicate; must not create an owner. */
  readonly isCurrent: () => boolean;
  /** Existing synchronous in-memory/UI warning channel ONLY. Not a persistent
   * Jev diagnostic sink, message injection, console fallback or repair callback. */
  readonly warn?: (message: string) => void;
}

export interface RevisionStartupSummary {
  readonly counts: Readonly<Record<State, number>>;
  /** Issue samples only, never batch/target IDs, paths, bodies or raw reasons. */
  readonly samples: readonly Readonly<{ state: State; actionId: string }>[];
  /** Omitted issue samples; null if enumeration exceeded C's hard row bound. */
  readonly omitted: number | null;
  readonly incomplete: boolean;
}
export type RevisionStartupDiagnosticsResult =
  | { readonly kind: "skipped" }
  | { readonly kind: "scanned"; readonly summary: RevisionStartupSummary; readonly warned: boolean };

function issue(state: State): boolean {
  return state !== "committed" && state !== "skipped" && state !== "restored";
}

/** Only the C scanner supplies classification. In particular, expected-after
 * bytes without a commit marker stay commit-unknown, never inferred committed.
 * C may classify untouched prepared/proposed records as skipped; do not undo
 * that classification by inspecting their files or parsing its raw reason. */
function summarize(rows: readonly RevisionRecoveryDiagnostic[]): RevisionStartupSummary {
  const counts: Record<State, number> = {
    prepared: 0,
    proposed: 0,
    committed: 0,
    skipped: 0,
    failed: 0,
    "commit-unknown": 0,
    restored: 0,
    corrupted: 0,
    unavailable: 0,
  };
  const samples: { state: State; actionId: string }[] = [];
  let issues = 0;
  const truncated = rows.length > REVISION_SCAN_ACTION_LIMIT;
  for (const row of rows.slice(0, REVISION_SCAN_ACTION_LIMIT)) {
    const validAction = row.kind === "action" && /^[a-f0-9]{64}$/.test(row.actionId);
    const state: State = validAction && STATES.includes(row.state) ? row.state : "unavailable";
    counts[state]++;
    if (issue(state)) {
      issues++;
      if (validAction && samples.length < REVISION_STARTUP_SAMPLE_LIMIT)
        samples.push(Object.freeze({ state, actionId: row.actionId }));
    }
  }
  if (truncated) counts.unavailable = Math.min(REVISION_SCAN_ACTION_LIMIT, counts.unavailable + 1);
  return Object.freeze({
    counts: Object.freeze(counts),
    samples: Object.freeze(samples),
    omitted: truncated ? null : issues - samples.length,
    incomplete: truncated || counts.unavailable > 0,
  });
}

function warning(summary: RevisionStartupSummary): string | undefined {
  if (!STATES.some((state) => issue(state) && summary.counts[state] > 0)) return undefined;
  return [
    `memory revisions: ${STATES.map((state) => `${state}=${summary.counts[state]}`).join(" ")}`,
    ...summary.samples.map(({ state, actionId }) => `${state}: ${actionId}`),
    `omitted=${summary.omitted}; read-only diagnostics; unknown is not proof of a commit. Inspect manually; do not blindly retry.`,
  ].join("\n");
}

export async function runRevisionStartupDiagnostics(
  input: RevisionStartupDiagnosticsInput,
): Promise<RevisionStartupDiagnosticsResult> {
  const skipped = { kind: "skipped" } as const;
  const deadline = performance.now() + (clampSpanMs(REVISION_STARTUP_BUDGET_MS) ?? REVISION_STARTUP_BUDGET_MS);
  const alive = () => !input.signal.aborted && performance.now() < deadline;
  const native = () =>
    input.settings.enabled === true &&
    (input.settings.scopes.session || input.settings.scopes.hub) &&
    !input.isChildSession &&
    input.domain === "plain" &&
    input.actualContext.mode === "tui" &&
    input.actualContext.hasUI === true &&
    !input.actualContext.webInvocation;
  try {
    // ALL identity/settings gates precede discovery, including canonicalDir/dirFormat.
    if (!alive() || !native() || !input.warn || !input.isCurrent()) return skipped;
    const runtime = input.scopes?.current();
    if (!runtime || input.actualContext.sessionManager !== runtime.manager) return skipped;
    const owner = runtime.owner;
    const epoch = owner.sessionEpoch;
    const branch = owner.branchGen;
    let revoked = false;
    const current = (dir: string): boolean => {
      if (revoked) return false;
      if (!alive() || runtime.signal.aborted || !native()) {
        revoked = true;
        return false;
      }
      if (
        input.scopes?.current() !== runtime ||
        input.actualContext.sessionManager !== runtime.manager ||
        runtime.owner !== owner ||
        runtime.owner.sessionEpoch !== epoch ||
        runtime.owner.branchGen !== branch ||
        !runtime.current() ||
        runtime.capability() !== "ok" ||
        !input.isCurrent() ||
        !input.gate.check(dir).ok
      ) {
        revoked = true;
        return false;
      }
      // Host callbacks above may synchronously revoke the original lifetime.
      const valid =
        native() &&
        input.scopes?.current() === runtime &&
        input.actualContext.sessionManager === runtime.manager &&
        alive() &&
        !runtime.signal.aborted;
      if (!valid) revoked = true;
      return valid;
    };
    if (!current(input.memoryDir)) return skipped;
    const canonical = canonicalDir(input.memoryDir);
    if (!canonical || !current(canonical.real) || dirFormat(canonical.real) !== "blocks") return skipped;
    const dir = canonical.real;
    const root = inspectDirSecurityNoFollow(dir);
    const blocks = inspectDirSecurityNoFollow(join(dir, "blocks"));
    const directoryCurrent = () => {
      if (!current(dir)) return false;
      if (canonicalDir(input.memoryDir)?.real !== dir) return false;
      const r = inspectDirSecurityNoFollow(dir);
      const b = inspectDirSecurityNoFollow(join(dir, "blocks"));
      return (
        r.dev === root.dev &&
        r.ino === root.ino &&
        r.uid === root.uid &&
        b.dev === blocks.dev &&
        b.ino === blocks.ino &&
        b.uid === blocks.uid &&
        alive() &&
        !runtime.signal.aborted
      );
    };
    if (!directoryCurrent()) return skipped;
    const summary = await withMemoryDirLock(
      dir,
      () => {
        if (!directoryCurrent() || dirFormat(dir) !== "blocks") return undefined;
        const audit = createRevisionAuditPort(dir, {
          gate: input.gate,
          signal: input.signal,
          isCurrent: directoryCurrent,
          now: () => new Date(),
        });
        // Exactly one C scan in the ORIGINAL lock. No retry or second scanner.
        const rows = audit.scanPendingLocked();
        if (!directoryCurrent()) return undefined;
        return summarize(rows);
      },
      { timeoutMs: 0, log: () => {} },
    );
    // Lock acquisition is async even though C is synchronous. Revoke-after-lock
    // and deadline expiry suppress both report and notification, with no retry.
    if (!summary || !directoryCurrent() || dirFormat(dir) !== "blocks") return skipped;
    const message = warning(summary);
    let warned = false;
    if (!directoryCurrent()) return skipped;
    if (message) {
      try {
        input.warn(message);
        warned = true;
      } catch {
        // A broken UI channel is not a reason to write a sink or retry startup.
      }
    }
    return { kind: "scanned", summary, warned };
  } catch {
    // Busy/unavailable lock, layout/identity errors and throwing host callbacks
    // are silent skips. Never expose the underlying reason/path or retry here.
    return skipped;
  }
}
