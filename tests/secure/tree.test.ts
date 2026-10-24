/**
 * V2 tree engine (`src/secure/bin/tree.mjs`) — convert-plan.md §1.3 / §1.5 / §5 / §7.1 tree.test.
 *
 * Covers: walk + every content rule V2 owns (owner/group/type/special bits/unreadable/external
 * hardlink/hardlinked symlink/escaping relative link/non-UTF-8 names), mountinfo (bind, file bind,
 * overlay, octal escapes, prefix siblings), xattr via an injected getfattr, parent dir +
 * filesystem-type whitelist, space estimate, `mv -n -T` rename with the after-the-fact identity
 * judgement (mv exiting 0 without moving ⇒ failure), freeze/restore via `.modes`, baseline compare
 * (ctime), copy + read-back verify, the `sync -f` barrier and the supervised worker protocol.
 *
 * Everything happens in private mktemp dirs; no FUSE (real gocryptfs lives in
 * tests/conformance/secure-convert-xc89.test.ts). Never touches ~/secure or ~/.pi.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const TREE = join(REPO, "src", "secure", "bin", "tree.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const T: any = await import(pathToFileURL(TREE).href);

const UID = process.getuid!();
const GID = process.getgid!();
const tmps: string[] = [];
function mkTmp(tag = "t"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `pi-secure-tree-${tag}-`)));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) {
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

/** A clean tree that passes every rule. */
function cleanTree(base: string, name = "proj"): string {
  const root = join(base, name);
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "rodir"));
  writeFileSync(join(root, "rodir", "x"), "x");
  chmodSync(join(root, "rodir"), 0o555);
  writeFileSync(join(root, "a.txt"), "hello\n");
  writeFileSync(join(root, "ro.txt"), "readonly", { mode: 0o444 });
  chmodSync(join(root, "ro.txt"), 0o444);
  writeFileSync(join(root, "src", "deep", "big.bin"), Buffer.alloc(9 * 1024 * 1024 + 17, 5));
  linkSync(join(root, "a.txt"), join(root, "src", "hard"));
  symlinkSync("../a.txt", join(root, "src", "rel"));
  symlinkSync(join(root, "a.txt"), join(root, "absin"));
  symlinkSync("/usr/share/no-such-thing", join(root, "absout"));
  symlinkSync("nowhere", join(root, "dangling"));
  writeFileSync(join(root, "src", "deep", "f"), "deep");
  utimesSync(join(root, "a.txt"), 1_600_000_000.123, 1_600_000_000.456);
  mkdirSync(join(root, ".git"));
  return root;
}

const fakeGetfattrClean = (dir: string) => script(dir, "getfattr", "exit 0");

describe("walk + content rules", () => {
  it("a clean tree passes; absolute links outside only warn", () => {
    const base = mkTmp("clean");
    const root = cleanTree(base);
    const r = T.checkTree(root, { getfattrBin: fakeGetfattrClean(base), mountinfo: "" });
    expect(r.problems).toEqual([]);
    expect(r.exit).toBe(0);
    expect(r.warnings.map((w: { rel: string }) => w.rel)).toEqual(["absout"]);
    expect(r.summary.files).toBe(6);
    expect(r.summary.hardlinkExtra).toBe(1);
    expect(r.gitEntries).toEqual([{ rel: ".git", type: "dir" }]);
    const rels = r.manifest.entries.map((e: { rel: string }) => e.rel);
    expect(rels[0]).toBe("");
    expect(rels).toContain("src/deep/big.bin");
    // symlinks are never followed: entry type stays symlink, text verbatim
    const rel = r.manifest.entries.find((e: { rel: string }) => e.rel === "src/rel");
    expect(rel.type).toBe("symlink");
    expect(rel.target).toBe("../a.txt");
  });

  it("refuses a root that is a symlink or not absolute", () => {
    const base = mkTmp("rootlink");
    const root = cleanTree(base);
    symlinkSync(root, join(base, "lnk"));
    expect(() => T.walkTree(join(base, "lnk"))).toThrow(/不是目录/);
    expect(() => T.walkTree("relative/path")).toThrow(/绝对路径/);
  });

  it("escaping relative symlink ⇒ escape-link", () => {
    const base = mkTmp("esc");
    const root = cleanTree(base);
    symlinkSync("../../outside", join(root, "src", "esc"));
    symlinkSync("..", join(root, "up"));
    const r = T.checkTreeRules(T.walkTree(root), {});
    expect(
      r.problems
        .filter((p: { code: string }) => p.code === "escape-link")
        .map((p: { rel: string }) => p.rel)
        .sort(),
    ).toEqual(["src/esc", "up"]);
  });

  it("classifyLink table", () => {
    const roots = ["/home/u/proj"];
    expect(T.classifyLink("a/l", "../b", roots)).toBe("rel-internal");
    expect(T.classifyLink("a/l", "../../b", roots)).toBe("escape");
    expect(T.classifyLink("l", "..", roots)).toBe("escape");
    expect(T.classifyLink("l", ".", roots)).toBe("rel-internal");
    expect(T.classifyLink("a/l", "x/../../y", roots)).toBe("rel-internal");
    expect(T.classifyLink("a/l", "x/../../../y", roots)).toBe("escape");
    expect(T.classifyLink("l", "/home/u/proj/x", roots)).toBe("abs-internal");
    expect(T.classifyLink("l", "/home/u/proj", roots)).toBe("abs-internal");
    expect(T.classifyLink("l", "/home/u/proj2/x", roots)).toBe("abs-external");
    expect(T.classifyLink("l", "/home/u/proj/../other", roots)).toBe("abs-external");
    expect(T.classifyLink("l", "", roots)).toBe("invalid");
  });

  it("external hardlink ⇒ ext-hardlink; in-tree group is fine", () => {
    const base = mkTmp("hl");
    const root = cleanTree(base);
    writeFileSync(join(root, "shared"), "s");
    linkSync(join(root, "shared"), join(base, "outside-link"));
    const r = T.checkTreeRules(T.walkTree(root), {});
    expect(r.problems).toEqual([{ code: "ext-hardlink", rel: "shared", detail: "nlink 2" }]);
  });

  it("hardlinked symlink ⇒ refused", () => {
    const base = mkTmp("hls");
    const root = cleanTree(base);
    linkSync(join(root, "absin"), join(root, "absin2")); // link(2) does not follow
    expect(lstatSync(join(root, "absin2")).isSymbolicLink()).toBe(true);
    const codes = T.checkTreeRules(T.walkTree(root), {}).problems.map((p: { code: string }) => p.code);
    expect(codes).toEqual(["hardlinked-symlink", "hardlinked-symlink"]);
  });

  it("FIFO and socket ⇒ type", async () => {
    const base = mkTmp("special");
    const root = cleanTree(base);
    expect(spawnSync("mkfifo", [join(root, "fifo")]).status).toBe(0);
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(join(root, "sock"), r));
    try {
      const r = T.checkTreeRules(T.walkTree(root), {});
      const types = r.problems.filter((p: { code: string }) => p.code === "type");
      expect(types.map((p: { rel: string; detail: string }) => `${p.rel}:${p.detail}`).sort()).toEqual([
        "fifo:fifo",
        "sock:socket",
      ]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("mode 000 file and unreadable dir ⇒ unreadable (walk + rule)", () => {
    const base = mkTmp("unread");
    const root = cleanTree(base);
    writeFileSync(join(root, "zero"), "z");
    chmodSync(join(root, "zero"), 0o000);
    mkdirSync(join(root, "closed"));
    writeFileSync(join(root, "closed", "inner"), "i");
    chmodSync(join(root, "closed"), 0o000);
    const m = T.walkTree(root);
    expect(m.walkProblems.map((p: { code: string; rel: string }) => `${p.code}:${p.rel}`)).toEqual([
      "unreadable:closed",
    ]);
    const r = T.checkTreeRules(m, {});
    const un = r.problems.filter((p: { code: string }) => p.code === "unreadable").map((p: { rel: string }) => p.rel);
    expect(un.sort()).toEqual(["closed", "closed", "zero"]);
    expect(T.problemsExit(r)).toBe(65);
  });

  it("setuid / setgid / sticky ⇒ special-bits", () => {
    const base = mkTmp("bits");
    const root = cleanTree(base);
    writeFileSync(join(root, "suid"), "s");
    chmodSync(join(root, "suid"), 0o4755);
    mkdirSync(join(root, "sgid"));
    chmodSync(join(root, "sgid"), 0o2755);
    mkdirSync(join(root, "sticky"));
    chmodSync(join(root, "sticky"), 0o1755);
    const r = T.checkTreeRules(T.walkTree(root), {});
    expect(r.problems.map((p: { rel: string; detail: string }) => `${p.rel}:${p.detail}`).sort()).toEqual([
      "sgid:02755",
      "sticky:01755",
      "suid:04755",
    ]);
  });

  it("other gid / uid (injected) ⇒ group / owner on every entry", () => {
    const base = mkTmp("own");
    const root = cleanTree(base);
    const m = T.walkTree(root);
    const g = T.checkTreeRules(m, { gid: GID + 4242 });
    expect(g.counts.group).toBe(m.entries.length);
    expect(g.problems.every((p: { code: string }) => p.code === "group")).toBe(true);
    const o = T.checkTreeRules(m, { uid: UID + 4242 });
    expect(o.counts.owner).toBe(m.entries.length);
  });

  it("non-UTF-8 names ⇒ name-encoding, never a lossy path", () => {
    const base = mkTmp("utf");
    const root = cleanTree(base);
    writeFileSync(Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff, 0xfe])]), "x");
    const m = T.walkTree(root);
    expect(m.walkProblems.map((p: { code: string }) => p.code)).toEqual(["name-encoding"]);
    expect(m.entries.some((e: { rel: string }) => e.rel.startsWith("bad-"))).toBe(false);
  });

  it("problem collector caps the list, keeps counts; formatProblems shows ≤20 + tail", () => {
    const P = T.createProblems(5);
    for (let i = 0; i < 30; i++) P.add({ code: "group", rel: `f${i}` });
    const res = P.result();
    expect(res.problems).toHaveLength(5);
    expect(res.total).toBe(30);
    expect(res.truncated).toBe(true);
    const lines = T.formatProblems(res);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toMatch(/另有 25 条/);
    const big = T.createProblems(100);
    for (let i = 0; i < 30; i++) big.add({ code: "owner", rel: `f${i}` });
    expect(T.formatProblems(big.result())).toHaveLength(21);
  });

  it("checkTree keeps exact counts beyond the collector cap", () => {
    const base = mkTmp("many");
    const root = join(base, "r");
    mkdirSync(root);
    for (let i = 0; i < 260; i++) writeFileSync(join(root, `f${i}`), "");
    const r = T.checkTree(root, { gid: GID + 1, getfattrBin: fakeGetfattrClean(base), mountinfo: "" });
    expect(r.counts.group).toBe(261);
    expect(r.total).toBe(261);
    expect(r.truncated).toBe(true);
  });
});

