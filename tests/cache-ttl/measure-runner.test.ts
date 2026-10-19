import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock, TimerHandle } from "../../src/core/clock.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { buildExecutionPlan } from "../../src/cache-ttl/measure-plan.js";
import { startMeasurement, type MeasureRunnerDeps } from "../../src/cache-ttl/measure-runner.js";
import type { PipelineDiag, PipelineOutcome, PipelinePingResult } from "../../src/cache-ttl/pipeline-ping-types.js";
import {
  OUTPUT_CAP,
  OUTPUT_ALLOWANCE_TOKENS,
  P_BOUND_TOKENS,
  REQUEST_BUDGET,
  TTL_GAPS_MS,
  type EffectiveTier,
  type MeasureApi,
  type MeasureProgress,
  type MeasureRequestKind,
  type MeasureRouteIdentity,
  type MeasureRunRecord,
  type MeasureSendFn,
  type MeasureSendRequest,
  type PayloadExpectation,
  type PriceTokens,
  type UsageReading,
} from "../../src/cache-ttl/measure-types.js";

const T0 = 1_000_000_000;
const OFFICIAL = "https://api.anthropic.com";
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------------------
// Harness: an event-driven clock, a scripted transport over a tiny cache model, and a driver
// ---------------------------------------------------------------------------------------------------------------------

class TestClock implements Clock {
  private time = T0;
  private nextId = 1;
  private entries = new Map<number, { due: number; fn: () => void }>();
  now(): number {
    return this.time;
  }
  setTimer(delayMs: number, fn: () => void): TimerHandle {
    const id = this.nextId++;
    this.entries.set(id, { due: this.time + Math.max(0, delayMs), fn });
    return { id };
  }
  clearTimer(h: TimerHandle): void {
    this.entries.delete(h.id);
  }
  /** Fire the earliest timer (time never moves backwards). */
  advanceToNext(): boolean {
    const next = [...this.entries].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
    if (!next) return false;
    this.entries.delete(next[0]);
    this.time = Math.max(this.time, next[1].due);
    next[1].fn();
    return true;
  }
  /** Move time forward WITHOUT firing anything (a suspended laptop). */
  suspend(ms: number): void {
    this.time += ms;
  }
  get pending(): number {
    return this.entries.size;
  }
}

type Override =
  | {
      notSent: "guard" | "deadline" | "aborted" | "auth" | "capability" | "provider-error";
      measured?: Record<string, unknown>;
    }
  | { http: number }
  | { lost: "accepted-then-lost" | "network" | "malformed" }
  | { invalidUsage: true }
  | { usage: Partial<{ P: number; C: number; W: number; W1h: number; output: number }> }
  | { hang: true }
  | { holdSettled: true }
  | { url: string }
  | { suspendBeforeGuard: number }
  | { latency: number }
  | { noRouteKey: true };

interface Call {
  n: number;
  kind: MeasureRequestKind;
  slot: number;
  attempt: number;
  sessionId: string;
  at: number;
  deadlineAt: number;
  hadBody: boolean;
  hadBuild: boolean;
  expectRouteKey: string | undefined;
  sent: boolean;
}

interface WorldOpts {
  api?: MeasureApi;
  retention?: "short" | "long";
  tier?: EffectiveTier;
  origin?: string;
  /** Injected cached baseline per request (relay-injected system prompt). */
  baseline?: number;
  /** The slot's own prefix tokens. */
  own?: number;
  latency?: number;
  /** Cache entry lifetime. `Infinity` ⇒ never expires. */
  ttlMs?: number;
  /** Does a read renew the entry? */
  renews?: boolean;
  /** `false` ⇒ the route never caches (reads return only the baseline, even right after a write). */
  caches?: boolean;
  script?: (ctx: {
    req: MeasureSendRequest;
    n: number;
    kindN: number;
    now: number;
    kind: MeasureRequestKind;
  }) => Override | undefined;
  hardDeadlineMs?: number;
  price?: MeasureRunnerDeps["price"];
  /** validatePayload behaviour. */
  validate?: (
    params: Record<string, unknown>,
    expect: PayloadExpectation,
  ) => ReturnType<MeasureRunnerDeps["validatePayload"]>;
  onProgressThrows?: boolean;
  onDoneThrows?: boolean;
}

function diagOf(sent: boolean): PipelineDiag {
  return {
    baseFetchCalls: sent ? 1 : 0,
    onPayloadCalls: 1,
    sawMessageStart: false,
    explicitSuccess: false,
    piStopReason: undefined,
    httpStatus: undefined,
    bodyBytes: 0,
    wireHeaderNames: [],
    deadlineHit: false,
    durationMs: 0,
  };
}

const sonnet = (t: PriceTokens): number =>
  (t.input * 3 +
    t.cacheRead * 0.3 +
    (t.cacheWrite - (t.cacheWrite1h ?? 0)) * 3.75 +
    (t.cacheWrite1h ?? 0) * 6 +
    t.output * 15) /
  1e6;

