import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import {
  handleReviewLite,
  firstUserReviewCount as firstUserReviewPass,
} from "../../../src/memory/govern/review-lite.js";
import { readGovernBlock } from "../../../src/memory/govern/supersede.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
const roots: string[] = [];
const now = new Date("2026-11-06T00:00:00Z");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-lite-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("Jev-off list has deterministic suggestions, no writes", async () => {
  const dir = fixture();
  createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", expires: "2020-01-01" }, "rule", now);
  const messages: string[] = [];
  await handleReviewLite(
    dir,
    "--list",
    {
      notify: (m) => messages.push(m),
      select: async () => {
        throw new Error("must not prompt");
      },
    },
    { interactive: false, enabled: false, residentBudget: 512, now },
  );
  expect(messages[0]).toContain("expired-user");
  expect(readIndex(dir).index.review).toBeUndefined();
});
it("expired user renew uses CAS, then review dismissal expires", async () => {
  const dir = fixture();
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", expires: "2020-01-01" }, "rule", now);
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "extend" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  expect(readGovernBlock(dir, b.id).meta.expires).toBe("2026-12-06");
  expect(readGovernBlock(dir, b.id).meta.version).toBe(2);
});
it("keep until condition dismisses permanently, user never offered archive", async () => {
  const dir = fixture();
  createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", until: "done" }, "rule", now);
  await handleReviewLite(
    dir,
    "",
    {
      notify() {},
      select: async (_t, options) => {
        expect(options.map((x) => x.value)).not.toContain("archive");
        return "keep";
      },
    },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  expect(readIndex(dir).index.review?.dismissed[0]?.until).toBeUndefined();
});
it("changed block cannot be edited by stale dialog", async () => {
  const dir = fixture();
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", expires: "2020-01-01" }, "rule", now);
  const messages: string[] = [];
  await handleReviewLite(
    dir,
    "",
    {
      notify: (m) => messages.push(m),
      select: async () => {
        replaceBlockLocked(join(dir, "blocks"), b.id, b.rev, { meta: b.meta, body: "changed" }, now);
        return "delete";
      },
    },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  expect(readGovernBlock(dir, b.id).body).toBe("changed");
  expect(messages[0]).toContain("changed");
});
it("first review only compares active users, late verdict discarded and repeat deduplicates", async () => {
  const dir = fixture();
  const a = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "a", now);
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "b", now);
  createBlockLocked(join(dir, "blocks"), "rule", { authority: "agent" }, "c", now);
  createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", private: true }, "private user", now);
  const judge = async (p: readonly { a: string; b: string }[]) => {
    expect(p).toEqual([{ a: a.id, b: b.id }]);
    return p.map((x) => ({ ...x, p: 1 }));
  };
  expect(await firstUserReviewPass(dir, judge)).toBe(1);
  expect(await firstUserReviewPass(dir, judge)).toBe(0);
  expect(readGovernBlock(dir, a.id).meta.status).toBe("active");
});

it("migration-generated id anchors and scope-check actions are usable", async () => {
  const { writeGovernIndexLocked } = await import("../../../src/memory/govern/supersede.js");
  const { entryHash } = await import("../../../src/memory/jev/entries.js");
  const dir = fixture();
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", scope: "topic" }, "rule", now);
  writeGovernIndexLocked(dir, {
    v: 1,
    entries: {},
    review: {
      lastRunAt: "",
      corpusFp: "",
      suggestions: [
        {
          id: "migration-scope",
          kind: "scope-check",
          a: { hash: entryHash(b.body), anchor: b.id },
          p: 1,
          at: now.toISOString(),
        },
      ],
      dismissed: [],
    },
  });
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "global" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  expect(readGovernBlock(dir, b.id).meta.scope).toBe("global");
});

