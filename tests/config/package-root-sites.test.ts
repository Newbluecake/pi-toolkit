/**
 * startup-bundle plan r3 §3.4 — the 8 `import.meta.url` depth sites now resolve the package root by
 * CONTENT (`name === "pi-toolkit"` in `package.json`), so src/, tsc `dist/` and any deeper emitted
 * layout must all produce the same paths.
 *
 * This is the real-layout half of `package-root-parity.test.ts` (which drives both resolver
 * implementations over synthetic trees). Here the actual production modules are loaded from real
 * emitted layouts of the real package:
 *
 *  - `src`        — the repository itself (jiti / git install).               paths.ts sits 3 deep.
 *  - `dist`       — `tsc -p tsconfig.build.json` (npm / release zip).          paths.js sits 3 deep.
 *  - `dist/bundle`— the same sources emitted two levels deeper, which is what a bundled entry
 *                   (`dist/bundle/index.js`) does to every module's relative depth. Under the old
 *                   `new URL("../../../", import.meta.url)` this layout resolved to
 *                   `<pkg>/dist/bundle/`; the content anchor must still find `<pkg>`.
 *
 * Each generated layout is a separate package directory with its own `package.json`, so
 * "resolved to this layout's temp root" is a real assertion, not a tautology against the repo.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = realpathSync(join(import.meta.dirname, "..", ".."));
const TSC = join(REPO, "node_modules", "typescript-7", "bin", "tsc");
/** The layout lives outside the repo, so `@types/node` must be pointed at explicitly. */
const TYPE_ROOTS = [join(REPO, "node_modules", "@types")];

let work: string;
let distPkg: string;
let deepPkg: string;

interface LayoutPaths {
  uiDistDir: string;
  rootDir: string;
  pluginRoot: string | undefined;
}

/** A throw-away package directory carrying this package's manifest name. */
function makeLayout(label: string): string {
  const root = join(work, label);
  mkdirSync(root, { recursive: true });
  // `type: module` mirrors the real package.json: NodeNext + ESM is what the repo builds.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-toolkit", version: "0.0.0", type: "module" }));
  cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
  return root;
}

/** Emit the modules under assertion (plus their transitive imports) into `root/<outDir>`. */
function emitLayout(root: string, outDir: string): void {
  const tsconfig = join(root, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        outDir,
        rootDir: "src",
        typeRoots: TYPE_ROOTS,
        types: ["node"],
      },
      // Only these entry modules. Compiling all of src/ would make this test fail for reasons it
      // does not own (other in-flight packages in the same worktree).
      files: ["src/web-hub/protocol/paths.ts", "src/hud/plugin-info.ts"],
    }),
  );
  try {
    execFileSync("node", [TSC, "-p", tsconfig], { cwd: root, stdio: "pipe" });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`tsc failed for ${root}:\n${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`);
  }
}

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "package-root-sites-")));

  distPkg = makeLayout("dist-layout");
  emitLayout(distPkg, "dist");

  deepPkg = makeLayout("deep-layout");
  emitLayout(deepPkg, join("dist", "bundle"));

  // Emitting runs a compiler, so give the suite room.
}, 120_000);

afterAll(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

/** Load the production modules from one layout's own emitted files (fresh URLs ⇒ no cache blend). */
async function loadLayout(root: string, base: string): Promise<LayoutPaths> {
  const paths = (await import(pathToFileURL(join(root, base, "web-hub", "protocol", "paths.js")).href)) as {
    packageUiDistDir(): string;
    packageRootDir(): string;
  };
  const info = (await import(pathToFileURL(join(root, base, "hud", "plugin-info.js")).href)) as {
    pluginRoot(): string | undefined;
  };
  return { uiDistDir: paths.packageUiDistDir(), rootDir: paths.packageRootDir(), pluginRoot: info.pluginRoot() };
}

/** Every layout must report the SAME byte shapes — only the package root differs. */
function expectShapes(got: LayoutPaths, root: string): void {
  expect(got.rootDir).toBe(root);
  expect(got.uiDistDir).toBe(`${join(root, "dist", "web-hub-ui")}${sep}`);
  expect(got.uiDistDir.endsWith(`web-hub-ui${sep}`), "packageUiDistDir keeps its trailing separator").toBe(true);
  expect(got.pluginRoot).toBe(`${root}${sep}`);
}

describe("T-PS1 src layout (the repository itself)", () => {
  it("packageUiDistDir / packageRootDir keep their byte shapes", async () => {
    const { packageUiDistDir, packageRootDir } = await import("../../src/web-hub/protocol/paths.js");
    expect(packageUiDistDir()).toBe(`${join(REPO, "dist", "web-hub-ui")}${sep}`);
    expect(packageRootDir()).toBe(REPO);
  });

  it("pluginRoot() returns the repo root with a trailing separator and can read package.json", async () => {
    const { pluginRoot, defaultPluginInfoDeps, readPluginInfo } = await import("../../src/hud/plugin-info.js");
    expect(pluginRoot()).toBe(`${REPO}${sep}`);
    const deps = defaultPluginInfoDeps();
    expect(deps?.root).toBe(`${REPO}${sep}`);
    expect(typeof (await readPluginInfo(deps!)).version).toBe("string");
  });

  it("TOOLKIT_PACKAGE_ROOT is the repo root and this module is under it", async () => {
    const { TOOLKIT_PACKAGE_ROOT, isUnder } = await import("../../src/traffic/dup-detect.js");
    expect(TOOLKIT_PACKAGE_ROOT).toBe(REPO);
    expect(isUnder(join(REPO, "src", "traffic", "index.ts"), TOOLKIT_PACKAGE_ROOT)).toBe(true);
  });

  it("the traffic page finds its assets through the package root", async () => {
    const { buildPage } = await import("../../src/traffic/page.js");
    const page = buildPage();
    // Both blobs were read: without them buildPage throws "已尝试目录: …".
    expect(page.html).toContain("createApp");
    expect(page.html).toMatch(/vue v3\.\d+\.\d+/);
  });
});

describe("T-PS2 tsc dist layout", () => {
  it("the compiled modules resolve THEIR package root with identical byte shapes", async () => {
    expectShapes(await loadLayout(distPkg, "dist"), distPkg);
  });
});

describe("T-PS3 deep (bundle-shaped) layout", () => {
  it("modules emitted under dist/bundle/ still resolve the package root", async () => {
    // Under the old derivation `new URL("../../../", import.meta.url)` from
    // `dist/bundle/web-hub/protocol/paths.js` yields `<pkg>/dist/` (*not* the package root) — a wrong
    // answer the content anchor must not reproduce.
    expectShapes(await loadLayout(deepPkg, join("dist", "bundle")), deepPkg);
  });
});
