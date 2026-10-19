// `/goal` argument completions: single-token surface (status|pause|resume|clear) — values
// must reproduce the full editor text under pi-tui applyCompletion's replace-the-whole-prefix
// semantics (regression guard for the `/webhub feishu setup` → `/webhub setup` bug class).

import { describe, expect, it } from "vitest";
import { createGoalCommand } from "../../src/goal/command.js";

describe("/goal getArgumentCompletions", () => {
  it("offers single-token subcommands whose values are the full argument text", () => {
    const cmd = createGoalCommand({ goal: () => undefined, persist: () => undefined });
    expect(cmd.getArgumentCompletions!("")!.map((i) => i.value)).toEqual(["status", "pause", "resume", "clear"]);
    const [pause] = cmd.getArgumentCompletions!("pa")!;
    expect(pause).toEqual({ value: "pause", label: "pause", description: expect.any(String) });
    // applyCompletion: newArgs = value → `/goal pause` byte-for-byte.
    expect(`/goal ${pause!.value}`).toBe("/goal pause");
  });
});
