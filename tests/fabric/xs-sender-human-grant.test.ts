import { describe, expect, it, vi } from "vitest";
import { createHumanGrantPort, type InvocationRef } from "../../src/fabric/xs/human-grant.js";
import { createXsSender, type XsHubPort, type XsPortReply, type XsPortSendArgs } from "../../src/fabric/xs/sender.js";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import { mapMentionSendOutcome } from "../../src/mention/wire.js";

const A = "sess-aaaaaaaaaaaa",
  B = "sess-bbbbbbbbbbbb";
const invocation = (id = "c1"): InvocationRef => ({
  sessionId: A,
  owner: "host",
  runKey: "run",
  contextSeq: 1,
  toolCallId: id,
  toolName: "message_session",
});
function harness(
  options: {
    granted?: boolean;
    state?: boolean;
    target?: boolean;
    activation?: boolean;
    wakeOn?: boolean;
    effect?: "none" | "unknown" | "applied";
    reason?: "pair_wake_rate";
    throwing?: boolean;
    transport?: "deadline" | "link_lost" | "off";
  } = {},
) {
  const grants = createHumanGrantPort();
  const ref = grants.issue({ inputId: "i", sessionId: A, owner: "host", issuedAt: Date.now(), via: "rpc" })!;
  grants.bindContext(ref, "run", 1);
  if (options.granted !== false) {
    grants.registerInvocation(invocation());
    grants.registerInvocation(invocation("c2"));
  }
  const calls: XsPortSendArgs[] = [];
  const result: XsPortReply = {
    kind: "res",
    res: {
      t: "xs_res",
      rid: "send",
      ok: true,
      effect: options.effect ?? "applied",
      ...(options.reason ? { wakeDowngraded: options.reason } : {}),
    },
    ...(options.state === false
      ? {}
      : {
          progress: {
            messageId: "original-xid",
            activationKey: "original-key",
            revision: 0,
            deliveryEffect: options.effect ?? "applied",
            observation: "live",
            wake: { requested: true, decision: "unknown" },
          },
        }),
  };
  const port: XsHubPort = {
    list: vi.fn(),
    stateCapable: () => options.state !== false,
    replyCapable: () => true,
    resolve: async () => ({
      kind: "res",
      targetState: options.target !== false,
      res: { t: "xs_res", rid: "resolve", ok: true, target: { ref: "bbbbbbbbbbbb", sessionId: B } },
    }),
    send: async (args) => {
      calls.push(args);
      if (args.wake === true && args.wakeView?.defaulted)
        expect(grants.reserve(ref, invocation("c2"), B)).toBeUndefined();
      if (options.throwing) throw new Error("after-side-effect");
      return options.transport
        ? { kind: options.transport, ...(result.progress ? { progress: result.progress } : {}) }
        : result;
    },
  };
  const ledger = new XsReplyLedger();
  const sender = createXsSender({
    port,
    origin: { current: () => ({ sessionId: A, epoch: 1 }) },
    activation: options.activation !== false,
    humanGrants: grants,
    wakeOn: options.wakeOn !== false,
    level: { levelOfRoot: () => 2, hopAllowed: () => true },
    reply: {
      ledger,
      defaultTimeoutS: 1800,
      maxTimeoutS: 86400,
      lateGraceS: 600,
      maxPending: 8,
      maxPendingPerTarget: 3,
      receivable: () => "ok",
      inbound: () => undefined,
    },
  });
  return { sender, calls, grants, ref };
}

