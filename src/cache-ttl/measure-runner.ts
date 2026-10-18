/**
 * Measurement runner of `/cache-ttl measure` (measure-plan.md r4 §4/§5/§7.2). Pi-free: the transport is the injected
 * {@link MeasureSendFn}, the strict raw reader / payload validator / route-key function / price function are injected
 * too (P4 binds P1's `measure-usage` / `measure-payload` / `measure-route` and the command's `calculateCost`).
 *
 * Timeline (one coroutine, ≤ 1 request in flight, all waits on the injected {@link Clock} — whose timers must be
 * unref'd in production, `systemClock` is):
 *   1. writes, slots 0..5 sequentially (replacement pool of 2 shared by all slots); the first valid write fixes the
 *      run-wide route key and gates on the own-prefix minimum;
 *   2. control read on slot 5 at `+30 s`, once more at `+60 s` unless the first was a valid hit;
 *   3. TTL probes, slot `i` once at `anchor_i.headersAt + gap_i`; the first valid miss skips the larger slots
 *      (`implied-miss`);
 *   4. the single boundary renewal read — the only request after a miss — when the actual-interval eligibility
 *      (`measure-renewal.ts`) holds.
 * The HARD cap of 17 sent requests holds on every path (pool 2, controls 2, probes 6, renewal 1, writes 6). Every
 * decision after a response comes from the single outcome → action table (`measure-actions.ts`).
 *
 * Lifecycle: `cancel`/`done` never await persistence or IO; every await re-checks `claim.owns(token)` and a stale owner
 * stops silently (no send, persist, progress or notify). A logically ended run releases the claim via
 * `finishLogical`; the claim stays `draining` until every send's transport `settled` resolved (`ioBegin`/`ioSettled`).
 */

import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { PipelineMeasureRouteKey, PipelineOutcome, PipelinePingResult } from "./pipeline-ping-types.js";
import { MEASURE_ACTION_TABLE, classifyMeasureOutcome, resolveMeasureAction, wasSent } from "./measure-actions.js";
import {
  boundBroken,
  classifyRead,
  computeTtlResult,
  decideControl,
  ownPrefixSufficient,
  slotBaselineOf,
  type ControlAttemptVerdict,
} from "./measure-classify.js";
import { accountRequestCost, sumCosts } from "./measure-plan.js";
import { buildPrefix } from "./measure-prefix.js";
import {
  finalizeRenewal,
  intervalBetween,
  planRenewal,
  readInfoFromClassification,
  unsentRenewalRecord,
  type RenewalGeometry,
} from "./measure-renewal.js";
import {
  CONTROL_SLOT,
  MEASURE_TIMING,
  REQUEST_BUDGET,
  RENEWAL,
  type CostAccount,
  type ControlRecord,
  type EffectiveTier,
  type ExecutionPlan,
  type InconclusiveReason,
  type Landed1h,
  type MeasureAction,
  type MeasureApi,
  type MeasureCancelReason,
  type MeasureClaim,
  type MeasureClaimToken,
  type MeasureOutcomeClass,
  type MeasurePriceFn,
  type MeasureProgress,
  type MeasureRequestKind,
  type MeasureRouteIdentity,
  type MeasureRunHandle,
  type MeasureRunRecord,
  type MeasureRunStatus,
  type MeasureSendFn,
  type MeasureSendRequest,
  type MeasureStatusReason,
  type MeasureStorePort,
  type MeasureUsage,
  type PayloadExpectation,
  type PayloadVerdict,
  type RenewalRecord,
  type RequestTiming,
  type SkipReason,
  type SlotBaseline,
  type SyntheticPrefix,
  type TtlSampleRecord,
  type UsageReading,
} from "./measure-types.js";

/** Extra wait past a send's `deadlineAt` before a never-resolving `send` promise is declared lost. */
export const SEND_RESOLVE_GRACE_MS = 2_000;

