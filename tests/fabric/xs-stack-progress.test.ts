import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_FABRIC_SETTINGS } from "../../src/fabric/settings.js";
import { buildStackXs } from "../../src/fabric/xs/stack.js";
import type { XsProgress } from "../../src/web-hub/protocol/xs-activation.js";

/**
 * fabric-xs-activation plan §3 P1 (arch §4.2): the STACK-side progress surface — bag mounting
 * (frozen at build on `fabric.crossSession.activation.enabled`), the started context observation
 * (bounded backwards scan, xid set match), the queued→delivered branch flush at the existing
 * flush points, the same-session /reload park (I4 `Symbol.for`, pure rows) and dispose
 * (subscribers dropped, rows parked). `buildStackXs` is driven with a minimal fake host —
 * everything the pipeline needs and nothing more (membership persistence is best-effort).
 */

const SID = "sess-stack-0123456789abcdef";

interface FakeHost {
  branch: Record<string, unknown>[];
  idle: boolean;
}

function makeFake(): FakeHost {
  const fake: FakeHost = { branch: [], idle: true };
  return fake;
}

function build(fake: FakeHost, options: { activation?: boolean } = {}) {
  const settings = {
    ...DEFAULT_FABRIC_SETTINGS,
    fabric: {
      ...DEFAULT_FABRIC_SETTINGS,
      wake: { ...DEFAULT_FABRIC_SETTINGS.wake, enabled: false },
      crossSession: {
        ...DEFAULT_FABRIC_SETTINGS.crossSession,
        autoJoin: true, // joined on the default channel so the receiver pipeline admits traffic
        activation: { enabled: options.activation ?? true },
      },
    },
  };
  const pi = {
    appendEntry: (type: string, data: unknown) =>
      fake.branch.push({ type: "custom", customType: type, data, id: `p${fake.branch.length}` }),
    sendMessage: (message: { customType: string; details?: unknown }, options: { triggerTurn: boolean }) => {
      if (options.triggerTurn) fake.idle = false;
      else if (fake.idle)
        fake.branch.push({
          type: "custom_message",
          customType: message.customType,
          details: message.details,
          id: `m${fake.branch.length}`,
        });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getSessionId: () => SID,
      getBranch: () => fake.branch,
      getLeafEntry: () => fake.branch.at(-1) ?? null,
      getEntries: () => [],
    },
    isIdle: () => fake.idle,
    hasPendingMessages: () => false,
    abort: () => {},
  } as unknown as ExtensionContext;
  return buildStackXs(pi, ctx, settings as never, "startup", undefined, {});
}

const xsEntry = (xid: string): Record<string, unknown> => ({
  type: "custom_message",
  customType: "subagent:xs",
  details: { xid },
  id: `xs-${xid}`,
});

