# web-hub port proxy: implementation plan v2 (2026-10-17)

User request: 「除了 html，内部启动的 http 服务，我也希望支持代理访问功能，比如服务器上启动了一个 127.0.0.1:23434 这么个服务」.
Inputs: AGENTS.md web-hub section, `docs/dev/web-hub-html-preview/{explore,plan}.md` (revocation selectors, seq0-before-authorize,
log redaction, browser gate), `docs/dev/web-hub/lan-plan.md` §2.1–2.5 (host allow-list, trusted proxy), §6.3 (conn-guard), §6.4 (origin binding).
Lane **L3**. Every package goes to an independent verifier before commit. Sequencing: package **XA** starts only after HTML-preview **P1b**
(currently in verification; it touches the same `hub/http.ts` auth and revoke sites) has landed. v1 → v2: §R1.

## 0. Fixed decisions (user, 2026-10-17; not reopened)

| #   | Decision                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Each proxied target gets its own hub-opened listener **port**, i.e. its own origin. Absolute paths, the app's cookies/localStorage and WebSocket work normally |
| F2  | Access is a one-time link exchanged for a separate **proxy session** (never the hub session). The hub API stays protected by X-PWH + Origin                    |
| F3  | Targets: this machine + LAN, fenced to loopback/private ranges. DNS is resolved once and the IP pinned. The hub's own ports are denied                         |
| F4  | HTTP + WebSocket (Upgrade)                                                                                                                                     |
| F5  | Two entry points: a 「打开本机端口」 dialog (host:port), and clickable loopback/private URLs in messages. Both open a new tab                                  |
| Q1  | New setting `webHub.proxy.enabled`, default **off**. Off ⇒ the hub is byte-identical: no service, routes, cap, `/api` gate or disk                             |
| Q2  | LAN reach **follows `webHub.lan`**. LAN on ⇒ proxy ports are reachable from the LAN as well; LAN off ⇒ loopback only (§3.4)                                    |
| Q3  | Ports `7900-7949`; at most **8** concurrent proxies                                                                                                            |
| Q4  | Proxy session idle **2 h**, absolute **12 h**, never beyond the parent hub login, and revoked with it                                                          |

Non-goals (v1): `https://` upstreams; response body rewriting; HTTP/2. Port reassignment between targets (§3.3). Access through the trusted
reverse proxy (§6). Restoring proxies across a hub restart. CORS or `form_post` callbacks into a target from foreign origins (§3.5 step 6).
Per-proxy traffic stats in the UI (logs only).

## 1. Code facts relied on (verified 2026-10-17)

- Listeners: loopback `BIND_HOST="127.0.0.1"` (not configurable). Its configured port falls back to a **random port** on `EADDRINUSE`
  (`listen()`), so the real port is only known after listen. LAN `LAN_BIND_HOST="0.0.0.0"`, port `webHub.lan.port`, host allow-list from
  `HostSnapshot.hostKeys` (live `handle.current()`), IPv4/hostname only. No hub listener has an `upgrade` handler.
- CSRF helpers: loopback `csrfOk` (JSON + `X-PWH: 1` + Origin, if present, = `http://<Host>`); `strictCsrfOk`/`uploadCsrfOk` (Origin
  mandatory, `Sec-Fetch-Site` must be `same-origin` when present); LAN `csrfOkLan` (Origin mandatory = `ctx.externalOrigin`). Cookie-only
  GETs: `/api/events`, `/api/history`, `/api/run/history` (+ LAN `/api/session`). All other GETs need `X-PWH`. `OPTIONS` falls through to
  404 with no `Access-Control-*`, and no `/api` response carries ACAO.
- Auth: `auth.check(cookieHeader)` (`hub/auth.ts`) reads the **first** `pwh_sid` via `readCookie`, with a sliding 12 h expiry. 17 `auth.check`
  call sites in `http.ts`. Sites that then **re-read** the first cookie for identity: `GET /api/load/top` and `/api/version` principals
  (~3035/3042), the HTML-cap authorize `sidTag` (~3096), and loopback logout (~3305). LAN: `requireLanSession` → `readLanCookie` (first
  `pwh_lan`) → `touchSession(sidHash)` → `LanSessionResult{userId, epoch, sidHash, absoluteExpiresAt}`. `checkLanSession` (`lan-auth.ts`
  ~246) is a second reader.
- Revoke sites (P1b working tree): LAN logout calls `revokeHtmlCaps({sidTag})` **before and after** `await deleteSession`, then
  `lanSse.revoke`. The LAN facade's `revoke({sidHash}|{userId})` is reached by `admin.ts handlePasswd`. `revokeAll()` handles LAN rotate.
  Loopback logout. `revokeAllSse` handles token rotate. `previewRoutes = deps.preview` inside `createHttpFrontend`.
- `createConnGuard(opts)` takes per-instance caps. The idle monitor counts `{agents, sse, headless}` (`hub.ts` ~1669).
  `extraHubCaps` (`hub.ts` ~356) feeds both cap surfaces. Settings → `HubConfig` in `agent/index.ts` `buildHubConfig`. A feature is off
  when its key is absent; `hub/main.ts` normalizes keys.
- Node 22: `stream.getDefaultHighWaterMark(false) === 65536`. `http.Agent` queues beyond `maxSockets` **without bound**. `headersTimeout`/
  `requestTimeout` are only enforced on each `connectionsCheckingInterval` tick (default 30 s).
- UI: markdown links are http(s)-only `<a target=_blank>` (`MdInline.vue`). Bare URLs are not linkified, and `findPathRefs` skips scheme tokens.
  `check-ui-dist.ts`: lazy JS total ≤ 128 KiB gz (≈ 40 KiB used).

## 2. Architecture

```
hub UI tab (http://H:7878)  POST /api/proxy/open {target} ─X-PWH,Origin─▶ hub listener ─▶ resolveIdentity ─▶ ProxyService.open
                            ◀─ {enterUrl: http://H:7901/__pwh_proxy__/enter?c=<code>} ◀─ fence+pin → durable port bind → listen → code
new tab ─▶ :7901 /__pwh_proxy__/enter?c= ─▶ consume code ─▶ 303 /<safe path> + Set-Cookie pwh_px_7901 (Lax)
        ─▶ :7901 /anything ─▶ Host ✓ ─▶ gate cookie ✓ ─▶ unsafe-method/WS Origin ✓ ─▶ queue ─▶ pinned IP:port (HTTP | WS pipe)
```

One instance = one `node:http` server per `(pinnedIp, targetPort, hostHeader)`, on a port permanently bound to that target. Credentials are
fully disjoint: proxy listeners never read `pwh_sid`/`pwh_lan`, and hub routes never read `pwh_px_*`.

## 3. Hub: proxy service

### 3.1 Target grammar and fence (`hub/proxy/target.ts`, pure apart from the DNS gate)

- `parseProxyTarget(input)` accepts `host:port`, `http://host:port[/path?query]`, `[v6]:port`. That is TCP host+port only: no `unix:`, no socket
  paths, no userinfo, no `https`. Port must be 1–65535 with no leading zero. IPv4 must be a strict dotted quad, so `0x7f.1`, `2130706433`,
  `127.1`, `0177.0.0.1` and `127.0.0.1.` are `syntax` errors. Hostnames go through `classifyHostToken`; `localhost` maps to `127.0.0.1` with no DNS.
  The optional path becomes `nextPath` after §3.5's `safeOriginForm`.
