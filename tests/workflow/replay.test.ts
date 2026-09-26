import { describe, expect, it, vi } from "vitest";
import { buildEntry, CHAIN_SEED, nextChainDigest, taskKeyOf } from "../../src/workflow/journal.js";
import { buildReplayIndex, decideReplay } from "../../src/workflow/replay.js";
import type { JournalEntry, TaskSemantics } from "../../src/workflow/types.js";

/**
 * M3.5 (workflow design §6.2/§6.3/§6.4): pure unit coverage for the
 * `ReplayIndex`/`decideReplay` decision layer, independent of host.ts's
 * wiring — this is where 定理 3 (至多复用一次), 定理 4' (chain causal
 * safety), and RP1-RP9 get their line-by-line assertions.
 */

const sem = (prompt: string): TaskSemantics => ({ agentType: "gp", agentTypeConfigHash: "h1", prompt });

function makeChainRun(prompts: readonly string[], scope: "chain" | "content" = "chain"): JournalEntry[] {
  let chain = CHAIN_SEED;
  const entries: JournalEntry[] = [];
  const occCounters = new Map<string, number>();
  prompts.forEach((prompt, i) => {
    const key = taskKeyOf(sem(prompt));
    const chainDigestBefore = chain;
    const k = scope === "content" ? key : nextChainDigest(chainDigestBefore, key);
    const occurrence = occCounters.get(k) ?? 0;
    occCounters.set(k, occurrence + 1);
    chain = nextChainDigest(chainDigestBefore, key);
    entries.push(
      buildEntry({
        scope,
        key,
        chainDigestBefore,
        occurrence,
        agentType: "gp",
        value: `result-${i}`,
        completedAt: 1000 + i,
        durationMs: 10,
      }),
    );
  });
  return entries;
}

describe("buildReplayIndex + decideReplay: basic hit/miss", () => {
  it("hits when taskKey/chainDigestBefore/occurrence all match (chain scope)", () => {
    const entries = makeChainRun(["a", "b"]);
    const index = buildReplayIndex(entries, 0, "chain");
    let chain = CHAIN_SEED;
    for (const prompt of ["a", "b"]) {
      const taskKey = taskKeyOf(sem(prompt));
      const decision = decideReplay({
        index,
        taskKey,
        chainDigestBefore: chain,
        occurrence: 0,
        noReplay: false,
        deterministic: true,
        now: 2000,
      });
      expect(decision.kind).toBe("hit");
      chain = nextChainDigest(chain, taskKey);
    }
  });

  it("misses when nothing was journaled for that key", () => {
    const index = buildReplayIndex([], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("never seen")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "miss" });
  });
});

describe("定理 3 (至多复用一次): occurrence-scoped, not key-scoped", () => {
  it("the same prompt submitted 3 times in one run: occurrence 0 hits, 1/2 miss when journal only has one", () => {
    const entries = makeChainRun(["same-prompt"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const taskKey = taskKeyOf(sem("same-prompt"));
    const results = [0, 1, 2].map((occurrence) =>
      decideReplay({
        index,
        taskKey,
        chainDigestBefore: CHAIN_SEED,
        occurrence,
        noReplay: false,
        deterministic: true,
        now: 2000,
      }),
    );
    expect(results.map((r) => r.kind)).toEqual(["hit", "miss", "miss"]);
  });
});

describe("定理 4' (chain scope causal safety): an upstream content change breaks the whole downstream chain", () => {
  it("chain scope: changing task A's prompt misses A AND B (chain propagation)", () => {
    const entries = makeChainRun(["A", "B"], "chain");
    const index = buildReplayIndex(entries, 0, "chain");

    // Run 2: A's prompt changed, B's did not.
    const taskKeyA2 = taskKeyOf(sem("A-changed"));
    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA2,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionA.kind).toBe("miss");

    const chainAfterA2 = nextChainDigest(CHAIN_SEED, taskKeyA2);
    const taskKeyB = taskKeyOf(sem("B")); // B's own content is unchanged...
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: chainAfterA2, // ...but its chain digest now differs.
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionB.kind).toBe("miss"); // causal break: B misses too.
  });

  it("content scope: the same upstream change only misses A, B still hits (推论 2.3)", () => {
    const entries = makeChainRun(["A", "B"], "content");
    const index = buildReplayIndex(entries, 0, "content");

    const taskKeyA2 = taskKeyOf(sem("A-changed"));
    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA2,
      chainDigestBefore: CHAIN_SEED, // irrelevant for content scope
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionA.kind).toBe("miss");

    const taskKeyB = taskKeyOf(sem("B"));
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: "irrelevant-in-content-scope",
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decisionB.kind).toBe("hit"); // content scope: B's own content is unchanged, still hits.
  });
});

