// jev-plan §4 J6: resolveJevWiring — the five verdicts (four off reasons + on)
// and the JevConfig mapping.

import { describe, expect, test } from "vitest";
import { jevConfigOf, jevLayoutAllowed, resolveJevWiring } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS, parseMemorySettings } from "../../../src/memory/settings.js";

describe("resolveJevWiring", () => {
  test("defaults (tiered + v2 + enabled + two classifiers) on a plain domain ⇒ on", () => {
    const v = resolveJevWiring(DEFAULT_MEMORY_SETTINGS, "plain");
    expect(v.on).toBe(true);
    if (v.on) expect(v.config.classifiers).toEqual(DEFAULT_MEMORY_SETTINGS.jev.classifiers);
  });

  test("enabled=false ⇒ disabled", () => {
    expect(resolveJevWiring(parseMemorySettings({ jev: { enabled: false } }), "plain")).toEqual({
      on: false,
      reason: "disabled",
    });
  });

  test("legacy layout or legacy tool surface ⇒ legacy", () => {
    expect(resolveJevWiring(parseMemorySettings({ layout: "legacy" }), "plain")).toEqual({
      on: false,
      reason: "legacy",
    });
    expect(resolveJevWiring(parseMemorySettings({ toolSurface: "legacy" }), "plain")).toEqual({
      on: false,
      reason: "legacy",
    });
  });

  test("secure and locked domains ⇒ secure (wins over every other reason, I11)", () => {
    expect(resolveJevWiring(DEFAULT_MEMORY_SETTINGS, "secure")).toEqual({ on: false, reason: "secure" });
    expect(resolveJevWiring(DEFAULT_MEMORY_SETTINGS, "locked")).toEqual({ on: false, reason: "secure" });
    expect(resolveJevWiring(parseMemorySettings({ layout: "legacy", jev: { enabled: false } }), "locked")).toEqual({
      on: false,
      reason: "secure",
    });
  });

  test('classifiers "" (empty list) and all-invalid ⇒ empty-list (Q34)', () => {
    expect(resolveJevWiring(parseMemorySettings({ jev: { classifiers: "" } }), "plain")).toEqual({
      on: false,
      reason: "empty-list",
    });
    expect(resolveJevWiring(parseMemorySettings({ jev: { classifiers: "foo" } }), "plain")).toEqual({
      on: false,
      reason: "empty-list",
    });
  });

  test("jevConfigOf maps every field and dedups classifiers in order", () => {
    const s = parseMemorySettings({
      jev: {
        classifiers: "opencode/jev-1.13,opencode/jev-1.13-free",
        proxy: "http://127.0.0.1:7890",
        childSessions: false,
        recall: { threshold: 0.75, maxEntries: 2, maxBytes: 1024, waitMs: 0 },
        review: { intervalDays: 0 },
        maxCostUsd: 1,
        maxCalls: 10,
        fastPathAllowTags: "testing, ci",
        fastPathDenyTags: ["git-push"],
        fastPathCooldownH: 12,
      },
    });
    const c = jevConfigOf(s);
    expect(c).toEqual({
      classifiers: ["opencode/jev-1.13", "opencode/jev-1.13-free"],
      proxy: "http://127.0.0.1:7890",
      childSessions: false,
      recall: { threshold: 0.75, maxEntries: 2, maxBytes: 1024, waitMs: 0 },
      reviewIntervalDays: 0,
      maxCostUsd: 1,
      maxCalls: 10,
      fastPath: { allowTags: ["testing", "ci"], denyTags: ["git-push"], cooldownMs: 12 * 3_600_000 },
      predict: {
        enabled: s.jev.predict.enabled,
        childSessions: s.jev.predict.childSessions,
        maxEntries: s.jev.predict.maxEntries,
        maxBytes: s.jev.predict.maxBytes,
        cooldownMs: s.jev.predict.cooldownH * 3_600_000,
        hintU: s.jev.predict.hintU,
        model: { ...s.jev.predict.model },
        cacheTtlMin: s.jev.predict.cacheTtlMin,
      },
    });
    const dup = jevConfigOf({ ...s, jev: { ...s.jev, classifiers: ["a/b", "a/b", "c/d"] } });
    expect(dup.classifiers).toEqual(["a/b", "c/d"]);
  });
});

// ── #36 P4 修复轮（root 2026-11-06）：jev 允许 blocks 布局（v3 载体） ──

describe("jevLayoutAllowed / resolveJevWiring blocks acceptance (#36 P4)", () => {
  test("layout:blocks + toolSurface:v2 wires jev ON (the v3 carrier)", () => {
    const settings = parseMemorySettings({ layout: "blocks" });
    expect(settings.layout).toBe("blocks");
    expect(settings.toolSurface).toBe("v2");
    expect(jevLayoutAllowed(settings)).toBe(true);
    expect(resolveJevWiring(settings, "plain").on).toBe(true);
  });

  test("tiered+v2 stays ON; legacy layout or legacy tool stays OFF (unchanged)", () => {
    expect(jevLayoutAllowed(parseMemorySettings({}))).toBe(true);
    expect(resolveJevWiring(parseMemorySettings({ layout: "legacy" }), "plain")).toEqual({
      on: false,
      reason: "legacy",
    });
    expect(resolveJevWiring(parseMemorySettings({ toolSurface: "legacy" }), "plain")).toEqual({
      on: false,
      reason: "legacy",
    });
    // legacy tool over a blocks layout is still a legacy-surface mismatch
    expect(resolveJevWiring(parseMemorySettings({ layout: "blocks", toolSurface: "legacy" }), "plain")).toEqual({
      on: false,
      reason: "legacy",
    });
  });

  test("secure/D8 and disabled/empty-list keep their precedence over the layout", () => {
    expect(resolveJevWiring(parseMemorySettings({ layout: "blocks" }), "secure")).toEqual({
      on: false,
      reason: "secure",
    });
    expect(resolveJevWiring(parseMemorySettings({ layout: "blocks", jev: { enabled: false } }), "plain")).toEqual({
      on: false,
      reason: "disabled",
    });
    expect(resolveJevWiring(parseMemorySettings({ layout: "blocks", jev: { classifiers: [] } }), "plain")).toEqual({
      on: false,
      reason: "empty-list",
    });
  });
});