describe("mountinfo", () => {
  const ml = (mp: string, fs: string, src = "/dev/sda1") => `30 25 8:1 / ${mp} rw,relatime shared:1 - ${fs} ${src} rw`;
  const text = [
    ml("/", "ext4"),
    ml("/home/u/proj/sub", "ext4"), // same-fs bind
    ml("/home/u/proj/file.txt", "ext4"), // file bind
    ml("/home/u/proj/ov", "overlay", "overlay"),
    ml("/home/u/proj\\040x/in", "tmpfs", "tmpfs"), // octal escape: "proj x"
    ml("/home/u/proj2", "ext4"), // prefix sibling — NOT inside
    ml("/real/proj/m", "tmpfs", "tmpfs"),
  ].join("\n");

  it("finds bind / file bind / overlay under the root, never a prefix sibling", () => {
    const hits = T.mountsInside(text, ["/home/u/proj"]).map((e: { mountPoint: string }) => e.mountPoint);
    expect(hits).toEqual(["/home/u/proj/sub", "/home/u/proj/file.txt", "/home/u/proj/ov"]);
  });

  it("decodes octal escapes and checks the realpath spelling too", () => {
    expect(T.mountsInside(text, ["/home/u/proj x"]).map((e: { mountPoint: string }) => e.mountPoint)).toEqual([
      "/home/u/proj x/in",
    ]);
    expect(T.mountsInside(text, ["/home/u/elsewhere", "/real/proj"]).length).toBe(1);
  });

  it("the root itself being a mount point is a hit", () => {
    expect(T.mountsInside(ml("/home/u/proj", "ext4"), ["/home/u/proj"])).toHaveLength(1);
    expect(T.mountProblems(ml("/home/u/proj", "ext4"), ["/home/u/proj"])[0].code).toBe("mount");
  });

  it("mountFor = longest prefix, last of equals (stacked)", () => {
    const t = [ml("/", "ext4"), ml("/home", "xfs"), ml("/home", "fuse.x", "x")].join("\n");
    expect(T.mountFor(t, "/home/u").fsType).toBe("fuse.x");
    expect(T.mountFor(t, "/var").fsType).toBe("ext4");
  });

  it("checkTree on a real tree reports a mount found in mountinfo", () => {
    const base = mkTmp("mi");
    const root = cleanTree(base);
    const r = T.checkTree(root, {
      getfattrBin: fakeGetfattrClean(base),
      mountinfo: ml(`${root}/src`, "ext4"),
    });
    expect(r.problems.map((p: { code: string }) => p.code)).toEqual(["mount"]);
    expect(r.exit).toBe(65);
  });
});

describe("xattr (getfattr)", () => {
  it("parses dump output incl. escaped names", () => {
    const out = [
      "# file: /t/a\\040b",
      'user.x="1"',
      "security.capability=0sAQAAAgAgAAAAAAAAAAAAAAAAAAA=",
      "",
      "# file: /t/c\\012d",
      "system.posix_acl_access=0sAgAAAAEABgD/////",
      "",
    ].join("\n");
    expect(T.parseGetfattrDump(out)).toEqual([
      { path: "/t/a b", names: ["user.x", "security.capability"] },
      { path: "/t/c\nd", names: ["system.posix_acl_access"] },
    ]);
    // LC_ALL=C escapes every non-ASCII byte: decoded as bytes, then UTF-8
    expect(T.parseGetfattrDump('# file: /t/\\344\\270\\255\\\\x\nuser.a="1"\n')).toEqual([
      { path: "/t/中\\x", names: ["user.a"] },
    ]);
  });

  it("an attribute anywhere ⇒ xattr problem (batched over exactly the manifest)", () => {
    const base = mkTmp("xa");
    const root = cleanTree(base);
    const bin = script(
      base,
      "getfattr",
      `for a in "$@"; do case "$a" in */ro.txt|*/rel) printf '# file: %s\\nuser.k="v"\\n\\n' "$a";; esac; done; exit 0`,
    );
    const r = T.checkTree(root, { getfattrBin: bin, mountinfo: "" });
    expect(r.problems.map((p: { code: string; rel: string }) => `${p.code}:${p.rel}`).sort()).toEqual([
      "xattr:ro.txt",
      "xattr:src/rel",
    ]);
    expect(r.exit).toBe(65);
  });

  it("getfattr failing ⇒ xattr-uncertain (refused); missing ⇒ prereq 69", () => {
    const base = mkTmp("xa2");
    const root = cleanTree(base);
    const bad = script(base, "getfattr", "echo boom >&2; exit 1");
    const r = T.checkTree(root, { getfattrBin: bad, mountinfo: "" });
    expect(r.problems.map((p: { code: string }) => p.code)).toEqual(["xattr-uncertain"]);
    expect(r.exit).toBe(65);
    const m = T.checkTree(root, { getfattrBin: join(base, "no-such-getfattr"), mountinfo: "" });
    expect(m.problems.map((p: { code: string }) => p.code)).toEqual(["prereq"]);
    expect(m.exit).toBe(69);
  });

  it("many entries ⇒ several batches, one progress tick each", () => {
    const base = mkTmp("xa3");
    const root = join(base, "r");
    mkdirSync(root);
    for (let i = 0; i < 600; i++) writeFileSync(join(root, `${"n".repeat(120)}-${i}`), "");
    const calls = join(base, "calls");
    const bin = script(base, "getfattr", `echo x >> "${calls}"; exit 0`);
    const ticks: number[] = [];
    const r = T.scanXattrs(T.walkTree(root), { bin, onProgress: (p: { units: number }) => ticks.push(p.units) });
    expect(r.kind).toBe("ok");
    const n = readFileSync(calls, "utf8").trim().split("\n").length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(ticks).toHaveLength(n);
    expect(ticks.at(-1)).toBe(601);
  });
});

