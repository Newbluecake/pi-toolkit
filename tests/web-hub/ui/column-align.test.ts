import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 2026-10-09 「边缘两侧没有对齐」: the control dock's children must share the transcript
 * column's geometry — the same side gutter token (`--col-gutter`, sp-3 on phones, sp-6 from
 * 481px) and the same centre line (the transcript reserves a stable scrollbar gutter, the dock
 * mirrors it with `padding-right: var(--sb-w)`, measured in main.ts).
 */
const read = (f: string): string =>
  readFileSync(resolve(fileURLToPath(import.meta.url), `../../../../src/web-hub/ui/src/${f}`), "utf8");
const rule = (css: string, selector: string): string => {
  const m = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
  return m?.[0] ?? "";
};

describe("transcript ↔ control dock column alignment", () => {
  const tokens = read("styles/tokens.css");
  const transcript = read("styles/transcript.css");
  const control = read("styles/control.css");

  it("one gutter token drives both columns (phones sp-3, tablet+ sp-6)", () => {
    expect(tokens).toMatch(/--col-gutter:\s*var\(--sp-3\)/);
    expect(tokens).toMatch(/@media \(min-width: 481px\)\s*\{\s*:root\s*\{\s*--col-gutter:\s*var\(--sp-6\)/);
    expect(rule(transcript, ".tx-inner")).toMatch(/padding:\s*var\(--sp-3\) var\(--col-gutter\)/);
    expect(transcript).toMatch(/padding:\s*var\(--sp-4\) var\(--col-gutter\) var\(--sp-8\)/);
    const child = rule(control, ".dock.dock-ctl > *");
    expect(child).toMatch(/padding-left:\s*max\(var\(--col-gutter\)/);
    expect(child).toMatch(/padding-right:\s*max\(var\(--col-gutter\)/);
  });

  it("same centre line: stable scrollbar gutter on the transcript, mirrored by the dock", () => {
    expect(rule(transcript, ".transcript")).toMatch(/scrollbar-gutter:\s*stable/);
    expect(rule(control, ".dock-ctl")).toMatch(/padding-right:\s*var\(--sb-w, 0px\)/);
    expect(read("main.ts")).toMatch(/setProperty\("--sb-w"/);
  });
});
