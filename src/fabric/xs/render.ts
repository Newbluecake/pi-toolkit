import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * RX7 D-display: user-facing rendering of received cross-session messages (`customType
 * "subagent:xs"`). The provider-facing `content` is untouched (untrusted header + nonce fence);
 * this only reshapes the DISPLAY: one compact English header line + the bare body.
 * Metadata comes from `details` when present, else from the content header (the web UI only
 * receives `content`, so `parseXsContent` is the shared fallback — mirrored by
 * `src/web-hub/ui/src/logic/xsMessage.ts`).
 */

export type XsDisplayKind = "wake" | "deliver" | "reply" | "late-reply";

export interface XsDisplayView {
  kind: XsDisplayKind;
  /** name when known, else ref. */
  from: string;
  cwdLabel?: string;
  requestId?: string;
  body: string;
}

const HEADER_RE = /^\[fabric xs (reply )?from=(\{.*?\})(?: cwd=("(?:[^"\\]|\\.)*"))?[ \]]/;
const FENCE_RE = /<<<fab-([^>\s]+)>>>\n([\s\S]*?)\n<<<fab-\1-end>>>\s*$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function tryJson(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Strip the untrusted header and nonce fence; falls back to the whole content when unfenced. */
export function extractXsBody(content: string): string {
  const m = FENCE_RE.exec(content);
  return m === null ? content : (m[2] ?? "").replaceAll("<<<fab_", "<<<fab-");
}

/** Pure view builder. `details` wins for metadata; the content header is the fallback. */
export function buildXsView(content: string, details: unknown): XsDisplayView {
  const d = details !== null && typeof details === "object" ? (details as Record<string, unknown>) : {};
  const h = HEADER_RE.exec(content);
  const hFrom = tryJson(h?.[2]) as { ref?: unknown; name?: unknown } | undefined;
  const dFrom = d["from"] !== null && typeof d["from"] === "object" ? (d["from"] as Record<string, unknown>) : {};
  const from = str(dFrom["name"]) ?? str(dFrom["ref"]) ?? str(hFrom?.name) ?? str(hFrom?.ref) ?? "unknown";
  const cwdLabel = str(dFrom["cwdLabel"]) ?? str(tryJson(h?.[3]));
  const requestId = str(d["inReplyTo"]) ?? (h?.[1] !== undefined ? /request="([^"]+)"/.exec(content)?.[1] : undefined);
  const isReply = requestId !== undefined || h?.[1] !== undefined;
  const late = d["late"] === true || (isReply && /state=late\]/.test(content));
  const kind: XsDisplayKind = isReply ? (late ? "late-reply" : "reply") : d["xsWake"] === true ? "wake" : "deliver";
  return {
    kind,
    from,
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(requestId === undefined ? {} : { requestId }),
    body: extractXsBody(content),
  };
}

export function xsHeaderLine(v: XsDisplayView): string {
  const tail =
    v.kind === "reply" || v.kind === "late-reply"
      ? `${v.kind === "late-reply" ? "late reply" : "reply"} to ${v.requestId ?? "?"}`
      : v.kind;
  return ["xs ←", v.from, ...(v.cwdLabel === undefined ? [] : [`· ${v.cwdLabel}`]), `· ${tail}`].join(" ");
}

export const renderXsMessage: MessageRenderer<unknown> = (message, options, theme) => {
  const content = typeof message.content === "string" ? message.content : undefined;
  if (content === undefined) return undefined;
  const view = buildXsView(content, message.details);
  const padX = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
  return new Text(`${theme.fg("muted", xsHeaderLine(view))}\n${view.body}`, padX, 0);
};
