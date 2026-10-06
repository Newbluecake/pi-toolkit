// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThinkingChip from "../../../src/web-hub/ui/src/components/control/ThinkingChip.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/ThinkingChip.vue` (web-model-switch plan v2 §5.1/§5.4/§6, package M3b — §9 M3b
 * row, A11): the read-only gates (levels absent / `["off"]` / old agent), `/thinking <level>`
 * execution with a caller-generated cmdId (same exact-tracking channel as the model chip),
 * the §6 clamp note converging identically for BOTH session-frame arrival orders, policy
 * confirm/deny, and the narrow-viewport PickerSheet form factor.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
let origMatchMedia: typeof window.matchMedia | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (origMatchMedia !== undefined) {
    window.matchMedia = origMatchMedia;
    origMatchMedia = undefined;
  }
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const LEVELS = ["off", "min", "low", "high", "max"];

function modelsWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    items: [],
    total: 0,
    levels: LEVELS,
    policy: { model: "allow", thinking: "allow" },
    sampledAt: 1700000000000,
    ...over,
  };
}

function sessionWith(models: Record<string, unknown> | undefined, thinkingLevel?: string): Record<string, unknown> {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
    model: { provider: "openai", id: "gpt-5" },
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(models !== undefined ? { models } : {}),
  };
}

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(handler?: (method: string, args: readonly unknown[]) => CmdOutcome): {
  control: ControlHandle;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(handler?.(method, args) ?? { ok: true, data: { completion: "sync" } });
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
      query: invoke("query") as ControlHandle["query"],
      retry: invoke("retry") as ControlHandle["retry"],
      discard: invoke("discard") as unknown as ControlHandle["discard"],
      draft: () => "",
      setDraft: () => {},
    },
  };
}

interface ViewOver {
  enabled?: boolean;
  busy?: boolean;
  commandsEnabled?: boolean;
  session?: Record<string, unknown>;
}

