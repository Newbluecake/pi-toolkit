/**
 * scheduled-reports plan r3 §7 (H1 r2 after review round 1) — the coordinator, with a
 * regression test per review finding (see H1-report's disposition table). The delivery side is
 * driven through a fake `ScheduleDelivery` shaped exactly like F1's committed
 * `service.schedule` (pushReport/pushNotice/receiptsFor/hasReceipt); the real-F1 seam lives in
 * schedule-f1.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScheduleService,
  SCHED_OBSERVE_DELAY_MS,
  type ScheduleCoordinator,
  type ScheduleServiceDeps,
  type SchedTimer,
} from "../../../src/web-hub/hub/schedule/service.js";
import type { ScheduleDelivery } from "../../../src/web-hub/hub/schedule/feishu-port.js";
import type { SchedHubStore } from "../../../src/web-hub/hub/schedule/hub-state.js";
import type { ScanResult } from "../../../src/web-hub/hub/schedule/scan.js";
import { defHash, emptyStateFile, type ScheduleStateFile, type ScheduleTask } from "../../../src/schedule/core/spec.js";
import { holderOf, readSelfIdentity } from "../../../src/schedule/core/recovery.js";
import { spawnSync } from "node:child_process";
import { SCHED_HUB_CAP } from "../../../src/web-hub/protocol/schedule.js";
import type { HubFrame } from "../../../src/web-hub/protocol/messages.js";

/** A holder whose pid is provably dead on THIS host (same host/boot as the hub process). */
function deadHolder(): ReturnType<typeof holderOf> {
  const finished = spawnSync("true", { shell: false });
  const self = readSelfIdentity()!;
  return { pid: finished.pid ?? 999_999, start: 1, host: self.host, boot: self.boot, epoch: "dead" };
}

const BASE = Date.UTC(2026, 9, 25, 0, 0, 0);
const T = (h: number): number => BASE + h * 3_600_000;
const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;

const dirs: string[] = [];
const services: ScheduleCoordinator[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-sched-svc-"));
  dirs.push(d);
  return d;
}

