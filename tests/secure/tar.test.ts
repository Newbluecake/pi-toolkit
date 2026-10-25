/**
 * V1 — `pi-secure-vault/2` tar package (src/secure/bin/tar.mjs; docs/dev/data-encryption/convert-plan.md
 * §3.1/§3.3/§7.1, §R2 B6). No FUSE here (the real-gocryptfs XC2 gate lives in
 * tests/conformance/secure-convert-xc2.test.ts).
 *
 *  - unified path validator / budget clamp / strict gocryptfs.conf / MANIFEST validation
 *  - every case of the independent malicious corpus (tests/fixtures/secure-tar-corpus/gen.mjs) is refused
 *    with exit 65 and its expected reason, and NOTHING outside the staging root changes (sentinel
 *    snapshot of the staging parent + an "outside" canary dir, before / after / after discard)
 *  - writer → reader round trip on a synthetic cipher tree (long pax paths, ns mtimes, modes, symlinks,
 *    hardlink groups incl. hardlinked symlinks, multi-chunk file), byte-determinism, writer refusals
 *  - GNU tar can list our package; a GNU-tar-made package of the same tree is refused (XC5 subset)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  lutimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
/* eslint-disable @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design */
const T: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "tar.mjs")).href);
const G: any = await import(pathToFileURL(join(REPO, "tests", "fixtures", "secure-tar-corpus", "gen.mjs")).href);
const H: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "helper.mjs")).href);
/* eslint-enable @typescript-eslint/no-explicit-any */

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) {
    try {
      T.discardStaging(d);
    } catch {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

function which(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
}

/** Recursive lstat snapshot (path → type/mode/size/mtime/ino/link target/content hash-lite), optional exclusion. */
function snapshot(root: string, exclude?: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (p === exclude) return;
    const st = lstatSync(p, { bigint: true });
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : st.isFile() ? "f" : "o";
    const extra = kind === "l" ? readlinkSync(p) : kind === "f" ? readFileSync(p).toString("base64") : "";
    // the root's own line is skipped: removing S legitimately changes the parent's mtime/nlink
    if (p !== root)
      out.push(`${p.slice(root.length)}|${kind}|${st.mode}|${st.size}|${st.mtimeNs}|${st.ino}|${st.nlink}|${extra}`);
    if (kind === "d") for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(root);
  return out;
}

function expectPkgError(fn: () => unknown, reasons: string[], exitCode = 65): { reason: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(T.PkgError);
    const err = e as { reason: string; exitCode: number; message: string };
    expect(reasons, err.message).toContain(err.reason);
    expect(err.exitCode, err.message).toBe(exitCode);
    return err;
  }
  throw new Error(`expected PkgError ${reasons.join("|")}, got success`);
}

/** Outer root with sentinels + an outside canary dir; the staging root S sits inside it. */
function arena(): { outer: string; S: string; outside: string } {
  const outer = tmp("v1-arena-");
  const outside = join(outer, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "canary"), "do-not-touch");
  writeFileSync(join(outer, "sentinel"), "s");
  mkdirSync(join(outer, "etc"));
  writeFileSync(join(outer, "etc", "passwd"), "p");
  const S = join(outer, "stage");
  mkdirSync(S, 0o700);
  return { outer, S, outside };
}

describe("checkPkgPath — the unified validator", () => {
  const C = "pi-secure-vault/cipher";
  it("accepts the cipher root, cipher names (incl. longname files) and the MANIFEST", () => {
    expect(T.checkPkgPath(C)).toMatchObject({ kind: "cipher", parent: null, depth: 1, rel: "cipher" });
    expect(T.checkPkgPath(`${C}/76jjN2k4Kllv2fPgvjnAfw/gocryptfs.diriv`)).toMatchObject({
      parent: `${C}/76jjN2k4Kllv2fPgvjnAfw`,
      depth: 3,
    });
    expect(T.checkPkgPath(`${C}/gocryptfs.longname.6iMJqq9kKrQnLORtwpTLBCNjX_PELU3y_OwhiPLEX.name`).kind).toBe(
      "cipher",
    );
    expect(T.checkPkgPath(`${C}/a=b-c_d.e`).kind).toBe("cipher");
    expect(T.checkPkgPath("pi-secure-vault/MANIFEST.json")).toEqual({
      kind: "manifest",
      path: "pi-secure-vault/MANIFEST.json",
    });
  });
  it.each([
    ["", "path-empty"],
    ["/etc/passwd", "path-absolute"],
    [`${C}/../x`, "path-dot-segment"],
    [`${C}/./x`, "path-dot-segment"],
    [`${C}//x`, "path-empty-segment"],
    [`${C}/x/`, "path-empty-segment"],
    [`${C}\\x`, "path-backslash"],
    [`${C}/x\0`, "path-nul"],
    [`${C}/\u00e9`, "path-bad-char"],
    [`${C}/a b`, "path-bad-char"],
    [`${C}/a\nb`, "path-bad-char"],
    ["pi-secure-vault", "path-prefix"],
    ["pi-secure-vault/MANIFEST.json/x", "path-prefix"],
    ["pi-secure-vault/state/x", "path-prefix"],
    ["other/cipher/x", "path-prefix"],
    [`${C}/${"a".repeat(256)}`, "segment-too-long"],
    [`${C}/${"a/".repeat(64)}z`, "path-too-deep"],
    [`${C}/${"a".repeat(4100)}`, "path-too-long"],
    [`${C}/\ud800`, "non-utf8"],
  ])("refuses %j (%s)", (p, reason) => {
    expectPkgError(() => T.checkPkgPath(p), [reason]);
  });
  it("non-strings are refused", () => {
    expectPkgError(() => T.checkPkgPath(5), ["path-empty"]);
  });
});

