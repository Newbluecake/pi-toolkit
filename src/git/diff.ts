/**
 * Pure argv builders and NUL-terminated-output parsers for the web-hub
 * "worktree file diff" feature (worktree-diff plan v3, §1.8 / §3.1.2 — D1 git layer).
 *
 * This module is hub-reachable through the web-hub boundary test's exact-file
 * allowlist and therefore carries a hard closure requirement: it must import
 * NOTHING (tests/web-hub/boundary.test.ts pins `diff.ts → {}`). Everything here
 * is a pure function over strings/arrays — no fs, no child_process, no pi
 * imports, and no imports from web-hub protocol either (protocol constants are
 * deliberately mirrored, not imported; see WTDIFF_DRIVER_SCAN_MAX).
 *
 * Byte-format notes (git 2.53, verified against real output):
 * - `status --porcelain=v2 -z --branch`: every header line AND every record is
 *   NUL-terminated. A `2` (rename/copy) record carries its orig path as the
 *   next NUL-terminated field. Paths are unmunged (may contain spaces/CR/LF).
 * - `diff-index --numstat -z -M`: entries are `<add>\t<del>\t<path>` NUL;
 *   renames are `<add>\t<del>\t` NUL `<orig>` NUL `<path>` NUL (the path field
 *   of the first token is EMPTY); binary files show `-` for both counters.
 * - `config --null --get-regexp <re>`: each match is `<key>\n<value>` NUL.
 * - `check-attr -z --source=<oid> filter -- <paths>`: `<path>` NUL `filter` NUL
 *   `<value>` NUL per path ("unspecified" when unbound).
 */

/** Fixed PATH for the minimal env policy (§2.7): git and its builtins live here. */
export const WTDIFF_GIT_PATH = "/usr/bin:/bin";

/** Empty-tree oids per object format (both verified via `git hash-object -t tree --no-filters /dev/null`). */
export const WTDIFF_EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

/**
 * The pinned argv prefix shared with run.ts's `PINNED_PREFIX`. run.ts must not
 * import this file (its closure table is `run.ts → {node:child_process}`), so
 * the constant is duplicated here; tests/git pins both copies byte-equal.
 */
export const WT_PINNED_PREFIX: readonly string[] = [
  "-C",
  "/proc/self/fd/3",
  "--git-dir=/proc/self/fd/4",
  "--work-tree=/proc/self/fd/3",
];

/** Must stay equal to protocol `WTDIFF_DRIVERS_MAX` (src/git never imports web-hub protocol). */
export const WTDIFF_DRIVER_SCAN_MAX = 16;

export interface StatusV2ZEntry {
  path: string;
  orig?: string;
  xy: string;
  kind: "1" | "2" | "u" | "?";
}

export interface StatusV2Z {
  oid: string | "(initial)" | undefined;
  entries: StatusV2ZEntry[];
  capped: boolean;
}

function nulTokens(stdout: string, capped: boolean): string[] {
  const tokens = stdout.split("\0");
  // A capped stream can cut a record in half; the trailing partial token is
  // dropped. (A cap landing exactly on a NUL leaves a trailing "" whose loss is
  // harmless.)
  return capped ? tokens.slice(0, -1) : tokens;
}

/**
 * Split on single spaces into exactly `limit` fields where the LAST field is
 * the verbatim remainder (JS `split(s, n)` truncates instead — paths containing
 * spaces would be cut). Returns undefined when there are fewer than `limit`
 * space-separated fields.
 */
