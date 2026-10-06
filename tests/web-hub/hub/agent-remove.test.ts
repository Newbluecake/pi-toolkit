/**
 * web-hub-delete-session plan v2 §2.4/§7.1: `hub/agent-remove.ts`'s decision table, unit-level
 * (no real HTTP/TCP — a minimal fake `AgentRemoveIo` drives `createAgentRemoveService` directly,
 * same style as the supervisor/registry unit suites). HTTP-layer concerns (CSRF wiring, real
 * SSE broadcast, LAN auth) live in `tests/web-hub/http/{api-agent-remove,lan-agent-remove}.test.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createAgentRemoveService, type AgentRemoveIo } from "../../../src/web-hub/hub/agent-remove.js";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import type {
  InternalRecord,
  SpawnSupervisor,
  RemoveResult,
  Death,
} from "../../../src/web-hub/hub/spawn/supervisor.js";
import { memLog } from "./helpers.js";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class TestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

interface FakeIo {
  io: AgentRemoveIo;
  sent: Array<{ status: number; body: unknown }>;
  errors: Array<{ status: number; code: string; message?: string }>;
}

function fakeIo(opts: {
  listener?: "loopback" | "lan";
  ip?: string;
  csrfOk?: boolean;
  auth?: { ip: string; user?: string } | { handled: true; code: string };
  body?: unknown;
  readJsonThrow?: { status: number };
}): FakeIo {
  const sent: FakeIo["sent"] = [];
  const errors: FakeIo["errors"] = [];
  const io: AgentRemoveIo = {
    listener: opts.listener ?? "loopback",
    ip: opts.ip ?? "127.0.0.1",
    strictCsrfOk: () => opts.csrfOk ?? true,
    authorize: async () => opts.auth ?? { ip: opts.ip ?? "127.0.0.1" },
    readJson: async () => {
      if (opts.readJsonThrow !== undefined) throw new TestHttpError(opts.readJsonThrow.status, "E_BAD");
      return opts.body ?? {};
    },
    sendJson: (_res, status, body) => {
      sent.push({ status, body });
    },
    sendError: (_res, status, code, message) => {
      errors.push({ status, code, message });
    },
    HttpError: TestHttpError,
  };
  return { io, sent, errors };
}

function fakeRegistryRemove(
  resultFn: (agentKey: string, opts: { allowConnected: boolean }) => "removed" | "absent" | "online",
) {
  const calls: Array<{ agentKey: string; allowConnected: boolean }> = [];
  return {
    calls,
    port: {
      remove: (agentKey: string, opts: { allowConnected: boolean }) => {
        calls.push({ agentKey, allowConnected: opts.allowConnected });
        return resultFn(agentKey, opts);
      },
    },
  };
}

function baseRecord(over: Partial<InternalRecord> & Pick<InternalRecord, "spawnId">): InternalRecord {
  return {
    state: "starting",
    cwd: "/home/u/proj",
    dev: 1,
    ino: 2,
    createdAt: 1,
    updatedAt: 1,
    owner: { listener: "loopback", reqId: "r1" },
    linked: false,
    control: undefined,
    sessionId: undefined,
    hintDetail: undefined,
    uiCancelled: [],
    stderrTail: () => undefined,
    removePending: false,
    ...over,
  };
}

function fakeSup(opts: {
  records: InternalRecord[];
  removeFn?: (spawnId: string) => RemoveResult;
  deathFn?: (spawnId: string) => Death | undefined;
}): { sup: SpawnSupervisor; removeCalls: string[] } {
  const removeCalls: string[] = [];
  const records = opts.records;
  const sup = {
    async init() {},
    policy: () => {
      throw new Error("not used");
    },
    start: () => {
      throw new Error("not used");
    },
    stop: () => ({ ok: false as const, code: "E_NOT_FOUND" as const }),
    records: () => records,
    isManaged: (agentKey: string) => records.some((r) => r.agentKey === agentKey),
    noteVersion: () => {},
    liveCount: () => 0,
    busyCount: () => 0,
    noteSpawnChanged: () => {},
    lookupByAgentKey: (agentKey: string) => {
      const rec = records.find((r) => r.agentKey === agentKey);
      return rec === undefined ? undefined : { spawnId: rec.spawnId };
    },
    remove: (spawnId: string, deadline: ReturnType<typeof createReqDeadline>): RemoveResult => {
      removeCalls.push(spawnId);
      if (opts.removeFn !== undefined) return opts.removeFn(spawnId);
      const rec = records.find((r) => r.spawnId === spawnId);
      if (rec === undefined) return { ok: false, code: "E_NOT_FOUND" };
      const terminal = rec.state === "exited" || rec.state === "failed";
      if (!terminal) {
        if (deadline.remaining() < 500) return { ok: false, code: "E_DEADLINE" };
        return { ok: true, outcome: "pending", state: "stopping" };
      }
      const d = opts.deathFn?.(spawnId) ?? "unknown";
      return d === "confirmed"
        ? { ok: true, outcome: "removed" }
        : { ok: false, code: "E_AGENT_ONLINE", reason: "exit-unconfirmed" };
    },
    deathOf: (spawnId: string) => opts.deathFn?.(spawnId),
    async shutdown() {},
  } satisfies SpawnSupervisor;
  return { sup, removeCalls };
}

const fakeRes = {
  setHeader: () => {},
  once: (ev: string, cb: () => void) => {
    if (ev === "finish") cb();
  },
} as unknown as ServerResponse;
const fakeReq = { destroy: () => {} } as unknown as IncomingMessage;

describe("createAgentRemoveService — §2.4 decision table", () => {
  it("row 1: spawnId form, spawn feature off ⇒ 404 E_NOT_FOUND (no lookup needed)", async () => {
    const log = memLog();
    const { port } = fakeRegistryRemove(() => "absent");
    const svc = createAgentRemoveService({ registry: port, log, now: Date.now });
    const { io, errors } = fakeIo({ body: { spawnId: "sp_0123456789abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(errors).toEqual([{ status: 404, code: "E_NOT_FOUND", message: undefined }]);
  });

  it("row 1: spawnId form, managed face present but LAN lan=off ⇒ 404", async () => {
    const log = memLog();
    const { port } = fakeRegistryRemove(() => "absent");
    const { sup } = fakeSup({ records: [baseRecord({ spawnId: "sp_0123456789abcdef", state: "live" })] });
    const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "off" }, log, now: Date.now });
    const { io, errors } = fakeIo({ listener: "lan", body: { spawnId: "sp_0123456789abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(errors).toEqual([{ status: 404, code: "E_NOT_FOUND", message: undefined }]);
  });

  it("row 2: spawnId form, no such record ⇒ 200 {removed:true} (idempotent)", async () => {
    const log = memLog();
    const { port } = fakeRegistryRemove(() => "absent");
    const { sup, removeCalls } = fakeSup({ records: [] });
    const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "known" }, log, now: Date.now });
    const { io, sent } = fakeIo({ body: { spawnId: "sp_0123456789abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([{ status: 200, body: { removed: true } }]);
    expect(removeCalls).toEqual([]); // never even called sup.remove for an absent record
  });

  it("row 3: a found record + managedAllowed ⇒ removed/pending/409/504 all ride through sup.remove()", async () => {
    const log = memLog();
    const { port } = fakeRegistryRemove(() => "absent");
    const rec = baseRecord({ spawnId: "sp_0123456789abcdef", state: "live", agentKey: "a1-abcdef" });
    {
      // removed
      const { sup } = fakeSup({ records: [rec], removeFn: () => ({ ok: true, outcome: "removed" }) });
      const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "known" }, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { agentKey: "a1-abcdef" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([{ status: 200, body: { removed: true } }]);
    }
    {
      // pending
      const { sup } = fakeSup({
        records: [rec],
        removeFn: () => ({ ok: true, outcome: "pending", state: "stopping" }),
      });
      const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "known" }, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { spawnId: "sp_0123456789abcdef" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([
        { status: 202, body: { removed: false, pending: true, spawnId: "sp_0123456789abcdef", state: "stopping" } },
      ]);
    }
    {
      // exit-unconfirmed
      const { sup } = fakeSup({
        records: [rec],
        removeFn: () => ({ ok: false, code: "E_AGENT_ONLINE", reason: "exit-unconfirmed" }),
      });
      const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "known" }, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { spawnId: "sp_0123456789abcdef" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([{ status: 409, body: { error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" } }]);
    }
    {
      // deadline
      const { sup } = fakeSup({ records: [rec], removeFn: () => ({ ok: false, code: "E_DEADLINE" }) });
      const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "known" }, log, now: Date.now });
      const { io, errors } = fakeIo({ body: { spawnId: "sp_0123456789abcdef" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(errors).toEqual([{ status: 504, code: "E_DEADLINE", message: undefined }]);
    }
  });

  it("row 4: agentKey form, non-terminal managed record, LAN lan=off ⇒ 403 E_SPAWN_DENIED{lan-off}; sup.remove is NEVER called", async () => {
    const log = memLog();
    const { port, calls } = fakeRegistryRemove(() => "online");
    const rec = baseRecord({ spawnId: "sp_0123456789abcdef", state: "live", agentKey: "a1-abcdef" });
    const { sup, removeCalls } = fakeSup({ records: [rec] });
    const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "off" }, log, now: Date.now });
    const { io, sent } = fakeIo({ listener: "lan", body: { agentKey: "a1-abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([{ status: 403, body: { error: "E_SPAWN_DENIED", reason: "lan-off" } }]);
    expect(removeCalls).toEqual([]);
    expect(calls).toEqual([]); // the registry is never touched either — process AND card untouched
  });

  it("row 5: agentKey form, TERMINAL managed record, LAN lan=off, deathOf=confirmed ⇒ 200, only the card is deleted (registry.remove, allowConnected:true), spawn record untouched", async () => {
    const log = memLog();
    const { port, calls } = fakeRegistryRemove(() => "removed");
    const rec = baseRecord({ spawnId: "sp_0123456789abcdef", state: "exited", agentKey: "a1-abcdef" });
    const { sup, removeCalls } = fakeSup({ records: [rec], deathFn: () => "confirmed" });
    const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "off" }, log, now: Date.now });
    const { io, sent } = fakeIo({ listener: "lan", body: { agentKey: "a1-abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([{ status: 200, body: { removed: true } }]);
    expect(removeCalls).toEqual([]); // the spawn record itself is NEVER touched
    expect(calls).toEqual([{ agentKey: "a1-abcdef", allowConnected: true }]);
  });

  it("row 5: same but deathOf is alive/unknown ⇒ 409 exit-unconfirmed, registry untouched", async () => {
    const log = memLog();
    const { port, calls } = fakeRegistryRemove(() => "removed");
    const rec = baseRecord({ spawnId: "sp_0123456789abcdef", state: "exited", agentKey: "a1-abcdef" });
    const { sup } = fakeSup({ records: [rec], deathFn: () => "alive" });
    const svc = createAgentRemoveService({ registry: port, managed: { sup, lan: "off" }, log, now: Date.now });
    const { io, sent } = fakeIo({ listener: "lan", body: { agentKey: "a1-abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([{ status: 409, body: { error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" } }]);
    expect(calls).toEqual([]);
  });

  it("row 6: agentKey form, no managed record ⇒ registry.remove alone decides; online⇒409, removed/absent⇒200", async () => {
    const log = memLog();
    {
      const { port } = fakeRegistryRemove(() => "online");
      const svc = createAgentRemoveService({ registry: port, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { agentKey: "a9-ffffff" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([{ status: 409, body: { error: "E_AGENT_ONLINE", reason: "online" } }]);
    }
    {
      const { port } = fakeRegistryRemove(() => "removed");
      const svc = createAgentRemoveService({ registry: port, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { agentKey: "a9-ffffff" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([{ status: 200, body: { removed: true } }]);
    }
    {
      const { port } = fakeRegistryRemove(() => "absent");
      const svc = createAgentRemoveService({ registry: port, log, now: Date.now });
      const { io, sent } = fakeIo({ body: { agentKey: "a9-ffffff" } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent).toEqual([{ status: 200, body: { removed: true } }]);
    }
  });
});

describe("createAgentRemoveService — gates (CSRF/auth/body/rate)", () => {
  function emptySvc() {
    const { port } = fakeRegistryRemove(() => "absent");
    return createAgentRemoveService({ registry: port, log: memLog(), now: Date.now });
  }

  it("CSRF fails ⇒ throws an HttpError(403, E_CSRF), never calls readJson", async () => {
    const svc = emptySvc();
    let readCalled = false;
    const { io } = fakeIo({ csrfOk: false });
    const wrapped: AgentRemoveIo = { ...io, readJson: async () => ((readCalled = true), {}) };
    await expect(svc.handle(fakeReq, fakeRes, wrapped)).rejects.toMatchObject({ status: 403, code: "E_CSRF" });
    expect(readCalled).toBe(false);
  });

  it("authorize() returns handled ⇒ the service sends nothing further itself (the io already answered)", async () => {
    const svc = emptySvc();
    const { io, sent, errors } = fakeIo({ auth: { handled: true, code: "E_AUTH" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("body with both agentKey and spawnId ⇒ 400 E_BAD_REQUEST", async () => {
    const svc = emptySvc();
    const { io, sent } = fakeIo({ body: { agentKey: "a1-abcdef", spawnId: "sp_0123456789abcdef" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent).toEqual([
      { status: 400, body: { error: "E_BAD_REQUEST", message: "body must carry exactly one of agentKey or spawnId" } },
    ]);
  });

  it("body with neither ⇒ 400 E_BAD_REQUEST", async () => {
    const svc = emptySvc();
    const { io, sent } = fakeIo({ body: {} });
    await svc.handle(fakeReq, fakeRes, io);
    expect(sent[0]).toMatchObject({ status: 400 });
  });

  it("malformed agentKey (bad chars) / spawnId (wrong shape) ⇒ 400", async () => {
    const svc = emptySvc();
    const { io: io1, sent: s1 } = fakeIo({ body: { agentKey: "bad key!" } });
    await svc.handle(fakeReq, fakeRes, io1);
    expect(s1[0]).toMatchObject({ status: 400 });
    const { io: io2, sent: s2 } = fakeIo({ body: { spawnId: "short" } });
    await svc.handle(fakeReq, fakeRes, io2);
    expect(s2[0]).toMatchObject({ status: 400 });
  });

  it("readJson 413/408 ⇒ the matching status, connection-closing reply", async () => {
    const svc = emptySvc();
    const { io: io413, sent: s413 } = fakeIo({ readJsonThrow: { status: 413 } });
    await svc.handle(fakeReq, fakeRes, io413);
    expect(s413[0]).toMatchObject({ status: 413, body: { error: "E_BAD_REQUEST" } });
    const { io: io408, sent: s408 } = fakeIo({ readJsonThrow: { status: 408 } });
    await svc.handle(fakeReq, fakeRes, io408);
    expect(s408[0]).toMatchObject({ status: 408, body: { error: "E_DEADLINE" } });
  });

  it("the remove token bucket is per listener:user:remove and independent from other buckets", async () => {
    const { port } = fakeRegistryRemove(() => "absent");
    const svc = createAgentRemoveService({ registry: port, log: memLog(), now: Date.now });
    for (let i = 0; i < 10; i++) {
      const { io, sent } = fakeIo({ auth: { ip: "10.0.0.1", user: "alice" }, body: { agentKey: `a${i}-aaaaaa` } });
      await svc.handle(fakeReq, fakeRes, io);
      expect(sent[0]?.status).toBe(200);
    }
    const { io, errors } = fakeIo({ auth: { ip: "10.0.0.1", user: "alice" }, body: { agentKey: "a99-aaaaaa" } });
    await svc.handle(fakeReq, fakeRes, io);
    expect(errors).toEqual([{ status: 429, code: "E_RATE", message: undefined }]);
    // a different user is a different bucket — unaffected
    const { io: io2, sent: s2 } = fakeIo({ auth: { ip: "10.0.0.2", user: "bob" }, body: { agentKey: "a0-bbbbbb" } });
    await svc.handle(fakeReq, fakeRes, io2);
    expect(s2[0]?.status).toBe(200);
  });
});
