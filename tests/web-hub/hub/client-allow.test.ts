/** LAN security §2.2 / §10 (pkg A): ClientAllowGuard decisions, audit throttle, bounded bookkeeping, burst. */
import { describe, expect, it } from "vitest";
import {
  CLIENT_DENY_BURST_DEQUE_MAX,
  CLIENT_DENY_LINES_PER_WINDOW,
  CLIENT_DENY_MAP_MAX,
  createClientAllowGuard,
  tagClientAllowGuard,
  type ClientAllowGuardDeps,
} from "../../../src/web-hub/hub/client-allow.js";
import type { ClientAllowBurst, ClientAllowGuard } from "../../../src/web-hub/hub/ports.js";

const MIN = 60_000;
function make(deps: ClientAllowGuardDeps = {}) {
  let t = 1_000_000;
  const lines: Array<Record<string, unknown>> = [];
  const guard = createClientAllowGuard({
    now: () => t,
    log: { info: (_m, d) => lines.push((d ?? {}) as Record<string, unknown>) },
    ...deps,
  });
  return {
    guard,
    lines,
    advance(ms: number) {
      t += ms;
    },
    at: () => t,
  };
}
const ip = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

describe("activation (P0 addendum 1)", () => {
  it("entries undefined ⇒ inactive: admits anything, records nothing", () => {
    const { guard, lines } = make();
    expect(guard.active).toBe(false);
    expect(guard.admitPeer("8.8.8.8", false)).toBe(true);
    expect(guard.admitPeer("garbage", false)).toBe(true);
    expect(guard.admitForwarded({ clientIp: "8.8.8.8", xffUsable: false })).toBe(true);
    expect(guard.snapshot()).toEqual({ entries: [] });
    expect(lines).toEqual([]);
  });

  it("entries [] ⇒ ACTIVE deny-all; only implicit loopback passes", () => {
    const { guard } = make({ entries: [] });
    expect(guard.active).toBe(true);
    for (const ok of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])
      expect(guard.admitPeer(ok, false), ok).toBe(true);
    for (const bad of ["192.168.32.38", "::2", "0.0.0.0"]) expect(guard.admitPeer(bad, false), bad).toBe(false);
    expect(guard.snapshot()).toMatchObject({ entries: [], denyAll: true });
  });

  it("implicitLoopback:false test seam removes the loopback exemption", () => {
    const { guard } = make({ entries: [], implicitLoopback: false });
    expect(guard.admitPeer("127.0.0.1", false)).toBe(false);
    expect(guard.admitPeer("::1", false)).toBe(false);
  });
});

describe("matching", () => {
  it("explicit /32 + /24, mapped dotted/hex forms, other families do not leak", () => {
    const { guard } = make({ entries: ["192.168.32.38/32", "10.1.2.0/24", "fd00::/8"] });
    expect(guard.admitPeer("192.168.32.38", false)).toBe(true);
    expect(guard.admitPeer("::ffff:192.168.32.38", false)).toBe(true);
    expect(guard.admitPeer("::ffff:c0a8:2026", false)).toBe(true); // 192.168.32.38 in hex
    expect(guard.admitPeer("192.168.32.39", false)).toBe(false);
    expect(guard.admitPeer("10.1.2.200", false)).toBe(true);
    expect(guard.admitPeer("10.1.3.1", false)).toBe(false);
    expect(guard.admitPeer("fd12::1", false)).toBe(true);
    expect(guard.admitPeer("fe80::1", false)).toBe(false);
    expect(guard.snapshot().entries).toEqual(["192.168.32.38/32", "10.1.2.0/24", "fd00::/8"]);
    expect(guard.snapshot().denyAll).toBeUndefined();
  });

  it("unparseable peer ⇒ deny (reason invalid-ip) and never logs the raw string", () => {
    const { guard, lines } = make({ entries: ["10.0.0.0/8"] });
    expect(guard.admitPeer("not an ip\r\nforged: line", false)).toBe(false);
    expect(guard.admitPeer("", false)).toBe(false);
    expect(lines[0]).toMatchObject({ reason: "invalid-ip", ip: "(invalid)" });
    expect(JSON.stringify(lines)).not.toContain("forged");
    expect(guard.snapshot().denied?.lastIp).toBe("(invalid)");
  });

  it("trusted-proxy peers pass admitPeer (request level decides) even with an unrelated allowlist", () => {
    const { guard, lines } = make({ entries: ["10.1.2.3/32"] });
    expect(guard.admitPeer("192.168.0.9", true)).toBe(true);
    expect(lines).toEqual([]);
  });

  it("defensive entry hygiene: invalid dropped (never widened), deduped, capped at 64", () => {
    const junk = make({ entries: ["bad", "10.0.0.5", "10.0.0.5/32", "10.0.0.0/33", "::ffff:10.0.0.5/128"] });
    expect(junk.guard.snapshot().entries).toEqual(["10.0.0.5/32"]);
    expect(junk.guard.admitPeer("10.0.0.6", false)).toBe(false);
    const allBad = make({ entries: ["x", "y"] });
    expect(allBad.guard.active).toBe(true);
    expect(allBad.guard.admitPeer("10.0.0.6", false)).toBe(false); // fewer admitted, never more
    expect(allBad.guard.snapshot().denyAll).toBe(true);
    const many = make({ entries: Array.from({ length: 70 }, (_, i) => `10.9.${i}.1`) });
    expect(many.guard.snapshot().entries).toHaveLength(64);
    expect(many.guard.admitPeer("10.9.63.1", false)).toBe(true);
    expect(many.guard.admitPeer("10.9.64.1", false)).toBe(false);
  });
});

