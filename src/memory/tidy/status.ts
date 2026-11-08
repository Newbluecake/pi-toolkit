/** Context-free tidy status. Never creates directories, acquires a lease or recovers a run. */
import { listDirNames, openRunDirs, readRegular } from "../safe-fs.js";
import { leaseRead } from "./lease.js";
import { parseManifestStrict, readManifestV2 } from "./manifest.js";

export function statusText(dir: string): string {
  const lease = leaseRead(dir);
  const leaseLine = lease
    ? `lease: pid ${lease.payload.pid} on ${lease.payload.host} since ${new Date(lease.payload.at).toISOString()}${lease.payload.draining.length ? ` draining ${lease.payload.draining.join(",")}` : ""}`
    : "lease: free";
  // Read-only: a stale or foreign directory lock blocks every memory write, so --status shows its
  // holder too (only `/mem tidy --break-lock` may clear it, M-T4).
  const lockHolder = lockReadText(dir);
  const rows: string[] = [lockHolder === "none" ? "lock: free" : `lock: ${lockHolder}`, leaseLine];
  const invalid: { id: string; reason: string }[] = [];
  for (const id of listDirNames(`${dir}/.backup`)) {
    let dirs;
    try {
      dirs = openRunDirs(dir, id, { createArchive: false, createBackup: false });
    } catch {
      continue;
    }
    const raw = (() => {
      try {
        return JSON.parse(readRegular(dirs.backup.path, "manifest.json").text) as unknown;
      } catch {
        return undefined;
      }
    })();
    const manifest = readManifestV2(dirs, id);
    if (!manifest) {
      try {
        parseManifestStrict(raw, id);
      } catch (err) {
        invalid.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    const run = manifest.events
      .slice()
      .reverse()
      .find((e) => e.ev === "run");
    if (run?.ev === "run") rows.push(`run ${id}: ${run.state}`);
  }
  if (invalid.length)
    rows.push(`invalid manifest: ${invalid.map((entry) => `${entry.id} (${entry.reason})`).join(", ")}`);
  return rows.join("\n");
}

export function lockReadText(dir: string): string {
  let raw: string;
  try {
    raw = readRegular(dir, ".lock").text;
  } catch {
    return "none";
  }
  try {
    const p = JSON.parse(raw) as { pid?: number; host?: string; at?: number };
    return p.pid && p.host
      ? `pid ${p.pid} on ${p.host} since ${p.at ? new Date(p.at).toISOString() : "unknown"}`
      : "unknown owner";
  } catch {
    return "unknown owner";
  }
}
