# Web Hub 本地服务代理 / 页内链接预览 · 开发者要点

> 何时读：改动 `src/web-hub/hub/proxy/**`、`webHub.proxy.*` 设置键、`/api/proxy*`、页内链接预览之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`link-preview-plan.md`、`acceptance.md`

## Local-service proxy

**Local-service proxy (web-hub-proxy plan v2 + §R1/§R2, `webHub.proxy.{enabled,portRange,maxProxies}`, default off;
non-live — `/reload` then `/webhub restart`)**: lets the browser open a service listening on the hub machine (e.g.
`127.0.0.1:23434`) through a per-target hub listener in `portRange` (default `7900-7949`, max 8 instances, LAN bind iff
`webHub.lan` is on). `HubConfig.proxy` exists only when enabled ∧ `control !== false`; key absence IS off (no service, routes,
caps, `/api` cross-site gate, multi-candidate cookies or disk — hub byte-identical). `hub/main.ts` re-validates via
`hub/proxy/config.ts` and drops the key on a malformed value or a range overlapping `webHub.port`/`webHub.lan.port`.
`hub.ts` builds `createProxyService` AFTER `fe.listen()` with the ACTUAL bound ports and a LIVE `lanHostSnapshot`, awaits
`dispose()` on close and on every later startup failure, subscribes `service.revoke` to the auth-revocation bus
(`hub/auth-revoke.ts`; logout/password change/token rotate kill proxy sessions), counts proxied sockets toward idle and
mirrors `portsStore` into `hub.json.proxy`. Routes (`hub/proxy/routes.ts`: `POST /api/proxy/open`, `GET /api/proxy`,
`POST /api/proxy/stop`) capture `seq0` before identity resolution, refuse the trusted reverse proxy (409 `reverse-proxy`)
and re-resolve identity on a retryable `closing` (stale ⇒ 401). Caps `proxy.v1` / `proxy.lan.v1` (iff `config.lan`) are
static. Engine invariants (`hub/proxy/{listener,forward,ws,service}.ts`): permanent fail-closed port↔target binding
(`ports-map`), pinned resolved IP (never re-resolved, redirects never followed — `Location` rewrite only), one-time code ⇒
`SameSite=Lax` gate cookie (idle 2 h, hard min(12 h, parent login)), strict Host/Origin checks, unsafe methods and WS
require Origin = the proxy origin BEFORE any upstream dial, hub cookies / `pwh_*` Set-Cookie / Clear-Site-Data never cross,
bounded queues/backpressure (an upload is cancelled only on a real client close — a slow upstream never kills a live
upload; residual: a hidden FIN behind full buffers waits for the 120 s idle timeout), audit lines carry no
path/query/cookie/code. Design: `docs/dev/web-hub-proxy/plan.md`; package reports `{XA,X0,X1a,X1b,X1c,X2,X3}-report.md`;
real-browser gate `docs/dev/web-hub-proxy/acceptance.md`.

## In-page link preview

**In-page link preview (link-preview plan r2, `docs/dev/web-hub-proxy/link-preview-plan.md`)**: cap `proxy.frame.v1` is
declared iff `config.proxy`; only with it does a click on a recognized link open a lazy-loaded in-page dialog iframing the proxy
origin (older hubs keep the new-tab flow). The hub UI CSP gains `frame-src 'self' http://*:<p>` limited to the configured
`portRange` (proxy off ⇒ CSP byte-identical); hub XFO/`frame-ancestors 'none'` stay. Proxy-generated pages (enter 303 and every
error page answered after Host validation) are frameable by the hub origin(s) only via a per-request `ProxyReplyPolicy`; an
invalid Host (421), the `closing` 503 and WS rejects keep the strict headers, and **upstream framing headers
(`X-Frame-Options`/`frame-ancestors`) pass through untouched (user ruling D2)** — a no-embed app shows refused in the dialog,
with 「新标签打开」 always offered. Enter reuses the browser's live same-identity gate session (no new session / `Set-Cookie`,
caps unchanged, nothing evicted), so repeated opens never hit `429 sessions`. Browser gate: `acceptance.md` §18, fixtures
`scripts/dev/proxy-frame-fixtures.mjs`.
