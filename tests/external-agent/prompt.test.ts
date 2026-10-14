import { describe, expect, it } from "vitest";
import { renderFirstMessage } from "../../src/external-agent/prompt.js";
import type { ExternalContextBlock } from "../../src/core/types.js";

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

  it("empty/whitespace blocks are skipped without leaving blank segments", () => {
    const out = renderFirstMessage({
      contextBlocks: blocks({ kind: "memory", text: "   " }, { kind: "capabilities", text: "" }),
      text: "t",
    });
    expect(out).toBe("t");
  });
});
