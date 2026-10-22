/**
 * RX7 D-display (web): structured view of a received cross-session message (`customType
 * "subagent:xs"`). Pure, DOM-free. The hub only projects `{date,kind,at}` of `details`, so the
 * ONLY source here is the message `content` — the untrusted `[fabric xs …]` header plus the
 * nonce-fenced body (format: src/fabric/xs/format.ts; mirrored by src/fabric/xs/render.ts for
 * the TUI). Anything unparseable ⇒ `undefined` and the caller falls back to the generic card.
 * The wake trigger and the deliver-only form are not distinguishable from content alone
 * except by the `wake=` header field, which the sender-side formatter does set.
 */

export const XS_CUSTOM_TYPE = "subagent:xs";

export type XsKind = "wake" | "deliver" | "reply" | "late-reply";

export interface XsView {
  readonly kind: XsKind;
  /** Sender name when provided, else ref. */
  readonly from: string;
  readonly cwdLabel?: string;
  /** Request id a reply answers. */
  readonly requestId?: string;
  /** Body only — header and fence removed. */
  readonly body: string;
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

export function parseXsMessage(content: string): XsView | undefined {
  const h = HEADER_RE.exec(content);
  const f = FENCE_RE.exec(content);
  if (h === null || f === null) return undefined;
  const from = tryJson(h[2]) as { ref?: unknown; name?: unknown } | undefined;
  const who = str(from?.name) ?? str(from?.ref) ?? "unknown";
  const cwdLabel = str(tryJson(h[3]));
  const isReply = h[1] !== undefined;
  // Header fields are read from the FIRST line only — the fenced body below it is untrusted
  // free text and must never be able to relabel the kind or forge a request id.
  const nl = content.indexOf("\n");
  const head = nl === -1 ? content : content.slice(0, nl);
  const requestId = isReply ? /request="([^"]+)"/.exec(head)?.[1] : undefined;
  const kind: XsKind = isReply
    ? /state=late\]/.test(head)
      ? "late-reply"
      : "reply"
    : /\swake=true[\s\]]/.test(head)
      ? "wake"
      : "deliver";
  return {
    kind,
    from: who,
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(requestId === undefined ? {} : { requestId }),
    body: (f[2] ?? "").replaceAll("<<<fab_", "<<<fab-"),
  };
}
