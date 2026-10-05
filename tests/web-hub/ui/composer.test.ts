// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` (control-plan.md v2.1 §7.4/§7.7 — C5): key map (Enter / Shift+Enter /
 * Alt+Enter / IME / coarse pointer), per-agent draft persistence through `CONTROL_CTX`, command
 * mode gating (deny never emits; sendAsText falls back to a plain prompt).
 */

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false); // fine pointer by default; the coarse test re-stubs
});

function fakeControl(): ControlHandle & { drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    drafts,
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop as ControlHandle["abort"],
    steerSub: noop as ControlHandle["steerSub"],
    stopSub: noop as ControlHandle["stopSub"],
    answerDialog: noop as ControlHandle["answerDialog"],
    cancelDialog: noop as ControlHandle["cancelDialog"],
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k) => drafts.get(k) ?? "",
    setDraft: (k, t) => void drafts.set(k, t),
  };
}

function controlView(over: Partial<ControlView> = {}): ControlView {
  const agent = ref({ pendingCtl: [] } as unknown as AgentState);
  return {
    agentKey: "agent-a",
    control: null,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
    ...over,
  };
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountComposer(opts: {
  busy?: boolean;
  view?: ControlView;
  ctx?: { agentKey: string; control: ControlHandle; enabled: boolean };
}) {
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: opts.busy ?? false },
    global: {
      provide: {
        ...(opts.view ? { [CONTROL_VIEW as symbol]: opts.view } : {}),
        ...(opts.ctx ? { [CONTROL_CTX as symbol]: opts.ctx } : {}),
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("Composer.vue key map (§7.4)", () => {
  it("Enter sends in the current mode (idle ⇒ prompt deliver=steer)", async () => {
    const w = mountComposer({});
    await w.find("textarea").setValue("hello there");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toEqual([["hello there", "steer"]]);
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe(""); // cleared on send
  });

  it("busy ⇒ Enter sends with the DeliverSwitch mode (default steer), switchable to followUp", async () => {
    const w = mountComposer({ busy: true });
    expect(w.find(".deliver-trigger").exists()).toBe(true);
    await w.find("textarea").setValue("steer this");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    await w.find("textarea").setValue("queued for later");
    await w.find(".deliver-trigger").trigger("click"); // open the dropdown
    await w.findAll(".deliver-item")[1]!.trigger("click"); // Follow-up
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toEqual([
      ["steer this", "steer"],
      ["queued for later", "followUp"],
    ]);
  });

  it("Shift+Enter inserts a newline and never sends", async () => {
    const w = mountComposer({});
    const ta = w.find("textarea");
    await ta.setValue("line one");
    await ta.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(w.emitted("send")).toBeUndefined();
  });

  it("Alt+Enter sends as followUp (TUI 同键)", async () => {
    const w = mountComposer({ busy: true });
    await w.find("textarea").setValue("after this turn");
    await w.find("textarea").trigger("keydown", { key: "Enter", altKey: true });
    expect(w.emitted("send")).toEqual([["after this turn", "followUp"]]);
  });

  it("IME composition (keyCode 229 / isComposing) never sends", async () => {
    const w = mountComposer({});
    await w.find("textarea").setValue("中文");
    await w.find("textarea").trigger("keydown", { key: "Enter", keyCode: 229 });
    await w.find("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    expect(w.emitted("send")).toBeUndefined();
  });

  it("coarse pointer: Enter sends (the soft keyboard's 发送 button keeps its enterkeyhint promise)", async () => {
    stubMatchMedia(true);
    const w = mountComposer({});
    await w.find("textarea").setValue("mobile text");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toEqual([["mobile text", "steer"]]);
  });

  it("send button is disabled with empty text / while a pendingCtl item is sending", async () => {
    const view = controlView({ sending: computed(() => true) });
    const w = mountComposer({ view });
    expect(w.find("[data-send]").attributes("disabled")).toBeDefined();
    await w.find("textarea").setValue("typed but in-flight");
    expect(w.find("[data-send]").attributes("disabled")).toBeDefined();
  });
});

describe("Composer.vue drafts (§7.1)", () => {
  it("persists drafts per agentKey via CONTROL_CTX and restores on mount", async () => {
    const control = fakeControl();
    const ctx = { agentKey: "agent-a", control, enabled: true };
    const w = mountComposer({ ctx });
    await w.find("textarea").setValue("half-written thought");
    expect(control.draft("agent-a")).toBe("half-written thought");
    w.unmount();

    const w2 = mountComposer({ ctx });
    expect((w2.find("textarea").element as HTMLTextAreaElement).value).toBe("half-written thought");
    await w2.find("textarea").trigger("keydown", { key: "Enter" });
    expect(control.draft("agent-a")).toBe(""); // cleared after a successful send
  });
});

describe("Composer.vue command mode (§7.7)", () => {
  const commands = [
    { name: "session", kind: "builtin", description: "Show session info", policy: "allow", output: "captured" },
    { name: "quit", kind: "builtin", description: "Exit pi", policy: "deny" },
  ];
  const cmdView = () =>
    controlView({
      commands: computed(() => commands),
      commandsEnabled: computed(() => true),
    });

  it("/ text with a commands slot enters command mode (cmd badge + palette)", async () => {
    const w = mountComposer({ view: cmdView() });
    await w.find("textarea").setValue("/se");
    expect(w.find(".cmd-badge").exists()).toBe(true);
    expect(w.find(".command-palette").exists()).toBe(true);
    expect(w.text()).toContain("/session");
  });

  it("a denied command never emits (palette shows the reason instead)", async () => {
    const w = mountComposer({ view: cmdView() });
    await w.find("textarea").setValue("/quit");
    expect(w.text()).toContain("Terminal only");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toBeUndefined();
    expect(w.find("[data-send]").attributes("disabled")).toBeDefined();
  });

  it("// prefix or the send-as-text toggle falls back to a plain prompt", async () => {
    const w = mountComposer({ view: cmdView() });
    await w.find("textarea").setValue("//session");
    expect(w.find(".cmd-badge").exists()).toBe(false);
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toEqual([["//session", "steer"]]);

    await w.find("textarea").setValue("/session");
    expect(w.find(".cmd-badge").exists()).toBe(true);
    await w.find(".send-as-text input").setValue(true);
    expect(w.find(".cmd-badge").exists()).toBe(false);
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")![1]).toEqual(["/session", "steer"]);
  });

  it("palette pick fills the composer", async () => {
    const w = mountComposer({ view: cmdView() });
    await w.find("textarea").setValue("/s");
    await w.find(".command-item").trigger("click");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("/session ");
  });
});
