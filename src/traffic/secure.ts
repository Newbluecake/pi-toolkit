/**
 * pi-secure 契约（pi-toolkit data-encryption plan §2.6）：
 * 进程环境 PI_SECURE_SESSION === "1" ⇒ 加密会话，不得持久化任何 request/message/response 正文，
 * 也不得打开 traffic.db。该变量由 toolkit 在 activate 时设置，与加载顺序无关，
 * 因此每次捕获/入队/落库前都必须现场读取，而不是只在 activate 时判断一次。
 */
export function isSecureSession(): boolean {
  return process.env.PI_SECURE_SESSION === "1";
}

export const SECURE_SESSION_MESSAGE = "加密会话（PI_SECURE_SESSION=1）：流量录制已禁用，不会写入 traffic.db。";

export class SecureSessionError extends Error {
  constructor() {
    super(SECURE_SESSION_MESSAGE);
    this.name = "SecureSessionError";
  }
}
