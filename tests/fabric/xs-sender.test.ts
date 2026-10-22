import { describe, expect, it } from "vitest";
import {
  createXsSender,
  detectXsToolCollisions,
  XS_MAIN_TOOL_NAMES,
  type XsHubPort,
  type XsPortListArgs,
  type XsPortReply,
  type XsPortResolveArgs,
  type XsPortSendArgs,
  type XsSenderDeps,
  type XsSenderLevelPort,
} from "../../src/fabric/xs/sender.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

/**
 * fabric phase-2 X3 anchor (phase2-plan §11.2 + r3 M2): the sender core — origin guard at every
 * await, fail-fast resolve→send, effect mapping, level/wake pre-checks, client deadline. All
 * hub behaviour is a fake `XsHubPort` (X2 owns the real connection).
 */

interface Harness {
  sender: ReturnType<typeof createXsSender>;
  calls: { list: XsPortListArgs[]; resolve: XsPortResolveArgs[]; send: XsPortSendArgs[] };
  /** Flip identity like `/new` (new sessionId) or `/fabric leave`/stack rebuild (epoch bump). */
  setIdentity(id: { sessionId: string; epoch: number } | undefined): void;
  setResolve(impl: () => Promise<XsPortReply>): void;
  setSend(impl: () => Promise<XsPortReply>): void;
}

function res(partial: Partial<XsResFrame> & { ok: boolean }): XsPortReply {
  return { kind: "res", res: { t: "xs_res", rid: "r-test", ...partial } as XsResFrame };
}

function makeHarness(deps?: Partial<XsSenderDeps>): Harness {
  let identity: { sessionId: string; epoch: number } | undefined = { sessionId: "sess-SENDER0001", epoch: 7 };
  let resolveImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, target: { ref: "abcdefgh1234", name: "frontend rework" } });
  let sendImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, effect: "applied", target: { ref: "abcdefgh1234", name: "frontend rework" } });
  const calls: Harness["calls"] = { list: [], resolve: [], send: [] };
  const port: XsHubPort = {
    async list(args) {
      calls.list.push(args);
      return res({ ok: true, rows: [] });
    },
    async resolve(args) {
      calls.resolve.push(args);
      return resolveImpl();
    },
    async send(args) {
      calls.send.push(args);
      return sendImpl();
    },
  };
  const sender = createXsSender({
    port,
    origin: { current: () => identity },
    wakeOn: true,
    level: { levelOfRoot: () => 1, hopAllowed: () => true } satisfies XsSenderLevelPort,
    ...deps,
  });
  return {
    sender,
    calls,
    setIdentity: (id) => {
      identity = id;
    },
    setResolve: (impl) => {
      resolveImpl = impl;
    },
    setSend: (impl) => {
      sendImpl = impl;
    },
  };
}

describe("fabric xs sender — happy path", () => {
  it("resolve→send: carries the origin snapshot, omits wake/level when wake is off, keeps the original address", async () => {
    const h = makeHarness({ wakeOn: false, level: undefined, maxChars: 2000 });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out).toMatchObject({ status: "sent", effect: "applied" });
    expect(out.to).toEqual({ ref: "abcdefgh1234", name: "frontend rework" });
    expect(h.calls.resolve).toHaveLength(1);
    expect(h.calls.resolve[0]).toMatchObject({
      origin: { sessionId: "sess-SENDER0001", epoch: 7 },
      query: "abcdefgh1234",
    });
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.send[0]).toMatchObject({
      origin: { sessionId: "sess-SENDER0001", epoch: 7 },
      to: "abcdefgh1234",
      text: "hello",
    });
    expect(h.calls.send[0]!.wake).toBeUndefined();
    expect(h.calls.send[0]!.level).toBeUndefined();
  });

  it("omitted wake stays false — no wake field in the frame even with wake enabled", async () => {
    const h = makeHarness();
    await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(h.calls.send[0]!.wake).toBeUndefined();
  });

  it("truncates the body to fabric.maxChars (75/25) and flags it", async () => {
    const h = makeHarness({ maxChars: 100 });
    const text = "y".repeat(300);
    const out = await h.sender.message({ to: "abcdefgh1234", text });
    expect(h.calls.send[0]!.text.length).toBe(100);
    expect(h.calls.send[0]!.text.startsWith("y")).toBe(true);
    expect(out.truncated).toBe(true);
  });
});

