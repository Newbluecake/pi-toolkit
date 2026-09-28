// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import StopButton from "../../../src/web-hub/ui/src/components/control/StopButton.vue";

/**
 * `control/StopButton.vue` (control-plan.md v2.1 §7.4 — C5): two-step confirm — first click
 * arms (data-armed, aria-live announcement, queue note), second click emits `stop`; 4s
 * auto-revert and Esc disarm; nothing renders while the agent is idle.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountStop(props: { busy: boolean; queueCount?: number }) {
  const wrapper = mount(StopButton, { props });
  mounted.push(wrapper);
  return wrapper;
}

describe("StopButton.vue (§7.4 two-step)", () => {
  it("renders nothing while the agent is not busy", () => {
    const w = mountStop({ busy: false });
    expect(w.find(".stop-btn").exists()).toBe(false);
  });

  it("first click only arms (no emit, data-armed + live announcement); second click emits stop", async () => {
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    expect(w.emitted("stop")).toBeUndefined();
    expect(w.find(".stop-btn").attributes("data-armed")).toBe("true");
    expect(w.find(".stop-live").exists()).toBe(true);
    await w.find(".stop-btn").trigger("click");
    expect(w.emitted("stop")).toHaveLength(1);
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
  });

  it("auto-reverts after 4s", async () => {
    vi.useFakeTimers();
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    expect(w.find(".stop-btn").attributes("data-armed")).toBe("true");
    vi.advanceTimersByTime(4100);
    await w.vm.$nextTick();
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
    await w.find(".stop-btn").trigger("click"); // arms again — no stale emit
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("Esc disarms without emitting", async () => {
    const w = mountStop({ busy: true });
    await w.find(".stop-btn").trigger("click");
    await w.find(".stop-btn").trigger("keydown", { key: "Escape" });
    expect(w.find(".stop-btn").attributes("data-armed")).toBeUndefined();
    expect(w.emitted("stop")).toBeUndefined();
  });

  it("armed copy carries the K12 queue note when queueCount > 0", async () => {
    const w = mountStop({ busy: true, queueCount: 3 });
    await w.find(".stop-btn").trigger("click");
    expect(w.find(".stop-queue-note").text()).toContain("3");
  });
});
