/**
 * Scheduled tasks — user/AI-facing task operations shared by the `schedule` tool and `/schedule`
 * (A3; plan r3 §4.1, §4.3, §5.1, §5.2). Every mutation is one S1 transaction on a `SessionStore`;
 * nothing here touches pi.
 *
 * Approval rules (S2 — approval = definition hash), enforced HERE so both surfaces agree:
 *  - an AI-origin write NEVER writes `approval`; changing an execution field changes `defHash`, so
 *    the old approval simply stops matching (no code path "revokes" anything);
 *  - a user create writes `approval = defHash`; a user edit re-approves ONLY a task that was
 *    approved before the edit (a pending task — typically AI-authored, never reviewed — stays
 *    pending: approval needs the review flow, `/schedule approve`);
 *  - `resume` flips `enabled` only; `__put`'s trailing hash must equal the hash of the definition
 *    that will be stored, otherwise `E_REV` (the web review dialog bound that hash).
 */
import { randomBytes } from "node:crypto";
import { changeTask, type TaskChange } from "../core/claim.js";
import { compileWhen, validateWhen } from "../core/cron.js";
import { initOcc } from "../core/occurrence.js";
import { SchedFsError } from "../core/paths.js";
import {
  defHash,
  isApproved,
  SCHED_BG_DEFAULT_TYPE,
  SCHED_BG_TIMEOUT_MIN_S,
  SCHED_MAX_TASKS_PER_SESSION,
  SCHED_NAME_MAX_CHARS,
  SCHED_PROMPT_MAX_BYTES,
  SCHED_TASK_ID_RE,
  type ScheduleBg,
  type ScheduleErrorCode,
  type ScheduleForm,
  type ScheduleTask,
  type ScheduleThinkingLevel,
  type ScheduleWhen,
  SCHEDULE_THINKING_LEVELS,
} from "../core/spec.js";
import { finishRun, removeTask, type SessionStore } from "../core/writer.js";
import { parseStrictModelRef } from "../../config/model-hint.js";
import type { XsHostCapabilityState } from "../../fabric/xs/host-cap.js";
import type { ScheduleRefusal } from "./mode.js";
import type { ScheduleAgent } from "./wire.js";

export type OpFail = { ok: false; code: ScheduleErrorCode; detail: string };
export type OpOk<T> = { ok: true; value: T };
export type OpResult<T> = OpOk<T> | OpFail;

const fail = (code: ScheduleErrorCode, detail: string): OpFail => ({ ok: false, code, detail });

export interface OpOrigin {
  by: "user" | "agent";
  via: "tui" | "web" | "tool";
}

export interface OpsPorts {
  agent: Pick<ScheduleAgent, "ensureStore" | "store" | "gate" | "changed">;
  now(): number;
  limits: { defaultTimeoutS: number; maxTimeoutS: number };
  /** Registry check for `bg.type`; `names()` only feeds the error text. */
  agentTypes: { has(name: string): boolean; names?(): readonly string[] };
  /** `false` ⇒ definitely unknown to the host registry; `undefined` ⇒ cannot tell (allowed). */
  knownModel?(ref: { provider: string; id: string }): boolean | undefined;
  /** Dispatcher capability evidence (`getXsHostCapability().state`): `absent` ⇒ no message/handoff. */
  capability(): XsHostCapabilityState;
  /** Canonical cwd stamped on a new task (§11). */
  ownerCwd(): string;
  defaultTz(): string;
  /** I1: revoke this session's in-memory queued message/handoff entries of a paused/deleted task. */
  revokeQueued?(taskId: string): void;
}

/** The execution definition + name — what a create/edit fully specifies. */
export interface TaskDef {
  name: string;
  form: ScheduleForm;
  when: ScheduleWhen;
  prompt: string;
  feishu: boolean;
  bg?: ScheduleBg;
}

