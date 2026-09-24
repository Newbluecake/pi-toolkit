import { describe, expect, it } from "vitest";
import type { RunId, RunSnapshot } from "../../src/core/types.js";
import { createExpertIndex, isUnderDir } from "../../src/consult/expert-index.js";
import { matchRunId, type ResolveTargetDeps } from "../../src/service/resolve-target.js";

/**
 * T-1 (consult plan §9): the ExpertIndex keeps terminal+persisted records,
 * structurally excludes consult runs (sessionFile under the consult dir),
 * and resolves ids with the SAME implementation resolve-target uses
 * (matchRunId) — the same fixture is run through both here so the two can
 * never drift. Label semantics are the index's own (§4.5): return ALL
 * same-label records; cross-source ambiguity is resolved by the caller.
 */

const CONSULT_DIR = "/cache/consult-sessions";

function entry(snap: RunSnapshot): unknown {
  return { type: "custom", customType: "subagent:run", data: snap };
}

function runSnapshot(opts: {
  runId: RunId;
  status?: RunSnapshot["status"];
  sessionFile?: string;
  label?: string;
  agentType?: string;
  lastTurnStartAtHack?: never;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  updatedAt?: number;
}): RunSnapshot {
  return {
    runId: opts.runId,
    generation: 1,
    status: opts.status ?? "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(opts.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}),
      ...(opts.contextUsage !== undefined ? { contextUsage: opts.contextUsage } : {}),
    },
    updatedAt: opts.updatedAt ?? 1000,
  };
}

const ALPHA1 = runSnapshot({
  runId: "r_ALPHA0001",
  label: "explorer",
  agentType: "explorer",
  sessionFile: "/sessions/r_ALPHA0001.jsonl",
  contextUsage: { tokens: 120_000, contextWindow: 200_000, percent: 60 },
  updatedAt: 2000,
});
const ALPHA2 = runSnapshot({
  runId: "r_ALPHA0002",
  label: "explorer", // same label across reload generations — both stay
  agentType: "planner",
  sessionFile: "/sessions/r_ALPHA0002.jsonl",
  updatedAt: 4000,
});
const RUNNING = runSnapshot({
  runId: "r_BETARUN1",
  status: "running",
  label: "live",
  agentType: "worker",
  sessionFile: "/sessions/r_BETARUN1.jsonl",
});
const NO_SESSION_FILE = runSnapshot({ runId: "r_NOFILE001", label: "ephemeral", agentType: "worker" });
const CONSULT_RUN = runSnapshot({
  runId: "r_CONSULT01",
  label: "consult-abcd",
  agentType: "explorer",
  sessionFile: `${CONSULT_DIR}/fork-r_CONSULT01.jsonl`, // fork copy ⇒ never an expert
});

function buildIndex() {
  const index = createExpertIndex({ consultDir: CONSULT_DIR });
  index.rebuildFromEntries([
    entry(ALPHA1),
    entry(ALPHA2),
    entry(RUNNING),
    entry(NO_SESSION_FILE),
    entry(CONSULT_RUN),
    // Junk that must be tolerated without throwing:
    { type: "custom", customType: "other:thing", data: ALPHA1 },
    { type: "message", data: "hello" },
    { type: "custom", customType: "subagent:run" }, // no data at all
    { type: "custom", customType: "subagent:run", data: null },
    null,
    42,
  ]);
  return index;
}

