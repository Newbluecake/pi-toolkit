/**
 * scheduled-reports plan r3 §4.6 (S1): holder liveness (dead pid, start-time reuse, boot change,
 * same-process stale epoch, cross host, unprovable), run recovery (unknown / dropped), shutdown
 * close of the own epoch, and the session lock's M-T4 behaviour (live and cross-host holders ⇒
 * E_BUSY, dead and own-process leftovers ⇒ broken).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { autoClaim, closeEpoch, recoverRuns } from "../../../src/schedule/core/claim.js";
import { withSessionLock } from "../../../src/schedule/core/lock.js";
import { openDirPath, sessionDirName } from "../../../src/schedule/core/paths.js";
import { holderOf, judgeHolder, unknownRunKeys, type ProcessIdentity } from "../../../src/schedule/core/recovery.js";
import type { Holder } from "../../../src/schedule/core/spec.js";
import { platformIdentity, platformProbe, spawnLockHolder } from "../../helpers/sched-platform.js";
import { addTask, approve, env, makeTask, readOk, SID, utc, type Env } from "./fixtures.js";

let E: Env;
afterEach(() => E?.cleanup());
const T8 = utc("2026-10-24T08:00:00Z");

let live: ChildProcess;
let liveId: ProcessIdentity;
let deadId: ProcessIdentity;
/** The judging process's REAL identity (darwin plan §5.2 #2): /proc on Linux, ps/sysctl on darwin. */
let realSelf: ProcessIdentity;

beforeAll(() => {
  live = spawn("sleep", ["60"], { stdio: "ignore" });
  const s = platformProbe().startOf(live.pid!);
  if (typeof s !== "number") throw new Error("no liveness probe");
  const me = platformIdentity().readSelf();
  if (me === undefined) throw new Error("no process identity");
  realSelf = me;
  liveId = { ...me, pid: live.pid!, start: s };
  const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  deadId = { ...me, pid: Number(r.stdout.trim()), start: 1 };
});
afterAll(() => {
  live.kill("SIGKILL");
});

describe("judgeHolder", () => {
  const me = (): ProcessIdentity => realSelf;
  it("matrix", () => {
    const s = me();
    expect(judgeHolder({ ...s, epoch: "e" }, s)).toEqual({ liveness: "alive" });
    expect(judgeHolder({ ...deadId, epoch: "e" }, s)).toEqual({ liveness: "dead", cause: "crash" });
    expect(judgeHolder({ ...liveId, boot: "other-boot", epoch: "e" }, s)).toEqual({ liveness: "dead", cause: "crash" });
    expect(judgeHolder({ ...liveId, host: "elsewhere", epoch: "e" }, s)).toEqual({ liveness: "unprovable" });
    expect(judgeHolder({ ...deadId, host: "elsewhere", epoch: "e" }, s)).toEqual({ liveness: "unprovable" });
    // same process, other epoch: dead only when this process KNOWS it was disposed
    expect(judgeHolder({ ...s, epoch: "old" }, s, { currentEpoch: "new" })).toEqual({ liveness: "alive" });
    expect(judgeHolder({ ...s, epoch: "old" }, s, { currentEpoch: "new", epochDisposed: (e) => e === "old" })).toEqual({
      liveness: "dead",
      cause: "reload",
    });
    // unreadable /proc entry / EPERM ⇒ unprovable, never dead
    const probe = { startOf: () => "error" as const, pidMayExist: () => true };
    expect(judgeHolder({ ...deadId, epoch: "e" }, s, { probe })).toEqual({ liveness: "unprovable" });
    const eperm = { startOf: () => undefined, pidMayExist: () => true };
    expect(judgeHolder({ ...deadId, epoch: "e" }, s, { probe: eperm })).toEqual({ liveness: "unprovable" });
  });

  // /proc-specific (darwin plan §5.2 #2): these two judge through the DEFAULT probe, which reads
  // /proc/<pid>/stat. On darwin that entry does not exist (unprovable), so the assertions stay
  // Linux-only; the darwin probe's live-pid semantics are pinned in identity-domain.test.ts (P1).
  describe.skipIf(process.platform !== "linux")("default-probe live reads (/proc only)", () => {
    it("live pid: same start ⇒ alive, shifted start ⇒ dead(crash)", () => {
      const s = me();
      expect(judgeHolder({ ...liveId, epoch: "e" }, s)).toEqual({ liveness: "alive" });
      expect(judgeHolder({ ...liveId, start: liveId.start + 1, epoch: "e" }, s)).toEqual({
        liveness: "dead",
        cause: "crash",
      });
    });
  });
});

