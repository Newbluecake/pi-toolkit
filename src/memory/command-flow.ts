/** R4 bounded revision-menu controller. No production dispatch, native handler,
 * model call or write authority. The domain port alone consumes exact receipts.
 * I1 owns completion-ledger publication; cancel() is its observation snapshot. */
import { createHash } from "node:crypto";
import {
  COMMAND_CONFIRM_TIMEOUT_MS,
  type CommandClock,
  type CommandConfirmKernel,
  type CommandPlan,
  type MemoryCommandApproval,
  type MemoryWebCall,
} from "./command-confirm.js";
import {
  aggregateMemoryCommandEffect,
  encodeMemoryCommandFacts,
  memoryCommandFailureCode,
  type MemoryCommandDomainCode,
  type MemoryCommandFactRow,
  type MemoryCommandFacts,
} from "../web-hub/protocol/memory-command-facts.js";

export const COMMAND_FLOW_LIMITS = Object.freeze({
  targets: 16,
  effects: 16,
  navigation: 64,
  pageBytes: 20 * 1024,
  terminalBytes: 24 * 1024,
  progressBytes: 8 * 1024,
});
export type RevisionFlowGrammar = { readonly kind: "review"; readonly listOnly: boolean };
/** No tidy, --run, legacy model effects, ambiguous flags or caller-supplied class. */
export function parseRevisionFlowCommand(raw: string): RevisionFlowGrammar | undefined {
  if (raw.trim() === "review") return { kind: "review", listOnly: false };
  if (raw.trim() === "review --list") return { kind: "review", listOnly: true };
  return undefined;
}
export interface CommandFlowTarget {
  readonly actionId: string;
  readonly targetId: string;
  readonly operation: Exclude<MemoryCommandFactRow["operation"], "keep">;
  readonly live: boolean;
}
export interface CommandFlowChoice {
  readonly cmdId: string;
  readonly target: number;
  readonly page: number;
  readonly pages: number;
  readonly presentation: string;
  readonly options: readonly string[];
}
export interface CommandFlowPrepared {
  readonly plan: CommandPlan;
  execute(
    receipt: MemoryCommandApproval,
    exactPlan: CommandPlan,
    observe: (row: MemoryCommandFactRow) => void,
  ): Promise<MemoryCommandFactRow>;
}
export interface CommandFlowDomain {
  snapshot(): Promise<{ readonly targets: readonly CommandFlowTarget[]; readonly omitted: number }>;
  view(target: CommandFlowTarget): Promise<string>;
  prepare(target: CommandFlowTarget, operation: "apply" | "keep", step: number): Promise<CommandFlowPrepared>;
}
export interface CommandFlowResult {
  readonly ok: boolean;
  readonly facts: MemoryCommandFacts;
  readonly message: string;
  readonly code?: ReturnType<typeof memoryCommandFailureCode>;
  readonly retryable: false;
}
export type CommandFlowCancelReason = "abort" | "timeout" | "tree" | "session" | "reload" | "dispose";
export interface CommandFlowTask {
  readonly done: Promise<CommandFlowResult>;
  cancel(reason?: CommandFlowCancelReason): CommandFlowResult;
  /** Called by I1 only AFTER observing and settling its existing ledger. */
  release(): void;
}
const defaultClock: CommandClock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimer(t) {
    clearTimeout(t as NodeJS.Timeout);
  },
};
/** Split without dropping or replacing a single UTF-8 codepoint. Pages are
 * navigational only; the final receipt binds ALL pages through the exact plan. */
