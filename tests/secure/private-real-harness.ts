/**
 * N4 — shared harness for the REAL `--private` e2e suites (real gocryptfs + real unshare, fake pi,
 * fake passfile password typed through script(1)). Everything lives under one mktemp root per
 * vault; nothing touches the user's ~/secure or ~/.pi (HOME is the temp home for every child).
 *
 * The fake pi is driven by env:
 *   FAKE_PI_REC      JSON facts (pid/uid/CapEff/ns/fd9/cwd/argv + spawned helper pids) written here
 *   FAKE_PI_SLEEP    ms before exiting (default 0) · FAKE_PI_EXIT exit code (default 0; TERM ⇒ 143)
 *   FAKE_PI_DATA     write this into ./data.txt (cwd = <mnt>/work[/sub])
 *   FAKE_PI_LEFTOVER setsid `sleep 1000` (no fd 9) · FAKE_PI_IGNORE_TERM setsid sleep ignoring TERM
 *   FAKE_PI_LAZY_CTL <log>: a setsid helper keeps ./data.txt open + cwd in the vault and logs, every
 *                    200 ms, reads through (fd, cwd-relative path, absolute path)
 *   FAKE_PI_IGNORE_HUP  survive SIGHUP (like a pi under nohup/tmux) — P0 is the pty's controlling
 *                    process, so its death hangs up the foreground group (P1 + pi)
 *   <FAKE_PI_REC>.events  SIGHUP/SIGPIPE/SIGINT/exit/uncaught notes
 *   FAKE_PI_TRIGGER  <prefix>: when <prefix>.<n> appears, run `pi-secure <its content>` from INSIDE
 *                    the session (cwd /, PWD=/) and write <prefix>.<n>.out
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = join(import.meta.dirname, "..", "..");
export const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
export const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
export const PW = "TESTPASS-fake-not-a-secret";

export const which = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why the real block is skipped ("" ⇔ it runs). */
export function realSkipReason(): string {
  if (process.platform !== "linux") return "not linux";
  const miss = ["gocryptfs", "fusermount3", "flock", "script", "unshare", "umount"].filter((b) => !which(b));
  if (miss.length) return `missing ${miss.join(", ")}`;
  if (spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status !== 0)
    return "/dev/fuse unusable";
  if (spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "true"]).status !== 0)
    return "unprivileged user+mount namespaces unavailable";
  return "";
}

const LAZY_CTL_SRC = `const fs=require("fs");const log=process.argv[1];const abs=process.argv[2];
const fd=fs.openSync("data.txt","r");
setInterval(()=>{const r={t:Date.now()};const b=Buffer.alloc(64);
try{r.fd=b.subarray(0,fs.readSync(fd,b,0,64,0)).toString()}catch(e){r.fd="ERR:"+e.code}
try{r.rel=fs.readFileSync("data.txt","utf8")}catch(e){r.rel="ERR:"+e.code}
try{r.abs=fs.readFileSync(abs,"utf8")}catch(e){r.abs="ERR:"+e.code}
fs.appendFileSync(log,JSON.stringify(r)+"\\n")},200);`;

