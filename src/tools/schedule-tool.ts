import { randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { actionRefusal, type ScheduleToolAction } from "../schedule/agent/mode.js";
import {
  createTask,
  deleteTask,
  setTaskEnabled,
  updateTask,
  type OpFail,
  type OpsPorts,
  type RawFields,
} from "../schedule/agent/ops.js";
import { runLine, taskDetail, taskLine } from "../schedule/agent/view.js";
import type { ScheduleAgent } from "../schedule/agent/wire.js";
import { compileTask } from "../schedule/core/occurrence.js";
import { nextOccurrence } from "../schedule/core/cron.js";
import {
  isApproved,
  isExecutable,
  SCHED_UPDATE_FORBIDDEN_FIELDS,
  type ScheduleErrorCode,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../schedule/core/spec.js";
import { SCHED_TASK_ID_RE } from "../web-hub/protocol/schedule.js";

/**
 * `schedule` — the AI's handle on the session's scheduled tasks (scheduled-reports plan r3 §5.1).
 * Tasks are owned by THIS session and only run while it is open. Approval semantics (§4.3):
 * everything the AI creates or changes waits for the USER's approval (`/schedule approve` in the
 * terminal, or the web panel) — there is deliberately no approve action here, and `resume` does not
 * approve. Registered once per activate with a frozen description (prompt-cache prefix stays byte-
 * stable); main session only (child sessions never reach this registration).
 */

const ACTIONS = ["list", "get", "create", "update", "pause", "resume", "delete", "run_now", "history"] as const;

export const SCHEDULE_TOOL_DESCRIPTION =
  "Manage scheduled tasks that belong to THIS session. A task runs on a cron schedule or once, either as a " +
  "background subagent (form=background: runs in a clean context; its final reply is the report) or as a " +
  "message into this session (form=message). Tasks only run while this session is open; a run that is " +
  "missed because the session was closed is skipped, never replayed. Run results appear as messages in this " +
  "session. IMPORTANT: every task you create, and every change you make to a task's schedule/prompt/form/" +
  "feishu/background options, must be approved by the USER before it can run (in the terminal with " +
  "/schedule approve <id>, or in the web schedule panel). You cannot approve; resume only un-pauses. " +
  "Actions: list, get, create, update, pause, resume, delete, run_now (immediate run; only an approved task), " +
  "history (recent runs).";

export const ScheduleToolParams = Type.Object(
  {
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)),
      { description: "What to do." },
    ),
    id: Type.Optional(
      Type.String({ description: "Task id (s_xxxxxxxx). Required for get/update/pause/resume/delete/run_now." }),
    ),
    name: Type.Optional(Type.String({ description: "Short single-line task name, at most 40 characters." })),
    form: Type.Optional(
      Type.Union([Type.Literal("background"), Type.Literal("message")], {
        description: "background (default): a subagent runs the prompt. message: the prompt is sent into this session.",
      }),
    ),
    cron: Type.Optional(
      Type.String({
        description: 'Recurring schedule: 5-field cron expression, e.g. "0 8 * * *". Give cron OR at, not both.',
      }),
    ),
    at: Type.Optional(
      Type.String({ description: "One-off local time YYYY-MM-DDTHH:mm (in tz). Give at OR cron, not both." }),
    ),
    tz: Type.Optional(
      Type.String({
        description:
          "IANA time zone for cron/at, e.g. Asia/Shanghai. Defaults to the system zone; must accompany cron or at.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "The task instruction (max 8 KiB). For background tasks it must be self-contained: the subagent starts with a clean context.",
      }),
    ),
    feishu: Type.Optional(
      Type.Boolean({
        description: "Push the result to the user's Feishu. Default: true for background, false for message.",
      }),
    ),
    agentType: Type.Optional(Type.String({ description: "Background only: subagent type. Default general-purpose." })),
    model: Type.Optional(Type.String({ description: 'Background only: strict "provider/id" model override.' })),
    thinking: Type.Optional(
      Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
        description: "Background only: thinking level override.",
      }),
    ),
    timeoutS: Type.Optional(
      Type.Integer({ description: "Background only: run budget in seconds (60..14400, default 1800)." }),
    ),
    consultMain: Type.Optional(
      Type.Boolean({ description: "Background only: let the subagent consult this session. Default false." }),
    ),
    handoff: Type.Optional(
      Type.Boolean({
        description: "Background only: after the run, hand the result back to this session to act on. Default false.",
      }),
    ),
    isolation: Type.Optional(
      Type.Union([Type.Literal("worktree"), Type.Literal("none")], {
        description: "Background only: run in a separate git worktree.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type ScheduleToolParams = Static<typeof ScheduleToolParams>;

export interface ScheduleToolDeps {
  /** The current session's schedule agent (late-bound through the stack holder). */
  agent(): ScheduleAgent | undefined;
  /** Ports for the shared task operations (agent types, settings limits, cwd, …). */
  ports(agent: ScheduleAgent, ctx: ExtensionContext): OpsPorts;
  now?: () => number;
}

const HISTORY_LIMIT = 20;
const PENDING_NOTE =
  "PENDING USER APPROVAL: it will not run until the user approves it (terminal: /schedule approve <id>; or the web schedule panel). " +
  "It only runs while this session is open, and each run's result appears as a message in this session.";

function out(text: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ok: true as const, ...extra } };
}
function failure(code: ScheduleErrorCode, detail: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: `${code}: ${detail}` }],
    details: { ok: false as const, code, ...extra },
  };
}
function failOp(f: OpFail) {
  return failure(f.code, f.detail);
}

