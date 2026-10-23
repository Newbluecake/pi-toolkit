/**
 * N0 — launcher OFF golden (private-plan r3 §6.5 / §7.2 F1).
 *
 * Generated ONCE from the post-L0 launcher (before any `--private` code existed) and NEVER
 * regenerated: every `pi-secure` subcommand WITHOUT `--private`, with no `private` entry key, no
 * `private.json` and an idle `mount.lease`, must keep its stdout/stderr bytes and exit code.
 * USAGE-printing scenarios are deliberately excluded (Q9: USAGE gains new lines). The argv
 * exception F1b (`run <name> --private|--no-private …` right after the name) is NOT pinned here;
 * every other `--private` spelling (after `-C`, after `--`, inside the message) is.
 *
 * Two self-gated blocks, each driven through the real bash entry with a private mktemp HOME:
 *  - "fake": fake gocryptfs / fusermount3 / pi on PATH (real flock), pty via script(1) where the
 *    launcher needs a TTY. Needs Linux + script + flock + a usable /dev/fuse (preflight checks it).
 *  - "real": real gocryptfs mounts made test-side with a FAKE passfile (never the user's vaults),
 *    then only non-TTY launcher commands (status / unlock-already / run-already / lock / stale).
 *
 * Normalization (environment-dependent only): the per-case scratch root ⇒ `<ROOT>`; pids ⇒
 * `<PID>`; settings backup timestamps ⇒ `<TS>`; machine warnings (swap/core_pattern) are dropped
 * from stderr and collapsed to one `warn: <env>` line in status output.
 *
 * Regeneration is refused when the fixture exists (`PI_SECURE_LAUNCHER_GOLDEN=write` only writes
 * a MISSING fixture).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
const FIXTURE = join(REPO, "tests", "fixtures", "secure-launcher-off-golden.json");
const FAKE_PW = "TESTPASS-fake-not-a-secret";
const WRITE = process.env.PI_SECURE_LAUNCHER_GOLDEN === "write";

const which = (b: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const HAVE_DEV_FUSE = spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;
const HAVE_FAKE =
  process.platform === "linux" && ["script", "flock"].every((b) => which(b) !== undefined) && HAVE_DEV_FUSE;
const HAVE_REAL = HAVE_FAKE && ["gocryptfs", "fusermount3"].every((b) => which(b) !== undefined);

interface GoldenCase {
  name: string;
  argv: string[];
  tty: boolean;
  exit: number | null;
  /** non-TTY: stdout; TTY: the merged pty transcript. */
  stdout: string;
  stderr: string;
  /** Normalized calls recorded by the fake gocryptfs/fusermount3 (fake block only). */
  calls?: string[];
  /** Normalized record written by the fake pi (when pi ran). */
  pi?: unknown;
}
interface GoldenFile {
  $comment: string;
  fake: GoldenCase[];
  real: GoldenCase[];
}

const produced: { fake: GoldenCase[]; real: GoldenCase[] } = { fake: [], real: [] };
const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}

const golden: GoldenFile | undefined = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as GoldenFile)
  : undefined;

