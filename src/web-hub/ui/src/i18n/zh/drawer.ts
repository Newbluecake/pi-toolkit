/**
 * `drawer` i18n namespace, Chinese (fleet-drawer plan v2 §6 — F6). `satisfies
 * Messages<typeof en>` 让缺/多键成为 vue-tsc 编译错误;`i18n-parity.test.ts` 再在运行时
 * 校验键与 `{placeholder}` 集合。
 */
import en from "../en/drawer.js";

type Messages<T> = { [K in keyof T]: string };

const drawer = {
  close: "关闭子 Agent 抽屉",
  backToTree: "子 Agent 列表",
  runTranscriptAria: "子 Agent 对话",
  parentMissing: "父 run 未列出",
  omittedActive: "另有 {n} 个运行中未列出",
  omittedTerminal: "另有 {n} 个已结束未列出",
  notListed: "不在列表中",
  reconnecting: "重新连接中…",
  retry: "重试",
  terminalStatus: "已结束 · {status}",
  watchingOff: "实时更新名额已满 —— 改为显示最近一次上报的活动",
  "reason.unknown_run": "该子 agent 已不在当前会话的记录中。",
  "reason.not_persisted": "未持久化(rememberAgents=false),结束后对话不可回看。",
  "reason.file_missing": "它在首条回复前就结束了,没有可显示的对话。",
  "reason.leaf_unknown": "无法确定最终对话位置。",
  "reason.leaf_missing": "会话文件与记录不一致。",
  "reason.too_large": "会话文件过大,无法在 web 端显示。",
  "reason.parse_error": "会话文件损坏。",
  "reason.unsupported": "当前连接不提供子 agent 对话。",
  "reason.busy": "繁忙,请稍后重试。",
  "reason.resync_storm": "实时更新暂时不稳定,请稍后重试。",
} satisfies Messages<typeof en>;

export default drawer;