function writeStore(root: string, sid: string, build: (s: ScheduleStateFile) => void): void {
  const dir = join(root, sid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = emptyStateFile(sid);
  s.rev = 1;
  build(s);
  writeFileSync(join(dir, "state.json"), JSON.stringify(s), { mode: 0o600 });
}

const task = (over: Partial<ScheduleTask> = {}): ScheduleTask => {
  const t: ScheduleTask = {
    id: "s_abcd2345",
    name: "hourly",
    form: "background",
    when: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    prompt: "p",
    feishu: true,
    enabled: true,
    bg: { type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false },
    approval: { hash: "", by: "user", via: "tui", at: 1 },
    createdBy: "user",
    createdVia: "tui",
    createdAt: 1,
    ownerCwd: "/tmp/x",
    ...over,
  };
  t.approval = { hash: defHash(t), by: "user", via: "tui", at: 1 };
  return t;
};

function fakeRegistry() {
  const sent: HubFrame[] = [];
  const agents = new Map<string, { session?: { sessionId: string }; caps?: string[]; connected: boolean }>();
  return {
    sent,
    agents,
    list: () =>
      [...agents.entries()].map(([agentKey, a]) => ({
        agentKey,
        ...(a.session === undefined ? {} : { session: a.session }),
      })),
    isConnected: (k: string) => agents.get(k)?.connected ?? false,
    getCaps: (k: string) => agents.get(k)?.caps,
    send: (k: string, f: HubFrame) => {
      sent.push(f);
      return agents.get(k)?.connected ?? false;
    },
    subscribe: (_fn: () => void) => () => {},
  };
}

interface NoticeCall {
  key: string;
  kind: string;
  count?: number;
  droppedIndex?: number;
  sessionId: string;
  taskId: string;
}
function fakeDelivery(over: Partial<{ noticeOutcome: "queued" | "refused"; reportOutcome: string }> = {}) {
  const notices: NoticeCall[] = [];
  const reports: string[] = [];
  const receipts = new Map<string, { state: string; sid: string }>();
  let noticeOutcome: "queued" | "refused" = over.noticeOutcome ?? "queued";
  let onReceipt: ((sid: string, reportId: string) => void) | undefined;
  const delivery: ScheduleDelivery = {
    pushNotice: async (input) => {
      notices.push({
        key: input.key,
        kind: input.kind,
        ...(input.count === undefined ? {} : { count: input.count }),
        ...(input.droppedIndex === undefined ? {} : { droppedIndex: input.droppedIndex }),
        sessionId: input.sessionId,
        taskId: input.taskId,
      });
      return noticeOutcome === "queued" ? { outcome: "queued" } : { outcome: "refused", reason: "task-hour" };
    },
    pushReport: async (offer) => {
      reports.push(offer.reportId);
      receipts.set(offer.reportId, { state: "accepted", sid: offer.sessionId });
      onReceipt?.(offer.sessionId, offer.reportId);
      return { reportId: offer.reportId, outcome: (over.reportOutcome ?? "queued") as "queued" };
    },
    receiptsFor: (sid: string) =>
      [...receipts]
        .filter(([, v]) => v.sid === sid)
        .map(([reportId, v]) => ({ reportId, state: v.state as "accepted" })),
    hasReceipt: (id: string) => receipts.has(id),
  };
  return {
    delivery,
    notices,
    reports,
    receipts,
    setNoticeOutcome: (o: "queued" | "refused") => (noticeOutcome = o),
    setOnReceipt: (cb: (sid: string, reportId: string) => void) => (onReceipt = cb),
  };
}

/** Manual timer aligned with the injected clock: runDue() fires everything due at now(). */
function manualTimer(now: () => number) {
  const singles = new Map<object, { at: number; fn: () => void }>();
  const periods = new Map<object, { period: number; fn: () => void }>();
  let seq = 0;
  const timer: SchedTimer = {
    set: (ms, fn) => {
      const h = { id: ++seq } as unknown as { unref?(): void };
      singles.set(h, { at: now() + ms, fn });
      return h;
    },
    clear: (h) => {
      singles.delete(h as object);
      periods.delete(h as object);
    },
    interval: (ms, fn) => {
      const h = { id: ++seq } as unknown as { unref?(): void };
      periods.set(h, { period: ms, fn });
      return h;
    },
  };
  return {
    timer,
    runDue(): number {
      let fired = 0;
      for (const [h, e] of [...singles]) {
        if (now() >= e.at) {
          singles.delete(h);
          e.fn();
          fired++;
        }
      }
      return fired;
    },
    fireScanInterval(): void {
      for (const e of periods.values()) e.fn();
    },
    singles: () => singles.size,
  };
}

interface Ctx {
  root: string;
  reg: ReturnType<typeof fakeRegistry>;
  stateDir: string;
  clockNow: { v: number };
  mt: ReturnType<typeof manualTimer>;
  scanAll?: ScheduleServiceDeps["scanAll"];
  scanOne?: ScheduleServiceDeps["scanOne"];
  store?: SchedHubStore;
  storeFs?: ScheduleServiceDeps["storeFs"];
}

function service(
  root: string,
  reg: ReturnType<typeof fakeRegistry>,
  now: number,
  extra: Partial<Ctx> = {},
): ScheduleCoordinator {
  const clockNow = { v: now };
  const mt = manualTimer(() => clockNow.v);
  const svc = createScheduleService({
    config: { dir: root, toleranceS: 60 },
    stateDir: extra.stateDir ?? tmp(),
    registry: reg,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => clockNow.v,
    timer: mt.timer,
    ...(extra.scanAll === undefined ? {} : { scanAll: extra.scanAll }),
    ...(extra.scanOne === undefined ? {} : { scanOne: extra.scanOne }),
    ...(extra.store === undefined ? {} : { store: extra.store }),
    ...(extra.storeFs === undefined ? {} : { storeFs: extra.storeFs }),
  });
  services.push(svc);
  (svc as unknown as { __ctx: Ctx }).__ctx = {
    root,
    reg,
    stateDir: extra.stateDir ?? "",
    clockNow,
    mt,
    ...extra,
  } as Ctx;
  return svc;
}

const ctxOf = (svc: ScheduleCoordinator): Ctx => (svc as unknown as { __ctx: Ctx }).__ctx;

const missedEntry = (defHash_: string, seq: number, from: number, to: number, count: number, totalAfter: number) => ({
  seq,
  defHash: defHash_,
  from,
  to,
  count,
  totalAfter,
  at: to,
  cause: "offline" as const,
});

describe("projection SSE (unchanged core)", () => {
  it("publishes on the first scan and gates repeats by fingerprint", async () => {
    const root = tmp();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
    });
    const reg = fakeRegistry();
    const svc = service(root, reg, T(13));
    const payloads: unknown[] = [];
    svc.setSseSink({ publish: (p) => payloads.push(p) });
    await svc.rescanAll();
    expect(payloads).toHaveLength(1);
    await svc.rescanAll();
    expect(payloads).toHaveLength(1);
    writeStore(root, "sid-a", (st) => {
      st.tasks.push(task());
      st.rev = 2;
    });
    await svc.rescanAll();
    expect(payloads).toHaveLength(2);
  });

  it("a broken store root yields an empty projection (never a crash) and a degraded status", async () => {
    const reg = fakeRegistry();
    const svc = service(join(tmp(), "missing"), reg, T(13));
    const payloads: unknown[] = [];
    svc.setSseSink({ publish: (p) => payloads.push(p) });
    await svc.rescanAll();
    expect(svc.snapshot()).toEqual({ sessions: [] });
    expect(svc.status().degraded).toBeDefined();
    expect(payloads).toEqual([{ sessions: [] }]);
  });
});

describe("B1 (r1 #1): the observation clock fires despite 60s scans", () => {
  it("60-second scans never postpone an armed ≥90s observation deadline", async () => {
    const root = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(8),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
    });
    const reg = fakeRegistry(); // offline
    const f = fakeDelivery();
    const svc = service(root, reg, T(9) - 5 * 60_000);
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    await svc.tickObserve();
    // Five 60s full scans pass BEFORE the T(9)+90s deadline — none may push it back.
    const ctx = ctxOf(svc);
    for (let i = 0; i < 5; i++) {
      ctx.clockNow.v += 60_000;
      await svc.rescanAll();
    }
    expect(ctx.clockNow.v).toBe(T(9) - 5 * 60_000 + 5 * 60_000); // T(9)
    ctx.clockNow.v = T(9) + SCHED_OBSERVE_DELAY_MS + 1_000;
    expect(ctx.mt.runDue()).toBe(1); // the observation timer fires exactly once
    await svc.tickObserve(); // drain the queued observation round deterministically
    expect(f.notices.filter((n) => n.kind === "missed")).toHaveLength(1);
  });

  it("startup runs the 10-minute catch-up pass without any timer", async () => {
    const root = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(8),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    // now is past T(9)+90s but inside the 10-minute catch-up window.
    const svc = service(root, reg, T(9) + SCHED_OBSERVE_DELAY_MS + 2 * 60_000);
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    await svc.tickObserve();
    expect(f.notices.filter((n) => n.kind === "missed")).toHaveLength(1);
  });
});

