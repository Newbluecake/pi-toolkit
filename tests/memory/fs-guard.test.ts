// optimize-plan §3.1 (todo #22 P0-b): `src/memory/safe-fs.ts` is the ONLY
// file under `src/memory/**` allowed to import `node:fs` / `fs` /
// `node:fs/promises` — a static import-level scan, stricter than a plain
// identifier blocklist (catches `openSync`/`renameSync`/`linkSync`/etc. no
// matter how they're imported). `import type` is exempt (no runtime fs
// access); `lock.ts` is explicitly NOT exempt (it must reach fs only through
// safe-fs.ts's exported primitives).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const MEMORY_SRC_DIR = new URL("../../src/memory/", import.meta.url).pathname;
const ALLOWED_FILE = "safe-fs.ts";

/** Matches a static `import ... from "node:fs"` / `"fs"` / `"node:fs/promises"`,
 *  a `require("node:fs")`-style call, or a dynamic `import("node:fs")` — but
 *  NOT `import type { X } from "node:fs"` (type-only imports touch no
 *  runtime fs code). */
const FS_MODULE_RE = /^(?:node:)?fs(?:\/promises)?$/;

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Returns the fs-importing statements of a file (empty = clean). Scans the
 *  whole file (not line-by-line) so a Prettier-wrapped multi-line import
 *  list is still caught; dynamic `import(...)` and `require(...)` calls are
 *  matched separately since they're always single-expression. */
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

describe("fs import guard (§3.1)", () => {
  it("only safe-fs.ts imports node:fs anywhere under src/memory/**", () => {
    const files = listTsFilesRecursive(MEMORY_SRC_DIR);
    expect(files.length).toBeGreaterThan(5);
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      const relPath = relative(MEMORY_SRC_DIR, file);
      if (relPath === ALLOWED_FILE) continue;
      const hits = fsImportLines(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders[relPath] = hits;
    }
    expect(offenders).toEqual({});
  });

  it("lock.ts specifically has zero fs imports (not exempt, §3.2)", () => {
    const source = readFileSync(join(MEMORY_SRC_DIR, "lock.ts"), "utf8");
    expect(fsImportLines(source)).toEqual([]);
  });

  it("safe-fs.ts itself DOES import node:fs (sanity: the guard isn't vacuously passing)", () => {
    const source = readFileSync(join(MEMORY_SRC_DIR, ALLOWED_FILE), "utf8");
    expect(fsImportLines(source).length).toBeGreaterThan(0);
  });

  it("the regex catches a deliberately-planted violation (self-test)", () => {
    expect(fsImportLines('import { readFileSync } from "node:fs";\n')).toHaveLength(1);
    expect(fsImportLines('import fs from "fs";\n')).toHaveLength(1);
    expect(fsImportLines('const x = await import("node:fs/promises");\n')).toHaveLength(1);
    expect(fsImportLines('import type { Stats } from "node:fs";\n')).toHaveLength(0);
    expect(fsImportLines('import { join } from "node:path";\n')).toHaveLength(0);
  });
});
