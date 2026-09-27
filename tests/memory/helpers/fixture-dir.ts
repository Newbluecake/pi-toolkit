// Test-only fixture materialization helper for the memory golden suites
// (方案 docs/dev/memory/optimize-plan.md §10.1 point 2). Copies a named
// fixture directory under tests/fixtures/memory/<name> into a fresh
// mkdtemp() root, applies deterministic mtimes, and returns a MemoryPaths
// object plus a fixed cwd so renderMemoryBlock / listMemory / the memory
// tool all produce byte-identical output across runs and machines.
//
// Zero pi/typebox imports; used only from tests/memory/*.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug, type MemoryPaths } from "../../../src/memory/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** tests/fixtures/memory/ */
export const FIXTURES_ROOT = join(HERE, "..", "..", "fixtures", "memory");

/** Fixed fake cwd used by every golden test (never a real directory). */
export const FIXTURE_CWD = "/fixture/repo";
export const FIXTURE_SLUG = toSlug(FIXTURE_CWD);

/** §10.1 point 2 default: 2026-09-01T00:00:00Z + i×60s, i by ascending filename order. */
const BASE_MTIME_MS = new Date("2026-09-01T00:00:00.000Z").getTime();

export interface MaterializedFixture {
  /** The mkdtemp() root — delete this (and only this) in cleanup(). */
  tmp: string;
  cwd: string;
  /** memoryDirFor(cwd, paths) — where the fixture's *.md files were copied. */
  memDir: string;
  paths: MemoryPaths;
  /** Names actually materialized, sorted (the order default mtimes were assigned in). */
  names: string[];
  cleanup: () => void;
}

function readMtimeOverrides(srcDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(srcDir, "mtimes.json"), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Non-fixture bookkeeping files that live alongside *.md fixtures but are
 *  never themselves materialized as memory files. */
const NON_FIXTURE_FILES = new Set(["mtimes.json", "CASE.md"]);

function copyMdFiles(srcDir: string, destDir: string): string[] {
  const names = readdirSync(srcDir)
    .filter((n) => n.endsWith(".md") && !NON_FIXTURE_FILES.has(n))
    .sort();
  for (const name of names) {
    writeFileSync(join(destDir, name), readFileSync(join(srcDir, name)));
  }
  return names;
}

function applyMtimes(srcDir: string, destDir: string, names: string[]): void {
  const overrides = readMtimeOverrides(srcDir);
  names.forEach((name, i) => {
    const iso = overrides[name] ?? new Date(BASE_MTIME_MS + i * 60_000).toISOString();
    const t = new Date(iso).getTime() / 1000;
    utimesSync(join(destDir, name), t, t);
  });
}

/**
 * Materialize `tests/fixtures/memory/<name>/*.md` into a fresh temp root at
 * `<tmp>/root/<slug>/`, with a fresh (empty) `<tmp>/cc/` as ccProjectsRoot.
 */
export function materializeFixture(name: string, opts: { cwd?: string } = {}): MaterializedFixture {
  const tmp = mkdtempSync(join(tmpdir(), "memfx-"));
  const cwd = opts.cwd ?? FIXTURE_CWD;
  const slug = toSlug(cwd);
  const root = join(tmp, "root");
  const memDir = join(root, slug);
  mkdirSync(memDir, { recursive: true });
  const srcDir = join(FIXTURES_ROOT, name);
  const names = copyMdFiles(srcDir, memDir);
  applyMtimes(srcDir, memDir, names);
  const ccRoot = join(tmp, "cc");
  mkdirSync(ccRoot, { recursive: true });
  return {
    tmp,
    cwd,
    memDir,
    paths: { memoryRoot: root, ccProjectsRoot: ccRoot },
    names,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Same shape as materializeFixture, but the memory dir starts empty — the
 *  caller writes files (with explicit mtimes via utimesSync) itself. Used
 *  for cases that don't need a checked-in fixture directory (empty dir,
 *  single file, over-indexMax, …). */
export function materializeEmptyFixture(opts: { cwd?: string } = {}): MaterializedFixture {
  const tmp = mkdtempSync(join(tmpdir(), "memfx-"));
  const cwd = opts.cwd ?? FIXTURE_CWD;
  const slug = toSlug(cwd);
  const root = join(tmp, "root");
  const memDir = join(root, slug);
  mkdirSync(memDir, { recursive: true });
  const ccRoot = join(tmp, "cc");
  mkdirSync(ccRoot, { recursive: true });
  return {
    tmp,
    cwd,
    memDir,
    paths: { memoryRoot: root, ccProjectsRoot: ccRoot },
    names: [],
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Write one memory file with a deterministic mtime (helper for callers
 *  building a case on top of materializeEmptyFixture). */
export function writeMemAt(dir: string, name: string, body: string, iso: string): void {
  writeFileSync(join(dir, name), body);
  const t = new Date(iso).getTime() / 1000;
  utimesSync(join(dir, name), t, t);
}

export interface MaterializedCCFixture {
  tmp: string;
  /** Points straight at the checked-in `tests/fixtures/memory/cc-source/`
   *  (read-only source; importProject never writes to it). */
  paths: MemoryPaths;
  cleanup: () => void;
}

/** Materialize just the destination side (`memoryRoot`) for a CC-import
 *  golden test; `ccProjectsRoot` is the checked-in fixture dir itself. */
export function materializeCCFixture(): MaterializedCCFixture {
  const tmp = mkdtempSync(join(tmpdir(), "memfx-cc-"));
  const root = join(tmp, "root");
  mkdirSync(root, { recursive: true });
  return {
    tmp,
    paths: { memoryRoot: root, ccProjectsRoot: join(FIXTURES_ROOT, "cc-source") },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
