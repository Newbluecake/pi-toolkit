import { describe, expect, it } from "vitest";
import { normalizeTimeUnits } from "../../../src/config/time-units.js";
import { parseWebHubTerminalBlock } from "../../../src/web-hub/agent/settings.js";
import { parseTerminalPolicy } from "../../../src/web-hub/protocol/terminal-policy.js";

const paths = ["webHub.terminal.inputIdleMs", "webHub.terminal.maxLifetimeMs"];
const wrap = (block: unknown) => ({ webHub: { terminal: block } });
function oracle(block: Record<string, unknown>) {
  const normalized = normalizeTimeUnits(wrap(block), paths) as { webHub: { terminal: unknown } };
  return parseWebHubTerminalBlock(normalized.webHub.terminal).terminal;
}
const defaults = {
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: 3_600_000,
  maxLifetimeMs: 28_800_000,
};

describe("valid machine settings parity with existing time-unit + agent parser oracle", () => {
  const valid: Record<string, unknown>[] = [
    { enabled: true },
    { enabled: true, inputIdleS: 300, maxLifetimeS: 900 },
    { enabled: true, inputIdleS: 86400, maxLifetimeS: 86400 },
    { enabled: true, inputIdleMs: 300000, maxLifetimeMs: 900000 },
    { enabled: true, inputIdleMs: 86400000, maxLifetimeMs: 86400000 },
    { enabled: true, inputIdleS: 301, inputIdleMs: "ignored", maxLifetimeS: 901, maxLifetimeMs: null },
    { enabled: true, inputIdleS: 600, inputIdleMs: 7200000, maxLifetimeS: 1800, maxLifetimeMs: 4000000 },
    { enabled: true, unknownKey: { secret: "never-forwarded" } },
  ];
  for (const maxPerSession of [1, 2, 4]) {
    for (const maxPerPrincipal of [1, 4, 8]) {
      for (const maxTotal of [1, 16, 32]) valid.push({ enabled: true, maxPerSession, maxPerPrincipal, maxTotal });
    }
  }
  it.each(valid)("valid input %#", (block) => {
    const { enabled, ...policy } = oracle(block);
    expect(enabled).toBe(true);
    expect(parseTerminalPolicy(wrap(block))).toEqual({ state: "enabled", policy });
  });
  it("fills only five internal ms fields and does not mutate even frozen input", () => {
    const block = Object.freeze({ enabled: true, inputIdleS: 3600, unknown: "x" });
    expect(parseTerminalPolicy(Object.freeze({ webHub: Object.freeze({ terminal: block }) }))).toEqual({
      state: "enabled",
      policy: defaults,
    });
    expect(block).toEqual({ enabled: true, inputIdleS: 3600, unknown: "x" });
  });
});

it.each([
  {},
  { webHub: {} },
  wrap({}),
  wrap({ enabled: false }),
  wrap({ enabled: false, maxTotal: null, inputIdleS: -1 }),
  wrap({ maxTotal: "invalid-but-unused" }),
])("sparse disabled input stays off: %#", (input) => {
  expect(parseTerminalPolicy(input)).toEqual({ state: "off" });
});
it.each([null, [], "{}", 1, undefined])("invalid whole file is NOT off: %#", (input) => {
  expect(parseTerminalPolicy(input)).toEqual({ state: "unavailable", reason: "settings-invalid" });
});
it.each([null, [], true, "yes", 1])("nonobject terminal rejects: %#", (input) => {
  expect(parseTerminalPolicy(wrap(input))).toEqual({ state: "unavailable", reason: "policy-invalid" });
});
it.each([null, [], false, "bad"])("invalid webHub cannot prove terminal off: %#", (webHub) => {
  expect(parseTerminalPolicy({ webHub })).toEqual({ state: "unavailable", reason: "policy-invalid" });
});
it.each([null, "true", 1, [], {}])("enabled must be boolean: %#", (enabled) => {
  expect(parseTerminalPolicy(wrap({ enabled }))).toEqual({ state: "unavailable", reason: "policy-invalid" });
});

describe("intentional safety difference: invalid enabled limits reject the whole machine block", () => {
  const fields = [
    ["maxPerSession", 1, 4],
    ["maxPerPrincipal", 1, 8],
    ["maxTotal", 1, 32],
    ["inputIdleS", 300, 86400],
    ["maxLifetimeS", 900, 86400],
    ["inputIdleMs", 300000, 86400000],
    ["maxLifetimeMs", 900000, 86400000],
  ] as const;
  for (const [key, min, max] of fields) {
    it.each([
      null,
      "1",
      true,
      [],
      {},
      undefined,
      NaN,
      Infinity,
      -Infinity,
      -1,
      0,
      min - 1,
      max + 1,
      min + 0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ])(`${key}: invalid %# is unavailable, not agent fallback`, (value) => {
      const block = { enabled: true, [key]: value };
      expect(parseTerminalPolicy(wrap(block))).toEqual({ state: "unavailable", reason: "policy-invalid" });
      // The old tolerant parser always returns enabled/default/clamped-valid fields, never
      // this unavailable outcome. It remains unchanged and serves only as the difference oracle.
      expect(oracle(block).enabled).toBe(true);
      expect(oracle(block).maxTotal).toBeGreaterThanOrEqual(1);
    });
  }
  it.each(["inputIdle", "maxLifetime"])("legacy %sMs requires WHOLE seconds", (prefix) => {
    const block = { enabled: true, [`${prefix}Ms`]: 1_000_001 };
    expect(parseTerminalPolicy(wrap(block))).toEqual({ state: "unavailable", reason: "policy-invalid" });
    expect(oracle(block)[prefix === "inputIdle" ? "inputIdleMs" : "maxLifetimeMs"]).toBe(
      defaults[prefix === "inputIdle" ? "inputIdleMs" : "maxLifetimeMs"],
    );
  });
  it.each(["inputIdle", "maxLifetime"])("invalid new %sS never falls back to valid legacy Ms", (prefix) => {
    const block = { enabled: true, [`${prefix}S`]: "bad", [`${prefix}Ms`]: 86400000 };
    expect(parseTerminalPolicy(wrap(block))).toEqual({ state: "unavailable", reason: "policy-invalid" });
    expect(oracle(block)[prefix === "inputIdle" ? "inputIdleMs" : "maxLifetimeMs"]).toBe(
      defaults[prefix === "inputIdle" ? "inputIdleMs" : "maxLifetimeMs"],
    );
  });
  it("pins a concrete unsafe default expansion avoided by strict rejection", () => {
    const block = { enabled: true, maxTotal: 0, inputIdleS: 299 };
    expect(oracle(block)).toEqual({ enabled: true, ...defaults });
    expect(parseTerminalPolicy(wrap(block))).toEqual({ state: "unavailable", reason: "policy-invalid" });
  });
});
