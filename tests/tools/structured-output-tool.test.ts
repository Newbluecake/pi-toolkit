import { describe, expect, it, vi } from "vitest";
// pi aliases `@sinclair/typebox` to its bundled typebox 1.x at runtime; our
// tests otherwise resolve @sinclair/typebox 0.34, whose Type.Unsafe silently
// accepts a string. Import 1.x directly so the regression exercises the same
// Type.Unsafe behavior production does.
import { Type as RuntimeType } from "typebox";
import {
  createStructuredOutputTool,
  type StructuredOutputSubmissionResult,
} from "../../src/tools/structured-output-tool.js";
import { normalizeSchemaInput, validateAgainstSchema } from "../../src/core/json-schema.js";
import { VERDICT_SCHEMA_V1 } from "../../src/core/verdict-schema.js";

const onSubmit = () => ({ ok: true, errors: [] });

describe("tools/structured-output-tool: schema shape guard", () => {
  it("documents the production crash: typebox 1.x Type.Unsafe throws on a string schema", () => {
    expect(() => RuntimeType.Unsafe('{"type":"object"}' as never)).toThrow(/defineProperty called on non-object/);
  });

  it("a normalized JSON-string schema is safe under the runtime typebox", () => {
    const r = normalizeSchemaInput('{"type":"object","properties":{"ok":{"type":"boolean"}}}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => RuntimeType.Unsafe(r.schema)).not.toThrow();
    expect(createStructuredOutputTool({ schema: r.schema, onSubmit }).name).toBe("StructuredOutput");
  });

  it.each([
    ["string", '{"type":"object"}', /got string/],
    ["null", null, /got null/],
    ["array", [], /got array/],
  ])("rejects a %s schema with a readable error", (_label, bad, message) => {
    expect(() => createStructuredOutputTool({ schema: bad as never, onSubmit })).toThrow(message);
  });

  it("rejects an inconsistent verdict/v1 blockers count before invoking submission", async () => {
    let submissions = 0;
    const tool = createStructuredOutputTool({
      schema: { type: "object" },
      schemaPreset: "verdict/v1",
      onSubmit: () => {
        submissions++;
        return { ok: true, errors: [] };
      },
    });
    const result = await tool.execute("tc", {
      verdict: "reject",
      blockers: 2,
      findings: [{ severity: "blocker", summary: "one" }],
      report: "report",
    });
    expect(result.details).toMatchObject({ ok: false });
    expect((result.content[0] as { text: string }).text).toContain("fix the blockers count");
    expect(submissions).toBe(0);
  });
});

const closedWindow = (): StructuredOutputSubmissionResult => ({
  ok: false,
  code: "window_closed",
  errors: ["the result window for this run has closed; this submission was not accepted"],
});
const validVerdict = { verdict: "pass", blockers: 0, findings: [], report: "done" };

describe("tools/structured-output-tool: host-only window preflight", () => {
  it.each([
    ["valid", validVerdict],
    ["semantic-invalid", { ...validVerdict, blockers: 1 }],
    ["schema-invalid (direct execute only)", { report: 42 }],
  ])("returns stable window_closed for a closed window with %s payload", async (_label, payload) => {
    const onSubmit = vi.fn(() => ({ ok: true, errors: [] }));
    const preflight = vi.fn(closedWindow);
    const tool = createStructuredOutputTool({
      schema: VERDICT_SCHEMA_V1,
      schemaPreset: "verdict/v1",
      preflight,
      onSubmit,
    });
    // Direct execute intentionally bypasses SDK argument validation. The SDK
    // may reject a schema-invalid call before our preflight is ever reached.
    const result = await tool.execute("closed", payload);
    expect(result.details).toEqual({ ok: false, code: "window_closed", errors: closedWindow().errors });
    expect(result.content[0]?.text).toContain("Stop submitting StructuredOutput for this run");
    expect(result.content[0]?.text).not.toContain("Fix the payload");
    expect(result.content[0]?.text).not.toContain("call StructuredOutput again");
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    // Type.Unsafe adds TypeBox's symbol metadata; the model-visible JSON
    // schema remains byte-identical, including required/additionalProperties.
    expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(VERDICT_SCHEMA_V1));
  });

  it("does not inspect semantic fields at all after a closed preflight", async () => {
    const readBlockers = vi.fn(() => {
      throw new Error("semantic validation must not run");
    });
    const payload = {
      ...validVerdict,
      get blockers() {
        return readBlockers();
      },
    };
    const tool = createStructuredOutputTool({
      schema: VERDICT_SCHEMA_V1,
      schemaPreset: "verdict/v1",
      preflight: closedWindow,
      onSubmit: vi.fn(),
    });
    const result = await tool.execute("closed", payload);
    expect(result.details).toMatchObject({ ok: false, code: "window_closed" });
    expect(readBlockers).not.toHaveBeenCalled();
  });

  it("preserves onSubmit's authoritative window_closed after preflight passed", async () => {
    const order: string[] = [];
    const tool = createStructuredOutputTool({
      schema: VERDICT_SCHEMA_V1,
      schemaPreset: "verdict/v1",
      preflight: () => {
        order.push("preflight-open");
        return { ok: true, errors: [] };
      },
      onSubmit: () => {
        order.push("submit-closed");
        return closedWindow();
      },
    });
    const result = await tool.execute("race", validVerdict);
    expect(order).toEqual(["preflight-open", "submit-closed"]);
    expect(result.details).toMatchObject({ ok: false, code: "window_closed" });
    expect(result.content[0]?.text).toContain("Stop submitting");
    expect(result.content[0]?.text).not.toContain("Fix the payload");
  });

  it("allows real semantic and schema errors to be corrected and resubmitted while open", async () => {
    let captured: unknown;
    const onSubmit = vi.fn((payload: unknown) => {
      const result = validateAgainstSchema(VERDICT_SCHEMA_V1, payload);
      if (result.ok) captured = payload;
      return result;
    });
    const tool = createStructuredOutputTool({
      schema: VERDICT_SCHEMA_V1,
      schemaPreset: "verdict/v1",
      preflight: () => ({ ok: true, errors: [] }),
      onSubmit,
    });
    const semanticBad = await tool.execute("semantic-bad", { ...validVerdict, blockers: 1 });
    expect(semanticBad.details).toMatchObject({ ok: false });
    expect(semanticBad.content[0]?.text).toContain("fix the blockers count");
    expect(semanticBad.content[0]?.text).toContain("Fix the payload and call StructuredOutput again");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();

    const schemaBad = await tool.execute("schema-bad", { ...validVerdict, report: 42 });
    expect(schemaBad.details).toMatchObject({ ok: false });
    expect(schemaBad.content[0]?.text).toContain('expected type "string"');
    expect(schemaBad.content[0]?.text).toContain("Fix the payload and call StructuredOutput again");
    expect(captured).toBeUndefined();

    const accepted = await tool.execute("fixed", validVerdict);
    expect(accepted.details).toEqual({ ok: true });
    expect(captured).toEqual(validVerdict);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
