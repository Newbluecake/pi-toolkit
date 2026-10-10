#!/usr/bin/env node
/**
 * consult A/B 实验 — 纯函数库（docs/dev/consult/ab-instrumentation-plan.md §5 P3）。
 *
 * 供 `consult-ab-arm.mjs` / `consult-ab-analyze.mjs` 和 `tests/exp/*.test.ts` 共用。
 * 不 import src/（只读持久化的 `subagent:run` JSONL 形状），除 node:crypto 外无任何依赖。
 *
 * 冻结规则（§5 P3 / §8 评审处置）：
 *  - 臂 = sha256(salt + "\0" + packageId) 首字节最低位，1 ⇒ experts；
 *  - runId 全局去重：有终态条目时只在终态里选，然后 updatedAt 最大者胜，
 *    相等时后扫到的胜出（复刻 seed 的 `>=` 语义；文件按路径排序、文件内按行序）；
 *  - 角色：diag.agentType ∈ work-types ⇒ work，"verifier" ⇒ verify，其余 other；
 *  - 三类协议违例：no-granted-experts / control-has-experts / verifier-has-experts；
 *  - partial-unenrolled：缺 packageId 的 work/verify run 与包内同角色 run 共享
 *    diag.sessionFile ⇒ 整包排除（阈值 1）；
 *  - absorbedRunIds FIFO cap 100：只打 absorbed-cap-hit 警告，不排除。
 */
import { createHash } from "node:crypto";

export const DEFAULT_SALT = "consult-ab-v1";
export const RUN_CUSTOM_TYPE = "subagent:run";
export const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "aborted"]);
/** 与 src/core/state-machine.ts 的 ABSORBED_RUN_IDS_CAP 对齐（本文件不 import src）。 */
export const ABSORBED_RUN_IDS_CAP = 100;
export const VERDICT_PRESET = "verdict/v1";
export const VERIFY_AGENT_TYPE = "verifier";
export const DEFAULT_WORK_TYPES = ["general", "frontend-dev"];
/** eval-2026-10 §6.3：检测 15pp 首验通过率差异约需每臂 150 个包。 */
export const POWER_MIN_PER_ARM = 150;
/** §2 冻结的 packageId / feature 共用格式（与 parseDispatchMeta 同源）。 */
export const DISPATCH_META_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/;

/* ------------------------------------------------------------------ arm ---- */

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 确定性抽签：sha256(salt + "\0" + packageId) 首字节的最低位，1 ⇒ experts。
 * 同一个 (packageId, salt) 恒定同一臂，事后可复算。
 */
export function armFor(packageId, salt = DEFAULT_SALT) {
  const digest = sha256Hex(`${salt}\0${packageId}`);
  return Number.parseInt(digest.slice(0, 2), 16) & 1 ? "experts" : "control";
}

/* --------------------------------------------------------------- parsing --- */

/**
 * 解析一段 session JSONL 文本，按行序返回其中的 `subagent:run` 快照。
 * 非 JSON 行、非 subagent:run 的 custom 条目一律忽略；customType 命中但形状
 * 畸形（缺 runId / updatedAt / diag，复刻 seed 的防御口径）的计进 malformed。
 */
export function parseSessionText(text) {
  const snapshots = [];
  let malformed = 0;
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 非 JSON 内容（其他条目 / 截断行）与本分析无关
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type !== "custom" || entry.customType !== RUN_CUSTOM_TYPE) continue;
    const snapshot = entry.data;
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      typeof snapshot.runId !== "string" ||
      snapshot.runId === "" ||
      typeof snapshot.updatedAt !== "number" ||
      snapshot.diag === null ||
      typeof snapshot.diag !== "object"
    ) {
      malformed++;
      continue;
    }
    snapshots.push(snapshot);
  }
  return { snapshots, malformed };
}

