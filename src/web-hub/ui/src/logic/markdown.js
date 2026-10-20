/**
 * Whitelisted markdown parser (vue-plan.md v2.1 §3.1/§3.10, §5.2 — P5b cleanup): fenced code
 * blocks, inline code, bold/italic, lists, links (http/https only), headings, paragraphs.
 * Extended subset (markdown-whitelist-extension): GFM pipe tables (alignment colons included),
 * blockquotes (`>`, recursively block-parsed, GFM lazy continuation for paragraph lines),
 * strikethrough (`~~x~~`), and task list items (`- [ ]` / `- [x]`, read-only). Anything else
 * stays literal text — no construct ever passes raw HTML through.
 *
 * DOM rendering used to live here too (`toDom`/`renderMarkdown`, built on the legacy
 * `render/dom.js`'s `el()`); the Vue UI renders the same `MdNode[]` output with
 * `MarkdownView.vue`/`MdBlock.vue`/`MdInline.vue` (§3.10) instead, so those two functions —
 * and this file's only reason to depend on `dom.js` — are deleted here (P5b, §3.1's
 * disposition table: "保留 isSafeHref/parseMarkdown；toDom/renderMarkdown P5b 删").
 * preview-mode extensions (md-preview-html plan, user ruling 2026-10-20): `parseMarkdown(text,
 * { preview: true })` additionally recognizes standard images (`![alt](src "title")` ⇒ an
 * `image` inline node) and a SAFE HTML SUBSET — block wrappers `<p align>`/`<div align>`
 * (align ∈ left|center|right ⇒ an `html_block` node), inline `<img src alt width height>`
 * (integer-px / `N%` dimensions clamped to sane bounds), `<br>`, `<sub>`, `<sup>`,
 * `<b>`/`<strong>` (⇒ `strong`), `<i>`/`<em>` (⇒ `em`), `<code>` (⇒ `code`) and `<a href>`
 * (http(s) ⇒ `link`, path ⇒ `pathlink`, anything else ⇒ literal). No other tag/attribute ever
 * parses — it stays literal text exactly as without the option (the transcript renderer never
 * passes the option and its output is byte-identical, pinned by the differential fixtures).
 */

