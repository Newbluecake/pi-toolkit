/**
 * topic-switch · cheap-model relevance judge (plan.md §P1 "judge.ts", arch §5).
 *
 * Pi-free: the LLM call itself is a `JudgePort` (P3b binds it to
 * `ctx.modelRegistry.streamSimple` with `reasoning: JUDGE_REASONING`, falling back to
 * `complete` on registries without it). `judgeRelevance` owns the hard
 * timeout: an internal AbortController driven by BOTH the external signal and
 * the clock timer, plus an outer `withDeadline(timeoutMs+500)` backstop for
 * providers that ignore abort. A late result after abort/timeout is discarded.
 */

import { parseStrictModelRef } from "../config/model-hint.js";
import { withDeadline } from "../core/deadline.js";
import type { Clock, TimerHandle } from "../core/clock.js";

/** D3 翻转点：配置模型与 title 模型都不可用时是否回退会话模型（唯一一处定义）。 */
export const JUDGE_SESSION_MODEL_FALLBACK: boolean = true;

/** 2026-10-16 64→1024：64 时 glm-5.3-flash（推理模型）的思考吃光额度，20–33% 调用空回复或截断 JSON，
 *  线上回落到更偏 related 的后备模型；512 时 glm 失败归零，deepseek-flash@minimal 仍 3/24 截断 ⇒ 1024。 */
export const JUDGE_MAX_TOKENS = 1024;

/** 判断调用的思考等级（2026-10-16 用户：速度优先于准确）：minimal 下 deepseek-flash 88%、中位 ~1.8s；
 *  1024 token 余量避免 minimal 思考 + JSON 在 512 时偶发截断（实测 512 下 3/24 失败）。 */
export const JUDGE_REASONING = "minimal" as const;

/** prompt 组装上限（frozen；码点截断）。 */
export const JUDGE_LIMITS = Object.freeze({
  compactionSummaryChars: 1500,
  recentUserMessages: 3,
  recentUserMessageChars: 400,
  lastAssistantChars: 400,
  requestChars: 2000,
});

export type JudgeModelOrigin = "configured" | "title" | "session";

export interface JudgeModelRef {
  provider: string;
  id: string;
  origin: JudgeModelOrigin;
}

export interface JudgeModelChainInput {
  /** settings `topicSwitch.models`（逐项已 trim）；逗号/JSON 数组已在 settings 解析层归一。 */
  configured: readonly string[];
  /** settings `title.model`。 */
  title: string;
  /** 当前会话模型 `provider/id`。 */
  session: string;
}

/** D3 链：configured（按序）→ title → session（JUDGE_SESSION_MODEL_FALLBACK=false 时截到前两档）。strict 解析、去重、保序。 */
export function judgeModelChain(i: JudgeModelChainInput): readonly JudgeModelRef[] {
  const out: JudgeModelRef[] = [];
  const push = (raw: string, origin: JudgeModelOrigin): void => {
    const ref = typeof raw === "string" && raw !== "" ? parseStrictModelRef(raw) : undefined;
    if (!ref) return;
    if (out.some((r) => r.provider === ref.provider && r.id === ref.id)) return;
    out.push({ provider: ref.provider, id: ref.id, origin });
  };
  for (const entry of i.configured) push(entry, "configured");
  push(i.title, "title");
  if (JUDGE_SESSION_MODEL_FALLBACK) push(i.session, "session");
  return out;
}

export interface JudgeInput {
  sessionName?: string;
  compactionSummary?: string;
  recentUserMessages: string[];
  lastAssistantExcerpt?: string;
  request: string;
  imageCount: number;
}

/**
 * 判据变体（评测 `scripts/exp/topic-judge-eval/`）：`v2` = 线上默认（2026-10-16 起，见
 * `JUDGE_DEFAULT_VARIANT`）——只有「答好必须依赖本会话自身状态」才算 related，仅同一仓库/
 * 模块/功能域不算；`v1` = 原判据（字节不变），只保留供离线对比。
 */
export const JUDGE_CRITERION_VARIANTS: readonly ["v1", "v2"] = Object.freeze(["v1", "v2"] as const);

export type JudgeCriterionVariant = (typeof JUDGE_CRITERION_VARIANTS)[number];

/** 码点截断（UTF-16 slice 会切碎代理对）。 */
function clip(text: string, maxChars: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= maxChars) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** v1 现行判据（字节冻结：线上行为与既有测试都锚定在这段文本上）。 */
const JUDGE_SYSTEM_PROMPT_V1 =
  "判断 NEW REQUEST 是否延续 CURRENT CONVERSATION。只要它引用、依赖或明显受益于先前上下文（同一任务、同一文件或功能、" +
  "后续、修先前的产出），就判 related=true。只有完全自足、不需要那些上下文的新任务才判 false。拿不准就判 true。" +
  '只输出 JSON：{"related":bool,"confidence":0..1}';

