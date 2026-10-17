# X1b report — hub proxy engine (2026-10-17)

Implemented package **X1b**, against committed XA `b9832b6`, X0 `cfcc845`, X1a `8f5a495`,
`plan.md` v2 + §R1/§R2 and the main-session rulings below. Read the X1a report including
§Rework before implementation. No frozen file, hub/HTTP/main/agent wiring, dependency or commit
was changed. Other agents' `docs/dev/feishu-bot/*` work was left alone.

## Changed files (absolute paths; all NEW)

Production:

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/listener.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/forward.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/ws.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/service.ts`

Tests/support:

- `/home/bluecake/ai/pi-toolkit/tests/fixtures/proxy-upstream.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/engine-helpers.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/listener.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/forward.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/ws.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/service.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/agent-queue.test.ts`

Delivery:

- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-proxy/X1b-report.md`

## Decisions taken (main-session ruling)

1. **Existing/pending target reopens are free, even at capacity.** Synchronous parse and X1a
   canonicalization happen before instance admission. Literal aliases share `proxyTargetKey`;
   unresolved hostnames have an internal logical key made from their canonical virtual-host
   authority. An existing instance/pending creation for that key is reused without another
   reservation or DNS lookup. Only a genuinely new creation takes the synchronous global and
   per-principal capacity reservation, before DNS/listen. The X1a ports map reserves the actual
   permanent port atomically at bind, once the pinned key is known. Every creation path releases
   capacity in `finally`; rejected capacity paths never call DNS/listen/persist. Tests fill eight
   instances, reopen literal/mapped aliases successfully, refuse a ninth new target, and join a
   pending creation under a one-instance ceiling. Hostname reopens retain their original IP pin.
2. **Invalid mint after an await** (parent expiry/revoke): fail closed using the frozen
   `{ok:false,status:503,error:"E_PROXY_UNAVAILABLE",reason:"closing",retryable:true}` outcome.
   There is deliberately no new `E_AUTH` arm or deny reason. **X1c must resolve identity before
   calling the service and re-resolve/recheck on this failure, mapping a stale/revoked identity
   to 401.** An ungranted new instance is closed immediately; its durable port binding stays.
   Existing instances with already issued credentials are not stopped by a failed mint.

The plan-author consult was for design intent only, not acceptance. The main session explicitly
ruled the two points above after the consult exposed the reservation-order ambiguity.

## Implementation notes

- `createProxyService(deps)` is async and returns the frozen `ProxyService`. It awaits X1a's
  bounded map load; a broken map remains inspectable and refuses opens without rewriting it.
  Production defaults are Node DNS/fs/interfaces, `Date.now`, and X1a's unref'd timer port.
  All mutable state is per construction. Hub code never imports pi.
- One creation per logical target, one per-creation `abandoned` fence. Each `ports.bind` listen
  callback races the frozen 2s cap. Timeout/close rejects it immediately and closes its candidate.
  A physical listen that settles later closes the actual server again, even if its first close
  promise resolved before listen. Insertion into the live map rechecks the global closing fence.
- `dispose()` is irreversible/idempotent: abandon pending creations, revoke all credentials,
  cancel queued/in-flight HTTP, destroy both sides of upgraded tunnels and all inbound sockets,
  destroy Agents, and close listeners concurrently under the frozen close bound. The idle sweep
  is one cancellable, unref'd recurring timer (implemented using the injected `after` port),
  armed only while an instance exists. Idle close revokes the instance but never releases its
  permanent binding. Audit throttle state is explicitly released with `audit.forget(instanceId)` on instance close.
- Listener options, conn guard, bind policy and budgets come from frozen constants. Direct Host
  checks use canonical keys and the live LAN snapshot; forwarded headers are never trusted.
  Proxy cookies use XA's single-resolution gate with four candidates and its best-effort conflict
  clearing. Entry is one-use code → HttpOnly/Lax session cookie → safe ASCII Location/303.
  Both HTTP and raw-socket proxy errors carry the hub-equivalent strict headers and no-store.
  `TRACK` is rejected by Node's llhttp parser before `request`; the mandated `clientError` path
  destroys it. `TRACE` reaches the explicit 405 path. Neither can reach upstream.
