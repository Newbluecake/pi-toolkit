# LAN security P0 — frozen surfaces (r2)

Status: P0 only; no HTTP/hub request wiring, cap advertisement, DB migration or commit.
Paths below are repository-relative; § references are to `lan-security-plan.md`.

## Decisions packages must use

- `parseClientCidr` → canonical string/undefined; matcher → `(ip) => boolean`, explicit entries only. Implicit loopback belongs to A. IPv4 and IPv6 networks are separate families; mapped ≥96 CIDRs become IPv4.
- Settings always parse the new defaults. `allowClientsDenyAll:true` distinguishes configured-but-all-invalid from inactive `allowClients:[]`; I later sends present `HubLanConfig.allowClients:[]` for deny-all. First 64 distinct valid entries win; overflow is reported.
- Additive settings fields, `RequestContext.xffUsable`, assembly security bus and proxy-route `ip` are optional for old callers. ABSENT `xffUsable` means false: A/C must test `=== true`. I supplies it from proxy warnings when wiring.
- P0 deliberately does NOT forward the new settings in `buildHubConfig`; hub revalidation accepts them, absent keys stay byte-identical. `securityAlerts` absent on the hub wire means false, even though its settings default is true.
- Socket responses use required `data.kind` (`status|totp_begin|totp_confirm|recovery_regen|ok`). Reset/repair require `confirm:true`; begin supports `replace:true`. Requests target the hub’s primary LAN account (same account as LAN info). No username selector.
- Feishu-only FIRST enrollment returns `data.kind:recovery_regen` so recovery secrets stay in the three permitted variants. Turning off the sole Feishu factor explicitly unenrolls (clear codes, bump gen; B updates metadata atomically).
- `SecurityEvent.type` discriminates events; burst payload retains `kind:totp|recovery`. Changed-op names are the mutating TFA wire ops, not a second vocabulary.
- Store `verifyTotp`/`consumeRecovery` use `expectedGen`; checked insertion uses `expectedFactorGen` + `expectedEpoch`. Reset retains monotonic generation even when state becomes none; forgetLoginIps bumps every enrolled generation. `touchSession` takes optional `ip` in its existing options argument.
- `LoginIo` carries UA, cancellation and live-response probe; `RequestContext.ua` carries the same current request header for cancel (which has no LoginIo); `LoginReply` contains status/body/headers/optional async after (core runs it at most once). I attaches after ONCE to finish, never close. Success body keeps today’s `initialPassword` field.
- Recovery request schemas accept canonical 12-char Crockford codes. UI/core normalize case, separators and aliases with `normalizeRecoveryCode` before validation/IPC.
- B embeds both import-free TOTP functions with injected SHA1-HMAC/constant-time primitives; replay/gen CAS stays in the child. P0 functions throw, not fake success.
- Fake store has a rejecting-by-default TOTP seam and before-op latches; it models CAS/caps/recovery/idle/history, NOT production crypto or SQLite schema safety.

## Frozen coordinates (plan point → surface)

Coordinates name both the file and the first declaration line for each export.

