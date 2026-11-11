/**
 * Local TS mirror of `@logic/schedule.js`'s `TaskRow`/`TaskLastRun` JSDoc typedefs (the logic
 * module is checkJs-off, so its typedefs don't reach vue-tsc). Drift is pinned by
 * `tests/web-hub/ui/schedule-logic.test.ts`'s toMatchObject/equality checks. Same escape
 * hatch as SchedulePanel.vue's PanelTask interface — contracts.ts stays untouched.
 */
export interface TaskLastRun {
  state: string;
  catchUp?: { dueCount: number };
  at: number | undefined;
  runId: string | undefined;
}

export interface TaskRow {
  id: string;
  name: string;
  whenText: string;
  nextAt: number | undefined;
  /** Compact relative token (relIn) for nextAt; "" when there is none. */
  nextIn: string;
  enabled: boolean;
  /** Any non-terminal run of this task (chip: running + spinner). */
  live: boolean;
  lastRun: TaskLastRun | undefined;
}

/** `schedSummaryOf`'s return (the TasksPanel summary's ⏰ segment). */
export interface SchedSummary {
  count: number;
  live: boolean;
}
