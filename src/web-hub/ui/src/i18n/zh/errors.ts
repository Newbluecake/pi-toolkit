/**
 * `errors` i18n namespace, Chinese (vue-plan.md v2.1 §3.8, §5.2 — P1). `satisfies Messages<typeof
 * en>` against the English namespace makes a missing/extra key a `vue-tsc` compile error at
 * authoring time (`i18n-parity.test.ts` also checks it at runtime, including `{param}` sets).
 */
import en from "../en/errors.js";

type Messages<T> = { [K in keyof T]: string };

const errors = {
  invalid: "用户名或密码错误。",
  notAllowed: '此地址不在 hub 的允许列表中，请使用 "/webhub open" 显示的地址之一。',
  saturated: '新地址登录已被临时阻止，请让主机运行 "/webhub unlock"。',
  busyExhausted: "hub 数据库不可用 — 请重试",
  network: "无法连接到 hub。",
  unknown: "登录失败。",
  throttled: "尝试次数过多，请在 {s} 秒后重试。",
  retryingRate: "请求过多，正在重试…",
  retryingBusy: "hub 繁忙，正在重试…",
  revoked: "已在其他标签页或被主机注销登录。",
  expired: "会话已过期，请重新登录。",
  tokenInvalid: "登录链接已失效。",
  authModeUnknown: "无法确定登录方式（页面已过期？）。请刷新。",
} satisfies Messages<typeof en>;

export default errors;
