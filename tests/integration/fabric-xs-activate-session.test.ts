import { createCommandHandler } from "../../src/web-hub/agent/commands.js";
import { createBuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createCommandRouter } from "../../src/web-hub/hub/commands.js";
import { createTokenTransport } from "../../src/web-hub/ui/src/transport/token.js";
import { createPasswordTransport } from "../../src/web-hub/ui/src/transport/password.js";
import type { CmdFrame } from "../../src/web-hub/protocol/messages.js";
/** P3 activation end to end (wake_session activation, NOT the tool-surface registration suite
 * `fabric-xs-activation.test.ts`): REAL hub router/relation bag/quota + REAL source & target
 * bridges + two REAL xs stacks + the REAL wake_session tool. Only the pi host is a deterministic
 * fake; no fake quota verdict, no fake claim. Proves: activation of an already-delivered body
 * sends ONE fixed body-free marker (the body stays exactly once), is at-most-once, shares the
 * hub pair quota (2/h ⇒ refused pair_wake_rate, no marker), query never activates, started is a
 * no-op, and unknown is never `none`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { buildStackXs, type StackXs } from "../../src/fabric/xs/stack.js";
import { createXsSender } from "../../src/fabric/xs/sender.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import { createXsActivationPort } from "../../src/fabric/xs/session-activation.js";
import { XS_ACTIVATE_MARKER_CONTENT } from "../../src/fabric/root-wake.js";
import { createWakeSessionTool } from "../../src/tools/wake-session-tool.js";
import { createXsAgentBridge } from "../../src/web-hub/agent/xs.js";
import type { HubConnection } from "../../src/web-hub/agent/connection.js";
import type { XsReqFrame } from "../../src/web-hub/protocol/xs.js";
import { rig } from "../web-hub/hub/xs-fixtures.js";

const A = "sess-aaaaaaaaaaaa",
  B = "sess-bbbbbbbbbbbb";
const CAPS = ["cmd.v1", "command.v1", "ev.v1", "xs.v1", "xs.reply.v1", "xs.state.v1", "xs.activate.v1"];
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  for (const name of [
    "xs-wake-ledger",
    "xs-host-cap",
    "xs-reply-ledger",
    "xs-progress",
    "xs-unread",
    "xs-activation-park",
  ])
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(`pi-subagent:${name}`)];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
  vi.useRealTimers();
});

function makeStack(sid: string) {
  const branch: Array<Record<string, unknown>> = [];
  const messages: Array<{ message: Record<string, unknown>; triggerTurn: boolean }> = [];
  let idle = true;
  let xs: StackXs;
  const level = createCausalLevel({ maxLevel: 3, initialRoot: 0, runLevel: () => 0, raiseRun() {}, persistRoot() {} });
  const pi = {
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (raw: Record<string, unknown>, options: { triggerTurn: boolean }) => {
      messages.push({ message: raw, triggerTurn: options.triggerTurn });
      branch.push({ type: "custom_message", id: `entry${branch.length}`, ...raw });
      if (options.triggerTurn) {
        idle = false;
        xs.beforeAgentStart({ messageType: "custom", message: { role: "custom", ...raw } });
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getSessionId: () => sid,
      getBranch: () => branch,
      getLeafEntry: () => branch.at(-1) ?? null,
      getEntries: () => branch,
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort() {
      idle = true;
    },
  } as unknown as ExtensionContext;
  const settings = {
    ...DEFAULT_SETTINGS,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      crossSession: {
        ...DEFAULT_SETTINGS.fabric.crossSession,
        enabled: true,
        autoJoin: true,
        channels: { ...DEFAULT_SETTINGS.fabric.crossSession.channels, enabled: false },
        alias: { ...DEFAULT_SETTINGS.fabric.crossSession.alias, enabled: false },
      },
    },
  };
  xs = buildStackXs(pi, ctx, settings, "startup", level, {});
  cleanup.push(() => xs.dispose());
  return {
    xs,
    messages,
    level,
    branch,
    settle: () => {
      idle = true;
      xs.settled();
    },
    /** the model-turn context: every xs custom message currently in the branch (what the model sees). */
    context: () => {
      xs.context({
        messages: branch
          .filter((e) => e.type === "custom_message")
          .map((e) => ({ role: "custom", customType: e.customType, content: e.content, details: e.details })),
      });
    },
  };
}

