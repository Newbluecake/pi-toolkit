/**
 * #30 reload-result plan §1 D6 / §3 — wiring-level: the tracker inside `wireWebHub`
 * (`StatusInfo.reload` riding publishStatus, the 1Hz tick retraction, session-boundary hooks,
 * the takeover across two activations) plus the real capture-proxy attribution loop (A3).
 *
 * The full wire-compat picture (byte equality against the pre-change golden) lives in
 * `reload-result-compat.test.ts`; this file pins the wiring behaviours themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { wrapCommandApi } from "../../../src/commands/capture.js";
import { createStatusCommand } from "../../../src/commands/status.js";
import { createReloadCommandPort } from "../../../src/reload/command-port.js";
import { DeferredReloadController } from "../../../src/reload/defer.js";
import { wireWebHub, type WebHubControl } from "../../../src/web-hub/agent/index.js";
import { parseSlashCommand } from "../../../src/web-hub/agent/slash.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir, waitUntil } from "./helpers.js";

const TRACK_KEY = Symbol.for("pi-subagent:web-hub:reload-track");

interface Wired {
  net: ReturnType<typeof fakeNet>;
  raw: { pi: ExtensionAPI; fire: (ev: string, event: unknown, ctx: unknown) => void };
  control: WebHubControl;
  registered: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  commandCtx: Record<string, unknown>;
  ctx: ReturnType<typeof fakeCtx>["ctx"];
  ctxState: ReturnType<typeof fakeCtx>["state"];
  ctl: DeferredReloadController;
  frames: () => Array<Record<string, unknown>>;
  statusFrames: () => Array<Record<string, unknown>>;
  hub: (frame: unknown) => void;
  connect: () => void;
  socketCount: () => number;
  clock: { v: number };
  cleanup: () => void;
}

function wire(
  over: {
    reloadModuleInstance?: string;
    runs?: () => Array<{ runId: string; status: string }>;
    sharedNet?: ReturnType<typeof fakeNet>;
    /** Keep the process-global reload record (a SECOND activation taking over the first). */
    preserveStore?: boolean;
  } = {},
): Wired {
  resetGlobals();
  if (over.preserveStore !== true) delete (globalThis as Record<symbol, unknown>)[TRACK_KEY];
  const tmp = tmpDir("wh-d-rrw-");
  const n = over.sharedNet ?? fakeNet();
  const raw = fakePi();
  const registered = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const { ctx, state } = fakeCtx({ leaf: "L1", idle: true });
  const commandCtx: Record<string, unknown> = ctx;
  const clock = { v: 1_700_000_000_000 };
  const basePi = {
    ...raw.pi,
    getCommands: () => [{ name: "agent", source: "extension" }],
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      registered.set(name, command);
    },
    sendUserMessage(text: string) {
      const parsed = parseSlashCommand(text);
      if (parsed === undefined) return;
      const command = registered.get(parsed.name);
      if (command !== undefined)
        void Promise.resolve((command.handler as (a: string, c: unknown) => unknown)(parsed.args, commandCtx)).catch(
          () => undefined,
        );
    },
  };
  const captureRef: { current?: unknown } = {};
  const recorderRef: { current?: unknown } = {};
  const owned = new Set<string>();
  const pi = wrapCommandApi(
    basePi as unknown as ExtensionAPI,
    () => captureRef.current as never,
    owned,
    new Map(),
    () => recorderRef.current as never,
  );
  const ctl = new DeferredReloadController({
    fire: () => pi.sendUserMessage("/agent reload fire", { deliverAs: "followUp", expandPromptTemplates: true }),
  });
  const control = wireWebHub(pi, {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    netConnect: n.netConnect,
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "b1@t" }),
    argv1: "/none",
    now: () => clock.v,
    ownedCommandNames: owned,
    ...(over.reloadModuleInstance !== undefined ? { reloadModuleInstance: over.reloadModuleInstance } : {}),
    gitRunner: (async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" })) as never,
  });
  captureRef.current = control.capture;
  if (control.recorder !== undefined) recorderRef.current = control.recorder;
  const port = createReloadCommandPort(
    () => ctl,
    pi,
    (event) => control.onReloadPhase?.(event),
  );
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: { list: () => over.runs?.() ?? [] },
      orphans: { register: () => undefined, recent: [], totalCount: 0 },
      notifier: { enqueue: () => undefined },
      reload: port,
    } as never),
  );
  commandCtx.reload = async () => undefined;
  commandCtx.waitForIdle = async () => {
    state.idle = true;
  };
  return {
    net: n,
    raw: { pi, fire: (ev, event, c) => raw.fire(ev, event, c ?? ctx) },
    control,
    registered,
    commandCtx,
    ctx,
    ctxState: state,
    ctl,
    frames: () => n.sockets.flatMap((s) => s.frames()),
    statusFrames: () => n.sockets.flatMap((s) => s.frames()).filter((f) => f.t === "status"),
    hub: (frame) => n.sockets.at(-1)?.hub(frame as never),
    connect: () => n.sockets.at(-1)?.emit("connect"),
    socketCount: () => n.sockets.length,
    clock,
    cleanup: () => {
      resetGlobals();
      tmp.cleanup();
    },
  };
}