describe("admitForwarded (trusted-proxy hops)", () => {
  it("same guard, one keep-alive-like sequence: allowed → denied → missing XFF, each judged independently", () => {
    const { guard, lines } = make({ entries: ["192.168.32.38/32"] });
    expect(guard.admitForwarded({ clientIp: "192.168.32.38", xffUsable: true })).toBe(true);
    expect(guard.admitForwarded({ clientIp: "203.0.113.7", xffUsable: true })).toBe(false);
    // XFF missing/malformed ⇒ clientIp falls back to the proxy peer and xffUsable is false ⇒ fail closed,
    // even when that fallback address would itself be allowed.
    expect(guard.admitForwarded({ clientIp: "192.168.32.38", xffUsable: false })).toBe(false);
    expect(guard.admitForwarded({ clientIp: "192.168.32.38", xffUsable: true })).toBe(true);
    expect(lines.map((l) => [l.via, l.reason])).toEqual([
      ["forwarded", "not-allowed"],
      ["forwarded", "xff-unusable"],
    ]);
  });

  it("absent xffUsable (undefined, e.g. an old caller) is NOT usable", () => {
    const { guard } = make({ entries: ["10.0.0.0/8"] });
    const input = { clientIp: "10.0.0.1" } as unknown as { clientIp: string; xffUsable: boolean };
    expect(guard.admitForwarded(input)).toBe(false);
  });

  it("implicit loopback applies to the resolved client too; unparseable resolved IP is denied", () => {
    const { guard } = make({ entries: ["10.0.0.0/8"] });
    expect(guard.admitForwarded({ clientIp: "127.0.0.1", xffUsable: true })).toBe(true);
    expect(guard.admitForwarded({ clientIp: "zzz", xffUsable: true })).toBe(false);
  });
});

describe("audit throttle", () => {
  it("≤1 line per IP per 10 min; next line carries the suppressed count; only whitelisted keys", () => {
    const { guard, lines, advance } = make({ entries: ["10.0.0.0/8"] });
    for (let i = 0; i < 5; i++) guard.admitPeer("203.0.113.9", false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      audit: "client-deny",
      listener: "lan",
      ip: "203.0.113.9",
      via: "peer",
      reason: "not-allowed",
      suppressed: 0,
    });
    advance(10 * MIN - 1);
    guard.admitPeer("203.0.113.9", false);
    expect(lines).toHaveLength(1);
    advance(2);
    guard.admitPeer("203.0.113.9", false);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ ip: "203.0.113.9", suppressed: 5 });
    // another IP is independent
    guard.admitPeer("203.0.113.10", false);
    expect(lines).toHaveLength(3);
  });

  it("60 lines per 10 min globally, then exactly ONE overflow line; resets next window", () => {
    const { guard, lines, advance } = make({ entries: ["10.0.0.0/8"] });
    for (let i = 0; i < 200; i++) guard.admitPeer(`203.0.${i >> 8}.${i & 255}`, false);
    expect(lines).toHaveLength(CLIENT_DENY_LINES_PER_WINDOW + 1);
    expect(lines.filter((l) => l.reason === "overflow")).toHaveLength(1);
    expect(guard.snapshot().denied?.total).toBe(200);
    advance(10 * MIN + 1);
    const before = lines.length;
    guard.admitPeer("203.0.5.5", false);
    expect(lines.length).toBe(before + 1);
    expect(lines[before]).toMatchObject({ ip: "203.0.5.5", reason: "not-allowed" });
  });

  it("an audit sink that throws never changes the decision", () => {
    const guard = createClientAllowGuard({
      entries: ["10.0.0.0/8"],
      log: {
        info() {
          throw new Error("disk full");
        },
      },
    });
    expect(guard.admitPeer("8.8.8.8", false)).toBe(false);
    expect(guard.admitPeer("10.1.1.1", false)).toBe(true);
  });

  it("forListener views share state and only change the audit tag", () => {
    const { guard, lines } = make({ entries: ["10.0.0.0/8"] });
    const proxy = guard.forListener("proxy");
    expect(proxy.active).toBe(true);
    proxy.admitPeer("8.8.8.8", false);
    expect(lines[0]).toMatchObject({ listener: "proxy" });
    expect(guard.snapshot().denied?.total).toBe(1); // shared counters
    expect(tagClientAllowGuard(guard, "proxy").active).toBe(true);
    const foreign: ClientAllowGuard = { ...guard } as ClientAllowGuard;
    delete (foreign as Partial<typeof guard>).forListener;
    expect(tagClientAllowGuard(foreign, "proxy")).toBe(foreign);
  });
});

