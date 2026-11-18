import { TERMINAL_V2_CAP } from "@protocol/terminal-v2-paths.js";

/** Browser hub capability only. Never infer support from an agent/version/status. */
export function terminalUiEnabled(hub: unknown): boolean {
  const caps = (hub as { caps?: unknown } | null | undefined)?.caps;
  return Array.isArray(caps) && caps.includes(TERMINAL_V2_CAP);
}

/** Strict new-UI/old-hub downgrade; the hub-only gate above still owns shared bash icons. */
export function terminalSessionSupported(hub: unknown): boolean {
  const caps = (hub as { caps?: unknown } | null | undefined)?.caps;
  return Array.isArray(caps) && caps.includes(TERMINAL_V2_CAP);
}

/** Optional negative hint only; legacy absence is not proof of readiness. */
export function terminalUnavailableReason(hub: unknown): string | undefined {
  if (!terminalSessionSupported(hub)) return undefined;
  const status = (hub as { terminal?: { state?: unknown; reason?: unknown } } | null)?.terminal;
  if (status?.state !== "unavailable") return undefined;
  return typeof status.reason === "string" && /^[a-z0-9-]{1,80}$/.test(status.reason) ? status.reason : "unavailable";
}

/** Positive declaration only, never authority. Keep the closed protocol parser/schema lazy:
 * an off/legacy hub must not eagerly load the terminal schema closure (or xterm/CSS).
 * Callers must invalidate pending validation on every observable scope/eligibility boundary. */
export async function terminalSessionUiEnabled(
  hub: unknown,
  agent: {
    session?: unknown;
    card?: unknown;
    status?: unknown;
  },
): Promise<boolean> {
  if (!terminalSessionSupported(hub) || terminalUnavailableReason(hub) !== undefined) return false;
  const sessionId = (agent.session as { sessionId?: unknown } | undefined)?.sessionId;
  const epoch = (agent.card as { epoch?: unknown } | undefined)?.epoch;
  const declaration = (agent.status as { terminalSessionV2?: unknown } | undefined)?.terminalSessionV2;
  if (typeof sessionId !== "string" || typeof epoch !== "string" || !declaration) return false;
  try {
    const { parseTerminalSessionV2 } = await import("@protocol/terminal-v2.js");
    return parseTerminalSessionV2(declaration, { sessionId, epoch }) !== undefined;
  } catch {
    return false;
  }
}
