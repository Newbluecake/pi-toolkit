// 2026-10-20 「手机模式下点击代理按钮没有反应」: a tab older than the hub's current UI build
// cannot load its lazy chunks; the failed import must surface a reload notice instead of a dead
// button.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staleUi, wireStaleUiCapture } from "../../../src/web-hub/ui/src/composables/useStaleUi.js";

const SRC = new URL("../../../src/web-hub/ui/src/", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

describe("useStaleUi", () => {
  it("latches a vite:preloadError into the page-wide stale flag", () => {
    const target = new EventTarget();
    wireStaleUiCapture(target as unknown as Window);
    expect(staleUi.value).toBe(false);
    target.dispatchEvent(new Event("vite:preloadError"));
    expect(staleUi.value).toBe(true);
  });

  it("is wired before mount and rendered as a persistent reload notice", () => {
    const main = read("main.ts");
    expect(main.indexOf("wireStaleUiCapture(window)")).toBeGreaterThan(-1);
    expect(main.indexOf("wireStaleUiCapture(window)")).toBeLessThan(main.indexOf(".mount("));
    const app = read("App.vue");
    expect(app).toMatch(/id: "ui-stale"[\s\S]*?action: \{ label: t\("notices\.reload"\) \}[\s\S]*?persistent: true/);
    expect(app).toMatch(/if \(id === "ui-stale"\) window\.location\.reload\(\);/);
    expect(app).toContain('@action="onGlobalNoticeAction"');
  });
});
