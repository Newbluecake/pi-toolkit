# LAN security — integration follow-ups for I (collected from package verifications)

Merge order A → B → C → D → E → F → G (plan §9). Branches: A `pi-agent-r_Q1CWPAMX`, B `pi-agent-r_J43KMS6B`,
C `pi-agent-r_QYKR6FC4` (+ rework commit), E `pi-agent-r_X730BNFY`, F `pi-agent-r_48FM5XTE`; D `pi-agent-r_KMGBJCWK`, G `pi-agent-r_HGDQR2BY` (all merged by LAN-I).
Each package's own wiring request: `docs/dev/web-hub/lan-security-wiring-<PKG>.md` (on its branch).

## From A (verified pass)

- **Closed (LAN-I/A):** `ProxyServiceDeps.clientAllow` is required (undefined only without LAN); one shared guard reaches BOTH listener kinds (I1); added
  `tests/web-hub/http/lan-allowlist.test.ts` (no bytes/no lease; one keepalive allowed→denied→missing XFF). Listener tags use `forListener()` / `tagClientAllowGuard()`.

## From B (verified conditional pass)

- **Closed (LAN-I/B):** Updated the stale P0 assertion `tests/web-hub/hub/lan-security-surfaces.test.ts:92-96` (repairLan2fa no longer throws).
- **Closed (LAN-I/B):** Fake store parity: `tests/web-hub/contract/fakes.ts` `commitTotp` returns `recoveryCodes: []` when a set exists (addendum #4), including an exhausted set; shared fake + real SQLite contract suite added.
- **Deferred (optional, outside wiring):** repair when the DB file is missing; self-eviction edge in the 32-session trim. No change to B's verified implementation in this phase.

## From C (verified rework merged, LAN-I wired)

- **Closed (LAN-I/C):** Strict `LanFactorBodySchema` validation (after recovery normalization) precedes `core.submitFactor`; response finish registers/executes `after()` exactly once, never close. Core owns all checked completions and the frontend subscribes/unsubscribes the revoke bus.
- **Closed (LAN-I phase 2):** staged production gate was regression-tested through real `startHub` before activation. After D/E/F/G gates, production enables second factors and both LAN capabilities together (no settings/env knob). The regression now pins required challenge + no session and cap parity; loopback-only remains unchanged.

## From F (verified conditional pass)

- Add a REAL policy-override test: `createCapturedCtx` + `webhub: allow` override ⇒ `/webhub 2fa …` still refused before frames
  (the existing test at tests/commands/webhub-2fa.test.ts:133-141 is tautological).
- Wire `feishuOwner` (hub-side owner check is fail-open when absent); set `advertiseTfa` only in the same merge as routing.
- Joint test: first enrollment clears `login_ips` (Q15, implemented in B).
- **Check**: a web `prompt` op whose text is `/webhub 2fa …` — confirm pi does not execute extension commands from
  `sendUserMessage` text (or that it arrives without the TUI-trusted context). If it can execute, block it (same class as
  `/webhub passwd`).
- Show QR / recovery codes via a widget rather than notify (truncation).
- `repairNeeded` detail should come from B's real detail, not the fixed "2fa-missing-row".

## Phase-1 integration verify follow-ups (r_9KH8R9H2, conditional pass, 2026-10-20)

- Before flipping `secondFactorEnabled` (hub.ts:~861) add a real startHub-level regression test for the production gate (not only the frontend `=== true` default).
- `proxy/service.ts:68,137`: make `clientAllow` required whenever `lan` is configured (drop the `| undefined` + inactive fallback); same for the `http.ts:~3025` `lan.clientAllow ?? createClientAllowGuard(...)` fallback.
- Delete the dead legacy `runLanLogin` (+ its `store.createSession` call) in `lan-auth.ts` and its test-only callers, or document why it stays.
- G (login UI) ships its styles as `src/web-hub/ui/src/styles/login-2fa.css` (no `<style>` blocks in .vue — source-scan gate): import it from `App.vue` next to `login.css`; mounting rules for `cancelSecondFactor()` live in `docs/dev/web-hub/lan-security-wiring-G.md`.

## D (sessions) verify follow-ups (r_HJ65FA67, conditional pass, 2026-10-20)

- User ruling 2026-10-20: ADD the 「验证方式」 row (approved 1B layout). Integrator adds a nullable `method` (`"password" | "totp" | "feishu" | "recovery"`) to B's session row (additive migration; legacy rows ⇒ `"password"`), C's `complete()` writes the method that satisfied login, `LanSessionWire` gains optional `method`, D's card renders one `<dt>/<dd>` pair (zh/en). Contract + migration tests.
- D card: disable the revoke buttons while a revoke is in flight (separate `revoking` flag), so a double click cannot fire a second POST.
- I's integration test must cover the real revoke consumers (proxy HTTP + WS sessions, HTML caps), not only stand-in subscribers.

## Phase-2 closure (LAN-I, 2026-10-20)

All mandatory follow-ups above are CLOSED; the two explicitly optional B hardenings remain deferred.
The final evidence/commit manifest is in `lan-security-DEFG-integration-report.md`.

- F: real `wrapCommandApi`/capture-engine context + `resolveCommandPolicy({webhub:"allow"})` runs the actual command
  and refuses every secret subcommand before socket/widget/QR work (`tests/commands/webhub-2fa.test.ts`).
- F/E: hub owner check is explicitly wired to the live bot snapshot AND fails closed when absent; the stable approval
  delegate reaches the registered LAN login core, cleared on disposal. `securityAlerts` is forwarded from settings.
- F: QR/manual key and recovery codes use a local-only widget (not truncated `notify`), with a 5 min unref'd expiry;
  status reads B's actual db-invalid detail, including while the store is off. `/webhub status` passes fetched TFA status
  to A's renderer. Real socket + SQLite TOTP enrollment and the real-child P5 path pin Q15 history clearing.
- F: pi 1.2's `sendUserMessage` defaults `expandPromptTemplates:false` (no extension-command execution). In addition,
  web `prompt` text starting `/webhub 2fa` or `/webhub passwd` now rejects with `E_COMMAND_DENIED` before dispatch;
  command-op policy overrides still cannot weaken the captured-context TUI gate.
- Phase 1: startHub-level pre-flip regression committed in D; proxy service requires a guard (including an explicit inert
  guard without LAN), HTTP rejects missing LAN guard, and both silent fallback constructors were removed. Deleted the
  legacy `runLanLogin`; `lan-login.ts` remains the ONLY production checked-insert caller.
- D: nullable additive `session_meta.method` migration preserves existing UA/IP; legacy/missing metadata reads as password.
  C's completion records all four methods; the optional strict wire field and zh/en row are tested against fake/SQLite,
  migration, schema and UI. Separate revoke-in-flight state disables all actions and prevents repeated POSTs.
- D: real route/bus integration kills active proxy HTTP and WebSocket connections, HTML caps, SSE and cookie identity,
  while preserving the other device (`lan-sessions-consumers.test.ts`).
- G: `App.vue` imports `login-2fa.css` beside `login.css`; honest transport unions replace the temporary login `any`.
  LoginView is cap/password-gated, preserves a parallel Feishu poll across method switches, and cancels on abandonment.
  A password-only static index cap marker bootstraps fresh unauthenticated pages (they have no SSE caps yet); absent/off
  and token-mode HTML stay byte-identical, including gzip behaviour.
