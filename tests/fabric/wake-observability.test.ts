import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../../src/core/types.js";
import { formatWakeStatusLine, type WakeStatusView } from "../../src/fabric/wake.js";
import { flush, snapshot } from "../helpers/fabric-inbox.js";
import { reviveRig, sender } from "../helpers/fabric-revive.js";

/**
 * Gate G: the `/agent status` wake line inputs (WakeService.stats().deadLetters, inboxCount) and the leftover subscriber
 * lifetime bound (an evicted/unknown successor must not linger until dispose).
 */
const SUCC = "r_REVIVE01";
afterEach(() => vi.restoreAllMocks());

const view = (over: Partial<WakeStatusView> = {}): WakeStatusView => ({
  maxLevel: 2,
  rootLevel: 1,
  resumesPerHour: 6,
  durability: "disk",
  resumesLastHour: 2,
  parked: 3,
  reserved: 0,
  quarantined: 0,
  unverified: 1,
  wakeResults: 4,
  wakeResultsSkipped: 1,
  deadLetters: {},
  ...over,
});

describe("formatWakeStatusLine", () => {
  it("renders compact English tokens in plan §7 order, no dead token without dead letters", () => {
    expect(formatWakeStatusLine(view())).toBe(
      "wake on · lvl≤2 · root L1 · resumes 2/6h · parked 3 · reserved 0 · unverified 1 · quarantined 0 · durability disk · results 4 (skipped 1)",
    );
  });
  it("lists dead letters by reason, sorted, zero counts omitted", () => {
    expect(formatWakeStatusLine(view({ deadLetters: { wake_refused: 2, ttl_expired: 1, target_gone: 0 } }))).toMatch(
      / · dead ttl_expired=1,wake_refused=2$/,
    );
  });
  it("contains no CJK (UI-text rule: compact markers are English only)", () => {
    expect(formatWakeStatusLine(view({ deadLetters: { a: 1 } }))).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("WakeService.stats().deadLetters / inboxCount", () => {
  it("counts the ORIGINAL records' dead letters by reason (real mailbox path)", async () => {
    const rig = reviveRig({
      spawn: () => ({ error: { kind: "config", message: "x", retryable: false, reason: "config" } }),
    });
    expect(rig.wake.stats().deadLetters).toEqual({});
    rig.send({ wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.wake.stats().deadLetters).toEqual({ wake_refused: 1 });
  });
  it("inboxCount: the trigger counts once the revive reserved/committed it; unknown runs are 0", async () => {
    const rig = reviveRig();
    expect(rig.wake.inboxCount(SUCC)).toBe(0);
    rig.send({ wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.wake.inboxCount(SUCC)).toBe(1); // reserved (pending) trigger
    const s = snapshot(SUCC, { status: "completed", phase: "settled" });
    s.diag.promptDispatchedAt = 1;
    s.diag.inputAcceptedAt = 2;
    rig.snaps.set(SUCC, s);
    rig.wake.onSnapshot(s);
    expect(rig.wake.inboxCount(SUCC)).toBe(1); // committed (revivedAs)
    expect(rig.wake.inboxCount("r_OTHER001")).toBe(0);
  });
});

describe("subscriber entry lifetime for an unknown successor (gate G)", () => {
  it("an entry whose successor is neither live nor replayed is dropped on the 10-minute watch, with an audit line and no timers left", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rig = reviveRig();
    const base = rig.clock.pendingTimers;
    rig.addRunning(sender);
    expect(rig.wake.subscribe("r_EVICTED01", sender)).toBe("ok");
    expect(rig.wake.pendingSubscribers("r_EVICTED01")).toBe(1);
    expect(rig.clock.pendingTimers).toBe(base + 1);
    rig.clock.advance(10 * 60_000);
    expect(rig.wake.pendingSubscribers("r_EVICTED01")).toBe(0);
    expect(rig.clock.pendingTimers).toBe(base);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("subscribers dropped (successor_unknown)"))).toBe(true);
  });
  it("a LIVE non-terminal successor is re-watched (not dropped), and settling clears the watch", async () => {
    const rig = reviveRig();
    const live: RunSnapshot = snapshot("r_LIVE0001", { status: "running", phase: "model_turn" });
    rig.snaps.set("r_LIVE0001", live);
    rig.addRunning(sender);
    rig.wake.subscribe("r_LIVE0001", sender);
    rig.clock.advance(10 * 60_000);
    expect(rig.wake.pendingSubscribers("r_LIVE0001")).toBe(1);
    const done = snapshot("r_LIVE0001", { status: "completed", phase: "settled" });
    rig.snaps.set("r_LIVE0001", done);
    rig.wake.onSnapshot(done);
    await flush();
    expect(rig.wake.pendingSubscribers("r_LIVE0001")).toBe(0);
    rig.clock.advance(10 * 60_000); // retention timer only
    expect(rig.clock.pendingTimers).toBe(0);
  });
  it("dispose clears the watch timer", () => {
    const rig = reviveRig();
    const base = rig.clock.pendingTimers;
    rig.addRunning(sender);
    rig.wake.subscribe("r_EVICTED02", sender);
    rig.wake.dispose();
    expect(rig.clock.pendingTimers).toBe(base);
  });
});
