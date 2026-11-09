import { createHash } from "node:crypto";
import type { BudgetRenderStats } from "../blocks/render.js";
import {
  JEV_GOVERNANCE_BUDGET_SIGNALS,
  type JevGovernanceBudgetSignal,
  type JevGovernanceEvent,
} from "../jev/contracts.js";

// #36: epoch-local owner of event candidates, pending signals and budget
// observations. It never schedules work or starts a turn; the host supplies
// success evidence and settles detached budget batches.

export type GovernanceSignal = JevGovernanceEvent;

export interface SignalAdmission {
  readonly success: boolean;
  readonly readOnly: boolean;
}

export interface TurnEndContext {
  /** The current turn's abort signal, when available. */
  readonly signal?: AbortSignal;
  /** Existing write/startup opportunity, not a plain empty turn. */
  readonly external?: boolean;
}

export function canMark(admission: SignalAdmission): boolean {
  return admission.success === true && admission.readOnly === false;
}

/** Identity must be captured and gated by the host for this epoch, not guessed here. */
export interface BudgetDirectoryIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly migration?: { readonly gen: number; readonly runId: string };
}
export interface BudgetObservation {
  readonly identity: BudgetDirectoryIdentity;
  readonly stats: BudgetRenderStats;
}
export interface BudgetCandidate {
  readonly kind: JevGovernanceBudgetSignal;
  readonly key: string;
  readonly observation: BudgetObservation;
  /** Opaque lease for this detach, never a deduplication key. */
  readonly attempt: object;
}
export interface GovernanceCandidate {
  readonly kind: GovernanceSignal;
  /** SHA-256 of the tool input, not command text. */
  readonly inputFingerprint: string;
  readonly taskId?: number;
}
interface BudgetState extends Omit<BudgetCandidate, "attempt"> {
  status: "pending" | "in-flight" | "succeeded" | "dormant";
  attempt?: object;
}
function directoryKey(identity: BudgetDirectoryIdentity): string {
  return JSON.stringify([identity.realpath, identity.dev, identity.ino]);
}
export function budgetObservationKey(observation: BudgetObservation, kind: JevGovernanceBudgetSignal): string {
  const { identity, stats } = observation;
  const extra =
    kind === "resident-over-budget"
      ? [stats.resident.inputFingerprint, stats.resident.usedBytes, stats.resident.budgetBytes]
      : [stats.index.inputFingerprint, stats.index.limitBytes, stats.index.omittedCount];
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.realpath,
        identity.dev,
        identity.ino,
        identity.migration?.gen ?? null,
        identity.migration?.runId ?? null,
        kind,
        stats.corpusFingerprint,
        stats.localToday,
        stats.policyVersion,
        ...extra,
      ]),
    )
    .digest("hex");
}

/** Create exactly one instance per session; never share one across sessions. */
export function createGovernanceSignals() {
  const pending = new Set<GovernanceSignal>();
  const dormant = new Set<GovernanceSignal>();
  const candidates = new Map<string, GovernanceCandidate>();
  const budgets = new Map<string, Map<JevGovernanceBudgetSignal, BudgetState>>();
  let closed = false;

  return {
    /** Undefined means unknown: leave prior states untouched. Admission/gate is the host's responsibility. */
    observeBudget(observation: BudgetObservation | undefined, origin: "external" | "sweep" = "external"): void {
      if (closed || observation === undefined) return;
      const dir = directoryKey(observation.identity);
      let entries = budgets.get(dir);
      if (entries === undefined) {
        entries = new Map();
        budgets.set(dir, entries);
      }
      for (const kind of JEV_GOVERNANCE_BUDGET_SIGNALS) {
        const over = kind === "resident-over-budget" ? observation.stats.resident.over : observation.stats.index.over;
        if (!over) {
          entries.delete(kind);
          continue;
        }
        const key = budgetObservationKey(observation, kind);
        const previous = entries.get(kind);
        if (previous?.key === key) continue;
        entries.set(kind, { kind, key, observation, status: origin === "sweep" ? "dormant" : "pending" });
      }
      if (entries.size === 0) budgets.delete(dir);
    },

    /** Atomic detach. External opportunities may re-admit dormant failed/sweep-origin keys;
     * a plain turn_end/render must pass external=false. Host merges with event signals. */
    consumeBudgets(
      identity: BudgetDirectoryIdentity,
      options: { external: boolean; signal?: AbortSignal },
    ): readonly BudgetCandidate[] {
      if (closed || options.signal?.aborted) return [];
      const entries = budgets.get(directoryKey(identity));
      if (entries === undefined) return [];
      const result: BudgetCandidate[] = [];
      for (const state of entries.values()) {
        if (state.status !== "pending" && !(options.external && state.status === "dormant")) continue;
        state.status = "in-flight";
        const attempt = {};
        state.attempt = attempt;
        result.push({ kind: state.kind, key: state.key, observation: state.observation, attempt });
      }
      return result;
    },

    /** Settle exactly the detached keys; newer observations never inherit an old result. */
    settleBudgets(batch: readonly BudgetCandidate[], success: boolean): void {
      if (closed) return;
      for (const candidate of batch) {
        const state = budgets.get(directoryKey(candidate.observation.identity))?.get(candidate.kind);
        if (state?.key === candidate.key && state.status === "in-flight" && state.attempt === candidate.attempt)
          state.status = success ? "succeeded" : "dormant";
      }
    },

    /** Bounded association, scoped to this epoch. Callers retain no duplicate table. */
    captureCandidate(toolCallId: string, candidate: GovernanceCandidate): void {
      if (closed) return;
      if (candidates.size >= 128 && !candidates.has(toolCallId)) candidates.delete(candidates.keys().next().value!);
      candidates.set(toolCallId, candidate);
    },
    takeCandidate(toolCallId: string, inputFingerprint: string): GovernanceCandidate | undefined {
      if (closed) return undefined;
      const candidate = candidates.get(toolCallId);
      candidates.delete(toolCallId);
      return candidate?.inputFingerprint === inputFingerprint ? candidate : undefined;
    },
    clearCandidates(): void {
      candidates.clear();
    },

    /** The caller supplies the success/read-only verdict, not raw tool input. */
    markSignal(kind: GovernanceSignal, admission: SignalAdmission): void {
      if (!closed && canMark(admission)) pending.add(kind);
    },

    /** A detached event batch the runner could not execute stays dormant. */
    deferSignals(signals: readonly GovernanceSignal[]): void {
      if (!closed) for (const signal of signals) dormant.add(signal);
    },

    /** One snapshot for one turn_end; clear synchronously before returning it. */
    consumeSignals(context: TurnEndContext): readonly GovernanceSignal[] | undefined {
      if (closed || context.signal?.aborted) {
        pending.clear();
        dormant.clear();
        if (context.signal?.aborted) {
          budgets.clear();
          candidates.clear();
        }
        return undefined;
      }
      if (context.external || pending.size > 0) {
        for (const signal of dormant) pending.add(signal);
        dormant.clear();
      }
      if (pending.size === 0) return undefined;
      const signals = [...pending];
      pending.clear();
      return signals;
    },

    /** Host calls on turn abort; a later turn may mark new events. */
    abort(): void {
      pending.clear();
      dormant.clear();
      candidates.clear();
      budgets.clear();
    },

    /** Host calls on session end or reload; the old instance stays inert. */
    dispose(): void {
      pending.clear();
      dormant.clear();
      candidates.clear();
      budgets.clear();
      closed = true;
    },
  };
}
