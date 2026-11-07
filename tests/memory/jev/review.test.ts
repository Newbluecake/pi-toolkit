// review tests (jev-plan §4 J4 第 6 条: 配对（共享标签 + Jaccard 前 5）、600 截断
// 优先级、dismissed 双键、stale、疑似用户令建议、runReviewPass 集成).

import { describe, expect, test } from "vitest";
import {
  anchorOf,
  buildPairs,
  isDismissed,
  markStale,
  runReviewPass,
  staleCandidates,
  suggestionsFrom,
} from "../../../src/memory/jev/review.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import type {
  ClassifierRegistryLike,
  DismissedPair,
  EntryTags,
  JevAnswer,
  JevClient,
  JevIndexV1,
  JevOutcome,
  JevRequest,
  JevStatus,
  MemEntry,
  ReviewSuggestion,
} from "../../../src/memory/jev/contracts.js";

// ───────────────────────────── helpers ─────────────────────────────

function entriesFrom(lines: readonly string[], file = "core.md"): readonly MemEntry[] {
  const raw = ["# Core", "", "## Rules", "", ...lines].join("\n") + "\n";
  return splitEntries(file, raw, { status: "active", handWritten: false });
}

function record(over: Record<string, unknown> = {}): EntryTags {
  return {
    file: "core.md",
    type: "rule",
    typeP: 0.9,
    importance: 2,
    tags: {},
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13-free",
    at: "2026-10-01T00:00:00.000Z",
    taxonomyRev: "rev00001",
    ...over,
  };
}

function indexWith(entries: readonly MemEntry[], make: (e: MemEntry) => EntryTags | undefined): JevIndexV1 {
  const out: JevIndexV1 = { v: 1, entries: {} };
  for (const e of entries) {
    const rec = make(e);
    if (rec !== undefined) out.entries[e.hash] = rec;
  }
  return out;
}

interface AskRecord {
  readonly duty: JevRequest["duty"];
  readonly state: JevRequest["state"];
  readonly questions: Record<string, JevRequest["questions"][string]>;
}

function fakeClient(script: (record: AskRecord, calls: number) => Record<string, JevAnswer> | JevOutcome): JevClient & {
  asks: readonly AskRecord[];
} {
  const asks: AskRecord[] = [];
  const client: JevClient = {
    status: (): JevStatus => ({ kind: "full", model: "opencode/jev-1.13-free" }),
    ask: async (req: JevRequest): Promise<JevOutcome> => {
      asks.push({ duty: req.duty, state: req.state, questions: req.questions });
      const n = asks.length;
      const out = script(asks[n - 1]!, n);
      if ("ok" in out) return out;
      return { ok: true, model: "m", answers: out, missing: [], costUsd: 0.0001, latencyMs: 1 };
    },
    probe: async (): Promise<JevStatus> => ({ kind: "full", model: "m" }),
  };
  return Object.assign(client, { asks });
}

const registry = {} as ClassifierRegistryLike;

// ───────────────────────────── anchorOf / isDismissed ─────────────────────────────

describe("anchorOf (§4.4)", () => {
  test("file|section|first-24-code-points, comment already stripped", () => {
    const [e] = entriesFrom([
      "- <!-- mem user --> always wrap long commands with timeout before running them, plus more tail",
    ]);
    // `body` keeps the list marker (only the inline comment is stripped).
    expect(anchorOf(e!)).toBe(`core.md|Rules|-  always wrap long comm`);
  });

  test("section changes move the anchor", () => {
    const [e] = entriesFrom(["- always wrap long commands with timeout"]);
    const other = splitEntries("core.md", "# Core\n\n## Other\n\n- always wrap long commands with timeout\n", {
      status: "active",
      handWritten: false,
    })[0]!;
    expect(anchorOf(e!) === anchorOf(other)).toBe(false);
  });
});