describe("parent directory + filesystem type", () => {
  const extMi = (p: string, fs = "ext4") => `30 25 8:1 / ${p} rw - ${fs} /dev/x rw`;
  const statfsAs = (type: number) => () => ({ type });

  it("real tmp parent: ok exactly when the filesystem is whitelisted", () => {
    const base = mkTmp("par");
    chmodSync(base, 0o700);
    const magic = statfsSync(base).type;
    const probs = T.checkParentDir(base, {});
    if (Object.values(T.FS_MAGIC).includes(magic)) expect(probs).toEqual([]);
    else expect(probs.map((p: { code: string }) => p.code)).toEqual(["fs-type"]);
  });

  it("each parent rule", () => {
    const base = mkTmp("par2");
    const ok = { statfs: statfsAs(T.FS_MAGIC.ext4), mountinfo: extMi("/") };
    chmodSync(base, 0o770);
    expect(T.checkParentDir(base, ok).map((p: { code: string }) => p.code)).toEqual(["parent-mode"]);
    chmodSync(base, 0o500);
    expect(T.checkParentDir(base, ok).map((p: { code: string }) => p.code)).toEqual(["parent-not-writable"]);
    chmodSync(base, 0o700);
    expect(T.checkParentDir(base, { ...ok, uid: UID + 1 }).map((p: { code: string }) => p.code)).toEqual([
      "parent-owner",
    ]);
    writeFileSync(join(base, "f"), "");
    expect(T.checkParentDir(join(base, "f"), ok).map((p: { code: string }) => p.code)).toEqual(["parent-not-dir"]);
    expect(T.checkParentDir(base, ok)).toEqual([]);
  });

  it("statfs and mountinfo must BOTH be on the whitelist", () => {
    const base = mkTmp("par3");
    chmodSync(base, 0o700);
    const overlay = 0x794c7630;
    const fuse = 0x65735546;
    expect(T.checkParentDir(base, { statfs: statfsAs(overlay), mountinfo: extMi("/") })[0].code).toBe("fs-type");
    expect(T.checkParentDir(base, { statfs: statfsAs(fuse), mountinfo: extMi("/") })[0].code).toBe("fs-type");
    expect(
      T.checkParentDir(base, { statfs: statfsAs(T.FS_MAGIC.ext4), mountinfo: extMi("/", "fuse.sshfs") })[0].code,
    ).toBe("fs-type");
    expect(T.checkParentDir(base, { statfs: statfsAs(T.FS_MAGIC.ext4), mountinfo: "" })[0].code).toBe("fs-type");
    for (const fs of T.PARENT_FS_TYPES)
      expect(T.checkParentDir(base, { statfs: statfsAs(T.FS_MAGIC[fs]), mountinfo: extMi("/", fs) })).toEqual([]);
  });
});

describe("space estimate", () => {
  it("gocryptfs ciphertext size", () => {
    expect(T.gocryptfsCipherSize(0)).toBe(0);
    expect(T.gocryptfsCipherSize(1)).toBe(18 + 1 + 32);
    expect(T.gocryptfsCipherSize(4096)).toBe(18 + 4096 + 32);
    expect(T.gocryptfsCipherSize(4097)).toBe(18 + 4097 + 64);
  });

  it("estimate: files once per inode, dirs ×2, symlinks, long names", () => {
    const e = (rel: string, type: string, size = 0, ino = rel) => ({ rel, type, size, dev: "1", ino });
    const m = {
      root: "/r",
      entries: [
        e("", "dir"),
        e("a", "file", 5000, "10"),
        e("b", "file", 5000, "10"), // hardlink: no cost
        e("l", "symlink"),
        e("z", "file", 0, "11"),
        e("n".repeat(176), "file", 1, "12"),
      ],
    };
    const est = T.estimateVaultUsage(m, { extraBytes: 100, extraInodes: 1 });
    // root dir 8192/2 + a ceil(5000+18+64)→8192/1 + l 4096/1 + z 0/1 + long: name 4096/1 + data 4096/1
    expect(est).toEqual({ bytes: 100 + 8192 + 8192 + 4096 + 0 + 4096 + 4096, inodes: 1 + 2 + 1 + 1 + 1 + 2 });
  });

  it("checkSpace: 1.10 × + 64 MiB, inode check skipped without an inode table", () => {
    const est = { bytes: 100 * 1024 * 1024, inodes: 1000 };
    const need = Math.ceil(est.bytes * 1.1) + 64 * 1024 * 1024;
    expect(T.checkSpace({ availBytes: need, freeInodes: 10_000, totalInodes: 1e6 }, est)).toEqual([]);
    expect(T.checkSpace({ availBytes: need - 1, freeInodes: 10_000, totalInodes: 1e6 }, est)[0].code).toBe("space");
    expect(T.checkSpace({ availBytes: need, freeInodes: 1000, totalInodes: 1e6 }, est)[0].code).toBe("inodes");
    expect(T.checkSpace({ availBytes: need, freeInodes: 0, totalInodes: 0 }, est)).toEqual([]);
    const res = T.createProblems();
    res.addAll(T.checkSpace({ availBytes: 0, freeInodes: 0, totalInodes: 1 }, est));
    expect(T.problemsExit(res.result())).toBe(74);
  });

  it("statfsInfo maps fields", () => {
    expect(T.statfsInfo("/x", () => ({ bavail: 10, bsize: 4096, ffree: 7, files: 9, type: 1 }))).toEqual({
      availBytes: 40960,
      freeInodes: 7,
      totalInodes: 9,
      type: 1,
    });
  });
});

describe("renameNoReplace (mv -n -T + identity judgement)", () => {
  const idOf = (p: string) => {
    const s = lstatSync(p, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino) };
  };
  function pair(tag: string) {
    const parent = mkTmp(tag);
    mkdirSync(join(parent, "src"));
    writeFileSync(join(parent, "src", "f"), "data");
    return { parent, id: idOf(join(parent, "src")) };
  }

  it("absent target: moved, same inode", async () => {
    const { parent, id } = pair("mv1");
    const r = await T.renameNoReplace({ parent, from: "src", to: "bak", expect: id });
    expect(r.ok).toBe(true);
    expect(existsSync(join(parent, "src"))).toBe(false);
    expect(idOf(join(parent, "bak"))).toEqual(id);
  });

  it("target appears between pre-check and mv: mv exits 0, verdict = failure, nothing replaced", async () => {
    const { parent, id } = pair("mv2");
    const bin = mkTmp("mv2bin");
    const racer = script(bin, "mv", `mkdir "$5" && exec mv "$@"`); // args: -n -T -- from to
    const r = await T.renameNoReplace({ parent, from: "src", to: "bak", expect: id, mvBin: racer });
    expect(r.mv.exit).toBe(0);
    expect(r).toMatchObject({ ok: false, state: "unchanged", reason: "target-exists" });
    expect(readdirSync(join(parent, "bak"))).toEqual([]);
    expect(idOf(join(parent, "src"))).toEqual(id);
  });

  it("existing target (empty dir / file) ⇒ refused before mv", async () => {
    const { parent, id } = pair("mv3");
    mkdirSync(join(parent, "bak"));
    expect(await T.renameNoReplace({ parent, from: "src", to: "bak", expect: id })).toMatchObject({
      ok: false,
      state: "unchanged",
      reason: "target-exists",
    });
    expect(idOf(join(parent, "src"))).toEqual(id);
  });

  it("mv exit 0 doing nothing ⇒ not-moved", async () => {
    const { parent, id } = pair("mv4");
    const noop = script(mkTmp("mv4bin"), "mv", "exit 0");
    const r = await T.renameNoReplace({ parent, from: "src", to: "bak", expect: id, mvBin: noop });
    expect(r).toMatchObject({ ok: false, state: "unchanged", reason: "not-moved", mv: { exit: 0 } });
  });

  it("copy+delete behaviour (new inode under the target) ⇒ unknown, never ok", async () => {
    const { parent, id } = pair("mv5");
    const copier = script(mkTmp("mv5bin"), "mv", `cp -a -- "$4" "$5" && rm -rf -- "$4"`);
    const r = await T.renameNoReplace({ parent, from: "src", to: "bak", expect: id, mvBin: copier });
    expect(r).toMatchObject({ ok: false, state: "unknown", reason: "identity-mismatch" });
  });

  it("wrong expected identity / bad names ⇒ refused without running mv", async () => {
    const { parent } = pair("mv6");
    const marker = join(parent, "ran");
    const spy = script(mkTmp("mv6bin"), "mv", `touch "${marker}"`);
    expect(
      await T.renameNoReplace({ parent, from: "src", to: "bak", expect: { dev: "1", ino: "2" }, mvBin: spy }),
    ).toMatchObject({ ok: false, reason: "source-identity" });
    for (const bad of [
      { from: "a/b", to: "x" },
      { from: "src", to: "../x" },
      { from: "src", to: "src" },
      { from: "..", to: "x" },
    ])
      expect((await T.renameNoReplace({ parent, ...bad, expect: { dev: "1", ino: "1" }, mvBin: spy })).reason).toBe(
        "bad-args",
      );
    expect((await T.renameNoReplace({ parent, from: "src", to: "x", mvBin: spy })).reason).toBe("bad-args");
    expect(existsSync(marker)).toBe(false);
  });

  it("a hung mv is killed at the deadline and still judged by lstat", async () => {
    const { parent, id } = pair("mv7");
    const slow = script(mkTmp("mv7bin"), "mv", "sleep 30");
    const t0 = Date.now();
    const r = await T.renameNoReplace({
      parent,
      from: "src",
      to: "bak",
      expect: id,
      mvBin: slow,
      deadline: Date.now() + 300,
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: false, state: "unchanged", reason: "not-moved", mv: { kind: "timeout" } });
  });

  it("backupName format", () => {
    const n = T.backupName("proj", new Date(2026, 9, 24, 6, 5, 9), () => 0xab);
    expect(n).toBe("proj.pi-secure-backup-20261024-060509-00ab");
  });
});

