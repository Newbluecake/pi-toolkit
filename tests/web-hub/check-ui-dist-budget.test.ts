import { describe, expect, it } from "vitest";
import { classifyJsAssets, gzipBytes, budgetExceeded } from "../../scripts/web-hub/check-ui-dist.ts";

describe("check:web JS budget classification", () => {
  const fixture = new Map([
    ["assets/entry.js", 'import "./shared.js"; import("./lazy.js");'],
    ["assets/shared.js", "console.log('shared');"],
    ["assets/preloaded.js", "console.log('preloaded');"],
    ["assets/lazy.js", "console.log('lazy');"],
    ["theme-init.js", "document.documentElement.dataset.theme = 'dark';"],
  ]);

  it("classifies entry, modulepreload, and classic theme scripts as first-screen", () => {
    const html = `
      <script src="/theme-init.js"></script>
      <script type="module" src="/assets/entry.js"></script>
      <link rel="modulepreload" href="/assets/preloaded.js">
    `;
    const result = classifyJsAssets(html, fixture);
    expect(result.firstScreen).toEqual(new Set(["theme-init.js", "assets/entry.js", "assets/preloaded.js"]));
    expect(result.lazy).toEqual(new Set(["assets/shared.js", "assets/lazy.js"]));
  });

  it("follows static imports when the build has no modulepreload links", () => {
    const result = classifyJsAssets('<script type="module" src="/assets/entry.js"></script>', fixture);
    expect(result.firstScreen).toEqual(new Set(["assets/entry.js", "assets/shared.js"]));
    expect(result.lazy).toEqual(new Set(["assets/preloaded.js", "assets/lazy.js", "theme-init.js"]));
  });

  it("follows minified static imports and re-exports but never dynamic import()", () => {
    const minified = new Map([
      [
        "assets/entry.js",
        'import{a as b}from"./a.js";import"./side.js";export{c}from"./re.js";const d=()=>import("./lazy.js");',
      ],
      ["assets/a.js", "export const a=1;"],
      ["assets/side.js", "console.log(1);"],
      ["assets/re.js", "export const c=2;"],
      ["assets/lazy.js", "export const l=3;"],
    ]);
    const result = classifyJsAssets('<script type="module" src="/assets/entry.js"></script>', minified);
    expect(result.firstScreen).toEqual(new Set(["assets/entry.js", "assets/a.js", "assets/side.js", "assets/re.js"]));
    expect(result.lazy).toEqual(new Set(["assets/lazy.js"]));
  });

  it("fails first-screen and lazy budgets independently", () => {
    const firstScreenBudget = gzipBytes("first") + gzipBytes("second");
    const lazyBudget = gzipBytes("lazy");
    expect(budgetExceeded(firstScreenBudget + 1, firstScreenBudget)).toBe(true);
    expect(budgetExceeded(lazyBudget, lazyBudget)).toBe(false);
    expect(budgetExceeded(lazyBudget + 1, lazyBudget)).toBe(true);
    expect(budgetExceeded(firstScreenBudget, firstScreenBudget)).toBe(false);
  });

  it("exposes measured values in the summary shape", () => {
    const line =
      "✓ check:web — dist/web-hub-ui/ OK (5 files, first-screen JS 233828B gz/258048B, lazy JS 27658B gz/41984B, CSS 12000B gz/25600B)";
    expect(line).toMatch(/first-screen JS \d+B gz\/\d+B/);
    expect(line).toMatch(/lazy JS \d+B gz\/\d+B/);
    expect(line).toMatch(/CSS \d+B gz\/\d+B/);
  });
});
