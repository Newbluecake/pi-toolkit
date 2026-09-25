/**
 * Goal-level (economic) verification of `cacheTtl.mode = "adaptive"`.
 *
 * The other adaptive suites pin individual rules (truth table, probes, budgets,
 * incident regressions). This one asks the question the feature exists for —
 * "over a whole session, does adaptive spend less than `auto`, and when it
 * cannot, is the loss bounded and self-limiting?" — by driving the REAL pure
 * reducers (`decideAdaptiveTtl` → `noteDecision` → `onLedgerObserved` /
 * `invalidateAdaptive` / `endArmedEpisode`, same call order as
 * src/service/cache-adaptive.ts) against a simulated upstream cache.
 *
 * Upstream model (field facts, plan.md §16.3 / §17.2):
 *   - 5m and 1h are separate namespaces. A `ttl:"1h"` request reads ONLY 1h
 *     entries; a 5m request reads either. A hit refreshes the entry it read.
 *   - `oneHourLifeMs` is configurable: 60 min (documented), 10 min (measured on
 *     cloudrouter-anthropic: 7.0 min hit / 13.6 min miss), or "ignored" (a
 *     proxy that drops ttl — the 1h request silently behaves as 5m,
 *     cacheWrite1h = 0).
 *   - A cross-session shared system/tools block (SHARED) is always readable,
 *     which is why "cacheRead > 0" must never count as a hit (D3).
 * Pricing (× base R): read 0.1, 5m write 1.25, 1h write 2.0; R = $5/M.
 *
 * Keepalive (optional, `keepalive: true`): while background work is live
 * during a gap (`Step.pingArmed`), a ping every 4 min (≤ 11 per window) replays
 * the previous request's payload — same prefix, same ttl — and gate #7 skips a
 * window whose captured payload was 1h. A ping that writes nothing is a proven
 * read and feeds `lastProvenCacheReadAt` (D1), like CacheKeepaliveService does.
 * F1 arbitration is modeled like the stack wires it: in adaptive mode the
 * pinger stands down while `adaptiveCoversPrefix` holds, and the predictor gets
 * `keepaliveHorizonMs` so it does not open a 1h prefix for gaps pings bridge.
 * The §6.3 "upgrade after ping budget" of auto mode is not modeled.
 *
 * Set ADAPTIVE_ECON_REPORT=1 to print the per-scenario cost table.
 */
import { describe, expect, it } from "vitest";
import {
  adaptiveCoversPrefix,
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  endArmedEpisode,
  invalidateAdaptive,
  noteDecision,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveSignals,
  type AdaptiveState,
} from "../../src/cache-ttl/adaptive.js";
import { keepaliveGapHorizonMs } from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";

const MIN = 60_000;
const R = 5e-6; // $ per base input token
const SHARED = 11_356; // cross-session shared system/tools block (measured)
const MODEL = "claude-sim";

const CONFIG: AdaptiveConfig = {
  writeBudgetTokens: 200_000,
  writeBudgetUsd: 1,
  feeBudgetTokens: 600_000,
  feeBudgetUsd: 3,
  maxDeltaTokens: 32_000,
  refreshAfterTokens: 16_000,
  coldUpgrades: 1,
  coldCooldownMs: 1_200_000,
  coldMinHorizonMs: 600_000,
  historyGapSignal: true,
  probeWriteFactor: 3,
  probeWriteFloorTokens: 64_000,
  probeWriteFloorFraction: 0.5,
  probeWriteFloorMinTokens: 4_000,
};

// ─── upstream cache simulator ──────────────────────────────────────────────

type OneHourLife = number | "ignored";
interface CacheEntry {
  lineage: number;
  prefix: number;
  ns: "5m" | "1h";
  lifeMs: number;
  expiresAt: number;
}
interface Usage {
  read: number;
  write: number;
  write1h: number;
  costUsd: number;
  cacheWriteUsd: number;
}

class Upstream {
  entries: CacheEntry[] = [];
  /** `readMult` = cache-read price × base (official 0.1; cloudrouter opus-5-5 bills 0.05 — F7). */
  constructor(
    readonly oneHourLife: OneHourLife,
    readonly readMult = 0.1,
  ) {}

  clone(): Upstream {
    const u = new Upstream(this.oneHourLife, this.readMult);
    u.entries = this.entries.map((e) => ({ ...e }));
    return u;
  }

