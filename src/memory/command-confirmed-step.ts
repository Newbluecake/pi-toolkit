/** Building block for a single confirmed Web step. Not a production command adapter.
 *
 * The domain adapter must do all preparation without effects and call commit only while
 * holding its normal lock, after its last await. validate and apply must be synchronous;
 * apply must be the only place where the adapter performs effects. This helper cannot
 * make an existing unguarded store or detached task cancellable.
 */
import {
  commandFailure,
  type CommandConfirmKernel,
  type CommandFailure,
  type CommandLease,
  type CommandPlan,
  type MemoryWebCall,
} from "./command-confirm.js";

type SyncApply<A extends () => unknown> = A & (ReturnType<A> extends PromiseLike<unknown> ? never : unknown);

export type ConfirmedStepResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CommandFailure }
  | { readonly ok: false; readonly code: "E_MEM_EFFECT_UNKNOWN"; readonly error: unknown };

/** The adapter must neither write nor start detached work before invoking commit. */
export async function runConfirmedStep<T>(options: {
  readonly kernel: CommandConfirmKernel;
  readonly call: MemoryWebCall;
  readonly plan: CommandPlan;
  readonly runLocked: (
    lease: CommandLease,
    commit: <A extends () => T>(validate: () => boolean, apply: SyncApply<A>) => ConfirmedStepResult<T>,
  ) => Promise<ConfirmedStepResult<T>>;
}): Promise<ConfirmedStepResult<T>> {
  const { kernel, call } = options;
  // Primitive fields are copied: external mutations cannot change the displayed plan.
  const plan = Object.freeze({ ...options.plan });
  const approval = await kernel.confirm(call, plan);
  if (!approval.approved) return { ok: false, failure: approval };
  const receipt = approval.receipt;
  let committed = false;
  let attempted = false;
  try {
    if (!kernel.reserve(call, receipt, plan)) return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
    const lease = kernel.lease(call);
    if (!lease || !lease.check()) return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
    const commit = <A extends () => T>(validate: () => boolean, apply: SyncApply<A>): ConfirmedStepResult<T> => {
      if (attempted || !lease.check() || !kernel.check(call, receipt, plan))
        return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
      attempted = true;
      let matches = false;
      try {
        matches = validate();
      } catch {
        // An unreadable or otherwise uncheckable snapshot is not the approved plan.
      }
      if (!matches) return { ok: false, failure: commandFailure("E_MEM_PLAN_CHANGED") };
      // Reject native async callbacks before consumption. This is a diagnostic guard,
      // not proof that an ordinary function cannot schedule detached work.
      if (Object.prototype.toString.call(apply) === "[object AsyncFunction]")
        return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
      // No await between final checks, consumption and the domain effect.
      if (!lease.check() || !kernel.consume(call, receipt, plan))
        return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
      committed = true;
      try {
        const value = apply();
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          typeof (value as { then?: unknown }).then === "function"
        ) {
          // It is too late to assume zero effects: the callback has already run.
          // Observe rejection to avoid leaving an unhandled promise behind.
          void Promise.resolve(value).catch(() => {});
          return { ok: false, code: "E_MEM_EFFECT_UNKNOWN", error: new Error("asynchronous apply is forbidden") };
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: "E_MEM_EFFECT_UNKNOWN", error };
      }
    };
    // Abort settles the caller even if the domain is still waiting for its lock.
    // The revoked receipt/lease makes a late invocation of commit fail closed.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<ConfirmedStepResult<T>>((resolve) => {
      onAbort = () =>
        resolve(
          committed
            ? { ok: false, code: "E_MEM_EFFECT_UNKNOWN", error: new Error("cancelled after commit") }
            : { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") },
        );
      if (lease.signal.aborted) onAbort();
      else lease.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([options.runLocked(lease, commit), aborted]);
      if (result.ok && !committed) return { ok: false, failure: commandFailure("E_MEM_CONFIRM_STALE") };
      return result;
    } finally {
      if (onAbort) lease.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    kernel.revoke(receipt);
  }
}
