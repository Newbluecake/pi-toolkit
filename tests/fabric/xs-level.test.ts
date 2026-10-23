import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createCausalLevel, type CausalLevel } from "../../src/fabric/wake-level.js";
import { RootWakeController } from "../../src/fabric/root-wake.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import { XsReceiver, type XsDeliverInput } from "../../src/fabric/xs/receiver.js";

/**
 * fabric phase-2 X4 (phase2-plan §6.6 + §11.2 X4 行 + r3 S1): level propagation at the
 * RECEIVER. Table: only a Controller dispatch that really starts a turn raises root to L_s+1
 * (deferred carries L_s now and commits +1 at its real start — the Controller owns that, S1);
 * deliver-only and every degraded wake carry L_s; rejections change nothing; messages without
 * a level (sender wake off) change nothing; a receiver with wake off has NO CausalLevel and
 * tracks nothing. Only proven human input resets root (phase-1 wake-input, unchanged — the
 * receiver adds no reset point).
 */

const SESSION = "sess-level-0123456789";
const SENDER = "sess-sender-1122334455";

interface BuildOptions {
  wakeOn?: boolean; // receiver's fabric.wake.enabled (default true)
  maxLevel?: number; // default 4
  hostIdle?: boolean; // default true
  hostFlipsOnTrigger?: boolean; // Fpi2 vs Fpi5 (default true)
  rootRunMaxS?: number; // default 900
}

function build(options: BuildOptions = {}) {
  const clock = new FakeClock(1_000);
  const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
  membership.attach();
  membership.join();
  let idle = options.hostIdle ?? true;
  const leaves: { type: string; customType?: string; details?: unknown }[] = [];
  const host = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sendMessage: (message: { customType: string; details?: unknown }, opts: { triggerTurn: boolean }) => {
      if (opts.triggerTurn) {
        if (options.hostFlipsOnTrigger ?? true) idle = false; // Fpi2
      } else if (idle) {
        leaves.push({ type: "custom_message", customType: message.customType, details: message.details });
      }
    },
    getLeafEntry: () => leaves.at(-1),
    abort: () => {},
  };
  const level: CausalLevel | undefined =
    options.wakeOn === false
      ? undefined
      : createCausalLevel({
          maxLevel: options.maxLevel ?? 4,
          initialRoot: 0,
          runLevel: () => undefined,
          raiseRun: () => {},
          persistRoot: () => {},
        });
  const receiver = new XsReceiver({
    sessionId: SESSION,
    membership,
    fence: createSessionFence({ clock }),
    inbox: new XsInbox(12, clock),
    recvPerHour: 30,
    wakesInPerHour: 12,
    host,
    dedup: new XsDedup(256, clock),
    clock,
    warn: () => {},
    ...(level === undefined ? {} : { level }),
  });
  let controller: RootWakeController | undefined;
  if (options.wakeOn !== false) {
    const capability = new XsHostCapability();
    capability.observe({ messageType: "user", prompt: "hi" });
    controller = new RootWakeController({
      sessionId: SESSION,
      rootRunMaxS: options.rootRunMaxS ?? 900,
      wakeEnabled: true,
      receive: () => membership.receive,
      host,
      guard: () => undefined,
      goalRunning: () => false,
      inboundWakeAvailable: () => true,
      chargeInboundWake: () => {},
      level,
      ledger: new XsWakeLedger(),
      capability,
      clock,
      newToken: (() => {
        let n = 0;
        return () => `t${++n}`;
      })(),
      audit: () => {},
      warn: () => {},
    });
    receiver.setController(controller);
  }
  const input = (over: Partial<XsDeliverInput> = {}): XsDeliverInput => ({
    xid: `x-${Math.random().toString(36).slice(2, 8)}`,
    to: { sessionId: SESSION, epoch: membership.epoch },
    from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/x", agentId: "ag" },
    text: "m",
    wake: false,
    expiresAt: clock.now() + 5_000,
    ...over,
  });
  return { clock, receiver, controller, level, membership, input };
}