function splitFields(token: string, limit: number): string[] | undefined {
  const parts: string[] = [];
  let rest = token;
  while (parts.length < limit - 1) {
    const index = rest.indexOf(" ");
    if (index < 0) return undefined;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  parts.push(rest);
  return parts;
}

export function parseStatusV2Z(stdout: string, capped: boolean): StatusV2Z {
  const tokens = nulTokens(stdout, capped);
  let oid: string | "(initial)" | undefined;
  const entries: StatusV2ZEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (token.startsWith("#")) {
      const match = token.match(/^# branch\.oid (.+)$/);
      if (match !== null) oid = match[1]!;
      continue;
    }
    const kind = token[0];
    if (kind === "?") {
      const path = token.slice(2);
      // Defensive: `--untracked-files=all` never emits directory records, but a
      // path ending in "/" is not a requestable file — drop it.
      if (path.length === 0 || path.endsWith("/")) continue;
      entries.push({ path, xy: "?", kind: "?" });
      continue;
    }
    if (kind === "!") continue; // ignored files are not part of the changeset
    if (kind === "1" || kind === "u") {
      const limit = kind === "1" ? 9 : 11;
      const parts = splitFields(token, limit);
      if (parts === undefined) continue;
      const xy = parts[1]!;
      const path = parts[limit - 1]!;
      if (xy.length !== 2 || path.length === 0) continue;
      entries.push({ path, xy, kind });
      continue;
    }
    if (kind === "2") {
      const parts = splitFields(token, 10);
      if (parts === undefined) continue;
      const xy = parts[1]!;
      const path = parts[9]!;
      // The orig path is the next NUL-terminated field; a `2` record without it
      // (only possible on a capped cut) is unusable — drop.
      const orig = tokens[i + 1];
      if (xy.length !== 2 || path.length === 0 || orig === undefined || orig.length === 0) continue;
      entries.push({ path, orig, xy, kind: "2" });
      i++;
      continue;
    }
    // Unknown record kinds are ignored (forward compat).
  }
  return { oid, entries, capped };
}

export interface NumstatZEntry {
  path: string;
  orig?: string;
  add: number | null;
  del: number | null;
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

export function parseNumstatZ(stdout: string, capped: boolean): NumstatZEntry[] {
  const tokens = nulTokens(stdout, capped);
  const entries: NumstatZEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const match = token.match(NUMSTAT_RE);
    if (match === null) continue;
    const add = match[1] === "-" ? null : Number(match[1]);
    const del = match[2] === "-" ? null : Number(match[2]);
    const path = match[3]!;
    if (path === "") {
      // Rename/copy: the next two NUL fields are <orig> then <path>.
      const orig = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (orig === undefined || orig.length === 0 || newPath === undefined || newPath.length === 0) continue;
      entries.push({ path: newPath, orig, add, del });
      i += 2;
      continue;
    }
    entries.push({ path, add, del });
  }
  return entries;
}

/**
 * Collapse a status entry to the wire status letter (plan §3.3):
 * `?`→`?`; `u`→`U`; `2`→X (R/C); `1`: X=A∧Y=D→null (dropped), X=A→A,
 * X/Y=D→D, X/Y=T→T, otherwise M.
 */
export function combinedStatus(e: StatusV2ZEntry): "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | null {
  if (e.kind === "?") return "?";
  if (e.kind === "u") return "U";
  if (e.xy.length !== 2) return null;
  const x = e.xy[0]!;
  const y = e.xy[1]!;
  if (e.kind === "2" && (x === "R" || x === "C")) return x;
  if (x === "A" && y === "D") return null;
  if (x === "A") return "A";
  if (x === "D" || y === "D") return "D";
  if (x === "T" || y === "T") return "T";
  return "M";
}

const HEAD_PROBE_RE = /^(sha1|sha256)\n([0-9a-f]+)\n?$/;

/** Parse C0's two-line `rev-parse --show-object-format <ref>` output. */
export function parseHeadProbe(stdout: string): { format: "sha1" | "sha256"; oid: string } | null {
  const match = stdout.match(HEAD_PROBE_RE);
  if (match === null) return null;
  const format = match[1] as "sha1" | "sha256";
  const oid = match[2]!;
  if (oid.length !== (format === "sha1" ? 40 : 64)) return null;
  return { format, oid };
}

