# F8 — bot service factories

Implemented the F8 factory domain of `plan.md` v2 + review dispositions + §R2 + the later main-session rulings. **No hub/http/main/agent-server/agent assembly edits, no dependency, no commit.** FA remains the sole shared-assembly owner. D2 wins over the task's generic “streaming/final” wording: collect the causally attributed stream, send **one final logical reply only at `agent_settled`**, through F7's split/outbox.

## Owned files (absolute paths)

New production factories:

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/service.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/runs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/dialogs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/files.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/notify.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/runtime.ts` — shared bounded ownership/text helpers; extra F8-owned helper, not a listener.

New tests/fixture:

- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/service.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/runs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/dialogs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/files.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/notify.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/runtime.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fixtures/feishu/f8.ts` — real private stores + F2 fetch fake + F3 socket fake + F6 envelopes; no real credentials.

Explicit, approved changes to **committed F6 files**:

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/requests.ts` — exactly two `if (disposed) return` fences, after `admission.dispatch` resolves and in its rejection continuation, plus a comment. No interface change. A late old-install router completion can no longer transition a disposed/reset successor's state. Main session explicitly approved; service regressions cover **both resolve and reject**.
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/router.ts` — later user `/help` ruling: additive `help.unknown?` / notice `unknownCommand?`, group-root/unbound help before topic admission, and the path-like first-token exception. Existing command effects/ACK/debounce architecture unchanged.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/router.test.ts` — update two unknown-command expectations and add the first-line/path/help regression matrix.

Report:

- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F8-report.md`

Unrelated untracked cache-keepalive design documents were left untouched. No stash/checkout/reset was used.

## Exact FA port surface

`service.ts` exports `createFeishuBotService(deps: FeishuBotServiceDeps): FeishuBotService`:

```ts
const bot = createFeishuBotService({
  stateDir, // hub stateDir; service appends "feishu-bot"
  config, // F0 FeishuBotHubConfig; ONLY construct when the config key exists
  limit, // SAME hoisted CmdLimit instance as HTTP
  commands, // Pick<CommandRouter, "request" | "peekIdempotent" | "inflight">
  sessions: { views, managed }, // F6 normalized rows; bindings are added by the service itself
  events: { subscribe, dialogs }, // normalized bus + optional authoritative dialog slots (below)
  uploads, // optional shared UploadStore slice
  preview, // optional existing FsAdmitter (already opens/verifies its fd)
  spawn, // optional F5/supervisor slice below
  idleEvidence, // optional positive completeness/freshness projection
  link, // optional (agentKey) => authenticated HTTP(S) detail URL, NO token/query secret
  onStatus, // optional synchronous F0 FsbInfoData sink
  log, // optional static {event,reason?,code?}; prefix at caller if desired
});
await bot.start();
await bot.stop(); // FIRST operation in EVERY hub cleanup path
await bot.dispose(); // final/idempotent; also calls stop first
bot.snapshot(); // F0 FsbInfoData, masked owner/allow-list, no secrets
bot.keepalive(); // loaded OR unsafe credentials; not merely status === open
await bot.admin(fsbReq); // => FsbResFrame; LOCAL TUI transport ONLY (R2-e)
```

`start/stop/dispose/admin/snapshot/keepalive` are the entire public service surface. FA does **not** construct stores/API/registration/F6/F7 separately. All mutable state is factory-local. Connector remains the only network listener.

### Sessions and bus projection

- `sessions.views(): readonly FeishuSessionView[]`: `{sessionId,agentKey,cwd,name?,live,mode:"tui"|"rpc",state:"busy"|"idle"|"waiting"|"read-only"}`. `live` must mean a current agent connection, not a retained offline card. Missing `cmd.v1` maps to `read-only`.
- `sessions.managed(): readonly FeishuManagedSession[]`: `{sessionId,cwd,name?}` from supervisor records. No guessing session identity from cwd.
- `events.subscribe(listener): unsubscribe`: synchronous, lossless subscription to supported hub events. Pass existing `ev`, `ctl`, `session`, `dialogs`, `gap`, `agent_down`, `agent_stale` shapes structurally. Map `agent_up{agent}` to `{type:"agent_up",agentKey:agent.agentKey}`. `spawns` can be `{type:"spawns"}`. `status`/`fleet` can be their type+agentKey (service re-reads evidence); ignore other bus variants. **Do not filter/deduplicate ev sequence numbers**: F8 uses every per-agent `seq` to detect discontinuity. A reconnect/agent-up is a proof gap, never a snapshot-backfill opportunity.
- `events.dialogs?()` returns only authoritative slots actually received: `[{agentKey,epoch,open,closed}]`. A registry record with no dialogs slot is **absent**, not `{open:[]}`. The 30-second unknown-state fallback requires this distinction.