describe("run recovery", () => {
  async function seeded(h: Holder, form: "background" | "message" = "background") {
    E = env(T8 - 60_000);
    const store = E.store();
    const t = approve(makeTask(form === "message" ? { form: "message" } : {}));
    await addTask(store, t, T8 - 60_000);
    E.clock.t = T8 + 1_000;
    const r = await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: h });
    expect(r.kind).toBe("fired");
    return { store, t };
  }

  it("dead holder ⇒ unknown(crash); live and cross-host holders are left alone", async () => {
    const { store } = await seeded(holderOf(deadId, "e1"));
    expect(unknownRunKeys(readOk(store), realSelf)).toHaveLength(1); // the hub's read-only view agrees
    const r = await recoverRuns(store, realSelf);
    expect(r).toMatchObject({ kind: "recovered", runs: [{ to: "unknown", reason: "crash" }] });
    expect(readOk(store).runs[0]).toMatchObject({ state: "unknown", reason: "crash" });

    const live2 = await seeded(holderOf(liveId, "e1"));
    expect(await recoverRuns(live2.store, realSelf)).toMatchObject({ runs: [] });
    const far = await seeded(holderOf({ ...deadId, host: "far" }, "e1"));
    expect(await recoverRuns(far.store, realSelf)).toMatchObject({ runs: [] });
    expect(readOk(far.store).runs[0]!.state).toBe("dispatching");
  });

  it("stale epoch of THIS process ⇒ unknown(reload) when known disposed", async () => {
    const { store } = await seeded(holderOf(realSelf, "old-epoch"));
    expect(await recoverRuns(store, realSelf, { currentEpoch: "new" })).toMatchObject({ runs: [] });
    const r = await recoverRuns(store, realSelf, { currentEpoch: "new", epochDisposed: () => true });
    expect(r).toMatchObject({ runs: [{ reason: "reload" }] });
  });

  it("queued messages of a dead holder become dropped(owner-closed)", async () => {
    const { store } = await seeded(holderOf(deadId, "e1"), "message");
    await recoverRuns(store, realSelf);
    expect(readOk(store).runs[0]).toMatchObject({ state: "dropped", reason: "owner-closed" });
  });

  it("shutdown closes only its own epoch's runs as unknown(owner-closed)", async () => {
    const mine = holderOf(realSelf, "mine");
    const { store, t } = await seeded(mine);
    await store.transact((d) => {
      d.runs.push({
        ...structuredClone(d.runs[0]!),
        runKey: `${t.id}@m-00000000`,
        kind: "manual",
        holder: holderOf(realSelf, "other"),
      });
      return { value: 0, write: true };
    });
    const r = await closeEpoch(store, mine);
    expect(r).toMatchObject({ runs: [{ runKey: `${t.id}@${T8}`, to: "unknown", reason: "owner-closed" }] });
    expect(readOk(store).runs.map((x) => x.state)).toEqual(["unknown", "dispatching"]);
  });
});