- The HTTP admission ledger bounds active 32/128 and queued 64/256, FIFO within an instance,
  with a 10s residence deadline and Retry-After. It can service another instance while the first
  is saturated. Cancellation attaches to the **physical client socket** as well as request/
  response events: later pipelined ServerResponses do not all emit `close` on disconnect.
- Agent handoff waits for physical socket **free or actual close**, not just ClientRequest.close.
  Node emits request close before socket free, and a maxFreeSockets eviction still counts toward
  maxSockets until the socket really closes. A real-Agent instrumentation test caught a transient
  internal queue entry with a simpler deferred handoff; the final code never enters Agent.requests
  in the 96-request handoff test. Admission does not hide an unbounded Agent wait queue.
- HTTP uses only literal pinned dial coordinates, plain `http.request` (no redirect follower),
  connect/head/idle deadlines, a real 256MiB counting Transform and explicit 64KiB stream HWMs.
  Both pipelines propagate backpressure. Application responses receive only X1a filtering, not
  extra proxy security headers. Informational upstream responses are not relayed.
- WS checks its cookie and exact Origin before any upstream request, caps handshakes/tunnels
  at 32/64, and immediately arms the 10s handshake destroy deadline. That deadline is cleared
  only after writing 101; established tunnels instead use 30min socket idle timers and the
  parent-bounded session hard deadline. Frames stay opaque. Both initial heads and both pipe
  directions honor write backpressure. A rejected handshake uses the same response filter,
  removes framing length, sends at most 64KiB, and closes. Error/revoke/timeout destroys both sides.
- Per-session and per-instance counters feed X1a's whitelisted audit; no URL/path/query/headers,
  raw code/sid, exception text, or body is logged. Response bytes never touch session liveness;
  WS data uses the X1a 60s-throttled touch operation.

## Test → threat mapping

**46 new cases**, plus the existing X1a/boundary suites: **12 files / 340 tests per scoped run**.
Tests use loopback kernel-assigned ports, real HTTP/raw WS sockets and a controllable upstream;
owned sockets/listeners are destroyed in cleanup. Clock/deadline tests use X1a's manual scheduler,
not ref'd test timers. The half-header test waits for Node's real header checker.

| Tests                                                             | Threat / requirement; actual evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-H1**, `listener.test.ts`                                      | Enter/303/UTF-8-safe Location/Lax session cookie, replay 410, own-origin echo, missing/hub-only/wrong-port/other-instance sid 401 with zero upstream connections; junk candidate ignored, conflict/overflow 401 + bounded clearing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **T-H2**, listener                                                | Evil/forwarded Host 421, actual loopback/all-interface server addresses, live LAN hostname accepted then 421 after snapshot disappears. DNS rebinding/Host confinement and Q2 LAN exposure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **T-H3**, `ws.test.ts`                                            | Real upgrade/initial-head/later-frame echo; missing/null/foreign Origin and cross-port A→B with both live sessions rejected before upstream; h2c 400; 101/non-101 cookie/Clear-Site-Data/Domain filtering; non-101 body exactly capped; 33rd instance WS / 65th global WS refused; capacity released; handshake stall dies at injected 10s, established WS survives it; configured 30min timeout is asserted and its actual timeout event closes both sides; parent hard expiry, revoke/error/stop teardown; paused readers saturate writers with bounded buffers in both directions. CSWSH, cookie clobber/leak, DoS and lifecycle rows.                                                                         |
| **T-H4**, `forward.test.ts`                                       | 32/128 active and 64/256 queue ledger, FIFO, cancellation/deadline/idempotent release; 300 real pipelined requests never exceed 32 upstreams, 64 expire and 204 overflow (268 total 503 with Retry-After); queued/in-flight client disconnect cancels work; >16KiB headers 431, half headers actually destroyed in ~10–11s plus event-loop scheduling overhead; refusal 502 and slow head 504; 4MiB streaming/paused-reader cancellation; a real >256MiB upload returns 413 and upstream receives ≤cap.                                                                                                                                                                                                           |
| **T-H4**, `agent-queue.test.ts`                                   | Instrumented (not stubbed) real Agent.addRequest observes zero Agent.requests queue entries across 96 HTTP pipeline handoffs; all 96 actual upstream requests finish, admission returns to zero and free sockets remain ≤4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **T-H5**, listener + service                                      | Absolute/network-form/asterisk/CONNECT/TRACE/TRACK/reserved paths never contact upstream; foreign 302 relayed unchanged with exactly one pinned-target connection and one upstream request; hostname DNS runs once for create, not reopen or requests. SSRF/forward-proxy/redirect and DNS-rebinding rows.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **T-H6**, listener                                                | Own/absent Origin POSTs forward; foreign/null Origin or same-site/cross-site Metadata refuse before upstream. Same-site cross-port CSRF row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **T-H7**, `service.test.ts`                                       | Single listen / distinct codes, eight-of-nine atomic admission, four-per-principal cap, full-capacity reopen/pending reuse rulings, reservation release on parse/fence/DNS/listen/persist/mint failures, real failed persistence closes listener and latches broken, immutable durable binding after idle close, late listen after timeout and after dispose self-closes, owner/loopback stop, irreversible dispose, hard expiry and active-socket idle suppression. Dispose with active + queued + upgraded traffic completes <2s and restores both `/proc/self/fd` count and network-handle baseline (excluding stdio). Simulated later-startup failure calls dispose; actual startHub ownership is X1c's gate. |
| **T-A2 preparation**, listener/service + existing X1a audit tests | Captured logs exclude actual issued code/sid, query and arbitrary thrown error text; session/instance audit uses the frozen field projector. Full frontend/listener audit matrix remains X1c.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Existing X1a + `boundary.test.ts`                                 | Fence corpus, permanent bindings/atomic IO, code/session/revocation guards, response header policy, and no pi/dependency-boundary regressions, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## X1c hand-off / remaining scope

