/**
 * convert-plan.md r3 §7.3 conformance — XC4 / XC5 / XC6 / XC7 (this file) and the index of all XC rows.
 *
 *   XC1  gocryptfs 1.8 stores plaintext mode/mtime as the cipher's mode/mtime ...... secure-convert-xc2.test.ts
 *   XC2  real gocryptfs cipher representation (files/dirs/links/hardlinks/long names/xattrs)
 *        + package round trip — the freeze gate of format v2 ......................... secure-convert-xc2.test.ts
 *   XC3  gocryptfs.conf shape + init FeatureFlags == allowed set ....................... secure-convert-xc2.test.ts
 *   XC4  unmounted + mount.lock held + lease free ⇒ cipher tree identical before/after export   (here)
 *   XC5  GNU tar can `-tf` our package; a GNU-tar-made package without MANIFEST ⇒ refused     (here)
 *   XC6  real pi: header reading rule, custom sessionDir filtered by exact cwd, `open` of a v3
 *        file never rewrites it                                                               (here)
 *   XC7  `getfattr -R -h -d -m -` reports system.posix_acl_access and security.capability     (here)
 *   XC8  coreutils `mv -n -T` = renameat2(RENAME_NOREPLACE), exit 0 on an existing target ... secure-convert-xc89.test.ts
 *   XC9  gocryptfs write-through (no FUSE writeback cache) + `sync -f` = syncfs ............. secure-convert-xc89.test.ts
 *
 * V7 decision: the two pre-gate files (XC2 ran before V1 froze the format, XC8/XC9 before V2 started)
 * are KEPT as they are — their history is part of the evidence chain the V1/V2 reports cite — and this
 * file carries the remaining rows plus this index (V7-report §3).
 *
 * Self-gating (no env switch): XC4/XC5 need the real-launcher stack (gocryptfs, fusermount3, flock,
 * script, unshare, /dev/fuse); XC6 needs the dev pi package; XC7 needs the real attr `getfattr`.
 * Everything runs in mktemp dirs (RealHarness, token-scoped cleanup) with a TEST-ONLY password; the
 * user's ~/secure and ~/.pi are never touched. Holds the cross-suite gocryptfs test lock.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "../secure/gocryptfs-test-lock.js";
import {
  BIN,
  type Env,
  REPO,
  RealHarness,
  lookInside,
  plain,
  realSkipReason,
  until,
  which,
} from "../secure/private-real-harness.js";

const PI_CORE = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "session-manager.js");
const HAVE_PI = existsSync(PI_CORE);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design
const S: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "sessions.mjs")).href);
const REAL_SKIP = realSkipReason();

/** rel → {type, mode, mtime ns, size, sha | target, nlink} of a cipher tree (lstat only, nothing followed). */
function cipherFacts(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (rel: string) => {
    const p = rel ? join(root, rel) : root;
    const st = lstatSync(p, { bigint: true });
    const e: Record<string, unknown> = {
      mode: (st.mode & 0o7777n).toString(8),
      mtimeNs: st.mtimeNs.toString(),
      nlink: st.nlink.toString(),
    };
    if (st.isSymbolicLink()) Object.assign(e, { type: "l", target: readlinkSync(p) });
    else if (st.isDirectory()) {
      e.type = "d";
      for (const n of readdirSync(p).sort()) walk(rel ? `${rel}/${n}` : n);
    } else {
      e.type = "f";
      e.size = st.size.toString();
      e.sha = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
    out[rel || "."] = e;
  };
  walk("");
  return out;
}

/** A filled new-layout vault `acme` (harness passfile init) — plaintext with links, hardlinks, long names. */
function filledVault(T: RealHarness): Env {
  const e = T.setup();
  lookInside(e, (root) => {
    const w = join(root, "work");
    mkdirSync(join(w, "d", "e"), { recursive: true });
    writeFileSync(join(w, "d", "f.txt"), "payload\n");
    linkSync(join(w, "d", "f.txt"), join(w, "hard"));
    symlinkSync("d/f.txt", join(w, "rel"));
    writeFileSync(join(w, "N".repeat(200)), "long\n");
    mkdirSync(join(root, "state", "sessions", "default"), { recursive: true });
  });
  return e;
}

describe.skipIf(REAL_SKIP !== "")("XC4 / XC5 — export against real gocryptfs + GNU tar", () => {
  let release: (() => void) | undefined;
  const T = new RealHarness();
  beforeAll(async () => {
    release = await acquireGocryptfsTestLock(560_000);
  }, 600_000);
  afterAll(() => {
    T.cleanup();
    release?.();
  });

  it("XC4: unmounted, mount.lock held by the export, lease free ⇒ the cipher tree is identical before and after", async () => {
    const e = filledVault(T);
    const cipher = join(e.dir, "cipher");
    const before = cipherFacts(cipher);
    const lockBefore = statSync(join(e.dir, "mount.lock"));
    const pkg = join(e.r, "a.tar");
    const exp = spawn(BIN, ["export", "acme", pkg], {
      env: { ...e.env, PI_SECURE_TEST_SEAMS: "1", PI_SECURE_TEST_ARCHIVE_STALL_MS: "1500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    exp.stdout.on("data", (b: Buffer) => (text += b.toString()));
    exp.stderr.on("data", (b: Buffer) => (text += b.toString()));
    // while the worker runs: mount.lock is held (by the export), the lease is free, nothing mounted
    await until(
      () => spawnSync("flock", ["-n", join(e.dir, "mount.lock"), "true"]).status !== 0,
      15_000,
      "export holds mount.lock",
    );
    expect(spawnSync("flock", ["-n", e.lease, "true"]).status).toBe(0);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(` ${e.mnt} `);
    const code = await new Promise<number | null>((r) => exp.on("close", r));
    expect(code, text).toBe(0);
    expect(cipherFacts(cipher)).toEqual(before);
    const lockAfter = statSync(join(e.dir, "mount.lock"));
    expect([lockAfter.ino, lockAfter.size, lockAfter.mtimeMs]).toEqual([
      lockBefore.ino,
      lockBefore.size,
      lockBefore.mtimeMs,
    ]);
    expect(existsSync(pkg)).toBe(true);
  }, 120_000);

  it("XC5: GNU tar lists every member of our package; a GNU-tar-made package with the same cipher but no MANIFEST ⇒ 65, nothing registered", () => {
    const e = filledVault(T);
    const pkg = join(e.r, "a.tar");
    const ex = plain(e, `export acme ${pkg}`, 60_000);
    expect(ex.code, ex.text).toBe(0);
    const t = spawnSync("tar", ["-tvf", pkg], { encoding: "utf8" });
    expect(t.status, t.stderr).toBe(0);
    const members = spawnSync("tar", ["-tf", pkg], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    expect(members[0]).toBe("pi-secure-vault/cipher/"); // the format has no bare root member
    expect(members).toContain("pi-secure-vault/MANIFEST.json");
    expect(members).toContain("pi-secure-vault/cipher/gocryptfs.conf");
    expect(members).toContain("pi-secure-vault/cipher/gocryptfs.diriv");
    // every cipher entry is listed (dirs with a trailing slash; links are NEVER tar link members)
    const cipher = join(e.dir, "cipher");
    const rels = Object.keys(cipherFacts(cipher)).filter((k) => k !== ".");
    const byIno = new Map<number, string[]>();
    for (const r of rels) {
      const st = lstatSync(join(cipher, r));
      if (st.isSymbolicLink()) continue; // symlinks live only in MANIFEST.json
      if (st.isDirectory()) expect(members, r).toContain(`pi-secure-vault/cipher/${r}/`);
      else byIno.set(st.ino, [...(byIno.get(st.ino) ?? []), r]);
    }
    // a hardlink group is ONE tar file member (the others are MANIFEST entries)
    for (const group of byIno.values())
      expect(group.filter((r) => members.includes(`pi-secure-vault/cipher/${r}`)).length, group.join(",")).toBe(1);
    expect(t.stdout).not.toMatch(/^[lh]/m); // no tar symlink/hardlink members at all
    // GNU tar re-pack of the extracted package minus MANIFEST.json ⇒ refused
    const x = mkdtempSync(join(e.r, "x-"));
    expect(spawnSync("tar", ["-xf", pkg, "-C", x]).status).toBe(0);
    rmSync(join(x, "pi-secure-vault", "MANIFEST.json"));
    const settings = readFileSync(join(e.h, ".pi", "agent", "pi-subagent.json"), "utf8");
    // same member set as ours (no bare root member). GNU's own pax dialect is refused at its PaxHeaders
    // names already; the plain ustar re-pack gets past the tar layer and is refused for the missing
    // MANIFEST — both 65, both rolled back
    for (const [fmt, why] of [
      ["pax", /pax-name|PaxHeaders/],
      ["ustar", /MANIFEST/],
    ] as const) {
      const alt = join(e.r, `gnu-${fmt}.tar`);
      const mk = spawnSync(
        "tar",
        [`--format=${fmt}`, "--owner=0", "--group=0", "--numeric-owner", "-cf", alt, "-C", x, "pi-secure-vault/cipher"],
        { encoding: "utf8" },
      );
      expect(mk.status, mk.stderr).toBe(0);
      const im = plain(e, `import ${alt} gnu`, 60_000);
      expect(im.code, `${fmt}: ${im.text}`).toBe(65);
      expect(im.text).toMatch(why);
    }
    expect(JSON.parse(readFileSync(join(e.h, ".pi", "agent", "pi-subagent.json"), "utf8"))).toEqual(
      JSON.parse(settings),
    );
    expect(existsSync(join(e.h, ".local", "share", "pi-toolkit-secure", "gnu"))).toBe(false);
    expect(existsSync(join(e.h, "secure", "gnu"))).toBe(false);
  }, 120_000);
});

describe.skipIf(!HAVE_PI)("XC6 — real pi session facts the sessions engine mirrors", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Pi: any;
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "xc6-"));
    Pi = await import(pathToFileURL(PI_CORE).href);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const hdr = (o: Record<string, unknown>) =>
    JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00.000Z", ...o });

  it("header rule: our mirror and pi's discovery agree on every corpus file", () => {
    const cwd = join(dir, "proj");
    const corpus: Record<string, string> = {
      plain: `${hdr({ cwd })}\n`,
      blankFirst: `\n\n${hdr({ cwd })}\n`,
      malformedFirst: `{oops\n${hdr({ cwd })}\n`,
      falsyFirst: `null\n0\nfalse\n""\n${hdr({ cwd })}\n`,
      messageFirst: `${JSON.stringify({ type: "message", id: "m" })}\n${hdr({ cwd })}\n`,
      noNewline: hdr({ cwd }),
      empty: "",
      beyondWindow: `${" ".repeat(1024 * 1024 + 10)}\n${hdr({ cwd })}\n`,
    };
    for (const [name, body] of Object.entries(corpus)) {
      const d = join(dir, `h-${name}`);
      mkdirSync(d);
      const f = join(d, "s.jsonl");
      writeFileSync(f, body);
      const piSays = Pi.findMostRecentSession(d, cwd) === f;
      const ours = S.readSessionHeaderLikePi(f).status === "ok";
      expect(ours, name).toBe(piSays);
    }
  });

  it("a custom sessionDir is filtered by EXACT header cwd (not subdirs, not dash-siblings)", async () => {
    const sd = join(dir, "custom");
    mkdirSync(sd);
    const cwd = join(dir, "work");
    const put = (id: string, c: string) =>
      writeFileSync(join(sd, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${hdr({ id, cwd: c })}\n`);
    put("own", cwd);
    put("sub", join(cwd, "sub"));
    put("sibling", `${cwd}-2`);
    put("parent", dir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = (l: any[]) => l.map((s) => s.id).sort();
    expect(ids(await Pi.SessionManager.list(cwd, sd))).toEqual(["own"]);
    expect(ids(await Pi.SessionManager.list(join(cwd, "sub"), sd))).toEqual(["sub"]);
    const recent = Pi.SessionManager.continueRecent(cwd, sd);
    expect(recent.getSessionFile()).toBe(join(sd, "2026-01-01T00-00-00-000Z_own.jsonl"));
  });

  it("open() never rewrites a current-version (v3) file; an old-version file IS migrated (the contrast)", () => {
    const cwd = join(dir, "openw");
    const v3 = join(dir, "v3.jsonl");
    const body =
      `${hdr({ id: "v3", cwd })}\n` +
      `${JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } })}\n`;
    writeFileSync(v3, body);
    const t = new Date("2026-01-02T00:00:00Z");
    utimesSync(v3, t, t);
    const st0 = statSync(v3);
    Pi.SessionManager.open(v3);
    const st1 = statSync(v3);
    expect(readFileSync(v3, "utf8")).toBe(body);
    expect([st1.mtimeMs, st1.ino, st1.size]).toEqual([st0.mtimeMs, st0.ino, st0.size]);
    // version-less (v1) header + an entry without ids ⇒ pi migrates and rewrites the file
    const v1 = join(dir, "v1.jsonl");
    const old =
      `${JSON.stringify({ type: "session", id: "v1", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n` +
      `${JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } })}\n`;
    writeFileSync(v1, old);
    Pi.SessionManager.open(v1);
    expect(readFileSync(v1, "utf8")).not.toBe(old);
    expect(JSON.parse(readFileSync(v1, "utf8").split("\n")[0]!).version).toBe(3);
  });
});

describe.skipIf(!which("getfattr"))("XC7 — getfattr reports ACL and capability xattrs", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "xc7-")); // created only when the block really runs
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("system.posix_acl_access (raw ACL xattr) is reported by `getfattr -R -h -d -m -`", () => {
    const f = join(dir, "acl.txt");
    writeFileSync(f, "x");
    const set = spawnSync(
      "python3",
      [
        "-c",
        [
          "import os, struct, sys",
          "e = lambda tag, perm, i: struct.pack('<HHI', tag, perm, i & 0xffffffff)",
          "v = struct.pack('<I', 2) + e(1, 6, -1) + e(2, 4, os.getuid()) + e(4, 4, -1) + e(0x10, 4, -1) + e(0x20, 4, -1)",
          "os.setxattr(sys.argv[1], 'system.posix_acl_access', v)",
        ].join("\n"),
        f,
      ],
      { encoding: "utf8" },
    );
    if (set.status !== 0) return; // filesystem without ACL support: nothing to pin here
    const r = spawnSync("getfattr", ["-R", "-h", "-d", "-m", "-", "--absolute-names", "--", dir], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`# file: ${f}`);
    expect(r.stdout).toMatch(/^system\.posix_acl_access=/m);
  });

  it("security.capability (file capability set inside a user namespace) is reported", () => {
    if (!which("setcap") || !which("unshare")) return;
    const f = join(dir, "cap.bin");
    writeFileSync(f, "x");
    const set = spawnSync("unshare", ["--user", "--map-root-user", "setcap", "cap_net_raw+ep", f], {
      encoding: "utf8",
    });
    if (set.status !== 0) return; // no namespaced file capabilities on this kernel/fs
    const r = spawnSync("getfattr", ["-h", "-d", "-m", "-", "--absolute-names", "--", f], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^security\.capability=/m);
  });
});