describe("consult/expert-index: admission filter (T-1)", () => {
  it("keeps terminal runs with a persisted session; drops running / no-sessionFile / consult-dir runs and junk", () => {
    const index = buildIndex();
    const ids = index
      .list()
      .map((r) => r.runId)
      .sort();
    expect(ids).toEqual(["r_ALPHA0001", "r_ALPHA0002"]);
  });

  it("projects the fields consult pre-checks read", () => {
    const index = buildIndex();
    const record = index.resolveId("r_ALPHA0001").ok ? index.resolveId("r_ALPHA0001").record : undefined;
    expect(record).toMatchObject({
      runId: "r_ALPHA0001",
      label: "explorer",
      sessionFile: "/sessions/r_ALPHA0001.jsonl",
      agentType: "explorer",
      status: "completed",
      contextPercent: 60,
      contextTokens: 120_000,
      updatedAt: 2000,
    });
  });

  it("findByLabel returns ALL same-label records (reload generations)", () => {
    const index = buildIndex();
    expect(index.findByLabel("explorer").map((r) => r.runId)).toEqual(["r_ALPHA0001", "r_ALPHA0002"]);
    expect(index.findByLabel("nobody")).toEqual([]);
  });

  it("rebuild replaces the index wholesale (no accumulation across reloads)", () => {
    const index = buildIndex();
    index.rebuildFromEntries([entry(runSnapshot({ runId: "r_ONLY00001", sessionFile: "/s/a.jsonl" }))]);
    expect(index.list().map((r) => r.runId)).toEqual(["r_ONLY00001"]);
  });

  it("contextUsage null tokens/percent are treated as absent, not 0", () => {
    const index = createExpertIndex({ consultDir: CONSULT_DIR });
    index.rebuildFromEntries([
      entry(
        runSnapshot({
          runId: "r_NULLCTX01",
          sessionFile: "/s/n.jsonl",
          contextUsage: { tokens: null, contextWindow: 0, percent: null },
        }),
      ),
    ]);
    const record = index.list()[0]!;
    expect(record.contextPercent).toBeUndefined();
    expect(record.contextTokens).toBeUndefined();
  });
});

describe("consult/expert-index: id resolution matches resolve-target exactly (T-1)", () => {
  // The same fixture, fed to both implementations: matchRunId gets a
  // ResolveTargetDeps built over the same runId set the index admitted.
  function resolveTargetDepsOver(records: readonly { runId: RunId }[]): ResolveTargetDeps {
    return {
      records: () =>
        records.map((r) => ({
          ...runSnapshot({ runId: r.runId, sessionFile: "/s/x.jsonl" }),
        })),
      liveSnapshots: [],
      labels: new Map(),
      tombstones: { list: () => [], get: () => undefined },
    };
  }

  it.each([
    "r_ALPHA0001", // exact
    "r_ALPHA", // unique prefix across BOTH records
    "r_ALPHA0", // ambiguous prefix
    "r_ZZZ", // miss
    "explorer", // a label — matchRunId ignores labels, so does the index id path
  ])("handle %j resolves identically in both implementations", (handle) => {
    const index = buildIndex();
    const viaIndex = index.resolveId(handle);
    const viaMatchRunId = matchRunId(handle, resolveTargetDepsOver(index.list()));
    if (viaMatchRunId.runId !== undefined) {
      expect(viaIndex.ok).toBe(true);
      if (viaIndex.ok) expect(viaIndex.record.runId).toBe(viaMatchRunId.runId);
    } else if (viaMatchRunId.ambiguous) {
      expect(viaIndex.ok).toBe(false);
      if (!viaIndex.ok) expect(viaIndex.ambiguous).toBeDefined();
    } else {
      expect(viaIndex.ok).toBe(false);
    }
  });

  it("ambiguous misses list the conflicting runIds", () => {
    const index = buildIndex();
    const result = index.resolveId("r_ALPHA");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([...(result.ambiguous ?? [])].sort()).toEqual(["r_ALPHA0001", "r_ALPHA0002"]);
      expect(result.reason).toContain("ambiguous");
    }
  });
});

describe("consult/expert-index: isUnderDir", () => {
  it("accepts files strictly inside the dir, rejects the dir itself / parents / siblings / absolute escapes", () => {
    expect(isUnderDir(CONSULT_DIR, `${CONSULT_DIR}/fork.jsonl`)).toBe(true);
    expect(isUnderDir(CONSULT_DIR, `${CONSULT_DIR}/nested/fork.jsonl`)).toBe(true);
    expect(isUnderDir(CONSULT_DIR, CONSULT_DIR)).toBe(false);
    expect(isUnderDir(CONSULT_DIR, "/cache/consult-sessions-evil/fork.jsonl")).toBe(false);
    expect(isUnderDir(CONSULT_DIR, "/sessions/r_ALPHA0001.jsonl")).toBe(false);
    expect(isUnderDir("/cache/consult-sessions", "/cache/other/fork.jsonl")).toBe(false);
  });
});
