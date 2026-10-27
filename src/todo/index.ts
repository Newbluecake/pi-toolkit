// Ported from pi-claude-todo (MIT, author is this repository's user) — src/index.ts.
//
// Entry contract (merge-plan D6): `wireTodo(pi)` registers the five Task*
// tools, the `/tasklist` command, and the session restore hooks. It does NOT
// read settings — the `todo.enabled` gate lives at the call site
// (src/index.ts, assembly package D).
//
// Intentional behavior difference vs the standalone pi-claude-todo plugin
// (merge-plan D3 / revision N5): the task widget is TUI-only. `currentUI`
// is assigned only when `ctx.mode === "tui"` and every refresh goes through
// the no-arg `refreshWidget()` (default `ui = currentUI`), so in rpc / print
// / child subagent sessions the `if (!ui) return` guard seals off every
// setWidget path (child sessions are rpc-mode; their widget must not leak
// into the RPC UI bridge). The Task* tools themselves stay fully functional
// headless — state persists via appendEntry in every session.
//
// String constants kept verbatim from the standalone plugin (merge-plan D3)
// so existing session data keeps loading: STATE_ENTRY "claude-code-todo-state"
// (state.ts), LEGACY_STATUS_KEY "claude-code-todo-status", widget key
// "claude-code-todo", command `/tasklist`.
//
// todo-nudge (L1 feature, opt-in via `deps`): a main-session-only staleness
// tracker piggybacked on the same closure. `deps` defaults to `{}` so every
// existing `wireTodo(pi)` call keeps registering zero extra handlers — the
// tracker only turns on when `deps.nudge?.enabled` is true AND
// `deps.isChildSession` is falsy (child subagent sessions never enable it).
// All Task* tool calls funnel through the single `enqueue()` choke point, so
// hooking it there is the one place that sees every touch (list/get included,
// per spec) without touching each of the five tool bodies.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isWebInvocation } from "../commands/capture.js";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { TodoPanel, TodoWidget, WIDGET_RECENT_COMPLETED } from "./ui.js";
import { WORKFLOW_NOTIFICATION_TYPE } from "../adapters/workflow-notice.js";
import { BASH_JOB_NOTIFICATION_TYPE } from "../bash/notify.js";
import { TODO_WIDGET_MOUNTED_EVENT } from "../ui/widget-mount-events.js";
import {
  buildNudgeText,
  DEFAULT_NUDGE_CONFIG,
  initNudgeState,
  isGitWriteCommand,
  recordEvidence,
  recordTodoTouch,
  tickTurn,
  type NudgeConfig,
  type NudgeState,
  type NudgePrecondition,
  type TodoTrackerSnapshot,
} from "./nudge.js";
import {
  activeBlockers,
  archiveCompleted,
  clearTasks,
  cloneState,
  completionTime,
  createTask,
  deleteTask,
  emptyState,
  getTask,
  isArchived,
  newlyUnblockedTasks,
  orderTasks,
  partitionTasks,
  replayState,
  STATE_ENTRY,
  type Task,
  type TaskInput,
  type TaskPartition,
  type TodoState,
  updateTask,
} from "./state.js";

const LEGACY_STATUS_KEY = "claude-code-todo-status";
const WIDGET_KEY = "claude-code-todo";

const MetadataSchema = Type.Optional(Type.Record(Type.String(), Type.Any()));
const TaskIdSchema = Type.String({ description: 'Task ID, for example "1" or "#1".' });
// Repository convention (merge-plan D4.1): Union-of-Literals instead of
// pi-ai's StringEnum (agent-tool.ts precedent) — @sinclair/typebox is the
// only runtime dependency; the two typebox versions are not TS-compatible.
const StatusSchema = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);
const DependencyIdsSchema = Type.Optional(Type.Array(Type.String(), { description: "Task IDs." }));

const TaskCreateSchema = Type.Object({
  subject: Type.String({ description: "Short imperative task title." }),
  description: Type.String({ description: "Detailed task context and acceptance criteria." }),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while active." })),
  owner: Type.Optional(Type.String({ description: "Optional agent or person responsible for the task." })),
  metadata: MetadataSchema,
  blockedBy: DependencyIdsSchema,
  blocks: DependencyIdsSchema,
});
type TaskCreateInput = Static<typeof TaskCreateSchema>;

