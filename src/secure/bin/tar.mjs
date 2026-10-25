// pi-secure package format `pi-secure-vault/2` (docs/dev/data-encryption/convert-plan.md §3.1/§3.3,
// package V1): a minimal pax writer, a budgeted validating reader, the MANIFEST (symlinks and hardlink
// groups are encoded ONLY there, never as tar link members), one unified package-path validator and
// conflict table shared by tar members and MANIFEST entries, link rebuilding confined to the staging
// root, and a strict `gocryptfs.conf` check.
//
// Plain ESM, ZERO dependencies beyond Node ≥22 built-ins, Linux only (the reader anchors every
// creation on a held `O_DIRECTORY|O_NOFOLLOW` fd of the staging root through `/proc/self/fd/<n>`).
// Everything here is synchronous and free of process-level side effects: V5 (`archive.mjs`) runs it
// inside a supervised worker (`__convert-work`, §5) and owns the transaction around it (staging
// directory creation, registration, publication, cleanup policy).
//
// Error model: every refusal is a `PkgError` with an `exitCode` (65 = bad package/content, 74 = IO)
// and a stable machine `reason`. Never trust a package: a refusal may happen after partial staging
// writes — the caller discards the staging root (`discardStaging`), which only ever touches entries
// inside it.
import crypto from "node:crypto";
import { constants as fsc } from "node:fs";
import fs from "node:fs";
import path from "node:path";

// ───────────────────────────── format constants ─────────────────────────────

export const PKG_FORMAT = "pi-secure-vault";
export const PKG_VERSION = 2;
export const PKG_ROOT = "pi-secure-vault";
export const PKG_CIPHER = "pi-secure-vault/cipher";
export const PKG_MANIFEST = "pi-secure-vault/MANIFEST.json";
/** Name of every pax `x` header's own ustar record (the reader requires exactly this). */
export const PKG_PAX_NAME = "pi-secure-vault/PaxHeader";
export const PKG_CONF = "pi-secure-vault/cipher/gocryptfs.conf";
export const PKG_DIRIV = "pi-secure-vault/cipher/gocryptfs.diriv";

export const EXIT_CONTENT = 65;
export const EXIT_IO = 74;

/** Kept in lockstep with helper.mjs `VAULT_NAME_RE` (tests/secure/tar.test.ts pins the equality). */
export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Hard upper bounds (§3.3 step 4). `budget` options passed to the API can only TIGHTEN them. */
export const BUDGET = Object.freeze({
  /** budget units (see `entryUnits`): dir + file members + MANIFEST link entries + 1 (the MANIFEST member) */
  maxEntries: 1_000_000,
  maxManifestBytes: 64 * 1024 * 1024,
  /** cumulative bytes of every admitted path (members + links). A valid package lists each path in the
   *  MANIFEST, so this equals the MANIFEST cap; it bounds the path/conflict tables BEFORE the MANIFEST
   *  (which comes last) can be checked. */
  maxPathBytesTotal: 64 * 1024 * 1024,
  maxPaxBytes: 64 * 1024,
  maxConfBytes: 64 * 1024,
  /** segments after `pi-secure-vault/` (`cipher` = 1) */
  maxDepth: 64,
  maxPathBytes: 4096,
  maxSegmentBytes: 255,
  maxSymlinkTargetBytes: 4096,
  maxMtimeSec: 2 ** 41,
});

/**
 * scrypt resource ceiling for an UNTRUSTED gocryptfs.conf (security review V1 #1). scrypt's working set is
 * ≈ 128·N·R bytes and its work ∝ N·R·P. gocryptfs's default is N=2^16, R=8, P=1 (64 MiB, XC3); the ceiling
 * allows exactly one doubling (`gocryptfs -init -scryptn 17` ⇒ 128 MiB) and nothing above. A bigger
 * parameter set would let a small package make every later mount / --verify-password burn GiBs of
 * memory (N=2^28 ⇒ 256 GiB) — refused as content (65) before any KDF ever runs. There is deliberately no
 * override: a vault created with -scryptn ≥ 18 cannot be imported (documented residual).
 */
export const SCRYPT_MAX_MEM_BYTES = 128 * 2 ** 17 * 8; // 128 MiB
export const SCRYPT_MAX_WORK = 2 ** 17 * 8 * 1; // N·R·P
/** JSON pre-scan limits (security review V1 #2): checked on the raw text BEFORE JSON.parse. */
const MANIFEST_JSON_DEPTH = 3; // {manifest} → [entries] → {entry}   ({totals} is depth 2)
const CONF_JSON_DEPTH = 2; // {conf} → {ScryptObject} | [FeatureFlags]
const JSON_MAX_STRING = 64 * 1024; // raw characters of one string token (escapes included)
/** value nodes per MANIFEST: ≤7 per entry (object + ≤6 values) + the fixed top/totals part */
const manifestMaxNodes = (b) => 7 * b.maxEntries + 64;
const CONF_MAX_NODES = 64;

/** gocryptfs 1.8 `-init` default flags (XC2/XC3); anything else — PlaintextNames included — is refused. */
export const CONF_FEATURE_FLAGS = Object.freeze(["GCMIV128", "HKDF", "DirIV", "EMENames", "LongNames", "Raw64"]);
const CONF_KEYS = ["Creator", "EncryptedKey", "ScryptObject", "Version", "FeatureFlags"];
const SCRYPT_KEYS = ["Salt", "N", "R", "P", "KeyLen"];
const MANIFEST_KEYS = ["format", "v", "name", "exportedAt", "gocryptfsVersion", "origRealWork", "entries", "totals"];
const TOTALS_KEYS = ["dirs", "files", "symlinks", "hardlinks", "bytes"];
/** null-prototype: an untrusted `type` ("__proto__", "constructor", "toString", …) never hits Object.prototype */
const ENTRY_KEYS = Object.freeze(
  Object.assign(Object.create(null), {
    dir: ["path", "type", "mode", "mtime"],
    file: ["path", "type", "mode", "mtime", "size", "sha256"],
    symlink: ["path", "type", "target_b64", "mtime"],
    hardlink: ["path", "type", "of"],
  }),
);

const BLOCK = 512;
const OCTAL11_MAX = 8 ** 11; // exclusive limit of an 11-digit ustar numeric field (size / mtime)
const CHUNK = 1024 * 1024;
const PROGRESS_BYTES = 64 * 1024 * 1024;
const SEGMENT_RE = /^[A-Za-z0-9._=-]+$/;
const SYMLINK_TARGET_RE = /^[A-Za-z0-9_=-]+$/;
const MTIME_RE = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,9})?$/;
const SIZE_RE = /^(0|[1-9][0-9]{0,15})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXPORTED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const PAX_KEYS = new Set(["path", "size", "mtime"]);
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// ───────────────────────────── errors & small helpers ─────────────────────────────

export class PkgError extends Error {
  /** @param {string} reason stable machine code  @param {string} [detail]  @param {number} [exitCode] */
  constructor(reason, detail = "", exitCode = EXIT_CONTENT) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "PkgError";
    this.reason = reason;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}
const bad = (reason, detail) => new PkgError(reason, detail, EXIT_CONTENT);
const ioErr = (reason, detail) => new PkgError(reason, detail, EXIT_IO);

/** Render any thrown value without ever invoking user-controlled conversions. */
function errText(e) {
  const code = e !== null && typeof e === "object" && typeof e.code === "string" ? e.code : undefined;
  if (code !== undefined) return code;
  return e instanceof Error && typeof e.name === "string" ? e.name : typeof e;
}
/**
 * Error-protocol guard for every exported entry point (security review V1 #4): a `PkgError` passes through,
 * a Node system error (string `code` + numeric `errno`) becomes 74 `io`, ANY other throwable (TypeError,
 * RangeError, …) becomes 65 `internal` — an unexpected failure on untrusted input is a content refusal.
 */