function readOf(
  agent: ScheduleAgent,
): { state: ScheduleStateFile | undefined } | { error: ReturnType<typeof failure> } {
  const r = agent.readState();
  if (r.kind === "ok") return { state: r.state };
  if (r.kind === "absent") return { state: undefined };
  return {
    error: failure("E_DEGRADED", `the schedule ledger is unreadable (${r.reason}); the user can run /schedule repair`),
  };
}

function flatToRaw(p: ScheduleToolParams): RawFields | OpFail {
  const raw: RawFields = {};
  if (p.name !== undefined) raw.name = p.name;
  if (p.form !== undefined) raw.form = p.form;
  if (p.prompt !== undefined) raw.prompt = p.prompt;
  if (p.feishu !== undefined) raw.feishu = p.feishu;
  if (p.cron !== undefined && p.at !== undefined)
    return { ok: false, code: "E_INVALID", detail: "give cron OR at, not both" };
  if (p.cron !== undefined) raw.when = { kind: "cron", expr: p.cron, ...(p.tz === undefined ? {} : { tz: p.tz }) };
  else if (p.at !== undefined) raw.when = { kind: "once", at: p.at, ...(p.tz === undefined ? {} : { tz: p.tz }) };
  else if (p.tz !== undefined) return { ok: false, code: "E_INVALID", detail: "tz must accompany cron or at" };
  const bg: Record<string, unknown> = {};
  if (p.agentType !== undefined) bg.type = p.agentType;
  if (p.model !== undefined) bg.model = p.model;
  if (p.thinking !== undefined) bg.thinking = p.thinking;
  if (p.timeoutS !== undefined) bg.timeoutS = p.timeoutS;
  if (p.consultMain !== undefined) bg.consultMain = p.consultMain;
  if (p.handoff !== undefined) bg.handoff = p.handoff;
  if (p.isolation !== undefined) bg.isolation = p.isolation;
  if (Object.keys(bg).length > 0) raw.bg = bg;
  return raw;
}

