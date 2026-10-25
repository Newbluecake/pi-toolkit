/**
 * N4 — `pi-secure run --private` launcher e2e (private-plan r3 §6.2), real gocryptfs + real
 * unshare, fake pi (see private-real-harness.ts), fake passfile password typed through script(1).
 *
 * Self-gated: skipped (with the reason in the suite title) when FUSE / unprivileged user
 * namespaces / the tools are missing. Serialized with every other real-mount suite through the
 * gocryptfs test lock. §6.2 items already pinned by the N1/N2 real blocks are not repeated here
 * (see N4-report §2 for the full item → test map).
 */
import { readFileSync, rmSync, writeFileSync, existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import {
  HELPER,
  RealHarness,
  alive,
  awaitNoForeignGocryptfs,
  fdHolders,
  globalMounted,
  inside,
  killVerified,
  leaseFree,
  lookInside,
  piFacts,
  plain,
  procStart,
  realSkipReason,
  recordOf,
  recordPath,
  sleep,
  until,
  untilPhase,
  type Env,
} from "./private-real-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);
const SKIP = realSkipReason();
const T = new RealHarness();

const id = (x: { pid: number; start: number }) => ({ pid: x.pid, start: x.start });
const ppidOf = (pid: number) => {
  const t = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[1]);
};
const pgidOf = (pid: number) => {
  const t = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[2]);
};
/** Expect a refusal with no password prompt and no new record of our own. */
function refusedNoPrompt(r: { code: number | null; text: string }, code = 76) {
  expect(r.code, r.text).toBe(code);
  expect(r.text).not.toMatch(/Password:/);
}