function guard(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PkgError) throw e;
    if (e !== null && typeof e === "object" && typeof e.code === "string" && typeof e.errno === "number")
      throw ioErr("io", e.code);
    throw bad("internal", errText(e));
  }
}

/**
 * The ONE budget unit (security review V1 #5; plan §3.3 「成员与 MANIFEST 条目合计」): every dir/file member,
 * every MANIFEST link entry, plus 1 for the MANIFEST member itself. pax headers are not units (each must be
 * followed by a member). Writer (self-check), streaming reader and the post-MANIFEST total all use it.
 */
export function entryUnits({ dirs = 0, files = 0, links = 0 }) {
  return dirs + files + links + 1;
}
function checkUnits(units, b, what) {
  if (units > b.maxEntries) throw bad("budget-entries", `${units} units (${what}) > ${b.maxEntries}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function sameKeys(obj, keys) {
  const got = Object.keys(obj);
  return got.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}
function safeIntInRange(v, lo, hi) {
  return Number.isSafeInteger(v) && v >= lo && v <= hi;
}
/** A budget override can only lower a limit; unknown keys / non-integers are ignored. */
export function effectiveBudget(override) {
  const out = { ...BUDGET };
  if (isPlainObject(override)) {
    for (const k of Object.keys(BUDGET)) {
      const v = override[k];
      if (Number.isSafeInteger(v) && v >= 0 && v < out[k]) out[k] = v;
    }
  }
  return Object.freeze(out);
}
function decodeUtf8(buf, what) {
  try {
    return utf8.decode(buf);
  } catch {
    throw bad("non-utf8", what);
  }
}
/** Diagnostic rendering that is safe for ANY value (never calls toString/valueOf of untrusted objects). */
function quote(v) {
  if (typeof v === "string") return JSON.stringify(v.slice(0, 200));
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v);
  return `<${Array.isArray(v) ? "array" : typeof v}>`;
}

/**
 * Bounded structural pre-scan of JSON text (security review V1 #2): container nesting depth, value-node
 * count and single string-token length are checked BEFORE `JSON.parse` materializes anything, so a tiny
 * deeply nested or node-dense input cannot exhaust the stack or the heap. It is NOT a validator — JSON.parse
 * still decides syntax; this only has to be conservative (it never under-counts depth or nodes).
 */
function prescanJsonImpl(text, { maxDepth, maxNodes, maxString = JSON_MAX_STRING }, what) {
  if (typeof text !== "string") throw bad("manifest-json", `${what}: not a string`);
  let depth = 0;
  let nodes = 0;
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      const start = i++;
      for (;;) {
        if (i >= n) throw bad("manifest-json", `${what}: unterminated string`);
        const d = text.charCodeAt(i);
        if (d === 0x5c) i += 2;
        else if (d === 0x22) break;
        else i++;
        if (i - start > maxString) throw bad("budget-json", `${what}: string token > ${maxString}`);
      }
      i++;
      let j = i;
      while (
        j < n &&
        (text.charCodeAt(j) === 0x20 ||
          text.charCodeAt(j) === 0x0a ||
          text.charCodeAt(j) === 0x0d ||
          text.charCodeAt(j) === 0x09)
      )
        j++;
      if (text.charCodeAt(j) !== 0x3a) nodes++; // a string that is not a key is a value node
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > maxDepth) throw bad("budget-json", `${what}: nesting deeper than ${maxDepth}`);
      nodes++;
      i++;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
      i++;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39) || c === 0x74 || c === 0x66 || c === 0x6e) {
      nodes++; // number / true / false / null: skip the whole bare token
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (
          (d >= 0x30 && d <= 0x39) ||
          (d >= 0x61 && d <= 0x7a) ||
          (d >= 0x41 && d <= 0x5a) ||
          d === 0x2e ||
          d === 0x2b ||
          d === 0x2d
        )
          i++;
        else break;
      }
    } else i++;
    if (nodes > maxNodes) throw bad("budget-json", `${what}: more than ${maxNodes} JSON values`);
  }
}
function parseJsonBounded(text, limits, what, reason) {
  prescanJsonImpl(text, limits, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof PkgError) throw e;
    throw bad(reason, `${what} is not JSON (${errText(e)})`);
  }
}
/** Display relative staging path for diagnostics (never includes absolute staging paths). */
function relOf(pkgPath) {
  return pkgPath.slice(PKG_ROOT.length + 1); // "cipher/…"
}

// ───────────────────────────── unified package-path validator ─────────────────────────────

/**
 * The ONE path check (§3.3 step 3): tar member paths, every MANIFEST entry `path` and every hardlink
 * `of` go through it. Returns `{ kind: "manifest" }` for the MANIFEST member itself, otherwise
 * `{ kind: "cipher", path, rel, segments, depth, parent }` (`parent` is `null` for the cipher root).
 * Throws `PkgError(65)`.
 */
function checkPkgPathImpl(p, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  if (typeof p !== "string" || p === "") throw bad("path-empty", quote(p));
  if (!p.isWellFormed()) throw bad("non-utf8", "path");
  if (p.includes("\0")) throw bad("path-nul", quote(p));
  if (p.includes("\\")) throw bad("path-backslash", quote(p));
  if (p.startsWith("/")) throw bad("path-absolute", quote(p));
  if (Buffer.byteLength(p, "utf8") > b.maxPathBytes) throw bad("path-too-long", `${Buffer.byteLength(p)} bytes`);
  if (p === PKG_MANIFEST) return { kind: "manifest", path: p };
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "") throw bad("path-empty-segment", quote(p));
    if (s === "." || s === "..") throw bad("path-dot-segment", quote(p));
  }
  if (segments[0] !== PKG_ROOT || segments[1] !== "cipher") throw bad("path-prefix", quote(p));
  for (const s of segments) {
    if (Buffer.byteLength(s, "utf8") > b.maxSegmentBytes) throw bad("segment-too-long", quote(p));
  }
  for (let i = 2; i < segments.length; i++) {
    if (!SEGMENT_RE.test(segments[i])) throw bad("path-bad-char", quote(p));
  }
  const depth = segments.length - 1;
  if (depth > b.maxDepth) throw bad("path-too-deep", `${depth} > ${b.maxDepth}`);
  return {
    kind: "cipher",
    path: p,
    rel: segments.slice(1).join("/"),
    segments,
    depth,
    parent: segments.length > 2 ? segments.slice(0, -1).join("/") : null,
  };
}

/** Pax/MANIFEST mtime grammar: decimal seconds, ≤9 fractional digits, integer part ≤ 2^41. */
function checkMtimeImpl(s, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  if (typeof s !== "string" || !MTIME_RE.test(s)) throw bad("mtime-syntax", quote(s));
  const sec = Number(s.split(".")[0]);
  if (!Number.isSafeInteger(sec) || sec > b.maxMtimeSec) throw bad("mtime-range", s);
  return s;
}
function mtimeSecondsPart(s) {
  return Number(s.split(".")[0]);
}
/** Exact stat → canonical mtime string (`sec[.frac]`, trailing zeros trimmed). */
export function mtimeFromStat(st) {
  const ns = typeof st.mtimeNs === "bigint" ? st.mtimeNs : BigInt(Math.round(st.mtimeMs * 1e6));
  if (ns < 0n) throw bad("mtime-range", "negative");
  const sec = ns / 1_000_000_000n;
  const frac = (ns % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? sec.toString() : `${sec}.${frac}`;
}

// ───────────────────────────── gocryptfs.conf strict check ─────────────────────────────

function strictBase64(s, bytes) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return false;
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s && buf.length === bytes;
}

/**
 * Strict `gocryptfs.conf` validation (§3.3 step 5, XC3): exactly the gocryptfs 1.8 keys, `Version 2`,
 * scrypt parameters in range, `FeatureFlags` ⊆ CONF_FEATURE_FLAGS (PlaintextNames / unknown ⇒ refused).
 * Accepts a Buffer or string; returns the parsed object. Throws `PkgError(65)`.
 */
function validateGocryptfsConfImpl(input, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  if (!Buffer.isBuffer(input) && typeof input !== "string") throw bad("conf-shape", "not a Buffer or string");
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (buf.length > b.maxConfBytes) throw bad("conf-too-large", `${buf.length} bytes`);
  const conf = parseJsonBounded(
    decodeUtf8(buf, "gocryptfs.conf"),
    { maxDepth: CONF_JSON_DEPTH, maxNodes: CONF_MAX_NODES },
    "gocryptfs.conf",
    "conf-json",
  );
  if (!isPlainObject(conf)) throw bad("conf-shape", "not an object");
  for (const k of Object.keys(conf)) if (!CONF_KEYS.includes(k)) throw bad("conf-unknown-key", quote(k));
  if (!sameKeys(conf, CONF_KEYS)) throw bad("conf-missing-key", CONF_KEYS.filter((k) => !(k in conf)).join(","));
  if (conf.Version !== 2) throw bad("conf-version", quote(conf.Version));
  if (typeof conf.Creator !== "string" || !/^gocryptfs [\x20-\x7e]{1,64}$/.test(conf.Creator))
    throw bad("conf-creator", quote(conf.Creator));
  const flags = conf.FeatureFlags;
  if (!Array.isArray(flags) || flags.length > 16 || flags.some((f) => typeof f !== "string"))
    throw bad("conf-flags", "FeatureFlags must be an array of strings");
  if (new Set(flags).size !== flags.length) throw bad("conf-flags", "duplicate flag");
  if (flags.includes("PlaintextNames")) throw bad("conf-plaintext-names", "PlaintextNames vaults are refused");
  for (const f of flags) if (!CONF_FEATURE_FLAGS.includes(f)) throw bad("conf-unknown-flag", quote(f));
  const so = conf.ScryptObject;
  if (!isPlainObject(so) || !sameKeys(so, SCRYPT_KEYS)) throw bad("conf-scrypt", "ScryptObject keys");
  if (!strictBase64(so.Salt, 32)) throw bad("conf-scrypt", "Salt");
  if (!Number.isSafeInteger(so.N) || so.N < 2 ** 10 || so.N > 2 ** 28 || (so.N & (so.N - 1)) !== 0)
    throw bad("conf-scrypt", "N");
  if (so.R !== 8 || so.P !== 1 || so.KeyLen !== 32) throw bad("conf-scrypt", "R/P/KeyLen");
  if (128 * so.N * so.R > SCRYPT_MAX_MEM_BYTES || so.N * so.R * so.P > SCRYPT_MAX_WORK)
    throw bad(
      "conf-scrypt-cost",
      `N=${so.N} R=${so.R} P=${so.P} exceeds the ${SCRYPT_MAX_MEM_BYTES / 2 ** 20} MiB KDF ceiling`,
    );
  // AES-GCM wrapped master key: IV (16 with GCMIV128, else 12) + 32-byte key + 16-byte tag
  if (!strictBase64(conf.EncryptedKey, flags.includes("GCMIV128") ? 64 : 60)) throw bad("conf-key", "EncryptedKey");
  return conf;
}

// ───────────────────────────── MANIFEST validation ─────────────────────────────

/**
 * Structural MANIFEST validation (§3.1): exact key sets, field types/ranges, every `path`/`of` through
 * `checkPkgPath`, totals consistent with the entries. Cross-checks against the tar members are done by
 * the reader. Returns the manifest. Throws `PkgError(65)`.
 */
function validateManifestImpl(m, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  if (!isPlainObject(m)) throw bad("manifest-shape", "not an object");
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.includes(k)) throw bad("manifest-unknown-key", quote(k));
  if (!sameKeys(m, MANIFEST_KEYS)) throw bad("manifest-missing-key", MANIFEST_KEYS.filter((k) => !(k in m)).join(","));
  if (m.format !== PKG_FORMAT) throw bad("manifest-format", quote(m.format));
  if (m.v !== PKG_VERSION) throw bad("manifest-version", quote(m.v));
  if (typeof m.name !== "string" || !VAULT_NAME_RE.test(m.name)) throw bad("manifest-name", quote(m.name));
  if (
    typeof m.exportedAt !== "string" ||
    !EXPORTED_AT_RE.test(m.exportedAt) ||
    !Number.isFinite(Date.parse(m.exportedAt))
  )
    throw bad("manifest-exported-at", quote(m.exportedAt));
  if (typeof m.gocryptfsVersion !== "string" || !/^[\x20-\x7e]{1,200}$/.test(m.gocryptfsVersion))
    throw bad("manifest-gocryptfs-version", quote(m.gocryptfsVersion));
  checkOrigRealWork(m.origRealWork);
  if (!Array.isArray(m.entries)) throw bad("manifest-entries", "not an array");
  // every entry is a unit (dir/file member or link) + 1 for the MANIFEST member itself
  if (m.entries.length + 1 > b.maxEntries) throw bad("budget-entries", `${m.entries.length} MANIFEST entries`);
  const counts = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, bytes: 0 };
  for (const e of m.entries) {
    validateEntry(e, b);
    if (e.type === "dir") counts.dirs++;
    else if (e.type === "file") {
      counts.files++;
      counts.bytes += e.size;
      if (!Number.isSafeInteger(counts.bytes)) throw bad("manifest-totals", "bytes overflow");
    } else if (e.type === "symlink") counts.symlinks++;
    else counts.hardlinks++;
  }
  const t = m.totals;
  if (!isPlainObject(t) || !sameKeys(t, TOTALS_KEYS)) throw bad("manifest-totals", "keys");
  for (const k of TOTALS_KEYS) {
    if (!Number.isSafeInteger(t[k]) || t[k] < 0 || t[k] !== counts[k]) throw bad("manifest-totals", k);
  }
  return m;
}

function checkOrigRealWork(p) {
  if (typeof p !== "string" || !p.isWellFormed() || p.includes("\0")) throw bad("manifest-orig-real-work", quote(p));
  if (Buffer.byteLength(p, "utf8") > 4096) throw bad("manifest-orig-real-work", "too long");
  if (!/^\/.+\/work$/.test(p) || path.posix.normalize(p) !== p) throw bad("manifest-orig-real-work", quote(p));
}

function validateEntry(e, b) {
  if (!isPlainObject(e)) throw bad("manifest-entry", "not an object");
  if (typeof e.type !== "string" || !Object.hasOwn(ENTRY_KEYS, e.type)) throw bad("manifest-entry-type", quote(e.type));
  const keys = ENTRY_KEYS[e.type];
  for (const k of Object.keys(e)) if (!keys.includes(k)) throw bad("manifest-entry-key", `${quote(k)} on ${e.type}`);
  if (!sameKeys(e, keys)) throw bad("manifest-entry-key", `missing on ${e.type}`);
  const p = checkPkgPathImpl(e.path, b);
  if (p.kind !== "cipher") throw bad("manifest-entry-path", quote(e.path));
  if (p.parent === null && e.type !== "dir") throw bad("manifest-entry-path", "cipher root must be a dir");
  if (e.type === "dir" || e.type === "file") {
    if (!safeIntInRange(e.mode, 0, 0o777)) throw bad("mode-range", `${quote(e.path)} mode ${quote(e.mode)}`);
  }
  if (e.type !== "hardlink") checkMtimeImpl(e.mtime, b);
  if (e.type === "file") {
    if (!Number.isSafeInteger(e.size) || e.size < 0) throw bad("manifest-entry-size", quote(e.path));
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) throw bad("manifest-entry-sha256", quote(e.path));
  } else if (e.type === "symlink") {
    checkSymlinkTarget(e.target_b64, b, e.path);
  } else if (e.type === "hardlink") {
    const of = checkPkgPathImpl(e.of, b);
    if (of.kind !== "cipher") throw bad("hardlink-of", quote(e.of));
  }
}

function checkSymlinkTarget(t, b, where) {
  if (typeof t !== "string" || t === "" || !SYMLINK_TARGET_RE.test(t))
    throw bad("symlink-target", `${quote(where)} → ${quote(t)}`);
  if (t.length > b.maxSymlinkTargetBytes) throw bad("symlink-target-too-long", quote(where));
}

// ───────────────────────────── ustar / pax encoding (writer) ─────────────────────────────

function writeStr(buf, off, len, s) {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length > len) throw new Error(`ustar field overflow (${len})`);
  bytes.copy(buf, off);
}
function writeOctal(buf, off, len, n) {
  const digits = n.toString(8);
  if (digits.length > len - 1) throw new Error(`ustar numeric overflow (${len})`);
  writeStr(buf, off, len, digits.padStart(len - 1, "0") + "\0");
}
/** Split into ustar prefix(≤155)/name(≤100) at a `/`; `undefined` when it cannot be represented. */
function splitUstar(p) {
  if (Buffer.byteLength(p) <= 100) return { prefix: "", name: p };
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== "/" || i === p.length - 1) continue;
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== "") return { prefix, name };
  }
  return undefined;
}
function ustarHeader({ name, prefix = "", mode, size, mtime, type }) {
  const h = Buffer.alloc(BLOCK);
  writeStr(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  writeStr(h, 257, 6, "ustar\0");
  writeStr(h, 263, 2, "00");
  writeOctal(h, 329, 8, 0);
  writeOctal(h, 337, 8, 0);
  writeStr(h, 345, 155, prefix);
  let sum = 0;
  for (const byte of h) sum += byte;
  writeStr(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return `${len}${body}`;
}
function padTo(n) {
  return (BLOCK - (n % BLOCK)) % BLOCK;
}

/** Header block(s) for one member: an optional pax `x` record (path/size/mtime only) + the ustar header. */
export function memberHeaders({ path: p, type, mode, size, mtime }) {
  const fullPath = type === "5" ? `${p}/` : p;
  const split = splitUstar(fullPath);
  const sec = mtimeSecondsPart(mtime);
  const recs = [];
  if (split === undefined) recs.push(paxRecord("path", fullPath));
  if (size >= OCTAL11_MAX) recs.push(paxRecord("size", String(size)));
  if (mtime.includes(".") || sec >= OCTAL11_MAX) recs.push(paxRecord("mtime", mtime));
  const out = [];
  if (recs.length > 0) {
    const data = Buffer.from(recs.join(""), "utf8");
    out.push(ustarHeader({ name: PKG_PAX_NAME, mode: 0o600, size: data.length, mtime: 0, type: "x" }));
    out.push(data, Buffer.alloc(padTo(data.length)));
  }
  const fallback = split ?? { prefix: "", name: Buffer.from(fullPath).subarray(-100).toString("latin1") };
  out.push(
    ustarHeader({
      name: fallback.name,
      prefix: fallback.prefix,
      mode,
      size: size >= OCTAL11_MAX ? 0 : size,
      mtime: sec >= OCTAL11_MAX ? 0 : sec,
      type,
    }),
  );
  return Buffer.concat(out);
}

// ───────────────────────────── cipher tree scan + writer ─────────────────────────────

function sortedNames(dir) {
  const names = fs.readdirSync(dir, { encoding: "buffer" });
  names.sort(Buffer.compare);
  return names;
}

/**
 * Walk a gocryptfs cipher directory (lstat only, never follows links) in deterministic pre-order.
 * Returns `[{ pkgPath, abs, type: "dir"|"file"|"symlink"|"hardlink", mode, mtime, size?, target?, of? }]`
 * — the first file of each (dev, ino) group (in walk order) is the content holder, later paths become
 * `hardlink` entries. Hardlinked SYMLINKS (gocryptfs keeps them, XC2) are emitted as independent
 * symlink entries with the same target. Refuses (65) FIFOs/sockets/devices, mode bits beyond 0o777,
 * names or targets outside the cipher alphabet, and budget overruns.
 */
function scanCipherTreeImpl(cipherDir, opts = {}) {
  const b = effectiveBudget(opts.budget);
  const rootSt = lstatBig(cipherDir);
  if (!rootSt.isDirectory()) throw bad("cipher-not-dir", "cipher root is not a directory");
  const entries = [];
  const holders = new Map(); // `${dev}:${ino}` → pkgPath
  const visit = (abs, pkgPath, st) => {
    checkUnits(entryUnits({ files: entries.length + 1 }), b, "export");
    checkPkgPathImpl(pkgPath, b);
    const perm = Number(st.mode & 0o7777n);
    if (st.isSymbolicLink()) {
      const t = fs.readlinkSync(abs, { encoding: "buffer" });
      const target = t.toString("latin1");
      checkSymlinkTarget(target, b, pkgPath);
      entries.push({ pkgPath, abs, type: "symlink", target, mtime: mtimeFromStat(st) });
      return;
    }
    if (perm > 0o777) throw bad("mode-range", `${quote(relOf(pkgPath))} mode ${perm.toString(8)}`);
    if (st.isDirectory()) {
      entries.push({ pkgPath, abs, type: "dir", mode: perm, mtime: mtimeFromStat(st) });
      for (const nb of sortedNames(abs)) {
        const name = nb.toString("latin1");
        if (!SEGMENT_RE.test(name)) throw bad("path-bad-char", quote(`${relOf(pkgPath)}/${name}`));
        const childAbs = path.join(abs, name);
        visit(childAbs, `${pkgPath}/${name}`, lstatBig(childAbs));
      }
      return;
    }
    if (!st.isFile()) throw bad("special-file", quote(relOf(pkgPath)));
    const key = `${st.dev}:${st.ino}`;
    if (st.nlink > 1n && holders.has(key)) {
      entries.push({ pkgPath, abs, type: "hardlink", of: holders.get(key) });
      return;
    }
    if (st.nlink > 1n) holders.set(key, pkgPath);
    entries.push({
      pkgPath,
      abs,
      type: "file",
      mode: perm,
      mtime: mtimeFromStat(st),
      size: Number(st.size),
      dev: st.dev,
      ino: st.ino,
    });
  };
  visit(cipherDir, PKG_CIPHER, rootSt);
  return entries;
}

function lstatBig(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (e) {
    throw ioErr("io", `lstat ${errText(e)}`);
  }
}
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * Write a `pi-secure-vault/2` package of `cipherDir` into the already-open, empty, writable `fd`
 * (V5 owns `<file>.partial-<txid>` O_EXCL creation, fsync and `link()` publication).
 * `meta = { name, gocryptfsVersion, origRealWork, exportedAt? }`. The cipher tree must be static
 * (unmounted, mount.lock held, lease idle — §3.2); any change observed while reading ⇒ PkgError(74).
 * Returns `{ manifest, bytesWritten, members }`.
 */
export function writePackage(opts) {
  return guard(() => writePackageImpl(opts));
}

const SHA256_PLACEHOLDER = "0".repeat(64);

/** The reader's checks, run by the writer on its own MANIFEST text (same budget ⇒ readable back). */
function selfCheckManifest(manifest, b) {
  validateManifestImpl(manifest, b);
  const links = manifest.totals.symlinks + manifest.totals.hardlinks;
  checkUnits(entryUnits({ dirs: manifest.totals.dirs, files: manifest.totals.files, links }), b, "export");
  let pathBytes = 0;
  for (const e of manifest.entries) pathBytes += Buffer.byteLength(e.path, "utf8");
  if (pathBytes > b.maxPathBytesTotal) throw bad("budget-path-bytes", `${pathBytes} path bytes`);
  const text = `${JSON.stringify(manifest)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > b.maxManifestBytes) throw bad("budget-manifest", `${bytes} bytes`);
  prescanJsonImpl(text, { maxDepth: MANIFEST_JSON_DEPTH, maxNodes: manifestMaxNodes(b) }, "MANIFEST.json");
  return text;
}

function writePackageImpl({ cipherDir, fd, name, gocryptfsVersion, origRealWork, exportedAt, budget, onProgress }) {
  const b = effectiveBudget(budget);
  const entries = scanCipherTreeImpl(cipherDir, { budget: b });
  const at = exportedAt ?? new Date().toISOString();
  // MANIFEST first, with placeholder hashes (fixed length): every budget / self-check runs BEFORE a byte is
  // written, so an export the reader would refuse never starts.
  const manifestEntries = [];
  const totals = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, bytes: 0 };
  for (const e of entries) {
    if (e.type === "dir") {
      manifestEntries.push({ path: e.pkgPath, type: "dir", mode: e.mode, mtime: e.mtime });
      totals.dirs++;
    } else if (e.type === "file") {
      e.entry = {
        path: e.pkgPath,
        type: "file",
        mode: e.mode,
        mtime: e.mtime,
        size: e.size,
        sha256: SHA256_PLACEHOLDER,
      };
      manifestEntries.push(e.entry);
      totals.files++;
      totals.bytes += e.size;
    } else if (e.type === "symlink") {
      manifestEntries.push({ path: e.pkgPath, type: "symlink", target_b64: e.target, mtime: e.mtime });
      totals.symlinks++;
    } else {
      manifestEntries.push({ path: e.pkgPath, type: "hardlink", of: e.of });
      totals.hardlinks++;
    }
  }
  const manifest = {
    format: PKG_FORMAT,
    v: PKG_VERSION,
    name,
    exportedAt: at,
    gocryptfsVersion,
    origRealWork,
    entries: manifestEntries,
    totals,
  };
  selfCheckManifest(manifest, b);

  let written = 0;
  let members = 0;
  const emit = (buf) => {
    writeAll(fd, buf);
    written += buf.length;
  };
  for (const e of entries) {
    if (e.type === "dir") {
      emit(memberHeaders({ path: e.pkgPath, type: "5", mode: e.mode, size: 0, mtime: e.mtime }));
    } else if (e.type === "file") {
      emit(memberHeaders({ path: e.pkgPath, type: "0", mode: e.mode, size: e.size, mtime: e.mtime }));
      e.entry.sha256 = copyFileInto(e, fd, (n) => {
        written += n;
        onProgress?.({ phase: "write", members, bytes: written });
      });
      emit(Buffer.alloc(padTo(e.size)));
    } else continue;
    members++;
    onProgress?.({ phase: "write", members, bytes: written });
  }
  const text = Buffer.from(selfCheckManifest(manifest, b), "utf8");
  const mt = String(Math.floor(Date.parse(at) / 1000));
  emit(memberHeaders({ path: PKG_MANIFEST, type: "0", mode: 0o600, size: text.length, mtime: mt }));
  emit(text);
  emit(Buffer.alloc(padTo(text.length) + 2 * BLOCK));
  members++;
  return { manifest, bytesWritten: written, members };
}

