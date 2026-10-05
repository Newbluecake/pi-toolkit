/**
 * Hand-written mirror of `src/web-hub/protocol/http-contract.ts` (plan §包 E).
 *
 * P5b 打回点 4: `SSE_EVENTS`/`API_ERRORS` now import + re-export the SAME array the TS protocol
 * module exports (via the `@protocol` alias `aliases.ts` already wires into both `vite.config.ts`
 * and the repo-root `vitest.config.ts`) instead of hand-copying it — a browser-facing `.js` module
 * CAN import a `.ts` module through Vite/esbuild's bundler resolution (this repo's `allowJs`+
 * `moduleResolution: "Bundler"` already supports it; `http-contract.ts` itself only pulls in
 * `messages.js`'s TYPES, never its runtime typebox import, so nothing extra reaches the browser
 * bundle), so there is no "drift" left to catch — the two names are now literally one array.
 * `tests/web-hub/ui/logic-contract.test.ts` asserts `toBe` (same reference), not just `toEqual`.
 * `API`/`SILENCE_MS`/`HISTORY_LIMIT_MAX` below have no protocol-module counterpart (frontend-only
 * constants, or — for `API.session`/`API.logout` — S1 LAN-only endpoints) and stay hand-written.
 *
 * Constraint worth spelling out: the specifier has to keep the literal `.ts` extension
 * (`@protocol/http-contract.ts`, not the usual NodeNext `.js` convention this repo otherwise
 * uses everywhere else) — Vite/esbuild only applies its TS-extension-remapping fallback
 * (`./foo.js` → `./foo.ts`) for a `.ts`/`.vue` IMPORTER; a plain `.js` importer's `./foo.js`
 * specifier resolves literally and 404s when only `foo.ts` exists (confirmed empirically: both
 * `vitest run` and the real `vite build` fail with `ENOENT ... http-contract.js` otherwise).
 * Spelling the extension out as `.ts` sidesteps that — both the real build and vitest resolve it
 * correctly — without renaming this file (would cascade: `password-client.js`/`token-client.js`
 * also import `./contract.js` as a plain `.js`→`.js` sibling, the same broken direction).
 */
import { API_ERRORS as PROTOCOL_API_ERRORS, SSE_EVENTS as PROTOCOL_SSE_EVENTS } from "@protocol/http-contract.ts";
import { PREVIEW_PATH } from "@protocol/preview.ts";
import { UPLOAD_ABORT_PATH, UPLOAD_BEGIN_PATH, UPLOAD_CHUNK_PATH, UPLOAD_COMMIT_PATH } from "@protocol/upload.ts";

/** SSE `event:` names pushed by the hub (order irrelevant, set must match) — same array as
 * `protocol/http-contract.ts`'s `SSE_EVENTS`, not a copy. */
export const SSE_EVENTS = Object.freeze(PROTOCOL_SSE_EVENTS);

/** Error codes returned by `/api/*` as `{ error: code }` — same array as
 * `protocol/http-contract.ts`'s `API_ERRORS`, not a copy. */
export const API_ERRORS = Object.freeze(PROTOCOL_API_ERRORS);

/** Endpoints the P1 (read-only) frontend talks to; `logout`/`session` are LAN-only (S1, package LF).
 * The four `/api/upload/*` paths (web-hub-upload plan §1.2, package U4b) are imported from the
 * protocol module — same anti-drift rule as `SSE_EVENTS`/`API_ERRORS` above: the hub's routes
 * (`hub/upload-http.ts`) and this object can never disagree. */
export const API = Object.freeze({
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
  events: "/api/events",
  subscribe: "/api/subscribe",
  unsubscribe: "/api/unsubscribe",
  history: "/api/history",
  cmd: "/api/cmd",
  dialog: "/api/dialog",
  uploadBegin: UPLOAD_BEGIN_PATH,
  uploadChunk: UPLOAD_CHUNK_PATH,
  uploadCommit: UPLOAD_COMMIT_PATH,
  uploadAbort: UPLOAD_ABORT_PATH,
  // web-hub-spawn plan SP11 / arch §8.2: the headless-spawn endpoints. Hand-written literals —
  // `protocol/spawn.ts` (SP1) freezes the BODY/record types but has no path constants to mirror
  // (same situation as `session`/`logout` above); `tests/web-hub/ui/logic-contract.test.ts`
  // pins both literals. `headlessDirs` is GET-only in S1 (`?path=` ⇒ 400 browse-unavailable);
  // the stop endpoint is `${headless}/<spawnId>/stop` (built at the call site).
  headless: "/api/headless",
  headlessDirs: "/api/headless/dirs",
  // web-hub-preview plan v3 §4.1 (PV4): the single content-preview endpoint, imported from
  // `protocol/preview.ts` — same anti-drift rule as the upload paths above.
  preview: PREVIEW_PATH,
  // @文件补全 (file-mention): the composer's file-search endpoint. Hand-written literal, NOT
  // imported from `hub/file-search.ts` — that module is hub-side (imports `node:fs*`) and must
  // never reach the browser bundle; `tests/web-hub/ui/logic-file-mention.test.ts` pins this
  // literal against the hub constant instead.
  filesSearch: "/api/files/search",
  // web-hub-fleet-drawer plan §3.1 (F0): the three run-transcript endpoints. Hand-written
  // literals, NOT imported from `protocol/run-transcript.ts`: that module also carries the
  // typebox frame schemas, and importing it here would drag `@sinclair/typebox` into the
  // browser bundle (the same reason `http-contract.ts` above pulls only `messages.js`'s
  // TYPES). `tests/web-hub/ui/logic-contract.test.ts` pins both literals against `RUN_API`.
  runSubscribe: "/api/run/subscribe",
  runUnsubscribe: "/api/run/unsubscribe",
  runHistory: "/api/run/history",
});

/** Client-side SSE silence limit: no frame (hub pings every 15s) for this long ⇒ reconnect. */
export const SILENCE_MS = 45_000;

/** `/api/history` page size cap enforced by the hub. */
export const HISTORY_LIMIT_MAX = 400;
