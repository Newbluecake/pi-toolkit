# FA — web-hub composition of the Feishu bot

Implemented against `plan.md` v2, review dispositions, §R2 and the later main-session rulings, consuming committed F8 (`f6d528d`) and F9. No commit, stash, checkout or reset was performed. F8 factory files and the existing passive `src/feishu-notify` plugin are unchanged.

## Changed files (absolute paths)

Production / shared assembly (every touched frozen file is listed):

- `/home/bluecake/ai/pi-toolkit/src/index.ts` — **approved expansion**: one `feishuBot: settings.feishuBot` assembly argument only; invariant I7 preserved.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/index.ts` — optional top-level `WebHubDeps.feishuBot`; `buildHubConfig` copies only public policy leaves, strips `enabled`, omits the complete key when disabled or control is off.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/connection.ts` — **F9 hand-off transport seam**: typed `fsb_req` overload, `fsb_res` pending-rid correlation, 12-second transport deadline for FSB operations (legacy LAN/admin requests retain 3 seconds).
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/ports.ts` — `HubConfig.feishuBot`, root-owned `FrontendDeps.cmdLimit`, optional `HubEvent.fleet.omitted` (internal bus only).
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/main.ts` — normalize with F0's strict normalizer; malformed values drop the complete key with a static, secret-free stderr warning.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts` — construct/start F8, shared HTTP/bot limiter, ports/adapters, conditional shared cap fold, bot idle component, first/bounded shutdown on runtime, supersede and startup rollback paths, bot-aware crash hard-exit budget.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/http.ts` — consume injected root-owned limiter; preserve the standalone frontend fallback for existing callers without a hub composition root.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/idle.ts` — optional bot count; absent count preserves legacy idle behavior.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/agent-server.ts` — trusted local `fsb_req` handler before registry/bus dispatch; response over the same connection. Caps still consume the one shared `extraHubCaps` fold.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/registry.ts` — **approved expansion**: preserve fleet omission evidence on the internal bus and expose a pure `isConnected` query (claiming/stale cards are not live sockets). No wire changes.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/admin.ts` — **approved expansion, R2-j**: reject creation of colon-containing usernames, with a clear refusal; existing legacy users may still rotate their password. No automatic rename/delete.

Tests:

- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub-feishu.test.ts` — new, 19 assembly cases using real hub/registry/command-router/service/stores plus the existing fake Feishu HTTP and WebSocket fixtures.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/wiring-feishu.test.ts` — new, settings/config gate and byte-equal off-config tests.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/connection-admin.test.ts` — real connection implementation's FSB correlation, capability refusal, stop-sized deadline and connection-loss tests.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/http/auth-identity.test.ts` — direct user-id principal isolation proof, including a user literally named `feishu:1:ou_x`.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/admin.test.ts` — new-user colon refusal and legacy-user password rotation.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/caps-coexist.test.ts` — eight avatar/privacy/proxy combinations, bot off/on; both cap surfaces identical, with only the conditional `fsb.v1` delta.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/deadline-nesting.test.ts` — shared F8 stop budget and FA margin nesting.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/idle.test.ts` — real idle monitor with bot-only keepalive and reset-to-idle transition.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/feishu.test.ts` — replace F0's intentionally temporary “not wired until FA” assertion with the conditional shared-fold assertion.

Report:

- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/FA-report.md`

## Wiring decisions

### Gate and caps

`feishuBot.enabled && webHub.enabled && webHub.control !== false` is the agent config gate. The bot's top-level settings do not get moved under `webHub`. The config carries neither credentials nor `enabled`. Hub entry normalizes all policy leaves with `normalizeFeishuBotHubConfig`; invalid input drops the whole key.

The composition root builds **nothing bot-specific** without `config.feishuBot`: no bot service, dialog-slot subscription, bot network/disk, bot idle-count property or `fsb.v1`. The one conditional `extraHubCaps` tail reaches both `HubInfo.caps` and `hello_ack.caps`. There is no HTTP/LAN bot-admin route. `fsb_req` is intercepted only on the trusted same-uid local agent socket and never enters registry events, browser SSE or ordinary frame logs.

