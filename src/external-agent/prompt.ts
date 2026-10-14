/**
 * 外部 agent 首条消息渲染（external-agent plan §2.12/§4.8，P1 冻结面纯函数）。
 * P3 只负责传参；这里不做任何 IO / 依赖注入。
 */
import type { ExternalContextBlock, JsonSchema } from "../core/types.js";

/**
 * 顺序：`<agent-role>`（rolePrompt + toolNameHint）→ 各 contextBlock（memory 包
 * `<project-memory>`，capabilities 原文）→ schema 指令 → text。
 * rolePrompt/contextBlocks/schema 均缺省（含空数组/空白内容）时返回 text 原样（resume 路径）。
 */
export function renderFirstMessage(o: {
  rolePrompt?: string;
  contextBlocks: readonly ExternalContextBlock[];
  schema?: JsonSchema;
  text: string;
  toolNameHint?: string;
}): string {
  const parts: string[] = [];
  if ((o.rolePrompt ?? "").trim().length > 0 || (o.toolNameHint ?? "").trim().length > 0) {
    const role: string[] = [];
    if ((o.rolePrompt ?? "").trim().length > 0) role.push(o.rolePrompt!.trim());
    if ((o.toolNameHint ?? "").trim().length > 0) role.push(`Tool name mapping: ${o.toolNameHint!.trim()}`);
    parts.push(`<agent-role>\n${role.join("\n\n")}\n</agent-role>`);
  }
  for (const block of o.contextBlocks) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text !== "string" || block.text.trim().length === 0) continue;
    parts.push(block.kind === "memory" ? `<project-memory>\n${block.text}\n</project-memory>` : block.text);
  }
  if (o.schema !== undefined)
    parts.push(
      "End your final answer with a single ```json fenced block containing your structured result as JSON; " +
        "nothing may follow the block.",
    );
  parts.push(o.text);
  return parts.join("\n\n");
}
