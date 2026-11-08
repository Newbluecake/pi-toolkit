/** Pi-free bounded governance runner. All state belongs to the factory. */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { clampSpanMs } from "../../core/deadline.js";
import type { MemoryWriteGate } from "../contracts.js";
import type { BlockCorpus } from "../blocks/store.js";
import { readMarker } from "../blocks/marker.js";
import { META_LIMITS, parseBlockFile, serializeBlock } from "../blocks/format.js";
import { residentBlocksOf, residentMeteredBytes } from "../blocks/render.js";
import { parseArchiveName, parseBlockName } from "../blocks/naming.js";
import { mergeReview, readIndex } from "../jev/index-store.js";
import { legacyDrift } from "../blocks/legacy.js";
import { withMemoryDirLock } from "../lock.js";
import { MemoryError } from "../paths.js";
import { recordSoftMeta, softLegacyMetadata } from "../soft-meta.js";
import {
  ensurePrivateDir,
  inspectDirNoFollow,
  listRegular,
  listDirNames,
  readRegular,
  renameNoClobber,
  replaceAtomic,
  writeTempRegular,
} from "../safe-fs.js";
import {
  governanceGate,
  governanceToday,
  readGovernBlock,
  restoreSupersededBlock,
  writeGovernIndexLocked,
  type SupersedeOptions,
} from "./supersede.js";
import { planSweep, type SweepReason } from "./sweep-plan.js";
export type ArchiveIndex = Record<string, { id: string; archivedAt: string; reason: string }>;
export function readArchiveIndex(memDir: string): ArchiveIndex {
  try {
    const raw: unknown = JSON.parse(readRegular(join(memDir, "blocks", "archive"), "index.json").text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MemoryError("invalid archive index");
    const out: ArchiveIndex = {};
    for (const [name, value] of Object.entries(raw)) {
      if (!parseArchiveName(name) || !value || typeof value !== "object")
        throw new MemoryError("invalid archive mapping");
      const v = value as ArchiveIndex[string];
      if (
        name.replace(/(?:\.r[0-9]+)?\.md$/, "") !== v.id ||
        typeof v.archivedAt !== "string" ||
        typeof v.reason !== "string"
      )
        throw new MemoryError("invalid archive mapping");
      out[name] = v;
    }
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
/** Unlike the general lock-free renderer reader, sweep must not enumerate
 * the entire directory after EACH block (quadratic on a large corpus).
 * Capture one identity/list, read each no-follow regular file once, then
 * verify identity once. Decisions still CAS-recheck under the write lock.
 * Reads are budgeted and yield in chunks, so shutdown can interrupt planning. */
async function readSweepCorpus(
  memDir: string,
  beforeRead: () => void,
  yieldControl: () => Promise<void>,
): Promise<BlockCorpus> {
  beforeRead();
  const dir = join(memDir, "blocks"),
    identity = inspectDirNoFollow(dir);
  const blocks: BlockCorpus["blocks"][number][] = [],
    strays: string[] = [],
    stamps: string[] = [];
  const files = listRegular(dir, { names: "legacy" });
  let count = 0;
  for (const file of files.files.sort((a, b) => a.name.localeCompare(b.name))) {
    beforeRead();
    const raw = readRegular(dir, file.name).text;
    const b = parseBlockFile(file.name, raw, {
      softLimits: true,
      onSoftLimit: (field, value) => recordSoftMeta(memDir, field, value),
    });
    if ("stray" in b || !parseBlockName(file.name)) strays.push(file.name);
    else {
      blocks.push(b);
      stamps.push(`${file.name}:${b.rev}`);
    }
    if (++count % 128 === 0) await yieldControl();
  }
  for (const file of files.skipped) strays.push(file.name);
  const legacy: BlockCorpus["legacy"]["files"][number][] = [];
  for (const file of listRegular(memDir, { names: "v2" }).files.sort((a, b) => a.name.localeCompare(b.name))) {
    beforeRead();
    const raw = readRegular(memDir, file.name).text;
    softLegacyMetadata(raw, memDir);
    legacy.push({ name: file.name, sha256: createHash("sha256").update(raw).digest("hex") });
  }
  beforeRead();
  const after = inspectDirNoFollow(dir);
  if (identity.dev !== after.dev || identity.ino !== after.ino)
    throw new MemoryError("E_UNMIGRATED: sweep corpus identity changed");
  const archivedByTopic = new Map<string, number>();
  for (const name of Object.keys(readArchiveIndex(memDir))) {
    const topic = parseArchiveName(name)!.topic;
    archivedByTopic.set(topic, (archivedByTopic.get(topic) ?? 0) + 1);
  }
  return {
    blocks,
    strays,
    archivedByTopic,
    marker: readMarker(dir),
    legacy: { files: legacy },
    fingerprint: createHash("sha1").update(JSON.stringify(stamps)).digest("hex"),
  };
}
export interface SweepOptions {
  enabled: boolean;
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  now?: () => number;
  notify?: (message: string) => void;
  onAfterWrite?: (origin: "sweep") => void;
  diag?: (message: string) => void;
  yield?: () => Promise<void>;
  residentBudget?: number;
  render?: { residentBytes: number; residentBudget: number; indexOverflow: boolean };
}
export interface SweepResult {
  operations: number;
  archived: string[];
  stopped: string;
  suggestions: number;
}
export function createSweepRunner(opts: SweepOptions) {
  let inFlight: Promise<SweepResult> | undefined;
  let pending: { dir: string; reason: SweepReason; signal?: AbortSignal } | undefined;
  const previous = new Map<string, string>();
  const clock = opts.now ?? Date.now;
  async function pass(memDir: string, reason: SweepReason, signal?: AbortSignal): Promise<SweepResult> {
    const result: SweepResult = { operations: 0, archived: [], stopped: "done", suggestions: 0 };
    if (!opts.enabled) {
      result.stopped = "disabled";
      return result;
    }
    const commitSignal = signal && opts.signal ? AbortSignal.any([signal, opts.signal]) : (signal ?? opts.signal);
    const deadline = clock() + (clampSpanMs(1000) ?? 1);
    const check = (): void => {
      governanceGate(memDir, opts.gate, commitSignal);
      if (clock() >= deadline || result.operations >= 50) throw new MemoryError("budget");
    };
    const op = (fn: () => void): void => {
      check();
      result.operations++;
      fn();
    };
    try {
      check();
      const beforeRead = (): void => {
        if (commitSignal?.aborted) throw new MemoryError("E_ABORTED");
        if (opts.gate && !opts.gate.check(memDir).ok) throw new MemoryError("E_WRITE_GATE");
        if (clock() >= deadline) throw new MemoryError("budget");
      };
      const corpus = await readSweepCorpus(memDir, beforeRead, opts.yield ?? (() => scheduler.yield()));
      const today = governanceToday(new Date(clock()));
      const key = JSON.stringify([corpus.fingerprint, today, corpus.legacy]);
      if (reason !== "startup" && reason !== "reload" && previous.get(memDir) === key) {
        result.stopped = "unchanged";
        return result;
      }
      const index = readIndex(memDir).index;
      const render =
        opts.render ??
        (opts.residentBudget === undefined
          ? undefined
          : {
              residentBytes: residentMeteredBytes(residentBlocksOf(corpus.blocks, { isChild: false, today }), today),
              residentBudget: opts.residentBudget,
              indexOverflow: false,
            });
      // Compare against the migration report plus explicit-import ledger,
      // never against the same current legacy fingerprint.
      const drift = legacyDrift(memDir).map((f) => f.name);
      const baseline = { files: corpus.legacy.files.filter((file) => !drift.includes(file.name)) };
      const plan = planSweep(corpus, index, baseline, today, reason, render);
      const archive = join(memDir, "blocks", "archive");
      const locked = async <T>(body: () => T): Promise<T> => {
        check();
        return withMemoryDirLock(memDir, body, {
          timeoutMs: clampSpanMs(Math.min(500, Math.max(1, deadline - clock()))) ?? 1,
        });
      };
      const persist = (mapping: ArchiveIndex): void => {
        op(() => ensurePrivateDir(archive));
        let tmp = "";
        op(() => {
          tmp = writeTempRegular(archive, "index.json", Buffer.from(JSON.stringify(mapping)), 0o600);
        });
        op(() => replaceAtomic(archive, tmp, "index.json"));
      };
      await locked(() => {
        check();
        const mapping = readArchiveIndex(memDir);
        const names = new Set(listDirNames(archive));
        let dirty = false;
        for (const name of Object.keys(mapping)) {
          check();
          if (!names.has(name)) {
            delete mapping[name];
            dirty = true;
          }
        }
        if (dirty) persist(mapping);
      });
      // Heal interrupted moves in separately bounded critical sections.
      for (const name of Object.keys(readArchiveIndex(memDir))) {
        if (result.operations + 2 > 50) break;
        await locked(() => {
          const b = parseBlockFile(name, readRegular(archive, name).text);
          if (!("stray" in b) && b.meta.status !== "archived" && b.errors.every((error) => error === "E_TOO_LARGE")) {
            let tmp = "";
            op(() => {
              tmp = writeTempRegular(
                archive,
                name,
                Buffer.from(serializeBlock({ ...b.meta, status: "archived" }, b.body, { allowOversize: true })),
                0o600,
              );
            });
            op(() => replaceAtomic(archive, tmp, name));
          }
        });
        await (opts.yield?.() ?? scheduler.yield());
      }
      let attempts = 0,
        casFailures = 0;
      for (const target of plan.archive) {
        check();
        if (result.operations + 6 > 50 || ++attempts > 50) {
          result.stopped = "budget";
          break;
        }
        await locked(() => {
          check();
          let b;
          try {
            b = readGovernBlock(memDir, target.id);
          } catch {
            casFailures++;
            return;
          }
          if (
            b.rev !== target.rev ||
            b.meta.authority !== "agent" ||
            b.meta.status !== "active" ||
            !b.meta.expires ||
            b.meta.expires >= today
          ) {
            casFailures++;
            return;
          }
          const mapping = readArchiveIndex(memDir),
            names = new Set(listDirNames(archive));
          let name = `${b.id}.md`;
          if (names.has(name)) {
            let n = 1;
            while (n <= 999 && names.has(`${b.id}.r${n}.md`)) n++;
            if (n > 999) {
              opts.diag?.("archive name exhaustion");
              return;
            }
            name = `${b.id}.r${n}.md`;
          }
          mapping[name] = { id: b.id, archivedAt: new Date(clock()).toISOString(), reason };
          persist(mapping);
          // A handwritten edit during index persistence invalidates the move.
          if (readGovernBlock(memDir, b.id).rev !== b.rev) {
            casFailures++;
            return;
          }
          op(() => renameNoClobber(join(memDir, "blocks"), `${b.id}.md`, `archive/${name}`));
          result.archived.push(b.id);
          let tmp = "";
          op(() => {
            tmp = writeTempRegular(
              archive,
              name,
              Buffer.from(
                serializeBlock(
                  {
                    ...b.meta,
                    status: "archived",
                    version: b.meta.version + 1,
                    updated: new Date(clock()).toISOString(),
                  },
                  b.body,
                  { allowOversize: true },
                ),
              ),
              0o600,
            );
          });
          op(() => replaceAtomic(archive, tmp, name));
        });
        // Release the directory lock before yielding to shutdown/external writers.
        // scheduler.yield is a single immediate, not a deadline/retry timer.
        await (opts.yield?.() ?? scheduler.yield());
        if (casFailures >= 8 && !result.archived.length) {
          result.stopped = "no-progress";
          break;
        }
      }
      if (plan.suggestions.length && result.operations + 3 <= 50) {
        await locked(() => {
          const latest = readIndex(memDir).index;
          const review = latest.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
          result.operations += 3;
          writeGovernIndexLocked(
            memDir,
            {
              ...latest,
              review: {
                ...mergeReview(review, { ...review, suggestions: plan.suggestions }),
                sweepLastRunAt: new Date(clock()).toISOString(),
                sweepCorpusFp: corpus.fingerprint,
              },
            },
            opts.gate,
            commitSignal,
          );
          result.suggestions = plan.suggestions.length;
        });
      }
      previous.set(
        memDir,
        result.stopped === "no-progress"
          ? JSON.stringify([
              (await readSweepCorpus(memDir, beforeRead, opts.yield ?? (() => scheduler.yield()))).fingerprint,
              today,
              corpus.legacy,
            ])
          : key,
      );
      if (plan.archive.length && !result.archived.length) opts.diag?.("sweep: no progress; wait for corpus change");
      if (drift.length) opts.notify?.(`memory: legacy drift: ${drift.join(", ")} — /mem migrate --import-legacy`);
      if (reason === "startup" || reason === "reload") {
        const count = readIndex(memDir).index.review?.suggestions.length ?? 0;
        if (render && render.residentBytes > render.residentBudget)
          opts.notify?.(
            `memory: resident budget exceeded (${render.residentBytes}/${render.residentBudget}B); no rules truncated — /mem review`,
          );
        if (count) opts.notify?.(`memory: ${count} suggestions — /mem review`);
        if (corpus.marker?.source !== "fresh")
          opts.notify?.("memory: migrated block memory — reload to refresh memory");
      }
    } catch (e) {
      result.stopped = (e as Error).message;
    }
    // A budget/abort after a committed rename must still invalidate caches
    // and report the recoverable archive. Never re-enter automatic sweep.
    try {
      if (result.operations) opts.onAfterWrite?.("sweep");
      if (result.archived.length)
        opts.notify?.(
          `memory: archived ${result.archived.length} expired agent blocks (undo: /mem restore --block ${result.archived[0]})`,
        );
    } catch {
      /* callbacks cannot undo disk commits */
    }
    await opts.yield?.();
    return result;
  }
  function runSweep(memDir: string, reason: SweepReason, signal?: AbortSignal, origin?: string): Promise<SweepResult> {
    if (origin === "sweep") return Promise.resolve({ operations: 0, archived: [], stopped: "self", suggestions: 0 });
    if (inFlight) {
      pending = { dir: memDir, reason, ...(signal ? { signal } : {}) };
      return inFlight;
    }
    inFlight = (async () => {
      let result = await pass(memDir, reason, signal);
      const next = pending;
      pending = undefined;
      if (next) result = await pass(next.dir, next.reason, next.signal);
      return result;
    })().finally(() => {
      inFlight = undefined;
      pending = undefined;
    });
    return inFlight;
  }
  return { runSweep };
}
export async function restoreBlock(memDir: string, target: string, opts: SupersedeOptions = {}): Promise<string> {
  governanceGate(memDir, opts.gate, opts.signal);
  const stored = target.endsWith(".md") ? target : `${target}.md`;
  if (!parseArchiveName(stored)) throw new MemoryError("invalid block id");
  const exactStorage = target.endsWith(".md") || /\.r[0-9]+$/.test(target);
  const matchesTarget = ([name, value]: [string, ArchiveIndex[string]]): boolean =>
    exactStorage ? name === stored : value.id === target;
  const index = readArchiveIndex(memDir);
  const matches = Object.entries(index).filter(matchesTarget);
  if (matches.length === 0)
    return (await restoreSupersededBlock(memDir, target.replace(/\.md$/, ""), opts))
      ? `restored: ${target}`
      : "block is not archived or superseded";
  return withMemoryDirLock(
    memDir,
    () => {
      governanceGate(memDir, opts.gate, opts.signal);
      const current = readArchiveIndex(memDir);
      const choices = Object.entries(current).filter(matchesTarget);
      if (choices.length !== 1)
        throw new MemoryError(`ambiguous archive: ${choices.map(([n]) => n).join(", ")} — specify stored name`);
      const [name, v] = choices[0]!;
      if (listDirNames(join(memDir, "blocks")).includes(`${v.id}.md`))
        throw new MemoryError(`restore conflict: ${v.id} already exists`);
      const archive = join(memDir, "blocks", "archive");
      const raw = readRegular(archive, name).text;
      const overages: { field: keyof typeof META_LIMITS; bytes: number }[] = [];
      const soft = parseBlockFile(name, raw, {
        softLimits: true,
        onSoftLimit: (field, value) => overages.push({ field, bytes: Buffer.byteLength(value) }),
      });
      if (
        "stray" in soft ||
        soft.errors.some((error) => !["E_TOO_LARGE", "E_META_SOFT", "E_SECTION_TOO_LARGE"].includes(error))
      )
        throw new MemoryError("invalid archived block: structural corruption; inspect the archive file manually");
      if (overages.length) {
        const { field, bytes } = overages[0]!;
        throw new MemoryError(
          `E_META: archived ${field} exceeds limit (${bytes}B > ${META_LIMITS[field]}B); inspect and correct the archived file manually before restore`,
        );
      }
      const b = parseBlockFile(name, raw);
      if ("stray" in b || b.errors.some((error) => error !== "E_TOO_LARGE"))
        throw new MemoryError("invalid archived block: structural corruption; inspect the archive file manually");
      governanceGate(memDir, opts.gate, opts.signal);
      const tmp = writeTempRegular(
        archive,
        name,
        Buffer.from(
          serializeBlock(
            {
              ...b.meta,
              status: "active",
              version: b.meta.version + 1,
              updated: (opts.now ?? new Date()).toISOString(),
            },
            b.body,
            { allowOversize: true },
          ),
        ),
        0o600,
      );
      governanceGate(memDir, opts.gate, opts.signal);
      replaceAtomic(archive, tmp, name);
      governanceGate(memDir, opts.gate, opts.signal);
      renameNoClobber(archive, name, `../${v.id}.md`);
      delete current[name];
      governanceGate(memDir, opts.gate, opts.signal);
      const idxTmp = writeTempRegular(archive, "index.json", Buffer.from(JSON.stringify(current)), 0o600);
      governanceGate(memDir, opts.gate, opts.signal);
      replaceAtomic(archive, idxTmp, "index.json");
      return `restored: ${v.id}`;
    },
    { timeoutMs: 500 },
  );
}

/** Explicit review action. Caller owns the directory lock; unlike a sweep,
 * it need not alter expires or wait for the next automatic signal. */
export function archiveBlockLocked(memDir: string, id: string, rev: string, opts: SupersedeOptions = {}): string {
  governanceGate(memDir, opts.gate, opts.signal);
  const block = readGovernBlock(memDir, id);
  if (block.rev !== rev || block.meta.status !== "active") throw new MemoryError("E_CONFLICT");
  if (block.meta.authority === "user") throw new MemoryError("user rules cannot be archived");
  const archive = join(memDir, "blocks/archive"),
    mapping = readArchiveIndex(memDir),
    names = new Set(listDirNames(archive));
  let name = `${id}.md`;
  if (names.has(name)) {
    let n = 1;
    while (n <= 999 && names.has(`${id}.r${n}.md`)) n++;
    if (n > 999) throw new MemoryError("archive name exhaustion");
    name = `${id}.r${n}.md`;
  }
  governanceGate(memDir, opts.gate, opts.signal);
  ensurePrivateDir(archive);
  mapping[name] = { id, archivedAt: (opts.now ?? new Date()).toISOString(), reason: "review" };
  governanceGate(memDir, opts.gate, opts.signal);
  const indexTmp = writeTempRegular(archive, "index.json", Buffer.from(JSON.stringify(mapping)), 0o600);
  governanceGate(memDir, opts.gate, opts.signal);
  replaceAtomic(archive, indexTmp, "index.json");
  governanceGate(memDir, opts.gate, opts.signal);
  if (readGovernBlock(memDir, id).rev !== rev) throw new MemoryError("E_CONFLICT");
  renameNoClobber(join(memDir, "blocks"), `${id}.md`, `archive/${name}`);
  governanceGate(memDir, opts.gate, opts.signal);
  const tmp = writeTempRegular(
    archive,
    name,
    Buffer.from(
      serializeBlock(
        {
          ...block.meta,
          status: "archived",
          version: block.meta.version + 1,
          updated: (opts.now ?? new Date()).toISOString(),
        },
        block.body,
        { allowOversize: true },
      ),
    ),
    0o600,
  );
  governanceGate(memDir, opts.gate, opts.signal);
  replaceAtomic(archive, tmp, name);
  return name;
}
