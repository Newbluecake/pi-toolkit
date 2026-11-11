/**
 * #39 P1 private OpCap registry + HumanTurnTracker (arch §5.1/§5.2, plan §3.3).
 *
 * The capability is an OPAQUE HOST OBJECT: it exists only inside activation closures, is
 * minted exclusively by authorize.ts AFTER a human exact-content affirmation, and can never
 * be produced from a tool argument, a string literal (`authority:"user"` grants nothing),
 * a wire frame or a journal entry. `PrivateOpCap` values cannot be constructed outside this
 * module (brand symbol is not exported).
 *
 * Lifecycle: minted → reserved → consumed (one-shot), or → revoked from any state.
 * Every recheck point (dequeue, last-await, commit gate) calls `check`/`consume` with the
 * CURRENT owner: reference-identity incarnation, sid, sessionEpoch and branchGen must all
 * still match, and the human turn must still be the tracker's current turn.
 *
 * Audit lines are generated ONLY from cap fields — a model-declared field never reaches them.
 *
 * Pi-free; all state lives in the factory closure (I4 — nothing at module scope, caps do not
 * survive /reload, which is supposed to revoke them anyway).
 */
import { randomBytes } from "node:crypto";
import type {
  FrozenScopedOp,
  HumanTurn,
  MemoryApprovalBinding,
  MemoryOpCapPort,
  MemoryOwner,
  PrivateOpCap,
  ReservedMemoryOperation,
} from "./types.js";

interface CapRecord {
  readonly capId: string;
  readonly operation: FrozenScopedOp;
  readonly binding: MemoryApprovalBinding;
  readonly channel: "tui" | "web";
  readonly who?: string;
  readonly project: string;
  state: "minted" | "reserved" | "consumed" | "revoked";
}

export interface OpCapAuditLine {
  readonly at: string;
  readonly op: string;
  readonly id: string;
  readonly rev: string;
  readonly via: "dialog";
  readonly channel: "tui" | "web";
  readonly who?: string;
  readonly by: "agent";
  readonly turn: string;
  readonly cap: string;
  readonly project: string;
  readonly sid8: string;
}

export interface MemoryOpCapRegistry extends MemoryOpCapPort {
  /** Host-only mint (authorize.ts). Binding fields are validated; a turn check is the caller's. */
  mint(input: {
    readonly operation: FrozenScopedOp;
    readonly binding: MemoryApprovalBinding;
    readonly channel: "tui" | "web";
    readonly project: string;
    readonly who?: string;
  }): PrivateOpCap;
  /** Audit view derived ONLY from cap fields; undefined for unknown/foreign objects. */
  auditOf(cap: PrivateOpCap, at: string): OpCapAuditLine | undefined;
  stateOf(cap: PrivateOpCap): "minted" | "reserved" | "consumed" | "revoked" | "unknown";
}

const sameOwner = (a: MemoryOwner, b: MemoryOwner): boolean =>
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen;