export interface MeasureRunnerDeps {
  plan: ExecutionPlan;
  token: MeasureClaimToken;
  claim: MeasureClaim;
  send: MeasureSendFn;
  clock: Clock;
  /** Fire-and-forget persistence; the runner never awaits it. */
  persist: Pick<MeasureStorePort, "persist" | "lastSavedAt">;
  /** Progress callback (status line). Called synchronously, try/catch-wrapped, owner-fenced. */
  onProgress(progress: MeasureProgress): void;
  /** Final callback (notify). Called once, try/catch-wrapped, owner-fenced, before the claim is released. */
  onDone(record: MeasureRunRecord, route: MeasureRouteIdentity | undefined): void;
  /** P1 `measure-usage`: the strict reader (reads `outcome.measured.rawUsage` for the plan's profile). */
  readUsage(outcome: PipelineOutcome): UsageReading;
  /** P1 `measure-payload`: `validateMeasurePayload(profile, params, expect)`. */
  validatePayload(params: Record<string, unknown>, expect: PayloadExpectation): PayloadVerdict;
  /** P1 `measure-route`: route key of the request URL, bound to api + wire model + effective tier. */
  routeKeyFor(input: {
    api: MeasureApi;
    wireModel: string;
    effectiveTier: EffectiveTier;
    requestUrl: string;
  }): PipelineMeasureRouteKey;
  /** Registry-priced cost function; `undefined` ⇒ unpriced route. */
  price: MeasurePriceFn | undefined;
  /** Auth is an OAuth token / model compat `supportsMidConvoEffort` (validator expectations). */
  payload: { oauth: boolean; managedEffort: boolean; promptCacheKeyFor?: (sessionId: string) => string | undefined };
  /** Lower-case normalised origin of the model's base URL (enables the documented renewal basis iff official). */
  routeOrigin?: string;
  versions?: { toolkitVersion?: string; piVersion?: string };
  /** Test seam: shortens the run's hard deadline (default {@link MEASURE_TIMING}`.hardDeadlineMs`, 80 min). */
  hardDeadlineMs?: number;
}

interface SlotState {
  slot: number;
  gapMs: number;
  attempt: number;
  prefix?: SyntheticPrefix;
  body?: Record<string, unknown>;
  baseline?: SlotBaseline;
  writeTiming?: RequestTiming;
  anchorTiming?: RequestTiming;
  probeTiming?: RequestTiming;
  anchored: boolean;
  unavailable: boolean;
  w1h?: { W: number; W1h: number | undefined };
  /** Final sample once decided. */
  sample?: TtlSampleRecord;
}

/** One processed request (never exposes the raw outcome to the phases). */
interface Done {
  cls: MeasureOutcomeClass;
  action: MeasureAction;
  sent: boolean;
  timing?: RequestTiming;
  reading?: UsageReading;
  usage?: MeasureUsage;
  builtBody?: Record<string, unknown>;
  routeKey?: string;
  routeLabel?: string;
  /** The run ended (cancel / deadline / stale owner) while this request was pending or before it started. */
  aborted?: true;
  /** Refused by the cap (nothing sent). */
  budget?: true;
  /** Refused because the previous send's transport has not settled. */
  ioBusy?: true;
}

const FINAL_VERDICTS = new Set<TtlSampleRecord["verdict"]>(["hit", "miss", "skipped"]);

