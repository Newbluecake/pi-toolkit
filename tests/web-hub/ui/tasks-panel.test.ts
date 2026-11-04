// @vitest-environment happy-dom
/**
 * `TasksPanel.vue` + the status reducer's todo mirror — the W2 rewrite of the deleted
 * todo-panel.test.ts (schedule-auto-approve plan §6-W2): the todo section's markup and
 * fold-tail logic migrated VERBATIM from TodoPanel.vue, so its regression suite carries over
 * unchanged in substance; the new coverage is the aggregated surface — merged summary,
 * sched section rows (chips/last-run/links), the render gate (either side has content),
 * offline ⇒ no action buttons, old wire without `runId` ⇒ no link, and the write path
 * (policy confirm: first send without confirm, E_CONFIRM_REQUIRED ⇒ CommandConfirm ⇒ re-send
 * with confirm:true), plus `@logic/state.js`'s AgentState.todo mirror lifecycle.
 */
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import TasksPanel from "../../../src/web-hub/ui/src/components/detail/TasksPanel.vue";
import ScheduleRows from "../../../src/web-hub/ui/src/components/schedule/ScheduleRows.vue";
// Pre-warms the lazy chunk's module cache: DetailHeader mounts SchedulePanel through
// defineAsyncComponent, and an eagerly-imported copy makes that dynamic import() resolve
// within a microtask — the exact precedent of schedule-panel.test.ts's own top-level import.
import SchedulePanel from "../../../src/web-hub/ui/src/components/schedule/SchedulePanel.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, TodoWire } from "../../../src/web-hub/ui/src/types.js";
import type { SchedulesPayloadWire } from "../../../src/web-hub/protocol/schedule.js";
import { makePayload, makeSession, makeTask, SCHED_SID } from "./fixtures/schedule.js";

const SCHED_CAP = "sched.v1";

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

// --- fixtures / fakes --------------------------------------------------------------------------

const todoFixture = (over: Partial<TodoWire> = {}): TodoWire => ({
  tasks: [
    { id: 1, subject: "设计数据通道", status: "completed", blockedBy: [] },
    { id: 2, subject: "实现投影", status: "in_progress", blockedBy: [], description: "32 KiB 预算" },
    { id: 3, subject: "agent 接线", status: "pending", blockedBy: [2] },
    { id: 4, subject: "长描述任务", status: "pending", blockedBy: [], description: "abcdef", descTruncated: true },
  ],
  total: 8,
  counts: { open: 3, inProgress: 2, completed: 3, blocked: 1 },
  omitted: 4,
  updatedAt: 1_728_000_000_000,
  ...over,
});

const SCHED_SUMMARY = { count: 2, live: true } as const;

function agentOf(over: { todo?: TodoWire; schedules?: SchedulesPayloadWire; down?: boolean } = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 1, cwd: "/w/p", state: "live" },
    down: over.down === true,
    session: { sessionId: SCHED_SID, cwd: "/w/p", name: "pi-toolkit", mode: "tui" },
    status: { busy: false },
    todo: over.todo,
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
  } as unknown as AgentState;
}

interface HubOver {
  caps?: unknown;
  conn?: string;
  schedules?: SchedulesPayloadWire;
  selectRuns?: string[][];
}
function hubOf(agent: AgentState, over: HubOver = {}) {
  const state = ref({
    agents: new Map([[agent.key, agent]]),
    hub: { caps: over.caps ?? [SCHED_CAP] },
    conn: over.conn ?? "open",
    schedules: over.schedules,
  });
  const hub = {
    state,
    selectRun: (agentKey: string, runId: string) => {
      over.selectRuns?.push([agentKey, runId]);
    },
  } as unknown as HubHandle;
  return { hub, state };
}

