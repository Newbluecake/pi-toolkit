/** P3b internal fabric command over the EXISTING authenticated /api/cmd path.
 * No new HTTP surface/op/cap. Exact key identifies a hub-owned original relation;
 * no text/target/source/status supplied by the browser is accepted as authority.
 */
export const XS_WEB_COMMAND = "__xs";
export interface XsWebAction {
  action: "activate" | "query";
  messageId: string;
  activationKey?: string;
}
export function isXsWebCommand(name: string, args: string): boolean {
  return name === "fabric" && /^__xs(?:\s|$)/.test(args.trim());
}
export function parseXsWebAction(args: string): XsWebAction | undefined {
  if (args.length > 16_384 || !isXsWebCommand("fabric", args)) return undefined;
  try {
    const value: unknown = JSON.parse(args.trim().slice(XS_WEB_COMMAND.length).trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const p = value as Record<string, unknown>;
    if (Object.keys(p).some((k) => !["action", "messageId", "activationKey"].includes(k))) return undefined;
    if (p.action !== "activate" && p.action !== "query") return undefined;
    if (typeof p.messageId !== "string" || p.messageId.length < 1 || p.messageId.length > 64) return undefined;
    if (
      p.activationKey !== undefined &&
      (typeof p.activationKey !== "string" || p.activationKey.length < 1 || p.activationKey.length > 64)
    )
      return undefined;
    if (p.action === "activate" && p.activationKey === undefined) return undefined;
    return {
      action: p.action,
      messageId: p.messageId,
      ...(typeof p.activationKey === "string" ? { activationKey: p.activationKey } : {}),
    };
  } catch {
    return undefined;
  }
}
export function xsWebCommandArgs(action: XsWebAction): string {
  return `${XS_WEB_COMMAND} ${JSON.stringify({
    action: action.action,
    messageId: action.messageId,
    ...(action.activationKey !== undefined ? { activationKey: action.activationKey } : {}),
  })}`;
}
