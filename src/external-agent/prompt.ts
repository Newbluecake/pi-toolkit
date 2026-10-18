/**
 * 外部 agent 首条消息渲染（external-agent plan §2.12/§4.8，P1 冻结面纯函数）。
 * P3 只负责传参；这里不做任何 IO / 依赖注入。
 */
import type { ExternalContextBlock, JsonSchema } from "../core/types.js";

/**
 * schema 指令里内联 JSON Schema 本体的上限（UTF-8 字节，约 8 KiB）。droid 没有
 * StructuredOutput 工具，schema 只能靠指令文本传达；超过上限（或不可序列化）时
 * 不内联本体，改为省略说明——永不抛错、不截断出半截 JSON。
 */
export const SCHEMA_INLINE_MAX_BYTES = 8192;

function renderSchemaInstruction(schema: JsonSchema): string {
  const base = "End your final answer with a single ```json fenced block containing your structured result as JSON";
  const tail = "nothing may follow the block.";
  let serialized = "";
  try {
    serialized = JSON.stringify(schema) ?? "";
  } catch {
    serialized = ""; // 循环引用 / BigInt 等 ⇒ 不内联，走省略说明
  }
  const bytes = serialized.length > 0 ? Buffer.byteLength(serialized, "utf8") : 0;
  if (serialized.length > 0 && bytes <= SCHEMA_INLINE_MAX_BYTES)
    return `${base} matching this JSON Schema: ${serialized}; ${tail}`;
  const why =
    serialized.length === 0
      ? "it could not be serialized"
      : `its serialized form is ${bytes} bytes, over the ${SCHEMA_INLINE_MAX_BYTES}-byte inline limit`;
  return `${base}; ${tail} (The JSON Schema for the structured result was omitted because ${why}.)`;
}

/**
 * 顺序：`<agent-role>`（rolePrompt + toolNameHint）→ 各 contextBlock（memory 包
 * `<project-memory>`，capabilities 原文）→ schema 指令 → text。schema 指令内联
 * 紧凑 JSON（`JSON.stringify`）形式的 schema 本体；序列化结果超过
 * `SCHEMA_INLINE_MAX_BYTES` 或不可序列化时降级为省略说明（永不抛错）。
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
  if (o.schema !== undefined) parts.push(renderSchemaInstruction(o.schema));
  parts.push(o.text);
  return parts.join("\n\n");
}
