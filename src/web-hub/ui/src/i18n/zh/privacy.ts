/**
 * `privacy` i18n namespace, Chinese (web-hub-privacy plan v2.1, package P2). 「隐私标记」（持久，
 * `mark*`/`unmark*`）与「立即锁定」（视图回锁，`lockNow`）两套词汇严格分离；紧凑标记
 * （徽标、单位）保持英文 token，散文块翻译（AGENTS.md UI-text split）。
 */
import en from "../en/privacy.js";

type Messages<T> = { [K in keyof T]: string };

const privacy = {
  badgeMarked: "Private",
  mark: "隐私标记",
  markAria: "将此会话标记为隐私会话",
  lockNow: "立即锁定",
  lockNowAria: "立即回锁此会话的视图",
  markLabel: "隐私",
  lockLabel: "锁定",
  screenTitle: "此会话已设为隐私",
  screenBody:
    "解锁查看前，其会话内容与各面板保持隐藏。解锁仅对本次查看有效：切走、长时间无操作或标签页隐藏时都会立即回锁。",
  passwordLabel: "LAN 密码",
  unlockSubmit: "解锁查看",
  confirmView: "点击确认查看",
  loopbackHint: "此 hub 使用链接令牌访问，没有第二凭证可校验——查看只是点击确认，并非真正的密码验证。",
  actionFailed: "隐私操作失败（{code}）",
  sessionChanged: "会话刚刚发生了变化，请重试。",
  unmarkTitle: "取消隐私标记",
  unmarkBodyLan: "输入 LAN 密码以取消此会话的隐私标记。密码仅用于本次请求，不会被存储。",
  unmarkBodyLoopback: "确定取消此会话的隐私标记？此 hub 没有第二凭证，取消仅需确认。",
  unmarkConfirm: "取消标记",
  unmarkCancel: "返回",
  timeoutSection: "隐私锁",
  timeoutHint:
    "已解锁的隐私会话在无键盘、指针、触摸或滚动操作达到此时长后自动回锁——仅在你正在查看它时计时。切换会话或隐藏标签页总是立即回锁。仅桌面端生效，手机布局不加锁。",
  timeoutLabel: "无操作回锁（分钟）",
  timeoutUnit: "min",
} satisfies Messages<typeof en>;

export default privacy;
