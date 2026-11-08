/**
 * `schedule` namespace — the LAZY i18n for `SchedulePanel.vue` / `ScheduleTaskDetail.vue`
 * (scheduled-reports W1, plan r3 §5.6). Same posture as `channels-extra.ts`: NOT under
 * `en/`/`zh/` (the eager glob would fold it into the first-screen bundle); the lazy dialog
 * chunk calls `registerScheduleExtra()` once on setup. Parity: zh
 * `satisfies Record<keyof typeof en, string>` + `tests/web-hub/ui/schedule-panel.test.ts`.
 *
 * UI-text rule (AGENTS.md): compact inline markers (badges, state tokens) stay English in BOTH
 * locales; prose (hints, notices, detail copy) is translated.
 */
import { MESSAGES } from "./index.js";

const en = {
  panelTitle: "Scheduled tasks",
  close: "Close",
  sectionTasks: "Tasks · {n}",
  sectionRuns: "Recent runs",
  empty: "No scheduled tasks in this session yet.",
  /** Offline (E3): read-only + the terminal pointer. */
  offlineNote: "Session offline — read-only. Manage tasks from any local terminal: /schedule … --all",
  /** Store unreadable (§5.6 / reader.ts): repair hint with the hub-reported reason. */
  degradedNote: "Task store unreadable ({reason}) — run /schedule repair in a terminal.",
  /** Panel-wide stale (consult r1 Q3): connection down ⇒ last snapshot + feishu ⇒ "?". */
  staleNote: "Hub connection lost — showing the last snapshot; Feishu receipt states are unknown.",
  staleChip: "stale",
  /** droppedReports (§4.2.1): the pending-reports index overflowed. */
  droppedReports: "{n} report(s) were never delivered (index overflow)",
  /** Per-task missed total > 0 (§4.4/§5.5). */
  missedNote: "{n} missed",

  taskEnabled: "enabled",
  taskPaused: "paused",
  /** r2 §6-W2: task-row action buttons (policy-confirm write path). */
  taskPause: "Pause",
  taskPauseAria: "Pause scheduled task {name}",
  taskResume: "Resume",
  taskResumeAria: "Resume scheduled task {name}",
  taskRemove: "Delete",
  taskRemoveAria: "Delete scheduled task {name}",
  actionFailed: "Action failed: {reason}",
  runOpen: "Open run in fleet",
  runOpenAria: "Open run {id} in fleet",
  taskStats: "fired {fired} · missed {missed} · skipped {skipped} · manual {manual}",
  taskFeishuOn: "feishu",
  taskNext: "next {t}",
  taskNextRelative: "next {t}",
  taskTriggerPaused: "trigger paused",
  taskDue: "due",
  taskNextNever: "next —",
  taskCreatedByAgent: "created by AI",
  whenCron: "cron {expr} ({tz})",
  whenOnce: "once {expr} ({tz})",
  whenInvalid: "(invalid schedule)",
  formBackground: "background",
  formMessage: "message",

  runAuto: "auto",
  runManual: "manual",
  runAt: "{t}",
  runDuration: "{s}s",
  runReport: "report {file}",
  runFeishu: "feishu {state}",
  /** runState.* — run-state vocabulary (§4.2); English tokens in both locales. */
  "runState.dispatching": "dispatching",
  "runState.running": "running",
  "runState.queued": "queued",
  "runState.dispatched": "dispatched",
  "runState.bound": "bound",
  "runState.aborting": "aborting",
  "runState.completed": "completed",
  "runState.failed": "failed",
  "runState.timed_out": "timed_out",
  "runState.aborted": "aborted",
  "runState.refused": "refused",
  "runState.settled": "settled",
  "runState.continued": "continued",
  "runState.unknown": "unknown",
  "runState.dropped": "dropped",
  /** runReason.* — prose for the dropped reasons (the leaf is `runReasonKey(state, reason)`; unknown ⇒ raw text). */
  "runReason.coalesced": "replaced by a newer run of the same task while queued",
  "runReason.owner-closed": "the owner session closed before it was sent",
  "runReason.capability": "this pi cannot be triggered by scheduled messages",
  "runReason.capability-unknown": "queued over 30 min with the pi trigger capability still unconfirmed",
  "runReason.start-timeout": "the trigger never started within 60 s",
  "runReason.task-changed": "the task was paused, changed or deleted while queued — not sent",
  /** feishu.* — receipt display (§7.1); "q" is the frontend-derived "?" (hub unreachable). */
  "feishu.accepted": "accepted",
  "feishu.sent": "sent",
  "feishu.failed": "failed",
  "feishu.uncertain": "uncertain",
  "feishu.refused": "refused",
  "feishu.none": "none",
  "feishu.na": "n/a",
  "feishu.waiting": "waiting",
  "feishu.expired": "expired",
  "feishu.q": "?",

  /** ScheduleTaskDetail — the read-only full-definition view (schedule-auto-approve r2 §6-W1). */
  detailTitle: "Scheduled task — {name}",
  reviewPromptLabel: "Full prompt",
  kvWhen: "Schedule",
  kvForm: "Form",
  kvFeishu: "Feishu push",
  kvType: "Agent type",
  kvModel: "Model",
  kvThinking: "Thinking",
  kvTimeout: "Timeout",
  kvConsult: "Consult this session (legacy, ignored)",
  kvHandoff: "Hand off when done",
  kvIsolation: "Worktree isolation",
  kvCreatedBy: "Created by",
  kvOn: "yes",
  kvOff: "no",
  createdByUser: "user · {at}",
  createdByAgent: "AI tool · {at}",
  cancel: "Cancel",
} satisfies Record<string, string>;

