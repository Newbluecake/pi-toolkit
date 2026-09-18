// Pure, pi-independent memory store: list / write / append / CC-import.
// Ported from @getpipher/armory-memory's memory-store.ts with the plan's
// hardening applied (方案 §5.3/§5.4): per-entry TOCTOU guards, byte-accurate
// limits (Buffer.byteLength, not string.length), 0600 files / 0700 dirs, the
// structural allowWrite gate (R7), and agent provenance frontmatter on write.
//
// Zero pi/typebox imports; independently unit-testable.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { upsertFrontmatterFields } from "./frontmatter.js";
import { MemoryError, memoryDirFor, defaultPaths, type MemoryPaths } from "./paths.js";

export interface MemoryFile {
  name: string; // filename, e.g. "playbook.md"
  path: string; // absolute path
  size: number; // bytes
  mtimeMs: number; // ms epoch
}

/** List *.md memory files for a cwd, newest-first. Empty array if none /
 *  missing / unreadable. Per-file stat failures (e.g. dangling symlinks) are
 *  skipped, not fatal — 方案 §5.1.6 TOCTOU. */
export function listMemory(cwd: string, paths?: MemoryPaths): MemoryFile[] {
  const dir = memoryDirFor(cwd, paths);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: MemoryFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    try {
      const path = join(dir, name);
      const st = statSync(path);
      files.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      continue; // raced delete / dangling symlink — skip this entry
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
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

/**
 * Write (replace) or append a single memory file under memoryDirFor(cwd).
 *
 * Safety model（方案 §5.3）：目录围栏（仅 memoryDirFor(cwd) 内 *.md，文件名
 * 白名单正则 + resolve 双保险）、体积双上限、0600/0700、结构性 allowWrite
 * 闸门。write 自动 upsert provenance frontmatter（source: agent + updated）；
 * append 是纯 O_APPEND 追加、绝不动 frontmatter（R4 原子性取舍）。
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
  if (opts.allowWrite !== true) throw new MemoryError("writes not allowed");
  if (!NAME_RE.test(name)) {
    throw new MemoryError(`invalid memory file name ${JSON.stringify(name)} — *.md only, no path separators`);
  }
  const dir = memoryDirFor(cwd, paths);
  const path = resolve(dir, name);
  if (dirname(path) !== resolve(dir)) {
    throw new MemoryError(`invalid memory file name ${JSON.stringify(name)} — escapes the memory dir`);
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > opts.maxWriteBytes) {
    throw new MemoryError(
      `content is ${contentBytes}B, over the per-write limit of ${opts.maxWriteBytes}B — split it into smaller writes`,
    );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (opts.append) {
    // Pure O_APPEND: never read-modify-write the file, never touch its
    // frontmatter (R4 — concurrent appends must not clobber each other).
    let existing = 0;
    let needsNewline = false;
    try {
      const st = statSync(path);
      existing = st.size;
      if (st.size > 0) {
        const tail = readFileSync(path, "utf8");
        needsNewline = !tail.endsWith("\n");
      }
    } catch {
      // not created yet
    }
    const appended = (needsNewline ? "\n" : "") + content;
    const appendedBytes = Buffer.byteLength(appended, "utf8");
    if (existing + appendedBytes > opts.maxFileBytes) {
      throw new MemoryError(
        `append would grow ${name} to ${existing + appendedBytes}B, over the ${opts.maxFileBytes}B file cap`,
      );
    }
    const created = existing === 0 && !existsSync(path);
    appendFileSync(path, appended, { encoding: "utf8", mode: 0o600 });
    return { path, bytesWritten: contentBytes, totalBytes: statSync(path).size, created };
  }

  // write (replace): upsert agent provenance into the NEW content（方案 §5.3 矩阵）。
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const finalContent = upsertFrontmatterFields(content, { source: "agent", updated: nowIso });
  const finalBytes = Buffer.byteLength(finalContent, "utf8");
  if (finalBytes > opts.maxFileBytes) {
    throw new MemoryError(`write would make ${name} ${finalBytes}B, over the ${opts.maxFileBytes}B file cap`);
  }
  const created = !existsSync(path);
  writeFileSync(path, finalContent, { encoding: "utf8", mode: 0o600 });
  return { path, bytesWritten: contentBytes, totalBytes: statSync(path).size, created };
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
 */
export function importProject(slug: string, force = false, paths?: MemoryPaths): ImportResult {
  const p = paths ?? defaultPaths();
  const src = join(p.ccProjectsRoot, slug, "memory");
  const dest = join(p.memoryRoot, slug);
  if (!existsSync(src)) {
    throw new MemoryError(`no CC memory at ${src}`);
  }
  mkdirSync(dest, { recursive: true, mode: 0o700 });

  let files = 0;
  let bytes = 0;
  let skipped = 0;
  const entries = readdirSync(src).filter((n) => n.endsWith(".md"));
  for (const name of entries) {
    const destPath = join(dest, name);
    if (existsSync(destPath) && !force) {
      skipped++;
      continue;
    }
    const body = readFileSync(join(src, name), "utf8");
    writeFileSync(destPath, DRIFT_HEADER + body, { encoding: "utf8", mode: 0o600 });
    files++;
    bytes += Buffer.byteLength(body, "utf8");
  }
  return { project: slug, piDir: dest, files, bytes, skipped };
}

/** Discover all CC projects that have a memory/ dir, sorted. Per-entry
 *  try/catch so one exploding project dir can't sink the whole scan
 *  (Nit 8 TOCTOU). */
export function discoverCCProjects(paths?: MemoryPaths): string[] {
  const root = (paths ?? defaultPaths()).ccProjectsRoot;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of entries) {
    try {
      if (statSync(join(root, d, "memory")).isDirectory()) out.push(d);
    } catch {
      continue; // dangling symlink / raced delete — skip this entry
    }
  }
  return out.sort();
}

/** Import every CC project's memory into pi (idempotent). */
export function importAll(force = false, paths?: MemoryPaths): ImportResult[] {
  return discoverCCProjects(paths).map((slug) => importProject(slug, force, paths));
}
