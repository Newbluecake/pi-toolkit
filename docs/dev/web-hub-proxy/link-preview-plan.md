# web-hub proxy: in-page link preview + wider link recognition — plan r2 (2026-10-19)

Requirement (user, 2026-10-19). Context: the hub runs on an internal network, reached over VPN, with LAN password auth over plain HTTP,
`webHub.proxy` on (ports 7900-7949), sole user.

1. Clicking a recognized intranet link opens an **in-page preview dialog** that iframes the proxied origin. The dialog always offers
   「新标签打开」 and reuses the popup-blocked fallback.
2. Recognition widens to scheme-less `host:port` and port-less `http://` links. **IP literals and `localhost` only.**

Lane **L2**. Base design: `plan.md` v2 + §R1/§R2. r1 → r2: the user/main-session rulings are folded in (§0) and the 8 review findings
(`link-preview-review-r1.md`) are closed (§10). Every package goes to an independent verifier before its commit.

## 0. Decisions (rulings folded in; authoritative)

| #   | Decision                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | New additive cap `proxy.frame.v1`, declared iff `proxy.v1` is. Only with it does a click open the dialog (compatibility tiers: §4.1)                                                                                                               |
| D2  | **Upstream `X-Frame-Options` / CSP `frame-ancestors` pass through untouched** (user ruling). An app that forbids embedding shows blank or refused in the dialog. A standing hint sits next to the always-present 「新标签打开」                    |
| D3  | **Proxy-generated** responses (the enter 303 and every error page answered after Host validation) carry `frame-ancestors 'self' <hubOrigins>` and no XFO. An unverified Host (421) and WS rejections keep today's strict headers (§2.2)            |
| D4  | The hub UI CSP gains `frame-src 'self' http://*:<p>` for every port in `deps.config.proxy.portRange` (no new dep). Proxy off ⇒ byte-identical `CSP`                                                                                                |
| D5  | iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`, never `allow-top-navigation*`, never `credentialless` (ruling 2)                                          |
| D6  | Repeated opens **reuse the browser's existing gate session**: enter with a live, same-identity gate cookie consumes the code but mints no new session and sets no cookie (§3). Caps are unchanged and nothing is evicted                           |
| D7  | Recognition: IP literals (private/loopback/cgnat/ULA classes) + `localhost` only; **no hostnames** (ruling 3). Port-less `http://` is normalized to `:80` in the UI (ruling 5). Scheme-less needs port ≥ 10 and excludes non-HTTP ports (ruling 6) |
| D8  | Dialog on all devices, full-screen ≤ 767 px. Ctrl/Meta-click ⇒ today's new-tab flow (ruling 4)                                                                                                                                                     |
| D9  | Hub refusal ⇒ the existing inline note / dialog error with the reason, plus a native 「直接打开原链接」 anchor. No automatic navigation                                                                                                            |

Not a security boundary: `allow-popups-to-escape-sandbox` lets the app's popups run unsandboxed. The sandbox only keeps the framed app
from navigating or reaching the hub page. It is never presented as a sandbox for malicious apps.

## 1. Code facts (verified 2026-10-19; further citations inline in §2-§5)

- **UI recognition** (`logic/proxy.js`):
  - `HOST`/`URL_SOURCE` (:56-57) require `http://` + a port. `TRAIL_RE` (:59) is ASCII only.
  - The IPv6 regex (:67-72) accepts `fd12:1`, which the hub's `isIP` (`target.ts:157`) rejects.
  - Left guard at :108.
  - `logic-proxy.test.ts` needs `http://127.0.0.1:3000.` positive (:50). It lists `http://127.0.0.1/` and `127.0.0.1:3000` as negatives
    (:59, :82); both flip.
- **UI entry points**:
  - `PathText.vue`: text segments send `seg.href` (:63), but `codeProxyHref` (:111-113) sends the raw `props.text`.
  - `MdInline.vue` `onLinkClick` (:82-95) sends the raw `n.href`.
  - `useProxyOpen.ts` `openProxyTab` (:55-114): sync `window.open`, then the blocked fallback (:153).
- **Hub target grammar** (`target.ts`):
  - Scheme-less input with a path ⇒ `syntax` (:145). Port is mandatory (:148). `%` ⇒ `syntax` (:147).
  - `:80` is dropped from the upstream `Host` (:206).
