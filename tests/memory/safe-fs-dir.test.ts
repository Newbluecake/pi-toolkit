import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalDir,
  fsyncDir,
  inspectDirNoFollow,
  removeTreeNoFollow,
  renameDirNoClobber,
} from "../../src/memory/safe-fs.js";
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()) }));
const roots: string[] = [];
function root(): string {
  const p = nodeFs.mkdtempSync(join(tmpdir(), "safe-dir-"));
  roots.push(p);
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) nodeFs.rmSync(p, { recursive: true, force: true });
});
it("directory rename refuses occupied targets, symlinks and traversal", () => {
  const p = root(),
    parent = canonicalDir(p)!;
  nodeFs.mkdirSync(join(p, "from"));
  nodeFs.mkdirSync(join(p, "to"));
  expect(() => renameDirNoClobber(parent, "from", "to")).toThrow("EEXIST");
  nodeFs.writeFileSync(join(p, "to", "file"), "occupied");
  expect(() => renameDirNoClobber(parent, "from", "to")).toThrow("EEXIST");
  nodeFs.symlinkSync(join(p, "from"), join(p, "link"));
  expect(() => renameDirNoClobber(parent, "link", "next")).toThrow("not-dir");
  for (const name of ["a/b", ".", "..", "", "x\0y"])
    expect(() => renameDirNoClobber(parent, name, "next")).toThrow("bad-name");
  const before = inspectDirNoFollow(join(p, "from"));
  renameDirNoClobber(parent, "from", "next");
  expect(inspectDirNoFollow(join(p, "next"))).toEqual(before);
});
it.each(["EXDEV", "ENOTSUP", "EPERM", "EINVAL", "ENOSYS"])("rename %s fails closed without copying", (code) => {
  const p = root();
  nodeFs.mkdirSync(join(p, "from"));
  nodeFs.writeFileSync(join(p, "from", "file"), "original");
  vi.spyOn(nodeFs, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("unsupported"), { code });
  });
  expect(() => renameDirNoClobber(canonicalDir(p)!, "from", "to")).toThrow(code);
  expect(nodeFs.readdirSync(p)).toEqual(["from"]);
  expect(nodeFs.readFileSync(join(p, "from", "file"), "utf8")).toBe("original");
});
it("tree deletion unlinks external symlinks without following them", () => {
  const p = root(),
    outside = root();
  nodeFs.writeFileSync(join(outside, "keep"), "safe");
  nodeFs.mkdirSync(join(p, "isolated"));
  nodeFs.mkdirSync(join(p, "isolated", "sub"));
  nodeFs.writeFileSync(join(p, "isolated", "sub", "file"), "x");
  nodeFs.symlinkSync(outside, join(p, "isolated", "link"));
  expect(removeTreeNoFollow(canonicalDir(p)!, "isolated", { maxOps: 10 })).toEqual({ removed: true, ops: 4 });
  expect(nodeFs.readFileSync(join(outside, "keep"), "utf8")).toBe("safe");
});
it("budget truncation is resumable; beforeOp stops and roots are guarded", () => {
  const p = root();
  nodeFs.mkdirSync(join(p, "isolated"));
  nodeFs.writeFileSync(join(p, "isolated", "a"), "a");
  nodeFs.writeFileSync(join(p, "isolated", "b"), "b");
  const parent = canonicalDir(p)!;
  expect(removeTreeNoFollow(parent, "isolated", { maxOps: 1 })).toEqual({ removed: false, ops: 1, reason: "budget" });
  expect(removeTreeNoFollow(parent, "isolated", { maxOps: 10, beforeOp: () => false })).toEqual({
    removed: false,
    ops: 0,
    reason: "stopped",
  });
  expect(removeTreeNoFollow(parent, "isolated", { maxOps: 10 })).toEqual({ removed: true, ops: 2 });
  nodeFs.symlinkSync(root(), join(p, "link"));
  expect(removeTreeNoFollow(parent, "link", { maxOps: 10 })).toMatchObject({ reason: "symlink", ops: 0 });
  expect(removeTreeNoFollow(parent, "../bad", { maxOps: 10 })).toMatchObject({ reason: "bad-name" });
  nodeFs.writeFileSync(join(p, "file"), "x");
  expect(removeTreeNoFollow(parent, "file", { maxOps: 10 })).toMatchObject({ reason: "not-dir" });
});
it("tree device and identity rechecks stop before destructive operations", () => {
  const p = root();
  nodeFs.mkdirSync(join(p, "isolated"));
  nodeFs.mkdirSync(join(p, "isolated", "mount"));
  const actual = nodeFs.lstatSync;
  vi.spyOn(nodeFs, "lstatSync").mockImplementation(((path: nodeFs.PathLike) => {
    const st = actual(path);
    if (String(path).endsWith("mount")) Object.defineProperty(st, "dev", { value: -1 });
    return st;
  }) as typeof nodeFs.lstatSync);
  expect(removeTreeNoFollow(canonicalDir(p)!, "isolated", { maxOps: 10 })).toMatchObject({ reason: "xdev", ops: 0 });
  vi.restoreAllMocks();
  nodeFs.writeFileSync(join(p, "isolated", "a"), "x");
  let swapped = false;
  const result = removeTreeNoFollow(canonicalDir(p)!, "isolated", {
    maxOps: 10,
    beforeOp: () => {
      if (!swapped) {
        swapped = true;
        nodeFs.renameSync(join(p, "isolated"), join(p, "saved"));
        nodeFs.symlinkSync(root(), join(p, "isolated"));
      }
      return true;
    },
  });
  expect(result).toMatchObject({ reason: "not-dir", ops: 0 });
  expect(nodeFs.readFileSync(join(p, "saved", "a"), "utf8")).toBe("x");
});
it("strict fsync and root-approved read-only identity probe reject missing/non-directory/symlink paths", () => {
  const p = root();
  expect(inspectDirNoFollow(p)).toMatchObject({
    dev: expect.any(Number),
    ino: expect.any(Number),
    mtimeMs: expect.any(Number),
  });
  fsyncDir(p);
  nodeFs.writeFileSync(join(p, "file"), "x");
  nodeFs.symlinkSync(p, join(p, "link"));
  for (const path of [join(p, "file"), join(p, "link"), join(p, "missing")])
    expect(() => inspectDirNoFollow(path)).toThrow();
  expect(() => fsyncDir(join(p, "missing"))).toThrow();
  vi.spyOn(nodeFs, "fsyncSync").mockImplementation(() => {
    throw new Error("fsync failed");
  });
  expect(() => fsyncDir(p)).toThrow("fsync failed");
});

it("read-only inspection distinguishes empty from EACCES enumeration", () => {
  const p = root();
  expect(inspectDirNoFollow(p).names).toEqual([]);
  vi.spyOn(nodeFs, "readdirSync").mockImplementation(() => {
    throw Object.assign(new Error("not enumerable"), { code: "EACCES" });
  });
  expect(() => inspectDirNoFollow(p)).toThrow("not enumerable");
});
