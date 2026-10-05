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
 */

/**
 * @typedef {"" | "left" | "center" | "right"} TableAlign
 * @typedef {{ type: "text", text: string } | { type: "code", text: string }
 *   | { type: "strong", children: Inline[] } | { type: "em", children: Inline[] }
 *   | { type: "del", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }} Inline
 * @typedef {{ type: "code_block", lang: string, text: string }
 *   | { type: "paragraph", children: Inline[] }
 *   | { type: "heading", level: number, children: Inline[] }
 *   | { type: "list", ordered: boolean, items: Inline[][], checked?: (boolean | null)[] }
 *   | { type: "quote", children: MdNode[] }
 *   | { type: "table", align: TableAlign[], header: Inline[][], rows: Inline[][][] }} MdNode
 *
 * `list.checked` is present only when at least one item carried a task marker; it is parallel
 * to `items` (`null` = plain item, `true`/`false` = task item, checked or not).
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^\s{0,8}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const DELIM_CELL_RE = /^:?-+:?$/;
const LINK_RE = /^\[([^\[\]\n]{0,1000})\]\(\s*([^()\s]{1,2048})(?:\s+"[^"\n]{0,200}")?\s*\)/;
const SAFE_HREF_RE = /^https?:\/\/[^\s]+$/i;
const MAX_DEPTH = 6;
const MAX_QUOTE_DEPTH = 10;

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
  return parseBlocks(src.split("\n"), 0);
}

/**
 * Block-level pass over one quote nesting level. Single forward scan, O(total chars) per
 * level — every construct below is recognized by per-line anchored regexes or bounded char
 * scans, so streaming re-parses stay cheap.
 * @param {string[]} lines @param {number} qdepth
 * @returns {MdNode[]}
 */
function parseBlocks(lines, qdepth) {
  /** @type {MdNode[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ ordered: boolean, items: string[], checked: (boolean | null)[] } | null} */
  let list = null;

  const flushPara = () => {
    if (para.length > 0) out.push({ type: "paragraph", children: parseInline(para.join("\n"), 0) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      /** @type {MdNode} */
      const node = { type: "list", ordered: list.ordered, items: list.items.map((t) => parseInline(t, 0)) };
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
    if (qdepth < MAX_QUOTE_DEPTH && QUOTE_RE.test(line)) {
      flushPara();
      flushList();
      i = collectQuote(lines, i, out, qdepth);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length) {
      const table = tryParseTable(lines, i);
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
 * @returns {number} index of the last consumed line
 */
function collectQuote(lines, start, out, qdepth) {
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
  out.push({ type: "quote", children: parseBlocks(inner, qdepth + 1) });
  return j - 1;
}

/**
 * GFM pipe table starting at `lines[start]`: header row (must contain a pipe) + delimiter row
 * (`:?-+:?` cells, count must equal the header's) + data rows. A malformed delimiter or a
 * header/delimiter column mismatch is NOT a table — the caller falls through and both lines
 * degrade to ordinary paragraph text. Ragged data rows follow GFM: extra cells are truncated,
 * missing cells padded empty. A data row without any pipe (or a blank line) ends the table.
 * @param {string[]} lines @param {number} start
 * @returns {{ node: MdNode, end: number } | null}
 */
function tryParseTable(lines, start) {
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
  const header = headCells.map((c) => parseInline(c.trim(), 0));
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
    rows.push(norm.map((c) => parseInline(c.trim(), 0)));
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
    if (c === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!~|]/.test(src[i + 1] ?? "")) {
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
    if (c === "~" && src[i + 1] === "~" && depth < MAX_DEPTH) {
      const next = src[i + 2] ?? "";
      if (next !== "" && !/\s/.test(next)) {
        const end = findClose(src, i + 2, "~~");
        if (end > i + 2) {
          flush();
          out.push({ type: "del", children: parseInline(src.slice(i + 2, end), depth + 1) });
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