/**
 * runId 全局去重（§5 P3 第 1 步）。`files` 是 [{path, snapshots}]，必须已按
 * path 排序、snapshots 保持行序 —— 扫描顺序即裁决顺序：
 *  1. 有任何终态条目 ⇒ 只在终态条目里选，否则在非终态（journal）条目里选；
 *  2. 同桶内 updatedAt 最大者胜；相等时后扫到的胜出（`>=`，复刻 seed：
 *     X10 的 post-policy 条目写在首条终态之后，平局时它胜出）。
 * 返回 Map<runId, {snapshot, path}>（path = 选中条目所在文件，用于覆盖率提示）。
 */
export function dedupeRuns(files) {
  const terminal = new Map();
  const journal = new Map();
  const origin = new Map();
  for (const file of files) {
    for (const snapshot of file.snapshots) {
      const bucket = TERMINAL_STATUSES.has(snapshot.status) ? terminal : journal;
      const prev = bucket.get(snapshot.runId);
      if (prev === undefined || snapshot.updatedAt >= prev.updatedAt) {
        bucket.set(snapshot.runId, snapshot);
        origin.set(snapshot.runId, file.path);
      }
    }
  }
  const chosen = new Map();
  for (const runId of new Set([...terminal.keys(), ...journal.keys()])) {
    const snapshot = terminal.get(runId) ?? journal.get(runId);
    if (snapshot !== undefined) chosen.set(runId, { snapshot, path: origin.get(runId) });
  }
  return chosen;
}

/* ------------------------------------------------------------------ stats -- */

const Z95 = 1.959963984540054;

/** Wilson score interval (95%) for a binomial proportion. */
export function wilsonInterval(k, n) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Abramowitz–Stegun 7.1.26 erf approximation (|err| ≤ 1.5e-7). */
function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

export function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

