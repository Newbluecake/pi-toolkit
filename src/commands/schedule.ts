import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { isFeishuInvocation, isWebInvocation } from "./capture.js";
import { actionRefusal } from "../schedule/agent/mode.js";
import {
  createTask,
  defOf,
  deleteTask,
  previewHash,
  resolveDef,
  setTaskEnabled,
  updateTask,
  type OpFail,
  type OpOrigin,
  type OpsPorts,
  type RawFields,
  type RevokeOpts,
} from "../schedule/agent/ops.js";
import { runLine, taskDetail, taskLine } from "../schedule/agent/view.js";
import type { ScheduleAgent } from "../schedule/agent/wire.js";
import { approveTask } from "../schedule/core/claim.js";
import { nextOccurrence } from "../schedule/core/cron.js";
import { compileTask } from "../schedule/core/occurrence.js";
import { resolveStoreRoot, SchedFsError, type InVaultPredicate, type StoreRoot } from "../schedule/core/paths.js";
import { listSessionDirs, readSessionState } from "../schedule/core/reader.js";
import { defHash, isApproved, isExecutable, type ScheduleStateFile, type ScheduleTask } from "../schedule/core/spec.js";
import { openSessionStore, type SessionStore } from "../schedule/core/writer.js";
import { SCHED_HASH_RE, SCHED_TASK_ID_RE } from "../web-hub/protocol/schedule.js";

/**
 * `/schedule` — the user's surface for scheduled tasks (scheduled-reports plan r3 §5.2).
 *
 *   /schedule [list] [--all]            list (this session / every session)
 *   /schedule add <name> --cron "<expr>"|--at <YYYY-MM-DDTHH:mm> [flags] -- <prompt>   create (= approved)
 *   /schedule edit <id> [flags] [-- <prompt>]                    edit (never approves a pending task)
 *   /schedule show <id> [--all] · log [<id>] [--all]            definition + hash · run history
 *   /schedule approve <id> [<hash>] [--all]   review (full definition + hash) → confirm → CAS on that hash
 *   /schedule pause|resume|rm <id> [--all]    (resume never approves)
 *   /schedule run <id>                         immediate run (this session only)
 *   /schedule repair                           quarantine a corrupt ledger; local-only: also resets the dispatcher blockers
 *   /schedule __put <json> <hash>              web review form (frozen contract below)
 *
 * Flags: --name --cron --at --tz --form background|message --feishu/--no-feishu --type --model
 * --thinking --timeout <s> --consult/--no-consult --handoff/--no-handoff --worktree/--no-worktree.
 *
 * `--all` (any local TUI session manages other sessions' tasks under their ledger lock): list/show/log/
 * pause/resume/rm/approve allowed; edit and run are refused (changes belong in the owning session,
 * execution only ever happens there). Feishu-marked invocations may not mutate (defence in depth —
 * the hub's Feishu admission never forwards command ops). Web policy lives in
 * `src/web-hub/agent/command-policy.ts` (`schedulePolicy`).
 *
 * `__put` contract (frozen here; the review UI binds to it):
 *   /schedule __put <json> <64-hex hash>
 *   json = { id?, baseHash?, name, form, when:{kind:"cron",expr,tz}|{kind:"once",at,tz}, prompt, feishu?, bg? }
 *   id absent ⇒ create; id present ⇒ edit and `baseHash` (the defHash the form was loaded from) is REQUIRED
 *   — a mismatch with the current definition is E_REV. The trailing hash is the defHash of the definition
 *   that will be stored (for a create the cwd is this session's). An all-zero hash is a PREVIEW (nothing is
 *   written; the reply's first line is `PREVIEW defHash=<hash>`), which is how a browser without sha256
 *   obtains the hash to bind. A non-zero hash that does not match ⇒ E_REV, nothing written. A successful
 *   `__put` is a REVIEWED write: create is approved and an edit approves the stored definition.
 *   Replies: `OK <id> defHash=<hash>` | `PREVIEW …` | `E_CODE: detail`.
 */

export const SCHEDULE_COMMAND_DESCRIPTION =
  "定时任务：/schedule [list] · add · edit · show · log · approve · pause|resume|rm · run · repair（--all 管理其他会话）";

