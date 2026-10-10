#!/usr/bin/env node
/**
 * consult 专家保活前置 — 缓存埋点分析库（docs/dev/consult/expert-keepalive-plan.md §4.4，包 F）。
 *
 * 供 `consult-cache-analyze.mjs` 与 `tests/exp/consult-cache-analyze.test.ts` 共用。
 * 不 import src/：只读持久化的 `subagent:run` JSONL 形状（`diag.consults.cacheProbes`
 * 与历史 `diag.consults` / `diag.experts` / `absorbedRunIds`），除 node:crypto（透传自
 * consult-ab-lib）外无任何依赖。
 *
 * 复用 `consult-ab-lib.mjs` 的解析/去重/分位（§4.4「复用 :55, 95, 158」）。
 *
 * 两种模式：
 *  - probe（默认）：消费 `diag.consults.cacheProbes[]`（§4.1 ConsultCacheProbe 形状），
 *    输出结局分布（含按原因码分组的 identity_mismatch）、hitRatio 按
 *    api × preflight × predicted 的分布与「预检通过但 hitRatio<0.5」个案、逐请求
 *    cacheRead/cacheWrite、间隔分桶、成本 cold/warm、被拦调用与 costAfterUsd、
 *    以及 §11 的保活 go/no-go 四项指标。
 *  - retro（--retro）：历史数据（今天只有 diag.consults，没有 cacheProbes）——
 *    从 `subagent:run` 重算「专家结算 → 消费者派发」的间隔分桶（§4.4），并输出
 *    可得到的结局分布与成本。命中率与 c2Effective 依赖 cacheProbes，在 retro 下为 null。
 */

import {
  RUN_CUSTOM_TYPE,
  TERMINAL_STATUSES,
  dedupeRuns,
  mean,
  median,
  parseDayUtc,
  parseSessionText,
  percentile,
} from "./consult-ab-lib.mjs";

/* --------------------------------------------------------------- buckets --- */

/** §4.4 间隔分桶边界（毫秒）：<4.25m / 4.25–15 / 15–45 / >45m。 */
export const GAP_BUCKET_425_MS = 4.25 * 60 * 1000;
export const GAP_BUCKET_15_MS = 15 * 60 * 1000;
export const GAP_BUCKET_45_MS = 45 * 60 * 1000;

/** §11 C2 生产有效：预检通过且 gapSettleMs ≤ 4 min 时 hitRatio 中位数 ≥ 0.6。 */
export const GO_C2_EFFECTIVE_MAX_GAP_MS = 4 * 60 * 1000;
export const GO_C2_EFFECTIVE_MIN_HIT = 0.6;

/** §11 可续命：D 间隔（专家结算 → 消费者派发）≤ 4.25 min 的需求窗口 ≥ 50%。 */
export const GO_RENEWABLE_MAX_GAP_MS = GAP_BUCKET_425_MS;
export const GO_RENEWABLE_MIN_SHARE = 0.5;

/** §11 可寻址：gapSettleMs ∈ (4.25m, 45m] 且预检通过的 consult ≥ 30%。 */
export const GO_ADDRESSABLE_GAP_LO_MS = GAP_BUCKET_425_MS;
export const GO_ADDRESSABLE_GAP_HI_MS = GAP_BUCKET_45_MS;
export const GO_ADDRESSABLE_MIN_SHARE = 0.3;

/** §11 净收益：保守上界下净节省 ≥ 20% 且 ≥ $2/周。 */
export const GO_NET_MIN_SHARE = 0.2;
export const GO_NET_MIN_WEEKLY_USD = 2;

/** 「预检通过但未命中」个案的 hitRatio 阈值（§4.4）。 */
export const MISS_HIT_RATIO = 0.5;

const MIN_CONSULTS_ANTHROPIC = 30;

/* -------------------------------------------------------------- helpers --- */

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * hitRatio（钳到 [0,1]）：优先取探针自带的 `hitRatio`，否则用
 * `requests[0].cacheRead / expertPrefixTokens` 现算（与 §4.1 一致）；均不可得返回 null。
 */
