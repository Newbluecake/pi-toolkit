import { describe, expect, it, vi } from "vitest";
import {
  SUPERSEDE_DEFAULT_MAX_WAIT_MS,
  SUPERSEDE_MAX_WAIT_MS,
  SUPERSEDE_MIN_WAIT_MS,
  createSupersede,
  supersedeWaitMs,
} from "../../../src/web-hub/hub/supersede.js";
import type { StopMarkerRead } from "../../../src/web-hub/protocol/stop-marker.js";

function harness() {
  let now = 1_000;
  let open = 1;
  let inflight = 0;
  let kdf = 0;
  let stop: StopMarkerRead = { state: "absent" };
  const restart = vi.fn(async () => undefined);
  const audit = vi.fn();
  const ctl = createSupersede({
    hubVersion: "1.0.0",
    now: () => now,
    stopFile: "/state/stopped",
    readStop: () => stop,
    openDialogs: () => (open === 0 ? [] : [{ agentKey: "a1", count: open }]),
    inflight: () => inflight,
    kdfInflight: () => kdf,
    restart,
    audit,
  });
  return {
    ctl,
    restart,
    audit,
    setNow: (v: number) => (now = v),
    setOpen: (v: number) => (open = v),
    setInflight: (v: number) => (inflight = v),
    setKdf: (v: number) => (kdf = v),
    setStop: (v: StopMarkerRead) => (stop = v),
  };
}

describe("hub supersede controller (C10)", () => {
  it("records a strictly newer version without resetting since/deadline", () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    const first = h.ctl.state()!;
    expect(first.deadlineAt).toBe(first.since + SUPERSEDE_DEFAULT_MAX_WAIT_MS);
    h.setNow(5_000);
    h.ctl.observe("3.0.0");
    expect(h.ctl.state()).toMatchObject({ nextVersion: "3.0.0", since: first.since, deadlineAt: first.deadlineAt });
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("waits for dialogs, router work, and KDF work on the quiet path", () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    h.setOpen(0);
    h.setInflight(1);
    h.ctl.tick();
    h.setInflight(0);
    h.setKdf(1);
    h.ctl.tick();
    expect(h.restart).not.toHaveBeenCalled();
    h.setKdf(0);
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  });

  it("forces after the deadline, but stop and unknown markers fail closed", () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    const deadline = h.ctl.state()!.deadlineAt;
    h.setNow(deadline);
    h.setStop({ state: "stopped" });
    h.ctl.tick();
    h.setStop({ state: "unknown", code: "EIO" });
    h.ctl.tick();
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith("supersede_blocked", expect.objectContaining({ reason: "stop" }));
    h.setStop({ state: "absent" });
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledWith(
      expect.objectContaining({ forced: true, openDialogs: [{ agentKey: "a1", count: 1 }] }),
    );
  });

  it("clamps the override to 10s..30min and defaults invalid values", () => {
    expect(supersedeWaitMs({ PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS: String(SUPERSEDE_MIN_WAIT_MS) })).toBe(
      SUPERSEDE_MIN_WAIT_MS,
    );
    expect(supersedeWaitMs({ PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS: String(SUPERSEDE_MAX_WAIT_MS) })).toBe(
      SUPERSEDE_MAX_WAIT_MS,
    );
    expect(supersedeWaitMs({ PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS: "9" })).toBe(SUPERSEDE_DEFAULT_MAX_WAIT_MS);
    expect(supersedeWaitMs({ PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS: "not-a-number" })).toBe(SUPERSEDE_DEFAULT_MAX_WAIT_MS);
  });

  it("surfaces the blocked state on the controller state while a stop marker holds (§6.7.3 ①)", () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    expect(h.ctl.state()!.blocked).toBeUndefined();
    h.setStop({ state: "stopped" });
    h.ctl.tick();
    expect(h.ctl.state()!.blocked).toBe("stopped");
    h.setStop({ state: "unknown", code: "EIO" });
    h.ctl.tick();
    expect(h.ctl.state()!.blocked).toBe("unknown");
    // Clearing the marker unblocks immediately and, the deadline having elapsed, forces at once.
    h.setNow(h.ctl.state()!.deadlineAt);
    h.setStop({ state: "absent" });
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: true }));
  });

  it("the forced path is exempt from the 60s anti-flap throttle (§6.7.3 ②)", async () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    h.setOpen(0);
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledTimes(1); // quiet replacement completes
    await Promise.resolve(); // let the restart promise settle (lastReplacementAt := now)
    // A still-higher version arrives seconds later; its deadline elapses while a dialog is open.
    h.setOpen(1);
    h.ctl.observe("3.0.0");
    h.setNow(h.ctl.state()!.deadlineAt);
    h.ctl.tick();
    // <60s since the last replacement: the quiet path would be throttled, the forced path is not.
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(h.restart).toHaveBeenLastCalledWith(expect.objectContaining({ forced: true, nextVersion: "3.0.0" }));
  });
});