function fakePiSource(): string {
  return `#!/usr/bin/env node
import fs from "node:fs"; import { spawn, spawnSync } from "node:child_process";
const E = process.env;
const st = fs.readFileSync("/proc/self/status", "utf8");
let fd9 = null; try { fd9 = fs.readlinkSync("/proc/self/fd/9"); } catch {}
const info = { pid: process.pid, uid: process.getuid(), cap: /CapEff:\\s+(\\S+)/.exec(st)[1],
  ns: fs.readlinkSync("/proc/self/ns/mnt"), fd9, NS: E.PI_SECURE_NS ?? null, cwd: process.cwd(), argv: process.argv.slice(2), kids: {} };
if (E.FAKE_PI_DATA) fs.writeFileSync("data.txt", E.FAKE_PI_DATA);
const bg = (name, cmd, args) => { const c = spawn(cmd, args, { detached: true, stdio: "ignore" }); c.unref(); info.kids[name] = c.pid; };
if (E.FAKE_PI_LEFTOVER) bg("leftover", "sleep", ["1000"]);
if (E.FAKE_PI_IGNORE_TERM) bg("ignoreTerm", "sh", ["-c", "trap '' TERM; exec sleep 1000"]);
if (E.FAKE_PI_LAZY_CTL) bg("lazyCtl", process.execPath, ["-e", ${JSON.stringify(LAZY_CTL_SRC)}, E.FAKE_PI_LAZY_CTL, E.FAKE_PI_LAZY_ABS]);
if (E.FAKE_PI_REC) fs.writeFileSync(E.FAKE_PI_REC, JSON.stringify(info));
process.on("SIGTERM", () => process.exit(143));
if (E.FAKE_PI_REC) {
  const note = (what) => { try { fs.appendFileSync(E.FAKE_PI_REC + ".events", what + "\\n"); } catch {} };
  for (const sig of ["SIGHUP", "SIGPIPE", "SIGINT"])
    process.on(sig, () => { note(sig); if (!(sig === "SIGHUP" && E.FAKE_PI_IGNORE_HUP)) process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGPIPE: 13 })[sig]); });
  process.on("exit", (c) => note("exit " + c));
  process.on("uncaughtException", (e) => { note("uncaught " + (e && e.stack)); process.exit(70); });
}
const trig = E.FAKE_PI_TRIGGER;
if (trig) {
  const done = new Set();
  setInterval(() => {
    for (let n = 1; n <= 9; n++) {
      if (done.has(n) || !fs.existsSync(trig + "." + n)) continue;
      done.add(n);
      const args = fs.readFileSync(trig + "." + n, "utf8").trim().split(/\\s+/);
      const t0 = Date.now();
      const r = spawnSync(E.FAKE_PI_STATUS_BIN, args, { cwd: "/", env: { ...E, PWD: "/" }, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
      fs.writeFileSync(trig + "." + n + ".out", JSON.stringify({ ms: Date.now() - t0, code: r.status, signal: r.signal, out: r.stdout, err: r.stderr }));
    }
  }, 100);
}
setTimeout(() => process.exit(Number(E.FAKE_PI_EXIT ?? 0)), Number(E.FAKE_PI_SLEEP ?? 0));
`;
}

export type Env = {
  r: string;
  h: string;
  dir: string;
  mnt: string;
  lease: string;
  rec: string;
  env: Record<string, string>;
};

/**
 * Test-only ownership token (N4 security review #2). Every process this harness starts carries
 * `PI_TOOLKIT_TEST_RUN=<random token>` in its environment (the launcher passes it through:
 * piChildEnv/hubSafeEnv only strip `PI_SECURE_*`, so P0 → P1 → gocryptfs → pi → pi's children all
 * inherit it). No product code reads this variable — it is never part of a launcher decision.
 * Cleanup signals a process only if it is PROVABLY ours: same real uid, started after this harness
 * was created, token present in /proc/<pid>/environ, starttime unchanged across the reads.
 * Anything else that merely mentions a scratch path (argv/cwd) is reported, never signalled.
 */
export const RUN_VAR = "PI_TOOLKIT_TEST_RUN";
export type Ident = { pid: number; start: number };
type Signal = (pid: number, sig: NodeJS.Signals) => void;

export class RealHarness {
  readonly scratch: string[] = [];
  readonly token = randomBytes(16).toString("hex");
  /** starttime (clock ticks) of a child spawned at construction: nothing of ours started earlier. */
  readonly runStart: number;
  /** live script(1) groups we started (pid = pgid, detached); removed as soon as they close. */
  readonly groups: Ident[] = [];
  /** Extra processes a test learned about (e.g. a fake pi's setsid helpers). */
  readonly tracked: Ident[] = [];
  /** Leftovers that mention a scratch path but are not provably ours: reported, never signalled. */
  readonly reports: string[] = [];
  private readonly signal: Signal;

