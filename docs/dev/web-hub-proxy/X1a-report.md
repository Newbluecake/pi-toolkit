# X1a report — hub pure proxy modules (2026-10-17)

Implemented package **X1a** of `plan.md` v2 + §R1/§R2 against XA `b9832b6` and X0 `cfcc845`.
No listener/server, route, cap advertisement, or hub wiring was added. No commit was created.
All changes are NEW files in the assigned domains. Frozen X0/XA files, UI, core, agent status,
protocol messages, and other agents' working changes were not edited. Neither boundary tests nor
XA source-scan tests needed modification.

## Files (absolute paths)

Production modules:

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/target.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/headers.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/sessions.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/ports-map.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/dns-gate.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/audit.ts`

Tests/support:

- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/target.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/headers.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/sessions.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/ports-map.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/dns-gate.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/audit.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/helpers.ts`

Delivery:

- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-proxy/X1a-report.md`

## Implementation / decisions

1. **One canonical address representation**: `canonicalAddr` returns bytes, IP version, and a
   normalized unbracketed IP `key`. IPv4-mapped IPv6 unwraps to the SAME IPv4 key, including hex
   and expanded forms. Legacy IPv4 numeric/octal/hex/short forms normalize defensively here, but
   `parseProxyTarget` rejects them **before admission**. Shared canonical keys drive the address
   fence, self-port comparison, pinned dial address, and permanent binding key.
2. **Grammar**: explicit TCP port 1–65535, no leading zero; bare `host:port` / `[v6]:port`, or
   `http://host:port[/path?query]`. No implicit port, bare-host path suffix, userinfo, Unix socket,
   zone id, or non-HTTP scheme. Hostname syntax delegates to the existing `classifyHostToken`
   function; no extra shared constants/types were imported from that module. `localhost` maps
   directly to `127.0.0.1` without DNS. Optional HTTP next-path is sanitized separately, never URL-
   normalized before the strict authority check. Unsafe paths fall back to `/`.
3. **SSRF tables** live in `target.ts`, as X0 explicitly delegated. Exact metadata IP
   `169.254.169.254` returns `metadata`; other `169.254/16` addresses return `link-local`.
   Metadata hostname exact matches (case-insensitive, before DNS): `metadata`,
   `metadata.google.internal`, `metadata.goog`, `instance-data`, `instance-data.ec2.internal`,
   `metadata.azure.internal`. RFC1918/loopback/CGNAT/ULA exclusions and NAT64/6to4/compatible-v6
   denials follow §3.1. All reasons/classes use the frozen protocol vocabulary.
4. **DNS**: `createProxyDnsGate` takes a lookup port and optional scheduler. One physical lookup,
   no queue. A busy/zombie slot returns the existing `dns-timeout` reason (no new deny reason).
   Timeout never releases the slot before real settlement. `resolveProxyTarget` checks every
   answer, returns first denied reason when all are denied, otherwise `mixed-answer`; picks first
   IPv4, else first IPv6; returns literal `pinnedIp` and no request-time lookup hook. The self-port
   port takes the actual bound hub/LAN ports, configured proxy range, and fresh local interfaces.
5. **Sessions**: injected `now`/random bytes, no timers or IO. Records copy only the allowed parent
   identity fields, never `AuthIdentity.sid` or `.lan`. Secrets are 32-byte base64url values; only
   SHA256 hashes are stored, compared with `timingSafeEqual`. Code first presentation consumes it
   even on origin/instance/cap failure. Session `hardAt` is copied from mint, not extended at
   exchange. Parent expiry, code expiry, revocations and ring gaps are rechecked at exchange.
   HTTP start slides every time; WS data slides at most once/60s; response bytes have no touch API.
   Per-instance/global caps refuse without eviction. Lazy expiry/revoke destroys all registered
   sockets and tolerates throwing teardown observers.
