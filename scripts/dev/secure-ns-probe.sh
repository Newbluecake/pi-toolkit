#!/bin/sh
# secure-ns-probe.sh — conformance probe for `pi-secure run --private` (private-plan r3 §6.3).
#
# Drives the PRODUCTION launcher (src/secure/bin/pi-secure) against a throw-away vault in a
# private mktemp dir (temp HOME, TEST-ONLY fake password via script(1), fake pi), plus a few raw
# unshare/gocryptfs experiments, and prints one line per fact the launcher relies on:
#
#     CHECK <NC id> PASS|FAIL|KNOWN <detail>
#
# ids: NC1 NC2 NC2b NC2c NC3 NC4 NC5 NC6 NC7 NC8 NC9 NC10 NC11 NC12 (NC9 is KNOWN by design:
# same-uid /proc/<pid>/root + setns reach the plaintext). `--fast` skips every online pi item
# (NC10: real pi) ⇒ zero model requests; the full mode runs real pi only in C5 isolation (temp
# HOME, minimal env, no credentials ⇒ "No API key"). Other lines: INFO / SKIP / SUMMARY.
#
# Never touches real vaults or ~/.pi; every step is time-bounded. Every process the probe starts
# carries a random PI_TOOLKIT_TEST_RUN token; cleanup signals only provably-own processes (same
# uid, started after the probe, token in /proc/<pid>/environ, starttime re-verified), merely
# reports anything else that mentions the temp dir, lazily unmounts what is left under it and
# removes it (a SELFTEST line proves an unrelated look-alike process survives).
# Precondition: no concurrent global fuse.gocryptfs mount (run --private refuses then). The
# conformance test holds the gocryptfs test lock every real-mount suite takes; standalone, the
# probe checks at start (SKIP all) and before every launcher session (explicit SKIP <id>).
# Exit: 0 = ran, no FAIL (or SKIP all: prerequisites missing) · 1 = at least one FAIL · 64 = usage.
# Run before any pi peer / gocryptfs / util-linux / kernel / Node upgrade
# (tests/conformance/secure-private-ns.test.ts runs it in full mode).
#
# The pre-implementation research probe this replaces lives in git history (commit ed33894e);
# its results are documented in docs/dev/data-encryption/private-ns-probe.md.
set -u

FAST=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;
    -h | --help)
      sed -n '2,24p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 [--fast]" >&2
      exit 64
      ;;
  esac
done

REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node) || {
  echo "SKIP all node not found"
  exit 0
}
T=$(mktemp -d "${TMPDIR:-/tmp}/secure-ns-probe.XXXXXX") || exit 1
chmod 700 "$T"

cat >"$T/probe.mjs" <<'PROBE_EOF'
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// Ownership token (N4 security review #2): every process this probe starts inherits it (the
// launcher passes it through — piChildEnv/hubSafeEnv only strip PI_SECURE_*; no product code
// reads it). Cleanup and every test-side kill signal a process only if it is provably ours: same
// real uid, started after the probe, token in /proc/<pid>/environ, starttime stable across reads.
const RUN_VAR = "PI_TOOLKIT_TEST_RUN";
const TOKEN = randomBytes(16).toString("hex");
process.env[RUN_VAR] = TOKEN;
const FAST = process.env.PROBE_FAST === "1";
const REPO = process.env.PROBE_REPO;
const T = process.env.PROBE_T;
const BIN = path.join(REPO, "src/secure/bin/pi-secure");
const HELPER = path.join(REPO, "src/secure/bin/helper.mjs");
const PI_PKG = path.join(REPO, "node_modules/@earendil-works/pi-coding-agent");
const PW = "TESTPASS-fake-not-a-secret";
const UID = process.getuid();
const GID = process.getgid();
const IDS = ["NC1", "NC2", "NC2b", "NC2c", "NC3", "NC4", "NC5", "NC6", "NC7", "NC8", "NC9", "NC10", "NC11", "NC12"];

