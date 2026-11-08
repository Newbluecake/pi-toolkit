// @vitest-environment happy-dom
/**
 * `SchedulePanel.vue` / `ScheduleTaskDetail.vue` (scheduled-reports W1, plan r3 §5.6) — mounted
 * against the mock `SchedulesPayloadWire` fixtures (`fixtures/schedule.ts`; the hub producer
 * is H1). Covers: task list + run records + chips, the read-only 「详情」 swap (approval UI
 * removed, schedule-auto-approve r2 §6-W1 — legacy `pendingApproval` / `offer` wire fields
 * are ignored), offline read-only (E3), degraded store note, stale (hub down ⇒ feishu "?"),
 * plain-text prompt rendering (a `<script>` payload stays inert text — source-scan pins
 * no-v-html separately), the lazy `schedule` i18n namespace parity, and the DetailHeader
 * 「定时」 entry gating + no offer auto-open.
 */
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import { toAgentCardView } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import SchedulePanel from "../../../src/web-hub/ui/src/components/schedule/SchedulePanel.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { SCHEDULE_EXTRA } from "../../../src/web-hub/ui/src/i18n/schedule-extra.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";
import type { SchedulesPayloadWire } from "../../../src/web-hub/protocol/schedule.js";
import { makePayload, makePendingTask, makeRun, makeSession, makeTask, SCHED_SID } from "./fixtures/schedule.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { setDetailedListForTests } from "./helpers/list-density.js";

const SCHED_CAP = "sched.v1";

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  setDetailedListForTests();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  resetLangForTests();
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

// --- fakes --------------------------------------------------------------------

interface HubOver {
  caps?: unknown;
  conn?: string;
  schedules?: SchedulesPayloadWire;
  down?: boolean;
}
function agentOf(over: HubOver = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 1, cwd: "/w/p", state: "live" },
    down: over.down === true,
    session: { sessionId: SCHED_SID, cwd: "/w/p", name: "pi-toolkit", mode: "tui" },
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
  } as unknown as AgentState;
}