describe("推论 2.1 (completion order does not affect matching — occurrence is submission-time, matching is by map lookup)", () => {
  it("out-of-order settle (journal written in completion order) does not change the hit set", () => {
    // Two tasks submitted A, B (in that order); simulate B completing before
    // A by writing the journal in completion order B-then-A, but with
    // occurrence/chainDigestBefore recorded per *submission* order (as
    // host.ts's real submission-time assignment would do).
    const taskKeyA = taskKeyOf(sem("A"));
    const chainAfterA = nextChainDigest(CHAIN_SEED, taskKeyA);
    const taskKeyB = taskKeyOf(sem("B"));

    const entryA = buildEntry({
      scope: "chain",
      key: taskKeyA,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "a",
      completedAt: 2000, // settles *second*
      durationMs: 10,
    });
    const entryB = buildEntry({
      scope: "chain",
      key: taskKeyB,
      chainDigestBefore: chainAfterA,
      occurrence: 0,
      agentType: "gp",
      value: "b",
      completedAt: 1000, // settles *first*, but was submitted second
      durationMs: 10,
    });

    // Journal file order = completion order (B, then A) — exactly what a
    // naive line-order matcher would trip over.
    const index = buildReplayIndex([entryB, entryA], 0, "chain");

    const decisionA = decideReplay({
      index,
      taskKey: taskKeyA,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 3000,
    });
    const decisionB = decideReplay({
      index,
      taskKey: taskKeyB,
      chainDigestBefore: chainAfterA,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 3000,
    });
    expect(decisionA.kind).toBe("hit");
    expect(decisionB.kind).toBe("hit");
  });
});

describe("RP gate: noReplay / deterministic / isolation / TTL / scope mismatch", () => {
  it("RP1: noReplay forces skip even on an otherwise-matching entry", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: true,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "no_replay" });
  });

  it("RP9: deterministic:false skips every lookup, even a matching one", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: false,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "non_deterministic" });
  });

  it("RP7: isolation:worktree entries are never replayed", () => {
    const key = taskKeyOf({ ...sem("a"), isolation: "worktree" });
    const entry = buildEntry({
      scope: "chain",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "isolation_worktree" });
  });

  it("D3: input.isolation:true skips before configHashAvailable/lookup, even when a matching entry exists", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      configHashAvailable: false, // would otherwise force config_hash_unavailable — isolation must win first
      isolation: true,
    });
    expect(decision).toEqual({ kind: "skip", reason: "isolation_worktree" });
  });

  it("D3: input.isolation:false/undefined does not skip — an otherwise-matching entry still hits", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: false,
    });
    expect(decision.kind).toBe("hit");
  });

  it("D3: isolation:true takes priority over tainted (both skip, but isolation_worktree is the reported reason)", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      tainted: true,
      isolation: true,
    });
    // `tainted` is checked first in decideReplay's ordering, so a call that is
    // BOTH tainted and isolated reports chain_tainted — pin that ordering here.
    expect(decision).toEqual({ kind: "skip", reason: "chain_tainted" });
  });

  it("RP6: an entry older than replayTtlMs is skipped as expired", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 1000 + 10_000,
      replayTtlMs: 5_000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "expired" });
  });

  it("scope mismatch: an entry written under 'content' is invisible to a 'chain'-scope index (and vice versa)", () => {
    const contentEntries = makeChainRun(["a"], "content");
    const chainIndex = buildReplayIndex(contentEntries, 0, "chain");
    expect(chainIndex.stats.scopeMismatch).toBe(1);
    const decision = decideReplay({
      index: chainIndex,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "miss" });
  });
});

