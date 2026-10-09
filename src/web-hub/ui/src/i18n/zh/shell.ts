/**
 * `shell` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/shell.js";

type Messages<T> = { [K in keyof T]: string };

const shell = {
  skipToConversation: "跳转到对话",
  dashboardHeading: "pi web-hub 仪表盘",
  hubVersion: "hub {v}",
  uiBuild: "ui {v}",
  signOut: "退出",
  /* 2026-10-10: the two-state `langToggle` became the LangMenu dropdown — the label names the
   * CURRENT language ({lang} is its own-script name), the menu aria is short, and the two
   * language names are identical across dictionaries (never translated). */
  langMenuLabel: "语言：{lang}",
  langMenuAria: "语言",
  langZh: "中文",
  langEn: "English",
  "conn.connecting": "连接中…",
  "conn.open": "在线",
  "conn.reconnecting": "重新连接中…",
  "conn.auth": "已注销",
  booting: "加载中…",
  sidebarResize: "调整会话列表宽度",
  sidebarResizeHint: "拖动调整宽度 · 双击恢复默认",
  "theme.system": "跟随系统",
  "theme.light": "浅色",
  "theme.dark": "暗色",
  "fontScale.reset": "重置",
} satisfies Messages<typeof en>;

export default shell;
