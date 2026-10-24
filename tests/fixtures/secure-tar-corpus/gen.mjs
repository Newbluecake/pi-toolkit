// Malicious-package corpus generator for `pi-secure-vault/2` (convert-plan §7.1 tar.test.ts, §R2 B6).
//
// Deliberately INDEPENDENT of src/secure/bin/tar.mjs: it has its own raw ustar/pax encoder so a bug in
// the production writer can never mask a reader bug. Every case starts from a valid baseline package
// (which the reader must accept — the test pins that) and applies exactly one mutation.
//
//   node tests/fixtures/secure-tar-corpus/gen.mjs <outdir>   # writes <id>.tar + index.json
//
// Each case: { id, category, reasons: [expected PkgError.reason …], budget?, build(): Buffer }.
// Zero dependencies; deterministic output (fixed mtimes, hash-derived fake key material — NOT a real
// gocryptfs key; nothing here can decrypt anything).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK = 512;
const R = "pi-secure-vault";
const C = `${R}/cipher`;
const MANIFEST = `${R}/MANIFEST.json`;

// ───────────────────────────── raw encoder ─────────────────────────────

function det(seed, n) {
  const out = [];
  let i = 0;
  while (Buffer.concat(out).length < n) out.push(crypto.createHash("sha256").update(`${seed}:${i++}`).digest());
  return Buffer.concat(out).subarray(0, n);
}
export function fakeConf(over = {}) {
  return {
    Creator: "gocryptfs 1.8.0",
    EncryptedKey: det("key", 64).toString("base64"),
    ScryptObject: { Salt: det("salt", 32).toString("base64"), N: 65536, R: 8, P: 1, KeyLen: 32 },
    Version: 2,
    FeatureFlags: ["GCMIV128", "HKDF", "DirIV", "EMENames", "LongNames", "Raw64"],
    ...over,
  };
}
const confBytes = (obj) => Buffer.from(JSON.stringify(obj, null, "\t") + "\n");

function put(h, off, len, v) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
  b.copy(h, off, 0, Math.min(len, b.length));
}
function oct(n, len) {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}
/** One raw ustar header. `o` may override any field (raw Buffers allowed) and checksum behaviour. */
export function header(o) {
  const h = Buffer.alloc(BLOCK);
  put(h, 0, 100, o.name ?? "");
  put(h, 100, 8, o.modeRaw ?? oct(o.mode ?? 0o644, 8));
  put(h, 108, 8, oct(0, 8));
  put(h, 116, 8, oct(0, 8));
  put(h, 124, 12, o.sizeRaw ?? oct(o.size ?? 0, 12));
  put(h, 136, 12, o.mtimeRaw ?? oct(o.mtime ?? 0, 12));
  h.fill(0x20, 148, 156);
  h[156] = (o.type ?? "0").charCodeAt(0);
  if (o.linkname !== undefined) put(h, 157, 100, o.linkname);
  put(h, 257, 6, o.magic ?? "ustar\0");
  put(h, 263, 2, o.version ?? "00");
  put(h, 329, 8, oct(0, 8));
  put(h, 337, 8, oct(0, 8));
  put(h, 345, 155, o.prefix ?? "");
  if (o.sizeBase256) {
    h.fill(0, 124, 136);
    h[124] = 0x80;
    h.writeUInt32BE(o.sizeBase256, 132);
  }
  let sum = 0;
  for (const x of h) sum += x;
  put(h, 148, 8, oct(sum + (o.chksumDelta ?? 0), 7) + " ");
  return h;
}
export function paxRec(key, value) {
  const body = Buffer.from(` ${key}=${value}\n`);
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.concat([Buffer.from(String(len)), body]);
}
const pad = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/**
 * A member: { path, type:"0"|"5"|other, mode, mtime:"sec[.frac]", content?: Buffer, pax?: Buffer[]
 * (extra raw records), paxOnly?: bool (force path via pax), hdr?: header overrides, noPax?: bool,
 * padByte?: number }.
 */
function encodeMember(m) {
  const content = m.content ?? Buffer.alloc(0);
  const full = m.type === "5" ? `${m.path}/` : m.path;
  const recs = [...(m.pax ?? [])];
  const sec = Number(String(m.mtime).split(".")[0]);
  const fits = Buffer.byteLength(full) <= 100 && !m.paxOnly;
  if (!m.noPax) {
    if (!fits) recs.unshift(paxRec("path", full));
    if (String(m.mtime).includes(".")) recs.push(paxRec("mtime", m.mtime));
  }
  const out = [];
  if (recs.length > 0) {
    const data = Buffer.concat(recs);
    out.push(header({ name: `${R}/PaxHeader`, mode: 0o600, size: data.length, type: "x", ...(m.paxHdr ?? {}) }));
    out.push(data, pad(data.length));
  }
  out.push(
    header({
      name: fits ? full : Buffer.from(full).subarray(-100),
      mode: m.mode,
      size: m.type === "5" ? 0 : content.length,
      mtime: sec,
      type: m.type,
      ...(m.hdr ?? {}),
    }),
  );
  if (content.length > 0) {
    out.push(content);
    const p = pad(content.length);
    if (m.padByte !== undefined && p.length > 0) p[0] = m.padByte;
    out.push(p);
  }
  return Buffer.concat(out);
}

// ───────────────────────────── baseline ─────────────────────────────

