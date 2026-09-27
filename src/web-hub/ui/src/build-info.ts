/**
 * Runtime build metadata (vue-plan.md v2.1 §1.2, §3.11, §5.2 — P0). Reads the `__PWH_UI_BUILD__`
 * constant `vite.config.ts`'s `define` bakes in at build time (declared in `env.d.ts`) —
 * byte-identical `{ version, proto, commit }` to what `build-info-plugin.ts` writes into
 * `dist/web-hub-ui/build-info.json`, so the two never drift. P3's `TopBar.vue` / the P1
 * version-mismatch banner (§3.11) read this to compare against the `hub` SSE frame's
 * `buildId` (`<version>@<commit>`).
 */

export interface UiRuntimeBuild {
  readonly version: string;
  readonly proto: { readonly major: number };
  readonly commit: string;
}

export const UI_BUILD: UiRuntimeBuild = __PWH_UI_BUILD__;