it("command restores blocks explicitly without Jev", async () => {
  const { createMemCommand } = await import("../../../src/memory/command.js");
  const { DEFAULT_SETTINGS } = await import("../../../src/config/settings.js");
  const { memoryDirFor } = await import("../../../src/memory/paths.js");
  const { supersede } = await import("../../../src/memory/govern/supersede.js");
  const root = fixture(),
    cwd = join(root, "project"),
    paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  mkdirSync(cwd);
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const a = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "new", now),
    b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "old", now);
  await supersede(dir, [
    { kind: "supersedes", newId: a.id, newRev: a.rev, oldId: b.id, oldRev: b.rev, p: 1, auto: true },
  ]);
  const messages: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: (m: string) => messages.push(m) },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;
  const command = createMemCommand({ paths, settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" } });
  await command.handler(`restore --block ${b.id}`, ctx);
  expect(messages.pop()).toContain("restored:");
  expect(readGovernBlock(dir, b.id).meta.status).toBe("active");
});

it("explicit archive action works while automatic governance is off, without rewriting until/expires", async () => {
  const { readArchiveIndex, restoreBlock } = await import("../../../src/memory/govern/sweep.js");
  const dir = fixture();
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "agent", until: "done" }, "state", now);
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "archive" },
    { interactive: true, enabled: false, residentBudget: 512, now },
  );
  expect(readArchiveIndex(dir)).toHaveProperty(`${b.id}.md`);
  await restoreBlock(dir, b.id);
  expect(readGovernBlock(dir, b.id).meta.until).toBe("done");
  expect(readGovernBlock(dir, b.id).meta.expires).toBeUndefined();
});

it("first semantic review discards an answer whose user was updated while judge was pending", async () => {
  const dir = fixture();
  const a = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "a", now);
  createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "b", now);
  const count = await firstUserReviewPass(dir, async (pairs) => {
    replaceBlockLocked(join(dir, "blocks"), a.id, a.rev, { meta: a.meta, body: "changed while judging" }, now);
    return pairs.map((pair) => ({ ...pair, p: 1 }));
  });
  expect(count).toBe(0);
  expect(readIndex(dir).index.review).toBeUndefined();
});

it("dismissal persists across block edits, reload, and later sweeps", async () => {
  const dir = fixture();
  const block = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user", until: "done" }, "old body", now);
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "keep" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  const stored = readIndex(dir).index.review!.dismissed;
  expect(stored).toHaveLength(1);
  expect(stored[0]!.suggestionKey).toBeDefined();
  replaceBlockLocked(
    join(dir, "blocks"),
    block.id,
    block.rev,
    { meta: block.meta, body: "completely changed body" },
    now,
  );
  const messages: string[] = [];
  await handleReviewLite(
    dir,
    "--list",
    { notify: (msg) => messages.push(msg), select: async () => "skip" },
    { interactive: false, enabled: true, residentBudget: 512, now: new Date("2027-01-01T00:00:00Z") },
  );
  expect(messages).toEqual(["review: no suggestions"]);
  expect(readIndex(dir).index.review!.dismissed).toEqual(stored);
});

it("dismissed migration conflict stays dismissed after both blocks are edited, without dismissing supersedes", async () => {
  const { supersede } = await import("../../../src/memory/govern/supersede.js");
  const dir = fixture();
  const a = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "first original text", now);
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "second original text", now);
  const judge = async (pairs: readonly { a: string; b: string }[]) => pairs.map((p) => ({ ...p, p: 1 }));
  expect(await firstUserReviewPass(dir, judge)).toBe(1);
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "keep" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  expect(readIndex(dir).index.review!.dismissed[0]?.suggestionKey).toBeDefined();
  replaceBlockLocked(
    join(dir, "blocks"),
    a.id,
    a.rev,
    { meta: a.meta, body: "rewritten first heading and content" },
    now,
  );
  replaceBlockLocked(
    join(dir, "blocks"),
    b.id,
    b.rev,
    { meta: b.meta, body: "rewritten second heading and content" },
    now,
  );
  expect(await firstUserReviewPass(dir, judge)).toBe(0);
  const next = readGovernBlock(dir, a.id),
    old = readGovernBlock(dir, b.id);
  const result = await supersede(dir, [
    { kind: "supersedes", newId: next.id, newRev: next.rev, oldId: old.id, oldRev: old.rev, p: 1, auto: true },
  ]);
  expect(result[0]).toMatchObject({ outcome: "superseded" });
  expect(readGovernBlock(dir, b.id).meta.status).toBe("superseded");
  expect(readIndex(dir).index.review!.suggestions).toEqual([]);
});

