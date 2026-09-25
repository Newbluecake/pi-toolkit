/**
 * Experiment 6 (docs/dev/consult/exp-trim/README.md) — shared helpers:
 * session context loading, chars→tokens calibration, and the T1/T2/T3 trim
 * rules. Used by both the offline Part A estimator and the online Part B
 * runner so the simulated and the real trim are the same code.
 *
 * Pure experiment code: imports pi's SessionManager only, never src/**.
 */
import { readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type AnyMsg = Record<string, any>;
export type Rule = "T1" | "T2" | "T3";

export const K_PROTECTED = 2;
export const T1_MIN_TOKENS = 1000;
export const QUESTION_TOKENS = 400;
export const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

export function loadContext(file: string): { messages: AnyMsg[]; entries: AnyMsg[] } {
  const sm = SessionManager.open(file, undefined, undefined);
  const ctx = sm.buildSessionContext() as { messages: AnyMsg[] };
  return { messages: ctx.messages, entries: sm.getEntries() as AnyMsg[] };
}

/** prompt tokens of one assistant request: input + cacheRead + cacheWrite (all three — never drop cache tokens). */
export function promptTokens(m: AnyMsg): number | undefined {
  const u = m?.usage;
  if (!u) return undefined;
  const p = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return p > 0 ? p : undefined;
}

export interface CharBreakdown {
  user: number;
  assistantText: number;
  thinking: number;
  toolCall: number;
  toolResult: number;
}

function textLen(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content)
    if (b && typeof b === "object" && typeof (b as any).text === "string") n += (b as any).text.length;
  return n;
}

export function messageChars(m: AnyMsg): CharBreakdown {
  const out: CharBreakdown = { user: 0, assistantText: 0, thinking: 0, toolCall: 0, toolResult: 0 };
  if (m.role === "assistant") {
    for (const b of m.content ?? []) {
      if (b.type === "text") out.assistantText += (b.text ?? "").length;
      else if (b.type === "thinking") out.thinking += (b.thinking ?? "").length;
      else if (b.type === "toolCall") out.toolCall += (b.name ?? "").length + JSON.stringify(b.arguments ?? {}).length;
    }
  } else if (m.role === "toolResult") out.toolResult += textLen(m.content);
  else out.user += textLen(m.content); // user / custom / bashExecution / summaries → "user" bucket
  return out;
}

export function sumChars(ms: AnyMsg[], withThinking: boolean): number {
  let n = 0;
  for (const m of ms) {
    const c = messageChars(m);
    n += c.user + c.assistantText + c.toolCall + c.toolResult + (withThinking ? c.thinking : 0);
  }
  return n;
}

export interface Calibration {
  ok: boolean;
  reason?: string;
  r: number; // tokens per char
  overhead: number; // system prompt + tool definitions, tokens
  withThinking: boolean;
  mape: number;
  mapeAlt: number;
  pFirst: number;
  pLast: number;
  assistantCount: number;
}

/** README §2: r from (P_last − P_first) over the chars in between; thinking in/out chosen by per-turn ΔP MAPE. */
export function calibrate(messages: AnyMsg[]): Calibration {
  const idx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant" && promptTokens(m) !== undefined) idx.push(i);
  });
  const bad = (reason: string): Calibration => ({
    ok: false,
    reason,
    r: 0,
    overhead: 0,
    withThinking: false,
    mape: NaN,
    mapeAlt: NaN,
    pFirst: 0,
    pLast: 0,
    assistantCount: idx.length,
  });
  if (idx.length < 3) return bad("fewer than 3 assistant messages with usage");
  const first = idx[0]!;
  const last = idx[idx.length - 1]!;
  const pFirst = promptTokens(messages[first])!;
  const pLast = promptTokens(messages[last])!;
  const variant = (withThinking: boolean) => {
    const cPre = sumChars(messages.slice(0, first), withThinking);
    const cPreLast = sumChars(messages.slice(0, last), withThinking);
    const r = (pLast - pFirst) / Math.max(1, cPreLast - cPre);
    const overhead = pFirst - r * cPre;
    // per-turn ΔP prediction error
    const errs: number[] = [];
    for (let k = 1; k < idx.length; k++) {
      const a = idx[k - 1]!;
      const b = idx[k]!;
      const dP = promptTokens(messages[b])! - promptTokens(messages[a])!;
      const dC = sumChars(messages.slice(a, b), withThinking);
      if (dP > 200) errs.push(Math.abs(r * dC - dP) / dP);
    }
    errs.sort((x, y) => x - y);
    const mape = errs.length ? errs[Math.floor(errs.length / 2)]! : NaN; // median abs pct error (robust)
    return { r, overhead, mape };
  };
  const a = variant(true);
  const b = variant(false);
  const hasThinking = messages.some((m) => messageChars(m).thinking > 0);
  const pickWith = hasThinking ? (Number.isNaN(b.mape) ? true : a.mape <= b.mape) : false;
  const chosen = pickWith ? a : b;
  if (!(chosen.r > 0.05 && chosen.r < 1.5)) return bad(`implausible r=${chosen.r.toFixed(3)}`);
  return {
    ok: true,
    r: chosen.r,
    overhead: Math.max(0, chosen.overhead),
    withThinking: pickWith,
    mape: chosen.mape,
    mapeAlt: pickWith ? b.mape : a.mape,
    pFirst,
    pLast,
    assistantCount: idx.length,
  };
}

