/** Browser hub capability only. Never infer support from an agent/version/status. */
export function terminalUiEnabled(hub: unknown): boolean {
  const caps = (hub as { caps?: unknown } | null | undefined)?.caps;
  return Array.isArray(caps) && caps.includes("terminal.ui.v1");
}