- **§1** — `src/config/settings.ts:49` (FeishuBotSettings); `src/config/settings.ts:965` (DEFAULT_WEBHUB_LAN_SETTINGS); `src/config/settings.ts:994` (DEFAULT_FEISHU_BOT_SETTINGS); `src/config/settings.ts:2324` (parseFeishuBotBlock); `src/config/settings.ts:2494` (WebHubLanParseResult); `src/config/settings.ts:2508` (parseWebHubLanBlock); `src/config/settings.ts:2555` (parseWebHubLanValidation); `src/config/settings.ts:2940` (loadWebHubLanSettingsWarnings)
- **§1 specs** — `src/config/setting-specs.ts:334` (webHub.lan.allowClients); `src/config/setting-specs.ts:338` (webHub.lan.sessionIdleMinutes); `src/config/setting-specs.ts:1138` (feishuBot.securityAlerts)
- **§1 settings types** — `src/web-hub/agent/index.ts:120` (WebHubLanSettings)
- **§1 warnings** — `src/commands/webhub.ts:78` (WebHubLanSettingsWarnings)
- **§1 wire check** — `src/web-hub/hub/lan-config.ts:21` (parseHubLanConfig)
- **§2.1** — `src/web-hub/protocol/client-allow.ts:2` (CLIENT_ALLOW_MAX); `src/web-hub/protocol/client-allow.ts:3` (IMPLICIT_ALLOWED); `src/web-hub/protocol/client-allow.ts:4` (InvalidClientCidr); `src/web-hub/protocol/client-allow.ts:62` (parseClientCidr); `src/web-hub/protocol/client-allow.ts:80` (normalizeClientIp); `src/web-hub/protocol/client-allow.ts:87` (createClientMatcher)
- **§2.4** — `src/web-hub/protocol/lan.ts:225` (LanStatus); `src/web-hub/protocol/lan.ts:240` (ClientAllowSnapshot)
- **§1/2/4 assembly** — `src/web-hub/hub/ports.ts:89` (HubLanConfig); `src/web-hub/hub/ports.ts:100` (RequestContext); `src/web-hub/hub/ports.ts:134` (LanAssembly)
- **§2 A** — `src/web-hub/hub/ports.ts:1234` (ClientAllowBurst); `src/web-hub/hub/ports.ts:1239` (ClientAllowGuard)
- **§2 A stub** — `src/web-hub/hub/client-allow.ts:4` (ClientAllowGuardDeps); `src/web-hub/hub/client-allow.ts:11` (createClientAllowGuard)
- **§3 B** — `src/web-hub/hub/ports.ts:1166` (LanSessionListRecord); `src/web-hub/hub/ports.ts:1184` (CreateSessionCheckedInput); `src/web-hub/hub/ports.ts:1193` (CreateSessionCheckedResult); `src/web-hub/hub/ports.ts:317` (LanSecurityStorePort); `src/web-hub/hub/ports.ts:317` (LanStorePort)
- **§3 B stub adapter** — `src/web-hub/hub/lan-security-stubs.ts:7` (unimplementedLanSecurityStore)
- **§3.1 B factory** — `src/web-hub/hub/lan-store.ts:74` (CreateLanStoreDeps); `src/web-hub/hub/lan-store.ts:405` (RepairLan2faResult); `src/web-hub/hub/lan-store.ts:406` (repairLan2fa)
- **§3.2 B helper** — `src/web-hub/hub/sid-hash.ts:15` (hashSid); `src/web-hub/hub/sid-hash.ts:20` (publicSessionId)
- **§3 wire** — `src/web-hub/protocol/lan-sessions.ts:3` (LAN_SESSIONS_PATH); `src/web-hub/protocol/lan-sessions.ts:4` (LAN_SESSIONS_REVOKE_PATH); `src/web-hub/protocol/lan-sessions.ts:5` (LAN_SESSIONS_PER_USER_MAX); `src/web-hub/protocol/lan-sessions.ts:6` (LAN_SESSION_ABSOLUTE_DAYS); `src/web-hub/protocol/lan-sessions.ts:7` (REVOKE_TOTAL_MS); `src/web-hub/protocol/lan-sessions.ts:8` (LAN_SESSIONS_CLIENT_TIMEOUT_MS); `src/web-hub/protocol/lan-sessions.ts:9` (LAN_SESSION_PUBLIC_ID_RE)
- **§3 schemas/types** — `src/web-hub/protocol/lan-sessions.ts:12` (LanSessionWireSchema); `src/web-hub/protocol/lan-sessions.ts:26` (LanSessionWire); `src/web-hub/protocol/lan-sessions.ts:27` (LanSessionsResponseSchema); `src/web-hub/protocol/lan-sessions.ts:36` (LanSessionsResponse); `src/web-hub/protocol/lan-sessions.ts:37` (LanSessionRevokeBodySchema); `src/web-hub/protocol/lan-sessions.ts:41` (LanSessionRevokeBody); `src/web-hub/protocol/lan-sessions.ts:42` (LanSessionRevokeResponseSchema); `src/web-hub/protocol/lan-sessions.ts:46` (LanSessionRevokeResponse)
- **§3 D** — `src/web-hub/hub/ports.ts:1294` (LanSessionsAuth); `src/web-hub/hub/ports.ts:1299` (LanSessionsIo); `src/web-hub/hub/ports.ts:1309` (LanSessionsRoutes); `src/web-hub/hub/ports.ts:1313` (LanSessionsDeps)
- **§3 D stub** — `src/web-hub/hub/lan-sessions.ts:4` (createLanSessionsRoutes)
- **§3 D UI** — `src/web-hub/ui/src/composables/useLanSessions.ts:4` (LanSessionsDeps); `src/web-hub/ui/src/composables/useLanSessions.ts:9` (LanSessionsHandle); `src/web-hub/ui/src/composables/useLanSessions.ts:17` (useLanSessions)
- **§3 D UA stub** — `src/web-hub/ui/src/logic/userAgent.ts:2` (userAgentLabel)
- **§4 bus** — `src/web-hub/hub/security-events.ts:4` (SecurityEvent); `src/web-hub/hub/security-events.ts:18` (SecurityEventBus); `src/web-hub/hub/security-events.ts:22` (createSecurityEventBus)
- **§4 E stub** — `src/web-hub/hub/feishu/security.ts:7` (NoticeBudget); `src/web-hub/hub/feishu/security.ts:12` (createNoticeBudget); `src/web-hub/hub/feishu/security.ts:15` (FeishuSecurityDeps); `src/web-hub/hub/feishu/security.ts:22` (FeishuSecurity); `src/web-hub/hub/feishu/security.ts:26` (createFeishuSecurity); `src/web-hub/hub/feishu/security.ts:29` (LoginApprovalDeps); `src/web-hub/hub/feishu/security.ts:49` (FeishuLoginApproval); `src/web-hub/hub/feishu/security.ts:60` (createLoginApprovalPort)
- **§4 E wire** — `src/web-hub/protocol/feishu.ts:687` (FeishuBotHubConfig); `src/web-hub/protocol/feishu.ts:718` (normalizeFeishuBotHubConfig)
- **§4 E route seam** — `src/web-hub/hub/ports.ts:1107` (ProxyRouteIo)
- **§5 B** — `src/web-hub/hub/ports.ts:1175` (Lan2faState); `src/web-hub/hub/ports.ts:1182` (LanFactorVerdict)
- **§5.3 B stub** — `src/web-hub/hub/totp.ts:3` (TotpCrypto); `src/web-hub/hub/totp.ts:7` (totpCode); `src/web-hub/hub/totp.ts:11` (verifyTotpCandidates)
- **§5.4 C** — `src/web-hub/hub/ports.ts:1260` (LoginIo); `src/web-hub/hub/ports.ts:1267` (LoginReply); `src/web-hub/hub/ports.ts:1273` (LanLoginCore); `src/web-hub/hub/ports.ts:1282` (LanLoginCoreDeps)
- **§5.4 C stub** — `src/web-hub/hub/lan-login.ts:4` (createLanLoginCore)
- **§5.7 E** — `src/web-hub/hub/ports.ts:1246` (LoginApprovalCloseReason); `src/web-hub/hub/ports.ts:1248` (LoginApprovalPort)
- **§5 constants** — `src/web-hub/protocol/lan-2fa.ts:4` (NEW_IP_WINDOW_MS); `src/web-hub/protocol/lan-2fa.ts:5` (LAN_SESSION_IDLE_MINUTES); `src/web-hub/protocol/lan-2fa.ts:6` (LAN_SESSION_IDLE_MIN); `src/web-hub/protocol/lan-2fa.ts:7` (LAN_SESSION_IDLE_MAX); `src/web-hub/protocol/lan-2fa.ts:13` (LAN_2FA_LIMITS); `src/web-hub/protocol/lan-2fa.ts:8` (LAN_2FA_COOKIE); `src/web-hub/protocol/lan-2fa.ts:9` (LAN_LOGIN_PATH); `src/web-hub/protocol/lan-2fa.ts:10` (LAN_2FA_PATH); `src/web-hub/protocol/lan-2fa.ts:11` (LAN_2FA_WAIT_PATH); `src/web-hub/protocol/lan-2fa.ts:12` (LAN_2FA_CANCEL_PATH)
- **§5 HTTP types/schemas** — `src/web-hub/protocol/lan-2fa.ts:35` (TOTP_CODE_RE); `src/web-hub/protocol/lan-2fa.ts:36` (RECOVERY_CODE_RE); `src/web-hub/protocol/lan-2fa.ts:38` (normalizeRecoveryCode); `src/web-hub/protocol/lan-2fa.ts:45` (LanFactorBodySchema); `src/web-hub/protocol/lan-2fa.ts:49` (LanFactorBody); `src/web-hub/protocol/lan-2fa.ts:50` (LanLoginMethod); `src/web-hub/protocol/lan-2fa.ts:51` (Lan2faChallengeSchema); `src/web-hub/protocol/lan-2fa.ts:60` (Lan2faChallenge); `src/web-hub/protocol/lan-2fa.ts:61` (Lan2faWaitSchema); `src/web-hub/protocol/lan-2fa.ts:65` (LAN_2FA_ERRORS); `src/web-hub/protocol/lan-2fa.ts:72` (LanLoginErrorSchema); `src/web-hub/protocol/lan-2fa.ts:85` (LanLoginSuccessSchema); `src/web-hub/protocol/lan-2fa.ts:89` (LanLoginResponseSchema); `src/web-hub/protocol/lan-2fa.ts:95` (LanLoginResponse)
- **§5.8 frames** — `src/web-hub/protocol/lan-2fa.ts:97` (TFA_REQ_TYPE); `src/web-hub/protocol/lan-2fa.ts:98` (TFA_RES_TYPE); `src/web-hub/protocol/lan-2fa.ts:99` (TFA_OPS); `src/web-hub/protocol/lan-2fa.ts:109` (TfaOp); `src/web-hub/protocol/lan-2fa.ts:116` (TfaReqSchema); `src/web-hub/protocol/lan-2fa.ts:126` (TfaReqFrame); `src/web-hub/protocol/lan-2fa.ts:127` (TfaStatusSchema); `src/web-hub/protocol/lan-2fa.ts:144` (TfaResDataSchema); `src/web-hub/protocol/lan-2fa.ts:158` (TfaResData); `src/web-hub/protocol/lan-2fa.ts:159` (TfaResSchema); `src/web-hub/protocol/lan-2fa.ts:172` (TfaResFrame)
- **§5.8 decode** — `src/web-hub/protocol/messages.ts:2112` (decodeAgentFrame); `src/web-hub/protocol/messages.ts:2117` (decodeHubFrame)
- **§3/5 caps DECLARED ONLY** — `src/web-hub/protocol/version.ts:326` (LAN_2FA_HUB_CAP); `src/web-hub/protocol/version.ts:327` (LAN_SESSIONS_HUB_CAP)
- **§5.8 F stub/cap gate** — `src/web-hub/agent/twofa-cmd.ts:6` (TwofaCommandDeps); `src/web-hub/agent/twofa-cmd.ts:10` (requestTfa); `src/web-hub/agent/twofa-cmd.ts:24` (runTwofaCommand)
- **§5.8 F prompt stub** — `src/web-hub/agent/twofa-prompt.ts:3` (TwofaPromptDeps); `src/web-hub/agent/twofa-prompt.ts:12` (TwofaPromptOutcome); `src/web-hub/agent/twofa-prompt.ts:14` (runTwofaEnrollPrompt)
- **§8 audit** — `src/web-hub/hub/audit.ts:694` (ClientDenyAuditRecord); `src/web-hub/hub/audit.ts:701` (CLIENT_DENY_AUDIT_KEYS); `src/web-hub/hub/audit.ts:738` (auditClientDeny); `src/web-hub/hub/audit.ts:702` (LanSessionAuditRecord); `src/web-hub/hub/audit.ts:712` (LAN_SESSION_AUDIT_KEYS); `src/web-hub/hub/audit.ts:741` (auditLanSession); `src/web-hub/hub/audit.ts:713` (Lan2faAuditRecord); `src/web-hub/hub/audit.ts:726` (LAN_2FA_AUDIT_KEYS); `src/web-hub/hub/audit.ts:744` (auditLan2fa)
- **§9 fake** — `tests/web-hub/contract/fakes.ts:40` (FakeLanStore); `tests/web-hub/contract/fakes.ts:58` (FakeLanStoreOptions); `tests/web-hub/contract/fakes.ts:65` (fakeLanStore)

