/**
 * Pure mermaid logic (web-hub-mermaid plan r2 + r3 rulings, `docs/dev/web-hub-mermaid/plan.md`):
 * fence detection, limits, the G1 lexical pre-check, the site configuration, the author-config and
 * diagram-DB checks (G2, executed by `components/shared/mermaid-impl.ts` before any DOM insertion),
 * the restricted `svgToImage` (§5 + G5), error classification, and the byte-budget LRU.
 *
 * No DOM, no mermaid import: everything here is unit-testable in plain node. Never import mermaid
 * from this file — the engine is lazy-loaded exclusively through `mermaid-impl.ts`.
 */

/* ---------------------------------------------------------------------------------- constants */

export const MAX_TEXT_CHARS = 20_000;
export const MAX_LINES = 2_000;
export const MAX_LINES_COARSE = 800;
export const MAX_FLOW_EDGES = 500;
export const MAX_FLOW_EDGES_COARSE = 200;
/** R2-4: flowchart vertex ceiling (a "common case" protection, not a hard CPU bound). */
export const MAX_FLOW_VERTICES = 1_000;
export const MAX_FLOW_VERTICES_COARSE = 400;
export const MAX_SVG_UTF8_BYTES = 2 * 1024 * 1024;
/** Encoded data-URL length ceiling in UTF-16 code units (4 Mi). */
export const MAX_SRC_CHARS = 4 * 1024 * 1024;
export const MAX_SIDE_PX = 16_384;
export const MAX_AREA_PX = 25_000_000;
export const CACHE_MAX_ENTRIES = 48;
/** Σ(key.length + payload.length) ≤ 16 Mi code units — a string-retention budget, NOT image memory. */
export const CACHE_MAX_UNITS = 16 * 1024 * 1024;

/** First-version diagram-type allow-list (21 families; r3 R2-6 removed `architecture`). */
export const MERMAID_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "flowchart-v2",
  "flowchart",
  "flowchart-elk",
  "sequence",
  "classDiagram",
  "class",
  "stateDiagram",
  "state",
  "er",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "journey",
  "timeline",
  "quadrantChart",
  "xychart",
  "sankey",
  "block",
  "kanban",
  "packet",
  "radar",
  "treemap",
  "c4",
  "requirement",
]);

/** R2-3: the only `layout` values an author may select. Checked, never injected into the config. */
export const MERMAID_ALLOWED_LAYOUTS: ReadonlySet<string> = new Set(["elk", "dagre"]);
/** mindmap's own `layoutAlgorithm` key: mermaid's default (cose-bilkent) plus the two allowed layouts. */
export const MERMAID_ALLOWED_LAYOUT_ALGORITHMS: ReadonlySet<string> = new Set(["cose-bilkent", "elk", "dagre"]);

/**
 * R2-4 (pinned against mermaid 12.2.0's `config.type.d.ts`): layout-computation parameters an author
 * may never override — iteration / separation / elasticity knobs of fcose (`architecture`), ELK's
 * `layeringLayerBound`. Any occurrence at any depth is a rejection. Re-audit on every mermaid bump.
 */
export const MERMAID_LAYOUT_PARAM_KEYS: ReadonlySet<string> = new Set([
  "numIter",
  "layeringLayerBound",
  "nodeSeparation",
  "idealEdgeLengthMultiplier",
  "edgeElasticity",
]);
/** Size-class keys: a number within [0, MAX_SPACING] only (they scale the layout area). */
export const MERMAID_SPACING_KEYS: ReadonlySet<string> = new Set(["nodeSpacing", "rankSpacing"]);
const MAX_SPACING = 200;

/** `secure` REPLACES mermaid's default list, so the six defaults must be written out. */
export const MERMAID_SECURE_KEYS: readonly string[] = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "themeCSS",
  "dompurifyConfig",
  "fontFamily",
  "fontSize",
];

