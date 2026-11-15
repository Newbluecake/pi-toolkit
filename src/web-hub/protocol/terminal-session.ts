/** Per-session positive declaration, not execution authority. Consumers must still verify the
 * live link/session/epoch and the private authority chain. Keep ordinary status decoding open. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TerminalConfigSchema, TerminalIdSchema } from "./terminal.js";

export const TERMINAL_SESSION_MAX_BYTES = 1024;
export const TerminalSessionSchema = Type.Object(
  {
    v: Type.Literal(1),
    enabled: Type.Literal(true),
    sessionId: TerminalIdSchema,
    epoch: TerminalIdSchema,
    limits: TerminalConfigSchema,
  },
  { additionalProperties: false },
);
export type TerminalSession = Static<typeof TerminalSessionSchema>;

/** Missing, malformed, oversized or stale declarations are all ineligible. No denial details,
 * paths, cwd, capability or private proof may be added to this closed public projection. */
export function parseTerminalSession(
  input: unknown,
  expected?: Readonly<{ sessionId: string; epoch: string }>,
): TerminalSession | undefined {
  try {
    const json = JSON.stringify(input);
    if (json === undefined || new TextEncoder().encode(json).byteLength > TERMINAL_SESSION_MAX_BYTES) return undefined;
    if (!Value.Check(TerminalSessionSchema, input)) return undefined;
    if (expected && (input.sessionId !== expected.sessionId || input.epoch !== expected.epoch)) return undefined;
    return input;
  } catch {
    return undefined;
  }
}
