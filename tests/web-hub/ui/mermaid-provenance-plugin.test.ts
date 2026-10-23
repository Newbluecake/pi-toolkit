import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";
import {
  MMD_CHUNK_PATTERN,
  PLAIN_CHUNK_PATTERN,
  chunkFileNamePattern,
  classifyChunkModules,
  computeExclusiveSets,
  elkBanner,
  embeddedComponentsOf,
  mermaidProvenancePlugin,
  normalizeLicense,
  packageDirOfModuleId,
  reachableModules,
  repoRelativePackageDir,
  type ModuleLookup,
  type UiProvenance,
} from "../../../src/web-hub/ui/mermaid-provenance-plugin.js";

/** Build a fake module graph: `edges[id] = { s: static imports, d: dynamic imports }`. */
function graph(
  edges: Record<string, { s?: string[]; d?: string[] }>,
  entries: string[],
): { lookup: ModuleLookup; ids: string[] } {
  const ids = Object.keys(edges);
  const lookup: ModuleLookup = (id) => {
    const e = edges[id];
    if (!e) return null;
    return { importedIds: e.s ?? [], dynamicallyImportedIds: e.d ?? [], isEntry: entries.includes(id) };
  };
  return { lookup, ids };
}

describe("computeExclusiveSets (E = M \\ A)", () => {
  it("handles a diamond: a module reachable from the app AND the impl is shared, never exclusive", () => {
    const { lookup, ids } = graph(
      {
        entry: { s: ["app", "shared"], d: ["impl"] },
        app: { s: ["shared"] },
        shared: {},
        impl: { s: ["core", "shared"] },
        core: { s: ["leafA", "leafB"] },
        leafA: { s: ["leafC"] },
        leafB: { s: ["leafC"] },
        leafC: {},
      },
      ["entry"],
    );
    const { exclusive, mermaid, app } = computeExclusiveSets(lookup, ids, "impl");
    expect([...exclusive].sort()).toEqual(["core", "impl", "leafA", "leafB", "leafC"]);
    expect(mermaid.has("shared")).toBe(true);
    expect(app.has("shared")).toBe(true);
    expect(exclusive.has("shared")).toBe(false);
    expect(app.has("impl")).toBe(false); // the traversal stops AT the impl
  });

  it("terminates on import cycles", () => {
    const { lookup, ids } = graph(
      { entry: { d: ["impl"] }, impl: { s: ["a"] }, a: { s: ["b"] }, b: { s: ["a", "impl"] } },
      ["entry"],
    );
    expect([...computeExclusiveSets(lookup, ids, "impl").exclusive].sort()).toEqual(["a", "b", "impl"]);
  });

  it("follows dynamic edges: a lazy diagram chunk reached only through the impl is exclusive; one also reached from another lazy app chunk is not", () => {
    const { lookup, ids } = graph(
      {
        entry: { d: ["impl", "otherLazy"] },
        impl: { d: ["diagramA", "sharedLazy"] },
        diagramA: { s: ["onlyMermaid"] },
        onlyMermaid: {},
        sharedLazy: {},
        otherLazy: { s: ["sharedLazy"] },
      },
      ["entry"],
    );
    const { exclusive } = computeExclusiveSets(lookup, ids, "impl");
    expect(exclusive.has("diagramA")).toBe(true);
    expect(exclusive.has("onlyMermaid")).toBe(true);
    expect(exclusive.has("sharedLazy")).toBe(false);
  });

  it("a STATIC edge from the entry to the impl makes the exclusive set empty-ish: the impl lands in the app set", () => {
    const { lookup, ids } = graph({ entry: { s: ["impl"] }, impl: { s: ["core"] }, core: {} }, ["entry"]);
    const { app, exclusive } = computeExclusiveSets(lookup, ids, "impl");
    // the traversal stops AT impl, so impl itself is not in A — but nothing else is exclusive of the entry's own
    // static closure being treated as first-screen: the build-level assertions (impl chunk exclusive + first-screen
    // disjointness, scripts/web-hub/check-ui-dist.ts) are what fail for this wiring.
    expect(app.has("entry")).toBe(true);
    expect([...exclusive].sort()).toEqual(["core", "impl"]);
  });

  it("reachableModules honours stopAt", () => {
    const { lookup } = graph({ a: { s: ["b"] }, b: { s: ["c"] }, c: {} }, []);
    expect([...reachableModules(lookup, ["a"], "b")]).toEqual(["a"]);
  });
});

