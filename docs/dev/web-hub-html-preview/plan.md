# web-hub HTML preview — implementation plan v2 (2026-10-17)

User request: 「我需要一个可以预览 HTML 的功能，并且这个 HTML 可以正常加载服务端文件」.
Inputs: `explore.md` (same dir), `docs/dev/web-hub-preview/{plan,dir-plan,chunked-plan}.md`, AGENTS.md web-hub section.
Lane **L3**. Every package → independent verifier before commit. v1 → v2 changes: §R1.

## 0. Fixed decisions (user, 2026-10-16/17 — not reopened)

| #   | Decision                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Scripts run, sandboxed: the page never gets hub cookies/session/token and cannot use hub APIs                                                                                        |
| F2  | Server resources = the HTML file's own directory + subdirectories only; denylist applies to every subresource                                                                        |
| F3  | External network (CDN scripts, web fonts) allowed                                                                                                                                    |
| F4  | Rendered in the existing preview dialog with render/source toggle (markdown precedent) + "open in new tab", equally sandboxed                                                        |
| D1  | Sandbox tokens `allow-scripts allow-forms allow-popups` — no `allow-modals`, `allow-downloads`, `allow-top-navigation*`, `allow-popups-to-escape-sandbox`, never `allow-same-origin` |
| D2  | Refuse an HTML whose directory is exactly `/`, `$HOME` (literal + canonical), the agent dir, or the uploads root (and anything under uploads) ⇒ source view only                     |
| D3  | New tab = script-free hub wrapper `/pvw/<cap>` holding the same sandboxed iframe                                                                                                     |
| D4  | Capability TTL: idle 15 min, absolute 60 min                                                                                                                                         |

Non-goals (v1): HTML attachments from the upload store; Range/206; gzip of `/pv`; root-absolute refs (`/x.css` hits the hub UI root ⇒ 404, inherent to F2); `new Worker(url)` (blob: workers work); `.xhtml`; cap dedup (every mint is independent, §R1-3).

## 1. Isolation model

Same hub origin, path-shaped capability URL `/pv/<cap>/<rel>`, framed by `<iframe sandbox="…">` AND every `/pv/*` response carries `Content-Security-Policy: sandbox …` with the identical token string `PV_SANDBOX` (one constant in `protocol/preview-html.ts`, imported by hub and UI). The document gets a fresh **opaque origin**: `document.cookie`/storage/IndexedDB/SW registration throw, `parent`/`top`/`opener` DOM is cross-origin, no top navigation, popups inherit the sandbox. The new tab opens `/pvw/<cap>` (§3.2), so tab and dialog have the same two layers; a raw `/pv/` URL pasted top-level still has the header layer.

srcdoc/blob rejected: srcdoc can't resolve sibling files; `blob:` inherits the hub origin. Distinct port rejected: cookies are not port-isolated and SameSite is site-based (a sibling port is same-site, would receive `pwh_sid`/`pwh_lan`), it needs a 3rd listener/host list/proxy origins, and the hub UI CSP (`default-src 'self'` ⇒ `frame-src 'self'`) already allows a same-origin `/pv/` iframe unchanged.

**Precise invariants** (not "every API needs X-PWH" — `/api/events`, `/api/history`, `/api/run/history` are cookie-only GETs):

