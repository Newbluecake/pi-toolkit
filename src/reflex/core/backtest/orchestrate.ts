/** B3 offline orchestration. I/O belongs to injected ports; no pi, fs, network or module state. */
import { resolve } from "node:path";
import { identityKey, templateHash } from "../identity.js";
import { normalizeInput } from "../normalize.js";
import {
  admitBatch,
  batchValidity,
  buildLiveEvidence,
  evaluateMergedPromotion,
  lastRevisedAt,
  type LiveEvidenceRow,
} from "../promotion.js";
import { scanReflexLine } from "../shadow-scan.js";
import type {
  Capability,
  CorpusFilter,
  EvidenceIdentity,
  ExposureRecordV1,
  PortId,
  PromotionVerdictV2,
  ReplayRow,
  RScriptV1,
  Turn,
} from "../types.js";
import {
  cacheVersions,
  decodeCache,
  encodeCache,
  invalidationKey,
  type CachedFile,
  type CorpusCache,
  type FileStamp,
} from "./cache-format.js";
import { buildFamilyIndex, createCorpusBuilder, parseSessionHeader, parseTimestamp, resolveFamily } from "./corpus.js";
import { clusterTurns } from "./cluster.js";
import { generateDrafts, refineDrafts, type GenerateResult } from "./draft-gen.js";
import { backtestEvidence, highIdentityOf, turnKeyOf } from "./evidence.js";
import { createBatch, createManifest, type LedgerPort, type LedgerState } from "./ledger-format.js";
import { replay } from "./replay.js";

