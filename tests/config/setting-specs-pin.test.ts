/**
 * #56 batch 2 ⑧ (D8-3): SETTING_SPECS is assembled from per-subsystem shards. This pins, captured on the
 * baseline `90dbb88e`, the listing ORDER (both `/agent settings` surfaces render in this order) and the full
 * serialised content of every spec, so the shard split can only be a pure move.
 * `GOV_SPECS_GENERATE=1` rewrites the pin — baseline commit only; never to make a refactor pass.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultOf, SETTING_SPECS } from "../../src/config/setting-specs.js";

const PIN_PATH = join(import.meta.dirname, "__corpus__", "setting-specs-pin.json");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Pin {
  baseline: string;
  /** [storage key, sha256 of JSON.stringify(spec)] in listing order. */
  specs: [string, string][];
  all: string;
}

function snapshot(specs = SETTING_SPECS): Pin {
  return {
    baseline: "90dbb88e",
    specs: Object.entries(specs).map(([key, spec]) => [key, sha(JSON.stringify(spec))]),
    all: sha(JSON.stringify(specs)),
  };
}

if (process.env.GOV_SPECS_GENERATE === "1") {
  describe("setting-specs pin generation (baseline only)", () => {
    it("writes the pin", () => {
      writeFileSync(PIN_PATH, JSON.stringify(snapshot()));
      expect(Object.keys(SETTING_SPECS).length).toBeGreaterThan(250);
    });
  });
} else {
  const pin = JSON.parse(readFileSync(PIN_PATH, "utf8")) as Pin;
  // task55 /fast is an intentional additive feature, not a refactor baseline refresh.
  // Remove exactly its one declared key; any other added/changed/reordered key still fails.
  const legacySpecs = Object.fromEntries(Object.entries(SETTING_SPECS).filter(([key]) => key !== "fast.enabled"));
  describe("SETTING_SPECS pin (order + content)", () => {
    it("adds exactly fast.enabled at the end, with the declared non-live default", () => {
      const oldKeys = pin.specs.map(([key]) => key);
      expect(Object.keys(SETTING_SPECS).filter((key) => !oldKeys.includes(key))).toEqual(["fast.enabled"]);
      expect(Object.keys(SETTING_SPECS)).toEqual([...oldKeys, "fast.enabled"]);
      expect(SETTING_SPECS["fast.enabled"]).toEqual({
        kind: "boolean",
        path: "fast.enabled",
        description: "/fast 总开关（默认 true，初始 inherit 不改请求）；false 为零接线紧急关闭，修改后需 /reload",
      });
      expect(defaultOf(SETTING_SPECS["fast.enabled"]!)).toBe(true);
    });
    it("lists the same keys in the same order", () => {
      expect(Object.keys(legacySpecs)).toEqual(pin.specs.map(([key]) => key));
    });
    it("every spec serialises identically (key order inside the spec included)", () => {
      const now = snapshot(legacySpecs);
      const changed = now.specs.filter(([key, h], i) => pin.specs[i]?.[0] !== key || pin.specs[i]?.[1] !== h);
      expect(changed.map(([key]) => key)).toEqual([]);
      expect(now.all).toBe(pin.all);
    });
  });
}