export function toolArgsPreview(args: unknown, max = 120): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.path === "string") {
      const extra = [
        a.offset !== undefined ? `offset=${a.offset}` : "",
        a.limit !== undefined ? `limit=${a.limit}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `${a.path}${extra ? ` (${extra})` : ""}`.slice(0, max);
    }
    if (typeof a.command === "string") return a.command.replace(/\s+/g, " ").slice(0, max);
    if (typeof a.pattern === "string")
      return `${a.pattern}${typeof a.path === "string" ? ` in ${a.path}` : ""}`.slice(0, max);
  }
  return JSON.stringify(args ?? {})
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export function placeholder(lines: number, tokens: number, toolName: string, preview: string): string {
  return `[elided by consult fork: ${lines} lines / ~${tokens} tokens of ${toolName} ${preview} output — re-read with the read tool if you need the exact content]`;
}

export interface TrimPlan {
  rule: Rule;
  /** toolCallId → placeholder text */
  elide: Map<string, string>;
  /** indices of assistant messages whose thinking blocks get dropped (T3) */
  dropThinking: Set<number>;
  elidedToolResults: number;
  keptToolResults: number;
}

/** README §1. `r` is the session's chars→tokens ratio. */
export function planTrim(messages: AnyMsg[], rule: Rule, r: number, k = K_PROTECTED): TrimPlan {
  const assistantIdx = messages.map((m, i) => (m.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  const protectedAssistants = new Set(assistantIdx.slice(-k));
  const protectedCalls = new Set<string>();
  const callInfo = new Map<string, { name: string; args: unknown }>();
  for (const i of assistantIdx) {
    for (const b of messages[i]!.content ?? []) {
      if (b.type !== "toolCall") continue;
      callInfo.set(b.id, { name: b.name, args: b.arguments });
      if (protectedAssistants.has(i)) protectedCalls.add(b.id);
    }
  }
  const elide = new Map<string, string>();
  let kept = 0;
  for (const m of messages) {
    if (m.role !== "toolResult") continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .map((b: AnyMsg) => (typeof b.text === "string" ? b.text : ""))
      .join("");
    const tokens = Math.round(text.length * r);
    const unprotected = !protectedCalls.has(m.toolCallId);
    const hit = unprotected && (rule === "T2" ? true : tokens > T1_MIN_TOKENS);
    if (!hit) {
      kept++;
      continue;
    }
    const info = callInfo.get(m.toolCallId);
    const lines = text.length === 0 ? 0 : text.split("\n").length;
    elide.set(
      m.toolCallId,
      placeholder(lines, tokens, info?.name ?? m.toolName ?? "tool", toolArgsPreview(info?.args)),
    );
  }
  const dropThinking = new Set<number>();
  if (rule === "T3") {
    const lastA = assistantIdx[assistantIdx.length - 1];
    for (const i of assistantIdx) if (i !== lastA) dropThinking.add(i);
  }
  return { rule, elide, dropThinking, elidedToolResults: elide.size, keptToolResults: kept };
}

/** Apply a plan to an in-memory context copy (Part A estimate). */
export function applyToMessages(messages: AnyMsg[], plan: TrimPlan): AnyMsg[] {
  return messages.map((m, i) => {
    if (m.role === "toolResult" && plan.elide.has(m.toolCallId))
      return { ...m, content: [{ type: "text", text: plan.elide.get(m.toolCallId)! }] };
    if (m.role === "assistant" && plan.dropThinking.has(i))
      return { ...m, content: (m.content ?? []).filter((b: AnyMsg) => b.type !== "thinking") };
    return m;
  });
}

/** Apply a T1/T2 plan to raw session jsonl text (Part B fork copy). Returns new text + count of rewritten entries. */
export function applyToJsonl(raw: string, plan: TrimPlan): { text: string; rewritten: number } {
  if (plan.dropThinking.size > 0) throw new Error("applyToJsonl: T3 thinking drop not supported for online runs");
  let rewritten = 0;
  const out = raw.split("\n").map((line) => {
    if (!line.trim()) return line;
    const e = JSON.parse(line);
    if (e.type === "message" && e.message?.role === "toolResult" && plan.elide.has(e.message.toolCallId)) {
      e.message.content = [{ type: "text", text: plan.elide.get(e.message.toolCallId)! }];
      rewritten++;
      return JSON.stringify(e);
    }
    return line;
  });
  return { text: out.join("\n"), rewritten };
}

export function readJsonl(file: string): AnyMsg[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
