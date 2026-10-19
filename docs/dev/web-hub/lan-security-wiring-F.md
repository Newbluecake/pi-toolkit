# LAN security — package F wiring request (TUI 2FA enrollment)

Owns: `src/web-hub/hub/admin.ts` (tfa_req dispatch), `src/web-hub/agent/{twofa-cmd,twofa-prompt}.ts`.
Plan refs: §5.8 (all), §6 (F only fetches tfa status), P0 addendum items 2/6. Nothing here is
wired yet; every call site below is yours (I). Invariants you must preserve are at the bottom.

## 1. hub: route `tfa_req` frames (agent-server.ts, next to the `lan_req` branch ~:227)

```ts
if (frame.t === "tfa_req") {
  if (deps.admin !== undefined) {
    deps.admin
      .handleTfaReq(frame, { agentKey, ...(agentPid === undefined ? {} : { agentPid }) })
      .then(write, (err: unknown) =>
        log.error("web-hub agent-server: admin tfa_req handler rejected", { error: String(err) }),
      );
  }
  return; // unknown/unrouted frames stay silently dropped, exactly like lan_req pre-wiring
}
```

## 2. hub: AdminDeps (hub.ts, wherever createAdminHandler is constructed)

```ts
advertiseTfa: true,                    // ONLY in the same merge that lands §1 routing (P0:
                                       // never advertise lan.2fa.v1 before routing works)
emit: (e) => securityBus.emit(e),      // P0 addendum item 6 → hub/security-events.ts bus
repair2fa: () => repairLan2fa({ dbFile, log }),  // B's maint op; works with the LAN store OFF
feishuOwner: () => /* feishuBot install owner present */,
```

`emit` also makes the existing `lan_req passwd` op emit `{type:"passwd"}` — no other change needed.
`repairLan2fa` (B) self-audits the `phase:"admin"` repair line; `admin.ts` deliberately does NOT
audit repair once the dep was invoked (no duplicates). `2fa-changed{op:"repair"}` stays with F.

## 3. agent: widen `HubConnection.request()` (connection.ts)

Same pattern as the FA fsb widening: accept `TfaReqFrame`, resolve the rid-matched `tfa_res`
(decoded via `decodeHubFrame`, already in P0 `protocol/messages.ts`), honoring `requiredCap`.

## 4. commands: `/webhub 2fa` (src/commands/webhub.ts)

Add `"2fa"` to `SUBCOMMANDS` + `SUBCOMMAND_DESCRIPTIONS`
(`2fa: "局域网二次验证：status/enroll/feishu/recovery/reset/forget-ips/repair（除 status 外仅 TUI）"`),
then dispatch (mirrors the passwd case):

```ts
case "2fa":
  await runTwofaCommand(tokens.slice(1).join(" "), ctx, makeTwofaDeps(ctx, deps));
  return;
```

`makeTwofaDeps` (per invocation; never cached across /reload):

```ts
const makeTwofaDeps = (ctx, deps): TwofaCommandDeps | undefined => {
  const conn = currentConnection();                    // agent/connection.ts singleton
  if (conn === undefined) { notify(ctx, "hub 不在线。", "warning"); return undefined; }
  return {
    hasCap: (cap) => conn.caps.includes(cap),
    request: (frame, cap) => (conn as TfaRequestCapableConnection).request(frame, cap), // §3
    promptCode: (title) => ctx.ui.custom((tui, done) => new MaskedInputComponent(title, tui, done)),
    showEnrollment: ({ otpauthUri, secretB32 }) => {
      try { notify(ctx, renderQr(otpauthUri) + `\n手动输入（base32）：${secretB32}`); }
      catch { notify(ctx, `otpauth: ${otpauthUri}\n手动输入（base32）：${secretB32}`); } // qr-too-large
    },
    showRecoveryCodes: (codes) => notify(ctx, `恢复码（仅显示一次）：\n${codes.join("\n")}`),
    hasFeishuOwner: async () => {
      const port = defaultFeishuAdminPort();
      if (port === undefined || !port.live) return false;
      const res = await callFsb(port, { t: "fsb_req", rid: newAdminRid(), op: "info" });
      return res.ok && isFsbInfoData(res.data) && /* owner confirmed */;
    },
    notify: (m, level) => notify(ctx, m, level),
  };
};
```

`MaskedInputComponent` is exported from `src/web-hub/agent/passwd-prompt.ts` (reuse, don't copy).
`renderQr` is `src/commands/qr-render.ts:23`.

## 5. `/webhub status` lan line (P0 addendum item 2)

F only FETCHES: `const tfa = await fetchTfaStatus(twofaPort)` (`agent/twofa-cmd.ts`; undefined on
no-cap/transport/wrong-kind — never throws). You pass the `TfaStatusData | undefined` into A's
`agent/lan-status.ts` renderer, which owns the `2fa=…` segment text. Bounded: only fetch when the
cap is present; the fetch rides the same request deadline as other admin frames.

## B contract notes (binding)

- `commitTotp` preserving an existing recovery set returns `{ok:true, recoveryCodes: []}` ⇒
  admin.ts answers the frozen `{kind:"ok"}` variant; the TUI prints 「沿用既有恢复码」 and shows
  no codes. First enrollment (10 codes) keeps the `totp_confirm` variant.
- `repairLan2fa` self-audits; admin.ts never emits a second repair audit (§2).

## Invariants for I to preserve

1. **I6 / r1-#4 gate**: `ctx.mode==="tui" && !isWebInvocation(ctx)` is checked inside
   `runTwofaCommand` BEFORE any frame/render for every subcommand except `status`. Do not wrap,
   pre-approve, or bypass it from command policy (`webhub: allow` must NOT weaken it — pinned by
   `tests/commands/webhub-2fa.test.ts`).
2. **Secret boundary**: `otpauthUri`/`secretB32`/`recoveryCodes` may only travel over the agent
   socket `tfa_res` and into `showEnrollment`/`showRecoveryCodes`. Never into audit, `hub.json`,
   `HubLog`, Feishu, or browser output. `auditLan2fa` phase `admin` whitelists `{op, ok}` only.
3. **Caps**: `lan.2fa.v1` appears in `admin.caps()` only with `advertiseTfa:true`; keep the
   hello_ack / HubInfo caps fold byte-identical (both spread `admin.caps()` already).
4. **Primary account**: tfa ops resolve the user via `initialInfo()` + `getUser()` (no username
   selector, per P0). Don't add one.
5. `repair` must not go through any LAN-store gate — it exists precisely for `db-invalid` LAN-off.
6. Codes printed once: never call `showRecoveryCodes` more than once per successful op; a rerender
   requires a new `recovery_regen` frame.
