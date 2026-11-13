/** Metadata-only durable fence. No output, credentials, leases, cwd or command text. */
import { constants } from "node:fs";
import { open, lstat, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  TERMINAL_JOURNAL_FILE,
  TerminalJournalSchema,
  terminalIdentityKey,
  type TerminalJournal,
} from "../../protocol/terminal.js";
import type { TerminalResourceJournalPort } from "../ports.js";
import { bounded } from "./limits.js";
const MAX_JOURNAL_BYTES = 2_097_152;
export function validJournal(j: unknown): j is TerminalJournal {
  if (!Value.Check(TerminalJournalSchema, j)) return false;
  const keys = new Set<string>(),
    reservations = new Set<string>();
  for (const r of j.resources) {
    const k = terminalIdentityKey(r.entry.identity);
    if (
      keys.has(k) ||
      reservations.has(r.entry.identity.reservationId) ||
      (r.status === "resolved" && (!r.proof || terminalIdentityKey(r.proof.identity) !== k))
    )
      return false;
    keys.add(k);
    reservations.add(r.entry.identity.reservationId);
  }
  return Buffer.byteLength(JSON.stringify(j)) <= MAX_JOURNAL_BYTES;
}
/** trustedNew is an internal local authority, NEVER inferred from ENOENT or browser input.
 * Integrator may supply it only for a genuinely new store before any terminal open. */
export function createTerminalResourceJournal(deps: {
  stateDir: string;
  now: () => number;
  trustedNew?: () => Promise<boolean>;
}): TerminalResourceJournalPort {
  const path = join(deps.stateDir, TERMINAL_JOURNAL_FILE);
  let current: TerminalJournal | undefined,
    loaded = false,
    poisoned = false,
    busy = false;
  const uid = process.getuid?.();
  async function directory() {
    const s = await lstat(deps.stateDir);
    if (
      uid === undefined ||
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== uid ||
      (s.mode & 0o777) !== 0o700 ||
      (await realpath(deps.stateDir)) !== resolve(deps.stateDir)
    )
      throw new Error("E_STORE");
  }
  async function read(): Promise<TerminalJournal> {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await h.stat();
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.size > MAX_JOURNAL_BYTES)
        throw new Error("E_STORE");
      const b = Buffer.alloc(st.size + 1);
      let n = 0;
      while (n < b.length) {
        const r = await h.read(b, n, b.length - n, n);
        if (!r.bytesRead) break;
        n += r.bytesRead;
      }
      if (n !== st.size) throw new Error("E_STORE");
      const j: unknown = JSON.parse(b.subarray(0, n).toString("utf8"));
      if (!validJournal(j)) throw new Error("E_STORE");
      return j;
    } finally {
      await h.close();
    }
  }
  return {
    async load(signal) {
      if (busy || poisoned) return { kind: "unavailable" };
      busy = true;
      try {
        const out = await bounded(
          (async () => {
            await directory();
            try {
              const journal = await read();
              return { kind: "loaded" as const, journal };
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !deps.trustedNew || !(await deps.trustedNew()))
                throw e;
              return { kind: "trusted-new" as const };
            }
          })(),
          deps.now,
          deps.now() + 2000,
          signal,
        );
        current = out.kind === "loaded" ? structuredClone(out.journal) : { v: 1, revision: 0, resources: [] };
        loaded = true;
        return out;
      } catch {
        poisoned = true;
        return { kind: "unavailable" };
      } finally {
        busy = false;
      }
    },
    async commit(expectedRevision, next, signal) {
      if (!loaded || poisoned || busy || !current) return "unavailable";
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return "conflict";
      if (!validJournal(next)) return "unavailable";
      busy = true;
      const copy = structuredClone(next);
      try {
        await bounded(
          (async () => {
            await directory();
            // Refuse outside-writer changes; a missing previously committed store is unknown.
            if (current!.revision > 0) {
              const disk = await read();
              if (JSON.stringify(disk) !== JSON.stringify(current)) throw new Error("E_STORE");
            }
            const tmp = join(deps.stateDir, `.terminal-fence-${randomBytes(16).toString("hex")}`);
            try {
              const h = await open(
                tmp,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              try {
                await h.writeFile(JSON.stringify(copy));
                await h.sync();
              } finally {
                await h.close();
              }
              if (signal.aborted) throw new Error("E_ABORT");
              await rename(tmp, path);
              const dir = await open(deps.stateDir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
              try {
                await dir.sync();
              } finally {
                await dir.close();
              }
              if (signal.aborted) throw new Error("E_ABORT");
            } finally {
              await unlink(tmp).catch(() => {});
            }
          })(),
          deps.now,
          deps.now() + 2000,
          signal,
        );
        current = copy;
        return "committed";
      } catch {
        poisoned = true;
        return "unavailable";
      } finally {
        busy = false;
      }
    },
  };
}
