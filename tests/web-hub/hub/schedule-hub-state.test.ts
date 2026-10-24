/**
 * scheduled-reports plan r3 §7.2 (H1 r2) — the hub's OWN coordination state: per-task reconcile
 * cursors + observation dedup set + PENDING delivery accumulators + hour gate + notifiedUnknown,
 * per-session droppedPending/droppedShown. Atomic 0600 writes; corrupt ⇒ fresh start (flagged);
 * flush reports success (delivery must not run on false); bounds-derived byte cap; prune keeps
 * quiescent task records only when nothing with duty would be dropped.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHED_HUB_STATE_FILE,
  SCHED_HUB_STATE_MAX_BYTES,
  SCHED_HUB_STATE_VERSION,
  createSchedHubStore,
  pruneReport,
  taskStateOf,
  type SchedHubFile,
  type SchedHubTaskState,
} from "../../../src/web-hub/hub/schedule/hub-state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-sched-hubstate-"));
  dirs.push(d);
  return d;
}

describe("createSchedHubStore — persistence", () => {
  it("round-trips pendings, gate and cursors (the E1 carry survives restarts)", async () => {
    const dir = tmp();
    const store = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await store.load();
    const stamp = Date.now() - 1_000;
    const ts = taskStateOf(store.data, "sid-a", "s_abcd2345");
    ts.consumedSeq = 2;
    ts.consumedTotal = 3;
    ts.observed = [{ t: 1, defHash: "a".repeat(64), at: stamp }];
    ts.pendingMissed = 4;
    ts.pendingUnknown = ["s_abcd2345@1", "s_efgh6789@2"];
    ts.gate = { hour: 10, attempted: true };
    ts.notifiedUnknown = [{ runKey: "s_abcd2345@9", at: stamp }];
    taskStateOf(store.data, "sid-a", "s_efgh6789");
    store.data.sessions["sid-a"]!.droppedPending = 5;
    store.data.sessions["sid-a"]!.droppedShown = 2;
    store.data.sessions["sid-a"]!.lastSeenAt = Date.now();
    expect(await store.flush()).toBe(true);
    await store.close();

    const second = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await second.load();
    expect(second.degraded).toBe(false);
    const back = taskStateOf(second.data, "sid-a", "s_abcd2345");
    expect(back.consumedSeq).toBe(2);
    expect(back.observed).toEqual([{ t: 1, defHash: "a".repeat(64), at: stamp }]);
    expect(back.pendingMissed).toBe(4);
    expect(back.pendingUnknown).toEqual(["s_abcd2345@1", "s_efgh6789@2"]);
    expect(back.gate).toEqual({ hour: 10, attempted: true });
    expect(back.notifiedUnknown).toEqual([{ runKey: "s_abcd2345@9", at: stamp }]);
    expect(second.data.sessions["sid-a"]!.droppedPending).toBe(5);
    expect(second.data.sessions["sid-a"]!.droppedShown).toBe(2);
    expect(taskStateOf(second.data, "sid-a", "s_efgh6789").consumedSeq).toBe(0);
    await second.close();
  });

  it("writes 0600 atomically (tmp+rename — no .tmp residue)", async () => {
    const dir = tmp();
    const path = join(dir, SCHED_HUB_STATE_FILE);
    const store = createSchedHubStore(path);
    await store.load();
    taskStateOf(store.data, "sid-a", "s_abcd2345");
    expect(await store.flush()).toBe(true);
    await store.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${path}.tmp`)).toThrow();
  });

  it("a missing file loads empty (not degraded); a corrupt file degrades to a fresh start", async () => {
    const dir = tmp();
    const missing = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await missing.load();
    expect(missing.degraded).toBe(false);
    expect(missing.data.sessions).toEqual({});
    await missing.close();

    const path = join(dir, "d", SCHED_HUB_STATE_FILE);
    mkdirSync(join(dir, "d"), { mode: 0o700 });
    writeFileSync(path, "{not json", { mode: 0o600 });
    const store = createSchedHubStore(path);
    await store.load();
    expect(store.degraded).toBe(true);
    expect(store.data.sessions).toEqual({});
    taskStateOf(store.data, "sid-a", "s_abcd2345");
    expect(await store.flush()).toBe(true);
    expect(store.degraded).toBe(false);
    await store.close();
    const reread = JSON.parse(readFileSync(path, "utf8")) as SchedHubFile;
    expect(reread.v).toBe(SCHED_HUB_STATE_VERSION);
  });

  it("flush() resolves FALSE on a write failure (delivery must not proceed) and stays false-flagged", async () => {
    const dir = tmp();
    const path = join(dir, SCHED_HUB_STATE_FILE);
    let fail = false;
    const store = createSchedHubStore(path, {
      fs: {
        ensureDir() {},
        read: () => {
          throw new Error("ENOENT");
        },
        exists: () => false,
        writeAtomic: () => {
          if (fail) throw new Error("EIO");
        },
      },
    });
    await store.load();
    taskStateOf(store.data, "sid-a", "s_abcd2345").pendingMissed = 2;
    fail = true;
    expect(await store.flush()).toBe(false);
    expect(store.degraded).toBe(true);
    fail = false;
    expect(await store.flush()).toBe(true);
    await store.close();
  });

  it("flushes serialize (no interleaved writes) and close drains the chain", async () => {
    const dir = tmp();
    const store = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await store.load();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        store.flush().then(() => {
          order.push(i);
        }),
      ),
    );
    await store.close();
    expect(order).toEqual([1, 2, 3]);
  });

  it("bounds are stop-adding caps, not evictions: observed/pendingUnknown/notifiedUnknown ≤ 64", async () => {
    const dir = tmp();
    const store = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await store.load();
    const ts = taskStateOf(store.data, "sid-a", "s_abcd2345");
    ts.observed = Array.from({ length: 100 }, (_, i) => ({ t: i, defHash: "a".repeat(64), at: i }));
    ts.pendingUnknown = Array.from({ length: 100 }, (_, i) => `s_abcd2345@${i}`);
    ts.notifiedUnknown = Array.from({ length: 100 }, (_, i) => ({ runKey: `s_abcd2345@${i}`, at: i }));
    store.data.sessions["sid-a"]!.lastSeenAt = Date.now();
    await store.flush();
    const kept = taskStateOf(store.data, "sid-a", "s_abcd2345");
    expect(kept.observed.length).toBeLessThanOrEqual(64);
    expect(kept.pendingUnknown.length).toBeLessThanOrEqual(64);
    expect(kept.notifiedUnknown.length).toBeLessThanOrEqual(64);
    await store.close();
  });

  it("the byte cap fits the worst legal capacity (96×8×(64+64+64) records)", async () => {
    const file: SchedHubFile = { v: SCHED_HUB_STATE_VERSION, sessions: {} };
    for (let s = 0; s < 96; s++) {
      const sid = `sid-${String(s).padStart(3, "0")}`;
      file.sessions[sid] = { tasks: {}, droppedPending: 0, droppedShown: 0, lastSeenAt: Date.now() };
      for (let t = 0; t < 8; t++) {
        const ts: SchedHubTaskState = {
          consumedSeq: 123456,
          consumedTotal: 123456,
          observed: Array.from({ length: 64 }, (_, i) => ({
            t: 1761350400000 + i * 3_600_000,
            defHash: "a".repeat(64),
            at: 1761350400000,
          })),
          pendingMissed: 99,
          pendingUnknown: Array.from({ length: 64 }, (_, i) => `s_abcd2345@176135040000${i}`),
          gate: { hour: 489264, attempted: true },
          notifiedUnknown: Array.from({ length: 64 }, (_, i) => ({
            runKey: `s_abcd2345@176135040000${i}`,
            at: 1761350400000,
          })),
        };
        file.sessions[sid]!.tasks[`s_task${String(t).padStart(3, "0")}`] = ts;
      }
    }
    const bytes = JSON.stringify(file).length;
    expect(bytes).toBeLessThan(SCHED_HUB_STATE_MAX_BYTES);
  });

  it("r2 #14: orphans trim oldest-first; LIVE records are never evicted; overflow keeps everything", () => {
    const file: SchedHubFile = { v: SCHED_HUB_STATE_VERSION, sessions: {} };
    const mk = (lastAt: number, pending = 0): SchedHubTaskState => ({
      lastAt,
      consumedSeq: 1,
      consumedTotal: 1,
      observed: [],
      pendingMissed: pending,
      pendingUnknown: [],
      gate: { hour: 489264, attempted: true },
      notifiedUnknown: [],
    });
    const session = {
      tasks: {} as Record<string, SchedHubTaskState>,
      droppedPending: 0,
      droppedShown: 0,
      lastSeenAt: Date.now(),
    };
    // 32 PENDING orphans (deleted tasks) at various ages + ONE live task with an old anchor.
    for (let i = 0; i < 32; i++) session.tasks[`s_orph${String(i).padStart(2, "0")}aa`] = mk(1_000 + i, 1);
    const active = mk(1, 5); // OLDEST anchor of all — must still survive
    session.tasks["s_liveaaaa"] = active;
    file.sessions["sid-a"] = session;
    file.sessions["stale"] = { tasks: {}, droppedPending: 0, droppedShown: 0, lastSeenAt: 1_000 };
    const live = (sid: string) => (sid === "sid-a" ? new Set(["s_liveaaaa"]) : new Set<string>());
    const report = pruneReport(file, Date.now(), live);
    expect(file.sessions["stale"]).toBeUndefined();
    // The LIVE record is untouched — cursor AND hour gate intact, no replay possible.
    expect(file.sessions["sid-a"]!.tasks["s_liveaaaa"]).toEqual(active);
    // Orphans were trimmed (oldest-first) down to the cap: 32 records total ⇒ 31 orphans kept…
    // wait: cap 32 − 1 live = 31 orphans kept of 32; the OLDEST (lastAt 1000) went first.
    expect(Object.keys(file.sessions["sid-a"]!.tasks)).toHaveLength(32);
    expect(file.sessions["sid-a"]!.tasks["s_orph00aa"]).toBeUndefined();
    expect(file.sessions["sid-a"]!.tasks["s_orph01aa"]).toBeDefined();
    expect(report.overflowSessions).toBe(0);
  });

  it("r2 #14: live records alone over the cap ⇒ NOTHING is deleted, the session counts as overflow", () => {
    const file: SchedHubFile = { v: SCHED_HUB_STATE_VERSION, sessions: {} };
    const session = {
      tasks: {} as Record<string, SchedHubTaskState>,
      droppedPending: 0,
      droppedShown: 0,
      lastSeenAt: Date.now(),
    };
    const ids: string[] = [];
    for (let i = 0; i < 33; i++) {
      // 33 live ids (defensive test — the reader caps real ledgers at 8, the backstop must not care)
      const id = `s_live${String(i).padStart(2, "0")}aa`;
      ids.push(id);
      session.tasks[id] = {
        lastAt: i,
        consumedSeq: i,
        consumedTotal: i,
        observed: [],
        pendingMissed: 0,
        pendingUnknown: [],
        gate: { hour: 489264, attempted: true },
        notifiedUnknown: [],
      };
    }
    file.sessions["sid-a"] = session;
    const report = pruneReport(file, Date.now(), () => new Set(ids));
    expect(Object.keys(session.tasks)).toHaveLength(33); // nothing deleted
    expect(report.overflowSessions).toBe(1);
  });

  it("r2 #4: a FILE fsync EIO makes flush() false (nothing may be delivered on top of it)", async () => {
    const dir = tmp();
    const store = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE), {
      fs: {
        ensureDir() {},
        read: () => {
          throw new Error("ENOENT");
        },
        exists: () => false,
        fsync() {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      },
    });
    await store.load();
    taskStateOf(store.data, "sid-a", "s_abcd2345").pendingMissed = 2;
    expect(await store.flush()).toBe(false);
    expect(store.degraded).toBe(true);
    await store.close();
  });

  it("r2 #4: fsync EINVAL (fs without fsync) stays tolerated — flush true; rename failure is false", async () => {
    const dir = tmp();
    const tolerant = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE), {
      fs: {
        ensureDir() {},
        read: () => {
          throw new Error("ENOENT");
        },
        exists: () => false,
        fsync() {
          throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
        },
      },
    });
    await tolerant.load();
    taskStateOf(tolerant.data, "sid-a", "s_abcd2345");
    expect(await tolerant.flush()).toBe(true);
    await tolerant.close();

    const brokenRename = createSchedHubStore(join(dir, "d", SCHED_HUB_STATE_FILE), {
      fs: {
        ensureDir() {},
        read: () => {
          throw new Error("ENOENT");
        },
        exists: () => false,
        rename() {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      },
    });
    await brokenRename.load();
    taskStateOf(brokenRename.data, "sid-a", "s_abcd2345");
    expect(await brokenRename.flush()).toBe(false);
    await brokenRename.close();
  });

  it("an unreadable existing file (directory at the path) degrades instead of crashing the hub", async () => {
    const dir = tmp();
    mkdirSync(join(dir, SCHED_HUB_STATE_FILE));
    const store = createSchedHubStore(join(dir, SCHED_HUB_STATE_FILE));
    await store.load();
    expect(store.degraded).toBe(true);
    taskStateOf(store.data, "sid-a", "s_abcd2345");
    await expect(store.flush()).resolves.toBe(false);
    await store.close();
  });
});
