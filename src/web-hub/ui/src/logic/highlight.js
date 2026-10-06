/**
 * web-hub syntax highlighting — pure UI logic (2026-10, 用户拍板引入 Prism + 调高 JS 预算).
 * No DOM, no I/O, and — critically — NO prismjs import: this module stays in the main bundle
 * while the Prism engine + language packs ride a lazily-imported chunk
 * (`components/shared/highlight-impl.ts`, loaded by `HighlightedCode.vue` only). Everything
 * here runs unchanged under vitest (node) and in the browser, same discipline as
 * `./preview.js`.
 *
 * - `resolveFenceLang(name)` — markdown fence info-string (```js …) → Prism grammar id, or
 *   `null` for unknown languages (⇒ plain text, DOM identical to pre-highlight).
 * - `resolveFileLang(basename)` — preview overlay: file extension / special filename →
 *   Prism grammar id, or `null`.
 * - `shouldHighlight(text)` — the large-text degradation gate: past
 *   `HIGHLIGHT_MAX_BYTES` (UTF-8 BYTES, matching the preview body's wire size) /
 *   `HIGHLIGHT_MAX_LINES` tokenizing is skipped outright so the main thread never
 *   stalls on a 256 KiB preview body.
 * - `flattenTokens(tree)` — a Prism token tree (strings + `{ type, content }` Token-shaped
 *   objects, structurally typed — never imported) → a flat `[{ cls, text }]` list with the
 *   enclosing token types as space-joined `tok-*` classes and adjacent same-class runs
 *   merged. The renderer (`HighlightedCode.vue`) turns each part into a text node or a
 *   `<span class="tok-…">` VNode — NEVER v-html/innerHTML, so previewed file content can
 *   carry `<script>` verbatim and still render as inert text. Returns `null` past
 *   `HIGHLIGHT_MAX_TOKENS` (pathological grammars ⇒ plain text).
 */

/** Skip highlighting entirely above 100 KiB (user-ruled threshold). */
export const HIGHLIGHT_MAX_BYTES = 100 * 1024;
/** … or above 3000 lines (minified one-liners dodge the byte cap, so both gates exist). */
export const HIGHLIGHT_MAX_LINES = 3000;
/** Flat-parts cap — a grammar exploding into millions of tokens degrades to plain text. */
export const HIGHLIGHT_MAX_TOKENS = 20000;
/** Streaming CodeBlock re-tokenize debounce (ms) — the latest text renders plain until it settles. */
export const HIGHLIGHT_DEBOUNCE_MS = 150;

/**
 * Prism grammar id → dynamic-import order is owned by `highlight-impl.ts`; the ids below are
 * the SUBSET of that pack reachable from a fence name or a filename. `markup` covers
 * html/xml/svg/vue (user ruling: vue 按 markup), `bash` covers sh/zsh.
 */
const FENCE_ALIAS = new Map(
  Object.entries({
    ts: "typescript",
    typescript: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    javascript: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    node: "javascript",
    tsx: "tsx",
    jsx: "jsx",
    json: "json",
    jsonc: "json",
    py: "python",
    python: "python",
    go: "go",
    golang: "go",
    rs: "rust",
    rust: "rust",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    shell: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    markdown: "markdown",
    css: "css",
    scss: "scss",
    html: "markup",
    htm: "markup",
    xml: "markup",
    svg: "markup",
    vue: "markup",
    markup: "markup",
    sql: "sql",
    diff: "diff",
    patch: "diff",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    "c++": "cpp",
    cxx: "cpp",
    cc: "cpp",
    hpp: "cpp",
    docker: "docker",
    dockerfile: "docker",
    ini: "ini",
  }),
);

/** Special full filenames with no usable extension. */
const SPECIAL_FILENAME = new Map(
  Object.entries({
    dockerfile: "docker",
    "dockerfile.dev": "docker",
    "dockerfile.prod": "docker",
    ".dockerignore": "docker",
    ".gitignore": "ini",
    ".gitattributes": "ini",
    ".editorconfig": "ini",
    ".npmrc": "ini",
    ".env": "ini",
  }),
);

/** Extension (lowercased, no dot) → grammar id for the preview overlay. */
const EXT_LANG = new Map(
  Object.entries({
    conf: "ini",
    cfg: "ini",
    properties: "ini",
    less: "css",
    vue: "markup",
    svelte: "markup",
    zsh: "bash",
    bash: "bash",
    env: "ini",
    lock: "json",
    ipynb: "json",
  }),
);

