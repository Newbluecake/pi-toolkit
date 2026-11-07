/**
 * Bare specifiers the esbuild bundle leaves EXTERNAL (startup-bundle plan r3 §3.5).
 *
 * Kept in a plain .mjs file (not TS) so both the build script and the tests can import it:
 * - `scripts/build-bundle.mjs` feeds it to esbuild's `external`;
 * - `tests/core/bundle-entry.test.ts` asserts it equals the runtime hook map
 *   (`HOST_SPECIFIERS` in `src/core/host-modules.ts`) — the two must never drift, or the bundle
 *   would load a specifier the dispatcher cannot pin to the host copy.
 *
 * Every non-`node:` entry here must have a `HOST_SPECIFIERS` counterpart. `node:*` is external
 * because Node's own resolution already returns the same builtin module for bundle and host.
 */
export const BUNDLE_EXTERNALS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@sinclair/typebox",
  "@sinclair/typebox/value",
  "node:*",
];