export function defOf(task: ScheduleTask): TaskDef {
  return {
    name: task.name,
    form: task.form,
    when: task.when,
    prompt: task.prompt,
    feishu: task.feishu,
    ...(task.bg === undefined ? {} : { bg: task.bg }),
  };
}

// ----------------------------------------------------------------- field parsing

const WHEN_KEYS = new Set(["kind", "expr", "at", "tz"]);
const BG_KEYS = new Set(["type", "model", "thinking", "timeoutS", "consultMain", "handoff", "isolation"]);
const DEFAULT_TZ_FALLBACK = "UTC";

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ_FALLBACK;
  } catch {
    return DEFAULT_TZ_FALLBACK;
  }
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(rec: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(rec).find((k) => !allowed.has(k));
}

/** Raw (external) field bag: the tool's flat params, `/schedule` flags and `__put` JSON all map onto it. */
export interface RawFields {
  name?: unknown;
  form?: unknown;
  when?: unknown;
  prompt?: unknown;
  feishu?: unknown;
  bg?: unknown;
}

function parseWhen(raw: unknown, base: ScheduleWhen | undefined, ports: OpsPorts): OpResult<ScheduleWhen> {
  if (!isRec(raw)) return fail("E_INVALID", "when must be an object {kind, expr|at, tz}");
  const bad = unknownKeys(raw, WHEN_KEYS);
  if (bad !== undefined) return fail("E_INVALID", `when: unknown field "${bad}"`);
  const kind = raw.kind;
  if (kind !== "cron" && kind !== "once") return fail("E_INVALID", 'when.kind must be "cron" or "once"');
  const tz = raw.tz ?? (base?.tz as unknown) ?? ports.defaultTz();
  if (typeof tz !== "string" || tz === "") return fail("E_INVALID", "when.tz must be an IANA time zone name");
  if (kind === "cron") {
    if (raw.at !== undefined) return fail("E_INVALID", "when: `at` only applies to kind once");
    if (typeof raw.expr !== "string" || raw.expr.trim() === "")
      return fail("E_INVALID", "when.expr must be a 5-field cron expression");
    return { ok: true, value: { kind: "cron", expr: raw.expr.trim().replace(/\s+/g, " "), tz } };
  }
  if (raw.expr !== undefined) return fail("E_INVALID", "when: `expr` only applies to kind cron");
  if (typeof raw.at !== "string") return fail("E_INVALID", "when.at must be a local time YYYY-MM-DDTHH:mm");
  return { ok: true, value: { kind: "once", at: raw.at, tz } };
}

function parseModel(raw: unknown): OpResult<{ provider: string; id: string }> {
  if (typeof raw === "string") {
    const ref = parseStrictModelRef(raw.trim());
    return ref === undefined ? fail("E_INVALID", 'model must be a strict "provider/id"') : { ok: true, value: ref };
  }
  if (isRec(raw) && typeof raw.provider === "string" && typeof raw.id === "string") {
    const ref = parseStrictModelRef(`${raw.provider}/${raw.id}`);
    if (ref !== undefined && Object.keys(raw).length === 2) return { ok: true, value: ref };
  }
  return fail("E_INVALID", 'model must be a strict "provider/id"');
}

