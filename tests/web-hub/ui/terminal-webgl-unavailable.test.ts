// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { mountTerminalSpike } from "../../../src/web-hub/ui/src/components/terminal/terminal-impl.js";
import type { WebglUiState } from "../../../src/web-hub/ui/src/components/terminal/webgl-lifecycle.js";

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("WebGL unavailable never starts an xterm or DOM fallback", () => {
  it.each(["null", "throw"])(
    "getContext %s produces a Chinese explanation before any terminal/CSS creation",
    async (mode) => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        if (mode === "throw") throw new Error("disabled by browser");
        return null;
      });
      const originalFactory = document.createElement;
      const originalAttribute = Element.prototype.setAttribute;
      const root = document.createElement("div");
      document.body.appendChild(root);
      const states: WebglUiState[] = [];
      await expect(mountTerminalSpike(root, { onStateChange: (state) => states.push(state) })).rejects.toThrow(
        "终端未启动",
      );
      expect(Terminal).not.toHaveBeenCalled();
      expect(root.childNodes).toHaveLength(0);
      expect(document.querySelectorAll('link[rel="stylesheet"], .xterm')).toHaveLength(0);
      expect(states).toEqual([expect.objectContaining({ phase: "unavailable", rebuilds: 0 })]);
      expect(document.createElement).toBe(originalFactory);
      expect(Element.prototype.setAttribute).toBe(originalAttribute);
    },
  );
});
