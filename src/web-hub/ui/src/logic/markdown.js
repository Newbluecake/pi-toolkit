/**
 * Whitelisted markdown parser (vue-plan.md v2.1 §3.1/§3.10, §5.2 — P5b cleanup): fenced code
 * blocks, inline code, bold/italic, lists, links (http/https only), headings, paragraphs.
 * Anything else stays literal text.
 *
 * DOM rendering used to live here too (`toDom`/`renderMarkdown`, built on the legacy
 * `render/dom.js`'s `el()`); the Vue UI renders the same `MdNode[]` output with
 * `MarkdownView.vue`/`MdBlock.vue`/`MdInline.vue` (§3.10) instead, so those two functions —
 * and this file's only reason to depend on `dom.js` — are deleted here (P5b, §3.1's
 * disposition table: "保留 isSafeHref/parseMarkdown；toDom/renderMarkdown P5b 删").
 */

/**
 * @typedef {{ type: "text", text: string } | { type: "code", text: string }
 *   | { type: "strong", children: Inline[] } | { type: "em", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }} Inline
 * @typedef {{ type: "code_block", lang: string, text: string }
 *   | { type: "paragraph", children: Inline[] }
 *   | { type: "heading", level: number, children: Inline[] }
 *   | { type: "list", ordered: boolean, items: Inline[][] }} MdNode
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^\s{0,8}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const LINK_RE = /^\[([^\[\]\n]{0,1000})\]\(\s*([^()\s]{1,2048})(?:\s+"[^"\n]{0,200}")?\s*\)/;
const SAFE_HREF_RE = /^https?:\/\/[^\s]+$/i;
const MAX_DEPTH = 6;

/** @param {string} href */
export function isSafeHref(href) {
  return SAFE_HREF_RE.test(href);
}

/**
 * @param {unknown} text
 * @returns {MdNode[]}
 */
export function parseMarkdown(text) {
  const src = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  const lines = src.split("\n");
  /** @type {MdNode[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ ordered: boolean, items: string[] } | null} */
  let list = null;

  const flushPara = () => {
    if (para.length > 0) out.push({ type: "paragraph", children: parseInline(para.join("\n"), 0) });
    para = [];
  };
  const flushList = () => {
    if (list) out.push({ type: "list", ordered: list.ordered, items: list.items.map((t) => parseInline(t, 0)) });
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
      /** @type {string[]} */
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = /** @type {string} */ (lines[j]);
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && close[1]?.[0] === marker[0] && (close[1]?.length ?? 0) >= marker.length) break;
        body.push(l);
      }
      out.push({ type: "code_block", lang, text: body.join("\n") }); // unclosed ⇒ runs to the end
      i = j;
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
      out.push({ type: "heading", level: heading[1]?.length ?? 1, children: parseInline(heading[2] ?? "", 0) });
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1] ?? "");
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[2] ?? "");
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
 * @param {string} src
 * @param {number} depth
 * @returns {Inline[]}
 */
function parseInline(src, depth) {
  /** @type {Inline[]} */
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = /** @type {string} */ (src[i]);
    if (c === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!~]/.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = src.indexOf(fence, i + n);
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
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const dbl = src[i + 1] === c;
      const mark = dbl ? c + c : c;
      const prev = i > 0 ? (src[i - 1] ?? "") : "";
      const intraword = c === "_" && /[A-Za-z0-9]/.test(prev);
      const next = src[i + mark.length] ?? "";
      if (!intraword && next !== "" && !/\s/.test(next)) {
        const end = findClose(src, i + mark.length, mark);
        if (end > i + mark.length) {
          flush();
          const children = parseInline(src.slice(i + mark.length, end), depth + 1);
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
          out.push({ type: "link", href, children: parseInline(m[1] ?? "", depth + 1) });
        } else {
          out.push({ type: "text", text: m[0] }); // javascript:/data:/relative ⇒ literal text
        }
        i += m[0].length;
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
 * @param {string} src @param {number} from @param {string} mark
 */
function findClose(src, from, mark) {
  let at = src.indexOf(mark, from);
  while (at !== -1) {
    const before = src[at - 1] ?? "";
    const after = src[at + mark.length] ?? "";
    const glued = mark.length === 1 && after === mark;
    const intraword = mark[0] === "_" && /[A-Za-z0-9]/.test(after);
    if (at > from && !/\s/.test(before) && !glued && !intraword) return at;
    at = src.indexOf(mark, at + (glued ? 2 : 1));
  }
  return -1;
}