function build() {
  const source = makeStack(A),
    target = makeStack(B);
  const r = rig(600, undefined, true);
  r.clock.t = Date.now();
  cleanup.push(() => r.relay.dispose());
  const limits = { pairMinIntervalMs: 0, wakesOutPerHour: 20 };
  const a = r.agent({ pid: 1, sessionId: A, caps: CAPS, epoch: source.xs.membership.epoch, limits });
  const b = r.agent({ pid: 2, sessionId: B, caps: CAPS, epoch: target.xs.membership.epoch });
  const requests: XsReqFrame[] = [];
  const port = (stack: StackXs) => ({
    stack: () => stack,
    memberLimits: () => DEFAULT_SETTINGS.fabric.crossSession.limits,
    hubSendsPerMin: () => 600,
    replyEnabled: () => true,
    activationEnabled: () => true,
    activateEnabled: () => true,
  });
  const srcConn = {
    caps: CAPS,
    status: () => ({ state: "live", attached: true }),
    request: (frame: XsReqFrame) =>
      new Promise((resolve) => {
        requests.push(frame);
        r.relay.router.handle(a.key, frame, resolve);
      }),
  } as unknown as HubConnection;
  const sourceBridge = createXsAgentBridge({ conn: () => srcConn, port: port(source.xs) });
  const tgtConn = {
    caps: CAPS,
    status: () => ({ state: "live", attached: true }),
    send: (frame: { t: string }) => {
      if (frame.t === "xs_ack") r.registry.onFrame(b.key, frame as never);
      else r.relay.router.onAgentFrame(b.key, frame as never);
    },
    request: async () => {
      throw new Error("target never requests");
    },
  } as unknown as HubConnection;
  const targetBridge = createXsAgentBridge({ conn: () => tgtConn, port: port(target.xs) });
  const aSend = a.conn.send;
  a.conn.send = (frame) => {
    aSend(frame);
    if (frame.t === "xs_state") sourceBridge.onState(frame);
  };
  const bSend = b.conn.send;
  b.conn.send = (frame) => {
    bSend(frame);
    if (frame.t === "xs_deliver") targetBridge.onDeliver(frame);
    if (frame.t === "xs_activate") targetBridge.onActivate(frame);
  };
  const sender = createXsSender({
    port: sourceBridge.hubPort(),
    origin: { current: () => ({ sessionId: A, epoch: source.xs.membership.epoch }) },
    activation: true,
    wakeOn: true,
    level: { levelOfRoot: () => source.level.root, hopAllowed: (level) => source.level.hopAllowed(level) },
  });
  const wake = createWakeSessionTool({
    port: createXsActivationPort({
      hub: () => sourceBridge.hubPort(),
      origin: { current: () => ({ sessionId: A, epoch: source.xs.membership.epoch }) },
      level: { levelOfRoot: () => source.level.root },
    }),
  });
  const call = async (params: Record<string, unknown>) => {
    const out = await wake.execute("tc", params as never, undefined as never, undefined as never, undefined as never);
    return out.details as Record<string, unknown>;
  };
  const send = async (text: string, w?: boolean) => {
    const out = await sender.message({ to: B, text, ...(w === undefined ? {} : { wake: w }) });
    await vi.advanceTimersByTimeAsync(0);
    return out;
  };
  return { source, target, r, requests, send, call, sourceBridge, a };
}

const markers = (h: ReturnType<typeof build>) =>
  h.target.messages.filter((m) => (m.message.details as { activateFor?: string } | undefined)?.activateFor);
const bodies = (h: ReturnType<typeof build>) =>
  h.target.messages.filter(
    (m) => m.message.customType === "subagent:xs" && !(m.message.details as { activateFor?: string }).activateFor,
  );

