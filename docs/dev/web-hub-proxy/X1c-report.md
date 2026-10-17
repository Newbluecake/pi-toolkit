# X1c report — hub wiring (2026-10-17)

Package **X1c** of `docs/dev/web-hub-proxy/plan.md` (v2 + §R1/§R2), against committed XA `b9832b6`, X0 `cfcc845`,
X1a `8f5a495`, X1b `72c3d86`, UI X2 `df9b3a4`. No commit. The X1b follow-up agent's files
(`hub/proxy/{service,forward}.ts`, `tests/web-hub/hub/proxy/{engine-helpers,service.test,forward.test}.ts`,
`X1b-report.md`) were left strictly alone — their parallel edits appear in `git status` but are not mine.
No frozen file was edited.

## What changed (absolute paths)

New production

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/routes.ts` — `createProxyRoutes({service(), log, now?})` → the frozen `ProxyRoutes`
  (`POST /api/proxy/open`, `GET /api/proxy`, `POST /api/proxy/stop`). Late-bound service (routes exist at frontend construction, the service
  after `listen()`).
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/config.ts` — `normalizeHubProxyConfig(value, {hubPort, lanPort?})` (pure): strict
  re-validation of `HubConfig.proxy` + the second line of the port-collision veto.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/proxy-status.ts` — pure `/webhub status` formatter (`formatProxyStatusLines`, `ProxyHubStatus`).

Modified production

- `src/web-hub/protocol/http-contract.ts` — `API_ERRORS` TAIL-append `E_PROXY_DENIED`, `E_PROXY_UNAVAILABLE`.
- `src/web-hub/hub/http.ts` — see "http.ts" below.
- `src/web-hub/hub/hub.ts` — see "hub.ts" below.
- `src/web-hub/hub/main.ts` — `normalizeHubProxyConfig` drop-the-key + stderr warn (after the LAN normalization so a dropped LAN never vetoes).
- `src/web-hub/agent/index.ts` — `WebHubSettings.proxy?` folded in; `buildHubConfig` translation; `control.proxy?.statusLines()`;
  `WebHubDeps.proxyWarnings?`; `hub.json.proxy` structural read-back.
- `src/config/settings.ts` — X0's `AgentWebHubSettings & {proxy?}` intersection dropped (`WebHubSettings = AgentWebHubSettings`);
  new `loadWebHubProxyWarnings(path?)` (read-only second read of the raw block, same contract as `loadWebHubLanSettingsWarnings`).

**Files outside the stated domain I had to touch (minimal, each needed to make the declared deliverable reachable):**
`src/web-hub/hub/hub-json.ts` (type-only: `HubRecord.proxy?: {portsStore}`), `src/commands/webhub.ts` (3 lines: print `control.proxy?.statusLines()`;
`WebHubControl.proxy?` is optional so every pre-feature control double still compiles), `src/index.ts` (4 lines: capture the raw-block
warnings once at activate, only when `webHub.proxy.enabled`, and pass `proxyWarnings`), and two tail pins in
`tests/web-hub/protocol/{preview,worktree-diff}.test.ts` (the exact-`API_ERRORS`-tail assertions that the mandated tail-append must
update). Flag in review if you prefer a different split.

### http.ts

- **Dispatch**: loopback `handleApi` and the LAN `/api` branch, right after the headless branch, only when `deps.proxy` exists; `ProxyRouteIo`
  built per request (loopback: Host host-part; LAN: `ctx.hostKey` host-part, `ctx.viaTrustedProxy`). `resolveIdentity` wraps the existing
  single resolvers (`authorizeLoopback` / `requireLanSession`), which already answer 401 / cookie-conflict / 429 / 503 themselves — the route
  only fills in a plain response when nothing was written.
- **`crossSiteGate` (P4, §4.3)** and **candidate max** (loopback 8 / LAN 3) are armed by exactly one thing: `deps.proxy !== undefined`
  (`FrontendIdentityDeps` also gains an explicit `crossSiteGate?` flag, mirroring XA's `multiCandidateAuth?`, for tests). Pure exported
  `apiCrossSiteOk(req, expectedOrigin)`; loopback skips `OPTIONS` (exact legacy 404, no ACAO), LAN already threw 404 for OPTIONS earlier.
  Runs before any cookie is read, `403 E_CSRF`.
- **Live `lanHostSnapshot()`** duck-typed extra on the frontend: `lanClosed ? undefined : handle?.current()` (undefined whenever the LAN
  listener is down/closed), never captured.
- `statusFor` knows the two new codes (403 / 503); the routes answer their own explicit statuses.

### hub.ts

- Routes created only when `config.proxy`, passed to the frontend as `proxy`. Service built **after** `fe.listen()` with the ACTUAL
  `httpPort`, `lanPort: config.lan?.port` (LAN has no port fallback), `lan: config.lan !== undefined`, live `lanHostSnapshot`, `stateDir`,
  `log`, `now`; via `startupStep(…, late => late.dispose())`.
- Caps tail-appended to the shared `extraHubCaps` (both surfaces): `proxy.v1` iff `config.proxy`, `proxy.lan.v1` iff `config.proxy && config.lan`.
  STATIC, like `privacy.v1` — never follows whether the LAN listener actually came up.
- Revocation: `fe.subscribeAuthRevoke(ev => service.revoke(ev))`, unsubscribed in `close()` and in the cleanup array.
- Idle: `sse: fe.clientCount() + proxyService.activeConnections()`.
- Dispose: `close()` unsubscribes then `await bounded(proxyService.dispose())` before `fe.close()`; the cleanup array (push right after
  construction ⇒ reverse order ⇒ before `fe.close()`) covers every startup failure after construction. `proxyService` / `unsubscribeProxyRevoke`
  are declared with the early bindings (close() is hoisted and can run before the assembly point).
- **Degrade, not fail**: a construction failure (cannot happen on the documented paths; `ports.load()` reports `broken` instead of throwing)
  logs `{code}` only, leaves the routes answering 503 `closing`, and never fails the hub; an aborted startup rethrows so a late service is disposed.
- `hub.json.proxy = {portsStore:"ok"|"broken"}` on the first write; the 5 s registry tick rewrites the in-memory record on a real change
  (runtime persist failure latches `broken`). Key absent ⇒ hub.json byte-identical.

### Route behaviour (routes.ts) — X1b hand-off points, followed exactly

1. Construction conditions as above (hub.ts).
2. `seq0 = service.currentSeq()` before `resolveIdentity`; `browserHost` = host part only; reverse-proxy `open`/`stop` ⇒ 409
   `E_PROXY_UNAVAILABLE{reverse-proxy}` at the route gate (audited through the whitelisted `proxy-open` event, throttled to one line per
   60 s; `list` stays allowed). `closing` + `retryable:true` ⇒ identity re-resolved: failure ⇒ 401 (resolver may already have answered the
   cookie-conflict), `revokedSince(seq0, identity) === true` ⇒ 401, otherwise 503 `closing` with `Retry-After`. Service absent ⇒ 503 `closing`.
3. Revocation subscribe/unsubscribe + idle accounting + `status()` (→ hub.json) as above.
4. `dispose()` on close and on every startup failure after construction (tests below).
5. The remaining items of the list (caps, routes, P4, settings translation) are all in.

- Budget: the route hands `resolveIdentity` a fresh `WRITE_TOTAL_MS` (13 s) so LAN auth keeps its full `LAN_AUTH_CAP_MS` exactly like `/api/cmd`
  (an 8 s budget would have squeezed it to 1 s); pinned in `deadline-nesting.test.ts`.
- Per-principal bucket 10 + 1/6 s (open AND stop share it), lazily pruned at 512 principals, no timers. Body ≤ 2 KiB, `{target}` / `{instanceId}`
  (grammar-checked) else 400 `E_BAD_REQUEST`; reader `HttpError`s keep their status/code.
- Mapping: deny reasons keep the service's frozen status/pair; `E_RATE`/503 `E_PROXY_UNAVAILABLE` carry `Retry-After: 1`; 409 `E_LIMIT` and 4xx don't.
  Never throws (500 `E_INTERNAL`; log carries only a code).
- **X1b-verifier notes honoured/mapped**: listen errors surface as `port-busy` (503 `E_PROXY_UNAVAILABLE`), a DNS _throw_ surfaces as `closing`
  **without** `retryable` (so no identity re-resolve — the UI shows the generic "unavailable" copy); only `closing`+`retryable:true` triggers
  the identity recheck.

### Settings / status

- `buildHubConfig`: `config.proxy = {portRange:[lo,hi], maxProxies}` only when `webHub.proxy.enabled ∧ control !== false` (unparsable range ⇒
  key omitted); `enabled`/LAN never cross the wire. `main.ts` drops a malformed or hub/LAN-port-overlapping key (stderr), including the DEFAULT
  range overlapping `webHub.port` (X0's "second-line veto").
- `/webhub status` lines (English tokens inline, Chinese prose): `proxy: on · lan|loopback · <range> · max <n>`; one prose warning per
  `parseWebHubProxyBlock` warning (`port-range-invalid|port-range-overlap|max-proxies-invalid`); `未挂载端口代理` when hub.json exists without
  the key; the `ports.json` recovery note (path, `/webhub stop` first, forget-bindings disclosure) on `broken`; one warning for `control:false`.
  Settings off ⇒ silent.

## Test map

| Plan item                  | Where                                                                                                                                                            | What is asserted (real behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-H8** proxy off         | `tests/web-hub/http/proxy-wiring.test.ts`                                                                                                                        | No cap; the three routes answer byte-for-byte like an unknown `/api` path (loopback and LAN); no listener on the range; no `<stateDir>/proxy`; no `hub.json.proxy`; P4 unarmed (cross-site headers ⇒ 200); candidate max 1 (junk-first cookie ⇒ first-value 401, no Set-Cookie)                                                                                                                                                                                                                                     |
| T-H8 LAN off / on          | same                                                                                                                                                             | `proxy.v1` only vs `+proxy.lan.v1`; loopback-only bind proven via `127.0.0.2` refused vs `0.0.0.0` accepted; 0600 `ports.json` with the real entry; `hub.json.proxy`; policy block; LAN open uses the LAN request host; **live LAN snapshot** (LAN host ⇒ passes Host gate, `evil` ⇒ 421, after `hub.lan.close()` ⇒ 421, loopback names still fine — skipped only on machines without a non-loopback IPv4)                                                                                                          |
| T-H8 trusted reverse proxy | same                                                                                                                                                             | Real trusted-proxy LAN (`trustProxyFrom:127.0.0.1`, https externalOrigin): `open` and `stop` ⇒ 409 `reverse-proxy`, `list` ⇒ 200, nothing persisted                                                                                                                                                                                                                                                                                                                                                                 |
| T-H8 real fallback port    | same                                                                                                                                                             | Occupied configured port ⇒ random bound port ⇒ proxy to it is 403 `self-port`; the occupied (foreign) port is allowed; the proxy range is self-port                                                                                                                                                                                                                                                                                                                                                                 |
| restart / same port        | same                                                                                                                                                             | Same state dir ⇒ same target gets the SAME port; the old gate cookie ⇒ 401                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ports store broken         | same                                                                                                                                                             | Corrupt `ports.json` ⇒ `hub.json.proxy.portsStore:"broken"`; file bytes untouched                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| revocation                 | same                                                                                                                                                             | hub logout and LAN logout kill the proxy session (next request 401, upstream untouched)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **T-A1**                   | same                                                                                                                                                             | Both listeners: valid cookie × {Origin = proxy origin, `same-site`, `cross-site`, both, `Origin: null`} × 10 loopback / 8 LAN endpoints (GET+POST) ⇒ 403 `E_CSRF`, never ACAO, upstream untouched, session survives the refused `/api/logout`; legit (no headers / `same-origin` / `none` / `localhost` spelling) passes; `OPTIONS` with a foreign Origin ⇒ exact 404, no ACAO on both listeners; WS upgrade to hub/LAN ports never 101; `apiCrossSiteOk` unit matrix                                               |
| §4.1 armed                 | same                                                                                                                                                             | Junk-first cookie accepted; 9 candidates ⇒ 401 `cookie-conflict` + clearing Set-Cookie, and the proxy route returns that single response                                                                                                                                                                                                                                                                                                                                                                            |
| **T-A2**                   | `proxy-redaction.test.ts`                                                                                                                                        | Real hub.log after open/enter/HTTP/redirect/hostile headers/denials/WS ok+403/refused opens/rate-limit/LAN open/stop/logout: none of {codes, hub+gate+LAN sids, hub token, paths, queries, host markers, header names, body, cookie words} appears; every `proxy-open`/`proxy-end` line only has whitelisted keys; audit lines exist (non-vacuous); a second test checks route failures never log target/error text                                                                                                 |
| hub lifecycle              | `proxy-lifecycle.test.ts`                                                                                                                                        | Not constructed when off; constructed after listen with the actual hub port / lanPort / `lan` / config; `dispose` awaited exactly once on close (listener gone) and on a startup failure AFTER construction (and the disposed service refuses opens); never constructed on a failure before it; construction failure degrades (503, caps static, no hub.json key, no stack in log); revocation subscribed live then unsubscribed on close; idle `sse` count includes a held proxied request and returns to baseline |
| routes unit                | `tests/web-hub/hub/proxy/routes.test.ts`                                                                                                                         | seq0-before-identity ordering, CSRF/auth ordering, resolver-answered vs unanswered failures, reverse-proxy refusal (+audit, stop), body/grammar/HttpError mapping, every failure shape + Retry-After, `closing`+`retryable` re-resolve (stale ⇒ 401, revoked ⇒ 401, live ⇒ 503, non-retryable ⇒ no re-resolve), service-absent, bucket refill/isolation, never-throws                                                                                                                                               |
| config / status / settings | `hub/proxy/config.test.ts`, `agent/proxy-status.test.ts`, `agent/wiring-proxy.test.ts`, `config/web-hub-proxy-warnings.test.ts`, `commands/webhub-proxy.test.ts` | normalization + veto matrix; formatter cases; `PI_WEBHUB_CONFIG` byte-identical when off, exact wire shape when on, `control:false` omission; `control.proxy.statusLines()` against real hub.json files; `/webhub status` printing & levels                                                                                                                                                                                                                                                                         |
| caps-coexist               | `hub/caps-coexist.test.ts`                                                                                                                                       | off / proxy / proxy+lan / lan-only: both surfaces set-equal and order-equal, `proxy.v1` is the tail, `proxy.lan.v1` adjacent iff `config.lan`, proxy-off baseline is exactly the prefix                                                                                                                                                                                                                                                                                                                             |
| deadline-nesting           | `hub/deadline-nesting.test.ts`                                                                                                                                   | LAN auth keeps its cap under `WRITE_TOTAL_MS`; auth cap + DNS + listen + persist ≤ `WRITE_TOTAL_MS` ≤ UI `PROXY_CLIENT_TIMEOUT_MS`; close bound ≤ hub step cap                                                                                                                                                                                                                                                                                                                                                      |
| contract                   | `proxy-wiring.test.ts` + the two tail pins                                                                                                                       | `API_ERRORS` ends with the two new codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Shared harness: `tests/web-hub/http/proxy-kit.ts` (REAL `startHub` + `createHttpFrontend` + fake LAN store + the upstream fixture + hub.log reader).

## Self-verification (real output)

```
$ npx prettier --check <all touched files>                      → All matched files use Prettier code style!
$ timeout 280 npm run typecheck                                  → tsc ×2 + vue-tsc, exit 0, no output
$ timeout 900 npx vitest run tests/web-hub tests/config tests/commands tests/integration/web-hub-*.test.ts
   Test Files  545 passed (545) · Tests  11078 passed | 4 skipped (11082)
