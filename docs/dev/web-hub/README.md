# Web Hub · 开发者要点（索引）

> 何时读：改动 `src/web-hub/**`、`webHub.*` 设置键、hub 协议/wire/cap、web UI 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`arch.md`、`plan.md`、`vue-plan.md`、`control-plan.md`、`lan-plan.md`、`lan-security-plan.md`、`bash-jobs-panel-plan.md`、`archive-report.md`

子 README 索引（按需另读）：[spawn / restore / relaunch / delete / 会话历史](../web-hub-spawn/README.md) · [内容预览 / HTML 预览](../web-hub-preview/README.md) · [worktree diff / graph](../worktree-diff/README.md) · [本地服务代理 / 链接预览](../web-hub-proxy/README.md) · [Feishu bot / xs mirror](../feishu-bot/README.md) · [fabric 频道/别名 UI](../fabric-cross-session/README.md)

目录：

- 概述与 P2 control-plane
- Web resume (resume.v1)
- UI serving 与 LAN access
- LAN security
- Worktree panel
- Bash-jobs panel
- Fleet drawer archive
- Cache keepalive panel
- Avatar
- Privacy lock
- Session switching
- prompt-gate.ts
- Slash-arg completion
- Command history
- Peer-bump conformance premises (cmd-history)

## 概述与 P2 control-plane

`src/web-hub/` — browser UI over a per-machine hub daemon (`webHub.enabled`, default off ⇒ zero wiring,
zero network, zero disk; post-guard, child sessions inert). `protocol/` (frame/key/path contracts shared by
both sides, incl. `ui-manifest.ts`'s `UiBuildInfo`/`parseUiBuildInfo`/`isAllowedUiPath` — the build-time
manifest schema both the Vite plugin and the hub-side verifier trust), `hub/` (singleton daemon: composition
root `hub.ts`, process entry `main.ts` run through pi's bundled jiti-cli, HTTP/SSE/auth/static; never imports
pi), `agent/` (pi-side client `wireWebHub`: process-level connection on a `Symbol.for` global, reused across
/new·/resume·/fork, handed over on /reload), `ui/` (the Vue 3 SFC frontend source, built by `npm run
build:web` into `dist/web-hub-ui/` — not checked in; `ui/src/logic/` holds the pure, DOM-free logic ported
from the pre-Vue frontend, imported through the `@logic` alias). The hub's own long-lived processes set
ONLY their kernel comm (`hub/comm.ts` — hub `pi-webhub`, auth/session DB child `pi-webhub-auth`, spawn
reaper `pi-webhub-reap`; never `process.title`): `/proc/<pid>/cmdline` is deliberately untouched — the
agent-side hub identity check and reaper-by-cmdline test location depend on it. Wired at the end of `src/index.ts` after
`wireDeferredReload`. P1 is read-only; **P2 (control-plane, #32, `docs/dev/web-hub/control-plan.md`)** layers a write
path on top — a single `cmd`/`cmd_result`/`cmd_late` channel (`op: prompt|abort|steer_subagent|abort_subagent|
command|switch_session`, idempotent by cmdId, a process-level command ledger in `src/web-hub/agent/index.ts`
outlives any single hub restart), an ask_user dual-channel bridge (`src/ask-user/remote.ts`'s port +
`src/web-hub/agent/dialogs.ts`, TUI and web race for the same dialog, loser gets a 409/`dialog_closed`), web-
origin slash commands with pi-toolkit's own commands captured and echoed back to the browser
(`wrapCommandApi`, `captured:true` + the output text; a third-party extension's raw-registered command is
never captured, `captured:false`, terminal-only), version-supersede/`/webhub stop`/`start`/`token rotate`
admin flows, and a `hub-state-banner` covering pending/blocked/restarting/stopping.

## Web resume (resume.v1)

**Web resume
(`resume.v1`, web-resume plan §2.4/§2.5/§2.7)**: `status.features` carries `resume.v1` iff control +
`webCommands` are on, the session is persisted and `webCommandPolicy.resume` isn't `confirm`/`deny`
(old agents never emit it ⇒ old UIs stay byte-identical); the advertised bare `resume` stays deny,
`resume __list <json>`/`__pick <json>` are the allowed internal forms (`resume-recent` always deny).
`__list` is the ONE thenable builtin (read-only race ≤6 s, `resume:scanning` retryable, ledger strips
`data.sessions`) and never calls pi's `SessionManager.list` — a bounded head/tail reader (§2.2 core,
O_NOFOLLOW/O_NONBLOCK open discipline) builds a generation (≤5 000 files / ≤5 s / ≤64 MiB / ≤2 000
rows / page ≤100 / ≤32 KiB, gen-bound cursor with `reset:true`, cwd-matched, duplicate header ids
omitted) retaining no message text. `__pick` is a fully SYNC decision: busy/pending ⇒ `resume:busy`
(D4 browse-only), a one-per-process exec claim SHARED with `/new` (`exec:in-flight`), then a ticket
bound to source session + target file identity, re-entered via `/webhub __exec resume <nonce>`; every
authoritative check (source unchanged, idle, deadline, O_NOFOLLOW dev/ino, header id/cwd/child,
provenance, not-current, D5-a: target written <30 s or changed since listed ⇒ `E_CONFIRM_REQUIRED
resume:active-elsewhere` unless `confirm`) re-runs synchronously at the execution point right before
`ctx.switchSession`; a revoked/expired ticket can never switch, late failures are `retryable:false`,
exactly one `cmd_late` per armed ticket, and `switchInFlight` refuses web prompts across the window.
UI: header 「恢复」 button next to 「清空」 (D7) + dock/input interception, dialog lazy-loaded.
Disclosed residual windows: W1 — between the execution-point checks and pi's `SessionManager.open`
lie the async `session_before_switch` handlers; a swap there is only detected afterwards
(`resume:mismatch`, effect unknown), a swap swapped back is undetectable. W2 — pi never locks
session files; an idle session open in a terminal not connected to web is undetectable (D5-a's
size/mtime are activity signals, not occupancy proof). Managed rpc sessions use the same path.
Design: `docs/dev/web-hub/{arch,plan,vue-plan,control-plan}.md`, `docs/dev/web-resume/plan.md`.

