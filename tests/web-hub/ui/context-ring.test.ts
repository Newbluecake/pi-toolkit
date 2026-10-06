// @vitest-environment happy-dom
/**
 * `control/ContextRing.vue` (2026-10-05, user 现场拍板): the context metric's new home — an SVG
 * progress ring inside the composer textarea's right edge, fed by the inject-only
 * `DETAIL_METRICS` channel (`AgentDetail` provides). No provider / no contextUsage ⇒ renders
 * nothing. Click toggles the upward details panel (context % + tokens, cost, sub-agent cost);
 * Esc / outside click close it.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { computed } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextRing from "../../../src/web-hub/ui/src/components/control/ContextRing.vue";
import {
  DETAIL_METRICS,
  type DetailMetricsView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";

const CIRC = 2 * Math.PI * 11; // matches ContextRing.vue (R=11)

function metrics(over: {
  percent?: number;
  tokens?: number;
  window?: number;
  costUsd?: number;
  subagentCostUsd?: number;
  noUsage?: boolean;
}): DetailMetricsView {
  const usage = over.noUsage
    ? undefined
    : { tokens: over.tokens ?? 124_000, contextWindow: over.window ?? 200_000, percent: over.percent ?? 62 };
  return {
    contextUsage: computed(() => usage),
    costUsd: computed(() => over.costUsd ?? 195.54),
    subagentCostUsd: computed(() => over.subagentCostUsd),
  };
}

function mountRing(m?: DetailMetricsView, props?: { busy?: boolean; queueCount?: number }) {
  const wrapper = mount(ContextRing, {
    props,
    global: m ? { provide: { [DETAIL_METRICS as symbol]: m } } : {},
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

describe("ContextRing.vue — render gating (2026-10-05)", () => {
  it("no DETAIL_METRICS provider (dashboard / read-only dock) ⇒ no ring, no stop (idle)", () => {
    const wrapper = mountRing();
    expect(wrapper.find(".ctx-ring").exists()).toBe(false);
    expect(wrapper.find(".stop-btn").exists()).toBe(false);
  });

  it("provider without contextUsage yet ⇒ renders nothing", () => {
    const wrapper = mountRing(metrics({ noUsage: true }));
    expect(wrapper.find(".ctx-ring").exists()).toBe(false);
  });

  it("with contextUsage ⇒ ring button with a percent aria-label and a matching dasharray", () => {
    const wrapper = mountRing(metrics({ percent: 62 }));
    const btn = wrapper.get(".ctx-ring-btn");
    expect(btn.attributes("aria-label")).toContain("62%");
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".ctx-ring-bar").attributes("stroke-dasharray")).toBe(`${0.62 * CIRC} ${CIRC}`);
    expect(wrapper.get(".ctx-ring").attributes("data-tone")).toBe("ok");
  });

  it("clamps the dasharray for out-of-range percents", () => {
    const wrapper = mountRing(metrics({ percent: 140 }));
    expect(wrapper.get(".ctx-ring-bar").attributes("stroke-dasharray")).toBe(`${CIRC} ${CIRC}`);
  });
});

describe("ContextRing.vue — color grading thresholds", () => {
  it.each([
    [0, "ok"],
    [74, "ok"],
    [75, "warn"],
    [89, "warn"],
    [90, "danger"],
    [100, "danger"],
  ] as const)("percent %i ⇒ data-tone %s", (percent, tone) => {
    const wrapper = mountRing(metrics({ percent }));
    expect(wrapper.get(".ctx-ring").attributes("data-tone")).toBe(tone);
  });
});

describe("ContextRing.vue — details panel", () => {
  it("click opens the panel with the full former header metrics; click again closes", async () => {
    const wrapper = mountRing(metrics({ percent: 62, costUsd: 195.54, subagentCostUsd: 36.17 }));
    const btn = wrapper.get(".ctx-ring-btn");
    await btn.trigger("click");
    expect(btn.attributes("aria-expanded")).toBe("true");
    const panel = wrapper.get(".ctx-ring-panel");
    expect(panel.text()).toContain("62%");
    expect(panel.text()).toContain("124,000 / 200,000");
    expect(panel.text()).toContain("$195.54");
    expect(panel.text()).toContain("$36.17"); // sub-agent cost aside
    await btn.trigger("click");
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(false);
  });

  it("no sub-agent cost ⇒ no aside", async () => {
    const wrapper = mountRing(metrics({ subagentCostUsd: 0 }));
    await wrapper.get(".ctx-ring-btn").trigger("click");
    expect(wrapper.get(".ctx-ring-panel").text()).not.toContain("sub");
  });

  it("Escape closes the panel and refocuses the trigger", async () => {
    const wrapper = mountRing(metrics({}));
    const btn = wrapper.get(".ctx-ring-btn");
    await btn.trigger("click");
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(true);
    await btn.trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(false);
    expect(document.activeElement).toBe(btn.element);
  });

  it("an outside click closes the panel", async () => {
    const wrapper = mountRing(metrics({}));
    await wrapper.get(".ctx-ring-btn").trigger("click");
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(true);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(false);
  });

  it("a click INSIDE the panel keeps it open", async () => {
    const wrapper = mountRing(metrics({}));
    await wrapper.get(".ctx-ring-btn").trigger("click");
    const panel = wrapper.get(".ctx-ring-panel");
    panel.element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(true);
  });
});

describe("ContextRing.vue — merged stop mode (2026-10 user request: stop 图标放进上下文圆圈)", () => {
  it("busy + ring ⇒ ONE merged button: stop aria-label + arc still shows usage; click ARMS instead of opening the panel (stop wins the whole zone)", async () => {
    const wrapper = mountRing(metrics({ percent: 62 }), { busy: true });
    const btn = wrapper.get(".ctx-ring-stop-btn");
    expect(btn.attributes("aria-label")).toBe("Stop the current turn"); // control.stopAria
    expect(btn.attributes("aria-expanded")).toBeUndefined();
    // arc keeps rendering the live usage around the icon
    expect(wrapper.get(".ctx-ring-bar").attributes("stroke-dasharray")).toBe(`${0.62 * CIRC} ${CIRC}`);
    expect(wrapper.get(".ctx-ring-stop-icon").exists()).toBe(true);
    expect(wrapper.get(".ctx-ring").attributes("data-stop")).toBe("true");
    await btn.trigger("click"); // arms — must NOT open the details panel
    expect(btn.attributes("data-armed")).toBe("true");
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(false);
    expect(wrapper.find(".stop-live").exists()).toBe(true); // aria-live announcement preserved
  });

  it("two-step: first click arms (no emit), second click emits stop", async () => {
    const wrapper = mountRing(metrics({}), { busy: true });
    await wrapper.get(".ctx-ring-stop-btn").trigger("click");
    expect(wrapper.emitted("stop")).toBeUndefined();
    await wrapper.get(".ctx-ring-stop-btn").trigger("click");
    expect(wrapper.emitted("stop")).toHaveLength(1);
    expect(wrapper.get(".ctx-ring-stop-btn").attributes("data-armed")).toBeUndefined();
  });

  it("auto-reverts after 4s; Esc disarms without emitting", async () => {
    vi.useFakeTimers();
    const wrapper = mountRing(metrics({}), { busy: true });
    await wrapper.get(".ctx-ring-stop-btn").trigger("click");
    expect(wrapper.get(".ctx-ring-stop-btn").attributes("data-armed")).toBe("true");
    vi.advanceTimersByTime(4100);
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".ctx-ring-stop-btn").attributes("data-armed")).toBeUndefined();
    await wrapper.get(".ctx-ring-stop-btn").trigger("click"); // arm again
    await wrapper.get(".ctx-ring-stop-btn").trigger("keydown", { key: "Escape" });
    expect(wrapper.get(".ctx-ring-stop-btn").attributes("data-armed")).toBeUndefined();
    expect(wrapper.emitted("stop")).toBeUndefined();
  });

  it("armed queue note floats above the ring when queueCount > 0 (K12 copy preserved)", async () => {
    const wrapper = mountRing(metrics({}), { busy: true, queueCount: 3 });
    expect(wrapper.find(".ctx-ring-stop-note").exists()).toBe(false); // not armed yet
    await wrapper.get(".ctx-ring-stop-btn").trigger("click");
    expect(wrapper.get(".ctx-ring-stop-note").text()).toContain("3");
  });

  it("busy flipping true force-closes an open details panel (the panel must not compete with stop)", async () => {
    const wrapper = mountRing(metrics({}), { busy: false });
    await wrapper.get(".ctx-ring-btn").trigger("click");
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(true);
    await wrapper.setProps({ busy: true });
    expect(wrapper.find(".ctx-ring-panel").exists()).toBe(false);
    expect(wrapper.get(".ctx-ring-stop-btn").exists()).toBe(true);
    expect(wrapper.find(".ctx-ring-btn:not(.ctx-ring-stop-btn)").exists()).toBe(false); // no competing handler
  });

  it("busy + NO ring (no provider / no usage) ⇒ standalone StopButton fallback (stop stays reachable)", async () => {
    const noProvider = mountRing(undefined, { busy: true });
    expect(noProvider.find(".ctx-ring").exists()).toBe(false);
    await noProvider.get(".stop-btn").trigger("click"); // arm
    await noProvider.get(".stop-btn").trigger("click"); // confirm
    expect(noProvider.emitted("stop")).toHaveLength(1);

    const noUsage = mountRing(metrics({ noUsage: true }), { busy: true });
    expect(noUsage.find(".ctx-ring").exists()).toBe(false);
    expect(noUsage.find(".stop-btn").exists()).toBe(true);
  });

  it("idle + ring ⇒ no stop affordance at all (today's plain ring, unchanged)", () => {
    const wrapper = mountRing(metrics({}), { busy: false });
    expect(wrapper.find(".ctx-ring-stop-btn").exists()).toBe(false);
    expect(wrapper.find(".stop-btn").exists()).toBe(false);
    expect(wrapper.get(".ctx-ring").attributes("data-stop")).toBeUndefined();
  });
});
