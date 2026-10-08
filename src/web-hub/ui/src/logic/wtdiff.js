/**
 * web-hub worktree file-diff — pure UI logic (worktree-diff plan v3.1 §3.4/§3.5/§3.7/§4.1,
 * package D2). No DOM, no I/O, no Vue imports: every function here runs unchanged under
 * vitest (node) and in the browser, same discipline as `./preview.js`/`./diff.js`. The DOM
 * half (panel toggle, dialog, row rendering, pagination) is D5's `components/diff/*`.
 *
 * What this computes:
 * - `wtdiffScopeOf(...)` — the §4.1 scope derivation, aligned 1:1 with `previewScopeOf`
 *   (`./preview.js`): a scope exists only when the transport offers `worktreeDiff`, the hub
 *   caps carry `wtdiff.v1`, password (LAN) mode ADDITIONALLY requires `preview.lan.v1` (D6:
 *   LAN availability rides that cap — a loopback-mode hub never declares it, so a LAN
 *   browser correctly gets no scope), and the selected agent has a live session. The result
 *   is `WtDiffScope` (`{ agentKey, sessionId }`, plan §4.6) — no `cwd`: the worktree path is
 *   a `WorktreeRowWire.path` input, never derived from the session.
 * - `rowDiffable(scope, row)` / `rowSig(row)` — the §4.1 row-eligibility formula (scope
 *   non-null ∧ a usable `path` ∧ not bare/prunable ∧ dirty>0 ∨ dirtyCapped ∨ unprobed) and
 *   the §4.5 refresh signature `head|dirty|dirtyCapped|untrackedSkipped` (opaque; only
 *   equality between signatures of the SAME row across samples ever matters).
 * - `buildSplitRows(parsed)` — the §3.4 split alignment, the mockup's algorithm verbatim:
 *   git's unified output is already a minimal edit script, so each del/add RUN between
 *   context lines zip-pairs index-wise (`段内第 j 个删除 ↔ 第 j 个新增`, the VSCode/GitHub
 *   reading); ctx rows re-align both sides every context line, so empty cells never
 *   accumulate across segments. One row = one grid line (four cells lnL|txL|lnR|txR), long
 *   lines wrap and both sides stay equal-height (D10).
 * - `buildUnifiedRows(parsed)` — §3.5: every `PatchLine` becomes one row
 *   `lnOld | lnNew | sign | text` (sign `+` / `−` (U+2212, mockup's glyph) / `""`), hunk
 *   headers span the row, multi-file block headers identical to split.
 * - `clipLine(text, max)` — §3.7's per-line display cap: clipping counts CODE POINTS and
 *   never splits a surrogate pair in half (an astral char straddling the cut is omitted
 *   whole and counted as one), appending the `…(+N)` marker with the omitted count.
 * - `displayPath(path)` — display-layer control-character visualization (§4.2): every C0
 *   control (incl. CR → `␍`, LF → `␊`, TAB → `␉`) becomes its Unicode control-picture glyph,
 *   DEL → `␡`. U+FFFD stays as-is (it is already a visible replacement glyph; requestability
 *   is `isWtRequestableEntry`'s business, never the display's).
 * - `statusBadge(status)` / `formatStat(add, del)` — the §4.2 file-list cell primitives:
 *   badge `{ cls, label }` (cls = the lowercase status letter; the set is imported from the
 *   protocol so it cannot drift from `WTDIFF_STATUSES`) and the mockup's `+a −d` stat with
 *   the typographic minus (U+2212); absent counts render as `""` (binary / untracked /
 *   numstat-missing entries) so the component can drop the empty parts.
 *
 * Runtime imports use the literal `.ts` extension (`@protocol/…`) — the same `.js`-importer
 * constraint `./contract.js` documents: Vite/esbuild only remap `./foo.js` → `./foo.ts` for
 * a `.ts`/`.vue` importer, so a plain `.js` module must spell `.ts` out.
 * `protocol/worktree-diff.ts` is deliberately `node:*`-free (D0) precisely so this module
 * can pull its constants into the browser bundle.
 */
