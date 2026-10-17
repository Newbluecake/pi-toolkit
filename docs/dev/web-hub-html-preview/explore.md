# HTML preview — exploration notes (2026-10-16, Explore glm-5.3 run r_AKGVXJQ7)

## User decisions (2026-10-16)

- Scripts allowed, but isolated in a sandbox (no allow-same-origin: no hub cookies/token/API).
- Server resources limited to the HTML file's own directory + subdirectories (no `../` / absolute escape; denylist still applies).
- External network (CDN scripts, web fonts) allowed.
- Rendered inside the preview dialog with render/source toggle + "open in new tab".

## 1. GET /api/preview end-to-end

- Route dispatch: `src/web-hub/hub/http.ts:1432-1452` (LAN branch, gated `rt.preview.mode === "on"`), loopback ~`:2499` / `:2891`; `probe` `:1454-1470`. LAN `mode:"loopback"` ⇒ 404 (`:1046`).
- `src/web-hub/hub/preview/routes.ts` `handle()` (~287-640): ⓪ closing guard, `previewCsrfOk` (:117-128 — `X-PWH: 1` mandatory, `Sec-Fetch-Site: same-origin` when present, `Origin` must match) → listener auth → param validation (:318-350) → rate limit (bucket cap 20, +1/250ms, :76-79; per-principal in-flight 2 / global 8, :81-82) → shared open → sniff → stream → audit.
- Admission: `hub/preview/admit.ts` + `hub/preview/open.ts` — literal denylist + virtual roots → realpath → re-check → stat → `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)` → fstat dev/ino → regular → `/proc/self/fd/N` readlink re-check. Uploads sha256-verified (`verify.ts`).
- Kind: content sniff only (`hub/preview/sniff.ts`, magic numbers; extensions never participate). Markdown decided client-side by extension (`isMarkdownPath`); server says `text`.
- Headers: `hub/preview/stream.ts:226-231` (download) and `streamText` :394-401 — `text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`; Content-Disposition only on download. No CSP on preview responses. Metadata `X-PWH-Preview-*` (PREVIEW_HDR).
- Caps: text `PREVIEW_TEXT_MAX_BYTES`, chunked ceiling 16 MiB, images 16 MiB loopback / 4 MiB LAN / 40 MP, download 256 MiB; admission deadline 8s (`PREVIEW_ADMIT_TOTAL_MS`), auth reserve 4s.
- Audit: one line per request; `cls` = `upload|cwd|abs` (literal prefix only), HMAC-12 `pathTag`; 429 lines throttled 1/60s (routes.ts:456-463).
- Zombie IO: `PreviewIoTracker` per routes instance (routes.ts:263) ⇒ 503 E_BUSY.
- LAN: `pwh_lan` session cookie via `requireLanSession` (sqlite child IPC); loopback: in-process `pwh_sid` cookie. LAN sessions origin-bound (`bound_origin === ctx.externalOrigin`, lan-auth.ts:243).

## 2. `.html` today

Sniffed as text, served `text/plain` + nosniff ⇒ shown as source, never executed. No html special-casing in `preview/`.

## 3. Auth

- loopback `pwh_sid` (HttpOnly, SameSite=Strict, `hub/auth.ts:34`) via one-time token exchange; LAN `pwh_lan` (lan-auth.ts:38-44, HttpOnly + SameSite=Strict, Secure when configured).
- `X-PWH: 1` blocks subresource loads (`<img>/<link>/<script>` can't set headers). Precedent: `PreviewHost.vue:174-178` download uses Blob→objectURL because navigation can't carry the header. No existing GET route is subresource-usable (avatar `http.ts:1575-1589` also X-PWH); only non-`/api` static GETs are cookie-free (`http.ts:8`, `:319-321`).

## 4. Global security headers

`hub/http.ts:157-158` CSP `default-src 'self'; script-src 'self'; …; frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff (`:319-321`). Any iframe of a hub URL is blocked unless relaxed on that route.

## 5. Frontend

`ui/src/components/preview/`: `PreviewHost.vue` (phase machine `loading|image|text|dir|unsupported|tooLarge|error`, template :466-559), `PreviewText.vue` (markdown rendered/source toggle :339-346, `isMarkdownPath` :77, MdBlock no-v-html), `PreviewImage.vue`, `PreviewDir*.vue`, `PathText.vue`, `previewContext.ts` (fetch with X-PWH). An iframe renderer = new phase + component; needs a real URL (or srcdoc/blob).

## 6. Sandboxed iframes

None in the UI today.

## 7. Origins / capability tokens

Two listeners: loopback `127.0.0.1` (http.ts:165, not configurable) and LAN `0.0.0.0:<lan.port>` (:166). Ticket precedents (resume `__pick` nonce, upload ids, restore.veto) — none is a URL-embedded signed capability for a bare GET.

## Constraints / risks

- X-PWH header CSRF is incompatible with subresource loads ⇒ need a signed short-TTL capability in the URL path, or cookie-only + Sec-Fetch-Site, both weaker than today.
- `frame-ancestors 'none'` + XFO DENY must be relaxed only on the new route.
- User HTML must never be served executable on the hub origin with cookies reachable: sandbox (no allow-same-origin) and/or a distinct origin; CSP `sandbox` header on the response so "open in new tab" stays sandboxed too.
- Relative URLs need a path-shaped route (`/…/<cap>/<rel path>`), not `?path=`.
- Per-subresource full admission chain vs rate bucket (20) / in-flight 2 / 8s budgets — a page with many assets will trip limits.
- LAN cookies are origin-bound.
- Files may change mid-page (no snapshot consistency).
