/**
 * Prism core + the `globalThis.Prism` bridge (syntax-highlight package, 2026-10).
 *
 * Prism's language components are plain CJS scripts that reference the BARE identifier
 * `Prism` (their IIFE parameter), i.e. a global — `prismjs`'s own `global.Prism = Prism`
 * line only runs when the CJS `global` shim exists, which a Vite ESM build does NOT
 * guarantee. So this module sets the global explicitly, and `highlight-impl.ts` imports
 * THIS module first: ESM evaluation order (depth-first, import-statement order) then
 * guarantees the global exists before any `prismjs/components/*` module executes. The same
 * holds under vitest (happy-dom), where `window`/`globalThis` is the test global.
 *
 * Only ever imported from `highlight-impl.ts`, which is itself only dynamically imported —
 * nothing here reaches the main bundle.
 */
import Prism from "prismjs";

(globalThis as { Prism?: unknown }).Prism = Prism;

export default Prism;