/** Safe driver name: the only strings allowed into `-c filter.<n>.*` argv slots. */
export const WTDIFF_DRIVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DRIVER_KEY_RE = /^(?:filter|diff)\.(.+)\.(?:clean|smudge|process|required|textconv|command)$/i;

/** Parse Cc (`config --null --get-regexp`); a capped scan or unsafe name is `unsafe` (fail-closed). */
export function parseDriverScan(stdout: string, capped: boolean): { names: string[] } | { unsafe: true } {
  if (capped) return { unsafe: true };
  const tokens = stdout.split("\0");
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    const key = token.split("\n", 1)[0]!;
    const match = key.match(DRIVER_KEY_RE);
    if (match === null) continue;
    const name = match[1]!;
    if (!WTDIFF_DRIVER_NAME_RE.test(name)) return { unsafe: true };
    names.add(name);
  }
  if (names.size > WTDIFF_DRIVER_SCAN_MAX) return { unsafe: true };
  return { names: [...names].sort() };
}

const ATTR_DRIVER_RE = /(?:^|\s)[-!]?(?:filter|diff)=(\S+)/gi;

/**
 * Superset extraction of driver names from `$GIT_COMMON_DIR/info/attributes`
 * (the only attribute source L1 cannot switch off). Covers plain lines, macro
 * definition lines (`[attr]m filter=p`) and negated/unset attrs (`-filter`/`!filter`).
 */
export function driverNamesFromAttributes(text: string): { names: string[] } | { unsafe: true } {
  const names = new Set<string>();
  for (const match of text.matchAll(ATTR_DRIVER_RE)) {
    const name = match[1]!;
    if (!WTDIFF_DRIVER_NAME_RE.test(name)) return { unsafe: true };
    names.add(name);
  }
  return { names: [...names].sort() };
}

/**
 * L2 neutralization (§2.6.2): unconditionally blank every filter/diff command
 * slot for EVERY known driver name — including names that have no command right
 * now (a command written between scan and execution still lands on a blanked
 * key; command-line `-c` has the highest precedence). Names failing
 * WTDIFF_DRIVER_NAME_RE are skipped; callers must validate the union first and
 * answer 415 `filter-config` instead of ever reaching here with such a name.
 */
export function neutralizeArgs(names: readonly string[]): string[] {
  const args: string[] = [];
  for (const name of names) {
    if (!WTDIFF_DRIVER_NAME_RE.test(name)) continue;
    args.push(
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
      "-c",
      `diff.${name}.textconv=`,
      "-c",
      `diff.${name}.command=`,
    );
  }
  return args;
}

/** L1 attribute-source shrink (§2.6.2): replace all attribute sources with the empty tree. */
export function attrSourceArgs(format: "sha1" | "sha256"): string[] {
  return [`--attr-source=${WTDIFF_EMPTY_TREE[format]}`, "-c", "core.attributesFile=/dev/null"];
}

/** Parse Ca (`check-attr -z ... filter -- <paths>`): path → filter attribute value. */
export function parseCheckAttrZ(stdout: string): Map<string, string> {
  const tokens = stdout.split("\0");
  const result = new Map<string, string>();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const path = tokens[i]!;
    const attr = tokens[i + 1]!;
    const value = tokens[i + 2]!;
    if (path.length === 0 || attr !== "filter") continue;
    result.set(path, value);
  }
  return result;
}

const DRIVER_SCAN_REGEXP = "^(filter|diff)\\..+\\.(clean|smudge|process|required|textconv|command)$";
const X_ARGS = ["-c", "core.bigFileThreshold=16m", "-c", "diff.suppressBlankEmpty=false"] as const;
const CHECK_ATTR_MAX_PATHS_PER_BATCH = 200;
const CHECK_ATTR_MAX_ARGV_BYTES = 128 * 1024;
const CHECK_ATTR_MAX_BATCHES = 5;

function pinnedBase(): string[] {
  return [...WT_PINNED_PREFIX, "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=true"];
}

function argvBytes(args: readonly string[]): number {
  let total = 0;
  for (const arg of args) total += Buffer.byteLength(arg, "utf8");
  return total;
}

