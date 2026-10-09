// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
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
  window.localStorage.clear(); // pwh_deliver must not leak between cases
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
  window.localStorage.clear();
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

  it("busy ⇒ Enter sends with the stored deliver default (settings page); no per-message switch", async () => {
    const steer = mountComposer({ busy: true });
    expect(steer.find(".deliver-trigger").exists()).toBe(false); // DeliverSwitch retired (2026-10)
    await steer.find("textarea").setValue("steer this");
    await steer.find("textarea").trigger("keydown", { key: "Enter" });
    expect(steer.emitted("send")).toEqual([["steer this", "steer"]]); // unset storage ⇒ fallback steer

    window.localStorage.setItem("pwh_deliver", "followUp"); // settings page stored followUp
    const queued = mountComposer({ busy: true });
    await queued.find("textarea").setValue("queued for later");
    await queued.find("textarea").trigger("keydown", { key: "Enter" });
    expect(queued.emitted("send")).toEqual([["queued for later", "followUp"]]);
  });

  it("busy placeholder follows the stored deliver default (acceptance P2)", async () => {
    const steer = mountComposer({ busy: true });
    expect(steer.find("textarea").attributes("placeholder")).toBe("Interject this turn…");

    window.localStorage.setItem("pwh_deliver", "followUp");
    const queued = mountComposer({ busy: true });
    expect(queued.find("textarea").attributes("placeholder")).toBe("Queue a follow-up…");
    expect(queued.find("textarea").attributes("aria-label")).toBe("Queue a follow-up…");
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

  it("2026-10-09: the cmd badge sits at the head of the sub row, never before the input card (no width jitter)", async () => {
    const w = mountComposer({ view: cmdView() });
    await w.find("textarea").setValue("/se");
    expect(w.find(".composer-row .cmd-badge").exists()).toBe(false);
    const sub = w.get(".composer-sub");
    expect(sub.element.firstElementChild?.classList.contains("cmd-badge")).toBe(true);
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

describe("Composer.vue — command palette keyboard (2026-10: Tab 补全, TUI-like combobox)", () => {
  /** "s" prefix ⇒ [session, status] (descriptions empty — no description-tier hits);
   * "ses" ⇒ single match; "quit" ⇒ single DENY row; "compact" ⇒ policyBusy flips to confirm. */
  const COMMANDS = [
    { name: "session", kind: "builtin", description: "", policy: "allow", output: "captured" },
    { name: "status", kind: "builtin", description: "", policy: "allow" },
    { name: "compact", kind: "builtin", description: "", policy: "allow", policyBusy: "confirm" },
    { name: "quit", kind: "builtin", description: "", policy: "deny" },
  ];

  function mountCmd() {
    const control = fakeControl();
    const view = controlView({ commands: computed(() => COMMANDS), commandsEnabled: computed(() => true) });
    const wrapper = mount(Composer, {
      props: { enabled: true, busy: false },
      attachTo: document.body, // focus assertions need a real document position
      global: {
        provide: {
          [CONTROL_VIEW as symbol]: view,
          [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
        },
      },
    });
    mounted.push(wrapper);
    wrapper.find("textarea").element.focus();
    return wrapper;
  }

  async function type(wrapper: ReturnType<typeof mount>, value: string): Promise<void> {
    const ta = wrapper.find("textarea");
    await ta.setValue(value);
    // happy-dom does not move the caret on setValue — pin it at the end like a real typist.
    (ta.element as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
    await ta.trigger("input");
  }

  /** Raw dispatch so preventDefault is observable (test-utils `trigger` hides the event). */
  async function press(wrapper: ReturnType<typeof mount>, init: KeyboardEventInit): Promise<{ prevented: boolean }> {
    const el = wrapper.find("textarea").element as HTMLTextAreaElement;
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...init });
    const spy = vi.spyOn(ev, "preventDefault");
    el.dispatchEvent(ev);
    await nextTick();
    await nextTick();
    return { prevented: spy.mock.calls.length > 0 };
  }

  const ta = (w: ReturnType<typeof mount>) => w.find("textarea");
  const value = (w: ReturnType<typeof mount>) => (ta(w).element as HTMLTextAreaElement).value;
  const palette = (w: ReturnType<typeof mount>) => w.find(".command-palette");
  /** aria-activedescendant of the textarea — the highlighted option id. */
  const activeDesc = (w: ReturnType<typeof mount>) => ta(w).attributes("aria-activedescendant");

  it("typing after / filters live; the highlight starts at the best match (row 0)", async () => {
    const w = mountCmd();
    await type(w, "/s");
    expect(palette(w).exists()).toBe(true);
    expect(w.findAll(".command-item").map((r) => r.find(".command-name").text())).toEqual(["/session", "/status"]);
    const sel = w.findAll(".command-item").map((r) => r.attributes("aria-selected"));
    expect(sel).toEqual(["true", "false"]);
    await type(w, "/sta");
    expect(w.findAll(".command-name").map((n) => n.text())).toEqual(["/status"]);
  });

  it("arrows move the highlight (wrapping both ways); aria-activedescendant follows the option id", async () => {
    const w = mountCmd();
    await type(w, "/s");
    const lb = palette(w).attributes("id");
    expect(lb).toBeDefined();
    expect(activeDesc(w)).toBe(`${lb}-opt-0`);
    await ta(w).trigger("keydown", { key: "ArrowDown" });
    expect(activeDesc(w)).toBe(`${lb}-opt-1`);
    await ta(w).trigger("keydown", { key: "ArrowDown" }); // wraps to the top
    expect(activeDesc(w)).toBe(`${lb}-opt-0`);
    await ta(w).trigger("keydown", { key: "ArrowUp" }); // wraps back to the bottom
    expect(activeDesc(w)).toBe(`${lb}-opt-1`);
    expect(document.activeElement).toBe(ta(w).element); // focus NEVER leaves the textarea
  });

  it("the highlight resets to the best match on every query change", async () => {
    const w = mountCmd();
    await type(w, "/s");
    await ta(w).trigger("keydown", { key: "ArrowDown" });
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-1`); // moved off row 0
    await type(w, "/sta"); // filter narrows to one row
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-0`);
    expect(w.findAll(".command-item")[0]!.classes()).toContain("active");
  });

  it("Tab completes the highlighted row: `/name `, palette hides, focus + draft stay", async () => {
    const w = mountCmd();
    await type(w, "/s");
    await ta(w).trigger("keydown", { key: "ArrowDown" }); // highlight /status
    const r = await press(w, { key: "Tab" });
    expect(r.prevented).toBe(true);
    expect(value(w)).toBe("/status ");
    expect(palette(w).exists()).toBe(false); // hidden — args come next
    expect(document.activeElement).toBe(ta(w).element); // Tab never moved focus out
    const caretNow = (ta(w).element as HTMLTextAreaElement).selectionStart;
    expect(caretNow).toBe("/status ".length); // caret after the trailing space
  });

  it("Shift+Tab moves the highlight UP (wrap); Tab then completes that row", async () => {
    const w = mountCmd();
    await type(w, "/s");
    const r = await press(w, { key: "Tab", shiftKey: true });
    expect(r.prevented).toBe(true);
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-1`); // wrapped to the last row
    await press(w, { key: "Tab" });
    expect(value(w)).toBe("/status ");
  });

  it("a single match completes on Tab", async () => {
    const w = mountCmd();
    await type(w, "/ses");
    expect(w.findAll(".command-item")).toHaveLength(1);
    await press(w, { key: "Tab" });
    expect(value(w)).toBe("/session ");
  });

  it("Tab on a denied row completes nothing but still never leaves the composer", async () => {
    const w = mountCmd();
    await type(w, "/quit");
    const r = await press(w, { key: "Tab" });
    expect(r.prevented).toBe(true);
    expect(value(w)).toBe("/quit"); // deny rows are not completable (same rule as click)
    expect(palette(w).exists()).toBe(true);
    expect(document.activeElement).toBe(ta(w).element);
  });

  it("Tab with the palette CLOSED is not prevented (native focus move, no trap)", async () => {
    const w = mountCmd();
    await type(w, "plain prompt");
    const closed = await press(w, { key: "Tab" });
    expect(closed.prevented).toBe(false);
    await type(w, "/s");
    await press(w, { key: "Escape" }); // close the palette without clearing
    const escaped = await press(w, { key: "Tab" });
    expect(escaped.prevented).toBe(false);
  });

  it("Escape hides the palette but keeps the text; name edits reopen, arg typing does not", async () => {
    const w = mountCmd();
    await type(w, "/s");
    const r = await press(w, { key: "Escape" });
    expect(r.prevented).toBe(true);
    expect(palette(w).exists()).toBe(false);
    expect(value(w)).toBe("/s"); // Esc never clears
    await type(w, "/sta"); // name token changed ⇒ reopens
    expect(palette(w).exists()).toBe(true);
  });

  it("after a Tab completion, typing args keeps the palette hidden; editing the name reopens it", async () => {
    const w = mountCmd();
    await type(w, "/ses");
    await press(w, { key: "Tab" });
    expect(value(w)).toBe("/session ");
    await type(w, "/session --json"); // args after the completed `/name ` token
    expect(palette(w).exists()).toBe(false);
    await type(w, "/sessio"); // backspaced into the name token
    expect(palette(w).exists()).toBe(true);
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-0`); // fresh highlight
  });

  it("IME composition never triggers completion/navigation (isComposing / keyCode 229)", async () => {
    const w = mountCmd();
    await type(w, "/s");
    await press(w, { key: "Tab", isComposing: true });
    expect(value(w)).toBe("/s"); // not completed — the key belongs to the IME candidate window
    expect(palette(w).exists()).toBe(true);
    await ta(w).trigger("keydown", { key: "ArrowDown", keyCode: 229 });
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-0`); // highlight unmoved
    await ta(w).trigger("keydown", { key: "Enter", keyCode: 229 });
    expect(w.emitted("send")).toBeUndefined();
  });

  it("Enter keeps the current behaviour: executes the typed command (not the highlight)", async () => {
    const w = mountCmd();
    await type(w, "/session"); // fully typed; palette open with one row
    await ta(w).trigger("keydown", { key: "ArrowDown" }); // harmless wrap to the same row
    await ta(w).trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toEqual([["/session", "steer"]]);
  });

  it("textarea carries the combobox aria wiring only while the palette is visible", async () => {
    const w = mountCmd();
    await type(w, "/s");
    const attrs = ta(w).attributes();
    expect(attrs["role"]).toBe("combobox");
    expect(attrs["aria-expanded"]).toBe("true");
    expect(attrs["aria-controls"]).toBe(palette(w).attributes("id"));
    expect(attrs["aria-activedescendant"]).toBe(activeDesc(w));
    await press(w, { key: "Escape" });
    const closed = ta(w).attributes();
    expect(closed["role"]).toBeUndefined();
    expect(closed["aria-expanded"]).toBeUndefined();
    expect(closed["aria-controls"]).toBeUndefined();
    expect(closed["aria-activedescendant"]).toBeUndefined();
  });

  it("click still completes through the same path (and hides the palette); hover moves the highlight", async () => {
    const w = mountCmd();
    await type(w, "/s");
    await w.findAll(".command-item")[1]!.trigger("mousemove");
    expect(activeDesc(w)).toBe(`${palette(w).attributes("id")}-opt-1`); // mouse + keyboard share one highlight
    await w.findAll(".command-item")[1]!.trigger("click");
    expect(value(w)).toBe("/status ");
    expect(palette(w).exists()).toBe(false);
    expect(document.activeElement).toBe(ta(w).element); // pick refocuses the textarea
  });
});

describe("Composer.vue — inline StopButton (2026-10 user request: stop lives inside the input edge)", () => {
  function abortingControl(calls: Array<{ method: string; args: readonly unknown[] }>): ControlHandle {
    const base = fakeControl();
    return {
      ...base,
      abort: ((key: string) => {
        calls.push({ method: "abort", args: [key] });
        return Promise.resolve({ ok: true as const });
      }) as ControlHandle["abort"],
    };
  }

  it("busy + CONTROL_VIEW with control ⇒ stop button renders INSIDE .composer-input", async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const w = mountComposer({ busy: true, view: controlView({ control: abortingControl(calls) }) });
    const wrap = w.find(".composer-input");
    expect(wrap.exists()).toBe(true);
    expect(wrap.find(".stop-btn").exists()).toBe(true);
  });

  it("busy ⇒ the card carries .busy (呼吸动画挂钩); idle ⇒ it does not", async () => {
    const busyW = mountComposer({ busy: true, view: controlView({ control: abortingControl([]) }) });
    expect(busyW.find(".composer-input").classes()).toContain("busy");
    const idleW = mountComposer({ view: controlView({ control: abortingControl([]) }) });
    expect(idleW.find(".composer-input").classes()).not.toContain("busy");
  });

  it("two-step click ⇒ view.control.abort(view.agentKey) — the dock's old channel, unchanged", async () => {
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const w = mountComposer({ busy: true, view: controlView({ control: abortingControl(calls) }) });
    await w.find(".stop-btn").trigger("click"); // arm
    expect(calls).toEqual([]);
    await w.find(".stop-btn").trigger("click"); // confirm
    expect(calls).toEqual([{ method: "abort", args: ["agent-a"] }]);
  });

  it("idle ⇒ no stop button; no CONTROL_VIEW (or null control) ⇒ no stop button even when busy", async () => {
    const idle = mountComposer({ busy: false, view: controlView({ control: fakeControl() }) });
    expect(idle.find(".stop-btn").exists()).toBe(false);
    const noView = mountComposer({ busy: true });
    expect(noView.find(".stop-btn").exists()).toBe(false);
    const nullCtl = mountComposer({ busy: true, view: controlView({ control: null }) });
    expect(nullCtl.find(".stop-btn").exists()).toBe(false);
  });
});

describe("Composer.vue — input CARD: chips + ring bottom row (2026-10 user-picked mock option 1 + collapse refinement)", () => {
  const session = {
    sessionId: "s1",
    model: { provider: "zai", id: "glm-5" },
    models: {
      status: "ok",
      items: [{ provider: "zai", id: "glm-5" }],
      total: 1,
      levels: ["low", "high"],
      policy: { model: "allow", thinking: "allow" },
      sampledAt: 1,
    },
  };
  const chipView = () =>
    controlView({
      agent: computed(() => ({ pendingCtl: [], session }) as unknown as AgentState),
      commandsEnabled: computed(() => true),
    });

  it("bottom row renders when the switcher is present: chips left + ring host right, INSIDE the card", () => {
    const w = mountComposer({ view: chipView() });
    const input = w.find(".composer-input");
    expect(input.exists()).toBe(true);
    // Card structure: textarea on top, `.composer-bottom` below it, both inside the card.
    const kids = Array.from(input.element.children) as HTMLElement[];
    expect(kids[0]!.tagName).toBe("TEXTAREA");
    expect(kids[1]!.classList.contains("composer-bottom")).toBe(true);
    const bottom = w.find(".composer-bottom");
    expect(bottom.find(".composer-chips .model-switcher button.model-chip").exists()).toBe(true);
    expect(bottom.find(".composer-chips .thinking-chip-host").exists()).toBe(true);
    // Chips are the row's left cell (first child); ContextRing is mounted into the row's right end.
    const bottomKids = Array.from(bottom.element.children) as HTMLElement[];
    expect(bottomKids[0]!.classList.contains("composer-chips")).toBe(true);
  });

  it("typing collapses the row: chips get .chips-off AND the card gets .has-text; clearing restores both", async () => {
    const w = mountComposer({ view: chipView() });
    const chips = () => w.find(".composer-chips");
    const card = () => w.find(".composer-input");
    expect(chips().classes()).not.toContain("chips-off"); // empty ⇒ visible
    expect(card().classes()).not.toContain("has-text"); // empty ⇒ bottom row expanded
    await w.find("textarea").setValue("hello");
    expect(chips().classes()).toContain("chips-off"); // content ⇒ hidden
    expect(card().classes()).toContain("has-text"); // content ⇒ row collapses + ring re-anchors
    await w.find("textarea").setValue("");
    expect(chips().classes()).not.toContain("chips-off"); // cleared ⇒ visible again
    expect(card().classes()).not.toContain("has-text");
  });

  it("no CONTROL_VIEW ⇒ ModelSwitcher self-hides: the bottom row stays (CSS-collapsed) with an empty chips host", () => {
    const w = mountComposer({});
    expect(w.find(".composer-bottom").exists()).toBe(true);
    expect(w.find(".composer-chips").exists()).toBe(true);
    expect(w.find(".composer-chips .model-switcher").exists()).toBe(false);
    expect(w.find(".model-chip").exists()).toBe(false);
  });

  it("control.css pins: the card carries border/radius/background; the textarea is borderless with NO chip reserve", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/control.css"), "utf8");
    const rule = (sel: string): string =>
      new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css)?.[1] ?? "";
    const card = rule(".composer-input");
    expect(card).toMatch(/border:\s*1px solid var\(--c-border-strong\)/);
    expect(card).toMatch(/border-radius:\s*var\(--r-md\)/);
    expect(card).toMatch(/background:\s*var\(--c-surface\)/);
    const ta = rule(".composer textarea");
    expect(ta).toMatch(/border:\s*0/);
    expect(ta).toMatch(/background:\s*transparent/);
    // The 5cc081d top-left overlay's constant 22px padding-top reserve is GONE (padding is normal now).
    expect(rule(".composer-input:has(.composer-chips .model-switcher) textarea")).toBe("");
    expect(css).not.toMatch(/padding-top:\s*22px/);
    // Focus indication moved from the (now borderless) textarea to the card.
    expect(rule(".composer textarea:focus-visible")).toBe("");
    expect(rule(".composer-input:focus-within")).toMatch(/border-color:\s*var\(--c-focus\)/);
    expect(rule(".composer-input:focus-within")).not.toMatch(/outline:/); // 2026-10-06: single ring only
    // The chips host is in-flow now (no absolute overlay), but keeps its hide transition.
    expect(rule(".composer-chips")).not.toMatch(/position:\s*absolute/);
    expect(rule(".composer-chips")).toMatch(/transition:/);
    const off = rule(".composer-chips.chips-off");
    expect(off).toMatch(/opacity:\s*0/);
    expect(off).toMatch(/visibility:\s*hidden/);
    expect(off).toMatch(/pointer-events:\s*none/);
  });

  it("control.css pins: the bottom row is COLLAPSED by default and expands only when the switcher rendered AND the input is empty", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/control.css"), "utf8");
    const rule = (sel: string): string =>
      new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css)?.[1] ?? "";
    // Base = collapsed (no dead strip while typing / no-control fallback), with a height transition.
    const base = rule(".composer-bottom");
    expect(base).toMatch(/max-height:\s*0/);
    expect(base).toMatch(/transition:\s*max-height/);
    // No overflow:hidden — it would clip the absolutely-positioned ring the collapsed row still contains.
    expect(base).not.toMatch(/overflow/);
    // Expanded tier: gated on BOTH conditions, so the no-control fallback never grows a row.
    const expanded = rule(".composer-input:has(.model-switcher):not(.has-text) .composer-bottom");
    expect(expanded).not.toBe("");
    expect(expanded).toMatch(/max-height:\s*\d+px/);
    expect(expanded).not.toMatch(/max-height:\s*0;/);
  });

  it("control.css pins: the ring re-anchors to its absolute mid-right geometry in every collapsed state", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/control.css"), "utf8");
    // Base `.ctx-ring` stays the pre-card overlay: absolute, right edge, vertically centered
    // (applies whenever the bottom row is collapsed — typing OR no switcher).
    const ring = /^\.ctx-ring\s*\{[^}]*\}/m.exec(css)?.[0] ?? "";
    expect(ring).toMatch(/position:\s*absolute/);
    expect(ring).toMatch(/right:\s*var\(--sp-1\)/);
    expect(ring).toMatch(/top:\s*0/);
    expect(ring).toMatch(/bottom:\s*0/);
    expect(ring).toMatch(/align-items:\s*center/);
    // The ONLY in-flow placement is the expanded tier (switcher rendered + input empty):
    // position:relative (not static) so the details panel / queue note keep anchoring to it.
    const inFlow =
      /\.composer-input:has\(\.model-switcher\):not\(\.has-text\) \.composer-bottom \.ctx-ring\s*\{([^}]*)\}/.exec(
        css,
      )?.[1] ?? "";
    expect(inFlow).toMatch(/position:\s*relative/);
    // No other rule may pull `.ctx-ring` into flow (narrow media blocks stay clean).
    expect(css).not.toMatch(/\.ctx-ring\s*\{[^}]*position:\s*static/);
  });

  it("control.css pins: the textarea's 32px ring slot is CONSTANT — not scoped to either ring placement", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/control.css"), "utf8");
    const rule = (sel: string): string =>
      new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css)?.[1] ?? "";
    expect(rule(".composer-input:has(.ctx-ring) textarea")).toMatch(/padding-right:\s*32px/);
    // No state-scoped variant may exist — the slot must not change when the row collapses
    // (text would reflow horizontally otherwise).
    expect(css).not.toMatch(/\.has-text[^,{]*textarea\s*\{[^}]*padding-right/);
    expect(css).not.toMatch(/:not\(\.has-text\)[^,{]*textarea\s*\{[^}]*padding-right/);
  });
});