UI component contracts: `src/web-hub/ui/src/components/shell/SettingsSessionsCard.vue:3` (sessions handle prop); `src/web-hub/ui/src/components/shell/LoginSecondFactor.vue:3` (challenge/busy/attempts/lock/clock props; submit/cancel/wait emits). Both render nothing and are unmounted. D namespace stubs: `src/web-hub/ui/src/i18n/{en,zh}/sessions.ts:2`.

## §9 exclusive module allowlists

All production paths here are under `src/web-hub/`; UI paths expand to `ui/src/` (actual repository layout). No module package edits any shared frozen file above. Own unit tests from §10 and one package wiring-request document are permitted alongside these code files.

| Package | Exclusive code files                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | `hub/client-allow.ts`, `hub/proxy/{listener,service}.ts`, `agent/{lan-status,proxy-status}.ts`                                                                                    |
| B       | `hub/{db,db-child,lan-store,sid-hash,totp}.ts` (remove the P0 stub spread from lan-store; shared adapter stays I-owned)                                                           |
| C       | `hub/lan-login.ts`, extracted helpers of `hub/lan-auth.ts`                                                                                                                        |
| D       | `hub/lan-sessions.ts`, `ui/src/components/shell/SettingsSessionsCard.vue`, `ui/src/composables/useLanSessions.ts`, `ui/src/logic/userAgent.ts`, `ui/src/i18n/{zh,en}/sessions.ts` |
| E       | `hub/feishu/{security,notify,service,inbound}.ts` (inbound only if needed), `hub/ratelimit.ts`, `hub/spawn/{entry,routes}.ts`, `hub/proxy/routes.ts`                              |
| F       | `hub/admin.ts`, `agent/{twofa-cmd,twofa-prompt}.ts`                                                                                                                               |
| G       | `ui/src/logic/password-client.js`, `ui/src/components/shell/LoginSecondFactor.vue`, `ui/src/i18n/{zh,en}/login.ts`                                                                |