6. **Revocations**: AuthIdentity/AuthRevokeEvent are imported through frozen `hub/ports.ts`.
   `ProxyRevokeEvent` is a LOCAL superset adding `{instanceId}`; XA types were not widened.
   Tombstones snapshot selectors. `seq0 < oldestSeq - 1` is a gap: the first retained event's
   immediate predecessor still has a complete history. Mint/exchange gap returns the frozen 503
   `revocation-gap` outcome. A normal invalid/expired/revoked credential is an INTERNAL
   `{ok:false, kind:"invalid"}` result, not a new wire deny reason/error code.
7. **Ports map**: injected fs/clock/scheduler, loaded once (64 KiB / 1s), write queue bounded by the
   frozen 16-instance ceiling, one physical fs operation at a time. Schema remains v1
   `{v,entries:[{key,port,boundAt}]}`. Unknown fields, duplicate key/port, noncanonical/invalid key,
   nonregular file, invalid UTF8, wrong version, out-of-range entries or IO error fail closed.
   Capacity equals configured range size (up to 256), per X0-report decision 2, not hard-coded 50.
   A narrower changed range with historical entries outside it refuses rather than discarding
   bindings. Known targets reuse without rewriting; foreign-process occupancy never relocates them.
8. **Durable commit boundary**: `bind(key, listen)` reserves lowest available port, invokes an
   injected bounded listener factory, skips only new-target `EADDRINUSE` (at most 8 attempts), then
   writes temp → chmod 0600 → write → fsync → close → rename → directory fsync → close before
   returning success to a code issuer. Failed persistence closes the listener, releases runtime
   reservation and latches broken. No old binding is evicted. Only temp files this operation
   actually created may be unlinked; never an EEXIST file or the committed map.
9. **IO deadlines**: ports-map's internal budgets remain the X0-approved exception (not protocol
   additions). Each write's 2s caller budget includes its wait for the physical write lane.
   Timeout latches broken and fences subsequent IO steps, including late completions; real work
   retains its lane until settlement. A failed transaction latches broken BEFORE releasing the
   real tail to queued transactions. A rename already in flight may finish, but its resulting map
   is never cleared and no code is issued. The only production timeout helper unrefs its timers.
10. **Headers**: one response filter for ordinary HTTP, WS 101, and WS non-101. Hop-by-hop and
    Connection-listed fields are stripped; WS explicitly reconstructs Upgrade/Connection. Request
    forwarded headers are replaced, not appended. Every `pwh_*` request cookie and response
    Set-Cookie is stripped; app cookie Domain attributes removed; upstream Clear-Site-Data dropped.
    Same-target absolute HTTP and network-path Location/Content-Location references rewrite the
    authority, including loopback aliases and normalized `:80`; foreign/relative references stay.
11. **Audit**: field-whitelisted projection from frozen protocol arrays, with runtime validation of
    values as well as keys. Never accepts a request/error object as a log record. Only normalized
    IP:port, hostname, principal identifiers, hashed instance tag, counters and frozen reason tokens
    reach logs. Denial throttle is bounded and per instance/60s; `forget` releases it on shutdown.
12. **Design-intent consult only**: plan author `r_N0H10HCQ` confirmed strict input versus defensive
    canonicalization, metadata exact-match policy, local internal APIs and internal IO budgets.
    No new deny reason/error code, TargetWire/Class change, or ports.json shape change was needed.
    The author was not asked to validate/pass this implementation.

## Threat → test mapping

All new tests live under the exclusive `tests/web-hub/hub/proxy/` domain. T-F1's corpus is inline
in `target.test.ts` instead of adding the plan's illustrative shared-fixture path outside this domain.
Tests use deterministic clocks, scripted DNS/fs seams, unique deterministic secrets, and real
filesystem roundtrips; no network listeners or fake always-pass assertions.