export function commandFlowPages(text: string): readonly string[] {
  const pages: string[] = [];
  let page = "",
    bytes = 0;
  for (const cp of text) {
    const n = Buffer.byteLength(cp);
    if (bytes + n > COMMAND_FLOW_LIMITS.pageBytes) {
      pages.push(page);
      page = "";
      bytes = 0;
    }
    page += cp;
    bytes += n;
  }
  pages.push(page);
  return pages;
}
export function commandFlowConfirmationPlan(plan: CommandPlan): CommandPlan {
  const pages = commandFlowPages(plan.presentation);
  return Object.freeze({
    ...plan,
    presentation:
      pages.length === 1
        ? plan.presentation
        : `${pages.at(-1)!}\n\n已逐页展示完整原文（${pages.length} 页）。全文 SHA256: ${createHash("sha256").update(plan.presentation).digest("hex")}\n仅执行此冻结单目标计划；取消不执行。`,
  });
}
export function flowFact(target: CommandFlowTarget, step: number): MemoryCommandFactRow {
  return {
    step,
    actionId: target.actionId,
    targetId: target.targetId,
    operation: target.operation,
    outcome: "skipped",
    receipt: "not-consumed",
    stage: "admission",
    data: "not-called",
    audit: "not-entered",
    review: "unchanged",
  };
}
/** Closed errors, never infer permission/effect from exception.message. */
export class CommandFlowRefusal extends Error {
  constructor(readonly code: MemoryCommandDomainCode) {
    super(code);
  }
}
export function startCommandFlow(options: {
  readonly kernel: CommandConfirmKernel;
  readonly call: MemoryWebCall;
  readonly domain: CommandFlowDomain;
  readonly choose: (request: CommandFlowChoice, signal: AbortSignal) => Promise<string | undefined>;
  readonly listOnly?: boolean;
  readonly clock?: CommandClock;
}): CommandFlowTask {
  const { kernel, call, domain } = options;
  const binding = kernel.binding(call),
    lease = kernel.lease(call),
    clock = options.clock ?? defaultClock;
  if (
    !binding ||
    !lease ||
    !binding.cmdId ||
    Buffer.byteLength(binding.cmdId) > 256 ||
    /[\x00-\x1f\x7f-\x9f]/.test(binding.cmdId) ||
    !encodeMemoryCommandFacts("", {
      v: 1,
      kind: "memory-flow",
      cmdId: binding.cmdId,
      effect: "none",
      rows: [],
      omitted: 0,
    })
  )
    throw new CommandFlowRefusal("E_MEM_NEEDS_HUMAN_COMMAND");
  const cmdId = binding.cmdId;
  let rows: MemoryCommandFactRow[] = [],
    omitted: number | null = 0,
    terminal: CommandFlowResult | undefined;
  let navigation = 0,
    effects = 0,
    active = -1,
    released = false;
  let failureCode: MemoryCommandDomainCode | undefined;
  let waitingConfirm = false;
  let resolveDone!: (r: CommandFlowResult) => void;
  const done = new Promise<CommandFlowResult>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (): CommandFlowResult => {
    if (terminal) return terminal;
    const frozenRows = Object.freeze(rows.map((r) => Object.freeze({ ...r })));
    let effect = aggregateMemoryCommandEffect(frozenRows, omitted);
    let facts: MemoryCommandFacts = Object.freeze({
      v: 1,
      kind: "memory-flow",
      cmdId,
      effect,
      rows: frozenRows,
      omitted,
    });
    const code = rows.find((r) => r.code)?.code ?? failureCode;
    const summary = `memory revision flow: ${effect}; completed=${rows.filter((r) => r.outcome === "completed").length}; rejected=${rows.filter((r) => r.outcome === "rejected").length}; skipped=${rows.filter((r) => r.outcome === "skipped").length}; unknown=${rows.filter((r) => r.outcome === "unknown").length}.\n${code ?? ""}\n单目标效果；无全局回滚。unknown 可能已写入，勿盲目重试；恢复须重新检查原 C 审计并另行确认。`;
    let message = encodeMemoryCommandFacts(summary, facts);
    if (!message) {
      effect = "unknown";
      facts = Object.freeze({ v: 1, kind: "memory-flow", cmdId, effect, rows: Object.freeze([]), omitted: null });
      message = encodeMemoryCommandFacts("memory revision flow: unknown. 观测不完整或不可验证；勿盲重试。", facts)!;
    }
    terminal = Object.freeze({
      ok: effect === "completed" || (effect === "none" && !code),
      facts,
      message,
      ...(code
        ? { code: memoryCommandFailureCode(code)! }
        : effect === "unknown" || effect === "partial"
          ? { code: "E_COMMAND_DENIED" as const }
          : {}),
      retryable: false,
    });
    lease.signal.removeEventListener("abort", onAbort);
    resolveDone(terminal);
    return terminal;
  };
  const cancel = (reason: CommandFlowCancelReason = "abort"): CommandFlowResult => {
    if (terminal) return terminal;
    const refusedCode = reason === "timeout" ? "E_MEM_CONFIRM_TIMEOUT" : "E_MEM_CONFIRM_STALE";
    if (active < 0) failureCode = refusedCode;
    if (active >= 0) {
      const row = rows[active]!;
      const uncertain = row.audit !== "not-entered" || row.data !== "not-called" || row.review !== "unchanged";
      if (row.outcome !== "completed")
        rows[active] = {
          ...row,
          outcome: uncertain ? "unknown" : "rejected",
          code: uncertain ? "E_MEM_EFFECT_UNKNOWN" : refusedCode,
        };
    }
    // Close before publication; abort reentry sees only the same terminal snapshot.
    const result = finish();
    kernel.close(call);
    return result;
  };
  const onAbort = () => {
    // confirm() ALWAYS settles on kernel close. Let its original closed code
    // win (declined/timeout/unavailable/stale), rather than racing it to stale.
    if (!waitingConfirm) cancel(clock.now() >= binding.deadline ? "timeout" : "abort");
  };
  lease.signal.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (terminal || !lease.check()) throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
  };
  const choose = async (request: CommandFlowChoice): Promise<string> => {
    check();
    if (++navigation > COMMAND_FLOW_LIMITS.navigation) throw new CommandFlowRefusal("E_MEM_PLAN_BUDGET");
    const controller = new AbortController();
    const navigationDeadline = clock.now() + COMMAND_CONFIRM_TIMEOUT_MS;
    let timer: unknown;
    const value = await new Promise<string | undefined>((resolve, reject) => {
      const stop = () => {
        controller.abort();
        end(undefined);
      };
      lease.signal.addEventListener("abort", stop, { once: true });
      const end = (v: string | undefined) => {
        lease.signal.removeEventListener("abort", stop);
        if (timer !== undefined) clock.clearTimer(timer);
        resolve(v);
      };
      timer = clock.setTimer(COMMAND_CONFIRM_TIMEOUT_MS, () => {
        controller.abort();
        end(undefined);
      });
      try {
        void options.choose(request, controller.signal).then(end, () => end(undefined));
      } catch (e) {
        lease.signal.removeEventListener("abort", stop);
        clock.clearTimer(timer);
        reject(e);
      }
    });
    controller.abort();
    check();
    if (clock.now() >= navigationDeadline) throw new CommandFlowRefusal("E_MEM_CONFIRM_TIMEOUT");
    if (value === undefined || !request.options.includes(value)) throw new CommandFlowRefusal("E_MEM_CONFIRM_DECLINED");
    return value;
  };
  const display = async (text: string, index: number, effect: boolean): Promise<void> => {
    const pages = commandFlowPages(text);
    for (let p = 0; p < pages.length; p++) {
      const answer = await choose({
        cmdId,
        target: index + 1,
        page: p + 1,
        pages: pages.length,
        presentation: pages[p]!,
        options: ["cancel", p + 1 === pages.length ? "continue" : "next"],
      });
      if (answer === "cancel") throw new CommandFlowRefusal("E_MEM_CONFIRM_DECLINED");
    }
    if (effect) check();
  };
  // Attach first, then begin domain reads/dialogs. No synchronous effect prefix.
  void Promise.resolve().then(async () => {
    try {
      check();
      const snapshot = await domain.snapshot();
      check();
      const targets = snapshot.targets.slice(0, COMMAND_FLOW_LIMITS.targets);
      omitted = snapshot.omitted + Math.max(0, snapshot.targets.length - targets.length);
      rows = targets.map((t, i) => flowFact(t, i + 1));
      for (let i = 0; i < targets.length; i++) {
        active = i;
        const target = targets[i]!;
        if (options.listOnly) {
          await display(await domain.view(target), i, false);
          check();
          continue;
        }
        for (;;) {
          const choice = await choose({
            cmdId,
            target: i + 1,
            page: 0,
            pages: 0,
            presentation: `${target.targetId} · ${target.operation} · ${target.live ? "LIVE" : "history (view/keep only)"}`,
            options: ["cancel", "skip", "view", "keep", ...(target.live ? ["apply"] : [])],
          });
          if (choice === "cancel") throw new CommandFlowRefusal("E_MEM_CONFIRM_DECLINED");
          if (choice === "skip") break;
          if (choice === "view") {
            await display(await domain.view(target), i, false);
            check();
            continue;
          }
          if (++effects > COMMAND_FLOW_LIMITS.effects) throw new CommandFlowRefusal("E_MEM_PLAN_BUDGET");
          if (choice === "keep") rows[i] = { ...rows[i]!, operation: "keep" };
          const prepared = await domain.prepare(target, choice === "keep" ? "keep" : "apply", i + 1);
          check();
          rows[i] = { ...rows[i]!, stage: "plan" };
          await display(prepared.plan.presentation, i, true);
          // The complete text was displayed in bound, sequential read-only pages.
          // Final question remains <=24KiB and hashes the ORIGINAL full plan.
          const plan = commandFlowConfirmationPlan(prepared.plan);
          waitingConfirm = true;
          const approval = await kernel.confirm(call, plan);
          waitingConfirm = false;
          if (!approval.approved) throw new CommandFlowRefusal(approval.code);
          check();
          try {
            if (!kernel.reserve(call, approval.receipt, plan)) throw new CommandFlowRefusal("E_MEM_CONFIRM_STALE");
            // Domain prepared plan must be the EXACT plan approved, including paging proof.
            // A wrapper passes it explicitly, not a digest supplied by the menu.
            const row = await prepared.execute(approval.receipt, plan, (r) => {
              if (!terminal) rows[i] = { ...r };
            });
            if (terminal) return;
            rows[i] = { ...row };
          } finally {
            kernel.revoke(approval.receipt);
          }
          if (rows[i]!.outcome !== "completed") {
            finish();
            return;
          }
          break;
        }
      }
      active = -1;
      finish();
    } catch (error) {
      waitingConfirm = false;
      if (terminal) return;
      if (active >= 0) {
        const old = rows[active]!;
        const uncertain = old.audit !== "not-entered" || old.data !== "not-called" || old.review !== "unchanged";
        rows[active] = {
          ...old,
          outcome: uncertain ? "unknown" : "rejected",
          code: uncertain ? "E_MEM_EFFECT_UNKNOWN" : error instanceof CommandFlowRefusal ? error.code : "unavailable",
        };
      } else if (!rows.length) {
        omitted = 0; // No effect was admitted; unread candidates are not attempted effects.
        failureCode = error instanceof CommandFlowRefusal ? error.code : "unavailable";
      }
      finish();
    } finally {
      kernel.close(call);
    }
  });
  return {
    done,
    cancel,
    release() {
      if (released) return;
      released = true;
      if (!terminal) cancel();
      kernel.close(call);
    },
  };
}
