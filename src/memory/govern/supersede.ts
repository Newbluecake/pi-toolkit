// #36 arch r5 §5.4: pi-free single-edge protocol and its sole tuning knobs.
// P4 introduced the constants; P5a owns execution, CAS, and restoration.

/** Relation choice `supersedes` at or above this probability is auto-executed
 *  (matrix permitting). */
export const SUPERSEDE_AUTO_P = 0.85;

/** Historical conflict cutoff retained for evaluation parameter readers.
 *  2026-11-07 user ruling: conflict is suggestion-only, never auto-executed. */
export const CONFLICT_AUTO_P = 0.9;

/** Auto-executed relations per write, user+agent combined; the rest stay
 *  suggestions. */
export const AUTO_PER_WRITE_MAX = 2;

import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import type { JevIndexV1, RelationVerdict } from "../jev/contracts.js";
import { entryHash, normalizeBody } from "../jev/entries.js";
import { readIndex } from "../jev/index-store.js";
import { withMemoryDirLock } from "../lock.js";
import { MemoryError } from "../paths.js";
import { dirFormat, parseBlockName } from "../blocks/naming.js";
import { parseBlockFile, serializeBlock, type BlockMeta, type ParsedBlock } from "../blocks/format.js";

import { ensurePrivateDir, inspectDirNoFollow, readRegular, replaceAtomic, writeTempRegular } from "../safe-fs.js";

/** Date-only expiry is local-calendar based, matching tool v3 and render. */
export function governanceToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function governanceGate(memDir: string, gate?: MemoryWriteGate, signal?: AbortSignal): void {
  if (signal?.aborted) throw new MemoryError("E_ABORTED");
  if (gate && !gate.check(memDir).ok) throw new MemoryError("E_WRITE_GATE");
  if (dirFormat(memDir) !== "blocks") throw new MemoryError("E_UNMIGRATED");
  const blocks = inspectDirNoFollow(join(memDir, "blocks"));
  for (const child of ["archive", ".jev"])
    if (blocks.names.includes(child)) {
      if (inspectDirNoFollow(join(memDir, "blocks", child)).dev !== blocks.dev)
        throw new MemoryError("E_WRITE_GATE: governance child device changed");
    }
}
export function readGovernBlock(memDir: string, id: string): ParsedBlock {
  if (!parseBlockName(`${id}.md`)) throw new MemoryError("E_BLOCK: invalid id");
  const b = parseBlockFile(`${id}.md`, readRegular(join(memDir, "blocks"), `${id}.md`).text);
  if ("stray" in b || b.errors.some((error) => error !== "E_TOO_LARGE"))
    throw new MemoryError("E_BLOCK: malformed block");
  return b;
}
/** Caller holds the memory directory lock; never nest writeIndexPatch's lock. */
export function writeGovernIndexLocked(
  memDir: string,
  index: JevIndexV1,
  gate?: MemoryWriteGate,
  signal?: AbortSignal,
): void {
  const dir = join(memDir, "blocks", ".jev");
  governanceGate(memDir, gate, signal);
  ensurePrivateDir(dir);
  governanceGate(memDir, gate, signal);
  const tmp = writeTempRegular(dir, "index.json", Buffer.from(JSON.stringify(index)), 0o600);
  governanceGate(memDir, gate, signal);
  replaceAtomic(dir, tmp, "index.json");
}
export function blockAnchor(b: ParsedBlock): string {
  return `${b.id}.md|${b.meta.section ?? ""}|${Array.from(normalizeBody(b.body)).slice(0, 24).join("")}`;
}
function pair(a: ParsedBlock, b: ParsedBlock): { hashKey: string; anchorKey: string } {
  return {
    hashKey: [entryHash(a.body), entryHash(b.body)].sort().join("+"),
    anchorKey: [blockAnchor(a), blockAnchor(b)].sort().join("+"),
  };
}
export interface SupersedeOptions {
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  explicit?: boolean;
  enabled?: boolean;
  now?: Date;
  notify?: (message: string) => void;
}

/** Governance metadata writes preserve migration provenance (only a tool
 * update clears residue). The caller owns the lock; raw-byte CAS still
 * runs immediately before atomic replace. */
