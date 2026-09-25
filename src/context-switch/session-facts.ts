/**
 * context-switch · 机械附录的事实采集（pi-facing 组装，index.ts 保持 assembly-only / I7）。
 *
 * 这些是"模型写交接内容时最容易漏、而扩展能确定性提供"的事实：仍在跑的 subagent 与后台
 * bash 任务（切换后它们还活着，模型必须知道）、未完成的 todo、上一段会话文件路径（可回读原文）。
 * 任何一项采集失败都必须静默降级——附录缺一行远好过让上下文切换整体失败。
 */

import type { Stack } from "../stack.js";
import type { AgentSettings } from "../config/settings.js";
import { replayState } from "../todo/state.js";
import type { HandoffAppendix } from "./handoff.js";
import type { SessionFactsProvider } from "./hook.js";

/** 事件 ctx 上我们用到的部分（结构化，便于单测）。 */
export interface SessionFactsCtx {
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getBranch?: (fromId?: string) => unknown[];
  };
}

const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "timed_out", "aborted"];
const LIVE_JOB_STATUSES: readonly string[] = ["staged", "running"];

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** 反查 label：mention 注册表是 label → target，这里做一次线性反查（规模 = 活跃 run 数）。 */
function labelIndex(stack: Stack | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!stack) return index;
  const labels = safe(() => stack.mention.labels()) ?? [];
  for (const label of labels) {
    const target = safe(() => stack.mention.resolve(label));
    if (target && !index.has(target.runId)) index.set(target.runId, label);
  }
  return index;
}

export function collectSessionFacts(
  stack: Stack | undefined,
  ctx: SessionFactsCtx | undefined,
  settings: AgentSettings,
): Pick<HandoffAppendix, "sessionFile" | "runs" | "bashJobs" | "todos"> {
  const facts: { sessionFile?: string; runs?: string[]; bashJobs?: string[]; todos?: string[] } = {};

  const sessionFile = safe(() => ctx?.sessionManager?.getSessionFile?.());
  if (sessionFile) facts.sessionFile = sessionFile;

  const snapshots = safe(() => stack?.query.list()) ?? [];
  const labels = labelIndex(stack);
  const runs = snapshots
    .filter((snapshot) => !TERMINAL_RUN_STATUSES.includes(snapshot.status))
    .map((snapshot) => {
      const label = labels.get(snapshot.runId);
      const handle = label ? `${label} (${snapshot.runId.slice(0, 8)})` : snapshot.runId.slice(0, 8);
      return `${handle} — ${snapshot.status}/${snapshot.phase}`;
    });
  // Background SubagentWorkflows survive the switch too (docs/dev/workflow-background/plan.md).
  const workflows = safe(() => stack?.workflow.runs.list()) ?? [];
  for (const wf of workflows) {
    if (wf.status === "running") runs.push(`workflow "${wf.name}" (${wf.workflowId}) — running`);
  }
  if (runs.length > 0) facts.runs = runs;

  const jobs = safe(() => stack?.bashJobs?.list()) ?? [];
  const liveJobs = jobs
    .filter((job) => LIVE_JOB_STATUSES.includes(job.status))
    .map((job) => `${job.jobId.slice(0, 8)} — ${job.command.replace(/\s+/g, " ").slice(0, 120)}`);
  if (liveJobs.length > 0) facts.bashJobs = liveJobs;

  if (settings.todo.enabled) {
    const branch = safe(() => ctx?.sessionManager?.getBranch?.()) ?? [];
    const state = branch.length > 0 ? safe(() => replayState(branch)) : undefined;
    const open = (state?.tasks ?? [])
      .filter((task) => task.status !== "completed")
      .map((task) => `#${task.id} ${task.subject} [${task.status}]`);
    if (open.length > 0) facts.todos = open;
  }

  return facts;
}

/** index.ts 用的现成闭包：读 holder 的当前 stack，永不抛。 */
export function createSessionFactsProvider(holder: { current?: Stack }, settings: AgentSettings): SessionFactsProvider {
  return (ctx) => collectSessionFacts(holder.current, ctx as SessionFactsCtx | undefined, settings);
}
