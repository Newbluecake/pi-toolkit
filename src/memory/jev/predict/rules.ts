// 规则引擎（plan.md v3.2 §3.2）——R01-R23（R04 已移为 §3.4 状态约束 S，本文件
// 不含）。规则同步执行、零调用；pi-free；无模块级可变状态（I4，全部常量不可
// 变，带 /g 的正则一律函数内新建）。
//
// decisive：只在祈使句、非疑问、未否定时生效，单独计 0.9；否则（§3.2 表中
// 标 ✔ 的规则）降为 medium，由 vote.ts 用 `w(source) × c(conf)` 公式计分。
// 未标 ✔ 的规则永远不 decisive，conf 取表中固定值。

import {
  negationWithinWindow,
  readonlyIntent,
  cancelIntent,
  splitClauses,
  WRITE_ACTION_TAGS,
  type ClauseInfo,
} from "./clauses.js";
import { extractNlCommandHits } from "./nl-commands.js";
import { allShapes } from "./shape.js";
import type { Confidence, Modifier, PredictInput, ScoredHit, ToolLite } from "./contracts.js";
import type { Taxonomy } from "../contracts.js";

/** 规则表版本：规则表任何一条命中条件/置信/decisive 资格变化都要 bump（供
 *  §7.1 精确键缓存纳入哈希）。 */
export const RULES_VERSION = 1;

export interface RulesOutput {
  readonly hits: readonly ScoredHit[];
  readonly modifiers: readonly Modifier[];
}

// ───────────────────────────── 规则表（§3.2） ─────────────────────────────

interface ClauseRuleDef {
  readonly id: string;
  readonly tag: string;
  readonly re: RegExp;
  readonly decisiveEligible: boolean;
  /** 非 decisive 资格时使用的固定置信（表中列值）。 */
  readonly conf: Confidence;
  /** 该规则命中后，额外派生的次要命中（如 R05 → R06）。 */
  readonly derive?: (hit: ScoredHit) => ScoredHit | undefined;
}

const U_RULES: readonly ClauseRuleDef[] = [
  {
    id: "R01",
    tag: "release",
    re: /发版|发布\s*v?\d|cut (a )?release|打\s*tag|bump\s*(version|版本)|release\.sh/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R02",
    tag: "git-commit",
    re: /提交(一下|代码|改动|这些)?|(?<![A-Za-z])commit(?![A-Za-z])/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R03",
    tag: "git-push",
    re: /推(送|到|上)(去|远端|github|origin)?|(?<![A-Za-z])push(?![A-Za-z])|开\s*pr|pull request|合并到\s*(dev|master|main)/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R05",
    tag: "dispatch",
    re: /派(发)?\s*([0-9一二两三四五几多]+\s*个)?\s*(子\s*)?(agent|代理|助手)|(开|起)\s*[0-9一二两三四五几多]+\s*个\s*(子\s*)?agent|并行(派|做|跑)|(?<![A-Za-z])(dispatch|subagent)(?![A-Za-z])|让\s*(子\s*)?agent\s*(去|来)?/i,
    decisiveEligible: true,
    conf: "high",
    derive: () => ({ rule: "R06", source: "U", tag: "model-routing", conf: "medium", baseConf: "medium" }),
  },
  {
    id: "R07",
    tag: "frozen-files",
    re: /tests\/fixtures|golden|金样本|快照文件|UPDATE_\w*GOLDEN/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R08",
    tag: "deletion",
    re: /删(除|掉)|(?<![A-Za-z])(rm|git rm|git clean)(?![A-Za-z])|清(理|空)(掉)?\s*\S|移除/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R09",
    tag: "dependencies",
    re: /(安装|升级|加|引入|删)\s*(个|一个)?\s*(依赖|包|peer)|npm (i|install|add)|pnpm add|yarn add|package\.json/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R14",
    tag: "memory-system",
    re: /记忆|(?<![A-Za-z])memory(?![A-Za-z])|\/mem(?![A-Za-z])|记住|写进记忆/i,
    decisiveEligible: false,
    conf: "high",
  },
  {
    id: "R15",
    tag: "session-context",
    re: /上下文|compact|switch_context|交接|handoff/i,
    decisiveEligible: false,
    conf: "medium",
  },
  {
    id: "R16",
    tag: "ci",
    re: /(?<![A-Za-z])ci(?![A-Za-z])|actions|流水线|gh run|绿了没/i,
    decisiveEligible: false,
    conf: "medium",
  },
  {
    id: "R20-verb",
    tag: "credentials",
    re: /(配置|设置|轮换|更新|填)\s*(token|key|密钥|凭证)/i,
    decisiveEligible: true,
    conf: "high",
  },
  {
    id: "R20-noun",
    tag: "credentials",
    re: /(?<![A-Za-z])(token|api[ _-]?key|secret|ssh[ -]?key|\.env|auth\.json|\.pem)(?![A-Za-z])|密钥|凭证|密码/i,
    decisiveEligible: false,
    conf: "high",
  },
  {
    id: "R22",
    tag: "git-history",
    re: /rebase|reset\s*(--hard)?|cherry-?pick|squash|amend|force[- ]?push|push\s+-f|改写历史|回滚(提交|到)|revert|切(换)?(到)?分支|checkout|stash|合并分支|(?<![A-Za-z])merge(?![A-Za-z])/i,
    decisiveEligible: true,
    conf: "high",
  },
];