- **Sessions** (`sessions.ts`): `exchange` (:212-244) always creates a session. 16 per instance / 128 global ⇒ `429 sessions` (:224-228;
  `protocol/proxy.ts:173-177`, "never evict"). Sessions end only on idle (2 h), hard expiry or revoke. Codes: 16 per instance with a 60 s TTL.
- **Listener** (`listener.ts`):
  - `STRICT_HEADERS` (:31-37, `frame-ancestors 'none'` + XFO `DENY`) is applied by `sendProxyResponse` (:39-54).
  - The forwarder gets a **static** `reply` (:81).
  - Request order: `closing` (:176) → Host 421 (:180) → enter (:194-239) → gate (`gate()` :167-170, kinds `none|one|conflict`,
    `auth-identity.ts:64-68`) → 403 (:253-262) → forward.
- **Forwarder** (`forward.ts`): `ProxyReply` (:31) carries no request policy. Its 503/502/504/413 replies come from :141 and :218-221.
- **Hub UI CSP**: `http.ts:179-180` has no `frame-src`. `setSecurityHeaders` (:363-368) is called at :631 (`createLanTransport`,
  `LanTransportCtx` :576), :1501 (`LanRuntime` :1049) and :3544. `createHttpFrontend` (:2785) has `deps.config` (`ports.ts:664-665`) and
  builds `rt` (:2940) and the LAN transport (:3024).
- **Ports and caps**: `service.ts:47-48` hub/lan ports are not passed to `createProxyListener` (:219-231). Caps are built at `hub.ts:474`.
- **Dialog precedent**:
  - `PreviewHost.vue` (:1-25, :413-489); `preview.css` desktop :82-86 and mobile :105-114.
  - `PreviewHtml.vue`'s iframe (:215-225) is `credentialless`, which must **not** be copied: it would drop the gate cookie.

## 2. Framing

### 2.1 Same-site facts (to be proven by browser acceptance, §7)

- The hub is `http://H:<hub|lan port>`; a proxy is `http://H:79xx` (`proxyOriginOf`, `protocol/proxy.ts:68-70`). That is cross-origin but
  same-site.
- **Gate cookie in the frame**: the Lax gate cookie is stored and sent on the framed app's navigations, subresources and WebSocket.
  - The frame's ancestors are all same-site, so third-party-cookie blocking, Firefox Total Cookie Protection and Safari ITP do not apply.
  - No `SameSite=None` and no CHIPS are needed.
- **Unsafe methods**: the framed app's own POSTs are `Sec-Fetch-Site: same-origin` and pass `listener.ts:255-262`.
- **Hub API**: `frame-src` widens what the hub may embed, never who may embed the hub. Hub XFO `DENY` and `frame-ancestors 'none'` stay.
- **Target fence**: `http://*:<port>` is a host wildcard, not a private-network matcher. The server-side target fence remains the guard on
  what gets proxied.

### 2.2 Per-request reply policy (D3; closes #6)

- **`protocol/proxy.ts`**:
  - `PROXY_STRICT_CSP_BASE` = today's CSP without its `frame-ancestors` part.
  - `proxyFrameAncestors(hostname, hubPort, lanPort?)` ⇒ `'self' http://<hostname>:<hubPort>[ http://<hostname>:<lanPort>]` (pure).
- **`listener.ts`**:
  - `sendProxyResponse(res, status, headers?, body?, policy?: ProxyReplyPolicy)`, where `ProxyReplyPolicy = { frameAncestors: string }`.
  - Without a policy ⇒ exactly `STRICT_HEADERS` (byte-identical).
  - With a policy ⇒ `PROXY_STRICT_CSP_BASE; frame-ancestors <value>`, no `X-Frame-Options`, all other strict headers kept.
- **Binding**: right after `origin = hostOrigin(req)` succeeds (:180), compute `policy` once from that **validated** canonical host.
  - The hostname is `origin` minus `http://` and the trailing `:port`. Raw header bytes never reach the policy.
  - `deps.hubPort` / `deps.lanPort` are newly passed by `service.ts` at :219-231.
  - Every later `sendProxyResponse` in the request handler gets it: 400/405, 404 reserved, 410/429/503 enter failures, 303 enter success,
    401 gate (incl. conflict), 403 origin.
