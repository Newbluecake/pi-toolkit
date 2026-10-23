import type { GateSlot } from "./serialize.js";
import type { Attempt, PendingRequest } from "./state.js";
import type { TrafficEngine } from "./engine.js";

const MAX_PENDING = 32;
const MAX_ATTEMPTS = 64;
const TTL_MS = 5 * 60 * 1000;
const HOOK_HEADERS_TTL_MS = 5 * 1000;
const RESPONSE_KEYS = ["request-id", "x-request-id", "x-amzn-requestid", "cf-ray", "x-ms-request-id"] as const;

function debugCorrelationEnabled(): boolean {
  return process.env.PI_RECORD_DEBUG_CORRELATE === "1";
}

/**
 * 中段 128 字符指纹（一次 slice，成本可忽略，生产路径无条件计算）。
 * 用途：① 零规则降级档的 bodyText 消歧 tie-break（V6）；② PI_RECORD_DEBUG_CORRELATE=1 时的认领断言。
 * 断言失败绝不改变行为（见 assertDebugProbe）。
 */
export function makeProbe(payloadText: string): string | null {
  if (payloadText.length < 24) return null;
  const mid = Math.floor(payloadText.length / 2);
  return payloadText.slice(Math.max(0, mid - 64), mid + 64);
}

export function urlMatchesBase(url: URL | string, baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const b = new URL(baseUrl);
    const u = typeof url === "string" ? new URL(url) : url;
    if (b.origin !== u.origin) return false;
    const basePath = b.pathname.replace(/\/+$/, "");
    return basePath === "" || u.pathname === basePath || u.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

export function respKeyOf(headers: Record<string, string> | Headers): string | null {
  for (const key of RESPONSE_KEYS) {
    const value =
      headers instanceof Headers
        ? headers.get(key)
        : (headers[key] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === key) ?? ""]);
    if (value) return value;
  }
  return null;
}

function urlCandidate(attempt: Attempt, entry: PendingRequest): boolean {
  return urlMatchesBase(attempt.url, entry.baseUrl);
}

function debugProbeOf(entry: PendingRequest): string | null {
  return entry.debugProbe ?? entry.probe;
}

