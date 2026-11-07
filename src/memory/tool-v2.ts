/**
 * `memory` tool v2 — official-field-compatible surface (optimize-plan §4).
 * `createMemoryToolV2(deps)` builds the v2 `ToolDefinition`; `deps` matches
 * P0-b's frozen `MemoryToolV2Deps` shape exactly (index.ts already calls it
 * with `{settings, isChildSession, onAfterWrite}` — this file only ADDS
 * optional fields, never a required one, so that existing call stays valid).
 *
 * Cross-package dependency (§14.1: "P2 的块估算调用 P1 的 renderTiered") is
 * an injected port; production P5 wiring passes the real renderer for the T3
 * budget and v2 directory listing. The P3 doctor summary is also passed by
 * production wiring as a best-effort footer.
 */

import { randomBytes } from "node:crypto";
import { newTidyId } from "./tidy/manifest.js";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { MemoryOp, TieredRenderInput, TieredRenderResult } from "./contracts.js";
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
import { normalizeMemoryCall } from "./normalize.js";
import type { NormalizedCall } from "./contracts.js";
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
  unlinkRegular,
  writeTempRegular,
  type RegularRead,
  type RegularStat,
} from "./safe-fs.js";
import { searchMemory } from "./search.js";
import { computeBudgetReport, findExactDuplicates, type BudgetLimits } from "./budget.js";
import { assertAllowWrite, resolveMemoryFile } from "./store.js";
import { MEMORY_TOOL_V2_TEXT, MEMORY_TOOL_V2_TEXT_JEV, MemoryToolParamsV2 } from "./tool-surface.js";
import type { ClassifierRegistryLike, JevWritePort, MemEntry } from "./jev/contracts.js";

export interface MemoryToolV2Deps {
  writeGate?: import("./contracts.js").MemoryWriteGate;
  settings: MemorySettings;
  isChildSession: boolean;
  onAfterWrite: (cwd: string) => void;
  paths?: MemoryPaths;
  /** §14.1's sanctioned P1 dependency, injected as a port. */
  renderBlock?: (input: TieredRenderInput) => TieredRenderResult;
  /** P5's real P3 health port for directory-view summary. */
  doctorSummary?: (cwd: string) => string;
  /** Jev write port (jev-plan J5 / arch §6.2): write-after tagging + echo,
   *  user-order guard, inline-comment validation. `undefined` ⇒ every jev
   *  behavior below is compiled out and the output stays byte-identical
   *  (I9, pinned by tests/memory/jev/off-golden.test.ts). */
  jev?: JevWritePort;
  /** #26 (no-user-guard-confirm plan): the session lifecycle signal (a
   *  fresh AbortController per session_start, aborted on session_shutdown/
   *  reload — managed in wireMemory's closure). MAIN-session commit
   *  checkpoint; child sessions are never handed one (src/index.ts), so a
   *  child's commit signal is the tool signal alone. The tool captures it
   *  per call and concatenates it with the tool signal; touched>0 plans
   *  re-check it before and inside the directory lock. Never carried across
   *  sessions. */
  sessionSignal?: () => AbortSignal | undefined;
}

type ToolTextResult = {
  content: { type: "text"; text: string }[];
  details: undefined;
  /** Jev classify usage surfaced on the tool result (C-J12: carried verbatim
   *  on the tool_result event, not merged into main LLM accounting). The
   *  port's `calls` count has no field in pi's Usage shape — it stays visible
   *  via `/mem jev`'s usage line instead. */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
};

function text(t: string, usage?: ToolTextResult["usage"]): ToolTextResult {
  return usage === undefined
    ? { content: [{ type: "text" as const, text: t }], details: undefined }
    : { content: [{ type: "text" as const, text: t }], details: undefined, usage };
}

/** B3: worktree child sessions resolve back to the original repository cwd
 *  (same convention as the legacy tool, `tool.ts`). */
function resolveCwd(ctx: ExtensionContext | undefined): string {
  const raw = ctx?.cwd ?? process.cwd();
  return resolveWorktreeOrigin(raw) ?? raw;
}

const READ_ONLY_OPS = new Set<MemoryOp>(["view", "search"]);

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

// ───────────────────── jev write path (jev-plan J5 / arch §6.2) ─────────────────────