const SUBS = ["list", "add", "edit", "show", "log", "approve", "pause", "resume", "rm", "run", "repair"] as const;
const READ_SUBS = new Set(["list", "show", "log"]);
const FEISHU_REFUSED = new Set(["add", "edit", "approve", "pause", "resume", "rm", "run", "repair", "__put"]);
const FEISHU_REFUSAL = "飞书入口不能修改定时任务，请在终端或 web 执行";
const ZERO_HASH = "0".repeat(64);
const PUT_KEYS = new Set(["id", "baseHash", "name", "form", "when", "prompt", "feishu", "bg"]);
const ONCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const USAGE = [
  "/schedule [list] [--all] — 列出任务",
  '/schedule add <名称> --cron "0 8 * * *" | --at 2026-12-01T09:00 [--tz Asia/Shanghai] [--form background|message] [--feishu|--no-feishu] [--type T] [--model p/id] [--thinking low] [--timeout 1800] [--consult] [--handoff] [--worktree] -- <prompt>',
  "/schedule edit <id> [同上参数] [-- <prompt>] — 修改（待确认的任务不会因编辑而被批准）",
  "/schedule show <id> · log [<id>] — 完整定义与 hash · 运行历史（可加 --all）",
  "/schedule approve <id> [<hash>] — 审阅完整定义后批准（绑定 hash）",
  "/schedule pause|resume|rm <id> — 暂停 / 恢复（恢复不等于批准）/ 删除",
  "/schedule run <id> — 立即运行（仅本会话）；/schedule repair — 修复损坏的账本，并重置调度器栅栏阻塞（仅本地）",
  "--all：管理其他会话的任务（list/show/log/pause/resume/rm/approve；edit、run 不可用）",
].join("\n");

export interface ScheduleCommandDeps {
  /** `schedule.enabled` frozen at activate: off ⇒ every call answers E_DISABLED. */
  enabled(): boolean;
  agent(): ScheduleAgent | undefined;
  ports(agent: ScheduleAgent, ctx: ExtensionCommandContext): OpsPorts;
  /** Vault predicate (literal + canonical) for opening other sessions' ledgers. */
  inVault: InVaultPredicate;
  /** I1: local human reset of the message dispatcher's fence windows / ui-prompt balance (`/schedule repair`). */
  resetBlockers?(): void;
  now?: () => number;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    /* best effort */
  }
}

/** Quote-aware tokenizer (double / single quotes, backslash escapes inside double quotes). */
export function tokenizeScheduleArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i]!;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur !== "") out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (has || cur !== "") out.push(cur);
  return out;
}

/** Split `head -- prompt` at the first standalone `--` (raw text after it is the prompt, spacing kept). */
export function splitPrompt(args: string): { head: string; prompt: string | undefined } {
  const m = /(^|\s)--(\s|$)/.exec(args);
  if (m === null) return { head: args, prompt: undefined };
  return { head: args.slice(0, m.index), prompt: args.slice(m.index + m[0].length).trim() };
}

const VALUE_FLAGS = new Set(["name", "cron", "at", "tz", "form", "type", "model", "thinking", "timeout"]);
const BOOL_FLAGS = new Set([
  "all",
  "feishu",
  "no-feishu",
  "consult",
  "no-consult",
  "handoff",
  "no-handoff",
  "worktree",
  "no-worktree",
]);

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  error?: string;
}

export function parseFlags(tokens: readonly string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map() };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("--")) {
      out.positional.push(t);
      continue;
    }
    const name = t.slice(2);
    if (BOOL_FLAGS.has(name)) out.flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const v = tokens[i + 1];
      if (v === undefined) return { ...out, error: `--${name} 需要一个值` };
      out.flags.set(name, v);
      i++;
    } else return { ...out, error: `未知参数 ${t}` };
  }
  return out;
}