- `canonicalAddr(text) → { v: 4|6, bytes: Uint8Array, key: string }` is the **single** classification input. It parses every IPv6 textual form
  to 16 bytes. `::ffff:0:0/96` in any spelling (`::ffff:127.0.0.1`, `[::ffff:7f00:1]`, `0:0:0:0:0:ffff:7f00:1`) unwraps to IPv4. `::/96`
  (IPv4-compatible) is denied. `classifyProxyAddr(canonical)` and the self-port check both compare canonical `key`s, never raw strings.

| Allow                                       | Deny (reason)                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `127/8`, `::1` (loopback)                   | `0/8`, `::` (unspecified); `169.254/16` incl. `169.254.169.254`, `fe80::/10` (link-local)                                                        |
| `10/8`, `172.16/12`, `192.168/16` (private) | `100.100/16` (Alibaba metadata `100.100.100.200`); `fd00:ec2::/32` (AWS IMDSv6) (metadata)                                                       |
| `100.64/10` minus `100.100/16` (cgnat)      | `224/4`, `ff00::/8` (multicast); `240/4`, `255.255.255.255`, `192.0.0/24`, `192.0.2/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24` (reserved) |
| `fc00::/7` minus `fd00:ec2::/32` (ula)      | `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `::/96` (translation); everything else (public)                                                   |

- DNS pin: `dns.promises.lookup(host, { all: true, verbatim: true })` through a 1-slot `ProxyDnsGate` (2 s caller deadline). The slot is
  held until the real lookup settles. Every answer is canonicalized and fenced. Any denied answer ⇒ `mixed-answer`; all answers denied ⇒ the first
  answer's reason. The first IPv4 is pinned, else the first IPv6. There is no per-request lookup.
- **Self-port**: if the pinned address is local (loopback, or any `os.networkInterfaces()` address read at open, canonicalized), deny
  `self-port` when the target port is the **actual bound** hub port (from `frontend.listen()`'s result, which covers the random fallback), the
  actual LAN port, or any port in the proxy range.

### 3.2 Identity, codes and sessions (`hub/proxy/sessions.ts`, pi-free, no timers)

- Mint consumes the hub `AuthIdentity` (§4.1): `{ listener, principal, sidTag, userId?, parentExpiresAt }`.
  `ProxyCode { codeHash, instanceId, origin, nextPath, principal, listener, sidTag, userId?, seq0, expAt, hardAt }` with
  `expAt = now + 60 s` and `hardAt = min(now + 12 h, parentExpiresAt)`. `ProxySession` copies the identity fields plus `sidHash, origin,
