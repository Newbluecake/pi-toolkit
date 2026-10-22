import { describe, expect, it } from "vitest";
import {
  XS_DEFAULT_CHANNEL,
  XS_MAX_CHANNELS,
  capChannels,
  channelSet,
  channelsFieldToWrite,
  checkChannelName,
  displayChannel,
  effectiveChannels,
  intersect,
  isDefaultOnly,
  isReservedChannel,
  linkChannels,
  linkJoined,
  normalizeChannel,
  sharedFieldToWrite,
  shares,
  viaOrDefault,
} from "../../src/fabric/xs/channel.js";

describe("channel names (channel-plan §2.1)", () => {
  it("constants", () => {
    expect(XS_DEFAULT_CHANNEL).toBe("default");
    expect(XS_MAX_CHANNELS).toBe(4);
    expect(displayChannel("team")).toBe("#team");
  });

  it("normalizes: strips one #, lower-cases ASCII", () => {
    expect(normalizeChannel("#Team")).toBe("team");
    expect(normalizeChannel("team")).toBe("team");
    expect(normalizeChannel("A_b-9")).toBe("a_b-9");
    expect(normalizeChannel("0abc")).toBe("0abc");
    expect(normalizeChannel("a".repeat(32))).toBe("a".repeat(32));
  });

  it.each([
    "",
    "#",
    "##a",
    "-a",
    "_a",
    "a".repeat(33),
    "a b",
    "a.b",
    "a/b",
    "团队",
    "tеam", // Cyrillic е
    "ｔｅａｍ", // full-width
    "\u212Aelvin", // KELVIN SIGN would fold into ASCII k under toLowerCase
    "a\n",
    " a",
  ])("rejects %j", (bad) => {
    expect(normalizeChannel(bad)).toBeNull();
  });

  it("rejects non-strings", () => {
    for (const v of [undefined, null, 1, {}, ["a"]]) expect(normalizeChannel(v)).toBeNull();
  });

  it("reserved names and the pi- prefix cannot be joined; default is not reserved", () => {
    for (const r of [
      "all",
      "everyone",
      "here",
      "none",
      "root",
      "system",
      "main",
      "hub",
      "session",
      "xs",
      "pi-x",
      "pi-",
    ]) {
      expect(isReservedChannel(r), r).toBe(true);
      expect(checkChannelName(`#${r.toUpperCase()}`)).toEqual({ ok: false, reason: "reserved" });
    }
    expect(isReservedChannel("default")).toBe(false);
    expect(isReservedChannel("pix")).toBe(false);
    expect(checkChannelName("#Default")).toEqual({ ok: true, name: "default" });
    expect(checkChannelName("#team")).toEqual({ ok: true, name: "team" });
    expect(checkChannelName("团队")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("channel sets", () => {
  it("channelSet de-duplicates, sorts, default first", () => {
    expect(channelSet(["b", "default", "a", "b"])).toEqual(["default", "a", "b"]);
    expect(channelSet([])).toEqual([]);
  });

  it("capChannels normalizes, drops invalid, truncates to 4", () => {
    expect(capChannels(["#B", "x y", 3, "a", "default", "c", "d", "e"])).toEqual(["default", "a", "b", "c"]);
  });

  it("intersect / shares / isDefaultOnly", () => {
    expect(intersect(["default", "a", "b"], ["b", "default", "z"])).toEqual(["default", "b"]);
    expect(intersect(["a"], ["b"])).toEqual([]);
    expect(shares(["a"], ["b", "a"])).toBe(true);
    expect(shares(["a"], [])).toBe(false);
    expect(isDefaultOnly(["default"])).toBe(true);
    expect(isDefaultOnly(["default", "a"])).toBe(false);
    expect(isDefaultOnly([])).toBe(false);
    expect(isDefaultOnly(["a"])).toBe(false);
  });
});

describe("effectiveChannels / linkChannels truth table (§2.3)", () => {
  const prefs: string[][] = [[], ["default"], ["a"], ["default", "a"], ["a", "b"]];
  const table: Array<{
    pref: string[];
    enabled: boolean;
    hubCap: boolean;
    eff: string[];
    link: string[];
    joined: boolean;
  }> = [];
  for (const pref of prefs) {
    for (const enabled of [true, false]) {
      for (const hubCap of [true, false]) {
        const eff = enabled ? [...pref] : pref.filter((c) => c === "default");
        const link = hubCap ? eff : eff.filter((c) => c === "default");
        table.push({ pref, enabled, hubCap, eff, link, joined: link.length > 0 });
      }
    }
  }
  it.each(table)("pref=$pref enabled=$enabled hubCap=$hubCap", ({ pref, enabled, hubCap, eff, link, joined }) => {
    expect(effectiveChannels(pref, enabled)).toEqual(eff);
    expect(linkChannels(pref, enabled, hubCap)).toEqual(link);
    expect(linkJoined(pref, enabled, hubCap)).toBe(joined);
  });

  it("explicit rows: suspended named channels never fold into default", () => {
    expect(effectiveChannels(["a"], false)).toEqual([]); // not ["default"]
    expect(linkChannels(["a"], true, false)).toEqual([]); // old hub: only-#a ⇒ not joined
    expect(linkJoined(["a"], true, false)).toBe(false);
    expect(linkChannels(["default", "a"], true, false)).toEqual(["default"]);
  });
});

describe("§3.2 frozen write rules", () => {
  it("channelsFieldToWrite: absent for default-only, empty or no hub cap", () => {
    expect(channelsFieldToWrite(["default"], true)).toBeUndefined();
    expect(channelsFieldToWrite([], true)).toBeUndefined();
    expect(channelsFieldToWrite(["default", "a"], false)).toBeUndefined();
    expect(channelsFieldToWrite(["a"], true)).toEqual(["a"]);
    expect(channelsFieldToWrite(["default", "a"], true)).toEqual(["default", "a"]);
  });

  it("channelsFieldToWrite returns a copy", () => {
    const eff = ["default", "a"];
    expect(channelsFieldToWrite(eff, true)).not.toBe(eff);
  });

  it("sharedFieldToWrite (via / rows.channels): absent for [default] or non-capable peer", () => {
    expect(sharedFieldToWrite(["default"], true)).toBeUndefined();
    expect(sharedFieldToWrite([], true)).toBeUndefined();
    expect(sharedFieldToWrite(["a"], false)).toBeUndefined();
    expect(sharedFieldToWrite(["default", "a"], true)).toEqual(["default", "a"]);
  });

  it("a missing via reads as [default] (§3.4)", () => {
    expect(viaOrDefault(undefined)).toEqual(["default"]);
    expect(viaOrDefault(["a"])).toEqual(["a"]);
  });
});
