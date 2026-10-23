// pi-secure convert/import — session & memory copy engine (convert-plan r3 §2, §3.4; package V3).
//
// Plain ESM, ZERO dependencies beyond Node ≥22 built-ins; runs straight from `src/` inside the
// launcher's worker. NEVER touches helper.mjs or the TypeScript plugin — V4 (convert) and V5
// (archive/relocation) consume this module through its exported functions only.
//
// Non-negotiable invariants (plan §2.3 / §2.5, user ruling 2026-10-23 "只复制，绝不修改或删除源文件"):
//   I-S1  Source session files and memory dirs are opened READ-ONLY. This module never renames,
//         writes, chmods or deletes anything outside the destinations it is told to create.
//   I-S2  Copies are written via tmp (`wx` 0600) + fsync + rename; an existing destination that
//         is byte-equal to the intended result is skipped (re-entrant), a differing one is a
//         conflict that the caller maps to exit 74 — never overwritten.
//   I-S3  Every copy is re-read from the source and compared (size + sha256); concurrent appends
//         by a running pi trigger at most COPY_MAX_ATTEMPTS re-reads, after which the file is
//         reported partial. The source is unaffected either way.
//   I-S4  Rewrites happen on the COPY only: header cwd (in-tree sessions), header parentSession
//         and every `subagent:run` diag.sessionFile that falls inside the copy set. All other
//         lines stay byte-identical; no version upgrades; source mtime/atime are restored.
//   I-S5  The pi session-header rules are mirrored from
//         node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js (pi 1.3.0):
//         blank/malformed lines are skipped inside a 1 MiB discovery window and the FIRST parsed
//         entry must be `type:"session"` with a string id, else the file is invalid (XC6).
//   I-S6  The relocation engine (§3.4) rewrites in place INSIDE the new vault only, per-file
//         tmp+rename, and is idempotent (already-rewritten files match no prefix and are left
//         untouched), so a crashed transaction can simply be re-run.
import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// ───────────────────────────── constants ─────────────────────────────

/** pi's bounded header discovery window (session-manager.js MAX_SESSION_HEADER_SCAN_BYTES). */
export const SESSION_HEADER_SCAN_MAX_BYTES = 1024 * 1024;
/** pi reads headers in 4 KiB chunks; mirrored so window behaviour (incl. the EOF probe) matches. */
const HEADER_CHUNK_BYTES = 4096;
/** Custom entry type that carries `data.diag.sessionFile` (pinned to src/adapters/pi-run-log.ts). */
export const SUBAGENT_RUN_CUSTOM_TYPE = "subagent:run";

/** §2.2 #4: child-session closure budget. */
export const CLOSURE_MAX_FILES = 2000;
export const CLOSURE_MAX_BYTES = 512 * 1024 * 1024;
/** §2.3: re-read retries when the source was appended to mid-copy. */
export const COPY_MAX_ATTEMPTS = 3;

/** Bounded walk budget while looking for `.pi/settings.json` inside the source tree (§2.2 #1). */
export const TREE_WALK_MAX_ENTRIES = 100_000;
export const TREE_WALK_MAX_DEPTH = 64;
export const SETTINGS_JSON_MAX_BYTES = 1024 * 1024;

/** §2.5: memory slug ambiguity — each `-` (after the leading one) may have been a `/`. */
export const MEMORY_AMBIGUITY_MAX_DASHES = 10;

/** Report-only reverse-link scan budget (R28). */
export const PARENT_SCAN_MAX_DIRS = 4096;
export const PARENT_SCAN_MAX_FILES = 20_000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class SessionsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SessionsError";
    this.code = code;
  }
}

