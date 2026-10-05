// @vitest-environment happy-dom
/**
 * `DetailHeader.vue` (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3). Title fallback
 * chain (session name → sessionId prefix → "(no session name)"), the back button's `narrow`
 * gating, and the context/cost metrics.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

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
    status: {
      busy: true,
      pending: false,
      costUsd: 195.54,
      subagentCostUsd: 36.17,
      contextUsage: { tokens: 124_000, contextWindow: 200_000, percent: 62 },
    },
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

describe("DetailHeader.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("titles from the session name when present", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wrapper.find(".detail-title").text()).toBe("web-hub Vue rewrite");
  });

  it("falls back to the sessionId prefix, then '(no session name)'", () => {
    const noName = mount(DetailHeader, {
      props: {
        agent: agent({ session: { sessionId: "01a0d892abcd", cwd: "/x", mode: "tui" } as never }),
        narrow: false,
      },
    });
    expect(noName.find(".detail-title").text()).toBe("01a0d892");

    const noSession = mount(DetailHeader, { props: { agent: agent({ session: undefined }), narrow: false } });
    expect(noSession.find(".detail-title").text()).toBe("(no session name)");
  });

  it("shows a status pill reflecting the agent's visual state", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wrapper.find(".pill").attributes("data-st")).toBe("running");
    expect(wrapper.find(".pill").text()).toBe("Working");
  });

  it("renders the back button only when narrow", () => {
    const narrow = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    expect(narrow.find(".detail-back").exists()).toBe(true);
    const wide = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wide.find(".detail-back").exists()).toBe(false);
  });

  it("emits back when the back button is clicked", async () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    await wrapper.find(".detail-back").trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
  });

  it("renders the context percent and cost with the sub-agent cost aside", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    const metrics = wrapper.find(".metrics").text();
    expect(metrics).toContain("62%");
    expect(metrics).toContain("$195.54");
    expect(metrics).toContain("$36.17");
  });

  it("session summary shows the short cwd and model/thinking level", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    const summary = wrapper.find(".session-sum").text();
    expect(summary).toContain("ai/pi-toolkit");
    expect(summary).toContain("cr-anthropic/claude-opus-5-5 · high");
  });
});

/**
 * web-hub-spawn SP12 (arch §9.1): a spawn record managing the header's agent adds the
 * 「停止会话」 two-step-arm button (wired to `useSpawn.stop`); a terminal failed/expired first
 * prompt whose body went back into the draft (useNewSession `refilled:"draft"`) shows a
 * one-time dismissible note. Inject-only — the frozen DetailHeaderProps are untouched.
 */
import { ref } from "vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, HubState, NewSessionFlow } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnRecordPublic, SpawnsPayload } from "../../../src/web-hub/protocol/spawn.js";
import type { SpawnStopOutcome } from "../../../src/web-hub/ui/src/transport/types.js";

function spawnRec(over: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp9",
    state: "live",
    createdAt: 1000,
    updatedAt: 1000,
    cwdLabel: "proj",
    agentKey: "agent-1",
    origin: { listener: "loopback", reqId: "req-aaaaaaaaaaaaaaaa" },
    ...over,
  };
}

function hubWithSpawn(opts: {
  spawns?: SpawnsPayload | null;
  flow?: NewSessionFlow;
  stop?: (spawnId: string, force?: boolean) => Promise<SpawnStopOutcome>;
}): HubHandle {
  return {
    state: ref({ agents: new Map(), spawns: opts.spawns ?? null } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: true, policy: {} as never, items: opts.spawns?.items ?? [] }),
      dirs: async () => ({ ok: true, recent: [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: opts.stop ?? (async () => ({ ok: true, state: "stopping" })),
      newSession: {
        flow: ref(opts.flow ?? { phase: "idle" }),
        submit: async () => true,
        confirm: async () => {},
        cancel: () => {},
        retry: async () => false,
        noteSpawns: () => {},
        dispose: () => {},
        stats: () => ({ retainedTexts: 0 }),
      },
    },
  };
}

describe("DetailHeader.vue — managed session stop (SP12)", () => {
  it("no managed record (or no HUB_CTX) ⇒ no stop button", () => {
    const plain = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(plain.find(".spawn-stop-btn").exists()).toBe(false);

    const hub = hubWithSpawn({ spawns: { items: [spawnRec({ state: "exited" })], active: 0, max: 4 } });
    const terminal = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    expect(terminal.find(".spawn-stop-btn").exists()).toBe(false);
  });

  it("managed live record ⇒ two-step arm, second click calls stop(spawnId)", async () => {
    const stopped: string[] = [];
    const hub = hubWithSpawn({
      spawns: { items: [spawnRec()], active: 1, max: 4 },
      stop: async (spawnId) => {
        stopped.push(spawnId);
        return { ok: true, state: "stopping" };
      },
    });
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".spawn-stop-btn");
    expect(btn.text()).toContain("Stop session");
    await btn.trigger("click"); // arm
    expect(btn.text()).toContain("Click again");
    expect(stopped).toHaveLength(0);
    await btn.trigger("click"); // confirm
    await wrapper.vm.$nextTick();
    expect(stopped).toEqual(["sp9"]);
  });

  it("a failed stop surfaces the error code inline", async () => {
    const hub = hubWithSpawn({
      spawns: { items: [spawnRec()], active: 1, max: 4 },
      stop: async () => ({ ok: false, error: "E_GONE" }),
    });
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    await wrapper.get(".spawn-stop-btn").trigger("click");
    await wrapper.get(".spawn-stop-btn").trigger("click");
    await flushPromises();
    expect(wrapper.get(".spawn-stop-note").text()).toContain("E_GONE");
  });

  it("stopping record ⇒ the button is disabled with the stopping label", () => {
    const hub = hubWithSpawn({ spawns: { items: [spawnRec({ state: "stopping" })], active: 1, max: 4 } });
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".spawn-stop-btn");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.text()).toContain("stopping");
  });
});

describe("DetailHeader.vue — first-prompt refill notice (SP12, §3.2)", () => {
  it("done flow with a failed, draft-refilled first prompt for THIS agent ⇒ one-time note; dismiss hides it", async () => {
    const flow: NewSessionFlow = {
      phase: "done",
      spawnId: "sp9",
      agentKey: "agent-1",
      firstPrompt: { state: "failed", refilled: "draft" },
    };
    const hub = hubWithSpawn({ flow });
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const note = wrapper.get(".spawn-fp-note");
    expect(note.text()).toContain("back in the draft");
    await note.get("button").trigger("click");
    expect(wrapper.find(".spawn-fp-note").exists()).toBe(false);
  });

  it("a note for ANOTHER agent never shows here", () => {
    const flow: NewSessionFlow = {
      phase: "done",
      spawnId: "sp9",
      agentKey: "agent-2",
      firstPrompt: { state: "failed", refilled: "draft" },
    };
    const hub = hubWithSpawn({ flow });
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    expect(wrapper.find(".spawn-fp-note").exists()).toBe(false);
  });
});