createdAt, lastUsedAt, hardAt (= code.hardAt), sockets:Set<Socket>`. Secrets are `randomBytes(32)` base64url, stored only as `sha256`.
- Caps: 16 codes per instance, 16 sessions per instance, 128 global. Overflow ⇒ refuse the new one (429). Nothing is evicted.
- Revocation: `revoke(ev: AuthRevokeEvent)` (§4.2) with `sel ∈ {sidTag}|{userId}|{listener}|{instanceId}|"all"`. It bumps `revokeSeq`, appends
  a tombstone (ring of 256), drops matching codes and sessions, and destroys their sockets (HTTP and upgraded).
  `open()` captures `seq0` before calling identity resolution. Right before inserting the code it calls `revokedSince(seq0, identity)`;
  if `seq0` is older than the oldest tombstone, it **fails closed** with 503 retryable.
- Exchange re-checks: the code is unconsumed (consumed on first presentation, even when that presentation fails), `now < expAt`,
  `now < hardAt`, `revokedSince(code.seq0)` (tombstone gap ⇒ fail closed), and the code origin = the request origin.
- Liveness: `live(s) = now < s.hardAt && now - s.lastUsedAt < 2 h`. `lastUsedAt` refreshes at each authenticated HTTP request start, and on WS
  data in either direction, throttled to once per 60 s. Bytes of a long HTTP response do not refresh it. An open but silent WS does not refresh
  it either; it dies at the WS idle limit (30 min) or at `hardAt`.

### 3.3 Port binding (`hub/proxy/ports-map.ts`): permanent, fail-closed

- `<stateDir>/proxy/ports.json` `{ v: 1, entries: [{ key: "<canonical ip>|<port>|<hostHeader>", port, boundAt }] }`. 0600. Writes go
  tmp → `fsync` → rename → dir `fsync`, single-flight, 2 s deadline. ≤ 50 entries (the range size). Loaded once at service start
  (≤ 64 KiB, 1 s).
- **Fail closed**: a missing file means empty. Unreadable, corrupt, a wrong version or a duplicate port means the store is `broken`, every
  `open` ⇒ 503 `E_PROXY_UNAVAILABLE{ports-store}`, and `/webhub status` shows a prose note. The file is never cleared or rewritten
  automatically. Recovery is manual: run `/webhub stop`, then delete the file. The docs disclose that this forgets every target↔origin binding
  and that the browser may still hold old per-origin storage for those ports.
- A binding is **permanent**: no LRU, no reassignment, no Clear-Site-Data protocol. A known target always reuses its port. A busy port
  (`EADDRINUSE` from a foreign process) ⇒ 503 `port-busy`; the target never moves. A new target takes the lowest unmapped port: try
  `listen` first, skip `EADDRINUSE` (at most 8 attempts), then **durably persist the binding before any code is issued**. A persist failure
  closes the listener, releases the reservation and returns 503. All 50 ports mapped ⇒ 409 `E_LIMIT{ports-exhausted}`.

### 3.4 Service and lifecycle (`hub/proxy/service.ts`)

- **Bind (Q2)**: `config.lan` present ⇒ bind `0.0.0.0`, the same as the LAN listener's `LAN_BIND_HOST`. Otherwise bind `127.0.0.1`.
  Why `0.0.0.0`: it is exactly the exposure the user already accepted for the LAN listener, and DHCP or interface changes don't strand
  listeners. A per-interface bind would need one server per address plus rebinding. Discipline mirrors the LAN listener:
  - Every request checks Host against `{127.0.0.1:<p>, localhost:<p>}` ∪ (`lanHostSnapshot()?.hostKeys` host parts with port `<p>`). The snapshot is
    live through a duck-typed frontend extra, so a LAN teardown at runtime drops LAN hosts to 421.
  - The listener is IPv4 + loopback only, like `canonicalHostKey`.
  - Forwarded headers are never parsed, so a request arriving through the trusted reverse proxy fails the Host check.
  - The conn-guard is direct-pool only.
  - Codes and sessions are origin-bound (`origin = "http://" + canonicalHostKey(Host)`), like LAN `bound_origin`.
- `open(identity, target, browserHost, seq0)`:
  1. Closing fence check.
  2. Synchronous **reservation**: `live + reserved < 8` globally and < 4 per principal, else 409 `E_LIMIT{proxies}`; `reserved++`.
  3. Parse + fence/DNS.
  4. Per-instance **single-flight**: `pending: Map<key, Promise<Instance>>`; concurrent opens of the same target share one creation.
  5. Port bind (§3.3) + `listen` (2 s).
  6. Code.
  7. The reservation is released in `finally` on every failure path. Each creation carries its own `abandoned` flag, set when ITS 2 s
     listen timeout fires or the fence is set; a `listen` that resolves after either (late listen) closes its own server and rejects — even
     while the service keeps running (§R2 #8). Result: `{ instanceId, origin: "http://<browserHost>:<p>", enterUrl, target: { host, port, cls } }`.
- `browserHost`: loopback mints use the request Host's host part (`127.0.0.1`/`localhost`). LAN direct mints use `ctx.hostKey`'s host part.
  A mint with `ctx.viaTrustedProxy` ⇒ 409 `reverse-proxy`.
- **Idle shutdown**: an instance with no sockets and no request for 15 min closes and is revoked `{instanceId}`; its port binding stays.
  One `setInterval(sweep, 30 s).unref()` exists only while ≥ 1 instance does.
- `stop(instanceId, identity)`: allowed for the owner principal or any loopback principal.
- `activeConnections()` is added to the idle monitor's `sse` count so a working proxy tab keeps the hub alive.
- **Closing fence** (`dispose()`, irreversible): `state = "closing"` ⇒ new opens 503, and pending opens' late listens self-close (above). Then:
  revoke `"all"`; for every instance `server.close()` + `closeAllConnections()`, destroy upgraded sockets, reject queued requests,
  `upReq.destroy()` in-flight requests, `agent.destroy()`. Bounded by the hub's 2 s close deadline.
- Hub startup: the service is constructed after `frontend.listen()` (it needs the real ports). Every startup failure path in `startHub` after
  construction calls `dispose()`.

### 3.5 Proxy listener (`hub/proxy/listener.ts`)

Server: `createServer({ maxHeaderSize: 16384, headersTimeout: 10_000, requestTimeout: 300_000, keepAliveTimeout: 5_000,
connectionsCheckingInterval: 1_000 })`, so half-sent headers are destroyed within ≤ 11 s, not ≤ 40 s. `maxRequestsPerSocket = 1000`.
Shared conn-guard `createConnGuard({ directTotalPerIp: 48, directUnauthPoolCap: 32, directUnauthPerIpCap: 8, maxConnections: 256 })`;
`socket.unref()`, `socket.setTimeout(120_000)` (non-WS). `clientError` and the CONNECT `connect` event ⇒ destroy. On socket `close`: lease
release, removal from `session.sockets`/`instance.sockets`.

Pipeline:

1. Host check (§3.4) ⇒ 421.
2. `req.url` must start with `/` and not `//` (absolute-form and `*` ⇒ 400). `TRACE`/`TRACK` ⇒ 405.
3. `GET /__pwh_proxy__/enter?c=`: per-IP bucket 20/min (bad codes count double), then the code checks (§3.2). Success ⇒ `303 Location: <nextPath>` +
   `Set-Cookie: pwh_px_<p>=<sid>; HttpOnly; SameSite=Lax; Path=/` (a browser-session cookie; TTL is enforced server-side), `Cache-Control:
no-store`, `Referrer-Policy: no-referrer`. Failure ⇒ 410 fixed page 「链接已失效，请回到 hub 重新打开」 + "Link expired". Any other
   `/__pwh_proxy__/*` ⇒ 404 and is never forwarded.
   - `safeOriginForm(path)`: take the path?query after parsing. Require a leading single `/`. Reject a leading `//`, any `\`, bytes ≤ 0x20 or
     0x7f (raw or `%00`–`%1f`/`%7f` decoded), and length > 2048. Any rejection ⇒ `/`. Since the Location is origin-form, it can never leave the proxy origin.
4. Gate cookie: resolved with `resolveCookieIdentity(header, "pwh_px_<p>", max 4, validate)` (§4.1). It must be live, belong to this instance and
   have `origin` = the request origin. Otherwise 401 with the same page, and the upstream is never contacted. Conflict ⇒ §4.1 conflict response.
5. **Gate cookie SameSite=Lax (fixed choice)**: external top-level GET navigations (links from chat or other apps, OAuth/SSO redirect callbacks,
   bookmarks) must arrive authenticated. Strict would 401 them. Lax still withholds the cookie on cross-site subresource and unsafe requests,
   and step 6 covers the same-site siblings (the hub, other proxy ports).
6. Unsafe methods (anything other than GET/HEAD/OPTIONS): if `Origin` is present and ≠ the request origin (`null` included), or `Sec-Fetch-Site`
   ∈ {`same-site`, `cross-site`} ⇒ 403, with no upstream. Absent ⇒ allowed (non-browser clients cannot hold the cookie without the exchange
   anyway). Disclosed consequence: a target that expects cross-origin POSTs (OAuth `form_post`, foreign CORS writes) does not work through the proxy.
7. Admission queue (§3.6), then forward.

Proxy-generated responses (401/403/410/421/429/5xx, enter) carry the hub's strict headers (`CSP`, `X-Frame-Options: DENY`, `nosniff`,
`no-referrer`, `no-store`). Upstream responses get no added headers.

### 3.6 HTTP forwarding (`hub/proxy/forward.ts`, `hub/proxy/headers.ts`)

- **Admission**: active upstream requests ≤ 32 per instance and ≤ 128 globally. Waiters are FIFO with a queue of ≤ 64 per instance / 256 global
  and a ≤ 10 s deadline ⇒ 503 `Retry-After: 1`. Each instance has an `http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4,
timeout: 60_000 })` and admission keeps active ≤ maxSockets, so the agent's unbounded queue is never used. Client `close` before finish
  removes the waiter or `upReq.destroy()`s the request. Revoke and dispose do the same.
- `http.request({ host: pinnedIp, port, method, path: req.url, headers, setHost: false, agent, maxHeaderSize: 16384 })`. An IP literal means
  no lookup. Redirects are **never followed** (the plain `http.request` does not follow; T-H5 asserts zero extra dials). Timers (unref'd):
  connect 5 s ⇒ 502, response head 120 s ⇒ 504, upstream idle 300 s ⇒ destroy.
- Request headers:
  - Drop hop-by-hop headers + `Connection`-listed tokens, `Proxy-*`, `X-PWH`, incoming `Forwarded`/`X-Forwarded-*`/`X-Real-IP`.
  - `Cookie`: drop every `pwh_*` pair (hub, gate and legacy cookies never reach a target).
  - `Host: <hostHeader>[:<port>≠80]`. `Origin` = request origin ⇒ rewritten to `http://<Host>`, other values unchanged.
    `Referer` with prefix `<origin>/` ⇒ prefix rewritten.
  - `X-Forwarded-For: <peer>` (replaced), `X-Forwarded-Proto: http`, `X-Forwarded-Host: <browser Host>`.
- Request body: a counting Transform with a cap of 256 MiB ⇒ 413 (head unsent) or destroy.
- Response headers:
  - Drop hop-by-hop headers and **`Clear-Site-Data`** (an upstream must not be able to wipe hub cookies or storage, since cookies are
    host-scoped).
  - `Set-Cookie` named `pwh_*` dropped; `Domain=` attribute removed.
  - `Location` (and `Content-Location`): absolute `http://A/…` **or network-path `//A/…`** where `A` ∈ the target authority set
    {`hostHeader:port`, `pinnedIp:port`, and for loopback `127.0.0.1|localhost|[::1]:port`; `:80` normalized} ⇒ rewritten to the request
    origin's authority. Relative refs and foreign authorities are unchanged.
  - 1xx informational responses are dropped.