function copyFileInto(e, outFd, onBytes) {
  let fd;
  try {
    fd = fs.openSync(e.abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (err) {
    throw ioErr("io", `open ${quote(relOf(e.pkgPath))}: ${errText(err)}`);
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (
      !st.isFile() ||
      st.dev !== e.dev ||
      st.ino !== e.ino ||
      Number(st.size) !== e.size ||
      mtimeFromStat(st) !== e.mtime
    )
      throw ioErr("cipher-changed", quote(relOf(e.pkgPath)));
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    let left = e.size;
    let sinceProgress = 0;
    while (left > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, left), null);
      if (n === 0) throw ioErr("cipher-changed", `${quote(relOf(e.pkgPath))} shrank`);
      const slice = buf.subarray(0, n);
      hash.update(slice);
      writeAll(outFd, slice);
      left -= n;
      sinceProgress += n;
      if (sinceProgress >= PROGRESS_BYTES) {
        onBytes(sinceProgress);
        sinceProgress = 0;
      }
    }
    if (sinceProgress > 0) onBytes(sinceProgress);
    if (fs.readSync(fd, buf, 0, 1, null) !== 0) throw ioErr("cipher-changed", `${quote(relOf(e.pkgPath))} grew`);
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

// ───────────────────────────── ustar / pax decoding (reader) ─────────────────────────────

function isZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}
/** NUL-terminated string field; anything but NUL after the first NUL is an injection. */
function strField(h, off, len, what) {
  const f = h.subarray(off, off + len);
  const nul = f.indexOf(0);
  const end = nul === -1 ? len : nul;
  if (nul !== -1 && !isZero(f.subarray(nul))) throw bad("header-nul-injection", what);
  return decodeUtf8(f.subarray(0, end), what);
}
/** Strict octal field: digits then only NUL/space; base-256 and empty fields refused. */
function octField(h, off, len, what) {
  const f = h.subarray(off, off + len);
  if (f[0] & 0x80) throw bad("header-numeric", `${what}: base-256`);
  const s = f.toString("latin1");
  const m = /^ *([0-7]+)[ \0]*$/.exec(s);
  if (m === null) throw bad("header-numeric", `${what}: ${quote(s)}`);
  const v = parseInt(m[1], 8);
  if (!Number.isSafeInteger(v)) throw bad("header-numeric", `${what}: too large`);
  return v;
}
function parseUstar(h) {
  const chk = octField(h, 148, 8, "chksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (sum !== chk) throw bad("header-checksum", `${chk} ≠ ${sum}`);
  if (h.toString("latin1", 257, 263) !== "ustar\0" || h.toString("latin1", 263, 265) !== "00")
    throw bad("header-magic", "not POSIX ustar");
  const tf = h[156];
  const type = tf === 0 ? "0" : String.fromCharCode(tf);
  const name = strField(h, 0, 100, "name");
  const prefix = strField(h, 345, 155, "prefix");
  return {
    type,
    linkEmpty: isZero(h.subarray(157, 257)),
    path: prefix === "" ? name : `${prefix}/${name}`,
    mode: octField(h, 100, 8, "mode"),
    uid: octField(h, 108, 8, "uid"),
    gid: octField(h, 116, 8, "gid"),
    size: octField(h, 124, 12, "size"),
    mtime: octField(h, 136, 12, "mtime"),
  };
}
/** Length-prefixed pax records; only path/size/mtime, each at most once. */
function parsePaxImpl(data, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  const out = {};
  let pos = 0;
  if (!Buffer.isBuffer(data)) throw bad("pax-syntax", "not a Buffer");
  if (data.length === 0) throw bad("pax-empty", "");
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1 || sp - pos > 6) throw bad("pax-syntax", "length");
    const lenStr = data.toString("latin1", pos, sp);
    if (!/^[1-9][0-9]*$/.test(lenStr)) throw bad("pax-syntax", `length ${quote(lenStr)}`);
    const len = Number(lenStr);
    if (pos + len > data.length || len < lenStr.length + 4) throw bad("pax-syntax", "record overruns header");
    const rec = data.subarray(sp + 1, pos + len);
    if (rec[rec.length - 1] !== 0x0a) throw bad("pax-syntax", "record not newline-terminated");
    const eq = rec.indexOf(0x3d);
    if (eq <= 0) throw bad("pax-syntax", "missing =");
    const key = decodeUtf8(rec.subarray(0, eq), "pax key");
    if (!PAX_KEYS.has(key)) throw bad("pax-key", quote(key));
    if (Object.prototype.hasOwnProperty.call(out, key)) throw bad("pax-duplicate-key", key);
    const value = decodeUtf8(rec.subarray(eq + 1, rec.length - 1), `pax ${key}`);
    if (value.includes("\0")) throw bad("path-nul", `pax ${key}`);
    if (key === "size") {
      if (!SIZE_RE.test(value) || !Number.isSafeInteger(Number(value))) throw bad("pax-size", quote(value));
      out.size = Number(value);
    } else if (key === "mtime") out.mtime = checkMtimeImpl(value, b);
    else out.path = value;
    pos += len;
  }
  return out;
}

