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
  let busy = 0;
  let stop: StopMarkerRead = { state: "absent" };
  const restart = vi.fn(async () => undefined);
  const audit = vi.fn();
  // acc32-B9: pending dialogs-slot handshake resolvers, keyed by agentKey. `settleDialogsWait`
  // simulates whichever of "the frame arrived" / "the bounded timeout elapsed" the real
  // `awaitDialogsSlot` would have resolved on — the controller treats both identically.
  const dialogsResolvers = new Map<string, () => void>();
  const ctl = createSupersede({
    hubVersion: "1.0.0",
    now: () => now,
    stopFile: "/state/stopped",
    readStop: () => stop,
    openDialogs: () => (open === 0 ? [] : [{ agentKey: "a1", count: open }]),
    inflight: () => inflight,
    kdfInflight: () => kdf,
    managedBusy: () => busy,
    restart,
    audit,
    awaitDialogsSlot: (agentKey) =>
      new Promise<void>((resolve) => {
        dialogsResolvers.set(agentKey, resolve);
      }),
  });
  return {
    ctl,
    restart,
    audit,
    setNow: (v: number) => (now = v),
    setOpen: (v: number) => (open = v),
    setInflight: (v: number) => (inflight = v),
    setKdf: (v: number) => (kdf = v),
    setBusy: (v: number) => (busy = v),
    setStop: (v: StopMarkerRead) => (stop = v),
    /** Resolves the pending dialogs-slot wait for `agentKey` and drains the microtask queue so
     * `observe()`'s deferred `tick()` (its `.then()` continuation) actually runs. */
    settleDialogsWait: async (agentKey: string) => {
      dialogsResolvers.get(agentKey)?.();
      dialogsResolvers.delete(agentKey);
      await Promise.resolve();
      await Promise.resolve();
    },
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

  it("web-hub-spawn §SP10: busy managed spawns block the quiet path (managedBusy), but never the forced deadline path", () => {
    const h = harness();
    h.ctl.observe("2.0.0");
    h.setOpen(0);
    h.setInflight(0);
    h.setKdf(0);
    h.setBusy(1); // a web-spawned agent reports status.busy
    h.ctl.tick();
    expect(h.restart).not.toHaveBeenCalled();
    h.setBusy(0);
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
    // forced: even with busy managed spawns, the 30-minute deadline still replaces (arch §7.8)
    const h2 = harness();
    h2.ctl.observe("2.0.0");
    h2.setOpen(0);
    h2.setBusy(2);
    h2.setNow(h2.ctl.state()!.deadlineAt);
    h2.ctl.tick();
    expect(h2.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: true }));
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

  it("observe() waits for THIS agent's own dialogs-slot frame before the first quiet judgment, so a dialogs frame arriving after hello (D14 reconnect replay) is not raced past (acc32-B9)", async () => {
    const h = harness();
    // Reconnect scenario: the Rec was reaped while a dialog was open, so the fresh registration's
    // hello arrives with no dialogs recorded yet — exactly what a brand-new Rec looks like.
    h.setOpen(0);
    h.ctl.observe("2.0.0", "a1");
    // Before the fix, `observe()` called `tick()` synchronously (or after a bare 0ms timer) right
    // here and would already have replaced (`waitedMs:0`) while the dialog frame was still in
    // flight over the network.
    expect(h.restart).not.toHaveBeenCalled();
    // The reconnecting agent's `dialogs` frame lands (D14 replay) reporting the dialog that was
    // open all along, updating the registry snapshot `openDialogs()` reads from.
    h.setOpen(1);
    // Now the handshake resolves (simulating the frame's arrival) and the deferred quiet check
    // actually runs.
    await h.settleDialogsWait("a1");
    expect(h.restart).not.toHaveBeenCalled();
    // Once the dialog closes, the (now-current) periodic tick correctly replaces.
    h.setOpen(0);
    h.ctl.tick();
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  });

  it("observe() still replaces promptly once the bounded handshake timeout elapses when there really is nothing open (no dialogs frame ever follows)", async () => {
    const h = harness();
    h.setOpen(0);
    h.ctl.observe("2.0.0", "a1");
    expect(h.restart).not.toHaveBeenCalled();
    // Simulates the bounded timeout firing rather than a frame arriving — the controller treats
    // both identically, which is what keeps this path from hanging forever on an agent that never
    // sends a `dialogs` frame at all.
    await h.settleDialogsWait("a1");
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  });

  it("a missing agentKey (older/minimal caller) degrades to the pre-handshake synchronous check", () => {
    const h = harness();
    h.setOpen(0);
    h.ctl.observe("2.0.0");
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  });

  it("a repeat observe() for an agentKey already being awaited does not start a second handshake wait", async () => {
    const h = harness();
    h.setOpen(1);
    h.ctl.observe("2.0.0", "a1");
    h.ctl.observe("3.0.0", "a1"); // still-higher version from the same connection
    expect(h.ctl.state()?.nextVersion).toBe("3.0.0");
    h.setOpen(0);
    await h.settleDialogsWait("a1");
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false, nextVersion: "3.0.0" }));
  });

  it("the periodic tick must not outrun an in-flight handshake — quiet and forced both wait (acc32-B9 round 2)", async () => {
    const h = harness();
    h.setOpen(0);
    h.ctl.observe("2.0.0", "a1"); // handshake starts, dialogs frame not yet arrived
    // The production 250ms periodic tick fires while the handshake is still pending. Before the
    // round-2 gate this judged quiet on incomplete information and replaced immediately
    // (verifier repro: calls-before-handshake=1).
    h.ctl.tick();
    expect(h.restart).not.toHaveBeenCalled();
    // The forced path waits too: an already-elapsed deadline must not begin mid-handshake.
    h.setNow(h.ctl.state()!.deadlineAt);
    h.ctl.tick();
    expect(h.restart).not.toHaveBeenCalled();
    // Handshake resolves (frame or bounded timeout) — its deferred tick now judges for real.
    // Everything is quiet, so this takes the quiet branch even past the deadline (the existing
    // quiet-preferred semantics); what matters is that it did not begin BEFORE the handshake.
    await h.settleDialogsWait("a1");
    expect(h.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));

    // And the forced branch itself, properly gated: a second agent's handshake while a dialog
    // stays open past the deadline ⇒ forced:true only AFTER the handshake settles.
    const h2 = harness();
    h2.setOpen(1);
    h2.ctl.observe("2.0.0", "a1");
    h2.setNow(h2.ctl.state()!.deadlineAt);
    h2.ctl.tick(); // periodic tick mid-handshake: must not force
    expect(h2.restart).not.toHaveBeenCalled();
    await h2.settleDialogsWait("a1"); // handshake settles, dialog still open, deadline elapsed
    expect(h2.restart).toHaveBeenCalledWith(expect.objectContaining({ forced: true }));
  });
});