  send(now: number, lineage: number, prefix: number, ttl: "5m" | "1h"): Usage {
    const honored1h = ttl === "1h" && this.oneHourLife !== "ignored";
    this.entries = this.entries.filter((e) => e.expiresAt > now);
    const readable = this.entries.filter(
      (e) => e.lineage === lineage && e.prefix <= prefix && (!honored1h || e.ns === "1h"),
    );
    let best: CacheEntry | undefined;
    for (const e of readable) if (best === undefined || e.prefix > best.prefix) best = e;
    if (best !== undefined) best.expiresAt = now + best.lifeMs; // a hit refreshes the entry
    const read = Math.min(prefix, Math.max(SHARED, best?.prefix ?? 0));
    const write = prefix - read;
    const write1h = honored1h ? write : 0;
    const lifeMs = honored1h ? (this.oneHourLife as number) : 5 * MIN;
    if (write > 0) this.entries.push({ lineage, prefix, ns: honored1h ? "1h" : "5m", lifeMs, expiresAt: now + lifeMs });
    const cacheWriteUsd = ((write - write1h) * 1.25 + write1h * 2.0) * R;
    return { read, write, write1h, cacheWriteUsd, costUsd: read * this.readMult * R + cacheWriteUsd };
  }
}

// ─── session driver ────────────────────────────────────────────────────────

interface Step {
  gapMs: number;
  /** Tokens appended to the prefix before this request (user msg / tool results / last reply). */
  delta: number;
  signals?: Partial<AdaptiveSignals>;
  /** Prefix drift before this request: new cache lineage, prefix reset to this size. */
  compactTo?: number;
  /** `agent_settled` after this request (closes the strong-signal episode). */
  settle?: boolean;
  /** Background work was live during the gap BEFORE this step ⇒ keepalive is armed. */
  pingArmed?: boolean;
}

interface RunResult {
  costUsd: number;
  upgrades: number;
  /** Σ over upgrade requests of (cost sent at 1h − cost of the same request sent at 5m, same upstream state). */
  trueMarginalUsd: number;
  /** What the extension itself booked (upgradeWriteUsd + feeWriteUsd). */
  bookedUsd: number;
  longGapHits: number;
  longGapMisses: number;
  pings: number;
  pingUsd: number;
  coverCollapses: number;
  state: AdaptiveState;
  reasons: Record<string, number>;
}

interface RunOpts {
  /** `on` = every request ttl:"1h" (cacheTtl.mode=on); keepalive then never pings (gate #7). */
  mode: "adaptive" | "auto" | "on";
  life: OneHourLife;
  startPrefix: number;
  keepalive?: boolean;
  readMult?: number;
}

const PING_INTERVAL_MS = 240_000;
const PING_MAX = 11;
const KEEPALIVE_HORIZON_MS = keepaliveGapHorizonMs({ intervalMs: PING_INTERVAL_MS, maxPings: PING_MAX });

