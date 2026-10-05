/**
 * `detail` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/detail.js";

type Messages<T> = { [K in keyof T]: string };

const detail = {
  selectAgentTitle: "选择一个代理",
  selectAgentBody: "在左侧选择一个会话，查看它的对话、工具调用与子代理。",
  notConnectedTitle: "该代理未连接",
  notConnectedBody: "它可能已退出，或链接已过期。",
  sessionDetailsAria: "会话详情",
  kvCwd: "cwd",
  kvSession: "会话",
  kvModel: "模型",
  kvProcess: "进程",
  copyCwd: "复制 cwd",
  copySession: "复制会话 ID",
  contextLabel: "上下文",
  contextAria: "已用上下文",
  costLabel: "花费",
  metricsToggleAria: "切换上下文与花费指标",
  subCost: "子代理 {v}",
  waitingOnDialog: "正在等待终端中的对话框：",
  waitingMore: "（+{n} 更多）",
  staleBanner: "过期 — 无最近心跳，数据可能已过期。",
  offlineBanner: "离线 — pi 进程已退出，正在显示最后已知的记录。",
  versionMismatch: "界面构建于 {c1}，hub 为 {c2} — 建议重新运行 npm run build:web。",
  loadingHistory: "正在加载历史记录…",
  dockLong: "· 请在终端中回复",
  latest: "最新",
  newCount: "{n} 条新消息",
} satisfies Messages<typeof en>;

export default detail;