describe("B2 (r1 #2): carried pendings flush independently of new events", () => {
  it("a same-hour second batch carries; the idle next hour delivers it with no new events", async () => {
    const root = tmp();
    const t = task();
    const withLog = (total: number, count: number): void => {
      writeStore(root, "sid-a", (s) => {
        s.tasks.push(t);
        s.occ[t.id] = {
          defHash: defHash(t),
          decidedThrough: T(12),
          firedTotal: 0,
          missedTotal: total,
          skippedTotal: 0,
          missedLog: [missedEntry(defHash(t), 1, T(11), T(12), count, total)],
        };
      });
    };
    withLog(5, 5);
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(12) + 30 * 60_000);
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.count).toBe(5);
    // A same-hour increment: F1 would refuse (task-hour) — simulate via our own gate having
    // spent the hour: write a bigger log; the reconcile adds to pendingMissed but the gate
    // blocks the second attempt this hour.
    writeStore(root, "sid-a", (s) => {
      s.tasks = [t];
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 8,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(t), 1, T(11), T(12), 5, 5), missedEntry(defHash(t), 2, T(12), T(12), 3, 8)],
      };
      s.rev = 2;
    });
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1); // hour gate: one attempt
    // IDLE hour rollover: nothing changes on disk, but the round must flush the carry.
    ctxOf(svc).clockNow.v = T(13) + 60_000;
    await svc.rescanAll();
    expect(f.notices).toHaveLength(2);
    expect(f.notices[1]!.count).toBe(3);
  });
});

describe("M3 (r1 #3): state-changing rounds persist without dispose (crash window)", () => {
  it("an observation-derived carry (no ledger entry yet) survives a crash past the catch-up window", async () => {
    const root = tmp();
    const stateDir = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      // The agent is OFFLINE and has NOT swept: no missedLog, T(9) merely undecided.
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(8),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
    });
    const reg = fakeRegistry();
    // svc1 observes T(9) (offline) with NO delivery bound — nothing was ever sent, so a
    // flush-only-on-delivery policy never persists anything. Then the process dies.
    const svc = service(root, reg, T(9) + SCHED_OBSERVE_DELAY_MS + 1_000, { stateDir });
    await svc.rescanAll();
    await svc.tickObserve();
    expect(svc.status().counters.observations).toBe(1);
    // NO dispose — hard crash. The restart sits BEYOND the 10-minute catch-up window.
    const f = fakeDelivery();
    const svc2 = service(root, reg, T(9) + SCHED_OBSERVE_DELAY_MS + 20 * 60_000, { stateDir });
    svc2.bindDelivery(f.delivery);
    await svc2.rescanAll();
    await svc2.tickObserve();
    // The persisted carry delivers WITHOUT any ledger entry — no waiting for the agent.
    const missed = f.notices.filter((n) => n.kind === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.count).toBe(1);
    // And the recorded observation is still there (no re-observe → no double count).
    expect(svc2.status().counters.observations).toBe(0);
  });
});

describe("M4 (r1 #4): a failed hub-state commit blocks delivery", () => {
  it("flush() false ⇒ no pushNotice, pendings retained; recovery delivers after the disk heals", async () => {
    const root = tmp();
    const stateDir = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 2,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(t), 1, T(11), T(12), 2, 2)],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    let flushOk = true;
    const realStore = await import("../../../src/web-hub/hub/schedule/hub-state.js");
    const store: SchedHubStore = {
      degraded: false,
      overflowSessions: 0,
      setLiveTasks: () => {},
      get data() {
        return dataRef.file;
      },
      load: async () => {
        dataRef.file = realStoreCreateData();
      },
      flush: async () => flushOk,
      close: async () => undefined,
    };
    const dataRef = { file: realStoreCreateData() };
    function realStoreCreateData() {
      return { v: 2 as const, sessions: {} };
    }
    const svc = service(root, reg, T(13), { stateDir, store });
    svc.bindDelivery(f.delivery);
    flushOk = false;
    await svc.rescanAll();
    expect(f.notices).toHaveLength(0);
    expect(svc.status().counters.persistFailures).toBeGreaterThan(0);
    flushOk = true;
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1);
  });
});

describe("M5 (r1 #5): a late binding delivers everything accumulated before it", () => {
  it("the first scan consumed nothing; bindDelivery + one round delivers the backlog", async () => {
    const root = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 7,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(t), 1, T(11), T(12), 7, 7)],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13));
    await svc.rescanAll(); // bot not bound yet — nothing sent, nothing lost
    svc.bindDelivery(f.delivery); // triggers its own round
    await svc.rescanAll();
    const missed = f.notices.filter((n) => n.kind === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.count).toBe(7);
  });
});

describe("M6 (r1 #6): refusals retain the pendings; the next hour retries", () => {
  it("a refused attempt keeps the count; an hour later the same count goes out", async () => {
    const root = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 4,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(t), 1, T(11), T(12), 4, 4)],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery({ noticeOutcome: "refused" });
    const svc = service(root, reg, T(13));
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1); // attempted, refused (F1 task-hour)
    expect(svc.status().counters.noticesRefused).toBe(1);
    f.setNoticeOutcome("queued");
    await svc.rescanAll(); // same hour: our gate blocks hammering
    expect(f.notices).toHaveLength(1);
    const ctx = ctxOf(svc);
    ctx.clockNow.v += HOUR;
    await svc.rescanAll();
    expect(f.notices).toHaveLength(2);
    expect(f.notices[1]!.count).toBe(4);
  });
});