describe("isDismissed / dismissed 双键 (评审 #7)", () => {
  const [a, b] = entriesFrom([
    "- first rule with a fairly unique body alpha",
    "- second rule with a fairly unique body beta",
  ]);
  const dismissed: readonly DismissedPair[] = [
    {
      hashKey: [a!.hash, b!.hash].sort().join("+"),
      anchorKey: [anchorOf(a!), anchorOf(b!)].sort().join("+"),
    },
  ];
  const pair = { a: { hash: a!.hash, anchor: anchorOf(a!) }, b: { hash: b!.hash, anchor: anchorOf(b!) } };

  test("hashKey match ⇒ dismissed", () => {
    expect(isDismissed(pair, dismissed)).toBe(true);
  });

  test("editing past the first 24 code points: hash changed, anchor stable ⇒ still dismissed", () => {
    const edited = entriesFrom([
      "- first rule with a fairly unique body alpha, plus an edited tail that changes the hash",
    ])[0]!;
    expect(edited.hash).not.toBe(a!.hash);
    expect(anchorOf(edited)).toBe(anchorOf(a!));
    expect(isDismissed({ a: { hash: edited.hash, anchor: anchorOf(edited) }, b: pair.b }, dismissed)).toBe(true);
  });

  test("rewriting the head (first 24 cp) or the section re-opens the pair", () => {
    const rewritten = entriesFrom(["- REWRITTEN head rule with a fairly unique body alpha"])[0]!;
    expect(
      isDismissed({ a: { hash: rewritten.hash, anchor: anchorOf(rewritten) }, b: pair.b }, [
        { ...dismissed[0]!, hashKey: "zz" },
      ]),
    ).toBe(false);
    const moved = splitEntries("core.md", "# Core\n\n## Moved\n\n- first rule with a fairly unique body alpha\n", {
      status: "active",
      handWritten: false,
    })[0]!;
    expect(anchorOf(moved)).not.toBe(anchorOf(a!));
  });

  test("single-entry (obsolete/user-like) shape: anchorKey alone matches", () => {
    const single: readonly DismissedPair[] = [{ hashKey: b!.hash, anchorKey: anchorOf(b!) }];
    expect(isDismissed({ a: { hash: "nope", anchor: anchorOf(b!) } }, single)).toBe(true);
    expect(isDismissed({ a: { hash: "nope", anchor: "core.md|Rules|other" } }, single)).toBe(false);
  });
});

// ───────────────────────────── buildPairs (§6.3.2) ─────────────────────────────

describe("buildPairs", () => {
  test("shared effective tag pairs entries even with disjoint vocabulary; untagged outlier stays out", () => {
    const entries = entriesFrom([
      "- zebra yarn quilt ombré floral patchwork stitch", // tagged, unique words
      "- karaoke gondola telescope falafel stencil mural", // tagged, unique words
      "- ukulele hammock candle labyrinth sparkle poncho", // untagged outlier
    ]);
    const index = indexWith(entries, (e) =>
      e.body.includes("ukulele") ? undefined : record({ tags: { release: { p: 0.9, rev: 1 } } }),
    );
    const pairs = buildPairs(entries, index, []);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a.hash, pairs[0]!.b.hash].sort().join("+")).toBe(
      [entries[0]!.hash, entries[1]!.hash].sort().join("+"),
    );
  });

  test("inline tags=+/− adjust the effective set", () => {
    const entries = entriesFrom([
      "- <!-- mem tags=+docs --> entry one about documentation conventions",
      "- <!-- mem tags=-docs --> entry two about documentation conventions",
    ]);
    // Both have docs in the sidecar; entry one reinforces it, entry two
    // removes it ⇒ no SHARED tag — but the near-identical bodies still pair
    // via Jaccard (that is the point: both paths coexist).
    const index = indexWith(entries, () => record({ tags: { docs: { p: 0.9, rev: 1 } } }));
    const pairs = buildPairs(entries, index, []);
    expect(pairs).toHaveLength(1);
    const side = (p: (typeof pairs)[number]) => [p.a.hash, p.b.hash];
    expect(side(pairs[0]!).sort()).toEqual([entries[0]!.hash, entries[1]!.hash].sort());
  });

  test("Jaccard top-5: the least-similar of 7 similar entries is dropped by the others but still selects 5 itself", () => {
    const base = "deploy note: export https_proxy=http://127.0.0.1:7890 before git push or github times out";
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => `- ${base} case${String(i)}`),
      // e6 carries extra junk tokens: strictly least similar to everyone.
      `- ${base} case6 extra junk words padding that lower the overlap ratio substantially`,
      "- ukulele hammock candle labyrinth sparkle poncho", // unrelated outlier
    ];
    const entries = entriesFrom(lines);
    const pairs = buildPairs(
      entries,
      indexWith(entries, () => undefined),
      [],
    );
    // e0..e5 are mutually top-of each other's lists: all C(6,2)=15 present.
    // Everyone drops e6 (strictly least similar); e6 itself still picks its
    // own top 5 of the remaining 6 ⇒ 15 + 5 = 20 (C(8,2) would be 28; with
    // 7 similar entries and no cap it would be 21).
    expect(pairs).toHaveLength(20);
    const outlier = entries[7]!;
    expect(pairs.every((p) => p.a.hash !== outlier.hash && p.b.hash !== outlier.hash)).toBe(true);
  });

  test("cap 600 with priority: user-order and non-permanent pairs survive the cut", () => {
    // 40 hand-written (user) + 60 agent entries, all sharing one tag ⇒
    // 100*99/2 = 4950 pairs, capped at 600 — every pair involving a user
    // entry (40*39/2 + 40*60 = 3180 ≥ 600) must fill the cap first.
    const lines = Array.from({ length: 100 }, (_, i) => `- shared tag rule number ${String(i)} with some shared words`);
    const raw = ["# Core", "", "## Rules", "", ...lines].join("\n") + "\n";
    const entries = splitEntries("core.md", raw, { status: "active", handWritten: true });
    const index = indexWith(entries, (e) => record({ tags: { docs: { p: 0.9, rev: 1 } } }) as EntryTags);
    const pairs = buildPairs(entries, index, [], 600);
    expect(pairs).toHaveLength(600);
    const userHashes = new Set(entries.filter((e) => e.authority === "user").map((e) => e.hash));
    expect(pairs.every((p) => userHashes.has(p.a.hash) || userHashes.has(p.b.hash))).toBe(true);
  });

  test("dismissed pairs are excluded; priority ordering is stable (insertion order within a class)", () => {
    const entries = entriesFrom([
      "- alpha rule about the release flow",
      "- beta rule about the release flow",
      "- gamma rule about the release flow",
    ]);
    const index = indexWith(entries, () => record({ tags: { release: { p: 0.9, rev: 1 } } }));
    const dismissedKey = {
      hashKey: [entries[0]!.hash, entries[1]!.hash].sort().join("+"),
      anchorKey: [anchorOf(entries[0]!), anchorOf(entries[1]!)].sort().join("+"),
    };
    const pairs = buildPairs(entries, index, [dismissedKey]);
    const keys = pairs.map((p) => [p.a.hash, p.b.hash].sort().join("+"));
    expect(keys).not.toContain(dismissedKey.hashKey);
    expect(keys).toHaveLength(2);
  });
});

