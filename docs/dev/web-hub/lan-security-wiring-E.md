# LAN security wiring — package E (Feishu alerts + emit seams + Feishu approval)

You (I, the integrator) own every shared file. E delivers `hub/feishu/{security,notify,service}.ts`,
`hub/ratelimit.ts`, `hub/spawn/{entry,routes}.ts`, `hub/proxy/routes.ts` and their tests. Everything
below is additive — no shared/frozen file was touched; absent injection ⇒ the seams are inert and the
hub is byte-identical to pre-feature.

## 1. One shared security bus

Create ONE `createSecurityEventBus(log)` and hand the same instance to every consumer below.

```ts
const security = createSecurityEventBus(log);
```

## 2. Feishu service (hub.ts, where the bot service is constructed)

```ts
import { createFeishuBotService } from "./feishu/service.js";
const bot = createFeishuBotService({
  // …existing deps…
  security, // SecurityEventBus (one instance)
  onApprovalDecision: (challengeId, allowed, gen) => loginCore.onApprovalDecision(challengeId, allowed, gen),
});
```

- `deps.config.securityAlerts` must be **forwarded from settings** (default `true`): P0's
  `normalizeFeishuBotHubConfig` accepts the key but does not set it — you must put
  `securityAlerts: settings.feishuBot.securityAlerts` into `buildHubConfig`'s `feishuBot` wire.
- The service now returns `bot.approval` (a `FeishuLoginApproval`). Pass it as
  `LanLoginCoreDeps.approval`; while the bot is stopped it answers `"unavailable"` (recovery-only).

## 3. Login core

```ts
createLanLoginCore({
  // …existing deps…
  approval: bot.approval, // LoginApprovalPort
  security, // SecurityEventBus (login-success / -2fa-* / recovery-used)
});
```

## 4. Spawn routes (lan-assembly / hub.ts, where `createSpawnRoutes` is called)

```ts
createSpawnRoutes({ /* …existing… */, security });
```

No other change. Emits happen at the seams (`entry.ts` accepted path for `new` via `onAccepted`,
session-branch success for `resume|fork`, relaunch success for `relaunch`), only when
`io.listener === "lan"`, never on an idempotent replay, never for the Feishu bot origin.

## 5. Proxy routes (hub.ts, where `createProxyRoutes` is called)

```ts
createProxyRoutes({ /* …existing… */, security });
```

You must ALSO supply `ProxyRouteIo.ip = ctx.clientIp` when constructing the per-request io (the
`ip?` field is P0-frozen, absent ⇒ the emit is skipped). The `proxy-open` event fires only for
`outcome.ok && io.listener === "lan"`.

## 6. Login limiter (lan-assembly)

`createLoginLimiter` now takes `{ now, onEvent }`. Wire it in `LanAssembly.build({ security })`:

```ts
const limiter = createLoginLimiter({ now, onEvent: (e) => security.emit(e) });
```

It emits `login-lockout` (first transition into backoff), `login-tightened` (false→true),
`login-saturated` (taint-cap latch) — transitions only.

## Invariants I must preserve

1. One shared `SecurityEventBus`; zero subscribers ⇒ zero work.
2. `onApprovalDecision` routes to the core's method; the core's `approval` is `bot.approval`.
3. `securityAlerts` is forwarded (`false` ⇒ the service never subscribes the bus).
4. Emits are best-effort: the shared notice budget (`createNoticeBudget`) caps 20 notices/min and
   drops + counts on exhaustion — never block a request path.
5. `dirTail` = last two path segments; LAN-origin only; dup replays and Feishu origin never emit.

## Accepted deviation (nonce target shape)

§5.7 pins the nonce `target: challengeId`, but the core's `onApprovalDecision(challengeId, allowed, gen)`
also needs the challenge gen, which no nonce field carries. E encodes it in the nonce target as
`JSON.stringify({ c: challengeId, g: gen })` (parse with `parseApprovalTarget`, exported from
`hub/feishu/security.ts`). The card-text rendering (`loginApprovalCard`) lives in `service.ts`; the
port itself never renders a card.