// ───────────────────────────── staging root (fd-anchored) ─────────────────────────────

function openStagingRoot(stagingRoot) {
  let fd;
  try {
    fd = fs.openSync(stagingRoot, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (e) {
    throw ioErr("staging", `open: ${errText(e)}`);
  }
  const st = fs.fstatSync(fd, { bigint: true });
  const uid = process.getuid?.();
  const problem = !st.isDirectory()
    ? "not a directory"
    : uid !== undefined && Number(st.uid) !== uid
      ? "foreign owner"
      : (st.mode & 0o077n) !== 0n
        ? "group/other access"
        : undefined;
  const base = `/proc/self/fd/${fd}`;
  let probe;
  try {
    probe = problem ?? (fs.readdirSync(base).length !== 0 ? "not empty" : undefined);
    if (probe === undefined) {
      const ps = fs.statSync(base, { bigint: true });
      if (ps.dev !== st.dev || ps.ino !== st.ino) probe = "/proc/self/fd anchor mismatch";
    }
  } catch (e) {
    probe = `/proc/self/fd unavailable (${errText(e)})`;
  }
  if (probe !== undefined) {
    fs.closeSync(fd);
    throw ioErr("staging", probe);
  }
  return { fd, base, dev: st.dev, ino: st.ino };
}

/**
 * Remove a staging root after a refusal. Never follows symlinks (lstat walk + rmSync, which unlinks
 * links rather than descending); only touches entries under `stagingRoot`. Bounded by `maxEntries`.
 */
export function discardStaging(stagingRoot, budgetOverride) {
  return guard(() => discardStagingImpl(stagingRoot, budgetOverride));
}
function discardStagingImpl(stagingRoot, budgetOverride) {
  const b = effectiveBudget(budgetOverride);
  let seen = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    if (++seen > b.maxEntries + 2) throw ioErr("staging", "discard budget exceeded");
    try {
      fs.chmodSync(p, 0o700);
    } catch {
      /* rmSync reports what remains */
    }
    for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(stagingRoot);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

// ───────────────────────────── validating reader ─────────────────────────────

/**
 * Read and validate a package into `stagingRoot` (an EXISTING empty 0700 directory owned by this uid —
 * V5 creates `<dir parent>/.<name>.import-<txid>` exclusively). Streams members (dirs 0700, files
 * O_EXCL|O_NOFOLLOW 0600 with sha256), checks the MANIFEST against the members through one unified
 * path/conflict table, rebuilds MANIFEST symlinks/hardlinks only inside the staging root, re-walks the
 * staged tree, then restores modes/mtimes. On success `stagingRoot/cipher` is a complete cipher dir.
 * Returns `{ manifest, conf, counts: { dirs, files, symlinks, hardlinks, members }, bytes, cipherDir }`.
 * Throws `PkgError` (65 content, 74 IO); the caller then calls `discardStaging(stagingRoot)`.
 */
export function readPackage(opts) {
  return guard(() => readPackageImpl(opts));
}
function readPackageImpl({ pkgPath, stagingRoot, budget, onProgress }) {
  const b = effectiveBudget(budget);
  let pfd;
  try {
    // O_NONBLOCK: a FIFO planted at the package path must not hang the open (fstat refuses it next)
    pfd = fs.openSync(pkgPath, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    throw ioErr("io", `open package: ${errText(e)}`);
  }
  let root;
  try {
    const pst = fs.fstatSync(pfd);
    if (!pst.isFile()) throw bad("package-not-file", "");
    root = openStagingRoot(stagingRoot);
    return new Reader(pfd, pst.size, root, b, onProgress).run(stagingRoot);
  } finally {
    if (root !== undefined) fs.closeSync(root.fd);
    fs.closeSync(pfd);
  }
}

class Reader {
  constructor(pfd, total, root, budget, onProgress) {
    this.pfd = pfd;
    this.total = total;
    this.root = root;
    this.b = budget;
    this.onProgress = onProgress;
    this.off = 0;
    /** unified conflict table: pkgPath → { type, mode?, mtime?, size?, sha256?, dev?, ino?, target?, of? } */
    this.table = new Map();
    /** ASCII-casefold key → pkgPath (casefolding staging filesystems would merge these) */
    this.folded = new Map();
    this.members = 0; // real tar members (incl. MANIFEST), for counts / first-member
    this.units = entryUnits({}); // budget units: the MANIFEST member is reserved up front
    this.pathBytes = 0;
    this.bytes = 0;
    this.lastVerifiedParent = undefined;
  }

  read(n, what) {
    if (n > this.total - this.off) throw bad("truncated", what);
    const buf = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = fs.readSync(this.pfd, buf, got, n - got, this.off + got);
      if (r === 0) throw bad("truncated", what);
      got += r;
    }
    this.off += n;
    return buf;
  }
  skipPadding(size, what) {
    const pad = padTo(size);
    if (pad > 0 && !isZero(this.read(pad, what))) throw bad("padding-not-zero", what);
  }
  abs(pkgPath) {
    const rel = relOf(pkgPath);
    const p = `${this.root.base}/${rel}`;
    // defence in depth: the joined path is lexically inside the anchor (checkPkgPath already
    // excluded `..`, `.`, empty segments, absolute paths and backslashes)
    if (path.posix.normalize(p) !== p || !p.startsWith(`${this.root.base}/cipher`)) throw bad("path-escape", rel);
    return p;
  }
  /** Every ancestor directory (cipher … parent) is a directory THIS reader created (dev+ino) and not a symlink. */
  verifyParentChain(parent, cache) {
    if (cache && parent === this.lastVerifiedParent) return;
    const segs = parent.split("/");
    for (let i = 2; i <= segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      const rec = this.table.get(p);
      if (rec === undefined || rec.type !== "dir" || rec.ino === undefined)
        throw bad("ancestor-not-dir", quote(relOf(p)));
      let st;
      try {
        st = fs.lstatSync(this.abs(p), { bigint: true });
      } catch (e) {
        throw ioErr("staging-changed", `${quote(relOf(p))}: ${errText(e)}`);
      }
      if (!st.isDirectory() || st.dev !== rec.dev || st.ino !== rec.ino)
        throw ioErr("staging-changed", quote(relOf(p)));
    }
    if (cache) this.lastVerifiedParent = parent;
  }
  /** Shared admission into the unified conflict table (members AND MANIFEST links). */
  admit(chk, type, links) {
    const p = chk.path;
    this.pathBytes += Buffer.byteLength(p, "utf8");
    if (this.pathBytes > this.b.maxPathBytesTotal) throw bad("budget-path-bytes", `> ${this.b.maxPathBytesTotal}`);
    if (this.table.has(p)) throw bad("duplicate-path", quote(relOf(p)));
    const fk = p.toLowerCase();
    const other = this.folded.get(fk);
    if (other !== undefined) throw bad("case-conflict", `${quote(relOf(p))} vs ${quote(relOf(other))}`);
    if (chk.parent === null) {
      if (type !== "dir" || links) throw bad("first-member", "cipher root must be the first member, a dir");
    } else {
      const parent = this.table.get(chk.parent);
      if (parent === undefined) throw bad("ancestor-missing", quote(relOf(p)));
      if (parent.type !== "dir") throw bad("ancestor-not-dir", quote(relOf(p)));
    }
    this.folded.set(fk, p);
  }
  progress(phase) {
    this.onProgress?.({ phase, members: this.members, bytes: this.bytes });
  }

  run(stagingRoot) {
    let pax;
    let manifestBuf;
    let confBuf;
    for (;;) {
      if (this.off === this.total)
        throw bad(manifestBuf === undefined ? "missing-manifest" : "truncated", "end of archive");
      const h = this.read(BLOCK, "header");
      if (isZero(h)) {
        if (pax !== undefined) throw bad("pax-dangling", "pax header without member");
        if (manifestBuf === undefined) throw bad("missing-manifest", "archive ended before MANIFEST.json");
        this.checkTrailer();
        break;
      }
      const u = parseUstar(h);
      if (manifestBuf !== undefined) throw bad("member-after-manifest", quote(u.path));
      if (u.type !== "0" && u.type !== "5" && u.type !== "x")
        throw bad("member-type", `type ${JSON.stringify(u.type)} ${quote(u.path)}`);
      if (!u.linkEmpty) throw bad("header-linkname", "link target present");
      if (u.type === "x") {
        if (pax !== undefined) throw bad("pax-chain", "two pax headers in a row");
        if (u.path !== PKG_PAX_NAME) throw bad("pax-name", quote(u.path));
        if (u.size > this.b.maxPaxBytes) throw bad("budget-pax", `${u.size} bytes`);
        const data = this.read(u.size, "pax header");
        this.skipPadding(u.size, "pax header");
        pax = parsePaxImpl(data, this.b);
        continue;
      }
      const m = this.applyPax(u, pax);
      pax = undefined;
      this.members++;
      if (m.size > this.total - this.off) throw bad("size-exceeds-package", quote(m.path));
      const chk = checkPkgPathImpl(m.path, this.b);
      if (chk.kind === "manifest") {
        if (m.type !== "0") throw bad("member-type", "MANIFEST.json must be a file");
        if (m.size > this.b.maxManifestBytes) throw bad("budget-manifest", `${m.size} bytes`);
        manifestBuf = this.read(m.size, "MANIFEST.json");
        this.skipPadding(m.size, "MANIFEST.json");
        continue;
      }
      checkUnits(++this.units, this.b, "members");
      if (m.mode > 0o777) throw bad("mode-range", `${quote(relOf(m.path))} mode ${m.mode.toString(8)}`);
      if (m.type === "5") this.stageDir(chk, m);
      else {
        const isConf = m.path === PKG_CONF;
        if (isConf && m.size > this.b.maxConfBytes) throw bad("conf-too-large", `${m.size} bytes`);
        const content = this.stageFile(chk, m, isConf);
        if (isConf) confBuf = content;
      }
      this.progress("read");
    }

    // required cipher root files
    const conf = this.table.get(PKG_CONF);
    const diriv = this.table.get(PKG_DIRIV);
    if (conf?.type !== "file" || confBuf === undefined) throw bad("missing-conf", "gocryptfs.conf");
    if (diriv?.type !== "file" || diriv.size !== 16) throw bad("missing-diriv", "gocryptfs.diriv");
    const confObj = validateGocryptfsConfImpl(confBuf, this.b);

    const manifest = this.parseManifest(manifestBuf);
    const links = this.crossCheck(manifest);
    this.rebuildLinks(links);
    this.verifyStagedTree();
    this.restoreDirs();
    this.progress("done");
    const counts = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, members: this.members };
    for (const r of this.table.values()) counts[`${r.type}s`]++;
    return { manifest, conf: confObj, counts, bytes: this.bytes, cipherDir: path.join(stagingRoot, "cipher") };
  }

  applyPax(u, pax) {
    let { path: p, size, type } = u;
    let mtime = String(u.mtime);
    if (pax !== undefined) {
      if (pax.path !== undefined) p = pax.path;
      if (pax.size !== undefined) {
        const expectUstar = pax.size < OCTAL11_MAX ? pax.size : 0;
        if (u.size !== expectUstar) throw bad("pax-size-mismatch", `ustar ${u.size} ≠ pax ${pax.size}`);
        size = pax.size;
      }
      if (pax.mtime !== undefined) {
        const sec = mtimeSecondsPart(pax.mtime);
        if (u.mtime !== (sec < OCTAL11_MAX ? sec : 0)) throw bad("pax-mtime-mismatch", `${u.mtime} ≠ ${pax.mtime}`);
        mtime = pax.mtime;
      }
    }
    checkMtimeImpl(mtime, this.b);
    if (type === "5") {
      if (!p.endsWith("/") || p.endsWith("//")) throw bad("dir-path", quote(p));
      p = p.slice(0, -1);
      if (size !== 0) throw bad("dir-size", quote(p));
    } else if (p.endsWith("/")) throw bad("file-path", quote(p));
    return { path: p, size, mtime, type, mode: u.mode };
  }

  stageDir(chk, m) {
    if (this.members === 1 && chk.parent !== null) throw bad("first-member", quote(m.path));
    this.admit(chk, "dir", false);
    if (chk.parent !== null) this.verifyParentChain(chk.parent, true);
    const abs = this.abs(m.path);
    try {
      fs.mkdirSync(abs, 0o700);
    } catch (e) {
      if (e?.code === "EEXIST") throw bad("exists", quote(relOf(m.path)));
      throw ioErr("io", `mkdir ${quote(relOf(m.path))}: ${errText(e)}`);
    }
    const st = fs.lstatSync(abs, { bigint: true });
    if (!st.isDirectory()) throw ioErr("staging-changed", quote(relOf(m.path)));
    this.table.set(m.path, { type: "dir", mode: m.mode, mtime: m.mtime, dev: st.dev, ino: st.ino, depth: chk.depth });
  }

  stageFile(chk, m, keep) {
    if (this.members === 1) throw bad("first-member", quote(m.path));
    this.admit(chk, "file", false);
    this.verifyParentChain(chk.parent, true);
    const abs = this.abs(m.path);
    let fd;
    try {
      fd = fs.openSync(abs, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    } catch (e) {
      if (e?.code === "EEXIST") throw bad("exists", quote(relOf(m.path)));
      throw ioErr("io", `create ${quote(relOf(m.path))}: ${errText(e)}`);
    }
    const hash = crypto.createHash("sha256");
    const kept = keep ? [] : undefined;
    try {
      let left = m.size;
      let since = 0;
      while (left > 0) {
        const n = Math.min(CHUNK, left);
        const chunk = this.read(n, quote(relOf(m.path)));
        hash.update(chunk);
        kept?.push(chunk);
        let w = 0;
        while (w < n) w += fs.writeSync(fd, chunk, w, n - w);
        left -= n;
        this.bytes += n;
        since += n;
        if (since >= PROGRESS_BYTES) {
          since = 0;
          this.progress("read");
        }
      }
      const st = fs.fstatSync(fd, { bigint: true });
      const mt = Number(m.mtime);
      fs.fchmodSync(fd, m.mode);
      fs.futimesSync(fd, mt, mt);
      this.table.set(m.path, {
        type: "file",
        mode: m.mode,
        mtime: m.mtime,
        size: m.size,
        sha256: hash.digest("hex"),
        dev: st.dev,
        ino: st.ino,
        depth: chk.depth,
      });
    } finally {
      fs.closeSync(fd);
    }
    this.skipPadding(m.size, quote(relOf(m.path)));
    return kept === undefined ? undefined : Buffer.concat(kept);
  }

  checkTrailer() {
    // after the first zero block: at least one more, then only zero bytes until EOF
    const rest = this.total - this.off;
    if (rest < BLOCK) throw bad("truncated", "end-of-archive marker");
    if (rest % BLOCK !== 0) throw bad("trailer-garbage", "package size is not block aligned");
    while (this.off < this.total) {
      if (!isZero(this.read(Math.min(CHUNK, this.total - this.off), "trailer"))) throw bad("trailer-garbage", "");
    }
  }

  parseManifest(buf) {
    const text = decodeUtf8(buf, "MANIFEST.json");
    const m = parseJsonBounded(
      text,
      { maxDepth: MANIFEST_JSON_DEPTH, maxNodes: manifestMaxNodes(this.b) },
      "MANIFEST.json",
      "manifest-json",
    );
    validateManifestImpl(m, this.b); // schema first (bounded), only then the canonical comparison
    // canonical encoding (our writer's exact output): rules out duplicate keys, alternate escapes, padding
    if (`${JSON.stringify(m)}\n` !== text) throw bad("manifest-not-canonical", "");
    return m;
  }

  /** MANIFEST ↔ members, then link admission into the SAME table. Returns links sorted by depth. */
  crossCheck(manifest) {
    const listed = new Set();
    const links = [];
    for (const e of manifest.entries) {
      if (listed.has(e.path)) throw bad("duplicate-path", `${quote(relOf(e.path))} listed twice`);
      listed.add(e.path);
      if (e.type === "dir" || e.type === "file") {
        const rec = this.table.get(e.path);
        if (rec === undefined) throw bad("manifest-missing-member", quote(relOf(e.path)));
        if (rec.type !== e.type) throw bad("manifest-type-mismatch", quote(relOf(e.path)));
        if (rec.mode !== e.mode || rec.mtime !== e.mtime) throw bad("manifest-meta-mismatch", quote(relOf(e.path)));
        if (e.type === "file" && (rec.size !== e.size || rec.sha256 !== e.sha256))
          throw bad("manifest-hash-mismatch", quote(relOf(e.path)));
      } else {
        if (this.table.has(e.path)) throw bad("duplicate-path", `${quote(relOf(e.path))} is also a member`);
        links.push(e);
      }
    }
    for (const p of this.table.keys()) if (!listed.has(p)) throw bad("manifest-extra-member", quote(relOf(p)));
    checkUnits(this.units + links.length, this.b, "members + links");
    const withDepth = links.map((e) => ({ e, chk: checkPkgPathImpl(e.path, this.b) }));
    withDepth.sort((x, y) => x.chk.depth - y.chk.depth);
    for (const { e, chk } of withDepth) {
      this.admit(chk, e.type, true);
      if (e.type === "hardlink") {
        const of = this.table.get(e.of);
        if (of === undefined) throw bad("hardlink-of-missing", `${quote(relOf(e.path))} → ${quote(relOf(e.of))}`);
        if (of.type !== "file") throw bad("hardlink-of-not-file", `${quote(relOf(e.path))} → ${of.type}`);
        this.table.set(e.path, { type: "hardlink", of: e.of, depth: chk.depth, parent: chk.parent });
      } else {
        this.table.set(e.path, {
          type: "symlink",
          target: e.target_b64,
          mtime: e.mtime,
          depth: chk.depth,
          parent: chk.parent,
        });
      }
    }
    return withDepth.map((x) => x.e);
  }

  rebuildLinks(links) {
    for (const e of links) {
      const rec = this.table.get(e.path);
      this.verifyParentChain(rec.parent, false);
      const abs = this.abs(e.path);
      try {
        if (e.type === "symlink") {
          fs.symlinkSync(e.target_b64, abs);
          const mt = Number(e.mtime);
          fs.lutimesSync(abs, mt, mt);
        } else {
          const of = this.table.get(e.of);
          const ofParent = checkPkgPathImpl(e.of, this.b).parent;
          this.verifyParentChain(ofParent, false);
          const ofAbs = this.abs(e.of);
          const ost = fs.lstatSync(ofAbs, { bigint: true });
          if (!ost.isFile() || ost.dev !== of.dev || ost.ino !== of.ino)
            throw ioErr("staging-changed", quote(relOf(e.of)));
          fs.linkSync(ofAbs, abs); // linkat without AT_SYMLINK_FOLLOW: never follows
        }
      } catch (err) {
        if (err instanceof PkgError) throw err;
        if (err?.code === "EEXIST") throw bad("exists", quote(relOf(e.path)));
        throw ioErr("io", `link ${quote(relOf(e.path))}: ${errText(err)}`);
      }
      const st = fs.lstatSync(abs, { bigint: true });
      if (e.type === "symlink" ? !st.isSymbolicLink() : !st.isFile() || st.ino !== this.table.get(e.of).ino)
        throw ioErr("staging-changed", quote(relOf(e.path)));
      rec.ino = st.ino;
      rec.dev = st.dev;
      this.progress("link");
    }
  }

  /** Re-walk the staged tree (lstat, no follow): entry set and types equal the table; nlink matches groups. */
  verifyStagedTree() {
    const seen = new Set();
    const groups = new Map(); // holder pkgPath → expected nlink
    for (const [p, r] of this.table) if (r.type === "hardlink") groups.set(r.of, (groups.get(r.of) ?? 1) + 1);
    const walk = (pkgPath) => {
      if (seen.size > this.table.size) throw ioErr("staging-changed", "extra entries");
      const st = fs.lstatSync(this.abs(pkgPath), { bigint: true });
      const rec = this.table.get(pkgPath);
      if (rec === undefined) throw ioErr("staging-changed", `unexpected ${quote(relOf(pkgPath))}`);
      seen.add(pkgPath);
      const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other";
      const want = rec.type === "hardlink" ? "file" : rec.type;
      if (kind !== want || st.ino !== rec.ino) throw ioErr("staging-changed", quote(relOf(pkgPath)));
      if (rec.type === "file" && st.nlink !== BigInt(groups.get(pkgPath) ?? 1))
        throw ioErr("staging-changed", `nlink ${quote(relOf(pkgPath))}`);
      if (kind === "dir") for (const n of fs.readdirSync(this.abs(pkgPath))) walk(`${pkgPath}/${n}`);
    };
    const top = fs.readdirSync(this.root.base);
    if (top.length !== 1 || top[0] !== "cipher") throw ioErr("staging-changed", "staging root content");
    walk(PKG_CIPHER);
    if (seen.size !== this.table.size) throw ioErr("staging-changed", "missing entries");
  }

  restoreDirs() {
    const dirs = [...this.table].filter(([, r]) => r.type === "dir");
    dirs.sort((x, y) => y[1].depth - x[1].depth);
    for (const [p, r] of dirs) {
      const abs = this.abs(p);
      const mt = Number(r.mtime);
      fs.chmodSync(abs, r.mode);
      fs.utimesSync(abs, mt, mt);
    }
  }
}

// ───────────────────────────── guarded public entry points ─────────────────────────────
// Every exported validator answers ONLY with a PkgError (65 content / 74 io), whatever the input.

export const checkPkgPath = (p, budgetOverride) => guard(() => checkPkgPathImpl(p, budgetOverride));
export const checkMtime = (s, budgetOverride) => guard(() => checkMtimeImpl(s, budgetOverride));
export const validateGocryptfsConf = (input, budgetOverride) =>
  guard(() => validateGocryptfsConfImpl(input, budgetOverride));
export const validateManifest = (m, budgetOverride) => guard(() => validateManifestImpl(m, budgetOverride));
export const parsePax = (data, budgetOverride) => guard(() => parsePaxImpl(data, budgetOverride));
export const scanCipherTree = (cipherDir, opts) => guard(() => scanCipherTreeImpl(cipherDir, opts));
export const prescanJson = (text, limits, what = "json") => guard(() => prescanJsonImpl(text, limits, what));
