# 消息 fabric · 开发者要点

> 何时读：改动 `src/fabric/**`、`fabric.*` 设置键、`message_agent`/`message_session`/`message_channel`、xs 协议、频道/别名/回复相关 UI 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`phase2-plan.md`、`reply-plan.md`、`channel-plan.md`、`alias-plan.md`、`../fabric-v2/`

目录：

- In-tree fabric
- Wake phase 1
- Cross-session phase 2
- Request-reply
- Channels + broadcast + unread inbox
- Session aliases
- Web UI：Channels
- Web UI：Aliases

## In-tree fabric

`src/fabric/` — inter-agent message fabric: router (admission, per-kind quotas, dead letters),
mailbox, tree routing, per-link throttle. `message_agent` is scoped to subagents via
`src/runtime/tool-scope.ts`; routing relations come from the agent type's `can_message`
frontmatter (default: parent only).

## Wake phase 1

**Wake phase 1 (in-tree only; `docs/dev/fabric-cross-session/plan.md` v3, packages S0/F0/W1–W6/G, reports
`W2..W6-report.md`, `G-report.md`)**: `fabric.wake.{enabled,maxLevel,perRunQuota,resumeBudgetS,resumesPerHour,
resumesPerTargetPerHour,parkCapPerTarget}` (`enabled` default true but only effective while `fabric.enabled` — default
off — is on; read once at stack build, non-live). With wake on, `message_agent` gains an optional `wake` boolean
(schema frozen per activation; wake off ⇒ the pre-wake schema instance, pinned by `tests/fixtures/fabric-wake-off-golden.json`
— never regenerate it — and C-P4): omitted = legacy byte-for-byte, `false` = deliver-only (to a finished run: **park**,
pending until TTL or until a resume carries it; needs inbox durability `disk`/`session-memory`, `stack-memory` ⇒ legacy
`target_gone` + `parkUnavailable`), `true` = wake (expensive; progress ⇒ `invalid_wake`). Wake to root is exactly the legacy
steer+`triggerTurn` call (no new unmanaged root run path in phase 1). **Causal level** (`wake-level.ts`): `diag.wakeLevel`
(reducer input `wake_level`, monotonic, persisted with the terminal entry; root level in `subagent:wake-level`); only
proven human input resets root (`wake-input.ts`'s `input` hook; runs never reset); an effective wake hop needs
`level+1 ≤ maxLevel` else it silently downgrades to deliver-only (`level_limit`). **Successor coalescing**
(`SpawnService.resumeOwners`/`successorOf`, mailbox `waitingFor`/`drainSession`): a message for a finished run whose
session chain already has a successor waits for it (pending_start) or is redirect-steered into it (durable
`steerAttempt`; a steer timeout/restart ⇒ audited consume, never a retry). **Revive** (`WakeService.revive`, the single
exit): root-direct resume with the pinned model/thinking, fixed `resumeBudgetS` budget, `poolFullPolicy/loadPolicy:"reject"`
(pool/load/quota/closing/lock ⇒ park, config-class ⇒ `wake_refused` dead letter); exclusions recorded at admission
(`wakeExclusion`: readonly domain, caller-owned incl. workflow children, external/droid; `consult_fork` is a legacy value — read-only, never produced since #40, still excludes revive) + worktree gone /
unknown type / user-stopped (Q6) / legacy entry without a verdict (fail closed). Reservation ownership is claim-aware
(`engine.reserveStrict`, persist-first; a failed rollback ⇒ quarantine); **at-most-once rule** (NQ2): the linearization
point is `diag.inputAcceptedAt` (driver `input_accepted`, `trackInput` runs only) — only a REAL terminal entry proves
non-delivery (release), every ambiguous case is an audited consume (`resume_unverified`/`steer_unverified`/
`reservation_expired`/`reservation_quarantined`, never message text). **Quiet completions**: a revived run's
`DeliveryPayload.quiet` makes `stack.ts`'s `sendFormatted` use `sendMessage({triggerTurn:false})` directly (no hub token,
no `ask_user` interrupt, hub ignores quiet `message_start`; mixed digests split, quiet first). **`wake_result`**: the
trigger sender (registered synchronously inside admission) and coalesced `wake:true` senders get ONE system summary
when the successor ends (cap 8 per successor ⇒ `subscriptionUnavailable` receipt; a finished waker is skipped with an
audit line, never woken; root is covered by the owner notice; entries are watched by one unref'd 10-min timer and an
evicted/unknown successor's entry is dropped). Visibility: `/agent status` adds one `wake on · lvl≤N · root L· ·
resumes a/b h · parked · reserved · unverified · quarantined · durability · results · dead <reason>=n` line (absent when
wake is off), `get_run_result` adds `Woken by <ref> (level n) · +N inbox messages` / `Resumed with +N inbox messages`.
Accepted limitation: after a real `/reload` the old stack's `onReaped` closure is dead, so a reservation whose run
was still closing is re-judged by the NEW stack's 60 s fresh-`getBranch()` fallback (bounded, never unbounded
waiting). Cross-session wake (C1, RootWakeController, mutation fence) is phase 2 — plan §12 is an archive that must be
re-reviewed first. Gates: `tests/integration/fabric-wake*.test.ts`, conformance C-P1…C-P5
(`tests/conformance/fabric-wake.test.ts`; run before any pi peer bump), state-machine
matrix/property in `tests/core/`.

## Cross-session phase 2

**Cross-session phase 2** (`docs/dev/fabric-cross-session/phase2-plan.md`, §13/§14 + r3 rulings):
main sessions only, settings frozen at activate; `fabric.enabled` + `fabric.crossSession.enabled` +
`webHub.enabled` + `webHub.control !== false` gate tools `list_sessions` / `message_session`, `/fabric`,
`xs.v1`, member slots and `StatusInfo.xs` (off ⇒ byte-identical; no reserved-name change). Two human
opt-ins: settings enabled, then local `/fabric join|leave` or `fabric.crossSession.autoJoin` (default
false); agents cannot change membership, receive policy, blocks or fences. Mutation subcommands
(join/leave/receive/block/unblock/fence reset) are web-executable (2026-10-22 ruling, supersedes
phase2 §5.3/#9/XI13): governed by `webCommandPolicy.fabric` (default allow; settable to
confirm/deny — overrides the whole name) at the command-op policy layer, with unknown
subcommands denied; the Feishu source is still hard-refused (hub F6 admission forwards Feishu
only as prompt/dialog ops — the prompt-op `/fabric <mutation>` text guard answers with the
dedicated 「飞书入口」 refusal — and the `/fabric` handler hard-refuses Feishu-marked captured
invocations via `isFeishuInvocation`, derived from the hub-internal `ip:"feishu"` origin
marker); web prompt text carrying `/fabric <mutation>` is likewise refused (defense-in-depth
so prompt text can never bypass the policy gate). status/blocks stay read-only. Joined
receive defaults to `wake` (`fabric.crossSession.receive`, `allowFrom`); fork/copy never inherits
membership, even with autoJoin. **`/new` (and its web 「清空」 twin) DOES inherit** (2026-10-27 fix,
`new-session-channels-fix.md`): the outgoing stack's explicit membership snapshot (channel pref, receive
pref, blocklist, joinedAt) rides a consume-once `Symbol.for("pi-subagent:xs-membership-handoff")` slot from
`session_shutdown{reason:"new"}` into the next stack, which `adopt()`s it (re-persisted under the NEW
sessionId, so `/reload` keeps it) and it suppresses autoJoin exactly like a restored entry — an explicit
leave therefore survives `/new` too. A pristine (never-touched) membership stashes nothing, so autoJoin
behaviour for fresh sessions is unchanged. **Aliases follow `/new` too (#72 AF7, section 「Force takeover…」 below) — only `/new`; fork never inherits an alias.** `message_session` omits wake = deliver-only; `wake:true` alone may
start a turn through `RootWakeController` (no steer), gated by `fabric.wake.enabled`, causal level,
capability (`absent` ⇒ `host_unsupported` deliver-only; `unknown` ⇒ **optimistic dispatch** since
wake-unknown-optimistic 2026-11: the first run is authorized by BAS or aborted at its first
`context` sight before any provider request on verified-shape hosts 1.0.4/1.1.0/1.4.0 — legacy
conformance + C-X12 gates; other shapes degrade to a bounded supervised run; `woke:true` means
"dispatch accepted", same as `start_deferred`, not a provider-request guarantee), goal and quotas.
root deadline `fabric.wake.rootRunMaxS` (default 900s) starts at dispatch, including
pre-start compaction. Token authorization and dedup survive /reload; marked unauthorized/expired
triggers abort before their first provider request (B1); human handover only after proven own-run
start. Peer-upgrade gates: C-X1…C-X12 with real pi, **plus** the self-gated legacy conformance
(`PI_TOOLKIT_LEGACY_PI_DIR=… npx vitest run tests/conformance/fabric-xs-legacy.test.ts` against
unpacked pi 1.0.4 and 1.1.0 — local only, never in CI) — run both before any pi peer bump.
Mutation fences (compaction/tree/switch/web_exec/topic_switch) reject ALL ingress; goal
only downgrades wake. A 30s stuck warning never opens a fence; input/run-start is NOT completion
evidence (r3 M1); local `/fabric fence reset` is the manual escape. M2 effects: before-send
cancellation/origin change = `none`; after-send no verdict = `unknown`, received remote evidence
stays intact. Busy recipient = `unknown/queued` (may be queued, never blindly resend). Defaults
under `fabric.crossSession.limits`: out 10/min + 60/h, out wakes 6/h, in 30/h + wakes 12/h,
pair interval 30s + wakes 2/h, in-flight 4/session, hub 60/min, inbox 12; hub owns outbound quota.
`/agent status` reads the live xs stack (outbound usage unavailable ⇒ `out n/a/60h`, never fake 0);
AgentCard's cap-gated `xs wake|deliver|off` badge is display-only, never authorization.
`details` (token/xid/source) never enters provider payload; enabled tools/system stay stable.
Peer-upgrade gates: `tests/conformance/fabric-xs.test.ts` C-X1/X1b/X2/X3/X4/X5/X6/X7 with real pi
and a local Anthropic stub, alongside fabric-wake C-P1–C-P5; C-X7 records
duplicate-tool arbitration without relying on a winner. Both off goldens must remain unchanged.

## Request-reply

**Request-reply (reply-plan r2, `docs/dev/fabric-cross-session/reply-plan.md`; packages RX0–RX6/RXW/M/MW, reports
`*-report.md`)**: `message_session` gains `expectReply:{timeoutS}` (A asks) and `replyTo:<requestId>` (B answers,
`to` = full sessionId); both ride the `xs.reply.v1` cap (only added when BOTH ends advertise it — no PROTO bump; hub
`REPLY_UNSUPPORTED` early-rejects without reserving) and require `fabric.crossSession.reply.enabled`
(default true; schema/off paths pinned by `tests/fixtures/fabric-xs-reply-off-golden.json` — with xs on ∧ reply off every
surface is byte-identical). `receive` accepts `"replies"` (only a valid, solicited reply is accepted; unsolicited
traffic is refused by hub and receiver) via the pure `effectiveReceive(pref, replyEnabled)`: reply unavailable ⇒ **off,
never wake** (fail closed); membership persists `{receive:"off", receivePref:"replies"}` so an older plugin reads off.
**Credential = the issuing process's in-memory ledger only** (`src/fabric/xs/reply-ledger.ts`,
`Symbol.for("pi-subagent:xs-reply-ledger")`, 64 slots, never evicts a live entry, sweep is process-wide/lazy): disk
(`subagent:xs-reply` entries) exists solely to emit a post-restart "invalidated" notice — `/tree` rollback, tombstone
eviction and pi restart can only REFUSE a reply (unknown id ⇒ rejected), never resurrect one. Consumption is
reserve → commit/release around the host dispatch: reserve flips the ticket to `consuming` BEFORE any re-entrant
call; only a provably-ineffective dispatch releases, everything else commits a tombstone ⇒ per requestId at most one
possibly-effective dispatch (`tests/fabric/xs-reply-receiver.property.test.ts` drives the real receiver + ledger).
Replies use an independent `replyInbox` (quota: receivable+consuming tickets + inbox occupancy ≤ `maxPending`), skip
recv rate/inbox caps, and a solicited wake returns the root to `requesterLevel` (no +1, R3). Timeout/late handling:
`timed_out` stays receivable until `lateUntil` (late reply = deliver-only); the timeout/invalidation/away-summary
notices go through **NoticeGate** (`reply-notice.ts`: disposed/session/joined/receive/fence admission, owed kept and
retried on event-driven flush points + 30 s fallback, dropped at `lateUntil` and counted; a delivered notice is never
re-owed). **@session mention** (`src/mention/session.ts`, `fabric/xs/directory.ts`): `@session:<ref|name>` explicit form and
a bare `@name` (R6 priority: subagent/real file path win; path-shaped never; a bare-name cache miss triggers one throttled
directory refresh); not joined / xs off ⇒ passes through untouched; a human-origin reply wakes per receive mode and
cross-session messages are user-visible (RX7 — do not hard-code the old R4 "display only"). **Handled-input
report (2026-11-04 fix)**: `installMentionInput` answers pi `{action:"handled"}` only after calling the optional
`MentionRouteDeps.onHandled` once with the raw `event.text` (`wire.ts` injects
`webHubRef.current?.noteInputHandled`) — a handled answer short-circuits pi's input chain, so without the report the
web-hub prompt ledger's `dispatched` entry would decay to `unconfirmed(unobserved)` ("sent · unconfirmed") although the
mention router really applied the message; `CommandHandler.onInputHandled` flips the session/owner-scoped
`findDispatchedByText` match to `consumed` (miss/ambiguity ⇒ no-op, never a guessed cmdId). Gates:
`tests/web-hub/agent/commands-input-handled.test.ts`, `tests/mention/mention.test.ts` (onHandled block),
`tests/integration/fabric-xs-mention.test.ts` (31 s ctl check). Settings
`fabric.crossSession.reply.{enabled,defaultTimeoutS,maxTimeoutS,maxPending,maxPendingPerTarget,lateGraceS}` (frozen at
stack build; `timeoutS` above the max is clamped). Visibility: `/agent status` adds
`xs replies p<pending>/<max> i<inbox> to<timedOut> late<n> rej<n> owed<n> drop<n> · ledger n/64` (absent when reply is
off), `/fabric status`/`/fabric replies` show the same counters/rows and `(pref replies)` when the effective receive differs.
Gates: `tests/integration/fabric-xs-reply*.test.ts` (real hub child × real stacks, §12.2 #1–#9) +
`fabric-xs-mention.test.ts`, conformance **C-X8** (`tests/conformance/fabric-xs.test.ts`, real pi: solicited run binds
its token, reply/token details never reach the provider payload, quiet replies don't start runs, replies mode refuses
unsolicited — run with C-X1…C-X7 before any pi peer bump). All THREE off goldens
(`fabric-xs-off`, `fabric-wake-off`, `fabric-xs-reply-off`) must never be regenerated.

## Channels + broadcast + unread inbox

**Channels + broadcast + unread inbox (channel-plan r3, `docs/dev/fabric-cross-session/channel-plan.md`; packages
CH0–CH6/CHU/CHU-b/IB1/IBP/IBU/IBW/CHW, reports `*-report.md`, real-device checklist `channel-acceptance.md`)**: a channel is a
communication SCOPE, not a credential (names are not secrets; pair with allowFrom/block). Membership is human-only
(`/fabric join [#a #b]` incremental, ≤4 names, lowercase ASCII, `#default` = legacy; local TUI/RPC/web per
`webCommandPolicy.fabric`, Feishu hard-refused; agents have no join path). Discovery and addressing
(`list_sessions`, `message_session`, `@session`, `/fabric block` resolution) cover only sessions sharing ≥1 channel (union);
hub enforces it at list/resolve/send/broadcast with the **unique-holder (AMBIGUOUS) check BEFORE visibility filtering**, and the
receiver re-checks at stage 3 against the hub-stamped `via`/`bc` (the linearization point of a local leave). Pure
`effectiveChannels`/`linkChannels` (`src/fabric/xs/channel.ts`, `membership.ts`): gates read `link(hubCap)`/`linkJoined(hubCap)`, so
on an OLD hub (no `xs.channel.v1`) a named-channel-only session fails closed (`/webhub restart`). Wire is additive (cap
`xs.channel.v1` on both surfaces, optional fields `channels`/`via`/`bc`, NO PROTO bump); **default-only ⇒ frames, membership
entry and status projection byte-identical** (compat proof `tests/integration/fabric-xs-channel-compat.test.ts`, three-way anchored on
the golden; the three off goldens + `tests/fixtures/legacy-xs-v071/` never regenerated). Settings (non-live, frozen at
activate/stack build): `fabric.crossSession.channels.{enabled (default true),autoJoin (default ["default"], boolean
`crossSession.autoJoin` stays the master switch),broadcast.{outPerHour,minIntervalS,wakeOutPerHour (hard ≤2),maxRecipients
(hub-global, ≤32),wakeMaxRecipients (hard ≤4)}}`. `channels.enabled=false` ≡ old agent: no cap, no `message_channel`, legacy
`list_sessions` instance, and saved named channels are **suspended** (kept in the entry, never collapsed into default; `/fabric status`
shows `suspended #a (channels.enabled=false)`). Broadcast = `message_channel{channel,text,wake?}` (main session only,
registered post-guard iff xs ∧ channels): hub-side fan-out (`src/web-hub/hub/xs/broadcast.ts`), whole-batch admission by head count
(`limits.admitBroadcast`: recipients ≤`maxRecipients`, hourly 6, min interval 60s, N charged against send quotas), `#default`
cannot broadcast, no expectReply, sender never loops back, deliver-only by default. `wake:true` needs sender level 0 ∧
hopAllowed ∧ N≤4 ∧ broadcast-wake ≤2/h ∧ outbound-wake quota; the first failing condition downgrades the whole broadcast to
deliver-only (`wakeDowngraded`), each receiver still applies its own receive mode/maxLevel/fence/quotas; broadcast wake
reservations and send counts are **NEVER refunded** (also P2P `unknown` no longer refunds) — a woken run is level ≥1 and cannot
broadcast-wake again. At most one dispatch per (broadcast, recipient); `unknown`/partial ⇒ never blindly resend. Receivers see the
first-line header `channel="#x" kind="broadcast"` + a host note (`formatXsMessage`; no `bc` ⇒ byte-identical); `details.bc`/`via`/token/xid
never enter the provider payload (**C-X9**). **Unread inbox** (`src/fabric/xs/unread.ts`, `Symbol.for("pi-subagent:xs-unread")`, ≤32 session
buckets FIFO): an event counter, NOT a correctness invariant — the two host write exits in `stack.ts` (receiver/Controller host + NoticeGate quiet
write) call `tap.written(id)` after a successful `sendMessage` (broadcasts, replies, notices count; tree `message_agent` does not); `turn_start`
stamps a monotone seq and `turn_end` (fallback `agent_end`) clears entries written before that turn started — better to clear early than never
(128-id FIFO + two-bucket overflow keeps liveness; display `99+`). Survives `/reload`, resets on pi restart, forks start at 0. Surfaces: TUI status
key `pi-subagent:xs-inbox` (`inbox N`), `StatusInfo.xsInbox{unread}` (open field, no cap; UI gates on `xs.v1`), `/fabric status` `inbox unread N`.
Visibility: `/fabric status|channels` (channels line, `hub-cap on|off|n/a`, broadcast limits, `usage n/a` — the hub has no usage port) and
`/agent status` adds ONE line `xs channels #default #team (2/4)[ · suspended …][ · inbox N]`, emitted only when it carries news (named
channel, suspended names or unread>0) so default-only/off output stays byte-identical. Gates: `tests/fabric/xs-{channel,channel-ch3,
sender-channel,directory-channel,unread}*.test.ts`, `tests/web-hub/hub/xs-{channel-hub,broadcast,broadcast.property,router-v071-diff}.test.ts`,
`tests/integration/fabric-xs-channel*.test.ts` (real hub child × 2–5 real stacks, serial boot — agents share HOME and UUIDv7 refs collide
within ~16 ms) + `fabric-xs-inbox.test.ts`, conformance **C-X9** (broadcast metadata hygiene + header format, real pi) and **C-X10** (pi ordering
facts for unread) in `tests/conformance/fabric-xs.test.ts` — run with C-X1…C-X8 before any pi peer bump. Accepted residuals: channel names
are not secrets; unread can clear early (context_edit/compaction/provider error/`/tree`/abort, IR1–IR4) or undercount (restart/fork, IR5/IR6);
bare-name completion uniqueness rests on a ≤10 min cache (hub resolves explicit refs authoritatively); `level===0` relies on an honest
sender (same-uid trust; receivers still enforce maxLevel); broadcast wake budgets are consumed conservatively.

## Session aliases

**Session aliases (alias-plan r4, `docs/dev/fabric-cross-session/alias-plan.md`; packages AL0a/AL0b/AL1/AL2/AL3/AL4/AL5a/AL5b/ALU/ALW/AL6,
reports `AL*-report.md`, real-device checklist `alias-acceptance.md`)**: a human-assigned, hub-unique short name per session (≤16 grapheme
clusters/≤48 bytes; ASCII alnum/`_`/`-`, CJK, kana, hangul; `src/web-hub/protocol/xs-alias.ts` `normalizeAlias` folds full-width/`@`, rejects
invisible/Jamo-filler/id-like/reserved words, skeleton blocks look-alikes — CJK↔CJK pairs like `カ/力` are accepted residue). Settings
`fabric.crossSession.alias.{enabled (default true),offlineLeaseH (168),coolMin (10),takeMinOfflineMin (10, floor 10)}`, non-live (activate/
stack build + hub start). Cap `xs.alias.v1` on both surfaces = `xsOn ∧ alias.enabled` (agent) / hub `crossSession.alias` key present ∧ store
`ready` (hub); **key absent ⇒ off ⇒ hub byte-identical** (agent writes the key only when alias.enabled, so whoever spawns the hub decides for the
run — residual R11). Only humans set/clear/take: `/fabric alias [<名>|--clear|<名> --take[=<token>]]` (local TUI/RPC/web per
`webCommandPolicy.fabric`; Feishu hard-refused at handler line 1 + prompt-text guard; no tool, no agent path; child sessions have no `/fabric`).
Take = preview (token bound to requester/alias/holder/rev/offlineSince, 5 min, ≤32 in hub memory, **every outcome consumes it**, preview counts
toward `listPerMin`) → confirm (TUI `ctx.ui.confirm`; web/RPC echo ends with the fixed `XS_ALIAS_TAKE_CONFIRM_RE` line that `useTrackedCommand`
parses from THAT command's captured output only) → execute with token; only a holder offline ≥10 min can be taken, an online/<10 min holder is
refused. **Hub single writer** (`hub/xs/aliases.ts`, `<stateDir>/xs-aliases.json`, 0600, ≤256 records/64 KiB): intents on disk, presence in
memory (restart restarts the 7-day lease, R8), shared step G (a grant demotes the grantee's other aliases to 10-min cooling — cooling is
reclaimable only by its owner), tombstones feed the one-shot `lost{taken|expired}` notice on reattach, rename-stall ⇒ `wedged` (writes busy,
reads keep the old table, >60 s ⇒ `disabled`), load three-state `ready|degraded` — **degraded never touches/moves the file**, declares no cap,
and guards alias-shaped names (UNAVAILABLE, never falls back to a same-named session; R10) until a human fixes/moves the file +
`/webhub restart`; the hub logs it AND writes `hub.json.alias{degraded,reason,path}` (key absent when healthy) which `/webhub status` renders as
`alias store degraded (…) · <path>` (`agent/alias-status.ts`). **Addressing**: for an `aliasUsable` requester (`aliasAdvertised ∧ aliasCapable`)
the alias layer is consulted FIRST and a hit is final — an unreachable alias (offline, not joined, other channel, self, cooling) answers
NO_TARGET and never falls through to names; a full sessionId / ref is exact-only (no prefix, no name) and `send` pins the full sessionId
(kills the same-ref/UUIDv7 and name-equals-sid spoofs); reserved addresses such as `root` ⇒ NO_TARGET (R12); without the cap every frame,
resolution and ordering is byte-identical to the channel build (pinned by the v0.7.1 router diff). Model-visible surface: tool descriptions gain
an alias sentence, rows/candidates/target carry `alias`, incoming headers carry an INDEPENDENT ` alias="…"` field after `from=` (hub-verified;
`from` is self-reported). **Tool instances freeze on the LOCAL `alias.enabled`** (never the hub cap — a late/changed cap must not rewrite
descriptions and break the prompt-cache prefix); cost: alias-on session on an old/degraded hub keeps the alias-flavoured description while
addressing falls back to legacy (R13). `/fabric status` adds `alias @x held · lease 7d · cool 10m | alias - (lost: taken) | alias n/a
(hub-cap off|alias.enabled=false)`. `@alias`/`@session:` mention (`mention/session.ts`, directory cache holds aliases; miss ⇒ one throttled refresh).
Gates: `tests/web-hub/protocol/xs-alias.test.ts`, `tests/web-hub/hub/{xs-alias*,hub-xs-alias,xs-router-v071-diff}.test.ts` (+AL1 property),
`tests/fabric/xs-alias*.test.ts`, `tests/integration/fabric-xs-alias-wiring.test.ts` (real activate × fake hub socket) and
`tests/integration/fabric-xs-alias.test.ts` (real hub child × 3 real stacks; hub clock injected via `StartHubDeps.now` through the fixture's
`skew` op — no production hook; covers set/send/@/channel scope/take chain/corrupt-file restart/web `webCommandPolicy.fabric=confirm`/mixed fleet),
conformance **C-X11** (alias tool schema stable, alias only as independent header field, details/token out of the payload; run with C-X1…C-X10
before any pi peer bump). The three off goldens and `tests/fixtures/legacy-xs-v071/` are never regenerated. Accepted residuals: R1–R13 in plan §11
(hand-deleted file ⇒ fresh table, display name equal to an unreachable alias, >20 aliases truncate list, cooling only mitigates stale-list mis-sends,
`lost` notice once per process, preview discloses holder cwd/offline time).

**Force takeover + cwd-basename auto alias (#72, `alias-force-default-plan.md` r2 — the 「用户拍板」 and 「r2 修订对照表」 at its end override the
body; packages AF0–AF4/AFU/AFW/AF6/AF7, reports `AF*-report.md`)**: everything above stays; this layer is additive and
gated on the cap `xs.alias.v2` (both surfaces, same condition as v1, declared right after it; no PROTO bump).

- **`--force`**: `/fabric alias <名> --force` is PREVIEW ONLY and mutually exclusive with `--take`/`--take=<t>`/`--clear` (any combination or
  `--force=x` ⇒ usage error, zero requests). Unlike `--take` it works on an ONLINE or just-offline holder. TUI: `ctx.ui.confirm` (title
  `强制抢占别名「x」？`, detail names the holder's cwd, 「（自动认领）」 when the record's `origin` is `auto`, online / offline time, and that later
  messages re-route); web/RPC: the same text ending with the unchanged fixed `XS_ALIAS_TAKE_CONFIRM_RE` line. Execution is the existing
  `--take=<token>`; the token carries `mode:"force"` + `presenceKey` (`on` | `off:<offlineSince>`), a mode=take token never executes as force and vice
  versa, every outcome consumes it. A `--take` refusal (`online`/`recent`) or a `set` on a taken name appends the `--force` pointer when the hub is v2
  (D5). Hub order in the transaction: token + `R.sessionId===H` + `R.rev` + presence + `notifiable(H)` re-checked at execute AND before rename.
- **Presence is three-state** (hub read-time): `xs-online` (an effective xs member) / `linked` (connected, phase≠stale, same sessionId, but no xs
  member — xs off, or not yet published) / `offline`. `take`, lease expiry and `offlineSince` still look at xs-online only (the 10-minute rule is
  unchanged); `linked` exists for force. `notifiable(H)` = offline, or xs-online with EVERY effective member declaring `xs.alias.v2`; linked ⇒ never.
  Unnotifiable ⇒ `E_XS_ALIAS_TAKE{unnotifiable}` (「持有会话在线但无法实时通知…请待其离线 ≥10 分钟后用 --take」); only `--take` remains.
- **Real-time notice**: after the commit (also a wedged rename that lands late; never a late failure) the hub pushes `xs_alias_evt{sessionId,at}` — no
  alias text — to every v2 effective member of the evicted session; the agent only answers it with a `get` reconcile, which yields `lost{taken, forced:true}`
  and the one-shot 「别名…已被其他会话强制抢占（对方已人工确认）」 notice (same per-process `(sid, lost.at)` dedup as the plain lost notice; `StatusInfo`
  is untouched, `publishStatus()` clears the card's `@alias`). The tombstone (`taken`, optional `forced:true`) remains the fallback if the push is lost.
- **Auto alias** (`fabric.crossSession.alias.autoFromCwd`, default **true**, non-live, agent-side only — never written into the hub config; it is the only
  crossSession key in `/agent settings`): after a `get` that was applied and says `none`, a main session that is joined, not `decided`, on a v2 hub,
  derives `deriveAliasFromDirName(cwd basename)` (NFKC → illegal code points to `-` → trim → ≤16 clusters/≤48 bytes; `/`, `$HOME`, tmpdir, reserved
  prefixes such as this repo's `pi-toolkit` and id-like names are SKIPPED, never prefixed/suffixed/stripped) and sends `intent:"auto"`. The hub only
  CREATES a record (`origin:"auto"`): refused (`TAKEN`, a synchronous pre-check that does not use the queue) while the name has any held record (expired
  included) or live cooling, or while the session owns a held/live-cooling record or a tombstone younger than 30 days. Dedup key
  `(connGen, sessionId, membershipEpoch)`; `BUSY{queue|io}` retried once after 1–5 s (unref'd, `clampSpanMs`); one-shot success notice through its own
  process set `pi-subagent:xs-alias-auto-noticed` (≤32). Sub-sessions have no xs bridge and never auto; secure (D8) forces xs off.
  `/fabric status`: `alias @x held (auto) · lease …` and `alias - · auto skip:<off|decided|not-joined|dir|invalid|taken|busy>` (English tokens). With
  `autoFromCwd=false` or a non-v2 hub the status lines are byte-identical to the v1 build.
- **「decided」mark**: custom session entry `subagent:xs-alias-decided {v:1,sessionId,at,via:set|clear|take|force|inherit}`, read from
  `sessionManager.getEntries()` (NOT `getBranch()`: `/tree` must not undo a human decision; a fork's copied entries carry the old sid and are ignored).
  Written BEFORE the xs_req leaves (memory flag + `appendEntry`; a failing append is swallowed and a throwing `markDecided` never blocks the write)
  by `set`, `clear` (also on a session with no alias — the explicit 「关闭目录名自动别名」), and by TUI-confirmed or `--take=<token>` execution;
  failed human writes count too (D6). Reads, previews, a cancelled confirm and Feishu do not. Survives `/reload`, resume and hub restart.
- **`/new` handoff (AF7, D3)**: `/new` and the web 「清空」 (same `session_shutdown{reason:"new"}`) move the held alias to the new session id; fork and resume never do.
  - _Agent_: at shutdown (`stashMembershipHandoff` → `stashAliasHandoff`, `fabric/xs/alias-handoff.ts`) the outgoing session's held alias (read **by explicit sid** from the bridge cache — the fence hook has
    already detached the stack, so `current()` cannot see it) and its decided mark go into ONE consume-once `Symbol.for("pi-subagent:xs-alias-handoff")` slot (TTL 60 s, nothing to carry ⇒ nothing stashed).
    `beginSessionStart` always clears the slot and adopts it only for `reason:"new"` ∧ a different sid. The decided mark is re-written for the new sid as `via:"inherit"` (so `/reload` keeps it, and
    `aliasHumanDecided` — any human set/clear/take/force on the new session — cancels a still-pending handoff). The alias becomes `aliasHandoff().pending(sid)` (expires after 120 s).
  - _Bridge_ (`agent/xs.ts` reconcile ①, before auto): after an APPLIED `state:"none"` get, hub ∋ `xs.alias.v2`, ONE `{alias, intent:"handoff", prevSessionId}` per `/new` (settled before the frame goes out;
    a concurrent reconcile cannot auto-claim meanwhile). It works with `autoFromCwd=false` (a continuation, not an auto-claim) and is silent on success. ANY failure — stale, BAD_FRAME from a hub that
    predates AF7, BUSY, UNKNOWN, link loss — falls straight through to the ordinary auto path (which the inherited decided mark still suppresses). A v1 hub gets nothing; hub offline at `/new` ⇒ no frame, the
    pending expires, the old name stays on the old sid until take/force (R22).
  - _Hub anti-forgery_ (I10): `members.predecessorOf(agentKey)` is the **hub's own observation** on that one socket — `onInvalidate("detached")` remembers the departing sid (a `/new` reaches the hub as
    `session_detached` → `session(new)` → `xs_member(new)`), `onSession`/`onMember` with another sid write `{from, to, at}` before the old record is dropped; one slot per agentKey, TTL 120 s, memory only, cleared by
    any non-detach invalidation (socket down/closed/reclaimed) and by a successful handoff. The frame's `prevSessionId` is only compared with that edge, never trusted: another socket has no edge, a socket
    with its own succession can only name its own predecessor. On top of the edge `store.handoff` requires (plan time AND again right before rename) `held(prev)` of exactly that alias, `prev`
    **offline** (neither xs-online on another socket nor `linked`), and the requester holding nothing yet. Transfer = in place (`rev+1`, `origin` kept, cwd label refreshed, no tombstone for prev, no cooling, prev's and
    the new sid's tombstones dropped). Every refusal is `E_XS_ALIAS_TAKE{stale}`; queue/IO trouble stays BUSY/UNKNOWN. A pre-v2 requester gets `E_XS_BAD_FRAME`.
- **Invariants** (extend alias-plan r4 §3.1): **I5′** (replaces I5 「online holder is never taken」) — someone else's held record moves only by human
  `take` (holder xs-offline ≥ takeMin), human `force`, `set` over an EXPIRED record, or (AF7) `handoff`; `take`/`force` re-check the token tuple at
  execute and before rename, and **an online holder can be forced only if it is notifiable**. **I7** — `auto` only creates; it never edits, moves or
  demotes a record (step G is a no-op for it). **I8** — decided is write-before-send, so a human op always lands after an in-flight auto (FIFO per
  connection). **I9** — a committed force pushes `xs_alias_evt` to each v2 member of the evicted session; push failure never rolls back. **I10** — `handoff`
  (AF7) moves a name only along a same-connection predecessor edge ≤120 s old, from an `offline` previous session, without tombstone/cooling.
- **r4 §5.2 revised**: it is no longer true that an evicted holder is always offline. A `send` pins the full sessionId at resolve time; if a force lands
  between resolve and send the message still goes to the holder it was resolved to (online ⇒ delivered; offline ⇒ `NO_TARGET`) — never to the new holder.
- **Mixed fleets** (additive wire; old keys never change): new agent × v1 hub ⇒ no `intent` frame is ever sent (a `xs_req` with unknown fields would be
  dropped whole by the old hub's strict schema), auto/force are off locally (`--force` ⇒ 「hub 不支持强制抢占，需 /webhub restart」), `--take`/`set`/
  delivery unchanged; old agent × new hub ⇒ the hub writes it no new keys and pushes nothing, it cannot be forced while online, and when it comes back
  it gets the legacy `lost{taken}` (no `forced`). The file keeps `version:1` with optional `origin`/`forced` keys only; an older hub reads such a file
  without degrading (and drops the keys at its next write).
- **Gates**: `tests/integration/fabric-xs-alias-v2.test.ts` (AF6: real hub child × 3 stacks; fixture knobs `XW_CWD`, `XW_TUI_CONFIRM`, `XW_STRIP_V2`,
  `XW_HUB_STRIP_V2` in `helpers/fabric-xs-process.ts` strip `xs.alias.v2` from the peer's own handshake caps so the other side sees a pre-v2 agent/hub
  on the wire), `fabric-xs-alias-wiring.test.ts` (real `activate()` × fake hub socket), `tests/web-hub/hub/xs-aliases-v2*.test.ts`,
  `xs-alias-v2-router.test.ts`, `tests/web-hub/agent/xs-alias-auto.test.ts`, `tests/fabric/xs-alias-{auto,decided,suggest}.test.ts`,
  `tests/commands/fabric-xs-alias.test.ts`. `tests/config/__corpus__/setting-specs-pin.json` gained exactly the `autoFromCwd` spec on purpose and
  `settings-corpus.json` was regenerated (only `"autoFromCwd"` differs).
- **Accepted residuals** (plan §11 R14–R23, plus what the packages found): **R14** common directory names (`web`, `app`) become a hub-global alias for the
  first session in; **R15** after a force, a sender holding a stale list/mention cache addresses the new holder (resolved-before-force messages still
  go to the old one); **R16** the decided mark is per process until the other process of the same session sees it; **R17** a human clear made before this
  upgrade left no mark, so after cooling that session may auto once (run `--clear` again); **R18** a hub downgrade drops `origin`/`forced` at its next
  write (display only); **R19** an old agent or an xs-off-but-linked holder cannot be forced while online, only taken after 10 offline minutes, with no
  real-time notice; **R20** auto never takes an expired record, so an abandoned session keeps its basename until a human sets/takes/forces; **R21**
  restart claim storms may answer BUSY — one retry, then the next hello; **R22** (AF7) the `/new` window is hub-memory only; **R23** the push is best effort
  — an evicted session that never reattaches shows a stale local `/fabric status`/card `@alias` until the next hello_ack, attach or status reconcile
  (hub data, addressing and delivery are already correct). Also: the audit records a forced execution as `take` (force vs take indistinguishable;
  `force-preview` is distinct, and no alias text/token/cwd is ever logged); an old hub's `/fabric status` has no `auto skip:hub-cap` (AF4 chose
  byte-identity with the v1 build over the plan's suffix); a `--take` refusal shows the `--force` pointer even when the holder will turn out
  unnotifiable (the next command then explains); a force token executed after `/reload` (or evicted from the 32-entry hint map) is logged as `via:"take"` in
  the decided mark (both mark decided; the hub enforces the real mode).

## Web UI：Channels

**Channels in the web UI (channel-plan §7, CHU/CHU-b)**: all gated on hub caps ∋ `xs.channel.v1` (absent ⇒ UI byte-identical). AgentCard shows a
channel chip only when the effective set ≠ `[default]` (`status.xs.channels`; missing ∧ joined ⇒ `[default]`); `AgentList.vue` shows a sidebar
channel-filter chip row only when a named channel exists (selection is component memory, not persisted); the `@` panel (`control/sessionMention.ts`)
lists only same-channel sessions (UI hint, hub is authoritative); broadcasts render in the transcript as `#team · 广播`
(`logic/xsMessage.ts` parses ONLY the first line, `TxCustom.vue`); the detail header has a 「频道」 button opening `detail/ChannelsDialog.vue`
(channels aggregated client-side from the sessions' pushed `status.xs.channels` — no new endpoint; ticking sends `/fabric join|leave #x` through the
existing web command op under `webCommandPolicy.fabric`, no optimistic update, Feishu still refused, ≤4/reserved names disabled client-side); unread
badge (`StatusInfo.xsInbox`) on AgentCard and `DetailHeader.vue`. Design: `docs/dev/fabric-cross-session/channel-plan.md` §7/§12.6.

## Web UI：Aliases

**Aliases in the web UI (alias-plan §7, ALU)**: gated on hub caps ∋ `xs.alias.v1` AND the session's `status.xs.alias` (absent ⇒ UI byte-identical,
DetailDock untouched). `composables/useTrackedCommand.ts` is the only path that runs web alias commands: own cmdId per command, `E_CONFIRM_REQUIRED`
⇒ generic confirm (`CommandConfirm.vue`) then a NEW cmdId with `confirm:true`, async completion ⇒ watches that cmdId's `pendingCtl` entry then one
`queryOnly` and unwraps `data.output`, 15 s timeout/dialog close/session switch drop late results (never undoes the command). `ChannelsDialog.vue`
(titled 「频道与别名」) has an alias area: live `normalizeAlias` pre-validation, ≤3 suggestion chips (others' taken ones greyed from pushed
`status.xs.alias`), save/clear/take (take: preview → token parsed from that one output → confirm dialog with countdown → execute), no optimistic
update. AgentCard chip order `kind → state → xs badge → @alias → #channels → unread` (alias shown whole — cap = protocol max 16 clusters since 2026-10-27, title = full);
DetailHeader shows `@alias` opening the dialog; the `@` panel matches/shows alias but still inserts `session:<ref>`; `logic/xsMessage.ts` reads
` alias="…"` from the first line independently of field order. Design: `docs/dev/fabric-cross-session/alias-plan.md` §7.

**Force takeover + cwd chip in the web UI (#72 AFU)**: everything is gated on hub caps ∋ `xs.alias.v2` (the UI mirrors the cap as
`XS_ALIAS_V2_CAP` in `agentCardModel.ts`; no v2 ⇒ the dialog and chips are byte-identical to the v1 build). When the 「尝试抢占」 preview is refused as
online/recent (`TAKE_REJECT_FORCE_RE` on the two fixed refusal sentences) the dialog shows a danger button 「强制抢占…」 under the echo. Clicking runs
`alias <名> --force`, parses the token from THAT command's output with the unchanged `parseTakeConfirm`, and reuses the existing confirm dialog
(holder cwd / online state / 「自动认领」 + 5-minute countdown); execution is `--take=<token>`. A refused force (e.g. `unnotifiable`) only echoes — no
button; the offer follows the input (changing the name drops it) and is re-checked against the live caps at render time (`forceOffer`, two-layer v2
gate). `webCommandPolicy.fabric=confirm` ⇒ the generic confirm appears once for the preview and once for the execution. The cwd suggestion chip uses
`deriveAliasFromDirName` (only when v2), so the chip equals what auto-claim would pick (`My Project` → `my-project`; reserved/id-like ⇒ no chip). Two
i18n keys (`alias.force`, `alias.forceAria`) live in the lazy `i18n/alias-extra.ts`, not `detail.ts`. Gate: `tests/web-hub/ui/alias-ui.test.ts`; the
end-to-end web path is `tests/integration/fabric-xs-alias-v2.test.ts` ⑤.

## Request progress / host human delegation (#14 P2, staged)

The frozen gate is `xsOn ∧ fabric.crossSession.activation.enabled` (default true).
`fabric/xs/activate.ts` now supplies P1's `activationEnabled` bridge port: main agents
advertise `xs.state.v1` and emit the hub `activation:true` config key. P3b registers
`wake_session` under activationOn; its separate `xs.activate.v1` cap requires frozen
local wake enabled. Query survives wake-off; activate fails closed on missing caps. `/fabric status` consumes both receiver
progress and the source mirror; no rows means no added line. B1 runs before the P1
context observer, including controller-less natural turns.

P2's host-only `human-grant.ts` stores pure provenance under
`Symbol.for("pi-subagent:xs-human-grants")`: 64 live inputs, lazy <=30 min expiry,
256 invocation/context references per grant, no live capacity eviction. Input is not
a turn-wide boolean: a signed TUI/RPC input, or a once-only policy-admitted web
cmd/owner proof, must enter context as the actual host-observed user message before
an exact toolCallId can resolve it. Queued input never upgrades the old assistant's
calls. Extension notifications, topic-switch replay, Feishu and model `source`/meta
are not signing paths. Missing/copy-transformed context identity fails closed.
Same-sid reload does not let a new owner take over old calls; new/fork/switch revoke.
The web proof park is pure data, cap64, 5 min, scoped/ambiguity-safe and consumed
once; command disposal/boundary clears that owner's unused proofs.

One qualified `expectReply` with omitted wake reserves the grant after address,
receivability and size checks. Commit is **before** send/re-entry; unknown or throw
keeps it consumed, proven none allows only the same call/target retry. Explicit
true/false and replyTo take precedence, no grant crosses xs, no quota or causal
level reset is added. The same ref can follow real spawn edges: stack's admission
hook records the edge; the host Agent tool result connects the exact invocation
and returned childRunId. Neither result text nor prompt/model metadata grants an
edge. P2c injects only a host-owned `message_session` SDK tool into an authorized
child; ordinary/readonly/excluded/noTools/secure/external/off children remain inert.
Children acquire no xs membership, connection, caps or bridge of their own.

The bridge's send port correlates progress only by the **original send rid** while
that send is live; sourceRid is never a tool parameter or model payload. A confirmed
relation exposes `XsSendOutcome.track{messageId,activationKey?}` and `progress`;
no matching state/off/old-cap/capacity fallback means no invented track. Local wake
marks overlay the source view without incrementing receiver revisions. The source
res, tool JSON/hint and new-cap mention result retain the first stop reason
(`pair_wake_rate` explains the existing default 2/h pair quota). `woke` is dispatch
acceptance, not `started`; unknown never causes a second body send. The synchronous
web mention branch marks its exact cmdId consumed; the shared mention subscription
uses session/owner-unique dispatched input matching and preserves onHandled once.
Legacy/off command results and notice text retain their old shape.

P2b's hub resolve stamps `target.xsState` only for the actual target socket when
hub/source/target all support state; missing proof never defaults a delegated wake.
P2c's activation-local human-runtime façade is passed only at the PiSessionDriver
constructor. It binds a real admitted childRunId to a unique driver owner, observes
exact SDK context/tool_call/tool_result events, and proxies the shared main sender.
Root Agent result races get one unref'd, clamped 1s wait (cap64), only after an
already proven potential parent and real spawn edge. No proof means no wait/tool.
For blocking nested Agent, a per-activation AsyncLocalStorage carries only the
exact captured SDK execute InvocationRef to nested driver creation; the recorded
admission edge still must agree. No model argument or guessed parent is authority.
The source session/epoch and child lifetime are checked after address resolve;
child causal level is read live at the wake decision and maxed with root, never
reset. Per-run allowlists gain only this host SDK tool, never readonly provenance.
Dispose/abort/agent_end/branch changes and committed child switch boundary entries
end that run's references while preserving already live descendants. New owners
cannot take over old child bindings. Switch/fork/start/shutdown detach synchronously
clears local binding closures and waiters and disables ALS; a generation guard
refuses a waiter resumed across detach. No callbacks/senders/SDK sessions enter the
global grant park (child owners are bounded pure data).

**Remaining staged work:** tracked wire downgrade continuity, activation tools,
audit/UI and their gates belong to the protocol/router/P3 owners, not P2c. The new
SDK tests use real Agent tools and PiSessionDriver sessions with scripted providers;
only admission/transport ports are controlled, not a full SpawnService/network test.

Tests: `tests/fabric/xs-{human-grant,sender-human-grant}.test.ts`,
`tests/web-hub/agent/{xs-state-bridge,commands-mention-session}.test.ts` plus the
unchanged default-on fabric/reply/mention/inbox/wake wiring regression suites;
`tests/runtime/human-runtime.test.ts` and
`tests/integration/fabric-xs-human-child-runtime.test.ts` pin P2c owner/lifecycle
and actual SDK child/blocking+background nested consumption.
P2 adds input/message_start/tool_call/tool_result registrations before the existing
B1 hook; P5 must refresh the declared B-tier governance trace, never A-tier goldens.

## P3b manual activation wiring

`createXsActivationPort` shares the sender's exact live source/epoch and current root
causal level. `XS_ACTIVATION_TOOL_NAMES` is a separate opt-in collision set; legacy
`XS_MAIN_TOOL_NAMES` stays unchanged. `/fabric status` adds an activation ready/off
line only while activation is on. Children/secure/off do not get a new tool.

Both browser transports implement `xsActivate` over the EXISTING authenticated
`/api/cmd` command.v1 path: `fabric __xs {action,messageId,activationKey?}`. No new
HTTP endpoint/op/CSRF exception. The internal handler validates bounded exact JSON,
checks current session and fabric allow/confirm/deny policy before looking up the
port, refuses Feishu, and directly calls the host port — never sends model input,
resends body, signs a human grant or records raw key args in command history.
Web omits target: the hub's already pinned relation selects it and revalidates
source/caps/key/current policy/delivery/claim/quotas. The model tool still requires
the original target in its unchanged schema. Query is strictly receipt-only; a miss
never activates. New activate thenables are bounded and timeout/rejection is cached
unknown/query-only, never retryable none; resume/read semantics remain unchanged.

P3b also makes the formerly dormant UI action surface safe: query/activate have
separate action-aware singleflights; server control-attempt outcomes are retained
in the existing bounded session/key-scoped seed store, separately from body phase,
revision and first wake-stop evidence. Unknown/accepted/already_active only offer
query, quota backoff comes only from the server, and stale/wrong-session/key results
are ignored. These local hints are non-persistent and NEVER authorization; refresh
still relies on the hub's message-level tombstone to prevent another charge/wake.
No lifecycle/status/reconnect event executes an action.

Receipt/activate audit uses the existing key whitelist/order, with no body/key/
controller token. The inherited pending audit op union is retained because P3 router
calls already require it. The declared B-tier trace update is only wake_session in
main-all-on and thread-main, counts +1; child/off/secure and phase2 traces unchanged.
Tests: `tests/web-hub/agent/xs-web-command.test.ts`, bridge/transport/UI xs suites,
`tests/integration/fabric-xs-activate-session.test.ts` (real command router + xs
relay/bridges/stacks, controlled HTTP-auth admission, both token/password adapters).

## P5 gates and acceptance (#14 closure)

Implementation state: P0–P4 are in; P5 adds **no feature**, only gates. Test knobs live in
`tests/integration/helpers/fabric-xs-process.ts` (debug only; the committed default is activation
ON on both sides — the helper hub now carries `crossSession.activation: true`, so the nine XsHarness
suites run against the new hub unchanged): `XW_ACTIVATION_OFF` (agent config off), `XW_HUB_ACTIVATION_OFF`
(hub key absent), `XW_STRIP_STATE` / `XW_HUB_STRIP_STATE` (wire-only removal of `xs.state.v1` and `xs.activate.v1`
from `hello` / `hello_ack`). Never commit a suite that pins them to dodge a failure.

- **C-X13** (`tests/conformance/fabric-xs.test.ts`): `delivered` comes from the synchronous leaf write, `started`
  only from a later model turn's `context` that exposes the delivered custom message with `details.xid` (pi fact the
  observer relies on); rows never carry body/sender session id; wake reasons are `[a-z0-9_:]{1,48}` tokens;
  details/token/xid/`activateFor` never reach the provider payload.
- **C-X14 / C-X14b**: real pi + Controller + progress bag + activation receiver: expired / unconfirmed ⇒ refused with
  zero provider work; one accepted activation ⇒ exactly one fixed body-free marker, B1 `authorized`, one provider
  request, the original body entry stays ONE; repeat ⇒ `already_active`, no second turn; key/token/session id absent
  from the payload; a host that loses the custom shape (no BAS) aborts the marker before the provider and the body is
  not re-sent as fallback.
- **Mixed versions** (`tests/integration/fabric-xs-activation-compat.test.ts`, real hub × 2 stacks): six old/new
  combinations (old/old, old hub×new agent, new hub×old agent, wire-hidden caps on either side, new/new). Old-side
  combinations keep the pre-feature `xs_deliver` key set/order and never invent `track`/`progress`; new/new exposes
  `track.messageId` and only appends keys.
- Registry/trace/corpus: `tests/fixtures/governance/activate-trace.json` and the setting-specs pin were refreshed by
  the packages that changed them (wake_session registration, input/tool_call wiring, the `activation.enabled` spec);
  P5 changes none. A-tier fixtures are untouched.

Accepted residuals: no cross-process exactly-once; hub/pi restart or a full relation bag ⇒ tracking `unavailable`
(never reconstructed from disk); activate never auto-runs and is quota-bound (`pair_wake_rate` ⇒ retryAfter, original
key only); the C-X conformance suites run on the current pi only — legacy pi 1.0.4/1.1.0 reruns need
`PI_TOOLKIT_LEGACY_PI_DIR` and were not run in this package.