function parseBg(raw: unknown, base: ScheduleBg | undefined, ports: OpsPorts): OpResult<ScheduleBg> {
  if (!isRec(raw)) return fail("E_INVALID", "bg must be an object");
  const bad = unknownKeys(raw, BG_KEYS);
  if (bad !== undefined) return fail("E_INVALID", `bg: unknown field "${bad}"`);
  const bg: ScheduleBg = base
    ? { ...base }
    : {
        type: SCHED_BG_DEFAULT_TYPE,
        timeoutS: ports.limits.defaultTimeoutS,
        consultMain: false,
        handoff: false,
      };
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || raw.type.trim() === "") return fail("E_INVALID", "bg.type must be a string");
    bg.type = raw.type.trim();
  }
  if (!ports.agentTypes.has(bg.type)) {
    const names = ports.agentTypes.names?.() ?? [];
    return fail(
      "E_INVALID",
      `unknown agent type "${bg.type}"${names.length > 0 ? ` (available: ${names.join(", ")})` : ""}`,
    );
  }
  if (raw.model !== undefined) {
    if (raw.model === null || raw.model === "") delete bg.model;
    else {
      const m = parseModel(raw.model);
      if (!m.ok) return m;
      bg.model = m.value;
    }
  }
  if (bg.model !== undefined && ports.knownModel?.(bg.model) === false)
    return fail("E_INVALID", `unknown model ${bg.model.provider}/${bg.model.id}`);
  if (raw.thinking !== undefined) {
    if (raw.thinking === null || raw.thinking === "") delete bg.thinking;
    else if (!(SCHEDULE_THINKING_LEVELS as readonly unknown[]).includes(raw.thinking))
      return fail("E_INVALID", `bg.thinking must be one of ${SCHEDULE_THINKING_LEVELS.join("|")}`);
    else bg.thinking = raw.thinking as ScheduleThinkingLevel;
  }
  if (raw.timeoutS !== undefined) {
    if (typeof raw.timeoutS !== "number" || !Number.isInteger(raw.timeoutS))
      return fail("E_INVALID", "bg.timeoutS must be an integer number of seconds");
    bg.timeoutS = raw.timeoutS;
  }
  if (bg.timeoutS < SCHED_BG_TIMEOUT_MIN_S || bg.timeoutS > ports.limits.maxTimeoutS)
    return fail("E_INVALID", `bg.timeoutS must be within ${SCHED_BG_TIMEOUT_MIN_S}..${ports.limits.maxTimeoutS}`);
  for (const key of ["consultMain", "handoff"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") return fail("E_INVALID", `bg.${key} must be a boolean`);
    bg[key] = raw[key] as boolean;
  }
  if (raw.isolation !== undefined) {
    if (raw.isolation === "worktree") bg.isolation = "worktree";
    else if (raw.isolation === "none" || raw.isolation === null) delete bg.isolation;
    else return fail("E_INVALID", 'bg.isolation must be "worktree" or "none"');
  }
  return { ok: true, value: bg };
}

/**
 * Merge `raw` over `base` (an existing task's definition; undefined ⇒ create, defaults apply) and
 * validate the result. Pure given `ports`. `when` is re-validated against the 400-day horizon only
 * when it is new or changed (renaming an expired once-task must stay possible).
 */
