import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseFabricXsChannelSettings } from "../../src/config/settings.js";

/** channel-plan §6.4 (CH0). */
const d = DEFAULT_SETTINGS.fabric.crossSession.channels;
const ch = (block: unknown) =>
  loadSettings({ fabric: { crossSession: { channels: block } } }).fabric.crossSession.channels;

describe("fabric.crossSession.channels settings", () => {
  it("defaults (Q5/Q6)", () => {
    expect(d).toEqual({
      enabled: true,
      autoJoin: ["default"],
      autoJoinInvalid: false,
      broadcast: { outPerHour: 6, minIntervalS: 60, wakeOutPerHour: 2, maxRecipients: 16, wakeMaxRecipients: 4 },
    });
    expect(loadSettings({}).fabric.crossSession.channels).toEqual(d);
    expect(loadSettings({}).fabric.crossSession.channels).not.toBe(d);
  });

  it("non-object blocks fall back without aliasing", () => {
    for (const input of [undefined, null, 1, "x", true, [], [1]]) {
      const parsed = parseFabricXsChannelSettings(input);
      expect(parsed).toEqual(d);
      expect(parsed).not.toBe(d);
      expect(parsed.autoJoin).not.toBe(d.autoJoin);
      expect(parsed.broadcast).not.toBe(d.broadcast);
    }
  });

  it("wakeOutPerHour can never exceed 2 and wakeMaxRecipients never 4 (hard ceilings — tighten only)", () => {
    expect(ch({ broadcast: { wakeOutPerHour: 3 } }).broadcast.wakeOutPerHour).toBe(2);
    expect(ch({ broadcast: { wakeOutPerHour: 999 } }).broadcast.wakeOutPerHour).toBe(2);
    expect(ch({ broadcast: { wakeOutPerHour: 1 } }).broadcast.wakeOutPerHour).toBe(1);
    expect(ch({ broadcast: { wakeOutPerHour: 0 } }).broadcast.wakeOutPerHour).toBe(0);
    expect(ch({ broadcast: { wakeOutPerHour: -5 } }).broadcast.wakeOutPerHour).toBe(0);
    expect(ch({ broadcast: { wakeMaxRecipients: 5 } }).broadcast.wakeMaxRecipients).toBe(4);
    expect(ch({ broadcast: { wakeMaxRecipients: 2 } }).broadcast.wakeMaxRecipients).toBe(2);
    expect(ch({ broadcast: { wakeMaxRecipients: 0 } }).broadcast.wakeMaxRecipients).toBe(1);
  });

  it("clamps the other leaves into their bounds and floors fractions", () => {
    expect(ch({ broadcast: { outPerHour: 1000 } }).broadcast.outPerHour).toBe(60);
    expect(ch({ broadcast: { outPerHour: 0 } }).broadcast.outPerHour).toBe(0); // 0 = forbidden
    expect(ch({ broadcast: { outPerHour: -1 } }).broadcast.outPerHour).toBe(0);
    expect(ch({ broadcast: { minIntervalS: 1 } }).broadcast.minIntervalS).toBe(10);
    expect(ch({ broadcast: { minIntervalS: 99_999 } }).broadcast.minIntervalS).toBe(3_600);
    expect(ch({ broadcast: { maxRecipients: 1 } }).broadcast.maxRecipients).toBe(2);
    expect(ch({ broadcast: { maxRecipients: 500 } }).broadcast.maxRecipients).toBe(32);
    expect(ch({ broadcast: { outPerHour: 7.9 } }).broadcast.outPerHour).toBe(7);
  });

  it("wrong-typed leaves fall back to defaults field by field; never throws", () => {
    const parsed = ch({
      enabled: "yes",
      autoJoin: "default",
      broadcast: {
        outPerHour: "6",
        minIntervalS: NaN,
        wakeOutPerHour: null,
        maxRecipients: Infinity,
        wakeMaxRecipients: {},
      },
    });
    expect(parsed).toEqual(d);
    expect(ch({ broadcast: "no" })).toEqual(d);
    expect(ch({ broadcast: [1] })).toEqual(d);
  });

  it("enabled is honoured", () => {
    expect(ch({ enabled: false }).enabled).toBe(false);
    expect(ch({ enabled: true }).enabled).toBe(true);
  });

  describe("autoJoin", () => {
    it("normalizes, de-duplicates, orders default first, caps at 4", () => {
      expect(ch({ autoJoin: ["#Team", "default", "team", "b", "c", "d"] }).autoJoin).toEqual([
        "default",
        "b",
        "c",
        "d",
      ]);
    });

    it("drops invalid and reserved entries but keeps the valid ones", () => {
      const parsed = ch({ autoJoin: ["root", "团队", 5, "ok"] });
      expect(parsed.autoJoin).toEqual(["ok"]);
      expect(parsed.autoJoinInvalid).toBe(false);
    });

    it("a non-empty list with ZERO valid entries joins nothing and flags autoJoinInvalid (warns once)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const parsed = ch({ autoJoin: ["root", "团队"] });
        expect(parsed.autoJoin).toEqual([]);
        expect(parsed.autoJoinInvalid).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("an explicitly empty list joins nothing without being flagged invalid", () => {
      const parsed = ch({ autoJoin: [] });
      expect(parsed.autoJoin).toEqual([]);
      expect(parsed.autoJoinInvalid).toBe(false);
    });

    it("a non-array autoJoin keeps the default", () => {
      expect(ch({ autoJoin: 7 }).autoJoin).toEqual(["default"]);
    });
  });

  it("old configs (no channels block) parse every pre-existing crossSession leaf unchanged", () => {
    const { channels: _c, ...rest } = loadSettings({
      fabric: { crossSession: { enabled: true, autoJoin: true, receive: "deliver", limits: { sendsOutPerMin: 3 } } },
    }).fabric.crossSession;
    expect(rest.enabled).toBe(true);
    expect(rest.autoJoin).toBe(true); // the legacy boolean leaf is untouched
    expect(rest.receive).toBe("deliver");
    expect(rest.limits.sendsOutPerMin).toBe(3);
  });
});
