/**
 * N2 — `pi-secure` command surface for `--private` (private-plan r3 §1.1/§1.2, §3.7, §3.8, §5.1, Q5/Q9).
 *
 * Unit tests (pure decision table / status renderer / instance view on a fake vault) + CLI tests
 * (spawned launcher, private mktemp HOME, never the user's ~/.pi) + a self-gated "real" block
 * (real gocryptfs + real unshare, fake passfile password typed through script(1), fake pi),
 * serialized with every other real-mount suite through the gocryptfs test lock.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);

const which = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
const HAVE_FLOCK = process.platform === "linux" && which("flock");
const HAVE_USERNS =
  process.platform === "linux" &&
  which("unshare") &&
  spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"]).status === 0;

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
const children: ChildProcess[] = [];
function holder(cmd: string, args: string[]): ChildProcess {
  const c = spawn(cmd, args, { stdio: "ignore", detached: true });
  children.push(c);
  return c;
}
function killAll(): void {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const OWN_NS = readlinkSync("/proc/self/ns/mnt");
const ID_A = "a".repeat(32);

// ───────────────────────────── shared fake vault (no FUSE) ─────────────────────────────

const ORIG_HOME = process.env.HOME;
let root = "";
let home = "";
let nodeBin = "";
let v: Record<string, string> = {};
const settingsFile = () => join(home, ".pi", "agent", "pi-subagent.json");
function writeSettings(vaults: Record<string, unknown>): void {
  writeFileSync(settingsFile(), JSON.stringify({ secure: { vaults } }));
}

beforeAll(() => {
  root = tmp("ps-n2-");
  home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  process.env.HOME = home;
  const dir = join(home, ".local", "share", "pi-toolkit-secure", "acme");
  const mnt = join(home, "secure", "acme");
  mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
  for (const p of [join(home, ".local"), join(home, ".local", "share"), dirname(dir), dir, join(dir, "cipher")])
    chmodSync(p, 0o700);
  mkdirSync(join(home, "secure"), { mode: 0o700 });
  mkdirSync(mnt, { mode: 0o700 });
  for (const n of ["work", "state"]) {
    writeFileSync(join(mnt, n), "");
    chmodSync(join(mnt, n), 0o400);
  }
  writeFileSync(join(dir, "cipher", "gocryptfs.conf"), "{}");
  writeFileSync(join(dir, "mount.lock"), "", { mode: 0o600 });
  writeFileSync(join(dir, "mount.lease"), "", { mode: 0o600 });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeSettings({ acme: {} });
  v = H.parseSecureConfig({ secure: { vaults: { acme: {} } } }, home).vaults[0];
  // PATH for spawned launchers: a dedicated dir (never the nvm dir — a real global `pi` lives there).
  nodeBin = join(root, "nodebin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const fakeBin = join(root, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "gocryptfs"),
    `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "gocryptfs 1.8.0"; exit 0; fi\necho "$*" >> "${join(root, "gocryptfs-calls.log")}"\nexit 12\n`,
  );
  writeFileSync(join(fakeBin, "fusermount3"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "gocryptfs"), 0o755);
  chmodSync(join(fakeBin, "fusermount3"), 0o755);
});
afterAll(() => {
  killAll();
  process.env.HOME = ORIG_HOME;
  for (const d of scratch) {
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
});
beforeEach(() => {
  killAll();
  rmSync(join(v.dir ?? "/nonexistent", "private.json"), { force: true });
  rmSync(join(root, "gocryptfs-calls.log"), { force: true });
  writeSettings({ acme: {} });
});

const recordFile = () => join(v.dir, "private.json");
function baseRecord(over: Record<string, unknown> = {}) {
  const li = H.leaseIdentitySync(v);
  const p = H.physicalPaths(v);
  return {
    v: 3,
    instanceId: ID_A,
    name: "acme",
    phase: "starting",
    mode: "run",
    bootId: BOOT,
    createdAt: "2026-10-23T11:30:00.000Z",
    realCipher: p.realCipher,
    realMnt: p.realMnt,
    lease: { dev: li.dev, ino: li.ino },
    owner: { pid: 999_999, start: 1 },
    ...over,
  };
}
function writeRecord(over: Record<string, unknown> = {}): void {
  writeFileSync(recordFile(), JSON.stringify(baseRecord(over)), { mode: 0o600 });
}
function liveIdentity(pid: number) {
  return { pid, start: H.readProcStartSync(pid) as number };
}

/** Spawn the launcher (PATH = fake gocryptfs + node only). `tty` ⇒ through script(1). */
function cli(args: string, { tty = false, env = {} }: { tty?: boolean; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number | null; out: string; err: string; text: string; ms: number }>((res) => {
    const t0 = Date.now();
    const c = tty
      ? spawn("script", ["-qefc", `${BIN} ${args}`, "/dev/null"], {
          env: { PATH: `${join(root, "fakebin")}:${nodeBin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", ...env },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn("sh", ["-c", `exec ${BIN} ${args} </dev/null`], {
          env: { PATH: `${join(root, "fakebin")}:${nodeBin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
    let out = "";
    let err = "";
    c.stdout!.on("data", (b) => (out += b));
    c.stderr!.on("data", (b) => (err += b));
    const t = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("close", (code) => {
      clearTimeout(t);
      res({ code, out, err, text: (out + err).replace(/\r/g, ""), ms: Date.now() - t0 });
    });
  });
}

/**
 * A fake live instance in its OWN user+mount namespace (no FUSE): `flock <lease> unshare … sleep`
 * — flock holds the lease exactly like a fd-9 holder and drops it when the sleep (our fake
 * supervisor + pi) dies. Returns the identities a real P1 would record.
 */
async function fakeInstance(): Promise<{ sup: { pid: number; start: number }; nsMnt: string; nsUser: string }> {
  const c = holder("flock", [v.lease, "unshare", "--user", "--map-root-user", "--mount", "sleep", "60"]);
  const flockPid = c.pid!;
  const end = Date.now() + 5_000;
  for (;;) {
    const kids = readFileSync(`/proc/${flockPid}/task/${flockPid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const pid = Number(kids[0]);
    if (pid) {
      try {
        const nsMnt = readlinkSync(`/proc/${pid}/ns/mnt`);
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (nsMnt !== OWN_NS && comm === "sleep")
          return { sup: liveIdentity(pid), nsMnt, nsUser: readlinkSync(`/proc/${pid}/ns/user`) };
      } catch {
        /* racing exec */
      }
    }
    if (Date.now() > end) throw new Error("fake instance did not start");
    await sleep(20);
  }
}

// ───────────────────────────── pure: §3.7 lock table ─────────────────────────────

describe("lockPrivateDecision — §3.7 table", () => {
  const V = { name: "acme", dir: "/d" };
  const D = (view: Record<string, unknown>, o: Record<string, boolean> = {}) => H.lockPrivateDecision(V, view, o);
  const rec = { pi: { pid: 1220, start: 1 }, phase: "session" };
  it("none ⇒ the original lock path (with a --kill note only)", () => {
    expect(D({ state: "none" })).toEqual({ action: "plain" });
    expect(D({ state: "none" }, { lazy: true })).toEqual({ action: "plain" });
    expect(D({ state: "none" }, { kill: true })).toEqual({
      action: "plain",
      note: "--kill 只用于 --private 实例；按普通 lock 处理",
    });
  });
  it("starting / mounting ⇒ 73 for every flag", () => {
    for (const state of ["starting", "mounting"])
      for (const o of [{}, { lazy: true }, { kill: true }])
        expect(D({ state }, o)).toEqual({ action: "refuse", code: 73, text: "另一个 pi-secure 正在挂载 acme" });
  });
  it("launching: plain ⇒ 76 session text, --lazy ⇒ 76 not-yet, --kill ⇒ kill", () => {
    expect(D({ state: "launching", record: {} })).toMatchObject({ action: "refuse", code: 76 });
    expect(D({ state: "launching", record: {} }).text).toMatch(/会话仍在运行（启动中）/);
    expect(D({ state: "launching" }, { lazy: true })).toEqual({
      action: "refuse",
      code: 76,
      text: "acme：会话尚未启动完成，稍后再试",
    });
    expect(D({ state: "launching" }, { kill: true })).toEqual({ action: "kill" });
  });
  it("session: plain ⇒ 76 with pi pid + both escapes, --lazy ⇒ lazy, --kill ⇒ kill", () => {
    const r = D({ state: "session", record: rec });
    expect(r).toMatchObject({ action: "refuse", code: 76 });
    expect(r.text).toBe(
      "acme：会话仍在运行（pi pid 1220）：退出 pi 后自动收尾；--lazy 摘除该命名空间里的挂载路径；--kill 结束会话并收尾",
    );
    expect(D({ state: "session", record: rec }, { lazy: true })).toEqual({ action: "lazy" });
    expect(D({ state: "session", record: rec }, { kill: true })).toEqual({ action: "kill" });
  });
  it("finalizing ⇒ wait; orphan/orphan-ns ⇒ outer (lazy degrades, reported); stale ⇒ release", () => {
    for (const o of [{}, { lazy: true }, { kill: true }])
      expect(D({ state: "finalizing" }, o)).toEqual({ action: "wait" });
    for (const state of ["orphan", "orphan-ns"]) {
      expect(D({ state })).toEqual({ action: "outer", degrade: false });
      expect(D({ state }, { lazy: true })).toEqual({ action: "outer", degrade: true });
      expect(D({ state }, { kill: true })).toEqual({ action: "outer", degrade: false });
    }
    for (const o of [{}, { lazy: true }, { kill: true }])
      expect(D({ state: "stale" }, o)).toEqual({ action: "release" });
  });
  it("unrecorded / unknown / ns-in-use / corrupt ⇒ 76 report only, for every flag (never kill)", () => {
    for (const state of ["unrecorded", "unknown", "ns-in-use", "corrupt"])
      for (const o of [{}, { lazy: true }, { kill: true }]) {
        const r = D({ state, reason: "x" }, o);
        expect(r.action).toBe("refuse");
        expect(r.code).toBe(76);
        expect(r.text).toMatch(/确认后可手工 kill，或重启$/);
      }
  });
  it("caller inside that ns ⇒ 76 for every non-none state and flag", () => {
    for (const state of ["session", "launching", "finalizing", "orphan", "stale", "unknown"])
      for (const o of [{}, { lazy: true }, { kill: true }])
        expect(D({ state, inNs: true, record: rec }, o)).toEqual({
          action: "refuse",
          code: 76,
          text: "acme：不能在私有会话内部收尾自己；退出 pi 即自动收尾",
        });
  });
});

describe("decidePrivateOutcome — setup mode (init --private / --fix-settings) never has a pi", () => {
  const NS = { ns: { mnt: "mnt:[7]", user: "user:[6]" }, supervisor: { pid: 9, start: 9 } };
  const D = (over: Record<string, unknown>, p1Code: number) =>
    H.decidePrivateOutcome({
      instanceId: ID_A,
      piAlive: false,
      p1Code,
      record: { kind: "ok", record: baseRecord({ ...NS, phase: "finalizing", ...over }) },
    });
  it("completed in-ns finalize without failCode ⇒ release with 0", () => {
    expect(D({ mode: "setup", inNsDone: true }, 0)).toEqual({ action: "release", code: 0 });
  });
  it("a recorded failure keeps its code; run mode without piExit stays a failure (unchanged)", () => {
    expect(D({ mode: "setup", inNsDone: true, failCode: 78 }, 78)).toEqual({ action: "release", code: 78 });
    expect(D({ mode: "setup", inNsDone: false }, 75)).toEqual({ action: "outer", code: 75 });
    expect(D({ mode: "run", inNsDone: true }, 0)).toEqual({ action: "release", code: 1 });
  });
});

// ───────────────────────────── pure: §3.8 status ─────────────────────────────

describe("status rendering — §3.8", () => {
  const V = { name: "acme", dir: "/home/u/.local/share/pi-toolkit-secure/acme", mnt: "/home/u/secure/acme" };
  const sessionRec = {
    v: 3,
    instanceId: "9f3c" + "0".repeat(28),
    name: "acme",
    phase: "session",
    createdAt: "2026-10-23T11:30:00.000Z",
    pi: { pid: 1220, start: 5 },
    supervisor: { pid: 1201, start: 3 },
    gocryptfs: { pid: 1210, start: 4 },
    ns: { mnt: "mnt:[4026532871]", user: "user:[4026532870]" },
  };
  const sessionView = {
    state: "session",
    record: sessionRec,
    recordKind: "ok",
    lease: "held",
    scan: { kind: "done", members: [{}, {}, {}, {}] },
    classes: { verified: [{}, {}, {}, {}], unverified: [] },
    inNs: false,
  };
  it("tokens", () => {
    const T = (state: string, extra: Record<string, unknown> = {}) => H.privateStatusToken({ state, ...extra });
    expect(T("session")).toBe("private");
    expect(T("starting")).toBe("private:starting");
    expect(T("mounting")).toBe("private:starting");
    expect(T("launching")).toBe("private:launching");
    expect(T("finalizing")).toBe("private:finalizing");
    expect(T("orphan")).toBe("private:orphan");
    expect(T("orphan-ns")).toBe("private:orphan-ns");
    expect(T("stale")).toBe("private:stale-record");
    expect(T("ns-in-use")).toBe("private:ns-in-use");
    expect(T("unrecorded")).toBe("lease:unrecorded");
    expect(T("corrupt")).toBe("private:corrupt-record");
    expect(T("unknown")).toBe("private:unknown");
    // inside the ns the scan cannot complete — the record phase decides
    expect(T("unknown", { inNs: true, record: { phase: "session" } })).toBe("private");
    expect(T("unknown", { inNs: true, record: { phase: "setup" } })).toBe("private:launching");
  });
  it("session block follows the §3.8 layout (boundary short sentence last)", () => {
    const lines = H.renderPrivateStatus(V, { st: "absent", layout: "ok", problems: [], view: sessionView });
    expect(lines).toEqual([
      "acme: private  layout ok  mnt /home/u/secure/acme",
      "  dir /home/u/.local/share/pi-toolkit-secure/acme",
      `  private: session · pi 1220 · supervisor 1201 · gocryptfs 1210 · ns mnt:[4026532871] · since ${H.shortTime(sessionRec.createdAt)} · id 9f3c…`,
      "  lease: held",
      "  outside view: not mounted · sentinels ok",
      "  ns members: 4",
      "  boundary: 防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）",
    ]);
    expect(lines.at(-1)).toBe(`  boundary: ${H.PRIVATE_BOUNDARY_SHORT}`);
  });
  it("global mount also present ⇒ conflict; incomplete scan ⇒ n/a; in-ns ⇒ marker line; lazy detach shown", () => {
    const a = H.renderPrivateStatus(V, {
      st: "mounted",
      layout: "ok",
      view: {
        ...sessionView,
        scan: { kind: "incomplete" },
        record: { ...sessionRec, lazyDetachedAt: sessionRec.createdAt },
      },
    });
    expect(a).toContain("  outside view: ! global mount also present (conflict)");
    expect(a).toContain("  ns members: n/a (incomplete)");
    expect(a[2]).toMatch(/ · lazy-detached \d{4}-\d\d-\d\d \d\d:\d\d$/);
    const b = H.renderPrivateStatus(V, {
      st: "mounted",
      layout: "ok",
      view: { ...sessionView, state: "unknown", scan: { kind: "incomplete" }, inNs: true },
    });
    expect(b[0]).toBe("acme: private  layout ok  mnt /home/u/secure/acme");
    expect(b).toContain("  outside view: n/a (seen from inside the private namespace)");
    expect(b).toContain("  (this process is inside the private namespace)");
  });
  it("unrecorded lease: holders listed, no boundary line (not a private instance)", () => {
    const lines = H.renderPrivateStatus(V, {
      st: "absent",
      layout: "ok",
      view: {
        state: "unrecorded",
        recordKind: "none",
        lease: "held",
        holders: [{ pid: 42, comm: "gocryptfs" }, { pid: 43 }],
      },
    });
    expect(lines[0]).toBe("acme: lease:unrecorded  layout ok  mnt /home/u/secure/acme");
    expect(lines).toContain("  lease: held (unrecorded)");
    expect(lines).toContain("    holder pid 42 gocryptfs");
    expect(lines).toContain("    holder pid 43 (exited/unreadable)");
    expect(lines.join("\n")).toMatch(/无法证明归属，不会自动终止/);
    expect(lines.join("\n")).not.toMatch(/boundary:/);
  });
  it("corrupt record ⇒ fail-closed hint with the real record path", () => {
    const lines = H.renderPrivateStatus(V, {
      st: "absent",
      layout: "ok",
      view: { state: "corrupt", reason: "json", recordKind: "corrupt", lease: "free" },
    });
    expect(lines[0]).toMatch(/^acme: private:corrupt-record /);
    expect(lines).toContain(`  private.json: corrupt (json)  ${V.dir}/private.json`);
    expect(lines.join("\n")).toMatch(/fail closed/);
  });
  it("shortTime is local YYYY-MM-DD HH:MM; garbage passes through", () => {
    expect(H.shortTime("2026-10-23T11:30:00.000Z")).toMatch(/^2026-10-2\d \d\d:\d\d$/);
    expect(H.shortTime("nope")).toBe("nope");
  });
});

// ───────────────────────────── N2 security review #1/#2 (status boundedness / userns owners) ─────────────────────────────

describe("review N2 #2: ancestor owners inside a user namespace", () => {
  it("userNsUnmappedUid: identity map ⇒ undefined (host rules); any other map ⇒ the overflow uid", () => {
    expect(
      H.userNsUnmappedUid({ uidMap: "         0          0 4294967295\n", overflowUid: "65534\n" }),
    ).toBeUndefined();
    expect(H.userNsUnmappedUid({ uidMap: "", overflowUid: "65534" })).toBeUndefined();
    expect(H.userNsUnmappedUid({ uidMap: "0 1000 1\n", overflowUid: "65534\n" })).toBe(65534);
    expect(H.userNsUnmappedUid({ uidMap: "1000 1000 1", overflowUid: "77" })).toBe(77);
    expect(H.userNsUnmappedUid({ uidMap: "1000 1000 1", overflowUid: "junk" })).toBe(65534);
  });
  const me = process.getuid!();
  const vv = { name: "x", mnt: "/a/b/mnt", layout: "new" };
  const fake = (byPath: Record<string, { uid: number; mode: number; link?: boolean }>) => (p: string) => {
    const e = byPath[p] ?? { uid: me, mode: 0o700 };
    return { uid: e.uid, mode: e.mode, isSymbolicLink: () => !!e.link, isDirectory: () => !e.link };
  };
  it("an overflow-owned (unmapped) level is indeterminate — never 'belongs to another user' — only when asked", () => {
    const lstat = fake({ "/a": { uid: 65534, mode: 0o1777 }, "/": { uid: 65534, mode: 0o755 } });
    const seen: string[] = [];
    expect(
      H.mntAncestorProblems(vv, me, { lstat, unmappedUid: 65534, onIndeterminate: (p: string) => seen.push(p) }),
    ).toEqual([]);
    expect(seen).toEqual(["/a", "/"]);
    // host rules (no unmappedUid) are unchanged: the same chain is refused
    expect(H.mntAncestorProblems(vv, me, { lstat }).join()).toMatch(/\/a 属于其他用户（uid 65534）/);
  });
  it("still refused inside a userns: symlinked level, own group-writable level, a mapped foreign uid", () => {
    const opt = { unmappedUid: 65534, onIndeterminate: () => {} };
    expect(
      H.mntAncestorProblems(vv, me, { lstat: fake({ "/a/b": { uid: me, mode: 0o700, link: true } }), ...opt }).join(),
    ).toMatch(/须为真实目录/);
    expect(H.mntAncestorProblems(vv, me, { lstat: fake({ "/a/b": { uid: me, mode: 0o770 } }), ...opt }).join()).toMatch(
      /组\/其他可写/,
    );
    expect(H.mntAncestorProblems(vv, me, { lstat: fake({ "/a": { uid: 4242, mode: 0o755 } }), ...opt }).join()).toMatch(
      /uid 4242/,
    );
  });
});

describe.skipIf(!HAVE_FLOCK)(
  "review N2 #1: status never touches the mount point unless the probe proved it absent",
  () => {
    it("hung / foreign / stale ⇒ no sentinel/readdir checks under <mnt> (an unreadable <mnt> is not even noticed); absent ⇒ checked", async () => {
      chmodSync(v.mnt, 0o000); // readdirSync(<mnt>) would fail EACCES — the proof that it was (not) called
      try {
        for (const st of ["hung", "foreign", "stale"]) {
          const d = await H.describeVault(v, { probe: async () => st, unmappedUid: null });
          const text = d.lines.join("\n");
          expect(text, st).not.toMatch(/不可读|哨兵|0700 目录/);
          expect(d.lines[0]).toMatch(new RegExp(`^acme: ${st}  layout ok  mnt `));
          expect(d.scan).toBe(false);
          if (st === "hung") expect(text).toMatch(/挂载探测超时（gocryptfs 无响应？）：未检查挂载点内容/);
        }
        const a = await H.describeVault(v, { probe: async () => "absent", unmappedUid: null });
        expect(a.lines.join("\n")).toMatch(/不可读：EACCES/); // control: absent does look
      } finally {
        chmodSync(v.mnt, 0o700);
      }
    });
    it("a private record + hung probe renders the private block with the timeout note (bounded, read-only)", async () => {
      writeRecord({ bootId: "another-boot" });
      const d = await H.describeVault(v, { probe: async () => "hung", unmappedUid: null });
      expect(d.lines[0]).toBe(`acme: private:stale-record  layout ok  mnt ${v.mnt}`);
      expect(d.lines[2]).toMatch(/^ {2}! 挂载探测超时/);
      expect(d.lines).toContain("  outside view: ! global hung");
      expect(existsSync(recordFile())).toBe(true);
    });
    it("inside a user namespace the unmapped levels are listed as n/a, not as a layout problem", async () => {
      // every ancestor of the fake mount point that is root-owned on this host plays "unmapped"
      const d = await H.describeVault(v, { probe: async () => "absent", unmappedUid: 0 });
      expect(d.lines[0]).toMatch(/^acme: locked  layout ok /);
      expect(d.lines.join("\n")).toMatch(/ancestors: n\/a for \d+ level\(s\) \(unmapped owner inside a user namespace/);
    });
  },
);

// ───────────────────────────── instance view on a fake vault ─────────────────────────────

describe.skipIf(!HAVE_FLOCK)("vaultInstanceView — which entry-point view a vault gets", () => {
  it("no record + lease free ⇒ none; no vault dir ⇒ none (never probes)", async () => {
    expect(await H.vaultInstanceView(v, "absent")).toMatchObject({ state: "none", lease: "free" });
    const ghost = { ...v, dir: join(root, "nope"), lease: join(root, "nope", "mount.lease") };
    expect(await H.vaultInstanceView(ghost, "absent")).toMatchObject({ state: "none", lease: "n/a" });
  });
  it("no record + lease held: global absent ⇒ unrecorded (holders); a global mount owns it ⇒ none", async () => {
    const c = holder("flock", [v.lease, "sleep", "30"]);
    await sleep(200);
    const u = await H.vaultInstanceView(v, "absent");
    expect(u.state).toBe("unrecorded");
    expect(u.holders.map((h: { pid: number }) => h.pid)).toContain(c.pid);
    expect(await H.vaultInstanceView(v, "mounted")).toMatchObject({ state: "none", lease: "held" });
    expect(await H.vaultInstanceView(v, "stale")).toMatchObject({ state: "none" });
  });
  it("record present ⇒ privateInstanceState verdict (stale boot / corrupt)", async () => {
    writeRecord({ bootId: "another-boot" });
    expect(await H.vaultInstanceView(v, "absent")).toMatchObject({ state: "stale", inNs: false });
    writeFileSync(recordFile(), "{not json", { mode: 0o600 });
    expect(await H.vaultInstanceView(v, "absent")).toMatchObject({ state: "corrupt", reason: "json" });
  });
  it("a record whose ns is OUR ns ⇒ inNs", async () => {
    writeRecord({
      phase: "session",
      supervisor: { pid: 999_990, start: H.readProcStartSync(process.pid) },
      ns: { mnt: OWN_NS, user: readlinkSync("/proc/self/ns/user") },
    });
    const s = await H.vaultInstanceView(v, "absent");
    expect(s.inNs).toBe(true);
    expect(H.callerInPrivateNs(s.record, "mnt:[1]")).toBe(false);
  });
});

// ───────────────────────────── settings registration ─────────────────────────────

describe.skipIf(!HAVE_FLOCK)("registerVault — `private: true` only when requested", () => {
  it("plain registration writes exactly {dir, mnt}; private adds private:true; __register validates", () => {
    H.registerVault("beta", "/x/beta", "/y/beta", home);
    H.registerVault("gamma", "/x/gamma", "/y/gamma", home, { private: true });
    const s = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(s.secure.vaults.beta).toEqual({ dir: "/x/beta", mnt: "/y/beta" });
    expect(s.secure.vaults.gamma).toEqual({ dir: "/x/gamma", mnt: "/y/gamma", private: true });
    const bad = spawnSync(process.execPath, [HELPER, "__register", "delta", "/x", "/y", "--bogus"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    expect(bad.status).toBe(78);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).secure.vaults.delta).toBeUndefined();
  });
});

// ───────────────────────────── CLI ─────────────────────────────

describe.skipIf(!HAVE_FLOCK || !which("script"))(
  "CLI: unlock --global / lock flags / stale / unrecorded (§1.2, §3.7, Q5)",
  () => {
    it("Q5: a private vault refuses plain unlock with 64 + hint; --global only lifts that default", async () => {
      writeSettings({ acme: { private: true } });
      const r = await cli("unlock acme", { tty: true });
      expect(r.code, r.text).toBe(64);
      expect(r.text).toMatch(/配置为 --private/);
      expect(r.text).toMatch(/pi-secure unlock acme --global/);
      expect(existsSync(join(root, "gocryptfs-calls.log"))).toBe(false);
      // --global lifts it: the normal unlock path runs (fake gocryptfs ⇒ wrong password ×3 ⇒ 77)
      const g = await cli("unlock acme --global", { tty: true });
      expect(g.code, g.text).toBe(77);
      expect(readFileSync(join(root, "gocryptfs-calls.log"), "utf8")).toMatch(/-nonempty -- /);
      // ordinary vaults: --global accepted, no difference
      writeSettings({ acme: {} });
      expect((await cli("unlock acme --global")).code).toBe(2); // non-TTY, as before
      expect((await cli("unlock acme --global --global")).code).toBe(2);
      expect((await cli("unlock acme --global")).text).toMatch(/需要在终端里输入口令/);
    }, 60_000);

    it("--global never bypasses mutual exclusion: a private record blocks it 76 before any prompt", async () => {
      writeSettings({ acme: { private: true } });
      const f = await fakeInstance();
      writeRecord({
        phase: "session",
        supervisor: f.sup,
        gocryptfs: f.sup,
        pi: f.sup,
        ns: { mnt: f.nsMnt, user: f.nsUser },
      });
      const r = await cli("unlock acme --global", { tty: true });
      expect(r.code, r.text).toBe(76);
      expect(r.text).toMatch(new RegExp(`正在运行（session，pi pid ${f.sup.pid}）`));
      expect(r.text).not.toMatch(/Password|口令/);
      expect(existsSync(join(root, "gocryptfs-calls.log"))).toBe(false);
    }, 30_000);

    it("lock: --lazy --kill together is a usage error; --kill on an ordinary vault notes and runs the old path", async () => {
      expect((await cli("lock acme --lazy --kill")).code).toBe(2);
      const k = await cli("lock acme --kill");
      expect(k.code, k.text).toBe(0);
      expect(k.err).toMatch(/--kill 只用于 --private 实例；按普通 lock 处理/);
      const plain = await cli("lock acme");
      expect(k.out).toBe(plain.out); // identical old-path output
    }, 30_000);

    it("stale record: status shows private:stale-record; lock releases it (0); a plain unlock also cleans it", async () => {
      writeRecord({ bootId: "another-boot" });
      const s = await cli("status acme");
      expect(s.code).toBe(0);
      expect(s.out).toMatch(/^acme: private:stale-record  layout ok  mnt /m);
      expect(s.out).toMatch(/^ {2}boundary: /m);
      expect(existsSync(recordFile())).toBe(true); // status is read-only
      const l = await cli("lock acme");
      expect(l.code, l.text).toBe(0);
      expect(l.out).toMatch(/acme：清理了失效的 --private 记录/);
      expect(existsSync(recordFile())).toBe(false);
      writeRecord({ bootId: "another-boot" });
      const u = await cli("unlock acme", { tty: true });
      expect(u.text).toMatch(/acme：清理了失效的 --private 记录/);
      expect(u.code, u.text).toBe(77); // then the ordinary unlock continued (fake gocryptfs)
      expect(existsSync(recordFile())).toBe(false);
    }, 60_000);

    it("unrecorded lease holder: status reports it, lock and unlock refuse 76 (report only, nothing killed)", async () => {
      const c = holder("flock", [v.lease, "sleep", "30"]);
      await sleep(200);
      const s = await cli("status acme");
      expect(s.out).toMatch(/^acme: lease:unrecorded /m);
      expect(s.out).toMatch(new RegExp(`holder pid ${c.pid} flock`));
      const l = await cli("lock acme --kill");
      expect(l.code, l.text).toBe(76);
      expect(l.err).toMatch(/未登记的进程持有/);
      expect(l.err).toMatch(new RegExp(`持有者 pid ${c.pid} flock`));
      const u = await cli("unlock acme", { tty: true });
      expect(u.code, u.text).toBe(76);
      expect(u.text).not.toMatch(/Password/);
      expect(existsSync(`/proc/${c.pid}`)).toBe(true);
    }, 30_000);

    it("corrupt record: every mount entry and lock refuse 76 (fail closed), status points at the file", async () => {
      writeFileSync(recordFile(), "garbage", { mode: 0o600 });
      const u = await cli("unlock acme", { tty: true });
      expect(u.code, u.text).toBe(76);
      expect(u.text).toMatch(/private\.json 无法解析/);
      expect((await cli("lock acme")).code).toBe(76);
      expect((await cli("status acme")).out).toMatch(/private:corrupt-record/);
      expect(existsSync(recordFile())).toBe(true);
    }, 30_000);

    it("caller inside the record's ns: lock 76 (cannot finalize itself), unlock 76, status marks it", async () => {
      writeRecord({
        phase: "session",
        supervisor: { pid: 999_990, start: H.readProcStartSync(process.pid) },
        pi: { pid: 999_991, start: 1 },
        ns: { mnt: OWN_NS, user: readlinkSync("/proc/self/ns/user") },
      });
      const l = await cli("lock acme --kill");
      expect(l.code, l.text).toBe(76);
      expect(l.err).toMatch(/不能在私有会话内部收尾自己/);
      const u = await cli("unlock acme", { tty: true });
      expect(u.code, u.text).toBe(76);
      expect(u.text).toMatch(/本进程就在该库的私有会话/);
      const s = await cli("status acme");
      expect(s.out).toMatch(/\(this process is inside the private namespace\)/);
    }, 30_000);
  },
);

describe.skipIf(!HAVE_FLOCK || !HAVE_USERNS || !which("script"))(
  "CLI against a fake live instance in its own ns",
  () => {
    it("session: status shows it (pi pid, lease held, members), plain lock refuses 76 with the pi pid", async () => {
      const f = await fakeInstance();
      writeRecord({
        phase: "session",
        supervisor: f.sup,
        pi: f.sup,
        ns: { mnt: f.nsMnt, user: f.nsUser },
      });
      const s = await cli("status acme");
      expect(s.out).toMatch(/^acme: private  layout ok  mnt /m);
      expect(s.out).toMatch(
        new RegExp(
          `private: session · pi ${f.sup.pid} · supervisor ${f.sup.pid} · ns ${f.nsMnt.replace(/[[\]]/g, "\\$&")}`,
        ),
      );
      expect(s.out).toMatch(/^ {2}lease: held$/m);
      expect(s.out).toMatch(/^ {2}outside view: not mounted · sentinels ok$/m);
      expect(s.out).toMatch(/^ {2}ns members: 1$/m);
      expect(s.out).not.toMatch(/cwd-in-vault/);
      const l = await cli("lock acme");
      expect(l.code, l.text).toBe(76);
      expect(l.err).toMatch(new RegExp(`会话仍在运行（pi pid ${f.sup.pid}）`));
      // The vault path is not mounted in that ns (no FUSE here) ⇒ --lazy has nothing to detach:
      // reported as detached, NOTHING is signalled (the fake supervisor has no SIGUSR2 handler).
      const lz = await cli("lock acme --lazy");
      expect(lz.code, lz.text).toBe(0);
      expect(lz.out).toContain(H.LAZY_DETACHED_TEXT);
      expect(existsSync(`/proc/${f.sup.pid}`)).toBe(true);
      expect(existsSync(recordFile())).toBe(true);
    }, 30_000);

    it("--kill: TERM to the verified supervisor, then waits for the instance to go (stale ⇒ released) ⇒ 0", async () => {
      const f = await fakeInstance();
      writeRecord({ phase: "session", supervisor: f.sup, pi: f.sup, ns: { mnt: f.nsMnt, user: f.nsUser } });
      const k = await cli("lock acme --kill");
      expect(k.code, k.text).toBe(0);
      expect(k.out).toMatch(new RegExp(`已通知监督进程（pid ${f.sup.pid}）结束会话并收尾`));
      expect(existsSync(`/proc/${f.sup.pid}`)).toBe(false);
      expect(existsSync(recordFile())).toBe(false);
      expect(spawnSync("flock", ["-n", v.lease, "true"]).status).toBe(0);
    }, 30_000);

    it("--kill never signals a recycled identity: wrong starttime ⇒ nothing signalled, re-judged", async () => {
      const f = await fakeInstance();
      const fake = { pid: f.sup.pid, start: f.sup.start + 1 };
      writeRecord({ phase: "session", supervisor: fake, pi: fake, ns: { mnt: f.nsMnt, user: f.nsUser } });
      const k = await cli("lock acme --kill");
      expect(existsSync(`/proc/${f.sup.pid}`)).toBe(true); // untouched
      expect(k.code, k.text).not.toBe(0);
    }, 30_000);
  },
);

// ───────────────────────────── real: gocryptfs + unshare (self-gated) ─────────────────────────────

const HAVE_REAL =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "script", "unshare", "umount"].every(which) &&
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0 &&
  spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "true"]).status === 0;

describe.skipIf(!HAVE_REAL)("N2 real: command surface against real --private instances", () => {
  let releaseGocryptfsLock: (() => void) | undefined;
  beforeAll(async () => {
    releaseGocryptfsLock = await acquireGocryptfsTestLock();
  }, 250_000);
  afterAll(() => releaseGocryptfsLock?.());
  const PW = "TESTPASS-fake-not-a-secret";

  function fakePi(r: string): { bin: string; rec: string } {
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
    const rec = join(r, "pi.json");
    writeFileSync(
      join(pkg, "dist", "cli.js"),
      `#!/usr/bin/env node
import fs from "node:fs"; import { spawnSync } from "node:child_process";
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
process.on("SIGTERM", () => process.exit(143));
// N2 review: run "pi-secure status acme" from INSIDE the session when a trigger file appears.
// cwd "/" and PWD=/ so neither the child nor bash ever touches the (possibly stopped) mount.
const trig = process.env.FAKE_PI_TRIGGER;
if (trig) {
  const done = new Set();
  setInterval(() => {
    for (const n of [1, 2, 3]) {
      if (done.has(n) || !fs.existsSync(trig + "." + n)) continue;
      done.add(n);
      const t0 = Date.now();
      const r = spawnSync(process.env.FAKE_PI_STATUS_BIN, ["status", "acme"], {
        cwd: "/", env: { ...process.env, PWD: "/" }, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
      fs.writeFileSync(trig + "." + n + ".out", JSON.stringify({ ms: Date.now() - t0, code: r.status,
        signal: r.signal, out: r.stdout, err: r.stderr }));
    }
  }, 100);
}
setTimeout(() => process.exit(Number(process.env.FAKE_PI_EXIT ?? 0)), Number(process.env.FAKE_PI_SLEEP ?? 0));
`,
    );
    chmodSync(join(pkg, "dist", "cli.js"), 0o755);
    mkdirSync(join(r, "bin"));
    symlinkSync(join(pkg, "dist", "cli.js"), join(r, "bin", "pi"));
    symlinkSync(process.execPath, join(r, "bin", "node"));
    return { bin: join(r, "bin"), rec };
  }

  function setup() {
    const r = tmp("ps-n2-real-");
    const h = join(r, "home");
    mkdirSync(h, { mode: 0o700 });
    const { bin, rec } = fakePi(r);
    const dir = join(h, ".local", "share", "pi-toolkit-secure", "acme");
    const mnt = join(h, "secure", "acme");
    mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
    for (const p of [join(h, ".local"), join(h, ".local", "share"), dirname(dir), dir, join(dir, "cipher")])
      chmodSync(p, 0o700);
    mkdirSync(join(h, "secure"), { mode: 0o700 });
    mkdirSync(mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(mnt, n), "");
      chmodSync(join(mnt, n), 0o400);
    }
    writeFileSync(join(r, "pf"), `${PW}\n`, { mode: 0o600 });
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
    expect(gi.status).toBe(0);
    writeFileSync(join(dir, "mount.lock"), "", { mode: 0o600 });
    writeFileSync(join(dir, "mount.lease"), "", { mode: 0o600 });
    mkdirSync(join(h, ".pi", "agent"), { recursive: true });
    writeFileSync(join(h, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ secure: { vaults: { acme: {} } } }));
    return { r, h, dir, mnt, rec, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: h, LANG: "C.UTF-8", TMPDIR: tmpdir() } };
  }
  type Env = { r: string; h: string; dir: string; mnt: string; rec: string; env: Record<string, string> };

  /** Launcher through script(1); types PW at every "Password:"/"Repeat:" prompt. */
  function tty(e: Env, args: string, extra: Record<string, string> = {}, killAfterMs = 90_000) {
    return new Promise<{ code: number | null; text: string; ms: number }>((res) => {
      const t0 = Date.now();
      const c = spawn("script", ["-qefc", `${BIN} ${args}`, "/dev/null"], {
        env: { ...e.env, ...extra },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      let typed = 0;
      const on = (b: Buffer) => {
        text += b.toString();
        const prompts = text.split(/Password:|Repeat:/).length - 1;
        while (typed < prompts) {
          typed++;
          c.stdin.write(`${PW}\r`);
        }
      };
      c.stdout.on("data", on);
      c.stderr.on("data", on);
      const t = setTimeout(() => c.kill("SIGKILL"), killAfterMs);
      c.on("close", (code) => {
        clearTimeout(t);
        res({ code, text: text.replace(/\r/g, ""), ms: Date.now() - t0 });
      });
    });
  }
  function plain(e: Env, args: string) {
    const r = spawnSync("sh", ["-c", `exec ${BIN} ${args} </dev/null`], {
      env: e.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
  }
  const recordOf = (e: Env) => JSON.parse(readFileSync(join(e.dir, "private.json"), "utf8"));
  const leaseFree = (e: Env) => spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status === 0;
  const globalMounted = (mnt: string) => readFileSync("/proc/self/mountinfo", "utf8").includes(` ${mnt} `);
  async function untilPhase(e: Env, phase: string, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      try {
        if (recordOf(e).phase === phase) return;
      } catch {
        /* not yet */
      }
      if (Date.now() > end) throw new Error(`phase ${phase} never reached`);
      await sleep(50);
    }
  }
  async function awaitNoForeignGocryptfs(ctx: { skip: () => void }, mine: string): Promise<void> {
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

  it("during a session: status shows it, plain unlock 76 without a prompt, lock 76 with the pi pid; exit cleans up", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const run = tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "9000", FAKE_PI_EXIT: "4" });
    await untilPhase(e, "session");
    const rec = recordOf(e);
    const s = plain(e, "status acme");
    expect(s.out).toMatch(/^acme: private  layout ok  mnt /m);
    expect(s.out).toContain(
      `private: session · pi ${rec.pi.pid} · supervisor ${rec.supervisor.pid} · gocryptfs ${rec.gocryptfs.pid} · ns ${rec.ns.mnt}`,
    );
    expect(s.out).toMatch(/^ {2}lease: held$/m);
    expect(s.out).toMatch(/^ {2}outside view: not mounted · sentinels ok$/m);
    expect(s.out).toMatch(/^ {2}ns members: \d+$/m);
    expect(s.out).toContain(`  boundary: ${H.PRIVATE_BOUNDARY_SHORT}`);
    const u = await tty(e, "unlock acme");
    expect(u.code, u.text).toBe(76);
    expect(u.text).toContain(`pi pid ${rec.pi.pid}`);
    expect(u.text).not.toMatch(/Password:/);
    const l = plain(e, "lock acme");
    expect(l.code, l.text).toBe(76);
    expect(l.err).toContain(`会话仍在运行（pi pid ${rec.pi.pid}）`);
    const pr = await tty(e, "run acme --private -- again");
    expect(pr.code, pr.text).toBe(76);
    expect(pr.text).not.toMatch(/Password:/);
    const r = await run;
    expect(r.code, r.text).toBe(4);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(leaseFree(e)).toBe(true);
    expect(globalMounted(e.mnt)).toBe(false);
    expect(plain(e, "status acme").out).toMatch(/^acme: locked  layout ok/m);
  }, 120_000);

  it("lock --kill ends the session (P1 TERMs pi, finalizes in-ns, P0 releases) ⇒ 0, nothing left", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const run = tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
    await untilPhase(e, "session");
    const piPid = recordOf(e).pi.pid;
    const t0 = Date.now();
    const k = plain(e, "lock acme --kill");
    expect(k.code, k.text).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(k.text).not.toMatch(/外部收尾/);
    const r = await run;
    expect(r.code, r.text).toBe(143);
    expect(existsSync(`/proc/${piPid}`)).toBe(false);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(leaseFree(e)).toBe(true);
  }, 120_000);

  it("lock --lazy detaches the path inside the ns (verified via /proc/<P1>/mountinfo), honest wording; session continues", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const run = tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "7000", FAKE_PI_EXIT: "0" });
    await untilPhase(e, "session");
    const rec = recordOf(e);
    const mi0 = readFileSync(`/proc/${rec.supervisor.pid}/mountinfo`, "utf8");
    expect(H.vaultMountState(mi0, rec.realMnt, rec.realCipher)).toBe("mounted");
    const z = plain(e, "lock acme --lazy");
    expect(z.code, z.text).toBe(0);
    expect(z.out).toContain(H.LAZY_DETACHED_TEXT);
    const mi1 = readFileSync(`/proc/${rec.supervisor.pid}/mountinfo`, "utf8");
    expect(H.vaultMountState(mi1, rec.realMnt, rec.realCipher)).toBe("absent");
    await sleep(500);
    expect(recordOf(e).lazyDetachedAt).toEqual(expect.any(String));
    expect(plain(e, "status acme").out).toMatch(/lazy-detached /);
    expect(existsSync(`/proc/${rec.pi.pid}`)).toBe(true); // --lazy never ends the session
    const again = plain(e, "lock acme --lazy");
    expect(again.code, again.text).toBe(0); // already detached ⇒ reported, nothing signalled
    const r = await run;
    expect(r.code, r.text).toBe(0);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(leaseFree(e)).toBe(true);
  }, 120_000);

  it("review N2 #1/#2: status from INSIDE the session (real nested userns): layout ok, then bounded with gocryptfs SIGSTOPped; nothing modified", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const trig = join(e.r, "trig");
    const run = tty(e, "run acme --private -- hi", {
      FAKE_PI_SLEEP: "40000",
      FAKE_PI_EXIT: "6",
      FAKE_PI_TRIGGER: trig,
      FAKE_PI_STATUS_BIN: BIN,
    });
    await untilPhase(e, "session");
    const rec = recordOf(e);
    const result = async (n: number, ms = 40_000) => {
      writeFileSync(`${trig}.${n}`, "");
      const end = Date.now() + ms;
      while (!existsSync(`${trig}.${n}.out`)) {
        if (Date.now() > end) throw new Error(`status ${n} never answered`);
        await sleep(100);
      }
      await sleep(50);
      return JSON.parse(readFileSync(`${trig}.${n}.out`, "utf8"));
    };
    let stopped = false;
    try {
      // #2: healthy vault seen from the nested userns — host root reads as the overflow uid there
      const a = await result(1);
      expect(a.code, a.out + a.err).toBe(0);
      expect(a.out).toMatch(/^acme: private  layout ok  mnt /m);
      expect(a.out).not.toMatch(/属于其他用户/);
      expect(a.out).toMatch(/ancestors: n\/a for \d+ level\(s\)/);
      expect(a.out).toMatch(/\(this process is inside the private namespace\)/);
      // #1: gocryptfs stops answering ⇒ status still ends, within its own probe budgets
      process.kill(rec.gocryptfs.pid, "SIGSTOP");
      stopped = true;
      const b = await result(2);
      expect(b.signal, b.out + b.err).toBeNull();
      expect(b.code, b.out + b.err).toBe(0);
      expect(b.ms).toBeLessThan(15_000);
      expect(b.out).toMatch(/^acme: private  layout ok  mnt /m);
      expect(b.out).toMatch(/挂载探测超时（gocryptfs 无响应？）：未检查挂载点内容/);
      // status is read-only: same record, same live gocryptfs, still no global mount
      expect(recordOf(e)).toEqual(rec);
      expect(H.readProcStartSync(rec.gocryptfs.pid)).toBe(rec.gocryptfs.start);
      expect(globalMounted(e.mnt)).toBe(false);
    } finally {
      if (stopped) process.kill(rec.gocryptfs.pid, "SIGCONT");
    }
    // let the session end normally
    process.kill(rec.pi.pid, "SIGTERM");
    const r = await run;
    expect(r.code, r.text).toBe(143);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(leaseFree(e)).toBe(true);
  }, 150_000);

  it("init --private: registers private:true, builds dirs + sessionDir inside the ns, ends unmounted and free; --fix-settings likewise", async (ctx) => {
    const r = tmp("ps-n2-init-");
    const h = join(r, "home");
    mkdirSync(h, { mode: 0o700 });
    const { bin } = fakePi(r);
    const e: Env = {
      r,
      h,
      dir: join(h, ".local", "share", "pi-toolkit-secure", "acme"),
      mnt: join(h, "secure", "acme"),
      rec: "",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: h, LANG: "C.UTF-8", TMPDIR: tmpdir() },
    };
    await awaitNoForeignGocryptfs(ctx, e.r);
    const i = await tty(e, "init acme --private", {}, 120_000);
    expect(i.code, i.text).toBe(0);
    expect(i.text).toMatch(/首次私有挂载以建立目录结构/);
    expect(i.text).toContain("明文挂载只存在于本次 pi 进程树的私有挂载命名空间里");
    expect(i.text).toMatch(/完成：私有保险库 acme/);
    const settings = JSON.parse(readFileSync(join(h, ".pi", "agent", "pi-subagent.json"), "utf8"));
    expect(settings.secure.vaults.acme).toEqual({ dir: e.dir, mnt: e.mnt, private: true });
    expect(globalMounted(e.mnt)).toBe(false);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(leaseFree(e)).toBe(true);
    expect(readFileSync(join(e.mnt, "work"), "utf8")).toBe(""); // sentinel back in place
    // plain unlock is refused by default (Q5)
    expect((await tty(e, "unlock acme")).code).toBe(64);
    // look inside with a test-side mount: dirs + sessionDir were made in the ns
    writeFileSync(join(r, "pf"), `${PW}\n`, { mode: 0o600 });
    const look = join(r, "look");
    mkdirSync(look, { mode: 0o700 });
    expect(spawnSync("gocryptfs", ["-q", "-passfile", join(r, "pf"), "--", join(e.dir, "cipher"), look]).status).toBe(
      0,
    );
    try {
      const ps = JSON.parse(readFileSync(join(look, "work", ".pi", "settings.json"), "utf8"));
      expect(ps.sessionDir).toBe(join(e.mnt, "state", "sessions", "default"));
      expect(existsSync(join(look, "state", "sessions", "default"))).toBe(true);
      writeFileSync(join(look, "work", ".pi", "settings.json"), JSON.stringify({ sessionDir: "/elsewhere" }));
    } finally {
      spawnSync("fusermount3", ["-u", look]);
    }
    // a conflicting sessionDir ⇒ --fix-settings rewrites it inside the ns, then unmounts
    const f = await tty(e, "init acme --fix-settings", {}, 120_000);
    expect(f.code, f.text).toBe(0);
    expect(f.text).toMatch(/已改写 sessionDir/);
    expect(f.text).toMatch(/sessionDir 已对齐（在私有命名空间内完成，已卸载）/);
    expect(globalMounted(e.mnt)).toBe(false);
    expect(leaseFree(e)).toBe(true);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
  }, 180_000);
});