| Threat / requirement                                                                                                               | Tests / actual assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSRF to public/metadata, IPv4 alternate spelling, mapped IPv6, NAT64/6to4/compatible-v6, unspecified/link-local/reserved/multicast | **T-F1** `target.test.ts` (131): canonical bytes + exact class/reason; grammar rejects legacy forms and socket/userinfo/scheme/zone inputs; metadata hostnames; actual fallback/LAN/proxy self-port keys including interface/mapped aliases                                                                                                                                                                                                                                                                                 |
| DNS rebinding/mixed answers and lookup DoS                                                                                         | **T-F2** `dns-gate.test.ts` (15): all-answer fence, all-denied ordering, IPv4 preference, mapped unwrapping; pinned literal dial coordinates without per-request lookup; timeout retains single slot until real settle; sync/async errors; zero DNS for literal/localhost/metadata; unref/cancel helper                                                                                                                                                                                                                     |
| Hub-cookie leakage/clobber, hop/forwarded header injection, Clear-Site-Data, redirect escape                                       | **T-F3** `headers.test.ts` (23) plus safeOriginForm corpus in target tests: exact request header output, app-only cookies, Domain stripping, HTTP/101/non-101 drops, full same/foreign/relative absolute/network-path Location matrix, default port and IPv6 aliases                                                                                                                                                                                                                                                        |
| Code replay, foreign origin/instance, parent expiry, silent session lifetime extension                                             | **T-F4** `sessions.test.ts` (22): hash-only records, first-use consume even on failure, TTL exact boundaries, hard=min(12h,parent) and mint-time anchor, full 12h activity cannot extend hard limit, idle/touch throttling and socket destruction                                                                                                                                                                                                                                                                           |
| Caps evict an existing valid credential; revocation loss/gap/delete window                                                         | T-F4: actual 16/16 and independent global 128 limits, old credentials still valid; every XA selector + instance selector, seq-before-authorize, selector snapshot, 257-event ring gap → 503, XA two-emit eventual revocation; cleanup despite observer/socket throws; no timer/IO source and runtime assertions                                                                                                                                                                                                             |
| Origin reused across targets, failed persistence, race/lost updates, IO starvation                                                 | **T-F5** `ports-map.test.ts` (45): restart-sticky reuse; lowest unmapped; new vs known EADDRINUSE; eight-attempt cap; permanent exhaustion vs transient reservations; real 0600/atomic fsync order; no code before successful commit; eight failure stages preserve old bindings and close/release; corrupt/unreadable/duplicate bytes untouched; EEXIST temp not deleted; concurrent binds + max physical IO=1; load/write/after-rename timeout + late completion fences; queued writer cannot start after earlier failure |
| Logs expose path/url/query/header/cookie/code/sid or exception text                                                                | **§7 pure/T-A2 preparation** `audit.test.ts` (12): exact field whitelist, forbidden-field and allowed-field smuggling attempts, canonical IPs/principal shape, hashed instance ID, frozen resource reasons, bounded 60s throttle, errno-only helper, logger exception isolation                                                                                                                                                                                                                                             |
| Boundary regression / accidental pi import or extra cookie parser                                                                  | Existing `boundary.test.ts` (11) and XA auth source-scan/regressions (29), all unchanged and passing                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Integration handoff (X1b/X1c, not implemented here)

- Resolve targets with `resolveProxyTarget(input, dnsGate, selfPorts)`; keep its `pinnedIp`, `key`,
  `target.hostHeader` and class. Populate selfPorts from the **actual** frontend listen result and
  current interfaces, not settings' requested port.
- Await `portsMap.load()` at service startup; expose broken status. `portsMap.bind` takes a listener
  factory and returns `{port,value,reused}` ONLY after durable commit. X1b owns the listener's 2s
  deadline, per-creation `abandoned` fence and bounded server shutdown. The map never constructs
  a listener itself. Same-target service single-flight happens before `bind`; its defensive
  duplicate admission returns `port-busy` rather than introducing an unbounded wait queue.
- Capture session `currentSeq()` before identity resolution. `mintCode(seq0, identity, ...)` checks
  again at insertion. Issue no link on any failure. `exchange` returns raw sid only to the cookie
  writer; use frozen `proxyCookieName(port)` and XA's gate candidate resolver in X1b. Proxy store
  does not parse hub cookies or build HTTP responses.
