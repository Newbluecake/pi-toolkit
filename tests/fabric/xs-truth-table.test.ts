import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createCausalLevel, type CausalLevel } from "../../src/fabric/wake-level.js";
import { RootWakeController } from "../../src/fabric/root-wake.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { XsReplyLedger, createXsReplyInboxPort } from "../../src/fabric/xs/reply-ledger.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import { XsReceiver, type XsDeliverInput } from "../../src/fabric/xs/receiver.js";

/**
 * fabric phase-2 X4 (phase2-plan §4.5 + §11.2 X4 行): the switch truth table, ROW BY ROW
 * (表驱动，行即用例). The receiver is the REAL pipeline; every wake row runs the REAL
 * RootWakeController (R1) — its `dispatch` owns the wake-column verdicts — with a fake host
 * that simulates the pi facts the table rests on (Fpi2: `triggerTurn:true` ⇒ !isIdle
 * synchronously; Fpi5: deferred when still idle).
 *
 * Cross-session traffic NEVER falls back to an unsupervised legacy `triggerTurn:true` /
 * steer: every `wake:true` row either reaches Controller.dispatch or lands as deliver-only
 * with an explicit `wakeDowngraded` token (review #8).
 */

const SESSION = "sess-truth-0123456789";
const SENDER = "sess-sender-9876543210";

interface StackOptions {
  replies?: boolean;
  wakeEnabled?: boolean; // receiver's fabric.wake.enabled (default true)
  rootRunMaxS?: number; // default 900
  maxLevel?: number; // default 2
  receive?: "off" | "deliver" | "wake" | "replies"; // session receive (default wake)
  capability?: "unknown" | "observed" | "absent";
  hostIdle?: boolean; // default true
  hostFlipsOnTrigger?: boolean; // Fpi2 simulation (default true)
  goalFence?: boolean; // goal port active
  wakeQuotaSpent?: number; // pre-charged wakesInPerHour
}

interface Stack {
  receiver: XsReceiver;
  setIdle(idle: boolean): void;
  ledger: XsReplyLedger;
  replyInbox: XsInbox;
  fence: ReturnType<typeof createSessionFence>;
  controller: RootWakeController | undefined;
  membership: XsMembership;
  level: CausalLevel;
  clock: FakeClock;
  sent: { triggerTurn: boolean; details?: unknown }[];
  input(over?: Partial<XsDeliverInput>): XsDeliverInput;
}