### Upload and preview ports

- `uploads?: Pick<UploadStore,"begin"|"chunk"|"commit"|"abort"|"pinForPrompt"|"settlePins"|"flushReferences">` — pass the already initialized shared store; do not create a bot-local store. F8 uses `sessionId/agentKey` so UploadStore computes its normal `bucketFor` identity. All five operations and prompt pinning use exactly `feishu:<installGen>:<senderOpenId>`, derived from frozen request identity, **never from synthetic origin**.
- `preview?: FsAdmitter` — pass the existing preview-chain factory product with the resolved literal+canonical deny context and bounded IO tracker. Its `admit` result is already an `O_NOFOLLOW`/fstat/dev+ino/proc-fd checked regular-file handle. F8 never raw-opens an outbound candidate. Missing port means outbound files refuse, not a raw-fs fallback. F8 rechecks live binding/session/allow/gen on explicit sends and button presses, and canonicalizes cwd before auto-image eligibility.

### Spawn port

```ts
spawn?: {
  dirs: Pick<DirService, "admit">;
  supervisor: Pick<SpawnSupervisor, "start" | "records">;
  firstPrompt: Pick<FirstPromptForwarder, "accept">;
  prefs: Pick<SpawnPrefs, "get">;
  registerTimeoutS: number;
  restore?: boolean;                    // actual spawn.restore gate
  relaunch?: SpawnSupervisor["relaunch"];
  lookup(spawnId): { agentKey?, sessionId?, terminal: boolean } | undefined;
}
```

Pass the existing services/method adapters. `lookup` reads the latest supervisor record, with `terminal` positively classified by `isTerminalSpawnState`; a successful `startFresh` does not itself promise live coordinates. F8 owns one capped F5 idempotency store and the bot-specific rate bucket. Principal/owner are exactly F5's agreed `feishu:<gen>:<openId>` / synthetic LAN owner, so supervisor limits derive `lan:feishu:<gen>:<openId>`. FA must still land R2-j's LAN-username `:` exclusion.

### Completion evidence

`idleEvidence?(agentKey)` returns `{at,fleet?:{complete,terminal:boolean[]},bash?:{complete,running:number}}`. `at` is the evidence sample time, not callback time. Require BOTH projections present, positive completeness (no omitted/truncated rows), freshness ≤10 seconds, all fleet terminal, zero running bash. Anything unprovable suppresses completion notices, never defers them. Failed/waiting notices do not depend on idle evidence.

Optional test/platform seams: `clock`, `fs` (F4 filesystem), `fetch`, `webSocket`, `api`. Production normally omits these. They introduce no destination allowlist bypass.

### FA lifecycle checklist

1. Config key absent: construct **nothing**, no cap, no disk/network/timer/idle change.
2. Build after registry/shared uploads/spawn and the **hoisted** HTTP CmdLimit exist; `await bot.start()` loads safe credentials → state → adopts install → builds factories → outbox/recovery/dialog reconciliation → connector.
3. Add `bot.keepalive() ? 1 : 0` to idle counts, including `auth_failed`/degraded/unsafe credentials. Explicit stop/supersede still bypass idle.
4. In EVERY cleanup path (including startup failure): invoke `bot.stop()` **before** registry/supervisor/uploads/http teardown; then finish teardown and `bot.dispose()`.
5. Dispatch decoded `fsb_req` through `bot.admin` on the trusted local agent control connection only. Add no web/LAN admin endpoint. F9 already gates its CLI surface to TUI.
6. Advertise `fsb.v1` only with the normalized config key on both cap surfaces; F8 does not advertise it itself.

## Design/behavior decisions

### Runs / durability

