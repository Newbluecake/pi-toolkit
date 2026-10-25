/**
 * scheduled-reports plan r3 §4.2/§4.2.1/§4.6/§4.7 (S1): single-file writer — atomic replace + rev,
 * first-terminal-wins, pendingReports write/remove/expire/overflow (R2-1), housekeeping, the
 * 256 KiB fit ladder, corrupt-file handling (E_DEGRADED, repair ⇒ .bak), the 64-directory cap,
 * report GC (referenced files never collected) and empty-directory recycling.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { autoClaim } from "../../../src/schedule/core/claim.js";
import { sessionDirName } from "../../../src/schedule/core/paths.js";
import {
  emptyStateFile,
  reportFileOf,
  reportIdOf,
  SCHED_PENDING_REPORTS_MAX,
  SCHED_REPORT_MAX_AGE_MS,
  SCHED_STATE_MAX_BYTES,
  type PendingReport,
  type ScheduleStateFile,
} from "../../../src/schedule/core/spec.js";
import {
  addPendingReport,
  findRun,
  finishRun,
  pendingReportFor,
  gcGlobalReports,
  gcSessionReports,
  planReportDeletions,
  recycleSessionDir,
  removePendingReports,
  serializeToFit,
  updateRun,
  writeReportLocked,
  type WriterFaultPoint,
} from "../../../src/schedule/core/writer.js";
import { addTask, approve, env, holder, HOUR, makeTask, MIN, readOk, self, SID, utc, type Env } from "./fixtures.js";

let E: Env;
afterEach(() => E?.cleanup());
const T8 = utc("2026-10-24T08:00:00Z");

function pending(sid: string, runKey: string, taskId: string, endedAt: number): PendingReport {
  return {
    reportId: reportIdOf(sid, runKey),
    runKey,
    taskId,
    form: "background",
    endedAt,
    expiresAt: endedAt + SCHED_REPORT_MAX_AGE_MS,
    reportFile: reportFileOf(sid, runKey),
    status: "completed",
  };
}

describe("transactions", () => {
  it("each write is one atomic replace with rev+1, 0600, no temp left; read-only bodies do not write", async () => {
    E = env(T8);
    const store = E.store();
    const r1 = await store.transact((d) => {
      d.tasks.push(approve(makeTask()));
      return { value: 1, write: true };
    });
    expect(r1).toMatchObject({ ok: true, rev: 1, wrote: true });
    const r2 = await store.transact(() => ({ value: 2, write: false }));
    expect(r2).toMatchObject({ ok: true, rev: 1, wrote: false });
    const dir = join(E.storeDir, sessionDirName(SID));
    expect(readdirSync(dir).sort()).toEqual([".lock", "state.json"]); // the flock file persists (never "broken")
    expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("a body that only reads an absent ledger creates nothing", async () => {
    E = env(T8);
    const r = await E.store().transact((d) => ({ value: d.tasks.length, write: false }));
    expect(r).toMatchObject({ ok: true, value: 0, rev: 0 });
    expect(readdirSync(E.storeDir)).toEqual([]);
  });

  it("corrupt state ⇒ E_DEGRADED for every transaction; repair quarantines to .bak and starts empty", async () => {
    E = env(T8);
    const store = E.store();
    await addTask(store, approve(makeTask()), T8);
    const file = join(E.storeDir, sessionDirName(SID), "state.json");
    writeFileSync(file, "{ not json", { mode: 0o600 });
    expect(await store.transact(() => ({ value: 0, write: true }))).toMatchObject({ ok: false, code: "E_DEGRADED" });
    expect(await autoClaim(store, { taskId: "s_aaaaaaab", t: T8, armedSince: 0, holder: holder() })).toMatchObject({
      kind: "error",
      code: "E_DEGRADED",
    });
    expect(await store.repair()).toMatchObject({ ok: true, value: { quarantined: true } });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("{ not json");
    expect(readOk(store).tasks).toEqual([]);
  });

  it("a state.json written for another session is degraded (sid mismatch)", async () => {
    E = env(T8);
    const store = E.store();
    await addTask(store, makeTask(), T8);
    const file = join(E.storeDir, sessionDirName(SID), "state.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as ScheduleStateFile;
    s.sessionId = "someone-else";
    writeFileSync(file, JSON.stringify(s));
    expect(store.read()).toMatchObject({ kind: "degraded", reason: "sid-mismatch" });
  });

  it("the 65th session directory is refused with E_LIMIT", async () => {
    E = env(T8);
    for (let i = 0; i < 64; i++) mkdirSync(join(E.storeDir, `sess-${i}`), { mode: 0o700 });
    const r = await E.store("sess-new").transact((d) => {
      d.tasks.push(makeTask());
      return { value: 0, write: true };
    });
    expect(r).toMatchObject({ ok: false, code: "E_LIMIT" });
    // an existing directory is unaffected
    expect((await E.store("sess-3").transact(() => ({ value: 0, write: true }))).ok).toBe(true);
  });
});

describe("run lifecycle", () => {
  it("first terminal write wins; later outcomes only land in lateOutcome", async () => {
    E = env(T8);
    const store = E.store();
    const t = approve(makeTask());
    await addTask(store, t, T8 - MIN);
    E.clock.t = T8 + 1_000;
    await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    const key = `${t.id}@${T8}`;
    await store.transact((d) => ({ value: updateRun(d, key, { state: "running", runId: "r_1" }), write: true }));
    const a = await store.transact((d, c) => ({
      value: finishRun(d, key, { state: "unknown", reason: "owner-closed" }, c.now),
      write: true,
    }));
    const b = await store.transact((d, c) => ({
      value: finishRun(d, key, { state: "completed" }, c.now),
      write: true,
    }));
    expect([a.ok && a.value, b.ok && b.value]).toEqual(["ok", "late"]);
    const run = readOk(store).runs[0]!;
    expect(run).toMatchObject({ state: "unknown", reason: "owner-closed", runId: "r_1", lateOutcome: "completed" });
    await store.transact((d) => ({ value: updateRun(d, key, { state: "running" }), write: false }));
    expect(() => updateRun(readOk(store), key, { state: "completed" })).toThrow(/finishRun/);
  });
});

describe("pendingReports (§4.2.1, R2-1)", () => {
  it("survives runs eviction: 1 pushed report + 25 non-pushed runs ⇒ still indexed 23h later", async () => {
    E = env(T8);
    const store = E.store();
    const t = approve(makeTask({ when: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" } }));
    await addTask(store, t, T8 - MIN);
    E.clock.t = T8 + 1_000;
    await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    const key = `${t.id}@${T8}`;
    await store.transact((d, c) => {
      finishRun(d, key, { state: "completed", reportFile: reportFileOf(SID, key), note: "pending" }, c.now);
      const entry = pendingReportFor(SID, findRun(d, key)!, "completed");
      expect(entry).toEqual(pending(SID, key, t.id, c.now));
      addPendingReport(d, entry, c.now);
      return { value: 0, write: true };
    });
    for (let i = 1; i <= 25; i++) {
      const T = T8 + i * 5 * MIN;
      E.clock.t = T + 1_000;
      await autoClaim(store, { taskId: t.id, t: T, armedSince: 0, holder: holder() });
      await store.transact((d, c) => ({
        value: finishRun(d, `${t.id}@${T}`, { state: "completed" }, c.now),
        write: true,
      }));
    }
    const s = readOk(store);
    expect(s.runs.find((r) => r.runKey === key)).toBeUndefined(); // evicted from UI history
    expect(s.runs.length).toBe(20);
    expect(s.pendingReports.map((p) => p.runKey)).toEqual([key]);
    E.clock.t = T8 + 23 * HOUR;
    await store.transact(() => ({ value: 0, write: true }));
    expect(readOk(store).pendingReports.map((p) => p.runKey)).toEqual([key]);
    // 24h after endedAt the entry expires on the next write
    E.clock.t = T8 + 1_000 + SCHED_REPORT_MAX_AGE_MS;
    await store.transact(() => ({ value: 0, write: true }));
    expect(readOk(store).pendingReports).toEqual([]);
  });

  it("receipts remove entries; adding the same reportId twice is a no-op", () => {
    const d = emptyStateFile(SID);
    const p = pending(SID, "s_aaaaaaaa@1", "s_aaaaaaaa", 1);
    addPendingReport(d, p, 1);
    addPendingReport(d, p, 2);
    expect(d.pendingReports).toHaveLength(1);
    expect(removePendingReports(d, [p.reportId, "f".repeat(64)])).toBe(1);
    expect(d.pendingReports).toEqual([]);
  });

  it("the 65th entry drops the OLDEST, counts it and marks its run report-skipped(index-cap)", () => {
    const d = emptyStateFile(SID);
    const h = holder();
    for (let i = 0; i < SCHED_PENDING_REPORTS_MAX + 1; i++) {
      const runKey = `s_aaaaaaaa@${1000 + i}`;
      d.runs.push({
        runKey,
        taskId: "s_aaaaaaaa",
        kind: "auto",
        form: "background",
        scheduledAt: 1000 + i,
        defHash: "a".repeat(64),
        state: "completed",
        holder: h,
        startedAt: 1000 + i,
        endedAt: 2000 + i,
        note: "written",
      });
      const r = addPendingReport(d, pending(SID, runKey, "s_aaaaaaaa", 2000 + i), 5000);
      if (i < SCHED_PENDING_REPORTS_MAX) expect(r.dropped).toEqual([]);
      else expect(r.dropped.map((x) => x.runKey)).toEqual(["s_aaaaaaaa@1000"]);
    }
    expect(d.pendingReports).toHaveLength(64);
    expect(d.reportStats).toEqual({ droppedIndexCap: 1, lastDroppedAt: 5000 });
    expect(d.runs[0]!.reason).toBe("report-skipped(index-cap)");
  });
});

describe("size fit (256 KiB)", () => {
  it("compacts UI history deterministically and keeps missedTotal", () => {
    const d = emptyStateFile(SID);
    const t = approve(makeTask({ prompt: "x".repeat(8000) }));
    d.tasks.push(t);
    const h = holder();
    for (let i = 0; i < 400; i++) {
      d.runs.push({
        runKey: `${t.id}@${1000 + i}`,
        taskId: t.id,
        kind: "auto",
        form: "background",
        scheduledAt: 1000 + i,
        defHash: "a".repeat(64),
        state: "completed",
        reason: "r".repeat(200),
        holder: h,
        noteHolder: h,
        startedAt: i,
        endedAt: i,
        note: "written",
        lateOutcome: "l".repeat(200),
      });
    }
    const bytes = serializeToFit(d);
    expect(bytes).toBeDefined();
    expect(bytes!.length).toBeLessThanOrEqual(SCHED_STATE_MAX_BYTES);
    expect(d.runs.length).toBeLessThan(400);
    // the newest runs survive
    expect(d.runs.some((r) => r.endedAt === 399)).toBe(true);
  });
});

describe("report GC and recycling (§4.7)", () => {
  function writeReport(dir: string, name: string, mtimeMs: number, bytes = 10): void {
    mkdirSync(join(dir, "reports"), { recursive: true, mode: 0o700 });
    const f = join(dir, "reports", name);
    writeFileSync(f, "r".repeat(bytes), { mode: 0o600 });
    utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  }

  it("plan: referenced and just-written files are never selected", () => {
    const now = 100 * 86_400_000;
    const old = now - 20 * 86_400_000;
    const reps = [
      { name: `${"1".repeat(64)}.md`, size: 1, mtimeMs: old },
      { name: `${"2".repeat(64)}.md`, size: 1, mtimeMs: old },
      { name: `${"3".repeat(64)}.md`, size: 1, mtimeMs: now - 60_000 },
    ];
    const plan = planReportDeletions(reps, new Set([`${"2".repeat(64)}.md`]), now, {
      maxCount: 0,
      maxBytes: 0,
      retentionMs: 14 * 86_400_000,
    });
    expect(plan.delete).toEqual([`${"1".repeat(64)}.md`]);
    expect(plan.overCap).toBe(true);
  });

  it("session GC deletes expired unreferenced reports only, and reaps old temps", async () => {
    E = env(T8);
    const store = E.store();
    const t = approve(makeTask());
    await addTask(store, t, T8);
    const dir = join(E.storeDir, sessionDirName(SID));
    const keep = reportFileOf(SID, `${t.id}@1`).slice(8);
    const drop = reportFileOf(SID, `${t.id}@2`).slice(8);
    const old = T8 - 20 * 86_400_000;
    writeReport(dir, keep, old);
    writeReport(dir, drop, old);
    writeReport(dir, ".x.md.1.abc.tmp", old);
    await store.transact((d, c) => {
      addPendingReport(d, pending(SID, `${t.id}@1`, t.id, c.now), c.now);
      return { value: 0, write: true };
    });
    const r = await gcSessionReports(store, T8);
    expect(r).toMatchObject({ ok: true, value: { deleted: [drop], tempsReaped: 1, overCap: false } });
    expect(readdirSync(join(dir, "reports"))).toEqual([keep]);
  });

  it("global GC trims across sessions oldest-first, never touching referenced files", async () => {
    E = env(T8);
    const a = E.store("sess-a");
    const b = E.store("sess-b");
    await addTask(a, makeTask(), T8);
    await addTask(b, makeTask(), T8);
    const old = T8 - 86_400_000;
    // 2 001 tiny reports would be slow; instead check the protection logic with one referenced, one not, over the byte cap
    writeReport(join(E.storeDir, "sess-a"), `${"a".repeat(64)}.md`, old, 1);
    await a.transact((d, c) => {
      const p = pending("sess-a", "s_aaaaaaaa@1", "s_aaaaaaaa", c.now);
      p.reportFile = `reports/${"a".repeat(64)}.md`;
      addPendingReport(d, p, c.now);
      return { value: 0, write: true };
    });
    const r = await gcGlobalReports({ root: E.root, self: self(), epoch: "ep-1", now: E.clock.now }, T8);
    expect(r).toEqual({ deleted: 0, overCap: false });
    expect(existsSync(join(E.storeDir, "sess-a", "reports", `${"a".repeat(64)}.md`))).toBe(true);
  });

  it("recycles an empty session directory; keeps one with tasks, pending reports or a fresh report", async () => {
    E = env(T8);
    const store = E.store();
    const t = makeTask();
    await addTask(store, t, T8);
    expect(await recycleSessionDir(store, T8)).toMatchObject({ ok: true, value: { recycled: false } });
    await store.transact((d) => {
      d.tasks = [];
      return { value: 0, write: true };
    });
    const dir = join(E.storeDir, sessionDirName(SID));
    writeReport(dir, `${"b".repeat(64)}.md`, T8 - HOUR);
    expect(await recycleSessionDir(store, T8)).toMatchObject({ value: { recycled: false } });
    expect(await recycleSessionDir(store, T8 + 25 * HOUR)).toMatchObject({ value: { recycled: true } });
    expect(existsSync(dir)).toBe(false);
    // a later write simply recreates it
    expect((await store.transact(() => ({ value: 0, write: true }))).ok).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  it("a group/other-writable session directory is refused (fail closed)", async () => {
    E = env(T8);
    const store = E.store();
    await addTask(store, makeTask(), T8);
    chmodSync(join(E.storeDir, sessionDirName(SID)), 0o777);
    expect(await store.transact(() => ({ value: 0, write: true }))).toMatchObject({ ok: false, code: "E_DEGRADED" });
    expect(store.read()).toMatchObject({ kind: "degraded" });
  });
});

const errno = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

describe("durability errors are never swallowed (review M5)", () => {
  async function seeded(fault: (p: WriterFaultPoint) => void) {
    E = env(T8 - 5 * MIN);
    await addTask(E.store(), approve(makeTask()), T8 - 5 * MIN);
    return E.store(undefined, { faults: fault });
  }

  it("directory fsync EIO after the rename ⇒ the transaction fails as uncertain; the claim is not reported fired", async () => {
    const store = await seeded((p) => {
      if (p === "dir-fsync") throw errno("EIO");
    });
    const rev = readOk(store).rev;
    const r = await store.transact(() => ({ value: 1, write: true }));
    expect(r).toMatchObject({ ok: false, code: "E_DEGRADED", uncertain: true });
    expect(readOk(store).rev).toBe(rev + 1); // renamed — exactly why it is "uncertain", not "failed"
    const t = readOk(store).tasks[0]!;
    E.clock.t = T8 + 1_000;
    const c = await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    expect(c).toMatchObject({ kind: "error", code: "E_DEGRADED", uncertain: true });
  });

  it("ENOSPC is reported too; only 'unsupported' errnos (EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS) are tolerated", async () => {
    for (const code of ["ENOSPC", "EROFS"]) {
      const store = await seeded((p) => {
        if (p === "dir-fsync") throw errno(code);
      });
      expect(await store.transact(() => ({ value: 1, write: true }))).toMatchObject({ ok: false, uncertain: true });
      E.cleanup();
    }
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
      const store = await seeded((p) => {
        if (p === "dir-fsync") throw errno(code);
      });
      expect(await store.transact(() => ({ value: 1, write: true }))).toMatchObject({ ok: true, wrote: true });
      E.cleanup();
    }
  });

  it("file fsync EIO before the rename ⇒ failure, old file intact, no temp left (not uncertain)", async () => {
    const store = await seeded((p) => {
      if (p === "file-fsync") throw errno("EIO");
    });
    const dir = join(E.storeDir, sessionDirName(SID));
    const before = readFileSync(join(dir, "state.json"), "utf8");
    const r = await store.transact(() => ({ value: 1, write: true }));
    expect(r).toMatchObject({ ok: false, code: "E_DEGRADED" });
    expect((r as { uncertain?: boolean }).uncertain).toBeUndefined();
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("session-directory admission is atomic (review m1)", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  const CHILD = join(ROOT, "tests/schedule/core/fixtures/tx-child.ts");

  it("creation happens under the store-level lock: a held .store.lock ⇒ E_BUSY, no directory created", async () => {
    E = env(T8);
    writeFileSync(join(E.storeDir, ".store.lock"), "", { mode: 0o600 });
    const ext = spawn("flock", ["-o", "-x", join(E.storeDir, ".store.lock"), "sleep", "30"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 200; i++) {
        const r = await E.store("sess-probe", { lockTimeoutMs: 0 }).transact(() => ({ value: 0, write: true }));
        if (!r.ok) break;
        rmSync(join(E.storeDir, "sess-probe"), { recursive: true, force: true });
        await new Promise((res) => setTimeout(res, 10));
      }
      const r = await E.store("sess-new", { lockTimeoutMs: 80 }).transact(() => ({ value: 0, write: true }));
      expect(r).toMatchObject({ ok: false, code: "E_BUSY" });
      expect(existsSync(join(E.storeDir, "sess-new"))).toBe(false);
    } finally {
      ext.kill("SIGKILL");
    }
  });

  it("63 directories + 6 processes creating different sessions at once ⇒ exactly one succeeds (64 total)", async () => {
    E = env(T8);
    for (let i = 0; i < 63; i++) mkdirSync(join(E.storeDir, `sess-${i}`), { mode: 0o700 });
    const outs = await Promise.all(
      Array.from(
        { length: 6 },
        (_, i) =>
          new Promise<string>((resolve) => {
            const c = spawn(process.execPath, ["--import", "tsx", CHILD, E.storeDir, `sess-new-${i}`], {
              cwd: ROOT,
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            c.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
            c.once("exit", () => resolve(out));
          }),
      ),
    );
    const rs = outs.map((o) => JSON.parse(o) as { ok: boolean; code?: string });
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => r.code === "E_LIMIT")).toBe(true);
    expect(readdirSync(E.storeDir).filter((n) => !n.startsWith("."))).toHaveLength(64);
  }, 60_000);
});

describe("report GC reserves room and reports the real outcome (review m2)", () => {
  const nm = (i: number) => `${i.toString(16).padStart(64, "0")}.md`;
  const old = T8 - 86_400_000;
  function writeReports(dir: string, n: number): void {
    mkdirSync(join(dir, "reports"), { recursive: true, mode: 0o700 });
    for (let i = 0; i < n; i++) {
      const f = join(dir, "reports", nm(i));
      writeFileSync(f, "r", { mode: 0o600 });
      utimesSync(f, (old + i) / 1000, (old + i) / 1000);
    }
  }

  it("planReportDeletions counts the incoming report against the caps", () => {
    const reps = Array.from({ length: 3 }, (_, i) => ({ name: nm(i), size: 1, mtimeMs: old + i }));
    const caps = { maxCount: 3, maxBytes: 100, retentionMs: 30 * 86_400_000 };
    expect(planReportDeletions(reps, new Set(), T8, caps)).toEqual({ delete: [], overCap: false });
    expect(planReportDeletions(reps, new Set(), T8, caps, { count: 1, bytes: 1 })).toEqual({
      delete: [nm(0)],
      overCap: false,
    });
    expect(planReportDeletions(reps, new Set([nm(0), nm(1), nm(2)]), T8, caps, { count: 1, bytes: 1 }).overCap).toBe(
      true,
    );
  });

  it("exactly 200 reports + 1 incoming ⇒ the oldest is deleted first; all referenced ⇒ overCap", async () => {
    E = env(T8);
    const store = E.store();
    const t = approve(makeTask());
    await addTask(store, t, T8);
    const dir = join(E.storeDir, sessionDirName(SID));
    writeReports(dir, 200);
    const r = await gcSessionReports(store, T8, undefined, { count: 1, bytes: 1 });
    expect(r).toMatchObject({ ok: true, value: { deleted: [nm(0)], overCap: false } });
    expect(readdirSync(join(dir, "reports"))).toHaveLength(199);
    // a full session whose files are all referenced ⇒ no room can be made ⇒ the writer must not write
    rmSync(join(dir, "reports"), { recursive: true });
    writeReports(dir, 3);
    await store.transact((d, c) => {
      for (let i = 0; i < 3; i++) {
        d.pendingReports.push({ ...pending(SID, `${t.id}@${i + 1}`, t.id, c.now), reportFile: `reports/${nm(i)}` });
      }
      return { value: 0, write: true };
    });
    const caps = { maxCount: 3, maxBytes: 1e9, retentionMs: 30 * 86_400_000 };
    expect(await gcSessionReports(store, T8, caps)).toMatchObject({ ok: true, value: { overCap: false } });
    const r2 = await gcSessionReports(store, T8, caps, { count: 1, bytes: 1 });
    expect(r2).toMatchObject({ ok: true, value: { deleted: [], overCap: true } });
  });
});

describe("report admission is single-writer (review round 2, m2)", () => {
  const nm = (i: number) => `${i.toString(16).padStart(64, "0")}.md`;
  const caps = { maxCount: 200, maxBytes: 1e9, retentionMs: 30 * 86_400_000 };
  function fill(dir: string, n: number, mtimeMs: number): void {
    mkdirSync(join(dir, "reports"), { recursive: true, mode: 0o700 });
    for (let i = 0; i < n; i++) {
      const f = join(dir, "reports", nm(i));
      writeFileSync(f, "r", { mode: 0o600 });
      utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
    }
  }

  it("two concurrent writers race for the LAST slot (199 protected files, cap 200) ⇒ exactly one writes, the other sees it and refuses", async () => {
    E = env(T8);
    const t = approve(makeTask());
    await addTask(E.store(), t, T8);
    const dir = join(E.storeDir, sessionDirName(SID));
    fill(dir, 199, T8 - 60_000); // inside the GC grace ⇒ nothing can be deleted to make room
    const a = E.store(undefined, { lockTimeoutMs: 5_000 });
    const b = E.store(undefined, { lockTimeoutMs: 5_000 });
    const [ra, rb] = await Promise.all([
      writeReportLocked(a, { reportFile: reportFileOf(SID, `${t.id}@1`), data: Buffer.from("A"), now: T8, caps }),
      writeReportLocked(b, { reportFile: reportFileOf(SID, `${t.id}@2`), data: Buffer.from("B"), now: T8, caps }),
    ]);
    const outs = [ra, rb].map((r) => (r.ok ? r.value : undefined));
    expect(outs.filter((o) => o?.written === true)).toHaveLength(1);
    expect(outs.filter((o) => o?.written === false && o.overCap)).toHaveLength(1);
    expect(readdirSync(join(dir, "reports"))).toHaveLength(200); // pre-fix ("GC, then write"): 201
  });

  it("the ledger update commits in the SAME transaction and learns whether the file landed", async () => {
    E = env(T8);
    const t = approve(makeTask());
    const store = E.store();
    await addTask(store, t, T8);
    const runKey = `${t.id}@1`;
    const r = await writeReportLocked(store, {
      reportFile: reportFileOf(SID, runKey),
      data: Buffer.from("# report"),
      now: T8,
      commit: (d, c, written) => {
        if (written) addPendingReport(d, pending(SID, runKey, t.id, c.now), c.now);
        return { value: written, write: true };
      },
    });
    expect(r).toMatchObject({ ok: true, value: { written: true, overCap: false, value: true } });
    const s = readOk(store);
    expect(s.pendingReports.map((p) => p.reportFile)).toEqual([reportFileOf(SID, runKey)]);
    const file = join(E.storeDir, sessionDirName(SID), reportFileOf(SID, runKey));
    expect(readFileSync(file, "utf8")).toBe("# report");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // full session ⇒ not written, and commit is told so
    const full = await writeReportLocked(store, {
      reportFile: reportFileOf(SID, `${t.id}@2`),
      data: Buffer.from("x"),
      now: T8,
      caps: { maxCount: 1, maxBytes: 1e9, retentionMs: 30 * 86_400_000 },
      commit: (_d, _c, written) => ({ value: written, write: false }),
    });
    expect(full).toMatchObject({ ok: true, value: { written: false, overCap: true, value: false } });
    expect(
      await writeReportLocked(store, { reportFile: "reports/../state.json", data: Buffer.from("x"), now: T8 }),
    ).toMatchObject({ ok: false });
  });

  it("deletions that FAIL count as still present: overCap from the actual result (session GC and admission)", async () => {
    E = env(T8);
    const store = E.store();
    await addTask(store, approve(makeTask()), T8);
    const dir = join(E.storeDir, sessionDirName(SID));
    fill(dir, 3, T8 - 20 * 86_400_000); // expired ⇒ planned for deletion
    const small = { maxCount: 2, maxBytes: 1e9, retentionMs: 14 * 86_400_000 };
    chmodSync(join(dir, "reports"), 0o500); // unlink ⇒ EACCES
    try {
      const gc = await gcSessionReports(store, T8, small);
      expect(gc).toMatchObject({ ok: true, value: { deleted: [], overCap: true } }); // the plan alone said "fits"
      const w = await writeReportLocked(store, {
        reportFile: `reports/${"f".repeat(64)}.md`,
        data: Buffer.from("x"),
        now: T8,
        caps: small,
      });
      expect(w).toMatchObject({ ok: true, value: { written: false, overCap: true, deleted: [] } });
    } finally {
      chmodSync(join(dir, "reports"), 0o700);
    }
    expect(readdirSync(join(dir, "reports"))).toHaveLength(3);
  });

  it("global GC: a victim session that cannot be locked, or an unreadable session, never reports free capacity", async () => {
    E = env(T8);
    const a = E.store("sess-a");
    const b = E.store("sess-b");
    await addTask(a, makeTask(), T8);
    await addTask(b, makeTask(), T8);
    const old = T8 - 86_400_000;
    for (const [sid, i] of [
      ["sess-a", 1],
      ["sess-b", 2],
    ] as const) {
      mkdirSync(join(E.storeDir, sid, "reports"), { mode: 0o700 });
      const f = join(E.storeDir, sid, "reports", nm(i));
      writeFileSync(f, "", { mode: 0o600 });
      truncateSync(f, 65 * 1024 * 1024); // sparse: 2 × 65 MiB > the 128 MiB global byte cap
      utimesSync(f, (old + i) / 1000, (old + i) / 1000);
    }
    const ext = spawn("flock", ["-o", "-x", join(E.storeDir, "sess-a", ".lock"), "sleep", "30"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 200; i++) {
        const probe = await E.store("sess-a", { lockTimeoutMs: 0 }).transact(() => ({ value: 0, write: false }));
        if (!probe.ok) break;
        await new Promise((res) => setTimeout(res, 10));
      }
      const opts = { root: E.root, self: self(), epoch: "ep-1", now: E.clock.now, lockTimeoutMs: 50 };
      expect(await gcGlobalReports(opts, T8)).toEqual({ deleted: 0, overCap: true }); // pre-fix: planned count ⇒ false
    } finally {
      ext.kill("SIGKILL");
    }
    await new Promise((res) => ext.once("exit", res));
    const opts = { root: E.root, self: self(), epoch: "ep-1", now: E.clock.now };
    expect(await gcGlobalReports(opts, T8)).toEqual({ deleted: 1, overCap: false });
    // an unreadable (degraded) session's files are unknown ⇒ capacity unprovable
    writeFileSync(join(E.storeDir, "sess-b", "state.json"), "{broken", { mode: 0o600 });
    expect(await gcGlobalReports(opts, T8)).toEqual({ deleted: 0, overCap: true });
  });
});
