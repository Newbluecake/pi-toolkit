// Ported from pi-claude-todo (MIT, author is this repository's user) — src/ui.ts.
// Adaptations per docs/dev/plugin-merge/merge-plan.md: ESM NodeNext import
// suffix (N2); cachedWidth/cachedLines explicitly `| undefined` for
// exactOptionalPropertyTypes (D4.2).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, Text } from "@earendil-works/pi-tui";
import { activeBlockers, isArchived, isBlocked, orderTasks, partitionTasks, type Task } from "./state.js";

const WIDGET_TASK_LIMIT = 6;
const PANEL_TASK_LIMIT = 10;
/** todo-archive D4: the collapsed widget shows the 2 most recently completed tasks, the panel 3. */
export const WIDGET_RECENT_COMPLETED = 2;
export const PANEL_RECENT_COMPLETED = 3;

export class TodoWidget implements Component {
  constructor(
    private readonly getTasks: () => readonly Task[],
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    // D7: every dependency lookup below is fed the FULL task list — archived completed
    // predecessors must not turn into phantom blockers. The partition only picks rows/counts.
    const allTasks = this.getTasks();
    const partition = partitionTasks(allTasks, WIDGET_RECENT_COMPLETED);
    const tasks = [
      ...selectWidgetTasks(partition.open, WIDGET_TASK_LIMIT - partition.recentCompleted.length),
      ...partition.recentCompleted,
    ];
    // Title counts never include archived tasks (D7).
    const unarchived = partition.open.length + partition.completed.length;
    const completed = partition.completed.length;
    const active = partition.open.filter((task) => task.status === "in_progress").length;
    const blocked = partition.open.filter((task) => isBlocked(task, allTasks)).length;
    const title =
      active > 0 ? `Tasks ${completed}/${unarchived} · ${active} active` : `Tasks ${completed}/${unarchived}`;
    const lines = [truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(title))}`, width)];

    for (const task of tasks) lines.push(...renderTaskLines(task, allTasks, this.theme, width));

    const moreOpen = partition.open.length - (tasks.length - partition.recentCompleted.length);
    if (moreOpen > 0) {
      const suffix = blocked > 0 ? ` · ${blocked} blocked` : "";
      lines.push(
        truncateToWidth(` ${this.theme.fg("dim", `… ${moreOpen} more${suffix} · /tasklist to view all`)}`, width),
      );
    }
    // Collapsed-done marker (D4, English token per the repo UI-text convention); the widget never
    // mentions archival — archived rows simply do not exist here and are not counted.
    if (partition.hiddenCompleted > 0) {
      lines.push(truncateToWidth(` ${this.theme.fg("dim", `✓ ${partition.hiddenCompleted} done`)}`, width));
    }
    return lines;
  }

  invalidate(): void {}
}

export class TodoPanel implements Component {
  private offset = 0;
  private showAll = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly getTasks: () => readonly Task[],
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  /** The panel's current row list: collapsed mode = open + PANEL_RECENT_COMPLETED latest completions
   *  (todo-archive D4); all mode = orderTasks(full list) with archived rows dimmed. One source for
   *  both handleInput's offset clamping and render. */
  private rows(): Task[] {
    const all = this.getTasks();
    if (this.showAll) return orderTasks(all);
    const partition = partitionTasks(all, PANEL_RECENT_COMPLETED);
    return [...partition.open, ...partition.recentCompleted];
  }

  handleInput(data: string): void {
    const tasks = this.rows();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }
    // Plain `a` toggles collapsed/all (todo-archive §2 ui); matchesKey rejects ctrl+a (\x01) and
    // alt+a (\x1ba) — the toggle must not fire on modified keys.
    if (matchesKey(data, "a")) {
      this.showAll = !this.showAll;
      this.offset = 0;
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

    // D7: dependency lookups always use the FULL list; title counts exclude archived tasks.
    const allTasks = this.getTasks();
    const partition = partitionTasks(allTasks, PANEL_RECENT_COMPLETED);
    const unarchived = partition.open.length + partition.completed.length;
    const completed = partition.completed.length;
    const active = partition.open.filter((task) => task.status === "in_progress").length;
    const title =
      active > 0
        ? ` Tasks · ${completed}/${unarchived} complete · ${active} active `
        : ` Tasks · ${completed}/${unarchived} complete `;
    const lines = [
      truncateToWidth(
        this.theme.fg("borderMuted", "─".repeat(2)) +
          this.theme.fg("accent", this.theme.bold(title)) +
          this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 2))),
        width,
      ),
      "",
    ];

    if (allTasks.length === 0) {
      lines.push(truncateToWidth(` ${this.theme.fg("dim", "No tasks yet.")}`, width));
    } else {
      const tasks = this.rows();
      const visible = tasks.slice(this.offset, this.offset + PANEL_TASK_LIMIT);
      for (const task of visible)
        lines.push(
          ...renderTaskLines(task, allTasks, this.theme, width, this.showAll ? { archived: isArchived(task) } : {}),
        );
      if (this.offset > 0 || this.offset + visible.length < tasks.length) {
        lines.push(
          truncateToWidth(
            ` ${this.theme.fg("dim", `Showing ${this.offset + 1}-${this.offset + visible.length} of ${tasks.length}`)}`,
            width,
          ),
        );
      }
      if (!this.showAll) {
        // Collapsed-mode summary line (D4/D7): hidden completed + archived counts, zero parts omitted.
        const parts: string[] = [];
        if (partition.hiddenCompleted > 0) parts.push(`✓ ${partition.hiddenCompleted} done`);
        if (partition.archived.length > 0) parts.push(`${partition.archived.length} archived`);
        if (parts.length > 0) lines.push(truncateToWidth(` ${this.theme.fg("dim", parts.join(" · "))}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        ` ${this.theme.fg(
          "dim",
          this.showAll
            ? "↑↓ scroll · PgUp/PgDn jump · a collapse · Esc close"
            : "↑↓ scroll · PgUp/PgDn jump · a show all · Esc close",
        )}`,
        width,
      ),
    );
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function renderTaskLines(
  task: Task,
  tasks: readonly Task[],
  theme: Theme,
  width: number,
  options: { archived?: boolean } = {},
): string[] {
  const blockers = activeBlockers(task, tasks);
  const icon =
    task.status === "completed" ? "✓" : task.status === "in_progress" ? "✳" : blockers.length > 0 ? "⊘" : "○";
  const label = task.status === "in_progress" ? (task.activeForm ?? task.subject) : task.subject;
  const owner = task.owner ? theme.fg("dim", ` · ${task.owner}`) : "";
  const archivedSuffix = options.archived ? theme.fg("dim", " · archived") : "";
  let subject: string;
  if (task.status === "completed") subject = theme.fg("dim", theme.strikethrough(label));
  else if (task.status === "in_progress") subject = theme.fg("warning", theme.bold(label));
  else if (blockers.length > 0) subject = theme.fg("muted", label);
  else subject = theme.fg("text", label);

  const iconText =
    task.status === "completed"
      ? theme.fg("success", icon)
      : task.status === "in_progress"
        ? theme.fg("warning", icon)
        : blockers.length > 0
          ? theme.fg("error", icon)
          : theme.fg("dim", icon);
  const primary = ` ${iconText} ${theme.fg("accent", `#${task.id}`)} ${subject}${owner}${archivedSuffix}`;
  const lines = [truncateToWidth(primary, width)];

  if (blockers.length > 0 && task.status !== "completed") {
    lines.push(
      truncateToWidth(`   ${theme.fg("dim", `↳ blocked by ${blockers.map((id) => `#${id}`).join(", ")}`)}`, width),
    );
  }
  return lines;
}

function selectWidgetTasks(tasks: readonly Task[], limit: number): readonly Task[] {
  if (limit <= 0) return [];
  if (tasks.length <= limit) return tasks;
  const activeIndex = tasks.findIndex((task) => task.status === "in_progress");
  if (activeIndex < 0) return tasks.slice(0, limit);
  const start = Math.max(0, Math.min(activeIndex - 2, tasks.length - limit));
  return tasks.slice(start, start + limit);
}
