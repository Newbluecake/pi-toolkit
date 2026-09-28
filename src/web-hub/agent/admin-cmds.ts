export interface AdminCommands {
  stop(): Promise<{ ok: false; code: "E_UNSUPPORTED" }>;
  start(): Promise<{ ok: false; code: "E_UNSUPPORTED" }>;
  rotateToken(): Promise<{ ok: false; code: "E_UNSUPPORTED" }>;
}
export function createAdminCommands(): AdminCommands {
  const unsupported = async () => ({ ok: false as const, code: "E_UNSUPPORTED" as const });
  return { stop: unsupported, start: unsupported, rotateToken: unsupported };
}