export function baseline() {
  return {
    members: [
      { path: C, type: "5", mode: 0o775, mtime: "1700000000.5" },
      { path: `${C}/gocryptfs.conf`, type: "0", mode: 0o400, mtime: "1700000000", content: confBytes(fakeConf()) },
      { path: `${C}/gocryptfs.diriv`, type: "0", mode: 0o440, mtime: "1700000000", content: det("iv0", 16) },
      { path: `${C}/Fa0aaaaaaaaaaaaaaaaaaa`, type: "0", mode: 0o664, mtime: "1700000001.25", content: det("fa", 1000) },
      { path: `${C}/D1dddddddddddddddddddd`, type: "5", mode: 0o775, mtime: "1700000002" },
      {
        path: `${C}/D1dddddddddddddddddddd/gocryptfs.diriv`,
        type: "0",
        mode: 0o440,
        mtime: "1700000002",
        content: det("iv1", 16),
      },
      {
        path: `${C}/D1dddddddddddddddddddd/Fbbbbbbbbbbbbbbbbbbbbb`,
        type: "0",
        mode: 0o600,
        mtime: "1700000003",
        content: det("fb", 700),
      },
    ],
    links: [
      { path: `${C}/S1ssssssssssssssssssss`, type: "symlink", target_b64: "AbC-_=xyz", mtime: "1700000004.75" },
      {
        path: `${C}/D1dddddddddddddddddddd/H1hhhhhhhhhhhhhhhhhhhh`,
        type: "hardlink",
        of: `${C}/Fa0aaaaaaaaaaaaaaaaaaa`,
      },
    ],
    meta: {
      format: "pi-secure-vault",
      v: 2,
      name: "corpus",
      exportedAt: "2026-10-24T00:00:00.000Z",
      gocryptfsVersion: "gocryptfs 1.8.0; go-fuse 2.0.3",
      origRealWork: "/home/u/secure/corpus/work",
    },
  };
}

export function manifestOf(pkg) {
  const entries = [];
  const totals = { dirs: 0, files: 0, symlinks: 0, hardlinks: 0, bytes: 0 };
  for (const m of pkg.members) {
    if (m.inManifest === false) continue;
    if (m.type === "5") {
      entries.push({ path: m.path, type: "dir", mode: m.mode, mtime: m.mtime });
      totals.dirs++;
    } else {
      const c = m.content ?? Buffer.alloc(0);
      entries.push({
        path: m.path,
        type: "file",
        mode: m.mode,
        mtime: m.mtime,
        size: c.length,
        sha256: crypto.createHash("sha256").update(c).digest("hex"),
      });
      totals.files++;
      totals.bytes += c.length;
    }
  }
  for (const l of pkg.links) {
    entries.push(l);
    if (l.type === "symlink") totals.symlinks++;
    else if (l.type === "hardlink") totals.hardlinks++;
  }
  return { ...pkg.meta, entries, totals };
}

/**
 * Assemble a package. `opts.manifest` (object) / `opts.manifestText` (string|Buffer) override the
 * derived MANIFEST; `opts.afterManifest` (Buffer[]) are raw blocks after it; `opts.trailer` replaces
 * the two end-of-archive zero blocks; `opts.mutateManifest(m)` edits the derived object in place.
 */
