import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostWarn } from "../../src/stack.js";

describe("hostWarn (TUI-safe warning sink)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes through ctx.ui.notify when a UI is present (never raw stderr in the TUI)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notify = vi.fn();
    hostWarn({ hasUI: true, ui: { notify } } as unknown as ExtensionContext, "droid auth 401");
    expect(notify).toHaveBeenCalledWith("droid auth 401", "warning"); // UI copy carries no [pi-subagent] tag
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to console.warn without a UI (print/json/child sessions)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hostWarn({ hasUI: false } as unknown as ExtensionContext, "x");
    expect(warn).toHaveBeenCalledWith("[pi-subagent] x");
  });

  it("falls back to console.warn when notify throws (stale ctx)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notify = vi.fn(() => {
      throw new Error("stale");
    });
    hostWarn({ hasUI: true, ui: { notify } } as unknown as ExtensionContext, "y");
    expect(warn).toHaveBeenCalledWith("[pi-subagent] y");
  });
});
