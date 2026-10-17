# X2 (UI) report — web-hub port proxy

Built against the frozen X0 contract only (fakes in tests). Not committed.

## Delivered

- `logic/proxy.js`: `proxyScopeOf(caps, transport, mode?)` (token ⇒ `proxy.v1`, password ⇒ `proxy.lan.v1`; no cap or no `transport.proxy` ⇒ `null`), `findProxyUrlRefs` / `isProxyableHref` (http + IP literal in loopback/private/cgnat/ULA or `localhost`, explicit port; the hub's metadata ranges are excluded; hostnames are never auto-linked), `parseProxyOpen/List/Stop` contract gates (the enter URL must be exactly `<origin>/__pwh_proxy__/enter?c=…`), `isSafeEnterUrl`, `proxyErrorKey`, and the shared `proxyFetch` response reader.
- `token-client.js` / `password-client.js` gain a `proxy` namespace (open/list/stop); `transport/{token,password}.ts` expose it. The token transport uses `withAuthNotice`, and the password transport adds exact-match `REST_AUTH_PATHS` entries for the three paths. `/api/proxy` is deliberately not a prefix rule.
- `composables/useProxyOpen.ts`: `openProxyTab` calls `window.open("about:blank","_blank")` before the first await, then `POST /api/proxy/open`. On success it sets `tab.opener=null` and calls `location.replace(enterUrl)`, so the one-time code is only ever used by that navigation. On error it closes the tab and returns a prose key. If the popup is blocked, or the navigation fails, it returns the URL so the caller can render `<a target=_blank rel="noopener noreferrer">`. The fallback link is cleared when the dialog or message unmounts. `useProxyOpen()` derives the scope from `HUB_CTX` caps + `CONTROL_ENV.authMode` + `hub.transport.proxy`.
- `components/proxy/ProxyDialog.vue` (lazy chunk, ~7 KB raw; Teleport + overlay contract like PrivacyUnmarkDialog): input + 打开, plus a list of open proxies with 打开/停止. The list is fetched on open and after each action, with no polling. It also carries the policy / LAN / tunnel / reverse-proxy notes. A 404 on stop is treated as "already gone".
- `TopBar.vue`: one icon button (`.proxy-entry`, via the 0/1-item `v-for` trick) shown only when a scope exists; the dialog is `defineAsyncComponent`.
- `PathText.vue` (plain segments + inline code that is exactly one URL) and `MdInline.vue` (links whose href is proxyable; modified clicks are left alone): `.proxy-ref` affordance, inline error / blocked-link note (8 s). Without a scope the DOM is byte-identical; streaming suspension and `noRefs` are honoured.
- i18n `proxy` (en + zh, auto-registered by the glob): a prose sentence for every deny reason plus the extra unavailable reasons, limits, rate, auth, `cookie-conflict` (manual cookie-clearing steps per §R2 #4), network and generic cases. Compact markers (`loopback`, `port N`, `mine`) stay English. No `http://` literals in messages (`check:web` forbids them).
- Styles: `styles/proxy.css` (first screen, `.proxy-ref*`) and `styles/proxy-dialog.css` (lazy). No scoped `<style>`, no `v-html`.

## Design notes

- `types.ts` (X0) has no `HubHandle.proxy`, and X2 may not edit it. The composable reads `hub.transport.proxy` through a local structural type. `useHub` already returns `transport`.
- `proxyScopeOf` takes an optional third `mode` argument beyond the plan's `(caps, transport)`. Without it, a LAN-on hub advertises both caps and a token tab could not be told apart from a password tab.
- Link errors surface as an inline `role=status` note rather than a global toast, because there is no toast infrastructure.

## Files

New: `src/web-hub/ui/src/{logic/proxy.js,composables/useProxyOpen.ts,components/proxy/ProxyDialog.vue,i18n/en/proxy.ts,i18n/zh/proxy.ts,styles/proxy.css,styles/proxy-dialog.css}`, `tests/web-hub/ui/{logic-proxy,proxy-ui}.test.ts`.
Edited: `src/web-hub/ui/src/{components/preview/PathText.vue,components/transcript/MdInline.vue,components/shell/TopBar.vue,logic/token-client.js,logic/password-client.js,transport/token.ts,transport/password.ts}`.
(`MdInline.vue` is at `components/transcript/`.)

## Verification (real output)

- `npx prettier --check src/web-hub/ui/src tests/web-hub/ui`: all files formatted.
- `timeout 280 npm run typecheck`: tsc + tsc(typecheck) + vue-tsc all clean.
- `timeout 600 npx vitest run tests/web-hub/ui --exclude tests/web-hub/ui/fleet-tree.test.ts`: 184 files, 4390 tests passed (includes the new 82: T-U1 corpus, T-U2 PathText/MdInline/TopBar, T-U3 open flow, T-U4 dialog, T-U5 transport + `API.*`). Also `boundary`, `check-ui-dist-budget` and `i18n-parity` pass.
- `timeout 300 npm run build:web && npm run check:web`: `✓ check:web — dist/web-hub-ui/ OK (17 files, first-screen JS 278720B gz/524288B, lazy JS 44301B gz/131072B, CSS 30127B gz/65536B)`. The first check:web run failed on `http://…` literals in i18n copy; fixed.

## Leftovers

- Not exercised against a real hub (X1 in parallel). Real-browser checks (popup behaviour, Safari activation, `opener` null → `replace`) belong to X3 / `acceptance.md`.
- The TopBar icon reuses `unplug` (no new icon added; `icons/` is outside the X2 domain).
- Fleet files and `hub/*` were not touched.