$ vitest run proxy-wiring + proxy-lifecycle + proxy-redaction, three consecutive runs → 33/33 each
$ timeout 300 npm run build                                      → tsc -p tsconfig.build.json, exit 0
```

One earlier full run had a single `lan-preview-html.test.ts` failure (`listen EADDRINUSE` on a LAN port picked by the harness while other agents'
tests ran) — passes alone and in the final full run; unrelated. The first run also surfaced the two exact-tail `API_ERRORS` pins (fixed above).

## Hand-off to X3

- **T-I1 real hub child** (`tests/integration/`): build on `proxy-kit`'s shape but spawn `hub/main.ts` through pi's jiti-cli with
  `PI_WEBHUB_CONFIG.proxy = {portRange:[lo,hi], maxProxies}`. Assert: open/WS/stop through the real process; `/webhub stop` (SIGTERM path, `close()` →
  `dispose()`) closes the listeners; after a restart the SAME target gets the same port and the old cookies get 401 (the in-process version of this
  is `proxy-wiring.test.ts` "hub restart"); a `main.ts`-level veto (`config.proxy.portRange` containing `config.port`) starts the hub with NO proxy
  (stderr line `dropping config.proxy: portRange overlaps webHub.port (…)`, no cap, `/api/proxy*` 404) — `main.ts` is not importable from vitest
  (`void main()`), so this is only reachable through a child process.
- **acceptance.md** (real-browser, §10): the wiring-level facts it can rely on: `proxy.v1` on token auth, `proxy.lan.v1` on password auth; (A)-set
  header behaviour is 403 `E_CSRF` from the P4 gate; (B)-set (headers absent) passes the gate by design and is bounded by P1/P2/P3; manual-recovery
  copy for `cookie-conflict` is a UI concern (X2) — verify it is shown; `/webhub status` lines are the operator-visible surface for a broken store.
- **AGENTS.md paragraph (web-hub section)** — suggested text:

  > **Port proxy (web-hub-proxy plan v2 + §R1/§R2, `webHub.proxy`, default off; non-live)**: `webHub.proxy.{enabled,portRange,maxProxies}` →
  > `HubConfig.proxy` only when enabled ∧ `control !== false` (key absence IS off: no service, routes, caps, `/api` cross-site gate, candidate
  > max or disk — hub byte-identical). `hub/main.ts` re-validates through `hub/proxy/config.ts` and drops the key on a malformed value or a range
  > overlapping `webHub.port`/`webHub.lan.port`. `hub.ts` builds `createProxyService` AFTER `fe.listen()` with the ACTUAL bound ports and a LIVE
  > `lanHostSnapshot`, awaits `dispose()` on close and on every later startup failure, subscribes `service.revoke` to XA's auth-revocation bus,
  > counts proxied sockets as idle `sse`, and mirrors `portsStore` into `hub.json.proxy`. Routes (`hub/proxy/routes.ts`: `POST /api/proxy/open`,
  > `GET /api/proxy`, `POST /api/proxy/stop`) capture `seq0` before identity resolution, refuse the trusted reverse proxy (409 `reverse-proxy`),
  > re-resolve identity on a retryable `closing`. Caps `proxy.v1` / `proxy.lan.v1` (iff `config.lan`) are static. Wiring `deps.proxy` arms the
  > §4.3 P4 gate (`Sec-Fetch-Site ∉ {same-origin,none}` or `Origin` ≠ listener ⇒ 403 `E_CSRF`, OPTIONS untouched) and §4.1 multi-candidate cookies.
  > Design: `docs/dev/web-hub-proxy/{plan,X0…X1c-report,acceptance}.md`.

## Leftovers / notes for review

- Since the X1b follow-up (66ac97d) a DNS throw reports `dns-failed` (400 `E_PROXY_DENIED`, frozen pair, passed through by the route); only other unexpected errors still report `closing` (plain 503). Post-verification main-session fixes: trusted-reverse-proxy refusal now happens before the per-principal bucket is charged (open and stop), and the browser host part keeps IPv6 brackets (`proxyBrowserHost`).
- The status line shows the settings' effective range; if `main.ts` dropped the key (overlap veto) the `未挂载` warning appears only when hub.json
  exists, and the veto reason itself is only on the hub process's stderr (no hub log exists yet at that point in `main.ts`, same as every other key).
- A runtime ports-store latch is mirrored to hub.json within 5 s (tick), not instantly.
- Skipped on hosts without a non-loopback IPv4: the single live-LAN-snapshot Host test (`it.skipIf`).
