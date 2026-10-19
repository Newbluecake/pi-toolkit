# LAN security — package G (login UI) wiring request

Scope: `ui/src/logic/password-client.js` (2FA transport), `ui/src/components/shell/LoginSecondFactor.vue`
(variant-B second-factor card), `ui/src/styles/login-2fa.css` (the card's stylesheet —
unscoped, every owned class is `tfa-*`-prefixed; **I imports it in App.vue next to
`login.css`** — the component carries no `<style>` block, `tests/web-hub/ui/source-scan.test.ts`
bans them), `ui/src/i18n/{zh,en}/login.ts` (`login.2fa.*` keys). Frozen wire:
`protocol/lan-2fa.ts`. Mount only when `lan.2fa.v1` is advertised AND `authMode==="password"` (I7).

## 1. password-client (consumed via `transport/password.ts` → `PasswordTransport`)

`login()` gains one result variant; everything else is unchanged:

```ts
| { ok: false, kind: "second-factor", challenge: Lan2faChallenge } // 401 E_2FA, narrow-validated
```

New methods (already on the returned client; expose them on `PasswordTransport`):

```ts
submitSecondFactor(body: { method: "totp" | "recovery"; code: string }): Promise<
  | { ok: true; initialPassword: boolean }                       // pwh_lan set; stream already opened
  | { ok: false; error: string; attemptsLeft?: number; retryAfterMs?: number }>;
waitApproval(challenge: Lan2faChallenge): Promise<
  | { ok: true; initialPassword: boolean }                       // approved; stream already opened
  | { ok: false; state: "denied" | "expired" | "cancelled" }
  | { ok: false; state: "error"; error: string }>;               // e.g. E_2FA_BUSY
cancelSecondFactor(): Promise<{ ok: true } | { ok: false; error: string }>; // also aborts the wait loop
```

Notes for I:

- The fetch wrapper's `REST_AUTH_PATHS`/`isRestAuthEndpoint` must NOT gain `/api/login/2fa*`:
  a 401 there is a challenge answer, never a lost session. (Verified: no existing prefix rule
  covers it — `API.login === "/api/login"` is not used as a prefix.)
- `waitApproval` is idempotent per challenge OBJECT (the same `challenge` reference ⇒ the same
  in-flight loop; identity is not `expiresAt` — two distinct challenges can share an expiry).
  Start it IMMEDIATELY when `challenge.feishu === "sent"` (an approval can land while the user
  types a TOTP code), and again on the component's `wait` emit — duplicates are free, never 409.
- **Keep polling after the user switches methods.** Switching to TOTP/recovery does NOT stop the
  Feishu wait loop — the approval may still land first, and an approved wait completes the login
  exactly like a successful submit. The loop stops only on: a terminal wire state
  (`denied`/`expired`), a `submitSecondFactor` success (the client aborts the loop itself — it
  settles `{state:"cancelled"}`, which you ignore), or your own `cancelSecondFactor()`.
- **I must call `cancelSecondFactor()` whenever the second-factor flow ends without a login:**
  the component's `cancel` emit, component unmount, and every return to the password form
  (denied/expired/error restarts included). Otherwise the loop keeps polling a dead challenge
  until `expiresAt`.
- Codes are validated/normalized client-side (`TOTP_CODE_RE`, `normalizeRecoveryCode`);
  `{error:"E_BAD_REQUEST"}` is returned locally without a request.
- Success paths call `openStream()` inside the client (same as `login()`); just tear down the
  2FA UI state.

## 2. LoginView mounting (I-owned file)

Render `<LoginSecondFactor>` inside `.login-page` in place of the password `.login-card` while a
challenge is active. Props (frozen in P0) and the mapping from client outcomes:

```ts
challenge: Lan2faChallenge            // from the login() second-factor result
busy: boolean                         // submitSecondFactor in flight
attemptsLeft?: number                 // from {error:"E_2FA_CODE"}; 0 = server dead:attempts (terminal view)
lockedUntil?: number                  // now + retryAfterMs from E_2FA_METHOD_LOCKED (per-method notice)
now: number                           // 1s ticker, e.g. useTicker — drives expiry/lock/approval countdowns
```

Emits:

```ts
submit(body)  → await submitSecondFactor(body)   // map outcome per the table below
wait()        → void waitApproval(challenge)     // idempotent; safe to call on every emit
cancel()      → void cancelSecondFactor(); back to the password form
```

Outcome mapping (submitSecondFactor / waitApproval):

| Result                               | UI action                                                        |
| ------------------------------------ | ---------------------------------------------------------------- |
| `ok:true`                            | clear challenge; dashboard opens (stream already open)           |
| `error:"E_2FA_CODE"`                 | set `attemptsLeft`; component renders the error on that method   |
| `error:"E_2FA_METHOD_LOCKED"`        | `lockedUntil = Date.now() + retryAfterMs`; other methods usable  |
| `error:"E_LOCKED"` + `retryAfterMs`  | shared lockout — reuse the existing `errors.throttled` countdown |
| `error:"E_2FA_EXPIRED"/"E_2FA_USED"` | restart login (password form); component also self-shows expired |
| `error:"network"`                    | show `errors.network`; challenge likely still alive              |
| wait `state:"denied"`                | back to password form + notice `t("login.2fa.denied")`           |
| wait `state:"expired"`               | back to password form + `t("login.2fa.expired", {min:5})`        |
| wait `state:"cancelled"`             | ignore (local abort — cancel/close/submit success)               |
| wait `state:"error"`                 | back to password form + `t("login.2fa.failed")`                  |

## 3. Invariants I must preserve

- Never issue concurrent `waitApproval` loops for different challenges without an intervening
  `cancelSecondFactor()` (client aborts the previous one; the hub allows ONE waiter/challenge).
- Never poll `/api/login/2fa/wait` manually — the client loop owns pacing (30s per-poll timeout,
  timeout ⇒ retry, ≥1s between poll starts, 1s→2s→4s…≤8s backoff after consecutive transport
  errors, stops at `expiresAt`).
- The component never fetches; keep it that way — all outcomes arrive via props. A challenge
  whose methods are all unusable (e.g. `["feishu"]` with `feishu:"unavailable"`) renders an
  honest "no usable method" state whose only action is 返回登录 (`cancel`) — it never shows a
  recovery panel the challenge did not offer.
- `challenge` prop identity: pass a NEW object only for a NEW challenge (the component resets
  all local state on challenge change); after a restart prefer remounting or a fresh object.
- i18n keys live ONLY in `login.2fa.*` (errors.ts is I-owned); zh/en parity is tested.
- No v-html anywhere; codes are cleared from component state right after `submit` is emitted.

## 4. Contract issues encountered

- **`LoginResult` in `ui/src/transport/types.ts` (I-owned) has no second-factor variant.** G
  cannot edit it, so `createPasswordClient`'s returned `login` is type-erased (`any`) at the
  object literal — the honest union stays on the function's own JSDoc. When mounting, I must
  add `| { ok: false; kind: "second-factor"; challenge: Lan2faChallenge }` to `LoginResult`,
  add `submitSecondFactor`/`waitApproval`/`cancelSecondFactor` to `PasswordTransport`, and drop
  the boundary cast. Until then the UI cannot see the challenge type-safely (runtime is fine).
- Advisory: `Lan2faChallenge` carries no client-IP field, so the preview's 「来自新 IP <addr>」
  copy is rendered without the address (`login.2fa.lead`). The Feishu approval TTL (120s) is
  not on the wire either; the component counts down from `LAN_2FA_LIMITS.approvalMs` locally at
  wait-view entry — a restart mid-wait re-arms the full 120s display (cosmetic only; the
  server's expiry is authoritative via the wait reply).
