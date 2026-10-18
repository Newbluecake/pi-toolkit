# F10 — final integration gate and user/tenant documentation

Implemented the F10 file domain against `plan.md` v2 + review dispositions + §R2 and the final rulings, consuming committed F0–F9/FA (`b0b6e58`). **No production code, dependency, commit, stash, checkout or reset.** Other agents' cache/keepalive/quota files were not touched. This report describes local tests, not a claim of real-tenant acceptance.

## Changed files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/tests/integration/web-hub-feishu-bot.test.ts` — new, eight real-child-assembly integration tests, covering FB1–FB10 plus help/unknown/cur/unbind.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/acceptance.md` — new, real-tenant checklist with expected results, failure observation points, V12, group topics, notifications, files, lifecycle, optional menus and an execution-record template.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/README.md` — new, setup/user/admin commands, all ten settings/defaults, limits, security/recovery residuals, status reasons and optional “send text” custom menu.
- `/home/bluecake/ai/pi-toolkit/AGENTS.md` — one Feishu bot paragraph under web-hub; no other section rewritten.
- `/home/bluecake/ai/pi-toolkit/README.md` — settings rows, top-level enable example, guide links and the explicit milliseconds exception.
- `/home/bluecake/ai/pi-toolkit/README.en.md` — matching English settings rows/example/links/time-unit correction.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F10-report.md` — this coverage and verification record.

## Test architecture and boundaries

Each rig forks **a real Node child** using the already installed `tsx` dev tool. That child imports the actual `startHub` and `createHttpFrontend`: real singleton claim/socket, registry, command router/limiter, service, durable credentials/state/outbox, shared UploadStore, preview admission chain, HTTP auth/SSE and (FB9) spawn supervisor/reaper.

Only external peers are fake:

- F2 `tests/fixtures/feishu/fake-http.ts` supplies the existing fetch seam. It does not open an external connection; production destination admission still runs against the allowed Feishu origin.
- F3 `tests/fixtures/feishu/fake-ws-server.ts` opens its minimal RFC6455 server on **127.0.0.1:0**; the bot uses a **real native WebSocket** to it through the existing socket-constructor seam. Frames, receive/ACK, close/drop and redelivery cross an actual socket. The first-retry nonce is zero only in the fake bootstrap response, to keep the scenario bounded; the connector and its real timers are unchanged.
- The parent acts as a fake pi agent over the real Unix socket, sends hello/session/ctl/ev/dialogs and returns actual command results. It does not call bot handlers directly or stub a service/router.
- FB9 launches a **real child** copied from `tests/integration/fixtures/fake-rpc-pi.mjs`, using a private fixture launcher package. `/new` goes through F5, actual directory admission, supervisor process identity and registration. The test checks the recorded process argv and exactly one fork.

The child source is embedded in the one F10 test file, so there is no new production env/config test backdoor or unowned fixture file. Each child has isolated HOME, PI_CODING_AGENT_DIR, state and cwd; XDG_RUNTIME_DIR is cleared. All waits have inner deadlines plus Vitest test/hook limits, new timers are unref'd, cleanup stops the real hub (or SIGKILLs and awaits a failed-start child), closes agents and removes only that rig's temporary directories. The crash test uses SIGKILL only for its own **non-spawning** hub. No Feishu/model/network tenant traffic or real credentials are used.

**Not tested by this harness:** the child calls `startHub` rather than `main.ts` because the latter deliberately exposes no fake transport seam. Normalization uses the real normalizer, but this is not an additional subprocess proof of `main.ts`'s invalid-config handling or pi's bundled-jiti launcher path. FA/protocol/config tests retain those responsibilities. Similarly, the fake agent proves the hub dialog route, not the actual TUI/Vue/Feishu UI winning a simultaneous race.

## FB → executable coverage map

| Plan scenario     | Integration test / assertions                                                                                                                                                                                                                                                                 | Remaining tenant/device proof                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FB1 DM round trip | `FB1/FB2: /list → numeric /use → labelled token round trip and Typing cleanup`: real cmd with token header, consumed + exact user anchor + contiguous ev + settle, exactly one labelled result, Typing POST body and DELETE, durable `replied`.                                               | Actual Typing animation/removal, botInfo identity, real client card rendering.                                                                                                                                                                  |
| FB2 list/use      | Same test binds the numeric result of `/list`, checks session label. Help/cur/unbind test also proves explicit binding removal and zero agent commands for help/unknown.                                                                                                                      | Multiple-client list presentation, ambiguous selection UX, expiry; core matrix remains in F6.                                                                                                                                                   |
| FB3 topics        | `FB3: two group topics bind different agents; replies stay in their own topic`: separate real agent sockets, unique commands/results, exact source reply URL + `reply_in_thread:true`, one command per target.                                                                                | Real group @/mentions, root-topic creation/UI and explicit subsequent binding, real thread target-gone codes. Root topics never inherit a p2p binding (F8 ruling).                                                                              |
| FB4 ask race      | `FB4: card answer/replay and web/TUI closed-race loser use the real dialog command route`: persisted nonce → callback → exact `dialog_answer`, duplicate ignored; authoritative competing web closure closes another card and its late callback sends no second command.                      | Real schema-2.0 single/multi-question forms, real TUI/web/Feishu near-simultaneous race and callback presentation.                                                                                                                              |
| FB5 inbound image | `FB5/FB6: inbound image bytes reach shared uploads; attributed cwd image auto-sends, file button re-admits`: fake resource crosses F2 download/staging/real UploadStore, prompt attachment parses, generated path is under private uploads and file bytes equal the fixture PNG.              | Tenant resource/download permission, real photo/file/media variants, filename UX and large/failed uploads.                                                                                                                                      |
| FB6 outbound      | Same test observes real safety-chain cwd PNG auto-send, independent text-file action nonce/button, callback, multipart upload byte sizes and delivered image/file message kinds.                                                                                                              | Actual upload/download/rendering, group no-auto UX, `buttons/off`, `/file`, tenant size/permission/target-gone failures. F8 unit/security matrices cover detailed R-16 restrictions.                                                            |
| FB7 recovery      | `FB7/FB8: real WS drop redelivery dedups; restart never redispatches accepted work or snapshot-backfills`: accepted persisted work, real hub **SIGKILL**, new child on same HOME/state, unattributed notice, no ordinary cmd, no result-body snapshot backfill; request stays `unattributed`. | Live restart timing, user-visible resend decision, already-proved final outbox recovery/partial-send platform effects (F7/F8 crash matrices remain separate). **Old “proof-backed snapshot backfill” wording is superseded by §R2-b.**          |
| FB8 reconnect     | Same test drops actual WS socket, waits for a new live connection, redelivers the same event/message on it and after hub restart; ACKs continue, one original dispatch/request, no second dispatch.                                                                                           | Actual tenant redelivery timing/horizon. V7 proved about 19.7s in a 300s observation, not its upper bound; two live connections split events, so do not reproduce with a second production hub.                                                 |
| FB9 new/bind      | `FB9: /new known directory forks real fake-pi, binds live session once; duplicate never forks twice`: actual process spawn, live `sess-fake-*` binding, duplicate ACK, exactly one argv log row and working `/cur`.                                                                           | Real pi/model startup, optional first-prompt UX and roots realpath confirm. F8 tests pin first-prompt wait/bind/admission and no boot auto-send.                                                                                                |
| FB10 off          | `off: same legacy caps/HTTP, no bot files or traffic, unavailable admin is explicit`: frozen legacy cap **serialized bytes/order**, matching hello/SSE caps, normal cookie login/SSE session list, zero fake calls/WS peers/bot files, no bot SSE field, explicit `E_FSB_STATE`.              | Settings → activate → `/reload`/restart UX and broader existing feature behavior; FA settings tests pin byte-equal feature-off config construction. This does not compare nondeterministic pid/port/timestamp bytes across different processes. |

Additional command coverage: `/help` while unbound, unknown first-line slash command not forwarded, `/cur`, `/unbind`. Native done/failed/waiting notifications, approval allow/deny, custom menu, QR flow and V12 are documented as real-tenant checklist items; existing factory/admin/unit gates cover their offline details rather than claiming this file simulates every UI.

## Documentation decisions retained

- `feishuBot` is a **top-level** off-by-default block, gated by Web Hub + control; all keys are non-live. Credentials are managed by local-TUI QR registration, not pasted into settings.
- `debounceMs` is the intentional millisecond/JSON-only exception; root README blanket “all time keys are seconds” text was corrected narrowly. `staleMessageS` is seconds. maxInboundMiB parses up to 100 but effective files/UploadStore ceiling stays 30 MiB.
- One app ↔ one hub; V12 unknown means “actual tenant visibility”, not a promise that allow makes the personal app discoverable.
- Group root creates an **unbound** topic; explicit `/use` or `/new` establishes the session. No inheritance from p2p or sole writable session.
- Native done notifications need positive fresh complete fleet AND bash evidence; missing evidence suppresses, never defers. Failed/waiting are separate. Passive feishuNotify co-existence is called out.
- Receive-before-ACK is durable, but no infinite exactly-once claim; restart/reconnect/gap breaks reply attribution, no automatic redispatch/snapshot backfill. Already-proven durable final outbox delivery is distinguished from backfill.
- Owner/allow-list users have local pi control capability. Group disclosure, explicit cwd-external file sends/preview blacklist residual, cmdId-only agent ledger accepted threat class, private credentials, native-WS allocation/physical zombie residual and unprobed outbound uuid window are documented.
- Optional custom menus must send **text** such as `/list`, not assume arbitrary custom events are recognized.

## Self-verification — actual output

Node v22.22.1. The final integration implementation passed **three consecutive runs**:

```text
$ timeout 180 npx vitest run tests/integration/web-hub-feishu-bot.test.ts
# run 1
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  16.81s
# run 2: same command
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  16.42s
# run 3: same command
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  15.90s

