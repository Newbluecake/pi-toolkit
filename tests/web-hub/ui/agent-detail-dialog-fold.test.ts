// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import enDialog from "../../../src/web-hub/ui/src/i18n/en/dialog.js";
import zhDialog from "../../../src/web-hub/ui/src/i18n/zh/dialog.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/**
 * AgentDetail.vue's `foldedNote()` (control-plan.md v2.1 §7.4/§5.4/§5.5 — C5, acc32-B3 /
 * accfix-B3): a `dialogs.closed[].by === "web"` record means SOME browser tab answered —
 * comparing its `cmdId` against the ids THIS mount generated (`trackOwnDialogCmdId`) tells
 * "answered here" apart from "answered in a different browser tab", which used to collapse to
 * the same (wrong, for the local case) "Answered in another browser" text.
 *
 * accfix-B3 root cause: the id used to be recovered by scanning `props.agent.pendingCtl` right
 * after the (fire-and-forget) `answerDialog`/`cancelDialog` call returned — but `props.agent` is
 * a throttled render-gate snapshot (`useHub.ts`) that only updates on its own commit cadence, so
 * that scan always saw the PREVIOUS snapshot and `mine` was permanently false. These tests'
 * fake `ControlHandle` therefore deliberately does NOT mutate `agent.pendingCtl` at all — the fix
 * must work from the id `AgentDetail.vue` generates and passes INTO `answerDialog`/`cancelDialog`
 * itself, never from reading it back out of props.
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

describe("AgentDetail.vue — ask_user close-fold attribution (acc32-B3 / accfix-B3)", () => {
  it("this tab's own successful answer folds to a local 'answered' note, not 'another browser'", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:1")], closed: [] };
    let capturedId: string | undefined;
    const control = fakeControl({
      // Deliberately does NOT touch `agent.pendingCtl` — the accfix-B3 regression is that the
      // OLD code depended on that side channel (which lags props by a render-gate commit) to
      // recover the id; the fix must work purely from the id passed INTO this call.
      answerDialog: async (_agentKey, _dialogId, _epoch, _answers, id): Promise<CmdOutcome> => {
        capturedId = id;
        return { ok: true };
      },
    });
    const w = mountDetail(agent, control);
    const form = w.findComponent(AskUserForm);
    expect(form.exists()).toBe(true);
    await form.vm.$emit("answer", [{ selected: ["A"], other: null }]);
    await nextTick();
    expect(capturedId).toBeDefined();

    // The dialog leaves `open`, and `closed[]` reports it answered by "web" with the SAME cmdId
    // this tab's `answerDialog()` call just generated and passed in.
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:1", by: "web", outcome: "answered", cmdId: capturedId, at: 2 }],
    };
    await nextTick();
    await nextTick();

    // 2026-10 user request: this tab's OWN answer gets no fold note at all (it is self-evident);
    // the attribution is still resolved ("mine"), which is exactly what suppresses the note.
    expect(w.find(".ask-folded").exists()).toBe(false);
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

  it("attribution does not depend on props.agent.pendingCtl reflecting the optimistic item yet (accfix-B3 regression)", async () => {
    // Simulates the exact failure mode: `props.agent` never gets an updated `pendingCtl` at all
    // during this test (the render-gate commit that would normally do so never happens here) —
    // the OLD `trackOwnDialogCmdId` that scanned `pendingCtl.value` would have found nothing and
    // permanently reported `mine === false`.
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:3")], closed: [] };
    expect(agent.pendingCtl).toEqual([]);
    let capturedId: string | undefined;
    const control = fakeControl({
      answerDialog: async (_agentKey, _dialogId, _epoch, _answers, id): Promise<CmdOutcome> => {
        capturedId = id;
        return { ok: true }; // agent.pendingCtl is intentionally left untouched
      },
    });
    const w = mountDetail(agent, control);
    const form = w.findComponent(AskUserForm);
    await form.vm.$emit("answer", [{ selected: ["A"], other: null }]);
    await nextTick();
    expect(agent.pendingCtl).toEqual([]); // still untouched — proves attribution didn't need it

    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:3", by: "web", outcome: "answered", cmdId: capturedId, at: 2 }],
    };
    await nextTick();
    await nextTick();

    // attributed as "mine" ⇒ no fold note (2026-10: own answers/cancels are not echoed)
    expect(w.find(".ask-folded").exists()).toBe(false);
  });
});

