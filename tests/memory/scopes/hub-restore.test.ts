import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHubMemoryProvider,
  defaultStoreIo,
  type HubFaultPoints,
  type HubStoreIo,
} from "../../../src/memory/scopes/hub-store.js";
import { HUB_ARCHIVE_FILE, HUB_ARCHIVE_MAX_ENTRIES } from "../../../src/memory/scopes/hub-management.js";
import { createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import type { HubMemorySource, MemoryOwner } from "../../../src/memory/scopes/types.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(io: HubStoreIo = defaultStoreIo, faults?: HubFaultPoints) {
  const dir = mkdtempSync(join(tmpdir(), "p3c-restore-"));
  dirs.push(dir);
  const slot = { effectiveStateDir: dir, uid: process.getuid?.() ?? 0 },
    root = join(dir, "hub-memory"),
    blocks = join(root, "blocks"),
    trash = join(blocks, ".trash");
  const owner: MemoryOwner = { incarnation: {}, sid: "session1", sessionEpoch: 1, branchGen: 0 };
  let src: HubMemorySource = { project: "abc123", label: "old source", sid8: "old" };
  const provider = createHubMemoryProvider({
    slot: () => slot,
    owner: () => owner,
    capability: () => "ok",
    registry: createMemoryOpCapRegistry(),
    trustedCommand: () => true,
    commandSource: () => src,
    io,
    ...(faults ? { faults } : {}),
  });
  const command = provider.management.command;
  return {
    dir,
    root,
    blocks,
    trash,
    provider,
    command,
    source: (s: HubMemorySource) => {
      src = s;
    },
  };
}
const add = (text = "original", topic = "general") => ({
  storageScope: "hub" as const,
  authority: "user" as const,
  op: "create" as const,
  text,
  topic,
});
async function deleted(f = setup()) {
  const c = await f.command(add());
  if (!c.ok || !c.rev) throw Error("create");
  const d = await f.command({ storageScope: "hub", authority: "user", op: "delete", targetId: c.id, expectRev: c.rev });
  expect(d.ok).toBe(true);
  const names = readdirSync(f.trash);
  expect(names).toHaveLength(1);
  return { ...f, id: c.id, rev: c.rev, name: names[0]! };
}
const nextSource = { project: "def456", label: "new source", sid8: "new" };
describe("restore retains old audit provenance, grants NEW command authority", () => {
  it("actual blocks/.trash; exact body/rev/updated restored, source never replayed; repeated token/source rejected", async () => {
    const f = await deleted();
    const oldArchive = JSON.parse(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8")).entries[f.name];
    const raw = readFileSync(join(f.trash, f.name), "utf8");
    f.source(nextSource);
    const p = f.provider.management.prepareRestore(f.name);
    expect(p.ok).toBe(true);
    if (!p.ok) throw Error("prepare");
    expect(p.confirmation).toMatchObject({
      text: "original",
      oldSource: { label: "old source" },
      warning: expect.stringContaining("新"),
    });
    expect(f.provider.view().items).toHaveLength(0);
    expect(await f.provider.management.commit(p.token)).toMatchObject({ ok: true, id: f.id, rev: f.rev });
    const inspect = f.provider.management.inspect(f.id);
    if (!inspect.ok) throw Error("inspect");
    expect(inspect.rev).toBe(f.rev);
    expect(inspect.item.src).toEqual(nextSource);
    expect(inspect.item.grant).toMatchObject({
      via: "command",
      by: "user",
      cap: expect.stringMatching(/^[a-f0-9]{8}$/),
    });
    expect(readFileSync(join(f.blocks, `${f.id}.md`), "utf8")).toBe(raw);
    expect(readdirSync(f.trash)).toEqual([]);
    const archive = JSON.parse(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8")).entries[f.name];
    expect(archive).toEqual({ ...oldArchive, state: "restored" });
    expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
    expect(f.provider.management.prepareRestore(f.name)).toMatchObject({ ok: false, code: "E_CONFLICT" });
    expect(readFileSync(join(f.root, "audit.jsonl"), "utf8")).toContain('"op":"restore"');
  });
  it("same logical id deleted twice has distinct filename-bound histories", async () => {
    const f = await deleted();
    f.source(nextSource);
    const p = f.provider.management.prepareRestore(f.name);
    if (!p.ok) throw Error("prepare");
    expect((await f.provider.management.commit(p.token)).ok).toBe(true);
    expect(
      (await f.command({ storageScope: "hub", authority: "user", op: "delete", targetId: f.id, expectRev: f.rev })).ok,
    ).toBe(true);
    const second = readdirSync(f.trash)[0]!;
    expect(second).not.toBe(f.name);
    const a = JSON.parse(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8")).entries;
    expect(a[f.name].provenance.src.label).toBe("old source");
    expect(a[second].provenance.src).toEqual(nextSource);
    expect(a[f.name].state).toBe("restored");
    expect(a[second].state).toBe("trashed");
    const two = f.provider.management.prepareRestore(second);
    if (!two.ok) throw Error("second prepare");
    expect(two.confirmation.oldSource).toEqual(nextSource);
  });
  it("unknown legacy source is explicit UNKNOWN and ordinary restore fails closed", async () => {
    const f = await deleted();
    rmSync(join(f.root, HUB_ARCHIVE_FILE));
    expect(f.provider.management.listTrash()).toEqual([{ fileName: f.name, id: f.id, provenance: "unknown" }]);
    expect(f.provider.management.prepareRestore(f.name)).toMatchObject({
      ok: false,
      code: "E_AUTHORITY",
      reason: expect.stringContaining("unknown"),
    });
    expect(readdirSync(f.trash)).toEqual([f.name]);
    expect(f.provider.view().state).toBe("ok");
  });
  it.each([
    "namespace",
    "body",
    "archive",
    "source",
    "trash-mode",
    "trash-inode",
    "trash-symlink",
    "target",
    "cancel",
    "abort",
  ])("confirmation CAS rejects %s change without restore writes", async (kind) => {
    const f = await deleted(),
      ac = new AbortController();
    const p = f.provider.management.prepareRestore(f.name, ac.signal);
    if (!p.ok) throw Error("prepare");
    if (kind === "namespace")
      writeFileSync(join(f.root, "namespace.json"), readFileSync(join(f.root, "namespace.json"), "utf8") + " ");
    if (kind === "body")
      writeFileSync(join(f.trash, f.name), readFileSync(join(f.trash, f.name), "utf8").replace("original", "changed!"));
    if (kind === "archive")
      writeFileSync(join(f.root, HUB_ARCHIVE_FILE), readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8") + " ");
    if (kind === "source")
      writeFileSync(join(f.root, "items.json"), readFileSync(join(f.root, "items.json"), "utf8") + " ");
    if (kind === "trash-mode") chmodSync(f.trash, 0o755);
    if (kind === "trash-inode") {
      renameSync(f.trash, `${f.trash}-old`);
      mkdirSync(f.trash, { mode: 0o700 });
    }
    if (kind === "trash-symlink") {
      renameSync(f.trash, `${f.trash}-old`);
      symlinkSync(`${f.trash}-old`, f.trash);
    }
    if (kind === "target") writeFileSync(join(f.blocks, `${f.id}.md`), "DO NOT CLOBBER", { mode: 0o600 });
    if (kind === "cancel") f.provider.management.cancel(p.token);
    if (kind === "abort") ac.abort();
    const archiveBefore = readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8");
    expect((await f.provider.management.commit(p.token)).ok).toBe(false);
    expect(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8")).toBe(archiveBefore);
    if (kind === "target") expect(readFileSync(join(f.blocks, `${f.id}.md`), "utf8")).toBe("DO NOT CLOBBER");
    expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
  });
  it("32 items and 4096B limits applied to restored body, no truncation", async () => {
    const f = await deleted();
    for (let n = 0; n < 32; n++) expect((await f.command(add("x", "more"))).ok).toBe(true);
    expect(f.provider.management.prepareRestore(f.name)).toMatchObject({ ok: false, code: "E_FULL" });
    expect(readdirSync(f.trash)).toEqual([f.name]);
    const g = await deleted();
    for (let n = 0; n < 4; n++) expect((await g.command(add("x".repeat(1024), "more"))).ok).toBe(true);
    expect(g.provider.management.prepareRestore(g.name)).toMatchObject({ ok: false, code: "E_FULL" });
  });
  it("archive saturation refuses future delete without evicting live/unfinished history", async () => {
    const f = await deleted();
    const a = JSON.parse(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8"));
    const old = a.entries[f.name];
    for (let i = 1; i < HUB_ARCHIVE_MAX_ENTRIES; i++) {
      const name = `20261107T090000000Z-${i}-abcdef-${f.id}.md`;
      a.entries[name] = { ...old, state: "restored" };
    }
    writeFileSync(join(f.root, HUB_ARCHIVE_FILE), JSON.stringify(a));
    expect(f.provider.view().state).toBe("ok");
    const c = await f.command(add("still live", "live"));
    if (!c.ok || !c.rev) throw Error("create");
    const before = readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8");
    expect(
      await f.command({ storageScope: "hub", authority: "user", op: "delete", targetId: c.id, expectRev: c.rev }),
    ).toEqual({ ok: false, code: "E_FULL" });
    expect(readFileSync(join(f.root, HUB_ARCHIVE_FILE), "utf8")).toBe(before);
    expect(f.provider.view().items.map((i) => i.text)).toEqual(["still live"]);
  });
});
describe("multi-file failures: no repair/retry and honest UNKNOWN", () => {
  it.each(["before-archive", "archive-write-then-throw"])(
    "delete archive stage %s precedes destructive movement",
    async (stage) => {
      let armed = false;
      const io: HubStoreIo = {
        ...defaultStoreIo,
        writePrivateFile(d, n, t) {
          if (armed && n === HUB_ARCHIVE_FILE) {
            if (stage === "archive-write-then-throw") defaultStoreIo.writePrivateFile(d, n, t);
            throw Error("archive failure");
          }
          defaultStoreIo.writePrivateFile(d, n, t);
        },
      };
      const f = setup(io);
      const c = await f.command(add());
      if (!c.ok || !c.rev) throw Error("create");
      armed = true;
      expect(
        await f.command({ storageScope: "hub", authority: "user", op: "delete", targetId: c.id, expectRev: c.rev }),
      ).toEqual({ ok: false, code: "E_PERSIST_UNKNOWN" });
      expect(readFileSync(join(f.blocks, `${c.id}.md`), "utf8")).toContain("original");
      expect(readdirSync(f.trash)).toEqual([]);
      expect(f.provider.view().state).toBe(stage === "before-archive" ? "ok" : "inert");
    },
  );
  it.each(["after-move", "before-items", "after-items", "before-audit", "before-archive", "archive-write-then-throw"])(
    "restore fault %s is UNKNOWN; no stale source accepted",
    async (stage) => {
      let armed = false;
      const io: HubStoreIo = {
        ...defaultStoreIo,
        writePrivateFile(d, n, t) {
          if (armed && n === HUB_ARCHIVE_FILE && (stage === "before-archive" || stage === "archive-write-then-throw")) {
            if (stage === "archive-write-then-throw") defaultStoreIo.writePrivateFile(d, n, t);
            throw Error("archive");
          }
          defaultStoreIo.writePrivateFile(d, n, t);
        },
      };
      const faults: HubFaultPoints = {
        afterBlockWrite() {
          if (armed && stage === "after-move") throw Error("after move");
        },
        beforeProvenanceWrite() {
          if (armed && stage === "before-items") throw Error("items");
        },
        afterProvenanceWrite() {
          if (armed && stage === "after-items") throw Error("items");
        },
        beforeAuditWrite() {
          if (armed && stage === "before-audit") throw Error("audit");
        },
      };
      const f = await deleted(setup(io, faults));
      f.source(nextSource);
      const p = f.provider.management.prepareRestore(f.name);
      if (!p.ok) throw Error("prepare");
      armed = true;
      expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_PERSIST_UNKNOWN" });
      const view = f.provider.view();
      if (stage === "archive-write-then-throw") {
        expect(view.state).toBe("ok");
        expect(view.items[0]?.src).toEqual(nextSource);
      } else expect(view).toMatchObject({ state: "inert", items: [] });
      expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
    },
  );
});