export function replaceGovernBlockLocked(
  memDir: string,
  old: ParsedBlock,
  meta: BlockMeta,
  opts: SupersedeOptions = {},
): void {
  governanceGate(memDir, opts.gate, opts.signal);
  const dir = join(memDir, "blocks");
  const raw = serializeBlock(
    { ...meta, version: old.meta.version + 1, updated: (opts.now ?? new Date()).toISOString() },
    old.body,
    { allowOversize: true },
  );
  const tmp = writeTempRegular(dir, `${old.id}.md`, Buffer.from(raw), 0o600);
  governanceGate(memDir, opts.gate, opts.signal);
  if (readGovernBlock(memDir, old.id).rev !== old.rev) throw new MemoryError("E_CONFLICT");
  replaceAtomic(dir, tmp, `${old.id}.md`);
}

export interface SupersedeResult {
  oldId: string;
  outcome: "superseded" | "skipped";
  reason?: string;
  echo: string;
}
/** One lock and one old-file CAS per edge. No reciprocal writes or graph repair. */
export async function supersede(
  memDir: string,
  verdicts: readonly RelationVerdict[],
  opts: SupersedeOptions = {},
): Promise<SupersedeResult[]> {
  const results: SupersedeResult[] = [];
  let executed = 0;
  for (const v of verdicts) {
    let reason: string | undefined;
    try {
      if (!opts.explicit && opts.enabled === false) throw new MemoryError("governance disabled");
      governanceGate(memDir, opts.gate, opts.signal);
      await withMemoryDirLock(
        memDir,
        () => {
          governanceGate(memDir, opts.gate, opts.signal);
          if (!opts.explicit && opts.enabled === false) throw new MemoryError("governance disabled");
          if (
            !opts.explicit &&
            (v.kind !== "supersedes" || !v.auto || !Number.isFinite(v.p) || v.p > 1 || v.p < SUPERSEDE_AUTO_P)
          )
            throw new MemoryError("below threshold");
          if (!opts.explicit && executed >= AUTO_PER_WRITE_MAX) throw new MemoryError("per-write limit");
          if (v.newId === v.oldId) throw new MemoryError("self supersession");
          const next = readGovernBlock(memDir, v.newId),
            old = readGovernBlock(memDir, v.oldId);
          if (next.rev !== v.newRev) throw new MemoryError("new rev changed");
          if (next.meta.status !== "active" || next.meta.supersededBy) throw new MemoryError("new block not active");
          if (old.rev !== v.oldRev) throw new MemoryError("old rev changed");
          if (old.meta.status !== "active" || old.meta.supersededBy) throw new MemoryError("old block not active");
          if (next.meta.authority === "agent" && old.meta.authority === "user")
            throw new MemoryError("supersedes ignored: target is a user rule");
          if (!opts.explicit && old.meta.residue) throw new MemoryError("residue requires explicit supersedes");
          const key = pair(next, old),
            today = governanceToday(opts.now ?? new Date());
          if (
            !opts.explicit &&
            readIndex(memDir).index.review?.dismissed.some(
              (d) => (!d.until || d.until >= today) && (d.hashKey === key.hashKey || d.anchorKey === key.anchorKey),
            )
          )
            throw new MemoryError("pair permanently dismissed");
          // Defensive against malformed/handwritten existing graphs as well.
          const seen = new Set([old.id]);
          let cursor: ParsedBlock | undefined = next;
          while (cursor) {
            if (seen.has(cursor.id)) throw new MemoryError("cycle");
            seen.add(cursor.id);
            cursor = cursor.meta.supersededBy ? readGovernBlock(memDir, cursor.meta.supersededBy) : undefined;
          }
          replaceGovernBlockLocked(memDir, old, { ...old.meta, status: "superseded", supersededBy: next.id }, opts);
          executed++;
          if (old.meta.authority === "user") {
            try {
              opts.notify?.(
                `memory: user rule ${next.id} superseded ${old.id} (p=${v.p.toFixed(2)}) — undo: /mem restore --block ${old.id}`,
              );
            } catch {
              /* notification cannot undo commit */
            }
          }
          if (old.meta.scope === "global" && next.meta.scope !== "global")
            reason = `${old.id} was global; new block remains topic`;
        },
        { timeoutMs: 500 },
      );
      results.push({
        oldId: v.oldId,
        outcome: "superseded",
        ...(reason ? { reason } : {}),
        echo: `superseded: ${v.oldId} by ${v.newId}${reason ? `\nnote: ${reason}` : ""}`,
      });
    } catch (error) {
      reason = (error as Error).message;
      results.push({ oldId: v.oldId, outcome: "skipped", reason, echo: `skipped: ${v.oldId}: ${reason}` });
    }
  }
  // Failed automatic decisions remain actionable instead of disappearing in
  // a tool echo. A denied gate/abort/off path never writes a suggestion.
  if (!opts.explicit && opts.enabled !== false && results.some((r) => r.outcome === "skipped")) {
    try {
      governanceGate(memDir, opts.gate, opts.signal);
      await withMemoryDirLock(
        memDir,
        () => {
          governanceGate(memDir, opts.gate, opts.signal);
          const index = readIndex(memDir).index;
          const review = index.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
          const suggestions = [...review.suggestions];
          for (const v of verdicts) {
            if (!results.some((r) => r.oldId === v.oldId && r.outcome === "skipped") || v.newId === v.oldId) continue;
            let a: ParsedBlock, b: ParsedBlock;
            try {
              a = readGovernBlock(memDir, v.newId);
              b = readGovernBlock(memDir, v.oldId);
            } catch {
              continue;
            }
            const key = pair(a, b);
            if (review.dismissed.some((d) => d.hashKey === key.hashKey || d.anchorKey === key.anchorKey)) continue;
            const id = `relation-${v.newId}-${v.oldId}`;
            if (!suggestions.some((s) => s.id === id))
              suggestions.push({
                id,
                kind: "conflict",
                a: { hash: entryHash(a.body), anchor: blockAnchor(a) },
                b: { hash: entryHash(b.body), anchor: blockAnchor(b) },
                p: v.p,
                at: (opts.now ?? new Date()).toISOString(),
              });
          }
          if (suggestions.length !== review.suggestions.length)
            writeGovernIndexLocked(memDir, { ...index, review: { ...review, suggestions } }, opts.gate, opts.signal);
        },
        { timeoutMs: 500 },
      );
    } catch {
      /* fail-soft suggestions never change the committed edge result */
    }
  }
  return results;
}
/** Restore exactly this edge; siblings and predecessors remain untouched.
 * Dismiss BEFORE clearing: a crash may conservatively suppress a future auto
 * judgment, but can never restore without its permanent dismissal. */
