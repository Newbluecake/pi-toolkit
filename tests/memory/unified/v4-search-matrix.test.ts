import { afterEach, expect, it } from "vitest";
import { selectScopedEntries } from "../../../src/memory/unified/read.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_MEMORY_ENTRY_TYPE } from "../../../src/memory/scopes/types.js";
import { harness, STAMP } from "./helpers.js";
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  closes.push(h.close);
  return h;
}

it("scoped matching is literal, body-only, case-insensitive, id sorted and bounded at 50", () => {
  const entries = Array.from({ length: 65 }, (_, i) => ({
    id: `n${i + 1}`,
    rev: `r${i}`,
    item: { text: i % 2 ? "alpha A.*[B] zeta" : "ALPHA a.*[b] ZETA", from: "metadata-only" },
  })).reverse();
  for (const command of ["view", "search"] as const) {
    const result = selectScopedEntries(entries, { command, query: "A.*[B]" });
    expect(result).toEqual([...entries].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 50));
    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe("n1");
    expect(result[1]?.id).toBe("n10");
  }
  expect(selectScopedEntries(entries, { command: "search", query: "a.+[b]" })).toEqual([]);
  expect(selectScopedEntries(entries, { command: "search", query: "alpha zeta" })).toEqual([]);
  expect(selectScopedEntries(entries, { command: "search", query: "metadata-only" })).toEqual([]);
  expect(entries[0]?.id).toBe("n65"); // input ordering is untouched
});
it.each(["session", "hub"] as const)(
  "runs real %s CRUD/search with exact current rev, CAS and no search writes",
  async (scope) => {
    const h = setup();
    const topic = scope === "hub" ? { topic: "fact" } : {};
    const put = async (text: string) => {
      if (scope === "hub") h.human();
      return (await h.call({ command: "create", scope, text, ...topic })) as { id: string; rev: string };
    };
    const one = await put("The A.*[B] literal"),
      two = await put("the a.*[b] lowercase");
    expect(one).toMatchObject({ ok: true });
    expect(two).toMatchObject({ ok: true });
    const appends = h.append.mock.calls.length,
      selects = h.select.mock.calls.length;
    const result = (await h.call({ command: "search", scope, query: "a.*[B]" })) as {
      kind: string;
      hits: { id: string; rev: string; item: { text: string } }[];
    };
    expect(result).toMatchObject({ ok: true, kind: "hits" });
    expect(result.hits.map((h) => h.id)).toEqual([one.id, two.id].sort());
    const view = (await h.call({ command: "view", scope, id: one.id })) as { id: string; rev: string; item: unknown };
    expect(result.hits[0]).toEqual({ id: view.id, rev: view.rev, item: view.item });
    expect(await h.call({ command: "search", scope, query: "a.+[B]" })).toEqual({ ok: true, kind: "hits", hits: [] });
    expect(h.append.mock.calls).toHaveLength(appends);
    expect(h.select.mock.calls).toHaveLength(selects);
    if (scope === "hub") h.human();
    expect(await h.call({ command: "update", scope, id: one.id, rev: view.rev, text: "new body" })).toMatchObject({
      ok: true,
    });
    const updated = (await h.call({ command: "view", scope, id: one.id })) as { rev: string; item: { text: string } };
    expect(updated.rev).not.toBe(view.rev);
    expect(updated.item.text).toBe("new body");
    for (const command of ["update", "delete"])
      expect(await h.call({ command, scope, id: one.id, rev: view.rev, text: "stale" })).toMatchObject({
        ok: false,
        code: "E_CONFLICT",
      });
    if (scope === "hub") h.human();
    expect(
      await h.call({ command: "delete", scope, id: one.id, rev: updated.rev, text: "must ignore substitute" }),
    ).toMatchObject({ ok: true });
    expect(await h.call({ command: "view", scope, id: one.id })).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
  },
);
it("project commands retain v3 semantics and aggregate search has exactly four hit fields", async () => {
  const h = setup();
  expect(await h.call({ command: "create", topic: "fact", text: "Alpha searchable body" })).toHaveProperty("content");
  const oldView = await h.v3.execute("old", { command: "view" }, undefined, undefined, h.ctx);
  const all = await h.call({ command: "view", scope: "all" });
  expect(all).toHaveProperty("groups.project", {
    kind: "listing",
    text: oldView.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
  });
  const read = () =>
    parseBlockFile(
      "fact.001.md",
      readFileSync(join(memoryDirFor(h.dir, h.projectDeps.paths), "blocks", "fact.001.md"), "utf8"),
    );
  const block = read();
  if ("stray" in block) throw Error("invalid block");
  expect(await h.call({ command: "search", scope: "all", query: "SEARCHABLE" })).toHaveProperty("groups.project", {
    kind: "hits",
    hits: [{ path: "fact.001", rev: block.rev, line: 1, text: "Alpha searchable body" }],
  });
  expect(await h.call({ command: "search", query: "searchable" })).toHaveProperty("content");
  expect(
    await h.call({ command: "update", path: "fact.001", rev: block.rev, text: "replacement body" }),
  ).toHaveProperty("content");
  const changed = read();
  if ("stray" in changed) throw Error("invalid updated block");
  expect(changed.body).toBe("replacement body");
  expect(changed.rev).not.toBe(block.rev);
  expect(await h.call({ command: "delete", path: "fact.001" })).toHaveProperty("content"); // project delete rev remains optional
  expect(await h.call({ command: "view", path: "fact.001" })).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
});
it.each([true, false])("scopes-on child project rejects every mutation with old allow=%s", async (allowChild) => {
  const h = setup({ child: true, allowChild });
  for (const params of [
    { command: "create", topic: "fact", text: "x" },
    { command: "update", path: "fact.001", rev: "stale", text: "x" },
    { command: "delete", path: "fact.001" },
  ])
    expect(await h.call(params)).toMatchObject({ ok: false, code: "E_READONLY" });
  expect(h.projectRun).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});
