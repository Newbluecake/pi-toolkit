# LAN security D/E/F/G integration report (LAN-I, phase 2)

Date: 2026-10-20. Branch: `dev`, main checkout. Baseline: `df26bbbf` (phase 1 and collected follow-ups).
Reused phase 1's gate procedure: squash D → E → F → G, each as ONE user-facing Conventional Commit,
then a separate wiring commit, typecheck and FULL `timeout 1800 npm test` before the next package.
No push, branch deletion, running-hub restart, golden regeneration, or `git add -A`/`.`.
Every commit used exact paths and `git commit --no-verify` after `npx prettier --write` on those paths.

## Commits

| Package                                | Import                                                                      | Wiring                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D                                      | `70a97446` manage LAN login sessions and revoke devices                     | `920042e7` wire LAN device sessions and verification methods            |
| E (including branch rework `486fd19b`) | `1fdb0c34` alert on LAN security events and approve logins in Feishu        | `45b40ee7` wire Feishu security alerts and LAN approval decisions       |
| F                                      | `7fc2f9b7` enroll and recover LAN second factors from the local terminal    | `c0509c70` wire trusted local two-factor setup and socket controls      |
| G (including branch rework `5036059d`) | `171ed016` guide new-IP logins through authenticator or Feishu verification | `e6dba500` wire capability-gated two-factor login and cancellation      |
| Final activation / P5                  | —                                                                           | `377f8879` activate verified LAN second factors and device capabilities |

Follow-up fixture commits: `186787f6` supplies explicit LAN guards in integration fixtures (D);
`b8545237` includes 2FA in an old command-completion contract (F). These are deliberate extra commits,
not extra squash imports. All four squash merges were conflict-free; existing phase-1 wiring was preserved.
This report is committed separately (its commit is the one adding this file).

The other agent's concurrent cache work was committed as `ec42b677` during D's gate. It is NOT part of this
manifest or LAN delivery. Its previously uncommitted cache files and `AGENTS.md` were never edited,
formatted, staged, reverted or stashed by LAN-I.

## Wiring / semantic evidence

Coordinates are at `377f8879` unless otherwise stated. `hub/`, `agent/`, `protocol/` and `ui/`
paths below are relative to `src/web-hub/`; test/command/doc paths are repository-relative.

### D / I2 / I3 / I4: sessions, method metadata, revocation

- `hub/http.ts`: constructs/disposes `createLanSessionsRoutes` per LAN frontend and mounts it ONLY on
  the LAN router after the proxy branch. Auth IPC shares the route's 10 s deadline; cookie clearing,
  `lanSse.revoke` and THE shared `authRevoke` bus are injected. Loopback stays 404.
- `hub/db.ts`, `hub/db-child.ts`: nullable `session_meta.method TEXT`; the exact legacy side-table shape
  gets `ALTER TABLE … ADD COLUMN` + password backfill INSIDE maintenance transaction, retaining UA/IP.
  Existing sessions without metadata/null method project as `password`. No security-table auto-repair.
- `hub/ports.ts`, `protocol/lan-sessions.ts`: additive optional method fields restricted to
  `password|totp|feishu|recovery`. `hub/lan-login.ts:328` remains the ONLY production checked-insert
  caller; `complete()` always passes its satisfied method. Removed `runLanLogin` and its unchecked insert;
  its limiter/KDF regression tests now exercise the checked core.
- `SettingsView.vue` mounts D's card behind `lan.sessions.v1` AND password mode, using abortable same-origin
  GET/POST with X-PWH. New `styles/sessions.css` supplies the approved per-device 1B layout. The card adds
  「验证方式」 / “Verification method”, all four zh/en labels and legacy password fallback. Its separate
  `revoking` flag disables every action until revoke + refresh settle, preventing a second POST.
- `tests/web-hub/contract/lan-security-store.test.ts`: identical fake AND real SQLite assertions for all four
  methods; existing epoch/gen CAS, cap, recovery parity, Q15 and monotonic-generation tests remain green.
  `db-lan-security.test.ts` proves additive migration preserves metadata and survives reopening.
  `protocol/lan-2fa.test.ts` pins legacy wire acceptance, all four method values and rejection of invalid values.
- `tests/web-hub/http/lan-sessions-consumers.test.ts`: REAL sessions route + frontend bus + actual proxy
  session/forwarding engine + actual HTML capability registry. Revoke kills an active HTTP stream AND
  upgraded WebSocket, rejects their gate cookie on next HTTP, kills HTML cap + SSE + LAN identity, and leaves
  the other device/cap alive. Existing producer race/deadline/unknown-effect tests remain unchanged.

