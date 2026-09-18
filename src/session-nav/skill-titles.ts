// Ported from the standalone session-nav extension (skill-titles.ts) —
// behavior preserved verbatim. Strict-mode adaptation: `open[1]` (regex match
// group) is undefined-checked instead of asserted (noUncheckedIndexedAccess).
//
// skill 信封清洗 — 让 resume 列表显示真实用户输入而不是 skill 正文。
//
// /skill:xxx 启动的会话，首条 user 消息 = `<skill name="…" …>整篇 skill 正文</skill>`
// + 真实输入（另一种形态是 skill 正文走 system prompt，消息里只剩开标签和
// "References are relative to …" 提示）。pi 原生取首条 user 消息当 resume 标题，
// 会被 skill 正文占满。这里在列表展示前剥掉信封，显示为 `[skill名] 真实输入`，
// 并同步净化模糊搜索文本。

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const SKILL_OPEN_RE = /^<skill\s+name="([^"]+)"[^>]*>/;
const SKILL_REFERENCES_RE = /^\s*References are relative to \S*\.?\s*/;
const SKILL_ENVELOPE_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;

export function stripSkillEnvelope(text: string): { name: string; rest: string } | null {
  const open = text.match(SKILL_OPEN_RE);
  if (!open) return null;
  const name = open[1];
  if (name === undefined) return null;
  const closeIndex = text.indexOf("</skill>");
  const rest =
    closeIndex >= 0
      ? text.slice(closeIndex + "</skill>".length)
      : text.slice(open[0].length).replace(SKILL_REFERENCES_RE, "");
  return { name, rest: rest.trim() };
}

/** 首条消息整个就是 skill 调用（无附带输入）时，找会话里下一条真实 user 消息当标题。 */
async function findNextUserText(sessionPath: string): Promise<string | undefined> {
  const rl = createInterface({ input: createReadStream(sessionPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"role":"user"')) continue;
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text = Array.isArray(content)
        ? content
            .filter((block): block is { type: string; text: string } => block?.type === "text")
            .map((block) => block.text)
            .join(" ")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim() && !SKILL_OPEN_RE.test(text.trimStart())) return text.trim();
    }
  } catch {
    /* 读失败就当没有后备标题 */
  } finally {
    rl.close();
  }
  return undefined;
}

/** 把 resume 列表里的 skill 信封标题替换为 `[skill名] 真实输入`，并净化搜索文本。 */
export async function cleanSkillTitles(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  return Promise.all(
    sessions.map(async (session) => {
      // 全文搜索文本剔除完整 skill 信封，避免 skill 正文里的词污染模糊匹配
      const allMessagesText = session.allMessagesText.replace(SKILL_ENVELOPE_RE, "[$1]");
      const withSearchText = allMessagesText === session.allMessagesText ? session : { ...session, allMessagesText };
      // 用户手动 rename 过的会话优先展示 name，不动标题
      if (session.name) return withSearchText;
      const parsed = stripSkillEnvelope(session.firstMessage);
      if (!parsed) return withSearchText;
      const rest = parsed.rest || (await findNextUserText(session.path)) || "";
      return { ...withSearchText, firstMessage: rest ? `[${parsed.name}] ${rest}` : `[${parsed.name}]` };
    }),
  );
}