const isHex64 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function createMemoryOpCapRegistry(turnOf?: () => HumanTurn | undefined): MemoryOpCapRegistry {
  const caps = new Map<PrivateOpCap, CapRecord>();
  const registry: MemoryOpCapRegistry = {
    mint(input) {
      if (input.channel !== "tui" && input.channel !== "web") throw new Error("invalid channel");
      if (!isHex64(input.binding.opDigest) || !isHex64(input.binding.textDigest))
        throw new Error("invalid binding digest");
      if (typeof input.binding.nonce !== "string" || input.binding.nonce.length < 16)
        throw new Error("invalid binding nonce");
      // The cap object itself carries NOTHING readable: its identity is the Map key inside
      // this closure. The PrivateOpCap brand lives only in types.ts, so no other module can
      // construct a value the registry would accept.
      const cap = Object.freeze({}) as PrivateOpCap;
      const record: CapRecord = {
        capId: randomBytes(16).toString("hex"),
        operation: input.operation,
        binding: input.binding,
        channel: input.channel,
        project: input.project,
        ...(input.who !== undefined ? { who: input.who } : {}),
        state: "minted",
      };
      Object.freeze(record.operation);
      Object.freeze(record.binding);
      caps.set(cap, record);
      return cap;
    },
    reserve(cap, owner) {
      const record = caps.get(cap);
      if (record === undefined || (record.state !== "minted" && record.state !== "reserved")) return undefined;
      if (!sameOwner(record.binding.owner, owner)) return undefined;
      const turn = turnOf?.();
      if (turn === undefined || turn.id !== record.binding.humanTurn.id) return undefined;
      record.state = "reserved";
      return reservedOf(record);
    },
    check(cap, owner) {
      const record = caps.get(cap);
      if (record === undefined || (record.state !== "reserved" && record.state !== "minted")) return undefined;
      if (!sameOwner(record.binding.owner, owner)) return undefined;
      const turn = turnOf?.();
      if (turn === undefined || turn.id !== record.binding.humanTurn.id) return undefined;
      return reservedOf(record);
    },
    consume(cap) {
      const record = caps.get(cap);
      if (record === undefined || record.state !== "reserved") return false;
      record.state = "consumed";
      caps.delete(cap);
      return true;
    },
    revoke(cap) {
      if (cap === undefined) {
        for (const record of caps.values()) record.state = "revoked";
        return;
      }
      const record = caps.get(cap);
      if (record !== undefined) record.state = "revoked";
    },
    auditOf(cap, at) {
      const record = caps.get(cap);
      if (record === undefined) return undefined;
      const operation = record.operation as unknown as Record<string, unknown>;
      return {
        at,
        op: String(operation.op ?? ""),
        id: String(operation.targetId ?? ""),
        rev: String(operation.expectRev ?? ""),
        via: "dialog",
        channel: record.channel,
        ...(record.who !== undefined ? { who: record.who } : {}),
        by: "agent",
        turn: record.binding.humanTurn.id.slice(0, 8),
        cap: record.capId.slice(0, 8),
        project: record.project,
        sid8: record.binding.owner.sid.slice(0, 8),
      };
    },
    stateOf(cap) {
      return caps.get(cap)?.state ?? "unknown";
    },
  };
  return registry;
}

const reservedOf = (record: CapRecord): ReservedMemoryOperation => ({
  operation: record.operation,
  binding: record.binding,
  capId: record.capId,
  channel: record.channel,
  ...(record.who !== undefined ? { who: record.who } : {}),
});

// ───────────────────────── HumanTurnTracker (arch §5.1) ─────────────────────────

export type HumanTurnEvent =
  "input" | "session" | "tree" | "abort" | "reload" | "handled" | "dispatch-error" | "shutdown";

export interface HumanTurnTracker {
  /** Current proven human turn, or undefined when no proven turn is live. */
  current(): HumanTurn | undefined;
  /** TUI `interactive` input in a TUI-mode session: a fresh human turn. */
  noteInteractive(owner: MemoryOwner): HumanTurn;
  /** Proven web dispatch turn (requires the P3 proof port upstream; here just host-fed). */
  noteWebTurn(owner: MemoryOwner): HumanTurn;
  /** rpc/feishu/xs/wake/schedule or any unprovable source: clear the turn. */
  noteNonHuman(): void;
  /** agent_end / session_start(any) / tree / shutdown / reload / abort: revoke turn + caps. */
  invalidate(reason: HumanTurnEvent): void;
  /** Dialog bookkeeping for the rate gate (max 3 per turn) and the one-rejection rule. */
  noteDialog(): void;
  dialogsThisTurn(): number;
  markRejected(): void;
  rejected(): boolean;
}

export const HUMAN_TURN_MAX_DIALOGS = 3;

export function createHumanTurnTracker(onTurnInvalidated?: () => void): HumanTurnTracker {
  let turn: HumanTurn | undefined;
  let dialogs = 0;
  let rejected = false;
  const clear = (): void => {
    turn = undefined;
    dialogs = 0;
    rejected = false;
  };
  const newTurn = (owner: MemoryOwner, channel: "tui" | "web"): HumanTurn => {
    const next: HumanTurn = { id: randomBytes(16).toString("hex"), channel, owner };
    turn = next;
    dialogs = 0;
    rejected = false;
    onTurnInvalidated?.();
    return next;
  };
  return {
    current: () => turn,
    noteInteractive: (owner) => newTurn(owner, "tui"),
    noteWebTurn: (owner) => newTurn(owner, "web"),
    noteNonHuman: () => {
      if (turn !== undefined) {
        clear();
        onTurnInvalidated?.();
      }
    },
    invalidate: () => {
      if (turn !== undefined) clear();
      onTurnInvalidated?.();
    },
    noteDialog: () => {
      dialogs++;
    },
    dialogsThisTurn: () => dialogs,
    markRejected: () => {
      rejected = true;
    },
    rejected: () => rejected,
  };
}
