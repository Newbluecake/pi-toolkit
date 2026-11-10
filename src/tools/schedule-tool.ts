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
import { localTime, runLine, taskDetail, taskLine } from "../schedule/agent/view.js";
import type { ScheduleAgent } from "../schedule/agent/wire.js";
import { compileTask } from "../schedule/core/occurrence.js";
import { nextOccurrence } from "../schedule/core/cron.js";
import {
  isExecutable,
  SCHED_UPDATE_FORBIDDEN_FIELDS,
  type ScheduleErrorCode,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../schedule/core/spec.js";
import { SCHED_TASK_ID_RE } from "../web-hub/protocol/schedule.js";

/**
 * `schedule` — the AI's handle on the session's scheduled tasks (scheduled-reports plan r3 §5.1).
 * Tasks are owned by THIS session and only run while it is open. There is no approval (schedule-auto-approve
 * r2): everything the AI creates or changes takes effect immediately and keeps running until paused or
 * deleted. Registered once per activate with a frozen description (prompt-cache prefix stays byte-
 * stable); main session only (child sessions never reach this registration).
 */

const ACTIONS = ["list", "get", "create", "update", "pause", "resume", "delete", "run_now", "history"] as const;

export const SCHEDULE_TOOL_DESCRIPTION =
  "Manage scheduled tasks that belong to THIS session. A task runs on a cron schedule, once, or at an elapsed UTC interval (every), either as a " +
  "background subagent (form=background: runs in a clean context; its final reply is the report) or as a " +
  "message into this session (form=message). Tasks only run while this session is open; a run that is " +
  "missed on cron/at is skipped, never replayed; every aggregates missed due points into at most one catch-up run. Run results appear as messages in this " +
  "session. IMPORTANT: tasks you create or change take effect immediately and keep running on schedule until paused or deleted. " +
  "Only create or change a scheduled task when the user asked for it, and tell the user the task id and its next run. " +
  "Actions: list, get, create, update, pause, resume, delete, run_now (immediate run), " +
  "history (recent runs).";

export const ScheduleToolParams = Type.Object(
  {
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)),
      {
        description:
          'What to do. Update is a patch: send id and only changed fields. Prompt-only example: {"action":"update","id":"<当前id>","prompt":"<新完整提示>"}. Omit unchanged cron/at/every/tz and other fields; do not use empty strings, false or 0 as placeholders.',
      },
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Task id (s_xxxxxxxx). Required for get/update/pause/resume/delete/run_now. On create omit id: ids are assigned; only an empty string/null placeholder is treated as unassigned, never a nonempty id.",
      }),
    ),
    name: Type.Optional(Type.String({ description: "Short single-line task name, at most 40 characters." })),
    form: Type.Optional(
      Type.Union([Type.Literal("background"), Type.Literal("message")], {
        description: "background (default): a subagent runs the prompt. message: the prompt is sent into this session.",
      }),
    ),
    cron: Type.Optional(
      Type.String({
        description:
          'Recurring schedule: 5-field cron expression, e.g. "0 8 * * *". Create: exactly one of cron/at/every. Update: omit all three to keep the schedule, or send exactly one to replace it. Empty string is not omission.',
      }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "One-off local time YYYY-MM-DDTHH:mm (in tz). Create: exactly one of cron/at/every. Update: omit all three to keep the schedule, or send exactly one to replace it. Empty string is not omission.",
      }),
    ),
    every: Type.Optional(
      Type.String({
        description:
          'Elapsed UTC interval: lowercase s/m/h/d (d=24h), up to 3 decimals, whole seconds within 30s..365d; e.g. "90m" or "1.5h". Create: exactly one of cron/at/every. Update: omit all three to keep the schedule, or send exactly one to replace it. Empty string is not omission; never combine every with tz. Missed due points aggregate into one catch-up run.',
      }),
    ),
    tz: Type.Optional(
      Type.String({
        description:
          "IANA time zone for cron/at, e.g. Asia/Shanghai. Defaults to the system zone; must accompany cron or at. On update omit tz if not changing the schedule; never send tz alone or with every.",
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
const ACTIVE_NOTE =
  "active immediately. It only runs while this session is open, and each run's result appears as a message in this session.";

function out(text: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ok: true as const, ...extra } };
}
// Presentation budgets are UTF-8 bytes, not input limits. Validation and stored values are untouched.
const ERROR_FIELD_MAX_BYTES = 80;
const ERROR_REASON_MAX_BYTES = 512;
const ERROR_CONTENT_MAX_BYTES = 2048;

function boundedErrorText(text: string, maxBytes: number): string {
  const prefix = text.slice(0, maxBytes).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
  if (prefix.length === text.length && Buffer.byteLength(prefix) <= maxBytes) return prefix;
  const suffix = " [truncated]";
  let out = "";
  let bytes = suffix.length;
  for (const char of prefix) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    out += char;
  }
  return out + suffix;
}