const FENCE_TOKEN_RE = /^\s*([^\s{]+)/;

/** A markdown code-fence info string denotes a mermaid block iff its first token is `mermaid`. */
export function isMermaidFence(lang: string | null | undefined): boolean {
  if (typeof lang !== "string") return false;
  const m = FENCE_TOKEN_RE.exec(lang);
  return m !== null && m[1]!.toLowerCase() === "mermaid";
}

/* ---------------------------------------------------------------------------------- outcomes */

export type MermaidTheme = "light" | "dark";
export type MermaidErrorReason =
  | "parse"
  | "render"
  | "too-large"
  | "unsupported"
  | "timeout"
  | "busy"
  | "load-failed"
  | "engine-unavailable"
  | "output-invalid";

export type MermaidRejection = { reason: "unsupported" | "too-large" | "parse"; detail: string };

/** Error thrown by the engine side for author-config rejections that must classify as `parse` (R2-3). */
export class MermaidAuthorConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "MermaidAuthorConfigError";
  }
}

/* ------------------------------------------------------------------------ G1 lexical pre-check */

const CSS_RESOURCE_FN_RE = /(?<![\w-])(?:-webkit-)?(?:url|image-set|cross-fade)(?:\(|\ufffd)/;
const MAX_NORMALIZE_ROUNDS = 3;

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(cp);
}

function decodeCssEscapes(s: string): string {
  return s
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/\\\n/g, "")
    .replace(/\\([^\n])/g, "$1");
}

function decodeJsEscapes(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]{1,8})\}/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)));
}

