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

  it("absentFromHead: a section the frozen prompt never had is ADDED, and follow-ups refer to the earlier update", () => {
    const title = "## Memory (demo)";
    const added = renderSectionUpdateMessage([
      {
        section: "pi_project_memory",
        title,
        kind: "update",
        content: "## Memory (demo) - 1 file(s)",
        absentFromHead: true,
      },
    ]);
    expect(added.content).toContain(
      "ADDS a section to your system prompt (it was absent when your system prompt was frozen)",
    );
    expect(added.content).not.toContain("REPLACES");
    expect(added.content).toContain('<pi_section_update name="pi_project_memory">');
    expect(added.details).toEqual({ v: 1, updates: [{ section: "pi_project_memory", kind: "update" }] });

    const pointer = renderSectionUpdateMessage([
      { section: "pi_project_memory", title, kind: "pointer", absentFromHead: true },
    ]);
    expect(pointer.content).toContain("introduced by an earlier update, has changed again");
    expect(pointer.content).not.toContain("section of your system prompt headed");

    const removed = renderSectionUpdateMessage([
      { section: "pi_project_memory", title, kind: "removed", absentFromHead: true },
    ]);
    expect(removed.content).toContain(
      "introduced by an earlier update (it is not part of your system prompt), no longer applies",
    );
  });

  it("without absentFromHead the wording is unchanged (REPLACES)", () => {
    const message = renderSectionUpdateMessage([
      { section: "pi_project_memory", title: "## Memory (demo)", kind: "update", content: "x" },
    ]);
    expect(message.content).toContain(
      'The block below REPLACES the section of your system prompt headed by the line beginning with "## Memory (demo)"',
    );
  });
});
