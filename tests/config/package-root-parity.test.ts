/**
 * startup-bundle plan r3 §3.4: `packageRoot()` exists twice — the authority in `src/core/` and a
 * verbatim mirror in `src/web-hub/protocol/` (protocol may not value-import `src/core/*`, I8).
 * Same shape as `agent-dir-parity.test.ts`: one contract table drives BOTH implementations.
 *
 * The three layouts the resolver must agree on:
 *  - `src`:     `<pkg>/src/{core,hud,feishu-notify}/x.ts`         (jiti / git install)
 *  - `dist`:    `<pkg>/dist/{core,hud,feishu-notify}/x.js`        (tsc build, npm consumers)
 *  - `bundle`:  `<pkg>/dist/bundle/index.js` — ONE file, so depth is gone entirely (esbuild)
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packageRoot } from "../../src/core/package-root.js";
import { packageRoot as protocolPackageRoot } from "../../src/web-hub/protocol/package-root.js";

const PACKAGE_DIR = realpathSync(join(import.meta.dirname, "..", ".."));
const impls = [
  { label: "core", fn: packageRoot },
  { label: "protocol", fn: protocolPackageRoot },
] as const;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throw-away package tree: `<tmp>/pkg` with a `package.json` naming pi-toolkit. */
function makePkg(name = "pi-toolkit"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "package-root-parity-")));
  tmpRoots.push(root);
  const pkg = join(root, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  return pkg;
}

/** Write a placeholder file (any extension) at `rel` under `root`, creating parents. */
function touch(root: string, rel: string): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  return file;
}

describe("T-PR1 packageRoot mirrors agree on every layout", () => {
  let pkg: string;
  beforeEach(() => {
    pkg = makePkg();
  });

  // T-PR1: one contract table, both implementations, three real layouts.
  const cases: Array<{ label: string; from: (pkg: string) => string | URL }> = [
    { label: "src: src/core/x.ts", from: (r) => touch(r, "src/core/x.ts") },
    { label: "src: src/hud/x.ts", from: (r) => touch(r, "src/hud/x.ts") },
    { label: "src: src/feishu-notify/x.ts", from: (r) => touch(r, "src/feishu-notify/x.ts") },
    { label: "src: src/web-hub/agent/index.ts", from: (r) => touch(r, "src/web-hub/agent/index.ts") },
    { label: "src: src/web-hub/protocol/paths.ts", from: (r) => touch(r, "src/web-hub/protocol/paths.ts") },
    { label: "dist: dist/core/x.js", from: (r) => touch(r, "dist/core/x.js") },
    { label: "dist: dist/web-hub/protocol/paths.js", from: (r) => touch(r, "dist/web-hub/protocol/paths.js") },
    // the bundled case: a single file two levels down, whose "depth" is meaningless for src files
    { label: "bundle: dist/bundle/index.js", from: (r) => touch(r, "dist/bundle/index.js") },
    { label: "package root itself", from: (r) => r },
    { label: "package root with trailing separator", from: (r) => `${r}${sep}` },
    { label: "package.json (a file in the root)", from: (r) => join(r, "package.json") },
  ];

  it.each(cases)("$label", ({ label, from }) => {
    const start = from(pkg);
    for (const { label: impl, fn } of impls) {
      const got = fn(start);
      expect(got, `${impl} · ${label}`).toBe(pkg);
      expect(got.endsWith(sep), `${impl} · ${label} must not keep a trailing separator`).toBe(false);
    }
  });

  it("file URL and path string forms are equivalent", () => {
    const file = touch(pkg, "src/core/url.js");
    for (const { fn } of impls) {
      expect(fn(pathToFileURL(file))).toBe(pkg);
      expect(fn(file)).toBe(pkg);
    }
  });

  it("an inner package.json with a different name does not anchor", () => {
    const inner = touch(pkg, "node_modules/dep/package.json");
    writeFileSync(inner, JSON.stringify({ name: "some-other-package" }));
    const file = touch(pkg, "node_modules/dep/dist/x.js");
    for (const { fn } of impls) expect(fn(file)).toBe(pkg);
  });

  it("a corrupt inner package.json is skipped, not thrown", () => {
    const inner = touch(pkg, "vendor/broken/package.json");
    writeFileSync(inner, "{not json");
    const file = touch(pkg, "vendor/broken/deep/x.js");
    for (const { fn } of impls) expect(fn(file)).toBe(pkg);
  });

  it("no anchor within MAX_DEPTH (8) levels ⇒ throws, never silently returns cwd", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "package-root-none-")));
    tmpRoots.push(root);
    // 9 nesting levels below a directory WITHOUT any package.json
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i");
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "x.ts");
    writeFileSync(file, "");
    for (const { label, fn } of impls) {
      // exactly at the 8th ancestor the anchor is out of reach (root has no manifest either)
      expect(() => fn(file), label).toThrow(/无法定位包根/);
    }
  });

  it("a package root 8 levels above the start file is still found", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "package-root-depth-")));
    tmpRoots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-toolkit" }));
    const file = touch(root, "a/b/c/d/e/f/g/x.ts"); // start dir is 7 levels down ⇒ root at level 8
    for (const { fn } of impls) expect(fn(file)).toBe(root);
  });
});

describe("T-PR2 the real repository anchors both implementations", () => {
  it("no-argument default (import.meta.url) resolves the repo root", () => {
    for (const { label, fn } of impls) {
      expect(fn(), label).toBe(PACKAGE_DIR);
      expect(fn(PACKAGE_DIR), label).toBe(PACKAGE_DIR);
    }
  });

  it("stays stable across calls (no module-level memo would still pass, I4 is a source rule)", () => {
    for (const { fn } of impls) expect(fn(import.meta.url)).toBe(fn(import.meta.url));
  });
});

describe("T-PR3 the mirror is verbatim", () => {
  it("protocol copy differs from core only in its first (provenance) line", async () => {
    const { readFileSync } = await import("node:fs");
    const core = readFileSync(join(PACKAGE_DIR, "src/core/package-root.ts"), "utf8").split("\n");
    const mirror = readFileSync(join(PACKAGE_DIR, "src/web-hub/protocol/package-root.ts"), "utf8").split("\n");
    expect(core[0]).toMatch(/^\/\/ Package-root authority/);
    expect(mirror[0]).toBe("// Mirror of src/core/package-root.ts — parity: tests/config/package-root-parity.test.ts.");
    expect(mirror.slice(1)).toEqual(core.slice(1));
  });

  it("both files import only node:* (I8: no src/core value import from protocol)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of ["src/core/package-root.ts", "src/web-hub/protocol/package-root.ts"]) {
      const specs = [...readFileSync(join(PACKAGE_DIR, rel), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(specs.length, rel).toBeGreaterThan(0);
      for (const spec of specs) expect(spec.startsWith("node:"), `${rel} → ${spec}`).toBe(true);
    }
  });
});