- **I1** `/pv/*` and `/pvw/*` never read `Cookie`, never call `auth.check`/`requireLanSession`, never `Set-Cookie`; the capability is the only credential.
- **I2** Requests from an opaque origin to `/api/*` carry no usable credential in supported engines (`pwh_sid`/`pwh_lan` are HttpOnly + SameSite=Strict; an opaque initiator is never same-site, a top-level opaque document has no site-for-cookies) ⇒ 401.
- **I3** No `/api/*` response ever carries `Access-Control-Allow-*` ⇒ even a credentialed opaque request yields an unreadable (opaque/failed) response.
- **I4** Every state-changing `/api` route requires `X-PWH: 1` and/or `Content-Type: application/json` (non-simple ⇒ preflight ⇒ `OPTIONS` 404 on both listeners) and rejects `Origin: null`; cookie-only GET routes are side-effect free (SSE open = resource use only, still needs I2's cookie).
  Tests T-H12 pin I1–I4 over representative routes; the browser gate (§9) checks them in real engines.

## 2. Capability

### 2.1 Mint — `POST /api/preview/html-cap?agentKey=&sessionId=`, body `{ "path": "<abs>" }`

`PreviewRoutes.handleHtmlCap` in `hub/preview/routes.ts`, dispatched beside `POST /api/preview/probe` with the identical CSRF gate (`previewCsrfOk` + JSON) and listener matrix (loopback when `previewRoutes` exists; LAN only `mode === "on"`). Steps (budget `PREVIEW_ADMIT_TOTAL_MS` 8 s):

1. ⓪ closing ⇒ 503 · ① CSRF · **capture `seq0 = store.revokeSeq()` BEFORE calling authorize** (R2 #2: authorize is async — a revoke landing after it resolved but before the caller resumes must still count) · ② `io.authorize(r)` → principal + new optional `PreviewAuthResult.sidTag` (loopback `hashSid(pwh_sid)`, LAN `session.sidHash`) and `userId` (LAN).
2. ③ body ≤ 8 KiB; `expandTildePath` → `normalizePreviewPath` → `validatePreviewPath(p,{minSegments:1})`; `isHtmlEntryPath` (`/\.html?$/i`) else 400.
3. ④ preview bucket, 1 token (existing `${principal}:preview`, cap 20).
4. ⑤–⑦ `openAdmittedPath` (session visibility, existing full chain). `cls:"upload"` ⇒ 403 `upload`. Keep the entry fh; `entryRp`, entry fstat `{dev,ino}`.
5. `boundDir = dirname(entryRp)`, `entry = basename(entryRp)`. D2 + `denyListHit`/`isVirtualFsPath` on `boundDir` ⇒ 403 `dir-too-broad|denylist|virtual-fs`.
6. **Dir pin** (all via the PV IO gate, §2.5): `dirFh = boundedFdOpen(open(boundDir, O_RDONLY|O_DIRECTORY|O_NOFOLLOW))` (`WTDIFF_DIR_OPEN_FLAGS` / `HISTORY_DIR_OPEN_FLAGS` precedent); `readlink(/proc/self/fd/<dirFd>) === boundDir` and `stat(/proc/self/fd/<dirFd>/<entry>)` dev/ino === entry fstat — else close both, 409 `E_PREVIEW_CHANGED`. Close entry fh.
7. **Revocation re-check right before insert** (synchronous, same tick as insert): `store.revokedSince(seq0, {listener, sidTag, userId})` ⇒ close dirFh, 401 `E_AUTH`. If `seq0` is older than the retained tombstones ⇒ fail closed 503 retryable.
8. Insert (per principal 8, global 64; FIFO eviction closes the evicted cap's dirFh). Every mint is a new cap (no dedup).
9. 200 `{ url: "/pv/<cap>/<encodeURIComponent(entry)>", openUrl: "/pvw/<cap>", idleMs, hardRemainingMs }` — `hardRemainingMs = cap.hardAt − now()` measured at send time.
10. One audit line (`kind:"html-cap"`, `cls`, `pathTag`, `ext`, `ok`, `code/reason`, `capTag` = HMAC-12 of cap) — never path/cap.

### 2.2 Store (`hub/preview/html-cap.ts`, pi-free, per `createPreviewRoutes` closure)

```ts
interface HtmlCap {
  cap;
  capTag;
  principal;
  listener;
  origin /* io.expectedOrigin at mint */;
  sidTag?;
  userId?;
  dirFh: PreviewHandle;
  dirPath: string;
  dirDev;
  dirIno;
  entry;
  mintedAt;
  hardAt;
  lastUsedAt;
  reqs;
  bytes;
  denied;
  codes;
  active: Set<AbortController>;
  queue: Waiter[];
}
```

- `cap = randomBytes(32).toString("base64url")` (`PV_CAP_RE = /^[A-Za-z0-9_-]{43}$/`).
- `lookup(cap, listener, origin)` hits only a **live** record bound to that listener+origin (idle `PV_IDLE_TTL_MS` 15 min sliding, `hardAt` = mint + 60 min). `isLive(rec)` sync, used before headers.
- `revoke(sel, reason)`, `sel ∈ {sidTag} | {userId} | {listener} | "all"`: bumps `revokeSeq`, appends a tombstone `{seq, sel}` (ring of 256, retained ≥ 2 × admit budget), marks matching records dead, **aborts every controller in `active` and rejects queued waiters**, closes `dirFh` via `boundedClose` once in-flight requests released it (refcount).
- No timers: `sweep()` on every mint/serve/revoke/dispose (n ≤ 64; ≤ 64 dir fds total). Ended caps emit one summary audit `{ev:"pv-end", capTag, reqs, bytes, denied, codes, end:"idle"|"hard"|"revoked"|"evicted"|"close"}`.

### 2.3 Serve — `GET /pv/<cap>/<rel>` (`hub/preview/pv-routes.ts` → `PreviewRoutes.servePv`)

- ⓪ closing ⇒ 503. Non-GET ⇒ 404. Query string dropped.
- ① `PV_CAP_RE` + `lookup` miss/expired/revoked/foreign ⇒ 404 constant `text/plain` body (no oracle).
- ② `parsePvRelPath(rawRest)` (`hub/preview/pv-path.ts`, pure) ⇒ 400: raw `%2f %2F %5c %5C %00`, literal `\`, raw bytes ≤ 0x20 / 0x7f; empty segments (leading/double/trailing `/`); > 64 segments; per-segment `decodeURIComponent` (throw ⇒ 400, catches `%c0%ae`) then `.`/`..`/`/`/`\`/NUL/C0/DEL; segment ≤ 255 B; joined ≤ 4096 B.
- ③ budgets: own `createCmdLimit` bucket `pv:${capTag}` 200 / +1 per 20 ms ⇒ 429; lifetime 10 000 requests ⇒ 429.
- ④ **Bounded queue** (replaces v1's 503 at the 7th): active ≤ `PV_ACTIVE_PER_CAP` 6 and ≤ `PV_ACTIVE_GLOBAL` 16 do FS/stream work; others wait FIFO (`PV_QUEUE_PER_CAP` 64, `PV_QUEUE_GLOBAL` 256, wait ≤ `PV_QUEUE_WAIT_MS` 10 s). Overflow/wait timeout ⇒ 503 `Retry-After: 1`. A waiter holds only the socket (no fd); client abort / revoke removes it. A 50-asset page (incl. HTTP/2 proxy fan-out) queues instead of failing.
- ⑤ Admission (`hub/preview/pv-admit.ts`, deadline `PV_ADMIT_TOTAL_MS` 4 s from dequeue, every fs op through the PV IO gate). Resolution is anchored on the **held directory fd**, not a path string:
  1. literal prefilter, zero fs: `denyListHit(dirPath + "/" + rel)` (segment rules like `.ssh` hit here).
  2. `cur = readlink(/proc/self/fd/<dirFd>)`; `" (deleted)"` suffix ⇒ revoke cap, 404.
  3. `rp = realpath(/proc/self/fd/<dirFd>/<rel>)`; require `rp.startsWith(cur + "/")`, `!denyListHit(rp)`, `!isVirtualFsPath(rp)` (prefilter that keeps opens away from outside devices) ⇒ 403 `outside|denylist|virtual-fs`.
  4. `anchored = /proc/self/fd/<dirFd>/<rp.slice(cur.length+1)>` (fully resolved ⇒ an O_NOFOLLOW miss means a swap) → `st = stat(anchored)` → `fh = boundedFdOpen(open(anchored, PREVIEW_READ_FLAGS))` (O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY) → fstat dev/ino === st, regular file (dirs 415).
  5. **Authoritative containment**: `f = readlink(/proc/self/fd/<fileFd>)`, `d = readlink(/proc/self/fd/<dirFd>)` (read after `f`); require `f.startsWith(d + "/")`, no `(deleted)`, `!denyListHit(f)`, `!isVirtualFsPath(f)` ⇒ else close, 403/409. This — not a string `within` — is the binding: a rename+mkdir at the old path after mint/stat cannot redirect resolution (the held inode is used), and an intermediate symlink swapped mid-request is caught at 5.
     Residual (same as today's admitter): a swap between 3 and 4 can make `open` touch an outside non-regular node (O_NONBLOCK|O_NOCTTY, closed at the fstat check).
- ⑥ size > `PV_FILE_MAX_BYTES` 32 MiB or cap total > 512 MiB ⇒ 413.
- ⑦ Stream via `readAndStream` pv mode: `beforeHead: () => store.isLive(cap)` checked synchronously right before `writeHead` (false ⇒ 404 pre-head); every `fh.stat/read` through the PV IO gate; deadline `PV_STREAM_MS` {loopback 30 s, lan 60 s}. Revoke mid-stream ⇒ controller abort ⇒ `res.destroy()`. Release slot → dequeue next.
- ⑧ Account into the cap; denials add an audit line throttled 1/10 s per cap (`ext`, `reason`, `capTag` only — never `rel`).

`GET /pvw/<cap>` (`serveWrapper`): ① lookup, then the fixed page (§3.2), 1 bucket token.

### 2.4 Revocation hooks (all in `hub/http.ts`; hub.ts/admin.ts unchanged)

- loopback `/api/logout` (beside `auth.logout(sid)`) ⇒ `revokeHtmlCaps({sidTag})`.
- LAN `/api/logout` (beside `rt.lanSse.revoke(… sidHash …)`) ⇒ `{sidTag}`.
- LAN facade `revoke(target)` (http.ts `lanFacade.revoke`, `{sidHash}|{userId}`) ⇒ same selector — this is the **real passwd commit path**: `admin.ts handlePasswd` → `store.setPassword` → `deps.lan()?.revoke({userId})` (admin.ts ~210). Facade `revokeAll()` (LAN rotate) ⇒ `{listener:"lan"}`.
- `revokeAllSse` (http.ts frontend ext, called by token rotate via `revokeLoopbackSse`) ⇒ `{listener:"loopback"}`.
- `dispose()` ⇒ `"all"` (hub restart kills caps; the UI re-mints).

### 2.5 Physical IO quota (`hub/preview/pv-io.ts`)

The per-routes `PreviewIoTracker` does not bound libuv pool use, so `/pv` gets a semaphore of `PV_IO_SLOTS = 2` **outstanding real fs operations** (readlink/realpath/stat/open/fstat/read/close, dir open/close): a slot is released only when the underlying op actually settles — the caller's race (`racePreviewIo`, unref'd timer, per-op 2 s) may give up earlier, but the slot stays held (zombie) until settle; late fds are closed on settle (`boundedFdOpen` semantics). Waiters FIFO, bounded by the request deadline ⇒ 503 busy. A never-completing `close` keeps its slot forever (pv degrades to busy; the rest of the hub keeps ≥ 2 of libuv's 4 threads for preview, uploads, history and async scrypt KDF). Own instance; never shared with preview/history.

### 2.6 Leakage & log redaction

- `Referrer-Policy: no-referrer` on all `/pv`/`/pvw` responses (document policy ⇒ CDN requests carry no Referer), iframe `referrerpolicy="no-referrer"`, anchor `rel="noopener noreferrer"`, TTL D4, listener+origin binding, revocation hooks.
- **HTTP fallback logs** currently log `{ url: req.url, error: String(err) }` at `hub/http.ts` ~593 (LAN listener), ~1899 (LAN request), ~3275 (loopback). New `redactLogUrl(url)` (exported from `pv-path.ts`): `/pv/…` ⇒ `/pv/[redacted]`, `/pvw/…` ⇒ `/pvw/[redacted]`; for those URLs `error` becomes `errCode(err)` (`code ?? name`) — fs error messages carry paths. `pv-routes.ts` itself logs only `capTag`/codes.
- Residual: a page that deliberately sets `<meta name=referrer content=unsafe-url>` or sends `location.href` leaks its own cap — equivalent to the accepted F3 exfiltration.

## 3. Response headers (overrides after `setSecurityHeaders`, global `CSP` constant untouched)

### 3.1 `/pv/*` (every status)

| Header                         | Value                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`      | `sandbox allow-scripts allow-forms allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'` + entry document only `; frame-ancestors <cap.origin>` (non-entry docs omit it: nested same-dir frames have an opaque ancestor nothing can match; they hold no hub authority)                                                        |
| `X-Frame-Options`              | removed                                                                                                                                                                                                                                                                                                                                                           |
| `X-Content-Type-Options`       | `nosniff`                                                                                                                                                                                                                                                                                                                                                         |
| `Referrer-Policy`              | `no-referrer`                                                                                                                                                                                                                                                                                                                                                     |
| `Cross-Origin-Resource-Policy` | `cross-origin` (an opaque initiator is never same-origin/site)                                                                                                                                                                                                                                                                                                    |
| `Access-Control-Allow-Origin`  | `null` only when request `Origin: null` (module scripts, `crossorigin`, fonts, `fetch("data.json")`, wasm); never `*`/ACAC; `Vary: Origin`                                                                                                                                                                                                                        |
| `Cache-Control`                | `no-store`                                                                                                                                                                                                                                                                                                                                                        |
| `Permissions-Policy`           | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), clipboard-read=(), publickey-credentials-get=()`                                                                                                                                                                                              |
| `Content-Type`                 | `pv-mime.ts` by extension: html/htm `text/html; charset=utf-8`, css, js/mjs/cjs `text/javascript; charset=utf-8`, json/map, wasm, svg `image/svg+xml`, png/jpg/jpeg/gif/webp/avif/bmp/ico, woff/woff2/ttf/otf, txt/csv/tsv/md/log `text/plain; charset=utf-8`, xml, mp4/webm/mp3/ogg/wav; else `application/octet-stream` (inert: nosniff + no `allow-downloads`) |
| other                          | `Content-Length`; no `Content-Encoding`, no `Set-Cookie`, no `X-PWH-Preview-*`                                                                                                                                                                                                                                                                                    |

`'unsafe-inline' 'unsafe-eval'` and `*`: report HTML (coverage, pytest-html, plotly, agent pages) needs inline scripts/handlers and `new Function`; isolation comes from sandbox + opaque origin, not script-src. `data:`/`blob:` explicit because `*` excludes them. `charset=utf-8` overrides `<meta charset>` (accepted; GBK pages mis-decode).

### 3.2 `/pvw/<cap>`

`text/html; charset=utf-8`; `CSP: default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`; XFO `DENY`; `no-store`; `no-referrer`. Fixed template: `<title>` = HTML-escaped entry, one full-viewport `<iframe sandbox="${PV_SANDBOX}" referrerpolicy="no-referrer" credentialless allow="" src="/pv/<cap>/<entry>">`, zero `<script>`.

## 4. Routing & gating

- **Loopback** `handle()`: after `allowedHost` and the `/api` branch, before the static fallback: `/pv/` → `servePv`, `/pvw/` → `serveWrapper` (no collision: `isAllowedUiPath` never admits them).
- **LAN** `handleLanRequestInner`: in the non-`/api` branch before `rt.ui.serve`, gated `rt.preview?.mode === "on"` and the methods present; otherwise falls through to `ui.serve` ⇒ 404 byte-identical. Mint beside the probe branch, same gate.
- `htmlEnabled = config.preview !== undefined && previewProcFdAvailable()` (fail-closed: dir-fd anchoring is /proc-bound), computed in `hub.ts`, passed as `PreviewRoutesDeps.html?`; absent ⇒ methods not attached.
- Modes: `on` both listeners · `loopback` LAN mint/`/pv`/`/pvw` 404 · `off` nothing.
- Cap `PREVIEW_HTML_HUB_CAP = "preview.html.v1"` (`protocol/version.ts`) in `hub.ts` `extraHubCaps` under `htmlEnabled` (both cap surfaces); LAN width rides `preview.lan.v1`. No frames ⇒ no PROTO bump.
- Compat: old UI ⇒ never mints, `.html` stays `text/plain` source; new UI + old hub ⇒ no cap ⇒ DOM byte-identical. `GET /api/preview` unchanged.

## 5. Frontend

- `logic/preview.js`: `isHtmlPath`; `previewScopeOf` adds `scope.html = true` iff the cap is present (only-add-when-present). `types.ts` `PreviewPathScope.html?`.
- Transport `PreviewTransport.htmlCap?(req,{signal})` → `{ok:true,url,openUrl,idleMs,hardRemainingMs} | {ok:false,status,error,reason?}`; `htmlCapPost` in `logic/token-client.js` + `logic/password-client.js` (`probePost` skeleton, 8 s deadline, no POST replay), wrapped in `transport/{token,password}.ts`; `API.previewHtmlCap` in `logic/contract.js`.
- `PreviewText.vue`: `isHtml && scope.html && htmlCap` ⇒ the existing `.preview-toggle` (reuse `preview.viewRendered/viewSource`, label `preview.htmlToggleLabel`), default rendered, per-open reset via Host `:key`. Source = the existing source view verbatim. Rendered mounts `PreviewHtml` via `defineAsyncComponent`. Otherwise zero DOM change.
- NEW `components/preview/PreviewHtml.vue`: states `minting → ready | error`; iframe `:sandbox="PV_SANDBOX"` (imported), `referrerpolicy="no-referrer"`, `credentialless`, `allow=""`, `:title`; never `allow-same-origin`, `srcdoc`, `v-html`, or a `window` `message` listener. "新标签页打开" = `<a :href="openUrl" target="_blank" rel="noopener noreferrer">`.
  - **TTL UX (§R1-8)**: idle elapsed since mint ⇒ non-blocking hint 「可能需刷新」; `hardRemainingMs` elapsed ⇒ banner 「链接已过期，刷新以继续加载」 + 「重新加载」 (re-mint + iframe `:key` bump). The running iframe is **never** unloaded automatically.
  - `@load` hides the spinner; > 10 s ⇒ 「仍在加载…」. Mint 403 (`dir-too-broad|upload|denylist`) ⇒ prose note + switch to source; 429/503 ⇒ retry.
  - standing note: 「页面脚本在沙箱中运行，可访问外网与本目录文件，无法访问 hub」.
- Sizing: `.preview-html-frame{width:100%;border:0;background:#fff;height:clamp(320px,72vh,1400px)}`; `<768px` ⇒ `calc(100dvh - var(--preview-header-h,96px))`. `PreviewHost.vue` sets `holdTall` for html text phases (dir-phase mechanism).
- i18n `i18n/{zh,en}/preview.ts`: `htmlToggleLabel`, `htmlOpenTab`, `htmlMaybeStale`, `htmlExpired`, `htmlReload`, `htmlLoadingSlow`, `htmlNote`, `htmlDenied.{dirTooBroad,upload}`; no new compact markers.
- check:web: the lazy budget is ONE 128 KiB gz **total** across all lazy chunks (`scripts/web-hub/check-ui-dist.ts` `LAZY_JS_BUDGET_GZIP_BYTES`); current dist measures 36,727 B gz; `PreviewHtml` adds ≈ 3 KiB ⇒ ≈ 40 KiB of 128 KiB. First-screen delta < 1 KiB (512 KiB budget). P2 runs `npm run build:web && npm run check:web`.

## 6. Packages (exclusive file domains)

**P0 frozen surface** (blocks all): NEW `protocol/preview-html.ts` (paths, `PV_PREFIX`/`PVW_PREFIX`, `PV_SANDBOX`, `PV_CAP_RE`, every `PV_*` limit/TTL above, `isHtmlEntryPath`, request/response body types); `protocol/preview.ts` (`PreviewDenyReason` += `"upload" | "dir-too-broad"`; `outside` already exists); `protocol/version.ts` (cap); `hub/ports.ts` (`PreviewAuthResult.sidTag?`/`userId?`; `PreviewRoutes` optional `handleHtmlCap?`, `servePv?`, `serveWrapper?`, `revokeHtmlCaps?`; `PvIo {listener, ip, origin}`); `ui/src/types.ts`, `ui/src/transport/types.ts`, `ui/src/logic/contract.js`. Test `tests/web-hub/protocol/preview-html.test.ts` (no `allow-same-origin`/top-nav/modals/downloads in `PV_SANDBOX`; cap regex = 43; idle < hard; active ≤ queue; slots ≥ 1).

**P1a hub pure** (after P0): NEW `hub/preview/{pv-path,pv-mime,pv-io,html-cap,pv-admit}.ts`; `hub/preview/stream.ts` (extract `streamRawBody(ctx, headers)` from `streamDownload`; `StreamSrc.pv?: { headers, beforeHead, io }`; download headers byte-identical). `admit.ts` untouched. Tests `tests/web-hub/hub/preview/{pv-path,pv-mime,pv-io,html-cap,pv-admit}.test.ts`, `stream.test.ts`; corpus `tests/fixtures/pv-path-corpus.json`.

**P1b hub wiring** (after P1a): NEW `hub/preview/pv-routes.ts` (queue, serve, wrapper, dispose); `hub/preview/routes.ts` (`html?` dep, `handleHtmlCap`, `revokeHtmlCaps`, dispose chain); `hub/http.ts` (dispatch on both listeners, `sidTag`/`userId` in authorize closures, four revoke hooks, `redactLogUrl` at the three fallback sites); `hub/hub.ts` (cap + `html` dep). Tests `tests/web-hub/http/{api,lan}-preview-html.test.ts`, `tests/web-hub/http/pv-log-redaction.test.ts`, `tests/web-hub/hub/caps-coexist.test.ts` additions; fixture tree `tests/fixtures/pv-site/`.

**P2 UI** (after P0, ∥ P1): `ui/src/logic/{preview,token-client,password-client}.js`, `ui/src/transport/{token,password}.ts`, `components/preview/{PreviewText,PreviewHost}.vue`, NEW `PreviewHtml.vue`, `i18n/{zh,en}/preview.ts`. Tests NEW `tests/web-hub/ui/preview-html.test.ts`; additions to `preview-text`, `logic-preview`, `preview-host`, `transport-contract` tests.

**P3 integration** (main session, after P1b+P2): NEW `tests/integration/web-hub-pv-starvation.test.ts` (child-process pattern of `tests/integration/fixtures/history-starvation-child.ts`); `docs/dev/web-hub-html-preview/acceptance.md` + browser security gate (§9); AGENTS.md web-hub paragraph; full gate `format:check → typecheck → test → build → build:web → check:web`.

## 7. Threat → test → browser-gate matrix

| Threat                         | Mitigation                                                        | Automated          | Browser gate (expected)                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read hub cookie/storage/UI DOM | opaque origin, two sandbox layers, HttpOnly                       | T-U1, T-H6, T-H13  | G1 cookie/storage/IndexedDB/`parent.document` throw; G2 SW `register` rejects; G3 BroadcastChannel never reaches a hub-origin listener                                                                                                                                                         |
| Use hub API                    | I1–I4                                                             | T-H7, T-H12        | G4 fetch/EventSource to `/api/history`,`/api/events` fail, hub sees 401 or nothing, SSE count unchanged; G5 `X-PWH` fetch ⇒ only `OPTIONS` hits hub (404); G6 no-cors text/plain POST and `<form>` POST to `/api/cmd` ⇒ 401/403, ledger unchanged; G7 `<img>`/frame nav to GET APIs unreadable |
| Hub tab hijack                 | no top-nav/modals; popups sandboxed; no `message` listener        | T-U1               | G8 `top.location=` blocked; G9 popup is sandboxed (cookie throws), `opener.document` throws; `/pvw` tab `opener === null`; G10 `parent.postMessage` changes nothing                                                                                                                            |
| Escape the directory           | rel parser, dir-fd anchoring, fd-readlink containment             | T-H1, T-H3, T-H9   | G11 `../x`, `%2e%2e`, `sub%2f..`, symlink-out, other-cap guess ⇒ 400/403/404, unreadable                                                                                                                                                                                                       |
| Credentials inside dir         | denylist on literal, rp and fd path                               | T-H3               | G12 `.ssh/id_rsa` 403                                                                                                                                                                                                                                                                          |
| Exfiltrate dir files           | **accepted** (F2+F3); D2 bounds roots                             | T-H5               | G13 CDN script + web font load (F3 works)                                                                                                                                                                                                                                                      |
| Cap leak                       | no-referrer, TTL, binding, revoke, log redaction                  | T-H2, T-H10, T-H15 | G14 CDN requests carry no Referer                                                                                                                                                                                                                                                              |
| Revocation race                | seq re-check before insert, `isLive` before head, abort in-flight | T-H16, T-H17       | G15 logout in another tab ⇒ next asset 404                                                                                                                                                                                                                                                     |
| DoS / pool starvation          | bucket, queue, 2 IO slots, size caps, own limiter                 | T-H8, T-H14, T-I1  | G16 50-asset page via HTTP/2 proxy all 200, no 503                                                                                                                                                                                                                                             |
| Old engine ignores CSP sandbox | wrapper is the only UI-offered tab                                | T-H13              | G17 raw `/pv` top-level: G1–G10 still blocked (evergreen engines)                                                                                                                                                                                                                              |
| DNS rebinding                  | `allowedHost` before `/pv`; LAN host list                         | existing           | —                                                                                                                                                                                                                                                                                              |

## 8. Tests

- **T-H1** `pv-path` corpus: ok `a/b.css`, `报告/图.png`; reject `..`, `a/../b`, `%2e%2e/x`, `%2E%2e`, `a%2fb`, `a%2Fb`, `a%5cb`, raw `\`, `%00`, `%0a`, `%7f`, `%c0%ae`, `%zz`, `a//b`, `/x`, `a/`, `./a`, 65 segs, 256-B seg, 4097-B total. `redactLogUrl` cases.
- **T-H2** store: unique 43-char caps; two mints of the same file ⇒ two caps; FIFO 8/64 closes dirFh; idle/hard expiry (fake clock, activity doesn't extend hard); listener/origin miss; revoke by sidTag/userId/listener/all bumps seq + tombstone; no `setTimeout`/`setInterval` spy hits.
- **T-H3** `pv-admit`: inside symlink ok; symlink to outside 403 `outside`; `.ssh/id_rsa` 403; **dir swap after mint**: rename bound dir + `mkdir` same name + plant files ⇒ requests still resolve inside the held inode (planted files 404), and a deleted dir ⇒ cap revoked; **swap after stat** (scripted fs: replace an intermediate dir with a symlink between steps 4 and 5) ⇒ 409/403.
- **T-H4** stream: download headers byte-identical; pv headers exact; `beforeHead` false ⇒ 404 pre-head.
- **T-H5** mint: non-html 400; upload 403; `/x.html`, `~/x.html`, agentDir, uploads ⇒ 403 `dir-too-broad`; denylisted 403; no X-PWH 403; 1 preview token; audit has no path/cap.
- **T-H6** headers on entry/non-entry/404/400 (§3.1 exact; ACAO `null` iff `Origin: null`).
- **T-H7** cookie independence: no cookie works; valid cookie + bad cap 404; byte-equal responses with/without cookie.
- **T-H8** 50 parallel requests on one cap ⇒ all 200 with ≤ 6 concurrently in FS/stream (instrumented); 71st concurrent request on one cap (6 active + 64 queued) ⇒ 503; wait > 10 s ⇒ 503; `/api/preview` unaffected.
- **T-H9** raw-socket traversal (no client normalization): `/pv/<cap>/../x`, `/%2e%2e/x`, `/sub%2f..%2fx` ⇒ 400.
- **T-H10** LAN parity: mode on/loopback/off matrix; loopback cap on LAN 404; origin A cap via B 404; **real passwd**: `admin.handlePasswd` (real store via `lan-helpers`) ⇒ that user's caps 404, other user's still 200; LAN rotate (`revokeAll`) LAN only; loopback rotate loopback only; logout both listeners.
- **T-H11** caps on both surfaces iff `htmlEnabled`.
- **T-H12** invariants: `Origin: null` + valid cookie to `/api/history`, `/api/run/history`, `/api/events`, `/api/preview`, `/api/headless`, `/api/load/top`, `/api/avatar` ⇒ no `Access-Control-*` header on either listener; `OPTIONS /api/*` 404; text/plain POST `/api/cmd` with cookie ⇒ 403; `/pv` never calls the auth port (spy).
- **T-H13** `/pvw`: CSP exact, one iframe with `sandbox="${PV_SANDBOX}"`, no `<script`, title escapes `<script>.html`.
- **T-H14** lifecycle: `dispose` aborts streams/waiters, fd count back to baseline (dir fds included); a hung `close` keeps a PV slot but `/api/preview` keeps serving.
- **T-H15** log redaction: inject a throwing `servePv` (loopback) and a throw in the LAN path (both fallback sites + LAN listener catch) ⇒ captured `HubLog` entries contain neither the cap nor the rel filename; `error` is a code.
- **T-H16** mint race: scripted fs pauses at the dir-pin step → logout (and separately passwd) → resume ⇒ 401, store size unchanged, dir fd closed.
- **T-H16b** mint race at the auth boundary: a scripted authorize that has resolved its session lookup but not yet returned → logout/passwd revoke → authorize returns ⇒ 401, no cap inserted (proves `seq0` is captured before authorize).
- **T-H17** serve race: pause FS at ⑤ → revoke → resume ⇒ 404 pre-head; pause mid-stream → revoke ⇒ socket destroyed; queued waiters ⇒ 404.
- **T-I1** starvation (child process, `UV_THREADPOOL_SIZE=4`): pv fs seam never settles (incl. close) ⇒ `/pv` answers 503 within its deadline, while `GET /api/preview`, an upload POST and a LAN login (real async scrypt) all complete within their normal budgets.
- **T-U1** `PreviewHtml`: sandbox === `PV_SANDBOX`, no `allow-same-origin`; referrerpolicy; src; new-tab anchor; idle hint + hard banner shown but iframe element/src unchanged until 「重新加载」; mint 403 ⇒ source; no `window` `message` listener.
- **T-U2** `PreviewText`: no cap ⇒ DOM snapshot identical; cap ⇒ toggle, default rendered. **T-U3** scope/`isHtmlPath`/transport parity.

## 9. Real-browser security gate (blocking; recorded in `acceptance.md`)

Fixture `tests/fixtures/pv-site/security-probe.html` + `probe.js` run G1–G14 and print a JSON verdict table into its own DOM (read via deveye/CDP); hub-side assertions captured in the same run: cmd ledger unchanged, SSE client count unchanged, no 2xx on `/api/*` from `Origin: null`, fd count back to baseline after closing.

- Contexts: (a) dialog iframe, (b) `/pvw` tab, (c) raw `/pv` URL pasted top-level, (d) popup opened by the page.
- Listeners/engines: loopback Chrome + Firefox; LAN password over http (Chrome, iOS Safari); LAN behind an HTTP/2 HTTPS reverse proxy (`externalOrigins`) — also G16 (50 parallel assets, all 200).
- Functional: vitest coverage HTML, plotly export, pytest-html render; `~/x.html` ⇒ source + note; `webHub.preview:"loopback"` ⇒ LAN source only; idle 15 min ⇒ hint only, page keeps working until reload.
- Liveness during G16 + a hung-FS run: ordinary preview, upload, LAN login respond normally.

## 10. Open sign-offs

None — D1–D4 fixed in §0.

## §R1 处置表 (review gpt-6.1-sol, verdict REVISE; all adopted)

| #   | Severity | Item                                       | Change in v2                                                                                                                                                                                  |
| --- | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker  | passwd path never calls `bumpLanRevokeGen` | Revocation hooked at the LAN facade `revoke(target)` (+`revokeAll`), the call `admin.ts handlePasswd` makes after `setPassword`; caps store `userId` (§2.4); T-H10 uses a real `handlePasswd` |
| 2   | Blocker  | async mint/serve vs revoke race            | `seq0` captured after authorize + tombstone re-check right before insert; `isLive` before `writeHead`; revoke aborts in-flight + queued (§2.1-7, §2.2, §2.3-⑦); T-H16/T-H17 pause-FS tests    |
| 3   | Major    | dedup vs sidTag mismatch                   | Dedup dropped; every mint independent (§0 non-goals, §2.1-8); T-H2                                                                                                                            |
| 4   | Blocker  | dir inode check-then-replace window        | Held `O_DIRECTORY                                                                                                                                                                             | O_NOFOLLOW`dir fd per cap, resolution through`/proc/self/fd/<dirFd>/…`, authoritative fd-readlink containment; no "string within = inode" claim; `admit.ts` untouched; dir fd closed on end (≤ 64) (§2.3-⑤); T-H3 swap tests |
| 5   | Major    | 7th concurrent ⇒ 503                       | Bounded FIFO queue (6/16 active, 64/256 queued, 10 s wait) (§2.3-④); T-H8 + G16 HTTP/2 50-asset gate                                                                                          |
| 6   | Major    | tracker doesn't bound libuv pool           | `pv-io.ts` 2-slot semaphore, slots held until real settle, all ops incl. close bounded (§2.5); T-H14, T-I1 starvation incl. KDF                                                               |
| 7   | Major    | fallback logs leak cap via `req.url`       | `redactLogUrl` + code-only error at http.ts ~593/~1899/~3275 (§2.6); T-H15                                                                                                                    |
| 8   | Minor    | TTL semantics/UX                           | `hardRemainingMs` returned; idle ⇒ 「可能需刷新」 hint, iframe never auto-unloaded (§2.1-9, §5); T-U1                                                                                         |
| 9   | Major    | real-browser gate + precise invariant      | I1–I4 stated precisely (cookie-only GETs acknowledged) (§1); threat→test→browser matrix (§7); blocking browser gate G1–G17 (§9); T-H12 covers representative GET APIs                         |
| —   | Note     | lazy budget is a total                     | §5 budgets against the 128 KiB lazy total (measured 36,727 B gz)                                                                                                                              |
| #10 | —        | fixed decisions                            | §0 holds F1–F4 + D1–D4; §10 has no open sign-offs                                                                                                                                             |

## §R2 主会话裁定（评审第 2 轮 REVISE，按评审收敛规则由主会话闭合，不开第 3 轮）

| #       | 残留点                                                                             | 处置                                                                                              |
| ------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 2       | `seq0` 在 await authorize 之后捕获，authorize 已取结果但尚未返回时的 revoke 会漏记 | `seq0` 改为在调用 authorize **之前**捕获；插入前同步检查此后匹配的撤销；新增 T-H16b（§2.1-1、§8） |
| 1, 3–10 | —                                                                                  | 评审第 2 轮确认 closed                                                                            |
