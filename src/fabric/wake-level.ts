import type { FabricRecord, MessageChannel, NodeRef } from "../core/message.js";
import type { RunId } from "../core/types.js";

/**
 * fabric-cross-session plan v3 §3.3 — CAUSAL LEVEL (W1).
 *
 * A level counts how many autonomous "wake" hops separate a node's current activity from the last proven human input.
 * It is host-owned (a model can never state or forge it): a run's value lives in the run's own diag (`diag.wakeLevel`,
 * moved only through the runner's `noteWakeLevel` ⇒ reducer input `wake_level`, monotonic max), the root's value is
 * persisted as a session entry so it survives `/reload` and a stack rebuild. Only PROVEN human input resets the root
 * (`resetRoot`); runs never reset.
 *
 * Rules implemented here (the numbers are the plan's L-numbers):
 *  - L2/L3 `onDelivered`: a delivery that STARTS A TURN (root context message with wake !== false — legacy or effective
 *    `wake:true`) raises the target to `L+1`; every other delivery (steer into a running run, root `wake:false`
 *    deliver-only, redirect) raises it to `L` ("carry without counting"). A root display-channel progress never reaches
 *    the root's model, so it raises nothing.
 *  - L3 seam B `onSteered`: `QueryService.steer` (steer_subagent tool, web steer op, @mention) raises the target to the
 *    caller's level (absent ⇒ the root's level; a human origin passes 0, which is a no-op).
 *  - L5 `hopAllowed`: a hop is effective only while `L+1 ≤ maxLevel`; otherwise the caller downgrades to deliver-only.
 *
 * Pure of pi: every side effect (run write-through, root persistence) is an injected port.
 */
export interface CausalLevelDeps {
  /** Max causal wake-chain depth (`fabric.wake.maxLevel`, Q9). */
  maxLevel: number;
  /** A run's CURRENT effective level (live runner state); `undefined` when the run is unknown to this stack. */
  runLevel(runId: RunId): number | undefined;
  /** Write-through to the run's diag (monotonic max inside the reducer). */
  raiseRun(runId: RunId, level: number): void;
  /** Root level restored from the session branch (0 when none). */
  initialRoot: number;
  /** Persist a changed root level (`subagent:wake-level` entry); failures are swallowed by the caller of this port. */
  persistRoot(level: number): void;
}

export interface CausalLevel {
  /** Level of a node as it would be stamped on an outgoing message / inherited by a spawn: run ⇒ diag value ?? 0; root ⇒ root level; system ⇒ 0. */
  levelOf(node: NodeRef): number;
  /** Current root level. */
  readonly root: number;
  /** L5: would a wake hop from a node at `level` stay within `maxLevel`? */
  hopAllowed(level: number): boolean;
  readonly maxLevel: number;
  /** Raise a node's level (monotonic max; the root change is persisted). */
  raise(node: NodeRef, level: number): void;
  /** Proven human input: root → 0 (persisted only when it actually changed). Runs never reset. */
  resetRoot(): void;
  /** Mailbox seam A: a fabric record was delivered. */
  onDelivered(record: FabricRecord, channel: MessageChannel): void;
  /** QueryService seam B: a steer landed on a running run. `originLevel` undefined ⇒ the root's current level. */
  onSteered(runId: RunId, originLevel: number | undefined): void;
}

const sane = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function createCausalLevel(deps: CausalLevelDeps): CausalLevel {
  let root = sane(deps.initialRoot);
  const maxLevel = sane(deps.maxLevel);
  const persist = (value: number): void => {
    try {
      deps.persistRoot(value);
    } catch {
      /* persistence is best-effort; the in-memory value stays authoritative for this stack */
    }
  };
  const level: CausalLevel = {
    levelOf(node) {
      if (node === "root") return root;
      if (node === "system") return 0;
      return sane(deps.runLevel(node) ?? 0);
    },
    get root() {
      return root;
    },
    maxLevel,
    hopAllowed: (l) => sane(l) + 1 <= maxLevel,
    raise(node, to) {
      const next = sane(to);
      if (node === "system") return;
      if (node === "root") {
        if (next <= root) return;
        root = next;
        persist(root);
        return;
      }
      try {
        deps.raiseRun(node, next);
      } catch {
        /* a run that vanished mid-propagation simply keeps its old level */
      }
    },
    resetRoot() {
      if (root === 0) return;
      root = 0;
      persist(0);
    },
    onDelivered(record, channel) {
      if (record.level === undefined) return;
      const base = sane(record.level);
      if (record.to === "root") {
        if (channel !== "context") return;
        // a root context message starts a turn unless the sender explicitly asked for deliver-only (wake:false)
        level.raise("root", record.wake === false ? base : base + 1);
        return;
      }
      level.raise(record.to, base);
    },
    onSteered(runId, originLevel) {
      level.raise(runId, originLevel === undefined ? root : originLevel);
    },
  };
  return level;
}

/** Name of the persisted root-level session entry (plan §3.3 L6). */
export const WAKE_LEVEL_CUSTOM_TYPE = "subagent:wake-level";

/**
 * Last `subagent:wake-level` value on the session branch, or 0. Tolerant of malformed entries (never throws): only a
 * finite non-negative `level` of a `v:1` entry counts.
 */
export function readRootLevel(branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "custom" || entry.customType !== WAKE_LEVEL_CUSTOM_TYPE) continue;
    const data = entry.data as { v?: unknown; level?: unknown } | undefined;
    if (data?.v === 1 && typeof data.level === "number" && Number.isFinite(data.level) && data.level >= 0)
      return Math.floor(data.level);
  }
  return 0;
}
