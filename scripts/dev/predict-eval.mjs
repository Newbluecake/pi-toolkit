#!/usr/bin/env node
/**
 * predict-eval — memory-predict（P 层）的 Tier 3 手工评测入口（plan.md v3.2 §12.2/§12.3/§12.4）。
 *
 * 本脚本只做三件事，全部基于**真实数据**，零网络、零模型调用：
 *   1. `--check-labels` 校验人工标注集 `docs/dev/memory-predict/eval/labelled.jsonl`
 *      （结构 + §12.2 分层配额 + 按会话 60/40 划分一致性）；
 *   2. `--metrics` 读取人工录制的逐轮 P 输出（runs.jsonl，可选 runs-model.jsonl）与
 *      P2 记账（calls.jsonl），在**保留集**上计算 §12.2 指标、§12.3 延迟分位、§12.4 费用日账；
 *   3. 数据缺口 ⇒ 该指标记 `NOT-EVALUATED` 并给出明确提示；绝不生成合成标注
 *      （伪造 160 轮是明令禁止的），也绝不在数据不全时声称达标。
 *
 * §12.2 的流程要求（标注由不看 P 输出的独立 agent 起草、用户逐条确认、保留集冻结）
 * 无法从数据本身验证，只在报告中作为 checklist 提示，本脚本不代替它们。
 *
 * 用法：
 *   node scripts/dev/predict-eval.mjs --help
 *   node scripts/dev/predict-eval.mjs --check-labels
 *   node scripts/dev/predict-eval.mjs --check-labels --labels /path/to/labelled.jsonl
 *   node scripts/dev/predict-eval.mjs --metrics                    # 默认路径，缺文件会明确提示
 *   node scripts/dev/predict-eval.mjs --metrics --no-model         # P1b 规则版：跳过 deepseek 增量项
 *   node scripts/dev/predict-eval.mjs --metrics --runs-model eval/runs-model.jsonl --out eval/report.md
 *
 * 退出码：0 = 校验通过 / 指标已算（含 INCOMPLETE）；1 = 用法或数据 schema 错误；
 * 2 = 指标判 FAIL。INCOMPLETE 不是错误——它就是"缺数据"的诚实结论。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "..", "docs", "dev", "memory-predict", "eval");

// ───────────────────── 常量（与 plan §12.2 / taxonomy 对齐） ─────────────────────

/** taxonomy 中 risk:"high" 的 9 个可注入动作 tag（§3.2 规则表 inject ✔ 列；§12.2 的"9 个高危 tag"）。 */
export const HIGH_RISK_TAGS = Object.freeze([
  "git-commit",
  "git-push",
  "git-history",
  "release",
  "deletion",
  "dispatch",
  "dependencies",
  "credentials",
  "frozen-files",
]);

/** §12.2 分层抽样的配额（不足即标注集校验失败）。tag:<t> 桶按 expected.tags 归属，各 ≥10。 */
export const STRATA_MIN = Object.freeze({
  total: 160,
  negation: 12,
  "readonly-or-question": 12,
  "carry-expired": 10,
  "release-in-progress": 8,
  "child-session": 12,
  carry: 12,
  "short-new-instruction": 10,
  "idle-chat": 10,
});

/** 逐 tag 精确率的单独计算门槛与及格线（§12.2 指标表）。 */
export const PER_TAG_SUPPORT_MIN = 5;
export const PER_TAG_PRECISION_MIN = 0.75;
export const OVERALL_PRECISION_MIN = 0.85;
export const COVERAGE_DELTA_MIN = Object.freeze({ partial: 0.25, full: 0.08 });
export const EXTRA_PER_TURN_MAX = 0.3;
export const MISINJECT_RATE_MAX = 0.2;
export const CARRY_COVERAGE_MIN = 0.7;
export const S_COVERAGE_MIN = 0.9;
export const MODEL_DELTA_COVERAGE_MIN = 0.05;
export const MODEL_DELTA_EXTRA_MAX = 0.1;

/** §12.3 延迟预算（本地 p99，ms；CI 的 rules 断言是 50ms，报告里注明）。 */
export const LATENCY_BUDGET_MS = Object.freeze({
  rules: 2,
  "runPredict-hot": 10,
  "runPredict-cold": 5,
  "max-corpus": 30,
});

/** §12.4 默认上限（可用 --max-usd/--max-calls 覆盖，仅为报告对照）。 */
export const DEFAULT_MAX_USD_PER_DAY = 0.14;
export const DEFAULT_MAX_CALLS_PER_DAY = 60;

// ───────────────────── JSONL 解析与 schema 校验 ─────────────────────

/**
 * 解析 JSONL：逐行 JSON.parse，坏行记为 `{ error, line }`；空行/纯空白行跳过。
 * 文件不存在时返回 `{ missing: true, rows: [] }`（调用方据此给出明确提示，不视为 schema 错）。
 */
export function parseJsonl(text) {
  const rows = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    try {
      rows.push(JSON.parse(raw));
    } catch (err) {
      rows.push({ __parseError: String(err?.message ?? err), __line: i + 1 });
    }
  }
  return rows;
}

/** 预设 tag id 全集（taxonomy.ts PRESET_TAGS；用户自定义 tag 允许，只警告拼写）。 */
export const PRESET_TAG_IDS = Object.freeze([
  ...HIGH_RISK_TAGS,
  "model-routing",
  "testing",
  "build",
  "ci",
  "network",
  "config",
  "shell-env",
  "background-jobs",
  "session-context",
  "docs",
  "communication",
  "workflow",
  "memory-system",
]);

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const isStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString);

/**
 * 校验一条标注。返回错误数组（空 = 通过）。字段契约见 --schema 输出。
 * 预设 tag 之外的 id 只警告不报错（存在用户自定义 tag），警告由调用方聚合。
 */
