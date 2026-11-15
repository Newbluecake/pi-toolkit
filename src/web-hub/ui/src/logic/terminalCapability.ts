import { TERMINAL_SESSION_CAP } from "@protocol/version.js";

/** Browser hub capability only. Never infer support from an agent/version/status. */
export function terminalUiEnabled(hub: unknown): boolean {
  const caps = (hub as { caps?: unknown } | null | undefined)?.caps;
  return Array.isArray(caps) && caps.includes("terminal.ui.v1");
}

/** Strict new-UI/old-hub downgrade; the hub-only gate above still owns shared bash icons. */
export function terminalSessionSupported(hub: unknown): boolean {
  const caps = (hub as { caps?: unknown } | null | undefined)?.caps;
  return terminalUiEnabled(hub) && Array.isArray(caps) && caps.includes(TERMINAL_SESSION_CAP);
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
  if (!terminalSessionSupported(hub)) return false;
  const sessionId = (agent.session as { sessionId?: unknown } | undefined)?.sessionId;
  const epoch = (agent.card as { epoch?: unknown } | undefined)?.epoch;
  const declaration = (agent.status as { terminalSession?: unknown } | undefined)?.terminalSession;
  if (typeof sessionId !== "string" || typeof epoch !== "string" || !declaration) return false;
  try {
    const { parseTerminalSession } = await import("@protocol/terminal-session.js");
    return parseTerminalSession(declaration, { sessionId, epoch }) !== undefined;
  } catch {
    return false;
  }
}
