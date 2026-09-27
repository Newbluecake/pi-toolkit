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
} satisfies Messages<typeof en>;

export default login;