- `lookup` defaults to HTTP-start touch; use `{touch:false}` for WS gate auth and `touch(rec,"ws")`
  only for WS data. Register/deregister inbound/upstream sockets via `attach`/`detach`. X1b owns
  active deadlines, sweeps, queue/upstream cancellation and socket close hooks.
- Reuse the SAME response filter for 101 and rejected handshakes; set `ws:true` only when a 101 is
  actually being emitted. Call audit `forget(instanceId)` when the instance closes.
- `ProxyCredentialFailure.kind:"invalid"` is internal; exchange maps it to the frozen expired-link
  response. Resource/gap failures already carry frozen statuses/codes/reasons. X1a adds no wire API.

## Verification

Only package-scoped and adjacent XA tests were run; full-repository `npm test`, engine/wiring
T-H1…T-H8/T-A1/T-I1, and real-browser acceptance are intentionally not claimed. They belong to later
packages/main-session integration. No blocking implementation issue or required frozen edit was
found. Independent verifier acceptance remains the dispatcher's next gate.

Captured command outputs follow below.

### 1. Format (exit 0)

```sh
npx prettier --write src/web-hub/hub/proxy/{target,headers,sessions,ports-map,dns-gate,audit}.ts tests/web-hub/hub/proxy/{helpers,target.test,headers.test,sessions.test,ports-map.test,dns-gate.test,audit.test}.ts docs/dev/web-hub-proxy/X1a-report.md
```

```text
src/web-hub/hub/proxy/target.ts 146ms (unchanged)
src/web-hub/hub/proxy/headers.ts 55ms (unchanged)
src/web-hub/hub/proxy/sessions.ts 58ms (unchanged)
src/web-hub/hub/proxy/ports-map.ts 61ms (unchanged)
src/web-hub/hub/proxy/dns-gate.ts 16ms (unchanged)
src/web-hub/hub/proxy/audit.ts 16ms (unchanged)
tests/web-hub/hub/proxy/helpers.ts 7ms (unchanged)
tests/web-hub/hub/proxy/target.test.ts 27ms (unchanged)
tests/web-hub/hub/proxy/headers.test.ts 19ms (unchanged)
tests/web-hub/hub/proxy/sessions.test.ts 58ms (unchanged)
tests/web-hub/hub/proxy/ports-map.test.ts 95ms (unchanged)
tests/web-hub/hub/proxy/dns-gate.test.ts 22ms (unchanged)
tests/web-hub/hub/proxy/audit.test.ts 21ms (unchanged)
docs/dev/web-hub-proxy/X1a-report.md 101ms
```

### 2. Typecheck (exit 0)

```sh
timeout 280 npm run typecheck
```

```text
> pi-toolkit@0.5.5 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### 3. Requested scoped tests (exit 0)

```sh
timeout 600 npx vitest run tests/web-hub/hub/proxy tests/web-hub/protocol/proxy.test.ts tests/web-hub/boundary.test.ts
```

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/boundary.test.ts (11 tests) 83ms
 ✓ tests/web-hub/hub/proxy/headers.test.ts (23 tests) 21ms
 ✓ tests/web-hub/hub/proxy/audit.test.ts (12 tests) 17ms
 ✓ tests/web-hub/hub/proxy/target.test.ts (131 tests) 40ms
 ✓ tests/web-hub/hub/proxy/dns-gate.test.ts (15 tests) 22ms
 ✓ tests/web-hub/hub/proxy/sessions.test.ts (22 tests) 37ms
 ✓ tests/web-hub/hub/proxy/ports-map.test.ts (45 tests) 73ms
 ✓ tests/web-hub/protocol/proxy.test.ts (75 tests) 32ms

 Test Files  8 passed (8)
      Tests  334 passed (334)
   Start at  14:22:35
   Duration  845ms (transform 936ms, setup 534ms, collect 1.77s, tests 325ms, environment 1ms, prepare 535ms)
```

### 4. Build (exit 0)

```sh
timeout 280 npm run build
```