const TaskListSchema = Type.Object({
  includeCompleted: Type.Optional(
    Type.Boolean({
      description: "Also list completed and archived tasks.",
    }),
  ),
});
type TaskListInput = Static<typeof TaskListSchema>;

const TaskGetSchema = Type.Object({ taskId: TaskIdSchema });
type TaskGetInput = Static<typeof TaskGetSchema>;

const TaskUpdateSchema = Type.Object({
  taskId: TaskIdSchema,
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  status: Type.Optional(StatusSchema),
  owner: Type.Optional(Type.String()),
  metadata: MetadataSchema,
  addBlockedBy: DependencyIdsSchema,
  removeBlockedBy: DependencyIdsSchema,
  addBlocks: DependencyIdsSchema,
  removeBlocks: DependencyIdsSchema,
});
type TaskUpdateInput = Static<typeof TaskUpdateSchema>;

const TaskDeleteSchema = Type.Object({ taskId: TaskIdSchema });
type TaskDeleteInput = Static<typeof TaskDeleteSchema>;

type Action = "create" | "list" | "get" | "update" | "delete";
type ToolDetails = {
  action: Action;
  state: TodoState;
  task?: Task | undefined;
  changed?: boolean | undefined;
  error?: string | undefined;
  unblocked?: Task[] | undefined;
};

/** Opt-in wiring for the main-session todo staleness nudge (L1 feature). Defaults keep `wireTodo(pi)` a no-op addition. */
export interface TodoNudgeDeps {
  /** True in a re-activated child subagent session (src/index.ts's `isChildSession`) — the tracker never turns on there. */
  readonly isChildSession?: boolean;
  readonly nudge?: NudgeConfig & { readonly enabled: boolean };
  /** Injected `pi.sendMessage`, matching the compact-hint/quota-hint hook shape (hidden, never triggers a new turn). */
  readonly sendMessage?: (
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { triggerTurn: false },
  ) => void;
  /** Completed-task auto-archive knobs (todo-archive plan D1, `todo.archive.*` settings). Defaults:
   *  `{ onCompact: true, afterTurns: 30 }`. The per-turn sweeper is registered in main AND child
   *  sessions, independent of the nudge tracker. */
  readonly archive?: TodoArchiveDeps;
}

/** todo-archive plan D1: archive-on-compaction + archive-after-N-turns knobs. */
export interface TodoArchiveDeps {
  /** Sweep all completed tasks inside the serialized `session_compact` handler (default true). */
  readonly onCompact: boolean;
  /** Archive a completed task on the Nth `turn_end` after its completion; 0 disables the per-turn sweeper (default 30). */
  readonly afterTurns: number;
}

const DEFAULT_ARCHIVE_DEPS: TodoArchiveDeps = { onCompact: true, afterTurns: 30 };

export interface TodoWireResult {
  /**
   * Live read of this session's todo closure state (todo-web plan §3.3, T1).
   * Unconditional — unlike `getTrackerSnapshot` below, which only exists while
   * the nudge tracker is armed. `todo.enabled=false` keeps `wireTodo` itself
   * from being called, so the getter is naturally absent there. Returns the
   * closure-state reference (same pattern as TodoWidget's `() => state.tasks`);
   * the web-hub projection (src/web-hub/agent/todo.ts) reads it synchronously
   * and builds its own wire objects, so no clone is needed here.
   */
  getTodoSnapshot: () => TodoState;
  /**
   * Present only while the staleness tracker is active (main session +
   * `nudge.enabled`); lets switch_context append its own handoff advisory
   * through a small read-only snapshot instead of depending on todo
   * internals (docs task spec — "port", not a shared module).
   */
  getTrackerSnapshot?: () => TodoTrackerSnapshot;
}

