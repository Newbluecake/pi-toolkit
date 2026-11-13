// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { captureTerminalStyles } from "../../../src/web-hub/ui/src/components/terminal/constructed-styles.js";

const rules = [
  ".xterm-dom-renderer-owner-1 .xterm-rows span { display: inline-block; }",
  ".xterm-dom-renderer-owner-1 .xterm-rows { color: red; }",
  ".xterm .xterm-scrollable-element > .scrollbar > .slider { background: red; }",
];
function makeRoot() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}
function openStyles(root: HTMLElement) {
  return rules.map((text) => {
    const style = document.createElement("style");
    root.appendChild(style);
    style.textContent = text;
    return style;
  });
}
afterEach(() => {
  document.body.replaceChildren();
  document.adoptedStyleSheets = [];
});

describe("terminal constructed stylesheet seam", () => {
  it("forwards known initial and subsequent textContent synchronously, preserving unrelated sheets", () => {
    const existing = new CSSStyleSheet();
    document.adoptedStyleSheets = [existing];
    const root = makeRoot();
    const original = document.createElement;
    const captured = captureTerminalStyles(root, "6.0.0", () => openStyles(root));
    expect(document.createElement).toBe(original);
    expect(Object.hasOwn(document, "createElement")).toBe(false);
    expect(document.adoptedStyleSheets).toHaveLength(4);
    expect(document.adoptedStyleSheets[0]).toBe(existing);
    expect(root.querySelectorAll("style")).toHaveLength(0);
    expect(captured.value[0]!.childNodes).toHaveLength(0);
    captured.value[1]!.textContent = rules[1]!.replace("red", "blue");
    expect(document.adoptedStyleSheets[2]!.cssRules[0]!.cssText).toContain("blue");
    expect(document.adoptedStyleSheets[3]!.cssRules[0]!.cssText).toContain(".pwh-terminal-");
    captured.dispose();
    captured.dispose();
    expect(document.adoptedStyleSheets).toEqual([existing]);
    expect(root.children).toHaveLength(0);
    captured.value[1]!.textContent = rules[1]!;
    expect(document.adoptedStyleSheets).toEqual([existing]);
  });
  it("fails closed on a non-pinned xterm without invoking open", () => {
    let called = false;
    expect(() =>
      captureTerminalStyles(makeRoot(), "6.0.1", () => {
        called = true;
      }),
    ).toThrow("requires 6.0.0");
    expect(called).toBe(false);
  });
  it("rejects unsupported constructed stylesheets before patching document", () => {
    const doc = { defaultView: { CSSStyleSheet: class {} }, adoptedStyleSheets: [] } as unknown as Document;
    const root = { ownerDocument: doc } as HTMLElement;
    expect(() => captureTerminalStyles(root, "6.0.0", () => {})).toThrow("not supported");
    expect(Object.hasOwn(doc, "createElement")).toBe(false);
  });
  it("restores an existing own wrapper and cleans partial opens on errors", () => {
    const root = makeRoot();
    const wrapper = document.createElement.bind(document);
    Object.defineProperty(document, "createElement", { value: wrapper, configurable: true, writable: true });
    try {
      expect(() =>
        captureTerminalStyles(root, "6.0.0", () => {
          openStyles(root);
          throw new Error("renderer failed");
        }),
      ).toThrow("renderer failed");
      expect(document.createElement).toBe(wrapper);
      expect(document.adoptedStyleSheets).toHaveLength(0);
      expect(root.children).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(document, "createElement");
    }
  });
  it("rejects unknown injection points and changed known sets", () => {
    const root = makeRoot();
    expect(() =>
      captureTerminalStyles(root, "6.0.0", () => {
        const node = document.createElement("style");
        root.appendChild(node);
        node.textContent = ".unknown { color: red; }";
      }),
    ).toThrow("unknown xterm");
    expect(document.adoptedStyleSheets).toHaveLength(0);
    expect(() =>
      captureTerminalStyles(root, "6.0.0", () => {
        const node = document.createElement("style");
        root.appendChild(node);
        node.textContent = rules[0]!;
      }),
    ).toThrow("1/3");
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });
  it("keeps multi-instance sheets independent", () => {
    const first = makeRoot(),
      second = makeRoot();
    const one = captureTerminalStyles(first, "6.0.0", () => openStyles(first));
    const two = captureTerminalStyles(second, "6.0.0", () => openStyles(second));
    one.dispose();
    expect(document.adoptedStyleSheets).toHaveLength(3);
    two.value[1]!.textContent = rules[1]!.replace("red", "green");
    expect(document.adoptedStyleSheets[1]!.cssRules[0]!.cssText).toContain("green");
    two.dispose();
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });
});