```text
> pi-toolkit@0.5.5 build
> tsc -p tsconfig.build.json
```

### 5. Adjacent XA/source-scan regression (exit 0)

```sh
timeout 180 npx vitest run tests/web-hub/http/auth-identity.test.ts tests/web-hub/http/auth-revoke.test.ts
```

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/http/auth-identity.test.ts (21 tests) 868ms
 ✓ tests/web-hub/http/auth-revoke.test.ts (8 tests) 1074ms
   ✓ bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes) > emits the exact {selector, reason} on all five revoke paths, and HTML caps die on each 419ms
   ✓ bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes) > LAN logout emit sequence is [before-delete, after-delete], then the SSE revoke 303ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
   Start at  14:22:34
   Duration  2.40s (transform 897ms, setup 136ms, collect 1.97s, tests 1.94s, environment 0ms, prepare 129ms)
```

Final requested gate: **8 files / 334 tests passed** (248 new pure-module cases + 86 existing protocol/boundary cases).
Additional XA regression: **2 files / 29 tests passed**. Typecheck and build both exited 0.
The initial corpus run had two test-only failures from wrapping an already mapped IPv6 address a second time;
the mapped recheck now uses its canonical IPv4 key, and the complete final command above passes.

No outstanding X1a implementation blocker. Full-suite, independent-verifier and runtime/browser gates remain
explicitly outside this self-verification scope.

### Final hygiene

All 14 new delivery files were checked with `npx prettier --check` (exit 0):

```text
Checking formatting...
All matched files use Prettier code style!
```

`git diff --check -- src/web-hub/hub/proxy tests/web-hub/hub/proxy docs/dev/web-hub-proxy/X1a-report.md`
exited 0 with no output; these are new/untracked files, so the explicit Prettier check above is
the meaningful formatting guard. Scoped `git status --short` contains only the two new directories
and this new report. No existing file was edited by X1a.

## §Rework — independent-verifier rejection (2026-10-17)

The original submission above was **REJECTED** by the independent verifier. This section is the
latest implementation/self-verification record; it supersedes the earlier descriptions of raw
Unicode paths, serialization-capacity failures, audit overflow, cookie case handling, and literal
Host/key spelling. Independent re-acceptance is still the dispatcher's next gate, not claimed here.

### Changed files in this rework (absolute)

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/target.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/headers.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/ports-map.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/audit.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/target.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/headers.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/ports-map.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/audit.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/sessions.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-proxy/X1a-report.md`

No frozen/XA files, wiring, listeners, UI files or other agents' work were edited. No dependency,
commit, stash, checkout or reset was introduced.

### Findings → repairs → regression evidence

