// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";
import {
  CMD_NOTE_AUTO_DISMISS_MS,
  __resetCmdHistoryStores,
  useCmdHistory,
} from "../../../src/web-hub/ui/src/composables/useCmdHistory.js";

/**
 * U1 · detail/DetailDock.vue historyMode (plan v2 §4.6/§4.7, D4): hub caps ∧ status.features
 * both carry `cmd.history.v1` ⇒ NO CommandResult; the dispatch leaves a placeholder in the
 * shared per-agentKey store and the reply's `history` field drives the placeholder state
 * machine. `historyMode` false ⇒ the legacy surface is untouched (covered exhaustively by
 * detail-dock.test.ts / command-result.test.ts; one guard case here).
 */

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => __resetCmdHistoryStores());
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
  __resetCmdHistoryStores();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(handler: (method: string, args: readonly unknown[]) => CmdOutcome): {
  control: ControlHandle;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(handler(method, args));
    };
  return {
    calls,
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
    },
  };
}

function mountDockHistory(
  control: ControlHandle,
  opts: {
    hubCaps?: readonly string[];
    features?: readonly string[];
    commands?: readonly Record<string, unknown>[];
  } = {},
) {
  const agent = ref({
    pendingCtl: [],
    queue: [],
    prompts: [],
    fleet: [],
    status: { features: [...(opts.features ?? [])] },
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => false),
    commands: computed(() => opts.commands ?? []),
    commandsEnabled: computed(() => true),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  const hub = { state: ref({ hub: { caps: [...(opts.hubCaps ?? [])] } }) } as unknown as HubHandle;
  const wrapper = mount(DetailDock, {
    props: { following: true, newCount: 0 },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [HUB_CTX as symbol]: hub,
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

const COMMANDS = [{ name: "session", kind: "builtin", policy: "allow", output: "captured" }];
const BOTH = { hubCaps: ["cmd.history.v1"], features: ["cmd.history.v1"], commands: COMMANDS } as const;

async function sendSlash(w: ReturnType<typeof mount>, text: string): Promise<void> {
  await w.find(".composer textarea").setValue(text);
  await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
  await flush();
}

describe("DetailDock historyMode (cmd-history §4.7)", () => {
  it("history:'recorded' ⇒ NO CommandResult, placeholder in the store, caller-minted id sent", async () => {
    const { control, calls } = fakeControl(() => ({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync", history: "recorded" },
    }));
    const w = mountDockHistory(control, BOTH);
    await sendSlash(w, "/session");
    expect(w.find(".command-result").exists()).toBe(false);
    const store = useCmdHistory("agent-a");
    expect(store.placeholders).toHaveLength(1);
    expect(store.placeholders[0]?.name).toBe("session");
    // the placeholder cmdId IS the wire frame id (§4.7: record lookup by frame id)
    const opts = calls[0]?.args[3] as { id?: string };
    expect(typeof opts.id).toBe("string");
    expect(opts.id).toBe(store.placeholders[0]?.cmdId);
  });

  it("history missing/none ⇒ placeholder swaps to the 4 s auto-dismissing 「已执行」 note", async () => {
    vi.useFakeTimers();
    const { control } = fakeControl(() => ({ ok: true, data: { op: "command", completion: "sync" } }));
    const w = mountDockHistory(control, BOTH);
    await sendSlash(w, "/session");
    const store = useCmdHistory("agent-a");
    expect(store.placeholders).toHaveLength(0);
    expect(w.find(".command-result").exists()).toBe(false);
    expect(w.find(".cmd-note").exists()).toBe(true);
    expect(w.find(".cmd-note").text()).toContain("/session");
    await vi.advanceTimersByTimeAsync(CMD_NOTE_AUTO_DISMISS_MS + 10);
    expect(w.find(".cmd-note").exists()).toBe(false);
  });

  it("dispatch error (effect none) ⇒ error note with manual dismiss, no CommandResult", async () => {
    const { control } = fakeControl(() => ({ ok: false, error: "E_POLICY", message: "denied by policy" }));
    const w = mountDockHistory(control, BOTH);
    await sendSlash(w, "/session");
    expect(w.find(".command-result").exists()).toBe(false);
    const note = w.find(".cmd-note[data-kind='err']");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("denied by policy");
    await note.find(".cmd-note-dismiss").trigger("click");
    expect(w.find(".cmd-note").exists()).toBe(false);
  });

  it("E_CONFIRM_REQUIRED ⇒ placeholder dropped, CommandConfirm unchanged, re-issue mints a NEW id", async () => {
    let n = 0;
    const { control, calls } = fakeControl(() => {
      n += 1;
      return n === 1
        ? { ok: false, error: "E_CONFIRM_REQUIRED", message: "Run /session?", retryable: false, effect: "none" }
        : { ok: true, data: { op: "command", completion: "sync", history: "recorded" } };
    });
    const w = mountDockHistory(control, {
      ...BOTH,
      commands: [{ name: "session", kind: "builtin", policy: "confirm" }],
    });
    await sendSlash(w, "/session");
    expect(useCmdHistory("agent-a").placeholders).toHaveLength(0);
    expect(w.find(".command-confirm").exists()).toBe(true);
    await w.find(".command-confirm-run").trigger("click");
    await flush();
    const runs = calls.filter((c) => c.method === "runCommand");
    expect(runs).toHaveLength(2);
    const idA = (runs[0]?.args[3] as { id?: string }).id;
    const idB = (runs[1]?.args[3] as { id?: string; confirm?: boolean }).id;
    expect(idA).not.toBe(idB);
    expect((runs[1]?.args[3] as { confirm?: boolean }).confirm).toBe(true);
    expect(useCmdHistory("agent-a").placeholders).toHaveLength(1);
  });

  it("historyMode OFF (hub cap missing) ⇒ legacy CommandResult path untouched", async () => {
    const { control } = fakeControl(() => ({
      ok: true,
      data: {
        op: "command",
        kind: "builtin",
        completion: "sync",
        output: { entries: [{ kind: "text", text: "sess-1" }] },
      },
    }));
    const w = mountDockHistory(control, { hubCaps: [], features: ["cmd.history.v1"], commands: COMMANDS });
    await sendSlash(w, "/session");
    await w.vm.$nextTick();
    expect(w.find(".command-result").exists()).toBe(true);
    expect(w.find(".command-result").text()).toContain("sess-1");
    expect(useCmdHistory("agent-a").placeholders).toHaveLength(0); // no placeholder in legacy mode
  });

  it("historyMode OFF (agent feature missing) ⇒ legacy too", async () => {
    const { control } = fakeControl(() => ({
      ok: true,
      data: { op: "command", completion: "sync", output: { entries: [{ kind: "text", text: "x" }] } },
    }));
    const w = mountDockHistory(control, { hubCaps: ["cmd.history.v1"], features: [], commands: COMMANDS });
    await sendSlash(w, "/session");
    await w.vm.$nextTick();
    expect(w.find(".command-result").exists()).toBe(true);
  });
});
