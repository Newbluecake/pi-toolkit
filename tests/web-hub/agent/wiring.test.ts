import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { currentConnection } from "../../../src/web-hub/agent/connection.js";
import { wireWebHub, WEB_HUB_STATUS_KEY, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-");
  resetGlobals();
});
afterEach(async () => {
  resetGlobals();
  await hub?.close();
  hub = undefined;
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("wireWebHub — print/json never connect", () => {
  it.each(["print", "json"] as const)("mode %s: zero net.connect, zero build-info probe", async (mode) => {
    const n = fakeNet();
    const buildInfo = vi.fn(async () => ({ pluginVersion: "1", buildId: "1@x" }));
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: n.netConnect, buildInfo }));
    const { ctx } = fakeCtx({ mode });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    fire("message_start", { type: "message_start", message: { role: "user", timestamp: 1 } }, ctx);
    fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(n.calls()).toBe(0);
    expect(buildInfo).not.toHaveBeenCalled();
    expect(control.status()).toEqual({ state: "off", attached: false });
  });
});

describe("wireWebHub — tui against a fake hub", () => {
  it("session_start → hello + session; events → ev; status line; session_shutdown(quit) → bye", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx, state } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    fire("message_start", { type: "message_start", message: { role: "user", timestamp: 7, content: "hi" } }, ctx);
    fire("message_end", { type: "message_end", message: { role: "user", timestamp: 7, content: "hi" } }, ctx);
    fire("turn_end", { type: "turn_end", turnIndex: 0, messageEntryId: "e1", toolResultEntryIds: [] }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "ev" && f.e.type === "turn_end"), 3_000, "ev");
    const frames = hub.all();
    expect(frames[0]).toMatchObject({ t: "hello", pluginVersion: "1.2.3", buildId: "1.2.3@test", kind: "tui" });
    expect(frames[1]).toMatchObject({
      t: "session",
      sessionId: "sess-1",
      sessionFile: "/tmp/fake-session.jsonl",
      reason: "startup",
      leafId: "e1",
      mode: "tui",
      model: { provider: "p", id: "m" },
    });
    const evs = frames.filter((f): f is Extract<AgentFrame, { t: "ev" }> => f.t === "ev");
    expect(evs.map((f) => f.e.type)).toEqual(["message_start", "message_end", "turn_end"]);
    expect(evs.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(frames.some((f) => f.t === "status")).toBe(true);
    expect(state.statusCalls).toContainEqual([WEB_HUB_STATUS_KEY, "web ●"]);

    fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "bye"), 3_000, "bye");
    expect(hub.all().at(-1)).toEqual({ t: "bye", reason: "quit" });
    expect(state.statusCalls.at(-1)).toEqual([WEB_HUB_STATUS_KEY, undefined]);
    expect(currentConnection()).toBeUndefined();
  });

  it("snapshot_req → snapshot_reply (same-tick leafId/seq, recent with seqs, sessionFile)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx, state } = fakeCtx({ mode: "tui", leaf: "L1" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    fire("message_end", { type: "message_end", message: { role: "user", timestamp: 11 } }, ctx);
    state.leaf = "L2";
    hub.send(hub.conns[0]!, { t: "snapshot_req", rid: "r9" });
    await waitUntil(() => hub!.all().some((f) => f.t === "snapshot_reply"), 3_000, "reply");
    const reply = hub.all().find((f) => f.t === "snapshot_reply") as Extract<AgentFrame, { t: "snapshot_reply" }>;
    expect(reply).toMatchObject({ rid: "r9", seq: 1, leafId: "L2", sessionFile: "/tmp/fake-session.jsonl" });
    expect(reply.status.leafId).toBe("L2");
    expect(reply.recent).toEqual([{ seq: 1, message: { role: "user", timestamp: 11 } }]);
  });

  it("K4 path 1 across re-activation: same connection object, zero extra connect, session_detached → session(new)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const n = { count: 0 };
    const { connect } = await import("node:net");
    const netConnect = ((o: never) => {
      n.count += 1;
      return connect(o);
    }) as unknown as typeof connect;
    const a = fakePi();
    const control1 = wireWebHub(a.pi, deps({ netConnect }));
    const c1 = fakeCtx({ mode: "tui" });
    a.fire("session_start", { type: "session_start", reason: "startup" }, c1.ctx);
    await waitUntil(() => control1.status().state === "live", 3_000, "live");
    const first = currentConnection();
    a.fire("session_shutdown", { type: "session_shutdown", reason: "new" }, c1.ctx);
    // activate re-runs (same module instance), then the new session starts
    const b = fakePi();
    const control2 = wireWebHub(b.pi, deps({ netConnect }));
    const c2 = fakeCtx({ mode: "tui", sessionId: "sess-2", sessionFile: "/tmp/s2.jsonl", leaf: null });
    b.fire("session_start", { type: "session_start", reason: "new" }, c2.ctx);
    expect(currentConnection()).toBe(first); // reused synchronously
    await waitUntil(() => hub!.all().filter((f) => f.t === "session").length >= 2, 3_000, "second session");
    expect(n.count).toBe(1);
    expect(hub.conns).toHaveLength(1);
    const types = hub
      .all()
      .map((f) => f.t)
      .filter((t) => t === "session" || t === "session_detached" || t === "hello");
    expect(types).toEqual(["hello", "session", "session_detached", "session"]);
    expect(
      hub
        .all()
        .filter((f) => f.t === "session")
        .at(-1),
    ).toMatchObject({ sessionId: "sess-2", reason: "new", leafId: null });
    expect(control2.status()).toMatchObject({ state: "live", attached: true });
  });

  it("rpc mode attaches (kind rpc) without touching the status line", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx, state } = fakeCtx({ mode: "rpc" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    expect(hub.all()[0]).toMatchObject({ t: "hello", kind: "rpc" });
    expect(state.statusCalls).toEqual([]);
  });
});