export function resolveDef(raw: RawFields, base: TaskDef | undefined, ports: OpsPorts): OpResult<TaskDef> {
  let name = base?.name;
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") return fail("E_INVALID", "name must be a string");
    name = raw.name.trim();
  }
  if (name === undefined || name === "") return fail("E_INVALID", "name is required");
  // eslint-disable-next-line no-control-regex
  if (name.length > SCHED_NAME_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(name))
    return fail("E_INVALID", `name must be a single line of at most ${SCHED_NAME_MAX_CHARS} characters`);

  let form: ScheduleForm = base?.form ?? "background";
  if (raw.form !== undefined) {
    if (raw.form !== "background" && raw.form !== "message")
      return fail("E_INVALID", 'form must be "background" or "message"');
    form = raw.form;
  }

  let prompt = base?.prompt;
  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== "string") return fail("E_INVALID", "prompt must be a string");
    prompt = raw.prompt;
  }
  if (prompt === undefined || prompt.trim() === "") return fail("E_INVALID", "prompt is required");
  if (Buffer.byteLength(prompt, "utf8") > SCHED_PROMPT_MAX_BYTES)
    return fail("E_INVALID", `prompt exceeds ${SCHED_PROMPT_MAX_BYTES} bytes`);

  let when = base?.when;
  const whenChanged = raw.when !== undefined;
  if (whenChanged) {
    const w = parseWhen(raw.when, base?.when, ports);
    if (!w.ok) return w;
    when = w.value;
  }
  if (when === undefined) return fail("E_INVALID", "when is required");
  if (whenChanged || base === undefined) {
    const v = validateWhen(when, ports.now());
    if (!v.ok) return fail("E_INVALID", v.error);
  } else if (!compileWhen(when).ok) {
    // unchanged but broken definitions stay editable only through a new `when`
    return fail("E_INVALID", "the stored schedule is no longer valid; supply a new `when`");
  }

  let feishu = base?.feishu;
  if (raw.feishu !== undefined) {
    if (typeof raw.feishu !== "boolean") return fail("E_INVALID", "feishu must be a boolean");
    feishu = raw.feishu;
  }
  // D7 defaults: background pushes to Feishu, a scheduled message does not. Re-apply the default when
  // a switch of form changes it and the caller did not say.
  if (feishu === undefined || (raw.feishu === undefined && base !== undefined && base.form !== form))
    feishu = form === "background";

  let bg: ScheduleBg | undefined;
  if (form === "background") {
    const r = parseBg(raw.bg ?? {}, base?.form === "background" ? base.bg : undefined, ports);
    if (!r.ok) return r;
    bg = r.value;
  } else if (raw.bg !== undefined && !(isRec(raw.bg) && Object.keys(raw.bg).length === 0)) {
    return fail("E_INVALID", "bg options only apply to background tasks");
  }

  const def: TaskDef = { name, form, when, prompt, feishu, ...(bg === undefined ? {} : { bg }) };

  // Dispatcher-backed features need the pi trigger shape (plan §6.2 capability gate, fail closed).
  const newMessage = form === "message" && base?.form !== "message";
  const newHandoff = def.bg?.handoff === true && base?.bg?.handoff !== true;
  if ((newMessage || newHandoff) && ports.capability() === "absent")
    return fail(
      "E_UNSUPPORTED",
      "this pi does not provide the trigger capability that scheduled messages and handoff need (use a background task without handoff)",
    );
  return { ok: true, value: def };
}

export function newTaskId(): string {
  const B32 = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(8);
  let s = "s_";
  for (const b of bytes) s += B32[b % 32];
  return s;
}

/** Task as it would be stored for `def` (execution hash is independent of id/createdAt). */
function taskOf(id: string, def: TaskDef, ownerCwd: string, origin: OpOrigin, now: number): ScheduleTask {
  return {
    id,
    name: def.name,
    form: def.form,
    when: def.when,
    prompt: def.prompt,
    feishu: def.feishu,
    ...(def.bg === undefined ? {} : { bg: def.bg }),
    enabled: true,
    createdBy: origin.by,
    createdVia: origin.via,
    createdAt: now,
    ownerCwd,
  };
}

/** `defHash` the stored task would have — what the web review dialog binds (create: this cwd). */
export function previewHash(def: TaskDef, ownerCwd: string): string {
  return defHash(taskOf("s_aaaaaaaa", def, ownerCwd, { by: "user", via: "tui" }, 0));
}

// ----------------------------------------------------------------- store resolution

function storeFailure(err: unknown): OpFail {
  if (err instanceof SchedFsError)
    return err.reason === "vault" ? fail("E_SECURE", err.message) : fail("E_DEGRADED", `${err.reason}: ${err.message}`);
  return fail("E_DEGRADED", err instanceof Error ? err.message : String(err));
}

function refusalOf(r: ScheduleRefusal): OpFail {
  return fail(r.code, r.detail);
}

function fromChange(c: TaskChange): OpResult<ScheduleTask> {
  switch (c.kind) {
    case "changed":
      return { ok: true, value: c.task };
    case "refused":
      return fail(c.code, c.detail ?? "refused");
    case "error":
      return fail(c.code, c.detail);
  }
}

