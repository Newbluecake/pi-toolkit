// @vitest-environment happy-dom
/**
 * Composer tasks chip (2026-11 user request + schedule-auto-approve r2 W3): the always-visible
 * aggregated chip
 * (`.composer-todo-external`, absolutely positioned at the composer card's top-left — a
 * `.composer-chips` SIBLING in the DOM, so the typing-time `.chips-off` fade never applies)
 * + its read-only open-only panel. Covers: the empty-state ruling (no todo wire / openCount
 * 0 ⇒ chip not rendered), the count口径 (wire `counts.open` is pending-only, so the chip
 * shows open + inProgress), hover auto-expand GATED to `(hover: hover) and (pointer: fine)`
 * (coarse/touch pointers ignore the browser's synthetic pre-click mouseenter, so the first
 * tap pins directly — verifier major, 2026-11-04), click pin/unpin with `aria-expanded`,
 * outside-pointerdown close, open-only row filtering (completed surface only as the header's
 * `X done` summary), the `+N more` tail (`omitted` minus the `completedHidden` fold,
 * TasksPanel's formula), the steer/held ruling (2026-11-04): while queue rows render
 * above the composer the chip AND panel never render — an expanded panel drops immediately
 * and never restores a stale expanded state when the queue drains — and a static contract
 * for the CSS-only expanded-badge hiding.
 */
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computed, nextTick, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import {
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState, CmdOutcome, ControlHandle, HubHandle, TodoWire } from "../../../src/web-hub/ui/src/types.js";
import type { SchedulesPayloadWire } from "../../../src/web-hub/protocol/schedule.js";
import { makePayload, makeSession, makeTask } from "./fixtures/schedule.js";

/** Desktop default: ONLY the composer's real-hover gate matches; every other query
 * (max-width, pointer: coarse, …) answers false, exactly like the old blanket stub. */
function stubMatchMedia(matches: (query: string) => boolean = (q) => q === "(hover: hover) and (pointer: fine)"): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia();
  window.localStorage.clear();
});

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetLangForTests();
  for (const w of mounted.splice(0)) w.unmount();
});

const todoFixture = (over: Partial<TodoWire> = {}): TodoWire => ({
  tasks: [
    { id: 1, subject: "设计数据通道", status: "completed", blockedBy: [] },
    { id: 2, subject: "实现投影", status: "in_progress", blockedBy: [], description: "32 KiB 预算" },
    { id: 3, subject: "agent 接线", status: "pending", blockedBy: [2] },
  ],
  total: 5,
  counts: { open: 1, inProgress: 1, completed: 3, blocked: 1 },
  updatedAt: 1_728_000_000_000,
  ...over,
});

const SCHED_SID = "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37";

function todoView(todo: TodoWire | undefined, queue: Ref<readonly unknown[]> = ref([])): ControlView {
  const agent = ref({ pendingCtl: [], todo, session: { sessionId: SCHED_SID } } as unknown as AgentState);
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
    queueItems: computed(() => queue.value),
    isWebMessage: () => false,
  };
}

function hubOf(over: { caps?: unknown; schedules?: SchedulesPayloadWire; selectRuns?: string[][] } = {}) {
  const state = ref({
    agents: new Map(),
    hub: { caps: over.caps ?? ["sched.v1"] },
    conn: "open",
    schedules: over.schedules,
  });
  const hub = {
    state,
    selectRun: (agentKey: string, runId: string) => {
      over.selectRuns?.push([agentKey, runId]);
    },
  } as unknown as HubHandle;
  return hub;
}