export function hitRatioOf(probe) {
  const recorded = num(probe?.hitRatio);
  if (recorded !== undefined) return clamp01(recorded);
  const read = num(probe?.requests?.[0]?.cacheRead);
  const prefix = num(probe?.expertPrefixTokens);
  if (read !== undefined && prefix !== undefined && prefix > 0) return clamp01(read / prefix);
  return null;
}

/** 预检归一化：`"pass"` / `"fail"`（带 `fail:${code}` 的只留前缀）。 */
export function preflightState(probe) {
  const pf = probe?.identity?.preflight;
  if (typeof pf !== "string") return "fail";
  return pf === "pass" ? "pass" : "fail";
}

/** `fail:${code}` 的原因码；非 fail 或缺失返回 null。 */
export function preflightReason(probe) {
  const pf = probe?.identity?.preflight;
  if (typeof pf !== "string" || !pf.startsWith("fail:")) return null;
  return pf.slice("fail:".length);
}

/**
 * predicted 摘要（§4.1 只记录项）：无 predicted 信息 ⇒ `"n/a"`；所有字段都为 true
 * ⇒ `"match"`；任一为 false ⇒ `"mismatch"`（并附带为 false 的字段名清单）。
 */
export function predictedSummary(probe) {
  const predicted = probe?.identity?.predicted;
  if (!isObject(predicted)) return { state: "n/a", mismatches: [] };
  const mismatches = [];
  for (const [key, value] of Object.entries(predicted)) {
    if (value === false) mismatches.push(key);
  }
  return { state: mismatches.length > 0 ? "mismatch" : "match", mismatches };
}

/** 间隔分桶标签（§4.4）：within425 / _425_15 / _15_45 / over45 / unknown。 */
export function gapBucket(gapMs) {
  const g = num(gapMs);
  if (g === undefined) return "unknown";
  if (g < GAP_BUCKET_425_MS) return "within425";
  if (g <= GAP_BUCKET_15_MS) return "_425_15";
  if (g <= GAP_BUCKET_45_MS) return "_15_45";
  return "over45";
}

/** 单个探针的成本 = Σ requests[].costUsd（不含 keepalivePingUsd，§4.1）。 */
export function probeCostUsd(probe) {
  const requests = Array.isArray(probe?.requests) ? probe.requests : [];
  let total = 0;
  for (const r of requests) {
    const c = num(r?.costUsd);
    if (c !== undefined) total += c;
  }
  return total;
}

/* --------------------------------------------------------------- parsing --- */

/**
 * 从去重后的 run 集合中提取 `diag.consults.cacheProbes[]`（probe 模式）。
 * 返回扁平数组，每条附 `runId` / `path` / `createdAt`（消费者 run 的 diag.createdAt，
 * 用于时间窗过滤）。畸形探针（非对象 / 缺 expertRunId）计入 `malformed`。
 */
export function extractProbes(chosen) {
  const probes = [];
  let malformed = 0;
  for (const { snapshot, path } of chosen.values()) {
    const createdAt = num(snapshot.diag?.createdAt);
    const runId = snapshot.runId;
    const cacheProbes = snapshot.diag?.consults?.cacheProbes;
    if (!Array.isArray(cacheProbes)) continue;
    for (const probe of cacheProbes) {
      if (!isObject(probe)) {
        malformed++;
        continue;
      }
      probes.push({ probe, runId, path, createdAt });
    }
  }
  return { probes, malformed };
}

/** 消费者 run 实际咨询过的专家 runId 列表（byExpert 的非 `_other` 键，缺失时回退 refs）。 */
export function expertRunIdsOf(snapshot) {
  const byExpert = snapshot.diag?.consults?.byExpert;
  if (isObject(byExpert)) {
    const ids = Object.keys(byExpert).filter((k) => k !== "_other");
    if (ids.length > 0) return ids;
  }
  const refs = snapshot.diag?.experts?.refs;
  if (Array.isArray(refs)) {
    return refs.map((r) => r?.runId).filter((id) => typeof id === "string" && id !== "");
  }
  return [];
}

