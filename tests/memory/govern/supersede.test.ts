import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  supersede,
  restoreSupersededBlock,
  readGovernBlock,
  SUPERSEDE_AUTO_P,
  AUTO_PER_WRITE_MAX,
} from "../../../src/memory/govern/supersede.js";
import { createBlockLocked, replaceBlockLocked, trashBlockLocked } from "../../../src/memory/blocks/store.js";
import type { ParsedBlock } from "../../../src/memory/blocks/format.js";
import type { RelationVerdict } from "../../../src/memory/jev/contracts.js";
const roots: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "supersede-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  return dir;
}
const now = new Date("2026-11-06T00:00:00Z");
function block(dir: string, authority: "user" | "agent" = "agent", residue?: true) {
  return createBlockLocked(
    join(dir, "blocks"),
    "rule",
    { authority, ...(residue ? { residue } : {}) },
    `rule ${Math.random()}`,
    now,
  );
}
function verdict(a: ParsedBlock, b: ParsedBlock, p = 1): RelationVerdict {
  return { kind: "supersedes", newId: a.id, newRev: a.rev, oldId: b.id, oldRev: b.rev, p, auto: true };
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("single old-file CAS, no reciprocal field, version increment and user notification", async () => {
  const d = setup(),
    a = block(d, "user"),
    b = block(d, "user");
  const notices: string[] = [];
  expect((await supersede(d, [verdict(a, b)], { notify: (m) => notices.push(m) }))[0]?.outcome).toBe("superseded");
  expect(readGovernBlock(d, b.id).meta).toMatchObject({ supersededBy: a.id, status: "superseded", version: 2 });
  expect(readFileSync(join(d, "blocks", `${a.id}.md`), "utf8")).toBe(a.raw);
  expect(notices[0]).toContain(`undo: /mem restore --block ${b.id}`);
});
it.each(["new-update", "old-update", "new-delete"])("late judgment %s skips", async (mode) => {
  const d = setup(),
    a = block(d),
    b = block(d),
    v = verdict(a, b);
  if (mode === "new-delete") trashBlockLocked(join(d, "blocks"), `${a.id}.md`);
  else {
    const target = mode === "new-update" ? a : b;
    replaceBlockLocked(join(d, "blocks"), target.id, target.rev, { meta: target.meta, body: "changed" }, now);
  }
  expect((await supersede(d, [v]))[0]?.outcome).toBe("skipped");
  expect(readGovernBlock(d, b.id).meta.supersededBy).toBeUndefined();
});
it("self and reversed concurrent edge are rejected", async () => {
  const d = setup(),
    a = block(d),
    b = block(d);
  expect((await supersede(d, [verdict(a, a)]))[0]?.reason).toContain("self");
  await supersede(d, [verdict(a, b)]);
  expect((await supersede(d, [verdict(b, a)]))[0]?.outcome).toBe("skipped");
  expect(readGovernBlock(d, a.id).meta.status).toBe("active");
});
it("chain restore affects one edge only; pair stays permanently dismissed", async () => {
  const d = setup(),
    a = block(d),
    b = block(d),
    c = block(d);
  await supersede(d, [verdict(b, a)]);
  await supersede(d, [verdict(c, b)]);
  await restoreSupersededBlock(d, b.id);
  const restored = readGovernBlock(d, b.id);
  expect(readGovernBlock(d, a.id).meta.supersededBy).toBe(b.id);
  expect(restored.meta.status).toBe("active");
  expect((await supersede(d, [verdict(c, restored)]))[0]?.reason).toContain("dismissed");
});
it("restore dangling successor is possible", async () => {
  const d = setup(),
    a = block(d),
    b = block(d);
  await supersede(d, [verdict(a, b)]);
  trashBlockLocked(join(d, "blocks"), `${a.id}.md`);
  expect(await restoreSupersededBlock(d, b.id)).toBe(true);
  expect(readGovernBlock(d, b.id).meta.status).toBe("active");
});
it("partial one-to-many retry is idempotent and cap is shared", async () => {
  const d = setup(),
    a = block(d),
    old = Array.from({ length: 4 }, () => block(d));
  const result = await supersede(
    d,
    old.map((b) => verdict(a, b)),
  );
  expect(result.filter((r) => r.outcome === "superseded")).toHaveLength(AUTO_PER_WRITE_MAX);
  expect((await supersede(d, [verdict(a, old[0]!)]))[0]?.outcome).toBe("skipped");
});
it("threshold, agent/user protection, explicit residue exception and off semantics", async () => {
  const d = setup(),
    a = block(d),
    u = block(d, "user"),
    r = block(d, "agent", true);
  expect((await supersede(d, [verdict(a, r, SUPERSEDE_AUTO_P - 0.001)]))[0]?.reason).toContain("threshold");
  expect((await supersede(d, [verdict(a, u)], { explicit: true }))[0]?.reason).toContain("user rule");
  expect((await supersede(d, [verdict(a, r)]))[0]?.reason).toContain("residue");
  expect((await supersede(d, [verdict(a, r)], { enabled: false }))[0]?.reason).toContain("disabled");
  expect((await supersede(d, [verdict(a, r)], { explicit: true, enabled: false }))[0]?.outcome).toBe("superseded");
  expect(readGovernBlock(d, r.id).meta.residue).toBe(true);
});
it("threshold equality, denied gate and abort", async () => {
  const d = setup(),
    a = block(d),
    b = block(d);
  const denied = {
    capture() {},
    check() {
      return { ok: false as const, reason: "locked" };
    },
  };
  expect((await supersede(d, [verdict(a, b)], { gate: denied }))[0]?.reason).toContain("GATE");
  expect((await supersede(d, [verdict(a, b)], { signal: AbortSignal.abort() }))[0]?.reason).toContain("ABORTED");
  expect((await supersede(d, [verdict(a, b, SUPERSEDE_AUTO_P)]))[0]?.outcome).toBe("superseded");
});

it("v3 explicit supersedes runs without Jev, echoes skips and notification; restore permanently dismisses", async () => {
  const { createMemoryToolV3 } = await import("../../../src/memory/tool-v3.js");
  const { DEFAULT_SETTINGS } = await import("../../../src/config/settings.js");
  const { memoryDirFor } = await import("../../../src/memory/paths.js");
  const root = setup(),
    cwd = join(root, "project"),
    paths = { memoryRoot: join(root, "mem"), ccProjectsRoot: join(root, "cc") };
  mkdirSync(cwd);
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const old = block(dir, "user"),
    notices: string[] = [];
  const tool = createMemoryToolV3({
    settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks", jev: { ...DEFAULT_SETTINGS.memory.jev, enabled: false } },
    isChildSession: false,
    paths,
    onAfterWrite() {},
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: (m: string) => notices.push(m) },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  const ignored = await tool.execute(
    "t",
    { command: "create", topic: "rule", text: `<!-- mem supersedes=${old.id} -->\nagent rule` },
    undefined,
    undefined,
    ctx,
  );
  expect(ignored.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("supersedes ignored:") })]),
  );
  const result = await tool.execute(
    "t",
    { command: "create", topic: "rule", text: `<!-- mem user supersedes=${old.id} -->\nnew user rule` },
    undefined,
    undefined,
    ctx,
  );
  const echo = (result.content[0] as { text: string }).text;
  expect(echo).toContain(`superseded: ${old.id}`);
  expect(notices.some((n) => n.includes("user rule"))).toBe(true);
  expect(readGovernBlock(dir, old.id).meta.supersededBy).toBe("rule.003");
  await restoreSupersededBlock(dir, old.id);
  expect(readGovernBlock(dir, old.id).meta.status).toBe("active");
});

