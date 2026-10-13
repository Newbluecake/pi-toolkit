/**
 * web-hub-privacy plan v2.1 (P1): the hub-side privacy-lock store — `<stateDir>/privacy.json`
 * (`HubPaths.stateDir`, already a private 0700 dir ensured by hub startup), shape
 * `{ "version": 1, "locked": { "<sessionId>": true } }` (v2 评审 #15: no key prefix, no
 * lockedAt — nothing consumed them).
 *
 * Semantics (plan「数据模型」):
 * - Atomic write (tmp + fsync + rename + best-effort dir fsync), file mode 0600.
 * - **Write-through, disk first**: a mutation writes the file BEFORE the in-memory set
 *   changes; a failed write rejects the whole operation and memory stays untouched
 *   （先写盘后改内存，写失败整体报错）.
 * - **上限拒绝而非淘汰**: adding a NEW sessionId beyond {@link PRIVACY_MAX_ENTRIES} (4096)
 *   rejects with `E_LIMIT` (v2.1 N7); removals are never limited. Orphan marks (session file
 *   long deleted) are never GC'd in v1 — harmless: consumers intersect the set.
 * - Corrupt/unreadable file at load: renamed to `privacy.json.bak` (best effort), the store
 *   starts EMPTY with `degraded === true` and a WARN log line (`/webhub status` surfaces the
 *   flag in P3). `webHub.privacy=off` never deletes the file — hub.ts simply never constructs
 *   the store, so re-enabling finds every mark intact.
 *
 * All mutations serialize on one internal promise chain (the file is small; a queue of one
 * pending write is the whole concurrency story). No timers, no fs watchers — `close()` just
 * drains the chain (bounded by the caller's deadline, same contract as the avatar store).
 */
import { open, rename, readFile } from "node:fs/promises";
import { join } from "node:path";

/** v2.1 N7: each entry is a few dozen bytes — 4096 costs nothing and keeps `E_LIMIT` far
 * beyond any real demand (no eviction, ever). */
export const PRIVACY_MAX_ENTRIES = 4096;
export const PRIVACY_FILE_NAME = "privacy.json";
export const PRIVACY_BAK_SUFFIX = ".bak";

/** Loose sessionId admission for the store itself (the route layer validates the request
 * shape first): non-empty, bounded length, no path separators / NUL — these ids are pi session
 * ids (uuid-ish), but the store deliberately doesn't pin the exact charset. */
const SESSION_ID_MAX = 128;

export class PrivacyStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: "E_LIMIT" | "E_INTERNAL",
  ) {
    super(code);
    this.name = "PrivacyStoreError";
  }
}

