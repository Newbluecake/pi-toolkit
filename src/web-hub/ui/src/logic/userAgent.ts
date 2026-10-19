/** P0 D pure display helper. Never use a device label as an authentication binding. */
export function userAgentLabel(_ua: string | undefined): string {
  throw new Error("LAN security P0: user-agent label not implemented");
}