1. Construct **only when `config.proxy` exists**, **after** `frontend.listen()` returns its actual
   ports. Call `await createProxyService({ config: config.proxy, stateDir, hubPort: actualPort,
lanPort: actualLanPort /* omit when absent */, lan: config.lan !== undefined,
lanHostSnapshot: () => frontend.lanHostSnapshot?.(), log })`. The `listen`, `portsMap`, `dns`,
   `timer`, `localAddresses`, `audit` seams are internal tests only, never env/config inputs.
2. Capture `currentSeq()` **before** identity resolution. Routes pass browser Host's **host part**,
   not an authority with a port. Re-resolve/recheck identity on the retryable closing outcome
   described above and map stale/revoked identity to 401; no raw hub credentials enter proxy records.
   Refuse trusted-reverse-proxy open/stop at the route gate. LAN snapshot must be live, not captured.
3. Subscribe `service.revoke` to XA's bus only when wired, unsubscribe on close; add
   `activeConnections()` to idle accounting. `status()` exposes `{instances,reserved,portsStore}`.
4. Every normal close **and every startup failure after construction** must await `dispose()`.
   X1b supplies this cleanup; it intentionally does not modify `startHub` or HTTP route assembly.
5. No cap advertisement, API routes, hub cross-site gate or settings-to-HubConfig translation was
   added. T-H8/T-A1/full T-A2/caps-coexist/deadline nesting and real hub child T-I1 remain X1c/X3.
   Full-repository `npm test`, browser/Safari/HMR/Jupyter/NAS acceptance and restart integration
   were **not** run/claimed. WS idle uses real timeout-handler invocation with the exact configured
   30min value, not a 30-minute wall-clock wait. No unresolved frozen-interface edit is required.
6. Independent verifier acceptance remains the dispatcher’s next gate; self-verification is not
   independent acceptance. No commit, stash, checkout or reset was performed.

## Self-verification — real output

All final commands below exited **0**. The final scoped gate passed **three consecutive runs,
340/340 each** (46 new cases). Typecheck/build passed, and adjacent XA regressions passed 29/29.

During development, real tests caught and fixed the pipelined-disconnect and Agent handoff bugs
noted above. A later flakiness run exposed a **test-only** assumption that eight successful proxy
instances imply exactly eight listen attempts: an adjacent ephemeral port was occupied, so X1a
correctly skipped EADDRINUSE and made nine attempts for eight live instances. The regression now
asserts **eight live listeners and no additional listen attempts during full-capacity reopen**,
without disallowing the production-required EADDRINUSE skip. The three final runs below are after
that repair. The handle-baseline assertion excludes stdio fd 0/1/2, whose JS Socket wrappers may
be materialized lazily by Vitest; actual fd count and owned socket/server teardown are separately
asserted. No production behavior or assertion was weakened to ignore leaked network resources.