it("governance dismissal survives section and body edits across semantic review and locked merge", async () => {
  const { blockToEntry } = await import("../../../src/memory/blocks/adapter.js");
  const { runReviewPass } = await import("../../../src/memory/jev/review.js");
  const { writeIndexPatch } = await import("../../../src/memory/jev/index-store.js");
  const dir = fixture();
  const a = createBlockLocked(
    join(dir, "blocks"),
    "rule",
    { authority: "user", section: "original" },
    "release pipeline alpha old",
    now,
  );
  const b = createBlockLocked(
    join(dir, "blocks"),
    "rule",
    { authority: "user", section: "original" },
    "release pipeline beta old",
    now,
  );
  const judge = async (pairs: readonly { a: string; b: string }[]) => pairs.map((p) => ({ ...p, p: 1 }));
  expect(await firstUserReviewPass(dir, judge)).toBe(1);
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "keep" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  const editedA = replaceBlockLocked(
    join(dir, "blocks"),
    a.id,
    a.rev,
    { meta: { ...a.meta, section: "new-section" }, body: "new release pipeline alpha text" },
    now,
  );
  const editedB = replaceBlockLocked(
    join(dir, "blocks"),
    b.id,
    b.rev,
    { meta: { ...b.meta, section: "new-section" }, body: "new release pipeline beta text" },
    now,
  );
  const entries = [blockToEntry(editedA, "2026-11-08"), blockToEntry(editedB, "2026-11-08")];
  const index = readIndex(dir).index;
  expect(index.review!.dismissed).toHaveLength(1);
  const client: import("../../../src/memory/jev/contracts.js").JevClient = {
    status: () => ({ kind: "full", model: "test" }),
    probe: async () => ({ kind: "full", model: "test" }),
    ask: async (req) => ({
      ok: true,
      model: "test",
      missing: [],
      costUsd: 0,
      latencyMs: 0,
      answers: Object.fromEntries(
        Object.keys(req.questions).map((id) => [
          id,
          { type: "choice", choice: "conflict", probabilities: { conflict: 0.99 }, confidence: 0.99 },
        ]),
      ),
    }),
  };
  const run = (inputIndex: typeof index) =>
    runReviewPass({ client, registry: {}, entries, index: inputIndex, today: "2026-11-08" });
  const undismissed = await run({ ...index, review: { ...index.review!, dismissed: [] } });
  if ("ok" in undismissed) throw new Error("unexpected failure");
  expect(undismissed.suggestions.filter((s) => s.kind === "conflict")).toHaveLength(1);
  const outcome = await run(index);
  if ("ok" in outcome) throw new Error("unexpected failure");
  expect(outcome.suggestions.filter((s) => s.kind === "conflict")).toHaveLength(0);
  expect(await writeIndexPatch(dir, { review: outcome, reviewBase: index.review ?? null })).toBe("ok");
  expect(readIndex(dir).index.review!.suggestions.filter((s) => s.kind === "conflict")).toHaveLength(0);
  // A stale semantic result produced before dismissal must also be rejected at merge.
  expect(await writeIndexPatch(dir, { review: undismissed, reviewBase: null })).toBe("ok");
  expect(readIndex(dir).index.review!.suggestions.filter((s) => s.kind === "conflict")).toHaveLength(0);
});