function flagsToRaw(p: Parsed, prompt: string | undefined, nameFromPositional?: string): RawFields | { error: string } {
  const f = p.flags;
  const raw: RawFields = {};
  const name = (f.get("name") as string | undefined) ?? nameFromPositional;
  if (name !== undefined) raw.name = name;
  if (f.has("form")) raw.form = f.get("form");
  if (prompt !== undefined && prompt !== "") raw.prompt = prompt;
  if (f.has("feishu") && f.has("no-feishu")) return { error: "--feishu 与 --no-feishu 互斥" };
  if (f.has("feishu")) raw.feishu = true;
  if (f.has("no-feishu")) raw.feishu = false;
  if (f.has("cron") && f.has("at")) return { error: "--cron 与 --at 只能给一个" };
  const tz = f.get("tz");
  if (f.has("cron")) raw.when = { kind: "cron", expr: f.get("cron"), ...(tz === undefined ? {} : { tz }) };
  else if (f.has("at")) raw.when = { kind: "once", at: f.get("at"), ...(tz === undefined ? {} : { tz }) };
  else if (tz !== undefined) return { error: "--tz 需要与 --cron 或 --at 一起给出" };
  const bg: Record<string, unknown> = {};
  if (f.has("type")) bg.type = f.get("type");
  if (f.has("model")) bg.model = f.get("model");
  if (f.has("thinking")) bg.thinking = f.get("thinking");
  if (f.has("timeout")) {
    const n = Number(f.get("timeout"));
    if (!Number.isFinite(n)) return { error: "--timeout 需要整数秒" };
    bg.timeoutS = n;
  }
  for (const [flag, key] of [
    ["consult", "consultMain"],
    ["handoff", "handoff"],
  ] as const) {
    if (f.has(flag) && f.has(`no-${flag}`)) return { error: `--${flag} 与 --no-${flag} 互斥` };
    if (f.has(flag)) bg[key] = true;
    if (f.has(`no-${flag}`)) bg[key] = false;
  }
  if (f.has("worktree") && f.has("no-worktree")) return { error: "--worktree 与 --no-worktree 互斥" };
  if (f.has("worktree")) bg.isolation = "worktree";
  if (f.has("no-worktree")) bg.isolation = "none";
  if (Object.keys(bg).length > 0) raw.bg = bg;
  return raw;
}

const failText = (f: OpFail): string => `${f.code}: ${f.detail}`;

function originOf(ctx: ExtensionCommandContext): OpOrigin {
  return { by: "user", via: isWebInvocation(ctx) ? "web" : "tui" };
}

function nextOf(task: ScheduleTask, at: number): number | undefined {
  if (!isExecutable(task)) return undefined;
  const c = compileTask(task);
  return c === undefined ? undefined : nextOccurrence(c, at);
}

function stateLines(state: ScheduleStateFile | undefined, at: number): string[] {
  const tasks = state?.tasks ?? [];
  return tasks.map((t) => `  ${taskLine(t, { next: nextOf(t, at) })}`);
}

// ----------------------------------------------------------------- --all (other sessions' ledgers)

interface SessionEntry {
  dir: string;
  sessionId: string;
  state: ScheduleStateFile;
}

type AllScan =
  | { ok: true; root: StoreRoot; sessions: SessionEntry[]; degraded: string[]; truncated: boolean }
  | { ok: false; text: string };

function scanAll(agent: ScheduleAgent, deps: ScheduleCommandDeps): AllScan {
  let root: StoreRoot;
  try {
    root = agent.store()?.root ?? resolveStoreRoot(agent.dir, { inVault: deps.inVault });
  } catch (err) {
    if (err instanceof SchedFsError && err.reason === "missing")
      return { ok: true, root: undefined as never, sessions: [], degraded: [], truncated: false };
    return { ok: false, text: `E_DEGRADED: ${err instanceof Error ? err.message : String(err)}` };
  }
  const listing = listSessionDirs(root, { inVault: deps.inVault });
  if (listing.kind === "degraded") return { ok: false, text: `E_DEGRADED: ${listing.reason} ${listing.detail}` };
  const sessions: SessionEntry[] = [];
  const degraded: string[] = [];
  for (const dir of listing.dirs) {
    const r = readSessionState(root, dir, { inVault: deps.inVault });
    if (r.kind === "ok") sessions.push({ dir, sessionId: r.state.sessionId, state: r.state });
    else if (r.kind === "degraded") degraded.push(`${dir} (${r.reason})`);
  }
  return { ok: true, root, sessions, degraded, truncated: listing.truncated };
}

function openForeign(
  agent: ScheduleAgent,
  root: StoreRoot,
  sessionId: string,
  deps: ScheduleCommandDeps,
): SessionStore {
  return openSessionStore({
    root,
    sessionId,
    self: agent.self!,
    epoch: agent.epoch,
    inVault: deps.inVault,
    now: deps.now ?? Date.now,
    lockTimeoutMs: 2_000,
  });
}

const sid8 = (sid: string): string => sid.slice(0, 8);

type Located = { ok: true; store: SessionStore; task: ScheduleTask; sessionId: string } | { ok: false; text: string };