describe.skipIf(SKIP !== "")(
  `N4 e2e: run --private on real gocryptfs + unshare${SKIP ? ` (skipped: ${SKIP})` : ""}`,
  () => {
    let release: (() => void) | undefined;
    beforeAll(async () => {
      release = await acquireGocryptfsTestLock();
    }, 250_000);
    afterAll(() => release?.());
    afterEach(() => T.cleanup());

    async function fresh(ctx: { skip: () => void }, extra: string[] = []): Promise<Env> {
      const e = T.setup(extra);
      await awaitNoForeignGocryptfs(ctx, e.r);
      return e;
    }

    it("§6.2-1 happy path: invisible outside while running, data persists for a later ordinary mount", async (ctx) => {
      const e = await fresh(ctx);
      const canary = `canary-${process.pid}-${Date.now()}`;
      const run = T.tty(e, "run acme --private -- hi", {
        FAKE_PI_DATA: canary,
        FAKE_PI_SLEEP: "3000",
        FAKE_PI_EXIT: "7",
      });
      await untilPhase(e, "session");
      await until(() => existsSync(e.rec), 5_000, "fake pi facts");
      const pi = piFacts(e);
      expect(pi).toMatchObject({ uid: process.getuid(), cap: "0000000000000000", NS: "1", fd9: e.lease });
      expect(pi.cwd).toBe(join(e.mnt, "work"));
      // outside view: sentinel intact, nothing in the global table, the canary is nowhere to be found
      expect(readFileSync(join(e.mnt, "work"), "utf8")).toBe("");
      expect(globalMounted(e.mnt)).toBe(false);
      expect(await H.probeLease(H.leaseIdentitySync({ lease: e.lease }))).toBe("held");
      const grep = (await import("node:child_process")).spawnSync("grep", ["-rFa", canary, e.mnt, e.dir]);
      expect(grep.status).toBe(1); // no match (cipher text only)
      expect(plain(e, "status acme").out).toMatch(/^acme: private  layout ok /m);
      const r = await run;
      expect(r.code, r.text).toBe(7);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
      expect(lookInside(e, (root) => readFileSync(join(root, "work", "data.txt"), "utf8"))).toBe(canary);
    }, 90_000);

    it("§6.2-3 mutual exclusion: global mount (same or other vault) ⇒ run --private 76; during a session plain run / second --private / ns-internal lock ⇒ 76", async (ctx) => {
      const e = await fresh(ctx, ["other"]);
      // (a) an ordinary (global) mount of acme exists ⇒ run --private refused before any prompt
      const g = (await import("node:child_process")).spawnSync(
        "gocryptfs",
        [
          "-q",
          "-nonempty", // the mount point holds the two sentinels
          "-passfile",
          join(e.r, "pf"),
          "--",
          join(e.dir, "cipher"),
          e.mnt,
        ],
        { env: e.env },
      );
      expect(g.status).toBe(0);
      try {
        const a = await T.tty(e, "run acme --private -- hi");
        refusedNoPrompt(a);
        expect(a.text).toMatch(/已普通挂载（对所有同用户进程可见）/);
      } finally {
        (await import("node:child_process")).spawnSync("fusermount3", ["-u", e.mnt]);
      }
      // another vault's global mount would be copied into the new ns (Q10) ⇒ refused as well
      const otherMnt = join(e.h, "secure", "other");
      const go = (await import("node:child_process")).spawnSync(
        "gocryptfs",
        [
          "-q",
          "-nonempty",
          "-passfile",
          join(e.r, "pf"),
          "--",
          join(e.h, ".local", "share", "pi-toolkit-secure", "other", "cipher"),
          otherMnt,
        ],
        { env: e.env },
      );
      expect(go.status).toBe(0);
      try {
        const o = await T.tty(e, "run acme --private -- hi");
        refusedNoPrompt(o);
        expect(o.text).toMatch(/保险库 other 正全局挂载：私有命名空间会复制这个挂载/);
      } finally {
        (await import("node:child_process")).spawnSync("fusermount3", ["-u", otherMnt]);
      }
      // (b)/(c) during a private session
      const trig = join(e.r, "trig");
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "30000", FAKE_PI_TRIGGER: trig });
      await untilPhase(e, "session");
      const b = await T.tty(e, "run acme -- hi");
      refusedNoPrompt(b);
      expect(b.text).toMatch(new RegExp(`pi pid ${recordOf(e).pi.pid}`));
      const second = await T.tty(e, "run acme --private -- hi");
      refusedNoPrompt(second);
      expect(second.text).toMatch(/--private 实例正在运行/);
      const c = await inside(e, trig, 1, "lock acme --kill");
      expect(c.code, c.out + c.err).toBe(76);
      expect(c.err).toMatch(/不能在私有会话内部收尾自己；退出 pi 即自动收尾/);
      expect(alive(recordOf(e).pi)).toBe(true); // the session itself is unaffected
      killVerified(recordOf(e).pi, "SIGTERM");
      expect((await run).code).toBe(143);
      expect(leaseFree(e)).toBe(true);
    }, 120_000);

    it("§6.2-4 lock inside the launching window (post-mount checks held 4 s): plain/--lazy 76, session unaffected", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", {
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_WORKER_DELAY: "post-mount:4000",
        FAKE_PI_SLEEP: "500",
        FAKE_PI_EXIT: "9",
      });
      await untilPhase(e, "launching");
      const l = plain(e, "lock acme");
      expect(l.code, l.text).toBe(76);
      expect(l.err).toMatch(/会话仍在运行（启动中）/);
      const z = plain(e, "lock acme --lazy");
      expect(z.code, z.text).toBe(76);
      expect(z.err).toMatch(/会话尚未启动完成，稍后再试/);
      expect(recordOf(e).phase).toBe("launching");
      const r = await run;
      expect(r.code, r.text).toBe(9); // pi still started and ran to its own exit
      expect(existsSync(recordPath(e))).toBe(false);
    }, 90_000);

    it("§6.2-4 lock --kill inside the launching window: P1 aborts before pi, finalizes, P0 releases ⇒ lock 0", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", {
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_WORKER_DELAY: "post-mount:4000",
      });
      await untilPhase(e, "launching");
      const t0 = Date.now();
      const k = plain(e, "lock acme --kill");
      expect(k.code, k.text).toBe(0);
      expect(k.out).toMatch(/--private 会话已结束并收尾|清理了失效的 --private 记录/);
      expect(Date.now() - t0).toBeLessThan(12_000);
      const r = await run;
      expect(r.code, r.text).toBe(1);
      expect(r.text).toMatch(/已中止/);
      expect(existsSync(e.rec)).toBe(false); // pi never started
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("§6.2-5 --lazy control group (R29): open fd and in-vault cwd keep reading, new path lookups fail, session continues", async (ctx) => {
      const e = await fresh(ctx);
      const log = join(e.r, "lazy.log");
      const run = T.tty(e, "run acme --private -- hi", {
        FAKE_PI_DATA: "lazy-data",
        FAKE_PI_LAZY_CTL: log,
        FAKE_PI_LAZY_ABS: join(e.mnt, "work", "data.txt"),
        FAKE_PI_SLEEP: "6000",
      });
      await untilPhase(e, "session");
      await until(() => existsSync(log) && readFileSync(log, "utf8").split("\n").length > 2, 5_000, "ctl log");
      const before = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .at(-1);
      expect(before).toMatchObject({ fd: "lazy-data", rel: "lazy-data", abs: "lazy-data" });
      const rec = recordOf(e);
      const z = plain(e, "lock acme --lazy");
      expect(z.code, z.text).toBe(0);
      expect(z.out).toContain(H.LAZY_DETACHED_TEXT);
      // the plugin's LOCKED evidence: the vault mount is gone from the session's own mount table
      const mi = readFileSync(`/proc/${rec.supervisor.pid}/mountinfo`, "utf8");
      expect(H.vaultMountState(mi, rec.realMnt, rec.realCipher)).toBe("absent");
      await sleep(700);
      const after = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .at(-1);
      expect(after.t).toBeGreaterThan(Date.now() - 1_000);
      expect(after.fd).toBe("lazy-data"); // R29: an already-open fd keeps reading plaintext
      expect(after.rel).toBe("lazy-data"); // R29: so does a cwd inside the detached mount
      expect(after.abs).toMatch(/^ERR:(ENOTDIR|ENOENT)$/); // a NEW path lookup no longer reaches it
      expect(alive(rec.pi)).toBe(true);
      const r = await run;
      expect(r.code, r.text).toBe(0);
      expect(r.text).toMatch(/pid \d+ node/); // the control helper was listed and terminated by finalize
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("§6.2-6 foreground process group SIGKILL: setsid gocryptfs survives ⇒ orphan, every entry refuses, lock cleans", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      const pg = pgidOf(rec.owner.pid);
      expect(pgidOf(rec.supervisor.pid)).toBe(pg);
      expect(pgidOf(rec.pi.pid)).toBe(pg);
      expect(pgidOf(rec.gocryptfs.pid)).not.toBe(pg); // setsid
      process.kill(-pg, "SIGKILL");
      await until(() => !alive(rec.owner) && !alive(rec.supervisor) && !alive(rec.pi), 5_000, "group gone");
      expect(alive(rec.gocryptfs)).toBe(true);
      expect(plain(e, "status acme").out).toMatch(/^acme: private:orphan  /m);
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      const l = plain(e, "lock acme");
      expect(l.code, l.text).toBe(0);
      expect(l.out).toMatch(/已终止 pid \d+ gocryptfs/);
      expect(alive(rec.gocryptfs)).toBe(false);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
      await run;
    }, 90_000);

    it("N2 residual: lock during finalizing waits for the instance to finish (in-ns finalize held 3 s)", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", {
        FAKE_PI_SLEEP: "60000",
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_FINALIZE_STALL_MS: "3000",
      });
      await untilPhase(e, "session");
      killVerified(recordOf(e).pi, "SIGTERM");
      await untilPhase(e, "finalizing", 5_000);
      const t0 = Date.now();
      const l = plain(e, "lock acme");
      expect(l.code, l.text).toBe(0);
      expect(l.text).toMatch(/--private 实例正在收尾，等待/);
      expect(l.text).toMatch(/--private 实例已收尾|清理了失效的 --private 记录/);
      expect(Date.now() - t0).toBeGreaterThan(1_000); // it really waited
      expect(Date.now() - t0).toBeLessThan(12_000);
      const r = await run;
      expect(r.code, r.text).toBe(143);
      expect(r.text).not.toMatch(/收尾未完成|外部收尾/);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("r3.1 F1: P0/P1/gocryptfs dead, a SIGHUP-immune pi + its job alive ⇒ orphan-ns; lock --kill ends both (provable), releases", async (ctx) => {
      const e = await fresh(ctx);
      // P0 is the pty's controlling process: its death hangs up the foreground group, so a pi that
      // outlives it must ignore SIGHUP (nohup/tmux-like) — otherwise this state is pi-less (see 6a)
      const run = T.tty(e, "run acme --private -- hi", {
        FAKE_PI_SLEEP: "60000",
        FAKE_PI_LEFTOVER: "1",
        FAKE_PI_IGNORE_HUP: "1",
      });
      await untilPhase(e, "session");
      await until(() => existsSync(e.rec), 5_000, "facts");
      const rec = recordOf(e);
      const job = { pid: piFacts(e).kids.leftover as number, start: 0 };
      job.start = procStart(job.pid)!;
      T.track(job.pid);
      for (const k of ["owner", "supervisor", "gocryptfs"] as const) expect(killVerified(rec[k])).toBe(true);
      await until(() => !alive(rec.owner) && !alive(rec.supervisor) && !alive(rec.gocryptfs), 5_000, "gone");
      await sleep(300);
      expect({ pi: alive(rec.pi), job: alive(job) }).toEqual({ pi: true, job: true });
      expect(readFileSync(e.rec + ".events", "utf8")).toMatch(/^SIGHUP$/m); // the hang-up did arrive
      // r3.1: no supervisor ⇒ not a session; gocryptfs dead + provable members ⇒ orphan-ns
      expect(plain(e, "status acme").out).toMatch(/^acme: private:orphan-ns  /m);
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      const k = plain(e, "lock acme --kill");
      expect(k.code, k.text).toBe(0);
      expect(k.text).toMatch(new RegExp(`已终止 pid ${rec.pi.pid} `));
      expect(k.text).toMatch(new RegExp(`已终止 pid ${job.pid} sleep`));
      expect(alive(rec.pi) || alive(job)).toBe(false);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
      await run;
    }, 90_000);

    it("r3.1 F1: only P1 killed (P0 + pi + gocryptfs alive) ⇒ orphan; lock --kill TERMs pi + gocryptfs, P0 then exits, all released", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      expect(killVerified(rec.supervisor)).toBe(true);
      await until(() => !alive(rec.supervisor), 5_000, "P1 gone");
      expect(alive(rec.owner) && alive(rec.pi) && alive(rec.gocryptfs)).toBe(true);
      expect(plain(e, "status acme").out).toMatch(/^acme: private:orphan  /m);
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      const k = plain(e, "lock acme --kill");
      expect(k.code, k.text).toBe(0);
      expect(k.text).toMatch(new RegExp(`已终止 pid ${rec.pi.pid} `));
      expect(k.text).toMatch(new RegExp(`已终止 pid ${rec.gocryptfs.pid} gocryptfs`));
      const r = await run;
      expect(alive(rec.owner) || alive(rec.pi) || alive(rec.gocryptfs)).toBe(false);
      expect(r.code, r.text).not.toBe(0);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("r3.1 F1 counter-example: supervisor ALIVE (P0 dead, pi ignores the hang-up) ⇒ still a session; plain lock refuses and never touches pi", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000", FAKE_PI_IGNORE_HUP: "1" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      expect(killVerified(rec.owner)).toBe(true);
      await until(() => !alive(rec.owner), 5_000, "P0 gone");
      await sleep(300);
      expect(alive(rec.supervisor) && alive(rec.pi) && alive(rec.gocryptfs)).toBe(true);
      expect(plain(e, "status acme").out).toMatch(/^acme: private  /m);
      const l = plain(e, "lock acme");
      expect(l.code, l.text).toBe(76);
      expect(l.text).not.toMatch(/已终止/);
      // review N4-r2 #1: the outer-cleanup primitive itself re-proves the supervisor's death under
      // the lock — called directly with a LIVE supervisor it refuses (REC.SUPERVISOR) and signals nothing
      const { spawnSync } = await import("node:child_process");
      const t = spawnSync(process.execPath, [HELPER, "__private-terminate", "acme", rec.instanceId, "2000"], {
        env: e.env,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(t.status, t.stdout + t.stderr).toBe(H.REC.SUPERVISOR);
      expect(t.stdout).toMatch(/"supervisor":"alive"/);
      await sleep(300);
      expect(alive(rec.pi) && alive(rec.supervisor) && alive(rec.gocryptfs)).toBe(true);
      // the session still ends cleanly through its own supervisor
      expect(killVerified(rec.pi, "SIGTERM")).toBe(true);
      await until(() => !alive(rec.supervisor) && !alive(rec.gocryptfs), 15_000, "in-ns finalize done");
      await run;
      // P0 died, so nobody deleted the record: the inNsDone record is stale and lock releases it
      expect(plain(e, "status acme").out).toMatch(/^acme: (private:stale-record|locked)  /m);
      expect(plain(e, "lock acme").code).toBe(0);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("§6.2-8 worker timeout (review N4 #4): the readdir probe worker exceeds its 3 s budget ⇒ detected, 75, pi never starts, bounded, released", async (ctx) => {
      const e = await fresh(ctx);
      const t0 = Date.now();
      const r = await T.tty(e, "run acme --private -- hi", {
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_WORKER_DELAY: "readdir:15000",
      });
      const ms = Date.now() - t0;
      expect(r.code, r.text).toBe(75);
      expect(r.text).toMatch(/挂载内操作 readdir 超时/);
      expect(existsSync(e.rec)).toBe(false); // pi never started
      // budget 3 s (+ TERM/KILL grace) + in-ns finalize — far below the 15 s the worker would sleep
      expect(ms).toBeLessThan(12_000);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
      expect(globalMounted(e.mnt)).toBe(false);
    }, 90_000);

    it("§6.2-6 record deleted mid-session: lease:unrecorded, entries refuse, lock never kills; session still ends clean", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      rmSync(recordPath(e));
      expect(plain(e, "status acme").out).toMatch(/^acme: lease:unrecorded  /m);
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      const l = plain(e, "lock acme --kill");
      expect(l.code, l.text).toBe(76);
      expect(alive(rec.pi) && alive(rec.gocryptfs) && alive(rec.supervisor)).toBe(true);
      killVerified(rec.pi, "SIGTERM");
      const r = await run;
      expect(r.code, r.text).toBe(143);
      expect(r.text).toMatch(/记录已不在/);
      await until(() => leaseFree(e), 5_000, "lease free");
      expect(alive(rec.gocryptfs)).toBe(false);
    }, 90_000);

    it("P1 killed: gocryptfs ALONE holds the lease — plain unlock and a new --private both refused until it exits", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      // P0 first (it would otherwise wait for pi and clean up), then P1 (= the shell chain after exec), then pi
      expect(killVerified(rec.owner)).toBe(true);
      expect(killVerified(rec.supervisor)).toBe(true);
      expect(killVerified(rec.pi)).toBe(true);
      await until(() => !alive(rec.owner) && !alive(rec.supervisor) && !alive(rec.pi), 5_000, "P0/P1/pi gone");
      expect(alive(rec.gocryptfs)).toBe(true);
      // nobody but gocryptfs (and its own syslog `logger` child, which inherits fd 9 from it) has
      // the lease open — observed fact, recorded in N4-report
      const holders = fdHolders(e.lease);
      expect(holders).toContain(rec.gocryptfs.pid);
      for (const p of holders) if (p !== rec.gocryptfs.pid) expect(ppidOf(p), `holder ${p}`).toBe(rec.gocryptfs.pid);
      expect(readlinkSync(`/proc/${rec.gocryptfs.pid}/fd/9`)).toBe(e.lease);
      expect(leaseFree(e)).toBe(false);
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      // once gocryptfs is gone the lease frees and the leftover record is stale
      expect(killVerified(rec.gocryptfs)).toBe(true);
      await until(() => leaseFree(e), 5_000, "lease free after gocryptfs");
      expect(plain(e, "status acme").out).toMatch(/^acme: private:stale-record  /m);
      const l = plain(e, "lock acme");
      expect(l.code, l.text).toBe(0);
      expect(existsSync(recordPath(e))).toBe(false);
      await run;
    }, 90_000);

    it("§6.2-6a B1 gate: P0+P1 killed, gocryptfs + background job alive ⇒ (a) lease, (b) orphaned job, (c) record removal, (d) cleanup", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000", FAKE_PI_LEFTOVER: "1" });
      await untilPhase(e, "session");
      await until(() => existsSync(e.rec), 5_000, "facts");
      const rec = recordOf(e);
      const job = { pid: piFacts(e).kids.leftover as number, start: 0 };
      job.start = procStart(job.pid)!;
      T.track(job.pid);
      expect(fdHolders(e.lease)).not.toContain(job.pid); // the job does not hold fd 9
      expect(killVerified(rec.owner)).toBe(true);
      expect(killVerified(rec.supervisor)).toBe(true); // the production chain: sh exec → unshare exec → node P1
      await until(() => !alive(rec.owner) && !alive(rec.supervisor), 5_000, "P0/P1 gone");
      // (a) gocryptfs (and pi) alive: lease held, its holder is gocryptfs; both mount entries refuse
      expect(alive(rec.gocryptfs) && alive(job)).toBe(true);
      expect(readlinkSync(`/proc/${rec.gocryptfs.pid}/fd/9`)).toBe(e.lease);
      expect(leaseFree(e)).toBe(false);
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      // (c-a) record removed in state (a): refused by the LEASE (unrecorded), not by the record
      const saved = readFileSync(recordPath(e));
      rmSync(recordPath(e));
      expect(plain(e, "status acme").out).toMatch(/^acme: lease:unrecorded  /m);
      const ua = await T.tty(e, "unlock acme");
      refusedNoPrompt(ua);
      expect(ua.text).toMatch(/未登记的进程持有/);
      writeFileSync(recordPath(e), saved, { mode: 0o600 });
      // P0 was the pty's controlling process: its death already hung up the foreground group, so
      // the (default-SIGHUP) pi is gone or going (observed; see N4-report §4). The job is now
      // orphaned: its parent chain to the instance is broken.
      killVerified(rec.pi, "SIGTERM");
      await until(() => !alive(rec.pi), 5_000, "pi gone");
      // (b) gocryptfs killed too ⇒ lease free, the ns still has the job ⇒ still refused (record + scan)
      expect(killVerified(rec.gocryptfs)).toBe(true);
      await until(() => leaseFree(e), 5_000, "lease free");
      const sb = plain(e, "status acme").out;
      // N1 review #2: an orphaned job cannot be PROVEN to belong to the instance ⇒ ns-in-use (not orphan-ns)
      expect(sb).toMatch(/^acme: private:ns-in-use  /m);
      expect(sb).toMatch(new RegExp(`unverified 1: pid ${job.pid} sleep`));
      refusedNoPrompt(await T.tty(e, "run acme --private -- hi"));
      refusedNoPrompt(await T.tty(e, "unlock acme"));
      // (c-b) record removed in state (b): no record + lease free ⇒ a new mount IS admitted (the old
      // gocryptfs is dead, its in-ns mount is ENOTCONN — there is never a second live gocryptfs)
      const saved2 = readFileSync(recordPath(e));
      rmSync(recordPath(e));
      expect(plain(e, "status acme").out).toMatch(/^acme: locked  layout ok /m);
      const ub = await T.tty(e, "unlock acme");
      expect(ub.code, ub.text).toBe(0);
      expect(globalMounted(e.mnt)).toBe(true);
      // Observed (N4-report §4): the ordinary lock's cwd-occupancy scan matches by PATH, so the job —
      // whose cwd is the same path inside the dead private mount — counts as an occupant ⇒ 76
      // (fail closed). --lazy (fusermount3 -uz) detaches the global mount.
      const lb = plain(e, "lock acme");
      expect(lb.code, lb.text).toBe(76);
      expect(lb.text).toMatch(new RegExp(`pid ${job.pid} sleep`));
      expect(plain(e, "lock acme --lazy").code).toBe(0);
      expect(globalMounted(e.mnt)).toBe(false);
      writeFileSync(recordPath(e), saved2, { mode: 0o600 });
      // (d) lock: the job is reported, never killed (unprovable); once a human ends it, lock releases
      const d1 = plain(e, "lock acme");
      expect(d1.code, d1.text).toBe(76);
      expect(d1.err).toMatch(new RegExp(`命名空间成员 pid ${job.pid} sleep（无法证明属于该实例，只报告、不终止）`));
      expect(alive(job)).toBe(true);
      expect(killVerified(job)).toBe(true);
      await until(() => !alive(job), 5_000, "job gone");
      const d2 = plain(e, "lock acme");
      expect(d2.code, d2.text).toBe(0);
      expect(d2.out).toMatch(/清理了失效的 --private 记录/);
      const again = await T.tty(e, "run acme --private -- hi");
      expect(again.code, again.text).toBe(0);
      await run;
    }, 150_000);

    it("§6.2-6b B2: P0 stopped through the normal exit ⇒ inNsDone record left (stale) ⇒ next run --private cleans it and proceeds", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "2500", FAKE_PI_EXIT: "4" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      expect(killVerified(rec.owner, "SIGSTOP")).toBe(true);
      await until(() => !alive(rec.supervisor), 15_000, "P1 exited");
      const left = recordOf(e);
      expect(left).toMatchObject({ instanceId: rec.instanceId, inNsDone: true, piExit: { code: 4 } });
      expect(leaseFree(e)).toBe(true); // P1 never deletes, but nothing holds fd 9 any more
      killVerified(rec.owner, "SIGKILL");
      await run;
      expect(plain(e, "status acme").out).toMatch(/^acme: private:stale-record  /m);
      const t0 = Date.now();
      const next = await T.tty(e, "run acme --private -- hi", { FAKE_PI_EXIT: "5" });
      expect(next.code, next.text).toBe(5);
      expect(next.text).toMatch(/清理了失效的 --private 记录/);
      expect(next.text).not.toMatch(/收尾未完成|外部收尾/);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(existsSync(recordPath(e))).toBe(false);
    }, 90_000);

    it("§6.2-7 pi's own non-zero exits pass through (1, 127) with a normal finalize", async (ctx) => {
      const e = await fresh(ctx);
      for (const code of [1, 127]) {
        const r = await T.tty(e, "run acme --private -- hi", { FAKE_PI_EXIT: String(code) });
        expect(r.code, r.text).toBe(code);
        expect(r.text).not.toMatch(/收尾未完成|外部收尾/);
        expect(existsSync(recordPath(e))).toBe(false);
        expect(leaseFree(e)).toBe(true);
      }
    }, 90_000);

    it("§6.2-8 a member ignoring TERM is KILLed by the in-ns finalize", async (ctx) => {
      const e = await fresh(ctx);
      const r = await T.tty(e, "run acme --private -- hi", { FAKE_PI_IGNORE_TERM: "1", FAKE_PI_SLEEP: "300" });
      expect(r.code, r.text).toBe(0);
      const pid = piFacts(e).kids.ignoreTerm as number;
      T.track(pid);
      expect(r.text).toMatch(new RegExp(`pid ${pid} sleep`));
      expect(procStart(pid)).toBeUndefined();
      expect(r.text).not.toMatch(/收尾未完成|外部收尾/);
    }, 90_000);

    it("§6.2-8 gocryptfs SIGSTOPped at session end: it never exits by itself ⇒ TERM/KILL path, finalize stays in-ns and bounded", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", { FAKE_PI_SLEEP: "60000" });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      expect(killVerified(rec.gocryptfs, "SIGSTOP")).toBe(true);
      const t0 = Date.now();
      killVerified(rec.pi, "SIGTERM");
      const r = await run;
      const ms = Date.now() - t0;
      expect(r.code, r.text).toBe(143);
      expect(ms).toBeLessThan(12_000);
      expect(alive(rec.gocryptfs)).toBe(false);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
    }, 90_000);

    it("§6.2-8 WORST PATH ≤22 s: in-ns finalize stalls to its 10.5 s backstop (75) + gocryptfs stopped ⇒ P0 outer cleanup", async (ctx) => {
      const e = await fresh(ctx);
      const run = T.tty(e, "run acme --private -- hi", {
        FAKE_PI_SLEEP: "60000",
        PI_SECURE_TEST_SEAMS: "1",
        PI_SECURE_TEST_FINALIZE_STALL_MS: "30000",
      });
      await untilPhase(e, "session");
      const rec = recordOf(e);
      expect(killVerified(rec.gocryptfs, "SIGSTOP")).toBe(true);
      const t0 = Date.now();
      killVerified(rec.pi, "SIGTERM"); // the session ends: from here on everything is finalization
      const r = await run;
      const ms = Date.now() - t0;
      expect(ms, r.text).toBeLessThanOrEqual(22_000);
      expect(ms).toBeGreaterThan(10_000); // the in-ns backstop really fired first
      expect(r.text).toMatch(/ns 内收尾未完成/);
      expect(r.text).toMatch(/执行外部收尾/);
      expect(r.text).toMatch(/已终止 pid \d+ gocryptfs/);
      expect(r.code, r.text).toBe(143); // outer cleanup succeeded ⇒ pi's own code
      expect(alive(rec.gocryptfs)).toBe(false);
      expect(existsSync(recordPath(e))).toBe(false);
      expect(leaseFree(e)).toBe(true);
      expect(globalMounted(e.mnt)).toBe(false);
    }, 90_000);

    it("§6.2-8 mount.lock held elsewhere ⇒ 73 after the claim wait, no prompt, no record", async (ctx) => {
      const e = await fresh(ctx);
      const { spawn } = await import("node:child_process");
      const holder = spawn("flock", [join(e.dir, "mount.lock"), "sleep", "30"], {
        stdio: "ignore",
        detached: true,
        env: e.env, // carries the run token ⇒ cleanup may end it
      });
      T.track(holder.pid!);
      await sleep(200);
      const r = await T.tty(e, "run acme --private -- hi");
      refusedNoPrompt(r, 73);
      expect(r.ms).toBeLessThan(15_000);
      expect(existsSync(recordPath(e))).toBe(false);
    }, 120_000);

    it("§6.2-9 refused pi arguments ⇒ 64 before any claim, prompt or record", async (ctx) => {
      const e = await fresh(ctx);
      for (const a of ["--session-dir /x", "--no-extensions", "--export /tmp/x.html"]) {
        const r = await T.tty(e, `run acme --private ${a}`);
        refusedNoPrompt(r, 64);
        expect(existsSync(recordPath(e))).toBe(false);
      }
      void id;
    }, 120_000);
  },
);
