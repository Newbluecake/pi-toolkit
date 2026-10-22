/**
 * channel-plan §12.6 (IBP): `StatusInfo.xsInbox` — the unread projection. Only written while the
 * stack port reports n>0 (1..9999 saturated); every other state leaves the key absent so the
 * status frame stays byte-equal to the pre-feature shape.
 */
import { describe, expect, it, vi } from "vitest";
import { createXsAgentBridge, type XsAgentPort, type XsStackPort } from "../../../src/web-hub/agent/xs.js";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";

function bridgeWith(unread: (() => number) | undefined, publishStatus?: () => void) {
  const stack: XsStackPort = {
    sessionId: () => "sess-aaaaaaaaaaaa",
    member: () => ({ epoch: 1, joined: true, receive: "wake" }),
    deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
    status: () => ({ joined: true, receive: "wake", blocked: 0 }),
    ...(unread !== undefined ? { unread } : {}),
  };
  const port: XsAgentPort = {
    stack: () => stack,
    memberLimits: () => ({
      sendsOutPerMin: 10,
      sendsOutPerHour: 60,
      wakesOutPerHour: 6,
      pairMinIntervalMs: 30_000,
      pairWakesPerHour: 2,
      inFlightPerSession: 4,
      listPerMin: 6,
    }),
    hubSendsPerMin: () => 60,
  };
  return createXsAgentBridge({
    port,
    conn: () => undefined,
    ...(publishStatus !== undefined ? { publishStatus } : {}),
  });
}

describe("xsInbox projection", () => {
  it("no unread port ⇒ undefined (key never written)", () => {
    expect(bridgeWith(undefined).inboxProjection()).toBeUndefined();
  });

  it("no stack ⇒ undefined", () => {
    const b = createXsAgentBridge({
      port: { stack: () => undefined, memberLimits: () => ({}) as never, hubSendsPerMin: () => 60 },
      conn: () => undefined,
    });
    expect(b.inboxProjection()).toBeUndefined();
  });

  it("n=0 / negative / NaN ⇒ undefined", () => {
    expect(bridgeWith(() => 0).inboxProjection()).toBeUndefined();
    expect(bridgeWith(() => -3).inboxProjection()).toBeUndefined();
    expect(bridgeWith(() => Number.NaN).inboxProjection()).toBeUndefined();
  });

  it("n>0 ⇒ { unread: n }", () => {
    expect(bridgeWith(() => 1).inboxProjection()).toEqual({ unread: 1 });
    expect(bridgeWith(() => 42).inboxProjection()).toEqual({ unread: 42 });
  });

  it("saturates at 9999 and floors fractions", () => {
    expect(bridgeWith(() => 9999).inboxProjection()).toEqual({ unread: 9999 });
    expect(bridgeWith(() => 123_456).inboxProjection()).toEqual({ unread: 9999 });
    expect(bridgeWith(() => 2.9).inboxProjection()).toEqual({ unread: 2 });
    expect(bridgeWith(() => 0.5).inboxProjection()).toBeUndefined();
  });

  it("a throwing port degrades to absent", () => {
    expect(
      bridgeWith(() => {
        throw new Error("x");
      }).inboxProjection(),
    ).toBeUndefined();
  });
});

describe("notifyUnreadChanged", () => {
  it("republishes status exactly once per call", () => {
    const publish = vi.fn();
    const b = bridgeWith(() => 1, publish);
    b.notifyUnreadChanged();
    b.notifyUnreadChanged();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("is a safe no-op without a publisher and never throws from one", () => {
    expect(() => bridgeWith(() => 1).notifyUnreadChanged()).not.toThrow();
    const b = bridgeWith(
      () => 1,
      () => {
        throw new Error("boom");
      },
    );
    expect(() => b.notifyUnreadChanged()).not.toThrow();
  });
});

describe("StatusInfo wire schema", () => {
  const base = { t: "status", leafId: null, busy: false, pending: false } as const;

  it("a frame without xsInbox decodes with no such key (byte-equal shape)", () => {
    const f = decodeAgentFrame({ ...base });
    expect(f).toBeDefined();
    expect(Object.keys(f as object)).not.toContain("xsInbox");
  });

  it("accepts 1..9999 and rejects 0 / >9999 / fractions", () => {
    expect(decodeAgentFrame({ ...base, xsInbox: { unread: 3 } })).toMatchObject({ xsInbox: { unread: 3 } });
    expect(decodeAgentFrame({ ...base, xsInbox: { unread: 9999 } })).toBeDefined();
    expect(decodeAgentFrame({ ...base, xsInbox: { unread: 0 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...base, xsInbox: { unread: 10_000 } })).toBeUndefined();
    expect(decodeAgentFrame({ ...base, xsInbox: { unread: 1.5 } })).toBeUndefined();
  });
});
