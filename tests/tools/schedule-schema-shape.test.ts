import { describe, expect, it } from "vitest";
import {
  inspectScheduleSchemaShape,
  SCHEDULE_SCHEMA_FIELDS,
  SCHEDULE_SCHEMA_LIMITS,
  type DiagnosticResult,
} from "../../src/tools/schedule-schema-shape.js";

function observe(schema: unknown = { type: "object", properties: {} }, extras: object = {}) {
  return { schema, ...extras };
}
function project(observations: unknown[], compare?: [number, number]) {
  return inspectScheduleSchemaShape({ observations, ...(compare ? { compare } : {}) });
}
function success(result: DiagnosticResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected synthetic success");
  return result;
}
function field(schema: unknown) {
  return success(project([observe({ type: "object", properties: { prompt: schema } })])).observations[0]!.fields.find(
    (f) => f.field === "prompt",
  )!;
}
function comparison(a: object, b: object) {
  return success(project([a, b], [0, 1])).comparison;
}

describe("#83 pure offline schema shape", () => {
  it("projects only fixed schedule field names and declared metadata enums", () => {
    const result = success(
      project([
        observe(
          {
            type: "object",
            properties: { action: { type: "string" }, strange: { type: "string" } },
            required: ["action", "strange"],
          },
          {
            source: "transport",
            sourceEvidence: "transport-attested",
            api: "openai-responses",
            apiEvidence: "selected",
          },
        ),
      ]),
    );
    expect(result.evidence).toBe("declarations-only");
    expect(result.scope).toBe("shape-only-not-a-fix");
    const shape = result.observations[0]!;
    expect(shape.fields.map((f) => f.field)).toEqual(SCHEDULE_SCHEMA_FIELDS);
    expect(shape.fields[0]).toEqual({
      field: "action",
      presence: "present",
      required: "yes",
      type: ["string"],
      nullability: "no",
    });
    expect(shape).toMatchObject({
      source: "transport",
      sourceEvidence: "transport-attested",
      api: "openai-responses",
      apiEvidence: "selected",
      unrecognizedProperties: 1,
      unrecognizedRequired: 1,
      complete: false,
    });
    expect(JSON.stringify(result)).not.toContain("strange");
  });

  it.each([
    [{}, "absent"],
    [{ strict: true }, "true"],
    [{ strict: false }, "false"],
    [{ strict: null }, "explicit-null"],
    [{ strict: "true" }, "unknown"],
    [{ strict: 1 }, "unknown"],
  ])("strict preserves five states: %j", (extra, expected) => {
    expect(success(project([observe(undefined, extra as object)])).observations[0]!.strict).toBe(expected);
  });

  it("distinguishes missing, explicit null, false, and inherited values", () => {
    expect(comparison(observe(), observe(undefined, { strict: null }))).toBe("different");
    expect(comparison(observe(undefined, { strict: false }), observe(undefined, { strict: null }))).toBe("different");
    expect(comparison({}, { schema: null })).toBe("different");
    const inherited = Object.create({
      strict: true,
      schema: { type: "object", properties: { prompt: { type: "string" } } },
    }) as object;
    const shape = success(project([inherited])).observations[0]!;
    expect(shape.strict).toBe("absent");
    expect(shape.schemaPresence).toBe("missing");
    expect(field(null)).toMatchObject({ presence: "present", type: "unknown", nullability: "unknown" });
    expect(success(project([observe()])).observations[0]!.fields.find((f) => f.field === "prompt")!.presence).toBe(
      "missing",
    );
  });

  it.each([
    [{ type: "string" }, "no"],
    [{ type: "null" }, "yes"],
    [{ type: ["string", "null"] }, "yes"],
    [{}, "yes"],
    [true, "yes"],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, "yes"],
    [{ anyOf: [{ type: "string" }, {}] }, "yes"],
    [{ anyOf: [{ type: "string" }, true] }, "yes"],
    [{ anyOf: [{ type: "string" }, { type: "integer" }] }, "no"],
    [{ anyOf: [{ type: "string" }, { $ref: "hidden" }] }, "unknown"],
    [{ anyOf: [{ type: "null", enum: ["hidden"] }, { type: "string" }] }, "unknown"],
    [{ anyOf: [{ type: "null" }, { $ref: "hidden" }] }, "yes"],
    [{ oneOf: [{ type: "null" }, { type: ["string", "null"] }] }, "unknown"],
    [{ allOf: [{ type: "null" }] }, "unknown"],
    [{ type: ["string", "null"], const: "hidden" }, "unknown"],
    [{ type: "null", anyOf: [{}] }, "unknown"],
    [{ type: "null", not: {} }, "unknown"],
    [{ type: "invalid" }, "unknown"],
    [{ type: ["null", "null"] }, "unknown"],
    [{ anyOf: [] }, "unknown"],
    [{ anyOf: [{ type: "null" }], enum: ["hidden"] }, "unknown"],
    [{ $ref: "hidden", type: "null" }, "unknown"],
    [false, "unknown"],
  ])("conservative nullability %j => %s", (schema, expected) => {
    expect(field(schema).nullability).toBe(expected);
    if (schema && typeof schema === "object" && "anyOf" in schema) expect(field(schema).type).toBe("unknown");
  });

  it("never equates unknowns; known differences outrank unknowns", () => {
    const unknown = observe({ type: "object", properties: { prompt: { $ref: "hidden" } } });
    expect(comparison(unknown, unknown)).toBe("inconclusive");
    expect(comparison({}, {})).toBe("inconclusive");
    expect(comparison({ ...unknown, strict: false }, { ...unknown, strict: true })).toBe("different");
    const known = observe({ type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] });
    expect(comparison(known, known)).toBe("equivalent");
    expect(
      comparison(
        known,
        observe({ type: "object", properties: { prompt: { type: ["string", "null"] } }, required: ["prompt"] }),
      ),
    ).toBe("different");
    expect(
      comparison(known, observe({ type: "object", properties: { prompt: { type: "string" } }, required: [] })),
    ).toBe("different");
    expect(
      comparison(known, {
        ...known,
        source: "transport",
        api: "openai-responses",
        sourceEvidence: "transport-attested",
      }),
    ).toBe("equivalent");
    expect(
      comparison(
        observe({ type: "object", properties: {}, allOf: [{}] }),
        observe({ type: "object", properties: {}, allOf: [{}] }),
      ),
    ).toBe("inconclusive");
    expect(comparison({ ...known, mystery: "hidden" }, { ...known, mystery: "hidden" })).toBe("inconclusive");
    expect(
      comparison(
        observe({ type: "object", properties: { unknownA: { type: "string" } } }),
        observe({ type: "object", properties: { unknownB: { type: "string" } } }),
      ),
    ).toBe("inconclusive");
  });

  it("keeps required undeclared fixed fields inconclusive for every additionalProperties pair", () => {
    const variants = [{}, { additionalProperties: true }, { additionalProperties: false }].map((extra) =>
      observe({ type: "object", properties: { action: { type: "string" } }, required: ["action", "prompt"], ...extra }),
    );
    for (const left of variants) {
      for (const right of variants) {
        const result = success(project([left, right], [0, 1]));
        expect(result.comparison).toBe("inconclusive");
        for (const shape of result.observations) {
          expect(shape.complete).toBe(false);
          expect(shape.fields.find((f) => f.field === "prompt")).toMatchObject({
            presence: "missing",
            required: "yes",
            type: "unknown",
            nullability: "unknown",
          });
        }
      }
    }
  });

  it("does not mutate frozen caller data", () => {
    const schema = Object.freeze({
      type: "object",
      properties: Object.freeze({ prompt: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["prompt"]),
    });
    const input = Object.freeze({ observations: Object.freeze([Object.freeze({ schema })]) });
    const before = JSON.stringify(input);
    expect(inspectScheduleSchemaShape(input).ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("never invokes getters or toJSON, including forbidden and inherited fields", () => {
    let calls = 0;
    const getter = Object.defineProperty(observe(), "description", {
      get() {
        calls++;
        throw new Error("SECRET");
      },
    });
    expect(project([getter])).toEqual({ ok: false, error: "E_INPUT_DATA" });
    const toJSON = {
      ...observe(),
      toJSON() {
        calls++;
        throw new Error("SECRET");
      },
    };
    expect(project([toJSON])).toEqual({ ok: false, error: "E_INPUT_DATA" });
    const inherited = Object.create({
      get strict() {
        calls++;
        return true;
      },
      toJSON() {
        calls++;
        return "SECRET";
      },
    }) as object;
    expect(project([inherited]).ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("withholds secret sentinels from every forbidden field and all malformed paths", () => {
    const secret = "SENTINEL_TINY_SECRET_凭据_\u001b";
    const forbidden = [
      "description",
      "prompt",
      "enum",
      "const",
      "headers",
      "url",
      "path",
      "credential",
      "apiKey",
      "$ref",
      "model",
      "session",
      "traffic",
      "ledger",
    ];
    for (const key of forbidden) {
      const schema = {
        type: "object",
        properties: {
          prompt: { type: "string", [key]: key === "enum" ? [secret] : secret },
          [secret]: { const: secret },
        },
        required: [secret],
        [key]: secret,
      };
      const result = project([
        observe(schema, {
          source: secret,
          api: secret,
          sourceEvidence: secret,
          apiEvidence: secret,
          strict: secret,
          [key]: secret,
        }),
      ]);
      expect(result.ok).toBe(true);
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("SENTINEL");
      expect(text).not.toContain("凭据");
      expect(text).not.toContain("\\u001b");
    }
    for (const input of [
      null,
      secret,
      { observations: [secret] },
      { observations: [observe()], compare: [secret, 1] },
    ]) {
      expect(inspectScheduleSchemaShape(input)).toEqual({ ok: false, error: "E_INPUT_SHAPE" });
    }
  });

  it.each([-1, 0, 1])("canonical UTF8 input budget %+d", (delta) => {
    const input = { observations: [observe()], padding: "凭" };
    const base = Buffer.byteLength(JSON.stringify(input));
    input.padding += "x".repeat(SCHEDULE_SCHEMA_LIMITS.inputBytes + delta - base);
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(SCHEDULE_SCHEMA_LIMITS.inputBytes + delta);
    expect(inspectScheduleSchemaShape(input).ok).toBe(delta <= 0);
    if (delta > 0) expect(inspectScheduleSchemaShape(input)).toEqual({ ok: false, error: "E_INPUT_BYTES" });
  });

  it.each([-1, 0, 1])("node budget %+d (containers and leaves)", (delta) => {
    // root, observations array, observation, schema, type, properties, padding array = 7.
    const input = {
      observations: [observe()],
      padding: Array<null>(SCHEDULE_SCHEMA_LIMITS.nodes + delta - 7).fill(null),
    };
    expect(inspectScheduleSchemaShape(input).ok).toBe(delta <= 0);
    if (delta > 0) expect(inspectScheduleSchemaShape(input)).toEqual({ ok: false, error: "E_NODES" });
  });

  it.each([-1, 0, 1])("depth budget %+d (root at zero)", (delta) => {
    let padding: unknown = null;
    for (let i = 1; i < SCHEDULE_SCHEMA_LIMITS.depth + delta; i++) padding = { nested: padding };
    const result = inspectScheduleSchemaShape({ observations: [observe()], padding });
    expect(result.ok).toBe(delta <= 0);
    if (delta > 0) expect(result).toEqual({ ok: false, error: "E_DEPTH" });
  });

  it.each([-1, 0, 1])("output UTF8 budget %+d including final newline", (delta) => {
    const types = ["null", "boolean", "object", "array", "number", "integer", "string"];
    let position = 0;
    const observations = Array.from({ length: 16 }, () =>
      observe({
        type: "object",
        properties: Object.fromEntries(
          SCHEDULE_SCHEMA_FIELDS.flatMap<[string, { type: string | string[] }]>((name) => {
            const index = position++;
            if (index < 87) return [[name, { type: types }]];
            if (index === 87) return [[name, { type: delta === 1 ? "string" : "null" }]];
            if (index === 88) return [[name, { type: delta === -1 ? "null" : "string" }]];
            return [];
          }),
        ),
      }),
    );
    // Build the expected complete projection from independent single-observation results;
    // this proves the exact encoded boundary even when the aggregate must fail closed.
    const singles = observations.map((o) => success(project([o])).observations[0]!);
    const expected = { ...success(project([observe()])), observations: singles };
    expect(Buffer.byteLength(JSON.stringify(expected) + "\n")).toBe(SCHEDULE_SCHEMA_LIMITS.outputBytes + delta);
    const result = project(observations);
    if (delta <= 0) expect(result).toEqual(expected);
    else expect(result).toEqual({ ok: false, error: "E_OUTPUT_BYTES" });
  });

  it("rejects cycles, functions, sparse arrays and invalid numbers without exceptions or partial output", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [cycle, () => 0, [, ,], NaN, Infinity, undefined, 1n]) {
      expect(inspectScheduleSchemaShape({ observations: [observe()], extra: value })).toEqual({
        ok: false,
        error: "E_INPUT_DATA",
      });
    }
    const huge = project(
      Array.from({ length: 40 }, () => observe()),
      [0, 1],
    );
    expect(huge).toEqual({ ok: false, error: "E_OUTPUT_BYTES" });
    expect(JSON.stringify(huge)).not.toContain("equivalent");
  });
});
