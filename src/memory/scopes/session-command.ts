/** Host-private command authorization; never part of ScopedMemoryWrite/model parameters.
 * P4 constructs ONE registry and supplies it to store + command adapter. Only the adapter
 * gets issue(); store gets the consumer port. Trusted context must come from actual command
 * dispatch (including not-Web), not args/hasUI alone. No dialog cap is minted or mimicked.
 */
import { canonicalJson, readUntrustedValue } from "./limits.js";
import type { FrozenScopedOp, MemoryOwner, ScopedMemoryWriteResult, SessionMemoryWrite } from "./types.js";

type SessionOp = SessionMemoryWrite["operation"];
export function freezeSessionOperation(input: unknown): SessionOp | undefined {
  const parsed = readUntrustedValue(input);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value))
    return undefined;
  const v = parsed.value;
  if (
    Object.keys(v).some(
      (key) => !["storageScope", "op", "authority", "text", "targetId", "expectRev", "from", "topic"].includes(key),
    )
  )
    return undefined;
  if (
    v.storageScope !== "session" ||
    !["create", "update", "delete"].includes(String(v.op)) ||
    (v.authority !== "user" && v.authority !== "agent")
  )
    return undefined;
  for (const key of ["text", "targetId", "expectRev", "from", "topic"])
    if (v[key] !== undefined && typeof v[key] !== "string") return undefined;
  // Session has no topic. Reject rather than silently dropping an approved field.
  if (
    v.topic !== undefined ||
    (v.op === "create" && (v.targetId !== undefined || v.expectRev !== undefined)) ||
    (v.op !== "create" && v.targetId === undefined)
  )
    return undefined;
  return Object.freeze(v) as unknown as SessionOp;
}
export function sameSessionOperation(a: FrozenScopedOp, b: FrozenScopedOp): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
export const sameSessionOwner = (a: MemoryOwner, b: MemoryOwner): boolean =>
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionFile === b.sessionFile &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen;

declare const commandGrantBrand: unique symbol;
export interface SessionCommandGrant {
  readonly [commandGrantBrand]: true;
}
export interface SessionCommandGrantPort {
  check(grant: SessionCommandGrant, operation: SessionOp, owner: MemoryOwner): boolean;
  consume(grant: SessionCommandGrant): boolean;
  revoke(grant: SessionCommandGrant): void;
}
export interface SessionCommandRegistry extends SessionCommandGrantPort {
  issue(operation: SessionOp, owner: MemoryOwner): SessionCommandGrant | undefined;
}
export function createSessionCommandRegistry(trustedTuiNow: () => boolean): SessionCommandRegistry {
  const grants = new WeakMap<SessionCommandGrant, { operation: SessionOp; owner: MemoryOwner }>();
  return {
    issue(operation, owner) {
      if (!trustedTuiNow()) return undefined;
      const frozen = freezeSessionOperation(operation);
      if (frozen === undefined || frozen.op !== "create" || frozen.authority !== "user") return undefined;
      const grant = Object.freeze({}) as SessionCommandGrant;
      grants.set(grant, { operation: frozen, owner: { ...owner } });
      return grant;
    },
    check(grant, operation, owner) {
      const stored = grants.get(grant);
      return (
        trustedTuiNow() &&
        stored !== undefined &&
        sameSessionOwner(stored.owner, owner) &&
        sameSessionOperation(stored.operation, operation)
      );
    },
    consume(grant) {
      return grants.delete(grant);
    },
    revoke(grant) {
      grants.delete(grant);
    },
  };
}
export interface SessionCommandTarget {
  enqueueCommand(request: SessionMemoryWrite, grant: SessionCommandGrant): Promise<ScopedMemoryWriteResult>;
}
export function createSessionMemoryCommand(deps: {
  readonly registry: SessionCommandRegistry;
  readonly currentOwner: () => MemoryOwner;
  readonly store: SessionCommandTarget;
}) {
  return {
    async add(text: string): Promise<ScopedMemoryWriteResult> {
      let grant: SessionCommandGrant | undefined;
      try {
        const owner = deps.currentOwner();
        const operation: SessionOp = Object.freeze({ storageScope: "session", op: "create", text, authority: "user" });
        grant = deps.registry.issue(operation, owner);
        if (grant === undefined) return { ok: false, code: "E_AUTHORITY" };
        return await deps.store.enqueueCommand({ operation, owner }, grant);
      } catch {
        return { ok: false, code: "E_WRITE_GATE" };
      } finally {
        try {
          if (grant !== undefined) deps.registry.revoke(grant);
        } catch {
          /* cleanup must not reject the command Promise */
        }
      }
    },
  };
}
