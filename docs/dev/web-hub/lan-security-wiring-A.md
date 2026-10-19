# LAN security — wiring request for package A (allowlist)

Plan: `lan-security-plan.md` §2, §2.4/§6; frozen: `lan-security-P0-surfaces.md` (+ addendum 1/2). Nothing below is wired by A.
Paths are relative to `src/web-hub/`.

## What A delivers

- `hub/client-allow.ts` — `createClientAllowGuard({entries?, now?, log?, implicitLoopback?}): ClientAllowGuardImpl`
  (a `ClientAllowGuard` + `forListener(tag)` + `bookkeeping()`), plus `tagClientAllowGuard(guard, "lan"|"proxy")`.
- `hub/proxy/listener.ts` — `ProxyListenerDeps.clientAllow: ClientAllowGuard` (REQUIRED); `connection` hook calls
  `admitPeer(remoteAddress, false)` before the conn-guard lease, destroys silently on deny (covers HTTP, enter and upgrade).
- `hub/proxy/service.ts` — `ProxyServiceDeps.clientAllow?: ClientAllowGuard`; tags it `"proxy"` and hands it to every listener.
  Absent ⇒ an inactive guard (kept optional ONLY so `hub.ts`/test helpers compile before you wire it).
- `agent/lan-status.ts`, `agent/proxy-status.ts` — all new `/webhub status` rendering (see §4).

## 1. Construct ONE guard per hub (hub.ts)

```ts
import { createClientAllowGuard } from "./client-allow.js";
// config.lan?.allowClients: undefined ⇒ inactive; [] ⇒ ACTIVE deny-all; otherwise canonical CIDRs.
const clientAllow = createClientAllowGuard({
  ...(config.lan?.allowClients === undefined ? {} : { entries: config.lan.allowClients }),
  log, // Pick<HubLog,"info"> — audit lines go through hub/audit.ts auditClientDeny
});
```

Pass the SAME instance to the LAN transport (`LanTransportCtx`) and to `createProxyService({ ..., clientAllow })`. After wiring,
make `ProxyServiceDeps.clientAllow` required (it is optional only for compile-compat). Never construct the guard when `config.lan`
is absent (loopback-only hub stays byte-identical); the proxy service then simply omits the dep.

## 2. LAN enforcement (http.ts — I owns it)

Connection level, FIRST statement of `srv.on("connection")`, before `connGuard.admit` (no bytes, no lease):

```ts
const peerIp = normalizePeerIp(socket.remoteAddress);
const viaTrustedProxy = snapshot.trustProxyFrom.has(peerIp);
if (!ctx.clientAllow.admitPeer(peerIp, viaTrustedProxy)) {
  socket.destroy();
  return;
}
```

Request level, right after a successful `buildContext`, before routes/cookie reads (only trusted-proxy hops can fail here;
direct peers were already judged at connect and `admitForwarded` on a direct peer is just the same peer address):

```ts
if (
  result.viaTrustedProxy &&
  !ctx.clientAllow.admitForwarded({ clientIp: result.clientIp, xffUsable: result.xffUsable === true })
) {
  setSecurityHeaders(res, ctx.csp);
  sendError(res, 403, "E_CLIENT");
  return; // keep-alive socket stays usable
}
```

- `RequestContext.xffUsable` = `warnings` has none of `xff-missing | xff-malformed | xff-all-trusted` (set it in `buildContext`).
  The guard itself maps anything but `=== true` to "unusable" ⇒ deny (fail closed), so an old caller can never open the gate.
- Judge each request independently on a keep-alive connection (the guard is stateless per call).
- Direct (non-proxy) requests need no per-request call. Do not call `admitForwarded` for them with `xffUsable:false`.
- Loopback listener and agent socket: do not touch (implicit loopback also keeps `::ffff:127.x` and `::1` admitted anyway).

## 3. Burst → security bus, status snapshot (hub.ts / facade)

```ts
const offBurst = clientAllow.onBurst((b) =>
  bus.emit({ type: "allowlist-burst", count: b.count, ips: [...b.ips], lastIp: b.lastIp }),
);
cleanup.push(async () => offBurst());
```

