# Package XA report — unified auth identity + revocation bus (2026-10-17)

Plan: `docs/dev/web-hub-proxy/plan.md` v2 + §R2 (§4.1, §4.2, §8 XA tests, §R1 #2/#4/#6/#7, §R2 #4/#6). Prerequisite: HTML preview P1b (f1a4e43). Not committed.

## Changed files

NEW

- `src/web-hub/hub/auth-identity.ts` — the ONLY cookie parser in `hub/`: `readCookie` (moved), `cookieCandidates`, `resolveCookieIdentity` (async, LAN) / `resolveCookieIdentitySync` (loopback), `AuthIdentity` / `IdentityResult` / `LanSessionResult` types, `lanRecordValid`, `loopbackIdentity` / `lanIdentity` builders, `clearingSetCookies` / `pathPrefixes` (best-effort clearing lines), caps `LOOPBACK_COOKIE_MAX=8`, `LAN_COOKIE_MAX=3`, `PROXY_GATE_COOKIE_MAX=4` (reserved).
- `src/web-hub/hub/auth-revoke.ts` — `createAuthRevokeBus(log)`: synchronous `emit`, subscription order, per-subscriber try/catch (logs reason + error only, never the selector), snapshot-safe subscribe/unsubscribe.
- `tests/web-hub/http/auth-identity.test.ts` (21 tests), `tests/web-hub/http/auth-revoke.test.ts` (8 tests).

MODIFIED

- `src/web-hub/hub/auth.ts` — `Auth.resolve(header, now, {maxCandidates})` → `{ok,sid,sidTag,expiresAt}|{ok:false,conflict?}`; `check` = `resolve().ok`; slides only the chosen session; `readCookie` re-exported from auth-identity.
- `src/web-hub/hub/lan-auth.ts` — `readLanCookie` removed; `checkLanSession` rebuilt on new `resolveLanSession` (`maxCandidates` option, default 1); `LanSessionCheck` gains `absoluteExpiresAt`.
- `src/web-hub/hub/http.ts` — bus + `multiCandidateAuth` option (`FrontendIdentityDeps`), `authorizeLoopback`/`resolveLoopbackIdentity`, `requireLanSession` on the resolver (returns `LanAuthed = LanSessionResult & {identity}`), `sendCookieConflict`, all revoke sites on the bus, `subscribeAuthRevoke` duck-typed extra, `LanRuntime.authRevoke` / `lanCookieMax`.
- `src/web-hub/hub/hub.ts` — only `HttpFrontendExt.subscribeAuthRevoke?` type (for X1c).
- `tests/web-hub/http/pv-lan-kit.ts` — `startLanPv({multiCandidateAuth})` + `fe.subscribeAuthRevoke` typing.
- Not touched: `preview/routes.ts` (no wiring change needed — its `revokeHtmlCaps` is subscribed from `http.ts`), `ports.ts`, AGENTS.md, `tests/integration/web-hub-pv-starvation.test.ts`.

## Migrated call sites (`src/web-hub/hub/http.ts`)

16 executing loopback `auth.check` calls → `authorizeLoopback(req, res)` (identity resolved once; 401 / conflict answered inside):
`/api/headless*` 3136 · `/api/load/top` 3148 (principal from identity) · `/api/version` 3155 (principal from identity) · `/api/preview` 3170 · `/api/preview/probe` 3185 · `/api/preview/html-cap` 3201 (**sidTag = `identity.sidTag`**, no cookie re-read) · `/api/files/search` 3217 · wtdiff 3237 · wtgraph 3256 · `/api/agents/remove` 3272 · avatar 3295 · privacy lock 3313 · `/api/cmd`+`/api/dialog` 3330 · `/api/upload/*` 3352 · generic POST (subscribe…) 3400 · generic GET (events/history) 3411.
`grep 'auth\.check(' http.ts` has no executing hit (pinned by a source-scan test).

LAN: `requireLanSession` (resolver, 1401–1441; all ~25 callers unchanged, now also get `session.identity`); LAN HTML-cap authorize takes `sidTag/userId` from `session.identity`; `/api/load/top` + `/api/version` LAN principals from `identity.principal` (= `u<userId>`, identical keys); `checkLanSession` (lan-auth.ts, no src caller — dead export, migrated anyway).
Logout: loopback 3387–3390 and LAN 1949–1960 use `cookieCandidates` (same module). Cookie parsing elsewhere: none (`readCookie(`/`readLanCookie` scan test).

Revoke sites → `bus.emit` 1:1 in place/order: LAN logout before (1956) and after (1959) `await deleteSession`, then `lanSse.revoke`; loopback logout after `auth.logout` (3390); facade `revoke` (3017, before `lanSse.revoke`); `revokeAll` (3026); `revokeAllSse` (3573). Preview subscribed unconditionally right after `previewRoutes` is bound.

## Deviations / decisions

1. **`multiCandidateAuth` lives on `FrontendIdentityDeps = FrontendDeps & {…}` (http.ts), not `FrontendDeps`** — `ports.ts` is X0's frozen file and outside this package's domain. Default off. X1c should pass it when `config.proxy` and may promote it into ports.ts. Same for the `AuthIdentity`/`AuthRevokeEvent` types (live in auth-identity.ts / auth-revoke.ts; plan puts them in ports.ts via X0).
2. Loopback `principal` is now the session `sidTag` (was the raw sid in `loopback:<sid>:load-top|version` limiter keys) — 1:1 mapping, no behaviour change, raw sid no longer in an identity field that proxy code will copy. LAN principal `u<userId>` unchanged.
3. Logout is not an authenticated route: legacy mode logs out the FIRST cookie value exactly as before (valid or not, and emits for it); multi-candidate mode logs out EVERY distinct candidate (≤ max) so a conflict never blocks logout.
4. Multi-candidate details beyond the plan text: exact-duplicate values collapse before counting; empty values are ignored (only in multi mode; legacy keeps "empty first value = no cookie"); a second distinct valid candidate stops further `touchSession` IPC; LAN candidates share one `authDeadlineMs` budget; a thrown validator (429 busy / 503 db) fails the whole request closed.
5. `dispatchCmdOrDialog`'s second `authorize()` (the §6.3 step-⑥ recheck) is deliberately still a fresh resolution — that re-auth IS the rotate/revoke guard, not an identity re-read.
6. Conflict response: 401 `{"error":"E_AUTH","reason":"cookie-conflict"}` + clearing `Set-Cookie`s (≤8 path prefixes × {host-only, `Domain=<host>`}, `Secure` on LAN https; IPv6/odd hosts get no Domain line). Best-effort only; manual-recovery UI copy belongs to the UI package (not in XA).
7. §4.3 P4 `/api` cross-site gate is NOT in XA's domain here (user: gate + proxy-specific belong to later packages); no `crossSiteGate` flag added.
8. Eventual revocation (§R2 #6) needed no new store logic: the existing double emit + preview store semantics hold; tested rather than strengthened.

## XA tests (plan §8) → where

- bus order incl. LAN double emit then SSE, five-path exact events + caps die with no proxy, throwing subscriber (pure + real frontend), unconditional preview subscription, §R2 #6 delete-await window → `auth-revoke.test.ts`.
- single-resolution source scan, HTML-cap sidTag = authenticating sid with junk-first shadow (loopback + LAN, option on), conflict/overflow exact clearing set, non-segment-Path / parent-Domain shadow not named ⇒ conflict persists, LAN 1 valid + 2 junk ≤3 IPC / 4 candidates ⇒ 0 IPC, attacker-valid sid ⇒ conflict never swap, proxy-off first-value (valid-first ok, junk-first byte-identical 401 `{"error":"E_AUTH"}` with no Set-Cookie, one `touchSession`), logout in conflict → `auth-identity.test.ts`.

## Self-verification (real output)

- `npx prettier --write` (all changed files) then `--check`: `All matched files use Prettier code style!`
- `timeout 280 npm run typecheck` → tsc ×2 + vue-tsc, exit 0, no output.
- `timeout 900 npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/integration/web-hub-*.test.ts` →
  `Test Files  239 passed (239)` · `Tests  4377 passed | 4 skipped (4381)` · `Duration 214.06s`.
  (An earlier full run had one failure, `api-upload.test.ts … (c) crash ⇒ recover()` — a timing-sensitive test under load while another agent was running; passes alone 45/45 and in the final full run. Not related to XA.)

## Leftovers for later packages

- X1c: pass `multiCandidateAuth: true` when `config.proxy`; `subscribeAuthRevoke` for `proxyService.revoke`; unsubscribe on close; P4 gate; `lanHostSnapshot()` extra.
- UI: cookie-conflict manual-recovery copy.
- `LanRuntime` test double in `lan-sse-verifiedat.test.ts` omits `authRevoke` (only exercises the recheck path; untyped there) — harmless, left as is.