export function validateLabelRow(row) {
  const errors = [];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return ["label row must be a JSON object"];
  if (!isNonEmptyString(row.id)) errors.push("id: required non-empty string");
  if (!isNonEmptyString(row.session)) errors.push("session: required non-empty string (split unit)");
  if (row.subset !== "tuning" && row.subset !== "holdout") errors.push("subset: must be 'tuning' or 'holdout'");
  if (row.sessionKind !== "main" && row.sessionKind !== "child") errors.push("sessionKind: must be 'main' or 'child'");
  if (!isNonEmptyString(row.prompt)) errors.push("prompt: required non-empty string");
  const exp = row.expected;
  if (exp === null || typeof exp !== "object" || Array.isArray(exp)) {
    errors.push("expected: required object { tags, anchors, state }");
  } else {
    if (!isStringArray(exp.tags)) errors.push("expected.tags: required string[] (may be empty)");
    if (!isStringArray(exp.anchors)) errors.push("expected.anchors: required string[] (may be empty)");
    if (!isStringArray(exp.state)) errors.push("expected.state: required string[] (may be empty)");
  }
  if (row.flags !== undefined) {
    if (row.flags === null || typeof row.flags !== "object" || Array.isArray(row.flags))
      errors.push("flags: optional object of booleans");
    else
      for (const [k, v] of Object.entries(row.flags))
        if (typeof v !== "boolean") errors.push(`flags.${k}: must be boolean`);
  }
  return errors;
}

/** 一条标注命中的分层桶（§12.2；tag:<t> 桶由 expected.tags 驱动）。 */
export function strataBucketsOf(label) {
  const buckets = new Set();
  for (const t of HIGH_RISK_TAGS) if ((label.expected?.tags ?? []).includes(t)) buckets.add(`tag:${t}`);
  const f = label.flags ?? {};
  if (f.negated) buckets.add("negation");
  if (f.readonlyOrQuestion) buckets.add("readonly-or-question");
  if (f.carryExpired) buckets.add("carry-expired");
  if (f.releaseInProgress) buckets.add("release-in-progress");
  if (label.sessionKind === "child") buckets.add("child-session");
  if (f.carry) buckets.add("carry");
  if (f.shortNewInstruction) buckets.add("short-new-instruction");
  if (f.idleChat) buckets.add("idle-chat");
  return buckets;
}

/**
 * 校验整份标注集：结构、id 唯一、会话→子集一致、分层配额、划分比例。
 * 返回 `{ ok, errors, warnings, counts }`；counts 含 total / per-subset / per-bucket / per-session-subset。
 */
export function validateLabels(labels) {
  const errors = [];
  const warnings = [];
  const counts = { total: labels.length, tuning: 0, holdout: 0, buckets: {}, sessions: {} };
  const ids = new Set();
  const sessionSubset = new Map();
  const knownTagWarned = new Set();

  labels.forEach((row, idx) => {
    const where = row && typeof row === "object" && isNonEmptyString(row.id) ? `id=${row.id}` : `line #${idx + 1}`;
    if (row?.__parseError) {
      errors.push(`${where}: JSON parse error: ${row.__parseError}`);
      return;
    }
    for (const e of validateLabelRow(row)) errors.push(`${where}: ${e}`);
    if (row?.subset === "tuning" || row?.subset === "holdout") counts[row.subset] += 1;
    if (isNonEmptyString(row?.id)) {
      if (ids.has(row.id)) errors.push(`${where}: duplicate id`);
      ids.add(row.id);
    }
    if (isNonEmptyString(row?.session) && (row?.subset === "tuning" || row?.subset === "holdout")) {
      const prev = sessionSubset.get(row.session);
      if (prev !== undefined && prev !== row.subset)
        errors.push(
          `${where}: session "${row.session}" split across ${prev} and ${row.subset} (split must be by session)`,
        );
      sessionSubset.set(row.session, row.subset);
      counts.sessions[row.session] = row.subset;
    }
    for (const t of row?.expected?.tags ?? []) {
      if (!PRESET_TAG_IDS.includes(t) && !knownTagWarned.has(t)) {
        knownTagWarned.add(t);
        warnings.push(
          `${where}: tag "${t}" is not a preset taxonomy id (user-defined tags are allowed — verify the spelling)`,
        );
      }
    }
  });

  // 分层配额（在整份集合上数；§12.2 的配额针对标注集全体，指标才只在保留集上算）。
  for (const label of labels) {
    if (label?.__parseError || validateLabelRow(label).length > 0) continue;
    for (const b of strataBucketsOf(label)) counts.buckets[b] = (counts.buckets[b] ?? 0) + 1;
  }
  if (counts.total < STRATA_MIN.total)
    errors.push(`strata total: ${counts.total} < ${STRATA_MIN.total} rounds (plan §12.2)`);
  for (const t of HIGH_RISK_TAGS) {
    const n = counts.buckets[`tag:${t}`] ?? 0;
    if (n < 10) errors.push(`strata tag:${t}: ${n} positives < 10 (plan §12.2)`);
  }
  for (const [name, min] of Object.entries(STRATA_MIN)) {
    if (name === "total") continue;
    const n = counts.buckets[name] ?? 0;
    if (n < min) errors.push(`strata ${name}: ${n} < ${min} (plan §12.2)`);
  }

  // 划分比例：按会话 60/40。硬性要求两侧都非空；比例偏差只警告（会话数少时 60/40 不可精确）。
  const tuningSessions = [...sessionSubset.values()].filter((s) => s === "tuning").length;
  const holdoutSessions = [...sessionSubset.values()].filter((s) => s === "holdout").length;
  if (tuningSessions === 0 || holdoutSessions === 0)
    errors.push(`split: both tuning (${tuningSessions}) and holdout (${holdoutSessions}) sessions must exist`);
  const holdoutShare = counts.total > 0 ? counts.holdout / counts.total : 0;
  if (counts.total > 0 && (holdoutShare < 0.25 || holdoutShare > 0.55))
    warnings.push(
      `split: holdout round share ${(holdoutShare * 100).toFixed(1)}% deviates from the plan's 60/40-by-session target (sessions: ${tuningSessions} tuning / ${holdoutSessions} holdout)`,
    );

  return { ok: errors.length === 0, errors, warnings, counts };
}

