import { Value } from "@sinclair/typebox/value";
import { readUntrustedValue } from "../scopes/limits.js";
import type { TSchema } from "@sinclair/typebox";
import type { MemoryV4Params } from "./types.js";

export interface V4Registration {
  active: boolean;
  registered: boolean;
}
/** Called only AFTER the old executor; never moves validation ahead of the legacy checks. */
export function appendV4Replacement(
  result: unknown,
  input: unknown,
  parameters: TSchema,
  registration?: V4Registration,
): unknown {
  if (!registration?.active || !registration.registered) return result;
  const parsed = readUntrustedValue(input);
  if (!parsed.ok || !Value.Check(parameters, parsed.value)) return result;
  const { op, storageScope, ...fields } = parsed.value as Record<string, unknown>;
  if (!result || typeof result !== "object") return result;
  // Old view accepts several fields it subsequently ignores (notably session
  // topic). Do not carry those into a stricter v4 success replacement.
  const params = (op === "view" && "ok" in result && result.ok === true
    ? { command: op, scope: storageScope, ...(fields.id !== undefined ? { id: fields.id } : {}) }
    : { command: op, scope: storageScope, ...fields }) as unknown as MemoryV4Params;
  return { ...result, deprecation: { replacement: { tool: "memory", params } } };
}