- `onBurst` handlers run synchronously inside the denial path; keep them cheap (the bus is already sync + isolated; throws are caught).
- The guard has NO timers. The facade's "re-emit status ≤ every 30 s + one unref'd trailing timer cleared in `close()`" is yours:
  `onStatus({ ...status, allowClients: clientAllow.snapshot() })` — set `allowClients` only when `clientAllow.active`, so an inactive
  guard keeps `LanStatus` byte-identical. `snapshot()` is O(entries) and allocation-light, safe to call on every status tick.
- `snapshot()` = `{entries, denyAll?: true, denied?: {total,lastAt,lastIp}}`; `lastIp` is `"(invalid)"` for unparseable peers.

## 4. Status rendering (agent/index.ts `lanStatusLines`, commands/webhub.ts) — A owns the text, you pass the data

- `formatLanStatusLines(rec?.lan, { settingsEnabled, hubPid?, paths, counts?, tfa? })` — `tfa` is OPTIONAL, the `data` of `tfa_req status`
  (type `TfaStatus`, exported). Absent ⇒ no `2fa=` segment. Rendered: `2fa=totp+feishu（恢复码剩 N）` | `2fa=totp（…）` | `2fa=feishu（…）` |
  `2fa=off` | `2fa=inconsistent`, appended to the `lan=on …` main line before the plaintext warning; `repairNeeded`/`inconsistent` add a
  warning line with 「/webhub 2fa repair --confirm」. Deviation note: the recovery count is shown for every enrolled form, not only `totp+feishu`.
- `formatLanOnLines(status, counts?, tfa?)` now also renders: allowlist marker line (`allowlist: <entries> · denied N · last <time> <ip>`;
  `allowlist: deny-all` + Chinese warning), and the `loginIpsRebuiltAt` notice.
- `formatLanOffLine`: `db-invalid` with detail `2fa-at-v1|2fa-schema|2fa-missing-row` (also tolerated with a `db-invalid:` prefix) renders
  `db-invalid:<detail>` + the repair hint and does NOT tell the user to move `hub.db` (that would silently drop 2FA). Other details unchanged.
- `formatInvalidAllowClientsLine(tokens: InvalidClientCidr[])` — mirror of `formatInvalidExtraHostsLine`; call it next to it in
  `commands/webhub.ts:~232` with `warnings.invalidAllowClients`.
- `formatProxyStatusLines(proxy, { ..., allowlistActive })` — pass `allowlistActive: rec.lan?.state === "on" && rec.lan.allowClients !== undefined`;
  adds ` · allowlist` to the first `proxy: on · lan …` line only (never on loopback-only). Omitted ⇒ byte-identical.

## 5. Invariants you must preserve

1. Exactly one guard instance shared by the LAN listener and all proxy listeners (counters/burst/throttle are per guard).
2. `admitPeer` is the FIRST thing on a new LAN connection: no lease, no bytes, no timers on deny. Never reorder behind `connGuard.admit`.
3. Never wrap guard calls in `?.` / try-catch-allow: a throwing/missing guard must not become "admit". (The guard itself never throws.)
4. `entries` semantics: `undefined` ⇒ inactive, `[]` ⇒ deny-all. Do not normalize `[]` to `undefined` anywhere on the path.
5. `E_CLIENT` is only ever written on trusted-proxy hops (request level); a denied direct client never receives bytes.
6. Audit records carry only `listener/ip/via/reason/suppressed` (guard-enforced); do not add fields or log the raw peer string.
7. Do not read the proxy listener's `ProxyListenerDeps.clientAllow` from config; it is plumbing, never user-reachable.

## 6. Tests not written by A (need your wiring)

`tests/web-hub/http/lan-allowlist.test.ts` (plan §10: no bytes/no slot on deny at the real LAN listener; allowed → denied → missing-XFF on one
keep-alive connection through a trusted proxy) needs `http.ts` wiring. The guard-level equivalent of that sequence is covered in
`tests/web-hub/hub/client-allow.test.ts`; the proxy listener (HTTP/enter/upgrade, inactive/allow/deny) in
`tests/web-hub/hub/proxy/listener-allowlist.test.ts`. The plan row's "`lan-status.test.ts` (ext)" is shipped as new files
`tests/web-hub/agent/{lan-status-security,proxy-status-allowlist}.test.ts` (allowlist forbids editing the existing file).
