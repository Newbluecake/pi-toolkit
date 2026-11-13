import { existsSync, readFileSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandHandler, createTerminalNegotiator } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createTerminalCommandIngress } from "../../src/web-hub/hub/commands.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import type { CmdFrame, CmdResultFrame, CmdLateFrame } from "../../src/web-hub/protocol/messages.js";
import type { TermRes, TerminalNegotiation } from "../../src/web-hub/protocol/terminal.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "../web-hub/agent/helpers.js";
import { postJson } from "../web-hub/http/helpers.js";
import { waitFor } from "../web-hub/hub/helpers.js";
import { terminalHarness, type TerminalHarness } from "./web-hub-terminal-harness.js";

const lives: TerminalHarness[] = [];
const ledgerKey = Symbol.for("pi-subagent:web-hub:cmd-ledger");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of lives.splice(0)) await h.close();
  delete (globalThis as Record<symbol, unknown>)[ledgerKey];
});
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const secret = "PRIVATE-GRANT-MARKER";
const inventory = "PRIVATE-INVENTORY-MARKER";
function agent(h: TerminalHarness) {
  const { ctx, state } = fakeCtx({ mode: "tui" });
  state.sessionId = "session";
  const { pi } = fakePi();
  const timer = fakeTimerQueue();
  const ordinary = {
    ok: true as const,
    data: {
      op: "command" as const,
      kind: "builtin" as const,
      completion: "sync" as const,
      captured: true,
      history: "none" as const,
    },
  };
  const builtin = vi.fn(() => ordinary);
  const mint = vi.fn(() => secret);
  const readInventory = vi.fn(() => inventory);
  const dedicated: TermRes[] = [];
  const cmdReplies: Array<CmdResultFrame | CmdLateFrame> = [];
  const incoming: CmdFrame[] = [];
  const scope = {
    localConnectionInstance: "live-connection",
    sessionId: "session",
    epoch: "epoch-1",
    ownerInstance: "owner",
  };
  const negotiator = createTerminalNegotiator({
    now: Date.now,
    current: () => scope,
    allowed: () => true,
    limits,
    mintGrant: mint,
    send: (f) => {
      dedicated.push(f);
      h.client.send(f);
    },
    onBound: (_channel, proof) => {
      if (proof.mode === "resource-only") readInventory();
    },
  });
  const ledger = createCommandLedger();
  let defer = false;
  const waiting: CmdFrame[] = [];
  const handler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => "session",
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin() {}, notify() {}, dispose() {} },
    builtinBridge: { execute: builtin, isQuiet: () => false },
    controlEnabled: () => true,
    now: Date.now,
    send: (f) => {
      cmdReplies.push(f);
      h.client.send(f);
    },
    onChanged() {},
    setTimer: timer.setTimer,
    terminal: negotiator,
  });
  const decoder = new NdjsonDecoder({
    onFrame: (raw) => {
      const f = raw as CmdFrame;
      if (f.t === "cmd") {
        incoming.push(f);
        if (defer) waiting.push(f);
        else handler.handle(f);
      } else if ((raw as { t?: string }).t === "term_req") negotiator.receive(raw);
    },
    onError: (e) => {
      throw new Error(e.code);
    },
  });
  h.client.sock.on("data", (b) => decoder.push(b));
  return {
    handler,
    ledger,
    negotiator,
    builtin,
    mint,
    readInventory,
    dedicated,
    cmdReplies,
    incoming,
    scope,
    defer() {
      defer = true;
    },
    release() {
      defer = false;
      for (const f of waiting.splice(0)) handler.handle(f);
    },
  };
}

