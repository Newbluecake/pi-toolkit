import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function currentSessionId(ctx: ExtensionContext): string {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}