it.each(["user", "agent"] as const)("%s automatic and explicit matrix cells", async (authority) => {
  for (const oldAuthority of ["user", "agent"] as const)
    for (const explicit of [false, true]) {
      const d = setup(),
        a = block(d, authority),
        b = block(d, oldAuthority);
      const result = await supersede(d, [verdict(a, b)], { explicit });
      expect(result[0]?.outcome).toBe(authority === "agent" && oldAuthority === "user" ? "skipped" : "superseded");
    }
});
it("conflict never auto-executes, even at the historical cutoff or certainty; explicit remains unchanged", async () => {
  const { CONFLICT_AUTO_P } = await import("../../../src/memory/govern/supersede.js");
  const d = setup(),
    a = block(d, "user");
  const b = createBlockLocked(join(d, "blocks"), "rule", { authority: "user", scope: "global" }, "global old", now);
  const v = { ...verdict(a, b), kind: "conflict" as const, p: CONFLICT_AUTO_P - 0.001 };
  expect((await supersede(d, [v]))[0]?.outcome).toBe("skipped");
  for (const p of [CONFLICT_AUTO_P, 1]) {
    expect((await supersede(d, [{ ...v, p }]))[0]?.outcome).toBe("skipped");
    expect(readGovernBlock(d, b.id).meta.status).toBe("active");
  }
  const { readIndex } = await import("../../../src/memory/jev/index-store.js");
  expect(readIndex(d).index.review?.suggestions).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "conflict" })]),
  );
  const passed = await supersede(d, [{ ...v, p: 1 }], { explicit: true });
  expect(passed[0]?.echo).toContain("was global");
  expect(readGovernBlock(d, a.id).meta.scope).toBeUndefined();
});

it("restored pair is excluded before classifier questions are constructed", async () => {
  const { createJevWritePort } = await import("../../../src/memory/jev/write-port.js");
  const { EntryIndex } = await import("../../../src/memory/jev/entries.js");
  const { mergeTaxonomy } = await import("../../../src/memory/jev/taxonomy.js");
  const d = setup(),
    a = block(d, "user"),
    b = block(d, "user");
  await supersede(d, [verdict(a, b)]);
  await restoreSupersededBlock(d, b.id);
  const requests: import("../../../src/memory/jev/contracts.js").JevRequest[] = [];
  const client: import("../../../src/memory/jev/contracts.js").JevClient = {
    status: () => ({ kind: "full", model: "test/model" }),
    probe: async () => ({ kind: "full", model: "test/model" }),
    ask: async (req) => {
      requests.push(req);
      return { ok: true, model: "test/model", answers: {}, missing: [], costUsd: 0, latencyMs: 0 };
    },
  };
  const port = createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: () => d,
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    now: () => now.getTime(),
  });
  await port.afterWrite({
    cwd: "/fixture",
    file: `${a.id}.md`,
    before: undefined,
    after: a.raw,
    registry: {},
    block: { id: a.id, rev: a.rev, authority: "user", scopeExplicit: false },
  });
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]!.questions).filter((k) => /^c[0-9]+/.test(k))).toEqual([]);
});

it("direct explicit conflict preserves authority checks, including agent→user denial", async () => {
  const d = setup(),
    a = block(d),
    u = block(d, "user"),
    old = block(d);
  const denied = await supersede(d, [{ ...verdict(a, u), kind: "conflict" }], { explicit: true });
  expect(denied[0]?.reason).toContain("user rule");
  expect(readGovernBlock(d, u.id).meta.status).toBe("active");
  expect(
    (await supersede(d, [{ ...verdict(a, old), kind: "conflict", auto: false, p: 0 }], { explicit: true }))[0]?.outcome,
  ).toBe("superseded");
});
