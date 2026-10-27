/**
 * `outdated` i18n namespace，中文（#65 outdated-reload，预览 §1–§7 的中文文案以此为准）。
 * 结构约束见 `en/outdated.ts` 头注；键集合两语言必须一致（i18n-parity 测试 + satisfies）。
 */
import en from "../en/outdated.js";

type Messages<T> = { [K in keyof T]: string };

export default {
  bannerPre: "此会话的插件版本",
  bannerMid: "落后于 hub",
  bannerSuffix: "。重新加载后生效（会话内容不丢失）。",
  reload: "重新加载",
  later: "暂不",
  reloading: "正在重新加载…",
  queuedText: "当前正在运行，将在本轮结束、空闲后自动重新加载。",
  queuedFleetText: "有 {n} 个子 agent/任务正在运行，将在其结束后自动重新加载。",
  parkedText: "重新加载命令已送达，正在等待 {n} 个子 agent 结束后自动执行。",
  cancelQueue: "取消排队",
  awaitingText: "命令已送达，等待重新加载生效…",
  failedPre: "重新加载失败：",
  retry: "重试",
  close: "关闭",
  donePre: "已重新加载到",
  errOffline: "会话进程已退出，无法送达 /reload",
  errUnsupported: "此会话未开启网页控制面，无法送达 /reload",
  errTimeout: "命令已送达，但未在限定时间内生效",
  errQueueTimeout: "等待会话空闲超时，已取消排队",
  chipNeedsUpdate: "需更新",
  chipTitle: "插件版本落后于 hub — 点击重新加载（/agent reload）",
  chipQueued: "排队中",
  chipQueuedTitle: "重新加载已排队，会话空闲后自动执行 — 点击取消排队",
  summaryPre: "",
  summaryMid: " 个会话的插件版本落后于 hub ",
  summarySuffix: "。",
  reloadAll: "全部重新加载",
  view: "查看",
  rowQueued: "排队等待空闲…",
  rowParked: "已送达，等待 {n} 个子 agent 结束…",
  rowSending: "正在重新加载…",
  rowAwaiting: "已送达，等待生效…",
  rowDone: "已重新加载",
  rowFailedPre: "失败：",
  summaryDonePre: "",
  summaryDoneMid: " 个会话已全部重新加载到 ",
  summaryDoneSuffix: "",
} satisfies Messages<typeof en>;
