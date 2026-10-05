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
  signOut: "退出登录",
  "conn.connecting": "连接中…",
  "conn.open": "在线",
  "conn.reconnecting": "重新连接中…",
  "conn.auth": "已注销",
  "theme.system": "跟随系统",
  "theme.light": "浅色",
  "theme.dark": "暗色",
  "theme.groupLabel": "主题",
  "fontScale.label": "字号",
  "fontScale.aria": "字号 {pct}%，点击切换到 {next}%",
} satisfies Messages<typeof en>;

export default shell;