describe("freeze (chmod a-w) / restore via .modes", () => {
  function modesOf(root: string) {
    return Object.fromEntries(
      T.walkTree(root).entries.map((e: { rel: string; mode: number; type: string }) => [
        e.rel,
        e.type === "symlink" ? "l" : e.mode,
      ]),
    );
  }

  it("records modes FIRST (0600 NDJSON), removes every write bit, restore is exact — also after a rename", async () => {
    const base = mkTmp("frz");
    const root = cleanTree(base);
    mkdirSync(join(root, "sg"));
    chmodSync(join(root, "sg"), 0o2750);
    writeFileSync(join(root, "wo"), "w");
    chmodSync(join(root, "wo"), 0o200); // write-only: open(O_RDONLY) fails ⇒ path fallback
    writeFileSync(join(root, "zero"), "");
    chmodSync(join(root, "zero"), 0o000);
    const before = modesOf(root);
    const modesFile = join(base, "x.modes");
    const r = T.freezeTree(root, modesFile);
    expect(r.entries).toBe(T.walkTree(root).entries.length);
    expect(lstatSync(modesFile).mode & 0o7777).toBe(0o600);
    const lines = readFileSync(modesFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "pi-secure-tree-modes", v: 1, root });
    expect(lines).toHaveLength(r.entries + 1);
    for (const e of T.walkTree(root).entries) if (e.type !== "symlink") expect(e.mode & 0o222, e.rel).toBe(0);
    expect(modesOf(root)["sg"]).toBe(0o2550);
    expect(() => writeFileSync(join(root, "new"), "x")).toThrow(/EACCES/);
    // rename the frozen tree (identity is by inode) then restore
    const id = lstatSync(root, { bigint: true });
    const mv = await T.renameNoReplace({
      parent: base,
      from: "proj",
      to: "bak",
      expect: { dev: String(id.dev), ino: String(id.ino) },
    });
    expect(mv.ok).toBe(true);
    const rr = T.restoreModes(join(base, "bak"), modesFile);
    expect(rr.ok).toBe(true);
    expect(rr.skipped).toEqual([]);
    expect(modesOf(join(base, "bak"))).toEqual(before);
  });

  it("an existing modes file ⇒ freeze fails before touching any mode", () => {
    const base = mkTmp("frz2");
    const root = cleanTree(base);
    const before = modesOf(root);
    const modesFile = join(base, "x.modes");
    writeFileSync(modesFile, "old");
    expect(() => T.freezeTree(root, modesFile)).toThrow(/EEXIST/);
    expect(modesOf(root)).toEqual(before);
    expect(readFileSync(modesFile, "utf8")).toBe("old");
  });

  it("restore skips (and reports) an entry that is no longer the recorded inode", () => {
    const base = mkTmp("frz3");
    const root = cleanTree(base);
    const modesFile = join(base, "x.modes");
    T.freezeTree(root, modesFile);
    chmodSync(root, 0o755);
    chmodSync(join(root, "a.txt"), 0o644);
    unlinkSync(join(root, "a.txt"));
    writeFileSync(join(root, "a.txt"), "impostor", { mode: 0o600 });
    const rr = T.restoreModes(root, modesFile);
    expect(rr.ok).toBe(false);
    expect(rr.skipped).toEqual([{ rel: "a.txt", reason: "identity" }]);
    expect(lstatSync(join(root, "a.txt")).mode & 0o777).toBe(0o600); // impostor untouched
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("impostor");
    expect(lstatSync(join(root, "src")).mode & 0o222).not.toBe(0); // the rest was restored
  });

  it("a truncated modes file is refused", () => {
    const base = mkTmp("frz4");
    const root = cleanTree(base);
    const modesFile = join(base, "x.modes");
    T.freezeTree(root, modesFile);
    const text = readFileSync(modesFile, "utf8").split("\n");
    const cut = join(base, "cut.modes");
    writeFileSync(cut, `${text.slice(0, 3).join("\n")}\n`, { mode: 0o600 });
    expect(() => T.restoreModes(root, cut)).toThrow(/记录数不符/);
    symlinkSync(modesFile, join(base, "link.modes"));
    expect(() => T.restoreModes(root, join(base, "link.modes"))).toThrow(/ELOOP/);
  });
});

describe("baseline", () => {
  it("unchanged ⇒ no diffs; chmod back after a write is caught by ctime", () => {
    const base = mkTmp("bl");
    const root = cleanTree(base);
    T.freezeTree(root, join(base, "m"));
    const a = T.takeBaseline(root);
    expect(T.compareBaselines(a, T.takeBaseline(root))).toEqual([]);
    // write without changing size/mtime visibly: chmod u+w, write same length, restore mtime, chmod back
    const f = join(root, "a.txt");
    const st = lstatSync(f);
    // ctime comes from the kernel's coarse clock: step past one tick so the change is observable
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    chmodSync(f, 0o644);
    writeFileSync(f, "HELLO\n");
    utimesSync(f, st.atime, st.mtime);
    chmodSync(f, st.mode & 0o7777);
    const d = T.compareBaselines(a, T.takeBaseline(root));
    // a.txt and its in-tree hardlink src/hard; size/mode/ino identical — only the timestamps tell
    expect(d.map((x: { rel: string }) => x.rel).sort()).toEqual(["a.txt", "src/hard"]);
    for (const x of d) {
      expect(x.kind).toBe("changed");
      expect(x.fields).toContain("ctimeNs");
      expect(x.fields).not.toContain("size");
    }
  });

  it("added / removed entries", () => {
    const base = mkTmp("bl2");
    const root = cleanTree(base);
    const a = T.takeBaseline(root);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); // past one coarse-clock tick
    writeFileSync(join(root, "new"), "n");
    rmSync(join(root, "dangling"));
    const kinds = T.compareBaselines(a, T.takeBaseline(root)).map(
      (d: { rel: string; kind: string }) => `${d.kind}:${d.rel}`,
    );
    expect(kinds).toContain("added:new");
    expect(kinds).toContain("removed:dangling");
    expect(kinds).toContain("changed:"); // root dir mtime/ctime
  });

  it("manifest file round-trip (exclusive 0600)", () => {
    const base = mkTmp("bl3");
    const root = cleanTree(base);
    const m = T.takeBaseline(root);
    const f = join(base, "base.ndjson");
    T.writeManifestFile(f, m);
    expect(lstatSync(f).mode & 0o777).toBe(0o600);
    expect(T.readManifestFile(f)).toEqual(m);
    expect(() => T.writeManifestFile(f, m)).toThrow(/EEXIST/);
  });
});

