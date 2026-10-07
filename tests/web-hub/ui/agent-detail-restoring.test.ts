// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/**
 * spawn-restore plan §9.1 (F20): while a restore replaces agent `a1` (a `starting` record with
 * `restore.phase` and `prevAgentKey: "a1"`), a briefly reconnected old card must NOT take input —
 * a prompt sent to it dies when it is reaped. AgentDetail turns its whole control surface
 * read-only (dock reason `spawn.composerRestoring`, no ask_user forms); without that record the
 * same agent is fully controllable (the positive control proves the harness can see the form).
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

function dialogWire(dialogId: string) {
  return {
    dialogId,
    source: "ask_user",
    toolCallId: dialogId,
    questions: [{ question: "Which plan?", options: [{ label: "A" }, { label: "B" }] }],
    allowCancel: true,
    openedAt: 1,
  };
}

function mountDetail(agent: AgentState, control: ControlHandle, spawns: unknown = null) {
  const hub: HubHandle = {
    state: ref({ control: true, spawns } as unknown as HubState) as HubHandle["state"],
    control,
    dispatch: () => {},
  };
  const wrapper = mount(AgentDetail, {
    props: { agent, now: 1_000, narrow: false },
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
  mounted.push(wrapper);
  return wrapper;
}

function fakeControl(over: Partial<ControlHandle> = {}): ControlHandle {
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
    ...over,
  };
}

const restoringSpawns = (prevAgentKey: string) => ({
  items: [
    {
      spawnId: "sp-r",
      state: "starting",
      createdAt: 1,
      updatedAt: 2,
      cwdLabel: "p",
      restore: { phase: "reaping", attempt: 0, prevAgentKey },
    },
  ],
  active: 1,
  max: 4,
});

describe("AgentDetail.vue — restoring old card is read-only (spawn-restore plan §9.1)", () => {
  it("control surface enabled without a restore (positive control)", () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:1")], closed: [] };
    const w = mountDetail(agent, fakeControl());
    expect(w.findComponent(AskUserForm).exists()).toBe(true);
    expect(w.text()).not.toContain("being restored");
  });

  it("the OLD agent of a restore in flight: no ask_user form, dock shows the restoring read-only reason", () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:1")], closed: [] };
    const w = mountDetail(agent, fakeControl(), restoringSpawns("a1"));
    expect(w.findComponent(AskUserForm).exists()).toBe(false);
    expect(w.text()).toContain("This session is being restored — sending is disabled until it is back.");
  });

  it("a restore of a DIFFERENT agent leaves this one controllable", () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:1")], closed: [] };
    const w = mountDetail(agent, fakeControl(), restoringSpawns("someone-else"));
    expect(w.findComponent(AskUserForm).exists()).toBe(true);
  });
});
