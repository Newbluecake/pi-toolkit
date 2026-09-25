// Ported from pi-claude-todo (MIT, author is this repository's user) — src/ui.ts.
// Adaptations per docs/dev/plugin-merge/merge-plan.md: ESM NodeNext import
// suffix (N2); cachedWidth/cachedLines explicitly `| undefined` for
// exactOptionalPropertyTypes (D4.2).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, Text } from "@earendil-works/pi-tui";
import { orderTasks, type Task } from "./state.js";

const WIDGET_TASK_LIMIT = 6;
const PANEL_TASK_LIMIT = 10;

export class TodoWidget implements Component {
  constructor(
    private readonly getTasks: () => readonly Task[],
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const allTasks = orderTasks(this.getTasks());
    const tasks = selectWidgetTasks(allTasks);
    const completed = allTasks.filter((task) => task.status === "completed").length;
    const active = allTasks.filter((task) => task.status === "in_progress").length;
    const blocked = allTasks.filter((task) => task.blockedBy.length > 0 && task.status !== "completed").length;
    const title =
      active > 0 ? `Tasks ${completed}/${allTasks.length} · ${active} active` : `Tasks ${completed}/${allTasks.length}`;
    const lines = [truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(title))}`, width)];

    for (const task of tasks) lines.push(...renderTaskLines(task, this.theme, width));

    const omitted = allTasks.length - tasks.length;
    if (omitted > 0) {
      const suffix = blocked > 0 ? ` · ${blocked} blocked` : "";
      lines.push(
        truncateToWidth(` ${this.theme.fg("dim", `… ${omitted} more${suffix} · /tasklist to view all`)}`, width),
      );
    }
    return lines;
  }

  invalidate(): void {}
}

export class TodoPanel implements Component {
  private offset = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly getTasks: () => readonly Task[],
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    const tasks = orderTasks(this.getTasks());
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, "down")) this.offset = Math.min(Math.max(0, tasks.length - PANEL_TASK_LIMIT), this.offset + 1);
    if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - PANEL_TASK_LIMIT);
    if (matchesKey(data, "pageDown"))
      this.offset = Math.min(Math.max(0, tasks.length - PANEL_TASK_LIMIT), this.offset + PANEL_TASK_LIMIT);
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const tasks = orderTasks(this.getTasks());
    const completed = tasks.filter((task) => task.status === "completed").length;
    const active = tasks.filter((task) => task.status === "in_progress").length;
    const title =
      active > 0
        ? ` Tasks · ${completed}/${tasks.length} complete · ${active} active `
        : ` Tasks · ${completed}/${tasks.length} complete `;
    const lines = [
      truncateToWidth(
        this.theme.fg("borderMuted", "─".repeat(2)) +
          this.theme.fg("accent", this.theme.bold(title)) +
          this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 2))),
        width,
      ),
      "",
    ];

    if (tasks.length === 0) {
      lines.push(truncateToWidth(` ${this.theme.fg("dim", "No tasks yet.")}`, width));
    } else {
      const visible = tasks.slice(this.offset, this.offset + PANEL_TASK_LIMIT);
      for (const task of visible) lines.push(...renderTaskLines(task, this.theme, width));
      if (this.offset > 0 || this.offset + visible.length < tasks.length) {
        lines.push(
          truncateToWidth(
            ` ${this.theme.fg("dim", `Showing ${this.offset + 1}-${this.offset + visible.length} of ${tasks.length}`)}`,
            width,
          ),
        );
      }
    }

    lines.push("");
    lines.push(truncateToWidth(` ${this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn jump · Esc close")}`, width));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function renderTaskLines(task: Task, theme: Theme, width: number): string[] {
  const icon =
    task.status === "completed" ? "✓" : task.status === "in_progress" ? "✳" : task.blockedBy.length > 0 ? "⊘" : "○";
  const label = task.status === "in_progress" ? (task.activeForm ?? task.subject) : task.subject;
  const owner = task.owner ? theme.fg("dim", ` · ${task.owner}`) : "";
  let subject: string;
  if (task.status === "completed") subject = theme.fg("dim", theme.strikethrough(label));
  else if (task.status === "in_progress") subject = theme.fg("warning", theme.bold(label));
  else if (task.blockedBy.length > 0) subject = theme.fg("muted", label);
  else subject = theme.fg("text", label);

  const iconText =
    task.status === "completed"
      ? theme.fg("success", icon)
      : task.status === "in_progress"
        ? theme.fg("warning", icon)
        : task.blockedBy.length > 0
          ? theme.fg("error", icon)
          : theme.fg("dim", icon);
  const primary = ` ${iconText} ${theme.fg("accent", `#${task.id}`)} ${subject}${owner}`;
  const lines = [truncateToWidth(primary, width)];

  if (task.blockedBy.length > 0 && task.status !== "completed") {
    lines.push(
      truncateToWidth(
        `   ${theme.fg("dim", `↳ blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}`)}`,
        width,
      ),
    );
  }
  return lines;
}

function selectWidgetTasks(tasks: readonly Task[]): readonly Task[] {
  if (tasks.length <= WIDGET_TASK_LIMIT) return tasks;
  const activeIndex = tasks.findIndex((task) => task.status === "in_progress");
  if (activeIndex < 0) return tasks.slice(0, WIDGET_TASK_LIMIT);
  const start = Math.max(0, Math.min(activeIndex - 2, tasks.length - WIDGET_TASK_LIMIT));
  return tasks.slice(start, start + WIDGET_TASK_LIMIT);
}

export function renderTaskPreview(task: Task, theme: Theme): Component {
  return new Text(renderTaskLines(task, theme, 80).join("\n"), 0, 0);
}
