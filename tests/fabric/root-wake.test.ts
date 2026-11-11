import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  guardRootWakeContext,
  observeRootWakeTrigger,
  RootWakeController,
  RootWakeOrphanWatch,
  XS_WAKE_CUSTOM_TYPE,
  type RootWakeDeps,
  type RootWakeMessage,
} from "../../src/fabric/root-wake.js";
import { classifyHumanInput } from "../../src/fabric/wake-input.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import { XsReplyNoticeGate } from "../../src/fabric/xs/reply-notice.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";

const trigger = (token: string, extra: object = {}) => ({
  messageType: "custom",
  message: {
    customType: XS_WAKE_CUSTOM_TYPE,
    details: { xsWake: true, wakeToken: token, ...extra },
  },
});
/** wake-unknown-optimistic: a `context` event whose trailing message is an xs wake marker (F4). */
const ctxEvent = (token: string | undefined, xid = "xid", trailing: unknown = undefined) => ({
  type: "context",
  messages: [
    { role: "user", content: "earlier" },
    trailing ?? {
      role: "custom",
      customType: XS_WAKE_CUSTOM_TYPE,
      content: "fenced content",
      timestamp: 0,
      details: { ...(token === undefined ? {} : { wakeToken: token }), xsWake: true, xid },
    },
  ],
});
const human = { source: "interactive", text: "human" } as const;
const userStart = { messageType: "user", prompt: "human" };
const request = (level?: number) => ({
  xid: "xid",
  from: { sessionId: "sender" },
  content: "fenced content",
  expiresAt: 5000,
  ...(level === undefined ? {} : { level }),
});

function harness(options: { deferred?: boolean; unknown?: boolean; overrides?: Partial<RootWakeDeps> } = {}) {
  const clock = new FakeClock(),
    ledger = new XsWakeLedger(),
    capability = new XsHostCapability();
  if (!options.unknown) capability.observe(userStart);
  const persisted: number[] = [];
  const level = createCausalLevel({
    maxLevel: 3,
    runLevel: () => undefined,
    raiseRun: () => {},
    initialRoot: 0,
    persistRoot: (l) => persisted.push(l),
  });
  const hostState = { idle: true, pending: false, foundXid: false };
  const messages: RootWakeMessage[] = [];
  const abort = vi.fn<() => void | Promise<void>>();
  const audit = vi.fn(),
    warn = vi.fn(),
    chargeInboundWake = vi.fn();
  let next = 0;
  const deps: RootWakeDeps = {
    sessionId: "session",
    rootRunMaxS: 60,
    wakeEnabled: true,
    receive: () => "wake",
    clock,
    ledger,
    capability,
    level,
    audit,
    warn,
    chargeInboundWake,
    newToken: () => `token-${++next}`,
    host: {
      isIdle: () => hostState.idle,
      hasPendingMessages: () => hostState.pending,
      sendMessage: (message, opts) => {
        expect(opts).toEqual({ triggerTurn: true });
        messages.push(message);
        hostState.idle = options.deferred === true;
      },
      abort,
      hasXid: () => hostState.foundXid,
    },
    ...options.overrides,
  };
  const controller = new RootWakeController(deps);
  const dispatch = (l?: number) => controller.dispatch(request(l));
  const bind = () => controller.beforeAgentStart(trigger(controller.activeToken!));
  return {
    controller,
    deps,
    clock,
    ledger,
    capability,
    hostState,
    messages,
    abort,
    audit,
    warn,
    chargeInboundWake,
    dispatch,
    bind,
    level,
    persisted,
  };
}