describe("budgets, mtime grammar, conf and helper parity", () => {
  it("effectiveBudget only tightens", () => {
    const b = T.effectiveBudget({ maxEntries: 10, maxPaxBytes: 10 ** 9, maxDepth: -1, bogus: 1 });
    expect(b.maxEntries).toBe(10);
    expect(b.maxPaxBytes).toBe(64 * 1024);
    expect(b.maxDepth).toBe(64);
    expect(b).not.toHaveProperty("bogus");
    expect(T.BUDGET).toMatchObject({
      maxEntries: 1_000_000,
      maxManifestBytes: 64 * 1024 * 1024,
      maxPaxBytes: 64 * 1024,
      maxDepth: 64,
      maxPathBytes: 4096,
      maxSegmentBytes: 255,
      maxSymlinkTargetBytes: 4096,
      maxMtimeSec: 2 ** 41,
    });
  });
  it("VAULT_NAME_RE is helper.mjs's", () => {
    expect(T.VAULT_NAME_RE.source).toBe(H.VAULT_NAME_RE.source);
    expect(T.VAULT_NAME_RE.flags).toBe(H.VAULT_NAME_RE.flags);
  });
  it("mtime grammar and exact stat formatting", () => {
    for (const ok of ["0", "1700000000", "1700000000.5", "1.123456789", String(2 ** 41)])
      expect(T.checkMtime(ok)).toBe(ok);
    for (const [v, r] of [
      ["-1", "mtime-syntax"],
      ["01", "mtime-syntax"],
      ["1.", "mtime-syntax"],
      ["1.1234567890", "mtime-syntax"],
      ["1e5", "mtime-syntax"],
      [String(2 ** 41 + 1), "mtime-range"],
    ] as const)
      expectPkgError(() => T.checkMtime(v), [r]);
    expect(T.mtimeFromStat({ mtimeNs: 1600000000123456789n })).toBe("1600000000.123456789");
    expect(T.mtimeFromStat({ mtimeNs: 1500000000500000000n })).toBe("1500000000.5");
    expect(T.mtimeFromStat({ mtimeNs: 1500000000000000000n })).toBe("1500000000");
  });
  it("gocryptfs.conf: the gocryptfs 1.8 init shape passes; every deviation is refused", () => {
    const good = G.fakeConf();
    expect(T.validateGocryptfsConf(JSON.stringify(good, null, "\t")).Version).toBe(2);
    expect(T.CONF_FEATURE_FLAGS).toEqual(good.FeatureFlags);
    const cases: [unknown, string][] = [
      [{ ...good, FeatureFlags: [...good.FeatureFlags, "PlaintextNames"] }, "conf-plaintext-names"],
      [{ ...good, FeatureFlags: ["XChaCha20Poly1305"] }, "conf-unknown-flag"],
      [{ ...good, FeatureFlags: "GCMIV128" }, "conf-flags"],
      [{ ...good, Extra: 1 }, "conf-unknown-key"],
      [(({ Creator: _c, ...rest }) => rest)(good), "conf-missing-key"],
      [{ ...good, Version: "2" }, "conf-version"],
      [{ ...good, Creator: "evil" }, "conf-creator"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, N: 2 ** 29 } }, "conf-scrypt"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, R: 1 } }, "conf-scrypt"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, Salt: "!!" } }, "conf-scrypt"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, X: 1 } }, "conf-scrypt"],
      [{ ...good, EncryptedKey: `${good.EncryptedKey}AAAA` }, "conf-key"],
      [[good], "budget-json"], // depth 3 > 2: refused by the pre-scan before JSON.parse
      [[1], "conf-shape"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, N: 2 ** 18 } }, "conf-scrypt-cost"],
      [{ ...good, ScryptObject: { ...good.ScryptObject, N: 2 ** 28 } }, "conf-scrypt-cost"],
    ];
    for (const [c, r] of cases) expectPkgError(() => T.validateGocryptfsConf(JSON.stringify(c)), [r]);
    expectPkgError(() => T.validateGocryptfsConf(Buffer.from([0xff])), ["non-utf8"]);
    expectPkgError(() => T.validateGocryptfsConf("{"), ["conf-json"]);
    expectPkgError(() => T.validateGocryptfsConf(" ".repeat(65 * 1024 + 1)), ["conf-too-large"]);
  });
  it("memberHeaders: ≥8^11 sizes ride pax with ustar size 0; parsePax round-trips; ustar path split at /", () => {
    const h = T.memberHeaders({ path: "pi-secure-vault/cipher/x", type: "0", mode: 0o600, size: 8 ** 11, mtime: "5" });
    expect(h.length).toBe(3 * 512);
    expect(h.subarray(156, 157).toString()).toBe("x");
    const recLen = parseInt(h.subarray(124, 136).toString().replace(/\0.*/, ""), 8);
    expect(T.parsePax(h.subarray(512, 512 + recLen))).toEqual({ size: 8 ** 11 });
    expect(h.subarray(1024 + 124, 1024 + 135).toString()).toBe("00000000000");
    const long = `pi-secure-vault/cipher/${"a".repeat(120)}/f`;
    const hl = T.memberHeaders({ path: long, type: "0", mode: 0o600, size: 0, mtime: "5" });
    expect(hl.length).toBe(512); // fits as ustar prefix/name, no pax
    expect(hl.subarray(345, 500).toString().replace(/\0+$/, "")).toBe(`pi-secure-vault/cipher/${"a".repeat(120)}`);
  });
});

