/**
 * Vite config for the web-hub Vue SPA (vue-plan.md v2.1 §1.1–§1.2, §4.4.1, §5.2 — P0 frozen).
 *
 * Two build modes, one config (so the CSP probe tests the exact same plugin/define/build
 * pipeline the real production bundle uses):
 *  - default (`npm run build:web`): entry `index.html`, output `dist/web-hub-ui/`,
 *    `build-info-plugin.ts` writes the manifest, single inlined JS chunk.
 *  - `--mode csp-probe` (`npm run probe:csp`, §4.4.1): entries
 *    `csp-probe/{index,negative}.html`, output `node_modules/.cache/pwh-csp-probe/`
 *    (already `.gitignore`d via `node_modules/`), no `build-info.json` (that plugin is
 *    skipped), no `public/` copy (the probe doesn't need `theme-init.js`/favicon).
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
import { buildInfoPlugin, readPackageVersion, resolveCommit } from "./build-info-plugin.js";
import { PROTO } from "../protocol/version.js";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  const cspProbe = mode === "csp-probe";
  const [version, commit] = await Promise.all([readPackageVersion(), resolveCommit()]);

  return {
    root: cspProbe ? resolve(here, "csp-probe") : here,
    base: "/",
    publicDir: cspProbe ? false : "public",
    plugins: [vue(), ...(cspProbe ? [] : [buildInfoPlugin()])],
    resolve: { alias: uiAliases },
    define: {
      __VUE_OPTIONS_API__: "false",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
      __PWH_UI_BUILD__: JSON.stringify({ version, proto: { major: PROTO.major }, commit }),
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
      modulePreload: { polyfill: false }, // single chunk, no polyfill needed
      rollupOptions: cspProbe
        ? {
            input: {
              index: resolve(here, "csp-probe/index.html"),
              negative: resolve(here, "csp-probe/negative.html"),
            },
          }
        : {
            input: { index: resolve(here, "index.html") },
            output: { manualChunks: undefined, inlineDynamicImports: true }, // single JS chunk
          },
      reportCompressedSize: false,
    },
  };
});
