import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  scanCorpus,
  replayScan,
  generate,
  freezeBatch,
  promote,
  prepareDetails,
  registerRevisions,
  type BacktestDeps,
  type OrchestrateOptions,
  type ScanResult,
} from "../../../../src/reflex/core/backtest/orchestrate.js";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { identityKey, templateHash } from "../../../../src/reflex/core/identity.js";
import { buildLiveEvidence, evaluateMergedPromotion } from "../../../../src/reflex/core/promotion.js";
import { createBatch, emptyLedger, type LedgerState } from "../../../../src/reflex/core/backtest/ledger-format.js";
import { ALL_CAPS, TG, headerLine, userLine, assistantLine, hudLine, customLine } from "./fixtures-b1.js";
import { makeRecord, makeTurn } from "../../helpers/turn.js";
import { requestDigest } from "../../../../src/reflex/core/digest.js";
import {
  cacheVersions,
  decodeCache,
  encodeCache,
  invalidationKey,
  type FileStamp,
} from "../../../../src/reflex/core/backtest/cache-format.js";
import { splitOfRoot } from "../../../../src/reflex/core/backtest/split.js";

const opts: OrchestrateOptions = {
  builtin: BUILTIN_SCRIPTS,
  drafts: [],
  caps: ALL_CAPS,
  portVersions: new Map([
    ["jobs.list", 1],
    ["fleet.status", 1],
    ["quota.summary", 1],
    ["git.status", 1],
  ]),
};
function memory() {
  const files = new Map<string, string[]>();
  const stamps = new Map<string, FileStamp>();
  let cache: string | undefined;
  let state: LedgerState = emptyLedger();
  const events: string[] = [],
    reads: string[] = [];
  const failed = new Set<string>();
  const deps: BacktestDeps = {
    listFiles: async () => [...stamps.values()],
    async *readLines(file, headerOnly) {
      reads.push(`${file}:${headerOnly ? "header" : "body"}`);
      if (failed.has(file)) throw new Error("read denied");
      yield* (headerOnly ? files.get(file)?.slice(0, 1) : files.get(file)) ?? [];
    },
    cache: {
      read: async () => cache,
      write: async (text) => {
        cache = text;
      },
    },
    ledger: {
      read: async () => state,
      create: async (kind, value) => {
        events.push(`create:${kind}`);
        if (kind === "manifest" && "manifestHash" in value && !("batchId" in value)) {
          if (state.manifests.some((m) => m.manifestHash === value.manifestHash)) throw new Error("EEXIST");
          state = { ...state, manifests: [...state.manifests, value] };
        } else if (kind === "batch" && "batchId" in value) {
          if (state.batches.some((b) => b.batchId === value.batchId)) throw new Error("EEXIST");
          state = { ...state, batches: [...state.batches, value] };
        }
      },
      append: async (kind, value) => {
        events.push(`append:${kind}`);
        if (kind === "revision" && "firstSeenAt" in value) state = { ...state, revisions: [...state.revisions, value] };
        else if (kind === "exposure" && "via" in value) state = { ...state, exposures: [...state.exposures, value] };
      },
    },
    clock: { now: () => TG - 500 },
  };
  return {
    deps,
    files,
    stamps,
    events,
    reads,
    failed,
    get state() {
      return state;
    },
    set state(v: LedgerState) {
      state = v;
    },
    put(file: string, lines: string[]) {
      files.set(file, lines);
      stamps.set(file, { file, size: lines.join("\n").length, mtimeMs: 1, dev: 1, ino: stamps.size + 1 });
    },
  };
}
function session(id: string, at = TG - 1000, text = "后台还有几个 job") {
  return [
    headerLine({ id, at }),
    userLine({ id: `${id}-u`, at: TG, text }),
    assistantLine({ id: `${id}-a`, at: TG + 1, stopReason: "stop", toolCalls: [{ name: "bash_job", action: "list" }] }),
    hudLine({ id: `${id}-h`, at: TG + 2 }),
  ];
}
const filter = { since: TG - 100, until: TG + 100000 };
function holdoutScan(base: ScanResult): ScanResult {
  const turns = Array.from({ length: 50 }, (_, i) =>
    makeTurn({
      session: `s${i}`,
      entryId: `u${i}`,
      at: TG + i * 1000000,
      settledAt: TG + i * 1000000 + 1,
      text: "后台还有几个 job",
      digest: `d${i}`,
      split: "holdout",
      shapes: ["write"],
      hasWrite: true,
    }),
  );
  return { ...base, turns, corrections: [] };
}
function addLive(scan: ScanResult): ScanResult {
  return {
    ...scan,
    liveRows: Array.from({ length: 50 }, (_, i) => ({
      kind: "record" as const,
      rec: makeRecord({
        scriptId: "jobs.list",
        at: TG + i * 1000000,
        requestDigest: `live${i}`,
        model: { agree: "agree", tools: ["bash_job:list"] },
        port: { outcome: "ok", ms: 2, portVer: 1 },
      }),
      entryId: `r${i}`,
      session: `s${i}`,
      at: TG + i * 1000000,
    })),
  };
}
describe("B3 orchestration", () => {
  it("cold/warm Turn/Correction/Replay/evidence equality, with header-timestamp ascending fork feed", async () => {
    const m = memory();
    const original = session("root");
    m.put("/s/aaa-fork.jsonl", [
      headerLine({ id: "fork", at: TG - 100, parentSession: "/s/zzz-parent.jsonl" }),
      ...original.slice(1),
    ]);
    m.put("/s/zzz-parent.jsonl", original);
    const cold = await scanCorpus(m.deps, filter);
    expect(cold.turns).toHaveLength(1);
    expect(cold.turns[0]?.session).toBe("root");
    expect(cold.turns[0]?.unknownFacts).toEqual([]);
    expect(m.reads.filter((r) => r.endsWith("body"))).toEqual(["/s/zzz-parent.jsonl:body", "/s/aaa-fork.jsonl:body"]);
    const warm = await scanCorpus(m.deps, filter);
    expect(warm.cacheMode).toBe("warm");
    expect(cold.cacheMode).toBe("cold");
    expect(warm.turns).toEqual(cold.turns);
    expect(warm.corrections).toEqual(cold.corrections);
    expect(replayScan(warm, opts)).toEqual(replayScan(cold, opts));
    expect(await promote(m.deps, warm, opts, "jobs.list")).toEqual(await promote(m.deps, cold, opts, "jobs.list"));
    expect(m.reads).toHaveLength(4);
  });
  it.each(["size", "mtimeMs", "dev", "ino"] as const)("file %s mutation rebuilds whole family index", async (field) => {
    const m = memory();
    m.put("/s/a.jsonl", session("a"));
    await scanCorpus(m.deps, filter);
    const stamp = m.stamps.get("/s/a.jsonl")!;
    m.stamps.set(stamp.file, { ...stamp, [field]: stamp[field] + 1 });
    expect((await scanCorpus(m.deps, filter)).cacheMode).toBe("cold");
    expect(m.reads).toHaveLength(4);
  });
  it.each(["markersVersion", "correctionHash"] as const)(
    "scanCorpus rebuilds a valid cache written under a prior %s",
    async (field) => {
      const m = memory();
      m.put("/s/a.jsonl", session("a"));
      const cold = await scanCorpus(m.deps, filter);
      const priorVersions = { ...cacheVersions(), [field]: "previous-semantic-version" };
      const priorKey = invalidationKey([...m.stamps.values()], priorVersions);
      const priorCache = { ...cold.corpus, key: priorKey };
      const text = encodeCache(priorCache);
      // The fixture is internally valid, not a truncated/corrupted cache fallback.
      expect(decodeCache(text, priorKey)).toEqual(priorCache);
      await m.deps.cache.write(text);
      m.reads.length = 0;
      const rebuilt = await scanCorpus(m.deps, filter);
      expect(rebuilt.cacheMode).toBe("cold");
      expect(m.reads).toEqual(["/s/a.jsonl:header", "/s/a.jsonl:body"]);
      expect(rebuilt.corpus).toEqual(cold.corpus);
      expect((await scanCorpus(m.deps, filter)).cacheMode).toBe("warm");
      expect(m.reads).toHaveLength(2);
    },
  );
  it("changed parent link invalidates family split and warm cache", async () => {
    const m = memory();
    m.put("/s/a.jsonl", session("a"));
    await scanCorpus(m.deps, filter);
    m.files.get("/s/a.jsonl")![0] = headerLine({ id: "a", at: TG - 1000, parentSession: "/s/missing.jsonl" });
    m.stamps.get("/s/a.jsonl")!.mtimeMs++;
    const next = await scanCorpus(m.deps, filter);
    expect(next.turns[0]?.split).toBe("unscored");
    expect(next.unresolved).toEqual({ "missing-parent": 1 });
  });
  it("read failure or invalid JSON cannot yield eligible, even with sufficient real-time rows", async () => {
    const m = memory();
    m.put("/s/good.jsonl", session("good"));
    m.put("/s/bad.jsonl", session("bad"));
    m.failed.add("/s/bad.jsonl");
    const scan = addLive(await scanCorpus(m.deps, filter));
    expect(scan.scanComplete).toBe(false);
    expect((await promote(m.deps, scan, opts, "jobs.list")).reasons).toContain("scan-incomplete");
    m.failed.clear();
    m.files.get("/s/bad.jsonl")!.push("broken");
    expect((await scanCorpus(m.deps, filter)).scanComplete).toBe(false);
  });
  it("promote uses EXACT same live-only verdict as B5; shadow source also calls shared entrance", async () => {
    const m = memory();
    const scan = addLive(await scanCorpus(m.deps, filter));
    const live = buildLiveEvidence(scan.liveRows, opts.builtin, opts.drafts);
    const script = BUILTIN_SCRIPTS.find((s) => s.id === "jobs.list")!;
    const identity = { lineage: script.id, templateHash: templateHash(script), portId: script.port.id, portVer: 1 };
    expect(await promote(m.deps, scan, opts, "jobs.list")).toEqual(
      evaluateMergedPromotion({
        identity,
        live: live.stats.get(identityKey(identity))!,
        port: live.ports.get("jobs.list@1")!,
        scanComplete: true,
      }),
    );
    expect(readFileSync(new URL("../../../../scripts/dev/reflex-shadow.mjs", import.meta.url), "utf8")).toContain(
      "buildLiveEvidence(liveRows",
    );
  });
  it("target portVer receives @0 missing bucket, never old-version success", async () => {
    const m = memory();
    const scan = addLive(await scanCorpus(m.deps, filter));
    const missing = {
      kind: "record" as const,
      rec: makeRecord({ scriptId: "jobs.list", requestDigest: "missing" }),
      entryId: "missing",
      session: "new",
      at: TG,
    };
    const v = await promote(
      m.deps,
      { ...scan, liveRows: [...scan.liveRows, missing] },
      { ...opts, portVersions: new Map([["jobs.list", 2]]) },
      "jobs.list",
    );
    expect(v.verdict).toBe("undetermined");
    expect(v.reasons).toContain("port-missing");
  });
  it("current valid batch with unreviewed/new suspect stays review-incomplete even if live sufficient", async () => {
    const m = memory();
    const scan = addLive(holdoutScan(await scanCorpus(m.deps, filter)));
    const batch = createBatch("jobs.list", scan.manifest.manifestHash, scan.turns, 0, 0, TG + 100000000, TG);
    m.state = {
      ...m.state,
      manifests: [scan.manifest],
      batches: [batch],
      reviews: [
        {
          v: 1,
          unverified: true,
          entries: scan.turns
            .slice(0, -1)
            .map((t) => ({ digest: t.digest, portId: "jobs.list", verdict: "ok" as const, at: TG })),
        },
      ],
    };
    const verdict = await promote(m.deps, scan, opts, "jobs.list", batch.batchId);
    expect(verdict.verdict).toBe("not-eligible");
    expect(verdict.reasons).toContain("review-incomplete");
    m.state = {
      ...m.state,
      reviews: [
        {
          v: 1,
          unverified: true,
          entries: scan.turns.map((t, i) => ({
            digest: t.digest,
            portId: "jobs.list",
            verdict: i === 0 ? "misfire" : "ok",
            at: TG,
          })),
        },
      ],
    };
    expect((await promote(m.deps, scan, opts, "jobs.list", batch.batchId)).reasons).toContain("misfire");
  });
  it.each(["manifest-mismatch", "batch-invalid", "turnKeys-incomplete"] as const)(
    "%s batch is excluded: entire verdict equals authoritative live-only result",
    async (reason) => {
      const m = memory();
      const scan = addLive(holdoutScan(await scanCorpus(m.deps, filter)));
      const batch = createBatch("jobs.list", scan.manifest.manifestHash, scan.turns, 0, 0, TG + 100000000, TG);
      m.state = { ...m.state, manifests: [scan.manifest], batches: [batch] };
      const live = buildLiveEvidence(scan.liveRows, opts.builtin, opts.drafts);
      const script = BUILTIN_SCRIPTS.find((s) => s.id === "jobs.list")!;
      const identity = { lineage: script.id, templateHash: templateHash(script), portId: script.port.id, portVer: 1 };
      const liveOnly = evaluateMergedPromotion({
        identity,
        live: live.stats.get(identityKey(identity))!,
        port: live.ports.get("jobs.list@1")!,
        scanComplete: scan.scanComplete,
      });
      expect(liveOnly.verdict).toBe("eligible");
      let expired = scan;
      if (reason === "manifest-mismatch")
        expired = { ...scan, manifest: { ...scan.manifest, manifestHash: "expired" } };
      else if (reason === "batch-invalid")
        m.state = {
          ...m.state,
          exposures: [{ v: 1, lineage: "jobs.list", templateHash: "old", batchId: batch.batchId, at: TG, via: "show" }],
        };
      else expired = { ...scan, turns: scan.turns.slice(0, -1) };
      expect(await promote(m.deps, expired, opts, "jobs.list", batch.batchId)).toEqual(liveOnly);
      // Negative control: the same batch/rows are usable, so its unreviewed suspects must
      // affect the verdict and carry the frozen evidence tuple rather than being ignored.
      m.state = { ...m.state, exposures: [] };
      const valid = await promote(m.deps, scan, opts, "jobs.list", batch.batchId);
      expect(valid).not.toEqual(liveOnly);
      expect(valid.verdict).toBe("not-eligible");
      expect(valid.reasons).toContain("review-incomplete");
      expect(valid.batchId).toBe(batch.batchId);
      expect(valid.manifestHash).toBe(batch.manifestHash);
    },
  );
  it("first seen records revisions before evaluation, and preserves firstSeen on later commands", async () => {
    const m = memory();
    const scan = await scanCorpus(m.deps, filter);
    await promote(m.deps, scan, opts, "jobs.list");
    expect(m.events[0]).toBe("append:revision");
    const n = m.state.revisions.length;
    await registerRevisions(m.deps, opts);
    expect(m.state.revisions).toHaveLength(n);
    const changed = { ...BUILTIN_SCRIPTS[0]!, intent: { ...BUILTIN_SCRIPTS[0]!.intent, weak: ["unique"] } };
    await registerRevisions(m.deps, { ...opts, builtin: [changed] });
    expect(m.state.revisions).toHaveLength(n + 1);
  });
  it("freeze selects admitted new holdout; immutable batch cannot be overwritten", async () => {
    const m = memory();
    let id = "";
    for (let i = 0; i < 100; i++)
      if (splitOfRoot(`h${i}`) === "holdout") {
        id = `h${i}`;
        break;
      }
    m.put("/s/h.jsonl", session(id));
    const scan = await scanCorpus(m.deps, filter);
    const result = await freezeBatch(m.deps, scan, opts, "jobs.list", filter);
    expect(result.ok).toBe(true);
    expect(m.events.slice(-2)).toEqual(["create:manifest", "create:batch"]);
    expect(m.state.batches[0]?.turnKeys).toHaveLength(1);
    await expect(freezeBatch(m.deps, scan, opts, "jobs.list", filter)).rejects.toThrow("EEXIST");
    await expect(m.deps.ledger.create("manifest", scan.manifest)).rejects.toThrow("EEXIST");
  });
  it("freeze has no writes on rejected scan/no-new/exposed candidates", async () => {
    const m = memory();
    const scan = holdoutScan(await scanCorpus(m.deps, filter));
    await registerRevisions(m.deps, opts);
    m.events.length = 0;
    expect((await freezeBatch(m.deps, { ...scan, scanComplete: false }, opts, "jobs.list", filter)).ok).toBe(false);
    expect(
      (
        await freezeBatch(
          m.deps,
          { ...scan, turns: scan.turns.map((t) => ({ ...t, at: TG - 1000 })) },
          opts,
          "jobs.list",
          filter,
        )
      ).ok,
    ).toBe(false);
    const old = createBatch("jobs.list", scan.manifest.manifestHash, scan.turns, 0, 0, TG + 1, TG);
    m.state = {
      ...m.state,
      batches: [old],
      exposures: [{ v: 1, lineage: "jobs.list", templateHash: "old", batchId: old.batchId, at: TG, via: "report" }],
    };
    expect((await freezeBatch(m.deps, scan, opts, "jobs.list", filter)).ok).toBe(false);
    expect(m.events).toEqual([]);
  });
  it("detail display records holdout exposure; aggregate selection produces none", async () => {
    const m = memory();
    const scan = holdoutScan(await scanCorpus(m.deps, filter));
    const rows = replayScan(scan, opts);
    const batch = createBatch("jobs.list", scan.manifest.manifestHash, scan.turns, 0, 0, TG + 1, TG);
    const state = { ...m.state, batches: [batch] };
    const prepared = prepareDetails(rows, state, opts, "show", TG);
    expect(prepared.exposures).toHaveLength(1);
    expect(prepared.exposures[0]?.via).toBe("show");
    expect(prepareDetails(rows, state, opts, "report", TG, () => false).exposures).toEqual([]);
    expect(
      prepareDetails(
        rows.map((r) => ({ ...r, turn: { ...r.turn, split: "train" as const } })),
        state,
        opts,
        "report",
        TG,
      ).exposures,
    ).toEqual([]);
  });
  it("generate uses ONLY train, B1 replay and B2 refinement, produces loader-valid drafts", async () => {
    const m = memory();
    const base = await scanCorpus(m.deps, filter);
    const turns = Array.from({ length: 5 }, (_, i) =>
      makeTurn({
        session: "train",
        entryId: `u${i}`,
        at: TG + i * 1000000,
        text: `后台第 ${i + 1} 个任务呢`,
        digest: requestDigest(`后台第 ${i + 1} 个任务呢`),
        split: "train",
      }),
    );
    const result = generate(
      { ...base, turns: [...turns, makeTurn({ session: "hold", entryId: "h", split: "holdout", text: "留出污染" })] },
      opts,
    );
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("留出污染");
    expect(result.drafts[0]?.port.id).toBe("jobs.list");
  });
  it("reviewed misfires are exposed even if replay now agrees", async () => {
    const m = memory();
    const scan = holdoutScan(await scanCorpus(m.deps, filter));
    const rows = replayScan(scan, opts).map((r) => {
      const { suspect: _suspect, ...rest } = r;
      return {
        ...rest,
        cls: { k: "high" as const, scriptId: "jobs.list", layer: "builtin" as const, agree: "agree" as const },
      };
    });
    const batch = createBatch("jobs.list", scan.manifest.manifestHash, scan.turns, 0, 0, TG + 1, TG);
    const state: LedgerState = {
      ...m.state,
      batches: [batch],
      reviews: [
        {
          v: 1,
          unverified: true,
          entries: [{ digest: scan.turns[0]!.digest, portId: "jobs.list", verdict: "misfire", at: TG }],
        },
      ],
    };
    const prepared = prepareDetails(rows, state, opts, "report", TG, (r) => r.suspect !== undefined);
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows[0]?.suspect).toBe("reviewed-misfire");
    expect(prepared.exposures).toHaveLength(1);
  });
  it("late main-session child references remove previously collected child turns", async () => {
    const m = memory();
    m.put("/s/child.jsonl", session("child", TG - 2000));
    m.put("/s/main.jsonl", [
      headerLine({ id: "main", at: TG - 1000 }),
      customLine({ id: "ref", at: TG, customType: "subagent:run", data: { diag: { sessionFile: "/s/child.jsonl" } } }),
    ]);
    const scan = await scanCorpus(m.deps, filter);
    expect(scan.turns).toEqual([]);
    expect(scan.corrections).toEqual([]);
    expect(scan.counts["childFiles"]).toBe(1);
  });
  it("warm cache retains live envelope evidence, and no-cache is behaviorally equal", async () => {
    const m = memory();
    m.put("/s/a.jsonl", [
      ...session("a"),
      customLine({
        id: "r",
        at: TG + 3,
        customType: "subagent:reflex-record",
        data: makeRecord({
          scriptId: "jobs.list",
          at: TG + 3,
          requestDigest: "native",
          port: { outcome: "ok", ms: 2, portVer: 1 },
        }),
      }),
    ]);
    const cold = await scanCorpus(m.deps, filter),
      warm = await scanCorpus(m.deps, filter),
      uncached = await scanCorpus(m.deps, filter, true);
    expect(warm.liveRows).toEqual(cold.liveRows);
    expect(uncached.corpus).toEqual(cold.corpus);
    expect([...buildLiveEvidence(warm.liveRows, opts.builtin, []).stats]).toEqual([
      ...buildLiveEvidence(cold.liveRows, opts.builtin, []).stats,
    ]);
  });
  it("long multiline corrections survive while corpus keeps only single short turns", async () => {
    const m = memory();
    m.put("/s/a.jsonl", [
      ...session("a"),
      userLine({ id: "long", at: TG + 5, text: "不是这个\n" + "请修正".repeat(100) }),
    ]);
    const scan = await scanCorpus(m.deps, filter);
    expect(scan.turns).toHaveLength(1);
    expect(scan.corrections.some((c) => c.entryId === "long" && c.corrHit)).toBe(true);
  });
});
