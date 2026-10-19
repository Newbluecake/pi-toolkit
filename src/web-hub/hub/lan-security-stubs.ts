/** P0 compatibility adapter ONLY: the current store must never pretend security ops work.
 * B replaces the spread in lan-store.ts with real child IPC. No current request calls these. */
import type { LanSecurityStorePort } from "./ports.js";
function notImplemented(): never {
  throw new Error("LAN security P0: not implemented");
}
export function unimplementedLanSecurityStore(): LanSecurityStorePort {
  return {
    createSessionChecked: notImplemented,
    listSessions: notImplemented,
    deleteSessionsExcept: notImplemented,
    noteLoginIp: notImplemented,
    isKnownIp: notImplemented,
    knownIpCount: notImplemented,
    get2faState: notImplemented,
    verifyTotp: notImplemented,
    consumeRecovery: notImplemented,
    beginTotp: notImplemented,
    commitTotp: notImplemented,
    setFeishu2fa: notImplemented,
    regenRecovery: notImplemented,
    reset2fa: notImplemented,
    forgetLoginIps: notImplemented,
  };
}
