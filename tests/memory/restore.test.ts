// §7.5 `/mem restore` (manifest/trash recovery, hash-conflict detection) —
// todo #22 P4, §10 K6/K7/K9's restore-side assertions.

import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeEmptyFixture, writeMemAt, type MaterializedFixture } from "./helpers/fixture-dir.js";
import { applyTidy } from "../../src/memory/tidy/apply.js";
import { snapshotMemoryDir } from "../../src/memory/tidy/snapshot.js";
import { listBackups, listTrashEntries, newTidyId, pruneBackups } from "../../src/memory/tidy/manifest.js";
import * as manifestModule from "../../src/memory/tidy/manifest.js";
import { applyRestore, planRestore, restoreFromTrash } from "../../src/memory/tidy/restore.js";
import { readRegular } from "../../src/memory/safe-fs.js";

let fx: MaterializedFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function setup(): MaterializedFixture {
  fx = materializeEmptyFixture();
  return fx;
}

describe("planRestore / applyRestore round-trip (K6)", () => {
  it("rewrite: restoring after a tidy apply brings back the exact original bytes", async () => {
    const f = setup();
    writeMemAt(f.memDir, "quota.md", "# quota\n\noriginal text\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
    const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
    const decisions = new Map([["quota.md", "apply" as const]]);
    const applied = await applyTidy({
      cwd: f.cwd,
      paths: f.paths,
      proposal: {
        files: [{ name: "quota.md", action: "rewrite", content: "# quota\n\nnew text\n", reason: "test" }],
        dropped: [],
      },
      decisions,
      originalSha,
      kind: "tidy",
    });
    expect(applied.applied).toHaveLength(1);
    expect(applied.manifest.entries).toHaveLength(1);
    const id = applied.manifest.id;

    // sanity: the live file now has the NEW content
    expect(readFileSync(join(f.memDir, "quota.md"), "utf8")).toContain("new text");

    const plan = planRestore(f.cwd, id, f.paths);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ name: "quota.md", op: "rewrite", conflict: false });

    const result = await applyRestore(f.cwd, id, new Map([["quota.md", "restore"]]), f.paths);
    expect(result.restored).toEqual(["quota.md"]);
    expect(result.failed).toHaveLength(0);

    const restoredText = readFileSync(join(f.memDir, "quota.md"), "utf8");
    expect(restoredText).toBe("# quota\n\noriginal text\n");
  });

  it("delete: restoring recreates the file with its original bytes", async () => {
    const f = setup();
    writeMemAt(f.memDir, "gone.md", "# gone\n\nkeep me\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
    const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
    const applied = await applyTidy({
      cwd: f.cwd,
      paths: f.paths,
      proposal: { files: [{ name: "gone.md", action: "delete", reason: "test" }], dropped: [] },
      decisions: new Map([["gone.md", "apply"]]),
      originalSha,
      kind: "tidy",
    });
    expect(readdirSync(f.memDir)).not.toContain("gone.md");

    const result = await applyRestore(f.cwd, applied.manifest.id, new Map([["gone.md", "restore"]]), f.paths);
    expect(result.restored).toEqual(["gone.md"]);
    expect(readFileSync(join(f.memDir, "gone.md"), "utf8")).toBe("# gone\n\nkeep me\n");
  });

  it("create: restoring removes the file tidy created", async () => {
    const f = setup();
    const applied = await applyTidy({
      cwd: f.cwd,
      paths: f.paths,
      proposal: {
        files: [{ name: "brandnew.md", action: "create", content: "# new\n\nhi\n", reason: "test" }],
        dropped: [],
      },
      decisions: new Map([["brandnew.md", "apply"]]),
      originalSha: new Map(),
      kind: "tidy",
    });
    expect(readdirSync(f.memDir)).toContain("brandnew.md");

    const plan = planRestore(f.cwd, applied.manifest.id, f.paths);
    expect(plan.entries[0]).toMatchObject({ name: "brandnew.md", op: "create", conflict: false });

    const result = await applyRestore(f.cwd, applied.manifest.id, new Map([["brandnew.md", "restore"]]), f.paths);
    expect(result.restored).toEqual(["brandnew.md"]);
    expect(readdirSync(f.memDir)).not.toContain("brandnew.md");
  });

  it("rename (content unchanged): restore reverses name, byte-exact", async () => {
    const f = setup();
    writeMemAt(f.memDir, "old.md", "# old\n\nsame body\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
    const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
    const applied = await applyTidy({
      cwd: f.cwd,
      paths: f.paths,
      proposal: { files: [{ name: "old.md", action: "rename", newName: "renamed.md", reason: "test" }], dropped: [] },
      decisions: new Map([["old.md", "apply"]]),
      originalSha,
      kind: "tidy",
    });
    expect(readdirSync(f.memDir)).toContain("renamed.md");
    expect(readdirSync(f.memDir)).not.toContain("old.md");

    const result = await applyRestore(f.cwd, applied.manifest.id, new Map([["old.md", "restore"]]), f.paths);
    expect(result.restored).toEqual(["old.md"]);
    expect(readdirSync(f.memDir)).toContain("old.md");
    expect(readdirSync(f.memDir)).not.toContain("renamed.md");
    expect(readFileSync(join(f.memDir, "old.md"), "utf8")).toBe("# old\n\nsame body\n");
  });

  it("conflict: current content diverged from afterSha256 ⇒ flagged, default is not auto-restored", async () => {
    const f = setup();
    writeMemAt(f.memDir, "quota.md", "# quota\n\nv1\n", "2026-09-01T00:00:00.000Z");
    const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
    const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
    const applied = await applyTidy({
      cwd: f.cwd,
      paths: f.paths,
      proposal: {
        files: [{ name: "quota.md", action: "rewrite", content: "# quota\n\nv2\n", reason: "test" }],
        dropped: [],
      },
      decisions: new Map([["quota.md", "apply"]]),
      originalSha,
      kind: "tidy",
    });
    // Someone edits the file again AFTER tidy applied.
    writeFileSync(join(f.memDir, "quota.md"), "# quota\n\nv3 edited by someone else\n");

    const plan = planRestore(f.cwd, applied.manifest.id, f.paths);
    expect(plan.entries[0]).toMatchObject({ name: "quota.md", conflict: true });

    // Skip the conflict: nothing changes.
    const skipped = await applyRestore(f.cwd, applied.manifest.id, new Map([["quota.md", "skip"]]), f.paths);
    expect(skipped.restored).toHaveLength(0);
    expect(skipped.skipped).toEqual([{ name: "quota.md", reason: "skipped by user" }]);
    expect(readFileSync(join(f.memDir, "quota.md"), "utf8")).toContain("v3 edited by someone else");

    // Overwrite the conflict: current (v3) content is captured in a NEW
    // pre-restore backup before the original (v1) content is restored.
    const overwritten = await applyRestore(f.cwd, applied.manifest.id, new Map([["quota.md", "overwrite"]]), f.paths);
    expect(overwritten.restored).toEqual(["quota.md"]);
    expect(overwritten.preRestoreBackupId).toBeDefined();
    expect(readFileSync(join(f.memDir, "quota.md"), "utf8")).toBe("# quota\n\nv1\n");
    const preRestoreManifest = listBackups(f.memDir).find((b) => b.id === overwritten.preRestoreBackupId);
    expect(preRestoreManifest?.kind).toBe("restore");
  });

  it("--trash: restores a soft-deleted file, or backs up an existing target on Overwrite", async () => {
    const f = setup();
    mkdirSync(join(f.memDir, ".trash"), { recursive: true, mode: 0o700 });
    const id = newTidyId(new Date("2026-09-01T00:00:00.000Z"), 12345, "abcdef");
    writeFileSync(join(f.memDir, ".trash", `${id}-old.md`), "# old\n\ntrashed content\n");

    const entries = listTrashEntries(f.memDir);
    expect(entries).toEqual([{ id, name: "old.md", fileName: `${id}-old.md` }]);

    const restored = await restoreFromTrash(f.cwd, id, "skip", f.paths);
    expect(restored).toEqual({ restored: true });
    expect(readFileSync(join(f.memDir, "old.md"), "utf8")).toBe("# old\n\ntrashed content\n");
    expect(readdirSync(join(f.memDir, ".trash"))).toHaveLength(0);
  });

  it("--trash: target already exists ⇒ Skip leaves both untouched, Overwrite backs the current one up first", async () => {
    const f = setup();
    mkdirSync(join(f.memDir, ".trash"), { recursive: true, mode: 0o700 });
    const id = newTidyId(new Date("2026-09-01T00:00:00.000Z"), 12345, "abcdef");
    writeFileSync(join(f.memDir, ".trash", `${id}-dup.md`), "# dup\n\nfrom trash\n");
    writeMemAt(f.memDir, "dup.md", "# dup\n\nlive version\n", "2026-09-02T00:00:00.000Z");

    const skipped = await restoreFromTrash(f.cwd, id, "skip", f.paths);
    expect(skipped.restored).toBe(false);
    expect(readFileSync(join(f.memDir, "dup.md"), "utf8")).toContain("live version");
    expect(readdirSync(join(f.memDir, ".trash"))).toHaveLength(1); // trash entry untouched

    const overwritten = await restoreFromTrash(f.cwd, id, "overwrite", f.paths);
    expect(overwritten.restored).toBe(true);
    expect(overwritten.backupId).toBeDefined();
    expect(readFileSync(join(f.memDir, "dup.md"), "utf8")).toBe("# dup\n\nfrom trash\n");
    const backedUp = readRegular(join(f.memDir, ".backup", overwritten.backupId!), "dup.md");
    expect(backedUp.text).toContain("live version");
  });
});

describe("backup retention (K6 '保留 10 份')", () => {
  it("listBackups offers only the most recent `keep` entries, newest first", async () => {
    const f = setup();
    writeMemAt(f.memDir, "a.md", "# a\n\nbody\n", "2026-09-01T00:00:00.000Z");
    let lastId = "";
    for (let i = 0; i < 12; i++) {
      const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
      const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
      const applied = await applyTidy({
        cwd: f.cwd,
        paths: f.paths,
        proposal: {
          files: [{ name: "a.md", action: "rewrite", content: `# a\n\nbody v${String(i)}\n`, reason: "test" }],
          dropped: [],
        },
        decisions: new Map([["a.md", "apply"]]),
        originalSha,
        kind: "tidy",
        nowIso: new Date(2026, 8, 1, 0, 0, i).toISOString(),
        pid: 1000 + i,
        rand6: String(i).padStart(6, "0"),
      });
      lastId = applied.manifest.id;
    }
    const backups = listBackups(f.memDir, 10);
    expect(backups).toHaveLength(10);
    expect(backups[0]?.id).toBe(lastId); // newest first
  });

  it("11 applies ⇒ exactly 10 backup directories physically remain on disk, oldest removed", async () => {
    const f = setup();
    writeMemAt(f.memDir, "a.md", "# a\n\nbody\n", "2026-09-01T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
      const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
      const applied = await applyTidy({
        cwd: f.cwd,
        paths: f.paths,
        proposal: {
          files: [{ name: "a.md", action: "rewrite", content: `# a\n\nbody v${String(i)}\n`, reason: "test" }],
          dropped: [],
        },
        decisions: new Map([["a.md", "apply"]]),
        originalSha,
        kind: "tidy",
        nowIso: new Date(2026, 8, 1, 0, 0, i).toISOString(),
        pid: 2000 + i,
        rand6: String(i).padStart(6, "0"),
      });
      ids.push(applied.manifest.id);
    }
    expect(ids).toHaveLength(11);
    const onDisk = readdirSync(join(f.memDir, ".backup")).sort();
    expect(onDisk).toHaveLength(10);
    expect(onDisk).toEqual([...ids.slice(1)].sort()); // oldest (ids[0]) removed, the rest survive
    expect(onDisk).not.toContain(ids[0]);
  });

  it("/mem restore's listing matches disk exactly after pruning", async () => {
    const f = setup();
    writeMemAt(f.memDir, "a.md", "# a\n\nbody\n", "2026-09-01T00:00:00.000Z");
    for (let i = 0; i < 13; i++) {
      const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
      const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
      await applyTidy({
        cwd: f.cwd,
        paths: f.paths,
        proposal: {
          files: [{ name: "a.md", action: "rewrite", content: `# a\n\nbody v${String(i)}\n`, reason: "test" }],
          dropped: [],
        },
        decisions: new Map([["a.md", "apply"]]),
        originalSha,
        kind: "tidy",
        nowIso: new Date(2026, 8, 1, 0, 0, i).toISOString(),
        pid: 3000 + i,
        rand6: String(i).padStart(6, "0"),
      });
    }
    const onDisk = new Set(readdirSync(join(f.memDir, ".backup")));
    expect(onDisk.size).toBe(10);
    const listed = new Set(listBackups(f.memDir).map((b) => b.id));
    expect(listed).toEqual(onDisk);
  });

  it("a backup dir polluted with a symlink or a subdirectory is skipped (not deleted); the rest still get pruned", async () => {
    const f = setup();
    writeMemAt(f.memDir, "a.md", "# a\n\nbody\n", "2026-09-01T00:00:00.000Z");
    const ids: string[] = [];
    // Oldest id so it's first in line to be pruned, but pollute it with a
    // symlink before the loop even starts — it must survive every prune pass.
    const pollutedId = newTidyId(new Date(2025, 0, 1, 0, 0, 0), 4000, "abcdef");
    const pollutedDir = join(f.memDir, ".backup", pollutedId);
    mkdirSync(pollutedDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pollutedDir, "manifest.json"),
      JSON.stringify({ v: 1, id: pollutedId, kind: "tidy", createdAt: "2025-01-01T00:00:00.000Z", entries: [] }),
    );
    symlinkSync(join(f.memDir, "a.md"), join(pollutedDir, "sneaky.md"));
    ids.push(pollutedId);
    for (let i = 0; i < 12; i++) {
      const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
      const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
      const applied = await applyTidy({
        cwd: f.cwd,
        paths: f.paths,
        proposal: {
          files: [{ name: "a.md", action: "rewrite", content: `# a\n\nbody v${String(i)}\n`, reason: "test" }],
          dropped: [],
        },
        decisions: new Map([["a.md", "apply"]]),
        originalSha,
        kind: "tidy",
        nowIso: new Date(2026, 8, 1, 0, 0, i).toISOString(),
        pid: 4001 + i,
        rand6: String(i).padStart(6, "0"),
      });
      ids.push(applied.manifest.id);
    }
    // pollutedId is the oldest of all 13 ids — with clean pruning it would
    // have been the very first one removed, but removeFlatDir must refuse it.
    const onDisk = readdirSync(join(f.memDir, ".backup")).sort();
    expect(onDisk).toContain(pollutedId); // never deleted
    expect(readdirSync(pollutedDir).sort()).toEqual(["manifest.json", "sneaky.md"]); // untouched inside
    // Everything else prunes down to keep=10 amongst the 12 clean ids, so
    // disk holds pollutedId + 10 clean survivors = 11 total.
    expect(onDisk).toHaveLength(11);
    const cleanIds = ids.slice(1); // the 12 clean applies, oldest-first
    expect(onDisk.filter((id) => id !== pollutedId).sort()).toEqual([...cleanIds.slice(2)].sort());
  });

  it("pruneBackups never throws on an unreadable/missing .backup directory", () => {
    const f = setup();
    // No .backup directory exists at all yet.
    const result = pruneBackups(f.memDir);
    expect(result).toEqual({ removedIds: [], skipped: [] });
  });

  it("a pruning failure never affects the apply result that triggered it", async () => {
    const f = setup();
    writeMemAt(f.memDir, "a.md", "# a\n\nbody\n", "2026-09-01T00:00:00.000Z");
    const spy = vi.spyOn(manifestModule, "pruneBackups").mockImplementation(() => {
      throw new Error("boom: simulated prune failure");
    });
    try {
      const snap = snapshotMemoryDir(f.cwd, { paths: f.paths });
      const originalSha = new Map(snap.files.map((x) => [x.name, x.sha256]));
      const result = await applyTidy({
        cwd: f.cwd,
        paths: f.paths,
        proposal: {
          files: [{ name: "a.md", action: "rewrite", content: "# a\n\nafter\n", reason: "test" }],
          dropped: [],
        },
        decisions: new Map([["a.md", "apply"]]),
        originalSha,
        kind: "tidy",
      });
      expect(result.applied).toEqual([{ name: "a.md", op: "rewrite" }]);
      expect(result.skipped).toHaveLength(0);
      expect(result.manifest.entries).toHaveLength(1);
      expect(readFileSync(join(f.memDir, "a.md"), "utf8")).toContain("after");
    } finally {
      spy.mockRestore();
    }
  });
});