- F6 remains the only admission path to `commands.request`; shared limits/live tenant+allow/gen/binding/process checks remain intact. F8's wrapper only tracks command lifetime and pins files, not another dispatch path.
- Install token header + byte-equal dispatched body + `ctl consumed` are all required. Assistant `message_end` text is collected only after that anchor, cut at another user input, emitted only at settle. `agent_end` is not an end signal. Errors/aborts render failure, wire/buffer truncation is labelled.
- Gap, reconnect, epoch change, mid-window session change, restart or missing anchor ⇒ no result content, `unattributed` notice with web link. Pre-anchor topic-switch transfer requires the exact token-bearing anchor before rebinding. Accepted TTL 24h is `expired`, never success.
- A **previously durable final outbox** is different from backfill: its proof window already completed before enqueue. Startup lets that durable final finish rather than also declaring its still-accepted request unattributed. Accepted requests with no final intent get no backfill.
- F7 `onSettled` makes `replied/reply-failed` durable before acknowledging/removing parts. Partial/`swept`/expired-uncertain groups are surfaced honestly. Stopped old-runtime settled callbacks refuse so restart can reconcile them.
- F7 overflow file upload is decided BEFORE enqueue. Upload success adds the markdown file; failure re-renders truncate mode, without duplicating part 1.
- Finals and Typing work have separate bounded pools (256/512) so a notification/file-action flood cannot silently consume the final/cleanup slots. General async ownership is capped at 256; physical slots follow actual task lifetime, not the timeout wrapper.

### Dialogs

- Durable placeholder via F7 → actual sent card coordinates → F4 bound one-shot nonces → PATCH (`update_multi:true`). Values are only `{n}`; form values never select routing authority.
- Single-question option buttons and addressed text; unaddressed text only with exactly one open dialog. Multi-question forms are card-only; ≤8 questions, option validation, single/multi-select, Other ≤4KiB, skip, allowCancel, 32 drafts/30min. Invalid answers are rejected before retaining drafts; validation errors PATCH fresh tokens. Closed race losers are honest `E_DIALOG_CLOSED`, not a failed run or automatic retry.
- F4's frozen dialog epoch field is numeric while agent epochs are strings. F8 stores a stable 32-bit epoch fingerprint there; exact authoritative epoch is retained in live state and each nonce target and rechecked before dispatch. No frozen store/protocol change. Old-epoch tokens cannot answer the new epoch.
- On reconnect, authoritative missing/closed slots reconcile cards; no list for 30s ⇒ “状态未知 — 在 web 查看”, never guessed answered/expired. A later authoritative open slot restores the card. TTL cards are patched before F4's silent expiry. Recovered queued placeholder results can attach through `dialogs.delivered`; a lost platform message id degrades honestly instead of inventing one.

### Files / notifications

- Inbound image/file/media/audio/post-resource keys use F2 capped streaming, private generated staging names, known-size UploadStore commit, one principal, sanitized names, attachment blocks, abort on partial errors, cleanup/boot sweep. Long body becomes an exact `.txt` upload, not silent truncation. Per-file ≤30s, at most four staging operations, ≤100MiB reserved staging; a separate two-slot physical-fs ledger retains hung-op slots after timeout. Inbound cap additionally clamps to 30MiB/UploadStore's cap.
- Outbound candidate cap 8, admission budget 1.5s, fd reads, sniffed image magic. Auto only p2p+attributed+canonical-cwd-subtree image ≤10MiB, at most 3; otherwise at most 5 requester-bound buttons, press-time admission repeated. Explicit `/file` shares the same safety chain; outbound off produces an explicit notice. Upload cap 30MiB. Denylist refusal reveals only “refused”.
- Owner notices cover static degradation/undecodable/auth/connection-limit/capability diagnostics, hourly per reason and under the global 20/min notice budget. Approval placeholder/nonce/PATCH uses F6's owner-only durable approval pair. Native completion uses R2-h evidence, excludes Feishu-owned runs, rate limits per session, and never substitutes missing/truncated evidence with “idle”.

### Main-session rulings adopted during F8