describe("P3 wake_session activation — real hub + bridges + stacks", () => {
  it("activates a delivered, unstarted body ONCE: fixed marker, body stays single, repeat is a dup no-op", async () => {
    const h = build();
    const sent = await h.send("please do the thing");
    expect(sent.track?.messageId).toMatch(/^x/);
    expect(bodies(h)).toHaveLength(1);
    expect(h.target.messages.filter((m) => m.triggerTurn)).toHaveLength(0); // deliver-only
    const { messageId, activationKey } = sent.track!;
    const args = { to: B, messageId, activationKey: activationKey! };
    const out = await h.call(args);
    expect(out).toMatchObject({ status: "accepted", messageId, activationKey });
    expect(markers(h)).toHaveLength(1);
    const marker = markers(h)[0]!;
    expect(marker.triggerTurn).toBe(true);
    expect(marker.message.content).toBe(XS_ACTIVATE_MARKER_CONTENT);
    expect(JSON.stringify(marker.message)).not.toContain("please do the thing");
    expect(bodies(h)).toHaveLength(1); // the body was NOT redelivered
    // unread/inbox did not count the marker as a body
    expect(h.target.xs.unread?.()).toBe(1);
    const again = await h.call(args);
    expect(again).toMatchObject({ status: "already_active", effect: "none", dup: true });
    expect(markers(h)).toHaveLength(1);
    // the tool never takes text and never sent a send op for the activation
    expect(h.requests.filter((f) => f.op === "send")).toHaveLength(1);
    expect(h.requests.filter((f) => f.op === "activate")).toHaveLength(2);
    expect(h.requests.filter((f) => f.op === "activate").every((f) => f.text === undefined)).toBe(true);
  });

  it("query never activates and reports the known phase; a miss is a result, not an execution", async () => {
    const h = build();
    const sent = await h.send("body");
    const q = await h.call({
      to: B,
      messageId: sent.track!.messageId,
      activationKey: sent.track!.activationKey,
      action: "query",
    });
    expect(q).toMatchObject({ status: "known", progress: { messageId: sent.track!.messageId, phase: "delivered" } });
    const miss = await h.call({ to: B, messageId: "x-unknown", activationKey: "k", action: "query" });
    expect(miss).toMatchObject({ status: "unavailable" });
    expect(h.requests.filter((f) => f.op === "activate")).toHaveLength(0);
    expect(markers(h)).toHaveLength(0);
  });

  it("started is a none no-op: once the model saw the body, activation sends nothing", async () => {
    const h = build();
    const sent = await h.send("body");
    h.target.context(); // the model-turn context includes the original xid ⇒ started
    await vi.advanceTimersByTimeAsync(0);
    const out = await h.call({ to: B, messageId: sent.track!.messageId, activationKey: sent.track!.activationKey });
    expect(out).toMatchObject({ status: "already_started", effect: "none" });
    expect(markers(h)).toHaveLength(0);
  });

  it("#14: pair wake window full ⇒ refused pair_wake_rate with retryAfterAt; NO marker, NO new wake charge, NO body resend", async () => {
    const h = build();
    const t0 = h.r.clock.t;
    await h.send("w1", true);
    h.target.settle();
    h.r.clock.t += 60_000;
    await h.send("w2", true);
    h.target.settle();
    h.r.clock.t += 60_000;
    const third = await h.send("quiet");
    const wakesBefore = h.target.messages.filter((m) => m.triggerTurn).length;
    const out = await h.call({ to: B, messageId: third.track!.messageId, activationKey: third.track!.activationKey });
    expect(out).toMatchObject({
      status: "refused",
      effect: "none",
      wakeDowngraded: "pair_wake_rate",
      retryable: true,
      retryAfterAt: t0 + 3_600_000,
    });
    expect(h.target.messages.filter((m) => m.triggerTurn)).toHaveLength(wakesBefore);
    expect(markers(h)).toHaveLength(0);
    expect(bodies(h)).toHaveLength(3);
  });

  it("a receiver handler failure before any claim is a proven none (receiver_error), never a marker or a body resend", async () => {
    const h = build();
    const sent = await h.send("body");
    const original = h.target.xs.activation!.handle;
    h.target.xs.activation!.handle = () => {
      throw new Error("handler exploded");
    };
    const out = await h.call({ to: B, messageId: sent.track!.messageId, activationKey: sent.track!.activationKey });
    h.target.xs.activation!.handle = original;
    expect(out).toMatchObject({ status: "refused", effect: "none", reason: "receiver_error" });
    expect(markers(h)).toHaveLength(0);
    expect(bodies(h)).toHaveLength(1);
    // the none attempt refunded its wake reservation: after the 30s attempt spacing the SAME key works
    h.r.clock.t += 31_000;
    const retry = await h.call({ to: B, messageId: sent.track!.messageId, activationKey: sent.track!.activationKey });
    expect(retry).toMatchObject({ status: "accepted" });
    expect(markers(h)).toHaveLength(1);
  });
});

