/**
 * web-hub-preview plan v3 / PV2a+PV3 source-scan guard (mirrors `tests/web-hub/hub/upload-fs-guard.test.ts`).
 *
 * Kernel discipline: within `src/web-hub/hub/preview/`, ONLY `fs.ts` may import
 * `node:fs`/`fs`/`node:fs/promises` (static, dynamic or require — `import type` is exempt),
 * and NO file may contain `readFile(` (whole-file reads are architecturally banned: previews
 * stream bounded windows, verification streams 64 KiB chunks). PV3's `routes.ts` joins the
 * scanned set with the same rules — it reaches disk exclusively through the PV2a kernels
 * and PV2b's store.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PREVIEW_DIR = fileURLToPath(new URL("../../../../src/web-hub/hub/preview/", import.meta.url));
const FS_FILE = "fs.ts";
const KERNEL_FILES = ["sniff.ts", "admit.ts", "stream.ts", "verify.ts", "routes.ts"] as const;

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

describe("preview source scan (PV2a)", () => {
  const files = readdirSync(PREVIEW_DIR).filter((f) => f.endsWith(".ts"));

  it("the expected file set is present", () => {
    expect(files.sort()).toEqual([...KERNEL_FILES, FS_FILE].sort());
  });

  it("only fs.ts imports node:fs* — every other file reaches disk exclusively through it", () => {
    for (const name of KERNEL_FILES) {
      const source = readFileSync(PREVIEW_DIR + name, "utf8");
      expect(fsImportLines(source), `${name} must not import node:fs*`).toEqual([]);
    }
  });

  it("fs.ts itself DOES import node:fs (sanity: the guard is not vacuous)", () => {
    const source = readFileSync(PREVIEW_DIR + FS_FILE, "utf8");
    expect(fsImportLines(source).length).toBeGreaterThan(0);
  });

  it("no file contains `readFile(` anywhere", () => {
    for (const name of files) {
      const source = readFileSync(PREVIEW_DIR + name, "utf8");
      expect(source.includes("readFile("), `${name} must not contain readFile(`).toBe(false);
    }
  });

  it("the regex catches a deliberately-planted violation (self-test)", () => {
    expect(fsImportLines('import { open } from "node:fs/promises";\n')).toHaveLength(1);
    expect(fsImportLines('import fs from "fs";\n')).toHaveLength(1);
    expect(fsImportLines('const fsp = await import("node:fs/promises");\n')).toHaveLength(1);
    expect(fsImportLines('const fs2 = require("fs");\n')).toHaveLength(1);
    expect(fsImportLines('import type { Stats } from "node:fs";\n')).toHaveLength(0);
    // cross-module imports of the pure helpers are NOT violations
    expect(fsImportLines('import { mapFsError } from "./fs.js";\n')).toHaveLength(0);
    expect(fsImportLines('import { withinRoot } from "../spawn/dirs.js";\n')).toHaveLength(0);
  });
});
