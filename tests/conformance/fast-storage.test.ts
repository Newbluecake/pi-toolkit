/**
 * P0 /fast V4: offline public SessionManager characterization, NOT a Fast controller test.
 * Official docs/sdk.md#sessionmanager-api: manager owns the entry tree and active leaf;
 * docs/session-format.md#customentry: custom records are branch-local extension state.
 * A green characterization on 1.4 means the known UNSAFE behavior was reproduced, not V4 pass.
 * Compare another already-installed SDK with PI_TOOLKIT_FAST_STORAGE_SDK_ROOT=<package root>.
 * No model, AgentSession, prompt, credentials, private manager fields or fs patches are used.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionEntry, SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";

type ManagerClass = typeof SessionManager;
type Mode = "off" | "inherit" | "on";
const customType = "subagent:fast";
// The package exposes import-only exports (require.resolve cannot resolve its main).
// Resolve its installed package root from this test's own Node module search paths.
const modulePaths = createRequire(import.meta.url).resolve.paths("@earendil-works/pi-coding-agent") ?? [];
const installedRoot = modulePaths
  .map((path) => join(path, "@earendil-works/pi-coding-agent"))
  .find((path) => existsSync(join(path, "package.json")));
const sdkRoot = process.env.PI_TOOLKIT_FAST_STORAGE_SDK_ROOT
  ? resolve(process.env.PI_TOOLKIT_FAST_STORAGE_SDK_ROOT)
  : installedRoot!;
const version: string = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;
// This pins the observed 1.4 regression; newer hosts must retain rollback rather than silently
// accepting a new regression. Version is test expectation only, NOT production capability detection.
const rollback = !/^1\.4\./.test(version);
let Managers: ManagerClass;
const dirs: string[] = [];
beforeAll(async () => {
  Managers = (await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href)).SessionManager;
  console.info("FAST_STORAGE_SDK", JSON.stringify({ version, sdkRoot, expectedRollback: rollback }));
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "fast-storage-"));
  dirs.push(dir);
  const manager = Managers.create(dir, join(dir, "sessions"));
  return { dir, manager, file: manager.getSessionFile()! };
}
function record(manager: SessionManager, mode: Mode) {
  return manager.appendCustomEntry(customType, { v: 1, mode });
}
function mode(entries: readonly SessionEntry[]): Mode {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === customType).at(-1);
  return entry?.type === "custom" ? (entry.data as { mode: Mode }).mode : "inherit";
}
function treeEntries(nodes: SessionTreeNode[]): SessionEntry[] {
  return nodes.flatMap((node) => [node.entry, ...treeEntries(node.children)]);
}
function disk(file: string): SessionEntry[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session");
}
function user(manager: SessionManager) {
  return manager.appendMessage({ role: "user", content: "offline storage fixture only", timestamp: 1 });
}
function throwsCode(fn: () => unknown, codes: string[]) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(codes).toContain((caught as NodeJS.ErrnoException).code);
  return (caught as NodeJS.ErrnoException).code;
}
function sameSessionReopen(file: string, id: string) {
  const reopened = Managers.open(file);
  expect(reopened.getSessionId()).toBe(id);
  return reopened;
}

describe(`Fast storage public SDK ${version} (characterization != capability approval)`, () => {
  it.each(["off", "inherit"] as const)(
    "flushed %s -> failed on: memory, parent, tree, open, fork and clone",
    async (lastMode) => {
      const { dir, manager, file } = fresh();
      user(manager);
      const goodId = record(manager, lastMode);
      const id = manager.getSessionId();
      const baseline = readFileSync(file, "utf8");
      // Replace ONLY our generated file path with a directory. Preserve the original bytes
      // by renaming, not editing session content. appendFileSync now really fails EISDIR.
      const saved = `${file}.saved`;
      renameSync(file, saved);
      mkdirSync(file);
      const errorCode = throwsCode(() => record(manager, "on"), ["EISDIR"]);
      const failed = manager.getEntries().find((e) => e.type === "custom" && e.id !== goodId);
      expect(Boolean(failed)).toBe(!rollback);
      expect(mode(manager.getBranch())).toBe(rollback ? lastMode : "on");
      expect(mode(treeEntries(manager.getTree()))).toBe(rollback ? lastMode : "on");
      expect(manager.getLeafId()).toBe(rollback ? goodId : failed!.id);
      rmSync(file, { recursive: true });
      renameSync(saved, file);
      expect(readFileSync(file, "utf8")).toBe(baseline);
      expect(mode(sameSessionReopen(file, id).getBranch())).toBe(lastMode);

      // Public branch(last-success) can avoid the ghost on this one active branch, but does
      // not delete it: getTree/getBranch(ghost) still expose the failed value on 1.4.
      manager.branch(goodId);
      expect(mode(manager.getBranch())).toBe(lastMode);
      if (failed) {
        manager.branch(failed.id);
        expect(mode(manager.getBranch())).toBe("on");
      }
      // A normal microtask-scheduled append follows the current leaf; no fake concurrency
      // or sleep is needed because these manager operations are synchronous.
      const nextId = await Promise.resolve().then(() => manager.appendCustomEntry("p0:other", { ok: true }));
      expect(manager.getEntry(nextId)?.parentId).toBe(rollback ? goodId : failed!.id);
      expect(disk(file).some((e) => e.id === failed?.id)).toBe(false);
      const reopened = sameSessionReopen(file, id);
      // 1.4 persisted a dangling parent: open loses the successful Fast ancestor as well.
      expect(mode(reopened.getBranch())).toBe(rollback ? lastMode : "inherit");
      const fork = Managers.forkFrom(file, dir, join(dir, "fork"));
      expect(mode(fork.getBranch())).toBe(rollback ? lastMode : "inherit");
      // In contrast clone from the still-live memory tree writes the failed on to disk.
      const cloneFile = manager.createBranchedSession(nextId)!;
      expect(mode(Managers.open(cloneFile).getBranch())).toBe(rollback ? lastMode : "on");
      const cloneFork = Managers.forkFrom(cloneFile, dir, join(dir, "clone-fork"));
      expect(mode(cloneFork.getBranch())).toBe(rollback ? lastMode : "on");
      console.info(
        "FAST_STORAGE_MATRIX",
        JSON.stringify({
          version,
          scenario: "flushed",
          lastMode,
          errorCode,
          ghost: !rollback,
          nextParentIsFailed: !rollback,
          reopen: mode(reopened.getBranch()),
          cloneReopen: mode(Managers.open(cloneFile).getBranch()),
          v4: rollback ? "pass-this-case" : "BLOCK",
        }),
      );
    },
  );

  it.each(["off", "inherit"] as const)(
    "unflushed %s: buffered append is not write proof; first flush failure and retry",
    (lastMode) => {
      const { dir, manager, file } = fresh();
      const goodId = record(manager, lastMode);
      expect(existsSync(file)).toBe(false);
      mkdirSync(file);
      // No conversation means no disk I/O: custom append returns successfully even with
      // an unwritable destination, on BOTH SDKs. Keep last successful Fast off/inherit.
      const bufferedOther = manager.appendCustomEntry("p0:buffered", {});
      expect(mode(manager.getBranch())).toBe(lastMode);
      // First flush uses open('wx'): Linux returns EEXIST for the obstructing directory.
      const errorCode = throwsCode(() => user(manager), ["EEXIST", "EISDIR"]);
      const failedUser = manager.getLeafId();
      expect(failedUser === bufferedOther).toBe(rollback);
      // On 1.4 the failed user remains, so even another custom append attempts a flush:
      // this is a REAL failed custom on before the manager has ever flushed successfully.
      if (!rollback) throwsCode(() => record(manager, "on"), ["EEXIST", "EISDIR"]);
      const failedOn = !rollback ? manager.getLeafId() : null;
      rmSync(file, { recursive: true });
      const other = manager.appendCustomEntry("p0:other", {});
      expect(manager.getEntry(other)?.parentId).toBe(rollback ? bufferedOther : failedOn);
      expect(existsSync(file)).toBe(!rollback);
      if (rollback) user(manager); // public retry triggers first flush, preserving successful records
      const entries = disk(file);
      expect(entries.some((e) => e.id === goodId)).toBe(true);
      expect(entries.some((e) => e.id === failedOn)).toBe(!rollback);
      const reopened = Managers.open(file);
      expect(mode(reopened.getBranch())).toBe(rollback ? lastMode : "on");
      expect(reopened.getEntries().filter((e) => e.type === "message")).toHaveLength(1);
      const fork = Managers.forkFrom(file, dir, join(dir, "fork"));
      expect(mode(fork.getBranch())).toBe(rollback ? lastMode : "on");
      console.info(
        "FAST_STORAGE_MATRIX",
        JSON.stringify({
          version,
          scenario: "unflushed",
          lastMode,
          errorCode,
          bufferedCustomWrites: false,
          failedCustomPossibleAfterFailedUser: !rollback,
          failedOnEventuallyOnDisk: !rollback,
          v4: rollback ? "pass-this-case" : "BLOCK",
        }),
      );
    },
  );

  it("unflushed custom on itself returns without I/O, not a failed-on transaction", () => {
    const { manager, file } = fresh();
    record(manager, "off");
    mkdirSync(file);
    const onId = record(manager, "on");
    expect(manager.getLeafId()).toBe(onId);
    expect(mode(manager.getBranch())).toBe("on");
    throwsCode(() => user(manager), ["EEXIST", "EISDIR"]);
    rmSync(file, { recursive: true });
    user(manager);
    expect(disk(file).some((entry) => entry.id === onId)).toBe(true);
    expect(mode(Managers.open(file).getBranch())).toBe("on");
  });

  it.each(["off", "inherit"] as const)(
    "public open can discard flushed ghosts, but branch correction cannot erase them (%s)",
    (lastMode) => {
      const { dir, manager, file } = fresh();
      user(manager);
      const goodId = record(manager, lastMode);
      const saved = `${file}.saved`;
      renameSync(file, saved);
      mkdirSync(file);
      throwsCode(() => record(manager, "on"), ["EISDIR"]);
      const failedId = manager.getLeafId();
      rmSync(file, { recursive: true });
      renameSync(saved, file);
      const clean = Managers.open(file);
      expect(mode(clean.getBranch())).toBe(lastMode);
      clean.appendCustomEntry("p0:other", {});
      expect(mode(Managers.open(file).getBranch())).toBe(lastMode);
      // Merely correcting the old manager's active leaf does NOT make its full tree safe.
      manager.branch(goodId);
      const corrected = record(manager, lastMode);
      expect(mode(manager.getBranch())).toBe(lastMode);
      if (!rollback) {
        expect(mode(manager.getBranch(failedId!))).toBe("on");
        const ghostClone = manager.createBranchedSession(failedId!)!;
        expect(mode(Managers.open(ghostClone).getBranch())).toBe("on");
        expect(mode(Managers.forkFrom(ghostClone, dir, join(dir, "fork")).getBranch())).toBe("on");
      } else {
        expect(manager.getEntry(corrected)?.parentId).toBe(goodId);
        expect(
          manager.getEntries().some((e) => e.type === "custom" && (e.data as { mode?: string })?.mode === "on"),
        ).toBe(false);
      }
    },
  );
});
