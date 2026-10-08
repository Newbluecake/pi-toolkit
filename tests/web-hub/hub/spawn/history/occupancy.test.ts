/**
 * web-hub session-history plan §4.5.5 (`occupancy.ts`): `prove`/`reprove` — kind gate + C1/C2/C3
 * best-effort occupancy (§14.1).
 */
import { describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import type { AgentView, Registry } from "../../../../../src/web-hub/hub/ports.js";
import { createOccupancyChecker } from "../../../../../src/web-hub/hub/spawn/history/occupancy.js";
import type {
  HistoryServiceDeps,
  ManagedSessionView,
  SessionPin,
} from "../../../../../src/web-hub/hub/spawn/history/ports.js";
import type { ProcFs, ProcSyncFs } from "../../../../../src/web-hub/hub/spawn/history/proc.js";

const UID = 1000;
const HUB_PID = 999999;
const now = () => 0;

function fakePin(over: Partial<SessionPin> = {}): SessionPin {
  return {
    id: "sess-1",
    cwd: "/w/p",
    kind: "main",
    size: 100,
    abs: "/h/.pi/agent/sessions/d/f.jsonl",
    root: { dev: 1, ino: 1 },
    dir: { dev: 1, ino: 2 },
    file: { dev: 1, ino: 3 },
    release: () => undefined,
    ...over,
  };
}

function fakeCard(over: Partial<AgentView> & { pid: number }): AgentView {
  return {
    agentKey: `k${String(over.pid)}`,
    kind: "rpc",
    cwd: "/w/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    prompts: [],
    agentId: { pid: over.pid, nonce: "n" },
    connectedAt: 0,
    lastFrameAt: 0,
    seq: 0,
    ...over,
  };
}

function fakeRegistry(cards: AgentView[]): Pick<Registry, "list"> {
  return { list: () => cards };
}

function baseDeps(over: Partial<HistoryServiceDeps> = {}): HistoryServiceDeps {
  return {
    agentDir: "/h/.pi/agent",
    forkSrcDir: "/h/.pi/agent/spawn/fork-src",
    registry: fakeRegistry([]),
    managed: () => [],
    deathOf: () => undefined,
    uid: UID,
    hubPid: HUB_PID,
    now,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...over,
  };
}

function emptyProcFs(): ProcFs {
  return {
    readdirProc: async () => [],
    statUid: () => Promise.reject(new Error("unused")),
    readStat: () => Promise.reject(new Error("unused")),
    readCmdline: () => Promise.reject(new Error("unused")),
  };
}
function emptyProcSyncFs(): ProcSyncFs {
  return {
    readdirProcSync: () => [],
    statUidSync: () => {
      throw new Error("unused");
    },
    readStatSync: () => {
      throw new Error("unused");
    },
  };
}

describe("createOccupancyChecker.prove", () => {
  it("kind sub ⇒ forced fork, no scan needed", async () => {
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin({ kind: "sub" }), createReqDeadline(now, 1000));
    expect(result).toEqual({ free: false, reason: "subagent" });
  });

  it("kind unknown ⇒ unverified, gap kind", async () => {
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin({ kind: "unknown" }), createReqDeadline(now, 1000));
    expect(result).toEqual({ free: false, reason: "unverified", gap: "kind" });
  });

  it("C1: a card with session.sessionId matching the pin ⇒ open/card", async () => {
    const card = fakeCard({
      pid: 42,
      session: { sessionId: "sess-1", cwd: "/w/p", reason: "ok", leafId: null, mode: "rpc" },
    });
    const deps = baseDeps({ registry: fakeRegistry([card]) });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "open", live: { by: "card", pid: 42 } });
  });

  it("C1: a card matching by sessionFile === pin.abs also counts", async () => {
    const card = fakeCard({
      pid: 43,
      session: {
        sessionId: "other-id",
        sessionFile: "/h/.pi/agent/sessions/d/f.jsonl",
        cwd: "/w/p",
        reason: "ok",
        leafId: null,
        mode: "rpc",
      },
    });
    const deps = baseDeps({ registry: fakeRegistry([card]) });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "open" });
  });

  it("Finding 7b: C1 also matches a card's LITERAL (un-realpath'd) sessionFile when agentDir/sessions is itself a symlink", async () => {
    const fakeSyncFs = {
      realpathSync: (p: string): string => (p === "/h/.pi/agent/sessions" ? "/real/sessions" : p),
    };
    const pin = fakePin({ abs: "/real/sessions/d/f.jsonl", id: "sess-literal" });
    const card = fakeCard({
      pid: 44,
      session: {
        sessionId: "some-other-id", // deliberately NOT pin.id — only the literal path should match
        sessionFile: "/h/.pi/agent/sessions/d/f.jsonl", // the LITERAL, pre-resolution form
        cwd: "/w/p",
        reason: "ok",
        leafId: null,
        mode: "rpc",
      },
    });
    const deps = baseDeps({ registry: fakeRegistry([card]) });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs(), fakeSyncFs);
    const result = await checker.prove(pin, createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "open" });
  });

  it("C2: a non-terminal managed record targeting the same id ⇒ open/managed", async () => {
    const rec: ManagedSessionView = { spawnId: "sp1", state: "live", sessionId: "sess-1" };
    const deps = baseDeps({ managed: () => [rec] });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "open", live: { by: "managed" } });
  });

  it("C2: a terminal managed record whose death is NOT confirmed still counts as open", async () => {
    const rec: ManagedSessionView = { spawnId: "sp1", state: "exited", sessionId: "sess-1" };
    const deps = baseDeps({ managed: () => [rec], deathOf: () => "unknown" });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result.free).toBe(false);
  });

  it("C2: a terminal managed record whose death IS confirmed does not block", async () => {
    const rec: ManagedSessionView = { spawnId: "sp1", state: "exited", sessionId: "sess-1" };
    const deps = baseDeps({ managed: () => [rec], deathOf: () => "confirmed" });
    const checker = createOccupancyChecker(deps, emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result.free).toBe(true);
  });

  it("no C1/C2 hit, proc scan incomplete ⇒ unverified/proc-partial", async () => {
    const procFs: ProcFs = {
      readdirProc: () => Promise.reject(new Error("unreadable")),
      statUid: () => Promise.reject(new Error("unused")),
      readStat: () => Promise.reject(new Error("unused")),
      readCmdline: () => Promise.reject(new Error("unused")),
    };
    const checker = createOccupancyChecker(baseDeps(), procFs, emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "unverified", gap: "proc-partial" });
  });

  it("an unconnected pi candidate (matches no card, no managed record) ⇒ maybe/unconnected-pi", async () => {
    const procFs: ProcFs = {
      readdirProc: async () => ["77"],
      statUid: async () => UID,
      readStat: async () => `1 (pi) R ${Array(48).fill("0").join(" ")}`,
      readCmdline: async () => "pi\0",
    };
    const checker = createOccupancyChecker(baseDeps(), procFs, emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({
      free: false,
      reason: "maybe",
      gap: "unconnected-pi",
      live: { by: "proc", pid: 77 },
    });
  });

  it("a candidate matching a session-less live card ⇒ card-unproven", async () => {
    const card = fakeCard({ pid: 77 }); // live, but no `session` reported
    const procFs: ProcFs = {
      readdirProc: async () => ["77"],
      statUid: async () => UID,
      readStat: async () => `1 (pi) R ${Array(48).fill("0").join(" ")}`,
      readCmdline: async () => "pi\0",
    };
    const checker = createOccupancyChecker(baseDeps({ registry: fakeRegistry([card]) }), procFs, emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result).toMatchObject({ free: false, reason: "unverified", gap: "card-unproven" });
  });

  it("a candidate matching a non-terminal managed record by pid+procStartTicks does NOT block", async () => {
    const rec: ManagedSessionView = { spawnId: "sp2", state: "starting", pid: 88, procStartTicks: 555 };
    const fields = Array(50).fill("0");
    fields[19] = "555";
    const statLine = `1 (pi) ${fields.join(" ")}`;
    const procFs: ProcFs = {
      readdirProc: async () => ["88"],
      statUid: async () => UID,
      readStat: async () => statLine,
      readCmdline: async () => "pi\0",
    };
    const checker = createOccupancyChecker(baseDeps({ managed: () => [rec] }), procFs, emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result.free).toBe(true);
  });

  it("all checks pass with no candidates ⇒ free:true with the scan token attached", async () => {
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result.free).toBe(true);
    if (result.free) expect(result.scan.complete).toBe(true);
  });

  it("Finding 7 end-to-end: a node* candidate whose cmdline is unreadable is NEVER waved through as free:true (fails closed)", async () => {
    const fields = Array(50).fill("0");
    fields[0] = "R";
    fields[19] = "5";
    const statLine = `1 (node) ${fields.join(" ")}`;
    const procFs: ProcFs = {
      readdirProc: async () => ["50"],
      statUid: async () => UID,
      readStat: async () => statLine,
      readCmdline: () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
    };
    const checker = createOccupancyChecker(baseDeps(), procFs, emptyProcSyncFs());
    const result = await checker.prove(fakePin(), createReqDeadline(now, 1000));
    expect(result.free).toBe(false);
  });
});

