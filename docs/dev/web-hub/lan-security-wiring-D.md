# LAN security — package D (sessions) wiring request

Module: `src/web-hub/hub/lan-sessions.ts` (`createLanSessionsRoutes`), UI:
`ui/src/composables/useLanSessions.ts` + `ui/src/components/shell/SettingsSessionsCard.vue` +
`ui/src/logic/userAgent.ts` + `ui/src/i18n/{zh,en}/sessions.ts` (auto-globbed by `i18n/index.ts`).
Tests: `tests/web-hub/http/lan-sessions{,-revoke-propagation}.test.ts`,
`tests/web-hub/ui/{settings-sessions-card,user-agent}.test.ts`.

## Hub wiring (plan §3.2; I mounts in `handleLanRequestInner` after the proxy branch, ~http.ts:1611)

```ts
// once, at LAN frontend construction (alongside the proxy routes):
const lanSessions = createLanSessionsRoutes({
  store: rt.lan.store, // LanStorePort (B's real store)
  idleMs: lanCfg.sessionIdleMs ?? 720 * 60_000, // the SAME idle policy the store uses
  now: Date.now,
  log, // HubLog (auditLanSession channel "lan-session")
  authRevoke: rt.authRevoke, // the shared bus (html caps + proxy sessions subscribe)
  revokeSse: (sidHash) => rt.lanSse.revoke((c) => c.auth?.sidHash === sidHash, "revoked"),
});
// on LanFacade.close(): lanSessions.dispose();

// per request, ONLY on the LAN listener, after the proxy branch:
const handled = await lanSessions.handle(req, res, method, path, {
  listener: "lan",
  ip: ctx.clientIp,
  xPwhOk: () => req.headers["x-pwh"] === "1",
  csrfOkLan: () => csrfOkLan(req, ctx),
  requireLanSession: async (deadline) => {
    const s = await requireLanSession(rt, req, res, ctx, false, lease, deadline.remaining());
    return s === undefined
      ? { handled: true }
      : { userId: s.record.userId, sidHash: s.identity.sidTag, user: s.record.username /* see note */ };
  },
  readJson: (req, maxBytes, maxMs) => readJson(req, maxBytes, maxMs),
  sendJson,
  clearCookie: (res) =>
    res.setHeader("Set-Cookie", formatLanCookie("", { secure: ctx.scheme === "https", clear: true })),
});
if (handled) return;
```

Invariants I must preserve:

1. **Mount on the LAN listener only.** The module self-defends (`listener !== "lan"` ⇒ 404), but
   loopback should never even reach it — keep it inside the LAN branch.
2. `requireLanSession` must send the failure response itself and return `{handled:true}` —
   the module never re-answers auth failures. The `LanSessionsAuth.user` field needs the
   username: if `LanSessionResult` doesn't carry it, resolve it via the identity/cookie path
   (it is audit-only; never block the route on it — `user` may be omitted).
3. The route's own `ReqDeadline` (`REVOKE_TOTAL_MS`) starts at `handle()`. The `deadline`
   passed into `requireLanSession` MUST be the same object the io receives (the module passes
   it through), so auth shares the 10 s budget with the store IPCs.
4. `authRevoke` must be THE shared bus (`http.ts:2826` HTML caps, `hub.ts:1792` proxy sessions):
   the module's emit → delete → emit → SSE order is what makes "cookie, SSE, proxy HTTP+WS, HTML
   caps all die" true (pinned by `lan-sessions-revoke-propagation.test.ts`).
5. Advertise cap `lan.sessions.v1` (`LAN_SESSIONS_HUB_CAP`) on both cap surfaces only with the
   module mounted, iff `config.lan`.
6. `idleMs` given here must equal the store's configured idle; the GET reply's `idleMinutes` is
   derived from it and the schema bounds it to 5–10080.

## UI wiring (I-owned `SettingsView.vue`)

```vue
<script setup lang="ts">
import SettingsSessionsCard from "./SettingsSessionsCard.vue";
import { useLanSessions } from "../../composables/useLanSessions.js";
const lanSessions = useLanSessions({
  enabled: () => Array.isArray(hubCaps) && hubCaps.includes("lan.sessions.v1") && authMode === "password",
  list: (signal) => apiGet("/api/lan/sessions", signal), // fetch, X-PWH: 1, credentials: same-origin
  revoke: (body, signal) => apiPost("/api/lan/sessions/revoke", body, signal), // JSON + Origin headers
});
</script>
<template>
  <SettingsSessionsCard :sessions="lanSessions" />
</template>
```

- Mount unconditionally; the cap+authMode gate lives in `enabled()` (`phase:"unsupported"` ⇒
  the card renders nothing). Transports must pass the AbortSignal through to fetch (15 s client
  timeout lives in the composable).
- The card uses only existing global classes plus the preview's `session-card`/`sessions-*`
  hooks (`~/pwh-preview/lan-security.html` 1B). `styles/` is outside D's allowlist — I may add a
  `styles/sessions.css` (per the preview) and import it from SettingsView; the card is fully
  functional without it.
- Self-revoke kills the caller's own session: the hub's SSE revoke already pushes the client to
  the login view; no extra handling needed.

## Contract issues / deviations (reported, not patched)

1. **「验证方式」 row omitted.** The approved 1B preview shows a per-session 验证方式 line, but
   the frozen wire `LanSessionWire` (`protocol/lan-sessions.ts`) and `LanSessionListRecord`
   (`ports.ts:1166`) carry no auth-method field (session_meta has only `user_agent`/`last_ip`).
   Adding it needs a B schema/ops change + a wire addition — both frozen. Recommend a P5
   follow-up (`method?: "password"|"totp"|"recovery"|"feishu"`); the card picks it up with one
   `<dt>/<dd>` pair.
2. **Unknown-id revoke answers `404 E_NOT_FOUND`** (plan §3.2 does not name this case; addendum
   item 5's code list is not exhaustive). Body stays `{error: code}`.
3. Revoke-before-dispatch store failures answer plain `503 E_DB`/`E_DEADLINE` without
   `effect:"unknown"`; `effect:"unknown"` is emitted exactly when a delete may already have been
   dispatched (plan §3.2 wording), with fail-closed re-emits in both cases.