## UI serving 与 LAN access

**UI serving
(todo #26 vue-plan.md v2.1 §2.1, P5b)**: `hub/static.ts`'s `createUiServer` resolves a verified root —
package-bundled `dist/web-hub-ui/` first, else the external, version-pinned
`~/.pi/agent/web-hub-ui/<hubVersion>/` (`hub/ui-root.ts`'s `resolveUiRoot`/`verifyUiRoot`: symlink/owner/mode/
manifest-hash checks, TOCTOU-safe — bytes are read and hashed once at resolve time, served purely from
memory afterward) — and serves an HTTP-200 "not built yet" placeholder (`hub/unbuilt.ts`) when neither
candidate verifies, with install instructions gated by auth mode (token/loopback sees absolute paths and
rejection reasons; password/LAN sees neither). `agent/ui-status.ts` renders the same status for
`/webhub status`/`open`, reading `hub.json`'s `ui` field (`hub-json.ts`'s `patchUi`, mirroring `patchLan`).
The legacy zero-build `src/web-hub/web/` frontend (`no-innerhtml`-enforced, hand-written JS) was deleted in
this same switch — its pure logic lives on under `ui/src/logic/`. LAN access (S1,
`webHub.lan.enabled`, default off): username/password auth over plain HTTP on `0.0.0.0:<webHub.lan.port>`,
host allow-list + optional trusted-reverse-proxy origin (`webHub.lan.{trustProxyFrom,externalOrigins}`) for
HTTPS termination, SQLite-backed sessions in a SIGKILL-able child process, and `/webhub passwd|unlock|restart`
— design: `docs/dev/web-hub/lan-plan.md`.

## LAN security

