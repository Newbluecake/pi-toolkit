import { afterEach, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MemoryToolParamsV4, memoryV4Surface, measureMemorySurface } from "../../../src/memory/unified/surface.js";
import { harness } from "./helpers.js";
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));
function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  closes.push(h.close);
  return h;
}
type ReplacementResult = { deprecation: { replacement: { tool: string; params: object } }; item: unknown; rev: string };

it("old view produces executable replacement against the actual registered v4 and same item", async () => {
  const h = setup({ active: true, registered: true });
  for (let n = 1; n <= 7; n++)
    expect(await h.alias.run("seed", { op: "create", storageScope: "session", text: `fact ${n}` })).toMatchObject({
      ok: true,
    });
  const result = (await h.alias.run("read", { op: "view", storageScope: "session", id: "n7" })) as ReplacementResult;
  expect(result.rev).toMatch(/^[a-f0-9]{8}$/);
  expect(result.deprecation).toEqual({
    replacement: { tool: "memory", params: { command: "view", scope: "session", id: "n7" } },
  });
  expect(Value.Check(MemoryToolParamsV4, result.deprecation.replacement.params)).toBe(true);
  const actual = await h.registeredCall(result.deprecation.replacement.params);
  expect(actual).toEqual({ ok: true, id: "n7", rev: result.rev, item: result.item });
});
it("real old update and its replacement are equivalent from identical session item snapshots", async () => {
  const a = setup({ active: true, registered: true }),
    b = setup({ active: true, registered: true });
  for (const h of [a, b])
    for (let n = 1; n <= 7; n++)
      await h.alias.run("seed", { op: "create", storageScope: "session", text: `fact ${n}` });
  const view = (await a.alias.run("read", { op: "view", storageScope: "session", id: "n7" })) as ReplacementResult;
  expect(a.session.view().items).toEqual(b.session.view().items);
  const old = (await a.alias.run("update", {
    op: "update",
    storageScope: "session",
    id: "n7",
    rev: view.rev,
    text: "updated",
  })) as ReplacementResult;
  expect(old).toMatchObject({ ok: true, id: "n7" });
  expect(old.deprecation.replacement).toEqual({
    tool: "memory",
    params: { command: "update", scope: "session", id: "n7", rev: view.rev, text: "updated" },
  });
  const result = await b.registeredCall(old.deprecation.replacement.params);
  expect(result).toEqual(Object.fromEntries(Object.entries(old).filter(([key]) => key !== "deprecation")));
  expect(b.session.view().items).toEqual(a.session.view().items);
  expect(a.session.view().items.find((i) => i.item.id === "n7")?.item.text).toBe("updated");
});
it.each([
  [false, false],
  [false, true],
  [true, false],
] as const)("alias stays byte-identical when active=%s registered=%s", async (active, registered) => {
  const h = setup({ active, registered });
  await h.originalAlias.run("seed", { op: "create", storageScope: "session", text: "same" });
  for (const input of [
    { op: "view", storageScope: "session" },
    { op: "view" },
    { op: "view", storageScope: "session", unknown: true },
    { op: "update", storageScope: "session", id: "n1", text: "same" },
  ]) {
    expect(JSON.stringify(await h.alias.run("test", input))).toBe(
      JSON.stringify(await h.originalAlias.run("test", input)),
    );
  }
  expect(h.alias.description).toBe(h.originalAlias.description);
  expect(JSON.stringify(h.alias.parameters)).toBe(JSON.stringify(h.originalAlias.parameters));
});
it("replacement is absent for requests failing the old closed schema", async () => {
  const h = setup({ active: true, registered: true });
  for (const input of [
    { op: "view" },
    { command: "view", scope: "session" },
    { op: "view", storageScope: "session", query: "x" },
  ])
    expect(await h.alias.run("test", input)).not.toHaveProperty("deprecation");
});
it("measures all variants and the unchanged alias with the exact UTF-8 formula", () => {
  const h = setup();
  const variants = {
    base: memoryV4Surface(),
    jev: memoryV4Surface({ jev: true }),
    child: memoryV4Surface({ child: true }),
    alias: h.originalAlias,
  };
  const limits = { base: 4096, jev: 4608, child: 4096, alias: 2560 };
  for (const [name, surface] of Object.entries(variants)) {
    const optional = surface as typeof surface & { promptSnippet?: string; promptGuidelines?: readonly string[] };
    const bytes = Buffer.byteLength(
      surface.description +
        (optional.promptSnippet ?? "") +
        (optional.promptGuidelines ?? []).join("\n") +
        JSON.stringify(surface.parameters),
      "utf8",
    );
    expect(measureMemorySurface(surface)).toBe(bytes);
    expect(bytes).toBeLessThanOrEqual(limits[name as keyof typeof limits]);
  }
  for (const name of ["base", "jev", "child"] as const)
    expect(measureMemorySurface(variants[name]) + measureMemorySurface(variants.alias)).toBeLessThanOrEqual(
      limits[name] + limits.alias,
    );
  expect(
    measureMemorySurface({ description: "中文", promptSnippet: "é", promptGuidelines: ["a", "b"], parameters: {} }),
  ).toBe(13);
});

it("successful legacy view drops ignored fields from its equivalent replacement", async () => {
  const h = setup({ active: true, registered: true });
  await h.alias.run("seed", { op: "create", storageScope: "session", text: "original" });
  const result = (await h.alias.run("view", {
    op: "view",
    storageScope: "session",
    id: "n1",
    topic: "ignored-topic",
    text: "ignored body",
    rev: "ignored",
    from: "session:n9",
    authority: "user",
  })) as ReplacementResult;
  expect(result).toMatchObject({ ok: true });
  expect(result.deprecation.replacement.params).toEqual({ command: "view", scope: "session", id: "n1" });
  expect(await h.registeredCall(result.deprecation.replacement.params)).toMatchObject({
    ok: true,
    item: result.item,
    rev: result.rev,
  });
  expect(h.select).not.toHaveBeenCalled();
});
