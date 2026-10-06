// @vitest-environment happy-dom
/**
 * `DetailHeader.vue` (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3). Title fallback
 * chain (session name → sessionId prefix → "(no session name)"), the back button's `narrow`
 * gating, and the cost metric. 2026-10-05 (user 现场拍板): the CONTEXT metric left this header
 * for the composer's `ContextRing` (covered by context-ring.test.ts) — the metrics panel here
 * carries cost only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("renders the cost with the sub-agent cost aside — and NO context metric (moved to the composer's ContextRing)", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    const metrics = wrapper.find(".metrics");
    expect(metrics.text()).toContain("$195.54");
    expect(metrics.text()).toContain("$36.17");
    expect(metrics.text()).not.toContain("62%");
    expect(wrapper.find("meter").exists()).toBe(false);
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

/**
 * Mobile-adaptation package (todo #7): the ≤480px metrics fold (`.metrics-wrap`'s
 * `data-collapsed` + the one-line `.metrics-summary` toggle — CSS decides at which widths the
 * fold is honored, the component only carries the state) and the mid-band drawer toggle
 * (DashboardView-provided `SIDEBAR_DRAWER` context, inject-only like SP12).
 */
import { computed } from "vue";
import { SIDEBAR_DRAWER } from "../../../src/web-hub/ui/src/components/shell/sidebarDrawer.js";

describe("DetailHeader.vue — ≤480px metrics fold (todo #7)", () => {
  it("starts collapsed with a one-line cost-only summary (context moved to the composer's ContextRing)", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    const wrap = wrapper.get(".metrics-wrap");
    expect(wrap.attributes("data-collapsed")).toBe("true");
    const summary = wrapper.get(".metrics-summary");
    expect(summary.text()).toContain("$195.54");
    expect(summary.text()).not.toContain("62%");
    expect(summary.attributes("aria-expanded")).toBe("false");
    // the full panel stays in the DOM (CSS hides it ≤480px; ≥481px the fold state is inert)
    expect(wrapper.find(".metrics").exists()).toBe(true);
  });

  it("falls back to a dash when no cost has been reported yet", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent({ status: undefined }), narrow: true } });
    expect(wrapper.get(".metrics-summary").text()).toContain("—");
  });

  it("clicking the summary toggles the fold and aria-expanded", async () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    const summary = wrapper.get(".metrics-summary");
    await summary.trigger("click");
    expect(wrapper.get(".metrics-wrap").attributes("data-collapsed")).toBe("false");
    expect(summary.attributes("aria-expanded")).toBe("true");
    await summary.trigger("click");
    expect(wrapper.get(".metrics-wrap").attributes("data-collapsed")).toBe("true");
  });

  // verify:detail-header-cost-merge P1 ①: the toggle must point `aria-controls` at the panel
  // it expands — neither `TodoPanel` nor `WorktreePanel` wire this on their own toggle buttons
  // (checked: no same-component precedent to mirror), so this is the row's own fix.
  it("wires aria-controls on the toggle to the expanded panel's id", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    const summary = wrapper.get(".metrics-summary");
    const panel = wrapper.get(".metrics");
    const controls = summary.attributes("aria-controls");
    expect(controls).toBeTruthy();
    expect(panel.attributes("id")).toBe(controls);
  });
});