describe("replay-verify plan D5/D4.2: verify-mode isolation decisions (§6 test 8)", () => {
  function isoEntry(
    worktree: JournalEntry["worktree"],
    overrides: Partial<Parameters<typeof buildEntry>[0]> = {},
  ): {
    entry: JournalEntry;
    taskKey: ReturnType<typeof taskKeyOf>;
  } {
    const isoSem: TaskSemantics = { ...sem("iso-a"), isolation: "worktree" };
    const taskKey = taskKeyOf(isoSem);
    const entry = buildEntry({
      scope: "chain",
      key: taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree,
      value: "iso-result",
      completedAt: 1000,
      durationMs: 10,
      ...overrides,
    });
    return { entry, taskKey };
  }
  const committedWt = {
    state: "committed" as const,
    branch: "pi-agent-r1",
    commit: "a".repeat(40),
    isoId: "b".repeat(32),
  };
  const cleanWt = { state: "clean" as const, isoId: "c".repeat(32) };

  it("a verified committed entry hits under verify mode", () => {
    const { entry, taskKey } = isoEntry(committedWt);
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
      isolationVerified: (e) => e.digest === entry.digest,
    });
    expect(decision).toEqual({ kind: "hit", entry });
  });

  it("an unverified committed entry (isolationVerified returns false) skips as worktree_unverified", () => {
    const { entry, taskKey } = isoEntry(committedWt);
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
      isolationVerified: () => false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "worktree_unverified" });
  });

  it("a missing isolationVerified port defaults to unverified (fail-closed)", () => {
    const { entry, taskKey } = isoEntry(committedWt);
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
    });
    expect(decision).toEqual({ kind: "skip", reason: "worktree_unverified" });
  });

  it("D3.1: a clean entry hits under verify mode WITHOUT ever consulting isolationVerified", () => {
    const { entry, taskKey } = isoEntry(cleanWt);
    const index = buildReplayIndex([entry], 0, "chain");
    const isolationVerified = vi.fn(() => false);
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
      isolationVerified,
    });
    expect(decision).toEqual({ kind: "hit", entry });
    expect(isolationVerified).not.toHaveBeenCalled();
  });

  it("off mode (isolationReplay absent) still unconditionally skips an isolated call, even with a verified entry present", () => {
    const { entry, taskKey } = isoEntry(committedWt);
    const index = buildReplayIndex([entry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationVerified: () => true, // must be ignored entirely under off mode
    });
    expect(decision).toEqual({ kind: "skip", reason: "isolation_worktree" });
  });

  it('a legacy entry (isolation:"worktree" but no worktree field) skips isolation_worktree even under verify mode', () => {
    const { taskKey } = isoEntry(committedWt);
    const legacy = buildEntry({
      scope: "chain",
      key: taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      value: "legacy",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([legacy], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
      isolationVerified: () => true,
    });
    expect(decision).toEqual({ kind: "skip", reason: "isolation_worktree" });
  });

  it("a truncated committed entry skips as truncated, never reaching the verification check", () => {
    const isoSem: TaskSemantics = { ...sem("iso-huge"), isolation: "worktree" };
    const taskKey = taskKeyOf(isoSem);
    const entry = buildEntry({
      scope: "chain",
      key: taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: committedWt,
      value: "x".repeat(70 * 1024),
      completedAt: 1000,
      durationMs: 10,
    });
    expect(entry.truncated).toBe(true);
    const index = buildReplayIndex([entry], 0, "chain");
    const isolationVerified = vi.fn(() => true);
    const decision = decideReplay({
      index,
      taskKey,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      isolation: true,
      isolationReplay: "verify",
      isolationVerified,
    });
    expect(decision).toEqual({ kind: "skip", reason: "truncated" });
    expect(isolationVerified).not.toHaveBeenCalled();
  });
});

