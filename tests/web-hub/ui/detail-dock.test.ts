// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `detail/DetailDock.vue` (control-plan.md v2.1 §7.4/§7.7 — C5): control ON ⇒
 * QueueList+Composer+StopButton replace the read-only line; control OFF ⇒ the original line
 * plus the negotiated reason (hub caps / agent caps / offline). Orchestration: plain text ⇒
 * sendPrompt; slash ⇒ runCommand (E_CONFIRM_REQUIRED ⇒ inline two-step ⇒ re-issue with
 * confirm:true); queue retry/discard (notExecuted ⇒ NEW id).
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
  for (const w of mounted.splice(0)) w.unmount();
});

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(handler: (method: string, args: readonly unknown[]) => CmdOutcome = () => ({ ok: true })): {
  control: ControlHandle;
  calls: Call[];
  drafts: Map<string, string>;
} {
  const calls: Call[] = [];
  const drafts = new Map<string, string>();
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(handler(method, args));
    };
  return {
    calls,
    drafts,
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
      draft: (k) => drafts.get(k) ?? "",
      setDraft: (k, t) => void drafts.set(k, t),
    },
  };
}

interface ViewOver {
  enabled?: boolean;
  readonlyReason?: string | null;
  busy?: boolean;
  commands?: readonly Record<string, unknown>[];
  commandsEnabled?: boolean;
  pendingCtl?: readonly Record<string, unknown>[];
  queue?: readonly unknown[];
}

function fakeView(control: ControlHandle, over: ViewOver = {}): { view: ControlView; agent: { value: AgentState } } {
  const agent = ref({
    pendingCtl: over.pendingCtl ?? [],
    queue: over.queue ?? [],
    prompts: [],
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => over.enabled ?? true),
    readonlyReason: computed(() => over.readonlyReason ?? null),
    agent: computed(() => agent.value),
    busy: computed(() => over.busy ?? false),
    commands: computed(() => over.commands ?? []),
    commandsEnabled: computed(() => over.commandsEnabled ?? false),
    sending: computed(() => false),
    queueItems: computed(() => [...(over.pendingCtl ?? []), ...(over.queue ?? [])]),
    isWebMessage: () => false,
  };
  return { view, agent: agent as { value: AgentState } };
}

function mountDock(
  control: ControlHandle,
  over: ViewOver = {},
  props: Partial<{ following: boolean; newCount: number }> = {},
) {
  const { view } = fakeView(control, over);
  const wrapper = mount(DetailDock, {
    props: { following: true, newCount: 0, ...props },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: over.enabled ?? true },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("DetailDock.vue — read-only reasons (§7.4)", () => {
  it("hub without cmd.v1 ⇒ 'This hub is read-only'", () => {
    const { control } = fakeControl();
    const w = mountDock(control, { enabled: false, readonlyReason: "control.dockReadonlyHub" });
    expect(w.find(".composer").exists()).toBe(false);
    expect(w.find(".readonly").text()).toContain("This hub is read-only");
  });

  it("agent without control caps ⇒ update-and-reload reason; offline ⇒ offline reason", () => {
    const { control } = fakeControl();
    const old = mountDock(control, { enabled: false, readonlyReason: "control.dockReadonlyAgent" });
    expect(old.find(".readonly").text()).toContain("doesn't support web control");
    const off = mountDock(control, { enabled: false, readonlyReason: "control.dockReadonlyOffline" });
    expect(off.find(".readonly").text()).toContain("Agent offline");
  });

  it("control ON ⇒ composer + queue list, Follow switch kept", () => {
    const { control } = fakeControl();
    const w = mountDock(control, {
      queue: [{ id: "q1", text: "queued", deliver: "steer", source: "web", cmdId: "c1", at: 1 }],
    });
    expect(w.find(".composer").exists()).toBe(true);
    expect(w.find(".queue-list").exists()).toBe(true);
    expect(w.find(".switch input").exists()).toBe(true);
  });
});

describe("DetailDock.vue — orchestration (§7.4/§7.7)", () => {
  it("plain text ⇒ sendPrompt with the current deliver mode", async () => {
    const { control, calls } = fakeControl();
    const w = mountDock(control, { busy: true });
    await w.find(".composer textarea").setValue("steer the turn");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls).toEqual([{ method: "sendPrompt", args: ["agent-a", "steer the turn", "steer"] }]);
  });

  it("slash text with a commands slot ⇒ runCommand (never sendPrompt)", async () => {
    const commands = [{ name: "session", kind: "builtin", policy: "allow", output: "captured" }];
    const { control, calls } = fakeControl(() => ({
      ok: true,
      data: {
        op: "command",
        kind: "builtin",
        completion: "sync",
        output: { entries: [{ kind: "text", text: "sess-1" }] },
      },
    }));
    const w = mountDock(control, { commands, commandsEnabled: true });
    await w.find(".composer textarea").setValue("/session");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["runCommand"]);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["agent-a", "session", ""]);
    await w.vm.$nextTick();
    expect(w.find(".command-result").exists()).toBe(true);
    expect(w.find(".command-result").text()).toContain("sess-1");
  });

  it("E_CONFIRM_REQUIRED ⇒ inline CommandConfirm ⇒ re-issued with confirm:true", async () => {
    let n = 0;
    const { control, calls } = fakeControl(() => {
      n += 1;
      return n === 1
        ? { ok: false, error: "E_CONFIRM_REQUIRED", message: "Run /new?", retryable: false, effect: "none" }
        : { ok: true, data: { op: "command", kind: "builtin", completion: "sync" } };
    });
    const commands = [{ name: "new", kind: "builtin", policy: "confirm" }];
    const w = mountDock(control, { commands, commandsEnabled: true });
    await w.find(".composer textarea").setValue("/new");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    await w.vm.$nextTick();
    expect(w.find(".command-confirm").exists()).toBe(true);
    await w.find(".command-confirm-run").trigger("click"); // arm
    await w.find(".command-confirm-run").trigger("click"); // confirm
    await flush();
    const runs = calls.filter((c) => c.method === "runCommand");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.args[3]).toEqual({ confirm: true });
  });

  it("StopButton emits ⇒ abort; queue retry/discard ⇒ control.retry/discard", async () => {
    const pendingCtl = [{ id: "f1", kind: "prompt", text: "x", state: "failed", error: "E_NETWORK", at: 0 }];
    const { control, calls } = fakeControl();
    const w = mountDock(control, { busy: true, pendingCtl });
    await w.find(".stop-btn").trigger("click");
    await w.find(".stop-btn").trigger("click");
    await w.find(".queue-actions .btn").trigger("click"); // retry
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["abort", "retry"]);
    expect(calls[1]!.args).toEqual(["agent-a", "f1"]);
  });

  it("notExecuted retry re-sends with a NEW id (sendPrompt) and discards the old item (§7.7)", async () => {
    const pendingCtl = [
      { id: "n1", kind: "prompt", text: "never ran", deliver: "followUp", state: "notExecuted", at: 0 },
    ];
    const { control, calls } = fakeControl();
    const w = mountDock(control, { pendingCtl });
    await w.find(".queue-actions .btn").trigger("click"); // resend
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["sendPrompt", "discard"]);
    expect(calls[0]!.args).toEqual(["agent-a", "never ran", "followUp"]);
    expect(calls[1]!.args).toEqual(["agent-a", "n1"]);
  });
});