function mountComposer(view?: ControlView, hub?: HubHandle) {
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false },
    global: {
      provide: {
        ...(view ? { [CONTROL_VIEW as symbol]: view } : {}),
        ...(hub ? { [HUB_CTX as symbol]: hub } : {}),
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("Composer todo chip (2026-11 user request)", () => {
  it("no CONTROL_VIEW / no todo wire ⇒ the chip is not rendered (空态拍板)", () => {
    expect(mountComposer().find(".composer-todo-external").exists()).toBe(false);
    expect(mountComposer(todoView(undefined)).find(".composer-todo-external").exists()).toBe(false);
  });

  it("zero open tasks (all completed) ⇒ the chip is not rendered", () => {
    const w = mountComposer(
      todoView(
        todoFixture({
          tasks: [{ id: 1, subject: "做完了", status: "completed", blockedBy: [] }],
          counts: { open: 0, inProgress: 0, completed: 1, blocked: 0 },
        }),
      ),
    );
    expect(w.find(".composer-todo-external").exists()).toBe(false);
  });

  it("the chip shows ✓ pending + inProgress (wire counts.open is pending-only)", () => {
    const w = mountComposer(todoView(todoFixture()));
    const btn = w.find(".composer-todo-btn");
    expect(btn.exists()).toBe(true);
    // single-segment mode (todo-only): icon WITHOUT the inline number; the count is the badge
    expect(btn.find(".seg .n").exists()).toBe(false);
    expect(btn.find(".composer-todo-badge").text()).toBe("2"); // open 1 + inProgress 1
    expect(btn.attributes("aria-label")).toContain("✓ 2"); // the aria always carries the count
    expect(btn.attributes("aria-label")).toBe("Show tasks · ✓ 2");
    expect(btn.attributes("aria-expanded")).toBe("false");
    // Positioned OUTSIDE the composer card (absolute, top-left), not inside .composer-chips.
    expect(w.find(".composer-chips .composer-todo-external").exists()).toBe(false);
    expect(w.find(".composer-todo-external").exists()).toBe(true);
  });

  it("typing never hides the chip (no chips-off class on the todo host)", async () => {
    const w = mountComposer(todoView(todoFixture()));
    await w.find("textarea").setValue("hello");
    expect(w.find(".composer-chips").classes()).toContain("chips-off"); // ModelSwitcher fades
    const host = w.find(".composer-todo-external");
    expect(host.exists()).toBe(true); // the todo chip stays
    expect(host.classes()).not.toContain("chips-off");
  });

  it("click toggles the panel (aria-expanded); it lists open tasks only + the done summary", async () => {
    const w = mountComposer(todoView(todoFixture()));
    const btn = w.find(".composer-todo-btn");
    await btn.trigger("click");
    expect(btn.attributes("aria-expanded")).toBe("true");
    const panel = w.find(".composer-todo-panel");
    expect(panel.exists()).toBe(true);
    expect(panel.attributes("aria-readonly")).toBe("true");
    const rows = panel.findAll(".composer-todo-item");
    expect(rows).toHaveLength(2); // in_progress + pending; the completed row never lists
    expect(rows[0]!.attributes("data-status")).toBe("in_progress");
    expect(rows[0]!.text()).toContain("#2 实现投影");
    expect(rows[0]!.text()).toContain("32 KiB 预算"); // description row
    expect(rows[1]!.attributes("data-status")).toBe("pending");
    expect(rows[1]!.text()).toContain("#3 agent 接线");
    expect(rows[1]!.text()).toContain("blocked by #2"); // open-blocker chip
    expect(panel.text()).not.toContain("设计数据通道"); // completed subject absent
    expect(panel.find(".composer-todo-done").text()).toBe("3 done"); // grey header summary
    await btn.trigger("click");
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });

  it("pointerdown outside the composer closes the panel", async () => {
    const w = mountComposer(todoView(todoFixture()));
    await w.find(".composer-todo-btn").trigger("click");
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });

  it("+N more tail = omitted minus the completedHidden fold (TasksPanel's formula)", async () => {
    const w = mountComposer(todoView(todoFixture({ omitted: 5, completedHidden: 2 })));
    await w.find(".composer-todo-btn").trigger("click");
    expect(w.find(".composer-todo-more").text()).toBe("(+3 more)");
    // old wire without completedHidden ⇒ raw omitted count
    const legacy = mountComposer(todoView(todoFixture({ omitted: 4 })));
    await legacy.find(".composer-todo-btn").trigger("click");
    expect(legacy.find(".composer-todo-more").text()).toBe("(+4 more)");
    // no omitted ⇒ no tail
    const none = mountComposer(todoView(todoFixture()));
    await none.find(".composer-todo-btn").trigger("click");
    expect(none.find(".composer-todo-more").exists()).toBe(false);
  });

  it("hover auto-expands the panel; mouseleave collapses it (no click needed)", async () => {
    const w = mountComposer(todoView(todoFixture())); // default stub: fine hover pointer
    const host = w.find(".composer-todo-external");
    const btn = w.find(".composer-todo-btn");
    await host.trigger("mouseenter");
    expect(btn.attributes("aria-expanded")).toBe("true");
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    await host.trigger("mouseleave");
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });

  it("coarse/touch pointer: the synthetic pre-click mouseenter is ignored — the FIRST tap pins the panel open", async () => {
    stubMatchMedia(() => false); // no `(hover: hover) and (pointer: fine)` — touch device
    const w = mountComposer(todoView(todoFixture()));
    const host = w.find(".composer-todo-external");
    const btn = w.find(".composer-todo-btn");
    // Mobile browsers fire mouseenter right before the first click on a touch target.
    await host.trigger("mouseenter");
    expect(w.find(".composer-todo-panel").exists()).toBe(false); // hover never arms on touch
    await btn.trigger("click"); // …then the real click — it must OPEN, not toggle shut
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    expect(btn.attributes("aria-expanded")).toBe("true");
    await btn.trigger("click"); // second tap closes
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
    expect(btn.attributes("aria-expanded")).toBe("false");
  });

  it("static contract: the expanded chip hides its badge via CSS (happy-dom has no layout)", () => {
    // vitest runs from the repo root; import.meta.url is not a file: URL under happy-dom.
    const css = readFileSync(resolve("src/web-hub/ui/src/styles/composer-todo.css"), "utf8");
    expect(css).toMatch(/\.composer-todo-btn\[aria-expanded="true"\]\s+\.composer-todo-badge\s*\{[^}]*display:\s*none/);
  });

  it("click pins the panel (survives mouseleave); a click while expanded always closes", async () => {
    const w = mountComposer(todoView(todoFixture()));
    const host = w.find(".composer-todo-external");
    const btn = w.find(".composer-todo-btn");
    // click without hover ⇒ pinned open
    await btn.trigger("click");
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    // hover in/out must not close a pinned panel
    await host.trigger("mouseenter");
    await host.trigger("mouseleave");
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    expect(btn.attributes("aria-expanded")).toBe("true");
    // click while hover-expanded toggles CLOSED (never a dead second click)
    await host.trigger("mouseenter");
    await btn.trigger("click");
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
    expect(btn.attributes("aria-expanded")).toBe("false");
  });

  it("steer/held scenario: queue rows above the composer ⇒ chip AND panel never render; the chip returns collapsed when the queue drains", async () => {
    const queue: Ref<readonly unknown[]> = ref([{ cmdId: "c1", text: "held steer", state: "held" }]);
    const w = mountComposer(todoView(todoFixture(), queue));
    expect(w.find(".composer-todo-external").exists()).toBe(false);
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
    // queue drains ⇒ the chip comes back COLLAPSED (no stale expanded state)
    queue.value = [];
    await nextTick();
    const btn = w.find(".composer-todo-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });

  it("an expanded panel drops immediately when the steer/held scenario starts", async () => {
    const queue: Ref<readonly unknown[]> = ref([]);
    const w = mountComposer(todoView(todoFixture(), queue));
    await w.find(".composer-todo-btn").trigger("click"); // pin open
    expect(w.find(".composer-todo-panel").exists()).toBe(true);
    // a held steer card lands above the composer
    queue.value = [{ cmdId: "c1", text: "held steer", state: "held" }];
    await nextTick();
    expect(w.find(".composer-todo-external").exists()).toBe(false);
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// schedule-auto-approve r2 §6-W3: the chip's ⏰ segment + the panel's read-only sched section.
// ---------------------------------------------------------------------------

describe("Composer tasks chip ⏰ segment (r2 W3)", () => {
  it("sched-only session (no todo wire): the chip shows ONLY a ⏰ icon (no inline number) + the count badge", () => {
    const w = mountComposer(todoView(undefined), hubOf({ schedules: makePayload() }));
    const btn = w.find(".composer-todo-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.findAll(".seg")).toHaveLength(1); // no ✓ segment without a todo wire
    expect(btn.find(".seg .n").exists()).toBe(false); // single-segment mode: no inline number
    expect(btn.find(".composer-todo-badge").text()).toBe("2"); // fixture: 2 tasks
    expect(btn.attributes("aria-label")).toBe("Show tasks · ⏰ 2"); // aria carries the real count
  });

  it("both sides: inline `✓ N`/`⏰ M` numbers, NO badge; live run spins the clock icon", () => {
    const running = makePayload(); // fixture session carries a `running` run ⇒ live
    const w = mountComposer(todoView(todoFixture()), hubOf({ schedules: running }));
    const btn = w.find(".composer-todo-btn");
    expect(btn.findAll(".seg")).toHaveLength(2);
    expect(btn.find(".composer-todo-badge").exists()).toBe(false); // both-segments mode: no badge
    expect(btn.findAll(".seg .n").map((n) => n.text())).toEqual(["2", "2"]);
    expect(btn.attributes("aria-label")).toBe("Show tasks · ✓ 2 · ⏰ 2");
    const clockSeg = btn.findAll(".seg")[1]!;
    expect(clockSeg.classes()).toContain("live");
    expect(clockSeg.find(".spin").exists()).toBe(true); // spinning clock while a run is live
    const quiet = makePayload([
      makeSession({ tasks: [makeTask()], runs: [] }), // no live run
    ]);
    const w2 = mountComposer(todoView(todoFixture()), hubOf({ schedules: quiet }));
    const seg = w2.find(".composer-todo-btn").findAll(".seg")[1]!;
    expect(seg.classes()).not.toContain("live");
    expect(seg.find(".spin").exists()).toBe(false);
  });

  it("gate: no todo AND no sched projection ⇒ no chip; no sched.v1 cap ⇒ no ⏰ segment", () => {
    expect(mountComposer(todoView(undefined)).find(".composer-todo-external").exists()).toBe(false);
    const noCap = mountComposer(todoView(undefined), hubOf({ caps: [], schedules: makePayload() }));
    expect(noCap.find(".composer-todo-external").exists()).toBe(false);
    // todo-only: single ✓ segment, count as the badge
    const todoOnly = mountComposer(todoView(todoFixture()));
    expect(todoOnly.find(".composer-todo-btn").findAll(".seg")).toHaveLength(1);
    expect(todoOnly.find(".composer-todo-badge").text()).toBe("2");
  });

  it("steer/held (queueAbove) hides the chip even sched-only", () => {
    const queue: Ref<readonly unknown[]> = ref([{ cmdId: "c1", text: "held steer", state: "held" }]);
    const w = mountComposer(todoView(undefined, queue), hubOf({ schedules: makePayload() }));
    expect(w.find(".composer-todo-external").exists()).toBe(false);
    expect(w.find(".composer-todo-panel").exists()).toBe(false);
  });

  it("panel: sched section renders compact rows READ-ONLY (no action buttons, inert names) + the note; run link jumps", async () => {
    const selectRuns: string[][] = [];
    const withRunId = makePayload([
      makeSession({
        tasks: [makeTask()],
        runs: [{ ...makeSession().runs[1]!, runId: "run-w3a" }],
      }),
    ]);
    const w = mountComposer(todoView(undefined), hubOf({ schedules: withRunId, selectRuns }));
    await w.find(".composer-todo-btn").trigger("click");
    const panel = w.find(".composer-todo-panel");
    expect(panel.exists()).toBe(true);
    expect(panel.find(".composer-tasks-sec").exists()).toBe(true);
    expect(panel.findAll(".sched-row")).toHaveLength(1);
    expect(panel.find(".sched-row-acts").exists()).toBe(false); // read-only: no action column
    // a11y (2026-11-05 fix): plainNames — the row name is a plain SPAN, not a focusable button
    const name = panel.find(".sched-row-name");
    expect(name.element.tagName).toBe("SPAN");
    expect(panel.findAll(".composer-tasks-sec button.sched-row-name")).toHaveLength(0);
    expect(panel.find(".composer-sched-readonly").exists()).toBe(true);
    await panel.find(".sched-run-link").trigger("click");
    expect(selectRuns).toEqual([["agent-a", "run-w3a"]]);
  });

  it("badge rulings (2026-11-05 round 2): single segment ⇒ badge carries its count; both ⇒ inline numbers, no badge; expanded ⇒ badge hidden", async () => {
    // todo-only: ✓ icon + the open count as the badge
    const todoOnly = mountComposer(todoView(todoFixture()));
    expect(todoOnly.find(".composer-todo-btn .seg .n").exists()).toBe(false);
    expect(todoOnly.find(".composer-todo-btn .composer-todo-badge").text()).toBe("2");
    // sched-only: ⏰ icon + the sched count as the badge
    const schedOnly = mountComposer(todoView(undefined), hubOf({ schedules: makePayload() }));
    expect(schedOnly.find(".composer-todo-btn .seg .n").exists()).toBe(false);
    expect(schedOnly.find(".composer-todo-btn .composer-todo-badge").text()).toBe("2");
    // both ⇒ inline numbers, NO badge
    const both = mountComposer(todoView(todoFixture()), hubOf({ schedules: makePayload() }));
    expect(both.find(".composer-todo-btn .composer-todo-badge").exists()).toBe(false);
    expect(both.find(".composer-todo-btn").attributes("aria-label")).toBe("Show tasks · ✓ 2 · ⏰ 2");
    // expanded ⇒ badge hidden (existing CSS contract, still applies)
    await both.find(".composer-todo-btn").trigger("click");
    expect(both.find(".composer-todo-btn").attributes("aria-expanded")).toBe("true");
    const css = readFileSync(resolve("src/web-hub/ui/src/styles/composer-todo.css"), "utf8");
    expect(css).toMatch(/\.composer-todo-btn\[aria-expanded="true"\]\s+\.composer-todo-badge\s*\{[^}]*display:\s*none/);
  });

  it("panel: both sections render side by side; the todo list keeps its open-only ruling", async () => {
    const w = mountComposer(todoView(todoFixture()), hubOf({ schedules: makePayload() }));
    await w.find(".composer-todo-btn").trigger("click");
    expect(w.find(".composer-todo-list").exists()).toBe(true);
    expect(w.find(".composer-tasks-sec").exists()).toBe(true);
    expect(w.find(".composer-todo-head .composer-todo-title").text()).toBe("Tasks");
  });
});
