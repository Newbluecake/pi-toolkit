# LAN security — integration follow-ups for I (collected from package verifications)

Merge order A → B → C → D → E → F → G (plan §9). Branches: A `pi-agent-r_Q1CWPAMX`, B `pi-agent-r_J43KMS6B`,
C `pi-agent-r_QYKR6FC4` (+ rework commit), E `pi-agent-r_X730BNFY`, F `pi-agent-r_48FM5XTE`; D/G pending.
Each package's own wiring request: `docs/dev/web-hub/lan-security-wiring-<PKG>.md` (on its branch).

## From A (verified pass)

- **Closed (LAN-I/A):** `ProxyServiceDeps.clientAllow` is required (undefined only without LAN); one shared guard reaches BOTH listener kinds (I1); added
  `tests/web-hub/http/lan-allowlist.test.ts` (no bytes/no lease; one keepalive allowed→denied→missing XFF). Listener tags use `forListener()` / `tagClientAllowGuard()`.

## From B (verified conditional pass)

- Update the stale P0 assertion `tests/web-hub/hub/lan-security-surfaces.test.ts:92-96` (repairLan2fa no longer throws).
- Fake store parity: `tests/web-hub/contract/fakes.ts` `commitTotp` must return `recoveryCodes: []` when a set exists (addendum #4).
- Optional hardening: repair when the DB file is missing; self-eviction edge in the 32-session trim.

## From C (conditional pass, rework in progress)

- Schema-validate `body.method` before calling the core; `after()` only on response finish.

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