describe("malicious corpus (gen.mjs): every case refused with 65, nothing outside the staging root changes", () => {
  it("the corpus is broad: ≥190 cases covering every required category", () => {
    const cats = new Set(G.CASES.map((c: { category: string }) => c.category));
    for (const c of [
      "traversal",
      "absolute",
      "link-path",
      "nul",
      "overlong",
      "duplicate",
      "case-unicode",
      "link-escape",
      "hardlink-cycle",
      "pax-injection",
      "member-type",
      "header",
      "truncation",
      "manifest",
      "conf",
      "budget",
      "json-structure",
      "json-types",
    ])
      expect(cats).toContain(c);
    expect(G.CASES.length).toBeGreaterThanOrEqual(190);
    expect(new Set(G.CASES.map((c: { id: string }) => c.id)).size).toBe(G.CASES.length);
  });

  for (const c of G.CASES as {
    id: string;
    category: string;
    reasons: string[];
    budget?: object;
    build: () => Buffer;
  }[]) {
    it(`${c.category} · ${c.id}`, () => {
      const { outer, S, outside } = arena();
      const pkg = join(outside, "..", `pkg-${c.id}.tar`);
      writeFileSync(pkg, c.build());
      const before = snapshot(outer, S);
      if (c.reasons.length === 0 && c.id !== "ok-baseline") {
        const r = T.readPackage({ pkgPath: pkg, stagingRoot: S, budget: c.budget });
        expect(r.manifest.format).toBe("pi-secure-vault");
        if (c.id === "ok-pax-overrides-ustar") {
          expect(lstatSync(join(S, "cipher", "Px")).isFile()).toBe(true);
          expect(snapshot(S).some((l) => l.includes("evil"))).toBe(false);
        }
      } else if (c.reasons.length === 0) {
        const r = T.readPackage({ pkgPath: pkg, stagingRoot: S, budget: c.budget });
        expect(r.counts).toMatchObject({ dirs: 2, files: 5, symlinks: 1, hardlinks: 1, members: 8 });
        const cipher = join(S, "cipher");
        expect(readlinkSync(join(cipher, "S1ssssssssssssssssssss"))).toBe("AbC-_=xyz");
        const fa = statSync(join(cipher, "Fa0aaaaaaaaaaaaaaaaaaa"), { bigint: true });
        const h1 = statSync(join(cipher, "D1dddddddddddddddddddd", "H1hhhhhhhhhhhhhhhhhhhh"), { bigint: true });
        expect(h1.ino).toBe(fa.ino);
        expect(fa.nlink).toBe(2n);
        expect(Number(fa.mode & 0o777n)).toBe(0o664);
        expect(fa.mtimeNs / 1000n).toBe(1700000001250000n);
        expect(statSync(cipher).mode & 0o777).toBe(0o775);
        expect(lstatSync(join(cipher, "S1ssssssssssssssssssss"), { bigint: true }).mtimeNs / 1000n).toBe(
          1700000004750000n,
        );
        expect(r.manifest.origRealWork).toBe("/home/u/secure/corpus/work");
      } else {
        expectPkgError(() => T.readPackage({ pkgPath: pkg, stagingRoot: S, budget: c.budget }), c.reasons);
        // everything that exists below S is a plain dir/file the reader created (no link survives a refusal
        // that happened before link rebuilding, and link rebuilding only ever runs after all checks)
        for (const line of snapshot(S)) expect(line.split("|")[1]).not.toBe("o");
      }
      expect(snapshot(outer, S)).toEqual(before);
      T.discardStaging(S);
      expect(existsSync(S)).toBe(false);
      expect(snapshot(outer, S)).toEqual(before);
      expect(readFileSync(join(outside, "canary"), "utf8")).toBe("do-not-touch");
    });
  }

  it("gen.mjs CLI writes every case + index.json", () => {
    const out = join(tmp("v1-gen-"), "corpus");
    const r = spawnSync(process.execPath, [join(REPO, "tests/fixtures/secure-tar-corpus/gen.mjs"), out], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const idx = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(idx.length).toBe(G.CASES.length);
    for (const e of idx) expect(existsSync(join(out, `${e.id}.tar`))).toBe(true);
  });
});

describe("staging root and package preconditions", () => {
  const good = () => G.assemble(G.baseline());
  it("refuses a non-empty / group-accessible / symlinked staging root (74) and a FIFO / symlinked package", () => {
    const { outer, S } = arena();
    const pkg = join(outer, "p.tar");
    writeFileSync(pkg, good());
    writeFileSync(join(S, "x"), "");
    expectPkgError(() => T.readPackage({ pkgPath: pkg, stagingRoot: S }), ["staging"], 74);
    rmSync(join(S, "x"));
    chmodSync(S, 0o770);
    expectPkgError(() => T.readPackage({ pkgPath: pkg, stagingRoot: S }), ["staging"], 74);
    chmodSync(S, 0o700);
    const link = join(outer, "stage-link");
    symlinkSync(S, link);
    expectPkgError(() => T.readPackage({ pkgPath: pkg, stagingRoot: link }), ["staging"], 74);
    const plink = join(outer, "p-link.tar");
    symlinkSync(pkg, plink);
    expectPkgError(() => T.readPackage({ pkgPath: plink, stagingRoot: S }), ["io"], 74);
    const fifo = join(outer, "fifo.tar");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expectPkgError(() => T.readPackage({ pkgPath: fifo, stagingRoot: S }), ["package-not-file"]);
    expect(readdirSync(S)).toEqual([]);
  });
  it("discardStaging never follows a symlink out of the staging root", () => {
    const { outer, S, outside } = arena();
    mkdirSync(join(S, "d"), 0o500);
    symlinkSync(outside, join(S, "d-out"));
    writeFileSync(join(S, "f"), "x");
    const before = snapshot(outer, S);
    T.discardStaging(S);
    expect(existsSync(S)).toBe(false);
    expect(snapshot(outer, S)).toEqual(before);
  });
  it("reports progress", () => {
    const { outer, S } = arena();
    const pkg = join(outer, "p.tar");
    writeFileSync(pkg, good());
    const seen: string[] = [];
    T.readPackage({ pkgPath: pkg, stagingRoot: S, onProgress: (p: { phase: string }) => seen.push(p.phase) });
    expect(seen).toContain("read");
    expect(seen).toContain("link");
    expect(seen.at(-1)).toBe("done");
  });
});

/** A synthetic gocryptfs-shaped cipher tree (no real encryption needed for the format round trip). */
function buildCipherTree(root: string): string {
  const c = join(root, "cipher");
  mkdirSync(c, 0o755);
  writeFileSync(join(c, "gocryptfs.conf"), JSON.stringify(G.fakeConf(), null, "\t") + "\n", { mode: 0o400 });
  writeFileSync(join(c, "gocryptfs.diriv"), Buffer.alloc(16, 1), { mode: 0o440 });
  let d = c;
  for (let i = 0; i < 6; i++) {
    d = join(d, `D${i}${"x".repeat(30)}`); // deep: forces pax paths (> 255 bytes)
    mkdirSync(d, i % 2 ? 0o700 : 0o751);
    writeFileSync(join(d, "gocryptfs.diriv"), Buffer.alloc(16, i), { mode: 0o440 });
  }
  writeFileSync(join(d, "deepfile"), "deep", { mode: 0o640 });
  writeFileSync(join(c, "gocryptfs.longname.6iMJqq9kKrQnLORtwpTLBCNjX_PELU3y_OwhiPLEX"), "x".repeat(17));
  writeFileSync(join(c, "gocryptfs.longname.6iMJqq9kKrQnLORtwpTLBCNjX_PELU3y_OwhiPLEX.name"), "n", { mode: 0o400 });
  writeFileSync(join(c, "empty-file="), "");
  const big = Buffer.alloc(3 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  writeFileSync(join(c, "big_file-A"), big, { mode: 0o600 });
  mkdirSync(join(c, "emptydir"), 0o700);
  writeFileSync(join(c, "emptydir", "gocryptfs.diriv"), Buffer.alloc(16, 9), { mode: 0o440 });
  writeFileSync(join(c, "hl0"), "group", { mode: 0o644 });
  linkSync(join(c, "hl0"), join(c, "emptydir", "hl1"));
  linkSync(join(c, "hl0"), join(d, "hl2"));
  symlinkSync("fUil1dTMs-P79aF_3CqVbTD1MEh3zMYtIfw5fcIpfIAmFX5Gm6lDrzkfbA", join(c, "sym0"));
  symlinkSync("t".repeat(4043), join(c, "symlong"));
  linkSync(join(c, "sym0"), join(c, "symHard")); // hardlinked symlink (gocryptfs keeps these, XC2)
  utimesSync(join(c, "big_file-A"), 1600000000.123456, 1600000000.123456);
  lutimesSync(join(c, "sym0"), 1500000000.5, 1500000000.5);
  for (const p of [d, c]) utimesSync(p, 1400000000.25, 1400000000.25);
  return c;
}

function treeFacts(c: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inodes = new Map<bigint, string>();
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { bigint: true });
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
    let group = "";
    if (kind === "f" && st.nlink > 1n) {
      group = inodes.get(st.ino) ?? rel;
      inodes.set(st.ino, group);
    }
    const body =
      kind === "f"
        ? `${createHash("sha256").update(readFileSync(p)).digest("hex")}#${st.size}`
        : kind === "l"
          ? readlinkSync(p)
          : "";
    out[rel] = `${kind}|${kind === "l" ? "" : (st.mode & 0o7777n).toString(8)}|${st.nlink}|${group}|${body}`;
    if (kind === "d") for (const n of readdirSync(p)) walk(join(p, n), `${rel}/${n}`);
  };
  walk(c, "cipher");
  return out;
}

