/// <reference types="vite/client" />

/**
 * Ambient declarations for the web-hub Vue UI (vue-plan.md v2.1 §1.1, §5.2 — P0 frozen).
 */

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * Injected by `vite.config.ts`'s `define` (`build-info-plugin.ts` writes the byte-identical
 * `build-info.json` alongside it — see `src/build-info.ts` and `protocol/ui-manifest.ts`).
 */
declare const __PWH_UI_BUILD__: {
  readonly version: string;
  readonly proto: { readonly major: number };
  readonly commit: string;
  readonly builtAt: string;
};
