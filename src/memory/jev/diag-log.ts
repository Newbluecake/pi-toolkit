// Bounded diagnostic sidecar `<slug>/.jev/diag.jsonl` (2026-11-04 all-failed
// fix): the in-memory error ring (wire.ts) is lost on restart, so the last
// `DIAG_MAX_LINES` diagnostic lines are also persisted here for `/mem jev`
// to show recent classifier failures across restarts.
//
// Derived, droppable data (same class as index.json):
//  - fail-soft everywhere: any fs/lock error drops the append (or yields an
//    empty read) — diagnostics must never break the write path;
//  - the whole read → append → trim → atomic-replace cycle runs synchronously
//    inside `withMemoryDirLock` (busy ⇒ dropped, never queued/thrown), the
//    same rules as `writeIndexPatch`;
//  - `.jev/` is 0700 (`ensurePrivateDir`), the file 0600
//    (`writeTempRegular` + `replaceAtomic`), no direct `node:fs`;
//  - content is redacted (`redactForJev`, "error" field) and length-capped
//    BEFORE persisting — memory bodies and credentials never land here (the
//    callers only ever pass classifier-id/error-message lines, the redaction
//    is defense in depth).
//
// Pi-free root; no module-scope state (I4).

import { join } from "node:path";
import { withMemoryDirLock } from "../lock.js";
import { ensurePrivateDir, readRegular, replaceAtomic, writeTempRegular } from "../safe-fs.js";
import { redactForJev } from "./redact.js";
import { JEV_DIR_NAME } from "./index-store.js";

const DIAG_NAME = "diag.jsonl";
/** Ring size on disk (lines). */
export const DIAG_MAX_LINES = 200;
/** Per-line cap (code points) applied after redaction. */
const DIAG_LINE_MAX_CP = 300;
const DIAG_FILE_MODE = 0o600;

export interface DiagRecord {
  /** ISO 8601 timestamp of when the line was logged. */
  readonly at: string;
  readonly line: string;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/** Sanitize one line for the disk copy: redact, cap length, strip newlines
 *  (jsonl invariant — one record per physical line). Never throws. */
function sanitizeLine(line: string): string {
  try {
    const redacted = redactForJev(line, "error").replace(/[\r\n]+/g, " ");
    const chars = Array.from(redacted);
    return chars.length <= DIAG_LINE_MAX_CP ? redacted : `${chars.slice(0, DIAG_LINE_MAX_CP).join("")}…`;
  } catch {
    return "";
  }
}

function serializeRecord(record: DiagRecord): string {
  // `line` is pre-sanitized (no newlines); JSON.stringify keeps it one line.
  return JSON.stringify({ at: record.at, line: record.line });
}

/** Tolerant parse of the existing file: unreadable/missing ⇒ `[]`; malformed
 *  lines are dropped individually (read tolerance, same as readIndex). */
function parseDiagFile(text: string): readonly DiagRecord[] {
  const out: DiagRecord[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>)["at"] === "string" &&
        typeof (parsed as Record<string, unknown>)["line"] === "string"
      ) {
        const rec = parsed as Record<string, string>;
        out.push({ at: rec["at"] as string, line: rec["line"] as string });
      }
    } catch {
      // drop malformed line
    }
  }
  return out;
}

/** Read the most recent `count` persisted diagnostic records (oldest first).
 *  Missing file ⇒ `[]`; never throws. Synchronous (called from `/mem jev`). */
export function readDiagLines(dir: string, count: number): readonly DiagRecord[] {
  if (count <= 0) return [];
  let text: string;
  try {
    text = readRegular(join(dir, JEV_DIR_NAME), DIAG_NAME).text;
  } catch {
    return [];
  }
  const records = parseDiagFile(text);
  return records.slice(Math.max(0, records.length - count));
}

/**
 * Append one diagnostic line to the ring. Fire-and-forget: the lock/fs work
 * happens on its own async tick and any failure (including lock busy) is
 * swallowed — losing a diagnostic line is always acceptable. `at` is the
 * epoch-ms timestamp of the log call (caller's clock).
 */
export function appendDiagLine(dir: string, at: number, line: string): void {
  const record: DiagRecord = { at: new Date(at).toISOString(), line: sanitizeLine(line) };
  if (record.line === "") return;
  void (async () => {
    try {
      await withMemoryDirLock(
        dir,
        () => {
          const jdir = join(dir, JEV_DIR_NAME);
          ensurePrivateDir(jdir);
          let existing: readonly DiagRecord[];
          try {
            existing = parseDiagFile(readRegular(jdir, DIAG_NAME).text);
          } catch (err) {
            if (!isErrno(err, "ENOENT")) return; // unreadable ⇒ drop, never rebuild over a suspect file
            existing = [];
          }
          const merged = [...existing, record].slice(-DIAG_MAX_LINES);
          const data = Buffer.from(`${merged.map(serializeRecord).join("\n")}\n`, "utf8");
          const tmp = writeTempRegular(jdir, DIAG_NAME, data, DIAG_FILE_MODE);
          replaceAtomic(jdir, tmp, DIAG_NAME);
        },
        { timeoutMs: 0, log: () => {} },
      );
    } catch {
      // lock busy or a genuine fs error — diagnostics are fail-soft; drop
      // the line rather than ever surfacing in the write path
    }
  })();
}
