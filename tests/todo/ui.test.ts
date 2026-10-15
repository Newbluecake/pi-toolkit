// todo-archive plan §3 (tests/todo/ui.test.ts): the collapsed TodoWidget (2 recent completions,
// `✓ N done` marker, archived-free title counts) and the TodoPanel `a` toggle (collapsed/all,
// ctrl+a and alt+a must NOT toggle, offset reset + clamp, mode-dependent footer hint). Stub theme
// — the assertions run on the plain-text projection, no ANSI.

import { describe, expect, test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TodoPanel, TodoWidget, PANEL_RECENT_COMPLETED, WIDGET_RECENT_COMPLETED } from "../../src/todo/ui.js";
import {
  archiveCompleted,
  createTask,
  emptyState,
  type Task,
  type TodoState,
  updateTask,
} from "../../src/todo/state.js";

const stubTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function withTasks(count: number, subject = "T"): TodoState {
  let state = emptyState();
  for (let i = 0; i < count; i++)
    state = createTask(state, { subject: `${subject}${i + 1}`, description: "d" }, i + 1).state;
  return state;
}
void withTasks;

function complete(state: TodoState, ids: number[], base = 100): TodoState {
  let next = state;
  for (const [i, id] of ids.entries()) next = updateTask(next, String(id), { status: "completed" }, base + i).state;
  return next;
}

describe("TodoWidget (todo-archive D4/D7)", () => {
  test("collapsed rows: open tasks then recent completions; `✓ N done` counts the hidden ones", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B" }, 2).state;
    state = createTask(state, { subject: "C", description: "C" }, 3).state;
    state = createTask(state, { subject: "D", description: "D" }, 4).state;
    state = updateTask(state, "2", { status: "completed" }, 10).state;
    state = updateTask(state, "3", { status: "completed" }, 20).state;
    state = updateTask(state, "4", { status: "completed" }, 30).state;

    const lines = new TodoWidget(() => state.tasks, stubTheme).render(80);
    const text = lines.join("\n");
    // Title counts non-archived only: 3 of 4 complete.
    expect(lines[0]).toBe(" Tasks 3/4");
    // Rows: #1 open, then recent-2 ascending (#3 then #4); #2 is the hidden one.
    expect(text).toContain("○ #1 A");
    expect(text).toContain("✓ #3 C");
    expect(text).toContain("✓ #4 D");
    expect(text).not.toContain("#2 B");
    expect(text).toContain("✓ 1 done");
    expect(WIDGET_RECENT_COMPLETED).toBe(2);
  });

  test("title counts and rows exclude archived tasks entirely", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B" }, 2).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    state = archiveCompleted(state, "all", 11);

    const lines = new TodoWidget(() => state.tasks, stubTheme).render(80);
    const text = lines.join("\n");
    expect(lines[0]).toBe(" Tasks 0/1"); // archived #1 outside both numerator and denominator
    expect(text).not.toContain("#1 A");
    expect(text).not.toContain("done"); // no hidden completions left, no marker
  });

  test("open overflow keeps the `… K more` line; blocked suffix unchanged", () => {
    let state = emptyState();
    for (let i = 1; i <= 8; i++) state = createTask(state, { subject: `T${i}`, description: "d" }, i).state;
    state = updateTask(state, "3", { status: "in_progress" }, 50).state;

    const lines = new TodoWidget(() => state.tasks, stubTheme).render(80);
    const text = lines.join("\n");
    expect(text).toContain("… 2 more · /tasklist to view all"); // 6 open shown, 2 hidden
    expect(text).not.toContain("done");
  });

  test("regression (plan §3): an archived completed predecessor does not render ⊘ / blocked", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B", blockedBy: ["1"] }, 2).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    state = archiveCompleted(state, "all", 11);

    const widget = new TodoWidget(() => state.tasks, stubTheme).render(80).join("\n");
    expect(widget).not.toContain("⊘");
    expect(widget).not.toContain("blocked");
    expect(widget).toContain("○ #2 B");

    const panel = new TodoPanel(
      () => state.tasks,
      stubTheme,
      () => undefined,
    )
      .render(80)
      .join("\n");
    expect(panel).not.toContain("⊘");
    expect(panel).not.toContain("blocked by");
  });
});