/** Pooled two-proportion z-test (two-sided p-value). */
export function twoProportionZTest(k1, n1, k2, n2) {
  if (!Number.isFinite(k1) || !Number.isFinite(k2) || n1 <= 0 || n2 <= 0) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Linear-interpolation percentile (numpy "type 7") on an already-sorted array. */
export function percentile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

export function median(sortedValues) {
  return percentile(sortedValues, 0.5);
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* ----------------------------------------------------------------- roles --- */

/** §5 P3 2a（硬规则）：verifier 恒为 verify，work-types 命中为 work，其余 other。 */
export function roleOf(agentType, workTypes = DEFAULT_WORK_TYPES) {
  if (agentType === VERIFY_AGENT_TYPE) return "verify";
  if (typeof agentType === "string" && workTypes.includes(agentType)) return "work";
  return "other";
}

/* -------------------------------------------------------------- analysis --- */

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyRefs(experts) {
  return experts !== null && typeof experts === "object" && Array.isArray(experts.refs) && experts.refs.length > 0;
}

/**
 * 主分析入口。
 *
 * @param {Map<string, {snapshot: object, path: string}>} chosen  dedupeRuns 的输出
 * @param {object} [opts]
 * @param {string[]} [opts.workTypes]     默认 ["general","frontend-dev"]
 * @param {string|null}  [opts.salt]      给定 ⇒ 核对每包 abArm 与哈希（hash-mismatch）
 * @param {number|null}  [opts.since]     createdAt >= since（含）
 * @param {number|null}  [opts.until]     createdAt < until（不含；UTC 日界）
 * @param {object}       [opts.scan]      扫描计数（files/runEntries/malformed…），原样透传
 */
export function analyzeRuns(chosen, opts = {}) {
  const workTypes = opts.workTypes ?? DEFAULT_WORK_TYPES;
  const salt = opts.salt ?? null;
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const scan = opts.scan ?? { files: 0, runEntries: 0, malformedEntries: 0 };

  // 1. 时间窗过滤（按 diag.createdAt；无 createdAt 的 run 只在有窗时丢弃）
  const records = [];
  let outOfWindow = 0;
  for (const { snapshot, path } of chosen.values()) {
    const createdAt = num(snapshot.diag?.createdAt);
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
    records.push({ snapshot, path, role: roleOf(snapshot.diag?.agentType, workTypes) });
  }

  // 2. 全局 absorbed 集合：出现在任何 run 的 absorbedRunIds 里 ⇒ 该 run 不计成本
  const absorbed = new Set();
  for (const { snapshot } of records) {
    const ids = snapshot.diag?.absorbedRunIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") absorbed.add(id);
  }

  // 3. 入组 / 未入组
  const enrolled = [];
  const unenrolled = [];
  for (const record of records) {
    const packageId = record.snapshot.diag?.dispatchMeta?.packageId;
    if (typeof packageId === "string" && packageId !== "") {
      record.packageId = packageId;
      enrolled.push(record);
    } else {
      unenrolled.push(record);
    }
  }

  // 4. partial-unenrolled 连接键：缺 meta 的 work/verify run 按 sessionFile 索引
  const unenrolledBySessionFile = new Map();
  for (const record of unenrolled) {
    if (record.role === "other") continue;
    const sessionFile = record.snapshot.diag?.sessionFile;
    if (typeof sessionFile !== "string" || sessionFile === "") continue;
    const bucket = unenrolledBySessionFile.get(sessionFile) ?? [];
    bucket.push({ runId: record.snapshot.runId, role: record.role });
    unenrolledBySessionFile.set(sessionFile, bucket);
  }

  // 5. 按包分组并逐包评估
  const byPackage = new Map();
  for (const record of enrolled) {
    const pkg = byPackage.get(record.packageId) ?? { packageId: record.packageId, records: [] };
    pkg.records.push(record);
    byPackage.set(record.packageId, pkg);
  }

  const packages = [];
  const excluded = [];
  const warnings = [];
  for (const pkg of byPackage.values()) {
    const recordsSorted = [...pkg.records].sort(compareRecords);
    const detail = evaluatePackage(pkg.packageId, recordsSorted, unenrolledBySessionFile, absorbed, salt);
    if (detail.excluded) {
      excluded.push({
        packageId: pkg.packageId,
        reasons: detail.reasons,
        runIds: [...detail.offending].sort(),
        detail: detail.exclusionDetail,
      });
    } else {
      packages.push(detail.summary);
    }
    for (const warning of detail.warnings) warnings.push({ packageId: pkg.packageId, ...warning });
  }
  packages.sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));
  excluded.sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));

  // 6. 分臂聚合 + 车道分层
  const armStats = {};
  for (const arm of ["experts", "control"]) {
    armStats[arm] = summarizeArm(packages.filter((p) => p.arm === arm));
  }

  // 7. 两臂对比（experts − control）
  const comparison = {
    firstPass: compareRates(armStats.experts.firstPass, armStats.control.firstPass),
    firstPassOrCond: compareRates(armStats.experts.firstPassOrCond, armStats.control.firstPassOrCond),
  };

  // 8. 覆盖率提示：按主会话文件统计窗内没有 meta 的 work run 数（只提示，不排除）
  const coverageByFile = new Map();
  for (const record of unenrolled) {
    if (record.role !== "work") continue;
    const bucket = coverageByFile.get(record.path) ?? { file: record.path, workRuns: 0, workRunsWithoutMeta: 0 };
    bucket.workRunsWithoutMeta++;
    coverageByFile.set(record.path, bucket);
  }
  for (const record of enrolled) {
    if (record.role !== "work") continue;
    const bucket = coverageByFile.get(record.path) ?? { file: record.path, workRuns: 0, workRunsWithoutMeta: 0 };
    bucket.workRuns++;
    coverageByFile.set(record.path, bucket);
  }
  const coverage = [...coverageByFile.values()]
    .filter((c) => c.workRunsWithoutMeta > 0)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // 9. 功效提示（eval §6.3：每臂 150 包才能看 15pp）
  const nVerdictMin = Math.min(armStats.experts.nVerdict, armStats.control.nVerdict);
  const powerHint =
    nVerdictMin < POWER_MIN_PER_ARM
      ? `per-arm packages with verdicts below ${POWER_MIN_PER_ARM} ` +
        `(experts ${armStats.experts.nVerdict}, control ${armStats.control.nVerdict}) — ` +
        `underpowered to detect a 15pp first-pass difference (eval 2026-10 §6.3)`
      : null;

  return {
    salt,
    window: { since, until },
    workTypes: [...workTypes],
    scan: { ...scan, uniqueRuns: chosen.size, outOfWindow },
    totals: {
      runs: records.length,
      enrolledRuns: enrolled.length,
      unenrolledRuns: unenrolled.length,
      packages: byPackage.size,
      excludedPackages: excluded.length,
      analyzedPackages: packages.length,
    },
    arms: armStats,
    comparison,
    packages,
    excluded,
    warnings,
    coverage,
    powerHint,
  };
}