describe("chunk naming / classification", () => {
  const exclusive = new Set(["/n/m1.js", "/n/m2.js"]);
  it("`mmd-` only when every module is exclusive and the chunk is non-empty", () => {
    expect(chunkFileNamePattern(["/n/m1.js", "/n/m2.js"], exclusive)).toBe(MMD_CHUNK_PATTERN);
    expect(chunkFileNamePattern(["/n/m1.js", "/app.js"], exclusive)).toBe(PLAIN_CHUNK_PATTERN);
    expect(chunkFileNamePattern([], exclusive)).toBe(PLAIN_CHUNK_PATTERN);
    expect(chunkFileNamePattern(["/app.js"], new Set())).toBe(PLAIN_CHUNK_PATTERN);
  });

  it("mixed chunk: exclusive + shared modules are flagged with offenders; pure chunks are not", () => {
    expect(classifyChunkModules(["/n/m1.js", "/app/a.js", "/app/b.js"], exclusive)).toEqual({
      exclusive: false,
      mixed: true,
      offenders: ["/app/a.js", "/app/b.js"],
    });
    expect(classifyChunkModules(["/n/m1.js", "/n/m2.js"], exclusive)).toMatchObject({ exclusive: true, mixed: false });
    expect(classifyChunkModules(["/app/a.js"], exclusive)).toMatchObject({ exclusive: false, mixed: false });
    expect(classifyChunkModules([], exclusive)).toMatchObject({ exclusive: false, mixed: false });
  });
});