### One admission limiter

The real hub unconditionally hoists one `CmdLimit` and passes the **same object** to HTTP and `createFeishuBotService`. HTTP and Feishu therefore consume the same `agent:<agentKey>` bucket. Identity equality and a bucket-exhaustion/Feishu-refusal test pin this.

Compatibility detail: `FrontendDeps.cmdLimit` is optional and `createHttpFrontend` retains `deps.cmdLimit ?? createCmdLimit(now)` for existing standalone frontend callers (46 existing test/consumer files construct the frontend independently). Every real `startHub` assembly injects the hoisted instance, including feature-off hubs. The unrelated spawn-route limiter and preview limiter retain their existing isolated buckets.

### F8 ports

- **Commands**: the real existing command router, not another dispatch path.
- **Sessions**: explicit `sessionId`, current socket liveness via `registry.isConnected` (not `AgentCard.state`, which also represents a disconnected reclaim window), current control/busy/waiting mode and actual supervisor session records. No cwd-to-session guessing or getter-side network I/O.
- **Events**: supported registry events pass through synchronously without sequence filtering. `agent_up.agent.agentKey` is normalized. The registry's version/hello callback additionally signals every reconnect, including unchanged epoch/caps reclaims, so that a silent reclaim can never preserve an attribution proof window.
- **Dialogs**: retain only slots actually received for the current connection generation. A missing slot is absent, never fabricated as an authoritative empty list. Reclaim clears the generation's slot even though the registry deliberately retains its old card for browser compatibility.
- **Uploads**: pass the shared `UploadStore`, with F8 owning its existing frozen-principal/pinning logic.
- **Preview**: pass the canonical-deny-context, fd-verifying `FsAdmitter`. When browser preview is on, it and the bot share the same admitter and zombie-IO tracker. When browser preview is off, the enabled bot still builds the safety-chain factory product, not a raw-fs fallback; no preview cap/route is enabled by that.
- **Spawn**: existing dirs/supervisor/first-prompt/prefs, actual restore gate and relaunch method, latest lookup with positive `isTerminalSpawnState` classification. No bot spawn port when spawn is off. Platform probe refusal remains fail-closed.
- **Completion evidence**: track real status/fleet receive times and the bash sample timestamp; preserve fleet `omitted`, require present/unomitted bash rows and full population counts. Reconnect/gap/stale/down clear evidence. Missing, old or incomplete evidence suppresses, never defers, native completion notices.
- **Link**: local authenticated hub detail URL, without token/query credentials. Before HTTP listen binds, return an empty value so F8 uses its honest “web 会话页面” fallback, never a port-0 URL. This is a loopback link, not a promise of remote phone/LAN reachability.

### Lifecycle and zero-hang

`FEISHU_STOP_RESERVE_MS = sum(FEISHU_SHUTDOWN_BUDGET_MS) + 500 = 6500`.

The first cleanup call is synchronously `bot.stop()`. `bot.dispose()` follows immediately/concurrently so its setup cancellation does **not** add a separate two-second tail after the shared six-second stop. Both are covered by one bounded, idempotent root cleanup promise. No supervisor, upload, registry, preview or frontend teardown begins before that promise settles or its reservation expires.

This applies to normal stop, signal, restart, idle exit, fence, supersede (including **before** forced command-router drain), startup failure and process crash. The existing runtime close deadline stays 10 seconds without the key; enabled hubs add the 6.5-second reservation. The process crash hard exit similarly stays 3 seconds without the cap, or 9.5 seconds with it; its inner deadline is 0.5 seconds shorter. Tests invoke the actual installed crash handler and advance the actual timers, rather than merely checking constants. A deliberately never-settling public stop promise delays subsequent teardown for at most the reserved 6.5 seconds.

