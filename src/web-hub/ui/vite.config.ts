/**
 * Vite config for the web-hub Vue SPA (vue-plan.md v2.1 §1.1–§1.2, §4.4.1, §5.2 — P0 frozen).
 *
 * Two build modes, one config (so the CSP probe tests the exact same plugin/define/build
 * pipeline the real production bundle uses):
 *  - default (`npm run build:web`): entry `index.html`, output `dist/web-hub-ui/`,
 *    `build-info-plugin.ts` writes the manifest. JS ships as the main chunk PLUS code-split
 *    lazy chunks for dynamic `import()`s (2026-10 syntax-highlight: Prism + its language
 *    packs load only when a highlightable code view mounts) — `assets/<name>-<hash>.js`
 *    remains the naming contract `ui-manifest.ts`'s `isAllowedUiPath` enforces.
 *  - `--mode csp-probe` (`npm run probe:csp` / `npm run probe:mermaid` / `npm run
 *    probe:preview-perf`, §4.4.1): entries `csp-probe/{index,negative,mermaid,preview-perf}.html`,
 *    output `node_modules/.cache/pwh-csp-probe/` (already `.gitignore`d via `node_modules/`),
 *    no `build-info.json` (that plugin is skipped), no `public/` copy (the probe doesn't
 *    need `theme-init.js`/favicon).
 *
 * Both modes also run `mermaid-provenance-plugin.ts` (web-hub-mermaid plan §7): `assets/mmd-*` naming of the lazily
 * loaded mermaid closure, mixed-chunk build failure, the ELK EPL banner, and the sha256-bound sidecar `check:web`
 * verifies; `katex` is aliased to a throwing stub (math is not bundled).
 *
 * `vue()` resolves the SFC compiler at build time only — the shipped runtime is
 * `vue.runtime.esm-bundler.js` (Vite's default resolution target for the bare `vue`
 * specifier), never the full `vue.esm-bundler.js` build (which bundles the template
 * compiler and would need `unsafe-eval` for `script-src`). Components must never use the
 * `template:` string option (would force the full build) — enforced by the source scan
 * (`tests/web-hub/ui/source-scan.test.ts`).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type UserConfig } from "vite";
import { uiAliases } from "./aliases.js";
import { buildInfoPlugin, builtAtNow, readPackageVersion, resolveCommit } from "./build-info-plugin.js";
import { mermaidProvenancePlugin } from "./mermaid-provenance-plugin.js";
import { motionPrefCssPlugin } from "./motion-css.js";
import { PROTO } from "../protocol/version.js";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  // A shipped UI must be the production Vue build. Vite only defaults NODE_ENV when it is unset, so
  // an inherited NODE_ENV (e.g. vitest children get "test") would otherwise leak dev-only runtime
  // code (and its diagnostic strings) into dist/web-hub-ui.
  if (command === "build") process.env["NODE_ENV"] = "production";
  const cspProbe = mode === "csp-probe";
  const [version, commit] = await Promise.all([readPackageVersion(), resolveCommit()]);
  // One timestamp for both the bundle define and the manifest, so the TopBar build stamp and
  // `build-info.json`'s `builtAt` never drift apart.
  const builtAt = builtAtNow();
  // web-hub-mermaid plan §7: provenance of the (lazily loaded) mermaid closure — `assets/mmd-*`
  // naming for mermaid-exclusive chunks, mixed-chunk build failure, ELK EPL banner, and the
  // sha256-bound sidecar `check:web` verifies. Same plugin in both build modes (the probe tests
  // the exact pipeline the shipped bundle uses).
  const provenance = mermaidProvenancePlugin({
    outFile: resolve(
      here,
      "../../../node_modules/.cache",
      cspProbe ? "pwh-csp-probe-provenance.json" : "pwh-ui-provenance.json",
    ),
  });

  return {
    root: cspProbe ? resolve(here, "csp-probe") : here,
    base: "/",
    publicDir: cspProbe ? false : "public",
    plugins: [vue(), provenance, ...(cspProbe ? [] : [buildInfoPlugin({ builtAt })])],
    resolve: {
      alias: [
        ...Object.entries(uiAliases).map(([find, replacement]) => ({ find, replacement })),
        // KaTeX is NOT bundled (user ruling D2): mermaid's lazy `import("katex")` gets a stub that throws
        // a recognizable error, mapped to the `unsupported` outcome (plan §2.3).
        { find: /^katex$/, replacement: resolve(here, "src/vendor-stubs/katex.ts") },
      ],
    },
    // Motion preference (2026-10, `pwh_motion`): rewrite every
    // `@media (prefers-reduced-motion: reduce)` so the browser-side `data-motion` switch can
    // override the OS setting — see `./motion-css.ts`'s header for the full contract. Runs in
    // BOTH build modes (the csp-probe tests the same CSS pipeline the shipped bundle uses).
    css: { postcss: { plugins: [motionPrefCssPlugin()] } },
    // preview-perf P5 (plan r3 §5.3): the highlight worker is an ES-module worker. Vite's
    // default `worker.format: "iife"` cannot carry `highlight-worker.ts`'s DYNAMIC engine
    // import (the prismjs `disableWorkerMessageHandler` pre-load flag must be seeded before
    // any prism code evaluates, so the engine cannot be a static import — see that file's
    // header). "es" emits the worker entry + its engine chunk as plain hashed assets, both
    // served same-origin under the existing `script-src 'self'` CSP (no relaxation).
    worker: { format: "es" },
    // syntax-highlight (2026-10): prismjs's MIT banner (`https://prismjs.com`, kept by
    // esbuild's default legal-comments handling) would trip check-ui-dist.ts's external-URL
    // allowlist — strip legal comments from the bundle instead of widening the allowlist.
    esbuild: { legalComments: "none" },
    define: {
      __VUE_OPTIONS_API__: "false",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
      __PWH_UI_BUILD__: JSON.stringify({ version, proto: { major: PROTO.major }, commit, builtAt }),
    },
    build: {
      outDir: cspProbe
        ? resolve(here, "../../../node_modules/.cache/pwh-csp-probe")
        : resolve(here, "../../../dist/web-hub-ui"),
      emptyOutDir: true,
      target: "es2020",
      sourcemap: false, // no .map file, no sourceMappingURL comment
      assetsInlineLimit: 0, // never inline assets as data: URLs
      cssCodeSplit: false, // one external CSS file, no runtime <link> injection
      modulePreload: { polyfill: false }, // no polyfill; lazy chunks load via dynamic import()
      rollupOptions: cspProbe
        ? {
            input: {
              index: resolve(here, "csp-probe/index.html"),
              negative: resolve(here, "csp-probe/negative.html"),
              mermaid: resolve(here, "csp-probe/mermaid.html"),
              // preview-perf plan §6.1 (PB): real-component perf probe — never in the product
              // bundle (this input list only exists under --mode csp-probe).
              "preview-perf": resolve(here, "csp-probe/preview-perf.html"),
            },
            output: { chunkFileNames: provenance.chunkFileNames },
          }
        : {
            input: { index: resolve(here, "index.html") },
            // dynamic import()s code-split (e.g. the Prism chunk, the mermaid closure — no manualChunks:
            // mermaid stays lazy per diagram type, D5)
            output: { manualChunks: undefined, chunkFileNames: provenance.chunkFileNames },
          },
      reportCompressedSize: false,
    },
  };
});
