// §4.4 T3: budget feedback line + exact-duplicate-line detection — P2 real
// implementation (todo #22 optimize-plan §14.1).
//
// §14.1's only sanctioned P2→P1 runtime dependency ("P2 的块估算调用 P1 的
// renderTiered") is wired here as an INJECTED PORT (`renderBlock`) rather
// than a direct import of `tiered.ts` — P1 is developed in parallel and its
// `renderTiered` is a throwing stub through P0–P4; real wiring lands in P5
// (§14.1's "全部经 P0 冻结的签名，开发期用桩/注入端口测试，真实串联在
// P5"). `computeBudgetReport`'s exact call shape is verified against a FAKE
// port in `tests/memory/budget.test.ts`; P5 passes the real `renderTiered`.
//
// Zero pi/typebox imports; independently unit-testable.

import type { BudgetReport, TieredRenderInput, TieredRenderResult } from "./contracts.js";

export interface DuplicateLineHit {
  line: string;
  alsoAt: string; // "<file>:<lineNo>"
}

const MIN_DUP_CODEPOINTS = 16;
const MAX_DUP_HITS = 3;

/** Strip a single leading list marker (`- `, `* `, or `N. `). */
function stripListMarker(s: string): string {
  return s.replace(/^(?:[-*]\s+|\d+\.\s+)/, "");
}

/** trim → collapse internal whitespace → drop one leading list marker →
 *  ASCII-lowercase (§4.4: safe superset for non-ASCII text, which
 *  `toLowerCase()` leaves unchanged). */
function normalizeLine(line: string): string {
  return stripListMarker(line.trim().replace(/\s+/g, " ")).toLowerCase();
}

/**
 * §4.4's exact-duplicate-line scan: each of `newLines` normalized and looked
 * up (`Set`/`Map`, O(total corpus lines)) against every line of `corpus`
 * (which may include the SAME file's other, unaffected lines — the caller's
 * choice, this function is agnostic to "self" vs "other file"). Lines under
 * 16 normalized code points are never compared (too likely to coincidentally
 * match); at most 3 hits are reported. Approximate/near matching is out of
 * scope (D12/§13, `similar.ts`, deferred).
 */
export function findExactDuplicates(
  newLines: readonly string[],
  corpus: readonly { file: string; lines: readonly string[] }[],
): DuplicateLineHit[] {
  const index = new Map<string, string>(); // normalized line -> "file:lineNo" (first occurrence wins)
  for (const { file, lines } of corpus) {
    for (let i = 0; i < lines.length; i++) {
      const norm = normalizeLine(lines[i] ?? "");
      if ([...norm].length < MIN_DUP_CODEPOINTS) continue;
      if (!index.has(norm)) index.set(norm, `${file}:${i + 1}`);
    }
  }
  const hits: DuplicateLineHit[] = [];
  for (const line of newLines) {
    if (hits.length >= MAX_DUP_HITS) break;
    const norm = normalizeLine(line);
    if ([...norm].length < MIN_DUP_CODEPOINTS) continue;
    const alsoAt = index.get(norm);
    if (alsoAt !== undefined) hits.push({ line, alsoAt });
  }
  return hits;
}

// ───────────────────────────── budget report line ─────────────────────────────

function fmtKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? `${kb}k` : `${kb.toFixed(1)}k`;
}

export interface BudgetFileInfo {
  name: string;
  /** Byte size AFTER this write/append (frontmatter included). */
  bytes: number;
  /** Whether `name` is the current primary core file (§2.1: `core.md`, or —
   *  absent that — the first pin:true non-archived file by filename order).
   *  Core files are measured against `coreBytes`, not
   *  `topicWarnBytes`/`topicMaxBytes`. */
  isCore: boolean;
}

export interface BudgetLimits {
  coreBytes: number;
  topicWarnBytes: number;
  topicMaxBytes: number;
}

export interface RenderBlockRequest {
  /** P1's `renderTiered`, injected (see file header). */
  fn: (input: TieredRenderInput) => TieredRenderResult;
  input: TieredRenderInput;
}

export interface ComputeBudgetOpts {
  file: BudgetFileInfo;
  limits: BudgetLimits;
  /** Current primary core file's post-write byte size, when it differs from
   *  `file` (i.e. `file.isCore` is false) — omitted when no core-eligible
   *  file exists yet. Equal to `file.bytes` whenever `file.isCore`. */
  coreFileBytes?: number;
  duplicates?: readonly DuplicateLineHit[];
  warnings?: readonly string[];
  renderBlock?: RenderBlockRequest;
}

/**
 * §4.4's fixed T3 feedback line, appended to every successful v2
 * write/append result: `<file> size/warn(hard max)`, optionally
 * ` · core X/Yk` and ` · block X/Yk (LN)` (the latter only when
 * `renderBlock` is supplied AND actually reachable — §4.4: "layout=legacy
 * 时只报文件大小" is expressed by the caller simply omitting `renderBlock`).
 */
export function computeBudgetReport(opts: ComputeBudgetOpts): BudgetReport {
  const { file, limits } = opts;
  const warnings: string[] = [...(opts.warnings ?? [])];

  let head: string;
  if (file.isCore) {
    head = `${file.name} ${fmtKB(file.bytes)}/${fmtKB(limits.coreBytes)} (core)`;
  } else {
    head = `${file.name} ${fmtKB(file.bytes)}/${fmtKB(limits.topicWarnBytes)} (hard ${fmtKB(limits.topicMaxBytes)})`;
    if (file.bytes > limits.topicWarnBytes) {
      warnings.push(`${file.name} is ${fmtKB(file.bytes)} — over the ${fmtKB(limits.topicWarnBytes)} warn threshold`);
    }
  }

  let coreSeg = "";
  if (!file.isCore && opts.coreFileBytes !== undefined) {
    coreSeg = ` · core ${fmtKB(opts.coreFileBytes)}/${fmtKB(limits.coreBytes)}`;
  }

  let blockSeg = "";
  if (opts.renderBlock) {
    const result = opts.renderBlock.fn(opts.renderBlock.input);
    blockSeg = ` · block ${fmtKB(result.bytes)}/${fmtKB(opts.renderBlock.input.blockBytes)} (L${result.level})`;
  }

  const duplicates = opts.duplicates ?? [];
  for (const dup of duplicates) {
    warnings.push(`duplicate line: ${JSON.stringify(dup.line)} also at ${dup.alsoAt}`);
  }

  return { line: `budget: ${head}${coreSeg}${blockSeg}`, duplicates, warnings };
}