- **Group root**: only create an **unbound** topic and reply with `/new`/`/use` instructions. Never select a sole writable session or the sender's p2p current pointer. Bind only when the topic explicitly chooses/creates a session; `thread_id` comes from the reply response (V8).
- **`/new` first prompt timing deviation (approved)**: F5 gets no raw `firstPrompt`. Persist the spawn receipt before effect; wait for live coordinates with a 60s timeout threshold (checked every ≤30s; hard wait ≤90s), atomically bind/close the receipt/receive the first prompt, then dispatch through F6 with token+admission. Terminal/timeout launch closes the first prompt and sends a failure notice. Boot never re-forks and never auto-sends a pending stored first prompt; already-dispatching prompts get only queryOnly. The durable marker uses reserved session id `feishu:new`; generated first-prompt records are marked `new-first` to distinguish pre-dispatch boot expiry.
- **Relaunch remains F8**: offline terminal managed `/cur` offers the requester-bound button only with restore+relaunch ports. Press-time identity/binding checks precede the synchronous supervisor preflight; B-alive `exit-unconfirmed` and other refusal reasons are shown unchanged. Other offline sessions get `/new <same dir>` or `/list`.
- **Later `/help` ruling**: one short text line per command, includes group @ instruction; unknown first-line slash token replies “未知命令 /xxx” plus help and never forwards. A first token with a second `/` is path-like and stays a prompt (`/home/me/file.txt 帮我看看`); slashes inside normal sentences/later lines and leading-space text are not commands. `//text` retains F6's literal-slash escape. Help is routed through F7 render/outbox, including unbound group roots.

## Verification — real local command output

Node v22.22.1. No real tenant/network acceptance is claimed; all Feishu HTTP/WS effects in these suites use the existing fakes. The factories are not wired into a real hub until FA.

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu
Test Files  23 passed (23)
     Tests  1113 passed (1113)
  Duration  16.35s
FEISHU_TEST_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts
Test Files  24 passed (24)
     Tests  1124 passed (1124)
  Duration  16.51s
FEISHU_TEST_EXIT=0

$ timeout 280 npm run build
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

Targeted coverage: actual private fsync state/ACK/outbox flow, thread-only sends, exact token anchor and every continuity loss class, no agent_end fallback, ask callback plus replay and web/TUI race, multi-question local validation, reconnect/TTL semantics, inbound/outbound bytes and principals, R-16 symlink/cwd matrix, owner approval nonce security, persistence pause/heal, disposed success/rejection continuations, queryOnly boot, no-backfill boot, F5 creation/confirm/B-alive, registration generation replacement, help and path grammar, unref'd deadline timers and retained zombie capacity.

No full-repository test run or real Feishu acceptance was performed for this factory package. FA/F10 retain the real-hub gates, cap coexistence/idle/admin wiring, and live multi-question card/form/device acceptance. Native WebSocket's bounded-abandon residual and F7's lost in-process sent-message coordinates/uuid window remain as previously documented, not new guarantees.

### Final rerun after final-outbox recovery / work-pool hardening