function buildStack(options: StackOptions = {}): Stack {
  const clock = new FakeClock(1_000);
  const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
  membership.attach();
  membership.join();
  if ((options.receive ?? "wake") !== "wake") membership.setReceive(options.receive ?? "wake");

  let idle = options.hostIdle ?? true;
  const sent: { triggerTurn: boolean; details?: unknown }[] = [];
  const leaves: { type: string; customType?: string; details?: unknown }[] = [];
  const hostCtl = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sendMessage: (message: { customType: string; details?: unknown }, opts: { triggerTurn: boolean }) => {
      sent.push({ triggerTurn: opts.triggerTurn, details: message.details });
      if (opts.triggerTurn) {
        if (options.hostFlipsOnTrigger ?? true) idle = false; // Fpi2
      } else if (idle) {
        // Fpi7: idle + triggerTurn:false ⇒ synchronous session-tree append (leaf evidence)
        leaves.push({ type: "custom_message", customType: message.customType, details: message.details });
      }
    },
    getLeafEntry: () => leaves.at(-1),
    abort: () => {},
    hasXid: () => false,
  };

  const fence = createSessionFence({
    clock,
    ...(options.goalFence ? { ports: { goal: () => true } } : {}),
  });
  const inbox = new XsInbox(12, clock);
  const dedup = new XsDedup(256, clock);
  const replyInbox = new XsInbox(8, clock);
  const ledger = new XsReplyLedger({ clock });
  ledger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(replyInbox) });
  const persistLog: number[] = [];
  const level = createCausalLevel({
    maxLevel: options.maxLevel ?? 2,
    initialRoot: 0,
    runLevel: () => undefined,
    raiseRun: () => {},
    persistRoot: (v) => persistLog.push(v),
  });

  const receiver = new XsReceiver({
    sessionId: SESSION,
    membership,
    fence,
    inbox,
    ...(options.replies ? { replyLedger: ledger } : {}),
    recvPerHour: 30,
    wakesInPerHour: 12,
    host: hostCtl,
    dedup,
    clock,
    warn: () => {},
    ...(options.wakeEnabled === false ? {} : { level }),
  });

  let controller: RootWakeController | undefined;
  if (options.wakeEnabled !== false) {
    const capability = new XsHostCapability();
    if (options.capability === "observed") capability.observe({ messageType: "user", prompt: "hi" });
    if (options.capability === "absent") capability.observe({ prompt: "hi" }); // pi 1.0/1.1 legacy shape
    let wakeCharges = options.wakeQuotaSpent ?? 0;
    controller = new RootWakeController({
      sessionId: SESSION,
      rootRunMaxS: options.rootRunMaxS ?? 900,
      wakeEnabled: true,
      receive: () => membership.receive,
      host: hostCtl,
      guard: () => undefined,
      goalRunning: () => false,
      inboundWakeAvailable: () => wakeCharges < 12,
      chargeInboundWake: () => {
        wakeCharges++;
      },
      level,
      ledger: new XsWakeLedger(),
      capability,
      clock,
      newToken: (() => {
        let n = 0;
        return () => `tok-${++n}`;
      })(),
      audit: () => {},
      warn: () => {},
    });
    receiver.setController(controller);
    for (let i = 0; i < (options.wakeQuotaSpent ?? 0); i++) receiver.chargeWake();
  }

  function input(over: Partial<XsDeliverInput> = {}): XsDeliverInput {
    return {
      xid: `xid-${Math.random().toString(36).slice(2, 10)}`,
      to: { sessionId: SESSION, epoch: membership.epoch },
      from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/x", agentId: "ag" },
      text: "wake me",
      wake: false,
      expiresAt: clock.now() + 5_000,
      ...over,
    };
  }
  return {
    receiver,
    controller,
    membership,
    level,
    clock,
    sent,
    input,
    ledger,
    replyInbox,
    fence,
    setIdle: (value) => {
      idle = value;
    },
  };
}