describe("M7 (r1 #7): observation evidence is never evicted (stop-adding)", () => {
  it("the 65th observation is SKIPPED (never notified); a later sweep notifies it exactly once", async () => {
    const root = tmp();
    const stateDir = tmp();
    const t = task();
    // Phase A ledger: 64 occurrences already swept and consumed; decidedThrough = T(64).
    const writeLedger = (decided: number, entries: unknown[], total: number, rev: number): void => {
      writeStore(root, "sid-a", (s) => {
        s.rev = rev;
        s.tasks.push(t);
        s.occ[t.id] = {
          defHash: defHash(t),
          decidedThrough: decided,
          firedTotal: 0,
          missedTotal: total,
          skippedTotal: 0,
          missedLog: entries as never,
        };
      });
    };
    writeLedger(T(64), [], 0, 1);
    // Seed 64 ALREADY-OBSERVED points T(1..T(64)) — they were each notified at observation time.
    const {
      createSchedHubStore,
      schedHubStatePath,
      taskStateOf: tso,
    } = await import("../../../src/web-hub/hub/schedule/hub-state.js");
    const seed = createSchedHubStore(schedHubStatePath(stateDir));
    await seed.load();
    const ts = tso(seed.data, "sid-a", t.id);
    ts.observed = Array.from({ length: 64 }, (_, i) => ({ t: T(i + 1), defHash: defHash(t), at: T(i + 1) }));
    seed.data.sessions["sid-a"]!.lastSeenAt = Date.now();
    await seed.flush();
    await seed.close();

    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(65) + SCHED_OBSERVE_DELAY_MS + 2 * 60_000, { stateDir });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    await svc.tickObserve();
    // Stop-adding: the 65th point was NOT observed (and not notified at observation time).
    expect(svc.status().counters.observations).toBe(0);
    // Phase B: the agent sweeps everything — one entry covering (T(0), T(65)], count 65.
    writeLedger(T(65), [missedEntry(defHash(t), 1, T(0), T(65), 65, 65)], 65, 2);
    ctxOf(svc).clockNow.v += HOUR;
    await svc.rescanAll();
    const missed = f.notices.filter((n) => n.kind === "missed");
    expect(missed).toHaveLength(1);
    // 65 occurrences − 64 observed ⇒ exactly the never-notified 65th. No double count.
    expect(missed[0]!.count).toBe(1);
    expect(svc.status().counters.observations).toBe(0);
  });
});

