# LAN security — integration follow-ups for I (collected from package verifications)

Merge order A → B → C → D → E → F → G (plan §9). Branches: A `pi-agent-r_Q1CWPAMX`, B `pi-agent-r_J43KMS6B`,
C `pi-agent-r_QYKR6FC4` (+ rework commit), E `pi-agent-r_X730BNFY`, F `pi-agent-r_48FM5XTE`; D/G pending.
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
- **Staged intentionally:** production `hub.ts` forces internal `secondFactorEnabled:false` until E/F/G + capability advertising land. An enrolled user's new-IP password login still completes (with real factor generation CAS); factor endpoints return 404. No new settings or capability activation. Tests enable the internal frontend seam only, never configuration/env.

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
