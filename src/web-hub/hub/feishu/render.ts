/**
 * Feishu reply rendering (bot plan §6.1 + R1 #13 + R2-b, package F7). Pure and pi-free: assistant markdown ⇒ schema-2.0
 * card JSON strings / text-message JSON strings, ready for `outbox.ts` (which sends them verbatim). No I/O, no
 * timers, no module-scope mutable state.
 *
 * **Assistant text is untrusted.** The card `markdown` element interprets Feishu-specific tags
 * (`<at id=all></at>`, `<font>`, `<a href>`, `<person>`, …), links and images, so nothing the agent wrote
 * reaches the wire raw:
 * - control / bidi / zero-width-space / BOM characters are stripped, CRLF normalized, lone surrogates replaced;
 * - every tag-shaped `<` (`<` + letter, `/`, `!` or `?`) gets a zero-width space after it — **everywhere, code
 *   spans and fences included**, because it is unverified whether Feishu keeps code literal (`codeTags:"literal"`
 *   is available once a real-tenant check proves it; default is the fail-safe);
 * - `[text](url)` survives only for http(s)/mailto URLs that parse, carry no userinfo/backslash/controls, and are
 *   re-serialized (parentheses percent-encoded); anything else (javascript:, lark://, relative, data:, …) becomes
 *   `text (`url`)` — an inert code span; `![alt](url)` is flattened to a link or to its alt text.
 * The only live tags in a card are the ones THIS module writes: the sender mention `<at id=ou_…></at>`
 * (validated open_id) — and the header/labels are `plain_text`.
 */

import { FEISHU_FILE_LIMITS, FEISHU_OPEN_ID_RE, FEISHU_REPLY_LIMITS } from "../../protocol/feishu.js";
import { classifyLines, jsonBytes, partSuffix, partSuffixReserveBytes, splitMarkdown } from "./split.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Appended to the final part when the assistant text was truncated on the wire (`truncated:true`). */
export const OUTPUT_INCOMPLETE_LABEL = "⚠️ 输出不完整 · output incomplete (truncated in transit)";
/** Last line of part 1 when the full text goes out as an attachment (plan §6.1). */
export const OVERFLOW_FILE_NOTE_PREFIX = "> 📎 输出较长，完整内容见附件 ";
/** Last line of the final part when the parts were truncated instead (attachment unavailable). */
export const OVERFLOW_TRUNCATED_NOTE = "> ✂️ 输出过长，已截断（完整内容请在 web 查看）";
export const EMPTY_REPLY_PLACEHOLDER = "（无文本输出）";

const LABEL_MAX_CODE_POINTS = 48;
const ERROR_MESSAGE_MAX_CODE_POINTS = 500;
const ZWSP = "\u200B";
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

export type ReplyKind = "done" | "failed" | "waiting" | "info";
export type CardTemplate = "green" | "red" | "orange" | "grey";
export const KIND_TEMPLATE: Readonly<Record<ReplyKind, CardTemplate>> = Object.freeze({
  done: "green",
  failed: "red",
  waiting: "orange",
  info: "grey",
});

export type CodeTagsPolicy = "neutralize" | "literal";

// ---------------------------------------------------------------------------
// sanitizing
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const STRIP_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const FORMAT_RE = /[\p{Cf}]/gu;

/** Strip control/format characters (keeps `\n`, `\t`, ZWJ/ZWNJ), normalize newlines, fix lone surrogates. */
export function sanitizeText(input: string): string {
  let s = typeof input === "string" ? input : "";
  s = s.replace(LONE_SURROGATE_RE, "\uFFFD");
  s = s.replace(/\r\n?|\u2028|\u2029/g, "\n");
  s = s.replace(STRIP_RE, "");
  // remaining format characters except ZWNJ/ZWJ (needed by scripts/emoji sequences)
  s = s.replace(FORMAT_RE, (c) => (c === "\u200c" || c === "\u200d" ? c : ""));
  return s;
}

/** A one-line, bounded label (session label, sender name): control/format stripped, markup chars kept literal. */
export function sanitizeLabel(label: string, maxCodePoints = LABEL_MAX_CODE_POINTS): string {
  const cleaned = sanitizeText(label).replace(/\s+/g, " ").trim();
  const cps = [...cleaned];
  const out = cps.length > maxCodePoints ? `${cps.slice(0, maxCodePoints - 1).join("")}…` : cleaned;
  return out === "" ? "session" : out;
}