// ───────────────────────────── staleCandidates (§6.3.2) ─────────────────────────────

describe("staleCandidates", () => {
  test("sidecar temporal dated/event, plus bodies carrying dates or versions", () => {
    const entries = entriesFrom([
      "- dated entry that lives on its sidecar temporal",
      "- permanent entry mentioning v1.2 in its body",
      "- plain permanent entry with no dates at all",
      "- <!-- mem private --> private entry with v3.4 never asked",
    ]);
    const index = indexWith(entries, (e) => {
      if (e.body.includes("dated entry")) return record({ temporal: "dated" });
      if (e.body.includes("plain permanent")) return record({ temporal: "permanent" });
      return undefined;
    });
    const stale = staleCandidates(entries, index);
    const bodies = stale.map((s) => s.entry.body);
    expect(bodies.some((b) => b.includes("dated entry"))).toBe(true);
    expect(bodies.some((b) => b.includes("v1.2"))).toBe(true);
    expect(bodies.some((b) => b.includes("plain permanent"))).toBe(false);
    expect(bodies.some((b) => b.includes("private"))).toBe(false);
    expect(stale.find((s) => s.entry.body.includes("dated entry"))!.temporal).toBe("dated");
  });
});

// ───────────────────────────── suggestionsFrom / markStale ─────────────────────────────

describe("suggestionsFrom + markStale (§6.3.4 thresholds)", () => {
  const pairs = [
    {
      id: "p1",
      a: { hash: "aaaaaaaaaaaa", anchor: "core.md|Rules|a" },
      b: { hash: "bbbbbbbbbbbb", anchor: "core.md|Rules|b" },
    },
  ];
  const staleCands = [{ id: "o1", hash: "cccccccccccc", anchor: "core.md|Rules|c" }];

  test("relation ≥ 0.75 with duplicate ⇒ duplicate suggestion; below ⇒ none", () => {
    const answers: Record<string, JevAnswer> = {
      p1: { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.9 }, confidence: 0.9 },
    };
    expect(suggestionsFrom(answers, pairs)[0]!.kind).toBe("duplicate");
    const low: Record<string, JevAnswer> = {
      p1: { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.6 }, confidence: 0.6 },
    };
    expect(suggestionsFrom(low, pairs)).toHaveLength(0);
  });

  test("b_supersedes_a flips the pair so `a` names the surviving side", () => {
    const answers: Record<string, JevAnswer> = {
      p1: { type: "choice", choice: "b_supersedes_a", probabilities: { b_supersedes_a: 0.9 }, confidence: 0.9 },
    };
    const [s] = suggestionsFrom(answers, pairs);
    expect(s!.kind).toBe("supersedes");
    expect(s!.a.hash).toBe("bbbbbbbbbbbb");
  });

  test("obsolescence ≥ 0.8 ⇒ obsolete suggestion (single-entry)", () => {
    const answers: Record<string, JevAnswer> = { o1: { type: "bool", probability: 0.85 } };
    const [s] = suggestionsFrom(answers, [], staleCands);
    expect(s!.kind).toBe("obsolete");
    expect(s!.a.hash).toBe("cccccccccccc");
  });

  test("markStale: either side's hash missing from the corpus flags stale", () => {
    const suggestions: readonly ReviewSuggestion[] = [
      { id: "p1", kind: "duplicate", a: { hash: "aa", anchor: "x" }, b: { hash: "bb", anchor: "y" }, p: 0.9, at: "t" },
      { id: "o1", kind: "obsolete", a: { hash: "cc", anchor: "z" }, p: 0.9, at: "t" },
    ];
    const views = markStale(suggestions, new Set(["aa", "cc"]));
    expect(views.map((v) => v.stale)).toEqual([true, false]); // bb gone ⇒ stale
  });
});