// ───────────────────────────── 单条规则求值（§3.2） ─────────────────────────────

function evalClauseRule(def: ClauseRuleDef, clauses: readonly ClauseInfo[]): ScoredHit | undefined {
  for (const clause of clauses) {
    const re = new RegExp(def.re.source, def.re.flags.replace("g", ""));
    const m = re.exec(clause.text);
    if (m === null) continue;
    const negated = negationWithinWindow(clause.text, m.index);
    const decisive = def.decisiveEligible && clause.imperative && !clause.question && !negated;
    const conf: Confidence = decisive ? "high" : def.decisiveEligible ? "medium" : def.conf;
    const hit: ScoredHit = {
      rule: def.id,
      source: "U",
      tag: def.tag,
      conf,
      baseConf: def.conf,
      ...(decisive ? { decisive: true as const } : {}),
      ...(clause.question ? { question: true as const } : {}),
      ...(negated ? { negated: true as const } : {}),
    };
    return hit;
  }
  return undefined;
}

/** U 层固定规则表（R01-R03、R05-R09、R14-R16、R20、R22）+ R05 的派生 R06。 */
function uRules(prompt: string): { hits: ScoredHit[]; modifiers: Modifier[] } {
  const clauses = splitClauses(prompt);
  const hits: ScoredHit[] = [];
  const modifiers: Modifier[] = [];
  for (const def of U_RULES) {
    const hit = evalClauseRule(def, clauses);
    if (hit === undefined) continue;
    hits.push(hit);
    if (hit.negated === true) modifiers.push({ rule: hit.rule, kind: "negate", tags: [hit.tag] });
    if (hit.question === true) modifiers.push({ rule: hit.rule, kind: "question", tags: [hit.tag] });
    if (def.derive !== undefined) {
      const derived = def.derive(hit);
      if (derived !== undefined) hits.push(derived);
    }
  }
  // 只读 / 取消（全文级，§3.1）。
  if (readonlyIntent(prompt)) modifiers.push({ rule: "readonly", kind: "readonly", tags: WRITE_ACTION_TAGS });
  if (cancelIntent(prompt)) modifiers.push({ rule: "cancel", kind: "cancel", tags: "all" });
  return { hits, modifiers };
}

// ───────────────────────────── R07/R09 的 T 变体 + R10（todo） ─────────────────────────────

const TESTING_TODO_RE = /测试|test|vitest|flake/i;
const FROZEN_TODO_RE = /tests\/fixtures|golden|金样本|快照文件|UPDATE_\w*GOLDEN/i;
const DEPS_TODO_RE =
  /(安装|升级|加|引入|删)\s*(个|一个)?\s*(依赖|包|peer)|npm (i|install|add)|pnpm add|yarn add|package\.json/i;

function todoRules(todo: PredictInput["todo"]): readonly ScoredHit[] {
  const out: ScoredHit[] = [];
  const inProgress = todo.filter((t) => t.status === "in_progress");
  const todoIds = (re: RegExp): readonly number[] => inProgress.filter((t) => re.test(t.subject)).map((t) => t.id);
  const frozenIds = todoIds(FROZEN_TODO_RE);
  if (frozenIds.length > 0) {
    out.push({
      rule: "R07-T",
      source: "T",
      tag: "frozen-files",
      conf: "high",
      baseConf: "high",
      evidence: { todoIds: frozenIds, jobShapes: [] },
    });
  }
  const depsIds = todoIds(DEPS_TODO_RE);
  if (depsIds.length > 0) {
    out.push({
      rule: "R09-T",
      source: "T",
      tag: "dependencies",
      conf: "high",
      baseConf: "high",
      evidence: { todoIds: depsIds, jobShapes: [] },
    });
  }
  const testIds = todoIds(TESTING_TODO_RE);
  if (testIds.length > 0) {
    out.push({
      rule: "R10",
      source: "T",
      tag: "testing",
      conf: "medium",
      baseConf: "medium",
      evidence: { todoIds: testIds, jobShapes: [] },
    });
  }
  return out;
}

// ───────────────────────────── H 规则（recentTools，§3.2） ─────────────────────────────

const TESTING_SHAPE_RE = /(^|\s)(vitest|test)(\s|$)/i;
const GIT_HISTORY_SHAPES = new Set([
  "git rebase",
  "git reset",
  "git cherry-pick",
  "git stash",
  "git checkout",
  "git switch",
  "git merge",
]);