/**
 * @param {unknown} name fence info string (may carry attributes, e.g. "js {1}")
 * @returns {string | null} Prism grammar id or null (unknown ⇒ plain text)
 */
export function resolveFenceLang(name) {
  if (typeof name !== "string") return null;
  const head =
    name
      .trim()
      .toLowerCase()
      .split(/[\s{,(]/, 1)[0] ?? "";
  if (head === "") return null;
  return FENCE_ALIAS.get(head) ?? null;
}

/**
 * @param {unknown} basename file name (NOT a full path — the caller slices at the last "/")
 * @returns {string | null} Prism grammar id or null
 */
export function resolveFileLang(basename) {
  if (typeof basename !== "string" || basename === "") return null;
  const lower = basename.toLowerCase();
  const special = SPECIAL_FILENAME.get(lower);
  if (special !== undefined) return special;
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return null;
  const ext = lower.slice(dot + 1);
  const fence = FENCE_ALIAS.get(ext);
  if (fence !== undefined) return fence;
  return EXT_LANG.get(ext) ?? null;
}

/**
 * Large-text degradation gate. The byte cap counts UTF-8 BYTES (the preview body's actual
 * size on the wire), not UTF-16 code units — a Chinese/emoji-heavy file is ~3-4 bytes per
 * `text.length` unit, so `text.length` alone would let a ~400 KiB multibyte file through.
 * Counting walks code points (a lone surrogate costs 3 bytes, exactly what TextEncoder's
 * U+FFFD substitution produces) — no `TextEncoder().encode()` allocation on a huge string.
 * Cheap short-circuits first: `text.length > cap` is already conclusive (UTF-8 bytes ≥
 * UTF-16 units), and the line cap rides the same single pass.
 * @param {string} text
 * @returns {boolean} true when tokenizing is allowed
 */
export function shouldHighlight(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.length > HIGHLIGHT_MAX_BYTES) return false; // UTF-8 bytes ≥ UTF-16 code units
  let lines = 1;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      lines++;
      if (lines > HIGHLIGHT_MAX_LINES) return false;
    }
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4; // surrogate pair = one astral code point = 4 UTF-8 bytes
      i++;
    } else bytes += 3; // BMP char, or a lone surrogate (TextEncoder substitutes U+FFFD = 3 bytes)
    if (bytes > HIGHLIGHT_MAX_BYTES) return false;
  }
  return true;
}

const SAFE_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * @typedef {{ type?: unknown, content?: unknown }} PrismTokenLike
 * @typedef {{ cls: string, text: string }} FlatTokenPart
 */

/**
 * Flatten a Prism token tree (`Prism.tokenize`'s return value, structurally typed) into
 * render-ready parts. Strings pass through unclassed; each Token contributes its (sanitized)
 * type as a `tok-<type>` class, nested types stack outermost-first. Adjacent parts with the
 * same class merge so the renderer creates the fewest VNodes.
 * @param {unknown} tree `(string | Token)[]` as returned by `Prism.tokenize`
 * @returns {FlatTokenPart[] | null} null when the tree is unusable or exceeds HIGHLIGHT_MAX_TOKENS
 */
export function flattenTokens(tree) {
  if (!Array.isArray(tree)) return null;
  /** @type {FlatTokenPart[]} */
  const out = [];
  let budget = HIGHLIGHT_MAX_TOKENS;
  /**
   * @param {unknown} node
   * @param {string} cls accumulated `tok-*` class string ("" at the root)
   * @returns {boolean} false when the token budget ran out
   */
  const walk = (node, cls) => {
    if (typeof node === "string") {
      if (node === "") return true;
      budget--;
      const last = out[out.length - 1];
      if (last !== undefined && last.cls === cls) last.text += node;
      else out.push({ cls, text: node });
      return budget >= 0;
    }
    if (node === null || typeof node !== "object") return true;
    const token = /** @type {PrismTokenLike} */ (node);
    const type = typeof token.type === "string" && SAFE_TYPE_RE.test(token.type) ? token.type.toLowerCase() : "";
    const inner = type === "" ? cls : cls === "" ? `tok-${type}` : `${cls} tok-${type}`;
    const content = token.content;
    if (typeof content === "string") return walk(content, inner);
    if (Array.isArray(content)) {
      for (const child of content) {
        if (!walk(child, inner)) return false;
      }
      return true;
    }
    return walk(content, inner); // unknown node shape: recurse defensively (walk() no-ops on non-token objects)
  };
  for (const node of tree) {
    if (!walk(node, "")) return null;
  }
  return out;
}
