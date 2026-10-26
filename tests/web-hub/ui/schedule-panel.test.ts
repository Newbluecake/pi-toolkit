// @vitest-environment happy-dom
/**
 * `SchedulePanel.vue` / `ScheduleReview.vue` (scheduled-reports W1, plan r3 §5.6) — mounted
 * against the mock `SchedulesPayloadWire` fixtures (`fixtures/schedule.ts`; the hub producer
 * is H1). Covers: task list + run records + chips, the pending-approval 「审阅」 path, offline
 * read-only (E3), degraded store note, stale (hub down ⇒ feishu "?"), plain-text prompt
 * rendering (a `<script>` payload stays inert text — source-scan pins no-v-html separately),
 * the lazy `schedule` i18n namespace parity, and the DetailHeader 「定时」 entry gating.
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
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SchedulesPayloadWire } from "../../../src/web-hub/protocol/schedule.js";
import { makePayload, makePendingTask, makeSession, makeTask, SCHED_SID } from "./fixtures/schedule.js";
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
function hubOf(agent: AgentState, over: HubOver = {}): FakeHub {
  const state = ref({
    agents: new Map([[agent.key, agent]]),
    hub: { caps: over.caps ?? [SCHED_CAP] },
    conn: over.conn ?? "open",
    schedules: over.schedules,
  });
  return { hub: { state } as unknown as HubHandle, state };
}

interface ViewOver {
  enabled?: boolean;
  commandsEnabled?: boolean;
  runCommand?: (name: string, args: string) => Promise<CmdOutcome>;
}
function viewOf(agent: AgentState, over: ViewOver = {}): { view: ControlView; runs: string[][] } {
  const runs: string[][] = [];
  const control = {
    runCommand: (k: string, n: string, a: string) => {
      runs.push([k, n, a]);
      return over.runCommand !== undefined ? over.runCommand(n, a) : Promise.resolve({ ok: true } as CmdOutcome);
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

function mountPanel(over: HubOver & ViewOver & { initialReviewTaskId?: string } = {}) {
  const agent = agentOf(over);
  const { hub, state } = hubOf(agent, over);
  const { view, runs } = viewOf(agent, over);
  const w = mount(SchedulePanel, {
    props: { sessionId: SCHED_SID, initialReviewTaskId: over.initialReviewTaskId },
    global: { provide: { [HUB_CTX as symbol]: hub, [CONTROL_VIEW as symbol]: view } },
    attachTo: document.body,
  });
  mounted.push(w);
  return { w: new DOMWrapper(document.body), runs, state };
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
    // pending task gets the 审阅 primary; the approved one gets 详情
    expect(tasks[1]!.find(".sched-task-act .btn-primary").exists()).toBe(true);
    expect(tasks[0]!.find(".sched-task-act .btn-primary").exists()).toBe(false);
    const runs = w.findAll(".sched-run");
    expect(runs).toHaveLength(3);
    expect(w.text()).toContain("reports/");
    expect(w.text()).toContain("run-max");
  });

  it("offline session: read-only hint, no write path (E3)", () => {
    const { w } = mountPanel({ schedules: makePayload(), down: true });
    expect(w.find(".sched-note[data-kind='info']").exists()).toBe(true);
    expect(w.text()).toContain("--all");
    // 审阅 primary is gone (canWrite false) — every row action is the read-only 详情
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

  it("review view: full prompt as INERT text (a <script> payload stays literal)", async () => {
    const { w } = mountPanel({ schedules: makePayload() });
    await w.findAll(".sched-task-act .btn")[1]!.trigger("click"); // pending task → 审阅
    const prompt = w.find(".review-prompt");
    expect(prompt.exists()).toBe(true);
    expect(prompt.element.tagName).toBe("PRE");
    // the approved task's prompt contains a <script> string; open ITS review instead:
    await w.find(".sched-head .btn-ghost").trigger("click"); // back
    await w.findAll(".sched-task-act .btn")[0]!.trigger("click"); // 详情
    const pre = w.find(".review-prompt");
    expect(pre.text()).toContain("<script>alert(1)</script>");
    expect(pre.element.querySelector("script")).toBeNull();
    // background form renders the bg kv rows
    expect(w.text()).toContain("claude-sonnet-4-5");
    expect(w.text()).toContain("1800s");
    expect(w.text()).toContain("fd9fcbba");
  });
});

describe("ScheduleReview approve (hash-bound, §4.3/§5.6)", () => {
  it("sends /schedule approve <id> <fullHash> with the projection's defHash", async () => {
    const { w, runs } = mountPanel({ schedules: makePayload() });
    await w.findAll(".sched-task-act .btn")[1]!.trigger("click");
    const approveBtn = w.find(".review-actions .btn-primary");
    expect(approveBtn.exists()).toBe(true);
    await approveBtn.trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toBe("agent-1");
    expect(runs[0]![1]).toBe("schedule");
    expect(runs[0]![2]).toBe("approve s_efgh6789 1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655");
  });

  it("E_REV ⇒ 「内容已变更，请重新审阅」 note", async () => {
    const { w } = mountPanel({
      schedules: makePayload(),
      runCommand: () => Promise.resolve({ ok: false, error: "E_FAILED", message: "E_REV: definition changed" }),
    });
    await w.findAll(".sched-task-act .btn")[1]!.trigger("click");
    await w.find(".review-actions .btn-primary").trigger("click");
    await flushPromises();
    expect(w.find(".review-status[data-kind='err']").exists()).toBe(true);
    expect(w.find(".review-status").text()).toBeTruthy();
  });

  it("offline ⇒ no approve button at all", async () => {
    const { w } = mountPanel({ schedules: makePayload(), down: true });
    await w.findAll(".sched-task-act .btn")[1]!.trigger("click"); // 详情 (read-only)
    expect(w.find(".review-actions .btn-primary").exists()).toBe(false);
  });

  it("a non-pending task shows no action row", async () => {
    const { w } = mountPanel({ schedules: makePayload() });
    await w.findAll(".sched-task-act .btn")[0]!.trigger("click"); // approved task 详情
    expect(w.find(".review-actions").exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #61 W2 (confirm-plan r2 §4.6, §8 tests 24/25): offer-driven review — the reject path, the
// initialReviewTaskId landing, the elsewhere-handled notes, and DetailHeader's auto-open.
// ---------------------------------------------------------------------------

const PENDING_HASH = "1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655";
function offerTask(offerId = "offer-aaaa1111bbbb2222") {
  const task = makePendingTask();
  task.offer = { offerId, expiresAt: Date.now() + 3_600_000 };
  return task;
}
/** Locale-agnostic text assertion (happy-dom's navigator.languages decides en/zh). */
function expectTextIn(text: string, en: string, zh: string): void {
  expect([en, zh]).toContain(text);
}