/** HTML (`&#N;`/`&#xN;`) + mermaid (`#N;`/`#xN;`) numeric entities; named entities become a wildcard. */
function decodeEntities(s: string): string {
  return (
    s
      .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]{1,7});?/g, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)))
      .replace(/#x([0-9a-fA-F]{1,6});/g, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
      .replace(/#([0-9]{1,7});/g, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)))
      // the few named entities that are plain punctuation decode to themselves (`url(&quot;#g&quot;)`) …
      .replace(/&(quot|apos|lt|gt);/g, (_m, n: string) => ({ quot: '"', apos: "'", lt: "<", gt: ">" })[n] ?? "")
      // … every other named entity could stand for anything: wildcard.
      .replace(/[&#][A-Za-z][A-Za-z0-9]*;/g, "\ufffd")
  );
}

function normalizeStep(s: string, escapes: (x: string) => string): string {
  return escapes(s)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\*[\s\S]*$/, "");
}

/**
 * G1 core: does `text` — after the two escape-decoding paths (CSS and JS/YAML), entity decoding and
 * comment stripping, iterated up to three rounds — contain a CSS resource function? This is an
 * OVER-approximation of what a CSS parser would see (a label literally spelling `url(` is refused too).
 */
export function hasCssResourceFunction(text: string): boolean {
  for (const escapes of [decodeCssEscapes, decodeJsEscapes]) {
    let cur = text;
    for (let round = 0; round <= MAX_NORMALIZE_ROUNDS; round++) {
      const flat = cur.toLowerCase();
      if (CSS_RESOURCE_FN_RE.test(flat)) return true;
      const next = decodeEntities(normalizeStep(cur, escapes));
      if (next === cur) break;
      cur = next;
    }
  }
  return false;
}

export type PrecheckResult =
  { ok: true } | { ok: false; reason: "too-large" | "unsupported" | "parse"; message: string };

export interface PrecheckOptions {
  /** `matchMedia("(pointer: coarse)")`, fixed per page. */
  coarse: boolean;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function precheckMermaid(text: string, opts: PrecheckOptions = { coarse: false }): PrecheckResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "parse", message: "Empty diagram." };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, reason: "too-large", message: `Diagram text exceeds ${MAX_TEXT_CHARS} characters.` };
  }
  const maxLines = opts.coarse ? MAX_LINES_COARSE : MAX_LINES;
  if (countLines(text) > maxLines) {
    return { ok: false, reason: "too-large", message: `Diagram exceeds ${maxLines} lines.` };
  }
  if (hasCssResourceFunction(text)) {
    return { ok: false, reason: "unsupported", message: "Resource references (url(), image-set()) are not supported." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------- site configuration */

export function mermaidConfig(theme: MermaidTheme, fontFamily: string): Record<string, unknown> {
  // NOTE: no `layout` key — r3: a global `layout:"elk"` crashes mindmap (12.2.0); ELK is already the
  // default and the author-selected layout is only checked against MERMAID_ALLOWED_LAYOUTS.
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily,
    fontSize: 16,
    maxTextSize: MAX_TEXT_CHARS,
    maxEdges: MAX_FLOW_EDGES,
    suppressErrorRendering: true,
    dompurifyConfig: {
      ALLOWED_TAGS: [
        "b",
        "strong",
        "i",
        "em",
        "u",
        "s",
        "del",
        "sub",
        "sup",
        "small",
        "mark",
        "code",
        "br",
        "span",
        "p",
        "div",
      ],
      ALLOWED_ATTR: ["class"],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ["style"],
    },
    secure: [...MERMAID_SECURE_KEYS],
    themeVariables: { fontFamily },
  };
}

/** `getComputedStyle(...).getPropertyValue("--font-sans")` → single-spaced, or a safe fallback. */
export function normalizeFontFamily(raw: string | null | undefined): string {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  return v.length > 0 ? v : "sans-serif";
}

/* -------------------------------------------------------------- G2: author configuration check */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FONT_WEIGHTS = new Set(["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]);
const MAX_CONFIG_DEPTH = 12;
const MAX_CONFIG_NODES = 5_000;

function fontSizeOk(value: unknown): boolean {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^\d+(px)?$/.test(value)) n = parseInt(value, 10);
  else return false;
  return Number.isFinite(n) && n >= 8 && n <= 40;
}

/**
 * Plan §2.2 + r3 R2-3/R2-4, applied to the DECODED config `mermaid.parse()` returns (so escape
 * spellings cannot hide anything). Returns `null` when acceptable, otherwise the rejection. `detail`
 * strings are fixed phrases — never author text.
 */
export function checkAuthorConfig(config: unknown): MermaidRejection | null {
  let nodes = 0;
  const reject = (reason: MermaidRejection["reason"], detail: string): MermaidRejection => ({ reason, detail });

  const walk = (value: unknown, depth: number, insideElk: boolean): MermaidRejection | null => {
    if (++nodes > MAX_CONFIG_NODES) return reject("unsupported", "Diagram configuration is too large.");
    if (depth > MAX_CONFIG_DEPTH) return reject("unsupported", "Diagram configuration is nested too deeply.");
    if (typeof value === "string") {
      if (value.includes("\\")) return reject("unsupported", "Configuration contains an escape sequence.");
      if (hasCssResourceFunction(value)) return reject("unsupported", "Configuration contains a resource reference.");
      return null;
    }
    if (typeof value === "number") {
      return insideElk ? reject("unsupported", "ELK layout parameters cannot be overridden.") : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const r = walk(item, depth + 1, insideElk);
        if (r) return r;
      }
      return null;
    }
    if (value === null || typeof value !== "object") return null;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) return reject("unsupported", "Configuration contains a reserved key.");
      if (key !== "fontFamily" && /fontfamily/i.test(key)) {
        return reject("unsupported", "Font-family overrides are not supported.");
      }
      if (key !== "fontSize" && /fontsize$/i.test(key) && !fontSizeOk(v)) {
        return reject("unsupported", "Font-size override is out of range.");
      }
      if (/fontweight$/i.test(key) && !FONT_WEIGHTS.has(String(v))) {
        return reject("unsupported", "Font-weight override is not supported.");
      }
      if (key === "layout") {
        if (typeof v !== "string" || !MERMAID_ALLOWED_LAYOUTS.has(v)) {
          return reject("parse", "Layout is not supported (only elk and dagre).");
        }
      }
      if (key === "layoutAlgorithm") {
        if (typeof v !== "string" || !MERMAID_ALLOWED_LAYOUT_ALGORITHMS.has(v)) {
          return reject("parse", "Layout algorithm is not supported.");
        }
      }
      if (MERMAID_LAYOUT_PARAM_KEYS.has(key)) {
        return reject("unsupported", "Layout computation parameters cannot be overridden.");
      }
      if (MERMAID_SPACING_KEYS.has(key)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_SPACING) {
          return reject("unsupported", "Layout spacing is out of range.");
        }
      }
      const r = walk(v, depth + 1, insideElk || key === "elk");
      if (r) return r;
    }
    return null;
  };

  return walk(config, 0, false);
}

/* --------------------------------------------------------------- G2: per-diagram database check */

export interface DiagramDbCheckOptions {
  coarse: boolean;
  /** The raw diagram text (sequence `details` is a lexical check). */
  text: string;
}