/** rel → mtime (ns). Compared with a 2 µs tolerance: Node passes float seconds and libuv truncates to µs, so the
 *  importer restores mtimes to ≤~1.3 µs (the package itself carries the exact ns value). */
function mtimesOf(top: string, rootRel: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { bigint: true });
    out.set(rel, st.mtimeNs);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n), `${rel}/${n}`);
  };
  walk(top, rootRel);
  return out;
}
function expectMtimesClose(got: Map<string, bigint>, want: Map<string, bigint>): void {
  expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
  for (const [k, v] of want) {
    const d = got.get(k)! - v;
    expect(d >= -2000n && d <= 2000n, `${k}: Δ ${d} ns`).toBe(true);
  }
}

describe("security review V1 #1/#2/#4: KDF ceiling, bounded JSON, hostile values", () => {
  it("scrypt ceiling = one doubling of gocryptfs's default (N=2^17·R=8·128 B = 128 MiB)", () => {
    expect(T.SCRYPT_MAX_MEM_BYTES).toBe(128 * 1024 * 1024);
    expect(T.SCRYPT_MAX_WORK).toBe(2 ** 17 * 8);
    const so = G.fakeConf().ScryptObject;
    for (const N of [2 ** 10, 2 ** 16, 2 ** 17])
      expect(T.validateGocryptfsConf(JSON.stringify(G.fakeConf({ ScryptObject: { ...so, N } }))).ScryptObject.N).toBe(
        N,
      );
    for (const N of [2 ** 18, 2 ** 20, 2 ** 28])
      expectPkgError(
        () => T.validateGocryptfsConf(JSON.stringify(G.fakeConf({ ScryptObject: { ...so, N } }))),
        ["conf-scrypt-cost"],
      );
  });

  it("prescanJson bounds depth, value nodes and string tokens without parsing; keys are not nodes", () => {
    const lim = { maxDepth: 3, maxNodes: 10 };
    expect(() => T.prescanJson('{"a":[{"b":"x\\"y"}]}', lim)).not.toThrow();
    expectPkgError(() => T.prescanJson("[[[[1]]]]", lim), ["budget-json"]);
    expectPkgError(() => T.prescanJson("[".repeat(20000) + "]".repeat(20000), lim), ["budget-json"]);
    expect(() => T.prescanJson('{"k1":1,"k2":2,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"k8":8,"k9":9}', lim)).not.toThrow(); // 10 nodes
    expectPkgError(
      () => T.prescanJson('{"k1":1,"k2":2,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"k8":8,"k9":9,"k10":0}', lim),
      ["budget-json"],
    );
    expectPkgError(() => T.prescanJson(`["${"s".repeat(70 * 1024)}"]`, lim), ["budget-json"]);
    expectPkgError(() => T.prescanJson('["abc', lim), ["manifest-json"]);
    expectPkgError(() => T.prescanJson(42, lim), ["manifest-json"]); // non-string ⇒ still a PkgError(65)
  });

  it("the real writer's MANIFEST fits the pre-scan node ceiling exactly (7 nodes per entry + fixed part)", () => {
    const root = tmp("v1-nodes-");
    const c = join(root, "cipher");
    mkdirSync(c, 0o755);
    writeFileSync(join(c, "gocryptfs.conf"), JSON.stringify(G.fakeConf()), { mode: 0o400 });
    writeFileSync(join(c, "gocryptfs.diriv"), Buffer.alloc(16), { mode: 0o440 });
    for (let i = 0; i < 40; i++) writeFileSync(join(c, `f${i}`), String(i));
    const fd = openSync(join(root, "o.tar"), "wx", 0o600);
    let w;
    try {
      w = T.writePackage({ cipherDir: c, fd, ...META, budget: { maxEntries: 44 } }); // 43 entries + 1 = exact
    } finally {
      closeSync(fd);
    }
    const S = join(root, "S");
    mkdirSync(S, 0o700);
    expect(
      T.readPackage({ pkgPath: join(root, "o.tar"), stagingRoot: S, budget: { maxEntries: 44 } }).manifest,
    ).toEqual(w.manifest);
  });

  it("hostile values (throwing getters, Proxies, prototype names) only ever yield PkgError(65)", () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    const throwingStr = { toString: boom, valueOf: boom };
    const trap = new Proxy(
      {},
      { get: boom, ownKeys: boom, getPrototypeOf: boom, has: boom, getOwnPropertyDescriptor: boom },
    );
    const good = (): Record<string, unknown> => {
      const p = G.baseline();
      return JSON.parse(JSON.stringify(G.manifestOf(p)));
    };
    const mutations: [string, (m: Record<string, unknown> & { entries: Record<string, unknown>[] }) => void][] = [
      ["name", (m) => (m.name = throwingStr)],
      ["format", (m) => (m.format = throwingStr)],
      ["v", (m) => (m.v = throwingStr)],
      ["exportedAt", (m) => (m.exportedAt = trap)],
      ["origRealWork", (m) => (m.origRealWork = throwingStr)],
      ["entries", (m) => (m.entries = trap as never)],
      ["entry", (m) => (m.entries[0] = trap)],
      ["type", (m) => (m.entries[3]!.type = throwingStr)],
      ["type-proto", (m) => (m.entries[3]!.type = "__proto__")],
      ["type-ctor", (m) => (m.entries[3]!.type = "constructor")],
      ["type-tostring", (m) => (m.entries[3]!.type = "toString")],
      ["path", (m) => (m.entries[3]!.path = throwingStr)],
      ["mode", (m) => (m.entries[3]!.mode = throwingStr)],
      ["mtime", (m) => (m.entries[3]!.mtime = throwingStr)],
      ["size", (m) => (m.entries[3]!.size = trap)],
      ["sha", (m) => (m.entries[3]!.sha256 = throwingStr)],
      ["target", (m) => (m.entries[7]!.target_b64 = throwingStr)],
      ["of", (m) => (m.entries[8]!.of = throwingStr)],
      ["totals", (m) => (m.totals = trap)],
    ];
    for (const [what, mut] of mutations) {
      const m = good() as Record<string, unknown> & { entries: Record<string, unknown>[] };
      mut(m);
      try {
        T.validateManifest(m);
        throw new Error(`${what}: accepted`);
      } catch (e) {
        expect(e, what).toBeInstanceOf(T.PkgError);
        expect((e as { exitCode: number }).exitCode, what).toBe(65);
      }
    }
    for (const v of [trap, throwingStr, null, 5, [], Symbol("s")]) {
      for (const fn of [T.checkPkgPath, T.checkMtime, T.validateManifest, T.validateGocryptfsConf, T.parsePax]) {
        try {
          fn(v);
          throw new Error(`accepted ${fn.name} ${typeof v}`);
        } catch (e) {
          expect(e).toBeInstanceOf(T.PkgError);
          expect((e as { exitCode: number }).exitCode).toBe(65);
        }
      }
    }
  });
});