### Format (exit 0)

```sh
npx prettier --write src/web-hub/hub/proxy/{listener,forward,ws,service}.ts tests/fixtures/proxy-upstream.ts tests/web-hub/hub/proxy/{engine-helpers,listener.test,forward.test,ws.test,service.test,agent-queue.test}.ts docs/dev/web-hub-proxy/X1b-report.md
```

```text
src/web-hub/hub/proxy/listener.ts 163ms (unchanged)
src/web-hub/hub/proxy/forward.ts 77ms (unchanged)
src/web-hub/hub/proxy/ws.ts 37ms (unchanged)
src/web-hub/hub/proxy/service.ts 78ms (unchanged)
tests/fixtures/proxy-upstream.ts 18ms (unchanged)
tests/web-hub/hub/proxy/engine-helpers.ts 29ms (unchanged)
tests/web-hub/hub/proxy/listener.test.ts 63ms (unchanged)
tests/web-hub/hub/proxy/forward.test.ts 30ms (unchanged)
tests/web-hub/hub/proxy/ws.test.ts 29ms (unchanged)
tests/web-hub/hub/proxy/service.test.ts 52ms (unchanged)
tests/web-hub/hub/proxy/agent-queue.test.ts 12ms (unchanged)
docs/dev/web-hub-proxy/X1b-report.md 111ms
```

### Typecheck, build and adjacent XA regression (all exit 0)

```sh
timeout 280 npm run typecheck
timeout 280 npm run build
timeout 180 npx vitest run tests/web-hub/http/auth-identity.test.ts tests/web-hub/http/auth-revoke.test.ts
```

```text
> pi-toolkit@0.5.5 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json


> pi-toolkit@0.5.5 build
> tsc -p tsconfig.build.json


 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/http/auth-identity.test.ts (21 tests) 868ms
 ✓ tests/web-hub/http/auth-revoke.test.ts (8 tests) 1148ms
   ✓ bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes) > emits the exact {selector, reason} on all five revoke paths, and HTML caps die on each 460ms
   ✓ bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes) > LAN logout emit sequence is [before-delete, after-delete], then the SSE revoke 304ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
   Start at  15:22:12
   Duration  2.50s (transform 919ms, setup 111ms, collect 2.12s, tests 2.02s, environment 0ms, prepare 106ms)
```

### Requested scoped gate, three consecutive final runs (all exit 0)

```sh
for run in 1 2 3; do
  echo "=== X1b scoped gate run $run ==="
  timeout 900 npx vitest run tests/web-hub/hub/proxy tests/web-hub/boundary.test.ts || exit $?
done
```

