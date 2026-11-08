/** Private, activation-local command confirmation kernel. No production wiring. */
import { createHash, randomBytes } from "node:crypto";
import { createSegmentedClock, type TimerHandle } from "../core/clock.js";
import { clampSpanMs } from "../core/deadline.js";
import { createDialogRace, type AskUserRemotePort, type AskUserRemoteSession } from "../ask-user/remote.js";

export const COMMAND_CONFIRM_TIMEOUT_MS = 120_000;
export const COMMAND_WALL_TIMEOUT_MS = 29 * 60_000;
export const COMMAND_BUSY_MESSAGE =
  "后台记忆任务尚未结束，本步未执行；本次授权已失效，不会自动重试，请稍后重新发起并确认。";
export const COMMAND_REJECT_LABEL = "拒绝（不执行）";
export type CommandErrorCode =
  | "E_MEM_CONFIRM_DECLINED"
  | "E_MEM_CONFIRM_TIMEOUT"
  | "E_MEM_CONFIRM_UNAVAILABLE"
  | "E_MEM_CONFIRM_STALE"
  | "E_MEM_NEEDS_HUMAN_COMMAND"
  | "E_MEM_PLAN_CHANGED"
  | "E_MEM_BUSY";
const messages: Readonly<Record<CommandErrorCode, string>> = {
  E_MEM_CONFIRM_DECLINED: "已取消确认，本步未执行。",
  E_MEM_CONFIRM_TIMEOUT: "确认超时，本步未执行；请重新发起并确认。",
  E_MEM_CONFIRM_UNAVAILABLE: "确认通道不可用，本步未执行。",
  E_MEM_CONFIRM_STALE: "命令已失效，本步未执行。",
  E_MEM_NEEDS_HUMAN_COMMAND: "缺少有效的人类命令授权，本步未执行。",
  E_MEM_PLAN_CHANGED: "确认后的计划已变化，本步未执行；请重新发起并确认。",
  E_MEM_BUSY: "记忆命令正在执行或已达到确认预算，本步未执行。",
};
export type CommandFailure = {
  readonly approved: false;
  readonly code: CommandErrorCode;
  readonly message: string;
  readonly retryable: false;
};
export function commandFailure(code: CommandErrorCode): CommandFailure {
  return { approved: false, code, message: messages[code], retryable: false };
}
export interface CommandClock {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
}
const clockDefault: CommandClock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimer(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
declare const callBrand: unique symbol;
declare const approvalBrand: unique symbol;
export type MemoryWebCall = { readonly [callBrand]: never };
export type MemoryCommandApproval = { readonly [approvalBrand]: never };
export interface CommandPlan {
  readonly rawArgs: string;
  readonly step: number;
  /** Complete canonical frozen manifest bytes, not a digest supplied by a model. */
  readonly manifest: string;
  readonly presentation: string;
}
export type CommandChannel =
  | { readonly kind: "web"; readonly remote: AskUserRemotePort }
  | {
      readonly kind: "tui";
      readonly select: (title: string, options: readonly string[], signal: AbortSignal) => Promise<string | undefined>;
    }
  | { readonly kind: "unavailable" };
export interface CommandConfirmOptions {
  readonly channel: CommandChannel;
  readonly clock?: CommandClock;
  readonly timeoutMs?: number;
  readonly maxDialogs?: number;
  /** Must synchronously verify actual owner/manager/epoch and trusted dispatch. */
  readonly isOwnerCurrent: () => boolean;
}
export interface CommandLease {
  readonly signal: AbortSignal;
  check(): boolean;
}
export interface CommandConfirmKernel {
  /** Host-only: invoke exclusively from the authenticated immediate dispatch seam. */
  start(rawArgs: string): MemoryWebCall | undefined;
  confirm(
    call: MemoryWebCall,
    plan: CommandPlan,
  ): Promise<{ approved: true; receipt: MemoryCommandApproval } | CommandFailure>;
  reserve(call: MemoryWebCall, receipt: MemoryCommandApproval, plan: CommandPlan): boolean;
  check(call: MemoryWebCall, receipt: MemoryCommandApproval, plan: CommandPlan): boolean;
  consume(call: MemoryWebCall, receipt: MemoryCommandApproval, plan: CommandPlan): boolean;
  revoke(receipt: MemoryCommandApproval): void;
  lease(call: MemoryWebCall): CommandLease | undefined;
  close(call: MemoryWebCall): void;
  dispose(): void;
}
interface CallRecord {
  rawArgs: string;
  deadline: number;
  dialogs: number;
  pending: boolean;
  steps: Set<number>;
  controller: AbortController;
  timer: TimerHandle | undefined;
}
interface ReceiptRecord {
  call: MemoryWebCall;
  digest: string;
  step: number;
  state: "minted" | "reserved";
}
function digest(plan: CommandPlan): string {
  return createHash("sha256")
    .update(JSON.stringify([plan.rawArgs, plan.step, plan.manifest, plan.presentation]))
    .digest("hex");
}
export function createCommandConfirmKernel(options: CommandConfirmOptions): CommandConfirmKernel {
  const clock = options.clock ?? clockDefault;
  const wallClock = createSegmentedClock({
    now: () => clock.now(),
    set: (ms, fn) => clock.setTimer(ms, fn),
    clear: (handle) => clock.clearTimer(handle),
  });
  const timeout = clampSpanMs(options.timeoutMs ?? COMMAND_CONFIRM_TIMEOUT_MS) ?? COMMAND_CONFIRM_TIMEOUT_MS;
  const requestedMax = options.maxDialogs ?? 256;
  const maxDialogs = Number.isFinite(requestedMax) ? Math.max(1, Math.min(1000, Math.floor(requestedMax))) : 256;
  const calls = new Map<MemoryWebCall, CallRecord>();
  const receipts = new Map<MemoryCommandApproval, ReceiptRecord>();
  let disposed = false;
  const ownerCurrent = (): boolean => {
    try {
      return !disposed && options.isOwnerCurrent() === true;
    } catch {
      return false;
    }
  };
  const close = (call: MemoryWebCall): void => {
    const record = calls.get(call);
    if (!record) return;
    calls.delete(call);
    if (record.timer !== undefined) wallClock.clearTimer(record.timer);
    record.controller.abort();
    for (const [cap, r] of receipts) if (r.call === call) receipts.delete(cap);
  };
  const valid = (call: MemoryWebCall): CallRecord | undefined => {
    const record = calls.get(call);
    if (!record) return undefined;
    if (!ownerCurrent() || record.controller.signal.aborted || clock.now() >= record.deadline) {
      close(call);
      return undefined;
    }
    return record;
  };
  const matches = (call: MemoryWebCall, cap: MemoryCommandApproval, plan: CommandPlan): ReceiptRecord | undefined => {
    const r = receipts.get(cap);
    const c = valid(call);
    if (!r || !c || r.call !== call) return undefined;
    if (c.rawArgs !== plan.rawArgs || r.digest !== digest(plan)) {
      close(call);
      return undefined;
    }
    return r;
  };
  return {
    start(rawArgs) {
      for (const c of calls.keys()) valid(c);
      if (!ownerCurrent() || calls.size !== 0) return undefined;
      const call = Object.freeze({}) as MemoryWebCall;
      const record: CallRecord = {
        rawArgs,
        deadline: clock.now() + COMMAND_WALL_TIMEOUT_MS,
        dialogs: 0,
        pending: false,
        steps: new Set(),
        controller: new AbortController(),
        timer: undefined,
      };
      calls.set(call, record);
      try {
        record.timer = wallClock.setTimer(clampSpanMs(COMMAND_WALL_TIMEOUT_MS) ?? COMMAND_WALL_TIMEOUT_MS, () =>
          close(call),
        );
      } catch {
        close(call);
        return undefined;
      }
      return call;
    },
    async confirm(call, plan) {
      const record = valid(call);
      if (!record) return commandFailure("E_MEM_NEEDS_HUMAN_COMMAND");
      // A concurrent request cannot terminate the legitimate in-flight dialog.
      if (record.pending) return commandFailure("E_MEM_BUSY");
      if (
        record.rawArgs !== plan.rawArgs ||
        !Number.isSafeInteger(plan.step) ||
        plan.step < 0 ||
        typeof plan.manifest !== "string" ||
        !plan.manifest ||
        typeof plan.presentation !== "string"
      ) {
        close(call);
        return commandFailure("E_MEM_PLAN_CHANGED");
      }
      const activeReceipt = [...receipts.values()].find((r) => r.call === call);
      if (activeReceipt && activeReceipt.step === plan.step && activeReceipt.digest !== digest(plan)) {
        close(call);
        return commandFailure("E_MEM_PLAN_CHANGED");
      }
      if (
        record.pending ||
        record.dialogs >= maxDialogs ||
        record.steps.has(plan.step) ||
        [...receipts.values()].some((r) => r.call === call)
      )
        return commandFailure("E_MEM_BUSY");
      if (options.channel.kind === "unavailable") {
        close(call);
        return commandFailure("E_MEM_CONFIRM_UNAVAILABLE");
      }
      const dialogDeadline = Math.min(clock.now() + timeout, record.deadline);
      const snapshot = digest(plan);
      const affirm = `确认执行 · ${snapshot.slice(0, 8)}`;
      const title = `${plan.presentation}\n\n命令：/mem ${plan.rawArgs}\n摘要：${snapshot}`;
      const channel = options.channel;
      let session: AskUserRemoteSession | undefined;
      if (channel.kind === "web") {
        try {
          session = channel.remote.open({
            toolCallId: `memcmd:${randomBytes(16).toString("hex")}`,
            questions: [
              {
                question: title,
                header: "MEMCMD",
                options: [{ label: COMMAND_REJECT_LABEL }, { label: affirm }],
                allowOther: false,
              },
            ],
            allowCancel: true,
          });
        } catch {
          /* unavailable */
        }
        if (!session) {
          close(call);
          return commandFailure("E_MEM_CONFIRM_UNAVAILABLE");
        }
      }
      record.pending = true;
      record.dialogs++;
      record.steps.add(plan.step);
      return await new Promise((resolve) => {
        const race = createDialogRace();
        const localAbort = new AbortController();
        let settled = false;
        let timer: unknown;
        const finish = (
          result: { approved: true; receipt: MemoryCommandApproval } | CommandFailure,
          closeRemote = true,
        ): void => {
          if (settled) return;
          settled = true;
          record.pending = false;
          if (timer !== undefined) clock.clearTimer(timer);
          record.controller.signal.removeEventListener("abort", onAbort);
          localAbort.abort();
          if (closeRemote) {
            try {
              session?.close("abort", "aborted");
            } catch {
              /* best effort */
            }
          }
          if (!result.approved) close(call);
          resolve(result);
        };
        const onAbort = (): void => {
          if (race.claim("abort")) finish(commandFailure("E_MEM_CONFIRM_STALE"));
        };
        const answer = (value: string | undefined, by: "tui" | "web"): void => {
          if (!race.claim(by)) return;
          // Deadline is exclusive: an answer at the exact deadline is too late.
          if (clock.now() >= dialogDeadline) {
            finish(commandFailure("E_MEM_CONFIRM_TIMEOUT"), by !== "web");
            return;
          }
          if (!valid(call)) {
            finish(commandFailure("E_MEM_CONFIRM_STALE"), by !== "web");
            return;
          }
          if (digest(plan) !== snapshot) {
            finish(commandFailure("E_MEM_PLAN_CHANGED"), by !== "web");
            return;
          }
          if (value !== affirm) {
            finish(commandFailure("E_MEM_CONFIRM_DECLINED"), by !== "web");
            return;
          }
          const receipt = Object.freeze({}) as MemoryCommandApproval;
          receipts.set(receipt, { call, digest: snapshot, step: plan.step, state: "minted" });
          finish({ approved: true, receipt }, by !== "web");
        };
        try {
          if (session)
            session.setOnRemote((outcome) => {
              if (settled || (outcome.originKind !== "loopback" && outcome.originKind !== "lan")) return false;
              if (clock.now() < dialogDeadline && !valid(call)) return false;
              if (outcome.kind === "cancel") {
                answer(undefined, "web");
                return true;
              }
              const entries = Object.entries(outcome.answers);
              if (
                entries.length !== 1 ||
                entries[0]?.[0] !== "MEMCMD" ||
                (entries[0][1] !== affirm && entries[0][1] !== COMMAND_REJECT_LABEL)
              )
                return false;
              answer(entries[0][1], "web");
              return true;
            });
          if (settled) return;
          record.controller.signal.addEventListener("abort", onAbort, { once: true });
          if (record.controller.signal.aborted) {
            onAbort();
            return;
          }
          timer = clock.setTimer(Math.max(0, dialogDeadline - clock.now()), () => {
            if (race.claim("abort")) finish(commandFailure("E_MEM_CONFIRM_TIMEOUT"));
          });
          if (channel.kind === "tui")
            void channel.select(title, [COMMAND_REJECT_LABEL, affirm], localAbort.signal).then(
              (v) => answer(v, "tui"),
              () => {
                if (race.claim("error")) finish(commandFailure("E_MEM_CONFIRM_UNAVAILABLE"));
              },
            );
        } catch {
          if (race.claim("error")) finish(commandFailure("E_MEM_CONFIRM_UNAVAILABLE"));
        }
      });
    },
    reserve(call, receipt, plan) {
      const r = matches(call, receipt, plan);
      if (!r || r.state !== "minted") return false;
      r.state = "reserved";
      return true;
    },
    check(call, receipt, plan) {
      return matches(call, receipt, plan) !== undefined;
    },
    consume(call, receipt, plan) {
      const r = matches(call, receipt, plan);
      if (!r || r.state !== "reserved") return false;
      receipts.delete(receipt);
      return true;
    },
    revoke(receipt) {
      receipts.delete(receipt);
    },
    lease(call) {
      const record = valid(call);
      return record ? { signal: record.controller.signal, check: () => valid(call) !== undefined } : undefined;
    },
    close,
    dispose() {
      disposed = true;
      for (const call of calls.keys()) close(call);
    },
  };
}
