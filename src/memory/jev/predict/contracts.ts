// P 层（记忆预测性预注入）核心契约 — plan.md v3.2 §2.1 逐字抄录。
//
// 本包（P1a）是纯 pi-free 预测模块：规则、状态约束、承接、投票、选条目。
// 不含 deepseek/llm/flight/ledger/outbound（§11.2 P2）。对 `jev/contracts.ts`
// 的追加（InjectLayer "P"、parts、pInjectedAt 等）属后续接线包，本包不改它，
// 类型自包含在这里。无模块级可变状态（I4）。

// ───────────────────────────── 信号源与权重（§2.1） ─────────────────────────────

/** T=todo · H=recentTools · W=workspace(git/jobs) · U=prompt · M=deepseek · C=承接。 */
export type SignalSource = "T" | "H" | "W" | "U" | "M" | "C";

/** high=0.9 · medium=0.6 · low=0.3（§2.1）。 */
export type Confidence = "high" | "medium" | "low";

export const SOURCE_WEIGHT = { T: 1.0, H: 0.9, W: 0.85, U: 0.8, M: 0.85, C: 1.0 } as const;

export const CONFIDENCE_VALUE = { high: 0.9, medium: 0.6, low: 0.3 } as const;

/** decisive 命中单独计 0.9（§3.2）。 */
export const DECISIVE_SCORE = 0.9;

// ───────────────────────────── 输入（§2.1 PredictInput） ─────────────────────────────

export interface PredictInput {
  /** strip skill 块；≤4000 码点（signals.ts 负责截断）。 */
  readonly prompt: string;
  /** ≤1000 码点。 */
  readonly previousPrompt?: string;
  /** ≤12，in_progress 优先；subject ≤200 码点。 */
  readonly todo: readonly TodoLite[];
  /** 上一 run，≤20。 */
  readonly recentTools: readonly ToolLite[];
  readonly git?: { branch?: string; dirty?: boolean };
  /** ≤10，command ≤500 码点。 */
  readonly bashJobs: readonly { status: "running" | "done" | "failed" | "other"; command: string }[];
  /** 夹到 0–99。 */
  readonly activeSubagents: number;
  readonly session: "main" | "child";
  readonly carry?: CarryState;
}

export interface TodoLite {
  readonly id: number;
  readonly subject: string;
  readonly status: "pending" | "in_progress";
}

export interface ToolLite {
  readonly tool: string;
  readonly shape?: string;
  readonly pathClass?: PathClass;
  readonly isError?: boolean;
}

export type PathClass = "src" | "tests" | "fixtures" | "docs" | "config" | "credentials" | "pkg" | "other";

// ───────────────────────────── 规则命中与修饰（§2.1） ─────────────────────────────

export interface RuleHit {
  readonly rule: string;
  readonly source: SignalSource;
  readonly tag: string;
  readonly conf: Confidence;
  readonly decisive?: true;
}

/** 规则引擎内部使用的富命中：携带定位/上下文标志与来源证据（对外契约仍是
 *  RuleHit；evidence 只随 final 记录落盘，§3.3）。 */
export interface ScoredHit extends RuleHit {
  /** 该命中所在的分句是否为疑问句（§3.1）。 */
  readonly question?: true;
  /** 该命中被分句内否定词覆盖（§3.1 否定窗口）。 */
  readonly negated?: true;
  /** 规则表原始置信（decisive 失效降级前的值）。 */
  readonly baseConf: Confidence;
  /** 来源证据（T 命中 → todoIds；W/R13 → branch；H 形状命中 → jobShapes）。 */
  readonly evidence?: Evidence;
  /** 承接（C）命中的显式分数 — 已含 ×0.95 重验证衰减；其余来源不设。 */
  readonly score?: number;
}

export interface Modifier {
  readonly rule: string;
  readonly kind: "negate" | "readonly" | "question" | "cancel";
  readonly tags: readonly string[] | "all";
}

export interface TagScore {
  readonly tag: string;
  readonly score: number;
  readonly sources: readonly SignalSource[];
  readonly rules: readonly string[];
}

// ───────────────────────────── 状态约束 S（§3.4）与承接（§3.3） ─────────────────────────────

export interface StateConstraint {
  readonly kind: "release-in-progress";
  /** evidence = job shape。 */
  readonly evidence: string;
}

/** final 记录里每个 tag 携带的来源证据（§3.3 重新验证用）。 */
export interface Evidence {
  readonly todoIds: readonly number[];
  readonly jobShapes: readonly string[];
  readonly branch?: string;
}

export interface CarryState {
  readonly tags: readonly (TagScore & { evidence: Evidence })[];
  /** 已连续承接的次数（≤3，§3.3）。 */
  readonly carries: number;
}

export interface PredictResult {
  /** 降序，≤6，score ≥0.3（§4.1 第 6 步）。 */
  readonly tags: readonly TagScore[];
  readonly state: readonly StateConstraint[];
  readonly origin: "rules" | "rules+model" | "rules+cache";
  readonly uncertain: boolean;
  readonly modifiers: readonly Modifier[];
}