/** Narrow fs seam (tests inject failures without chmod games that root bypasses). */
export interface PrivacyFs {
  readFile(path: string): Promise<Uint8Array>;
  /** Atomic replace: tmp + fsync + rename + best-effort dir fsync. */
  writeFileAtomic(path: string, bytes: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

async function defaultWriteFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  // Best-effort dir fsync (durability of the rename itself); a failure here must not fail the
  // write — the rename already landed.
  try {
    const dir = await open(join(path, ".."), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* best effort */
  }
}

const defaultFs: PrivacyFs = {
  readFile: (path) => readFile(path),
  writeFileAtomic: defaultWriteFileAtomic,
  rename: (a, b) => rename(a, b),
};

export interface PrivacyStoreDeps {
  stateDir: string;
  log?: { warn(msg: string, data?: object): void; error(msg: string, data?: object): void };
  fs?: PrivacyFs;
  /** Fired synchronously after every SUCCESSFUL mutation (the in-memory set is already
   * updated); hub.ts republishes it as the `privacy` bus/SSE event. Never fired by `load()`. */
  onChange?: (locked: readonly string[]) => void;
}

export interface PrivacyStore {
  /** Sorted locked-sessionId list — the wire shape of the `privacy` SSE frame's `locked`. */
  locked(): readonly string[];
  isLocked(sessionId: string): boolean;
  /** True once a corrupt/unreadable file was renamed aside at load (status-alert source). */
  readonly degraded: boolean;
  /** Read `privacy.json` (missing ⇒ empty, the normal first-run state). Never throws. */
  load(): Promise<void>;
  /** Write-through mutation: file first, memory second; rejects (memory untouched) on
   * `E_LIMIT` (adding beyond the cap) or any write failure. No-op when already in the
   * requested state (no write). */
  setLocked(sessionId: string, locked: boolean): Promise<void>;
  /** Drain the mutation chain (idempotent). */
  close(): Promise<void>;
}

interface PrivacyFileShape {
  version: 1;
  locked: Record<string, true>;
}

function parseFile(raw: Uint8Array): Set<string> {
  const text = new TextDecoder().decode(raw);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad-shape");
  const rec = parsed as Record<string, unknown>;
  if (rec["version"] !== 1) throw new Error("bad-version");
  const locked = rec["locked"];
  if (typeof locked !== "object" || locked === null || Array.isArray(locked)) throw new Error("bad-locked");
  const out = new Set<string>();
  for (const [k, v] of Object.entries(locked as Record<string, unknown>)) {
    if (v !== true) throw new Error("bad-entry");
    out.add(k);
  }
  return out;
}

function serialize(set: ReadonlySet<string>): Uint8Array {
  const locked: Record<string, true> = {};
  for (const id of [...set].sort()) locked[id] = true;
  const shape: PrivacyFileShape = { version: 1, locked };
  return new TextEncoder().encode(`${JSON.stringify(shape, null, 2)}\n`);
}

export function createPrivacyStore(deps: PrivacyStoreDeps): PrivacyStore {
  const file = join(deps.stateDir, PRIVACY_FILE_NAME);
  const fs = deps.fs ?? defaultFs;
  const set = new Set<string>();
  let degradedFlag = false;
  let chain: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    let raw: Uint8Array;
    try {
      raw = await fs.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // normal empty state
      // Unreadable (permissions, EISDIR, …): rename aside best-effort, start empty, alert.
      degradedFlag = true;
      deps.log?.warn("web-hub privacy: privacy.json unreadable — starting with an empty lock set", {
        error: String(err),
      });
      try {
        await fs.rename(file, file + PRIVACY_BAK_SUFFIX);
      } catch {
        /* best effort — an unreadable file may also be unrenamable */
      }
      return;
    }
    let parsed: Set<string>;
    try {
      parsed = parseFile(raw);
    } catch (err) {
      degradedFlag = true;
      deps.log?.warn("web-hub privacy: privacy.json corrupt — renamed to .bak, starting with an empty lock set", {
        error: String(err),
      });
      try {
        await fs.rename(file, file + PRIVACY_BAK_SUFFIX);
      } catch (renameErr) {
        deps.log?.warn("web-hub privacy: failed to rename corrupt privacy.json aside", { error: String(renameErr) });
      }
      return;
    }
    for (const id of parsed) set.add(id);
  }

  /** The actual mutation, always running inside the serialized chain. */
  async function apply(sessionId: string, locked: boolean): Promise<void> {
    const has = set.has(sessionId);
    if (locked === has) return; // no-op: never a write, never E_LIMIT
    if (locked && set.size >= PRIVACY_MAX_ENTRIES) {
      throw new PrivacyStoreError(409, "E_LIMIT");
    }
    const next = new Set(set);
    if (locked) next.add(sessionId);
    else next.delete(sessionId);
    // Disk first — a failure here leaves the in-memory set untouched and rejects the caller.
    try {
      await fs.writeFileAtomic(file, serialize(next));
    } catch (err) {
      deps.log?.error("web-hub privacy: privacy.json write failed — lock set unchanged", { error: String(err) });
      throw new PrivacyStoreError(500, "E_INTERNAL");
    }
    set.clear();
    for (const id of next) set.add(id);
    deps.onChange?.([...set].sort());
  }

  function setLocked(sessionId: string, locked: boolean): Promise<void> {
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > SESSION_ID_MAX ||
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      sessionId.includes("\0")
    ) {
      // Defensive — the route layer's SESSION_ID_RE already excludes all of these.
      return Promise.reject(new PrivacyStoreError(500, "E_INTERNAL"));
    }
    const op = chain.then(() => apply(sessionId, locked));
    chain = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  return {
    locked: () => [...set].sort(),
    isLocked: (sessionId) => set.has(sessionId),
    get degraded() {
      return degradedFlag;
    },
    load,
    setLocked,
    close: () => chain,
  };
}
