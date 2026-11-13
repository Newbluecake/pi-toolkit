// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import StopButton from "../../../src/web-hub/ui/src/components/control/StopButton.vue";
import { usePreviewWindowCycle } from "../../../src/web-hub/ui/src/composables/usePreviewWindowCycle.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.textContent = "";
  vi.useRealTimers();
});
function tty() {
  const surface = document.createElement("div");
  surface.setAttribute("data-terminal-input", "");
  const helper = document.createElement("textarea");
  surface.append(helper);
  document.body.append(surface);
  return helper;
}
describe("global keyboard narrow gates (§7.4)", () => {
  it("lets Escape pass the real document-capture hold-stop handler, but retains ordinary host Escape handling", async () => {
    vi.useFakeTimers();
    const w = mount(StopButton, { props: { busy: true }, attachTo: document.body });
    cleanups.push(() => w.unmount());
    await w.get(".stop-btn").trigger("click", { detail: 0 });
    const helper = tty();
    helper.focus();
    const received = vi.fn();
    helper.addEventListener("keydown", received);
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    helper.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledOnce();
    expect(w.emitted("stop")).toBeUndefined();
    w.get(".stop-btn").element.focus();
    const hostKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    w.get(".stop-btn").element.dispatchEvent(hostKey);
    expect(hostKey.defaultPrevented).toBe(true);
  });
  it("keeps Ctrl+Backquote in the terminal, while the same real window handler still cycles from ordinary page focus", async () => {
    const helper = tty();
    const page = document.createElement("button");
    document.body.append(page);
    const panel = document.createElement("div");
    panel.className = "preview-panel";
    panel.setAttribute("aria-labelledby", "pw-title-1");
    panel.tabIndex = -1;
    const win = document.createElement("section");
    win.className = "preview-window";
    win.append(panel);
    document.body.append(win);
    const focusWindow = vi.fn(() => panel.focus());
    const face = {
      windows: ref([{ id: 1, handle: {} }]),
      order: ref([1]),
      activeId: ref(1),
      focusRequest: ref(null),
      limitNotice: ref(null),
      openWindow: vi.fn(),
      closeWindow: vi.fn(),
      closeAll: vi.fn(),
      focusWindow,
    };
    const scope = effectScope();
    scope.run(() => usePreviewWindowCycle({ face: face as any, pageFocus: () => page }));
    cleanups.push(() => scope.stop());
    helper.focus();
    const key = new KeyboardEvent("keydown", {
      key: "`",
      code: "Backquote",
      ctrlKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    helper.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(helper);
    page.focus();
    const hostKey = new KeyboardEvent("keydown", {
      key: "`",
      code: "Backquote",
      ctrlKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    page.dispatchEvent(hostKey);
    await nextTick();
    await nextTick();
    expect(hostKey.defaultPrevented).toBe(true);
    expect(focusWindow).toHaveBeenCalledOnce();
  });
});
