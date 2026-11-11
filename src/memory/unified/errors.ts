import { MemoryError } from "../paths.js";
import type { ProjectMemoryErrorCode, UnifiedError } from "./types.js";

/** Only the declared project codes survive. Never use Hub's persistence mapper here. */
export const PROJECT_ERROR_MESSAGES = {
  E_META_INVALID: "invalid project memory inline metadata",
  E_NOT_FOUND: "project memory target not found",
  E_REV_REQUIRED: "project memory update requires rev",
  E_CONFLICT: "project memory revision conflict",
  E_TOO_LARGE: "project memory body exceeds the byte limit",
  E_WRITE_GATE: "project memory write refused",
  E_READONLY: "project memory is read-only",
  E_BAD_PATH: "invalid project memory path",
  E_BAD_TOPIC: "invalid project memory topic",
  E_UNMIGRATED: "project memory requires migration",
  E_UNSUPPORTED_COMMAND: "unsupported project memory command",
} as const satisfies Record<ProjectMemoryErrorCode, string>;

export function projectError(error: unknown): UnifiedError {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const originalCode =
    error instanceof MemoryError ? (error.code ?? /^(E_[A-Z0-9_]+)(?=:|$|\s)/.exec(originalMessage)?.[1]) : undefined;
  if (originalCode && Object.hasOwn(PROJECT_ERROR_MESSAGES, originalCode)) {
    return {
      code: originalCode as ProjectMemoryErrorCode,
      message: PROJECT_ERROR_MESSAGES[originalCode as keyof typeof PROJECT_ERROR_MESSAGES],
      originalCode,
      originalMessage,
    };
  }
  return {
    code: "E_INTERNAL",
    message: "project memory operation failed",
    ...(originalCode ? { originalCode } : {}),
    originalMessage,
  };
}
export function scopedReadError(scope: "session" | "hub", error: unknown): UnifiedError {
  return {
    code: "E_INTERNAL",
    message: `${scope} memory read failed`,
    originalMessage: error instanceof Error ? error.message : String(error),
  };
}
