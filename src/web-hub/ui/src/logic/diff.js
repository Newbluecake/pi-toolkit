/**
 * web-hub edit-tool diff view model — pure UI logic (2026-10, 用户需求「edit 工具卡片直接
 * 呈现改了哪些内容」). No DOM, no I/O, no Vue imports — runs unchanged under vitest (node)
 * and in the browser, same discipline as `./highlight.js`. The renderer is `ToolCard.vue`.
 *
 * What this computes: for a `tool` transcript card whose `toolName === "edit"` and whose args
 * parse as `{ path?, edits: [{ oldText: string, newText: string }, …] }`, a unified-diff-style
 * row list per edit entry (`编辑 N/M` hunk). Anything else returns `null` and the card keeps
 * its raw-JSON Input section — the gate is total, not per-entry.
 *
 * Rules (frozen here, mirrored by `tests/web-hub/ui/logic-diff.test.ts`):
 * - Line alignment: `oldText`/`newText` split on `\n` (`""` ⇒ zero lines; a trailing `\n`
 *   keeps its trailing empty line), common leading/trailing lines trimmed first (cheap), then
 *   a classic LCS on the remaining middle. LCS cost is guarded (`LCS_CELL_GUARD` cells):
 *   over the guard the middle degrades to pure `-` rows then pure `+` rows — no common
 *   detection, no inline pairing — so a monster edit never stalls the main thread.
 * - LCS walk ⇒ op stream (`common`/`del`/`add`); consecutive non-common ops merge into one
 *   change group whose dels/adds are zip-paired index-wise: a paired (old, new) renders as a
 *   `-` row followed by a `+` row; leftovers render as pure rows (no inline marks).
 * - Inline marks: for a paired line, the common char prefix/suffix (non-overlapping, capped at
 *   `min(len)`; equal lines ⇒ empty range ⇒ no marks) is trimmed and the middle slice on each
 *   side becomes that row's `hl: true` segments — the deeper-tier highlight in the CSS.
 * - Fold guard (`DIFF_FOLD`): `foldRows()` collapses a hunk over `threshold` rows to
 *   head + fold marker + tail; the marker is DATA (`{ kind: "fold", count }`) — expanding is
 *   the component's business (it still holds the full rows, this only slices a display copy).
 */

/**
 * @typedef {{ hl: boolean, text: string }} DiffSeg
 * @typedef {{ kind: "common", text: string }} DiffRowCommon
 * @typedef {{ kind: "del" | "add", segs: DiffSeg[] }} DiffRowChange
 * @typedef {{ kind: "fold", count: number }} DiffRowFold
 * @typedef {DiffRowCommon | DiffRowChange | DiffRowFold} DiffRow
 * @typedef {{ rows: DiffRow[] }} DiffHunk
 * @typedef {{ path: string | null, edits: DiffHunk[] }} EditDiffView
 */

/** Max LCS DP cells ((n+1)·(m+1)) before degrading to unpaired pure rows. */
const LCS_CELL_GUARD = 1_000_000;

/** Display-fold thresholds: fold when a hunk exceeds `threshold` rows, keep head+tail around
 *  the marker. Exported for tests; `foldRows` callers pass nothing to use these. */
export const DIFF_FOLD = Object.freeze({ threshold: 200, head: 20, tail: 20 });

/** `""` ⇒ `[]` (a truly empty side has no lines); a trailing `\n` keeps its trailing `""`. */
export function splitLines(text) {
  return text === "" ? [] : text.split("\n");
}

/** Count of identical leading (`pre`) / trailing (`suf`) lines, non-overlapping. */
function trimCommonLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/** LCS op stream of the middle blocks: `[{ op: "common"|"del"|"add", text }]`.
 *  `old[i] === new[j]` is always safe to take as a match (classical LCS property). */
function lcsOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const w = m + 1;
  const t = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const oi = oldLines[i];
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = oi === newLines[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  /** @type {{ op: "common" | "del" | "add", text: string }[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ op: "common", text: oldLines[i] });
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      ops.push({ op: "del", text: oldLines[i] });
      i++;
    } else {
      ops.push({ op: "add", text: newLines[j] });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ op: "del", text: oldLines[i] });
  for (; j < m; j++) ops.push({ op: "add", text: newLines[j] });
  return ops;
}

/** `text` with `[start, end)` marked: plain/marked/plain segments, empties skipped; an empty
 *  range yields a single plain segment (or none for the empty string) — so UNPAIRED rows
 *  (`segsOf(l, 0, 0)`) never carry an inline mark, while a PAIRED line whose fragment spans
 *  the whole line keeps it (GitHub-split-style full-line chip). */
function segsOf(text, start, end) {
  if (start >= end) return text === "" ? [] : [{ hl: false, text }];
  /** @type {DiffSeg[]} */
  const segs = [];
  if (start > 0) segs.push({ hl: false, text: text.slice(0, start) });
  segs.push({ hl: true, text: text.slice(start, end) });
  if (end < text.length) segs.push({ hl: false, text: text.slice(end) });
  return segs;
}

/** One paired change block: `-` row + `+` row sharing a char prefix/suffix trim. */
function changeRows(oldLine, newLine) {
  const min = Math.min(oldLine.length, newLine.length);
  let p = 0;
  while (p < min && oldLine.charCodeAt(p) === newLine.charCodeAt(p)) p++;
  let s = 0;
  while (s < min - p && oldLine.charCodeAt(oldLine.length - 1 - s) === newLine.charCodeAt(newLine.length - 1 - s)) s++;
  return [
    { kind: "del", segs: segsOf(oldLine, p, oldLine.length - s) },
    { kind: "add", segs: segsOf(newLine, p, newLine.length - s) },
  ];
}

/** Op stream ⇒ rows: commons pass through; runs of non-common ops merge into one change group
 *  whose dels/adds are zip-paired (leftovers become pure rows without inline marks). */
function opsToRows(ops) {
  /** @type {DiffRow[]} */
  const rows = [];
  /** @type {string[] | null} */
  let dels = null;
  /** @type {string[] | null} */
  let adds = null;
  const flush = () => {
    if (dels === null && adds === null) return;
    const d = dels ?? [];
    const a = adds ?? [];
    const k = Math.min(d.length, a.length);
    for (let x = 0; x < k; x++) rows.push(...changeRows(d[x], a[x]));
    for (let x = k; x < d.length; x++) rows.push({ kind: "del", segs: segsOf(d[x], 0, 0) });
    for (let x = k; x < a.length; x++) rows.push({ kind: "add", segs: segsOf(a[x], 0, 0) });
    dels = null;
    adds = null;
  };
  for (const { op, text } of ops) {
    if (op === "common") {
      flush();
      rows.push({ kind: "common", text });
    } else if (op === "del") {
      (dels ??= []).push(text);
    } else {
      (adds ??= []).push(text);
    }
  }
  flush();
  return rows;
}

/** All rows of one edit entry (`编辑 N/M` hunk): commons around the change groups. Over the
 *  cell guard the middle degrades INLINE to pure `-` rows then pure `+` rows — no common
 *  detection and NO zip pairing (unrelated monster lines would make inline marks pure noise),
 *  which is why there is no `fallbackOps` helper. */
export function editHunkRows(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { pre, suf } = trimCommonLines(a, b);
  /** @type {DiffRow[]} */
  const rows = [];
  for (let x = 0; x < pre; x++) rows.push({ kind: "common", text: a[x] });
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (midA.length !== 0 || midB.length !== 0) {
    if (midA.length * midB.length > LCS_CELL_GUARD) {
      for (const l of midA) rows.push({ kind: "del", segs: segsOf(l, 0, 0) });
      for (const l of midB) rows.push({ kind: "add", segs: segsOf(l, 0, 0) });
    } else {
      rows.push(...opsToRows(lcsOps(midA, midB)));
    }
  }
  for (let x = 0; x < suf; x++) rows.push({ kind: "common", text: a[a.length - suf + x] });
  return rows;
}

/**
 * Display-fold a hunk's rows: over `threshold` ⇒ head + `{ kind: "fold", count }` + tail.
 * The input array is never mutated; `folded === false` returns it unchanged.
 * @param {DiffRow[]} rows
 * @param {{ threshold?: number, head?: number, tail?: number }} [fold]
 * @returns {{ rows: DiffRow[], folded: boolean, hidden: number }}
 */
export function foldRows(rows, fold) {
  const threshold = fold?.threshold ?? DIFF_FOLD.threshold;
  const head = fold?.head ?? DIFF_FOLD.head;
  const tail = fold?.tail ?? DIFF_FOLD.tail;
  const hidden = rows.length - head - tail;
  if (rows.length <= threshold || hidden <= 0) return { rows, folded: false, hidden: 0 };
  const out = rows.slice(0, head);
  out.push({ kind: "fold", count: hidden });
  out.push(...rows.slice(rows.length - tail));
  return { rows: out, folded: true, hidden };
}

/**
 * `edit`-tool args → diff view model, or `null` when the card must keep its raw-JSON Input
 * section (any other tool name; non-object args; missing/empty/non-array `edits`; any entry
 * that is not a plain object with string `oldText` AND `newText`). `""` texts are VALID (pure
 * insertion / pure deletion) — only a missing or non-string one rejects.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {EditDiffView | null}
 */
export function buildEditDiff(toolName, args) {
  if (toolName !== "edit") return null;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const edits = /** @type {Record<string, unknown>} */ (args).edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  /** @type {DiffHunk[]} */
  const hunks = [];
  for (const e of edits) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
    const rec = /** @type {Record<string, unknown>} */ (e);
    if (typeof rec.oldText !== "string" || typeof rec.newText !== "string") return null;
    hunks.push({ rows: editHunkRows(rec.oldText, rec.newText) });
  }
  const rawPath = /** @type {Record<string, unknown>} */ (args).path;
  const path = typeof rawPath === "string" && rawPath !== "" ? rawPath : null;
  return { path, edits: hunks };
}