const META = {
  name: "acme",
  gocryptfsVersion: "gocryptfs 1.8.0; go-fuse 2.0.3",
  origRealWork: "/home/u/secure/acme/work",
  exportedAt: "2026-10-24T01:02:03.000Z",
};
/** root + conf + diriv (+ optional symlink + hardlink): 3 (5) entries ⇒ 4 (6) budget units. */
function tinyCipher(withLinks: boolean): string {
  const root = tmp("v1-units-");
  const c = join(root, "cipher");
  mkdirSync(c, 0o755);
  writeFileSync(join(c, "gocryptfs.conf"), JSON.stringify(G.fakeConf()), { mode: 0o400 });
  writeFileSync(join(c, "gocryptfs.diriv"), Buffer.alloc(16), { mode: 0o440 });
  if (withLinks) {
    symlinkSync("abcDEF", join(c, "sym"));
    linkSync(join(c, "gocryptfs.diriv"), join(c, "hl"));
  }
  return c;
}
function writeWith(c: string, budget: object | undefined, tag: string): { file: string; err?: { reason: string } } {
  const file = join(c, "..", `${tag}.tar`);
  const fd = openSync(file, "wx", 0o600);
  try {
    T.writePackage({ cipherDir: c, fd, ...META, ...(budget ? { budget } : {}) });
    return { file };
  } catch (e) {
    return { file, err: e as { reason: string } };
  } finally {
    closeSync(fd);
  }
}
function readWith(file: string, budget: object | undefined): { reason?: string } {
  const S = mkdtempSync(join(file, "..", "S-"));
  chmodSync(S, 0o700);
  try {
    T.readPackage({ pkgPath: file, stagingRoot: S, ...(budget ? { budget } : {}) });
    return {};
  } catch (e) {
    return { reason: (e as { reason: string }).reason };
  } finally {
    T.discardStaging(S);
  }
}