I alone owns `hub/{http,hub,main,lan-assembly,agent-server,ports,audit}.ts`, `protocol/{messages,version,lan,lan-2fa,lan-sessions,client-allow,feishu}.ts`, `src/config/{settings,setting-specs}.ts`, `agent/index.ts`, `src/commands/webhub.ts`, `ui/src/components/shell/{SettingsView,LoginView}.vue`, `ui/src/i18n/index.ts`; P0 also owns the shared fake. Cross-allowlist needs must be reported, not silently patched.

## Required follow-on wiring (NOT part of P0)

- I forwards settings only when effective, wires A into both listeners, supplies `xffUsable`/UA/proxy-route IP and enables no active guard without A.
- I installs B real store ops and idle policy before C/D/F; C remains the sole checked-insert caller. Attach revocation, post-finish history/alerts, and all deadline/late-result cleanup.
- E gets one runtime notice budget shared with notify; never advertise TFA before F admin + local socket routing work. Connection request dispatch/response matching is I integration, not F.
- I mounts D/G only behind caps and password mode, adds F dispatch, and advertises both new caps on both hub surfaces only after corresponding implementations pass.
- §10 tests: parser/CIDR/schema/frame/cap contracts, real cap-coexistence, fake behavior, audit whitelist/bus isolation and compiler-checked port signatures are in the P0 test changes. No golden fixture was regenerated.

