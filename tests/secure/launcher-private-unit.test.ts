/**
 * N1 — `pi-secure run --private` launcher core (private-plan r3 §2–§3, §6.1).
 *
 * Unit + barrier-concurrency tests for helper.mjs's private mode. Everything runs under ONE private
 * mktemp HOME (process.env.HOME is swapped for this worker so the record subcommands spawned via
 * flock resolve the fake vault, never the user's ~/.pi); nothing is mounted except in the
 * self-gated "real" block at the bottom (real gocryptfs + real unshare, fake passfile password
 * typed through script(1), fake pi).
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
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const require = createRequire(import.meta.url);

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
const PI_ARGS = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);
const HELPER_SRC = readFileSync(HELPER, "utf8");
// #56 ⑩-S: the --private command bodies live in private.mjs, the in-ns finalize steps in finalize.mjs
// (helper.mjs loads both lazily); the source pins below follow the code there.
const PRIVATE_SRC = readFileSync(join(dirname(HELPER), "private.mjs"), "utf8");
const FINALIZE_SRC = readFileSync(join(dirname(HELPER), "finalize.mjs"), "utf8");

const which = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
const HAVE_FLOCK = process.platform === "linux" && which("flock");

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

// ───────────────────────────── shared fake vault ─────────────────────────────

const ORIG_HOME = process.env.HOME;
let root = "";
let home = "";
let v: Record<string, string> = {};
const OWN_NS = readlinkSync("/proc/self/ns/mnt");
const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
/** A supervisor identity that starts with this worker: older non-dumpable same-uid processes predate it. */
const SUP = () => ({ pid: 999_990, start: H.readProcStartSync(process.pid) as number });

beforeAll(() => {
  root = tmp("ps-n1-");
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
  writeFileSync(join(home, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ secure: { vaults: { acme: {} } } }));
  v = H.parseSecureConfig({ secure: { vaults: { acme: {} } } }, home).vaults[0];
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
});

function leaseId() {
  return H.leaseIdentitySync(v);
}
function baseRecord(over: Record<string, unknown> = {}) {
  const li = leaseId();
  const p = H.physicalPaths(v);
  return {
    v: 3,
    instanceId: ID_A,
    name: "acme",
    phase: "starting",
    mode: "run",
    bootId: BOOT,
    createdAt: new Date().toISOString(),
    realCipher: p.realCipher,
    realMnt: p.realMnt,
    lease: { dev: li.dev, ino: li.ino },
    owner: { pid: 999_999, start: 1 },
    ...over,
  };
}
const recordFile = () => join(v.dir, "private.json");
const readRecord = () => JSON.parse(readFileSync(recordFile(), "utf8"));
function liveIdentity(c: ChildProcess) {
  return { pid: c.pid!, start: H.readProcStartSync(c.pid) as number };
}

// ───────────────────────────── parity (helper side) ─────────────────────────────

describe("parity: helper parsePrivateRecord matches the shared fixture", () => {
  const fx = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "secure-contract-parity.json"), "utf8")) as {
    privateRecord: Array<{ name: string; text: string; expect: unknown }>;
  };
  for (const c of fx.privateRecord)
    it(c.name, () => expect(JSON.parse(JSON.stringify(H.parsePrivateRecord(c.text)))).toEqual(c.expect));
});

// ───────────────────────────── §1.1 run flags ─────────────────────────────

describe("parseRunFlags (§1.1 fixed order; F1b frozen)", () => {
  const oldSplit = (rest: string[]) => {
    if (rest[0] === "-C") {
      if (rest.length < 2) return "ERR";
      return { sub: rest[1], piArgs: rest.slice(2) };
    }
    return { sub: undefined, piArgs: rest };
  };
  const newSplit = (rest: string[]) => {
    try {
      const r = H.parseRunFlags(rest);
      return { sub: r.sub, piArgs: r.piArgs, private: r.private };
    } catch (e) {
      return `ERR${(e as { code: number }).code}`;
    }
  };
  const same: string[][] = [
    [],
    ["hello"],
    ["-C", "a"],
    ["-C"],
    ["-C", "a", "-C", "b"],
    ["--", "--private"],
    ["-C", "sub", "--private"],
    ["-C", "sub", "--no-private", "x"],
    ["hello", "--private"],
    ["please use --private mode"],
    ["--session-dir", "x"],
    ["-p", "--private"],
  ];
  for (const rest of same)
    it(`without the new flags the split equals the old code: ${JSON.stringify(rest)}`, () => {
      const o = oldSplit(rest);
      const n = newSplit(rest);
      if (o === "ERR") expect(n).toBe("ERR2");
      else expect(n).toEqual({ ...o, private: undefined });
    });
  it("--private / --no-private only right after the name, then -C keeps its first-position rule", () => {
    expect(newSplit(["--private"])).toEqual({ sub: undefined, piArgs: [], private: true });
    expect(newSplit(["--no-private", "-C", "x", "m"])).toEqual({ sub: "x", piArgs: ["m"], private: false });
    expect(newSplit(["--private", "--", "-C", "x"])).toEqual({
      sub: undefined,
      piArgs: ["--", "-C", "x"],
      private: true,
    });
    expect(newSplit(["--private", "-C", "a", "-C", "b"])).toEqual({ sub: "a", piArgs: ["-C", "b"], private: true });
    expect(newSplit(["--private", "-C"])).toBe("ERR2");
  });
  it("both flags (or one twice) ⇒ usage error 2", () => {
    expect(newSplit(["--private", "--no-private"])).toBe("ERR2");
    expect(newSplit(["--no-private", "--private"])).toBe("ERR2");
    expect(newSplit(["--private", "--private"])).toBe("ERR2");
  });
});

// ───────────────────────────── /proc parsing ─────────────────────────────

describe("/proc facts", () => {
  it("parseProcStat survives spaces and parens in comm; reads starttime (field 22)", () => {
    const f = Array.from({ length: 50 }, (_, i) => String(i + 3));
    f[0] = "S";
    const st = H.parseProcStat(`123 (a (b) c) ${f.join(" ")}`);
    expect(st).toEqual({ state: "S", ppid: 4, pgrp: 5, sid: 6, start: 22 });
    expect(H.parseProcStat("garbage")).toBeUndefined();
    expect(H.readProcStartSync(process.pid)).toBeGreaterThan(0);
  });
  it("devMajMin inverts devFromMajMin (glibc encoding) and decodes large majors/minors", () => {
    for (const [maj, min] of [
      [8, 1],
      [0, 54],
      [259, 3],
      [4095, 255],
      [254, 70000],
    ])
      expect(H.devMajMin(H.devFromMajMin(maj, min))).toEqual({ maj, min });
    // maj > 0xfff lives above bit 32 (devFromMajMin's 32-bit OR cannot build it — see N1-report residuals)
    const big = ((5000n & 0xfffn) << 8n) | ((5000n & ~0xfffn) << 32n) | (70000n & 0xffn) | ((70000n & ~0xffn) << 12n);
    expect(H.devMajMin(Number(big))).toEqual({ maj: 5000, min: 70000 });
  });
  it("/proc/locks: hex devices, waiters (->) and POSIX locks never count as the lease", () => {
    const text = [
      "1: FLOCK  ADVISORY  WRITE 4242 103:02:777 0 EOF",
      "1: -> FLOCK  ADVISORY  WRITE 5555 08:01:145137 0 EOF",
      "2: POSIX  ADVISORY  WRITE 4243 08:01:145137 0 EOF",
      "3: OFDLCK ADVISORY  READ  -1 08:01:145137 0 EOF",
    ].join("\n");
    const e = H.parseProcLocks(text);
    expect(e[0]).toMatchObject({ type: "FLOCK", maj: 0x103, min: 2, ino: 777, blocked: false });
    expect(e[1]).toMatchObject({ blocked: true });
    expect(H.leaseHeldIn(text, { dev: "259:2", ino: 777 })).toBe(true);
    expect(H.leaseHeldIn(text, { dev: "8:1", ino: 145137 })).toBe(false);
    expect(H.leaseHeldIn(text + "\n4: FLOCK ADVISORY WRITE 1 08:01:145137 0 EOF", { dev: "8:1", ino: 145137 })).toBe(
      true,
    );
  });
  it.skipIf(!HAVE_FLOCK)("probeLease sees a real flock holder by inode; unreadable /proc ⇒ unknown", async () => {
    const li = leaseId();
    expect(await H.probeLease(li)).toBe("free");
    holder("flock", [v.lease, "sleep", "30"]);
    await sleep(300);
    expect(await H.probeLease(li)).toBe("held");
    killAll();
    await sleep(200);
    expect(await H.probeLease(li)).toBe("free");
    expect(await H.probeLease(li, { procRoot: join(root, "no-proc") })).toBe("unknown");
    expect(await H.probeLease(undefined)).toBe("unknown");
  });
});

// ───────────────────────────── record IO + CAS ─────────────────────────────

describe("private.json IO and CAS (§3.2)", () => {
  it("exclusive create, round-trip, second create ⇒ EEXIST", async () => {
    const rec = baseRecord();
    H.writePrivateRecordExclusive(v, rec);
    expect(H.readPrivateRecordSync(v)).toEqual({ kind: "ok", record: rec });
    expect(await H.readPrivateRecord(v)).toEqual({ kind: "ok", record: rec });
    expect(() => H.writePrivateRecordExclusive(v, baseRecord({ instanceId: ID_B }))).toThrow(/EEXIST/);
    expect(readRecord().instanceId).toBe(ID_A);
  });
  it("symlink / oversize / bad JSON / v≠3 ⇒ corrupt (fail closed); absent ⇒ none", async () => {
    expect(H.readPrivateRecordSync(v)).toEqual({ kind: "none" });
    const other = join(root, "elsewhere.json");
    writeFileSync(other, JSON.stringify(baseRecord()));
    symlinkSync(other, recordFile());
    expect(H.readPrivateRecordSync(v)).toMatchObject({ kind: "corrupt", reason: "not-regular" });
    expect(await H.readPrivateRecord(v)).toMatchObject({ kind: "corrupt" });
    rmSync(recordFile());
    writeFileSync(recordFile(), "x".repeat(5000), { mode: 0o600 });
    expect(H.readPrivateRecordSync(v)).toMatchObject({ kind: "corrupt", reason: "size" });
    writeFileSync(recordFile(), "{nope", { mode: 0o600 });
    expect(H.readPrivateRecordSync(v)).toMatchObject({ kind: "corrupt", reason: "json" });
    writeFileSync(recordFile(), JSON.stringify(baseRecord({ v: 2 })), { mode: 0o600 });
    expect(H.readPrivateRecordSync(v)).toMatchObject({ kind: "corrupt", reason: "field:v" });
  });
  it("applyRecordPatch: instanceId mismatch never writes; immutable keys and backward phases refused", () => {
    const cur = baseRecord() as never;
    expect(H.applyRecordPatch(cur, ID_B, { phase: "mounting" })).toEqual({ error: "mismatch" });
    expect(H.applyRecordPatch(cur, ID_A, { owner: { pid: 2, start: 2 } })).toEqual({ error: "patch:owner" });
    expect(H.applyRecordPatch(cur, ID_A, { instanceId: ID_B })).toEqual({ error: "patch:instanceId" });
    expect(H.applyRecordPatch(cur, ID_A, { phase: "session" }).error).toMatch(/^phase:/);
    const ok = H.applyRecordPatch(cur, ID_A, { phase: "mounting", supervisor: { pid: 9, start: 9 } });
    expect(ok.record).toMatchObject({ phase: "mounting", supervisor: { pid: 9, start: 9 } });
    expect(H.applyRecordPatch(ok.record, ID_A, { phase: "starting" }).error).toMatch(/^phase:/);
    expect(H.applyRecordPatch(ok.record, ID_A, { ns: { mnt: "bogus", user: "user:[1]" } }).error).toMatch(/^invalid/);
  });
  it.skipIf(!HAVE_FLOCK)("updateRecord (real flock child): CAS by instanceId; a foreign id never writes", async () => {
    H.writePrivateRecordExclusive(v, baseRecord());
    expect(await H.updateRecord(v, ID_B, { phase: "mounting" })).toBe("mismatch");
    expect(readRecord().phase).toBe("starting");
    expect(await H.updateRecord(v, ID_A, { phase: "mounting", supervisor: { pid: 4, start: 4 } })).toBe("ok");
    expect(readRecord()).toMatchObject({ phase: "mounting", supervisor: { pid: 4, start: 4 } });
    rmSync(recordFile());
    expect(await H.updateRecord(v, ID_A, { phase: "launching" })).toBe("mismatch");
    expect(existsSync(recordFile())).toBe(false); // never resurrects a record
  });
  it.skipIf(!HAVE_FLOCK)("updateRecord is bounded when mount.lock is held elsewhere (≤ ~2 s) ⇒ failed", async () => {
    H.writePrivateRecordExclusive(v, baseRecord());
    holder("flock", [v.lock, "sleep", "30"]);
    await sleep(200);
    const t0 = Date.now();
    expect(await H.updateRecord(v, ID_A, { phase: "mounting" })).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(readRecord().phase).toBe("starting");
  });
});

