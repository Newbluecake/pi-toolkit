import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  createSessionFence,
  type FencePort,
  type SessionFence,
  type SessionFenceOptions,
} from "../../src/fabric/xs/fence.js";

/**
 * fabric phase-2 T1 (phase2-plan §11.2 T1 row + r3 主会话裁定 M1): the session-change fence.
 * Pure module + FakeClock — the events fed to `onEvent` here are exactly what the XW assembly
 * will forward from real pi; no pi import anywhere in `src/fabric/xs/**`.
 *
 * M1 overrides the r2 §7.2 table in two places this suite pins explicitly:
 *  - `input` / `before_agent_start` / run start are NOT close evidence (slow-`before_switch`
 *    test below) — no terminal event ⇒ keep rejecting, 30s only marks `stuck`;
 *  - completion events close their window SYNCHRONOUSLY (no `setTimeout(0)`), and every
 *    dispatch re-verifies `sessionGen` + fence state in the same synchronous block
 *    (`beginDispatch`/`verifyDispatch`) — the long-awaiting-later-handler test below.
 */

function makeFence(over: Partial<SessionFenceOptions> & { clock?: FakeClock } = {}): {
  fence: SessionFence;
  clock: FakeClock;
  warns: string[];
} {
  const clock = over.clock ?? new FakeClock(0);
  const warns: string[] = [];
  const fence = createSessionFence({ clock, warn: (m) => warns.push(m), ...over });
  return { fence, clock, warns };
}

describe("xs-fence: window open/close matrix (§7.2, M1-amended)", () => {
  it("compaction: before_compact opens; session_compact, session_compact_failed and session_start each close", () => {
    for (const closer of ["session_compact", "session_compact_failed", "session_start"] as const) {
      const { fence } = makeFence();
      expect(fence.check()).toEqual({ ok: true });
      fence.onEvent({ type: "session_before_compact" });
      expect(fence.check()).toEqual({ ok: false, reason: "fenced:compaction" });
      fence.onEvent({ type: closer });
      expect(fence.check()).toEqual({ ok: true });
    }
  });

  it("tree: before_tree opens; session_tree and session_start close", () => {
    for (const closer of ["session_tree", "session_start"] as const) {
      const { fence } = makeFence();
      fence.onEvent({ type: "session_before_tree" });
      expect(fence.check()).toEqual({ ok: false, reason: "fenced:tree" });
      fence.onEvent({ type: closer });
      expect(fence.check()).toEqual({ ok: true });
    }
  });

  it("switch: before_switch AND before_fork open; session_shutdown and session_start close", () => {
    for (const opener of ["session_before_switch", "session_before_fork"] as const) {
      for (const closer of ["session_shutdown", "session_start"] as const) {
        const { fence } = makeFence();
        fence.onEvent({ type: opener });
        expect(fence.check()).toEqual({ ok: false, reason: "fenced:switch" });
        fence.onEvent({ type: closer });
        expect(fence.check()).toEqual({ ok: true });
      }
    }
  });

  it("session_start closes EVERY open window at once", () => {
    const { fence } = makeFence();
    fence.onEvent({ type: "session_before_compact" });
    fence.onEvent({ type: "session_before_tree" });
    fence.onEvent({ type: "session_before_switch" });
    expect(fence.status().open).toEqual(["compaction", "tree", "switch"]);
    fence.onEvent({ type: "session_start" });
    expect(fence.check()).toEqual({ ok: true });
    expect(fence.status()).toEqual({ open: [], stuck: [] });
  });

  it("session_shutdown closes ONLY the switch window (§7.2 close-evidence table)", () => {
    const { fence } = makeFence();
    fence.onEvent({ type: "session_before_compact" });
    fence.onEvent({ type: "session_before_switch" });
    fence.onEvent({ type: "session_shutdown" });
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:compaction" });
    expect(fence.status().open).toEqual(["compaction"]);
  });

  it("a second open while the window is still open keeps the ORIGINAL stuck clock (no restart, no 2nd timer)", () => {
    const { fence, clock, warns } = makeFence();
    fence.onEvent({ type: "session_before_tree" });
    clock.advance(10_000);
    fence.onEvent({ type: "session_before_tree" }); // still open — ignored
    clock.advance(20_000); // 30s from the ORIGINAL open, 30s from the second event too
    expect(fence.status().stuck).toEqual(["tree"]);
    expect(warns).toHaveLength(1);
  });
});