describe("xs truth table §4.5 (row by row)", () => {
  it("row 1: wake omitted/false, root idle ⇒ deliver-only applied (triggerTurn:false, sync evidence)", () => {
    const s = buildStack();
    const verdict = s.receiver.deliver(s.input({ wake: false }));
    expect(verdict).toEqual({ effect: "applied", woke: false });
    expect(s.sent).toEqual([expect.objectContaining({ triggerTurn: false })]);
  });

  it("row 2: wake omitted/false, root streaming ⇒ unknown{queued} (pi memory queue)", () => {
    const s = buildStack({ hostIdle: false });
    expect(s.receiver.deliver(s.input({ wake: false }))).toEqual({ effect: "unknown", reason: "queued", woke: false });
    expect(s.sent).toHaveLength(1);
  });

  it("row 3: receive off ⇒ none{rejected} (wake or not)", () => {
    const s = buildStack({ receive: "off" });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({ effect: "none", reason: "rejected", woke: false });
    expect(s.receiver.deliver(s.input())).toEqual({ effect: "none", reason: "rejected", woke: false });
    expect(s.sent).toEqual([]);
  });

  it("row 4: wake:true, receiver fabric.wake.enabled=false ⇒ deliver-only wake_disabled, level NOT tracked", () => {
    const s = buildStack({ wakeEnabled: false });
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 1 }));
    expect(verdict).toEqual({ effect: "applied", woke: false, wakeDowngraded: "wake_disabled" });
    expect(s.sent[0]!.triggerTurn).toBe(false);
    expect(s.level.root).toBe(0); // 不跟踪 (no CausalLevel wired on the receiver)
  });

  it("row 5: wake:true, rootRunMaxS=0 ⇒ deliver-only controller_disabled", () => {
    const s = buildStack({ rootRunMaxS: 0, capability: "observed" });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "controller_disabled",
    });
  });

  it("row 6: capability unknown ⇒ host_unverified; absent ⇒ host_unsupported (N1, fail closed)", () => {
    const u = buildStack({ capability: "unknown" });
    expect(u.receiver.deliver(u.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "host_unverified",
    });
    const a = buildStack({ capability: "absent" });
    expect(a.receiver.deliver(a.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "host_unsupported",
    });
  });

  it("row 7: capability observed but receive=deliver ⇒ deliver-only receiver_policy", () => {
    const s = buildStack({ capability: "observed", receive: "deliver" });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "receiver_policy",
    });
  });

  it("row 8a: root busy (run active) ⇒ deliver-only busy (queued while streaming)", () => {
    const s = buildStack({ capability: "observed", hostIdle: false });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "unknown",
      reason: "queued",
      woke: false,
      wakeDowngraded: "busy",
    });
  });

  it("row 8a: Controller slot occupied ⇒ deliver-only busy even though the host is idle", () => {
    // First wake lands deferred (Fpi5: host stayed idle) — the Controller slot is occupied.
    const s = buildStack({ capability: "observed", hostFlipsOnTrigger: false });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "unknown",
      reason: "start_deferred",
      woke: true,
    });
    expect(s.controller!.busy).toBe(true);
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "busy",
    });
  });

  it("row 8a (host busy): a streaming root both downgrades the wake AND queues the delivery", () => {
    const s = buildStack({ capability: "observed" });
    const first = s.receiver.deliver(s.input({ wake: true }));
    expect(first).toEqual({ effect: "applied", woke: true });
    expect(s.controller!.busy).toBe(true);
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "unknown",
      reason: "queued",
      woke: false,
      wakeDowngraded: "busy",
    });
  });

  it("row 8b: goal fence active ⇒ wake-only downgrade 'goal', delivery itself unaffected", () => {
    const s = buildStack({ capability: "observed", goalFence: true });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "goal",
    });
    expect(s.receiver.deliver(s.input())).toEqual({ effect: "applied", woke: false }); // plain delivery passes
  });

  it("row 8c: hop beyond maxLevel ⇒ deliver-only level_limit", () => {
    const s = buildStack({ capability: "observed" });
    expect(s.receiver.deliver(s.input({ wake: true, level: 2 }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "level_limit",
    });
  });

  it("row 8d: inbound wake quota exhausted ⇒ deliver-only inbound_wake_rate", () => {
    const s = buildStack({ capability: "observed", wakeQuotaSpent: 12 });
    expect(s.receiver.deliver(s.input({ wake: true }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "inbound_wake_rate",
    });
  });

  it("row 9: everything satisfied ⇒ Controller.dispatch — applied+woke (Fpi2) or unknown{start_deferred}+woke (Fpi5)", () => {
    const applied = buildStack({ capability: "observed" });
    expect(applied.receiver.deliver(applied.input({ wake: true, level: 1 }))).toEqual({
      effect: "applied",
      woke: true,
    });
    expect(applied.sent[0]!.triggerTurn).toBe(true);
    expect(applied.controller!.state).toBe("starting");
    expect(applied.level.root).toBe(2); // §6.6: controller commit raised root to L_s+1

    const deferred = buildStack({ capability: "observed", hostFlipsOnTrigger: false });
    expect(deferred.receiver.deliver(deferred.input({ wake: true, level: 1 }))).toEqual({
      effect: "unknown",
      reason: "start_deferred",
      woke: true,
    });
    expect(deferred.controller!.state).toBe("deferred");
  });

  it("no row ever uses steer or a Controller-less triggerTurn:true (review #8)", () => {
    // The only writer of triggerTurn:true is the Controller (row 9); every degraded row above
    // produced triggerTurn:false — pinned by re-running the degraded rows and asserting sends.
    const cases: Array<[StackOptions, boolean]> = [
      [{ wakeEnabled: false }, true],
      [{ rootRunMaxS: 0, capability: "observed" }, true],
      [{ capability: "unknown" }, true],
      [{ capability: "absent" }, true],
      [{ capability: "observed", receive: "deliver" }, true],
      [{ capability: "observed", hostIdle: false }, true],
      [{ capability: "observed", goalFence: true }, true],
      [{ capability: "observed" }, true], // level_limit below
      [{ capability: "observed", wakeQuotaSpent: 12 }, true],
    ];
    for (const [opts] of cases) {
      const s = buildStack(opts);
      s.receiver.deliver(s.input({ wake: true, level: 2 }));
      if (s.sent.length > 0) expect(s.sent[0]!.triggerTurn).toBe(false);
    }
  });
});

