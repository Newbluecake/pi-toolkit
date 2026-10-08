/**
 * web-hub-preview plan v3 / PV2a+PV3 source-scan guard (mirrors `tests/web-hub/hub/upload-fs-guard.test.ts`).
 *
 * Kernel discipline: within `src/web-hub/hub/preview/`, ONLY `fs.ts` may import
 * `node:fs`/`fs`/`node:fs/promises` (static, dynamic or require — `import type` is exempt),
 * and NO file may contain `readFile(` (whole-file reads are architecturally banned: previews
 * stream bounded windows, verification streams 64 KiB chunks). PV3's `routes.ts` joins the
 * scanned set with the same rules — it reaches disk exclusively through the PV2a kernels
 * and PV2b's store. The 2026-10-07 修订 adds `open.ts` (the shared ⑤–⑦ pipeline) and
 * `probe.ts` (the batch existence probe) under the SAME rules — both reach disk only
 * through `fs.ts`/the admitter/the upload store. *
 * dir-plan v3.1 §2.1/§2.4 (P1a) adds four rules:
 * 1. `previewFsStep(` call sites in the kernel files must carry `tracker` in their opts;
 * 2. `NO_TRACKER` may appear ONLY in `fs.ts` (definition), `hub/file-search.ts` (root ruling
 *    2026-10-08: file-search is on §2.4's 未纳入 list — explicit NO_TRACKER, byte-identical
 *    behavior) and `tests/`;
 * 3. `racePreviewIo(` in admit/fs must pass a tracker explicitly (verify/stream are
 *    whitelisted — §2.4's 未纳入 list, filename-pinned);
 * 4. the old `CwdAdmitter`/`createCwdAdmitter` surface must never come back (§2.1's
 *    旧接口删除不留别名 — re-introducing it is the 两套准入 resurrection entry).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PREVIEW_DIR = fileURLToPath(new URL("../../../../src/web-hub/hub/preview/", import.meta.url));
const HUB_DIR = fileURLToPath(new URL("../../../../src/web-hub/hub/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../../../src/", import.meta.url));
const FS_FILE = "fs.ts";
const KERNEL_FILES = [
  "sniff.ts",
  "admit.ts",
  "stream.ts",
  "verify.ts",
  "routes.ts",
  "open.ts",
  "probe.ts",
  "dir.ts",
] as const;

/** dir-plan §2.4 rule 2's whitelist: files outside tests/ allowed to reference NO_TRACKER
 * (paths relative to hub/). */
const NO_TRACKER_FILES = new Set(["preview/fs.ts", "file-search.ts"] as const);

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

  // ---- dir-plan v3.1 §2.4/§2.1 (P1a): tracker discipline + old-surface ban --------------

  it("§2.4 rule 1: every previewFsStep call site in the kernel files carries tracker in its opts", () => {
    for (const name of KERNEL_FILES) {
      const source = readFileSync(PREVIEW_DIR + name, "utf8");
      let idx = source.indexOf("previewFsStep(");
      while (idx !== -1) {
        const window = source.slice(idx, idx + 400);
        expect(window.includes("tracker"), `${name} @${idx}: previewFsStep opts must carry tracker`).toBe(true);
        idx = source.indexOf("previewFsStep(", idx + 1);
      }
    }
  });

  it("§2.4 rule 2: NO_TRACKER appears only in fs.ts, hub/file-search.ts and tests/", () => {
    const offenders: string[] = [];
    const walk = (dirPath: string): void => {
      for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
        const full = dirPath + ent.name;
        if (ent.isDirectory()) {
          walk(full + "/");
        } else if (ent.name.endsWith(".ts")) {
          const rel = full.startsWith(HUB_DIR) ? full.slice(HUB_DIR.length) : undefined;
          if (rel !== undefined && NO_TRACKER_FILES.has(rel as "fs.ts")) continue;
          if (readFileSync(full, "utf8").includes("NO_TRACKER")) offenders.push(full);
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });

  it("§2.4 rule 3: racePreviewIo call sites in admit/fs/dir pass a tracker (verify/stream whitelisted)", () => {
    const trackedFiles = ["admit.ts", "fs.ts", "dir.ts"] as const; // dir.ts joined in P1b
    for (const name of trackedFiles) {
      const source = readFileSync(PREVIEW_DIR + name, "utf8");
      let idx = source.indexOf("racePreviewIo(");
      while (idx !== -1) {
        const window = source.slice(idx, idx + 400);
        expect(window.includes("tracker"), `${name} @${idx}: racePreviewIo must pass tracker explicitly`).toBe(true);
        idx = source.indexOf("racePreviewIo(", idx + 1);
      }
    }
    // the whitelisted pre-tracker callers keep their (deliberate) omission — pinned so the
    // 未纳入 decision stays visible instead of silently eroding.
    for (const name of ["verify.ts", "stream.ts"] as const) {
      const source = readFileSync(PREVIEW_DIR + name, "utf8");
      expect(source.includes("PreviewIoTracker"), `${name}: tracker types must not creep in (§2.4 未纳入)`).toBe(false);
    }
  });

  it("§2.1: the CwdAdmitter surface is gone for good (hub/** must not contain the strings)", () => {
    const offenders: string[] = [];
    const walk = (dirPath: string): void => {
      for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
        const full = dirPath + ent.name;
        if (ent.isDirectory()) walk(full + "/");
        else if (ent.name.endsWith(".ts")) {
          const source = readFileSync(full, "utf8");
          if (source.includes("CwdAdmitter") || source.includes("createCwdAdmitter")) offenders.push(full);
        }
      }
    };
    walk(HUB_DIR); // covers hub/preview/ too
    expect(offenders).toEqual([]);
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
