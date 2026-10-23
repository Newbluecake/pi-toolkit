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

export type XsKind = "wake" | "deliver" | "reply" | "late-reply" | "broadcast";

import { normalizeAlias } from "@protocol/xs-alias.js";

export interface XsView {
  readonly kind: XsKind;
  /** Sender name when provided, else ref. */
  readonly from: string;
  /** alias-plan r4 §6/§7.2: the sender's hub-verified alias (independent first-line header
   *  field ` alias="…"`); absent ⇒ byte-identical pre-alias view. */
  readonly fromAlias?: string;
  readonly cwdLabel?: string;
  /** Request id a reply answers. */
  readonly requestId?: string;
  /** Broadcast channel (canonical, no `#`) — present iff `kind === "broadcast"`. */
  readonly channel?: string;
  /** Body only — header and fence removed. */
  readonly body: string;
}

const HEADER_RE = /^\[fabric xs (reply )?from=(\{.*?\})(?: cwd=("(?:[^"\\]|\\.)*"))?[ \]]/;
/** Channel-plan §5.3: broadcast marker on the header's FIRST line only (mirrors src/fabric/xs/render.ts). */
const BC_HEADER_RE = /^[^\n]* channel="#([a-z0-9][a-z0-9_-]{0,31})" kind="broadcast"\]/;
/** alias-plan r4 §7.2: the alias is an INDEPENDENT header field — parsed with its own regex on
 *  the first line only, regardless of the cwd/reply_to/channel field order. */
const ALIAS_HEADER_RE = /\salias=("(?:[^"\\]|\\.)*")/;
/** When an alias sits between `from=` and `cwd=` the HEADER_RE cwd group cannot match (its
 *  `(?: cwd=…)` is anchored right after the from object) — re-read cwd independently, but ONLY
 *  on the alias path so alias-free messages keep the byte-identical legacy parse. */
const CWD_HEADER_RE = /\scwd=("(?:[^"\\]|\\.)*")/;
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
  const channel = isReply ? undefined : BC_HEADER_RE.exec(head)?.[1];
  // alias-plan r4 §7.2: an alias is trusted only when the header value is valid JSON AND a
  // canonical alias (normalizeAlias is idempotent on one) — anything else is ignored, and a
  // forged body line can never reach here (head is the FIRST line only).
  const aliasRaw = tryJson(ALIAS_HEADER_RE.exec(head)?.[1]);
  let fromAlias: string | undefined;
  if (typeof aliasRaw === "string") {
    const n = normalizeAlias(aliasRaw, { stripAt: false });
    if (n.ok && n.alias === aliasRaw) fromAlias = aliasRaw;
  }
  const cwdLabelFinal = cwdLabel ?? (fromAlias !== undefined ? str(tryJson(CWD_HEADER_RE.exec(head)?.[1])) : undefined);
  const kind: XsKind = isReply
    ? /state=late\]/.test(head)
      ? "late-reply"
      : "reply"
    : channel !== undefined
      ? "broadcast"
      : /\swake=true[\s\]]/.test(head)
        ? "wake"
        : "deliver";
  return {
    kind,
    from: who,
    ...(fromAlias === undefined ? {} : { fromAlias }),
    ...(cwdLabelFinal === undefined ? {} : { cwdLabel: cwdLabelFinal }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(channel === undefined ? {} : { channel }),
    body: (f[2] ?? "").replaceAll("<<<fab_", "<<<fab-"),
  };
}
