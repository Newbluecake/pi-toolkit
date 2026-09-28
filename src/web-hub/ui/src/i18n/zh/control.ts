/**
 * `control` i18n namespace, Chinese (control-plan.md v2.1 §7.6 — C5). Compact inline markers
 * (badges/states/policies) deliberately stay English tokens (AGENTS.md UI-text split); prose
 * blocks are translated.
 */
import en from "../en/control.js";

type Messages<T> = { [K in keyof T]: string };

const control = {
  noticePlainHttp:
    "控制已开启：本页可以向 agent 发送消息、中止任务。当前经明文 HTTP 访问，同一网络中能截获流量的人可以冒用你的登录、以你的身份执行任意命令。",
  noticeLocal: "控制已开启：你发送的消息将以本机用户的完整权限执行。",
  noticeHttps: "控制已开启：你发送的消息将以宿主机用户的完整权限执行。",
  noticeTitle: "控制已开启",
  noticeExpand: "详情",
  noticeCollapse: "收起详情",

  placeholderIdle: "输入消息（将开始新一轮）",
  placeholderBusy: "输入消息（插话当前轮；Alt+Enter 排到之后）",
  send: "发送",
  sendAria: "发送消息",
  deliverGroup: "投递方式",
  deliverSteer: "Steer",
  deliverFollowUp: "Follow-up",
  idleHint: "空闲——将开始新一轮",

  stop: "Stop",
  stopConfirm: "确认中止",
  stopAria: "中止当前轮",
  stopArmed: "已待确认——再次点击确认，Esc 取消",
  stopQueueNote: "排队中的 {n} 条仍会发送",

  queueAria: "消息队列",
  badgeSteer: "steer",
  badgeFollowUp: "follow-up",
  sourceWeb: "web",
  sourceTerminal: "terminal",
  stateSending: "sending",
  stateQueued: "queued",
  stateFailed: "failed",
  stateDropped: "dropped",
  stateUnknown: "unknown",
  stateQuerying: "checking",
  stateNotExecuted: "not executed",
  stateUnconfirmed: "unconfirmed",
  stateUnobserved: "sent · unconfirmed",
  stateRunning: "running",
  retry: "重试",
  retryAria: "重试此项",
  discard: "丢弃",
  discardAria: "丢弃此项",
  resend: "重新发送",
  resendAria: "作为新操作重新发送",
  droppedNote: "已退回终端编辑器或被丢弃。",
  unconfirmedNote: "已发送，未能确认是否进入对话——请看对话流。",
  unknownNote: "结果未知——正在向 agent 查询，绝不自动重发。",
  offlineNote: "结果未知——agent 已离线。",
  notExecutedNote: "从未到达 agent——请作为新操作重新发送。",
  sessionChanged: "终端已切换会话——确认后重新发送。",
  resultUnknown: "结果未知——不会自动重复执行。",
  hubRestarting: "hub 正在重启——该请求未被接收，恢复后请重试。",

  cmdBadge: "cmd",
  sendAsText: "作为文本发送",
  paletteAria: "命令补全",
  policyAllow: "allow",
  policyConfirm: "confirm",
  policyDeny: "deny",
  outputHere: "output here",
  outputTerminal: "output in terminal",
  cmdDeniedTerminal: "仅终端可用",
  cmdDeniedUnknown: "未知命令——绝不会作为普通文本发送",
  cmdConfirm: "执行 /{name}？",
  cmdConfirmHint: "该命令需要二次确认——再次点击执行。",
  cmdRunning: "执行中…",
  cmdWaitingTerminal: "该命令正在终端等待交互。",
  cmdFailed: "/{name} 失败：{error}",

  "cmdOutput.needsTerminal": "此命令的交互步骤需要在终端完成，网页已跳过：{steps}",
  "cmdOutput.terminalOnly": "此命令的输出只在终端显示。",
  "cmdOutput.truncated": "输出过长——已丢弃 {entries} 条 / {kib} KiB，完整内容见终端。",
  "cmdOutput.clipped": "…",

  dockReadonlyHub: "此 hub 为只读",
  dockReadonlyAgent: "此 pi 的 pi-toolkit 不支持网页控制——请更新并 /reload",
  dockReadonlyOffline: "Agent 离线",

  fleetActionsAria: "子 agent 操作",

  badgeWeb: "web",
} satisfies Messages<typeof en>;

export default control;