`keepalive()` contributes `bot:1` with zero agents, including auth failure and unsafe-credential degradation; reset removes the count. Explicit stop is not idle-gated. The F8/F3 physical-native-WebSocket bounded-abandon limitation is unchanged: logical non-ACKing cleanup is bounded, not a claim that every native socket confirms physical close.

## R2-j ruling and scope clarifications

The initial implementation correctly identified `auth-identity.ts`'s numeric LAN session principal `u${userId}`, but its original report **overstated what that proves**: command-router idempotency independently uses `lan:${origin.user}`. The numeric identity regression remains useful for upload/session identity, not a proof about the command ledger. The verifier follow-up below corrects that separate collision structurally.

The main session's no-escaping/no-warning/no-DB-migration ruling remains in force. `auth-identity.ts` is unchanged and existing users are not re-keyed, renamed or deleted. New colon-username creation is refused; existing legacy users can still rotate passwords.
The other approved expansions are the one-line `src/index.ts` argument and the internal registry evidence/liveness seams. `agent/connection.ts` is the transport change explicitly required by F9's hand-off.

## Real verification output

Node v22.22.1. No real Feishu tenant traffic was used or claimed. HTTP/WS tenant effects in the new assembly tests use `tests/fixtures/feishu/{fake-http,fake-ws-server}.ts`; the actual hub socket, command router, F8 service and durable stores are real.

First prescribed hub/http/agent subset:

```text
$ timeout 180 npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/agent
Test Files  293 passed (293)
     Tests  5823 passed (5823)
  Duration  67.99s
```

Full verification (the web-hub output below is the final rerun after adding the startup-link fallback regression):

```text
$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 280 npm run build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 900 npx vitest run tests/web-hub
Test Files  523 passed (523)
     Tests  11773 passed | 3 skipped (11776)
  Duration  78.25s
WEBHUB_EXIT=0
```

The successful full run includes expected existing Vue lazy-loader error-path warnings, happy-dom connection-refusal diagnostics and SQLite experimental warnings; no failed suite or unhandled-error summary was reported. The subset run preceded the last few added assembly/admin cases; the full run includes them all.

```text
$ timeout 80 xargs -d '\n' npx prettier --check < <FA changed-file list, including this report>
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

The exact 20 code/test paths are the changed files listed above; the report is the 21st formatted path. Only those paths were passed to Prettier, never the unrelated uncommitted design files.

## Remaining gates

- F10's real-hub/fake-managed-pi end-to-end package and real-tenant/device acceptance remain separate work; no claim of live QR/card/phone acceptance here.
- Tenant V7 redelivery uncertainty and F8/F3's documented native-WebSocket physical-close residual are unchanged.
- No known FA blocker from self-verification. Independent verifier review is still required by the main-session workflow.

Uncommitted `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/{capture-pairing-plan,other-protocols-plan}.md` and `/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts` were not touched.

## Follow-ups after r_5V38H7WY

Independent verifier result before these changes: **conditional pass, zero blockers**; its full-repository run reported
**21,165 passed**. That is the verifier's result for the preceding revision, not a claim that FA re-ran the whole repository.

### Follow-up changed files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/commands.ts` — approved shared/frozen expansion: trusted hub-only Feishu origin factory and a disjoint top-level command-ledger principal.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/admission.ts` — approved F6 expansion: create that origin at the live admission point for both idempotency peek and dispatch.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/hub.ts` — synchronous stop/dispose exception guards, settle both independent cleanup tasks under the same reservation.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/agent-server.ts` — explicit `E_FSB_STATE` response for a disabled/unavailable bot.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/commands.test.ts` — actual router isolation/retry tests and source-boundary pin.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/hub-feishu.test.ts` — actual lifecycle-entry tests, throwing-stop regressions and disabled-admin refusal.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/plan.md` — correct §4.1's old attribution/username-grammar claim and append the superseding R2-k ruling.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/FA-report.md` — this correction and verification record.

### Dispositions

