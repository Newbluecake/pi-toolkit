import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { getXsWakeLedger, XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";

const entry = (token = "token", sessionId = "session") => ({
  token,
  sessionId,
  xid: `x-${token}`,
  dispatchedAt: 0,
  deadlineAt: 60_000,
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-wake-ledger")];
});

describe("xs token ledger (B1, not a TTL cache)", () => {
  it("admits once; snapshots cannot mutate authorization", () => {
    const ledger = new XsWakeLedger();
    expect(ledger.put(entry())).toBe(true);
    expect(ledger.put(entry())).toBe(false);
    const snapshot = ledger.get("token")!;
    Object.assign(snapshot, { state: "tombstone" });
    Object.assign(ledger.entries()[0]!, { handed: true });
    expect(ledger.get("token")).toMatchObject({ state: "live", started: false, handed: false });
  });

  it("claims exactly one owner; unclaim from a stale owner cannot steal the new lease", () => {
    const ledger = new XsWakeLedger();
    const a = Symbol("old"),
      b = Symbol("new");
    expect(ledger.claim("missing", a)).toBe(false);
    ledger.put(entry());
    expect(ledger.claim("token", a)).toBe(true);
    expect(ledger.claim("token", a)).toBe(true);
    expect(ledger.claim("token", b)).toBe(false);
    ledger.unclaim("token", b);
    expect(ledger.owns("token", a)).toBe(true);
    ledger.unclaim("token", a);
    expect(ledger.claim("token", b)).toBe(true);
    ledger.unclaim("token", a);
    expect(ledger.owns("token", b)).toBe(true);
    expect(ledger.size).toBe(1); // disposal does not free authorization capacity
  });

  it("ownership excludes even a DIFFERENT token in the same session", () => {
    const ledger = new XsWakeLedger();
    const a = Symbol(),
      b = Symbol();
    ledger.put(entry("a"));
    ledger.put(entry("b"));
    ledger.put(entry("c", "other"));
    expect(ledger.claim("a", a)).toBe(true);
    expect(ledger.hasOwner("session")).toBe(true);
    expect(ledger.claim("b", b)).toBe(false);
    expect(ledger.claim("c", b)).toBe(true);
    ledger.unclaim("a", a);
    expect(ledger.claim("b", b)).toBe(true);
  });

  it("full means reject, never evict (including arbitrarily old tombstones)", () => {
    const ledger = new XsWakeLedger(2);
    ledger.put(entry("a"));
    ledger.put(entry("b"));
    ledger.tombstone("a");
    const clock = new FakeClock();
    clock.advance(100 * 365 * 24 * 3600 * 1000);
    expect(ledger.size).toBe(2);
    expect(ledger.get("a")).toMatchObject({ state: "tombstone", abortOnSight: true });
    expect(ledger.put(entry("c"))).toBe(false);
    expect(ledger.entries().map((e) => e.token)).toEqual(["a", "b"]);
    expect(clock.pendingTimers).toBe(0); // no periodic or lazy time-based GC
    ledger.release("a", "aborted");
    expect(ledger.put(entry("c"))).toBe(true);
    expect(ledger.entries().map((e) => e.token)).toEqual(["b", "c"]);
  });

  it.each(["settled", "idle_observed", "host_rejected", "aborted", "teardown"] as const)(
    "explicit terminal proof %s releases record and ownership",
    (proof) => {
      const ledger = new XsWakeLedger();
      const owner = Symbol();
      ledger.put(entry());
      ledger.claim("token", owner);
      ledger.release("token", proof);
      expect(ledger.get("token")).toBeUndefined();
      expect(ledger.owns("token", owner)).toBe(false);
    },
  );

  it("proven teardown removes only that session's actions", () => {
    const ledger = new XsWakeLedger();
    ledger.put(entry("a", "A"));
    ledger.put(entry("b", "B"));
    ledger.tombstone("a");
    ledger.teardown("A");
    expect(ledger.entries().map((e) => e.token)).toEqual(["b"]);
  });

  it("same global survives a fresh module instance (jiti reload equivalent)", async () => {
    const first = getXsWakeLedger();
    first.put(entry());
    vi.resetModules();
    const reloaded = await import("../../src/fabric/xs/wake-ledger.js");
    expect(reloaded.getXsWakeLedger()).toBe(first);
    expect(reloaded.getXsWakeLedger().get("token")?.state).toBe("live");
  });
});
