// Pure, pi-independent memory store: list / write / append / CC-import.
// Ported from @getpipher/armory-memory's memory-store.ts with the plan's
// hardening applied (方案 §5.3/§5.4): per-entry TOCTOU guards, byte-accurate
// limits (Buffer.byteLength, not string.length), 0600 files / 0700 dirs, the
// structural allowWrite gate (R7), and agent provenance frontmatter on write.
//
// todo #22 optimize-plan P0-b: every fs primitive now routes through
// `safe-fs.ts` (§3.1's file-level-symlink refusal + canonicalized-directory
// trust) instead of calling `node:fs` directly — this file has zero fs
// imports (enforced by `tests/memory/fs-guard.test.ts`). `importProject` /
// `importAll` are now `async` and run inside `withMemoryDirLock` (§3.3);
// every other function's SUCCESSFUL-PATH behavior is byte-identical to
// #22-before (legacy golden, `tests/memory/legacy-golden.test.ts`) — the one
// deliberate deviation is that a file-level symlink inside the memory dir is
// now refused/skipped instead of followed (§2.7's decision N2).
//
// Zero pi/typebox imports; independently unit-testable.

import { dirname, join, resolve } from "node:path";
import { upsertFrontmatterFields } from "./frontmatter.js";
import { MemoryError, memoryDirFor, defaultPaths, type MemoryPaths } from "./paths.js";
import {
  appendLegacy,
  canonicalDir,
  createExclusive,
  ensureMemoryDir,
  isDirFollowOutside,
  listDirNames,
  listRegular,
  readRegular,
  replaceAtomic,
  statRegularIfExists,
  writeInPlaceLegacy,
  writeTempRegular,
  type RegularRead,
} from "./safe-fs.js";
import { withMemoryDirLock } from "./lock.js";

export interface MemoryFile {
  name: string; // filename, e.g. "playbook.md"
  path: string; // absolute path
  size: number; // bytes
  mtimeMs: number; // ms epoch
}

/** List *.md memory files for a cwd, newest-first. Empty array if none /
 *  missing / unreadable. A file-level symlink (or any other non-regular
 *  entry) is skipped, not fatal (方案 §5.1.6 TOCTOU / §2.7 决策 N2).
 *
 *  P0-b 打回修复（§3.1）：listing is a READ, so it goes through the
 *  canonicalized (real) slug directory like every other fs primitive here —
 *  a slug directory that is itself a symlink (§3.1's trusted trust model)
 *  must list its REAL target, not silently see an empty/missing dir at the
 *  display path. A missing/non-directory display path falls back to the
 *  display path itself, which `listRegular` already turns into `[]` on a
 *  failed `readdir` (unchanged behavior for the non-symlink case). */
