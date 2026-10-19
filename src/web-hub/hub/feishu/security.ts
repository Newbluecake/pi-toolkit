/** P0 E factories. Unwired; all work/timers belong to the bot runtime, never module scope. */
import type { LoginApprovalPort, LoginApprovalCloseReason } from "../ports.js";
import type { SecurityEvent, SecurityEventBus } from "../security-events.js";
import type { FeishuClock } from "./http.js";
import type { FeishuState } from "./state.js";
import type { FeishuNotifyDeps } from "./notify.js";
export interface NoticeBudget {
  reserve(key: string, gapMs: number): boolean;
  dispose(): void;
}
/** E extracts notify.ts's existing reserve into this shared factory, one per runtime. */
export function createNoticeBudget(_clock: Pick<FeishuClock, "now">): NoticeBudget {
  throw new Error("LAN security P0: notice budget not implemented");
}
export interface FeishuSecurityDeps {
  security: SecurityEventBus;
  clock: FeishuClock;
  owner(): string | undefined;
  budget: NoticeBudget;
  send: FeishuNotifyDeps["send"];
}
export interface FeishuSecurity {
  onEvent(event: SecurityEvent): void;
  dispose(): void;
}
export function createFeishuSecurity(_deps: FeishuSecurityDeps): FeishuSecurity {
  throw new Error("LAN security P0: security notifier not implemented");
}
export interface LoginApprovalDeps {
  state: FeishuState;
  clock: FeishuClock;
  /** Real work slot lives until sendCard settles (not the 5s logical timeout). */
  work: { run(task: () => Promise<unknown>): boolean };
  installation(): { gen: number; ownerOpenId: string; tenantKey: string } | undefined;
  sendCard(input: {
    owner: string;
    ip: string;
    device: string;
    user: string;
    expiresAt: number;
  }): Promise<{ chatId: string; messageId: string } | undefined>;
  patchCard(
    messageId: string,
    state: "pending" | "approved" | "denied" | "expired",
    nonces?: { approve: string; deny: string },
  ): Promise<unknown>;
  onDecision(challengeId: string, allowed: boolean, gen: number): void;
}
export interface FeishuLoginApproval extends LoginApprovalPort {
  /** Called only AFTER inbound's existing redeem chain; E rechecks install + owner + sibling. */
  onDecision(input: {
    challengeId: string;
    allowed: boolean;
    gen: number;
    operatorOpenId: string;
    installGen: number;
  }): void;
  dispose(): void;
}
export function createLoginApprovalPort(_deps: LoginApprovalDeps): FeishuLoginApproval {
  throw new Error("LAN security P0: Feishu approval not implemented");
}
export type { LoginApprovalPort, LoginApprovalCloseReason };
