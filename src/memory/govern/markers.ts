/** Sole owner of blocks/.jev/governance-markers.json (#36 §5).
 * No model/UI promises under the directory lock. Invalid derived data is
 * NOT an empty store: refuse writes until the user repairs/removes it. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import { readMarker } from "../blocks/marker.js";
import { dirFormat } from "../blocks/naming.js";
import {
  JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER as REVIEW,
  JEV_GOVERNANCE_RELOAD_REMINDER_MARKER as RELOAD,
} from "../jev/contracts.js";
import { withMemoryDirLock } from "../lock.js";
import { MemoryError } from "../paths.js";
import {
  canonicalDir,
  ensurePrivateDir,
  inspectDirNoFollow,
  readRegularHead,
  replaceAtomic,
  statRegularIfExists,
  unlinkRegular,
  writeTempRegular,
} from "../safe-fs.js";

const FILE = "governance-markers.json";
const MAX_BYTES = 64 * 1024;
// Same migration id shape as blocks/migrate.ts (newMemoryId), not a guessed generation.
const MIGRATION_ID = /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}$/;
const RELOAD_TEXT = "memory: migrated block memory — /reload to refresh memory";

export interface MigrationIdentity {
  readonly gen: number;
  readonly runId: string;
}
export interface FirstUserReviewMarker {
  readonly completedAt: string;
  readonly corpusFp: string;
  readonly policy: "bounded-neighbours-v1";
  readonly eligibleUsers: number;
  readonly selectedUsers: number;
  readonly reviewedPairs: number;
}
export interface GovernanceMarkersV1 {
  readonly v: 1;
  readonly migration: MigrationIdentity;
  readonly markers: {
    readonly [REVIEW]?: FirstUserReviewMarker;
    readonly [RELOAD]?: { readonly deliveredAt: string };
  };
}
export interface GovernanceMarkersSnapshot {
  readonly state: "current" | "missing" | "different-generation";
  readonly realDir: string;
  readonly directoryKey: string;
  readonly migration: MigrationIdentity;
  /** Raw file revision; null only for physical absence. Includes file identity. */
  readonly revision: string | null;
  /** Only current-generation markers; a valid older generation yields {}. */
  readonly markers: GovernanceMarkersV1["markers"];
}
export type GovernanceMarkersRead =
  GovernanceMarkersSnapshot | { readonly state: "invalid" | "unavailable"; readonly reason: string };