1. **Hub command-ledger identity**: `createFeishuCommandOrigin(gen, openId, reqId)` attaches a module-private, non-enumerable Symbol brand to the trusted origin. `principalOf` chooses `fsb:<gen>:<openId>` for that brand; unbranded LAN origins still use the unchanged `lan:<origin.user>` rule. Thus a legacy LAN user literally named `feishu:ou_x` and the bot sender `ou_x` have separate entries, even with the same agent and command id. Tests use different payloads, actual forwarding/results and independent cached retries, not merely string comparisons. JSON-cloned origins and chosen LAN strings cannot select the bot namespace. Ordinary serialized attribution remains unchanged, so no protocol/audit/agent wire schema widening is necessary.
2. **Pre-serialization proof / accepted agent-id threat class**: the source-boundary test pins exactly two `principalOf` callers (hub `request` and `peekIdempotent`) and their pre-forward key construction. Agent `commands.ts` invokes `ledger.begin(frame.id, ...)`; `agent/ledger.ts` indexes `entries.get(id)`; neither that ledger nor `agent/index.ts` derives a key from `origin.user`/`origin.listener`. The hub brand is intentionally not needed after JSON serialization. **The agent's process-global ledger is still keyed by cmdId alone**, not by the hub principal. The main session explicitly ruled that structural cmdId disjointness is not required: accidental collisions between hashed bot ids and random browser ids are negligible; an authenticated LAN caller deliberately reusing a bot id is a trusted user acting against their own bot (accepted T1/U1 threat class). Therefore F6/F8 command-id generators, agent commands/ledger/index and wire schemas are unchanged. The independent hub-key tests do not claim to isolate deliberately reused ids in the agent ledger.
3. **Throwing cleanup**: `bot.stop()` is still the first cleanup call, but a synchronous throw cannot escape `stopBot`, skip `dispose`, or skip later frontend/store/singleton cleanup. `dispose` is independently guarded too. `Promise.allSettled` keeps a rejection from fail-fast bypassing the other task's drain; the pair still has the same 6.5-second bound. Both normal close and startup-failure tests throw synchronously and assert actual disposal before HTTP cleanup.
4. **Actual lifecycle entrances**: tests now trigger the real idle monitor callback, replace the actual socket path to trigger the fence, send an actual local `hub_ctl` restart request, and drive a newer agent hello plus the real forced-supersede controller. The forced path holds bot stop pending and proves `commandRouter.drain()` is not called until it settles, before subsequent HTTP cleanup. These supplement the prior direct `close(reason)` matrix.
5. **Disabled bot admin**: a valid local `fsb_req` receives an immediate `fsb_res{ok:false,code:"E_FSB_STATE"}` when config/handler is absent. It still adds no cap, service, bot disk/network or bus event. The off regression now asserts the explicit reply rather than the former silent drop.

### Follow-up self-verification (real output)

```text
$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 80 npx vitest run tests/web-hub/hub/commands.test.ts tests/web-hub/hub/hub-feishu.test.ts tests/web-hub/hub/feishu/admission.test.ts tests/web-hub/agent/connection-admin.test.ts
Test Files  4 passed (4)
     Tests  94 passed (94)
  Duration  5.71s
TARGET_EXIT=0

$ timeout 280 npm run build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 900 npx vitest run tests/web-hub
Test Files  523 passed (523)
     Tests  11782 passed | 3 skipped (11785)
  Duration  78.30s
WEBHUB_EXIT=0

$ timeout 80 xargs -d '\n' npx prettier --check < <25 FA + follow-up paths>
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

The full run includes all nine newly added follow-up regressions (three router/boundary cases and six lifecycle cases), plus the updated disabled-feature expectation. The 25 assembly cases use real hub services and existing Feishu fakes. Formatting/whitespace checks cover the original FA file list plus these approved follow-up files; no unrelated uncommitted file is formatted. No commit was made. All requested follow-ups are implemented; no known self-verification blocker remains. F10 and real-device/tenant gates remain separate.