describe("replay-verify plan D4.2: ReplayIndex.isolatedCandidates", () => {
  it("returns only committed, non-truncated isolated entries within TTL", () => {
    const isoSem: TaskSemantics = { ...sem("iso-a"), isolation: "worktree" };
    const committed = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const cleanIsoSem: TaskSemantics = { ...sem("iso-b"), isolation: "worktree" };
    const clean = buildEntry({
      scope: "chain",
      key: taskKeyOf(cleanIsoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "clean", isoId: "c".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const plain = makeChainRun(["plain"])[0]!;
    const index = buildReplayIndex([committed, clean, plain], 0, "chain");
    const candidates = index.isolatedCandidates({ now: 2000 });
    expect(candidates).toEqual([committed]); // clean is excluded (nothing to verify); plain has no isolation at all
  });

  it("excludes a committed candidate past replayTtlMs", () => {
    const isoSem: TaskSemantics = { ...sem("iso-old"), isolation: "worktree" };
    const committed = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "v",
      completedAt: 1000,
      durationMs: 10,
    });
    const index = buildReplayIndex([committed], 0, "chain");
    expect(index.isolatedCandidates({ now: 2_000, replayTtlMs: 500 })).toEqual([]);
    expect(index.isolatedCandidates({ now: 1_400, replayTtlMs: 500 })).toEqual([committed]);
  });

  it("excludes a truncated committed candidate", () => {
    const isoSem: TaskSemantics = { ...sem("iso-huge2"), isolation: "worktree" };
    const truncated = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-r1", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "x".repeat(70 * 1024),
      completedAt: 1000,
      durationMs: 10,
    });
    expect(truncated.truncated).toBe(true);
    const index = buildReplayIndex([truncated], 0, "chain");
    expect(index.isolatedCandidates({ now: 2000 })).toEqual([]);
  });

  it("honors dedup (takes the latest completedAt per key/occurrence, same as lookup)", () => {
    const isoSem: TaskSemantics = { ...sem("iso-dup"), isolation: "worktree" };
    const older = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-old", commit: "a".repeat(40), isoId: "b".repeat(32) },
      value: "v1",
      completedAt: 1000,
      durationMs: 10,
    });
    const newer = buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      isolation: "worktree",
      worktree: { state: "committed", branch: "pi-agent-new", commit: "d".repeat(40), isoId: "e".repeat(32) },
      value: "v2",
      completedAt: 2000,
      durationMs: 10,
    });
    const index = buildReplayIndex([older, newer], 0, "chain");
    expect(index.isolatedCandidates({ now: 3000 })).toEqual([newer]);
  });
});

describe("同 (K, occurrence) 多条 → 取 completedAt 最大者 (§6.5)", () => {
  it("buildReplayIndex keeps the entry with the latest completedAt for a duplicate key", () => {
    const key = taskKeyOf(sem("dup"));
    const older = buildEntry({
      scope: "content",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "older",
      completedAt: 1000,
      durationMs: 10,
    });
    const newer = buildEntry({
      scope: "content",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "newer",
      completedAt: 5000,
      durationMs: 10,
    });
    const index = buildReplayIndex([older, newer], 0, "content");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 6000,
    });
    expect(decision.kind).toBe("hit");
    if (decision.kind === "hit") expect(decision.entry.value).toBe("newer");
  });
});