describe("copy + read-back verify", () => {
  function prepared(tag: string) {
    const base = mkTmp(tag);
    const root = cleanTree(base);
    const modesFile = join(base, "m.modes");
    T.freezeTree(root, modesFile);
    const baseline = T.takeBaseline(root);
    const modes = T.readModesFile(modesFile).records;
    const dst = join(base, "dst");
    mkdirSync(dst);
    return { base, root, baseline, modes, dst };
  }

  it("copies a frozen tree with ORIGINAL modes, times, links, groups; verify passes", () => {
    const { root, baseline, modes, dst } = prepared("cp1");
    const ticks: number[] = [];
    const r = T.copyTree({
      src: root,
      dst,
      baseline,
      modes,
      onProgress: (p: { bytes: number }) => ticks.push(p.bytes),
    });
    expect(r).toMatchObject({ files: 5, links: 1, symlinks: 4 });
    expect(ticks.length).toBeGreaterThan(1);
    const v = T.verifyCopy({ dst, baseline, modes, hashes: r.hashes });
    expect(v.diffs).toEqual([]);
    expect(v.ok).toBe(true);
    const orig = new Map(modes.map((m: { rel: string; mode: number }) => [m.rel, m.mode]));
    for (const rel of ["a.txt", "ro.txt", "rodir", "src", ""])
      expect(lstatSync(join(dst, rel)).mode & 0o7777, rel).toBe(orig.get(rel));
    expect(lstatSync(join(dst, "src", "hard")).ino).toBe(lstatSync(join(dst, "a.txt")).ino);
    expect(Math.floor(lstatSync(join(dst, "a.txt")).mtimeMs)).toBe(1_600_000_000_456);
    expect(lstatSync(join(dst, "absin")).isSymbolicLink()).toBe(true);
    expect(
      readFileSync(join(dst, "src", "deep", "big.bin")).equals(readFileSync(join(root, "src", "deep", "big.bin"))),
    ).toBe(true);
    // the source is untouched
    expect(T.compareBaselines(baseline, T.takeBaseline(root))).toEqual([]);
  });

  it("refuses a non-empty destination and a source changed after the baseline", () => {
    const { root, baseline, modes, dst, base } = prepared("cp2");
    writeFileSync(join(dst, "x"), "");
    expect(() => T.copyTree({ src: root, dst, baseline, modes })).toThrow(/不是空的/);
    rmSync(join(dst, "x"));
    const f = join(root, "src", "deep", "f");
    chmodSync(f, 0o644);
    appendFileSync(f, "!");
    chmodSync(f, 0o444);
    let err: { code?: string } | undefined;
    try {
      T.copyTree({ src: root, dst, baseline, modes });
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe("source-changed");
    expect(base).toBeTruthy();
  });

  it("refuses a special file in the baseline", () => {
    const base = mkTmp("cp3");
    const root = cleanTree(base);
    expect(spawnSync("mkfifo", [join(root, "fifo")]).status).toBe(0);
    const baseline = T.takeBaseline(root);
    const dst = join(base, "dst");
    mkdirSync(dst);
    expect(() => T.copyTree({ src: root, dst, baseline })).toThrow(/不支持的条目类型 fifo/);
  });

  it("verify catches content, mode, mtime, size, link text, extra, missing and broken groups", () => {
    const { root, baseline, modes, dst } = prepared("cp4");
    const r = T.copyTree({ src: root, dst, baseline, modes });
    writeFileSync(join(dst, "src", "deep", "f"), "DEEP"); // same size, other bytes (also mtime)
    chmodSync(join(dst, "ro.txt"), 0o644);
    writeFileSync(join(dst, "extra"), "");
    rmSync(join(dst, "dangling"));
    symlinkSync("elsewhere", join(dst, "dangling2"));
    rmSync(join(dst, "src", "rel"));
    symlinkSync("../A.txt", join(dst, "src", "rel"));
    rmSync(join(dst, "src", "hard"));
    writeFileSync(join(dst, "src", "hard"), "hello\n");
    const v = T.verifyCopy({ dst, baseline, modes, hashes: r.hashes });
    expect(v.ok).toBe(false);
    const got = v.diffs.map((d: { rel: string; what: string }) => `${d.what}:${d.rel}`);
    for (const want of [
      "sha256:src/deep/f",
      "mtime:src/deep/f",
      "mode:ro.txt",
      "extra:extra",
      "extra:dangling2",
      "missing:dangling",
      "link-text:src/rel",
      "hardlink-group:src/hard",
      "nlink:a.txt",
    ])
      expect(got).toContain(want);
  });

  it("hash files round-trip", () => {
    const base = mkTmp("cp5");
    const f = join(base, "h");
    const h = new Map([
      ["a", "00"],
      ["b/c", "ff"],
    ]);
    T.writeHashesFile(f, h);
    expect(T.readHashesFile(f)).toEqual(h);
  });
});

describe("sync barrier", () => {
  it("real sync -f + dir fsync ⇒ ok", () => {
    const base = mkTmp("sy");
    const r = T.syncBarrier({ syncfs: [T.dirTarget(base)], fsyncDirs: [T.dirTarget(base)] });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: { what: string }) => s.what)).toEqual(["syncfs", "fsync-dir"]);
  });

  it("failing sync / missing dir / hung sync ⇒ not ok", () => {
    const base = mkTmp("sy2");
    const bad = script(base, "sync", "exit 1");
    const tb = T.dirTarget(base);
    expect(T.syncBarrier({ syncfs: [tb], fsyncDirs: [tb], syncBin: bad }).ok).toBe(false);
    expect(T.syncBarrier({ syncfs: [tb], fsyncDirs: [{ ...tb, path: join(base, "nope") }] }).ok).toBe(false);
    const hung = script(base, "hung", "sleep 30");
    const t0 = Date.now();
    const r = T.syncBarrier({ syncfs: [tb], fsyncDirs: [tb], syncBin: hung, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("prerequisite probe", () => {
  it("real mv/sync + a getfattr on PATH ⇒ ok; missing getfattr / broken mv ⇒ listed", async () => {
    const base = mkTmp("pre");
    const bin = mkTmp("prebin");
    fakeGetfattrClean(bin);
    const envPath = `${bin}:${process.env.PATH}`;
    expect(await T.probeTreeTools({ scratchParent: base, envPath })).toEqual({ ok: true, missing: [], leftover: [] });
    const r = await T.probeTreeTools({
      scratchParent: base,
      envPath: process.env.PATH,
      getfattrBin: "no-such-getfattr-x",
    });
    expect(r.missing).toContain("getfattr");
    const noop = script(bin, "mvnoop", "exit 0");
    expect((await T.probeTreeTools({ scratchParent: base, envPath, mvBin: noop })).missing).toContain("mv -n -T");
    expect(readdirSync(base)).toEqual([]); // probe dir removed
  });
});

describe("worker protocol", () => {
  it("real worker ops through superviseWorker: check, freeze, baseline, copy, verify, compare, restore, sync", async () => {
    const base = mkTmp("wk");
    const root = cleanTree(base);
    const getfattr = fakeGetfattrClean(base);
    const progress: number[] = [];
    const chk = await T.superviseWorker({
      op: "check",
      spec: { root, getfattrBin: getfattr, manifestOut: join(base, "early.ndjson") },
      onProgress: (p: { units: number }) => progress.push(p.units),
    });
    expect(chk.kind).toBe("result");
    expect(chk.result.exit).toBe(0);
    expect(chk.result.manifest).toBeUndefined();
    expect(T.readManifestFile(join(base, "early.ndjson")).entries.length).toBe(chk.result.summary.entries);
    expect(progress.length).toBeGreaterThan(0);

    const fr = await T.superviseWorker({ op: "freeze", spec: { root, modesFile: join(base, "m.modes") } });
    expect(fr.kind).toBe("result");
    const bl = await T.superviseWorker({ op: "baseline", spec: { root, manifestOut: join(base, "base.ndjson") } });
    expect(bl.kind).toBe("result");
    const dst = join(base, "dst");
    mkdirSync(dst);
    const cp = await T.superviseWorker({
      op: "copy",
      spec: {
        src: root,
        dst,
        baselineFile: join(base, "base.ndjson"),
        modesFile: join(base, "m.modes"),
        hashesOut: join(base, "h"),
      },
    });
    expect(cp.kind).toBe("result");
    expect(cp.result).toMatchObject({ files: 5, hashed: 5 });
    const vf = await T.superviseWorker({
      op: "verify",
      spec: {
        dst,
        baselineFile: join(base, "base.ndjson"),
        modesFile: join(base, "m.modes"),
        hashesFile: join(base, "h"),
      },
    });
    expect(vf.kind).toBe("result");
    expect(vf.result.ok).toBe(true);
    const cmp = await T.superviseWorker({
      op: "compare-baseline",
      spec: { root, baselineFile: join(base, "base.ndjson") },
    });
    expect(cmp.result).toEqual({ same: true, diffs: [] });
    const sy = await T.superviseWorker({
      op: "sync",
      spec: { syncfs: [T.dirTarget(base)], fsyncDirs: [T.dirTarget(base)] },
    });
    expect(sy.kind).toBe("result");
    const rs = await T.superviseWorker({ op: "restore-modes", spec: { root, modesFile: join(base, "m.modes") } });
    expect(rs.result.ok).toBe(true);
  });

  it("op failures come back as typed errors", async () => {
    const base = mkTmp("wk2");
    const e1 = await T.superviseWorker({ op: "check", spec: { root: join(base, "missing") } });
    expect(e1).toMatchObject({ kind: "error", code: "ENOENT" });
    const e2 = await T.superviseWorker({ op: "check", spec: { root: "rel" } });
    expect(e2).toMatchObject({ kind: "error", code: "bad-spec" });
    const e3 = await T.superviseWorker({
      op: "sync",
      spec: { syncfs: [T.dirTarget(base)], fsyncDirs: [T.dirTarget(base)], syncBin: script(base, "s", "exit 3") },
    });
    expect(e3).toMatchObject({ kind: "error", code: "barrier", exit: 74 });
    const dst = join(base, "d");
    mkdirSync(dst);
    writeFileSync(join(dst, "x"), "");
    const root = cleanTree(base);
    T.writeManifestFile(join(base, "b"), T.takeBaseline(root));
    const e4 = await T.superviseWorker({
      op: "copy",
      spec: { src: root, dst, baselineFile: join(base, "b"), hashesOut: join(base, "h") },
    });
    expect(e4).toMatchObject({ kind: "error", code: "dst-not-empty" });
    await expect(T.runTreeOp("nope", {})).rejects.toMatchObject({ code: "bad-op" });
    // unknown op through the real entry: refused before reading the spec
    const e5 = await T.superviseWorker({ op: "nope", spec: {} });
    expect(e5).toMatchObject({ kind: "crashed", code: 2 });
  });

  it("workerMain: bad spec ⇒ one error line, exit 1", async () => {
    const lines: string[] = [];
    const code = await T.workerMain("check", {
      stdin: Readable.from(["not json"]),
      write: (s: string) => lines.push(s),
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ t: "error", code: "bad-spec" });
  });

  const nodeArgv = (src: string) => [process.execPath, "-e", src];
  function tracked() {
    const kids: ChildProcess[] = [];
    const spawnImpl = (cmd: string, args: string[], opts: object) => {
      const c = spawn(cmd, args, opts);
      kids.push(c);
      return c;
    };
    return { kids, spawnImpl };
  }
  const groupGone = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it("no progress for stallMs ⇒ stalled; TERM-ignoring group is KILLed and abandoned", async () => {
    const { kids, spawnImpl } = tracked();
    const t0 = Date.now();
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(
        "process.on('SIGTERM',()=>{}); require('child_process').spawn('sleep',['30'],{stdio:'ignore'}); setInterval(()=>{},1000)",
      ),
      stallMs: 300,
      killGraceMs: 200,
      abandonMs: 200,
      spawnImpl,
    });
    expect(r.kind).toBe("stalled");
    expect(Date.now() - t0).toBeLessThan(5_000);
    await new Promise((res) => setTimeout(res, 200));
    expect(groupGone(kids[0]!.pid!)).toBe(true); // the grandchild `sleep` went with the group
  });

  it("progress lines reset the watchdog", async () => {
    const src =
      "let n=0;const t=setInterval(()=>{n++;console.log(JSON.stringify({t:'progress',op:'x',units:n}));" +
      "if(n===8){clearInterval(t);console.log(JSON.stringify({t:'result',op:'x',ok:true,result:{n}}));}},100)";
    const seen: number[] = [];
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(src),
      stallMs: 400,
      onProgress: (p: { units: number }) => seen.push(p.units),
    });
    expect(r).toMatchObject({ kind: "result", result: { n: 8 } });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("crash without a result ⇒ crashed; result then hang ⇒ result kept, process reaped", async () => {
    const c = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("console.error('bye'); process.exit(3)"),
      stallMs: 2_000,
    });
    expect(c).toMatchObject({ kind: "crashed", code: 3 });
    expect(c.stderr).toMatch(/bye/);
    const { kids, spawnImpl } = tracked();
    const h = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("console.log(JSON.stringify({t:'result',op:'x',ok:true,result:{v:1}})); setInterval(()=>{},1000)"),
      stallMs: 300,
      spawnImpl,
    });
    expect(h).toMatchObject({ kind: "result", result: { v: 1 } });
    await new Promise((res) => setTimeout(res, 200));
    expect(groupGone(kids[0]!.pid!)).toBe(true);
  });

  it("spawn failure ⇒ spawn-error", async () => {
    const r = await T.superviseWorker({ op: "x", argv: ["/nonexistent/node-binary"], stallMs: 1_000 });
    expect(r.kind).toBe("spawn-error");
  });
});