describe("package / licence / embedded-component helpers", () => {
  it("packageDirOfModuleId: scoped, nested, query suffix, virtual and first-party ids", () => {
    expect(packageDirOfModuleId("/r/node_modules/vue/dist/vue.js")).toEqual({
      name: "vue",
      dir: "/r/node_modules/vue",
    });
    expect(packageDirOfModuleId("/r/node_modules/@scope/pkg/lib/x.js?commonjs-proxy")).toEqual({
      name: "@scope/pkg",
      dir: "/r/node_modules/@scope/pkg",
    });
    expect(packageDirOfModuleId("/r/node_modules/a/node_modules/b/index.js")).toEqual({
      name: "b",
      dir: "/r/node_modules/a/node_modules/b",
    });
    expect(packageDirOfModuleId("\0vite/preload-helper")).toBeNull();
    expect(packageDirOfModuleId("/r/src/app.ts")).toBeNull();
    expect(repoRelativePackageDir("/abs/repo/node_modules/a/node_modules/b")).toBe("node_modules/a/node_modules/b");
  });

  it("normalizeLicense accepts string / {type} / garbage", () => {
    expect(normalizeLicense(" MIT ")).toBe("MIT");
    expect(normalizeLicense({ type: "ISC" })).toBe("ISC");
    expect(normalizeLicense(undefined)).toBeNull();
    expect(normalizeLicense("")).toBeNull();
    expect(normalizeLicense(5)).toBeNull();
  });

  it("embeddedComponentsOf reads the pnpm path comments and flags versionless comments with '?'", () => {
    const code = [
      "// ../../node_modules/.pnpm/fastdom@1.0.12_patch_hash=abc/node_modules/fastdom/fastdom.js",
      "// ../../node_modules/.pnpm/@chevrotain+gast@13.2.0/node_modules/x/y.js",
      "// ../../node_modules/.pnpm/vscode-uri@3.1.0/node_modules/vscode-uri/lib/index.js",
      "// ../../node_modules/flat-dep/lib/index.js",
      "var x = 'node_modules/.pnpm/not-a-comment-but-a-string@1.0.0/node_modules/p'",
    ].join("\n");
    expect(embeddedComponentsOf(code)).toEqual([
      "@chevrotain/gast@13.2.0",
      "fastdom@1.0.12",
      "flat-dep@?",
      "not-a-comment-but-a-string@1.0.0",
      "vscode-uri@3.1.0",
    ]);
    expect(embeddedComponentsOf("no markers here")).toEqual([]);
  });

  it("elkBanner states version, SPDX, copyright lines and the source tag", () => {
    const b = elkBanner("0.9.3");
    expect(b.startsWith("/*! Contains elkjs 0.9.3")).toBe(true);
    for (const needle of [
      "EPL-2.0",
      "Kiel University",
      "Google LLC",
      "Apache-2.0",
      "github.com/kieler/elkjs",
      "tag 0.9.3",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      expect(b).toContain(needle);
    }
    expect(b.endsWith("*/\n")).toBe(true);
  });
});

/* ------------------------------------------------------------------------------ real build */

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function writeFixture(opts: { elkBody: string }): string {
  const root = mkdtempSync(join(tmpdir(), "pwh-prov-"));
  tmpRoots.push(root);
  const w = (rel: string, content: string): void => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  w("package.json", '{"name":"fixture","type":"module"}');
  w("node_modules/elkjs/package.json", '{"name":"elkjs","version":"9.9.9","license":"EPL-2.0"}');
  w("node_modules/elkjs/lib/elk.bundled.js", opts.elkBody);
  w("node_modules/mm-core/package.json", '{"name":"mm-core","version":"1.2.3","license":"MIT"}');
  w(
    "node_modules/mm-core/index.js",
    "// ../../node_modules/.pnpm/inner-lib@4.5.6/node_modules/inner-lib/index.js\nexport const core = () => 'mm-core ' + Date.now();\n",
  );
  w("node_modules/shared-pkg/package.json", '{"name":"shared-pkg","version":"2.0.0","license":"ISC"}');
  w("node_modules/shared-pkg/index.js", "export const sh = () => 'shared-pkg';\n");
  w("src/shared.ts", "import { sh } from 'shared-pkg';\nexport const shared = () => sh();\n");
  w(
    "src/components/shared/mermaid-impl.ts",
    "import { core } from 'mm-core';\nimport { shared } from '../../shared';\nexport const impl = async () => { const elk = await import('elkjs/lib/elk.bundled.js'); return core() + shared() + String(elk.default); };\n",
  );
  w(
    "src/main.ts",
    "import { shared } from './shared';\nconsole.log(shared());\nexport const lazy = () => import('./components/shared/mermaid-impl');\nwindow.lazy = lazy;\n",
  );
  w("index.html", '<!doctype html><script type="module" src="/src/main.ts"></script>');
  w("public/theme-init.js", "document.documentElement.dataset.x = '1';\n");
  return root;
}

async function buildFixture(root: string, bannerOverride?: string): Promise<{ prov: UiProvenance; files: string[] }> {
  const outFile = join(root, "prov.json");
  const outDir = join(root, "dist");
  const plugin = mermaidProvenancePlugin({ outFile, ...(bannerOverride !== undefined ? { bannerOverride } : {}) });
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [plugin],
    publicDir: join(root, "public"),
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      reportCompressedSize: false,
      modulePreload: { polyfill: false },
      rollupOptions: { input: join(root, "index.html"), output: { chunkFileNames: plugin.chunkFileNames } },
    },
  });
  const files = readdirSync(join(outDir, "assets"));
  return { prov: JSON.parse(readFileSync(outFile, "utf8")) as UiProvenance, files };
}