describe("wireWebHub — zero hang", () => {
  it("handlers return synchronously (< 5ms) while the hub never answers (fake net never calls back)", async () => {
    const n = fakeNet();
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const { ctx } = fakeCtx({ mode: "tui" });
    const timings: number[] = [];
    const timed = (ev: string, event: unknown): void => {
      const t0 = performance.now();
      fire(ev, event, ctx);
      timings.push(performance.now() - t0);
    };
    timed("session_start", { type: "session_start", reason: "startup" });
    await flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(n.calls()).toBe(1); // connecting, never answered
    for (let i = 0; i < 200; i++) {
      timed("message_update", {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(100) },
      });
    }
    timed("message_end", { type: "message_end", message: { role: "assistant", timestamp: 1 } });
    timed("turn_end", { type: "turn_end", turnIndex: 0 });
    timed("agent_settled", { type: "agent_settled" });
    timed("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(Math.max(...timings)).toBeLessThan(5);
    expect(n.sockets[0]!.written).toEqual([]); // nothing written before connect
  });
});

describe("wireWebHub — url()", () => {
  it("live: port from hello_ack + token fragment; missing token ⇒ bare url + hint; not running ⇒ hint", async () => {
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    expect(control.url()).toEqual({ hint: expect.stringContaining("state=off") });

    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    resetGlobals();
    const w = fakePi();
    const live = wireWebHub(w.pi, deps());
    w.fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await waitUntil(() => live.status().state === "live", 3_000, "live");
    expect(live.url()).toMatchObject({ url: "http://127.0.0.1:4242/", hint: expect.stringContaining("token") });
    writeFileSync(pathsIn(tmp.dir).tokenFile, "tok_abc\n");
    expect(live.url()).toEqual({ url: "http://127.0.0.1:4242/#t=tok_abc" });
    void fire;
  });

  it("not live: falls back to hub.json when its pid is alive", () => {
    const p = pathsIn(tmp.dir);
    writeFileSync(p.hubJson, JSON.stringify({ pid: process.pid, port: 7979 }));
    writeFileSync(p.tokenFile, "t0k");
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    expect(control.url()).toEqual({ url: "http://127.0.0.1:7979/#t=t0k" });
    writeFileSync(p.hubJson, JSON.stringify({ pid: 2 ** 22 + 12345, port: 7979 })); // dead pid
    expect(control.url()).toEqual({ hint: expect.any(String) });
  });
});

describe("statusLineText colours (live marker green)", () => {
  it("plain without a theme; label dim + state colour with one", async () => {
    const { statusLineText } = await import("../../../src/web-hub/agent/index.js");
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</>` };
    expect(statusLineText({ state: "live" } as never)).toBe("web ●");
    expect(statusLineText({ state: "live" } as never, theme)).toBe("<dim>web</> <success>●</>");
    expect(statusLineText({ state: "connecting" } as never, theme)).toBe("<dim>web</> <dim>○</>");
    expect(statusLineText({ state: "backoff" } as never, theme)).toBe("<dim>web</> <error>✗</>");
    expect(statusLineText({ state: "off" } as never, theme)).toBeUndefined();
  });
});