export async function restoreSupersededBlock(
  memDir: string,
  id: string,
  opts: SupersedeOptions = {},
): Promise<boolean> {
  governanceGate(memDir, opts.gate, opts.signal);
  return withMemoryDirLock(
    memDir,
    () => {
      governanceGate(memDir, opts.gate, opts.signal);
      const old = readGovernBlock(memDir, id);
      if (!old.meta.supersededBy) return false;
      let target: ParsedBlock | undefined;
      try {
        target = readGovernBlock(memDir, old.meta.supersededBy);
      } catch {
        /* deleted successor: restoration still works */
      }
      const index = readIndex(memDir).index;
      const review = index.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
      writeGovernIndexLocked(
        memDir,
        {
          ...index,
          review: {
            ...review,
            dismissed: [
              ...review.dismissed,
              target
                ? pair(old, target)
                : {
                    hashKey: [entryHash(old.body), old.meta.supersededBy].sort().join("+"),
                    anchorKey: [blockAnchor(old), `${old.meta.supersededBy}.md||`].sort().join("+"),
                  },
            ],
          },
        },
        opts.gate,
        opts.signal,
      );
      const meta = { ...old.meta, status: "active" as const };
      delete meta.supersededBy;
      replaceGovernBlockLocked(memDir, old, meta, opts);
      return true;
    },
    { timeoutMs: 500 },
  );
}
