import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import { handleReviewLite, firstUserReviewPass } from "../../../src/memory/govern/review-lite.js";
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
it("keep until condition dismisses 14 days, user never offered archive", async () => {
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
  expect(readIndex(dir).index.review?.dismissed[0]?.until).toBe("2026-11-20");
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

it("command routes blocks tidy and restore explicitly, without Jev or a tidy agent", async () => {
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
  await command.handler("tidy --batch", ctx);
  expect(messages.pop()).toBe("memory: /mem tidy is disabled for block-layout directories — use /mem review");
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