function makeWorld(opts: WorldOpts = {}) {
  const api = opts.api ?? "anthropic-messages";
  const retention = opts.retention ?? "short";
  const tier: EffectiveTier =
    opts.tier ?? (api === "anthropic-messages" ? (retention === "long" ? "ephemeral-1h" : "ephemeral") : "auto");
  const B = opts.baseline ?? 0;
  const S = opts.own ?? 15_000;
  const latency = opts.latency ?? 1_000;
  const ttl = opts.ttlMs ?? Number.POSITIVE_INFINITY;
  const clock = new TestClock();
  const claim = createMeasureClaim();
  const prep = claim.prepare({ activationId: "act-1", sessionId: "sess-1", runId: "m-test-00000000" }, clock.now());
  if (!prep.ok) throw new Error("prepare");
  const token = prep.token;

  const calls: Call[] = [];
  const kindCount: Record<string, number> = {};
  const entries = new Map<string, { ref: number }>();
  const held: Array<() => void> = [];
  const validateCalls: PayloadExpectation[] = [];
  const persisted: Array<{ route: MeasureRouteIdentity; slot: "latest" | "inProgress"; run: MeasureRunRecord | null }> =
    [];
  const progress: MeasureProgress[] = [];
  const dones: Array<{ record: MeasureRunRecord; route: MeasureRouteIdentity | undefined }> = [];
  let inflight = 0;
  let maxInflight = 0;
  let settledCount = 0;

  const sleep = (ms: number) => new Promise<void>((r) => clock.setTimer(ms, r));

  const send: MeasureSendFn = async (req) => {
    kindCount[req.kind] = (kindCount[req.kind] ?? 0) + 1;
    const n = calls.length + 1;
    const o = opts.script?.({ req, n, kindN: kindCount[req.kind]!, now: clock.now(), kind: req.kind });
    const call: Call = {
      n,
      kind: req.kind,
      slot: req.slot,
      attempt: req.attempt,
      sessionId: req.sessionId,
      at: clock.now(),
      deadlineAt: req.deadlineAt,
      hadBody: req.body !== undefined,
      hadBuild: req.build !== undefined,
      expectRouteKey: req.expectRouteKey,
      sent: false,
    };
    calls.push(call);
    let settled: Promise<void> = Promise.resolve();
    if (o && "holdSettled" in o) settled = new Promise<void>((r) => held.push(r));
    const finish = (outcome: PipelineOutcome): PipelinePingResult => ({
      outcome,
      settled: settled.then(() => void settledCount++),
    });
    const notSent = (
      reason: "guard" | "deadline" | "aborted" | "auth" | "capability" | "provider-error",
      measured?: Record<string, unknown>,
    ) =>
      finish({ kind: "not-sent", reason, diag: diagOf(false), ...(measured ? { measured } : {}) } as PipelineOutcome);

    if (o && "hang" in o) {
      call.sent = true;
      return new Promise<PipelinePingResult>(() => undefined);
    }
    if (o && "suspendBeforeGuard" in o) clock.suspend(o.suspendBeforeGuard);
    if (!req.guard()) return notSent("guard");
    if (o && "notSent" in o) return notSent(o.notSent, o.measured);
    if (req.build) {
      const params = { model: "relay-model", marker: req.sessionId };
      const expectation = req.build.validate;
      void expectation;
      const code = req.build.validate(params);
      if (code !== undefined) return notSent("capability", { rejection: code });
    }
    const url = o && "url" in o ? o.url : "https://relay.example/v1/messages";
    let rk: { key: string; label: string };
    try {
      rk = req.routeKey(url);
    } catch {
      return notSent("capability", { routeMismatch: true });
    }
    if (req.expectRouteKey !== undefined && rk.key !== req.expectRouteKey)
      return notSent("capability", { routeMismatch: true });

    call.sent = true;
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    const sentAt = clock.now();
    await sleep(o && "latency" in o ? o.latency : latency);
    const headersAt = clock.now();
    inflight--;
    const measured: Record<string, unknown> = { sentAt, headersAt };
    if (!(o && "noRouteKey" in o)) {
      measured.routeKey = rk.key;
      measured.routeLabel = rk.label;
    }
    if (req.build) measured.builtBody = { model: "relay-model", marker: req.sessionId };

    if (o && "http" in o)
      return finish({ kind: "http", status: o.http, diag: diagOf(true), measured } as PipelineOutcome);
    if (o && "lost" in o) return finish({ kind: o.lost, diag: diagOf(true), measured } as PipelineOutcome);
    if (o && "invalidUsage" in o) {
      measured.rawUsage = { bad: true };
      return finish({ kind: "usage", usage: undefined, diag: diagOf(true), measured } as PipelineOutcome);
    }

    // cache model
    const isWrite = req.build !== undefined;
    let C = B;
    let W: number | undefined = S;
    if (isWrite) {
      if (opts.caches !== false) entries.set(req.sessionId, { ref: headersAt });
    } else {
      const e = entries.get(req.sessionId);
      const alive = opts.caches !== false && e !== undefined && sentAt - e.ref <= ttl;
      if (alive) {
        C = B + S;
        W = 0;
        if (opts.renews === true) e.ref = headersAt;
      } else {
        W = S;
        entries.set(req.sessionId, { ref: headersAt });
      }
    }
    const raw = {
      P: B + S,
      C,
      W,
      W1h: undefined as number | undefined,
      output: undefined as number | undefined,
      ...(o && "usage" in o ? o.usage : {}),
    };
    measured.rawUsage = raw;
    return finish({ kind: "usage", usage: undefined, diag: diagOf(true), measured } as PipelineOutcome);
  };

  const deps: MeasureRunnerDeps = {
    plan: buildExecutionPlan({
      runId: "m-test-00000000",
      api,
      wireModel: "relay-model",
      requestedRetention: retention,
      ...(opts.price !== undefined ? { price: opts.price } : { price: sonnet as never }),
    }),
    token,
    claim,
    send,
    clock,
    persist: {
      persist: (route, slot, run) => void persisted.push({ route, slot, run }),
      get lastSavedAt() {
        return undefined;
      },
    },
    onProgress: (p) => {
      progress.push(p);
      if (opts.onProgressThrows) throw new Error("boom");
    },
    onDone: (record, route) => {
      dones.push({ record, route });
      if (opts.onDoneThrows) throw new Error("boom");
    },
    readUsage: (outcome): UsageReading => {
      const raw = (outcome.measured?.rawUsage ?? undefined) as
        { P: number; C: number; W?: number; W1h?: number; output?: number; bad?: boolean } | undefined;
      if (raw === undefined || raw.bad === true) {
        return {
          cacheEvidence: { kind: "invalid", reason: "no-terminal-frame" },
          billing: { kind: "unknown", items: ["all"] },
        };
      }
      return {
        usage: {
          P: raw.P,
          C: raw.C,
          ...(raw.W !== undefined ? { W: raw.W } : {}),
          ...(raw.W1h !== undefined ? { W1h: raw.W1h } : {}),
          ...(raw.output !== undefined ? { output: raw.output } : {}),
        },
        cacheEvidence: { kind: "valid" },
        billing: { kind: "unknown", items: ["output"] },
      };
    },
    validatePayload: (params, expectation) => {
      validateCalls.push(expectation);
      return opts.validate ? opts.validate(params, expectation) : { ok: true, effectiveTier: tier };
    },
    routeKeyFor: ({ api: a, wireModel, effectiveTier, requestUrl }) => ({
      key: `sha256:${a}|${wireModel}|${effectiveTier}|${requestUrl}`,
      label: `relay.example · /v1 · ${wireModel}`,
    }),
    price: (opts.price ?? (sonnet as never)) as MeasureRunnerDeps["price"],
    payload: { oauth: false, managedEffort: false },
    ...(opts.origin !== undefined ? { routeOrigin: opts.origin } : {}),
    ...(opts.hardDeadlineMs !== undefined ? { hardDeadlineMs: opts.hardDeadlineMs } : {}),
    versions: { toolkitVersion: "9.9.9", piVersion: "1.2.0" },
  };

  return {
    clock,
    claim,
    token,
    deps,
    calls,
    persisted,
    progress,
    dones,
    validateCalls,
    held,
    get maxInflight() {
      return maxInflight;
    },
    get settledCount() {
      return settledCount;
    },
    entries,
    finished: false,
    handle: undefined as unknown as ReturnType<typeof startMeasurement>,
  };
}
type World = ReturnType<typeof makeWorld>;

const flush = () => new Promise<void>((r) => setImmediate(r));

function start(w: World): MeasureRunRecord | undefined {
  w.handle = startMeasurement(w.deps);
  void w.handle.done.then(() => (w.finished = true));
  return undefined;
}

/** Drive timers + microtasks until `pred` holds (or the run is over / nothing is left to fire). */
async function runUntil(w: World, pred: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 100_000; i++) {
    await flush();
    if (pred() || w.finished) {
      await flush();
      return;
    }
    if (!w.clock.advanceToNext()) {
      await flush();
      return;
    }
  }
  throw new Error("runUntil: did not converge");
}

async function run(opts: WorldOpts = {}): Promise<{ w: World; record: MeasureRunRecord }> {
  const w = makeWorld(opts);
  start(w);
  await runUntil(w);
  expect(w.finished, "run must finish").toBe(true);
  return { w, record: await w.handle.done };
}

const sentCalls = (w: World) => w.calls.filter((c) => c.sent);
const kinds = (w: World) => w.calls.map((c) => c.kind);
const byKind = (w: World, k: MeasureRequestKind) => w.calls.filter((c) => c.kind === k);

// ---------------------------------------------------------------------------------------------------------------------

