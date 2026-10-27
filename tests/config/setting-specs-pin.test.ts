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
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

const PIN_PATH = join(import.meta.dirname, "__corpus__", "setting-specs-pin.json");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Pin {
  baseline: string;
  /** [storage key, sha256 of JSON.stringify(spec)] in listing order. */
  specs: [string, string][];
  all: string;
}

function snapshot(): Pin {
  return {
    baseline: "90dbb88e",
    specs: Object.entries(SETTING_SPECS).map(([key, spec]) => [key, sha(JSON.stringify(spec))]),
    all: sha(JSON.stringify(SETTING_SPECS)),
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
  describe("SETTING_SPECS pin (order + content)", () => {
    it("lists the same keys in the same order", () => {
      expect(Object.keys(SETTING_SPECS)).toEqual(pin.specs.map(([key]) => key));
    });
    it("every spec serialises identically (key order inside the spec included)", () => {
      const now = snapshot();
      const changed = now.specs.filter(([key, h], i) => pin.specs[i]?.[0] !== key || pin.specs[i]?.[1] !== h);
      expect(changed.map(([key]) => key)).toEqual([]);
      expect(now.all).toBe(pin.all);
    });
  });
}