describe("xs-fence: M1 — no setTimeout(0), no subsequent-evidence close (D26)", () => {
  it("completion events close SYNCHRONOUSLY: zero clock ticks, and the stuck timer is gone", () => {
    const { fence, clock } = makeFence();
    fence.onEvent({ type: "session_before_compact" });
    expect(clock.pendingTimers).toBe(1);
    fence.onEvent({ type: "session_compact" });
    // No advance(0), no microtask flush — the window is closed the moment the event lands.
    expect(fence.check()).toEqual({ ok: true });
    expect(clock.pendingTimers).toBe(0);
  });

  it("M1 test A: slow before_switch + human input / run start ⇒ fence stays closed", () => {
    const { fence, clock, warns } = makeFence();
    fence.onEvent({ type: "session_before_switch" });
    // A human submits input while the async before_switch handler chain is still awaiting —
    // pi's prompt() has no mutex waiting for switch handlers, so this proves NOTHING about the
    // switch being cancelled (r2 inference deleted by M1).
    fence.onEvent({ type: "input" });
    fence.onEvent({ type: "before_agent_start" });
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:switch" });
    // …and it keeps rejecting forever: no terminal evidence arrived, 30s only marks stuck.
    clock.advance(30_000);
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:switch" });
    expect(fence.status().stuck).toEqual(["switch"]);
    expect(warns).toHaveLength(1);
    clock.advance(600_000);
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:switch" });
    expect(warns).toHaveLength(1); // one warn per stuck episode, never a second
    expect(fence.status().open).toEqual(["switch"]);
  });

  it("tree cancelled by an extension has NO completion event (Fpi9) ⇒ only session_start / reset re-open", () => {
    const { fence, clock } = makeFence();
    fence.onEvent({ type: "session_before_tree" });
    fence.onEvent({ type: "input" });
    fence.onEvent({ type: "before_agent_start" });
    clock.advance(120_000);
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:tree" });
    expect(fence.status().stuck).toEqual(["tree"]);
    fence.onEvent({ type: "session_start" });
    expect(fence.check()).toEqual({ ok: true });
  });
});

