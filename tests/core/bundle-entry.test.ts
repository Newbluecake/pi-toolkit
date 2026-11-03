import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENTRY_ENV,
  bundleAvailable,
  bundlePath,
  bundleUrl,
  hooksSupported,
  installBundleHooks,
  pickBundleFactory,
  resetBundleHooksForTest,
  sourceEntryForced,
  staleWarning,
  staleness,
  type BundleResolveHook,
} from "../../src/core/bundle-entry.js";

/**
 * startup-bundle plan r3 §6.1 / §4.2: the decisions the dispatcher delegates here.
 * Every test injects its seams — nothing touches the real dist/ or the real process hook.
 */
/** Write the bundle file (presence is a real fs check) and return its path. */
function writeBundle(dir: string, name = "b.js"): string {
  const file = join(dir, name);
  writeFileSync(file, "export default async () => {};");
  return file;
}

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pt-bundle-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

afterEach(() => resetBundleHooksForTest());

/** A src tree whose newest .ts is at `ageMs` old relative to `now`. */
function fakeTree(dir: string, newestMs: number, now: number): string {
  const src = join(dir, "src");
  mkdirSync(join(src, "core"), { recursive: true });
  mkdirSync(join(src, "web-hub", "ui"), { recursive: true });
  writeFileSync(join(src, "index.ts"), "");
  writeFileSync(join(src, "core", "a.ts"), "");
  // UI sources are vite inputs, never bundle inputs ⇒ must not influence staleness.
  writeFileSync(join(src, "web-hub", "ui", "App.vue.ts"), "");
  const mtimes = new Map<string, number>([
    [join(src, "index.ts"), newestMs - 5_000],
    [join(src, "core", "a.ts"), newestMs],
    [join(src, "web-hub", "ui", "App.vue.ts"), now + 60_000],
  ]);
  return src;
}

