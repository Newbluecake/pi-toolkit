// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandConfirm from "../../../src/web-hub/ui/src/components/control/CommandConfirm.vue";

/**
 * `control/CommandConfirm.vue` (control-plan.md v2.1 §7.7/§12.3 — C5): the E_CONFIRM_REQUIRED
 * inline two-step (arm → confirm, 4s auto-revert, Esc disarm-then-cancel); the end-to-end
 * re-issue with `confirm:true` is covered by `detail-dock.test.ts`.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

describe("CommandConfirm.vue (§7.7)", () => {
  function mountConfirm() {
    const wrapper = mount(CommandConfirm, {
      props: { name: "new", args: "", message: "Run /new on agent-alpha?" },
    });
    mounted.push(wrapper);
    return wrapper;
  }

  it("first click arms, second confirms; the server message is shown", async () => {
    const w = mountConfirm();
    expect(w.text()).toContain("Run /new on agent-alpha?");
    await w.find(".command-confirm-run").trigger("click");
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.find(".command-confirm-run").attributes("data-armed")).toBe("true");
    await w.find(".command-confirm-run").trigger("click");
    expect(w.emitted("confirm")).toHaveLength(1);
  });

  it("auto-reverts after 4s; Esc cancels (disarm first, then cancel)", async () => {
    vi.useFakeTimers();
    const w = mountConfirm();
    await w.find(".command-confirm-run").trigger("click");
    vi.advanceTimersByTime(4100);
    await w.vm.$nextTick();
    expect(w.find(".command-confirm-run").attributes("data-armed")).toBeUndefined();
    await w.find(".command-confirm-run").trigger("click");
    await w.trigger("keydown", { key: "Escape" }); // disarm
    expect(w.emitted("cancel")).toBeUndefined();
    await w.trigger("keydown", { key: "Escape" }); // cancel
    expect(w.emitted("cancel")).toHaveLength(1);
  });
});