const one = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 700);
const counts = { PASS: 0, FAIL: 0, KNOWN: 0, SKIP: 0 };
const seen = new Set();
const skipped = new Set();
function check(id, st, detail) {
  if (skipped.has(id)) return;
  if (st === true) st = "PASS";
  if (st === false) st = "FAIL";
  counts[st]++;
  seen.add(id);
  console.log(`CHECK ${id} ${st} ${one(detail)}`);
}
const info = (s) => console.log(`INFO ${one(s)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── processes: identity-verified bookkeeping ─────────────
function statFields(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return t.slice(t.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
}
function procStart(pid) {
  const f = statFields(pid);
  return f && f[0] !== "Z" ? Number(f[19]) : undefined;
}
const alive = (id) => id && procStart(id.pid) === id.start;
const RUN_START = procStart(process.pid);
/** `pid`'s identity iff provably ours (see RUN_VAR). */
function owned(pid) {
  const s1 = procStart(pid);
  if (s1 === undefined || !(s1 >= RUN_START)) return undefined;
  try {
    const uid = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    if (Number(uid) !== UID) return undefined;
    if (!fs.readFileSync(`/proc/${pid}/environ`).toString("latin1").split("\0").includes(`${RUN_VAR}=${TOKEN}`)) return undefined;
  } catch {
    return undefined;
  }
  return procStart(pid) === s1 ? { pid, start: s1 } : undefined;
}
const tracked = [];
function track(pid) {
  const start = procStart(pid);
  if (start !== undefined) tracked.push({ pid, start });
  return start === undefined ? undefined : { pid, start };
}
/** Signal `id` only if it is still that process AND provably ours. */
function killVerified(id, sig = "SIGKILL") {
  const o = id && owned(id.pid);
  if (!o || o.start !== id.start) return false;
  try {
    process.kill(id.pid, sig);
    return true;
  } catch {
    return false;
  }
}
const nsOf = (pid) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/mnt`);
  } catch {
    return undefined;
  }
};
const pids = () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
function fdHolders(file) {
  const out = [];
  for (const p of pids()) {
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${p}/fd/${fd}`) === file) {
          out.push(p);
          break;
        }
      } catch {
        /* raced */
      }
    }
  }
  return out;
}
/** /proc/locks entries for `file`'s inode (the pid column is the ORIGINAL locker, so match by inode). */
function lockEntries(file) {
  const ino = fs.statSync(file).ino;
  return fs
    .readFileSync("/proc/locks", "utf8")
    .split("\n")
    .filter((l) => /\bFLOCK\b/.test(l) && l.split(/\s+/).some((f) => /^[0-9a-f]+:[0-9a-f]+:\d+$/.test(f) && Number(f.split(":")[2]) === ino));
}
const leaseFree = (lease) => sh("flock", ["-n", lease, "true"]).status === 0;
const globalMounted = (mp) => fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((l) => l.split(" ")[4] === mp);
function mountSource(mountinfo, mp) {
  for (const l of mountinfo.split("\n")) {
    const f = l.split(" ");
    if (f[4] !== mp) continue;
    const tail = l.slice(l.indexOf(" - ") + 3).split(" ");
    return { fstype: tail[0], source: tail[1] };
  }
  return undefined;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", ...opts });
  return { status: r.status, signal: r.signal, out: r.stdout ?? "", err: r.stderr ?? "", text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (pred()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// ───────────── fixture: temp HOME, new-layout vaults, fake pi ─────────────
const H = path.join(T, "home");
const DATA = path.join(H, ".local/share/pi-toolkit-secure");
const PF = path.join(T, "pf");
function makeVault(name) {
  const dir = path.join(DATA, name);
  const mnt = path.join(H, "secure", name);
  fs.mkdirSync(path.join(dir, "cipher"), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(mnt, { recursive: true, mode: 0o700 });
  for (const n of ["work", "state"]) {
    fs.writeFileSync(path.join(mnt, n), "");
    fs.chmodSync(path.join(mnt, n), 0o400);
  }
  const r = sh("gocryptfs", ["-init", "-q", "-scryptn", "10", "-passfile", PF, "--", path.join(dir, "cipher")]);
  if (r.status !== 0) throw new Error(`gocryptfs -init ${name}: ${r.text}`);
  for (const f of ["mount.lock", "mount.lease"]) fs.writeFileSync(path.join(dir, f), "", { mode: 0o600 });
  return { name, dir, mnt, cipher: path.join(dir, "cipher"), lease: path.join(dir, "mount.lease"), rec: path.join(dir, "private.json") };
}

const FAKE_PI = `#!/usr/bin/env node
import fs from "node:fs"; import { spawnSync } from "node:child_process";
const E = process.env, C = E.PROBE_CTL;
const st = fs.readFileSync("/proc/self/status", "utf8");
const sf = (() => { const t = fs.readFileSync("/proc/self/stat", "utf8"); return t.slice(t.lastIndexOf(")") + 2).split(" "); })();
const rl = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
const flags = (fd) => { try { return /flags:\\s+(\\d+)/.exec(fs.readFileSync("/proc/self/fdinfo/" + fd, "utf8"))[1]; } catch { return null; } };
const f = { pid: process.pid, uid: process.getuid(), gid: process.getgid(), cap: /CapEff:\\s+(\\S+)/.exec(st)[1],
  ns: rl("/proc/self/ns/mnt"), fd9: rl("/proc/self/fd/9"), fd9flags: flags(9), pgid: Number(sf[2]), sid: Number(sf[3]), cwd: process.cwd(), kids: {} };
if (E.PROBE_CANARY) fs.writeFileSync("data.txt", E.PROBE_CANARY);
if (E.PROBE_NC12) {
  // NC12: which children see fd 9 (each writes "<link|none> <flags|none>" into C/nc12-<name>)
  const probe = (name) => "readlink /proc/self/fd/9 >" + C + "/nc12-" + name + " 2>/dev/null || echo none >" + C + "/nc12-" + name + "; awk '/^flags/{print $2}' /proc/self/fdinfo/9 >>" + C + "/nc12-" + name + " 2>/dev/null";
  const run = (name, opts) => spawnSync("sh", ["-c", probe(name)], { timeout: 5000, ...opts });
  run("inherit", { stdio: "inherit" });
  run("detached", { stdio: "inherit", detached: true });
  run("bashtool", { stdio: ["ignore", "pipe", "pipe"], detached: true });
  run("slot9", { stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] });
  spawnSync(process.execPath, ["-e", "require('child_process').spawnSync('sh',['-c',process.argv[1]],{stdio:'inherit',timeout:5000})", probe("nested")], { stdio: "inherit", timeout: 8000 });
}
if (E.PROBE_INNER) {
  const um = spawnSync("umount", [E.PROBE_INNER_MNT], { encoding: "utf8", timeout: 5000 });
  f.umount = { code: um.status, err: (um.stderr || "").trim() };
  const ns = spawnSync("nsenter", ["--mount=/proc/" + E.PROBE_HOSTPID + "/ns/mnt", "true"], { encoding: "utf8", timeout: 5000 });
  f.setns = { code: ns.status, err: (ns.stderr || "").trim() };
}
if (E.PROBE_PI_SIGINT_DELAY) process.on("SIGINT", () => { fs.writeFileSync(C + "/sigint", String(Date.now())); setTimeout(() => process.exit(130), Number(E.PROBE_PI_SIGINT_DELAY)); });
fs.writeFileSync(C + "/facts.json", JSON.stringify(f));
const done = new Set();
setInterval(() => {
  if (fs.existsSync(C + "/exit")) process.exit(Number(fs.readFileSync(C + "/exit", "utf8") || 0));
  for (let n = 1; n <= 9; n++) {
    if (done.has(n) || !fs.existsSync(C + "/cmd." + n)) continue;
    done.add(n);
    const r = spawnSync("sh", ["-c", fs.readFileSync(C + "/cmd." + n, "utf8")], { encoding: "utf8", timeout: 10000 });
    fs.writeFileSync(C + "/cmd." + n + ".out", JSON.stringify({ code: r.status, out: r.stdout, err: r.stderr }));
  }
}, 100);
setTimeout(() => process.exit(0), Number(E.PROBE_PI_MAX || 120000));
`;

function setup() {
  fs.mkdirSync(H, { mode: 0o700 });
  fs.mkdirSync(path.join(T, "tmp"), { mode: 0o700 });
  fs.writeFileSync(PF, `${PW}\n`, { mode: 0o600 });
  const pkg = path.join(T, "fakepi");
  fs.mkdirSync(path.join(pkg, "dist/cli"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  fs.writeFileSync(path.join(pkg, "dist/cli/args.js"), `export * from ${JSON.stringify("file://" + path.join(PI_PKG, "dist/cli/args.js"))};\n`);
  fs.writeFileSync(path.join(pkg, "dist/cli.js"), FAKE_PI, { mode: 0o755 });
  for (const [d, pi] of [
    ["bin", path.join(pkg, "dist/cli.js")],
    ["realbin", path.join(PI_PKG, "dist/cli.js")],
  ]) {
    fs.mkdirSync(path.join(T, d));
    fs.symlinkSync(pi, path.join(T, d, "pi"));
    fs.symlinkSync(process.execPath, path.join(T, d, "node"));
  }
  fs.mkdirSync(path.join(H, "secure"), { mode: 0o700 });
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const v = { acme: makeVault("acme"), other: makeVault("other") };
  fs.mkdirSync(path.join(H, ".pi/agent"), { recursive: true });
  fs.writeFileSync(path.join(H, ".pi/agent/pi-subagent.json"), JSON.stringify({ secure: { vaults: { acme: {}, other: {} } } }));
  return v;
}
const baseEnv = (bin = "bin") => ({
  PATH: `${path.join(T, bin)}:/usr/bin:/bin`,
  HOME: H,
  LANG: "C.UTF-8",
  TERM: "xterm",
  TMPDIR: path.join(T, "tmp"),
  [RUN_VAR]: TOKEN,
});

/** Launcher through script(1); types PW at every prompt. `.send(s)` writes to the pty. */
function tty(args, env, killAfterMs = 90_000) {
  const t0 = Date.now();
  const c = spawn("script", ["-qefc", `${BIN} ${args}`, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const leader = track(c.pid);
  let reaped = false;
  c.on("exit", () => (reaped = true)); // from here on the pid may be recycled: never signal it
  let text = "";
  const p = new Promise((res) => {
    let typed = 0;
    const on = (b) => {
      text += b.toString();
      const prompts = text.split(/Password:|Repeat:/).length - 1;
      while (typed < prompts) {
        typed++;
        try {
          c.stdin.write(`${PW}\r`);
        } catch {
          /* closed */
        }
      }
    };
    c.stdout.on("data", on);
    c.stderr.on("data", on);
    const k = setTimeout(() => {
      // still that script(1) leader (pid+starttime, pgid == pid)?
      if (reaped || !leader || procStart(c.pid) !== leader.start || Number(statFields(c.pid)?.[2]) !== c.pid) return;
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, killAfterMs);
    c.on("close", (code) => {
      clearTimeout(k);
      res({ code, text: text.replace(/\r/g, ""), ms: Date.now() - t0 });
    });
  });
  p.send = (s) => c.stdin.write(s);
  p.text = () => text;
  return p;
}
const plain = (args, env) => sh("sh", ["-c", `exec ${BIN} ${args} </dev/null`], { env, timeout: 40_000 });
const recordOf = (v) => JSON.parse(fs.readFileSync(v.rec, "utf8"));
const untilPhase = (v, phase, ms = 30_000) => until(() => recordOf(v).phase === phase, ms, `phase ${phase}`);
function ctlDir(name) {
  const d = path.join(T, `ctl-${name}`);
  fs.mkdirSync(d, { mode: 0o700 });
  return d;
}
const facts = (ctl) => JSON.parse(fs.readFileSync(path.join(ctl, "facts.json"), "utf8"));
async function insideCmd(ctl, n, cmd) {
  fs.writeFileSync(path.join(ctl, `cmd.${n}`), cmd);
  await until(() => fs.existsSync(path.join(ctl, `cmd.${n}.out`)), 15_000, `inside cmd ${n}`);
  await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(ctl, `cmd.${n}.out`), "utf8"));
}
const endPi = (ctl, code = 0) => fs.writeFileSync(path.join(ctl, "exit"), String(code));
const membersOf = (ns) => pids().filter((p) => p !== process.pid && nsOf(p) === ns);
function trackRecord(v) {
  try {
    const r = recordOf(v);
    for (const k of ["owner", "supervisor", "gocryptfs", "pi"]) if (r[k] && alive(r[k])) tracked.push(r[k]);
  } catch {
    /* no record */
  }
}

// ───────────── cleanup (identity re-verified before every signal) ─────────────
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const id of tracked) killVerified(id);
  // never our own ancestors (the `timeout` wrapper's cmdline also names $T/probe.mjs)
  const mine = new Set();
  for (let p = process.pid; p > 1 && !mine.has(p); p = Number(statFields(p)?.[1] ?? 0)) mine.add(p);
  for (const p of pids()) {
    if (mine.has(p)) continue;
    const id = owned(p);
    if (id) {
      killVerified(id);
      continue;
    }
    let hit = false;
    try {
      hit = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes(T + "/");
    } catch {
      /* gone */
    }
    try {
      hit ||= fs.readlinkSync(`/proc/${p}/cwd`).startsWith(T + "/");
    } catch {
      /* other ns / gone */
    }
    if (hit && procStart(p) !== undefined) console.log(`INFO cleanup: pid ${p} mentions ${T} but is not provably ours — not signalled`);
  }
  for (const l of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const mp = l.split(" ")[4];
    if (mp && mp.startsWith(T + "/")) sh("fusermount3", ["-uz", mp], { timeout: 5_000 });
  }
}
process.on("SIGTERM", () => {
  cleanup();
  process.exit(1);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});
setTimeout(() => {
  console.log("INFO probe hard deadline (360 s) reached — aborting");
  cleanup();
  process.exit(1);
}, 360_000).unref();

// ───────────── checks ─────────────
/**
 * Precondition: no foreign global fuse.gocryptfs mount while the probe runs (run --private
 * correctly refuses then). tests/conformance/secure-private-ns.test.ts guarantees it by holding
 * the gocryptfs test lock that every real-mount suite takes; a standalone run checks it at start
 * (SKIP all) and again before every launcher session (explicit SKIP, never a misleading FAIL).
 */
const foreignMounts = () =>
  fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .filter((l) => l.includes(" - fuse.gocryptfs ") && !l.split(" ")[4].startsWith(T + "/"))
    .map((l) => l.split(" ")[4]);
function guard(ids) {
  const f = foreignMounts();
  if (!f.length) return true;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    skipped.add(id);
    counts.SKIP++;
    console.log(`SKIP ${id} a foreign global fuse.gocryptfs mount appeared mid-run (${f.join(", ")}): run --private would correctly refuse — the probe needs the gocryptfs test lock / no concurrent global mounts`);
  }
  return false;
}
async function step(id, fn) {
  try {
    await fn();
  } catch (e) {
    check(id, false, `error: ${e && e.message}`);
  }
}

async function main() {
  const miss = ["gocryptfs", "fusermount3", "flock", "script", "unshare", "umount", "nsenter", "timeout"].filter(
    (b) => sh("sh", ["-c", `command -v ${b}`]).status !== 0,
  );
  if (process.platform !== "linux" || miss.length || sh("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status !== 0) {
    console.log(`SKIP all prerequisites missing: ${process.platform !== "linux" ? "not linux " : ""}${miss.join(" ")} (or /dev/fuse unusable)`);
    return 0;
  }
  if (!fs.existsSync(path.join(PI_PKG, "dist/cli/args.js"))) {
    console.log("SKIP all repo devDependency @earendil-works/pi-coding-agent missing (npm install)");
    return 0;
  }
  info(`kernel ${sh("uname", ["-r"]).out.trim()} · ${sh("unshare", ["--version"]).out.trim()} · ${sh("gocryptfs", ["-version"]).out.split(";")[0].trim()} · node ${process.version} · pi ${JSON.parse(fs.readFileSync(path.join(PI_PKG, "package.json"), "utf8")).version} · mode ${FAST ? "fast" : "full"}`);
  const foreign = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((l) => l.includes(" - fuse.gocryptfs "));
  if (foreign.length) {
    console.log(`SKIP all a global fuse.gocryptfs mount exists (${foreign.length}); run --private refuses then — lock it first`);
    return 0;
  }
  const V = setup();
  const acme = V.acme;
  const env = baseEnv();

  await step("NC1", () => {
    const help = sh("unshare", ["--help"]).text;
    const flags = ["--user", "--map-root-user", "--map-user", "--map-group", "--mount", "--propagation"].filter((f) => !help.includes(f));
    const d = path.join(T, "nc1");
    fs.mkdirSync(d);
    const m = sh("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "sh", "-c", 'mount -t tmpfs -o size=4k nc1 "$1" && grep -q " $1 " /proc/self/mountinfo && echo inside-ok', "sh", d]);
    const leaked = globalMounted(d);
    check("NC1", !flags.length && m.out.includes("inside-ok") && !leaked, `unshare flags ${flags.length ? "MISSING " + flags.join(",") : "all present"}; userns tmpfs mount ${m.out.includes("inside-ok") ? "ok" : "FAILED " + m.text}; visible outside: ${leaked}`);
  });

  await step("NC11", () => {
    const codes = {};
    codes.version = sh("gocryptfs", ["-version"]).status;
    codes.badflag = sh("gocryptfs", ["-definitely-not-a-flag"]).status;
    const wrong = path.join(T, "wrongpw");
    fs.writeFileSync(wrong, "wrong-password\n", { mode: 0o600 });
    const nm = path.join(T, "nc11-mnt");
    fs.mkdirSync(nm);
    codes.wrongPassword = sh("gocryptfs", ["-q", "-passfile", wrong, "--", acme.cipher, nm]).status;
    codes.noCipherdir = sh("gocryptfs", ["-q", "-passfile", PF, "--", path.join(T, "nope"), nm]).status;
    codes.nonEmptyMnt = sh("gocryptfs", ["-q", "-passfile", PF, "--", acme.cipher, acme.mnt]).status;
    codes.noMountpoint = sh("gocryptfs", ["-q", "-passfile", PF, "--", acme.cipher, path.join(T, "nope-mnt")]).status;
    const busy = Number(/export const LEASE_BUSY_CODE = (\d+)/.exec(fs.readFileSync(HELPER, "utf8"))?.[1]);
    const vals = Object.values(codes);
    check("NC11", busy === 213 && !vals.includes(busy) && vals.every((c) => c !== null && c < 200), `launcher lease-busy code ${busy}; observed gocryptfs exit codes ${JSON.stringify(codes)} (upstream 1.8 exitcodes are all < 30)`);
  });

  await step("NC5", async () => {
    // (b) Q10's basis: another vault's GLOBAL mount is copied into a fresh mount namespace
    const o = V.other;
    const g = sh("gocryptfs", ["-q", "-nonempty", "-passfile", PF, "--", o.cipher, o.mnt]);
    if (g.status !== 0) throw new Error(`global mount of other: ${g.text}`);
    let copied;
    try {
      const mi = sh("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "cat", "/proc/self/mountinfo"]).out;
      copied = mountSource(mi, o.mnt);
    } finally {
      sh("fusermount3", ["-u", o.mnt]);
    }
    NC5b = copied?.source === o.cipher ? `other vault's global mount copied into a new ns (${copied.fstype})` : `NOT copied (${JSON.stringify(copied)})`;
    NC5bOk = copied?.source === o.cipher;
  });

  await step("NC6", () => {
    // raw ns sequence (what finalize does): umount -n with a cwd holder ⇒ EBUSY; without ⇒ ok; -l with holder ⇒ ok
    const raw = path.join(T, "raw");
    fs.mkdirSync(path.join(raw, "c"), { recursive: true });
    fs.mkdirSync(path.join(raw, "m"));
    sh("gocryptfs", ["-init", "-q", "-scryptn", "10", "-passfile", PF, "--", path.join(raw, "c")]);
    const script = [
      'gocryptfs -q -passfile "$1" -- "$2" "$3" || exit 90',
      '(cd "$3" && exec sleep 20) & H=$!; sleep 0.3',
      'umount -n "$3" 2>/dev/null; echo "busy=$?"',
      'kill $H; wait $H 2>/dev/null',
      'umount -n "$3"; echo "plain=$?"',
      'gocryptfs -q -passfile "$1" -- "$2" "$3" || exit 91',
      '(cd "$3" && exec sleep 20) & H=$!; sleep 0.3',
      'umount -l -n "$3"; echo "lazy=$?"',
      'grep -q " $3 " /proc/self/mountinfo && echo still-listed || echo detached',
      'kill $H; wait $H 2>/dev/null',
      "true",
    ].join("\n");
    const r = sh("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "sh", "-c", script, "sh", PF, path.join(raw, "c"), path.join(raw, "m")], { timeout: 30_000 });
    const busy = /busy=(\d+)/.exec(r.out)?.[1];
    NC6raw = { ok: busy !== undefined && busy !== "0" && /plain=0/.test(r.out) && /lazy=0/.test(r.out) && /detached/.test(r.out), detail: `raw ns: umount -n with cwd holder exit ${busy} (EBUSY), ${/plain=0/.test(r.out) ? "plain ok" : "plain FAILED"}, ${/lazy=0/.test(r.out) && /detached/.test(r.out) ? "-l ok" : "-l FAILED"}${r.status !== 0 ? " sh exit " + r.status + " " + r.err : ""}` };
  });

  // ── session A: the production chain, inner facts, outside view, NC12 ──
  const canary = `nc4-canary-${process.pid}-${Date.now()}`;
  const ctlA = ctlDir("a");
  const goA = guard(["NC2", "NC3", "NC4", "NC5", "NC9", "NC12", "NC6"]);
  const runA = !goA ? undefined : tty("run acme --private -- probe", {
    ...env,
    PROBE_CTL: ctlA,
    PROBE_CANARY: canary,
    PROBE_NC12: "1",
    PROBE_INNER: "1",
    PROBE_INNER_MNT: acme.mnt,
    PROBE_HOSTPID: String(process.pid),
  });
  let recA;
  if (goA) try {
    await untilPhase(acme, "session");
    trackRecord(acme);
    recA = recordOf(acme);
    await until(() => fs.existsSync(path.join(ctlA, "facts.json")), 15_000, "fake pi facts");
  } catch (e) {
    for (const id of ["NC2", "NC3", "NC4", "NC5", "NC9", "NC12", "NC6"]) check(id, false, `session A did not start: ${e.message}; launcher said: ${runA.text().slice(-400)}`);
    recA = undefined;
  }
  if (recA) {
    const fA = facts(ctlA);
    const g = recA.gocryptfs;
    const gf = statFields(g.pid);
    NC2a = {
      ok: alive(g) && nsOf(g.pid) === nsOf(recA.supervisor.pid) && Number(gf[3]) === g.pid && fs.readlinkSync(`/proc/${g.pid}/fd/9`) === acme.lease && /Password:/.test(runA.text()),
      detail: `TTY password accepted after setsid; phase session (P1 got the notifypid SIGUSR1); gocryptfs ns==P1 ns ${nsOf(g.pid) === nsOf(recA.supervisor.pid)}; sid==pid ${Number(gf[3]) === g.pid}; /proc/<g>/fd/9 ${fs.readlinkSync(`/proc/${g.pid}/fd/9`) === acme.lease ? "= lease" : "≠ lease"}`,
    };
    await step("NC3", () => {
      const ok = fA.uid === UID && fA.gid === GID && fA.cap === "0000000000000000" && fA.umount.code !== 0 && fA.setns.code !== 0;
      check("NC3", ok, `inner uid ${fA.uid}/gid ${fA.gid} (real ${UID}/${GID}); CapEff ${fA.cap}; umount vault exit ${fA.umount.code} "${fA.umount.err}"; setns back to the host ns exit ${fA.setns.code} "${fA.setns.err}"`);
    });
    await step("NC4", () => {
      const sent = ["work", "state"].map((n) => fs.statSync(path.join(acme.mnt, n))).every((s) => s.isFile() && s.size === 0 && (s.mode & 0o777) === 0o400);
      const listed = fs.readdirSync(acme.mnt).sort().join(",");
      const grep = sh("grep", ["-rFal", canary, acme.dir, acme.mnt, H]);
      const ok = sent && listed === "state,work" && !globalMounted(acme.mnt) && grep.status === 1;
      check("NC4", ok, `sentinels intact ${sent} (${listed}); global mountinfo entry ${globalMounted(acme.mnt)}; grep -r for the canary outside: ${grep.status === 1 ? "no match" : "MATCH " + grep.out}`);
    });
    await step("NC5", () => {
      const src = mountSource(fs.readFileSync(`/proc/${fA.pid}/mountinfo`, "utf8"), recA.realMnt);
      const ok = src?.source === recA.realCipher && NC5bOk;
      check("NC5", ok, `outside read of /proc/<pi>/mountinfo: ${src ? `${src.fstype} source==realCipher ${src.source === recA.realCipher}` : "NO ENTRY"}; ${NC5b}`);
    });
    await step("NC9", () => {
      let viaRoot;
      try {
        viaRoot = fs.readFileSync(`/proc/${fA.pid}/root${recA.realMnt}/work/data.txt`, "utf8") === canary ? "plaintext READ" : "read, content differs";
      } catch (e) {
        viaRoot = `not readable (${e.code})`;
      }
      const ns = sh("nsenter", ["-t", String(recA.supervisor.pid), "-U", "-m", "--preserve-credentials", "cat", `${recA.realMnt}/work/data.txt`]);
      const viaNs = ns.status === 0 && ns.out === canary ? "plaintext READ" : `failed (${ns.status} ${ns.err.trim()})`;
      check("NC9", "KNOWN", `same-uid /proc/<pi>/root: ${viaRoot}; setns PoC (nsenter -U -m into the session): ${viaNs} — accepted residual (same uid is not a boundary)`);
    });
    await step("NC12", () => {
      const r = (n) => {
        try {
          return fs.readFileSync(path.join(ctlA, `nc12-${n}`), "utf8").trim().split(/\s+/);
        } catch {
          return ["missing"];
        }
      };
      const cloexec = (fl) => fl !== null && fl !== undefined && (parseInt(fl, 8) & 0o2000000) !== 0;
      const none = ["inherit", "detached", "nested", "bashtool"].filter((n) => r(n)[0] !== "none");
      const s9 = r("slot9");
      const bashSrc = fs.readFileSync(path.join(REPO, "src/bash/process.ts"), "utf8");
      const bashStdio = bashSrc.includes('stdio: ["ignore", "pipe", "pipe"]');
      const ok = fA.fd9 === acme.lease && cloexec(fA.fd9flags) && !none.length && s9[0] === acme.lease && !cloexec(s9[1]) && bashStdio;
      check("NC12", ok, `pi (Node) inherited fd 9 = lease ${fA.fd9 === acme.lease}, flags ${fA.fd9flags} CLOEXEC ${cloexec(fA.fd9flags)}; children without fd 9: inherit/detached/nested-node/bash-tool-stdio ${none.length ? "LEAK " + none.join(",") : "all"}; explicit slot 9: ${s9.join(" ")} (no CLOEXEC ${!cloexec(s9[1])}); src/bash/process.ts stdio ["ignore","pipe","pipe"] ${bashStdio}`);
    });
    endPi(ctlA, 0);
    const rA = await runA;
    await step("NC6", async () => {
      await until(() => !membersOf(recA.ns.mnt).length, 5_000, "ns members gone");
      const prod = rA.code === 0 && !fs.existsSync(acme.rec) && leaseFree(acme.lease) && !lockEntries(acme.lease).length;
      NC6prod = `production end: exit ${rA.code}, ns destroyed (0 members), record ${fs.existsSync(acme.rec) ? "LEFT" : "removed"}, lease ${leaseFree(acme.lease) ? "free" : "HELD"}`;
      check("NC6", Boolean(prod && NC6raw?.ok), `${NC6raw?.detail ?? "raw sequence not run"}; ${NC6prod}; remount: see NC7 (next session)`);
    });
  }

  // ── session B: NC7 external TERM to gocryptfs while pi's cwd occupies the mount (also: remount ok) ──
  if (guard(["NC7"])) await step("NC7", async () => {
    const ctl = ctlDir("b");
    const run = tty("run acme --private -- probe", { ...env, PROBE_CTL: ctl, PROBE_CANARY: "nc7" });
    await untilPhase(acme, "session");
    trackRecord(acme);
    const rec = recordOf(acme);
    await until(() => fs.existsSync(path.join(ctl, "facts.json")), 15_000, "facts");
    killVerified(rec.gocryptfs, "SIGTERM");
    await sleep(2_500);
    const gAlive = alive(rec.gocryptfs);
    const rd = await insideCmd(ctl, 1, "cat data.txt");
    const mi = mountSource(fs.readFileSync(`/proc/${rec.pi.pid}/mountinfo`, "utf8"), rec.realMnt);
    endPi(ctl, 0);
    const r = await run;
    await sleep(200);
    const clean = !fs.existsSync(acme.rec) && leaseFree(acme.lease) && !alive(rec.gocryptfs);
    check("NC7", clean, `remount after the previous session ok; external TERM with pi's cwd inside: gocryptfs ${gAlive ? "kept running" : "exited"} after 2.5 s; in-ns read ${rd.code === 0 ? "ok" : `failed (${rd.err.trim()})`}; mount entry in ns ${mi ? "present" : "gone"}; session end exit ${r.code}${/收尾未完成|外部收尾/.test(r.text) ? " (outer cleanup)" : ""}; final state ${clean ? "clean" : "NOT clean"}`);
  });

  // ── session C: NC2 kill part + NC8 orphan ──
  if (guard(["NC8", "NC2"])) await step("NC8", async () => {
    const ctl = ctlDir("c");
    const run = tty("run acme --private -- probe", { ...env, PROBE_CTL: ctl });
    await untilPhase(acme, "session");
    trackRecord(acme);
    const rec = recordOf(acme);
    for (const k of ["owner", "supervisor", "pi"]) killVerified(rec[k]);
    await until(() => !alive(rec.owner) && !alive(rec.supervisor) && !alive(rec.pi), 5_000, "P0/P1/pi gone");
    const chain = pids().filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes(acme.lease) && !String(fs.readFileSync(`/proc/${p}/comm`, "utf8")).startsWith("gocryptfs");
      } catch {
        return false;
      }
    });
    const holders = fdHolders(acme.lease);
    const onlyG = holders.includes(rec.gocryptfs.pid) && holders.every((p) => p === rec.gocryptfs.pid || Number(statFields(p)?.[1]) === rec.gocryptfs.pid);
    const entry = lockEntries(acme.lease).length;
    const busy = !leaseFree(acme.lease);
    const setsid = Number(statFields(rec.gocryptfs.pid)?.[3]) === rec.gocryptfs.pid;
    NC2b_kill = { ok: !chain.length && onlyG && entry > 0 && busy, detail: `after SIGKILL P0+P1(+pi), shell chain alive: ${chain.length}; lease holders ${JSON.stringify(holders)} = gocryptfs${holders.length > 1 ? " + its own children" : ""} ${onlyG}; /proc/locks entry ${entry > 0}; flock -n refused ${busy}` };
    // kill every process in the recorded ns (by ns id), then the lease must be free and the entry gone
    for (const p of membersOf(rec.ns.mnt)) killVerified({ pid: p, start: procStart(p) });
    await until(() => !membersOf(rec.ns.mnt).length, 5_000, "ns emptied");
    await until(() => leaseFree(acme.lease), 5_000, "lease free");
    const gone = !lockEntries(acme.lease).length;
    NC2b_kill.detail += `; after gocryptfs exited: /proc/locks entry ${gone ? "gone" : "STILL THERE"}`;
    NC2b_kill.ok &&= gone;
    const l = plain("lock acme", env);
    check("NC8", alive(rec.gocryptfs) === false && setsid && busy && l.status === 0, `orphan gocryptfs (setsid ${setsid}) held the lease after its supervisor died (${busy}); killing the ns members by ns id destroyed the ns and freed the lease; lock afterwards exit ${l.status} (stale record cleaned)`);
    await run;
  });
  if (NC2a || NC2b_kill) check("NC2", Boolean(NC2a?.ok && NC2b_kill?.ok), `${NC2a?.detail ?? "session A missing"}; ${NC2b_kill?.detail ?? "kill part missing"}`);

  // ── session D: NC2b Ctrl-C on the TTY ──
  if (guard(["NC2b"])) await step("NC2b", async () => {
    const ctl = ctlDir("d");
    // pi handles Ctrl-C itself and leaves 1.5 s later (like a real pi -p): gocryptfs is judged while pi still runs
    const run = tty("run acme --private -- probe", { ...env, PROBE_CTL: ctl, PROBE_PI_MAX: "60000", PROBE_PI_SIGINT_DELAY: "1500" });
    await untilPhase(acme, "session");
    trackRecord(acme);
    const rec = recordOf(acme);
    await until(() => fs.existsSync(path.join(ctl, "facts.json")), 15_000, "facts");
    run.send("\x03");
    await until(() => fs.existsSync(path.join(ctl, "sigint")), 5_000, "pi saw SIGINT");
    await sleep(500);
    const gAfter = alive(rec.gocryptfs);
    const piAfter = alive(rec.pi);
    const p1After = alive(rec.supervisor) && alive(rec.owner);
    const r = await run;
    await sleep(200);
    const clean = !fs.existsSync(acme.rec) && leaseFree(acme.lease) && !alive(rec.gocryptfs);
    check("NC2b", gAfter && p1After && clean, `Ctrl-C: gocryptfs (setsid) ${gAfter ? "unaffected" : "KILLED"}, P0/P1 ${p1After ? "unaffected" : "GONE"}, pi got SIGINT and was ${piAfter ? "still running" : "already gone"} 0.5 s later; launcher exit ${r.code}${/收尾未完成|外部收尾/.test(r.text) ? " via outer cleanup" : " via normal finalize"}; final state ${clean ? "clean" : "NOT clean"} (real-pi Ctrl-C behaviour is pi's own; fake pi used so --fast stays offline)`);
  });

  // ── NC2c: ordinary mode daemon holds the lease after the shell chain and the mount parent exit ──
  if (guard(["NC2c"])) await step("NC2c", async () => {
    const r = await tty("unlock acme", env);
    if (r.code !== 0) throw new Error(`unlock exit ${r.code}: ${r.text.slice(-300)}`);
    const daemons = pids().filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/comm`, "utf8").trim() === "gocryptfs" && fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes(acme.cipher);
      } catch {
        return false;
      }
    });
    daemons.forEach((p) => track(p));
    const d = daemons[0];
    const holds = d !== undefined && fdHolders(acme.lease).includes(d);
    const parent = d !== undefined ? Number(statFields(d)?.[1]) : undefined;
    const parentIsChain = parent !== undefined && (() => {
      try {
        return fs.readFileSync(`/proc/${parent}/cmdline`, "utf8").includes(acme.lease);
      } catch {
        return false;
      }
    })();
    const entry = lockEntries(acme.lease).length > 0;
    const l = plain("lock acme", env);
    await sleep(200);
    const gone = !lockEntries(acme.lease).length && leaseFree(acme.lease);
    check("NC2c", daemons.length === 1 && holds && !parentIsChain && entry && l.status === 0 && gone, `unlock exit 0; daemon pid ${d} (ppid ${parent}, not the shell chain ${!parentIsChain}) holds the lease fd ${holds}; /proc/locks entry ${entry}; lock exit ${l.status}; entry gone + lease free after unmount ${gone}`);
  });

  // ── NC10: real pi inside the session (C5 isolation) ──
  if (FAST) {
    counts.SKIP++;
    console.log("SKIP NC10 --fast: real-pi items not run (zero model requests)");
    seen.add("NC10");
  } else {
    if (guard(["NC10"])) await step("NC10", async () => {
      const renv = { ...baseEnv("realbin"), PI_CODING_AGENT_DIR: path.join(T, "agent"), PI_OFFLINE: "1" };
      fs.mkdirSync(renv.PI_CODING_AGENT_DIR, { mode: 0o700 });
      const v = await tty("run acme --private --version", renv, 45_000);
      // the launcher refuses --no-extensions (the guards need the toolkit extension); the temp HOME
      // has no pi packages installed, so `-p` runs extension-free anyway
      const p = await tty("run acme --private -p hi", renv, 60_000);
      const vOk = v.code === 0 && /\d+\.\d+\.\d+/.test(v.text);
      const pOk = /No API key|No models available/i.test(p.text);
      const clean = !fs.existsSync(acme.rec) && leaseFree(acme.lease);
      check("NC10", vOk && pOk && clean, `real pi --version in the session: exit ${v.code} ${vOk ? "ok" : v.text.slice(-200)}; pi -p (temp HOME without packages, minimal env, no credentials): exit ${p.code} ${pOk ? '"No API key" (zero model requests)' : "UNEXPECTED " + p.text.slice(-300)}; finalize clean ${clean}`);
    });
  }

  for (const id of IDS) if (!seen.has(id)) check(id, false, "not reached (an earlier step failed)");
  return counts.FAIL ? 1 : 0;
}

let NC2a, NC2b_kill, NC5b = "copy check not run", NC5bOk = false, NC6raw, NC6prod;
let rc = 1;
try {
  rc = await main();
} catch (e) {
  console.log(`INFO probe error: ${e && e.stack}`);
  rc = 1;
} finally {
  // self-test (review N4 #2): an unrelated process whose argv AND cwd mention $T but which does not
  // carry the token must survive cleanup
  let decoy;
  try {
    const env = { ...process.env };
    delete env[RUN_VAR];
    decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", path.join(T, "decoy-marker")], { cwd: T, env, stdio: "ignore" });
    await sleep(150);
  } catch {
    decoy = undefined;
  }
  const decoyId = decoy?.pid !== undefined ? { pid: decoy.pid, start: procStart(decoy.pid) } : undefined;
  cleanup();
  if (decoyId?.start !== undefined) {
    const ok = alive(decoyId);
    console.log(`SELFTEST cleanup-decoy ${ok ? "PASS" : "FAIL"} unrelated process (argv + cwd in the temp dir, no token) ${ok ? "survived" : "was KILLED by"} cleanup`);
    if (!ok) rc = 1;
    if (alive(decoyId)) decoy.kill("SIGKILL"); // our own direct child, identity just re-verified
  }
}
console.log(`SUMMARY pass=${counts.PASS} fail=${counts.FAIL} known=${counts.KNOWN} skip=${counts.SKIP}`);
process.exit(rc);
PROBE_EOF

PROBE_FAST=$FAST PROBE_REPO=$REPO PROBE_T=$T timeout -k 5 380 "$NODE" "$T/probe.mjs"
rc=$?
# safety net if node itself was killed: lazily unmount anything left under $T, then remove it
awk -v t="$T/" 'index($5, t) == 1 { print $5 }' /proc/self/mountinfo | while read -r mp; do fusermount3 -uz "$mp" 2>/dev/null; done
chmod -R u+rwx "$T" 2>/dev/null
rm -rf "$T" 2>/dev/null || echo "INFO could not remove $T"
exit $rc