const FLOW_TYPES = new Set(["flowchart-v2", "flowchart", "flowchart-elk"]);
const SEQ_DETAILS_RE = /(?:^|[;\n])[ \t]*details[ \t]+[^/\\+()<>:\n,;\s-]/i;

function mapValues(m: unknown): unknown[] | null {
  if (m instanceof Map) return [...m.values()];
  if (m !== null && typeof m === "object") return Object.values(m as Record<string, unknown>);
  return null;
}

function hasOwn(o: unknown, key: string): boolean {
  return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, key);
}

/** R2-5: sequence `details` reads arbitrary main-document nodes at parse time — refuse it lexically. */
export function hasSequenceDetails(text: string): boolean {
  return SEQ_DETAILS_RE.test(text);
}

/**
 * Fail-closed DB audit run on the pre-parsed diagram, BEFORE `render` (and therefore before any DOM
 * insertion or request): flowchart `@{img}` / limits, sequence actor icon (+ the `details` directive
 * as a second line of defence). Unknown DB shapes for those two families reject.
 */
export function checkDiagramDb(type: string, db: unknown, opts: DiagramDbCheckOptions): MermaidRejection | null {
  const reject = (reason: MermaidRejection["reason"], detail: string): MermaidRejection => ({ reason, detail });
  if (FLOW_TYPES.has(type)) {
    const d = db as { getVertices?: () => unknown; getEdges?: () => unknown } | null;
    if (!d || typeof d.getVertices !== "function" || typeof d.getEdges !== "function") {
      return reject("unsupported", "Unexpected flowchart structure.");
    }
    const vertices = mapValues(d.getVertices());
    const edges = d.getEdges();
    if (vertices === null || !Array.isArray(edges)) return reject("unsupported", "Unexpected flowchart structure.");
    const maxV = opts.coarse ? MAX_FLOW_VERTICES_COARSE : MAX_FLOW_VERTICES;
    const maxE = opts.coarse ? MAX_FLOW_EDGES_COARSE : MAX_FLOW_EDGES;
    if (vertices.length > maxV) return reject("too-large", `Flowchart has more than ${maxV} nodes.`);
    if (edges.length > maxE) return reject("too-large", `Flowchart has more than ${maxE} edges.`);
    for (const v of vertices) {
      if (hasOwn(v, "img") && (v as { img?: unknown }).img) {
        return reject("unsupported", "Node images are not supported (resource reference).");
      }
    }
    return null;
  }
  if (type === "sequence") {
    if (hasSequenceDetails(opts.text)) {
      return reject("unsupported", "The sequence `details` directive is not supported.");
    }
    const d = db as { getActors?: () => unknown } | null;
    if (!d || typeof d.getActors !== "function") return reject("unsupported", "Unexpected sequence structure.");
    const actors = mapValues(d.getActors());
    if (actors === null) return reject("unsupported", "Unexpected sequence structure.");
    for (const a of actors) {
      const props = a !== null && typeof a === "object" ? (a as { properties?: unknown }).properties : undefined;
      if (props !== null && typeof props === "object" && hasOwn(props, "icon")) {
        return reject("unsupported", "Actor icons are not supported (resource reference).");
      }
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------------------ svgToImage */

export interface SvgImage {
  src: string;
  width: number;
  height: number;
  diagramType: string;
  title: string | null;
}

const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const ATTR_NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;
const MAX_ROOT_TAG = 4096;
const MAX_ROOT_ATTRS = 64;
const FORBIDDEN_OUTPUT_RE = /<(?:image|img|script|iframe|object|embed|video|audio|animate[\w-]*|set)(?![\w-])/i;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** Parse the root tag (`svg` string starting at `<svg`): attributes + index of the closing `>`. */
function parseRootTag(svg: string): { attrs: Array<[string, string]>; end: number } | null {
  if (!svg.startsWith("<svg") || svg.length < 5 || !isSpace(svg.charAt(4))) return null;
  const limit = Math.min(svg.length, MAX_ROOT_TAG + 1);
  const attrs: Array<[string, string]> = [];
  const seen = new Set<string>();
  let i = 4;
  for (;;) {
    let sawSpace = false;
    while (i < limit && isSpace(svg.charAt(i))) {
      i++;
      sawSpace = true;
    }
    if (i >= limit) return null;
    if (svg.charAt(i) === ">") {
      if (i > MAX_ROOT_TAG) return null;
      return { attrs, end: i };
    }
    if (!sawSpace) return null; // attributes must be whitespace-separated (also rejects `/>`)
    const nameStart = i;
    while (i < limit && !isSpace(svg.charAt(i)) && svg.charAt(i) !== "=" && svg.charAt(i) !== ">") i++;
    const name = svg.slice(nameStart, i);
    if (!ATTR_NAME_RE.test(name)) return null;
    while (i < limit && isSpace(svg.charAt(i))) i++;
    if (svg.charAt(i) !== "=") return null; // bare attribute
    i++;
    while (i < limit && isSpace(svg.charAt(i))) i++;
    const quote = svg.charAt(i);
    if (quote !== '"' && quote !== "'") return null;
    i++;
    const valStart = i;
    while (i < limit && svg.charAt(i) !== quote) {
      if (svg.charAt(i) === "<") return null;
      i++;
    }
    if (i >= limit) return null;
    const value = svg.slice(valStart, i);
    i++; // closing quote
    if (seen.has(name) || attrs.length >= MAX_ROOT_ATTRS) return null;
    seen.add(name);
    attrs.push([name, value]);
  }
}

function decodeTitleEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});/g, (m) => {
    switch (m) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&amp;":
        return "&";
      case "&quot;":
        return '"';
      default: {
        const cp = m.charAt(2) === "x" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
        return safeFromCodePoint(cp);
      }
    }
  });
}

