import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { effectiveReceive, isValidXsSessionId } from "../../src/fabric/xs/receive.js";
import { parseFabricCrossSessionSettings } from "../../src/fabric/settings.js";

/** fabric phase-2 XS0 (phase2-plan §4.1/§5.2/§5.3 #14): the `fabric.crossSession.*` leaves. */
const defaults = DEFAULT_SETTINGS.fabric.crossSession;
const xs = (block: unknown) => loadSettings({ fabric: { crossSession: block } }).fabric.crossSession;

describe("fabric.crossSession settings (phase2 §4.1)", () => {
  it("pins the defaults (Q2/P1/P2/P8 + review #7: independent inboxCap + reply-plan §8.1 reply block)", () => {
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
      reply: {
        enabled: true,
        defaultTimeoutS: 1_800,
        maxTimeoutS: 86_400,
        maxPending: 8,
        maxPendingPerTarget: 3,
        lateGraceS: 600,
      },
      // channel-plan §6.4 (CH0)
      channels: {
        enabled: true,
        autoJoin: ["default"],
        autoJoinInvalid: false,
        broadcast: { outPerHour: 6, minIntervalS: 60, wakeOutPerHour: 2, maxRecipients: 16, wakeMaxRecipients: 4 },
      },
      // alias-plan §3.6 (AL0b)
      alias: { enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 },
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

describe("fabric.crossSession.reply + replies (reply-plan §8.1, RX0)", () => {
  it('receive accepts "replies" as the stored preference; wrong types still fall back to wake', () => {
    expect(xs({ receive: "replies" }).receive).toBe("replies");
    // non-object blocks still clone the reply defaults without aliasing
    const parsed = parseFabricCrossSessionSettings(null);
    expect(parsed.reply).toEqual(defaults.reply);
    expect(parsed.reply).not.toBe(defaults.reply);
  });

  it("parses reply values, ignores unknown keys, and falls back per field on wrong types", () => {
    const parsed = xs({
      reply: {
        enabled: false,
        defaultTimeoutS: 600,
        maxTimeoutS: 43_200,
        maxPending: 16,
        maxPendingPerTarget: 5,
        lateGraceS: 120,
        unknownKey: 1, // tolerated, never parsed
      },
    });
    expect(parsed.reply).toEqual({
      enabled: false,
      defaultTimeoutS: 600,
      maxTimeoutS: 43_200,
      maxPending: 16,
      maxPendingPerTarget: 5,
      lateGraceS: 120,
    });
    const garbage = xs({
      reply: { enabled: "yes", defaultTimeoutS: "600", maxTimeoutS: Number.NaN, maxPending: null, lateGraceS: [] },
    });
    expect(garbage.reply).toEqual(defaults.reply);
    for (const block of [undefined, null, 0, "no", true, [], [1]]) {
      expect(xs({ reply: block }).reply).toEqual(defaults.reply);
    }
  });

  it("clamps every reply leaf to its §8.1 bounds", () => {
    const parsed = xs({
      reply: {
        defaultTimeoutS: 1, // -> 60
        maxTimeoutS: 1_000_000, // -> 86400
        maxPending: 99, // -> 32
        maxPendingPerTarget: 99, // -> 8
        lateGraceS: 9_999, // -> 3600
      },
    });
    expect(parsed.reply).toEqual({
      ...defaults.reply,
      defaultTimeoutS: 60,
      maxTimeoutS: 86_400,
      maxPending: 32,
      maxPendingPerTarget: 8,
      lateGraceS: 3_600,
    });
    // 0 is legal exactly for lateGraceS (no late grace); timeouts clamp up to their 60s floor
    const zero = xs({ reply: { lateGraceS: 0, defaultTimeoutS: 0, maxTimeoutS: 0 } });
    expect(zero.reply.lateGraceS).toBe(0);
    expect(zero.reply.defaultTimeoutS).toBe(60);
    expect(zero.reply.maxTimeoutS).toBe(60);
  });

  it('receive:"replies" with reply disabled warns exactly once and NEVER falls back to wake', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = xs({ receive: "replies", reply: { enabled: false } });
    // the stored preference stays "replies" — the EFFECTIVE value is off (never wake)
    expect(parsed.receive).toBe("replies");
    expect(effectiveReceive(parsed.receive, parsed.reply.enabled)).toBe("off");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("fabric.crossSession.receive");
    warn.mockRestore();
    // no warn while the feature is on, and none for the three legacy values with it off
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(xs({ receive: "replies" }).receive).toBe("replies");
    for (const receive of ["off", "deliver", "wake"] as const) {
      expect(xs({ receive, reply: { enabled: false } }).receive).toBe(receive);
    }
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("effectiveReceive is the single downgrade rule (replies unavailable ⇒ off)", () => {
    for (const pref of ["off", "deliver", "wake", "replies"] as const) {
      expect(effectiveReceive(pref, true)).toBe(pref);
    }
    expect(effectiveReceive("replies", false)).toBe("off");
    expect(effectiveReceive("off", false)).toBe("off");
    expect(effectiveReceive("deliver", false)).toBe("deliver");
    expect(effectiveReceive("wake", false)).toBe("wake");
  });
});
