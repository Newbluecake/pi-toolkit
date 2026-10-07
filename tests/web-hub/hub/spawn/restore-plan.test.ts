/**
 * web-hub-spawn-restore plan v1 §6.4/§6.5 (RS5): the pure decision half — `classifyForRestore`
 * (§6.4's boot table, row by row × restore on/off × veto, plus the three filters) and
 * `planSessionArgv` (D7's every branch).
 */
import { describe, expect, it } from "vitest";
import {
  classifyForRestore,
  hidesIdentityOnWire,
  planSessionArgv,
  restoreWireOf,
  type RestoreClassifyContext,
  type RestoreSessionFs,
} from "../../../../src/web-hub/hub/spawn/restore-plan.js";
import type { StoredRecord } from "../../../../src/web-hub/hub/spawn/store.js";

const NOW = 1_800_000_000_000;
const ctx = (over: Partial<RestoreClassifyContext> = {}): RestoreClassifyContext => ({
  restoreOn: true,
  vetoed: false,
  now: NOW,
  maxLifetimeMs: 720 * 60_000,
  ...over,
});

function rec(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    spawnId: "sp0000000000000001",
    state: "live",
    cwd: "/w/p",
    dev: 1,
    ino: 2,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    owner: { listener: "loopback", reqId: "r" },
    pid: 10,
    procStartTicks: 20,
    bootId: "b",
    uid: 1000,
    sessionId: "sess-1",
    ...over,
  };
}

describe("classifyForRestore — §6.4 table", () => {
  const rows: Array<[string, Partial<StoredRecord>, string]> = [
    ["live + sessionId (crash path)", {}, "candidate"],
    ["live without sessionId (old format)", { sessionId: undefined }, "legacy"],
    ["live with a malformed sessionId", { sessionId: "-bad" }, "legacy"],
    [
      "stopping + restoreIntent (graceful, parked)",
      { state: "stopping", restoreIntent: true, exit: { code: 0, signal: null } },
      "candidate",
    ],
    ["stopping without restoreIntent (user/lifetime/stop)", { state: "stopping" }, "legacy"],
    [
      "starting + restore reaping",
      { state: "starting", restore: { attempts: 1, lastAt: 1, phase: "reaping" } },
      "candidate",
    ],
    [
      "starting + restore registering",
      { state: "starting", restore: { attempts: 1, lastAt: 1, phase: "registering" } },
      "candidate",
    ],
    ["starting fresh (never live, D3)", { state: "starting" }, "legacy"],
    [
      "starting with a failed restore slice (no phase)",
      { state: "starting", restore: { attempts: 1, lastAt: 1, failure: "launcher" } },
      "legacy",
    ],
    ["launching", { state: "launching", pid: undefined }, "legacy"],
    ["removeIntent always wins", { removeIntent: true }, "legacy"],
  ];
  for (const [name, over, kind] of rows) {
    it(`${name} ⇒ ${kind} (restore on); legacy when off or vetoed`, () => {
      expect(classifyForRestore(rec(over), ctx()).kind).toBe(kind);
      expect(classifyForRestore(rec(over), ctx({ restoreOn: false })).kind).toBe("legacy");
      expect(classifyForRestore(rec(over), ctx({ vetoed: true })).kind).toBe("legacy");
    });
  }

  it("starting{forking} ⇒ scan with forkIntentAt (lastAt fallback)", () => {
    expect(
      classifyForRestore(
        rec({
          state: "starting",
          pid: undefined,
          restore: { attempts: 1, lastAt: 5, phase: "forking", forkIntentAt: 7 },
        }),
        ctx(),
      ),
    ).toEqual({ kind: "scan", forkIntentAt: 7 });
    expect(
      classifyForRestore(
        rec({ state: "starting", pid: undefined, restore: { attempts: 1, lastAt: 5, phase: "forking" } }),
        ctx(),
      ),
    ).toEqual({ kind: "scan", forkIntentAt: 5 });
  });

  it("filters: <5min lifetime left ⇒ lifetime; attempts ≥3 ⇒ exhausted; incomplete identity ⇒ prev-unknown", () => {
    expect(classifyForRestore(rec({ createdAt: NOW - 716 * 60_000 }), ctx())).toEqual({
      kind: "skip",
      failure: "lifetime",
    });
    expect(classifyForRestore(rec({ createdAt: NOW - 715 * 60_000 }), ctx()).kind).toBe("candidate"); // exactly 5min
    expect(classifyForRestore(rec({ restore: { attempts: 3, lastAt: 1 } }), ctx())).toEqual({
      kind: "skip",
      failure: "exhausted",
    });
    expect(classifyForRestore(rec({ restore: { attempts: 2, lastAt: 1 } }), ctx()).kind).toBe("candidate");
    expect(classifyForRestore(rec({ uid: undefined }), ctx())).toEqual({ kind: "skip", failure: "prev-unknown" });
  });
});