/** Hidden customType for the nudge message (new, todo-nudge plan); `subagent:*` prefix matches the repo's existing channel convention. */
export const TODO_NUDGE_CUSTOM_TYPE = "subagent:todo-nudge";
/** Run/subagent completion notification customType (delivery/stack-hooks.ts's createNotificationReceiptHook uses the same literal). */
const RUN_NOTIFICATION_CUSTOM_TYPE = "subagent:notification";
/** Bash tool_execution_start/end correlation map is bounded — a session with hundreds of concurrent bash calls is not realistic, and an unbounded map would be the one module-scope-shaped leak this feature could introduce. */
const MAX_PENDING_BASH_COMMANDS = 32;

export function wireTodo(pi: ExtensionAPI, deps: TodoNudgeDeps = {}): TodoWireResult {
  let state = emptyState();
  let currentUI: ExtensionUIContext | undefined;
  let queue: Promise<void> = Promise.resolve();
  // Mount-once + update-in-place (same pattern as FleetWidgetController in
  // src/ui/fleet-widget.ts): `mountedWidget` tracks whether WIDGET_KEY is
  // currently registered so an ordinary task-list change only triggers a
  // repaint of the already-mounted component instead of a fresh
  // `ui.setWidget` call — pi's setExtensionWidget always does a Map
  // delete()+set(), so a repeat call on every task touch was what kept
  // shoving the todo widget below the fleet (agent tree) widget once both
  // had been re-set at least once. `TodoWidget` itself needs no per-update
  // data push (its constructor closes over `() => state.tasks`, so it
  // always reads the live state on its own next render); `requestRenderFn`
  // is only there to ask the host to actually repaint between mounts.
  let mountedWidget = false;
  let requestRenderFn: (() => void) | undefined;

  const nudgeConfig: NudgeConfig = deps.nudge ?? DEFAULT_NUDGE_CONFIG;
  const nudgeTrackingEnabled = !deps.isChildSession && (deps.nudge?.enabled ?? false);
  let nudgeState: NudgeState = initNudgeState(nudgeConfig);
  const pendingBashCommands = new Map<string, string>();

  // todo-archive (D1/D8): archive knobs + per-turn completion-age bookkeeping. `turnSeq` counts
  // turn_end events (only while a per-turn sweeper is registered); `doneSince` maps task id → the
  // turnSeq at which the task was (re-)observed as "completed and not archived". All mutation of
  // both lives inside commit()/restore()/the archive turn_end handler — no module-scope state.
  const archive: TodoArchiveDeps = deps.archive ?? DEFAULT_ARCHIVE_DEPS;
  let turnSeq = 0;
  const doneSince = new Map<number, number>();

  const noteTodoTouch = (): void => {
    nudgeState = recordTodoTouch(nudgeState, nudgeConfig);
  };

  /** todo-archive D8: the ONLY point that assigns `state`. Reconciles `doneSince` per task against
   *  the previous state so intra-turn reopen→recomplete cycles re-age (every tool call commits
   *  individually). Called only inside serialized work or restore() (session boundaries). */
  const commit = (next: TodoState): void => {
    const prevById = new Map(state.tasks.map((task) => [task.id, task]));
    const nextById = new Map(next.tasks.map((task) => [task.id, task]));
    for (const task of next.tasks) {
      if (task.status !== "completed" || isArchived(task)) continue;
      const before = prevById.get(task.id);
      const wasDone = before !== undefined && before.status === "completed" && !isArchived(before);
      if (!wasDone || before.completedAt !== task.completedAt) doneSince.set(task.id, turnSeq);
    }
    for (const id of [...doneSince.keys()]) {
      const task = nextById.get(id);
      if (!task || task.status !== "completed" || isArchived(task)) doneSince.delete(id);
    }
    state = next;
  };

  const restore = (ctx: ExtensionContext): void => {
    // Session boundary (session_start/session_tree/session_compact all call
    // restore()): the nudge counters restart clean — counting turns/evidence
    // across a context reset or a brand-new session would be meaningless.
    nudgeState = initNudgeState(nudgeConfig);
    // Legacy cleanup is capability-gated, not mode-gated: any session with a
    // functional status bridge clears the slot written by pre-isolation
    // versions (widget-only UI cannot be concatenated into HUD's footer
    // line). Bare contexts without ui skip it gracefully.
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
    // TUI gate (revision N5): only the interactive session may own the widget.
    // In rpc/print/child sessions currentUI stays undefined and every
    // refreshWidget() call no-ops at its `if (!ui) return` guard.
    if (ctx.mode === "tui") currentUI = ctx.ui;
    // Bare contexts (tests, exotic hosts) may lack a session manager —
    // degrade to an empty replay instead of throwing (repo convention:
    // graceful degradation on missing host APIs).
    const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    commit(replayState(branch) ?? emptyState());
    // todo-archive §2: after replay the completion ages restart — register every currently
    // "completed and not archived" task at the CURRENT turnSeq (re-count from here).
    doneSince.clear();
    for (const task of state.tasks) {
      if (task.status === "completed" && !isArchived(task)) doneSince.set(task.id, turnSeq);
    }
    refreshWidget();
  };

  const persist = (): void => {
    pi.appendEntry(STATE_ENTRY, cloneState(state));
  };

  const refreshWidget = (ui = currentUI): void => {
    if (!ui) return;
    // todo-archive §2: the hidden⇒visible judgment follows the collapsed widget's own row set
    // (open + 2 recent completions) — a list of only archived tasks unmounts the widget.
    const visible = partitionTasks(state.tasks, WIDGET_RECENT_COMPLETED).visible;
    if (visible.length === 0) {
      // Empty ⇒ hidden: unmount (matches pre-existing behavior) and forget
      // the mount so the NEXT non-empty transition remounts fresh.
      if (mountedWidget) {
        mountedWidget = false;
        requestRenderFn = undefined;
        ui.setWidget(WIDGET_KEY, undefined);
      }
      return;
    }

    if (mountedWidget) {
      // Already visible: an ordinary task-list change repaints the mounted
      // component in place — no setWidget call, so pi's widget Map (and its
      // insertion-order-derived render order) never moves.
      requestRenderFn?.();
      return;
    }

    mountedWidget = true;
    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        requestRenderFn = typeof tui?.requestRender === "function" ? () => tui.requestRender() : undefined;
        return new TodoWidget(() => state.tasks, theme);
      },
      { placement: "aboveEditor" },
    );
    // Announce the hidden→visible transition so the fleet widget (if it is
    // itself currently mounted) can remount to fall back to the end of pi's
    // widget Map, i.e. after this fresh todo entry. See widget-mount-events.ts.
    pi.events?.emit(TODO_WIDGET_MOUNTED_EVENT, { at: Date.now() });
  };

  /** todo-archive D8: serialization only — no nudge touch. Automatic archiving (the per-turn
   *  sweeper and the compaction sweep) goes through here so it never resets the nudge counters. */
  const serialize = <T>(work: () => T): Promise<T> => {
    const run = queue.then(work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const enqueue = <T>(work: () => T): Promise<T> => {
    // Every Task* tool execute funnels through here — including the
    // read-only List/Get calls, which the spec explicitly counts as a touch.
    noteTodoTouch();
    return serialize(work);
  };

  /** todo-archive §2: archive the given completed tasks (or "all"), only inside serialized work.
   *  Persists exactly once per effective change; failures are contained (warn + keep going). */
  const sweep = (ids: number[] | "all"): void => {
    try {
      const next = archiveCompleted(state, ids, Date.now());
      if (next === state) return;
      commit(next);
      persist();
      refreshWidget();
    } catch (error) {
      console.warn(`[pi-subagent] todo archive sweep failed: ${String(error)}`);
    }
  };

  const successfulResult = (
    action: Action,
    extra: Partial<ToolDetails> = {},
  ): { content: [{ type: "text"; text: string }]; details: ToolDetails } => ({
    content: [{ type: "text", text: formatToolText(action, state, extra.task, extra.changed) }],
    details: { action, state: cloneState(state), ...extra },
  });

  const registerMutation = <T extends object>(
    name: string,
    label: string,
    description: string,
    parameters: unknown,
    action: Action,
    handler: (
      params: T,
      ctx: ExtensionContext,
    ) => {
      task?: Task | undefined;
      changed?: boolean | undefined;
      text?: string | undefined;
      unblocked?: Task[] | undefined;
    },
    persistState = true,
  ): void => {
    pi.registerTool({
      name,
      label,
      description,
      // The schema is erased to `unknown` through the helper signature; pi's
      // ToolDefinition is generic over pi-ai's typebox v1 TSchema, which is
      // not TS-assignable from @sinclair/typebox 0.34 schemas (merge-plan
      // §0.9). Runtime structures are compatible — same `as never` pattern
      // as src/index.ts's compat-disabled Agent tool.
      parameters: parameters as never,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return enqueue(() => {
          const result = handler(params as T, ctx);
          if (persistState && result.changed !== false) persist();
          refreshWidget();
          const baseText = result.text ?? formatToolText(action, state, result.task, result.changed);
          const text = appendUnblockedNotice(baseText, result.unblocked);
          notifyUnblocked(ctx, result.unblocked);
          return {
            content: [{ type: "text" as const, text }],
            details: { action, state: cloneState(state), ...result },
          };
        });
      },
      renderCall(args, theme) {
        const taskId =
          typeof (args as { taskId?: unknown }).taskId === "string" ? ` ${(args as { taskId: string }).taskId}` : "";
        return new Text(theme.fg("toolTitle", theme.bold(`${label}${taskId}`)), 0, 0);
      },
      renderResult(result, _options, theme) {
        const details = result.details as ToolDetails | undefined;
        if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
        const text = result.content[0];
        return new Text(theme.fg("muted", text?.type === "text" ? text.text : "Done"), 0, 0);
      },
    });
  };

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description:
      "Create a task for multi-step work. Use an imperative subject and detailed acceptance criteria. Add dependency IDs when ordering matters.",
    promptSnippet: "Create and track a structured task",
    promptGuidelines: [
      "Use TaskCreate for complex work with multiple independently verifiable steps.",
      "Mark a task in_progress with TaskUpdate before starting work and completed immediately after verification.",
      "Use blockedBy and blocks for real dependencies; do not create dependency cycles.",
    ],
    parameters: TaskCreateSchema,
    async execute(_toolCallId, params: TaskCreateInput, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const result = createTask(state, params as TaskInput);
        commit(result.state);
        persist();
        refreshWidget();
        return successfulResult("create", { task: result.task });
      });
    },
    renderCall(args, theme) {
      // args may be partial while the tool call is still streaming, so subject
      // can be absent; guard instead of interpolating `undefined`.
      const subject =
        typeof (args as { subject?: unknown }).subject === "string" ? ` ${(args as { subject: string }).subject}` : "";
      return new Text(theme.fg("toolTitle", theme.bold(`TaskCreate${subject}`)), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as ToolDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      return new Text(theme.fg("success", `✓ Created #${details?.task?.id ?? "?"}`), 0, 0);
    },
  });

  registerMutation<TaskListInput>(
    "TaskList",
    "TaskList",
    "List tasks with status, ownership and dependency information. The default output lists open tasks only; when completed or archived tasks are hidden, a footer reports their counts, the latest completed ids and how to list everything (includeCompleted:true; archived rows are marked, TaskGet still works on them).",
    TaskListSchema,
    "list",
    (params) => {
      refreshWidget();
      return { text: formatTaskList(state, { includeCompleted: params.includeCompleted ?? false }) };
    },
    false,
  );

  registerMutation<TaskGetInput>(
    "TaskGet",
    "TaskGet",
    "Get the full details of one task by ID.",
    TaskGetSchema,
    "get",
    (params) => ({ task: getTask(state, params.taskId) }),
    false,
  );

  registerMutation<TaskUpdateInput>(
    "TaskUpdate",
    "TaskUpdate",
    "Update a task's status, text, owner, metadata or dependencies. Use the task ID returned by TaskCreate or TaskList. Completing a task reports any other tasks it unblocks.",
    TaskUpdateSchema,
    "update",
    (params) => {
      const before = state;
      const result = updateTask(state, params.taskId, {
        subject: params.subject,
        description: params.description,
        activeForm: params.activeForm,
        status: params.status,
        owner: params.owner,
        metadata: params.metadata,
        blockedBy: params.addBlockedBy,
        blocks: params.addBlocks,
        removeBlockedBy: params.removeBlockedBy,
        removeBlocks: params.removeBlocks,
      } as TaskInput);
      commit(result.state);
      refreshWidget();
      const unblocked = result.changed ? newlyUnblockedTasks(before, state) : [];
      return { task: result.task, changed: result.changed, unblocked };
    },
  );

  registerMutation<TaskDeleteInput>(
    "TaskDelete",
    "TaskDelete",
    "Delete a task by ID and remove its dependency edges. Reports any other tasks the deletion unblocks.",
    TaskDeleteSchema,
    "delete",
    (params) => {
      const before = state;
      const result = deleteTask(state, params.taskId);
      commit(result.state);
      const unblocked = newlyUnblockedTasks(before, state);
      return { task: result.task, unblocked };
    },
  );

  pi.registerCommand("tasklist", {
    description: "Show the Claude Code-style task list, or clear it with /tasklist clear",
    handler: async (args, ctx) => {
      // TUI gate (revision N5): same rule as restore() — a rpc/child session
      // must never become the widget owner. A web-claimed invocation keeps
      // `ctx.mode === "tui"` (it is genuinely a TUI session, just also
      // reached over the web-hub capture proxy — plan §4.9 point 6), so it
      // must be excluded here too, or `currentUI` (the long-lived widget
      // host used by every *other* future `refreshWidget()` call) would get
      // swapped for this one invocation's short-lived capture proxy.
      if (ctx.mode === "tui" && !isWebInvocation(ctx)) currentUI = ctx.ui;
      if (args.trim().toLowerCase() === "clear") {
        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm("Clear tasks?", "This permanently clears the current session task list."))
        )
          return;
        await enqueue(() => {
          // todo-archive D9: clearTasks keeps the nextId high-water mark so ids
          // are never reused within this branch/session.
          commit(clearTasks(state));
          persist();
          refreshWidget();
        });
        ctx.ui.notify("Task list cleared.", "info");
        return;
      }
      if (ctx.mode !== "tui" || isWebInvocation(ctx)) {
        // Collapsed format (open tasks + hidden-count footer) for non-TUI/web invocations.
        ctx.ui.notify(formatTaskList(state), "info");
        return;
      }
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) =>
          new TodoPanel(
            () => state.tasks,
            theme,
            () => done(),
          ),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  // todo-archive D1(a)/D8: compaction restores first (inside the same serial queue, AFTER any
  // already-enqueued tool mutations), then sweeps every completed task. The handler returns the
  // serialize() promise — pi awaits session_compact handlers, so the archive entry is on disk
  // before compact() resolves. session_start/session_tree stay synchronous restore-only (R6).
  pi.on("session_compact", (_event, ctx) =>
    serialize(() => {
      restore(ctx);
      if (archive.onCompact) sweep("all");
    }),
  );
  // todo-archive D1(b): the per-turn sweeper, registered OUTSIDE the nudge conditional — main
  // AND child sessions, independent of nudge tracking. A task is archived on the Nth turn_end
  // after its completion; collapsed/hidden completed tasks age the same way. Runs through
  // serialize() so it neither resets the nudge (D8) nor races in-flight tool mutations.
  if (archive.afterTurns > 0) {
    pi.on("turn_end", () =>
      serialize(() => {
        turnSeq++;
        const due = [...doneSince].filter(([, since]) => turnSeq - since >= archive.afterTurns).map(([id]) => id);
        if (due.length > 0) sweep(due);
      }),
    );
  }
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    mountedWidget = false;
    requestRenderFn = undefined;
    currentUI = undefined;
  });

  if (nudgeTrackingEnabled) {
    // E1: a completion notification (subagent / workflow / bash job) entered
    // the session. message_start fires for every message regardless of
    // display, matching delivery/stack-hooks.ts's createNotificationReceiptHook pattern.
    pi.on("message_start", (event) => {
      const message = (event as { message?: { role?: string; customType?: string } }).message;
      if (message?.role !== "custom") return;
      if (
        message.customType === RUN_NOTIFICATION_CUSTOM_TYPE ||
        message.customType === WORKFLOW_NOTIFICATION_TYPE ||
        message.customType === BASH_JOB_NOTIFICATION_TYPE
      ) {
        nudgeState = recordEvidence(nudgeState, "e1");
      }
    });

    // E2: a successful bash "git commit|merge|cherry-pick|rebase|revert".
    // tool_execution_end never carries the command text, so the command is
    // captured on tool_execution_start and correlated by toolCallId —
    // toolName "bash" catches both pi's built-in tool and this repo's
    // same-name auto-background override (bash-tool.ts), which passes the
    // built-in's resolve/reject through verbatim: a non-zero exit code
    // always throws there, so `!isError` already means "exit 0", no separate
    // exit-code parsing needed.
    pi.on("tool_execution_start", (event) => {
      const e = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
      if (e.toolName !== "bash" || typeof e.toolCallId !== "string") return;
      const command = (e.args as { command?: unknown } | undefined)?.command;
      if (typeof command !== "string") return;
      if (pendingBashCommands.size >= MAX_PENDING_BASH_COMMANDS) {
        const oldestKey = pendingBashCommands.keys().next().value;
        if (oldestKey !== undefined) pendingBashCommands.delete(oldestKey);
      }
      pendingBashCommands.set(e.toolCallId, command);
    });
    pi.on("tool_execution_end", (event) => {
      const e = event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; result?: unknown };
      if (e.toolName !== "bash" || typeof e.toolCallId !== "string") return;
      const command = pendingBashCommands.get(e.toolCallId);
      pendingBashCommands.delete(e.toolCallId);
      if (command === undefined || e.isError) return;
      // An auto-/explicitly backgrounded call returns early with
      // `details.background: true` — that says nothing about the git command's
      // final exit. Its settle arrives later as a bash-job notification, which
      // E1 already counts, so never score E2 on the early return.
      const details = (e.result as { details?: { background?: unknown } } | undefined)?.details;
      if (details?.background === true) return;
      if (isGitWriteCommand(command)) nudgeState = recordEvidence(nudgeState, "e2");
    });

    // E3 + trigger evaluation. Hidden message, never triggers a new turn.
    pi.on("turn_end", () => {
      const precondition: NudgePrecondition = {
        inProgress: state.tasks.filter((task) => task.status === "in_progress").length,
        pending: state.tasks.filter((task) => task.status === "pending").length,
      };
      const result = tickTurn(nudgeState, nudgeConfig, precondition);
      nudgeState = result.state;
      if (!result.fire) return;
      const listedTasks =
        result.kind === "untracked"
          ? state.tasks.filter((task) => task.status === "pending")
          : state.tasks.filter((task) => task.status === "in_progress");
      const text = buildNudgeText(
        { e1: nudgeState.e1, e2: nudgeState.e2, e3: nudgeState.e3 },
        listedTasks,
        result.kind,
      );
      try {
        deps.sendMessage?.(
          {
            customType: TODO_NUDGE_CUSTOM_TYPE,
            content: text,
            display: false,
            details: { e1: nudgeState.e1, e2: nudgeState.e2, e3: nudgeState.e3, kind: result.kind },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        console.warn(`[pi-subagent] todo nudge send failed: ${String(error)}`);
      }
    });

    return {
      getTodoSnapshot: (): TodoState => state,
      getTrackerSnapshot: (): TodoTrackerSnapshot => ({
        openTaskCount: state.tasks.filter((task) => task.status !== "completed").length,
        turnsSinceTouch: nudgeState.e3,
        hasEvidence: nudgeState.e1 + nudgeState.e2 >= 1,
      }),
    };
  }

  return { getTodoSnapshot: (): TodoState => state };
}