describe("RootWakeController §6.2 full lifecycle table", () => {
  it("idle → starting on synchronous !isIdle evidence; token lives only in details", () => {
    const h = harness();
    expect(h.dispatch(1)).toEqual({ dispatched: true, effect: "applied", woke: true, token: "token-1" });
    expect(h.controller.state).toBe("starting");
    expect(h.clock.pendingTimers).toBe(3);
    expect(h.ledger.get("token-1")).toMatchObject({ started: true, deadlineAt: 60000, state: "live" });
    expect(h.messages[0]).toEqual({
      customType: "subagent:xs",
      content: "fenced content",
      display: true,
      details: { xsWake: true, wakeToken: "token-1", xid: "xid", from: { sessionId: "sender" }, level: 1 },
    });
    expect(h.level.root).toBe(2);
    expect(h.chargeInboundWake).toHaveBeenCalledTimes(1);
  });

  it("dispatch owns BEFORE send and supports synchronous binding (reentrancy)", () => {
    const h = harness();
    h.deps.host.sendMessage = (message) => {
      expect(h.controller.busy).toBe(true);
      expect(h.ledger.get(message.details.wakeToken)?.state).toBe("live");
      expect(h.clock.pendingTimers).toBe(1);
      expect(h.controller.dispatch(request())).toMatchObject({ dispatched: false, wakeDowngraded: "busy" });
      h.hostState.idle = false;
      h.controller.beforeAgentStart(trigger(message.details.wakeToken));
    };
    expect(h.dispatch()).toMatchObject({ effect: "applied" });
    expect(h.controller.state).toBe("bound");
  });

  it("sync host rejection → none, idle, no ledger/timers/quota/level charge", () => {
    const h = harness();
    h.deps.host.sendMessage = () => {
      throw new Error("assertActive");
    };
    expect(h.dispatch(1)).toEqual({ dispatched: false, effect: "none", reason: "host_rejected", woke: false });
    expect(h.controller.state).toBe("idle");
    expect(h.ledger.size).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.level.root).toBe(0);
    expect(h.chargeInboundWake).not.toHaveBeenCalled();
  });

  it("idle → deferred on idle after send; S1 carry now, +1 ONLY on own actual start", () => {
    const h = harness({ deferred: true });
    expect(h.dispatch(1)).toEqual({
      dispatched: true,
      effect: "unknown",
      reason: "start_deferred",
      woke: true,
      token: "token-1",
    });
    expect(h.controller.state).toBe("deferred");
    expect(h.clock.pendingTimers).toBe(1);
    expect(h.level.root).toBe(1);
    h.controller.beforeAgentStart(userStart);
    h.controller.beforeAgentStart({ messageType: "custom", message: { customType: "other", details: {} } });
    h.controller.beforeAgentStart(trigger("some-other-token")); // orphan aborted, not our start
    expect(h.controller.state).toBe("deferred");
    expect(h.level.root).toBe(1);
    h.hostState.idle = false;
    h.bind();
    expect(h.controller.state).toBe("bound");
    expect(h.level.root).toBe(2);
    expect(h.capability.state).toBe("verified");
    h.level.resetRoot();
    h.bind(); // duplicate hook must not undo a human reset
    expect(h.level.root).toBe(0);
    expect(h.persisted).toEqual([1, 2, 0]);
  });

  it("starting and deferred matching token → bound; watchdog remains absolute from dispatch", () => {
    for (const deferred of [true, false]) {
      const h = harness({ deferred });
      h.dispatch();
      h.clock.advance(25000);
      h.hostState.idle = false;
      h.bind();
      expect(h.controller.state).toBe("bound");
      expect(h.ledger.get("token-1")?.boundAt).toBe(25000);
      h.clock.advance(34999);
      expect(h.abort).not.toHaveBeenCalled();
      h.clock.advance(1);
      expect(h.abort).toHaveBeenCalledTimes(1);
      expect(h.controller.state).toBe("aborting");
    }
  });

  it("10s slow-start is warning ONLY; pre-start compaction remains owned until execution deadline", () => {
    const h = harness();
    h.dispatch();
    h.clock.advance(10000);
    expect(h.controller.state).toBe("starting");
    expect(h.controller.busy).toBe(true);
    expect(h.audit).toHaveBeenCalledWith("wake_slow_start", "token-1");
    expect(h.abort).not.toHaveBeenCalled();
    h.clock.advance(49999);
    expect(h.controller.state).toBe("starting");
    h.clock.advance(1);
    expect(h.controller.state).toBe("aborting");
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it("deferred custom without message/details → presumed bound, sticky absent + warn once", () => {
    for (const event of [
      { messageType: "custom" },
      { messageType: "custom", message: { customType: "subagent:xs" } },
    ]) {
      const h = harness({ deferred: true });
      h.dispatch(1);
      h.hostState.idle = false;
      h.controller.beforeAgentStart(event);
      expect(h.controller.state).toBe("bound");
      expect(h.level.root).toBe(1); // presumed ownership is not actual token-start evidence (S1)
      expect(h.capability.state).toBe("absent");
      expect(h.warn).toHaveBeenCalledTimes(1);
      h.clock.advance(60000);
      expect(h.abort).toHaveBeenCalledTimes(1);
    }
  });

  it("presumed custom ownership cannot hand over or release a still-executable delayed token (B1)", () => {
    const h = harness({ deferred: true });
    h.dispatch(1);
    h.hostState.idle = false;
    h.controller.beforeAgentStart({ messageType: "custom" });
    h.controller.input(human);
    expect(h.controller.state).toBe("bound");
    expect(h.ledger.get("token-1")).toMatchObject({ started: false, executionPending: true, handed: false });
    h.controller.settled();
    expect(h.controller.state).toBe("idle");
    expect(h.ledger.get("token-1")).toMatchObject({ state: "tombstone", executionPending: false });
    h.clock.advance(100 * 365 * 24 * 3600 * 1000);
    h.controller.beforeAgentStart(trigger("token-1"));
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.level.root).toBe(1);
    h.controller.settled();
    expect(h.ledger.size).toBe(0);
  });

  it("aborting a presumed predecessor never exempts the later real token from B1", () => {
    const h = harness({ deferred: true });
    h.dispatch();
    h.hostState.idle = false;
    h.controller.beforeAgentStart({ messageType: "custom" });
    h.clock.advance(60000);
    expect(h.abort).toHaveBeenCalledTimes(1); // presumed predecessor run
    h.controller.settled();
    expect(h.ledger.get("token-1")?.started).toBe(false);
    h.controller.beforeAgentStart(trigger("token-1"));
    expect(h.abort).toHaveBeenCalledTimes(2); // a DIFFERENT run, the actual delayed action, still must abort
    h.controller.beforeAgentStart(trigger("token-1"));
    expect(h.abort).toHaveBeenCalledTimes(2);
    h.controller.settled();
    expect(h.ledger.size).toBe(0);
  });

  it("starting foreign/user start counts but never changes ownership", () => {
    const h = harness();
    h.dispatch();
    h.controller.beforeAgentStart(userStart);
    expect(h.controller.state).toBe("starting");
    expect(h.controller.activeToken).toBe("token-1");
    expect(h.audit).toHaveBeenCalledWith("wake_foreign_start", "token-1");
  });

  it("starting/bound settled → idle, and only missing never-bound xid reports lost-after-accept", () => {
    for (const bind of [false, true])
      for (const foundXid of [false, true]) {
        const h = harness();
        h.dispatch();
        h.hostState.foundXid = foundXid;
        if (bind) h.bind();
        h.controller.settled();
        expect(h.controller.state).toBe("idle");
        expect(h.ledger.size).toBe(0);
        expect(h.clock.pendingTimers).toBe(0);
        expect(h.audit.mock.calls.some(([event]) => event === "wake_lost_after_accept")).toBe(!bind && !foundXid);
      }
  });

  it("deferred settled belongs to predecessor; keeps waiting without idle observation", () => {
    const h = harness({ deferred: true });
    h.dispatch();
    h.controller.settled();
    h.clock.advance(20000);
    expect(h.controller.state).toBe("deferred");
    expect(h.ledger.size).toBe(1);
    expect(h.clock.pendingTimers).toBe(1);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("two consecutive 2s idle observations recover a missing agent_settled; a busy read resets the streak", () => {
    const h = harness();
    h.dispatch();
    h.hostState.idle = true;
    h.clock.advance(2000);
    expect(h.controller.state).toBe("starting");
    h.hostState.idle = false;
    h.clock.advance(2000);
    h.hostState.idle = true;
    h.clock.advance(2000);
    expect(h.controller.busy).toBe(true);
    h.clock.advance(2000);
    expect(h.controller.state).toBe("idle");
    expect(h.audit).toHaveBeenCalledWith("wake_end_unobserved", "token-1");
    expect(h.ledger.size).toBe(0);
  });

  it.each(["starting", "bound"] as const)(
    "%s human → handedOver; never abort even past arbitrary deadlines",
    (state) => {
      const h = harness();
      h.dispatch();
      if (state === "bound") h.bind();
      h.controller.input(human);
      expect(h.controller.state).toBe("handedOver");
      expect(h.ledger.get("token-1")).toMatchObject({ handed: true, started: true });
      expect(h.clock.pendingTimers).toBe(1);
      h.clock.advance(10 * 60000);
      h.bind();
      expect(h.abort).not.toHaveBeenCalled();
      expect(h.controller.state).toBe("handedOver");
      h.controller.settled();
      expect(h.controller.state).toBe("idle");
      expect(h.ledger.size).toBe(0);
    },
  );

  it("handedOver still occupies and its two-idle fallback releases", () => {
    const h = harness();
    h.dispatch();
    h.controller.input(human);
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "busy" });
    h.hostState.idle = true;
    h.clock.advance(4000);
    expect(h.controller.state).toBe("idle");
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("B1 deferred human is NOT handover: predecessor input cannot authorize an unstarted delayed action", () => {
    const h = harness({ deferred: true });
    h.dispatch(1);
    h.controller.input(human);
    expect(h.controller.state).toBe("deferred");
    expect(h.ledger.get("token-1")?.handed).toBe(false);
    h.clock.advance(60000);
    expect(h.controller.state).toBe("idle");
    expect(h.level.root).toBe(1);
    expect(h.ledger.get("token-1")).toMatchObject({ state: "tombstone", abortOnSight: true });
    h.hostState.idle = false;
    h.controller.beforeAgentStart(trigger("token-1"));
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.level.root).toBe(1); // no turn hop for a denied start
  });

  it("only proven interactive/rpc/browser attribution hands over; reinjection/machine/reload do not", () => {
    const h = harness();
    h.dispatch();
    for (const text of ["reinjected", "machine continue", "/agent reload fire"])
      h.controller.input({ source: "extension", text });
    expect(h.controller.state).toBe("starting");
    h.controller.input({ source: "extension", text: "not browser" }, () => undefined);
    expect(h.controller.state).toBe("starting");
    h.controller.input({ source: "extension", text: "browser" }, () => "web_prompt");
    expect(h.controller.state).toBe("handedOver");
    expect(classifyHumanInput({ source: "rpc", text: "x" })).toBe(true);
    expect(
      classifyHumanInput({ source: "extension", text: "x" }, () => {
        throw new Error("bad attribution");
      }),
    ).toBe(false);
  });

  it("aborting → stuck after 10s; never awaits abort, never aborts twice; settled releases", () => {
    const h = harness();
    h.abort.mockImplementation(() => new Promise<void>(() => {}));
    h.dispatch();
    h.clock.advance(60000);
    expect(h.controller.state).toBe("aborting");
    expect(h.clock.pendingTimers).toBe(2);
    h.controller.input(human);
    expect(h.controller.state).toBe("aborting");
    h.clock.advance(10000);
    expect(h.controller.state).toBe("stuck");
    expect(h.clock.pendingTimers).toBe(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("abortStuck", "token-1");
    h.clock.advance(120000);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.controller.dispatch({ ...request(), expiresAt: 999999 })).toMatchObject({ wakeDowngraded: "busy" });
    h.controller.settled();
    expect(h.controller.state).toBe("idle");
    expect(h.ledger.size).toBe(0);
  });

  it.each(["bound", "aborting", "stuck"] as const)("%s idle fallback does not depend on settled", (state) => {
    const h = harness();
    h.dispatch();
    h.bind();
    if (state !== "bound") h.clock.advance(state === "stuck" ? 70000 : 60000);
    expect(h.controller.state).toBe(state);
    h.hostState.idle = true;
    h.clock.advance(4000);
    expect(h.controller.state).toBe("idle");
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("abort errors are audited, not thrown or retried", async () => {
    for (const async of [false, true]) {
      const h = harness();
      h.abort.mockImplementation(() => {
        if (async) return Promise.reject(new Error("abort"));
        throw new Error("abort");
      });
      h.dispatch();
      h.clock.advance(60000);
      await Promise.resolve();
      expect(h.audit).toHaveBeenCalledWith("wake_abort_error", "token-1");
      h.clock.advance(10000);
      expect(h.controller.state).toBe("stuck");
      expect(h.abort).toHaveBeenCalledTimes(1);
    }
  });
});

describe("B1 process guard, delayed token and reload", () => {
  it("arbitrarily late deferred start still aborts before provider seam, no TTL/eviction", () => {
    const h = harness({ deferred: true });
    h.dispatch();
    h.clock.advance(100 * 365 * 24 * 3600 * 1000);
    expect(h.ledger.size).toBe(1);
    expect(h.clock.pendingTimers).toBe(0);
    const provider = vi.fn();
    let aborted = false;
    h.abort.mockImplementation(() => {
      aborted = true;
    });
    h.hostState.idle = false;
    const result = h.controller.beforeAgentStart(trigger("token-1"));
    if (!aborted) provider(); // fake host's first-request continuation, NOT a check of our return value
    expect(result.kind).toBe("aborted");
    expect(provider).not.toHaveBeenCalled();
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("wake_late_aborted", "token-1");
    expect(h.controller.state).toBe("aborting");
    h.controller.beforeAgentStart(trigger("token-1"));
    expect(h.abort).toHaveBeenCalledTimes(1);
    h.controller.settled();
    expect(h.ledger.size).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it.each([undefined, "not-in-ledger", "other-session"])(
    "orphan %s aborts even without controller and regardless of human input",
    (token) => {
      const h = harness();
      if (token === "other-session")
        h.ledger.put({ token, sessionId: "other", xid: "other-x", dispatchedAt: 0, deadlineAt: 60000 });
      h.controller.input(human);
      h.controller.dispose();
      const event =
        token === undefined
          ? { messageType: "custom", message: { customType: "subagent:xs", details: { xsWake: true } } }
          : trigger(token);
      expect(
        observeRootWakeTrigger(event, {
          sessionId: "session",
          abort: h.abort,
          ledger: h.ledger,
          capability: h.capability,
          clock: h.clock,
          audit: h.audit,
        }).kind,
      ).toBe("aborted");
      expect(h.abort).toHaveBeenCalledTimes(1);
      expect(h.audit).toHaveBeenCalledWith("wake_orphan_aborted", token);
    },
  );

  it("ordinary custom messages and non-wake xs deliveries never get caught by B1", () => {
    const h = harness();
    for (const event of [
      userStart,
      { messageType: "custom", message: { customType: "other", details: { xsWake: true } } },
      { messageType: "custom", message: { customType: "subagent:xs", details: { xid: "delivery-only" } } },
    ]) {
      expect(h.controller.beforeAgentStart(event)).toEqual({ kind: "other" });
    }
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("dispose clears timers but preserves live authorization; recover claims remaining absolute budget", () => {
    const h = harness();
    h.dispatch(1);
    h.clock.advance(50000);
    h.controller.dispose();
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.ledger.size).toBe(1);
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("bound");
    expect(next.activeToken).toBe("token-1");
    h.clock.advance(10000);
    expect(next.state).toBe("aborting");
    expect(h.abort).toHaveBeenCalledTimes(1);
    next.settled();
    expect(h.ledger.size).toBe(0);
  });

  it("recover does not steal a still-owned token; stale disposal cannot unclaim successor", () => {
    const h = harness();
    h.dispatch();
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("idle");
    h.controller.dispose();
    next.recover();
    expect(next.state).toBe("bound");
    h.controller.dispose();
    h.clock.advance(60000);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(next.state).toBe("aborting");
  });

  it("a valid trigger observed during stack replacement defers level commit until the port is available", () => {
    const h = harness({ deferred: true });
    h.dispatch(1);
    h.controller.dispose();
    h.hostState.idle = false;
    expect(
      observeRootWakeTrigger(trigger("token-1"), {
        sessionId: "session",
        abort: h.abort,
        ledger: h.ledger,
        capability: h.capability,
        clock: h.clock,
      }),
    ).toEqual({ kind: "authorized", token: "token-1" });
    expect(h.ledger.get("token-1")).toMatchObject({ started: true, levelCommitted: false });
    expect(h.level.root).toBe(1);
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("bound");
    expect(h.level.root).toBe(2);
    expect(h.ledger.get("token-1")?.levelCommitted).toBe(true);
  });

  it("recover handedOver preserves human ownership forever and never re-raises a reset level", () => {
    const h = harness();
    h.dispatch(1);
    h.controller.input(human);
    h.level.resetRoot();
    h.controller.dispose();
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("handedOver");
    expect(h.level.root).toBe(0);
    h.clock.advance(600000);
    expect(h.abort).not.toHaveBeenCalled();
    next.settled();
    expect(h.ledger.size).toBe(0);
  });

  it("recover deferred during unrelated predecessor stays deferred, no false handover/level hop", () => {
    const h = harness({ deferred: true });
    h.dispatch(1);
    h.hostState.idle = false;
    h.controller.dispose();
    const next = new RootWakeController(h.deps);
    next.recover();
    next.input(human);
    expect(next.state).toBe("deferred");
    expect(h.level.root).toBe(1);
    next.settled();
    expect(next.state).toBe("deferred");
    h.clock.advance(60000);
    expect(next.state).toBe("idle");
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("recover presumed-bound keeps the watchdog but does not manufacture own-token evidence", () => {
    const h = harness({ deferred: true });
    h.dispatch(1);
    h.hostState.idle = false;
    h.controller.beforeAgentStart({ messageType: "custom" });
    h.controller.dispose();
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("bound");
    next.input(human);
    expect(next.state).toBe("bound");
    expect(h.level.root).toBe(1);
    next.settled();
    expect(h.ledger.get("token-1")).toMatchObject({ state: "tombstone", executionPending: false });
    const later = new RootWakeController(h.deps);
    later.recover();
    expect(later.state).toBe("idle"); // an unrelated new run cannot resurrect ended presumed ownership
  });

  it("idle/foreign-session records revoke on recovery, but are not forgotten", () => {
    const h = harness();
    h.dispatch();
    h.controller.dispose();
    h.hostState.idle = true;
    h.ledger.put({ token: "foreign", sessionId: "elsewhere", xid: "x", dispatchedAt: 0, deadlineAt: 60000 });
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("idle");
    expect(h.ledger.size).toBe(2);
    expect(h.ledger.entries().every((e) => e.state === "tombstone" && e.abortOnSight)).toBe(true);
  });

  it("a recovery contender cannot own an old aborted token alongside a new session token", () => {
    const h = harness({ deferred: true });
    h.dispatch();
    h.controller.dispose();
    const old = new RootWakeController(h.deps);
    old.recover(); // idle => tombstone
    h.hostState.idle = false;
    old.beforeAgentStart(trigger("token-1"));
    old.dispose();
    h.hostState.idle = true;
    const next = new RootWakeController(h.deps);
    next.recover();
    h.deps.host.sendMessage = () => {
      h.hostState.idle = false;
    };
    expect(next.dispatch(request())).toMatchObject({ dispatched: true });
    const contender = new RootWakeController(h.deps);
    contender.recover();
    expect(next.state).toBe("starting");
    expect(contender.state).toBe("idle");
    expect(h.ledger.hasOwner("session")).toBe(true);
  });

  it("recover expired/aborting run uses original deadline and original abort grace", () => {
    const h = harness();
    h.dispatch();
    h.controller.dispose();
    h.clock.advance(60001);
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("aborting");
    expect(h.abort).toHaveBeenCalledTimes(1);
    h.clock.advance(5000);
    next.dispose();
    const third = new RootWakeController(h.deps);
    third.recover();
    h.clock.advance(5000);
    expect(third.state).toBe("stuck");
    expect(h.abort).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch guard/downgrade seam (§4.5, X4 handles only-delivery)", () => {
  it.each([
    ["wake_disabled", { wakeEnabled: false }],
    ["controller_disabled", { rootRunMaxS: 0 }],
    ["receiver_policy", { receive: () => "deliver" as const }],
    ["inbound_wake_rate", { inboundWakeAvailable: () => false }],
  ] as const)("%s never dispatches a run", (reason, overrides) => {
    const h = harness({ overrides });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: reason });
    expect(h.messages).toHaveLength(0);
    expect(h.ledger.size).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("absent (legacy prompt shape) is permanently deliver-only (wake-unknown-optimistic keeps this half)", () => {
    const h = harness();
    h.controller.beforeAgentStart({ prompt: "old peer" });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "host_unsupported" });
    expect(h.messages).toHaveLength(0);
  });

  it("idle with pending, non-idle, chain depth and full ledger downgrade without sending", () => {
    const h = harness();
    h.hostState.pending = true;
    expect(h.dispatch()).toMatchObject({ wakeDowngraded: "busy" });
    h.hostState.pending = false;
    h.hostState.idle = false;
    expect(h.dispatch()).toMatchObject({ wakeDowngraded: "busy" });
    h.hostState.idle = true;
    expect(h.dispatch(3)).toMatchObject({ wakeDowngraded: "level_limit" });
    for (let i = 0; i < h.ledger.capacity; i++) {
      h.ledger.put({ token: `old-${i}`, sessionId: "old", xid: "old", dispatchedAt: -99999999, deadlineAt: -9999999 });
      h.ledger.tombstone(`old-${i}`);
    }
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "ledger_full" });
    expect(h.messages).toHaveLength(0);
    expect(h.ledger.size).toBe(8);
  });

  it("expires/off/fence/sessionGen failures are none, not a wake downgrade", () => {
    const h = harness({ overrides: { guard: () => "fenced:switch" } });
    expect(h.dispatch()).toMatchObject({ effect: "none", reason: "fenced:switch" });
    const off = harness({ overrides: { receive: () => "off" } });
    expect(off.dispatch()).toMatchObject({ effect: "none", reason: "rejected" });
    const expired = harness();
    expired.clock.advance(5000);
    expect(expired.dispatch()).toMatchObject({ effect: "none", reason: "expired" });
    expired.controller.dispose();
    expect(expired.dispatch()).toMatchObject({ effect: "none", reason: "session_changed" });
  });
});

describe("RX5 solicited return wakes", () => {
  it("replies permits only solicited wakes; deliver still forbids them (R2)", () => {
    const h = harness({ overrides: { receive: () => "replies" } });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "receiver_policy" });
    expect(h.controller.dispatch({ ...request(99), solicited: true, returnLevel: 2 })).toMatchObject({
      dispatched: true,
    });
    expect(h.level.root).toBe(2);
    expect(h.ledger.entries()[0]).toMatchObject({ level: 2, levelMode: "return", levelCommitted: true });
    const d = harness({ overrides: { receive: () => "deliver" } });
    expect(d.controller.dispatch({ ...request(), solicited: true, returnLevel: 2 })).toEqual({
      dispatched: false,
      wakeDowngraded: "receiver_policy",
    });
    expect(d.messages).toHaveLength(0);
  });

  it("solicited skips hopAllowed and never increments the return level", () => {
    const h = harness();
    expect(h.controller.dispatch({ ...request(99), solicited: true, returnLevel: 9 })).toMatchObject({
      dispatched: true,
    });
    expect(h.level.root).toBe(9); // beyond maxLevel=3, and NOT 10
    expect(h.chargeInboundWake).toHaveBeenCalledOnce();
    expect(h.messages[0]?.details.level).toBe(9);
    h.bind();
    expect(h.level.root).toBe(9);
  });

  it("deferred return survives reload, commits once at real start, never re-raises after human reset", () => {
    const h = harness({ deferred: true, overrides: { receive: () => "replies" } });
    expect(h.controller.dispatch({ ...request(), solicited: true, returnLevel: 2 })).toMatchObject({
      effect: "unknown",
    });
    const token = h.controller.activeToken!;
    expect(h.ledger.get(token)).toMatchObject({ levelMode: "return", levelCommitted: false });
    h.level.resetRoot();
    h.controller.dispose();
    h.hostState.idle = false;
    const replacement = new RootWakeController(h.deps);
    replacement.recover();
    expect(h.level.root).toBe(0); // recovery of a deferred token is NOT start evidence
    replacement.beforeAgentStart(trigger(token));
    expect(h.level.root).toBe(2);
    expect(h.ledger.get(token)?.levelCommitted).toBe(true);
    h.level.resetRoot();
    replacement.beforeAgentStart(trigger(token));
    expect(h.level.root).toBe(0);
    replacement.dispose();
  });

  it("solicited still obeys wake quota and orphan authorization", () => {
    for (const overrides of [{ inboundWakeAvailable: () => false }, { wakeEnabled: false }]) {
      const h = harness({ overrides });
      const r = h.controller.dispatch({ ...request(), solicited: true, returnLevel: 0 });
      expect(r.dispatched).toBe(false);
      expect(h.messages).toHaveLength(0);
    }
    const h = harness({ deferred: true });
    h.controller.dispatch({ ...request(), solicited: true, returnLevel: 0 });
    const token = h.controller.activeToken!;
    h.clock.advance(60_000);
    expect(h.controller.beforeAgentStart(trigger(token)).kind).toBe("aborted");
    expect(h.abort).toHaveBeenCalledOnce();
  });

  it("wake request keeps inbound reply stamp out of content and in details", () => {
    const h = harness();
    h.controller.dispatch({ ...request(), reply: { requestId: "qabc", dueAt: 4000 } });
    expect(h.messages[0]?.details.reply).toEqual({ requestId: "qabc", dueAt: 4000 });
    expect(h.messages[0]?.content).toBe("fenced content");
  });
});

it("RX5 NoticeGate directly accepts the real Controller port and returns requester level", () => {
  const h = harness({ overrides: { receive: () => "replies" } });
  const ledger = new XsReplyLedger({ clock: h.clock });
  const issue = ledger.issue({
    requesterSessionId: "session",
    replierSessionId: "peer",
    replierRef: "peer",
    origin: "model",
    wakeOnReply: true,
    requesterLevel: 2,
    timeoutMs: 60_000,
    lateGraceMs: 600_000,
    maxPending: 8,
    maxPendingPerTarget: 3,
  });
  if (!issue.ok) throw new Error("issue failed");
  const quiet = vi.fn();
  const gate = new XsReplyNoticeGate({
    ledger,
    sessionId: "session",
    getSessionId: () => "session",
    disposed: () => false,
    joined: () => true,
    receive: () => "replies",
    fence: createSessionFence({ clock: h.clock }),
    controller: h.controller,
    host: { sendMessage: quiet },
    clock: h.clock,
  });
  h.clock.advance(60_000);
  expect(gate.flush()).toEqual({ written: "wake", requestIds: [issue.ticket.requestId] });
  expect(h.level.root).toBe(2);
  expect(h.messages[0]?.details.from).toEqual({ kind: "local", reason: "reply_timeout" });
  expect(h.chargeInboundWake).toHaveBeenCalledOnce();
  expect(quiet).not.toHaveBeenCalled();
  gate.dispose();
  h.controller.dispose();
});

describe("channel-plan §5.3 (CH3): RootWakeRequest.bc is threaded into details only", () => {
  it("bc rides details.bc; content is untouched; no bc ⇒ details carry no bc key", () => {
    const h = harness();
    expect(h.controller.dispatch({ ...request(0), bc: { channel: "team" } })).toMatchObject({ dispatched: true });
    const message = h.messages[0]!;
    expect(message.details.bc).toEqual({ channel: "team" });
    expect(message.content).toBe("fenced content");
    expect(JSON.stringify(message.content)).not.toContain("token-");
    const plain = harness();
    plain.dispatch(0);
    expect("bc" in plain.messages[0]!.details).toBe(false);
    expect(Object.keys(plain.messages[0]!.details)).toEqual(["xsWake", "xid", "from", "wakeToken", "level"]);
  });
});

/**
 * wake-unknown-optimistic (docs/dev/fabric-cross-session/wake-unknown-optimistic-plan.md §1/§5.4):
 * capability `unknown` dispatches optimistically; the first run is authorized by BAS (union hosts)
 * or aborted at its first `context` sight before any provider request (legacy hosts, F1). Every
 * case below drives the real guard pair over the real ledger.
 */
describe("wake-unknown-optimistic: dispatch + first-run verification", () => {
  it("1. unknown + union BAS ⇒ verified, bound, +1 at authorization, record carries authorizedAt", () => {
    const h = harness({ unknown: true });
    expect(h.dispatch(1)).toEqual({ dispatched: true, effect: "applied", woke: true, token: "token-1" });
    expect(h.controller.state).toBe("starting");
    expect(h.level.root).toBe(1); // optimistic dispatch only carries
    expect(h.audit).toHaveBeenCalledWith("wake_optimistic_dispatch", "token-1");
    h.bind(); // the run's BAS carries our custom token
    expect(h.controller.state).toBe("bound");
    expect(h.capability.state).toBe("verified");
    expect(h.capability.optimistic).toBe(false);
    expect(h.level.root).toBe(2); // the hop commits exactly when BAS authorizes
    expect(h.ledger.get("token-1")).toMatchObject({
      optimistic: true,
      authorizedAt: 0,
      started: true,
      levelCommitted: true,
    });
    h.controller.settled();
    h.hostState.idle = true;
    expect(h.controller.dispatch({ ...request(), expiresAt: 9_999_999 })).toMatchObject({
      dispatched: true,
    }); // verified hosts keep dispatching (non-optimistic now)
    expect(h.ledger.get(h.controller.activeToken!)).toMatchObject({ levelCommitted: true });
    expect(h.level.root).toBe(2); // level-less dispatch tracks nothing
  });

  it("2. legacy starting: the run's first context sight aborts once, absent, second wake host_unsupported", () => {
    const h = harness({ unknown: true });
    expect(h.dispatch()).toMatchObject({ effect: "applied", woke: true });
    const token = h.controller.activeToken!;
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token });
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.controller.state).toBe("aborting");
    expect(h.capability.state).toBe("absent");
    expect(h.audit).toHaveBeenCalledWith("wake_shape_absent_aborted", token);
    expect(h.ledger.get(token)).toMatchObject({
      state: "tombstone",
      started: true,
      executionPending: true,
      levelCommitted: true,
      gateSightAt: 0,
      abortIssuedAt: 0,
    });
    h.controller.settled();
    expect(h.controller.dispatch({ ...request(), expiresAt: 9_999_999 })).toEqual({
      dispatched: false,
      wakeDowngraded: "host_unsupported",
    });
  });

  it("3a. legacy deferred: the human prompt's legacy BAS never aborts; the queued run's context aborts once", () => {
    const h = harness({ unknown: true, deferred: true });
    expect(h.dispatch()).toMatchObject({ effect: "unknown", reason: "start_deferred", woke: true });
    const token = h.controller.activeToken!;
    h.hostState.idle = false; // the human prompt's run starts first (F2 settle delay)
    expect(h.controller.beforeAgentStart({ prompt: "human" })).toEqual({ kind: "other" }); // a user trigger is not a wake marker
    expect(h.controller.state).toBe("deferred"); // not our run: no handover, no abort
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.capability.state).toBe("absent"); // {prompt} with no messageType = legacy shape
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token }); // queued run reaches context
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.controller.state).toBe("aborting");
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_aborted")).toHaveLength(1);
  });

  it("3b. legacy deferred past its deadline: the tombstoned queued run still aborts exactly once at context", () => {
    const h = harness({ unknown: true, deferred: true });
    h.dispatch();
    const token = h.controller.activeToken!;
    h.clock.advance(60_000); // deferred deadline: tombstone + release, NO abort yet
    expect(h.controller.state).toBe("idle");
    expect(h.abort).not.toHaveBeenCalled();
    h.hostState.idle = false; // the queued run finally executes
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token });
    expect(h.controller.state).toBe("aborting"); // claimed while idle (late-tombstone claim)
    h.controller.context(ctxEvent(token));
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_aborted")).toHaveLength(1);
  });

  it.each([false, true])(
    "4. optimistic dispatch + BAS custom without readable details (deferred=%s): absent, abort once, later context silent",
    (deferred) => {
      const h = harness({ unknown: true, deferred });
      h.dispatch(1);
      const token = h.controller.activeToken!;
      expect(h.controller.beforeAgentStart({ messageType: "custom" })).toEqual({ kind: "other" }); // no customType ⇒ not our marker
      expect(h.capability.state).toBe("absent");
      expect(h.controller.state).toBe("aborting");
      expect(h.abort).toHaveBeenCalledTimes(1);
      expect(h.audit).toHaveBeenCalledWith("wake_shape_absent_aborted", token);
      expect(h.ledger.get(token)).toMatchObject({
        state: "tombstone",
        started: true,
        levelCommitted: true,
        gateSightAt: 0,
        abortIssuedAt: 0,
      });
      expect(h.level.root).toBe(1); // the optimistic hop stays a carry forever
      expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token }); // gateSightAt set ⇒ silent
      expect(h.abort).toHaveBeenCalledTimes(1);
      expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_aborted")).toHaveLength(1);
    },
  );

  it("5. handed-over optimistic token: context never aborts, audits once, later authorization raises nothing", () => {
    const h = harness({ unknown: true });
    h.dispatch(1);
    h.controller.input(human); // starting + started ⇒ handedOver
    const token = h.controller.activeToken!;
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "other" });
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith("wake_shape_absent_handed", token);
    expect(h.capability.state).toBe("absent");
    expect(h.ledger.get(token)).toMatchObject({ handed: true, gateSightAt: 0, levelCommitted: true });
    expect(h.controller.state).toBe("handedOver");
    h.controller.beforeAgentStart(trigger(token)); // a late authorization cannot raise the voided hop
    expect(h.level.root).toBe(1);
    expect(h.controller.state).toBe("handedOver");
    h.controller.context(ctxEvent(token)); // gateSightAt set ⇒ other
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_handed")).toHaveLength(1);
  });

  it("6. repeated context sights of one token: exactly one abort and one audit entry", () => {
    const h = harness({ unknown: true, deferred: true });
    h.dispatch();
    const token = h.controller.activeToken!;
    for (let i = 0; i < 3; i++) expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token });
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_aborted")).toHaveLength(1);
  });

  it("7. after a BAS tombstone abort, a context sight of the same run is 0/0", () => {
    const h = harness({ unknown: true, deferred: true });
    h.dispatch();
    const token = h.controller.activeToken!;
    h.clock.advance(60_000); // deferred deadline: tombstone, released
    h.hostState.idle = false;
    expect(h.controller.beforeAgentStart(trigger(token)).kind).toBe("aborted");
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("wake_late_aborted", token);
    expect(h.controller.state).toBe("aborting");
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token }); // gateSightAt set by the BAS sight
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_late_aborted")).toHaveLength(1);
  });

  it("8. after the deadline abort (started, abortIssuedAt set), a context sight adds no abort/audit", () => {
    const h = harness({ unknown: true });
    h.dispatch();
    const token = h.controller.activeToken!;
    h.clock.advance(60_000); // deadline: aborting, abort once
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.controller.state).toBe("aborting");
    expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "aborted", token });
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_shape_absent_aborted")).toHaveLength(0);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_late_aborted")).toHaveLength(0);
    expect(h.ledger.get(token)).toMatchObject({ gateSightAt: 60_000, abortIssuedAt: 60_000 });
  });

  it("9. context-guard orphans (no token / not in ledger / xid mismatch): one abort per run via the watch, a new run aborts again", () => {
    const h = harness({ unknown: true });
    h.dispatch(); // a known record for xid "xid" (token-1)
    const known = h.controller.activeToken!;
    const watch = new RootWakeOrphanWatch({ clock: h.clock, audit: h.audit, warn: h.warn });
    const port = { abort: h.abort, isIdle: () => false };
    const deps = {
      sessionId: "session",
      abort: h.abort,
      ledger: h.ledger,
      capability: h.capability,
      clock: h.clock,
      audit: h.audit,
      warn: h.warn,
      orphan: (t: string | undefined) => watch.issue(port, t),
    };
    expect(guardRootWakeContext(ctxEvent(undefined), deps)).toEqual({ kind: "aborted" });
    expect(guardRootWakeContext(ctxEvent("not-in-ledger"), deps)).toEqual({ kind: "aborted", token: "not-in-ledger" });
    expect(guardRootWakeContext(ctxEvent(known, "WRONG"), deps)).toEqual({ kind: "aborted", token: known }); // xid mismatch
    expect(h.abort).toHaveBeenCalledTimes(1); // ONE abort for the whole run (latch)
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_orphan_aborted")).toHaveLength(1);
    watch.settled(); // the run ends
    expect(guardRootWakeContext(ctxEvent("not-in-ledger"), deps)).toEqual({ kind: "aborted", token: "not-in-ledger" });
    expect(h.abort).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls.filter(([e]) => e === "wake_orphan_aborted")).toHaveLength(2);
    watch.dispose();
    expect(h.clock.pendingTimers).toBeGreaterThanOrEqual(1); // the controller's own timers remain
  });

  it("10. an authorized live token stays authorized across repeated context sights (retries)", () => {
    const h = harness();
    h.dispatch();
    const token = h.controller.activeToken!;
    h.bind(); // BAS authorization
    for (let i = 0; i < 3; i++) expect(h.controller.context(ctxEvent(token))).toEqual({ kind: "authorized", token });
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.capability.state).toBe("verified");
    expect(h.controller.state).toBe("bound");
  });

  it("11. /reload of an optimistic deferred record: recover commits no optimistic hop; context claims and aborts once", () => {
    const h = harness({ unknown: true, deferred: true });
    h.dispatch(1);
    const token = h.controller.activeToken!;
    h.clock.advance(60_000); // deferred deadline: tombstone, released
    h.controller.dispose();
    const next = new RootWakeController(h.deps);
    next.recover();
    expect(next.state).toBe("idle"); // idle recovery revokes but claims nothing
    expect(h.level.root).toBe(1); // recover never commits an optimistic hop
    h.hostState.idle = false; // the queued run finally executes on the legacy host
    expect(next.context(ctxEvent(token))).toEqual({ kind: "aborted", token });
    expect(next.state).toBe("aborting");
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.level.root).toBe(1); // still carry only
    next.settled();
    expect(h.ledger.size).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("union-host non-marker tails and post-marker tails are `other` (O(1), no scans)", () => {
    const h = harness({ unknown: true });
    h.dispatch();
    expect(h.controller.context({ type: "context", messages: [] })).toEqual({ kind: "other" });
    expect(h.controller.context({ type: "context", messages: [{ role: "assistant", content: "a" }] })).toEqual({
      kind: "other",
    });
    expect(
      h.controller.context({
        type: "context",
        messages: [
          { role: "user", content: "u" },
          { role: "custom", customType: "other:custom", details: { xsWake: true } },
        ],
      }),
    ).toEqual({ kind: "other" });
    expect(
      h.controller.context(
        ctxEvent(h.controller.activeToken!, "xid", { role: "custom", customType: XS_WAKE_CUSTOM_TYPE, details: null }),
      ),
    ).toEqual({ kind: "other" }); // marker type but details not an object with xsWake
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.controller.state).toBe("starting");
  });
});