// ───────────────────────────── runReviewPass ─────────────────────────────

describe("runReviewPass (§6.3.3 integration)", () => {
  test("builds p/o questions from pairs and stale candidates; carries dismissed; sets corpusFp", async () => {
    const entries = entriesFrom([
      "- release rule alpha about the release flow",
      "- release rule beta about the release flow",
      "- temporary rule until v0.10 ships with a version",
    ]);
    const prevDismissed: readonly DismissedPair[] = [{ hashKey: "keepme+zz", anchorKey: "keepanchor|zz" }];
    const index: JevIndexV1 = {
      v: 1,
      entries: Object.fromEntries(
        entries.map((e) => [
          e.hash,
          record({ tags: { release: { p: 0.9, rev: 1 } }, ...(e.body.includes("v0.10") ? { temporal: "event" } : {}) }),
        ]),
      ),
      review: { lastRunAt: "2026-10-01T00:00:00.000Z", corpusFp: "old", suggestions: [], dismissed: prevDismissed },
    };
    const client = fakeClient((rec) => {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(rec.questions)) {
        if (id.startsWith("p")) {
          answers[id] = { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.9 }, confidence: 0.9 };
        } else {
          answers[id] = { type: "bool", probability: 0.9 };
        }
      }
      return answers;
    });
    const out = await runReviewPass({ client, registry, entries, index, today: "2026-10-30", project: "demo" });
    expect("ok" in out).toBe(false);
    if ("ok" in out) return;
    expect(out.dismissed).toEqual(prevDismissed);
    expect(out.corpusFp).not.toBe("old");
    expect(out.suggestions.some((s) => s.kind === "duplicate")).toBe(true);
    expect(out.suggestions.some((s) => s.kind === "obsolete")).toBe(true);
    // Every ask was duty review and carried the project in state.
    expect(client.asks.length).toBeGreaterThan(0);
    expect(client.asks.every((a) => a.duty === "review")).toBe(true);
    expect(client.asks[0]!.state["project"]).toBe("demo");
  });

  test("failed call fails the pass fast (no partial state written)", async () => {
    const entries = entriesFrom(["- release rule alpha", "- release rule beta"]);
    const index = indexWith(entries, () => record({ tags: { release: { p: 0.9, rev: 1 } } }));
    const client = fakeClient(() => ({ ok: false, reason: "all-failed", detail: "System One API error (451)" }));
    const out = await runReviewPass({ client, registry, entries, index, today: "2026-10-30" });
    expect(out).toMatchObject({ ok: false, reason: "all-failed" });
  });

  test("userLike ≥ 0.8 on an agent entry ⇒ user-like suggestion (zero calls)", async () => {
    const entries = entriesFrom(["- agent lesson that reads like a user order: never push on Fridays"]);
    const index = indexWith(entries, () => record({ userLike: 0.9 }));
    const client = fakeClient(() => ({}));
    const out = await runReviewPass({ client, registry, entries, index, today: "2026-10-30" });
    if ("ok" in out) throw new Error("expected ReviewState");
    expect(out.suggestions.some((s) => s.kind === "user-like" && s.p === 0.9)).toBe(true);
  });

  test("pre-aborted signal ⇒ aborted outcome, zero asks", async () => {
    const entries = entriesFrom(["- release rule alpha", "- release rule beta"]);
    const index = indexWith(entries, () => record({ tags: { release: { p: 0.9, rev: 1 } } }));
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient(() => ({}));
    const out = await runReviewPass({
      client,
      registry,
      entries,
      index,
      today: "2026-10-30",
      signal: controller.signal,
    });
    expect(out).toMatchObject({ ok: false, reason: "aborted" });
    expect(client.asks).toHaveLength(0);
  });
});
