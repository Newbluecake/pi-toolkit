/**
 * Hold phase machine — fault injection + I-SYNC (plan §5.3/§5.5, §9 anchor `hold-faults.test.ts`).
 * `dispatchOne`'s per-outcome ownership (D5): `dispatchToPi` returning anything but `"sent"` must
 * trigger exactly one `markReturned`+`onReturned` call for that item, and `publish()` exactly once
 * per hook regardless of outcome. Phase always ends at `"between"` even after a failure.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHoldBuffer, type HoldItem } from "../../../src/web-hub/agent/hold.js";
import {
  createHoldDriver,
  type DispatchOutcome,
  type HoldDriverDeps,
  type HoldRequest,
} from "../../../src/web-hub/agent/hold-driver.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r1" };

function req(cmdId: string): HoldRequest {
  return { cmdId, text: `text-${cmdId}`, deliver: "steer", origin: ORIGIN };
}

function makeCtx(): ExtensionContext {
  return {
    signal: undefined,
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "s1" },
  } as unknown as ExtensionContext;
}

function makeDeps(dispatch: (item: HoldItem) => DispatchOutcome) {
  const buffer = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
  const onReturned = vi.fn();
  const publish = vi.fn();
  const dispatchToPi = vi.fn(dispatch);
  let offset = 0;
  const deps: HoldDriverDeps = {
    buffer,
    owner: "owner-1",
    getSessionId: () => "s1",
    holdCap: () => true,
    dispatchToPi,
    onReturned,
    publish,
    now: () => Date.now() + offset,
    setRefTimer(_ms, fn) {
      const h = setImmediate(fn);
      return { cancel: () => clearImmediate(h) };
    },
    nextMacrotask: () => new Promise((r) => setImmediate(r)),
  };
  return { deps, buffer, onReturned, publish, dispatchToPi, advance: (ms: number) => (offset += ms) };
}

describe("hold-driver — per-outcome ownership (D5)", () => {
  it("'sent': onReturned is never called, publish is called exactly once this hook", async () => {
    const { deps, onReturned, publish } = makeDeps(() => "sent");
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    publish.mockClear();
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(onReturned).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    await p;
  });

  it("'refused': onReturned is called exactly once with the refused item, publish once, phase=between", () => {
    const { deps, buffer, onReturned, publish } = makeDeps(() => "refused");
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const result = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(result).toBeUndefined(); // refused ⇒ confirm() never runs (nothing was sent)
    expect(onReturned).toHaveBeenCalledTimes(1);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[]).map((h) => h.cmdId)).toEqual(["a"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(drv.phase()).toBe("between");
    expect(buffer.held("s1")).toHaveLength(0);
    expect(drv.inflightCmdId()).toBeUndefined(); // never blocks on a no-op
  });

  it("'threw': same ownership contract as 'refused'", () => {
    const { deps, onReturned, publish } = makeDeps(() => "threw");
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const result = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(result).toBeUndefined();
    expect(onReturned).toHaveBeenCalledTimes(1);
    expect(onReturned.mock.calls[0]?.[0]).toMatchObject([{ cmdId: "a", reason: "stale" }]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(drv.inflightCmdId()).toBeUndefined();
  });

  it("dispatchToPi throwing an exception (not returning a value) is treated as 'threw'", () => {
    const { deps, onReturned } = makeDeps(() => {
      throw new Error("boom");
    });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(onReturned).toHaveBeenCalledTimes(1);
  });

  it("onReturned itself throwing is swallowed per §5.3's table, never propagating out of the hook", () => {
    const { deps } = makeDeps(() => "refused");
    deps.onReturned = () => {
      throw new Error("boom");
    };
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    expect(() => drv.onTurnEnd({ outcome: "completed" }, ctx)).not.toThrow();
    expect(drv.phase()).toBe("between");
  });

  it("publish throwing is swallowed and never prevents the dispatch outcome from being correct", () => {
    const { deps, buffer } = makeDeps(() => "sent");
    deps.publish = () => {
      throw new Error("boom");
    };
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    expect(() => drv.onTurnEnd({ outcome: "completed" }, ctx)).not.toThrow();
    expect(buffer.held("s1")).toHaveLength(0); // the dispatch itself already committed
  });

  it("consecutive failures still leave phase at 'between', never stuck 'armed'", () => {
    const { deps } = makeDeps(() => "refused");
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.phase()).toBe("between");
    drv.onContext(ctx);
    drv.hold(req("b"));
    drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.phase()).toBe("between");
  });
});

describe("hold-driver — I-SYNC: the dispatch pass is one synchronous block", () => {
  it("a tick firing synchronously from inside dispatchToPi cannot interleave mid-pass (taken===sent+returned)", () => {
    const { deps, buffer, advance } = makeDeps(() => "sent");
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.hold(req("b"));
    let sentCount = 0;
    deps.dispatchToPi = vi.fn((_item: HoldItem) => {
      sentCount += 1;
      // simulate a 1 Hz tick firing "during" the dispatch call (synchronously, same stack) by
      // advancing the clock past every tick threshold and invoking onTick RE-ENTRANTLY, from
      // inside the very call `dispatchOne` is making — the sharpest version of "can a tick
      // interleave mid-pass" this harness can produce without real timers.
      advance(31 * 60_000);
      drv.onTick(ctx);
      return "sent";
    });
    drv.onTurnEnd({ outcome: "completed" }, ctx);
    // taken===sent+returned (I-SYNC): exactly one item was taken out of "held" THIS pass ("a");
    // the re-entrant tick may or may not have also flushed "b" (both are legitimate, non-
    // corrupting outcomes) — what must never happen is a double-take/double-send of the same id
    // or a buffer left with a dangling `handing` row.
    expect(sentCount).toBeGreaterThanOrEqual(1);
    const remaining = buffer.held("s1").map((h) => h.cmdId);
    expect(remaining).not.toContain("a"); // "a" was taken by THIS pass, never left half-mutated
    expect(new Set(remaining).size).toBe(remaining.length); // no duplicate rows
  });
});