export function startMeasurement(deps: MeasureRunnerDeps): MeasureRunHandle {
  const { plan, token, claim, send, clock } = deps;
  const startedAt = clock.now();
  const hardMs = deps.hardDeadlineMs ?? MEASURE_TIMING.hardDeadlineMs;
  const hardAt = startedAt + hardMs;
  const slots: SlotState[] = plan.slots.map((p) => ({
    slot: p.slot,
    gapMs: p.gapMs,
    attempt: 0,
    anchored: false,
    unavailable: false,
  }));
  const abort = new AbortController();

  // ---- run state ------------------------------------------------------------------------------------------------
  let ended = false;
  let record: MeasureRunRecord | undefined;
  let statusNow: MeasureRunStatus = "running";
  let sent = 0;
  let possiblyBilled = 0;
  let replacementsLeft = REQUEST_BUDGET.replacements;
  let rateLimited = false;
  const costs: CostAccount[] = [];
  let routeKey: string | undefined;
  let routeLabel: string | undefined;
  let effectiveTier: EffectiveTier | undefined;
  let route: MeasureRouteIdentity | undefined;
  let control: ControlRecord = { verdict: "not-run", attempts: 0 };
  let renewal: RenewalRecord | undefined;
  let firstWriteGated = false;
  let ownPending = 0;
  let inflight: MeasureRequestKind | undefined;
  let next: { at: Millis; kind: MeasureRequestKind; gapMs?: number } | undefined;
  let idleWaiters: Array<() => void> = [];
  const sleepers = new Set<{ timer: TimerHandle; resolve: (reached: boolean) => void }>();

  let resolveDone!: (r: MeasureRunRecord) => void;
  const done = new Promise<MeasureRunRecord>((resolve) => {
    resolveDone = resolve;
  });

  const alive = (): boolean => !ended && claim.owns(token);

  // ---- helpers --------------------------------------------------------------------------------------------------
  const sampleRecords = (final: boolean, skipReason: SkipReason): TtlSampleRecord[] => {
    const out: TtlSampleRecord[] = [];
    for (const s of slots) {
      if (s.sample !== undefined) {
        if (final || FINAL_VERDICTS.has(s.sample.verdict)) out.push(s.sample);
      } else if (final) {
        out.push(
          s.unavailable
            ? { gapMs: s.gapMs, verdict: "unavailable" }
            : { gapMs: s.gapMs, verdict: "skipped", reason: skipReason },
        );
      }
    }
    return out;
  };

  const landed1h = (): Landed1h | undefined => {
    if (plan.api !== "anthropic-messages" || plan.requestedRetention !== "long") return undefined;
    const seen = slots.map((s) => s.w1h).filter((w): w is { W: number; W1h: number | undefined } => w !== undefined);
    if (seen.some((w) => w.W1h !== undefined && w.W1h > 0)) return true;
    if (seen.length > 0 && seen.every((w) => w.W1h !== undefined && w.W > 0)) return false;
    return "unknown";
  };

  const buildRecord = (
    status: MeasureRunStatus,
    reason: MeasureStatusReason | undefined,
    finalRun: boolean,
    skipReason: SkipReason,
  ): MeasureRunRecord => {
    const samples = sampleRecords(finalRun, skipReason);
    const all = [...costs];
    if (finalRun && inflight !== undefined) {
      // a send was still pending when the run ended: count it conservatively (it may have reached the server)
      all.push(
        accountRequestCost({
          api: plan.api,
          requestedRetention: plan.requestedRetention,
          outputCap: plan.outputCap,
          sent: true,
          price: deps.price,
          pBound: plan.tokens.pBound,
        }),
      );
    }
    const sentCount = sent + (finalRun && inflight !== undefined ? 1 : 0);
    const billedCount = possiblyBilled + (finalRun && inflight !== undefined ? 1 : 0);
    const written = slots.filter((s) => s.baseline !== undefined);
    const landed = landed1h();
    return {
      runId: plan.runId,
      status,
      ...(reason !== undefined ? { statusReason: reason } : {}),
      startedAt,
      ...(finalRun ? { finishedAt: clock.now() } : {}),
      load: { prefixes: written.length, ownTokens: written.reduce((n, s) => n + s.baseline!.S, 0) },
      ttl: computeTtlResult(samples, status),
      samples,
      control,
      ...(landed !== undefined ? { landed1h: landed } : {}),
      ...(renewal !== undefined ? { renewal } : {}),
      requests: { cap: REQUEST_BUDGET.total, sent: sentCount, possiblyBilled: billedCount },
      cost: { ...sumCosts(all), estimate: plan.estimate },
      ...(deps.versions?.toolkitVersion !== undefined ? { toolkitVersion: deps.versions.toolkitVersion } : {}),
      ...(deps.versions?.piVersion !== undefined ? { piVersion: deps.versions.piVersion } : {}),
    };
  };

  const snapshot = (): MeasureProgress => {
    const slotsDone = slots.filter((s) => s.sample !== undefined && FINAL_VERDICTS.has(s.sample.verdict)).length;
    return {
      runId: plan.runId,
      label: routeLabel ?? plan.wireModel,
      status: statusNow,
      startedAt,
      slotsDone,
      ...(next !== undefined && !ended
        ? { nextDueAt: next.at, nextKind: next.kind, ...(next.gapMs !== undefined ? { nextGapMs: next.gapMs } : {}) }
        : {}),
      sent,
      cost: sumCosts(costs),
      ...(deps.persist.lastSavedAt !== undefined ? { lastSavedAt: deps.persist.lastSavedAt } : {}),
      physicalPending: claim.physicalPending,
    };
  };

  const progress = (): void => {
    if (!alive()) return;
    try {
      deps.onProgress(snapshot());
    } catch {
      /* never affects the run */
    }
  };

  const persistProgress = (): void => {
    if (route === undefined || !alive()) return;
    try {
      deps.persist.persist(route, "inProgress", buildRecord("running", undefined, false, "run-ended"));
    } catch {
      /* never throws into the run */
    }
  };

  /** Logical end, synchronous. Idempotent. */
  const endRun = (
    status: MeasureRunStatus,
    reason: MeasureStatusReason | undefined,
    skipReason: SkipReason = "run-ended",
  ): void => {
    if (ended) return;
    const owned = claim.owns(token);
    ended = true;
    statusNow = status;
    for (const s of sleepers) {
      clock.clearTimer(s.timer);
      s.resolve(false);
    }
    sleepers.clear();
    clock.clearTimer(hardTimer);
    abort.abort();
    record = buildRecord(status, reason, true, skipReason);
    const final = record;
    if (owned) {
      try {
        if (route !== undefined) {
          const measuredSomething =
            final.ttl.validHits + final.ttl.validMisses > 0 ||
            status === "complete" ||
            status === "partial" ||
            status === "no-cache" ||
            status === "control-inconclusive" ||
            status === "inconclusive";
          if (measuredSomething) deps.persist.persist(route, "latest", final);
          deps.persist.persist(route, "inProgress", null);
        }
      } catch {
        /* swallowed */
      }
      try {
        deps.onDone(final, route);
      } catch {
        /* swallowed */
      }
      try {
        claim.finishLogical(token, clock.now());
      } catch {
        /* swallowed */
      }
    }
    resolveDone(final);
  };

  const hardTimer = clock.setTimer(hardMs, () => {
    if (ended) return;
    const measured =
      slots.some((s) => s.sample !== undefined && (s.sample.verdict === "hit" || s.sample.verdict === "miss")) ||
      control.verdict === "hit";
    endRun(measured ? "partial" : "inconclusive", "hard-deadline", "hard-deadline");
  });

  const fail = (reason: MeasureStatusReason): void => endRun("failed", reason);

  const sleepUntil = (at: Millis): Promise<boolean> => {
    if (ended) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry: { timer: TimerHandle; resolve: (reached: boolean) => void } = {
        timer: undefined as unknown as TimerHandle,
        resolve,
      };
      entry.timer = clock.setTimer(Math.max(0, at - clock.now()), () => {
        sleepers.delete(entry);
        resolve(true);
      });
      sleepers.add(entry);
    });
  };

  const waitIdle = (maxMs: number): Promise<boolean> => {
    if (ownPending === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const timer = clock.setTimer(maxMs, () => {
        if (finished) return;
        finished = true;
        resolve(ownPending === 0);
      });
      idleWaiters.push(() => {
        if (finished) return;
        finished = true;
        clock.clearTimer(timer);
        resolve(true);
      });
    });
  };

  const expectation = (prefix: SyntheticPrefix): PayloadExpectation => {
    const key = deps.payload.promptCacheKeyFor?.(prefix.sessionId);
    return {
      api: plan.api,
      wireModel: plan.wireModel,
      expectedSystem: prefix.systemPrompt,
      expectedUser: prefix.userText,
      outputCap: plan.outputCap,
      requestedRetention: plan.requestedRetention,
      oauth: deps.payload.oauth,
      managedEffort: deps.payload.managedEffort,
      ...(key !== undefined ? { promptCacheKey: key } : {}),
    };
  };

  // ---- one request ----------------------------------------------------------------------------------------------
  interface Spec {
    kind: MeasureRequestKind;
    slot: SlotState;
    /** Write only. */
    prefix?: SyntheticPrefix;
    /** Timed sends: planned time + the lateness reference gap. */
    due?: { at: Millis; gapMs: number };
  }

  async function doRequest(spec: Spec): Promise<Done> {
    const unsent = (extra: Pick<Done, "aborted"> | Pick<Done, "ioBusy"> | Pick<Done, "budget">): Done => ({
      cls: "not-sent-transient",
      action: MEASURE_ACTION_TABLE["not-sent-transient"][spec.kind],
      sent: false,
      ...extra,
    });
    const aborted = unsent({ aborted: true });
    if (!alive()) return aborted;
    if (ownPending > 0) {
      if (spec.kind !== "write") return unsent({ ioBusy: true });
      const idle = await waitIdle(MEASURE_TIMING.perSendDeadlineMs);
      if (!alive()) return aborted;
      if (!idle) return unsent({ ioBusy: true });
    }
    if (sent >= REQUEST_BUDGET.total) return unsent({ budget: true });

    const lateLimit =
      spec.due !== undefined
        ? spec.due.at + Math.max(MEASURE_TIMING.lateMinMs, MEASURE_TIMING.lateFraction * spec.due.gapMs)
        : Number.POSITIVE_INFINITY;
    let lateRefused = false;
    const refuseIfLate = (): boolean => {
      if (clock.now() > lateLimit) {
        lateRefused = true;
        return true;
      }
      return false;
    };
    if (refuseIfLate()) {
      const cls: MeasureOutcomeClass = "not-sent-late";
      return { cls, action: resolveMeasureAction(cls, spec.kind), sent: false };
    }

    const s = spec.slot;
    const prefix = spec.prefix ?? s.prefix!;
    const callAt = clock.now();
    const deadlineAt = Math.min(callAt + MEASURE_TIMING.perSendDeadlineMs, hardAt);
    let verdictTier: EffectiveTier | undefined;
    const request: MeasureSendRequest = {
      kind: spec.kind,
      slot: s.slot,
      attempt: prefix.attempt,
      sessionId: prefix.sessionId,
      ...(spec.kind === "write"
        ? {
            build: {
              context: prefix.context,
              validate: (params: Record<string, unknown>): string | undefined => {
                const v = deps.validatePayload(params, expectation(prefix));
                if (v.ok) {
                  verdictTier = v.effectiveTier;
                  effectiveTier ??= v.effectiveTier;
                  return undefined;
                }
                return v.code;
              },
            },
          }
        : { body: s.body! }),
      routeKey: (requestUrl: string) => {
        const tier = effectiveTier ?? verdictTier;
        if (tier === undefined) throw new Error("effective tier not known yet");
        return deps.routeKeyFor({ api: plan.api, wireModel: plan.wireModel, effectiveTier: tier, requestUrl });
      },
      ...(routeKey !== undefined ? { expectRouteKey: routeKey } : {}),
      deadlineAt,
      guard: () => alive() && clock.now() < hardAt && !refuseIfLate(),
      signal: abort.signal,
    };

    inflight = spec.kind;
    claim.ioBegin();
    ownPending += 1;
    const settleOnce = (() => {
      let fired = false;
      return () => {
        if (fired) return;
        fired = true;
        ownPending = Math.max(0, ownPending - 1);
        claim.ioSettled();
        if (ownPending === 0) {
          const ws = idleWaiters;
          idleWaiters = [];
          for (const w of ws) w();
        }
      };
    })();

    type Raced = { result: PipelinePingResult } | { stuck: true };
    const raced = await new Promise<Raced>((resolve) => {
      let finished = false;
      const timer = clock.setTimer(Math.max(0, deadlineAt + SEND_RESOLVE_GRACE_MS - clock.now()), () => {
        if (finished) return;
        finished = true;
        resolve({ stuck: true });
      });
      let p: Promise<PipelinePingResult>;
      try {
        p = send(request);
      } catch {
        clock.clearTimer(timer);
        settleOnce();
        finished = true;
        resolve({ stuck: true });
        return;
      }
      p.then(
        (result) => {
          // `settled` never rejects by contract; guard anyway so the physical ledger always balances
          void Promise.resolve(result.settled).then(settleOnce, settleOnce);
          if (finished) return;
          finished = true;
          clock.clearTimer(timer);
          resolve({ result });
        },
        () => {
          settleOnce();
          if (finished) return;
          finished = true;
          clock.clearTimer(timer);
          resolve({ stuck: true });
        },
      );
    });
    if (ended || !claim.owns(token)) {
      // the request's own bookkeeping is superseded by the run's end (it was counted conservatively there)
      inflight = ended ? inflight : undefined;
      return aborted;
    }
    inflight = undefined;

    // ---- interpret ---------------------------------------------------------------------------------------------
    if ("stuck" in raced) {
      const cls: MeasureOutcomeClass = "sent-lost";
      const action = resolveMeasureAction(cls, spec.kind);
      return account({ cls, action, sent: true });
    }
    const outcome = raced.result.outcome;
    let reading: UsageReading | undefined;
    if (outcome.kind === "usage") {
      try {
        reading = deps.readUsage(outcome);
      } catch {
        reading = {
          cacheEvidence: { kind: "invalid", reason: "no-terminal-frame" },
          billing: { kind: "unknown", items: ["all"] },
        };
      }
    }
    const cls = classifyMeasureOutcome(outcome, reading, { lateRefused });
    const action = resolveMeasureAction(cls, spec.kind, {
      ...(outcome.measured?.rejection !== undefined ? { rejection: outcome.measured.rejection } : {}),
      ...(outcome.kind === "http" ? { httpStatus: outcome.status } : {}),
    });
    const m = outcome.measured;
    const timing: RequestTiming | undefined =
      m?.sentAt !== undefined && m.headersAt !== undefined
        ? { sentAt: m.sentAt, headersAt: m.headersAt }
        : wasSent(outcome) && outcome.kind === "usage"
          ? { sentAt: callAt, headersAt: clock.now() } // conservative widening when the transport gave no timings
          : undefined;
    return account({
      cls,
      action,
      sent: wasSent(outcome),
      ...(timing !== undefined ? { timing } : {}),
      ...(reading !== undefined ? { reading } : {}),
      ...(reading?.cacheEvidence.kind === "valid" && reading.usage !== undefined ? { usage: reading.usage } : {}),
      ...(m?.builtBody !== undefined ? { builtBody: m.builtBody } : {}),
      ...(m?.routeKey !== undefined ? { routeKey: m.routeKey } : {}),
      ...(m?.routeLabel !== undefined ? { routeLabel: m.routeLabel } : {}),
    });
  }

  /** Counters, cost, flags and the §4.3 runtime bound guard for one interpreted request. */
  function account(d: Done): Done {
    if (d.cls === "http-429") rateLimited = true;
    if (d.sent) {
      sent += 1;
      const billed =
        d.action.kind === "replacement" ||
        d.action.kind === "retry-control" ||
        d.action.kind === "inconclusive" ||
        d.action.kind === "renewal-unknown"
          ? d.action.possiblyBilled
          : false;
      if (billed) possiblyBilled += 1;
      costs.push(
        accountRequestCost({
          api: plan.api,
          requestedRetention: plan.requestedRetention,
          outputCap: plan.outputCap,
          sent: true,
          ...(d.reading !== undefined ? { reading: d.reading } : {}),
          price: deps.price,
          pBound: plan.tokens.pBound,
        }),
      );
    }
    if (d.sent && boundBroken(d.usage, plan.tokens.pBound, plan.outputCap) !== undefined) {
      fail("bound-exceeded");
    }
    return d;
  }

  // ---- verdict helpers ---------------------------------------------------------------------------------------------
  const probeReasonOf = (cls: MeasureOutcomeClass): InconclusiveReason => {
    const cell = MEASURE_ACTION_TABLE[cls].probe;
    return cell.kind === "inconclusive" ? cell.reason : "not-sent";
  };

  type ReadVerdict = { verdict: "hit" | "miss" } | { verdict: "inconclusive"; reason: InconclusiveReason };

  /** Control / probe read → hit | miss | inconclusive (table first, then §5.3 classification). */
  const readVerdict = (d: Done, baseline: SlotBaseline): ReadVerdict => {
    // runner-local refusals first: they carry the transient not-sent action but have their own reasons
    if (d.ioBusy === true) return { verdict: "inconclusive", reason: "io-busy" };
    if (d.budget === true) return { verdict: "inconclusive", reason: "budget" };
    if (d.action.kind === "classify" && d.usage !== undefined) {
      const c = classifyRead(baseline, d.usage);
      return c.kind === "inconclusive" ? { verdict: "inconclusive", reason: c.reason } : { verdict: c.kind };
    }
    if (d.action.kind === "inconclusive") return { verdict: "inconclusive", reason: d.action.reason };
    return { verdict: "inconclusive", reason: probeReasonOf(d.cls) };
  };

  const sampleOf = (s: SlotState, v: ReadVerdict, d: Done): TtlSampleRecord => {
    const idle =
      d.timing !== undefined && s.anchorTiming !== undefined ? intervalBetween(s.anchorTiming, d.timing) : undefined;
    return {
      gapMs: s.gapMs,
      verdict: v.verdict,
      ...(v.verdict === "inconclusive" ? { reason: v.reason } : {}),
      ...(idle !== undefined ? { idleMs: idle } : {}),
      ...(d.usage !== undefined && s.baseline !== undefined
        ? { P: d.usage.P, C: d.usage.C, B: s.baseline.B, S: s.baseline.S }
        : {}),
      ...(d.reading !== undefined
        ? { cacheEvidence: d.reading.cacheEvidence.kind === "valid" ? ("valid" as const) : ("invalid" as const) }
        : {}),
      ...(d.reading !== undefined
        ? { billing: d.reading.billing.kind === "complete" ? ("complete" as const) : ("unknown" as const) }
        : {}),
    };
  };

  const measuredAnything = (): boolean =>
    control.verdict === "hit" ||
    slots.some((s) => s.sample !== undefined && (s.sample.verdict === "hit" || s.sample.verdict === "miss"));

  // ---- phase 1: writes ---------------------------------------------------------------------------------------------
  async function writePhase(): Promise<boolean> {
    for (const s of slots) {
      let attempt = 0;
      for (;;) {
        if (!alive()) return false;
        const prefix = buildPrefix(plan.runId, s.slot, attempt);
        s.prefix = prefix;
        s.attempt = attempt;
        next = undefined;
        progress();
        const d = await doRequest({ kind: "write", slot: s, prefix });
        if (ended || d.aborted === true) return false;
        if (d.ioBusy === true || d.budget === true) {
          s.unavailable = true;
          break;
        }
        const a = d.action;
        if (a.kind === "failed") {
          fail(a.reason);
          return false;
        }
        if (a.kind === "anchor") {
          if (d.usage === undefined || d.timing === undefined || d.builtBody === undefined) {
            fail("internal");
            return false;
          }
          if (d.routeKey === undefined || (routeKey !== undefined && d.routeKey !== routeKey)) {
            fail("route");
            return false;
          }
          const baseline = slotBaselineOf(d.usage);
          if (routeKey === undefined) {
            routeKey = d.routeKey;
            routeLabel = d.routeLabel ?? plan.wireModel;
            route = {
              key: routeKey,
              label: routeLabel,
              api: plan.api,
              wireModel: plan.wireModel,
              requestedRetention: plan.requestedRetention,
              effectiveTier: effectiveTier ?? "auto",
            };
          }
          if (!firstWriteGated) {
            firstWriteGated = true;
            if (!ownPrefixSufficient(baseline)) {
              s.baseline = baseline;
              s.writeTiming = d.timing;
              endRun("inconclusive", "prefix-too-small");
              return false;
            }
          }
          s.baseline = baseline;
          s.body = d.builtBody;
          s.writeTiming = d.timing;
          s.anchorTiming = d.timing;
          s.anchored = true;
          s.w1h = { W: d.usage.W ?? 0, W1h: d.usage.W1h };
          persistProgress();
          progress();
          break;
        }
        if (a.kind === "replacement") {
          if (replacementsLeft <= 0) {
            s.unavailable = true;
            break;
          }
          replacementsLeft -= 1;
          attempt += 1;
          if (a.waitMs !== undefined) {
            const reached = await sleepUntil(clock.now() + a.waitMs);
            if (!reached || !alive()) return false;
          }
          continue;
        }
        fail("internal"); // no other action is defined for a write
        return false;
      }
    }
    const ctl = slots[CONTROL_SLOT]!;
    if (!ctl.anchored) {
      fail("unavailable-slots");
      return false;
    }
    return true;
  }

  // ---- phase 2: control --------------------------------------------------------------------------------------------
  async function controlPhase(): Promise<boolean> {
    const s = slots[CONTROL_SLOT]!;
    const attempts: ControlAttemptVerdict[] = [];
    const writeHeaders = s.writeTiming!.headersAt;
    for (let i = 0; i < MEASURE_TIMING.controlDelaysMs.length; i++) {
      const delay = MEASURE_TIMING.controlDelaysMs[i]!;
      const at = writeHeaders + delay;
      next = { at, kind: "control" };
      progress();
      if (!(await sleepUntil(at)) || !alive()) return false;
      const d = await doRequest({ kind: "control", slot: s, due: { at, gapMs: delay } });
      if (ended || d.aborted === true) return false;
      if (d.action.kind === "failed") {
        fail(d.action.reason);
        return false;
      }
      const v = readVerdict(d, s.baseline!);
      attempts.push(v.verdict === "inconclusive" ? "other" : v.verdict);
      control = {
        verdict: v.verdict === "inconclusive" ? "inconclusive" : v.verdict,
        attempts: attempts.length as 1 | 2,
        ...(v.verdict === "inconclusive" ? { reason: v.reason } : {}),
      };
      const decision = decideControl(attempts);
      if (decision.kind === "proceed") {
        control = { verdict: "hit", attempts: attempts.length as 1 | 2 };
        if (d.timing !== undefined) s.anchorTiming = d.timing; // slot 5's anchor moves to the control touch
        persistProgress();
        return true;
      }
      if (decision.kind === "no-cache") {
        control = { verdict: "miss", attempts: 2 };
        endRun("no-cache", undefined);
        return false;
      }
      if (decision.kind === "control-inconclusive") {
        endRun("control-inconclusive", undefined);
        return false;
      }
      // retry: the second attempt, unless the cap forbids it
      if (sent >= REQUEST_BUDGET.total) {
        endRun("control-inconclusive", "budget");
        return false;
      }
    }
    endRun("control-inconclusive", undefined);
    return false;
  }

  // ---- phase 3: probes (+ phase 4: boundary renewal) -------------------------------------------------------------
  async function probePhase(): Promise<void> {
    const order = slots
      .filter((s) => s.anchored)
      .map((s) => ({ s, at: s.anchorTiming!.headersAt + s.gapMs }))
      .sort((x, y) => x.at - y.at || x.s.slot - y.s.slot);
    for (const { s, at } of order) {
      next = { at, kind: "probe", gapMs: s.gapMs };
      progress();
      if (!(await sleepUntil(at)) || !alive()) return;
      const d = await doRequest({ kind: "probe", slot: s, due: { at, gapMs: s.gapMs } });
      if (ended || d.aborted === true) return;
      if (d.action.kind === "failed") {
        fail(d.action.reason);
        return;
      }
      const v = readVerdict(d, s.baseline!);
      if (d.cls === "http-429") rateLimited = true;
      s.sample = sampleOf(s, v, d);
      if ((v.verdict === "hit" || v.verdict === "miss") && d.timing !== undefined) s.probeTiming = d.timing;
      persistProgress();
      progress();
      if (v.verdict === "miss") {
        for (const later of slots) {
          if (later.sample === undefined && later.gapMs > s.gapMs) {
            later.sample = { gapMs: later.gapMs, verdict: "skipped", reason: "implied-miss" };
          }
        }
        await renewalPhase(s);
        if (ended) return;
        break;
      }
    }
    if (ended) return;
    if (renewal === undefined) renewal = unsentRenewalRecord("no-expiry-observed");
    const resolved = slots.every(
      (s) =>
        s.sample !== undefined &&
        (s.sample.verdict === "hit" ||
          s.sample.verdict === "miss" ||
          (s.sample.verdict === "skipped" && s.sample.reason === "implied-miss")),
    );
    endRun(resolved ? "complete" : measuredAnything() ? "partial" : "inconclusive", undefined);
  }

  /** §5.5: ONE boundary renewal read on the largest-gap hit prefix, only when the actual-interval eligibility holds. */
  async function renewalPhase(b: SlotState): Promise<void> {
    const hits = slots.filter(
      (s) =>
        s.sample?.verdict === "hit" &&
        s.sample.cacheEvidence === "valid" &&
        s.sample.idleMs !== undefined &&
        s.probeTiming !== undefined &&
        s.writeTiming !== undefined &&
        s.slot !== b.slot,
    );
    if (hits.length === 0 || b.probeTiming === undefined || b.writeTiming === undefined) {
      renewal = unsentRenewalRecord("pair-ineligible");
      return;
    }
    const a = hits.reduce((best, s) => (s.sample!.idleMs![0] > best.sample!.idleMs![0] ? s : best));
    const geometry: RenewalGeometry = {
      tier: effectiveTier ?? "auto",
      ...(deps.routeOrigin !== undefined ? { origin: deps.routeOrigin } : {}),
      lowerMs: a.sample!.idleMs![0],
      touchedGapMs: a.gapMs,
      untouchedGapMs: b.gapMs,
      wA: a.writeTiming!,
      r1: a.probeTiming!,
      wB: b.writeTiming,
      miss: b.probeTiming,
      rateLimited,
      involvedValid: b.sample?.cacheEvidence === "valid" && a.sample?.cacheEvidence === "valid",
    };
    const rp = planRenewal(geometry);
    if (!rp.eligible) {
      renewal = unsentRenewalRecord("pair-ineligible", geometry);
      return;
    }
    if (sent >= REQUEST_BUDGET.total) {
      renewal = unsentRenewalRecord("budget", geometry);
      return;
    }
    next = { at: rp.plannedSentAt, kind: "renewal", gapMs: RENEWAL.delayAfterMissMs };
    progress();
    if (!(await sleepUntil(rp.plannedSentAt)) || !alive()) return;
    const d = await doRequest({
      kind: "renewal",
      slot: a,
      due: { at: rp.plannedSentAt, gapMs: RENEWAL.delayAfterMissMs },
    });
    if (ended || d.aborted === true) return;
    const act = d.action;
    if (act.kind === "failed") {
      fail(act.reason);
      return;
    }
    if (act.kind === "evaluate-renewal" && d.usage !== undefined && d.timing !== undefined) {
      const c = classifyRead(a.baseline!, d.usage);
      renewal = finalizeRenewal(geometry, readInfoFromClassification(c, d.timing, d.usage, a.baseline!));
    } else if (act.kind === "renewal-unknown") {
      renewal = finalizeRenewal(
        geometry,
        d.sent
          ? { verdict: "inconclusive", reason: act.reason, ...(d.timing !== undefined ? { timing: d.timing } : {}) }
          : { verdict: "not-sent", reason: act.reason },
      );
    } else {
      renewal = finalizeRenewal(geometry, {
        verdict: "not-sent",
        reason: d.budget === true ? "budget" : "not-sent",
      });
    }
    persistProgress();
  }

  // ---- main --------------------------------------------------------------------------------------------------------
  const handle: MeasureRunHandle = {
    snapshot,
    cancel(reason: MeasureCancelReason): void {
      if (ended) return;
      if (renewal === undefined && route !== undefined) renewal = unsentRenewalRecord("cancelled");
      endRun("cancelled", reason, "cancelled");
    },
    done,
  };
  // `preparing → running` here (not left to the caller) so a run that ends before the caller's own `start` can never
  // leave the claim stuck in `running`. A token that no longer owns the claim ends the run silently.
  if (!claim.start(token, handle) && !claim.owns(token)) endRun("cancelled", "session-quit");

  void (async () => {
    try {
      if (!(await writePhase())) return;
      if (!(await controlPhase())) return;
      await probePhase();
    } catch {
      fail("internal");
    } finally {
      // a stale owner (revoked / replaced generation) stops silently: close the logical run without any callback
      if (!ended) endRun("cancelled", "session-quit");
    }
  })();

  return handle;
}
