// @vitest-environment happy-dom
/**
 * preview-perf P3 §6.3 — the window-level 完整视图 escape (plan r3 §4.7, 已拍板 ③):
 *  - the header button appears only while a virtual source view is AVAILABLE (and stays
 *    visible while pressed, to un-press it);
 *  - ON renders exactly the line-numbers-OFF legacy DOM (byte-identical `outerHTML`);
 *  - it affects ONLY this window — a sibling window with a big file stays virtual, and the
 *    global line-numbers pref is untouched;
 *  - the state SURVIVES file navigation (kept until the window closes);
 *  - with it on, `findable` is false (the Ctrl+F interception goes away — pinned in
 *    preview-find.test.ts; here: the button + the legacy body coexist).
 */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import {
  LINE_NUMBERS_STORAGE_KEY,
  resetLineNumbersPrefForTests,
} from "../../../src/web-hub/ui/src/composables/useLineNumbersPref.js";
import type { PreviewViewDir } from "../../../src/web-hub/ui/src/composables/usePreview.js";
import { fakeWindowHandle, fakeWindowsFace } from "./helpers/preview-windows-fake.js";

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

const bigText = (lines: number): string => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function rig(views: Array<{ path: string; text: string }>): {
  wins: Array<ReturnType<typeof fakeWindowHandle>>;
} {
  const wins = views.map((v, i) =>
    fakeWindowHandle(i + 1, {
      phase: "text",
      path: v.path,
      text: v.text,
      truncated: false,
      size: v.text.length,
    } as PreviewViewDir),
  );
  const face = fakeWindowsFace(wins);
  const host = document.createElement("div");
  document.body.appendChild(host);
  mount(PreviewHost, {
    attachTo: host,
    global: { provide: { [PREVIEW_CTX as symbol]: { handle: face, plaintext: false } as PreviewContext } },
  });
  return { wins };
}

const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-panel")];

afterEach(() => {
  window.localStorage.removeItem(LINE_NUMBERS_STORAGE_KEY);
  resetLineNumbersPrefForTests();
  document.body.innerHTML = "";
});

describe("preview-full-view (§4.7)", () => {
  it("the button appears for a virtual source view and toggles aria-pressed", async () => {
    rig([{ path: "/p/big.log", text: bigText(700) }]);
    await tick();
    expect(document.querySelector("pre.pv-virtual")).not.toBeNull();
    const btn = document.querySelector<HTMLButtonElement>(".pw-fullview-btn")!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("title")).toContain("Affects this window only"); // en test lang
    btn.click();
    await tick();
    expect(btn.getAttribute("aria-pressed")).toBe("true"); // stays visible to un-press
  });

  it("ON renders the byte-identical legacy DOM the line-numbers-off view renders", async () => {
    // (a) full view ON (line numbers ON, the default)
    rig([{ path: "/p/a.log", text: bigText(700) }]);
    await tick();
    (document.querySelector<HTMLButtonElement>(".pw-fullview-btn") as HTMLButtonElement).click();
    await tick();
    const fullViewHtml = document.querySelector<HTMLElement>("pre.preview-text-body")!.outerHTML;
    expect(document.querySelector("pre.pv-virtual")).toBeNull();
    document.body.innerHTML = "";
    // (b) line numbers OFF (full view off — the pre-existing pref path)
    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    rig([{ path: "/p/a.log", text: bigText(700) }]);
    await tick();
    const lnOffHtml = document.querySelector<HTMLElement>("pre.preview-text-body")!.outerHTML;
    expect(document.querySelector("pre.pv-virtual")).toBeNull();
    expect(fullViewHtml).toBe(lnOffHtml); // §4.7: DOM 与行号关时逐字节相同
  });

  it("a small file never offers the button (no virtual view available)", async () => {
    rig([{ path: "/p/small.log", text: "a\nb\nc" }]);
    await tick();
    expect(document.querySelector(".pw-fullview-btn")).toBeNull();
  });

  it("only THIS window: a sibling window's virtual body is untouched; the pref survives", async () => {
    rig([
      { path: "/p/one.log", text: bigText(700) },
      { path: "/p/two.log", text: bigText(800) },
    ]);
    await tick();
    expect(panels()).toHaveLength(2);
    expect(document.querySelectorAll("pre.pv-virtual")).toHaveLength(2);
    (panels()[0]!.querySelector(".pw-fullview-btn") as HTMLButtonElement).click();
    await tick();
    const pres = [...document.querySelectorAll<HTMLElement>("pre.preview-text-body")];
    expect(pres[0]!.classList.contains("pv-virtual")).toBe(false); // this window: legacy
    expect(pres[1]!.classList.contains("pv-virtual")).toBe(true); // sibling: still virtual
    expect(window.localStorage.getItem(LINE_NUMBERS_STORAGE_KEY)).toBeNull(); // pref untouched
  });

  it("the state SURVIVES file navigation within the window (kept until close, §4.7)", async () => {
    const { wins } = rig([{ path: "/p/first.log", text: bigText(700) }]);
    await tick();
    (document.querySelector<HTMLButtonElement>(".pw-fullview-btn") as HTMLButtonElement).click();
    await tick();
    // navigate: loading → another big text view (the PreviewText remounts on the new path)
    wins[0]!.view.value = { phase: "loading", path: "/p/second.log" } as PreviewViewDir;
    await tick();
    wins[0]!.view.value = {
      phase: "text",
      path: "/p/second.log",
      text: bigText(900),
      truncated: false,
      size: 0,
    } as PreviewViewDir;
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.preview-text-body")!;
    expect(pre.classList.contains("pv-virtual")).toBe(false); // full view still ON
    const btn = document.querySelector<HTMLButtonElement>(".pw-fullview-btn")!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // and it still un-presses back to the virtual body
    btn.click();
    await tick();
    expect(document.querySelector("pre.pv-virtual")).not.toBeNull();
  });
});
