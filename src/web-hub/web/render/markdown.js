/**
 * Whitelisted markdown (plan §包 E): fenced code blocks, inline code,
 * bold/italic, lists, links (http/https only), headings, paragraphs. Anything
 * else stays literal text. `toDom` only uses createElement + text nodes, so raw
 * HTML in the source (`<script>`) always ends up as inert text.
 */
import { el } from "./dom.js";

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

/**
 * @param {MdNode[]} nodes
 * @param {Document} doc
 * @returns {DocumentFragment}
 */
export function toDom(nodes, doc) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) frag.appendChild(blockDom(n, doc));
  return frag;
}

/** @param {MdNode} n @param {Document} doc @returns {Node} */
function blockDom(n, doc) {
  switch (n.type) {
    case "code_block": {
      const code = el(doc, "code", n.lang ? { class: `lang-${n.lang.replace(/[^A-Za-z0-9_+-]/g, "")}` } : null);
      code.textContent = n.text;
      return el(doc, "pre", { class: "md-pre" }, [code]);
    }
    case "heading":
      return el(doc, `h${Math.min(6, Math.max(3, n.level + 2))}`, { class: "md-h" }, inlineDom(n.children, doc));
    case "list":
      return el(
        doc,
        n.ordered ? "ol" : "ul",
        { class: "md-list" },
        n.items.map((item) => el(doc, "li", null, inlineDom(item, doc))),
      );
    default:
      return el(doc, "p", { class: "md-p" }, inlineDom(n.children, doc));
  }
}

/** @param {Inline[]} nodes @param {Document} doc @returns {Node[]} */
function inlineDom(nodes, doc) {
  return nodes.map((n) => {
    switch (n.type) {
      case "code": {
        const code = el(doc, "code", { class: "md-code" });
        code.textContent = n.text;
        return code;
      }
      case "strong":
        return el(doc, "strong", null, inlineDom(n.children, doc));
      case "em":
        return el(doc, "em", null, inlineDom(n.children, doc));
      case "link":
        return el(
          doc,
          "a",
          { href: n.href, rel: "noopener noreferrer nofollow", target: "_blank" },
          inlineDom(n.children, doc),
        );
      default:
        return doc.createTextNode(n.text);
    }
  });
}

/** Convenience: markdown string → fragment. @param {unknown} text @param {Document} doc */
export function renderMarkdown(text, doc) {
  return toDom(parseMarkdown(text), doc);
}