function fsOf(
  files: Record<string, { head?: string; uid?: number; link?: true; dir?: true; err?: string }>,
): RestoreSessionFs {
  const err = (code: string): Error => Object.assign(new Error(code), { code });
  return {
    lstatSync: (p) => {
      const f = files[p];
      if (f === undefined) throw err("ENOENT");
      if (f.err !== undefined) throw err(f.err);
      return {
        isFile: () => f.link !== true && f.dir !== true,
        isSymbolicLink: () => f.link === true,
        uid: f.uid ?? 1000,
      };
    },
    readHeadSync: (p) => {
      const f = files[p];
      if (f?.head === undefined) throw err("EIO");
      return f.head;
    },
  };
}

const F = "/h/.pi/agent/sessions/--w-p--/x.jsonl";
const header = (o: Record<string, unknown>): string =>
  `${JSON.stringify({ type: "session", id: "sess-1", cwd: "/w/p", ...o })}\n{}\n`;

describe("planSessionArgv — D7 branches", () => {
  const input = (over: Record<string, unknown> = {}) => ({ sessionId: "sess-1", sessionFile: F, cwd: "/w/p", ...over });
  it("present + valid header ⇒ --session <abs file>", () => {
    expect(planSessionArgv(input(), fsOf({ [F]: { head: header({}) } }), 1000)).toEqual({
      ok: true,
      tail: ["--session", F],
    });
  });
  it("absent + never persisted ⇒ --session-id; absent + persisted ⇒ session-missing", () => {
    expect(planSessionArgv(input(), fsOf({}), 1000)).toEqual({ ok: true, tail: ["--session-id", "sess-1"] });
    expect(planSessionArgv(input({ sessionPersisted: true }), fsOf({}), 1000)).toMatchObject({
      ok: false,
      failure: "session-missing",
    });
  });
  it("sessionFile unknown ⇒ --session-id", () => {
    expect(planSessionArgv(input({ sessionFile: undefined }), fsOf({}), 1000)).toEqual({
      ok: true,
      tail: ["--session-id", "sess-1"],
    });
  });
  const invalid: Array<[string, Parameters<typeof fsOf>[0]]> = [
    ["symlink", { [F]: { link: true, head: header({}) } }],
    ["not a regular file", { [F]: { dir: true } }],
    ["owner mismatch", { [F]: { uid: 0, head: header({}) } }],
    ["header unreadable", { [F]: {} }],
    ["header not JSON", { [F]: { head: "garbage\n" } }],
    ["header type mismatch", { [F]: { head: header({ type: "other" }) } }],
    ["header id mismatch", { [F]: { head: header({ id: "sess-2" }) } }],
    ["header cwd mismatch", { [F]: { head: header({ cwd: "/elsewhere" }) } }],
    ["lstat EACCES", { [F]: { err: "EACCES" } }],
  ];
  for (const [name, files] of invalid) {
    it(`${name} ⇒ session-invalid (with an owner-only detail)`, () => {
      const r = planSessionArgv(input(), fsOf(files), 1000);
      expect(r).toMatchObject({ ok: false, failure: "session-invalid" });
      expect(!r.ok && r.detail.length).toBeGreaterThan(0);
    });
  }
  it("a malformed sessionId never reaches argv", () => {
    expect(planSessionArgv(input({ sessionId: "--evil" }), fsOf({}), 1000)).toMatchObject({
      ok: false,
      failure: "session-invalid",
    });
  });
});

describe("restoreWireOf / hidesIdentityOnWire (§9.1/§9.2)", () => {
  it("explicit copy, attempts → attempt; forkIntentAt/lastAt never on the wire", () => {
    expect(restoreWireOf(undefined)).toBeUndefined();
    expect(
      restoreWireOf({
        attempts: 2,
        lastAt: 9,
        phase: "registering",
        forkIntentAt: 8,
        prevAgentKey: "k",
        failure: "persist",
        restoredAt: 10,
      }),
    ).toEqual({ attempt: 2, phase: "registering", prevAgentKey: "k", failure: "persist", restoredAt: 10 });
    expect(hidesIdentityOnWire({ attempts: 0, lastAt: 1, phase: "reaping" })).toBe(true);
    expect(hidesIdentityOnWire({ attempts: 1, lastAt: 1, phase: "registering" })).toBe(false);
    expect(hidesIdentityOnWire(undefined)).toBe(false);
  });
});