/** Two-step harness (agent ref exists first so a control fake can close over it). */
function harness(over: ViewOver = {}): {
  agent: { value: AgentState };
  mountWith(control: ControlHandle): ReturnType<typeof mount>;
} {
  const agent = ref({
    session: over.session ?? sessionWith(modelsWith(), "high"),
    pendingCtl: [],
    ctl: [],
    queue: [],
    prompts: [],
    fleet: [],
  } as unknown as AgentState);
  const mountWith = (control: ControlHandle): ReturnType<typeof mount> => {
    const view: ControlView = {
      agentKey: "agent-a",
      control,
      enabled: computed(() => over.enabled ?? true),
      readonlyReason: computed(() => null),
      agent: computed(() => agent.value),
      busy: computed(() => over.busy ?? false),
      commands: computed(() => []),
      commandsEnabled: computed(() => over.commandsEnabled ?? true),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    };
    const wrapper = mount(ThinkingChip, {
      attachTo: document.body,
      global: { provide: { [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(wrapper);
    return wrapper;
  };
  return { agent: agent as { value: AgentState }, mountWith };
}

function mountChip(
  control: ControlHandle,
  over: ViewOver = {},
): { wrapper: ReturnType<typeof mount>; agent: { value: AgentState } } {
  const h = harness(over);
  return { wrapper: h.mountWith(control), agent: h.agent };
}

function stubNarrow(matches: boolean): void {
  if (origMatchMedia === undefined) origMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe("ThinkingChip.vue — visibility + read-only gates (§5.4 ⑤, A11)", () => {
  it("①②③ mirror the model chip: control off / command cap missing ⇒ renders nothing", () => {
    const { control } = fakeControl();
    const off = mountChip(control, { enabled: false });
    expect(off.wrapper.find(".thinking-chip-host").exists()).toBe(false);
    const noCap = mountChip(control, { commandsEnabled: false });
    expect(noCap.wrapper.find(".thinking-chip-host").exists()).toBe(false);
  });

  it("④ old agent (no session.models): static chip only when a thinkingLevel exists; nothing otherwise", () => {
    const { control } = fakeControl();
    const withLevel = mountChip(control, { session: sessionWith(undefined, "high") });
    const chip = withLevel.wrapper.find(".model-chip-static");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain("high");
    expect(withLevel.wrapper.find("button.model-chip").exists()).toBe(false);
    expect(chip.attributes("title")).toBe("Update pi-toolkit to pick thinking levels here — or type /thinking <level>");

    const noLevel = mountChip(control, { session: sessionWith(undefined) });
    expect(noLevel.wrapper.find(".thinking-chip-host").exists()).toBe(false);
  });

  it("levels absent ⇒ read-only with the no-levels tooltip; ['off'] ⇒ read-only unsupported (never derived locally, #2)", () => {
    const { control } = fakeControl();
    const noLevels = mountChip(control, { session: sessionWith(modelsWith({ levels: undefined }), "high") });
    const a = noLevels.wrapper.find(".model-chip-static");
    expect(a.exists()).toBe(true);
    expect(a.attributes("title")).toBe("Thinking levels not reported — update pi-toolkit, or type /thinking <level>");

    const offOnly = mountChip(control, { session: sessionWith(modelsWith({ levels: ["off"] }), "off") });
    const b = offOnly.wrapper.find(".model-chip-static");
    expect(b.exists()).toBe(true);
    expect(b.text()).toContain("off");
    expect(b.attributes("title")).toBe("This model doesn't support thinking levels");
  });

  it("normal: [sparkle] {level} ▾ chip; click opens the level listbox with the current row selected", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountChip(control);
    const chip = wrapper.find("button.model-chip");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain("high");
    await chip.trigger("click");
    const list = wrapper.find("ul.thinking-list");
    expect(list.exists()).toBe(true);
    expect(list.attributes("role")).toBe("listbox");
    const rows = wrapper.findAll(".thinking-row");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.attributes("aria-selected"))).toEqual(["false", "false", "false", "true", "false"]);
    expect(rows[3]!.text()).toContain("current");
    // desktop popover focuses the listbox (no search box on this chip at all)
    expect(document.activeElement).toBe(list.element);
  });
});

describe("ThinkingChip.vue — /thinking execution (§5.2 exact id, §6 clamp)", () => {
  it("pick ⇒ runCommand(key, 'thinking', level, {id}); sync ok closes the panel", async () => {
    const { control, calls } = fakeControl();
    const { wrapper } = mountChip(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click"); // max
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("agent-a");
    expect(calls[0]!.args[1]).toBe("thinking");
    expect(calls[0]!.args[2]).toBe("max");
    expect((calls[0]!.args[3] as { id: string }).id).toMatch(ID_RE);
    expect(wrapper.find("ul.thinking-list").exists()).toBe(false);
    expect(wrapper.find(".model-note").exists()).toBe(false); // no clamp note while awaiting
  });

  it("pick the CURRENT level ⇒ no command sent, panel just closes", async () => {
    const { control, calls } = fakeControl();
    const { wrapper } = mountChip(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[3]!.trigger("click"); // high = current
    await flush();
    expect(calls.filter((c) => c.method === "runCommand")).toHaveLength(0);
    expect(wrapper.find("ul.thinking-list").exists()).toBe(false);
  });

  it("clamp, frame AFTER cmd_result (order B): session frame with a different level ⇒ 'clamped to {level}' once", async () => {
    const { agent, mountWith } = harness();
    const { control } = fakeControl();
    const wrapper = mountWith(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click"); // request max
    await flush();
    expect(wrapper.find(".model-note-clamp").exists()).toBe(false);
    // the proving session frame arrives clamped (pi capped max → low for this model)
    agent.value = { ...agent.value, session: sessionWith(modelsWith(), "low") } as AgentState;
    await flush();
    const note = wrapper.find(".model-note-clamp");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("clamped to low");
    // chip itself always renders the latest session frame as truth (§6)
    expect(wrapper.find("button.model-chip").text()).toContain("low");
    await note.find(".model-note-x").trigger("click");
    expect(wrapper.find(".model-note-clamp").exists()).toBe(false);
  });

  it("clamp, frame BEFORE cmd_result (order A) ⇒ the SAME note after the settle window", async () => {
    vi.useFakeTimers();
    const { agent, mountWith } = harness();
    // production ordering possibility: the session frame lands before the cmd_result resolves
    const control: ControlHandle = {
      ...fakeControl().control,
      runCommand: (key: string, name: string, args: string, opts?: { confirm?: true; id?: string }) => {
        agent.value = { ...agent.value, session: sessionWith(modelsWith(), "low") } as AgentState;
        return Promise.resolve({ ok: true, data: { completion: "sync" } });
      },
    };
    const wrapper = mountWith(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click"); // request max
    await flush();
    expect(wrapper.find(".model-note-clamp").exists()).toBe(false); // settle window still open
    await vi.advanceTimersByTimeAsync(4_100); // CLAMP_SETTLE_MS elapsed ⇒ judge with current level
    await flush();
    expect(wrapper.find(".model-note-clamp").text()).toContain("clamped to low");
  });

  it("no clamp: the frame confirming the requested level ⇒ no note, no error", async () => {
    const { agent, mountWith } = harness();
    const { control } = fakeControl();
    const wrapper = mountWith(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click"); // max
    await flush();
    agent.value = { ...agent.value, session: sessionWith(modelsWith(), "max") } as AgentState;
    await flush();
    expect(wrapper.find(".model-note-clamp").exists()).toBe(false);
    expect(wrapper.find(".model-note-error").exists()).toBe(false);
    expect(wrapper.find("button.model-chip").text()).toContain("max");
  });

  it("frame arrival ORDER does not change the outcome (§6): both orders render the same chip + note", async () => {
    // order B: result first, frame second — drive one chip through it
    const b = harness();
    const wb = b.mountWith(fakeControl().control);
    await wb.find("button.model-chip").trigger("click");
    await wb.findAll(".thinking-row")[4]!.trigger("click");
    await flush();
    b.agent.value = { ...b.agent.value, session: sessionWith(modelsWith(), "low") } as AgentState;
    await flush();
    const chipB = wb.find("button.model-chip").text();
    const noteB = wb.find(".model-note-clamp").text();

    // order A: frame first (inside runCommand), result second, settle window judges
    vi.useFakeTimers();
    const a = harness();
    const controlA: ControlHandle = {
      ...fakeControl().control,
      runCommand: () => {
        a.agent.value = { ...a.agent.value, session: sessionWith(modelsWith(), "low") } as AgentState;
        return Promise.resolve({ ok: true, data: { completion: "sync" } });
      },
    };
    const wa = a.mountWith(controlA);
    await wa.find("button.model-chip").trigger("click");
    await wa.findAll(".thinking-row")[4]!.trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(4_100);
    await flush();
    expect(wa.find("button.model-chip").text()).toBe(chipB);
    expect(wa.find(".model-note-clamp").text()).toBe(noteB);
  });

  it("sync failure ⇒ §5.2 code mapping (E_BAD_REQUEST = unknown level); × dismisses", async () => {
    const { control } = fakeControl(() => ({ ok: false, error: "E_BAD_REQUEST", retryable: false, effect: "none" }));
    const { wrapper } = mountChip(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click");
    await flush();
    const note = wrapper.find(".model-note-error");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("Unknown thinking level");
    await note.find(".model-note-x").trigger("click");
    expect(wrapper.find(".model-note-error").exists()).toBe(false);
  });
});

describe("ThinkingChip.vue — policy (§5.2, execution result overrides pre-judgement #18)", () => {
  it("policy confirm ⇒ inline confirm; confirm re-issues with a NEW id + confirm:true", async () => {
    const { control, calls } = fakeControl();
    const { wrapper } = mountChip(control, {
      session: sessionWith(modelsWith({ policy: { model: "allow", thinking: "confirm" } }), "high"),
    });
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".thinking-row")[4]!.trigger("click");
    await flush();
    expect(calls).toHaveLength(0);
    const confirm = wrapper.find(".model-confirm");
    expect(confirm.text()).toContain("Set thinking to max?");
    await confirm.find(".btn-primary").trigger("click");
    await flush();
    expect(calls).toHaveLength(1);
    const opts = calls[0]!.args[3] as { confirm?: boolean; id: string };
    expect(opts.confirm).toBe(true);
    expect(opts.id).toMatch(ID_RE);
  });

  it("policy deny ⇒ disabled chip with policy tooltip; shadowed ⇒ shadowed tooltip", () => {
    const { control } = fakeControl();
    const denied = mountChip(control, {
      session: sessionWith(modelsWith({ policy: { model: "allow", thinking: "deny" } }), "high"),
    });
    const chip = denied.wrapper.find("button.model-chip");
    expect(chip.attributes("disabled")).toBeDefined();
    expect(chip.attributes("title")).toBe("Thinking level switching is disabled by webCommandPolicy");

    const shadowed = mountChip(control, {
      session: sessionWith(
        modelsWith({ policy: { model: "allow", thinking: "deny" }, shadowed: { thinking: true } }),
        "high",
      ),
    });
    expect(shadowed.wrapper.find("button.model-chip").attributes("title")).toBe(
      "/thinking is shadowed by an extension command — set levels in the terminal",
    );
  });
});

describe("ThinkingChip.vue — narrow viewport bottom sheet (§5.1 M3b, A10)", () => {
  it("desktop thinking popover pins min(360px) (2026-10 widening — the model panel carries the shell)", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/models.css"), "utf8");
    const panel = css.match(/\.thinking-panel \{([\s\S]*?)\n\}/);
    expect(panel).not.toBeNull();
    expect(panel![1]).toContain("width: min(360px, calc(100vw - 2 * var(--sp-4)))");
  });

  it("≤640px: opens as a Teleport'd PickerSheet; busy footnote inside; scrim close returns focus", async () => {
    stubNarrow(true);
    const { control } = fakeControl();
    const { wrapper } = mountChip(control, { busy: true });
    const chip = wrapper.find("button.model-chip");
    (chip.element as HTMLButtonElement).focus();
    await chip.trigger("click");
    await flush();
    const sheet = document.body.querySelector(".picker-sheet");
    expect(sheet).not.toBeNull();
    expect(wrapper.find(".model-panel").exists()).toBe(false); // no desktop popover
    expect(sheet!.querySelectorAll(".thinking-row")).toHaveLength(5);
    expect(sheet!.textContent).toContain("Current reply is unaffected; later requests use the new level");
    // listbox (data-autofocus) got the focus — never a search box (none on this chip)
    expect(document.activeElement).toBe(sheet!.querySelector("ul.thinking-list"));
    expect(document.body.style.overflow).toBe("hidden");
    document.body
      .querySelector<HTMLElement>(".picker-scrim")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(chip.element);
  });
});
