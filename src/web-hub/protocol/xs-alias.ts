/**
 * Session alias rules (alias-plan r4 §2) — pure functions, zero imports, no Node API.
 *
 * Shared by the hub, the agent and the browser UI (the UI imports it through `@protocol/*`),
 * so it may only rely on ECMAScript builtins (`Intl.Segmenter`, Unicode property escapes).
 * Changing the skeleton table or the reserved list requires bumping `XS_ALIAS_SKELETON_VERSION`
 * (skeleton) and refreshing `tests/fixtures/xs-alias-corpus.json` in the same PR.
 */

/** Skeleton table version (§2.2). Bump together with any change to `SKELETON_MAP`. */
export const XS_ALIAS_SKELETON_VERSION = 1;
/** §2.1-6: grapheme-cluster window and UTF-8 byte cap (Q8). */
export const XS_ALIAS_MIN_GRAPHEMES = 1;
export const XS_ALIAS_MAX_GRAPHEMES = 16;
export const XS_ALIAS_MAX_BYTES = 48;

export type XsAliasRejectReason = "invalid" | "too_long" | "id_like" | "reserved";

export type XsAliasNormalizeResult =
  | { readonly ok: true; readonly alias: string; readonly skeleton: string }
  | { readonly ok: false; readonly reason: XsAliasRejectReason };

// ------------------------------------------------------------------ reserved words (§2.3)

/** Channel-reserved names (mirrors `src/fabric/xs/channel.ts` `XS_RESERVED_CHANNELS`; pinned by a test —
 *  protocol/ may not import outside protocol/hub). */
const CHANNEL_RESERVED: readonly string[] = [
  "all",
  "everyone",
  "here",
  "none",
  "root",
  "system",
  "main",
  "hub",
  "session",
  "xs",
];

export const XS_RESERVED_ALIASES: readonly string[] = Object.freeze([
  ...CHANNEL_RESERVED,
  "default",
  "self",
  "me",
  "you",
  "user",
  "human",
  "assistant",
  "agent",
  "bot",
  "model",
  "pi",
  "subagent",
  "workflow",
  "channel",
  "broadcast",
  "reply",
  "所有人",
  "全部",
  "大家",
  "自己",
  "我",
  "你",
  "主会话",
  "系统",
]);

/** Superset of `router.ts`/`sender.ts` `RESERVED_PREFIXES` minus `@` (never reachable: `@` is not whitelisted). */
export const XS_RESERVED_ALIAS_PREFIXES: readonly string[] = Object.freeze(["pi-", "r_", "wf_"]);

const RESERVED_SET: ReadonlySet<string> = new Set(XS_RESERVED_ALIASES);

/** Judge a canonical (already NFKC + ASCII-lowercased) alias. Input is compared as-is. */
export function isReservedAlias(canonical: string): boolean {
  if (RESERVED_SET.has(canonical)) return true;
  return XS_RESERVED_ALIAS_PREFIXES.some((p) => canonical.startsWith(p));
}

// ------------------------------------------------------------------ character classes (§2.1-3/4)

/** §2.1-3: rejected before the whitelist is consulted. */
const DENY_RE = /[\p{Default_Ignorable_Code_Point}\p{C}\p{M}\p{White_Space}]/u;
/** Hangul Jamo blocks (incl. fillers U+115F/U+1160/U+3164/U+FFA0), variation selectors, Bidi controls. */
const DENY_RANGE_RE =
  /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF\uFFA0-\uFFDC\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u180B-\u180F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** §2.1-4 whitelist (single code point). Han/kana are additionally restricted to letters (+ 〇 Nl),
 *  so symbol-class members of those scripts (CJK radicals, circled forms …) are refused. */
const ASCII_RE = /^[A-Za-z0-9_-]$/;
const HAN_RE = /^[\p{Script=Han}]$/u;
const KANA_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const LETTER_RE = /^\p{L}$/u;
const LETTER_OR_NL_RE = /^[\p{L}\p{Nl}]$/u;

function isAllowedCodePoint(ch: string): boolean {
  if (ASCII_RE.test(ch)) return true;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0xac00 && cp <= 0xd7a3) return true; // precomposed Hangul syllables only
  if (cp === 0x30fc) return true; // ー
  if (HAN_RE.test(ch)) return LETTER_OR_NL_RE.test(ch); // 〇 is Nl
  if (KANA_RE.test(ch)) return LETTER_RE.test(ch);
  return false;
}

// ------------------------------------------------------------------ sizing

function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Grapheme-cluster count (`Intl.Segmenter`; falls back to the code-point count where unavailable —
 *  after the deny list every accepted string is mark-free, so the two agree). */