// ───────────────────────────── release protocol (I-P3) ─────────────────────────────

describe.skipIf(!HAVE_FLOCK)("releaseRecord — the only deleter (§3.2, I-P3)", () => {
  it("lease held by another holder ⇒ lease-busy within the wait, record kept", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ phase: "mounting", ns: { mnt: "mnt:[1]", user: "user:[1]" }, supervisor: SUP() }),
    );
    holder("flock", [v.lease, "sleep", "30"]);
    await sleep(200);
    const t0 = Date.now();
    expect(await H.releaseRecord(v, ID_A, { waitMs: 500 })).toEqual({ kind: "lease-busy" });
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(existsSync(recordFile())).toBe(true);
  });
  it("instanceId mismatch ⇒ kept; ns with live members (this very process) ⇒ kept and members listed", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ phase: "finalizing", ns: { mnt: OWN_NS, user: "user:[1]" }, supervisor: SUP() }),
    );
    expect(await H.releaseRecord(v, ID_B, { waitMs: 300 })).toEqual({ kind: "mismatch" });
    const r = await H.releaseRecord(v, ID_A, { waitMs: 300 });
    expect(r.kind).toBe("members");
    expect(r.members.length).toBeGreaterThan(0);
    expect(existsSync(recordFile())).toBe(true);
  });
  it("lease free ∧ empty ns ⇒ released; a different boot ⇒ released even when the ns id matches", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ phase: "finalizing", ns: { mnt: "mnt:[1]", user: "user:[1]" }, supervisor: SUP() }),
    );
    const t0 = Date.now();
    expect(await H.releaseRecord(v, ID_A)).toEqual({ kind: "released" });
    expect(Date.now() - t0).toBeLessThan(1_000); // normal path: lease taken at once (§3.6 «<1 s»)
    expect(existsSync(recordFile())).toBe(false);
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ bootId: "other-boot", ns: { mnt: OWN_NS, user: "user:[1]" }, supervisor: SUP() }),
    );
    expect(await H.releaseRecord(v, ID_A)).toEqual({ kind: "released" });
    expect(await H.releaseRecord(v, ID_A)).toEqual({ kind: "none" });
  });
  it.skipIf(!which("python3"))(
    "r3.2 (real): a same-uid NON-DUMPABLE process OUTSIDE the vault lineage (sshd-session case) ⇒ skipped, released",
    async () => {
      const nd = holder("python3", ["-c", "import ctypes,time; ctypes.CDLL(None).prctl(4,0,0,0,0); time.sleep(30)"]);
      await sleep(400);
      let denied = false;
      try {
        readlinkSync(`/proc/${nd.pid}/ns/mnt`);
      } catch (e) {
        denied = (e as { code?: string }).code === "EACCES";
      }
      expect(denied).toBe(true); // the premise: the kernel refuses the ns link of a non-dumpable process
      H.writePrivateRecordExclusive(
        v,
        baseRecord({
          phase: "finalizing",
          ns: { mnt: "mnt:[1]", user: "user:[1]" },
          supervisor: SUP(),
          inNsDone: true,
        }),
      );
      // the holder's chain is holder → vitest worker (start = SUP.start but pid ≠ the recorded
      // anchor) → vitest main (start < minStart) ⇒ OUT by lineage: the scan completes with the
      // holder skipped and the record is released (the scan-poison fix, private-plan §3.3 r3.2)
      const r = await H.releaseRecord(v, ID_A, { waitMs: 300 });
      expect(r).toEqual({ kind: "released" });
      expect(existsSync(recordFile())).toBe(false);
    },
  );
  it.skipIf(!which("python3"))(
    "r3.2 (real): a non-dumpable child of the recorded pi (inside the lineage) ⇒ incomplete in-lineage, record kept",
    async () => {
      const nd = holder("python3", ["-c", "import ctypes,time; ctypes.CDLL(None).prctl(4,0,0,0,0); time.sleep(30)"]);
      await sleep(400);
      H.writePrivateRecordExclusive(
        v,
        baseRecord({
          phase: "finalizing",
          ns: { mnt: "mnt:[1]", user: "user:[1]" },
          supervisor: SUP(),
          pi: { pid: process.pid, start: H.readProcStartSync(process.pid) as number }, // this very worker
          inNsDone: true,
        }),
      );
      // holder → this worker == the recorded pi anchor (pid+start) ⇒ IN: the strict fail-closed
      // verdict stays for processes provably inside the instance lineage (P-SP1)
      const r = await H.releaseRecord(v, ID_A, { waitMs: 300 });
      expect(r.kind).toBe("incomplete");
      expect(String(r.reason)).toMatch(new RegExp(`ns ${nd.pid} .*EACCES in-lineage`));
      expect(existsSync(recordFile())).toBe(true);
    },
  );
  it("barrier: two concurrent releases ⇒ exactly one deletes, the other sees none (never a successor)", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ phase: "finalizing", ns: { mnt: "mnt:[1]", user: "user:[1]" }, supervisor: SUP() }),
    );
    const rs = await Promise.all([H.releaseRecord(v, ID_A), H.releaseRecord(v, ID_A)]);
    expect(rs.map((r: { kind: string }) => r.kind).sort()).toEqual(["none", "released"]);
    // a successor's record written afterwards is never touched by a stale releaser
    H.writePrivateRecordExclusive(v, baseRecord({ instanceId: ID_B }));
    expect(await H.releaseRecord(v, ID_A)).toEqual({ kind: "mismatch" });
    expect(readRecord().instanceId).toBe(ID_B);
  });
  it("lock order: holding mount.lock only TRIES the lease (no blocking, no deadlock)", async () => {
    H.writePrivateRecordExclusive(v, baseRecord({ ns: { mnt: "mnt:[1]", user: "user:[1]" } }));
    holder("flock", [v.lease, "sleep", "30"]);
    await sleep(200);
    const t0 = Date.now();
    expect(H.releaseRecordHoldingMountLock(v, ID_A)).toEqual({ kind: "lease-busy" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(existsSync(recordFile())).toBe(true);
  });
  it("§3.2 unique exception (__private-abort-start): only an own `starting` record without ns/supervisor", () => {
    const run = (id: string) =>
      spawnSync("flock", ["-w", "2", v.lock, process.execPath, HELPER, "__private-abort-start", "acme", id], {
        env: process.env,
      }).status;
    H.writePrivateRecordExclusive(v, baseRecord({ supervisor: { pid: 5, start: 5 } }));
    expect(run(ID_A)).toBe(H.REC.MEMBERS);
    expect(existsSync(recordFile())).toBe(true);
    rmSync(recordFile());
    H.writePrivateRecordExclusive(v, baseRecord());
    expect(run(ID_B)).toBe(H.REC.MISMATCH);
    expect(run(ID_A)).toBe(H.REC.OK);
    expect(existsSync(recordFile())).toBe(false);
  });
  it("structural: only __private-release / __private-abort-start delete; the ns-root never releases (spy by source)", () => {
    const callers = [...PRIVATE_SRC.matchAll(/deletePrivateRecordSync\(/g)].length;
    expect(callers).toBe(3); // definition + the two sanctioned callers
    expect(HELPER_SRC).not.toContain("deletePrivateRecordSync"); // nothing else (helper dispatch, record primitives) deletes
    const body = (start: string, end: string) =>
      PRIVATE_SRC.slice(PRIVATE_SRC.indexOf(start), PRIVATE_SRC.indexOf(end));
    const rel = body("async function cmdPrivateRelease", "function cmdPrivateAbortStart");
    const abort = body("function cmdPrivateAbortStart", "async function cmdPrivateTerminate");
    expect(rel).toContain("deletePrivateRecordSync(v)");
    expect(abort).toContain("deletePrivateRecordSync(v)");
    // the ns-root: cmdNsRoot (last function of private.mjs) plus everything it runs from finalize.mjs
    const p1 = PRIVATE_SRC.slice(PRIVATE_SRC.indexOf("async function cmdNsRoot")) + FINALIZE_SRC;
    for (const forbidden of [
      "deletePrivateRecordSync",
      "__private-release",
      "releaseRecord(",
      "unlinkSync(privateRecordPath",
    ])
      expect(p1).not.toContain(forbidden);
  });
});

// ───────────────────────────── ns scan + state matrix (§3.3) ─────────────────────────────

function fakeProc(
  procs: Array<{
    pid: number;
    ns?: string;
    user?: string;
    start: number;
    ppid?: number;
    state?: string;
    comm?: string;
    uid?: number;
  }>,
) {
  const pr = tmp("ps-n1-proc-");
  for (const p of procs) {
    const d = join(pr, String(p.pid));
    mkdirSync(join(d, "ns"), { recursive: true });
    if (p.ns) symlinkSync(p.ns, join(d, "ns", "mnt"));
    symlinkSync(p.user ?? "user:[6]", join(d, "ns", "user"));
    const f = Array.from({ length: 50 }, () => "0");
    f[0] = p.state ?? "S";
    f[1] = String(p.ppid ?? 1);
    f[19] = String(p.start);
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm ?? "x"}) ${f.join(" ")}`);
    writeFileSync(join(d, "comm"), `${p.comm ?? "x"}\n`);
    const u = p.uid ?? process.getuid!();
    writeFileSync(join(d, "status"), `Name:\t${p.comm ?? "x"}\nUid:\t${u}\t${u}\t${u}\t${u}\nGid:\t1\t1\t1\t1\n`);
  }
  return pr;
}
/** fs facade over a fake /proc that injects errno codes for chosen paths (review N1 #1). */
function faultyFs(faults: Record<string, string>) {
  const fail = (p: string) => {
    for (const [suffix, code] of Object.entries(faults))
      if (p.endsWith(suffix)) return Object.assign(new Error(code), { code });
    return undefined;
  };
  const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
  return {
    readdir: (p: string) => fsp.readdir(p),
    readlink: async (p: string) => {
      const e = fail(p);
      if (e) throw e;
      return fsp.readlink(p);
    },
    readFile: async (p: string, enc: BufferEncoding) => {
      const e = fail(p);
      if (e) throw e;
      return fsp.readFile(p, enc);
    },
  };
}

describe("scanNsMembers (never reports an incomplete scan as empty)", () => {
  it("matches ns id, honours minStart and exclude, skips zombies", async () => {
    const pr = fakeProc([
      { pid: 10, ns: "mnt:[7]", start: 100, comm: "p1" },
      { pid: 11, ns: "mnt:[7]", start: 50, comm: "setns-joiner" },
      { pid: 12, ns: "mnt:[7]", start: 150, comm: "job" },
      { pid: 13, ns: "mnt:[8]", start: 150, comm: "other" },
      { pid: 14, ns: "mnt:[7]", start: 160, state: "Z", comm: "zombie" },
      { pid: 15, start: 170, comm: "unreadable" },
    ]);
    const r = await H.scanNsMembers("mnt:[7]", { procRoot: pr, minStart: 100, exclude: [10] });
    expect(r).toEqual({ kind: "done", members: [{ pid: 12, start: 150, ppid: 1, user: "user:[6]", comm: "job" }] });
  });
  it("review N1 #1: only ENOENT/ESRCH mean gone — EACCES/EPERM of a SAME-uid process, EIO anywhere ⇒ incomplete", async () => {
    const procs = [
      { pid: 20, ns: "mnt:[7]", start: 100, comm: "p1" },
      { pid: 21, ns: "mnt:[7]", start: 150, comm: "member" },
      { pid: 22, ns: "mnt:[8]", start: 150, comm: "other-uid", uid: 4242 },
      { pid: 23, ns: "mnt:[8]", start: 50, comm: "old-nondumpable" },
    ];
    const pr = fakeProc(procs);
    const scan = (faults: Record<string, string>) =>
      H.scanNsMembers("mnt:[7]", { procRoot: pr, minStart: 100, fsImpl: faultyFs(faults) });
    // baseline: one member
    expect((await scan({})).members?.map((m: { pid: number }) => m.pid)).toEqual([20, 21]);
    // a same-uid member whose ns link is unreadable is NOT "gone"
    for (const code of ["EACCES", "EPERM", "EIO"])
      expect(await scan({ "/21/ns/mnt": code })).toMatchObject({ kind: "incomplete" });
    // other-uid denial is skipped; a same-uid denial predating the supervisor is skipped (never a member)
    expect((await scan({ "/22/ns/mnt": "EACCES", "/23/ns/mnt": "EACCES" })).kind).toBe("done");
    // ... but the same denial with an unreadable starttime is not
    expect((await scan({ "/23/ns/mnt": "EACCES", "/23/stat": "EIO" })).kind).toBe("incomplete");
    // the supervisor's in-ns view (deniedMeans:"outside") skips denials; EIO stays incomplete
    const inNs = (faults: Record<string, string>) =>
      H.scanNsMembers("mnt:[7]", { procRoot: pr, minStart: 100, fsImpl: faultyFs(faults), deniedMeans: "outside" });
    expect((await inNs({ "/21/ns/mnt": "EACCES" })).kind).toBe("done");
    expect((await inNs({ "/21/ns/mnt": "EIO" })).kind).toBe("incomplete");
    // the deletion gate never uses that mode: structural check on the source
    const relBody = PRIVATE_SRC.slice(
      PRIVATE_SRC.indexOf("async function cmdPrivateRelease"),
      PRIVATE_SRC.indexOf("function cmdPrivateAbortStart"),
    );
    expect(relBody).not.toContain("deniedMeans");
    // the single in-ns use (finalizeInNs) — none in helper.mjs or private.mjs
    expect(
      [HELPER_SRC, PRIVATE_SRC, FINALIZE_SRC].map((t) => [...t.matchAll(/deniedMeans: "outside"/g)].length),
    ).toEqual([0, 0, 1]);
    // status / stat / ns-user failures other than ENOENT ⇒ incomplete; ENOENT/ESRCH ⇒ skipped
    expect((await scan({ "/21/status": "EIO" })).kind).toBe("incomplete");
    expect((await scan({ "/21/status": "EACCES" })).kind).toBe("incomplete");
    expect((await scan({ "/21/stat": "EIO" })).kind).toBe("incomplete");
    expect((await scan({ "/21/ns/user": "EACCES" })).kind).toBe("incomplete");
    const gone = await scan({ "/21/status": "ENOENT" });
    expect(gone.members.map((m: { pid: number }) => m.pid)).toEqual([20]);
    const gone2 = await scan({ "/21/ns/mnt": "ESRCH" });
    expect(gone2.members.map((m: { pid: number }) => m.pid)).toEqual([20]);
  });
  it("review N1 #1: an incomplete scan never releases and never makes a record stale", () => {
    const rec = { kind: "ok", record: baseRecord({ phase: "session", ns: { mnt: "mnt:[7]", user: "user:[6]" } }) };
    expect(
      H.judgePrivateInstance({ record: rec, lease: "free", bootId: BOOT, scan: { kind: "incomplete" }, alive: {} })
        .state,
    ).toBe("unknown");
  });
  it("too many entries / missing /proc / past deadline ⇒ incomplete", async () => {
    const pr = fakeProc([1, 2, 3].map((pid) => ({ pid, ns: "mnt:[7]", start: 1 })));
    expect((await H.scanNsMembers("mnt:[7]", { procRoot: pr, maxEntries: 2 })).kind).toBe("incomplete");
    expect((await H.scanNsMembers("mnt:[7]", { procRoot: join(pr, "nope") })).kind).toBe("incomplete");
    expect((await H.scanNsMembers("mnt:[7]", { procRoot: pr, deadline: Date.now() - 1 })).kind).toBe("incomplete");
  });
});

describe("scanNsMembers lineage (scan-poison, private-plan §3.3 r3.2)", () => {
  // X is always pid 80: same uid, ns link EACCES (injected), start ≥ minStart=100 → deferred to
  // the ppid walk. Anchors default to a pi identity {pid:12, start:105} unless a case overrides.
  const PI_ANCHOR = { pid: 12, start: 105 };
  const scanL = (pr: string, faults: Record<string, string> = {}, over: Record<string, unknown> = {}) =>
    H.scanNsMembers("mnt:[7]", {
      procRoot: pr,
      minStart: 100,
      fsImpl: faultyFs(faults),
      lineage: { anchors: [PI_ANCHOR] },
      ...over,
    });

  it("1. sshd chain: session → root [priv] → boot-time listener ⇒ done, X in outside, members unchanged", async () => {
    const pr = fakeProc([
      { pid: 20, ns: "mnt:[7]", start: 100, comm: "member" },
      { pid: 30, start: 10, comm: "sshd-listener" }, // started at boot: before the supervisor
      { pid: 31, uid: 4242, ns: "mnt:[8]", start: 150, ppid: 30, comm: "sshd-priv" }, // root [priv]
      { pid: 80, start: 150, ppid: 31, comm: "sshd-session" }, // same uid, link EACCES (fault)
    ]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES", "/31/ns/mnt": "EACCES" });
    expect(r).toEqual({
      kind: "done",
      members: [{ pid: 20, start: 100, ppid: 1, user: "user:[6]", comm: "member" }],
      outside: [{ pid: 80, comm: "sshd-session" }],
    });
  });
  it("2. X's ppid is a READABLE ns member (pid 20, mnt:[7]) ⇒ incomplete `in-lineage`", async () => {
    const pr = fakeProc([
      { pid: 20, ns: "mnt:[7]", start: 100, comm: "member" },
      { pid: 80, start: 150, ppid: 20, comm: "x" },
    ]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" });
    expect(r).toMatchObject({ kind: "incomplete" });
    expect(r.reason).toMatch(/^ns 80 x EACCES in-lineage$/);
  });
  it("3. X's ppid matches the recorded pi anchor (pid+start) ⇒ incomplete in-lineage", async () => {
    const pr = fakeProc([
      { pid: 12, start: 105, ppid: 1, comm: "pi" }, // the anchor itself needs no ns link here
      { pid: 80, start: 150, ppid: 12, comm: "x" },
    ]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" });
    expect(r).toMatchObject({ kind: "incomplete" });
    expect(r.reason).toMatch(/in-lineage$/);
  });
  it("4. same anchor pid but a different start (pid reused) is NOT an anchor ⇒ walk continues ⇒ out", async () => {
    const pr = fakeProc([
      { pid: 12, start: 200, ppid: 30, comm: "reused" },
      { pid: 30, start: 10, comm: "old" },
      { pid: 80, start: 250, ppid: 12, comm: "x" },
    ]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" });
    expect(r).toEqual({
      kind: "done",
      members: [],
      outside: [{ pid: 80, comm: "x" }],
    });
  });
  it("5. X reparented to pid 1 (broken chain) ⇒ out — accepted residual R37", async () => {
    const pr = fakeProc([{ pid: 80, start: 150, ppid: 1, comm: "orphan" }]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" });
    expect(r).toEqual({ kind: "done", members: [], outside: [{ pid: 80, comm: "orphan" }] });
  });
  it("6. ancestor stat EIO ⇒ incomplete; ancestor ENOENT twice (race) ⇒ incomplete; parent newer than child (reuse) ⇒ incomplete; X gone on rewalk ⇒ out and NOT in outside (review #3)", async () => {
    const eio = fakeProc([
      { pid: 81, start: 140, ppid: 1, comm: "anc" },
      { pid: 80, start: 150, ppid: 81, comm: "x" },
    ]);
    const rEio = await scanL(eio, { "/80/ns/mnt": "EACCES", "/81/stat": "EIO" });
    expect(rEio).toMatchObject({ kind: "incomplete" });
    expect(rEio.reason).toMatch(/^lineage 81 EIO$/);
    // pid 81 does not exist at all: ENOENT on the walk, rewalk, ENOENT again ⇒ fail closed
    const race = fakeProc([{ pid: 80, start: 150, ppid: 81, comm: "x" }]);
    const rRace = await scanL(race, { "/80/ns/mnt": "EACCES" });
    expect(rRace).toMatchObject({ kind: "incomplete" });
    expect(rRace.reason).toBe("lineage race");
    // a parent can never start after its child ⇒ the pid was reused: one rewalk, then fail closed
    const reuse = fakeProc([
      { pid: 81, start: 400, ppid: 1, comm: "reused-parent" },
      { pid: 80, start: 150, ppid: 81, comm: "x" },
    ]);
    const rReuse = await scanL(reuse, { "/80/ns/mnt": "EACCES" });
    expect(rReuse).toMatchObject({ kind: "incomplete" });
    expect(rReuse.reason).toBe("lineage 81 reuse");
    // the race rewalk finds X itself gone: OUT with no diagnostic (a dead process holds no mount)
    const gone = fakeProc([{ pid: 80, start: 150, ppid: 81, comm: "x" }]); // 81 missing → rewalk
    const real = require("node:fs/promises") as typeof import("node:fs/promises");
    let statReads = 0;
    const vanishingX = {
      readdir: (p: string) => real.readdir(p),
      readlink: async (p: string) => {
        if (p === join(gone, "80", "ns", "mnt")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return real.readlink(p);
      },
      readFile: async (p: string, enc: BufferEncoding) => {
        if (p === join(gone, "80", "stat") && ++statReads > 1)
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return real.readFile(p, enc);
      },
    };
    const rGone = await H.scanNsMembers("mnt:[7]", {
      procRoot: gone,
      minStart: 100,
      fsImpl: vanishingX,
      lineage: { anchors: [PI_ANCHOR] },
    });
    expect(rGone).toEqual({ kind: "done", members: [] }); // no `outside` field at all
  });
  it("7. a ppid cycle never resolves ⇒ incomplete after maxHops (lineage depth)", async () => {
    const pr = fakeProc([
      { pid: 90, start: 150, ppid: 91, comm: "a" },
      { pid: 91, start: 150, ppid: 90, comm: "b" },
      { pid: 80, start: 150, ppid: 90, comm: "x" },
    ]);
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" });
    expect(r).toMatchObject({ kind: "incomplete" });
    expect(r.reason).toBe("lineage depth");
  });
  it("8. X's own link EIO still fails the scan even with lineage; other-uid denial skipped; lineage without minStart ⇒ incomplete", async () => {
    const pr = fakeProc([
      { pid: 84, uid: 4242, ns: "mnt:[8]", start: 150, comm: "other" },
      { pid: 80, start: 150, ppid: 1, comm: "x" },
    ]);
    // EIO is not a ptrace denial (EACCES/EPERM): fail closed before lineage ever applies
    expect(await scanL(pr, { "/80/ns/mnt": "EIO" })).toMatchObject({ kind: "incomplete" });
    // another uid's unreadable link is skipped (never a member without privileges over our userns)
    expect(await scanL(pr, { "/84/ns/mnt": "EACCES" })).toEqual({ kind: "done", members: [] });
    // no minStart (no supervisor recorded): the deferred branch never applies ⇒ incomplete
    const r = await scanL(pr, { "/80/ns/mnt": "EACCES" }, { minStart: undefined });
    expect(r).toMatchObject({ kind: "incomplete" });
    expect(r.reason).toBe("ns 80 EACCES");
  });
  it("9. a deadline expiring mid-walk ⇒ incomplete timeout", async () => {
    const pr = fakeProc([
      { pid: 82, start: 148, ppid: 1, comm: "anc2" },
      { pid: 81, start: 149, ppid: 82, comm: "anc1" },
      { pid: 80, start: 150, ppid: 81, comm: "x" },
    ]);
    const real = require("node:fs/promises") as typeof import("node:fs/promises");
    const slowAncestorStat = {
      readdir: (p: string) => real.readdir(p),
      readlink: async (p: string) => {
        if (p === join(pr, "80", "ns", "mnt")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return real.readlink(p);
      },
      readFile: async (p: string, enc: BufferEncoding) => {
        if (p === join(pr, "81", "stat")) await sleep(300); // the walk stalls on the first ancestor
        return real.readFile(p, enc);
      },
    };
    const r = await H.scanNsMembers("mnt:[7]", {
      procRoot: pr,
      minStart: 100,
      fsImpl: slowAncestorStat,
      deadline: Date.now() + 100,
      lineage: { anchors: [PI_ANCHOR] },
    });
    expect(r).toEqual({ kind: "incomplete", reason: "timeout" });
  });
  it("10. structure: exactly the three authoritative ns-outer callers pass lineage (review #6)", () => {
    expect([...HELPER_SRC.matchAll(/lineage: \{ anchors: recordAnchors\(/g)].length).toBe(2); // judge + outer terminate
    expect([...PRIVATE_SRC.matchAll(/lineage: \{ anchors: recordAnchors\(/g)].length).toBe(1); // __private-release
    expect([...FINALIZE_SRC.matchAll(/lineage: \{ anchors: recordAnchors\(/g)].length).toBe(0); // in-ns: unchanged
  });
});

describe("r3.2 scan-poison: privateInstanceState / terminateInstance with lineage", () => {
  const POISON = { "/58/ns/mnt": "EACCES" }; // pid 58: same uid, unreadable link, start 140 ≥ minStart
  const recOver = { ns: { mnt: "mnt:[7]", user: "user:[6]", innerUser: "user:[8]" } };
  const identities = {
    supervisor: { pid: 50, start: 100 },
    gocryptfs: { pid: 51, start: 120 },
    pi: { pid: 52, start: 130 },
  };
  const stateOf = (procs: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => {
    const pr = fakeProc(procs as never);
    writeFileSync(join(pr, "locks"), ""); // empty /proc/locks ⇒ the lease is free
    const record = { kind: "ok", record: baseRecord({ phase: "session", ...recOver, ...identities, ...over }) };
    return H.privateInstanceState(v, { procRoot: pr, record, fsImpl: faultyFs(POISON) });
  };

  it("a lineage-EXTERNAL unreadable process no longer poisons the judge: supervisor alive ⇒ session, lock --kill ⇒ kill", async () => {
    const s = await stateOf([
      { pid: 50, ns: "mnt:[7]", start: 100, comm: "node" },
      { pid: 51, ns: "mnt:[7]", start: 120, comm: "gocryptfs" },
      { pid: 52, ns: "mnt:[7]", start: 130, ppid: 50, user: "user:[8]", comm: "pi" },
      { pid: 59, start: 10, comm: "old-ancestor" }, // logged in at boot: before the supervisor
      { pid: 58, start: 140, ppid: 59, comm: "sshd-session" }, // 58 → 59 < minStart ⇒ OUT
    ]);
    expect(s.state).toBe("session"); // previously unknown/scan-incomplete (the poison)
    expect(s.scan).toMatchObject({ kind: "done" });
    expect(H.lockPrivateDecision(v, { ...s, inNs: false }, { kill: true }).action).toBe("kill");
  });
  it("…identities dead, lease free, no members ⇒ stale (the rsi-evo residual-record case)", async () => {
    const s = await stateOf([
      { pid: 59, start: 10, comm: "old-ancestor" },
      { pid: 58, start: 140, ppid: 59, comm: "sshd-session" },
    ]);
    expect(s.state).toBe("stale"); // the record can be released while the ssh session lives on
  });
  it("the same process re-hung under the recorded pi ⇒ IN ⇒ unknown/scan-incomplete again", async () => {
    const s = await stateOf([
      { pid: 52, ns: "mnt:[7]", start: 130, ppid: 50, user: "user:[8]", comm: "pi" },
      { pid: 58, start: 140, ppid: 52, comm: "pi-child" }, // 58 → pi anchor (pid+start) ⇒ IN
    ]);
    expect(s.state).toBe("unknown");
    expect(s.reason).toBe("scan-incomplete");
    expect(s.scan).toMatchObject({ kind: "incomplete" });
    expect(s.scan.reason).toMatch(/ns 58 pi-child EACCES in-lineage$/);
  });

  it("terminateInstance: an outside-lineage unreadable process neither blocks nor is ever signalled; readable members still are", async () => {
    const pr = fakeProc([
      { pid: 50, ns: "mnt:[7]", start: 100, comm: "node" },
      { pid: 55, ns: "mnt:[7]", start: 130, ppid: 50, comm: "bgjob" },
      { pid: 59, start: 10, comm: "old-ancestor" },
      { pid: 58, start: 140, ppid: 59, comm: "sshd-session" },
    ]);
    const sent: Array<[number, string]> = [];
    const kill = (pid: number, sig: string) => {
      sent.push([pid, sig]);
      rmSync(join(pr, String(pid)), { recursive: true, force: true }); // dies at once
    };
    const rec = baseRecord({
      phase: "session",
      ...recOver,
      supervisor: identities.supervisor,
      gocryptfs: identities.gocryptfs,
    });
    const r = await H.terminateInstance(rec, {
      deadline: Date.now() + 5_000,
      procRoot: pr,
      kill,
      fsImpl: faultyFs(POISON),
    });
    expect(r.ok).toBe(true);
    expect(sent.map(([p]) => p).sort()).toEqual([50, 55]);
    expect(sent.some(([p]) => p === 58)).toBe(false); // OUT processes are never signalled
    expect(r.unverified ?? []).toEqual([]);
  });
  it("terminateInstance: an IN-lineage unreadable process fails the scan ⇒ nothing signalled", async () => {
    const pr = fakeProc([
      { pid: 52, ns: "mnt:[7]", start: 130, ppid: 50, user: "user:[8]", comm: "pi" },
      { pid: 58, start: 140, ppid: 52, comm: "pi-child" },
    ]);
    const kill = () => {
      throw new Error("must not signal");
    };
    const rec = baseRecord({
      phase: "session",
      ...recOver,
      supervisor: identities.supervisor,
      gocryptfs: identities.gocryptfs,
      pi: identities.pi,
    });
    const r = await H.terminateInstance(rec, {
      deadline: Date.now() + 2_000,
      procRoot: pr,
      kill,
      fsImpl: faultyFs(POISON),
    });
    expect(r).toMatchObject({ ok: false, killed: [] });
    expect(r.incomplete).toMatch(/in-lineage$/);
  });
});

// ─────────── r3.2 kernel premise pins (real; P-SP1 — private-plan §3.3) ───────────

const HAVE_USERNS =
  process.platform === "linux" &&
  which("unshare") &&
  spawnSync("unshare", ["--user", "--map-root-user", "true"]).status === 0;

describe.skipIf(!HAVE_USERNS || !which("python3"))("scan-poison premise pins (P-SP1, private-plan §R3)", () => {
  it("P-SP1: the owner of a child userns still reads /proc/<pid>/ns/mnt of a non-dumpable process in it", async () => {
    const nd = holder("unshare", [
      "--user",
      "--map-root-user",
      "python3",
      "-c",
      "import ctypes,time; ctypes.CDLL(None).prctl(4,0,0,0,0); time.sleep(30)",
    ]);
    await sleep(600);
    let link: string | undefined;
    try {
      link = readlinkSync(`/proc/${nd.pid}/ns/mnt`);
    } catch {
      link = undefined;
    }
    // if this ever fails the lineage reasoning no longer holds: an instance member made
    // non-dumpable would be unreadable to P0 and could be misjudged OUT (plan §8 R-a)
    expect(link).toMatch(/^mnt:\[\d+\]$/);
  });
  it("/proc/1/stat is readable here (hidepid≥1 ⇒ cross-uid lineage walks fail, this machine does not benefit — §R3 R-f)", () => {
    let stat: string | undefined;
    try {
      stat = readFileSync("/proc/1/stat", "utf8");
    } catch {
      stat = undefined;
    }
    expect(
      stat,
      "hidepid≥1 detected: the scan-poison fix cannot work on this machine (lineage walks read root ancestors' stat) — this is a machine property, not a code bug",
    ).toBeDefined();
  });
});

describe("judgePrivateInstance — §3.3 matrix", () => {
  const ok = (over: Record<string, unknown> = {}) => ({ kind: "ok", record: baseRecord(over) });
  const NS = { ns: { mnt: "mnt:[7]", user: "user:[6]" }, supervisor: { pid: 9, start: 9 } };
  const done = (n: number) => ({ kind: "done", members: Array.from({ length: n }, (_, i) => ({ pid: 100 + i })) });
  const J = (f: Record<string, unknown>) => H.judgePrivateInstance({ bootId: BOOT, alive: {}, ...f }).state;
  it("no record: free ⇒ none, held ⇒ unrecorded, unknown ⇒ unknown; corrupt / unreadable fail closed", () => {
    expect(J({ record: { kind: "none" }, lease: "free" })).toBe("none");
    expect(J({ record: { kind: "none" }, lease: "held" })).toBe("unrecorded");
    expect(J({ record: { kind: "none" }, lease: "unknown" })).toBe("unknown");
    expect(J({ record: { kind: "corrupt", reason: "json" }, lease: "free" })).toBe("corrupt");
    expect(J({ record: { kind: "unknown" }, lease: "free" })).toBe("unknown");
  });
  it("bootId ≠ current ⇒ stale regardless of evidence", () => {
    expect(J({ record: ok({ ...NS, bootId: "old" }), lease: "held", scan: done(3) })).toBe("stale");
  });
  it("stale needs BOTH a free lease AND a complete empty scan (B1)", () => {
    expect(J({ record: ok({ ...NS, phase: "session" }), lease: "free", scan: done(0) })).toBe("stale");
    expect(J({ record: ok({ ...NS, phase: "session" }), lease: "free", scan: done(1), verified: 1 })).toBe("orphan-ns");
    // members present but none provable (recycled ns id, review N1 #2) ⇒ ns-in-use: blocks, never killed
    expect(J({ record: ok({ ...NS, phase: "session" }), lease: "free", scan: done(1), verified: 0 })).toBe("ns-in-use");
    expect(J({ record: ok({ ...NS, phase: "session" }), lease: "free", scan: { kind: "incomplete" } })).toBe("unknown");
    expect(J({ record: ok({ ...NS, phase: "session" }), lease: "unknown", scan: done(0) })).toBe("unknown");
    expect(
      J({ record: ok({ ...NS, phase: "session" }), lease: "held", scan: done(0), alive: { gocryptfs: true } }),
    ).toBe("orphan");
  });
  it("phases with a live supervisor / pi; gocryptfs not yet registered ≠ dead", () => {
    const a = { supervisor: true };
    expect(J({ record: ok({ ...NS, phase: "mounting" }), lease: "held", scan: done(1), alive: a })).toBe("mounting");
    expect(J({ record: ok({ ...NS, phase: "launching" }), lease: "held", scan: done(2), alive: a })).toBe("launching");
    expect(J({ record: ok({ ...NS, phase: "setup" }), lease: "held", scan: done(2), alive: a })).toBe("launching");
    expect(
      J({
        record: ok({ ...NS, phase: "session" }),
        lease: "held",
        scan: done(3),
        alive: { pi: true, supervisor: true },
      }),
    ).toBe("session");
    expect(J({ record: ok({ ...NS, phase: "finalizing" }), lease: "held", scan: done(1), alive: a })).toBe(
      "finalizing",
    );
    expect(J({ record: ok({ ...NS, phase: "starting" }), lease: "held", scan: done(1), alive: { owner: true } })).toBe(
      "starting",
    );
  });
  it("orphan / orphan-ns / done-but-unreleased", () => {
    const rec = ok({ ...NS, phase: "session", gocryptfs: { pid: 11, start: 11 } });
    expect(J({ record: rec, lease: "held", scan: done(2), alive: { gocryptfs: true } })).toBe("orphan");
    expect(J({ record: rec, lease: "free", scan: done(1), alive: {}, verified: 1 })).toBe("orphan-ns");
    expect(J({ record: rec, lease: "free", scan: done(1), alive: {} })).toBe("ns-in-use");
    expect(J({ record: ok({ ...NS, phase: "finalizing", inNsDone: true }), lease: "free", scan: done(0) })).toBe(
      "stale",
    );
  });
  it("r3.1 (N4 F1): pi alive but supervisor dead is NOT a session — orphan / orphan-ns / ns-in-use", () => {
    const rec = ok({ ...NS, phase: "session", gocryptfs: { pid: 11, start: 11 } });
    // P1 killed, pi (+ P0) still running, gocryptfs alive ⇒ orphan (outer cleanup of provable members)
    expect(J({ record: rec, lease: "held", scan: done(3), alive: { pi: true, owner: true, gocryptfs: true } })).toBe(
      "orphan",
    );
    // P0/P1/gocryptfs dead, a SIGHUP-immune pi + its job remain ⇒ orphan-ns when provable …
    expect(J({ record: rec, lease: "held", scan: done(2), alive: { pi: true }, verified: 2 })).toBe("orphan-ns");
    // … ns-in-use (report only) when nothing is provable
    expect(J({ record: rec, lease: "held", scan: done(2), alive: { pi: true }, verified: 0 })).toBe("ns-in-use");
    // with the supervisor alive it stays a session (lock without --kill must refuse)
    expect(
      J({ record: rec, lease: "held", scan: done(3), alive: { pi: true, supervisor: true, gocryptfs: true } }),
    ).toBe("session");
  });
  it("record without ns: only lease + owner/supervisor liveness", () => {
    expect(J({ record: ok({ phase: "starting" }), lease: "free", alive: {} })).toBe("stale");
    expect(J({ record: ok({ phase: "starting" }), lease: "free", alive: { owner: true } })).toBe("starting");
    expect(J({ record: ok({ phase: "starting" }), lease: "held", alive: {} })).toBe("unknown");
  });
});

// ───────────────────────────── termination right (I-P4) ─────────────────────────────

describe("termination right (I-P4): only recorded / ns-proven identities, re-verified per signal", () => {
  it("signalVerified refuses a reused pid (start differs) and a pid that left the ns", () => {
    const pr = fakeProc([{ pid: 40, ns: "mnt:[7]", start: 500 }]);
    const sent: Array<[number, string]> = [];
    const kill = (pid: number, sig: string) => sent.push([pid, sig]);
    expect(H.signalVerified({ pid: 40, start: 499 }, "SIGTERM", { procRoot: pr, kill })).toBe(false);
    expect(H.signalVerified({ pid: 40, start: 500 }, "SIGTERM", { procRoot: pr, kill, nsMnt: "mnt:[8]" })).toBe(false);
    expect(H.signalVerified({ pid: 40, start: 500 }, "SIGTERM", { procRoot: pr, kill, nsMnt: "mnt:[7]" })).toBe(true);
    expect(sent).toEqual([[40, "SIGTERM"]]);
  });
  it("terminateInstance: members (not gocryptfs' own helpers) first, gocryptfs last; pre-supervisor joiners and other ns untouched", async () => {
    const pr = fakeProc([
      { pid: 50, ns: "mnt:[7]", start: 100, comm: "p1" },
      { pid: 51, ns: "mnt:[7]", start: 120, comm: "gocryptfs" },
      { pid: 52, ns: "mnt:[7]", start: 121, ppid: 51, comm: "logger" },
      { pid: 53, ns: "mnt:[7]", start: 130, ppid: 50, comm: "bgjob" },
      { pid: 56, ns: "mnt:[7]", start: 131, ppid: 53, user: "user:[66]", comm: "pi-grandchild" },
      { pid: 57, ns: "mnt:[7]", start: 132, ppid: 1, comm: "reparented" },
      { pid: 54, ns: "mnt:[7]", start: 90, comm: "setns-joiner" },
      { pid: 55, ns: "mnt:[9]", start: 140, comm: "other-vault-holder" },
    ]);
    const order: string[] = [];
    const kill = (pid: number, sig: string) => {
      order.push(`${pid}:${sig}`);
      rmSync(join(pr, String(pid)), { recursive: true, force: true }); // dies at once
    };
    const rec = baseRecord({
      phase: "session",
      ns: { mnt: "mnt:[7]", user: "user:[6]" },
      supervisor: { pid: 50, start: 100 },
      gocryptfs: { pid: 51, start: 120 },
    });
    // pi-grandchild's user ns (user:[66]) is neither ns.user nor ns.innerUser ⇒ unverified
    const r = await H.terminateInstance(rec, { deadline: Date.now() + 5_000, procRoot: pr, kill });
    expect(r.ok).toBe(false); // unverified members remain ⇒ never "ok"
    expect(r.unverified.map((u: { pid: number }) => u.pid).sort()).toEqual([56, 57]);
    expect(order.some((x) => x.startsWith("56:") || x.startsWith("57:"))).toBe(false);
    const idx = (s: string) => order.indexOf(s);
    expect(idx("53:SIGTERM")).toBeGreaterThanOrEqual(0);
    expect(idx("50:SIGTERM")).toBeGreaterThanOrEqual(0);
    expect(idx("51:SIGTERM")).toBeGreaterThan(idx("53:SIGTERM"));
    expect(idx("52:SIGTERM")).toBeGreaterThan(idx("53:SIGTERM"));
    expect(order.some((s) => s.startsWith("54:") || s.startsWith("55:"))).toBe(false);
  });
  it("review N1 #2: ns id recycled — every recorded identity dead ⇒ members are unverified, ZERO signals", async () => {
    const pr = fakeProc([
      { pid: 70, ns: "mnt:[7]", start: 900, comm: "unrelated-init" },
      { pid: 71, ns: "mnt:[7]", start: 901, ppid: 70, comm: "unrelated-child" },
      { pid: 72, ns: "mnt:[7]", start: 902, ppid: 70, user: "user:[99]", comm: "other-userns" },
    ]);
    const kill = () => {
      throw new Error("must not signal");
    };
    const rec = baseRecord({
      phase: "session",
      ns: { mnt: "mnt:[7]", user: "user:[6]", innerUser: "user:[8]" },
      supervisor: { pid: 60, start: 100 },
      gocryptfs: { pid: 61, start: 110 },
      pi: { pid: 62, start: 120 },
    });
    const r = await H.terminateInstance(rec, { deadline: Date.now() + 2_000, procRoot: pr, kill });
    expect(r).toMatchObject({ ok: false, killed: [] });
    expect(r.unverified.map((u: { pid: number }) => u.pid).sort()).toEqual([70, 71, 72]);
  });
  it("review N1 #2: memberAuthorized needs boot ∧ user ns ∈ {user, innerUser} ∧ start ≥ supervisor ∧ provable ancestry", () => {
    const rec = baseRecord({
      ns: { mnt: "mnt:[7]", user: "user:[6]", innerUser: "user:[8]" },
      supervisor: { pid: 10, start: 100 },
      gocryptfs: { pid: 11, start: 101 },
      pi: { pid: 12, start: 105 },
    });
    const table: Record<number, { pid: number; start: number; ppid: number }> = {
      10: { pid: 10, start: 100, ppid: 1 },
      11: { pid: 11, start: 101, ppid: 1 },
      12: { pid: 12, start: 105, ppid: 10 },
      30: { pid: 30, start: 200, ppid: 12 },
      31: { pid: 31, start: 150, ppid: 30 }, // parent started AFTER child ⇒ chain is not a real ancestry
    };
    const chain = (pid: number) => table[pid];
    const A = (m: Record<string, unknown>, bootId = BOOT) => H.memberAuthorized(rec, m, { chain, bootId });
    expect(A({ pid: 30, start: 200, ppid: 12, user: "user:[8]" })).toBe(true); // pi's child, inner userns
    expect(A({ pid: 11, start: 101, ppid: 1, user: "user:[6]" })).toBe(true); // gocryptfs itself (reparented)
    expect(A({ pid: 40, start: 210, ppid: 11, user: "user:[6]" })).toBe(true); // gocryptfs' logger
    expect(A({ pid: 30, start: 200, ppid: 12, user: "user:[9]" })).toBe(false); // foreign user ns
    expect(A({ pid: 30, start: 200, ppid: 12, user: "user:[8]" }, "other-boot")).toBe(false);
    expect(A({ pid: 32, start: 90, ppid: 12, user: "user:[8]" })).toBe(false); // predates supervisor
    expect(A({ pid: 33, start: 300, ppid: 1, user: "user:[8]" })).toBe(false); // reparented: unprovable
    expect(A({ pid: 34, start: 140, ppid: 31, user: "user:[8]" })).toBe(false);
    expect(
      H.memberAuthorized(
        { ...rec, ns: undefined },
        { pid: 30, start: 200, ppid: 12, user: "user:[8]" },
        { chain, bootId: BOOT },
      ),
    ).toBe(false);
  });
  it("incomplete scan ⇒ nothing is signalled", async () => {
    const kill = () => {
      throw new Error("must not signal");
    };
    const rec = baseRecord({ ns: { mnt: "mnt:[7]", user: "user:[6]" }, supervisor: { pid: 50, start: 1 } });
    const r = await H.terminateInstance(rec, { deadline: Date.now() + 1_000, procRoot: join(root, "nope"), kill });
    expect(r).toMatchObject({ ok: false, killed: [] });
  });
});

// ───────────────────────────── review N4-r2: three-state liveness + no backfill ─────────────────────────────

describe("review N4-r2 #1: supervisor liveness is three-state (alive / dead / unknown)", () => {
  const io = (code: string) => async () => {
    throw Object.assign(new Error(code), { code });
  };
  it("readProcStart never swallows errors; identityState is dead ONLY on proof", async () => {
    const pr = fakeProc([
      { pid: 40, start: 500 },
      { pid: 41, start: 600, state: "Z" },
    ]);
    mkdirSync(join(pr, "42", "stat"), { recursive: true }); // EISDIR
    mkdirSync(join(pr, "43"));
    writeFileSync(join(pr, "43", "stat"), "garbage");
    const S = (id: { pid: number; start: number }, o: Record<string, unknown> = {}) =>
      H.identityState(id, { procRoot: pr, ...o });
    expect(await S({ pid: 40, start: 500 })).toBe("alive");
    expect(await S({ pid: 40, start: 499 })).toBe("dead"); // live, different starttime
    expect(await S({ pid: 44, start: 1 })).toBe("dead"); // ENOENT
    expect(await S({ pid: 41, start: 600 })).toBe("dead"); // zombie: exited
    expect(await S({ pid: 42, start: 1 })).toBe("unknown"); // EISDIR
    expect(await S({ pid: 43, start: 1 })).toBe("unknown"); // unparsable stat
    for (const code of ["EACCES", "EIO", "EMFILE", "EPERM"])
      expect(await S({ pid: 40, start: 500 }, { readFile: io(code) }), code).toBe("unknown");
    expect(await S({ pid: 40, start: 500 }, { readFile: io("ESRCH") })).toBe("dead");
    expect(await H.readProcStart(40, { procRoot: pr, readFile: io("EIO") })).toEqual({ kind: "error", code: "EIO" });
    expect(await H.readProcStart(44, { procRoot: pr })).toEqual({ kind: "gone" });
    expect(await H.identityAlive({ pid: 40, start: 500 }, { procRoot: pr, readFile: io("EIO") })).toBe(false);
  });

  const sessionFixture = (withSupervisorInProc: boolean) => {
    const procs = [
      { pid: 51, ns: "mnt:[7]", start: 120, comm: "gocryptfs" },
      { pid: 52, ns: "mnt:[7]", start: 130, ppid: 50, user: "user:[8]", comm: "pi" },
    ];
    if (withSupervisorInProc) procs.unshift({ pid: 50, ns: "mnt:[7]", start: 100, comm: "node" } as never);
    const pr = fakeProc(procs);
    writeFileSync(join(pr, "locks"), "");
    const rec = baseRecord({
      phase: "session",
      ns: { mnt: "mnt:[7]", user: "user:[6]", innerUser: "user:[8]" },
      supervisor: { pid: 50, start: 100 },
      gocryptfs: { pid: 51, start: 120 },
      pi: { pid: 52, start: 130 },
    });
    return { pr, record: { kind: "ok", record: rec } };
  };
  // the supervisor's /proc/<pid>/stat read fails with EIO; every other read succeeds
  const supEio = async (p: string, enc: BufferEncoding) => {
    if (p.endsWith("/50/stat")) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return (require("node:fs/promises") as typeof import("node:fs/promises")).readFile(p, enc);
  };

  it("an EIO on the supervisor read ⇒ unknown ⇒ treated as alive: session, never orphan; lock (and --kill) refuse 76", async () => {
    const { pr, record } = sessionFixture(false); // the scan cannot see P1 either
    const s = await H.privateInstanceState(v, { procRoot: pr, record, readFile: supEio });
    expect(s.supervisorState).toBe("unknown");
    expect(s.alive.supervisor).toBe(true);
    expect(s.state).toBe("session");
    for (const opts of [{}, { kill: true }, { lazy: true }]) {
      const d = H.lockPrivateDecision(v, { ...s, inNs: false }, opts);
      expect(d.action, JSON.stringify(opts)).toBe("refuse");
      expect(d.code).toBe(H.EXIT.BUSY);
      expect(d.text).toMatch(/无法确认监督进程状态/);
    }
    // the same view with gocryptfs dead would previously have been orphan-ns; now it stays session
    const s2 = await H.privateInstanceState(v, {
      procRoot: pr,
      record: { kind: "ok", record: { ...record.record, gocryptfs: { pid: 51, start: 999 } } },
      readFile: supEio,
    });
    expect(s2.state).toBe("session");
  });

  it("a later scan that SEES the recorded P1 alive overrides the failed read ⇒ alive ⇒ session (lock refuses as running)", async () => {
    const { pr, record } = sessionFixture(true);
    const s = await H.privateInstanceState(v, { procRoot: pr, record, readFile: supEio });
    expect(s.supervisorState).toBe("alive");
    expect(s.state).toBe("session");
    const d = H.lockPrivateDecision(v, { ...s, inNs: false }, {});
    expect(d).toMatchObject({ action: "refuse", code: H.EXIT.BUSY });
    expect(d.text).toMatch(/会话仍在运行/);
  });

  it("a PROVEN dead supervisor (ENOENT) with pi + gocryptfs alive ⇒ orphan (outer cleanup allowed)", async () => {
    const { pr, record } = sessionFixture(false);
    const s = await H.privateInstanceState(v, { procRoot: pr, record });
    expect(s.supervisorState).toBe("dead");
    expect(s.state).toBe("orphan");
    expect(H.lockPrivateDecision(v, { ...s, inNs: false }, {}).action).toBe("outer");
  });
});

describe("review N4-r2 #2: outer termination has no recorded-identity backfill", () => {
  it("signalVerified also checks the user ns when given", () => {
    const pr = fakeProc([{ pid: 40, ns: "mnt:[7]", user: "user:[99]", start: 500 }]);
    const sent: Array<[number, string]> = [];
    const kill = (pid: number, sig: string) => sent.push([pid, sig]);
    const o = { procRoot: pr, kill, nsMnt: "mnt:[7]" };
    expect(H.signalVerified({ pid: 40, start: 500 }, "SIGTERM", { ...o, userNs: ["user:[6]", "user:[8]"] })).toBe(
      false,
    );
    expect(sent).toEqual([]);
    expect(H.signalVerified({ pid: 40, start: 500 }, "SIGTERM", { ...o, userNs: ["user:[99]"] })).toBe(true);
  });

  it("pi / supervisor / gocryptfs whose pid+start match the record but which are NOT in the recorded ns (or foreign user ns) get ZERO signals", async () => {
    const pr = fakeProc([
      // a legitimate anchor keeps the instance an orphan: the logger child of a live gocryptfs
      { pid: 51, ns: "mnt:[7]", start: 120, comm: "gocryptfs" },
      { pid: 53, ns: "mnt:[7]", start: 121, ppid: 51, comm: "logger" },
      // recorded pi: identity matches, but it lives in ANOTHER mount ns
      { pid: 52, ns: "mnt:[9]", start: 130, ppid: 1, user: "user:[8]", comm: "pi" },
      // recorded supervisor: identity matches, right mnt ns, but a foreign user ns
      { pid: 50, ns: "mnt:[7]", start: 100, user: "user:[99]", comm: "node" },
    ]);
    const sent: Array<[number, string]> = [];
    const kill = (pid: number, sig: string) => {
      sent.push([pid, sig]);
      rmSync(join(pr, String(pid)), { recursive: true, force: true });
    };
    const rec = baseRecord({
      phase: "session",
      ns: { mnt: "mnt:[7]", user: "user:[6]", innerUser: "user:[8]" },
      supervisor: { pid: 50, start: 100 },
      gocryptfs: { pid: 51, start: 120 },
      pi: { pid: 52, start: 130 },
    });
    const r = await H.terminateInstance(rec, { deadline: Date.now() + 5_000, procRoot: pr, kill });
    expect(sent.some(([p]) => p === 52 || p === 50)).toBe(false);
    expect(sent.some(([p]) => p === 51)).toBe(true); // the authorized anchor is still handled
    expect(r.ok).toBe(false); // unproven identities remain ⇒ never ok ⇒ record kept, lock non-zero
    const unv = r.unverified.map((u: { pid: number; comm: string }) => `${u.pid}:${u.comm}`).join(" ");
    expect(unv).toMatch(/52:pi（记录身份未通过命名空间\/成员校验）/);
    expect(unv).toMatch(/50:/);
  });

  it("a record without a registered ns ⇒ nothing can be authorized ⇒ zero signals, live identities reported", async () => {
    const pr = fakeProc([{ pid: 50, ns: "mnt:[7]", start: 100, comm: "node" }]);
    const kill = () => {
      throw new Error("must not signal");
    };
    const rec = baseRecord({ phase: "mounting", supervisor: { pid: 50, start: 100 } });
    const r = await H.terminateInstance(rec, { deadline: Date.now() + 1_000, procRoot: pr, kill });
    expect(r).toMatchObject({ ok: false, killed: [] });
    expect(r.unverified.map((u: { pid: number }) => u.pid)).toEqual([50]);
  });
});

// ───────────────────────────── spawn specs (I-P9) ─────────────────────────────

describe("spawn specs: fd 9 only to gocryptfs and the inner unshare→pi (I-P9)", () => {
  const SLOT9 = ["inherit", "inherit", "inherit", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9];
  it("gocryptfs: -fg + -notifypid, setsid (detached), exact slot array", () => {
    const g = H.gocryptfsSpawnSpec("/c", "/m", 4242);
    expect(g.cmd).toBe("gocryptfs");
    expect(g.args).toEqual(["-fg", "-notifypid=4242", "-nonempty", "--", "/c", "/m"]);
    expect(g.opts.detached).toBe(true);
    expect(g.opts.stdio).toEqual(SLOT9);
  });
  it("inner unshare → pi: maps back to the real uid/gid, NOT detached (TTY job control), slot 9", () => {
    const p = H.innerPiSpawnSpec({
      uid: 1001,
      gid: 1002,
      piBin: "/bin/pi",
      sessionDir: "/s",
      piArgs: ["-p", "x"],
      cwd: "/w",
      env: { A: "1" },
    });
    expect(p.args).toEqual([
      "--user",
      "--map-user=1001",
      "--map-group=1002",
      "--",
      "/bin/pi",
      "--session-dir",
      "/s",
      "-p",
      "x",
    ]);
    expect(p.opts.detached).toBe(false);
    expect(p.opts.stdio).toEqual(SLOT9);
  });
  it("worker / record children never get slot 9; the shell chain opens the lease itself", () => {
    const w = H.workerSpawnSpec({ op: "readdir", name: "acme" }, {});
    expect(w.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(w.opts.stdio).not.toContain(9);
    expect(w.opts.detached).toBe(true);
    expect(H.NO_LEASE_STDIO).toEqual(["ignore", "pipe", "pipe"]);
    const a = H.leaseChainArgs("/d/mount.lease", H.nsRootTail("/n", "/h"));
    expect(a[0]).toBe("-c");
    expect(a[1]).toBe(`exec 9<>"$1" && flock -n 9 || exit ${H.LEASE_BUSY_CODE}; shift; exec "$@"`);
    expect(a.slice(2)).toEqual([
      "sh",
      "/d/mount.lease",
      "unshare",
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--",
      "/n",
      "/h",
      "__ns-root",
    ]);
  });
  it.skipIf(!HAVE_FLOCK)("barrier: two lease chains race ⇒ exactly one holds, the other exits BUSY (213)", async () => {
    const runChain = () =>
      new Promise<number | null>((res) => {
        const c = spawn("/bin/sh", H.leaseChainArgs(v.lease, ["sleep", "1"]), { stdio: "ignore" });
        c.on("close", (code) => res(code));
      });
    const codes = await Promise.all([runChain(), runChain()]);
    expect(codes.sort()).toEqual([0, H.LEASE_BUSY_CODE]);
  });
  it("piChildEnv: PI_SECURE_NS only for the private child; the plain env is unchanged", () => {
    const plain = H.piChildEnv(v, v.work, { PATH: "/bin", PI_SECURE_NS_SPEC: "{}" });
    expect(plain).not.toHaveProperty("PI_SECURE_NS");
    expect(plain).not.toHaveProperty("PI_SECURE_NS_SPEC");
    const ns = H.piChildEnv(v, v.work, { PATH: "/bin", PI_SECURE_NS_SPEC: "{}" }, { ns: true });
    expect(ns.PI_SECURE_NS).toBe("1");
    expect(ns).not.toHaveProperty("PI_SECURE_NS_SPEC");
    const { PI_SECURE_NS: _drop, ...rest } = ns;
    expect(rest).toEqual(plain);
  });
});

// ───────────────────────────── P0 outcome (§3.6) ─────────────────────────────

describe("decidePrivateOutcome — §3.6 table", () => {
  const ok = (over: Record<string, unknown>) => ({ kind: "ok", record: baseRecord(over) });
  const D = (f: Record<string, unknown>) => H.decidePrivateOutcome({ instanceId: ID_A, piAlive: false, ...f });
  const NS = { ns: { mnt: "mnt:[7]", user: "user:[6]" }, supervisor: { pid: 9, start: 9 } };
  it("record gone: BUSY ⇒ 76, otherwise P1's code", () => {
    expect(D({ record: { kind: "none" }, p1Code: H.LEASE_BUSY_CODE })).toMatchObject({ action: "none", code: 76 });
    expect(D({ record: { kind: "none" }, p1Code: 4 })).toMatchObject({ action: "none", code: 4 });
  });
  it("successor record is never touched; unreadable ⇒ 75", () => {
    expect(D({ record: ok({ instanceId: ID_B }), p1Code: 0 })).toMatchObject({ action: "none", note: "successor" });
    expect(D({ record: { kind: "corrupt" }, p1Code: 0 })).toMatchObject({ action: "none", code: 75 });
  });
  it("BUSY + own starting record without ns ⇒ the unique abort-start exception", () => {
    expect(D({ record: ok({}), p1Code: H.LEASE_BUSY_CODE })).toEqual({ action: "abort-start", code: 76 });
    // pi itself exiting 213 never triggers the exception (the record has a supervisor)
    expect(
      D({ record: ok({ ...NS, phase: "finalizing", piExit: { code: 213 }, inNsDone: true }), p1Code: 213 }),
    ).toEqual({
      action: "release",
      code: 213,
    });
  });
  it("no ns (unshare / self-check failed) ⇒ release, 69 (or recorded failCode)", () => {
    expect(D({ record: ok({}), p1Code: 1 })).toEqual({ action: "release", code: 69 });
    expect(D({ record: ok({ failCode: 78 }), p1Code: 1 })).toEqual({ action: "release", code: 78 });
  });
  it("inNsDone ⇒ release with pi's code; or the pre-pi failure code; P1 normal nonzero exits 1 / 127", () => {
    expect(D({ record: ok({ ...NS, phase: "finalizing", piExit: { code: 0 }, inNsDone: true }), p1Code: 0 })).toEqual({
      action: "release",
      code: 0,
    });
    expect(
      D({ record: ok({ ...NS, phase: "finalizing", piExit: { code: 127 }, inNsDone: true }), p1Code: 127 }),
    ).toEqual({
      action: "release",
      code: 127,
    });
    expect(D({ record: ok({ ...NS, phase: "finalizing", failCode: 77, inNsDone: true }), p1Code: 77 })).toEqual({
      action: "release",
      code: 77,
    });
  });
  it("pi alive (P1 killed alone) ⇒ wait for pi, code 1 when piExit missing; otherwise outer cleanup", () => {
    expect(D({ record: ok({ ...NS, phase: "session" }), p1Code: 137, piAlive: true })).toEqual({
      action: "wait-pi",
      code: 1,
    });
    expect(D({ record: ok({ ...NS, phase: "finalizing", piExit: { code: 2 }, inNsDone: false }), p1Code: 75 })).toEqual(
      {
        action: "outer",
        code: 2,
      },
    );
    expect(D({ record: ok({ ...NS, phase: "mounting" }), p1Code: 137 })).toEqual({ action: "outer", code: 137 });
  });
});

// ───────────────────────────── preflight / self-check / bounded children ─────────────────────────────

describe("privatePreflight (§2.7) with injected probes", () => {
  const HELP = "--map-root-user --map-user --map-group --propagation";
  const deps = (over: Record<string, unknown> = {}) => ({
    which: () => "/usr/bin/x",
    read: (p: string) =>
      p.endsWith("unprivileged_userns_clone") ? "1\n" : p.endsWith("max_user_namespaces") ? "100\n" : undefined,
    run: async (_cmd: string, args: string[]) =>
      args[0] === "--help"
        ? { kind: "exit", code: 0, stdout: HELP, stderr: "" }
        : { kind: "exit", code: 0, stdout: "", stderr: "" },
    mkdtemp: () => "/x",
    rmdir: () => {},
    ...over,
  });
  it("all good ⇒ ok", async () => expect(await H.privatePreflight(deps())).toEqual({ ok: true, problems: [] }));
  it("each failure names the item", async () => {
    expect(
      (await H.privatePreflight(deps({ which: (b: string) => (b === "unshare" ? undefined : "/x") }))).problems[0],
    ).toMatch(/unshare/);
    const noProp = deps({
      run: async () => ({ kind: "exit", code: 0, stdout: "--map-root-user --map-user --map-group", stderr: "" }),
    });
    expect((await H.privatePreflight(noProp)).problems.join()).toMatch(/--propagation/);
    expect(
      (
        await H.privatePreflight(deps({ read: (p: string) => (p.endsWith("clone") ? "0" : undefined) }))
      ).problems.join(),
    ).toMatch(/unprivileged_userns_clone/);
    expect(
      (
        await H.privatePreflight(deps({ read: (p: string) => (p.includes("apparmor") ? "1" : undefined) }))
      ).problems.join(),
    ).toMatch(/AppArmor/);
    const probeFail = deps({
      run: async (_c: string, a: string[]) =>
        a[0] === "--help"
          ? { kind: "exit", code: 0, stdout: HELP, stderr: "" }
          : { kind: "exit", code: 1, stdout: "", stderr: "unshare: EPERM\n" },
    });
    expect((await H.privatePreflight(probeFail)).problems.join()).toMatch(/实测失败：unshare: EPERM/);
    const probeHang = deps({
      run: async (_c: string, a: string[]) =>
        a[0] === "--help" ? { kind: "exit", code: 0, stdout: HELP, stderr: "" } : { kind: "timeout" },
    });
    expect((await H.privatePreflight(probeHang)).problems.join()).toMatch(/超时/);
  });
});

describe("nsRootSelfCheck (§2.3-1)", () => {
  const spec = { v: 3, instanceId: ID_A, name: "acme", uid: 1001, gid: 1001 };
  it("exact maps + uid 0 + valid spec ⇒ ok; any drift ⇒ problem", () => {
    expect(
      H.nsRootSelfCheck({ uid: 0, uidMap: "         0       1001          1\n", gidMap: "0 1001 1", spec }),
    ).toEqual([]);
    expect(H.nsRootSelfCheck({ uid: 1001, uidMap: "0 1001 1", gidMap: "0 1001 1", spec }).length).toBe(1);
    expect(H.nsRootSelfCheck({ uid: 0, uidMap: "0 0 4294967295", gidMap: "0 1001 1", spec }).length).toBe(1);
    expect(
      H.nsRootSelfCheck({ uid: 0, uidMap: "0 1001 1", gidMap: "0 1001 1", spec: { ...spec, instanceId: "x" } }).length,
    ).toBe(1);
  });
});

describe("review N1 #6: a fired deadline is always a timeout (⇒ 75)", () => {
  it("TERM makes the child exit promptly ⇒ still {kind:timeout}", async () => {
    const r = await H.runBounded("sleep", ["30"], { deadline: Date.now() + 200, killGraceMs: 2_000, abandonMs: 300 });
    expect(r).toMatchObject({ kind: "timeout", signal: "SIGTERM" });
  });
  it("workerOutcome maps every timeout to 75 and a normal close to its JSON line", () => {
    expect(H.workerOutcome({ kind: "timeout", signal: "SIGKILL", stdout: "" }, "post-mount")).toMatchObject({
      ok: false,
      code: 75,
    });
    expect(H.workerOutcome({ kind: "timeout", stdout: "" }, "readdir")).toMatchObject({ code: 75 });
    expect(H.workerOutcome({ kind: "exit", code: 0, stdout: '{"ok":true,"cwd":"/w"}\n' }, "post-mount")).toEqual({
      ok: true,
      cwd: "/w",
    });
    expect(H.workerOutcome({ kind: "exit", code: 1, stdout: "", stderr: "boom" }, "x")).toMatchObject({
      ok: false,
      code: 1,
    });
  });
});

describe("review N1 #4: termThenKill — cancelled on exit, identity-checked", () => {
  it("child exits on TERM ⇒ the delayed KILL is never sent", async () => {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((r) => c.on("close", r));
    const id = { pid: c.pid!, start: H.readProcStartSync(c.pid) as number };
    const sent: string[] = [];
    const kill = (pid: number, sig: string) => {
      sent.push(sig);
      process.kill(pid, sig as NodeJS.Signals);
    };
    H.termThenKill(id, { graceMs: 300, exited, kill });
    await exited;
    await sleep(500);
    expect(sent).toEqual(["SIGTERM"]);
  });
  it("a recycled pid (start differs) is never signalled, neither TERM nor the delayed KILL", async () => {
    const sent: string[] = [];
    const kill = (_pid: number, sig: string) => sent.push(sig);
    const id = { pid: process.pid, start: (H.readProcStartSync(process.pid) as number) + 1 };
    H.termThenKill(id, { graceMs: 100, exited: new Promise(() => {}), kill });
    await sleep(300);
    expect(sent).toEqual([]);
  });
  it("still alive after the grace ⇒ KILL with re-verified identity", async () => {
    const c = spawn("sh", ["-c", 'trap "" TERM; sleep 30'], { stdio: "ignore" });
    await sleep(100);
    const exited = new Promise((r) => c.on("close", r));
    const id = { pid: c.pid!, start: H.readProcStartSync(c.pid) as number };
    const sent: string[] = [];
    const kill = (pid: number, sig: string) => {
      sent.push(sig);
      process.kill(pid, sig as NodeJS.Signals);
    };
    H.termThenKill(id, { graceMs: 200, exited, kill });
    await exited;
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("review N1 #3: Q10 re-checked on the inherited mount table", () => {
  const mi = (lines: string[]) => lines.map((l, i) => `${100 + i} 1 0:${50 + i} / ${l}`).join("\n");
  it("any fuse.gocryptfs, any mount on another vault's mount point, or our own mount point ⇒ refuse", () => {
    const opts = { realMnt: "/h/secure/acme", others: [{ name: "beta", realMnt: "/h/secure/beta" }] };
    expect(H.inheritedMountProblems(mi(["/ rw - ext4 /dev/sda1 rw", "/proc rw - proc proc rw"]), opts)).toEqual([]);
    expect(H.inheritedMountProblems(mi(["/x rw - fuse.gocryptfs /c/x rw"]), opts)[0]).toMatch(/gocryptfs/);
    expect(H.inheritedMountProblems(mi(["/h/secure/beta rw - tmpfs t rw"]), opts)[0]).toMatch(/beta/);
    expect(H.inheritedMountProblems(mi(["/h/secure/acme rw - tmpfs t rw"]), opts)[0]).toMatch(/本库挂载点/);
  });
});

describe("runBounded: TERM → +grace KILL → +abandon (I-P5)", () => {
  it("a child ignoring TERM is group-KILLed and the call returns within deadline+grace+abandon", async () => {
    const t0 = Date.now();
    const r = await H.runBounded("sh", ["-c", 'trap "" TERM; sleep 30'], {
      deadline: Date.now() + 300,
      killGraceMs: 300,
      abandonMs: 300,
    });
    // TERM is ignored (inherited SIG_IGN), so only the group KILL at deadline+grace ends it;
    // the result stays a timeout (review N1 #6)
    expect(r).toMatchObject({ kind: "timeout", signal: "SIGKILL" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
});

// ───────────────────────────── claim barrier tests (real flock, fake vault, no mount) ─────────────────────────────

describe.skipIf(!HAVE_FLOCK)("claim under mount.lock (§2.2-4) — barrier concurrency", () => {
  const claim = (id: string) =>
    new Promise<{ code: number | null; err: string }>((res) => {
      const c = spawn(
        "flock",
        [
          "-o",
          "-E",
          "73",
          "-w",
          "10",
          v.lock,
          process.execPath,
          HELPER,
          "__private-claim",
          "acme",
          id,
          String(process.pid),
          String(H.readProcStartSync(process.pid)),
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: process.env },
      );
      let err = "";
      c.stderr.on("data", (b) => (err += b));
      c.on("close", (code) => res({ code, err }));
    });
  it("two concurrent claims ⇒ exactly one record, the other is refused 76", async () => {
    const rs = await Promise.all([claim(ID_A), claim(ID_B)]);
    expect(rs.map((r) => r.code).sort()).toEqual([0, 76]);
    const rec = readRecord();
    expect([ID_A, ID_B]).toContain(rec.instanceId);
    expect(rec).toMatchObject({ phase: "starting", owner: { pid: process.pid }, lease: leaseId(), bootId: BOOT });
  }, 30_000);
  it("unrecorded lease holder ⇒ 76, no record written, nothing signalled (holder survives)", async () => {
    const h = holder("flock", [v.lease, "sleep", "30"]);
    await sleep(200);
    const r = await claim(ID_A);
    expect(r.code).toBe(76);
    expect(r.err).toMatch(/未登记/);
    expect(existsSync(recordFile())).toBe(false);
    expect(H.readProcStartSync(h.pid)).toBeDefined();
  }, 30_000);
  it("P0 died after P1's self-check: a live supervisor in the record ⇒ second run refused, successor record untouched", async () => {
    const sup = holder("sleep", ["30"]);
    const lh = holder("flock", [v.lease, "sleep", "30"]);
    await sleep(200);
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ phase: "mounting", supervisor: liveIdentity(sup), ns: { mnt: OWN_NS, user: "user:[1]" } }),
    );
    const before = readFileSync(recordFile(), "utf8");
    const r = await claim(ID_B);
    expect(r.code).toBe(76);
    expect(readFileSync(recordFile(), "utf8")).toBe(before);
    expect(H.readProcStartSync(sup.pid)).toBeDefined();
    expect(H.readProcStartSync(lh.pid)).toBeDefined();
  }, 30_000);
  it("gocryptfs dead, background member alive, lease FREE ⇒ still refused (B1; unprovable ⇒ ns-in-use)", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({
        phase: "session",
        supervisor: SUP(),
        gocryptfs: { pid: 999_997, start: 1 },
        ns: { mnt: OWN_NS, user: "user:[1]" },
      }),
    );
    const r = await claim(ID_B);
    expect(r.code).toBe(76);
    // the background member cannot be PROVEN to belong (dead anchors) ⇒ ns-in-use: blocks, never killed
    expect(r.err).toMatch(/无法证明属于该实例/);
    expect(readRecord().instanceId).toBe(ID_A);
  }, 30_000);
  it("a stale record (other boot) is released through the protocol, then the claim proceeds", async () => {
    H.writePrivateRecordExclusive(
      v,
      baseRecord({ bootId: "previous-boot", phase: "session", ns: { mnt: OWN_NS, user: "user:[1]" } }),
    );
    const r = await claim(ID_B);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/清理了失效的 --private 记录/);
    expect(readRecord().instanceId).toBe(ID_B);
  }, 30_000);
  it("corrupt record ⇒ fail closed (76), file untouched", async () => {
    writeFileSync(recordFile(), "{broken", { mode: 0o600 });
    const r = await claim(ID_A);
    expect(r.code).toBe(76);
    expect(readFileSync(recordFile(), "utf8")).toBe("{broken");
  }, 30_000);
  it("sentinel problem ⇒ 78, no record", async () => {
    writeFileSync(join(v.mnt, "stray"), "");
    try {
      const r = await claim(ID_A);
      expect(r.code).toBe(78);
      expect(existsSync(recordFile())).toBe(false);
    } finally {
      rmSync(join(v.mnt, "stray"));
    }
  }, 30_000);
});

describe.skipIf(!HAVE_FLOCK || !which("script"))(
  "plain __mount runs gocryptfs under the shell lease chain (§3.1)",
  () => {
    it("a held lease ⇒ plain unlock refused 76 before gocryptfs ever runs (no password prompt)", async () => {
      const bin = join(root, "fakebin");
      const log = join(root, "gocryptfs-calls.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "gocryptfs"),
        `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "gocryptfs 1.8.0"; exit 0; fi\necho "$*" >> "${log}"\nexit 12\n`,
      );
      writeFileSync(join(bin, "fusermount3"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "gocryptfs"), 0o755);
      chmodSync(join(bin, "fusermount3"), 0o755);
      const nodeBin = join(root, "nodebin");
      mkdirSync(nodeBin, { recursive: true });
      if (!existsSync(join(nodeBin, "node"))) symlinkSync(process.execPath, join(nodeBin, "node"));
      holder("flock", [v.lease, "sleep", "30"]);
      await sleep(200);
      const r = await new Promise<{ code: number | null; text: string }>((res) => {
        const c = spawn("script", ["-qefc", `${BIN} unlock acme`, "/dev/null"], {
          env: { PATH: `${bin}:${nodeBin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let text = "";
        c.stdout.on("data", (b) => (text += b));
        c.stderr.on("data", (b) => (text += b));
        c.on("close", (code) => res({ code, text }));
      });
      expect(r.code, r.text).toBe(76);
      // N2: refused by the pre-TTY lease gate (§1.2) — the lease chain's own BUSY is the backstop.
      expect(r.text).toMatch(/挂载租约被一个未登记的进程持有/);
      expect(r.text).toMatch(/持有者 pid \d+ flock/);
      expect(existsSync(log)).toBe(false);
    }, 30_000);
  },
);

