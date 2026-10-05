// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` @mention completion (web-hub task #11): a line-initial `@` opens a
 * panel of the session's RUNNING sub-agents (fleet rows, `status === "running"` only — a
 * queued/terminal row would steer into a guaranteed E_NOT_RUNNING). Typing prefix-filters,
 * Enter/click inserts `@label `, arrows navigate, Esc/outside-pointerdown closes, and a
 * session with no running sub-agents never pops the panel. After a pick the composer behaves
 * exactly as before (Enter emits the full `@label msg` text; DetailDock owns the routing).
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
  stubMatchMedia(false);
  window.localStorage.clear();
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

interface FleetRow {
  runId: string;
  label?: string;
  status: string;
  terminal: boolean;
}

const RUNNING: readonly FleetRow[] = [
  { runId: "r1", label: "bot", status: "running", terminal: false },
  { runId: "r2", label: "builder", status: "running", terminal: false },
  { runId: "r3", label: "old", status: "completed", terminal: true },
  { runId: "r4", status: "running", terminal: false }, // label-less: unmentionable
];

function controlView(fleet: readonly unknown[], over: Partial<ControlView> = {}): ControlView {
  const agent = ref({ pendingCtl: [], fleet } as unknown as AgentState);
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
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountComposer(fleet: readonly unknown[] = RUNNING) {
  const ctx = { agentKey: "agent-a", control: fakeControl(), enabled: true };
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false },
    attachTo: document.body,
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: controlView(fleet),
        [CONTROL_CTX as symbol]: ctx,
      },
    },
  });
  mounted.push(wrapper);
  return { wrapper, ctx };
}

async function type(wrapper: ReturnType<typeof mount>, value: string): Promise<void> {
  const ta = wrapper.find("textarea");
  await ta.setValue(value);
  // happy-dom does not move the caret on setValue — pin it at the end like a real typist.
  (ta.element as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
  await ta.trigger("input");
}

const PANEL = ".mention-panel";

describe("Composer @mention panel (task #11)", () => {
  it("line-initial `@` opens the panel listing RUNNING sub-agents only", async () => {
    const { wrapper } = mountComposer();
    expect(wrapper.find(PANEL).exists()).toBe(false);
    await type(wrapper, "@");
    const items = wrapper.findAll(".mention-item");
    expect(items.map((i) => i.find(".mention-label").text())).toEqual(["@bot", "@builder"]); // no "old", no label-less
  });

  it("no running sub-agents ⇒ `@` never pops the panel", async () => {
    const { wrapper } = mountComposer([{ runId: "r9", label: "done", status: "completed", terminal: true }]);
    await type(wrapper, "@");
    expect(wrapper.find(PANEL).exists()).toBe(false);
  });

  it("no fleet data at all ⇒ `@` never pops the panel", async () => {
    const { wrapper } = mountComposer([]);
    await type(wrapper, "@b");
    expect(wrapper.find(PANEL).exists()).toBe(false);
  });

  it("typing prefix-filters (case-insensitive); no match ⇒ empty line, panel stays open", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@BU");
    expect(wrapper.findAll(".mention-item").map((i) => i.find(".mention-label").text())).toEqual(["@builder"]);
    await type(wrapper, "@zzz");
    expect(wrapper.findAll(".mention-item")).toHaveLength(0);
    expect(wrapper.find(".mention-empty").exists()).toBe(true);
  });

  it("Enter picks the first row: `@label ` lands in the textarea, panel closes, draft persists", async () => {
    const { wrapper, ctx } = mountComposer();
    await type(wrapper, "@b");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("@bot ");
    expect(wrapper.find(PANEL).exists()).toBe(false);
    expect(wrapper.emitted("send")).toBeUndefined(); // pick, not send
    expect(ctx.control.drafts.get("agent-a")).toBe("@bot ");
  });

  it("arrow keys move the active row (wrapping); Enter picks the active one", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@");
    await wrapper.find("textarea").trigger("keydown", { key: "ArrowUp" }); // wraps to the last row
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("@builder ");
  });

  it("click picks that row", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@");
    await wrapper.findAll(".mention-item")[1]!.trigger("click");
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("@builder ");
    expect(wrapper.find(PANEL).exists()).toBe(false);
  });

  it("Esc closes; typing reopens", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@b");
    await wrapper.find("textarea").trigger("keydown", { key: "Escape" });
    expect(wrapper.find(PANEL).exists()).toBe(false);
    await type(wrapper, "@bo");
    expect(wrapper.find(PANEL).exists()).toBe(true);
  });

  it("pointerdown outside the composer closes the panel", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@");
    expect(wrapper.find(PANEL).exists()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(PANEL).exists()).toBe(false);
  });

  it("a space ends the token: panel closes and Enter sends the raw text (no steer here)", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@bot run it");
    expect(wrapper.find(PANEL).exists()).toBe(false);
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toEqual([["@bot run it", "steer"]]);
  });

  it("full flow: pick, type the message, Enter emits the complete `@label msg` text", async () => {
    const { wrapper } = mountComposer();
    await type(wrapper, "@b");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" }); // ⇒ "@bot "
    const ta = wrapper.find("textarea");
    await ta.setValue("@bot please rebase");
    (ta.element as HTMLTextAreaElement).setSelectionRange(17, 17);
    await ta.trigger("input");
    await ta.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toEqual([["@bot please rebase", "steer"]]);
    expect((ta.element as HTMLTextAreaElement).value).toBe(""); // cleared like any send
  });
});
