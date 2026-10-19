// `/resume-recent` argument completions: single-token `--all` — the value must reproduce
// the full editor text under pi-tui applyCompletion's replace-the-whole-prefix semantics
// (regression guard for the `/webhub feishu setup` → `/webhub setup` bug class).

import { describe, expect, test, vi } from "vitest";
import { wireSessionNav } from "../../src/session-nav/index.js";

describe("/resume-recent getArgumentCompletions", () => {
  test("offers --all as the full argument text", () => {
    const commands = new Map<string, { getArgumentCompletions?: (prefix: string) => unknown }>();
    const pi = {
      registerCommand: (name: string, spec: { getArgumentCompletions?: (prefix: string) => unknown }) =>
        commands.set(name, spec),
      on: vi.fn(),
    };
    wireSessionNav(pi as never);
    const completions = commands.get("resume-recent")!.getArgumentCompletions!;
    expect(completions("")).toEqual([{ value: "--all", label: "--all", description: expect.any(String) }]);
    expect(completions("--bogus")).toBeNull();
    // applyCompletion: newArgs = value → `/resume-recent --all` byte-for-byte.
    const [all] = completions("--a") as Array<{ value: string }>;
    expect(`/resume-recent ${all.value}`).toBe("/resume-recent --all");
  });
});
