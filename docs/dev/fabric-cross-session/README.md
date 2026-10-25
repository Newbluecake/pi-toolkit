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
(`wakeExclusion`: consult fork, readonly domain, caller-owned incl. workflow children, external/droid) + worktree gone /
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
wake is off), `get_subagent_result` adds `Woken by <ref> (level n) · +N inbox messages` / `Resumed with +N inbox messages`.
Accepted limitation: after a real `/reload` the old stack's `onReaped` closure is dead, so a reservation whose run
was still closing is re-judged by the NEW stack's 60 s fresh-`getBranch()` fallback (bounded, never unbounded
waiting). Cross-session wake (C1, RootWakeController, mutation fence) is phase 2 — plan §12 is an archive that must be
re-reviewed first. Gates: `tests/integration/fabric-wake*.test.ts`, conformance C-P1…C-P5
(`tests/conformance/fabric-wake.test.ts`; run before any pi peer bump together with consult-preserve), state-machine
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
membership, even with autoJoin. `message_session` omits wake = deliver-only; `wake:true` alone may
start a turn through `RootWakeController` (no steer), gated by `fabric.wake.enabled`, causal level,
capability, goal and quotas. Unknown host capability downgrades to deliver-only until real runtime
shape evidence; root deadline `fabric.wake.rootRunMaxS` (default 900s) starts at dispatch, including
pre-start compaction. Token authorization and dedup survive /reload; marked unauthorized/expired
triggers abort before their first provider request (B1); human handover only after proven own-run
start. Mutation fences (compaction/tree/switch/web_exec/topic_switch) reject ALL ingress; goal
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
and a local Anthropic stub, alongside fabric-wake C-P1–C-P5 and consult-preserve C1–C7; C-X7 records
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
cross-session messages are user-visible (RX7 — do not hard-code the old R4 "display only"). Settings
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
update. AgentCard chip order `kind → state → xs badge → @alias → #channels → unread` (alias cut at 8 grapheme clusters, title = full);
DetailHeader shows `@alias` opening the dialog; the `@` panel matches/shows alias but still inserts `session:<ref>`; `logic/xsMessage.ts` reads
` alias="…"` from the first line independently of field order. Design: `docs/dev/fabric-cross-session/alias-plan.md` §7.
