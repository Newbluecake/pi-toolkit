/** The existing scoped tool operations, shared by both adapters (not a second writer). */
import { randomBytes } from "node:crypto";
import { scopedFailure } from "./error-messages.js";
import { bodyTextDigest, scopedOpDigest } from "./limits.js";
import { sameSessionOwner } from "./session-command.js";
import { scopedReadGate, scopedView, type ScopedToolDeps } from "./tool-surface.js";
import type { FrozenScopedOp } from "./types.js";

/** Validated by dispatchScopedMemory, in the original scoped field order. */
export interface ScopedMutationParams {
  readonly op: "create" | "update" | "delete";
  readonly id?: string;
  readonly text?: string;
  readonly rev?: string;
  readonly topic?: string;
  readonly from?: string;
  readonly authority?: "agent" | "user";
}

export function viewScopedItem(deps: ScopedToolDeps, scope: "session" | "hub", id: string | undefined) {
  if (id !== undefined) {
    if (scope === "hub") return deps.hub!.management.inspect(id);
    const found = deps.session!.view().items.find((i) => i.item.id === id);
    return found ? { ok: true, ...found } : scopedFailure("E_NOT_FOUND");
  }
  return scopedView(deps, scope);
}

export async function mutateScopedMemory(
  deps: ScopedToolDeps,
  scope: "session" | "hub",
  toolCallId: string,
  p: ScopedMutationParams,
  signal?: AbortSignal,
): Promise<unknown> {
  const owner = deps.currentOwner();
  const capturedOwner = Object.freeze({ ...owner });
  const lifecycle = deps.signal();
  const combined = signal ? AbortSignal.any([lifecycle, signal]) : lifecycle;
  if (combined.aborted) return scopedFailure("E_STALE_SESSION");
  let authority: "user" | "agent" = scope === "hub" || p.authority === "user" ? "user" : "agent";
  let text = typeof p.text === "string" ? p.text : undefined;
  if (p.op !== "create") {
    if (typeof p.id !== "string") return scopedFailure("E_META_INVALID");
    if (scope === "session") {
      const found = deps.session!.view().items.find((i) => i.item.id === p.id);
      if (!found) return scopedFailure("E_NOT_FOUND");
      if (found.rev !== p.rev) return scopedFailure("E_CONFLICT");
      if (found.item.authority === "user") {
        if (deps.child) return scopedFailure("E_AUTHORITY");
        authority = "user";
      }
      if (p.op === "delete") text = found.item.text;
    } else {
      const found = deps.hub!.management.inspect(p.id);
      if (!found.ok) return found;
      if (found.rev !== p.rev) return scopedFailure("E_CONFLICT");
      if (p.op === "delete") text = found.item.text;
    }
  }
  const fields: Omit<FrozenScopedOp, "storageScope" | "authority"> = {
    op: p.op,
    ...(p.id !== undefined ? { targetId: p.id as string } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(p.rev !== undefined ? { expectRev: p.rev as string } : {}),
    ...(p.topic !== undefined ? { topic: p.topic as string } : {}),
    ...(p.from !== undefined ? { from: p.from as string } : {}),
  };
  const operation: FrozenScopedOp = Object.freeze(
    scope === "hub"
      ? { ...fields, storageScope: "hub", authority: "user" }
      : { ...fields, storageScope: "session", authority },
  );
  let cap;
  if (authority === "user") {
    const turn = deps.humanTurn();
    if (!turn || !sameSessionOwner(turn.owner, owner)) return scopedFailure("E_HUB_NEEDS_HUMAN_TURN");
    const approval = await deps.sharedApproval.request(
      {
        operation,
        projectLabel: deps.projectLabel(),
        binding: Object.freeze({
          owner,
          humanTurn: turn,
          toolCallId,
          nonce: randomBytes(16).toString("hex"),
          opDigest: scopedOpDigest({ ...operation }),
          textDigest: bodyTextDigest(operation.text ?? ""),
        }),
      },
      combined,
    );
    if (!approval.approved) return scopedFailure(approval.code, approval.message);
    cap = approval.cap;
  }
  try {
    if (combined.aborted || !sameSessionOwner(capturedOwner, deps.currentOwner()) || scopedReadGate(deps, scope))
      return scopedFailure("E_STALE_SESSION");
    if (operation.storageScope === "session")
      return await deps.session!.enqueue({ operation, owner, signal: combined, ...(cap ? { cap } : {}) });
    if (!cap) return scopedFailure("E_AUTHORITY");
    return await deps.hub!.enqueue({ operation, owner, cap, signal: combined });
  } finally {
    if (cap) deps.caps.revoke(cap);
  }
}