// ───────────────────────────── real smoke: gocryptfs + unshare (self-gated) ─────────────────────────────

const HAVE_REAL =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "script", "unshare", "umount"].every(which) &&
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0 &&
  spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "true"]).status === 0;

describe.skipIf(!HAVE_REAL)("N1 smoke: run --private through the real chain (fake passfile password, fake pi)", () => {
  // N1 review #3: serialize every suite that creates REAL global gocryptfs mounts (see gocryptfs-test-lock.ts).
  let releaseGocryptfsLock: (() => void) | undefined;
  beforeAll(async () => {
    releaseGocryptfsLock = await acquireGocryptfsTestLock();
  }, 250_000);
  afterAll(() => releaseGocryptfsLock?.());
  const PW = "TESTPASS-fake-not-a-secret";
  function setup() {
    const r = tmp("ps-n1-real-");
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
    const rec = join(r, "pi.json");
    writeFileSync(
      join(pkg, "dist", "cli.js"),
      `#!/usr/bin/env node
import fs from "node:fs"; import { spawn } from "node:child_process";
const st = fs.readFileSync("/proc/self/status", "utf8");
let fd9 = null; try { fd9 = fs.readlinkSync("/proc/self/fd/9"); } catch {}
fs.writeFileSync("data.txt", "hello");
if (process.env.FAKE_PI_LEFTOVER) spawn("setsid", ["sleep", "1000"], { detached: true, stdio: "ignore" }).unref();
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ uid: process.getuid(), cap: /CapEff:\\s+(\\S+)/.exec(st)[1],
  ns: fs.readlinkSync("/proc/self/ns/mnt"), fd9, NS: process.env.PI_SECURE_NS ?? null, argv: process.argv.slice(2), cwd: process.cwd() }));
setTimeout(() => process.exit(Number(process.env.FAKE_PI_EXIT ?? 0)), Number(process.env.FAKE_PI_SLEEP ?? 0));
`,
    );
    chmodSync(join(pkg, "dist", "cli.js"), 0o755);
    mkdirSync(join(r, "bin"));
    symlinkSync(join(pkg, "dist", "cli.js"), join(r, "bin", "pi"));
    symlinkSync(process.execPath, join(r, "bin", "node"));
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
    return {
      r,
      h,
      dir,
      mnt,
      rec,
      env: { PATH: `${join(r, "bin")}:/usr/bin:/bin`, HOME: h, LANG: "C.UTF-8", TMPDIR: tmpdir() },
    };
  }
  function runPrivate(
    e: ReturnType<typeof setup>,
    extra: Record<string, string>,
    during?: () => void,
    duringAt = 1_500,
  ): Promise<{ code: number | null; text: string; ms: number }> {
    return new Promise((res) => {
      const t0 = Date.now();
      const c = spawn("script", ["-qefc", `${BIN} run acme --private -- hi`, "/dev/null"], {
        env: { ...e.env, ...extra },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      let typed = 0;
      const on = (b: Buffer) => {
        text += b.toString();
        if (text.split("Password:").length - 1 > typed) {
          typed++;
          c.stdin.write(`${PW}\r`);
        }
      };
      c.stdout.on("data", on);
      c.stderr.on("data", on);
      if (during) setTimeout(during, duringAt);
      const t = setTimeout(() => c.kill("SIGKILL"), 60_000);
      c.on("close", (code) => {
        clearTimeout(t);
        res({ code, text: text.replace(/\r/g, ""), ms: Date.now() - t0 });
      });
    });
  }
  const globalMounted = (mnt: string) => readFileSync("/proc/self/mountinfo", "utf8").includes(` ${mnt} `);
  /**
   * Review N1 #3 refuses `run --private` while ANY fuse.gocryptfs mount exists globally. Other
   * suites (or other sessions) may hold short-lived test mounts; wait for a clean table, else skip.
   */
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

  it("normal exit: invisible outside, real uid / CapEff 0 / fd 9 in pi, exit code passes, record + lease released", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    let mid: Record<string, unknown> = {};
    const r = await runPrivate(
      e,
      { FAKE_PI_EXIT: "3", FAKE_PI_SLEEP: "2500" },
      () => {
        mid = {
          sentinel: readFileSync(join(e.mnt, "work"), "utf8") === "" && !existsSync(join(e.mnt, "work", "data.txt")),
          global: globalMounted(e.mnt),
          phase: JSON.parse(readFileSync(join(e.dir, "private.json"), "utf8")).phase,
          leaseHeld: spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status !== 0,
        };
      },
      2_000,
    );
    expect(r.code, r.text).toBe(3);
    expect(r.text).toContain("明文挂载只存在于本次 pi 进程树的私有挂载命名空间里");
    expect(mid).toEqual({ sentinel: true, global: false, phase: "session", leaseHeld: true });
    const pi = JSON.parse(readFileSync(e.rec, "utf8"));
    expect(pi).toMatchObject({
      uid: process.getuid(),
      cap: "0000000000000000",
      NS: "1",
      fd9: join(e.dir, "mount.lease"),
    });
    expect(pi.ns).not.toBe(OWN_NS);
    expect(pi.argv).toEqual(["--session-dir", join(e.mnt, "state", "sessions", "default"), "--", "hi"]);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status).toBe(0);
    expect(globalMounted(e.mnt)).toBe(false);
    expect(r.text).not.toMatch(/收尾未完成|外部收尾/);
  }, 90_000);

  it("leftover member is listed and terminated by the ns-internal finalize (gocryptfs' logger is not)", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const r = await runPrivate(e, { FAKE_PI_LEFTOVER: "1" });
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/pid \d+ sleep/);
    expect(r.text).not.toMatch(/pid \d+ logger/);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    const pid = Number(/pid (\d+) sleep/.exec(r.text)![1]);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  }, 90_000);

  it("Q10: another registered vault mounted globally ⇒ run --private refused 76 before any password prompt", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const bdir = join(e.h, ".local", "share", "pi-toolkit-secure", "beta");
    const bmnt = join(e.h, "secure", "beta");
    mkdirSync(join(bdir, "cipher"), { recursive: true, mode: 0o700 });
    chmodSync(bdir, 0o700);
    mkdirSync(bmnt, { mode: 0o700 });
    expect(
      spawnSync("gocryptfs", [
        "-init",
        "-q",
        "-scryptn",
        "10",
        "-passfile",
        join(e.r, "pf"),
        "--",
        join(bdir, "cipher"),
      ]).status,
    ).toBe(0);
    expect(spawnSync("gocryptfs", ["-q", "-passfile", join(e.r, "pf"), "--", join(bdir, "cipher"), bmnt]).status).toBe(
      0,
    );
    try {
      writeFileSync(
        join(e.h, ".pi", "agent", "pi-subagent.json"),
        JSON.stringify({ secure: { vaults: { acme: {}, beta: {} } } }),
      );
      const r = await runPrivate(e, {});
      expect(r.code, r.text).toBe(76);
      expect(r.text).toMatch(/保险库 beta 正全局挂载/);
      expect(r.text).not.toMatch(/Password:/);
      expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    } finally {
      spawnSync("fusermount3", ["-u", bmnt]);
    }
  }, 90_000);

  it("review N1 #3: a gocryptfs mount inherited by the new ns (not seen by the claim) ⇒ P1 refuses 76 before any password prompt", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const cdir = join(e.r, "unregistered");
    const cmnt = join(e.r, "unregistered-mnt");
    mkdirSync(join(cdir, "cipher"), { recursive: true, mode: 0o700 });
    mkdirSync(cmnt, { mode: 0o700 });
    expect(
      spawnSync("gocryptfs", [
        "-init",
        "-q",
        "-scryptn",
        "10",
        "-passfile",
        join(e.r, "pf"),
        "--",
        join(cdir, "cipher"),
      ]).status,
    ).toBe(0);
    expect(spawnSync("gocryptfs", ["-q", "-passfile", join(e.r, "pf"), "--", join(cdir, "cipher"), cmnt]).status).toBe(
      0,
    );
    try {
      const r = await runPrivate(e, {});
      expect(r.code, r.text).toBe(76);
      expect(r.text).toMatch(/私有命名空间继承了不应存在的挂载/);
      expect(r.text).not.toMatch(/Password:/);
      expect(existsSync(join(e.dir, "private.json"))).toBe(false);
      expect(spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status).toBe(0);
    } finally {
      spawnSync("fusermount3", ["-u", cmnt]);
    }
  }, 90_000);

  it("review N1 #5: session publish blocked (mount.lock held at launching) ⇒ pi stopped, bounded finalize, failure exit, nothing left", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const lockFile = join(e.dir, "mount.lock");
    const recFile = join(e.dir, "private.json");
    let held: ChildProcess | undefined;
    const seen = new Set<string>();
    const poll = setInterval(() => {
      if (held) return;
      try {
        const ph = JSON.parse(readFileSync(recFile, "utf8")).phase;
        seen.add(ph);
        if (ph === "launching") {
          held = spawn("flock", [lockFile, "sleep", "4"], { stdio: "ignore", detached: true });
          children.push(held);
        }
      } catch {
        /* not yet */
      }
    }, 5);
    try {
      const r = await runPrivate(e, { FAKE_PI_SLEEP: "15000" });
      expect(held, `${r.text}\n the launching window was observed (seen ${[...seen].join(",")})`).toBeDefined();
      expect(r.text).toMatch(/会话身份登记失败/);
      expect(r.code, r.text).toBe(75);
      expect(r.ms).toBeLessThan(15_000); // pi was stopped, not waited for
      expect(existsSync(recFile)).toBe(false);
      expect(spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status).toBe(0);
      expect(globalMounted(e.mnt)).toBe(false);
    } finally {
      clearInterval(poll);
    }
  }, 90_000);

  it("P1 SIGKILLed mid-session: P0 waits for pi, then outer cleanup TERMs gocryptfs and releases (exit 1)", async (ctx) => {
    const e = setup();
    await awaitNoForeignGocryptfs(ctx, e.r);
    const r = await runPrivate(
      e,
      { FAKE_PI_SLEEP: "4000", FAKE_PI_EXIT: "5" },
      () => {
        const rec = JSON.parse(readFileSync(join(e.dir, "private.json"), "utf8"));
        process.kill(rec.supervisor.pid, "SIGKILL");
      },
      2_000,
    );
    expect(r.code, r.text).toBe(1);
    expect(r.text).toMatch(/监督进程意外退出/);
    expect(r.text).toMatch(/已终止 pid \d+ gocryptfs/);
    expect(existsSync(join(e.dir, "private.json"))).toBe(false);
    expect(spawnSync("flock", ["-n", join(e.dir, "mount.lease"), "true"]).status).toBe(0);
  }, 90_000);
});