- Bodies go through `stream.pipeline` both ways. Each stream keeps the Node 22 default highWaterMark (64 KiB, set explicitly), `pipeline`
  pauses the source while `write()` returns false, and the claim is **boundedness** (≤ hwm + one chunk buffered per direction), not a fixed byte figure.

### 3.7 WebSocket (`hub/proxy/ws.ts`)

`server.on("upgrade", (req, socket, head))`:

- A 10 s destroy deadline is armed **immediately**. It covers auth, the upstream handshake and the late-upgrade case, and is cleared only after
  the 101 has been written.
- Checks, in order:
  1. §3.5 steps 1, 2, 4.
  2. **`Origin` must equal the request origin exactly** before anything touches upstream. A missing Origin or `null` ⇒ 403; browsers always
     send Origin on WS.
  3. `GET`, single-token `Upgrade: websocket`, `Sec-WebSocket-Key` present; other upgrades (`h2c`) ⇒ 400.
  4. Caps: 32 WS per instance, 64 globally ⇒ 503.
     Rejections write a minimal HTTP response, then `destroy()`.
- Upstream: `http.request({…, headers: filterRequestHeaders(…, { ws: true }) /* keeps Upgrade/Connection/Sec-WebSocket-* */, agent: false })`.
  - On `upgrade (upRes, upSock, upHead)`: write `101` + filtered response headers (same drops, incl. `Clear-Site-Data` and `pwh_*` cookies),
    flush `head`/`upHead` to the opposite sides, then `pipe` both directions with `setNoDelay(true)`. Each side has `setTimeout(30 min)` ⇒
    destroy both. Error or close on either side destroys the other and removes both from `session.sockets`/`instance.upgraded`.
  - On `response` (non-101): relay status + **filtered** headers + up to 64 KiB of body, then end.
- Revocation, `hardAt`, stop and dispose destroy live WS. Frames are never parsed.

### 3.8 Hub API (`hub/proxy/routes.ts`)

| Route                  | Gate                                                                      | Result                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/proxy/open` | `strictCsrfOk` → `resolveIdentity` → bucket 10 / +1 per 6 s per principal | `{target}` ≤ 2 KiB ⇒ 200 `ProxyOpenResult` · 400/403 `E_PROXY_DENIED{reason}` · 409 `E_LIMIT`/`E_PROXY_UNAVAILABLE` · 503 |
| `GET /api/proxy`       | `X-PWH: 1` → `resolveIdentity`                                            | `{ items: [{ instanceId, target:{host,port,cls}, origin, createdAt, mine }], policy: { maxProxies, portRange, lan } }`    |
| `POST /api/proxy/stop` | as open                                                                   | `{instanceId}` ⇒ 200 · 404                                                                                                |

Dispatch: loopback `handleApi` after the headless branch, and the LAN `/api` handler at the same spot, both only when `proxyRoutes` exists
(LAN additionally requires `config.lan`, which holds by construction). Deny reasons (closed set, `protocol/proxy.ts`):
`syntax|scheme|userinfo|port|public|link-local|metadata|multicast|reserved|translation|unspecified|mixed-answer|dns-failed|dns-timeout|
self-port|port-busy|ports-exhausted|ports-store|reverse-proxy`.

## 4. Hub-side changes

### 4.1 One identity-resolution API (`hub/auth-identity.ts`, NEW)

```ts
type AuthIdentity = { listener: "loopback" | "lan"; principal: string; sidTag: string; userId?: number; parentExpiresAt: number;
  /* loopback only, never leaves the hub process */ sid?: string; lan?: LanSessionResult };
