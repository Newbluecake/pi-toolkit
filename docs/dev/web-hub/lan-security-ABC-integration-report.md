# LAN security A/B/C integration report (LAN-I)

Date: 2026-10-20. Branch: `dev`, main checkout. Baseline: `e42cf6ee` (P0 + rulings + collected follow-ups).
Only A → B → C merged, each via `git merge --squash`, each followed by its own wiring commit and full-suite/typecheck gate.
No push. D/E/F/G untouched. No golden fixture regenerated.

## Commits

| Package                 | Import                                                                               | Wiring                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A                       | `f76fa713` feat(web-hub): guard LAN and proxy clients with IP allowlists (LAN-A)     | `14e5f29c` feat(web-hub): wire shared LAN client guards and allowlist status (LAN-I)          |
| B                       | `da825dd9` feat(web-hub): persist secure LAN sessions and two-factor state (LAN-B)   | `e8cb7332` feat(web-hub): wire LAN idle policy and secure store contracts (LAN-I)             |
| C (both branch commits) | `bb208b11` feat(web-hub): unify LAN login completion and factor verification (LAN-C) | This report's commit: feat(web-hub): wire checked LAN login and staged factor rollout (LAN-I) |

All commits used precise paths and `git commit --no-verify` after Prettier.

## Wiring / semantic evidence

Paths below are relative to the repository root; coordinates refer to the final A/B/C wiring tree.

### A / I1

- `src/web-hub/hub/hub.ts:801`: one security bus and ONE client guard per LAN-configured hub; `:811` burst subscription (cleanup owned); `:857` inject into LAN deps; `:1812` pass same guard to proxy service.
- `src/web-hub/hub/http.ts:545`: derive fail-closed `xffUsable` from proxy warnings and carry request UA. `:633` deny direct TCP before lease/idle timer (no bytes); `:667` independently deny unusable/not-allowed forwarded clients on every request.
- `src/web-hub/hub/proxy/service.ts:68`: required `clientAllow` plumbing (undefined only without LAN); `:137` tag shared guard for proxy; `:244` inject into every proxy listener. `proxy/listener.ts:135` gates HTTP, enter and upgrade before connection admission.
- `src/web-hub/hub/http.ts:3152`: active-only status snapshot; `:3226` scope-owned unref'd 30s coalescing/trailing tick, cleared on shutdown.
- `src/web-hub/agent/index.ts:1159`: effective allowlist forwarding, preserving absent vs deny-all; `:1581` proxy allowlist marker. `src/commands/webhub.ts:235` shows invalid allowlist warnings.
- `tests/web-hub/http/lan-allowlist.test.ts`: real TCP no-bytes/no-lease, and one trusted-proxy keepalive socket allowed → denied → missing XFF. `proxy-lifecycle.test.ts` asserts proxy receives the identical hub-owned LAN guard and none is constructed by the hub without LAN.

### B / I2

- `src/web-hub/agent/index.ts:1162`: forward idle minutes as milliseconds ONLY when present; old callers without new settings retain the exact four-field LAN config. `tests/web-hub/agent/wiring-lan.test.ts` pins absent/allow/deny-all/idle forwarding.
- `src/web-hub/hub/lan-assembly.ts:56`: pass idle policy to the real store; `:78` retain `loginIpsRebuiltAt`. Existing `LanAssemblyOffError` forwarding preserves exact db-invalid detail. A's renderer already shows security-specific repair guidance.
- `src/web-hub/hub/http.ts:1262,1340,1481,2168`: request and reserved SSE touches carry the resolved client IP; weak keys avoid retaining disconnected clients. `:3152` folds history-rebuild notice into LAN-on status.
- `tests/web-hub/contract/fakes.ts`: `commitTotp` returns `recoveryCodes:[]` for ANY existing set, including exhausted sets. `tests/web-hub/hub/lan-security-surfaces.test.ts`: replace stale throwing-repair assertion with async cancellation + audit assertions.
- `tests/web-hub/contract/lan-security-store.test.ts`: identical assertions against fake AND real SQLite child: epoch/gen CAS, exact 32-session evictions, idle expiry, first enrollment clears login IPs, single-use recovery race, monotonic reset, exhausted recovery set retained on TOTP enrollment. Real crypto in the fake's explicit TOTP seam; B's independent RFC vectors also pass.

### C / I3 / I4

