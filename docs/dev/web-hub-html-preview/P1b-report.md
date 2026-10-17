# P1b report — hub wiring (web-hub-html-preview plan v2 + §R2)

## Changed files (absolute)

Source (all inside the P1b domain):

- NEW `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/preview/pv-routes.ts` — `createPvRoutes`: store + PV IO gate composition, bounded FIFO queue, `servePv`, `serveWrapper`, §3 header builders, `readHtmlCapBody`, `PreviewHtmlDeps` (test seams), bounded `dispose`.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/preview/routes.ts` — `PreviewRoutesDeps.html?`, `handleHtmlCap` (mint), `revokeHtmlCaps`/`servePv`/`serveWrapper` attached only when `html` is set, dispose chain.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts` — dispatch (loopback + LAN), `sidTag`/`userId` in the two mint authorize closures, the four revoke hooks, `requestFailedFields` at the three fallback log sites.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts` — `htmlEnabled`, `PREVIEW_HTML_HUB_CAP` in `extraHubCaps`, `html: {}` dep.

Tests / fixtures:

- NEW `tests/web-hub/http/{api-preview-html,lan-preview-html,pv-log-redaction}.test.ts`, helpers `tests/web-hub/http/{pv-kit,pv-lan-kit}.ts`, fixture tree `tests/fixtures/pv-site/`.
- Additions: `tests/web-hub/hub/caps-coexist.test.ts` (T-H11 block), `tests/web-hub/hub/hub-preview.test.ts` (existing exact cap-order assertions gain `preview.html.v1`), `tests/web-hub/hub/preview/source-scan.test.ts` (+`pv-routes.ts` in KERNEL_FILES — same as P1a did for its files; the "expected file set" assertion fails otherwise).

P0/P1a files, `ui/**` untouched.

## The five P1a-verifier checks + §R2 (file:line)

1. **Real uploadsRoots into D2** — `routes.ts:1051` `resolveUploadsRoots` (the routes' real `uploadsRoot`, literal AND canonical via the PV gate; cached only when every realpath resolved) → `routes.ts:1300-1302` `dirTooBroad(boundDir, denyCtx, uploadsRoots)`. Test: "P1a check #1" (symlinked spelling of an uploads dir ⇒ 403 `dir-too-broad`; needs a non-denylisted uploads root, harness option `uploadsRootRel` — the default `webHubUploadsDir` lives under the agent dir and the admitter's denylist already refuses it earlier).
2. **Denylist on the bound dir at mint** — `routes.ts:1306` `denyListHit(boundDir)` (+ `isVirtualFsPath`). Test: `kubeconfig/page.html` (entry admitted, dir basename denied) ⇒ 403 `denylist`.
3. **Query string stripped before parsing /pv rest, never logged** — dispatch passes the already query-stripped `path` (`http.ts:1447/1454`, `3357/3364`); `pv-routes.ts:383` / `:549` additionally cut at `?`/`#` defensively; no log line carries rest/rel/url (`requestFailedFields`, `http.ts:328`). Tests: `?x=../../etc/passwd` ⇒ 200; T-H15.
4. **seq0 before authorize, mintChecked the single sync check-then-insert** — `routes.ts:1164` `seq0 = store.revokeSeq()` immediately before `io.authorize`; `routes.ts:1348-1351` `closing/aborted` check + `mintChecked(seq0, …)` in the same tick (every await — fstat, uploads roots, pin, closeEntry, dir fstat — precedes it). T-H16b is mutation-verified: moving `seq0` after authorize makes it fail.
5. **Lease for the whole admission + stream** — `pv-routes.ts:314/322` `store.lease` at dequeue (immediate or pump), held until `lease.release()` in the `finally` at `:475` after `admitPvFile` (`:418`) and `readAndStream` (stream owns/closes the file fh; the lease signal is combined with the client-abort signal). `endCap`/`revoke` therefore only close the dir fd after release (store refcount). Also: stream receives `sample: Buffer.alloc(0)` (`pv-routes.ts:443`).

- **§R2 / revoke hooks** — logout loopback `http.ts:3309`; LAN logout `:1876` (before the awaited delete) and `:1879` (after it — closes the window of a mint whose authorize ran in between); facade `revoke` `:2919` (real passwd path: `admin.handlePasswd → deps.lan()?.revoke({userId})`) and `revokeAll` `:2928`; loopback `revokeAllSse` `:3492`; `dispose` ⇒ `store.dispose()` (= revoke "all", `pv-routes.ts` `dispose`).

## §3/§4 notes

- Loopback dispatch: `http.ts:3357-3370` after `allowedHost` and the `/api` branch, before static; LAN: `:1447-1460` in the non-`/api` branch before `rt.ui.serve`, gated `rt.preview.mode === "on"` and method presence. Mint: loopback `:3086`, LAN `:1586` beside the probe, same gates.
- Caps: `hub.ts:355` `htmlEnabled = config.preview !== undefined && previewProcFdAvailable()`; `:398` cap on the one shared array (both surfaces); `:1152` `html: {}` ⇒ methods attached iff the cap is. Absent ⇒ no new member exists, every existing route byte-identical (T-H11 + "html:false" LAN/loopback fall-through test).
- `/pv` answers use a private plain responder (no `sendJson`, no gzip); `X-Frame-Options` is removed, `Vary: Origin` always, ACAO `null` only for `Origin: null`; entry doc (rel === bound entry, HTTP 200) alone carries `frame-ancestors <cap.origin>`.
- Mint extras: requires `Content-Type: application/json` (403 `E_CSRF` otherwise), upload-class path refused 403 `upload` before any open (never opens an upload handle), shares the preview in-flight caps and `${principal}:preview` bucket, audit line `msg "preview html-cap"` (`kind:"html-cap"`, no path/cap), cap-end `ev:"pv-end"`, throttled `ev:"pv-deny"`.

## Deviations / disclosures

1. `routes.ts` now carries the mint (plan §6 allows) but `resSink` is passed into `createPvRoutes` (`makeSink`) to avoid a circular value import.
2. No store-size observable: T-H16 asserts 401, the dir fd back to baseline (`/proc/self/fd` count) and no `pv-end` audit instead of a literal "store size unchanged".
3. The 10 s queue-wait test shortens exactly the `10_000 ms` `setTimeout` via a spy (real 10 s otherwise); the lifetime-10 000 budget is not driven, the per-cap bucket (200) is.
4. T-H11's "no /proc ⇒ no cap" half cannot be exercised (`previewProcFdAvailable` is a direct import); the cap tests assert `iff previewProcFdAvailable()`, as the existing wtdiff/wtgraph tests do.
5. LAN `pv` requests are not counted against LAN per-IP in-flight caps (no `requireLanSession` — I1); bounded by the per-cap bucket + PV queue instead.
6. T-H12 is asserted over both listeners; "no `access-control-*` on `/api/*`" is a negative check on the existing routes (no src change was needed).
7. Existing exact-order cap assertions in `hub-preview.test.ts` were extended (required by the new cap).

## Self-verify output

```
npx prettier --check src/web-hub/hub tests/web-hub/http tests/web-hub/hub tests/fixtures/pv-site
  All matched files use Prettier code style!
timeout 280 npx tsc --noEmit -p tsconfig.json
  (no output — clean)
timeout 900 npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/protocol tests/web-hub/boundary.test.ts
  Test Files  214 passed (214)
  Tests  4178 passed | 3 skipped (4181)
npx vitest run tests/web-hub/contract tests/web-hub/agent
  Test Files  65 passed (65) · Tests  1225 passed (1225)
```

New suites: api-preview-html 32 tests, lan-preview-html 12, pv-log-redaction 3, caps-coexist +3. Mutation checks: seq0-after-authorize ⇒ T-H16b fails; redaction bypass ⇒ T-H15 fails. Zero "Closing file descriptor on garbage collection" warnings in the new suite.