import { PREVIEW_LAN_HUB_CAP, WTDIFF_HUB_CAP } from "@protocol/version.ts";
import { WTDIFF_STATUSES } from "@protocol/worktree-diff.ts";

/**
 * @typedef {import("@protocol/worktree-diff.ts").PatchFileMeta} PatchFileMeta
 * @typedef {import("@protocol/worktree-diff.ts").PatchLine} PatchLine
 * @typedef {import("@protocol/worktree-diff.ts").ParsedPatch} ParsedPatch
 * @typedef {import("@protocol/messages.ts").WorktreeRowWire} WorktreeRowWire
 * @typedef {{ agentKey: string, sessionId: string }} WtDiffScope
 * @typedef {{ mode?: unknown, hubCaps?: unknown, hasTransport?: unknown, agentKey?: unknown,
 *   session?: unknown }} WtdiffScopeInput
 * @typedef {{ cls: string, label: string }} StatusBadge
 * @typedef {{ plus: string, minus: string }} StatParts
 * @typedef {{ text: string, clipped: number }} ClippedLine
 * @typedef {{ t: "file", meta: PatchFileMeta }} SplitRowFile
 * @typedef {{ t: "hunk", text: string }} RowHunk
 * @typedef {{ t: "ctx", o: number, n: number, text: string, noEol?: true }} SplitRowCtx
 * @typedef {{ t: "pair", l: PatchLine | null, r: PatchLine | null }} SplitRowPair
 * @typedef {SplitRowFile | RowHunk | SplitRowCtx | SplitRowPair} SplitRow
 * @typedef {{ t: "ctx" | "del" | "add", o: number | null, n: number | null, sign: string,
 *   text: string, noEol?: true }} UnifiedRowLine
 * @typedef {SplitRowFile | RowHunk | UnifiedRowLine} UnifiedRow
 */

/** §3.7 render page size: first paint rows, and each「显示更多」append (D5 slices with it). */
export const WTDIFF_RENDER_PAGE_ROWS = 2_000;

/** §3.7 per-line display cap in CODE POINTS (see `clipLine`). */
export const WTDIFF_LINE_DISPLAY_MAX = 2_000;

/**
 * §4.1 作用域推导, the wtdiff twin of `previewScopeOf` (`./preview.js`). Password (LAN)
 * mode needs `wtdiff.v1` AND `preview.lan.v1` — the LAN gate rides preview's cap (D6); every
 * other listener mode needs `wtdiff.v1` alone (declared whenever `config.preview` exists and
 * `/proc/self/fd` is usable, D21). Total and never throws.
 * @param {WtdiffScopeInput} [p]
 * @returns {WtDiffScope | null}
 */
export function wtdiffScopeOf(p) {
  const { mode, hubCaps, hasTransport, agentKey, session } = p ?? {};
  if (hasTransport !== true) return null;
  const caps = Array.isArray(hubCaps) ? hubCaps : [];
  if (!caps.includes(WTDIFF_HUB_CAP)) return null;
  if (mode === "password" && !caps.includes(PREVIEW_LAN_HUB_CAP)) return null;
  if (typeof agentKey !== "string" || agentKey === "") return null;
  if (session === null || typeof session !== "object") return null;
  const s = /** @type {{ sessionId?: unknown }} */ (session);
  if (typeof s.sessionId !== "string" || s.sessionId === "") return null;
  return { agentKey, sessionId: s.sessionId };
}

/**
 * §4.1 row eligibility — whether a worktree panel row may expand the file list:
 * scope non-null ∧ `row.path` a usable string (the `wt` request input; the wire drops the
 * field first under projection pressure — such rows stay inert) ∧ not bare/prunable (git
 * cannot diff them) ∧ the row might carry changes (`dirty > 0`, or a capped count which is
 * a LOWER bound, or an unprobed row whose dirty state is simply unknown). Clean rows keep
 * today's inert `<span>` (I8). Total and never throws.
 * @param {WtDiffScope | null} scope
 * @param {WorktreeRowWire | null | undefined} row
 * @returns {boolean}
 */
