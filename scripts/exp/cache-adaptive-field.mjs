#!/usr/bin/env node
/**
 * Field analysis of the cache TTL "adaptive" feature (plan.md §16.3/§17/§18,
 * field template docs/dev/cache-ttl-adaptive/field-2026-09-24.md).
 *
 * Reads pi session .jsonl files (streaming, zero deps) and computes:
 *  1. decisions by reason; upgrades by class × covered1h
 *  2. each upgrade + settling usage, classified entry-fee / covered-refresh /
 *     anomaly (cacheWrite1h === 0 despite upgrade)
 *  3. payoff events: gap > 5min requests while a 1h entry was written <= 60min
 *     earlier and no keepalive proven hit covered the gap; hit vs miss by
 *     gap-since-1h-write bucket; estimated $ saving per hit
 *  4. feature cost: extension accounting (feeWriteUsd + upgradeWriteUsd) and an
 *     independent estimate (see ESTIMATE formula in the output)
 *  5. net = savings − cost, per session and total; pure-waste upgrades
 *  6. breakers: trips, post-trip decision reasons, budget-snapshot resets
 *     (reload persistence / rehydration failures)
 *  7. keepalive interplay: cold-cache-alive declines; D1 regression check
 *  8. whole-prefix misses NOT caused by gaps (gap < 300s, read < 0.5×prev)
 *
 * Usage: node cache-adaptive-field.mjs [session.jsonl ...]
 *        (no args → auto-discover ~/.pi/agent/sessions (recursive) .jsonl
 *         modified after 2026-09-24 14:15 +0800 containing subagent:cache-adaptive)
 */

import { createReadStream } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUT_MS = Date.parse("2026-09-23T17:36:00Z"); // cb33ea7 (D1) landed
/** Sessions analyzed only after this time (per task instructions). */
const WINDOW_OVERRIDES = [
  ["01a0cf02", Date.parse("2026-09-24T04:51:00Z")], // huge session spanning pre-fix code
];
const DISCOVER_MTIME_MS = Date.parse("2026-09-24T14:15:00+08:00");
const COMMIT_TIMES = [
  ["cb33ea7 D1", Date.parse("2026-09-23T17:36:00Z")],
  ["c527de0 §18-tail", Date.parse("2026-09-24T02:26:00Z")],
  ["a0c3400 rehydrate", Date.parse("2026-09-24T06:14:00Z")],
];
const GAP_MS = 300_000; // 5 min
const PROVEN_ALIVE_MS = 255_000; // ASSUMED_TTL_MS(300k) − TTL_SAFETY_MARGIN(45k)
const COVER_MS = 3_600_000;
const HIT_FRACTION = 0.5; // ADAPTIVE_COVER_HIT_FRACTION
const ADAPTIVE = "subagent:cache-adaptive";
const KEEPALIVE = "subagent:cache-keepalive";
const MIN = 60_000;
const GAP_BUCKETS = [
  [5 * MIN, 7 * MIN, "5-7"],
  [7 * MIN, 10 * MIN, "7-10"],
  [10 * MIN, 13 * MIN, "10-13"],
  [13 * MIN, 20 * MIN, "13-20"],
  [20 * MIN, 60 * MIN + 1, "20-60"],
];

const fmt = (n) =>
  n === undefined || n === null || Number.isNaN(n)
    ? "–"
    : typeof n === "number"
      ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 3 })
      : n;
const iso = (ms) => (ms === undefined ? "–" : new Date(ms).toISOString().replace(".000Z", "Z"));
const usd = (n) => (n === undefined || Number.isNaN(n) ? "–" : `$${n.toFixed(3)}`);

function bucketOf(ms) {
  for (const [lo, hi, label] of GAP_BUCKETS) if (ms >= lo && ms < hi) return label;
  return ms >= 60 * MIN ? ">60" : "<5";
}

/** Median of a numeric array. */
function median(arr) {
  if (arr.length === 0) return undefined;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function parseSession(file) {
  const s = {
    file,
    label: path.basename(file, ".jsonl").slice(0, 30),
    id: "",
    sessionStartMs: undefined,
    msgs: [], // assistant messages with usage
    decisions: [],
    reconciles: [],
    keepalive: [], // proven-hit entries
    modelChanges: [],
    compacts: [],
  };
  const rl = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = e.timestamp !== undefined ? Date.parse(e.timestamp) : undefined;
    if (ts !== undefined && s.sessionStartMs === undefined) s.sessionStartMs = ts;
    if (e.type === "session" && e.id) s.id = e.id;
    if (e.type === "model_change") {
      s.modelChanges.push({ ts, model: `${e.provider}/${e.modelId}` });
    } else if (e.type === "compact") {
      s.compacts.push({ ts });
    } else if (e.type === "message" && e.message && e.message.role === "assistant") {
      const u = e.message.usage;
      if (!u) continue;
      // message.timestamp = request-start epoch ms (matches decision `at` clocks)
      const reqTs =
        typeof e.message.timestamp === "number" && Number.isFinite(e.message.timestamp) ? e.message.timestamp : ts;
      s.msgs.push({
        ts: reqTs,
        entryTs: ts,
        model: e.message.model ?? "?",
        provider: e.message.provider ?? "?",
        input: u.input ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheWrite1h: typeof u.cacheWrite1h === "number" ? u.cacheWrite1h : undefined,
        costRead: u.cost?.cacheRead,
        costWrite: u.cost?.cacheWrite,
        costTotal: u.cost?.total,
      });
    } else if (e.type === "custom" && e.customType === ADAPTIVE && e.data) {
      const d = e.data;
      const at = typeof d.at === "number" ? d.at : ts;
      if (d.kind === "decision") s.decisions.push({ ...d, at });
      else if (d.kind === "reconcile") s.reconciles.push({ ...d, at });
    } else if (e.type === "custom" && e.customType === KEEPALIVE && e.data) {
      if (e.data.kind === "proven-hit") s.keepalive.push({ ...e.data });
    }
  }
  s.msgs.sort((a, b) => a.ts - b.ts);
  s.decisions.sort((a, b) => a.at - b.at);
  s.reconciles.sort((a, b) => a.at - b.at);
  return s;
}