/** #26 (no-user-guard-confirm plan): the only remaining refusal on the
 *  touched>0 path — an abort checkpoint hit. No dialog, no refusal by
 *  mode (child/print/rpc all write through); only a cancelled call stays
 *  off disk. */
const ABORTED_GUARD = (name: string): string => `${name}: aborted before commit; file unchanged`;
/** Fixed timestamp for outside-lock guard drafts — never lands on disk; only
 *  entry content (frontmatter excluded by splitEntries) is ever compared. */
const DRAFT_ISO = "1970-01-01T00:00:00.000Z";

/** A committed write's echo pieces: `head` + jev echo lines + `voided user
 *  rule:` lines + `budgetLine` join with "\n"; without jev the composition is
 *  byte-identical to the pre-J5 strings (`head\n${budgetLine}`). */
interface WriteOutcome {
  readonly head: string;
  readonly budgetLine: string | undefined;
  /** In-lock pre-state of the file (exact base for afterWrite's hash diff). */
  readonly before: string | undefined;
  readonly after: string;
}

/** Result of the outside-lock guard phase (v4.1 §3.2; #26 removed the
 *  confirm — a hit now writes through). */
interface JevGuardPlan {
  /** Outside-read stat the in-lock re-read must still match. */
  readonly baseline: RegularStat | undefined;
  /** `voided user rule: <anchor>` lines appended to the committed write. */
  readonly voided: readonly string[];
  /** Bodyless entry ids (`#<ordinal> (L<start>-<end>)`) for the TUI notify —
   *  headings/bodies stay out of the notification channel (they may carry
   *  sensitive names, like the old remote card's exclusion). Skip plans
   *  carry an empty list. */
  readonly noticeIds: readonly string[];
  /** Every touched>0 plan carries the concatenated guard signal (main
   *  session: tool ∪ session; child session: tool only) that the in-lock
   *  phase re-checks right before touching disk. Skip plans omit it ⇒
   *  skip-path aborts never block a write. */
  readonly commitSignal?: AbortSignal;
}

function guardAnchor(entry: {
  file: string;
  heading?: string;
  ordinal: number;
  lineStart: number;
  lineEnd: number;
}): string {
  const where =
    entry.heading !== undefined
      ? `${entry.file} › ${entry.heading} #${entry.ordinal}`
      : `${entry.file} #${entry.ordinal}`;
  return `${where} (L${entry.lineStart}-${entry.lineEnd})`;
}

/** Bodyless notify id — ordinal + line range only. Deliberately NOT the
 *  guardAnchor: headings come from user prose (jev/entries.ts headingLabel)
 *  and may carry sensitive names. */
function noticeId(entry: { ordinal: number; lineStart: number; lineEnd: number }): string {
  return `#${entry.ordinal} (L${entry.lineStart}-${entry.lineEnd})`;
}

/** In-lock abort checkpoint (#26): a touched>0 write must not touch disk
 *  once its commit signal fired (e.g. while waiting for the lock). */
function assertCommitNotAborted(signal: AbortSignal | undefined, name: string): void {
  if (signal !== undefined && signal.aborted) throw new MemoryError(ABORTED_GUARD(name));
}

/** Concatenate the tool signal with the session lifecycle signal (plan
 *  Major #2/#3). `AbortSignal.any` needs ≥Node 20 (engines pin ≥22).
 *  #36 P4: shared with tool-v3.ts (exported unchanged). */
export function concatGuardSignals(
  tool: AbortSignal | undefined,
  session: AbortSignal | undefined,
): AbortSignal | undefined {
  if (tool === undefined) return session;
  if (session === undefined) return tool;
  if (tool.aborted || session.aborted) return AbortSignal.abort();
  try {
    return AbortSignal.any([tool, session]);
  } catch {
    return tool;
  }
}

/** #36 P4: registry resolution shared with tool-v3.ts — arch §5.3
 *  off(pi-api): the registry must actually carry the classifier API; an
 *  object without `classify`/`getAvailableOfType` is runtime-off, not a
 *  callable port (verifier minor #3). Module scope (pure). */
export function registryOf(ctx: ExtensionContext | undefined): ClassifierRegistryLike | undefined {
  const registry = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry;
  if (registry === undefined || registry === null) return undefined;
  const r = registry as Record<string, unknown>;
  if (typeof r.classify !== "function" || typeof r.getAvailableOfType !== "function") return undefined;
  return registry as ClassifierRegistryLike;
}

