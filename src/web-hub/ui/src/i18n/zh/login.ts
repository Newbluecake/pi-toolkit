/**
 * `login` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P3).
 */
import en from "../en/login.js";

type Messages<T> = { [K in keyof T]: string };

const login = {
  subtitle: "登录以实时查看你的 pi 会话与子代理。",
  plaintextLead: "纯 HTTP。",
  plaintextBody: "你的密码将以未加密方式传输。",
  plaintextMore:
    "此页面通过纯 HTTP 提供，你的密码和会话 cookie 会在此网络上以未加密方式传输。请只在受信任的网络上登录，或将 hub 部署在 HTTPS 反向代理之后。",
  usernameLabel: "用户名",
  passwordLabel: "密码",
  showPassword: "显示密码",
  hidePassword: "隐藏密码",
  submit: "登录",
  tokenInvalidTitle: "此链接已失效",
  tokenInvalidLead: "请在主机上运行",
  tokenInvalidTail: "，然后打开它输出的新链接。",
  "2fa.heading": "二次验证",
  "2fa.headingTotp": "输入验证码",
  "2fa.headingFeishu": "等待飞书审批",
  "2fa.headingRecovery": "使用恢复码",
  "2fa.lead": "本次登录来自新地址，需要完成二次验证。验证在 {min} 分钟内有效。",
  "2fa.totpLabel": "验证器 App 中的 6 位验证码",
  "2fa.totpHint": "验证码每 30 秒刷新，允许多次尝试。",
  "2fa.recoveryLabel": "12 位恢复码",
  "2fa.recoveryHint": "每枚恢复码仅可使用一次。",
  "2fa.submit": "验证并登录",
  "2fa.verifying": "验证中…",
  "2fa.altTitle": "其他方式",
  "2fa.useTotp": "改用验证器 App",
  "2fa.useFeishu": "改用飞书审批",
  "2fa.useRecovery": "使用恢复码",
  "2fa.cancel": "取消登录",
  "2fa.backToLogin": "返回登录",
  "2fa.waitLead": "已向飞书发送审批请求，请在飞书中确认",
  "2fa.waitCountdown": "审批剩余 {s} 秒",
  "2fa.waitExpired": "审批已超时，仍可使用其他方式验证",
  "2fa.errorTotp": "验证码不正确，请重试（本次登录还可尝试 {n} 次）",
  "2fa.errorRecovery": "恢复码不正确或已使用，请重试（本次登录还可尝试 {n} 次）",
  "2fa.invalidTotp": "请输入 6 位数字验证码。",
  "2fa.invalidRecovery": "恢复码为 12 位字符（可含空格或连字符）。",
  "2fa.methodLocked": "该方式尝试次数已达上限，请 {s} 秒后再试，或使用其他方式。",
  "2fa.attemptsExhausted": "本次登录的尝试次数已用完，请重新登录。",
  "2fa.noMethod": "本次登录没有可用的验证方式，请返回重新登录。",
  "2fa.expired": "验证已过期（超过 {min} 分钟），请重新登录。",
  "2fa.denied": "本次登录已在飞书中被拒绝。",
  "2fa.failed": "验证失败，请重试或重新登录。",
} satisfies Messages<typeof en>;

export default login;