/**
 * V2 security review (2026-10-24) regressions — deterministic interleavings through the test-only
 * `_hooks` seams. Threat model: targeted same-uid attackers are out of scope, but the invariants
 * I1–I5 must hold under ANY race; each test asserts the object OUTSIDE the tree stays untouched.
 */
describe("security review regressions (I1–I5)", () => {
  const snap = (p: string) => {
    const st = lstatSync(p);
    return { ino: st.ino, mode: st.mode, mtimeMs: st.mtimeMs, entries: st.isDirectory() ? readdirSync(p).sort() : [] };
  };

  it("#1 probe: temp dir swapped for a user dir with content ⇒ nothing of it deleted, leftovers reported", async () => {
    const base = mkTmp("r1");
    const bin = mkTmp("r1bin");
    fakeGetfattrClean(bin);
    let swapped = "";
    const r = await T.probeTreeTools({
      scratchParent: base,
      envPath: `${bin}:${process.env.PATH}`,
      _hooks: {
        afterCreate: (tmpPath: string) => {
          swapped = tmpPath;
          renameSync(tmpPath, `${tmpPath}.moved`);
          mkdirSync(tmpPath);
          writeFileSync(join(tmpPath, "canary"), "user data");
        },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.leftover).toContain(swapped);
    expect(readFileSync(join(swapped, "canary"), "utf8")).toBe("user data");
    // the temp dir is no longer at its name ⇒ cleanup touches nothing at all and reports everything
    // (renameNoReplace refused too: the parent path no longer resolves to the pinned temp dir)
    expect(readdirSync(`${swapped}.moved`).sort()).toEqual(["a", "b"]);
    expect(r.leftover).toEqual(expect.arrayContaining([join(swapped, "a"), join(swapped, "b")]));
  });

  it("#2 copy: a just-created destination dir swapped for a symlink ⇒ fails, outside dir untouched", () => {
    const base = mkTmp("r2");
    const root = cleanTree(base);
    const baseline = T.takeBaseline(root);
    const dst = join(base, "dst");
    mkdirSync(dst);
    const E = join(base, "E");
    mkdirSync(E, 0o755);
    const before = snap(E);
    expect(() =>
      T.copyTree({
        src: root,
        dst,
        baseline,
        _hooks: {
          afterMkdir: (rel: string) => {
            if (rel !== "src") return;
            renameSync(join(dst, "src"), join(dst, "src.moved"));
            symlinkSync(E, join(dst, "src"));
          },
        },
      }),
    ).toThrow();
    expect(snap(E)).toEqual(before);
  });

  it("#2 copy: swapped AFTER the destination dir fd is held ⇒ writes stay in our dir object, outside untouched, verify fails", () => {
    const base = mkTmp("r2b");
    const root = cleanTree(base);
    const baseline = T.takeBaseline(root);
    const dst = join(base, "dst");
    mkdirSync(dst);
    const E = join(base, "E");
    mkdirSync(E, 0o755);
    const before = snap(E);
    let r: { hashes: Map<string, string> } | undefined;
    try {
      r = T.copyTree({
        src: root,
        dst,
        baseline,
        _hooks: {
          afterOpenDstDir: (rel: string) => {
            if (rel !== "src") return;
            renameSync(join(dst, "src"), join(dst, "src.moved"));
            symlinkSync(E, join(dst, "src"));
          },
        },
      });
    } catch {
      /* failing is fine too — what matters is E */
    }
    expect(snap(E)).toEqual(before); // zero creations, zero chmod, zero utimes outside
    expect(existsSync(join(dst, "src.moved", "deep", "big.bin"))).toBe(true);
    if (r) expect(T.verifyCopy({ dst, baseline, hashes: r.hashes }).ok).toBe(false);
  });

  it("#3 walk: a directory swapped for a symlink mid-walk never pulls outside objects into the manifest", () => {
    const base = mkTmp("r3");
    const root = cleanTree(base);
    const E = join(base, "E");
    mkdirSync(E);
    writeFileSync(join(E, "evil"), "outside");
    const evilIno = String(lstatSync(join(E, "evil"), { bigint: true }).ino);
    const m = T.walkTree(root, {
      _hooks: {
        afterList: (rel: string) => {
          if (rel !== "src") return;
          renameSync(join(root, "src"), join(root, "src.real"));
          symlinkSync(E, join(root, "src"));
        },
      },
    });
    expect(m.entries.some((e: { ino: string }) => e.ino === evilIno)).toBe(false);
    expect(m.entries.map((e: { rel: string }) => e.rel)).toContain("src/deep/big.bin"); // read from the real dir object
  });

  it("#3/#4 freeze: an entry replaced by a symlink before the chmod pass ⇒ stops; the outside file keeps its mode", () => {
    const base = mkTmp("r3b");
    const root = cleanTree(base);
    const F = join(base, "outside.txt");
    writeFileSync(F, "o", { mode: 0o644 });
    chmodSync(F, 0o644);
    const modesFile = join(base, "m.modes");
    expect(() =>
      T.freezeTree(root, modesFile, {
        _hooks: {
          beforeChmod: () => {
            unlinkSync(join(root, "a.txt"));
            symlinkSync(F, join(root, "a.txt"));
          },
        },
      }),
    ).toThrow(/条目已被替换|identity/);
    expect(lstatSync(F).mode & 0o7777).toBe(0o644);
    const rr = T.restoreModes(root, modesFile);
    expect(rr.skipped.map((x: { rel: string }) => x.rel)).toEqual(["a.txt"]);
    expect(lstatSync(F).mode & 0o7777).toBe(0o644);
  });

  it("#3 freeze refuses (nothing changed) when another mount or walk problem is inside", () => {
    const base = mkTmp("r3c");
    const root = cleanTree(base);
    const before = T.takeBaseline(root);
    const mi = `30 25 8:1 / ${root}/src rw - ext4 /dev/x rw`;
    expect(() => T.freezeTree(root, join(base, "m1"), { mountinfo: mi })).toThrow(/挂载点/);
    expect(existsSync(join(base, "m1"))).toBe(false);
    chmodSync(join(root, "empty"), 0o000);
    expect(() => T.freezeTree(root, join(base, "m2"), { mountinfo: "" })).toThrow(/未做任何修改/);
    chmodSync(join(root, "empty"), 0o775);
    expect(existsSync(join(base, "m2"))).toBe(false);
    const after = T.takeBaseline(root);
    expect(
      after.entries
        .filter((e: { rel: string }) => e.rel !== "" && e.rel !== "empty")
        .map((e: { mode: number }) => e.mode),
    ).toEqual(
      before.entries
        .filter((e: { rel: string }) => e.rel !== "" && e.rel !== "empty")
        .map((e: { mode: number }) => e.mode),
    );
  });

  it("#5 rename: parent ABA during mv ⇒ the move happens in the pinned parent, the decoy is untouched", async () => {
    const base = mkTmp("r5");
    const P = join(base, "P");
    mkdirSync(join(P, "src"), { recursive: true });
    const Q = join(base, "Q");
    mkdirSync(join(Q, "src"), { recursive: true });
    writeFileSync(join(Q, "src", "marker"), "decoy");
    const s0 = lstatSync(join(P, "src"), { bigint: true });
    const expect0 = { dev: String(s0.dev), ino: String(s0.ino) };
    const r = await T.renameNoReplace({
      parent: P,
      from: "src",
      to: "bak",
      expect: expect0,
      _hooks: {
        beforeMv: () => {
          renameSync(P, `${P}.orig`);
          symlinkSync(Q, P);
        },
        afterMv: () => {
          unlinkSync(P);
          renameSync(`${P}.orig`, P);
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(readdirSync(Q)).toEqual(["src"]);
    expect(readFileSync(join(Q, "src", "marker"), "utf8")).toBe("decoy");
    expect(readdirSync(P)).toEqual(["bak"]);
  });

  it("#5 rename: parent path left swapped ⇒ unknown (never unchanged), decoy untouched", async () => {
    const base = mkTmp("r5b");
    const P = join(base, "P");
    mkdirSync(join(P, "src"), { recursive: true });
    const Q = join(base, "Q");
    mkdirSync(join(Q, "src"), { recursive: true });
    const s0 = lstatSync(join(P, "src"), { bigint: true });
    const r = await T.renameNoReplace({
      parent: P,
      from: "src",
      to: "bak",
      expect: { dev: String(s0.dev), ino: String(s0.ino) },
      _hooks: {
        beforeMv: () => {
          renameSync(P, `${P}.orig`);
          symlinkSync(Q, P);
        },
      },
    });
    expect(r).toMatchObject({ ok: false, state: "unknown", reason: "parent-path-changed" });
    expect(readdirSync(Q)).toEqual(["src"]);
    expect(readdirSync(`${P}.orig`)).toEqual(["bak"]);
  });

  function copied(tag: string) {
    const base = mkTmp(tag);
    const root = cleanTree(base);
    const baseline = T.takeBaseline(root);
    const dst = join(base, "dst");
    mkdirSync(dst);
    const r = T.copyTree({ src: root, dst, baseline });
    return { base, root, baseline, dst, hashes: r.hashes };
  }

  it("#6 verify: an already-verified file swapped for a wrong one later ⇒ fails (final re-check)", () => {
    const { baseline, dst, hashes } = copied("r6");
    const f = join(dst, "ro.txt");
    const st = lstatSync(f);
    const v = T.verifyCopy({
      dst,
      baseline,
      hashes,
      _hooks: {
        afterHash: (rel: string) => {
          if (rel !== "src/deep/f") return; // the last file: ro.txt was verified long before
          const tmp = join(dst, ".x");
          writeFileSync(tmp, "WRONGONL", { mode: st.mode & 0o7777 });
          utimesSync(tmp, st.atime, st.mtime);
          renameSync(tmp, f);
        },
      },
    });
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d: { rel: string; what: string }) => `${d.what}:${d.rel}`)).toContain(
      "changed-after-check:ro.txt",
    );
  });

  it("#6 verify: the hashed file replaced right after reading ⇒ fails", () => {
    const { baseline, dst, hashes } = copied("r6c");
    const f = join(dst, "src", "deep", "f");
    const v = T.verifyCopy({
      dst,
      baseline,
      hashes,
      _hooks: {
        afterHash: (rel: string) => {
          if (rel !== "src/deep/f") return;
          chmodSync(join(dst, "src", "deep"), 0o775);
          writeFileSync(join(dst, "src", "deep", ".x"), "DEEP");
          renameSync(join(dst, "src", "deep", ".x"), f);
        },
      },
    });
    expect(v.ok).toBe(false);
  });

  it("#6 verify: the file changes while/after being read ⇒ unstable", () => {
    const { baseline, dst, hashes } = copied("r6b");
    const v = T.verifyCopy({
      dst,
      baseline,
      hashes,
      _hooks: {
        afterHash: (rel: string) => {
          if (rel !== "src/deep/f") return;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
          appendFileSync(join(dst, "src", "deep", "f"), "!");
        },
      },
    });
    expect(v.ok).toBe(false);
    expect(v.diffs.map((d: { rel: string; what: string }) => `${d.what}:${d.rel}`)).toContain("unstable:src/deep/f");
  });

  it("#7 check: an inode swapped during the xattr scan or a new mount ⇒ refused, never re-baselined", () => {
    const base = mkTmp("r7");
    const root = cleanTree(base);
    const getfattr = fakeGetfattrClean(base);
    const r = T.checkTree(root, {
      getfattrBin: getfattr,
      mountinfo: "",
      _hooks: {
        beforeGetfattr: () => {
          writeFileSync(join(root, ".swap"), "hello\n");
          renameSync(join(root, ".swap"), join(root, "ro.txt"));
        },
      },
    });
    expect(r.exit).toBe(65);
    expect(
      r.problems.some((p: { code: string; rel: string }) => p.code === "changed-during-check" && p.rel === "ro.txt"),
    ).toBe(true);
    const r2 = T.checkTree(root, {
      getfattrBin: getfattr,
      mountinfo: "",
      mountinfoAfter: `30 25 8:1 / ${root}/src rw - ext4 /dev/x rw`,
    });
    expect(r2.problems.map((p: { code: string }) => p.code)).toEqual(["mount"]);
    // a getfattr run that changes an attribute (ctime moves) is caught by the second walk
    const touching = script(base, "getfattr-touch", `chmod 600 "${root}/a.txt"; exit 0`);
    const r3 = T.checkTree(root, { getfattrBin: touching, mountinfo: "" });
    expect(r3.problems.map((p: { code: string; rel: string }) => `${p.code}:${p.rel}`)).toContain(
      "changed-during-check:a.txt",
    );
  });

  it("#8 barrier: wrong identity / swapped path / empty or id-less spec ⇒ fails", () => {
    const base = mkTmp("r8");
    const d = join(base, "cipher");
    mkdirSync(d);
    const t = T.dirTarget(d);
    expect(T.syncBarrier({ syncfs: [t], fsyncDirs: [t] }).ok).toBe(true);
    expect(T.syncBarrier({ syncfs: [], fsyncDirs: [t] })).toMatchObject({ ok: false, reason: "empty-spec" });
    expect(T.syncBarrier({ syncfs: [t], fsyncDirs: [] })).toMatchObject({ ok: false, reason: "empty-spec" });
    expect(T.syncBarrier({})).toMatchObject({ ok: false, reason: "empty-spec" });
    expect(T.syncBarrier({ syncfs: [d], fsyncDirs: [t] })).toMatchObject({ ok: false, reason: "bad-target" });
    renameSync(d, `${d}.old`);
    mkdirSync(d);
    expect(T.syncBarrier({ syncfs: [t], fsyncDirs: [T.dirTarget(base)] })).toMatchObject({
      ok: false,
      reason: "syncfs",
    });
    rmSync(d, { recursive: true });
    symlinkSync(`${d}.old`, d);
    expect(T.syncBarrier({ syncfs: [t], fsyncDirs: [T.dirTarget(base)] })).toMatchObject({
      ok: false,
      reason: "syncfs",
    });
  });

  const nodeArgv = (src: string) => [process.execPath, "-e", src];
  function tracked() {
    const kids: ChildProcess[] = [];
    const spawnImpl = (cmd: string, args: string[], opts: object) => {
      const c = spawn(cmd, args, opts);
      kids.push(c);
      return c;
    };
    return { kids, spawnImpl };
  }
  /** Independent of tree.mjs's /proc scan: kill(-pgid, 0) fails with ESRCH once the group is empty. */
  const groupGoneIndependent = (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const DESCENDANT =
    "require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});";

  it("#9 supervisor: leader dies on TERM, a TERM-ignoring descendant with its own stdio is still KILLed", async () => {
    const { kids, spawnImpl } = tracked();
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(`${DESCENDANT} setInterval(()=>{},1000)`),
      stallMs: 400,
      killGraceMs: 300,
      abandonMs: 2_000,
      spawnImpl,
    });
    expect(r.kind).toBe("stalled");
    expect(groupGoneIndependent(kids[0]!.pid!)).toBe(true);
  });

  it("#9 supervisor: a normal exit that leaves a descendant behind ⇒ the group is reaped too", async () => {
    const { kids, spawnImpl } = tracked();
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(
        `${DESCENDANT} console.log(JSON.stringify({t:'result',op:'x',ok:true,result:{v:2}})); setTimeout(()=>process.exit(0),100)`,
      ),
      stallMs: 5_000,
      killGraceMs: 300,
      abandonMs: 2_000,
      spawnImpl,
    });
    expect(r).toMatchObject({ kind: "result", result: { v: 2 } });
    expect(groupGoneIndependent(kids[0]!.pid!)).toBe(true);
  });

  it("#10 protocol: wrong op / ok:false / duplicate terminal ⇒ protocol error; flat progress does not feed the watchdog", async () => {
    const line = (o: object) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
    const wrongOp = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(line({ t: "result", op: "y", ok: true, result: {} })),
    });
    expect(wrongOp).toMatchObject({ kind: "error", code: "protocol" });
    const notOk = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(line({ t: "result", op: "x", ok: false, result: {} })),
    });
    expect(notOk).toMatchObject({ kind: "error", code: "protocol" });
    const dup = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(line({ t: "result", op: "x", ok: true, result: {} }) + line({ t: "error", op: "x", code: "c" })),
    });
    expect(dup).toMatchObject({ kind: "error", code: "protocol" });
    const exitAfter = await T.superviseWorker({
      op: "x",
      argv: nodeArgv(`${line({ t: "result", op: "x", ok: true, result: {} })} process.exitCode=5`),
    });
    expect(exitAfter).toMatchObject({ kind: "error", code: "protocol" });
    const t0 = Date.now();
    const flat = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("setInterval(()=>console.log(JSON.stringify({t:'progress',op:'x',units:1,bytes:0})),100)"),
      stallMs: 500,
      killGraceMs: 200,
      abandonMs: 1_000,
    });
    expect(flat.kind).toBe("stalled");
    expect(Date.now() - t0).toBeLessThan(4_000);
    const other = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("let n=0;setInterval(()=>console.log(JSON.stringify({t:'progress',op:'y',units:++n})),100)"),
      stallMs: 500,
      killGraceMs: 200,
      abandonMs: 1_000,
    });
    expect(other.kind).toBe("stalled");
  });

  it("r2-1 probe: cleanup stops at the first non-removable directory and reports the rest", async () => {
    const base = mkTmp("r21");
    const bin = mkTmp("r21bin");
    fakeGetfattrClean(bin);
    let tmp = "";
    const r = await T.probeTreeTools({
      scratchParent: base,
      envPath: `${bin}:${process.env.PATH}`,
      _hooks: {
        afterCreate: (tmpPath: string) => {
          tmp = tmpPath;
          writeFileSync(join(tmpPath, "b", "keep"), "data"); // b is no longer empty
        },
      },
    });
    expect(r.missing).toEqual(["mv -n -T"]); // b was not an empty target any more
    expect(readFileSync(join(tmp, "b", "keep"), "utf8")).toBe("data");
    expect(r.leftover).toEqual(expect.arrayContaining([join(tmp, "b"), tmp]));
    expect(existsSync(tmp)).toBe(true);
  });

  it("r2-3 scanGroup is fail-closed: unreadable /proc, unreadable or garbled stat ⇒ incomplete", () => {
    const base = mkTmp("r23");
    expect(T.scanGroup(4242, join(base, "no-proc"))).toMatchObject({ complete: false });
    expect(T.groupMembers(4242, join(base, "no-proc"))).toBeNull();
    const fake = join(base, "proc");
    const statLine = (pid: number, pgrp: number, state = "S", start = 100) =>
      `${pid} (x y) ${state} 1 ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;
    mkdirSync(join(fake, "10"), { recursive: true });
    writeFileSync(join(fake, "10", "stat"), statLine(10, 10));
    mkdirSync(join(fake, "11"));
    writeFileSync(join(fake, "11", "stat"), statLine(11, 10, "S", 150));
    mkdirSync(join(fake, "12"));
    writeFileSync(join(fake, "12", "stat"), statLine(12, 10, "Z", 160)); // zombie: not a live member
    mkdirSync(join(fake, "13")); // no stat file: process gone (ENOENT) — fine
    expect(T.scanGroup(10, fake)).toEqual({
      complete: true,
      members: [
        { pid: 10, start: "100" },
        { pid: 11, start: "150" },
      ],
      leader: { state: "S", start: "100" },
    });
    mkdirSync(join(fake, "14", "stat"), { recursive: true }); // stat is a directory ⇒ EISDIR
    expect(T.scanGroup(10, fake).complete).toBe(false);
    expect(T.groupMembers(10, fake)).toBeNull();
    rmSync(join(fake, "14"), { recursive: true });
    mkdirSync(join(fake, "15"));
    writeFileSync(join(fake, "15", "stat"), "garbage");
    expect(T.scanGroup(10, fake).complete).toBe(false);
    expect(T.readProcStart(11, fake)).toBe("150");
  });

  it("r2-3 supervisor: /proc unreadable ⇒ SIGKILL still sent to the (unreaped) group, result is unclean", async () => {
    const { kids, spawnImpl } = tracked();
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"),
      stallMs: 300,
      killGraceMs: 200,
      abandonMs: 300,
      spawnImpl,
      procRoot: join(mkTmp("r23b"), "no-proc"),
    });
    expect(r).toMatchObject({ kind: "unclean", scan: "incomplete", killed: true, outcome: { kind: "stalled" } });
    await new Promise((res) => setTimeout(res, 200));
    expect(kids[0]!.signalCode).toBe("SIGKILL"); // independent proof the KILL was delivered
    expect(groupGoneIndependent(kids[0]!.pid!)).toBe(true);
  });

  it("r2-3 supervisor: /proc unreadable after a normal exit ⇒ unclean, never a plain result", async () => {
    const r = await T.superviseWorker({
      op: "x",
      argv: nodeArgv("console.log(JSON.stringify({t:'result',op:'x',ok:true,result:{v:3}}))"),
      stallMs: 2_000,
      killGraceMs: 200,
      abandonMs: 200,
      procRoot: join(mkTmp("r23c"), "no-proc"),
    });
    expect(r).toMatchObject({ kind: "unclean", scan: "incomplete", outcome: { kind: "result", result: { v: 3 } } });
  });
});
