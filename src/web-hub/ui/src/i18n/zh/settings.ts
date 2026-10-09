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
  // D2 (web-hub-session-switch plan §2.2 步骤 6)——「会话缓存」卡片。数字标记两种语言都是
  // 英文 token（AGENTS.md UI 文本分层）；散文部分翻译。
  keepAliveSection: "会话缓存",
  keepAliveHint: "最近访问的会话保持订阅，来回切换无需重新加载；下次切换时生效",
  keepAliveOff: "关闭（每次切换重新加载）",
  keepAlive3: "3 个（默认）",
  keepAlive5: "5 个",
  // 2026-10 明文警告开关——「明文 HTTP 警告」卡片。仅在确实以明文提供的页面（密码模式 + http:，
  // 与各警告组件的判定一致——CONTROL_ENV.plaintext）渲染；https / 回环 token 页面不显示警告，
  // 开关也无从谈起。隐藏只影响警告文案的可见性——传输仍是未加密的（提示语即此意）。
  plainWarnSection: "明文 HTTP 警告",
  plainWarnHint: "隐藏警告不会改变传输方式——本网段流量仍以未加密形式传输、可被他人读取。",
  plainWarnShow: "显示警告（默认）",
  plainWarnHide: "隐藏警告",
  // default-model plan F1 —「新建会话默认模型」卡片（2026-10 改为只选不输：自由输入框换成
  // 切换按钮风格的选取器，「跟随 pi 默认」是列表首行）。`defaultModelPlaceholder` /
  // `defaultModelInvalid` 保留——SpawnModelField（新建会话弹窗的本次模型字段）仍在用。
  // 模型 ref（provider/id）和 chip 内的 not in list 标记两种语言都是英文 token；散文翻译。
  defaultModelSection: "新建会话默认模型",
  defaultModelHint:
    "从此 hub 新建会话（网页选目录/新建入口）时使用的模型。不修改 ~/.pi/agent/settings.json，也不影响已在运行的会话。",
  defaultModelShared: "此值在已登录的所有设备间共享。",
  defaultModelPlaceholder: "provider/id — 留空表示 pi 默认",
  defaultModelFollowPi: "跟随 pi 默认",
  defaultModelFollowPiHint: "新建会话沿用 pi 自身的默认",
  defaultModelListAria: "默认模型选择",
  defaultModelSaving: "保存中…",
  defaultModelSaved: "已保存。",
  defaultModelInvalid: "不是合法的 provider/id — 例如 anthropic/claude-opus-4-5",
  defaultModelUnsupported: "此 hub 版本过旧，不支持默认模型设置 — 升级后请运行 /webhub restart。",
  defaultModelSaveFailed: "保存失败 — hub 拒绝或无法持久化，请重试。",
  defaultModelNoList: "暂无模型列表——有会话在线后才会在这里出现。",
  defaultModelNotInList: "not in list",
  defaultModelNotInListTitle: "不在已知模型列表中——可从列表中另选一个替换。",
} satisfies Messages<typeof en>;

export default settings;
