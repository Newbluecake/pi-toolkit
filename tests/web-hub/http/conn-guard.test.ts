/**
 * `createConnGuard` unit tests (plan §6.3). Exercises the frozen `ConnGuard`
 * contract at the port level (no real sockets — `admit()`'s `onEvict`
 * callback stands in for `socket.destroy()`, matching the convention
 * `tests/web-hub/contract/fakes.test.ts` uses for `fakeConnGuard`). A real-
 * socket end-to-end pass lives in `lan-admission.test.ts` (via the LAN
 * harness) so the TCP-level wiring in `createLanTransport` is covered too.
 */
import { describe, expect, it } from "vitest";
import { createConnGuard } from "../../../src/web-hub/hub/conn-guard.js";

function admit(g: ReturnType<typeof createConnGuard>, peerIp: string, viaTrustedProxy: boolean, onEvict: () => void) {
  return g.admit({ peerIp, viaTrustedProxy, onEvict });
}

describe("createConnGuard (plan §6.3)", () => {
  it("64 direct IPs each holding 1 idle connection; the 65th evicts the smallest-seq lease", () => {
    const g = createConnGuard();
    const evicted: number[] = [];
    const leases = Array.from({ length: 64 }, (_, i) => admit(g, `10.0.0.${i}`, false, () => evicted.push(i))!);
    for (const l of leases) expect(l).toBeDefined();
    const extra = admit(g, "10.0.1.0", false, () => evicted.push(999));
    expect(extra).toBeDefined();
    expect(evicted).toEqual([0]); // globally-oldest unauth (rule ②: no IP has >=2 unauth conns)
  });

  it("30 login-pending + 34 idle on one IP's pool: new connections evict idle first, login-pending survives", () => {
    const g = createConnGuard({ directUnauthPoolCap: 64 });
    const evicted: string[] = [];
    const pending = Array.from({ length: 30 }, (_, i) => admit(g, `10.1.0.${i}`, false, () => evicted.push(`p${i}`))!);
    for (const p of pending) p.enterLoginPending();
    const idle = Array.from({ length: 34 }, (_, i) => admit(g, `10.2.0.${i}`, false, () => evicted.push(`i${i}`))!);
    expect(pending.length + idle.length).toBe(64);
    const extra = admit(g, "10.3.0.0", false, () => evicted.push("extra"));
    expect(extra).toBeDefined();
    expect(evicted.length).toBe(1);
    expect(evicted[0]?.startsWith("i")).toBe(true); // an idle (unauth) one, never a login-pending one
  });

  it("one IP with 2+ unauth connections is preferred for eviction over other IPs with only 1", () => {
    const g = createConnGuard({ directUnauthPoolCap: 3 });
    const evicted: string[] = [];
    const a1 = admit(g, "10.0.0.5", false, () => evicted.push("a1"))!;
    void a1;
    const a2 = admit(g, "10.0.0.5", false, () => evicted.push("a2"))!;
    void a2;
    const b1 = admit(g, "10.0.0.9", false, () => evicted.push("b1"))!;
    void b1;
    // pool at cap (3); 4th admission must evict from .5 (2 unauth conns), not .9 (only 1) — and
    // within .5, the smaller-seq (a1, admitted first) is chosen.
    const extra = admit(g, "10.0.0.7", false, () => evicted.push("extra"));
    expect(extra).toBeDefined();
    expect(evicted).toEqual(["a1"]);
  });

  it("same IP's 9th unauth+login-pending connection is destroyed outright (no eviction of others)", () => {
    const g = createConnGuard();
    const evicted: string[] = [];
    const leases = Array.from({ length: 8 }, (_, i) => admit(g, "10.9.9.9", false, () => evicted.push(`self-${i}`))!);
    for (const l of leases) expect(l).toBeDefined();
    const ninth = admit(g, "10.9.9.9", false, () => evicted.push("ninth"));
    expect(ninth).toBeUndefined(); // destroyed outright, per-IP unauth cap (8), no one else evicted
    expect(evicted).toEqual([]);
    // another IP is unaffected.
    const other = admit(g, "10.0.0.1", false, () => evicted.push("other"));
    expect(other).toBeDefined();
  });

  it("release() decrements the pool's count (a closed socket frees room for a new one)", () => {
    const g = createConnGuard({ directUnauthPoolCap: 2 });
    const evicted: string[] = [];
    const a = admit(g, "1.1.1.1", false, () => evicted.push("a"))!;
    const b = admit(g, "2.2.2.2", false, () => evicted.push("b"))!;
    a.release();
    const c = admit(g, "3.3.3.3", false, () => evicted.push("c"));
    expect(c).toBeDefined();
    expect(evicted).toEqual([]); // room was freed by release(), nobody had to be evicted
    b.release();
    c!.release();
  });

  it("a lease already granted in the same synchronous admit() call is never itself re-evicted (no reentrancy)", () => {
    const g = createConnGuard({ directUnauthPoolCap: 1 });
    const a = admit(g, "1.1.1.1", false, () => {
      // A malicious/buggy onEvict tries to call admit() again — must be rejected, not crash the guard.
      expect(() => admit(g, "9.9.9.9", false, () => {})).toThrow();
    })!;
    expect(a).toBeDefined();
    const b = admit(g, "2.2.2.2", false, () => {});
    expect(b).toBeDefined(); // the eviction + new admission still completes normally
  });

  it("onEvict throwing is swallowed and does not prevent the new connection's own admission", () => {
    const g = createConnGuard({ directUnauthPoolCap: 1, onEvictError: () => {} });
    const a = admit(g, "1.1.1.1", false, () => {
      throw new Error("boom");
    });
    expect(a).toBeDefined();
    const b = admit(g, "2.2.2.2", false, () => {});
    expect(b).toBeDefined();
  });

  it("direct and proxy pools are fully independent — a direct flood never evicts a proxy connection and vice versa", () => {
    const g = createConnGuard({ directUnauthPoolCap: 4, proxyUnauthPoolCap: 3 });
    const evicted: string[] = [];
    const proxyLeases = Array.from({ length: 3 }, (_, i) =>
      admit(g, "192.168.31.10", true, () => evicted.push(`proxy-${i}`))!,
    );
    for (const l of proxyLeases) expect(l).toBeDefined();
    const directFlood = Array.from({ length: 4 }, (_, i) =>
      admit(g, `10.0.0.${i}`, false, () => evicted.push(`direct-${i}`))!,
    );
    for (const l of directFlood) expect(l).toBeDefined();
    const moreDirect = admit(g, "10.0.1.0", false, () => evicted.push("direct-extra"));
    expect(moreDirect).toBeDefined();
    expect(evicted.every((e) => e.startsWith("direct"))).toBe(true); // proxy pool untouched
  });

  it("each trusted proxy address gets its own independent pool (128 total / 48 unauth)", () => {
    const g = createConnGuard({ proxyUnauthPoolCap: 2 });
    const evicted: string[] = [];
    const addrA = Array.from({ length: 2 }, (_, i) => admit(g, "192.168.31.10", true, () => evicted.push(`a-${i}`))!);
    for (const l of addrA) expect(l).toBeDefined();
    // a *different* trusted address gets a fresh 2-slot budget, unaffected by addr A's saturation.
    const b1 = admit(g, "192.168.31.11", true, () => evicted.push("b1"));
    expect(b1).toBeDefined();
    expect(evicted).toEqual([]);
    // addr A's own 3rd connection does evict within its own pool (rule skips the multi-IP
    // selection step — there's only ever one address in a proxy pool).
    const a3 = admit(g, "192.168.31.10", true, () => evicted.push("a-extra"));
    expect(a3).toBeDefined();
    expect(evicted).toEqual(["a-0"]);
  });

  it("129th connection on one trusted proxy address's total cap (128) is destroyed outright", () => {
    const g = createConnGuard({ proxyTotalPerAddr: 3, proxyUnauthPoolCap: 3 });
    const leases = Array.from({ length: 3 }, (_, i) => admit(g, "192.168.31.10", true, () => {})!);
    for (const l of leases) {
      l.enterAuthed(); // authed connections are never evictable, so they still count toward "总连接"
    }
    const extra = admit(g, "192.168.31.10", true, () => {});
    expect(extra).toBeUndefined();
  });

  it("global maxConnections caps the sum across both pools, destroying the new connection (never evicting)", () => {
    const g = createConnGuard({ maxConnections: 5, directUnauthPoolCap: 10, proxyUnauthPoolCap: 10 });
    const evicted: string[] = [];
    const leases = [
      admit(g, "1.1.1.1", false, () => evicted.push("1"))!,
      admit(g, "2.2.2.2", false, () => evicted.push("2"))!,
      admit(g, "192.168.31.10", true, () => evicted.push("3"))!,
      admit(g, "192.168.31.11", true, () => evicted.push("4"))!,
      admit(g, "3.3.3.3", false, () => evicted.push("5"))!,
    ];
    for (const l of leases) expect(l).toBeDefined();
    const extra = admit(g, "4.4.4.4", false, () => evicted.push("extra"));
    expect(extra).toBeUndefined();
    expect(evicted).toEqual([]);
  });

  it("X-Forwarded-For has no bearing here — this port only ever sees the TCP peerIp", () => {
    const g = createConnGuard({ directUnauthPoolCap: 1 });
    const evicted: string[] = [];
    const a = admit(g, "1.1.1.1", false, () => evicted.push("a"));
    expect(a).toBeDefined();
    // admit() has no header-parsing surface at all — nothing to spoof; the same peerIp always
    // maps to the same pool bucket regardless of what a request later claims via XFF.
    const b = admit(g, "1.1.1.1", false, () => evicted.push("b"));
    expect(b).toBeDefined(); // 2nd conn on the same IP is still within its own 32-total / 8-unauth cap
  });
});