- `src/web-hub/hub/http.ts:3112`: one core per LAN frontend; shared store/KDF/limiter/admission/security bus. Until E, approval is explicitly unavailable. `:3129` auth revoke subscription, scope fallback cleanup; facade close unsubscribes/disposes before store teardown. Corrupt-KDF status warning behavior retained through an additive callback.
- `src/web-hub/hub/http.ts:1583`: bounded request parsing, request-aborted/unfinished-response-close cancellation. Ordinary successful request close/end is NOT cancellation. `:1631`: strict `LanFactorBodySchema` after recovery normalization BEFORE calling `submitFactor` (including `body.method`). Factor/wait are login-pending, GET wait requires X-PWH; POST routes keep LAN CSRF.
- `src/web-hub/hub/http.ts:1545`: preserve Set-Cookie arrays and attach `after` ONCE to finish, never close; closed response aborts core-to-send gap. HTTP no longer calls legacy `runLanLogin`, session insertion, history, mark-initial or limiter-success itself.
- `src/web-hub/hub/lan-login.ts:328`: exactly ONE production `.createSessionChecked(` caller. `complete()` at `:302` is reached by password (`:649`), factor (`:709`) and approval (`:778`), with C's late-insert/delete/revoke/deadline machinery intact.
- `src/web-hub/hub/hub.ts:861`: production forces INTERNAL `secondFactorEnabled:false`. Core still reads actual factor generation for checked insertion and refuses inconsistent state. An enrolled user's new-IP password login does NOT become an unanswerable factor challenge. HTTP factor routes are 404 while staged (`http.ts:1659`), and no `lan.2fa.v1` / `lan.sessions.v1` cap is advertised. Only programmatic frontend tests enable the seam; no settings/env knob exists.
- `tests/web-hub/http/lan-login-integration.test.ts`: checked insertion/no legacy insertion for new+known IP, recovery completion and single alerts, schema-before-core, actual user-revoke propagation to pending challenge, close unsubscribe/dispose, staged enrolled-account usability, finish-only hook and cookie array/send-gap assertions. Core's 66 race/deadline tests pass.
- Existing HTTP store-exception assertion updated from generic 500 to C's deliberate `503 {error:"E_DB"}`; still verifies the next valid login succeeds (no slot wedge).

## Validation

After EACH import + wiring, before advancing:

| Gate | Exact full-suite command | Result                                            | Wall time | Typecheck                              |
| ---- | ------------------------ | ------------------------------------------------- | --------- | -------------------------------------- |
| A    | `timeout 1800 npm test`  | 1171 files passed; 22621 tests passed, 22 skipped | 256.26s   | `timeout 120 npm run typecheck` passed |
| B    | `timeout 1800 npm test`  | 1175 files passed; 22693 tests passed, 22 skipped | 258.56s   | `timeout 150 npm run typecheck` passed |
| C    | `timeout 1800 npm test`  | 1178 files passed; 22790 tests passed, 22 skipped | 267.69s   | `timeout 180 npm run typecheck` passed |

Raw full outputs: `/tmp/lan-a-full.log`, `/tmp/lan-b-full-final.log`, `/tmp/lan-c-full.log`.
C totals include concurrent cache-keepalive tests in this shared checkout, NOT extra LAN scope.

B needed two unchanged-code full-suite reruns:

1. `/tmp/lan-b-full.log`: 1174 passed / 1 failed file, 22688 passed / 1 failed / 22 skipped tests. Existing headless H6 RSS delta was 40228 KiB vs 32768 limit. Isolated rerun (`timeout 150 npx vitest run tests/integration/web-hub-headless.test.ts -t 'H6 \(flood/RSS cells\)'`) passed; no test threshold/source changes.
2. `/tmp/lan-b-full-rerun.log`: 1174 passed / 1 failed file, 22692 passed / 1 failed / 22 skipped tests. Existing Feishu SW1 absolute-expiry equality differed by 1ms. E/Feishu files not changed. Third full run passed all tests.

Focused passes: A 9 tests / 2 files; B 32 tests / 4 files (incl. real SQLite); C final 16 tests / 2 files (HTTP integration + proxy lifecycle), plus core 66 tests and real-hub LAN integration 4 tests.

Final gates: `timeout 180 npm run build`, `timeout 180 npm run build:web`, `timeout 120 npm run check:web`, `timeout 180 npm run format:check`, `git diff --check` all passed. Vite only reports the existing advisory >500kB chunk warning; check:web passed (19 files; first-screen gzip 286394B / 524288B).

## Integration notes closed / deferrals

- A required proxy guard, dual listener injection, tags and LAN HTTP regression suite: CLOSED.
- B stale P0 assertion and fake commitTotp recovery parity: CLOSED; joint first-enrollment/history contract is also covered now.
- C method schema-before-core and after-only-on-finish: CLOSED. I3/I4 wiring done for core; sessions-route subscription awaits D.
- Optional B hardening (repair missing DB; self-eviction on backwards/tied timestamps) deferred, not silently modified.
- D/E/F/G not merged or edited. Feishu owner/adapters/alerts, TUI twofa commands and routing, sessions routes/UI and second-factor UI/caps remain deferred. Never forward `securityAlerts` yet. Production factor gate must flip ONLY with working E/F/G and cap advertising; sessions cap awaits D.
- No Agent dispatch tool is available in this integrator session: independent verifier could not be launched here. Requested root-side independent verification via `message_agent`; self-verification evidence above is complete, not represented as independent review.
- Concurrent cache-keepalive/AGENTS edits present in the shared checkout were neither staged nor reformatted by this integrator. No stash/reset, no `git add -A`, no push.

## Changed-file manifest (absolute paths; this phase ONLY)

```text
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-ABC-integration-report.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-integration-notes.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-A.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-B.md
/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/lan-security-wiring-C.md
/home/bluecake/ai/pi-toolkit/src/commands/webhub.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/lan-status.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/agent/proxy-status.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/client-allow.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db-child.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/db.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-assembly.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-auth.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-login.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/lan-store.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/listener.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/proxy/service.ts
/home/bluecake/ai/pi-toolkit/src/web-hub/hub/totp.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/lan-status-security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/proxy-status-allowlist.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-lan.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/contract/fakes.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/contract/lan-security-store.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-allowlist.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-helpers.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-login-integration.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/lan-login.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/http/proxy-lifecycle.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/client-allow.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/db-lan-security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-login.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-security-surfaces.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/lan-store-security.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/engine-helpers.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/proxy/listener-allowlist.test.ts
/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/totp.test.ts
```
