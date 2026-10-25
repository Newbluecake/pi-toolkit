// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MarkdownView from "../../../src/web-hub/ui/src/components/transcript/MarkdownView.vue";

/**
 * 2026-10-24 bug: in a fenced code block the FIRST line sat ~5px (≈1 char) to the right of
 * every later line. Root cause was CSS, not text: the inline-chip rule `.md code` in
 * transcript.css also matched the fence's `.md .codeblock pre > code`, and an inline
 * element's left padding paints once — at the start of its first line box only (verified in
 * headless Chromium: first-char x of line 1 = 13px vs 8px for lines 2/3, delta 5px; the fix
 * brings the delta to 0). The same rule's `font-size: 0.9em` also shrank the whole block.
 *
 * Two pins, since vitest has no layout engine (the real render was checked in Chromium):
 *  1. CSS invariant — the `.md .codeblock pre code` neutralizer must keep padding/background/
 *     border-radius cleared and font-size inherited, and the inline-chip rule must survive
 *     (the fix scopes the fence, it does not delete inline-code styling).
 *  2. DOM invariant — the rendered fence really IS a `.md .codeblock pre > code` (so the CSS
 *     selector above actually covers it) and its textContent is byte-identical to the source:
 *     no leading whitespace text node, first line not indented in the text layer.
 */

const css = readFileSync("src/web-hub/ui/src/styles/transcript.css", "utf8");
const rule = (sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.()>:*\[\]"=]/g, "\\$&")} \\{([^}]*)\\}`));
  expect(m, sel).not.toBeNull();
  return m![1]!;
};

const CODE =
  "pi-secure export conv ~/conv.tar\npi-secure import ~/conv.tar conv2 --verify-password\npi-secure run conv2";

describe("codeblock first-line indent regression (2026-10-24)", () => {
  it("CSS: .md .codeblock pre code neutralizes the .md code inline chip inside fences", () => {
    const fix = rule(".md .codeblock pre code");
    expect(fix).toContain("padding: 0");
    expect(fix).toContain("background: none");
    expect(fix).toContain("border-radius: 0");
    expect(fix).toContain("font-size: inherit");
    // the inline-code chip itself is untouched
    const inline = rule(".md code");
    expect(inline).toContain("padding: 1px 5px");
    expect(inline).toContain("font-size: 0.9em");
    // ordering matters: the neutralizer must come AFTER `.md code` so it wins at equal
    // importance without depending on specificity alone
    expect(css.indexOf(".md .codeblock pre code")).toBeGreaterThan(css.indexOf(".md code {"));
  });

  it("DOM: the fence renders as .md .codeblock pre > code with byte-identical, unindented text", () => {
    const wrapper = mount(MarkdownView, { props: { text: "```sh\n" + CODE + "\n```" } });
    const pre = wrapper.find(".md .codeblock pre");
    expect(pre.exists(), "fence must render inside the .md markdown root").toBe(true);
    const code = pre.find("code");
    expect(code.exists()).toBe(true);
    // text layer carries no indent at all: byte-identical to the fence source
    expect(pre.element.textContent).toBe(CODE);
    // … and no whitespace-only text node sneaks in before the first content node
    const first = code.element.firstChild;
    expect(first, "code must start with content, not a whitespace text node").not.toBeNull();
    if (first && first.nodeType === 3) {
      expect(
        (first as Text).data.startsWith("pi-secure"),
        `leading text ${JSON.stringify((first as Text).data.slice(0, 12))}`,
      ).toBe(true);
    }
    // every line starts flush: no line begins with whitespace
    for (const line of pre.element.textContent!.split("\n")) {
      expect(/^\s/.test(line), `line starts with whitespace: ${JSON.stringify(line)}`).toBe(false);
    }
  });
});