function locateAll(agent: ScheduleAgent, deps: ScheduleCommandDeps, id: string): Located {
  if (!SCHED_TASK_ID_RE.test(id))
    return { ok: false, text: `E_INVALID: 任务 id 形如 s_xxxxxxxx（收到 ${id || "空"}）` };
  const scan = scanAll(agent, deps);
  if (!scan.ok) return { ok: false, text: scan.text };
  const hits = scan.sessions.flatMap((s) => s.state.tasks.filter((t) => t.id === id).map((t) => ({ s, t })));
  if (hits.length === 0) return { ok: false, text: `E_INVALID: 所有会话中都没有任务 ${id}` };
  if (hits.length > 1)
    return {
      ok: false,
      text: `E_INVALID: 任务 ${id} 在多个会话中出现（${hits.map((h) => sid8(h.s.sessionId)).join(", ")}），请在归属会话中操作`,
    };
  const hit = hits[0]!;
  return {
    ok: true,
    store: openForeign(agent, scan.root, hit.s.sessionId, deps),
    task: hit.t,
    sessionId: hit.s.sessionId,
  };
}

// ----------------------------------------------------------------- review → approve

async function approveFlow(
  ctx: ExtensionCommandContext,
  store: SessionStore,
  id: string,
  given: string | undefined,
  via: "tui" | "web",
): Promise<{ text: string; level: "info" | "warning" | "error"; changed: boolean }> {
  const snap = store.read();
  if (snap.kind !== "ok")
    return { text: "E_DEGRADED: 账本不可读，请先 /schedule repair", level: "error", changed: false };
  const task = snap.state.tasks.find((t) => t.id === id);
  if (task === undefined) return { text: `E_INVALID: 没有任务 ${id}`, level: "error", changed: false };
  if (isApproved(task)) return { text: `任务 ${id} 已是批准状态。`, level: "info", changed: false };
  // Sample the hash BEFORE any dialog: the CAS below binds exactly what the reviewer saw (§4.3).
  const hash = defHash(task);
  if (given !== undefined) {
    if (given !== hash)
      return {
        text: "E_REV: 任务定义已变更，hash 不符；请重新审阅（/schedule show）",
        level: "warning",
        changed: false,
      };
  } else {
    let ok = false;
    try {
      ok =
        (await ctx.ui.confirm(
          `批准定时任务 ${id}？`,
          [...taskDetail(task, snap.state.occ[id]), "", "批准后它将按上述定义自动运行（仅在归属会话打开时）。"].join(
            "\n",
          ),
        )) === true;
    } catch {
      ok = false;
    }
    if (!ok) return { text: "已取消，任务保持待确认。", level: "info", changed: false };
  }
  const res = await approveTask(store, id, hash, via);
  if (res.kind === "changed")
    return {
      text: `已批准 ${id}（hash ${hash.slice(0, 8)}）${res.task.enabled ? "" : "；任务处于暂停状态，/schedule resume 后生效"}。`,
      level: "info",
      changed: true,
    };
  if (res.kind === "refused")
    return {
      text:
        res.code === "E_REV" ? "E_REV: 审阅期间任务定义已变更，未批准；请重新审阅" : `${res.code}: ${res.detail ?? ""}`,
      level: "warning",
      changed: false,
    };
  return { text: `${res.code}: ${res.detail}`, level: "error", changed: false };
}

// ----------------------------------------------------------------- command