/** v2 候选判据（2026-10-16 用户报告：长单仓会话里 v1 几乎全 related）。 */
const JUDGE_SYSTEM_PROMPT_V2 =
  "判断 NEW REQUEST 是否必须依赖本会话自身的状态才能答好——即一个能读仓库文件与项目记忆的全新会话答不了或答不好。" +
  "只有当它引用或延续本会话刚产生的结果或改动（如「刚才/上面/这个/再/继续/还是不行」）、正在进行或悬而未决的工作、" +
  "正在讨论中的决策、对本会话产出的跟进或修复时，才判 related=true。" +
  "仅是同一仓库、同一模块、同一功能域或同一主题不算 related——全新会话读代码和项目记忆即可答好。" +
  "只有确实拿不准是否需要会话内状态时才判 true。" +
  '只输出 JSON：{"related":bool,"confidence":0..1}';

/** 线上判据（2026-10-16 用户拍板切 v2：24 条人工标注评测，glm v2+512 准确率 79–83% vs v1 63–74%，
 *  漏报 9→4、误报 0–1；v1 保留供 scripts/exp/topic-judge-eval 对比）。 */
export const JUDGE_DEFAULT_VARIANT: JudgeCriterionVariant = "v2";

/** 判定 prompt（≤2k 输入 token 量级）：system 定标准，user 分块给证据。variant 只换 system 判据，证据块逐字节相同。 */
export function buildJudgePrompt(
  i: JudgeInput,
  variant: JudgeCriterionVariant = JUDGE_DEFAULT_VARIANT,
): { systemPrompt: string; userPrompt: string } {
  const blocks: string[] = [];
  if (typeof i.sessionName === "string" && i.sessionName.trim() !== "") {
    blocks.push(`Session title: ${clip(i.sessionName.trim(), JUDGE_LIMITS.lastAssistantChars)}`);
  }
  if (typeof i.compactionSummary === "string" && i.compactionSummary.trim() !== "") {
    blocks.push(`Latest compaction summary:\n${clip(i.compactionSummary, JUDGE_LIMITS.compactionSummaryChars)}`);
  }
  const recent = i.recentUserMessages.slice(-JUDGE_LIMITS.recentUserMessages);
  if (recent.length > 0) {
    const lines = recent.map((m) => `- ${clip(m, JUDGE_LIMITS.recentUserMessageChars)}`);
    blocks.push(`Recent user messages:\n${lines.join("\n")}`);
  }
  if (typeof i.lastAssistantExcerpt === "string" && i.lastAssistantExcerpt.trim() !== "") {
    blocks.push(`Last assistant reply:\n${clip(i.lastAssistantExcerpt, JUDGE_LIMITS.lastAssistantChars)}`);
  }
  const request = clip(i.request, JUDGE_LIMITS.requestChars);
  const imageNote = i.imageCount > 0 ? ` [${i.imageCount} images attached]` : "";
  blocks.push(`NEW REQUEST:\n${request}${imageNote}`);
  return {
    systemPrompt: variant === "v2" ? JUDGE_SYSTEM_PROMPT_V2 : JUDGE_SYSTEM_PROMPT_V1,
    userPrompt: blocks.join("\n\n"),
  };
}

/** 取第一个平衡的 `{…}` 做 JSON.parse；related 必须 boolean、confidence 必须有限数再 clamp 到 [0,1]。 */
export function parseJudgeReply(text: string): { related: boolean; confidence: number } | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let idx = start; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (ch === undefined) return undefined;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.slice(start, idx + 1));
        } catch {
          return undefined;
        }
        if (parsed === null || typeof parsed !== "object") return undefined;
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.related !== "boolean") return undefined;
        const confidence = rec.confidence;
        if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
        return { related: rec.related, confidence: Math.min(1, Math.max(0, confidence)) };
      }
    }
  }
  return undefined;
}

export type JudgeVerdict =
  | { kind: "ok"; related: boolean; confidence: number; ms: number }
  | { kind: "timeout" | "error" | "parse-error" | "aborted" | "no-model"; ms: number };

/** P3b 绑定到 `modelRegistry.streamSimple(model, {systemPrompt, messages}, {signal, maxTokens, reasoning})`（无则 `complete`）。 */
export interface JudgePort {
  complete(systemPrompt: string, userPrompt: string, signal: AbortSignal): Promise<string>;
}

/**
 * 带硬超时的相关性判定。内部 AbortController 同时受外部 `signal` 与
 * `clock.setTimer(timeoutMs)` 驱动；外层 `withDeadline(timeoutMs+500)` 兜底
 * 不响应 abort 的 provider。超时/abort 之后迟到的结果直接丢弃。
 */
