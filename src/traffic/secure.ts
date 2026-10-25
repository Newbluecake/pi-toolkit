/**
 * 加密会话判定（traffic-merge plan §6）。
 *
 * isSecure() = PI_SECURE_SESSION === "1" ∨ getSecureDomain()?.kind ∈ {secure, locked}。
 * - env 由 toolkit 在 activate 时设置（与加载顺序无关）；domain 判定冻结在
 *   `Symbol.for("pi-subagent:secure-domain")`（`initSecureDomain()` 之后才有值；hub 进程 / 单测为
 *   undefined ⇒ 视为 plain，env 判定照常）。
 * - 每个判定点都现场调用（命令入口、钩子入口、wrapper 入口、persist 闸口、流捕获每批、重放各切点），
 *   不缓存。
 */
import { getSecureDomain } from "../secure/domain.js";

export function isSecure(): boolean {
  if (process.env.PI_SECURE_SESSION === "1") return true;
  return (getSecureDomain()?.kind ?? "plain") !== "plain";
}

/** 旧名（源仓库 v0.2.1 契约）：与 isSecure 同义，保留以免改动迁入测试的断言语义。 */
export function isSecureSession(): boolean {
  return isSecure();
}

export const SECURE_SESSION_MESSAGE = "加密会话（PI_SECURE_SESSION=1）：流量录制已禁用，不会写入 traffic.db。";

export class SecureSessionError extends Error {
  constructor() {
    super(SECURE_SESSION_MESSAGE);
    this.name = "SecureSessionError";
  }
}