function compareRecords(a, b) {
  const ca = num(a.snapshot.diag?.createdAt) ?? Number.POSITIVE_INFINITY;
  const cb = num(b.snapshot.diag?.createdAt) ?? Number.POSITIVE_INFINITY;
  if (ca !== cb) return ca - cb;
  return a.snapshot.runId < b.snapshot.runId ? -1 : a.snapshot.runId > b.snapshot.runId ? 1 : 0;
}

function evaluatePackage(packageId, records, unenrolledBySessionFile, absorbed, salt) {
  const work = records.filter((r) => r.role === "work");
  const verify = records.filter((r) => r.role === "verify");
  const other = records.filter((r) => r.role === "other");
  const reasons = [];
  const offending = new Set();
  const warnings = [];
  let exclusionDetail = null;

  // partial-unenrolled（阈值 1）：缺 meta 的同角色 run 与包内 run 共享 sessionFile
  const linkedRunIds = new Set();
  for (const role of ["work", "verify"]) {
    const sessionFiles = new Set(
      (role === "work" ? work : verify)
        .map((r) => r.snapshot.diag?.sessionFile)
        .filter((v) => typeof v === "string" && v !== ""),
    );
    if (sessionFiles.size === 0) continue;
    for (const [sessionFile, items] of unenrolledBySessionFile) {
      if (!sessionFiles.has(sessionFile)) continue;
      for (const item of items) if (item.role === role) linkedRunIds.add(item.runId);
    }
  }
  if (linkedRunIds.size > 0) {
    reasons.push("partial-unenrolled");
    for (const runId of linkedRunIds) offending.add(runId);
    exclusionDetail =
      `${linkedRunIds.size} work/verify run(s) without dispatchMeta.packageId share diag.sessionFile ` +
      `with this package's same-role run(s) (threshold 1)`;
  }

  // 臂：包内 run 的 abArm 必须唯一且可知，否则 mixed-arm
  const armValues = new Set(
    records.map((r) => r.snapshot.diag?.dispatchMeta?.abArm).filter((v) => v === "experts" || v === "control"),
  );
  const arm = armValues.size === 1 ? [...armValues][0] : null;
  if (arm === null) {
    reasons.push("mixed-arm");
    exclusionDetail =
      armValues.size === 0
        ? "no run in this package declares meta.abArm"
        : `runs declare both arms: ${[...armValues].sort().join(" + ")}`;
    for (const r of records) {
      const declared = r.snapshot.diag?.dispatchMeta?.abArm;
      if (declared === "experts" || declared === "control") offending.add(r.snapshot.runId);
    }
  }

  // 带 --salt 时核对哈希（需要臂已确定）
  if (salt !== null && arm !== null && armFor(packageId, salt) !== arm) {
    reasons.push("hash-mismatch");
    exclusionDetail = `declared arm ${arm} but ${salt} hash draws ${armFor(packageId, salt)}`;
    for (const r of records) offending.add(r.snapshot.runId);
  }

  // 三类协议违例（只看 work / verify run；other 只计成本）
  if (arm === "experts" && !work.some((r) => r.snapshot.diag?.experts?.granted === true)) {
    reasons.push("no-granted-experts");
    for (const r of work) offending.add(r.snapshot.runId);
  }
  if (arm === "control") {
    for (const r of work) {
      if (nonEmptyRefs(r.snapshot.diag?.experts)) {
        reasons.push("control-has-experts");
        offending.add(r.snapshot.runId);
      }
    }
  }
  for (const r of verify) {
    if (nonEmptyRefs(r.snapshot.diag?.experts)) {
      reasons.push("verifier-has-experts");
      offending.add(r.snapshot.runId);
    }
  }

  // absorbedRunIds FIFO cap 100：只警告，不排除
  for (const r of records) {
    const ids = r.snapshot.diag?.absorbedRunIds;
    if (Array.isArray(ids) && ids.length >= ABSORBED_RUN_IDS_CAP) {
      warnings.push({
        kind: "absorbed-cap-hit",
        runIds: [r.snapshot.runId],
        detail:
          `run ${r.snapshot.runId} lists ${ids.length} absorbedRunIds (FIFO cap ` +
          `${ABSORBED_RUN_IDS_CAP}) — oldest ids were evicted and their cost is double-counted`,
      });
    }
  }

  // verdict 序列：schemaPreset=verdict/v1 且 completed 的 verifier run，按 createdAt 排序
  const verdicts = [];
  for (const r of verify) {
    if (r.snapshot.diag?.schemaPreset !== VERDICT_PRESET) continue;
    if (r.snapshot.status !== "completed") continue;
    const structured = r.snapshot.outcome?.structuredResult;
    const verdict = structured?.verdict;
    if (verdict !== "pass" && verdict !== "conditional_pass" && verdict !== "reject") {
      warnings.push({
        kind: "verdict-missing",
        runIds: [r.snapshot.runId],
        detail: `verifier run completed with schemaPreset ${VERDICT_PRESET} but carries no structuredResult.verdict`,
      });
      continue;
    }
    const blockers = structured.blockers;
    const findings = Array.isArray(structured.findings) ? structured.findings : [];
    const blockerFindings = findings.filter(
      (f) => f !== null && typeof f === "object" && f.severity === "blocker",
    ).length;
    const consistent = blockers === blockerFindings;
    if (!consistent) {
      warnings.push({
        kind: "verdictInconsistent",
        runIds: [r.snapshot.runId],
        detail: `blockers=${blockers} but ${blockerFindings} finding(s) carry severity=blocker`,
      });
    }
    verdicts.push({
      runId: r.snapshot.runId,
      verdict,
      blockers: typeof blockers === "number" ? blockers : null,
      findings: findings.length,
      blockerFindings,
      consistent,
    });
  }

  const first = verdicts.length > 0 ? verdicts[0].verdict : null;
  let reworkRounds = null;
  let censored = true;
  let rejects = 0;
  for (const v of verdicts) {
    if (v.verdict === "reject") rejects++;
    else {
      reworkRounds = rejects;
      censored = false;
      break;
    }
  }

  // 成本：跳过被吸收的 run（其花费已计入吸收方）
  let costUsd = 0;
  let absorbedCostSkipped = 0;
  for (const r of records) {
    if (absorbed.has(r.snapshot.runId)) {
      absorbedCostSkipped++;
      continue;
    }
    costUsd += num(r.snapshot.diag?.usage?.costUsd) ?? 0;
  }

  // 墙钟：有 settledAt 的 run 中最大 settledAt − 全部 run 中最小 createdAt；全缺 ⇒ null
  const settledAts = records.map((r) => num(r.snapshot.diag?.settledAt)).filter((v) => v !== undefined);
  const createdAts = records.map((r) => num(r.snapshot.diag?.createdAt)).filter((v) => v !== undefined);
  const wallMs =
    settledAts.length > 0 && createdAts.length > 0 ? Math.max(...settledAts) - Math.min(...createdAts) : null;

  // consult 汇总：failed = 各 run 的 (calls − byResult.completed) 之和（即未圆满完成的调用，
  // 含 bad_ref/invalid/unknown；取负防御为 0）
  let calls = 0;
  let consultCostUsd = 0;
  let consultFailed = 0;
  for (const r of records) {
    const consults = r.snapshot.diag?.consults;
    if (consults === null || typeof consults !== "object") continue;
    const runCalls = num(consults.calls) ?? 0;
    const completed = num(consults.byResult?.completed) ?? 0;
    calls += runCalls;
    consultCostUsd += num(consults.costUsd) ?? 0;
    consultFailed += Math.max(0, runCalls - completed);
  }

  const laneRecord = records.find((r) => {
    const lane = r.snapshot.diag?.dispatchMeta?.lane;
    return lane === "L0" || lane === "L1" || lane === "L2" || lane === "L3";
  });

  const summary = {
    packageId,
    arm,
    lane: laneRecord?.snapshot.diag?.dispatchMeta?.lane ?? "?",
    runIds: records.map((r) => r.snapshot.runId).sort(),
    roles: { work: work.length, verify: verify.length, other: other.length },
    verdicts,
    firstPass: first === null ? null : first === "pass",
    firstPassOrCond: first === null ? null : first === "pass" || first === "conditional_pass",
    reworkRounds,
    censored,
    costUsd,
    absorbedCostSkipped,
    wallMs,
    consult: { calls, costUsd: consultCostUsd, failed: consultFailed },
  };
  return { summary, excluded: reasons.length > 0, reasons, offending, exclusionDetail, warnings };
}