describe("SchedulePanel initialReviewTaskId (#61 W2)", () => {
  it("mounts the panel straight into that task's review view", () => {
    const { w } = mountPanel({ schedules: makePayload(), initialReviewTaskId: "s_efgh6789" });
    expect(w.find(".review-kv").exists()).toBe(true);
    expect(w.text()).toContain("周五归档提醒");
    expect(w.find(".sched-list").exists()).toBe(false); // the list is NOT the landing view
  });
  it("an unknown initialReviewTaskId falls back to the list view", () => {
    const { w } = mountPanel({ schedules: makePayload(), initialReviewTaskId: "s_zzzz9999" });
    expect(w.find(".review-kv").exists()).toBe(false);
    expect(w.find(".sched-list").exists()).toBe(true);
  });
});

describe("ScheduleReview reject (#61 W2, §4.6)", () => {
  it("an offer-carrying never-approved AI task shows 「拒绝（删除）」 and sends /schedule reject <id> <hash>", async () => {
    const { w, runs } = mountPanel({ schedules: makePayload([makeSession({ tasks: [offerTask()] })]) });
    await w.find(".sched-task-act .btn").trigger("click"); // 审阅
    const rejectBtn = w.find(".review-actions .btn-danger");
    expect(rejectBtn.exists()).toBe(true);
    expectTextIn(rejectBtn.text(), SCHEDULE_EXTRA.en.rejectDelete, SCHEDULE_EXTRA.zh.rejectDelete);
    await rejectBtn.trigger("click");
    await flushPromises();
    expect(runs).toHaveLength(1);
    expect(runs[0]![0]).toBe("agent-1");
    expect(runs[0]![1]).toBe("schedule");
    expect(runs[0]![2]).toBe(`reject s_efgh6789 ${PENDING_HASH}`);
  });

  it("a previously-approved task (an AI update invalidated the approval) labels reject as restore", async () => {
    const task = offerTask();
    task.task = { ...task.task, approval: { hash: "0".repeat(64), by: "user", via: "tui", at: Date.now() } };
    const { w } = mountPanel({ schedules: makePayload([makeSession({ tasks: [task] })]) });
    await w.find(".sched-task-act .btn").trigger("click");
    const rejectBtn = w.find(".review-actions .btn-danger");
    expect(rejectBtn.exists()).toBe(true);
    expectTextIn(rejectBtn.text(), SCHEDULE_EXTRA.en.rejectRestore, SCHEDULE_EXTRA.zh.rejectRestore);
  });

  it("a pending task WITHOUT an offer has no reject button (approve stays)", async () => {
    const { w } = mountPanel({ schedules: makePayload([makeSession({ tasks: [makePendingTask()] })]) });
    await w.find(".sched-task-act .btn").trigger("click");
    expect(w.find(".review-actions .btn-danger").exists()).toBe(false);
    expect(w.find(".review-actions .btn-primary").exists()).toBe(true);
  });

  it("offline ⇒ no reject button even with an offer", async () => {
    const { w } = mountPanel({ schedules: makePayload([makeSession({ tasks: [offerTask()] })]), down: true });
    await w.find(".sched-task-act .btn").trigger("click"); // 详情 (read-only)
    expect(w.find(".review-actions .btn-danger").exists()).toBe(false);
  });

  it("E_REV on reject ⇒ the re-review note", async () => {
    const { w } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      runCommand: () => Promise.resolve({ ok: false, error: "E_FAILED", message: "E_REV: definition changed" }),
    });
    await w.find(".sched-task-act .btn").trigger("click");
    await w.find(".review-actions .btn-danger").trigger("click");
    await flushPromises();
    const note = w.find(".review-status[data-kind='err']");
    expect(note.exists()).toBe(true);
    expectTextIn(note.text(), SCHEDULE_EXTRA.en.approveRev, SCHEDULE_EXTRA.zh.approveRev);
  });

  it("reject success ⇒ the deleted note for a never-approved task", async () => {
    const { w } = mountPanel({ schedules: makePayload([makeSession({ tasks: [offerTask()] })]) });
    await w.find(".sched-task-act .btn").trigger("click");
    await w.find(".review-actions .btn-danger").trigger("click");
    await flushPromises();
    const note = w.find(".review-status[data-kind='ok']");
    expect(note.exists()).toBe(true);
    expectTextIn(note.text(), SCHEDULE_EXTRA.en.rejectOkDelete, SCHEDULE_EXTRA.zh.rejectOkDelete);
  });

  it("while reject is in flight only IT spins — approve is disabled but keeps its copy (verifier fix #1)", async () => {
    const { w } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      runCommand: () => new Promise<CmdOutcome>(() => {}), // never settles
    });
    await w.find(".sched-task-act .btn").trigger("click");
    const rejectBtn = w.find(".review-actions .btn-danger");
    const approveBtn = w.find(".review-actions .btn-primary");
    await rejectBtn.trigger("click");
    await flushPromises();
    expect(rejectBtn.find(".spin").exists()).toBe(true);
    expectTextIn(rejectBtn.text(), SCHEDULE_EXTRA.en.rejecting, SCHEDULE_EXTRA.zh.rejecting);
    expect(approveBtn.attributes("disabled")).toBeDefined();
    expect(approveBtn.find(".spin").exists()).toBe(false);
    expectTextIn(approveBtn.text(), SCHEDULE_EXTRA.en.approve, SCHEDULE_EXTRA.zh.approve);
  });

  it("a local reject-delete keeps 「已拒绝——任务已删除。」 across the vanishing snapshot (verifier nit #4)", async () => {
    const { w, state } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      initialReviewTaskId: "s_efgh6789",
    });
    await w.find(".review-actions .btn-danger").trigger("click");
    await flushPromises();
    state.value.schedules = makePayload([makeSession({ tasks: [], runs: [] })]); // the ledger catches up
    await nextTick();
    await flushPromises();
    expect(w.find(".review-kv").exists()).toBe(false);
    const gone = w.find(".sched-note[data-kind='info']");
    expect(gone.exists()).toBe(true);
    expectTextIn(gone.text(), SCHEDULE_EXTRA.en.rejectOkDelete, SCHEDULE_EXTRA.zh.rejectOkDelete);
  });
});

