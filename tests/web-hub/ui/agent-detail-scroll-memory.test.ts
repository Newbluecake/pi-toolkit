// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { createScrollMemory, SCROLL_MEMORY } from "../../../src/web-hub/ui/src/composables/useScrollMemory.js";
import type { AgentState, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/**
 * AgentDetail.vue's `following` 初值 now seeds from the DashboardView-provided scroll memory
 * (docs/dev/web-hub-session-switch/plan.md §1.4 — E1-6): a remembered `following:false` for the
 * mounted agentKey reaches the DetailDock as `false`; no record (or no store provided) keeps the
 * pre-E1 `true`. Fixture shape reused from agent-detail-dialog-fold.test.ts.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

function baseAgent(): AgentState {
  return reactive({
    key: "a1",
    card: { control: true, state: "live" },
    down: false,
    prompts: [],
    fleet: [],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    commands: [],
  }) as unknown as AgentState;
}

function mountDetail(agent: AgentState, scrollMemory: ReturnType<typeof createScrollMemory> | null) {
  const hub: HubHandle = {
    state: ref({ control: true } as HubState) as HubHandle["state"],
    control: fakeControl(),
    dispatch: () => {},
  };
  const wrapper = mount(AgentDetail, {
    props: { agent, now: 1_000, narrow: false },
    global: {
      provide: {
        [HUB_CTX as symbol]: hub,
        ...(scrollMemory !== null ? { [SCROLL_MEMORY as symbol]: scrollMemory } : {}),
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

function fakeControl(): ControlHandle {
  return {
    sendPrompt: async () => ({ ok: true }),
    abort: async () => ({ ok: true }),
    steerSub: async () => ({ ok: true }),
    stopSub: async () => ({ ok: true }),
    answerDialog: async () => ({ ok: true }),
    cancelDialog: async () => ({ ok: true }),
    runCommand: async () => ({ ok: true }),
    query: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };
}

describe("AgentDetail.vue — following 初值 from scroll memory (session-switch plan §1.4 E1-6)", () => {
  it("a remembered following:false reaches the DetailDock as false", async () => {
    const mem = createScrollMemory();
    mem.set("a1", { following: false });
    const w = mountDetail(baseAgent(), mem);
    await w.vm.$nextTick();
    expect(w.findComponent(DetailDock).props("following")).toBe(false);
  });

  it("a remembered following:true reaches the DetailDock as true", async () => {
    const mem = createScrollMemory();
    mem.set("a1", { following: true });
    const w = mountDetail(baseAgent(), mem);
    await w.vm.$nextTick();
    expect(w.findComponent(DetailDock).props("following")).toBe(true);
  });

  it("no record for the key ⇒ true (today's behavior)", async () => {
    const w = mountDetail(baseAgent(), createScrollMemory());
    await w.vm.$nextTick();
    expect(w.findComponent(DetailDock).props("following")).toBe(true);
  });

  it("no SCROLL_MEMORY provided at all ⇒ true (defensive default, pre-E1 callers)", async () => {
    const w = mountDetail(baseAgent(), null);
    await w.vm.$nextTick();
    expect(w.findComponent(DetailDock).props("following")).toBe(true);
  });
});