/**
 * 消费者 run 的「派发时刻」集合：优先取 `absorbedRunIds` 里每个 consult 子 run 的
 * `createdAt`（升序），取不到时回退到消费者自身 `createdAt`（下界代理）。
 */
export function dispatchTimesOf(snapshot, chosen) {
  const absorbed = snapshot.diag?.absorbedRunIds;
  const times = [];
  if (Array.isArray(absorbed)) {
    for (const id of absorbed) {
      if (typeof id !== "string") continue;
      const rec = chosen.get(id);
      const createdAt = num(rec?.snapshot?.diag?.createdAt);
      if (createdAt !== undefined) times.push(createdAt);
    }
  }
  if (times.length > 0) return times.sort((a, b) => a - b);
  const own = num(snapshot.diag?.createdAt);
  return own === undefined ? [] : [own];
}

/** 专家的 settledAt（去重集合里该 runId 的终态条目；无则 undefined）。 */
export function settledAtOf(expertRunId, chosen) {
  const rec = chosen.get(expertRunId);
  return num(rec?.snapshot?.diag?.settledAt);
}

/**
 * retro 模式的间隔重算：对每个 `diag.consults.calls > 0` 的消费者 run，
 * 取它实际咨询的专家（byExpert 键，回退 refs）与该消费者的最早派发时刻，
 * 采样 gap = 派发时刻 − 专家 settledAt（只保留 ≥ 0 的样本；缺失/负值跳过，robust）。
 * 返回 [{ runId, expertRunId, gapSettleMs }]。
 */
export function reconstructGaps(chosen) {
  const gaps = [];
  for (const { snapshot } of chosen.values()) {
    const calls = num(snapshot.diag?.consults?.calls);
    if (calls === undefined || calls <= 0) continue;
    const dispatch = dispatchTimesOf(snapshot, chosen);
    if (dispatch.length === 0) continue;
    const experts = expertRunIdsOf(snapshot);
    for (const expertRunId of experts) {
      const settledAt = settledAtOf(expertRunId, chosen);
      if (settledAt === undefined) continue;
      const gap = dispatch[0] - settledAt;
      if (gap < 0) continue;
      gaps.push({ runId: snapshot.runId, expertRunId, gapSettleMs: gap });
    }
  }
  return gaps;
}

/* -------------------------------------------------------------- analysis --- */

/**
 * 主分析入口。`chosen` 为 `dedupeRuns` 的输出（Map<runId, {snapshot, path}>）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.retro]     true ⇒ retro 模式（重算间隔，无 cacheProbes）
 * @param {number|null} [opts.since]  run 的 diag.createdAt >= since（含）
 * @param {number|null} [opts.until] run 的 diag.createdAt < until（不含，UTC 日界）
 * @param {object}      [opts.scan]  扫描计数（files/runEntries/malformedEntries），原样透传
 */
