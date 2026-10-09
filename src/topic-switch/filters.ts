/**
 * topic-switch · zero-cost message filters (plan.md §P1 "filters.ts").
 *
 * Pure string classification, runs before any I/O in the gate. Order:
 * prefix (`/`, `//`, `!`) → short (code points < minChars; pure images are
 * short too) → continuation (whole-sentence short-reply table OR anaphora).
 * Exported lookup tables are frozen arrays + predicate functions (rule #14:
 * never export Set/Map).
 */

import type { InputSourceLike } from "./types.js";

/** I1: the input handler only holds `interactive`/`rpc`; web prompts are claimed at the dispatch point (origin "web"). */
export function sourceAllowed(origin: "input" | "web", source: InputSourceLike): boolean {
  return origin === "web" ? true : source === "interactive" || source === "rpc";
}

/** 短回复整句表（去尾标点、小写后整句相等才算命中）。`方案X`/`选X`/纯数字是模式，由 isShortReply 处理。 */
export const SHORT_REPLY_TABLE: readonly string[] = Object.freeze([
  "继续",
  "好的",
  "好",
  "嗯",
  "行",
  "可以",
  "ok",
  "okay",
  "yes",
  "no",
  "push",
  "commit",
  "merge",
  "lgtm",
]);

/** CJK 指代词：trim 后前 12 码点内出现任一子串 ⇒ 承接。 */
export const ANAPHORA_CJK: readonly string[] = Object.freeze([
  "这个",
  "那个",
  "刚才",
  "上面",
  "上述",
  "前面",
  "接着",
  "还是",
  "再",
  "它",
  "同样",
  "上一个",
  "然后",
]);

/** EN 指代词：trim 后前 3 词内整词命中（不分大小写）。 */
export const ANAPHORA_EN: readonly string[] = Object.freeze([
  "this",
  "that",
  "it",
  "above",
  "again",
  "same",
  "also",
  "continue",
  "previous",
]);

/** UTF-16 string → code-point array length（码点数，不是 UTF-16 单元数）。 */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** 前 maxCp 个码点组成的子串（码点边界安全）。 */
function firstCodePoints(text: string, maxCp: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= maxCp) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** 去掉尾部标点与空白（可叠加多枚，如「好的。。！」→「好的」）。 */
function stripTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (ch === undefined) break;
    // CJK/ASCII 常见收尾标点 + 各类省略/波浪/引号/括号；空白也剥。
    if (!/[\s。．.?？!！,，、;；:：~～…"'”’»)\]）】》]/.test(ch)) break;
    end -= 1;
  }
  return text.slice(0, end);
}

/** 整句短回复：去尾标点、小写后命中表项，或匹配 方案X / 选X / 纯数字 模式。 */
export function isShortReply(text: string): boolean {
  const normalized = stripTrailingPunctuation(text.trim()).toLowerCase();
  if (normalized === "") return false;
  if (SHORT_REPLY_TABLE.includes(normalized)) return true;
  if (/^方案[一二三四五1-9]$/.test(normalized)) return true;
  if (/^选[一二三abc1-9]$/.test(normalized)) return true;
  return /^[0-9]+$/.test(normalized);
}

/** 指代词承接：CJK 前 12 码点内子串，或 EN 前 3 词内整词（不分大小写）。 */
export function hasAnaphora(text: string): boolean {
  const trimmed = text.trim();
  const head = firstCodePoints(trimmed, 12);
  for (const word of ANAPHORA_CJK) {
    if (head.includes(word)) return true;
  }
  const firstWords = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.toLowerCase());
  for (const word of ANAPHORA_EN) {
    if (firstWords.includes(word)) return true;
  }
  return false;
}

export type TextClass = "ok" | "prefix" | "short" | "continuation";

/** 门 2b/2c 文本分类。纯图片（文本为空）也 short；图片数不 rescue 短文本。 */
export function classifyText(text: string, imageCount: number, minChars: number): TextClass {
  void imageCount; // 显式保留 plan 签名：图片不参与长度判定（纯图片 ⇒ 文本为空 ⇒ short）
  const trimmed = text.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return "prefix";
  if (codePointLength(trimmed) < minChars) return "short";
  if (isShortReply(trimmed) || hasAnaphora(trimmed)) return "continuation";
  return "ok";
}

/** 门 2d：最近 assistant 文本（trimEnd）以 `?`/`？` 结尾，或上一轮有 ask_user 工具调用。 */
export function assistantAsked(text: string | undefined, askedUser: boolean): boolean {
  if (askedUser) return true;
  if (typeof text !== "string") return false;
  const trimmed = text.trimEnd();
  return trimmed.endsWith("?") || trimmed.endsWith("？");
}
