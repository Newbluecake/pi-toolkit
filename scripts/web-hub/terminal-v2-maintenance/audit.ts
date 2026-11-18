/** Tool-only trusted in-process adapter. NEVER import from production.
 * A JSON file, hash, proofId or operator boolean cannot implement this trust boundary.
 * The adapter must hold the real deployment singleton and prevent publishers for the
 * entire lease. It neither requests shutdown nor kills anything: drain is pre-existing.
 */
export type MaintenanceOperation = "fresh" | "checkpoint" | "rollback";
export interface ComponentVersion {
  sourceCommit: string;
  build: string;
  artifactSha256: string;
}
export interface LegacyDrainEvidence {
  resources: 0;
  receipts: 0;
  active: 0;
  starting: 0;
  pendingSpawn: 0;
  authority: "revoked" | "safe-old-boot-completed";
  durableRevision: number;
  /** Correlation with original physical proof + resolve/prune + exact ACK evidence.
   * This digest is NOT a substitute for the adapter checking those physical facts. */
  physicalProofPruneAckSha256: string;
}
export interface NewDrainEvidence {
  allocations: 0;
  backend: 0;
  pendingSpawn: 0;
  dispose: "clean";
  durableRevision: number;
  physicalProofPruneSha256: string;
}
interface CommonEvidence {
  stateIdentity: { dev: number; ino: number };
  generation: string;
  proofId: string;
  publisherFence: { state: "disabled"; generation: string; evidenceSha256: string };
  newVersion: ComponentVersion;
}
export type MaintenanceEvidence = CommonEvidence &
  (
    | { kind: "fresh"; history: { state: "never-initialized"; evidenceSha256: string } }
    | { kind: "checkpoint"; oldVersion: ComponentVersion; legacy: LegacyDrainEvidence }
    | { kind: "rollback"; oldVersion: ComponentVersion; legacy: LegacyDrainEvidence; next: NewDrainEvidence }
  );
export interface MaintenanceLease {
  /** Observe real components/OS/version/deployment state, not externally supplied JSON.
   * Snapshot must be recursively immutable and registered to this lease by object
   * identity. Neither matching proofId nor matching generation substitutes for it. */
  observe(): Promise<MaintenanceEvidence>;
  /** Bounded actual fs/proc/component revalidation. Reject on any changed/unknown fact.
   * Must reject snapshots not originally produced by THIS lease. No drain or repair. */
  revalidate(snapshot: MaintenanceEvidence): Promise<void>;
  /** Synchronous, NO IO. Exact live owner identity + per-lease released flag,
   * private snapshot identity, generation, invalidation/abort and absolute deadline.
   * Released leases never revive when a successor has the same generation. */
  current(snapshot: MaintenanceEvidence): boolean;
  /** Tool-only final synchronous READ-ONLY filesystem fence, separate from the
   * NO-IO memory current() above. Real controlled adapter verifies original state,
   * deployment lock, singleton socket/dir immediately at each publication guard.
   * No await, mutation, drain, repair or capability minting. */
  guardOwnership?(snapshot: MaintenanceEvidence): void;
  /** Idempotent per lease. A stale release must never unlock a successor owner. */
  release(): Promise<void>;
}
export interface MaintenanceAuditPort {
  acquire(input: {
    stateDir: string;
    operation: MaintenanceOperation;
    signal: AbortSignal;
    deadline: number;
  }): Promise<MaintenanceLease>;
}
export interface MaintenanceOptions {
  /** Explicit existing owned0700 physical directories; never inferred from HOME/env. */
  stateDir: string;
  evidenceDir: string;
  audit: MaintenanceAuditPort;
  signal?: AbortSignal;
  /** Logical bound, <= 30s. Kernel fsync is not interruptible. */
  timeoutMs?: number;
}
/** Internal DI only, never CLI/env/settings. Models failures at real syscall boundaries. */
export interface MaintenanceTestHooks {
  before?(stage: "evidence-write" | "evidence-sync" | "state-write" | "state-sync" | "complete-write"): void;
}
export class MaintenanceError extends Error {
  constructor(
    readonly code: string,
    readonly effect: "none" | "unknown" = "none",
  ) {
    super(`terminal maintenance: ${code}`);
  }
}
export function fail(code: string): never {
  throw new MaintenanceError(code);
}