// reply-plan §6.6 (the reference to §6.4 in the RX5 brief): append-only new rows.
interface ReplyTruthRow {
  name: string;
  receive: "off" | "deliver" | "wake" | "replies";
  human?: boolean;
  late?: boolean;
  unsolicited?: boolean;
  invalid?: "unknown" | "consuming";
  options?: StackOptions;
  setup?: (s: Stack) => void;
  expected: { effect: "none" | "applied" | "unknown"; woke: boolean; reason?: string; wakeDowngraded?: string };
  state?: "pending" | "replied" | "late_replied" | "consuming";
}
const replyRows: ReplyTruthRow[] = [
  {
    name: "unsolicited × replies ⇒ rejected",
    receive: "replies",
    unsolicited: true,
    expected: { effect: "none", reason: "rejected", woke: false },
    state: "pending",
  },
  {
    name: "valid reply × off ⇒ rejected, no reserve",
    receive: "off",
    expected: { effect: "none", reason: "rejected", woke: false },
    state: "pending",
  },
  {
    name: "unknown/restarted credential ⇒ rejected",
    receive: "wake",
    invalid: "unknown",
    expected: { effect: "none", reason: "rejected", woke: false },
    state: "pending",
  },
  {
    name: "consuming credential ⇒ rejected",
    receive: "wake",
    invalid: "consuming",
    expected: { effect: "none", reason: "rejected", woke: false },
    state: "consuming",
  },
  ...(["replies", "wake"] as const).map((receive): ReplyTruthRow => ({
    name: `valid reply × ${receive} ⇒ solicited return, no hop`,
    receive,
    options: { maxLevel: 0 },
    expected: { effect: "applied", woke: true },
    state: "replied",
  })),
  ...(
    [
      ["busy", { hostIdle: false }, "busy"],
      ["host", { capability: "unknown" }, "host_unverified"],
      ["goal", { goalFence: true }, "goal"],
      ["quota", { wakeQuotaSpent: 12 }, "inbound_wake_rate"],
    ] as const
  ).map(([name, options, reason]): ReplyTruthRow => ({
    name: `reply downgrade ${name} ⇒ quiet commit`,
    receive: "replies",
    options,
    expected: {
      effect: name === "busy" ? "unknown" : "applied",
      ...(name === "busy" ? { reason: "queued" } : {}),
      woke: false,
      wakeDowngraded: reason,
    },
    state: "replied",
  })),
  {
    name: "reply ledger_full ⇒ quiet commit",
    receive: "wake",
    setup: (s) => {
      s.receiver.setController({ dispatch: () => ({ dispatched: false, wakeDowngraded: "ledger_full" }) });
    },
    expected: { effect: "applied", woke: false, wakeDowngraded: "ledger_full" },
    state: "replied",
  },
  {
    name: "Controller none ⇒ release",
    receive: "replies",
    setup: (s) => {
      s.receiver.setController({
        dispatch: () => ({ dispatched: false, effect: "none", reason: "session_changed", woke: false }),
      });
    },
    expected: { effect: "none", woke: false, reason: "session_changed" },
    state: "pending",
  },
  {
    name: "downgrade then guard2 fenced ⇒ release",
    receive: "replies",
    setup: (s) => {
      s.receiver.setController({
        dispatch: () => {
          s.fence.onEvent({ type: "session_before_compact" });
          return { dispatched: false, wakeDowngraded: "busy" };
        },
      });
    },
    expected: { effect: "none", woke: false, reason: "fenced:compaction" },
    state: "pending",
  },
  {
    name: "reply × deliver cannot wake (R2)",
    receive: "deliver",
    expected: { effect: "applied", woke: false, wakeDowngraded: "receiver_policy" },
    state: "replied",
  },
  {
    name: "wakeOnReply false ⇒ quiet commit",
    receive: "replies",
    human: true,
    expected: { effect: "applied", woke: false },
    state: "replied",
  },
  {
    name: "timed_out inside grace ⇒ reply_late, no wake",
    receive: "replies",
    late: true,
    expected: { effect: "applied", reason: "reply_late", woke: false },
    state: "late_replied",
  },
  {
    name: "stage5 fenced ⇒ no reserve",
    receive: "wake",
    setup: (s) => s.fence.onEvent({ type: "session_before_compact" }),
    expected: { effect: "none", reason: "fenced:compaction", woke: false },
    state: "pending",
  },
  {
    name: "valid reply × wake off ⇒ wake_disabled quiet commit",
    receive: "wake",
    options: { wakeEnabled: false },
    expected: { effect: "applied", woke: false, wakeDowngraded: "wake_disabled" },
    state: "replied",
  },
];

