/** Shared scoped ports/read projection; the host remains their sole owner. */
import { scopedFailure, withScopedMessage } from "./error-messages.js";
import { utf8Bytes } from "./limits.js";
import type { HubMemoryPort } from "./hub-store.js";
import type { ApprovalPort, HumanTurn, MemoryOwner, SessionMemoryPort, ScopedMemoryErrorCode } from "./types.js";

export interface ScopedSurfaceDeps {
  readonly enabled: { readonly session: boolean; readonly hub: boolean };
  readonly child: boolean;
  /** Realtime capability; secure/locked/unknown refuse BEFORE calling any read port. */
  readonly capability: () => "ok" | "disabled" | "secure" | "locked" | "unknown";
  readonly currentOwner: () => MemoryOwner;
  readonly session?: SessionMemoryPort;
  readonly hub?: HubMemoryPort;
  readonly signal: () => AbortSignal;
}
export interface ScopedToolDeps extends ScopedSurfaceDeps {
  readonly sharedApproval: ApprovalPort;
  /** Same host registry consumer; revoke ONLY this request's cap, never global turn. */
  readonly caps: Pick<import("./types.js").MemoryOpCapPort, "revoke">;
  readonly humanTurn: () => HumanTurn | undefined;
  readonly projectLabel: () => string;
}
export function scopedReadGate(deps: ScopedSurfaceDeps, scope: "session" | "hub"): ScopedMemoryErrorCode | undefined {
  if (!deps.enabled[scope] || (scope === "hub" && deps.child)) return "E_SCOPE_DISABLED";
  if (deps.capability() !== "ok" || deps.signal().aborted) return "E_WRITE_GATE";
  if (scope === "session" ? !deps.session : !deps.hub) return "E_SCOPE_DISABLED";
  return undefined;
}
export function scopedView(deps: ScopedSurfaceDeps, scope: "session" | "hub") {
  const gate = scopedReadGate(deps, scope);
  if (gate) return scopedFailure(gate);
  if (scope === "session") {
    const view = deps.session!.view();
    return {
      ok: true,
      state: view.poisoned ? "poisoned" : "ok",
      ...view,
      capacity: {
        items: view.items.length,
        maxItems: 48,
        rawBytes: view.items.reduce((n, i) => n + utf8Bytes(i.item.text), 0),
        maxRawBytes: 8192,
      },
    };
  }
  const view = deps.hub!.management.status();
  const items = [];
  for (const item of view.items) {
    const gate = scopedReadGate(deps, "hub");
    if (gate) return scopedFailure(gate);
    const inspected = deps.hub!.management.inspect(item.id);
    if (!inspected.ok) return withScopedMessage(inspected);
    items.push({ ...inspected.item, rev: inspected.rev });
  }
  return {
    ok: true,
    ...view,
    items,
    capacity: {
      items: items.length,
      maxItems: 32,
      rawBytes: items.reduce((n, i) => n + utf8Bytes(i.text), 0),
      maxRawBytes: 4096,
    },
  };
}