/** Never serialize an input value, even a short one: type/length/empty suffice to repair a call. */
function fieldSummary(key: "cron" | "at" | "every" | "tz" | "action" | "id", value: unknown): string {
  const shape =
    typeof value === "string"
      ? `string(${value.length === 0 ? "empty, " : ""}length=${value.length}, value hidden)`
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "array(value hidden)"
          : `${typeof value}(value hidden)`;
  return boundedErrorText(`${key}: ${shape}`, ERROR_FIELD_MAX_BYTES);
}

/** Deny-by-default projection of shared diagnostics: matching a reason never permits echoing its payload. */
function operationReason(f: OpFail): string {
  // Only the writer/claim's authoritative flag establishes commit uncertainty, never detail text.
  if (f.uncertain === true)
    return "The operation may already have taken effect; commit durability is uncertain. Do not blindly retry or run the task again. First verify with read-only action=list/get/history and inspect the ledger locally; do not repair or mutate it before verification.";
  const detail = f.detail;
  // These prefixes have untrusted suffixes (tz, cron tokens, id, model, registry names or runtime errors).
  if (detail.startsWith("when.tz: unsupported time zone ")) return "when.tz: unsupported time zone (value hidden)";
  if (detail.startsWith("no such task")) return "no such task (id hidden); get the current id with action=list";
  if (detail.startsWith("unknown agent type ")) return "unknown agent type (value hidden); use a registered agentType";
  if (detail.startsWith("unknown model ")) return "unknown model (value hidden); use a registered provider/id";
  if (detail.startsWith("session LOCKED:")) return "session LOCKED (details hidden)";
  const cron =
    /^cron: (minute|hour|day-of-month|month|day-of-week)(?:: (bad step in|bad range|bad value|reversed range)| step |: step must be)/.exec(
      detail.slice(0, ERROR_REASON_MAX_BYTES),
    );
  if (cron !== null) {
    if (cron[2] !== undefined) return `cron: ${cron[1]}: ${cron[2]} (value hidden)`;
    // Bounds/examples are fixed vocabulary, never copied from the offending step or original diagnostic.
    const field = cron[1]!;
    const bounds: Readonly<Record<string, number>> = {
      minute: 59,
      hour: 23,
      "day-of-month": 31,
      month: 12,
      "day-of-week": 7,
    };
    const fix =
      field === "minute"
        ? 'for elapsed time remove cron and use every (e.g. every:"90m", CLI: --every 90m)'
        : field === "hour"
          ? 'use cron:"0 0 * * *" for midnight, or every for elapsed time'
          : "use a step within the field bound, or every for elapsed time";
    return `cron: ${field} step outside 1..${bounds[field]}; ${fix}`;
  }
  // Only exact, bounded, input-free diagnostic vocabulary may pass through unchanged.
  const safe = [
    "give exactly one of cron, at, every; remove the other schedule fields",
    "give exactly one of cron, at, every",
    "tz must accompany cron or at",
    "nothing to update",
    "when.expr must be a 5-field cron expression",
    "when.at must be a local time YYYY-MM-DDTHH:mm",
    'when.at: expected "YYYY-MM-DDTHH:mm"',
    "when.at: not a calendar date/time",
    "when.at: local time does not exist in tz (DST gap)",
    "when.tz must be an IANA time zone name",
    "when: no occurrence within 400 days",
    "the stored schedule is no longer valid; supply a new `when`",
    'every uses elapsed UTC time; remove tz and keep every:"90m"',
    "every: expected at most 32 characters",
    'every unit must be s/m/h/d; use every:"90m" or every:"1.5h"',
    'every must be whole seconds within 30s..365d; use every:"45s"',
    "cron: too long",
    "cron: need exactly 5 fields",
    "name must be a string",
    "name is required",
    "name must be a single line of at most 40 characters",
    'form must be "background" or "message"',
    "prompt must be a string",
    "prompt is required",
    "prompt exceeds 8192 bytes",
    "feishu must be a boolean",
    "bg options only apply to background tasks",
    "bg.type must be a string",
    'model must be a strict "provider/id"',
    "bg.thinking must be one of off|low|medium|high",
    "bg.timeoutS must be an integer number of seconds",
    "bg.consultMain must be a boolean",
    "bg.handoff must be a boolean",
    'bg.isolation must be "worktree" or "none"',
    'connect an interval-capable hub (update hub and run /webhub restart), or disable webHub and /reload; then retry every:"90m"',
    "this pi does not provide the trigger capability that scheduled messages and handoff need (use a background task without handoff)",
    "owner cwd cannot be resolved",
    "owner cwd lies inside a vault",
    "not the owning session",
    "stack disposed",
    "refused",
  ];
  if (detail.length <= ERROR_REASON_MAX_BYTES && safe.includes(detail)) return detail;
  if (detail.startsWith("bg.timeoutS must be within ")) return "bg.timeoutS must be within the configured limits";
  const fieldReason = /^cron: (minute|hour|day-of-month|month|day-of-week)(: empty list item| matches nothing)$/.exec(
    detail.slice(0, ERROR_REASON_MAX_BYTES),
  );
  if (detail.length <= ERROR_REASON_MAX_BYTES && fieldReason !== null) return fieldReason[0];
  const reason: Record<ScheduleErrorCode, string> = {
    E_DISABLED: "scheduled tasks are disabled",
    E_UNAPPROVED: "legacy task approval is unavailable",
    E_INVALID: "invalid schedule parameters",
    E_DEGRADED:
      "schedule ledger unavailable or refused; inspect it locally with read-only checks; do not automatically repair or retry",
    E_SECURE: "secure/locked domain refuses scheduled tasks",
    E_NOT_OWNER: "this session is not the schedule owner",
    E_MODE: "this mode does not allow the schedule operation",
    E_EPHEMERAL: "a persistent session is required",
    E_CHILD: "child sessions cannot own scheduled tasks",
    E_UNSUPPORTED: "required schedule capability is unavailable",
    E_BUSY: "schedule writer or reconciliation is busy; retry later",
    E_LIMIT: "schedule task, directory or ledger size limit exceeded",
    E_OVERLAP: "a run of this task is already in progress",
    E_REV: "the task definition changed; read it again before retrying",
  };
  return `${reason[f.code] ?? "schedule operation refused"} (diagnostic details hidden)`;
}