// ---------------------------------------------------------------------------
// Pricing per model (derived from usage.cost of that very model's messages)
// ---------------------------------------------------------------------------

/** Returns { model -> {pread, p5m, p1h} } — EMPIRICAL $/tok medians from that model's
 *  own usage.cost fields (routes may deviate from the official 0.1/1.25/2.0
 *  multipliers — e.g. cloudrouter-anthropic opus-5-5: read 0.2, 5m 5.0, 1h 8.0 $/M,
 *  which is NOT 0.1×base of any single base). Fallbacks via official multipliers
 *  when a sample class is missing. */
function derivePrices(msgs) {
  const byModel = new Map();
  for (const m of msgs) {
    const cur = byModel.get(m.model) ?? { readRates: [], w5: [], w1h: [] };
    if (m.cacheRead > 0 && m.costRead > 0) cur.readRates.push(m.costRead / m.cacheRead); // $/tok
    if (m.cacheWrite > 0 && m.costWrite > 0) {
      if (m.cacheWrite1h !== undefined && m.cacheWrite1h >= m.cacheWrite * 0.999)
        cur.w1h.push(m.costWrite / m.cacheWrite);
      else if (m.cacheWrite1h === undefined || m.cacheWrite1h === 0) cur.w5.push(m.costWrite / m.cacheWrite);
    }
    byModel.set(m.model, cur);
  }
  const prices = new Map();
  for (const [model, r] of byModel) {
    const p5m = median(r.w5);
    const p1h = median(r.w1h) ?? (p5m !== undefined ? p5m * (2.0 / 1.25) : undefined);
    const pread = median(r.readRates) ?? (p5m !== undefined ? p5m * (0.1 / 1.25) : undefined);
    if (p5m === undefined && p1h === undefined && pread === undefined) continue;
    prices.set(model, { pread, p5m, p1h });
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Per-session analysis
// ---------------------------------------------------------------------------

function analyzeSession(s, prices) {
  const windowStart = WINDOW_OVERRIDES.find(([id]) => s.id.startsWith(id))?.[1] ?? CUT_MS;
  const codeAt = (t) => {
    let label = "pre-D1";
    for (const [name, ct] of COMMIT_TIMES) if (t >= ct) label = name;
    return label;
  };

  const decisions = s.decisions.filter((d) => d.at >= windowStart);
  const reconciles = s.reconciles.filter((r) => r.at >= windowStart);
  const msgs = s.msgs; // messages are not window-cut; prev-prefix anchors need history

  // -- per-model prefix anchors (cache is per model+prefix) ----------------
  // msg.ts = request-send time (matches decision `at` clock); entryTs = entry
  // append ≈ response completion ≈ cache-write completion.
  const lastByModel = new Map(); // model -> {ts, prefix}
  const anchors = new Map(); // msg index -> {prevPrefix, prevTs} BEFORE this msg
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prev = lastByModel.get(m.model);
    anchors.set(i, prev ? { prevPrefix: prev.prefix, prevTs: prev.ts } : { prevPrefix: 0, prevTs: undefined });
    lastByModel.set(m.model, { ts: m.ts, prefix: m.cacheRead + m.cacheWrite });
  }
  // last 1h write / last cache access per model before each msg, by WRITE time (entryTs)
  const last1hByModel = new Map();
  const lastAccessByModel = new Map();
  const last1h = new Map(); // msg index -> {writeAt, model, point} of last 1h write
  const next1h = new Map(); // msg index -> ts of NEXT 1h write of same model (for revival checks)
  const lastAccess = new Map(); // msg index -> {at, model} of last read/write
  const next1hByModel = new Map();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    next1h.set(i, next1hByModel.get(m.model));
    if (m.cacheWrite1h !== undefined && m.cacheWrite1h > 0) next1hByModel.set(m.model, m.entryTs ?? m.ts);
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prevInfo = last1hByModel.get(m.model);
    last1h.set(
      i,
      prevInfo !== undefined ? { writeAt: prevInfo.writeAt, model: m.model, point: prevInfo.point } : undefined,
    );
    lastAccess.set(
      i,
      lastAccessByModel.get(m.model) !== undefined ? { at: lastAccessByModel.get(m.model), model: m.model } : undefined,
    );
    const writeAt = m.entryTs ?? m.ts;
    if (m.cacheRead > 0 || m.cacheWrite > 0) lastAccessByModel.set(m.model, writeAt);
    if (m.cacheWrite1h !== undefined && m.cacheWrite1h > 0)
      last1hByModel.set(m.model, { writeAt, point: m.cacheRead + m.cacheWrite });
  }

  // settle-msg matching: msg.ts (request send) ≈ decision.at ± ms skew; allow 3s slack.
  // Requests are sequential; some decisions error out (no msg), so scan unclaimed msgs.
  const claimed = new Array(msgs.length).fill(false);
  const settleIdxOf = new Map(); // decision index (in `decisions`) -> msg idx
  let base = 0;
  decisions.forEach((d, di) => {
    while (base < msgs.length && (claimed[base] || msgs[base].ts < d.at - 3000)) base++;
    for (let i = base; i < msgs.length; i++) {
      if (claimed[i] || msgs[i].ts < d.at - 3000) continue;
      if (msgs[i].ts > d.at + 150_000) break; // no response within 2.5min → none
      settleIdxOf.set(di, i);
      claimed[i] = true;
      break;
    }
  });

  // -- item 1: decision counts ---------------------------------------------
  const reasons = new Map();
  const upgradesByClass = new Map(); // "warm|covered" etc
  for (const d of decisions) {
    const key = d.upgrade ? `UPGRADE(${d.class}${d.covered1h ? ",covered" : ",uncovered"})` : (d.reason ?? "?");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  // -- item 2: upgrades + settles ------------------------------------------
  const upgrades = [];
  let recPtr = 0;
  decisions.forEach((d, di) => {
    if (!d.upgrade) return;
    // settle = first reconcile with a pending after decision time
    while (recPtr < reconciles.length && reconciles[recPtr].at < d.at) recPtr++;
    let settle = undefined;
    for (let j = recPtr; j < reconciles.length; j++) {
      if (reconciles[j].pendingClass !== undefined) {
        settle = reconciles[j];
        recPtr = j + 1;
        break;
      }
      if (reconciles[j].at - d.at > 20 * MIN) break; // pending TTL is 120s; give slack
    }
    const msgIdx = settleIdxOf.get(di);
    const msg = msgIdx !== undefined ? msgs[msgIdx] : undefined;
    const anchor = msgIdx !== undefined ? anchors.get(msgIdx) : undefined;
    const readCollapsed =
      anchor !== undefined &&
      anchor.prevPrefix > 0 &&
      settle !== undefined &&
      settle.cacheRead < HIT_FRACTION * anchor.prevPrefix;
    const anomaly = settle !== undefined && settle.cacheWrite1h === 0;
    let cls;
    if (settle === undefined) cls = "dropped-pending";
    else if (anomaly) cls = "anomaly(w1h=0)";
    else if (settle.pendingCovered1h === false || readCollapsed) cls = "entry-fee";
    else cls = "covered-refresh";
    upgrades.push({ d, settle, msg, msgIdx, readCollapsed, anomaly, cls });
  });

  // -- item 3: payoff events ------------------------------------------------
  // A payoff candidate is a request whose 5m entries were provably stale
  // (no cache access by this model for >5min — reads refresh the 5m TTL) while
  // a 1h write of the same model was (300s, 3600s] old, and keepalive did not
  // cover the gap. NOTE: gapBeforeMs>300s alone is NOT enough — a long
  // in-flight request can write 1ms before the next decision (observed:
  // 01a0d188 03:59:05, 6.5min request whose response landed 1ms before the next).
  const payoffs = [];
  let payoffExcludedKeepalive = 0;
  let payoffExcludedNoAnchor = 0;
  let payoffExcludedFresh5m = 0;
  decisions.forEach((d, di) => {
    if (d.gapBeforeMs === undefined || d.gapBeforeMs <= GAP_MS) return;
    const msgIdx = settleIdxOf.get(di);
    if (msgIdx === undefined) return;
    const m = msgs[msgIdx];
    const info = last1h.get(msgIdx);
    const acc = lastAccess.get(msgIdx);
    if (!info || info.model !== m.model || d.at - info.writeAt > COVER_MS) return;
    if (d.provenReadAgeMs !== undefined && d.provenReadAgeMs <= PROVEN_ALIVE_MS) {
      payoffExcludedKeepalive++;
      return;
    }
    const gap1h = d.at - info.writeAt;
    if (gap1h <= GAP_MS || (acc !== undefined && acc.model === m.model && d.at - acc.at <= GAP_MS)) {
      payoffExcludedFresh5m++; // cache touched (read/write) <5min ago → 5m would hit anyway
      return;
    }
    const anchor = anchors.get(msgIdx);
    if (!anchor || anchor.prevPrefix <= 0) {
      payoffExcludedNoAnchor++;
      return;
    }
    const hit = m.cacheRead >= HIT_FRACTION * anchor.prevPrefix;
    const p = prices.get(m.model);
    // attribute only the tokens covered by the 1h entry itself (a read beyond the
    // 1h point came from fresher 5m entries, not from the 1h write)
    const savedTokens = Math.min(m.cacheRead, info.point);
    const saving = hit && p ? savedTokens * (p.p5m - p.pread) : 0;
    // revival check: if a LATER request of the same model (before the next 1h
    // write) reads ≥50% of the same 1h point, the entry was alive all along and
    // this miss is a prefix-lineage split, not 1h expiry (observed: 01a0d2f9
    // 10:49 miss at 9.6min vs 11:02 read of the exact 1h point at 23.2min)
    let lineageSuspect = false;
    if (!hit) {
      // A valid witness: a LATER request of the same model that (a) happens
      // before the next 1h write / +1h, and (b) is itself stale — no cache
      // access in the prior 5min — so its ≥50% read of the 1h point can only
      // have come from the 1h entry (a fresh 5m rewrite would not qualify).
      const horizon = next1h.get(msgIdx) ?? m.ts + COVER_MS;
      let lastAcc = acc !== undefined && acc.model === m.model ? acc.at : undefined;
      for (let k = msgIdx + 1; k < msgs.length; k++) {
        const mm = msgs[k];
        if (mm.ts > Math.min(horizon, m.ts + COVER_MS)) break;
        if (mm.model !== m.model) continue;
        const stale = lastAcc === undefined || mm.ts - lastAcc > 360_000; // >6min: past observed 5m-TTL slack
        if (stale && mm.cacheRead >= HIT_FRACTION * info.point) {
          lineageSuspect = true;
          break;
        }
        if (mm.cacheRead > 0 || mm.cacheWrite > 0) lastAcc = mm.entryTs ?? mm.ts;
      }
    }
    payoffs.push({
      at: d.at,
      gapReq: d.gapBeforeMs,
      gap1h,
      gapLastAccess: acc !== undefined && acc.model === m.model ? d.at - acc.at : undefined,
      model: m.model,
      hit,
      lineageSuspect,
      // a hit only 5–6min after the last cache access may be a 5m entry read
      // within TTL slack (observed reads at 305–318s), not a 1h payoff
      ambiguous: hit && acc !== undefined && acc.model === m.model && d.at - acc.at <= 360_000,
      cacheRead: m.cacheRead,
      prevPrefix: anchor.prevPrefix,
      oneHourPoint: info.point,
      saving,
      upgraded: !!d.upgrade,
    });
  });

  // -- item 4: cost ----------------------------------------------------------
  // Extension accounting: last reconcile snapshots in window
  let extFeeUsd = 0,
    extUpgUsd = 0,
    extFeeTok = 0,
    extUpgTok = 0,
    lastBudgetSeen;
  for (const r of reconciles) {
    extFeeUsd = r.feeWriteUsd ?? extFeeUsd;
    extUpgUsd = r.upgradeWriteUsd ?? extUpgUsd;
    extFeeTok = r.feeWriteTokens ?? extFeeTok;
    extUpgTok = r.upgradeWriteTokens ?? extUpgTok;
    lastBudgetSeen = r;
  }
  // Independent estimate:
  //  A = Σ cacheWrite1h × (p1h − p5m)   [1h premium over a 5m write of the same tokens]
  //  B = Σ over entry-fee-like landed upgrades max(0, cacheWrite − predictedDelta) × (p1h − pread)
  //     [those tokens would have been READ (0.1×) had the request stayed 5m]
  //  independent = A + B   (covered-refresh 5m tails are left at the A rate: slight undercount)
  let costA = 0,
    costB = 0;
  const msgsInWindow = msgs.filter((m) => m.ts >= windowStart);
  for (const m of msgsInWindow) {
    if (m.cacheWrite1h !== undefined && m.cacheWrite1h > 0) {
      const p = prices.get(m.model);
      if (p) costA += m.cacheWrite1h * (p.p1h - p.p5m);
    }
  }
  for (const u of upgrades) {
    if (u.settle === undefined || u.settle.cacheWrite1h === 0 || u.settle.cacheWrite1h === undefined) continue;
    if (u.cls !== "entry-fee") continue;
    const p = u.msg ? prices.get(u.msg.model) : undefined;
    if (!p) continue;
    const wouldRead = Math.max(0, u.settle.cacheWrite - (u.d.predictedDeltaTokens ?? 0));
    costB += wouldRead * (p.p1h - p.pread);
  }

  // -- item 5: net + waste -------------------------------------------------
  const savings = payoffs.reduce((a, p) => a + p.saving, 0);
  const landed = upgrades.filter((u) => u.settle && u.settle.cacheWrite1h > 0);
  // fee episodes: a maximal chain of landed upgrades spaced <1h apart. A fee is
  // amortized if any payoff HIT lands before (last settle + 1h) of its episode.
  const episodes = [];
  for (const u of landed) {
    const last = episodes[episodes.length - 1];
    if (last && u.settle.at - last.lastAt < COVER_MS) {
      last.lastAt = u.settle.at;
      last.ups.push(u);
    } else {
      episodes.push({ firstAt: u.settle.at, lastAt: u.settle.at, ups: [u] });
    }
  }
  const feeEpisodes = episodes.filter((e) => e.ups.some((u) => u.cls === "entry-fee"));
  const wastedFees = feeEpisodes.filter(
    (e) => !payoffs.some((p) => p.hit && p.at > e.firstAt - 60_000 && p.at < e.lastAt + COVER_MS),
  );
  // pure waste (literal task definition): landed 1h write with no >5min IDLE gap
  // (next request start − prev response completion, per model) before the next
  // landed upgrade or prefix drift (model change / compact / same-model read collapse)
  let pureWaste = 0;
  for (let i = 0; i < landed.length; i++) {
    const t0 = landed[i].settle.at;
    const t1 = i + 1 < landed.length ? landed[i + 1].settle.at : Infinity;
    let followed = false;
    for (let k = 1; k < msgs.length; k++) {
      const m = msgs[k];
      const prev = msgs[k - 1];
      if (m.model !== prev.model) continue;
      const idleStart = prev.entryTs ?? prev.ts;
      if (m.ts > t0 && m.ts < t1 && m.ts - idleStart > GAP_MS) {
        followed = true;
        break;
      }
    }
    if (followed) continue;
    // drift check: model change / compact / same-model read collapse in (t0, t1)
    let drifted = false;
    for (const mc of s.modelChanges) if (mc.ts > t0 && mc.ts < t1) drifted = true;
    for (const c of s.compacts) if (c.ts > t0 && c.ts < t1) drifted = true;
    if (drifted) continue;
    for (let k = 0; k < msgs.length; k++) {
      const m = msgs[k];
      if (m.ts <= t0 || m.ts >= t1) continue;
      const a = anchors.get(k);
      if (a && a.prevPrefix > 0 && m.cacheRead < HIT_FRACTION * a.prevPrefix) drifted = true;
    }
    if (!drifted) pureWaste++;
  }

  // -- item 6: breakers & resets (whole file — session-level question) ------
  const firstTrip = s.reconciles.find((r) => typeof r.breaker === "string" && r.breaker.length > 0);
  let decisionsAfterTrip = 0,
    breakerReasonsAfterTrip = 0,
    nonBreakerAfterTrip = [];
  if (firstTrip) {
    for (const d of s.decisions) {
      if (d.at <= firstTrip.at) continue;
      decisionsAfterTrip++;
      if (d.reason === "breaker" || d.reason === "write-budget" || d.reason === "fee-budget") breakerReasonsAfterTrip++;
      else if (d.upgrade || (d.reason && !["breaker", "write-budget", "fee-budget"].includes(d.reason)))
        nonBreakerAfterTrip.push(d);
    }
  }
  // budget snapshot resets: consecutive decisions where the snapshot drops
  const resets = [];
  let prevSnap;
  for (const d of s.decisions) {
    const b = d.budget;
    if (!b) continue;
    const snap = (b.upgradeWriteTokens ?? 0) + (b.feeWriteTokens ?? 0);
    if (prevSnap !== undefined && snap < prevSnap.sum) {
      resets.push({ at: d.at, from: prevSnap.sum, to: snap, reason: d.reason, upgrade: d.upgrade });
    }
    prevSnap = { sum: snap, at: d.at };
  }
  // rehydration check: after a reset, does the next decision still say "breaker"
  // with a non-zero budget (restored) — or do upgrades resume with zero budget (failure)?
  const rehydrated = [];
  for (const r of resets) {
    let restored = false;
    for (const d of s.decisions) {
      if (d.at < r.at) continue;
      if (d.reason === "breaker" && (d.budget?.upgradeWriteTokens ?? 0) + (d.budget?.feeWriteTokens ?? 0) > 0) {
        restored = true;
        break;
      }
      if (d.at - r.at > 10 * MIN) break;
    }
    rehydrated.push(restored);
  }

  // -- item 7: keepalive interplay -------------------------------------------
  let coldCacheAlive = 0;
  const d1Regressions = [];
  for (const d of decisions) {
    if (d.reason === "cold-cache-alive") coldCacheAlive++;
    if (d.upgrade && d.class === "cold" && d.provenReadAgeMs !== undefined && d.provenReadAgeMs < PROVEN_ALIVE_MS) {
      d1Regressions.push({ at: d.at, provenReadAgeMs: d.provenReadAgeMs });
    }
  }

  // -- item 8: non-gap whole-prefix misses -----------------------------------
  let nonGapMisses = 0;
  const nonGapMissUpgrades = new Set();
  const nonGapMissExamples = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.ts < windowStart) continue;
    const a = anchors.get(i);
    if (!a || a.prevPrefix <= 0 || a.prevTs === undefined) continue;
    if (m.ts - a.prevTs >= GAP_MS) continue;
    if (m.cacheRead < HIT_FRACTION * a.prevPrefix) {
      nonGapMisses++;
      if (nonGapMissExamples.length < 5)
        nonGapMissExamples.push({
          at: m.ts,
          model: m.model,
          read: m.cacheRead,
          prevPrefix: a.prevPrefix,
          gapMs: m.ts - a.prevTs,
        });
    }
  }
  for (const u of upgrades)
    if (u.settle && u.msg && u.settle.cacheRead < HIT_FRACTION * (anchors.get(u.msgIdx)?.prevPrefix ?? 0))
      nonGapMissUpgrades.add(u.settle.at);

  // upgrades contributing to item 8 count
  let nonGapMissByUpgrade = 0;
  for (const u of upgrades) {
    if (!u.msg || !u.settle) continue;
    const a = anchors.get(u.msgIdx);
    if (
      a &&
      a.prevPrefix > 0 &&
      a.prevTs !== undefined &&
      u.msg.ts - a.prevTs < GAP_MS &&
      u.settle.cacheRead < HIT_FRACTION * a.prevPrefix
    )
      nonGapMissByUpgrade++;
  }

  return {
    s,
    windowStart,
    codeStart: codeAt(s.sessionStartMs ?? 0),
    decisions,
    reasons,
    upgrades,
    payoffs,
    payoffExcludedKeepalive,
    payoffExcludedFresh5m,
    payoffExcludedNoAnchor,
    ext: { extFeeUsd, extUpgUsd, extFeeTok, extUpgTok, lastBudgetSeen },
    costA,
    costB,
    savings,
    pureWaste,
    feeEpisodes: feeEpisodes.length,
    wastedFees: wastedFees.length,
    wastedFeeDetail: wastedFees.map((e) => iso(e.firstAt)),
    breaker: { firstTrip, decisionsAfterTrip, breakerReasonsAfterTrip, nonBreakerAfterTrip },
    resets,
    rehydrated,
    coldCacheAlive,
    d1Regressions,
    nonGapMisses,
    nonGapMissByUpgrade,
    nonGapMissExamples,
    msgsInWindow,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSession(r, prices) {
  const L = [];
  const sid = r.s.id.slice(0, 8) || path.basename(r.s.file).slice(0, 14);
  const modelSet = [...new Set(r.s.msgs.map((m) => m.model))].join(", ");
  L.push(`\n=== ${sid}  ${path.basename(r.s.file)} ===`);
  L.push(
    `start ${iso(r.s.sessionStartMs)} (latest commit ≤ start: ${r.codeStart} — process may be older) · window ≥ ${iso(r.windowStart)} · models: ${modelSet}`,
  );
  if (prices.size) {
    const ps = [...prices.entries()]
      .map(
        ([m, p]) =>
          `${m}: r=${p.pread !== undefined ? (p.pread * 1e6).toFixed(2) : "?"}/5m=${p.p5m !== undefined ? (p.p5m * 1e6).toFixed(2) : "?"}/1h=${p.p1h !== undefined ? (p.p1h * 1e6).toFixed(2) : "?"} $/M`,
      )
      .join(" · ");
    L.push(`prices: ${ps}`);
  }
  L.push(
    `decisions in window: ${r.decisions.length}, reconciles: ${r.s.reconciles.filter((x) => x.at >= r.windowStart).length}, keepalive proven-hits: ${r.s.keepalive.length}`,
  );

  // item 1
  L.push(`-- 1. decisions by reason:`);
  const reasonRows = [...r.reasons.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of reasonRows) L.push(`   ${String(v).padStart(5)}  ${k}`);
  const upgTotal = r.upgrades.length;
  L.push(
    `   upgrades: ${upgTotal} total (${r.upgrades.filter((u) => u.d.class === "warm").length} warm / ${r.upgrades.filter((u) => u.d.class === "cold").length} cold)`,
  );

  // item 2
  L.push(`-- 2. upgrade settlements:`);
  const byCls = new Map();
  for (const u of r.upgrades) byCls.set(u.cls, (byCls.get(u.cls) ?? 0) + 1);
  L.push(`   ${[...byCls.entries()].map(([k, v]) => `${v}× ${k}`).join(", ") || "none"}`);
  for (const u of r.upgrades) {
    if (u.settle === undefined) {
      L.push(
        `   ${iso(u.d.at)} ${u.d.class}${u.d.covered1h ? "(cov)" : ""} Δ̂=${fmt(u.d.predictedDeltaTokens)} → NO SETTLE (dropped pending)`,
      );
      continue;
    }
    L.push(
      `   ${iso(u.settle.at)} ${u.d.class}${u.d.covered1h ? "(cov)" : ""} ${u.cls}: read=${fmt(u.settle.cacheRead)} write=${fmt(u.settle.cacheWrite)} w1h=${fmt(u.settle.cacheWrite1h)} $write=${usd(u.settle.cacheWriteUsd)} ${u.anomaly ? "  <-- ANOMALY w1h=0" : ""}`,
    );
  }

  // item 3
  L.push(`-- 3. payoff events (gap>5min, 1h entry ≤60min old, keepalive not covering):`);
  L.push(
    `   candidates excluded: keepalive-covered=${r.payoffExcludedKeepalive}, cache-touched<5min=${r.payoffExcludedFresh5m}, no-anchor=${r.payoffExcludedNoAnchor}`,
  );
  if (r.payoffs.length === 0) L.push(`   none`);
  const hist = new Map();
  for (const b of GAP_BUCKETS) hist.set(b[2], { hit: 0, miss: 0 });
  for (const p of r.payoffs) {
    const b = hist.get(bucketOf(p.gap1h));
    if (b) b[p.hit ? "hit" : "miss"]++;
  }
  L.push(`   bucket(min-since-1h-write)  hit  miss`);
  for (const [label, c] of hist)
    L.push(`   ${label.padEnd(26)} ${String(c.hit).padStart(4)} ${String(c.miss).padStart(4)}`);
  for (const p of r.payoffs) {
    L.push(
      `   ${iso(p.at)} gapReq=${(p.gapReq / MIN).toFixed(1)}m gap1h=${(p.gap1h / MIN).toFixed(1)}m lastAccess=${p.gapLastAccess !== undefined ? `${(p.gapLastAccess / MIN).toFixed(1)}m` : "?"} ${p.hit ? "HIT " : "MISS"}${p.lineageSuspect ? "(lineage-suspect)" : p.ambiguous ? "(5m-slack-ambiguous)" : "          "} read=${fmt(p.cacheRead)}/${fmt(p.prevPrefix)} 1hpt=${fmt(p.oneHourPoint)} ${p.upgraded ? "(upgraded req)" : ""} saving=${usd(p.saving)}`,
    );
  }

  // item 4
  L.push(`-- 4. cost of the feature:`);
  L.push(
    `   extension accounting: fee=${usd(r.ext.extFeeUsd)} (${fmt(r.ext.extFeeTok)} tok) + marginal=${usd(r.ext.extUpgUsd)} (${fmt(r.ext.extUpgTok)} tok) = ${usd(r.ext.extFeeUsd + r.ext.extUpgUsd)}`,
  );
  if (r.ext.lastBudgetSeen) L.push(`   last breaker field in reconcile: ${r.ext.lastBudgetSeen.breaker ?? "none"}`);
  L.push(`   independent estimate A (Σ w1h×(1h−5m premium)) = ${usd(r.costA)}`);
  L.push(`   independent estimate B (entry-fee would-have-read × (1h−read)) = ${usd(r.costB)}`);
  L.push(`   independent total A+B = ${usd(r.costA + r.costB)}`);

  // item 5
  L.push(`-- 5. net = savings − cost:`);
  L.push(
    `   savings ${usd(r.savings)} − independent ${usd(r.costA + r.costB)} = ${usd(r.savings - r.costA - r.costB)}`,
  );
  L.push(
    `   savings ${usd(r.savings)} − extension  ${usd(r.ext.extFeeUsd + r.ext.extUpgUsd)} = ${usd(r.savings - r.ext.extFeeUsd - r.ext.extUpgUsd)}`,
  );
  L.push(
    `   pure-waste landed upgrades (literal: no >5min idle gap before next upgrade/drift): ${r.pureWaste}/${r.upgrades.filter((u) => u.settle && u.settle.cacheWrite1h > 0).length}`,
  );
  L.push(
    `   fee episodes: ${r.feeEpisodes}, never amortized (no payoff hit): ${r.wastedFees}${r.wastedFeeDetail.length ? ` [${r.wastedFeeDetail.join(", ")}]` : ""}`,
  );

  // item 6
  L.push(`-- 6. breakers & reload persistence (whole file):`);
  L.push(
    `   first trip: ${r.breaker.firstTrip ? `${r.breaker.firstTrip.breaker} @ ${iso(r.breaker.firstTrip.at)}` : "never"}`,
  );
  L.push(
    r.breaker.firstTrip
      ? `   decisions after trip: ${r.breaker.decisionsAfterTrip}, breaker/budget-gated: ${r.breaker.breakerReasonsAfterTrip}, other: ${r.breaker.nonBreakerAfterTrip.length} (upgrades among them: ${r.breaker.nonBreakerAfterTrip.filter((d) => d.upgrade).length}${r.breaker.nonBreakerAfterTrip.length ? `; first: ${iso(r.breaker.nonBreakerAfterTrip[0].at)} ${r.breaker.nonBreakerAfterTrip[0].upgrade ? "UPGRADE" : r.breaker.nonBreakerAfterTrip[0].reason}` : ""})`
      : `   no breaker ever tripped`,
  );
  L.push(`   budget-snapshot drops (state resets / reloads): ${r.resets.length}`);
  r.resets.forEach((rs, i) => {
    L.push(
      `     ${iso(rs.at)} ${fmt(rs.from)} → ${fmt(rs.to)} tok (decision: ${rs.upgrade ? "UPGRADE" : rs.reason}) rehydrated-within-10min=${r.rehydrated[i]}`,
    );
  });

  // item 7
  L.push(`-- 7. keepalive interplay:`);
  L.push(`   cold-cache-alive declines: ${r.coldCacheAlive}`);
  L.push(
    `   D1 regressions (cold upgrade <255s after proven hit): ${r.d1Regressions.length}${r.d1Regressions.map((d) => ` [${iso(d.at)} age=${(d.provenReadAgeMs / 1000).toFixed(0)}s]`).join("")}`,
  );

  // item 8
  L.push(`-- 8. whole-prefix misses with gap<5min (non-gap misses, for context):`);
  L.push(`   total: ${r.nonGapMisses} (of which upgrade settles: ${r.nonGapMissByUpgrade})`);
  for (const ex of r.nonGapMissExamples)
    L.push(
      `     ${iso(ex.at)} ${ex.model} read=${fmt(ex.read)}/${fmt(ex.prevPrefix)} gap=${(ex.gapMs / 1000).toFixed(0)}s`,
    );
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function discover() {
  const root = path.join(os.homedir(), ".pi/agent/sessions");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(root, f));
  const hits = [];
  for (const f of files) {
    try {
      if (statSync(f).mtimeMs < DISCOVER_MTIME_MS) continue;
    } catch {
      continue;
    }
    // quick scan for the custom type (stream, cheap bail-out)
    const rl = readline.createInterface({ input: createReadStream(f, "utf8"), crlfDelay: Infinity });
    let found = false;
    for await (const line of rl) {
      if (line.includes(`"customType":"${ADAPTIVE}"`)) {
        found = true;
        rl.close();
        break;
      }
    }
    if (found) hits.push(f);
  }
  return hits.sort();
}

const files = process.argv.length > 2 ? process.argv.slice(2) : await discover();
console.log(`# cache-adaptive field analysis — ${new Date().toISOString()}`);
console.log(`# files: ${files.length}`);
const results = [];
for (const f of files) {
  const s = await parseSession(f);
  if (s.decisions.length === 0 && s.reconciles.length === 0) continue;
  const prices = derivePrices(s.msgs);
  const r = analyzeSession(s, prices);
  results.push(r);
  console.log(renderSession(r, prices));
}

// ---- totals ----
const T = {
  decisions: 0,
  upgrades: 0,
  hit: 0,
  miss: 0,
  savings: 0,
  costA: 0,
  costB: 0,
  extFee: 0,
  extUpg: 0,
  pureWaste: 0,
  feeEpisodes: 0,
  wastedFees: 0,
  landed: 0,
  anomalies: [],
  hist: new Map(GAP_BUCKETS.map((b) => [b[2], { hit: 0, miss: 0 }])),
  lineageSuspect: 0,
  ambiguous: 0,
  d1: 0,
  coldCacheAlive: 0,
  nonGapMisses: 0,
  nonGapMissUpgrades: 0,
  breakerSessions: 0,
  resetSessions: 0,
  rehydrateFail: 0,
};
for (const b of GAP_BUCKETS) T.hist.set(b[2], { hit: 0, miss: 0 });
for (const r of results) {
  T.decisions += r.decisions.length;
  T.upgrades += r.upgrades.length;
  T.savings += r.savings;
  T.costA += r.costA;
  T.costB += r.costB;
  T.extFee += r.ext.extFeeUsd;
  T.extUpg += r.ext.extUpgUsd;
  T.pureWaste += r.pureWaste;
  T.feeEpisodes += r.feeEpisodes;
  T.wastedFees += r.wastedFees;
  T.landed += r.upgrades.filter((u) => u.settle && u.settle.cacheWrite1h > 0).length;
  T.d1 += r.d1Regressions.length;
  T.coldCacheAlive += r.coldCacheAlive;
  T.nonGapMisses += r.nonGapMisses;
  T.nonGapMissUpgrades += r.nonGapMissByUpgrade;
  if (r.breaker.firstTrip) T.breakerSessions++;
  if (r.resets.length) T.resetSessions++;
  r.rehydrated.forEach((ok) => !ok && T.rehydrateFail++);
  for (const u of r.upgrades) if (u.anomaly) T.anomalies.push({ sid: r.s.id.slice(0, 8), at: u.settle.at, cls: u.cls });
  for (const p of r.payoffs) {
    T[p.hit ? "hit" : "miss"]++;
    if (p.lineageSuspect) T.lineageSuspect++;
    if (p.ambiguous) T.ambiguous++;
    const b = T.hist.get(bucketOf(p.gap1h));
    if (b) b[p.hit ? "hit" : "miss"]++;
  }
}
console.log(`\n===== TOTALS (${results.length} sessions) =====`);
console.log(
  `decisions ${T.decisions}, upgrades ${T.upgrades} (${T.landed} landed w1h>0, anomalies w1h=0: ${T.anomalies.length})`,
);
console.log(
  `payoff events: ${T.hit} hits / ${T.miss} misses (${T.lineageSuspect} misses lineage-suspect; ${T.ambiguous} hits 5m-slack-ambiguous)`,
);
console.log(`1h survival histogram (by minutes since 1h write): bucket hit miss`);
for (const [label, c] of T.hist)
  console.log(`  ${label.padEnd(8)} ${String(c.hit).padStart(3)} ${String(c.miss).padStart(3)}`);
console.log(`savings (hits)                    : ${usd(T.savings)}`);
console.log(`independent cost A (1h premium)   : ${usd(T.costA)}`);
console.log(`independent cost B (entry-fee rd) : ${usd(T.costB)}`);
console.log(`independent cost total            : ${usd(T.costA + T.costB)}`);
console.log(`NET (savings − independent)       : ${usd(T.savings - T.costA - T.costB)}`);
console.log(`extension-accounting cost (Σ last fee+marginal per session): ${usd(T.extFee + T.extUpg)}`);
console.log(`NET (savings − extension)         : ${usd(T.savings - T.extFee - T.extUpg)}`);
console.log(
  `pure-waste upgrades (literal): ${T.pureWaste}/${T.landed}; fee episodes: ${T.feeEpisodes}, never amortized: ${T.wastedFees}`,
);
console.log(
  `breakers: ${T.breakerSessions}/${results.length} sessions tripped; sessions w/ budget resets: ${T.resetSessions}; resets NOT rehydrated within 10min: ${T.rehydrateFail}`,
);
console.log(`cold-cache-alive declines: ${T.coldCacheAlive}; D1 regressions: ${T.d1}`);
console.log(`non-gap whole-prefix misses: ${T.nonGapMisses} (upgrade settles: ${T.nonGapMissUpgrades})`);
if (T.anomalies.length) {
  console.log(`anomaly (w1h=0) examples:`);
  for (const a of T.anomalies.slice(0, 10)) console.log(`  ${a.sid} ${iso(a.at)} ${a.cls}`);
}
