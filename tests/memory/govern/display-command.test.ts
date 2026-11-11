import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../../src/memory/command.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import { mergeReview, readIndex, suggestionKey } from "../../../src/memory/jev/index-store.js";
import { blockExpiredDisplay, blockReviewDisplay } from "../../../src/memory/govern/display.js";
import { blockAnchor } from "../../../src/memory/govern/supersede.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function snapshot(root: string) {
  const rows: string[] = [];
  function visit(p: string) {
    const st = lstatSync(p);
    rows.push(
      `${relative(root, p)} ${st.mtimeMs} ${st.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : "dir"}`,
    );
    if (st.isDirectory()) for (const name of readdirSync(p).sort()) visit(join(p, name));
  }
  visit(root);
  return rows;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "display-command-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(join(dir, "blocks", ".jev"), { recursive: true });
  writeFileSync(join(dir, "blocks", ".layout.json"), '{"v":1,"source":"fresh"}');
  const messages: string[] = [];
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (s: string) => messages.push(s),
      select: () => {
        throw new Error("must not prompt");
      },
    },
  } as unknown as ExtensionCommandContext;
  return { dir, ctx, paths, cmd: createMemCommand({ paths }), messages };
}
it("shows all suggestion kinds and four expiry quadrants without writing, including --run", async () => {
  const { dir, cmd, ctx, messages } = setup();
  const blocks = join(dir, "blocks");
  const now = new Date("2020-01-01T00:00:00Z");
  const a = createBlockLocked(blocks, "topic", { authority: "user", expires: "2020-01-01" }, "user expires", now);
  const b = createBlockLocked(
    blocks,
    "topic",
    { authority: "agent", expires: "2020-01-01", until: "finish" },
    "agent both",
    now,
  );
  createBlockLocked(blocks, "topic", { authority: "user", until: "finish" }, "user until", now);
  const old = createBlockLocked(blocks, "topic", { authority: "agent", expires: "2020-01-01" }, "superseded", now);
  replaceBlockLocked(
    blocks,
    old.id,
    old.rev,
    { meta: { ...old.meta, status: "superseded", supersededBy: a.id }, body: old.body },
    now,
  );
  mkdirSync(join(blocks, "archive"));
  writeFileSync(join(blocks, "archive", "topic.999.md"), readFileSync(join(blocks, `${b.id}.md`)));
  const ref = (v: typeof a) => ({ hash: entryHash(v.body), anchor: blockAnchor(v) });
  writeFileSync(
    join(blocks, ".jev", "index.json"),
    JSON.stringify({
      v: 1,
      entries: {},
      review: {
        lastRunAt: "",
        corpusFp: "",
        dismissed: [],
        suggestions: [
          { id: "duplicate-1", kind: "duplicate", a: ref(a), b: ref(b), p: 0.9, at: "2020-01-01T00:00:00Z" },
        ],
      },
    }),
  );
  const before = snapshot(dir);
  await cmd.handler("review", ctx);
  await cmd.handler("review --list", ctx);
  await cmd.handler("review --run", ctx);
  await cmd.handler("expired", ctx);
  expect(messages[0]).toBe(messages[1]);
  expect(messages[2]).toBe(`${messages[0]}\n只展示现有建议，不会启动整理。`);
  expect(messages[0]).toContain("review: 4 suggestions");
  expect(messages[0]).toContain("[duplicate]");
  expect(messages[0]).toContain("[expired-user]");
  expect(messages[0]!.match(/\[until-check\]/g)).toHaveLength(2);
  expect(messages[3]).toContain("expired: 4 entries");
  for (const label of ["user expires", "user until", "agent expires", "agent until"])
    expect(messages[3]).toContain(`[${label}]`);
  expect(messages[3]).not.toContain(old.id);
  expect(messages[3]).not.toContain("topic.999");
  expect(snapshot(dir)).toEqual(before);
});
it("empty blocks produce explicit results without creating a sidecar", async () => {
  const { dir, cmd, ctx, messages } = setup();
  const before = snapshot(dir);
  await cmd.handler("review", ctx);
  await cmd.handler("expired", ctx);
  expect(messages).toEqual(["review: no suggestions", "expired: no entries"]);
  expect(snapshot(dir)).toEqual(before);
});
it("files layout without Jev reports review unavailable and lists both fields independently", async () => {
  const { dir, cmd, ctx, messages } = setup();
  rmSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(
    join(dir, "core.md"),
    '# Core\n\n- user <!-- mem user expires=2020-01-01 until="done" -->\n\n- agent <!-- mem lesson until="done" -->\n',
  );
  const before = snapshot(dir);
  await cmd.handler("review", ctx);
  await cmd.handler("expired", ctx);
  expect(messages[0]).toContain("未启用建议索引");
  expect(messages[1]).toContain("expired: 3 entries");
  expect(messages[1]).toContain("[user expires]");
  expect(messages[1]).toContain("[user until]");
  expect(messages[1]).toContain("[agent until]");
  expect(snapshot(dir)).toEqual(before);
});

