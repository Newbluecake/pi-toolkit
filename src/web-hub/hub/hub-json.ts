/**
 * `hub.json` writer (plan §1.4.2): the single write path for the file — no
 * other module may write it. Holds the current record in memory (never reads
 * it back off disk); `patchLan` merges a `LanStatus` update into that record
 * and re-writes, except before the first `write()` (nothing on disk yet),
 * where it only updates the in-memory record so a later `write()` picks it
 * up. `write`/`removeIfOurs` stay synchronous — this is P1's existing
 * `writeHubJson` / `removeHubJsonIfOurs` behavior verbatim (small file,
 * tmp+rename), carried over unconverted per plan §3.1's zero-hang accounting
 * (residual noted in plan §13, not in W1's scope to fix).
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
  /** Full write (tmp + rename, mode 0600). Failures are only logged. */
  write(record: HubRecord): void;
  /** Merge `lan` into the current in-memory record, then `write()` it — or, before the first
   * `write()`, only update the in-memory record (there is nothing on disk to rewrite yet). */
  patchLan(lan: LanStatus): void;
  /** The record last passed to `write()`/`patchLan()`, if any (never re-read from disk). */
  current(): HubRecord | undefined;
  /** Delete the file iff its `pid` still matches this process. */
  removeIfOurs(): void;
}

export function createHubJsonWriter(file: string, log: HubLog): HubJsonWriter {
  let record: HubRecord | undefined;
  let everWritten = false;

  function write(next: HubRecord): void {
    record = next;
    everWritten = true;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      log.error("web-hub: hub.json write failed", { error: String(err) });
    }
  }

  function patchLan(lan: LanStatus): void {
    if (record === undefined) return; // no base record yet; nothing to merge into
    const next: HubRecord = { ...record, lan };
    if (everWritten) write(next);
    else record = next;
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
      }
    },
  };
}
