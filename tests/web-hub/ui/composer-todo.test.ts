// @vitest-environment happy-dom
/**
 * Composer todo chip (2026-11 user request): the always-visible `✓ N` open-tasks chip in the
 * composer's bottom row (a `.composer-chips` SIBLING — the typing-time `.chips-off` fade never
 * applies) + its read-only open-only panel. Covers: the empty-state ruling (no todo wire /
 * openCount 0 ⇒ chip not rendered), the count口径 (wire `counts.open` is pending-only, so the
 * chip shows open + inProgress), click toggle with `aria-expanded`, outside-pointerdown close,
 * open-only row filtering (completed surface only as the header's `X done` summary), and the
 * `+N more` tail (`omitted` minus the `completedHidden` fold, TodoPanel's formula).
 */
import { mount } from "@vue/test-utils";
import { computed, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetLangForTests } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState, TodoWire } from "../../../src/web-hub/ui/src/types.js";

function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
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

function todoView(todo: TodoWire | undefined): ControlView {
  const agent = ref({ pendingCtl: [], todo } as unknown as AgentState);
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
  };
}

function mountComposer(view?: ControlView) {
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false },
    global: {
      provide: {
        ...(view ? { [CONTROL_VIEW as symbol]: view } : {}),
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
    expect(btn.find(".composer-todo-badge").text()).toBe("2"); // open 1 + inProgress 1
    expect(btn.attributes("aria-label")).toBe("Show open tasks");
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

  it("+N more tail = omitted minus the completedHidden fold (TodoPanel's formula)", async () => {
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
});