## P0 verification addendum (main-session rulings, 2026-10-19) — binding for A–G

1. **Guard activation (A)** — `createClientAllowGuard({entries})`: `entries === undefined` ⇒ inactive (`active:false`, every
   admit `true`); `entries` present but `[]` ⇒ **active deny-all** (only the implicit loopback is admitted). This mirrors plan §1:
   `HubLanConfig.allowClients` is present iff non-empty or deny-all, absent ⇒ inactive. A adds a contract test for both.
2. **2FA db-invalid / login_ips rebuilt (B → I → A)**:
   - B's open path reports refusal details exactly `2fa-at-v1` | `2fa-schema` | `2fa-missing-row` (no prefix); I maps them to
     `LanStatus {state:"off", reason:"db-invalid", detail}`.
   - B reports a `login_ips` rebuild at open as a boolean on its open result; I sets `LanStatus.on.loginIpsRebuiltAt`
     (`protocol/lan.ts`, added in P0).
   - **A owns all `/webhub status` lan-line rendering** in `agent/lan-status.ts`: allowlist line; `db-invalid:<detail>` + hint
     「/webhub 2fa repair --confirm」; the login_ips rebuilt notice; and a `2fa=…` segment rendered from an OPTIONAL
     `TfaStatus` argument (`2fa=totp+feishu（恢复码剩 N）` | `2fa=totp` | `2fa=feishu` | `2fa=off` | `2fa=inconsistent` +
     `repairNeeded`). F only fetches the status over `tfa_req status`; I passes it in.