describe("security review V1 #5: one budget unit for writer, streaming reader and link total", () => {
  for (const withLinks of [false, true]) {
    const units = withLinks ? 6 : 4;
    it(`${withLinks ? "with" : "without"} links: exact limit round-trips, limit-1 is refused by BOTH sides, nothing written on refusal`, () => {
      expect(T.entryUnits({ dirs: 1, files: withLinks ? 3 : 2, links: withLinks ? 1 : 0 })).toBe(units);
      const c = tinyCipher(withLinks);
      const exact = writeWith(c, { maxEntries: units }, "exact");
      expect(exact.err).toBeUndefined();
      expect(readWith(exact.file, { maxEntries: units })).toEqual({});
      const under = writeWith(c, { maxEntries: units - 1 }, "under");
      expect(under.err?.reason).toBe("budget-entries");
      expect(statSync(under.file).size).toBe(0); // all budget checks run before the first byte
      const dflt = writeWith(c, undefined, "default");
      expect(readWith(dflt.file, { maxEntries: units - 1 }).reason).toBe("budget-entries");
      expect(readWith(dflt.file, { maxEntries: units + 1 })).toEqual({});
    });
  }
  it("path-bytes and MANIFEST-bytes budgets: the writer's self-check equals the reader's limit", () => {
    const c = tinyCipher(true);
    const dflt = writeWith(c, undefined, "d");
    const m = JSON.parse(execTarManifest(dflt.file));
    const pathBytes = m.entries.reduce((n: number, e: { path: string }) => n + Buffer.byteLength(e.path), 0);
    const manBytes = Buffer.byteLength(`${JSON.stringify(m)}\n`);
    expect(writeWith(c, { maxPathBytesTotal: pathBytes }, "p-ok").err).toBeUndefined();
    expect(readWith(dflt.file, { maxPathBytesTotal: pathBytes })).toEqual({});
    expect(writeWith(c, { maxPathBytesTotal: pathBytes - 1 }, "p-under").err?.reason).toBe("budget-path-bytes");
    expect(readWith(dflt.file, { maxPathBytesTotal: pathBytes - 1 }).reason).toBe("budget-path-bytes");
    expect(writeWith(c, { maxManifestBytes: manBytes }, "m-ok").err).toBeUndefined();
    expect(readWith(dflt.file, { maxManifestBytes: manBytes })).toEqual({});
    expect(writeWith(c, { maxManifestBytes: manBytes - 1 }, "m-under").err?.reason).toBe("budget-manifest");
    expect(readWith(dflt.file, { maxManifestBytes: manBytes - 1 }).reason).toBe("budget-manifest");
  });
});