describe("bounded bookkeeping", () => {
  it("per-IP map ≤ 1024 and burst deque ≤ 512 under a flood of distinct and repeated denials", () => {
    const { guard, advance } = make({ entries: ["10.0.0.0/8"] });
    for (let i = 0; i < 5000; i++) {
      guard.admitPeer(`198.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, false);
      if (i % 700 === 699) advance(11 * MIN); // let windows roll so pruning of expired entries runs too
      const b = guard.bookkeeping();
      expect(b.ips).toBeLessThanOrEqual(CLIENT_DENY_MAP_MAX);
      expect(b.burst).toBeLessThanOrEqual(CLIENT_DENY_BURST_DEQUE_MAX);
    }
    for (let i = 0; i < 2000; i++) guard.admitPeer("198.51.100.1", false);
    expect(guard.bookkeeping().burst).toBeLessThanOrEqual(CLIENT_DENY_BURST_DEQUE_MAX);
    expect(guard.snapshot().denied?.total).toBe(7000);
  });
});

describe("burst", () => {
  function burstRig() {
    const rig = make({ entries: ["10.0.0.0/8"] });
    const bursts: ClientAllowBurst[] = [];
    const off = rig.guard.onBurst((b) => bursts.push(b));
    const deny = (n: number, spreadMs = 0) => {
      for (let i = 0; i < n; i++) {
        rig.guard.admitPeer(ip((i % 7) + 100).replace(/^10/, "172"), false);
        if (spreadMs) rig.advance(spreadMs);
      }
    };
    return { ...rig, bursts, off, deny };
  }

  it("fires at the 20th denial in 10 min, exactly once, with bounded ips/lastIp", () => {
    const r = burstRig();
    r.deny(19);
    expect(r.bursts).toHaveLength(0);
    r.guard.admitPeer("198.51.100.77", false);
    expect(r.bursts).toHaveLength(1);
    expect(r.bursts[0]!.count).toBe(20);
    expect(r.bursts[0]!.lastIp).toBe("198.51.100.77");
    expect(r.bursts[0]!.ips[0]).toBe("198.51.100.77");
    expect(r.bursts[0]!.ips.length).toBeLessThanOrEqual(10);
    expect(new Set(r.bursts[0]!.ips).size).toBe(r.bursts[0]!.ips.length);
    r.deny(500);
    expect(r.bursts).toHaveLength(1);
  });

  it("denials spread wider than 10 min never reach the threshold", () => {
    const r = burstRig();
    r.deny(60, 40_000); // 15 per 10 min
    expect(r.bursts).toHaveLength(0);
  });

  it("re-arms after 1 h: at most one burst per hour, then again when the window is hot again", () => {
    const r = burstRig();
    r.deny(20);
    expect(r.bursts).toHaveLength(1);
    r.advance(30 * MIN);
    r.deny(30);
    expect(r.bursts).toHaveLength(1);
    r.advance(31 * MIN); // 61 min after the first fire; old denials aged out
    r.deny(19);
    expect(r.bursts).toHaveLength(1);
    r.deny(1);
    expect(r.bursts).toHaveLength(2);
  });

  it("unsubscribe stops delivery; a throwing subscriber never breaks the denial path or other subscribers", () => {
    const r = burstRig();
    r.guard.onBurst(() => {
      throw new Error("boom");
    });
    r.off();
    r.deny(20);
    expect(r.bursts).toHaveLength(0);
    const seen: number[] = [];
    r.advance(2 * 60 * MIN);
    r.guard.onBurst((b) => seen.push(b.count));
    expect(() => r.deny(20)).not.toThrow();
    expect(seen).toEqual([20]);
  });
});