describe("fabric xs sender — r3 M2 origin guard", () => {
  it("resolve 往返期间 `/new` ⇒ none{origin_changed} 且不发 send 帧", async () => {
    const h = makeHarness();
    h.setResolve(async () => {
      h.setIdentity({ sessionId: "sess-NEW00000001", epoch: 1 }); // /new during the round trip
      return res({ ok: true, target: { ref: "abcdefgh1234" } });
    });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none", reason: "origin_changed" });
    expect(h.calls.resolve).toHaveLength(1);
    expect(h.calls.send).toHaveLength(0);
  });

  it("leave 在途（epoch bump）发生在 send 之前 ⇒ none 且不发 send 帧", async () => {
    const h = makeHarness();
    h.setResolve(async () => {
      h.setIdentity({ sessionId: "sess-SENDER0001", epoch: 8 }); // leave bumps epoch only
      return res({ ok: true, target: { ref: "abcdefgh1234" } });
    });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
  });

  it("接收成功后、响应返回前发送方切换会话 ⇒ 保留远端结果 applied，不是 none", async () => {
    const h = makeHarness();
    h.setSend(async () => {
      h.setIdentity({ sessionId: "sess-NEW00000001", epoch: 1 }); // switch AFTER the frame left
      return res({ ok: true, effect: "applied", target: { ref: "abcdefgh1234" } });
    });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out.effect).not.toBe("none");
    expect(out).toMatchObject({ status: "sent", effect: "applied" });
    expect(h.calls.send).toHaveLength(1);
  });

  it("send 之后 origin 变化且无远端结论 ⇒ unknown{origin_changed_after_send}，绝不 none", async () => {
    const h = makeHarness();
    h.setSend(async () => {
      h.setIdentity(undefined); // stack torn down mid-await
      return { kind: "deadline" };
    });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out).toMatchObject({ status: "unanswered", effect: "unknown", reason: "origin_changed_after_send" });
  });

  it("post-send origin change + a provable hub rejection keeps the remote verdict (none is the hub's, not derived)", async () => {
    const h = makeHarness();
    h.setSend(async () => {
      h.setIdentity({ sessionId: "sess-NEW00000001", epoch: 1 });
      return res({ ok: false, code: "E_XS_NO_TARGET" });
    });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "hello" });
    expect(out).toMatchObject({ status: "no_target", effect: "none" });
  });

  it("signal abort before the send frame ⇒ none, no frame; after a received verdict ⇒ verdict kept", async () => {
    const controller = new AbortController();
    const h = makeHarness();
    h.setResolve(async () => {
      controller.abort();
      return res({ ok: true, target: { ref: "abcdefgh1234" } });
    });
    const pre = await h.sender.message({ to: "abcdefgh1234", text: "x", signal: controller.signal });
    expect(pre).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(h.calls.send).toHaveLength(0);

    const controller2 = new AbortController();
    const h2 = makeHarness();
    h2.setSend(async () => {
      controller2.abort();
      return res({ ok: true, effect: "applied" });
    });
    const post = await h2.sender.message({ to: "abcdefgh1234", text: "x", signal: controller2.signal });
    expect(post).toMatchObject({ status: "sent", effect: "applied" });
  });

  it("a gone identity at call start ⇒ none, nothing leaves", async () => {
    const h = makeHarness();
    h.setIdentity(undefined);
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(h.calls.resolve).toHaveLength(0);
    expect(h.calls.send).toHaveLength(0);
  });
});