describe("offer-opened review: elsewhere-handled notes (#61 W2, §4.6)", () => {
  it("offer vanishes + task approved ⇒ 「已在其他端批准」, actions hide with pendingApproval", async () => {
    const { w, state } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      initialReviewTaskId: "s_efgh6789",
    });
    expect(w.find(".review-actions").exists()).toBe(true);
    const approved = makePendingTask();
    approved.pendingApproval = false;
    approved.executable = true;
    approved.task = { ...approved.task, approval: { hash: PENDING_HASH, by: "user", via: "web", at: Date.now() } };
    state.value.schedules = makePayload([makeSession({ tasks: [approved] })]);
    await nextTick();
    await flushPromises();
    expect(w.find(".review-actions").exists()).toBe(false);
    const note = w.find(".review-status[data-kind='ok']");
    expect(note.exists()).toBe(true);
    expectTextIn(note.text(), SCHEDULE_EXTRA.en.offerApprovedElsewhere, SCHEDULE_EXTRA.zh.offerApprovedElsewhere);
  });

  it("offer vanishes but the task is still pending ⇒ NO note (superseded/expired speaks for itself)", async () => {
    const { w, state } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      initialReviewTaskId: "s_efgh6789",
    });
    state.value.schedules = makePayload([makeSession({ tasks: [makePendingTask()] })]); // same task, offer gone
    await nextTick();
    await flushPromises();
    expect(w.find(".review-status").exists()).toBe(false);
    expect(w.find(".review-actions").exists()).toBe(true); // still pending — approve stays
  });

  it("the offer-opened task vanishing mid-review falls back to the list WITH 「任务已删除」", async () => {
    const { w, state } = mountPanel({
      schedules: makePayload([makeSession({ tasks: [offerTask()] })]),
      initialReviewTaskId: "s_efgh6789",
    });
    expect(w.find(".review-kv").exists()).toBe(true);
    state.value.schedules = makePayload([makeSession({ tasks: [], runs: [] })]);
    await nextTick();
    await flushPromises();
    expect(w.find(".review-kv").exists()).toBe(false);
    expect(w.find(".sched-empty").exists()).toBe(true);
    const gone = w.find(".sched-note[data-kind='info']");
    expect(gone.exists()).toBe(true);
    expectTextIn(gone.text(), SCHEDULE_EXTRA.en.offerTaskGone, SCHEDULE_EXTRA.zh.offerTaskGone);
  });

  it("a MANUALLY opened review whose task vanishes falls back silently (no note)", async () => {
    const { w, state } = mountPanel({ schedules: makePayload([makeSession({ tasks: [offerTask()] })]) });
    await w.find(".sched-task-act .btn").trigger("click");
    expect(w.find(".review-kv").exists()).toBe(true);
    state.value.schedules = makePayload([makeSession({ tasks: [], runs: [] })]);
    await nextTick();
    await flushPromises();
    expect(w.find(".review-kv").exists()).toBe(false);
    expect(w.find(".sched-note[data-kind='info']").exists()).toBe(false);
  });
});