type IdentityResult = { ok: true; id: AuthIdentity } | { ok: false; code: "E_AUTH" | "E_DB" | "E_RATE"; conflict?: true };
function resolveCookieIdentity<T>(header, name, max, validate: (v) => T | undefined | Promise<…>): { kind: "none" } | { kind: "one", value, rec: T } | { kind: "conflict" };
```

- Loopback `auth.resolve(cookieHeader, now)` replaces the internals of `auth.check`, which becomes `resolve().ok`. It returns
  `{ sid, sidTag: hashSid(sid), expiresAt }`, sliding as today. The LAN equivalent is inside `requireLanSession`/`checkLanSession`:
  `parentExpiresAt = min(expiresAt, absoluteExpiresAt)`.
- **Every** consumer takes `principal`/`sidTag`/`userId`/`sid` from the result; nothing re-parses `Cookie`. Migrated in package XA:
  - all 17 `auth.check` sites;
  - load/version principals (~3035/3042);
  - **HTML-cap authorize** (~3096, which today calls `auth.check` and then re-reads the first cookie);
  - loopback logout (~3305, which logs out the resolved `sid`; no identity ⇒ cookie clear only);
  - LAN `requireLanSession` (returns `sidHash` from the resolution) + `checkLanSession` + the LAN logout `sidHash`.
- Candidates (only matters when several same-name cookies arrive):
  - `max = 1` when `config.proxy` is absent: first value, byte-identical to today.
  - When the proxy is wired: loopback `pwh_sid` max 8, LAN `pwh_lan` max 3 (each one is a shared `touchSession` IPC), proxy gate max 4.
  - Exactly one **distinct valid** identity ⇒ use it; invalid candidates are ignored.
  - ≥ 2 distinct valid identities, or more candidates than `max` ⇒ **conflict**: 401 `E_AUTH` + `{ reason: "cookie-conflict" }` + clearing
    `Set-Cookie`s for `name` at the directory-segment path prefixes of the request path (≤ 8 prefixes × {host-only, `Domain=<host>`}, ≤ 16
    lines). This clearing is **best-effort** (§R2 #4): a shadow cookie may use a non-segment Path prefix (`/ap` for `/api`) or a parent-domain
    `Domain=`, which these lines can't name — so re-login is NOT guaranteed to recover. The UI shows 「检测到重复的登录 Cookie，已尝试清除；若重新
    登录后仍出现，请在浏览器里清除本站 Cookie」 with the manual recovery steps (site settings → cookies for this host). Tests cover non-segment
    Path and parent Domain shadows (cleared lines miss them ⇒ conflict persists ⇒ the manual-recovery copy is shown).
- Disclosed residual (no "defeats" claim):
  - Any script or HTTP response on **any** same-host origin can set `pwh_*` cookies with a narrower Path. That includes proxied apps (the proxy
    strips upstream `Set-Cookie: pwh_*`, but page JS can still do it) and other local services the user browses directly, which already exist
    today without the proxy.
  - With the proxy enabled this can force a logout (conflict or overflow ⇒ re-login). It cannot silently swap a **logged-in** user into another
    identity (≥ 2 valid ⇒ refused).
  - It **can** log a user who has no valid own session into an attacker's valid LAN session. That needs a LAN account and script on a
    same-host origin; the LAN UI shows the username.

### 4.2 Revocation bus (`hub/auth-revoke.ts`, NEW)

`type AuthRevokeEvent = { sel: {sidTag} | {userId} | {listener: "loopback"|"lan"} | "all"; reason: "logout"|"passwd"|"rotate"|"close" }`;
`createAuthRevokeBus(log) → { subscribe(fn): () => void; emit(ev): void }`. `emit` is synchronous; each subscriber runs in its own
`try/catch` (an exception is logged and the rest still run), in subscription order.

- `createHttpFrontend` creates the bus and subscribes `previewRoutes.revokeHtmlCaps` **itself, unconditionally** (independent of the proxy
  setting). Every existing `previewRoutes?.revokeHtmlCaps?.(sel, reason)` call is replaced 1:1 by `bus.emit({sel, reason})` **at the same
  position and in the same order**: LAN logout emits before `await deleteSession` **and again after it**, then `lanSse.revoke`. Facade `revoke`
  emits before `lanSse.revoke`. `revokeAll` emits, as does `revokeAllSse`. Loopback logout emits after `auth.logout`.
- `hub.ts` subscribes `proxyService.revoke` via the duck-typed extra `subscribeAuthRevoke(fn)` only when `config.proxy`, and calls the
  returned unsubscribe on close.

### 4.3 Hub `/api` cross-site gate (only when `config.proxy`)

The proxy origin is same-site with the hub, because ports are ignored by schemeful site. So `SameSite=Strict` `pwh_sid`, or a non-Secure `pwh_lan`,
**is** attached to requests that proxied pages make to the hub. A Secure `pwh_lan` (HTTPS reverse-proxy entry) is not. Protections:

- (P1) There is no ACAO anywhere ⇒ no cross-origin reads.
- (P2) Writes need JSON/octet-stream + `X-PWH` ⇒ preflight ⇒ `OPTIONS` 404 ⇒ never sent. Simple POSTs fail the Content-Type and Origin checks.
- (P3) Cookie-only GETs are side-effect free; SSE open is resource use only.
- (P4, new) `apiCrossSiteOk(req, expectedOrigin)` runs at the top of loopback `handleApi` and the LAN `/api` branch, **after** the `OPTIONS`
  short-circuit (OPTIONS keeps its exact 404, no ACAO, on both listeners):
  - `Sec-Fetch-Site` present and ∉ {`same-origin`, `none`} ⇒ 403 `E_CSRF`;
  - `Origin` present and its canonical form ≠ the listener origin ⇒ 403;
  - both absent ⇒ pass (old browsers, CLI).
- (P5) The §4.1 conflict handling.
- (P6) The hub has no `upgrade` handler.
- Residual (disclosed): an engine that sends neither Fetch Metadata nor Origin on a no-cors subresource (e.g. Safari < 16.4,
  `<img src=…/api/events>`) can still make a proxied page open cookie-bearing SSE streams that consume the LAN SSE caps (32 global / 8 per sid).
  This is availability only; the data is unreadable under P1.
- Config off ⇒ no P4, `max = 1`, no bus subscriber beyond preview, so the hub is byte-identical.

## 5. Settings, gating, caps

- `webHub.proxy = { enabled: false, portRange: "7900-7949", maxProxies: 8 }` in `config/settings.ts` + `config/setting-specs.ts`. Non-live.
  An invalid range (overlaps the hub/LAN port, or > 256 ports) or `maxProxies` ∉ 1..16 ⇒ default + warning. TTLs are fixed constants in
  `protocol/proxy.ts` (Q4), not settings.
- `HubConfig.proxy?: { portRange: [number, number]; maxProxies: number }`, written by `buildHubConfig` only when `enabled && control !== false`.
  `hub/main.ts` `normalizeHubProxyConfig` drops the key if malformed. LAN reach is derived from `config.lan` (Q2); the proxy has no LAN field.
- Caps (`protocol/version.ts`): `PROXY_HUB_CAP = "proxy.v1"` iff `config.proxy`, and `PROXY_LAN_HUB_CAP = "proxy.lan.v1"` iff `config.proxy &&
config.lan`. Both go into `extraHubCaps`. No frames, no PROTO bump.
- `/webhub status` line (`agent/proxy-status.ts`): `proxy: on · lan · 7900-7949 · max 8`, plus a prose note on `ports-store` broken.

## 6. Reverse proxy and tunnels (documented limitations)

- Trusted reverse proxy (`externalOrigins`, HTTPS): mint ⇒ 409 `reverse-proxy`. Per-port origins would need the reverse proxy to publish
  every port with TLS. A single-port path fallback is rejected, because target JS would run on the hub origin. Future work: a
  `publicOrigins` port map.
- SSH tunnel to the loopback hub: proxy ports must be forwarded too (`-L 7900:127.0.0.1:7900 …`). The dialog shows the origin.

## 7. Logging

- `proxy-open {ok, reason, principal, listener, cls, target:"<ip>:<port>", host?, port}`.
- `proxy-end {instTag, end, reqs, bytesUp, bytesDown, ws}` per session and per instance.
- Denials are throttled to one line per instance per 60 s.
- Never logged: paths, queries, headers, cookies, codes, sids. Proxy listener catch-alls log `errCode(err)` only, never `req.url`.

## 8. UI (trimmed v1)

- `logic/proxy.js` (first screen, ≤ 1 KiB gz):
  - `proxyScopeOf(caps, transport)` uses `proxy.v1` for token auth and `proxy.lan.v1` for password auth.
  - `findProxyUrlRefs(text)` matches `http://` + IP literal in loopback/private/cgnat/ULA or `localhost`, `:port` and an optional path; trailing
    punctuation is trimmed, and hostnames are not auto-recognised.
  - `isProxyableHref(href)`.
- `PathText.vue` renders non-path plain segments that match as `a.proxy-ref[href=original]`. `MdInline.vue` links matching `isProxyableHref`
  get the same interception. No scope ⇒ identical DOM. Streaming suppression follows `PATH_REFERENCES_SUSPENDED`.
- `useProxyOpen`:
  1. Synchronously `w = window.open("about:blank", "_blank")`, which keeps user activation (Safari).
  2. `POST /api/proxy/open`.
  3. Success ⇒ `w.opener = null; w.location.replace(enterUrl)`. Error ⇒ `w.close()` + a prose toast. `w === null` ⇒ the dialog shows the
     link as `<a target=_blank rel="noopener noreferrer">`.
- **One management entry**: a TopBar icon button (visible iff a scope exists) opens the lazy `components/proxy/ProxyDialog.vue`. It holds the
  `host:port` input + open button, and a basic list (target, origin, 「打开」, 「停止」) fetched when the dialog opens and after each action
  (no polling), plus the prose LAN, tunnel and reverse-proxy notes.
- i18n `i18n/{zh,en}/proxy.ts`. Budget ≈ 3 KiB gz lazy.

## 9. Tests

Hub pure (X1a):

