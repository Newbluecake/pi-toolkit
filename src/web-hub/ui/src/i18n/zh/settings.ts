/**
 * `settings` i18n namespace, Chinese (user-decided 2026-10). Deliver mode names stay English
 * tokens (AGENTS.md UI-text split); prose blocks are translated.
 */
import en from "../en/settings.js";

type Messages<T> = { [K in keyof T]: string };

const settings = {
  title: "设置",
  close: "关闭",
  themeSection: "主题",
  fontSection: "字号",
  deliverSection: "默认投递方式",
  deliverHint: "agent 忙碌时新消息的投递方式。输入框中按 Alt+Enter 仍可临时改为 Follow-up。",
  deliverSteer: "Steer",
  deliverFollowUp: "Follow-up",
  deliverSteerHint: "插话当前轮",
  deliverFollowUpHint: "排队等本轮结束",
  // default-model plan F1 —「新建会话默认模型」卡片。
  defaultModelSection: "新建会话默认模型",
  defaultModelHint:
    "从此 hub 新建会话（网页选目录/新建入口）时使用的模型。不修改 ~/.pi/agent/settings.json，也不影响已在运行的会话。",
  defaultModelShared: "此值在已登录的所有设备间共享。",
  defaultModelPlaceholder: "provider/id — 留空表示 pi 默认",
  defaultModelUsePi: "使用 pi 默认",
  defaultModelSave: "保存",
  defaultModelSaving: "保存中…",
  defaultModelSaved: "已保存。",
  defaultModelInvalid: "不是合法的 provider/id — 例如 anthropic/claude-opus-4-5",
  defaultModelUnsupported: "此 hub 版本过旧，不支持默认模型设置 — 升级后请运行 /webhub restart。",
  defaultModelSaveFailed: "保存失败 — hub 拒绝或无法持久化，请重试。",
  defaultModelNoList: "没有在线会话可提供模型列表 — 仍可手动输入 provider/id。",
  defaultModelNotInList: "不在已知模型列表中 — 保存前请确认拼写。",
} satisfies Messages<typeof en>;

export default settings;