function run(steps: readonly Step[], opts: RunOpts) {
  const up = new Upstream(opts.life, opts.readMult);
  let state = createInitialAdaptiveState();
  let now = 1_800_000_000_000;
  let prefix = opts.startPrefix;
  let lineage = 0;
  let entries = 0; // session entry count (user + assistant per request)
  let ledger: LedgerUsage = {
    source: "unknown",
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: undefined,
    costTotalUsd: undefined,
    cacheWriteUsd: undefined,
    entrySeq: -1,
    entriesLength: 0,
    modelId: "",
  };
  let lastPrefix = 0;
  // Keepalive gate #8 realism: a window's capture carries the ledger of the request BEFORE the
  // captured one, so the gap after a session's first request is never pinged ("prefix-unproven").
  // `ledgerPrefix` is the latest settled assistant usage — it survives compaction, like the real
  // `readLatestAssistantUsage` does; `capturePrefix` is what the pinger sees for the current window.
  let ledgerPrefix = 0;
  let capturePrefix = 0;
  let lastTtl: "5m" | "1h" = "5m";
  let lastProvenAt: number | undefined;
  const res: RunResult = {
    costUsd: 0,
    upgrades: 0,
    trueMarginalUsd: 0,
    bookedUsd: 0,
    longGapHits: 0,
    longGapMisses: 0,
    pings: 0,
    pingUsd: 0,
    coverCollapses: 0,
    state,
    reasons: {},
  };

  for (const step of steps) {
    const prevAt = now;
    now += step.gapMs;
    const yieldToAdaptive =
      opts.mode === "adaptive" && adaptiveCoversPrefix(state, CONFIG, prevAt, KEEPALIVE_HORIZON_MS);
    if (opts.keepalive && step.pingArmed && lastTtl === "5m" && capturePrefix >= 20_000 && !yieldToAdaptive) {
      for (let i = 1; i <= PING_MAX && prevAt + i * PING_INTERVAL_MS < now; i++) {
        const at = prevAt + i * PING_INTERVAL_MS;
        const ping = up.send(at, lineage, lastPrefix, "5m");
        res.pings += 1;
        res.pingUsd += ping.costUsd;
        res.costUsd += ping.costUsd;
        if (ping.write === 0) lastProvenAt = at;
        else {
          // an unproven ping ends the window and clears its capture ⇒ provenCacheReadAt() = undefined
          lastProvenAt = undefined;
          break;
        }
      }
    }
    if (step.compactTo !== undefined) {
      lineage += 1;
      prefix = step.compactTo;
      lastPrefix = 0;
      entries += 1; // compaction entry
      state = invalidateAdaptive(state, "compact", entries);
      lastProvenAt = undefined; // the keepalive window is invalidated on the same event (capture cleared)
    }
    prefix += step.delta;
    entries += 1; // user / toolResult entry
    const signals: AdaptiveSignals = {
      subagentRuns: 0,
      maxSubagentHorizonMs: undefined,
      backgroundBashJobs: 0,
      uiPrompts: 0,
      activeTools: 0,
      ...step.signals,
    };

    let ttl: "5m" | "1h" = opts.mode === "on" ? "1h" : "5m";
    if (opts.mode === "adaptive") {
      const gapMs = state.lastRequestStartedAt !== undefined ? now - state.lastRequestStartedAt : undefined;
      // Same derivation as CacheAdaptiveService.decide (F-D / F-C).
      const lastStart = state.lastRequestStartedAt;
      const provenAt = lastProvenAt;
      const gapArmed = lastStart !== undefined && provenAt !== undefined && provenAt > lastStart;
      const sinceTouchMs = gapArmed && provenAt !== undefined ? now - provenAt : gapMs;
      const decision = decideAdaptiveTtl({
        now,
        mode: "adaptive",
        api: "anthropic-messages",
        provider: "cloudrouter-anthropic",
        modelId: MODEL,
        supportsLongCacheRetention: true,
        shape: { ephemeralBreakpoints: 2, ttl1h: false, hasThinking: false, maxTokens: 32_000 },
        signals,
        ledger: { ...ledger, entriesLength: entries },
        config: CONFIG,
        state,
        lastProvenCacheReadAt: lastProvenAt,
        lineageKey: `L${lineage}`,
        // R1: the pinger only covers the next gap when the measured prefix clears its min-prefix gate.
        keepaliveHorizonMs: opts.keepalive && ledgerPrefix >= 20_000 ? KEEPALIVE_HORIZON_MS : undefined,
      });
      const key = decision.upgrade ? `UP:${decision.class}` : `no:${decision.reason}`;
      res.reasons[key] = (res.reasons[key] ?? 0) + 1;
      state = noteDecision(state, decision, {
        now,
        gapMs,
        entriesLength: entries,
        strongSignals: decision.signals.filter((s) => s !== "history-gap").length,
        lineageKey: `L${lineage}`,
        routeKey: `cloudrouter-anthropic|${MODEL}`,
        gapArmed,
        sinceTouchMs,
      });
      if (decision.upgrade) {
        ttl = "1h";
        res.upgrades += 1;
        const counterfactual = up.clone().send(now, lineage, prefix, "5m");
        const actual = up.clone().send(now, lineage, prefix, "1h");
        res.trueMarginalUsd += actual.costUsd - counterfactual.costUsd;
      }
    }

    const usage = up.send(now, lineage, prefix, ttl);
    lastTtl = ttl;
    res.costUsd += usage.costUsd;
    if (step.gapMs > 5 * MIN && lastPrefix > 0) {
      if (usage.read >= 0.5 * lastPrefix) res.longGapHits += 1;
      else res.longGapMisses += 1;
    }
    lastPrefix = usage.read + usage.write;
    capturePrefix = ledgerPrefix;
    ledgerPrefix = lastPrefix;
    ledger = {
      source: "usage",
      cacheRead: usage.read,
      cacheWrite: usage.write,
      cacheWrite1h: usage.write1h,
      costTotalUsd: usage.costUsd,
      cacheWriteUsd: usage.cacheWriteUsd,
      entrySeq: entries, // the assistant entry lands at index `entries`
      entriesLength: entries + 1,
      modelId: MODEL,
      providerId: "cloudrouter-anthropic", // R9: survival evidence needs a known route
    };
    entries += 1;
    if (opts.mode === "adaptive") {
      // message_end / turn_end / agent_end all reconcile — the m2 watermark must make it count once.
      for (let i = 0; i < 3; i++) state = onLedgerObserved(state, ledger, now + 5_000, CONFIG);
      if (step.settle) state = endArmedEpisode(state);
    }
  }
  res.state = state;
  res.coverCollapses = state.coverCollapses;
  res.bookedUsd = state.upgradeWriteUsd + state.feeWriteUsd;
  return res;
}

