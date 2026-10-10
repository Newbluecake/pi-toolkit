/**
 * topic-switch · cheap-model relevance judge (plan.md §P1 "judge.ts", arch §5).
 *
 * Pi-free: the LLM call itself is a `JudgePort` (P3b binds it to
 * `ctx.modelRegistry.complete`, title 先例). `judgeRelevance` owns the hard
 * timeout: an internal AbortController driven by BOTH the external signal and
 * the clock timer, plus an outer `withDeadline(timeoutMs+500)` backstop for
 * providers that ignore abort. A late result after abort/timeout is discarded.
 */

import { parseStrictModelRef } from "../config/model-hint.js";
import { withDeadline } from "../core/deadline.js";
import type { Clock, TimerHandle } from "../core/clock.js";

/** D3 翻转点：配置模型与 title 模型都不可用时是否回退会话模型（唯一一处定义）。 */
export const JUDGE_SESSION_MODEL_FALLBACK: boolean = true;

export const JUDGE_MAX_TOKENS = 64;

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

/** 判定 prompt（≤2k 输入 token 量级）：system 定标准，user 分块给证据。 */
export function buildJudgePrompt(i: JudgeInput): { systemPrompt: string; userPrompt: string } {
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
    systemPrompt:
      "判断 NEW REQUEST 是否延续 CURRENT CONVERSATION。只要它引用、依赖或明显受益于先前上下文（同一任务、同一文件或功能、" +
      "后续、修先前的产出），就判 related=true。只有完全自足、不需要那些上下文的新任务才判 false。拿不准就判 true。" +
      '只输出 JSON：{"related":bool,"confidence":0..1}',
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

/** P3b 绑定到 `modelRegistry.complete(model, {systemPrompt, messages}, {signal, maxTokens})`。 */
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