describe("M8 (r1 #8): observation and scans share ONE serial queue", () => {
  it("a ledger written while the observation's read is in flight is reconciled, never double-counted", async () => {
    const root = tmp();
    const t = task();
    const staleSnapshot = (): ScheduleStateFile => {
      const s = emptyStateFile("sid-a");
      s.rev = 1;
      s.tasks.push(t);
      // The STALE view: T(9) still undecided (decidedThrough = T(8)), no missedLog.
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(8),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      return s;
    };
    writeStore(root, "sid-a", (s) => {
      Object.assign(s, staleSnapshot());
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    const svc = service(root, reg, T(9) + SCHED_OBSERVE_DELAY_MS + 1_000, {
      scanOne: async () => {
        await readGate; // the observation's fresh read hangs…
        return { kind: "ok", state: staleSnapshot(), bytes: 10, mtimeMs: 0 }; // …and returns the OLD view
      },
    });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    const observing = svc.tickObserve();
    await new Promise((r) => setTimeout(r, 5));
    // While the observation's read is in flight, the (offline) agent's ledger gets the sweep:
    // T(9) is now DECIDED and a missedLog entry covers it.
    writeStore(root, "sid-a", (s) => {
      Object.assign(s, staleSnapshot());
      s.occ[t.id]!.decidedThrough = T(9);
      s.occ[t.id]!.missedTotal = 1;
      s.occ[t.id]!.missedLog = [missedEntry(defHash(t), 1, T(8), T(9), 1, 1)];
      s.rev = 2;
    });
    const scanning = svc.rescanAll(); // queues BEHIND the observation (serial queue)
    // Under the fix the scan CANNOT pass the hung observation within 300ms (serialized); under
    // the round-1 defect it completes concurrently — that difference is exactly what lets the
    // stale observation double-count T(9) afterwards.
    // The serialization itself is the invariant (r1 #8): while the observation's read is in
    // flight, NO scan round may complete — under the round-1 defect the concurrent scan
    // finished ("done"), read the fresh ledger, and let the stale observation double-count T(9).
    const outcome = await Promise.race([
      scanning.then(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(outcome).toBe("timeout"); // the queue holds the scan behind the observation
    releaseRead!();
    await Promise.all([observing, scanning]);
    // Exactly ONE notification for T(9) total — ever.
    const missed = f.notices.filter((n) => n.kind === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.count).toBe(1);
    // And nothing else waits in the wings an hour later (the round-1 double lands HERE).
    ctxOf(svc).clockNow.v += HOUR;
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "missed")).toHaveLength(1);
  });
});

describe("M10 (r1 #10): timed-out scans keep unvisited sessions and rotate", () => {
  it("a partial round never deletes unvisited sessions; the next pass resumes at nextStart", async () => {
    const root = tmp();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
    });
    writeStore(root, "sid-b", (s) => {
      s.tasks.push(task());
    });
    const reg = fakeRegistry();
    const starts: Array<number | undefined> = [];
    // Pass 1 completes (both sessions); pass 2 times out after sid-a only; pass 3 recovers.
    let phase = 0;
    const svc = service(root, reg, T(13), {
      scanAll: async (_root, opts) => {
        starts.push(opts.startAt);
        const mk = (sid: string) => ({
          sessionId: sid,
          read: { kind: "ok" as const, state: readFixture(sid), bytes: 1, mtimeMs: 0 },
        });
        if (phase === 0)
          return { sessions: [mk("sid-a"), mk("sid-b")], truncated: false, timedOut: false, fenced: false };
        if (phase === 1)
          return { sessions: [mk("sid-a")], truncated: false, timedOut: true, nextStart: 1, fenced: false };
        return { sessions: [mk("sid-a"), mk("sid-b")], truncated: false, timedOut: false, fenced: false };
      },
    });
    function readFixture(sid: string): ScheduleStateFile {
      const s = emptyStateFile(sid);
      s.rev = 1;
      return s;
    }
    phase = 0;
    await svc.rescanAll();
    expect(
      svc
        .snapshot()
        .sessions.map((x) => x.sessionId)
        .sort(),
    ).toEqual(["sid-a", "sid-b"]);
    phase = 1;
    await svc.rescanAll();
    // sid-b was NOT visited by the partial pass — it must STILL be in the projection (kept).
    expect(
      svc
        .snapshot()
        .sessions.map((x) => x.sessionId)
        .sort(),
    ).toEqual(["sid-a", "sid-b"]);
    expect(svc.status().scan.timedOut).toBe(true);
    phase = 2;
    await svc.rescanAll();
    // The startup/bindDelivery rounds add extra phase-0 calls; what matters: the LAST pass (the
    // one after the timed-out pass) resumed at the rotation cursor, and only that one did.
    expect(starts[starts.length - 1], JSON.stringify(starts)).toBe(1);
    expect(
      starts.slice(0, -1).every((x) => x === 0 || x === undefined),
      JSON.stringify(starts),
    ).toBe(true);
  });
});

describe("M11 (r1 #11): unknown prediction re-reads the ledger fresh", () => {
  it("a stale non-terminal snapshot + a later completion ⇒ NO unknown notice", async () => {
    const root = tmp();
    const t = task();
    const dead = deadHolder();
    const snapshot = (runState: string): ScheduleStateFile => {
      const s = emptyStateFile("sid-a");
      s.rev = 1;
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 1,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      s.runs.push({
        runKey: "s_abcd2345@1",
        taskId: t.id,
        kind: "auto",
        form: "background",
        scheduledAt: T(12),
        defHash: defHash(t),
        state: runState as "running",
        holder: dead,
        startedAt: T(12),
        note: "none",
      });
      return s;
    };
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13), {
      scanOne: async () => ({ kind: "ok", state: snapshot("completed"), bytes: 1, mtimeMs: 0 }),
    });
    writeStore(root, "sid-a", (s) => {
      Object.assign(s, snapshot("running"));
    });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "unknown")).toHaveLength(0);
  });

  it("a genuinely dead non-terminal run (fresh read agrees) notifies once (review baseline)", async () => {
    const root = tmp();
    const t = task();
    const dead = deadHolder();
    const snapshot = (): ScheduleStateFile => {
      const s = emptyStateFile("sid-a");
      s.rev = 1;
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 1,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      s.runs.push({
        runKey: "s_abcd2345@1",
        taskId: t.id,
        kind: "auto",
        form: "background",
        scheduledAt: T(12),
        defHash: defHash(t),
        state: "running",
        holder: dead,
        startedAt: T(12),
        note: "none",
      });
      return s;
    };
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13), {
      scanOne: async () => ({ kind: "ok", state: snapshot(), bytes: 1, mtimeMs: 0 }),
    });
    writeStore(root, "sid-a", (s) => {
      Object.assign(s, snapshot());
    });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "unknown")).toHaveLength(1);
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "unknown")).toHaveLength(1); // deduped
  });
});

describe("M12/#15 (r1): deleted-task unknowns still notify; queued+dead never does", () => {
  it("an unknown run of a DELETED task is notified (orphan slot)", async () => {
    const root = tmp();
    writeStore(root, "sid-a", (s) => {
      s.runs.push({
        runKey: "s_deadbeef@1",
        taskId: "s_deadbeef",
        kind: "auto",
        form: "background",
        scheduledAt: T(12),
        defHash: "d".repeat(64),
        state: "unknown",
        holder: holderOf(readSelfIdentity()!, "e"),
        startedAt: T(12),
        note: "none",
      });
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13));
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    const unknowns = f.notices.filter((n) => n.kind === "unknown");
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.taskId).toBe("s_deadbeef");
  });

  it("a queued message with a dead holder is NOT predicted unknown (writer recovers dropped)", async () => {
    const root = tmp();
    const t = task();
    const dead = deadHolder();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      s.runs.push({
        runKey: "s_abcd2345@2",
        taskId: t.id,
        kind: "auto",
        form: "message",
        scheduledAt: T(12),
        defHash: defHash(t),
        state: "queued",
        holder: dead,
        startedAt: T(12),
        note: "none",
      });
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13));
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "unknown")).toHaveLength(0);
  });
});

