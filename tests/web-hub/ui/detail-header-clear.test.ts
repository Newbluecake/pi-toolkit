// @vitest-environment happy-dom
/**
 * `DetailHeader.vue` — web `/clear` quick button (2026-10 user request): the titlebar 「清空」
 * starts a new session in the SAME pi process by sending the EXISTING command path
 * `runCommand(agentKey, "new", "", { confirm: true })` (builtin /new, confirm baked in —
 * no confirmation dialog anywhere in this flow). Gating mirrors the composer's slash-command
 * surface (`CONTROL_VIEW.enabled` ∧ `commandsEnabled`); busy is NOT gating (builtin `new`
 * queues as followUp exactly like typing /new); in-flight disable is the local `clearing`
 * ref; a wire failure surfaces as the header's one-line role=alert note.
 */
import { mount, flushPromises } from "@vue/test-utils";
import { computed, ref } from "vue";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState, CmdOutcome, ControlHandle } from "../../../src/web-hub/ui/src/types.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 123, cwd: "/home/bluecake/ai/pi-toolkit", state: "live" },
    down: false,
    session: {
      sessionId: "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37",
      cwd: "/home/bluecake/ai/pi-toolkit",
      name: "web-hub Vue rewrite",
      model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "high",
      mode: "tui",
    },
    status: { busy: false },
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
    ...over,
  } as unknown as AgentState;
}

interface RunCall {
  readonly args: readonly unknown[];
  readonly opts: { confirm?: true; id?: string } | undefined;
}

function fakeControl(
  outcome: () => CmdOutcome = () => ({ ok: true, data: { op: "command", kind: "builtin", completion: "unknown" } }),
): { control: ControlHandle; runs: RunCall[]; gates: { resolveNext: () => void } } {
  const runs: RunCall[] = [];
  const pending: Array<() => void> = [];
  const control: ControlHandle = {
    runCommand: ((agentKey: string, name: string, args: string, opts?: { confirm?: true; id?: string }) => {
      runs.push({ args: [agentKey, name, args], opts });
      return new Promise<CmdOutcome>((resolve) => {
        pending.push(() => resolve(outcome()));
      });
    }) as ControlHandle["runCommand"],
    sendPrompt: (() => Promise.resolve({ ok: true })) as ControlHandle["sendPrompt"],
    abort: (() => Promise.resolve({ ok: true })) as ControlHandle["abort"],
    steerSub: (() => Promise.resolve({ ok: true })) as ControlHandle["steerSub"],
    stopSub: (() => Promise.resolve({ ok: true })) as ControlHandle["stopSub"],
    answerDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["answerDialog"],
    cancelDialog: (() => Promise.resolve({ ok: true })) as ControlHandle["cancelDialog"],
    query: (() => Promise.resolve({ ok: true })) as ControlHandle["query"],
    retry: (() => Promise.resolve({ ok: true })) as ControlHandle["retry"],
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };
  return { control, runs, gates: { resolveNext: () => pending.shift()?.() } };
}

interface ViewOver {
  enabled?: boolean;
  commandsEnabled?: boolean;
  busy?: boolean;
}