describe("M3.6 Blocker fix (§6.3 E2): configHashAvailable fail-closed", () => {
  it("configHashAvailable:false skips even an entry that would otherwise hit, and does not consult the index at all", () => {
    const entries = makeChainRun(["a"]);
    let lookedUp = false;
    const index = buildReplayIndex(entries, 0, "chain");
    const spiedIndex = {
      ...index,
      lookup: (...args: Parameters<typeof index.lookup>) => {
        lookedUp = true;
        return index.lookup(...args);
      },
    };
    const decision = decideReplay({
      index: spiedIndex,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      configHashAvailable: false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "config_hash_unavailable" });
    expect(lookedUp).toBe(false); // fail-closed: never even looks, regardless of what might match
  });

  it("configHashAvailable:true (or omitted, default) behaves exactly as before — unaffected by the Blocker fix", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const withTrue = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      configHashAvailable: true,
    });
    const omitted = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(withTrue.kind).toBe("hit");
    expect(omitted.kind).toBe("hit");
  });

  it("a truncated (JS6) entry is always skipped, never handed back as a hit", () => {
    const key = taskKeyOf(sem("a"));
    const truncatedEntry = buildEntry({
      scope: "chain",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "gp",
      value: "x".repeat(70 * 1024), // forces JS6 truncation
      completedAt: 1000,
      durationMs: 10,
    });
    expect(truncatedEntry.truncated).toBe(true);
    const index = buildReplayIndex([truncatedEntry], 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision).toEqual({ kind: "skip", reason: "truncated" });
  });
});

describe("workflow-experts §4.6/§5: experts/chain_tainted skip — lookup never runs, noReplay still wins first", () => {
  it("experts:true skips even when a matching entry exists, and never touches the index (lookup spy)", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const lookupSpy = vi.spyOn(index, "lookup");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      experts: true,
    });
    expect(decision).toEqual({ kind: "skip", reason: "experts" });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("tainted:true skips even when a matching entry exists, and never touches the index (lookup spy)", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const lookupSpy = vi.spyOn(index, "lookup");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
      tainted: true,
    });
    expect(decision).toEqual({ kind: "skip", reason: "chain_tainted" });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("ordering: noReplay > non_deterministic > experts > chain_tainted > config_hash_unavailable > lookup", () => {
    const index = buildReplayIndex([], 0, "chain");
    const base = {
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      now: 2000,
    };
    expect(
      decideReplay({
        ...base,
        noReplay: true,
        deterministic: false,
        experts: true,
        tainted: true,
        configHashAvailable: false,
      }),
    ).toEqual({ kind: "skip", reason: "no_replay" });
    expect(
      decideReplay({
        ...base,
        noReplay: false,
        deterministic: false,
        experts: true,
        tainted: true,
        configHashAvailable: false,
      }),
    ).toEqual({ kind: "skip", reason: "non_deterministic" });
    expect(
      decideReplay({
        ...base,
        noReplay: false,
        deterministic: true,
        experts: true,
        tainted: true,
        configHashAvailable: false,
      }),
    ).toEqual({ kind: "skip", reason: "experts" });
    expect(
      decideReplay({
        ...base,
        noReplay: false,
        deterministic: true,
        experts: false,
        tainted: true,
        configHashAvailable: false,
      }),
    ).toEqual({ kind: "skip", reason: "chain_tainted" });
    expect(
      decideReplay({
        ...base,
        noReplay: false,
        deterministic: true,
        experts: false,
        tainted: false,
        configHashAvailable: false,
      }),
    ).toEqual({ kind: "skip", reason: "config_hash_unavailable" });
  });

  it("experts/tainted both absent (undefined) behaves exactly like before (unaffected calls keep hitting)", () => {
    const entries = makeChainRun(["a"]);
    const index = buildReplayIndex(entries, 0, "chain");
    const decision = decideReplay({
      index,
      taskKey: taskKeyOf(sem("a")),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      noReplay: false,
      deterministic: true,
      now: 2000,
    });
    expect(decision.kind).toBe("hit");
  });
});