### Phase-1 mandatory follow-ups

- D's `lan-rollout.test.ts` was committed and passed through REAL `startHub` while production still forced
  `secondFactorEnabled:false` (staged account login 200, factor endpoints 404, no caps). The activation commit
  updates that SAME regression to require a new-IP challenge, zero session rows and both cap surfaces.
- `hub/proxy/service.ts`: `clientAllow` is REQUIRED, never `| undefined`; service never manufactures a fallback.
  A configured LAN proxy receives the identical hub guard used by HTTP. Loopback-only proxy construction
  explicitly supplies an inert guard. `http.ts` rejects a missing LAN guard rather than manufacturing another.
  Legacy direct-frontend test assemblies were updated to supply explicit guards; identity tests stay meaningful.
- Removed the dead password-only `runLanLogin` (not merely documented it). No production bypass remains.

### E / I5: Feishu alerts and approval

- `hub/hub.ts`: one early closure-local security bus shared by limiter, allowlist bursts, spawn routes,
  proxy routes, login core and Feishu service. `agent/index.ts` forwards `securityAlerts` from settings
  (default true); absent bot config remains inert. `lan-assembly.ts` forwards transition-only limiter events.
  LAN proxy route IO now carries the resolved client IP, never an untrusted/raw forwarded string.
- `LanFrontendDeps.approval` gets the stable `bot.approval` delegate. `onLoginCore` registers the live frontend
  core for `botDeps.onApprovalDecision`, and is cleared on facade/scope disposal. Bot stop still happens FIRST
  during teardown. No module-scope mutable state, new unbounded wait or credential path was introduced.
- E's notice budget remains shared with normal notify; owner-only, nonce/gen/tenant-bound approval and
  late-send/cancel/stop cleanup remain in the verified package. The accepted JSON nonce-target encoding
  carries both challenge id and generation (no frozen wire change).
- `hub-feishu.test.ts` pins the shared bus, approval identity and cleared decision sink.
  `http/lan-security-emits.test.ts` proves real LAN proxy opens emit resolved IP + pinned target exactly once;
  loopback opens do not. E's full spawn seam suite proves accepted-only LAN emission, never dup/Feishu origin.

### F / I6: trusted TUI setup, policy and status

- `hub/agent-server.ts` routes `tfa_req` on the trusted local socket; `agent/connection.ts` has typed
  `tfa_req`/`tfa_res`, cap-before-bytes, rid correlation and bounded disconnect/timeout rejection.
- `commands/webhub.ts` dispatches `/webhub 2fa`, uses the real masked input and QR renderer, and displays
  enrollment/recovery secrets in a LOCAL widget, not truncated `notify`. The widget expires after 5 min
  on an unref'd timer; disposed UI cleanup is swallowed, never an uncaught timer error. Secrets are never
  persisted to hub.json, audit, command output or Feishu. Tests pin one widget display and expiry.
- Hub `feishuOwner` reads the live bot owner snapshot; admin also fails closed if the dependency is absent.
  `repair2fa` calls B's real maintenance op while the store is off; events come from the admin's post-commit
  seams. Status uses B's real `repairNeeded` / open-path db-invalid detail (all three refusal details tested),
  not an invented universal `2fa-missing-row`. `/webhub status` fetches TFA only with the cap and passes it
  to A's renderer.
- Replaced F's tautological policy test: the REAL capture engine + `wrapCommandApi` creates the context proxy,
  `resolveCommandPolicy({overrides:{webhub:"allow"}})` allows dispatch, then the actual registered command
  refuses EVERY secret subcommand before frames/widgets/QR. Captured refusal output is secret-free.
- Checked installed pi 1.2: `AgentSession.sendUserMessage` defaults `expandPromptTemplates:false`, so a prompt
  does not execute extension commands. Defense-in-depth: web `prompt` text beginning `/webhub 2fa` or
  `/webhub passwd` now rejects `E_COMMAND_DENIED` before mention/topic/hold/native dispatch. The explicit
  command-op TUI gate still applies independently of policy overrides; passwd's captured-context gate was
  aligned too. No arbitrary prompt text is rewritten or interpreted as a command.
- Real socket + SQLite Q15 test in `hub-lan.test.ts`: actual TOTP enrollment clears trusted `login_ips`, issues
  ten codes, keeps the existing session (Q16), and returns status with zero known IPs. Missing Feishu owner
  refuses enrollment. Shared fake/SQLite contracts also prove first-enrollment clearing.

