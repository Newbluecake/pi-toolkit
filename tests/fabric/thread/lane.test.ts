import { describe, expect, it } from "vitest";
import { RunGate, THREAD_RUN_GATE_WAIT, ThreadLane } from "../../../src/fabric/thread/lane.js";

describe("ThreadLane (§6.5: 在途 1 / 等待 ≤ laneWait)", () => {
  it("FIFO with a single in-flight slot", () => {
    const lane = new ThreadLane(8);
    expect(lane.enqueue("e1")).toBe(true);
    expect(lane.enqueue("e2")).toBe(true);
    expect(lane.begin()).toBe("e1");
    expect(lane.inFlight).toBe("e1");
    expect(lane.begin()).toBeUndefined(); // busy
    expect(lane.complete("e2")).toBe(false); // not the in-flight one
    expect(lane.complete("e1")).toBe(true);
    expect(lane.inFlight).toBeUndefined();
    expect(lane.begin()).toBe("e2");
  });

  it("wait queue fills at maxWait (while the lane is busy)", () => {
    const lane = new ThreadLane(2);
    expect(lane.enqueue("e1")).toBe(true);
    expect(lane.begin()).toBe("e1"); // busy now
    expect(lane.enqueue("e2")).toBe(true);
    expect(lane.enqueue("e3")).toBe(true);
    expect(lane.waitFull()).toBe(true);
    expect(lane.enqueue("e4")).toBe(false);
    expect(lane.waitingCount).toBe(2);
    expect(lane.waiting()).toEqual(["e2", "e3"]);
  });

  it("removeWaiting pulls a deadline-expired event out of the wait queue (§6.5 lane_timeout)", () => {
    const lane = new ThreadLane(8);
    lane.enqueue("e1");
    lane.enqueue("e2");
    lane.enqueue("e3");
    expect(lane.removeWaiting("e2")).toBe(true);
    expect(lane.removeWaiting("e2")).toBe(false);
    expect(lane.waiting()).toEqual(["e1", "e3"]);
    expect(lane.begin()).toBe("e1");
    expect(lane.removeWaiting("e1")).toBe(false); // in-flight, not waiting
  });

  it("laneWait 0: a free lane always accepts (straight to fan-out); a busy lane never waits", () => {
    const lane = new ThreadLane(0);
    expect(lane.canAccept()).toBe(true); // free ⇒ accept
    expect(lane.enqueue("e1")).toBe(true);
    expect(lane.begin()).toBe("e1");
    expect(lane.canAccept()).toBe(false); // busy ∧ queue cap 0 ⇒ R5
    expect(lane.enqueue("e2")).toBe(false);
    expect(lane.waitFull()).toBe(true);
  });

  it("canAccept tracks the wait cap only while busy", () => {
    const lane = new ThreadLane(2);
    expect(lane.canAccept()).toBe(true);
    lane.enqueue("e1");
    lane.enqueue("e2");
    lane.enqueue("e3"); // free lane accepted past the cap — it begins immediately
    expect(lane.begin()).toBe("e1");
    expect(lane.canAccept()).toBe(false); // busy ∧ 2 waiting
    expect(lane.enqueue("e4")).toBe(false);
    expect(lane.waiting()).toEqual(["e2", "e3"]);
  });
});

describe("RunGate (§6.5 per-run 串行: 在途 1 / 等待 4)", () => {
  const task = (n: number) => ({ runId: "r_A", eventId: `ev${n}`, subId: `s${n}` });

  it("defaults to a wait capacity of 4", () => {
    expect(THREAD_RUN_GATE_WAIT).toBe(4);
    const gate = new RunGate();
    for (let i = 1; i <= 4; i++) expect(gate.enqueue(task(i))).toBe(true);
    expect(gate.waitFull()).toBe(true);
    expect(gate.enqueue(task(5))).toBe(false); // the 5th waiter records none — pre-call
  });

  it("one in flight at a time; release frees the slot (reference identity)", () => {
    const gate = new RunGate();
    const first = task(1);
    const second = task(2);
    gate.enqueue(first);
    gate.enqueue(second);
    expect(gate.next()).toBe(first);
    expect(gate.busy).toBe(true);
    expect(gate.next()).toBeUndefined(); // busy — no pop
    expect(gate.releaseInflight(first)).toBe(true);
    expect(gate.busy).toBe(false);
    expect(gate.next()).toBe(second);
    expect(gate.releaseInflight(first)).toBe(false); // stale release
  });

  it("cancelQueued removes matching WAITERS only — never the in-flight task", () => {
    const gate = new RunGate();
    const t1 = task(1);
    const t2 = task(2);
    const t3 = task(3);
    gate.enqueue(t1);
    gate.enqueue(t2);
    gate.enqueue(t3);
    const inflight = gate.next()!; // t1 in flight
    const removed = gate.cancelQueued((t) => t !== inflight);
    expect(removed).toEqual([t2, t3]);
    expect(gate.queuedCount).toBe(0);
    expect(gate.inFlight).toBe(inflight);
    expect(gate.releaseInflight(inflight)).toBe(true);
  });
});