describe("mermaidProvenancePlugin: a real vite build of a synthetic project", () => {
  it("names exclusive chunks mmd-*, keeps shared code out, records EVERY .js (R2-2), packages, embedded components and the ELK banner", async () => {
    const root = writeFixture({ elkBody: "export default 'ELK-BODY-1';\n" });
    const { prov, files } = await buildFixture(root);
    expect(prov.v).toBe(1);
    expect(prov.implInGraph).toBe(true);

    const names = Object.keys(prov.chunks);
    // public/theme-init.js is recorded as plain, non-exclusive, no packages (R2-2: never skipped)
    expect(prov.chunks["theme-init.js"]).toMatchObject({
      mermaidExclusive: false,
      containsImpl: false,
      containsElk: false,
      packages: [],
    });
    const mmd = names.filter((n) => n.startsWith("assets/mmd-"));
    expect(mmd.length).toBeGreaterThanOrEqual(2);
    for (const n of mmd) expect(prov.chunks[n]!.mermaidExclusive).toBe(true);
    for (const n of names.filter((x) => !x.startsWith("assets/mmd-")))
      expect(prov.chunks[n]!.mermaidExclusive).toBe(false);
    // the shared module + its package stay in the entry chunk (not exclusive)
    const entry = names.find((n) => /assets\/index-/.test(n))!;
    expect(prov.chunks[entry]!.packages.map((p) => p.name)).toContain("shared-pkg");
    expect(files.some((f) => f.startsWith("mmd-"))).toBe(true);
    // exactly one chunk carries the impl, and it is exclusive
    const impl = names.filter((n) => prov.chunks[n]!.containsImpl);
    expect(impl).toHaveLength(1);
    expect(prov.chunks[impl[0]!]!.mermaidExclusive).toBe(true);
    // packages carry version + licence
    const corePkg = names.flatMap((n) => prov.chunks[n]!.packages).find((p) => p.name === "mm-core");
    expect(corePkg).toMatchObject({
      version: "1.2.3",
      license: "MIT",
      dir: expect.stringContaining("node_modules/mm-core"),
    });
    // embedded components are detected from path comments of the OUTER package's files and sha-bound
    expect(prov.embedded["mm-core@1.2.3"]).toEqual([
      { file: "index.js", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), components: ["inner-lib@4.5.6"] },
    ]);
    // ELK chunk: banner first, flagged
    const elk = names.filter((n) => prov.chunks[n]!.containsElk);
    expect(elk).toHaveLength(1);
    const elkSource = readFileSync(join(root, "dist", elk[0]!), "utf8");
    expect(elkSource.startsWith(elkBanner("9.9.9"))).toBe(true);
    // sha256 bound to the final bytes
    const { createHash } = await import("node:crypto");
    expect(prov.chunks[elk[0]!]!.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(root, "dist", elk[0]!)))
        .digest("hex"),
    );
  }, 60_000);

  it("R2-8: a banner-only change renames the ELK chunk (the banner participates in the content hash)", async () => {
    const root = writeFixture({ elkBody: "export default 'ELK-BODY-2';\n" });
    const a = await buildFixture(root, "/*! banner A */\n");
    const b = await buildFixture(root, "/*! banner B */\n");
    const elkOf = (p: UiProvenance): string => Object.keys(p.chunks).find((n) => p.chunks[n]!.containsElk)!;
    expect(elkOf(a.prov)).not.toBe(elkOf(b.prov));
    expect(elkOf(a.prov)).toMatch(/^assets\/mmd-/);
  }, 60_000);

  it("without the impl in the module graph: implInGraph=false, no exclusive chunks, theme-init.js still recorded", async () => {
    const root = writeFixture({ elkBody: "export default 1;\n" });
    writeFileSync(join(root, "src/main.ts"), "import { shared } from './shared';\nconsole.log(shared());\n");
    const { prov } = await buildFixture(root);
    expect(prov.implInGraph).toBe(false);
    expect(Object.values(prov.chunks).some((c) => c.mermaidExclusive || c.containsImpl || c.containsElk)).toBe(false);
    expect(prov.chunks["theme-init.js"]).toBeDefined();
  }, 60_000);
});