```text
$ timeout 280 npm run typecheck
TYPECHECK_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu
Test Files  23 passed (23)
     Tests  1113 passed (1113)
  Duration  16.39s
FEISHU_TEST_EXIT=0

$ timeout 280 npm run build
BUILD_EXIT=0

$ timeout 60 npx prettier --check src/web-hub/hub/feishu/{service,runs,dialogs,files,notify,runtime,requests,router}.ts tests/web-hub/hub/feishu/{service,runs,dialogs,files,notify,runtime,router}.test.ts tests/fixtures/feishu/f8.ts docs/dev/feishu-bot/F8-report.md
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

The last status also showed concurrent modifications in `src/cache-ttl/`, `src/service/cache-keepalive.ts` and their cache tests. They are not F8 edits and were not reverted or included in this file ownership list.

## Follow-ups after r_NHKEWJ0Z

Verifier disposition: **conditional pass, zero blockers** (the verifier's separate full-repository run reported 21,111 passed). All six requested follow-ups are now implemented in the F8 domain. No additional F6/frozen file was changed and no commit was made.

### Changed files in this follow-up (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/runs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/service.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/dialogs.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/runs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/dialogs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/service-followups.test.ts` — new, wraps real factory products for teardown-order assertions and uses failure injection for the deadline test.
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F8-report.md`

| #   | Fix                                                                                                                                                                                                                                                                                                                                       | Regression evidence                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ignore `agent_settled` before the request's exact token anchor; `maybe()` also requires an anchor. An earlier queued run's settle cannot close this request or make its eventual result unattributed.                                                                                                                                     | Two queued-timing cases (accepted before/after that early settle) retain the request, discard earlier output, and emit exactly the later token-anchored result. Existing forged/mismatched-anchor tests now verify the 60-second no-anchor timeout rather than treating an unrelated settle as proof.                                                                             |
| 2   | Transport receipt drain/socket close run **in parallel** with the group-commit/dispatch/outbox/flush phases; no initial 6.1-second transport wait is added to the business budgets. Final connector disposal and its wait use only the remaining total budget.                                                                            | A fake-clock service test combines a native-like **never-closing socket**, an unresolved real dispatch, hung commit, hung outbox stop and hung final flush. It is still pending at 5,999 ms, resolves at **6,000 ms**, and a late dispatch result leaves the durable record `dispatching`. The hung socket stays unconfirmed, not falsely reported closed.                        |
| 3   | A successful capability observation removes its matching `capability-denied:<name>` degraded reason.                                                                                                                                                                                                                                      | Real F2 fake HTTP first denies Typing (99991672), then permits it. Snapshot changes `denied → ok`, removes the reason and returns to `open`.                                                                                                                                                                                                                                      |
| 4   | Snapshot counters are **service-lifetime**. Retired runtimes' receive/duplicate/outbox success+failure/reconnect/drop counters and last outbox code are folded exactly once, synchronously with dropping that runtime. They also survive credential replacement/reset within this service instance; a new process naturally starts fresh. | Actual receive, duplicate ACK and outbox sends retain identical totals after stop and restart, then increment once for new-runtime traffic; a second stop does not double-count.                                                                                                                                                                                                  |
| 5   | Simpler numeric-Other rule: in-range integer indices still select options; an out-of-range numeric reply is literal Other text when Other is allowed (default). No new prefix syntax. `allowOther:false` still refuses it.                                                                                                                | `42`, `0` and an oversized integer all dispatch exact Other strings when permitted; the explicit disallow case stays open, sends no command and patches a validation hint. Existing in-range option tests remain green.                                                                                                                                                           |
| 6   | Expanded lifecycle/keepalive tests without widening production ports.                                                                                                                                                                                                                                                                     | Real factory methods are wrapped, not replaced, to assert `connector.stop` is first and precedes **each** other teardown method on stop, dispose and reset. The budget test disposes with a pending dispatch. Unsafe credentials keepalive and reset-to-false are now directly asserted; the existing corrupt-state/no-connector/keepalive/repair/reset regression remains green. |

### Final shutdown deadline for FA (supersedes the earlier sequential transport wait)

- **t=0:** `connector.stop()` is the first cleanup call. It immediately stops admitting socket events/dispatch; its bounded existing-receipt drain and socket close proceed concurrently.
- Business sequence: group commit **≤1 s**, command/work/final/reaction drain sharing **≤2 s total**, outbox drain **≤2 s**, final state flush **≤1 s**. Each later wait is additionally capped by the remaining shared deadline.
- At the end, call `connector.dispose()` to synchronously fence it finally and wait for transport/dispose only within the remaining time. No extra unbounded or five-second close wait follows the six-second sequence.
- **Worst-case asynchronous `bot.stop()` / runtime cleanup wall budget: 6,000 ms**, plus ordinary synchronous work/event-loop scheduling delay. FA should reserve **6 s plus its scheduling margin** (for example 6.5 s), not 11 s. An unconfigured service has no transport; final setup cancellation in `dispose()` is independently capped at 2 s and runs concurrently, so it does not extend the configured service's six-second budget.
- This does **not** assert physical native-WebSocket termination: F3's documented bounded-abandon policy remains. A socket that never confirms close can survive as an inert, non-ACKing diagnostic zombie. Bounded logical cleanup and preserved durable requests/outbox are the guarantee.

### Follow-up self-verification (real output)

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 600 npx vitest run tests/web-hub/hub/feishu
Test Files  24 passed (24)
     Tests  1126 passed (1126)
  Duration  17.20s
FEISHU_TEST_EXIT=0

$ timeout 280 npm run build
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
BUILD_EXIT=0

$ timeout 60 npx prettier --check src/web-hub/hub/feishu/{service,runs,dialogs}.ts tests/web-hub/hub/feishu/{runs,dialogs,service-followups}.test.ts
Checking formatting...
All matched files use Prettier code style!
PRETTIER_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0
```

The changed test suites contain 13 new regression cases in total. Full-repository tests were not re-run by F8 for this follow-up; the 21,111 figure above is explicitly the independent verifier's prior result, not a claim about this revision. FA/F10/live-tenant acceptance scope remains unchanged.
