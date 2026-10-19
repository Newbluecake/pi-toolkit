/**
 * LAN security r2 §4.2 (package E): the lan-spawn emit seams.
 *
 * Fresh (`entry.ts` onAccepted, provisioned only for the LAN listener), resume/fork and relaunch
 * (`routes.ts` emitLanSpawn), the idempotent-replay exclusion and the Feishu-origin exclusion.
 * These run against the REAL `startFresh`/`createSpawnRoutes` over the spawn-kit fakes (no fork,
 * no procfs, no reaper) — the seam is the injected `SecurityEventBus`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createCmdLimit } from "../../../../src/web-hub/hub/cmd-limit.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { createSecurityEventBus, type SecurityEvent } from "../../../../src/web-hub/hub/security-events.js";
import {
  createSpawnIdempotency,
  dirTailOf,
  startFresh,
  type FreshSpawnContext,
  type FreshSpawnIntent,
} from "../../../../src/web-hub/hub/spawn/entry.js";
import { createSpawnRoutes, type SpawnRoutesDeps } from "../../../../src/web-hub/hub/spawn/routes.js";
import type { SpawnRouteIo } from "../../../../src/web-hub/hub/spawn/ports.js";
import { fakeClock } from "../../http/lan-helpers.js";
import {
  fakeDirs,
  fakeFirstPrompt,
  fakeHistory,
  fakeSpawnPrefs,
  fakeSpawnSupervisor,
  spawnKit,
} from "../../http/spawn-kit.js";

describe("dirTailOf (§4.2 Q9)", () => {
  it("returns the last two path segments, undefined when there are none", () => {
    expect(dirTailOf("/home/alice/proj/sub")).toBe("proj/sub");
    expect(dirTailOf("/home/alice/proj")).toBe("alice/proj");
    expect(dirTailOf("/proj")).toBe("proj");
    expect(dirTailOf("/")).toBeUndefined();
    expect(dirTailOf("")).toBeUndefined();
    expect(dirTailOf("/home/")).toBe("home");
  });
});

describe("fresh lan-spawn emit (entry.ts onAccepted)", () => {
  it("fires onAccepted on the accepted path and never on the idempotent replay", async () => {
    const supervisor = fakeSpawnSupervisor();
    const dirs = fakeDirs(); // default admit: known, realpath = raw
    const accepted: Array<{ ip: string; user?: string; dirTail?: string }> = [];
    const ctx: FreshSpawnContext = {
      principal: "lan-alice",
      owner: { listener: "lan", user: "alice", reqId: "req-aaaaaaaaaaaa" },
      origin: { listener: "lan", ip: "192.168.1.5", user: "alice", reqId: "req-aaaaaaaaaaaa" },
      policy: { scope: "known", confirm: "unknown-dir" },
      rate: { bucket: "lan-alice:spawn", capacity: 10, refillMs: 6_000, onReject: () => {} },
      limit: createCmdLimit(() => 0),
      idempotency: createSpawnIdempotency(() => 0),
      dirs,
      supervisor,
      firstPrompt: fakeFirstPrompt(),
      prefs: fakeSpawnPrefs(),
      registerTimeoutS: 30,
      deadline: createReqDeadline(() => 0, 8_000),
      now: () => 0,
      audit: () => {},
      reauthorize: async () => ({ ok: true }),
      onAccepted: (info) => accepted.push(info),
    };
    const intent: FreshSpawnIntent = {
      id: "req-aaaaaaaaaaaa",
      cwd: "/home/alice/proj/sub",
      confirmed: false,
      expectCwd: undefined,
      model: undefined,
      firstPrompt: undefined,
    };
    const first = await startFresh(intent, ctx);
    expect(first.kind).toBe("accepted");
    expect(accepted).toEqual([{ ip: "192.168.1.5", user: "alice", dirTail: "proj/sub" }]);
    // Idempotent replay: same principal|id ⇒ dup, and the dup path never calls onAccepted.
    const second = await startFresh(intent, ctx);
    expect(second.kind).toBe("accepted");
    expect(accepted).toHaveLength(1);
  });

  it("works without onAccepted (the Feishu bot origin never sets it)", async () => {
    const supervisor = fakeSpawnSupervisor();
    const dirs = fakeDirs();
    const ctx: FreshSpawnContext = {
      principal: "feishu:1:ou_owner",
      owner: { listener: "lan", user: "feishu:1:ou_owner", reqId: "req-ffffffffffff" },
      origin: { listener: "lan", ip: "feishu", user: "feishu:1:ou_owner", reqId: "req-ffffffffffff" },
      policy: { scope: "known", confirm: "unknown-dir" },
      rate: { bucket: "b", capacity: 10, refillMs: 6_000, onReject: () => {} },
      limit: createCmdLimit(() => 0),
      idempotency: createSpawnIdempotency(() => 0),
      dirs,
      supervisor,
      firstPrompt: fakeFirstPrompt(),
      prefs: fakeSpawnPrefs(),
      registerTimeoutS: 30,
      deadline: createReqDeadline(() => 0, 8_000),
      now: () => 0,
      audit: () => {},
      reauthorize: async () => ({ ok: true }),
      // no onAccepted
    };
    const outcome = await startFresh(
      {
        id: "req-ffffffffffff",
        cwd: "/home/u/proj",
        confirmed: false,
        expectCwd: undefined,
        model: undefined,
        firstPrompt: undefined,
      },
      ctx,
    );
    expect(outcome.kind).toBe("accepted");
  });
});

function makeRoutes(listener: "loopback" | "lan" = "lan") {
  const clock = fakeClock();
  const kit = spawnKit({ lan: "known", history: true }, clock, fakeSpawnPrefs(), fakeHistory());
  const events: SecurityEvent[] = [];
  const bus = createSecurityEventBus({ error: () => {} });
  bus.subscribe((e) => events.push(e));
  const deps: SpawnRoutesDeps = {
    supervisor: kit.supervisor,
    dirs: kit.dirs,
    firstPrompt: kit.firstPrompt,
    prefs: kit.prefs,
    cfg: kit.cfg,
    limit: createCmdLimit(clock.now),
    rejectAudit429: new Map(),
    log: kit.log,
    now: clock.now,
    history: kit.history,
    security: bus,
  };
  const spawn = createSpawnRoutes(deps);
  return { kit, spawn, events, listener };
}

function fakeIo(listener: "loopback" | "lan", body?: unknown): SpawnRouteIo & { status?: number } {
  const state: { status?: number } = {};
  class HttpError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    listener,
    ip: "192.168.1.5",
    scheme: "http",
    viaTrustedProxy: false,
    strictCsrfOk: () => true,
    authorize: async () => ({ ip: "192.168.1.5", user: "alice" }),
    readJson: async () => body,
    sendJson: (_res: ServerResponse, status: number) => {
      state.status = status;
    },
    sendError: (_res: ServerResponse, status: number) => {
      state.status = status;
    },
    HttpError,
    ...state,
  };
}

const req = {} as IncomingMessage;
const res = {} as ServerResponse;

describe("lan-spawn emit seams on the routes (§4.2)", () => {
  it("fresh LAN spawn emits lan-spawn{new}; loopback does not", async () => {
    const lan = makeRoutes("lan");
    await lan.spawn.handle(
      req,
      res,
      "POST",
      "/api/headless",
      new URLSearchParams(),
      fakeIo("lan", { id: "req-aaaaaaaaaaaa", cwd: "/home/u/proj" }),
    );
    expect(lan.events).toEqual([
      { type: "lan-spawn", ip: "192.168.1.5", user: "alice", mode: "new", dirTail: "u/proj" },
    ]);

    const loop = makeRoutes("loopback");
    await loop.spawn.handle(
      req,
      res,
      "POST",
      "/api/headless",
      new URLSearchParams(),
      fakeIo("loopback", { id: "req-aaaaaaaaaaaa", cwd: "/home/u/proj" }),
    );
    expect(loop.events).toEqual([]);
  });

  it("resume and fork emit lan-spawn with the session mode", async () => {
    const { spawn, events } = makeRoutes("lan");
    await spawn.handle(
      req,
      res,
      "POST",
      "/api/headless",
      new URLSearchParams(),
      fakeIo("lan", {
        id: "hist-0000-aaaaaa",
        cwd: "/home/u/proj",
        session: { key: "dir/sess-old.jsonl", id: "sess-old" },
      }),
    );
    expect(events).toContainEqual({
      type: "lan-spawn",
      ip: "192.168.1.5",
      user: "alice",
      mode: "resume",
      dirTail: "u/proj",
    });
    events.length = 0;
    await spawn.handle(
      req,
      res,
      "POST",
      "/api/headless",
      new URLSearchParams(),
      fakeIo("lan", {
        id: "hist-0000-bbbbbb",
        cwd: "/home/u/proj",
        session: { key: "dir/sess-old.jsonl", id: "sess-old", mode: "fork" },
      }),
    );
    expect(events).toContainEqual({
      type: "lan-spawn",
      ip: "192.168.1.5",
      user: "alice",
      mode: "fork",
      dirTail: "u/proj",
    });
  });

  it("relaunch emits lan-spawn{relaunch} once, and never on an idempotent replay", async () => {
    const { kit, spawn, events } = makeRoutes("lan");
    kit.supervisor.seedRecord({ spawnId: "relaunch-aaaaaaaa", cwd: "/home/u/proj" });
    kit.supervisor.setRelaunchResult({ ok: true, state: "starting", dup: false });
    await spawn.handle(
      req,
      res,
      "POST",
      "/api/headless/relaunch",
      new URLSearchParams(),
      fakeIo("lan", { spawnId: "relaunch-aaaaaaaa" }),
    );
    expect(events).toEqual([
      { type: "lan-spawn", ip: "192.168.1.5", user: "alice", mode: "relaunch", dirTail: "u/proj" },
    ]);
    // Idempotent replay: dup:true ⇒ no second alert.
    kit.supervisor.setRelaunchResult({ ok: true, state: "starting", dup: true });
    await spawn.handle(
      req,
      res,
      "POST",
      "/api/headless/relaunch",
      new URLSearchParams(),
      fakeIo("lan", { spawnId: "relaunch-aaaaaaaa" }),
    );
    expect(events).toHaveLength(1);
  });
});