**LAN security (lan-security plan r2)**: `hub/client-allow.ts` supplies ONE hub-owned client-IP allow guard
(`webHub.lan.allowClients` IP/CIDR csv; empty = unrestricted, all-invalid = deny-all) to LAN HTTP and every proxy listener (explicit
inert guard without LAN; a missing configured guard is never a fallback). `hub/lan-login.ts` owns the sole checked
session completion (`complete()` — the only `createSessionChecked` caller), with epoch/factor-generation CAS and
bounded cancellation/late-insert cleanup for password/TOTP/recovery/Feishu approval. Enrolled accounts require a
second factor from a new IP (30 d history **per account**, capped at 256 IPs/user; unusable trusted-proxy XFF stays
new); first enrollment clears only that account's trust. Kicking sessions (single / others) atomically clears that
user's trust for the kicked sessions' created/last IPs, EXCEPT the revoker's current IP (shared-IP retention is audited);
uncertain revokes attempt bounded best-effort trust cleanup, while self-logout keeps trust. Pending challenges are never
sessions. `hub/lan-sessions.ts` lists/revokes ≤32 LAN sessions with one 10 s revoke deadline and the shared
auth-revoke fan-out to proxy HTTP+WS, HTML caps and SSE; nullable `session_meta.method` migrates additively (legacy
reads as password) and the settings card is cap+password gated, disabling all actions during a revoke.
`/webhub user list|delete <username>` is trusted-local TUI-only too: list shows primary/2FA/live sessions, delete needs
an explicit TUI confirmation, refuses primary/last-user, CASCADE-deletes account data and revokes that user's live
cookie/SSE/proxy/HTML sessions. `/webhub passwd` confirms before creating an extra independent account.
`/webhub 2fa` still targets only the primary (lowest-id) account and is trusted-local TUI-only (masked setup, bounded
secret widgets, independent of web command policy; web prompt-op auth-admin text, including `/webhub user`, is refused too); admin repair preserves B's actual db-invalid detail. Feishu approval
uses the live owner, sibling nonces/gen/tenant binding and a stable runtime delegate; security alerts share
notify's budget and are settings-gated. `lan.2fa.v1` / `lan.sessions.v1` are advertised on both surfaces iff
`config.lan` is configured (not the assembled store state — the 2fa cap is needed for repair while the store is
off); fresh password index bytes carry only a public `data-lan-caps` bootstrap for the login UI (off/token bytes
unchanged); G's approval polling survives method switches and is cancelled on abandonment. Gates: fake+SQLite
contracts, real revoke consumers, real-socket Q15 enrollment, LAN-P5 real child hub × SQLite × fake Feishu callback
integration, `tests/web-hub/http/lan-rollout.test.ts` (startHub-level activation). Design / evidence:
`docs/dev/web-hub/{lan-security-plan,lan-security-P0-surfaces,lan-security-DEFG-integration-report}.md`.

## Worktree panel