export function aliasGraphemeCount(s: string): number {
  const Seg = (
    globalThis as {
      Intl?: {
        Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(x: string): Iterable<unknown> };
      };
    }
  ).Intl?.Segmenter;
  if (typeof Seg === "function") {
    let n = 0;
    for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(s)) {
      void _;
      n++;
    }
    return n;
  }
  return Array.from(s).length;
}

// ------------------------------------------------------------------ skeleton (§2.2)

const SKELETON_MAP: Readonly<Record<string, string>> = Object.freeze({
  // ASCII internal
  "0": "o",
  "1": "l",
  i: "l",
  _: "-",
  // CJK <-> ASCII look-alikes (Q7)
  〇: "o",
  口: "o",
  ロ: "o",
  ー: "-",
  一: "-",
  "－": "-",
  "—": "-",
  丨: "l",
});

/** Per-character confusable skeleton of a canonical alias. Used only for squat conflicts, never for resolution. */
export function aliasSkeleton(canonical: string): string {
  let out = "";
  for (const ch of canonical) out += SKELETON_MAP[ch] ?? ch;
  return out;
}

// ------------------------------------------------------------------ normalize (§2.1)

/**
 * `opts.stripAt` (default true): drop ONE leading `@` first (setting entry points and mention parsing).
 * `message_session.to` must not call this with a leading `@` (A4: that stays rejected there).
 */
export function normalizeAlias(input: unknown, opts?: { readonly stripAt?: boolean }): XsAliasNormalizeResult {
  const bad = (reason: XsAliasRejectReason): XsAliasNormalizeResult => ({ ok: false, reason });
  if (typeof input !== "string" || input.length === 0) return bad("invalid");
  let s = input;
  if ((opts?.stripAt ?? true) && s.startsWith("@")) s = s.slice(1);
  if (s.length === 0) return bad("invalid");
  if (s.length > 256) return bad("too_long"); // cheap bound before Unicode work

  s = s.normalize("NFKC");
  if (s !== s.normalize("NFKC")) return bad("invalid"); // idempotence guard
  if (s.length === 0) return bad("invalid");

  for (const ch of s) {
    if (DENY_RE.test(ch) || DENY_RANGE_RE.test(ch)) return bad("invalid");
    if (!isAllowedCodePoint(ch)) return bad("invalid");
  }

  const alias = s.replace(/[A-Z]/g, (c) => c.toLowerCase());

  const g = aliasGraphemeCount(alias);
  if (g < XS_ALIAS_MIN_GRAPHEMES || g > XS_ALIAS_MAX_GRAPHEMES) return bad("too_long");
  if (utf8Bytes(alias) > XS_ALIAS_MAX_BYTES) return bad("too_long");

  if (!/\p{L}/u.test(alias)) return bad("invalid");
  const first = alias.codePointAt(0);
  if (first === 0x5f || first === 0x2d || first === 0x30fc) return bad("invalid");

  if (/^[0-9a-f-]{8,}$/.test(alias)) return bad("id_like");
  if (isReservedAlias(alias)) return bad("reserved");

  return { ok: true, alias, skeleton: aliasSkeleton(alias) };
}

// ------------------------------------------------------------------ take token / confirm line (§3.5)

/** `k` + 16 lower-case hex. */
export const XS_ALIAS_TAKE_TOKEN_RE = /^k[0-9a-f]{16}$/;

/** The fixed last line of a take preview echoed to web/RPC callers. Matches ONE line (no `m` flag):
 *  callers feed it the last non-empty line of that single command's captured output (`parseTakeConfirm`). */
export const XS_ALIAS_TAKE_CONFIRM_RE = /^确认抢占请执行：\/fabric alias (\S+) --take=(k[0-9a-f]{16})（5 分钟内有效）$/;

export function formatTakeConfirmLine(alias: string, token: string): string {
  return `确认抢占请执行：/fabric alias ${alias} --take=${token}（5 分钟内有效）`;
}

/** Parse a take-preview output: only the LAST non-empty line counts, and its alias must be a valid
 *  canonical alias (`normalizeAlias` is idempotent on it) — text earlier in the output can never inject a token. */
export function parseTakeConfirm(output: string): { readonly alias: string; readonly token: string } | undefined {
  const lines = output.split(/\r?\n/);
  let last: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l.length > 0) {
      last = l;
      break;
    }
  }
  if (last === undefined) return undefined;
  const m = XS_ALIAS_TAKE_CONFIRM_RE.exec(last);
  if (m === null) return undefined;
  const alias = m[1]!;
  const token = m[2]!;
  const n = normalizeAlias(alias, { stripAt: false });
  if (!n.ok || n.alias !== alias) return undefined;
  return { alias, token };
}
