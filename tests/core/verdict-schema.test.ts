import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../src/core/json-schema.js";
import {
  renderStructuredForHost,
  resolveSchemaPreset,
  SCHEMA_PRESETS,
  VERDICT_SCHEMA_V1,
  validateVerdictV1Semantics,
} from "../../src/core/verdict-schema.js";

function validPayload(over: Record<string, unknown> = {}) {
  return {
    verdict: "pass",
    blockers: 0,
    findings: [],
    report: "Everything checks out.",
    ...over,
  };
}

describe("resolveSchemaPreset (consult A/B instrumentation plan §4/§5 P1a)", () => {
  it("resolves the known preset name to {id, schema}", () => {
    const resolved = resolveSchemaPreset("verdict/v1");
    expect(resolved).toEqual({ id: "verdict/v1", schema: VERDICT_SCHEMA_V1 });
  });

  it("exposes the same schema object through SCHEMA_PRESETS", () => {
    expect(SCHEMA_PRESETS["verdict/v1"]).toBe(VERDICT_SCHEMA_V1);
  });

  it("returns undefined for an unknown string, a literal schema object, or a non-string", () => {
    expect(resolveSchemaPreset("verdict/v2")).toBeUndefined();
    expect(resolveSchemaPreset({ type: "object" })).toBeUndefined();
    expect(resolveSchemaPreset(undefined)).toBeUndefined();
    expect(resolveSchemaPreset(42)).toBeUndefined();
  });
});

describe("VERDICT_SCHEMA_V1 shape (§4) — validated through the shared validator", () => {
  it("accepts a minimal valid payload", () => {
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload()).ok).toBe(true);
  });

  it("accepts a payload with findings and an optional packageId", () => {
    const payload = validPayload({
      blockers: 1,
      findings: [{ severity: "blocker", summary: "missing test", location: "src/x.ts:10" }],
      packageId: "pkg-1",
    });
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, payload).ok).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { report: _drop, ...rest } = validPayload();
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, rest).ok).toBe(false);
  });

  it("rejects an invalid verdict enum value", () => {
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload({ verdict: "approved" })).ok).toBe(false);
  });

  it("rejects a negative blockers count", () => {
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload({ blockers: -1 })).ok).toBe(false);
  });

  it("rejects an unknown top-level property (additionalProperties: false)", () => {
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload({ extra: 1 })).ok).toBe(false);
  });

  it("rejects a findings item missing a required field or with an unknown property", () => {
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload({ findings: [{ severity: "minor" }] })).ok).toBe(
      false,
    );
    expect(
      validateAgainstSchema(
        VERDICT_SCHEMA_V1,
        validPayload({ findings: [{ severity: "minor", summary: "x", bogus: 1 }] }),
      ).ok,
    ).toBe(false);
  });

  it("rejects more than 50 findings", () => {
    const findings = Array.from({ length: 51 }, () => ({ severity: "nit" as const, summary: "x" }));
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, validPayload({ findings })).ok).toBe(false);
  });

  it("rejects a blockers count that disagrees with blocker findings", () => {
    const payload = validPayload({
      blockers: 2,
      findings: [{ severity: "blocker", summary: "one blocker" }],
    });
    expect(validateAgainstSchema(VERDICT_SCHEMA_V1, payload).ok).toBe(true);
    expect(validateVerdictV1Semantics(payload)).toEqual({
      ok: false,
      errors: [expect.stringContaining('$.blockers must equal the number of findings with severity "blocker"')],
    });
  });

  it("accepts a semantically consistent blockers count", () => {
    expect(
      validateVerdictV1Semantics(
        validPayload({
          blockers: 2,
          findings: [
            { severity: "blocker", summary: "a" },
            { severity: "blocker", summary: "b" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("keeps every enum/description string in the schema English-only (model-visible surface, CJK-free per model-facing-strings.test.ts)", () => {
    const text = JSON.stringify(VERDICT_SCHEMA_V1);
    expect(text).not.toMatch(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/);
  });
});

describe("renderStructuredForHost (consult A/B instrumentation plan §4/§5 P1a)", () => {
  it("verdict/v1 + valid shape: report verbatim plus a one-line verdict summary", () => {
    const payload = validPayload({
      verdict: "conditional_pass",
      blockers: 0,
      findings: [{ severity: "minor", summary: "nit" }],
      report: "Full report text\nwith multiple lines.",
    });
    const rendered = renderStructuredForHost(payload, "verdict/v1");
    expect(rendered).toBe(
      "Full report text\nwith multiple lines.\n\nverdict: conditional_pass · blockers 0 · findings 1",
    );
  });

  it("falls back to JSON.stringify when the preset is undefined", () => {
    const payload = validPayload();
    expect(renderStructuredForHost(payload, undefined)).toBe(JSON.stringify(payload));
  });

  it("falls back to JSON.stringify when verdict/v1 is named but the payload does not actually validate", () => {
    const malformed = { verdict: "pass" }; // missing required fields
    expect(renderStructuredForHost(malformed, "verdict/v1")).toBe(JSON.stringify(malformed));
  });

  it("never throws on a non-object/null structured value", () => {
    expect(() => renderStructuredForHost(null, "verdict/v1")).not.toThrow();
    expect(() => renderStructuredForHost("plain text", "verdict/v1")).not.toThrow();
    expect(renderStructuredForHost(null, "verdict/v1")).toBe("null");
  });

  it("findings count in the summary line reflects the actual array length, not blockers", () => {
    const payload = validPayload({
      blockers: 1,
      findings: [
        { severity: "blocker", summary: "a" },
        { severity: "minor", summary: "b" },
        { severity: "nit", summary: "c" },
      ],
    });
    expect(renderStructuredForHost(payload, "verdict/v1")).toContain("blockers 1 · findings 3");
  });
});
