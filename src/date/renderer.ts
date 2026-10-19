/**
 * [date] 注入 — 紧凑 TUI 渲染器（date 模块）。
 *
 * 注入消息现在对用户可见（`display: true`）；默认的 custom message 方框太重，这里渲染成
 * 一行暗色标记：`── date 2026-10-19 Mon 14:12 (Asia/Shanghai) · idle ──`。
 * 紧凑标记只用英文 token（AGENTS.md UI 语言规则）。内容无法解析 ⇒ 返回 undefined，
 * pi 退回默认渲染（用户仍能看到原文）。与 src/commands/task.ts 的 renderer 同款：
 * 自带水平 padding（`options.outputPad`，默认 1）。
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { dateKindSuffix, parseDateMarker } from "./core.js";

/** 纯文本形态（测试/复用）；无法解析 ⇒ undefined。 */
export function formatDateMarkerLine(content: unknown, kind: unknown): string | undefined {
  const text = typeof content === "string" ? content : undefined;
  if (text === undefined) return undefined;
  const parsed = parseDateMarker(text);
  if (!parsed) return undefined;
  const suffix = dateKindSuffix(kind);
  return `── date ${parsed.date} ${parsed.weekday} ${parsed.time} (${parsed.zone})${suffix ? ` · ${suffix}` : ""} ──`;
}

export const renderDateMessage: MessageRenderer<{ kind?: unknown }> = (message, options, theme) => {
  const details = message.details;
  const kind = details !== null && typeof details === "object" ? details.kind : undefined;
  const line = formatDateMarkerLine(message.content, kind);
  if (line === undefined) return undefined;
  const padX = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
  return new Text(theme.fg("dim", line), padX, 0);
};
