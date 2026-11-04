// 自然语言命令提取（plan.md v3.2 §3.5）。
//
// 代码片段（反引号 span、`$ ` 开头的行）用 parseShell 解析后走 matchTags 命中
// ⇒ high；散文只用 taxonomy `match.commands` 里**多词、无通配**的模式做短语
// 匹配（两侧加 `(?<![A-Za-z0-9_-])…(?![A-Za-z0-9_-])`）⇒ medium。单词程序名
// 与含 `*` 的模式不做散文匹配。用户自定义 tag 的 match.commands 自动参与。
// pi-free；无模块级可变状态（I4）。

import type { Taxonomy } from "../contracts.js";
import { matchTags } from "../match.js";
import { parseShell } from "../shell-parse.js";

export interface NlCommandHit {
  readonly tag: string;
  readonly via: "code" | "prose";
  /** 命中文本在原始 prompt 中的起始码点偏移（rules.ts 用它定位否定窗口/所在分句）。 */
  readonly at: number;
}

const CODE_SPAN_RE = /`([^`\n]+)`/g;
const DOLLAR_LINE_RE = /^[ \t]*\$[ \t]+(.+)$/gm;

/** 提取文本中的代码片段命令（反引号 span + `$ ` 行），带其在原文中的起始偏移。 */
export function codeSnippets(text: string): readonly { readonly code: string; readonly at: number }[] {
  const out: { code: string; at: number }[] = [];
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    const code = m[1]!.trim();
    if (code !== "") out.push({ code, at: m.index });
  }
  for (const m of text.matchAll(DOLLAR_LINE_RE)) {
    const code = m[1]!.trim();
    if (code !== "") out.push({ code, at: m.index });
  }
  return out;
}

/** 去掉代码片段后的散文文本（散文匹配不在代码上重复计数）。 */
export function proseText(text: string): string {
  return text.replace(CODE_SPAN_RE, " ").replace(DOLLAR_LINE_RE, " ");
}

function escapeRe(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 散文可用的命令模式：≥2 个词、不含通配符 `*`/`?`（§3.5 第 2 步）。 */
export function prosePatterns(tax: Taxonomy): readonly { tag: string; pattern: string }[] {
  const out: { tag: string; pattern: string }[] = [];
  for (const tag of tax.tags) {
    const commands = tag.match?.commands;
    if (commands === undefined) continue;
    for (const pattern of commands) {
      const words = pattern
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "");
      if (words.length < 2) continue; // 单词程序名不做散文匹配
      if (words.some((w) => w.includes("*") || w.includes("?"))) continue; // 通配不做散文匹配
      out.push({ tag: tag.id, pattern: words.map(escapeRe).join("\\s+") });
    }
  }
  return out;
}

/** §3.5 提取：命中 tag 及其证据级别（code=high / prose=medium）与位置。 */
export function extractNlCommandHits(text: string, tax: Taxonomy): readonly NlCommandHit[] {
  if (text.trim() === "") return [];
  const out: NlCommandHit[] = [];
  const seen = new Set<string>();
  const push = (tag: string, via: "code" | "prose", at: number): void => {
    const key = `${via}:${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tag, via, at });
  };

  // 1. 代码片段：parseShell + matchTags（`echo "git push"` 的 program 是 echo，不会误命中）。
  for (const { code, at } of codeSnippets(text)) {
    const parsed = parseShell(code);
    for (const tag of matchTags(
      { tool: "bash", input: { command: code }, ...(parsed.ok ? { parsed: parsed.commands } : {}) },
      tax,
    )) {
      push(tag, "code", at);
    }
  }

  // 2. 散文：多词、无通配模式，词边界用词字符类 lookaround。
  const prose = proseText(text);
  if (prose.trim() !== "") {
    for (const { tag, pattern } of prosePatterns(tax)) {
      const re = new RegExp(`(?<![A-Za-z0-9_-])${pattern}(?![A-Za-z0-9_-])`);
      const m = re.exec(prose);
      if (m !== null) push(tag, "prose", m.index);
    }
  }
  return out;
}