export function listMemory(cwd: string, paths?: MemoryPaths): MemoryFile[] {
  const display = memoryDirFor(cwd, paths);
  const canon = canonicalDir(display);
  const dir = canon ? canon.real : display;
  const { files } = listRegular(dir, { names: "legacy" });
  return files
    .map((f) => ({ name: f.name, path: f.path, size: f.size, mtimeMs: f.mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
}

// ───────────────────────────── write / append ─────────────────────────────

export interface WriteOptions {
  append?: boolean;
  /** 结构性写闸门（R7）：false 时抛 MemoryError("writes not allowed")。调用方必须显式传 true；工具层按 isChildSession/settings 计算。 */
  allowWrite: boolean;
  maxWriteBytes: number;
  maxFileBytes: number;
  /** 测试确定性注入；缺省 new Date().toISOString()。 */
  nowIso?: string;
}

/** bytesWritten = 用户 content 的 UTF-8 字节（不含自动 provenance frontmatter）；totalBytes = 落盘后文件实际字节（R10 钉死）。 */
export interface WriteResult {
  path: string;
  bytesWritten: number;
  totalBytes: number;
  created: boolean;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/** R7 结构性写闸门：调用方必须显式传 true，否则拒绝（方案 §5.3）。
 *  P0-b：从 `writeMemoryFile` 内联的同款检查抽出并导出（方案 §14.1），供 tool-v2/edit/search
 *  （P2）复用同一道闸门，不各自写一份。行为与现有内联检查完全一致（同一错误消息）。 */
export function assertAllowWrite(allowWrite: boolean): void {
  if (allowWrite !== true) throw new MemoryError("writes not allowed");
}

const MEMORIES_PREFIX = "/memories/";

export type MemoryFileTarget = { kind: "dir" } | { kind: "file"; name: string };

/**
 * Normalize a v2-tool-surface `path`/`name` value into either "the directory
 * itself" or a single in-fence file name (方案 §4.2 第 4 条). P0-b: extracted
 * from `store.ts`'s own write-path fence so P2's `normalizeMemoryCall` can
 * reuse the SAME fence instead of redefining it (§14.1) — not yet called by
 * anything in P0-b's own legacy path (`tool.ts` is untouched, 复审 新-3).
 *
 * A leading `/memories/` prefix is stripped first; the empty string,
 * `/memories`, `/memories/`, or `undefined` all mean "the directory itself".
 * Anything else must pass BOTH `NAME_RE` (the same `*.md` whitelist
 * `writeMemoryFile` enforces) AND `dirname(resolve(dir, name)) === resolve(dir)`
 * (belt-and-suspenders against any future `NAME_RE` gap letting a path
 * separator / `..` segment through) — a violation throws `MemoryError`,
 * never silently degrades to "treat as directory".
 */
export function resolveMemoryFile(pathOrName: string | undefined, dir: string): MemoryFileTarget {
  const raw = pathOrName ?? "";
  const stripped = raw.startsWith(MEMORIES_PREFIX) ? raw.slice(MEMORIES_PREFIX.length) : raw;
  if (stripped === "" || stripped === "/memories" || stripped === "/memories/") return { kind: "dir" };
  if (!NAME_RE.test(stripped)) {
    throw new MemoryError(`invalid memory path ${JSON.stringify(raw)} — *.md only, no path separators`);
  }
  const base = resolve(dir);
  const resolved = resolve(base, stripped);
  if (dirname(resolved) !== base) {
    throw new MemoryError(`invalid memory path ${JSON.stringify(raw)} — escapes the memory directory`);
  }
  return { kind: "file", name: stripped };
}

function tryReadExisting(dir: string, name: string): RegularRead | undefined {
  try {
    return readRegular(dir, name);
  } catch (err) {
    if (err instanceof MemoryError) throw err; // symlink / non-regular: reject the write, don't silently treat as absent
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Write (replace) or append a single memory file under memoryDirFor(cwd).
 *
 * Safety model（方案 §5.3, P0-b: §3）：目录围栏（仅 memoryDirFor(cwd) 内 *.md，
 * 文件名白名单正则 + resolve 双保险）、体积双上限、0600/0700、结构性
 * allowWrite 闸门、canonicalized-directory 信任（slug 目录 symlink 允许，
 * 目录内文件级 symlink 一律拒绝）。write 自动 upsert provenance frontmatter
 * （source: agent + updated）；append 是纯 append-only 追加、绝不动
 * frontmatter（R4 原子性取舍）。
 *
 * All violations throw MemoryError — callers (the tool layer) translate to
 * thrown Error per repo convention (Nit 13).
 */
export function writeMemoryFile(
  cwd: string,
  name: string,
  content: string,
  opts: WriteOptions,
  paths?: MemoryPaths,
): WriteResult {
  assertAllowWrite(opts.allowWrite);
  if (!NAME_RE.test(name)) {
    throw new MemoryError(`invalid memory file name ${JSON.stringify(name)} — *.md only, no path separators`);
  }
  const display = memoryDirFor(cwd, paths);
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > opts.maxWriteBytes) {
    throw new MemoryError(
      `content is ${contentBytes}B, over the per-write limit of ${opts.maxWriteBytes}B — split it into smaller writes`,
    );
  }
  ensureMemoryDir(display);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const dir = canon.real;

  if (opts.append) {
    // Pure append: never read-modify-write the file's frontmatter (R4 —
    // concurrent appends must not clobber each other's provenance).
    const existingFile = tryReadExisting(dir, name);
    const existingBytes = existingFile ? existingFile.stat.size : 0;
    const needsNewline = existingFile !== undefined && existingBytes > 0 && !existingFile.text.endsWith("\n");
    const appended = (needsNewline ? "\n" : "") + content;
    const appendedBytes = Buffer.byteLength(appended, "utf8");
    if (existingBytes + appendedBytes > opts.maxFileBytes) {
      throw new MemoryError(
        `append would grow ${name} to ${existingBytes + appendedBytes}B, over the ${opts.maxFileBytes}B file cap`,
      );
    }
    const created = existingFile === undefined;
    const { totalBytes } = appendLegacy(dir, name, Buffer.from(appended, "utf8"));
    return { path: join(dir, name), bytesWritten: contentBytes, totalBytes, created };
  }

  // write (replace): upsert agent provenance into the NEW content（方案 §5.3 矩阵）。
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const finalContent = upsertFrontmatterFields(content, { source: "agent", updated: nowIso });
  const finalBytes = Buffer.byteLength(finalContent, "utf8");
  if (finalBytes > opts.maxFileBytes) {
    throw new MemoryError(`write would make ${name} ${finalBytes}B, over the ${opts.maxFileBytes}B file cap`);
  }
  const existedStat = statRegularIfExists(dir, name); // throws for a symlinked/non-regular target (N2)
  writeInPlaceLegacy(dir, name, Buffer.from(finalContent, "utf8"));
  return {
    path: join(dir, name),
    bytesWritten: contentBytes,
    totalBytes: finalBytes,
    created: existedStat === undefined,
  };
}

// ───────────────────────────── Import (CC → Pi) ─────────────────────────────

/** Prepended to imported files; 出处文案更新为 pi-toolkit（方案 §5.4）。剥离
 *  正则只锚 `**pi copy**` 前缀，旧文案 header 双向兼容（见 render.ts）。 */
export const DRIFT_HEADER =
  "> **pi copy** — imported from Claude Code memory by pi-toolkit `/mem import`. " +
  "CC original is canonical until you edit here; mirror changes to CC if you still use both.\n\n";

export interface ImportResult {
  project: string; // CC slug
  piDir: string;
  files: number;
  bytes: number;
  skipped: number;
}

/**
 * Import a single CC project's memory into pi (1:1, idempotent).
 * Files are COPIED (CC originals untouched) with a drift-mitigation header
 * prepended. Re-running skips files that already exist at the destination
 * (unless force). Import 产物不加 provenance frontmatter（drift-header 已是
 * 其溯源标记，双标注重叠有害 —— 方案 §5.4）。
 *
 * P0-b（方案 §3.3 复审 v1-6）: `async`（任何失败都是 rejection，绝不同步抛
 * 出），持整个目标目录锁贯穿整次导入；非 force 用 `createExclusive`
 * 消除「先查后写」TOCTOU；CC 源里的文件级 symlink 同样跳过并计入 skipped。
 */
export async function importProject(slug: string, force = false, paths?: MemoryPaths): Promise<ImportResult> {
  const p = paths ?? defaultPaths();
  const srcDir = join(p.ccProjectsRoot, slug, "memory");
  if (!isDirFollowOutside(srcDir)) {
    throw new MemoryError(`no CC memory at ${srcDir}`);
  }
  const destDisplay = join(p.memoryRoot, slug);
  ensureMemoryDir(destDisplay);
  const canon = canonicalDir(destDisplay);
  if (!canon) throw new MemoryError(`memory directory for ${slug} is not accessible`);
  const real = canon.real;

  return withMemoryDirLock(real, () => {
    const { files: srcFiles } = listRegular(srcDir, { names: "legacy" });
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    for (const { name } of srcFiles) {
      let body: string;
      try {
        body = readRegular(srcDir, name).text;
      } catch {
        skipped++; // symlink / raced delete in the CC source — never fatal
        continue;
      }
      const data = Buffer.from(DRIFT_HEADER + body, "utf8");
      if (force) {
        try {
          statRegularIfExists(real, name); // throws for an existing symlink — force never clobbers it
        } catch {
          skipped++;
          continue;
        }
        const tmp = writeTempRegular(real, name, data, 0o600);
        replaceAtomic(real, tmp, name);
      } else {
        const tmp = writeTempRegular(real, name, data, 0o600);
        try {
          createExclusive(real, tmp, name);
        } catch {
          skipped++; // already exists — idempotent re-import
          continue;
        }
      }
      files++;
      bytes += Buffer.byteLength(body, "utf8");
    }
    return { project: slug, piDir: real, files, bytes, skipped };
  });
}

/** Discover all CC projects that have a memory/ dir, sorted. Per-entry
 *  try/catch so one exploding project dir can't sink the whole scan
 *  (Nit 8 TOCTOU). */
export function discoverCCProjects(paths?: MemoryPaths): string[] {
  const root = (paths ?? defaultPaths()).ccProjectsRoot;
  const entries = listDirNames(root);
  const out: string[] = [];
  for (const d of entries) {
    if (isDirFollowOutside(join(root, d, "memory"))) out.push(d);
  }
  return out.sort();
}

/** Import every CC project's memory into pi (idempotent). Serial `await` —
 *  §3.3: the first failure stops the batch, already-imported projects keep
 *  their results (same semantics `/mem import all` relied on pre-#22). */
export async function importAll(force = false, paths?: MemoryPaths): Promise<ImportResult[]> {
  const slugs = discoverCCProjects(paths);
  const results: ImportResult[] = [];
  for (const slug of slugs) {
    results.push(await importProject(slug, force, paths));
  }
  return results;
}
