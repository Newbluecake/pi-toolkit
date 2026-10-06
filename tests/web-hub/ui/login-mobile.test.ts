// @vitest-environment happy-dom
/**
 * Mobile login redesign source guard (field report: "登录页面还是很丑，就不能让登录框扩充到
 * 整个页面吗，在移动端上"). happy-dom cannot evaluate media queries, so this pins the
 * `login.css` mobile block structurally — the same approach as `stop-button.test.ts`:
 *
 *  - ≤640px: the card fills the whole viewport (no floating box: no border/radius/shadow,
 *    width 100%, min-height 100dvh, safe-area-aware padding), foot pinned to the bottom,
 *    TokenGate's short content vertically centered via `.login-card--center`.
 *  - Desktop keeps the raised-card chrome (the old 481px padding bump is now 641px so the
 *    481–640px band gets the full-page treatment instead).
 *  - ≥44px touch targets stay pinned: inputs, password toggle, submit button.
 */
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import TokenGate from "../../../src/web-hub/ui/src/components/shell/TokenGate.vue";

const css = readFileSync(
  resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/login.css"),
  "utf8",
);

/** Extract a `@media <query>` block's full text (balanced braces), starting the search at `from`. */
function mediaBlock(query: string, from = 0): string {
  const start = css.indexOf(`@media ${query}`, from);
  expect(start, `media block ${query} must exist`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in media block ${query}`);
}

/** Extract one selector rule's body inside `scope` (e.g. a media block). */
function rule(scope: string, selector: string): string {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(scope);
  expect(m, `${selector} rule must exist`).toBeTruthy();
  return m![1]!;
}

describe("login.css mobile full-viewport treatment (≤640px)", () => {
  const mobile = mediaBlock("(max-width: 640px)");

  it("the page stops centering a floating box and drops its padding", () => {
    const page = rule(mobile, ".login-page");
    expect(page).toContain("place-items: stretch");
    expect(page).toMatch(/padding:\s*0/);
  });

  it("the card fills the viewport: 100% wide, 100dvh tall, chromeless", () => {
    const card = rule(mobile, ".login-card");
    expect(card).toMatch(/width:\s*100%/);
    expect(card).toMatch(/min-height:\s*100dvh/);
    expect(card).toMatch(/border:\s*0/);
    expect(card).toMatch(/border-radius:\s*0/);
    expect(card).toMatch(/box-shadow:\s*none/);
  });

  it("the card padding respects safe-area insets on all four sides", () => {
    const card = rule(mobile, ".login-card");
    expect(card).toContain("env(safe-area-inset-top)");
    expect(card).toContain("env(safe-area-inset-right)");
    expect(card).toContain("env(safe-area-inset-bottom)");
    expect(card).toContain("env(safe-area-inset-left)");
  });

  it("vertical rhythm: flex column, brand headroom clamped, foot pinned to the bottom", () => {
    const card = rule(mobile, ".login-card");
    expect(card).toContain("flex-direction: column");
    expect(rule(mobile, ".login-brand")).toContain("clamp(");
    expect(rule(mobile, ".login-foot")).toContain("margin-top: auto");
  });

  it("no fixed heights that would overflow when the keyboard opens", () => {
    // min-height is allowed (the page scrolls); a bare `height:` on page/card is not.
    const card = rule(mobile, ".login-card");
    expect(card).not.toMatch(/(?<!min-)height:/);
    expect(rule(mobile, ".login-page")).not.toMatch(/(?<!min-)height:/);
  });

  it("TokenGate's center modifier vertically centers the short gate content", () => {
    expect(rule(mobile, ".login-card--center")).toContain("justify-content: center");
  });
});

describe("login.css desktop card preserved", () => {
  it("the raised-card padding bump moved to ≥641px (same values as the old 481px block)", () => {
    const desktop = mediaBlock("(min-width: 641px)");
    const card = rule(desktop, ".login-card");
    expect(card).toContain("var(--sp-8) var(--sp-8) var(--sp-6)");
  });

  it("the base card keeps its floating-box chrome (border, radius, shadow, 400px cap)", () => {
    const card = rule(css, ".login-card");
    expect(card).toContain("min(400px");
    expect(card).toContain("1px solid var(--c-border)");
    expect(card).toContain("var(--r-lg)");
    expect(card).toContain("var(--shadow-3)");
  });
});

describe("login.css touch targets (all viewports)", () => {
  it("inputs, the password toggle and the submit button are ≥44px", () => {
    expect(rule(css, ".field .input")).toMatch(/min-height:\s*44px/);
    const toggle = rule(css, ".input-wrap .btn-icon");
    expect(toggle).toMatch(/width:\s*44px/);
    expect(toggle).toMatch(/height:\s*44px/);
    // submit: `.btn-lg` in primitives.css
    const primitives = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/primitives.css"),
      "utf8",
    );
    expect(rule(primitives, ".btn-lg")).toMatch(/min-height:\s*44px/);
  });
});

describe("TokenGate.vue shares the full-page card treatment", () => {
  it("both gate variants use login-card--center on the shared login-card", () => {
    const invalid = mount(TokenGate, { props: { reason: "token-invalid" } });
    expect(invalid.find(".login-card.login-card--center").exists()).toBe(true);
    const unknown = mount(TokenGate, { props: { reason: "auth-mode-unknown" } });
    expect(unknown.find(".login-card.login-card--center").exists()).toBe(true);
  });
});
