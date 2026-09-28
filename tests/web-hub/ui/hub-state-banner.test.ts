// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import HubStateBanner from "../../../src/web-hub/ui/src/components/shell/HubStateBanner.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/**
 * `shell/HubStateBanner.vue` (control-plan.md v2.1 §6.6/§6.7, §7.7 — C5): stopping /
 * restarting (forced vs draining) / supersedePending countdown, hidden while running.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

function hubWith(patch: Partial<HubState>): HubHandle {
  return {
    state: ref(patch as HubState),
    dispatch: () => {},
  };
}

function mountBanner(patch: Partial<HubState>) {
  const wrapper = mount(HubStateBanner, {
    global: { provide: { [HUB_CTX as symbol]: hubWith(patch) } },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("HubStateBanner.vue (§7.7)", () => {
  it("renders nothing while the hub is plain running (no supersede pending)", () => {
    const w = mountBanner({ hubState: "running" } as Partial<HubState>);
    expect(w.find(".hub-state-banner").exists()).toBe(false);
  });

  it("stopping ⇒ terminal-stop copy", () => {
    const w = mountBanner({ hubState: "stopping" } as Partial<HubState>);
    expect(w.find(".hub-state-banner").attributes("data-state")).toBe("stopping");
    expect(w.text()).toContain("stopped from the terminal");
    expect(w.text()).toContain("/webhub start");
  });

  it("restarting + forced ⇒ forced-upgrade copy; draining otherwise", () => {
    const forced = mountBanner({ hubState: "restarting", nextVersion: "1.6.0", forced: true } as Partial<HubState>);
    expect(forced.text()).toContain("1.6.0");
    expect(forced.text()).toContain("forced");
    const draining = mountBanner({ hubState: "restarting", nextVersion: "1.6.0", draining: true } as Partial<HubState>);
    expect(draining.text()).toContain("Draining");
  });

  it("supersedePending ⇒ one-liner with the HH:MM deadline, expandable", async () => {
    const at = new Date("2026-01-01T13:05:00").getTime();
    const w = mountBanner({
      hubState: "running",
      supersedePending: true,
      nextVersion: "1.6.0",
      supersedeDeadlineAt: at,
    } as Partial<HubState>);
    expect(w.find(".hub-state-banner").attributes("data-state")).toBe("pending");
    expect(w.text()).toContain("1.6.0");
    expect(w.text()).toContain("13:05");
    expect(w.find(".hub-state-detail").exists()).toBe(false);
    await w.find(".hub-state-toggle").trigger("click");
    expect(w.find(".hub-state-detail").exists()).toBe(true);
  });

  it("no HUB_CTX provider ⇒ nothing renders (defensive)", () => {
    const wrapper = mount(HubStateBanner);
    mounted.push(wrapper);
    expect(wrapper.find(".hub-state-banner").exists()).toBe(false);
  });
});