function failure(code: ScheduleErrorCode, detail: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: boundedErrorText(`${code}: ${detail}`, ERROR_CONTENT_MAX_BYTES) }],
    details: { ok: false as const, code, ...extra },
  };
}
function promptUpdateExample(): string {
  return JSON.stringify({ action: "update", id: "<当前id>", prompt: "<新完整提示>" });
}

/** Fixed examples only; never reflect task names, prompts or other submitted values. */
function createExample(params: ScheduleToolParams): string {
  return JSON.stringify(
    params.form === "message"
      ? { action: "create", name: "message", form: "message", every: "20m", prompt: "<完整提示>", feishu: false }
      : { action: "create", name: "daily", cron: "0 8 * * *", prompt: "<完整提示>" },
  );
}

/** Presentation only: retain the shared code/reason semantics and never normalize a supplied value. */
function failOp(f: OpFail, params?: ScheduleToolParams) {
  const reason = boundedErrorText(operationReason(f), ERROR_REASON_MAX_BYTES);
  const extra = f.uncertain === undefined ? {} : { uncertain: f.uncertain };
  if (f.uncertain === true || f.code !== "E_INVALID" || params === undefined) return failure(f.code, reason, extra);
  const fields = (["cron", "at", "every", "tz"] as const)
    .filter((key) => params[key] !== undefined)
    .map((key) => fieldSummary(key, params[key]));
  const hints: string[] = [];
  if (fields.length > 0) {
    hints.push(
      `Supplied schedule fields: ${fields.join(", ")}. Empty strings are supplied values, not omission.`,
      'To change the schedule, send exactly one nonempty cron (5 fields, e.g. "0 8 * * *"), at (future local YYYY-MM-DDTHH:mm), or every (e.g. "90m", whole seconds within 30s..365d). tz must accompany cron or at, never every.',
    );
  }
  if (params.action === "update") {
    hints.push(
      "Update is a patch: omit unchanged cron/at/every/tz and all other unchanged fields. Do not use empty strings, false or 0 as placeholders; supplied values are validated/applied, not ignored.",
      `To update only prompt, replace the placeholders and send: ${promptUpdateExample()}`,
    );
  } else {
    hints.push(
      `Create example (replace name/prompt): ${createExample(params)}. Omit unrelated fields, not placeholders.${params.form === "message" ? " For form=message omit agentType/model/thinking/timeoutS/handoff/isolation, even default or false values; these are background-only options." : ""}`,
    );
  }
  return failure(f.code, `${reason}\n${hints.join("\n")}`, extra);
}