describe("createOccupancyChecker.reprove", () => {
  it("throws if the scan token is not complete (defensive — prove already returned 409)", () => {
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), emptyProcSyncFs());
    expect(() => checker.reprove(fakePin(), { at: 0, complete: false, pids: new Map() })).toThrow();
  });

  it("maps rescanSync's new-process gap into an OccupancyProof", () => {
    const token = {
      at: 0,
      complete: true,
      pids: new Map([[1, { startTicks: 1, uid: UID, comm: "pi", cls: "pi" as const }]]),
    };
    const procSyncFs: ProcSyncFs = {
      readdirProcSync: () => ["1"],
      statUidSync: () => UID,
      readStatSync: () => {
        const fields = Array(50).fill("0");
        fields[19] = "999"; // starttime changed
        return `1 (pi) ${fields.join(" ")}`;
      },
    };
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), procSyncFs);
    const result = checker.reprove(fakePin(), token);
    expect(result).toMatchObject({ free: false, reason: "unverified", gap: "new-process" });
  });

  it("free:true re-attaches the SAME scan token", () => {
    const token = { at: 0, complete: true, pids: new Map() };
    const checker = createOccupancyChecker(baseDeps(), emptyProcFs(), emptyProcSyncFs());
    const result = checker.reprove(fakePin(), token);
    expect(result).toEqual({ free: true, scan: token });
  });

  it("C1/C2 still apply synchronously in reprove (no proc read needed)", () => {
    const card = fakeCard({
      pid: 1,
      session: { sessionId: "sess-1", cwd: "/w/p", reason: "ok", leafId: null, mode: "rpc" },
    });
    const token = { at: 0, complete: true, pids: new Map() };
    const checker = createOccupancyChecker(
      baseDeps({ registry: fakeRegistry([card]) }),
      emptyProcFs(),
      emptyProcSyncFs(),
    );
    const result = checker.reprove(fakePin(), token);
    expect(result).toMatchObject({ free: false, reason: "open" });
  });
});