/**
 * @typedef {"" | "left" | "center" | "right"} TableAlign
 * @typedef {{ n: number, unit: "px" | "%" }} MdImageSize
 * @typedef {{ type: "text", text: string } | { type: "code", text: string }
 *   | { type: "strong", children: Inline[] } | { type: "em", children: Inline[] }
 *   | { type: "del", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }
 *   | { type: "pathlink", target: string, children: Inline[], raw: string }
 *   | { type: "textlink", children: Inline[], raw: string }
 *   | { type: "image", src: string, alt: string, title?: string, width?: MdImageSize, height?: MdImageSize }
 *   | { type: "br" }
 *   | { type: "sub", children: Inline[] } | { type: "sup", children: Inline[] }} Inline
 * @typedef {{ type: "code_block", lang: string, text: string }
 *   | { type: "paragraph", children: Inline[] }
 *   | { type: "heading", level: number, children: Inline[] }
 *   | { type: "list", ordered: boolean, items: Inline[][], checked?: (boolean | null)[] }
 *   | { type: "quote", children: MdNode[] }
 *   | { type: "html_block", align: TableAlign, children: Inline[] }
 *   | { type: "table", align: TableAlign[], header: Inline[][], rows: Inline[][][] }} MdNode
 *
 * `list.checked` is present only when at least one item carried a task marker; it is parallel
 * to `items` (`null` = plain item, `true`/`false` = task item, checked or not). The
 * `image`/`br`/`sub`/`sup` inline nodes and the `html_block` block node are only ever produced
 * in preview mode (`{ preview: true }`).
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^\s{0,8}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const DELIM_CELL_RE = /^:?-+:?$/;
const LINK_RE = /^\[([^\[\]\n]{0,1000})\]\(\s*([^()\s]{1,2048})(?:\s+"[^"\n]{0,200}")?\s*\)/;
// GFM-style bare-URL autolink. Body stops at whitespace, `<>` and CJK full-width punctuation;
// bounded (scheme + 2048) so one attempt is O(1) and attempts only start at `h`/`H` word starts.
const AUTOLINK_RE = /^https?:\/\/[^\s<>，。；：！？、）》」』】（《「『【“”‘’…〉〕]{1,2048}/i;
const AUTOLINK_PREV_RE = /[\s(<[{"'\u2E80-\u9FFF\uAC00-\uD7AF\u3000-\u303F\uFF00-\uFFEF]/;
const AUTOLINK_TRAIL = ".,;:!?'\"*_~";
const SAFE_HREF_RE = /^https?:\/\/[^\s]+$/i;
const MAX_DEPTH = 6;
const MAX_QUOTE_DEPTH = 10;

/* --- preview-mode safe-HTML subset (md-preview-html plan) — all bounded, whitelist-only --- */
/** `![alt](src "title")` — the LINK_RE shape with a leading `!`. */
const IMAGE_RE = /^!\[([^\[\]\n]{0,1000})\]\(\s*([^()\s]{1,2048})(?:\s+"([^"\n]{0,200})")?\s*\)/;
/** One opening tag: name + a well-formed attribute list (no `>` inside quoted values) + `/`?. */
const HTML_TAG_OPEN_RE =
  /^<([a-zA-Z][a-zA-Z0-9]{0,15})((?:\s+[\w-]+(?:\s*=\s*(?:"[^"\n]{0,2048}"|'[^'\n]{0,2048}'|[^\s>"'\n]{1,2048}))?)*)\s*(\/?)>/;
/** `<p …>`/`<div …>` alone on a line (multi-line block form). */
const HTML_BLOCK_OPEN_RE = /^ {0,3}<(p|div)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s>"']+))?)*)\s*>\s*$/i;
/** `<p …>inner</p>` on ONE line. */
const HTML_BLOCK_LINE_RE =
  /^ {0,3}<(p|div)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s>"']+))?)*)\s*>(.{0,2000}?)<\/\1>\s*$/i;
const HTML_BLOCK_CLOSE_RE = /^ {0,3}<\/(p|div)>\s*$/i;
/** A multi-line block wrapper may span at most this many lines (README's blocks are 4–6). */
const HTML_BLOCK_MAX_LINES = 100;
/** Search window for a paired tag's `</tag>` (keeps every `<` attempt O(1)). */
const HTML_PAIR_MAX_CHARS = 4096;
/** `src`/`alt`/`width`/`height` only — anything else (style/class/onXxx/srcset) ⇒ literal. */
const IMG_ATTRS = new Set(["src", "alt", "width", "height"]);
const IMG_DIM_RE = /^(\d{1,7})(%)?$/;
/** Sane bounds: percent dims clamp into 1–100, px dims into 1–2000. */
const IMG_DIM_MAX_PX = 2000;
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
/** Paired inline tags → the node they map to (`a` handled separately). */
const PAIRED_HTML_TAGS = new Map([
  ["sub", "sub"],
  ["sup", "sup"],
  ["b", "strong"],
  ["strong", "strong"],
  ["i", "em"],
  ["em", "em"],
  ["code", "code"],
  ["a", "a"],
]);

const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * chunked-plan §4.3.2: the fence-closing scan, extracted verbatim out of `parseBlocks` (pure
 * refactor — the fixed-seed differential test against `fixtures/markdown-ref.js` pins the
 * output byte-for-byte). Returns the index of the closing fence line for the fence opened at
 * `lines[i]` with marker `marker` (same char, run length ≥ the opener's), or -1 when the
 * fence runs unclosed to the end of `lines`. `scanMarkdownTail` mirrors `parseBlocks`
 * through this shared helper so the two can never disagree on where a fence ends.
 * @param {string[]} lines @param {number} i @param {string} marker
 * @returns {number}
 */
function findFenceClose(lines, i, marker) {
  for (let j = i + 1; j < lines.length; j++) {
    const close = FENCE_CLOSE_RE.exec(/** @type {string} */ (lines[j]));
    if (close && close[1]?.[0] === marker[0] && (close[1]?.length ?? 0) >= marker.length) return j;
  }
  return -1;
}

/**
 * chunked-plan §4.3.3: the fence marker (` ``` ` / `~~~` run) of an opening-fence line, or
 * `null` when the line does not open a fence. Exported so `logic/previewStream.js`'s forced
 * cut can close/reopen an unclosed fence with the SAME marker without re-typing the regex.
 * @param {unknown} line
 * @returns {string | null}
 */
export function markdownFenceMarker(line) {
  if (typeof line !== "string") return null;
  const fence = FENCE_RE.exec(line);
  return fence === null ? null : /** @type {string} */ (fence[1]);
}

/**
 * A markdown link target that names a filesystem path (relative `./x` `../x` `x/y.md`, or
 * absolute `/x`): no URI scheme, not protocol-relative `//host`, not a pure `#frag` / `?query`.
 * Pure shape check — resolution against a base directory happens in the UI (`mdLinkPath.ts`).
 * @param {string} href
 */
export function isPathLinkTarget(href) {
  if (href === "" || href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
}

/** @param {string} href */
export function isSafeHref(href) {
  return SAFE_HREF_RE.test(href);
}

/**
 * @param {unknown} text
 * @param {{ preview?: boolean }} [opts] `preview: true` enables the safe-HTML subset +
 *   `![alt](src)` image nodes (file-preview rendering only; default output is unchanged).
 * @returns {MdNode[]}
 */
export function parseMarkdown(text, opts) {
  const preview = opts !== undefined && opts !== null && opts.preview === true;
  const src = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  return parseBlocks(src.split("\n"), 0, preview);
}

/**
 * Block-level pass over one quote nesting level. Single forward scan, O(total chars) per
 * level — every construct below is recognized by per-line anchored regexes or bounded char
 * scans, so streaming re-parses stay cheap.
 * @param {string[]} lines @param {number} qdepth @param {boolean} preview
 * @returns {MdNode[]}
 */
function parseBlocks(lines, qdepth, preview) {
  /** @type {MdNode[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ ordered: boolean, items: string[], checked: (boolean | null)[] } | null} */
  let list = null;

  const flushPara = () => {
    if (para.length > 0) out.push({ type: "paragraph", children: parseInline(para.join("\n"), 0, false, preview) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      /** @type {MdNode} */
      const node = {
        type: "list",
        ordered: list.ordered,
        items: list.items.map((t) => parseInline(t, 0, false, preview)),
      };
      if (list.checked.some((c) => c !== null)) node.checked = list.checked;
      out.push(node);
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const marker = /** @type {string} */ (fence[1]);
      const lang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      // chunked-plan §4.3.2: the closing scan lives in `findFenceClose` (shared with
      // `scanMarkdownTail`); unclosed ⇒ the body runs to the end of `lines`.
      const closeIdx = findFenceClose(lines, i, marker);
      const end = closeIdx === -1 ? lines.length : closeIdx;
      out.push({ type: "code_block", lang, text: lines.slice(i + 1, end).join("\n") });
      i = end;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        children: parseInline(heading[2] ?? "", 0, false, preview),
      });
      continue;
    }
    if (qdepth < MAX_QUOTE_DEPTH && QUOTE_RE.test(line)) {
      flushPara();
      flushList();
      i = collectQuote(lines, i, out, qdepth, preview);
      continue;
    }
    if (preview) {
      const hb = matchHtmlBlock(lines, i, preview);
      if (hb !== null) {
        flushPara();
        flushList();
        out.push(hb.node);
        i = hb.end;
        continue;
      }
    }
    if (line.includes("|") && i + 1 < lines.length) {
      const table = tryParseTable(lines, i, preview);
      if (table) {
        flushPara();
        flushList();
        out.push(table.node);
        i = table.end;
        continue;
      }
    }
    const item = LIST_RE.exec(line);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1] ?? "");
      let text = item[2] ?? "";
      /** @type {boolean | null} */
      let checked = null;
      if (!ordered) {
        const task = TASK_RE.exec(text);
        if (task) {
          checked = (task[1] ?? " ").toLowerCase() === "x";
          text = task[2] ?? "";
        }
      }
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [], checked: [] };
      list.items.push(text);
      list.checked.push(checked);
      continue;
    }
    if (list && /^\s+\S/.test(line) && list.items.length > 0) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last]}\n${line.trim()}`; // continuation line
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

/**
 * Aggregate one blockquote starting at `lines[start]`: consecutive `>`-prefixed lines plus
 * GFM lazy continuation lines (a bare line joins only while the quote's inner tail is an open
 * paragraph — never across a blank line, a fence, or a line that itself starts a new block).
 * The stripped inner lines recurse through `parseBlocks`, so quotes nest lists/code/tables.
 * @param {string[]} lines @param {number} start @param {MdNode[]} out @param {number} qdepth
 * @param {boolean} preview
 * @returns {number} index of the last consumed line
 */
function collectQuote(lines, start, out, qdepth, preview) {
  /** @type {string[]} */
  const inner = [];
  let inFence = false;
  let paraOpen = false;
  let j = start;
  for (; j < lines.length; j++) {
    const l = /** @type {string} */ (lines[j]);
    const q = QUOTE_RE.exec(l);
    /** @type {string} */
    let stripped;
    if (q) {
      stripped = q[1] ?? "";
    } else {
      // lazy continuation: bare line, quote tail is an open paragraph, and the bare line
      // does not itself open a new block (GFM paragraph continuation rules).
      const blocked =
        l.trim() === "" ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        LIST_RE.test(l) ||
        QUOTE_RE.test(l) ||
        l.includes("|");
      if (!paraOpen || inFence || blocked) break;
      stripped = l;
    }
    inner.push(stripped);
    if (stripped.trim() === "") {
      paraOpen = false;
    } else if (FENCE_RE.test(stripped)) {
      inFence = !inFence;
      paraOpen = false;
    } else if (inFence) {
      paraOpen = false;
    } else {
      paraOpen =
        !HEADING_RE.test(stripped) &&
        !LIST_RE.test(stripped) &&
        !QUOTE_RE.test(stripped) &&
        !isDelimRow(stripped) &&
        !stripped.includes("|");
    }
  }
  out.push({ type: "quote", children: parseBlocks(inner, qdepth + 1, preview) });
  return j - 1;
}

/**
 * GFM pipe table starting at `lines[start]`: header row (must contain a pipe) + delimiter row
 * (`:?-+:?` cells, count must equal the header's) + data rows. A malformed delimiter or a
 * header/delimiter column mismatch is NOT a table — the caller falls through and both lines
 * degrade to ordinary paragraph text. Ragged data rows follow GFM: extra cells are truncated,
 * missing cells padded empty. A data row without any pipe (or a blank line) ends the table.
 * @param {string[]} lines @param {number} start @param {boolean} preview
 * @returns {{ node: MdNode, end: number } | null}
 */
function tryParseTable(lines, start, preview) {
  const headCells = splitRow(/** @type {string} */ (lines[start]));
  if (!headCells || headCells.length === 0) return null;
  const delimCells = splitRow(/** @type {string} */ (lines[start + 1]));
  if (!delimCells || delimCells.length !== headCells.length) return null;
  /** @type {TableAlign[]} */
  const align = [];
  for (const raw of delimCells) {
    const cell = raw.trim();
    if (!DELIM_CELL_RE.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  const cols = align.length;
  const header = headCells.map((c) => parseInline(c.trim(), 0, false, preview));
  /** @type {Inline[][][]} */
  const rows = [];
  let j = start + 2;
  for (; j < lines.length; j++) {
    const l = /** @type {string} */ (lines[j]);
    if (l.trim() === "") break;
    const cells = splitRow(l);
    if (!cells || cells.length === 0) break;
    const norm = cells.slice(0, cols);
    while (norm.length < cols) norm.push("");
    rows.push(norm.map((c) => parseInline(c.trim(), 0, false, preview)));
  }
  return { node: { type: "table", align, header, rows }, end: j - 1 };
}

/**
 * Split a table row into raw cell strings on UNESCAPED pipes (a `\|` stays literal inside the
 * cell; `parseInline`'s backslash escape resolves it to `|`). Outer empty cells from
 * leading/trailing pipes are dropped. Returns null when the line has no pipe at all.
 * @param {string} line
 * @returns {string[] | null}
 */
function splitRow(line) {
  let hasPipe = false;
  /** @type {string[]} */
  const cells = [];
  let cur = "";
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === "\\" && line[k + 1] === "|") {
      cur += "\\|";
      k++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      hasPipe = true;
      continue;
    }
    cur += ch;
  }
  if (!hasPipe) return null;
  cells.push(cur);
  if (cells.length > 0 && /** @type {string} */ (cells[0]).trim() === "") cells.shift();
  if (cells.length > 0 && /** @type {string} */ (cells[cells.length - 1]).trim() === "") cells.pop();
  return cells;
}

/**
 * @param {string} line
 * @returns {boolean} true when every pipe-delimited cell is a `:?-+:?` delimiter cell
 */
function isDelimRow(line) {
  const cells = splitRow(line);
  return !!cells && cells.length > 0 && cells.every((c) => DELIM_CELL_RE.test(c.trim()));
}

/* -------------------------------------------------------------------------
 * Preview-mode safe-HTML subset helpers (md-preview-html plan). Everything below is
 * whitelist-only and bounded: a non-matching / malformed / over-long construct returns
 * `null` and the caller emits the source as literal text — exactly the no-option behavior.
 * ---------------------------------------------------------------------- */

/** @param {string} s */
function decodeHtmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

/**
 * Attribute-list string (already shape-checked by the tag regexes) → name → value map, or
 * `null` on a duplicate attribute name or an unparseable rest. Names compare lowercase.
 * @param {string} raw
 * @returns {Map<string, string> | null}
 */
function parseHtmlAttrs(raw) {
  /** @type {Map<string, string>} */
  const attrs = new Map();
  let i = 0;
  while (i < raw.length) {
    const ws = /^\s+/.exec(raw.slice(i));
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const m = /^([\w-]+)(?:\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s>"'\n]+)))?/.exec(raw.slice(i));
    if (!m) return null;
    const name = (m[1] ?? "").toLowerCase();
    if (attrs.has(name)) return null;
    attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
    i += m[0].length;
  }
  return attrs;
}

/**
 * One width/height attribute value: integer px or `N%`, clamped into sane bounds
 * (px 1–2000, % 1–100). Anything else ⇒ `undefined` (the dimension is dropped, the image
 * itself still renders).
 * @param {string} raw
 * @returns {MdImageSize | undefined}
 */
function imgDimOf(raw) {
  const m = IMG_DIM_RE.exec(raw);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n)) return undefined;
  if (m[2] === "%") return { n: Math.min(100, Math.max(1, n)), unit: "%" };
  return { n: Math.min(IMG_DIM_MAX_PX, Math.max(1, n)), unit: "px" };
}

/**
 * Whitelisted `<img>` attributes → an `image` node, or `null` (⇒ literal) on any
 * non-whitelisted attribute (style/class/onXxx/srcset/…) or a missing `src`.
 * @param {Map<string, string>} attrs
 * @returns {Inline | null}
 */
function imageNodeFromAttrs(attrs) {
  for (const name of attrs.keys()) if (!IMG_ATTRS.has(name)) return null;
  const src = attrs.get("src");
  if (src === undefined) return null;
  /** @type {Inline} */
  const node = { type: "image", src: decodeHtmlEntities(src), alt: decodeHtmlEntities(attrs.get("alt") ?? "") };
  const w = attrs.get("width");
  if (w !== undefined) {
    const dim = imgDimOf(w);
    if (dim !== undefined) node.width = dim;
  }
  const h = attrs.get("height");
  if (h !== undefined) {
    const dim = imgDimOf(h);
    if (dim !== undefined) node.height = dim;
  }
  return node;
}

/**
 * A block wrapper's attribute list → its alignment, or `null` when anything but an optional
 * single `align="left|center|right"` is present (⇒ the whole construct stays literal).
 * @param {string} attrsRaw
 * @returns {TableAlign | null}
 */
function htmlBlockAlign(attrsRaw) {
  const attrs = parseHtmlAttrs(attrsRaw);
  if (attrs === null) return null;
  if (attrs.size === 0) return "";
  if (attrs.size !== 1 || !attrs.has("align")) return null;
  const v = (attrs.get("align") ?? "").toLowerCase();
  return v === "left" || v === "center" || v === "right" ? v : null;
}

/**
 * Closing-tag line index for the block wrapper opened at `lines[start]`, or -1 when the
 * block does not close within `HTML_BLOCK_MAX_LINES` (the parser then treats every line as
 * literal paragraph text — the scan mirrors this exactly).
 * @param {string[]} lines @param {number} start @param {string} tag (lowercase)
 */
function findHtmlBlockClose(lines, start, tag) {
  const bound = Math.min(lines.length, start + 1 + HTML_BLOCK_MAX_LINES);
  for (let j = start + 1; j < bound; j++) {
    const close = HTML_BLOCK_CLOSE_RE.exec(/** @type {string} */ (lines[j]));
    if (close && (close[1] ?? "").toLowerCase() === tag) return j;
  }
  return -1;
}

/**
 * Preview-mode block wrapper at `lines[start]`: the single-line form
 * `<p align="center">inner</p>` and the README's multi-line form (opening tag line, inner
 * lines, closing tag line). Inner content is INLINE-parsed only (no nested blocks). Returns
 * null when nothing recognized — the caller falls through to ordinary paragraph handling.
 * @param {string[]} lines @param {number} start @param {boolean} preview
 * @returns {{ node: MdNode, end: number } | null}
 */
function matchHtmlBlock(lines, start, preview) {
  const line = /** @type {string} */ (lines[start]);
  const single = HTML_BLOCK_LINE_RE.exec(line);
  if (single) {
    const align = htmlBlockAlign(single[2] ?? "");
    if (align === null) return null;
    return {
      node: { type: "html_block", align, children: parseInline(single[3] ?? "", 0, false, preview) },
      end: start,
    };
  }
  const open = HTML_BLOCK_OPEN_RE.exec(line);
  if (!open) return null;
  const align = htmlBlockAlign(open[2] ?? "");
  if (align === null) return null;
  const tag = (open[1] ?? "").toLowerCase();
  const closeIdx = findHtmlBlockClose(lines, start, tag);
  if (closeIdx === -1) return null;
  const inner = lines.slice(start + 1, closeIdx).join("\n");
  return { node: { type: "html_block", align, children: parseInline(inner, 0, false, preview) }, end: closeIdx };
}

/**
 * Preview-mode inline HTML at `src[i]` (a `<`): whitelisted paired tags (`sub`/`sup`/`b`/
 * `strong`/`i`/`em`/`code`/`a`) with NO attributes (`a` gets exactly one `href`), the void
 * `<br>` and the attribute-whitelisted `<img>`. A paired tag needs its `</tag>` within
 * `HTML_PAIR_MAX_CHARS`; non-empty inner only. Anything else ⇒ `null` (literal text).
 * @param {string} src @param {number} i @param {number} depth @param {boolean} inLink
 * @param {boolean} preview
 * @returns {{ node: Inline, length: number } | null}
 */
function matchHtmlInline(src, i, depth, inLink, preview) {
  const open = HTML_TAG_OPEN_RE.exec(src.slice(i, i + 2300));
  if (!open) return null;
  const tag = (open[1] ?? "").toLowerCase();
  const attrsRaw = open[2] ?? "";
  const full = open[0];
  if (tag === "br") {
    if (attrsRaw.trim() !== "") return null;
    return { node: { type: "br" }, length: full.length };
  }
  if (tag === "img") {
    const attrs = parseHtmlAttrs(attrsRaw);
    if (attrs === null) return null;
    const node = imageNodeFromAttrs(attrs);
    return node === null ? null : { node, length: full.length };
  }
  const kind = PAIRED_HTML_TAGS.get(tag);
  if (kind === undefined) return null;
  const attrs = parseHtmlAttrs(attrsRaw);
  if (attrs === null) return null;
  if (kind === "a" ? attrs.size !== 1 || !attrs.has("href") : attrs.size > 0) return null;
  const from = i + full.length;
  const closeAt = src
    .slice(from, from + HTML_PAIR_MAX_CHARS)
    .toLowerCase()
    .indexOf(`</${tag}>`);
  if (closeAt <= 0) return null; // unclosed or empty inner ⇒ literal
  const inner = src.slice(from, from + closeAt);
  const length = full.length + closeAt + tag.length + 3;
  if (kind === "code") return { node: { type: "code", text: inner }, length };
  if (kind === "a") {
    const href = decodeHtmlEntities(attrs.get("href") ?? "");
    const children = parseInline(inner, depth + 1, true, preview);
    if (isSafeHref(href)) return { node: { type: "link", href, children }, length };
    if (isPathLinkTarget(href)) {
      return { node: { type: "pathlink", target: href, children, raw: src.slice(i, i + length) }, length };
    }
    return null; // any other scheme ⇒ the whole tag stays literal text
  }
  const children = parseInline(inner, depth + 1, inLink, preview);
  return { node: { type: kind, children }, length };
}

/**
 * Bare-URL candidate at `src[i]` (caller guarantees a word start) → trimmed URL or "".
 * @param {string} src @param {number} i
 */
function matchAutolink(src, i) {
  const m = AUTOLINK_RE.exec(src.slice(i, i + 2060));
  if (!m) return "";
  const raw = m[0];
  const minLen = raw.indexOf("://") + 4;
  // Paren balance counted ONCE (trimming only ever removes trailing chars), so a run of
  // trailing `)` costs O(n) instead of a recount per char.
  let open = 0;
  let close = 0;
  for (const ch of raw) {
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  let end = raw.length;
  while (end >= minLen) {
    const last = raw[end - 1] ?? "";
    if (AUTOLINK_TRAIL.includes(last)) {
      end--;
    } else if (last === ")" && close > open) {
      end--;
      close--;
    } else break;
  }
  const url = raw.slice(0, end);
  return url.length >= minLen && isSafeHref(url) ? url : "";
}

/**
 * @param {string} src
 * @param {number} depth
 * @param {boolean} [inLink] inside an explicit link's text — never autolink there
 * @param {boolean} [preview] preview-mode extensions (safe-HTML subset + images)
 * @returns {Inline[]}
 */
function parseInline(src, depth, inLink = false, preview = false) {
  /** @type {Inline[]} */
  const out = [];
  let buf = "";
  // dir-plan v3.1 §4.2 failed-search memos (amortized-linear inline parsing, output
  // IDENTICAL to the pre-change parser by construction): a closing search that found no
  // valid delimiter from position `from` can never find one from any later start — a
  // candidate's validity depends only on the characters around the candidate itself plus
  // `at > from`, so "nothing valid ≥ from" implies "nothing valid ≥ from' > from". Both
  // maps are LOCAL to this call (recursion slices are disjoint; depth ≤ MAX_DEPTH ⇒ every
  // character is processed O(7) times), and they only ever short-circuit a scan whose full
  // execution provably returns -1, so the emitted AST is byte-for-byte unchanged (pinned by
  // the fixed-seed differential test against fixtures/markdown-ref.js).
  /** @type {Map<string, number>} mark → earliest `from` whose findClose returned -1 */
  const noClose = new Map();
  /** @type {Map<number, number>} fence length → earliest `from` whose indexOf returned -1 */
  const noFence = new Map();
  const flush = () => {
    if (buf !== "") out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = /** @type {string} */ (src[i]);
    if (c === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!~|]/.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      // §4.2: `indexOf(fence)` matches any position containing ≥ n consecutive backticks —
      // "no such position ≥ from" is likewise monotone in `from`, so memoize per fence
      // length (a shorter run later in the string can still close, hence the length key).
      const fenceFailFrom = noFence.get(n);
      let end;
      if (fenceFailFrom !== undefined && fenceFailFrom <= i + n) {
        end = -1;
      } else {
        end = src.indexOf(fence, i + n);
        if (end === -1) noFence.set(n, i + n); // fenceFailFrom > i + n here ⇒ i + n is the new min
      }
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: src.slice(i + n, end) });
        i = end + n;
      } else {
        buf += fence;
        i += n;
      }
      continue;
    }
    if (c === "~" && src[i + 1] === "~" && depth < MAX_DEPTH) {
      const next = src[i + 2] ?? "";
      if (next !== "" && !/\s/.test(next)) {
        const end = findClose(src, i + 2, "~~", noClose);
        if (end > i + 2) {
          flush();
          out.push({ type: "del", children: parseInline(src.slice(i + 2, end), depth + 1, inLink, preview) });
          i = end + 2;
          continue;
        }
      }
      buf += "~~";
      i += 2;
      continue;
    }
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const dbl = src[i + 1] === c;
      const mark = dbl ? c + c : c;
      const prev = i > 0 ? (src[i - 1] ?? "") : "";
      const intraword = c === "_" && /[A-Za-z0-9]/.test(prev);
      const next = src[i + mark.length] ?? "";
      if (!intraword && next !== "" && !/\s/.test(next)) {
        const end = findClose(src, i + mark.length, mark, noClose);
        if (end > i + mark.length) {
          flush();
          const children = parseInline(src.slice(i + mark.length, end), depth + 1, inLink, preview);
          out.push(dbl ? { type: "strong", children } : { type: "em", children });
          i = end + mark.length;
          continue;
        }
      }
      buf += mark;
      i += mark.length;
      continue;
    }
    if (c === "[") {
      const m = LINK_RE.exec(src.slice(i, i + 3300));
      if (m) {
        flush();
        const href = m[2] ?? "";
        if (isSafeHref(href) && depth < MAX_DEPTH) {
          out.push({ type: "link", href, children: parseInline(m[1] ?? "", depth + 1, true, preview) });
        } else if (depth < MAX_DEPTH) {
          // Non-http(s) target: never a native <a>, never the raw `[..](..)` syntax. A relative /
          // absolute-path target ⇒ `pathlink` (the UI resolves it + opens the preview); any other
          // scheme / pure `#frag` / `?query` / `//host` ⇒ `textlink` (children only). `raw` is the
          // source slice (kept for the frozen-reference differential comparison; never rendered).
          const children = parseInline(m[1] ?? "", depth + 1, true, preview);
          if (isPathLinkTarget(href)) out.push({ type: "pathlink", target: href, children, raw: m[0] });
          else out.push({ type: "textlink", children, raw: m[0] });
        } else {
          out.push({ type: "text", text: m[0] }); // depth cap ⇒ literal text
        }
        i += m[0].length;
        continue;
      }
    }
    if (preview && c === "!" && src[i + 1] === "[" && depth < MAX_DEPTH) {
      const m = IMAGE_RE.exec(src.slice(i, i + 3300));
      if (m) {
        flush();
        /** @type {Inline} */
        const node = { type: "image", src: m[2] ?? "", alt: m[1] ?? "" };
        if (m[3] !== undefined) node.title = m[3];
        out.push(node);
        i += m[0].length;
        continue;
      }
    }
    if (preview && c === "<" && depth < MAX_DEPTH) {
      const hit = matchHtmlInline(src, i, depth, inLink, preview);
      if (hit !== null) {
        flush();
        out.push(hit.node);
        i += hit.length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !inLink && (i === 0 || AUTOLINK_PREV_RE.test(src[i - 1] ?? ""))) {
      const url = matchAutolink(src, i);
      if (url !== "") {
        flush();
        out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * Closing delimiter: same mark, preceded by non-space, not glued to a longer run.
 * §4.2: `noClose` is the caller's per-`parseInline`-call failure memo (mark → earliest
 * `from` whose search returned -1). A memo hit (`failFrom <= from`) returns -1 directly —
 * exactly what the full scan would return, since any valid close at `at > from ≥ failFrom`
 * would have been found by the earlier failed scan too. On failure the earliest `from` is
 * recorded (`failFrom > from` holds on this path — smaller values returned early), so a
 * run of unclosed openers like `"*a ".repeat(n)` costs ONE full scan instead of one per
 * `*` (the O(n²) the linearization exists to kill).
 * @param {string} src @param {number} from @param {string} mark @param {Map<string, number>} noClose
 */
function findClose(src, from, mark, noClose) {
  const failFrom = noClose.get(mark);
  if (failFrom !== undefined && failFrom <= from) return -1;
  let at = src.indexOf(mark, from);
  while (at !== -1) {
    const before = src[at - 1] ?? "";
    const after = src[at + mark.length] ?? "";
    const glued = mark.length === 1 && after === mark;
    const intraword = mark[0] === "_" && /[A-Za-z0-9]/.test(after);
    if (at > from && !/\s/.test(before) && !glued && !intraword) return at;
    at = src.indexOf(mark, at + (glued ? 2 : 1));
  }
  noClose.set(mark, from);
  return -1;
}

/* -------------------------------------------------------------------------
 * Chunked markdown streaming (web-hub-preview chunked-plan §4.3, package P2a) —
 * `scanMarkdownTail`, appended ONLY. A mirror scan over the COMPLETE lines of a pending
 * tail that finds the last TOP-LEVEL blank line (the only safe cut point: `parseBlocks`
 * flushes paragraphs/lists there, and the three multi-line constructs — fences, quotes,
 * tables — are mirrored through the parser's own private helpers so a line that is inside
 * one of them is never mistaken for a cut point). The §4.3.1 invariant (property-tested):
 * for `cut` returned here, `parseMarkdown(text.slice(0, cut)) ++ parseMarkdown(text.slice(cut))`
 * deep-equals `parseMarkdown(text)`.
 * ---------------------------------------------------------------------- */

/**
 * @param {string[]} lines
 * @returns {number[]} starts[i] = the char offset of `lines[i]` in the joined text
 */
function lineStartsOf(lines) {
  const starts = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = at;
    at += /** @type {string} */ (lines[i]).length + 1;
  }
  return starts;
}

/**
 * chunked-plan §4.3.2: scan the COMPLETE lines of `text` (already `\r\n?`→`\n` normalized,
 * starting at a top-level boundary) and report the last safe cut.
 *
 * Mirrors `parseBlocks`'s recognition order exactly — fence first, then blank, heading,
 * quote, table — minus list/paragraph handling (single-line constructs carry no cross-blank
 * state, so they cannot affect where a cut is safe). Only complete lines are scanned: the
 * lookahead a table needs (`i+1`) never sees the incomplete trailing line, and a closing
 * fence on the incomplete line is likewise invisible — both only ever SHRINK the reported
 * cut, never produce a wrong one (the conservative direction). With `opts.preview` the
 * preview-mode html block wrappers (`<p align>…</p>`) are mirrored too: a recognized block is
 * consumed through its closing line so the scan never cuts inside one (an unclosed opener is
 * literal to the parser within `HTML_BLOCK_MAX_LINES`, so it needs no mirroring).
 * @param {string} text @param {{ preview?: boolean }} [opts]
 * @returns {{ cut: number, lineEnd: number, openFence: string | null }}
 *   cut       start of the line AFTER the last top-level blank line (-1 = no safe cut);
 *   lineEnd   one past the last "\n" (0 when there is no complete line at all);
 *   openFence  when the complete lines end INSIDE an unclosed fence, its opening line (for
 *              the forced cut's close/reopen, §4.3.3)
 */
export function scanMarkdownTail(text, opts) {
  const preview = opts !== undefined && opts !== null && opts.preview === true;
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return { cut: -1, lineEnd: 0, openFence: null };
  const lines = text.slice(0, nl).split("\n"); // complete lines only
  const starts = lineStartsOf(lines);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    const fence = FENCE_RE.exec(line); // same order as parseBlocks: fence first
    if (fence) {
      const j = findFenceClose(lines, i, /** @type {string} */ (fence[1]));
      if (j === -1) return { cut, lineEnd: nl + 1, openFence: line };
      i = j;
      continue;
    }
    if (line.trim() === "") {
      cut = i + 1 < lines.length ? /** @type {number} */ (starts[i + 1]) : nl + 1;
      continue;
    }
    if (HEADING_RE.test(line)) continue;
    if (preview) {
      // mirror matchHtmlBlock's multi-line consumption so a cut never lands inside a wrapper
      const open = HTML_BLOCK_OPEN_RE.exec(line);
      if (open && htmlBlockAlign(open[2] ?? "") !== null) {
        const closeIdx = findHtmlBlockClose(lines, i, (open[1] ?? "").toLowerCase());
        if (closeIdx !== -1) {
          i = closeIdx;
          continue;
        }
      }
    }
    if (QUOTE_RE.test(line)) {
      // A quote swallows its `>`-prefixed blank lines and lazy continuations — mirror the
      // same consumption (the collected nodes are discarded; only the end index matters).
      i = collectQuote(lines, i, [], 0, preview);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length) {
      // A table data row may itself LOOK like an opening fence (e.g. "```a|b") — mirror the
      // table's consumption so such a line is never treated as one.
      const t = tryParseTable(lines, i, preview);
      if (t) {
        i = t.end;
        continue;
      }
    }
    // list item / continuation / paragraph line: single-line state, no effect on cuts.
  }
  return { cut, lineEnd: nl + 1, openFence: null };
}