- **Stays strict (no policy)**: 421 Host mismatch, the `closing` 503 at :176 (sent before Host validation), and every `rejectSocket` WS
  response. A WS response is not a navigation, so framing does not apply.
- **`forward.ts`**:
  - `ProxyRequestGate` gains `frameAncestors: string`, set on both `access` objects (:220, :264).
  - `ProxyReply` becomes `(res, status, headers?, policy?)`. Its positions differ from `sendProxyResponse` (which has `body?` 4th), so
    `listener.ts:81`'s direct `reply: sendProxyResponse` binding is **replaced** by
    `reply: (res, status, headers, policy) => sendProxyResponse(res, status, headers, undefined, policy)` (r2-review #6). `handle`'s closing 503 (:141) and `fail` (:218-221: 502/503 queue/504/413) pass
    `{ frameAncestors: gate.frameAncestors }`.
  - `filterResponseHeaders` is **unchanged**: upstream headers are passed through verbatim.

### 2.3 One-time enter inside the iframe

- The flow: `iframe.src = enterUrl` → 303 (frameable via D3) → nextPath.
- The code lives in the `src` attribute only until it is consumed (≤ 1 request).
- A browser-level reload or bfcache restore of the iframe re-presents a consumed code ⇒ the 410 page, which is now visible in the frame.
  「重新加载」 re-opens with a new code.
- The iframe is keyed by a generation counter and never re-parented.

### 2.4 Hub UI CSP (D4; closes #5)

- **`hubCsp(range?)`** in `http.ts`:
  - `undefined` ⇒ `CSP` exactly.
  - Otherwise `frame-src 'self' http://*:<p0> … http://*:<pN>` is inserted before `frame-ancestors 'none'`. `'self'` keeps `/pv` working.
  - Size: ≤ 256 ports ≈ 3.9 KiB; ≈ 750 B for the default range.
- **Wiring**: computed once in `createHttpFrontend` from `deps.config.proxy?.portRange`, which is present iff the cap is.
  - It is threaded only through http.ts-internal shapes: `LanTransportCtx.csp?` (default `CSP`), `LanRuntime.csp`, and the loopback `handle`
    closure.
  - `setSecurityHeaders(res, csp)` at :631, :1501, :3544.
  - No `FrontendDeps`/`ports.ts` change and no hub.ts hand-off beyond the cap.

### 2.5 iframe (D5)

- Markup: `<iframe :key="gen" :src="enterUrl" :sandbox="PROXY_FRAME_SANDBOX" referrerpolicy="no-referrer" :allow="PROXY_FRAME_ALLOW"
allowfullscreen>`, with `PROXY_FRAME_ALLOW = "clipboard-write; fullscreen"`.
- **`allow-same-origin` is required.** Without it every request from the app is cross-site, which drops the Lax cookie and breaks storage.
  It is safe only because the frame is cross-origin to the hub.
- **Mount guard**: `isSafeEnterUrl(enterUrl)` and `new URL(enterUrl).origin !== location.origin`.
- **No top navigation** ⇒ framebusting is inert.
- **No `message` listener** (PreviewHtml precedent).
- **Session history**: frame navigations join the session history (Back walks the frame first). They are pruned when the iframe is removed;
  this is disclosed in the hint.

## 3. Session lifecycle for repeated opens (D6; closes #2)

Choice: **reuse at enter.** The alternative, revoke-on-close, was rejected: the session cookie is HttpOnly and shared by every tab of the
browser, so revoking on close would kill a parallel 「新标签打开」 tab and its WebSocket. It would also need a new API.

- **`sessions.ts`**: `exchange(code, instanceId, origin, opts?: { reuse?: ProxySession })`. The code checks run unchanged: consume first, then
  `sweep`, revocation gap/revoked, expiry, instance, origin.
  - If they pass and `opts.reuse` is live (`isLive`), the same instance and origin, and the **same identity** as the code (`listener`,
    `principal`, `sidTag`, `userId` all equal): `touch(reuse,"http")` and return `{ ok: true, reused: true, rec: reuse, nextPath }`.
    No new session, no cap check.
  - Otherwise today's create path, with `reused: false` and `sid`.
  - `hardAt` stays the reused record's. The same `sidTag` means the same parent login, so the parent bound is identical.
- **`listener.ts` enter branch (:194-239)**:
  - Before `exchange`, `prior = gate(req, origin)` (`touch:false`). `kind === "one"` ⇒ `{ reuse: prior.rec }`. `none` / `conflict` ⇒ no reuse,
    the existing behavior.
  - On `reused` ⇒ `303 Location` **without `Set-Cookie`**: the browser keeps its cookie.
  - `attach` / `onRequest` are as today.
- **Effect**:
  - Dialog re-opens, 「重新加载」, 「新标签打开」 and iframe reloads within one browser all hold the same cookie, so one browser = one session
    per instance.
  - A new session is minted only on a first visit, after the cookie expired or was revoked, in another browser or profile, or after a hub
    re-login (identity changed; the old record idles out in 2 h).
  - Live WS on the session is untouched (no `end`).
- **Security**:
  - Reuse still requires a fresh valid code (proof of a current hub login) **and** a live same-identity session.
  - A planted cookie from another identity is ignored: a new session is issued and the existing conflict rules apply.
  - The code is consumed either way.
- **Codes**: one mint per open, consumed by enter. The only remaining 429 is `codes`: more than 16 opens of one instance within 60 s whose
  iframes never redeemed.
  - `useProxyPreview` ignores a repeat open for the same href while `opening`.
  - The copy is the existing `proxy.rate` text (稍后重试). It self-recovers within 60 s.

## 4. UI behavior

### 4.1 Compatibility tiers (closes #8)

| Hub capabilities                 | Behavior                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No proxy scope                   | DOM identical to today                                                                                                                                                      |
| Proxy scope, no `proxy.frame.v1` | Inputs recognized today keep identical DOM + new-tab flow. **New** inputs (scheme-less, port-less) may also be recognized and use the new-tab flow with the normalized href |
| Proxy scope + `proxy.frame.v1`   | Plain click / Enter / Space ⇒ dialog. Ctrl/Meta-click on a PathText span ⇒ new tab. MdInline modified clicks stay native (:84)                                              |

### 4.2 Normalized href everywhere (closes #1)

- `normalizeProxyHref(s): string | null` (§5) is the single source.
- `PathText.vue` text segments already send `seg.href`, which is now normalized. `codeProxyHref` (:111-113) becomes
  `proxyActive && normalizeProxyHref(props.text)`; the template keeps displaying `text` and passes the normalized href.
- `MdInline.vue`: the anchor `href` attribute stays original (native modified clicks). `onLinkClick` sends `normalizeProxyHref(n.href)`.
- The dialog, 「新标签打开」 and the no-frame-cap legacy flow all receive that same string.

### 4.3 Dialog

- **`composables/useProxyPreview.ts`** (NEW), a singleton state machine `closed | opening | ready | error`:
  - `open(href)` bumps `gen`, aborts the previous request, then POSTs `transport.proxy.open({target: href}, {signal})`. Stale results are
    dropped by `gen`.
  - A same-href open while `opening` ⇒ no-op.
  - `reload()` = `open(href)`.
  - No `window.open` on this path, so popup blockers do not apply.
- **`components/proxy/proxyPreviewContext.ts`** (NEW): `PROXY_PREVIEW_CTX`.
  - Provided in `App.vue` next to `PREVIEW_CTX` (:189-195). The async host is mounted beside `<PreviewHost />` (:361).
  - PathText/MdInline inject it; absent ⇒ new-tab flow.
- **`components/proxy/ProxyPreview.vue`** (NEW, lazy): Teleport/focus/Esc/scroll-lock per `PreviewHost.vue`.
  - Header: the target as typed, the proxy origin (muted), and 「重新加载」 「新标签打开」 「关闭」.
  - 「新标签打开」 calls `useProxyOpen().open(href)` synchronously in its handler. That mints a new code, which redeems by reuse, and shows the
    existing `fallbackUrl` link if the popup is blocked.
  - Body by state:
    - `opening`: a spinner.
    - `ready`: the iframe, plus a **standing hint**: 「若内容空白或拒绝显示，可能是该应用禁止被嵌入 — 请用新标签打开；浏览器后退会先在内嵌页面内后退」.
      After 10 s without `load`: 「仍在加载…」.
    - `error`: `t(proxyErrorKey(e))`, 「重试」, and the D9 anchor `<a :href="href" target="_blank" rel="noopener noreferrer">`.
  - Keystrokes inside the cross-origin frame never reach the parent. Close and scrim stay available; Esc works when focus is outside the
    frame (disclosed in the hint).
  - The dialog closes on agent-route change.
- **Sizing**, in `styles/proxy-preview.css` (NEW):
  - Desktop: `width: min(1280px, 96vw)` × `height: min(90vh, 1000px)`, with the iframe `flex: 1; border: 0`.
  - ≤ 767 px: full-screen `100dvh` (`preview.css:105-114` rule). Header targets are 44 px under `(pointer: coarse)`.
- **i18n**: `proxy.preview.*` in `i18n/{zh,en}/proxy.ts`. The error notes in `PathText.vue:263-269` / `MdInline.vue:128-134` gain the D9 anchor.

## 5. Recognition grammar (`logic/proxy.js`; closes #3, #4)

- **Hosts**:
  - IPv4: strict dotted quad, no leading zeros, in the existing classes (`:76-81`).
  - `localhost` (any case).
  - `[v6]`:
    - **Full RFC 4291 textual syntax** via a NEW pure `parseIPv6(text) → Uint8Array(16) | null`: hex groups of 1-4, at most one `::`, exactly
      8 groups without `::` or ≤ 7 with it, an optional trailing strict dotted quad counting as 2 groups. No `%zone`, no empty groups otherwise.
    - Classes: `::1`, or ULA `fc00::/7` minus `fd00:ec2::/32`.
    - IPv4-mapped forms are deliberately **not** recognized (the UI is a strict subset of the hub).
- **Forms** (one scanning regex `(scheme)?(host)(:port)?`, then validated):

| Form                     | Port                                                                                         | href                  |
| ------------------------ | -------------------------------------------------------------------------------------------- | --------------------- |
| F1 `http://H:port[tail]` | 1–65535, no leading zero                                                                     | as typed              |
| F2 `http://H[tail]`      | none; **only if the char right after H is not `:`** (a failed F1 never degrades to F2)       | `http://H:80[tail]`   |
| F3 `H:port[tail]`        | ≥ 10, no leading zero, ∉ {21,22,23,25,53,110,143,443,445,993,995,3306,5432,6379,11211,27017} | `http://H:port[tail]` |

- **Left boundary**: the previous char ∉ `[A-Za-z0-9_/.:@\\-]` (the existing :108 guard plus `\`).
- **Right boundary**, applied to the suffix `r` right after the port (F1/F3) or the host (F2):
  - accept if `r` is empty, starts with whitespace, starts with `/?#` (a tail), or starts with a sentence-punctuation char that is not
    followed by an endpoint continuation;
  - **reject** if `r` matches `^[A-Za-z0-9_\-@\[]` or `^[.:][A-Za-z0-9_]`. So `:3000.` ✓, `:3000,` ✓, `:3000: ok` ✓, `:80.5` ✗, `:8080:80` ✗,
    `:3000-4000` ✗, `:3000x` ✗, `http://10.0.0.1.5` ✗.
  - A rejected candidate consumes its match: there is no inner re-match.
- **Tail**: stops at `\s<>"'\x60`. `TRAIL_RE` gains `。，；：！？）」』】》、`. Segments keep `text` = the raw substring (concatenation stays
  exact) and `href` = normalized.
- **API**: `normalizeProxyHref(s)` = the href iff the whole string is one ref, else `null`. `isProxyableHref(s) ≡ normalizeProxyHref(s) !== null`.

**Corpus**: NEW `tests/fixtures/proxy-link-corpus.json`.

- **positive**: `localhost:5173`; `访问 10.0.0.5:8080。`; `192.168.1.10:9000/ui`; `[fd12::1]:3000`; `[FD12:3456::1]:3000/x`; `[fd00::1.2.3.4]:80`;
  `http://10.0.0.5/` → `:80/`; `http://127.0.0.1` → `:80`; `http://127.0.0.1:3000.`; `(http://127.0.0.1:3000/a).`; `--bind=127.0.0.1:8000`;
  `127.0.0.1:3000: ok`.
- **negative**:
  - non-private / not an endpoint: `1.2.3.4:5`, `12:30`, `12:30:45`, `obj.key:value`, `8.8.8.8:80`, `0.0.0.0:3000`, `https://10.0.0.5:8443`;
  - all hostnames (`nas.lan:5000`, `http://nas.local/`, `http://nas:5000`, `example.com:8080`);
  - excluded ports: `10.0.0.5:22`, `10.0.0.5:443`, `10.0.0.5:5`;
  - boundary traps: `10.0.0.1:080`, `10.0.0.1:65536`, `127.0.0.1:8080:80`, `127.0.0.1:80.5`, `127.0.0.1:3000-4000`, `v10.0.0.1:80`,
    `/srv/10.0.0.1:80`, `C:\10.0.0.1:80`, `user@10.0.0.1:22`, `redis://10.0.0.5:6379`;
  - F1 failures that must not degrade to F2: `http://127.0.0.1:0/`, `http://127.0.0.1:70000/`;
  - invalid IPv6: `[fd12:1]:80`, `[fd12::1::2]:80`, `[fd12:::1]:80`, `[fd12::12345]:80`, `[fd12::1%eth0]:80`, `[fd12::g]:80`,
    `[1:2:3:4:5:6:7:8:9]:80`;
  - IPv6 classes: `[fd00:ec2::254]:80`, `[fe80::1]:80`, `[::ffff:127.0.0.1]:80` (UI-strict), `[2001:db8::1]:80`;
  - the existing negatives, minus the two flips.

**Hub-agreement tests**:

- Every href produced from the corpus and from a seeded fuzz (ASCII/CJK/digit/colon/bracket alphabet, 2 000 strings) must pass the real
  `parseProxyTarget(href).ok` (imported from `hub/proxy/target.ts`).
- The invalid-IPv6 list is fed explicitly to both sides: UI `null`, hub `!ok`.

## 6. Packages (exclusive file domains)

- **LP0 frozen surface**: `protocol/version.ts` (`PROXY_FRAME_HUB_CAP`); `protocol/proxy.ts` (`PROXY_FRAME_SANDBOX`, `PROXY_FRAME_ALLOW`,
  `PROXY_STRICT_CSP_BASE`, `proxyFrameAncestors`, `ProxyReplyPolicy` type).
  Test `tests/web-hub/protocol/proxy.test.ts`: the sandbox has no `allow-top-navigation` and no `credentialless`; ancestors output; base CSP
  - `frame-ancestors 'none'` === the listener's strict CSP.
- **LP1 hub** (after LP0): `hub/proxy/{sessions,listener,forward,service}.ts`, `hub/http.ts`, `hub/hub.ts` (cap tail-appended after the
  existing proxy caps at :474). Tests:
  - `tests/web-hub/hub/proxy/sessions.test.ts`:
    - 20 sequential mint→exchange-with-reuse on one instance ⇒ `counts().sessions === 1`, never 429;
    - identity mismatch (sidTag/principal/listener/userId) ⇒ new session;
    - dead/expired/foreign-instance/foreign-origin reuse ⇒ new session;
    - revoked or expired code ⇒ invalid even with a valid reuse;
    - reuse touches `lastUsedAt` and keeps `hardAt`;
    - without `opts` the create path is byte-identical (existing tests unchanged);
    - 17 distinct non-reusing redeems still ⇒ `429 sessions` (cap not raised).
  - `tests/web-hub/hub/proxy/listener.test.ts`:
    - enter with a live same-identity gate cookie ⇒ 303, no `Set-Cookie`, session count unchanged;
    - `none`/`conflict` cookie ⇒ new session + `Set-Cookie`;
    - **17+ open/enter cycles** through a real listener + fixture upstream (simulating dialog re-open, reload, new tab) ⇒ no 429;
    - a live proxied WS attached before the cycles stays open after them;
    - policy matrix on a valid Host: 303/400/401/403/404/405/410/429 carry `frame-ancestors 'self' http://H:<hub> [http://H:<lan>]` and no
      XFO;
    - invalid Host 421, `closing` 503 and WS rejects carry the exact old strict headers.
  - `tests/web-hub/hub/proxy/forward.test.ts`: queue-full 503, connect 502, head-timeout 504 (fake timer) and 413 carry the gate's policy; a
    fixture upstream sending `X-Frame-Options: DENY` + `CSP: frame-ancestors 'none'` reaches the client deep-equal (pass-through).
  - `tests/web-hub/http/security.test.ts`: proxy off ⇒ `toBe(CSP)` on loopback, LAN and the LAN transport reject (:631). Proxy on ⇒ `frame-src`
    lists exactly the range on all three sites, and `frame-ancestors 'none'` + XFO `DENY` remain.
  - `tests/web-hub/hub/caps-coexist.test.ts`: `proxy.frame.v1` iff `config.proxy`, tail order.
- **LP2 UI logic** (after LP0, parallel to LP1): `logic/proxy.js` (grammar, `parseIPv6`, `normalizeProxyHref`,
  `proxyFrameScopeOf(caps, scope)`), `tests/fixtures/proxy-link-corpus.json`, `tests/web-hub/ui/logic-proxy.test.ts` (corpus,
  concatenation invariant, hub agreement + fuzz).
- **LP3 UI components** (after LP2): NEW `useProxyPreview.ts`, `ProxyPreview.vue`, `proxyPreviewContext.ts`, `styles/proxy-preview.css`;
  `App.vue`, `PathText.vue`, `MdInline.vue`, `i18n/{zh,en}/proxy.ts`. Tests:
  - NEW `tests/web-hub/ui/proxy-preview.test.ts`:
    - state machine: generation, abort, same-href dedupe, reload;
    - exact iframe attributes (no `credentialless`);
    - a same-origin enter URL ⇒ no iframe;
    - no `message` listener;
    - the standing hint is present in `ready`;
    - 「新标签打开」 calls `window.open` synchronously, plus the blocked fallback;
    - D9 anchor;
    - focus/Esc/scrim/scroll-lock restore.
  - `tests/web-hub/ui/proxy-ui.test.ts`:
    - the three §4.1 tiers;
    - **actual POST targets** for plain text, inline code (`127.0.0.1:3000/ui` ⇒ `http://127.0.0.1:3000/ui`; `http://127.0.0.1/` ⇒
      `http://127.0.0.1:80/`) and markdown anchors, in all three flows (dialog, new tab, legacy).
  - `build:web` + `check:web` (dialog ≈ 2–3 KiB gz lazy).
- **LP4 integration** (main session):
  - NEW `scripts/dev/proxy-frame-fixtures.mjs`: one upstream port with `/plain`, `/xfo`, `/fa`, `/probe`, `/bust`, `/popup`, `/cookie`,
    `/form`, `/ws`; one "foreign" port serving framing pages. Loopback only by default, with an explicit LAN flag.
  - `acceptance.md` §18 (§7 below), the AGENTS.md proxy paragraph, the full gate.

## 7. Browser acceptance (`acceptance.md` §18; closes #7)

- **Preconditions**:
  - Logged in, with a **valid gate session** (opened through the dialog within the last minutes). Never run right after logout, so a 401
    cannot pass for "blocked".
  - Record per run: browser + exact version, OS, access mode (`127.0.0.1`, `localhost`, LAN IP over VPN), and the minimum Safari version
    observed working.
- **18A — positive / compatibility** (blocking):
  1. Dialog over `/plain`: the enter flow works in the frame and the `pwh_px_<p>` cookie shows in DevTools.
  2. `/cookie` set + reload persists; `/form` same-origin POST succeeds; `/ws` echo works.
     - Repeat with Chrome "block third-party cookies", Firefox ETP Strict and Safari default ITP.
  3. 20× open/close/reload/「新标签打开」 on one target ⇒ never `proxy.rate`; the `/ws` tab stays connected.
  4. Popups blocked ⇒ the fallback link works.
  5. Mobile (iOS Safari): full-screen, close button, Back behavior.
  6. Old-hub tier: a hub without `proxy.frame.v1` ⇒ the new-tab flow; new inputs open via new tab.
- **18B — negative matrix** (blocking; each result recorded as rendered / refused / 401):
  1. `/xfo` and `/fa` in the dialog ⇒ refused, the hint is visible, `curl -I` shows the headers verbatim.
  2. The foreign same-site port (`http://H:8999`) framing `http://H:79xx/__pwh_proxy__/x` (404 page) ⇒ **refused**. Framing `/xfo` ⇒
     refused. Framing `/plain` ⇒ renders; this residual exists today without the feature (the upstream sent no restriction) and is recorded,
     not failed.
  3. A cross-site page (`http://127.0.0.2:8999`, or another LAN IP) framing a proxy URL ⇒ the cookie is not sent and the 401 page is refused.
  4. The foreign port framing the hub (`http://H:<hub>/`) ⇒ refused (XFO `DENY` / `'none'`).
  5. `/probe` inside the dialog (credentialed `fetch` of `/api/version` and `/api/proxy`, a form POST to `/api/proxy/open`, `EventSource
/api/events`, `<img>` of `/api/events`) ⇒ the same outcomes as `acceptance.md` §8 A-group (unreadable / 403 / not sent).
  6. `/bust` (`top.location=`) ⇒ the hub tab does not move.
  7. `/popup` ⇒ an unsandboxed tab opens (documented: the sandbox is not a malicious-app sandbox).
  8. Proxy-generated pages inside the dialog with a valid session: a reused enter (410), `/__pwh_proxy__/x` (404) and a stopped upstream
     (502) render their text.

## 8. Risks

- **R1** `http://*:<port>` in `frame-src` on old Safari. 18A records the minimum version. Fallback: per-request host enumeration.
- **R2** Apps that forbid embedding are blank in the dialog. This is accepted by the D2 ruling and mitigated by the hint and 「新标签打开」.
- **R3** Grammar false positives (e.g. `10.0.0.5:1500` in logs). The cost is a styled span and a clear refusal or a working proxy; the corpus
  pins the known traps.
- **R4** Instance quota (`PROXY_PER_PRINCIPAL_MAX` 4). The same target reuses its instance; over the limit ⇒ the existing `proxy.limit.*` copy.
- **R5** A hub re-login mints a second session per instance (the identity changed). It is bounded by re-logins and idles out in 2 h.

## 9. Non-goals

Hostname recognition (ruling 3; hostnames stay TopBar-dialog input only); rewriting upstream framing headers (ruling 1); a per-row
「预览」 in the TopBar `ProxyDialog`; a dialog-vs-tab preference; `https://` upstreams; body rewriting.

## 10. r1 review disposition

| #   | Finding                                   | Disposition                                                                                                                                        |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Inline-code branch not normalized (Major) | Accepted. §4.2: `codeProxyHref` → `normalizeProxyHref`; all three flows consume one string; POST-target tests in `proxy-ui.test.ts`                |
| 2   | Repeated opens exhaust sessions (Major)   | Accepted. §3: same-identity reuse at enter (no new session, no Set-Cookie); caps unchanged, no eviction; sessions/listener/WS tests                |
| 3   | Port right boundary vs corpus             | Accepted. §5 right-boundary rule (`:3000.` ✓, `:80.5`/`:8080:80` ✗) + F2 never after a failed F1; corpus rows                                      |
| 4   | Loose IPv6 breaks hub agreement           | Accepted. §5 `parseIPv6` full RFC 4291; invalid-IPv6 corpus fed to UI and hub; agreement + fuzz test                                               |
| 5   | Unfrozen / wrong CSP interface            | Accepted. §2.4: derived from `deps.config.proxy?.portRange` inside `createHttpFrontend`; http.ts-internal threading only; no `FrontendDeps` change |
| 6   | Error pages not fully wired               | Accepted. §2.2: per-request `ProxyReplyPolicy` in listener + `ProxyReply`/`ProxyRequestGate` in forward; strict for 421/closing/WS; tests          |
| 7   | No browser negative matrix                | Accepted. §7 18B deterministic fixtures, valid-session precondition, version/access-mode record, privacy-protection runs, popup caveat (§0)        |
| 8   | Compatibility wording conflict            | Accepted. §4.1 three tiers; 18A.6                                                                                                                  |

## 11. r2 review disposition (main-session adjudication, 2026-10-19)

r2 re-review (r_PPSQ0DDF): 7 closed, 1 partially, no Blocker. Closed by the main session (no third round): #6 — the
`reply` binding in `listener.ts:81` is replaced by an adapter that passes `undefined` as `body` and the policy 5th (§2.2);
the forwarder error-response assertions in §6 stay.

## 12. Implementation deviations (LP3 verification, main-session accepted)

- The dialog header shows the **normalized** target (what is actually opened, e.g. `http://127.0.0.1:80/`), not the raw typed
  text; the full value is in the `title` tooltip.
- Icons reuse the existing sprite (`arrow-up` rotated 45° for 「新标签打开」); dialog CSS ships in the main stylesheet
  (`cssCodeSplit:false`), only the JS chunk is lazy; the proxy origin line appears only in `ready` (known only after `open`).
- The standing hint does not mention the Esc-inside-frame limitation (approved copy kept).