function appendUnblockedNotice(text: string, unblocked?: Task[]): string {
  const suffix = formatUnblockedSuffix(unblocked);
  return suffix ? `${text}\n${suffix}` : text;
}

function formatUnblockedSuffix(unblocked?: Task[]): string | undefined {
  if (!unblocked || unblocked.length === 0) return undefined;
  return `Unblocked: ${unblocked.map((task) => `#${task.id} ${task.subject}`).join(", ")}`;
}

function notifyUnblocked(ctx: ExtensionContext, unblocked?: Task[]): void {
  if (!unblocked || unblocked.length === 0) return;
  if (!ctx.hasUI) return;
  const list = unblocked.map((task) => `#${task.id} ${task.subject}`).join("\u3001");
  ctx.ui.notify(`\u53ef\u4ee5\u7ee7\u7eed\u63a8\u8fdb\uff1a${list}`, "info");
}

function formatTaskLine(task: Task, tasks: readonly Task[]): string {
  const icon = task.status === "completed" ? "\u2713" : task.status === "in_progress" ? "\u2733" : "\u25cb";
  const blockers = activeBlockers(task, tasks);
  const suffix = blockers.length > 0 ? ` [blocked by ${blockers.map((id) => `#${id}`).join(", ")}]` : "";
  const owner = task.owner ? ` (${task.owner})` : "";
  const archived = isArchived(task) ? " [archived]" : "";
  return `${icon} #${task.id} ${task.status} ${task.subject}${owner}${suffix}${archived}`;
}