export function rowDiffable(scope, row) {
  if (scope === null || typeof scope !== "object") return false;
  if (row === null || typeof row !== "object") return false;
  if (typeof row.path !== "string" || row.path === "") return false;
  if (row.bare === true || row.prunable === true) return false;
  if (typeof row.dirty === "number" && row.dirty > 0) return true;
  if (row.dirtyCapped === true) return true;
  return row.unprobed !== undefined;
}

/**
 * §4.5 refresh signature: `head|dirty|dirtyCapped|untrackedSkipped`. Opaque — only equality
 * of two signatures of the SAME row across samples matters (a change ⇒ debounce-refresh the
 * expanded list / raise the dialog's「工作区已变化」banner). Absent fields render as empty
 * strings so `dirty: 3` and `dirty: undefined` never collide. Total and never throws.
 * @param {WorktreeRowWire | null | undefined} row
 * @returns {string}
 */
export function rowSig(row) {
  if (row === null || typeof row !== "object") return "";
  const head = typeof row.head === "string" ? row.head : "";
  const dirty = typeof row.dirty === "number" ? row.dirty : "";
  return `${head}|${dirty}|${row.dirtyCapped === true ? 1 : 0}|${row.untrackedSkipped === true ? 1 : 0}`;
}

/** The eight §4.2 badges, keyed off the protocol's single status source (`WTDIFF_STATUSES`). */
const WTDIFF_BADGES = new Map(WTDIFF_STATUSES.map((s) => [s, { cls: s === "?" ? "q" : s.toLowerCase(), label: s }]));

/**
 * §4.2 status badge cell: `{ cls, label }` where `cls` is the lowercase status letter (the
 * D5 CSS tier, e.g. `.wtd-badge.m`) and `label` the status itself. Unknown input (defensive
 * only — the D0 parser enforces the enum) degrades to the generic `{ cls: "q", label: "?" }`.
 * @param {unknown} status
 * @returns {StatusBadge}
 */
export function statusBadge(status) {
  return WTDIFF_BADGES.get(status) ?? { cls: "q", label: "?" };
}

/**
 * §4.2 / §4.3 `+a −d` stat cell (mockup glyphs: ASCII `+`, typographic `−` U+2212). An
 * absent count renders as `""` (binary / untracked / filtered / numstat-missing entries) so
 * the component drops the empty half; a present `0` stays visible (`+0 −0`, mode-only).
 * @param {unknown} add
 * @param {unknown} del
 * @returns {StatParts}
 */
export function formatStat(add, del) {
  return {
    plus: typeof add === "number" ? `+${add}` : "",
    minus: typeof del === "number" ? `\u2212${del}` : "",
  };
}

/**
 * §4.2 display-layer control-character visualization for paths (and any other monospace
 * label): every C0 control becomes its Unicode control-picture glyph (U+2400 + code — so CR
 * → `␍` U+240D, LF → `␊` U+240A, TAB → `␉` U+2409), DEL → `␡` U+2421. Everything else —
 * including U+FFFD, already a visible replacement glyph — passes through unchanged.
 * Total and never throws.
 * @param {unknown} path
 * @returns {string}
 */
export function displayPath(path) {
  const s = typeof path === "string" ? path : "";
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return c === 0x7f ? "\u2421" : String.fromCharCode(0x2400 + c);
  });
}

/**
 * §3.7 per-line display clip. Measures and cuts at CODE POINT boundaries — a surrogate pair
 * straddling the limit is omitted whole and counts as ONE clipped character (代理对不切半).
 * When nothing is clipped the ORIGINAL string is returned untouched (`clipped: 0`); when
 * clipping fires, `text` is the kept prefix plus the `…(+N)` marker carrying the omitted
 * code-point count. `max` defaults to `WTDIFF_LINE_DISPLAY_MAX`; a non-finite/negative `max`
 * falls back to the default. Total and never throws.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {ClippedLine}
 */
