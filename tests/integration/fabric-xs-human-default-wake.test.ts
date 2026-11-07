/** P2b default wake: REAL router + source bridge/sender + two REAL xs stacks.
 * Only the pi host is a deterministic fake; no fake sender or fake quota verdict.
 * Complements fabric-xs-activation.test.ts (tool-surface registration, not activation/wake).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { buildStackXs, type StackXs } from "../../src/fabric/xs/stack.js";
import { createXsSender } from "../../src/fabric/xs/sender.js";
import { createHumanGrantHost, createHumanGrantPort } from "../../src/fabric/xs/human-grant.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import { createXsAgentBridge } from "../../src/web-hub/agent/xs.js";
import type { HubConnection } from "../../src/web-hub/agent/connection.js";
import type { XsDeliverFrame, XsReqFrame } from "../../src/web-hub/protocol/xs.js";
import { createMessageSessionTool, XS_IDLE_NO_WAKE_HINT } from "../../src/tools/message-session-tool.js";
import { rig } from "../web-hub/hub/xs-fixtures.js";

const A = "sess-aaaaaaaaaaaa",
  B = "sess-bbbbbbbbbbbb",
  C = "sess-cccccccccccc";
const OLD = ["ev.v1", "xs.v1", "xs.reply.v1"];
const NEW = [...OLD, "xs.state.v1"];
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  for (const name of ["xs-wake-ledger", "xs-host-cap", "xs-reply-ledger", "xs-progress", "xs-unread"])
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(`pi-subagent:${name}`)];
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
    settle: () => {
      idle = true;
      xs.settled();
    },
  };
}

function build(
  options: { targetState?: boolean; hubState?: boolean; clonedContext?: boolean; secondTarget?: boolean } = {},
) {
  const source = makeStack(A),
    target = makeStack(B);
  const target2 = options.secondTarget ? makeStack(C) : undefined;
  const r = rig(60, undefined, options.hubState === false ? undefined : true);
  r.clock.t = Date.now();
  cleanup.push(() => r.relay.dispose());
  const a = r.agent({ pid: 1, sessionId: A, caps: NEW, epoch: source.xs.membership.epoch });
  const b = r.agent({
    pid: 2,
    sessionId: B,
    caps: options.targetState === false ? OLD : NEW,
    epoch: target.xs.membership.epoch,
  });
  const c = target2 ? r.agent({ pid: 3, sessionId: C, caps: NEW, epoch: target2.xs.membership.epoch }) : undefined;
  const requests: XsReqFrame[] = [],
    deliveries: XsDeliverFrame[] = [];
  const conn = {
    caps: options.hubState === false ? OLD : NEW,
    status: () => ({ state: "live", attached: true }),
    request: (frame: XsReqFrame) =>
      new Promise((resolve) => {
        requests.push(frame);
        r.relay.router.handle(a.key, frame, resolve);
      }),
  } as unknown as HubConnection;
  const bridge = createXsAgentBridge({
    conn: () => conn,
    port: {
      stack: () => source.xs,
      memberLimits: () => DEFAULT_SETTINGS.fabric.crossSession.limits,
      hubSendsPerMin: () => 60,
      replyEnabled: () => true,
      activationEnabled: () => true,
    },
  });
  const originalSourceSend = a.conn.send;
  a.conn.send = (frame) => {
    originalSourceSend(frame);
    if (frame.t === "xs_state") bridge.onState(frame);
  };
  for (const [peer, stack] of [[b, target], ...(c && target2 ? [[c, target2] as const] : [])] as const) {
    const originalTargetSend = peer.conn.send;
    peer.conn.send = (frame) => {
      originalTargetSend(frame);
      if (frame.t !== "xs_deliver") return;
      deliveries.push(frame);
      const verdict = stack.xs.deliver(frame);
      r.registry.onFrame(peer.key, {
        t: "xs_ack",
        rid: frame.rid,
        xid: frame.xid,
        effect: verdict.effect,
        woke: verdict.woke,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.wakeDowngraded ? { wakeDowngraded: verdict.wakeDowngraded } : {}),
      });
    };
    cleanup.push(
      stack.xs.progress!.subscribe((progress) => r.relay.router.onAgentFrame(peer.key, { t: "xs_state", ...progress })),
    );
  }
  const grants = createHumanGrantPort(),
    host = createHumanGrantHost(grants, "root-host");
  const user = { role: "user", content: "Please ask the other session and get a reply." };
  host.input({ source: "rpc", text: user.content }, A);
  host.message(user, A);
  host.context({ messages: [options.clonedContext ? { ...user } : user] }, A);
  host.toolCall("c1", "message_session", A);
  host.toolCall("c2", "message_session", A);
  const sender = createXsSender({
    port: bridge.hubPort(),
    origin: { current: () => ({ sessionId: A, epoch: source.xs.membership.epoch }) },
    activation: true,
    humanGrants: grants,
    wakeOn: true,
    level: { levelOfRoot: () => source.level.root, hopAllowed: (level) => source.level.hopAllowed(level) },
    reply: {
      ledger: source.xs.reply!.ledger,
      defaultTimeoutS: 1800,
      maxTimeoutS: 86400,
      lateGraceS: 600,
      maxPending: 8,
      maxPendingPerTarget: 3,
      receivable: (sid) => source.xs.reply!.receivable(sid),
      inbound: () => undefined,
    },
  });
  const tool = createMessageSessionTool({
    sender,
    reply: true,
    activation: true,
    idleWakeAdvice: true,
    invocation: (id) => host.invocation(id, "message_session"),
  });
  return {
    tool,
    source,
    target,
    sender,
    requests,
    deliveries,
    message: (id: string, wake?: boolean) =>
      sender.message({
        to: B,
        text: `body-${id}`,
        expectReply: {},
        invocation: host.invocation(id, "message_session")!,
        ...(wake === undefined ? {} : { wake }),
      }),
    advance: async () => {
      r.clock.t += 6_000;
      await vi.advanceTimersByTimeAsync(6_000);
      target.settle();
    },
  };
}

describe("P2b host human delegation default wake integration", () => {
  it("verified omitted wake starts one dispatch; a second call shares the consumed grant and delivers only", async () => {
    const h = build();
    const first = await h.message("c1");
    expect(first).toMatchObject({
      effect: "applied",
      wake: { requested: true, defaulted: true, decision: "dispatch_accepted" },
    });
    expect(first.track?.messageId).toMatch(/^x/);
    expect(first.track?.activationKey).toMatch(/^k/);
    expect(h.deliveries[0]!.wake).toBe(true);
    expect(h.target.messages.filter((m) => m.triggerTurn)).toHaveLength(1);
    await h.advance();
    const second = await h.message("c2");
    expect(second.wake?.requested).toBe(false);
    expect(second.wake?.defaulted).toBeUndefined();
    expect(h.deliveries[1]!.wake).toBe(false);
    expect(h.target.messages.filter((m) => m.message.customType === "subagent:xs")).toHaveLength(2);
    expect(h.requests.filter((f) => f.op === "send")).toHaveLength(2); // once per DISTINCT body, never a retry
  });
  it("#20 human grant upgrade has no hint; next call on same input to idle target has hint", async () => {
    const h = build();
    const first = await h.tool.execute("c1", { to: B, text: "human-first", expectReply: {} });
    expect(first.details).toMatchObject({ wake: { requested: true, defaulted: true } });
    expect(first.content[0]).not.toMatchObject({ text: expect.stringContaining(XS_IDLE_NO_WAKE_HINT) });
    await h.advance();
    const second = await h.tool.execute("c2", { to: B, text: "human-second", expectReply: {} });
    expect(second.details).toMatchObject({ effect: "applied", wake: { requested: false } });
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining(XS_IDLE_NO_WAKE_HINT) });
  });
  it("#20 parallel targets on one human input: one upgrade has no hint, second idle deliver-only has hint", async () => {
    const h = build({ secondTarget: true });
    const results = await Promise.all([
      h.tool.execute("c1", { to: B, text: "parallel-B", expectReply: {} }),
      h.tool.execute("c2", { to: C, text: "parallel-C", expectReply: {} }),
    ]);
    expect(results.map((result) => (result.details as { effect: string }).effect)).toEqual(["applied", "applied"]);
    expect(results.map((result) => (result.details as { wake: { requested: boolean } }).wake.requested)).toEqual([
      true,
      false,
    ]);
    expect(
      results.map((result) => (result.content[0] as { text: string }).text.includes(XS_IDLE_NO_WAKE_HINT)),
    ).toEqual([false, true]);
    expect(h.deliveries).toHaveLength(2);
  });
  it.each([{ targetState: false }, { hubState: false }, { clonedContext: true }])(
    "missing proof fails closed: %j",
    async (options) => {
      const h = build(options);
      const out = await h.message("c1");
      expect(out.wake?.defaulted).toBeUndefined();
      expect(h.deliveries[0]!.wake).toBe(false);
      expect(h.target.messages.filter((m) => m.triggerTurn)).toHaveLength(0);
      if (options.targetState === false || options.hubState === false) expect(out.track).toBeUndefined();
    },
  );
  it("explicit false preserves the grant for the next eligible omitted-wake call", async () => {
    const h = build();
    await h.message("c1", false);
    expect(h.deliveries[0]!.wake).toBe(false);
    await h.advance();
    const out = await h.message("c2");
    expect(out.wake?.defaulted).toBe(true);
    expect(h.deliveries[1]!.wake).toBe(true);
    expect(h.target.messages.filter((m) => m.triggerTurn)).toHaveLength(1);
  });
});
