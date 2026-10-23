/**
 * P1 launcher — CLI behaviour through the real bash entry, WITHOUT FUSE
 * (docs/dev/data-encryption/plan.md §2.2, §3, §6 "启动器测试"; §7 P1 smoke).
 *
 * gocryptfs / fusermount3 are fake scripts on PATH here; nothing is ever mounted. HOME is always a
 * private mktemp dir, so the user's real ~/.pi settings are never read or written. Cases needing a
 * TTY drive the launcher through script(1) (a pty); they skip when script(1) is missing.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
const NODE_DIR = dirname(process.execPath);
const which = (b: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const HAVE_SCRIPT = which("script") !== undefined && which("flock") !== undefined;

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function exe(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A fake pi PACKAGE whose dist/cli/args.js re-exports the real parser; the binary records its call. */
function fakePi(root: string): { bin: string; record: string } {
  const pkg = join(root, "fakepi");
  mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  writeFileSync(join(pkg, "dist", "cli", "args.js"), `export * from ${JSON.stringify(pathToFileURL(PI_ARGS).href)};\n`);
  const record = join(root, "pi-record.json");
  exe(
    join(pkg, "dist", "cli.js"),
    `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
  );
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync(join(pkg, "dist", "cli.js"), join(root, "bin", "pi"));
  return { bin: join(root, "bin", "pi"), record };
}

interface Ctx {
  root: string;
  home: string;
  bin: string;
  log: string;
  env: NodeJS.ProcessEnv;
}
/** Private HOME + fake gocryptfs/fusermount3 (recording every call) + fake pi. */
function ctx(opts: { gocryptfsExit?: number; version?: string } = {}): Ctx {
  const root = tmp("ps-cli-");
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  exe(
    join(bin, "gocryptfs"),
    `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "${opts.version ?? "gocryptfs 1.8.0; go-fuse 2.0.3"}"; exit 0; fi\necho "gocryptfs $*" >> "${log}"\nexit ${opts.gocryptfsExit ?? 12}\n`,
  );
  exe(join(bin, "fusermount3"), `#!/bin/sh\necho "fusermount3 $*" >> "${log}"\nexit 0\n`);
  fakePi(root);
  const env = { PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8" };
  return { root, home, bin, log, env };
}

function register(c: Ctx, name: string, entry: Record<string, string> = {}): void {
  mkdirSync(join(c.home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(c.home, ".pi", "agent", "pi-subagent.json"),
    JSON.stringify({ secure: { vaults: { [name]: entry } } }),
  );
}

function run(c: Ctx, args: string[], bin = BIN) {
  const r = spawnSync(bin, args, { env: c.env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Run under a pty (script -qefc). `answers` are typed whenever the output ends with "Password:". */
function runTty(
  c: Ctx,
  cmd: string,
  answers: string[] = [],
  timeoutMs = 30_000,
): Promise<{ code: number | null; text: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("script", ["-qefc", cmd, "/dev/null"], { env: c.env, stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    let typed = 0;
    const onData = (b: Buffer) => {
      text += b.toString("utf8");
      if (
        /(Password|Repeat): *$/.test(text.trimEnd() + " ") &&
        typed < answers.length &&
        text.split(/Password:|Repeat:/).length - 1 > typed
      ) {
        child.stdin.write(`${answers[typed++]}\r`);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, text: text.replace(/\r/g, ""), ms: Date.now() - t0 });
    });
  });
}

describe("entry point & install smoke (§7 P1)", () => {
  it("runs through a ~/.local/bin symlink to the repo script", () => {
    const c = ctx();
    const link = join(c.home, ".local", "bin", "pi-secure");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(BIN, link);
    const r = run(c, ["status"], link);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("(no vaults)");
    expect(r.out).toMatch(/^gocryptfs: 1\.8\.0/m);
  });
  it("runs from a git-install-shaped copy, reached through a chain of symlinks", () => {
    const c = ctx();
    const inst = join(c.home, ".pi", "agent", "git", "github.com", "Newbluecake", "pi-toolkit", "src", "secure", "bin");
    mkdirSync(inst, { recursive: true });
    copyFileSync(BIN, join(inst, "pi-secure"));
    copyFileSync(HELPER, join(inst, "helper.mjs"));
    chmodSync(join(inst, "pi-secure"), 0o755);
    const hop = join(c.root, "hop");
    symlinkSync(join(inst, "pi-secure"), hop);
    const link = join(c.home, ".local", "bin", "pi-secure");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(hop, link);
    const r = run(c, ["--help"], link);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("pi-secure run <name>");
  });
  it("the committed script is executable and package.json declares the bin", () => {
    expect(spawnSync("test", ["-x", BIN]).status).toBe(0);
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.bin["pi-secure"]).toBe("src/secure/bin/pi-secure");
    expect(pkg.files).toContain("src");
  });
  it("no command ⇒ usage (exit 2); unknown command ⇒ exit 2", () => {
    const c = ctx();
    expect(run(c, []).code).toBe(2);
    const r = run(c, ["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("未知命令");
  });
  it("the entry hardens the process: core size 0 and umask 077 reach the helper", () => {
    const c = ctx();
    // A probe "helper" next to a copied entry reports what it inherited.
    const d = join(c.root, "probe");
    mkdirSync(d);
    copyFileSync(BIN, join(d, "pi-secure"));
    chmodSync(join(d, "pi-secure"), 0o755);
    writeFileSync(
      join(d, "helper.mjs"),
      `import fs from "node:fs"; const lim = fs.readFileSync("/proc/self/limits","utf8").split("\\n").find(l=>l.startsWith("Max core file size")); console.log(JSON.stringify({umask: process.umask().toString(8), core: lim.split(/\\s{2,}/)[1], cwd: process.cwd(), args: process.argv.slice(2)}));`,
    );
    const r = run(c, ["a", "--", "b c"], join(d, "pi-secure"));
    expect(JSON.parse(r.out)).toEqual({ umask: "77", core: "0", cwd: "/", args: ["a", "--", "b c"] });
  });
});

describe("prerequisites & configuration errors (§3)", () => {
  it("missing gocryptfs ⇒ exit 69 with an install hint", () => {
    const c = ctx();
    const minimal = join(c.root, "minimal");
    mkdirSync(minimal);
    for (const b of ["bash", "readlink", "dirname", "uname", "flock", "fusermount3"]) {
      const p = which(b);
      if (p) symlinkSync(p, join(minimal, b));
    }
    symlinkSync(process.execPath, join(minimal, "node"));
    register(c, "acme");
    const r = spawnSync(BIN, ["unlock", "acme"], {
      env: { ...c.env, PATH: minimal },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(69);
    expect(r.stderr).toMatch(/缺少 gocryptfs/);
  });
  it("gocryptfs older than 1.8 ⇒ exit 69", () => {
    const c = ctx({ version: "gocryptfs 1.7.1; go-fuse 1.0" });
    register(c, "acme");
    const r = run(c, ["unlock", "acme"]);
    expect(r.code).toBe(69);
    expect(r.err).toMatch(/1\.7\.1 过旧/);
  });
  it("unregistered vault ⇒ exit 66 pointing at init; bad name ⇒ exit 2", () => {
    const c = ctx();
    const r = run(c, ["run", "acme"]);
    expect(r.code).toBe(66);
    expect(r.err).toContain("pi-secure init acme");
    expect(run(c, ["unlock", "Bad Name"]).code).toBe(2);
  });
  it("invalid secure section / invalid vault entry ⇒ exit 78", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(c.home, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ secure: { vaults: [] } }));
    expect(run(c, ["unlock", "acme"]).code).toBe(78);
    register(c, "acme", { dir: "relative/path" });
    expect(run(c, ["unlock", "acme"]).code).toBe(78);
  });
  it("secure.enabled=false ⇒ run refused (exit 78), nothing spawned", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(c.home, ".pi", "agent", "pi-subagent.json"),
      JSON.stringify({ secure: { enabled: false, vaults: { acme: {} } } }),
    );
    const r = run(c, ["run", "acme"]);
    expect(r.code).toBe(78);
    expect(existsSync(c.log)).toBe(false);
  });
  it("init without a TTY is refused and creates nothing", () => {
    const c = ctx();
    const r = run(c, ["init", "acme"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/TTY/);
    expect(existsSync(join(c.home, ".local", "share", "pi-toolkit-secure", "acme"))).toBe(false);
    expect(existsSync(join(c.home, ".pi", "agent", "pi-subagent.json"))).toBe(false);
  });
  it("status lists an incomplete vault with recovery steps covering BOTH locations (review L0 #4)", () => {
    const c = ctx();
    register(c, "acme");
    mkdirSync(join(c.home, ".local", "share", "pi-toolkit-secure", "acme"), { recursive: true, mode: 0o700 });
    const r = run(c, ["status", "acme"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/acme: locked {2}layout incomplete/);
    expect(r.out).toContain("恢复：");
    expect(r.out).toContain(join(c.home, ".local", "share", "pi-toolkit-secure", "acme"));
    expect(r.out).toContain(join(c.home, "secure", "acme")); // the mount point is named too
  });
});

describe("run: argument audit happens BEFORE any mount or pi start (§2.2.1)", () => {
  const cases: [string, string[]][] = [
    ["--session-dir", ["--session-dir", "/tmp/x"]],
    ['--session-dir ""', ["--session-dir", ""]],
    ["dangling --session-dir", ["--session-dir"]],
    ["--session outside", ["--session", "/tmp/elsewhere/a.jsonl"]],
    ["--export", ["--export", "/tmp/a.jsonl"]],
    ["--no-extensions", ["--no-extensions"]],
    ["-e", ["-e", "/tmp/ext.ts"]],
  ];
  for (const [name, argv] of cases) {
    it(`rejects ${name}: exit 64, no gocryptfs call, pi never started`, () => {
      const c = ctx();
      register(c, "acme");
      const r = run(c, ["run", "acme", ...argv]);
      expect(r.code, r.err).toBe(64);
      expect(r.err).toContain("参数被拒");
      expect(existsSync(c.log)).toBe(false);
      expect(existsSync(join(c.root, "pi-record.json"))).toBe(false);
    });
  }
  it("-C escaping the vault is refused before mounting", () => {
    const c = ctx();
    register(c, "acme");
    const r = run(c, ["run", "acme", "-C", "../../.."]);
    expect(r.code).toBe(2);
    expect(existsSync(c.log)).toBe(false);
  });
  it("pi not locatable as a pi package ⇒ refuse (fail closed)", () => {
    const c = ctx();
    register(c, "acme");
    rmSync(join(c.root, "bin", "pi"));
    symlinkSync("/bin/true", join(c.root, "bin", "pi"));
    const r = run(c, ["run", "acme"]);
    expect(r.code).toBe(69);
    expect(r.err).toMatch(/定位 pi 包/);
  });
});

describe.skipIf(!HAVE_SCRIPT)("unlock: password retries (D9) with a fake gocryptfs under a pty", () => {
  /** New §L.1 layout: metadata under <dir>, mount point at ~/secure/acme (registered default). */
  function layout(c: Ctx) {
    const d = join(c.home, ".local", "share", "pi-toolkit-secure", "acme");
    const mnt = join(c.home, "secure", "acme");
    mkdirSync(join(d, "cipher"), { recursive: true, mode: 0o700 });
    chmodSync(join(c.home, ".local"), 0o700);
    chmodSync(d, 0o700);
    mkdirSync(join(c.home, "secure"), { mode: 0o700 });
    mkdirSync(mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(mnt, n), "");
      chmodSync(join(mnt, n), 0o400);
    }
    writeFileSync(join(d, "cipher", "gocryptfs.conf"), "{}");
    writeFileSync(join(d, "mount.lock"), "");
    writeFileSync(join(d, "mount.lease"), "", { mode: 0o600 });
    return d;
  }
  it("3 wrong passwords ⇒ exit 77 after 1s+2s back-off; exactly 3 attempts; lock released", async () => {
    const c = ctx({ gocryptfsExit: 12 });
    register(c, "acme");
    const d = layout(c);
    const r = await runTty(c, `${BIN} unlock acme`);
    expect(r.code, r.text).toBe(77);
    expect(r.text).toContain("口令错误（1/3）");
    expect(r.text).toContain("口令错误（2/3）");
    expect(r.text).toContain("口令连续错误 3 次");
    expect(r.ms).toBeGreaterThanOrEqual(3_000);
    const calls = readFileSync(c.log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(`gocryptfs -nonempty -- ${d}/cipher ${join(c.home, "secure", "acme")}`);
    expect(spawnSync("flock", ["-n", join(d, "mount.lock"), "true"]).status).toBe(0);
  }, 30_000);
  it("a failed sentinel check refuses to mount (gocryptfs never called)", async () => {
    const c = ctx({ gocryptfsExit: 0 });
    register(c, "acme");
    const d = layout(c);
    writeFileSync(join(c.home, "secure", "acme", "stray"), "");
    const r = await runTty(c, `${BIN} unlock acme`);
    expect(r.code).toBe(78); // §L.1: extra entries at the mount point refuse the mount (78)
    expect(r.text).toContain("多余条目：stray");
    expect(existsSync(c.log)).toBe(false);
  }, 30_000);
  it("gocryptfs exit 0 without a real mount is caught by the mountinfo check", async () => {
    const c = ctx({ gocryptfsExit: 0 });
    register(c, "acme");
    layout(c);
    const r = await runTty(c, `${BIN} unlock acme`);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/mountinfo 不符/);
  }, 30_000);
  it("mount.lock held by someone else ⇒ exit 73 after the 10s wait", async () => {
    const c = ctx({ gocryptfsExit: 0 });
    register(c, "acme");
    const d = layout(c);
    const holder = spawn("flock", [join(d, "mount.lock"), "sleep", "30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const r = await runTty(c, `${BIN} unlock acme`, [], 25_000);
      expect(r.code, r.text).toBe(73);
      expect(r.text).toContain("另一个 pi-secure 正在挂载或卸载");
      expect(r.ms).toBeLessThan(14_000);
      expect(existsSync(c.log)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 30_000);
});

describe("review #4: an interrupted init names BOTH cleanup locations", () => {
  it.skipIf(!HAVE_SCRIPT)("gocryptfs -init failure: the hint lists the metadata dir and the mount point", async () => {
    const c = ctx({ gocryptfsExit: 12 });
    const r = await runTty(c, `${BIN} init acme`, []);
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("gocryptfs -init 失败");
    expect(r.text).toContain(join(c.home, ".local", "share", "pi-toolkit-secure", "acme"));
    expect(r.text).toContain(join(c.home, "secure", "acme"));
    expect(r.text).toMatch(/删除元数据目录.*挂载点目录/);
    // the layout WAS created (both locations exist on disk), matching the hint's premise
    expect(existsSync(join(c.home, ".local", "share", "pi-toolkit-secure", "acme"))).toBe(true);
    expect(existsSync(join(c.home, "secure", "acme", "work"))).toBe(true);
  });
});

describe("legacy-layout vaults: read-only compat (§L.3)", () => {
  /** A registered pre-L0 vault: entry {dir, link}, mount point <dir>/mnt with sentinels. */
  function legacy(c: Ctx, name = "old") {
    const d = join(c.home, ".local", "share", "pi-toolkit-secure", name);
    mkdirSync(join(d, "cipher"), { recursive: true, mode: 0o700 });
    writeFileSync(join(d, "cipher", "gocryptfs.conf"), "{}");
    writeFileSync(join(d, "mount.lock"), "");
    mkdirSync(join(d, "mnt"), { mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(d, "mnt", n), "");
      chmodSync(join(d, "mnt", n), 0o400);
    }
    mkdirSync(join(c.home, "secure"), { recursive: true, mode: 0o700 });
    symlinkSync(join(d, "mnt", "work"), join(c.home, "secure", name));
    register(c, name, { dir: d, link: join(c.home, "secure", name) });
    return d;
  }
  it("status shows legacy-layout and the migration pointer; no lease is required", () => {
    const c = ctx();
    legacy(c);
    const r = run(c, ["status", "old"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/old: locked {2}layout legacy {2}mnt .*\/mnt/);
    expect(r.out).toContain("旧布局");
    expect(r.out).toContain("pi-secure export old <文件>");
  });
  it("unlock / run / init --fix-settings are refused with 78 and the export→import guidance", () => {
    const c = ctx();
    legacy(c);
    for (const args of [
      ["unlock", "old"],
      ["run", "old"],
      ["init", "old", "--fix-settings"],
    ]) {
      const r = run(c, args);
      expect(r.code, `${args}: ${r.err}`).toBe(78);
      expect(r.err).toContain("使用旧布局");
      expect(r.err).toContain("pi-secure export old <文件>");
      expect(r.err).toContain("pi-secure import <文件> <新名字>");
    }
    expect(existsSync(c.log)).toBe(false); // gocryptfs never called
    expect(existsSync(join(c.root, "pi-record.json"))).toBe(false); // pi never started
  });
  it("lock still works on a legacy vault (not mounted ⇒ ok, no refusal; mount path shares finalize)", () => {
    const c = ctx({ gocryptfsExit: 0 });
    legacy(c);
    const r = run(c, ["lock", "old"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("未挂载");
    expect(existsSync(c.log)).toBe(false); // nothing to unmount
  });
});

describe("hard backstop (§R4 m1): a wedged finalize still exits non-zero with one stderr line", () => {
  it("exits 75 at budget+0.5s (budget 2s) even when the unmount stage never settles", () => {
    const script = `
      const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
      const v = H.deriveVault("acme", "/nonexistent/acme", "/nonexistent/l");
      setInterval(() => {}, 1000); // keep the loop alive like a stuck libuv fs request would
      await H.finalizeBounded(v, { budgetMs: 2000, deps: {
        mountState: () => "stale",
        unmount: () => new Promise(() => {}),
      } });
      console.log("unreachable");`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    const ms = Date.now() - t0;
    expect(r.status).toBe(75);
    expect(r.stdout).not.toContain("unreachable");
    expect(r.stderr.trim().split("\n")).toEqual([`pi-secure: 卸载未完成，保险库 acme 可能仍挂载（/nonexistent/l）`]);
    expect(ms).toBeGreaterThanOrEqual(2_400);
    expect(ms).toBeLessThan(4_500);
  });
});