### G / I7: typed cap-gated login UI

- `transport/types.ts` honestly represents the second-factor login union and the three factor methods;
  `password.ts` forwards them, and G's temporary `login:any` boundary cast is REMOVED. Login factor 401s
  never enter the REST “lost session” endpoint set.
- `usePasswordAuth.ts` owns the network/state machine. Feishu polling starts IMMEDIATELY while TOTP/recovery
  remains visible, deduplicates by challenge identity, and survives method switches. Success fences late
  callbacks; cancellation drains before another password request. Denied/expired/error, explicit cancel,
  abandoned LoginView unmount and dispose cancel the pending flow; a successful stream opening first is
  treated as success, never accidentally cancelled by unmount.
- `LoginView.vue` mounts G's pure component ONLY behind the cap + password App branch, maps attempt/lock/error
  props and emits, and owns a disposed ticker. `App.vue` imports `login-2fa.css` directly beside `login.css`.
- Necessary additive bootstrap: a FRESH unauthenticated page cannot receive authenticated SSE hub caps.
  HTTP therefore passes `UiServer.serve({lan2fa:true})` ONLY when the internal gate AND advertised `lan.2fa.v1`
  both hold; the verified password index gains `data-lan-caps="lan.2fa.v1"`. App reads it to gate the flow.
  Off/absent and token HTML bytes remain identical, including gzip; no new endpoint/request/auth authority.
  This public feature marker never contains secrets. Unit and mounted-flow tests cover the compatibility path.

### Final activation / P5

- Production `secondFactorEnabled:true`, `advertiseTfa` iff configured LAN, and static `lan.sessions.v1` iff
  configured LAN were flipped ONLY in `377f8879`, after all four per-package gates and pre-flip format/build/web
  checks passed. Both hello_ack and HubInfo cap surfaces are set/order-equal. Loopback-only caps stay unchanged.
- `tests/integration/web-hub-feishu-bot.test.ts` adds LAN-P5 to the existing REAL child-hub/native-WebSocket
  fixture (no production env seam). Real SQLite + real scrypt + real TOTP/recovery + real Feishu callback
  nonces → each completion inserts ONE session and emits ONE method-labelled login-success event. The optional
  session method wire is verified for every login. New + known-IP password are covered; pending challenges
  do not insert sessions; Q15 is asserted through the socket. A LAN spawn + identical retry emits ONE event
  and ONE Feishu notice. All new-IP method notices include the correct method; hub.json/log do not leak the
  enrollment key. Feature-off fixture inspection remains byte-identical.
- Clarification, not a behavioral deviation: known-IP password success emits one `login-success{newIp:false}`
  event, but deliberately sends NO high-risk Feishu notice (plan §4.3; E suppresses known-IP notices).

## Validation

Per-package gates (the next import happened only after the final green full run):

| Gate | Full command            | Result                                     | Wall time | Typecheck                              |
| ---- | ----------------------- | ------------------------------------------ | --------- | -------------------------------------- |
| D    | `timeout 1800 npm test` | 1187 files; 22883 tests passed, 22 skipped | 268.11s   | `timeout 180 npm run typecheck` passed |
| E    | `timeout 1800 npm test` | 1191 files; 22915 tests passed, 22 skipped | 270.39s   | same, passed                           |
| F    | `timeout 1800 npm test` | 1193 files; 22967 tests passed, 22 skipped | 272.92s   | same, passed                           |
| G    | `timeout 1800 npm test` | 1195 files; 23011 tests passed, 22 skipped | 269.12s   | same, passed                           |

Raw green logs: `/tmp/lan-d-full-pass.log`, `/tmp/lan-e-full.log`, `/tmp/lan-f-full-pass.log`,
`/tmp/lan-g-full-pass.log`; matching `*-type-*.log` files contain the typecheck output.

Failures, isolated reruns and fixes (nothing hidden as “all first-pass green”):

1. D `/tmp/lan-d-full.log`: 2 failed files / 10 failed tests (old UI integration and PV-starvation assemblies
   omitted their now-required guard). Focused reproduction `/tmp/lan-d-fail-alone.log` confirmed the same
   deterministic guard error. A partial-fixture rerun `/tmp/lan-d-full-final.log` still had 1 failed test
   (the child assigned `.lan = …`, not a `lan:{…}` literal). Fixed both precise fixtures in `186787f6`;
   final full passed. Post-fix standalone FILE checks also passed: UI integration 15 tests
   (`/tmp/lan-d-ui-alone-pass.log`), PV starvation 1 test (`/tmp/lan-d-pv-alone-pass.log`). No weakened
   assertion/threshold or production fallback restored.