export function assemble(pkg, opts = {}) {
  const parts = pkg.members.map(encodeMember);
  if (opts.omitManifest !== true) {
    let m = opts.manifest ?? manifestOf(pkg);
    if (opts.mutateManifest) {
      m = structuredClone(m);
      opts.mutateManifest(m);
    }
    const text = opts.manifestText ?? `${JSON.stringify(m)}\n`;
    const content = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
    parts.push(encodeMember({ path: MANIFEST, type: "0", mode: 0o600, mtime: "1761264000", content }));
  }
  for (const b of opts.afterManifest ?? []) parts.push(b);
  parts.push(opts.trailer ?? Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

const clone = () => {
  const b = baseline();
  return { members: b.members.map((m) => ({ ...m })), links: b.links.map((l) => ({ ...l })), meta: { ...b.meta } };
};
/** Baseline with one mutation of the derived structure. */
const withPkg =
  (fn, opts = {}) =>
  () => {
    const p = clone();
    const extra = fn(p) ?? {};
    return assemble(p, { ...opts, ...extra });
  };
const addMember = (m) => withPkg((p) => void p.members.push(m));
const addLink = (l) => withPkg((p) => void p.links.push(l));
const fileM = (p, extra = {}) => ({
  path: p,
  type: "0",
  mode: 0o600,
  mtime: "1700000009",
  content: Buffer.from("z"),
  ...extra,
});

// ───────────────────────────── the corpus ─────────────────────────────

const FA = `${C}/Fa0aaaaaaaaaaaaaaaaaaa`;
const D1 = `${C}/D1dddddddddddddddddddd`;
const S1 = `${C}/S1ssssssssssssssssssss`;

export const CASES = [
  // ── baseline (must be accepted) ──
  { id: "ok-baseline", category: "ok", reasons: [], build: withPkg(() => {}) },

  // ── path traversal / absolute / `..` (tar members) ──
  {
    id: "trav-member-dotdot",
    category: "traversal",
    reasons: ["path-dot-segment"],
    build: addMember(fileM(`${C}/../../etc/x`)),
  },
  {
    id: "trav-member-leading-dotdot",
    category: "traversal",
    reasons: ["path-dot-segment"],
    build: addMember(fileM("../x")),
  },
  { id: "trav-member-dot", category: "traversal", reasons: ["path-dot-segment"], build: addMember(fileM(`${C}/./x`)) },
  {
    id: "trav-member-absolute",
    category: "absolute",
    reasons: ["path-absolute"],
    build: addMember(fileM("/etc/passwd")),
  },
  {
    id: "trav-member-absolute-pax",
    category: "absolute",
    reasons: ["path-absolute"],
    build: addMember(fileM("/tmp/pwn", { paxOnly: true })),
  },
  {
    id: "trav-member-outside-prefix",
    category: "traversal",
    reasons: ["path-prefix"],
    build: addMember(fileM("other/x")),
  },
  {
    id: "trav-member-root-not-cipher",
    category: "traversal",
    reasons: ["path-prefix"],
    build: addMember(fileM(`${R}/mount.lock`)),
  },
  {
    id: "trav-member-empty-segment",
    category: "traversal",
    reasons: ["path-empty-segment"],
    build: addMember(fileM(`${C}//x`)),
  },
  {
    id: "trav-member-backslash",
    category: "traversal",
    reasons: ["path-backslash"],
    build: addMember(fileM(`${C}/..\\..\\x`)),
  },
  {
    id: "trav-member-bad-char",
    category: "traversal",
    reasons: ["path-bad-char"],
    build: addMember(fileM(`${C}/a b`)),
  },
  // ── MANIFEST link paths (B6) ──
  {
    id: "trav-link-dotdot",
    category: "link-path",
    reasons: ["path-dot-segment"],
    build: addLink({ path: `${C}/../x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-leading-dotdot",
    category: "link-path",
    reasons: ["path-dot-segment"],
    build: addLink({ path: "../x", type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-absolute",
    category: "link-path",
    reasons: ["path-absolute"],
    build: addLink({ path: "/tmp/x", type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-dot",
    category: "link-path",
    reasons: ["path-dot-segment"],
    build: addLink({ path: `${C}/./x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-empty-segment",
    category: "link-path",
    reasons: ["path-empty-segment"],
    build: addLink({ path: `${C}//x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-bad-char",
    category: "link-path",
    reasons: ["path-bad-char"],
    build: addLink({ path: `${C}/x;rm`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-outside-prefix",
    category: "link-path",
    reasons: ["path-prefix"],
    build: addLink({ path: `${R}/x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-link-is-manifest",
    category: "link-path",
    reasons: ["manifest-entry-path"],
    build: addLink({ path: MANIFEST, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "trav-hardlink-of-dotdot",
    category: "link-path",
    reasons: ["path-dot-segment"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: `${C}/../../../etc/passwd` }),
  },
  {
    id: "trav-hardlink-of-absolute",
    category: "link-path",
    reasons: ["path-absolute"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: "/etc/passwd" }),
  },
  {
    id: "trav-hardlink-of-manifest",
    category: "link-path",
    reasons: ["hardlink-of"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: MANIFEST }),
  },

  // ── NUL ──
  {
    id: "nul-ustar-name-injection",
    category: "nul",
    reasons: ["header-nul-injection"],
    build: addMember(fileM(`${C}/x`, { hdr: { name: Buffer.from(`${C}/x\0../../evil`) } })),
  },
  {
    id: "nul-pax-path",
    category: "nul",
    reasons: ["path-nul"],
    build: addMember(fileM(`${C}/x\0y`, { paxOnly: true })),
  },
  {
    id: "nul-link-path",
    category: "nul",
    reasons: ["path-nul"],
    build: addLink({ path: `${C}/x\u0000y`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "nul-symlink-target",
    category: "nul",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "ab\u0000c", mtime: "1" }),
  },
  {
    id: "nul-hardlink-of",
    category: "nul",
    reasons: ["path-nul"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: `${FA}\u0000` }),
  },

  // ── overlong ──
  {
    id: "long-segment-256",
    category: "overlong",
    reasons: ["segment-too-long"],
    build: addMember(fileM(`${C}/${"a".repeat(256)}`)),
  },
  {
    id: "long-path-4097",
    category: "overlong",
    reasons: ["path-too-long"],
    build: addMember(fileM(`${C}/${Array(40).fill("b".repeat(102)).join("/")}`)),
  },
  {
    id: "long-depth-65",
    category: "overlong",
    reasons: ["path-too-deep"],
    build: addMember(fileM(`${C}/${Array(64).fill("d").join("/")}`)),
  },
  {
    id: "long-link-path",
    category: "overlong",
    reasons: ["path-too-long"],
    build: addLink({ path: `${C}/${"c".repeat(4100)}`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "long-link-segment",
    category: "overlong",
    reasons: ["segment-too-long"],
    build: addLink({ path: `${C}/${"c".repeat(300)}`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "long-symlink-target",
    category: "overlong",
    reasons: ["symlink-target-too-long"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "t".repeat(4097), mtime: "1" }),
  },

  // ── duplicates ──
  {
    id: "dup-member-file",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: withPkg((p) => void p.members.push({ ...p.members[3], inManifest: false })),
  },
  {
    id: "dup-member-dir",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: withPkg((p) => void p.members.push({ ...p.members[4], inManifest: false })),
  },
  {
    id: "dup-member-dir-vs-file",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: addMember({ path: FA, type: "5", mode: 0o700, mtime: "1", inManifest: false }),
  },
  {
    id: "dup-manifest-entry",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: withPkg(() => ({
      mutateManifest: (m) => m.entries.push(m.entries[3]) && (m.totals.files++, (m.totals.bytes += m.entries[3].size)),
    })),
  },
  {
    id: "dup-link-vs-member",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: addLink({ path: FA, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "dup-link-vs-link",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: addLink({ path: S1, type: "symlink", target_b64: "other", mtime: "1" }),
  },
  {
    id: "dup-hardlink-vs-member",
    category: "duplicate",
    reasons: ["duplicate-path"],
    build: addLink({ path: `${D1}/gocryptfs.diriv`, type: "hardlink", of: FA }),
  },

  // ── case / Unicode ──
  {
    id: "case-member-member",
    category: "case-unicode",
    reasons: ["case-conflict"],
    build: withPkg((p) => void p.members.push(fileM(`${C}/Ab`), fileM(`${C}/aB`))),
  },
  {
    id: "case-link-member",
    category: "case-unicode",
    reasons: ["case-conflict"],
    build: addLink({
      path: FA.toUpperCase().replace("PI-SECURE-VAULT/CIPHER", C),
      type: "symlink",
      target_b64: "abc",
      mtime: "1",
    }),
  },
  {
    id: "case-link-link",
    category: "case-unicode",
    reasons: ["case-conflict"],
    build: addLink({ path: S1.replace("S1sss", "s1SSS"), type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "unicode-nfc-member",
    category: "case-unicode",
    reasons: ["path-bad-char"],
    build: addMember(fileM(`${C}/caf\u00e9`, { paxOnly: true })),
  },
  {
    id: "unicode-nfd-member",
    category: "case-unicode",
    reasons: ["path-bad-char"],
    build: addMember(fileM(`${C}/cafe\u0301`, { paxOnly: true })),
  },
  {
    id: "unicode-fullwidth-link",
    category: "case-unicode",
    reasons: ["path-bad-char"],
    build: addLink({ path: `${C}/\uff21`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "unicode-non-utf8-name",
    category: "case-unicode",
    reasons: ["non-utf8"],
    build: addMember(
      fileM(`${C}/x`, { hdr: { name: Buffer.concat([Buffer.from(`${C}/`), Buffer.from([0xff, 0xfe])]) } }),
    ),
  },
  {
    id: "unicode-lone-surrogate-link",
    category: "case-unicode",
    reasons: ["non-utf8", "path-bad-char"],
    build: addLink({ path: `${C}/\ud800`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },

  // ── links escaping / bad link structure ──
  {
    id: "link-target-dotdot",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "../../outside", mtime: "1" }),
  },
  {
    id: "link-target-absolute",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "/etc/passwd", mtime: "1" }),
  },
  {
    id: "link-target-slash",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "a/b", mtime: "1" }),
  },
  {
    id: "link-target-dot-only",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "..", mtime: "1" }),
  },
  {
    id: "link-target-empty",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "", mtime: "1" }),
  },
  {
    id: "link-target-not-string",
    category: "link-escape",
    reasons: ["symlink-target"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: 7, mtime: "1" }),
  },
  {
    id: "link-ancestor-file",
    category: "link-escape",
    reasons: ["ancestor-not-dir"],
    build: addLink({ path: `${FA}/x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "link-ancestor-symlink",
    category: "link-escape",
    reasons: ["ancestor-not-dir"],
    build: addLink({ path: `${S1}/x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "link-ancestor-hardlink",
    category: "link-escape",
    reasons: ["ancestor-not-dir"],
    build: addLink({ path: `${D1}/H1hhhhhhhhhhhhhhhhhhhh/x`, type: "hardlink", of: FA }),
  },
  {
    id: "link-ancestor-missing",
    category: "link-escape",
    reasons: ["ancestor-missing"],
    build: addLink({ path: `${C}/nodir/x`, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "link-at-cipher-root",
    category: "link-escape",
    reasons: ["duplicate-path", "manifest-entry-path"],
    build: addLink({ path: C, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "hardlink-of-dir",
    category: "link-escape",
    reasons: ["hardlink-of-not-file"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: D1 }),
  },
  {
    id: "hardlink-of-root",
    category: "link-escape",
    reasons: ["hardlink-of-not-file"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: C }),
  },
  {
    id: "hardlink-of-symlink",
    category: "link-escape",
    reasons: ["hardlink-of-not-file"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: S1 }),
  },
  {
    id: "hardlink-of-missing",
    category: "link-escape",
    reasons: ["hardlink-of-missing"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: `${C}/nothere` }),
  },

  // ── hardlink cycles / chains ──
  {
    id: "hardlink-self",
    category: "hardlink-cycle",
    reasons: ["hardlink-of-missing"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: `${C}/Hx` }),
  },
  {
    id: "hardlink-two-cycle",
    category: "hardlink-cycle",
    reasons: ["hardlink-of-missing", "hardlink-of-not-file"],
    build: withPkg(
      (p) =>
        void p.links.push(
          { path: `${C}/Ha`, type: "hardlink", of: `${C}/Hb` },
          { path: `${C}/Hb`, type: "hardlink", of: `${C}/Ha` },
        ),
    ),
  },
  {
    id: "hardlink-chain",
    category: "hardlink-cycle",
    reasons: ["hardlink-of-not-file"],
    build: withPkg(
      (p) =>
        void p.links.push(
          { path: `${C}/Ha`, type: "hardlink", of: FA },
          { path: `${C}/Hb`, type: "hardlink", of: `${C}/Ha` },
        ),
    ),
  },

  // ── pax header injection ──
  {
    id: "pax-key-linkpath",
    category: "pax-injection",
    reasons: ["pax-key"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("linkpath", "/etc/passwd")] })),
  },
  {
    id: "pax-key-uid",
    category: "pax-injection",
    reasons: ["pax-key"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("uid", "0")] })),
  },
  {
    id: "pax-key-xattr",
    category: "pax-injection",
    reasons: ["pax-key"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("SCHILY.xattr.security.capability", "x")] })),
  },
  {
    id: "pax-duplicate-path",
    category: "pax-injection",
    reasons: ["pax-duplicate-key"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("path", `${C}/x`), paxRec("path", `${C}/../../y`)] })),
  },
  {
    id: "pax-embedded-record",
    category: "pax-injection",
    reasons: ["path-bad-char"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("path", `${C}/x\n30 linkpath=/etc/passwd`)] })),
  },
  {
    id: "pax-length-lies",
    category: "pax-injection",
    reasons: ["pax-syntax"],
    build: addMember(fileM(`${C}/x`, { pax: [Buffer.from(`99 path=${C}/x\n`)] })),
  },
  {
    id: "pax-length-leading-zero",
    category: "pax-injection",
    reasons: ["pax-syntax"],
    build: addMember(fileM(`${C}/x`, { pax: [Buffer.from(`0035 path=${C}/x\n`)] })),
  },
  {
    id: "pax-global-header",
    category: "pax-injection",
    reasons: ["member-type"],
    build: withPkg(
      (p) =>
        void p.members.splice(1, 0, {
          path: `${R}/PaxHeader`,
          type: "g",
          mode: 0o600,
          mtime: "0",
          content: paxRec("path", "/etc"),
          inManifest: false,
        }),
    ),
  },
  {
    id: "pax-chain",
    category: "pax-injection",
    reasons: ["pax-chain"],
    build: withPkg(
      (p) =>
        void p.members.splice(1, 0, {
          path: `${R}/PaxHeader`,
          type: "x",
          mode: 0o600,
          mtime: "0",
          content: paxRec("mtime", "1"),
          noPax: true,
          inManifest: false,
          pax: [paxRec("mtime", "2")],
        }),
    ),
  },
  {
    id: "pax-dangling",
    category: "pax-injection",
    reasons: ["pax-dangling", "missing-manifest"],
    build: withPkg(() => {
      const rec = paxRec("mtime", "1");
      return {
        omitManifest: true,
        afterManifest: [header({ name: `${R}/PaxHeader`, size: rec.length, type: "x" }), rec, pad(rec.length)],
      };
    }),
  },
  {
    id: "pax-name-wrong",
    category: "pax-injection",
    reasons: ["pax-name"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("mtime", "5")], paxHdr: { name: "../../PaxHeader" } })),
  },
  {
    id: "pax-oversized",
    category: "budget",
    reasons: ["budget-pax"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("mtime", "1"), Buffer.alloc(65 * 1024, 0x20)] })),
  },
  {
    id: "pax-size-mismatch",
    category: "pax-injection",
    reasons: ["pax-size-mismatch"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("size", "5")] })),
  },
  {
    id: "pax-size-negative",
    category: "pax-injection",
    reasons: ["pax-size"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("size", "-1")] })),
  },
  {
    id: "pax-size-unsafe",
    category: "pax-injection",
    reasons: ["pax-size"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("size", "9007199254740993")] })),
  },
  {
    id: "pax-mtime-range",
    category: "pax-injection",
    reasons: ["mtime-range"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("mtime", "2199023255553")], hdr: { mtime: 0 } })),
  },
  {
    id: "pax-mtime-syntax",
    category: "pax-injection",
    reasons: ["mtime-syntax"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("mtime", "-5")] })),
  },
  {
    id: "pax-empty",
    category: "pax-injection",
    reasons: ["pax-empty"],
    build: withPkg(
      (p) =>
        void p.members.splice(1, 0, {
          path: `${R}/PaxHeader`,
          type: "x",
          mode: 0o600,
          mtime: "0",
          noPax: true,
          inManifest: false,
        }),
    ),
  },

  // ── forbidden member types / header fields ──
  {
    id: "type-hardlink-member",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(
      fileM(`${C}/x`, { type: "1", content: Buffer.alloc(0), hdr: { linkname: FA }, inManifest: false }),
    ),
  },
  {
    id: "type-symlink-member",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(
      fileM(`${C}/x`, { type: "2", content: Buffer.alloc(0), hdr: { linkname: "/etc/passwd" }, inManifest: false }),
    ),
  },
  {
    id: "type-char-device",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "3", content: Buffer.alloc(0), inManifest: false })),
  },
  {
    id: "type-block-device",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "4", content: Buffer.alloc(0), inManifest: false })),
  },
  {
    id: "type-fifo",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "6", content: Buffer.alloc(0), inManifest: false })),
  },
  {
    id: "type-contiguous",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "7", inManifest: false })),
  },
  {
    id: "type-gnu-longname",
    category: "member-type",
    reasons: ["member-type"],
    build: withPkg(
      (p) =>
        void p.members.splice(1, 0, {
          path: "././@LongLink",
          type: "L",
          mode: 0o644,
          mtime: "0",
          content: Buffer.from("../../etc/passwd\0"),
          inManifest: false,
        }),
    ),
  },
  {
    id: "linkname-on-file",
    category: "member-type",
    reasons: ["header-linkname"],
    build: addMember(fileM(`${C}/x`, { hdr: { linkname: "/etc/passwd" } })),
  },
  {
    id: "mode-setuid",
    category: "member-type",
    reasons: ["mode-range"],
    build: addMember(fileM(`${C}/x`, { mode: 0o4755 })),
  },
  {
    id: "mode-sticky-dir",
    category: "member-type",
    reasons: ["mode-range"],
    build: addMember({ path: `${C}/Dx`, type: "5", mode: 0o1777, mtime: "1" }),
  },
  {
    id: "manifest-mode-range",
    category: "member-type",
    reasons: ["mode-range"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].mode = 0o4664) })),
  },
  {
    id: "hdr-checksum",
    category: "header",
    reasons: ["header-checksum"],
    build: addMember(fileM(`${C}/x`, { hdr: { chksumDelta: 1 } })),
  },
  {
    id: "hdr-gnu-magic",
    category: "header",
    reasons: ["header-magic"],
    build: addMember(fileM(`${C}/x`, { hdr: { magic: "ustar ", version: " \0" } })),
  },
  {
    id: "hdr-size-base256",
    category: "header",
    reasons: ["header-numeric"],
    build: addMember(fileM(`${C}/x`, { hdr: { sizeBase256: 1 } })),
  },
  {
    id: "hdr-size-non-octal",
    category: "header",
    reasons: ["header-numeric"],
    build: addMember(fileM(`${C}/x`, { hdr: { sizeRaw: "0000000009\0\0" } })),
  },
  {
    id: "hdr-mode-garbage",
    category: "header",
    reasons: ["header-numeric"],
    build: addMember(fileM(`${C}/x`, { hdr: { modeRaw: "-000644\0" } })),
  },
  {
    id: "hdr-size-exceeds",
    category: "header",
    reasons: ["size-exceeds-package"],
    build: addMember(fileM(`${C}/x`, { hdr: { size: 0o7777777 } })),
  },
  {
    id: "hdr-dir-size",
    category: "header",
    reasons: ["dir-size"],
    build: addMember({ path: `${C}/Dx`, type: "5", mode: 0o700, mtime: "1", hdr: { size: 512 } }),
  },
  {
    id: "hdr-file-trailing-slash",
    category: "header",
    reasons: ["file-path"],
    build: addMember(fileM(`${C}/x/`, { inManifest: false })),
  },
  {
    id: "hdr-padding-not-zero",
    category: "header",
    reasons: ["padding-not-zero"],
    build: addMember(fileM(`${C}/x`, { padByte: 0x41 })),
  },
  {
    id: "order-first-not-root",
    category: "header",
    reasons: ["first-member"],
    build: withPkg((p) => void p.members.unshift(p.members.splice(1, 1)[0])),
  },
  {
    id: "order-child-before-dir",
    category: "header",
    reasons: ["ancestor-missing"],
    build: withPkg((p) => void p.members.splice(4, 0, p.members.splice(5, 1)[0])),
  },
  {
    id: "order-member-under-file",
    category: "header",
    reasons: ["ancestor-not-dir"],
    build: addMember(fileM(`${FA}/x`)),
  },

  // ── truncation / trailer ──
  { id: "trunc-empty", category: "truncation", reasons: ["missing-manifest"], build: () => Buffer.alloc(0) },
  {
    id: "trunc-mid-header",
    category: "truncation",
    reasons: ["truncated"],
    build: () => assemble(clone()).subarray(0, BLOCK + 300),
  },
  {
    id: "trunc-mid-file",
    category: "truncation",
    reasons: ["truncated", "size-exceeds-package"],
    build: () => {
      const b = assemble(clone());
      return b.subarray(0, 4 * BLOCK + 200);
    },
  },
  {
    id: "trunc-no-trailer",
    category: "truncation",
    reasons: ["truncated"],
    build: withPkg(() => ({ trailer: Buffer.alloc(0) })),
  },
  {
    id: "trunc-one-zero-block",
    category: "truncation",
    reasons: ["truncated"],
    build: withPkg(() => ({ trailer: Buffer.alloc(BLOCK) })),
  },
  {
    id: "trailer-garbage",
    category: "truncation",
    reasons: ["trailer-garbage"],
    build: withPkg(() => ({ trailer: Buffer.concat([Buffer.alloc(2 * BLOCK), Buffer.from("x".repeat(BLOCK))]) })),
  },
  {
    id: "trailer-unaligned",
    category: "truncation",
    reasons: ["trailer-garbage"],
    build: withPkg(() => ({ trailer: Buffer.alloc(2 * BLOCK + 7) })),
  },
  {
    id: "trunc-zero-before-manifest",
    category: "truncation",
    reasons: ["missing-manifest"],
    build: withPkg(() => ({ omitManifest: true })),
  },
  {
    id: "member-after-manifest",
    category: "truncation",
    reasons: ["member-after-manifest"],
    build: withPkg(() => ({ afterManifest: [encodeMember(fileM(`${C}/late`))] })),
  },

  // ── MANIFEST ↔ members ──
  {
    id: "manifest-hash-mismatch",
    category: "manifest",
    reasons: ["manifest-hash-mismatch"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].sha256 = "0".repeat(64)) })),
  },
  {
    id: "manifest-size-mismatch",
    category: "manifest",
    reasons: ["manifest-hash-mismatch"],
    build: withPkg(() => ({ mutateManifest: (m) => ((m.entries[3].size += 1), (m.totals.bytes += 1)) })),
  },
  {
    id: "manifest-extra-member",
    category: "manifest",
    reasons: ["manifest-extra-member"],
    build: addMember(fileM(`${C}/unlisted`, { inManifest: false })),
  },
  {
    id: "manifest-missing-member",
    category: "manifest",
    reasons: ["manifest-missing-member"],
    build: withPkg(() => ({
      mutateManifest: (m) => (
        m.entries.push({
          path: `${C}/ghost`,
          type: "file",
          mode: 0o600,
          mtime: "1",
          size: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        }),
        m.totals.files++
      ),
    })),
  },
  {
    id: "manifest-type-mismatch",
    category: "manifest",
    reasons: ["manifest-type-mismatch"],
    build: withPkg(() => ({
      mutateManifest: (m) => {
        m.entries[4] = {
          path: m.entries[4].path,
          type: "file",
          mode: 0o775,
          mtime: "1700000002",
          size: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        };
        m.totals.dirs--;
        m.totals.files++;
      },
    })),
  },
  {
    id: "manifest-meta-mismatch",
    category: "manifest",
    reasons: ["manifest-meta-mismatch"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].mode = 0o600) })),
  },
  {
    id: "manifest-not-canonical",
    category: "manifest",
    reasons: ["manifest-not-canonical"],
    build: withPkg((p) => ({ manifestText: JSON.stringify(manifestOf(p), null, 2) + "\n" })),
  },
  {
    id: "manifest-duplicate-json-key",
    category: "manifest",
    reasons: ["manifest-not-canonical"],
    build: withPkg((p) => ({
      manifestText: `${JSON.stringify(manifestOf(p)).replace('{"format":"pi-secure-vault"', '{"format":"pi-secure-vault","v":1')}\n`,
    })),
  },
  {
    id: "manifest-unknown-key",
    category: "manifest",
    reasons: ["manifest-unknown-key"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.extra = 1) })),
  },
  {
    id: "manifest-entry-unknown-key",
    category: "manifest",
    reasons: ["manifest-entry-key"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].uid = 0) })),
  },
  {
    id: "manifest-entry-unknown-type",
    category: "manifest",
    reasons: ["manifest-entry-type"],
    build: addLink({ path: `${C}/Dv`, type: "device", mtime: "1" }),
  },
  {
    id: "manifest-version",
    category: "manifest",
    reasons: ["manifest-version"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.v = 1) })),
  },
  {
    id: "manifest-format",
    category: "manifest",
    reasons: ["manifest-format"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.format = "tar") })),
  },
  {
    id: "manifest-orig-relative",
    category: "manifest",
    reasons: ["manifest-orig-real-work"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.origRealWork = "secure/x/work") })),
  },
  {
    id: "manifest-orig-dotdot",
    category: "manifest",
    reasons: ["manifest-orig-real-work"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.origRealWork = "/home/u/../../work") })),
  },
  {
    id: "manifest-orig-not-work",
    category: "manifest",
    reasons: ["manifest-orig-real-work"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.origRealWork = "/home/u/secure/x/state") })),
  },
  {
    id: "manifest-name",
    category: "manifest",
    reasons: ["manifest-name"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.name = "../evil") })),
  },
  {
    id: "manifest-totals",
    category: "manifest",
    reasons: ["manifest-totals"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.totals.symlinks = 9) })),
  },
  {
    id: "manifest-non-utf8",
    category: "manifest",
    reasons: ["non-utf8"],
    build: withPkg(() => ({ manifestText: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]) })),
  },
  {
    id: "manifest-not-json",
    category: "manifest",
    reasons: ["manifest-json"],
    build: withPkg(() => ({ manifestText: "not json\n" })),
  },
  {
    id: "manifest-mtime-syntax",
    category: "manifest",
    reasons: ["mtime-syntax"],
    build: addLink({ path: `${C}/Sx`, type: "symlink", target_b64: "abc", mtime: 1 }),
  },
  {
    id: "manifest-oversized",
    category: "budget",
    reasons: ["budget-manifest"],
    budget: { maxManifestBytes: 1024 },
    build: withPkg(() => {}),
  },
  {
    id: "manifest-type-is-dir",
    category: "manifest",
    reasons: ["member-type"],
    build: withPkg(() => ({
      omitManifest: true,
      afterManifest: [encodeMember({ path: MANIFEST, type: "5", mode: 0o700, mtime: "1" })],
    })),
  },

  // ── gocryptfs.conf strict ──
  {
    id: "conf-plaintext-names",
    category: "conf",
    reasons: ["conf-plaintext-names"],
    build: confCase({ FeatureFlags: ["GCMIV128", "HKDF", "DirIV", "PlaintextNames"] }),
  },
  {
    id: "conf-unknown-flag",
    category: "conf",
    reasons: ["conf-unknown-flag"],
    build: confCase({ FeatureFlags: ["GCMIV128", "HKDF", "DirIV", "EMENames", "LongNames", "Raw64", "AESSIV"] }),
  },
  {
    id: "conf-duplicate-flag",
    category: "conf",
    reasons: ["conf-flags"],
    build: confCase({ FeatureFlags: ["GCMIV128", "GCMIV128"] }),
  },
  { id: "conf-unknown-key", category: "conf", reasons: ["conf-unknown-key"], build: confCase({ LongNameMax: 255 }) },
  { id: "conf-version", category: "conf", reasons: ["conf-version"], build: confCase({ Version: 3 }) },
  {
    id: "conf-scrypt-n",
    category: "conf",
    reasons: ["conf-scrypt"],
    build: confCase({ ScryptObject: { ...fakeConf().ScryptObject, N: 65535 } }),
  },
  {
    id: "conf-scrypt-keylen",
    category: "conf",
    reasons: ["conf-scrypt"],
    build: confCase({ ScryptObject: { ...fakeConf().ScryptObject, KeyLen: 16 } }),
  },
  {
    id: "conf-key-length",
    category: "conf",
    reasons: ["conf-key"],
    build: confCase({ EncryptedKey: det("k", 48).toString("base64") }),
  },
  { id: "conf-not-json", category: "conf", reasons: ["conf-json"], build: confRaw(Buffer.from("{nope")) },
  {
    id: "conf-oversized",
    category: "conf",
    reasons: ["conf-too-large"],
    build: confRaw(Buffer.alloc(65 * 1024 + 1, 0x20)),
  },
  {
    id: "conf-missing",
    category: "conf",
    reasons: ["missing-conf"],
    build: withPkg((p) => void p.members.splice(1, 1)),
  },
  {
    id: "diriv-missing",
    category: "conf",
    reasons: ["missing-diriv"],
    build: withPkg((p) => void p.members.splice(2, 1)),
  },
  {
    id: "diriv-wrong-size",
    category: "conf",
    reasons: ["missing-diriv"],
    build: withPkg((p) => void (p.members[2].content = det("iv", 17))),
  },
  {
    id: "conf-is-dir",
    category: "conf",
    reasons: ["missing-conf"],
    build: withPkg((p) => void (p.members[1] = { path: `${C}/gocryptfs.conf`, type: "5", mode: 0o700, mtime: "1" })),
  },

  // ── budgets (tightened via the budget option; real limits tested for pax/depth/path above) ──
  {
    id: "budget-members",
    category: "budget",
    reasons: ["budget-entries"],
    budget: { maxEntries: 5 },
    build: withPkg(() => {}),
  },
  {
    // baseline = 2 dirs + 5 files + 2 links + 1 MANIFEST = 10 units; 9 lets every member stream (8 units)
    // and only the MANIFEST's link entries push it over
    id: "budget-links-push-over",
    category: "budget",
    reasons: ["budget-entries"],
    budget: { maxEntries: 9 },
    build: withPkg(() => {}),
  },
  {
    id: "budget-depth-tight",
    category: "budget",
    reasons: ["path-too-deep"],
    budget: { maxDepth: 2 },
    build: withPkg(() => {}),
  },
  { id: "ok-budget-exact", category: "ok", reasons: [], budget: { maxEntries: 10 }, build: withPkg(() => {}) },
  {
    id: "budget-path-bytes",
    category: "budget",
    reasons: ["budget-path-bytes"],
    budget: { maxPathBytesTotal: 150 },
    build: withPkg(() => {}),
  },

  // ── security review V1 #1: scrypt cost ceiling (valid powers of two, but too expensive) ──
  {
    id: "ok-scrypt-n17",
    category: "ok",
    reasons: [],
    build: confCase({ ScryptObject: { ...fakeConf().ScryptObject, N: 2 ** 17 } }),
  },
  {
    id: "conf-scrypt-cost-n18",
    category: "conf",
    reasons: ["conf-scrypt-cost"],
    build: confCase({ ScryptObject: { ...fakeConf().ScryptObject, N: 2 ** 18 } }),
  },
  {
    id: "conf-scrypt-cost-n28",
    category: "conf",
    reasons: ["conf-scrypt-cost"],
    build: confCase({ ScryptObject: { ...fakeConf().ScryptObject, N: 2 ** 28 } }),
  },
  {
    id: "conf-json-deep",
    category: "json-structure",
    reasons: ["budget-json"],
    build: confRaw(Buffer.from("[".repeat(20000) + "]".repeat(20000))),
  },
  {
    id: "conf-json-many-nodes",
    category: "json-structure",
    reasons: ["budget-json"],
    build: confRaw(Buffer.from(JSON.stringify({ ...fakeConf(), FeatureFlags: Array(100).fill("HKDF") }))),
  },

  // ── security review V1 #2: JSON structure is bounded BEFORE JSON.parse ──
  {
    id: "manifest-json-deep-40k",
    category: "json-structure",
    reasons: ["budget-json"],
    build: withPkg(() => ({ manifestText: `${"[".repeat(20000)}${"]".repeat(20000)}\n` })), // 40 001 bytes
  },
  {
    id: "manifest-json-deep-field",
    category: "json-structure",
    reasons: ["budget-json"],
    build: withPkg((p) => ({ manifestText: `${JSON.stringify(manifestOf(p)).slice(0, -1)},"x":[[[[1]]]]}\n` })),
  },
  {
    id: "manifest-json-deep-object-in-entry",
    category: "json-structure",
    reasons: ["budget-json"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].mode = { a: { b: 1 } }) })),
  },
  {
    id: "manifest-json-wide-nodes",
    category: "json-structure",
    reasons: ["budget-json"],
    budget: { maxEntries: 10 }, // node ceiling 7·10+64 = 134
    build: withPkg((p) => ({
      manifestText: `${JSON.stringify(manifestOf(p)).slice(0, -1)},"pad":[${Array(300).fill(0).join(",")}]}\n`,
    })),
  },
  {
    id: "manifest-json-long-string",
    category: "json-structure",
    reasons: ["budget-json"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.gocryptfsVersion = "v".repeat(70 * 1024)) })),
  },
  {
    id: "manifest-json-unterminated",
    category: "json-structure",
    reasons: ["manifest-json"],
    build: withPkg(() => ({ manifestText: '{"format":"pi-secure-vault\n' })),
  },

  // ── security review V1 #4: prototype names / hostile value types never escape the 65 protocol ──
  // (an object/array as an entry FIELD value is depth 4 ⇒ refused by the JSON pre-scan already; the
  //  field validators themselves are exercised with such values directly in tar.test.ts)
  ...["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"].map((t) => ({
    id: `type-proto-${t}`,
    category: "json-types",
    reasons: ["manifest-entry-type"],
    build: addLink({ path: `${C}/Px`, type: t, mtime: "1" }),
  })),
  {
    id: "type-number",
    category: "json-types",
    reasons: ["manifest-entry-type"],
    build: addLink({ path: `${C}/Px`, type: 5, mtime: "1" }),
  },
  {
    id: "type-array",
    category: "json-types",
    reasons: ["budget-json"],
    build: addLink({ path: `${C}/Px`, type: ["symlink"], mtime: "1" }),
  },
  {
    id: "name-object-tostring",
    category: "json-types",
    reasons: ["manifest-name"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.name = { toString: 0 }) })),
  },
  {
    id: "format-object",
    category: "json-types",
    reasons: ["manifest-format"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.format = { valueOf: 0, toString: 0 }) })),
  },
  {
    id: "version-object",
    category: "json-types",
    reasons: ["manifest-version"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.v = { toString: 0 }) })),
  },
  {
    id: "path-object",
    category: "json-types",
    reasons: ["budget-json"],
    build: addLink({ path: { toString: 0 }, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "path-null",
    category: "json-types",
    reasons: ["path-empty"],
    build: addLink({ path: null, type: "symlink", target_b64: "abc", mtime: "1" }),
  },
  {
    id: "mtime-object",
    category: "json-types",
    reasons: ["budget-json"],
    build: addLink({ path: `${C}/Px`, type: "symlink", target_b64: "abc", mtime: { toString: 0 } }),
  },
  {
    id: "target-object",
    category: "json-types",
    reasons: ["budget-json"],
    build: addLink({ path: `${C}/Px`, type: "symlink", target_b64: { toString: 0 }, mtime: "1" }),
  },
  {
    id: "of-array",
    category: "json-types",
    reasons: ["budget-json"],
    build: addLink({ path: `${C}/Hx`, type: "hardlink", of: [FA] }),
  },
  {
    id: "mode-string",
    category: "json-types",
    reasons: ["mode-range"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].mode = "436") })),
  },
  {
    id: "size-bool",
    category: "json-types",
    reasons: ["manifest-entry-size"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries[3].size = true) })),
  },
  {
    id: "totals-null",
    category: "json-types",
    reasons: ["manifest-totals"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.totals = null) })),
  },
  {
    id: "entries-object",
    category: "json-types",
    reasons: ["manifest-entries"],
    build: withPkg(() => ({ mutateManifest: (m) => (m.entries = { length: 1 }) })),
  },
  {
    id: "entry-null",
    category: "json-types",
    reasons: ["manifest-entry"],
    build: withPkg(() => ({ mutateManifest: (m) => m.entries.push(null) })),
  },
  {
    id: "entry-own-proto-key",
    category: "json-types",
    reasons: ["manifest-entry-key"],
    build: withPkg((p) => ({
      manifestText: `${JSON.stringify(manifestOf(p)).replace('{"path":"pi-secure-vault/cipher/Fa0', '{"__proto__":0,"path":"pi-secure-vault/cipher/Fa0')}\n`,
    })),
  },
  {
    id: "manifest-own-proto-key",
    category: "json-types",
    reasons: ["manifest-unknown-key"],
    build: withPkg((p) => ({ manifestText: `{"__proto__":0,${JSON.stringify(manifestOf(p)).slice(1)}\n` })),
  },

  // ── security review: header / override semantics ──
  {
    id: "hdr-prefix-nul-injection",
    category: "header",
    reasons: ["header-nul-injection"],
    build: addMember(fileM(`${C}/x`, { hdr: { name: "x", prefix: Buffer.from(`${C}\0../../evil`) } })),
  },
  {
    id: "hdr-prefix-non-utf8",
    category: "header",
    reasons: ["non-utf8"],
    build: addMember(fileM(`${C}/x`, { hdr: { name: "x", prefix: Buffer.from([0x63, 0xc3]) } })),
  },
  {
    id: "type-gnu-longlink-K",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "K", inManifest: false })),
  },
  {
    id: "type-gnu-sparse-S",
    category: "member-type",
    reasons: ["member-type"],
    build: addMember(fileM(`${C}/x`, { type: "S", inManifest: false })),
  },
  {
    id: "pax-key-gnu-sparse",
    category: "pax-injection",
    reasons: ["pax-key"],
    build: addMember(fileM(`${C}/x`, { pax: [paxRec("GNU.sparse.size", "99999")] })),
  },
  {
    // a pax path overrides a hostile ustar name: only the pax path (validated) ever reaches the disk
    id: "ok-pax-overrides-ustar",
    category: "ok",
    reasons: [],
    build: addMember(fileM(`${C}/Px`, { paxOnly: true, hdr: { name: "../../../evil" } })),
  },
];

function confCase(over) {
  return withPkg((p) => void (p.members[1].content = confBytes(fakeConf(over))));
}
function confRaw(buf) {
  return withPkg((p) => void (p.members[1].content = buf));
}

// ───────────────────────────── CLI ─────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: node gen.mjs <outdir>\n");
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const index = [];
  for (const c of CASES) {
    fs.writeFileSync(path.join(out, `${c.id}.tar`), c.build(), { mode: 0o600 });
    index.push({ id: c.id, category: c.category, reasons: c.reasons, ...(c.budget ? { budget: c.budget } : {}) });
  }
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  process.stdout.write(`${CASES.length} cases → ${out}\n`);
}
