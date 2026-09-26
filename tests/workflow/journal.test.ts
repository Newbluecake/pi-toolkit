import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  buildEntry,
  canonicalize,
  CHAIN_SEED,
  createJournalStore,
  entryDigest,
  nextChainDigest,
  parseEntry,
  sha256Hex,
  taskKeyOf,
} from "../../src/workflow/journal.js";
import type { JournalEntry, TaskSemantics } from "../../src/workflow/types.js";

/**
 * M3.5 (workflow design §6.2/§6.5/§6.6): pure unit coverage for
 * `journal.ts` — key computation (`taskKeyOf`, chain digest recurrence),
 * entry digesting/tamper-detection, and the append-only `JournalStore`
 * (JS1/JS2/JS3, corrupt-line tolerance).
 */

const baseSem: TaskSemantics = { agentType: "general-purpose", agentTypeConfigHash: "h1", prompt: "hello" };

describe("canonicalize (§6.2 WP6: key-order-insensitive, value-sensitive)", () => {
  it("is insensitive to object key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it("is sensitive to value differences", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });
  it("drops undefined-valued keys (matches JSON.stringify's own object behavior)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
  it("preserves array order (arrays are not reordered)", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("taskKeyOf (§6.2 A2': declared-semantics completeness)", () => {
  it("is deterministic for identical semantics", () => {
    expect(taskKeyOf(baseSem)).toBe(taskKeyOf({ ...baseSem }));
  });
  it("changes when prompt changes", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, prompt: "different" }));
  });
  it("changes when agentTypeConfigHash changes (§6.3 E2: a .md definition edit must miss)", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, agentTypeConfigHash: "h2" }));
  });
  it("changes when agentType changes even if the config hash coincidentally matches", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, agentType: "other-type" }));
  });
  it("changes when isolation is added", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, isolation: "worktree" }));
  });
  it("changes when a per-call model override is added (same prompt + different model must never replay the old result)", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, model: "cr-anthropic/claude-sonnet-5" }));
    expect(taskKeyOf({ ...baseSem, model: "zai/glm-5.3" })).not.toBe(
      taskKeyOf({ ...baseSem, model: "cr-anthropic/claude-sonnet-5" }),
    );
    // The raw string participates, so a strict pair and its fuzzy hint form
    // are distinct declared semantics (a miss is always safe; a false hit is not).
    expect(taskKeyOf({ ...baseSem, model: "sonnet" })).not.toBe(
      taskKeyOf({ ...baseSem, model: "cr-anthropic/claude-sonnet-5" }),
    );
  });
  it("changes when a per-call thinking override is added or differs", () => {
    expect(taskKeyOf(baseSem)).not.toBe(taskKeyOf({ ...baseSem, thinking: "high" }));
    expect(taskKeyOf({ ...baseSem, thinking: "low" })).not.toBe(taskKeyOf({ ...baseSem, thinking: "high" }));
  });
  it("is byte-identical to the pre-override formula when model/thinking are absent (existing journals never invalidate)", () => {
    // The exact canon object taskKeyOf built before model/thinking existed —
    // recomputed here from the exported primitives so the equality below is
    // a byte-level proof, not a restatement of the current implementation.
    const legacyKeyOf = (sem: TaskSemantics): string =>
      sha256Hex(
        canonicalize({
          agentType: sem.agentType,
          agentTypeConfigHash: sem.agentTypeConfigHash,
          prompt: sem.prompt,
          ...(sem.isolation !== undefined ? { isolation: sem.isolation } : {}),
          ...(sem.workflowArgs !== undefined ? { workflowArgs: sem.workflowArgs } : {}),
        }),
      ).slice(0, 32);
    expect(taskKeyOf(baseSem)).toBe(legacyKeyOf(baseSem));
    expect(taskKeyOf({ ...baseSem, isolation: "worktree", workflowArgs: { a: 1 } })).toBe(
      legacyKeyOf({ ...baseSem, isolation: "worktree", workflowArgs: { a: 1 } }),
    );
  });
  it("changes when workflowArgs changes", () => {
    expect(taskKeyOf({ ...baseSem, workflowArgs: { n: 1 } })).not.toBe(
      taskKeyOf({ ...baseSem, workflowArgs: { n: 2 } }),
    );
  });
  it("is stable under workflowArgs key-order permutation (canonicalize, not raw JSON)", () => {
    expect(taskKeyOf({ ...baseSem, workflowArgs: { a: 1, b: 2 } })).toBe(
      taskKeyOf({ ...baseSem, workflowArgs: { b: 2, a: 1 } }),
    );
  });
});