describe("session lock — kernel flock (review B1/M6)", () => {
  async function lockDir(): Promise<{ fd: number; dir: string }> {
    E = env(T8);
    const store = E.store();
    await addTask(store, makeTask(), T8);
    const dir = join(E.storeDir, sessionDirName(SID));
    return { fd: openDirPath(dir).fd, dir };
  }
  /** An external process holding the kernel lock on `<dir>/.lock` until killed. */
  function holdExternally(dir: string): ChildProcess {
    // flock -o: the lock stays with the flock process itself (not inherited by `sleep`), so killing
    // it models "the holder process died"; the darwin perl holder blocks inside its own process
    // and then sleeps — the same death-releases-the-lock semantics (P4-B helper).
    return spawnLockHolder(join(dir, ".lock"));
  }
  async function untilBusy(fd: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await withSessionLock(fd, () => 0, { timeoutMs: 0 });
      if (!r.ok) return;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("external holder never acquired");
  }

  it("a live holder ⇒ E_BUSY after the deadline (body never runs); its death releases at once", async () => {
    const { fd, dir } = await lockDir();
    const ext = holdExternally(dir);
    try {
      await untilBusy(fd);
      let ran = false;
      const r = await withSessionLock(fd, () => (ran = true), { timeoutMs: 80 });
      expect(r).toMatchObject({ ok: false, code: "E_BUSY" });
      expect(ran).toBe(false);
      expect(await E.store().transact(() => ({ value: 0, write: true }))).toMatchObject({ ok: false, code: "E_BUSY" });
    } finally {
      ext.kill("SIGKILL");
    }
    await new Promise((res) => ext.once("exit", res));
    expect(await withSessionLock(fd, () => 7, { timeoutMs: 2_000 })).toEqual({ ok: true, value: 7 });
    closeSync(fd);
  });

  it("stale lock-file CONTENT (dead pid, foreign host, garbage) never matters and is never renamed/broken", async () => {
    const { fd, dir } = await lockDir();
    for (const content of [
      JSON.stringify({ ...deadId, epoch: "x" }),
      JSON.stringify({ ...liveId, host: "another-host", epoch: "x" }),
      "",
    ]) {
      writeFileSync(join(dir, ".lock"), content, { mode: 0o600 });
      const ino = lstatSync(join(dir, ".lock")).ino;
      expect(await withSessionLock(fd, () => 1, { timeoutMs: 100 })).toEqual({ ok: true, value: 1 });
      expect(lstatSync(join(dir, ".lock")).ino).toBe(ino); // same inode: nothing was broken
    }
    closeSync(fd);
  });

  it("repair has no forced break: a live holder ⇒ E_BUSY with an actionable hint", async () => {
    const { fd, dir } = await lockDir();
    writeFileSync(join(dir, "state.json"), "{broken", { mode: 0o600 });
    const ext = holdExternally(dir);
    try {
      await untilBusy(fd);
      const store = E.store();
      // @ts-expect-error — the forced-break option no longer exists (review M6)
      const r = await store.repair({ breakLock: true });
      expect(r).toMatchObject({ ok: false, code: "E_BUSY" });
      expect(r.ok ? "" : r.detail).toMatch(/released automatically when that process exits/);
    } finally {
      ext.kill("SIGKILL");
    }
    await new Promise((res) => ext.once("exit", res));
    expect(await E.store().repair()).toMatchObject({ ok: true, value: { quarantined: true } });
    closeSync(fd);
  });

  // Linux-only (darwin plan §5.2 #2): `flockBin` is the util-linux flock(1) knob — on darwin the
  // platform default ignores it (perl flock(2) succeeds), and the darwin fail-closed twin (a
  // missing perl binary ⇒ E_BUSY) is pinned in tests/integration/schedule-darwin-lock.test.ts.
  describe.skipIf(process.platform !== "linux")("no flock binary", () => {
    it("⇒ fail closed (never an unlocked write)", async () => {
      const { fd } = await lockDir();
      const r = await withSessionLock(fd, () => 1, { flockBin: "/nonexistent/flock", timeoutMs: 50 });
      expect(r).toMatchObject({ ok: false, code: "E_BUSY", detail: expect.stringMatching(/flock binary not found/) });
      expect(
        await E.store(undefined, { flockBin: "/nonexistent/flock" }).transact(() => ({ value: 0, write: true })),
      ).toMatchObject({
        ok: false,
      });
      closeSync(fd);
    });
  });
});
