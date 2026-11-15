/** Read-only machine settings parser. Valid/default/key precedence mirrors normalizeTimeUnits
 * + parseWebHubTerminalBlock; invalid enabled limits intentionally reject the WHOLE block rather
 * than falling back to a potentially larger default. No config/secure runtime imports (I8).
 * This does not read files, establish startup provenance, or authorize a target session. */
import { TERMINAL_LIMITS, type TerminalHubConfig } from "./terminal.js";

export type TerminalPolicyReason = "settings-invalid" | "policy-invalid";
export type TerminalMachinePolicy =
  | { state: "off" }
  | { state: "enabled"; policy: TerminalHubConfig }
  | { state: "unavailable"; reason: TerminalPolicyReason };

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
function integer(input: unknown, min: number, max: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= min && input <= max;
}

/** Input is the parsed whole settings file (not an already normalized agent block).
 * A truly missing file is handled by the reader as off, not passed here as undefined.
 * S wins over Ms even when invalid; ignored legacy values and unknown keys are not forwarded. */
export function parseTerminalPolicy(settings: unknown): TerminalMachinePolicy {
  const root = record(settings);
  if (!root) return { state: "unavailable", reason: "settings-invalid" };
  if (root.webHub === undefined) return { state: "off" };
  const hub = record(root.webHub);
  if (!hub) return { state: "unavailable", reason: "policy-invalid" };
  if (hub.terminal === undefined) return { state: "off" };
  const block = record(hub.terminal);
  if (!block || (block.enabled !== undefined && typeof block.enabled !== "boolean"))
    return { state: "unavailable", reason: "policy-invalid" };
  // Sparse off semantics: limits have no meaning and cannot create a diagnostic when disabled.
  if (block.enabled !== true) return { state: "off" };
  const policy: TerminalHubConfig = {
    maxPerSession: TERMINAL_LIMITS.maxPerSession,
    maxPerPrincipal: TERMINAL_LIMITS.maxPerPrincipal,
    maxTotal: TERMINAL_LIMITS.maxTotal,
    inputIdleMs: TERMINAL_LIMITS.inputIdleMs,
    maxLifetimeMs: TERMINAL_LIMITS.maxLifetimeMs,
  };
  for (const [key, max] of [
    ["maxPerSession", 4],
    ["maxPerPrincipal", 8],
    ["maxTotal", 32],
  ] as const) {
    if (!Object.hasOwn(block, key)) continue;
    const value = block[key];
    if (!integer(value, 1, max)) return { state: "unavailable", reason: "policy-invalid" };
    policy[key] = value;
  }
  for (const [secondsKey, msKey, minSeconds] of [
    ["inputIdleS", "inputIdleMs", 300],
    ["maxLifetimeS", "maxLifetimeMs", 900],
  ] as const) {
    if (Object.hasOwn(block, secondsKey)) {
      const seconds = block[secondsKey];
      if (!integer(seconds, minSeconds, 86_400)) return { state: "unavailable", reason: "policy-invalid" };
      policy[msKey] = seconds * 1000;
    } else if (Object.hasOwn(block, msKey)) {
      const ms = block[msKey];
      if (!integer(ms, minSeconds * 1000, 86_400_000) || ms % 1000 !== 0)
        return { state: "unavailable", reason: "policy-invalid" };
      policy[msKey] = ms;
    }
  }
  return { state: "enabled", policy };
}
