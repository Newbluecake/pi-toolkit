/**
 * `memory` tool v2 — official-field-compatible surface (optimize-plan §4).
 * `createMemoryToolV2(deps)` builds the v2 `ToolDefinition`; `deps` matches
 * P0-b's frozen `MemoryToolV2Deps` shape exactly (index.ts already calls it
 * with `{settings, isChildSession, onAfterWrite}` — this file only ADDS
 * optional fields, never a required one, so that existing call stays valid).
 *
 * Cross-package dependency (§14.1: "P2 的块估算调用 P1 的 renderTiered") is
 * an injected port, optional and a no-op until P5 wires it:
 * - `deps.renderBlock`: P1's `renderTiered`, used only for the T3 budget
 *   line's/`view`'s directory-listing "block X/Yk (LN)" segment. Omitted
 *   (as it is through P0–P4) ⇒ that segment is skipped — in the spirit of
 *   §4.4's "layout=legacy 时只报文件大小".
 *
 * A `runDoctor`-backed "doctor: N error M warn" summary segment in the
 * directory listing (§6.2) is intentionally NOT wired here: §14.1 lists
 * exactly three sanctioned cross-package runtime calls (P2→P1, P3→P1,
 * P4→P3) and a P2→P3 dependency is not one of them. This package's `view`
 * directory listing omits that segment; P5 (or a follow-up) can splice it
 * in without touching this file's tested logic.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { TieredRenderInput, TieredRenderResult } from "./contracts.js";
import {
  findStrReplaceMatches,
  frontmatterEndOffset,
  resolveInsertTarget,
  resolveSectionMatch,
  splitSectionsWithLines,
} from "./edit.js";
import { frontmatterSource, upsertFrontmatterFields } from "./frontmatter.js";
import { withMemoryDirLock } from "./lock.js";
import { descriptionOrHeading, parseMemoryMeta } from "./meta.js";
import { normalizeMemoryCall, type MemoryOpV2, type NormalizedCall } from "./normalize.js";
import { memoryDirFor, MemoryError, toSlug, type MemoryPaths } from "./paths.js";
import { formatSize } from "./render.js";
import {
  canonicalDir,
  createExclusive,
  ensureMemoryDir,
  ensurePrivateDir,
  isV2Name,
  listRegular,
  readRegular,
  renameNoClobber,
  replaceAtomic,
  statRegularIfExists,
  writeTempRegular,
  type RegularRead,
  type RegularStat,
} from "./safe-fs.js";
import { searchMemory } from "./search.js";
import { computeBudgetReport, findExactDuplicates, type BudgetLimits } from "./budget.js";
import { assertAllowWrite, resolveMemoryFile } from "./store.js";
import { MEMORY_TOOL_V2_TEXT, MemoryToolParamsV2 } from "./tool-surface.js";

export interface MemoryToolV2Deps {
  settings: MemorySettings;
  isChildSession: boolean;
  onAfterWrite: (cwd: string) => void;
  paths?: MemoryPaths;
  /** §14.1's sanctioned P1 dependency, injected as a port (see file header).
   *  Real wiring lands in P5; every P0–P4 call site omits it. */
  renderBlock?: (input: TieredRenderInput) => TieredRenderResult;
}

type ToolTextResult = { content: { type: "text"; text: string }[]; details: undefined };