it("keeps same-id distinct semantic suggestions and folds reversed duplicate pairs", async () => {
  const { dir, cmd, ctx, messages } = setup();
  const blocks = join(dir, "blocks");
  const now = new Date("2026-01-01T00:00:00Z");
  const a = createBlockLocked(blocks, "topic", { authority: "agent" }, "alpha", now);
  const b = createBlockLocked(blocks, "topic", { authority: "agent" }, "beta", now);
  const c = createBlockLocked(blocks, "topic", { authority: "agent" }, "gamma", now);
  const ref = (v: typeof a) => ({ hash: entryHash(v.body), anchor: blockAnchor(v) });
  const duplicate = { id: "p1", kind: "duplicate" as const, a: ref(a), b: ref(b), p: 0.9, at: "2026-01-01" };
  const conflict = { id: "p1", kind: "conflict" as const, a: ref(a), b: ref(c), p: 0.9, at: "2026-01-01" };
  const state = { lastRunAt: "", corpusFp: "", dismissed: [], suggestions: [duplicate, conflict] };
  const merged = mergeReview(undefined, state);
  expect(merged.suggestions).toHaveLength(2);
  const reversed = { ...duplicate, id: "p99", a: duplicate.b, b: duplicate.a };
  writeFileSync(
    join(blocks, ".jev", "index.json"),
    JSON.stringify({ v: 1, entries: {}, review: { ...merged, suggestions: [...merged.suggestions, reversed] } }),
  );
  expect(readIndex(dir).index.review?.suggestions).toHaveLength(3);
  const before = snapshot(dir);
  await cmd.handler("review", ctx);
  expect(messages[0]).toContain("review: 2 suggestions");
  expect(messages[0]).toContain(`[duplicate] ${a.id}.md vs ${b.id}.md`);
  expect(messages[0]).toContain(`[conflict] ${a.id}.md vs ${c.id}.md`);
  expect(snapshot(dir)).toEqual(before);
});

it("filters persisted tombstones even when stale suggestions coexist in the index", async () => {
  const { dir, cmd, ctx, messages } = setup();
  const blocks = join(dir, "blocks");
  const now = new Date("2026-01-01T00:00:00Z");
  const a = createBlockLocked(blocks, "topic", { authority: "agent" }, "alpha", now);
  const b = createBlockLocked(blocks, "topic", { authority: "agent" }, "beta", now);
  const ref = (v: typeof a) => ({ hash: entryHash(v.body), anchor: blockAnchor(v) });
  const duplicate = { id: "p1", kind: "duplicate" as const, a: ref(a), b: ref(b), p: 0.9, at: "2026-01-01" };
  const tombstone = { hashKey: "", anchorKey: "", suggestionKey: suggestionKey(duplicate) };
  writeFileSync(
    join(blocks, ".jev", "index.json"),
    JSON.stringify({
      v: 1,
      entries: {},
      review: { lastRunAt: "", corpusFp: "", dismissed: [tombstone], suggestions: [duplicate] },
    }),
  );
  expect(readIndex(dir).index.review?.suggestions).toHaveLength(1);
  const before = snapshot(dir);
  await cmd.handler("review", ctx);
  expect(messages[0]).toBe("review: no suggestions");
  expect(snapshot(dir)).toEqual(before);
});