- **T-F1** fence corpus `tests/fixtures/proxy-ssrf-corpus.json`:
  - Allowed: `127.0.0.1:1`, `[::1]:3000`, `localhost:5173`, `10.0.0.1`, `172.16.0.1`, `172.31.255.255`, `192.168.31.25`, `100.64.0.1`, `[fd12::1]`.
  - Mapped forms that classify as loopback: `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[0:0:0:0:0:ffff:7f00:1]`.
  - Denied:
    - public: `172.32.0.1`, `8.8.8.8`, `[2001:db8::1]`;
    - metadata: `169.254.169.254`, `100.100.100.200`, `[fd00:ec2::254]`;
    - translation: `[::ffff:a9fe:a9fe]` (mapped metadata, link-local), `[64:ff9b::7f00:1]`, `[64:ff9b::a00:1]`, `[64:ff9b:1::1]`,
      `[2002:7f00:1::]`, `[::7f00:1]`;
    - multicast / reserved / unspecified: `0.0.0.0`, `[::]`, `224.0.0.1`, `255.255.255.255`.
  - Syntax: `0x7f.0.0.1`, `2130706433`, `127.1`, `0177.0.0.1`, `127.0.0.1.`, `unix:/run/x.sock`, `/run/pi-webhub.sock`, `https://…`,
    `user@…`, missing port, `:0`, `:65536`, `:080`.
- **T-F2** DNS (scripted seam): mixed answer ⇒ `mixed-answer`; all-denied ⇒ the first answer's reason; timeout keeps the slot held until settle;
  rebinding ⇒ the pinned IP is still dialed and there is zero per-request lookup.
- **T-F3** headers:
  - Cookie `a=1; pwh_sid=x; pwh_lan=y; pwh_px_7901=z; b=2` ⇒ `a=1; b=2`.
  - `Clear-Site-Data` dropped on normal, 101 and non-101 WS responses; `Set-Cookie: pwh_lan=…` dropped; `Domain` stripped.
  - Location matrix: absolute and `//` same-target ⇒ rewritten; foreign absolute and `//` ⇒ unchanged; relative ⇒ unchanged; `:80` normalized.
  - `safeOriginForm` corpus: `//evil`, `/\evil`, `\\evil`, `/%0d%0aSet-Cookie:x`, `/%00`, `/a b`, 2049-B path ⇒ `/`; `/a?b=c` kept.
- **T-F4** sessions:
  - `hardAt = min(12 h, parent)` (parent sooner ⇒ parent wins), re-checked at exchange; one-time code; caps refuse, never evict.
  - Revoke selectors; tombstone gap ⇒ 503; idle refresh rules (HTTP request start yes, response bytes no, WS data throttled 60 s); no timers.
- **T-F5** ports-map:
  - Sticky reuse; lowest unmapped; `EADDRINUSE` skip for new targets and `port-busy` for a mapped target; exhausted ⇒ 409, never reassigned.
  - Persist-before-code (a failing write ⇒ listener closed, reservation released, no code).
  - Corrupt / unreadable / duplicate ⇒ `broken` and the file is untouched (byte-compare). Atomic + fsync order (spy). 0600.

Hub engine and wiring (X1b/X1c, real frontend + `tests/fixtures/proxy-upstream.ts`: echo, redirects, Set-Cookie/Clear-Site-Data, sink, slow
head, raw-upgrade WS echo):

- **T-H1** open → enter → 303 (Location = `safeOriginForm`) → Lax cookie → echo. The upstream saw `Host: 127.0.0.1:<up>` and no `pwh_*`.
  No cookie, a foreign-port cookie or another instance's session ⇒ 401 with zero upstream connections. A reused code ⇒ 410.
- **T-H2** Host: `evil.com:<p>` ⇒ 421. With LAN on, a snapshot host ⇒ ok; after a LAN teardown ⇒ 421. With LAN off the listener is bound to
  `127.0.0.1` (assert `server.address()`).