interface FakeHub {
  hub: HubHandle;
  state: { value: Record<string, unknown> };
}
function hubOf(agent: AgentState, over: HubOver & { selectRuns?: string[][] } = {}): FakeHub {
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

function mountPanel(over: HubOver & ViewOver & { selectRuns?: string[][] } = {}) {
  const agent = agentOf(over);
  const { hub, state } = hubOf(agent, over);
  const { view, runs } = viewOf(agent, over);
  const w = mount(SchedulePanel, {
    props: { sessionId: SCHED_SID },
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    attachTo: document.body,
  });
  mounted.push(w);
  return { w: new DOMWrapper(document.body), state, runs, selectRuns: over.selectRuns ?? [] };
}

// --- tests --------------------------------------------------------------------

describe("SchedulePanel", () => {
  it("renders the task list with chips/meta/stats and the run records", () => {
    const { w } = mountPanel({ schedules: makePayload() });
    const tasks = w.findAll(".sched-task");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text()).toContain("每日晨报");
    expect(tasks[0]!.text()).toContain("0 8 * * *");
    expect(tasks[0]!.text()).toContain("Asia/Shanghai");
    expect(tasks[1]!.text()).toContain("周五归档提醒");
    // r2: EVERY row is the read-only ghost 「详情」 — no primary 审阅 button anywhere,
    // and the legacy pendingApproval task shows the plain 已启用/enabled chip (no 待确认).
    expect(w.findAll(".sched-task-act .btn-primary")).toHaveLength(0);
    expect(w.findAll(".sched-task-act .btn-ghost")).toHaveLength(2);
    // the legacy taskPending/taskExecutable copy (removed with the keys, r2) never renders
    expect(w.text()).not.toContain("review pending");
    expect(w.text()).not.toContain("待确认");
    expect(w.text()).not.toContain("approved");
    expect(w.text()).not.toContain("已批准");
    const runs = w.findAll(".sched-run");
    expect(runs).toHaveLength(3);
    expect(w.text()).toContain("reports/");
    expect(w.text()).toContain("run-max");
  });

  it("offline session: read-only hint, no write path (E3)", () => {
    const { w } = mountPanel({ schedules: makePayload(), down: true });
    expect(w.find(".sched-note[data-kind='info']").exists()).toBe(true);
    expect(w.text()).toContain("--all");
    expect(w.find(".sched-task-act .btn-primary").exists()).toBe(false);
  });

  it("degraded store ⇒ repair note, no task list", () => {
    const p = makePayload([makeSession({ tasks: [], runs: [], degraded: "invalid-json" })]);
    const { w } = mountPanel({ schedules: p });
    expect(w.find(".sched-note[data-kind='warn']").text()).toContain("invalid-json");
    expect(w.find(".sched-task").exists()).toBe(false);
  });

  it("stale (conn ≠ open): banner + every feishu receipt renders '?'", () => {
    const { w } = mountPanel({ schedules: makePayload(), conn: "reconnecting" });
    expect(w.find(".sched-note[data-kind='warn']").exists()).toBe(true);
    expect(w.find(".sched-run").text()).toContain("?");
    expect(w.text()).not.toContain("sent");
  });

  it("empty projection ⇒ empty state text; a session-less payload ⇒ same", () => {
    const { w } = mountPanel({ schedules: makePayload([makeSession({ tasks: [], runs: [] })]) });
    expect(w.find(".sched-empty").exists()).toBe(true);
    // the payload covers only OTHER sessions ⇒ this session renders the empty state too
    const other = makePayload([makeSession({ sessionId: "other-session-id" })]);
    const { w: w2 } = mountPanel({ schedules: other });
    expect(w2.find(".sched-empty").exists()).toBe(true);
  });

  it("droppedReports hint renders when the index overflowed", () => {
    const { w } = mountPanel({ schedules: makePayload([makeSession({ droppedReports: 3 })]) });
    expect(w.text()).toContain("3");
  });

  it("a task with missed occurrences carries a warn chip (错过提示)", () => {
    const p = makePayload([
      makeSession({ tasks: [makeTask({ totals: { fired: 3, missed: 2, skipped: 0, manual: 0 } })] }),
    ]);
    const { w } = mountPanel({ schedules: p });
    expect(w.find(".sched-task .sched-chip-missed").exists()).toBe(true);
  });

  it("detail view: full prompt as INERT text (a <script> payload stays literal), bg kv rows", async () => {
    const { w } = mountPanel({ schedules: makePayload() });
    await w.findAll(".sched-task-act .btn")[0]!.trigger("click"); // 详情
    const prompt = w.find(".review-prompt");
    expect(prompt.exists()).toBe(true);
    expect(prompt.element.tagName).toBe("PRE");
    expect(prompt.text()).toContain("<script>alert(1)</script>");
    expect(prompt.element.querySelector("script")).toBeNull();
    // background form renders the bg kv rows
    expect(w.text()).toContain("claude-sonnet-4-5");
    expect(w.text()).toContain("1800s");
  });

  it("detail view is READ-ONLY: no approve/reject actions, no hash note (r2 §6-W1)", async () => {
    const { w } = mountPanel({ schedules: makePayload() });
    // the legacy-pending task (pendingApproval:true + offer on the wire) opens the SAME
    // read-only view — no action row, no hash note, no tracked command of any kind
    await w.findAll(".sched-task-act .btn")[1]!.trigger("click");
    expect(w.find(".review-actions").exists()).toBe(false);
    expect(w.find(".review-hash").exists()).toBe(false);
    expect(w.text()).not.toContain("defHash");
    expect(w.findAll("button.review-actions .btn")).toHaveLength(0);
    // back returns to the list
    await w.find(".sched-head .btn-ghost").trigger("click");
    expect(w.find(".sched-list").exists()).toBe(true);
  });

  it("a task vanishing mid-detail falls back to the list silently (no note)", async () => {
    const { w, state } = mountPanel({ schedules: makePayload() });
    await w.findAll(".sched-task-act .btn")[0]!.trigger("click");
    expect(w.find(".review-kv").exists()).toBe(true);
    state.value.schedules = makePayload([makeSession({ tasks: [], runs: [] })]);
    await nextTick();
    await flushPromises();
    expect(w.find(".review-kv").exists()).toBe(false);
    expect(w.find(".sched-empty").exists()).toBe(true);
    expect(w.find(".sched-note[data-kind='info']").exists()).toBe(false);
  });
});