it("shows pure transient governance and excludes today and future expires", async () => {
  const { dir } = setup();
  const blocks = join(dir, "blocks");
  const now = new Date("2026-01-01T00:00:00Z");
  const past = createBlockLocked(blocks, "topic", { authority: "user", expires: "2026-01-01" }, "past", now);
  const today = createBlockLocked(blocks, "topic", { authority: "user", expires: "2026-11-08" }, "today", now);
  const future = createBlockLocked(blocks, "topic", { authority: "agent", expires: "2026-11-09" }, "future", now);
  const before = snapshot(dir);
  expect(blockReviewDisplay(dir, "2026-11-08")).toContain(`[expired-user] ${past.id}.md`);
  const expired = blockExpiredDisplay(dir, "2026-11-08");
  expect(expired).toContain("expired: 1 entries");
  expect(expired).toContain(past.id);
  expect(expired).not.toContain(today.id);
  expect(expired).not.toContain(future.id);
  expect(snapshot(dir)).toEqual(before);
});

it("files Jev review variants are read-only without model, sweep, confirmation or writes", async () => {
  const { dir, ctx, messages } = setup();
  rmSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(join(dir, "core.md"), "# Core\n\n- item <!-- mem lesson expires=2020-01-01 -->\n");
  const list = vi.fn(() => []);
  const run = vi.fn();
  const classify = vi.fn();
  const confirm = vi.fn();
  const select = vi.fn();
  const onAfterWrite = vi.fn();
  const jev = { review: { list, run } } as unknown as import("../../../src/memory/jev/contracts.js").JevCommandPort;
  const command = createMemCommand({
    paths: { memoryRoot: join(dir, ".."), ccProjectsRoot: join(dir, "..", "cc") },
    jev,
    onAfterWrite,
  });
  const testCtx = {
    ...ctx,
    modelRegistry: { classify },
    ui: { ...ctx.ui, confirm, select },
  } as unknown as ExtensionCommandContext;
  const before = snapshot(dir);
  for (const args of ["review", "review --list", "review --run", "expired"]) await command.handler(args, testCtx);
  expect(messages.slice(0, 3)).toEqual(["review: no suggestions", "review: no suggestions", "review: no suggestions"]);
  expect(messages[3]).toContain("expired: 1 entries");
  expect(list).toHaveBeenCalledTimes(3);
  expect(run).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(onAfterWrite).not.toHaveBeenCalled();
  expect(snapshot(dir)).toEqual(before);
});

it("blocks Jev review variants never invoke side effects or change fixture bytes", async () => {
  const { dir, ctx, paths, messages } = setup();
  createBlockLocked(
    join(dir, "blocks"),
    "topic",
    { authority: "agent", expires: "2020-01-01" },
    "expired",
    new Date("2020-01-01T00:00:00Z"),
  );
  const run = vi.fn();
  const list = vi.fn();
  const classify = vi.fn();
  const confirm = vi.fn();
  const select = vi.fn();
  const onAfterWrite = vi.fn();
  const jev = { review: { list, run } } as unknown as import("../../../src/memory/jev/contracts.js").JevCommandPort;
  const command = createMemCommand({ paths, jev, onAfterWrite });
  const testCtx = {
    ...ctx,
    modelRegistry: { classify },
    ui: { ...ctx.ui, confirm, select },
  } as unknown as ExtensionCommandContext;
  const before = snapshot(dir);
  for (const args of ["review", "review --list", "review --run", "expired"]) await command.handler(args, testCtx);
  expect(messages[0]).toBe(messages[1]);
  expect(messages[2]).toBe(`${messages[0]}\n只展示现有建议，不会启动整理。`);
  expect(messages[3]).toContain("expired: 1 entries");
  for (const spy of [run, list, classify, confirm, select, onAfterWrite]) expect(spy).not.toHaveBeenCalled();
  expect(snapshot(dir)).toEqual(before);
});

it("content-readonly child continues rejecting review and expired before discovery", async () => {
  const { dir, ctx, paths, messages } = setup();
  const onAfterWrite = vi.fn();
  const cmd = createMemCommand({ paths, isChildSession: true, contentReadonly: true, onAfterWrite });
  const before = snapshot(dir);
  for (const args of ["review", "review --list", "review --run", "expired"]) await cmd.handler(args, ctx);
  expect(messages).toHaveLength(4);
  for (const message of messages) expect(message).toContain("E_CHILD_READONLY");
  expect(onAfterWrite).not.toHaveBeenCalled();
  expect(snapshot(dir)).toEqual(before);
});
