import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOST_SPECIFIERS, PI_PACKAGE, findPiPackageJson, resolveHostModules } from "../../src/core/host-modules.js";
import { BUNDLE_EXTERNALS } from "../../scripts/bundle-externals.mjs";

/**
 * startup-bundle plan r3 §3.3.1: the host anchor must be realpath(argv1) → pi package.json →
 * createRequire(<that package.json>). `createRequire(argv1)` alone fails on every normal install
 * because `bin/pi` is a symlink — these tests pin that.
 */
function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pt-hostmod-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** npm-global layout: <p>/lib/node_modules/@earendil-works/pi-coding-agent + <p>/bin/pi symlink. */
function piLayout(dir: string): { piPkg: string; bin: string } {
  const piPkg = join(dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(piPkg, "dist"), { recursive: true });
  writeFileSync(
    join(piPkg, "package.json"),
    JSON.stringify({ name: PI_PACKAGE, exports: { ".": { import: "./dist/index.js" } } }),
  );
  writeFileSync(join(piPkg, "dist", "index.js"), "");
  mkdirSync(join(dir, "bin"));
  const bin = join(dir, "bin", "pi");
  symlinkSync(join("..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), bin);
  return { piPkg, bin };
}

describe("findPiPackageJson", () => {
  it("finds the package at or above a file inside the package dir", () => {
    const t = tmp();
    try {
      const { piPkg } = piLayout(t.dir);
      expect(findPiPackageJson(join(piPkg, "dist", "index.js"))).toBe(join(piPkg, "package.json"));
    } finally {
      t.cleanup();
    }
  });

  it("finds a nested node_modules copy from a sibling path", () => {
    const t = tmp();
    try {
      const piPkg = join(t.dir, "proj", "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(piPkg, { recursive: true });
      writeFileSync(join(piPkg, "package.json"), "{}");
      expect(findPiPackageJson(join(t.dir, "proj", "src", "x.js"))).toBe(join(piPkg, "package.json"));
    } finally {
      t.cleanup();
    }
  });

  it("returns undefined when nothing matches (does not throw)", () => {
    const t = tmp();
    try {
      expect(findPiPackageJson(join(t.dir, "lonely.js"))).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });
});

describe("resolveHostModules — real argv1 symlink layout", () => {
  it("walks through the bin/pi symlink instead of resolving from the symlink path", () => {
    const t = tmp();
    try {
      const { bin, piPkg } = piLayout(t.dir);
      // createRequire(<pi package.json>) is the anchor: assert it is what the chain produced.
      const r = resolveHostModules({ argv1: bin });
      if (!r.ok) throw new Error(r.reason);
      expect(r.piPackageJson).toBe(join(piPkg, "package.json"));
    } finally {
      t.cleanup();
    }
  });

  it("createRequire(argv1) would fail here — the point of the realpath step", () => {
    const t = tmp();
    try {
      const { bin } = piLayout(t.dir);
      // Documenting the trap: resolving from the symlink path cannot find the package tree.
      const fromSymlink = resolveHostModules({
        argv1: bin,
        realpath: (p) => p, // disable realpath: the pre-fix behaviour
      });
      if (!fromSymlink.ok) expect(fromSymlink.reason).toMatch(/pi package not found above/);
      else expect(fromSymlink.resolveHost("@earendil-works/pi-tui")).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it("reports a reason (never throws) when argv1 is empty or unresolvable", () => {
    expect(resolveHostModules({ argv1: "" }).ok).toBe(false);
    const missing = resolveHostModules({ argv1: "/nonexistent/pi/entry.js" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/realpath/);
  });

  it("resolves each specifier's host target and returns undefined for unknown ones", () => {
    const t = tmp();
    try {
      const { bin, piPkg } = piLayout(t.dir);
      const tuiPkg = join(piPkg, "node_modules", "@earendil-works", "pi-tui");
      mkdirSync(join(tuiPkg, "dist"), { recursive: true });
      writeFileSync(
        join(tuiPkg, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-tui", main: "./dist/index.js" }),
      );
      writeFileSync(join(tuiPkg, "dist", "index.js"), "");
      const aiPkg = join(piPkg, "node_modules", "@earendil-works", "pi-ai");
      mkdirSync(join(aiPkg, "dist"), { recursive: true });
      writeFileSync(
        join(aiPkg, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-ai",
          exports: { ".": { import: "./dist/index.js" }, "./compat": { import: "./dist/compat.js" } },
        }),
      );
      writeFileSync(join(aiPkg, "dist", "compat.js"), "");
      writeFileSync(join(aiPkg, "dist", "index.js"), "");

      const r = resolveHostModules({
        argv1: bin,
        // Stand-in for createRequire: the fake tree has no real resolution, so answer from the map.
        resolveFromPackageJson: (from, request) => {
          if (request === "@earendil-works/pi-tui")
            return join(dirname(dirname(from)), "@earendil-works", "pi-tui", "dist", "index.js");
          if (request === "typebox" || request === "typebox/value") return join(t.dir, "host-typebox", `${request}.js`);
          throw Object.assign(new Error(`not found: ${request}`), { code: "MODULE_NOT_FOUND" });
        },
      });
      if (!r.ok) throw new Error(r.reason);

      expect(r.resolveHost("@earendil-works/pi-ai")).toBe(join(aiPkg, "dist", "compat.js"));
      expect(r.resolveHost("@earendil-works/pi-coding-agent")).toBe(join(piPkg, "dist", "index.js"));
      // Both spellings go through the host's `typebox` (there is no host `@sinclair/typebox`).
      expect(r.resolveHost("@sinclair/typebox")).toBe(join(t.dir, "host-typebox", "typebox.js"));
      expect(r.resolveHost("@sinclair/typebox/value")).toBe(join(t.dir, "host-typebox", "typebox/value.js"));
      expect(r.resolveHost("not-a-host-module")).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it("a specifier that cannot be resolved returns undefined (caller treats it as fatal)", () => {
    const t = tmp();
    try {
      const { bin } = piLayout(t.dir);
      const r = resolveHostModules({ argv1: bin, resolveFromPackageJson: () => undefined as unknown as string });
      if (!r.ok) throw new Error(r.reason);
      expect(r.resolveHost("typebox")).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });
});

describe("HOST_SPECIFIERS ↔ BUNDLE_EXTERNALS", () => {
  it("every external the bundle can emit has a host mapping", () => {
    const externals = BUNDLE_EXTERNALS.filter((spec) => !spec.startsWith("node:"));
    const mapped = new Set(HOST_SPECIFIERS.map((entry) => entry.spec));
    // A superset is intended: `typebox` / `typebox/value` are resolution REQUESTS the hook map
    // reaches through, not specifiers the source ever writes. A missing external is the failure.
    const unmapped = externals.filter((spec) => !mapped.has(spec));
    expect(unmapped, unmapped.join(", ")).toEqual([]);
  });

  it("maps both typebox spellings onto the host's `typebox` package", () => {
    const bySpec = new Map(HOST_SPECIFIERS.map((entry) => [entry.spec, entry]));
    for (const [spec, subpath] of [
      ["@sinclair/typebox", "."],
      ["@sinclair/typebox/value", "./value"],
    ] as const) {
      const entry = bySpec.get(spec);
      expect(entry?.packageName, `${spec} → host typebox`).toBe("typebox");
      expect(entry?.subpath, `${spec} subpath`).toBe(subpath);
    }
  });
});