// ----------------------------------------------------------------- create

export interface CreateOpts {
  /** `__put`: the hash the review dialog bound; must equal the hash of what will be stored (E_REV). */
  expectHash?: string;
}

export async function createTask(
  ports: OpsPorts,
  raw: RawFields,
  origin: OpOrigin,
  opts: CreateOpts = {},
): Promise<OpResult<ScheduleTask>> {
  const refusal = ports.agent.gate();
  if (refusal !== undefined) return refusalOf(refusal);
  const def = resolveDef(raw, undefined, ports);
  if (!def.ok) return def;
  const ownerCwd = ports.ownerCwd();
  if (opts.expectHash !== undefined && previewHash(def.value, ownerCwd) !== opts.expectHash)
    return fail("E_REV", "the submitted content differs from the reviewed content; review again");
  let store: SessionStore;
  try {
    store = ports.agent.ensureStore();
  } catch (err) {
    return storeFailure(err);
  }
  const r = await store.transact<ScheduleTask | "limit">((draft, ctx) => {
    if (draft.tasks.length >= SCHED_MAX_TASKS_PER_SESSION) return { value: "limit", write: false };
    let id = newTaskId();
    while (draft.tasks.some((t) => t.id === id)) id = newTaskId();
    const task = taskOf(id, def.value, ownerCwd, origin, ctx.now);
    if (origin.by === "user")
      task.approval = { hash: defHash(task), by: "user", via: origin.via === "web" ? "web" : "tui", at: ctx.now };
    draft.tasks.push(task);
    draft.occ[id] = initOcc(task, ctx.now);
    return { value: structuredClone(task), write: true };
  });
  if (!r.ok) return fail(r.code, r.detail);
  if (r.value === "limit") return fail("E_LIMIT", `at most ${SCHED_MAX_TASKS_PER_SESSION} tasks per session`);
  ports.agent.changed();
  return { ok: true, value: r.value };
}

// ----------------------------------------------------------------- update

export interface UpdateOpts {
  /** Edit form: the defHash the form was loaded from — CAS against the current definition (E_REV). */
  baseHash?: string;
  /** `__put`: hash bound by the review dialog (see CreateOpts). */
  expectHash?: string;
  /**
   * The caller proved the user reviewed the COMPLETE new definition (`__put`: the dialog showed it and
   * `expectHash` binds it): a user edit then approves it even when the task was pending before.
   */
  approveReviewed?: boolean;
  /**
   * Called once INSIDE the lock, after validation and before the fields are rewritten, with a structured
   * clone of the task as it was (#61: `confirm` records the rollback baseline for "reject = undo the AI's
   * change"). Read-only; a throw is swallowed.
   */
  onBase?: (before: ScheduleTask) => void;
}

/** Edit any of name / when / prompt / feishu / bg / form. `origin` decides re-approval (module header). */
export async function updateTask(
  ports: OpsPorts,
  id: string,
  raw: RawFields,
  origin: OpOrigin,
  opts: UpdateOpts = {},
): Promise<OpResult<ScheduleTask>> {
  const refusal = ports.agent.gate();
  if (refusal !== undefined) return refusalOf(refusal);
  const store = ports.agent.store();
  if (store === undefined || !SCHED_TASK_ID_RE.test(id)) return fail("E_INVALID", `no such task ${id}`);
  const change = await changeTask(store, id, (task, now) => {
    if (opts.baseHash !== undefined && defHash(task) !== opts.baseHash)
      return { refuse: "E_REV", detail: "the task changed since it was loaded; review again" };
    const def = resolveDef(raw, defOf(task), ports);
    if (!def.ok) return { refuse: def.code, detail: def.detail };
    const next = taskOf(
      task.id,
      def.value,
      task.ownerCwd,
      { by: task.createdBy, via: task.createdVia },
      task.createdAt,
    );
    const nextHash = defHash(next);
    if (opts.expectHash !== undefined && nextHash !== opts.expectHash)
      return { refuse: "E_REV", detail: "the submitted content differs from the reviewed content; review again" };
    if (opts.onBase !== undefined) {
      try {
        opts.onBase(structuredClone(task));
      } catch {
        /* a baseline observer must never break the write */
      }
    }
    const wasApproved = isApproved(task);
    const hashChanged = nextHash !== defHash(task);
    task.name = next.name;
    task.form = next.form;
    task.when = next.when;
    task.prompt = next.prompt;
    task.feishu = next.feishu;
    if (next.bg === undefined) delete task.bg;
    else task.bg = next.bg;
    // User edit keeps an already-approved task approved; a pending task is NEVER approved by an edit.
    if (origin.by === "user" && ((wasApproved && hashChanged) || (opts.approveReviewed === true && opts.expectHash)))
      task.approval = { hash: nextHash, by: "user", via: origin.via === "web" ? "web" : "tui", at: now };
    return undefined;
  });
  const out = fromChange(change);
  if (out.ok) ports.agent.changed();
  return out;
}

