import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildInfoPlugin, readPackageVersion, resolveCommit } from "../../../src/web-hub/ui/build-info-plugin.js";
import { parseUiBuildInfo, UI_MAX_FILES } from "../../../src/web-hub/protocol/ui-manifest.js";

/**
 * `build-info-plugin.ts` unit tests (vue-plan.md v2.1 §1.2, §5.2 — P0). Exercises the plugin's
 * `configResolved`/`closeBundle` hooks directly against a temp `outDir` — no real Vite build
 * needed (`npm run build:web` + `check:web` exercise the real end-to-end pipeline; see the P0
 * acceptance report).
 */

const PKG_PATH = fileURLToPath(new URL("../../../package.json", import.meta.url));
const dirs: string[] = [];

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pwh-build-info-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readPackageVersion", () => {
  it("matches the repo's package.json version", async () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string };
    await expect(readPackageVersion()).resolves.toBe(pkg.version);
  });
});

describe("resolveCommit", () => {
  it("returns a 12-char hex commit (optionally -dirty) or the unknown sentinel", async () => {
    const commit = await resolveCommit();
    expect(commit).toMatch(/^[0-9a-f]{12}(-dirty)?$|^unknown$/);
  });
});

/** Minimal structural shape of Vite's `ResolvedConfig` the plugin actually reads. */
function fakeResolvedConfig(root: string, outDir: string) {
  return { root, build: { outDir } } as never;
}

describe("buildInfoPlugin", () => {
  it("writes a valid, self-consistent build-info.json for a simple output tree", async () => {
    const outDir = tmpOutDir();
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    writeFileSync(join(outDir, "theme-init.js"), "//noop");
    mkdirSync(join(outDir, "assets"));
    writeFileSync(join(outDir, "assets", "index-deadbeef.js"), "console.log(1)");
    writeFileSync(join(outDir, "assets", "index-deadbeef.css"), "body{}");

    const plugin = buildInfoPlugin();
    (plugin.configResolved as (c: unknown) => void)(fakeResolvedConfig(outDir, outDir));
    await (plugin.closeBundle as () => Promise<void>)();

    const raw = JSON.parse(await readFile(join(outDir, "build-info.json"), "utf8"));
    const parsed = parseUiBuildInfo(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.info.files.map((f) => f.path).sort()).toEqual(
      ["assets/index-deadbeef.css", "assets/index-deadbeef.js", "index.html", "theme-init.js"].sort(),
    );
    // sorted by path
    expect(parsed.info.files.map((f) => f.path)).toEqual([...parsed.info.files.map((f) => f.path)].sort());
  });

  it("refuses to write a manifest when the output tree contains a symlink", async () => {
    const outDir = tmpOutDir();
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    const real = join(outDir, "real.js");
    writeFileSync(real, "1");
    symlinkSync(real, join(outDir, "assets-link.js"));

    const plugin = buildInfoPlugin();
    (plugin.configResolved as (c: unknown) => void)(fakeResolvedConfig(outDir, outDir));
    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow(/symlink/i);
  });

  it("refuses to write a manifest when an output file is not on the path whitelist", async () => {
    const outDir = tmpOutDir();
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    writeFileSync(join(outDir, "unexpected.txt"), "x");

    const plugin = buildInfoPlugin();
    (plugin.configResolved as (c: unknown) => void)(fakeResolvedConfig(outDir, outDir));
    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow(/whitelist/i);
  });

  it("stays within UI_MAX_FILES for a plausible real build (sanity bound)", () => {
    // The manifest cap is generous relative to a single-chunk build (index.html, theme-init.js,
    // favicon.svg, one JS chunk, one CSS chunk = 5 files) — this is a documentation-style
    // assertion, not a behavioral one.
    expect(UI_MAX_FILES).toBeGreaterThanOrEqual(5);
  });
});