describe("nextChainDigest (§6.2 chain recurrence)", () => {
  it("is deterministic", () => {
    const tk = taskKeyOf(baseSem);
    expect(nextChainDigest(CHAIN_SEED, tk)).toBe(nextChainDigest(CHAIN_SEED, tk));
  });
  it("differs for different chainDigestBefore (causal propagation, 定理 4')", () => {
    const tk = taskKeyOf(baseSem);
    expect(nextChainDigest(CHAIN_SEED, tk)).not.toBe(nextChainDigest("some-other-digest", tk));
  });
  it("differs for different taskKey", () => {
    const tk1 = taskKeyOf(baseSem);
    const tk2 = taskKeyOf({ ...baseSem, prompt: "other" });
    expect(nextChainDigest(CHAIN_SEED, tk1)).not.toBe(nextChainDigest(CHAIN_SEED, tk2));
  });
});

function makeEntry(overrides: Partial<Parameters<typeof buildEntry>[0]> = {}): JournalEntry {
  return buildEntry({
    scope: "chain",
    key: taskKeyOf(baseSem),
    chainDigestBefore: CHAIN_SEED,
    occurrence: 0,
    agentType: baseSem.agentType,
    value: "the answer",
    completedAt: 1000,
    durationMs: 50,
    ...overrides,
  });
}

describe("entryDigest / parseEntry (RP4: tamper detection)", () => {
  it("round-trips a well-formed line", () => {
    const entry = makeEntry();
    const parsed = parseEntry(JSON.stringify(entry));
    expect(parsed).toEqual(entry);
  });
  it("recomputes the same digest for the same fields", () => {
    const entry = makeEntry();
    const { digest, ...fields } = entry;
    expect(entryDigest(fields)).toBe(digest);
  });
  it("rejects a hand-edited `value` whose digest was not recomputed (the exact §10.2 W30 scenario)", () => {
    const entry = makeEntry();
    const tampered = { ...entry, value: "a completely different answer" };
    expect(parseEntry(JSON.stringify(tampered))).toBeUndefined();
  });
  it("rejects malformed JSON", () => {
    expect(parseEntry("{not json")).toBeUndefined();
  });
  it("rejects an unknown `v`", () => {
    const entry = makeEntry();
    expect(parseEntry(JSON.stringify({ ...entry, v: 2 }))).toBeUndefined();
  });
  it("rejects a non-object line", () => {
    expect(parseEntry("42")).toBeUndefined();
    expect(parseEntry('"a string"')).toBeUndefined();
    expect(parseEntry("[1,2,3]")).toBeUndefined();
  });
  it("rejects a truncated line", () => {
    const entry = makeEntry();
    const line = JSON.stringify(entry);
    expect(parseEntry(line.slice(0, line.length - 10))).toBeUndefined();
  });
});

