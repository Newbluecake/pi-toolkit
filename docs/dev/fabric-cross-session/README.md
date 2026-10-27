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
behaviour for fresh sessions is unchanged. Aliases deliberately do NOT transfer on `/new` (alias-plan 「不做」). `message_session` omits wake = deliver-only; `wake:true` alone may
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

**Force takeover + cwd-basename auto alias (#72, `alias-force-default-plan.md` r2 — the 「用户拍板」 and 「r2 修订对照表」 at its end override the
body; packages AF0–AF4/AFU/AFW/AF6, reports `AF*-report.md`; AF7 `/new` handoff is NOT in yet)**: everything above stays; this layer is additive and
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
  the decided mark (both mark decided; the hub enforces the real mode); `intent:"handoff"` answers `E_XS_BAD_FRAME` until AF7.

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