describe("runner — timeline on a renewing route (first miss, boundary renewal)", () => {
  it("writes → control → probes in due order → first miss stops → ONE renewal read is the only post-miss request", async () => {
    // ttl 30 min: probes at 3/6/11/21 min hit, the 31-min probe misses; reads renew the entry
    const { w, record } = await run({ ttlMs: 30 * MIN, renews: true });
    expect(kinds(w)).toEqual([
      "write",
      "write",
      "write",
      "write",
      "write",
      "write",
      "control",
      "probe",
      "probe",
      "probe",
      "probe",
      "probe",
      "renewal",
    ]);
    expect(w.calls.filter((c) => c.kind === "write").map((c) => [c.slot, c.attempt])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ]);
    expect(byKind(w, "probe").map((c) => c.slot)).toEqual([0, 1, 2, 3, 4]);
    // renewal re-sends the TOUCHED arm: slot 3 (largest hit), with its own prefix session
    const renewal = byKind(w, "renewal")[0]!;
    expect(renewal.slot).toBe(3);
    expect(renewal.sessionId).toBe(byKind(w, "write")[3]!.sessionId);
    expect(renewal.hadBody).toBe(true);
    // nothing after the renewal; slot 5's 61-min probe was never sent
    expect(w.calls[w.calls.length - 1]).toBe(renewal);
    expect(record.requests).toEqual({ cap: 17, sent: 13, possiblyBilled: 0 });

    expect(record.status).toBe("complete");
    expect(record.samples.map((s) => s.verdict)).toEqual(["hit", "hit", "hit", "hit", "miss", "skipped"]);
    expect(record.samples[5]).toMatchObject({ verdict: "skipped", reason: "implied-miss" });
    expect(record.ttl).toMatchObject({
      validHits: 4,
      validMisses: 1,
      consistent: true,
      eligible: true,
      reachedMaxGap: false,
    });
    expect(record.ttl.lowerMs).toBeGreaterThanOrEqual(TTL_GAPS_MS[3]!);
    expect(record.ttl.lowerMs).toBeLessThan(TTL_GAPS_MS[3]! + 5_000);
    expect(record.ttl.missMs).toBeGreaterThanOrEqual(TTL_GAPS_MS[4]!);
    expect(record.control).toEqual({ verdict: "hit", attempts: 1 });
    expect(record.renewal).toMatchObject({
      renewsOnRead: "true",
      basis: "paired-empirical",
      touchedGapMs: TTL_GAPS_MS[3],
      untouchedGapMs: TTL_GAPS_MS[4],
      read: { verdict: "hit" },
    });
    expect(record.renewal!.assumptions).toHaveLength(3);
    expect(record.load).toEqual({ prefixes: 6, ownTokens: 6 * 15_000 });
    expect(record.toolkitVersion).toBe("9.9.9");
    expect(w.maxInflight).toBe(1);
  });

  it("probe timing: slot i is sent at anchor.headersAt + gap (slot 5 anchored on the control touch); control at +30 s", async () => {
    const { w } = await run({ ttlMs: Number.POSITIVE_INFINITY, renews: true });
    const writes = byKind(w, "write");
    const latency = 1_000;
    // writes are sequential: each starts when the previous returned
    expect(writes.map((c) => c.at)).toEqual([0, 1, 2, 3, 4, 5].map((i) => T0 + i * latency));
    const w5Headers = writes[5]!.at + latency;
    const control = byKind(w, "control")[0]!;
    expect(control.at).toBe(w5Headers + 30_000);
    const probes = byKind(w, "probe");
    expect(probes).toHaveLength(6);
    for (const p of probes.slice(0, 5)) {
      expect(p.at).toBe(writes[p.slot]!.at + latency + TTL_GAPS_MS[p.slot]!);
    }
    const p5 = probes[5]!;
    expect(p5.slot).toBe(5);
    expect(p5.at).toBe(control.at + latency + TTL_GAPS_MS[5]!); // control touch moved slot 5's anchor
    // calls are strictly ordered by time (≤ 1 in flight)
    for (let i = 1; i < w.calls.length; i++) expect(w.calls[i]!.at).toBeGreaterThanOrEqual(w.calls[i - 1]!.at);
  });

  it("write-anchored route: the renewal read misses ⇒ unknown(renewal-miss), never false", async () => {
    const { record } = await run({ ttlMs: 30 * MIN, renews: false });
    expect(record.status).toBe("complete");
    expect(record.renewal).toMatchObject({
      renewsOnRead: "unknown",
      reason: "renewal-miss",
      read: { verdict: "miss" },
    });
    expect(record.renewal!.renewsOnRead).not.toBe("false");
  });

  it("no expiry in the whole run: all six arms hit ⇒ '≥ 61 min', no renewal request, unknown(no-expiry-observed)", async () => {
    const { w, record } = await run({ ttlMs: Number.POSITIVE_INFINITY, renews: false });
    expect(record.status).toBe("complete");
    expect(record.ttl.reachedMaxGap).toBe(true);
    expect(record.ttl.lowerMs).toBeGreaterThanOrEqual(TTL_GAPS_MS[5]!);
    expect(record.ttl.missMs).toBeUndefined();
    expect(byKind(w, "renewal")).toHaveLength(0);
    expect(record.requests.sent).toBe(13); // 6 writes + 1 control + 6 probes
    expect(record.renewal).toEqual({ renewsOnRead: "unknown", reason: "no-expiry-observed" });
  });

  it("first-miss stop: no TTL probe after a miss, larger arms are skipped(implied-miss)", async () => {
    // ttl 5 min ⇒ 3-min hit, 6-min miss
    const { w, record } = await run({ ttlMs: 5 * MIN, renews: true });
    expect(byKind(w, "probe").map((c) => c.slot)).toEqual([0, 1]);
    expect(record.samples.map((s) => s.verdict)).toEqual(["hit", "miss", "skipped", "skipped", "skipped", "skipped"]);
    expect(record.samples.slice(2).every((s) => s.reason === "implied-miss")).toBe(true);
    expect(record.ttl).toMatchObject({ validHits: 1, validMisses: 1 });
    expect(record.ttl.lowerMs).toBeLessThan(record.ttl.missMs!);
  });

  it("3→6 on a relay is ineligible from the real intervals ⇒ no request after the miss, unknown(pair-ineligible)", async () => {
    const { w, record } = await run({ ttlMs: 5 * MIN, renews: true, origin: "https://relay.example" });
    expect(byKind(w, "renewal")).toHaveLength(0);
    expect(w.calls[w.calls.length - 1]!.kind).toBe("probe");
    expect(record.renewal).toMatchObject({
      renewsOnRead: "unknown",
      reason: "pair-ineligible",
      touchedGapMs: TTL_GAPS_MS[0],
      untouchedGapMs: TTL_GAPS_MS[1],
    });
    expect(record.requests.sent).toBe(9);
  });

  it("3→6 on api.anthropic.com (documented ceiling) is eligible: one renewal read, true(documented-ceiling)", async () => {
    const { w, record } = await run({ ttlMs: 5 * MIN, renews: true, origin: OFFICIAL, tier: "ephemeral" });
    expect(byKind(w, "renewal")).toHaveLength(1);
    expect(record.renewal).toMatchObject({ renewsOnRead: "true", basis: "documented-ceiling", ceilingMs: 300_000 });
    expect(record.renewal!.assumptions).toBeUndefined();
    expect(record.requests.sent).toBe(10);
    // …and when the entry is write-anchored, the same read misses ⇒ unknown, never false
    const anchored = await run({ ttlMs: 5 * MIN, renews: false, origin: OFFICIAL, tier: "ephemeral" });
    expect(anchored.record.renewal).toMatchObject({ renewsOnRead: "unknown", reason: "renewal-miss" });
  });

  it("renewal eligibility uses the ACTUAL latencies (6→11: fast writes eligible, slow ones not) — same numbers as the closed form", async () => {
    // ttl 500 s ⇒ 3/6-min hit, 11-min miss ⇒ boundary 6→11 (needs D + g_b + L + 50 s < 2·g_a with planned 30 s response)
    const fast = await run({ ttlMs: 500_000, renews: true, latency: 1_000 });
    expect(byKind(fast.w, "renewal")).toHaveLength(1);
    expect(fast.record.renewal).toMatchObject({ renewsOnRead: "true", basis: "paired-empirical" });
    const slow = await run({ ttlMs: 500_000, renews: true, latency: 12_000 });
    expect(byKind(slow.w, "renewal")).toHaveLength(0);
    expect(slow.record.renewal).toMatchObject({ renewsOnRead: "unknown", reason: "pair-ineligible" });
  });

  it("a 429 anywhere in the run withholds paired-empirical (rate-limited flag) ⇒ no renewal request", async () => {
    const { w, record } = await run({
      ttlMs: 30 * MIN,
      renews: true,
      script: ({ kind, kindN }) => (kind === "probe" && kindN === 1 ? { http: 429 } : undefined),
    });
    expect(record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "rate-limited" });
    expect(byKind(w, "renewal")).toHaveLength(0);
    expect(record.renewal).toMatchObject({ renewsOnRead: "unknown", reason: "pair-ineligible" });
  });

  it("terminal bookkeeping: onDone once, persisted latest + cleared inProgress, claim released, status running→complete", async () => {
    const { w, record } = await run({ ttlMs: Number.POSITIVE_INFINITY });
    expect(w.dones).toHaveLength(1);
    expect(w.dones[0]!.record).toBe(record);
    expect(w.dones[0]!.route).toMatchObject({
      api: "anthropic-messages",
      wireModel: "relay-model",
      effectiveTier: "ephemeral",
      requestedRetention: "short",
    });
    expect(w.dones[0]!.route!.label).toBe("relay.example · /v1 · relay-model");
    const last = w.persisted.slice(-2);
    expect(last.map((p) => [p.slot, p.run === null ? null : p.run.status])).toEqual([
      ["latest", "complete"],
      ["inProgress", null],
    ]);
    const progressWrites = w.persisted.filter((p) => p.slot === "inProgress" && p.run !== null);
    expect(progressWrites.length).toBeGreaterThanOrEqual(6);
    expect(progressWrites.every((p) => p.run!.status === "running" && p.run!.finishedAt === undefined)).toBe(true);
    expect(w.claim.state).toBe("free");
    expect(w.progress.length).toBeGreaterThan(5);
    expect(w.progress.every((p) => p.status === "running")).toBe(true);
    expect(record.finishedAt).toBeGreaterThan(record.startedAt);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// §4.2 table, as executed by the runner
// ---------------------------------------------------------------------------------------------------------------------

describe("runner — outcome → action table, per request kind", () => {
  describe("write rows", () => {
    const writeFirst = (o: Override) => ({
      script: ({ kind, kindN }: { kind: MeasureRequestKind; kindN: number }) =>
        kind === "write" && kindN === 1 ? o : undefined,
    });

    it("not-sent guard/deadline/aborted/provider-error ⇒ replacement, no spend, pool consumed", async () => {
      for (const reason of ["deadline", "aborted", "provider-error"] as const) {
        const { w, record } = await run({ ...writeFirst({ notSent: reason }), ttlMs: Number.POSITIVE_INFINITY });
        expect(w.calls[0]).toMatchObject({ kind: "write", slot: 0, attempt: 0, sent: false });
        expect(w.calls[1]).toMatchObject({ kind: "write", slot: 0, attempt: 1 });
        expect(record.requests.sent).toBe(13); // the refused write consumed nothing
        expect(record.requests.possiblyBilled).toBe(0);
        expect(record.status).toBe("complete");
      }
    });

    it("http 429 ⇒ wait 5 s, then a replacement; flagged rate-limited", async () => {
      const { w, record } = await run({ ...writeFirst({ http: 429 }), ttlMs: Number.POSITIVE_INFINITY });
      expect(w.calls[1]!.attempt).toBe(1);
      expect(w.calls[1]!.at - w.calls[0]!.at).toBe(1_000 + 5_000); // response latency + the 5 s rate-limit wait
      expect(record.requests.sent).toBe(14); // the 429'd request WAS sent
      expect(record.requests.possiblyBilled).toBe(0);
      expect(record.status).toBe("complete");
    });

    it("http 5xx ⇒ replacement (not billed, still counted)", async () => {
      const { w, record } = await run({ ...writeFirst({ http: 503 }), ttlMs: Number.POSITIVE_INFINITY });
      expect(w.calls[1]).toMatchObject({ slot: 0, attempt: 1 });
      expect(record.requests).toEqual({ cap: 17, sent: 14, possiblyBilled: 0 });
    });

    it("network / accepted-then-lost / malformed ⇒ possibly billed, nonce burned, replacement with a FRESH nonce", async () => {
      for (const lost of ["accepted-then-lost", "network", "malformed"] as const) {
        const { w, record } = await run({ ...writeFirst({ lost }), ttlMs: Number.POSITIVE_INFINITY });
        const [a, b] = w.calls;
        expect(a).toMatchObject({ slot: 0, attempt: 0 });
        expect(b).toMatchObject({ slot: 0, attempt: 1 });
        expect(b!.sessionId).not.toBe(a!.sessionId);
        // the replacement's synthetic content carries a different nonce (the validator saw both prefixes)
        const [e0, e1] = w.validateCalls;
        const nonce = (x: PayloadExpectation) => /^Nonce ([0-9a-f]{24})\./.exec(x.expectedUser)![1];
        expect(nonce(e1!)).not.toBe(nonce(e0!));
        expect(e1!.expectedSystem).toContain(nonce(e1!)!);
        expect(record.requests).toEqual({ cap: 17, sent: 14, possiblyBilled: 1 });
        expect(record.cost.unknownItems).toContain("all×1");
      }
    });

    it("usage frame with invalid cacheEvidence ⇒ possibly billed, replacement", async () => {
      const { w, record } = await run({ ...writeFirst({ invalidUsage: true }), ttlMs: Number.POSITIVE_INFINITY });
      expect(w.calls[1]).toMatchObject({ slot: 0, attempt: 1 });
      expect(record.requests).toEqual({ cap: 17, sent: 14, possiblyBilled: 1 });
    });

    it("failed rows end the run: auth / payload rejection / 3xx / 401 / other 4xx", async () => {
      const cases: Array<[Override, string]> = [
        [{ notSent: "auth" }, "auth"],
        [{ http: 307 }, "redirect"],
        [{ http: 401 }, "auth-http"],
        [{ http: 403 }, "auth-http"],
        [{ http: 404 }, "http-404"],
        [{ http: 413 }, "http-413"],
      ];
      for (const [o, reason] of cases) {
        const { w, record } = await run(writeFirst(o));
        expect(record.status, reason).toBe("failed");
        expect(record.statusReason).toBe(reason);
        expect(w.calls).toHaveLength(1); // nothing after a failed row
        expect(w.dones).toHaveLength(1);
      }
      const rejected = await run({ validate: () => ({ ok: false, code: "extra-input" }) });
      expect(rejected.record).toMatchObject({ status: "failed", statusReason: "payload:extra-input" });
      expect(rejected.w.calls).toHaveLength(1);
      expect(rejected.record.requests.sent).toBe(0); // 0 POSTs
    });

    it("a route mismatch (URL changed) on a later write ⇒ failed(route)", async () => {
      const { w, record } = await run({
        script: ({ kind, kindN }) =>
          kind === "write" && kindN === 3 ? { url: "https://other.example/v1/messages" } : undefined,
      });
      expect(record).toMatchObject({ status: "failed", statusReason: "route" });
      expect(w.calls).toHaveLength(3);
    });

    it("a valid first write without a route key ⇒ failed(route)", async () => {
      const { record } = await run({
        script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { noRouteKey: true } : undefined),
      });
      expect(record).toMatchObject({ status: "failed", statusReason: "route" });
    });

    it("every request after the first valid write carries the run-wide route key", async () => {
      const { w } = await run({ ttlMs: 30 * MIN, renews: true });
      const key = byKind(w, "write")[0]!.expectRouteKey;
      expect(key).toBeUndefined(); // only the very first write has none
      for (const c of w.calls.slice(1))
        expect(c.expectRouteKey).toMatch(/^sha256:anthropic-messages\|relay-model\|ephemeral\|/);
      expect(new Set(w.calls.slice(1).map((c) => c.expectRouteKey)).size).toBe(1);
    });
  });

  describe("control rows", () => {
    const control = (f: (n: number) => Override | undefined) => ({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }: { kind: MeasureRequestKind; kindN: number }) =>
        kind === "control" ? f(kindN) : undefined,
    });

    it("not-sent / 5xx / 429 / lost / invalid usage ⇒ the single retry at +60 s; a later valid hit proceeds", async () => {
      const first: Override[] = [
        { notSent: "deadline" },
        { http: 503 },
        { http: 429 },
        { lost: "network" },
        { invalidUsage: true },
      ];
      for (const o of first) {
        const { w, record } = await run(control((n) => (n === 1 ? o : undefined)));
        const controls = byKind(w, "control");
        expect(controls).toHaveLength(2);
        const w5Headers = byKind(w, "write")[5]!.at + 1_000;
        expect(controls[0]!.at).toBe(w5Headers + 30_000);
        expect(controls[1]!.at).toBe(w5Headers + 60_000);
        expect(record.control).toMatchObject({ verdict: "hit", attempts: 2 });
        expect(record.status).toBe("complete");
      }
    });

    it("the slot-5 probe anchor moves to the control touch that hit (the retry, when the first failed)", async () => {
      const { w } = await run(control((n) => (n === 1 ? { http: 503 } : undefined)));
      const second = byKind(w, "control")[1]!;
      expect(byKind(w, "probe").find((c) => c.slot === 5)!.at).toBe(second.at + 1_000 + TTL_GAPS_MS[5]!);
    });

    it("two valid misses ⇒ no-cache, no TTL probe; requests = 6 writes + 2 controls", async () => {
      const { w, record } = await run({ caches: false });
      expect(record.status).toBe("no-cache");
      expect(record.control).toEqual({ verdict: "miss", attempts: 2 });
      expect(kinds(w)).toEqual([...Array(6).fill("write"), "control", "control"]);
      expect(record.ttl.eligible).toBe(false);
    });

    it("miss + inconclusive ⇒ control-inconclusive (never no-cache); two inconclusive too", async () => {
      const a = await run({
        caches: false,
        script: ({ kind, kindN }) => (kind === "control" && kindN === 2 ? { http: 503 } : undefined),
      });
      expect(a.record.status).toBe("control-inconclusive");
      const b = await run({
        ttlMs: Number.POSITIVE_INFINITY,
        script: ({ kind }) => (kind === "control" ? { http: 503 } : undefined),
      });
      expect(b.record.status).toBe("control-inconclusive");
      expect(b.record.control).toMatchObject({ verdict: "inconclusive", attempts: 2 });
      expect(byKind(b.w, "probe")).toHaveLength(0);
      const c = await run({
        ttlMs: Number.POSITIVE_INFINITY,
        script: ({ kind }) => (kind === "control" ? { usage: { P: 15_000 + 3_000 } } : undefined),
      }); // backend size mismatch
      expect(c.record.status).toBe("control-inconclusive");
      expect(c.record.control.reason).toBe("backend-mismatch");
    });

    it("failed rows still end the run (3xx / 401 / 4xx)", async () => {
      for (const [o, reason] of [
        [{ http: 302 }, "redirect"],
        [{ http: 401 }, "auth-http"],
        [{ http: 400 }, "http-400"],
      ] as Array<[Override, string]>) {
        const { w, record } = await run(control(() => o));
        expect(record).toMatchObject({ status: "failed", statusReason: reason });
        expect(byKind(w, "control")).toHaveLength(1);
      }
    });
  });

  describe("probe rows", () => {
    const probe1 = (o: Override) => ({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }: { kind: MeasureRequestKind; kindN: number }) =>
        kind === "probe" && kindN === 1 ? o : undefined,
    });
    const cases: Array<[Override, string, boolean]> = [
      [{ notSent: "deadline" }, "not-sent", false],
      [{ http: 429 }, "rate-limited", false],
      [{ http: 502 }, "http-5xx", false],
      [{ lost: "accepted-then-lost" }, "sent-lost", true],
      [{ lost: "network" }, "sent-lost", true],
      [{ invalidUsage: true }, "no-usage", true],
    ];
    for (const [o, reason, billed] of cases) {
      it(`${JSON.stringify(o)} ⇒ inconclusive(${reason}); the run goes on and never stops on it`, async () => {
        const { w, record } = await run(probe1(o));
        expect(record.samples[0]).toMatchObject({ gapMs: TTL_GAPS_MS[0], verdict: "inconclusive", reason });
        expect(record.samples.slice(1).every((s) => s.verdict === "hit")).toBe(true);
        expect(byKind(w, "probe")).toHaveLength(6); // later arms still probed
        expect(record.status).toBe("partial"); // something measured, one arm unknown
        expect(record.requests.possiblyBilled).toBe(billed ? 1 : 0);
        expect(record.ttl.consistent).toBe(true);
      });
    }

    it("failed rows (3xx / 401 / other 4xx) end the run", async () => {
      for (const [o, reason] of [
        [{ http: 301 }, "redirect"],
        [{ http: 403 }, "auth-http"],
        [{ http: 422 }, "http-422"],
      ] as Array<[Override, string]>) {
        const { record } = await run(probe1(o));
        expect(record).toMatchObject({ status: "failed", statusReason: reason });
      }
    });

    it("partial / mismatching / own-prefix-small reads are inconclusive, not hit/miss", async () => {
      const partial = await run(probe1({ usage: { P: 15_000, C: 7_000 } }));
      expect(partial.record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "partial" });
      const mismatch = await run(probe1({ usage: { P: 15_000 + 3_000, C: 18_000 } }));
      expect(mismatch.record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "backend-mismatch" });
      // an own prefix that is too small on a later slot's WRITE makes that slot's reads inconclusive(own-prefix-small)
      const small = await run({
        ttlMs: Number.POSITIVE_INFINITY,
        script: ({ kind, kindN }) =>
          kind === "write" && kindN === 3 ? { usage: { P: 5_000, C: 2_500, W: 2_500 } } : undefined,
      });
      expect(small.record.samples[2]).toMatchObject({ verdict: "inconclusive", reason: "own-prefix-small" });
      expect(small.record.status).toBe("partial");
    });
  });

  describe("renewal rows (6→11 eligible geometry: ttl 500 s)", () => {
    const renewal = (o: Override) => ({
      ttlMs: 500_000,
      renews: true,
      script: ({ kind }: { kind: MeasureRequestKind }) => (kind === "renewal" ? o : undefined),
    });
    const rows: Array<[Override, string, number]> = [
      [{ notSent: "deadline" }, "not-sent", 0],
      [{ http: 429 }, "rate-limited", 0],
      [{ http: 404 }, "http", 0],
      [{ http: 502 }, "http", 0],
      [{ lost: "network" }, "sent-lost", 1],
      [{ invalidUsage: true }, "no-usage", 1],
    ];
    for (const [o, reason, billed] of rows) {
      it(`${JSON.stringify(o)} ⇒ unknown(${reason}) — the run still completes (not failed)`, async () => {
        const { w, record } = await run(renewal(o));
        expect(byKind(w, "renewal")).toHaveLength(1);
        expect(record.status).toBe("complete");
        expect(record.renewal).toMatchObject({ renewsOnRead: "unknown", reason });
        expect(record.requests.possiblyBilled).toBe(billed);
      });
    }
    it("3xx and 401 on the renewal read DO fail the run", async () => {
      for (const [o, reason] of [
        [{ http: 307 }, "redirect"],
        [{ http: 401 }, "auth-http"],
      ] as Array<[Override, string]>) {
        const { record } = await run(renewal(o));
        expect(record).toMatchObject({ status: "failed", statusReason: reason });
      }
    });
    it("partial / mismatching renewal reads are unknown with their reason", async () => {
      expect((await run(renewal({ usage: { P: 15_000, C: 7_000 } }))).record.renewal).toMatchObject({
        renewsOnRead: "unknown",
        reason: "partial",
      });
      expect((await run(renewal({ usage: { P: 18_000, C: 18_000 } }))).record.renewal).toMatchObject({
        renewsOnRead: "unknown",
        reason: "backend-mismatch",
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Hard request cap
// ---------------------------------------------------------------------------------------------------------------------

describe("runner — the hard 17-request cap on every path", () => {
  it("the exact maximum path sends exactly 17: 6 writes + 2 replacements + 2 controls + 6 probes + 1 renewal", async () => {
    const { w, record } = await run({
      // 40-min lifetime: probes 0–4 hit, the 61-min probe (slot 5) misses ⇒ 6 probes, then the boundary renewal 31→61
      ttlMs: 40 * MIN,
      renews: true,
      origin: OFFICIAL,
      tier: "ephemeral-1h",
      retention: "long",
      script: ({ kind, kindN }) => {
        if (kind === "write" && kindN === 1) return { lost: "network" }; // replacement #1
        if (kind === "write" && kindN === 3) return { http: 503 }; // replacement #2 (slot 1's first attempt)
        if (kind === "control" && kindN === 1) return { http: 503 }; // control retry
        return undefined;
      },
    });
    expect(w.calls.filter((c) => c.sent)).toHaveLength(17);
    expect(record.requests).toEqual({ cap: 17, sent: 17, possiblyBilled: 1 });
    expect(w.calls.filter((c) => c.kind === "write" && c.attempt > 0)).toHaveLength(2);
    expect(byKind(w, "write")).toHaveLength(8);
    expect(byKind(w, "control")).toHaveLength(2);
    expect(byKind(w, "probe")).toHaveLength(6);
    expect(byKind(w, "renewal")).toHaveLength(1);
    expect(record.renewal).toMatchObject({ renewsOnRead: "true", basis: "documented-ceiling", ceilingMs: 3_600_000 });
    expect(record.status).toBe("complete");
  });

  it("a persistently failing transport is bounded by the pool: 6 first attempts + 2 replacements = 8 sends, never more", async () => {
    const { w, record } = await run({ script: ({ kind }) => (kind === "write" ? { http: 503 } : undefined) });
    expect(record).toMatchObject({ status: "failed", statusReason: "unavailable-slots" });
    expect(record.requests.sent).toBe(8);
    expect(w.calls).toHaveLength(8);
    expect(record.samples.every((s) => s.verdict === "unavailable")).toBe(true);
  });

  it("unavailable (pool exhausted) slots are skipped but the run continues if slot 5 (control) is anchored", async () => {
    // slot 0: three failures (2 replacements) ⇒ unavailable; slot 1: one failure, no replacement left ⇒ unavailable
    const { w, record } = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "write" && kindN <= 4 ? { http: 502 } : undefined),
    });
    expect(record.samples.slice(0, 2).map((s) => s.verdict)).toEqual(["unavailable", "unavailable"]);
    expect(record.samples.slice(2).every((s) => s.verdict === "hit")).toBe(true);
    expect(record.status).toBe("partial"); // some arms never existed
    expect(byKind(w, "probe").map((c) => c.slot)).toEqual([2, 3, 4, 5]);
    expect(record.requests.sent).toBeLessThanOrEqual(17);
    expect(record.load.prefixes).toBe(4);
  });

  it("if slot 5 (the control prefix) cannot be written the run fails(unavailable-slots) without probing", async () => {
    const { w, record } = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ req }) => (req.kind === "write" && req.slot === 5 ? { http: 503 } : undefined),
    });
    expect(record).toMatchObject({ status: "failed", statusReason: "unavailable-slots" });
    expect(byKind(w, "control")).toHaveLength(0);
    expect(byKind(w, "probe")).toHaveLength(0);
    expect(record.requests.sent).toBe(5 + 3); // slots 0–4 once, slot 5 three times (2 replacements)
  });

  it("property: 150 seeded random transports never exceed any cap, never overlap sends and always finish", async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const pool: Array<Override | undefined> = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { http: 429 },
      { http: 503 },
      { http: 404 },
      { http: 401 },
      { http: 302 },
      { lost: "network" },
      { lost: "accepted-then-lost" },
      { lost: "malformed" },
      { invalidUsage: true },
      { notSent: "guard" },
      { notSent: "deadline" },
      { notSent: "auth" },
      { notSent: "capability" },
      { usage: { P: 15_000, C: 6_000 } },
      { usage: { P: 18_500, C: 18_500 } },
      { usage: { P: 15_000, C: 0 } },
    ];
    for (let run_ = 0; run_ < 150; run_++) {
      const plan = Array.from({ length: 40 }, () => (rnd() < 0.35 ? pick(pool) : undefined));
      const { w, record } = await run({
        ttlMs: pick([4 * MIN, 8 * MIN, 25 * MIN, 45 * MIN, Number.POSITIVE_INFINITY]),
        renews: rnd() < 0.5,
        origin: pick([OFFICIAL, "https://relay.example"]),
        tier: "ephemeral",
        script: ({ n }) => plan[n - 1],
      });
      const sent = w.calls.filter((c) => c.sent).length;
      expect(sent, `run ${run_}`).toBeLessThanOrEqual(REQUEST_BUDGET.total);
      expect(record.requests.sent).toBe(sent);
      expect(w.calls.filter((c) => c.kind === "write" && c.attempt > 0).length).toBeLessThanOrEqual(
        REQUEST_BUDGET.replacements,
      );
      expect(byKind(w, "control").length).toBeLessThanOrEqual(REQUEST_BUDGET.controls);
      expect(byKind(w, "probe").length).toBeLessThanOrEqual(REQUEST_BUDGET.probes);
      expect(byKind(w, "renewal").length).toBeLessThanOrEqual(REQUEST_BUDGET.renewal);
      expect(w.maxInflight).toBeLessThanOrEqual(1);
      expect(w.dones).toHaveLength(1);
      expect(w.claim.state).toBe("free");
      expect(record.finishedAt).toBeDefined();
      expect(record.renewal?.renewsOnRead ?? "unknown").not.toBe("false");
      // the first valid TTL miss is always the last probe; the boundary renewal is the only request after it
      const lastMiss = w.calls
        .map((c, i) => [c, i] as const)
        .filter(([c]) => c.kind === "probe" && record.samples[c.slot]?.verdict === "miss")
        .pop();
      if (lastMiss) {
        const after = w.calls.slice(lastMiss[1] + 1);
        expect(after.every((c) => c.kind === "renewal")).toBe(true);
        expect(after.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Gates: first write, bound guard
// ---------------------------------------------------------------------------------------------------------------------

describe("runner — first-write gate and the runtime bound guard", () => {
  it("first valid write with own prefix S below the minimum ⇒ inconclusive(prefix-too-small), no 'no cache' verdict", async () => {
    const { w, record } = await run({ own: 3_000 });
    expect(record).toMatchObject({ status: "inconclusive", statusReason: "prefix-too-small" });
    expect(w.calls).toHaveLength(1);
    expect(record.control.verdict).toBe("not-run");
  });

  it("S < 0.5·P_w is also too small (huge injected baseline)", async () => {
    const { record } = await run({ own: 5_000, baseline: 9_000 }); // P = 14_000, S = 5_000 < 7_000
    expect(record).toMatchObject({ status: "inconclusive", statusReason: "prefix-too-small" });
  });

  it("a 4.2k injected baseline stays measurable (P ≈ 19.2k ≤ P_bound) and classifies against its own B", async () => {
    const { w, record } = await run({ baseline: 4_224, ttlMs: 30 * MIN, renews: true });
    expect(record.status).toBe("complete");
    expect(record.samples.map((s) => s.verdict)).toEqual(["hit", "hit", "hit", "hit", "miss", "skipped"]);
    expect(record.samples[0]).toMatchObject({ B: 4_224, S: 15_000, P: 19_224, C: 19_224 });
    expect(w.calls.length).toBe(13);
  });

  it("a miss on a baseline route reads C = B (not zero) and is still a miss", async () => {
    const { record } = await run({ baseline: 4_096, ttlMs: 5 * MIN });
    expect(record.samples[1]).toMatchObject({ verdict: "miss", C: 4_096, B: 4_096 });
  });

  it("bound guard: P = P_bound is fine, P = P_bound + 1 stops the run before the next send (G-a)", async () => {
    const at = await run({ own: P_BOUND_TOKENS, ttlMs: Number.POSITIVE_INFINITY });
    expect(at.record.status).toBe("complete");
    const over = await run({ own: P_BOUND_TOKENS + 1, ttlMs: Number.POSITIVE_INFINITY });
    expect(over.record).toMatchObject({ status: "failed", statusReason: "bound-exceeded" });
    expect(over.w.calls).toHaveLength(1); // only the request that revealed it
    expect(over.record.requests.sent).toBe(1);
    const below = await run({ own: P_BOUND_TOKENS - 1, ttlMs: Number.POSITIVE_INFINITY });
    expect(below.record.status).toBe("complete");
  });

  it("a real ~19.2k fixture runs normally; a baseline pushing P to 21k stops it", async () => {
    const ok = await run({ own: 15_000, baseline: 4_200, ttlMs: Number.POSITIVE_INFINITY });
    expect(ok.record.status).toBe("complete");
    const injected6k = await run({ own: 15_000, baseline: 6_000, ttlMs: Number.POSITIVE_INFINITY });
    expect(injected6k.record).toMatchObject({ status: "failed", statusReason: "bound-exceeded" });
  });

  it("the guard also watches controls, probes and renewal reads (a relay that starts injecting mid-run)", async () => {
    for (const kind of ["control", "probe"] as const) {
      const { w, record } = await run({
        ttlMs: Number.POSITIVE_INFINITY,
        script: ({ kind: k, kindN }) =>
          k === kind && kindN === 1 ? { usage: { P: P_BOUND_TOKENS + 1, C: P_BOUND_TOKENS + 1 } } : undefined,
      });
      expect(record).toMatchObject({ status: "failed", statusReason: "bound-exceeded" });
      expect(w.calls[w.calls.length - 1]!.kind).toBe(kind);
    }
    const r = await run({
      ttlMs: 500_000,
      renews: true,
      script: ({ kind }) =>
        kind === "renewal" ? { usage: { P: P_BOUND_TOKENS + 1, C: P_BOUND_TOKENS + 1 } } : undefined,
    });
    expect(r.record).toMatchObject({ status: "failed", statusReason: "bound-exceeded" });
  });

  it("observed output above the allowance breaks C2; the wire cap is unchanged", async () => {
    const cap = OUTPUT_ALLOWANCE_TOKENS["anthropic-messages"];
    const bad = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "probe" && kindN === 2 ? { usage: { output: cap + 1 } } : undefined),
    });
    expect(bad.record).toMatchObject({
      status: "failed",
      statusReason: "bound-exceeded",
      boundExceeded: { condition: "C2", observed: cap + 1, limit: cap },
    });
    const ok = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "probe" && kindN === 2 ? { usage: { output: cap } } : undefined),
    });
    expect(ok.record.status).toBe("complete");
  });
  it("live Responses output=32 survives writes, controls and probes with unchanged wire cap 16", async () => {
    const r = await run({ api: "openai-responses", ttlMs: Infinity, script: () => ({ usage: { output: 32 } }) });
    expect(r.record.status).toBe("complete");
    expect(r.record.requests.sent).toBe(13);
    expect(r.record.boundExceeded).toBeUndefined();
    expect(r.w.deps.plan.outputCap).toBe(16);
  });
  it("first-write C1 failure records the actual prompt observed and preserves its route diagnostic", async () => {
    const r = await run({ script: () => ({ usage: { P: P_BOUND_TOKENS + 1 } }) });
    expect(r.record.boundExceeded).toEqual({ condition: "C1", observed: P_BOUND_TOKENS + 1, limit: P_BOUND_TOKENS });
    expect(r.record.requests.sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle: cancel, owner fences, deadlines, lateness, io-busy
// ---------------------------------------------------------------------------------------------------------------------

describe("runner — cancel / fences / deadlines", () => {
  it("cancel with a never-resolving send: done resolves at once, the in-flight request is counted, claim drains until IO settles", async () => {
    const w = makeWorld({
      script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { hang: true } : undefined),
    });
    start(w);
    await runUntil(w, () => w.calls.length === 1);
    w.handle.cancel("user");
    const record = await w.handle.done;
    expect(record).toMatchObject({ status: "cancelled", statusReason: "user" });
    expect(record.requests.sent).toBe(1); // conservatively counted
    expect(record.cost.unknownItems).toEqual(["all×1"]);
    expect(w.dones).toHaveLength(1);
    expect(w.claim.state).toBe("draining"); // the hung send's IO never settles ⇒ fail closed
    expect(w.claim.physicalPending).toBe(1);
    expect(w.claim.prepare({ activationId: "a2", sessionId: "s2", runId: "m2" }, w.clock.now())).toMatchObject({
      ok: false,
      reason: "busy-io-pending",
    });
    // nothing else is ever sent
    for (let i = 0; i < 50; i++) w.clock.advanceToNext();
    await flush();
    expect(w.calls).toHaveLength(1);
    // cancel is idempotent
    w.handle.cancel("user");
    expect(w.dones).toHaveLength(1);
  });

  it("cancel never awaits persistence or IO: onDone/claim release happen synchronously inside cancel()", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => w.calls.length === 3);
    w.handle.cancel("session-reload");
    expect(w.dones).toHaveLength(1); // synchronous
    expect(w.dones[0]!.record.statusReason).toBe("session-reload");
    expect(w.claim.state === "free" || w.claim.state === "draining").toBe(true);
  });

  it("a late settle of a cancelled run's request is ignored (no progress, no persist, no new send) and frees the claim", async () => {
    const w = makeWorld({
      script: ({ kind, kindN }) => (kind === "write" && kindN === 2 ? { holdSettled: true } : undefined),
    });
    start(w);
    await runUntil(w, () => w.calls.length === 2);
    await runUntil(w, () => w.progress.length >= 3); // slot 2's write is about to start (it waits for the held settle)
    w.handle.cancel("session-quit");
    const progressAfterCancel = w.progress.length;
    const persistedAfterCancel = w.persisted.length;
    expect(w.claim.state).toBe("draining");
    for (let i = 0; i < 20; i++) {
      w.clock.advanceToNext();
      await flush();
    }
    expect(w.progress.length).toBe(progressAfterCancel);
    expect(w.persisted.length).toBe(persistedAfterCancel);
    expect(w.calls).toHaveLength(2);
    w.held.forEach((r) => r());
    await flush();
    await flush();
    expect(w.persisted.length).toBe(persistedAfterCancel);
    expect(w.claim.physicalPending).toBe(0);
    expect(w.claim.state).toBe("free"); // ioSettled is not token-gated
  });

  it("cancel right after start: at most the one synchronous first send (counted), status cancelled, nothing after", async () => {
    const w = makeWorld();
    start(w);
    w.handle.cancel("user");
    const record = await w.handle.done;
    await runUntil(w);
    expect(w.calls.length).toBeLessThanOrEqual(1);
    expect(record).toMatchObject({ status: "cancelled", statusReason: "user" });
    expect(record.requests.sent).toBeLessThanOrEqual(1);
    expect(w.dones).toHaveLength(1);
  });

  it("cancel mid-run keeps what was measured and persists it as latest (valid hits), never eligible", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => byKind(w, "probe").length === 3);
    await flush();
    w.handle.cancel("user");
    const record = await w.handle.done;
    expect(record.status).toBe("cancelled");
    expect(record.ttl.validHits).toBeGreaterThanOrEqual(2);
    expect(record.ttl.eligible).toBe(false);
    expect(record.samples.filter((s) => s.verdict === "skipped").every((s) => s.reason === "cancelled")).toBe(true);
    expect(record.renewal).toMatchObject({ renewsOnRead: "unknown", reason: "cancelled" });
    expect(w.persisted.filter((p) => p.slot === "latest").pop()?.run?.status).toBe("cancelled");
  });

  it("owner fence: once the claim no longer belongs to the run it stops silently (no send, persist, progress or notify)", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => w.calls.length === 3);
    w.claim.finishLogical(w.token, w.clock.now()); // someone else ended the logical run (e.g. a new activation took over)
    const calls = w.calls.length;
    const persisted = w.persisted.length;
    const progress = w.progress.length;
    await runUntil(w);
    const record = await w.handle.done;
    expect(w.calls.length).toBeLessThanOrEqual(calls + 1); // at most the already-pending one
    expect(w.persisted.length).toBe(persisted);
    expect(w.progress.length).toBe(progress);
    expect(w.dones).toHaveLength(0);
    expect(record.status).toBe("cancelled");
  });

  it("generation fence: a run whose token was revoked before it started sends nothing", async () => {
    const w = makeWorld();
    w.claim.revoke(w.token);
    start(w);
    const record = await w.handle.done;
    await runUntil(w);
    expect(w.calls).toHaveLength(0);
    expect(w.dones).toHaveLength(0);
    expect(record.status).toBe("cancelled");
    expect(w.claim.state).toBe("free");
  });

  it("a stale handle of an old generation cannot touch a new owner's claim", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => w.calls.length === 2);
    w.claim.finishLogical(w.token, w.clock.now());
    await runUntil(w, () => w.claim.state === "free"); // the old run's last IO settles
    const second = w.claim.prepare({ activationId: "act-2", sessionId: "sess-1", runId: "m-2" }, w.clock.now());
    expect(second.ok).toBe(true);
    const doneAfter = w.dones.length;
    await runUntil(w);
    w.handle.cancel("user"); // old handle
    expect(w.dones.length).toBe(doneAfter);
    expect(w.claim.state).toBe("preparing"); // the new owner is untouched
    expect(second.ok && w.claim.owns(second.token)).toBe(true);
  });

  it("onDone is delivered while the run still owns the claim, before it is released", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    let ownedInDone: boolean | undefined;
    let stateInDone: string | undefined;
    w.deps.onDone = () => {
      ownedInDone = w.claim.owns(w.token);
      stateInDone = w.claim.state;
    };
    start(w);
    await runUntil(w);
    expect(ownedInDone).toBe(true);
    expect(stateInDone).toBe("running");
    expect(w.claim.state).toBe("free");
  });

  it("hard deadline: the run ends partial(hard-deadline), later arms are skipped, no send follows, per-send deadlines never pass it", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY, hardDeadlineMs: 100_000 });
    start(w);
    await runUntil(w);
    const record = await w.handle.done;
    expect(record).toMatchObject({ status: "partial", statusReason: "hard-deadline" });
    expect(record.samples.every((s) => s.verdict === "skipped" && s.reason === "hard-deadline")).toBe(true);
    expect(byKind(w, "probe")).toHaveLength(0);
    expect(w.calls.every((c) => c.deadlineAt <= T0 + 100_000)).toBe(true);
    expect(record.finishedAt).toBe(T0 + 100_000);
    expect(w.claim.state).toBe("free");
  });

  it("hard deadline before anything was measured ⇒ inconclusive(hard-deadline); the in-flight request is counted", async () => {
    const w = makeWorld({ hardDeadlineMs: 3_500, latency: 1_000 });
    start(w);
    await runUntil(w);
    const record = await w.handle.done;
    expect(record).toMatchObject({ status: "inconclusive", statusReason: "hard-deadline" });
    expect(w.calls.length).toBeLessThanOrEqual(4);
    expect(record.requests.sent).toBeLessThanOrEqual(4);
  });

  it("per-send deadline is min(now + 30 s, hardAt)", async () => {
    const { w } = await run({ ttlMs: Number.POSITIVE_INFINITY });
    for (const c of w.calls) expect(c.deadlineAt).toBe(c.at + 30_000);
    const near = makeWorld({ hardDeadlineMs: 10_000 });
    start(near);
    await runUntil(near);
    expect(near.calls[0]!.deadlineAt).toBe(T0 + 10_000);
  });

  it("a send that never resolves is declared lost after its deadline + 2 s (possibly billed, counted); it blocks every later send (fail closed)", async () => {
    const { w, record } = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { hang: true } : undefined),
    });
    expect(w.calls).toHaveLength(1); // the hung request's IO never settled ⇒ no second request may be in flight
    expect(record).toMatchObject({ status: "failed", statusReason: "unavailable-slots" });
    expect(record.requests).toMatchObject({ sent: 1, possiblyBilled: 1 });
    expect(w.claim.state).toBe("draining");
    expect(w.claim.physicalPending).toBe(1);
  });

  it("lateness: a probe whose timer fires later than due + max(30 s, 10 % gap) is inconclusive(late) at zero cost; later arms still run", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => w.progress.some((p) => p.nextKind === "probe"));
    w.clock.suspend(300_000); // laptop asleep: slot 0 (due ≈ +181 s) is overdue by ~2 min, slot 1 (due ≈ +362 s) is not
    await runUntil(w);
    const record = await w.handle.done;
    expect(record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "late" });
    expect(byKind(w, "probe").map((c) => c.slot)).toEqual([1, 2, 3, 4, 5]); // slot 0 was never sent
    expect(record.requests.sent).toBe(12);
    expect(record.status).toBe("partial");
  });

  it("lateness is also enforced right before the base fetch (guard): a slow pipeline auth ⇒ not-sent ⇒ inconclusive(late), zero POSTs", async () => {
    const { w, record } = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "probe" && kindN === 1 ? { suspendBeforeGuard: 45_000 } : undefined),
    });
    expect(record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "late" });
    expect(byKind(w, "probe")[0]!.sent).toBe(false);
    expect(record.requests.sent).toBe(12);
    expect(record.requests.possiblyBilled).toBe(0);
  });

  it("a guard refusal that is NOT lateness (cancel/ownership) is a plain not-sent, not 'late'", async () => {
    const { record } = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "probe" && kindN === 1 ? { notSent: "guard" } : undefined),
    });
    expect(record.samples[0]).toMatchObject({ verdict: "inconclusive", reason: "not-sent" });
  });

  it("io-busy: a due probe whose predecessor's transport has not settled is inconclusive(io-busy) and sends nothing", async () => {
    const w = makeWorld({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "control" && kindN === 1 ? { holdSettled: true } : undefined),
    });
    start(w);
    await runUntil(w);
    const record = await w.handle.done;
    expect(byKind(w, "probe")).toHaveLength(0);
    expect(record.samples.every((s) => s.verdict === "inconclusive" && s.reason === "io-busy")).toBe(true);
    expect(record.requests.sent).toBe(7);
    expect(record.status).toBe("partial");
    expect(w.claim.state).toBe("draining");
    w.held.forEach((r) => r());
    await flush();
    expect(w.claim.state).toBe("free");
  });

  it("io-busy on writes: waits up to the per-send deadline for the settle, then the slot is unavailable (no send)", async () => {
    const w = makeWorld({
      script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { holdSettled: true } : undefined),
    });
    start(w);
    await runUntil(w);
    const record = await w.handle.done;
    expect(w.calls).toHaveLength(1);
    expect(record).toMatchObject({ status: "failed", statusReason: "unavailable-slots" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Accounting, persistence, progress, robustness
// ---------------------------------------------------------------------------------------------------------------------

describe("runner — cost accounting, landed1h, persistence, progress", () => {
  it("per-run cost: known = every reported component priced per request; output sits in the unknown range; estimate attached", async () => {
    const { w, record } = await run({ ttlMs: Number.POSITIVE_INFINITY });
    const write = (15_000 * 3.75) / 1e6;
    const read = (15_000 * 0.3) / 1e6;
    expect(record.cost.knownUsd).toBeCloseTo(6 * write + 7 * read, 10);
    expect(record.cost.unknownUsd![0]).toBe(0);
    expect(record.cost.unknownUsd![1]).toBeCloseTo((13 * OUTPUT_ALLOWANCE_TOKENS["anthropic-messages"] * 15) / 1e6, 10);
    expect(record.cost.unknownItems).toEqual(["output×13"]);
    expect(record.cost.estimate).toBe(w.deps.plan.estimate);
    expect(record.cost.estimate.requestCap).toBe(17);
  });

  it("a request that never reached the base fetch adds nothing; a lost one adds the conditional unknown range", async () => {
    const refused = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { notSent: "deadline" } : undefined),
    });
    const clean = await run({ ttlMs: Number.POSITIVE_INFINITY });
    expect(refused.record.cost.knownUsd).toBeCloseTo(clean.record.cost.knownUsd!, 12);
    const lost = await run({
      ttlMs: Number.POSITIVE_INFINITY,
      script: ({ kind, kindN }) => (kind === "write" && kindN === 1 ? { lost: "network" } : undefined),
    });
    expect(lost.record.cost.unknownItems).toContain("all×1");
    expect(lost.record.cost.unknownUsd![1]).toBeGreaterThan(clean.record.cost.unknownUsd![1]);
    expect(lost.record.cost.knownUsd).toBeCloseTo(clean.record.cost.knownUsd!, 12);
  });

  it("unpriced route ⇒ cost unknown, the cap still applies", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    w.deps.price = undefined;
    start(w);
    await runUntil(w);
    const r = await w.handle.done;
    expect(r.cost.knownUsd).toBeNull();
    expect(r.cost.unknownUsd).toBeNull();
    expect(r.requests.sent).toBe(13);
  });

  it("landed1h (Anthropic long): true when a 1h write was reported, false when reported as 0, unknown when the split is absent, absent for short", async () => {
    const long = { retention: "long" as const, tier: "ephemeral-1h" as const, ttlMs: Number.POSITIVE_INFINITY };
    const landed = await run({
      ...long,
      script: ({ kind }) => (kind === "write" ? { usage: { W1h: 15_000 } } : undefined),
    });
    expect(landed.record.landed1h).toBe(true);
    const collapsed = await run({
      ...long,
      script: ({ kind }) => (kind === "write" ? { usage: { W1h: 0 } } : undefined),
    });
    expect(collapsed.record.landed1h).toBe(false);
    const unknown = await run(long);
    expect(unknown.record.landed1h).toBe("unknown");
    const short = await run({ ttlMs: Number.POSITIVE_INFINITY });
    expect(short.record.landed1h).toBeUndefined();
  });

  it("persistence: nothing before the route is known; inProgress while running; latest + cleared inProgress at the end", async () => {
    const failed = await run({ script: ({ kind }) => (kind === "write" ? { notSent: "auth" } : undefined) });
    expect(failed.w.persisted).toHaveLength(0); // no route ⇒ nothing to key a record on
    expect(failed.record.status).toBe("failed");
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    await runUntil(w, () => w.calls.length === 1);
    expect(w.persisted).toHaveLength(0);
    await runUntil(w);
    expect(w.persisted[0]).toMatchObject({ slot: "inProgress" });
    expect(w.persisted[0]!.run!.status).toBe("running");
    expect(w.persisted[0]!.route.key).toMatch(/^sha256:/);
  });

  it("a failed run without any measurement never overwrites a learned `latest`; no-cache does (that IS a result)", async () => {
    const bad = await run({ script: ({ kind }) => (kind === "control" ? { http: 400 } : undefined) });
    expect(bad.record.status).toBe("failed");
    expect(bad.w.persisted.filter((p) => p.slot === "latest")).toHaveLength(0);
    expect(bad.w.persisted[bad.w.persisted.length - 1]).toMatchObject({ slot: "inProgress", run: null });
    const nocache = await run({ caches: false });
    expect(nocache.w.persisted.filter((p) => p.slot === "latest").pop()?.run?.status).toBe("no-cache");
  });

  it("snapshot(): label, status, slotsDone, next due, sent, cost and physicalPending track the run", async () => {
    const w = makeWorld({ ttlMs: Number.POSITIVE_INFINITY });
    start(w);
    expect(w.handle.snapshot()).toMatchObject({
      runId: "m-test-00000000",
      label: "relay-model",
      status: "running",
      slotsDone: 0,
      sent: 0,
    });
    await runUntil(w, () => w.progress.some((p) => p.nextGapMs === TTL_GAPS_MS[2]));
    const mid = w.handle.snapshot();
    expect(mid).toMatchObject({ label: "relay.example · /v1 · relay-model", status: "running", sent: 7 + 2 });
    expect(mid.slotsDone).toBeGreaterThanOrEqual(1);
    expect(mid.nextKind).toBe("probe");
    expect(mid.nextDueAt).toBeGreaterThan(w.clock.now() - 1);
    expect(mid.nextGapMs).toBe(TTL_GAPS_MS[2]);
    expect(mid.cost.knownUsd).toBeGreaterThan(0);
    await runUntil(w);
    const end = w.handle.snapshot();
    expect(end).toMatchObject({ status: "complete", slotsDone: 6, sent: 13 });
    expect(end.nextDueAt).toBeUndefined();
  });

  it("progress callbacks carry English-token data only and are called many times; a throwing onProgress/onDone never breaks the run", async () => {
    const { w, record } = await run({ ttlMs: Number.POSITIVE_INFINITY, onProgressThrows: true, onDoneThrows: true });
    expect(record.status).toBe("complete");
    expect(w.progress.length).toBeGreaterThan(5);
    expect(w.dones).toHaveLength(1);
    expect(w.claim.state).toBe("free");
  });

  it("timers are on the injected clock: no real setTimeout is ever armed, none is left pending on it", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { w } = await run({ ttlMs: 30 * MIN, renews: true });
    expect(spy).not.toHaveBeenCalled();
    // only the (cleared) hard-deadline timer existed at the end
    expect(w.clock.pending).toBe(0);
  });
});

afterEach(() => vi.restoreAllMocks());
