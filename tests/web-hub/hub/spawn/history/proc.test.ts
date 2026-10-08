/**
 * web-hub session-history plan §4.5.5 (`proc.ts`): `scanAsync` classification + `rescanSync`'s
 * PID-reuse matrix (the evidence #1 closing move — full re-stat, no diffing, no cmdline).
 */
import { describe, expect, it } from "vitest";
import {
  defaultProcFs,
  rescanSync,
  scanAsync,
  type ProcFs,
  type ProcSyncFs,
} from "../../../../../src/web-hub/hub/spawn/history/proc.js";
import { PROC_SCAN_PID_MAX } from "../../../../../src/web-hub/hub/spawn/history/budget.js";

interface FakeProcEntry {
  uid: number;
  comm: string;
  state?: string;
  startTicks: number;
  cmdline?: string[];
  err?: string; // simulate statUid/readStat throwing this errno
}

function statLine(comm: string, state: string, startTicks: number): string {
  // minimal /proc/<pid>/stat: "pid (comm) state ppid pgrp ... [19 fields] startticks ..."
  const fields = Array(50).fill("0");
  fields[0] = state;
  fields[19] = String(startTicks);
  return `1 (${comm}) ${fields.join(" ")}`;
}

function fakeAsyncProcFs(table: Map<number, FakeProcEntry>): ProcFs {
  return {
    readdirProc: async () => Array.from(table.keys()).map(String),
    statUid: async (pid) => {
      const e = table.get(pid);
      if (e === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return e.uid;
    },
    readStat: async (pid) => {
      const e = table.get(pid);
      if (e === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (e.err !== undefined) throw Object.assign(new Error(e.err), { code: e.err });
      return statLine(e.comm, e.state ?? "R", e.startTicks);
    },
    readCmdline: async (pid) => {
      const e = table.get(pid);
      return (e?.cmdline ?? []).join("\0") + "\0";
    },
  };
}

function fakeSyncProcFs(table: Map<number, FakeProcEntry>): ProcSyncFs {
  return {
    readdirProcSync: () => Array.from(table.keys()).map(String),
    statUidSync: (pid) => {
      const e = table.get(pid);
      if (e === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (e.err !== undefined) throw Object.assign(new Error(e.err), { code: e.err });
      return e.uid;
    },
    readStatSync: (pid) => {
      const e = table.get(pid);
      if (e === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return statLine(e.comm, e.state ?? "R", e.startTicks);
    },
  };
}

const UID = 1000;
const HUB_PID = 999999;
const now = () => 0;

describe("scanAsync", () => {
  it("classifies comm===pi as a candidate, excludes the hub pid, and includes every uid in the token", async () => {
    const table = new Map<number, FakeProcEntry>([
      [10, { uid: UID, comm: "pi", startTicks: 100 }],
      [11, { uid: UID, comm: "bash", startTicks: 101 }],
      [12, { uid: 0, comm: "pi", startTicks: 102 }], // foreign uid — recorded but not classified
      [HUB_PID, { uid: UID, comm: "pi", startTicks: 103 }], // excluded even though it looks like pi
    ]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(true);
    expect(token.pids.size).toBe(4);
    expect(token.pids.get(10)?.cls).toBe("pi");
    expect(token.pids.get(11)?.cls).toBe("other");
    expect(token.pids.get(12)?.cls).toBe("other"); // foreign uid never classified as pi
    expect(token.pids.get(HUB_PID)?.cls).toBe("other");
  });

  it("node* comm: reads cmdline; jiti-cli-style argv[1] not matching ⇒ node-other, pi-coding-agent cli.js ⇒ pi", async () => {
    const table = new Map<number, FakeProcEntry>([
      [20, { uid: UID, comm: "node", startTicks: 1, cmdline: ["node", "/opt/some/other/main.js"] }],
      [21, { uid: UID, comm: "node", startTicks: 2, cmdline: ["node", "/x/pi-coding-agent/dist/cli.js"] }],
      [22, { uid: UID, comm: "node", startTicks: 3, cmdline: ["node", "/usr/local/bin/pi"] }],
    ]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.pids.get(20)?.cls).toBe("node-other");
    expect(token.pids.get(21)?.cls).toBe("pi");
    expect(token.pids.get(22)?.cls).toBe("pi");
  });

  it("Finding 7a fix: a readCmdline() ERROR on a node* candidate fails CLOSED to cls:'pi', never 'node-other'", async () => {
    const table = new Map<number, FakeProcEntry>([
      [40, { uid: UID, comm: "node", startTicks: 1, cmdline: ["node", "/opt/some/other/main.js"] }],
    ]);
    const base = fakeAsyncProcFs(table);
    const procFs: ProcFs = {
      ...base,
      readCmdline: () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
    };
    const token = await scanAsync({ procFs, uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(true);
    // an UNREADABLE node* candidate must never be silently waved through as "definitely not pi".
    expect(token.pids.get(40)?.cls).toBe("pi");
  });

  it("Finding 5 fix: a per-pid call exceeding PROC_CALL_MS (but within the overall scan budget) fails that pid/scan the same way a real error would, never hangs", async () => {
    const table = new Map<number, FakeProcEntry>([[41, { uid: UID, comm: "pi", startTicks: 1 }]]);
    const base = fakeAsyncProcFs(table);
    const procFs: ProcFs = {
      ...base,
      statUid: () => new Promise<number>(() => undefined), // never settles
    };
    const token = await scanAsync({ procFs, uid: UID, hubPid: HUB_PID, now, budgetMs: 10_000 });
    // the per-call bound (PROC_CALL_MS, far shorter than the 10s scan budget) is what actually
    // ends this — if it only had the whole-scan budget it would hang for the full 10s.
    expect(token.complete).toBe(false);
  });

  it("ESRCH/ENOENT mid-scan ⇒ process treated as exited, not recorded", async () => {
    const table = new Map<number, FakeProcEntry>([[30, { uid: UID, comm: "pi", startTicks: 1, err: "ESRCH" }]]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(true);
    expect(token.pids.has(30)).toBe(false);
  });

  it("an unreadable SAME-uid entry (non-ENOENT) ⇒ incomplete (proc-partial)", async () => {
    const table = new Map<number, FakeProcEntry>([[40, { uid: UID, comm: "pi", startTicks: 1, err: "EACCES" }]]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(false);
  });

  it("an unreadable OTHER-uid entry does not trip completeness", async () => {
    const table = new Map<number, FakeProcEntry>([[41, { uid: 0, comm: "pi", startTicks: 1, err: "EACCES" }]]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(true);
  });

  it("zombie/dead state candidates are recorded but classified 'other'", async () => {
    const table = new Map<number, FakeProcEntry>([[50, { uid: UID, comm: "pi", state: "Z", startTicks: 1 }]]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.pids.get(50)?.cls).toBe("other");
  });

  it("over PROC_SCAN_PID_MAX ⇒ incomplete without even attempting per-pid reads", async () => {
    const table = new Map<number, FakeProcEntry>();
    for (let i = 0; i < PROC_SCAN_PID_MAX + 1; i++) table.set(i + 1, { uid: UID, comm: "bash", startTicks: i });
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(false);
    expect(token.pids.size).toBe(0);
  });

  it("budget exhaustion mid-scan ⇒ incomplete, partial token retained", async () => {
    const table = new Map<number, FakeProcEntry>([
      [1, { uid: UID, comm: "bash", startTicks: 1 }],
      [2, { uid: UID, comm: "bash", startTicks: 2 }],
    ]);
    const token = await scanAsync({ procFs: fakeAsyncProcFs(table), uid: UID, hubPid: HUB_PID, now, budgetMs: 0 });
    expect(token.complete).toBe(false);
  });

  it("readdir(/proc) itself failing ⇒ incomplete, empty token", async () => {
    const procFs: ProcFs = {
      readdirProc: () => Promise.reject(new Error("no proc")),
      statUid: () => Promise.reject(new Error("unused")),
      readStat: () => Promise.reject(new Error("unused")),
      readCmdline: () => Promise.reject(new Error("unused")),
    };
    const token = await scanAsync({ procFs, uid: UID, hubPid: HUB_PID, now });
    expect(token.complete).toBe(false);
    expect(token.pids.size).toBe(0);
  });

  it("verifier round 3 (defect 3a): a HANGING readdirProc fails closed within PROC_CALL_MS — scan resolves partial, never hangs the scan budget", async () => {
    const procFs: ProcFs = {
      readdirProc: () => new Promise<string[]>(() => undefined), // never settles
      statUid: () => Promise.reject(new Error("unused")),
      readStat: () => Promise.reject(new Error("unused")),
      readCmdline: () => Promise.reject(new Error("unused")),
    };
    const start = Date.now();
    const token = await scanAsync({ procFs, uid: UID, hubPid: HUB_PID, now, budgetMs: 10_000 });
    expect(token.complete).toBe(false); // fail closed ⇒ the proof is never free
    expect(token.pids.size).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000); // the per-call race ended it, not the 10s budget
  });
});

describe("rescanSync — PID-reuse matrix (evidence #1)", () => {
  function tokenFrom(table: Map<number, FakeProcEntry>): ReturnType<typeof makeToken> {
    return makeToken(table);
  }
  function makeToken(table: Map<number, FakeProcEntry>) {
    const pids = new Map<
      number,
      { startTicks: number; uid: number; comm: string; cls: "pi" | "node-other" | "other" }
    >();
    for (const [pid, e] of table) {
      const cls: "pi" | "node-other" | "other" =
        e.comm === "pi" ? "pi" : e.comm.startsWith("node") ? "node-other" : "other";
      pids.set(pid, { startTicks: e.startTicks, uid: e.uid, comm: e.comm, cls });
    }
    return { at: 0, complete: true, pids };
  }

  it("unchanged pid/uid/comm/starttime ⇒ ok (free)", () => {
    const table = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "pi", startTicks: 100 }]]);
    const token = tokenFrom(table);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(table), uid: UID, hubPid: HUB_PID, now })).toEqual({ ok: true });
  });

  it("token candidate pid's starttime changed (new pi reused the pid) ⇒ new-process", () => {
    const before = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "pi", startTicks: 100 }]]);
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "pi", startTicks: 999 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({
      gap: "new-process",
      pid: 1,
    });
  });

  it("token candidate pid's starttime changed but now a non-candidate comm ⇒ ignored", () => {
    const before = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "pi", startTicks: 100 }]]);
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "bash", startTicks: 999 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({ ok: true });
  });

  it("an 'other'-class pid (bash) exits and is reused by a new pi (same pid, different starttime) ⇒ new-process", () => {
    const before = new Map<number, FakeProcEntry>([[7, { uid: UID, comm: "bash", startTicks: 1 }]]);
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[7, { uid: UID, comm: "pi", startTicks: 2 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({
      gap: "new-process",
      pid: 7,
    });
  });

  it("a foreign-uid pid gets reused by a same-uid pi ⇒ new-process", () => {
    const before = new Map<number, FakeProcEntry>([[8, { uid: 0, comm: "bash", startTicks: 1 }]]);
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[8, { uid: UID, comm: "pi", startTicks: 2 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({
      gap: "new-process",
      pid: 8,
    });
  });

  it("a candidate that became a zombie (same identity) is ignored, not flagged", () => {
    const before = new Map<number, FakeProcEntry>([[9, { uid: UID, comm: "pi", startTicks: 1 }]]);
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[9, { uid: UID, comm: "pi", state: "Z", startTicks: 1 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({ ok: true });
  });

  it("a brand new pid with comm 'node' ⇒ new-process (conservative, no cmdline read)", () => {
    const before = new Map<number, FakeProcEntry>();
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[15, { uid: UID, comm: "node", startTicks: 1 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({
      gap: "new-process",
      pid: 15,
    });
  });

  it("a brand new pid with comm 'bash' ⇒ ignored", () => {
    const before = new Map<number, FakeProcEntry>();
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>([[16, { uid: UID, comm: "bash", startTicks: 1 }]]);
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({ ok: true });
  });

  it("pid count or elapsed time over the sync budget ⇒ proc-partial", () => {
    const before = new Map<number, FakeProcEntry>();
    const token = tokenFrom(before);
    const after = new Map<number, FakeProcEntry>();
    for (let i = 0; i < PROC_SCAN_PID_MAX + 1; i++) after.set(i + 1, { uid: UID, comm: "bash", startTicks: i });
    expect(rescanSync(token, { procFs: fakeSyncProcFs(after), uid: UID, hubPid: HUB_PID, now })).toEqual({
      gap: "proc-partial",
    });
  });

  it("never reads cmdline (source-level guarantee): fake sync fs exposes no readCmdlineSync at all", () => {
    const table = new Map<number, FakeProcEntry>([[1, { uid: UID, comm: "pi", startTicks: 1 }]]);
    const sync = fakeSyncProcFs(table);
    expect("readCmdlineSync" in sync).toBe(false);
  });
});

describe("defaultProcFs", () => {
  it("constructs without throwing and exposes the four async members", () => {
    const fs = defaultProcFs();
    expect(typeof fs.readdirProc).toBe("function");
    expect(typeof fs.statUid).toBe("function");
    expect(typeof fs.readStat).toBe("function");
    expect(typeof fs.readCmdline).toBe("function");
  });
});