function compare(name: string, steps: readonly Step[], life: OneHourLife, startPrefix = 100_000) {
  const adaptive = run(steps, { mode: "adaptive", life, startPrefix });
  const auto = run(steps, { mode: "auto", life, startPrefix });
  const net = auto.costUsd - adaptive.costUsd;
  if (process.env.ADAPTIVE_ECON_REPORT === "1") {
    // eslint-disable-next-line no-console
    console.log(
      `[econ] ${name.padEnd(46)} auto $${auto.costUsd.toFixed(2)}  adaptive $${adaptive.costUsd.toFixed(2)}  ` +
        `net ${net >= 0 ? "+" : ""}${net.toFixed(2)}  ups=${adaptive.upgrades}  ` +
        `longGap hit/miss auto ${auto.longGapHits}/${auto.longGapMisses} adaptive ${adaptive.longGapHits}/${adaptive.longGapMisses}  ` +
        `marginal true $${adaptive.trueMarginalUsd.toFixed(2)} booked $${adaptive.bookedUsd.toFixed(2)}  ` +
        `breaker=${adaptive.state.breaker?.reason ?? "-"}  ${JSON.stringify(adaptive.reasons)}`,
    );
  }
  return { adaptive, auto, net };
}

// ─── scenario builders ─────────────────────────────────────────────────────

const SUBAGENT_30M: Partial<AdaptiveSignals> = { subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN };

/** One agent run: `n` requests `gapBetween` apart; the first request comes after `gapBefore`. */
function turn(n: number, gapBefore: number, delta: number, signals?: Partial<AdaptiveSignals>, gapBetween = 20_000) {
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    steps.push({ gapMs: i === 0 ? gapBefore : gapBetween, delta, ...(signals ? { signals } : {}) });
  }
  steps[steps.length - 1]!.settle = true;
  return steps;
}

/**
 * The dev-flow "background dispatch" rhythm: a turn dispatches a background
 * subagent (the requests after the dispatch see a live run), the user then
 * waits `wait`, and the subagent's completion notification wakes a turn in
 * which the run is already terminal (no strong signal).
 */
function dispatchCycles(cycles: number, wait: number): Step[] {
  const steps: Step[] = [];
  for (let c = 0; c < cycles; c++) {
    steps.push({ gapMs: c === 0 ? 0 : 60_000, delta: 3_000 }); // the dispatching request
    steps.push(...turn(2, 20_000, 2_000, SUBAGENT_30M)); // follow-ups with the run live
    const wake = turn(3, wait, 4_000); // completion notification turn
    wake[0]!.pingArmed = true; // the subagent was live during the whole wait
    steps.push(...wake);
  }
  return steps;
}

// ─── goals ─────────────────────────────────────────────────────────────────

describe("adaptive economics — G1: long gaps behind a live horizon get cheaper", () => {
  it("documented route (1h lives 60 min): 20-min background waits turn misses into hits and save money", () => {
    const { adaptive, auto, net } = compare("G1 dispatch×4, wait 20m, 1h=60m", dispatchCycles(4, 20 * MIN), 60 * MIN);
    expect(auto.longGapMisses).toBe(4);
    expect(adaptive.longGapHits).toBe(4);
    expect(adaptive.longGapMisses).toBe(0);
    expect(adaptive.state.breaker).toBeUndefined();
    expect(adaptive.state.feeUpgrades).toBe(1); // exactly one entry fee for the whole session
    expect(net).toBeGreaterThan(0);
  });

  it("measured route (1h lives ~10 min): 8-min waits still hit and save money", () => {
    const { adaptive, auto, net } = compare("G1 dispatch×4, wait 8m, 1h=10m", dispatchCycles(4, 8 * MIN), 10 * MIN);
    expect(auto.longGapMisses).toBe(4);
    expect(adaptive.longGapHits).toBe(4);
    expect(adaptive.state.breaker).toBeUndefined();
    expect(net).toBeGreaterThan(0);
  });

  it("a single long wait does not amortize the entry fee (documents the break-even point)", () => {
    const one = compare("G1 dispatch×1, wait 20m, 1h=60m", dispatchCycles(1, 20 * MIN), 60 * MIN);
    const two = compare("G1 dispatch×2, wait 20m, 1h=60m", dispatchCycles(2, 20 * MIN), 60 * MIN);
    // fee ≈ P×(2.0−0.1)R vs one saved miss ≈ P×(1.25−0.1)R ⇒ break-even needs ~2 covered gaps.
    expect(one.net).toBeLessThan(0);
    expect(two.net).toBeGreaterThan(0);
  });
});

