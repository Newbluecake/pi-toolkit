/**
 * `settings` i18n namespace, Chinese (user-decided 2026-10). Deliver mode names stay English
 * tokens (AGENTS.md UI-text split); prose blocks are translated.
 */
import en from "../en/settings.js";

type Messages<T> = { [K in keyof T]: string };

const settings = {
  title: "设置",
  back: "返回",
  themeSection: "主题",
  fontSection: "字号",
  deliverSection: "默认投递方式",
  deliverHint: "agent 忙碌时新消息的投递方式。输入框中按 Alt+Enter 仍可临时改为 Follow-up。",
  deliverSteer: "Steer",
  deliverFollowUp: "Follow-up",
  deliverSteerHint: "插话当前轮",
  deliverFollowUpHint: "排队等本轮结束",
} satisfies Messages<typeof en>;

export default settings;
