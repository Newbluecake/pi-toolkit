/**
 * `spawn` i18n namespace, Chinese (web-hub-spawn plan SP12 / arch §9.1). 行内标记（state chips、
 * `web` 徽标、`fp:*` token）保持英文；提示性长文本译为中文（AGENTS.md 的 UI 文案分流规则）。
 */
import en from "../en/spawn.js";

type Messages<T> = { [K in keyof T]: string };

const spawn = {
  menuAria: "新建会话选项",
  menuToggleAria: "更多新建会话方式",
  itemSameCwd: "在 {cwd} 新建（/new）",
  itemSameCwdNoCwd: "为当前选中的 agent 新建会话（/new）",
  itemPickDir: "选择目录新建…",

  deniedPlatform: "此 hub 的平台不支持该功能",
  deniedLauncher: "hub 上的 launcher 校验失败",
  deniedPersist: "hub 上持久化不可用",
  deniedReaper: "hub 上 reaper 不可用",
  deniedCooldown: "失败后冷却中 — 稍后重试",
  deniedBreaker: "多次失败后暂时停用",
  deniedUnknown: "此 hub 上不可用",

  pickerAria: "在目录中启动会话",
  pickerTitle: "选择目录新建会话",
  pickerCwdLabel: "目录",
  pickerCwdPlaceholder: "/path/to/project 或 ~",
  pickerRecentLabel: "最近目录",
  pickerRecentPartial: "部分目录未能列出。",
  pickerRecentError: "最近目录加载失败。",
  pickerPromptLabel: "首条消息（可选）",
  pickerPromptPlaceholder: "会话上线后自动发送",
  pickerPromptTooLong: "首条消息为 {n} 字节 — 超出 48 KiB 上限",
  pickerSubmit: "启动",
  pickerSubmitting: "正在启动…",
  pickerAwaiting: "正在等待会话上线…",
  pickerUnknown: "状态未知 — 仍在监听；下次同步后会确定结果。",
  pickerDone: "会话已上线。",
  pickerRetry: "重试",
  pickerCancel: "取消",
  pickerClose: "关闭",
  fpPending: "fp: pending",
  fpSending: "fp: sending",
  fpDelivered: "fp: delivered",

  errDir: "目录被拒绝 — 请选择最近目录或允许的目录",
  errDenied: "此 hub 当前不允许新建会话",
  errLimit: "进程数已达上限 — 请停止一个会话或等待其退出",
  errRate: "请求过于频繁 — 稍后重试",
  errLauncher: "hub 暂时无法启动 pi — 稍后重试",
  errDeadline: "hub 未及时应答 — 请确认会话是否已上线",
  errNetwork: "网络错误 — 请重试",
  errSpawn: "会话启动失败",
  errFirstPrompt: "首条消息未能送达",
  errUnsupported: "此 hub 不提供网页新建会话",
  errRetryAfter: "请在 {n} 秒后重试",

  confirmTitle: "确认真实目录",
  confirmBody: "hub 将你输入的目录解析为以下真实路径，将在其中启动新的 pi 会话。",
  confirmReasonUnknownDir: "该目录不在已知目录列表中。",
  confirmReasonLan: "通过 LAN 启动会话需要逐一确认。",
  confirmPlaintext: "明文 HTTP：此确认及会话流量将以未加密的方式经过网络。",
  confirmRun: "在此目录启动",

  pendingAria: "进行中的网页会话",
  stateStarting: "starting",
  stateFailed: "failed",
  rowDetails: "详情",
  rowDetailsAria: "查看 {cwd} 的失败详情",
  rowRetry: "重试",
  rowRetryAria: "在 {cwd} 重新启动会话",
  rowDismiss: "关闭",
  rowDismissAria: "关闭此行",
  rowOwnerOnly: "仅会话的创建者可见详情。",
  rowStderrTail: "stderr 尾部",
  rowDetailError: "详情加载失败 — 请重试",

  hintRegisterTimeoutHello: "会话一直未注册 — pi 是否通过 pi install 安装了本扩展？",
  hintRegisterTimeoutSession: "进程已注册，但一直未开启会话",
  hintControlOff: "该会话未启用控制面",
  hintNewerPlugin: "pi 版本高于此 hub 支持的范围",
  hintCwdMismatch: "进程启动在了不同的目录 — 已被停止",
  hintProtocolError: "进程输出了非预期协议 — 已被停止",
  hintLauncherChanged: "pi 启动器在磁盘上发生变化 — 请运行 /webhub restart",

  badgeWeb: "web",
  badgeWebTitle: "由网页启动 — 受此 hub 管理",

  stopSession: "停止会话",
  stopSessionConfirm: "再次点击确认停止",
  stopSessionAria: "停止这个由网页启动的会话",
  stopSessionStopping: "stopping…",
  stopSessionFailed: "停止失败（{code}）",
  fpRefilled: "首条消息未能送达（{state}）— 正文已放回草稿。",
  fpRefilledDismiss: "关闭",
} satisfies Messages<typeof en>;

export default spawn;
