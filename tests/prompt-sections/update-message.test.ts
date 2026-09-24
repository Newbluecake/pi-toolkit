import { describe, expect, it } from "vitest";
import { SECTION_UPDATE_CUSTOM_TYPE, renderSectionUpdateMessage } from "../../src/prompt-sections/update-message.js";

describe("section update messages", () => {
  it("renders full, removed and pointer updates with bounded metadata", () => {
    const message = renderSectionUpdateMessage([
      {
        section: "pi_project_memory",
        title: "## Memory (demo)",
        kind: "update",
        content: "## Memory (demo) - 1 file(s)",
      },
      { section: "pi_subagent_types", title: "## Available subagent types (pi-subagent)", kind: "removed" },
      {
        section: "pi_subagent_models",
        title: "## Available models (pi-subagent)",
        kind: "pointer",
        pointerHint: "Use the model list.",
      },
    ]);
    expect(message.customType).toBe(SECTION_UPDATE_CUSTOM_TYPE);
    expect(message.display).toBe(false);
    expect(message.content).toContain('<pi_section_update name="pi_project_memory">');
    expect(message.content).toContain("no longer applies");
    expect(message.content).toContain("further full copies are withheld");
    expect(message.details).toEqual({
      v: 1,
      updates: [
        { section: "pi_project_memory", kind: "update" },
        { section: "pi_subagent_types", kind: "removed" },
        { section: "pi_subagent_models", kind: "pointer" },
      ],
    });
  });
});