const zh: Record<keyof typeof en, string> = {
  panelTitle: "定时任务",
  close: "关闭",
  sectionTasks: "任务 · {n}",
  sectionRuns: "运行记录",
  empty: "本会话还没有定时任务。",
  offlineNote: "会话离线——只读。管理任务请到任意本地终端执行 /schedule … --all。",
  degradedNote: "任务数据不可读（{reason}）——需在终端执行 /schedule repair。",
  staleNote: "与 hub 的连接已断开——以下为最后一次快照；飞书回执状态未知。",
  staleChip: "可能已过时",
  droppedReports: "{n} 份报告未能投递（索引溢出）",
  missedNote: "错过 {n} 次",

  taskEnabled: "已启用",
  taskPaused: "已暂停",
  /** r2 §6-W2：任务行操作按钮（走 policy confirm 的写路径）。 */
  taskPause: "暂停",
  taskPauseAria: "暂停定时任务 {name}",
  taskResume: "继续",
  taskResumeAria: "继续定时任务 {name}",
  taskRemove: "删除",
  taskRemoveAria: "删除定时任务 {name}",
  actionFailed: "操作失败：{reason}",
  runOpen: "在 fleet 中打开 run",
  runOpenAria: "在 fleet 中打开 run {id}",
  taskStats: "已执行 {fired} · 错过 {missed} · 跳过 {skipped} · 手动 {manual}",
  taskFeishuOn: "推飞书",
  taskNext: "下次 {t}",
  taskNextRelative: "下次 {t} 后",
  taskTriggerPaused: "暂停触发",
  taskDue: "即将触发",
  taskNextNever: "下次 —",
  taskCreatedByAgent: "AI 创建",
  whenCron: "cron {expr}（{tz}）",
  whenOnce: "一次性 {expr}（{tz}）",
  whenInvalid: "（时间定义无效）",
  formBackground: "后台运行",
  formMessage: "定时消息",

  runAuto: "自动",
  runManual: "手动",
  runAt: "{t}",
  runDuration: "{s}s",
  runReport: "报告 {file}",
  runFeishu: "飞书 {state}",
  "runState.dispatching": "dispatching",
  "runState.running": "running",
  "runState.queued": "queued",
  "runState.dispatched": "dispatched",
  "runState.bound": "bound",
  "runState.aborting": "aborting",
  "runState.completed": "completed",
  "runState.failed": "failed",
  "runState.timed_out": "timed_out",
  "runState.aborted": "aborted",
  "runState.refused": "refused",
  "runState.settled": "settled",
  "runState.continued": "continued",
  "runState.unknown": "unknown",
  "runState.dropped": "dropped",
  /** runReason.* — dropped 原因的说明文案（叶子由 `runReasonKey(state, reason)` 给出；未知原因显示原文）。 */
  "runReason.coalesced": "排队期间被同一任务的新一次运行取代",
  "runReason.owner-closed": "发送前归属会话已关闭",
  "runReason.capability": "当前 pi 不支持定时消息触发",
  "runReason.capability-unknown": "排队超过 30 分钟仍未确认 pi 的触发能力",
  "runReason.start-timeout": "触发后 60 秒内没有启动",
  "runReason.task-changed": "排队期间任务被暂停、修改或删除，未发送",
  "feishu.accepted": "accepted",
  "feishu.sent": "sent",
  "feishu.failed": "failed",
  "feishu.uncertain": "uncertain",
  "feishu.refused": "refused",
  "feishu.none": "none",
  "feishu.na": "n/a",
  "feishu.waiting": "waiting",
  "feishu.expired": "expired",
  "feishu.q": "?",

  detailTitle: "定时任务详情 — {name}",
  reviewPromptLabel: "Prompt 全文",
  kvWhen: "触发",
  kvForm: "形式",
  kvFeishu: "推飞书",
  kvType: "类型",
  kvModel: "模型",
  kvThinking: "thinking",
  kvTimeout: "超时",
  kvConsult: "consult 本会话（已移除，忽略）",
  kvHandoff: "完成后接手",
  kvIsolation: "worktree 隔离",
  kvCreatedBy: "创建者",
  kvOn: "是",
  kvOff: "否",
  createdByUser: "用户 · {at}",
  createdByAgent: "AI 工具 · {at}",
  cancel: "取消",
};

export const SCHEDULE_EXTRA: Readonly<Record<"en" | "zh", Readonly<Record<string, string>>>> = { en, zh };

let registered = false;

/** Merge the lazy keys into `MESSAGES.<lang>.schedule` (idempotent). */
export function registerScheduleExtra(): void {
  if (registered) return;
  registered = true;
  for (const lang of ["en", "zh"] as const) {
    const dict = MESSAGES[lang]["schedule"];
    if (dict === undefined) MESSAGES[lang]["schedule"] = { ...SCHEDULE_EXTRA[lang] };
    else for (const [k, v] of Object.entries(SCHEDULE_EXTRA[lang])) if (!(k in dict)) dict[k] = v;
  }
}
