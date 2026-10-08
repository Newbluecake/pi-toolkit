// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import QueueList from "../../../src/web-hub/ui/src/components/control/QueueList.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import { mergeQueue } from "../../../src/web-hub/ui/src/logic/control.js";
import type { AgentState, CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `detail/DetailDock.vue` — steer-recall (web-hub-steer-recall plan §7, P-ui): the recall
 * orchestration. Guards (SSE down / card stale ⇒ NEVER sent), the single-backfill rule
 * (`appliedRecalls`, §8.3 first-verdict-final), the re-edit flow into the Composer (injectDraft
 * rev bump + focus + announcement), copy preferring the local original text, and the reconnect
 * recovery (link back ⇒ the row is recallable again). The view's queueItems ride the REAL
 * `mergeQueue` so the pendingCtl recall-join behaves exactly as in production.
 */

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

interface RecallCall {
  method: string;
  args: readonly unknown[];
}

function fakeControl(
  handler: (method: string, args: readonly unknown[]) => CmdOutcome = () => ({ ok: true, data: {} }),
): { control: ControlHandle; calls: RecallCall[]; originals: Map<string, string> } {
  const calls: RecallCall[] = [];
  const originals = new Map<string, string>();
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(handler(method, args));
    };
  return {
    calls,
    originals,
    control: {
      sendPrompt: invoke("sendPrompt") as ControlHandle["sendPrompt"],
      abort: invoke("abort") as ControlHandle["abort"],
      steerSub: invoke("steerSub") as ControlHandle["steerSub"],
      stopSub: invoke("stopSub") as ControlHandle["stopSub"],
      answerDialog: invoke("answerDialog") as ControlHandle["answerDialog"],
      cancelDialog: invoke("cancelDialog") as ControlHandle["cancelDialog"],
      runCommand: invoke("runCommand") as ControlHandle["runCommand"],
      query: invoke("query"),
      retry: invoke("retry"),
      discard: invoke("discard") as unknown as (agentKey: string, id: string) => void,
      draft: () => "",
      setDraft: () => {},
      recall: invoke("recall") as NonNullable<ControlHandle["recall"]>,
      originalText: (_key: string, sessionId: string, cmdId: string) =>
        originals.get(`${sessionId}|${cmdId}`) as string | undefined,
      forgetAgent: () => {},
    },
  };
}

interface DockHarness {
  wrapper: ReturnType<typeof mount>;
  calls: RecallCall[];
  control: ControlHandle;
  pendingCtl: ReturnType<typeof ref>;
  held: ReturnType<typeof ref>;
  rowMode: ReturnType<typeof ref>;
}

function mountRecallDock(
  control: ControlHandle,
  over: {
    holdEnabled?: boolean;
    holdLink?: "live" | "unavailable";
    pendingCtl?: readonly Record<string, unknown>[];
    held?: readonly Record<string, unknown>[];
    rowMode?: "recallable" | "unavailable";
    sessionId?: string;
  } = {},
): DockHarness {
  const pendingCtl = ref([...(over.pendingCtl ?? [])]) as ReturnType<typeof ref>;
  const held = ref([...(over.held ?? [HELD_ROW])]) as ReturnType<typeof ref>;
  const rowMode = ref(over.rowMode ?? "recallable") as ReturnType<typeof ref>;
  const agent = ref({
    pendingCtl: pendingCtl.value,
    queue: [],
    prompts: [],
    fleet: [],
    held: held.value,
    session: { sessionId: over.sessionId ?? "s1" },
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => true),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() =>
      mergeQueue(
        [],
        [...(pendingCtl.value as readonly Record<string, unknown>[])],
        [],
        [...(held.value as readonly Record<string, unknown>[])],
        {
          holdEnabled: over.holdEnabled ?? true,
          rowMode: rowMode.value as "recallable" | "unavailable",
          sessionId: over.sessionId ?? "s1",
        },
      ),
    ),
    isWebMessage: () => false,
  };
  const wrapper = mount(DetailDock, {
    props: {
      following: true,
      newCount: 0,
      holdEnabled: over.holdEnabled ?? true,
      holdLink: over.holdLink ?? "live",
    },
    attachTo: document.body,
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
      },
    },
  });
  mounted.push(wrapper);
  return { wrapper, calls: [], control, pendingCtl, held, rowMode };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const HELD_ROW = {
  cmdId: "cmd-h1",
  text: "please reb",
  deliver: "steer",
  state: "held",
  sessionId: "s1",
  at: 1,
};