// verify:detail-header-cost-merge P1 ②: the whole summary-row family (`.session-sum` /
// `.todo-sum` / `.wt-sum` / `.metrics-summary`) shares a 40px default min-height (36px under
// `pointer: coarse`) so the cost row never reads shorter/taller than its siblings in the same
// info stack — asserted straight off the real stylesheets (component mounts can't see CSS).
describe("summary-row touch target parity (verify:detail-header-cost-merge P1 ②)", () => {
  const read = (relPath: string): string => readFileSync(resolve(fileURLToPath(import.meta.url), relPath), "utf8");
  const rule = (css: string, selector: string): string => {
    const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
    return m?.[0] ?? "";
  };

  it("default (non-coarse) min-height is 40px for .session-sum / .metrics-summary (detail.css), .todo-sum (todo.css), .wt-sum (worktrees.css)", () => {
    const detailCss = read("../../../../src/web-hub/ui/src/styles/detail.css");
    const todoCss = read("../../../../src/web-hub/ui/src/styles/todo.css");
    const wtCss = read("../../../../src/web-hub/ui/src/styles/worktrees.css");
    expect(rule(detailCss, ".session-sum")).toMatch(/min-height:\s*40px/);
    expect(rule(detailCss, ".metrics-summary")).toMatch(/min-height:\s*40px/);
    expect(rule(todoCss, ".todo-sum")).toMatch(/min-height:\s*40px/);
    expect(rule(wtCss, ".wt-sum")).toMatch(/min-height:\s*40px/);
  });

  it("`@media (pointer: coarse)` bumps every one of them to 20px (2026-10-06 compaction ×4)", () => {
    const detailCss = read("../../../../src/web-hub/ui/src/styles/detail.css");
    const todoCss = read("../../../../src/web-hub/ui/src/styles/todo.css");
    const wtCss = read("../../../../src/web-hub/ui/src/styles/worktrees.css");
    const coarseBlock = (css: string): string => {
      const start = css.indexOf("@media (pointer: coarse)");
      return start < 0 ? "" : css.slice(start);
    };
    expect(coarseBlock(detailCss)).toMatch(/\.session-sum\s*\{\s*min-height:\s*20px/);
    expect(coarseBlock(detailCss)).toMatch(/\.metrics-summary\s*\{\s*min-height:\s*20px/);
    expect(coarseBlock(todoCss)).toMatch(/\.todo-sum\s*\{\s*min-height:\s*20px/);
    expect(coarseBlock(wtCss)).toMatch(/\.wt-sum\s*\{\s*min-height:\s*20px/);
  });
});

describe("DetailHeader.vue — mid-band drawer toggle (todo #7)", () => {
  function drawerCtx(active: boolean, open: () => void = () => {}) {
    return { active: computed(() => active), open };
  }

  it("renders the toggle and the back button while the drawer context is active, even when not narrow", async () => {
    let opened = 0;
    const wrapper = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [SIDEBAR_DRAWER as symbol]: drawerCtx(true, () => opened++) } },
    });
    expect(wrapper.find(".detail-back").exists()).toBe(true);
    const toggle = wrapper.get(".detail-drawer-toggle");
    await toggle.trigger("click");
    expect(opened).toBe(1);
  });

  it("no drawer context (or an inactive one) ⇒ no toggle, and the back button follows `narrow`", () => {
    const inactive = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [SIDEBAR_DRAWER as symbol]: drawerCtx(false) } },
    });
    expect(inactive.find(".detail-drawer-toggle").exists()).toBe(false);
    expect(inactive.find(".detail-back").exists()).toBe(false);
  });
});

/**
 * worktree-web plan §5 (package W4): the header mounts `WorktreePanel` straight from
 * `status.worktrees` (no state.js mirror — the status reducer replaces `agent.status`
 * wholesale), after the TodoPanel slot; no wire (or zero rows) ⇒ no panel.
 */
describe("DetailHeader.vue — worktree panel mount (worktree-web W4)", () => {
  const wt = {
    rows: [
      {
        label: "~/ai/pi-toolkit",
        path: "/home/bluecake/ai/pi-toolkit",
        branch: "master",
        head: "0123456",
        current: true,
        main: true,
        dirty: 0,
      },
    ],
    total: 1,
    probed: 1,
    dirtyCount: 0,
    agentCount: 0,
    sampledAt: 1_700_000_000_000,
  };

  it("mounts the panel at the header bottom when status.worktrees is present (single worktree included, Q2)", () => {
    const wrapper = mount(DetailHeader, {
      props: {
        agent: agent({ status: { busy: false, pending: false, worktrees: wt } as never }),
        narrow: false,
      },
    });
    const panel = wrapper.find(".wt-panel");
    expect(panel.exists()).toBe(true);
    expect(wrapper.find(".wt-sum-text").text()).toBe("master@0123456 · worktrees 1");
    // mounted after the metrics block — the header's bottom
    const kids = wrapper.find(".detail-head").element.children;
    expect(kids[kids.length - 1]).toBe(panel.element);
  });

  it("renders no panel when the wire is absent (not a git repo / not sampled / web-hub off)", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wrapper.find(".wt-panel").exists()).toBe(false);
  });
});