function text(t: string): ToolTextResult {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

/** B3: worktree child sessions resolve back to the original repository cwd
 *  (same convention as the legacy tool, `tool.ts`). */
function resolveCwd(ctx: ExtensionContext | undefined): string {
  const raw = ctx?.cwd ?? process.cwd();
  return resolveWorktreeOrigin(raw) ?? raw;
}

const READ_ONLY_OPS = new Set<MemoryOpV2>(["view", "search"]);

function isHandWritten(content: string): boolean {
  return frontmatterSource(content) !== "agent";
}

function statsEqual(a: RegularStat | undefined, b: RegularStat | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function readExisting(real: string, name: string): RegularRead | undefined {
  try {
    return readRegular(real, name);
  } catch (err) {
    if (err instanceof MemoryError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * §3.3's read-modify-write atomic sequence, minus the "delete the temp file
 * on a failed recheck" step: since NOTHING between the caller's initial read
 * and this recheck yields the event loop (`withMemoryDirLock`'s body is
 * fully synchronous), moving the recheck to happen BEFORE `writeTempRegular`
 * (rather than after, as the plan's illustrative ordering has it) gives the
 * exact same atomicity guarantee — no legitimate lock-respecting writer can
 * have touched the file in between either way — while never creating a temp
 * file that would need to be discarded. `safe-fs.ts` (frozen) exposes no
 * "delete a temp file by name" primitive, so this reordering avoids needing
 * one without weakening the guarantee (flagged in this package's final
 * report as a possible small follow-up, not a blocker).
 */
function commitReplace(
  real: string,
  name: string,
  baseline: RegularStat | undefined,
  data: Buffer,
  mode: number,
): void {
  const now = statRegularIfExists(real, name);
  if (!statsEqual(baseline, now)) {
    throw new MemoryError(`${name} changed concurrently; view and retry`);
  }
  const tmp = writeTempRegular(real, name, data, mode);
  replaceAtomic(real, tmp, name);
}

// ───────────────────────────── primary-core detection (§2.1) ─────────────────────────────

/** §2.1: `name === "core.md"` is ALWAYS the primary core, even before it
 *  exists on disk (creating it makes it so immediately) — `determinePrimaryCore`
 *  alone only reflects the CURRENT listing, which doesn't yet include a file
 *  being created/renamed into that name. */
function isCoreFile(name: string, files: readonly { name: string; body: string }[]): boolean {
  if (name === "core.md") return true;
  return determinePrimaryCore(files)?.name === name;
}

interface CoreInfo {
  name: string;
  bytes: number;
}

/** §2.1: `core.md` if present, else the first (filename order) `pin:true`
 *  non-archived file. Pure lookup over an already-materialized listing — no
 *  disk access beyond what the caller already did. */
function determinePrimaryCore(files: readonly { name: string; body: string }[]): CoreInfo | undefined {
  const coreMd = files.find((f) => f.name === "core.md");
  if (coreMd) return { name: coreMd.name, bytes: Buffer.byteLength(coreMd.body, "utf8") };
  const pinned = files
    .filter((f) => {
      const meta = parseMemoryMeta(f.body, f.name.replace(/\.md$/, "")).meta;
      return meta.pin && meta.status !== "archived";
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const first = pinned[0];
  return first ? { name: first.name, bytes: Buffer.byteLength(first.body, "utf8") } : undefined;
}

// ───────────────────────────── hard limits ─────────────────────────────

function biggestSections(body: string, n: number): { heading: string; bytes: number }[] {
  const { sections } = splitSectionsWithLines(body);
  return sections
    .map((s) => ({ heading: s.heading, bytes: Buffer.byteLength(s.text, "utf8") }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

/** §4.4 "原有 maxWriteBytes（单次）/ maxFileBytes（绝对上限）保留为最外层":
 *  `maxWriteBytes` bounds the CALLER'S raw payload for a single write op
 *  (the pre-upsert `file_text`/`new_str`/`insert_text`/`content` — never the
 *  file's full final text), independent of and checked before every other
 *  limit — legacy `store.ts` checks the exact same raw-input quantity. */
function assertWithinWriteLimit(payload: string, maxWriteBytes: number): void {
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxWriteBytes) {
    throw new MemoryError(
      `content is ${bytes}B, over the per-write limit of ${maxWriteBytes}B — split it into smaller writes`,
    );
  }
}

/** `maxFileBytes` is the absolute file-size ceiling (§4.4: "保留为最外层",
 *  §9: "语义不变") — unlike `coreBytes`/`topicMaxBytes` it applies
 *  UNCONDITIONALLY to the final byte count, not only when the file grew
 *  (matches legacy `store.ts`'s `writeMemoryFile`). */
function assertWithinFileByteCap(name: string, finalContent: string, maxFileBytes: number): void {
  const bytes = Buffer.byteLength(finalContent, "utf8");
  if (bytes > maxFileBytes) {
    throw new MemoryError(`${name} would be ${bytes}B, over the ${maxFileBytes}B absolute file cap`);
  }
}

/** §4.3 "frontmatter 校验（写入结果中的 frontmatter）：结构性错误 ⇒ 拒写".
 *  Used by create/write (a full new body): every structural error in the
 *  final frontmatter block rejects the write. */
function assertValidFrontmatter(name: string, finalContent: string): void {
  const errors = parseMemoryMeta(finalContent, name.replace(/\.md$/, "")).errors;
  if (errors.length > 0) {
    throw new MemoryError(`refused: ${name}'s frontmatter is invalid — ${errors.join("; ")}`);
  }
}

/** Same rule for str_replace/insert/append, which only ever touch a file's
 *  BODY (frontmatter is preserved byte-for-byte or left untouched for a
 *  hand-written file) — an old file that already had an invalid
 *  frontmatter must stay editable (decision 8: pre-existing problems are
 *  doctor-only prompts, never a write-blocker), so only errors that this
 *  edit newly introduces reject the write. */
function assertNoNewFrontmatterErrors(name: string, oldContent: string, finalContent: string): void {
  const topic = name.replace(/\.md$/, "");
  const oldErrors = new Set(parseMemoryMeta(oldContent, topic).errors);
  const newErrors = parseMemoryMeta(finalContent, topic).errors.filter((e) => !oldErrors.has(e));
  if (newErrors.length > 0) {
    throw new MemoryError(`refused: ${name}'s frontmatter is invalid — ${newErrors.join("; ")}`);
  }
}

/** §4.4's hard upper limits — only trip when the file GREW past the limit
 *  ("只在变更后更大时生效，旧的超限文件可以缩小"). */
function assertWithinHardLimit(
  name: string,
  isCore: boolean,
  newBody: string,
  oldBytes: number,
  limits: BudgetLimits,
): void {
  const newBytes = Buffer.byteLength(newBody, "utf8");
  const limit = isCore ? limits.coreBytes : limits.topicMaxBytes;
  if (newBytes <= limit || newBytes <= oldBytes) return;
  const top = biggestSections(newBody, 3);
  const list = top.map((s) => `${JSON.stringify(s.heading)} (${formatSize(s.bytes)})`).join(", ");
  const suggestion = isCore
    ? `sink the largest section into a topic file (create path=<topic>.md) and leave a pointer in ${name}`
    : `split ${name} by section (create path=<topic>.md)`;
  throw new MemoryError(
    `${name} would be ${formatSize(newBytes)}, over the ${formatSize(limit)} ${isCore ? "core" : "hard"} limit` +
      (list ? ` — largest sections: ${list}` : "") +
      `; ${suggestion}`,
  );
}

// ───────────────────────────── directory listing ─────────────────────────────

interface ListedFile {
  name: string;
  body: string;
  bytes: number;
}

function readAllV2(real: string): ListedFile[] {
  const { files } = listRegular(real, { names: "v2" });
  const out: ListedFile[] = [];
  for (const f of files) {
    try {
      const { text: body } = readRegular(real, f.name);
      out.push({ name: f.name, body, bytes: f.size });
    } catch {
      // symlink swapped in after listing / raced delete — skip, never fatal
    }
  }
  return out;
}

function fmtKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? `${kb}k` : `${kb.toFixed(1)}k`;
}

function renderDirectoryListing(cwd: string, real: string, deps: MemoryToolV2Deps, budget: BudgetLimits): string {
  const files = readAllV2(real).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (files.length === 0) {
    return `No memory for ${cwd} yet. Add *.md to ${memoryDirFor(cwd, deps.paths)}/ or run /mem import.`;
  }
  const lines = files.map((f) => {
    const { meta } = parseMemoryMeta(f.body, f.name.replace(/\.md$/, ""));
    const desc = descriptionOrHeading(f.body, meta);
    const updated = meta.updated ? meta.updated.slice(0, 10) : "?";
    return (
      `${f.name} · ${desc}` +
      (meta.readWhen ? ` · when: ${meta.readWhen}` : "") +
      ` · ${formatSize(f.bytes)} · ${updated} · ${meta.status}` +
      (meta.pin ? " · pin" : "") +
      (meta.source ? ` · ${meta.source}` : "")
    );
  });
  const core = determinePrimaryCore(files);
  const footerParts: string[] = [];
  if (core) footerParts.push(`core ${fmtKB(core.bytes)}/${fmtKB(budget.coreBytes)}`);
  if (deps.renderBlock) {
    const input: TieredRenderInput = {
      cwd,
      profile: "full",
      access: "memory",
      coreBytes: budget.coreBytes,
      blockBytes: deps.settings.blockBytes,
      indexMax: 15,
    };
    try {
      const result = deps.renderBlock(input);
      footerParts.push(`block ${fmtKB(result.bytes)}/${fmtKB(input.blockBytes)} (L${result.level})`);
    } catch {
      // best-effort footer segment only — never fail the whole listing
    }
  }
  const footer = footerParts.length > 0 ? `\n${footerParts.join(" · ")}` : "";
  return `Memory for ${cwd} (${toSlug(cwd)}):\n${lines.join("\n")}${footer}`;
}

// ───────────────────────────── view (single file) ─────────────────────────────

function numberedLines(lines: readonly string[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${String(i).padStart(6, " ")}\t${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

const VIEW_TRUNCATE_BYTES = 16_384;

function renderViewFile(body: string, opts: { viewRange?: readonly [number, number]; section?: string }): string {
  const lines = body.split("\n");
  const total = lines.length;
  let from = 1;
  let to = total;
  let note = "";
  if (opts.section !== undefined) {
    const { sections } = splitSectionsWithLines(body);
    const match = resolveSectionMatch(sections, opts.section);
    from = match.startLine;
    to = match.endLine;
    note = ` (section L${from}-${to})`;
  } else if (opts.viewRange !== undefined) {
    const [a, bRaw] = opts.viewRange;
    let clamped = false;
    from = a;
    to = bRaw === -1 ? total : bRaw;
    if (from < 1) {
      from = 1;
      clamped = true;
    }
    if (to > total) {
      to = total;
      clamped = true;
    }
    if (from > to) {
      from = to;
    }
    if (clamped) note = " (clamped to file range)";
  }
  const rendered = numberedLines(lines, from, to);
  if (
    opts.viewRange === undefined &&
    opts.section === undefined &&
    Buffer.byteLength(rendered, "utf8") > VIEW_TRUNCATE_BYTES
  ) {
    let bytes = 0;
    let end = 0;
    for (const ch of rendered) {
      const b = Buffer.byteLength(ch, "utf8");
      if (bytes + b > VIEW_TRUNCATE_BYTES) break;
      bytes += b;
      end += ch.length;
    }
    return rendered.slice(0, end) + "\n…(truncated — use view_range to see the rest)";
  }
  return rendered + note;
}

// ───────────────────────────── snippet rendering (±3 lines) ─────────────────────────────

function renderSnippet(body: string, aroundLine: number, context = 3): string {
  const lines = body.split("\n");
  const from = Math.max(1, aroundLine - context);
  const to = Math.min(lines.length, aroundLine + context);
  return numberedLines(lines, from, to);
}

// ───────────────────────────── delete (soft, to .trash) ─────────────────────────────

const TRASH_DIR = ".trash";
const TRASH_KEEP = 20;

function trashId(): string {
  const now = new Date();
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${iso}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

// ───────────────────────────── main factory ─────────────────────────────

export function createMemoryToolV2(deps: MemoryToolV2Deps): ToolDefinition {
  const { settings } = deps;
  const limits: BudgetLimits = {
    coreBytes: settings.coreBytes,
    topicWarnBytes: settings.topicWarnBytes,
    topicMaxBytes: settings.topicMaxBytes,
  };

  function requireDir(cwd: string): { display: string; real: string } {
    const display = memoryDirFor(cwd, deps.paths);
    ensureMemoryDir(display);
    const canon = canonicalDir(display);
    if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
    return { display, real: canon.real };
  }

  function readDirForView(cwd: string): { display: string; real: string } | undefined {
    const display = memoryDirFor(cwd, deps.paths);
    const canon = canonicalDir(display);
    return canon ? { display, real: canon.real } : undefined;
  }

  function nameFor(target: string | undefined, real: string): string {
    const resolved = resolveMemoryFile(target, real);
    if (resolved.kind === "dir") throw new MemoryError("this command requires a file path (a directory was given)");
    return resolved.name;
  }

  function assertWritable(op: MemoryOpV2): void {
    if (deps.isChildSession && !settings.allowWriteInChildSessions && !READ_ONLY_OPS.has(op)) {
      throw new Error(
        "child sessions are read-only for memory by default; enable memory.allowWriteInChildSessions to allow writes",
      );
    }
  }

  function corpusExcept(real: string, exceptName: string | undefined): { file: string; lines: readonly string[] }[] {
    return readAllV2(real)
      .filter((f) => f.name !== exceptName)
      .map((f) => ({ file: f.name, lines: f.body.split("\n") }));
  }

  function budgetLineFor(real: string, name: string, newBody: string, duplicateSourceLines: readonly string[]): string {
    const files = readAllV2(real);
    const core = determinePrimaryCore(files);
    const isCore = isCoreFile(name, files);
    const corpus = corpusExcept(real, name);
    const duplicates = findExactDuplicates(duplicateSourceLines, corpus);
    const blockInput: TieredRenderInput = {
      cwd: "",
      profile: "full",
      access: "memory",
      coreBytes: limits.coreBytes,
      blockBytes: settings.blockBytes,
      indexMax: 15,
    };
    const report = computeBudgetReport({
      file: { name, bytes: Buffer.byteLength(newBody, "utf8"), isCore },
      limits,
      ...(isCore ? {} : core ? { coreFileBytes: core.bytes } : {}),
      duplicates,
      ...(deps.renderBlock ? { renderBlock: { fn: deps.renderBlock, input: blockInput } } : {}),
    });
    return [report.line, ...report.warnings.map((w) => `⚠ ${w}`)].join("\n");
  }

  async function doCreate(real: string, name: string, fileText: string): Promise<string> {
    assertWithinWriteLimit(fileText, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      const existing = statRegularIfExists(real, name);
      if (existing)
        throw new MemoryError(
          `${name} already exists — use str_replace/insert to edit it, or action:"write" to overwrite`,
        );
      const nowIso = new Date().toISOString();
      const finalContent = upsertFrontmatterFields(fileText, { source: "agent", updated: nowIso });
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertValidFrontmatter(name, finalContent);
      assertWithinHardLimit(name, isCoreFile(name, readAllV2(real)), finalContent, 0, limits);
      const tmp = writeTempRegular(real, name, Buffer.from(finalContent, "utf8"), 0o600);
      createExclusive(real, tmp, name);
      const budgetLine = budgetLineFor(real, name, finalContent, finalContent.split("\n"));
      return `created ${name} (${formatSize(Buffer.byteLength(finalContent, "utf8"))})\n${budgetLine}`;
    });
  }

  async function doStrReplace(
    real: string,
    name: string,
    oldStr: string | undefined,
    newStr: string | undefined,
  ): Promise<string> {
    if (oldStr === undefined) throw new Error("str_replace requires old_str");
    assertWithinWriteLimit(newStr ?? "", settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      const existing = readExisting(real, name);
      if (!existing) throw new MemoryError(`the path ${name} does not exist`);
      const matches = findStrReplaceMatches(existing.text, oldStr);
      if (matches.length === 0) throw new MemoryError(`old_str did not appear verbatim in ${name} — try search first`);
      if (matches.length > 1) {
        throw new MemoryError(
          `old_str appears ${matches.length} times in ${name} (lines: ${matches.map((m) => m.line).join(", ")}) — make it unique`,
        );
      }
      const matchIndex = existing.text.indexOf(oldStr);
      const handWritten = isHandWritten(existing.text);
      if (handWritten && matchIndex < frontmatterEndOffset(existing.text)) {
        throw new MemoryError(
          `refused: the match in ${name} touches its frontmatter — edit user-authored frontmatter yourself`,
        );
      }
      const replaced =
        existing.text.slice(0, matchIndex) + (newStr ?? "") + existing.text.slice(matchIndex + oldStr.length);
      const nowIso = new Date().toISOString();
      const finalContent = handWritten
        ? replaced
        : upsertFrontmatterFields(replaced, { source: "agent", updated: nowIso });
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertNoNewFrontmatterErrors(name, existing.text, finalContent);
      const isCore = isCoreFile(name, readAllV2(real));
      assertWithinHardLimit(name, isCore, finalContent, existing.stat.size, limits);
      commitReplace(real, name, existing.stat, Buffer.from(finalContent, "utf8"), existing.stat.mode & 0o777);
      const snippet = renderSnippet(finalContent, matchLineOf(finalContent, matchIndex));
      const newLines = (newStr ?? "").split("\n");
      const budgetLine = budgetLineFor(real, name, finalContent, newLines);
      const warn = handWritten ? "⚠ edited a user-authored file; frontmatter left untouched\n" : "";
      return `${warn}edited ${name}:\n${snippet}\n${budgetLine}`;
    });
  }

  async function doInsert(
    real: string,
    name: string,
    insertLine: number | undefined,
    section: string | undefined,
    insertText: string | undefined,
  ): Promise<string> {
    if (insertText === undefined) throw new Error("insert requires insert_text (or content)");
    assertWithinWriteLimit(insertText, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      const existing = readExisting(real, name);
      if (!existing) throw new MemoryError(`the path ${name} does not exist`);
      const target = resolveInsertTarget(existing.text, {
        ...(insertLine === undefined ? {} : { insertLine }),
        ...(section === undefined ? {} : { section }),
      });
      const lines = existing.text.split("\n");
      const insertLines = insertText.split("\n");
      const out = [...lines.slice(0, target.afterLine), ...insertLines, ...lines.slice(target.afterLine)];
      const inserted = out.join("\n");
      const handWritten = isHandWritten(existing.text);
      const nowIso = new Date().toISOString();
      const finalContent = handWritten
        ? inserted
        : upsertFrontmatterFields(inserted, { source: "agent", updated: nowIso });
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertNoNewFrontmatterErrors(name, existing.text, finalContent);
      const isCore = isCoreFile(name, readAllV2(real));
      assertWithinHardLimit(name, isCore, finalContent, existing.stat.size, limits);
      commitReplace(real, name, existing.stat, Buffer.from(finalContent, "utf8"), existing.stat.mode & 0o777);
      const snippet = renderSnippet(finalContent, target.afterLine + 1);
      const budgetLine = budgetLineFor(real, name, finalContent, insertLines);
      const warn = handWritten ? "⚠ edited a user-authored file; frontmatter left untouched\n" : "";
      const noteLine = target.note ? `${target.note}\n` : "";
      return `${warn}${noteLine}edited ${name}:\n${snippet}\n${budgetLine}`;
    });
  }

  async function doOverwrite(real: string, name: string, body: string): Promise<string> {
    assertWithinWriteLimit(body, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      const existing = readExisting(real, name);
      if (existing && isHandWritten(existing.text)) {
        throw new MemoryError(
          `${name} is user-authored (no "source: agent"); edit it yourself, or add "source: agent" to its frontmatter first`,
        );
      }
      const nowIso = new Date().toISOString();
      const finalContent = upsertFrontmatterFields(body, { source: "agent", updated: nowIso });
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertValidFrontmatter(name, finalContent);
      const isCore = isCoreFile(name, readAllV2(real));
      assertWithinHardLimit(name, isCore, finalContent, existing?.stat.size ?? 0, limits);
      const mode = existing ? existing.stat.mode & 0o777 : 0o600;
      commitReplace(real, name, existing?.stat, Buffer.from(finalContent, "utf8"), mode);
      const budgetLine = budgetLineFor(real, name, finalContent, finalContent.split("\n"));
      return `wrote ${name} (${formatSize(Buffer.byteLength(finalContent, "utf8"))})\n${budgetLine}`;
    });
  }

  async function doAppend(real: string, name: string, content: string): Promise<string> {
    assertWithinWriteLimit(content, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      const existing = readExisting(real, name);
      const handWritten = existing !== undefined && isHandWritten(existing.text);
      const needsNewline = existing !== undefined && existing.stat.size > 0 && !existing.text.endsWith("\n");
      const appended = (needsNewline ? "\n" : "") + content;
      const finalContent = (existing?.text ?? "") + appended;
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertNoNewFrontmatterErrors(name, existing?.text ?? "", finalContent);
      const isCore = isCoreFile(name, readAllV2(real));
      assertWithinHardLimit(name, isCore, finalContent, existing?.stat.size ?? 0, limits);
      const mode = existing ? existing.stat.mode & 0o777 : 0o600;
      commitReplace(real, name, existing?.stat, Buffer.from(finalContent, "utf8"), mode);
      const budgetLine = budgetLineFor(real, name, finalContent, content.split("\n"));
      const warn = handWritten ? "⚠ appended to a user-authored file; frontmatter left untouched\n" : "";
      return `${warn}appended to ${name} (+${formatSize(Buffer.byteLength(appended, "utf8"))}, total ${formatSize(Buffer.byteLength(finalContent, "utf8"))})\n${budgetLine}`;
    });
  }

  async function doDelete(real: string, name: string): Promise<string> {
    return withMemoryDirLock(real, () => {
      const existing = statRegularIfExists(real, name);
      if (!existing) throw new MemoryError(`the path ${name} does not exist`);
      // §4.3's decision table: delete is a covering rejection for hand-written
      // files (same class as write-overwrite/rename) — read the content INSIDE
      // the lock (matches doRename) so a concurrent write can't race provenance.
      const { text: body } = readRegular(real, name);
      if (isHandWritten(body)) {
        throw new MemoryError(
          `${name} is user-authored (no "source: agent"); edit it yourself, or add "source: agent" to its frontmatter first`,
        );
      }
      ensurePrivateDir(`${real}/${TRASH_DIR}`);
      const id = trashId();
      renameNoClobber(real, name, `${TRASH_DIR}/${id}-${name}`);
      pruneTrash(real);
      return `deleted ${name} (recoverable: /mem restore --trash ${id})`;
    });
  }

  function pruneTrash(real: string): void {
    const trashPath = `${real}/${TRASH_DIR}`;
    const { files } = listRegular(trashPath, { names: "legacy" });
    const sorted = files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // newest-name-first (ids sort lexically by time)
    for (const f of sorted.slice(TRASH_KEEP)) {
      try {
        renameNoClobber(trashPath, f.name, `.gone-${f.name}`);
      } catch {
        // best effort; a failed prune never blocks the delete itself
      }
    }
  }

  async function doRename(real: string, oldName: string, newName: string): Promise<string> {
    if (!isV2Name(newName))
      throw new MemoryError(`invalid memory file name ${JSON.stringify(newName)} — *.md only, no path separators`);
    return withMemoryDirLock(real, () => {
      const existing = statRegularIfExists(real, oldName);
      if (!existing) throw new MemoryError(`the path ${oldName} does not exist`);
      const { text: body } = readRegular(real, oldName);
      if (isHandWritten(body)) {
        throw new MemoryError(
          `${oldName} is user-authored (no "source: agent"); edit it yourself, or add "source: agent" to its frontmatter first`,
        );
      }
      renameNoClobber(real, oldName, newName);
      return `renamed ${oldName} -> ${newName}`;
    });
  }

  function doSearch(real: string, query: string): string {
    const files = readAllV2(real).map((f) => ({ name: f.name, body: f.body }));
    const hits = searchMemory(files, query);
    if (hits.length === 0) return `no matches for ${JSON.stringify(query)}`;
    return hits
      .map((h) => {
        const seg = h.section ? ` › ${h.section}` : "";
        const archived = h.archived ? " (archived)" : "";
        return `${h.file}${archived}${seg} › L${h.line}: ${h.text}`;
      })
      .join("\n");
  }

  return {
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_V2_TEXT.description,
    promptSnippet: MEMORY_TOOL_V2_TEXT.promptSnippet,
    promptGuidelines: [...MEMORY_TOOL_V2_TEXT.promptGuidelines],
    parameters: MemoryToolParamsV2,
    async execute(_toolCallId, rawParams: MemoryToolParamsV2, _signal, _onUpdate, ctx): Promise<ToolTextResult> {
      const cwd = resolveCwd(ctx);
      const normalized: NormalizedCall = normalizeMemoryCall(rawParams);
      const op = normalized.op;
      assertWritable(op);

      if (op === "search") {
        if (!normalized.query) throw new Error("search requires query");
        const dirs = readDirForView(cwd);
        if (!dirs) return text(`no matches for ${JSON.stringify(normalized.query)}`);
        return text(doSearch(dirs.real, normalized.query));
      }
      if (op === "view") {
        const display = memoryDirFor(cwd, deps.paths);
        // resolveMemoryFile is pure string handling (§4.2 rule 4) — it does not
        // need the directory to exist on disk, so the "directory vs. specific
        // file" distinction is made BEFORE touching the filesystem.
        const resolved = resolveMemoryFile(normalized.target, display);
        const dirs = readDirForView(cwd);
        if (resolved.kind === "dir") {
          if (!dirs) return text(`No memory for ${cwd} yet. Add *.md to ${display}/ or run /mem import.`);
          return text(renderDirectoryListing(cwd, dirs.real, deps, limits));
        }
        if (!dirs) throw new MemoryError(`the path ${resolved.name} does not exist`);
        const existing = readExisting(dirs.real, resolved.name);
        if (!existing) throw new MemoryError(`the path ${resolved.name} does not exist`);
        return text(
          renderViewFile(existing.text, {
            ...(normalized.viewRange === undefined ? {} : { viewRange: normalized.viewRange }),
            ...(normalized.section === undefined ? {} : { section: normalized.section }),
          }),
        );
      }

      // every remaining op writes — resolve the real directory + target name
      assertAllowWrite(true); // structural gate (R7); tool-level gate already ran (assertWritable)
      const { real } = requireDir(cwd);

      switch (op) {
        case "create": {
          const name = nameFor(normalized.target, real);
          if (normalized.body === undefined) throw new Error("create requires file_text (or content)");
          const out = await doCreate(real, name, normalized.body);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "str_replace": {
          const name = nameFor(normalized.target, real);
          const out = await doStrReplace(real, name, normalized.oldStr, normalized.newStr);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "insert": {
          const name = nameFor(normalized.target, real);
          const out = await doInsert(real, name, normalized.insertLine, normalized.section, normalized.body);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "delete": {
          const name = nameFor(normalized.target, real);
          const out = await doDelete(real, name);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "rename": {
          const oldName = nameFor(normalized.target, real);
          if (!normalized.dest) throw new Error("rename requires new_path");
          const newName = nameFor(normalized.dest, real);
          const out = await doRename(real, oldName, newName);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "write": {
          const name = nameFor(normalized.target, real);
          if (normalized.body === undefined) throw new Error('action:"write" requires file_text (or content)');
          const out = await doOverwrite(real, name, normalized.body);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        case "append": {
          const name = nameFor(normalized.target, real);
          if (normalized.body === undefined) throw new Error('action:"append" requires content (or insert_text)');
          const out = await doAppend(real, name, normalized.body);
          deps.onAfterWrite(cwd);
          return text(out);
        }
        default:
          throw new Error(`memory: unknown command ${String(op)}`);
      }
    },
  } as ToolDefinition;
}

function matchLineOf(body: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (body.charCodeAt(i) === 10) line++;
  }
  return line;
}
