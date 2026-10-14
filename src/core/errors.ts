import type { ErrorInfo, ErrorKind } from "./types.js";

/** All ErrorKind union members (runtime mirror of the union in core/types.ts). */
const ERROR_KINDS: readonly string[] = [
  "config",
  "auth",
  "startup_transient",
  "model",
  "timeout",
  "aborted",
  "internal",
  "schema",
];

/**
 * 外部 agent（external-agent plan §2.3，冻结面）：携带 ErrorInfo 的 Error。
 * 外部驱动在 create()/resume()/prompt() reject 时用它把 kind/retryable 带给 runner
 * （runner 的 startError / prompt 结算经 classifiedInfo 解包）。
 */
export class ClassifiedError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = "ClassifiedError";
    this.info = info;
  }
}

/**
 * 解包 ClassifiedError 的 ErrorInfo：instanceof 优先，另加结构守卫
 * （name==="ClassifiedError" 且 info.kind/message/retryable 形状合法），跨 realm 安全。
 * 非 ClassifiedError ⇒ undefined。
 */
export function classifiedInfo(e: unknown): ErrorInfo | undefined {
  if (e instanceof ClassifiedError) return e.info;
  if (e === null || e === undefined || typeof e !== "object") return undefined;
  const r = e as { name?: unknown; info?: unknown };
  if (r.name !== "ClassifiedError") return undefined;
  const info = r.info;
  if (info === null || typeof info !== "object") return undefined;
  const i = info as { kind?: unknown; message?: unknown; stack?: unknown; retryable?: unknown };
  if (
    typeof i.kind !== "string" ||
    !ERROR_KINDS.includes(i.kind) ||
    typeof i.message !== "string" ||
    typeof i.retryable !== "boolean" ||
    (i.stack !== undefined && typeof i.stack !== "string")
  )
    return undefined;
  const out: ErrorInfo = { kind: i.kind as ErrorKind, message: i.message, retryable: i.retryable };
  if (typeof i.stack === "string") out.stack = i.stack;
  return out;
}

/**
 * Classify an unknown caught value into an ErrorInfo. Used by withDeadline
 * (N6-2) to turn a rejected Promise into a diagnosable, typed error instead
 * of silently mislabeling it as a timeout.
 */
export function toErrorInfo(error: unknown, fallback: ErrorKind = "internal"): ErrorInfo {
  const e = error instanceof Error ? error : new Error(String(error));
  return e.stack === undefined
    ? { kind: fallback, message: e.message, retryable: fallback === "startup_transient" }
    : { kind: fallback, message: e.message, stack: e.stack, retryable: fallback === "startup_transient" };
}