3. `LanLoginCoreDeps.limiter.isFresh?` is not in the plan: C must not depend on it; I will not supply it.
4. **Recovery codes (B)** — `commitTotp` never regenerates an existing recovery set; the first factor enrollment of a user with no
   set generates 10 and returns them. `reset` keeps the `twofa_users` row (factors cleared, `factorGen` bumped).
5. **Sessions route errors (D)** — the existing hub error body `{error: code}` with `E_CSRF` / `E_AUTH` / `E_BAD_REQUEST` /
   `E_DB` / `E_RATE`; `E_CLIENT` never appears on the wire (a denied client gets no bytes).
6. **F emits** — `passwd` / `2fa-changed` security events are emitted from `hub/admin.ts` through an injected
   `emit(e: SecurityEvent): void` dependency; I wires it to the `security-events` bus.
7. New settings are parsed but not forwarded until I wires them — no release may ship between P0 and I's wiring.
8. B replaces the throwing production-store stubs with async implementations (the stubs throw synchronously today).
9. **Amends item 3 (C verification, 2026-10-20)** — C may (and should) call the optional `limiter.isFresh?.(ip) ?? true` for
   `admission.acquire`'s fresh flag, preserving the existing fair scheduling of the login KDF queue; it must still work when
   `isFresh` is absent. An `inconsistent` 2FA state answering 503 even for known IPs is accepted (fail-closed; factorGen is needed
   for the CAS).

## Phase-2 authorized additive integration amendments (2026-10-20)

- User ruling (D follow-up): `session_meta.method TEXT` is nullable and additively migrated (no table drop for the exact
  legacy shape). Existing metadata rows are set to `password`; missing/null legacy metadata also projects as `password`.
  `CreateSessionCheckedInput.method?`, `LanSessionListRecord.method?` and strict `LanSessionWire.method?` accept ONLY
  `password|totp|feishu|recovery`; C's sole `complete()` caller writes the satisfied method. D renders a zh/en method row.
- `Lan2faState.repairNeeded?` carries B's runtime diagnosis; admin also uses the exact open-path `LanStatus.off.detail`
  while the store is unavailable, rather than fabricating `2fa-missing-row` for every failure.
- `LanFrontendDeps.approval?` and `onLoginCore?(core|undefined)` bind the Feishu runtime delegate to the frontend's
  per-LAN core without a module-scope ref; registration is cleared on facade/scope disposal.
- Fresh password pages have no authenticated SSE cap snapshot. `UiServer.serve`'s optional `lan2fa` bootstrap is set ONLY
  when the internal production factor gate AND advertised `lan.2fa.v1` both hold. The verified index auth-mode substitution
  then adds `data-lan-caps="lan.2fa.v1"` on password HTML only (gzip included); absence/off/token preserve old bytes.
  This is public feature information, never a secret, identity or auth bypass. App gates LoginView from that marker.