interface ViewOver {
  enabled?: boolean;
  commandsEnabled?: boolean;
  runCommand?: (name: string, args: string, opts?: { confirm?: true; id?: string }) => Promise<CmdOutcome>;
}
function viewOf(agent: AgentState, over: ViewOver = {}) {
  const runs: Array<[string, string, string, { confirm?: true; id?: string } | undefined]> = [];
  const control = {
    runCommand: (k: string, n: string, a: string, opts?: { confirm?: true; id?: string }) => {
      runs.push([k, n, a, opts]);
      return over.runCommand !== undefined ? over.runCommand(n, a, opts) : Promise.resolve({ ok: true } as CmdOutcome);
    },
    query: () => Promise.resolve({ ok: true } as CmdOutcome),
  } as unknown as ControlHandle;
  const view: ControlView = {
    agentKey: agent.key,
    control,
    enabled: computed(() => over.enabled !== false),
    readonlyReason: computed(() => null),
    agent: computed(() => agent),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => over.commandsEnabled !== false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  return { view, runs };
}

interface PanelOver extends HubOver, ViewOver {
  todo?: TodoWire;
  schedSummary?: { count: number; live: boolean };
  schedProj?: SchedulesPayloadWire["sessions"][number];
  canWrite?: boolean;
  down?: boolean;
}
function mountPanel(over: PanelOver = {}) {
  const agent = agentOf({ todo: over.todo, schedules: over.schedules, down: over.down });
  const { hub } = hubOf(agent, over);
  const { view, runs } = viewOf(agent, over);
  const w = mount(TasksPanel, {
    props: {
      todo: over.todo,
      schedSummary: over.schedSummary,
      schedProj: over.schedProj,
      canWrite: over.canWrite,
    },
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
  });
  mounted.push(w);
  return { w, runs };
}

async function expand(w: VueWrapper<any>): Promise<void> {
  await w.find(".todo-sum").trigger("click");
  await flushPromises();
}

// --- todo section regression (verbatim TodoPanel migration) ------------------------------------

describe("TasksPanel.vue — todo section (todo-web plan §4, T4 regression)", () => {
  it("shows the merged summary line and starts collapsed (todo-only)", () => {
    const { w } = mountPanel({ todo: todoFixture() });
    expect(w.find(".todo-sum-text").text()).toBe("Tasks 3/8 · 2 active");
    expect(w.find(".todo-sum").attributes("aria-expanded")).toBe("false");
    expect(w.find(".tasks-body").exists()).toBe(false);
  });

  it("flags the blocked count on the summary row", () => {
    const { w } = mountPanel({ todo: todoFixture() });
    expect(w.find(".todo-sum-blocked").text()).toBe("1");
    const none = mountPanel({ todo: todoFixture({ counts: { open: 3, inProgress: 2, completed: 3, blocked: 0 } }) });
    expect(none.w.find(".todo-sum-blocked").exists()).toBe(false);
  });

  it("expands and collapses via the summary button (keyboard-reachable, aria-expanded)", async () => {
    const { w } = mountPanel({ todo: todoFixture() });
    const button = w.find(".todo-sum");
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(w.find(".tasks-panel").attributes("data-open")).toBe("true");
    const items = w.findAll(".todo-item");
    expect(items).toHaveLength(4);
    expect(items[0]?.attributes("data-status")).toBe("completed");
    expect(items[1]?.attributes("data-status")).toBe("in_progress");
    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(w.find(".todo-list").exists()).toBe(false);
  });

  it("renders subject, description (+truncation ellipsis), blocker label and the omitted tail", async () => {
    const { w } = mountPanel({ todo: todoFixture() });
    await expand(w);
    const items = w.findAll(".todo-item");
    expect(items[0]?.find(".todo-subject").text()).toBe("设计数据通道");
    expect(items[1]?.find(".todo-desc").text()).toBe("32 KiB 预算");
    expect(items[2]?.find(".todo-blocked").text()).toBe("blocked by #2");
    expect(items[3]?.find(".todo-desc").text()).toBe("abcdef…");
    expect(items[2]?.find(".todo-desc").exists()).toBe(false);
    expect(w.find(".todo-more").text()).toBe("(+4 more)");
    expect(items[1]?.find(".sr-only").text()).toBe("In progress");
    // the todo section stays read-only
    expect(w.findAll(".todo-list button")).toHaveLength(0);
    expect(w.findAll(".todo-list input")).toHaveLength(0);
    expect(w.find(".tasks-sec[aria-readonly='true']").exists()).toBe(true);
  });

  it("fold tail rows: done fold, more (minus completedHidden), archived — old wire degrades", async () => {
    const { w } = mountPanel({ todo: todoFixture({ completedHidden: 2, omitted: 5, archived: 3 }) });
    await expand(w);
    expect(w.find(".todo-done").text()).toBe("✓ 2 done");
    expect(w.find(".todo-more").text()).toBe("(+3 more)");
    expect(w.find(".todo-archived").text()).toBe("3 archived");
    const legacy = mountPanel({ todo: todoFixture({ omitted: 4 }) });
    await expand(legacy.w);
    expect(legacy.w.find(".todo-more").text()).toBe("(+4 more)");
    expect(legacy.w.find(".todo-done").exists()).toBe(false);
    expect(legacy.w.find(".todo-archived").exists()).toBe(false);
  });

  it("zh translations render for the fold rows", async () => {
    setLangOverride("zh");
    try {
      const { w } = mountPanel({ todo: todoFixture({ completedHidden: 2, omitted: 5, archived: 3 }) });
      await expand(w);
      expect(w.find(".todo-done").text()).toBe("已完成 2 项");
      expect(w.find(".todo-more").text()).toBe("（+3 更多）");
      expect(w.find(".todo-archived").text()).toBe("已归档 3 项");
    } finally {
      resetLangForTests();
    }
  });
});

// --- sched section + aggregation (schedule-auto-approve r2 §6-W2) ------------------------------

describe("TasksPanel.vue — sched section (r2 W2)", () => {
  it("merged summary appends the ⏰ segment; both sections render expanded", async () => {
    const { w } = mountPanel({ todo: todoFixture(), schedSummary: SCHED_SUMMARY, schedProj: makeSession() });
    expect(w.find(".todo-sum-text").text()).toBe("Tasks 3/8 · 2 active · ⏰ 2");
    await expand(w);
    expect(w.findAll(".tasks-sec")).toHaveLength(2);
    expect(w.find(".tasks-sec-title").text()).toContain("8"); // todo section count = total
    expect(w.findAll(".sched-row")).toHaveLength(2);
    expect(w.find(".tasks-foot-link").exists()).toBe(true);
  });

  it("sched-only session renders with just the ⏰ segment and one section", async () => {
    const { w } = mountPanel({ schedSummary: SCHED_SUMMARY, schedProj: makeSession() });
    expect(w.find(".todo-sum-text").text()).toBe("⏰ 2");
    await expand(w);
    expect(w.findAll(".tasks-sec")).toHaveLength(1);
    expect(w.find(".todo-list").exists()).toBe(false);
  });

  it("rows: name/when/next/chips — running chip on live rows, paused chip + greyed meta when disabled", async () => {
    const pausedOnly = makeSession({
      tasks: [makeTask({ task: { id: "s_paused01", name: "paused-task", enabled: false }, enabled: false })],
      runs: [],
    });
    const { w } = mountPanel({ schedSummary: { count: 1, live: false }, schedProj: pausedOnly });
    await expand(w);
    const row = w.find(".sched-row");
    expect(row.attributes("data-enabled")).toBe("false");
    expect(row.find(".chip[data-st='paused']").exists()).toBe(true);
    expect(row.text()).toContain("paused");
    expect(row.find(".sched-row-run").exists()).toBe(false); // no runs at all
    // live row (fixture's running run) gets the running chip with the spinner
    const live = mountPanel({ schedSummary: SCHED_SUMMARY, schedProj: makeSession() });
    await expand(live.w);
    expect(live.w.find(".sched-row .chip[data-st='running']").exists()).toBe(true);
    expect(live.w.find(".sched-row .chip[data-st='running'] .spin").exists()).toBe(true);
  });

  it("last-run line: state token + run link ONLY when the wire carries a runId (old wire ⇒ none)", async () => {
    const withId = makeSession({
      tasks: [makeTask()],
      runs: [{ ...makeSession().runs[1]!, runId: "run-abc123" }], // completed run with a runId
    });
    const { w } = mountPanel({ schedSummary: { count: 1, live: false }, schedProj: withId });
    await expand(w);
    const line = w.find(".sched-row-run");
    expect(line.text()).toContain("completed");
    expect(line.find(".sched-run-link").exists()).toBe(true);
    expect(line.find(".sched-run-link").text()).toContain("run-abc123");
    const legacy = makeSession({
      tasks: [makeTask()],
      runs: [makeSession().runs[1]!], // same run, no runId on the wire
    });
    const l = mountPanel({ schedSummary: { count: 1, live: false }, schedProj: legacy });
    await expand(l.w);
    expect(l.w.find(".sched-row-run").text()).toContain("completed");
    expect(l.w.find(".sched-run-link").exists()).toBe(false);
  });

  it("canWrite=false (offline/read-only) ⇒ NO action buttons; true ⇒ pause/resume/delete render", async () => {
    const ro = mountPanel({ schedSummary: SCHED_SUMMARY, schedProj: makeSession(), canWrite: false });
    await expand(ro.w);
    expect(ro.w.find(".sched-row-acts").exists()).toBe(false);
    const rw = mountPanel({ schedSummary: SCHED_SUMMARY, schedProj: makeSession(), canWrite: true });
    await expand(rw.w);
    // fixture: both tasks enabled ⇒ pause + delete per row
    expect(rw.w.findAll(".sched-row-acts .icon-btn")).toHaveLength(4);
    expect(rw.w.findAll(".sched-row-acts .icon-btn.danger")).toHaveLength(2);
    const pausedRow = makeSession({
      tasks: [makeTask({ task: { id: "s_paused01", enabled: false }, enabled: false })],
      runs: [],
    });
    const p = mountPanel({ schedSummary: { count: 1, live: false }, schedProj: pausedRow, canWrite: true });
    await expand(p.w);
    // the disabled row's ONLY action button is resume (play), not pause
    const first = p.w.find(".sched-row-acts .icon-btn");
    expect(first.attributes("title")).toMatch(/Resume|继续/);
    expect(first.find("svg").exists()).toBe(true);
  });

  it("pause goes through the policy confirm: bare send → E_CONFIRM_REQUIRED → bar → confirm:true re-send", async () => {
    let call = 0;
    const { w, runs } = mountPanel({
      schedSummary: SCHED_SUMMARY,
      schedProj: makeSession(),
      canWrite: true,
      runCommand: (_n, _a, opts) => {
        call += 1;
        if (opts?.confirm === true) return Promise.resolve({ ok: true } as CmdOutcome);
        return Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED" } as CmdOutcome);
      },
    });
    await expand(w);
    await w.findAll(".sched-row-acts .icon-btn")[0]!.trigger("click"); // pause s_abcd2345
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toBe("agent-1");
    expect(runs[0]![1]).toBe("schedule");
    expect(runs[0]![2]).toBe("pause s_abcd2345");
    expect(runs[0]![3]).toEqual({ id: expect.any(String) }); // first send carries NO confirm
    // the generic confirm bar appears; 执行 re-sends with confirm:true (new cmdId)
    expect(w.find(".command-confirm").exists()).toBe(true);
    await w.find(".command-confirm-run").trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(2);
    const confirmCall = runs[1]!;
    expect(confirmCall[2]).toBe("pause s_abcd2345");
    expect(confirmCall[3]).toEqual({ id: expect.any(String), confirm: true });
  });

  it("a failed action surfaces the error note (no bar)", async () => {
    const { w } = mountPanel({
      schedSummary: SCHED_SUMMARY,
      schedProj: makeSession(),
      canWrite: true,
      runCommand: () => Promise.resolve({ ok: false, error: "E_FAILED", message: "nope" } as CmdOutcome),
    });
    await expand(w);
    await w.findAll(".sched-row-acts .icon-btn.danger")[0]!.trigger("click"); // delete
    await flushPromises();
    expect(w.find(".command-confirm").exists()).toBe(false);
    expect(w.find(".tasks-sched-note[role='alert']").text()).toContain("nope");
  });

  it("emits open-schedule from the 详情 foot and from a row name click", async () => {
    const { w } = mountPanel({ schedSummary: SCHED_SUMMARY, schedProj: makeSession() });
    await expand(w);
    await w.find(".tasks-foot-link").trigger("click");
    expect(w.emitted("openSchedule")).toHaveLength(1);
    await w.find(".sched-row-name").trigger("click");
    expect(w.emitted("openSchedule")).toHaveLength(2);
  });

  it("emits open-run with the run's id when the link is clicked", async () => {
    const withId = makeSession({
      tasks: [makeTask()],
      runs: [{ ...makeSession().runs[1]!, runId: "run-xyz789" }],
    });
    const { w } = mountPanel({ schedSummary: { count: 1, live: false }, schedProj: withId });
    await expand(w);
    await w.find(".sched-run-link").trigger("click");
    expect(w.emitted("openRun")).toEqual([["run-xyz789"]]);
  });
});

// --- render gate --------------------------------------------------------------------------------

describe("TasksPanel.vue — render gate (either side has content)", () => {
  it("both sides empty ⇒ the whole panel doesn't render (parent gate; empty todo section hides itself)", async () => {
    // empty todo wire + no sched summary ⇒ the component renders only the summary shell;
    // DetailHeader's v-if keeps even that out — pinned in the DetailHeader describe below.
    const { w } = mountPanel({ todo: todoFixture({ tasks: [], omitted: undefined }) });
    await expand(w);
    expect(w.find(".todo-list").exists()).toBe(false);
    expect(w.find(".sched-row").exists()).toBe(false);
  });

  it("ScheduleRows standalone: canWrite=false hides the whole action column", () => {
    const w = mount(ScheduleRows, {
      props: { rows: [], now: 0, canWrite: false },
    });
    mounted.push(w);
    expect(w.find(".sched-rows").exists()).toBe(true);
    expect(w.find(".sched-row-acts").exists()).toBe(false);
  });
});

// --- DetailHeader wiring (todo-web T4 regression + r2 W2) --------------------------------------

describe("DetailHeader tasks-panel mount (todo-web T4 + r2 W2)", () => {
  function mountHeader(over: PanelOver = {}) {
    const agent = agentOf({ todo: over.todo, schedules: over.schedules, down: over.down });
    const { hub, state } = hubOf(agent, over);
    const { view } = viewOf(agent, over);
    const w = mount(DetailHeader, {
      props: { agent, narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
      attachTo: document.body,
    });
    mounted.push(w);
    return { w, body: new DOMWrapper(document.body), state };
  }

  it("mounts the panel at the header bottom when the agent carries a todo wire", () => {
    const { w } = mountHeader({ todo: todoFixture() });
    const panel = w.find(".tasks-panel");
    expect(panel.exists()).toBe(true);
    expect(w.find(".todo-sum-text").text()).toBe("Tasks 3/8 · 2 active");
    const kids = w.find(".detail-head-info").element.children;
    expect(kids[kids.length - 1]).toBe(panel.element);
  });

  it("renders no panel when BOTH the todo wire is absent and there is no sched projection", () => {
    const { w } = mountHeader({});
    expect(w.find(".tasks-panel").exists()).toBe(false);
  });

  it("renders the panel from the sched side alone (cap + schedules slot)", () => {
    const { w } = mountHeader({ schedules: makePayload() });
    expect(w.find(".tasks-panel").exists()).toBe(true);
    expect(w.find(".todo-sum-text").text()).toBe("⏰ 2");
  });

  it("no cap ⇒ no panel even with a schedules payload", () => {
    const { w } = mountHeader({ caps: [], schedules: makePayload() });
    expect(w.find(".tasks-panel").exists()).toBe(false);
  });

  it("open-run ⇒ hub.selectRun(agentKey, runId) (FleetDrawer precedent)", async () => {
    const selectRuns: string[][] = [];
    const withId = makeSession({
      tasks: [makeTask()],
      runs: [{ ...makeSession().runs[1]!, runId: "run-hdr1" }],
    });
    const { w } = mountHeader({ schedules: makePayload([withId]), selectRuns });
    await expand(w);
    await w.find(".sched-run-link").trigger("click");
    await flushPromises();
    expect(selectRuns).toEqual([["agent-1", "run-hdr1"]]);
  });

  it("open-schedule ⇒ the lazy SchedulePanel dialog opens", async () => {
    // Warm the dynamic-import path DetailHeader uses (vitest resolves the top-level static
    // import through a different channel than the component's own import(); awaiting the SAME
    // dynamic form here makes defineAsyncComponent resolve within microtasks afterwards).
    await import("../../../src/web-hub/ui/src/components/schedule/SchedulePanel.vue");
    const { body } = mountHeader({ schedules: makePayload() });
    await expand(body);
    await body.find(".tasks-foot-link").trigger("click");
    for (let i = 0; i < 10 && !body.find(".sched-dialog").exists(); i++) {
      await flushPromises();
      await nextTick();
    }
    expect(body.find(".sched-dialog").exists()).toBe(true);
  });

  it("offline agent ⇒ the panel renders but carries no write buttons", async () => {
    const { w } = mountHeader({ schedules: makePayload(), down: true });
    await expand(w);
    expect(w.find(".tasks-panel").exists()).toBe(true);
    expect(w.find(".sched-row-acts").exists()).toBe(false);
  });
});

// --- state.js todo mirror (todo-web plan §4, T4 — unchanged regression) -------------------------

describe("state.js todo mirror (todo-web plan §4, T4)", () => {
  type Msg = { event: string; data: any; id?: number };
  const run = (msgs: Msg[]) => msgs.reduce((acc, m) => reduce(acc, m), initialState());
  const card = (status?: Record<string, unknown>) => ({
    agentKey: "A",
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    session: { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", cwd: "/tmp/p", leafId: null, mode: "tui" },
    prompts: [],
    ...(status ? { status } : {}),
  });

  it("agents frame: card.status.todo lands on the agent", () => {
    const todo = todoFixture();
    const s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo })] }]);
    expect(s.agents.get("A")?.todo).toEqual(todo);
  });

  it("status frame: sets, replaces, and clears (absent-means-cleared) the mirror", () => {
    const todo = todoFixture();
    let s = run([{ event: "agents", data: [card()] }]);
    expect(s.agents.get("A")?.todo).toBeUndefined();
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { busy: true, pending: false, todo } } });
    expect(s.agents.get("A")?.todo).toEqual(todo);
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { busy: false, pending: false } } });
    expect(s.agents.get("A")?.todo).toBeUndefined();
  });

  it("agent_up with a stale card lacking status keeps the mirrored todo (status ?? fallback)", () => {
    const todo = todoFixture();
    let s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo })] }]);
    s = reduce(s, { event: "agent_up", data: { agentKey: "A", kind: "tui", pid: 2, cwd: "/tmp/p", state: "live" } });
    expect(s.agents.get("A")?.todo).toEqual(todo);
  });

  it("ignores a malformed todo value (non-object / task-less)", () => {
    let s = run([{ event: "agents", data: [card({ busy: false, pending: false, todo: "nope" })] }]);
    expect(s.agents.get("A")?.todo).toBeUndefined();
    s = reduce(s, {
      event: "status",
      data: { agentKey: "A", status: { busy: false, pending: false, todo: { total: 3 } } },
    });
    expect(s.agents.get("A")?.todo).toBeUndefined();
  });
});