function summarizeArm(pkgs) {
  const n = pkgs.length;
  const withVerdict = pkgs.filter((p) => p.firstPass !== null);
  const firstPassK = withVerdict.filter((p) => p.firstPass === true).length;
  const firstPassOrCondK = withVerdict.filter((p) => p.firstPassOrCond === true).length;
  const reworkValues = pkgs
    .filter((p) => p.reworkRounds !== null)
    .map((p) => p.reworkRounds)
    .sort((a, b) => a - b);
  const costValues = pkgs.map((p) => p.costUsd).sort((a, b) => a - b);
  const wallValues = pkgs
    .filter((p) => p.wallMs !== null)
    .map((p) => p.wallMs)
    .sort((a, b) => a - b);
  const consultUsed = pkgs.filter((p) => p.consult.calls > 0).length;

  const byLane = new Map();
  for (const p of pkgs) {
    const lane = byLane.get(p.lane) ?? { lane: p.lane, n: 0, nVerdict: 0, firstPassK: 0, costMedian: null, costs: [] };
    lane.n++;
    if (p.firstPass !== null) {
      lane.nVerdict++;
      if (p.firstPass === true) lane.firstPassK++;
    }
    lane.costs.push(p.costUsd);
    byLane.set(p.lane, lane);
  }

  return {
    n,
    nVerdict: withVerdict.length,
    firstPass: {
      k: firstPassK,
      n: withVerdict.length,
      rate: withVerdict.length > 0 ? firstPassK / withVerdict.length : null,
      ci95: wilsonInterval(firstPassK, withVerdict.length),
    },
    firstPassOrCond: {
      k: firstPassOrCondK,
      n: withVerdict.length,
      rate: withVerdict.length > 0 ? firstPassOrCondK / withVerdict.length : null,
    },
    rework: {
      n: reworkValues.length,
      mean: mean(reworkValues),
      median: median(reworkValues),
      censored: pkgs.length - reworkValues.length,
    },
    cost: {
      n: costValues.length,
      median: median(costValues),
      p90: percentile(costValues, 0.9),
      total: costValues.reduce((a, b) => a + b, 0),
    },
    wallMs: {
      n: wallValues.length,
      median: median(wallValues),
      p90: percentile(wallValues, 0.9),
      nullCount: pkgs.length - wallValues.length,
    },
    consult: {
      calls: pkgs.reduce((a, p) => a + p.consult.calls, 0),
      costUsd: pkgs.reduce((a, p) => a + p.consult.costUsd, 0),
      failed: pkgs.reduce((a, p) => a + p.consult.failed, 0),
    },
    consultUsed: { packages: consultUsed, of: n, fraction: n > 0 ? consultUsed / n : null },
    byLane: [...byLane.values()]
      .map(({ costs, ...lane }) => ({ ...lane, costMedian: median(costs.sort((a, b) => a - b)) }))
      .sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)),
  };
}