export function clipLine(text, max) {
  const s = typeof text === "string" ? text : "";
  const limit = typeof max === "number" && Number.isFinite(max) && max >= 0 ? Math.floor(max) : WTDIFF_LINE_DISPLAY_MAX;
  // [...s] iterates code points: astral chars stay whole, lone surrogates are single items.
  const cps = [...s];
  if (cps.length <= limit) return { text: s, clipped: 0 };
  const clipped = cps.length - limit;
  return { text: `${cps.slice(0, limit).join("")}…(+${clipped})`, clipped };
}

/**
 * §3.4 hunk-header row text, byte-exact with git: `@@ -a,b +c,d @@` — no trailing space
 * when the section is empty (the plan's template literal would leave one; git never does).
 * @param {import("@protocol/worktree-diff.ts").PatchHunk} hunk
 * @returns {string}
 */
function hunkHeaderText(hunk) {
  const base = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return hunk.section === "" ? base : `${base} ${hunk.section}`;
}

/**
 * §3.4 split rows from a parsed patch. Row grammar (one row = one equal-height grid line):
 * `{ t:"file", meta }` per `diff --git` block when the patch carries MORE than one file,
 * `{ t:"hunk", text }` per hunk header, `{ t:"ctx", o, n, text, noEol? }` per context line,
 * `{ t:"pair", l, r }` per zip-paired del/add slot — `l`/`r` reference the parsed
 * `PatchLine`s themselves, and the SHORTER side of a run pads with `null` (D10: single-row
 * pairs, empty cell on one side only, never accumulating across ctx re-alignments).
 * Returns `[]` for null/non-object input. Total and never throws.
 * @param {ParsedPatch | null | undefined} parsed
 * @returns {SplitRow[]}
 */
export function buildSplitRows(parsed) {
  /** @type {SplitRow[]} */
  const rows = [];
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.files)) return rows;
  const multi = parsed.files.length > 1;
  for (const file of parsed.files) {
    if (multi) rows.push({ t: "file", meta: file.meta });
    for (const hunk of file.hunks) {
      rows.push({ t: "hunk", text: hunkHeaderText(hunk) });
      const L = hunk.lines;
      let i = 0;
      while (i < L.length) {
        const line = L[i];
        if (line === undefined) break;
        if (line.k === "ctx") {
          const ctxRow = { t: "ctx", o: line.o, n: line.n, text: line.text };
          if (line.noEol === true) ctxRow.noEol = true;
          rows.push(ctxRow);
          i++;
          continue;
        }
        const dels = [];
        const adds = [];
        while (i < L.length) {
          const seg = L[i];
          if (seg === undefined || seg.k === "ctx") break;
          (seg.k === "del" ? dels : adds).push(seg);
          i++;
        }
        const pairs = Math.max(dels.length, adds.length);
        for (let j = 0; j < pairs; j++) {
          rows.push({ t: "pair", l: dels[j] ?? null, r: adds[j] ?? null });
        }
      }
    }
  }
  return rows;
}

/**
 * §3.5 unified rows: one row per `PatchLine` — `{ t, o, n, sign, text, noEol? }` with sign
 * `+` (add) / `−` U+2212 (del, the mockup's glyph) / `""` (ctx); `o`/`n` stay `null` on the
 * sides a line does not occupy (the component renders the empty cell). Hunk headers span the
 * four cells; multi-file block headers are identical to split. Returns `[]` for null input.
 * Total and never throws.
 * @param {ParsedPatch | null | undefined} parsed
 * @returns {UnifiedRow[]}
 */
export function buildUnifiedRows(parsed) {
  /** @type {UnifiedRow[]} */
  const rows = [];
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.files)) return rows;
  const multi = parsed.files.length > 1;
  for (const file of parsed.files) {
    if (multi) rows.push({ t: "file", meta: file.meta });
    for (const hunk of file.hunks) {
      rows.push({ t: "hunk", text: hunkHeaderText(hunk) });
      for (const line of hunk.lines) {
        const row = {
          t: line.k,
          o: line.o,
          n: line.n,
          sign: line.k === "add" ? "+" : line.k === "del" ? "\u2212" : "",
          text: line.text,
        };
        if (line.noEol === true) row.noEol = true;
        rows.push(row);
      }
    }
  }
  return rows;
}