it.each([true, false])("scopes-off child preserves original write opt-in=%s", async (allowChild) => {
  const h = setup({ child: true, scopesOn: false, allowChild });
  const result = await h.call({ command: "create", topic: "fact", text: "x" });
  if (allowChild) expect(result).toHaveProperty("content");
  else expect(result).toMatchObject({ ok: false, code: "E_READONLY" });
});
it("Hub still requires real approval, ignores authority, and oversized writes never ask", async () => {
  const h = setup();
  expect(
    await h.call({ command: "create", scope: "hub", topic: "fact", text: "no proof", authority: "agent" }),
  ).toMatchObject({ ok: false, code: "E_HUB_NEEDS_HUMAN_TURN" });
  h.human();
  for (const scope of ["session", "hub"])
    expect(
      await h.call({
        command: "create",
        scope,
        text: "x".repeat(1025),
        ...(scope === "hub" ? { topic: "fact" } : { authority: "user" }),
      }),
    ).toMatchObject({ ok: false, code: "E_TOO_LARGE" });
  expect(h.select).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
  expect(
    await h.call({ command: "create", scope: "hub", topic: "fact", text: "approved fact", authority: "agent" }),
  ).toMatchObject({ ok: true });
  expect(h.select).toHaveBeenCalledTimes(1);
  const view = (await h.call({ command: "view", scope: "hub" })) as { items: { item: { authority: string } }[] };
  expect(view.items[0]?.item.authority).toBe("user");
});

it("real folded historical session snapshots apply the per-scope 50-hit/read cap", async () => {
  const h = setup();
  const items = Array.from({ length: 60 }, (_, i) => ({
    id: `n${i + 1}`,
    text: "Literal [A.*] fact",
    authority: "agent",
    created: STAMP,
    updated: STAMP,
  }));
  h.manager.appendCustomEntry(SESSION_MEMORY_ENTRY_TYPE, { v: 1, sid: h.owner.sid, op: "snap", items, nextN: 61 });
  expect(h.session.view().items).toHaveLength(60);
  for (const command of ["view", "search"] as const) {
    const result = (await h.call({
      command,
      scope: "session",
      ...(command === "search" ? { query: "[a.*]" } : {}),
    })) as { items?: { id: string; rev: string }[]; hits?: { id: string; rev: string }[] };
    const entries = command === "view" ? result.items! : result.hits!;
    expect(entries).toHaveLength(50);
    expect(entries.map((i) => i.id)).toEqual(
      items
        .map((i) => i.id)
        .sort()
        .slice(0, 50),
    );
    for (const entry of entries)
      expect(entry.rev).toBe(h.session.view().items.find((i) => i.item.id === entry.id)?.rev);
  }
  expect(h.append).not.toHaveBeenCalled();
});