function bodyTieBreak(entries: PendingRequest[], bodyText: string | null): PendingRequest | null {
  if (bodyText === null) return null;
  const matches = entries.filter((entry) => {
    const probe = debugProbeOf(entry);
    return probe !== null && bodyText.includes(probe);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function chooseClosedCandidate(candidates: PendingRequest[], bodyText: string | null): PendingRequest | null {
  const waiting = candidates.filter((entry) => entry.status === "waiting").sort((a, b) => a.createdAt - b.createdAt);
  if (waiting.length > 0) return bodyTieBreak(waiting, bodyText) ?? waiting[0]!;

  const sent = candidates.filter((entry) => entry.status === "sent").sort((a, b) => a.createdAt - b.createdAt);
  return bodyTieBreak(sent, bodyText) ?? sent[0] ?? null;
}

/** 关联层 API（T2b 以票据配对取代；T2a 只把模块级状态收进 engine）。 */
export interface Correlator {
  stashHookHeaders(json: string): void;
  takeHookHeaders(): string | null;
  reap(now?: number): void;
  pushPending(entry: PendingRequest): void;
  beginAttempt(url: string, method: string): Attempt | null;
  claimPending(attempt: Attempt, bodyText: string | null): PendingRequest | null;
  settleAttempt(attempt: Attempt, res: Response): void;
  failAttempt(attempt: Attempt, err: unknown): void;
  blockAttempt(attempt: Attempt): void;
  matchAfter(status: number, headers: Record<string, string>): Attempt | null;
  matchAfter(attempts: Attempt[], status: number, headers: Record<string, string>): Attempt | null;
  resetCorrelation(): void;
}

export function createCorrelator(state: TrafficEngine, gate: { currentSlot(): GateSlot | null }): Correlator {
  let stashedHookHeaders: { json: string; createdAt: number } | null = null;

  function removePending(entry: PendingRequest): void {
    const index = state.pendingRequests.indexOf(entry);
    if (index >= 0) state.pendingRequests.splice(index, 1);
  }

  function clearExpiredHookHeaders(now: number): void {
    if (stashedHookHeaders && now - stashedHookHeaders.createdAt >= HOOK_HEADERS_TTL_MS) {
      stashedHookHeaders = null;
    }
  }

  function stashHookHeaders(json: string): void {
    stashedHookHeaders = { json, createdAt: Date.now() };
  }

  function takeHookHeaders(): string | null {
    const cached = stashedHookHeaders;
    stashedHookHeaders = null;
    if (!cached || Date.now() - cached.createdAt >= HOOK_HEADERS_TTL_MS) return null;
    return cached.json;
  }

  function reap(now = Date.now()): void {
    clearExpiredHookHeaders(now);
    for (let i = state.pendingRequests.length - 1; i >= 0; i--) {
      const entry = state.pendingRequests[i];
      if (entry && now - entry.createdAt >= TTL_MS) state.pendingRequests.splice(i, 1);
    }
    for (let i = state.attempts.length - 1; i >= 0; i--) {
      const attempt = state.attempts[i];
      if (!attempt) continue;
      const age = now - Math.max(attempt.startedAt, attempt.settledAt ?? attempt.startedAt);
      if (age >= TTL_MS) state.attempts.splice(i, 1);
    }
    while (state.pendingRequests.length > MAX_PENDING) state.pendingRequests.shift();
    while (state.attempts.length > MAX_ATTEMPTS) state.attempts.shift();
  }

  function pushPending(entry: PendingRequest): void {
    reap(entry.createdAt);
    state.pendingRequests.push(entry);
    reap(entry.createdAt);
  }

  function beginAttempt(url: string, method: string): Attempt | null {
    const parsed = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    if (!parsed) return null;
    reap();
    const holder = gate.currentSlot();
    const pendingSlot = state.pendingRequests.find((entry) => urlMatchesBase(parsed, entry.baseUrl))?.slot ?? null;
    const provider =
      state.pendingRequests.some((entry) => urlMatchesBase(parsed, entry.baseUrl)) ||
      (holder !== null && urlMatchesBase(parsed, holder.baseUrl));
    if (!provider) return null;
    const attempt: Attempt = {
      seq: ++state.attemptSeq,
      url,
      method: method.toUpperCase(),
      origin: parsed.origin,
      path: parsed.pathname,
      slot: holder ?? pendingSlot,
      pending: null,
      rowId: null,
      startedAt: Date.now(),
      outcome: "pending",
      status: null,
      respKey: null,
      afterConsumed: false,
      rewriteRuleIds: [],
    };
    state.attempts.push(attempt);
    reap(attempt.startedAt);
    return attempt;
  }

  function claim(attempt: Attempt, entry: PendingRequest, slot: GateSlot | null = null): PendingRequest {
    entry.status = "sent";
    entry.claimedBy.push(attempt.seq);
    if (slot !== null) entry.slot = slot;
    attempt.pending = entry;
    attempt.rowId = entry.rowId;
    return entry;
  }

  function assertDebugProbe(attempt: Attempt, entry: PendingRequest, bodyText: string | null): void {
    if (!debugCorrelationEnabled() || bodyText === null) return;
    const probe = debugProbeOf(entry);
    if (probe === null || bodyText.includes(probe)) return;
    state.correlationAssertFailures++;
    console.warn(`[traffic-record] correlation probe assertion failed for attempt ${attempt.seq}`);
  }

  function markUnlinked(attempt: Attempt, degraded: boolean): null {
    if (degraded) attempt.degraded = true;
    state.unlinkedRewrites++;
    return null;
  }

  function claimPending(attempt: Attempt, bodyText: string | null): PendingRequest | null {
    if (attempt.pending) return attempt.pending;
    reap();
    const slot = gate.currentSlot();

    if (attempt.slot !== null && attempt.slot !== undefined && attempt.slot === slot) {
      if (!urlMatchesBase(attempt.url, slot.baseUrl) || slot.pending === null) return markUnlinked(attempt, true);
      const entry = claim(attempt, slot.pending, slot);
      assertDebugProbe(attempt, entry, bodyText);
      return entry;
    }

    const orphan = slot !== null;
    if (orphan) attempt.degraded = true;
    const candidates = state.pendingRequests.filter(
      (entry) => (entry.status === "waiting" || entry.status === "sent") && urlCandidate(attempt, entry),
    );
    const entry = chooseClosedCandidate(candidates, bodyText);
    if (entry === null) return markUnlinked(attempt, orphan);
    const claimed = claim(attempt, entry);
    assertDebugProbe(attempt, claimed, bodyText);
    return claimed;
  }

  function settleAttempt(attempt: Attempt, res: Response): void {
    attempt.outcome = "response";
    attempt.status = res.status;
    attempt.respKey = respKeyOf(res.headers);
    attempt.settledAt = Date.now();
  }

  function failAttempt(attempt: Attempt, _err: unknown): void {
    attempt.outcome = "failed";
    attempt.settledAt = Date.now();
  }

  function blockAttempt(attempt: Attempt): void {
    attempt.outcome = "blocked";
    attempt.afterConsumed = true;
    attempt.settledAt = Date.now();
    if (attempt.pending) {
      attempt.pending.status = "blocked";
      removePending(attempt.pending);
    }
  }

  function matchAfter(status: number, headers: Record<string, string>): Attempt | null;
  function matchAfter(attempts: Attempt[], status: number, headers: Record<string, string>): Attempt | null;
  function matchAfter(
    statusOrAttempts: number | Attempt[],
    maybeStatus: number | Record<string, string>,
    maybeHeaders?: Record<string, string>,
  ): Attempt | null {
    const customAttempts = Array.isArray(statusOrAttempts);
    const attempts = customAttempts ? statusOrAttempts : state.attempts;
    const status = customAttempts ? (maybeStatus as number) : statusOrAttempts;
    const headers = (customAttempts ? maybeHeaders : (maybeStatus as Record<string, string>)) ?? {};
    const available = attempts.filter((attempt) => attempt.outcome === "response" && !attempt.afterConsumed);
    const slot = gate.currentSlot();
    const gated = slot === null ? [] : available.filter((attempt) => attempt.slot === slot);
    let match = gated.length === 1 ? gated[0]! : undefined;
    const responseKey = respKeyOf(headers);
    if (!match && responseKey !== null) {
      match = available.find((attempt) => attempt.respKey !== null && attempt.respKey === responseKey);
    }
    if (!match) {
      const sameStatus = available
        .filter((attempt) => attempt.status === status && attempt.settledAt !== undefined)
        .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
      match = sameStatus[0];
    }
    if (!match) return null;
    match.afterConsumed = true;
    if (match.pending && status < 400) {
      match.pending.status = "resolved";
      removePending(match.pending);
    }
    return match;
  }

  function resetCorrelation(): void {
    state.pendingRequests = [];
    state.attempts = [];
    state.attemptSeq = 0;
    state.unlinkedRewrites = 0;
    state.correlationAssertFailures = 0;
    stashedHookHeaders = null;
  }

  return {
    stashHookHeaders,
    takeHookHeaders,
    reap,
    pushPending,
    beginAttempt,
    claimPending,
    settleAttempt,
    failAttempt,
    blockAttempt,
    matchAfter,
    resetCorrelation,
  };
}