function hRules(recentTools: readonly ToolLite[]): readonly ScoredHit[] {
  const out: ScoredHit[] = [];

  // R11: 上一 run ≥3 次 edit/write 落在 pathClass=src，其后没有 testing 形状的 bash。
  const editWriteSrc = recentTools.filter((t) => (t.tool === "edit" || t.tool === "write") && t.pathClass === "src");
  if (editWriteSrc.length >= 3) {
    const lastEditIdx = recentTools.lastIndexOf(editWriteSrc[editWriteSrc.length - 1]!);
    const hasTestingAfter = recentTools
      .slice(lastEditIdx + 1)
      .some((t) => t.tool === "bash" && t.shape !== undefined && TESTING_SHAPE_RE.test(t.shape));
    if (!hasTestingAfter) {
      out.push({ rule: "R11", source: "H", tag: "testing", conf: "medium", baseConf: "medium" });
      out.push({ rule: "R11", source: "H", tag: "build", conf: "low", baseConf: "low" });
    }
  }

  // R21: 上一 run 有 read/edit/write 落在 pathClass=credentials。
  if (recentTools.some((t) => ["read", "edit", "write"].includes(t.tool) && t.pathClass === "credentials")) {
    out.push({ rule: "R21", source: "H", tag: "credentials", conf: "medium", baseConf: "medium" });
  }

  // R23: 上一 run 有 git-history 形状的 bash 且 isError=true。
  const historyError = recentTools.find(
    (t) => t.tool === "bash" && t.isError === true && t.shape !== undefined && GIT_HISTORY_SHAPES.has(t.shape),
  );
  if (historyError !== undefined) {
    out.push({
      rule: "R23",
      source: "H",
      tag: "git-history",
      conf: "medium",
      baseConf: "medium",
      evidence: { todoIds: [], jobShapes: [historyError.shape!] },
    });
  }

  return out;
}

// ───────────────────────────── W 规则（git/workspace，§3.2） ─────────────────────────────

function wRules(input: PredictInput): readonly ScoredHit[] {
  const out: ScoredHit[] = [];
  // R12: dirty=true ⇒ git-commit low（§4.3 的"提交一下，dirty"验算要求与 U
  // 层 R02 noisy-OR 叠加，故不按 R02/R03 命中与否做门控——见模块头注释）。
  if (input.git?.dirty === true) {
    out.push({ rule: "R12", source: "W", tag: "git-commit", conf: "low", baseConf: "low" });
  }
  // R13: branch ∈ {master, main} ⇒ git-push low。
  const branch = input.git?.branch;
  if (branch === "master" || branch === "main") {
    out.push({
      rule: "R13",
      source: "W",
      tag: "git-push",
      conf: "low",
      baseConf: "low",
      evidence: { todoIds: [], jobShapes: [], branch },
    });
  }
  return out;
}

// ───────────────────────────── R19 自然语言命令（§3.5） ─────────────────────────────

function nlCommandRules(prompt: string, tax: Taxonomy | undefined): readonly ScoredHit[] {
  if (tax === undefined) return [];
  const clauses = splitClauses(prompt);
  const out: ScoredHit[] = [];
  for (const hit of extractNlCommandHits(prompt, tax)) {
    if (hit.via === "code") {
      const clause = clauses.find((c) => hit.at >= c.start && hit.at < c.end);
      const negated = negationWithinWindow(prompt, hit.at);
      const decisive = clause !== undefined && clause.imperative && !clause.question && !negated;
      out.push({
        rule: "R19",
        source: "U",
        tag: hit.tag,
        conf: decisive ? "high" : "medium",
        baseConf: "high",
        ...(decisive ? { decisive: true as const } : {}),
        ...(negated ? { negated: true as const } : {}),
      });
    } else {
      out.push({ rule: "R19", source: "U", tag: hit.tag, conf: "medium", baseConf: "medium" });
    }
  }
  return out;
}

// ───────────────────────────── 入口（§3） ─────────────────────────────

/** 全部规则（R01-R23，不含 R04 状态约束）一次求值。taxonomy 省略时跳过
 *  R19（自然语言命令提取需要 tag 的 `match.commands`）。 */
export function runRules(input: PredictInput, tax?: Taxonomy): RulesOutput {
  const { hits: uHits, modifiers: uModifiers } = uRules(input.prompt);
  const hits: ScoredHit[] = [
    ...uHits,
    ...todoRules(input.todo),
    ...hRules(input.recentTools),
    ...wRules(input),
    ...nlCommandRules(input.prompt, tax),
  ];
  // R19 的否定：对命中补一条全局 negate modifier（code 变体，与 U_RULES 对齐）。
  const modifiers: Modifier[] = [...uModifiers];
  for (const hit of hits) {
    if (hit.rule === "R19" && hit.negated === true) modifiers.push({ rule: "R19", kind: "negate", tags: [hit.tag] });
  }
  return { hits, modifiers };
}

/** 导出给 state.ts 复用的 shape 辅助（S 判定走同一本地口径，§3.4）。 */
export { allShapes };