/** Up to this many latest-completed ids appear in the collapsed TaskList footer (todo-archive D3). */
const FOOTER_LATEST_IDS = 3;

function formatHiddenFooter(partition: TaskPartition): string | undefined {
  const parts: string[] = [];
  if (partition.hiddenCompleted > 0) {
    const latest = [...partition.completed]
      .sort((a, b) => {
        const delta = completionTime(b) - completionTime(a);
        return delta !== 0 ? delta : b.id - a.id;
      })
      .slice(0, FOOTER_LATEST_IDS)
      .reverse()
      .map((task) => `#${task.id}`)
      .join(", ");
    parts.push(`Completed: ${partition.hiddenCompleted} hidden (latest ${latest}; includeCompleted:true lists all)`);
  }
  if (partition.archived.length > 0) {
    parts.push(`Archived: ${partition.archived.length} (TaskGet <id> still works)`);
  }
  return parts.length > 0 ? parts.join(" \u00b7 ") : undefined;
}

/** todo-archive D3: the default output lists open tasks only; hidden completed/archived tasks are
 *  summarized in a one-line footer (zero-count clauses omitted). With only open tasks the output
 *  is byte-identical to the pre-archive full listing; `includeCompleted:true` restores the full
 *  listing with ` [archived]` markers. Dependency info always comes from the FULL task list. */
