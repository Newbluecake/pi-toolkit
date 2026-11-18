/** Controlled component double + private real files. NOT real O/N shell drain. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
const ownedRoots = new Map<string, { dev: number; ino: number }>();
afterEach(() => {
  for (const [path, identity] of ownedRoots) {
    const current = lstatSync(path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error("test scratch directory replaced; refusing cleanup");
    rmSync(path, { recursive: true });
    ownedRoots.delete(path);
  }
});
function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}
import {
  MaintenanceError,
  type MaintenanceAuditPort,
  type MaintenanceEvidence,
  type MaintenanceOptions,
  type MaintenanceOperation,
} from "../../scripts/web-hub/terminal-v2-maintenance/audit.js";
import { OLD_SOURCE } from "../../scripts/web-hub/terminal-v2-maintenance/legacy-reader.js";
export const hash = "a".repeat(64);
export function put(path: string, value: unknown) {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
}
export function setup() {
  // Respect the caller's private TMPDIR. Cleanup only exact roots created here;
  // production tools still never garbage-collect maintenance evidence.
  const base = mkdtempSync(join(tmpdir(), "pi-t51p5r-"));
  const identity = lstatSync(base);
  ownedRoots.set(base, { dev: identity.dev, ino: identity.ino });
  const stateDir = join(base, "state"),
    evidenceDir = join(base, "evidence");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(evidenceDir, { mode: 0o700 });
  const audit = new ControlledAudit(stateDir);
  const options: MaintenanceOptions = { stateDir, evidenceDir, audit };
  return { base, stateDir, evidenceDir, audit, options };
}
export function legacyLayout(stateDir: string, revision = 7) {
  const root = join(stateDir, "terminal-v1");
  for (const path of [root, join(root, "authority"), join(root, "receipts")]) mkdirSync(path, { mode: 0o700 });
  const marker = { v: 1, storeId: "L".repeat(32) };
  put(join(root, "initialized"), marker);
  put(join(stateDir, ".terminal-initialized-v1"), marker);
  put(join(root, "terminal-resource-fence-v1.json"), { v: 1, revision, resources: [] });
}
export function tree(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      const target = join(dir, name),
        st = lstatSync(target),
        key = `${relative}${name}`;
      if (st.isDirectory()) {
        result[key + "/"] = `${st.ino}:${st.mode & 0o777}`;
        walk(target, key + "/");
      } else if (st.isSymbolicLink()) result[key] = `symlink:${st.ino}`;
      else result[key] = `${st.ino}:${st.mode & 0o777}:${readFileSync(target).toString("base64")}`;
    }
  };
  walk(path, "");
  return result;
}
/** Stateful trusted-port double. Identity, invalidation and singleton tests are real
 * component behavior; all physical-drain observations here are explicitly simulated. */
export class ControlledAudit implements MaintenanceAuditPort {
  private owner: object | undefined;
  get locked() {
    return this.owner !== undefined;
  }
  generation = 1;
  publisher = false;
  active = 0;
  pending = 0;
  revision = 7;
  nextRevision = 0;
  releaseCount = 0;
  observations = 0;
  validations = 0;
  oldSource = OLD_SOURCE;
  newSource = "b".repeat(40);
  onObserve?: () => void;
  onRevalidate?: () => void;
  constructor(readonly stateDir: string) {}
  async acquire(input: { stateDir: string; operation: MaintenanceOperation; signal: AbortSignal; deadline: number }) {
    if (this.locked || input.stateDir !== this.stateDir) throw new MaintenanceError("singleton-busy");
    const owner = {};
    this.owner = owner;
    let released = false;
    const generation = this.generation,
      snapshots = new WeakSet<object>();
    const current = (snapshot: MaintenanceEvidence) =>
      !released &&
      this.owner === owner &&
      this.generation === generation &&
      snapshots.has(snapshot) &&
      !input.signal.aborted &&
      Date.now() < input.deadline;
    const check = () => {
      if (this.publisher) throw new MaintenanceError("old-publisher-active");
      if (this.active || this.pending) throw new MaintenanceError("component-not-drained");
    };
    return {
      observe: async (): Promise<MaintenanceEvidence> => {
        if (
          released ||
          this.owner !== owner ||
          this.generation !== generation ||
          input.signal.aborted ||
          Date.now() >= input.deadline
        )
          throw new MaintenanceError("snapshot-not-current");
        check();
        this.onObserve?.();
        this.observations++;
        const st = lstatSync(this.stateDir);
        const common = {
          stateIdentity: { dev: st.dev, ino: st.ino },
          generation: String(generation),
          proofId: "controlled-only",
          publisherFence: { state: "disabled" as const, generation: String(generation), evidenceSha256: hash },
          newVersion: { sourceCommit: this.newSource, build: "controlled-N", artifactSha256: hash },
        };
        const old = { sourceCommit: this.oldSource, build: "controlled-O", artifactSha256: hash };
        const legacy = {
          resources: 0 as const,
          receipts: 0 as const,
          active: 0 as const,
          starting: 0 as const,
          pendingSpawn: 0 as const,
          authority: "revoked" as const,
          durableRevision: this.revision,
          physicalProofPruneAckSha256: hash,
        };
        const snapshot: MaintenanceEvidence =
          input.operation === "fresh"
            ? { ...common, kind: "fresh", history: { state: "never-initialized", evidenceSha256: hash } }
            : input.operation === "checkpoint"
              ? { ...common, kind: "checkpoint", oldVersion: old, legacy }
              : {
                  ...common,
                  kind: "rollback",
                  oldVersion: old,
                  legacy,
                  next: {
                    allocations: 0,
                    backend: 0,
                    pendingSpawn: 0,
                    dispose: "clean",
                    durableRevision: this.nextRevision,
                    physicalProofPruneSha256: hash,
                  },
                };
        snapshots.add(snapshot);
        return deepFreeze(snapshot);
      },
      current,
      revalidate: async (snapshot: MaintenanceEvidence) => {
        if (!current(snapshot)) throw new MaintenanceError("snapshot-not-current");
        this.validations++;
        this.onRevalidate?.();
        check();
        if (!current(snapshot)) throw new MaintenanceError("snapshot-not-current");
      },
      release: async () => {
        if (released) return;
        released = true;
        if (this.owner === owner) this.owner = undefined;
        this.releaseCount++;
      },
    };
  }
}
