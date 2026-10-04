/**
 * web-hub-upload plan §包 U2 source-scan guard: `src/web-hub/hub/uploads.ts` is the upload
 * state machine and must reach the disk ONLY through `hub/upload-fs.ts` — it may not import
 * `node:fs`/`fs`/`node:fs/promises` in any form (mirrors `tests/memory/fs-guard.test.ts`).
 * `upload-fs.ts` is the single allowed fs importer on the upload side.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const HUB_SRC_DIR = new URL("../../../src/web-hub/hub/", import.meta.url).pathname;
const UPLOADS_FILE = "uploads.ts";
const UPLOAD_FS_FILE = "upload-fs.ts";

/** Matches `node:fs` / `fs` / `node:fs/promises` (static, dynamic, require); `import type` is exempt. */
const FS_MODULE_RE = /^(?:node:)?fs(?:\/promises)?$/;

function fsImportLines(source: string): string[] {
  const hits: string[] = [];
  const staticImportRe = /import\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(source)) !== null) {
    const isTypeOnly = m[1] !== undefined;
    const specifier = m[2] ?? "";
    if (!isTypeOnly && FS_MODULE_RE.test(specifier)) hits.push(m[0].replace(/\s+/g, " ").trim());
  }
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicRe.exec(source)) !== null) {
    if (FS_MODULE_RE.test(m[1] ?? "")) hits.push(m[0]);
  }
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(source)) !== null) {
    if (FS_MODULE_RE.test(m[1] ?? "")) hits.push(m[0]);
  }
  return hits;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(dir, e.name));
}

describe("upload fs import guard (plan §2.2)", () => {
  it("uploads.ts has zero fs imports (all disk access goes through upload-fs.ts)", () => {
    const source = readFileSync(join(HUB_SRC_DIR, UPLOADS_FILE), "utf8");
    expect(fsImportLines(source)).toEqual([]);
  });

  it("upload-fs.ts itself DOES import node:fs (sanity: the guard isn't vacuously passing)", () => {
    const source = readFileSync(join(HUB_SRC_DIR, UPLOAD_FS_FILE), "utf8");
    expect(fsImportLines(source).length).toBeGreaterThan(0);
  });

  it("the regex catches a deliberately-planted violation (self-test)", () => {
    expect(fsImportLines('import { open } from "node:fs/promises";\n')).toHaveLength(1);
    expect(fsImportLines('import fs from "fs";\n')).toHaveLength(1);
    expect(fsImportLines('const fsp = await import("node:fs/promises");\n')).toHaveLength(1);
    expect(fsImportLines('const fs2 = require("fs");\n')).toHaveLength(1);
    expect(fsImportLines('import type { Stats } from "node:fs";\n')).toHaveLength(0);
    expect(fsImportLines('import { join } from "node:path";\n')).toHaveLength(0);
  });

  it("uploads.ts exists in the hub source dir (the scan isn't scanning the wrong tree)", () => {
    const names = listTsFiles(HUB_SRC_DIR).map((f) => relative(HUB_SRC_DIR, f));
    expect(names).toContain(UPLOADS_FILE);
    expect(names).toContain(UPLOAD_FS_FILE);
  });
});
