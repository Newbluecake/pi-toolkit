/** No FUSE/real encryption: every executable used here is an owned marker, never a host tool. */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealHarness } from "./private-real-harness.js";
import {
  composeRealPath,
  createRealToolBridge,
  requireRealGocryptfs,
  resolveRealGocryptfs,
  type RealGocryptfsBinding,
} from "./real-tool-path.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-tool-path-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function bin(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function marker(dir: string, name: string, id: string, code = 0) {
  const path = join(dir, name);
  const log = join(dir, `${name}.calls`);
  writeFileSync(
    path,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({id:${JSON.stringify(id)},argv:process.argv.slice(2)})+"\\n");process.stdout.write(${JSON.stringify(id)});process.exit(${code});\n`,
    { mode: 0o700 },
  );
  return { path, log };
}
function calls(log: string): Array<{ id: string; argv: string[] }> {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s))
    : [];
}
function binding(path: string): RealGocryptfsBinding {
  const result = resolveRealGocryptfs(path);
  expect(result.reason).toBeUndefined();
  return requireRealGocryptfs(result.binding);
}
function run(path: string, command: string, argv: string[] = []) {
  return spawnSync(command, argv, { env: { PATH: path }, encoding: "utf8", timeout: 2_000 });
}
function fixture(id = "A") {
  const root = scratch();
  const parent = bin(root, "parent-local-bin");
  const tool = marker(parent, "gocryptfs", id);
  const selected = binding(parent);
  const fakeBin = bin(root, "fake-bin");
  const pi = marker(fakeBin, "pi", "fake-pi");
  const nodeBin = bin(root, "node-only");
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const realTools = createRealToolBridge(root, selected);
  const path = composeRealPath(fakeBin, nodeBin, realTools, selected, "");
  return { root, parent, tool, selected, fakeBin, pi, nodeBin, realTools, path };
}

describe("immutable gocryptfs selection and controlled fixture PATH (owned markers only)", () => {
  it("snapshots A; after parent PATH switches to B, direct init and controlled child still execute A (B zero calls)", () => {
    const f = fixture();
    const b = bin(f.root, "parent-B");
    const decoy = marker(b, "gocryptfs", "B");
    expect(Object.isFrozen(f.selected)).toBe(true);
    const before = process.env.PATH;
    try {
      process.env.PATH = b;
      const direct = run(process.env.PATH, requireRealGocryptfs(f.selected).realPath, ["-init", "marker-only"]);
      const child = run(f.path, "gocryptfs", ["-q", "marker-only"]);
      expect([direct.error, child.error]).toEqual([undefined, undefined]);
      expect([direct.status, child.status]).toEqual([0, 0]);
      expect([direct.stdout, child.stdout]).toEqual(["A", "A"]);
      expect(calls(f.tool.log)).toEqual([
        { id: "A", argv: ["-init", "marker-only"] },
        { id: "A", argv: ["-q", "marker-only"] },
      ]);
      expect(calls(decoy.log)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });

  it("RealHarness setup uses its explicit snapshot for direct init and child PATH, not a later parent PATH", () => {
    const root = scratch();
    const a = bin(root, "A");
    const tool = marker(a, "gocryptfs", "harness-A");
    const selected = binding(a);
    const b = bin(root, "B");
    const decoy = marker(b, "gocryptfs", "harness-B");
    // runStart avoids the harness's /proc constructor probe. No cleanup scan or real mount is used.
    const T = new RealHarness({ runStart: 0, gocryptfs: selected });
    const before = process.env.PATH;
    try {
      process.env.PATH = b;
      const e = T.setup([], { root });
      const result = run(e.env.PATH!, "gocryptfs", ["child-marker"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const log = calls(tool.log);
      expect(log).toHaveLength(2);
      expect(log[0]).toEqual({
        id: "harness-A",
        argv: ["-init", "-q", "-scryptn", "10", "-passfile", join(e.r, "pf"), "--", join(e.dir, "cipher")],
      });
      expect(log[1]).toEqual({ id: "harness-A", argv: ["child-marker"] });
      expect(calls(decoy.log)).toEqual([]);
      expect(realpathSync(join(e.r, "real-tools", "gocryptfs"))).toBe(selected.realPath);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });

  it("fixed-tail selection stays bound and deduplicated without copying a parent/local/nvm directory", () => {
    const f = fixture();
    expect(binding(`:${f.parent}:${f.parent}:`).realPath).toBe(f.selected.realPath);
    const path = composeRealPath(f.fakeBin, f.nodeBin, f.realTools, f.selected, "/usr/bin:/bin");
    expect(path.split(":")).toEqual([f.fakeBin, f.nodeBin, f.realTools, "/usr/bin", "/bin"]);
    expect(path.split(":")).not.toContain(f.parent);
    expect(path.split(":")).not.toContain(process.execPath.slice(0, process.execPath.lastIndexOf("/")));
    expect(resolveRealGocryptfs(path).binding).toEqual({
      selectedPath: join(f.realTools, "gocryptfs"),
      realPath: f.selected.realPath,
    });
    expect(calls(f.tool.log)).toEqual([]); // metadata never executes even -version
  });

  it("fake pi wins over a parent/nvm pi decoy; bridge whitelist contains only gocryptfs", () => {
    const f = fixture();
    const decoy = marker(f.parent, "pi", "real-pi-decoy");
    const result = run(f.path, "pi", ["hello"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fake-pi");
    expect(calls(f.pi.log)).toEqual([{ id: "fake-pi", argv: ["hello"] }]);
    expect(calls(decoy.log)).toEqual([]);
    expect(readdirSync(f.realTools)).toEqual(["gocryptfs"]);
    expect(lstatSync(f.realTools).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.realTools, "gocryptfs")).isSymbolicLink()).toBe(true);
  });

  it("explicit full PATH without tool fails ENOENT, never automatically appends a bridge", () => {
    const f = fixture();
    const override = bin(f.root, "explicit-empty-path");
    const result = run(override, "gocryptfs", ["marker-only"]);
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(calls(f.tool.log)).toEqual([]);
    expect(readdirSync(override)).toEqual([]);
  });

  it("fake gocryptfs mode has no bridge; its requested failure is not healed by a real decoy", () => {
    const root = scratch();
    const fakeBin = bin(root, "fake");
    const fake = marker(fakeBin, "gocryptfs", "fake", 42);
    const parent = bin(root, "real-decoy");
    const decoy = marker(parent, "gocryptfs", "real-decoy");
    const result = run(fakeBin, "gocryptfs", ["-init", "marker-only"]);
    expect(result.status).toBe(42);
    expect(calls(fake.log)).toEqual([{ id: "fake", argv: ["-init", "marker-only"] }]);
    expect(calls(decoy.log)).toEqual([]);
    expect(existsSync(join(root, "real-tools"))).toBe(false);
  });

  it("fake sync -f retains its injected exit; a real-sync decoy gets zero calls", () => {
    const f = fixture();
    const fake = marker(f.fakeBin, "sync", "fake-sync", 47);
    const tail = bin(f.root, "synthetic-system-tail");
    const decoy = marker(tail, "sync", "real-sync-decoy");
    const path = composeRealPath(f.fakeBin, f.nodeBin, f.realTools, f.selected, tail);
    const result = run(path, "sync", ["-f", "marker-only"]);
    expect(result.status).toBe(47);
    expect(result.stdout).toBe("fake-sync");
    expect(calls(fake.log)).toEqual([{ id: "fake-sync", argv: ["-f", "marker-only"] }]);
    expect(calls(decoy.log)).toEqual([]);
  });

  it("missing getfattr proves only isolated PATH absence, never borrows a parent tool or claims product 69", () => {
    const f = fixture();
    const decoy = marker(f.parent, "getfattr", "parent-getfattr");
    const before = process.env.PATH;
    try {
      process.env.PATH = f.parent;
      const result = run(f.path, "getfattr", ["marker-only"]);
      expect(result.error).toMatchObject({ code: "ENOENT" });
      expect(result.status).toBeNull();
      expect(calls(decoy.log)).toEqual([]);
      expect(readdirSync(f.realTools)).toEqual(["gocryptfs"]);
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });
});

describe("fail-closed bindings and scratch ownership", () => {
  it("missing/relative PATH never treats empty entries as cwd or resolves relative entries", () => {
    const root = scratch();
    expect(resolveRealGocryptfs(":").reason).toBe("missing gocryptfs");
    expect(resolveRealGocryptfs(`relative:${root}`).reason).toContain("relative PATH");
    expect(resolveRealGocryptfs(root).reason).toBe("missing gocryptfs");
  });

  it.each(["missing", "relative", "directory", "not-executable", "dangling"] as const)(
    "explicit %s binding throws without falling back to a valid candidate",
    (kind) => {
      const root = scratch();
      const a = bin(root, "invalid");
      const b = bin(root, "valid-fallback");
      const decoy = marker(b, "gocryptfs", "B");
      const invalid = join(a, "gocryptfs");
      if (kind === "directory") mkdirSync(invalid);
      if (kind === "not-executable") writeFileSync(invalid, "no", { mode: 0o600 });
      if (kind === "dangling") symlinkSync(join(a, "absent"), invalid);
      const path = kind === "relative" ? "relative/gocryptfs" : invalid;
      const before = process.env.PATH;
      try {
        process.env.PATH = b;
        expect(() => createRealToolBridge(root, { selectedPath: path, realPath: path })).toThrow(/gocryptfs/);
        expect(existsSync(join(root, "real-tools"))).toBe(false);
        expect(calls(decoy.log)).toEqual([]);
        if (["directory", "not-executable", "dangling"].includes(kind)) {
          expect(resolveRealGocryptfs(`${a}:${b}`).binding).toBeUndefined();
          expect(resolveRealGocryptfs(`${a}:${b}`).reason).toContain(invalid);
        }
      } finally {
        if (before === undefined) delete process.env.PATH;
        else process.env.PATH = before;
      }
    },
  );

  it.each(["deleted", "permissions", "retargeted"] as const)(
    "a capable snapshot later %s fails instead of skip/reselection",
    (kind) => {
      const f = fixture();
      const other = bin(f.root, "B");
      const decoy = marker(other, "gocryptfs", "B");
      if (kind === "permissions") chmodSync(f.tool.path, 0o600);
      else {
        unlinkSync(f.tool.path);
        if (kind === "retargeted") symlinkSync(decoy.path, f.tool.path);
      }
      expect(() => requireRealGocryptfs(f.selected)).toThrow(/gocryptfs binding/);
      expect(() => createRealToolBridge(scratch(), f.selected)).toThrow(/gocryptfs binding/);
      expect(calls(decoy.log)).toEqual([]);
    },
  );

  it.each(["directory", "same-name", "symlink", "dangling"] as const)(
    "existing %s bridge fails without overwrite or cleanup",
    (kind) => {
      const root = scratch();
      const parent = bin(root, "parent");
      const tool = marker(parent, "gocryptfs", "A");
      const selected = binding(parent);
      const bridge = join(root, "real-tools");
      const foreign = bin(root, "not-bridge");
      writeFileSync(join(foreign, "sentinel"), "unchanged");
      if (kind === "symlink" || kind === "dangling")
        symlinkSync(kind === "symlink" ? foreign : join(root, "absent"), bridge);
      else {
        mkdirSync(bridge, { mode: 0o700 });
        if (kind === "same-name") symlinkSync(tool.path, join(bridge, "gocryptfs"));
      }
      const originalTool = readFileSync(tool.path, "utf8");
      expect(() => createRealToolBridge(root, selected)).toThrow(/EEXIST/);
      expect(lstatSync(bridge).isSymbolicLink()).toBe(kind === "symlink" || kind === "dangling");
      expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("unchanged");
      expect(readFileSync(tool.path, "utf8")).toBe(originalTool);
      if (kind === "same-name") expect(realpathSync(join(bridge, "gocryptfs"))).toBe(tool.path);
      expect(calls(tool.log)).toEqual([]);
    },
  );

  it("unsafe scratch mode and symlink roots fail before writing outside owned scratch", () => {
    const f = fixture();
    const unsafe = scratch();
    chmodSync(unsafe, 0o755);
    expect(() => createRealToolBridge(unsafe, f.selected)).toThrow(/0700 scratch/);
    expect(existsSync(join(unsafe, "real-tools"))).toBe(false);
    const outside = scratch();
    const link = join(f.root, "scratch-link");
    symlinkSync(outside, link);
    expect(() => createRealToolBridge(link, f.selected)).toThrow(/0700 scratch/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each(["extra-name", "broken-link", "permissions"] as const)(
    "a bridge with %s is rejected, never repaired",
    (kind) => {
      const f = fixture();
      if (kind === "extra-name") writeFileSync(join(f.realTools, "sync"), "not allowed");
      if (kind === "broken-link") {
        unlinkSync(join(f.realTools, "gocryptfs"));
        symlinkSync(join(f.root, "absent"), join(f.realTools, "gocryptfs"));
      }
      if (kind === "permissions") chmodSync(f.realTools, 0o755);
      expect(() => composeRealPath(f.fakeBin, f.nodeBin, f.realTools, f.selected, "")).toThrow();
      if (kind === "extra-name") expect(readFileSync(join(f.realTools, "sync"), "utf8")).toBe("not allowed");
      if (kind === "broken-link") expect(lstatSync(join(f.realTools, "gocryptfs")).isSymbolicLink()).toBe(true);
      if (kind === "permissions") expect(lstatSync(f.realTools).mode & 0o777).toBe(0o755);
      expect(calls(f.tool.log)).toEqual([]);
    },
  );

  it("writing a fake gocryptfs cannot follow the separate real bridge and overwrite the selected binary", () => {
    const f = fixture();
    const original = readFileSync(f.tool.path, "utf8");
    const fake = marker(f.fakeBin, "gocryptfs", "fake", 39);
    const result = run(f.path, "gocryptfs", ["marker-only"]);
    expect(result.status).toBe(39);
    expect(readFileSync(f.tool.path, "utf8")).toBe(original);
    expect(calls(fake.log)).toHaveLength(1);
    expect(calls(f.tool.log)).toEqual([]);
    expect(() => composeRealPath(f.fakeBin, f.nodeBin, f.realTools, f.selected, "")).toThrow(/mismatch/);
  });

  it("parallel fixtures have distinct owned bridges and execute only their respective targets", async () => {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => fixture("A")),
      Promise.resolve().then(() => fixture("B")),
    ]);
    expect(a.root).not.toBe(b.root);
    expect(a.realTools).not.toBe(b.realTools);
    expect(realpathSync(join(a.realTools, "gocryptfs"))).toBe(a.tool.path);
    expect(realpathSync(join(b.realTools, "gocryptfs"))).toBe(b.tool.path);
    const exec = promisify(execFile);
    const results = await Promise.all([
      exec("gocryptfs", ["a"], { env: { PATH: a.path }, encoding: "utf8", timeout: 2_000 }),
      exec("gocryptfs", ["b"], { env: { PATH: b.path }, encoding: "utf8", timeout: 2_000 }),
    ]);
    expect(results.map((result) => result.stdout)).toEqual(["A", "B"]);
    expect(calls(a.tool.log)).toEqual([{ id: "A", argv: ["a"] }]);
    expect(calls(b.tool.log)).toEqual([{ id: "B", argv: ["b"] }]);
  });
});