describe("P2 human grant × expectReply × wake three-value matrix", () => {
  for (const granted of [false, true])
    for (const expectReply of [false, true])
      for (const wake of [undefined, false, true]) {
        it(`grant=${granted} expect=${expectReply} wake=${wake}`, async () => {
          const h = harness({ granted });
          const out = await h.sender.message({
            to: B,
            text: "one body",
            invocation: invocation(),
            ...(expectReply ? { expectReply: {} } : {}),
            ...(wake === undefined ? {} : { wake }),
          });
          const wants = wake === true || (wake === undefined && granted && expectReply);
          expect(h.calls).toHaveLength(1);
          expect(h.calls[0]!.wake === true).toBe(wants);
          expect(out.wake?.requested).toBe(wants);
          expect(out.wake?.defaulted === true).toBe(wake === undefined && granted && expectReply);
          expect(h.calls[0]!.level).toBe(2); // delegation does NOT reset causal level
        });
      }
  it("concurrent qualified delegations CAS once, even if both resolves complete together", async () => {
    const h = harness();
    await Promise.all(
      ["c1", "c2"].map((id) => h.sender.message({ to: B, text: id, expectReply: {}, invocation: invocation(id) })),
    );
    expect(h.calls).toHaveLength(2);
    expect(h.calls.filter((c) => c.wake === true)).toHaveLength(1);
  });
  it.each([{ state: false }, { target: false }, { activation: false }])(
    "missing negotiation preserves omitted wake: %j",
    async (options) => {
      const h = harness(options);
      const out = await h.sender.message({ to: B, text: "body", expectReply: {}, invocation: invocation() });
      expect(h.calls[0]!.wake).toBeUndefined();
      expect(out.wake?.defaulted).toBeUndefined();
      if (options.activation === false || options.state === false) expect(out.wake).toBeUndefined();
      expect(h.grants.reserve(h.ref, invocation(), B)).toBeDefined();
    },
  );
  it("replyTo excludes grant and explicit wake; ordinary agent default is deliver-only", async () => {
    const h = harness();
    const out = await h.sender.message({
      to: B,
      text: "reply",
      replyTo: "q123456789012345678",
      wake: true,
      invocation: invocation(),
    });
    expect(h.calls[0]!.wake).toBeUndefined();
    expect(h.calls[0]!.level).toBeUndefined();
    expect(out.wake?.defaulted).toBeUndefined();
    expect(h.grants.reserve(h.ref, invocation(), B)).toBeDefined();
  });
  it("remote none releases only exact call/target, unknown and after-send throw stay consumed", async () => {
    const none = harness({ effect: "none" });
    await none.sender.message({ to: B, text: "body", expectReply: {}, invocation: invocation() });
    expect(none.grants.reserve(none.ref, invocation("c2"), B)).toBeUndefined();
    expect(none.grants.reserve(none.ref, invocation(), B)).toBeDefined();
    for (const options of [{ effect: "unknown" as const }, { throwing: true }]) {
      const h = harness(options);
      const out = await h.sender.message({ to: B, text: "body", expectReply: {}, invocation: invocation() });
      expect(out.effect).toBe("unknown");
      expect(h.grants.reserve(h.ref, invocation(), B)).toBeUndefined();
    }
  });
  it("sender downgrade survives after-send throw and retains intended wake without started", async () => {
    const h = harness({ wakeOn: false, throwing: true });
    const out = await h.sender.message({ to: B, text: "body", wake: true });
    expect(out).toMatchObject({
      effect: "unknown",
      wakeDowngraded: "sender_wake_disabled",
      wake: { requested: true, stage: "sender", decision: "downgraded" },
    });
    expect(out.woke).toBeUndefined();
    expect(h.calls[0]!.wake).toBeUndefined();
  });
  it("messageId/key and pair_wake_rate survive JSON/hint/mention, no second body", async () => {
    const h = harness({ reason: "pair_wake_rate" });
    const tool = createMessageSessionTool({
      sender: h.sender,
      reply: true,
      activation: true,
      invocation: () => invocation(),
    });
    const result = await tool.execute(
      "c1",
      { to: B, text: "body", expectReply: {}, source: "human", grantId: "fake" } as never,
      undefined,
    );
    expect(result.details).toMatchObject({
      track: { messageId: "original-xid", activationKey: "original-key" },
      wakeDowngraded: "pair_wake_rate",
      wake: { stage: "hub" },
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("每会话对默认 2 次/小时") });
    expect(mapMentionSendOutcome(result.details as never, 8)).toMatchObject({
      track: { messageId: "original-xid", activationKey: "original-key" },
      wakeDowngraded: "pair_wake_rate",
    });
    expect(h.calls).toHaveLength(1);
  });
  it("model source/meta/grantId are ignored at execute; only captured call can claim", async () => {
    const h = harness();
    const tool = createMessageSessionTool({ sender: h.sender, reply: true, activation: true });
    await tool.execute(
      "fake",
      { to: B, text: "body", expectReply: {}, source: "human", grantId: h.ref.id, meta: { human: true } } as never,
      undefined,
    );
    expect(h.calls[0]!.wake).toBeUndefined();
    expect(h.grants.reserve(h.ref, invocation(), B)).toBeDefined();
  });
  it("legacy tool descriptions and schemas remain unchanged with activation off", () => {
    const h = harness({ activation: false });
    const old = createMessageSessionTool({ sender: h.sender, reply: true });
    const off = createMessageSessionTool({ sender: h.sender, reply: true, activation: false });
    expect(off.description).toBe(old.description);
    expect(off.parameters).toBe(old.parameters);
  });
});

describe("P2 tracked transport ambiguity", () => {
  it.each(["deadline", "link_lost", "off"] as const)(
    "%s keeps the original relation and consumes the grant",
    async (transport) => {
      const h = harness({ transport });
      const out = await h.sender.message({ to: B, text: "body", expectReply: {}, invocation: invocation() });
      expect(out).toMatchObject({
        effect: "unknown",
        track: { messageId: "original-xid", activationKey: "original-key" },
      });
      expect(out.progress?.phase).toBeUndefined(); // registration is not delivery or start evidence
      expect(h.calls).toHaveLength(1);
      expect(h.grants.reserve(h.ref, invocation(), B)).toBeUndefined();
    },
  );
  it("invalid address/oversize refuses before grant reservation or any send", async () => {
    const h = harness();
    expect(
      (await h.sender.message({ to: "root", text: "body", expectReply: {}, invocation: invocation() })).effect,
    ).toBe("none");
    expect(h.calls).toHaveLength(0);
    expect(h.grants.reserve(h.ref, invocation(), B)).toBeDefined();
  });
});