describe("xs level propagation (§6.6)", () => {
  it("Controller dispatch that starts the run ⇒ root = L_s + 1", () => {
    const s = build();
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 1 }));
    expect(verdict).toEqual({ effect: "applied", woke: true });
    expect(s.level!.root).toBe(2);
  });

  it("Controller dispatch deferred ⇒ carry L_s now; +1 commits at the real start (S1)", () => {
    const s = build({ hostFlipsOnTrigger: false }); // Fpi5: idle stays true after the trigger
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 1 }));
    expect(verdict).toEqual({ effect: "unknown", reason: "start_deferred", woke: true });
    expect(s.level!.root).toBe(1); // carry only — the hop is NOT counted yet
    // the deferred run really starts; the B1 hook observes the token and commits the +1
    s.controller!.beforeAgentStart({
      messageType: "custom",
      message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: "t1", xid: "x" } },
    });
    expect(s.level!.root).toBe(2); // S1: 真正起 turn 才提交 +1
  });

  it("deliver-only idle append ⇒ carry L_s", () => {
    const s = build();
    s.receiver.deliver(s.input({ level: 3 }));
    expect(s.level!.root).toBe(3);
  });

  it("deliver-only streaming queue ⇒ carry L_s", () => {
    const s = build({ hostIdle: false, wakeOn: true });
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 2 }));
    // wake degrades busy (root busy) AND the deliver queues — both rows carry L_s
    expect(verdict).toEqual({ effect: "unknown", reason: "queued", woke: false, wakeDowngraded: "busy" });
    expect(s.level!.root).toBe(2);
  });

  it("wake:true degraded (controller_disabled) ⇒ carry L_s, never +1", () => {
    const s = build({ rootRunMaxS: 0 });
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 1 }));
    expect(verdict).toEqual({ effect: "applied", woke: false, wakeDowngraded: "controller_disabled" });
    expect(s.level!.root).toBe(1);
  });

  it("rejection (none) ⇒ root unchanged (expired / rejected rows)", () => {
    const s = build();
    s.receiver.deliver(s.input({ level: 2, expiresAt: s.clock.now() })); // expired
    expect(s.level!.root).toBe(0);
    s.membership.setReceive("off");
    s.receiver.deliver(s.input({ level: 2 })); // rejected
    expect(s.level!.root).toBe(0);
    s.membership.setReceive("wake");
  });

  it("message without level (sender wake off) ⇒ nothing tracked, even for a dispatched wake (§6.6 row 5)", () => {
    const s = build();
    s.receiver.deliver(s.input()); // deliver-only, no level ⇒ nothing
    expect(s.level!.root).toBe(0);
    const verdict = s.receiver.deliver(s.input({ wake: true })); // level-less wake (degenerate)
    expect(verdict).toEqual({ effect: "applied", woke: true });
    expect(s.level!.root).toBe(0); // 不变 — there is no L_s to raise from
  });

  it("receiver wake off ⇒ no CausalLevel, nothing tracked (§6.6 last row)", () => {
    const s = build({ wakeOn: false });
    expect(s.level).toBeUndefined();
    expect(s.receiver.deliver(s.input({ wake: true, level: 5 }))).toEqual({
      effect: "applied",
      woke: false,
      wakeDowngraded: "wake_disabled",
    });
  });

  it("mixed chain (unit slice): tree carry raises to L, then a cross-session wake adds +1 on the SAME chain", () => {
    const s = build();
    s.level!.raise("root", 1); // phase-1 tree delivery carry (W1 seam) — root at L=1
    const verdict = s.receiver.deliver(s.input({ wake: true, level: 1 }));
    expect(verdict).toEqual({ effect: "applied", woke: true });
    expect(s.level!.root).toBe(2); // §6.6: 跨会话一跳与树内一跳在同一条因果链上累计
  });

  it("deliveries never reset root — only proven human input does (no new reset points)", () => {
    const s = build();
    s.level!.raise("root", 2);
    s.receiver.deliver(s.input({ level: 1 }));
    expect(s.level!.root).toBe(2); // monotonic max, never lowered by a delivery
    s.level!.resetRoot();
    expect(s.level!.root).toBe(0);
  });
});