/** G5: output scan. True when the SVG carries anything that must never reach an `<img>`. */
export function svgOutputBreaches(svg: string): boolean {
  if (FORBIDDEN_OUTPUT_RE.test(svg)) return true;
  // Normalize escape/entity spellings before looking at `url(` (attribute values decode entities).
  for (const escapes of [decodeCssEscapes, decodeJsEscapes]) {
    const flat = decodeEntities(normalizeStep(svg, escapes)).toLowerCase();
    if (/(?<![\w-])(?:-webkit-)?(?:image-set|cross-fade)(?:\(|\ufffd)/.test(flat)) return true;
    if (/(?<![\w-])url\ufffd/.test(flat)) return true;
    for (const m of flat.matchAll(/(?<![\w-])url\(\s*(['"]?)\s*(.?)/g)) {
      if (m[2] !== "#") return true;
    }
  }
  return false;
}

/**
 * Plan §5: restricted root-tag parse, viewBox-derived px size, dedup'd rewrite, metadata, G5 scan and
 * UTF-8 budgets. `null` ⇒ `output-invalid`. `onBreach` fires when the failure was a G5 hit — i.e.
 * G1–G4 let something through.
 */
export function svgToImage(svg: string, onBreach?: () => void): SvgImage | null {
  if (typeof svg !== "string" || svg.length === 0) return null;
  // Cheap guard before encoding: a code unit is at most 3 UTF-8 bytes.
  if (svg.length > MAX_SVG_UTF8_BYTES) return null;
  if (new TextEncoder().encode(svg).length > MAX_SVG_UTF8_BYTES) return null;
  const root = parseRootTag(svg);
  if (!root) return null;
  const get = (n: string): string | null => root.attrs.find(([k]) => k === n)?.[1] ?? null;
  if (get("xmlns") !== "http://www.w3.org/2000/svg") return null;
  const vb = get("viewBox");
  if (vb === null) return null;
  const parts = vb.trim().split(/[\s,]+/);
  if (parts.length !== 4 || !parts.every((p) => NUM_RE.test(p))) return null;
  const [minX, minY, w, h] = parts.map(Number) as [number, number, number, number];
  if (![minX, minY, w, h].every(Number.isFinite)) return null;
  if (Math.abs(minX) > 1e6 || Math.abs(minY) > 1e6 || !(w > 0 && h > 0)) return null;
  const W = Math.ceil(w);
  const H = Math.ceil(h);
  if (W < 1 || H < 1 || W > MAX_SIDE_PX || H > MAX_SIDE_PX || W * H > MAX_AREA_PX) return null;

  let out = "<svg";
  for (const [k, v] of root.attrs) {
    if (k === "width" || k === "height" || k === "style") continue;
    out += ` ${k}="${v.replace(/"/g, "&quot;")}"`;
  }
  out += ` width="${W}" height="${H}">${svg.slice(root.end + 1)}`;

  if (svgOutputBreaches(out)) {
    onBreach?.();
    return null;
  }

  let diagramType = get("aria-roledescription") ?? "";
  if (!/^[A-Za-z0-9-]{1,32}$/.test(diagramType)) diagramType = "unknown";
  let title: string | null = null;
  const tm = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(out);
  if (tm)
    title = Array.from(decodeTitleEntities(tm[1] ?? ""))
      .slice(0, 200)
      .join("");

  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`;
  if (src.length > MAX_SRC_CHARS) return null;
  return { src, width: W, height: H, diagramType, title };
}

/* ----------------------------------------------------------------------- error classification */

const PARSE_MESSAGE_RE =
  /(?:^|\b)(?:Parse error|Parsing failed|Lexical error|Syntax error|Expecting|UnknownDiagramError|No diagram type detected)/i;

/** Mermaid parse/lexical errors (and unknown diagram types) → `parse`; the KaTeX stub → `unsupported`; mermaid's own edge/text limits → `too-large`. */
export function classifyMermaidError(err: unknown): "parse" | "render" | "unsupported" | "too-large" {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const name = err instanceof Error ? err.name : "";
  if (/KaTeX math is not bundled/.test(message)) return "unsupported";
  if (/Edge limit exceeded|Maximum Text size/i.test(message)) return "too-large";
  if (name === "MermaidAuthorConfigError" || name === "UnknownDiagramError") return "parse";
  if (
    err !== null &&
    typeof err === "object" &&
    "hash" in err &&
    typeof (err as { hash?: unknown }).hash === "object"
  ) {
    return "parse"; // jison parse errors carry a `hash` descriptor
  }
  if (PARSE_MESSAGE_RE.test(message)) return "parse";
  return "render";
}

const FIXED_MESSAGES: Record<MermaidErrorReason, string> = {
  parse: "Diagram syntax error.",
  render: "Diagram rendering failed.",
  "too-large": "Diagram is too large.",
  unsupported: "Diagram is not supported.",
  timeout: "Diagram rendering timed out.",
  busy: "Too many diagrams are rendering.",
  "load-failed": "Diagram engine failed to load.",
  "engine-unavailable": "Diagram engine is unavailable.",
  "output-invalid": "Diagram output was rejected.",
};

export function clampMessage(s: string): string {
  const flat = s.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  return Array.from(flat).slice(0, 160).join("");
}

/** ≤160 chars, single line, never the diagram source. Parse errors keep only the line number. */
export function shortMermaidError(reason: MermaidErrorReason, err?: unknown): string {
  if (reason === "parse" && err instanceof Error) {
    if (err.name === "MermaidAuthorConfigError") return clampMessage(err.message);
    const m = /line (\d{1,6})/i.exec(err.message);
    if (m) return `Diagram syntax error near line ${m[1]}.`;
  }
  if (reason === "unsupported" && err instanceof Error && /KaTeX math is not bundled/.test(err.message)) {
    return "Diagram contains math formulas (not supported).";
  }
  return FIXED_MESSAGES[reason];
}

/* ---------------------------------------------------------------------------------- the cache */

/** LRU bounded by entry count AND a caller-supplied "units" budget (UTF-16 code units retained). */
export class ByteBudgetLru<V> {
  private readonly map = new Map<string, { value: V; units: number }>();
  private total = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxUnits: number,
    readonly maxEntryUnits: number = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get units(): number {
    return this.total;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Returns false (and stores nothing) when the entry alone exceeds the per-entry or total budget. */
  set(key: string, value: V, units: number): boolean {
    const u = Math.max(0, units);
    if (u > this.maxEntryUnits || u > this.maxUnits) return false;
    const old = this.map.get(key);
    if (old) {
      this.total -= old.units;
      this.map.delete(key);
    }
    this.map.set(key, { value, units: u });
    this.total += u;
    while (this.map.size > this.maxEntries || this.total > this.maxUnits) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const e = this.map.get(oldest.value)!;
      this.total -= e.units;
      this.map.delete(oldest.value);
    }
    return true;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