describe("TodoPanel (todo-archive §2 ui / D6)", () => {
  function panelOf(tasks: () => readonly Task[]): TodoPanel {
    return new TodoPanel(tasks, stubTheme, () => undefined);
  }

  function collapsedState(): TodoState {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B" }, 2).state;
    state = createTask(state, { subject: "C", description: "C" }, 3).state;
    state = createTask(state, { subject: "D", description: "D" }, 4).state;
    state = updateTask(state, "2", { status: "completed" }, 10).state;
    state = updateTask(state, "3", { status: "completed" }, 20).state;
    state = updateTask(state, "4", { status: "completed" }, 30).state;
    state = archiveCompleted(state, [2], 40); // #2 archived; #3/#4 recent completions
    return state;
  }

  test("collapsed mode: open + 3 recent completions + summary line; hint says 'a show all'", () => {
    const state = collapsedState();
    const panel = panelOf(() => state.tasks);
    const text = panel.render(80).join("\n");
    expect(text).toContain("○ #1 A");
    expect(text).toContain("✓ #3 C");
    expect(text).toContain("✓ #4 D");
    expect(text).not.toContain("#2 B");
    expect(text).toContain("1 archived");
    expect(text).not.toContain("done"); // hiddenCompleted is 0 ⇒ that part is omitted
    expect(text).toContain("a show all");
    expect(PANEL_RECENT_COMPLETED).toBe(3);
  });

  test("'a' toggles to all mode: archived row dimmed with ' · archived', hint flips", () => {
    const state = collapsedState();
    const panel = panelOf(() => state.tasks);
    panel.render(80);
    panel.handleInput("a");
    const text = panel.render(80).join("\n");
    expect(text).toContain("✓ #2 B · archived");
    expect(text).toContain("a collapse");
    expect(text).not.toContain("a show all");

    panel.handleInput("a");
    const back = panel.render(80).join("\n");
    expect(back).not.toContain("· archived");
    expect(back).toContain("a show all");
  });

  test("ctrl+a (\\x01) and alt+a (\\x1ba) do NOT toggle", () => {
    const state = collapsedState();
    const panel = panelOf(() => state.tasks);
    panel.render(80);
    panel.handleInput("\x01");
    expect(panel.render(80).join("\n")).toContain("a show all");
    panel.handleInput("\x1ba");
    expect(panel.render(80).join("\n")).toContain("a show all");
    // But plain 'a' still works after the modified keys.
    panel.handleInput("a");
    expect(panel.render(80).join("\n")).toContain("a collapse");
  });

  test("toggling resets the offset; offsets clamp against the current mode's row count", () => {
    const state = collapsedState();
    const panel = panelOf(() => state.tasks);
    // Scroll down in collapsed mode (4 rows: #1,#3,#4 → only 3... use pgDn to jump past the end).
    panel.handleInput("\x1b[6~"); // pageDown
    const clamped = panel.render(80).join("\n");
    expect(clamped).not.toContain("Showing 11-"); // clamped to the row count, no negative overshoot
    expect(clamped).not.toContain("Showing 4-0");

    panel.handleInput("a"); // toggle resets offset to 0
    const all = panel.render(80).join("\n");
    // Offset reset to the top of all mode: first row is open #1, archived #2 renders.
    expect(all).toContain("○ #1 A");
    expect(all).toContain("✓ #2 B · archived");
    expect(all).not.toContain("Showing"); // 4 rows fit in one page
  });

  test("empty list still renders 'No tasks yet.' with the collapsed hint", () => {
    const panel = panelOf(() => []);
    const text = panel.render(80).join("\n");
    expect(text).toContain("No tasks yet.");
    expect(text).toContain("a show all");
  });
});
