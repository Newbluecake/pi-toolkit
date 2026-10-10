import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpEpoch,
  createLocExclusive,
  moveLocNoClobber,
  observeLoc,
  openRunDirs,
  probeHardlinks,
  readEpoch,
  replaceLocAtomic,
  resolveLoc,
  createFsyncWarningState,
  fsyncDirBestEffort,
  unlinkObservedLoc,
  writeTmpLoc,
} from "../../src/memory/safe-fs.js";
import { tmpNameFor } from "../../src/memory/tmp-names.js";
import {
  leaseCreate,
  leaseOwnerAlive,
  leaseRead,
  leaseRefresh,
  leaseRelease,
  makeLeasePayload,
} from "../../src/memory/tidy/lease.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mem-tidy-prims-"));
  fixtureRoots.push(root);
  mkdirSync(join(root, ".trash"));
  const dirs = openRunDirs(root, "20260101T000000000Z-1-abcdef", { createArchive: true, createBackup: true });
  return { root, dirs };
}

describe("tidy storage primitives", () => {
  it("tolerates a missing read-only trash directory", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-tidy-no-trash-"));
    fixtureRoots.push(root);
    const dirs = openRunDirs(root, "20260101T000000000Z-1-abcdef", { createArchive: true, createBackup: true });
    expect(dirs.trash.dev).toBe(-1);
    const loc = { area: "trash" as const, name: "20260101T000000000Z-1-abcdef-topic.md" };
    expect(resolveLoc(dirs, loc).dir.dev).toBe(-1);
    expect(observeLoc(dirs, loc)).toEqual({ kind: "absent" });
  });

  it("writes, creates, replaces, moves, and unlinks with identities", () => {
    const { root, dirs } = fixture();
    const target = { area: "live" as const, name: "topic.md" };
    const first = Buffer.from("first");
    const tmp = { area: "tmp" as const, within: "live" as const, name: tmpNameFor("abcdef01", 1, "c") };
    const ident = createLocExclusive(dirs, target, tmp, first);
    expect(observeLoc(dirs, target)).toEqual({ kind: "file", ...ident });

    const replacement = Buffer.from("second");
    const tmp2 = { area: "tmp" as const, within: "live" as const, name: tmpNameFor("abcdef02", 2, "c") };
    const after = replaceLocAtomic(dirs, target, tmp2, replacement, ident);
    expect(readFileSync(join(root, "topic.md"), "utf8")).toBe("second");
    expect(observeLoc(dirs, target)).toEqual({ kind: "file", ...after });

    moveLocNoClobber(dirs, target, { area: "archive", name: "topic.md" }, after);
    expect(observeLoc(dirs, target)).toEqual({ kind: "absent" });
    const archived = observeLoc(dirs, { area: "archive", name: "topic.md" });
    expect(archived.kind).toBe("file");
    if (archived.kind === "file")
      expect(unlinkObservedLoc(dirs, { area: "archive", name: "topic.md" }, archived)).toBe("unlinked");
  });

  it("probes hard links and rejects an old epoch", () => {
    const { dirs } = fixture();
    expect(() => probeHardlinks(dirs)).not.toThrow();
    expect(readEpoch(dirs)).toBe(0);
    expect(bumpEpoch(dirs, { pid: process.pid, host: "test" })).toBe(1);
    expect(() =>
      writeTmpLoc(dirs, { area: "tmp", within: "live", name: tmpNameFor("abcdef03", 1, "c") }, Buffer.from("x"), {
        epoch: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "EPOCH_REVOKED", mutated: false }));
  });

  it("never unlinks an object whose inode or sha changed", () => {
    const { dirs, root } = fixture();
    writeFileSync(join(root, "owned.md"), "old");
    const observed = observeLoc(dirs, { area: "live", name: "owned.md" });
    if (observed.kind !== "file") throw new Error("expected file");
    writeFileSync(join(root, "owned.md"), "new");
    expect(() => unlinkObservedLoc(dirs, { area: "live", name: "owned.md" }, observed)).toThrowError(
      expect.objectContaining({ code: "OWNERSHIP", mutated: false }),
    );
    expect(readdirSync(root)).toContain("owned.md");
  });

  it("detects a swapped directory before mutation", () => {
    const { dirs, root } = fixture();
    writeFileSync(join(root, "swap.md"), "x");
    const observed = observeLoc(dirs, { area: "live", name: "swap.md" });
    if (observed.kind !== "file") throw new Error("expected file");
    renameSync(join(root, "archive"), join(root, "archive-old"));
    mkdirSync(join(root, "archive"));
    expect(() =>
      moveLocNoClobber(dirs, { area: "live", name: "swap.md" }, { area: "archive", name: "swap.md" }, observed),
    ).toThrowError(expect.objectContaining({ code: "DIR_SWAPPED", mutated: false }));
  });

  it("warns once and does not throw when directory fsync is unavailable", () => {
    const { root } = fixture();
    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");
    const warnings: string[] = [];
    const state = createFsyncWarningState();
    fsyncDirBestEffort(file, (message) => warnings.push(message), state);
    fsyncDirBestEffort(file, (message) => warnings.push(message), state);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it("uses conservative lease owner liveness", () => {
    const payload = makeLeasePayload(0, []);
    expect(leaseOwnerAlive({ payload, mtimeMs: Date.now() })).toBe(true);
    expect(
      leaseOwnerAlive({
        payload: { ...payload, pid: 999_999_999 },
        mtimeMs: Date.now(),
      }),
    ).toBe(false);
    expect(
      leaseOwnerAlive({
        payload: { ...payload, host: "other-host" },
        mtimeMs: Date.now(),
      }),
    ).toBeUndefined();
  });

  it("keeps lease payload complete and token-scoped", () => {
    const { root } = fixture();
    const payload = makeLeasePayload(0, []);
    expect(leaseCreate(root, payload)).toBe(true);
    expect(leaseCreate(root, makeLeasePayload(0, []))).toBe(false);
    expect(leaseRead(root)?.payload.token).toBe(payload.token);
    expect(leaseRefresh(root, { ...payload, draining: ["run-1"] })).toBe(true);
    expect(leaseRead(root)?.payload.draining).toEqual(["run-1"]);
    expect(leaseRelease(root, "wrong")).toBe(false);
    expect(leaseRelease(root, payload.token)).toBe(true);
    expect(leaseRead(root)).toBeUndefined();
  });
});