describe("DetailHeader offer auto-open (#61 W2, §4.6 / §8.24)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

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
    await flushPromises(); // async SchedulePanel chunk + the auto-open watcher
    await nextTick();
    await flushPromises();
  }

  it("a live offer auto-opens the panel straight into that task's review (reject button present)", async () => {
    const { body } = mountHeaderBody({ schedules: makePayload([makeSession({ tasks: [offerTask()] })]) });
    await settle();
    expect(body.find(".sched-dialog .review-kv").exists()).toBe(true);
    expect(body.text()).toContain("周五归档提醒");
    expect(body.find(".review-actions .btn-danger").exists()).toBe(true);
  });

  it("closing marks the offerId seen — no re-pop on refresh or on a fresh mount; a NEW offerId pops again", async () => {
    const payload = makePayload([makeSession({ tasks: [offerTask()] })]);
    const first = mountHeaderBody({ schedules: payload });
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(true);
    await first.body.find(".sched-close").trigger("click"); // close ⇒ 「已呈现」
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(false);
    // the offer is still on the wire; a payload refresh must not re-pop
    first.state.value.schedules = makePayload([makeSession({ tasks: [offerTask()] })]);
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(false);
    first.w.unmount();
    document.body.innerHTML = "";
    // a fresh mount (same tab ⇒ same sessionStorage) still does not re-pop
    const second = mountHeaderBody({ schedules: payload });
    await settle();
    expect(second.body.find(".sched-dialog").exists()).toBe(false);
    second.w.unmount();
    document.body.innerHTML = "";
    // a NEW offerId is a fresh request ⇒ pops again
    const third = mountHeaderBody({
      schedules: makePayload([makeSession({ tasks: [offerTask("offer-cccc3333dddd4444")] })]),
    });
    await settle();
    expect(third.body.find(".sched-dialog").exists()).toBe(true);
  });

  it("a second offer that arrived while the panel was open pops on close (verifier fix #2)", async () => {
    const first = mountHeaderBody({
      schedules: makePayload([makeSession({ tasks: [offerTask("offer-aaaa1111bbbb2222")] })]),
    });
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(true);
    // a superseding offer arrives WHILE the panel is open — the watcher returns early
    first.state.value.schedules = makePayload([makeSession({ tasks: [offerTask("offer-bbbb2222cccc3333")] })]);
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(true); // same open panel, no thrash
    // closing marks the first offer seen and immediately re-opens for the unseen second one
    await first.body.find(".sched-close").trigger("click");
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(true);
    // closing again marks the second seen — now it stays closed
    await first.body.find(".sched-close").trigger("click");
    await settle();
    expect(first.body.find(".sched-dialog").exists()).toBe(false);
  });

  it("never pops on a read-only control surface or an offline session", async () => {
    const payload = makePayload([makeSession({ tasks: [offerTask()] })]);
    const readOnly = mountHeaderBody({ schedules: payload, enabled: false });
    await settle();
    expect(readOnly.body.find(".sched-dialog").exists()).toBe(false);
    readOnly.w.unmount();
    document.body.innerHTML = "";
    const offline = mountHeaderBody({ schedules: payload, down: true });
    await settle();
    expect(offline.body.find(".sched-dialog").exists()).toBe(false);
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
  it("⏰! while a task is pendingApproval; ⏰<n> otherwise; nothing without the cap", () => {
    const pending = mountCard({ schedules: makePayload() });
    expect(pending.find(".chip-sched").exists()).toBe(true);
    expect(pending.find(".chip-sched").attributes("data-pending")).toBe("true");
    expect(pending.find(".chip-sched").text()).toContain("!");
    const plain = mountCard({ schedules: makePayload([makeSession({ tasks: [makeSession().tasks[0]!] })]) });
    expect(plain.find(".chip-sched").attributes("data-pending")).toBeUndefined();
    expect(plain.find(".chip-sched .num").text()).toBe("1");
    expect(mountCard({ caps: [], schedules: makePayload() }).find(".chip-sched").exists()).toBe(false);
    expect(mountCard({}).find(".chip-sched").exists()).toBe(false); // no schedules slot at all
  });
});