describe("fabric xs sender — deadline / link / cap", () => {
  it("8s client deadline ⇒ unknown{client_deadline}", async () => {
    const h = makeHarness();
    h.setSend(async () => ({ kind: "deadline" }));
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(out).toMatchObject({ status: "unanswered", effect: "unknown", reason: "client_deadline" });
  });

  it("link lost with the request pending ⇒ unknown{link_lost}", async () => {
    const h = makeHarness();
    h.setSend(async () => ({ kind: "link_lost" }));
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(out).toMatchObject({ status: "unanswered", effect: "unknown", reason: "link_lost" });
  });

  it("hub without the xs.v1 cap ⇒ E_XS_OFF, provably none", async () => {
    const h = makeHarness();
    h.setSend(async () => ({ kind: "off" }));
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(out).toMatchObject({ status: "off", effect: "none", code: "E_XS_OFF" });
  });

  it("resolve-stage transport failure ⇒ provable none (nothing was sent)", async () => {
    const h = makeHarness();
    h.setResolve(async () => ({ kind: "deadline" }));
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x" });
    expect(out).toMatchObject({ status: "error", effect: "none", reason: "client_deadline" });
    expect(h.calls.send).toHaveLength(0);
  });
});

describe("fabric xs sender — hub verdict mapping", () => {
  it("E_XS_NO_TARGET ⇒ no_target/none (unknown and not-joined indistinguishable)", async () => {
    const h = makeHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_NO_TARGET" }));
    expect(await h.sender.message({ to: "zzzz", text: "x" })).toMatchObject({
      status: "no_target",
      effect: "none",
    });
  });

  it("E_XS_STALE_ORIGIN ⇒ stale_origin/none (hub proved the frame never relayed)", async () => {
    const h = makeHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_STALE_ORIGIN" }));
    expect(await h.sender.message({ to: "abcdefgh1234", text: "x" })).toMatchObject({
      status: "stale_origin",
      effect: "none",
    });
  });

  it("E_XS_AMBIGUOUS from send ⇒ ambiguous with candidates, none", async () => {
    const h = makeHarness();
    h.setSend(async () =>
      res({
        ok: false,
        code: "E_XS_AMBIGUOUS",
        candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb", name: "n" }],
      }),
    );
    const out = await h.sender.message({ to: "dup", text: "x" });
    expect(out.status).toBe("ambiguous");
    expect(out.effect).toBe("none");
    expect(out.candidates).toHaveLength(2);
  });

  it("ambiguous RESOLVE ⇒ no send frame at all", async () => {
    const h = makeHarness();
    h.setResolve(async () => res({ ok: true, candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb" }] }));
    const out = await h.sender.message({ to: "dup", text: "x" });
    expect(out.status).toBe("ambiguous");
    expect(h.calls.send).toHaveLength(0);
  });

  it("E_XS_INTERNAL ⇒ conservatively unknown (cannot prove where the handler threw)", async () => {
    const h = makeHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_INTERNAL" }));
    expect(await h.sender.message({ to: "abcdefgh1234", text: "x" })).toMatchObject({
      status: "error",
      effect: "unknown",
    });
  });

  it("ok without an effect field ⇒ unknown (XI11: applied only on evidence)", async () => {
    const h = makeHarness();
    h.setSend(async () => res({ ok: true }));
    expect(await h.sender.message({ to: "abcdefgh1234", text: "x" })).toMatchObject({
      status: "sent",
      effect: "unknown",
      reason: "unspecified",
    });
  });

  it("applied + wake requested and not downgraded ⇒ derived woke:true (xs_res carries no woke)", async () => {
    const h = makeHarness();
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x", wake: true });
    expect(out).toMatchObject({ status: "sent", effect: "applied", woke: true });
    expect(h.calls.send[0]!.wake).toBe(true);
    expect(h.calls.send[0]!.level).toBe(1);
  });
});

describe("fabric xs sender — reserved addresses and sizes", () => {
  it.each(["root", "system", "main", "r_PARENT01", "@label", "wf_123456", "", "   ", "x".repeat(129)])(
    "reserved/invalid address %j ⇒ bad_target, no frames at all",
    async (to) => {
      const h = makeHarness();
      const out = await h.sender.message({ to, text: "x" });
      expect(out).toMatchObject({ status: "bad_target", effect: "none", reason: "bad_target" });
      expect(h.calls.resolve).toHaveLength(0);
      expect(h.calls.send).toHaveLength(0);
    },
  );

  it("oversize body (16 KiB frame cap) ⇒ too_large/none, sender pre-check, no frame", async () => {
    const h = makeHarness({ maxChars: 20_000 }); // defeat truncation so the byte cap binds
    const out = await h.sender.message({ to: "abcdefgh1234", text: "z".repeat(16_500) });
    expect(out).toMatchObject({ status: "too_large", effect: "none", reason: "too_large" });
    expect(h.calls.send).toHaveLength(0);
  });
});

describe("fabric xs sender — wake/level pre-checks (§4.5/§6.6)", () => {
  it("sender wake off ⇒ local downgrade sender_wake_disabled, deliver-only, no level", async () => {
    const h = makeHarness({ wakeOn: false, level: undefined });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x", wake: true });
    expect(out).toMatchObject({ status: "sent", effect: "applied", wakeDowngraded: "sender_wake_disabled" });
    expect(out.woke).toBeUndefined();
    expect(h.calls.send[0]!.wake).toBeUndefined();
    expect(h.calls.send[0]!.level).toBeUndefined();
  });

  it("sender maxLevel pre-check fails ⇒ local downgrade level_limit, level still carried", async () => {
    const level: XsSenderLevelPort = { levelOfRoot: () => 2, hopAllowed: (l) => l + 1 <= 2 };
    const h = makeHarness({ wakeOn: true, level });
    const out = await h.sender.message({ to: "abcdefgh1234", text: "x", wake: true });
    expect(out).toMatchObject({ status: "sent", effect: "applied", wakeDowngraded: "level_limit" });
    expect(h.calls.send[0]!.wake).toBeUndefined();
    expect(h.calls.send[0]!.level).toBe(2);
  });
});

describe("fabric xs sender — list", () => {
  it("passes query/scope with the origin snapshot and returns rows; post-reply identity change keeps them", async () => {
    const h = makeHarness();
    let flip = false;
    const sender = createXsSender({
      port: {
        ...h.calls,
        list: async () => {
          flip = true;
          return res({
            ok: true,
            rows: [
              { ref: "abcdefgh1234", cwdLabel: "~/p", kind: "main", receive: "wake", busy: false, lastActiveAgoS: 3 },
            ],
          });
        },
        resolve: async () => res({ ok: true }),
        send: async () => res({ ok: true }),
      } as XsHubPort,
      origin: { current: () => (flip ? undefined : { sessionId: "s", epoch: 0 }) },
    });
    const out = await sender.list({ query: "front", scope: "cwd" });
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(1);
  });

  it("off / error map without an effect column", async () => {
    const h = makeHarness();
    h.setResolve(async () => ({ kind: "off" }));
    // list path
    const sender = createXsSender({
      port: {
        list: async () => ({ kind: "off" }),
        resolve: async () => ({ kind: "off" }),
        send: async () => ({ kind: "off" }),
      },
      origin: { current: () => ({ sessionId: "s", epoch: 0 }) },
    });
    expect(await sender.list({})).toMatchObject({ status: "off" });
    expect(await h.sender.message({ to: "abcdefgh1234", text: "x" })).toMatchObject({
      status: "off",
      effect: "none",
    });
  });
});

describe("detectXsToolCollisions (§4.3/#12)", () => {
  it("flags same-named tools from other sources; unreadable tool table ⇒ no conflict", () => {
    expect(detectXsToolCollisions(["bash", "message_session"])).toEqual(["message_session"]);
    expect(detectXsToolCollisions(["list_sessions", "message_session", "bash"])).toEqual([
      "list_sessions",
      "message_session",
    ]);
    expect(detectXsToolCollisions(["bash"])).toEqual([]);
    expect(detectXsToolCollisions(undefined)).toEqual([]);
    expect(XS_MAIN_TOOL_NAMES).toEqual(["list_sessions", "message_session"]);
  });
});

// ====================================================================== reply-plan §4.2 (RX4)

import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import type { XsSenderReplyDeps } from "../../src/fabric/xs/sender.js";

const A_ID = "sess-SENDER0001";
const B_ID = "sess-REPLIER0001-full-session-id";

interface ReplyHarness extends Harness {
  ledger: XsReplyLedger;
  now: { t: number };
  state: {
    capable: boolean;
    receivable: ReturnType<XsSenderReplyDeps["receivable"]>;
    inbound: { fromSessionId: string } | undefined;
  };
}

function makeReplyHarness(over?: { sessionId?: string | undefined }): ReplyHarness {
  const now = { t: 1_000_000 };
  const ledger = new XsReplyLedger({ clock: { now: () => now.t } as never });
  const state: ReplyHarness["state"] = { capable: true, receivable: "ok", inbound: undefined };
  const h = makeHarness({
    reply: {
      ledger,
      defaultTimeoutS: 1800,
      maxTimeoutS: 86_400,
      lateGraceS: 600,
      maxPending: 8,
      maxPendingPerTarget: 3,
      receivable: () => state.receivable,
      inbound: () => state.inbound,
      now: () => now.t,
    },
  });
  // capability probe lives on the port; wrap the harness's port via a second sender is overkill —
  // rebuild with a port that records calls and answers replyCapable().
  const calls = h.calls;
  let resolveImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, target: { ref: "abcdefgh1234", name: "peer", sessionId: over?.sessionId ?? B_ID } as never });
  let sendImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, effect: "applied", target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never });
  let identity: { sessionId: string; epoch: number } | undefined = { sessionId: A_ID, epoch: 7 };
  const port: XsHubPort = {
    async list() {
      return res({ ok: true, rows: [] });
    },
    async resolve(a) {
      calls.resolve.push(a);
      return resolveImpl();
    },
    async send(a) {
      calls.send.push(a);
      return sendImpl();
    },
    replyCapable: () => state.capable,
  };
  const sender = createXsSender({
    port,
    origin: { current: () => identity },
    wakeOn: true,
    level: { levelOfRoot: () => 2, hopAllowed: () => true },
    reply: {
      ledger,
      defaultTimeoutS: 1800,
      maxTimeoutS: 86_400,
      lateGraceS: 600,
      maxPending: 8,
      maxPendingPerTarget: 3,
      receivable: () => state.receivable,
      inbound: () => state.inbound,
    },
  });
  return {
    ...h,
    sender,
    calls,
    ledger,
    now,
    state,
    setIdentity: (id) => {
      identity = id;
    },
    setResolve: (impl) => {
      resolveImpl = impl;
    },
    setSend: (impl) => {
      sendImpl = impl;
    },
  };
}

