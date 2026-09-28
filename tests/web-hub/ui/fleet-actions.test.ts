// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FleetActions from "../../../src/web-hub/ui/src/components/fleet/FleetActions.vue";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `fleet/FleetActions.vue` (control-plan.md v2.1 §7.4 — C5): inline sub-agent Steer…/Stop on
 * non-terminal rows. Renders NOTHING without the frozen `CONTROL_CTX` inject; steer input sends
 * `steerSub`, Stop is two-step → `stopSub`; outcomes surface inline.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(result: CmdOutcome = { ok: true }): { control: ControlHandle; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const noop = () => Promise.resolve(result);
  return {
    calls,
    control: {
      sendPrompt: record("sendPrompt") as ControlHandle["sendPrompt"],
      abort: record("abort") as ControlHandle["abort"],
      steerSub: record("steerSub") as ControlHandle["steerSub"],
      stopSub: record("stopSub") as ControlHandle["stopSub"],
      answerDialog: noop as ControlHandle["answerDialog"],
      cancelDialog: noop as ControlHandle["cancelDialog"],
      runCommand: noop as ControlHandle["runCommand"],
      query: noop,
      retry: noop,
      discard: () => {},
      draft: () => "",
      setDraft: () => {},
    },
  };
}

function mountActions(opts: { provideCtx?: boolean; enabled?: boolean; result?: CmdOutcome }) {
  const { control, calls } = fakeControl(opts.result);
  const wrapper = mount(FleetActions, {
    props: { agentKey: "agent-a", runId: "r_ABC", enabled: opts.enabled ?? true },
    global: {
      provide:
        opts.provideCtx === false
          ? {}
          : { [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: opts.enabled ?? true } },
    },
  });
  mounted.push(wrapper);
  return { wrapper, calls };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("FleetActions.vue (§7.4)", () => {
  it("renders nothing without the CONTROL_CTX inject (e.g. outside a control-enabled detail)", () => {
    const { wrapper } = mountActions({ provideCtx: false });
    expect(wrapper.find(".fleet-actions").exists()).toBe(false);
  });

  it("renders nothing when disabled", () => {
    const { wrapper } = mountActions({ enabled: false });
    expect(wrapper.find(".fleet-actions").exists()).toBe(false);
  });

  it("Steer… sends steerSub with the row's runId; Enter in the input sends too", async () => {
    const { wrapper, calls } = mountActions({});
    await wrapper.find(".fleet-steer-input").setValue("focus on the tests first");
    await wrapper.find(".fleet-steer .btn-ghost").trigger("click");
    await flush();
    expect(calls).toEqual([{ method: "steerSub", args: ["agent-a", "r_ABC", "focus on the tests first"] }]);
    expect((wrapper.find(".fleet-steer-input").element as HTMLInputElement).value).toBe(""); // cleared on ok
  });

  it("Stop is two-step: first click arms, second sends stopSub", async () => {
    const { wrapper, calls } = mountActions({});
    await wrapper.find(".stop-btn").trigger("click");
    expect(calls).toEqual([]);
    await wrapper.find(".stop-btn").trigger("click");
    await flush();
    expect(calls).toEqual([{ method: "stopSub", args: ["agent-a", "r_ABC"] }]);
  });

  it("a failed outcome surfaces inline (no throw, no global state)", async () => {
    const { wrapper } = mountActions({ result: { ok: false, error: "E_NOT_RUNNING", message: "run finished" } });
    await wrapper.find(".fleet-steer-input").setValue("too late");
    await wrapper.find(".fleet-steer .btn-ghost").trigger("click");
    await flush();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".fleet-actions-note").text()).toContain("run finished");
  });
});
