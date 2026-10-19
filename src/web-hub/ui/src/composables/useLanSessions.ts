/** P0 D contract. Not imported by SettingsView until I wires the LAN-only cap gate. */
import type { Ref } from "vue";
import type { LanSessionsResponse, LanSessionRevokeBody, LanSessionRevokeResponse } from "@protocol/lan-sessions.js";
export interface LanSessionsDeps {
  enabled(): boolean;
  list(signal: AbortSignal): Promise<LanSessionsResponse>;
  revoke(body: LanSessionRevokeBody, signal: AbortSignal): Promise<LanSessionRevokeResponse>;
}
export interface LanSessionsHandle {
  readonly phase: Readonly<Ref<"unsupported" | "idle" | "loading" | "ok" | "error">>;
  readonly snapshot: Readonly<Ref<LanSessionsResponse | undefined>>;
  readonly lastRevoke: Readonly<Ref<LanSessionRevokeResponse | undefined>>;
  refresh(): Promise<void>;
  revoke(body: LanSessionRevokeBody): Promise<void>;
  dispose(): void;
}
export function useLanSessions(_deps: LanSessionsDeps): LanSessionsHandle {
  throw new Error("LAN security P0: sessions UI not implemented");
}