describe("RX5 reply truth table §6.6 — original rows above unchanged", () => {
  it.each(replyRows)("$name", (row) => {
    const s = buildStack({ replies: true, receive: row.receive, capability: "observed", ...row.options });
    const issued = s.ledger.issue({
      requesterSessionId: SESSION,
      replierSessionId: SENDER,
      replierRef: "target",
      origin: row.human ? "human" : "model",
      wakeOnReply: !row.human,
      requesterLevel: 2,
      timeoutMs: 60_000,
      lateGraceMs: 600_000,
      maxPending: 8,
      maxPendingPerTarget: 3,
    });
    if (!issued.ok) throw new Error("issue failed");
    const id = issued.ticket.requestId;
    if (row.late) s.clock.advance(60_000);
    if (row.invalid === "consuming") s.ledger.reserve(id, "already-consuming");
    row.setup?.(s);
    const reserve = vi.spyOn(s.ledger, "reserve");
    const verdict = s.receiver.deliver(
      s.input({ ...(row.unsolicited ? {} : { inReplyTo: row.invalid === "unknown" ? "q-restarted" : id }) }),
    );
    expect(verdict).toEqual(row.expected);
    expect(s.ledger.get(id)?.state).toBe(row.state);
    if (row.expected.woke) {
      expect(s.level.root).toBe(2);
      expect(s.replyInbox.snapshot()[0]?.mode).toBe("trigger");
    }
    if (row.state === "pending" || row.state === "consuming") expect(s.replyInbox.occupied).toBe(0);
    if (row.name.startsWith("stage5") || row.receive === "off") expect(reserve).not.toHaveBeenCalled();
    if (row.human) expect(s.sent[0]?.details).toMatchObject({ inReplyTo: id });
    s.controller?.dispose();
    s.fence.dispose();
  });
});

it("RX5 repeated replies with wire wake:false use shared inbound wake cap, never hop past requesterLevel", () => {
  const s = buildStack({ replies: true, receive: "replies", capability: "observed", maxLevel: 0 });
  for (let n = 0; n < 13; n++) {
    const issued = s.ledger.issue({
      requesterSessionId: SESSION,
      replierSessionId: SENDER,
      replierRef: "peer",
      origin: "model",
      wakeOnReply: true,
      requesterLevel: 2,
      timeoutMs: 60_000,
      lateGraceMs: 600_000,
      maxPending: 8,
      maxPendingPerTarget: 3,
    });
    if (!issued.ok) throw new Error("issue failed");
    s.setIdle(true);
    const ack = s.receiver.deliver(s.input({ wake: false, inReplyTo: issued.ticket.requestId }));
    expect(ack).toEqual(
      n < 12
        ? { effect: "applied", woke: true }
        : { effect: "applied", woke: false, wakeDowngraded: "inbound_wake_rate" },
    );
    expect(s.level.root).toBe(2);
    s.controller!.settled();
    s.replyInbox.releaseTrigger();
  }
  expect(s.sent.filter((m) => m.triggerTurn)).toHaveLength(12);
  expect(s.replyInbox.occupied).toBe(1); // final quiet reply still awaits a run
  s.controller!.dispose();
  s.fence.dispose();
});
