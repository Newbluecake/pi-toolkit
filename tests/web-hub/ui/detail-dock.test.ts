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
  window.localStorage.clear();
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
  fleet?: readonly unknown[];
  session?: Record<string, unknown>;
}

function fakeView(control: ControlHandle, over: ViewOver = {}): { view: ControlView; agent: { value: AgentState } } {
  const agent = ref({
    pendingCtl: over.pendingCtl ?? [],
    queue: over.queue ?? [],
    prompts: [],
    fleet: over.fleet ?? [],
    ...(over.session !== undefined ? { session: over.session } : {}),
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

  it("control ON ⇒ composer + queue list; Follow switch retired (2026-10), Latest jump kept", () => {
    const { control } = fakeControl();
    const w = mountDock(control, {
      queue: [{ id: "q1", text: "queued", deliver: "steer", source: "web", cmdId: "c1", at: 1 }],
    });
    expect(w.find(".composer").exists()).toBe(true);
    expect(w.find(".queue-list").exists()).toBe(true);
    expect(w.find(".switch").exists()).toBe(false); // auto-follow is symmetric; jump-latest covers manual
  });

  it("jump-to-latest still renders in BOTH dock branches when behind (following=false, newCount>0)", () => {
    const { control } = fakeControl();
    const on = mountDock(control, {}, { following: false, newCount: 3 });
    expect(on.find(".jump-latest").exists()).toBe(true);
    const off = mountDock(
      control,
      { enabled: false, readonlyReason: "control.dockReadonlyHub" },
      { following: false, newCount: 3 },
    );
    expect(off.find(".jump-latest").exists()).toBe(true);
    expect(off.find(".switch").exists()).toBe(false);
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

  it("inline StopButton (inside Composer since 2026-10) ⇒ abort; queue retry/discard ⇒ control.retry/discard", async () => {
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

describe("DetailDock.vue — @mention send routing (task #11)", () => {
  const fleet = [
    { runId: "r1", label: "bot", status: "running", terminal: false },
    { runId: "r2", label: "old", status: "completed", terminal: true },
  ];

  it("`@running-label msg` ⇒ steerSub with the STRIPPED message (never sendPrompt)", async () => {
    const { control, calls } = fakeControl();
    const w = mountDock(control, { fleet, busy: true });
    await w.find(".composer textarea").setValue("@bot please rebase");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls).toEqual([{ method: "steerSub", args: ["agent-a", "r1", "please rebase"] }]);
  });

  it("idle (not busy) still steers — interjecting IS the steer semantics", async () => {
    const { control, calls } = fakeControl();
    const w = mountDock(control, { fleet, busy: false });
    await w.find(".composer textarea").setValue("@bot ping");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["steerSub"]);
  });

  it("terminal label / unknown label ⇒ plain sendPrompt with the raw text", async () => {
    const { control, calls } = fakeControl();
    const w = mountDock(control, { fleet });
    for (const text of ["@old hi", "@ghost hi"]) {
      await w.find(".composer textarea").setValue(text);
      await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    }
    await flush();
    expect(calls).toEqual([
      { method: "sendPrompt", args: ["agent-a", "@old hi", "steer"] },
      { method: "sendPrompt", args: ["agent-a", "@ghost hi", "steer"] },
    ]);
  });

  it("bare `@label` (no message): Enter COMPLETES while the panel is open; Esc then Enter sends raw", async () => {
    const { control, calls } = fakeControl();
    const w = mountDock(control, { fleet });
    await w.find(".composer textarea").setValue("@bot");
    const ta = w.find(".composer textarea");
    (ta.element as HTMLTextAreaElement).setSelectionRange(4, 4);
    await ta.trigger("input");
    await ta.trigger("keydown", { key: "Enter" }); // panel open ⇒ pick, not send
    expect((ta.element as HTMLTextAreaElement).value).toBe("@bot ");
    expect(calls).toEqual([]);
    // restore the bare form and dismiss: now Enter sends the raw text (TUI parity)
    await ta.setValue("@bot");
    (ta.element as HTMLTextAreaElement).setSelectionRange(4, 4);
    await ta.trigger("input");
    await ta.trigger("keydown", { key: "Escape" });
    await ta.trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls).toEqual([{ method: "sendPrompt", args: ["agent-a", "@bot", "steer"] }]);
  });

  it("slash command mode still wins over mention routing (disjoint prefixes, pinned)", async () => {
    const commands = [{ name: "bot", kind: "skill", policy: "allow" }];
    const { control, calls } = fakeControl(() => ({
      ok: true,
      data: { op: "command", completion: "sync", output: null },
    }));
    const w = mountDock(control, { fleet, commands, commandsEnabled: true });
    await w.find(".composer textarea").setValue("/bot do it");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["runCommand"]);
  });

  it("steerSub failure stays on the standard path: no crash, no sendPrompt fallback", async () => {
    const { control, calls } = fakeControl(() => ({
      ok: false,
      error: "E_NOT_RUNNING",
      retryable: false,
      effect: "none" as const,
    }));
    const w = mountDock(control, { fleet, busy: true });
    await w.find(".composer textarea").setValue("@bot too late");
    await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(calls).toEqual([{ method: "steerSub", args: ["agent-a", "r1", "too late"] }]);
  });
});

describe("DetailDock.vue — model/thinking chips inside the composer input (2026-10: 放进输入框)", () => {
  const models = {
    status: "ok",
    items: [{ provider: "zai", id: "glm-5" }],
    total: 1,
    policy: { model: "allow", thinking: "allow" },
    sampledAt: 1,
  };
  const session = {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
    model: { provider: "zai", id: "glm-5" },
    models,
  };

  it("control ON + command cap ⇒ chips INSIDE .composer-input; the old .dock-tools strip is gone", () => {
    const { control } = fakeControl();
    const w = mountDock(control, { commandsEnabled: true, session });
    expect(w.find(".dock-tools").exists()).toBe(false); // superseded (2026-10 user request)
    const chips = w.find(".composer-input .composer-chips");
    expect(chips.exists()).toBe(true);
    expect(chips.find(".model-switcher button.model-chip").exists()).toBe(true);
    expect(chips.find(".model-chip").text()).toContain("glm-5");
    expect(chips.find(".thinking-chip-host").exists()).toBe(true);
  });

  it("control ON but no session.models (old agent) ⇒ read-only chip; command cap missing ⇒ empty chips host", () => {
    const { control } = fakeControl();
    const oldAgent = mountDock(control, {
      commandsEnabled: true,
      session: { ...session, models: undefined },
    });
    expect(oldAgent.find(".composer-chips .model-chip-static").exists()).toBe(true);
    expect(oldAgent.find(".composer-chips button.model-chip").exists()).toBe(false);

    const noCap = mountDock(control, { commandsEnabled: false, session });
    expect(noCap.find(".composer-chips .model-switcher").exists()).toBe(false);
  });

  it("read-only dock branch ⇒ no composer, no chips at all", () => {
    const { control } = fakeControl();
    const w = mountDock(control, { enabled: false, readonlyReason: "control.dockReadonlyHub" });
    expect(w.find(".dock-tools").exists()).toBe(false);
    expect(w.find(".composer-chips").exists()).toBe(false);
    expect(w.find(".model-switcher").exists()).toBe(false);
  });

  it("notExecuted command retry re-sends with the item's OWN args (§R addendum: /model keeps its argument)", async () => {
    const pendingCtl = [{ id: "n2", kind: "command", name: "model", args: "zai/glm-5", state: "notExecuted", at: 0 }];
    const { control, calls } = fakeControl(() => ({ ok: true, data: { completion: "sync" } }));
    const w = mountDock(control, { pendingCtl });
    await w.find(".queue-actions .btn").trigger("click"); // resend
    await flush();
    const run = calls.find((c) => c.method === "runCommand");
    expect(run).toBeDefined();
    expect(run!.args.slice(0, 3)).toEqual(["agent-a", "model", "zai/glm-5"]);
    expect(calls.some((c) => c.method === "discard" && c.args[1] === "n2")).toBe(true);
  });
});