export function analyzeConsultCache(chosen, opts = {}) {
  const retro = opts.retro === true;
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const scan = opts.scan ?? { files: 0, runEntries: 0, malformedEntries: 0 };

  // 1. 时间窗过滤（按消费者 run 的 diag.createdAt；无 createdAt 只在有窗时丢弃）
  const inWindow = new Map();
  let outOfWindow = 0;
  for (const [runId, rec] of chosen) {
    const createdAt = num(rec.snapshot.diag?.createdAt);
    if (createdAt !== undefined) {
      if (since !== null && createdAt < since) {
        outOfWindow++;
        continue;
      }
      if (until !== null && createdAt >= until) {
        outOfWindow++;
        continue;
      }
    } else if (since !== null || until !== null) {
      outOfWindow++;
      continue;
    }
    inWindow.set(runId, rec);
  }

  // 2. 收集输入（probe 或 retro 间隔）
  let probes = [];
  let probesMalformed = 0;
  let retroGaps = [];
  if (!retro) {
    const extracted = extractProbes(inWindow);
    probes = extracted.probes;
    probesMalformed = extracted.malformed;
  } else {
    retroGaps = reconstructGaps(inWindow);
  }

  // 3. 结局分布（probe：探针 outcome；retro：diag.consults.byResult）
  const byOutcome = {};
  const identityMismatchByReason = {};
  const identityFailures = {};
  const blockedTotals = { calls: 0, batches: 0, terminated: 0, identity: 0, nested: 0, costAfterUsd: 0 };
  const blockedExtras = { disallowedInvalidCalls: 0, unknownToolCalls: 0 };

  if (!retro) {
    for (const { probe } of probes) {
      const outcome = typeof probe.outcome === "string" ? probe.outcome : "unknown";
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
      const reason = preflightReason(probe);
      if (outcome === "identity_mismatch" || reason !== null) {
        const key = reason ?? "unknown";
        identityMismatchByReason[key] = (identityMismatchByReason[key] ?? 0) + 1;
      }
      const blocked = probe.blocked;
      if (isObject(blocked)) {
        blockedTotals.calls += num(blocked.calls) ?? 0;
        blockedTotals.batches += num(blocked.batches) ?? 0;
        blockedTotals.terminated += blocked.terminated === true ? 1 : 0;
        blockedTotals.identity += num(blocked.identity) ?? 0;
        blockedTotals.nested += num(blocked.nested) ?? 0;
        blockedTotals.costAfterUsd += num(blocked.costAfterUsd) ?? 0;
      }
      blockedExtras.disallowedInvalidCalls += num(probe.disallowedInvalidCalls) ?? 0;
      blockedExtras.unknownToolCalls += num(probe.unknownToolCalls) ?? 0;
    }
  } else {
    for (const { snapshot } of inWindow.values()) {
      const byResult = snapshot.diag?.consults?.byResult;
      if (isObject(byResult)) {
        for (const [result, count] of Object.entries(byResult)) {
          const n = num(count) ?? 0;
          byOutcome[result] = (byOutcome[result] ?? 0) + n;
        }
      }
      const failures = snapshot.diag?.consults?.identityFailures;
      if (isObject(failures)) {
        for (const [reason, count] of Object.entries(failures)) {
          identityFailures[reason] = (identityFailures[reason] ?? 0) + (num(count) ?? 0);
        }
      }
      const blockedCalls = num(snapshot.diag?.consults?.blockedCalls);
      if (blockedCalls !== undefined) blockedTotals.calls += blockedCalls;
    }
  }

  // 4. hitRatio 分布（api × preflight × predicted）与未命中个案（仅 probe）
  const hitGroups = new Map();
  const misses = [];
  if (!retro) {
    for (const { probe, runId, expertRunId } of probes) {
      const hit = hitRatioOf(probe);
      const api = typeof probe.api === "string" && probe.api !== "" ? probe.api : "unknown";
      const preflight = preflightState(probe);
      const predicted = predictedSummary(probe).state;
      const key = `${api}\u0000${preflight}\u0000${predicted}`;
      let group = hitGroups.get(key);
      if (group === undefined) {
        group = { api, preflight, predicted, values: [] };
        hitGroups.set(key, group);
      }
      if (hit !== null) group.values.push(hit);

      if (preflight === "pass" && hit !== null && hit < MISS_HIT_RATIO) {
        misses.push({
          runId,
          expertRunId: typeof probe.expertRunId === "string" ? probe.expertRunId : undefined,
          api,
          predicted: predictedSummary(probe),
          hitRatio: hit,
          gapSettleMs: num(probe.gapSettleMs),
          prefixSource: typeof probe.prefixSource === "string" ? probe.prefixSource : undefined,
        });
      }
    }
  }

  const hitGroupsOut = [...hitGroups.values()]
    .map(({ values, ...rest }) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        ...rest,
        n: sorted.length,
        median: median(sorted),
        p90: percentile(sorted, 0.9),
        min: sorted.length > 0 ? sorted[0] : null,
        max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      };
    })
    .sort((a, b) => `${a.api}/${a.preflight}/${a.predicted}`.localeCompare(`${b.api}/${b.preflight}/${b.predicted}`));

  // 5. 逐请求 cacheRead/cacheWrite 与成本（仅 probe）
  const requests = [];
  let coldCostUsd = 0;
  let coldCount = 0;
  let warmCostUsd = 0;
  let warmCount = 0;
  let totalRequestCostUsd = 0;
  let keepalivePingUsd = 0;
  if (!retro) {
    for (const { probe, runId } of probes) {
      const hit = hitRatioOf(probe);
      const cost = probeCostUsd(probe);
      totalRequestCostUsd += cost;
      keepalivePingUsd += num(probe.keepalivePingUsd) ?? 0;
      const cls = hit === null ? "unknown" : hit < MISS_HIT_RATIO ? "cold" : "warm";
      if (cls === "cold") {
        coldCount++;
        coldCostUsd += cost;
      } else if (cls === "warm") {
        warmCount++;
        warmCostUsd += cost;
      }
      const expertRunId = typeof probe.expertRunId === "string" ? probe.expertRunId : undefined;
      const list = Array.isArray(probe.requests) ? probe.requests : [];
      list.forEach((r, index) => {
        requests.push({
          runId,
          expertRunId,
          api: typeof probe.api === "string" && probe.api !== "" ? probe.api : "unknown",
          index,
          input: num(r?.input),
          cacheRead: num(r?.cacheRead),
          cacheWrite: num(r?.cacheWrite),
          output: num(r?.output),
          costUsd: num(r?.costUsd),
          toolsDrift: r?.toolsDrift === true ? true : undefined,
        });
      });
    }
  } else {
    for (const { snapshot } of inWindow.values()) {
      totalRequestCostUsd += num(snapshot.diag?.consults?.costUsd) ?? 0;
    }
  }

  // 6. 间隔分桶
  const gapBuckets = { within425: 0, _425_15: 0, _15_45: 0, over45: 0, unknown: 0 };
  const gapSamples = [];
  if (!retro) {
    for (const { probe, runId } of probes) {
      const gap = num(probe.gapSettleMs);
      gapBuckets[gapBucket(gap)]++;
      if (gap !== undefined) gapSamples.push({ runId, gapSettleMs: gap });
    }
  } else {
    for (const g of retroGaps) {
      gapBuckets[gapBucket(g.gapSettleMs)]++;
      gapSamples.push({ runId: g.runId, gapSettleMs: g.gapSettleMs });
    }
  }

  // 7. §11 保活 go/no-go 四项指标
  const keepalive = computeKeepalive({ probes, retroGaps, totalRequestCostUsd, coldCostUsd, warmCostUsd, retro });

  return {
    mode: retro ? "retro" : "probe",
    window: { since, until },
    scan: { ...scan, uniqueRuns: chosen.size, outOfWindow },
    totals: {
      runs: inWindow.size,
      runsWithProbes: retro ? 0 : new Set(probes.map((p) => p.runId)).size,
      probes: retro ? 0 : probes.length,
      probesMalformed: retro ? 0 : probesMalformed,
      consultCalls: retro
        ? [...inWindow.values()].reduce((a, r) => a + (num(r.snapshot.diag?.consults?.calls) ?? 0), 0)
        : 0,
    },
    outcomes: {
      byOutcome,
      identityMismatchByReason: retro ? identityFailures : identityMismatchByReason,
    },
    hitRatio: {
      groups: hitGroupsOut,
      misses,
    },
    requests,
    gaps: { buckets: gapBuckets, samples: gapSamples },
    cost: {
      cold: retro ? null : { n: coldCount, costUsd: coldCostUsd },
      warm: retro ? null : { n: warmCount, costUsd: warmCostUsd },
      totalConsultCostUsd: totalRequestCostUsd,
      keepalivePingUsd: retro ? 0 : keepalivePingUsd,
    },
    blocked: {
      ...blockedTotals,
      disallowedInvalidCalls: retro ? 0 : blockedExtras.disallowedInvalidCalls,
      unknownToolCalls: retro ? 0 : blockedExtras.unknownToolCalls,
    },
    keepalive,
  };
}