const ledgerTickets = (l: XsReplyLedger) => l.repliesView(A_ID);

describe("sender reply — expectReply branch (§4.2)", () => {
  it("sends `to` = the verified FULL sessionId (never the typed name), carries expect, issues the ticket first", async () => {
    const h = makeReplyHarness();
    const out = await h.sender.message({ to: "peer", text: "do it", wake: true, expectReply: { timeoutS: 120 } });
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.send[0]!.to).toBe(B_ID);
    expect(h.calls.send[0]!.expect).toMatchObject({ timeoutMs: 120_000 });
    expect(h.calls.send[0]!.expect!.requestId).toMatch(/^q[0-9a-f]{18}$/);
    expect(h.calls.send[0]!.wake).toBe(true);
    expect(h.calls.send[0]!.level).toBe(2);
    expect(out.status).toBe("sent");
    expect(out.reply).toMatchObject({ requestId: h.calls.send[0]!.expect!.requestId, state: "pending" });
    expect(out.reply!.dueAt).toBe(new Date(1_000_000 + 120_000).toISOString());
    // result `to` never carries the full sessionId
    expect(out.to).toEqual({ ref: "abcdefgh1234", name: "peer" });
    expect(JSON.stringify(out)).not.toContain(B_ID);
    expect(ledgerTickets(h.ledger).length).toBe(1);
  });

  it("default timeout comes from settings; the ticket wakes the requester only for model origin", async () => {
    const h = makeReplyHarness();
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(h.calls.send[0]!.expect!.timeoutMs).toBe(1_800_000);
    expect(out.reply!.state).toBe("pending");
    const q = h.calls.send[0]!.expect!.requestId;
    const t = h.ledger.classify(q, B_ID, A_ID, h.now.t);
    expect(t.kind).toBe("reply");
    if (t.kind === "reply") {
      expect(t.ticket.wakeOnReply).toBe(true);
      expect(t.ticket.origin).toBe("model");
      expect(t.ticket.requesterLevel).toBe(2);
    }
  });

  it("human origin: quiet reply ticket, level 0 on the frame", async () => {
    const h = makeReplyHarness();
    await h.sender.message({ to: "peer", text: "x", wake: true, expectReply: {}, origin: "human", levelOverride: 0 });
    expect(h.calls.send[0]!.level).toBe(0);
    expect(h.calls.send[0]!.wake).toBe(true);
    const t = h.ledger.classify(h.calls.send[0]!.expect!.requestId, B_ID, A_ID, h.now.t);
    if (t.kind !== "reply") throw new Error("expected reply");
    expect(t.ticket).toMatchObject({ origin: "human", wakeOnReply: true, requesterLevel: 0 });
  });

  it("reply_unsupported: port not capable ⇒ no ticket, no send frame", async () => {
    const h = makeReplyHarness();
    h.state.capable = false;
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
    expect(ledgerTickets(h.ledger).length).toBe(0);
  });

  it("reply_unsupported: resolve backfilled no sessionId (old peer) ⇒ no ticket, no send frame", async () => {
    const h = makeReplyHarness();
    h.setResolve(async () => res({ ok: true, target: { ref: "abcdefgh1234" } }));
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none", reason: "no_session_id" });
    expect(h.calls.send).toHaveLength(0);
    expect(ledgerTickets(h.ledger).length).toBe(0);
  });

  it("reply_unsupported: no reply deps wired at all", async () => {
    const h = makeHarness();
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
  });

  it.each(["receive_off", "blocked", "not_joined"] as const)(
    "reply_unreceivable{%s}: no ticket, no send frame",
    async (why) => {
      const h = makeReplyHarness();
      h.state.receivable = why;
      const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
      expect(out).toMatchObject({ status: "reply_unreceivable", effect: "none", unreceivable: why });
      expect(h.calls.send).toHaveLength(0);
      expect(ledgerTickets(h.ledger).length).toBe(0);
    },
  );

  it("reply_quota: the 4th request to one target is refused (per-target 3) with no frame", async () => {
    const h = makeReplyHarness();
    for (let i = 0; i < 3; i++) {
      expect((await h.sender.message({ to: "peer", text: "x", expectReply: {} })).status).toBe("sent");
    }
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_quota", effect: "none", reason: "per_target" });
    expect(h.calls.send).toHaveLength(3);
  });

  it("reply_ledger_full: a full process ledger refuses issuance, no frame, no eviction", async () => {
    const now = { t: 1_000_000 };
    const ledger = new XsReplyLedger({ capacity: 1, clock: { now: () => now.t } as never });
    const h = makeHarness({
      reply: {
        ledger,
        defaultTimeoutS: 1800,
        maxTimeoutS: 86_400,
        lateGraceS: 600,
        maxPending: 8,
        maxPendingPerTarget: 3,
        receivable: () => "ok",
        inbound: () => undefined,
      },
    });
    // capability probe is absent on the plain harness port ⇒ use a bespoke sender
    const calls: XsPortSendArgs[] = [];
    const sender = createXsSender({
      port: {
        list: async () => res({ ok: true, rows: [] }),
        resolve: async () => res({ ok: true, target: { ref: "abcdefgh1234", sessionId: B_ID } as never }),
        send: async (a) => {
          calls.push(a);
          return res({ ok: true, effect: "applied" });
        },
        replyCapable: () => true,
      },
      origin: { current: () => ({ sessionId: A_ID, epoch: 1 }) },
      reply: {
        ledger,
        defaultTimeoutS: 1800,
        maxTimeoutS: 86_400,
        lateGraceS: 600,
        maxPending: 8,
        maxPendingPerTarget: 3,
        receivable: () => "ok",
        inbound: () => undefined,
      },
    });
    void h;
    expect((await sender.message({ to: "peer", text: "x", expectReply: {} })).status).toBe("sent");
    const out = await sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_ledger_full", effect: "none" });
    expect(calls).toHaveLength(1);
  });

  it("bad_args: expectReply together with replyTo ⇒ local refusal, no resolve, no send", async () => {
    const h = makeReplyHarness();
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {}, replyTo: "q" + "a".repeat(18) });
    expect(out).toMatchObject({ status: "bad_args", effect: "none" });
    expect(h.calls.resolve).toHaveLength(0);
    expect(h.calls.send).toHaveLength(0);
  });

  it("send none (hub rejected, provable) ⇒ ticket send_failed and not receivable", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_NO_TARGET" }));
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "no_target", effect: "none" });
    expect(out.reply).toMatchObject({ state: "send_failed" });
    const q = h.calls.send[0]!.expect!.requestId;
    expect(h.ledger.classify(q, B_ID, A_ID, h.now.t).kind).toBe("invalid");
  });

  it("E_XS_REPLY_UNSUPPORTED from the hub is a provable none ⇒ send_failed", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_REPLY_UNSUPPORTED" }));
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none", code: "E_XS_REPLY_UNSUPPORTED" });
    expect(out.reply!.state).toBe("send_failed");
  });

  it("send unknown (deadline) ⇒ ticket stays pending (r3 M2) and the reply is still acceptable", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => ({ kind: "deadline" }));
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "unanswered", effect: "unknown", reason: "client_deadline" });
    expect(out.reply!.state).toBe("pending");
    expect(h.ledger.classify(h.calls.send[0]!.expect!.requestId, B_ID, A_ID, h.now.t).kind).toBe("reply");
  });

  it("origin change after the send (no verdict) keeps the ticket pending; a received verdict survives", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => {
      h.setIdentity({ sessionId: "sess-OTHER", epoch: 1 });
      return { kind: "link_lost" };
    });
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ effect: "unknown", reason: "origin_changed_after_send" });
    expect(out.reply!.state).toBe("pending");
  });

  it("origin change DURING resolve ⇒ none, nothing issued, no send", async () => {
    const h = makeReplyHarness();
    h.setResolve(async () => {
      h.setIdentity({ sessionId: "sess-OTHER", epoch: 1 });
      return res({ ok: true, target: { ref: "abcdefgh1234", sessionId: B_ID } as never });
    });
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
    expect(ledgerTickets(h.ledger).length).toBe(0);
  });

  it("too_large is refused BEFORE issuing a ticket (no ledger entry leaks)", async () => {
    const h = makeReplyHarness();
    const out = await h.sender.message({ to: "peer", text: "x".repeat(40_000), expectReply: {} });
    // body is truncated to maxChars (2000), so this stays sendable — the oversize path needs maxChars huge:
    expect(out.status).toBe("sent");
    const big = createXsSender({
      port: {
        list: async () => res({ ok: true, rows: [] }),
        resolve: async () => res({ ok: true, target: { ref: "abcdefgh1234", sessionId: B_ID } as never }),
        send: async () => res({ ok: true, effect: "applied" }),
        replyCapable: () => true,
      },
      origin: { current: () => ({ sessionId: A_ID, epoch: 1 }) },
      maxChars: 100_000,
      reply: {
        ledger: new XsReplyLedger(),
        defaultTimeoutS: 1800,
        maxTimeoutS: 86_400,
        lateGraceS: 600,
        maxPending: 8,
        maxPendingPerTarget: 3,
        receivable: () => "ok",
        inbound: () => undefined,
      },
    });
    const o2 = await big.message({ to: "peer", text: "y".repeat(60_000), expectReply: {} });
    expect(o2).toMatchObject({ status: "too_large", effect: "none" });
    expect(o2.reply).toBeUndefined();
  });

  it("name rebind after resolve: the frame still targets the pinned sessionId, not the name", async () => {
    const h = makeReplyHarness();
    let n = 0;
    h.setResolve(async () => {
      n++;
      return res({ ok: true, target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never });
    });
    await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(n).toBe(1); // one resolve; the later hub-side name binding can no longer matter
    expect(h.calls.send[0]!.to).toBe(B_ID);
    expect(h.calls.send[0]!.to).not.toBe("peer");
  });

  it("ambiguous short ref: refused at resolve, nothing issued and no frame", async () => {
    const h = makeReplyHarness();
    h.setResolve(async () =>
      res({
        ok: true,
        candidates: [
          { ref: "abcdefgh1111", cwdLabel: "~/a" },
          { ref: "abcdefgh2222", cwdLabel: "~/b" },
        ] as never,
      }),
    );
    const out = await h.sender.message({ to: "abcdefgh", text: "x", expectReply: {} });
    expect(out.status).toBe("ambiguous");
    expect(h.calls.send).toHaveLength(0);
    expect(ledgerTickets(h.ledger).length).toBe(0);
  });

  it("target gone between resolve and send (hub E_XS_NO_TARGET) ⇒ none, ticket send_failed", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => res({ ok: false, code: "E_XS_NO_TARGET" }));
    const out = await h.sender.message({ to: "peer", text: "x", expectReply: {} });
    expect(out.effect).toBe("none");
    expect(out.reply!.state).toBe("send_failed");
  });
});