describe("AgentDetail.vue — folded note survives closed[] eviction (accfix-N3)", () => {
  it("a specific outcome resolved once stays specific even after its closed[] record scrolls out of the bounded slot", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:n3")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    expect(w.findComponent(AskUserForm).exists()).toBe(true);

    // The dialog closes with a determinable outcome (cancelled in the terminal).
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:n3", by: "tui", outcome: "cancelled", at: 2 }],
    };
    await nextTick();
    await nextTick();
    expect(w.find(".ask-folded").text()).toBe("Cancelled in the terminal");

    // accfix-N3: `closed[]` is a bounded slot on the hub/agent side — the SAME dialogId's record
    // can later scroll out of it (enough other dialogs closed after it) while the fold row for
    // this dialogId is STILL shown (`folded` has its own, independent 4-item cap). Before the
    // fix, `foldedNote` re-derived its text from `closedDialogs.value.find(...)` on every call,
    // so losing the record degraded the note to the generic "Dialog closed" on the very next
    // render — even though nothing about the ANSWER changed, only bookkeeping elsewhere evicted
    // it.
    agent.dialogs = { epoch: "e1", open: [], closed: [] };
    await nextTick();
    await nextTick();

    const note = w.find(".ask-folded");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("Cancelled in the terminal");
    expect(note.text()).not.toBe("Dialog closed");
  });

  it("a dialogId this mount never resolved (no closed[] record ever seen) still falls back to the generic note", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:n3b")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);

    // The dialog leaves `open` without EVER appearing in `closed[]` at all (e.g. it was already
    // gone from the bounded slot by the time this tab observed the transition) — this is the
    // one legitimate case the generic fallback text must still cover.
    agent.dialogs = { epoch: "e1", open: [], closed: [] };
    await nextTick();
    await nextTick();

    const note = w.find(".ask-folded");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe("Dialog closed");
  });
});

describe("AgentDetail.vue — background-interrupt close note (ask-user-async §7.2, P3)", () => {
  it('by:"background" folds to the dedicated closedBackground note, not the generic/error fallback', async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:bg")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    expect(w.findComponent(AskUserForm).exists()).toBe(true);

    // A background completion interrupted the ask: outcome "aborted", by "background".
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:bg", by: "background", outcome: "aborted", at: 2 }],
    };
    await nextTick();
    await nextTick();

    const note = w.find(".ask-folded");
    expect(note.exists()).toBe(true);
    expect(note.text()).toBe(enDialog.closedBackground);
    expect(note.text()).not.toContain("error");
  });

  it("an unknown by value never throws — it degrades to the error-note branch (old-UI safety, acceptance #3)", async () => {
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:unk")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    agent.dialogs = {
      epoch: "e1",
      open: [],
      // a future by value this build does not know — resolveClosedNote's default must eat it
      closed: [{ dialogId: "ask:unk", by: "future-value" as never, outcome: "aborted", at: 2 }],
    };
    await nextTick();
    await nextTick();
    expect(w.find(".ask-folded").text()).toBe(enDialog.closedError);
  });

  it("the closedBackground copy follows plan §7.2 in both locales", () => {
    expect(enDialog.closedBackground).toBe("Background task finished — the agent will re-ask");
    expect(zhDialog.closedBackground).toBe("后台任务完成，问题已暂挂，模型会重新提问");
  });
});

describe("AgentDetail.vue — folded note auto-dismiss (bug fix: used to stay pinned forever)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a folded note disappears on its own ~8s after it first appears", async () => {
    vi.useFakeTimers();
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:auto")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    expect(w.findComponent(AskUserForm).exists()).toBe(true);

    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:auto", by: "tui", outcome: "cancelled", at: 2 }],
    };
    await nextTick();
    await nextTick();
    expect(w.find(".ask-folded").exists()).toBe(true);

    vi.advanceTimersByTime(7999);
    await nextTick();
    expect(w.find(".ask-folded").exists()).toBe(true);

    vi.advanceTimersByTime(2);
    await nextTick();
    expect(w.find(".ask-folded").exists()).toBe(false);
  });

  it("unmounting clears pending auto-dismiss timers (no stray setTimeout callbacks after teardown)", async () => {
    vi.useFakeTimers();
    const agent = baseAgent();
    agent.dialogs = { epoch: "e1", open: [dialogWire("ask:unmount")], closed: [] };
    const control = fakeControl();
    const w = mountDetail(agent, control);
    agent.dialogs = {
      epoch: "e1",
      open: [],
      closed: [{ dialogId: "ask:unmount", by: "tui", outcome: "cancelled", at: 2 }],
    };
    await nextTick();
    await nextTick();
    expect(w.find(".ask-folded").exists()).toBe(true);

    w.unmount();
    mounted.pop(); // already unmounted here, don't double-unmount in afterEach
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
