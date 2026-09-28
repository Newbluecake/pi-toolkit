/**
 * Shared path aliases for the Vue UI build (vue-plan.md v2.1 §1.1, §1.3, §5.2 — P0 frozen).
 *
 * `vite.config.ts` (the SPA build) and the repo-root `vitest.config.ts` (unit/component
 * tests) both import this so `@logic` / `@protocol` resolve identically in both — a single
 * source of truth for the alias targets.
 *
 * - `@logic` → `src/web-hub/web/` through P0–P4 (the untouched legacy pure-logic modules the
 *   new UI reuses read-only, e.g. `state.js`, `contract.js`, `token-client.js`). P5b's
 *   `git mv` to `src/web-hub/ui/src/logic/` changes only this one target (its授权例外 —
 *   plan §5.2); no UI source file re-imports through a different path.
 * - `@protocol` → `src/web-hub/protocol/` (the frozen wire-contract module, e.g.
 *   `http-contract.ts`, `messages.ts`, `ui-manifest.ts`).
 *
 * Paths are resolved relative to this file's own location (`fileURLToPath` off
 * `import.meta.url`), never the caller's cwd, so the same aliases hold whether this is
 * imported from `src/web-hub/ui/vite.config.ts` or the repo-root `vitest.config.ts`.
 */
import { fileURLToPath } from "node:url";

/** `src/web-hub/ui/src/logic/` */
export const LOGIC_DIR = fileURLToPath(new URL("./src/logic", import.meta.url));

/** `src/web-hub/protocol/` */
export const PROTOCOL_DIR = fileURLToPath(new URL("../protocol", import.meta.url));

/** Vite/vitest `resolve.alias` record — pass through as-is (`resolve: { alias: uiAliases }`). */
export const uiAliases: Record<string, string> = {
  "@logic": LOGIC_DIR,
  "@protocol": PROTOCOL_DIR,
};
