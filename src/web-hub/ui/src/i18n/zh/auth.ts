/**
 * `auth` i18n namespace, Chinese (control-plan.md v2.1 §6.7.1 — C5).
 */
import en from "../en/auth.js";

type Messages<T> = { [K in keyof T]: string };

const auth = {
  tokenRotated: "token 已轮换——请在终端运行 /webhub open 获取新链接。",
} satisfies Messages<typeof en>;

export default auth;