afterAll(() => {
  for (const d of scratch) {
    for (const l of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const mp = l.split(" ")[4];
      if (mp && mp.startsWith(d + "/")) spawnSync("fusermount3", ["-uz", mp], { timeout: 10_000 });
    }
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
  if (WRITE) {
    if (golden) throw new Error(`${FIXTURE} exists — the N0 golden is never regenerated`);
    if (!HAVE_FAKE || !HAVE_REAL) throw new Error("refusing to write a partial golden (a block was skipped)");
    const file: GoldenFile = {
      $comment:
        "N0 launcher off golden (private-plan r3 §6.5/§7.2 F1). Generated once from the post-L0 launcher; NEVER regenerate. " +
        "See tests/secure/launcher-off-golden.test.ts for the normalization rules.",
      fake: produced.fake,
      real: produced.real,
    };
    writeFileSync(FIXTURE, JSON.stringify(file, null, 2) + "\n");
  }
});

function exe(p: string, body: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

function normalize(text: string, root: string, { status = false } = {}): string {
  let t = text.replace(/\r/g, "").split(root).join("<ROOT>").split(tmpdir()).join("<TMP>");
  t = t
    .replace(/\bpid \d+/g, "pid <PID>")
    .replace(/\.bak-\d{8}-\d{6}/g, ".bak-<TS>")
    .replace(/invalid JSON \([^\n]*\)$/gm, "invalid JSON (<v8 message>)");
  const lines = t.split("\n").filter((l) => !/^(pi-secure: )?警告：/.test(l));
  if (status) {
    const outLines: string[] = [];
    let warned = false;
    for (const l of lines) {
      if (/^warn: /.test(l)) {
        if (!warned) outLines.push("warn: <env>");
        warned = true;
      } else outLines.push(l);
    }
    return outLines.join("\n");
  }
  return lines.join("\n");
}

interface Env {
  root: string;
  home: string;
  log: string;
  record: string;
  env: NodeJS.ProcessEnv;
}

function fakePiPackage(root: string): string {
  const pkg = join(root, "fakepi");
  mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  writeFileSync(join(pkg, "dist", "cli", "args.js"), `export * from ${JSON.stringify(pathToFileURL(PI_ARGS).href)};\n`);
  const record = join(root, "pi-record.json");
  exe(
    join(pkg, "dist", "cli.js"),
    `#!/usr/bin/env node
import fs from "node:fs";
const e = process.env;
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  env: { PI_SECURE_VAULT: e.PI_SECURE_VAULT, PI_SECURE_SESSION: e.PI_SECURE_SESSION, PI_SECURE_ORIG_ENV: e.PI_SECURE_ORIG_ENV,
         PI_SECURE_NS: e.PI_SECURE_NS, PI_SECURE_STALE: e.PI_SECURE_STALE, TMPDIR: e.TMPDIR, ARMORY_MEMORY_ROOT: e.ARMORY_MEMORY_ROOT,
         PWD: e.PWD, PI_CODING_AGENT_SESSION_DIR: e.PI_CODING_AGENT_SESSION_DIR },
}));
process.exit(Number(e.FAKE_PI_EXIT ?? 0));
`,
  );
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync(join(pkg, "dist", "cli.js"), join(root, "bin", "pi"));
  return record;
}

/** Private HOME; `fakeGocryptfs` ⇒ fake gocryptfs/fusermount3 recording every call. */
function makeEnv(opts: { fakeGocryptfs: boolean; gocryptfsExit?: number; initExit?: number }): Env {
  const root = tmp("ps-n0-");
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  if (opts.fakeGocryptfs) {
    exe(
      join(bin, "gocryptfs"),
      `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "gocryptfs 1.8.0; go-fuse 2.0.3"; exit 0; fi\necho "gocryptfs $*" >> "${log}"\nif [ "$1" = "-init" ]; then exit ${opts.initExit ?? 1}; fi\nexit ${opts.gocryptfsExit ?? 12}\n`,
    );
    exe(join(bin, "fusermount3"), `#!/bin/sh\necho "fusermount3 $*" >> "${log}"\nexit 0\n`);
  }
  const record = fakePiPackage(root);
  // node only (never NODE_DIR itself: a globally installed real `pi` may live there).
  const nodeBin = join(root, "nodebin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${nodeBin}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: tmpdir(),
    PI_SECURE_STALE: "must-not-reach-pi",
    PI_CODING_AGENT_SESSION_DIR: "/must/not/reach/pi",
  };
  return { root, home, log, record, env };
}

function settings(e: Env, value: unknown): void {
  mkdirSync(join(e.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(e.home, ".pi", "agent", "pi-subagent.json"), JSON.stringify(value));
}
function register(e: Env, name: string, entry: Record<string, unknown> = {}): void {
  settings(e, { secure: { vaults: { [name]: entry } } });
}

/** §L.1 layout for `acme` at the defaults; cipher holds a fake conf unless `realCipher`. */
function layout(e: Env, { realCipher = false } = {}): { dir: string; mnt: string } {
  const dir = join(e.home, ".local", "share", "pi-toolkit-secure", "acme");
  const mnt = join(e.home, "secure", "acme");
  mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
  for (const p of [join(e.home, ".local"), join(e.home, ".local", "share"), dirname(dir), dir, join(dir, "cipher")])
    chmodSync(p, 0o700);
  mkdirSync(join(e.home, "secure"), { mode: 0o700 });
  mkdirSync(mnt, { mode: 0o700 });
  for (const n of ["work", "state"]) {
    writeFileSync(join(mnt, n), "");
    chmodSync(join(mnt, n), 0o400);
  }
  if (realCipher) {
    const pf = join(e.root, "pf");
    writeFileSync(pf, `${FAKE_PW}\n`, { mode: 0o600 });
    const r = spawnSync("gocryptfs", ["-init", "-q", "-scryptn", "10", "-passfile", pf, "--", join(dir, "cipher")], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.status !== 0) throw new Error(`gocryptfs -init failed: ${r.stderr}`);
  } else writeFileSync(join(dir, "cipher", "gocryptfs.conf"), "{}");
  writeFileSync(join(dir, "mount.lock"), "", { mode: 0o600 });
  writeFileSync(join(dir, "mount.lease"), "", { mode: 0o600 });
  chmodSync(join(dir, "mount.lease"), 0o600);
  return { dir, mnt };
}

function legacyLayout(e: Env): void {
  const dir = join(e.home, ".local", "share", "pi-toolkit-secure", "acme");
  mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "mnt"), { mode: 0o700 });
  for (const n of ["work", "state"]) {
    writeFileSync(join(dir, "mnt", n), "");
    chmodSync(join(dir, "mnt", n), 0o400);
  }
  writeFileSync(join(dir, "cipher", "gocryptfs.conf"), "{}");
  writeFileSync(join(dir, "mount.lock"), "", { mode: 0o600 });
}

function readCalls(e: Env): string[] | undefined {
  if (!existsSync(e.log)) return undefined;
  return normalize(readFileSync(e.log, "utf8"), e.root).trim().split("\n");
}
function readPi(e: Env): unknown {
  if (!existsSync(e.record)) return undefined;
  return JSON.parse(normalize(readFileSync(e.record, "utf8"), e.root));
}

function runPlain(e: Env, argv: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(BIN, argv, {
    env: { ...e.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runTty(e: Env, argv: string[], timeoutMs = 60_000): Promise<{ code: number | null; text: string }> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = [BIN, ...argv].map(q).join(" ");
  return new Promise((resolve) => {
    const child = spawn("script", ["-qefc", cmd, "/dev/null"], { env: e.env, stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (b: Buffer) => (text += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (text += b.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, text });
    });
  });
}

function check(block: "fake" | "real", c: GoldenCase): void {
  produced[block].push(c);
  if (WRITE) return;
  expect(golden, `${FIXTURE} missing — N0 golden must exist`).toBeDefined();
  const want = golden![block].find((x) => x.name === c.name);
  expect(want, `golden case missing: ${block}/${c.name}`).toBeDefined();
  expect(c).toEqual(want);
}

async function record(
  block: "fake" | "real",
  name: string,
  e: Env,
  argv: string[],
  { tty = false, extraEnv = {} as NodeJS.ProcessEnv, status = false } = {},
): Promise<GoldenCase> {
  let c: GoldenCase;
  if (tty) {
    const r = await runTty(e, argv);
    c = { name, argv, tty, exit: r.code, stdout: normalize(r.text, e.root, { status }), stderr: "" };
  } else {
    const r = runPlain(e, argv, extraEnv);
    c = {
      name,
      argv,
      tty,
      exit: r.code,
      stdout: normalize(r.out, e.root, { status }),
      stderr: normalize(r.err, e.root),
    };
  }
  const calls = readCalls(e);
  if (calls) c.calls = calls;
  const pi = readPi(e);
  if (pi !== undefined) c.pi = pi;
  check(block, c);
  return c;
}

// ─────────────────────────────── fake block ───────────────────────────────

describe.skipIf(!HAVE_FAKE)("N0 golden — fake gocryptfs (no FUSE mount)", () => {
  const F = (name: string, fn: () => Promise<void>, t = 60_000) => it(name, fn, t);

  F("status: no settings file", async () => {
    await record("fake", "status-no-settings", makeEnv({ fakeGocryptfs: true }), ["status"], { status: true });
  });
  F("status: corrupt settings JSON", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    mkdirSync(join(e.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(e.home, ".pi", "agent", "pi-subagent.json"), "{nope");
    await record("fake", "status-corrupt-settings", e, ["status"], { status: true });
  });
  F("status: secure not an object / invalid entries / enabled=false", async () => {
    const e1 = makeEnv({ fakeGocryptfs: true });
    settings(e1, { secure: 7 });
    await record("fake", "status-secure-not-object", e1, ["status"], { status: true });
    const e2 = makeEnv({ fakeGocryptfs: true });
    settings(e2, { secure: { vaults: { "Bad Name": {}, acme: { dir: "rel" }, beta: { mnt: "rel" }, gamma: 3 } } });
    await record("fake", "status-invalid-entries", e2, ["status"], { status: true });
    const e3 = makeEnv({ fakeGocryptfs: true });
    settings(e3, { secure: { enabled: false } });
    await record("fake", "status-enabled-false", e3, ["status"], { status: true });
  });
  F("status: registered vault, layout ok, locked (all + by name)", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme");
    layout(e);
    await record("fake", "status-locked-all", e, ["status"], { status: true });
    await record("fake", "status-locked-name", e, ["status", "acme"], { status: true });
  });
  F("status: unregistered name / registered but missing / incomplete / legacy", async () => {
    const e1 = makeEnv({ fakeGocryptfs: true });
    await record("fake", "status-unregistered-name", e1, ["status", "zed"], { status: true });
    const e2 = makeEnv({ fakeGocryptfs: true });
    register(e2, "acme");
    await record("fake", "status-missing", e2, ["status"], { status: true });
    const e3 = makeEnv({ fakeGocryptfs: true });
    register(e3, "acme");
    const { mnt, dir } = layout(e3);
    writeFileSync(join(mnt, "stray"), "x");
    rmSync(join(dir, "mount.lease"));
    await record("fake", "status-incomplete", e3, ["status"], { status: true });
    const e4 = makeEnv({ fakeGocryptfs: true });
    register(e4, "acme", { link: "~/secure/acme" });
    legacyLayout(e4);
    await record("fake", "status-legacy", e4, ["status"], { status: true });
  });
  F("status: bad vault name argument", async () => {
    await record("fake", "status-bad-name", makeEnv({ fakeGocryptfs: true }), ["status", "Bad"], { status: true });
  });

  F("unlock: not found / bad name / legacy / non-TTY", async () => {
    await record("fake", "unlock-not-found", makeEnv({ fakeGocryptfs: true }), ["unlock", "acme"]);
    await record("fake", "unlock-bad-name", makeEnv({ fakeGocryptfs: true }), ["unlock", "Bad"]);
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme", { link: "~/secure/acme" });
    legacyLayout(e);
    await record("fake", "unlock-legacy", e, ["unlock", "acme"]);
    const e2 = makeEnv({ fakeGocryptfs: true });
    register(e2, "acme");
    layout(e2);
    await record("fake", "unlock-non-tty", e2, ["unlock", "acme"]);
  });
  F("unlock (pty): 3 wrong passwords ⇒ 77", async () => {
    const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 12 });
    register(e, "acme");
    layout(e);
    await record("fake", "unlock-tty-bad-password", e, ["unlock", "acme"], { tty: true });
  });
  F("unlock (pty): gocryptfs exit 0 without a mount ⇒ mountinfo mismatch", async () => {
    const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 0 });
    register(e, "acme");
    layout(e);
    await record("fake", "unlock-tty-no-mount", e, ["unlock", "acme"], { tty: true });
  });
  F("unlock (pty): gocryptfs exit 10 / 23 ⇒ mapped failure", async () => {
    const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 10 });
    register(e, "acme");
    layout(e);
    await record("fake", "unlock-tty-exit10", e, ["unlock", "acme"], { tty: true });
    const e2 = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 23 });
    register(e2, "acme");
    layout(e2);
    await record("fake", "unlock-tty-exit23", e2, ["unlock", "acme"], { tty: true });
  });
  F("unlock (pty): stray entry under the mount point ⇒ 78, gocryptfs never called", async () => {
    const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 0 });
    register(e, "acme");
    const { mnt } = layout(e);
    writeFileSync(join(mnt, "stray"), "");
    await record("fake", "unlock-tty-stray", e, ["unlock", "acme"], { tty: true });
  });
  F(
    "unlock (pty): mount.lock held elsewhere ⇒ 73 after the wait",
    async () => {
      const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 0 });
      register(e, "acme");
      const { dir } = layout(e);
      const holder = spawn("flock", [join(dir, "mount.lock"), "sleep", "30"], { stdio: "ignore", detached: true });
      try {
        await new Promise((r) => setTimeout(r, 300));
        await record("fake", "unlock-tty-lock-busy", e, ["unlock", "acme"], { tty: true });
      } finally {
        try {
          process.kill(-holder.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    },
    60_000,
  );

  F("lock: unmounted / --lazy / not found / legacy", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme");
    layout(e);
    await record("fake", "lock-unmounted", e, ["lock", "acme"]);
    await record("fake", "lock-lazy-unmounted", e, ["lock", "--lazy", "acme"]);
    await record("fake", "lock-not-found", makeEnv({ fakeGocryptfs: true }), ["lock", "acme"]);
    const e2 = makeEnv({ fakeGocryptfs: true });
    register(e2, "acme", { link: "~/secure/acme" });
    legacyLayout(e2);
    await record("fake", "lock-legacy-unmounted", e2, ["lock", "acme"]);
  });

  F("init: non-TTY / existing dir / legacy re-init / bad --path / --fix-settings misuse", async () => {
    await record("fake", "init-non-tty", makeEnv({ fakeGocryptfs: true }), ["init", "acme"]);
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme");
    layout(e);
    await record("fake", "init-exists", e, ["init", "acme"]);
    const e2 = makeEnv({ fakeGocryptfs: true });
    register(e2, "acme");
    const { mnt } = layout(e2);
    writeFileSync(join(mnt, "stray"), "");
    await record("fake", "init-exists-incomplete", e2, ["init", "acme"]);
    const e3 = makeEnv({ fakeGocryptfs: true });
    register(e3, "acme", { link: "~/secure/acme" });
    legacyLayout(e3);
    await record("fake", "init-legacy", e3, ["init", "acme"]);
    await record("fake", "init-fix-settings-legacy", e3, ["init", "acme", "--fix-settings"]);
    await record("fake", "init-bad-path", makeEnv({ fakeGocryptfs: true }), ["init", "acme", "--path", "rel/x"]);
    await record("fake", "init-fix-with-path", makeEnv({ fakeGocryptfs: true }), [
      "init",
      "acme",
      "--fix-settings",
      "--path",
      "~/x",
    ]);
    await record("fake", "init-fix-not-found", makeEnv({ fakeGocryptfs: true }), ["init", "acme", "--fix-settings"]);
    await record("fake", "init-bad-name", makeEnv({ fakeGocryptfs: true }), ["init", "Bad"]);
    const e4 = makeEnv({ fakeGocryptfs: true });
    register(e4, "acme");
    layout(e4);
    await record("fake", "init-fix-settings-non-tty", e4, ["init", "acme", "--fix-settings"]);
  });
  F("init (pty): gocryptfs -init fails ⇒ cleanup hint naming both locations", async () => {
    const e = makeEnv({ fakeGocryptfs: true, initExit: 1 });
    await record("fake", "init-tty-init-fails", e, ["init", "acme"], { tty: true });
  });
  F("init (pty): existing mount point ⇒ 78; non-default missing parent ⇒ 78", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    mkdirSync(join(e.home, "secure", "acme"), { recursive: true, mode: 0o700 });
    chmodSync(join(e.home, "secure"), 0o700);
    await record("fake", "init-tty-mnt-exists", e, ["init", "acme"], { tty: true });
    const e2 = makeEnv({ fakeGocryptfs: true });
    await record("fake", "init-tty-parent-missing", e2, ["init", "acme", "--path", "~/nowhere/acme"], { tty: true });
  });

  F("run: not found / bad name / legacy / enabled=false / pi missing / not a pi package", async () => {
    await record("fake", "run-not-found", makeEnv({ fakeGocryptfs: true }), ["run", "acme"]);
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme", { link: "~/secure/acme" });
    legacyLayout(e);
    await record("fake", "run-legacy", e, ["run", "acme"]);
    const e2 = makeEnv({ fakeGocryptfs: true });
    settings(e2, { secure: { enabled: false, vaults: { acme: {} } } });
    layout(e2);
    await record("fake", "run-enabled-false", e2, ["run", "acme"]);
    const e3 = makeEnv({ fakeGocryptfs: true });
    register(e3, "acme");
    layout(e3);
    rmSync(join(e3.root, "bin", "pi"));
    await record("fake", "run-pi-missing", e3, ["run", "acme"]);
    symlinkSync("/bin/true", join(e3.root, "bin", "pi"));
    await record("fake", "run-pi-not-package", e3, ["run", "acme"]);
  });
  F("run: argument audit refusals (before any mount)", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme");
    layout(e);
    const cases: Array<[string, string[]]> = [
      ["run-refuse-session-dir", ["run", "acme", "--session-dir", "/tmp/x"]],
      ["run-refuse-session-dir-dangling", ["run", "acme", "--session-dir"]],
      ["run-refuse-no-extensions", ["run", "acme", "--no-extensions"]],
      ["run-refuse-export", ["run", "acme", "--export", "out.html"]],
      ["run-refuse-extension", ["run", "acme", "-e", "/x.ts"]],
      ["run-refuse-session-outside", ["run", "acme", "--session", "/tmp/s.jsonl"]],
      ["run-refuse-session-dangling", ["run", "acme", "--session"]],
      ["run-refuse-fork-dangling", ["run", "acme", "--fork"]],
      ["run-C-missing-value", ["run", "acme", "-C"]],
      ["run-C-escape", ["run", "acme", "-C", "../../x"]],
      ["run-C-absolute-outside", ["run", "acme", "-C", "/etc"]],
      ["run-C-then-refused", ["run", "acme", "-C", "sub", "--session-dir", "/x"]],
    ];
    for (const [n, argv] of cases) await record("fake", n, e, argv);
  });
  F("run: accepted argv reaches the mount (non-TTY ⇒ 2), incl. every non-F1b --private spelling", async () => {
    const e = makeEnv({ fakeGocryptfs: true });
    register(e, "acme");
    layout(e);
    const cases: Array<[string, string[]]> = [
      ["run-plain-non-tty", ["run", "acme"]],
      ["run-message-non-tty", ["run", "acme", "hello world"]],
      ["run-C-non-tty", ["run", "acme", "-C", "sub"]],
      ["run-C-dup-non-tty", ["run", "acme", "-C", "a", "-C", "b"]],
      ["run-dashdash-non-tty", ["run", "acme", "--", "--session-dir", "x"]],
      ["run-dashdash-private-non-tty", ["run", "acme", "--", "--private"]],
      ["run-C-private-non-tty", ["run", "acme", "-C", "sub", "--private"]],
      ["run-C-no-private-non-tty", ["run", "acme", "-C", "sub", "--no-private", "msg"]],
      ["run-message-private-non-tty", ["run", "acme", "hello", "--private"]],
      ["run-message-with-private-text", ["run", "acme", "please use --private mode"]],
      ["run-no-session-non-tty", ["run", "acme", "--no-session", "-p", "hi"]],
      ["run-session-inside-non-tty", ["run", "acme", "--session", "~/secure/acme/state/sessions/default/x.jsonl"]],
      ["run-fork-non-tty", ["run", "acme", "--fork", "/tmp/s.jsonl"]],
    ];
    for (const [n, argv] of cases) await record("fake", n, e, argv);
  });
  F("run (pty): 3 wrong passwords ⇒ 77 and pi never starts", async () => {
    const e = makeEnv({ fakeGocryptfs: true, gocryptfsExit: 12 });
    register(e, "acme");
    layout(e);
    await record("fake", "run-tty-bad-password", e, ["run", "acme", "-C", "sub", "--private", "msg"], { tty: true });
  });
});