/**
 * Frozen argv constructors (§1.8). Everything returned here starts (for the
 * pinned commands) with the pinned prefix; request-derived values appear only
 * after a `--` pathspec terminator or in the explicit-oid slot.
 */
export const wtDiffArgs: {
  /** C1a — repo locate (admission phase, NOT pinned). */
  commonDir(cwd: string): string[];
  /** C1 — membership (admission phase, NOT pinned). */
  worktreeList(cwd: string): string[];
  /** C0 — the request's single HEAD resolution point (pinned). */
  head(): string[];
  /** Cc — driver scan over config as seen from the pinned chain (pinned). */
  driverScan(): string[];
  /** C2 — changeset (pinned; L1 + L2 supplied by the caller). */
  status(l1: string[], n: string[], untracked: "all" | "no"): string[];
  /** Ca — filter marking via check-attr against the immutable base tree (pinned, batched). */
  checkAttr(oid: string, paths: string[]): string[][];
  /** C3 — numstat counts against the explicit C0 oid (pinned). */
  numstat(l1: string[], n: string[], oid: string): string[];
  /** C4 — single-file patch against the explicit C0 oid (pinned). */
  diff(l1: string[], n: string[], oid: string, path: string, orig?: string): string[];
} = {
  commonDir(cwd) {
    return ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"];
  },
  worktreeList(cwd) {
    return ["-C", cwd, "worktree", "list", "--porcelain"];
  },
  head() {
    return [...pinnedBase(), "rev-parse", "--show-object-format", "HEAD"];
  },
  driverScan() {
    return [...pinnedBase(), "config", "--null", "--get-regexp", DRIVER_SCAN_REGEXP];
  },
  status(l1, n, untracked) {
    return [
      ...pinnedBase(),
      ...l1,
      ...X_ARGS,
      ...n,
      "-c",
      "status.renames=true",
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      `--untracked-files=${untracked}`,
      "--ignore-submodules=all",
    ];
  },
  checkAttr(oid, paths) {
    const base = [...pinnedBase(), "check-attr", "-z", `--source=${oid}`, "filter", "--"];
    const baseBytes = argvBytes(base);
    const batches: string[][] = [];
    let current: string[] = [];
    let currentBytes = baseBytes;
    for (const path of paths) {
      if (batches.length >= CHECK_ATTR_MAX_BATCHES) break;
      const pathBytes = argvBytes([path]);
      if (baseBytes + pathBytes > CHECK_ATTR_MAX_ARGV_BYTES) continue; // single path can never fit — left uncovered (fail-closed at the caller)
      if (current.length >= CHECK_ATTR_MAX_PATHS_PER_BATCH || currentBytes + pathBytes > CHECK_ATTR_MAX_ARGV_BYTES) {
        batches.push([...base, ...current]);
        current = [];
        currentBytes = baseBytes;
        if (batches.length >= CHECK_ATTR_MAX_BATCHES) break;
      }
      current.push(path);
      currentBytes += pathBytes;
    }
    if (current.length > 0 && batches.length < CHECK_ATTR_MAX_BATCHES) batches.push([...base, ...current]);
    return batches;
  },
  numstat(l1, n, oid) {
    return [
      ...pinnedBase(),
      ...l1,
      ...X_ARGS,
      ...n,
      "diff-index",
      "--numstat",
      "-z",
      "-M",
      "--no-textconv",
      "--no-ext-diff",
      "--ignore-submodules=all",
      oid,
    ];
  },
  diff(l1, n, oid, path, orig) {
    return [
      ...pinnedBase(),
      ...l1,
      ...X_ARGS,
      ...n,
      "diff-index",
      "-p",
      "-M",
      "--unified=3",
      "--no-color",
      "--no-textconv",
      "--no-ext-diff",
      "--ignore-submodules=all",
      oid,
      "--",
      ...(orig !== undefined ? [orig] : []),
      path,
    ];
  },
};
