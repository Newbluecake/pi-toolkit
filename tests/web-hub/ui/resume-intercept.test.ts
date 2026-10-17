// @vitest-environment happy-dom
/**
 * web-resume plan v2 §4 P3 — the ALWAYS-LOADED surface: Composer's §2.6 sendGate (intent ∧
 * available ∧ empty tray ⇒ ok; deny stays deny otherwise), the palette decoration
 * (`decoratePalette` wiring), DetailDock's onSend FIRST-line intercept, DetailHeader's D7
 * 「恢复」 button gating (the detail-header-clear test pattern), AgentDetail's RESUME_DIALOG
 * host + lazy mount, and the dialog-unmount-on-unmount path (the privacy-relock half, F10).
 */
import { mount, flushPromises } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { RESUME_DIALOG } from "../../../src/web-hub/ui/src/logic/resume.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => setLangOverride("zh"));
// The assertions pin the zh dictionaries (the product default here) — pin the language in
// beforeEach (afterEach resets the shared override for the other suites) so they hold
// regardless of the host browser language vitest inherits.
afterEach(() => {
  resetLangForTests();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function fakeControl(over: Partial<ControlHandle> = {}): ControlHandle {
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop,
    steerSub: noop,
    stopSub: noop,
    answerDialog: noop,
    cancelDialog: noop,
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
    ...over,
  };
}

interface ViewOver {
  features?: string[];
  busy?: boolean;
  commandsEnabled?: boolean;
  commands?: readonly Record<string, unknown>[];
  session?: Record<string, unknown>;
}

function fakeView(
  over: ViewOver = {},
  control = fakeControl(),
): { view: ControlView; agent: ReturnType<typeof ref<AgentState>> } {
  const agent = ref({
    key: "agent-a",
    card: { agentKey: "agent-a", control: true, state: "live" },
    down: false,
    pendingCtl: [],
    prompts: [],
    fleet: [],
    session: over.session ?? { sessionId: "sess-1", cwd: "/w" },
    status: { busy: over.busy ?? false, ...(over.features !== undefined ? { features: over.features } : {}) },
    commands: over.commands ?? [],
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => over.busy ?? false),
    commands: computed(() => over.commands ?? []),
    commandsEnabled: computed(() => over.commandsEnabled ?? false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  return { view, agent };
}

const RESUME_ON = ["resume.v1"];
const COMMANDS: readonly Record<string, unknown>[] = [
  { name: "resume", description: "", policy: "deny", output: "terminal" },
  { name: "resume-recent", description: "", policy: "deny" },
  { name: "other", description: "", policy: "confirm" },
];

// ---------------------------------------------------------------------------
// Composer — sendGate + palette
// ---------------------------------------------------------------------------

async function sendButtonState(text: string, over: ViewOver): Promise<boolean> {
  const { view } = fakeView(over);
  const w = mount(Composer, {
    props: { enabled: true, busy: over.busy ?? false },
    global: { provide: { [CONTROL_VIEW as symbol]: view } },
  });
  mounted.push(w);
  await w.find("textarea").setValue(text);
  return !(w.find("button[data-send]").attributes("disabled") !== undefined);
}

describe("Composer sendGate (§2.6 intent ∧ available ∧ empty tray)", () => {
  it("available: /resume and /resume --all pass despite the advertised deny", async () => {
    expect(await sendButtonState("/resume", { features: RESUME_ON, commandsEnabled: true, commands: COMMANDS })).toBe(
      true,
    );
    expect(
      await sendButtonState("/resume-recent --all", { features: RESUME_ON, commandsEnabled: true, commands: COMMANDS }),
    ).toBe(true);
  });

  it("unavailable (old agent): /resume stays blocked by the deny policy — golden old behaviour", async () => {
    expect(await sendButtonState("/resume", { commandsEnabled: true, commands: COMMANDS })).toBe(false);
  });

  it("available but no commands slot: /resume is plain text and passes", async () => {
    expect(await sendButtonState("/resume", { features: RESUME_ON, commandsEnabled: false })).toBe(true);
  });

  it("another denied command is still blocked when resume is available", async () => {
    expect(
      await sendButtonState("/denied", {
        features: RESUME_ON,
        commandsEnabled: true,
        commands: [...COMMANDS, { name: "denied", policy: "deny" }],
      }),
    ).toBe(false);
  });

  it("bare resume always passes (it is plain text)", async () => {
    expect(await sendButtonState("resume", { features: RESUME_ON })).toBe(true);
    expect(await sendButtonState("resume --all", {})).toBe(true);
  });
});

describe("Composer palette decoration (§2.6 decoratePalette wiring)", () => {
  it("available: the /resume row renders runnable (no aria-disabled) with the description", async () => {
    const { view } = fakeView({ features: RESUME_ON, commandsEnabled: true, commands: COMMANDS });
    const w = mount(Composer, {
      props: { enabled: true },
      global: { provide: { [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(w);
    await w.find("textarea").setValue("/res");
    const row = w.find(".command-item");
    expect(row.exists()).toBe(true);
    expect(row.attributes("aria-disabled")).toBeUndefined();
    expect(row.text()).toContain("恢复会话");
  });

  it("unavailable: the /resume row stays denied with no description override", async () => {
    const { view } = fakeView({ commandsEnabled: true, commands: COMMANDS });
    const w = mount(Composer, {
      props: { enabled: true },
      global: { provide: { [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(w);
    await w.find("textarea").setValue("/res");
    const row = w.find(".command-item");
    expect(row.attributes("aria-disabled")).toBe("true");
    expect(row.text()).not.toContain("恢复会话");
  });
});

// ---------------------------------------------------------------------------
// DetailDock — the onSend FIRST line
// ---------------------------------------------------------------------------

function mountDock(over: ViewOver, host: { open: (i: { scope: string }) => void } | null) {
  const calls: string[] = [];
  const control = fakeControl({
    sendPrompt: ((key: string, text: string) => {
      calls.push(`prompt:${text}`);
      return Promise.resolve({ ok: true });
    }) as ControlHandle["sendPrompt"],
    runCommand: ((key: string, name: string, args: string) => {
      calls.push(`cmd:${name}:${args}`);
      return Promise.resolve({ ok: true });
    }) as ControlHandle["runCommand"],
  });
  const { view } = fakeView(over, control);
  const w = mount(DetailDock, {
    props: { following: true, newCount: 0 },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
        [RESUME_DIALOG as symbol]: host,
      },
    },
  });
  mounted.push(w);
  return { w, calls };
}

async function dockSend(w: ReturnType<typeof mount>, text: string): Promise<void> {
  await w.find(".composer textarea").setValue(text);
  await w.find(".composer textarea").trigger("keydown", { key: "Enter" });
  await flushPromises();
}

describe("DetailDock onSend intercept (§2.6 first line)", () => {
  it.each([
    ["resume", "recent"],
    ["resume --all", "all"],
    ["/resume", "recent"],
    ["/resume-recent --all", "all"],
  ])("%j ⇒ open({scope:%j}), nothing sent", async (text, scope) => {
    const open = vi.fn();
    const { w, calls } = mountDock({ features: RESUME_ON, commandsEnabled: true, commands: COMMANDS }, { open });
    await dockSend(w, text);
    expect(open).toHaveBeenCalledWith({ scope });
    expect(calls).toEqual([]); // neither sendPrompt nor runCommand
  });

  it("unavailable ⇒ falls through to the normal prompt path (old behaviour)", async () => {
    const open = vi.fn();
    const { w, calls } = mountDock({}, { open }); // no features, no commands slot
    await dockSend(w, "resume");
    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual(["prompt:resume"]);
  });

  it("unavailable + command slot ⇒ /resume still hits the deny branch (nothing sent)", async () => {
    const open = vi.fn();
    const { w, calls } = mountDock({ commandsEnabled: true, commands: COMMANDS }, { open });
    await dockSend(w, "/resume");
    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("no host (standalone mount) ⇒ the intent degrades to the prompt path", async () => {
    const { w, calls } = mountDock({ features: RESUME_ON }, null);
    await dockSend(w, "resume");
    expect(calls).toEqual(["prompt:resume"]);
  });
});

// ---------------------------------------------------------------------------
// DetailHeader — the D7 「恢复」 button
// ---------------------------------------------------------------------------

function mountHeader(features?: string[], enabled = true) {
  const open = vi.fn();
  const { view } = fakeView(features !== undefined ? { features } : {});
  const view2: ControlView = { ...view, enabled: computed(() => enabled), commandsEnabled: computed(() => enabled) };
  const w = mount(DetailHeader, {
    props: { agent: view.agent.value, narrow: false },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view2,
        [RESUME_DIALOG as symbol]: { open },
      },
    },
  });
  mounted.push(w);
  return { w, open };
}

describe("DetailHeader D7 button gating (clear-button pattern + resume.v1)", () => {
  it("renders when clear-gating ∧ features carry resume.v1; click opens recent", async () => {
    const { w, open } = mountHeader(["resume.v1"]);
    const btn = w.find(".detail-resume-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.get(".head-btn-label").text()).toBe("恢复"); // visible label; aria-label unchanged
    expect(btn.get(".head-btn-label").attributes("aria-hidden")).toBe("true");
    await btn.trigger("click");
    expect(open).toHaveBeenCalledWith({ scope: "recent" });
  });

  it("absent without the feature (old agent)", () => {
    expect(mountHeader(undefined).w.find(".detail-resume-btn").exists()).toBe(false);
    expect(mountHeader(["other.v1"]).w.find(".detail-resume-btn").exists()).toBe(false);
  });

  it("absent when the control surface is off (same gating as clear)", () => {
    expect(mountHeader(["resume.v1"], false).w.find(".detail-resume-btn").exists()).toBe(false);
  });

  it("renders next to the clear button (both present together)", () => {
    const { w } = mountHeader(["resume.v1"]);
    expect(w.find(".detail-clear-btn").exists()).toBe(true);
    expect(w.find(".detail-resume-btn").exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentDetail — the RESUME_DIALOG host + lazy mount + unmount-with-parent (F10 relock half)
// ---------------------------------------------------------------------------

function mountDetail(features?: string[]) {
  // AgentDetail's own lazy import loads the REAL ResumeDialog chunk; the assertion below
  // targets the host contract end-to-end (provide + v-if + teleport + parent unmount).
  const agent = ref({
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
    status: { busy: false, ...(features !== undefined ? { features } : {}) },
  } as unknown as AgentState);
  const control = fakeControl();
  const hub: HubHandle = {
    state: ref({ control: true } as unknown as HubState) as HubHandle["state"],
    control,
    dispatch: () => {},
  };
  const w = mount(AgentDetail, {
    props: { agent: agent.value, now: 1_000, narrow: false },
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
  mounted.push(w);
  return { w, agent };
}

describe("AgentDetail RESUME_DIALOG host (§2.6)", () => {
  it("open() mounts the lazy dialog; parent unmount removes it (relock half, F10)", async () => {
    const { w } = mountDetail(["resume.v1"]);
    // The dialog host's v-if child is the LAZY component. Drive the header button (D7),
    // which injects the same host AgentDetail provides, then verify the teleported dialog
    // appears — and that unmounting AgentDetail (what a privacy relock does to the pane)
    // removes it with the parent (F10).
    const btn = w.find(".detail-resume-btn");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();
    const inBody = () => document.body.querySelectorAll(".picker-scrim").length;
    expect(inBody()).toBeGreaterThan(0);
    w.unmount();
    expect(inBody()).toBe(0);
    expect(document.querySelectorAll(".resume-stub").length).toBe(0);
  });
});