describe("T-OLD-HUB r4 (§4.1.1 Major): unpatched /api/cmd/LRU/waiters/registry/HTTP/SSE", () => {
  it("actively submitted reserved actions get public offers/refusal only, including concurrent dup/query/late", async () => {
    const h = await terminalHarness({ legacy: true });
    lives.push(h);
    const a = agent(h);
    const spawn = vi.spyOn(childProcess, "spawn"),
      fork = vi.spyOn(childProcess, "fork"),
      execFile = vi.spyOn(childProcess, "execFile"),
      spawnSync = vi.spyOn(childProcess, "spawnSync");
    const streams = await Promise.all([h.sse(0), h.sse(1)]);
    const mapSpy = vi.spyOn(Map.prototype, "set"); // observation only; original implementation remains real
    const request = (id: string, args: string, queryOnly = false) =>
      postJson(
        h.ports[0]!,
        "/api/cmd",
        {
          agentKey: h.agentKey,
          id,
          op: "command",
          name: "webhub",
          args,
          expect: { sessionId: "session", epoch: "epoch-1" },
          ...(queryOnly ? { queryOnly: true } : {}),
        },
        { Cookie: h.cookies[0]!, Origin: `http://127.0.0.1:${h.ports[0]}` },
      );
    const raw: string[] = [];
    const args = "__terminal " + JSON.stringify({ v: 1, action: "negotiate", requestNonce: "browser-public-nonce" });
    a.defer();
    const first = request("a".repeat(16), args);
    await waitFor(() => a.incoming.length === 1);
    let secondDone = false;
    const second = request("a".repeat(16), args).then((r) => {
      secondDone = true;
      return r;
    });
    // A bounded real delay lets HTTP accept the second request while the original remains deferred.
    await new Promise<void>((r) => {
      const t = setTimeout(r, 25);
      t.unref();
    });
    expect(secondDone).toBe(false);
    expect(a.cmdReplies).toHaveLength(0);
    expect(a.incoming).toHaveLength(1);
    a.release();
    for (const r of await Promise.all([first, second])) {
      expect(r.status).toBe(200);
      raw.push(r.body);
      expect(r.body).toContain("handshake-required");
    }
    raw.push((await request("a".repeat(16), args)).body, (await request("a".repeat(16), args, true)).body);
    const actions: unknown[] = [
      { v: 1, action: "resource_inventory", requestNonce: "resource-nonce" },
      { v: 1, action: "resource_inventory", requestNonce: "resource-nonce", page: 1 },
      { v: 1, action: "protocol_ready", offerId: "forged", hubNonce: "forged", agentChallenge: "forged" },
      { v: 1, action: "negotiate", requestNonce: "nonce", ready: { t: "term_req", op: "protocol_ready" } },
    ];
    for (const [i, action] of actions.entries()) {
      const id = String(i + 1).repeat(16),
        text = "__terminal " + JSON.stringify(action);
      const r = await request(id, text);
      raw.push(r.body);
      expect([200, 409], r.body).toContain(r.status);
      raw.push((await request(id, text, true)).body);
    }
    const prompt = await postJson(
      h.ports[0]!,
      "/api/cmd",
      {
        agentKey: h.agentKey,
        id: "p".repeat(16),
        op: "prompt",
        text: "/webhub __terminal " + JSON.stringify({ v: 1, action: "negotiate", requestNonce: "prompt-nonce" }),
        deliver: "steer",
      },
      { Cookie: h.cookies[0]!, Origin: `http://127.0.0.1:${h.ports[0]}` },
    );
    raw.push(prompt.body);
    expect(prompt.body).toContain("E_COMMAND_DENIED");
    // A malicious late completion cannot bypass the agent's before-ledger boundary either.
    const original = a.incoming[0]!;
    a.handler.handleBridgeLate(original, {
      ok: true,
      data: {
        op: "command",
        kind: "builtin",
        completion: "sync",
        history: "none",
        terminal: { grant: secret, inventory },
      } as never,
    });
    await h.barrier();
    for (const s of streams) await s.waitFor((e) => e.event === "cmd_late");
    raw.push((await request("a".repeat(16), args, true)).body);
    const entries = mapSpy.mock.calls
      .map((c) => c[1])
      .filter(
        (v): v is { result: unknown; waiters: unknown[] } =>
          !!v && typeof v === "object" && "waiters" in v && "result" in v,
      );
    expect(entries.length).toBeGreaterThan(0);
    const all = JSON.stringify({
      raw,
      entries: entries.map((e) => ({ result: e.result, waiters: e.waiters })),
      cmdReplies: a.cmdReplies,
      ledger: a.ledger.query(original.id),
      bus: h.bus,
      streams: streams.map((s) => s.events),
      logs: h.log.lines,
    });
    for (const m of [secret, inventory, "writerLease", "agentChallenge", "connectionToken"])
      expect(all).not.toContain(m);
    expect(a.incoming.every((f) => f.origin.listener === "loopback" && f.origin.ip === "127.0.0.1")).toBe(true);
    expect(a.dedicated).toEqual([]);
    expect(a.mint).toHaveBeenCalledTimes(0);
    expect(a.readInventory).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(fork).toHaveBeenCalledTimes(0);
    expect(execFile).toHaveBeenCalledTimes(0);
    expect(spawnSync).toHaveBeenCalledTimes(0);
    expect(a.builtin).toHaveBeenCalledTimes(0);
    // Legacy HTTP command positive control: this chain really executes ordinary commands.
    const r = await postJson(
      h.ports[0]!,
      "/api/cmd",
      { agentKey: h.agentKey, id: "z".repeat(16), op: "command", name: "webhub", args: "status" },
      { Cookie: h.cookies[0]!, Origin: `http://127.0.0.1:${h.ports[0]}` },
    );
    expect(r.status).toBe(200);
    expect(a.builtin).toHaveBeenCalledTimes(1);
    const snapshot = {
      baseline: "2d802f1f HTTP/router/ingress + new agent ordinary command",
      normalization: ["HTTP Date"],
      status: r.status,
      headers: { ...r.headers, date: "<DATE>" },
      body: r.body,
    };
    const fixture = new URL("../web-hub/terminal-legacy/http.json", import.meta.url);
    if (process.env.P1C_CAPTURE_LEGACY_HTTP === "1") {
      if (existsSync(fixture)) throw new Error("refuse to overwrite HTTP baseline");
      writeFileSync(fixture, JSON.stringify(snapshot, null, 2) + "\n");
    }
    expect(snapshot).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
  });
  it("new/new dedicated prepare/challenge/ready/grant/bind positive control; replay/cmd-spoof cannot mint", async () => {
    let h: TerminalHarness;
    const privateFrames: TermRes[] = [];
    const ingress = createTerminalCommandIngress({
      current: (m) => m.linkGen === h.registry.getLinkGen(h.agentKey),
      onOffer: (_meta, _id, o) => {
        if (o)
          h.registry.send(h.agentKey, {
            t: "term_req",
            v: 1,
            rid: "prepare",
            sessionId: "session",
            epoch: "epoch-1",
            op: "prepare_protocol",
            offerId: o.offerId,
            hubNonce: "private-hub-nonce",
          });
      },
      onDedicated: (_meta, raw) => {
        const f = raw as TermRes;
        privateFrames.push(f);
        if (f.op === "protocol_challenge" && f.ok)
          h.registry.send(h.agentKey, {
            t: "term_req",
            v: 1,
            rid: "ready",
            sessionId: f.sessionId,
            epoch: f.epoch,
            ownerInstance: f.ownerInstance,
            op: "protocol_ready",
            offerId: f.offerId,
            hubNonce: f.hubNonce,
            agentChallenge: f.agentChallenge,
          });
        else if (f.op === "protocol_ready" && f.ok && f.mode === "interactive")
          h.registry.send(h.agentKey, {
            t: "term_req",
            v: 1,
            rid: "bind",
            sessionId: f.sessionId,
            epoch: f.epoch,
            ownerInstance: f.ownerInstance,
            op: "bind",
            offerId: f.offerId,
            hubNonce: f.hubNonce,
            agentChallenge: f.agentChallenge,
            proposedChannelId: "bound-channel",
            grant: f.grant,
          });
      },
    });
    h = await terminalHarness({ terminal: ingress });
    lives.push(h);
    const a = agent(h);
    const meta = {
      agentKey: h.agentKey,
      linkGen: h.registry.getLinkGen(h.agentKey)!,
      sessionId: "session",
      epoch: "epoch-1",
    };
    expect(ingress.register(meta, { rid: "internal", commandId: "i".repeat(16) })).toBe(true);
    const request: TerminalNegotiation = { v: 1, action: "negotiate", requestNonce: "nonce" };
    expect(a.mint).toHaveBeenCalledTimes(0);
    h.registry.send(h.agentKey, {
      t: "cmd",
      rid: "internal",
      id: "i".repeat(16),
      deadlineMs: 3000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16) },
      cmd: { op: "command", name: "webhub", args: "__terminal " + JSON.stringify(request) },
    });
    await waitFor(() => privateFrames.some((f) => f.op === "bind" && f.ok));
    await h.barrier();
    expect(privateFrames.map((f) => f.op)).toEqual(["protocol_challenge", "protocol_ready", "bind"]);
    expect(a.mint).toHaveBeenCalledTimes(1);
    expect(a.readInventory).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(a.cmdReplies)).not.toContain(secret);
    expect(JSON.stringify(h.bus)).not.toContain(secret);
    expect(JSON.stringify(privateFrames)).toContain(secret);
    const proof = privateFrames[0]!;
    if (proof.op !== "protocol_challenge" || !proof.ok) throw new Error("missing challenge");
    const ready = {
      t: "term_req",
      v: 1,
      rid: "again",
      sessionId: proof.sessionId,
      epoch: proof.epoch,
      ownerInstance: proof.ownerInstance,
      op: "protocol_ready",
      offerId: proof.offerId,
      hubNonce: proof.hubNonce,
      agentChallenge: proof.agentChallenge,
    };
    h.registry.send(h.agentKey, ready as never);
    await h.barrier();
    expect(a.mint).toHaveBeenCalledTimes(1);
    expect(privateFrames).toHaveLength(3);
    expect(ingress.register(meta, { rid: "resource", commandId: "r".repeat(16) })).toBe(true);
    h.registry.send(h.agentKey, {
      t: "cmd",
      rid: "resource",
      id: "r".repeat(16),
      deadlineMs: 3000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "q".repeat(16) },
      cmd: {
        op: "command",
        name: "webhub",
        args: "__terminal " + JSON.stringify({ v: 1, action: "resource_inventory", requestNonce: "resource-nonce" }),
      },
    });
    await waitFor(() => a.readInventory.mock.calls.length === 1);
    await h.barrier();
    expect(a.mint).toHaveBeenCalledTimes(1);
    const resourceReady = privateFrames.find((f) => f.op === "protocol_ready" && f.ok && f.mode === "resource-only");
    expect(resourceReady).toMatchObject({ op: "protocol_ready", mode: "resource-only", ok: true });
    expect(resourceReady).not.toHaveProperty("grant");
    expect(JSON.stringify(a.cmdReplies)).not.toContain(inventory);
  });
});
