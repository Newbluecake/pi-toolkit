// Ported from pi-claude-todo (MIT, author is this repository's user) — src/index.ts.
//
// Entry contract (merge-plan D6): `wireTodo(pi)` registers the five Task*
// tools, the `/tasks` command, and the session restore hooks. It does NOT
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
// "claude-code-todo", command `/tasks`.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { TodoPanel, TodoWidget } from "./ui.js";
import {
  cloneState,
  createTask,
  deleteTask,
  emptyState,
  getTask,
  orderTasks,
  replayState,
  STATE_ENTRY,
  type Task,
  type TaskInput,
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
const DependencyIdsSchema = Type.Optional(Type.Array(Type.String(), { description: 'Task IDs such as ["1", "2"].' }));

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

const TaskListSchema = Type.Object({});
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
};

export function wireTodo(pi: ExtensionAPI): void {
  let state = emptyState();
  let currentUI: ExtensionUIContext | undefined;
  let queue: Promise<void> = Promise.resolve();

  const restore = (ctx: ExtensionContext): void => {
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
    state = replayState(branch) ?? emptyState();
    refreshWidget();
  };

  const persist = (): void => {
    pi.appendEntry(STATE_ENTRY, cloneState(state));
  };

  const refreshWidget = (ui = currentUI): void => {
    if (!ui) return;
    const tasks = state.tasks;
    if (tasks.length === 0) {
      ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ui.setWidget(WIDGET_KEY, (_tui, theme) => new TodoWidget(() => state.tasks, theme), {
      placement: "aboveEditor",
    });
  };

  const enqueue = <T>(work: () => T): Promise<T> => {
    const run = queue.then(work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    ) => { task?: Task | undefined; changed?: boolean | undefined; text?: string | undefined },
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
          return {
            content: [
              {
                type: "text" as const,
                text: result.text ?? formatToolText(action, state, result.task, result.changed),
              },
            ],
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
        state = result.state;
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
    "List all tasks with status, ownership and dependency information.",
    TaskListSchema,
    "list",
    (_params) => {
      refreshWidget();
      return { text: formatTaskList(state) };
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
    "Update a task's status, text, owner, metadata or dependencies. Use the task ID returned by TaskCreate or TaskList.",
    TaskUpdateSchema,
    "update",
    (params) => {
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
      state = result.state;
      refreshWidget();
      return { task: result.task, changed: result.changed };
    },
  );

  registerMutation<TaskDeleteInput>(
    "TaskDelete",
    "TaskDelete",
    "Delete a task by ID and remove its dependency edges.",
    TaskDeleteSchema,
    "delete",
    (params) => {
      const result = deleteTask(state, params.taskId);
      state = result.state;
      return { task: result.task };
    },
  );

  pi.registerCommand("tasks", {
    description: "Show the Claude Code-style task list, or clear it with /tasks clear",
    handler: async (args, ctx) => {
      // TUI gate (revision N5): same rule as restore() — a rpc/child session
      // must never become the widget owner.
      if (ctx.mode === "tui") currentUI = ctx.ui;
      if (args.trim().toLowerCase() === "clear") {
        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm("Clear tasks?", "This permanently clears the current session task list."))
        )
          return;
        await enqueue(() => {
          state = emptyState();
          persist();
          refreshWidget();
        });
        ctx.ui.notify("Task list cleared.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
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
  pi.on("session_compact", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    currentUI = undefined;
  });
}

function formatTaskLine(task: Task): string {
  const icon = task.status === "completed" ? "✓" : task.status === "in_progress" ? "✳" : "○";
  const suffix = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
  const owner = task.owner ? ` (${task.owner})` : "";
  return `${icon} #${task.id} ${task.status} ${task.subject}${owner}${suffix}`;
}

function formatTaskList(state: TodoState): string {
  if (state.tasks.length === 0) return "No tasks.";
  return orderTasks(state.tasks)
    .map((task) => `${formatTaskLine(task)}\n  ${task.description}`)
    .join("\n");
}

function formatToolText(action: Action, state: TodoState, task?: Task, changed = true): string {
  switch (action) {
    case "create":
      return task ? `Task #${task.id} created: ${task.subject}` : "Task created.";
    case "get":
      return task ? `${formatTaskLine(task)}\n${task.description}` : "Task found.";
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