/** Archived judgment shared with entries.ts `EntryIndex.splitFile`
 * (`meta.status === "archived"`) — reused, not re-parsed, per the ruling. */
function isArchivedContent(content: string, name: string): boolean {
  return parseMemoryMeta(content, name.replace(/\.md$/, "")).meta.status === "archived";
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
  if (deps.doctorSummary) {
    try {
      footerParts.push(deps.doctorSummary(cwd));
    } catch {
      // health summary is best effort and must not make view fail
    }
  }
  const footer = footerParts.length > 0 ? `\n${footerParts.join(" · ")}` : "";
  return `Memory for ${cwd} (${toSlug(cwd)}):\n${lines.join("\n")}${footer}`;
}

// ───────────────────────────── view (single file) ─────────────────────────────

function numberedLines(lines: readonly string[], from: number, to: number): string {
  // Gutter width tracks the largest displayed number (like `cat -n`) instead of
  // a fixed 6 — a 13-line file must not show "     7".
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${String(i).padStart(width, " ")}\t${lines[i - 1] ?? ""}`);
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

/** `.trash` id in the exact shape `safe-fs` TRASH_NAME_RE and
 *  `tidy/manifest` listTrashEntries accept (ms-precision stamp + 6 hex) —
 *  the previous local stamp dropped the milliseconds and used base36, so
 *  `/mem restore --trash` never listed tool/review deletions. */
function trashId(): string {
  return newTidyId(new Date(), process.pid, randomBytes(3).toString("hex"));
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
    if (deps.writeGate && !(deps.writeGate.bootstrap?.(display) ?? deps.writeGate.check(display)).ok)
      throw new MemoryError("writes not allowed");
    ensureMemoryDir(display);
    deps.writeGate?.capture(display);
    if (deps.writeGate && !deps.writeGate.check(display).ok) throw new MemoryError("writes not allowed");
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
    // Checked BEFORE resolveMemoryFile (which rejects separators with its own
    // generic message): a block-subtree target gets the curated pointer.
    const stem = target === undefined ? "" : target.replace(/^\/+/, "").replace(/^memories\//, "");
    if (stem === "blocks" || stem.startsWith("blocks/")) {
      throw new MemoryError(
        "E_BLOCKS_DIR: this path is inside the block layout — /reload so the v3 block tool (view/create/update/delete) replaces this one",
      );
    }
    const resolved = resolveMemoryFile(target, real);
    if (resolved.kind === "dir") throw new MemoryError("this command requires a file path (a directory was given)");
    return resolved.name;
  }

  function assertWritable(op: MemoryOp): void {
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

  function budgetLineFor(
    cwd: string,
    real: string,
    name: string,
    newBody: string,
    duplicateSourceLines: readonly string[],
  ): string {
    const files = readAllV2(real);
    const core = determinePrimaryCore(files);
    const isCore = isCoreFile(name, files);
    const corpus = corpusExcept(real, name);
    const duplicates = findExactDuplicates(duplicateSourceLines, corpus);
    const blockInput: TieredRenderInput = {
      cwd,
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

  // ── jev write path helpers (all no-ops without deps.jev — I9) ──

  /** Guard phase 3 (v4.1 §3.2): inside the lock, the file must still match
   *  the stat the guard plan was computed from. */
  function assertGuardBaseline(name: string, fresh: RegularStat | undefined, baseline: RegularStat | undefined): void {
    if (baseline === undefined) return;
    if (!statsEqual(baseline, fresh)) {
      throw new MemoryError(`${name} changed concurrently; view and retry`);
    }
  }

  /** In-lock inline-authority validation: a write that would NEWLY break an
   *  inline comment rejects (arch §6.2.5); pre-existing errors stay
   *  doctor-only (D18), same policy as frontmatter errors. */
  function assertInlineOk(name: string, before: string | undefined, after: string): void {
    const err = deps.jev?.checkInline(name, before, after);
    if (err !== undefined) throw new MemoryError(err);
  }

  /** Outside-lock draft of the final content, mirroring each op's in-lock
   *  transformation (frontmatter upserts included, timestamp differs —
   *  splitEntries ignores frontmatter so guard pairing is unaffected).
   *  `undefined` ⇒ the op will throw its own error in-lock; skip the guard. */
  function draftFinalContent(
    op: MemoryOp,
    normalized: NormalizedCall,
    existing: RegularRead | undefined,
  ): string | undefined {
    const upsertAgent = (content: string): string =>
      upsertFrontmatterFields(content, { source: "agent", updated: DRAFT_ISO });
    const handWritten = existing !== undefined && isHandWritten(existing.text);
    try {
      switch (op) {
        case "create":
          return upsertAgent(normalized.body ?? "");
        case "write": {
          if (existing !== undefined && handWritten) return undefined; // in-lock provenance refusal
          return upsertAgent(normalized.body ?? "");
        }
        case "str_replace": {
          if (existing === undefined || normalized.oldStr === undefined) return undefined;
          if (findStrReplaceMatches(existing.text, normalized.oldStr).length !== 1) return undefined;
          const i = existing.text.indexOf(normalized.oldStr);
          const replaced =
            existing.text.slice(0, i) + (normalized.newStr ?? "") + existing.text.slice(i + normalized.oldStr.length);
          return handWritten ? replaced : upsertAgent(replaced);
        }
        case "insert": {
          if (existing === undefined || normalized.body === undefined) return undefined;
          const target = resolveInsertTarget(existing.text, {
            ...(normalized.insertLine === undefined ? {} : { insertLine: normalized.insertLine }),
            ...(normalized.section === undefined ? {} : { section: normalized.section }),
          });
          const lines = existing.text.split("\n");
          const inserted = [
            ...lines.slice(0, target.afterLine),
            ...normalized.body.split("\n"),
            ...lines.slice(target.afterLine),
          ].join("\n");
          return handWritten ? inserted : upsertAgent(inserted);
        }
        case "append": {
          const needsNewline = existing !== undefined && existing.stat.size > 0 && !existing.text.endsWith("\n");
          const combined = (existing?.text ?? "") + (needsNewline ? "\n" : "") + (normalized.body ?? "");
          if (handWritten) return combined;
          // With jev on, append refreshes `updated` / stamps `source: agent`
          // on the files it creates (arch §6.2.5) — mirror the in-lock rule.
          return deps.jev === undefined ? combined : upsertAgent(combined);
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  /** Guard phase 1 (v4.1 §3.2, #26 confirm-free): compute touched user entries outside the
   *  lock and hand the in-lock phase a baseline stat + notice ids; throws
   *  only on a pre-lock abort. `undefined` means "no jev / nothing to
   *  guard" (skip plan: no commit signal, abort never blocks). */
  async function prepareJevGuard(
    real: string,
    name: string,
    op: MemoryOp,
    normalized: NormalizedCall,
    ctx: ExtensionContext | undefined,
    call: { signal: AbortSignal | undefined; toolCallId: string } = { signal: undefined, toolCallId: "" },
  ): Promise<JevGuardPlan | undefined> {
    const jev = deps.jev;
    if (jev === undefined) return undefined;
    const skip: JevGuardPlan = { baseline: undefined, voided: [], noticeIds: [] };
    const preRead = readExisting(real, name);
    // Ops the in-lock phase refuses anyway — don't draft a doomed write.
    if (op === "create" && preRead !== undefined) return skip;
    if (op === "write" && preRead !== undefined && isHandWritten(preRead.text)) return skip;
    const draft = draftFinalContent(op, normalized, preRead);
    if (draft === undefined) return skip;
    const handWritten = preRead !== undefined && isHandWritten(preRead.text);
    const touched = [...jev.touchedUserEntries(name, preRead?.text ?? "", draft, handWritten)];
    // Whole-file retirement guards (rework rounds 2–3, root rulings):
    //
    // 1) provenance flip — a write that turns a hand-written file into an
    //    `source: agent` file (e.g. inserting a `---\nsource: agent\n---`
    //    block at line 0 / offset 0 — allowed because frontmatter protections
    //    only apply to EXISTING blocks) silently demotes every default-user
    //    entry to agent authority and unlocks provenance-refused delete/write.
    //    `source` is the ONLY file-level authority input, so this single check
    //    covers every authority-derivation flip (inline `user`/`lesson` edits
    //    are already caught by guardHash pairing — they change the raw hash).
    //
    // 2) archive flip — un-archived → `status: archived` retires the file's
    //    entries from the index and injection (same archived judgment as
    //    entries.ts `EntryIndex.splitFile`: `meta.status === "archived"`),
    //    which voids user orders even though the file stays on disk. The
    //    REVERSE (un-archiving) restores visibility and needs no confirm.
    const hwFlip = handWritten && !isHandWritten(draft);
    const archiveFlip =
      (preRead === undefined || !isArchivedContent(preRead.text, name)) && isArchivedContent(draft, name);
    if (hwFlip || archiveFlip) {
      // Either flip retires the before-file's user orders wholesale (authority
      // demotion / index-and-injection removal) — merge the full user set
      // into `touched` (deduped by guardHash against text-level touches).
      const seen = new Set(touched.map((e) => e.guardHash));
      for (const e of jev.touchedUserEntries(name, preRead?.text ?? "", "", handWritten)) {
        if (!seen.has(e.guardHash)) {
          touched.push(e);
          seen.add(e.guardHash);
        }
      }
    }
    if (touched.length === 0) return skip;
    // Abort checkpoint 1 (#26): a call already cancelled before the lock is
    // taken never reaches disk (the pre-#26 confirm refusal's only survivor).
    assertCommitNotAborted(call.signal, name);
    return {
      baseline: preRead?.stat,
      voided: touched.map((e) => `voided user rule: ${guardAnchor(e)}`),
      noticeIds: touched.map((e) => noticeId(e)),
      ...(call.signal === undefined ? {} : { commitSignal: call.signal }),
    };
  }

  /** Delete-specific guard variant (v4.1 §3.2, #26 confirm-free): `after =
   *  ""` makes the file's user-authority entries ALL count as touched, so
   *  deleting an agent-created file that carries `<!-- mem user -->` entries
   *  carries voided echoes + the notify. Hand-written files skip — doDelete
   *  refuses them on provenance grounds anyway. Rename never guards
   *  (hygiene-plan §3.2 "rename 不改内容"). */
  async function prepareJevDeleteGuard(
    real: string,
    name: string,
    ctx: ExtensionContext | undefined,
    call: { signal: AbortSignal | undefined; toolCallId: string } = { signal: undefined, toolCallId: "" },
  ): Promise<JevGuardPlan | undefined> {
    const jev = deps.jev;
    if (jev === undefined) return undefined;
    const skip: JevGuardPlan = { baseline: undefined, voided: [], noticeIds: [] };
    const preRead = readExisting(real, name);
    if (preRead === undefined) return skip; // doDelete: "does not exist"
    if (isHandWritten(preRead.text)) return skip; // doDelete: provenance refusal
    const touched = jev.touchedUserEntries(name, preRead.text, "", false);
    if (touched.length === 0) return skip;
    // Abort checkpoint 1 (#26) — same as the edit path.
    assertCommitNotAborted(call.signal, name);
    return {
      baseline: preRead.stat,
      voided: touched.map((e) => `voided user rule: ${guardAnchor(e)}`),
      noticeIds: touched.map((e) => noticeId(e)),
      ...(call.signal === undefined ? {} : { commitSignal: call.signal }),
    };
  }

  /** #26: the one-line TUI warning after a committed user-rule change. Only
   *  the MAIN session with a UI gets it (child sessions/print stay silent —
   *  rpc's notify is fire-and-forget and dropped by the hub); every mode
   *  still sees the `voided user rule:` echo in the tool result. Listing is
   *  capped at 10 bodyless ids; a notify crash never fails the committed
   *  write. Called ONLY on commit success (CAS/match/abort/limit failures
   *  stay silent). */
  function notifyUserRuleChange(
    ctx: ExtensionContext | undefined,
    kind: "edit" | "delete",
    name: string,
    plan: JevGuardPlan | undefined,
  ): void {
    if (plan === undefined || plan.noticeIds.length === 0) return;
    if (deps.isChildSession || ctx?.hasUI !== true) return;
    const ui = ctx?.ui as { notify?: unknown } | undefined;
    if (typeof ui?.notify !== "function") return;
    const n = plan.noticeIds.length;
    const head =
      kind === "delete"
        ? `agent 删除了 ${name}，其中 ${n} 条用户令随之作废（文件已移入 .trash，可用 /mem restore --trash 找回）：`
        : `agent 改动了 ${name} 中的 ${n} 条用户令（已直接写入，未经确认）：`;
    const listed = plan.noticeIds.slice(0, 10).map((id) => `- 条目 ${id}`);
    if (n > 10) listed.push(`- …另有 ${n - 10} 条（见工具结果）`);
    try {
      (ui.notify as (message: string, level?: "info" | "warning" | "error") => void)(
        [head, ...listed].join("\n"),
        "warning",
      );
    } catch {
      // never fail a committed write on a notify error
    }
  }

  function composeOutcome(out: WriteOutcome, jevEcho: readonly string[], voided: readonly string[]): string {
    const parts = [out.head];
    if (jevEcho.length > 0) parts.push(jevEcho.join("\n"));
    if (voided.length > 0) parts.push(voided.join("\n"));
    if (out.budgetLine !== undefined) parts.push(out.budgetLine);
    return parts.join("\n");
  }

  /** Post-commit phase (arch §6.2.1): outside the lock, tag the changed
   *  entries and splice the §6.2.4 echo before the budget line. A port crash
   * degrades to the plain echo — the write itself already succeeded. */
  async function finishJevWrite(
    cwd: string,
    name: string,
    out: WriteOutcome,
    plan: JevGuardPlan | undefined,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext | undefined,
  ): Promise<ToolTextResult> {
    const jev = deps.jev;
    if (jev === undefined) return text(composeOutcome(out, [], []));
    let echo: readonly string[] = [];
    let usage: { costUsd: number; calls: number } | undefined;
    try {
      const result = await jev.afterWrite({
        cwd,
        file: name,
        before: out.before,
        after: out.after,
        ...(signal === undefined ? {} : { signal }),
        registry: registryOf(ctx),
      });
      echo = result.echo;
      usage = result.usage;
    } catch {
      echo = []; // frozen contract: afterWrite never rejects — belt and braces
    }
    const composed = composeOutcome(out, echo, plan?.voided ?? []);
    if (usage !== undefined && usage.calls > 0) {
      return text(composed, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costUsd },
      });
    }
    return text(composed);
  }

  async function doCreate(
    cwd: string,
    real: string,
    name: string,
    fileText: string,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    assertWithinWriteLimit(fileText, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
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
      assertGuardBaseline(name, existing, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
      assertInlineOk(name, undefined, finalContent);
      const tmp = writeTempRegular(real, name, Buffer.from(finalContent, "utf8"), 0o600);
      createExclusive(real, tmp, name);
      const budgetLine = budgetLineFor(cwd, real, name, finalContent, finalContent.split("\n"));
      return {
        head: `created ${name} (${formatSize(Buffer.byteLength(finalContent, "utf8"))})`,
        budgetLine,
        before: undefined,
        after: finalContent,
      };
    });
  }

  async function doStrReplace(
    cwd: string,
    real: string,
    name: string,
    oldStr: string | undefined,
    newStr: string | undefined,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    if (oldStr === undefined) throw new Error("str_replace requires old_str");
    assertWithinWriteLimit(newStr ?? "", settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
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
      assertGuardBaseline(name, existing.stat, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
      assertInlineOk(name, existing.text, finalContent);
      commitReplace(real, name, existing.stat, Buffer.from(finalContent, "utf8"), existing.stat.mode & 0o777);
      const snippet = renderSnippet(finalContent, matchLineOf(finalContent, matchIndex));
      const newLines = (newStr ?? "").split("\n");
      const budgetLine = budgetLineFor(cwd, real, name, finalContent, newLines);
      const warn = handWritten ? "⚠ edited a user-authored file; frontmatter left untouched\n" : "";
      return {
        head: `${warn}edited ${name}:\n${snippet}`,
        budgetLine,
        before: existing.text,
        after: finalContent,
      };
    });
  }

  async function doInsert(
    cwd: string,
    real: string,
    name: string,
    insertLine: number | undefined,
    section: string | undefined,
    insertText: string | undefined,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    if (insertText === undefined) throw new Error("insert requires insert_text (or content)");
    assertWithinWriteLimit(insertText, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
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
      assertGuardBaseline(name, existing.stat, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
      assertInlineOk(name, existing.text, finalContent);
      commitReplace(real, name, existing.stat, Buffer.from(finalContent, "utf8"), existing.stat.mode & 0o777);
      const snippet = renderSnippet(finalContent, target.afterLine + 1);
      const budgetLine = budgetLineFor(cwd, real, name, finalContent, insertLines);
      const warn = handWritten ? "⚠ edited a user-authored file; frontmatter left untouched\n" : "";
      const noteLine = target.note ? `${target.note}\n` : "";
      return {
        head: `${warn}${noteLine}edited ${name}:\n${snippet}`,
        budgetLine,
        before: existing.text,
        after: finalContent,
      };
    });
  }

  async function doOverwrite(
    cwd: string,
    real: string,
    name: string,
    body: string,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    assertWithinWriteLimit(body, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
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
      assertGuardBaseline(name, existing?.stat, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
      assertInlineOk(name, existing?.text, finalContent);
      const mode = existing ? existing.stat.mode & 0o777 : 0o600;
      commitReplace(real, name, existing?.stat, Buffer.from(finalContent, "utf8"), mode);
      const budgetLine = budgetLineFor(cwd, real, name, finalContent, finalContent.split("\n"));
      return {
        head: `wrote ${name} (${formatSize(Buffer.byteLength(finalContent, "utf8"))})`,
        budgetLine,
        before: existing?.text,
        after: finalContent,
      };
    });
  }

  async function doAppend(
    cwd: string,
    real: string,
    name: string,
    content: string,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<WriteOutcome> {
    assertWithinWriteLimit(content, settings.maxWriteBytes);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
      const existing = readExisting(real, name);
      const handWritten = existing !== undefined && isHandWritten(existing.text);
      const needsNewline = existing !== undefined && existing.stat.size > 0 && !existing.text.endsWith("\n");
      const appended = (needsNewline ? "\n" : "") + content;
      const combined = (existing?.text ?? "") + appended;
      // arch §6.2.5: with jev on, append refreshes `updated` on agent files
      // and stamps `source: agent` on the file it creates. Hand-written files
      // keep the untouched-frontmatter behavior; without a port the bytes are
      // exactly the pre-J5 ones (I9).
      const finalContent =
        !handWritten && deps.jev !== undefined
          ? upsertFrontmatterFields(combined, { source: "agent", updated: new Date().toISOString() })
          : combined;
      assertWithinFileByteCap(name, finalContent, settings.maxFileBytes);
      assertNoNewFrontmatterErrors(name, existing?.text ?? "", finalContent);
      const isCore = isCoreFile(name, readAllV2(real));
      assertWithinHardLimit(name, isCore, finalContent, existing?.stat.size ?? 0, limits);
      assertGuardBaseline(name, existing?.stat, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
      assertInlineOk(name, existing?.text, finalContent);
      const mode = existing ? existing.stat.mode & 0o777 : 0o600;
      commitReplace(real, name, existing?.stat, Buffer.from(finalContent, "utf8"), mode);
      const budgetLine = budgetLineFor(cwd, real, name, finalContent, content.split("\n"));
      const warn = handWritten ? "⚠ appended to a user-authored file; frontmatter left untouched\n" : "";
      return {
        head: `${warn}appended to ${name} (+${formatSize(Buffer.byteLength(appended, "utf8"))}, total ${formatSize(Buffer.byteLength(finalContent, "utf8"))})`,
        budgetLine,
        before: existing?.text,
        after: finalContent,
      };
    });
  }

  async function doDelete(
    real: string,
    name: string,
    guardBaseline?: RegularStat,
    commitSignal?: AbortSignal,
  ): Promise<string> {
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
      const existing = statRegularIfExists(real, name);
      if (!existing) throw new MemoryError(`the path ${name} does not exist`);
      // Guard phase 3 (v4.1 §3.2 — delete guards too): the file must still
      // match the stat the delete plan was computed from.
      assertGuardBaseline(name, existing, guardBaseline);
      assertCommitNotAborted(commitSignal, name);
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
        unlinkRegular(trashPath, f.name);
      } catch {
        // best effort; a failed prune never blocks the delete itself
      }
    }
  }

  async function doRename(real: string, oldName: string, newName: string): Promise<string> {
    if (!isV2Name(newName))
      throw new MemoryError(`invalid memory file name ${JSON.stringify(newName)} — *.md only, no path separators`);
    return withMemoryDirLock(real, () => {
      if (deps.writeGate && !deps.writeGate.check(real).ok) throw new MemoryError("writes not allowed");
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
    // jev on ⇒ only the DESCRIPTION swaps to the §9.3 variant (schema,
    // snippet and guidelines stay shared — arch §9.3 "只换描述").
    description: deps.jev === undefined ? MEMORY_TOOL_V2_TEXT.description : MEMORY_TOOL_V2_TEXT_JEV.description,
    promptSnippet: MEMORY_TOOL_V2_TEXT.promptSnippet,
    promptGuidelines: [...MEMORY_TOOL_V2_TEXT.promptGuidelines],
    parameters: MemoryToolParamsV2,
    async execute(toolCallId, rawParams: MemoryToolParamsV2, signal, _onUpdate, ctx): Promise<ToolTextResult> {
      const cwd = resolveCwd(ctx);
      // #26: the commit signal concatenates the tool signal with the
      // session lifecycle signal (captured per call — the session controller
      // is swapped on session_start and aborted on shutdown/reload, never
      // carried across sessions).
      const guardSignal = concatGuardSignals(signal, deps.sessionSignal?.());
      const call = { signal: guardSignal, toolCallId };
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
      assertAllowWrite(deps.writeGate ? deps.writeGate.check(memoryDirFor(cwd, deps.paths)).ok : true); // structural gate (R7); tool-level gate already ran (assertWritable)
      const { real } = requireDir(cwd);

      switch (op) {
        case "create": {
          const name = nameFor(normalized.target, real);
          if (normalized.body === undefined) throw new Error("create requires file_text (or content)");
          const plan = await prepareJevGuard(real, name, op, normalized, ctx, call);
          const out = await doCreate(cwd, real, name, normalized.body, plan?.baseline, plan?.commitSignal);
          notifyUserRuleChange(ctx, "edit", name, plan);
          deps.onAfterWrite(cwd);
          return finishJevWrite(cwd, name, out, plan, signal, ctx);
        }
        case "str_replace": {
          const name = nameFor(normalized.target, real);
          const plan = await prepareJevGuard(real, name, op, normalized, ctx, call);
          const out = await doStrReplace(
            cwd,
            real,
            name,
            normalized.oldStr,
            normalized.newStr,
            plan?.baseline,
            plan?.commitSignal,
          );
          notifyUserRuleChange(ctx, "edit", name, plan);
          deps.onAfterWrite(cwd);
          return finishJevWrite(cwd, name, out, plan, signal, ctx);
        }
        case "insert": {
          const name = nameFor(normalized.target, real);
          const plan = await prepareJevGuard(real, name, op, normalized, ctx, call);
          const out = await doInsert(
            cwd,
            real,
            name,
            normalized.insertLine,
            normalized.section,
            normalized.body,
            plan?.baseline,
            plan?.commitSignal,
          );
          notifyUserRuleChange(ctx, "edit", name, plan);
          deps.onAfterWrite(cwd);
          return finishJevWrite(cwd, name, out, plan, signal, ctx);
        }
        case "delete": {
          const name = nameFor(normalized.target, real);
          const plan = await prepareJevDeleteGuard(real, name, ctx, call);
          const out = await doDelete(real, name, plan?.baseline, plan?.commitSignal);
          notifyUserRuleChange(ctx, "delete", name, plan);
          deps.onAfterWrite(cwd);
          const voided = plan?.voided ?? [];
          return text(voided.length === 0 ? out : `${out}\n${voided.join("\n")}`);
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
          const plan = await prepareJevGuard(real, name, op, normalized, ctx, call);
          const out = await doOverwrite(cwd, real, name, normalized.body, plan?.baseline, plan?.commitSignal);
          notifyUserRuleChange(ctx, "edit", name, plan);
          deps.onAfterWrite(cwd);
          return finishJevWrite(cwd, name, out, plan, signal, ctx);
        }
        case "append": {
          const name = nameFor(normalized.target, real);
          if (normalized.body === undefined) throw new Error('action:"append" requires content (or insert_text)');
          const plan = await prepareJevGuard(real, name, op, normalized, ctx, call);
          const out = await doAppend(cwd, real, name, normalized.body, plan?.baseline, plan?.commitSignal);
          notifyUserRuleChange(ctx, "edit", name, plan);
          deps.onAfterWrite(cwd);
          return finishJevWrite(cwd, name, out, plan, signal, ctx);
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