describe("adaptive economics — G2: dense interaction without horizon signals costs nothing", () => {
  it("no signals, 30-s cadence: zero upgrades, cost identical to auto", () => {
    const steps: Step[] = [];
    for (let t = 0; t < 10; t++) steps.push(...turn(5, t === 0 ? 0 : 90_000, 3_000));
    const { adaptive, auto } = compare("G2 dense, no signals", steps, 60 * MIN);
    expect(adaptive.upgrades).toBe(0);
    expect(adaptive.costUsd).toBeCloseTo(auto.costUsd, 10);
  });

  it("only fast tools (activeTools) never upgrade", () => {
    const steps: Step[] = [];
    for (let t = 0; t < 6; t++) steps.push(...turn(5, 60_000, 3_000, { activeTools: 3 }));
    const { adaptive, auto } = compare("G2 dense, activeTools only", steps, 60 * MIN);
    expect(adaptive.upgrades).toBe(0);
    expect(adaptive.costUsd).toBeCloseTo(auto.costUsd, 10);
  });
});

describe("adaptive economics — G3: wrong predictions are bounded", () => {
  it("dense interaction WITH a live subagent (no gap ever materializes): loss ≤ fee budget + marginal budget", () => {
    const steps: Step[] = [];
    for (let t = 0; t < 12; t++) steps.push(...turn(5, t === 0 ? 0 : 60_000, 3_000, SUBAGENT_30M));
    const { adaptive, net } = compare("G3 dense + live subagent (pure waste)", steps, 60 * MIN);
    expect(adaptive.upgrades).toBeGreaterThan(0);
    expect(net).toBeLessThan(0); // it IS a loss — the question is only how big
    expect(-net).toBeLessThanOrEqual(CONFIG.feeBudgetUsd + CONFIG.writeBudgetUsd);
    // F4: the session-start cold upgrade is booked at the 0.375 premium, not 0.95 (was $1.87 vs $1.35).
    expect(adaptive.bookedUsd / adaptive.trueMarginalUsd).toBeLessThan(1.1);
  });

  it("adversarial: frequent prefix drift + permanent bash-job signal ⇒ fee budget stops new entry fees", () => {
    const steps: Step[] = [];
    for (let c = 0; c < 15; c++) {
      steps.push({ gapMs: 60_000, delta: 0, compactTo: 150_000, signals: { backgroundBashJobs: 1 } });
      steps.push(...turn(4, 20_000, 3_000, { backgroundBashJobs: 1 }));
    }
    const { adaptive, net } = compare("G3 compact every 5 req + bash job", steps, 60 * MIN);
    const maxPrefix = 150_000 + 5 * 3_000;
    // Budgets are checked BEFORE each upgrade ⇒ at most one full-prefix overshoot per budget.
    const overshoot = maxPrefix * 2.0 * R;
    expect(adaptive.reasons["no:fee-budget"] ?? 0).toBeGreaterThan(0);
    expect(-net).toBeLessThanOrEqual(CONFIG.feeBudgetUsd + CONFIG.writeBudgetUsd + 2 * overshoot);
  });

  it("the extension's own USD bookkeeping tracks the true marginal cost (within 25%)", () => {
    const { adaptive } = compare("G3 accounting check (dispatch×4)", dispatchCycles(4, 20 * MIN), 60 * MIN);
    expect(adaptive.trueMarginalUsd).toBeGreaterThan(0);
    const ratio = adaptive.bookedUsd / adaptive.trueMarginalUsd;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.25);
  });
});

describe("adaptive economics — G4: routes where 1h does not work self-disable", () => {
  it("proxy ignores ttl:1h ⇒ 1h-ineffective breaker at the first covered long gap, ~zero loss", () => {
    const { adaptive, net } = compare("G4 route ignores ttl", dispatchCycles(4, 20 * MIN), "ignored");
    expect(adaptive.state.breaker?.reason).toBe("1h-ineffective");
    expect(Math.abs(net)).toBeLessThan(0.01);
  });

  it("1h lives only 10 min but waits are 20 min ⇒ trips once, loss bounded by one entry fee", () => {
    const { adaptive, net } = compare("G4 1h=10m, wait 20m", dispatchCycles(4, 20 * MIN), 10 * MIN);
    expect(adaptive.state.breaker?.reason).toBe("1h-ineffective");
    const fee = (100_000 + 3_000 + 2 * 2_000) * 1.9 * R;
    expect(-net).toBeLessThanOrEqual(fee * 1.2);
    const upsAfterTrip = adaptive.upgrades;
    expect(upsAfterTrip).toBeLessThanOrEqual(2);
  });
});

// ─── G5: against the production default (keepalive on) ─────────────────────