function readOf(
  agent: ScheduleAgent,
): { state: ScheduleStateFile | undefined } | { error: ReturnType<typeof failure> } {
  const r = agent.readState();
  if (r.kind === "ok") return { state: r.state };
  if (r.kind === "absent") return { state: undefined };
  // A JSON parse failure is a proven repairable corruption. Other refusals (including unknown
  // versions, identity/owner/mode/symlink and unclassified schema failures) need manual inspection.
  const guidance =
    r.reason === "json"
      ? "the ledger has invalid JSON; after local inspection and backup the user may run /schedule repair (quarantines and resets the ledger)"
      : "the ledger is unavailable or refused; inspect it locally with read-only checks; do not automatically repair or retry";
  return { error: failure("E_DEGRADED", guidance) };
}

function flatToRaw(p: ScheduleToolParams): RawFields | OpFail {
  const raw: RawFields = {};
  if (p.name !== undefined) raw.name = p.name;
  if (p.form !== undefined) raw.form = p.form;
  if (p.prompt !== undefined) raw.prompt = p.prompt;
  if (p.feishu !== undefined) raw.feishu = p.feishu;
  if ([p.cron, p.at, p.every].filter((v) => v !== undefined).length > 1)
    return {
      ok: false,
      code: "E_INVALID",
      detail: "give exactly one of cron, at, every; remove the other schedule fields",
    };
  if (p.cron !== undefined) raw.when = { kind: "cron", expr: p.cron, ...(p.tz === undefined ? {} : { tz: p.tz }) };
  else if (p.at !== undefined) raw.when = { kind: "once", at: p.at, ...(p.tz === undefined ? {} : { tz: p.tz }) };
  else if (p.every !== undefined)
    raw.when = { kind: "every", every: p.every, ...(p.tz === undefined ? {} : { tz: p.tz }) };
  else if (p.tz !== undefined) return { ok: false, code: "E_INVALID", detail: "tz must accompany cron or at" };
  const bg: Record<string, unknown> = {};
  if (p.agentType !== undefined) bg.type = p.agentType;
  if (p.model !== undefined) bg.model = p.model;
  if (p.thinking !== undefined) bg.thinking = p.thinking;
  if (p.timeoutS !== undefined) bg.timeoutS = p.timeoutS;
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
      "schedule(action, …) - create/list/update scheduled tasks for this session (takes effect immediately; create only what the user asked for)",
    promptGuidelines: [
      "Tasks you create or modify take effect immediately and keep running until paused or deleted. Only create or change one when the user asked for it, and tell the user the task id and its next run.",
      "A background task's prompt must be self-contained (clean context); a message task is sent into this session when it is idle.",
    ],
    parameters: ScheduleToolParams,
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      const agent = deps.agent();
      if (agent === undefined) return failure("E_NOT_OWNER", "no active session");
      const action = params.action as ScheduleToolAction;
      const refusal = actionRefusal(agent.mode, action);
      if (refusal !== undefined) return failure(refusal.code, refusal.detail);
      if (!ACTIONS.includes(action))
        return failure(
          "E_INVALID",
          `\`action\` is required and must be one of ${ACTIONS.join(", ")}; use action, not op. ${fieldSummary("action", params.action)}. To find the current id send {"action":"list"}. Prompt-only update (replace placeholders): ${promptUpdateExample()}`,
        );
      // Fields the AI may never write — also rejected here in case the host does not enforce the schema.
      const rawParams = params as Record<string, unknown>;
      for (const key of [...SCHED_UPDATE_FORBIDDEN_FIELDS, "everyMs", "intervalMs", "anchorAt"]) {
        if (key === "id") {
          if (action !== "create") continue; // A selector, never an update field.
          // Strict SDK responses use null for absent optionals (normally stripped before execute).
          // Some bridges/models send "" instead. On CREATE ONLY these cannot specify an id:
          // flatToRaw never forwards id; createTask always assigns one. Do not trim nonempty ids
          // or extend this exception to time, bg, boolean or patch fields.
          if (rawParams.id === "" || rawParams.id === null) continue;
        }
        if (rawParams[key] !== undefined)
          return failure(
            "E_INVALID",
            key === "id"
              ? `\`id\` cannot be set through this tool (ids are assigned). Omit id on create; only an empty string/null placeholder means unassigned. ${fieldSummary("id", rawParams.id)}. Create example (replace name/prompt): ${createExample(params)}`
              : `\`${key}\` cannot be set through this tool`,
          );
      }
      const ports = (): OpsPorts => deps.ports(agent, ctx);
      const revokeOf = (): { revoke?: (taskId: string) => void } => {
        const revoke = ports().revokeQueued;
        return revoke === undefined ? {} : { revoke };
      };
      const taskId = params.id;
      const needId = (): ReturnType<typeof failure> | undefined =>
        typeof taskId !== "string" || !SCHED_TASK_ID_RE.test(taskId)
          ? failure(
              "E_INVALID",
              `\`id\` (s_xxxxxxxx) is required for ${action}. ${fieldSummary("id", taskId)}. Get the current task id with {"action":"list"}, then send ${action === "update" ? promptUpdateExample() : JSON.stringify({ action, id: "<当前id>" })}. Replace the placeholders; do not use an empty id.`,
            )
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
          if (t === undefined)
            return failure("E_INVALID", "no such task (id hidden); get the current id with action=list");
          const recent = (r.state?.runs ?? []).filter((x) => x.taskId === t.id).slice(-5);
          const lines = taskDetail(t, r.state?.occ[t.id], r.state?.manualTotal[t.id]);
          if (recent.length > 0)
            lines.push("recent runs:", ...recent.map((x) => `  ${runLine(x, t.when, agent.store())}`));
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
          return out(
            runs.map((x) => `${x.taskId} · ${runLine(x, tasks.get(x.taskId)?.when, agent.store())}`).join("\n"),
            {
              runs: runs.length,
            },
          );
        }
        case "create": {
          const raw = flatToRaw(params);
          if ("ok" in raw) return failOp(raw, params);
          const res = await createTask(ports(), raw, { by: "agent", via: "tool" });
          if (!res.ok) return failOp(res, params);
          notifyActive(ctx, "created", res.value, now());
          return out(
            `Created task ${res.value.id} "${res.value.name}". It is ${ACTIVE_NOTE}${nextText(res.value, now())}${res.value.when.kind === "every" ? ` ${taskLine(res.value)} · catch-up: aggregate once.` : ""}`,
            { id: res.value.id },
          );
        }
        case "update": {
          const bad = needId();
          if (bad) return bad;
          const raw = flatToRaw(params);
          if ("ok" in raw) return failOp(raw, params);
          if (Object.keys(raw).length === 0)
            return failOp({ ok: false, code: "E_INVALID", detail: "nothing to update" }, params);
          const res = await updateTask(ports(), taskId!, raw);
          if (!res.ok) return failOp(res, params);
          notifyActive(ctx, "updated", res.value, now());
          return out(
            `Updated task ${res.value.id}. Task is ${ACTIVE_NOTE}${nextText(res.value, now())}${res.value.when.kind === "every" ? ` ${taskLine(res.value)} · catch-up: aggregate once.` : ""}`,
            {
              id: res.value.id,
            },
          );
        }
        case "pause":
        case "resume": {
          const bad = needId();
          if (bad) return bad;
          const g = agent.gate();
          if (g !== undefined) return failOp({ ok: false, ...g });
          const store = agent.store();
          if (store === undefined)
            return failure("E_INVALID", "no such task (id hidden); get the current id with action=list");
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
          if (g !== undefined) return failOp({ ok: false, ...g });
          const store = agent.store();
          if (store === undefined)
            return failure("E_INVALID", "no such task (id hidden); get the current id with action=list");
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
            const f: OpFail = {
              ok: false,
              code: res.code as ScheduleErrorCode,
              detail: res.detail ?? "refused",
              ...(res.uncertain === undefined ? {} : { uncertain: res.uncertain }),
            };
            if (f.uncertain === true) return failOp(f);
            const hint = res.code === "E_OVERLAP" ? " A run of this task is already in progress." : "";
            return failure(
              f.code,
              `${operationReason(f)}${hint}`,
              f.uncertain === undefined ? {} : { uncertain: f.uncertain },
            );
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

/** TUI-only courtesy line after an AI create/update; silent without a UI or on any error. */
function notifyActive(ctx: ExtensionContext, verb: string, task: ScheduleTask, at: number): void {
  try {
    const n = nextOf(task, at);
    const next = n === undefined ? "no upcoming run" : `next run ${new Date(n).toLocaleString()}`;
    ctx.ui?.notify(
      `定时任务 ${task.id}「${task.name}」已${verb === "created" ? "创建" : "更新"}并启用，${next}`,
      "info",
    );
  } catch {
    /* no UI (print/rpc) or notify failed — never affects the tool result */
  }
}

function statusNote(task: ScheduleTask): string {
  return task.enabled ? "Task is scheduled." : "Task is paused.";
}

/** ` Next run: …` for the tool result (empty when the task has no upcoming occurrence). */
function nextText(task: ScheduleTask, at: number): string {
  const n = nextOf(task, at);
  return n === undefined ? "" : ` Next run: ${localTime(task.when, n)}.`;
}