export function createScheduleCommand(deps: ScheduleCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const now = deps.now ?? Date.now;
  return {
    description: SCHEDULE_COMMAND_DESCRIPTION,
    // Pure: subcommand names only (no ledger reads, no IO).
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim();
      if (p.includes(" ")) return null;
      const items = SUBS.map((s) => ({ value: s, label: s, description: "" })).filter((i) => i.value.startsWith(p));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = args.trim();
      const first = text.split(/\s+/)[0] ?? "";
      const sub = first === "" || first.startsWith("--") ? "list" : first;
      const rest = sub === first ? text.slice(first.length).trim() : text;
      // Feishu: hard refusal of every mutation, FIRST (defence in depth).
      if (isFeishuInvocation(ctx) && (FEISHU_REFUSED.has(sub) || /(^|\s)--all(\s|$)/.test(text))) {
        notify(ctx, FEISHU_REFUSAL, "warning");
        return;
      }
      if (!deps.enabled()) {
        notify(ctx, "E_DISABLED: 定时任务未启用（settings 的 schedule.enabled=false；改后 /reload）。", "warning");
        return;
      }
      const agent = deps.agent();
      if (agent === undefined) {
        notify(ctx, "E_NOT_OWNER: 当前没有活动会话。", "error");
        return;
      }
      try {
        if (sub === "__put") return void (await put(ctx, agent, text.slice("__put".length).trim()));
        const { head, prompt } = splitPrompt(rest);
        const tokens = tokenizeScheduleArgs(head);
        const parsed = parseFlags(tokens);
        if (parsed.error !== undefined) return void notify(ctx, `${parsed.error}\n${USAGE}`, "warning");
        const all = parsed.flags.has("all");
        const pos = parsed.positional;
        const known = (SUBS as readonly string[]).includes(sub);
        if (!known) return void notify(ctx, `未知子命令 ${sub}\n${USAGE}`, "warning");
        const refusal = actionRefusal(agent.mode, READ_SUBS.has(sub) ? "list" : "create");
        if (refusal !== undefined && !(all && refusal.code !== "E_SECURE" && refusal.code !== "E_CHILD"))
          return void notify(ctx, `${refusal.code}: ${refusal.detail}`, "warning");
        if (all && (sub === "edit" || sub === "run" || sub === "add" || sub === "repair"))
          return void notify(
            ctx,
            sub === "run"
              ? "run 不能与 --all 一起用：执行只发生在归属会话内，请在那个会话里运行。"
              : "该子命令不支持 --all：请在归属会话里操作。",
            "warning",
          );
        if (all && agent.self === undefined && !READ_SUBS.has(sub))
          return void notify(ctx, "E_UNSUPPORTED: 无法取得进程身份（/proc），不能写入其他会话的账本。", "error");

        switch (sub) {
          case "list":
            return void notify(ctx, all ? listAll(agent) : listOwn(agent));
          case "show":
            return void notify(ctx, showTask(agent, pos[0], all));
          case "log":
            return void notify(ctx, logTask(agent, pos[0], all));
          case "add":
            return void (await add(ctx, agent, pos, parsed, prompt));
          case "edit":
            return void (await edit(ctx, agent, pos, parsed, prompt));
          case "approve":
            return void (await approve(ctx, agent, pos, all));
          case "pause":
          case "resume":
          case "rm":
            return void (await simple(ctx, agent, sub, pos[0], all));
          case "run":
            return void (await run(ctx, agent, pos[0]));
          case "repair":
            return void (await repair(ctx, agent));
        }
      } catch (err) {
        notify(ctx, `E_DEGRADED: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  };

  // ------------------------------------------------------------- read paths

  function ownState(agent: ScheduleAgent): { state?: ScheduleStateFile; error?: string } {
    const r = agent.readState();
    if (r.kind === "ok") return { state: r.state };
    if (r.kind === "absent") return {};
    return { error: `E_DEGRADED: 账本不可读（${r.reason}）。可执行 /schedule repair。` };
  }

  function listOwn(agent: ScheduleAgent): string {
    const r = ownState(agent);
    if (r.error !== undefined) return r.error;
    const n = r.state?.tasks.length ?? 0;
    if (n === 0) return "本会话没有定时任务。让 AI 用 schedule 工具创建，或 /schedule add …（--all 查看所有会话）。";
    return [`本会话 ${n} 个任务：`, ...stateLines(r.state, now())].join("\n");
  }

  function listAll(agent: ScheduleAgent): string {
    const scan = scanAll(agent, deps);
    if (!scan.ok) return scan.text;
    const out: string[] = [];
    for (const s of scan.sessions) {
      if (s.state.tasks.length === 0) continue;
      out.push(
        `会话 ${sid8(s.sessionId)}…${s.sessionId === agent.sessionId ? "（本会话）" : ""}：`,
        ...stateLines(s.state, now()),
      );
    }
    if (scan.degraded.length > 0) out.push(`账本损坏（需在其会话里 /schedule repair）：${scan.degraded.join("，")}`);
    if (scan.truncated) out.push("（会话目录过多，仅显示前 64 个）");
    return out.length === 0 ? "所有会话都没有定时任务。" : out.join("\n");
  }

  function findOwn(
    agent: ScheduleAgent,
    id: string | undefined,
  ): { state?: ScheduleStateFile; task?: ScheduleTask; error?: string } {
    if (id === undefined) return { error: "用法：需要任务 id（/schedule list 查看）" };
    const r = ownState(agent);
    if (r.error !== undefined) return { error: r.error };
    const task = r.state?.tasks.find((t) => t.id === id);
    return task === undefined
      ? { error: `E_INVALID: 本会话没有任务 ${id}（--all 可查其他会话）` }
      : { state: r.state!, task };
  }

  function showTask(agent: ScheduleAgent, id: string | undefined, all: boolean): string {
    let state: ScheduleStateFile | undefined;
    let task: ScheduleTask | undefined;
    if (all) {
      const l = locateAll(agent, deps, id ?? "");
      if (!l.ok) return l.text;
      const snap = l.store.read();
      if (snap.kind !== "ok") return "E_DEGRADED: 账本不可读";
      state = snap.state;
      task = l.task;
    } else {
      const f = findOwn(agent, id);
      if (f.error !== undefined) return f.error;
      state = f.state;
      task = f.task;
    }
    const lines = taskDetail(task!, state!.occ[task!.id], state!.manualTotal[task!.id]);
    const recent = state!.runs.filter((r) => r.taskId === task!.id).slice(-5);
    if (recent.length > 0) lines.push("最近运行：", ...recent.map((r) => `  ${runLine(r, task!.when)}`));
    return lines.join("\n");
  }

  function logTask(agent: ScheduleAgent, id: string | undefined, all: boolean): string {
    let state: ScheduleStateFile | undefined;
    if (all) {
      if (id === undefined) return "用法：/schedule log <id> --all";
      const l = locateAll(agent, deps, id);
      if (!l.ok) return l.text;
      const snap = l.store.read();
      if (snap.kind !== "ok") return "E_DEGRADED: 账本不可读";
      state = snap.state;
    } else {
      const r = ownState(agent);
      if (r.error !== undefined) return r.error;
      state = r.state;
      if (id !== undefined && state?.tasks.find((t) => t.id === id) === undefined)
        return `E_INVALID: 本会话没有任务 ${id}`;
    }
    const tasks = new Map((state?.tasks ?? []).map((t) => [t.id, t]));
    const runs = (state?.runs ?? [])
      .filter((r) => id === undefined || r.taskId === id)
      .sort((a, b) => b.scheduledAt - a.scheduledAt)
      .slice(0, 20);
    if (runs.length === 0) return "没有运行记录。";
    return runs.map((r) => `${r.taskId} · ${runLine(r, tasks.get(r.taskId)?.when)}`).join("\n");
  }

  // ------------------------------------------------------------- write paths

  async function add(
    ctx: ExtensionCommandContext,
    agent: ScheduleAgent,
    pos: string[],
    parsed: Parsed,
    prompt: string | undefined,
  ): Promise<void> {
    const built = flagsToRaw(parsed, prompt, pos[0]);
    if ("error" in built) return void notify(ctx, `${built.error}\n${USAGE}`, "warning");
    // Interactive completion of the three required fields (TUI / RPC with a UI).
    const ask = async (title: string, placeholder?: string): Promise<string | undefined> => {
      try {
        const v = await ctx.ui.input(title, placeholder);
        return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
      } catch {
        return undefined;
      }
    };
    if (built.name === undefined) built.name = await ask("任务名称（≤40 字符）");
    if (built.when === undefined) {
      const w = await ask("时间：5 段 cron（如 0 8 * * *）或一次性本地时间 YYYY-MM-DDTHH:mm");
      if (w !== undefined) built.when = ONCE_SHAPE.test(w) ? { kind: "once", at: w } : { kind: "cron", expr: w };
    }
    if (built.prompt === undefined) built.prompt = await ask("任务 prompt（后台任务需自包含）");
    if (built.name === undefined || built.when === undefined || built.prompt === undefined)
      return void notify(ctx, `信息不完整，未创建。\n${USAGE}`, "warning");
    const res = await createTask(deps.ports(agent, ctx), built, originOf(ctx));
    if (!res.ok) return void notify(ctx, failText(res), "error");
    notify(
      ctx,
      `已创建并批准 ${res.value.id} "${res.value.name}"（hash ${defHash(res.value).slice(0, 8)}）。仅在本会话打开时运行。`,
    );
  }

  async function edit(
    ctx: ExtensionCommandContext,
    agent: ScheduleAgent,
    pos: string[],
    parsed: Parsed,
    prompt: string | undefined,
  ): Promise<void> {
    const id = pos[0];
    if (id === undefined) return void notify(ctx, `用法：/schedule edit <id> [参数] [-- <prompt>]`, "warning");
    const built = flagsToRaw(parsed, prompt, undefined);
    if ("error" in built) return void notify(ctx, `${built.error}\n${USAGE}`, "warning");
    if (Object.keys(built).length === 0) return void notify(ctx, "没有要修改的内容。", "warning");
    const res = await updateTask(deps.ports(agent, ctx), id, built, originOf(ctx));
    if (!res.ok) return void notify(ctx, failText(res), "error");
    notify(
      ctx,
      isApproved(res.value)
        ? `已修改 ${id}（已重新批准，hash ${defHash(res.value).slice(0, 8)}）。`
        : `已修改 ${id}，但任务仍待确认：审阅后执行 /schedule approve ${id}。`,
      isApproved(res.value) ? "info" : "warning",
    );
  }

  async function approve(
    ctx: ExtensionCommandContext,
    agent: ScheduleAgent,
    pos: string[],
    all: boolean,
  ): Promise<void> {
    const id = pos[0];
    const given = pos[1];
    if (id === undefined || pos.length > 2)
      return void notify(ctx, "用法：/schedule approve <id> [<hash>] [--all]", "warning");
    if (given !== undefined && !SCHED_HASH_RE.test(given))
      return void notify(ctx, "E_INVALID: hash 应为 64 位十六进制（来自审阅界面）", "warning");
    let store: SessionStore;
    let own = true;
    if (all) {
      const l = locateAll(agent, deps, id);
      if (!l.ok) return void notify(ctx, l.text, "error");
      store = l.store;
      own = l.sessionId === agent.sessionId; // a foreign process's in-memory queue is out of reach (ledger half only)
    } else {
      const g = agent.gate();
      if (g !== undefined) return void notify(ctx, `${g.code}: ${g.detail}`, "error");
      const s = agent.store();
      if (s === undefined) return void notify(ctx, `E_INVALID: 本会话没有任务 ${id}`, "error");
      store = s;
    }
    const r = await approveFlow(ctx, store, id, given, isWebInvocation(ctx) ? "web" : "tui");
    if (r.changed) agent.changed();
    notify(ctx, r.text, r.level);
  }

  function revokeOpts(agent: ScheduleAgent, ctx: ExtensionCommandContext, own: boolean): RevokeOpts {
    if (!own) return {};
    const revoke = deps.ports(agent, ctx).revokeQueued;
    return revoke === undefined ? {} : { revoke };
  }

  async function simple(
    ctx: ExtensionCommandContext,
    agent: ScheduleAgent,
    sub: "pause" | "resume" | "rm",
    id: string | undefined,
    all: boolean,
  ): Promise<void> {
    if (id === undefined) return void notify(ctx, `用法：/schedule ${sub} <id> [--all]`, "warning");
    let store: SessionStore;
    let own = true;
    if (all) {
      const l = locateAll(agent, deps, id);
      if (!l.ok) return void notify(ctx, l.text, "error");
      store = l.store;
      own = l.sessionId === agent.sessionId; // a foreign process's in-memory queue is out of reach (ledger half only)
    } else {
      const g = agent.gate();
      if (g !== undefined) return void notify(ctx, `${g.code}: ${g.detail}`, "error");
      const s = agent.store();
      if (s === undefined) return void notify(ctx, `E_INVALID: 本会话没有任务 ${id}`, "error");
      store = s;
    }
    if (sub === "rm") {
      const r = await deleteTask(store, id, revokeOpts(agent, ctx, own));
      if (!r.ok) return void notify(ctx, failText(r), "error");
      agent.changed();
      return void notify(ctx, `已删除 ${id}（已有运行记录保留在历史里）。`);
    }
    const r = await setTaskEnabled(store, id, sub === "resume", revokeOpts(agent, ctx, own));
    if (!r.ok) return void notify(ctx, failText(r), "error");
    agent.changed();
    notify(
      ctx,
      sub === "pause"
        ? `已暂停 ${id}。`
        : isApproved(r.value)
          ? `已恢复 ${id}。`
          : `已恢复 ${id}，但任务仍待确认（恢复不等于批准）：/schedule approve ${id}。`,
      sub === "resume" && !isApproved(r.value) ? "warning" : "info",
    );
  }

  async function run(ctx: ExtensionCommandContext, agent: ScheduleAgent, id: string | undefined): Promise<void> {
    if (id === undefined || !SCHED_TASK_ID_RE.test(id)) return void notify(ctx, "用法：/schedule run <id>", "warning");
    const r = await agent.runNow({ taskId: id, reqId: randomBytes(12).toString("base64url") });
    if (r.kind === "refused") {
      const hint =
        r.code === "E_UNAPPROVED"
          ? "（任务待确认：/schedule approve " + id + "）"
          : r.code === "E_OVERLAP"
            ? "（该任务已有运行在进行）"
            : "";
      return void notify(ctx, `${r.code}: ${r.detail ?? "已拒绝"}${hint}`, "warning");
    }
    notify(ctx, `已开始运行 ${r.runKey}；结果会作为消息出现在本会话。`);
  }

  async function repair(ctx: ExtensionCommandContext, agent: ScheduleAgent): Promise<void> {
    // The dispatcher's own blockers (a lost ui `end`, a stuck fence window) never lift on their own (M1):
    // this local-only subcommand is the escape that works even when fabric/xs (/fabric fence reset) is off.
    // Local TUI/RPC only: a web invocation (even under a permissive `webCommandPolicy.schedule`) never resets it.
    const reset = deps.resetBlockers !== undefined && !isWebInvocation(ctx);
    if (reset) deps.resetBlockers!();
    const r = ownState(agent);
    if (r.error === undefined)
      return void notify(
        ctx,
        `本会话的账本正常，无需修复。${reset ? "调度器的栅栏窗口与对话计数已重置（仅本地）。" : ""}`,
      );
    let store: SessionStore;
    try {
      store = agent.store() ?? agent.ensureStore();
    } catch (err) {
      return void notify(ctx, `E_DEGRADED: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    const res = await store.repair();
    if (!res.ok) return void notify(ctx, `${res.code}: ${res.detail}`, "error");
    agent.changed();
    notify(
      ctx,
      res.value.quarantined
        ? "已把损坏的账本移到 state.json.bak，并从空账本重新开始（旧任务需重建）。"
        : "没有需要隔离的内容。",
      "warning",
    );
  }

  // ------------------------------------------------------------- __put (web review form)

  async function put(ctx: ExtensionCommandContext, agent: ScheduleAgent, rest: string): Promise<void> {
    const m = /^([\s\S]*\S)\s+([0-9a-f]{64})$/.exec(rest);
    if (m === null) return void notify(ctx, "E_INVALID: 用法 /schedule __put <json> <64位hash>", "error");
    let body: unknown;
    try {
      body = JSON.parse(m[1]!);
    } catch {
      return void notify(ctx, "E_INVALID: json 无法解析", "error");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return void notify(ctx, "E_INVALID: json 须是对象", "error");
    const rec = body as Record<string, unknown>;
    const badKey = Object.keys(rec).find((k) => !PUT_KEYS.has(k));
    if (badKey !== undefined) return void notify(ctx, `E_INVALID: 未知字段 ${badKey}`, "error");
    const hash = m[2]!;
    const refusal = actionRefusal(agent.mode, "create");
    if (refusal !== undefined) return void notify(ctx, `${refusal.code}: ${refusal.detail}`, "error");
    const ports = deps.ports(agent, ctx);
    const raw: RawFields = {
      ...(rec.name !== undefined ? { name: rec.name } : {}),
      ...(rec.form !== undefined ? { form: rec.form } : {}),
      ...(rec.when !== undefined ? { when: rec.when } : {}),
      ...(rec.prompt !== undefined ? { prompt: rec.prompt } : {}),
      ...(rec.feishu !== undefined ? { feishu: rec.feishu } : {}),
      ...(rec.bg !== undefined ? { bg: rec.bg } : {}),
    };
    const origin = originOf(ctx);
    const id = rec.id;
    if (id !== undefined) {
      if (typeof id !== "string" || !SCHED_TASK_ID_RE.test(id)) return void notify(ctx, "E_INVALID: id 无效", "error");
      if (typeof rec.baseHash !== "string" || !SCHED_HASH_RE.test(rec.baseHash))
        return void notify(ctx, "E_INVALID: 编辑必须带 baseHash（表单加载时的定义 hash）", "error");
    } else if (rec.baseHash !== undefined) return void notify(ctx, "E_INVALID: 创建不能带 baseHash", "error");

    if (hash === ZERO_HASH) {
      // PREVIEW: compute the hash the dialog must bind; nothing is written.
      let ownerCwd = ports.ownerCwd();
      let base;
      if (id !== undefined) {
        const t = ownState(agent).state?.tasks.find((x) => x.id === id);
        if (t === undefined) return void notify(ctx, `E_INVALID: 没有任务 ${id}`, "error");
        if (defHash(t) !== rec.baseHash) return void notify(ctx, "E_REV: 任务已变更，请重新载入后再审阅", "warning");
        ownerCwd = t.ownerCwd;
        base = defOf(t);
      }
      const def = resolveDef(raw, base, ports);
      if (!def.ok) return void notify(ctx, failText(def), "error");
      const h = previewHash(def.value, ownerCwd);
      return void notify(
        ctx,
        [`PREVIEW defHash=${h}`, `${def.value.name} · ${def.value.form}`, `prompt: ${def.value.prompt}`].join("\n"),
      );
    }
    const res =
      id === undefined
        ? await createTask(ports, raw, origin, { expectHash: hash })
        : await updateTask(ports, id, raw, origin, {
            baseHash: rec.baseHash as string,
            expectHash: hash,
            approveReviewed: true,
          });
    if (!res.ok) return void notify(ctx, failText(res), res.code === "E_REV" ? "warning" : "error");
    notify(ctx, `OK ${res.value.id} defHash=${defHash(res.value)}`);
  }
}