/**
 * 校验一条运行记录（人工录制的逐轮 P 输出）。`jev` 接受 full/probing（同桶）与 partial。
 * 返回错误数组；未知字段不报错（向前兼容），缺 `p` 视为"P 未产出"（合法，如否定轮）。
 */
export function validateRunRow(row) {
  const errors = [];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return ["run row must be a JSON object"];
  if (!isNonEmptyString(row.id)) errors.push("id: required non-empty string (must match a label id)");
  if (row.jev !== "full" && row.jev !== "probing" && row.jev !== "partial")
    errors.push("jev: must be 'full' | 'probing' | 'partial'");
  if (row.p !== undefined) {
    if (row.p === null || typeof row.p !== "object" || Array.isArray(row.p)) errors.push("p: optional object");
    else {
      if (row.p.tags !== undefined && !isStringArray(row.p.tags)) errors.push("p.tags: string[]");
      if (row.p.state !== undefined && !isStringArray(row.p.state)) errors.push("p.state: string[]");
      if (row.p.anchors !== undefined && !isStringArray(row.p.anchors)) errors.push("p.anchors: string[]");
      if (row.p.carryTags !== undefined && !isStringArray(row.p.carryTags)) errors.push("p.carryTags: string[]");
      if (row.p.origin !== undefined && !isNonEmptyString(row.p.origin)) errors.push("p.origin: non-empty string");
      if (row.p.ms !== undefined && (typeof row.p.ms !== "number" || !Number.isFinite(row.p.ms) || row.p.ms < 0))
        errors.push("p.ms: non-negative number");
      if (row.p.phase !== undefined && !isNonEmptyString(row.p.phase)) errors.push("p.phase: non-empty string");
    }
  }
  for (const side of ["uOn", "uOff"]) {
    if (row[side] !== undefined) {
      if (row[side] === null || typeof row[side] !== "object" || Array.isArray(row[side]))
        errors.push(`${side}: optional object { anchors }`);
      else if (row[side].anchors !== undefined && !isStringArray(row[side].anchors))
        errors.push(`${side}.anchors: string[]`);
    }
  }
  return errors;
}

