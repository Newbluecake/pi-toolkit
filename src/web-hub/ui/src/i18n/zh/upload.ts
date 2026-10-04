/**
 * `upload` i18n namespace, Chinese (web-hub-upload plan §4.1–§4.3, package U5). Compact inline
 * markers (state chips) deliberately stay English tokens (AGENTS.md UI-text split); prose
 * blocks are translated.
 */
import en from "../en/upload.js";

type Messages<T> = { [K in keyof T]: string };

const upload = {
  // --- 托盘 ---
  trayAria: "附件",
  stateQueued: "queued",
  stateUploading: "uploading",
  stateReady: "ready",
  stateFailed: "failed",
  stateRemoving: "removing",
  itemAria: "{name}，{size}，{state}",
  progressAria: "{name} 上传进度",
  removeAria: "移除 {name}",
  retry: "重试",
  retryAria: "重新上传 {name}",
  announceReady: "{name} 已添加为附件",
  announceFailed: "{name} 上传失败",

  // --- 入口（粘贴 / 拖入 / 附件按钮） ---
  attachAria: "添加附件",
  dropHint: "松开以添加附件",
  hintTooLarge: "{name} 超过单文件 100 MiB 上限",
  hintTooMany: "每条消息最多 {n} 个附件",
  hintDuplicate: "{name} 已在附件列表中",
  hintInvalid: "{name} 无法作为附件",
  hintDirectory: "不能附加文件夹（{names}）",

  // --- 发送闸门提示（§3.2——与托盘相关的拦截原因） ---
  gateUploading: "附件仍在上传中——等它们完成后再发送",
  gateFailed: "有附件上传失败——请先重试或移除",
  gateCommand: "附件只能随普通消息发送：移除附件，或用 // 开头按文本发送",
  gateTooLarge: "正文与附件块合计超过 48 KiB 上限",
  gateBlocked: "当前状态下附件无法发送",

  // --- 明文警告（§4.2——托盘非空时常驻，不可关闭） ---
  plaintextWarning: "明文 HTTP：附件内容在局域网内未加密传输，可被同网段窃听或篡改。",

  // --- upload.err.*（§4.2 错误映射；Attachment.error 的错误码索引到这里） ---
  errTooLarge: "文件超过 hub 的大小上限",
  errQuota: "上传配额已满——清理空间或等待旧上传过期",
  errDisabled: "此 hub 已禁用上传",
  errConflict: "上传冲突——请重试",
  errGone: "附件已被清理，请重新上传",
  errAgentGone: "上传期间 agent 断开——请重试",
  errBusy: "hub 正在整理临时空间——请稍后重试",
  errRestarted: "hub 已重启——请重新上传",
  errNetwork: "网络错误——请重试",
  errTimeout: "上传超时——请重试",
  errAuth: "登录已过期——重新登录后再试",
  errRate: "上传请求过多——请稍后重试",
  errUnknown: "上传失败（{code}）",
} satisfies Messages<typeof en>;

export default upload;