| User finding                                                        | Repair                                                                                                                                                                                                                                                                                                                                                                              | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — MAJOR: Unicode Location throws after consuming a code**       | `safeOriginForm` UTF-8 percent-encodes every byte ≥ 0x80, retaining only 0x21–0x7e. UTF-8 conversion replaces lone surrogates with U+FFFD instead of throwing. Raw controls/backslash, dangerous encoded bytes, malformed `%` escapes and leading network-path forms remain rejected. The output's encoded byte length also obeys the existing 2048-byte cap.                       | Target corpus asserts exact encoded outputs for `/日本`, `/?q=é`, U+2028, high/low lone surrogates and emoji, then checks ASCII-only output AND real Node `http.validateHeaderValue("Location", result)`. Target parsing of `http://localhost:80/日本` and `http://localhost:80?q=é` is covered. A session test mints/exchanges a Unicode nextPath, verifies the code is consumed, checks the exact returned Location and validates it with Node. |
| **2 — serialized map >64 KiB must not permanently break the store** | Capacity is tested inside the serialized write lane BEFORE any persistence IO. An oversized candidate returns this call's existing `ports-store` refusal normally, rather than throwing/latching broken. The failed listener closes, runtime reservations release, and old bindings stay usable. Actual corrupt/oversized reads and real IO failures still fail closed permanently. | A real >64 KiB candidate on a loaded, near-limit map preserves its bytes and leaves status `ok`; an existing binding reuses its old port. A reduced-budget concurrent test refuses a large candidate but allows a queued smaller candidate to commit, with no lost bindings or leaked reservation.                                                                                                                                                |
| **3 — full audit throttle permanently hides new ids**               | Expired entries are pruned by the 60s timestamp window on denial insertion. New ids are always logged. The existing bounded table is retained: if churn exceeds the live-instance ceiling inside one window, the oldest throttle entry is retired rather than dropping the new log event. `forget` is optional cleanup, not required for logging to recover.                        | 1000 distinct ids over time without `forget`, immediate duplicate suppression, expiry re-admission, and a separate 1000-id same-window burst all assert actual log-call counts. Overflow may retire old suppression state, but never silently suppresses a new id.                                                                                                                                                                                |
| **4 — pwh\_ prefix case-insensitive both directions**               | Request cookie-pair names and response Set-Cookie names are lowercased for the reserved-prefix comparison. Original app cookie spelling/values remain intact.                                                                                                                                                                                                                       | Mixed-case `PWH_LAN`, `PwH_px_7900`, `pWh_other` and `PWH_` are removed in request/response paths, including WS filtering. Nonreserved `App` / `xpwh_keep` survive. The old case-sensitive expectation was replaced.                                                                                                                                                                                                                              |
| **5 — reject UTF-8 BOM / duplicate JSON keys**                      | UTF-8 decoding explicitly preserves a BOM for rejection instead of silently stripping it. Strict parsing rejects it and scans valid JSON tokens for per-object duplicate decoded property names, including escaped aliases such as `"v"` vs `"\u0076"`. JSON.parse never silently overwrites a binding before validation.                                                           | BOM and root/entry duplicates, escaped root/port duplicates, and duplicate `entries` that would otherwise replace a populated map with `[]` all produce broken status and preserve original bytes. A unique escaped root key remains valid.                                                                                                                                                                                                       |
| **7 — mapped IPv6 and IPv4 need one key/port and canonical Host**   | Literal `hostHeader` is derived from the shared canonical IP, not the user's spelling. The key helper normalizes literal authority spelling too. Hostname virtual-host authorities remain names.                                                                                                                                                                                    | `[::ffff:7f00:1]:80`, dotted mapped and expanded mapped forms share `127.0.0.1                                                                                                                                                                                                                                                                                                                                                                    | 80                                                                                                                                                                                                                                                                                                                                                | 127.0.0.1` with IPv4, get one durable binding/port and one write, and reuse it after restart. Non-default ports and compressed native IPv6 authorities are covered. Request-header filtering asserts the actual canonical upstream Host. Strict v1 parsing refuses now-noncanonical historical keys rather than silently merging/reassigning old ports. |
| **9 — Referer exactly equal to origin**                             | Exact equality and the existing `<origin>/` prefix both rewrite to the target origin; foreign and near-prefix values still stay unchanged.                                                                                                                                                                                                                                          | Request-header test checks exact-origin Referer without trailing slash, path/query Referer, Origin and foreign/null/near-prefix negatives.                                                                                                                                                                                                                                                                                                        |
| **State directory symlink**                                         | Open `proxy/` itself with `O_DIRECTORY                                                                                                                                                                                                                                                                                                                                              | O_NOFOLLOW` before loading a map. At persistence, open/check it again BEFORE opening any temp file, and hold that directory handle through the final directory fsync. No new fs-port method or frozen schema field was needed.                                                                                                                                                                                                                    | Real-fs tests cover a symlinked directory with and without ports.json, plus substitution after load but before bind: no temp file is opened, target bytes remain unchanged, listener closes and the store refuses. Injected late-directory-open tests cover both load/write timeout cleanup with no subsequent IO and physical outstanding IO ≤1. |

The directory checks reject symlinks present at load / before temporary-file creation. They do not
claim a new fd-relative/openat defense against an adversarial local rename _after_ that check;
no wider local-filesystem threat model or new platform dependency is introduced in this rework.
The same 64 KiB/1s/2s internal budgets and frozen protocol constants/types remain in force.

