/**
 * `hub` i18n namespace, Chinese (control-plan.md v2.1 §6.6/§6.7, §7.7 — C5).
 */
import en from "../en/hub.js";

type Messages<T> = { [K in keyof T]: string };

const hub = {
  bannerAria: "Hub 状态",
  stopped: "hub 已由终端停止——在终端运行 /webhub start 恢复。",
  restarting: "hub 正在升级到 v{v}…",
  forcedUpgrade: "等待超过 30 分钟，已强制升级。",
  draining: "正在排空在途请求。",
  supersedePending: "hub 将在空闲时升级到 v{v}（最晚 {time}）。",
  supersedeBlocked: "升级到 v{v} 已暂停：存在 hub 停止标记。",
  supersedeBlockedHint: "/webhub start 清除标记后立即继续。",
  supersedeDetail: "有更新版本的 pi-toolkit 已连接；所有 agent 空闲后 hub 会自动替换升级——你正在进行的操作不会被打断。",
  expand: "详情",
  collapse: "收起详情",
} satisfies Messages<typeof en>;

export default hub;