export async function judgeRelevance(
  port: JudgePort,
  input: JudgeInput,
  timeoutMs: number,
  clock: Clock,
  signal: AbortSignal,
): Promise<JudgeVerdict> {
  const start = clock.now();
  const elapsed = (): number => clock.now() - start;
  if (signal.aborted) return { kind: "aborted", ms: elapsed() };

  const ac = new AbortController();
  let firstCause: "aborted" | "timeout" | undefined;
  let cleanup = (): void => {};
  const cancel = new Promise<"aborted" | "timeout">((resolveCancel) => {
    const settle = (cause: "aborted" | "timeout"): void => {
      if (firstCause !== undefined) return;
      firstCause = cause;
      ac.abort();
      resolveCancel(cause);
    };
    const onAbort = (): void => settle("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: TimerHandle | undefined;
    if (timeoutMs > 0) {
      timer = clock.setTimer(timeoutMs, () => settle("timeout"));
    }
    cleanup = () => {
      if (timer !== undefined) clock.clearTimer(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });

  try {
    const { systemPrompt, userPrompt } = buildJudgePrompt(input);
    const wrapped = withDeadline(
      port.complete(systemPrompt, userPrompt, ac.signal),
      timeoutMs + 500,
      clock,
      "topic-switch judge",
    );
    const raced = await Promise.race([wrapped, cancel]);
    if (raced === "aborted" || raced === "timeout") return { kind: raced, ms: elapsed() };
    if (!raced.ok) {
      return { kind: raced.reason === "timeout" ? "timeout" : "error", ms: elapsed() };
    }
    const parsed = parseJudgeReply(raced.value);
    if (parsed === undefined) return { kind: "parse-error", ms: elapsed() };
    return { kind: "ok", related: parsed.related, confidence: parsed.confidence, ms: elapsed() };
  } catch {
    return { kind: "error", ms: elapsed() };
  } finally {
    cleanup();
  }
}

/** Failover per-attempt budget floor: each attempt gets at least this much of the total budget. */
export const JUDGE_ATTEMPT_FLOOR_MS = 1_500;

/** Per-attempt budget inside the TOTAL judge budget: `min(remaining, max(floor, ceil(total/2)))`. */
export function judgeAttemptBudgetMs(totalMs: number, remainingMs: number): number {
  const cap = Math.max(JUDGE_ATTEMPT_FLOOR_MS, Math.ceil(totalMs / 2));
  return Math.max(0, Math.min(remainingMs, cap));
}

/** One candidate model in the failover chain: its resolved ref plus the port that calls it. */
export interface JudgeAttempt {
  ref: JudgeModelRef;
  port: JudgePort;
}

/** Per-attempt diagnostics (model identity + outcome; no paths, no secrets). */
export interface JudgeAttemptOutcome {
  provider: string;
  id: string;
  origin: JudgeModelOrigin;
  kind: JudgeVerdict["kind"];
  ms: number;
}

export interface JudgeFailoverResult {
  verdict: JudgeVerdict;
  attempts: readonly JudgeAttemptOutcome[];
}

/**
 * 按序故障转移的判定链：在总预算 `totalTimeoutMs` 内逐个尝试 `attempts`，每次尝试拿
 * `judgeAttemptBudgetMs(total, remaining)` 毫秒（单次 `judgeRelevance` 自带 abort/timer/
 * `withDeadline` 兕底，超时后的迟到结果丢弃）。error/timeout/parse-error ⇒ 下一个模型；
 * 外部 abort ⇒ 立即停止（不再尝试后续模型）；成功解析 ⇒ 返回。全部失败 ⇒ 返回最后一次
 * 尝试的失败类型（`ms` 改写为总耗时，看门狗口径不变）；空链 ⇒ `no-model`。
 */
export async function judgeWithFailover(
  attempts: readonly JudgeAttempt[],
  input: JudgeInput,
  totalTimeoutMs: number,
  clock: Clock,
  signal: AbortSignal,
): Promise<JudgeFailoverResult> {
  const start = clock.now();
  const outcomes: JudgeAttemptOutcome[] = [];
  let last: JudgeVerdict | undefined;
  for (const attempt of attempts) {
    const remaining = totalTimeoutMs - (clock.now() - start);
    if (remaining <= 0) break;
    const verdict = await judgeRelevance(
      attempt.port,
      input,
      judgeAttemptBudgetMs(totalTimeoutMs, remaining),
      clock,
      signal,
    );
    outcomes.push({
      provider: attempt.ref.provider,
      id: attempt.ref.id,
      origin: attempt.ref.origin,
      kind: verdict.kind,
      ms: verdict.ms,
    });
    last = verdict;
    if (verdict.kind === "aborted") break; // external abort ⇒ stop immediately, no further attempts
    if (verdict.kind === "ok") break;
  }
  const ms = clock.now() - start;
  if (last === undefined) return { verdict: { kind: "no-model", ms }, attempts: outcomes };
  return { verdict: { ...last, ms }, attempts: outcomes };
}