function compare4(name: string, steps: readonly Step[], life: OneHourLife, startPrefix = 100_000) {
  const base = { life, startPrefix };
  const r = {
    auto: run(steps, { ...base, mode: "auto" }),
    autoKa: run(steps, { ...base, mode: "auto", keepalive: true }),
    adaptive: run(steps, { ...base, mode: "adaptive" }),
    adaptiveKa: run(steps, { ...base, mode: "adaptive", keepalive: true }),
  };
  if (process.env.ADAPTIVE_ECON_REPORT === "1") {
    const f = (x: RunResult) =>
      `$${x.costUsd.toFixed(2)}(p${x.pings},u${x.upgrades},h${x.longGapHits}/m${x.longGapMisses})`;
    // eslint-disable-next-line no-console
    console.log(
      `[econ4] ${name.padEnd(34)} auto ${f(r.auto)}  auto+ka ${f(r.autoKa)}  adaptive ${f(r.adaptive)}  adaptive+ka ${f(r.adaptiveKa)}` +
        `  ka-breaker=${r.adaptiveKa.state.breaker?.reason ?? "-"} ${JSON.stringify(r.adaptiveKa.reasons)}`,
    );
  }
  return r;
}

describe("adaptive economics — G5: value on top of keepalive (the production default)", () => {
  // F1 (verification-2026-09-25): this used to be a FINDING PIN — adaptive+ka cost
  // $4.86 vs $3.69 for keepalive alone (entry fee + refreshes bought nothing new).
  it("waits within the ping horizon (20 min): adaptive yields to keepalive — no double payment", () => {
    const r = compare4("G5 dispatch×4 wait 20m 1h=60m", dispatchCycles(4, 20 * MIN), 60 * MIN);
    expect(r.autoKa.longGapMisses).toBe(0);
    expect(r.adaptiveKa.longGapMisses).toBe(0);
    expect(r.adaptiveKa.upgrades).toBe(0);
    expect(r.adaptiveKa.reasons["no:keepalive-covers"] ?? 0).toBeGreaterThan(0);
    expect(r.adaptiveKa.costUsd).toBeLessThanOrEqual(r.autoKa.costUsd + 1e-9);
  });

  it("waits beyond the ping horizon (60 min) on the documented 60-min route: adaptive adds value", () => {
    const r = compare4("G5 dispatch×4 wait 60m 1h=60m", dispatchCycles(4, 60 * MIN - 30_000), 60 * MIN);
    expect(r.autoKa.longGapMisses).toBe(4);
    expect(r.adaptiveKa.longGapHits).toBeGreaterThan(0);
    expect(r.adaptiveKa.costUsd).toBeLessThan(r.autoKa.costUsd);
    // R2 (review): keepalive only stands down once this session has PROVEN the 1h entry
    // outlives the ping horizon (a covered hit after ≥ 49 min). Before that proof the
    // windows still ping — the first (no cover yet) and the second (cover, no proof) —
    // so the cost sits a little above plain `auto`; that is the price of never trading
    // a working 5m cover for an unproven 1h one.
    expect(r.adaptiveKa.pings).toBeLessThanOrEqual(2 * PING_MAX);
    expect(r.adaptiveKa.state.max1hSurvivalMs).toBeGreaterThanOrEqual(KEEPALIVE_HORIZON_MS);
  });

  it("waits beyond the ping horizon on the measured 10-min route: 1h cannot help, adaptive self-disables", () => {
    const r = compare4("G5 dispatch×4 wait 60m 1h=10m", dispatchCycles(4, 60 * MIN - 30_000), 10 * MIN);
    expect(r.adaptiveKa.longGapHits).toBe(0);
    expect(r.adaptiveKa.state.breaker?.reason).toBe("1h-ineffective");
    // one entry fee plus the 1h premium on the increments it carried
    const fee = (100_000 + 3_000 + 2 * 2_000) * 1.9 * R;
    expect(r.adaptiveKa.costUsd - r.autoKa.costUsd).toBeLessThanOrEqual(fee * 1.1);
  });

  it("waits within the ping horizon on the measured 10-min route", () => {
    const r = compare4("G5 dispatch×4 wait 20m 1h=10m", dispatchCycles(4, 20 * MIN), 10 * MIN);
    expect(r.autoKa.longGapMisses).toBe(0);
    expect(r.adaptiveKa.costUsd).toBeLessThanOrEqual(r.autoKa.costUsd + 1e-9);
  });
});

// ─── strategy matrix: every mode × workload × 1h survival × price profile ─────
//
// Answers "how much does the production default save versus always-5m and
// always-1h?" across workloads, instead of per-goal pins. Rows are workloads,
// columns the five strategies a user can actually configure. Printed with
// ADAPTIVE_ECON_REPORT=1; the assertions only pin the bounded-loss invariant
// (adaptive on top of keepalive never costs more than its budgets over
// keepalive alone) so the table can evolve without brittle numbers.

/** Human think-time between turns, no background work: no strong signal, keepalive unarmed. */
function humanGaps(turns: number, gapsMin: readonly number[]): Step[] {
  const steps: Step[] = [];
  for (let t = 0; t < turns; t++) steps.push(...turn(4, t === 0 ? 0 : gapsMin[t % gapsMin.length]! * MIN, 3_000));
  return steps;
}

