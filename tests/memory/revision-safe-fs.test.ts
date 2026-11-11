import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createRevisionObserved,
  replaceRevisionObserved,
  deleteRevisionObserved,
  writeTempRegular,
  listRevisionNamesBounded,
  fsyncRevisionFile,
} from "../../src/memory/safe-fs.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function root() {
  const p = fs.mkdtempSync(join(tmpdir(), "revision-safe-"));
  roots.push(p);
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function temp(p: string) {
  return writeTempRegular(p, "target.md", Buffer.from("actual bytes"), 0o600);
}
const binding = { digest: hash("actual bytes"), rev: "1-abcdef" };
it("replace observes the rename itself and checks prepared bytes after the final guard", () => {
  const p = root(),
    t = temp(p);
  fs.writeFileSync(join(p, "target.md"), "old");
  const seen: string[] = [];
  const result = replaceRevisionObserved(p, t, "target.md", binding, {
    beforeSyscall: () => seen.push("guard"),
    observe: (o) => {
      expect(o.kind).toBe("applied");
      expect(fs.readFileSync(join(p, "target.md"), "utf8")).toBe("actual bytes");
      seen.push("observed");
    },
  });
  expect(result.observation).toMatchObject({
    kind: "applied",
    proof: "rename-observed",
    expectedAfter: { kind: "file", ...binding },
  });
  expect(seen).toEqual(["guard", "observed"]);
  const t2 = temp(p);
  expect(
    replaceRevisionObserved(p, t2, "target.md", binding, {
      beforeSyscall: () => fs.writeFileSync(join(p, t2), "tamper"),
    }).observation.kind,
  ).toBe("not-applied");
  expect(fs.readFileSync(join(p, "target.md"), "utf8")).toBe("actual bytes");
});
it("observer failure after rename preserves applied bytes without rollback", () => {
  const p = root(),
    t = temp(p);
  const r = replaceRevisionObserved(p, t, "target.md", binding, {
    observe: () => {
      throw Error("after rename");
    },
  });
  expect(r).toMatchObject({
    observation: { kind: "applied", proof: "rename-observed" },
    error: expect.stringContaining("after rename"),
  });
  expect(fs.readFileSync(join(p, "target.md"), "utf8")).toBe("actual bytes");
  expect(fs.existsSync(join(p, t))).toBe(false);
});
it("create link success + temp unlink failure is applied, with both paths retained", () => {
  const p = root(),
    t = temp(p),
    actual = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
    if (String(path) === join(p, t)) throw Error("unlink fault");
    actual(path);
  });
  const r = createRevisionObserved(p, t, "target.md", binding);
  expect(r).toMatchObject({
    observation: {
      kind: "applied",
      proof: "link-observed",
      paths: [
        { area: "temp", name: t },
        { area: "blocks", name: "target.md" },
      ],
    },
    error: expect.any(String),
  });
  expect(fs.readFileSync(join(p, t))).toEqual(fs.readFileSync(join(p, "target.md")));
});
it("delete link alone is never deletion proof; unlink failure retains unknown and both paths", () => {
  const p = root(),
    trash = join(p, ".trash");
  fs.mkdirSync(trash, { mode: 0o700 });
  fs.writeFileSync(join(p, "target.md"), "actual bytes", { mode: 0o600 });
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw Error("source unlink fault");
  });
  const r = deleteRevisionObserved(p, "target.md", trash, "entry.md", binding);
  expect(r.observation).toEqual({
    kind: "unknown",
    reason: "trash-linked-source-not-unlinked",
    paths: [
      { area: "blocks", name: "target.md" },
      { area: "trash", name: "entry.md" },
    ],
  });
  expect(fs.statSync(join(p, "target.md")).ino).toBe(fs.statSync(join(trash, "entry.md")).ino);
});
it("delete applied-missing is emitted only after successful source unlink", () => {
  const p = root(),
    trash = join(p, ".trash");
  fs.mkdirSync(trash, { mode: 0o700 });
  fs.writeFileSync(join(p, "target.md"), "actual bytes", { mode: 0o600 });
  const r = deleteRevisionObserved(p, "target.md", trash, "entry.md", binding, {
    observe: (o) => {
      expect(fs.existsSync(join(p, "target.md"))).toBe(false);
      expect(o).toMatchObject({ kind: "applied", expectedAfter: { kind: "missing" }, proof: "unlink-observed" });
    },
  });
  expect(r.error).toBeUndefined();
  expect(fs.readFileSync(join(trash, "entry.md"), "utf8")).toBe("actual bytes");
});
it.each(["EPERM", "ENOTSUP", "EXDEV", "EEXIST"])("no-clobber %s refuses without legacy rename fallback", (code) => {
  const p = root(),
    t = temp(p);
  fs.writeFileSync(join(p, "target.md"), "occupied");
  const rename = vi.spyOn(fs, "renameSync");
  vi.spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(Error(code), { code });
  });
  const r = createRevisionObserved(p, t, "target.md", binding);
  expect(r.observation.kind).toBe("not-applied");
  expect(r.error).toContain(code);
  expect(rename).not.toHaveBeenCalled();
  expect(fs.readFileSync(join(p, "target.md"), "utf8")).toBe("occupied");
  expect(fs.existsSync(join(p, t))).toBe(true);
});
it("wrong digest, wide permissions, symlink and traversal are refused before syscall", () => {
  const p = root(),
    t = temp(p),
    rename = vi.spyOn(fs, "renameSync");
  expect(replaceRevisionObserved(p, t, "target.md", { ...binding, digest: "0".repeat(64) }).observation.kind).toBe(
    "not-applied",
  );
  fs.chmodSync(join(p, t), 0o644);
  expect(replaceRevisionObserved(p, t, "target.md", binding).observation.kind).toBe("not-applied");
  fs.chmodSync(join(p, t), 0o600);
  fs.symlinkSync(join(p, t), join(p, "link"));
  expect(replaceRevisionObserved(p, "link", "target.md", binding).observation.kind).toBe("not-applied");
  expect(replaceRevisionObserved(p, t, "../escape", binding).observation.kind).toBe("not-applied");
  expect(rename).not.toHaveBeenCalled();
});
it("bounded scan rejects overflow and I/O instead of a truncated successful list", () => {
  const p = root();
  fs.writeFileSync(join(p, "a"), "");
  fs.writeFileSync(join(p, "b"), "");
  expect(listRevisionNamesBounded(p, 2)).toEqual(["a", "b"]);
  expect(() => listRevisionNamesBounded(p, 1)).toThrow("incomplete");
  expect(() => listRevisionNamesBounded(join(p, "absent"), 2)).toThrow();
});
it("evidence file fsync propagates failures without rewriting data or relaxing private identity", () => {
  const p = root(),
    name = temp(p),
    identity = fs.statSync(join(p, name)),
    before = fs.readFileSync(join(p, name));
  const sync = vi.spyOn(fs, "fsyncSync");
  fsyncRevisionFile(p, name, identity);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(join(p, name))).toEqual(before);
  expect(fs.statSync(join(p, name)).ino).toBe(identity.ino);
  sync.mockImplementation(() => {
    throw Error("persistent fsync");
  });
  expect(() => fsyncRevisionFile(p, name, identity)).toThrow("persistent fsync");
  expect(fs.readFileSync(join(p, name))).toEqual(before);
});
it("evidence file fsync refuses symlinks, foreign inode, wide mode, and a swap during fsync", () => {
  const p = root(),
    name = temp(p),
    identity = fs.statSync(join(p, name));
  fs.symlinkSync(join(p, name), join(p, "link"));
  expect(() => fsyncRevisionFile(p, "link", identity)).toThrow();
  expect(() => fsyncRevisionFile(p, name, { dev: identity.dev, ino: identity.ino + 1 })).toThrow("identity/permission");
  fs.chmodSync(join(p, name), 0o644);
  expect(() => fsyncRevisionFile(p, name, identity)).toThrow("identity/permission");
  expect(fs.statSync(join(p, name)).mode & 0o777).toBe(0o644);
  fs.chmodSync(join(p, name), 0o600);
  const actual = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    actual(fd);
    fs.renameSync(join(p, name), join(p, "saved"));
    fs.writeFileSync(join(p, name), "new inode", { mode: 0o600 });
  });
  expect(() => fsyncRevisionFile(p, name, identity)).toThrow("changed during file fsync");
  expect(fs.readFileSync(join(p, name), "utf8")).toBe("new inode");
  expect(fs.readFileSync(join(p, "saved"), "utf8")).toBe("actual bytes");
});
