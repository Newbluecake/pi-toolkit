/**
 * `notices` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/notices.js";

type Messages<T> = { [K in keyof T]: string };

const notices = {
  retryNow: "立即重试",
  signIn: "登录",
  reload: "刷新",
  initialPasswordLead: "请尽快修改初始密码。",
  initialPasswordRun: "请在主机上运行",
  initialPasswordHost: "。",
  initialPasswordMore: "hub 目前仍接受安装时生成的初始密码，任何见过它的人都能登录。修改密码后此提示会自动消失。",
  connectionLostTitle: "连接已断开。",
  connectionLostBody: "{s} 秒后重试 — 当前显示 {t} 时的数据。",
  sessionExpiredTitle: "会话已过期。",
  sessionExpiredBody: "请重新登录以继续查看。",
  authUnknown: "无法确定登录方式 — 此页面可能已过期。",
} satisfies Messages<typeof en>;

export default notices;