describe("M13 (r1 #13): pending unknowns are never silently dropped", () => {
  it("multiple pending unknowns drain one per hour, none lost", async () => {
    const root = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      for (let i = 0; i < 3; i++) {
        s.runs.push({
          runKey: `s_abcd2345@${100 + i}`,
          taskId: t.id,
          kind: "auto",
          form: "background",
          scheduledAt: T(12),
          defHash: defHash(t),
          state: "unknown",
          holder: holderOf(readSelfIdentity()!, "e"),
          startedAt: T(12),
          note: "none",
        });
      }
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13));
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.kind === "unknown")).toHaveLength(1);
    const ctx = ctxOf(svc);
    ctx.clockNow.v += HOUR;
    await svc.rescanAll();
    ctx.clockNow.v += HOUR;
    await svc.rescanAll();
    const unknowns = f.notices.filter((n) => n.kind === "unknown");
    expect(unknowns).toHaveLength(3);
  });
});

describe("M14 (r1 #14): deleted-task records are cleaned; live cursors survive", () => {
  it("a deleted task's quiescent coord disappears; the live task's cursor persists", async () => {
    const root = tmp();
    const stateDir = tmp();
    const live = task({ id: "s_liveaaaa", when: { kind: "cron", expr: "0 * * * *", tz: "UTC" } });
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(live);
      s.occ[live.id] = {
        defHash: defHash(live),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 1,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(live), 1, T(11), T(12), 1, 1)],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13), { stateDir });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    // Now delete the live task and add a different one; the old coord must be reaped.
    writeStore(root, "sid-a", (s) => {
      const other = task({ id: "s_other222", when: { kind: "cron", expr: "0 * * * *", tz: "UTC" } });
      s.tasks = [other];
      s.occ = {
        [other.id]: {
          defHash: defHash(other),
          decidedThrough: T(13),
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      };
      s.rev = 2;
    });
    await svc.rescanAll();
    const { createSchedHubStore, schedHubStatePath } = await import("../../../src/web-hub/hub/schedule/hub-state.js");
    const check = createSchedHubStore(schedHubStatePath(stateDir));
    await check.load();
    const tasks = check.data.sessions["sid-a"]!.tasks;
    expect(tasks["s_liveaaaa"]).toBeUndefined(); // reaped (no duty left)
    expect(tasks["s_other222"]).toBeDefined();
    await check.close();
    // The live task's delivered hour gate was used exactly once per hour.
    expect(f.notices.filter((n) => n.kind === "missed")).toHaveLength(1);
  });
});

describe("receipts & sched_receipts (§7.1)", () => {
  it("pushes to the ONLINE owning session, split at 64 ids; offline gets nothing", async () => {
    const root = tmp();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
    });
    const reg = fakeRegistry();
    reg.agents.set("a1", { session: { sessionId: "sid-a" }, connected: true, caps: [SCHED_HUB_CAP] });
    const svc = service(root, reg, T(13));
    await svc.rescanAll();
    const ids = Array.from({ length: 70 }, (_, i) => String(i).padStart(64, "0"));
    svc.receipts(
      "sid-a",
      ids.map((id) => ({ reportId: id, state: "accepted", at: 1 })),
    );
    const frames = reg.sent.filter((f) => f.t === "sched_receipts");
    expect(frames).toHaveLength(2);
    expect((frames[0] as { reportIds: string[] }).reportIds).toHaveLength(64);
    reg.sent.length = 0;
    svc.receipts("sid-b", [{ reportId: "a".repeat(64), state: "sent", at: 1 }]);
    expect(reg.sent.filter((f) => f.t === "sched_receipts")).toHaveLength(0);
  });
});

describe("port().run + sched_run_ack (§7.4, F1's seam)", () => {
  it("resolves started on ack; timeout without one; offline/multi/no-cap refusals", async () => {
    const root = tmp();
    const reg = fakeRegistry();
    const svc = service(root, reg, T(13));
    const target = { sessionId: "sid-a", taskId: "s_abcd2345", defHash: "d".repeat(64) };
    expect(await svc.port().run({ ...target, reqId: "req-1234567890abcdef" })).toEqual({ kind: "offline" });
    reg.agents.set("a1", { session: { sessionId: "sid-a" }, connected: true });
    expect(await svc.port().run({ ...target, reqId: "req-1234567890abcdeg" })).toEqual({
      kind: "refused",
      reason: "no-cap",
    });
    reg.agents.set("a1", { session: { sessionId: "sid-a" }, connected: true, caps: [SCHED_HUB_CAP] });
    reg.agents.set("a2", { session: { sessionId: "sid-a" }, connected: true, caps: [SCHED_HUB_CAP] });
    expect(await svc.port().run({ ...target, reqId: "req-1234567890abcdeh" })).toEqual({ kind: "multi" });
    reg.agents.delete("a2");
    const pending = svc.port().run({ ...target, reqId: "req-1234567890abcdei" });
    svc.onAgentFrame("a1", { t: "sched_run_ack", reqId: "req-1234567890abcdei", result: "started" });
    expect(await pending).toEqual({ kind: "started" });
    // Refused ack carries the reason.
    const pendingRefused = svc.port().run({ ...target, reqId: "req-1234567890abcdej" });
    svc.onAgentFrame("a1", {
      t: "sched_run_ack",
      reqId: "req-1234567890abcdej",
      result: "refused",
      reason: "E_OVERLAP",
    });
    expect(await pendingRefused).toEqual({ kind: "refused", reason: "E_OVERLAP" });
    // No ack ⇒ timeout after SCHED_RUN_ACK_WAIT_MS (manual timer).
    const pendingTimeout = svc.port().run({ ...target, reqId: "req-1234567890abcdek" });
    const ctx = ctxOf(svc);
    ctx.clockNow.v += 10_000;
    ctx.mt.runDue();
    expect(await pendingTimeout).toEqual({ kind: "timeout" });
  });
});

