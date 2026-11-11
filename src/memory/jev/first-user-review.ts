/** Migration first-user review host. No hooks or scheduler are installed here. */
import { systemClock, type Clock } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import type { MemoryWriteGate } from "../contracts.js";
import { createGovernanceMarkers, type GovernanceMarkersSnapshot } from "../govern/markers.js";
import { firstUserReviewPass, type FirstReviewPlan, type FirstReviewResult } from "../govern/review-lite.js";
import { JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER, QUESTION_BATCH_TOKENS } from "./contracts.js";
import type { ClassifierRegistryLike, JevClient, JevQuestion } from "./contracts.js";
import { estimateTokens } from "./questions.js";

const POLICY = "bounded-neighbours-v1" as const;
const QUESTION: JevQuestion = {
  type: "bool",
  instructions: "Do these two user memory excerpts conflict?",
  criteria: { true: "The excerpts conflict.", false: "The excerpts do not conflict." },
};
export interface FirstUserReviewHostOptions {
  memDir: string;
  enabled: boolean;
  jevEnabled: boolean;
  isChild: boolean;
  client?: JevClient;
  registry?: ClassifierRegistryLike;
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  clock?: Clock;
}
export interface FirstUserReviewOutcome {
  status: "completed" | "skipped" | "incomplete";
  reason?: string;
  review?: FirstReviewResult;
  metrics?: {
    elapsedMs: number;
    batchesAttempted: number;
    requestedBudgetsMs: readonly number[];
    /** Sum reported by successful client outcomes; failed calls may have unreported cost. */
    reportedCostUsd: number;
  };
}
/** I1 assembly calls run only at natural startup / meaningful turn_end opportunities. */
export function createFirstUserReviewHost(opts: FirstUserReviewHostOptions) {
  const clock = opts.clock ?? systemClock;
  let active: AbortController | undefined;
  let disposed = false;
  function cancel(): void {
    active?.abort();
  }
  function dispose(): void {
    disposed = true;
    cancel();
  }
  async function run(): Promise<FirstUserReviewOutcome> {
    if (
      disposed ||
      active ||
      !opts.enabled ||
      !opts.jevEnabled ||
      opts.isChild ||
      !opts.client ||
      !opts.registry ||
      typeof opts.registry.classify !== "function" ||
      typeof opts.registry.getAvailableOfType !== "function" ||
      typeof opts.registry.getModelOfType !== "function" ||
      opts.signal?.aborted ||
      !opts.isCurrent() ||
      opts.client.status().kind === "off" ||
      opts.client.status().kind === "partial"
    )
      return { status: "skipped", reason: "admission" };
    const controller = new AbortController();
    active = controller;
    const start = clock.now(),
      deadline = start + 6000;
    let progress: FirstReviewResult | undefined;
    let batchesAttempted = 0,
      reportedCostUsd = 0;
    const requestedBudgetsMs: number[] = [];
    const basicCurrent = () =>
      !disposed && !controller.signal.aborted && !opts.signal?.aborted && opts.isCurrent() && clock.now() < deadline;
    const markers = createGovernanceMarkers(opts.memDir, {
      ...(opts.gate ? { gate: opts.gate } : {}),
      signal: controller.signal,
      isCurrent: basicCurrent,
    });
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = clock.setTimer(clampSpanMs(6000) ?? 6000, () => controller.abort());
    try {
      const read = markers.read();
      if (!("directoryKey" in read)) return { status: "skipped", reason: read.reason };
      const snapshot: GovernanceMarkersSnapshot = read;
      const sameIdentity = (current: GovernanceMarkersSnapshot) =>
        current.directoryKey === snapshot.directoryKey &&
        current.migration.gen === snapshot.migration.gen &&
        current.migration.runId === snapshot.migration.runId;
      const check = () => {
        if (!basicCurrent()) throw new Error("cancelled or deadline");
        const live = markers.read();
        if (!("directoryKey" in live) || !sameIdentity(live)) throw new Error("identity changed");
      };
      let already = false;
      const judge = async (
        plan: FirstReviewPlan,
        reportAnswer: (answer: { a: string; b: string; p: number }) => void,
      ) => {
        check();
        const previous = snapshot.markers[JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER];
        if (previous?.corpusFp === plan.corpusFp && previous.policy === POLICY) {
          already = true;
          throw new Error("already completed");
        }
        // Each request has a fresh alias namespace and only its own excerpts.
        const batches: (typeof plan.pairs)[number][][] = [];
        let batch: (typeof plan.pairs)[number][] = [];
        let tokens = 1;
        for (const pair of plan.pairs) {
          const cost =
            estimateTokens(QUESTION) +
            Math.ceil(Buffer.byteLength(JSON.stringify([pair.aExcerpt, pair.bExcerpt])) / 3) +
            8;
          if (cost + 1 > QUESTION_BATCH_TOKENS) throw new Error("question too large");
          if (batch.length === 16 || tokens + cost > QUESTION_BATCH_TOKENS) {
            batches.push(batch);
            batch = [];
            tokens = 1;
          }
          batch.push(pair);
          tokens += cost;
        }
        if (batch.length) batches.push(batch);
        if (batches.length > 4) throw new Error("batch limit");
        const answers: { a: string; b: string; p: number }[] = [];
        for (const group of batches) {
          check();
          const state: Record<string, unknown> = {},
            questions: Record<string, JevQuestion> = {};
          group.forEach((pair, i) => {
            const alias = `p${i + 1}`;
            state[alias] = [pair.aExcerpt, pair.bExcerpt];
            questions[alias] = QUESTION;
          });
          // Exact upper bound for the same token estimator used by splitBatches.
          if (
            Math.ceil(Buffer.byteLength(JSON.stringify(state)) / 3) +
              Object.values(questions).reduce((n, q) => n + estimateTokens(q), 0) >
            QUESTION_BATCH_TOKENS
          )
            throw new Error("batch tokens");
          const budgetMs = clampSpanMs(deadline - clock.now());
          if (budgetMs === undefined) throw new Error("deadline");
          check();
          batchesAttempted++;
          requestedBudgetsMs.push(budgetMs);
          const outcome = await opts.client!.ask({
            duty: "review",
            registry: opts.registry!,
            state,
            questions,
            budgetMs,
            mode: "background",
            signal: controller.signal,
          });
          if (!outcome.ok) throw new Error("model batch incomplete");
          if (Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0) reportedCostUsd += outcome.costUsd;
          const keys = Object.keys(outcome.answers);
          let invalid =
            outcome.missing.length > 0 ||
            keys.length !== group.length ||
            keys.some((key) => !Object.hasOwn(questions, key));
          for (let i = 0; i < group.length; i++) {
            const answer = outcome.answers[`p${i + 1}`],
              pair = group[i]!;
            if (
              !answer ||
              answer.type !== "bool" ||
              !Number.isFinite(answer.probability) ||
              answer.probability < 0 ||
              answer.probability > 1
            ) {
              invalid = true;
              continue;
            }
            const accepted = { a: pair.a, b: pair.b, p: answer.probability };
            reportAnswer(accepted);
            answers.push(accepted);
          }
          if (invalid) throw new Error("model batch incomplete");
          check();
        }
        return answers;
      };
      const aborted = new Promise<FirstUserReviewOutcome>((resolve) => {
        const onCancel = () =>
          resolve({
            status: "incomplete",
            reason: "cancelled or deadline",
            ...(progress
              ? {
                  review: {
                    ...progress,
                    complete: false,
                    casFailures: [...progress.casFailures],
                    reason: "cancelled or deadline",
                  },
                }
              : {}),
          });
        controller.signal.addEventListener("abort", onCancel, { once: true });
        if (controller.signal.aborted) onCancel();
      });
      const work = (async (): Promise<FirstUserReviewOutcome> => {
        // Refresh availability even for a zero-pair pass; mere presence of a
        // registry object is not evidence that a classifier is available.
        const status = await opts.client!.probe(opts.registry!, controller.signal);
        check();
        if (status.kind === "off" || status.kind === "partial")
          return { status: "skipped", reason: "registry unavailable" };
        const review = await firstUserReviewPass(opts.memDir, judge, {
          ...(opts.gate ? { gate: opts.gate } : {}),
          signal: controller.signal,
          check,
          remainingMs: () => Math.max(0, deadline - clock.now()),
          onProgress: (result) => {
            progress = result;
          },
        });
        if (already) return { status: "skipped", reason: "already-completed", review };
        if (!review.complete || !review.plan)
          return { status: "incomplete", reason: review.reason ?? "incomplete", review };
        check();
        const plan = review.plan;
        const written = await markers.writeFirstUserReview(snapshot, {
          completedAt: new Date(clock.now()).toISOString(),
          corpusFp: plan.corpusFp,
          policy: POLICY,
          eligibleUsers: plan.eligibleUsers,
          selectedUsers: plan.selectedUsers,
          reviewedPairs: plan.plannedPairs,
        });
        if (written.status !== "written")
          return { status: "incomplete", reason: written.reason ?? "marker-write", review };
        return { status: "completed", review };
      })();
      const outcome = await Promise.race([work, aborted]);
      return {
        ...outcome,
        metrics: {
          elapsedMs: Math.max(0, clock.now() - start),
          batchesAttempted,
          requestedBudgetsMs: [...requestedBudgetsMs],
          reportedCostUsd,
        },
      };
    } catch (e) {
      return {
        status: "incomplete",
        reason: (e as Error).message,
        ...(progress ? { review: { ...progress, complete: false, casFailures: [...progress.casFailures] } } : {}),
        metrics: {
          elapsedMs: Math.max(0, clock.now() - start),
          batchesAttempted,
          requestedBudgetsMs: [...requestedBudgetsMs],
          reportedCostUsd,
        },
      };
    } finally {
      controller.abort();
      clock.clearTimer(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (active === controller) active = undefined;
    }
  }
  return { run, cancel, dispose };
}
