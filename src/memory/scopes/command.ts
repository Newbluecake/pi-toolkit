/** Optional /mem subrouter; never registers or changes the original command. */
import { scopedFailure, scopedReadGate, scopedView, type ScopedSurfaceDeps } from "./tool.js";
import { sameSessionOwner, type SessionCommandRegistry, type SessionCommandTarget } from "./session-command.js";
import type { SessionMemoryWrite } from "./types.js";
import { clampSpanMs } from "../../core/deadline.js";
import { OP_APPROVAL_TIMEOUT_MS, REJECT_LABEL, type TuiSelectPort } from "./authorize.js";
import { bodyTextDigest, canonicalJson } from "./limits.js";
import type { HubConfirmation } from "./hub-management.js";

/** Sole presentation source is the kernel's deep-frozen token-bound confirmation.
 * Metadata is complete; raw bodies get their own unescaped blocks, never pointers. */
export function scopedHubConfirmationTitle(confirmation: HubConfirmation, digest: string): string {
  const heading = ["目标：HUB（所有项目共享）", `操作：${confirmation.kind}`, `完整操作摘要：${digest}`];
  if (confirmation.kind === "restore") {
    const { text, ...metadata } = confirmation;
    return [...heading, JSON.stringify(metadata, null, 2), "—— 冻结原文全文 ——", text].join("\n");
  }
  const { items, ...metadata } = confirmation;
  return [
    ...heading,
    JSON.stringify(metadata, null, 2),
    ...items.flatMap((item) => {
      const { text, ...history } = item;
      return [JSON.stringify(history, null, 2), `—— ${item.id} 冻结原文全文 ——`, text];
    }),
  ].join("\n");
}