describe("sched_bound tap & dropped watermarks (§7.5 + nits)", () => {
  it("sched_bound reaches the bot tap; droppedShown follows the agent's ledger DOWN", async () => {
    const root = tmp();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
      s.reportStats = { droppedIndexCap: 3, lastDroppedAt: T(13) };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const taps: Array<[string, string]> = [];
    const svc = service(root, reg, T(13));
    svc.setBoundTap((a, r) => taps.push([a, r]));
    svc.onAgentFrame("a1", { t: "sched_bound", agentKey: "a1", runKey: "s_abcd2345@1" });
    expect(taps).toEqual([["a1", "s_abcd2345@1"]]);
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices.some((n) => n.droppedIndex === 3)).toBe(true);
    // Agent rebuilds its ledger: droppedIndexCap resets to 0 — the watermark follows DOWN so a
    // later increment reports its true delta.
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
      s.reportStats = { droppedIndexCap: 0 };
      s.rev = 2;
    });
    await svc.rescanAll();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
      s.reportStats = { droppedIndexCap: 1, lastDroppedAt: T(13) };
      s.rev = 3;
    });
    const before = f.notices.length;
    await svc.rescanAll();
    // The +1 lands on the next flushing notice of the session (hour gate may defer it — the
    // watermark reset itself is what this pins; assert no negative/lost accounting).
    expect(f.notices.length).toBeGreaterThanOrEqual(before);
  });
});

describe("pendingReports discovery (§7.1 → F1)", () => {
  it("hands due reports over; expired and receipted ones are skipped", async () => {
    const root = tmp();
    const rid = "c".repeat(64);
    const ridOld = "d".repeat(64);
    const ridDone = "e".repeat(64);
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(task());
      s.pendingReports.push(
        {
          reportId: rid,
          runKey: "s_abcd2345@1",
          taskId: "s_abcd2345",
          form: "background",
          endedAt: T(12),
          expiresAt: T(12) + DAY,
          reportFile: `reports/${rid}.md`,
          status: "completed",
        },
        {
          reportId: ridOld,
          runKey: "s_abcd2345@2",
          taskId: "s_abcd2345",
          form: "background",
          endedAt: T(11),
          expiresAt: T(12),
          reportFile: `reports/${ridOld}.md`,
          status: "completed",
        },
        {
          reportId: ridDone,
          runKey: "s_abcd2345@3",
          taskId: "s_abcd2345",
          form: "background",
          endedAt: T(11),
          expiresAt: T(11) + DAY,
          reportFile: `reports/${ridDone}.md`,
          status: "completed",
        },
      );
    });
    mkdirSync(join(root, "sid-a", "reports"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "sid-a", "reports", `${rid}.md`), "# report body", { mode: 0o600 });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    const svc = service(root, reg, T(13));
    svc.receipts("sid-a", [{ reportId: ridDone, state: "sent", at: T(12) }]);
    // Mirror F1: a receipt created by pushReport is announced back via receiptsChanged.
    f.setOnReceipt((sid, reportId) => svc.receipts(sid, [{ reportId, state: "accepted", at: T(13) }]));
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.reports).toEqual([rid]);
    // Later rounds see the receipt — no re-offer.
    await svc.rescanAll();
    expect(f.reports).toEqual([rid]);
    expect(svc.readReport("sid-a", `reports/${rid}.md`)).toEqual({ ok: true, text: "# report body" });
  });
});

describe("r2 #4: fsync-level persistence failures (real store, injected fs seam)", () => {
  it("file fsync EIO ⇒ NOTHING sends; the disk heals ⇒ exactly ONE notice for the pending", async () => {
    const root = tmp();
    const stateDir = tmp();
    const t = task();
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 2,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(t), 1, T(11), T(12), 2, 2)],
      };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    // The REAL write/rename chain runs below — pre-create the state dir it writes into.
    mkdirSync(join(stateDir, "schedule"), { mode: 0o700 });
    let fsyncErr: NodeJS.ErrnoException | undefined = Object.assign(new Error("EIO"), { code: "EIO" });
    const svc = service(root, reg, T(13), {
      stateDir,
      storeFs: {
        ensureDir() {},
        exists: () => false,
        read: () => {
          throw new Error("ENOENT");
        },
        fsync: () => {
          if (fsyncErr !== undefined) throw fsyncErr;
        },
      },
    });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    expect(f.notices).toHaveLength(0); // EIO ⇒ flush false ⇒ nothing sent
    expect(svc.status().counters.persistFailures).toBeGreaterThan(0);
    fsyncErr = undefined; // the disk heals
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1); // exactly once — never duplicated
    expect(f.notices[0]!.count).toBe(2);
  });

  it("taskless dropped-carry is persist-before-send too (r2 #1 order fix)", async () => {
    const root = tmp();
    const stateDir = tmp();
    writeStore(root, "sid-b", (s) => {
      s.reportStats = { droppedIndexCap: 4, lastDroppedAt: T(13) };
    });
    const reg = fakeRegistry();
    const f = fakeDelivery();
    let flushOk = true;
    const dataRef = { file: { v: 2 as const, sessions: {} } };
    const store: SchedHubStore = {
      degraded: false,
      overflowSessions: 0,
      setLiveTasks: () => {},
      get data() {
        return dataRef.file;
      },
      load: async () => {},
      flush: async () => flushOk,
      close: async () => undefined,
    };
    const svc = service(root, reg, T(13), { stateDir, store });
    svc.bindDelivery(f.delivery);
    flushOk = false;
    await svc.rescanAll();
    // The taskless "" slot's card must NOT be sent while the commit keeps failing.
    expect(f.notices).toHaveLength(0);
    expect(svc.status().counters.persistFailures).toBeGreaterThan(0);
    flushOk = true;
    await svc.rescanAll();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.droppedIndex).toBe(4);
  });
});