// ----------------------------------------------------------------- pause / resume / delete (store-level, reused by --all)

/**
 * I1 (A2 residual 3): a pause / delete must also revoke the task's already-QUEUED message runs. A once task
 * that a claim already disabled makes `pause` a no-op for the definition, so nothing else would stop a queued
 * (or handoff) run from being sent after the user said stop. Ledger half (works for any session's store, so
 * `--all` is covered): queued message runs → `dropped(task-changed)`; the owner process's in-memory queue
 * (incl. handoffs, which have no ledger run) is revoked through `opts.revoke` — own session only.
 */
export interface RevokeOpts {
  /** Own-session in-memory revocation (`MessageSchedulerInstall.revokeTask`); omitted for foreign stores. */
  revoke?: (taskId: string) => void;
}

/** Ledger half of the I1 revocation (queued message runs of `taskId` → `dropped(task-changed)`); shared with confirm's reject-delete. */
export async function dropQueuedRuns(store: SessionStore, taskId: string): Promise<void> {
  // Best effort: a failed write leaves the runs to the dispatcher's own CAS (task-changed / E_REV paths).
  await store.transact<number>((draft, ctx) => {
    let n = 0;
    for (const run of draft.runs) {
      if (run.taskId !== taskId || run.form !== "message" || run.state !== "queued") continue;
      if (finishRun(draft, run.runKey, { state: "dropped", reason: "task-changed" }, ctx.now) === "ok") n += 1;
    }
    return { value: n, write: n > 0 };
  });
}

export async function setTaskEnabled(
  store: SessionStore,
  id: string,
  enabled: boolean,
  opts: RevokeOpts = {},
): Promise<OpResult<ScheduleTask>> {
  if (!SCHED_TASK_ID_RE.test(id)) return fail("E_INVALID", `no such task ${id}`);
  const out = fromChange(
    await changeTask(store, id, (task) => {
      task.enabled = enabled; // resume NEVER approves (§4.3)
      return undefined;
    }),
  );
  if (out.ok && !enabled) {
    opts.revoke?.(id);
    await dropQueuedRuns(store, id);
  }
  return out;
}

export async function deleteTask(
  store: SessionStore,
  id: string,
  opts: RevokeOpts = {},
): Promise<OpResult<{ id: string }>> {
  if (!SCHED_TASK_ID_RE.test(id)) return fail("E_INVALID", `no such task ${id}`);
  const r = await store.transact<boolean>((draft) => {
    const removed = removeTask(draft, id);
    return { value: removed, write: removed };
  });
  if (!r.ok) return fail(r.code, r.detail);
  if (!r.value) return fail("E_INVALID", `no such task ${id}`);
  opts.revoke?.(id);
  await dropQueuedRuns(store, id);
  return { ok: true, value: { id } };
}