/** 校验 runs 与 labels 的一致性（id 存在、无重复）。 */
export function validateRuns(runs, labels) {
  const errors = [];
  const labelIds = new Set(labels.filter((l) => isNonEmptyString(l?.id)).map((l) => l.id));
  const seen = new Set();
  runs.forEach((row, idx) => {
    const where = row && typeof row === "object" && isNonEmptyString(row.id) ? `id=${row.id}` : `line #${idx + 1}`;
    if (row?.__parseError) {
      errors.push(`${where}: JSON parse error: ${row.__parseError}`);
      return;
    }
    for (const e of validateRunRow(row)) errors.push(`${where}: ${e}`);
    if (isNonEmptyString(row?.id)) {
      if (seen.has(row.id)) errors.push(`${where}: duplicate run for the same label id`);
      seen.add(row.id);
      if (!labelIds.has(row.id)) errors.push(`${where}: no label with this id`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// ───────────────────── 统计工具 ─────────────────────

/** 最近邻秩分位（nearest-rank）：p∈(0,100]；空数组返回 undefined。 */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedValues.length));
  return sortedValues[rank - 1];
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pp = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
const usd = (x) => `$${x.toFixed(4)}`;

// ───────────────────── §12.2 指标（只在保留集上） ─────────────────────

const intersects = (a, b) => a.some((x) => b.includes(x));

/**
 * 计算 §12.2 指标。runsModel 缺省时 M9（deepseek 增量）记 NOT-EVALUATED。
 * 每个指标 `{ name, status: "PASS"|"FAIL"|"NOT-EVALUATED", detail }`——NOT-EVALUATED
 * 必须带明确缺数据原因；没有任何指标会在无数据时判 PASS。
 */
export function computeMetrics(labels, runs, options = {}) {
  const runsModel = options.runsModel ?? [];
  const noModel = options.noModel === true;
  const labelById = new Map(labels.filter((l) => isNonEmptyString(l?.id)).map((l) => [l.id, l]));
  const runById = new Map(runs.filter((r) => isNonEmptyString(r?.id)).map((r) => [r.id, r]));
  const modelById = new Map(runsModel.filter((r) => isNonEmptyString(r?.id)).map((r) => [r.id, r]));

  const holdout = labels.filter((l) => l?.subset === "holdout" && labelById.get(l.id) !== undefined);
  const matched = holdout.filter((l) => runById.has(l.id)).map((l) => ({ label: l, run: runById.get(l.id) }));
  const unmatched = holdout.filter((l) => !runById.has(l.id)).map((l) => l.id);
  const metrics = [];
  const notes = [];
  if (holdout.length === 0)
    notes.push("holdout is empty — no metric can be evaluated until the labelled set has holdout rounds with runs");
  if (unmatched.length > 0)
    notes.push(
      `${unmatched.length} holdout round(s) have no run record (skipped): ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? " …" : ""}`,
    );

  // M1 逐 tag 精确率（支持数 ≥5 的高危 tag 单独算；预测 0 次无法测精确率）。
  let m1AllEvaluated = true;
  let m1AnyFail = false;
  const m1Detail = [];
  let sumCorrect = 0;
  let sumPredicted = 0;
  for (const t of HIGH_RISK_TAGS) {
    const support = matched.filter(({ label }) => label.expected.tags.includes(t)).length;
    if (support < PER_TAG_SUPPORT_MIN) {
      m1AllEvaluated = false;
      m1Detail.push(`${t}: NOT-EVALUATED (holdout support ${support} < ${PER_TAG_SUPPORT_MIN})`);
      continue;
    }
    const predictedRounds = matched.filter(({ run }) => (run.p?.tags ?? []).includes(t));
    if (predictedRounds.length === 0) {
      m1AllEvaluated = false;
      m1Detail.push(
        `${t}: NOT-EVALUATED (support ${support} but zero P predictions — nothing to measure precision on)`,
      );
      continue;
    }
    const correct = predictedRounds.filter(({ label }) => label.expected.tags.includes(t)).length;
    sumCorrect += correct;
    sumPredicted += predictedRounds.length;
    const precision = correct / predictedRounds.length;
    const pass = precision >= PER_TAG_PRECISION_MIN;
    if (!pass) m1AnyFail = true;
    m1Detail.push(
      `${t}: ${pct(precision)} (${correct}/${predictedRounds.length}) ${pass ? "PASS" : "FAIL"} [support ${support}]`,
    );
  }
  metrics.push({
    name: "M1 per-tag precision (holdout, each ≥0.75)",
    status: m1AnyFail ? "FAIL" : m1AllEvaluated ? "PASS" : "NOT-EVALUATED",
    detail: m1Detail,
  });

  // M2 总体精确率（micro，9 个高危 tag 合计）。
  if (sumPredicted === 0) {
    metrics.push({
      name: "M2 overall precision (≥0.85)",
      status: "NOT-EVALUATED",
      detail: ["zero P tag predictions on holdout"],
    });
  } else {
    const overall = sumCorrect / sumPredicted;
    metrics.push({
      name: "M2 overall precision (≥0.85)",
      status:
        m1AllEvaluated && overall >= OVERALL_PRECISION_MIN
          ? "PASS"
          : overall < OVERALL_PRECISION_MIN
            ? "FAIL"
            : "NOT-EVALUATED",
      detail: [
        `${pct(overall)} (${sumCorrect}/${sumPredicted})${m1AllEvaluated ? "" : " — some tags NOT-EVALUATED above"}`,
      ],
    });
  }

  // M3 首请求可见覆盖率增量（P 开减 P 关，partial ≥+25pp / full ≥+8pp）。
  const bucketOf = (jev) => (jev === "partial" ? "partial" : "full"); // full/probing 同桶（§5.2）
  const m3Detail = [];
  let m3Evaluated = true;
  let m3Fail = false;
  for (const bucket of ["partial", "full"]) {
    const rows = matched.filter(({ label, run }) => bucketOf(run.jev) === bucket && label.expected.anchors.length > 0);
    if (rows.length === 0) {
      m3Evaluated = false;
      m3Detail.push(`${bucket}: NOT-EVALUATED (no holdout rounds with expected anchors and a run)`);
      continue;
    }
    const missingBaseline = rows.filter(({ run }) => !run.uOff || !run.uOff.anchors).length;
    const missingOn = rows.filter(({ run }) => !run.uOn || !run.uOn.anchors).length;
    if (missingBaseline > 0 || missingOn > 0) {
      m3Evaluated = false;
      m3Detail.push(
        `${bucket}: NOT-EVALUATED (${rows.length} rounds; ${missingOn} missing uOn.anchors, ${missingBaseline} missing uOff.anchors — record the P-off replay too)`,
      );
      continue;
    }
    const hitOn = rows.filter(({ label, run }) =>
      intersects([...(run.p?.anchors ?? []), ...run.uOn.anchors], label.expected.anchors),
    ).length;
    const hitOff = rows.filter(({ label, run }) => intersects(run.uOff.anchors, label.expected.anchors)).length;
    const delta = hitOn / rows.length - hitOff / rows.length;
    const pass = delta >= COVERAGE_DELTA_MIN[bucket];
    if (!pass) m3Fail = true;
    m3Detail.push(
      `${bucket}: on ${pct(hitOn / rows.length)} vs off ${pct(hitOff / rows.length)} ⇒ ${pp(delta)} (need ≥${pp(COVERAGE_DELTA_MIN[bucket])}, n=${rows.length}) ${pass ? "PASS" : "FAIL"}`,
    );
  }
  metrics.push({
    name: "M3 first-request coverage delta (P on − P off)",
    status: m3Fail ? "FAIL" : m3Evaluated ? "PASS" : "NOT-EVALUATED",
    detail: m3Detail,
  });

  // M4 额外注入量（P 注入、且 U/A/E 都不会注入的条目，均值 ≤0.3/轮）。
  const extraRows = matched.filter(({ run }) => run.uOn?.anchors && run.uOff?.anchors);
  if (extraRows.length === 0) {
    metrics.push({
      name: "M4 extra P-only injections (≤0.3/turn)",
      status: "NOT-EVALUATED",
      detail: ["no holdout round carries both uOn.anchors and uOff.anchors"],
    });
  } else {
    const totalExtra = extraRows.reduce(
      (acc, { run }) =>
        acc +
        (run.p?.anchors ?? []).filter((a) => !run.uOn.anchors.includes(a) && !run.uOff.anchors.includes(a)).length,
      0,
    );
    const mean = totalExtra / extraRows.length;
    metrics.push({
      name: "M4 extra P-only injections (≤0.3/turn)",
      status: mean <= EXTRA_PER_TURN_MAX ? "PASS" : "FAIL",
      detail: [
        `${mean.toFixed(3)}/turn (${totalExtra} across ${extraRows.length} turns with baselines; ${matched.length - extraRows.length} skipped for missing baselines)`,
      ],
    });
  }

  // M5 误注条目率（P 注入锚点不在期望锚点里，≤20%）。
  const injectedRows = matched.filter(({ run }) => (run.p?.anchors ?? []).length > 0);
  if (injectedRows.length === 0) {
    metrics.push({
      name: "M5 misinjected entry rate (≤20%)",
      status: "NOT-EVALUATED",
      detail: ["no holdout round has P-injected anchors"],
    });
  } else {
    const totalInjected = injectedRows.reduce((acc, { run }) => acc + run.p.anchors.length, 0);
    const wrong = injectedRows.reduce(
      (acc, { label, run }) => acc + run.p.anchors.filter((a) => !label.expected.anchors.includes(a)).length,
      0,
    );
    const rate = wrong / totalInjected;
    metrics.push({
      name: "M5 misinjected entry rate (≤20%)",
      status: rate <= MISINJECT_RATE_MAX ? "PASS" : "FAIL",
      detail: [`${pct(rate)} (${wrong}/${totalInjected} anchors across ${injectedRows.length} turns)`],
    });
  }

  // M6 否定/只读样本中出现写动作 P 条目（= 0）。
  const negRows = matched.filter(({ label }) => label.flags?.negated || label.flags?.readonlyOrQuestion);
  if (negRows.length === 0) {
    metrics.push({
      name: "M6 write-action P tags on negation/readonly rounds (= 0)",
      status: "NOT-EVALUATED",
      detail: ["no holdout round flagged negated/readonlyOrQuestion"],
    });
  } else {
    const violations = negRows.filter(({ run }) => intersects(run.p?.tags ?? [], HIGH_RISK_TAGS));
    metrics.push({
      name: "M6 write-action P tags on negation/readonly rounds (= 0)",
      status: violations.length === 0 ? "PASS" : "FAIL",
      detail: [
        `${violations.length}/${negRows.length} rounds surfaced a write-action tag${
          violations.length === 0
            ? ""
            : `: ${violations
                .slice(0, 8)
                .map(({ label }) => label.id)
                .join(", ")}`
        }`,
      ],
    });
  }

  // M7 承接覆盖率 ≥70% / 短新指令误承接 = 0。
  const carryRows = matched.filter(({ label }) => label.flags?.carry);
  const shortRows = matched.filter(({ label }) => label.flags?.shortNewInstruction);
  if (carryRows.length === 0) {
    metrics.push({
      name: "M7 carry coverage ≥70% / false carry on short new instructions = 0",
      status: "NOT-EVALUATED",
      detail: ["no holdout round flagged carry"],
    });
  } else {
    const covered = carryRows.filter(({ label, run }) =>
      label.expected.tags.every((t) => (run.p?.tags ?? []).includes(t)),
    ).length;
    const covRate = covered / carryRows.length;
    const covPass = covRate >= CARRY_COVERAGE_MIN;
    let falseDetail = "short-new-instruction rounds: none flagged — false-carry half NOT-EVALUATED";
    let falsePass = false;
    let falseEvaluated = false;
    if (shortRows.length > 0) {
      falseEvaluated = true;
      const falseCarries = shortRows.filter(({ label, run }) =>
        (run.p?.carryTags ?? run.p?.tags ?? []).some((t) => !label.expected.tags.includes(t)),
      );
      falsePass = falseCarries.length === 0;
      falseDetail = `false carry ${falseCarries.length}/${shortRows.length}${
        falsePass
          ? ""
          : `: ${falseCarries
              .slice(0, 8)
              .map(({ label }) => label.id)
              .join(", ")}`
      }`;
    }
    metrics.push({
      name: "M7 carry coverage ≥70% / false carry on short new instructions = 0",
      status: covPass && (!falseEvaluated || falsePass) ? (falseEvaluated ? "PASS" : "NOT-EVALUATED") : "FAIL",
      detail: [
        `carry coverage ${pct(covRate)} (${covered}/${carryRows.length}) ${covPass ? "PASS" : "FAIL"} · ${falseDetail}`,
      ],
    });
  }

  // M8 发版进行中样本的 S 条目覆盖率 ≥90%。
  const sRows = matched.filter(({ label }) => label.flags?.releaseInProgress);
  if (sRows.length === 0) {
    metrics.push({
      name: "M8 S-entry coverage on release-in-progress rounds (≥90%)",
      status: "NOT-EVALUATED",
      detail: ["no holdout round flagged releaseInProgress"],
    });
  } else {
    const covered = sRows.filter(({ run }) => (run.p?.state ?? []).includes("release-in-progress")).length;
    const rate = covered / sRows.length;
    metrics.push({
      name: "M8 S-entry coverage on release-in-progress rounds (≥90%)",
      status: rate >= S_COVERAGE_MIN ? "PASS" : "FAIL",
      detail: [`${pct(rate)} (${covered}/${sRows.length})`],
    });
  }

  // M9 deepseek 增量（uncertain 轮：rules+model 相比纯规则覆盖率 ≥+5pp，额外注入增量 ≤0.1/轮）。
  if (noModel) {
    metrics.push({
      name: "M9 deepseek increment on uncertain rounds (+≥5pp coverage, +≤0.1/turn extra)",
      status: "NOT-EVALUATED",
      detail: ["--no-model: P1b rules-only run — the model increment is out of scope for this pass"],
    });
  } else if (runsModel.length === 0) {
    metrics.push({
      name: "M9 deepseek increment on uncertain rounds (+≥5pp coverage, +≤0.1/turn extra)",
      status: "NOT-EVALUATED",
      detail: [
        "no --runs-model file — record a second pass with the P2 model path enabled and pass --runs-model (plan §12.2)",
      ],
    });
  } else {
    const uncertain = matched.filter(({ run }) => run.p?.uncertain === true);
    const withModel = uncertain.filter(({ label }) => modelById.has(label.id));
    if (withModel.length === 0) {
      metrics.push({
        name: "M9 deepseek increment on uncertain rounds (+≥5pp coverage, +≤0.1/turn extra)",
        status: "NOT-EVALUATED",
        detail: [`no run flagged p.uncertain=true with a matching --runs-model record`],
      });
    } else {
      const hitBase = (row) =>
        row.label.expected.anchors.length === 0
          ? false
          : intersects([...(row.run.p?.anchors ?? []), ...(row.run.uOn?.anchors ?? [])], row.label.expected.anchors);
      const hitModel = (row) => {
        const m = modelById.get(row.label.id);
        return (
          row.label.expected.anchors.length > 0 &&
          intersects([...(m.p?.anchors ?? []), ...(m.uOn?.anchors ?? [])], row.label.expected.anchors)
        );
      };
      const baseRate = withModel.filter(hitBase).length / withModel.length;
      const modelRate = withModel.filter(hitModel).length / withModel.length;
      const delta = modelRate - baseRate;
      const extraOf = (run) =>
        (run.p?.anchors ?? []).filter(
          (a) => !(run.uOn?.anchors ?? []).includes(a) && !(run.uOff?.anchors ?? []).includes(a),
        ).length;
      const extraBase = withModel.reduce((acc, r) => acc + extraOf(r.run), 0) / withModel.length;
      const extraModel =
        withModel.reduce((acc, r) => acc + extraOf(modelById.get(r.label.id) ?? {}), 0) / withModel.length;
      const covPass = delta >= MODEL_DELTA_COVERAGE_MIN;
      const extraPass = extraModel - extraBase <= MODEL_DELTA_EXTRA_MAX;
      metrics.push({
        name: "M9 deepseek increment on uncertain rounds (+≥5pp coverage, +≤0.1/turn extra)",
        status: covPass && extraPass ? "PASS" : "FAIL",
        detail: [
          `coverage ${pct(modelRate)} vs ${pct(baseRate)} ⇒ ${pp(delta)} (need ≥${pp(MODEL_DELTA_COVERAGE_MIN)}) ${covPass ? "PASS" : "FAIL"} · extra ${extraModel.toFixed(3)}/turn vs ${extraBase.toFixed(3)}/turn (+${(extraModel - extraBase).toFixed(3)}, need ≤${MODEL_DELTA_EXTRA_MAX}) ${extraPass ? "PASS" : "FAIL"} · n=${withModel.length}`,
        ],
      });
    }
  }

  const evaluated = metrics.filter((m) => m.status !== "NOT-EVALUATED");
  const failed = metrics.filter((m) => m.status === "FAIL");
  const incomplete = metrics.filter((m) => m.status === "NOT-EVALUATED");
  const verdict =
    failed.length > 0 ? "FAIL" : incomplete.length > 0 ? "INCOMPLETE" : evaluated.length > 0 ? "PASS" : "INCOMPLETE";
  return { verdict, metrics, notes, holdoutCount: holdout.length, matchedCount: matched.length };
}

// ───────────────────── §12.3 延迟 / §12.4 费用 ─────────────────────

/** runs 里 p.ms 的分位统计（按 p.phase 分组，缺省 "rules"）。延迟是 Minor 记录项，不算门禁。 */
export function latencyStats(runs) {
  const byPhase = new Map();
  for (const run of runs) {
    const ms = run?.p?.ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
    const phase = run.p.phase ?? "rules";
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(ms);
  }
  const rows = [];
  for (const [phase, values] of byPhase) {
    const sorted = [...values].sort((a, b) => a - b);
    const budget = LATENCY_BUDGET_MS[phase];
    rows.push({
      phase,
      n: sorted.length,
      p50: percentile(sorted, 50),
      p99: percentile(sorted, 99),
      budgetMs: budget,
      overBudget: budget !== undefined && percentile(sorted, 99) > budget,
    });
  }
  return rows;
}

/**
 * §12.4 费用日账：calls.jsonl 每行 `{ at?, day?, ok?, reserveUsd?, costUsd?, costSource? }`，
 * spent = Σ(costUsd ?? reserveUsd)（无 usage 按预留结算）；对照 maxUsd/maxCalls 只报告。
 */
export function costStats(calls, maxUsdPerDay = DEFAULT_MAX_USD_PER_DAY, maxCallsPerDay = DEFAULT_MAX_CALLS_PER_DAY) {
  const byDay = new Map();
  for (const call of calls) {
    if (call === null || typeof call !== "object") continue;
    const day = isNonEmptyString(call.day)
      ? call.day
      : typeof call.at === "string" && call.at.length >= 10
        ? call.at.slice(0, 10)
        : "unknown";
    if (!byDay.has(day)) byDay.set(day, { calls: 0, spentUsd: 0, reserveSettled: 0 });
    const entry = byDay.get(day);
    entry.calls += 1;
    entry.spentUsd +=
      typeof call.costUsd === "number" ? call.costUsd : typeof call.reserveUsd === "number" ? call.reserveUsd : 0;
    if (call.costSource === "reserve") entry.reserveSettled += 1;
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, e]) => ({
      day,
      calls: e.calls,
      spentUsd: Number(e.spentUsd.toFixed(6)),
      reserveShare: e.calls > 0 ? e.reserveSettled / e.calls : 0,
      overUsdCap: e.spentUsd > maxUsdPerDay,
      overCallsCap: e.calls > maxCallsPerDay,
    }));
  return { days, maxUsdPerDay, maxCallsPerDay, hasData: days.length > 0 };
}

// ───────────────────── 报告渲染 ─────────────────────

function renderLabelReport(result, path) {
  const lines = [];
  lines.push(`predict-eval · labelled set · ${path}`);
  lines.push(
    `rounds: ${result.counts.total} (tuning ${result.counts.tuning} / holdout ${result.counts.holdout}) · sessions: ${Object.keys(result.counts.sessions).length}`,
  );
  const buckets = Object.entries(result.counts.buckets).sort(([a], [b]) => a.localeCompare(b));
  lines.push(`strata: ${buckets.length === 0 ? "none counted" : buckets.map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  for (const w of result.warnings) lines.push(`WARN: ${w}`);
  for (const e of result.errors) lines.push(`ERROR: ${e}`);
  lines.push(
    result.ok
      ? "labels: OK (structure + §12.2 strata quotas + by-session split)"
      : "labels: NOT READY — fix the errors above (plan §12.2 quotas gate the merge)",
  );
  lines.push(
    "process checklist (cannot be validated from data): drafted by an independent agent that never saw P output · every round confirmed by the user · holdout frozen",
  );
  return lines.join("\n");
}

function renderMetricsReport(labelsResult, metricsResult, runsPath, runsModelPath, latency, cost) {
  const lines = [];
  lines.push(`predict-eval · metrics (holdout only, plan §12.2)`);
  lines.push(
    `holdout rounds: ${metricsResult.holdoutCount} · with run records: ${metricsResult.matchedCount} · runs: ${runsPath}${runsModelPath ? ` · model pass: ${runsModelPath}` : ""}`,
  );
  for (const n of metricsResult.notes) lines.push(`NOTE: ${n}`);
  lines.push("");
  for (const m of metricsResult.metrics) {
    lines.push(`[${m.status}] ${m.name}`);
    for (const d of m.detail) lines.push(`  ${d}`);
  }
  lines.push("");
  lines.push(
    `latency (§12.3, local p99, INFO only — not a gate): ${
      latency.length === 0
        ? "no p.ms in runs — NOT-EVALUATED"
        : latency
            .map(
              (r) =>
                `${r.phase}: n=${r.n} p50=${r.p50?.toFixed(2)}ms p99=${r.p99?.toFixed(2)}ms${r.budgetMs !== undefined ? ` (budget ${r.budgetMs}ms${r.overBudget ? " · OVER" : ""})` : " (no budget row)"}`,
            )
            .join(" · ") + " (CI asserts rules <50ms; the 2ms budget is local)"
    }`,
  );
  lines.push(
    `cost (§12.4, recorded calls, INFO only): ${
      cost.hasData
        ? cost.days
            .map(
              (d) =>
                `${d.day}: ${d.calls} calls · ${usd(d.spentUsd)}${d.overUsdCap ? " OVER usd cap" : ""}${d.overCallsCap ? " OVER call cap" : ""} · reserve-settled ${pct(d.reserveShare)}`,
            )
            .join(" · ") + ` · caps: ${usd(cost.maxUsdPerDay)}/day, ${cost.maxCallsPerDay} calls/day`
        : 'no call records — NOT-EVALUATED (expected for P1b rules-only; record P2 `kind:"call"` ledger lines to fill this)'
    }`,
  );
  lines.push("");
  if (metricsResult.verdict === "PASS") {
    lines.push(
      "GATE: PASS on measured §12.2 metrics — this is a data verdict only; plan §12.2 still requires the process checklist and the report to be written to docs/dev/memory-predict/eval/report.md",
    );
  } else if (metricsResult.verdict === "FAIL") {
    lines.push(
      `GATE: FAIL — ${metricsResult.metrics.filter((m) => m.status === "FAIL").length} metric(s) below threshold; per plan §12.2 a holdout miss blocks the merge (or the user decides an enabled=false merge)`,
    );
  } else {
    const missing = metricsResult.metrics.filter((m) => m.status === "NOT-EVALUATED").map((m) => m.name.split(" ")[0]);
    lines.push(
      `GATE: INCOMPLETE — NOT-EVALUATED: ${missing.join(", ")}. No pass claim is made; fill the data gaps above and re-run.`,
    );
  }
  if (labelsResult !== undefined && !labelsResult.ok)
    lines.push(
      "labels: NOT READY (see --check-labels) — metrics above are provisional until the labelled set passes validation",
    );
  return lines.join("\n");
}

// ───────────────────── CLI ─────────────────────

const HELP = `predict-eval — memory-predict P-layer manual evaluation (Tier 3, plan.md v3.2 §12)

Reads REAL, human-recorded data only. It never fabricates rounds and never
claims the §12.2 gate is met while any metric lacks data.

用法：
  node scripts/dev/predict-eval.mjs --help
  node scripts/dev/predict-eval.mjs --check-labels [--labels <file>]
  node scripts/dev/predict-eval.mjs --metrics [options]

默认路径（可用旗标覆盖）：
  --labels <file>     标注集，默认 ${join(EVAL_DIR, "labelled.jsonl")}
  --runs <file>       P-on 逐轮录制，默认 ${join(EVAL_DIR, "runs.jsonl")}
  --runs-model <file> P2 模型通路的第二遍录制（M9 deepseek 增量）
  --calls <file>      P2 \`kind:"call"\` 记账行，默认 ${join(EVAL_DIR, "calls.jsonl")}
  --no-model          本遍不含 deepseek（P1b 规则版）：M9 明确记 NOT-EVALUATED
  --max-usd <n>       费用日额对照（默认 ${DEFAULT_MAX_USD_PER_DAY}）
  --max-calls <n>     次数日额对照（默认 ${DEFAULT_MAX_CALLS_PER_DAY}）
  --out <file>        报告同时写入该文件（如 docs/dev/memory-predict/eval/report.md）
  --schema            打印两份输入 schema（标注行 / 运行行）

标注行 schema（labelled.jsonl，每行一个 JSON 对象；分层配额见 --check-labels）：
  {
    "id": "r0001",                  // 唯一；运行行用它对齐
    "session": "s-2026-11-04-a",    // 划分单位：同一 session 必须同 subset
    "subset": "tuning" | "holdout", // 保留集冻结，指标只在 holdout 上算
    "sessionKind": "main" | "child",
    "prompt": "先别发版，把这个 fix 提交了",
    "expected": {
      "tags": ["git-commit"],       // 本轮开始前就应提醒的动作 tag（9 个高危 tag 计入配额）
      "anchors": ["pitfalls-git.md#4"], // 有用的条目锚点（覆盖/误注指标用；可为空）
      "state": []                   // 期望的 S 状态，如 ["release-in-progress"]
    },
    "flags": {                      // 全部可选布尔；命中 §12.2 的约束桶
      "negated": true, "readonlyOrQuestion": false, "carry": false,
      "carryExpired": false, "shortNewInstruction": false,
      "releaseInProgress": true, "idleChat": false
    }
  }

运行行 schema（runs.jsonl，每行一轮的人工/录制器转录）：
  {
    "id": "r0001",                  // 必须存在于标注集
    "jev": "full" | "probing" | "partial",  // probing 与 full 同桶（§5.2）
    "p": {                          // 缺 p = 该轮 P 未产出（合法，如否定轮）
      "tags": ["git-commit"],       // P 最终浮出的动作 tag（阈值后）
      "state": [],                  // P 的 S 状态输出
      "anchors": ["pitfalls-git.md#4"], // P 本轮注入的条目锚点
      "carryTags": ["git-commit"],  // 可选：经承接浮出的 tag（误承接判定优先用它）
      "origin": "rules",            // rules | rules+model | rules+cache
      "uncertain": false,           // M9 只统计 uncertain 轮
      "ms": 1.4,                    // 可选：该轮规则引擎耗时（§12.3）
      "phase": "rules"              // 可选：rules | runPredict-hot | runPredict-cold | max-corpus
    },
    "uOn":  { "anchors": [] },      // P 开时 U 在首请求可见的锚点（P 认领后的合并结果）
    "uOff": { "anchors": [] }       // P 关回放时 U 首请求锚点（覆盖率增量/额外注入基线）
  }

calls 行 schema（calls.jsonl，P2 记账转录）：{ "at": "ISO", "ok": true,
  "reserveUsd": 0.0003, "costUsd": 0.00028, "costSource": "usage" | "reserve" }

退出码：0 通过/已算（含 INCOMPLETE）；1 用法或 schema 错误；2 指标 FAIL。`;

function parseArgs(argv) {
  const args = {
    help: false,
    schema: false,
    checkLabels: false,
    metrics: false,
    labels: join(EVAL_DIR, "labelled.jsonl"),
    runs: join(EVAL_DIR, "runs.jsonl"),
    runsModel: undefined,
    calls: join(EVAL_DIR, "calls.jsonl"),
    noModel: false,
    maxUsd: DEFAULT_MAX_USD_PER_DAY,
    maxCalls: DEFAULT_MAX_CALLS_PER_DAY,
    out: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--schema") args.schema = true;
    else if (a === "--check-labels") args.checkLabels = true;
    else if (a === "--metrics") args.metrics = true;
    else if (a === "--labels") args.labels = argv[++i];
    else if (a === "--runs") args.runs = argv[++i];
    else if (a === "--runs-model") args.runsModel = argv[++i];
    else if (a === "--calls") args.calls = argv[++i];
    else if (a === "--no-model") args.noModel = true;
    else if (a === "--max-usd") args.maxUsd = Number(argv[++i]);
    else if (a === "--max-calls") args.maxCalls = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${a} (see --help)`);
  }
  if ([args.maxUsd, args.maxCalls].some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("--max-usd/--max-calls must be non-negative numbers");
  if (args.help) return args;
  if (!args.checkLabels && !args.metrics && !args.schema) args.checkLabels = true; // 空参 ⇒ 默认先看标注集
  return args;
}

function loadJsonlOrMissing(path, what) {
  if (!existsSync(path)) return { missing: true, why: `${what} not found: ${path}`, rows: [] };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { missing: true, why: `${what} is empty: ${path}`, rows: [] };
  return { missing: false, why: undefined, rows: parseJsonl(text) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.schema) {
    // HELP 已含两份 schema；--schema 单独打印方便粘贴给标注 agent。
    const schemaStart = HELP.indexOf("标注行 schema");
    console.log(HELP.slice(schemaStart));
    return 0;
  }

  const labelsFile = loadJsonlOrMissing(args.labels, "labelled set");
  if (args.checkLabels) {
    if (labelsFile.missing) {
      console.log(labelsFile.why);
      console.log(
        "no labelled set yet — nothing to validate. Per plan §12.2 it must be hand-labelled (≥160 stratified rounds, independently drafted, user-confirmed); this script never generates it.",
      );
      return 0;
    }
    const labelsResult = validateLabels(labelsFile.rows);
    const report = renderLabelReport(labelsResult, args.labels);
    console.log(report);
    if (labelsResult.errors.length > 0) return 1;
    return 0;
  }

  // --metrics
  const problems = [];
  let labels = [];
  let labelsResult = undefined;
  if (labelsFile.missing) {
    problems.push(labelsFile.why);
  } else {
    labels = labelsFile.rows;
    labelsResult = validateLabels(labels);
    if (!labelsResult.ok)
      problems.push(`labelled set has ${labelsResult.errors.length} validation error(s) — run --check-labels first`);
  }
  const runsFile = loadJsonlOrMissing(args.runs, "runs file");
  if (runsFile.missing) problems.push(runsFile.why);
  let runs = [];
  if (!runsFile.missing) {
    runs = runsFile.rows;
    const runCheck = validateRuns(runs, labels);
    if (!runCheck.ok) for (const e of runCheck.errors.slice(0, 20)) problems.push(`runs: ${e}`);
  }
  const runsModelFile =
    args.runsModel === undefined ? { missing: true, rows: [] } : loadJsonlOrMissing(args.runsModel, "model-pass runs");
  if (args.runsModel !== undefined && runsModelFile.missing) problems.push(runsModelFile.why);
  const callsFile = loadJsonlOrMissing(args.calls, "calls file");

  if (problems.length > 0) {
    for (const p of problems) console.log(`MISSING/BAD INPUT: ${p}`);
    console.log(
      "metrics: NOT-EVALUATED — no numbers are produced without real recorded data (fill the inputs above; see --help for the schemas).",
    );
    return 1;
  }

  const metricsResult = computeMetrics(labels, runs, {
    runsModel: runsModelFile.rows,
    noModel: args.noModel,
  });
  const latency = latencyStats(runs);
  const cost = costStats(callsFile.missing ? [] : callsFile.rows, args.maxUsd, args.maxCalls);
  const report = renderMetricsReport(labelsResult, metricsResult, args.runs, args.runsModel, latency, cost);
  console.log(report);
  if (args.out !== undefined) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, report + "\n", "utf8");
    console.log(`\nreport written: ${args.out}`);
  }
  if (metricsResult.verdict === "FAIL") return 2;
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.stack ?? err));
      process.exit(1);
    },
  );
}
