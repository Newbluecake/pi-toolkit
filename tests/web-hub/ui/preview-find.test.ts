// @vitest-environment happy-dom
/**
 * preview-perf P3 §6.3 — the in-window find, wired through the REAL window stack
 * (PreviewHost → PreviewWindow → PreviewText → VirtualCode, >600-line body ⇒ virtual):
 *  - the Ctrl/⌘+F interception matrix (§4.6): focus INSIDE the window ⇒ prevent + open the
 *    bar (input selected); focus in the FIND INPUT ⇒ let the browser's page find through;
 *    IME composition / already-prevented / full view on / line numbers off / non-virtual
 *    body / focus outside the window ⇒ never intercepted;
 *  - the bar's keys: Enter / Shift+Enter, F3 / Shift+F3, Ctrl/⌘+G (+Shift) navigate and
 *    wrap, IME-composed Enter is ignored, Esc closes ONLY the bar (PreviewHost's window
 *    Esc checks defaultPrevented — the window survives) and focus returns to the scroll body;
 *  - the count live region (`role=status`: `cur / n`) and the standing scope note;
 *    navigation to a far hit scrolls the virtual body to the hit's line.
 */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A >600-line body: even lines carry "hit 00xx", odd lines are plain filler. */
const bigText = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => (i % 2 === 0 ? `hit ${String(i).padStart(4, "0")} tail` : `plain ${i}`)).join(
    "\n",
  );

function rigText(text: string, path = "/p/big.log"): { win: ReturnType<typeof fakeWindowHandle> } {
  const win = fakeWindowHandle(1, {
    phase: "text",
    path,
    text,
    truncated: false,
    size: text.length,
  } as PreviewViewDir);
  const face = fakeWindowsFace([win]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  mount(PreviewHost, {
    attachTo: host,
    global: { provide: { [PREVIEW_CTX as symbol]: { handle: face, plaintext: false } as PreviewContext } },
  });
  return { win };
}

/** The reference greedy non-overlapping count (ASCII corpus ⇒ toLowerCase == the fold). */
function greedyCount(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const h = haystack.indexOf(needle, from);
    if (h < 0) return n;
    n += 1;
    from = h + needle.length;
  }
}

function keydown(target: Element, init: KeyboardEventInit, patch?: Record<string, unknown>): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (patch !== undefined) {
    for (const [k, v] of Object.entries(patch)) Object.defineProperty(ev, k, { value: v });
  }
  target.dispatchEvent(ev);
  return ev;
}

/** Drive the find input like a real keystroke would (the @input handler reads target.value). */
function typeQuery(q: string): void {
  const input = document.querySelector<HTMLInputElement>(".pv-find-input")!;
  input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  window.localStorage.removeItem(LINE_NUMBERS_STORAGE_KEY);
  resetLineNumbersPrefForTests();
  document.body.innerHTML = "";
});