describe("sender reply — replyTo branch (§4.2)", () => {
  const Q = "q" + "ab12".repeat(4) + "cd";

  it("sends the full sessionId with replyTo and NO wake / NO level, even when the caller asked for wake", async () => {
    const h = makeReplyHarness();
    h.state.inbound = { fromSessionId: B_ID };
    const out = await h.sender.message({ to: "peer", text: "result", wake: true, replyTo: Q });
    const sent = h.calls.send[0]!;
    expect(sent.to).toBe(B_ID);
    expect(sent.replyTo).toBe(Q);
    expect(sent.wake).toBeUndefined();
    expect(sent.level).toBeUndefined();
    expect(sent.expect).toBeUndefined();
    expect(out).toMatchObject({ status: "sent", effect: "applied", replyTo: { requestId: Q, accepted: true } });
    expect(out.woke).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(B_ID);
    expect(ledgerTickets(h.ledger).length).toBe(0); // a reply never issues a ticket
  });

  it("reply_unsupported: not capable ⇒ no resolve round trip, no frame", async () => {
    const h = makeReplyHarness();
    h.state.capable = false;
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none" });
    expect(h.calls.resolve).toHaveLength(0);
    expect(h.calls.send).toHaveLength(0);
  });

  it("reply_unsupported: no full sessionId from resolve ⇒ no frame", async () => {
    const h = makeReplyHarness();
    h.setResolve(async () => res({ ok: true, target: { ref: "abcdefgh1234" } }));
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ status: "reply_unsupported", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
  });

  it("reply_target_mismatch: the inbound request came from a different session ⇒ none, no frame", async () => {
    const h = makeReplyHarness();
    h.state.inbound = { fromSessionId: "sess-SOMEONE-ELSE" };
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ status: "reply_target_mismatch", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
  });

  it("inbound not found ⇒ not blocked (the requester decides)", async () => {
    const h = makeReplyHarness();
    h.state.inbound = undefined;
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out.status).toBe("sent");
    expect(h.calls.send).toHaveLength(1);
  });

  it("hub rejection (requester refused) ⇒ none, accepted:false, no retry", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => res({ ok: true, effect: "none", reason: "rejected" }));
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ status: "sent", effect: "none", reason: "rejected", replyTo: { accepted: false } });
    expect(h.calls.send).toHaveLength(1);
  });

  it("unknown (deadline) ⇒ accepted:false + effect unknown, still exactly one frame (NQ3)", async () => {
    const h = makeReplyHarness();
    h.setSend(async () => ({ kind: "deadline" }));
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ effect: "unknown", replyTo: { requestId: Q, accepted: false } });
    expect(h.calls.send).toHaveLength(1);
  });

  it("origin change during resolve ⇒ none and no frame", async () => {
    const h = makeReplyHarness();
    h.setResolve(async () => {
      h.setIdentity({ sessionId: "sess-OTHER", epoch: 1 });
      return res({ ok: true, target: { ref: "abcdefgh1234", sessionId: B_ID } as never });
    });
    const out = await h.sender.message({ to: "peer", text: "r", replyTo: Q });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(h.calls.send).toHaveLength(0);
  });
});

describe("sender reply — legacy sends are untouched", () => {
  it("a plain send on a reply-wired sender keeps the original address and carries no reply fields", async () => {
    const h = makeReplyHarness();
    const out = await h.sender.message({ to: "peer", text: "plain", wake: true });
    expect(h.calls.send[0]!.to).toBe("peer");
    expect(h.calls.send[0]!.expect).toBeUndefined();
    expect(h.calls.send[0]!.replyTo).toBeUndefined();
    expect(out.reply).toBeUndefined();
    expect(out.replyTo).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(B_ID);
  });
});