export interface BacktestDeps {
  listFiles(): Promise<readonly FileStamp[]>;
  readLines(file: string, headerOnly?: boolean): AsyncIterable<string>;
  cache: { read(): Promise<string | undefined>; write(text: string): Promise<void> };
  ledger: LedgerPort;
  clock: { now(): number };
}
export interface ScanResult {
  corpus: CorpusCache;
  turns: readonly Turn[];
  corrections: CorpusCache["corrections"];
  liveRows: readonly LiveEvidenceRow[];
  manifest: ReturnType<typeof createManifest>;
  scanComplete: boolean;
  errors: readonly string[];
  cacheMode: "cold" | "warm";
  scannedBytes: number;
  counts: Readonly<Record<string, number>>;
  unresolved: Readonly<Record<string, number>>;
}
function select(corpus: CorpusCache, f: CorpusFilter, warm: boolean, errors: string[]): ScanResult {
  const inRange = (at: number) => at >= f.since && (f.until === undefined || at < f.until);
  const cwdMatch = (cwd: string) => f.cwd === undefined || resolve(cwd) === resolve(f.cwd);
  const sessions = new Set(corpus.files.filter((x) => cwdMatch(x.header.cwd)).map((x) => x.header.file));
  const turns = corpus.turns.filter((t) => inRange(t.at) && cwdMatch(t.cwd));
  const sessionIds = new Set(corpus.files.filter((x) => cwdMatch(x.header.cwd)).map((x) => x.header.id));
  const corrections = corpus.corrections.filter((t) => t.at >= f.since && sessionIds.has(t.session));
  const liveRows = corpus.liveRows.filter(
    (r) => r.at !== undefined && inRange(r.at) && r.session !== undefined && sessions.has(r.session),
  );
  const families = buildFamilyIndex(corpus.files.map((x) => x.header));
  const unresolved: Record<string, number> = {};
  for (const file of corpus.files) {
    const r = resolveFamily(file.header.file, families);
    if (r.reason) unresolved[r.reason] = (unresolved[r.reason] ?? 0) + 1;
  }
  const counts = {
    ...corpus.counts,
    windowCwd: turns.length,
    train: turns.filter((t) => t.split === "train").length,
    holdout: turns.filter((t) => t.split === "holdout").length,
    unscored: turns.filter((t) => t.split === "unscored").length,
  };
  return {
    corpus,
    turns,
    corrections,
    liveRows,
    manifest: createManifest(corpus.files),
    scanComplete: errors.length === 0,
    errors,
    cacheMode: warm ? "warm" : "cold",
    scannedBytes: corpus.files.reduce((s, f) => s + f.stamp.size, 0),
    counts,
    unresolved,
  };
}
/** Whole-cache invalidation on a file change is intentional: claims/fences/child provenance cross files. */
export async function scanCorpus(deps: BacktestDeps, filter: CorpusFilter, noCache = false): Promise<ScanResult> {
  const errors: string[] = [];
  let stamps: readonly FileStamp[] = [];
  try {
    stamps = [...(await deps.listFiles())].sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    errors.push("list-files");
  }
  const key = invalidationKey(stamps, cacheVersions());
  if (!noCache && errors.length === 0) {
    try {
      const text = await deps.cache.read();
      const cached = text === undefined ? undefined : decodeCache(text, key);
      if (cached) return select(cached, filter, true, errors);
    } catch {
      /* A broken cache is rebuilt, never used as partial evidence. */
    }
  }
  const files: CachedFile[] = [];
  // First pass ALL headers, including other cwd directories and old ancestors.
  for (const stamp of stamps) {
    try {
      let header;
      for await (const line of deps.readLines(stamp.file, true)) {
        header = parseSessionHeader(stamp.file, JSON.parse(line));
        break;
      }
      if (!header) {
        errors.push("invalid-header");
        continue;
      }
      files.push({ stamp, header, lines: 0, lastEntryId: "" });
    } catch {
      errors.push("header-read");
    }
  }
  files.sort((a, b) => a.header.timestamp - b.header.timestamp || a.header.file.localeCompare(b.header.file));
  const builder = createCorpusBuilder({ since: 0 }, buildFamilyIndex(files.map((f) => f.header)));
  let turns: Turn[] = [],
    corrections: CorpusCache["corrections"][number][] = [];
  const liveRows: LiveEvidenceRow[] = [];
  const counts = {
    files: stamps.length,
    headers: files.length,
    rawUsers: 0,
    parsedTurns: 0,
    singleShort: 0,
    childFiles: 0,
    childReferences: 0,
  };
  for (const file of files) {
    const accepted = builder.beginFile(file.header.file, { type: "session", ...file.header });
    try {
      for await (const line of deps.readLines(file.header.file)) {
        file.lines++;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(line) as Record<string, unknown>;
          if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error();
        } catch {
          errors.push("invalid-json");
          continue;
        }
        if (typeof e["id"] === "string") file.lastEntryId = e["id"];
        const message = e["message"] as Record<string, unknown> | undefined;
        if (e["type"] === "message" && message?.["role"] === "user") counts.rawUsers++;
        if (accepted === "ok") builder.line(line);
        const { row, entryId } = scanReflexLine(line);
        if (!row) {
          if (typeof e["customType"] === "string" && e["customType"].startsWith("subagent:reflex"))
            errors.push("invalid-reflex-row");
          continue;
        }
        const at =
          row.kind === "answer" ? parseTimestamp(e["timestamp"]) : row.kind === "record" ? row.rec.at : row.c.at;
        if (at === undefined || !Number.isFinite(at)) {
          errors.push("invalid-live-time");
          continue;
        }
        liveRows.push({ ...row, ...(entryId === undefined ? {} : { entryId }), session: file.header.file, at });
      }
    } catch {
      errors.push("body-read");
    }
    const out = builder.endFile();
    turns.push(...out.turns);
    corrections.push(...out.corrections);
    const revoked = builder.takeRevoked();
    const rt = new Set(revoked.turns),
      rc = new Set(revoked.corrections);
    turns = turns.filter((t) => !rt.has(t));
    corrections = corrections.filter((c) => !rc.has(c));
  }
  const children = builder.childFiles();
  const childIds = new Set(files.filter((f) => children.has(resolve(f.header.file))).map((f) => f.header.id));
  turns = turns.filter((t) => !childIds.has(t.session));
  corrections = corrections.filter((c) => !childIds.has(c.session));
  counts.childFiles = files.filter((f) => children.has(resolve(f.header.file))).length;
  counts.childReferences = children.size;
  counts.parsedTurns = turns.length;
  turns = turns.filter((t) => {
    const n = normalizeInput(t.text);
    return n.lines === 1 && n.chars <= 120;
  });
  counts.singleShort = turns.length;
  // A concurrent append/replacement cannot create a warm cache bearing the earlier file stamps.
  try {
    if (invalidationKey(await deps.listFiles()) !== key) errors.push("files-changed-during-scan");
  } catch {
    errors.push("restat-files");
  }
  const corpus: CorpusCache = { key, files, turns, corrections, liveRows, counts };
  if (!noCache && errors.length === 0)
    try {
      await deps.cache.write(encodeCache(corpus));
    } catch {
      errors.push("cache-write");
    }
  return select(corpus, filter, false, errors);
}
export interface OrchestrateOptions {
  builtin: readonly RScriptV1[];
  drafts: readonly RScriptV1[];
  caps: ReadonlySet<Capability>;
  portVersions: ReadonlyMap<PortId, number>;
  gitCommitAt?: number;
  draftSource?: "draft-file" | "drafts-out";
}
export function replayScan(scan: ScanResult, opts: OrchestrateOptions): readonly ReplayRow[] {
  return replay(scan.turns, scan.corrections, { builtin: opts.builtin, drafts: opts.drafts }, opts.caps);
}
/** Register first-seen BEFORE every identity-dependent command, including show/review/report. */
export async function registerRevisions(deps: BacktestDeps, opts: OrchestrateOptions): Promise<LedgerState> {
  let state = await deps.ledger.read();
  for (const s of [...opts.builtin, ...opts.drafts]) {
    const lineage = s.lineage ?? s.id,
      th = templateHash(s);
    if (state.revisions.some((r) => r.lineage === lineage && r.templateHash === th)) continue;
    await deps.ledger.append("revision", {
      v: 1,
      lineage,
      templateHash: th,
      firstSeenAt: deps.clock.now(),
      source: s.origin === "builtin" ? "catalog" : (opts.draftSource ?? "draft-file"),
      ...(s.origin === "builtin" && opts.gitCommitAt !== undefined ? { gitCommitAt: opts.gitCommitAt } : {}),
    });
    state = await deps.ledger.read();
  }
  return state;
}
export function generate(
  scan: ScanResult,
  opts: OrchestrateOptions,
  assign?: ReadonlyMap<string, PortId>,
  minGroup = 3,
): GenerateResult {
  const train = scan.turns.filter((t) => t.split === "train");
  const clustered = clusterTurns(train);
  const generated = generateDrafts(
    clustered.clusters,
    { turns: train, negatives: train.filter((t) => t.hasWrite).map((t) => normalizeInput(t.text).norm) },
    assign,
    { minGroup },
  );
  const refined = refineDrafts(generated.drafts, train, (drafts, turns) =>
    replay(turns, scan.corrections, { builtin: opts.builtin, drafts }, opts.caps).flatMap((r) =>
      r.cls.k === "high" && r.cls.layer === "draft"
        ? [{ draftId: r.cls.scriptId, turn: r.turn, band: "high" as const }]
        : [],
    ),
  );
  return {
    drafts: refined.drafts,
    needsPort: generated.needsPort,
    skips: Object.fromEntries(
      Object.entries(generated.skips).map(([k, v]) => [k, v + (refined.skips[k as keyof typeof refined.skips] ?? 0)]),
    ) as GenerateResult["skips"],
  };
}
export async function freezeBatch(
  deps: BacktestDeps,
  scan: ScanResult,
  opts: OrchestrateOptions,
  lineage: string,
  filter: CorpusFilter,
) {
  const state = await registerRevisions(deps, opts);
  if (!scan.scanComplete) return { ok: false as const, reason: "scan-incomplete" };
  if (![...opts.builtin, ...opts.drafts].some((s) => (s.lineage ?? s.id) === lineage))
    return { ok: false as const, reason: "unknown-lineage" };
  // Automatically select NEW, unexposed holdout turns; then call authoritative admission.
  const cutoff = lastRevisedAt(lineage, state.revisions);
  const exposedIds = new Set(state.exposures.map((e) => e.batchId));
  const used = new Set(state.batches.filter((b) => exposedIds.has(b.batchId)).flatMap((b) => [...b.turnDigests]));
  const candidate = scan.turns.filter((t) => t.split === "holdout" && t.at > cutoff && !used.has(t.digest));
  if (candidate.length === 0) return { ok: false as const, reason: "no-new-holdout" };
  const admission = admitBatch(candidate, lineage, state.revisions, state.batches, state.exposures);
  if (!admission.ok) return { ok: false as const, reason: admission.reason ?? "admission" };
  const batch = createBatch(
    lineage,
    scan.manifest.manifestHash,
    candidate,
    admission.cutoffAt,
    filter.since,
    filter.until ?? deps.clock.now(),
    deps.clock.now(),
  );
  if (!state.manifests.some((m) => m.manifestHash === scan.manifest.manifestHash))
    await deps.ledger.create("manifest", scan.manifest);
  await deps.ledger.create("batch", batch);
  return { ok: true as const, batch };
}
export async function promote(
  deps: BacktestDeps,
  scan: ScanResult,
  opts: OrchestrateOptions,
  scriptId: string,
  batchId?: string,
): Promise<PromotionVerdictV2> {
  const state = await registerRevisions(deps, opts);
  const script = [...opts.builtin, ...opts.drafts].find((s) => s.id === scriptId);
  if (!script) throw new Error("unknown script");
  const identity: EvidenceIdentity = {
    lineage: script.lineage ?? script.id,
    templateHash: templateHash(script),
    portId: script.port.id,
    portVer: opts.portVersions.get(script.port.id) ?? 0,
  };
  const evidence = buildLiveEvidence(scan.liveRows, opts.builtin, opts.drafts);
  const live = evidence.stats.get(identityKey(identity));
  const port = evidence.ports.get(`${identity.portId}@${identity.portVer}`) ?? {
    portId: identity.portId,
    portVer: identity.portVer,
    runs: 0,
    ok: 0,
    unavailable: 0,
    missing: evidence.ports.get(`${identity.portId}@0`)?.missing ?? 0,
  };
  const batch = state.batches.find((b) => b.batchId === batchId && b.lineage === identity.lineage);
  const valid = batch ? batchValidity(batch, identity, state.exposures, state.manifests) : undefined;
  const keys = new Set(scan.turns.map(turnKeyOf));
  // Invalid/expired batches are regression only. Do not pass poisoned backtest to B5.
  const usable =
    batch && valid?.ok && batch.manifestHash === scan.manifest.manifestHash && batch.turnKeys.every((k) => keys.has(k));
  const rows = usable
    ? replayScan(scan, opts).filter((r) => {
        const i = highIdentityOf(r, opts.builtin, opts.drafts);
        return i !== undefined && identityKey(i) === identityKey(identity);
      })
    : [];
  const backtest = usable
    ? backtestEvidence(rows, batch, identity, {
        v: 1,
        unverified: true,
        entries: state.reviews.flatMap((r) => [...r.entries]),
      })
    : undefined;
  return evaluateMergedPromotion({
    identity,
    ...(live ? { live } : {}),
    port,
    scanComplete: scan.scanComplete,
    ...(backtest ? { backtest, batchValid: valid! } : {}),
  });
}
/** Include previously recorded misfires in the display list even when replay now agrees. */
export function applyReviews(
  rows: readonly ReplayRow[],
  state: LedgerState,
  opts: OrchestrateOptions,
): readonly ReplayRow[] {
  return rows.map((row) => {
    const identity = highIdentityOf(row, opts.builtin, opts.drafts);
    const misfire =
      identity &&
      state.reviews.some((review) =>
        review.entries.some(
          (e) => e.digest === row.turn.digest && e.portId === identity.portId && e.verdict === "misfire",
        ),
      );
    return misfire ? { ...row, suspect: "reviewed-misfire" as const } : row;
  });
}
/** Detail display preparation, not persistence. The caller MUST append before printing. */
export function prepareDetails(
  rows: readonly ReplayRow[],
  state: LedgerState,
  opts: OrchestrateOptions,
  via: ExposureRecordV1["via"],
  at: number,
  filter: (row: ReplayRow) => boolean = () => true,
) {
  const selected = applyReviews(rows, state, opts).filter(filter);
  const exposures: ExposureRecordV1[] = [];
  const seen = new Set<string>();
  for (const row of selected) {
    if (row.turn.split !== "holdout" || row.suspect === undefined) continue;
    const identity = highIdentityOf(row, opts.builtin, opts.drafts);
    if (!identity) continue;
    for (const batch of state.batches) {
      if (batch.lineage !== identity.lineage || !batch.turnKeys.includes(turnKeyOf(row.turn))) continue;
      const key = `${batch.batchId}:${identityKey(identity)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      exposures.push({
        v: 1,
        lineage: identity.lineage,
        templateHash: identity.templateHash,
        batchId: batch.batchId,
        at,
        via,
      });
    }
  }
  return { rows: selected, exposures };
}