// ───────────────────────────── small helpers ─────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function tmpNameFor(file) {
  return `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Write `data` to `dir/<name>` via tmp file (§2.3: `O_EXCL|O_NOFOLLOW` 0600) + fsync + rename. */
function writeTmpAtomic(dir, name, data, mode = FILE_MODE) {
  const tmp = path.join(dir, tmpNameFor(name));
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, mode);
  try {
    writeSync(fd, data, 0, data.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path.join(dir, name));
}

function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Resolve `p` without throwing (missing/broken paths resolve lexically, like pi's list filter). */
function resolveSafe(p) {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

// ───────────────────────────── path predicates (§2.2 #3) ─────────────────────────────

/** True iff `child === root` or `child` starts with `root + "/"` (both must be pre-resolved). */
export function isPathWithin(child, root) {
  return child === root || child.startsWith(root + path.sep);
}

/**
 * Match `cwd` (a session header cwd) against the source-root spellings. Tries the literal
 * resolve first, then realpath on both sides (a symlinked subpath inside the tree still counts).
 * Returns the matched root spelling plus the remainder used to build the new cwd, or undefined.
 */
export function matchWithinRoots(cwd, roots) {
  const lit = resolveSafe(cwd);
  for (const root of roots) {
    if (isPathWithin(lit, root)) return { root, remainder: lit.slice(root.length), via: "literal" };
  }
  const cwdReal = realpathOrNull(lit);
  if (cwdReal !== undefined) {
    for (const root of roots) {
      const rootReal = realpathOrNull(root) ?? root;
      if (isPathWithin(cwdReal, rootReal)) {
        return { root: rootReal, remainder: cwdReal.slice(rootReal.length), via: "realpath" };
      }
    }
  }
  return undefined;
}

// ───────────────────────────── pi header mirror (§2.1, XC6) ─────────────────────────────

/**
 * One physical line during the header search, mirroring pi's `parseSessionHeaderCandidate`:
 * undefined = keep scanning (blank / malformed), null = parsed non-header (file invalid),
 * object = the session header (`type:"session"` + string id).
 */
function parseHeaderCandidate(line) {
  if (!line.trim()) return undefined;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  // pi's parseSessionEntryLine + `!entry` skip: falsy scalars (null/0/false/"") keep scanning
  if (!entry) return undefined;
  if (!isPlainObject(entry)) return null;
  if (entry.type !== "session" || typeof entry.id !== "string") return null;
  return entry;
}

/**
 * Mirror of pi's `readSessionHeader` (session-manager.js): scan at most
 * SESSION_HEADER_SCAN_MAX_BYTES from the start of the file, skipping blank and malformed
 * lines; the first PARSED line must be a session header. A header line that only ends past
 * the window makes the file invalid for discovery (`scan-limit`), exactly like pi throws
 * SessionHeaderScanLimitError and discovery treats the file as "not a session".
 */
export function readSessionHeaderLikePi(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    return { status: "invalid", reason: "unreadable", message: String(error?.message ?? error) };
  }
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
    const lineChunks = [];
    let scanned = 0;
    while (scanned < SESSION_HEADER_SCAN_MAX_BYTES) {
      const want = Math.min(buf.length, SESSION_HEADER_SCAN_MAX_BYTES - scanned);
      const n = readSync(fd, buf, 0, want, null);
      if (n === 0) {
        // EOF: the final unterminated line is still a candidate (pi pushes decoder.end()).
        lineChunks.push(decoder.end());
        const header = parseHeaderCandidate(lineChunks.join(""));
        return header ? { status: "ok", header } : { status: "invalid", reason: "not-session" };
      }
      scanned += n;
      const chunk = decoder.write(buf.subarray(0, n));
      let start = 0;
      let nl = chunk.indexOf("\n", start);
      while (nl !== -1) {
        lineChunks.push(chunk.slice(start, nl));
        const header = parseHeaderCandidate(lineChunks.join(""));
        if (header !== undefined) {
          return header ? { status: "ok", header } : { status: "invalid", reason: "not-session" };
        }
        lineChunks.length = 0;
        start = nl + 1;
        nl = chunk.indexOf("\n", start);
      }
      lineChunks.push(chunk.slice(start));
    }
    // Window exhausted — pi probes one more byte: a header ending exactly at the limit with EOF
    // is allowed, anything beyond is a scan-limit (invalid for discovery).
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, null) === 0) {
      lineChunks.push(decoder.end());
      const header = parseHeaderCandidate(lineChunks.join(""));
      return header ? { status: "ok", header } : { status: "invalid", reason: "not-session" };
    }
    return { status: "invalid", reason: "scan-limit" };
  } finally {
    closeSync(fd);
  }
}

// ───────────────────────────── slug rules (§2.1 / §2.5) ─────────────────────────────

/** pi's default session dir name for a cwd: `--<cwd sans leading /, with / \ : → ->--` (lossy). */
export function sessionDirSlug(cwd) {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The prefix every slug of a SUBDIRECTORY of `cwd` starts with (also matches the root's own
 * slug): root `--a-b--`, subdir `--a-b-c--` ⇒ core prefix `--a-b-`. Dash-siblings of the root
 * (`/a/b-c`) are indistinguishable from real subdirs (toSlug is lossy) and therefore included
 * as candidates; per-file header cwd filtering stays authoritative.
 */
export function sessionDirSlugPrefix(cwd) {
  const slug = sessionDirSlug(cwd);
  return slug.slice(0, -1); // drop ONE trailing dash: `--a-b--` → `--a-b-`
}

/** Mirror of src/memory/paths.ts `toSlug`: strip trailing '/', replace '/' with '-'. */
export function memorySlug(cwd) {
  return cwd.replace(/\/+$/, "").replace(/\//g, "-");
}

// ───────────────────────────── settings discovery (§2.2 #1) ─────────────────────────────

/**
 * Read `sessionDir` out of a settings.json (project `.pi/settings.json` or the global one).
 * Returns undefined when the file is missing/unreadable/not an object or the key is absent.
 */
export function readSessionDirFromSettings(file) {
  let text;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > SETTINGS_JSON_MAX_BYTES) return undefined;
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(obj)) return undefined;
  const v = obj.sessionDir;
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Bounded, symlink-free walk of `treeRoot` collecting every `.pi/settings.json` (absolute,
 * lstat-verified regular file). `.git` trees are skipped — settings never live there and the
 * walk budget is better spent elsewhere. Over-budget ⇒ `truncated: true` (report-only).
 */
export function findProjectSettingsFiles(
  treeRoot,
  { maxEntries = TREE_WALK_MAX_ENTRIES, maxDepth = TREE_WALK_MAX_DEPTH } = {},
) {
  const files = [];
  let entries = 0;
  let truncated = false;
  const stack = [{ dir: resolveSafe(treeRoot), depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue; // unreadable dir — report nothing, keep walking siblings
    }
    for (const name of names) {
      if (++entries > maxEntries) {
        truncated = true;
        return { files, truncated, entriesScanned: entries };
      }
      if (name === ".git") continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === ".pi") {
          const settings = path.join(full, "settings.json");
          try {
            if (lstatSync(settings).isFile()) files.push(settings);
          } catch {
            /* no settings.json here */
          }
        } else if (depth + 1 <= maxDepth) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  return { files, truncated, entriesScanned: entries };
}

/**
 * Resolve one sessionDir value from a settings file to an absolute dir. `~` expands against
 * `home`; relative values resolve against the project root that owns the settings file
 * (`projRoot`), matching how pi would see them from that cwd. Unknown shapes return undefined.
 */
export function resolveSessionDirValue(value, { home, projRoot }) {
  if (typeof value !== "string" || value === "") return undefined;
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  if (value.startsWith("/")) return path.resolve(value);
  return path.resolve(projRoot, value);
}

// ───────────────────────────── discovery (§2.2 #1) ─────────────────────────────

/**
 * Collect every candidate session DIRECTORY for a conversion. Sources, in plan order:
 *  1. `<agentDir>/sessions/` entries named `slug(root)` or starting with a subdir-slug prefix —
 *     computed for BOTH the literal and the realpath spelling of `root` (sessions may have
 *     recorded either), deduped by realpath;
 *  2. the global settings `sessionDir` (caller-read value, `globalSessionDir`);
 *  3. every `.pi/settings.json` `sessionDir` found inside `treeRoot` (bounded walk);
 *  4. the current `PI_CODING_AGENT_SESSION_DIR` (`envSessionDir`);
 *  5. every `--sessions-from <dir>` (`extraDirs`).
 * Missing dirs are kept in the report (why + missing) but naturally yield no files.
 */
export function discoverSessionSources({
  root,
  treeRoot,
  agentDir,
  home,
  globalSessionDir,
  envSessionDir,
  extraDirs = [],
  walkBudget,
  /**
   * The PRE-RENAME realpath spelling of `root`, captured by the caller before the backup
   * rename (once renamed, `realpath(root)` is gone or resolves through the new symlink into
   * the vault — both useless for matching historical header cwds). Optional; when omitted
   * the current on-disk realpath is used (pre-rename / test usage).
   */
  rootRealpath,
}) {
  const notes = [];
  const seen = new Set();
  const sources = [];
  const addDir = (dir, why) => {
    const abs = resolveSafe(dir);
    const key = realpathOrNull(abs) ?? abs; // dedupe physical dirs (literal/real root spellings)
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ dir: abs, why });
  };

  // 1. slug dirs under <agentDir>/sessions (literal + realpath spelling of root)
  const sessionsRoot = path.join(resolveSafe(agentDir), "sessions");
  const spellings = [path.resolve(root)];
  const rootReal = rootRealpath ?? realpathOrNull(root);
  if (rootReal !== undefined && path.resolve(rootReal) !== spellings[0]) spellings.push(path.resolve(rootReal));
  let names = [];
  try {
    names = readdirSync(sessionsRoot);
  } catch {
    notes.push(`无法读取 ${sessionsRoot}（不存在或不可读）`);
  }
  for (const spelling of spellings) {
    const exact = sessionDirSlug(spelling);
    const prefix = sessionDirSlugPrefix(spelling);
    for (const name of names) {
      if (name === exact || name.startsWith(prefix)) {
        addDir(path.join(sessionsRoot, name), `slug:${name}`);
      }
    }
  }

  // 2–4. explicit dirs
  if (globalSessionDir) addDir(globalSessionDir, "settings:global");
  if (envSessionDir) addDir(envSessionDir, "env:PI_CODING_AGENT_SESSION_DIR");
  for (const dir of extraDirs) addDir(dir, "sessions-from");

  // 3. in-tree project settings
  const walkRoot = treeRoot ?? root;
  const walk = findProjectSettingsFiles(walkRoot, walkBudget);
  if (walk.truncated) notes.push(`源树扫描超过预算（${walk.entriesScanned} 条目），.pi/settings.json 清单可能不完整`);
  for (const file of walk.files) {
    const value = readSessionDirFromSettings(file);
    if (value === undefined) continue;
    const dir = resolveSessionDirValue(value, { home, projRoot: path.dirname(path.dirname(file)) });
    if (dir) addDir(dir, `settings:${file}`);
  }
  return { sources, notes, settingsFiles: walk.files, treeWalkTruncated: walk.truncated };
}

/** List `*.jsonl` files of one candidate dir with their pi-mirrored header verdicts. */
export function scanSessionDir(dir) {
  const abs = resolveSafe(dir);
  let names;
  try {
    names = readdirSync(abs);
  } catch {
    return { dir: abs, missing: true, files: [] };
  }
  const files = [];
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    const file = path.join(abs, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const header = readSessionHeaderLikePi(file);
    files.push({
      file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      dev: st.dev,
      ino: st.ino,
      header: header.status === "ok" ? header.header : undefined,
      headerStatus: header.status,
      headerReason: header.status === "invalid" ? header.reason : undefined,
    });
  }
  return { dir: abs, missing: false, files };
}

// ───────────────────────────── subagent refs + closure (§2.2 #4) ─────────────────────────────

/**
 * Extract every `subagent:run` diag.sessionFile reference from session file content.
 * Mirrors src/session-nav/provenance.ts: cheap substring prefilter, then strict shape checks;
 * relative refs resolve against the referencing file's directory.
 */
export function extractRunRefs(content, filePath) {
  const refs = [];
  const lines = content.toString("utf8").split("\n");
  for (const line of lines) {
    if (!line.includes('"subagent:run"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed) || parsed.type !== "custom" || parsed.customType !== SUBAGENT_RUN_CUSTOM_TYPE) continue;
    const diag = isPlainObject(parsed.data) ? parsed.data.diag : undefined;
    const sessionFile = isPlainObject(diag) ? diag.sessionFile : undefined;
    if (typeof sessionFile !== "string" || sessionFile === "") continue;
    refs.push(
      sessionFile.startsWith("/") ? path.resolve(sessionFile) : path.resolve(path.dirname(filePath), sessionFile),
    );
  }
  return refs;
}

/**
 * Plan the copy set: selection (header cwd within `matchRoots`) + child closure
 * (`subagent:run` refs, deduped by (dev, ino), budget ≤ maxFiles files / ≤ maxBytes bytes).
 * Over-budget ⇒ `partial: true` and the not-yet-processed refs in `unfinishedRefs` — the
 * discovered part still copies (plan r3: partial only affects the report, nothing is deleted).
 * `matchRoots`/`newRoot` are echoed onto the plan for the copy stage.
 */
export function planSessionCopy({ sources, matchRoots, newRoot, budgets = {} }) {
  const maxFiles = budgets.maxFiles ?? CLOSURE_MAX_FILES;
  const maxBytes = budgets.maxBytes ?? CLOSURE_MAX_BYTES;
  const copySet = new Map(); // abs src path → plan entry
  const outOfTree = [];
  const invalid = [];
  const visited = new Set(); // "dev:ino"
  let bytes = 0;
  let partial = false;
  const unfinishedRefs = [];
  const queue = []; // { file, why: "selected" | "child:<ref>" }
  const enqueued = new Set();

  const enqueue = (file, why) => {
    if (enqueued.has(file)) return;
    enqueued.add(file);
    queue.push({ file, why });
  };

  const scans = sources.map((src) => scanSessionDir(src.dir));
  for (const scan of scans) {
    for (const f of scan.files) {
      if (f.header === undefined) {
        invalid.push({ file: f.file, reason: f.headerReason ?? "no-header" });
        continue;
      }
      const cwd = typeof f.header.cwd === "string" ? f.header.cwd : undefined;
      const match = cwd !== undefined ? matchWithinRoots(cwd, matchRoots) : undefined;
      if (match === undefined) {
        outOfTree.push({ file: f.file, cwd: cwd ?? null });
        continue;
      }
      enqueue(f.file, "selected");
    }
  }

  while (queue.length > 0) {
    const { file, why } = queue.shift();
    let st;
    try {
      st = statSync(file);
    } catch (error) {
      invalid.push({ file, reason: `unreadable:${String(error?.message ?? error)}` });
      continue;
    }
    // Budget gate BEFORE slurping content (an oversized file must not be read just to be
    // rejected), and (dev, ino) dedupe so the same file reached via several refs copies once.
    const key = `${st.dev}:${st.ino}`;
    if (visited.has(key)) continue;
    if (copySet.size >= maxFiles || bytes + st.size > maxBytes) {
      partial = true;
      unfinishedRefs.push(file);
      continue;
    }
    let content;
    try {
      content = readFileSync(file);
    } catch (error) {
      invalid.push({ file, reason: `unreadable:${String(error?.message ?? error)}` });
      continue;
    }
    const headerRead = readSessionHeaderLikePi(file);
    visited.add(key);
    copySet.set(file, {
      file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      cwd: headerRead.status === "ok" && typeof headerRead.header.cwd === "string" ? headerRead.header.cwd : undefined,
      headerStatus: headerRead.status,
      inTree: why === "selected",
      why,
    });
    bytes += st.size;
    // Follow this file's own run refs (children of children included).
    for (const ref of extractRunRefs(content, file)) {
      if (statOrNull(ref) === undefined) {
        unfinishedRefs.push(ref); // dangling ref (source deleted): record, never fail
        continue;
      }
      enqueue(ref, `child:${ref}`);
    }
  }

  return {
    copySet,
    matchRoots,
    newRoot: newRoot !== undefined ? path.resolve(newRoot) : undefined,
    outOfTree,
    invalid,
    partial,
    unfinishedRefs,
    budget: { files: copySet.size, bytes, maxFiles, maxBytes },
    scannedDirs: scans.map((s) => s.dir),
  };
}

function statOrNull(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

// ───────────────────────────── line rewriting (§2.3) ─────────────────────────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Rewrite one session file's content onto the copy:
 *  - header line (first PARSED line — the file is header-valid by then): `cwd` → newRoot+remainder
 *    for in-tree sessions; `parentSession` → mapped path when inside the copy set;
 *  - every `subagent:run` line's `data.diag.sessionFile` → mapped path when inside the copy set;
 *  - all other lines byte-identical.
 * Returns the new content plus structural checks used by the post-write verification.
 */
export function rewriteSessionContent({ content, inTree, matchRoots, newRoot, pathMap, file }) {
  const text = content.toString("utf8");
  const lines = text.split("\n");
  let sawHeader = false;
  const rewrote = { cwd: false, parentSession: false, runRefs: 0 };
  const checks = []; // { line, srcParsed, ignore: [fieldpath...] } — ONE per rewritten line, so
  // a line with several mapped fields verifies against all-but-those-fields at once.

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line — byte-identical passthrough (mirrors pi skipping them)
    }
    if (!isPlainObject(parsed)) continue;

    if (!sawHeader) {
      sawHeader = true; // first parsed line of a valid session file is the header
      if (parsed.type !== "session") continue;
      const srcParsed = JSON.parse(line); // pristine snapshot for the deep-equal check
      const ignore = [];
      if (inTree && typeof parsed.cwd === "string") {
        const match = matchWithinRoots(parsed.cwd, matchRoots);
        if (match) {
          parsed.cwd = path.join(newRoot, match.remainder);
          rewrote.cwd = true;
          ignore.push(["cwd"]);
        }
      }
      if (typeof parsed.parentSession === "string") {
        const mapped = pathMap.get(path.resolve(parsed.parentSession));
        if (mapped !== undefined) {
          parsed.parentSession = mapped;
          rewrote.parentSession = true;
          ignore.push(["parentSession"]);
        }
      }
      if (ignore.length > 0) {
        lines[i] = JSON.stringify(parsed);
        checks.push({ line: i, srcParsed, ignore });
      }
      continue;
    }

    if (parsed.type === "custom" && parsed.customType === SUBAGENT_RUN_CUSTOM_TYPE) {
      const sessionFile =
        isPlainObject(parsed.data) && isPlainObject(parsed.data.diag) ? parsed.data.diag.sessionFile : undefined;
      if (typeof sessionFile === "string" && sessionFile !== "") {
        const mapped = pathMap.get(path.resolve(sessionFile));
        if (mapped !== undefined) {
          const srcParsed = JSON.parse(line);
          parsed.data.diag.sessionFile = mapped;
          lines[i] = JSON.stringify(parsed);
          rewrote.runRefs++;
          checks.push({ line: i, srcParsed, ignore: [["data", "diag", "sessionFile"]] });
        }
      }
    }
  }

  return {
    content: Buffer.from(lines.join("\n"), "utf8"),
    rewrote,
    checks,
    file,
  };
}

/** Verify one structural check: copy deep-equals source except the mapped fields. */
function verifyRewriteCheck(check, copyLine) {
  let copyParsed;
  try {
    copyParsed = JSON.parse(copyLine);
  } catch {
    return false;
  }
  const a = structuredClone(check.srcParsed);
  const b = structuredClone(copyParsed);
  for (const fieldPath of check.ignore) {
    unsetPath(a, fieldPath);
    unsetPath(b, fieldPath);
  }
  return deepEqual(a, b);
}

function unsetPath(obj, fieldPath) {
  let cur = obj;
  for (let i = 0; i < fieldPath.length - 1 && isPlainObject(cur); i++) cur = cur[fieldPath[i]];
  if (isPlainObject(cur)) delete cur[fieldPath[fieldPath.length - 1]];
}

// ───────────────────────────── copy + re-read verification (§2.3) ─────────────────────────────

/**
 * Copy one session file into `destDir` under its original basename, with rewrite + re-read
 * verification. See module header for the invariants. `hooks.beforeVerify` fires between the
 * temp write and the source re-read on EVERY attempt (the §7.1 test seam for concurrent
 * appends); it must not throw.
 */
export function copySessionFile({ src, destDir, inTree, matchRoots, newRoot, pathMap, hooks = {} }) {
  mkdirSync(destDir, { mode: DIR_MODE, recursive: true });
  const dest = path.join(destDir, path.basename(src));
  const srcStat = statOrNull(src);
  if (srcStat === undefined) return { src, dest, status: "partial", reason: "source-missing" };
  // A destination that existed BEFORE this call is either a previous run's output
  // (byte-equal ⇒ skip, re-entrant) or a foreign file (differs ⇒ conflict, exit 74 — never
  // overwritten). A destination WE wrote on an earlier attempt of THIS call is not subject
  // to that check: retries replace our own leftover via tmp+rename.
  const destPreexisting = existsSync(dest);

  const attempt = () => {
    const content = readFileSync(src); // may throw ENOENT if deleted mid-run — caught below
    const rewritten = rewriteSessionContent({ content, inTree, matchRoots, newRoot, pathMap, file: src });
    return { content, rewritten };
  };

  const removeOurLeftover = () => {
    // "从未得到一致读取时不写副本只报告" — the last attempt's snapshot is ours, remove it.
    try {
      if (!destPreexisting) unlinkSync(dest);
    } catch {
      /* best-effort — reported as partial either way */
    }
  };

  for (let i = 1; i <= COPY_MAX_ATTEMPTS; i++) {
    let read1;
    try {
      read1 = attempt();
    } catch (error) {
      return { src, dest, status: "partial", reason: `read-failed:${String(error?.message ?? error)}` };
    }
    const digest1 = sha256(read1.content);

    if (destPreexisting) {
      const existing = statOrNull(dest);
      const existingBytes = existing !== undefined && existing.isFile() ? readFileSync(dest) : undefined;
      if (existingBytes !== undefined && existingBytes.equals(read1.rewritten.content)) {
        return { src, dest, status: "skipped", attempts: i, rewrote: read1.rewritten.rewrote };
      }
      return {
        src,
        dest,
        status: "conflict",
        attempts: i,
        reason: "destination-exists-differs",
        rewrote: read1.rewritten.rewrote,
      };
    }

    writeTmpAtomic(destDir, path.basename(src), read1.rewritten.content);
    if (typeof hooks.beforeVerify === "function") {
      try {
        hooks.beforeVerify({ src, attempt: i, content: read1.content });
      } catch {
        /* test seam — never fails the copy */
      }
    }
    const again = statOrNull(src);
    const content2 = again !== undefined ? readFileSync(src) : undefined;
    if (content2 !== undefined && sha256(content2) === digest1 && content2.length === read1.content.length) {
      // Consistent read: restore the source's mtime/atime so pi's list order + 48 h window hold.
      const st = statOrNull(src) ?? srcStat;
      try {
        utimesSync(dest, st.atime, st.mtime);
      } catch {
        /* times are best-effort */
      }
      // Read-back verification (§2.3): byte equality + structural deep-equal on rewritten lines.
      const readback = readFileSync(dest);
      const ok =
        readback.equals(read1.rewritten.content) &&
        read1.rewritten.checks.every((c) => verifyRewriteCheck(c, readback.toString("utf8").split("\n")[c.line] ?? ""));
      if (ok) return { src, dest, status: "complete", attempts: i, rewrote: read1.rewritten.rewrote };
      return { src, dest, status: "partial", reason: "verify-failed", attempts: i, rewrote: read1.rewritten.rewrote };
    }
  }
  // Never got a consistent read in COPY_MAX_ATTEMPTS: no copy is left behind, source untouched.
  removeOurLeftover();
  return { src, dest, status: "partial", reason: "source-appended", attempts: COPY_MAX_ATTEMPTS };
}

/**
 * Orchestrated copy of a planned copy set into `destDir` (created if missing, 0700).
 * Builds the path map (every source file → `<destDir>/<basename>`), then copies each entry.
 * Returns per-file results plus rolled-up conflicts/partial lists; V4 maps conflicts to 74.
 */
export function copySessions({ plan, destDir, hooks = {} }) {
  mkdirSync(destDir, { mode: DIR_MODE, recursive: true });
  const pathMap = new Map();
  for (const src of plan.copySet.keys()) pathMap.set(src, path.join(destDir, path.basename(src)));
  const files = [];
  const conflicts = [];
  const partial = [];
  for (const [src, entry] of plan.copySet) {
    const result = copySessionFile({
      src,
      destDir,
      inTree: entry.inTree,
      matchRoots: plan.matchRoots ?? [],
      newRoot: plan.newRoot,
      pathMap,
      hooks,
    });
    files.push(result);
    if (result.status === "conflict") conflicts.push(result);
    if (result.status === "partial") partial.push(result);
  }
  return {
    destDir,
    files,
    conflicts,
    partial,
    counts: {
      complete: files.filter((f) => f.status === "complete").length,
      skipped: files.filter((f) => f.status === "skipped").length,
      partial: partial.length,
      conflict: conflicts.length,
    },
  };
}

// ───────────────────────────── memory (§2.5, copy-only) ─────────────────────────────

/**
 * The exact memory slugs of the source root: literal and realpath spelling, deduped.
 * Subdir slugs and prefix matches are deliberately NOT taken (toSlug is lossy, W10).
 */
export function memoryExactSlugs({ root, memoryRoot, rootRealpath }) {
  const out = [];
  const seen = new Set();
  const real = rootRealpath !== undefined ? path.resolve(rootRealpath) : realpathOrNull(root);
  for (const spelling of [path.resolve(root), real]) {
    if (spelling === undefined) continue;
    const slug = memorySlug(spelling);
    if (slug === "" || seen.has(slug)) continue;
    seen.add(slug);
    const dir = path.join(resolveSafe(memoryRoot), slug);
    out.push({ slug, dir, spelling });
  }
  return out;
}

/**
 * Ambiguity check: every `-` after the leading one may have been a `/`; enumerate the ≤2^k
 * other decodings of `slug` and if ANY of them exists as a real directory on disk (other than
 * our own root spellings), the memory dir cannot be attributed unambiguously ⇒ skip (report).
 * k > MEMORY_AMBIGUITY_MAX_DASHES ⇒ ambiguous without enumeration.
 */
export function checkMemorySlugAmbiguity(slug, ownPaths) {
  // The slug's leading dash encodes the cwd's leading "/" — real cwds are absolute, so the
  // first char always decodes to "/" and only the remaining dashes are ambiguous.
  const positions = [];
  for (let i = 1; i < slug.length; i++) if (slug[i] === "-") positions.push(i);
  if (positions.length === 0) return { ambiguous: false, collisions: [] };
  if (positions.length > MEMORY_AMBIGUITY_MAX_DASHES) {
    return { ambiguous: true, collisions: [], reason: "too-many-dashes" };
  }
  const own = new Set(ownPaths.map((p) => path.resolve(p)));
  const collisions = [];
  for (let mask = 0; mask < 1 << positions.length; mask++) {
    const chars = [...slug];
    chars[0] = "/";
    for (let b = 0; b < positions.length; b++) if (mask & (1 << b)) chars[positions[b]] = "/";
    const candidate = chars.join("");
    if (own.has(path.resolve(candidate))) continue;
    if (existsSync(candidate)) {
      let isDir = false;
      try {
        isDir = statSync(candidate).isDirectory();
      } catch {
        /* raced away — treat as non-collision */
      }
      if (isDir) collisions.push(candidate);
    }
  }
  return { ambiguous: collisions.length > 0, collisions };
}

/** Copy one regular file with the §2.3 re-read rule (sha256 + size, ≤3 attempts). */
function copyFileVerified(src, destDir, name, hooks) {
  const dest = path.join(destDir, name);
  for (let i = 1; i <= COPY_MAX_ATTEMPTS; i++) {
    const content = readFileSync(src);
    const digest = sha256(content);
    if (existsSync(dest)) {
      try {
        if (readFileSync(dest).equals(content)) return { src, dest, status: "skipped", attempts: i };
      } catch {
        return { src, dest, status: "conflict", reason: "destination-exists-unreadable" };
      }
      return { src, dest, status: "conflict", reason: "destination-exists-differs" };
    }
    writeTmpAtomic(destDir, name, content);
    if (typeof hooks?.beforeVerify === "function") {
      try {
        hooks.beforeVerify({ src, attempt: i, content });
      } catch {
        /* seam */
      }
    }
    const again = readFileSync(src);
    if (sha256(again) === digest && again.length === content.length) {
      const st = statSync(src);
      try {
        utimesSync(dest, st.atime, st.mtime);
      } catch {
        /* best-effort */
      }
      return { src, dest, status: "complete", attempts: i };
    }
  }
  return { src, dest, status: "partial", reason: "source-appended" };
}

/**
 * Copy one memory slug dir into `destDir`. The slug dir itself may be a user-trusted symlink —
 * resolved ONCE here; everything below is walked without following any further links.
 * File-level symlinks and non-regular entries are skipped and reported (never copied).
 */
export function copyMemoryDir({ srcDir, destDir, hooks }) {
  const realSrc = realpathSync(srcDir); // throws if missing — caller checks existence first
  mkdirSync(destDir, { mode: DIR_MODE, recursive: true });
  const files = [];
  const skipped = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (st.isDirectory()) {
        mkdirSync(path.join(destDir, childRel), { mode: DIR_MODE, recursive: true });
        walk(full, childRel);
        try {
          utimesSync(path.join(destDir, childRel), st.atime, st.mtime);
        } catch {
          /* best-effort */
        }
      } else if (st.isFile()) {
        try {
          files.push(copyFileVerified(full, destDir, childRel, hooks));
        } catch (error) {
          files.push({
            src: full,
            dest: path.join(destDir, childRel),
            status: "partial",
            reason: `copy-failed:${String(error?.message ?? error)}`,
          });
        }
      } else {
        skipped.push({ path: full, kind: st.isSymbolicLink() ? "symlink" : st.isFIFO() ? "fifo" : "other" });
      }
    }
  };
  walk(realSrc, "");
  return {
    srcDir,
    srcDirReal: realSrc,
    destDir,
    files,
    skipped,
    counts: {
      complete: files.filter((f) => f.status === "complete").length,
      skippedFiles: files.filter((f) => f.status === "skipped").length,
      partial: files.filter((f) => f.status === "partial").length,
      conflict: files.filter((f) => f.status === "conflict").length,
      nonRegular: skipped.length,
    },
  };
}

/**
 * Copy the project's memory into the vault: exact slugs only (literal + realpath), ambiguity
 * check per slug, all copying into ONE destination dir keyed by `memorySlug(newRoot)`.
 * Old dirs are never touched; their paths are returned for the manual-cleanup listing.
 */
export function copyProjectMemory({ root, rootRealpath, newRoot, memoryRoot, destMemoryRoot, hooks }) {
  const slugs = memoryExactSlugs({ root, memoryRoot, rootRealpath });
  const destSlug = memorySlug(path.resolve(newRoot));
  const destDir = path.join(resolveSafe(destMemoryRoot), destSlug);
  const results = [];
  const ambiguity = [];
  const own = [path.resolve(root)];
  if (rootRealpath !== undefined) own.push(path.resolve(rootRealpath));
  else {
    const r = realpathOrNull(root);
    if (r !== undefined) own.push(r);
  }
  for (const { slug, dir, spelling } of slugs) {
    if (!existsSync(dir)) continue;
    const check = checkMemorySlugAmbiguity(slug, own);
    if (check.ambiguous) {
      ambiguity.push({ slug, dir, collisions: check.collisions, reason: check.reason });
      continue;
    }
    results.push(copyMemoryDir({ srcDir: dir, destDir, hooks }));
  }
  return { root, newRoot, destDir, destSlug, results, ambiguity, sourceListed: slugs.map((s) => s.dir) };
}

// ───────────────────────────── report-only listings (§2.2 #5, R28) ─────────────────────────────

/**
 * List files under extra dirs (consult fork cache, web-hub `spawn/fork-src/`) whose session
 * header cwd falls inside the match roots — plaintext copies the user should know about (R12).
 * Read-only; bounded by PARENT_SCAN_* caps.
 */
export function listForeignHeaderMatches(dirs, matchRoots, { maxFiles = PARENT_SCAN_MAX_FILES } = {}) {
  const matches = [];
  let truncated = false;
  for (const dir of dirs) {
    const scan = scanSessionDir(resolveSafe(dir));
    if (scan.missing) continue;
    for (const f of scan.files) {
      if (matches.length >= maxFiles) {
        truncated = true;
        break;
      }
      const cwd = typeof f.header?.cwd === "string" ? f.header.cwd : undefined;
      if (cwd !== undefined && matchWithinRoots(cwd, matchRoots) !== undefined) {
        matches.push({ file: f.file, cwd });
      }
    }
  }
  return { matches, truncated };
}

/**
 * R28: sessions in OTHER projects whose header `parentSession` points at a file in our copy
 * set (forks created from this project's sessions). Listed only — never copied or touched.
 */
export function findParentLinks({
  agentSessionsRoot,
  extraDirs = [],
  copySetPaths,
  maxDirs = PARENT_SCAN_MAX_DIRS,
  maxFiles = PARENT_SCAN_MAX_FILES,
}) {
  const targets = new Set([...copySetPaths].map((p) => path.resolve(p)));
  const dirs = [];
  const root = resolveSafe(agentSessionsRoot);
  try {
    dirs.push(...readdirSync(root).map((n) => path.join(root, n)));
  } catch {
    /* no sessions root */
  }
  dirs.push(...extraDirs.map((d) => resolveSafe(d)));
  const links = [];
  let truncated = false;
  let filesScanned = 0;
  for (const dir of dirs.slice(0, maxDirs)) {
    const scan = scanSessionDir(dir);
    if (scan.missing) continue;
    for (const f of scan.files) {
      if (++filesScanned > maxFiles) {
        truncated = true;
        break;
      }
      const parent = typeof f.header?.parentSession === "string" ? f.header.parentSession : undefined;
      if (parent === undefined) continue;
      if (targets.has(path.resolve(parent))) links.push({ file: f.file, parentSession: parent });
    }
  }
  return { links, truncated, filesScanned };
}

// ───────────────────────────── relocation engine (§3.4) ─────────────────────────────

/** `<realWork>` ⇒ `<mnt>/state/sessions/default` (realWork must end in `/work`). */
export function stateSessionsDirFor(realWork) {
  const p = path.resolve(realWork);
  if (!p.endsWith("/work")) {
    throw new SessionsError(`realWork 必须以 /work 结尾：${p}`, "bad-realwork");
  }
  return `${p.slice(0, -"/work".length)}/state/sessions/default`;
}

/** Segment-aligned prefix replace: p === from or p starts with from+"/" ⇒ to + remainder. */
export function rewritePathPrefix(p, from, to) {
  const abs = path.resolve(p);
  const f = path.resolve(from);
  if (abs === f) return path.resolve(to);
  if (abs.startsWith(f + path.sep)) return path.join(path.resolve(to), abs.slice(f.length + 1));
  return undefined;
}

/**
 * Pure relocation rewrite of one session file's content (§3.4 step 2):
 *  - header cwd: `from` → `to` (segment-aligned);
 *  - header parentSession and every `subagent:run` diag.sessionFile:
 *    `fromSessionsDir` → `toSessionsDir` (segment-aligned).
 * Malformed/blank lines and non-matching values pass through byte-identical, which makes the
 * whole operation idempotent (a second run matches no prefix and writes nothing).
 */
export function relocateSessionContent(content, { from, to, fromSessionsDir, toSessionsDir }) {
  const text = content.toString("utf8");
  const lines = text.split("\n");
  let sawHeader = false;
  const changed = { cwd: 0, parentSession: 0, runRefs: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    if (!sawHeader && parsed.type === "session") {
      sawHeader = true;
      if (typeof parsed.cwd === "string") {
        const next = rewritePathPrefix(parsed.cwd, from, to);
        if (next !== undefined) {
          parsed.cwd = next;
          changed.cwd++;
          lines[i] = JSON.stringify(parsed);
        }
      }
      if (typeof parsed.parentSession === "string") {
        const next = rewritePathPrefix(parsed.parentSession, fromSessionsDir, toSessionsDir);
        if (next !== undefined) {
          parsed.parentSession = next;
          changed.parentSession++;
          lines[i] = JSON.stringify(parsed);
        }
      }
      continue;
    }
    if (parsed.type === "custom" && parsed.customType === SUBAGENT_RUN_CUSTOM_TYPE) {
      const sessionFile =
        isPlainObject(parsed.data) && isPlainObject(parsed.data.diag) ? parsed.data.diag.sessionFile : undefined;
      if (typeof sessionFile === "string") {
        const next = rewritePathPrefix(sessionFile, fromSessionsDir, toSessionsDir);
        if (next !== undefined) {
          parsed.data.diag.sessionFile = next;
          changed.runRefs++;
          lines[i] = JSON.stringify(parsed);
        }
      }
    }
  }
  const out = lines.join("\n");
  return {
    content: Buffer.from(out, "utf8"),
    changed,
    anyChange: changed.cwd + changed.parentSession + changed.runRefs > 0,
  };
}

/**
 * Relocate every `*.jsonl` under `dir` in place (per-file tmp+rename, 0600, fsync; mtime/atime
 * preserved). Unchanged files are left untouched (re-entrant). `onProgress(filesDone)` fires
 * every batch so V5 can advance the transaction `phase`.
 */
export function relocateSessionsInDir(dir, rules, { onProgress, batchSize = 50 } = {}) {
  const abs = resolveSafe(dir);
  let names;
  try {
    names = readdirSync(abs);
  } catch (error) {
    return { dir: abs, error: String(error?.message ?? error), changed: 0, unchanged: 0, files: [] };
  }
  const files = [];
  let changed = 0;
  let unchanged = 0;
  let done = 0;
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    const file = path.join(abs, name);
    let st;
    try {
      st = statSync(file);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let result;
    try {
      const content = readFileSync(file);
      result = relocateSessionContent(content, rules);
      if (result.anyChange) {
        writeTmpAtomic(abs, name, result.content);
        try {
          utimesSync(file, st.atime, st.mtime);
        } catch {
          /* best-effort */
        }
        changed++;
      } else {
        unchanged++;
      }
    } catch (error) {
      files.push({ file, error: String(error?.message ?? error) });
      continue;
    }
    files.push({ file, changed: result.anyChange, counts: result.changed });
    if (++done % batchSize === 0 && typeof onProgress === "function") onProgress(done);
  }
  if (typeof onProgress === "function") onProgress(done);
  return { dir: abs, changed, unchanged, files };
}

/**
 * §3.4 step 3: rename `state/memory/<toSlug(from)>` to `state/memory/<toSlug(to)>` inside the
 * vault. Target exists ⇒ NO merge, report only. Source missing ⇒ no-op success.
 */
export function relocateMemoryDir(memoryRoot, { from, to }) {
  const root = resolveSafe(memoryRoot);
  const fromDir = path.join(root, memorySlug(path.resolve(from)));
  const toDir = path.join(root, memorySlug(path.resolve(to)));
  if (!existsSync(fromDir)) return { renamed: false, fromDir, toDir, reason: "absent" };
  if (existsSync(toDir)) return { renamed: false, fromDir, toDir, reason: "target-exists" };
  try {
    renameSync(fromDir, toDir);
  } catch (error) {
    return { renamed: false, fromDir, toDir, reason: `rename-failed:${String(error?.message ?? error)}` };
  }
  return { renamed: true, fromDir, toDir };
}

// ───────────────────────────── one-shot orchestration + report (§2.2–§2.5) ─────────────────────────────

/**
 * Discover + plan + copy everything for `convert` step 10 (§1.4). `root` is the ORIGINAL
 * project path (pre-rename — that is what session headers recorded), `newRoot` the vault
 * `<realWork>`. Sources are read read-only; destinations live under `destStateDir`
 * (`<state>/sessions/default` and `<state>/memory`). Returns a JSON-serializable report —
 * V4 prints the manual-cleanup listing from `formatManualCleanup`.
 */
export function convertCopySessionsAndMemory({
  root,
  /** Pre-rename realpath spelling of `root` (captured before the backup rename); see
   *  discoverSessionSources. Omitted ⇒ the current on-disk realpath (pre-rename usage). */
  rootRealpath,
  treeRoot,
  newRoot,
  agentDir,
  home,
  memoryRoot,
  destStateDir,
  globalSessionDir,
  envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR,
  extraDirs = [],
  budgets,
  hooks,
}) {
  const roots = [path.resolve(root)];
  const rootReal = rootRealpath !== undefined ? path.resolve(rootRealpath) : realpathOrNull(root);
  if (rootReal !== undefined && rootReal !== roots[0]) roots.push(rootReal);

  const discovery = discoverSessionSources({
    root,
    rootRealpath,
    treeRoot,
    agentDir,
    home,
    globalSessionDir,
    envSessionDir,
    extraDirs,
  });
  const plan = planSessionCopy({ sources: discovery.sources, matchRoots: roots, newRoot, budgets });
  const sessions = copySessions({ plan, destDir: path.join(resolveSafe(destStateDir), "sessions", "default"), hooks });
  const memory = copyProjectMemory({
    root,
    rootRealpath,
    newRoot,
    memoryRoot,
    destMemoryRoot: path.join(resolveSafe(destStateDir), "memory"),
    hooks,
  });
  return { root, roots, discovery, plan, sessions, memory };
}

/**
 * Manual-cleanup listing for the completion output (§2.3 last bullet, §1.7): old session
 * files/dirs and old memory dirs, grouped, with copy-paste `rm` lines. Report-only.
 */
export function formatManualCleanup(report) {
  const lines = [];
  const dirs = [...new Set(report.discovery.sources.map((s) => s.dir))];
  const copiedFiles = report.sessions.files.map((f) => f.src);
  lines.push("旧会话目录（确认保险库内容无误后可手动删除）：");
  if (dirs.length > 0) {
    for (const dir of dirs) lines.push(`  ${dir}`);
  } else {
    lines.push("  （无候选目录）");
  }
  if (copiedFiles.length > 0) {
    lines.push("旧会话文件（已复制进保险库）：");
    for (const f of copiedFiles) lines.push(`  ${f}`);
    // ARG_MAX-safe: chunk the rm suggestions at 50 files per line.
    for (let i = 0; i < copiedFiles.length; i += 50) {
      lines.push(
        `  rm -- ${copiedFiles
          .slice(i, i + 50)
          .map((f) => `'${f}'`)
          .join(" ")}`,
      );
    }
  } else {
    lines.push("  （无入选会话）");
  }
  const memoryDirs = report.memory.sourceListed.filter((d) => existsSync(d));
  lines.push("旧 memory 目录：");
  if (memoryDirs.length > 0) {
    for (const d of memoryDirs) lines.push(`  ${d}`);
    for (const d of memoryDirs) lines.push(`  rm -rf -- '${d}'`);
  } else {
    lines.push("  （无）");
  }
  if (report.memory.ambiguity.length > 0) {
    lines.push("memory 因 slug 歧义被跳过（人工确认后手动复制）：");
    for (const a of report.memory.ambiguity)
      lines.push(`  ${a.dir}（与 ${a.collisions.join(", ") || "过多解码组合"} 歧义）`);
  }
  return lines.join("\n");
}