**Worktree panel (worktree-web plan v1.1)**: `agent/worktree-sampler.ts` samples the session cwd's repo through
`src/git/` (local commands only — never fetch; hard per-scan deadline, single-flight, zombie guard across
stop/start, all timers unref'd, inert in print mode) and rides the optional `StatusInfo.worktrees` slot
(append-only, open-but-bounded schema, `agent/worktrees.ts` byte-budgeted projection, fingerprint-gated
publish) to a read-only `WorktreePanel` on the web detail header (absolute paths shown, 1 worktree included).
Design: `docs/dev/worktree-web/plan.md`.

## Bash-jobs panel

**Bash-jobs panel (bash-jobs-panel plan v3/v4)**: `agent/bash-jobs-sampler.ts` samples the main session's
background bash jobs (`BashJobManager`, source-generation pinned, single-flight with per-job deadlines, all
timers unref'd) and `agent/bash-jobs.ts` projects to the optional `StatusInfo.bashJobs` slot (D1 row
selection, D6 24 KiB budget with a five-step reduction ladder, fingerprint-gated publish, hot path zero I/O)
to a read-only `BashJobsPanel` on the web detail header. Command + log tail are kept per the U1 sole-LAN-user
ruling — `agent/redact.ts`'s secret scrubbing is HYGIENE ONLY, never a security boundary. Design:
`docs/dev/web-hub/bash-jobs-panel-plan.md`.

## Fleet drawer archive

**Fleet drawer archive (archive-report.md)**: `src/archive/` (per-session `ArchiveControl` built by
`buildSessionStack`, `webHub.enabled`-gated, state in the `subagent:archive` session entry, full-snapshot-per-change,
60s unref'd auto-sweep under `webHub.archiveAfterMin` — default 30, 0 = off, agent-side only ⇒ `/reload` suffices)
hides TERMINAL run rows / bash rows from the fleet drawer and the TUI fleet widget (display only — never
get_run_result/`/agent status`/notifications). Web ops ride the `archive` cmd op (`{kind,target,set}`, hub
`parseCmdBody` whitelist ⇒ needs one `/webhub restart`); the set rides the open `StatusInfo.archived` slot
(no proto bump/caps, absent when empty); user-unarchived ids are `held` and never re-auto-archived. Report:
`docs/dev/web-hub/archive-report.md`.

**#59 count + age gates**: `webHub.archiveKeepRuns` defaults to 6 and
`webHub.archiveKeepBash` to 5 (non-negative integers; `0` = no count gate, legacy
age-only behavior). Each sweep counts unarchived TERMINAL items per kind, including
held items; running and already archived items do not count. Only when a kind exceeds
its keep count does it archive eligible items oldest-settled-first, stopping at the
keep count or when no age-eligible non-held items remain. Held items never auto-archive.
`archiveAfterMin=0` still disables the timer; manual archive remains available.
`src/archive/sweep.ts` performs pure selection; control adapts snapshots and batch-commits
once. All three settings are agent-only, non-live: `/reload` suffices, no hub restart.
Evidence: `docs/dev/web-hub/archive-threshold-report.md`.

## Cache keepalive panel

**Cache keepalive panel (cache-ttl-keepalive webhub plan)**: `agent/cache-keepalive.ts` projects the keepalive report to the
optional `StatusInfo.cacheKeepalive` slot (append-only, 1Hz fingerprint-gated publish, wire never carries `armed`, 8 KiB
budget) for a read-only, lazy-loaded `CacheKeepalivePanel` on the web detail header. Design:
`docs/dev/cache-ttl-keepalive/webhub-plan.md`.

## Avatar

**Avatar (web-hub-avatar plan v2.1, `webHub.avatar`, default on)**: the hub stores one validated PNG at
`hub/avatar/{fs,store,validate,routes}.ts`, assembles it through `hub.ts`, and dispatches the three
`/api/avatar*` endpoints on both authenticated listeners via `hub/http.ts`; `avatar.v1` is advertised only
when the `HubConfig.avatar` key is present (the agent receives but does not add a cap). `control:false` or
the setting off omits that key and leaves the hub byte-identical. Atomic replacement, strict PNG validation,
bounded IO/concurrency, CSRF/auth/rate limits, full-digest ETags, generation-ordered SSE updates, and
exactly-once audit records are invariants; gates are `tests/web-hub/http/{api-avatar,lan-avatar}.test.ts`,
`tests/web-hub/hub/{caps-coexist,deadline-nesting}.test.ts`, and the real-device acceptance in the plan.

## Privacy lock

**Privacy lock (web-hub-privacy plan v2.1, `webHub.privacy`, default on)**: per-sessionId view-time
re-verification against shoulder-surfing — marks live in `<stateDir>/privacy.json`
(`hub/privacy/{store,routes}.ts`, 0600 atomic writes, E_LIMIT over 4096, corrupt ⇒ `.bak` + degraded),
`POST /api/privacy/{lock,verify}` (verify is LAN-only; unlock on LAN requires the inline password, on
loopback it degrades honestly to click-to-confirm), the `privacy` SSE frame is direct-send only (never in
the replay ring, ordered before `agents`), and hub-initiated forks inherit the mark BEFORE spawn. The UI
locks only on the desktop band (≥768px; the mobile band ignores the frames entirely), relocks four ways
(route change / idle timeout / manual / tab hidden), and an old hub without `privacy.v1` leaves the UI
byte-identical. `/webhub status` renders the on/off + degraded + loopback-difference lines off
`hub.json.privacy` (`agent/privacy-status.ts`). Design: `docs/dev/web-hub-privacy/plan.md`.

## Session switching

**Session switching (web-hub-session-switch plan, E1+D2)**: the browser UI keeps the last K sessions subscribed on
the hub (main-subscription LRU keep-alive; browser pref `pwh_keepalive`, default 3, `1` = legacy single-slot, pure
planner `ui/src/logic/sessionKeepAlive.ts`; `useHub`'s library default stays 1 — only App.vue lifts it to the product
default), owns a main-subscription ledger with same-key op serialization and hello-time op voiding
(`useHub.ts`, K=1 transport order pinned by `tests/fixtures/web-hub-ui/keepalive-legacy-golden.json`), guards in-flight
snapshots with the optional `HistoryPayload.sessionId` (agent backfills `snapshot_reply.sessionId`; missing on either
side passes through — compat window), and remembers per-agentKey transcript scroll position on switch. Design:
`docs/dev/web-hub-session-switch/plan.md`.

## prompt-gate.ts

**`prompt-gate.ts`** (topic-switch plan P4, D2):
`PromptGatePort`/`WebPromptRelease`, a late-bound port (`WebHubDeps.promptGate`, assigned by
`src/index.ts`'s `promptGateRef.current = …` — the sole D2 flip point) that `commands.ts`'s
`handlePrompt` consults synchronously, idle-only, before its native dispatch; claiming replies
immediately (no dispatch) and hands ownership to `release.current()`/`release.elsewhere()`.

## Slash-arg completion

**Slash-arg completion** (`docs/dev/web-hub-slash-args/plan.md`): the Composer's `/name␠`
argument hints + dynamic completion. Cap `cmd.args.v1` gates everything (`CommandInfoWire.args`,
the `complete_req`/`complete_reply` frame pair, `POST /api/command/complete`); PROTO is NOT
bumped (r1 评审 #2 — new optional frames only, the fsb/lan/tfa 先例). `webHub.commandComplete`
`"all"|"toolkit"|"off"` (default `all`, NON-live: `/reload` + `/webhub restart`; off ⇒ no
service, no TUI wrapper, no cap, `HubConfig.cmdArgs` key absent ⇒ hub builds no route and the
agent's slot-flush strips `args` for cap-less hubs). Sources: S-own (toolkit commands —
`wrapCommandApi` records each raw `getArgumentCompletions`; new toolkit completers must be
reviewed pure functions) and S-tui (`mode:"tui"` + `all` only — a transparent
`addAutocompleteProvider` passthrough capturing pi's base provider for third-party/builtin
commands; RPC/print never gets it). Deny commands never complete and deny ITEMS are dropped
per-item (the execution path's own tables); budgets: agent 1.5s hard timeout + in-flight ≤2
(a SYNCHRONOUS third-party hang blocks the process — accepted residual, r1 #4), hub 4s route
deadline / in-flight ≤8 global ≤3 per principal / independent limiter, browser disconnect ⇒
slot released + audit `aborted` (r1 #6). Enter applies a candidate ONLY after explicit ↑↓
navigation (D2 拍板). `/webhub status` prints `cmd-args: <mode> · hub-cap on|off|n/a`
(`agent/cmd-args-status.ts`). Conformance: `tests/conformance/slash-args.test.ts` (real pi
rpc child + real InteractiveMode) before any pi peer bump.

## Command history

**Command history** (`docs/dev/web-hub-cmd-history/plan.md` v2, packages P0/H1/A1/U1/I1):
command output becomes `subagent:cmd` custom entries (`protocol/cmd-record.ts`, freeze F1 —
via `pi.appendEntry` only, never a TUI renderer, never LLM context; Q1 原文落盘，Q5 `/webhub`
敏感子命令只记头部，editor 预填/input 值不落盘) written by the agent-side recorder
(`agent/command-record.ts`; `webHub.cmdHistory=false` ⇒ no recorder, no feature token,
byte-identical legacy) at the handler's REAL execution point — `wrapCommandApi`'s optional 5th
param feeds both the claimed (web) and observed (TUI, pure tee — terminal display never
changes) modes plus ctx leave interception (`commitBeforeLeave` before
newSession/fork/switchSession/reload, one corrective `end{failed}` if cancelled);
`builtin-bridge.ts` records builtins at their settlement points (intent ledger D7 recovers the
frame cmdId for agent_settled-deferred dispatches — G7) and stamps the open `history` field on
sync/late replies. The hub statically advertises `cmd.history.v1` and projects entries as
custom tombstones + open `cmd` field (`protocol/keys.ts`); `runTail`'s ENOENT-only
`branch_req` fallback serves records live before the first conversation flushes the file
(§4.10 — a GENERAL hub fix, deliberately outside the switch-off promise). UI: purple cards
(`TxCommand.vue`), gated `hubCap ∧ status.features`, placeholder state machine with 60 s
degrade; `historyMode` off ⇒ DOM byte-identical. `/webhub status` adds the `cmd-history:` line
(`agent/cmd-history-status.ts`). secure LOCKED sessions still execute commands but skip every
write (guards' read-only `recheckForWrite`, M1). Residual: plaintext command output (incl.
live credentials like `?token=` take tokens, §5.3) persists in session files by user ruling —
hub.log/agent logs must never carry output bodies (gated by tests). Integration:
`tests/integration/web-hub-cmd-history.test.ts` (real hub child × real stack); conformance
`tests/conformance/cmd-history.test.ts` (the six pi premises — custom-out-of-context,
no-renderer, streaming/settled-deferral timing, `expandPromptTemplates:false`,
no-file-before-first-message, newSession cancelled/stale-ctx) before any pi peer bump;
real-device checklist `docs/dev/web-hub-cmd-history/acceptance.md`.

## Peer-bump conformance premises (cmd-history)

**Also run `tests/conformance/cmd-history.test.ts`** (web-hub-cmd-history I1):
it pins the six pi premises the command-history feature stands on — custom `appendEntry` entries
never reach `buildSessionContext`/the provider payload/the system prompt; a custom entry with
no renderer renders nothing in InteractiveMode; extension commands run immediately while
streaming and defer ONLY inside the `_isEmittingAgentSettled` window (deferred actions in
order); `sendUserMessage` never executes slash text (`expandPromptTemplates:false` default);
`appendEntry` before the first conversation does not create the session file; `ctx.newSession()`
returns `{cancelled}` and every read of a replaced ctx throws the stale error.
