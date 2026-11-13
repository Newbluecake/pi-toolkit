// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalStyleAttributes } from "../../../src/web-hub/ui/src/components/terminal/style-attributes.js";

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function root() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}
function install(el: HTMLElement) {
  const release = installTerminalStyleAttributes(el);
  releases.push(release);
  return release;
}

describe("root-scoped terminal style attributes", () => {
  it("changes only style writes on elements inside a registered root", () => {
    const original = vi.spyOn(Element.prototype, "setAttribute");
    const terminal = root(),
      outside = root();
    const cell = document.createElement("span");
    terminal.appendChild(cell);
    // Happy DOM implements cssText by re-entering JS setAttribute (native browsers do not).
    // Isolate the CSSOM boundary here; the real Chromium probe checks computed style as well.
    let written = "";
    Object.defineProperty(cell, "style", {
      configurable: true,
      value: {
        set cssText(value: string) {
          written = value;
        },
      },
    });
    install(terminal);
    cell.setAttribute("style", "color: rgb(12, 34, 56)");
    expect(written).toBe("color: rgb(12, 34, 56)");
    expect(original).not.toHaveBeenCalled();
    outside.setAttribute("style", "color: red");
    cell.setAttribute("aria-label", "cell");
    cell.setAttribute("STYLE", "color: blue");
    expect(original.mock.calls).toEqual([
      ["style", "color: red"],
      ["aria-label", "cell"],
      ["STYLE", "color: blue"],
    ]);
  });
  it("preserves detached/outside behavior; does not invent future root membership", () => {
    const original = vi.spyOn(Element.prototype, "setAttribute");
    install(root());
    const detached = document.createElement("span");
    detached.setAttribute("style", "color: red");
    expect(original).toHaveBeenCalledWith("style", "color: red");
  });
  it("reference counts multiple roots and duplicate registrations, restoring the original method", () => {
    const before = Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute");
    const first = root(),
      second = root();
    const a = install(first),
      b = install(second),
      again = install(first);
    const installed = Element.prototype.setAttribute;
    expect(installed).not.toBe(before!.value);
    a();
    a();
    b();
    expect(Element.prototype.setAttribute).toBe(installed);
    again();
    expect(Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")).toEqual(before);
  });
});
