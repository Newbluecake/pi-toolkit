/** Read-only drift detection and explicit, append-only legacy imports. */
import { clampSpanMs } from "../../core/deadline.js";
import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import { MemoryError } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import { readRegular, writeTempRegular, replaceAtomic, fsyncDir, createExclusive, listDirNames } from "../safe-fs.js";
import { readIndex } from "../jev/index-store.js";
import { entryHash } from "../jev/entries.js";
import { planMigration, type MigrationSource } from "./migrate-plan.js";
import { snapshotMigrationSources, plainMemoryWriteGate } from "./migrate.js";
import { readCorpus } from "./store.js";
import { parseBlockFile, serializeBlock } from "./format.js";
import { readMarker } from "./marker.js";
import { dirFormat, nextSeq } from "./naming.js";
interface LegacyImport {
  at: string;
  files: { name: string; sha256: string }[];
  created: string[];
}
function ledger(dir: string): LegacyImport[] {
  try {
    const raw: unknown = JSON.parse(readRegular(join(dir, "blocks"), ".legacy-import.json").text);
    if (
      !Array.isArray(raw) ||
      !raw.every(
        (r) =>
          r &&
          typeof r.at === "string" &&
          Array.isArray(r.files) &&
          r.files.every(
            (f: { name?: unknown; sha256?: unknown }) => typeof f.name === "string" && typeof f.sha256 === "string",
          ) &&
          Array.isArray(r.created),
      )
    )
      throw new Error("invalid ledger");
    return raw as LegacyImport[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MemoryError(`E_IMPORT_LEDGER: ${String(err)}`);
  }
}
export function legacyDrift(memDir: string): MigrationSource[] {
  if (dirFormat(memDir) !== "blocks") return [];
  let report: { files: { name: string; sha256: string }[] };
  try {
    report = JSON.parse(readRegular(join(memDir, "blocks"), ".migration-report.json").text) as typeof report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || readMarker(join(memDir, "blocks"))?.source !== "fresh")
      throw error;
    report = { files: [] };
  }
  const known = new Map(report.files.map((f) => [f.name, f.sha256]));
  for (const r of ledger(memDir)) for (const f of r.files) known.set(f.name, f.sha256);
  return snapshotMigrationSources(memDir).filter((f) => known.get(f.name) !== f.sha256);
}
export async function importLegacy(
  memDir: string,
  opts: { gate?: MemoryWriteGate; dryRun?: boolean; signal?: AbortSignal; now?: Date } = {},
): Promise<{ created: string[]; files: string[] }> {
  const gate = opts.gate ?? plainMemoryWriteGate;
  const deadline = Date.now() + (clampSpanMs(60000) ?? 1);
  let operations = 0;
  const check = (): void => {
    const v = gate.check(memDir);
    if (!v.ok) throw new MemoryError(`E_GATE: ${v.reason}`);
    if (opts.signal?.aborted) throw new MemoryError("E_ABORTED");
    if (Date.now() >= deadline || ++operations > 120000) throw new MemoryError("E_BUDGET");
  };
  check();
  if (opts.dryRun) return { created: [], files: legacyDrift(memDir).map((f) => f.name) };
  return withMemoryDirLock(
    memDir,
    () => {
      check();
      if (dirFormat(memDir) !== "blocks") throw new MemoryError("E_UNMIGRATED");
      const files = legacyDrift(memDir),
        now = opts.now ?? new Date(),
        plan = planMigration(files, readIndex(memDir).index, now.toISOString().slice(0, 10));
      const real = join(memDir, "blocks"),
        corpus = readCorpus(real),
        hashes = new Set(corpus.blocks.map((b) => entryHash(b.body))),
        created: string[] = [];
      for (const candidate of plan.blocks) {
        check();
        const b = parseBlockFile(candidate.name, candidate.content);
        if ("stray" in b) throw new MemoryError("E_IMPORT: invalid planned block");
        const hash = entryHash(b.body);
        if (hashes.has(hash)) continue;
        // Each create is atomic and independently recoverable. Interrupted imports dedup against the corpus on retry.
        const used = [
          ...listDirNames(real),
          ...listDirNames(join(real, "archive")),
          ...listDirNames(join(real, ".trash")),
        ];
        const name = `${b.topic}.${String(nextSeq(b.topic, used)).padStart(3, "0")}.md`;
        const raw = serializeBlock(
          { ...b.meta, created: now.toISOString(), updated: now.toISOString(), version: 1 },
          b.body,
          { allowOversize: true },
        );
        check();
        const tmp = writeTempRegular(real, name, Buffer.from(raw), 0o600);
        check();
        createExclusive(real, tmp, name);
        check();
        fsyncDir(real);
        created.push(name.slice(0, -3));
        hashes.add(hash);
      }
      if (files.length) {
        const next = [
          ...ledger(memDir),
          { at: now.toISOString(), files: files.map((f) => ({ name: f.name, sha256: f.sha256 })), created },
        ];
        check();
        const tmp = writeTempRegular(real, ".legacy-import.json", Buffer.from(JSON.stringify(next) + "\n"), 0o600);
        check();
        replaceAtomic(real, tmp, ".legacy-import.json");
        check();
        fsyncDir(real);
      }
      return { created, files: files.map((f) => f.name) };
    },
    { timeoutMs: 0, log: () => {} },
  );
}
