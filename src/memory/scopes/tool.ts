/** Factory-only scoped surface. Host owns all ports, lifecycle and human provenance. */
import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { bodyTextDigest, isFromRef, isHubTopic, readUntrustedValue, scopedOpDigest, utf8Bytes } from "./limits.js";
import { sameSessionOwner } from "./session-command.js";
import type { HubMemoryPort } from "./hub-store.js";
import type {
  ApprovalPort,
  FrozenScopedOp,
  HumanTurn,
  MemoryOwner,
  SessionMemoryPort,
  ScopedMemoryErrorCode,
} from "./types.js";

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
export const scopedFailure = (code: ScopedMemoryErrorCode) => ({ ok: false as const, code });
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
    if (!inspected.ok) return inspected;
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
export const SCOPED_MEMORY_DESCRIPTION =
  "Session and Hub memory: op=view|create|update|delete. update/delete require the actual rev returned by view (for Hub, supply id); delete confirms the full current body. Session defaults to agent; user authority and changes to user items require exact-content human approval. Child sessions accept no explicit authority, including agent. Hub is shared by ALL projects of this Hub; a write needs the user to approve it in a dialog (terminal or web). scope=global inside memory text is NOT cross-project. No human proof/remote channel means refusal, not queueing or resending. Never store secrets.";
export function createScopedMemoryTool(deps: ScopedToolDeps) {
  const scopes = deps.child
    ? deps.enabled.session
      ? ["session"]
      : []
    : ["session", "hub"].filter((s) => deps.enabled[s as "session" | "hub"]);
  const parameters = Type.Object(
    {
      op: Type.Union([Type.Literal("view"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
      storageScope: scopes.length ? Type.Union(scopes.map((s) => Type.Literal(s))) : Type.Never(),
      id: Type.Optional(
        Type.String({
          description: "Exact target id. Required for update/delete; Hub view with id returns actual rev.",
        }),
      ),
      text: Type.Optional(
        Type.String({
          description:
            "Full body for create/update. Delete always freezes the actual current body, never supplied substitute text.",
        }),
      ),
      rev: Type.Optional(
        Type.String({ description: "Actual current revision from view, required for update/delete CAS." }),
      ),
      topic: Type.Optional(
        Type.String({
          description: "Hub create topic (lowercase letters, digits, hyphens). Not accepted for session.",
        }),
      ),
      from: Type.Optional(
        Type.String({
          description:
            "Optional provenance link session:nN or project:<reference>; does not grant authority or move the source.",
        }),
      ),
      authority: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("user")])),
    },
    { additionalProperties: false },
  );
  async function run(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const parsed = readUntrustedValue(input);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value))
      return scopedFailure("E_META_INVALID");
    const p = parsed.value;
    if (deps.child && Object.hasOwn(p, "authority")) return scopedFailure("E_CHILD_AUTHORITY");
    if (
      Object.keys(p).some((k) => !["op", "storageScope", "id", "text", "rev", "topic", "from", "authority"].includes(k))
    )
      return scopedFailure("E_META_INVALID");
    if (p.storageScope !== "session" && p.storageScope !== "hub") return scopedFailure("E_SCOPE_DISABLED");
    const scope = p.storageScope;
    const gate = scopedReadGate(deps, scope);
    if (gate) return scopedFailure(gate);
    for (const k of ["id", "text", "rev", "topic", "from", "authority"])
      if (p[k] !== undefined && typeof p[k] !== "string") return scopedFailure("E_META_INVALID");
    if (p.authority !== undefined && p.authority !== "agent" && p.authority !== "user")
      return scopedFailure("E_AUTHORITY");
    if (scope === "hub" && p.authority !== undefined) return scopedFailure("E_AUTHORITY");
    if (typeof p.text === "string" && utf8Bytes(p.text) > 1024) return scopedFailure("E_TOO_LARGE");
    if (p.from !== undefined && !isFromRef(p.from)) return scopedFailure("E_FROM_INVALID");
    if (p.topic !== undefined && !isHubTopic(p.topic)) return scopedFailure("E_META_INVALID");
    if (p.op === "view") {
      if (p.id !== undefined) {
        if (scope === "hub") return deps.hub!.management.inspect(p.id as string);
        const found = deps.session!.view().items.find((i) => i.item.id === p.id);
        return found ? { ok: true, ...found } : scopedFailure("E_NOT_FOUND");
      }
      return scopedView(deps, scope);
    }
    if (p.op !== "create" && p.op !== "update" && p.op !== "delete") return scopedFailure("E_META_INVALID");
    if (scope === "hub") {
      const status = deps.hub!.management.status();
      if (status.state === "inert") return scopedFailure("E_NAMESPACE");
      if (status.state === "disabled") return scopedFailure("E_SCOPE_DISABLED");
    }
    if (p.op !== "create" && (typeof p.rev !== "string" || !p.rev)) return scopedFailure("E_REV_REQUIRED");
    if (p.op === "create" && (p.id !== undefined || p.rev !== undefined)) return scopedFailure("E_META_INVALID");
    if (p.op !== "delete" && typeof p.text !== "string") return scopedFailure("E_META_INVALID");
    if (scope === "session" && p.topic !== undefined) return scopedFailure("E_META_INVALID");
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
      if (!approval.approved) return scopedFailure(approval.code);
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
  return {
    name: "scoped_memory",
    label: "Scoped Memory",
    description: SCOPED_MEMORY_DESCRIPTION,
    parameters,
    run,
    async execute(id: string, params: unknown, signal?: AbortSignal) {
      const result = await run(id, params, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  };
}