function fakeView(control: ControlHandle, over: ViewOver = {}): ControlView {
  const a = ref(agent());
  return {
    agentKey: "agent-1",
    control,
    enabled: computed(() => over.enabled ?? true),
    readonlyReason: computed(() => ((over.enabled ?? true) ? null : "control.dockReadonlyOffline")),
    agent: computed(() => a.value),
    busy: computed(() => over.busy ?? false),
    commands: computed(() => [{ name: "new", kind: "builtin", policy: "confirm" }]),
    commandsEnabled: computed(() => over.commandsEnabled ?? true),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
}

function mountHeader(control: ControlHandle, over: ViewOver = {}, provideView = true) {
  const wrapper = mount(DetailHeader, {
    props: { agent: agent(), narrow: false },
    ...(provideView ? { global: { provide: { [CONTROL_VIEW as symbol]: fakeView(control, over) } } } : {}),
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("DetailHeader.vue — web /clear quick button", () => {
  it("visible label next to the icon; aria-label/title stay the accessible name; CSS collapses it by container width", () => {
    const w = mountHeader(fakeControl().control);
    const label = w.get(".detail-clear-btn .head-btn-label");
    expect(label.text()).toBe("Clear");
    expect(label.attributes("aria-hidden")).toBe("true");
    expect(w.get(".detail-clear-btn").attributes("aria-label")).toBe("Clear");
    const css = readFileSync("src/web-hub/ui/src/styles/detail.css", "utf8");
    expect(css).toMatch(/\.detail-titlebar\s*\{[^}]*container:\s*detail-titlebar \/ inline-size/);
    expect(css).toMatch(
      /@container detail-titlebar \(max-width: 599px\)\s*\{\s*\.head-btn-label\s*\{\s*display: none;/,
    );
    expect(MESSAGES.zh.resume.openLabel).toBe("恢复");
    expect(MESSAGES.zh.privacy.markLabel).toBe("隐私");
    expect(MESSAGES.zh.privacy.lockLabel).toBe("锁定");
    expect(MESSAGES.zh.detail.clearAria).toBe("清空");
    expect(MESSAGES.zh.detail.clearLabel).toBe("清空");
  });

  it("click ⇒ exactly one runCommand('new', '', { confirm: true }) — the dialog-free path", async () => {
    const { control, runs } = fakeControl();
    const w = mountHeader(control);
    const btn = w.get(".detail-clear-btn");
    expect(btn.attributes("aria-label")).toBe("Clear");
    expect(btn.attributes("title")).toBe("New session (/clear)");
    await btn.trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toEqual(["agent-1", "new", ""]);
    expect(runs[0]!.opts).toEqual({ confirm: true });
  });

  it("in flight ⇒ disabled, a second click never sends (no double submit)", async () => {
    const { control, runs, gates } = fakeControl();
    const w = mountHeader(control);
    const btn = w.get(".detail-clear-btn");
    await btn.trigger("click");
    await w.vm.$nextTick();
    expect(btn.attributes("disabled")).toBeDefined();
    await btn.trigger("click"); // disabled buttons don't fire, but prove the count stays 1 anyway
    expect(runs).toHaveLength(1);
    gates.resolveNext();
    await flushPromises();
    await w.vm.$nextTick();
    expect(w.get(".detail-clear-btn").attributes("disabled")).toBeUndefined();
    expect(runs).toHaveLength(1); // re-enabled, still exactly one send
  });

  it("hidden without the composer's command surface: control off / no command slot / no CONTROL_VIEW", () => {
    const off = fakeControl();
    expect(mountHeader(off.control, { enabled: false }).find(".detail-clear-btn").exists()).toBe(false);
    const noCmd = fakeControl();
    expect(mountHeader(noCmd.control, { commandsEnabled: false }).find(".detail-clear-btn").exists()).toBe(false);
    const none = fakeControl();
    expect(mountHeader(none.control, {}, false).find(".detail-clear-btn").exists()).toBe(false);
  });

  it("busy agent stays enabled and sends (builtin /new queues as followUp — same as typing /new)", async () => {
    const { control, runs } = fakeControl();
    const w = mountHeader(control, { busy: true });
    const btn = w.get(".detail-clear-btn");
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.opts).toEqual({ confirm: true });
  });

  it("wire failure ⇒ one-line role=alert note with the code; success ⇒ no note", async () => {
    const fail = fakeControl(() => ({
      ok: false,
      error: "E_STALE_CTX",
      retryable: true,
      effect: "unknown",
    }));
    const w = mountHeader(fail.control);
    await w.get(".detail-clear-btn").trigger("click");
    fail.gates.resolveNext();
    await flushPromises();
    const note = w.get(".spawn-stop-note");
    expect(note.attributes("role")).toBe("alert");
    expect(note.text()).toContain("E_STALE_CTX");

    const ok = fakeControl();
    const w2 = mountHeader(ok.control);
    await w2.get(".detail-clear-btn").trigger("click");
    ok.gates.resolveNext();
    await flushPromises();
    expect(w2.find(".spawn-stop-note").exists()).toBe(false);
  });
});

describe("i18n — /clear button keys (en/zh parity, appended at the detail files' end)", () => {
  const en = MESSAGES.en["detail"] as Record<string, string>;
  const zh = MESSAGES.zh["detail"] as Record<string, string>;
  const KEYS = ["clearAria", "clearTitle", "clearFailed"] as const;

  it.each(KEYS)("%s exists in both languages", (k) => {
    expect(typeof en[k]).toBe("string");
    expect(typeof zh[k]).toBe("string");
  });

  it("wording matches the requirement (en Clear / zh 清空; tooltip names /clear)", () => {
    expect(en["clearAria"]).toBe("Clear");
    expect(zh["clearAria"]).toBe("清空");
    expect(en["clearTitle"]).toBe("New session (/clear)");
    expect(zh["clearTitle"]).toBe("新会话（/clear）");
  });

  it("clearFailed carries the same {code} placeholder in both languages", () => {
    expect(en["clearFailed"]).toContain("{code}");
    expect(zh["clearFailed"]).toContain("{code}");
    expect([...(zh["clearFailed"] as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1])).toEqual(["code"]);
  });
});