2. F `/tmp/lan-f-full.log`: 1 failed test in `tests/commands/webhub-feishu.test.ts` (old exact completion list).
   Isolated FILE rerun `/tmp/lan-f-fail-alone.log` reproduced it. Updated only the expected additive `2fa`
   command in `b8545237`; final full passed.
3. G `/tmp/lan-g-full.log`: existing F10 SW1 strict absolute-expiry equality differed by 1ms (same flake as
   phase 1). Isolated entire file `/tmp/lan-g-fail-alone.log`: all 14 tests passed. Unchanged-code full rerun
   passed. SW1 assertion and production session-card code were NOT changed.
4. New P5 fixture was iterated against actual admission (valid ≥16-char spawn id, explicit LAN confirmation
   and expectCwd); its complete F10 file finally passed 15 tests (`/tmp/lan-p5-entire-pass.log`, 38.92s).
   Initial off-fixture metadata projection was corrected to remain absent when LAN is off. These were new-test
   construction errors, not waived behavior or golden regeneration.

5. Final `/tmp/lan-final-full.log`: 1 failed / 1194 passed files; 23012 passed / 1 failed / 22 skipped tests.
   `auth-identity.test.ts` hit an ephemeral-port race (`listen EADDRINUSE`, 0.0.0.0:35979) in its old
   free-port-then-bind fixture. Isolated entire file (`timeout 120 npx vitest run tests/web-hub/http/auth-identity.test.ts`,
   `/tmp/lan-final-fail-alone.log`) passed all 22 tests. No code/fixture/threshold change; unchanged-code full rerun
   passed ALL tests below.

Final gates, all on the activated code (`377f8879`; report-only formatting afterwards):

| Exact command                                                                  | Result / evidence                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `timeout 180 npm run format:check`                                             | PASS, all matched files; `/tmp/lan-final-format.log`; run again including this report                                            |
| `timeout 180 npm run typecheck`                                                | PASS, all three tsc/vue-tsc stages; `/tmp/lan-final-type.log`                                                                    |
| `timeout 180 npm run build`                                                    | PASS; `/tmp/lan-final-build.log`                                                                                                 |
| `timeout 180 npm run build:web`                                                | PASS; `/tmp/lan-final-web.log` (existing advisory >500kB chunk warning only)                                                     |
| `timeout 120 npm run check:web`                                                | PASS, 19 files; first-screen JS 296730 / 524288B gz, lazy JS 46430 / 131072B, CSS 31360 / 65536B; `/tmp/lan-final-check-web.log` |
| `timeout 1800 npm test`                                                        | PASS, 1195 files; **23013 passed, 22 skipped**, 263.76s; `/tmp/lan-final-full-pass.log`                                          |
| `timeout 900 npx vitest run --config tests/web-hub/hub/spawn/golden.config.ts` | PASS, 9 files / **192 tests**, 279.66s; `/tmp/lan-final-golden.log`; no golden changed                                           |
| `git diff --check`                                                             | PASS                                                                                                                             |

Pre-flip format/build/build:web/check:web also passed (`/tmp/lan-preflip-*.log`), in addition to every
per-package typecheck/full-suite gate. The final golden pass and final unchanged-code full rerun use the
same source tree; no production changes were made between them.

## Deviations / residual acceptance

- Extra precise fixture commits D/F are listed above; they were needed by real full-suite failures.
- Added the pre-auth static cap bootstrap because an authenticated SSE-only cap gate would make the first
  ever second-factor login impossible. Its opt-in/off-byte compatibility is explicitly tested and documented
  as an authorized additive integration amendment in `lan-security-P0-surfaces.md`.
- Optional B hardenings (repair of a missing DB file; tie/backwards-time session trim edge) remain deferred,
  exactly as phase 1 accepted. No new security-table auto-repair behavior was invented.
- Real tenant / real browser-device acceptance remains manual; fake Feishu transport is NOT represented as
  tenant acceptance. No live hub was restarted, so the operator must choose when to activate deployed source.
- No Agent-dispatch tool is exposed in this integrator session. Independent verification cannot be launched
  here; root was notified at final code commit with coordinates. Self-validation is not labelled independent.