function compareRates(a, b) {
  if (a === null || b === null || a.n === 0 || b.n === 0) return null;
  return {
    diff: a.rate - b.rate,
    z: null,
    p: null,
    ...(twoProportionZTest(a.k, a.n, b.k, b.n) ?? {}),
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

function pp(value) {
  return value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function pValue(value) {
  if (value === null || value === undefined) return "—";
  return value < 0.0001 ? "<0.0001" : value.toFixed(4);
}

/** 人类可读报告（英文 token，遵守仓库 UI 语言约定；中文只出现在注释里）。 */
export function renderReport(analysis) {
  const lines = [];
  const w = analysis.window;
  lines.push("consult A/B analysis");
  lines.push(
    `  scan: ${analysis.scan.files} file(s), ${analysis.scan.runEntries} run entries, ` +
      `${analysis.scan.uniqueRuns} unique runs` +
      (analysis.scan.malformedEntries > 0 ? `, ${analysis.scan.malformedEntries} malformed skipped` : "") +
      (analysis.scan.outOfWindow > 0 ? `, ${analysis.scan.outOfWindow} out of window` : ""),
  );
  lines.push(
    `  window: ${w.since === null && w.until === null ? "all time" : `${w.since === null ? "…" : new Date(w.since).toISOString()} .. ${w.until === null ? "…" : new Date(w.until).toISOString()} (exclusive)`}`,
  );
  lines.push(
    `  salt: ${analysis.salt === null ? "not verified (pass --salt to check declared arms)" : `${analysis.salt} (declared arms verified against hash)`}`,
  );
  lines.push(`  work types: ${analysis.workTypes.join(",")} · verify type: ${VERIFY_AGENT_TYPE}`);
  lines.push(
    `  runs: ${analysis.totals.runs} (${analysis.totals.enrolledRuns} enrolled, ` +
      `${analysis.totals.unenrolledRuns} unenrolled) · packages: ${analysis.totals.analyzedPackages} analyzed, ` +
      `${analysis.totals.excludedPackages} excluded`,
  );
  lines.push("");

  for (const arm of ["experts", "control"]) {
    const s = analysis.arms[arm];
    lines.push(`arm ${arm} (n=${s.n} packages, ${s.nVerdict} with verdicts):`);
    const ci = s.firstPass.ci95;
    lines.push(
      `  first-pass:          ${s.firstPass.k}/${s.firstPass.n} = ${pct(s.firstPass.rate)}` +
        (ci ? `  Wilson95 [${pct(ci.lo)}, ${pct(ci.hi)}]` : ""),
    );
    lines.push(`  first-pass-or-cond:  ${s.firstPassOrCond.k}/${s.firstPassOrCond.n} = ${pct(s.firstPassOrCond.rate)}`);
    lines.push(
      `  rework rounds: mean ${s.rework.mean === null ? "—" : s.rework.mean.toFixed(2)} · median ${s.rework.median === null ? "—" : s.rework.median} (${s.rework.n} packages, ${s.rework.censored} censored)`,
    );
    lines.push(`  cost USD: median ${usd(s.cost.median)} · p90 ${usd(s.cost.p90)} · total ${usd(s.cost.total)}`);
    lines.push(
      `  wallMs: median ${ms(s.wallMs.median)} · p90 ${ms(s.wallMs.p90)} (${s.wallMs.n} packages, ${s.wallMs.nullCount} without settledAt)`,
    );
    lines.push(
      `  consult: ${s.consult.calls} calls · ${usd(s.consult.costUsd)} · ${s.consult.failed} failed · used in ${s.consultUsed.packages}/${s.consultUsed.of} packages (${pct(s.consultUsed.fraction)})`,
    );
    if (s.byLane.length > 0) {
      lines.push(
        `  by lane: ${s.byLane
          .map(
            (lane) =>
              `${lane.lane} n=${lane.n} first-pass ${lane.firstPassK}/${lane.nVerdict} · cost median ${usd(lane.costMedian)}`,
          )
          .join(" ; ")}`,
      );
    }
    lines.push("");
  }

  const cmp = analysis.comparison;
  lines.push("comparison (experts − control):");
  lines.push(
    `  first-pass:          ${pp(cmp.firstPass?.diff ?? null)}  (z=${cmp.firstPass?.z?.toFixed(3) ?? "—"}, p=${pValue(cmp.firstPass?.p ?? null)})`,
  );
  lines.push(
    `  first-pass-or-cond:  ${pp(cmp.firstPassOrCond?.diff ?? null)}  (z=${cmp.firstPassOrCond?.z?.toFixed(3) ?? "—"}, p=${pValue(cmp.firstPassOrCond?.p ?? null)})`,
  );
  lines.push("");

  lines.push(`exclusions (${analysis.excluded.length}):`);
  if (analysis.excluded.length === 0) {
    lines.push("  (none)");
  } else {
    for (const ex of analysis.excluded) {
      lines.push(`  ${ex.packageId}  ${ex.reasons.join(",")}  runs ${ex.runIds.join(",") || "—"}`);
      if (ex.detail) lines.push(`    ${ex.detail}`);
    }
    lines.push(
      `  note: diag.absorbedRunIds is a FIFO set capped at ${ABSORBED_RUN_IDS_CAP} per run — a run absorbing ` +
        `more than ${ABSORBED_RUN_IDS_CAP} ids evicts the oldest, and the evicted runs' cost is double-counted ` +
        `(flagged as absorbed-cap-hit, never excluded).`,
    );
  }
  lines.push("");

  lines.push(`warnings (${analysis.warnings.length}):`);
  if (analysis.warnings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const warning of analysis.warnings) {
      lines.push(
        `  ${warning.packageId}  ${warning.kind}${warning.runIds ? `  runs ${warning.runIds.join(",")}` : ""}`,
      );
      if (warning.detail) lines.push(`    ${warning.detail}`);
    }
  }
  lines.push("");

  if (analysis.coverage.length > 0) {
    lines.push("coverage hint (work runs without meta, by main session file — hint only, never excludes):");
    for (const c of analysis.coverage) {
      lines.push(`  ${c.file}: ${c.workRunsWithoutMeta} work run(s) without meta (${c.workRuns} with)`);
    }
    lines.push("");
  }

  if (analysis.packages.length > 0) {
    lines.push(`packages (${analysis.packages.length} analyzed):`);
    for (const p of analysis.packages) {
      const first = p.firstPass === null ? "no-verdict" : p.firstPass ? "pass" : p.firstPassOrCond ? "cond" : "reject";
      lines.push(
        `  ${p.packageId}  ${p.arm ?? "?"}  ${p.lane}  first=${first}  rework=${p.reworkRounds === null ? "cens" : p.reworkRounds}  cost ${usd(p.costUsd)}  wall ${ms(p.wallMs)}ms  consult ${p.consult.calls}/${usd(p.consult.costUsd)}/${p.consult.failed}f`,
      );
    }
    lines.push("");
  }

  if (analysis.powerHint !== null) lines.push(`power: ${analysis.powerHint}`);
  return lines.join("\n");
}

/** 解析 YYYY-MM-DD 为 UTC 零点 epoch ms；不合法返回 undefined。 */
export function parseDayUtc(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : undefined;
}
