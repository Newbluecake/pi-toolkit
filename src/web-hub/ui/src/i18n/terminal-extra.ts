import { MESSAGES } from "./index.js";
const en = {
  smallerFont: "Smaller terminal font",
  largerFont: "Larger terminal font",
  unsupported:
    "This agent does not support the terminal protocol, or its backend is not available. No shell was started.",
  backendUnavailable: "Linux PTY, Python 3 or a usable login shell is unavailable on this agent. No shell was started.",
  writerBusy: "Another tab owns this terminal. Put it in the background there, or wait for its lease to expire.",
  quarantined: "Resource cleanup has not been confirmed. New terminals remain blocked; do not retry creating a shell.",
  loginRequired: "Please sign in again to enable terminal access.",
  focusFirst: "Focus the writable terminal before dropping text.",
  title: "Terminal",
  focus: "Focus terminal",
  list: "Terminal list",
  background: "Put in background",
  maximize: "Maximize",
  restore: "Restore",
  terminate: "Terminate",
  attach: "Attach",
  create: "New terminal",
  empty: "No terminals for this login. Refreshing or closing a tab keeps a live shell in the background.",
  warning:
    "Not a sandbox: commands run as the current OS user, without model approval. This is not pi TUI or bash_job.",
  escape: "Ctrl+Shift+F6: leave terminal input focus. Esc does not close or restore the terminal.",
  resize: "Resize terminal panel",
  confirmTitle: "Confirm terminal action",
  confirmKill: "Terminate this shell and interrupt its foreground and background programs?",
  confirmPaste: "Paste multiple lines? These lines may execute commands immediately.",
  cancel: "Cancel",
  confirm: "Confirm",
  pasteTooLarge: "Paste exceeds the 4 KiB input limit.",
  metadataUnavailable: "Metadata unavailable",
  recovery: "Only a bounded output suffix is replayed. Missing output and VT state cannot be recovered exactly.",
};

const zh = {
  smallerFont: "缩小终端字号",
  largerFont: "放大终端字号",
  unsupported: "此 agent 不支持终端协议，或终端后端尚不可用。未启动 shell。",
  backendUnavailable: "目标 agent 的 Linux PTY、Python 3 或可用登录 shell 能力不可用。未启动 shell。",
  writerBusy: "此终端正由另一个标签页使用。请在原标签页放到后台，或等待 writer lease 到期。",
  quarantined: "资源回收尚未确认，暂时禁止新建终端。请勿反复创建 shell。",
  loginRequired: "请重新登录以启用终端。",
  focusFirst: "请先聚焦可写的终端，再拖放文本。",
  title: "终端",
  focus: "聚焦终端",
  list: "终端列表",
  background: "放到后台",
  maximize: "最大化",
  restore: "还原",
  terminate: "终止",
  attach: "接回",
  create: "新建终端",
  empty: "本次登录暂无终端。刷新或关闭标签后，存活的 shell 会保留在后台，可从此列表接回。",
  warning: "非沙盒：以当前 OS 用户执行，不经过模型审批。这不是 pi 原 TUI，也不是 bash_job。",
  escape: "Ctrl+Shift+F6：退出终端输入焦点。Esc 不关闭终端，也不退出最大化。",
  resize: "调整终端面板高度",
  confirmTitle: "确认终端操作",
  confirmKill: "终止此 shell？这会中断其前台和后台程序。",
  confirmPaste: "粘贴多行文本？这些文本可能立即执行命令。",
  cancel: "取消",
  confirm: "确认",
  pasteTooLarge: "粘贴内容超出 4 KiB 输入上限。",
  metadataUnavailable: "元数据不可用",
  recovery: "仅重放有界输出尾流。丢失的输出及 VT 状态无法精确恢复。",
} satisfies Record<keyof typeof en, string>;

export function registerTerminalExtra(): void {
  for (const [lang, extra] of [
    ["en", en],
    ["zh", zh],
  ] as const)
    Object.assign((MESSAGES[lang]["terminal"] ??= {}), extra);
}