- **T-H3** WS:
  - echo; Origin missing, `null` or another proxy's origin ⇒ 403 with zero upstream connections; `h2c` ⇒ 400; non-101 relay is filtered;
    the 33rd WS ⇒ 503.
  - Handshake not completed (client that stalls before the upgrade is accepted, upstream that never answers the handshake) ⇒ destroyed at
    10 s (≤ 11 s under normal event-loop scheduling). After a successful 101 the handshake timer is cleared and the 30 min WS idle / session
    deadline applies instead — a quiet but established WS is NOT destroyed at 10 s (§R2 #11).
  - A paused reader keeps the proxy's buffered bytes ≤ hwm + one chunk per side (instrumented `writableLength`/`readableLength`).
  - An error on either side destroys both and empties the sets; revoke mid-stream closes both.
- **T-H4** budgets: header > 16 KiB ⇒ 431; half headers destroyed ≤ 11 s; 300 parallel requests ⇒ ≤ 32 active per instance, 64 queued, the
  rest 503; the queue deadline 10 s ⇒ 503; a client abort while queued ⇒ the waiter is removed; a client abort in flight ⇒ upstream destroyed
  (spy); body > 256 MiB ⇒ 413; connect refused ⇒ 502; slow head ⇒ 504; the 9th proxy ⇒ 409.
- **T-H5** absolute-form `GET http://8.8.8.8/` and CONNECT ⇒ 400/destroyed. An upstream 302 to `http://10.0.0.9/` ⇒ relayed unchanged, with
  **zero** dials to anything except the pinned target.
- **T-H6** unsafe methods: POST with `Origin` = own ⇒ forwarded; foreign, `null` or `Sec-Fetch-Site: same-site` ⇒ 403; absent ⇒ forwarded.
- **T-H7** lifecycle:
  - Concurrent opens of one target ⇒ one listen (single-flight). Concurrent opens of 9 targets ⇒ exactly 8 succeed (reservation).
  - Failures at every stage release the reservation (`reserved === 0` afterwards).
  - Dispose during a pending listen ⇒ the late listen self-closes.
  - Per-creation listen timeout while the service stays up (no dispose) ⇒ the late listen still self-closes, reservation released.
  - Dispose with in-flight, queued and upgraded traffic ⇒ all destroyed ≤ 2 s and fd/handle baseline restored.
  - Startup failure after construction ⇒ disposed. Idle 15 min ⇒ closed and the binding kept. The idle monitor counts proxy connections.
- **T-H8** gating:
  - Proxy off ⇒ the `/api/proxy*` matrix is byte-identical to today, no cap, no P4, `max = 1`, no `ports.json`.
  - LAN off ⇒ no `proxy.lan.v1`, LAN routes absent, loopback bind.
  - Via-trusted-proxy mint ⇒ 409.
  - Real fallback port: occupy the configured hub port ⇒ the hub binds a random port ⇒ a proxy to `127.0.0.1:<actual>` ⇒ `self-port`.
- **XA tests** (`tests/web-hub/http/auth-identity.test.ts`, `auth-revoke.test.ts`):
  - Every migrated site takes identity from the single result (spy: `readCookie` is never called outside `auth-identity.ts`).
  - HTML-cap `sidTag` = the authenticating sid when a junk duplicate comes first.
  - Conflict and overflow ⇒ 401 + the exact clearing `Set-Cookie` set. LAN `pwh_lan` with one valid and two junk values ⇒ accepted, ≤ 3 IPC calls.
  - A proxy-off duplicate ⇒ first-value behavior, byte-identical.
  - Bus order: the LAN logout emit sequence is `[before-delete, after-delete]`, then SSE.
  - Eventual revocation across the delete await (§R2 #6): a mint/code issued between the first emit and the session delete may succeed, but
    after the second emit every cap/code minted in that window is invalid (next use ⇒ 401/404); no in-window mint is guaranteed to fail
    up front.
  - A throwing subscriber ⇒ other subscribers still run.
  - Proxy off ⇒ HTML caps are still revoked on all five paths.
- **T-A1** hub safety, both listeners, with proxy on:
  - Valid hub cookie + `Origin: http://H:7901` / `Sec-Fetch-Site: same-site` ⇒ every `/api` GET and POST is 403.
  - No headers ⇒ the legacy matrix, and still no ACAO.
  - `OPTIONS` with a foreign Origin ⇒ 404 without ACAO (precedence).
  - WS to the hub port is closed.
- **T-A2** log redaction across T-H1…T-H7: no code, sid, path, query or cookie value in the captured `HubLog`.
- **T-I1** integration (real hub child + fake upstream): open/WS/stop; `/webhub stop` closes listeners; after a restart the port is the same
  and old cookies get 401.

UI (X2): **T-U1** URL recognition corpus; **T-U2** PathText/MdInline: identical DOM without a scope, interception with one; **T-U3** open flow:
sync blank window, opener nulled, replace, error closes it, popup-blocked fallback; **T-U4** dialog list/open/stop, no polling; **T-U5**
transport contract + `API.*`.

## 10. Real-browser acceptance (`acceptance.md`, blocking)

Two engine sets: **(A) headers present** (Chrome, Firefox, Safari ≥ 16.4) and **(B) headers absent** (`curl` scripts with the cookie copied,
simulating old engines).

1. A Vite dev server with HMR over WS; Jupyter token login + kernel WS; a LAN NAS by IP and by `nas.local` (pinned).
2. Entry flows: the message URL `http://127.0.0.1:23434/` opens a tab (Safari, no popup block); the first enter ⇒ 303 lands on the path; an
   **external link** to the proxy origin (from another site, gate cookie already set) ⇒ authenticated (Lax); an **OAuth/SSO-style callback** (a
   fake IdP on another origin, 302 back to `/callback?code=`) ⇒ authenticated.
3. A probe page through the proxy (`tests/fixtures/proxy-probe.html`), verdicts read via deveye; the (A) set is expected to block, (B) to show
   only the disclosed residual:
   1. credentialed fetch and EventSource to the hub `/api` ⇒ 403 and the hub SSE count unchanged;
   2. a `text/plain` form POST to `/api/cmd` ⇒ 403 with the ledger unchanged;
   3. WS to the hub fails;
   4. proxy A's page opens a WS to proxy B with **both sessions live** ⇒ 403, and B's upstream sees no connection;
   5. `document.cookie` lacks `pwh_*`.
4. Cookie injection matrix: JS plants `pwh_sid` / `pwh_lan` with `Path=/api`, `Path=/api/history`, `Domain=<host>`, and 9 candidates.
   - Expected: junk with one valid ⇒ still logged in; 9 candidates ⇒ conflict, cleared, re-login works.
   - An **attacker-valid LAN sid** planted while the victim is logged in ⇒ conflict (never a swap).
   - The no-own-session case is recorded as the disclosed residual.
5. A malicious upstream sends `Clear-Site-Data: "cookies","storage"` on a page, on a non-101 WS answer and with `Set-Cookie: pwh_sid=…; Path=/`
   ⇒ the hub tab stays logged in.
6. Logout in the hub tab, LAN passwd, token rotate ⇒ the proxy tab gets 「链接已失效」 and WS closes; stop in the dialog ⇒ the WS closes.
7. A reverse-proxy entry ⇒ 409 + prose; LAN off ⇒ the proxy port is unreachable from another host.

## 11. Threat model

| Threat                                        | Mitigation                                                                               | Tests                | Residual                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| SSRF (metadata, public, socket paths)         | canonical-bytes fence, strict grammar, TCP only, no forward mode, no redirect following  | T-F1, T-H5           | private VPC services reachable by design (F3)                |
| DNS rebinding of the target / to a proxy port | resolve once + pin; Host allow-list                                                      | T-F2, T-H2           | —                                                            |
| Unauthenticated proxy use                     | one-time hashed code → origin+instance-bound Lax cookie; 401 before upstream             | T-H1                 | code in history until consumed                               |
| Cross-port CSRF / CSWSH (hub, other proxies)  | unsafe-method + WS Origin enforcement; Lax                                               | T-H3, T-H6, gate 3.4 | foreign-origin POST callbacks unsupported                    |
| Proxied page uses the hub API                 | P1–P6                                                                                    | T-A1, gate 3         | no-Origin/no-Metadata SSE exhaustion (old engines)           |
| Hub cookie leak / clobber via a target        | `pwh_*` stripped both ways; `Clear-Site-Data` dropped                                    | T-F3, gate 5         | —                                                            |
| Same-host cookie injection                    | single identity resolution, conflict ⇒ refuse + clear                                    | XA, gate 4           | forced logout; no-session login into an attacker LAN session |
| Origin reuse across targets                   | permanent bindings, fail-closed store                                                    | T-F5                 | manual store reset forgets bindings (disclosed)              |
| LAN users reach loopback services             | follows `webHub.lan` (Q2); Host list + LAN-consistent discipline                         | T-H2, T-H8           | by design when LAN is on                                     |
| Revocation gaps                               | bus at the identical sites/order, seq0 + tombstone fail-closed, parent-bounded hardAt    | XA, T-F4             | —                                                            |
| DoS                                           | conn-guard, 1 s checking interval, request queue, WS caps, handshake deadlines, DNS gate | T-H3, T-H4           | large downloads are unbounded in bytes, bounded by timeouts  |
| Log leaks                                     | §7 whitelist                                                                             | T-A2                 | —                                                            |

## 12. Packages (exclusive file domains)

- **X0 frozen surface** (blocks everything):
  - NEW `protocol/proxy.ts` (paths, `PROXY_RESERVED_PREFIX="/__pwh_proxy__/"`, cookie prefix, every limit/TTL, deny reasons, bodies);
  - `protocol/version.ts` (2 caps);
  - `hub/ports.ts` (`HubConfig.proxy?`, `ProxyService`, `ProxyRoutes`, `AuthIdentity`, `AuthRevokeEvent` types);
  - `config/{settings,setting-specs}.ts`;
  - `ui/src/types.ts`, `ui/src/transport/types.ts`, `ui/src/logic/contract.js`.
  - Test `tests/web-hub/protocol/proxy.test.ts`.
- **XA auth identity + revoke bus** (after P1b lands; independent of X1): NEW `hub/auth-identity.ts`, NEW `hub/auth-revoke.ts`; `hub/auth.ts`
  (`resolve`), `hub/lan-auth.ts` (`checkLanSession` via the resolver), `hub/http.ts` (all identity consumers incl. the HTML-cap authorize,
  bus emits at the five sites, `subscribeAuthRevoke` extra, P4 gate wiring behind a `crossSiteGate` flag). XA tests.
- **X1a hub pure** (after X0): NEW `hub/proxy/{target,headers,sessions,ports-map,dns-gate,audit}.ts`. Tests T-F1…T-F5.
- **X1b hub engine** (after X1a): NEW `hub/proxy/{listener,forward,ws,service}.ts` + `tests/fixtures/proxy-upstream.ts`. Tests T-H1…T-H7.
- **X1c hub wiring** (after XA + X1b): NEW `hub/proxy/routes.ts`; `hub/http.ts` (route dispatch, `lanHostSnapshot()` extra, enable
  `crossSiteGate` + candidate max when proxy is wired), `hub/hub.ts` (construction after listen, caps, idle count, bus subscription, dispose on
  close and on startup failure), `hub/main.ts`, `agent/index.ts` (`buildHubConfig`), NEW `agent/proxy-status.ts`. Tests T-H8, T-A1, T-A2,
  `caps-coexist`/`deadline-nesting` additions.
- **X2 UI** (after X0, in parallel with X1/XA): NEW `logic/proxy.js`, `composables/useProxyOpen.ts`, `components/proxy/ProxyDialog.vue`,
  `i18n/{zh,en}/proxy.ts`; `PathText.vue`, `MdInline.vue`, `TopBar.vue`, `logic/{token,password}-client.js`, `transport/{token,password}.ts`.
  Tests T-U1…T-U5; `build:web` + `check:web`.
- **X3 integration** (main session): T-I1, `acceptance.md` + the §10 gate, AGENTS.md web-hub paragraph, full gate.

## 13. Open sign-offs

None. Q1–Q4 and F1–F5 are fixed in §0.

## §R1 处置表（评审 gpt-6.1-sol，REVISE；主会话裁定 15 项全部采纳）

| #   | 级别    | 评审项                                        | v2 处置                                                                                                                                                                             |
| --- | ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 跨目标端口重分配 + Clear-Site-Data 协议不安全 | 删除 LRU/重分配/marker cookie/Clear-Site-Data 协议；端口↔目标永久绑定，耗尽 ⇒ 409；绑定先持久化（fsync+rename）再发链接；损坏/写失败 fail-closed、不清空（§3.3、T-F5）              |
| 2   | Blocker | 认证与身份分别解析（首值 cookie 重读）        | 新 `auth-identity.ts` 单一解析结果，auth/principal/sidTag/logout 全部消费；XA 迁移全部 17 处 + 已落地 HTML-cap authorize（~3096）；在 P1b 落地后执行（§4.1、XA 测试）               |
| 3   | Blocker | WS 缺 Origin 校验（跨端口 CSWSH）             | upgrade 必须 `Origin` 等于当前代理 origin，缺失/`null` ⇒ 403，均在接触上游前；测试 A 页 → B WS 双会话存活（§3.7、T-H3、验收 3.4）                                                   |
| 4   | Major   | 「防 cookie tossing」说法不成立               | 删除该说法；定义多候选：唯一有效即用，≥2 有效或超额 ⇒ conflict 401 + 按路径前缀清除并重新登录；浏览器 Path/Domain/多候选/攻击者有效 LAN SID 测试；披露同主机残余（§4.1、验收 4）    |
| 5   | Major   | 上游 Clear-Site-Data 可登出 hub               | 普通响应、101、WS 非 101 一律剥离 `Clear-Site-Data`；浏览器验证（§3.6–3.7、T-F3、验收 5）                                                                                           |
| 6   | Major   | 撤销扇出可能改变顺序/丢调用                   | 同步类型化事件 `{sel, reason}`，逐订阅者异常隔离；1:1 原位替换（LAN logout 删除前后各一次）；HTML 订阅不依赖代理开关；回归测试（§4.2、XA 测试）                                     |
| 7   | Major   | 父会话到期未传递                              | code/session `hardAt = min(12h, parentExpiresAt)`，兑换时复核；tombstone 断档 fail-closed；明确 idle 刷新规则（§3.2、T-F4）                                                         |
| 8   | Major   | 容量/端口竞态、生命周期泄漏                   | 同步预留 + 每实例 single-flight + 全失败路径释放；迟到 listen 自关；不可逆 closing 栅栏覆盖 agent/队列/升级 socket；启动失败清理（§3.4、T-H7）                                      |
| 9   | Major   | 无请求并发上限，Agent 队列无界                | 每实例 32 / 全局 128 活跃 + 有界 FIFO 队列（64/256，10s）；断开/超时/撤销取消排队与上游；关闭 socket 移出集合（§3.6、T-H4）                                                         |
| 10  | Major   | nextPath 开放重定向；Location 漏网络路径引用  | `safeOriginForm`（`//`、`\`、控制字符、长度）；同目标绝对与 `//` 引用均改写，外部不动；服务器端从不跟随重定向（零额外拨号断言）（§3.5–3.6、T-F3、T-H5）                             |
| 11  | Major   | 半包/握手无销毁期限，32 KiB 断言不实          | `connectionsCheckingInterval: 1000`（半头 ≤11s）；upgrade 立即挂 10s 销毁期限；显式流参数；只主张有界；缓冲/背压/迟到升级/错误清理测试（§3.5–3.7、T-H3–4）                          |
| 12  | Major   | Sec-Fetch-Site 门过严且未覆盖 Origin          | 头缺失放行；新增 Origin 不符拒绝；OPTIONS 404 优先；披露无 Origin/无 Metadata 的 SSE 资源耗尽残余；验收分有头/无头两组（§4.3、T-A1、验收）                                          |
| 13  | Minor   | 地址分类不统一                                | `canonicalAddr` 统一字节规范化（含 `[::ffff:7f00:1]` 等）、自端口按规范键比较且用实际绑定端口；NAT64/全拒 DNS 负例；真实回退端口测试；仅 TCP，拒 Unix socket（§3.1、T-F1/F2、T-H8） |
| 14  | Minor   | Strict/Lax 取舍未明确                         | 选 Lax 门 cookie + 不安全方法/WS 的 Origin 强制；浏览器测试外部链接、登录回调、首次 enter → 303（§3.5、验收 2）                                                                     |
| 15  | Minor   | v1 范围过大                                   | 去掉重分配协议、设置卡片、轮询与流量统计；仅保留一个 TopBar 入口 + 基础 打开/停止 列表；设置项缩为 3 个（§5、§8）                                                                   |

## §R2 主会话裁定（评审第 2 轮 REVISE，按评审收敛规则由主会话闭合，不开第 3 轮）

| #                       | 残留点                                                   | 处置                                                                                                          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4                       | 「清除所有 shadow cookie」不成立（非段 Path、父 Domain） | 改为 best-effort 清理 + 手动恢复步骤文案；补非段 Path / 父 Domain 测试，不再承诺重登即恢复（§4.1）            |
| 6                       | 删除窗口内 mint 必为 401 无法保证                        | 改为最终撤销语义：第二次 emit 后窗口内生成的 cap/code 全部失效；测试相应改写（§8）                            |
| 8                       | 迟到 listen 只在全局 closing 时自关                      | 每次创建独立 `abandoned` 标记（本次 2 s 超时或 fence），服务不 dispose 时迟到成功同样自关；补测试（§3.4、§8） |
| 11                      | 101 后静默 WS 被要求 10 s 销毁，与 30 min idle 冲突      | 区分握手未完成（10 s）与已 101（30 min idle / 会话期限）（§8）                                                |
| 1–3, 5, 7, 9, 10, 12–15 | —                                                        | 评审第 2 轮确认 closed                                                                                        |
