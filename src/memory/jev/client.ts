// Jev client: failover across the configured classifier list, error-grade
// isolation, availability caching, context-batch splitting, sync/background
// concurrency caps, budget/rate limiting, and status-change notification
// plumbing (jev-arch §5.1–§5.3/§5.5, jev-plan J2).
//
// I1: `req.budgetMs` is clamped via `clampSpanMs`; every timer here is
// `unref`'d (I5). I4: the only module-scope mutable state anywhere in this
// tree is the two Symbol-keyed tables in `health.ts` — this file holds
// everything else as instance state inside the closure returned by
// `createJevClient`, which the wire layer (J6) owns for the session.
//
// Pi-free root.

import { clampSpanMs } from "../../core/deadline.js";
import type {
  ClassifierRegistryLike,
  FetchLike,
  HealthTable,
  JevAnswer,
  JevClient,
  JevConfig,
  JevOutcome,
  JevRequest,
  JevStatus,
  JevUsage,
  TokenBucket,
} from "./contracts.js";
import { classifyError, createTokenBucket, errorCode, getHealthTable, summarizeStatus } from "./health.js";
import type { AvailabilityKind } from "./health.js";
import { createProxyFetch } from "./proxy-fetch.js";

const AVAILABILITY_CACHE_MS = 10 * 60_000;
const UNAVAILABLE_ISOLATION_MS = 60 * 60_000;
const TRANSIENT_ISOLATION_MS = 10 * 60_000;
const TRANSIENT_FAIL_THRESHOLD = 3;
const SYNC_CONCURRENCY = 3;
const BACKGROUND_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 4_000;

function splitId(id: string): { provider: string; model: string } {
  const slash = id.indexOf("/");
  return slash === -1 ? { provider: id, model: "" } : { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

// ───────────────────────────── availability resolution (§5.2 "有凭证 ≠ 可用") ─────────────────────────────

async function resolveAvailability(
  registry: ClassifierRegistryLike,
  classifiers: readonly string[],
): Promise<Map<string, AvailabilityKind>> {
  const out = new Map<string, AvailabilityKind>();
  let availSet: Set<string>;
  try {
    const list = registry.getAvailableOfType === undefined ? [] : await registry.getAvailableOfType("classifier");
    availSet = new Set(list.map((m) => `${m.provider}/${m.id}`));
  } catch {
    availSet = new Set();
  }
  for (const id of classifiers) {
    if (availSet.has(id)) {
      out.set(id, "available");
      continue;
    }
    const { provider, model } = splitId(id);
    let exists = true;
    try {
      exists =
        registry.getModelOfType === undefined
          ? true
          : registry.getModelOfType("classifier", provider, model) !== undefined;
    } catch {
      exists = true; // fail open on the probe itself — don't mislabel as not-found
    }
    out.set(id, exists ? "no-auth" : "not-found");
  }
  return out;
}

// ───────────────────────────── tiny async semaphore ─────────────────────────────

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }
}

// ───────────────────────────── outcome helpers ─────────────────────────────

function computeMissing(questions: Record<string, unknown>, answers: Record<string, JevAnswer>): readonly string[] {
  return Object.keys(questions).filter((id) => answers[id] === undefined);
}

type JevFailReason = Extract<JevOutcome, { ok: false }>["reason"];

function fail(reason: JevFailReason, detail: string): JevOutcome {
  return { ok: false, reason, detail };
}

function statusEquals(a: JevStatus, b: JevStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "off" && b.kind === "off") return a.reason === b.reason;
  if (a.kind === "full" && b.kind === "full") return a.model === b.model;
  if (a.kind === "partial" && b.kind === "partial") {
    return a.reason === b.reason && a.inactive === b.inactive && a.retryAt === b.retryAt;
  }
  return true; // probing === probing
}

// ───────────────────────────── client ─────────────────────────────

/** Code-point-safe substring (no splitting of surrogate pairs — classifier
 *  error messages can carry CJK emoji etc. from provider bodies). */
function capCp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

export interface CreateJevClientDeps {
  readonly config: JevConfig;
  readonly isChild: boolean;
  readonly now: () => number;
  readonly health?: HealthTable;
  readonly bucket?: TokenBucket;
  readonly makeFetch?: (proxy: string) => FetchLike | undefined;
  readonly log?: (line: string) => void;
}

export type JevClientHandle = JevClient & {
  usage(): JevUsage;
  onStatusChange(cb: (prev: JevStatus, next: JevStatus) => void): () => void;
  abortBackground(): void;
  markInactive(inactive: boolean): void;
};

