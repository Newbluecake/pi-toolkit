import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ident, Loc, OpSpec, TidyManifest } from "../../src/memory/contracts.js";
import { bumpEpoch, observeLoc, openRunDirs } from "../../src/memory/safe-fs.js";
import { parseManifestStrict } from "../../src/memory/tidy/manifest.js";
import { recoverRun, runStep, type TxnOperation } from "../../src/memory/tidy/txn.js";
import { applyRestore } from "../../src/memory/tidy/restore.js";

const roots: string[] = [];
const live = (name: string): Loc => ({ area: "live", name });
const tmp = (within: "live" | "backup", name: string): Loc => ({ area: "tmp", within, name });
const ident = (sha: string, ino = 1): Ident => ({ dev: 1, ino, sha, size: 1 });
function fixture(id = "20260101T000000000Z-1-abcdef") {
  const root = mkdtempSync(join(tmpdir(), "tidy-p2b-"));
  roots.push(root);
  mkdirSync(join(root, "archive"));
  mkdirSync(join(root, ".trash"));
  return { root, dirs: openRunDirs(root, id, { createArchive: true, createBackup: true }), id };
}
function createOp(name: string, seq: number): { operation: TxnOperation; content: Map<string, string> } {
  const staging = tmp("live", `.pt-abcdef01-${seq}-c.tmp`);
  return {
    operation: {
      seq,
      phase: "normalize",
      op: { prim: "CREATE", target: live(name), afterSha: "a".repeat(64), tmpContent: staging },
    },
    content: new Map([[`tmp:live:${staging.name}`, "a"]]),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P2b transaction executor", () => {
  it("records the complete plan and resumes an op whose intent was never written", () => {
    const { root, dirs, id } = fixture();
    const first = createOp("one.md", 1);
    const second = createOp("two.md", 2);
    const ops = [first.operation, second.operation];
    const contents = new Map([...first.content, ...second.content]);
    expect(() =>
      runStep({
        dirs,
        id,
        ops,
        contents,
        hooks: {
          onEvent: (event) => {
            if (event.ev === "result") throw new Error("crash");
          },
        },
      }),
    ).toThrow("crash");
    const recovered = recoverRun(dirs, id);
    expect(recovered.state).toBe("interrupted");
    expect(recovered.pending).toHaveLength(1);
    const resumed = runStep({ dirs, id, ops, contents, probe: false });
    expect(["complete", "recovered"]).toContain(resumed.state);
    expect(readFileSync(join(root, "two.md"), "utf8")).toBe("a");
  });

  it("continues after the 20-op block boundary without reporting skips", () => {
    const { root, dirs, id } = fixture();
    const all = Array.from({ length: 21 }, (_, index) => createOp(`f${index}.md`, index + 1));
    const ops = all.map(({ operation }) => operation);
    const contents = new Map(all.flatMap(({ content }) => [...content]));
    let result = runStep({ dirs, id, ops, contents });
    expect(result.state).toBe("applying");
    expect(result.pending).toHaveLength(1);
    while (result.state === "applying") result = runStep({ dirs, id, ops, contents, probe: false });
    expect(["complete", "recovered"]).toContain(result.state);
    expect(result.results).toHaveLength(21);
    expect(readFileSync(join(root, "f20.md"), "utf8")).toBe("a");
  });

  it("handles a partial CREATE+MOVE rename group through recovery", () => {
    const { root, dirs, id } = fixture();
    writeFileSync(join(root, "old.md"), "old");
    const old = observeLoc(dirs, live("old.md"));
    if (old.kind !== "file") throw new Error("expected old file");
    const create = createOp("new.md", 1);
    const move: TxnOperation = {
      seq: 2,
      group: 1,
      phase: "normalize",
      op: {
        prim: "MOVE",
        src: live("old.md"),
        dst: { area: "backup", name: "s2-2-live--old.md" },
        obj: { dev: old.dev, ino: old.ino, sha: old.sha, size: old.size },
      },
    };
    const ops = [{ ...create.operation, group: 1 }, move];
    const contents = create.content;
    expect(() =>
      runStep({
        dirs,
        id,
        ops,
        contents,
        hooks: {
          onEvent: (event) => {
            if (event.ev === "result") throw new Error("crash");
          },
        },
      }),
    ).toThrow();
    expect(recoverRun(dirs, id).pending).toHaveLength(1);
    const result = runStep({ dirs, id, ops, contents, probe: false });
    expect(["complete", "recovered"]).toContain(result.state);
    expect(readFileSync(join(root, "new.md"), "utf8")).toBe("a");
    expect(readFileSync(join(root, ".backup", id, "s2-2-live--old.md"), "utf8")).toBe("old");
  });

  it("never overwrites a CAS-conflicting destination", () => {
    const { root, dirs, id } = fixture();
    writeFileSync(join(root, "src.md"), "x");
    writeFileSync(join(root, "archive", "src.md"), "foreign");
    const source = observeLoc(dirs, live("src.md"));
    if (source.kind !== "file") throw new Error("expected source");
    const result = runStep({
      dirs,
      id,
      ops: [
        {
          seq: 1,
          phase: "archive",
          op: { prim: "MOVE", src: live("src.md"), dst: { area: "archive", name: "src.md" }, obj: source },
        },
      ],
    });
    expect(result.state).toBe("conflict-reported");
    expect(readFileSync(join(root, "src.md"), "utf8")).toBe("x");
    expect(readFileSync(join(root, "archive", "src.md"), "utf8")).toBe("foreign");
  });

  it("re-decides state from the mandatory final observation", () => {
    const { root, dirs, id } = fixture();
    const op = createOp("tampered.md", 1);
    const result = runStep({
      dirs,
      id,
      ops: [op.operation],
      contents: op.content,
      hooks: { beforeResult: () => writeFileSync(join(root, "tampered.md"), "tampered") },
    });
    expect(result.results[0]?.state).toBe("conflict");
    expect(result.results[0]?.final.some(({ obs }) => obs.kind === "file" && obs.sha !== "a".repeat(64))).toBe(true);
  });

  it("rejects unknown, out-of-order, and incomplete strict v2 manifests", () => {
    const base = { v: 2, id: "20260101T000000000Z-1-abcdef", kind: "batch", createdAt: "now" };
    expect(() =>
      parseManifestStrict({ ...base, events: [{ ev: "run", state: "applying", epoch: 0, extra: true }] }, base.id),
    ).toThrow();
    expect(() =>
      parseManifestStrict({ ...base, events: [{ ev: "run", state: "complete", epoch: 0 }] }, base.id),
    ).toThrow();
    expect(() =>
      parseManifestStrict(
        {
          ...base,
          events: [
            { ev: "run", state: "applying", epoch: 0 },
            {
              ev: "intent",
              opId: "x",
              seq: 2,
              step: 1,
              phase: "archive",
              op: {
                prim: "MOVE",
                src: live("a.md"),
                dst: { area: "archive", name: "a.md" },
                obj: ident("a".repeat(64)),
              },
            },
          ],
        },
        base.id,
      ),
    ).toThrow();
  });

  it("refuses a legacy manifest without --legacy and restores it through the txn layer with --legacy", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "tidy-p2b-memory-"));
    roots.push(memoryRoot);
    const root = join(memoryRoot, "-legacy-fixture");
    mkdirSync(join(root, "archive"), { recursive: true });
    mkdirSync(join(root, ".trash"));
    const id = "20260101T000000000Z-1-abcdef";
    mkdirSync(join(root, ".backup", id), { recursive: true });
    writeFileSync(join(root, ".backup", id, "old.md"), "old");
    const manifest: TidyManifest = {
      v: 1,
      id,
      kind: "tidy",
      createdAt: "now",
      entries: [{ name: "old.md", op: "delete", beforeSha256: "a".repeat(64), backupFile: "old.md" }],
    };
    writeFileSync(join(root, ".backup", id, "manifest.json"), JSON.stringify(manifest));
    const paths = { memoryRoot, ccProjectsRoot: memoryRoot };
    await expect(applyRestore("/legacy-fixture", id, new Map([["old.md", "restore"]]), paths)).rejects.toThrow(
      "--legacy",
    );
    const result = await applyRestore("/legacy-fixture", id, new Map([["old.md", "restore"]]), paths, { legacy: true });
    expect(result.restored).toEqual(["old.md"]);
    expect(readFileSync(join(root, "old.md"), "utf8")).toBe("old");
  });

  it("rejects an old owner after epoch revocation before its next journal action", () => {
    const { dirs, id } = fixture();
    const op = createOp("revoked.md", 1);
    expect(() =>
      runStep({
        dirs,
        id,
        ops: [op.operation],
        contents: op.content,
        hooks: {
          beforeAction: () => {
            bumpEpoch(dirs, { pid: process.pid, host: "test" });
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "EPOCH_REVOKED" }));
    expect(observeLoc(dirs, live("revoked.md"))).toEqual({ kind: "absent" });
  });
});
