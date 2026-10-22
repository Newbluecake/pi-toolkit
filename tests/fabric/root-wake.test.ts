import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  observeRootWakeTrigger,
  RootWakeController,
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

  it("only proven interactive/rpc/browser attribution hands over; reinjection/goal/reload do not", () => {
    const h = harness();
    h.dispatch();
    for (const text of ["reinjected", "/goal continue", "/agent reload fire"])
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
    ["goal", { goalRunning: () => true }],
    ["inbound_wake_rate", { inboundWakeAvailable: () => false }],
  ] as const)("%s never dispatches a run", (reason, overrides) => {
    const h = harness({ overrides });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: reason });
    expect(h.messages).toHaveLength(0);
    expect(h.ledger.size).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("unknown is only delivery until observed; absent is permanently only delivery (N1)", () => {
    const h = harness({ unknown: true });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "host_unverified" });
    expect(h.messages).toHaveLength(0);
    h.controller.beforeAgentStart(userStart);
    expect(h.dispatch()).toMatchObject({ dispatched: true });
    h.controller.settled();
    h.hostState.idle = true;
    h.controller.beforeAgentStart({ prompt: "old peer" });
    expect(h.dispatch()).toEqual({ dispatched: false, wakeDowngraded: "host_unsupported" });
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

  it("solicited still obeys wake quota, goal and orphan authorization", () => {
    for (const overrides of [
      { inboundWakeAvailable: () => false },
      { goalRunning: () => true },
      { wakeEnabled: false },
    ]) {
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