export interface NativeMemoryCommandContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly isWeb: boolean;
  /** Host dispatch provenance, NOT tool/model metadata. */
  readonly interactive: boolean;
}
export interface ScopedCommandDeps extends ScopedSurfaceDeps {
  readonly commandContext: () => NativeMemoryCommandContext;
  /** SAME private registry injected into the session store, never constructed here. */
  readonly sessionCommands: SessionCommandRegistry;
  readonly sessionCommandTarget: SessionCommandTarget;
  readonly sessionPath: () => string | undefined;
  readonly hubPath: () => string;
  /** Actual native UI port, never a model answer. Used only after trusted native predicate. */
  readonly select?: TuiSelectPort;
}
export function trustedNativeMemoryCommand(deps: Pick<ScopedCommandDeps, "child" | "commandContext">): boolean {
  const ctx = deps.commandContext();
  return !deps.child && ctx.mode === "tui" && ctx.hasUI && !ctx.isWeb && ctx.interactive;
}
async function selectNativeConfirmation(
  deps: ScopedCommandDeps,
  title: string,
  affirm: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!deps.select || signal.aborted || !trustedNativeMemoryCommand(deps)) return undefined;
  const local = new AbortController();
  const abort = () => local.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, clampSpanMs(OP_APPROVAL_TIMEOUT_MS) ?? OP_APPROVAL_TIMEOUT_MS);
  timer.unref();
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      local.signal.addEventListener("abort", onAbort, { once: true });
    });
    const answer = deps.select(title, [REJECT_LABEL, affirm], { signal: local.signal });
    return await Promise.race([answer, cancelled]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (onAbort) local.signal.removeEventListener("abort", onAbort);
    local.abort();
  }
}
export function createScopedMemoryCommand(deps: ScopedCommandDeps) {
  return {
    async route(args: string, requestSignal?: AbortSignal): Promise<{ handled: boolean; result?: unknown }> {
      // Only exact new layer prefixes are consumed; old /mem paths remain untouched.
      const match = /^(session|hub)(?: ([\s\S]*))?$/.exec(args);
      if (!match) return { handled: false };
      const scope = match[1] as "session" | "hub",
        rest = match[2] ?? "list";
      const reply = (result: unknown) => ({ handled: true, result });
      const gate = scopedReadGate(deps, scope);
      if (gate) return reply(scopedFailure(gate));
      if (requestSignal?.aborted) return reply(scopedFailure("E_STALE_SESSION"));
      if (rest === "list" || rest === "status") return reply(scopedView(deps, scope));
      if (rest === "path")
        return reply({ ok: true, path: scope === "session" ? (deps.sessionPath() ?? "memory-only") : deps.hubPath() });
      const show = /^show ([^ ]+)$/.exec(rest);
      if (show && scope === "hub") return reply(deps.hub!.management.inspect(show[1]!));
      if (rest === "trash" && scope === "hub") return reply({ ok: true, items: deps.hub!.management.listTrash() });
      if (!trustedNativeMemoryCommand(deps))
        return reply(scopedFailure(deps.child ? "E_CHILD_READONLY" : "E_AUTHORITY"));
      const owner = { ...deps.currentOwner() };
      const lifecycle = deps.signal();
      const signal = requestSignal ? AbortSignal.any([lifecycle, requestSignal]) : lifecycle;
      const valid = () =>
        !signal.aborted &&
        sameSessionOwner(owner, deps.currentOwner()) &&
        trustedNativeMemoryCommand(deps) &&
        !scopedReadGate(deps, scope);
      if (!valid()) return reply(scopedFailure("E_STALE_SESSION"));
      const add = /^add ([\s\S]+)$/.exec(rest);
      if (add) {
        if (scope === "session") {
          const operation: SessionMemoryWrite["operation"] = Object.freeze({
            storageScope: "session",
            op: "create",
            authority: "user",
            text: add[1]!,
          });
          const grant = deps.sessionCommands.issue(operation, owner);
          if (!grant) return reply(scopedFailure("E_AUTHORITY"));
          try {
            if (!valid()) return reply(scopedFailure("E_STALE_SESSION"));
            return reply(await deps.sessionCommandTarget.enqueueCommand({ operation, owner, signal }, grant));
          } finally {
            deps.sessionCommands.revoke(grant);
          }
        }
        return reply(
          await deps.hub!.management.command(
            Object.freeze({ storageScope: "hub", op: "create", authority: "user", topic: "general", text: add[1]! }),
            signal,
          ),
        );
      }
      const rm = /^rm ([^ ]+)$/.exec(rest);
      if (scope === "hub" && rm) {
        const found = deps.hub!.management.inspect(rm[1]!);
        if (!found.ok) return reply(found);
        if (!valid()) return reply(scopedFailure("E_STALE_SESSION"));
        return reply(
          await deps.hub!.management.command(
            Object.freeze({
              storageScope: "hub",
              op: "delete",
              authority: "user",
              targetId: found.item.id,
              expectRev: found.rev,
              text: found.item.text,
            }),
            signal,
          ),
        );
      }
      const restore = /^restore ([^ ]+)$/.exec(rest);
      if (scope === "hub" && (rest === "adopt" || restore)) {
        const prepared = restore
          ? deps.hub!.management.prepareRestore(restore[1]!, signal)
          : deps.hub!.management.prepareAdopt(signal);
        if (!prepared.ok) return reply(prepared);
        try {
          if (!valid()) return reply(scopedFailure("E_STALE_SESSION"));
          if (!deps.select) return reply(scopedFailure("E_HUB_CONFIRM_UNAVAILABLE"));
          const confirmation = prepared.confirmation;
          const digest = bodyTextDigest(canonicalJson(confirmation));
          const affirm = `确认执行 HUB ${confirmation.kind} · ${digest.slice(0, 8)}`;
          const choice = await selectNativeConfirmation(
            deps,
            scopedHubConfirmationTitle(confirmation, digest),
            affirm,
            signal,
          );
          if (!valid()) return reply(scopedFailure("E_STALE_SESSION"));
          if (choice !== affirm) return reply(scopedFailure("E_HUB_DECLINED"));
          return reply(await deps.hub!.management.commit(prepared.token));
        } finally {
          // Invalidates this token only; never aborts lifecycle or revokes another owner.
          deps.hub!.management.cancel(prepared.token);
        }
      }
      return reply(scopedFailure("E_META_INVALID"));
    },
  };
}