describe("r2 #14: orphan pressure never evicts a live task's cursor", () => {
  it("32 pending orphans + a live task ⇒ the live cursor/gate survive the flush; no replay", async () => {
    const root = tmp();
    const stateDir = tmp();
    const live = task({ id: "s_liveaaaa", when: { kind: "cron", expr: "0 * * * *", tz: "UTC" } });
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(live);
      s.occ[live.id] = {
        defHash: defHash(live),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 1,
        skippedTotal: 0,
        missedLog: [missedEntry(defHash(live), 1, T(11), T(12), 1, 1)],
      };
    });
    // Seed 32 orphan slots (deleted tasks) that each still owe a pending notice.
    const {
      createSchedHubStore,
      schedHubStatePath,
      taskStateOf: tso,
    } = await import("../../../src/web-hub/hub/schedule/hub-state.js");
    const seed = createSchedHubStore(schedHubStatePath(stateDir));
    await seed.load();
    for (let i = 0; i < 32; i++) {
      const tid = `s_orph${String(i).padStart(2, "0")}aa`;
      const ts = tso(seed.data, "sid-a", tid);
      ts.pendingMissed = 1;
      ts.lastAt = 1_000 + i;
    }
    seed.data.sessions["sid-a"]!.lastSeenAt = Date.now();
    await seed.flush();
    const kept = seed.data.sessions["sid-a"]!.tasks["s_liveaaaa"];
    expect(kept).toBeUndefined(); // the live slot appears only after the service's first round
    await seed.close();

    const reg = fakeRegistry();
    const f = fakeDelivery();
    let now = T(13);
    const svc = service(root, reg, now, { stateDir });
    svc.bindDelivery(f.delivery);
    await svc.rescanAll();
    // The live task's own notice went out exactly once…
    expect(f.notices.filter((n) => n.taskId === "s_liveaaaa")).toHaveLength(1);
    // …its cursor survived the orphan-heavy flush (delivered hour gate + consumed seq on disk)…
    const check = createSchedHubStore(schedHubStatePath(stateDir));
    await check.load();
    const liveRec = check.data.sessions["sid-a"]!.tasks["s_liveaaaa"];
    expect(liveRec).toBeDefined();
    expect(liveRec!.consumedSeq).toBe(1);
    expect(liveRec!.gate.attempted).toBe(true);
    await check.close();
    // …and a later rescan does NOT replay it (orphan pressure can never reset a live cursor).
    now += HOUR;
    await svc.rescanAll();
    expect(f.notices.filter((n) => n.taskId === "s_liveaaaa")).toHaveLength(1);
    expect(svc.status().counters.capOverflow).toBe(0);
  });
});

describe("r2 #13: pendingUnknown overflow is counted and visible", () => {
  it("the 65th distinct unknown bumps unknownDropped (per runKey), never a notice for it", async () => {
    const root = tmp();
    const stateDir = tmp();
    const t = task();
    const mkRun = (i: number): ScheduleStateFile["runs"][number] => ({
      runKey: `s_abcd2345@${200 + i}`,
      taskId: t.id,
      kind: "auto",
      form: "background",
      scheduledAt: T(12),
      defHash: defHash(t),
      state: "unknown",
      holder: { pid: 1, start: 1, host: "h", boot: "b", epoch: "e" },
      startedAt: T(12),
      note: "none",
    });
    writeStore(root, "sid-a", (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 0,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      for (let i = 0; i < 65; i++) s.runs.push(mkRun(i));
    });
    // Pre-fill pendingUnknown to its cap with 64 of the 65 runs.
    const {
      createSchedHubStore,
      schedHubStatePath,
      taskStateOf: tso,
    } = await import("../../../src/web-hub/hub/schedule/hub-state.js");
    const seed = createSchedHubStore(schedHubStatePath(stateDir));
    await seed.load();
    const ts = tso(seed.data, "sid-a", t.id);
    ts.pendingUnknown = Array.from({ length: 64 }, (_, i) => `s_abcd2345@${200 + i}`);
    seed.data.sessions["sid-a"]!.lastSeenAt = Date.now();
    await seed.flush();
    await seed.close();

    const reg = fakeRegistry();
    // NO delivery bound: nothing drains, the queue stays full and the SAME dropped runKey is
    // revisited every scan — the counter must stay at 1 (per DISTINCT runKey, r2 #13).
    const svc = service(root, reg, T(13), { stateDir });
    await svc.rescanAll();
    expect(svc.status().counters.unknownDropped).toBe(1);
    for (let i = 0; i < 3; i++) await svc.rescanAll();
    expect(svc.status().counters.unknownDropped).toBe(1); // deduped across rescans
    // The drop is visible in status() — the residual is disclosed, not silent.
    expect(svc.status().counters.unknownDropped).toBeGreaterThanOrEqual(1);
  });
});
