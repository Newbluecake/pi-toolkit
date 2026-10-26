/** Shared fixtures for the S1 core tests (scheduled-reports plan r3). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureStoreRoot,
  openSessionStore,
  type SessionStore,
  type SessionStoreOpts,
} from "../../../src/schedule/core/writer.js";
import { holderOf, readSelfIdentity, type ProcessIdentity } from "../../../src/schedule/core/recovery.js";
import { initOcc } from "../../../src/schedule/core/occurrence.js";
import {
  defHash,
  reportIdOf,
  type Holder,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";
import type { StoreRoot } from "../../../src/schedule/core/paths.js";

export const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";

export function self(): ProcessIdentity {
  const s = readSelfIdentity();
  if (s === undefined) throw new Error("needs /proc");
  return s;
}

export function holder(epoch = "ep-1"): Holder {
  return holderOf(self(), epoch);
}

export interface Clock {
  t: number;
  now: () => number;
}
export function clock(start: number): Clock {
  const c: Clock = { t: start, now: () => c.t };
  return c;
}

export interface Env {
  dir: string;
  storeDir: string;
  root: StoreRoot;
  clock: Clock;
  store: (sid?: string, extra?: Partial<SessionStoreOpts>) => SessionStore;
  cleanup: () => void;
}

export function env(start: number): Env {
  const dir = mkdtempSync(join(tmpdir(), "sched-s1-"));
  const storeDir = join(dir, "schedules");
  const root = ensureStoreRoot(storeDir);
  const ck = clock(start);
  return {
    dir,
    storeDir,
    root,
    clock: ck,
    store: (sid = SID, extra = {}) =>
      openSessionStore({
        root,
        sessionId: sid,
        self: self(),
        epoch: "ep-1",
        now: ck.now,
        lockTimeoutMs: 200,
        ...extra,
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

let seq = 0;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function taskId(): string {
  seq += 1;
  let n = seq;
  let s = "";
  for (let i = 0; i < 8; i++) {
    s = B32[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return `s_${s}`;
}

export function makeTask(over: Partial<ScheduleTask> = {}): ScheduleTask {
  const t: ScheduleTask = {
    id: taskId(),
    name: "hourly",
    form: "background",
    when: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    prompt: "report",
    feishu: true,
    bg: { type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false },
    enabled: true,
    createdBy: "user",
    createdVia: "tui",
    createdAt: 0,
    ownerCwd: "/home/u/proj",
    ...over,
  };
  if (t.form === "message") delete t.bg;
  return t;
}

export function approve(t: ScheduleTask, at = 0): ScheduleTask {
  t.approval = { hash: defHash(t), by: "user", via: "tui", at };
  return t;
}

/** Insert a task (approved unless told otherwise) with a fresh occ watermark at `now`. */
export async function addTask(store: SessionStore, task: ScheduleTask, now: number): Promise<void> {
  const r = await store.transact((d: ScheduleStateFile) => {
    d.tasks.push(task);
    d.occ[task.id] = initOcc(task, now);
    return { value: undefined, write: true };
  });
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
}

export function readOk(store: SessionStore): ScheduleStateFile {
  const r = store.read();
  if (r.kind !== "ok") throw new Error(`state ${r.kind}`);
  return r.state;
}

export const utc = (s: string): number => Date.parse(s);
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** Pre-#62 paths, retained only as compatibility fixtures (never used by new writers). */
export const legacyReportFileOf = (sid: string, runKey: string): string => `reports/${reportIdOf(sid, runKey)}.md`;