describe.each(["token", "password"] as const)(
  "P3b %s browser adapter → existing command router → host activation → real xs relay",
  (mode) => {
    it("query is pure; manual activate uses the original relation/key once, quota is server-checked", async () => {
      const h = build();
      const gate = createCommandRouter({ registry: h.r.registry, log: h.r.log, now: () => Date.now() });
      const port = createXsActivationPort({
        hub: () => h.sourceBridge.hubPort(),
        origin: { current: () => ({ sessionId: A, epoch: h.source.xs.membership.epoch }) },
        level: { levelOfRoot: () => h.source.level.root },
      });
      const native = vi.fn();
      const pi = {
        getCommands: () => [{ name: "fabric", source: "extension" }],
        sendUserMessage: native,
      } as unknown as ExtensionAPI;
      const ctx = { isIdle: () => true } as ExtensionContext;
      const bridge = createBuiltinBridge({ pi, getCtx: () => ctx, getSessionId: () => A, xsActivation: () => port });
      const handler = createCommandHandler({
        pi,
        getCtx: () => ctx,
        getSessionId: () => A,
        ledger: createCommandLedger(),
        queueMirror: createQueueMirror(),
        compactionState: { manualCompacting: false, dispose() {} },
        originEntry: { appendOrigin() {}, notify: native, dispose() {} } as never,
        builtinBridge: bridge,
        controlEnabled: () => true,
        now: Date.now,
        onChanged() {},
        send: (frame) => h.r.registry.onFrame(h.a.key, frame),
        setTimer: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          timer.unref();
          return { cancel: () => clearTimeout(timer) };
        },
      });
      cleanup.push(() => handler.dispose());
      const oldSend = h.a.conn.send;
      h.a.conn.send = (frame) => {
        oldSend(frame);
        if (frame.t === "cmd") handler.handle(frame);
      };
      let cmdSeq = 0;
      const posts: unknown[] = [];
      // HTTP auth admission is controlled here; the existing real command gateway
      // stamps origin, checks command caps and idempotency before forwarding.
      const fetch = async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        expect(url).toBe("/api/cmd");
        expect(init?.headers?.["X-PWH"]).toBe("1");
        const body = JSON.parse(init!.body!);
        posts.push(body);
        const cmd: CmdFrame = {
          t: "cmd",
          rid: `web-${++cmdSeq}`,
          id: body.id,
          deadlineMs: 12_000,
          origin: {
            listener: mode === "token" ? "loopback" : "lan",
            ip: "127.0.0.1",
            reqId: "http-admitted",
            ...(mode === "password" ? { user: "logged-in-user" } : {}),
          },
          cmd: { op: "command", name: body.name, args: body.args, expect: body.expect },
        };
        const result = await gate.request(cmd, h.a.key);
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => result };
      };
      const deps = {
        fetch,
        EventSource: class {},
        location: { hash: "", pathname: "/", search: "" },
        history: { replaceState() {} },
        storage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout,
        clearTimeout,
        now: Date.now,
        onMessage() {},
        onConn() {},
        onAuthEvent() {},
        onUnauthenticated() {},
        onSessionInfo() {},
        onLoginRetry() {},
      };
      const transport = mode === "token" ? createTokenTransport(deps as never) : createPasswordTransport(deps as never);
      const sent = await h.send("original browser body");
      const request = {
        agentKey: h.a.key,
        messageId: sent.track!.messageId,
        activationKey: sent.track!.activationKey!,
        expect: { sessionId: A },
      };
      const query = await transport.xsActivate!({ ...request, id: "q".repeat(16), action: "query" });
      expect(query).toMatchObject({
        ok: true,
        data: { xsActivation: { status: "known", progress: { phase: "delivered" } } },
      });
      expect(markers(h)).toHaveLength(0);
      const [first, duplicate] = await Promise.all([
        transport.xsActivate!({ ...request, id: "a".repeat(16), action: "activate" }),
        transport.xsActivate!({ ...request, id: "b".repeat(16), action: "activate" }),
      ]);
      expect(first).toMatchObject({ ok: true, data: { xsActivation: { status: "accepted" } } });
      expect(duplicate).toMatchObject({ ok: true, data: { xsActivation: { status: "already_active" } } });
      expect(markers(h)).toHaveLength(1);
      expect(bodies(h)).toHaveLength(1);
      expect(
        h.requests.filter((f) => f.op === "activate").every((f) => f.to === undefined && f.text === undefined),
      ).toBe(true);
      const wrong = await transport.xsActivate!({
        ...request,
        activationKey: "forged-key",
        id: "c".repeat(16),
        action: "activate",
      });
      expect(wrong).toMatchObject({ ok: true, data: { xsActivation: { status: "refused", reason: "stale_key" } } });
      expect(markers(h)).toHaveLength(1);
      expect(posts).toHaveLength(4);
      expect(native).not.toHaveBeenCalled();
      h.target.context();
      h.target.settle();
      h.r.clock.t += 60_000;
      const secondBody = await h.send("fresh second quota probe");
      const second = await transport.xsActivate!({
        ...request,
        messageId: secondBody.track!.messageId,
        activationKey: secondBody.track!.activationKey!,
        id: "d".repeat(16),
        action: "activate",
      });
      expect(second).toMatchObject({ ok: true, data: { xsActivation: { status: "accepted" } } });
      h.target.context();
      h.target.settle();
      h.r.clock.t += 60_000;
      const thirdBody = await h.send("fresh third quota probe");
      const limited = await transport.xsActivate!({
        ...request,
        messageId: thirdBody.track!.messageId,
        activationKey: thirdBody.track!.activationKey!,
        id: "e".repeat(16),
        action: "activate",
      });
      expect(limited).toMatchObject({
        ok: true,
        data: { xsActivation: { status: "refused", wakeDowngraded: "pair_wake_rate", retryAfterAt: 4_600_000 } },
      });
      expect(markers(h)).toHaveLength(2);
      expect(bodies(h)).toHaveLength(3); // three NEW bodies, never a resend
      expect(h.requests.filter((f) => f.op === "send")).toHaveLength(3);
    });
  },
);
