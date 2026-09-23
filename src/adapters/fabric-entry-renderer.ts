import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { FabricRecord } from "../core/message.js";

export const FABRIC_ENTRY_CUSTOM_TYPE = "subagent:fabric";

/** Left padding of the rendered payload, so the body reads as a block under its header. */
const FABRIC_BODY_INDENT = 2;

/**
 * TUI renderer for fabric custom entries. The fabric outbox store is
 * append-only: every state transition of a record appends a fresh entry
 * (pending → … → delivered), and pi's interactive mode renders each appended
 * entry that has a renderer (addCustomEntryToChat). Rendering every state
 * showed the same message once per transition; only the terminal `delivered`
 * record is display-worthy, so anything else returns undefined — pi's
 * CustomEntryComponent.hasContent() is then false and the entry is skipped.
 * Context injection (sendRootContext / steer) is unaffected: it never goes
 * through this renderer.
 */
/** Resolve a sender runId to its mention label, if one is registered. */
export type FabricSenderResolver = (runId: string) => string | undefined;

function formatSender(from: string | undefined, resolveSender?: FabricSenderResolver): string {
  if (!from) return "";
  if (from === "root") return " root";
  const label = resolveSender?.(from);
  return label !== undefined ? ` @${label}` : ` ${from}`;
}

/**
 * Derive a markdown theme from the Theme handed to the renderer.
 *
 * Mirrors the host's getMarkdownTheme(), but reads the passed instance instead
 * of pi's process-global theme singleton (which throws before initTheme(), so
 * it is unusable outside interactive mode and in tests). `highlightCode` is
 * intentionally omitted: it needs that same singleton, and dropping it only
 * degrades fenced blocks to the flat mdCodeBlock color — which is exactly what
 * the host's own fallback does for un-annotated code fences.
 */
function markdownThemeFrom(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
}

export function createFabricEntryRenderer(resolveSender?: FabricSenderResolver): EntryRenderer {
  return (entry, _options, theme) => {
    const data = entry.data as Partial<FabricRecord> | undefined;
    if (data?.state !== "delivered") return undefined;
    const text = data.payload?.text ?? "";
    const sender = formatSender(data.from, resolveSender);
    const header = new Text(theme.fg("muted", `[fabric ${data.kind ?? "message"}${sender}]`), 0, 0);
    if (text.trim() === "") return header;
    // Header on its own line + the payload as an indented markdown block:
    // fabric payloads are model-written prose (progress reports, findings) that
    // routinely span lines and carry lists/code. Prefixing them inline into one
    // plain Text left wrapped lines hugging column 0 and swallowed all markup.
    const container = new Container();
    container.addChild(header);
    container.addChild(
      new Markdown(text, FABRIC_BODY_INDENT, 0, markdownThemeFrom(theme), {
        color: (plain) => theme.fg("muted", plain),
      }),
    );
    return container;
  };
}

export const renderFabricEntry: EntryRenderer = createFabricEntryRenderer();
