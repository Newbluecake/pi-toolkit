import { describe, expect, it } from "vitest";
import { SCHEMA_INLINE_MAX_BYTES, renderFirstMessage } from "../../src/external-agent/prompt.js";
import type { ExternalContextBlock, JsonSchema } from "../../src/core/types.js";

const blocks = (...b: ExternalContextBlock[]): readonly ExternalContextBlock[] => b;

describe("renderFirstMessage (external-agent plan §2.12/§4.8)", () => {
  it("resume path: everything absent ⇒ text verbatim", () => {
    expect(renderFirstMessage({ contextBlocks: [], text: "do the thing" })).toBe("do the thing");
    expect(
      renderFirstMessage({
        contextBlocks: [],
        text: "do the thing",
        ...({ toolNameHint: undefined } as unknown as { toolNameHint?: string }),
      }),
    ).toBe("do the thing");
  });

  it("agent-role block wraps rolePrompt and the tool name mapping", () => {
    const out = renderFirstMessage({
      rolePrompt: "You are a verifier.",
      contextBlocks: [],
      text: "task",
      toolNameHint: "pi read/bash/edit ≈ droid Read/Execute/Edit",
    });
    expect(out).toBe(
      "<agent-role>\nYou are a verifier.\n\nTool name mapping: pi read/bash/edit ≈ droid Read/Execute/Edit\n</agent-role>\n\ntask",
    );
  });

  it("toolNameHint alone still renders the agent-role block; rolePrompt alone works too", () => {
    const hintOnly = renderFirstMessage({ contextBlocks: [], text: "t", toolNameHint: "hint" });
    expect(hintOnly).toContain("<agent-role>\nTool name mapping: hint\n</agent-role>");
    const roleOnly = renderFirstMessage({ rolePrompt: "R", contextBlocks: [], text: "t" });
    expect(roleOnly).toBe("<agent-role>\nR\n</agent-role>\n\nt");
  });

  it("memory blocks are wrapped in <project-memory>; capabilities blocks pass through verbatim", () => {
    const out = renderFirstMessage({
      contextBlocks: blocks(
        { kind: "memory", text: "## Memory\n- core.md" },
        { kind: "capabilities", text: "You are running as an external agent." },
      ),
      text: "task",
    });
    expect(out).toBe(
      "<project-memory>\n## Memory\n- core.md\n</project-memory>\n\nYou are running as an external agent.\n\ntask",
    );
  });

  it("full order: agent-role → blocks → schema instruction → text", () => {
    const out = renderFirstMessage({
      rolePrompt: "ROLE",
      contextBlocks: blocks({ kind: "capabilities", text: "CAPS" }),
      schema: { type: "object" },
      text: "TEXT",
      toolNameHint: "MAP",
    });
    // order via index positions (the agent-role block itself contains a blank
    // line between ROLE and the mapping, so a plain split is not meaningful)
    const role = out.indexOf("<agent-role>");
    const caps = out.indexOf("CAPS");
    const schema = out.indexOf("```json");
    const text = out.indexOf("TEXT");
    expect(role).toBeGreaterThanOrEqual(0);
    expect(role).toBeLessThan(caps);
    expect(caps).toBeLessThan(schema);
    expect(schema).toBeLessThan(text);
    expect(out).toContain("<agent-role>\nROLE\n\nTool name mapping: MAP\n</agent-role>");
  });

  it("schema alone (no role/blocks) still emits the instruction", () => {
    const out = renderFirstMessage({ contextBlocks: [], schema: { type: "object" }, text: "t" });
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("```json");
    expect(parts[1]).toBe("t");
  });

  it("inlines the schema body as compact JSON in the instruction (droid has no StructuredOutput tool)", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["verdict", "blockers", "report"],
      properties: { verdict: { type: "string", enum: ["pass", "reject"] } },
    };
    const out = renderFirstMessage({ contextBlocks: [], schema, text: "t" });
    expect(out).toBe(
      "End your final answer with a single ```json fenced block containing your structured result as JSON " +
        `matching this JSON Schema: ${JSON.stringify(schema)}; nothing may follow the block.\n\nt`,
    );
  });

  it("inlines a schema whose serialized size is exactly the byte limit (boundary is inclusive)", () => {
    const wrapper = JSON.stringify({ type: "object", description: "" }).length;
    const fill = SCHEMA_INLINE_MAX_BYTES - wrapper;
    expect(fill).toBeGreaterThan(0);
    const schema: JsonSchema = { type: "object", description: "x".repeat(fill) };
    const out = renderFirstMessage({ contextBlocks: [], schema, text: "t" });
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8")).toBe(SCHEMA_INLINE_MAX_BYTES);
    expect(out).toContain(`matching this JSON Schema: ${JSON.stringify(schema)};`);
  });

  it("oversized schema degrades to an omission note (never throws, no truncated JSON)", () => {
    const schema: JsonSchema = { type: "object", description: "x".repeat(SCHEMA_INLINE_MAX_BYTES) };
    const serialized = JSON.stringify(schema);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(SCHEMA_INLINE_MAX_BYTES);
    const out = renderFirstMessage({ contextBlocks: [], schema, text: "t" });
    expect(out).toBe(
      "End your final answer with a single ```json fenced block containing your structured result as JSON; " +
        "nothing may follow the block. " +
        `(The JSON Schema for the structured result was omitted because its serialized form is ` +
        `${Buffer.byteLength(serialized, "utf8")} bytes, over the ${SCHEMA_INLINE_MAX_BYTES}-byte inline limit.)\n\nt`,
    );
    expect(out).not.toContain("matching this JSON Schema:");
    expect(out.length).toBeLessThan(1000);
  });

  it("unserializable schema (circular) degrades to an omission note instead of throwing", () => {
    const schema = { type: "object" } as { [k: string]: unknown };
    schema.self = schema;
    const out = renderFirstMessage({ contextBlocks: [], schema, text: "t" });
    expect(out).toBe(
      "End your final answer with a single ```json fenced block containing your structured result as JSON; " +
        "nothing may follow the block. " +
        "(The JSON Schema for the structured result was omitted because it could not be serialized.)\n\nt",
    );
  });

  it("empty/whitespace blocks are skipped without leaving blank segments", () => {
    const out = renderFirstMessage({
      contextBlocks: blocks({ kind: "memory", text: "   " }, { kind: "capabilities", text: "" }),
      text: "t",
    });
    expect(out).toBe("t");
  });
});