- `AGENTS.md` was deliberately NOT edited; the following P5 paragraph is for the main session to apply.

## AGENTS.md P5 text (main session applies; LAN-I did NOT edit AGENTS.md)

> **LAN security (lan-security plan r2, phase 2)**: `hub/client-allow.ts` supplies ONE hub-owned guard to LAN
> HTTP and every proxy listener (explicit inert guard without LAN; missing configured guard is never a fallback).
> `hub/lan-login.ts` owns the sole checked session completion, with epoch/factor-generation CAS and bounded
> cancellation/late-insert cleanup for password/TOTP/recovery/Feishu approval. Enrolled accounts require a second
> factor from a new IP (30 d history; unusable trusted-proxy XFF stays new); pending challenges are never sessions.
> `hub/lan-sessions.ts` lists/revokes ≤32 LAN sessions with one 10 s revoke deadline and shared auth-revoke fan-out
> to proxy HTTP+WS, HTML caps and SSE. Nullable `session_meta.method` migrates additively; legacy reads as password.
> The settings card is cap+password gated and disables all actions during revoke. `/webhub 2fa` uses trusted-local
> TUI-only masked setup and bounded secret widgets, independent of web command policy; web prompt-op auth-admin
> text is also refused. Admin repair preserves B's actual db-invalid detail. Feishu approval uses the live owner,
> sibling nonces/gen/tenant binding and a stable runtime delegate; alerts share notify's budget and are settings-gated.
> `lan.2fa.v1` / `lan.sessions.v1` are advertised on both surfaces iff LAN is configured, after all D/E/F/G gates.
> Fresh password index bytes carry only a public `data-lan-caps` bootstrap for the login UI (off/token bytes unchanged);
> G's polling survives method switches and is cancelled on abandonment. Gates: fake+SQLite contracts, actual revoke
> consumers, real socket Q15 enrollment, and LAN-P5 real child hub × SQLite × fake Feishu callback integration.
> Design / integration evidence: `docs/dev/web-hub/{lan-security-plan,lan-security-P0-surfaces,lan-security-DEFG-integration-report}.md`.

## Changed-file manifest (absolute paths; this phase ONLY)

98 files (including this report; excluding concurrent cache/AGENTS work):

```text
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-DEFG-integration-report.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-P0-surfaces.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-integration-notes.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-D.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-E.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-F.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-G.md
/home/bluecake/ai/pi-toolkit/src/commands/webhub.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/commands.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/connection.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/twofa-cmd.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/twofa-prompt.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/admin.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/agent-server.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-child.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/notify.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/security.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/service.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-assembly.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-auth.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-login.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-sessions.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/routes.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/service.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ratelimit.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/spawn/entry.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/spawn/routes.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/static.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/lan-sessions.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/App.vue
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/shell/LoginSecondFactor.vue
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/shell/LoginView.vue
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/shell/SettingsSessionsCard.vue
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/shell/SettingsView.vue
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/composables/useLanSessions.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/composables/usePasswordAuth.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/contracts.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/en/login.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/en/sessions.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/zh/login.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/zh/sessions.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/password-client.js
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/userAgent.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/styles/login-2fa.css
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/styles/sessions.css
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/transport/password.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/transport/types.ts
/home/bluecake/ai/pi-toolkit/tests/commands/webhub-2fa.test.ts
/home/bluecake/ai/pi-toolkit/tests/commands/webhub-feishu.test.ts
/home/bluecake/ai/pi-toolkit/tests/commands/webhub.test.ts
/home/bluecake/ai/pi-toolkit/tests/integration/fixtures/pv-starvation-child.ts
/home/bluecake/ai/pi-toolkit/tests/integration/web-hub-feishu-bot.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/commands.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/connection-admin.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-feishu.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/contract/fakes.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/contract/lan-security-store.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/api-worktree-diff.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/api-worktree-graph.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-avatar.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-helpers.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-login-integration.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-password-client.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-preview.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-rollout.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-run.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-security-emits.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-sessions-consumers.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-sessions-revoke-propagation.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-sessions.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-upload.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/proxy-lifecycle.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/pv-lan-kit.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/ratelimit.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/static.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/admin-tfa.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/caps-coexist.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-lan-security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/login-approval.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/service.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub-feishu.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub-lan.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-auth.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/engine-helpers.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/spawn/lan-security-emits.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/lan-2fa.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/hub-http-integration.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/login-factor-wiring.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/login-second-factor.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/settings-sessions-card.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/user-agent.test.ts
```
