import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = "src/web-hub/ui/src/styles/";
const agents = readFileSync(`${dir}agents.css`, "utf8");
const preview = readFileSync(`${dir}preview.css`, "utf8");
const rule = (css: string, sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.()>:*]/g, "\\$&")} \\{([^}]*)\\}`));
  expect(m, sel).not.toBeNull();
  return m![1]!;
};

describe("layout CSS invariants (no real layout engine in vitest; real render checked in Chromium)", () => {
  it("agent-row1 is a 3-column grid; wrapping lives only in .agent-main; cost column never wraps", () => {
    const row = rule(agents, ".agent-row1");
    expect(row).toContain("display: grid");
    expect(row).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    expect(row).not.toContain("flex-wrap");
    expect(rule(agents, ".agent-main")).toContain("flex-wrap: wrap");
    expect(rule(agents, ".agent-end")).toContain("white-space: nowrap");
    expect(rule(agents, ".agent-cost")).not.toContain("margin-left");
  });
  it("dir footnote pins to the bottom-left of a flex-column body", () => {
    expect(rule(preview, ".preview-dir-footnote")).toMatch(/margin:\s*auto 0 0/);
    expect(rule(preview, ".preview-body:has(> .preview-dir)")).toContain("flex-direction: column");
    expect(rule(preview, ".preview-dir")).toContain("flex: 1 0 auto");
  });
});