### Rework self-verification scope

The requested scoped gate now has **8 files / 369 passing tests** (283 pure-module cases + 86
existing protocol/boundary cases), including 35 additional cases since the rejected submission.
Adjacent XA/source-scan regression has **2 files / 29 passing tests**. Typecheck and build both
exit 0. Full-repository tests, X1b/X1c runtime integration and browser acceptance are not claimed.
The captured command output below is from this rework, not the rejected submission's earlier run.

#### Rework format — exit 0

```sh
npx prettier --write src/web-hub/hub/proxy/{target,headers,ports-map,audit}.ts tests/web-hub/hub/proxy/{target,headers,ports-map,audit,sessions}.test.ts docs/dev/web-hub-proxy/X1a-report.md
```

```text
src/web-hub/hub/proxy/target.ts 151ms (unchanged)
src/web-hub/hub/proxy/headers.ts 57ms (unchanged)
src/web-hub/hub/proxy/ports-map.ts 80ms (unchanged)
src/web-hub/hub/proxy/audit.ts 19ms (unchanged)
tests/web-hub/hub/proxy/target.test.ts 38ms (unchanged)
tests/web-hub/hub/proxy/headers.test.ts 20ms (unchanged)
tests/web-hub/hub/proxy/ports-map.test.ts 130ms (unchanged)
tests/web-hub/hub/proxy/audit.test.ts 18ms (unchanged)
tests/web-hub/hub/proxy/sessions.test.ts 61ms (unchanged)
docs/dev/web-hub-proxy/X1a-report.md 135ms
```

#### Rework typecheck — exit 0

```sh
timeout 280 npm run typecheck
```

```text
> pi-toolkit@0.5.5 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

#### Rework requested tests — exit 0

```sh
timeout 600 npx vitest run tests/web-hub/hub/proxy tests/web-hub/protocol/proxy.test.ts tests/web-hub/boundary.test.ts
```

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/boundary.test.ts (11 tests) 86ms
 ✓ tests/web-hub/hub/proxy/headers.test.ts (29 tests) 29ms
 ✓ tests/web-hub/hub/proxy/dns-gate.test.ts (15 tests) 35ms
 ✓ tests/web-hub/hub/proxy/target.test.ts (143 tests) 46ms
 ✓ tests/web-hub/hub/proxy/sessions.test.ts (23 tests) 54ms
 ✓ tests/web-hub/hub/proxy/audit.test.ts (14 tests) 93ms
 ✓ tests/web-hub/hub/proxy/ports-map.test.ts (59 tests) 147ms
 ✓ tests/web-hub/protocol/proxy.test.ts (75 tests) 32ms

 Test Files  8 passed (8)
      Tests  369 passed (369)
   Start at  14:48:28
   Duration  853ms (transform 955ms, setup 498ms, collect 1.75s, tests 522ms, environment 1ms, prepare 533ms)
```

#### Rework build — exit 0

```sh
timeout 280 npm run build
```

```text
> pi-toolkit@0.5.5 build
> tsc -p tsconfig.build.json
```

#### Rework XA/source-scan regression — exit 0

```sh
timeout 180 npx vitest run tests/web-hub/http/auth-identity.test.ts tests/web-hub/http/auth-revoke.test.ts
```

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/web-hub/http/auth-identity.test.ts (21 tests) 893ms
 ✓ tests/web-hub/http/auth-revoke.test.ts (8 tests) 1093ms
   ✓ bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes) > emits the exact {selector, reason} on all five revoke paths, and HTML caps die on each 428ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
   Start at  14:48:28
   Duration  2.44s (transform 878ms, setup 115ms, collect 2.03s, tests 1.99s, environment 0ms, prepare 131ms)
```

Rework self-gate: **PASS — 369/369 scoped tests, 29/29 XA regressions, typecheck/build/format exit 0**.
No unresolved implementation blocker was found in this rework. Independent verifier re-acceptance
remains pending; no commit was made.