describe("xs-fence: stuck = warn + keep rejecting (§7.3, never fail-open)", () => {
  it("marks stuck at 30s exactly, warns once with the window name and age, keeps rejecting", () => {
    const { fence, clock, warns } = makeFence();
    fence.onEvent({ type: "session_before_compact" });
    clock.advance(29_999);
    expect(fence.status().stuck).toEqual([]);
    clock.advance(1);
    expect(fence.status()).toEqual({ open: ["compaction"], stuck: ["compaction"], oldestOpenMs: 30_000 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("fabric fence stuck: compaction");
    expect(warns[0]).toContain("30s");
    expect(warns[0]).toContain("/fabric fence reset");
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:compaction" });
  });

  it("a stuck window that later gets real close evidence clears stuck and opens the fence", () => {
    const { fence, clock } = makeFence();
    fence.onEvent({ type: "session_before_compact" });
    clock.advance(45_000);
    expect(fence.status().stuck).toEqual(["compaction"]);
    fence.onEvent({ type: "session_compact_failed" });
    expect(fence.check()).toEqual({ ok: true });
    expect(fence.status()).toEqual({ open: [], stuck: [] });
  });

  it("reset() clears every window and every stuck marker without touching the generation", () => {
    const { fence, clock } = makeFence();
    fence.onEvent({ type: "session_before_tree" });
    fence.onEvent({ type: "session_before_switch" });
    fence.onEvent({ type: "session_start" }); // gen 0 → 1
    fence.onEvent({ type: "session_before_tree" });
    clock.advance(31_000);
    expect(fence.status().stuck).toEqual(["tree"]);
    const genBefore = fence.generation();
    fence.reset();
    expect(fence.check()).toEqual({ ok: true });
    expect(fence.status()).toEqual({ open: [], stuck: [] });
    expect(fence.generation()).toBe(genBefore); // reset ≠ session change
    expect(clock.pendingTimers).toBe(0);
  });

  it("status(): oldestOpenMs is the age of the OLDEST open event window; ports appear in `open` live", () => {
    const webExec: FencePort = () => true;
    const { fence, clock } = makeFence({ ports: { webExec } });
    fence.onEvent({ type: "session_before_compact" });
    clock.advance(10_000);
    fence.onEvent({ type: "session_before_tree" });
    clock.advance(5_000);
    expect(fence.status()).toEqual({
      open: ["compaction", "tree", "web_exec"],
      stuck: [],
      oldestOpenMs: 15_000,
    });
  });
});

describe("xs-fence: ports (late-bound, read at check time, fail closed)", () => {
  it("absent ports and false-returning ports are inactive", () => {
    const { fence } = makeFence({ ports: { webExec: () => false, topicSwitch: () => undefined } });
    expect(fence.check()).toEqual({ ok: true });
    expect(fence.status().open).toEqual([]);
  });

  it("active web_exec / topic_switch ports reject with their own reason", () => {
    const a = makeFence({ ports: { webExec: () => true } });
    expect(a.fence.check()).toEqual({ ok: false, reason: "fenced:web_exec" });
    const b = makeFence({ ports: { topicSwitch: () => true } });
    expect(b.fence.check()).toEqual({ ok: false, reason: "fenced:topic_switch" });
  });

  it("a THROWING port counts as active — fail closed (§7.2)", () => {
    const boom = (): boolean => {
      throw new Error("port source unreadable");
    };
    expect(makeFence({ ports: { webExec: boom } }).fence.check()).toEqual({ ok: false, reason: "fenced:web_exec" });
    expect(makeFence({ ports: { topicSwitch: boom } }).fence.check()).toEqual({
      ok: false,
      reason: "fenced:topic_switch",
    });
    expect(makeFence({ ports: { goal: boom } }).fence.check()).toEqual({
      ok: false,
      reason: "fenced:goal",
      wakeOnly: true,
    });
  });

  it("goal ⇒ wakeOnly: downgrades a wake, never rejects the delivery (§7.2 goal row)", () => {
    const { fence } = makeFence({ ports: { goal: () => true } });
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:goal", wakeOnly: true });
    expect(fence.status().open).toEqual(["goal"]);
    expect(fence.status().stuck).toEqual([]); // ports have no age — never "stuck"
  });

  it("a rejecting window beats goal's wakeOnly; deterministic reason order", () => {
    const { fence } = makeFence({ ports: { goal: () => true } });
    fence.onEvent({ type: "session_before_tree" });
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:tree" });
    const all = makeFence({ ports: { goal: () => true } });
    all.fence.onEvent({ type: "session_before_switch" });
    all.fence.onEvent({ type: "session_before_compact" });
    expect(all.fence.check()).toEqual({ ok: false, reason: "fenced:compaction" }); // fixed order, no wakeOnly
  });

  it("ports are read LIVE at check time, not snapshotted at construction", () => {
    let active = false;
    const { fence } = makeFence({ ports: { topicSwitch: () => active } });
    expect(fence.check()).toEqual({ ok: true });
    active = true;
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:topic_switch" });
    active = false;
    expect(fence.check()).toEqual({ ok: true });
  });
});

describe("xs-fence: session generation + dispatch-point recheck (M1 / §7.4)", () => {
  it("generation bumps ONLY on session_start / session_shutdown", () => {
    const { fence } = makeFence();
    expect(fence.generation()).toBe(0);
    fence.onEvent({ type: "session_before_compact" });
    fence.onEvent({ type: "input" });
    expect(fence.generation()).toBe(0);
    fence.onEvent({ type: "session_compact" });
    expect(fence.generation()).toBe(0);
    fence.onEvent({ type: "session_shutdown" });
    expect(fence.generation()).toBe(1);
    fence.onEvent({ type: "session_start" });
    expect(fence.generation()).toBe(2);
  });

  it("beginDispatch returns the verdict plus the gen snapshot; a fenced state carries no gen", () => {
    const { fence } = makeFence();
    expect(fence.beginDispatch()).toEqual({ ok: true, gen: 0 });
    fence.onEvent({ type: "session_before_tree" });
    expect(fence.beginDispatch()).toEqual({ ok: false, reason: "fenced:tree" });
  });

  it("M1 test B: completion event whose LATER handlers long-await ⇒ the dispatch-point recheck intercepts", () => {
    // The dispatch point passed its precheck (guard ok, gen N) and is inside its synchronous
    // block; the session-change completion chain resolves underneath it — `session_shutdown`
    // then `session_start` — while a LATER handler for that same chain is still awaiting
    // arbitrarily long. The deleted setTimeout(0) reasoning would have called this "cleaned";
    // M1 instead re-verifies state directly: the gen moved ⇒ the write is not provably applied.
    const { fence, clock } = makeFence();
    fence.onEvent({ type: "session_before_switch" });
    fence.onEvent({ type: "session_shutdown" }); // switch window closed… gen 0 → 1
    fence.onEvent({ type: "session_start" }); // …and the new session is live, gen → 2
    const guard = fence.beginDispatch();
    expect(guard).toEqual({ ok: true, gen: 2 });
    // Mid-dispatch: the long-awaited handler chain finally lands another identity change.
    fence.onEvent({ type: "session_shutdown" }); // gen → 3 (stack being torn down again)
    expect(fence.verifyDispatch(guard.gen)).toEqual({ ok: false, reason: "gen_changed" });
    // A guard taken AFTER the change verifies cleanly — the recheck is state comparison, not timers.
    const guard2 = fence.beginDispatch();
    expect(guard2).toEqual({ ok: true, gen: 3 });
    clock.advance(10 * 60_000); // arbitrarily long later — still synchronous-state semantics
    expect(fence.verifyDispatch(guard2.gen)).toEqual({ ok: true, gen: 3 });
  });

  it("a window OPENING mid-dispatch is also caught by the postcheck (fenced, not gen_changed)", () => {
    const { fence } = makeFence();
    const guard = fence.beginDispatch();
    expect(guard.ok).toBe(true);
    fence.onEvent({ type: "session_before_switch" }); // dispatch raced a switch start
    expect(fence.verifyDispatch((guard as { gen: number }).gen)).toEqual({
      ok: false,
      reason: "fenced:switch",
    });
  });

  it("verifyDispatch mirrors check()'s wakeOnly for a goal port that turns active mid-dispatch", () => {
    let goalActive = false;
    const { fence } = makeFence({ ports: { goal: () => goalActive } });
    const guard = fence.beginDispatch();
    expect(guard).toEqual({ ok: true, gen: 0 });
    goalActive = true;
    expect(fence.verifyDispatch(0)).toEqual({ ok: false, reason: "fenced:goal", wakeOnly: true });
  });
});

describe("xs-fence: dispose", () => {
  it("cancels armed stuck timers, ignores further events, keeps last state readable (fail closed)", () => {
    const { fence, clock, warns } = makeFence();
    fence.onEvent({ type: "session_before_tree" });
    expect(clock.pendingTimers).toBe(1);
    fence.dispose();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(120_000);
    expect(warns).toHaveLength(0); // nothing fires into a dead stack
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:tree" }); // state kept, still closed
    fence.onEvent({ type: "session_tree" }); // ignored after dispose
    expect(fence.check()).toEqual({ ok: false, reason: "fenced:tree" });
    fence.dispose(); // idempotent
  });
});