describe("DetailDock.vue — steer recall (§7)", () => {
  it("recall success: wire {op:recall,target}; the row vanishes, the body lands in the composer (focused) with an announcement; dup only backfills once", async () => {
    const { control, calls } = fakeControl((_m, args) => ({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: `FULL ${String(args[1])} body` },
    }));
    const h = mountRecallDock(control);
    expect(h.wrapper.find(".queue-item").exists()).toBe(true);
    await h.wrapper.find("[data-recall]").trigger("click");
    await flush();
    // wire shape: identify-only recall {agentKey, target} — no expect (S5)
    expect(calls).toEqual([{ method: "recall", args: ["agent-a", "cmd-h1"] }]);
    // the row is gone immediately (the reducer tombstone + ctl frame follow asynchronously)
    expect(h.wrapper.find(".queue-item").exists()).toBe(false);
    // backfill: the recalled body is in the composer, focused; the live region announced
    const ta = h.wrapper.find(".composer textarea").element as HTMLTextAreaElement;
    expect(ta.value).toBe("FULL cmd-h1 body");
    expect(document.activeElement).toBe(ta);
    expect(h.wrapper.find(".sr-only").text()).toContain("recalled");
    // dup (§8.3): a second trigger of the same target never re-sends nor re-backfills
    h.wrapper.findComponent(QueueList).vm.$emit("recall", "cmd-h1");
    await flush();
    expect(calls).toHaveLength(1);
    expect((h.wrapper.find(".composer textarea").element as HTMLTextAreaElement).value).toBe("FULL cmd-h1 body");
  });

  it("an OPTIMISTIC held row (this tab's own prompt) also disappears on a successful recall", async () => {
    const { control, calls } = fakeControl(() => ({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "the full body" },
    }));
    const h = mountRecallDock(control, {
      held: [],
      pendingCtl: [{ id: "cmd-h1", kind: "prompt", text: "the full body", deliver: "steer", state: "held", at: 1 }],
    });
    expect(h.wrapper.find(".queue-item").exists()).toBe(true);
    await h.wrapper.find("[data-recall]").trigger("click");
    await flush();
    expect(calls).toEqual([{ method: "recall", args: ["agent-a", "cmd-h1"] }]);
    expect(h.wrapper.find(".queue-item").exists()).toBe(false);
    expect((h.wrapper.find(".composer textarea").element as HTMLTextAreaElement).value).toBe("the full body");
  });

  it("SSE 断开 (holdLink unavailable): the recall is NEVER sent — the guard sits in the dock, below the render", async () => {
    const { control, calls } = fakeControl();
    const h = mountRecallDock(control, { holdLink: "unavailable", rowMode: "unavailable" });
    // the row renders copy-only, and even a forced emit (a click racing a disconnect) is refused:
    h.wrapper.findComponent(QueueList).vm.$emit("recall", "cmd-h1");
    await flush();
    expect(calls).toEqual([]);
    expect((h.wrapper.find(".composer textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it("card stale ⇒ same refusal; reconnect (link back, snapshot refreshed) ⇒ the row is recallable again and the recall goes out", async () => {
    const { control, calls } = fakeControl((_m, a) => ({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: `body-${String(a[1])}` },
    }));
    const h = mountRecallDock(control, { holdLink: "unavailable", rowMode: "unavailable" });
    h.wrapper.findComponent(QueueList).vm.$emit("recall", "cmd-h1");
    await flush();
    expect(calls).toEqual([]);
    // the hub pushed a fresh snapshot (new rev) and the link is back — AgentDetail flips the props:
    h.rowMode.value = "recallable";
    await h.wrapper.setProps({ holdLink: "live" });
    await h.wrapper.vm.$nextTick();
    expect(h.wrapper.find("[data-recall]").exists()).toBe(true);
    await h.wrapper.find("[data-recall]").trigger("click");
    await flush();
    expect(calls).toEqual([{ method: "recall", args: ["agent-a", "cmd-h1"] }]);
    expect((h.wrapper.find(".composer textarea").element as HTMLTextAreaElement).value).toBe("body-cmd-h1");
  });

  it("too_late: no backfill, no announcement — the row flips to the already-delivered look (mergeQueue join)", async () => {
    const { control } = fakeControl(() => ({
      ok: true,
      data: { op: "recall", outcome: "too_late" },
    }));
    const h = mountRecallDock(control);
    await h.wrapper.find("[data-recall]").trigger("click");
    await flush();
    expect((h.wrapper.find(".composer textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(h.wrapper.find(".sr-only").text()).toBe("");
  });

  it("copy uses the LOCAL original text when the handle has it (never the 200-char clip)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { control, originals } = fakeControl();
    originals.set("s1|cmd-h1", "the FULL typed body that the wire clip truncated to 200 chars");
    const h = mountRecallDock(control, { holdLink: "unavailable", rowMode: "unavailable" });
    await h.wrapper.find("[data-copy-held]").trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("the FULL typed body that the wire clip truncated to 200 chars");
  });

  it("copy falls back to the row's wire text when no local original survived (page reload / other tab)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { control } = fakeControl();
    const h = mountRecallDock(control, { holdLink: "unavailable", rowMode: "unavailable" });
    await h.wrapper.find("[data-copy-held]").trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledWith("please reb");
  });

  it("discardHeld hides a returned row locally (agent-side row untouched)", async () => {
    const { control } = fakeControl();
    const h = mountRecallDock(control, {
      held: [{ ...HELD_ROW, state: "returned", reason: "stale" }],
    });
    expect(h.wrapper.findAll(".queue-item")).toHaveLength(1);
    await h.wrapper.find("[data-discard-held]").trigger("click");
    await h.wrapper.vm.$nextTick();
    expect(h.wrapper.find(".queue-list").exists()).toBe(false);
  });
});
