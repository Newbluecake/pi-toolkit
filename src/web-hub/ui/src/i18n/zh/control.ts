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
  noticeDismiss: "关闭此提醒",

  // 2026-10-07（用户反馈「插话当前轮的提示不优雅」×2「太长了，需要精简」）：简短句式；
  // busy 两条仍跟随设置页的默认投递方式（验收 P2——固定写死插话文案在默认为 follow-up 时
  // 会说谎）。
  placeholderIdle: "请输入消息…",
  placeholderBusy: "请输入插话内容…",
  placeholderBusyFollowUp: "请输入排队消息…",
  send: "发送",
  sendAria: "发送消息",

  contextRingAria: "上下文已用 {p}——点击查看详情",
  contextRingPanelAria: "上下文与花费详情",

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

  mentionAria: "提及与文件",
  mentionZone: "子 agent",
  fileZone: "文件",
  mentionEmpty: "无匹配的子 agent 或文件",

  badgeWeb: "web",

  // model switcher（web-model-switch §5，M3a）——tab/徽标/snapshot 保持英文 token
  modelChipAria: "切换模型",
  modelListAria: "模型列表",
  modelSearch: "搜索模型",
  modelTabScoped: "scoped",
  modelTabAll: "all",
  modelCurrentBadge: "current",
  modelEmpty: "没有已配置凭据的模型",
  modelNoMatch: "没有匹配的模型",
  modelReadError: "无法读取完整模型列表",
  modelBusyNote: "当前正在输出的回复不受影响，之后的请求使用新模型",
  modelOmitted: "+{n} omitted",
  modelInvalidCount: "{n} invalid",
  modelSnapshot: "snapshot {t}",
  modelOldAgent: "升级 pi-toolkit 后可在此选择模型——或在下方输入 /model provider/id",
  modelDeniedPolicy: "webCommandPolicy 已禁用切换模型",
  modelDeniedShadowed: "/model 被扩展同名命令遮蔽——请在终端切换模型",
  modelConfirm: "切换到 {id}？",
  modelConfirmRun: "切换",
  modelConfirmCancel: "取消",
  modelErrRejected: "该模型的 provider 未配置凭据，或请求被拒绝",
  modelErrUnknown: "找不到模型——列表可能已过期",
  modelErrDenied: "webCommandPolicy 已禁用切换模型",
  modelErrSession: "会话已切换——请重新选择",
  modelErrInvalidRef: "模型引用无效——未发送",
  modelUnconfirmed: "尚未确认——请查看会话确认结果",
  modelErrGeneric: "切换模型失败（{code}）",
  modelCheck: "check",
  modelDismiss: "关闭",

  // thinking chip（web-model-switch §5.1/§6，M3b）——档位名与 clamp 标记保持英文 token
  thinkingChipAria: "切换思考档位",
  thinkingListAria: "思考档位",
  thinkingCurrentBadge: "current",
  thinkingOldAgent: "升级 pi-toolkit 后可在此选择思考档位——或在下方输入 /thinking <level>",
  thinkingNoLevels: "未上报思考档位——请升级 pi-toolkit，或输入 /thinking <level>",
  thinkingUnsupported: "当前模型不支持思考档位",
  thinkingDeniedPolicy: "webCommandPolicy 已禁用切换思考档位",
  thinkingDeniedShadowed: "/thinking 被扩展同名命令遮蔽——请在终端设置档位",
  thinkingConfirm: "设为 {level}？",
  thinkingConfirmRun: "设置",
  thinkingConfirmCancel: "取消",
  thinkingClamped: "clamped to {level}",
  thinkingBusyNote: "当前正在输出的回复不受影响，之后的请求使用新档位",
  thinkingErrBadLevel: "未知思考档位",
  thinkingErrDenied: "webCommandPolicy 已禁用切换思考档位",
  thinkingErrSession: "会话已切换——请重新选择",
  thinkingErrGeneric: "设置思考档位失败（{code}）",
  thinkingDismiss: "关闭",
} satisfies Messages<typeof en>;

export default control;
