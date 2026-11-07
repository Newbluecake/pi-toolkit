import { describe, expect, it } from "vitest";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import {
  createXsSender,
  type XsPortReply,
  type XsHubPort,
  type XsSenderMessageArgs,
} from "../../src/fabric/xs/sender.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

/**
 * #21 plan §3 T14 (B1 half) / §1 D6 (M6): `XsSenderMessageArgs.onIssued` — the precise
 * ticket→call registration hook. It must fire EXACTLY ONCE per successful `ledger.issue`,
 * synchronously in the same block (AFTER the ticket exists, BEFORE the send frame leaves),
 * never on a failed issue / refused branch, and a throwing callback must never break the send.
 */

const A_ID = "sess-SENDER0001abcdefgh";
const B_ID = "sess-PEER0002abcdefghij";

const res = (partial: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "r-test", ...partial } as XsResFrame,
});

interface Harness {
  ledger: XsReplyLedger;
  now: { t: number };
  calls: { send: unknown[] };
  send(args: XsSenderMessageArgs): Promise<ReturnType<ReturnType<typeof createXsSender>["message"]>>;
  setSendImpl(impl: () => Promise<XsPortReply>): void;
  setResolveImpl(impl: () => Promise<XsPortReply>): void;
  flipIdentity(): void;
}

function makeHarness(replyOver: { maxPending?: number; maxTimeoutS?: number } = {}): Harness {
  const now = { t: 1_000_000 };
  const ledger = new XsReplyLedger({ clock: { now: () => now.t } as never });
  const calls: { send: unknown[] } = { send: [] };
  let identity: { sessionId: string; epoch: number } | undefined = { sessionId: A_ID, epoch: 7 };
  let resolveImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never });
  let sendImpl: () => Promise<XsPortReply> = async () =>
    res({ ok: true, effect: "applied", target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never });
  const port: XsHubPort = {
    async list() {
      return res({ ok: true, rows: [] });
    },
    async resolve() {
      return resolveImpl();
    },
    async send(args) {
      calls.send.push(args);
      return sendImpl();
    },
    replyCapable: () => true,
  };
  const sender = createXsSender({
    port,
    origin: { current: () => identity },
    wakeOn: true,
    level: { levelOfRoot: () => 2, hopAllowed: () => true },
    reply: {
      ledger,
      defaultTimeoutS: 1_800,
      maxTimeoutS: replyOver.maxTimeoutS ?? 86_400,
      lateGraceS: 600,
      maxPending: replyOver.maxPending ?? 8,
      maxPendingPerTarget: 3,
      receivable: () => "ok",
      inbound: () => undefined,
      now: () => now.t,
    },
  });
  return {
    ledger,
    now,
    calls,
    send: (args) => sender.message(args),
    setSendImpl: (impl) => {
      sendImpl = impl;
    },
    setResolveImpl: (impl) => {
      resolveImpl = impl;
    },
    flipIdentity: () => {
      identity = { sessionId: "sess-NEW000000000001", epoch: 1 };
    },
  };
}

describe("xs sender onIssued (#21 D6/M6, T14)", () => {
  it("fires exactly once, synchronously AFTER the issue and BEFORE the send frame leaves", async () => {
    const h = makeHarness();
    const seen: { requestId: string; dueAt: number }[] = [];
    let firedBeforeFrame = false;
    h.setSendImpl(async () => {
      // port.send is called with the frame — by then onIssued must already have fired
      firedBeforeFrame = seen.length === 1;
      return res({
        ok: true,
        effect: "applied",
        target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never,
      });
    });
    const out = await h.send({
      to: "peer",
      text: "question",
      wake: true,
      expectReply: { timeoutS: 120 },
      onIssued: (t) => seen.push(t),
    });
    expect(seen).toHaveLength(1);
    expect(firedBeforeFrame).toBe(true);
    expect(seen[0]!.requestId).toMatch(/^q[0-9a-f]{18}$/);
    expect(seen[0]!.requestId).toBe(out.reply?.requestId);
    expect(seen[0]!.dueAt).toBe(h.now.t + 120_000); // the ledger's real issue-time dueAt (ms)
    expect(out.reply?.dueAt).toBe(new Date(seen[0]!.dueAt).toISOString());
  });

  it("carries the clamped timeout when an explicit timeoutS exceeds maxTimeoutS", async () => {
    const h = makeHarness({ maxTimeoutS: 3_600 });
    const seen: number[] = [];
    await h.send({
      to: "peer",
      text: "x",
      wake: true,
      expectReply: { timeoutS: 100_000 },
      onIssued: (t) => seen.push(t.dueAt),
    });
    expect(seen[0]).toBe(h.now.t + 3_600_000);
  });

  it("never fires without expectReply", async () => {
    const h = makeHarness();
    let fired = 0;
    await h.send({ to: "peer", text: "x", onIssued: () => void fired++ });
    expect(fired).toBe(0);
    expect(h.calls.send).toHaveLength(1);
  });

  it("never fires when the issue is refused (reply quota exhausted)", async () => {
    const h = makeHarness({ maxPending: 0 });
    let fired = 0;
    const out = await h.send({
      to: "peer",
      text: "x",
      wake: true,
      expectReply: {},
      onIssued: () => void fired++,
    });
    expect(out).toMatchObject({ status: "reply_quota", effect: "none" });
    expect(fired).toBe(0);
    expect(h.calls.send).toHaveLength(0); // nothing was sent
  });

  it("never fires when the origin guard refuses before the frame (none, no send)", async () => {
    const h = makeHarness();
    let fired = 0;
    h.setResolveImpl(async () => {
      h.flipIdentity(); // /new DURING the resolve round trip — the post-resolve guard fires
      return res({ ok: true, target: { ref: "abcdefgh1234", name: "peer", sessionId: B_ID } as never });
    });
    const out = await h.send({
      to: "peer",
      text: "x",
      wake: true,
      expectReply: {},
      onIssued: () => void fired++,
    });
    expect(out).toMatchObject({ status: "origin_changed", effect: "none" });
    expect(fired).toBe(0);
    expect(h.calls.send).toHaveLength(0);
  });

  it("a throwing callback is swallowed — the send still completes", async () => {
    const h = makeHarness();
    const out = await h.send({
      to: "peer",
      text: "x",
      wake: true,
      expectReply: {},
      onIssued: () => {
        throw new Error("observer bug");
      },
    });
    expect(out).toMatchObject({ status: "sent", effect: "applied" });
    expect(out.reply?.state).toBe("pending");
    expect(h.calls.send).toHaveLength(1);
  });

  it("fires once even when the send round trip ends in unknown (the ticket exists)", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.setSendImpl(async () => ({ kind: "deadline" }));
    const out = await h.send({
      to: "peer",
      text: "x",
      wake: true,
      expectReply: {},
      onIssued: (t) => seen.push(t.requestId),
    });
    expect(out).toMatchObject({ status: "unanswered", effect: "unknown", reason: "client_deadline" });
    expect(seen).toHaveLength(1);
    expect(out.reply).toMatchObject({ requestId: seen[0], state: "pending" }); // ticket stays receivable
  });
});
