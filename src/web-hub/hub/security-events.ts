/** LAN security r2 §4.1. Synchronous, isolated fan-out; instance-local, no timers or IO. */
import type { HubLog } from "./ports.js";
import type { LanLoginMethod, TfaOp } from "../protocol/lan-2fa.js";
export type SecurityEvent =
  | { type: "lan-spawn"; ip: string; user?: string; mode: "new" | "resume" | "fork" | "relaunch"; dirTail?: string }
  | { type: "proxy-open"; ip: string; host: string; port: number }
  | { type: "login-success"; ip: string; method: LanLoginMethod; device: string; newIp: boolean }
  | { type: "login-2fa-challenge"; ip: string; device: string; cardSent: boolean }
  | { type: "login-2fa-denied"; ip: string }
  | { type: "login-2fa-burst"; kind: "totp" | "recovery" }
  | { type: "recovery-used"; left: number }
  | { type: "2fa-changed"; op: Exclude<TfaOp, "status" | "totp_begin"> }
  | { type: "passwd" }
  | { type: "login-lockout"; ip: string; failures: number; lockMs: number }
  | { type: "login-tightened" }
  | { type: "login-saturated" }
  | { type: "allowlist-burst"; count: number; ips: readonly string[]; lastIp: string };
export interface SecurityEventBus {
  subscribe(fn: (event: SecurityEvent) => void): () => void;
  emit(event: SecurityEvent): void;
}
export function createSecurityEventBus(log: Pick<HubLog, "error">): SecurityEventBus {
  const subs: Array<(event: SecurityEvent) => void> = [];
  return {
    subscribe(fn) {
      subs.push(fn);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    emit(event) {
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch {
          log.error("web-hub security-events: subscriber threw", { type: event.type });
        }
      }
    },
  };
}
