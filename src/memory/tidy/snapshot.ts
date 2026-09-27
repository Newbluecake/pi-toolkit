// §7.3 step 1 snapshot (read target files, hash them, classify primary
// core / hand-written) — todo #22 P4. Pure over the safe-fs primitives it's
// given; no locking (reads never take the memory dir lock, §3.2).

import { createHash } from "node:crypto";
import { canonicalDir, isV2Name, listRegular, readRegular } from "../safe-fs.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "../paths.js";
import { frontmatterSource } from "../frontmatter.js";
import { parseMemoryMeta } from "../meta.js";
import type { MemoryMeta } from "../contracts.js";

export interface TidySnapshotFile {
  name: string;
  /** Raw file content, including frontmatter (byte-exact — used for backups
   *  and content-conservation checks). */
  body: string;
  meta: MemoryMeta;
  metaErrors: readonly string[];
  /** §2.1's primary-core rule: `core.md` if present (non-archived), else the
   *  first (filename order) `pin: true` non-archived file. */
  isPrimaryCore: boolean;
  /** frontmatter `source !== "agent"` (§5's table: agent ⇒ fence/overwritable; anything else = hand-written). */
  handWritten: boolean;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface TidySnapshot {
  cwd: string;
  /** Canonical (realpath'd) memory directory tidy operates on. */
  dir: string;
  files: readonly TidySnapshotFile[];
  totalBytes: number;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** §2.1 primary-core selection: `core.md` (non-archived) wins outright;
 *  otherwise the first (filename, code-point order) `pin: true` non-archived
 *  file. Pure over the already-parsed meta so every package that needs this
 *  rule (P1's tiered renderer, P4's tidy) can compute it identically without
 *  sharing runtime state — the rule itself is frozen text in §2.1, not code. */
export function computePrimaryCoreName(files: readonly { name: string; meta: MemoryMeta }[]): string | undefined {
  const core = files.find((f) => f.name === "core.md" && f.meta.status !== "archived");
  if (core) return core.name;
  const pinned = files.filter((f) => f.meta.pin && f.meta.status !== "archived").map((f) => f.name);
  pinned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return pinned[0];
}

export interface SnapshotOptions {
  /** Explicit file list from the command line; undefined = all non-archived
   *  addressable (v2 name rule) files. */
  names?: readonly string[];
  paths?: MemoryPaths;
}

/**
 * Read + hash the target files for `/mem tidy` / `/mem restore`'s
 * conflict checks. Throws `MemoryError` for: no memory directory; an
 * explicitly-named file that isn't a v2-addressable regular file.
 * Archived files are excluded from the default (no-args) selection but ARE
 * eligible when explicitly named (the user asked for them by name).
 */
export function snapshotMemoryDir(cwd: string, opts: SnapshotOptions = {}): TidySnapshot {
  const display = memoryDirFor(cwd, opts.paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`no memory directory for ${cwd}`);
  const dir = canon.real;
  const { files: entries } = listRegular(dir, { names: "v2" });
  const byName = new Map(entries.map((e) => [e.name, e]));

  let selectedNames: string[];
  if (opts.names && opts.names.length > 0) {
    selectedNames = [];
    for (const raw of opts.names) {
      const name = raw.trim();
      if (!isV2Name(name) || !byName.has(name)) {
        throw new MemoryError(`not a memory file: ${JSON.stringify(raw)}`);
      }
      selectedNames.push(name);
    }
  } else {
    selectedNames = [...byName.keys()];
  }

  // Parse meta for every candidate up front (needed for primary-core
  // selection even when a subset was explicitly named — §2.1's rule looks
  // at the whole directory, not just the requested subset).
  const allParsed = entries.map((e) => {
    const { text } = readRegular(dir, e.name);
    const { meta, errors } = parseMemoryMeta(text, e.name.replace(/\.md$/, ""));
    return { name: e.name, body: text, meta, errors, size: e.size, mtimeMs: e.mtimeMs };
  });
  const primaryName = computePrimaryCoreName(allParsed);

  const bodyByName = new Map(allParsed.map((p) => [p.name, p]));
  const explicit = opts.names !== undefined && opts.names.length > 0;
  const files: TidySnapshotFile[] = [];
  for (const name of selectedNames) {
    const parsed = bodyByName.get(name);
    if (!parsed) continue;
    if (!explicit && parsed.meta.status === "archived") continue; // default selection skips archived
    files.push({
      name,
      body: parsed.body,
      meta: parsed.meta,
      metaErrors: parsed.errors,
      isPrimaryCore: name === primaryName,
      handWritten: frontmatterSource(parsed.body) !== "agent",
      sha256: sha256Hex(parsed.body),
      size: parsed.size,
      mtimeMs: parsed.mtimeMs,
    });
  }
  const totalBytes = files.reduce((acc, f) => acc + Buffer.byteLength(f.body, "utf8"), 0);
  return { cwd, dir, files, totalBytes };
}