/* -------------------------------------------------------------- keepalive --- */

function hasGap(probe) {
  return num(probe?.gapSettleMs) !== undefined;
}

function preflightPassed(probe) {
  return preflightState(probe) === "pass";
}

/**
 * §11 四项 go/no-go 条件（见上方常量注释）。probe 模式下 c2Effective/可寻址均要求
 * 预检通过；retro 模式下没有 hitRatio / preflight，c2Effective 恒为 null，可寻址按
 * 「预检通过」未知处理（报告上界并注明）。
 */
function computeKeepalive({ probes, retroGaps, totalRequestCostUsd, coldCostUsd, warmCostUsd, retro }) {
  if (retro) {
    const gaps = retroGaps.map((g) => g.gapSettleMs);
    const n = gaps.length;
    const within425 = gaps.filter((g) => g <= GO_RENEWABLE_MAX_GAP_MS).length;
    const addressable = gaps.filter((g) => g > GO_ADDRESSABLE_GAP_LO_MS && g <= GO_ADDRESSABLE_GAP_HI_MS).length;
    return {
      c2Effective: null,
      renewable: {
        n,
        nWithin425: within425,
        share: n > 0 ? within425 / n : null,
        pass: n > 0 ? within425 / n >= GO_RENEWABLE_MIN_SHARE : null,
      },
      addressable: {
        n,
        nAddressable: addressable,
        share: n > 0 ? addressable / n : null,
        pass: n > 0 ? addressable / n >= GO_ADDRESSABLE_MIN_SHARE : null,
        note: "retro: preflight-pass is unknown — share is an upper bound (no cacheProbes in historical data)",
      },
      economics: {
        totalConsultCostUsd: totalRequestCostUsd,
        note: "net savings needs a route/pricing/usage replay; gate is >= 20% of total AND >= $2/week",
      },
    };
  }

  const flat = probes.map((p) => p.probe);
  const c2 = [];
  for (const probe of flat) {
    const gap = num(probe.gapSettleMs);
    const hit = hitRatioOf(probe);
    if (preflightPassed(probe) && hit !== null && gap !== undefined && gap <= GO_C2_EFFECTIVE_MAX_GAP_MS) {
      c2.push(hit);
    }
  }
  const c2Sorted = c2.slice().sort((a, b) => a - b);
  const c2Median = median(c2Sorted);

  const n = flat.length;
  const within425 = flat.filter((p) => hasGap(p) && p.gapSettleMs <= GO_RENEWABLE_MAX_GAP_MS).length;
  const withGap = flat.filter((p) => hasGap(p)).length;
  const addressable = flat.filter(
    (p) =>
      preflightPassed(p) &&
      hasGap(p) &&
      p.gapSettleMs > GO_ADDRESSABLE_GAP_LO_MS &&
      p.gapSettleMs <= GO_ADDRESSABLE_GAP_HI_MS,
  ).length;
  const preflightPassCount = flat.filter((p) => preflightPassed(p)).length;

  return {
    c2Effective: {
      n: c2.length,
      hitRatioMedian: c2Median,
      pass: c2.length > 0 ? c2Median >= GO_C2_EFFECTIVE_MIN_HIT : null,
    },
    renewable: {
      n: withGap,
      nWithin425: within425,
      share: withGap > 0 ? within425 / withGap : null,
      pass: withGap > 0 ? within425 / withGap >= GO_RENEWABLE_MIN_SHARE : null,
    },
    addressable: {
      n: preflightPassCount,
      nAddressable: addressable,
      share: preflightPassCount > 0 ? addressable / preflightPassCount : null,
      pass: preflightPassCount > 0 ? addressable / preflightPassCount >= GO_ADDRESSABLE_MIN_SHARE : null,
    },
    economics: {
      totalConsultCostUsd: totalRequestCostUsd,
      coldCostUsd,
      warmCostUsd,
      potentialColdSavingsUsd: coldCostUsd,
      note: `net savings needs a route/pricing/usage replay; gate is >= ${(GO_NET_MIN_SHARE * 100).toFixed(0)}% of total AND >= $${GO_NET_MIN_WEEKLY_USD}/week`,
    },
    eligibility: {
      minWeeks: 4,
      minAnthropicConsults: MIN_CONSULTS_ANTHROPIC,
      anthropicConsultCount: flat.filter((p) => (typeof p.api === "string" ? p.api : "").startsWith("anthropic"))
        .length,
      note: "keepalive project requires >= 4 weeks live AND >= 30 Anthropic-routed consults",
    },
  };
}