/** The MANIFEST text of one of our packages (it is the last member; read via the reader's own result). */
function execTarManifest(file: string): string {
  const S = mkdtempSync(join(file, "..", "M-"));
  chmodSync(S, 0o700);
  try {
    return `${JSON.stringify(T.readPackage({ pkgPath: file, stagingRoot: S }).manifest)}`;
  } finally {
    T.discardStaging(S);
  }
}

describe("writer → reader round trip", () => {
  const meta = {
    name: "acme",
    gocryptfsVersion: "gocryptfs 1.8.0; go-fuse 2.0.3",
    origRealWork: "/home/u/secure/acme/work",
    exportedAt: "2026-10-24T01:02:03.000Z",
  };
  function exportTo(c: string, file: string): ReturnType<typeof T.writePackage> {
    const fd = openSync(file, "wx", 0o600);
    try {
      return T.writePackage({ cipherDir: c, fd, ...meta });
    } finally {
      closeSync(fd);
    }
  }

  it("preserves every cipher fact (types, modes, mtimes, contents, link texts, hardlink groups)", () => {
    const root = tmp("v1-rt-");
    const c = buildCipherTree(root);
    const want = treeFacts(c);
    const wantM = mtimesOf(c, "cipher");
    const file = join(root, "out.tar");
    const w = exportTo(c, file);
    expect(w.manifest.totals).toMatchObject({ symlinks: 3, hardlinks: 2 });
    expect(
      w.manifest.entries.filter((e: { type: string }) => e.type === "symlink").map((e: { path: string }) => e.path),
    ).toContain("pi-secure-vault/cipher/symHard");
    const S = join(root, "stage");
    mkdirSync(S, 0o700);
    const r = T.readPackage({ pkgPath: file, stagingRoot: S });
    expect(r.manifest).toEqual(w.manifest);
    const got = treeFacts(join(S, "cipher"));
    // the only deliberate difference: a hardlinked SYMLINK comes back as two independent symlinks
    expect(want["cipher/sym0"]!.split("|")[2]).toBe("2");
    expect(got["cipher/sym0"]!.split("|")[2]).toBe("1");
    const norm = (f: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(f).map(([k, v]) => [
          k,
          v.startsWith("l|")
            ? v
                .split("|")
                .filter((_, i) => i !== 2)
                .join("|")
            : v,
        ]),
      );
    expect(norm(got)).toEqual(norm(want));
    expectMtimesClose(mtimesOf(join(S, "cipher"), "cipher"), wantM);
    expect(r.bytes).toBe(w.manifest.totals.bytes);
  });

  it("an equal-length corruption in the middle or at the tail of a large file is caught (full sha256)", () => {
    const root = tmp("v1-tamper-");
    const c = buildCipherTree(root);
    const file = join(root, "good.tar");
    exportTo(c, file);
    const buf = readFileSync(file);
    // locate the data of cipher/big_file-A by walking the headers
    let dataOff = -1;
    let size = 0;
    let paxPath: string | undefined;
    for (let off = 0; off + 512 <= buf.length && dataOff < 0;) {
      const h = buf.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const t = String.fromCharCode(h[156]!);
      const sz = parseInt(h.subarray(124, 135).toString("latin1"), 8);
      const name = h.subarray(0, 100).toString("latin1").replace(/\0.*$/s, "");
      if (t === "x")
        paxPath = /\d+ path=([^\n]*)\n/.exec(buf.subarray(off + 512, off + 512 + sz).toString("latin1"))?.[1];
      else {
        if ((paxPath ?? name).endsWith("big_file-A")) {
          dataOff = off + 512;
          size = sz;
        }
        paxPath = undefined;
      }
      off += 512 + Math.ceil(sz / 512) * 512;
    }
    expect(size).toBe(3 * 1024 * 1024 + 123);
    for (const at of [Math.floor(size / 2), size - 1]) {
      const bad = Buffer.from(buf);
      bad[dataOff + at] = bad[dataOff + at]! ^ 0xff;
      const f = join(root, `bad-${at}.tar`);
      writeFileSync(f, bad);
      const S = join(root, `S-${at}`);
      mkdirSync(S, 0o700);
      expectPkgError(() => T.readPackage({ pkgPath: f, stagingRoot: S }), ["manifest-hash-mismatch"]);
      T.discardStaging(S);
    }
  });

  it("is byte-deterministic for a fixed exportedAt, and never emits link members", () => {
    const root = tmp("v1-det-");
    const c = buildCipherTree(root);
    exportTo(c, join(root, "a.tar"));
    exportTo(c, join(root, "b.tar"));
    const a = readFileSync(join(root, "a.tar"));
    expect(a.equals(readFileSync(join(root, "b.tar")))).toBe(true);
    expect(a.length % 512).toBe(0);
    // walk the headers (skipping data) and collect every typeflag
    const types: string[] = [];
    let paxSize: number | undefined;
    for (let off = 0; off + 512 <= a.length;) {
      const h = a.subarray(off, off + 512);
      if (h.every((x) => x === 0)) break;
      const t = String.fromCharCode(h[156]!);
      types.push(t);
      let size = parseInt(h.subarray(124, 135).toString("latin1"), 8);
      if (t === "x") {
        const m = /(?:^|\n)\d+ size=(\d+)\n/.exec(a.subarray(off + 512, off + 512 + size).toString("latin1"));
        paxSize = m ? Number(m[1]) : undefined;
      } else if (paxSize !== undefined) {
        size = paxSize;
        paxSize = undefined;
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(new Set(types)).toEqual(new Set(["x", "0", "5"]));
  });

  it("refuses FIFOs, sockets-like specials, mode bits beyond 0o777, foreign names and targets, a symlinked root", () => {
    const mk = (): { root: string; c: string } => {
      const root = tmp("v1-wr-");
      return { root, c: buildCipherTree(root) };
    };
    const refuse = (c: string, reasons: string[]): void => {
      const f = join(c, "..", `o-${Math.random()}.tar`);
      expectPkgError(() => exportTo(c, f), reasons);
    };
    let t = mk();
    spawnSync("mkfifo", [join(t.c, "fifo")]);
    refuse(t.c, ["special-file"]);
    t = mk();
    chmodSync(join(t.c, "hl0"), 0o4755);
    refuse(t.c, ["mode-range"]);
    t = mk();
    chmodSync(join(t.c, "emptydir"), 0o1777);
    refuse(t.c, ["mode-range"]);
    t = mk();
    writeFileSync(join(t.c, "plain name"), "");
    refuse(t.c, ["path-bad-char"]);
    t = mk();
    symlinkSync("../escape", join(t.c, "badsym"));
    refuse(t.c, ["symlink-target"]);
    t = mk();
    const ln = join(t.root, "cipher-link");
    symlinkSync(t.c, ln);
    refuse(ln, ["cipher-not-dir"]);
    t = mk();
    expectPkgError(
      () => T.writePackage({ cipherDir: t.c, fd: -1, ...meta, budget: { maxEntries: 3 } }),
      ["budget-entries"],
    );
  });

  it("refuses to write an invalid MANIFEST (self-check) — e.g. a bad origRealWork", () => {
    const root = tmp("v1-self-");
    const c = buildCipherTree(root);
    const fd = openSync(join(root, "x.tar"), "wx", 0o600);
    try {
      expectPkgError(
        () => T.writePackage({ cipherDir: c, fd, ...meta, origRealWork: "/x/state" }),
        ["manifest-orig-real-work"],
      );
    } finally {
      closeSync(fd);
    }
  });

  describe.skipIf(!which("tar"))("GNU tar interop (XC5 subset)", () => {
    it("GNU tar lists our package; members are dirs/files + MANIFEST only", () => {
      const root = tmp("v1-gnu-");
      const c = buildCipherTree(root);
      const file = join(root, "out.tar");
      exportTo(c, file);
      const r = spawnSync("tar", ["-tvf", file], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.some((l) => l.endsWith("pi-secure-vault/MANIFEST.json"))).toBe(true);
      expect(lines.some((l) => l.includes("D5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/deepfile"))).toBe(true);
      for (const l of lines) expect(l[0] === "-" || l[0] === "d", l).toBe(true);
      expect(lines.some((l) => l.includes("sym0"))).toBe(false);
    });
    it("a GNU-tar-made package of the same tree is refused", () => {
      const root = tmp("v1-gnu2-");
      const c = buildCipherTree(root);
      const layout = join(root, "pi-secure-vault");
      mkdirSync(layout);
      spawnSync("cp", ["-a", c, join(layout, "cipher")]);
      for (const fmt of ["posix", "gnu", "ustar"]) {
        const file = join(root, `gnu-${fmt}.tar`);
        const r = spawnSync("tar", [`--format=${fmt}`, "-cf", file, "-C", root, "pi-secure-vault"], {
          encoding: "utf8",
        });
        if (r.status !== 0) continue; // ustar may not represent long names — skip that format
        const S = join(root, `stage-${fmt}`);
        mkdirSync(S, 0o700);
        const err = expectPkgError(
          () => T.readPackage({ pkgPath: file, stagingRoot: S }),
          [
            "member-type",
            "header-magic",
            "pax-key",
            "pax-name",
            "path-prefix",
            "first-member",
            "missing-manifest",
            "header-linkname",
          ],
        );
        expect(err.reason).toBeTruthy();
        T.discardStaging(S);
      }
    });
  });
});