describe("Ctrl/⌘+F interception (§4.6)", () => {
  it("focus inside the window (the body) ⇒ prevented, the bar opens with its input selected", async () => {
    rigText(bigText(700));
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.pv-virtual")!;
    expect(pre).not.toBeNull(); // >600 lines ⇒ virtual
    pre.focus();
    const ev = keydown(pre, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    const input = document.querySelector<HTMLInputElement>(".pv-find-input")!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("⌘F (meta) also intercepts", async () => {
    rigText(bigText(700));
    await tick();
    const ev = keydown(document.querySelector<HTMLElement>("pre.pv-virtual")!, { key: "f", metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("focus in the FIND INPUT ⇒ NOT prevented (the browser's page find takes over)", async () => {
    rigText(bigText(700));
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.pv-virtual")!;
    keydown(pre, { key: "f", ctrlKey: true });
    await tick();
    const input = document.querySelector<HTMLInputElement>(".pv-find-input")!;
    input.focus();
    const ev = keydown(input, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });

  it("IME composition ⇒ ignored", async () => {
    rigText(bigText(700));
    await tick();
    const ev = keydown(
      document.querySelector<HTMLElement>("pre.pv-virtual")!,
      { key: "f", ctrlKey: true },
      { isComposing: true },
    );
    expect(ev.defaultPrevented).toBe(false);
    await tick();
    expect(document.querySelector(".pv-find")).toBeNull();
  });

  it("already defaultPrevented ⇒ not re-handled", async () => {
    rigText(bigText(700));
    await tick();
    document
      .querySelector<HTMLElement>(".preview-panel")!
      .addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true });
    const ev = keydown(document.querySelector<HTMLElement>("pre.pv-virtual")!, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true); // by the capture listener, NOT the window
    await tick();
    expect(document.querySelector(".pv-find")).toBeNull();
  });

  it("full view ON ⇒ findable false ⇒ never intercepted", async () => {
    rigText(bigText(700));
    await tick();
    (document.querySelector<HTMLButtonElement>(".pw-fullview-btn") as HTMLButtonElement).click();
    await tick();
    expect(document.querySelector("pre.pv-virtual")).toBeNull(); // legacy body now
    const pre = document.querySelector<HTMLElement>("pre.preview-text-body")!;
    pre.focus();
    const ev = keydown(pre, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector(".pv-find")).toBeNull();
  });

  it("line numbers OFF ⇒ legacy body ⇒ never intercepted", async () => {
    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    rigText(bigText(700));
    await tick();
    expect(document.querySelector("pre.pv-virtual")).toBeNull();
    const pre = document.querySelector<HTMLElement>("pre.preview-text-body")!;
    pre.focus();
    const ev = keydown(pre, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });

  it("focus OUTSIDE the window ⇒ the panel handler never fires", async () => {
    rigText(bigText(700));
    await tick();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const ev = keydown(outside, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    await tick();
    expect(document.querySelector(".pv-find")).toBeNull();
  });

  it("a small (non-virtual) body ⇒ never intercepted", async () => {
    rigText("just\na few\nlines");
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.preview-text-body")!;
    expect(pre.classList.contains("pv-virtual")).toBe(false);
    pre.focus();
    const ev = keydown(pre, { key: "f", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("the find bar (§4.6)", () => {
  async function rigOpen(): Promise<{ input: HTMLInputElement; count: HTMLElement; pre: HTMLElement }> {
    rigText(bigText(700));
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.pv-virtual")!;
    pre.focus();
    keydown(pre, { key: "f", ctrlKey: true });
    await tick();
    const input = document.querySelector<HTMLInputElement>(".pv-find-input")!;
    expect(input).not.toBeNull();
    return { input, count: document.querySelector<HTMLElement>(".pv-find-count")!, pre };
  }

  it("the standing scope note and the count live region render", async () => {
    const { count } = await rigOpen();
    const note = document.querySelector<HTMLElement>(".pv-find-note")!;
    expect(note.textContent).toContain("Enter");
    expect(count.getAttribute("role")).toBe("status");
    expect(count.getAttribute("aria-live")).toBe("polite");
  });

  it("typing debounces (120 ms) into the greedy count; a miss shows the empty state", async () => {
    const { count } = await rigOpen();
    typeQuery("zzz-no-such-thing");
    await vi.waitFor(
      () => {
        expect(count.textContent).toContain("No matches");
      },
      { timeout: 2000, interval: 20 },
    );
    typeQuery("hit 00");
    const want = greedyCount(bigText(700).toLowerCase(), "hit 00"); // 50: lines "hit 0000"…"hit 0098"
    expect(want).toBeGreaterThan(0);
    await vi.waitFor(
      () => {
        expect(count.textContent).toBe(`1 / ${want}`);
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it("case-insensitive by default; the Aa toggle flips to a full re-search", async () => {
    const text = Array.from({ length: 700 }, (_, i) => (i % 2 === 0 ? `CASE ${i}` : `case ${i}`)).join("\n");
    rigText(text);
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.pv-virtual")!;
    pre.focus();
    keydown(pre, { key: "f", ctrlKey: true });
    await tick();
    const count = document.querySelector<HTMLElement>(".pv-find-count")!;
    typeQuery("case 6");
    const wantInsensitive = greedyCount(text.toLowerCase(), "case 6"); // CASE + case both hit
    const wantSensitive = greedyCount(text, "case 6"); // only the lowercase lines
    expect(wantInsensitive).toBeGreaterThan(wantSensitive);
    await vi.waitFor(
      () => {
        expect(count.textContent).toBe(`1 / ${wantInsensitive}`);
      },
      { timeout: 2000, interval: 20 },
    );
    (document.querySelector(".pv-find button") as HTMLButtonElement).click(); // the Aa toggle
    await vi.waitFor(
      () => {
        expect(count.textContent).toBe(`1 / ${wantSensitive}`);
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it("Enter / Shift+Enter / F3 / Ctrl+G / Shift+Ctrl+G / ⌘G navigate, wrap, and scroll far hits in", async () => {
    const { input, count, pre } = await rigOpen();
    typeQuery("hit 00");
    const want = greedyCount(bigText(700).toLowerCase(), "hit 00");
    await vi.waitFor(
      () => {
        expect(count.textContent).toBe(`1 / ${want}`);
      },
      { timeout: 2000, interval: 20 },
    );
    const at = (n: number): string => `${n} / ${want}`;
    keydown(input, { key: "Enter" }); // next
    await tick();
    expect(count.textContent).toBe(at(2));
    keydown(input, { key: "F3" }); // next
    await tick();
    expect(count.textContent).toBe(at(3));
    keydown(input, { key: "Enter", shiftKey: true }); // prev
    await tick();
    expect(count.textContent).toBe(at(2));
    keydown(input, { key: "g", ctrlKey: true }); // next
    await tick();
    expect(count.textContent).toBe(at(3));
    keydown(input, { key: "g", ctrlKey: true, shiftKey: true }); // prev
    await tick();
    expect(count.textContent).toBe(at(2));
    keydown(input, { key: "g", metaKey: true }); // ⌘G next (Mac key path)
    await tick();
    expect(count.textContent).toBe(at(3));
    // back to hit 1, then wrap: prev from hit 1 lands on the LAST hit and scrolls down
    keydown(input, { key: "F3", shiftKey: true });
    await tick();
    expect(count.textContent).toBe(at(2));
    keydown(input, { key: "F3", shiftKey: true });
    await tick();
    expect(count.textContent).toBe(at(1));
    keydown(input, { key: "F3", shiftKey: true }); // wrap
    await tick();
    expect(count.textContent).toBe(at(want));
    await vi.waitFor(
      () => {
        expect(pre.scrollTop).toBeGreaterThan(0); // scrollToLine drove the virtual body down
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it("IME-composed Enter is ignored entirely", async () => {
    const { input, count } = await rigOpen();
    typeQuery("hit 00");
    const want = greedyCount(bigText(700).toLowerCase(), "hit 00");
    await vi.waitFor(
      () => {
        expect(count.textContent).toBe(`1 / ${want}`);
      },
      { timeout: 2000, interval: 20 },
    );
    keydown(input, { key: "Enter" }, { isComposing: true });
    await tick();
    expect(count.textContent).toBe(`1 / ${want}`);
    keydown(input, {}, { keyCode: 229 });
    await tick();
    expect(count.textContent).toBe(`1 / ${want}`);
  });

  it("Esc closes ONLY the bar: prevented + stopped, focus returns to the scroll body, the window survives", async () => {
    rigText(bigText(700));
    await tick();
    const pre = document.querySelector<HTMLElement>("pre.pv-virtual")!;
    pre.focus();
    keydown(pre, { key: "f", ctrlKey: true });
    await tick();
    const input = document.querySelector<HTMLInputElement>(".pv-find-input")!;
    input.focus();
    const esc = keydown(input, { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true); // PreviewHost's Esc branch must see this
    await tick();
    expect(document.querySelector(".pv-find")).toBeNull();
    expect(document.activeElement).toBe(pre);
    expect(document.querySelector(".preview-panel")).not.toBeNull(); // window still open
  });
});