export function createJevClient(deps: CreateJevClientDeps): JevClientHandle {
  const health = deps.health ?? getHealthTable();
  const bucket = deps.bucket ?? createTokenBucket();
  const makeFetch = deps.makeFetch ?? ((proxy: string) => createProxyFetch(proxy));
  const log = deps.log ?? ((): void => {});

  let availability = new Map<string, AvailabilityKind>();
  let availabilityAt = -Infinity;
  let everSucceeded = false;
  let lastModel: string | undefined;
  let usageCostUsd = 0;
  let usageCalls = 0;
  let budgetExhausted = false;
  let inactiveFlag = false;
  let lastStatus: JevStatus | undefined;
  const statusSubscribers = new Set<(prev: JevStatus, next: JevStatus) => void>();
  const backgroundAborts = new Set<AbortController>();
  const syncSem = new Semaphore(SYNC_CONCURRENCY);
  const backgroundSem = new Semaphore(BACKGROUND_CONCURRENCY);

  function currentStatus(): JevStatus {
    return summarizeStatus({
      classifiers: deps.config.classifiers,
      availability,
      health,
      now: deps.now(),
      everSucceeded,
      ...(lastModel === undefined ? {} : { lastModel }),
      budgetExhausted,
      inactive: inactiveFlag,
    });
  }

  function emitStatusChangeIfAny(): void {
    const next = currentStatus();
    if (lastStatus !== undefined && statusEquals(lastStatus, next)) return;
    const prev = lastStatus ?? next;
    lastStatus = next;
    if (prev === next) return;
    for (const cb of statusSubscribers) cb(prev, next);
  }

  async function ensureAvailability(
    registry: ClassifierRegistryLike,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = deps.now();
    if (!force && now - availabilityAt < AVAILABILITY_CACHE_MS) return;
    if (signal?.aborted === true) return; // keep the last known snapshot, do not call the registry
    const resolvePromise = resolveAvailability(registry, deps.config.classifiers);
    const resolved =
      signal === undefined
        ? await resolvePromise
        : await Promise.race([
            resolvePromise,
            new Promise<undefined>((resolve) => {
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
          ]);
    // `getAvailableOfType` takes no signal of its own (contracts.ts) — an
    // abort firing mid-flight can't cancel the underlying call, but it does
    // let `probe()` return promptly instead of hanging on it; the snapshot
    // from a race that resolves later is simply dropped.
    if (resolved === undefined) return;
    availability = resolved;
    availabilityAt = deps.now();
    // Stale no-auth/not-found health entries reset to unknown once the
    // classifier becomes newly available (credentials added mid-session).
    for (const [id, kind] of resolved) {
      if (kind !== "available") continue;
      const h = health.get(id);
      if (h !== undefined && (h.state === "no-auth" || h.state === "not-found")) health.set(id, { state: "unknown" });
    }
    emitStatusChangeIfAny();
  }

  /** Attempt order (2026-11-04 all-failed fix): prefer the classifier the
   *  session last succeeded on (`lastModel`), then any health-"ok" tier, then
   *  clean-unknown tiers, with tiers carrying unresolved consecutive
   *  transient failures demoted last — a free tier that transient-fails every
   *  call must not keep eating the first per-try slice of the budget ahead of
   * a healthy paid tier. Config order is the stable tie-break at equal rank
   * (identical output when all ranks are equal — pure config order). */
  function tierRank(id: string): number {
    if (id === lastModel) return 0;
    const h = health.get(id);
    if (h === undefined) return 2;
    if (h.state === "ok") return 1;
    return (h.transientFails ?? 0) > 0 ? 3 : 2;
  }

  function usableIds(): readonly string[] {
    const now = deps.now();
    const out: string[] = [];
    for (const id of deps.config.classifiers) {
      if (availability.get(id) !== "available") continue;
      const h = health.get(id);
      if (h !== undefined && (h.state === "unavailable" || h.state === "transient")) {
        if (h.until !== undefined && h.until > now) continue;
        health.set(id, { state: "unknown" });
      }
      out.push(id);
    }
    const configIndex = new Map(deps.config.classifiers.map((id, i) => [id, i] as const));
    return out.sort((a, b) => tierRank(a) - tierRank(b) || (configIndex.get(a) ?? 0) - (configIndex.get(b) ?? 0));
  }

  function recordFailure(id: string, errorMessage: string): "unavailable" | "transient" | "context" {
    const grade = classifyError(errorMessage);
    if (grade === "unavailable") {
      health.set(id, {
        state: "unavailable",
        until: deps.now() + UNAVAILABLE_ISOLATION_MS,
        code: errorCode(errorMessage),
      });
    } else if (grade === "transient") {
      const prev = health.get(id);
      const fails = (prev?.transientFails ?? 0) + 1;
      if (fails >= TRANSIENT_FAIL_THRESHOLD) {
        health.set(id, { state: "transient", until: deps.now() + TRANSIENT_ISOLATION_MS, transientFails: 0 });
      } else {
        health.set(id, { state: "unknown", transientFails: fails });
      }
    }
    return grade;
  }

  async function callOnce(
    registry: ClassifierRegistryLike,
    id: string,
    state: JevRequest["state"],
    questions: JevRequest["questions"],
    timeoutMs: number,
    outerSignal: AbortSignal | undefined,
  ): Promise<
    | { ok: true; answers: Record<string, JevAnswer>; costUsd: number }
    | { ok: false; grade: "unavailable" | "transient" | "context" | "aborted"; errorMessage: string }
  > {
    const { provider, model: modelId } = splitId(id);
    const model = registry.getModelOfType?.("classifier", provider, modelId);
    if (model === undefined) return { ok: false, grade: "unavailable", errorMessage: "model not found in registry" };
    if (registry.classify === undefined)
      return { ok: false, grade: "unavailable", errorMessage: "registry has no classify" };
    // Already-aborted signal: never issue a request (zero-wait contract).
    if (outerSignal?.aborted === true) return { ok: false, grade: "aborted", errorMessage: "aborted" };

    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    outerSignal?.addEventListener("abort", onOuterAbort);
    // Per-tier timeout (§5.2: each tier gets at most half the budget) is a
    // transient failure of THIS model — fail over to the next tier — not a
    // caller abort. Only an outer-signal abort maps to "aborted".
    let timedOut = false;
    // read live: the signal can flip during the await (defeats TS narrowing above)
    const outerAborted = (): boolean => outerSignal?.aborted === true;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    try {
      const fetchFn = deps.config.proxy === "" ? undefined : makeFetch(deps.config.proxy);
      const pending = registry.classify(
        model,
        { state, questions },
        { signal: controller.signal, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) },
      );
      const result = await new Promise<Awaited<typeof pending> | undefined>((resolve, reject) => {
        const onAbort = (): void => resolve(undefined);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        void pending.then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err: unknown) => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
      if (result === undefined || controller.signal.aborted) {
        return timedOut && !outerAborted()
          ? { ok: false, grade: "transient", errorMessage: `timeout after ${String(timeoutMs)}ms` }
          : { ok: false, grade: "aborted", errorMessage: "aborted" };
      }
      usageCalls += 1;
      if (result.stopReason === "aborted" || (result.stopReason === "error" && timedOut)) {
        if (timedOut && !outerAborted()) {
          return { ok: false, grade: "transient", errorMessage: `timeout after ${String(timeoutMs)}ms` };
        }
        return { ok: false, grade: "aborted", errorMessage: "aborted" };
      }
      if (result.stopReason === "error") {
        return { ok: false, grade: classifyError(result.errorMessage ?? ""), errorMessage: result.errorMessage ?? "" };
      }
      usageCostUsd += result.usage?.cost?.total ?? 0;
      return { ok: true, answers: result.answers, costUsd: result.usage?.cost?.total ?? 0 };
    } catch (err) {
      // `classify()` must never reject (docs/extensions.md) — defensive only.
      if (outerAborted() && !timedOut) return { ok: false, grade: "aborted", errorMessage: "aborted" };
      return { ok: false, grade: "transient", errorMessage: String((err as Error)?.message ?? err) };
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** §5.1 "context 类：拆半重试一次". Each half is final — no further splits. */
  async function splitContextRetry(
    registry: ClassifierRegistryLike,
    id: string,
    state: JevRequest["state"],
    questions: JevRequest["questions"],
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ answers: Record<string, JevAnswer>; costUsd: number }> {
    const entries = Object.entries(questions);
    const mid = Math.ceil(entries.length / 2);
    const halves = [entries.slice(0, mid), entries.slice(mid)].filter((h) => h.length > 0);
    const answers: Record<string, JevAnswer> = {};
    let costUsd = 0;
    for (const half of halves) {
      const r = await callOnce(registry, id, state, Object.fromEntries(half), timeoutMs, signal);
      if (r.ok) {
        Object.assign(answers, r.answers);
        costUsd += r.costUsd;
      }
      // Missing entries fall out naturally via computeMissing on the merged set.
    }
    return { answers, costUsd };
  }

  async function askInner(req: JevRequest): Promise<JevOutcome> {
    if (deps.config.classifiers.length === 0) return fail("off", "no classifiers configured");
    if (budgetExhausted) return fail("budget", "per-activation cost/call cap reached");
    if (
      (deps.config.maxCostUsd > 0 && usageCostUsd >= deps.config.maxCostUsd) ||
      (deps.config.maxCalls > 0 && usageCalls >= deps.config.maxCalls)
    ) {
      budgetExhausted = true;
      emitStatusChangeIfAny();
      return fail("budget", "per-activation cost/call cap reached");
    }
    if (deps.isChild && !bucket.tryTake(deps.now())) return fail("budget", "child-session token bucket exhausted");

    await ensureAvailability(req.registry, false, req.signal);
    if (req.signal?.aborted === true) return fail("aborted", "aborted");
    const totalBudgetMs = clampSpanMs(req.budgetMs) ?? DEFAULT_BUDGET_MS;
    const startedAt = deps.now();
    const ids = usableIds();
    if (ids.length === 0) return fail("all-failed", "every configured classifier is isolated, unavailable, or unknown");
    // Per-tier failure notes for the final all-failed detail (2026-11-04
    // fix: the old generic detail hid WHICH tier failed and why — the write
    // echo and diag log now carry it, redacted/truncated by the caller).
    const tierErrors: string[] = [];

    for (const id of ids) {
      const elapsed = deps.now() - startedAt;
      const remaining = totalBudgetMs - elapsed;
      if (remaining <= 0) break;
      const perTryTimeoutMs = Math.min(remaining, Math.max(1_000, Math.ceil(totalBudgetMs / 2)));

      const attempt = await callOnce(req.registry, id, req.state, req.questions, perTryTimeoutMs, req.signal);
      if (attempt.ok) {
        everSucceeded = true;
        lastModel = id;
        health.set(id, { state: "ok", transientFails: 0 });
        emitStatusChangeIfAny();
        const missing = computeMissing(req.questions, attempt.answers);
        return {
          ok: true,
          model: id,
          answers: attempt.answers,
          missing,
          costUsd: attempt.costUsd,
          latencyMs: deps.now() - startedAt,
        };
      }
      if (attempt.grade === "aborted") return fail("aborted", attempt.errorMessage);
      if (attempt.grade === "context") {
        const retried = await splitContextRetry(
          req.registry,
          id,
          req.state,
          req.questions,
          perTryTimeoutMs,
          req.signal,
        );
        if (Object.keys(retried.answers).length > 0) {
          everSucceeded = true;
          lastModel = id;
          health.set(id, { state: "ok", transientFails: 0 });
          emitStatusChangeIfAny();
          return {
            ok: true,
            model: id,
            answers: retried.answers,
            missing: computeMissing(req.questions, retried.answers),
            costUsd: retried.costUsd,
            latencyMs: deps.now() - startedAt,
          };
        }
        continue;
      }
      recordFailure(id, attempt.errorMessage);
      const note = `${id}: ${capCp(attempt.errorMessage, 120)}`;
      if (!tierErrors.includes(note)) tierErrors.push(note);
      log(`[pi-subagent] jev: ${id} failed (${attempt.grade}): ${attempt.errorMessage.slice(0, 200)}`);
      emitStatusChangeIfAny();
    }
    return fail(
      "all-failed",
      tierErrors.length > 0 ? capCp(tierErrors.join(" · "), 300) : "all configured classifiers failed for this call",
    );
  }

  return {
    status: () => currentStatus(),

    async ask(req: JevRequest): Promise<JevOutcome> {
      const sem = req.mode === "background" ? backgroundSem : syncSem;
      const release = await sem.acquire();
      const abortController = req.mode === "background" ? new AbortController() : undefined;
      if (abortController !== undefined) backgroundAborts.add(abortController);
      try {
        const signal =
          abortController === undefined
            ? req.signal
            : req.signal === undefined
              ? abortController.signal
              : combineSignals(req.signal, abortController.signal);
        return await askInner({ ...req, ...(signal === undefined ? {} : { signal }) });
      } catch (err) {
        return fail("all-failed", String((err as Error)?.message ?? err));
      } finally {
        if (abortController !== undefined) backgroundAborts.delete(abortController);
        release();
      }
    },

    async probe(registry: ClassifierRegistryLike, signal?: AbortSignal): Promise<JevStatus> {
      await ensureAvailability(registry, true, signal);
      return currentStatus();
    },

    usage(): JevUsage {
      return { costUsd: usageCostUsd, calls: usageCalls };
    },

    onStatusChange(cb: (prev: JevStatus, next: JevStatus) => void): () => void {
      statusSubscribers.add(cb);
      return () => statusSubscribers.delete(cb);
    },

    abortBackground(): void {
      for (const controller of backgroundAborts) controller.abort();
    },

    markInactive(inactive: boolean): void {
      if (inactiveFlag === inactive) return;
      inactiveFlag = inactive;
      emitStatusChangeIfAny();
    },
  };
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}
