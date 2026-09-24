import { describe, expect, it } from "vitest";
// pi aliases `@sinclair/typebox` to its bundled typebox 1.x at runtime; our
// tests otherwise resolve @sinclair/typebox 0.34, whose Type.Unsafe silently
// accepts a string. Import 1.x directly so the regression exercises the same
// Type.Unsafe behavior production does.
import { Type as RuntimeType } from "typebox";
import { createStructuredOutputTool } from "../../src/tools/structured-output-tool.js";
import { normalizeSchemaInput } from "../../src/core/json-schema.js";

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
});