```text
=== X1b scoped gate run 1 ===

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/hub/proxy/headers.test.ts (29 tests) 22ms
 ✓ tests/web-hub/hub/proxy/target.test.ts (143 tests) 43ms
 ✓ tests/web-hub/boundary.test.ts (11 tests) 90ms
 ✓ tests/web-hub/hub/proxy/sessions.test.ts (23 tests) 39ms
 ✓ tests/web-hub/hub/proxy/ports-map.test.ts (59 tests) 132ms
 ✓ tests/web-hub/hub/proxy/listener.test.ts (14 tests) 187ms
 ✓ tests/web-hub/hub/proxy/service.test.ts (14 tests) 248ms
 ✓ tests/web-hub/hub/proxy/audit.test.ts (14 tests) 89ms
 ✓ tests/web-hub/hub/proxy/ws.test.ts (10 tests) 357ms
 ✓ tests/web-hub/hub/proxy/dns-gate.test.ts (15 tests) 22ms
 ✓ tests/web-hub/hub/proxy/forward.test.ts (7 tests) 10739ms
   ✓ T-H4 HTTP budgets > header size >16KiB ⇒ 431 and half headers destroyed by 10s/1s checker 10010ms
   ✓ T-H4 HTTP budgets > real >256MiB request is cut at the counting Transform and answered 413 before response head 465ms
 ✓ tests/web-hub/hub/proxy/agent-queue.test.ts (1 test) 171ms

 Test Files  12 passed (12)
      Tests  340 passed (340)
   Start at  15:22:48
   Duration  11.69s (transform 809ms, setup 472ms, collect 1.64s, tests 12.14s, environment 2ms, prepare 697ms)

=== X1b scoped gate run 2 ===

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/boundary.test.ts (11 tests) 83ms
 ✓ tests/web-hub/hub/proxy/headers.test.ts (29 tests) 27ms
 ✓ tests/web-hub/hub/proxy/target.test.ts (143 tests) 46ms
 ✓ tests/web-hub/hub/proxy/sessions.test.ts (23 tests) 39ms
 ✓ tests/web-hub/hub/proxy/ports-map.test.ts (59 tests) 131ms
 ✓ tests/web-hub/hub/proxy/listener.test.ts (14 tests) 209ms
 ✓ tests/web-hub/hub/proxy/service.test.ts (14 tests) 254ms
 ✓ tests/web-hub/hub/proxy/audit.test.ts (14 tests) 95ms
 ✓ tests/web-hub/hub/proxy/ws.test.ts (10 tests) 367ms
 ✓ tests/web-hub/hub/proxy/dns-gate.test.ts (15 tests) 21ms
 ✓ tests/web-hub/hub/proxy/forward.test.ts (7 tests) 10773ms
   ✓ T-H4 HTTP budgets > header size >16KiB ⇒ 431 and half headers destroyed by 10s/1s checker 10009ms
   ✓ T-H4 HTTP budgets > real >256MiB request is cut at the counting Transform and answered 413 before response head 502ms
 ✓ tests/web-hub/hub/proxy/agent-queue.test.ts (1 test) 186ms

 Test Files  12 passed (12)
      Tests  340 passed (340)
   Start at  15:23:00
   Duration  11.77s (transform 824ms, setup 531ms, collect 1.71s, tests 12.23s, environment 2ms, prepare 680ms)

=== X1b scoped gate run 3 ===

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/hub/proxy/headers.test.ts (29 tests) 22ms
 ✓ tests/web-hub/boundary.test.ts (11 tests) 85ms
 ✓ tests/web-hub/hub/proxy/target.test.ts (143 tests) 47ms
 ✓ tests/web-hub/hub/proxy/sessions.test.ts (23 tests) 41ms
 ✓ tests/web-hub/hub/proxy/ports-map.test.ts (59 tests) 125ms
 ✓ tests/web-hub/hub/proxy/listener.test.ts (14 tests) 182ms
 ✓ tests/web-hub/hub/proxy/service.test.ts (14 tests) 247ms
 ✓ tests/web-hub/hub/proxy/audit.test.ts (14 tests) 83ms
 ✓ tests/web-hub/hub/proxy/ws.test.ts (10 tests) 354ms
 ✓ tests/web-hub/hub/proxy/dns-gate.test.ts (15 tests) 21ms
 ✓ tests/web-hub/hub/proxy/forward.test.ts (7 tests) 10892ms
   ✓ T-H4 HTTP budgets > header size >16KiB ⇒ 431 and half headers destroyed by 10s/1s checker 10010ms
   ✓ T-H4 HTTP budgets > real >256MiB request is cut at the counting Transform and answered 413 before response head 619ms
 ✓ tests/web-hub/hub/proxy/agent-queue.test.ts (1 test) 169ms

 Test Files  12 passed (12)
      Tests  340 passed (340)
   Start at  15:23:13
   Duration  11.85s (transform 763ms, setup 460ms, collect 1.63s, tests 12.27s, environment 2ms, prepare 679ms)
```

### Final hygiene

`npx prettier --check` on all twelve delivery files exited 0:

```text
Checking formatting...
All matched files use Prettier code style!
```

`git diff --check` exited 0. Final `git status` also showed late, out-of-package tracked UI changes
(`DetailHeader.vue`, en/zh privacy/resume i18n, `styles/detail.css`, and the detail-header-clear /
privacy-lock UI tests), in addition to the already-known `docs/dev/feishu-bot/` work. None were
written or reverted by this package; the main session was notified to attribute them. This report
lists only X1b-owned delivery files. No commit was created.