describe("SchedulePanel task actions + run jump (r2 §6-W2)", () => {
  it("shows timeline state in both languages and keeps all actions operable", async () => {
    setLangOverride("zh");
    const tasks = [
      makeTask({ nextAt: Date.now() + 29 * 60_000 }),
      makeTask({ task: { id: "s_paused01", name: "暂停任务", enabled: false }, nextAt: undefined }),
    ];
    const { w, runs } = mountPanel({ schedules: makePayload([makeSession({ tasks, runs: [] })]) });
    const rows = w.findAll(".sched-task");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find(".sched-task-meta strong").text()).toMatch(/下次 .* 后/);
    expect(rows[0]!.find(".sched-task-when").text()).toContain("0 8");
    expect(rows[1]!.find(".sched-task-when").text()).toContain("0 8");
    expect(rows[1]!.find(".sched-task-meta").text()).toContain("暂停触发");
    expect(rows.every((row) => row.find(".sched-task-dot").attributes("aria-hidden") === "true")).toBe(true);
    expect(rows[0]!.findAll(".chip")).toHaveLength(0);
    expect(rows[1]!.findAll("button").every((button) => !!button.attributes("aria-label"))).toBe(true);
    await rows[1]!.find(".icon-btn").trigger("click");
    await flushPromises();
    await rows[0]!.find(".icon-btn.danger").trigger("click");
    await flushPromises();
    expect(runs.map((run) => run[2])).toEqual(["resume s_paused01", "rm s_abcd2345"]);
    setLangOverride("en");
    await nextTick();
    expect(rows[0]!.find(".sched-task-meta").text()).toContain("next ");
    expect(rows[1]!.find(".sched-task-meta").text()).toContain("trigger paused");
    await rows[1]!.find(".btn-ghost").trigger("click");
    expect(w.find(".sched-task-act").exists()).toBe(false);
  });

  it("online + canWrite: task rows carry pause/resume/delete icon buttons", () => {
    const { w } = mountPanel({ schedules: makePayload() });
    // fixture: both tasks enabled ⇒ pause + delete per row
    expect(w.findAll(".sched-task-act .icon-btn")).toHaveLength(4);
    expect(w.findAll(".sched-task-act .icon-btn.danger")).toHaveLength(2);
  });

  it("pause goes through the policy confirm: bare send → E_CONFIRM_REQUIRED → bar → confirm:true re-send", async () => {
    const { w, runs } = mountPanel({
      schedules: makePayload(),
      runCommand: (_n, _a, opts) =>
        opts?.confirm === true
          ? Promise.resolve({ ok: true } as CmdOutcome)
          : Promise.resolve({ ok: false, error: "E_CONFIRM_REQUIRED" } as CmdOutcome),
    });
    await w.findAll(".sched-task-act .icon-btn")[0]!.trigger("click"); // pause s_abcd2345
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]![2]).toBe("pause s_abcd2345");
    expect(runs[0]![3]).toEqual({ id: expect.any(String) }); // first send carries NO confirm
    expect(w.find(".command-confirm").exists()).toBe(true);
    await w.find(".command-confirm-run").trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(2);
    expect(runs[1]![2]).toBe("pause s_abcd2345");
    expect(runs[1]![3]).toEqual({ id: expect.any(String), confirm: true });
  });

  it("a failed action surfaces the warn note", async () => {
    const { w } = mountPanel({
      schedules: makePayload(),
      runCommand: () => Promise.resolve({ ok: false, error: "E_FAILED", message: "boom" } as CmdOutcome),
    });
    await w.findAll(".sched-task-act .icon-btn.danger")[0]!.trigger("click");
    await flushPromises();
    const note = w.find(".sched-note[data-kind='warn'][role='alert']");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("boom");
  });

  it("offline (E3): no action buttons — the read-only 详情 stays", () => {
    const { w } = mountPanel({ schedules: makePayload(), down: true });
    expect(w.findAll(".sched-task-act .icon-btn")).toHaveLength(0);
    expect(w.findAll(".sched-task-act .btn-ghost")).toHaveLength(2);
  });

  it("run rows with a runId jump to the fleet (hub.selectRun); legacy runs without one render no button", async () => {
    const p = makePayload([
      makeSession({
        runs: [
          makeRun({ runKey: "s_abcd2345@new", runId: "run-jmp1" }),
          makeRun(), // legacy wire: no runId
        ],
      }),
    ]);
    const selectRuns: string[][] = [];
    const { w, selectRuns: recorder } = mountPanel({ schedules: p, selectRuns });
    expect(w.findAll(".sched-run-open")).toHaveLength(1);
    await w.find(".sched-run-open").trigger("click");
    expect(recorder).toEqual([["agent-1", "run-jmp1"]]);
  });
});

