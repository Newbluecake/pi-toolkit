// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/**
 * AgentDetail.vue's `foldedNote()` (control-plan.md v2.1 §7.4/§5.4/§5.5 — C5, acc32-B3): a
 * `dialogs.closed[].by === "web"` record means SOME browser tab answered — comparing its
 * `cmdId` against the ids THIS mount generated (`trackOwnDialogCmdId`) tells "answered here"
 * apart from "answered in a different browser tab", which used to collapse to the same
 * (wrong, for the local case) "Answered in another browser" text.
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

function mountDetail(agent: AgentState, control: ControlHandle) {
  const hub: HubHandle = {
    state: ref({ control: true } as HubState) as HubHandle["state"],
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

describe("AgentDetail.vue — ask_user close-fold attribution (acc32-B3)", () => {
  it("this tab's own successful answer folds to a local 'answered' note, not 'another browser'", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:1")], closed: [] };
    let nextId = 0;
    const control = fakeControl({
      answerDialog: async (_agentKey, dialogId): Promise<CmdOutcome> => {
        const id = `mine-${(nextId += 1)}`;
        // Mirrors useControl.ts's `sendDialog`: the optimistic pendingCtl item lands
        // synchronously, before this async function's caller even sees the returned promise.
        (agent as unknown as { pendingCtl: unknown[] }).pendingCtl = [
          ...((agent.pendingCtl as unknown[]) ?? []),
          { id, kind: "dialog_answer", dialogId, state: "sending", at: 0 },
        ];
        return { ok: true };
      },
    });
    const w = mountDetail(agent, control);
    const form = w.findComponent(AskUserForm);
    expect(form.exists()).toBe(true);
    await form.vm.$emit("answer", [{ selected: ["A"], other: null }]);
    await nextTick();
    const mineId = (agent.pendingCtl as Array<{ id: string }>)[0]!.id;

    // The dialog leaves `open`, and `closed[]` reports it answered by "web" with the SAME cmdId
    // this tab's `answerDialog()` call just generated.
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:1", by: "web", outcome: "answered", cmdId: mineId, at: 2 }],
    };
    await nextTick();
    await nextTick();

    const note = w.find(".ask-folded");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("Answered");
    expect(note.text()).not.toContain("another browser");
  });

  it("a DIFFERENT browser tab's answer (unrelated cmdId) still folds to 'answered in another browser'", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:2")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    expect(w.findComponent(AskUserForm).exists()).toBe(true);

    // Nobody in THIS tab ever answered — some other tab won the race first.
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:2", by: "web", outcome: "answered", cmdId: "someone-elses-cmd", at: 2 }],
    };
    await nextTick();
    await nextTick();

    const note = w.find(".ask-folded");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("Answered in another browser");
  });
});