// ─────────────────────────────── real block ───────────────────────────────

describe.skipIf(!HAVE_REAL)("N0 golden — real gocryptfs (test-side mounts, fake passfile)", () => {
  // N1 review #3: serialize every suite that creates REAL global gocryptfs mounts (see gocryptfs-test-lock.ts).
  let releaseGocryptfsLock: (() => void) | undefined;
  beforeAll(async () => {
    releaseGocryptfsLock = await acquireGocryptfsTestLock();
  }, 250_000);
  afterAll(() => releaseGocryptfsLock?.());
  const mountedAt = (mnt: string) =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((l) => l.split(" ")[4] === mnt && l.includes(" - fuse.gocryptfs "));
  function mountDirect(e: Env, dir: string, mnt: string): void {
    if (mountedAt(mnt)) return;
    const r = spawnSync(
      "gocryptfs",
      ["-q", "-nonempty", "-passfile", join(e.root, "pf"), "--", join(dir, "cipher"), mnt],
      {
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(mountedAt(mnt)).toBe(true);
  }
  function gocryptfsPid(mnt: string): number | undefined {
    const r = spawnSync("pgrep", ["-f", `gocryptfs .*${mnt}`], { encoding: "utf8" });
    const pid = Number(r.stdout.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  }

  it("mounted lifecycle: status / unlock-already / run-already / lock busy / lock / stale", async () => {
    const e = makeEnv({ fakeGocryptfs: false });
    register(e, "acme");
    const { dir, mnt } = layout(e, { realCipher: true });
    mountDirect(e, dir, mnt);
    // First launcher contact with a fresh mount: dirs + project settings get created.
    await record("real", "unlock-already-first", e, ["unlock", "acme"]);
    await record("real", "status-mounted", e, ["status"], { status: true });
    await record("real", "unlock-already-again", e, ["unlock", "acme"]);
    await record("real", "run-already-exit3", e, ["run", "acme", "--no-session", "-p", "hi"], {
      extraEnv: { FAKE_PI_EXIT: "3" },
    });
    rmSync(e.record, { force: true });
    await record("real", "status-after-run", e, ["status", "acme"], { status: true });

    mountDirect(e, dir, mnt);
    mkdirSync(join(mnt, "work", "sub"), { recursive: true });
    await record("real", "run-already-C-sub", e, ["run", "acme", "-C", "sub", "--private", "msg"]);
    rmSync(e.record, { force: true });

    mountDirect(e, dir, mnt);
    // a settings conflict blocks run (78); --fix-settings repairs (already mounted ⇒ no TTY needed)
    writeFileSync(join(mnt, "work", ".pi", "settings.json"), JSON.stringify({ sessionDir: "/elsewhere" }));
    await record("real", "run-settings-conflict", e, ["run", "acme"]);
    await record("real", "init-fix-settings-mounted", e, ["init", "acme", "--fix-settings"]);
    await record("real", "status-mounted-after-fix", e, ["status", "acme"], { status: true });

    // occupant ⇒ lock refuses (76) and lists it; status counts it
    const sleeper = spawn("sleep", ["60"], { cwd: join(mnt, "work"), stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      await record("real", "status-occupied", e, ["status", "acme"], { status: true });
      await record("real", "lock-occupied", e, ["lock", "acme"]);
    } finally {
      try {
        process.kill(-sleeper.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await record("real", "lock-mounted", e, ["lock", "acme"]);
    await record("real", "status-locked-after", e, ["status", "acme"], { status: true });

    // stale: daemon killed ⇒ ENOTCONN
    mountDirect(e, dir, mnt);
    const pid = gocryptfsPid(mnt);
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    await record("real", "status-stale", e, ["status", "acme"], { status: true });
    await record("real", "lock-stale", e, ["lock", "acme"]);
    await record("real", "status-after-stale-lock", e, ["status", "acme"], { status: true });

    // lock --lazy on a mounted, occupied vault
    mountDirect(e, dir, mnt);
    const sleeper2 = spawn("sleep", ["60"], { cwd: join(mnt, "work"), stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      await record("real", "lock-lazy-occupied", e, ["lock", "--lazy", "acme"]);
    } finally {
      try {
        process.kill(-sleeper2.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 120_000);
});