describe("sha256Hex", () => {
  it("is a 64-char lowercase hex string", () => {
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("replay-verify plan D2: JournalEntry.worktree round-trip and shape validation (§6 test 7)", () => {
  const isoSem: TaskSemantics = { ...baseSem, isolation: "worktree" };
  const committedWt = {
    state: "committed" as const,
    branch: "pi-agent-r1",
    commit: "a".repeat(40),
    isoId: "b".repeat(32),
  };
  const cleanWt = { state: "clean" as const, isoId: "c".repeat(32) };

  function makeIsoEntry(worktree: JournalEntry["worktree"]): JournalEntry {
    return buildEntry({
      scope: "chain",
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: isoSem.agentType,
      isolation: "worktree",
      worktree,
      value: "iso-result",
      completedAt: 1000,
      durationMs: 10,
    });
  }

  it("a committed entry round-trips with a stable digest", () => {
    const entry = makeIsoEntry(committedWt);
    expect(entry.worktree).toEqual(committedWt);
    const parsed = parseEntry(JSON.stringify(entry));
    expect(parsed).toEqual(entry);
  });

  it("a clean entry round-trips (no branch/commit)", () => {
    const entry = makeIsoEntry(cleanWt);
    const parsed = parseEntry(JSON.stringify(entry));
    expect(parsed).toEqual(entry);
    expect(parsed?.worktree).toEqual(cleanWt);
  });

  it("tampering any worktree field (branch/commit/isoId/state) invalidates the digest ⇒ corrupt", () => {
    const entry = makeIsoEntry(committedWt);
    const line = JSON.stringify(entry);
    for (const bad of [
      { ...committedWt, branch: "not-a-pi-agent-branch" },
      { ...committedWt, commit: "not-hex" },
      { ...committedWt, isoId: "too-short" },
      { ...committedWt, state: "bogus" },
    ]) {
      const tampered = { ...JSON.parse(line), worktree: bad };
      expect(parseEntry(JSON.stringify(tampered))).toBeUndefined();
    }
  });

  it("an illegal branch name (regex mismatch) is corrupt even with a digest recomputed over it", () => {
    // Build a "legit" entry with an illegal branch by bypassing buildEntry's
    // trust of its own input (buildEntry does not itself validate shape —
    // only parseEntry does, so this simulates a foreign/future producer).
    const illegal = { ...committedWt, branch: "feature/not-pi-agent" };
    const fields = {
      v: 1 as const,
      scope: "chain" as const,
      key: taskKeyOf(isoSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: isoSem.agentType,
      status: "completed" as const,
      isolation: "worktree" as const,
      worktree: illegal,
      value: "x",
      completedAt: 1,
      durationMs: 1,
    };
    const digest = entryDigest(fields);
    expect(parseEntry(JSON.stringify({ ...fields, digest }))).toBeUndefined();
  });

  it("a bad commit sha (not 40/64 hex) is corrupt", () => {
    const entry = makeIsoEntry({ ...committedWt, commit: "short" });
    // makeIsoEntry itself doesn't validate — but the digest DOES cover the
    // bad commit, so parseEntry must reject it on shape, not on digest.
    expect(parseEntry(JSON.stringify(entry))).toBeUndefined();
  });

  it('a `worktree` key without `isolation:"worktree"` is corrupt (D2)', () => {
    const entry = makeIsoEntry(committedWt);
    const { isolation, ...rest } = entry as JournalEntry & { isolation?: unknown };
    void isolation;
    const withoutIsolation = { ...rest };
    // digest was computed WITH isolation present, so this is already corrupt
    // by digest mismatch too — assert the corrupt outcome either way.
    expect(parseEntry(JSON.stringify(withoutIsolation))).toBeUndefined();
  });

  it("an extra/unknown key inside worktree is corrupt", () => {
    const entry = makeIsoEntry(committedWt);
    const withExtra = { ...JSON.parse(JSON.stringify(entry)), worktree: { ...committedWt, extra: "nope" } };
    expect(parseEntry(JSON.stringify(withExtra))).toBeUndefined();
  });

  it("a non-isolated entry's shape/digest is unaffected by this feature (byte-identical)", () => {
    const plain = makeEntry();
    expect(plain.worktree).toBeUndefined();
    const parsed = parseEntry(JSON.stringify(plain));
    expect(parsed).toEqual(plain);
  });

  it("an OLDER parser (pre-D2, no `worktree`-awareness at all) loads a REAL on-disk journal.jsonl written by the CURRENT store: only the worktree-bearing line is corrupt, the plain sibling line reads back byte-identical", async () => {
    // A faithful reconstruction of `parseEntry` exactly as it existed BEFORE
    // D2 added the `worktree` field — same whitelist/digest logic, minus
    // every worktree-related line (no `parseJournalWorktree`, `EntryDigestInput`
    // never gets a `worktree` key, and it doesn't even special-case the raw
    // `worktree` key's presence). This is what a not-yet-upgraded sibling
    // process (or a rollback) would actually run.
    function oldParseEntry(line: string): JournalEntry | undefined {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
      const r = raw as Record<string, unknown>;
      if (r.v !== 1) return undefined;
      if (r.scope !== "chain" && r.scope !== "content") return undefined;
      if (typeof r.key !== "string" || typeof r.chainDigestBefore !== "string") return undefined;
      if (typeof r.occurrence !== "number" || !Number.isFinite(r.occurrence)) return undefined;
      if (typeof r.agentType !== "string") return undefined;
      if (r.status !== "completed") return undefined;
      if (r.isolation !== undefined && r.isolation !== "worktree") return undefined;
      if (r.value !== null && typeof r.value !== "string") return undefined;
      if (r.truncated !== undefined && r.truncated !== true) return undefined;
      if (typeof r.completedAt !== "number" || typeof r.durationMs !== "number") return undefined;
      if (typeof r.digest !== "string") return undefined;
      const fields = {
        v: 1 as const,
        scope: r.scope,
        key: r.key,
        chainDigestBefore: r.chainDigestBefore,
        occurrence: r.occurrence,
        agentType: r.agentType,
        status: "completed" as const,
        ...(r.isolation !== undefined ? { isolation: r.isolation } : {}),
        // — NO `worktree` key here: the old parser has never heard of it —
        value: r.value,
        completedAt: r.completedAt,
        durationMs: r.durationMs,
        ...(r.truncated === true ? { truncated: true as const } : {}),
      };
      if (entryDigest(fields as Parameters<typeof entryDigest>[0]) !== r.digest) return undefined;
      return { ...fields, digest: r.digest } as unknown as JournalEntry;
    }

    const dir = await mkdtemp(join(tmpdir(), "wf-journal-old-parser-"));
    try {
      const clock = new FakeClock();
      const store = createJournalStore({ clock });
      const plain = makeEntry(); // no `worktree` field at all — unaffected by D2
      const iso = makeIsoEntry(committedWt); // digest computed WITH `worktree` — the old parser can never reproduce it
      store.append(dir, plain);
      store.append(dir, iso);
      await store.flush(dir, 5_000);
      const text = await readFile(join(dir, "journal.jsonl"), "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);

      const results = lines.map((line) => oldParseEntry(line));
      const corruptCount = results.filter((r) => r === undefined).length;
      expect(corruptCount).toBe(1); // ONLY the worktree-bearing line
      expect(results[0]).toEqual(plain); // sibling line reads back fine, byte-identical
      expect(results[1]).toBeUndefined(); // the worktree line is corrupt under the old parser

      // Sanity check: the CURRENT parser (which knows about `worktree`) reads BOTH lines fine —
      // proving the corruption above is specifically an old-parser compatibility gap, not a real defect.
      expect(parseEntry(lines[0]!)).toEqual(plain);
      expect(parseEntry(lines[1]!)).toEqual(iso);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("JournalStore (§6.6 JS1/JS2/JS3): async append, batched flush, corrupt-line tolerance", () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wf-journal-"));
    clock = new FakeClock();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("load() on a missing journal returns empty, not an error", async () => {
    const store = createJournalStore({ clock });
    const result = await store.load(dir);
    expect(result).toEqual({ entries: [], corruptLines: 0 });
  });

  it("append() returns synchronously (JS1) — does not block the caller on disk I/O", () => {
    const store = createJournalStore({ clock });
    const start = Date.now();
    store.append(dir, makeEntry());
    // JS1: append() must be a plain synchronous function call, not an
    // (even resolved) Promise — asserting on wall-clock elapsed time here
    // would be flaky; the real guarantee is the *type signature* (`void`,
    // not `Promise<void>`) plus the JS1 end-to-end coverage in host.test.ts
    // (asserting `agent()`'s own settle round trip never awaits a flush).
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("flush() writes every appended entry to journal.jsonl, batched into one file", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    store.append(dir, makeEntry({ occurrence: 1 }));
    store.append(dir, makeEntry({ occurrence: 2 }));
    const result = await store.flush(dir, 5_000);
    expect(result).toEqual({ written: 3, pending: 0 });
    const text = await readFile(join(dir, "journal.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("load() after flush() reconstructs every valid entry and reports zero corrupt lines", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    store.append(dir, makeEntry({ occurrence: 1, value: "second" }));
    await store.flush(dir, 5_000);
    const result = await store.load(dir);
    expect(result.corruptLines).toBe(0);
    expect(result.entries).toHaveLength(2);
  });

  it("a hand-corrupted line is skipped (WARN + counted) while the remaining valid lines still load (§10.2 W30/W33)", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry({ occurrence: 0 }));
    await store.flush(dir, 5_000);
    const good = makeEntry({ occurrence: 1, value: "still good" });
    const tampered = { ...makeEntry({ occurrence: 2, value: "original" }), value: "hand-edited, digest stale" };
    const path = join(dir, "journal.jsonl");
    await appendFile(path, "not even json\n" + JSON.stringify(good) + "\n" + JSON.stringify(tampered) + "\n");
    const result = await store.load(dir);
    // 1 garbage line + 1 tampered-digest line = 2 corrupt; the original
    // entry + the still-good appended one load fine (2 entries).
    expect(result.corruptLines).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("flush() with an exhausted deadline still reports what remains pending, never throws", async () => {
    const store = createJournalStore({ clock });
    store.append(dir, makeEntry());
    const result = await store.flush(dir, 0);
    // Whether or not the microtask-scheduled fs write beat the zero-deadline
    // race is not the point under test — the call must resolve (not hang,
    // not throw) either way.
    expect(result.pending).toBeGreaterThanOrEqual(0);
    expect(result.written).toBeGreaterThanOrEqual(0);
  });
});

describe("JS6 (§6.6): oversize `value` is truncated and marked, and a truncated entry is never replayed", () => {
  it("buildEntry() truncates a value above JOURNAL_VALUE_MAX_BYTES and sets truncated:true", () => {
    const huge = "x".repeat(70 * 1024); // > 64KB
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(baseSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: baseSem.agentType,
      value: huge,
      completedAt: 1000,
      durationMs: 50,
    });
    expect(entry.truncated).toBe(true);
    expect(Buffer.byteLength(entry.value ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
    // digest covers the *truncated* bytes, not the original huge value.
    expect(entry.digest).toBe(entryDigest({ ...entry, digest: undefined as never } as never));
  });

  it("buildEntry() leaves a value at or under the limit untouched (no truncated field at all)", () => {
    const entry = makeEntry({ value: "short" });
    expect(entry.truncated).toBeUndefined();
    expect(entry.value).toBe("short");
  });

  it("a truncated entry round-trips through parseEntry with truncated:true preserved", () => {
    const huge = "y".repeat(70 * 1024);
    const entry = buildEntry({
      scope: "content",
      key: taskKeyOf(baseSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: baseSem.agentType,
      value: huge,
      completedAt: 1000,
      durationMs: 50,
    });
    const parsed = parseEntry(JSON.stringify(entry));
    expect(parsed).toEqual(entry);
    expect(parsed?.truncated).toBe(true);
  });

  it("never splits a multi-byte UTF-8 codepoint at the truncation boundary", () => {
    // A 3-byte-per-char string comfortably over the limit — if truncation
    // sliced mid-codepoint, `Buffer#toString("utf8")` would emit U+FFFD
    // replacement characters instead of dropping the partial tail cleanly.
    const huge = "\u4e2d".repeat(30_000); // "中" x 30000 ~ 90KB
    const entry = buildEntry({
      scope: "chain",
      key: taskKeyOf(baseSem),
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: baseSem.agentType,
      value: huge,
      completedAt: 1000,
      durationMs: 50,
    });
    expect(entry.truncated).toBe(true);
    expect(entry.value ?? "").not.toContain("\ufffd");
  });
});