/** A label/reason that is embedded in MARKDOWN or TEXT content (not a plain_text header): tags neutralized too. */
export function markupSafeLabel(label: string, maxCodePoints = LABEL_MAX_CODE_POINTS): string {
  return neutralizeTags(sanitizeLabel(label, maxCodePoints));
}

/** Break tag-shaped `<` so Feishu never parses agent text as a tag. */
export function neutralizeTags(s: string): string {
  return s.replace(/<(?=[A-Za-z/!?])/g, `<${ZWSP}`);
}

// ---------------------------------------------------------------------------
// markdown neutralization
// ---------------------------------------------------------------------------

/** End index (exclusive) of the inline code span opening at `i`, or −1 (unmatched ⇒ the backticks are literal). */
function codeSpanEnd(s: string, i: number): number {
  let n = 0;
  while (s[i + n] === "`") n++;
  const limit = Math.min(s.length, i + n + 4096);
  let k = i + n;
  while (k < limit) {
    if (s[k] === "`") {
      let m = 0;
      while (s[k + m] === "`") m++;
      if (m === n) return k + m;
      k += m;
    } else k++;
  }
  return -1;
}

interface ParsedLink {
  text: string;
  dest: string;
  end: number;
}

const LINK_TEXT_MAX = 300;
const LINK_DEST_MAX = 2_048;

function parseLink(s: string, open: number): ParsedLink | undefined {
  // bracket text (nesting counted, inline code opaque, bounded)
  let j = open + 1;
  let depth = 1;
  while (j < s.length && j - open <= LINK_TEXT_MAX) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const e = codeSpanEnd(s, j);
      if (e > 0) {
        j = e;
        continue;
      }
      while (s[j] === "`") j++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  if (depth !== 0 || s[j] !== "]" || s[j + 1] !== "(") return undefined;
  const text = s.slice(open + 1, j);
  let p = j + 2;
  while (s[p] === " " || s[p] === "\t") p++;
  let dest: string;
  if (s[p] === "<") {
    const q = s.indexOf(">", p);
    if (q < 0 || q - p > LINK_DEST_MAX) return undefined;
    dest = s.slice(p + 1, q);
    p = q + 1;
  } else {
    const start = p;
    let d = 0;
    while (p < s.length && p - start <= LINK_DEST_MAX) {
      const c = s[p]!;
      if (c === "\\") {
        p += 2;
        continue;
      }
      if (c === " " || c === "\t") break;
      if (c === "(") d++;
      else if (c === ")") {
        if (d === 0) break;
        d--;
      }
      p++;
    }
    if (p - start > LINK_DEST_MAX) return undefined;
    dest = s.slice(start, p);
  }
  while (s[p] === " " || s[p] === "\t") p++;
  if (s[p] === '"' || s[p] === "'") {
    const quote = s[p]!;
    const q = s.indexOf(quote, p + 1);
    if (q < 0 || q - p > 300) return undefined;
    p = q + 1;
    while (s[p] === " " || s[p] === "\t") p++;
  }
  if (s[p] !== ")" || dest === "") return undefined;
  return { text, dest, end: p + 1 };
}