/* ---------------------------------------------------------------- report --- */

function pct(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value) {
  return value === null || value === undefined ? "—" : `$${value.toFixed(3)}`;
}

function ms(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value)}`;
}

function bucketLabel(key) {
  return { within425: "<4.25m", _425_15: "4.25–15m", _15_45: "15–45m", over45: ">45m", unknown: "unknown" }[key] ?? key;
}

function passMark(value) {
  if (value === null || value === undefined) return "n/a";
  return value ? "PASS" : "FAIL";
}

/** 人类可读报告（英文 token，遵守仓库 UI 语言约定；中文只出现在注释里）。 */
export function renderReport(analysis) {
  const lines = [];
  const w = analysis.window;
  lines.push(`consult cache analysis (${analysis.mode})`);
  lines.push(
    `  scan: ${analysis.scan.files} file(s), ${analysis.scan.runEntries} run entries, ` +
      `${analysis.scan.uniqueRuns} unique runs` +
      (analysis.scan.malformedEntries > 0 ? `, ${analysis.scan.malformedEntries} malformed skipped` : "") +
      (analysis.scan.outOfWindow > 0 ? `, ${analysis.scan.outOfWindow} out of window` : ""),
  );
  lines.push(
    `  window: ${w.since === null && w.until === null ? "all time" : `${w.since === null ? "…" : new Date(w.since).toISOString()} .. ${w.until === null ? "…" : new Date(w.until).toISOString()} (exclusive)`}`,
  );
  if (analysis.mode === "probe") {
    lines.push(
      `  runs: ${analysis.totals.runs} in window · ${analysis.totals.runsWithProbes} with probes · ` +
        `${analysis.totals.probes} probes${analysis.totals.probesMalformed > 0 ? ` (${analysis.totals.probesMalformed} malformed)` : ""}`,
    );
  } else {
    lines.push(
      `  runs: ${analysis.totals.runs} in window · ${analysis.totals.consultCalls} consult calls (retro reconstruction)`,
    );
  }
  lines.push("");

  lines.push("outcomes:");
  if (Object.keys(analysis.outcomes.byOutcome).length === 0) {
    lines.push("  (none)");
  } else {
    for (const [outcome, count] of Object.entries(analysis.outcomes.byOutcome).sort()) {
      lines.push(`  ${outcome}: ${count}`);
    }
  }
  const identityMismatch = analysis.outcomes.identityMismatchByReason ?? {};
  if (Object.keys(identityMismatch).length > 0) {
    lines.push(`  identity_mismatch by reason code:`);
    for (const [reason, count] of Object.entries(identityMismatch).sort()) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  lines.push("");

  if (analysis.mode === "probe") {
    lines.push(`hitRatio by api × preflight × predicted (${analysis.hitRatio.groups.length} groups):`);
    if (analysis.hitRatio.groups.length === 0) {
      lines.push("  (none)");
    } else {
      for (const g of analysis.hitRatio.groups) {
        lines.push(
          `  ${g.api} / ${g.preflight} / ${g.predicted}: n=${g.n} median ${g.median === null ? "—" : g.median.toFixed(3)} p90 ${g.p90 === null ? "—" : g.p90.toFixed(3)}`,
        );
      }
    }
    lines.push(`  preflight-passed but hitRatio < ${MISS_HIT_RATIO} (${analysis.hitRatio.misses.length} cases):`);
    if (analysis.hitRatio.misses.length === 0) {
      lines.push("    (none)");
    } else {
      for (const m of analysis.hitRatio.misses) {
        lines.push(
          `    ${m.runId} expert=${m.expertRunId ?? "—"} api=${m.api} predicted=${m.predicted.state} hitRatio=${m.hitRatio.toFixed(3)} gap=${ms(m.gapSettleMs)}ms`,
        );
      }
    }
    lines.push("");

    lines.push(`per-request cacheRead/cacheWrite (${analysis.requests.length} requests):`);
    if (analysis.requests.length === 0) {
      lines.push("  (none)");
    } else {
      for (const r of analysis.requests) {
        lines.push(
          `  ${r.runId} req#${r.index} read=${r.cacheRead ?? "—"} write=${r.cacheWrite ?? "—"} out=${r.output ?? "—"} cost=${usd(r.costUsd)}${r.toolsDrift ? " toolsDrift" : ""}`,
        );
      }
    }
    lines.push("");
  }

  lines.push(`interval buckets:`);
  for (const [key, count] of Object.entries(analysis.gaps.buckets)) {
    lines.push(`  ${bucketLabel(key)}: ${count}`);
  }
  lines.push("");

  if (analysis.cost.cold !== null) {
    lines.push(
      `cost: cold ${analysis.cost.cold.n}/${usd(analysis.cost.cold.costUsd)} · warm ${analysis.cost.warm.n}/${usd(analysis.cost.warm.costUsd)}`,
    );
  }
  lines.push(
    `  total consult cost ${usd(analysis.cost.totalConsultCostUsd)} · keepalive ping ${usd(analysis.cost.keepalivePingUsd)}`,
  );
  lines.push("");

  lines.push(
    `blocked calls ${analysis.blocked.calls} · batches ${analysis.blocked.batches} · terminated ${analysis.blocked.terminated} · identity ${analysis.blocked.identity} · nested ${analysis.blocked.nested}`,
  );
  lines.push(
    `  costAfterUsd ${usd(analysis.blocked.costAfterUsd)} · disallowedInvalid ${analysis.blocked.disallowedInvalidCalls} · unknownTool ${analysis.blocked.unknownToolCalls}`,
  );
  lines.push("");

  const ka = analysis.keepalive;
  lines.push("keepalive go/no-go (§11):");
  if (ka.c2Effective === null) {
    lines.push("  C2 effective:      n/a (requires cacheProbes; not available in retro mode)");
  } else {
    lines.push(
      `  C2 effective:      ${passMark(ka.c2Effective.pass)}  median hitRatio ${ka.c2Effective.hitRatioMedian === null ? "—" : ka.c2Effective.hitRatioMedian.toFixed(3)} (n=${ka.c2Effective.n}, preflight pass & gapSettleMs<=4min)`,
    );
  }
  lines.push(
    `  renewable:         ${passMark(ka.renewable.pass)}  gap<=4.25m share ${pct(ka.renewable.share)} (${ka.renewable.nWithin425}/${ka.renewable.n})`,
  );
  lines.push(
    `  addressable:       ${passMark(ka.addressable.pass)}  gap in (4.25m,45m] & preflight-pass share ${pct(ka.addressable.share)} (${ka.addressable.nAddressable}/${ka.addressable.n})`,
  );
  if (ka.addressable.note) lines.push(`    (${ka.addressable.note})`);
  lines.push(`  economics:         total consult cost ${usd(ka.economics.totalConsultCostUsd)} — ${ka.economics.note}`);
  if (ka.eligibility) {
    lines.push(
      `  eligibility:       >= ${ka.eligibility.minWeeks} weeks live AND >= ${ka.eligibility.minAnthropicConsults} Anthropic consults (now ${ka.eligibility.anthropicConsultCount})`,
    );
  }
  return lines.join("\n");
}

export { parseDayUtc, parseSessionText, dedupeRuns, mean, median, percentile, RUN_CUSTOM_TYPE, TERMINAL_STATUSES };