function formatTaskList(state: TodoState, opts: { includeCompleted?: boolean } = {}): string {
  if (state.tasks.length === 0) return "No tasks.";
  if (opts.includeCompleted) {
    return orderTasks(state.tasks)
      .map((task) => `${formatTaskLine(task, state.tasks)}\n  ${task.description}`)
      .join("\n");
  }
  const partition = partitionTasks(state.tasks, 0);
  const lines = partition.open.map((task) => `${formatTaskLine(task, state.tasks)}\n  ${task.description}`);
  const footer = formatHiddenFooter(partition);
  if (lines.length === 0) return footer ? `No open tasks.\n${footer}` : "No open tasks.";
  return footer ? `${lines.join("\n")}\n${footer}` : lines.join("\n");
}

function formatToolText(action: Action, state: TodoState, task?: Task, changed = true): string {
  switch (action) {
    case "create":
      return task ? `Task #${task.id} created: ${task.subject}` : "Task created.";
    case "get":
      return task ? `${formatTaskLine(task, state.tasks)}\n${task.description}` : "Task found.";
    case "update":
      return task
        ? changed
          ? `Task #${task.id} updated: ${task.status} — ${task.subject}`
          : `Task #${task.id} unchanged.`
        : "Task updated.";
    case "delete":
      return task ? `Task #${task.id} deleted: ${task.subject}` : "Task deleted.";
    case "list":
      return formatTaskList(state);
  }
}