describe("bundle availability", () => {
  it("reports presence from the (injected) bundle file only", () => {
    expect(bundleAvailable({ bundleFile: "/definitely/not/here/index.js" })).toBe(false);
    const t = tmp();
    try {
      const file = join(t.dir, "index.js");
      writeFileSync(file, "");
      expect(bundleAvailable({ bundleFile: file })).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it("bundlePath() and bundleUrl() point at dist/bundle/index.js under the package root", () => {
    expect(bundlePath()).toMatch(/\/dist\/bundle\/index\.js$/);
    expect(bundleUrl()).toMatch(/^file:\/\/.*\/dist\/bundle\/index\.js$/);
  });

  it("PI_TOOLKIT_ENTRY=src (case/space tolerant) forces the source path; anything else does not", () => {
    expect(sourceEntryForced({ [ENTRY_ENV]: "src" })).toBe(true);
    expect(sourceEntryForced({ [ENTRY_ENV]: " SRC " })).toBe(true);
    expect(sourceEntryForced({ [ENTRY_ENV]: "bundle" })).toBe(false);
    expect(sourceEntryForced({})).toBe(false);
  });
});

describe("staleness", () => {
  const now = Date.UTC(2026, 10, 3, 8, 0, 0);

  it("no bundle ⇒ unknown (the caller already took the source path)", () => {
    const t = tmp();
    try {
      const src = fakeTree(t.dir, now - 60_000, now);
      const info = staleness({
        bundleFile: join(t.dir, "dist", "bundle", "index.js"),
        srcDir: src,
        exists: () => false,
        mtime: () => now,
      });
      expect(info.state).toBe("unknown");
      expect(staleWarning(info)).toBe("");
    } finally {
      t.cleanup();
    }
  });

  it("source newer than the bundle ⇒ stale, and the warning names both timestamps + the fixes", () => {
    const t = tmp();
    try {
      const builtAt = now - 600_000;
      const src = fakeTree(t.dir, now - 1_000, now);
      const bundleFile = join(t.dir, "bundle.js");
      writeFileSync(bundleFile, "");
      const info = staleness({
        bundleFile,
        srcDir: src,
        mtime: (path) => (path === bundleFile ? builtAt : path.endsWith("core/a.ts") ? now - 1_000 : builtAt - 1),
      });
      expect(info.state).toBe("stale");
      expect(info.bundleMtimeMs).toBe(builtAt);
      expect(info.newestSrcMtimeMs).toBe(now - 1_000);
      expect(info.newestSrcPath.endsWith("core/a.ts")).toBe(true);
      const warning = staleWarning(info);
      expect(warning).toContain("[pi-subagent] bundle is stale");
      expect(warning).toContain("npm run build:bundle");
      expect(warning).toContain(`${ENTRY_ENV}=src`);
      expect(warning).toContain("running OLD code");
    } finally {
      t.cleanup();
    }
  });

  it("bundle newer than every .ts ⇒ fresh, silent", () => {
    const t = tmp();
    try {
      const builtAt = now;
      const src = fakeTree(t.dir, now - 600_000, now);
      const info = staleness({ bundleFile: writeBundle(t.dir), srcDir: src, mtime: () => builtAt - 1 });
      expect(info.state).toBe("fresh");
      expect(staleWarning(info)).toBe("");
    } finally {
      t.cleanup();
    }
  });

  it("equal mtimes ⇒ fresh (coarse filesystem timestamps must not cry wolf)", () => {
    const t = tmp();
    try {
      const src = fakeTree(t.dir, now, now);
      const info = staleness({ bundleFile: writeBundle(t.dir), srcDir: src, mtime: () => now });
      expect(info.state).toBe("fresh");
    } finally {
      t.cleanup();
    }
  });

  it("no src tree (release/npm install) ⇒ fresh with zero output", () => {
    const t = tmp();
    try {
      const bundleFile = writeBundle(t.dir);
      const info = staleness({
        bundleFile,
        srcDir: join(t.dir, "missing-src"),
        exists: (path) => path === bundleFile,
        mtime: () => now,
      });
      expect(info.state).toBe("fresh");
      expect(staleWarning(info)).toBe("");
    } finally {
      t.cleanup();
    }
  });

  it("ignores src/web-hub/ui (vite-built, not a bundle input)", () => {
    const t = tmp();
    try {
      const src = fakeTree(t.dir, now - 600_000, now);
      // The ui file in fakeTree is NEWER than the bundle; if it were counted the state would be stale.
      const info = staleness({ bundleFile: writeBundle(t.dir), srcDir: src, mtime: () => now });
      expect(info.state).toBe("fresh");
    } finally {
      t.cleanup();
    }
  });

  it("counts only .ts files (a newer .md or .json never makes the bundle stale)", () => {
    const t = tmp();
    try {
      const src = join(t.dir, "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "index.ts"), "");
      writeFileSync(join(src, "README.md"), "");
      writeFileSync(join(src, "data.json"), "");
      const builtAt = now;
      const info = staleness({
        bundleFile: writeBundle(t.dir),
        srcDir: src,
        mtime: (path) => (path.endsWith(".ts") ? builtAt - 10 : builtAt + 10),
      });
      expect(info.state).toBe("fresh");
    } finally {
      t.cleanup();
    }
  });
});

describe("installBundleHooks", () => {
  const okResolver = {
    argv1: "/fake/bin/pi",
    realpath: (p: string) => p,
    resolveFromPackageJson: (from: string, request: string) => {
      // Enough of a host tree for the seven mapped specifiers to resolve.
      if (request.startsWith("@earendil-works/")) return join("/fake/host", `${request}.js`);
      if (request.startsWith("typebox")) return join("/fake/host", `${request}.js`);
      throw new Error(`not found: ${request} from ${from}`);
    },
    exists: (path: string) => path === "/fake/bin/pi" || path.endsWith("package.json"),
    readText: (path: string) =>
      path.endsWith("pi-coding-agent/package.json")
        ? JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./dist/index.js" } } })
        : path.endsWith("pi-ai/package.json")
          ? JSON.stringify({
              name: "@earendil-works/pi-ai",
              exports: { ".": { import: "./dist/index.js" }, "./compat": { import: "./dist/compat.js" } },
            })
          : "{}",
  };

  it("installs once and is idempotent (Symbol.for marker, /reload-safe)", () => {
    const installed: BundleResolveHook[] = [];
    const deps = {
      ...okResolver,
      registerHooks: (options: { resolve: BundleResolveHook }) => installed.push(options.resolve),
    };
    const first = installBundleHooks(deps);
    expect(first.installed).toBe(true);
    expect(installed).toHaveLength(1);
    const second = installBundleHooks(deps);
    expect(second.installed).toBe(false);
    expect(second.reason).toContain("already installed");
    expect(installed).toHaveLength(1);
  });

  it("the hook redirects exactly the mapped specifiers and delegates everything else", () => {
    let hook: BundleResolveHook | undefined;
    installBundleHooks({
      ...okResolver,
      registerHooks: (options: { resolve: BundleResolveHook }) => (hook = options.resolve),
    });
    if (hook === undefined) throw new Error("hook was not installed");

    const redirected = hook("@earendil-works/pi-tui", {}, () => {
      throw new Error("must not delegate");
    }) as { url: string; shortCircuit: boolean };
    expect(redirected.url).toMatch(/^file:\/\/.*@earendil-works\/pi-tui\.js$/);
    expect(redirected.shortCircuit).toBe(true);

    const delegated = hook("node:fs", {}, (spec: string) => `delegated:${spec}`) as string;
    expect(delegated).toBe("delegated:node:fs");
  });

  it("maps pi-ai to the compat entry (pi's own alias contract)", () => {
    let hook: BundleResolveHook | undefined;
    installBundleHooks({
      ...okResolver,
      registerHooks: (options: { resolve: BundleResolveHook }) => (hook = options.resolve),
    });
    const hit = hook?.("@earendil-works/pi-ai", {}, () => "delegated") as { url: string };
    expect(hit.url).toMatch(/compat\.js$/);
  });

  it("an unresolvable host module is FATAL — never a partial redirect", () => {
    const installs: unknown[] = [];
    const result = installBundleHooks({
      ...okResolver,
      resolveFromPackageJson: () => {
        throw new Error("host typebox missing");
      },
      registerHooks: (options) => installs.push(options),
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("host modules not resolvable");
    expect(result.reason).toContain("typebox");
    expect(installs).toHaveLength(0); // nothing installed ⇒ no half-host graph
  });

  it("a failing pi anchor is reported, not swallowed", () => {
    const result = installBundleHooks({ argv1: "", registerHooks: () => {} });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("process.argv[1]");
  });

  it("without module.registerHooks the caller is told to fall back (Node < 22.15)", () => {
    expect(hooksSupported({ registerHooks: undefined })).toBe(false);
    const result = installBundleHooks({ ...okResolver, registerHooks: undefined });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("module.registerHooks is unavailable");
  });
});

describe("pickBundleFactory", () => {
  it("returns the default export when it is callable", () => {
    const factory = () => {};
    expect(pickBundleFactory({ default: factory })).toBe(factory);
    expect(pickBundleFactory({ default: async () => {} })).toBeTypeOf("function");
  });

  it("throws for a broken artifact instead of silently registering nothing", () => {
    expect(() => pickBundleFactory({})).toThrow(/no default activate\(\) export/);
    expect(() => pickBundleFactory({ default: "nope" })).toThrow(/no default activate\(\) export/);
    expect(() => pickBundleFactory(null)).toThrow(/no default activate\(\) export/);
    expect(() => pickBundleFactory({ default: {} })).toThrow(/no default activate\(\) export/);
  });
});