$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 280 npm run build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 900 npx vitest run tests/web-hub tests/integration/web-hub-feishu-bot.test.ts
Test Files  524 passed (524)
     Tests  11791 passed | 3 skipped (11794)
  Duration  92.45s
WEBHUB_EXIT=0
```

The broad run includes expected existing Vue lazy-loader rejection warnings, missing-prop/error-path diagnostics and SQLite experimental warnings; no failed suite or unhandled-error summary. No full-repository test or real-tenant acceptance is claimed.

An initial typecheck during parallel cache work failed on temporarily missing capture exports/fields in `src/cache-ttl/child.ts` and `src/service/cache-keepalive.ts`. Those files were left untouched; the later prescribed command above passed after the other agent's changes landed in the working tree.

Whole-repository formatting was attempted (read-only) and has a **separate unrelated-work blocker**:

```text
$ timeout 180 npm run format:check
> prettier --check .
[warn] src/adapters/pi-compat.ts
[warn] tests/cache-ttl/cache-ttl.test.ts
[warn] tests/cache-ttl/fake-pipeline.ts
[warn] tests/cache-ttl/keepalive-lifecycle.test.ts
[warn] tests/cache-ttl/keepalive-state.test.ts
[warn] tests/cache-ttl/request-capture.test.ts
[warn] Code style issues found in 6 files. Run Prettier with --write to fix.
FORMAT_ALL_EXIT=1
```

The preceding 80s attempt timed out while the broad suite/typecheck were also running; the serial 180s attempt completed with the six warnings above. No unrelated file was formatted to silence them. Targeted formatting and whitespace checks for **all seven F10 files**, including this report, are recorded below after the final report write.

## Remaining gates

1. User executes `acceptance.md` on a real tenant/device; especially V12, QR, multi-question cards/forms, real race, permissions, menus, group @/topic UI, native notification evidence and live resource/WS behaviors.
2. Other agents resolve the six unrelated whole-repository Prettier warnings; targeted F10 formatting is independent of those warnings.
3. Independent verifier review by the dispatching session remains required. No known F10 functional blocker from self-verification.

### Final F10 formatting / whitespace gates

```text
$ timeout 80 npx prettier --check tests/integration/web-hub-feishu-bot.test.ts docs/dev/feishu-bot/acceptance.md docs/dev/feishu-bot/README.md docs/dev/feishu-bot/F10-report.md AGENTS.md README.md README.en.md
Checking formatting...
All matched files use Prettier code style!
F10_PRETTIER_EXIT=0

$ git diff --check -- <the same seven exact F10 paths>
F10_DIFF_CHECK_EXIT=0
```

Only the listed F10 paths were written/formatted. No commit was made.
