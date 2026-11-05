/**
 * hub.log writer (plan §包 B): append-only JSON lines, 0600, three-generation
 * rotation (`hub.log` → `hub.log.1` → `hub.log.2` → `hub.log.3`, oldest dropped) once
 * the file would exceed `maxBytes`.
 *
 * Writes are synchronous and tiny (the hub logs lifecycle events, not traffic)
 * and never throw — a broken log must never take the hub down.
 */
import { Buffer } from "node:buffer";
import { appendFileSync, chmodSync, renameSync, rmSync, statSync } from "node:fs";
import type { HubLog } from "./ports.js";

export const DEFAULT_LOG_MAX_BYTES = 1 << 20;

export function createHubLog(file: string, opts?: { maxBytes?: number }): HubLog & { close(): void } {
  const maxBytes = opts?.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  let closed = false;
  let size = currentSize(file);

  const write = (level: "info" | "warn" | "error", msg: string, data?: object): void => {
    if (closed) return;
    let line: string;
    try {
      line = `${JSON.stringify({ t: new Date().toISOString(), level, pid: process.pid, msg, ...(data ?? {}) })}\n`;
    } catch {
      line = `${JSON.stringify({ t: new Date().toISOString(), level, pid: process.pid, msg, data: "[unserializable]" })}\n`;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    try {
      if (size > 0 && size + bytes > maxBytes) {
        // Three backups: shift .2→.3 (dropping the old .3), .1→.2, hub.log→.1.
        // Each shift is best-effort on its own so a stuck one cannot block the rest.
        try {
          rmSync(`${file}.3`, { force: true });
        } catch {
          // ignore
        }
        try {
          renameSync(`${file}.2`, `${file}.3`);
        } catch {
          // ignore
        }
        try {
          renameSync(`${file}.1`, `${file}.2`);
        } catch {
          // ignore
        }
        renameSync(file, `${file}.1`);
        size = 0;
      }
      const fresh = size === 0;
      appendFileSync(file, line, { mode: 0o600 });
      if (fresh) chmodSync(file, 0o600);
      size += bytes;
    } catch {
      // Logging is best-effort: never throw into the hub.
      size = currentSize(file);
    }
  };

  return {
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    close: () => {
      closed = true;
    },
  };
}

function currentSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