describe("legacy offer wire is ignored (r2 §6-W1, old-hub compat)", () => {
  function mountHeaderBody(over: HubOver & ViewOver = {}) {
    const agent = agentOf(over);
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
  async function settle(): Promise<void> {
    await flushPromises(); // async chunk resolution
    await nextTick();
    await flushPromises();
  }

  it("an offer-carrying projection (makePendingTask) NEVER auto-opens the panel", async () => {
    const { body } = mountHeaderBody({ schedules: makePayload() });
    await settle();
    expect(body.find(".sched-dialog").exists()).toBe(false);
  });

  it("the legacy pendingApproval task still opens the plain read-only detail from the panel", async () => {
    const { body } = mountHeaderBody({ schedules: makePayload() });
    await settle();
    await body.find(".detail-sched-btn").trigger("click");
    await settle();
    const buttons = body.findAll(".sched-task-act .btn");
    expect(buttons).toHaveLength(2);
    await buttons[1]!.trigger("click");
    await settle();
    expect(body.find(".review-kv").exists()).toBe(true);
    expect(body.find(".review-actions").exists()).toBe(false);
  });
});

describe("lazy `schedule` i18n namespace parity", () => {
  it("zh keys === en keys", () => {
    const k = (o: Record<string, string>) => Object.keys(o).sort();
    expect(k(SCHEDULE_EXTRA.zh)).toEqual(k(SCHEDULE_EXTRA.en));
  });
});

describe("DetailHeader 「定时」 entry (cap-gated)", () => {
  function mountHeader(over: HubOver = {}) {
    const agent = agentOf(over);
    const { hub } = hubOf(agent, over);
    const { view } = viewOf(agent);
    const w = mount(DetailHeader, {
      props: { agent, narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(w);
    return w;
  }
  it("renders with sched.v1 + sessionId; zero trace without the cap or sessionId", () => {
    expect(mountHeader().find(".detail-sched-btn").exists()).toBe(true);
    expect(mountHeader({ caps: [] }).find(".detail-sched-btn").exists()).toBe(false);
    const noSid = mountHeader();
    noSid.unmount();
    const agent = agentOf();
    (agent.session as Record<string, unknown>).sessionId = "";
    const { hub } = hubOf(agent);
    const { view } = viewOf(agent);
    const w = mount(DetailHeader, {
      props: { agent, narrow: false },
      global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    });
    mounted.push(w);
    expect(w.find(".detail-sched-btn").exists()).toBe(false);
  });
});

describe("AgentCard ⏰ badge", () => {
  function mountCard(over: HubOver = {}) {
    const agent = agentOf(over);
    const { hub } = hubOf(agent, over);
    const w = mount(AgentCard, {
      props: { card: toAgentCardView(agent, (k: string) => k), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    mounted.push(w);
    return w;
  }
  it("⏰<n> count-only: a legacy pendingApproval+offer task counts like any other (no `!`)", () => {
    // fixture session: one plain task + makePendingTask() (pendingApproval:true, offer)
    const pending = mountCard({ schedules: makePayload() });
    expect(pending.find(".chip-sched").exists()).toBe(true);
    expect(pending.find(".chip-sched").attributes("data-pending")).toBeUndefined();
    expect(pending.find(".chip-sched .num").text()).toBe("2");
    expect(pending.find(".chip-sched").text()).not.toContain("!");
    const plain = mountCard({ schedules: makePayload([makeSession({ tasks: [makeSession().tasks[0]!] })]) });
    expect(plain.find(".chip-sched .num").text()).toBe("1");
    expect(mountCard({ caps: [], schedules: makePayload() }).find(".chip-sched").exists()).toBe(false);
    expect(mountCard({}).find(".chip-sched").exists()).toBe(false); // no schedules slot at all
  });
});