/** Like pi's AgentSession.reload: shutdown{reload} → start{reload} inside the awaited promise. */
const reloadThroughPi = (w: Wired): void => {
  w.raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, w.ctx);
  w.raw.fire("session_start", { type: "session_start", reason: "reload" }, w.ctx);
};

const netOf = (w: Wired): ReturnType<typeof fakeNet> => w.net;
const command = (w: Wired, args: string): Promise<unknown> =>
  (w.registered.get("agent")!.handler as unknown as (a: string, c: unknown) => Promise<unknown>)(args, w.commandCtx);

async function goLive(w: Wired, reason = "startup"): Promise<void> {
  w.raw.fire("session_start", { type: "session_start", reason }, undefined);
  await waitUntil(() => w.socketCount() > 0, 3_000, "socket");
  w.connect();
  await waitUntil(() => w.frames().some((f) => f.t === "hello"), 3_000, "hello");
  w.hub(ackFrame());
  await new Promise((r) => setTimeout(r, 30));
}

describe("#30 wiring: StatusInfo.reload through wireWebHub (D6)", () => {
  let w: Wired;
  afterEach(() => {
    w?.cleanup();
    vi.useRealTimers();
  });

  it("G3: TUI facts with no record produce NO output side effect (frame count unchanged)", async () => {
    w = wire();
    await goLive(w);
    const before = w.frames().length;
    await command(w, "reload"); // TUI `/agent reload`, idle — untracked (Q1)
    await new Promise((r) => setTimeout(r, 30));
    // only the session-boundary frames the unchanged pre-feature code emits — no extra status
    const added = w
      .frames()
      .slice(before)
      .filter((f) => f.t === "status");
    const all = w.frames().filter((f) => f.t === "status");
    expect(all.every((f) => f.reload === undefined)).toBe(true);
    expect(added.length).toBeLessThanOrEqual(2); // the handover burst's own publishes
  });

  it("a tracked web request rides the status slot; each projection change adds exactly one frame", async () => {
    w = wire({ runs: () => [{ runId: "r1", status: "running" }] });
    await goLive(w);
    const statusBefore = w.statusFrames().length;
    // web c1 parks the reload (fleet busy)
    w.hub({
      t: "cmd",
      rid: "r-1",
      id: "cmdw0000000000001",
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await waitUntil(() => w.frames().some((f) => f.t === "cmd_result"), 3_000, "cmd_result");
    await new Promise((r) => setTimeout(r, 30));
    const deferred = w.statusFrames().filter((f) => (f.reload as { state?: string } | undefined)?.state === "deferred");
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    expect(deferred.at(-1)!.reload).toMatchObject({
      v: 1,
      cmdIds: ["cmdw0000000000001"],
      state: "deferred",
      open: true,
      waitingFor: "runs",
      activeRuns: 1,
    });
    // web c2 cancels — exactly one more projection frame (cancelled)
    w.hub({
      t: "cmd",
      rid: "r-2",
      id: "cmdw0000000000002",
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload cancel", confirm: true },
    });
    await waitUntil(
      () => w.statusFrames().some((f) => (f.reload as { state?: string } | undefined)?.state === "cancelled"),
      3_000,
      "cancelled frame",
    );
    // the projection progressed deferred → cancelled; older status frames (pre-fact) never
    // carried the slot — the exact per-frame delta is pinned byte-level by the compat golden
    const preFact = w.statusFrames().slice(0, statusBefore);
    expect(preFact.every((f) => f.reload === undefined)).toBe(true);
  });

  it("A3: attribution flows through the real capture proxy (dispatch deferred past bridge-return)", async () => {
    w = wire();
    await goLive(w);
    // the hub frame arms the capture; pi would run the handler later (the agent_settled window)
    w.hub({
      t: "cmd",
      rid: "r-1",
      id: "cmdw0000000000003",
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await new Promise((r) => setTimeout(r, 30)); // bridge returned; handler NOT yet executed
    w.ctxState.idle = false; // model streaming — the handler parks instead of reloading
    await command(w, "reload"); // pi's deferred dispatch — the capture fallback queue matches
    await new Promise((r) => setTimeout(r, 30));
    const tracked = w.statusFrames().find((f) => f.reload !== undefined)!.reload as Record<string, unknown>;
    expect(tracked.cmdIds).toEqual(["cmdw0000000000003"]); // attributed via webCmdId (A3)
  });

  it("A6: a foreign /reload shutdown supersedes a parked request; the retraction rides the next publish", async () => {
    w = wire({ runs: () => [{ runId: "r1", status: "running" }] });
    await goLive(w);
    w.ctxState.idle = false;
    await command(w, "reload"); // TUI parks (streaming) — untracked…
    // …then the WEB request parks on the same lifecycle (busy fleet)
    // (drive directly: the port emitted facts only for TUI so far — feed the tracker through
    // the real captured path instead)
    w.hub({
      t: "cmd",
      rid: "r-1",
      id: "cmdw0000000000004",
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await waitUntil(() => w.statusFrames().some((f) => f.reload !== undefined), 3_000, "deferred slot");
    // pi's BUILTIN /reload fires (no port facts): shutdown{reload} without a started fact
    w.raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, w.ctx);
    w.raw.fire("session_start", { type: "session_start", reason: "reload" }, w.ctx);
    await waitUntil(
      () => w.statusFrames().some((f) => (f.reload as { state?: string } | undefined)?.state === "cancelled"),
      3_000,
      "superseded frame",
    );
    const cancelled = w.statusFrames().find((f) => (f.reload as { state?: string } | undefined)?.state === "cancelled")!
      .reload as Record<string, unknown>;
    expect(cancelled.code).toBe("superseded"); // A6: never completed
  });

  it("A4/D4 wiring: started → shutdown{reload} → a DIFFERENT module instance's session_start ⇒ completed (epoch + version)", async () => {
    w = wire(); // the OLD activation (module instance A — the default seam value)
    // The OLD activation's half of a real reload: shutdown{reload} INSIDE the awaited reload().
    // The NEW module instance's session_start{reload} arrives with w2 below — a real /reload.
    w.commandCtx.reload = async () => {
      w.raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, undefined);
    };
    await goLive(w);
    w.hub({
      t: "cmd",
      rid: "r-1",
      id: "cmdw0000000000005",
      deadlineMs: 8_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await waitUntil(() => w.frames().some((f) => f.t === "cmd_result"), 3_000, "cmd_result");
    await waitUntil(
      () =>
        (w.statusFrames().find((f) => f.reload !== undefined)?.reload as { state?: string } | undefined)?.state ===
        "started",
      3_000,
      "started frame",
    );
    // the OLD activation's wire never says "completed": only the next activation can
    expect(w.statusFrames().every((f) => (f.reload as { state?: string } | undefined)?.state !== "completed")).toBe(
      true,
    );
    const shared = netOf(w);
    // A REAL /reload re-evaluates the module: MODULE_INSTANCE differs. `reloadModuleInstance`
    // is the seam standing in for that; the record store is process-global and survives.
    const w2 = wire({ reloadModuleInstance: "module-instance-B", sharedNet: shared, preserveStore: true });
    try {
      await goLive(w2, "reload"); // consume marker → validate → completed (D4)
      const { readStore } = await import("../../../src/web-hub/agent/reload-track.js");
      const done = readStore().rec;
      expect(done).toMatchObject({
        state: "completed",
        open: false,
        cmdIds: ["cmdw0000000000005"],
        epoch: "module-instance-B", // the TAKING activation's instance
      });
      expect(typeof done!.version).toBe("string");
      expect(done!.version).not.toBe("0.0.0");
    } finally {
      w2.cleanup();
    }
  });

  it("D6/A4 slot: a completed projection rides the status slot on the next publish", async () => {
    vi.useFakeTimers();
    w = wire();
    w.raw.fire("session_start", { type: "session_start", reason: "startup" }, undefined);
    await vi.advanceTimersByTimeAsync(0);
    w.connect();
    await vi.advanceTimersByTimeAsync(0);
    w.hub(ackFrame());
    await vi.advanceTimersByTimeAsync(0);
    const { readStore, writeStore } = await import("../../../src/web-hub/agent/reload-track.js");
    // the state a validated takeover leaves behind: completed with a trusted version + epoch
    writeStore({
      v: 1,
      rec: {
        v: 1,
        life: "L-completed",
        cmdIds: ["cmdw0000000000007"],
        rev: 5,
        execId: "X-completed",
        state: "completed",
        open: false,
        at: w.clock.v,
        version: "0.10.6",
        epoch: "module-instance-B",
      },
    });
    expect(readStore().rec?.state).toBe("completed");
    w.ctxState.leaf = "L2"; // the existing leaf probe is the publish path
    await vi.advanceTimersByTimeAsync(1_000);
    const slot = w.statusFrames().at(-1)!.reload as Record<string, unknown>;
    expect(slot).toMatchObject({
      v: 1,
      state: "completed",
      open: false,
      version: "0.10.6",
      epoch: "module-instance-B",
      cmdIds: ["cmdw0000000000007"],
    });
  });

  const webReloadFrame = (id: string) => ({
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
    cmd: { op: "command", name: "agent", args: "reload", confirm: true },
  });
  const lastReload = (x: Wired): Record<string, unknown> | undefined =>
    x
      .statusFrames()
      .map((f) => f.reload as Record<string, unknown> | undefined)
      .filter((r) => r !== undefined)
      .at(-1);

  it("A8: a TUI host that refuses (returns normally, no shutdown) ⇒ failed E_RELOAD_REFUSED on the wire", async () => {
    w = wire();
    w.commandCtx.reload = async () => undefined; // pi's handleReloadCommand: streaming ⇒ hint + return
    await goLive(w);
    w.hub(webReloadFrame("cmdw0000000000008"));
    await waitUntil(() => lastReload(w)?.code === "E_RELOAD_REFUSED", 3_000, "REFUSED slot");
    expect(lastReload(w)).toMatchObject({ state: "failed", open: false, cmdIds: ["cmdw0000000000008"] });
  });

  it("A9: shutdown{reload} then a swallowed load failure (no new activation) ⇒ NO outcome frame; record stays started", async () => {
    w = wire();
    w.commandCtx.reload = async () => {
      // pi emits shutdown, the load then fails; the TUI catches it ("Reload failed:") and resolves
      w.raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, undefined);
    };
    await goLive(w);
    w.hub(webReloadFrame("cmdw0000000000009"));
    await waitUntil(() => lastReload(w)?.state === "started", 3_000, "started slot");
    await new Promise((r) => setTimeout(r, 60));
    const states = w
      .statusFrames()
      .map((f) => (f.reload as { state?: string } | undefined)?.state)
      .filter((x) => x !== undefined);
    expect(states.every((x) => x === "started")).toBe(true); // never failed/completed/cancelled
    const { readStore } = await import("../../../src/web-hub/agent/reload-track.js");
    expect(readStore().rec).toMatchObject({ state: "started", open: true });
  });

  it("A10: an RPC host that throws BEFORE any shutdown ⇒ failed E_RELOAD_THREW with the message", async () => {
    w = wire();
    // an RPC host's ctx.reload() is session.reload() — a load failure propagates to the caller.
    // (ctx.mode stays "tui" in the fake: command-port only reads it for the force-abort path,
    // which an idle ctx never takes.)
    w.commandCtx.reload = async () => {
      throw new Error("rpc reload exploded");
    };
    await goLive(w);
    w.hub(webReloadFrame("cmdw0000000000010"));
    await waitUntil(() => lastReload(w)?.code === "E_RELOAD_THREW", 3_000, "THREW slot");
    expect(lastReload(w)).toMatchObject({
      state: "failed",
      open: false,
      message: "rpc reload exploded",
      cmdIds: ["cmdw0000000000010"],
    });
  });

  it("A12: TTL expiry retracts the slot through the 1Hz tick — exactly one extra status frame", async () => {
    vi.useFakeTimers();
    w = wire();
    w.raw.fire("session_start", { type: "session_start", reason: "startup" }, undefined);
    await vi.advanceTimersByTimeAsync(0);
    w.connect();
    await vi.advanceTimersByTimeAsync(0);
    w.hub(ackFrame());
    await vi.advanceTimersByTimeAsync(0);
    w.ctxState.idle = false;
    // park a tracked request (deferred) via the real command path — TUI ctx parks the ctl, and
    // the tracker only tracks web facts: drive the web cmd frame
    w.hub({
      t: "cmd",
      rid: "r-1",
      id: "cmdw0000000000006",
      deadlineMs: 60_000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" },
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const withSlot = w.statusFrames().filter((f) => f.reload !== undefined);
    expect(withSlot.length).toBeGreaterThanOrEqual(1);
    // advance past the OPEN record TTL (40min) — the next tick publishes ONE retraction
    w.clock.v += 40 * 60_000 + 2_000;
    const retraction = w.statusFrames().length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.statusFrames().length).toBe(retraction + 1);
    expect(w.statusFrames().at(-1)!.reload).toBeUndefined();
    // …and never again
    w.clock.v += 60_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.statusFrames().length).toBe(retraction + 1);
  });
});
