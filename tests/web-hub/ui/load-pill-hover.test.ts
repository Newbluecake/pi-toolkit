// @vitest-environment happy-dom
/**
 * LoadPill hover peek (2026-10-17 user 「sysload 也改为 hover 悬停展开模式，参考 quota」): mirrors
 * QuotaPill's pinned + hover-peek popover — ~150ms hover opens a non-pinned peek that never steals
 * focus, ~200ms after leaving BOTH pill and card it closes, a click pins it, phones never peek.
 */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoadPill from "../../../src/web-hub/ui/src/components/load/LoadPill.vue";
import type { LoadWire } from "../../../src/web-hub/protocol/messages.js";

function stubMedia(opts: { phone?: boolean; hover?: boolean }): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(max-width: 480px)"
        ? opts.phone === true
        : query === "(hover: hover) and (pointer: fine)"
          ? opts.hover === true
          : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function load(): LoadWire {
  return {
    v: 1,
    at: Date.now(),
    intervalMs: 5_000,
    scope: "host",
    level: "ok",
    thresholds: {
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
    },
    cpu: { busyPct: 12, level: "ok", cores: 8 },
  };
}

function mountPill(opts: { phone?: boolean; hover?: boolean }) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  stubMedia(opts);
  const wrapper = mount(LoadPill, { props: { load: load(), receivedAt: Date.now() }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe("LoadPill — hover peek popover (QuotaPill parity)", () => {
  it("~150ms hover opens a peek; ~200ms after leaving it closes", async () => {
    const wrapper = mountPill({ hover: true });
    const pill = wrapper.get("button.ld-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(149);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(false);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(true);
    expect(document.activeElement?.id).not.toBe("load-panel"); // peek never steals focus
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(199);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(true);
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(false);
  });

  it("pill→card traversal within the grace keeps it open; leaving the card closes it", async () => {
    const wrapper = mountPill({ hover: true });
    const pill = wrapper.get("button.ld-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await nextTick();
    await pill.trigger("mouseleave");
    vi.advanceTimersByTime(100);
    await wrapper.get("#load-panel").trigger("mouseenter");
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(true);
    await wrapper.get("#load-panel").trigger("mouseleave");
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(false);
  });

  it("a click pins it: mouseleave no longer closes; Esc does", async () => {
    const wrapper = mountPill({ hover: true });
    const pill = wrapper.get("button.ld-pill");
    await pill.trigger("mouseenter");
    vi.advanceTimersByTime(150);
    await nextTick();
    await pill.trigger("click");
    await pill.trigger("mouseleave");
    await wrapper.get("#load-panel").trigger("mouseleave");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(wrapper.find("#load-panel").exists()).toBe(false);
  });

  it("no hover-capable pointer, or a phone ⇒ hovering never opens; click still does", async () => {
    for (const opts of [{ hover: false }, { hover: true, phone: true }]) {
      const wrapper = mountPill(opts);
      const pill = wrapper.get("button.ld-pill");
      await pill.trigger("mouseenter");
      vi.advanceTimersByTime(1000);
      await nextTick();
      expect(wrapper.find("#load-panel").exists()).toBe(false);
      await pill.trigger("click");
      await nextTick();
      expect(wrapper.find("#load-panel").exists()).toBe(true);
      wrapper.unmount();
      mounted.splice(mounted.indexOf(wrapper), 1);
      vi.useRealTimers();
    }
  });
});