  constructor({ signal, runStart }: { signal?: Signal; runStart?: number } = {}) {
    this.signal = signal ?? ((pid, sig) => process.kill(pid, sig));
    if (runStart !== undefined) this.runStart = runStart;
    else {
      const r = spawnSync("sh", ["-c", "cat /proc/self/stat"], { encoding: "utf8" });
      const t = r.stdout ?? "";
      this.runStart = Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[19]);
    }
  }

  /** Environment for anything this harness (or a test using it) spawns. */
  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, [RUN_VAR]: this.token, ...extra };
  }

  track(pid: number): void {
    const start = procStart(pid);
    if (start !== undefined) this.tracked.push({ pid, start });
  }

  /** `pid`'s identity iff it is provably ours (see RUN_VAR). */
  owned(pid: number): Ident | undefined {
    const s1 = procStart(pid);
    if (s1 === undefined || !(s1 >= this.runStart)) return undefined;
    try {
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      if (Number(uid) !== process.getuid()) return undefined;
      const env = readFileSync(`/proc/${pid}/environ`).toString("latin1").split("\0");
      if (!env.includes(`${RUN_VAR}=${this.token}`)) return undefined;
    } catch {
      return undefined;
    }
    return procStart(pid) === s1 ? { pid, start: s1 } : undefined;
  }

  /** Signal `id` only if it is still that process AND provably ours. */
  killOwned(id: Ident, sig: NodeJS.Signals = "SIGKILL"): boolean {
    const o = this.owned(id.pid);
    if (!o || o.start !== id.start) return false;
    try {
      this.signal(id.pid, sig);
      return true;
    } catch {
      return false;
    }
  }

  /** Group-kill a script(1) leader we started — only while it still is that leader. */
  killGroup(g: Ident): boolean {
    if (procStart(g.pid) !== g.start || pgidOf(g.pid) !== g.pid) return false;
    try {
      this.signal(-g.pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  tmp(prefix: string, root: string = tmpdir()): string {
    const d = mkdtempSync(join(root, prefix));
    chmodSync(d, 0o700);
    this.scratch.push(d);
    return d;
  }

  cleanup(): void {
    for (const g of this.groups.splice(0)) this.killGroup(g);
    for (const t of this.tracked.splice(0)) this.killOwned(t);
    // provably-ours processes still around after a failed assertion (gocryptfs daemons, helpers …)
    for (const n of readdirSync("/proc")) {
      if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
      const id = this.owned(Number(n));
      if (id) this.killOwned(id);
    }
    for (const d of this.scratch.splice(0)) {
      for (const n of readdirSync("/proc")) {
        if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
        let hit = false;
        try {
          hit = readFileSync(`/proc/${n}/cmdline`, "utf8").includes(d + "/");
        } catch {
          /* gone */
        }
        try {
          hit ||= readlinkSync(`/proc/${n}/cwd`).startsWith(d + "/");
        } catch {
          /* other ns / gone */
        }
        if (hit && procStart(Number(n)) !== undefined) {
          const line = `not signalled (not provably ours): pid ${n} mentions ${d}`;
          this.reports.push(line);
          console.warn(`[private-real-harness] ${line}`);
        }
      }
      // mount points under our own mktemp root: lazily detach whatever is left (no signal involved)
      for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
        const mp = line.split(" ")[4];
        if (mp && mp.startsWith(d + "/")) spawnSync("fusermount3", ["-uz", mp]);
      }
      spawnSync("chmod", ["-R", "u+rwx", d]);
      rmSync(d, { recursive: true, force: true });
    }
  }

  /** A fresh new-layout vault `acme` (plus optional extra registered vault names) under a temp HOME. */
  setup(
    extraVaults: string[] = [],
    { acme = true, root, prefix = "ps-n4-" }: { acme?: boolean; root?: string; prefix?: string } = {},
  ): Env {
    const r = this.tmp(prefix, root);
    const h = join(r, "home");
    mkdirSync(h, { mode: 0o700 });
    const pkg = join(r, "fakepi");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }),
    );
    writeFileSync(
      join(pkg, "dist", "cli", "args.js"),
      `export * from ${JSON.stringify(pathToFileURL(PI_ARGS).href)};\n`,
    );
    writeFileSync(join(pkg, "dist", "cli.js"), fakePiSource());
    chmodSync(join(pkg, "dist", "cli.js"), 0o755);
    mkdirSync(join(r, "bin"));
    symlinkSync(join(pkg, "dist", "cli.js"), join(r, "bin", "pi"));
    symlinkSync(process.execPath, join(r, "bin", "node"));
    writeFileSync(join(r, "pf"), `${PW}\n`, { mode: 0o600 });
    for (const p of [join(h, ".local"), join(h, ".local", "share"), join(h, ".local", "share", "pi-toolkit-secure")])
      mkdirSync(p, { mode: 0o700 });
    mkdirSync(join(h, "secure"), { mode: 0o700 });
    const vaults: Record<string, object> = {};
    for (const name of [...(acme ? ["acme"] : []), ...extraVaults]) {
      this.makeVault(r, h, name);
      vaults[name] = {};
    }
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(join(h, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ secure: { vaults } }));
    const dir = join(h, ".local", "share", "pi-toolkit-secure", "acme");
    return {
      r,
      h,
      dir,
      mnt: join(h, "secure", "acme"),
      lease: join(dir, "mount.lease"),
      rec: join(r, "pi.json"),
      env: {
        PATH: `${join(r, "bin")}:/usr/bin:/bin`,
        HOME: h,
        LANG: "C.UTF-8",
        TMPDIR: tmpdir(),
        FAKE_PI_REC: join(r, "pi.json"),
        FAKE_PI_STATUS_BIN: BIN,
        [RUN_VAR]: this.token,
      },
    };
  }

  private makeVault(r: string, h: string, name: string): void {
    const dir = join(h, ".local", "share", "pi-toolkit-secure", name);
    const mnt = join(h, "secure", name);
    mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    mkdirSync(mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(mnt, n), "");
      chmodSync(join(mnt, n), 0o400);
    }
    const gi = spawnSync("gocryptfs", [
      "-init",
      "-q",
      "-scryptn",
      "10",
      "-passfile",
      join(r, "pf"),
      "--",
      join(dir, "cipher"),
    ]);
    if (gi.status !== 0) throw new Error(`gocryptfs -init failed: ${gi.stderr}`);
    writeFileSync(join(dir, "mount.lock"), "", { mode: 0o600 });
    writeFileSync(join(dir, "mount.lease"), "", { mode: 0o600 });
    void dirname;
  }

  /** Launcher through script(1); types PW at every "Password:" prompt. `onText` sees live output. */
  tty(
    e: Env,
    args: string,
    extra: Record<string, string> = {},
    {
      killAfterMs = 90_000,
      onText,
      answers = [],
      cwd,
      password = PW,
      passwords,
    }: {
      killAfterMs?: number;
      onText?: (t: string) => void;
      /** [prompt pattern, reply]: the reply is typed once per occurrence of the pattern. */
      answers?: Array<[RegExp, string]>;
      cwd?: string;
      /** typed at every "Password:"/"Repeat:" prompt (default: the harness's test password) */
      password?: string;
      /** per-prompt passwords in order (prompt n gets passwords[n], falling back to `password`) */
      passwords?: string[];
    } = {},
  ): Promise<{ code: number | null; text: string; ms: number; pid: number }> & { child: ChildProcess } {
    const t0 = Date.now();
    const c = spawn("script", ["-qefc", `${BIN} ${args}`, "/dev/null"], {
      env: { ...e.env, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    const g = c.pid !== undefined ? { pid: c.pid, start: procStart(c.pid) ?? -1 } : undefined;
    if (g) this.groups.push(g);
    const forget = () => {
      const i = g ? this.groups.indexOf(g) : -1;
      if (i >= 0) this.groups.splice(i, 1);
    };
    const p = new Promise<{ code: number | null; text: string; ms: number; pid: number }>((res) => {
      let text = "";
      let typed = 0;
      const answered = answers.map(() => 0);
      const on = (b: Buffer) => {
        text += b.toString();
        const prompts = text.split(/Password:|Repeat:/).length - 1;
        while (typed < prompts) {
          typed++;
          try {
            c.stdin.write(`${passwords?.[typed - 1] ?? password}\r`);
          } catch {
            /* closed */
          }
        }
        answers.forEach(([re, reply], i) => {
          const n = text.match(new RegExp(re.source, "g"))?.length ?? 0;
          while (answered[i]! < n) {
            answered[i]!++;
            try {
              c.stdin.write(`${reply}\r`);
            } catch {
              /* closed */
            }
          }
        });
        onText?.(text);
      };
      c.stdout.on("data", on);
      c.stderr.on("data", on);
      const t = setTimeout(() => {
        if (g) this.killGroup(g); // re-verified: still that leader (pid+starttime, pgid == pid)
      }, killAfterMs);
      c.on("exit", forget); // reaped ⇒ the pid may be recycled from now on: never signal it again
      c.on("close", (code) => {
        clearTimeout(t);
        forget();
        res({ code, text: text.replace(/\r/g, ""), ms: Date.now() - t0, pid: c.pid! });
      });
    }) as Promise<{ code: number | null; text: string; ms: number; pid: number }> & { child: ChildProcess };
    p.child = c;
    return p;
  }
}

/** Non-TTY launcher call (status / lock …). */
export function plain(e: Env, args: string, timeoutMs = 60_000) {
  const r = spawnSync("sh", ["-c", `exec ${BIN} ${args} </dev/null`], {
    env: e.env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", text: (r.stdout ?? "") + (r.stderr ?? "") };
}

export const recordPath = (e: Env) => join(e.dir, "private.json");
export const recordOf = (e: Env) => JSON.parse(readFileSync(recordPath(e), "utf8"));
export const leaseFree = (e: Env) => spawnSync("flock", ["-n", e.lease, "true"]).status === 0;
export const globalMounted = (mnt: string) => readFileSync("/proc/self/mountinfo", "utf8").includes(` ${mnt} `);
export const piFacts = (e: Env) => JSON.parse(readFileSync(e.rec, "utf8"));

export function procStart(pid: number): number | undefined {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = t.slice(t.lastIndexOf(")") + 2).split(" ");
    return f[0] === "Z" ? undefined : Number(f[19]);
  } catch {
    return undefined;
  }
}
export const alive = (id: { pid: number; start: number }) => procStart(id.pid) === id.start;
export function pgidOf(pid: number): number | undefined {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return undefined;
  }
}
/** SIGKILL `id` only if it still is that process (pid+starttime re-verified). */
export function killVerified(id: { pid: number; start: number }, sig: NodeJS.Signals = "SIGKILL"): boolean {
  if (!alive(id)) return false;
  try {
    process.kill(id.pid, sig);
    return true;
  } catch {
    return false;
  }
}

export async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (pred()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(50);
  }
}
export const untilPhase = (e: Env, phase: string, ms = 30_000) =>
  until(() => recordOf(e).phase === phase, ms, `phase ${phase}`);

/** pids (same uid) with an open fd pointing at `file`. */
export function fdHolders(file: string): number[] {
  const out: number[] = [];
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${n}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${n}/fd/${fd}`) === file) {
          out.push(Number(n));
          break;
        }
      } catch {
        /* raced */
      }
    }
  }
  return out;
}

/** Run `pi-secure <args>` from inside the session (fake pi trigger n). */
export async function inside(e: Env, prefix: string, n: number, args: string, ms = 40_000) {
  writeFileSync(`${prefix}.${n}`, args);
  await until(() => existsSync(`${prefix}.${n}.out`), ms, `inside command ${n}`);
  await sleep(50);
  return JSON.parse(readFileSync(`${prefix}.${n}.out`, "utf8")) as {
    ms: number;
    code: number | null;
    signal: string | null;
    out: string;
    err: string;
  };
}

/** Test-side read-only look at the plaintext through a passfile mount (never the launcher). */
export function lookInside<T>(e: Env, fn: (root: string) => T): T {
  const look = join(e.r, "look");
  mkdirSync(look, { recursive: true, mode: 0o700 });
  const m = spawnSync("gocryptfs", ["-q", "-passfile", join(e.r, "pf"), "--", join(e.dir, "cipher"), look], {
    env: e.env,
  });
  if (m.status !== 0) throw new Error(`test-side mount failed: ${m.stderr}`);
  try {
    return fn(look);
  } finally {
    spawnSync("fusermount3", ["-u", look]);
  }
}

/** Wait (≤60 s) until no foreign fuse.gocryptfs mount exists, else skip (run --private refuses then). */
export async function awaitNoForeignGocryptfs(ctx: { skip: () => void }, mine: string): Promise<void> {
  const end = Date.now() + 60_000;
  for (;;) {
    const foreign = readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter((l) => l.includes(" - fuse.gocryptfs ") && !l.split(" ")[4]!.startsWith(mine + "/"));
    if (!foreign.length) return;
    if (Date.now() >= end) {
      ctx.skip();
      return;
    }
    await sleep(500);
  }
}