export function createScheduleTool(deps: ScheduleToolDeps): ToolDefinition<typeof ScheduleToolParams> {
  const now = deps.now ?? Date.now;
  return {
    name: "schedule",
    label: "Schedule",
    description: SCHEDULE_TOOL_DESCRIPTION,
    promptSnippet:
      "schedule(action, …) - create/list/update scheduled tasks for this session (user must approve what you create)",
    promptGuidelines: [
      "Tasks you create or modify are pending until the user approves them; tell the user to run /schedule approve <id> (or use the web schedule panel). Never claim a pending task will run.",
      "A background task's prompt must be self-contained (clean context); a message task is sent into this session when it is idle.",
    ],
    parameters: ScheduleToolParams,
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      const agent = deps.agent();
      if (agent === undefined) return failure("E_NOT_OWNER", "no active session");
      const action = params.action as ScheduleToolAction;
      const refusal = actionRefusal(agent.mode, action);
      if (refusal !== undefined) return failure(refusal.code, refusal.detail);
      // Fields the AI may never write — also rejected here in case the host does not enforce the schema.
      const rawParams = params as Record<string, unknown>;
      for (const key of SCHED_UPDATE_FORBIDDEN_FIELDS) {
        if (key === "id" && action !== "create") continue;
        if (rawParams[key] !== undefined)
          return failure(
            "E_INVALID",
            `\`${key}\` cannot be set through this tool${key === "id" ? " (ids are assigned)" : ""}`,
          );
      }
      const ports = (): OpsPorts => deps.ports(agent, ctx);
      const revokeOf = (): { revoke?: (taskId: string) => void } => {
        const revoke = ports().revokeQueued;
        return revoke === undefined ? {} : { revoke };
      };
      const taskId = params.id;
      const needId = (): ReturnType<typeof failure> | undefined =>
        taskId === undefined || !SCHED_TASK_ID_RE.test(taskId)
          ? failure("E_INVALID", `\`id\` (s_xxxxxxxx) is required for ${action}`)
          : undefined;

      switch (action) {
        case "list": {
          const r = readOf(agent);
          if ("error" in r) return r.error;
          const tasks = r.state?.tasks ?? [];
          if (tasks.length === 0) return out("No scheduled tasks in this session.", { tasks: [] });
          const lines = tasks.map((t) => taskLine(t, { next: nextOf(t, now()) }));
          return out(lines.join("\n"), { tasks: tasks.map((t) => t.id) });
        }
        case "get": {
          const bad = needId();
          if (bad) return bad;
          const r = readOf(agent);
          if ("error" in r) return r.error;
          const t = r.state?.tasks.find((x) => x.id === taskId);
          if (t === undefined) return failure("E_INVALID", `no such task ${taskId}`);
          const recent = (r.state?.runs ?? []).filter((x) => x.taskId === t.id).slice(-5);
          const lines = taskDetail(t, r.state?.occ[t.id], r.state?.manualTotal[t.id]);
          if (recent.length > 0) lines.push("recent runs:", ...recent.map((x) => `  ${runLine(x, t.when)}`));
          return out(lines.join("\n"), { id: t.id });
        }
        case "history": {
          const r = readOf(agent);
          if ("error" in r) return r.error;
          if (taskId !== undefined && !SCHED_TASK_ID_RE.test(taskId)) return failure("E_INVALID", "bad task id");
          const tasks = new Map((r.state?.tasks ?? []).map((t) => [t.id, t]));
          const runs = (r.state?.runs ?? [])
            .filter((x) => taskId === undefined || x.taskId === taskId)
            .sort((a, b) => b.scheduledAt - a.scheduledAt)
            .slice(0, HISTORY_LIMIT);
          if (runs.length === 0) return out("No runs recorded.", { runs: 0 });
          return out(runs.map((x) => `${x.taskId} · ${runLine(x, tasks.get(x.taskId)?.when)}`).join("\n"), {
            runs: runs.length,
          });
        }
        case "create": {
          const raw = flatToRaw(params);
          if ("ok" in raw) return failOp(raw);
          const res = await createTask(ports(), raw, { by: "agent", via: "tool" });
          if (!res.ok) return failOp(res);
          return out(`Created task ${res.value.id} "${res.value.name}". It is ${PENDING_NOTE}`, {
            id: res.value.id,
            pending: true,
          });
        }
        case "update": {
          const bad = needId();
          if (bad) return bad;
          const raw = flatToRaw(params);
          if ("ok" in raw) return failOp(raw);
          if (Object.keys(raw).length === 0) return failure("E_INVALID", "nothing to update");
          const res = await updateTask(ports(), taskId!, raw, { by: "agent", via: "tool" });
          if (!res.ok) return failOp(res);
          return out(`Updated task ${res.value.id}. ${statusNote(res.value)}`, {
            id: res.value.id,
            pending: !isApproved(res.value),
          });
        }
        case "pause":
        case "resume": {
          const bad = needId();
          if (bad) return bad;
          const g = agent.gate();
          if (g !== undefined) return failure(g.code, g.detail);
          const store = agent.store();
          if (store === undefined) return failure("E_INVALID", `no such task ${taskId}`);
          const res = await setTaskEnabled(store, taskId!, action === "resume", revokeOf());
          if (!res.ok) return failOp(res);
          agent.changed();
          return out(`${action === "resume" ? "Resumed" : "Paused"} task ${res.value.id}. ${statusNote(res.value)}`, {
            id: res.value.id,
          });
        }
        case "delete": {
          const bad = needId();
          if (bad) return bad;
          const g = agent.gate();
          if (g !== undefined) return failure(g.code, g.detail);
          const store = agent.store();
          if (store === undefined) return failure("E_INVALID", `no such task ${taskId}`);
          const res = await deleteTask(store, taskId!, revokeOf());
          if (!res.ok) return failOp(res);
          agent.changed();
          return out(`Deleted task ${taskId}. Runs already recorded stay in history.`, { id: taskId });
        }
        case "run_now": {
          const bad = needId();
          if (bad) return bad;
          const res = await agent.runNow({ taskId: taskId!, reqId: randomBytes(12).toString("base64url") });
          if (res.kind === "refused") {
            const hint =
              res.code === "E_UNAPPROVED"
                ? " The task is pending the user's approval (/schedule approve <id>)."
                : res.code === "E_OVERLAP"
                  ? " A run of this task is already in progress."
                  : "";
            return failure(res.code as ScheduleErrorCode, `${res.detail ?? "refused"}${hint}`);
          }
          return out(
            `Run started (${res.runKey}). The result will appear as a message in this session when it finishes.`,
            { runKey: res.runKey },
          );
        }
      }
    },
  };
}

function nextOf(task: ScheduleTask, at: number): number | undefined {
  if (!isExecutable(task)) return undefined;
  const c = compileTask(task);
  return c === undefined ? undefined : nextOccurrence(c, at);
}

function statusNote(task: ScheduleTask): string {
  const pending = !isApproved(task);
  const paused = !task.enabled;
  if (pending) return `Task is ${PENDING_NOTE}`;
  return paused ? "Task is paused." : "Task is approved and scheduled.";
}