describe("RootWakeOrphanWatch (wake-unknown-optimistic §1.4)", () => {
  it("issue dedups per run; a never-settling abort goes stuck after the grace, never aborts twice; two idles release", () => {
    const clock = new FakeClock();
    const audit = vi.fn(),
      warn = vi.fn(),
      abort = vi.fn();
    const watch = new RootWakeOrphanWatch({ clock, audit, warn });
    expect(watch.issue({ abort, isIdle: () => false }, "tok")).toBe(true);
    expect(watch.issue({ abort, isIdle: () => false }, "tok")).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimers).toBe(2); // grace + idle poll
    clock.advance(9_999);
    expect(audit).not.toHaveBeenCalledWith("abortStuck", "tok");
    clock.advance(1);
    expect(audit).toHaveBeenCalledWith("abortStuck", "tok");
    expect(warn).toHaveBeenCalledTimes(1);
    clock.advance(120_000);
    expect(abort).toHaveBeenCalledTimes(1); // stuck never aborts a second time
    watch.dispose(); // stop the stuck watch's perpetual idle observation
    // release path: two consecutive idle observations clear latch AND timers
    const watch2 = new RootWakeOrphanWatch({ clock, audit, warn });
    let idle = false;
    expect(watch2.issue({ abort, isIdle: () => idle }, "t2")).toBe(true);
    idle = true;
    clock.advance(4_000);
    expect(watch2.pending).toBe(false);
    expect(watch2.issue({ abort, isIdle: () => false }, "t3")).toBe(true); // re-armed after release
    watch2.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it("a busy host never releases via idle; settled / runStarted / dispose each clear every timer and the latch", () => {
    for (const release of ["settled", "runStarted", "dispose"] as const) {
      const clock = new FakeClock();
      const watch = new RootWakeOrphanWatch({ clock, audit: vi.fn(), warn: vi.fn() });
      expect(watch.issue({ abort: vi.fn(), isIdle: () => false }, "t")).toBe(true);
      expect(clock.pendingTimers).toBe(2);
      clock.advance(6_000); // three busy observations: still latched
      expect(watch.pending).toBe(true);
      watch[release]();
      expect(clock.pendingTimers).toBe(0);
      expect(watch.pending).toBe(false);
    }
  });
});