/** A long background bash job (build/test) the user waits on, `cycles` times. */
function bashWaits(cycles: number, wait: number): Step[] {
  const steps: Step[] = [];
  for (let c = 0; c < cycles; c++) {
    steps.push(...turn(2, c === 0 ? 0 : 60_000, 3_000, { backgroundBashJobs: 1 }));
    const wake = turn(3, wait, 4_000);
    wake[0]!.pingArmed = true;
    steps.push(...wake);
  }
  return steps;
}

function denseTurns(turns: number, signals?: Partial<AdaptiveSignals>): Step[] {
  const steps: Step[] = [];
  for (let t = 0; t < turns; t++) steps.push(...turn(5, t === 0 ? 0 : 90_000, 3_000, signals));
  return steps;
}

function compactChurn(): Step[] {
  const steps: Step[] = [];
  for (let c = 0; c < 15; c++) {
    steps.push({ gapMs: 60_000, delta: 0, compactTo: 150_000, signals: { backgroundBashJobs: 1 } });
    steps.push(...turn(4, 20_000, 3_000, { backgroundBashJobs: 1 }));
  }
  return steps;
}

/** A plausible working session stitched from the pieces above. */
function mixedDay(): Step[] {
  const a = denseTurns(5);
  const b = dispatchCycles(2, 20 * MIN);
  b[0]!.gapMs = 60_000;
  const c = humanGaps(4, [3, 8, 15, 6]);
  c[0]!.gapMs = 4 * MIN;
  const d = dispatchCycles(2, 50 * MIN);
  d[0]!.gapMs = 60_000;
  const e: Step[] = [{ gapMs: 60_000, delta: 0, compactTo: 60_000 }, ...denseTurns(3, SUBAGENT_30M)];
  const f = dispatchCycles(1, 30 * MIN);
  f[0]!.gapMs = 60_000;
  return [...a, ...b, ...c, ...d, ...e, ...f];
}

/** A session opens with a plain user turn — no background work can exist before the first request. */
function opened(build: () => Step[]): () => Step[] {
  return () => {
    const steps = build();
    return [{ gapMs: 0, delta: 0 }, ...steps.map((st, i) => (i === 0 ? { ...st, gapMs: 30_000 } : st))];
  };
}

const MATRIX_WORKLOADS: ReadonlyArray<readonly [string, () => Step[]]> = [
  ["dense, no signals", () => denseTurns(10)],
  ["dense + live subagent", () => denseTurns(12, SUBAGENT_30M)],
  ["human gaps 3-15m", () => humanGaps(8, [3, 8, 15, 6])],
  ["dispatch×4 wait 8m", () => dispatchCycles(4, 8 * MIN)],
  ["dispatch×4 wait 20m", () => dispatchCycles(4, 20 * MIN)],
  ["dispatch×4 wait 40m", () => dispatchCycles(4, 40 * MIN)],
  ["dispatch×4 wait 58m", () => dispatchCycles(4, 58 * MIN)],
  ["bash build×3 wait 25m", () => bashWaits(3, 25 * MIN)],
  ["compact churn + bash", compactChurn],
  ["mixed day", mixedDay],
  ["long break, bash×4 25m", longBreakThenBash],
  ["dispatch 58m, bash×4 25m", longWaitThenBash],
];

/** An ARMED >horizon wait (legit entry fee under F1/F-D), then ping-bridged 25-min builds (F-A's remaining path). */
function longWaitThenBash(): Step[] {
  const back = bashWaits(4, 25 * MIN);
  back[0]!.gapMs = 60_000;
  return [...dispatchCycles(1, 58 * MIN), ...back];
}

/** A >horizon idle (lunch) teaches the gap ring, then ping-bridged 25-min builds follow (F-A's legit-cover path). */
function longBreakThenBash(): Step[] {
  const steps = [...denseTurns(3)];
  const back = bashWaits(4, 25 * MIN);
  back[0]!.gapMs = 55 * MIN;
  return [...steps, ...back];
}

const STRATEGIES = [
  ["5m", { mode: "auto" }],
  ["5m+ka", { mode: "auto", keepalive: true }],
  ["1h", { mode: "on" }],
  ["adaptive", { mode: "adaptive" }],
  ["adaptive+ka", { mode: "adaptive", keepalive: true }],
] as const satisfies ReadonlyArray<readonly [string, Pick<RunOpts, "mode" | "keepalive">]>;

