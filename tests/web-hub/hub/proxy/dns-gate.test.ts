import { describe, expect, it, vi } from "vitest";
import {
  createProxyDnsGate,
  resolveProxyTarget,
  systemProxyTimer,
} from "../../../../src/web-hub/hub/proxy/dns-gate.js";
import { PROXY_DNS_TIMEOUT_MS } from "../../../../src/web-hub/protocol/proxy.js";
import { deferred, flush, manualClock } from "./helpers.js";

const self = { hubPort: 48000, lanPort: 7879, proxyRange: [7900, 7949] as const, localAddresses: ["192.168.1.5"] };
const answer = (address: string) => ({ address, family: address.includes(":") ? 6 : 4 });

describe("T-F2 single-slot DNS, all-answer fence and pin", () => {
  it.each([
    [["192.168.1.1", "8.8.8.8"], "mixed-answer"],
    [["8.8.8.8", "192.168.1.1"], "mixed-answer"],
    [["169.254.169.254", "8.8.8.8"], "metadata"],
    [["8.8.8.8", "169.254.169.254"], "public"],
    [["::ffff:a9fe:a9fe", "64:ff9b::a00:1"], "metadata"],
    [["invalid", "192.168.1.1"], "mixed-answer"],
    [["invalid"], "dns-failed"],
    [[], "dns-failed"],
  ] as const)("fences all answers %j => %s", async (ips, reason) => {
    const clock = manualClock();
    const dns = createProxyDnsGate({ lookup: async () => ips.map(answer), timer: clock.timer });
    expect(await resolveProxyTarget("nas.local:3000", dns, self)).toEqual({ ok: false, reason });
    expect(clock.pending()).toBe(0);
  });
  it("prefers first IPv4, pins once and never looks up again to use dial coordinates", async () => {
    const clock = manualClock();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([answer("fd12::1"), answer("192.168.1.10"), answer("10.0.0.3")])
      .mockResolvedValue([answer("8.8.8.8")]);
    const dns = createProxyDnsGate({ lookup, timer: clock.timer });
    const r = await resolveProxyTarget("nas.local:3000", dns, self);
    expect(r).toMatchObject({
      ok: true,
      pinned: { pinnedIp: "192.168.1.10", cls: "private", key: "192.168.1.10|3000|nas.local:3000" },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("nas.local", { all: true, verbatim: true });
    if (!r.ok) throw new Error("resolve failed");
    const dial = vi.fn();
    for (let i = 0; i < 3; i++) dial({ host: r.pinned.pinnedIp, port: r.pinned.target.port });
    expect(dial.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ host: "192.168.1.10", port: 3000 }]));
    expect(lookup).toHaveBeenCalledTimes(1);
    // A NEW open must check fresh DNS. It doesn't mutate the old pinned record.
    expect(await resolveProxyTarget("nas.local:3000", dns, self)).toEqual({ ok: false, reason: "public" });
    expect(r.pinned.pinnedIp).toBe("192.168.1.10");
  });
  it("uses first IPv6 if no IPv4 and unwraps mapped IPv6 before selection", async () => {
    const clock = manualClock();
    let ips = ["fd12::1", "fc12::2"];
    const dns = createProxyDnsGate({ lookup: async () => ips.map(answer), timer: clock.timer });
    expect(await resolveProxyTarget("nas.local:3000", dns, self)).toMatchObject({
      pinned: { pinnedIp: "fd12::1", cls: "ula" },
    });
    ips = ["fd12::1", "::ffff:7f00:1"];
    expect(await resolveProxyTarget("nas.local:3000", dns, self)).toMatchObject({
      pinned: { pinnedIp: "127.0.0.1", cls: "loopback" },
    });
  });
  it("caller timeout retains the physical slot until the real promise settles, with zero queued lookups", async () => {
    const clock = manualClock();
    const pending = deferred<ReturnType<typeof answer>[]>();
    const lookup = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue([answer("10.0.0.1")]);
    const dns = createProxyDnsGate({ lookup, timer: clock.timer });
    const first = dns.resolve("nas.local");
    await flush();
    expect(dns.inflight).toBe(true);
    expect(await dns.resolve("other.local")).toEqual({ ok: false, reason: "dns-timeout" });
    expect(lookup).toHaveBeenCalledTimes(1);
    clock.advance(PROXY_DNS_TIMEOUT_MS);
    expect(await first).toEqual({ ok: false, reason: "dns-timeout" });
    expect(dns.inflight).toBe(true);
    expect(await dns.resolve("third.local")).toEqual({ ok: false, reason: "dns-timeout" });
    pending.resolve([answer("8.8.8.8")]);
    await flush();
    expect(dns.inflight).toBe(false);
    expect(await dns.resolve("third.local")).toEqual({ ok: true, answers: [answer("10.0.0.1")] });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(clock.pending()).toBe(0);
  });
  it.each([false, true])("releases slot for lookup failure (sync throw=%s)", async (sync) => {
    const clock = manualClock();
    const lookup = () => {
      if (sync) throw new Error("secret url");
      return Promise.reject(new Error("secret url"));
    };
    const dns = createProxyDnsGate({ lookup, timer: clock.timer });
    expect(await dns.resolve("nas.local")).toEqual({ ok: false, reason: "dns-failed" });
    expect(dns.inflight).toBe(false);
    expect(clock.pending()).toBe(0);
  });
  it("literal/localhost/metadata/syntax uses zero DNS; self-port checks actual bound addresses", async () => {
    const lookup = vi.fn();
    const dns = createProxyDnsGate({ lookup });
    for (const target of ["127.0.0.1:48000", "[::ffff:7f00:1]:48000", "localhost:7879", "192.168.1.5:7900"])
      expect(await resolveProxyTarget(target, dns, self)).toEqual({ ok: false, reason: "self-port" });
    expect(await resolveProxyTarget("localhost:3000", dns, self)).toMatchObject({ pinned: { pinnedIp: "127.0.0.1" } });
    expect(await resolveProxyTarget("metadata.google.internal:80", dns, self)).toEqual({
      ok: false,
      reason: "metadata",
    });
    expect(await resolveProxyTarget("127.1:80", dns, self)).toEqual({ ok: false, reason: "syntax" });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("system timers are unref'd and cancellable", () => {
    const unref = vi.fn();
    const token = { unref };
    const set = vi.spyOn(globalThis, "setTimeout").mockReturnValue(token as unknown as NodeJS.Timeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const fn = vi.fn();
      const cancel = systemProxyTimer.after(123, fn);
      expect(set).toHaveBeenCalledWith(fn, 123);
      expect(unref).toHaveBeenCalledOnce();
      cancel();
      expect(clear).toHaveBeenCalledWith(token);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});