/** The re-serialized href when `dest` is an acceptable link target, else `undefined`. */
export function safeHref(dest: string): string | undefined {
  const d = dest.trim();
  // eslint-disable-next-line no-control-regex
  if (d === "" || /[\u0000-\u0020\u007f-\u009f\\<>"`]/.test(d) || d.length > LINK_DEST_MAX) return undefined;
  let u: URL;
  try {
    u = new URL(d);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  const href = u.href;
  if (href.length > LINK_DEST_MAX || /[\u0000-\u0020<>"`\\]/.test(href)) return undefined;
  return href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function inertDest(dest: string): string {
  const cleaned = dest.replace(/[`\r\n\t]/g, " ").trim();
  const cps = [...cleaned];
  return cps.length > 120 ? `${cps.slice(0, 119).join("")}…` : cleaned;
}

function renderLink(link: ParsedLink, image: boolean): string {
  const href = safeHref(link.dest);
  const text = link.text.trim();
  if (href !== undefined) return image ? `[🖼 ${text === "" ? "image" : text}](${href})` : `[${text}](${href})`;
  const shown = text === "" ? "" : `${text} `;
  return `${shown}(\`${inertDest(neutralizeTags(link.dest))}\`)`;
}

interface Piece {
  text: string;
  code: boolean;
}

/** One non-fenced line ⇒ pieces (prose with links rewritten; inline code spans kept opaque). */
function rewriteLine(line: string): Piece[] {
  const pieces: Piece[] = [];
  let prose = "";
  const flush = (): void => {
    if (prose !== "") pieces.push({ text: prose, code: false });
    prose = "";
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "\\") {
      prose += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "`") {
      const e = codeSpanEnd(line, i);
      if (e > 0) {
        flush();
        pieces.push({ text: line.slice(i, e), code: true });
        i = e;
        continue;
      }
      let n = 0;
      while (line[i + n] === "`") n++;
      prose += line.slice(i, i + n);
      i += n;
      continue;
    }
    const image = c === "!" && line[i + 1] === "[";
    if (c === "[" || image) {
      const link = parseLink(line, image ? i + 1 : i);
      if (link !== undefined) {
        prose += renderLink(link, image);
        i = link.end;
        continue;
      }
    }
    prose += c;
    i++;
  }
  flush();
  return pieces;
}

/**
 * Make untrusted assistant markdown safe for a Feishu card `markdown` element (see the module doc). Idempotent
 * enough for re-rendering: a second pass leaves an already neutralized text unchanged.
 */
export function neutralizeMarkdown(text: string, options: { codeTags?: CodeTagsPolicy } = {}): string {
  const policy = options.codeTags ?? "neutralize";
  const safe = sanitizeText(text);
  const out: string[] = [];
  for (const { text: line, fenced } of classifyLines(safe)) {
    if (fenced) {
      out.push(policy === "neutralize" ? neutralizeTags(line) : line);
      continue;
    }
    out.push(
      rewriteLine(line)
        .map((p) => (p.code && policy === "literal" ? p.text : neutralizeTags(p.text)))
        .join(""),
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

function buildCard(title: string, template: CardTemplate, markdown: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements: [{ tag: "markdown", content: markdown }] },
  });
}

/** Card title: `pi · <label>` (+ ` (i/n)`). The label is sanitized + bounded. */
export function cardTitle(label: string, index = 1, total = 1): string {
  return `pi · ${sanitizeLabel(label)}${partSuffix(index, total)}`;
}

export interface RenderedMessage {
  msgType: "interactive" | "text";
  /** serialized platform `content` (already JSON) — send verbatim */
  content: string;
  /** UTF-8 bytes of `content` */
  bytes: number;
}
export interface RenderedPart extends RenderedMessage {
  msgType: "interactive";
  /** 1-based */
  index: number;
  total: number;
}

export interface ReplyInput {
  kind: ReplyKind;
  /** session label, e.g. `api · a1b2c3` (sanitized + bounded here) */
  label: string;
  /** 6-char session id prefix for the overflow attachment name `reply-<sid6>.md` */
  shortId?: string;
  /** assistant markdown (untrusted) */
  text: string;
  /** the wire delivered a truncated text (`truncated:true`) ⇒ explicit "output incomplete" label */
  truncated?: boolean;
  /** failed-run card: stop reason + error message (both untrusted) */
  failure?: { stopReason?: string; message?: string };
  /** group replies @ the sender: validated open_id; first part only */
  mention?: string;
  /** more than `maxParts` parts: `file` (default) = part 1 + attachment, `truncate` = `maxParts` parts + note */
  overflow?: "file" | "truncate";
  codeTags?: CodeTagsPolicy;
  /** test seams (defaults: frozen limits) */
  maxCardBytes?: number;
  maxParts?: number;
}

export interface ReplyOverflow {
  /** the whole sanitized assistant text (NOT neutralized: it is a file, not a card) */
  fullText: string;
  fileName: string;
  /** the file itself was clipped to the upload cap */
  clipped: boolean;
}

export interface RenderedReply {
  parts: RenderedPart[];
  /** present only for `overflow:"file"` when the text did not fit `maxParts` parts */
  overflow?: ReplyOverflow;
  /** `overflow:"truncate"` cut the text */
  truncatedByOverflow: boolean;
  /** the wire-truncation label was appended */
  incomplete: boolean;
}

function leadFor(input: ReplyInput, codeTags: CodeTagsPolicy): string {
  if (input.kind !== "failed") return "";
  const stop = markupSafeLabel(input.failure?.stopReason ?? "", 40);
  const aborted = input.failure?.stopReason === "aborted";
  const head = aborted ? "**⏹ 运行已中止**" : "**❌ 运行失败**";
  const detail = input.failure?.stopReason !== undefined && stop !== "session" && !aborted ? ` · ${stop}` : "";
  const raw = sanitizeText(input.failure?.message ?? "").trim();
  let msg = "";
  if (raw !== "") {
    const cps = [...raw];
    const clipped =
      cps.length > ERROR_MESSAGE_MAX_CODE_POINTS ? `${cps.slice(0, ERROR_MESSAGE_MAX_CODE_POINTS).join("")}…` : raw;
    msg =
      "\n" +
      neutralizeMarkdown(clipped, { codeTags })
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
  }
  return `${head}${detail}${msg}`;
}

function safeShortId(shortId: string | undefined): string {
  const s = (shortId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
  return s === "" ? "reply" : s;
}

/**
 * Render one final reply (one run). Always returns ≥1 part; every part's serialized card is verified ≤ the cap
 * (`maxCardBytes`, default frozen 20 000) — the budget is derived from the REAL serialized chrome, then re-checked.
 */
export function renderReply(input: ReplyInput): RenderedReply {
  const cap = Math.max(1_024, Math.floor(input.maxCardBytes ?? FEISHU_REPLY_LIMITS.maxCardBytes));
  const maxParts = Math.max(1, Math.floor(input.maxParts ?? FEISHU_REPLY_LIMITS.maxParts));
  const codeTags = input.codeTags ?? "neutralize";
  const mode = input.overflow ?? "file";
  const template: CardTemplate =
    input.kind === "failed" && input.failure?.stopReason === "aborted" ? "orange" : KIND_TEMPLATE[input.kind];

  const lead = leadFor(input, codeTags);
  // Work bound: the card path never needs more than (maxParts + 1) parts' worth of text (a char costs ≥ 1 JSON
  // byte), so a huge assistant text is clipped BEFORE the per-line passes; the attachment keeps the whole text.
  const rawText = sanitizeText(input.text);
  const workChars = (maxParts + 1) * cap;
  const body = neutralizeMarkdown(rawText.length > workChars ? rawText.slice(0, workChars) : rawText, { codeTags });
  let full = lead === "" ? body : body.trim() === "" ? lead : `${lead}\n\n${body}`;
  if (full.trim() === "") full = EMPTY_REPLY_PLACEHOLDER;

  const mention =
    input.mention !== undefined && FEISHU_OPEN_ID_RE.test(input.mention) ? `<at id=${input.mention}></at> ` : "";
  const incomplete = input.truncated === true;
  const sid = safeShortId(input.shortId);
  const fileName = `reply-${sid}.md`;
  const trailerBase = incomplete ? `\n\n${OUTPUT_INCOMPLETE_LABEL}` : "";
  const fileNote = `\n\n${OVERFLOW_FILE_NOTE_PREFIX}\`${fileName}\``;
  const truncNote = `\n\n${OVERFLOW_TRUNCATED_NOTE}`;

  const chrome = (suffixReserve: number): number =>
    utf8(buildCard(cardTitle(input.label), template, "")) + suffixReserve;

  for (let extra = 0; extra < 6; extra++) {
    const slack = extra * 64;
    // pass A: a single part (no numbering)
    const a = splitMarkdown(full, {
      maxParts: 1,
      budgetFor: () => cap - chrome(0) - jsonBytes(mention) - jsonBytes(trailerBase) - slack,
    });
    let bodies: string[];
    let overflow: ReplyOverflow | undefined;
    let truncatedByOverflow = false;
    let lastTrailer = trailerBase;
    if (a.complete && a.parts.length === 1) {
      bodies = a.parts;
    } else {
      const reserve = partSuffixReserveBytes(maxParts);
      const base = cap - chrome(reserve) - slack;
      const b = splitMarkdown(full, {
        maxParts,
        budgetFor: (i) => base - jsonBytes(trailerBase) - (i === 0 ? jsonBytes(mention) : 0),
      });
      if (b.complete) {
        bodies = b.parts;
      } else if (mode === "file") {
        // part 1 only + attachment note
        const one = splitMarkdown(full, {
          maxParts: 1,
          budgetFor: () => cap - chrome(0) - jsonBytes(mention) - jsonBytes(trailerBase) - jsonBytes(fileNote) - slack,
        });
        bodies = one.parts;
        lastTrailer = `${fileNote}${trailerBase}`;
        const raw = rawText;
        const limit = FEISHU_FILE_LIMITS.outboundUploadMaxBytes;
        let clipped = false;
        let fullText = raw;
        if (utf8(raw) > limit) {
          fullText = Buffer.from(raw, "utf8")
            .subarray(0, limit)
            .toString("utf8")
            .replace(/\uFFFD+$/u, "");
          clipped = true;
        }
        if (incomplete) fullText += `\n\n${OUTPUT_INCOMPLETE_LABEL}\n`;
        overflow = { fullText, fileName, clipped };
      } else {
        const t = splitMarkdown(full, {
          maxParts,
          budgetFor: (i) =>
            base -
            jsonBytes(trailerBase) -
            (i === 0 ? jsonBytes(mention) : 0) -
            (i === maxParts - 1 ? jsonBytes(truncNote) : 0),
        });
        bodies = t.parts;
        lastTrailer = `${truncNote}${trailerBase}`;
        truncatedByOverflow = true;
      }
    }
    const total = bodies.length;
    const parts: RenderedPart[] = bodies.map((b, idx) => {
      const prefix = idx === 0 ? mention : "";
      const suffix = idx === total - 1 ? lastTrailer : "";
      const content = buildCard(cardTitle(input.label, idx + 1, total), template, `${prefix}${b}${suffix}`);
      return { msgType: "interactive", content, bytes: utf8(content), index: idx + 1, total };
    });
    if (parts.every((p) => p.bytes <= cap)) {
      const reply: RenderedReply = { parts, truncatedByOverflow, incomplete };
      if (overflow !== undefined) reply.overflow = overflow;
      return reply;
    }
  }
  // unreachable in practice (budget is derived from the real chrome); fail closed with a fixed small card
  const content = buildCard(cardTitle(input.label), template, "⚠️ 回复无法渲染（内容过大）");
  return {
    parts: [{ msgType: "interactive", content, bytes: utf8(content), index: 1, total: 1 }],
    truncatedByOverflow: false,
    incomplete,
  };
}

// ---------------------------------------------------------------------------
// text notices
// ---------------------------------------------------------------------------

export interface NoticeInput {
  label: string;
  text: string;
  /** group notices @ the sender (validated open_id) */
  mention?: string;
  maxBytes?: number;
}

/**
 * Very short system notice as a TEXT message prefixed `【label】` (plan §6.1). Text messages do not render markdown
 * but DO parse `<at …>`; tag-shaped `<` is neutralized, over-long text is cut (with `…`) to the cap.
 */
export function renderNotice(input: NoticeInput): RenderedMessage {
  const cap = Math.max(256, Math.floor(input.maxBytes ?? FEISHU_REPLY_LIMITS.maxCardBytes));
  const mention =
    input.mention !== undefined && FEISHU_OPEN_ID_RE.test(input.mention) ? `<at user_id="${input.mention}"></at> ` : "";
  const head = `${mention}【${markupSafeLabel(input.label)}】`;
  let text = neutralizeTags(sanitizeText(input.text)).trim();
  if (text === "") text = EMPTY_REPLY_PLACEHOLDER;
  for (let extra = 0; extra < 6; extra++) {
    const budget = cap - utf8(JSON.stringify({ text: "" })) - jsonBytes(head) - jsonBytes("…") - extra * 64;
    const cut = splitMarkdown(text, { maxParts: 1, budgetFor: () => budget });
    const body = cut.complete ? (cut.parts[0] ?? "") : `${cut.parts[0] ?? ""}…`;
    const content = JSON.stringify({ text: `${head}${body}` });
    // same final re-check as renderReply: the budget is derived, the cap is verified
    if (utf8(content) <= cap) return { msgType: "text", content, bytes: utf8(content) };
  }
  const content = JSON.stringify({ text: "【notice】…" });
  return { msgType: "text", content, bytes: utf8(content) };
}

// ---------------------------------------------------------------------------
// xs-mirror card (feishu-xs-mirror plan §4.5) — read-only, zero actions
// ---------------------------------------------------------------------------

export const XS_MIRROR_BODY_MAX_CODE_POINTS = 1_500;
export const XS_MIRROR_CARD_MAX_BYTES = 8_192;

export interface XsMirrorCardInput {
  /** receiving session label (sanitized here) */
  label: string;
  kind: "message" | "broadcast" | "reply";
  from: { ref: string; name?: string; alias?: string };
  channel?: string;
  late?: boolean;
  queued?: boolean;
  wakeDowngraded?: string;
  /** untrusted body */
  text: string;
  /** already `safeFeishuLink`ed (falls back to words) */
  link: string;
  /** earlier mirrored messages that could not be pushed to this chat */
  omitted?: number;
  maxBytes?: number;
}

/** Inline-code-safe fragment: tag/markup neutralized, bounded, backticks replaced so the span cannot be closed. */
function codeSafe(v: string, max: number): string {
  return markupSafeLabel(v, max).replace(/`/g, "\u02cb");
}

const XS_TOKEN_RE = /^[a-z0-9_.-]{1,40}$/;

/**
 * Render one cross-session message mirror card (`buildCard` only: schema 2.0 + plain_text header + ONE markdown
 * element; no button/behaviors). Every sender-controlled field is escaped; the body is quoted line by line.
 */
export function renderXsMirror(input: XsMirrorCardInput): RenderedMessage {
  const cap = Math.max(
    1_024,
    Math.min(Math.floor(input.maxBytes ?? XS_MIRROR_CARD_MAX_BYTES), FEISHU_REPLY_LIMITS.maxCardBytes),
  );
  const title = `跨会话来信 · ${sanitizeLabel(input.label)}`;
  const head: string[] = ["**⚠️ 来自另一会话的消息，内容未经核实，请勿据此操作**"];
  if (input.from.alias !== undefined && input.from.alias !== "")
    head.push(`**别名** \`@${codeSafe(input.from.alias, 40)}\`（hub 核验）`);
  if (input.from.name !== undefined && input.from.name !== "")
    head.push(`**会话名** \`${codeSafe(input.from.name, 40)}\`（对方自报，未核验）`);
  head.push(`**ref** \`${codeSafe(input.from.ref, 40)}\``);
  const type =
    input.kind === "broadcast"
      ? `频道广播 \`#${codeSafe(input.channel ?? "", 40)}\``
      : input.kind === "reply"
        ? input.late === true
          ? "回复（迟到）"
          : "回复"
        : "点对点消息";
  head.push(`**类型** ${type}`);
  if (input.wakeDowngraded !== undefined && XS_TOKEN_RE.test(input.wakeDowngraded))
    head.push(`对方请求唤醒，但本会话未被唤醒（\`${input.wakeDowngraded}\`）`);
  if (input.queued === true) head.push("会话运行中，消息已排入当前回合（送达未确认）");
  const tail: string[] = [`本卡片仅供查看，不提供任何操作。在 web 查看：${input.link}`];
  const omitted = Math.max(0, Math.floor(input.omitted ?? 0));
  if (omitted > 0) tail.push(`此前另有 ${omitted} 条跨会话来信未能推送到这里，请到 web 查看`);

  const clean = sanitizeText(input.text);
  const cps = [...clean];
  const build = (take: number, forceNote: boolean): string => {
    const clipped = take < cps.length;
    const raw = cps.slice(0, take).join("");
    const quoted =
      raw === ""
        ? forceNote
          ? ""
          : "> " + EMPTY_REPLY_PLACEHOLDER
        : neutralizeMarkdown(raw)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
    const note = forceNote
      ? "> 正文过长，请在 web 查看"
      : clipped
        ? `> …（正文已截断，共 ${cps.length} 字，完整内容请在 web 查看）`
        : "";
    const body = [quoted, note].filter((x) => x !== "").join("\n");
    return `${head.join("\n")}\n\n${body}\n\n${tail.join("\n")}`;
  };
  let take = Math.min(cps.length, XS_MIRROR_BODY_MAX_CODE_POINTS);
  for (let i = 0; i < 5; i++) {
    const content = buildCard(title, "grey", build(take, false));
    if (utf8(content) <= cap) return { msgType: "interactive", content, bytes: utf8(content) };
    take = Math.floor(take * 0.75);
  }
  const content = buildCard(title, "grey", build(0, true));
  return { msgType: "interactive", content, bytes: utf8(content) };
}
