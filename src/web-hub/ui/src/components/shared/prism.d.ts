/**
 * Ambient module declarations for prismjs (syntax-highlight package, 2026-10). prismjs
 * ships no TypeScript types and the user ruled the package.json change is prismjs ONLY (no
 * `@types/prismjs`), so the lazily-loaded `highlight-impl.ts` works against these minimal
 * structural declarations instead. Only the surface `HighlightedCode.vue` touches
 * (`languages` lookup + `tokenize`) is typed; the token TREE itself is structurally typed
 * by `@logic/highlight.js`'s `flattenTokens`, which never imports prism.
 */

declare module "prismjs" {
  /** Structural subset of the Prism namespace — `tokenize` returns the (string | Token)[] tree. */
  interface PrismLike {
    readonly languages: Record<string, unknown>;
    tokenize(text: string, grammar: unknown): unknown[];
  }
  const Prism: PrismLike;
  export default Prism;
}

declare module "prismjs/components/*" {
  /** Side-effect-only modules: each registers its grammar onto the global `Prism`. */
}