export interface GovernanceMarkersOptions {
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  /** Host-owned session/activation epoch. Rechecked at every commit boundary. */
  isCurrent?: () => boolean;
  now?: () => Date;
  /** At most one invalid-data diagnostic per owner; never includes file contents. */
  diag?: (message: string) => void;
}
export type GovernanceMarkerResult = {
  status: "written" | "delivered" | "already-delivered" | "skipped" | "rejected";
  reason?: string;
};

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).every((key) => allowed.includes(key));
}
function count(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function iso(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
function migration(v: unknown): v is MigrationIdentity {
  return (
    object(v) && keys(v, ["gen", "runId"]) && count(v.gen) && typeof v.runId === "string" && MIGRATION_ID.test(v.runId)
  );
}
function review(v: unknown): v is FirstUserReviewMarker {
  return (
    object(v) &&
    keys(v, ["completedAt", "corpusFp", "policy", "eligibleUsers", "selectedUsers", "reviewedPairs"]) &&
    iso(v.completedAt) &&
    typeof v.corpusFp === "string" &&
    v.corpusFp.length > 0 &&
    v.policy === "bounded-neighbours-v1" &&
    count(v.eligibleUsers) &&
    count(v.selectedUsers) &&
    count(v.reviewedPairs) &&
    v.selectedUsers <= 32 &&
    v.selectedUsers <= v.eligibleUsers &&
    v.reviewedPairs <= 64 &&
    v.reviewedPairs <= (v.selectedUsers * (v.selectedUsers - 1)) / 2
  );
}
function valid(v: unknown): v is GovernanceMarkersV1 {
  if (
    !object(v) ||
    !keys(v, ["v", "migration", "markers"]) ||
    v.v !== 1 ||
    !migration(v.migration) ||
    !object(v.markers) ||
    !keys(v.markers, [REVIEW, RELOAD])
  )
    return false;
  if (REVIEW in v.markers && !review(v.markers[REVIEW])) return false;
  const reload = v.markers[RELOAD];
  return !(RELOAD in v.markers) || (object(reload) && keys(reload, ["deliveredAt"]) && iso(reload.deliveredAt));
}
function sameMigration(a: MigrationIdentity, b: MigrationIdentity): boolean {
  return a.gen === b.gen && a.runId === b.runId;
}
function ready(r: GovernanceMarkersRead): r is GovernanceMarkersSnapshot {
  return r.state === "current" || r.state === "missing" || r.state === "different-generation";
}

export function createGovernanceMarkers(memDir: string, opts: GovernanceMarkersOptions = {}) {
  let reported = false;
  function invalid(): GovernanceMarkersRead {
    if (!reported) {
      reported = true;
      try {
        opts.diag?.(
          "memory: invalid governance markers; repair/remove blocks/.jev/governance-markers.json before retrying",
        );
      } catch {
        /* diagnostics are not delivery */
      }
    }
    return { state: "invalid", reason: "E_GOVERNANCE_MARKERS_INVALID" };
  }
  function check(): void {
    if (opts.signal?.aborted || opts.isCurrent?.() === false) throw new MemoryError("E_ABORTED");
    if (opts.gate && !opts.gate.check(memDir).ok) throw new MemoryError("E_WRITE_GATE");
    // A gate callback can revoke the owner too.
    if (opts.signal?.aborted || opts.isCurrent?.() === false) throw new MemoryError("E_ABORTED");
  }
  function read(): GovernanceMarkersRead {
    try {
      check();
      const canonical = canonicalDir(memDir);
      if (!canonical || dirFormat(canonical.real) !== "blocks") return { state: "unavailable", reason: "E_UNMIGRATED" };
      const parent = inspectDirNoFollow(canonical.real);
      const blocks = inspectDirNoFollow(join(canonical.real, "blocks"));
      const layout = readMarker(join(canonical.real, "blocks"));
      if (layout?.source === "fresh") return { state: "unavailable", reason: "E_NOT_MIGRATED" };
      const identity = { gen: layout?.gen, runId: layout?.runId };
      if (layout?.source !== "migrate" || !migration(identity)) {
        if (!reported) {
          reported = true;
          try {
            opts.diag?.("memory: migration identity unavailable; reload reminder deferred");
          } catch {
            /* diagnostic */
          }
        }
        return { state: "unavailable", reason: "E_MIGRATION_IDENTITY" };
      }
      const base = {
        realDir: canonical.real,
        directoryKey: JSON.stringify([canonical.real, parent.dev, parent.ino, blocks.dev, blocks.ino]),
        migration: identity,
      };
      // Inspect the derived directory BEFORE opening its child; never follow a .jev symlink.
      try {
        const sidecar = join(canonical.real, "blocks", ".jev");
        if (!blocks.names.includes(".jev")) return { ...base, state: "missing", revision: null, markers: {} };
        if (inspectDirNoFollow(sidecar).dev !== blocks.dev) return invalid();
        const stat = statRegularIfExists(sidecar, FILE);
        if (!stat) return { ...base, state: "missing", revision: null, markers: {} };
        if (stat.size > MAX_BYTES) return invalid();
        const raw = readRegularHead(sidecar, FILE, MAX_BYTES + 1);
        // A short head read is not proof of a complete JSON document (nor is
        // replacement-character decoding of invalid UTF-8). Never accept its prefix.
        if (raw.stat.size > MAX_BYTES || Buffer.byteLength(raw.text) !== raw.stat.size) return invalid();
        const data: unknown = JSON.parse(raw.text);
        if (!valid(data)) return invalid();
        const revision = createHash("sha256")
          .update(JSON.stringify([raw.stat, raw.text]))
          .digest("hex");
        return {
          ...base,
          revision,
          state: sameMigration(identity, data.migration) ? "current" : "different-generation",
          markers: sameMigration(identity, data.migration) ? data.markers : {},
        };
      } catch {
        return invalid();
      }
    } catch (e) {
      return { state: "unavailable", reason: (e as Error).message };
    }
  }
  function latest(expected: GovernanceMarkersSnapshot): GovernanceMarkersSnapshot {
    const live = read();
    if (!ready(live)) throw new MemoryError(live.reason);
    if (
      live.directoryKey !== expected.directoryKey ||
      !sameMigration(live.migration, expected.migration) ||
      live.revision !== expected.revision
    )
      throw new MemoryError("E_CONFLICT");
    return live;
  }
  /** The caller holds the same directory lock used by migration, review and sweep. */
  function persist(expected: GovernanceMarkersSnapshot, markers: GovernanceMarkersV1["markers"]): void {
    const data: GovernanceMarkersV1 = { v: 1, migration: expected.migration, markers };
    const bytes = Buffer.from(JSON.stringify(data));
    if (!valid(data) || bytes.length > MAX_BYTES) throw new MemoryError("E_GOVERNANCE_MARKER_VALUE");
    const dir = join(expected.realDir, "blocks", ".jev");
    latest(expected); // gate first, then verify parents immediately before mkdir
    ensurePrivateDir(dir); // parent blocks was checked above; never bootstrap memory/blocks.
    const identity = inspectDirNoFollow(dir);
    let tmp: string | undefined;
    try {
      latest(expected);
      tmp = writeTempRegular(dir, FILE, bytes, 0o600);
      latest(expected); // gate + raw revision CAS immediately before atomic replacement
      const after = inspectDirNoFollow(dir);
      if (after.dev !== identity.dev || after.ino !== identity.ino) throw new MemoryError("E_CONFLICT");
      replaceAtomic(dir, tmp, FILE);
      tmp = undefined;
      // No post-commit abort rollback: the marker is already durable.
    } finally {
      if (tmp !== undefined) {
        try {
          const after = inspectDirNoFollow(dir);
          if (after.dev === identity.dev && after.ino === identity.ino) unlinkRegular(dir, tmp);
        } catch {
          /* never clean up through a changed directory */
        }
      }
    }
  }
  async function writeFirstUserReview(
    expected: GovernanceMarkersSnapshot,
    marker: FirstUserReviewMarker,
  ): Promise<GovernanceMarkerResult> {
    try {
      check();
      return await withMemoryDirLock(
        expected.realDir,
        () => {
          const live = latest(expected);
          persist(live, { ...live.markers, [REVIEW]: marker });
          return { status: "written" };
        },
        { timeoutMs: 500 },
      );
    } catch (e) {
      return { status: "rejected", reason: (e as Error).message };
    }
  }
  async function deliverReloadReminder(notify?: (message: string) => void): Promise<GovernanceMarkerResult> {
    if (!notify) return { status: "skipped", reason: "no-ui" };
    const expected = read();
    if (!ready(expected)) return { status: "skipped", reason: expected.reason };
    try {
      return await withMemoryDirLock(
        expected.realDir,
        () => {
          // Startup callers may race normally: re-read under lock rather than reject
          // the second caller's old revision. The directory/migration MUST still match.
          const live = read();
          if (!ready(live)) throw new MemoryError(live.reason);
          if (live.directoryKey !== expected.directoryKey || !sameMigration(live.migration, expected.migration))
            throw new MemoryError("E_CONFLICT");
          if (live.markers[RELOAD]) return { status: "already-delivered" };
          check();
          const returned: unknown = notify(RELOAD_TEXT);
          if (
            returned &&
            (typeof returned === "object" || typeof returned === "function") &&
            typeof (returned as { then?: unknown }).then === "function"
          ) {
            // A miswired async port is not synchronous delivery evidence; never await it in the lock.
            void Promise.resolve(returned).catch(() => {});
            throw new MemoryError("E_NOTIFY_ASYNC");
          }
          check(); // notify may synchronously cancel/switch owner; do NOT consume it.
          persist(live, { ...live.markers, [RELOAD]: { deliveredAt: (opts.now?.() ?? new Date()).toISOString() } });
          return { status: "delivered" };
        },
        { timeoutMs: 500 },
      );
    } catch (e) {
      return { status: "rejected", reason: (e as Error).message };
    }
  }
  return { read, writeFirstUserReview, deliverReloadReminder };
}
