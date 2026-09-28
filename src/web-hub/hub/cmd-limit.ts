export interface CmdLimit {
  admit(bucket?: string): { ok: true } | { ok: false; retryAfterMs: number };
}
export function createCmdLimit(): CmdLimit {
  return { admit: () => ({ ok: true }) };
}