it("cross-kind conflict dismiss permits semantic supersedes candidate, stale merge and review list", async () => {
  const { blockToEntry } = await import("../../../src/memory/blocks/adapter.js");
  const { runReviewPass } = await import("../../../src/memory/jev/review.js");
  const { writeIndexPatch } = await import("../../../src/memory/jev/index-store.js");
  const dir = fixture();
  const a = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "release pipeline alpha", now);
  const b = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "release pipeline beta", now);
  const judge = async (pairs: readonly { a: string; b: string }[]) => pairs.map((p) => ({ ...p, p: 1 }));
  expect(await firstUserReviewPass(dir, judge)).toBe(1);
  const snapshot = readIndex(dir).index;
  const entries = [blockToEntry(a, "2026-11-08"), blockToEntry(b, "2026-11-08")];
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client: import("../../../src/memory/jev/contracts.js").JevClient = {
    status: () => ({ kind: "full", model: "test" }),
    probe: async () => ({ kind: "full", model: "test" }),
    ask: async (req) => {
      started();
      await barrier;
      return {
        ok: true,
        model: "test",
        missing: [],
        costUsd: 0,
        latencyMs: 0,
        answers: Object.fromEntries(
          Object.keys(req.questions).map((id) => [
            id,
            { type: "choice", choice: "a_supersedes_b", probabilities: { a_supersedes_b: 0.99 }, confidence: 0.99 },
          ]),
        ),
      };
    },
  };
  const run = (index: typeof snapshot) => runReviewPass({ client, registry: {}, entries, index, today: "2026-11-08" });
  const inflight = run(snapshot);
  await asked;
  await handleReviewLite(
    dir,
    "",
    { notify() {}, select: async () => "keep" },
    { interactive: true, enabled: true, residentBudget: 512, now },
  );
  const current = readIndex(dir).index;
  expect(current.review!.dismissed[0]!.kind).toBe("conflict");
  release();
  const oldResult = await inflight;
  if ("ok" in oldResult) throw new Error("unexpected failure");
  expect(oldResult.suggestions.map((s) => s.kind)).toContain("supersedes");
  const freshResult = await run(current);
  if ("ok" in freshResult) throw new Error("unexpected failure");
  expect(freshResult.suggestions.map((s) => s.kind)).toContain("supersedes");
  expect(await writeIndexPatch(dir, { review: oldResult, reviewBase: snapshot.review ?? null })).toBe("ok");
  expect(readIndex(dir).index.review!.suggestions.map((s) => s.kind)).toEqual(["supersedes"]);
  const messages: string[] = [];
  await handleReviewLite(
    dir,
    "--list",
    { notify: (s) => messages.push(s), select: async () => "skip" },
    { interactive: false, enabled: true, residentBudget: 512, now },
  );
  expect(messages.join("\n")).toContain("[supersedes]");
});

it("bounds migration candidate selection before constructing neighbour pairs", async () => {
  const dir = fixture();
  const ids: string[] = [];
  for (let i = 0; i < 33; i++) {
    ids.push(createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, `body ${i}`, now).id);
  }
  ids.sort();
  const selected = ids.slice(0, 32);
  const expected = [1, 2].flatMap((distance) =>
    selected.slice(0, selected.length - distance).map((a, i) => ({ a, b: selected[i + distance] })),
  );
  let calls = 0;
  await firstUserReviewPass(dir, async (pairs) => {
    calls++;
    expect(pairs).toEqual(expected);
    expect(pairs).toHaveLength(61);
    expect(pairs.some((p) => p.a === ids[32] || p.b === ids[32])).toBe(false);
    return pairs.map((pair) => ({ ...pair, p: 0 }));
  });
  expect(calls).toBe(1);
});

it("forms one pair for two users and does not call judge for one", async () => {
  const dir = fixture();
  const first = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "one", now);
  let calls = 0;
  const judge = async (pairs: readonly { a: string; b: string }[]) => {
    calls++;
    expect(pairs).toEqual([{ a: first.id, b: second.id }]);
    return pairs.map((pair) => ({ ...pair, p: 0.5 }));
  };
  expect(await firstUserReviewPass(dir, judge)).toBe(0);
  expect(calls).toBe(0);
  const second = createBlockLocked(join(dir, "blocks"), "rule", { authority: "user" }, "two", now);
  expect(await firstUserReviewPass(dir, judge)).toBe(1);
  expect(calls).toBe(1);
});