function runMatrix(life: OneHourLife, readMult: number) {
  const rows = MATRIX_WORKLOADS.map(([name, build]) => {
    const steps = opened(build)();
    const cells = STRATEGIES.map(([label, s]) => {
      const r = run(steps, { ...s, life, startPrefix: 100_000, readMult });
      return { label, r };
    });
    return { name, cells, maxPrefix: Math.max(...cells.map((c) => c.r.state.lastPrefixTokens ?? 0), 200_000) };
  });
  if (process.env.ADAPTIVE_ECON_REPORT === "1") {
    const pct = (x: number, base: number) => `${x <= base ? "-" : "+"}${Math.abs((1 - x / base) * 100).toFixed(0)}%`;
    const lines = [
      `[matrix] 1h life=${life === "ignored" ? "ignored" : `${(life as number) / MIN}m`}  read=${readMult}×  (cost; % vs 5m)`,
      `  ${"workload".padEnd(24)}${STRATEGIES.map(([l]) => l.padStart(17)).join("")}   best`,
    ];
    const totals = STRATEGIES.map(() => 0);
    for (const row of rows) {
      const base = row.cells[0]!.r.costUsd;
      const best = row.cells.reduce((a, b) => (b.r.costUsd < a.r.costUsd - 1e-9 ? b : a));
      row.cells.forEach((c, i) => (totals[i]! += c.r.costUsd));
      lines.push(
        `  ${row.name.padEnd(24)}${row.cells
          .map((c, i) => `$${c.r.costUsd.toFixed(2)}${i === 0 ? "" : ` ${pct(c.r.costUsd, base)}`}`.padStart(17))
          .join("")}   ${best.label}`,
      );
    }
    lines.push(
      `  ${"Σ (equal weight)".padEnd(24)}${totals
        .map((t, i) => `$${t.toFixed(2)}${i === 0 ? "" : ` ${pct(t, totals[0]!)}`}`.padStart(17))
        .join("")}`,
    );
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }
  return rows;
}

describe("adaptive economics — strategy matrix (5m / 5m+ka / 1h / adaptive / adaptive+ka)", () => {
  const LIVES: readonly OneHourLife[] = [60 * MIN, 25 * MIN, 10 * MIN];
  for (const readMult of [0.1, 0.05]) {
    for (const life of LIVES) {
      it(`bounded loss vs keepalive alone — 1h life ${(life as number) / MIN}m, read ${readMult}×`, () => {
        for (const row of runMatrix(life, readMult)) {
          const autoKa = row.cells[1]!.r.costUsd;
          const adaptiveKa = row.cells[4]!.r.costUsd;
          const overshoot = row.maxPrefix * 2.0 * R;
          expect(adaptiveKa - autoKa, row.name).toBeLessThanOrEqual(
            CONFIG.feeBudgetUsd + CONFIG.writeBudgetUsd + 2 * overshoot,
          );
        }
      });
    }
  }
});

// ─── regressions from the 2026-09-26 strategy matrix (F-A / F-C / F-D) ─────────

describe("adaptive economics — 2026-09-26 fixes hold across the matrix", () => {
  const cell = (life: OneHourLife, readMult: number, workload: string, label: string) => {
    const [, build] = MATRIX_WORKLOADS.find(([n]) => n === workload)!;
    const [, s] = STRATEGIES.find(([l]) => l === label)!;
    return run(opened(build)(), { ...s, life, startPrefix: 100_000, readMult });
  };

  for (const readMult of [0.1, 0.05]) {
    for (const life of [60 * MIN, 25 * MIN]) {
      const tag = `1h ${life / MIN}m, read ${readMult}×`;
      it(`F-D: an unpinged human idle no longer disables F1 — adaptive+ka = keepalive alone (${tag})`, () => {
        const ka = cell(life, readMult, "long break, bash×4 25m", "5m+ka");
        const aka = cell(life, readMult, "long break, bash×4 25m", "adaptive+ka");
        expect(aka.upgrades).toBe(0); // was: entry fee + renewals on top of the pings
        expect(aka.costUsd).toBeCloseTo(ka.costUsd, 10);
      });
    }
    it(`F-A: after a legit fee, a dead 1h entry is found once, not per renewal (1h 25m, read ${readMult}×)`, () => {
      const aka = cell(25 * MIN, readMult, "dispatch 58m, bash×4 25m", "adaptive+ka");
      expect(aka.state.coverCollapses).toBe(1); // was 3 (every renewal rewrote the whole prefix)
      expect(aka.state.learned1hLifeMs).toBeDefined();
      expect(aka.state.learned1hLifeMs!).toBeLessThan(60 * MIN);
    });
    it(`F-A control: when the 1h entry really lives 60 min nothing is learned (read ${readMult}×)`, () => {
      const aka = cell(60 * MIN, readMult, "dispatch 58m, bash×4 25m", "adaptive+ka");
      expect(aka.state.coverCollapses).toBe(0);
      expect(aka.state.learned1hLifeMs).toBeUndefined();
    });
  }
});
