/**
 * `hub.json` writer (plan §1.4.2): the single write path for the file — no
 * other module may write it. Holds the current record in memory (never reads
 * it back off disk); `patchLan` merges a `LanStatus` update into that record
 * and re-writes, except before the first `write()` (nothing on disk yet),
 * where it queues the update as `pendingLan` — review fix #8: an `onStatus`
 * callback firing from inside `lanAssembly.build()` (which resolves *before*
 * `hub.ts`'s own `write()` call at step ⑦) must not be silently dropped; the
 * queued value is merged into (and takes priority over) whatever `lan`
 * `write()`'s own record carries, then cleared. After `removeIfOurs()` the
 * writer is sealed (review fix #8): `write`/`patchLan` become permanent
 * no-ops so a stray, already-in-flight `onStatus`/patch callback (e.g. from
 * the fire-and-forget `fe.lan.start().then(...)` chain in `hub.ts`) can never
 * resurrect a hub.json that close() already tore down. `write`/`removeIfOurs`
 * stay synchronous — this is P1's existing `writeHubJson` /
 * `removeHubJsonIfOurs` behavior verbatim (small file, tmp+rename), carried
 * over unconverted per plan §3.1's zero-hang accounting (residual noted in
 * plan §13, not in W1's scope to fix).
 */
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { LanStatus } from "../protocol/lan.js";
import type { HubLog } from "./ports.js";
import type { PROTO } from "../protocol/version.js";

export interface HubRecord {
  pid: number;
  nonce: string;
  version: string;
  buildId: string;
  proto: typeof PROTO;
  socket: string;
  port: number;
  startedAt: number;
  procStartTicks?: number;
  argv?: string[];
  lan?: LanStatus;
}

export interface HubJsonWriter {
  /** Full write (tmp + rename, mode 0600). Failures are only logged. No-op once sealed. */
  write(record: HubRecord): void;
  /** Merge `lan` into the current in-memory record, then `write()` it — or, before the first
   * `write()`, queue it as `pendingLan` so the eventual `write()` picks it up (and it takes
   * priority over whatever `lan` that `write()` call's own record carries). No-op once sealed. */
  patchLan(lan: LanStatus): void;
  /** The record last passed to `write()`/`patchLan()`, if any (never re-read from disk). */
  current(): HubRecord | undefined;
  /** Delete the file iff its `pid` still matches this process, then seal the writer. */
  removeIfOurs(): void;
}

export function createHubJsonWriter(file: string, log: HubLog): HubJsonWriter {
  let record: HubRecord | undefined;
  let everWritten = false;
  let pendingLan: LanStatus | undefined;
  let sealed = false;

  function write(next: HubRecord): void {
    if (sealed) return;
    record = pendingLan !== undefined ? { ...next, lan: pendingLan } : next;
    pendingLan = undefined;
    everWritten = true;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      log.error("web-hub: hub.json write failed", { error: String(err) });
    }
  }

  function patchLan(lan: LanStatus): void {
    if (sealed) return;
    if (record === undefined) {
      pendingLan = lan; // no base record yet — queue it for the eventual write()
      return;
    }
    write({ ...record, lan });
  }

  return {
    write,
    patchLan,
    current: () => record,
    removeIfOurs: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
        if (parsed.pid === process.pid) unlinkSync(file);
      } catch {
        // missing / foreign / corrupt: leave it
      } finally {
        sealed = true;
      }
    },
  };
}
