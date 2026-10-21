import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  isValidXsSessionId,
  loadSettings,
  parseFabricCrossSessionSettings,
} from "../../src/config/settings.js";

/** fabric phase-2 XS0 (phase2-plan §4.1/§5.2/§5.3 #14): the `fabric.crossSession.*` leaves. */
const defaults = DEFAULT_SETTINGS.fabric.crossSession;
const xs = (block: unknown) => loadSettings({ fabric: { crossSession: block } }).fabric.crossSession;

describe("fabric.crossSession settings (phase2 §4.1)", () => {
  it("pins the defaults (Q2/P1/P2/P8 + review #7: independent inboxCap)", () => {
    expect(defaults).toEqual({
      enabled: false,
      autoJoin: false,
      receive: "wake",
      allowFrom: [],
      allowFromDenyAll: false,
      limits: {
        sendsOutPerMin: 10,
        sendsOutPerHour: 60,
        wakesOutPerHour: 6,
        recvPerHour: 30,
        wakesInPerHour: 12,
        inboxCap: 12,
        pairMinIntervalMs: 30_000,
        pairWakesPerHour: 2,
        inFlightPerSession: 4,
        hubSendsPerMin: 60,
        listPerMin: 6,
      },
    });
  });

  it("missing / non-object blocks fall back to defaults without aliasing DEFAULT_SETTINGS", () => {
    for (const input of [undefined, null, 0, "no", true, [], [1]]) {
      const parsed = parseFabricCrossSessionSettings(input);
      expect(parsed).toEqual(defaults);
      expect(parsed).not.toBe(defaults);
      expect(parsed.limits).not.toBe(defaults.limits);
      expect(parsed.allowFrom).not.toBe(defaults.allowFrom);
    }
    const noFabric = loadSettings({}).fabric;
    expect(noFabric.crossSession).toEqual(defaults);
    expect(noFabric.crossSession).not.toBe(DEFAULT_SETTINGS.fabric.crossSession);
    const nonObjectFabric = loadSettings({ fabric: "oops" }).fabric;
    expect(nonObjectFabric.crossSession).toEqual(defaults);
  });

  it("parses valid values and ignores unknown keys (incl. the removed r1.1 `discoverScope`)", () => {
    const parsed = xs({
      enabled: true,
      autoJoin: true,
      receive: "deliver",
      allowFrom: ["01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a"],
      discoverScope: "cwd", // P6: the key was deleted — still ignored, never parsed
      limits: { sendsOutPerMin: 5, inboxCap: 30, hubSendsPerMin: 120 },
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.autoJoin).toBe(true);
    expect(parsed.receive).toBe("deliver");
    expect(parsed.allowFrom).toEqual(["01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a"]);
    expect(parsed.allowFromDenyAll).toBe(false);
    expect(parsed.limits.sendsOutPerMin).toBe(5);
    expect(parsed.limits.inboxCap).toBe(30);
    expect(parsed.limits.hubSendsPerMin).toBe(120);
    // untouched leaves keep their defaults
    expect(parsed.limits.sendsOutPerHour).toBe(defaults.limits.sendsOutPerHour);
    expect(parsed.limits.wakesOutPerHour).toBe(defaults.limits.wakesOutPerHour);
    expect(parsed.limits.recvPerHour).toBe(defaults.limits.recvPerHour);
    expect(parsed.limits.wakesInPerHour).toBe(defaults.limits.wakesInPerHour);
    expect(parsed.limits.pairMinIntervalMs).toBe(defaults.limits.pairMinIntervalMs);
    expect(parsed.limits.pairWakesPerHour).toBe(defaults.limits.pairWakesPerHour);
    expect(parsed.limits.inFlightPerSession).toBe(defaults.limits.inFlightPerSession);
    expect(parsed.limits.listPerMin).toBe(defaults.limits.listPerMin);
    // the deleted key never materialises anywhere in the parsed shape
    expect(JSON.stringify(parsed)).not.toContain("discoverScope");
  });

  it("receive falls back to wake (P2) for wrong types; limits is tolerant of non-object garbage", () => {
    expect(xs({ receive: "sometimes" }).receive).toBe("wake");
    expect(xs({ receive: 1 }).receive).toBe("wake");
    expect(xs({ limits: "big" }).limits).toEqual(defaults.limits);
    expect(xs({ limits: [1, 2] }).limits).toEqual(defaults.limits);
  });

  it("clamps every limit leaf to its §5.2 bounds (config-accident containment)", () => {
    const parsed = xs({
      limits: {
        sendsOutPerMin: 0, // -> 1
        sendsOutPerHour: 100_000, // -> 600
        wakesOutPerHour: -3, // -> 0 (0 is legal: deliver-only)
        recvPerHour: 0.5, // -> 1
        wakesInPerHour: 99, // -> 60
        inboxCap: 1_000, // -> 64
        pairMinIntervalMs: 10, // -> 5_000
        pairWakesPerHour: 999, // -> 20
        inFlightPerSession: 0, // -> 1
        hubSendsPerMin: 1_000, // -> 600
        listPerMin: 0.9, // -> 1
      },
    });
    expect(parsed.limits).toEqual({
      sendsOutPerMin: 1,
      sendsOutPerHour: 600,
      wakesOutPerHour: 0,
      recvPerHour: 1,
      wakesInPerHour: 60,
      inboxCap: 64,
      pairMinIntervalMs: 5_000,
      pairWakesPerHour: 20,
      inFlightPerSession: 1,
      hubSendsPerMin: 600,
      listPerMin: 1,
    });
  });

  it("wrong-typed / non-finite limit leaves fall back per field", () => {
    const parsed = xs({
      limits: {
        sendsOutPerMin: "10",
        inboxCap: Number.NaN,
        pairMinIntervalMs: Infinity,
        listPerMin: false,
      },
    });
    expect(parsed.limits.sendsOutPerMin).toBe(10);
    expect(parsed.limits.inboxCap).toBe(defaults.limits.inboxCap);
    expect(parsed.limits.pairMinIntervalMs).toBe(defaults.limits.pairMinIntervalMs);
    expect(parsed.limits.listPerMin).toBe(defaults.limits.listPerMin);
  });

  describe("allowFrom (#14: full session ids only, fail closed)", () => {
    it("accepts exactly pi `assertValidSessionId` shapes", () => {
      expect(isValidXsSessionId("a")).toBe(true);
      expect(isValidXsSessionId("01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a")).toBe(true);
      expect(isValidXsSessionId("abc.DEF-123_x")).toBe(true);
      // must start AND end alphanumeric; only [A-Za-z0-9._-]; non-empty
      expect(isValidXsSessionId("")).toBe(false);
      expect(isValidXsSessionId("-abc")).toBe(false);
      expect(isValidXsSessionId("abc-")).toBe(false);
      expect(isValidXsSessionId(".abc")).toBe(false);
      expect(isValidXsSessionId("ab/cd")).toBe(false);
      expect(isValidXsSessionId("ab cd")).toBe(false);
      expect(isValidXsSessionId("ab:cd")).toBe(false);
      // prefixes / refs / names are NOT session ids by INTENT, but the rule is pi's own
      // assertValidSessionId character class — any [A-Za-z0-9._-] token with alnum endpoints
      // parses (e.g. a run-id shape like "r_ABCDEFGH"); names with spaces/colons do not.
      expect(isValidXsSessionId("r_ABCDEFGH")).toBe(true);
      expect(isValidXsSessionId("main")).toBe(true);
    });

    it("drops invalid entries with one console.warn and keeps the valid ones", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const parsed = xs({ allowFrom: ["01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a", "not a session id", 42, "-leading"] });
      expect(parsed.allowFrom).toEqual(["01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a"]);
      expect(parsed.allowFromDenyAll).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("fabric.crossSession.allowFrom");
      warn.mockRestore();
    });

    it("non-empty but ALL invalid ⇒ allowFromDenyAll (deny everything, fail closed)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const parsed = xs({ allowFrom: ["not a session id", "-leading", "trail-", "a:b"] });
      expect(parsed.allowFrom).toEqual([]);
      expect(parsed.allowFromDenyAll).toBe(true);
      warn.mockRestore();
    });

    it("absent / non-array / empty allowFrom never sets the deny-all marker", () => {
      expect(xs({}).allowFromDenyAll).toBe(false);
      expect(xs({ allowFrom: "01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a" }).allowFromDenyAll).toBe(false);
      expect(xs({ allowFrom: [] }).allowFromDenyAll).toBe(false);
    });

    it("warn fires once per parse even with many invalid entries", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      xs({ allowFrom: ["not a session id", "-x", "y-", "a b", "c:d"] });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  it("fabric.wake.rootRunMaxS joins the wake block (see fabric-wake-settings.test.ts) and the\n    tree-internal path never reads it (P7 — no cross-package wiring exists yet)", () => {
    // The parse-level contract lives in tests/config/fabric-wake-settings.test.ts; here we only
    // pin that the fabric-level crossSession block and the wake-level leaf coexist.
    const fabric = loadSettings({ fabric: { wake: { rootRunMaxS: 0 }, crossSession: { enabled: true } } }).fabric;
    expect(fabric.wake.rootRunMaxS).toBe(0);
    expect(fabric.crossSession.enabled).toBe(true);
    expect(fabric.crossSession.receive).toBe("wake");
  });
});