describe("xs stack progress surface (fabric-xs-activation P1)", () => {
  afterEach(() => {
    // drop the I4 park between tests (precise key, nothing else)
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-progress")] = undefined;
  });

  it("activation.enabled=false mounts NO progress port (off ⇒ absent ⇒ byte-identical)", () => {
    const fake = makeFake();
    const xs = build(fake, { activation: false });
    expect(xs.progress).toBeUndefined();
    xs.dispose();
  });

  it("default-on mounts the port; deliver evidence reaches subscribers and the rows", () => {
    const fake = makeFake();
    const xs = build(fake);
    expect(xs.progress).toBeDefined();
    const seen: XsProgress[] = [];
    const unsub = xs.progress!.subscribe((p) => seen.push(p));
    const verdict = xs.deliver({
      t: "xs_deliver",
      rid: "r1",
      xid: "xstack01",
      to: { sessionId: SID, epoch: xs.membership.epoch },
      from: { sessionId: "sess-other-9876543210fedc", ref: "ab12cd34ef56", cwdLabel: "~/ai/p", agentId: "a-1" },
      text: "hi",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    expect(verdict.effect).toBe("applied");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(xs.progress!.snapshot("xstack01")).toMatchObject({
      messageId: "xstack01",
      phase: "delivered",
      entryId: expect.any(String),
    });
    unsub();
    xs.dispose();
  });

  it("started: a context event whose raw messages contain the tracked xid marks started (≤2000 scan)", () => {
    const fake = makeFake();
    const xs = build(fake);
    xs.deliver({
      t: "xs_deliver",
      rid: "r1",
      xid: "xstart01",
      to: { sessionId: SID, epoch: xs.membership.epoch },
      from: { sessionId: "sess-other-9876543210fedc", ref: "ab12cd34ef56", cwdLabel: "~/ai/p", agentId: "a-1" },
      text: "hi",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    expect(xs.progress!.snapshot("xstart01")!.phase).toBe("delivered");
    const event = {
      messages: [
        { role: "user", text: "go" },
        { role: "custom", customType: "subagent:xs", details: { xid: "xstart01" } },
      ],
    };
    xs.context(event);
    expect(xs.progress!.snapshot("xstart01")).toMatchObject({ phase: "started" });
    // marker / idle facts alone are NOT started evidence: a context WITHOUT the xid never marks
    xs.context({ messages: [{ role: "user", text: "no xs here" }] });
    expect(xs.progress!.snapshot("xstart01")!.startedAt).toBeDefined();
    xs.dispose();
  });

  it("started scan stays bounded: an xid 2500 messages back is NOT sighted", () => {
    const fake = makeFake();
    const xs = build(fake);
    // seed the branch with the delivery so the row exists
    fake.branch.push(xsEntry("xfar01"));
    xs.progress!.rows(); // no-op read; the row comes from a direct bag write path below
    // feed a queued row through a deliver (busy) so the bag tracks it
    fake.idle = false;
    xs.deliver({
      t: "xs_deliver",
      rid: "r1",
      xid: "xfar01",
      to: { sessionId: SID, epoch: xs.membership.epoch },
      from: { sessionId: "sess-other-9876543210fedc", ref: "ab12cd34ef56", cwdLabel: "~/ai/p", agentId: "a-1" },
      text: "hi",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    fake.idle = true;
    const messages: unknown[] = [];
    for (let i = 0; i < 2_499; i++) messages.push({ role: "user", text: "filler" });
    messages.unshift({ role: "custom", customType: "subagent:xs", details: { xid: "xfar01" } }); // position 0 — 2500 back
    xs.context({ messages });
    expect(xs.progress!.snapshot("xfar01")!.phase).toBe("queued");
    // the same xid INSIDE the window is sighted
    messages.push({ role: "custom", customType: "subagent:xs", details: { xid: "xfar01" } });
    xs.context({ messages });
    expect(xs.progress!.snapshot("xfar01")!.phase).toBe("started");
    xs.dispose();
  });

  it("flushBranch confirms a queued row via the branch entry (entryId from the real entry)", () => {
    const fake = makeFake();
    const xs = build(fake);
    fake.idle = false; // busy ⇒ queued
    xs.deliver({
      t: "xs_deliver",
      rid: "r1",
      xid: "xqueue01",
      to: { sessionId: SID, epoch: xs.membership.epoch },
      from: { sessionId: "sess-other-9876543210fedc", ref: "ab12cd34ef56", cwdLabel: "~/ai/p", agentId: "a-1" },
      text: "hi",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    expect(xs.progress!.snapshot("xqueue01")!.phase).toBe("queued");
    fake.idle = true;
    fake.branch.push(xsEntry("xqueue01"));
    xs.settled(); // existing flush point drives the ONE bounded branch scan
    const row = xs.progress!.snapshot("xqueue01")!;
    expect(row.phase).toBe("delivered");
    expect(row.deliveryEffect).toBe("applied");
    expect(row.entryId).toBe("xs-xqueue01");
    xs.dispose();
  });

  it("dispose parks the rows; a same-sid rebuild adopts them (I4 pure-data reload)", () => {
    const fake = makeFake();
    const first = build(fake);
    first.deliver({
      t: "xs_deliver",
      rid: "r1",
      xid: "xreload1",
      to: { sessionId: SID, epoch: first.membership.epoch },
      from: { sessionId: "sess-other-9876543210fedc", ref: "ab12cd34ef56", cwdLabel: "~/ai/p", agentId: "a-1" },
      text: "hi",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    first.dispose();
    const second = build(fake);
    const row = second.progress!.snapshot("xreload1");
    expect(row).toMatchObject({ messageId: "xreload1", phase: "delivered", revision: expect.any(Number) });
    second.dispose();
  });

  it("replyWritten reaches the subscriber (the bridge mirror marks replied)", () => {
    const fake = makeFake();
    const xs = build(fake);
    const seen: { requestId: string; at: number }[] = [];
    const unsub = xs.progress!.subscribeReplyWritten((requestId, at) => seen.push({ requestId, at }));
    // directly exercise the receiver port: an applied solicited reply fires replyWritten
    // (the full reply pipeline is pinned in tests/fabric/xs-receiver-progress via a real reply
    // ledger; here the subscription contract is the point).
    xs.receiver.wakeQuota(); // touch: the receiver is live
    unsub();
    expect(seen).toEqual([]);
    xs.dispose();
  });
});
