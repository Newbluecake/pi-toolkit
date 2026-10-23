/**
 * TUI label rewrite for visible `subagent:*` custom messages.
 *
 * pi's default custom-message renderer labels a box with the raw customType
 * (`[subagent:usage-tick]`). The `subagent:*` names are persisted session data
 * and must never change, so only the DISPLAY label changes here: `[toolkit:usage-tick]`.
 * Everything else mirrors pi's default render (custom-message.js): purple box,
 * bold label, spacer, markdown body. The model-visible content is untouched.
 */

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";

const PREFIX = "subagent:";

/**
 * Visible (display:true) `subagent:*` customTypes without a dedicated renderer.
 * Types with their own renderer (date, task-started, xs) are registered elsewhere.
 */
export const TOOLKIT_LABELLED_CUSTOM_TYPES: readonly string[] = [
  "subagent:usage-tick",
  "subagent:compact-hint",
  "subagent:quota",
  "subagent:load",
  "subagent:notification",
  "subagent:workflow-notification",
  "subagent:timeout",
  "subagent:mention-error",
  "subagent:mention-session",
  "subagent:xs-reply",
  "subagent:switch-context-notice",
];

/** `subagent:quota` → `toolkit:quota`; other names are left as-is. */
export function toolkitLabel(customType: string): string {
  return customType.startsWith(PREFIX) ? `toolkit:${customType.slice(PREFIX.length)}` : customType;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function markdownThemeFrom(theme: Theme): MarkdownTheme {
  try {
    return getMarkdownTheme(); // host theme (with code highlighting)
  } catch {
    return {
      heading: (t) => theme.fg("mdHeading", t),
      link: (t) => theme.fg("mdLink", t),
      linkUrl: (t) => theme.fg("mdLinkUrl", t),
      code: (t) => theme.fg("mdCode", t),
      codeBlock: (t) => theme.fg("mdCodeBlock", t),
      codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
      quote: (t) => theme.fg("mdQuote", t),
      quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
      hr: (t) => theme.fg("mdHr", t),
      listBullet: (t) => theme.fg("mdListBullet", t),
      bold: (t) => theme.bold(t),
      italic: (t) => theme.italic(t),
      underline: (t) => theme.underline(t),
      strikethrough: (t) => theme.strikethrough(t),
    };
  }
}

export const renderToolkitMessage: MessageRenderer<unknown> = (message, options, theme) => {
  if (typeof message?.customType !== "string") return undefined;
  const pad = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
  const box = new Box(pad, 1, (t) => theme.bg("customMessageBg", t));
  const label = theme.fg("customMessageLabel", `\x1b[1m[${toolkitLabel(message.customType)}]\x1b[22m`);
  box.addChild(new Text(label, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(
    new Markdown(textOf(message.content), 0, 0, markdownThemeFrom(theme), {
      color: (t: string) => theme.fg("customMessageText", t),
    }),
  );
  return box;
};
