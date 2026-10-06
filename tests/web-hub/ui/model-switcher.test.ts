// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelSwitcher from "../../../src/web-hub/ui/src/components/control/ModelSwitcher.vue";
import { clampPopoverX } from "../../../src/web-hub/ui/src/composables/usePopoverClamp.js";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/ModelSwitcher.vue` (web-model-switch plan v2 §5, package M3a): the §5.4 four-state
 * table, chip/popover interaction, exact-id switch tracking (§5.2), confirm/deny policy, and
 * the narrow-viewport full-width panel CSS rule. The v1 wire shape is IMPORTED from M1's
 * frozen fixture (#19 — never copied).
 */

function fixture(name: string): Record<string, unknown> {
  // happy-dom's URL polyfill mishandles file: base URLs — resolve via import.meta.dirname.
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "../../fixtures/web-hub-models", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}

const V1_MODELS = fixture("v1-session"); // zai/glm-5 (scoped) + openai/gpt-5; policy model=allow

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function sessionWith(models: Record<string, unknown> | undefined, model?: { provider: string; id: string }) {
  return {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
    model: model ?? { provider: "openai", id: "gpt-5" },
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
      return Promise.resolve(handler?.(method, args) ?? { ok: true, data: {} });
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
  readonlyReason?: string | null;
  busy?: boolean;
  commandsEnabled?: boolean;
  session?: Record<string, unknown>;
  pendingCtl?: readonly Record<string, unknown>[];
  ctl?: readonly Record<string, unknown>[];
}

/** Two-step harness: the agent ref exists FIRST so a control fake can close over it (the
 * production ordering — optimistic pendingCtl item before the outcome — needs that). */
function harness(over: ViewOver = {}): {
  agent: { value: AgentState };
  mountWith(control: ControlHandle): ReturnType<typeof mount>;
} {
  const agent = ref({
    session: over.session ?? sessionWith(V1_MODELS),
    pendingCtl: over.pendingCtl ?? [],
    ctl: over.ctl ?? [],
    queue: [],
    prompts: [],
    fleet: [],
  } as unknown as AgentState);
  const mountWith = (control: ControlHandle): ReturnType<typeof mount> => {
    const view: ControlView = {
      agentKey: "agent-a",
      control,
      enabled: computed(() => over.enabled ?? true),
      readonlyReason: computed(() => over.readonlyReason ?? null),
      agent: computed(() => agent.value),
      busy: computed(() => over.busy ?? false),
      commands: computed(() => []),
      commandsEnabled: computed(() => over.commandsEnabled ?? true),
      sending: computed(() => false),
      queueItems: computed(() => []),
      isWebMessage: () => false,
    };
    const wrapper = mount(ModelSwitcher, {
      attachTo: document.body, // real focus paths (activeElement) need a connected tree
      global: { provide: { [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(wrapper);
    return wrapper;
  };
  return { agent: agent as { value: AgentState }, mountWith };
}

function mountSwitcher(
  control: ControlHandle,
  over: ViewOver = {},
): { wrapper: ReturnType<typeof mount>; agent: { value: AgentState } } {
  const h = harness(over);
  return { wrapper: h.mountWith(control), agent: h.agent };
}

/** runCommand fake that mirrors the production ordering: the optimistic pendingCtl item lands
 * BEFORE the outcome resolves (createControl dispatches ctl_send synchronously). */
function asyncSwitchControl(calls: Call[], agent: { value: AgentState }): ControlHandle {
  return {
    ...fakeControl().control,
    runCommand: (key: string, name: string, args: string, opts?: { confirm?: true; id?: string }) => {
      calls.push({ method: "runCommand", args: [key, name, args, opts] });
      agent.value = {
        ...agent.value,
        pendingCtl: [{ id: opts?.id, kind: "command", name, state: "sending", at: 0 }],
      } as AgentState;
      return Promise.resolve({ ok: true, data: { completion: "async" } });
    },
  };
}

describe("ModelSwitcher.vue — §5.4 four-state table (A12/A13)", () => {
  it("① control off (hub/agent read-only) ⇒ renders nothing", () => {
    const { control } = fakeControl();
    for (const readonlyReason of ["control.dockReadonlyHub", "control.dockReadonlyAgent"]) {
      const { wrapper } = mountSwitcher(control, { enabled: false, readonlyReason });
      expect(wrapper.find(".model-switcher").exists()).toBe(false);
    }
  });

  it("② agent offline ⇒ renders nothing", () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control, { enabled: false, readonlyReason: "control.dockReadonlyOffline" });
    expect(wrapper.find(".model-switcher").exists()).toBe(false);
  });

  it("③ command cap missing ⇒ renders nothing", () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control, { commandsEnabled: false });
    expect(wrapper.find(".model-switcher").exists()).toBe(false);
  });

  it("④ old agent (no session.models) ⇒ read-only chip: current short label, no chevron, tooltip", () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control, { session: sessionWith(undefined) });
    const chip = wrapper.find(".model-chip-static");
    expect(chip.exists()).toBe(true);
    expect(wrapper.find("button.model-chip").exists()).toBe(false);
    expect(chip.text()).toContain("gpt-5");
    expect(chip.attributes("title")).toBe("Update pi-toolkit to pick models here — or type /model provider/id");
  });

  it("⑤ normal ⇒ chip with short label + provider/id tooltip (A1); click opens the panel", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    const chip = wrapper.find("button.model-chip");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain("gpt-5");
    expect(chip.attributes("title")).toBe("openai/gpt-5");
    expect(chip.attributes("aria-expanded")).toBe("false");
    await chip.trigger("click");
    expect(wrapper.find(".model-panel").exists()).toBe(true);
    expect(chip.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".model-foot").text()).toContain("snapshot");
  });
});

describe("ModelSwitcher.vue — panel content (§5.1, A2)", () => {
  it("scoped tab by default (scoped items only, user order); all tab groups by provider", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    const tabs = wrapper.findAll(".model-tabs button");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.text()).toBe("scoped");
    expect(tabs[0]!.attributes("aria-selected")).toBe("true");
    // default scoped tab: only zai/glm-5
    let rows = wrapper.findAll(".model-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("glm-5");
    // all tab: both, grouped (two providers ⇒ two sticky group headers)
    await tabs[1]!.trigger("click");
    expect(wrapper.findAll(".model-group").map((g) => g.text())).toEqual(["zai", "openai"]);
    rows = wrapper.findAll(".model-row");
    expect(rows).toHaveLength(2);
    // current row: check + selected; ctx/reasoning badges on gpt-5
    const gpt = rows[1]!;
    expect(gpt.attributes("aria-selected")).toBe("true");
    expect(gpt.text()).toContain("400k");
    expect(gpt.text()).toContain("R");
  });

  it("search filters by provider/id/name case-insensitively; empty result note", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-tabs button")[1]!.trigger("click"); // all
    await wrapper.find(".model-search").setValue("GLM 5");
    expect(wrapper.findAll(".model-row")).toHaveLength(1);
    await wrapper.find(".model-search").setValue("nothing-matches");
    expect(wrapper.findAll(".model-row")).toHaveLength(0);
    expect(wrapper.find(".model-empty").text()).toBe("No matching model");
  });

  it("current model NOT in the list ⇒ pinned current row on top", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control, {
      session: sessionWith(V1_MODELS, { provider: "acme", id: "acme-1" }),
    });
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-tabs button")[1]!.trigger("click"); // all
    const first = wrapper.findAll(".model-row")[0]!;
    expect(first.text()).toContain("acme-1");
    expect(first.text()).toContain("current");
    expect(first.attributes("aria-selected")).toBe("true");
  });

  it("status empty ⇒ 'No models with credentials'; status error ⇒ banner + readable items", async () => {
    const { control } = fakeControl();
    const empty = mountSwitcher(control, {
      session: sessionWith({ ...V1_MODELS, status: "empty", items: [], total: 0 }),
    });
    await empty.wrapper.find("button.model-chip").trigger("click");
    expect(empty.wrapper.find(".model-empty").text()).toBe("No models with credentials");

    const err = mountSwitcher(control, {
      session: sessionWith({ ...V1_MODELS, status: "error", invalid: 1, omitted: 3 }),
    });
    await err.wrapper.find("button.model-chip").trigger("click");
    expect(err.wrapper.find(".model-banner").text()).toBe("Couldn't read the full model list");
    expect(err.wrapper.find(".model-foot").text()).toContain("+3 omitted");
    expect(err.wrapper.find(".model-foot").text()).toContain("1 invalid");
  });

  it("busy footnote (Q4/#8 wording) only while busy", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control, { busy: true });
    await wrapper.find("button.model-chip").trigger("click");
    expect(wrapper.find(".model-busy").text()).toBe("Current reply is unaffected; later requests use the new model");
  });

  it("Esc from inside the panel closes it; outside click closes it too", async () => {
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.find(".model-search").trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".model-panel").exists()).toBe(false);
    await wrapper.find("button.model-chip").trigger("click");
    expect(wrapper.find(".model-panel").exists()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".model-panel").exists()).toBe(false);
  });
});

describe("ModelSwitcher.vue — switch execution + exact-id tracking (§5.2, A3/A14)", () => {
  it("pick ⇒ runCommand(key, 'model', 'provider/id', {id}); panel closes; chip goes pending", async () => {
    const calls: Call[] = [];
    const { agent, mountWith } = harness();
    const wrapper = mountWith(asyncSwitchControl(calls, agent));
    await wrapper.find("button.model-chip").trigger("click");
    const row = wrapper.findAll(".model-row")[0]!; // scoped tab by default ⇒ zai/glm-5
    expect(row.text()).toContain("glm-5");
    await row.trigger("click");
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("agent-a");
    expect(calls[0]!.args[1]).toBe("model");
    expect(calls[0]!.args[2]).toBe("zai/glm-5");
    const opts = calls[0]!.args[3] as { id: string };
    expect(opts.id).toMatch(ID_RE);
    expect(wrapper.find(".model-panel").exists()).toBe(false);
    expect(wrapper.find(".model-chip .model-spin").exists()).toBe(true); // pending loader
    expect(wrapper.find(".model-chip").text()).toContain("glm-5"); // optimistic target label
  });

  it("pick the CURRENT model ⇒ no command sent, panel just closes", async () => {
    const { control, calls } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-tabs button")[1]!.trigger("click"); // all
    const current = wrapper.findAll(".model-row")[1]!; // gpt-5
    expect(current.attributes("aria-selected")).toBe("true");
    await current.trigger("click");
    await flush();
    expect(calls.filter((c) => c.method === "runCommand")).toHaveLength(0);
    expect(wrapper.find(".model-panel").exists()).toBe(false);
  });

  it("converges to idle via session.model reaching the target (proof of execution)", async () => {
    const calls: Call[] = [];
    const { agent, mountWith } = harness();
    const wrapper = mountWith(asyncSwitchControl(calls, agent));
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(true);
    // the next session frame reports the new model ⇒ back to idle, chip label = new model
    agent.value = {
      ...agent.value,
      pendingCtl: [],
      session: sessionWith(V1_MODELS, { provider: "zai", id: "glm-5" }),
    } as AgentState;
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(false);
    expect(wrapper.find(".model-chip").text()).toContain("glm-5");
  });

  it("20s without a conclusion ⇒ unknown (A14): '?' chip, note + check, auto query once, resend barred", async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const { agent, mountWith } = harness();
    const ctlBase = asyncSwitchControl(calls, agent);
    const queried: string[] = [];
    const wrapper = mountWith({
      ...ctlBase,
      query: (key: string, id: string) => {
        queried.push(id);
        return Promise.resolve({ ok: false, error: "E_UNKNOWN_ID", retryable: false } as CmdOutcome);
      },
    });
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(21_000);
    await flush();
    expect(wrapper.find(".model-chip").text()).toContain("?");
    const note = wrapper.find(".model-note-unknown");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("Not confirmed yet");
    const sentId = (calls[0]!.args[3] as { id: string }).id;
    expect(queried).toEqual([sentId]); // auto queryOnly ONCE on entering unknown
    // manual check button queries again with the same id
    await wrapper.find(".model-note-check").trigger("click");
    await flush();
    expect(queried).toEqual([sentId, sentId]);
    // unknown bars a second send: rows are aria-disabled and clicks are ignored
    await wrapper.find("button.model-chip").trigger("click");
    const rows = wrapper.findAll(".model-row");
    expect(rows[0]!.attributes("aria-disabled")).toBe("true");
    await rows[0]!.trigger("click");
    await flush();
    expect(calls.filter((c) => c.method === "runCommand")).toHaveLength(1);
  });

  it("sync failure ⇒ error note with the §5.2 code mapping; × dismisses", async () => {
    const { control, calls } = fakeControl(() => ({
      ok: false,
      error: "E_BAD_REQUEST",
      retryable: false,
      effect: "none",
    }));
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(calls).toHaveLength(1);
    const note = wrapper.find(".model-note-error");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("Model not found — the list may be out of date");
    await wrapper.find(".model-note-x").trigger("click");
    expect(wrapper.find(".model-note-error").exists()).toBe(false);
  });

  it("session switch drops tracking back to idle", async () => {
    const calls: Call[] = [];
    const { agent, mountWith } = harness();
    const wrapper = mountWith(asyncSwitchControl(calls, agent));
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(true);
    agent.value = {
      ...agent.value,
      session: { ...sessionWith(V1_MODELS), sessionId: "s2" },
    } as AgentState;
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(false);
  });

  it("query E_UNKNOWN_ID ⇒ pendingCtl notExecuted ⇒ '?' clears and rows send again (#verify P2)", async () => {
    vi.useFakeTimers();
    const calls: Call[] = [];
    const queried: string[] = [];
    const { agent, mountWith } = harness();
    const base = asyncSwitchControl(calls, agent);
    const wrapper = mountWith({
      ...base,
      query: (_key: string, id: string) => {
        queried.push(id);
        // what the reducer does with pendingTransition(query_result E_UNKNOWN_ID): notExecuted
        agent.value = {
          ...agent.value,
          pendingCtl: [{ id, kind: "command", name: "model", state: "notExecuted", at: 0 }],
        } as AgentState;
        return Promise.resolve({ ok: false, error: "E_UNKNOWN_ID", retryable: false } as CmdOutcome);
      },
    });
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(wrapper.find(".model-spin").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(21_000);
    await flush();
    // entering unknown fired the auto queryOnly with the tracked id, whose E_UNKNOWN_ID the
    // reducer folded into notExecuted ⇒ trackSwitch converges to idle (retry unlocked)
    const sentId = (calls[0]!.args[3] as { id: string }).id;
    expect(queried).toEqual([sentId]);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".model-chip").text()).not.toContain("?");
    expect(wrapper.find(".model-note-unknown").exists()).toBe(false);
    expect(wrapper.find(".model-chip .model-spin").exists()).toBe(false);
    // and the switcher is unlocked: rows are enabled and a pick sends again
    await wrapper.find("button.model-chip").trigger("click");
    const rows = wrapper.findAll(".model-row");
    expect(rows[0]!.attributes("aria-disabled")).toBe("false");
    await rows[0]!.trigger("click");
    await flush();
    expect(calls.filter((c) => c.method === "runCommand")).toHaveLength(2);
  });
});

describe("ModelSwitcher.vue — real focus path (#verify P1)", () => {
  it("focus chip → Enter opens (focus lands IN the panel) → ↓/Enter picks ⇒ runCommand; Esc returns focus to chip", async () => {
    const { control, calls } = fakeControl(() => ({ ok: true, data: { completion: "sync" } }));
    const { wrapper } = mountSwitcher(control);
    const chip = wrapper.find("button.model-chip");
    (chip.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(chip.element);

    // Enter on the focused chip opens the panel and moves focus into it (the search input)
    await chip.trigger("keydown", { key: "Enter" });
    await flush();
    await wrapper.vm.$nextTick();
    const search = wrapper.find(".model-search");
    expect(wrapper.find(".model-panel").exists()).toBe(true);
    expect(document.activeElement).toBe(search.element);

    // ArrowDown on the FOCUSED search input: aria-activedescendant tracks the active option
    await search.trigger("keydown", { key: "ArrowDown" });
    const firstRow = wrapper.findAll(".model-row")[0]!;
    expect(firstRow.attributes("id")).toBeTruthy();
    expect(search.attributes("aria-activedescendant")).toBe(firstRow.attributes("id"));
    expect(firstRow.classes()).toContain("active");

    // Enter picks the highlighted row through the normal send path
    await search.trigger("keydown", { key: "Enter" });
    await flush();
    const runs = calls.filter((c) => c.method === "runCommand");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args.slice(0, 3)).toEqual(["agent-a", "model", "zai/glm-5"]);
    expect(wrapper.find(".model-panel").exists()).toBe(false);

    // reopen via Space, Esc from the focused element ⇒ focus returns to the chip
    (chip.element as HTMLButtonElement).focus();
    await chip.trigger("keydown", { key: " " });
    await flush();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".model-panel").exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.find(".model-search").element);
    await wrapper.find(".model-search").trigger("keydown", { key: "Escape" });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".model-panel").exists()).toBe(false);
    expect(document.activeElement).toBe(chip.element);
  });
});

describe("ModelSwitcher.vue — policy (§5.2, A7/A8)", () => {
  const policyModels = (model: string, extra: Record<string, unknown> = {}) => ({
    ...V1_MODELS,
    policy: { model, thinking: "allow" },
    ...extra,
  });

  it("policy confirm ⇒ inline confirm in the panel; confirm re-issues with a NEW id + confirm:true (A7)", async () => {
    const { control, calls } = fakeControl(() => ({ ok: true, data: { completion: "sync" } }));
    const { wrapper } = mountSwitcher(control, { session: sessionWith(policyModels("confirm")) });
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    expect(calls).toHaveLength(0); // nothing sent before the inline confirm
    const confirm = wrapper.find(".model-confirm");
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toContain("Switch to glm-5?");
    await confirm.find(".btn-primary").trigger("click");
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[2]).toBe("zai/glm-5");
    const opts = calls[0]!.args[3] as { confirm?: boolean; id: string };
    expect(opts.confirm).toBe(true);
    expect(opts.id).toMatch(ID_RE);
  });

  it("E_CONFIRM_REQUIRED from the execution also enters the inline confirm (result overrides pre-judgement, #18)", async () => {
    let n = 0;
    const { control, calls } = fakeControl(() => {
      n += 1;
      return n === 1
        ? { ok: false, error: "E_CONFIRM_REQUIRED", message: "switching models needs confirmation", retryable: false }
        : { ok: true, data: { completion: "sync" } };
    });
    const { wrapper } = mountSwitcher(control); // policy allow, but the agent demands confirm
    await wrapper.find("button.model-chip").trigger("click");
    await wrapper.findAll(".model-row")[0]!.trigger("click");
    await flush();
    const confirm = wrapper.find(".model-confirm");
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toContain("switching models needs confirmation");
    await confirm.find(".btn-primary").trigger("click");
    await flush();
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.args[3] as { confirm?: boolean; id: string });
    expect(first!.confirm).toBeUndefined();
    expect(second!.confirm).toBe(true);
    expect(second!.id).not.toBe(first!.id); // NEW id (§5.2)
  });

  it("policy deny ⇒ chip disabled with policy tooltip; shadowed ⇒ shadowed tooltip (A8)", () => {
    const { control } = fakeControl();
    const denied = mountSwitcher(control, { session: sessionWith(policyModels("deny")) });
    const chip = denied.wrapper.find("button.model-chip");
    expect(chip.attributes("disabled")).toBeDefined();
    expect(chip.attributes("title")).toBe("Model switching is disabled by webCommandPolicy");

    const shadowed = mountSwitcher(control, {
      session: sessionWith(policyModels("deny", { shadowed: { model: true } })),
    });
    expect(shadowed.wrapper.find("button.model-chip").attributes("title")).toBe(
      "/model is shadowed by an extension command — pick models in the terminal",
    );
  });
});

describe("ModelSwitcher.vue — narrow viewport bottom sheet (§5.1 M3b, #16/A10)", () => {
  let origMatchMedia: typeof window.matchMedia | undefined;
  afterEach(() => {
    if (origMatchMedia !== undefined) {
      window.matchMedia = origMatchMedia;
      origMatchMedia = undefined;
    }
  });

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

  it("models.css pins the Teleport'd sheet shell (75vh + safe-area) and ≥44px sheet rows", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/models.css"), "utf8");
    expect(css).toContain(".picker-scrim");
    const sheet = css.match(/\.picker-sheet \{([\s\S]*?)\n\}/);
    expect(sheet).not.toBeNull();
    expect(sheet![1]).toContain("max-height: 75vh");
    expect(sheet![1]).toContain("env(safe-area-inset-bottom)");
    // the M3a full-width in-place panel is gone — ≤640px uses the Teleport'd sheet now
    const narrow = css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/);
    expect(narrow).not.toBeNull();
    expect(narrow![1]).not.toContain("position: fixed");
    expect(narrow![1]).toContain("min-height: 44px");
    // viewport decides the form factor (#16); coarse pointer only raises hit areas
    const coarse = css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/);
    expect(coarse).not.toBeNull();
    expect(coarse![1]).toContain("min-height: 44px");
    expect(css).not.toContain("v-html");
  });

  it("≤640px: opens as a Teleport'd PickerSheet — search NOT autofocused (keyboard stays down), listbox is", async () => {
    stubNarrow(true);
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    const chip = wrapper.find("button.model-chip");
    (chip.element as HTMLButtonElement).focus();
    await chip.trigger("click");
    await flush();
    const sheet = document.body.querySelector(".picker-sheet");
    expect(sheet).not.toBeNull();
    expect(wrapper.find(".model-panel").exists()).toBe(false); // no desktop popover
    // the search box exists but is NOT focused (§5.1: avoid popping the mobile keyboard);
    // focus landed on the [data-autofocus] listbox instead
    const search = sheet!.querySelector(".model-search");
    expect(search).not.toBeNull();
    expect(document.activeElement).not.toBe(search);
    expect(document.activeElement).toBe(sheet!.querySelector("ul.model-list"));
    // scroll locked while open, restored on scrim close; focus returns to the chip
    expect(document.body.style.overflow).toBe("hidden");
    document.body
      .querySelector<HTMLElement>(".picker-scrim")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(chip.element);
  });

  it("≤640px: picking a row inside the sheet still sends the switch command", async () => {
    stubNarrow(true);
    const calls: Call[] = [];
    const { agent, mountWith } = harness();
    const wrapper = mountWith(asyncSwitchControl(calls, agent));
    await wrapper.find("button.model-chip").trigger("click");
    await flush();
    const row = document.body.querySelector<HTMLElement>(".picker-sheet .model-row");
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["agent-a", "model", "zai/glm-5"]);
    expect(document.body.querySelector(".picker-sheet")).toBeNull();
  });
});

describe("ModelSwitcher.vue — widened desktop popover (2026-10 user 拍板)", () => {
  it("models.css pins the wider shell: min(720px) panel at 70vh, min(360px) thinking panel", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/web-hub/ui/src/styles/models.css"), "utf8");
    const panel = css.match(/\.model-panel \{([\s\S]*?)\n\}/);
    expect(panel).not.toBeNull();
    expect(panel![1]).toContain("width: min(720px, calc(100vw - 2 * var(--sp-4)))");
    expect(panel![1]).toContain("max-height: 70vh");
    const thinking = css.match(/\.thinking-panel \{([\s\S]*?)\n\}/);
    expect(thinking).not.toBeNull();
    expect(thinking![1]).toContain("width: min(360px, calc(100vw - 2 * var(--sp-4)))");
  });

  it("clampPopoverX shifts a viewport-overflowing panel back inside; fitting panels stay anchored", () => {
    vi.stubGlobal("innerWidth", 1000);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const rect = (l: number, r: number) =>
      ({ left: l, right: r, top: 0, bottom: 0, width: r - l, height: 0, x: l, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(el, "getBoundingClientRect");

    spy.mockReturnValue(rect(700, 1120)); // right edge past 1000 - 8 margin
    clampPopoverX(el);
    expect(el.style.left).toBe("-128px");

    spy.mockReturnValue(rect(10, 400)); // fits ⇒ inline left cleared, nothing applied
    clampPopoverX(el);
    expect(el.style.left).toBe("");

    spy.mockReturnValue(rect(-50, 700)); // left edge past the margin ⇒ shift right to it
    clampPopoverX(el);
    expect(el.style.left).toBe("58px");

    spy.mockRestore();
    el.remove();
    vi.unstubAllGlobals();
  });

  // --- vertical fit (2026-10-13: chip near the TOP of a short page ran the panel off-screen) -

  function rectOf(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it("chip near the top: flips below + caps max-height; resize re-clamps while open; close removes listeners", async () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    let chipR = rectOf(0, 30, 100, 62); // chip near the top of the page (short transcript)
    let panelR = rectOf(0, 0, 720, 400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("model-chip")) return chipR;
      if (this.classList.contains("model-panel")) return panelR;
      return rectOf(0, 0, 0, 0);
    });
    const { control } = fakeControl();
    const { wrapper } = mountSwitcher(control);
    await wrapper.find("button.model-chip").trigger("click");
    await flush();
    const panelEl = wrapper.find(".model-panel").element as HTMLElement;
    expect(panelEl.style.top).toBe("calc(100% + 6px)"); // flipped BELOW the chip
    expect(panelEl.style.bottom).toBe("auto");
    expect(panelEl.style.maxHeight).toBe("560px"); // min(0.7*800, below: 800-62-8-6=724)

    // geometry changes while open (scroll, keyboard closed): window resize re-clamps both ways
    chipR = rectOf(0, 500, 100, 532);
    panelR = rectOf(0, 0, 720, 200);
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(panelEl.style.top).toBe(""); // fits above again ⇒ CSS anchor restored
    expect(panelEl.style.maxHeight).toBe("486px"); // min(560, above: 500-8-6)

    // closing removes the listeners — a later resize is a no-op (no errors, nothing reopens)
    await wrapper.find("button.model-chip").trigger("click");
    await flush();
    chipR = rectOf(0, 30, 100, 62);
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(wrapper.find(".model-panel").exists()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("crossing the 640px boundary while open re-clamps the re-created desktop panel", async () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    const mqListeners: Array<() => void> = [];
    const mq = {
      matches: false,
      media: "(max-width: 640px)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_t: string, fn: () => void) => {
        mqListeners.push(fn);
      },
      removeEventListener: (_t: string, fn: () => void) => {
        const i = mqListeners.indexOf(fn);
        if (i >= 0) mqListeners.splice(i, 1);
      },
      dispatchEvent: () => false,
    };
    const setNarrow = (m: boolean): void => {
      mq.matches = m;
      for (const fn of [...mqListeners]) fn();
    };
    const origMq = window.matchMedia;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    try {
      const chipR = rectOf(0, 30, 100, 62);
      const panelR = rectOf(0, 0, 720, 400);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("model-chip")) return chipR;
        if (this.classList.contains("model-panel")) return panelR;
        return rectOf(0, 0, 0, 0);
      });
      const { control } = fakeControl();
      const { wrapper } = mountSwitcher(control);
      await wrapper.find("button.model-chip").trigger("click");
      await flush();
      expect((wrapper.find(".model-panel").element as HTMLElement).style.top).toBe("calc(100% + 6px)");

      // shrink past 640px while open ⇒ the desktop panel is replaced by the Teleport'd sheet
      setNarrow(true);
      await flush();
      expect(wrapper.find(".model-panel").exists()).toBe(false);
      expect(document.body.querySelector(".picker-sheet")).not.toBeNull();

      // grow back while STILL open ⇒ the re-created desktop panel element gets clamped too
      setNarrow(false);
      await flush();
      const panel = wrapper.find(".model-panel");
      expect(panel.exists()).toBe(true);
      expect((panel.element as HTMLElement).style.top).toBe("calc(100% + 6px)");
      expect(document.body.querySelector(".picker-sheet")).toBeNull();
    } finally {
      window.matchMedia = origMq;
      vi.unstubAllGlobals();
    }
  });
});
