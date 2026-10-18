import { describe, expect, it } from "vitest";
import { readMeasureUsage } from "../../src/cache-ttl/measure-usage.js";

const api = "anthropic-messages";
const raw = { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };

describe("strict Anthropic measurement usage", () => {
  it("adds uncached, read and written tokens; output at message_start is NOT final output", () => {
    expect(readMeasureUsage(api, { ...raw, output_tokens: 1 })).toEqual({
      usage: { P: 132, C: 100, W: 20 },
      cacheEvidence: { kind: "valid" },
      billing: { kind: "unknown", items: ["output"] },
    });
  });
  it("keeps zero distinct from missing, including the 1h split", () => {
    expect(
      readMeasureUsage(
        api,
        {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0 },
        },
        "long",
      ),
    ).toEqual({
      usage: { P: 0, C: 0, W: 0, W1h: 0 },
      cacheEvidence: { kind: "valid" },
      billing: { kind: "unknown", items: ["output"] },
    });
    const withoutSplit = readMeasureUsage(api, raw, "long");
    expect(withoutSplit).toEqual({
      usage: { P: 132, C: 100, W: 20 },
      cacheEvidence: { kind: "valid" },
      billing: { kind: "unknown", items: ["output", "write1h-split"] },
    });
    expect(withoutSplit.usage).not.toHaveProperty("W1h");
    expect(withoutSplit.usage).not.toHaveProperty("output");
  });
  it.each([undefined, null, [], "usage"])("absent/non-object usage is invalid, not zero-filled (%j)", (value) => {
    expect(readMeasureUsage(api, value)).toEqual({
      cacheEvidence: { kind: "invalid", reason: "no-terminal-frame" },
      billing: { kind: "unknown", items: ["all"] },
    });
  });
  it.each([
    ["input_tokens", "missing-prompt"],
    ["cache_creation_input_tokens", "missing-prompt"],
    ["cache_read_input_tokens", "missing-cached"],
  ])("requires %s", (field, reason) => {
    const value: Record<string, unknown> = { ...raw };
    delete value[field!];
    expect(readMeasureUsage(api, value)).toEqual({
      cacheEvidence: { kind: "invalid", reason },
      billing: { kind: "unknown", items: ["all"] },
    });
  });
  it.each(["12", null, 1.5, NaN, Infinity, {}, Number.MAX_SAFE_INTEGER + 1])(
    "flags invalid present counters (%j)",
    (value) => {
      for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
        expect(readMeasureUsage(api, { ...raw, [field]: value })).toEqual({
          cacheEvidence: { kind: "invalid", reason: "not-integer" },
          billing: { kind: "unknown", items: ["all"] },
        });
      }
      expect(
        readMeasureUsage(api, { ...raw, cache_creation: { ephemeral_1h_input_tokens: value } }).cacheEvidence,
      ).toEqual({ kind: "invalid", reason: "not-integer" });
    },
  );
  it.each(["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"])(
    "flags negatives (%s)",
    (field) => {
      const value = readMeasureUsage(api, { ...raw, [field]: -1 });
      expect(value.cacheEvidence).toEqual({ kind: "invalid", reason: "negative" });
      expect(value).not.toHaveProperty("usage");
      expect(value.billing.kind).toBe("unknown");
    },
  );
  it("rejects W1h > W, but accepts equality and absent short split independently of billing", () => {
    expect(
      readMeasureUsage(api, { ...raw, cache_creation: { ephemeral_1h_input_tokens: 21 } }, "long").cacheEvidence,
    ).toEqual({ kind: "invalid", reason: "write1h-exceeds-write" });
    expect(
      readMeasureUsage(api, { ...raw, cache_creation: { ephemeral_1h_input_tokens: 20 } }, "long").usage?.W1h,
    ).toBe(20);
    expect(readMeasureUsage(api, raw).cacheEvidence.kind).toBe("valid");
    expect(readMeasureUsage(api, raw).billing.kind).toBe("unknown");
  });
  it("P includes C and W by construction (C ≤ P and C + W ≤ P), even with large cached baselines", () => {
    for (const input of [0, 12, 4096])
      for (const C of [0, 4096, 19200])
        for (const W of [0, 100, 15000]) {
          const value = readMeasureUsage(api, {
            input_tokens: input,
            cache_read_input_tokens: C,
            cache_creation_input_tokens: W,
          });
          expect(value.usage).toEqual({ P: input + C + W, C, W });
          expect(C).toBeLessThanOrEqual(value.usage!.P);
          expect(C + W).toBeLessThanOrEqual(value.usage!.P);
        }
  });
  it("does not turn overflowing prompt totals into evidence", () => {
    expect(readMeasureUsage(api, { ...raw, input_tokens: Number.MAX_SAFE_INTEGER }).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "not-integer",
    });
  });
  it.each(["openai-responses", "openai-completions"] as const)(
    "does not misread Anthropic fields as another profile (%s)",
    (profile) => {
      expect(readMeasureUsage(profile, raw).cacheEvidence.kind).toBe("invalid");
      expect(readMeasureUsage(profile, raw)).not.toHaveProperty("usage");
    },
  );
});
