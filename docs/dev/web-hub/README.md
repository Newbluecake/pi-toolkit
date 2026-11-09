# Web Hub · 开发者要点（索引）

> 何时读：改动 `src/web-hub/**`、`webHub.*` 设置键、hub 协议/wire/cap、web UI 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`arch.md`、`plan.md`、`vue-plan.md`、`control-plan.md`、`lan-plan.md`、`lan-security-plan.md`、`bash-jobs-panel-plan.md`、`archive-report.md`、`fleet-fill-budget.md`（抽屉 agents/bash 按高度对半分配）

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
- Unknown slash text（#40）
- Command history
- Peer-bump conformance premises (cmd-history)
- Registry epoch 刷新与 epoch.up.v1（#23）
- Outdated reload 状态机（#23）
- Reload 结果回传 `status.reload`（#30）
- 助手回复 tokens/s（task58）

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

**#88 subscribe 定向补发 ctl/status**（36ca30e3 的 hub 侧后续）：`ctl`/`status` 槽是纯广播（无 per-agent 快照、
不进订阅回放），断线重连/resync 后队列条会丢推进信息。`hub/http.ts` 的 `runSnapshot` 在 `history` 之后、
缓冲帧之前，向该订阅者**定向**补发：registry 保留的最近 `status`（复用广播帧形状，重建 UI 侧
queue/held 镜像与空缓冲清扫）+ 路由层 `ctlCache`（`fleetCache` 同构，随广播同步更新、dropAgent 清除）
里**仍活跃**的 ctl 条目（`CTL_ACTIVE_STATES`：dispatched/observed/started/queued/consumed/running/held；
终态不补 —— UI 侧已有自愈）。定向 send 不入 ring、无新 timer/模块态；同 tick 同步读保证补发不会
旧于已收帧、也不会乱于后续实时帧。

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

**Credential hardening, read side (#66 P1, `docs/dev/web-hub-auth-hardening/plan.md`)**: `hub/hardening.ts` (zero imports)
holds the phase gate — `HARDENING_PHASE=1` this release (reads only; every write stays at scrypt 2^15). The maintenance
`open-check-migrate` stamps `meta.hardening_reader={"v":1,"since":…}` (older v only raised, `since` never moves), decides
`writerActive` ONCE (phase 2 ∧ marker ≥14 d old) and returns it in `reply.hardening{readerSince,writerActive,maxKdf}`;
`lan-store` turns that into `CreateLanStoreResult.hardening` (+ `verifyTarget = max(write target, strongest stored)`) and
no longer drops the open check's `warning` (TRUNCATE failure ⇒ `truncateFailed`). `validateKdfParams` accepts
N∈[2^14,2^17], 128·N·r ≤ 128 MiB. `createKdf` frees a pool slot only when scrypt PHYSICALLY calls back (an aborted caller
still rejects at once), so physical concurrency stays ≤2 (≈258 MiB worst case at 2^17); `runPadded` runs real +
compensation scrypt inside ONE slot. `kdfMatches` times every path (unknown/corrupt ⇒ dummy, cheaper valid record ⇒ one
padded run) against `kdfPolicy.verifyTarget` (absent ⇒ `KDF_LEGACY`, i.e. v0.10 behaviour; tests inject it via
`lan-helpers.ts`). `hub.ts` counts both `run` and `runPadded` in `kdfInflight` so the quiet-replace path cannot cut across
a login. Residual: compensation scrypt is a smaller-memory computation, so wall-clock can differ by ~10–30 % (A2 live check).

**Initial-password wipe (#66 P5, plan §4.5/D4)**: the auto-generated initial account stays (Q14/L6), but its plaintext
lives only until the FIRST successful sign-in. `markInitialLogin` is ONE statement (`initial_login_at/ip =
COALESCE(…)`, `initial_password = NULL … WHERE username=? AND initial_password IS NOT NULL`, no epoch condition) and
returns `{cleared}`; `lan-login.complete()` calls it best-effort (≤2 s, failure ⇒ `initial-password-clear-failed` warn,
the login still succeeds and the next one retries) and, when `cleared`, asks `store.requestCheckpointTruncate()` — a
coalesced maintenance `checkpoint-truncate` (now reporting `checkpoint-truncate-busy` when a reader blocked it) whose
failure raises the store warning `initial-password-residue` into `LanStatus.warnings` (`store.warnings()` /
`onWarningsChanged`, in-memory ⇒ gone after a restart whose open check re-truncates). "Initial password still in use"
is now `initial_created_at IS NOT NULL OR initial_password IS NOT NULL` for the login response, `getUserSummary` and
`initialInfo`; `initialInfo` reports `initialLogin` only while in use and `initialPassword` only while the plaintext is
there, so the TUI shows «初始密码已于 <时间> 被 <ip> 用于登录，明文已从 hub.db 清除；该账号仍在使用初始密码…» plus the usual change reminder. No wire change. Residual: backups taken
before the wipe still hold the plaintext; an open-check TRUNCATE failure alone does not raise the residue warning.

**TOTP at-rest encryption (#66 P6, plan §4.2 / r3)**: the reader accepts legacy 20B secrets and version-1 53B
AES-256-GCM envelopes (`version | kid(4) | nonce(12) | ciphertext(20) | tag(16)`, AAD binds `user_id`). The 32B
machine key is `<home>/.local/state/pi-webhub/totp.key`, never under `.pi/agent`, and never derived from
`XDG_STATE_HOME`. `HubPaths.totpKeyFile` exposes this path; the existing assembly only passes `dbFile`, so
`lan-store` extracts the **same home prefix** from the canonical `/.pi/agent/web-hub/hub.db` suffix (custom DB
paths need the explicit test seam). Only the children read key bytes; IPC/env carry a path, not a key. This protects
against a DB-only or `.pi/agent`-only leak, **not a whole-home backup or same-uid/root access**. The hub/key stay outside
secure vaults (accepted secure R12); no settings path or D8 override is added, and LAN-off creates no key/store.

The maintenance child is the **sole** `writerActive` judge. `lan-store` forwards its frozen verdict through
`DbClientDeps.childEnv` as `PI_WEBHUB_TOTP_WRITE=1|0` plus `PI_WEBHUB_TOTP_KEY`; query respawns reuse a snapshot and
never re-evaluate phase/soak. **This release remains `HARDENING_PHASE=1`: no key creation, no migration, enrollment
still writes 20B**. Phase 2 additionally requires the reader marker to be ≥14 days old at the next hub startup.
When active, only maintenance can create/replace a key, and **only with `rows53=0`**: validate 0700 owned directory,
`wx` 0600 temp → write/fsync/close → rename → directory fsync → readback. Unsupported directory fsync (`EINVAL` /
`EISDIR`) is tolerated; other failures warn, clean the temp and skip migration. File reads use lstat, owned regular
32B checks and NOFOLLOW/NONBLOCK open + fstat. Wide modes are repaired with fixed-code warnings. Invalid files
(including symlinks/foreign owners/wrong sizes) may be replaced only without encrypted rows; rename replaces the
symlink itself, not its target. A nonempty-directory target or foreign-owned key directory fails creation safely.

`rows53=0` always means `none`, regardless of stale `meta.totp_key_fp`; adopting an existing or newly created key
**overwrites fp**. With encrypted rows, absent/unreadable/noncompliant key ⇒ `key-missing`, valid key but missing/wrong
fp ⇒ `key-mismatch`; neither is schema inconsistency or closes LAN. Internal `totpUsable:false` removes TOTP from
new challenges, leaving recovery and live Feishu usable. An undecryptable row returns `unavailable`: HTTP 503 `E_DB`,
both verification budgets refunded, no limiter failure. Bad per-row kid/tag affects only that row. Reset and recovery
bypass decryption; repair clears 2FA tables **and fp in one transaction**, retaining the key file. Public strict status
schemas/PROTO stay unchanged; warnings use append-only `totp-key-missing`, `totp-key-mismatch`, `totp-plaintext-residue`.
Warnings are startup snapshots (restart after recovery to refresh). Recovery codes remain `sha256(salt || code)` and
**are not bound to this key**.

Active-writer enrollment rereads the file at commit inside its transaction: no other 53B rows ⇒ overwrite fp and
encrypt (or warn/fall back to 20B if no compliant key); other 53B rows ⇒ require the existing fp to match, else
`E_TOTP_KEY`. Queries never build keys. Verification uses the startup-cached key, so deleting the file only affects
verification after a restart. Migration CAS-replaces 20B rows without bumping `factor_gen`, atomically with fp, then
immediately checkpoint-TRUNCATEs; failures/busy raise `totp-plaintext-residue` if rows migrated and retry on next open.
Before TRUNCATE the WAL may retain plaintext; **pre-migration backups retain plaintext**, and released filesystem blocks
are outside scope. Crash after key creation reuses it next open; crash after COMMIT replays only TRUNCATE.

Recovery: restore DB + matching key ⇒ usable; DB-only restore/new machine ⇒ missing; unpaired key ⇒ mismatch. Use
recovery/Feishu, then local `/webhub 2fa reset --confirm` (primary) or `/webhub 2fa repair --confirm` (all accounts),
`/webhub restart`, and enroll again. **Online rotation is not implemented this period**: for suspected leakage reset
all TOTP accounts (or repair), remove `totp.key`, restart and re-enroll (new key creation requires phase 2 + soak).
A rollback to phase 1 can read 53B and enrolls 20B; rollback to ≤v0.10.x rejects 53B and closes LAN — reset before
rollback, or use the old version's explicit repair (clears all 2FA). Gate evidence: `totp-key.test.ts` fs/crypto fault
matrix + real child crash/recovery/HTTP tests, `db-client.test.ts` env snapshots across restart, and the shared contract
run against fake, plaintext SQLite and encrypted SQLite.

## Worktree panel

**Worktree panel (worktree-web plan v1.1)**: `agent/worktree-sampler.ts` samples the session cwd's repo through
`src/git/` (local commands only — never fetch; hard per-scan deadline, single-flight, zombie guard across
stop/start, all timers unref'd, inert in print mode) and rides the optional `StatusInfo.worktrees` slot
(append-only, open-but-bounded schema, `agent/worktrees.ts` byte-budgeted projection, fingerprint-gated
publish) to a read-only `WorktreePanel` on the web detail header (absolute paths shown, 1 worktree included).
Design: `docs/dev/worktree-web/plan.md`.

## Bash-jobs panel

The activity drawer remembers the selected agent/bash panel separately from its docked open state.
If the saved panel has no content at mount, it falls back temporarily and restores when content
arrives only until the user acts: a panel toggle, drawer close, or activation of a drawer control
(including run selection and tree folds) cancels that pending restore. Passive data updates do not.

**Bash-jobs panel (bash-jobs-panel plan v3/v4)**: `agent/bash-jobs-sampler.ts` samples the main session's
background bash jobs (`BashJobManager`, source-generation pinned, single-flight with per-job deadlines, all
timers unref'd) and `agent/bash-jobs.ts` projects to the optional `StatusInfo.bashJobs` slot (D1 row
selection, D6 24 KiB budget with a five-step reduction ladder, fingerprint-gated publish, hot path zero I/O)
to a read-only `BashJobsPanel` on the web detail header. Command + log tail are kept per the U1 sole-LAN-user
ruling — `agent/redact.ts`'s secret scrubbing is HYGIENE ONLY, never a security boundary. Design:
`docs/dev/web-hub/bash-jobs-panel-plan.md`.

## Activity rail（#41/#42）

Two independent right-edge buttons now expose agent and background-bash activity: each has its
own running count (bash includes staged), `99+` visual cap with the full accessible count, and
no-record classes render nothing. The user explicitly rejected a white card / square outlined
rail: only bot/terminal icons and corner badges are visible, with transparent 44px hit targets.
Active icons get a soft **circular radial** opacity-only halo (3.2s); idle is still; reduced-motion
keeps a static halo and badge. Keyboard focus-visible is circular, not a persistent square frame.

**Phone exception (#48, ≤767px only)**: both icons share one compact content-sized rounded
`--c-surface` backdrop with a themed border and soft shadow, so dark/light transcript text
cannot visually merge into the controls. A single category automatically shrinks to one button;
no records still render nothing. Individual 44px buttons remain transparent; badges and circular
halos are not clipped. This is an absolute overlay, never a reserved column. At ≥768px the rail
remains transparent, borderless and shadowless, regardless of coarse/fine pointer capability.

`AgentDetail` owns `useActivityRail` and mounts the rail beside `FleetDrawer` at the existing
relative `.detail-split` anchor. The rail is click-driven: opening the drawer keeps it expanded,
including when the pointer leaves. There is no pin control, hover preview or timed auto-close.
Close only with `×`, `Esc`, another click on the active rail icon, or an outside click in overlay
mode. Clicking the other rail icon switches the panel without closing the drawer.

Viewport layout rules are unchanged: ≥1280 docked (grid shrinks main), 768–1279 overlay,
≤767 fullscreen. `useFleetDrawerOpen` exclusively owns `webhub.fleetDrawer.open`: docked-mode
open/close state is persisted there, with the existing default-open and breakpoint-reset behavior;
no new key/wire/setting. `data-docked-open` alone drives grid allocation. Production always
passes an explicit `panel`, while undefined panel is legacy combined-render/fill-budget compatibility.

Run subscribe/unsubscribe still belongs solely to useHub. Only keyboard Enter/Space opens focus
close; close/Escape return to the triggering type (never first aria-controls), while outside close
does not grab focus. Fullscreen restores background inert values on close/resize/unmount and traps
Tab; input/composition Escape guards remain.

Budget measurement resets on panel/effective-mode/open and ResizeObserver updates; explicit
panels give the other class zero budget counts, undefined preserves the previous joint algorithm.
Privacy lock still unmounts the whole detail subtree including both rail buttons. Gate coverage:
`tests/web-hub/ui/{activity-rail,fleet-drawer,fleet-fill-budget,fleet-tree,fleet-bash-jobs,privacy-lock,
checks-body-applicability,detail-body}.test.ts`; real compiled-UI evidence and design decisions:
`docs/dev/activity-rail/plan.md`. No Vue Transition/rAF, inline style or new dependency.

### Historical Task60 compact panel — zero reserved column, entry moves into the header

**Historical implementation, superseded by the click-driven drawer described above.** The following
records the former hover preview / pin / held geometry and its validation, not current behavior.
The pin control, hover preview, held state and timed auto-close have since been removed.

User-confirmed rework (`docs/dev/activity-rail/compact-panel-plan.md`, frozen): the expanded
panel no longer keeps ANY right-edge reserved column (the old docked 84px padding overrides are
deleted; normal 8/12px paddings stay) and the manual/locked/fullscreen entries live in the
drawer's COMMON header row in normal document flow. Hover/held keep the original floating DOM
and geometry, with panel↔button gap and bridge tightened 20→8px (drawer `right: 72px` = fine
rail 20 + hit 44 + gap 8; manual overlay is `right: 12px`, no bridge; docked column width policy
unchanged).

Single instance, two local hosts: `AgentDetail` owns both `[data-rail-host]` elements — a
resident `floating` host (absolute inset-0, pointer-events none, the rail's positioning ancestor
inside `.detail-split`) and a `header` host placed via FleetDrawer's optional `activity` slot in
the common `drawer-head` lifted OUTSIDE the tree/run branches (child detail keeps its own
RunHeader back/name/status/close; the common header shows entry+pin and NO duplicate close).
One Teleport moves the SAME `FleetSummaryBar` between them: `panelFloating = peeking || held`
(`useActivityRail` now exposes readonly `held` — held has `peeking === false`, so peeking/mode
alone can't pick the host) selects the floating host when closed/peeking/held, the header host
otherwise (fullscreen included). The header host's rail CSS resets to `position:static; inset:auto;
transform:none; display:flex; flex-direction:row; gap:8px; flex-shrink:0` and clears the ≤767px
backdrop chrome (buttons/badges/44px pulse untouched). Hover never moves the hovered DOM
(anti-oscillation); held migrates only AFTER its click landed (click exactly once); a Teleport
move re-focuses the SAME node only if focus was inside the rail and nothing higher-priority took
it (keyboard open still focuses close).

`FleetDrawer` takes a local `floating` prop (`FleetDrawerProps & { floating?: boolean }`, no
contracts change; legacy callers fall back to `peeking` — implemented with `||` because Vue
casts absent Boolean props to `false`, so `??` would never reach the fallback). `resolvedFloating`
drives `data-floating`, the bridge render condition (`overlay && floating`) and the fill-budget
invalidation watch (a held release keeps `mode === "overlay"` but flips floating true→false ⇒
remeasure + row-height cache clear). `restoreTrigger` now requires an actually-visible,
non-inert target (`checkVisibility` + ancestor inert walk; falls back to old semantics where
unavailable). Validation: the three suites above plus real-browser CDP evidence
(geometry/host/migration/focus/viewport 375–1600/container 478–600/fill/fullscreen trap) — see
`docs/dev/activity-rail/compact-panel-plan.md` §6; the #51 agent-card terminal+count background
pulse in `agents.css` is a DIFFERENT object and stays untouched.

## Fleet drawer archive

**Fleet drawer archive (archive-report.md)**: `src/archive/` (per-session `ArchiveControl` built by
`buildSessionStack`, `webHub.enabled`-gated, state in the `subagent:archive` session entry, full-snapshot-per-change,
60s unref'd auto-sweep under `webHub.archiveEnabled` — default on, agent-side only ⇒ `/reload` suffices)
hides TERMINAL run rows / bash rows from the fleet drawer and the TUI fleet widget (display only — never
get_run_result/`/agent status`/notifications). Web ops ride the `archive` cmd op (`{kind,target,set}`, hub
`parseCmdBody` whitelist ⇒ needs one `/webhub restart`); the set rides the open `StatusInfo.archived` slot
(no proto bump/caps, absent when empty); user-unarchived ids are `held` and never re-auto-archived. Report:
`docs/dev/web-hub/archive-report.md`.

**Count-only auto-archive**: `webHub.archiveKeepRuns` defaults to 6 and
`webHub.archiveKeepBash` to 5 (non-negative integers; `0` = archive all eligible items). Each sweep counts unarchived TERMINAL items per kind, including
held items; running and already archived items do not count. Only when a kind exceeds
its keep count does it archive eligible items oldest-settled-first, stopping at the
keep count or when no non-held items remain, regardless of their age. Held items never auto-archive.
`archiveEnabled=false` disables the timer; manual archive remains available. Legacy
`archiveAfterMin=0` disables the timer and a positive value enables it only when the new
boolean is absent; its duration no longer applies. The explicit boolean takes precedence.
`src/archive/sweep.ts` performs pure selection; control adapts snapshots and batch-commits
once. These settings are agent-only, non-live: `/reload` suffices, no hub restart.
Evidence: `docs/dev/web-hub/archive-threshold-report.md`.

**Cap-full progression (#91)**: a FULL 256-entry cap no longer stalls auto-archive (the pre-#91
`archiveRoom` clamp — free slots + gone entries — is 0 on a cap full of live entries, which the run
registry's never-shrinking candidate union makes the steady state; a 741-run session sat dead for
18.7 h, forensics in `docs/dev/archive-full/forensics.md`). Each kind now carries a monotone settled
watermark, persisted as the snapshot field `horizon: {run?, bash?}` (absent until the first live
eviction — old snapshots read back at −∞, and pre-#91 sessions never gain the key); terminal items
settled at/below their kind's horizon are IMPLICITLY archived: never selected, not counted toward
keep. `selectAutoArchives` is unclamped; after folding the selection, `trimToCap` enforces the cap
by evicting, in order: P1 unprotected gone entries (insertion order), P2 oldest-settled live auto,
P3 oldest-settled live manual, P4 protected/batch entries FIFO. Every LIVE victim raises its kind's
horizon to its settledAt — monotone, so an evicted live item can never be re-selected: an entry
leaves the explicit set only via gone (not a candidate), horizon (never selectable) or hold (never
auto-selected) — no resurrect flip-flop, by construction. Writes stay bounded: a stable fleet
converges to zero writes, every arrival settles in one write, the post-upgrade first sweep over a
legacy full-cap snapshot is exactly one horizon-only write; `sameArchiveState`/`semanticKey` treat
the horizon as semantic state. The horizon never rides the wire (I10) — implicit rows sit at the
256 depth, beyond every display window (two honest boundaries, plan §5 R1: mass-gone can float
implicit rows into view, and bash `(+N more)` eviction within retention does not converge).
Manual paths share the trim: `setArchived` protects its own id; `setArchivedMany` protects the batch
(P4 keeps a >cap batch's newest rows). Tests: `tests/archive/{state,sweep,control}.test.ts`
(T1–T6), `tests/archive/write-rate.test.ts` (S5–S7, CF3). Design: `docs/dev/archive-full/plan.md`.
Write-dedup safety net (#89 A1): `commit()` compares the next snapshot against the per-instance
`lastPersisted` baseline (`sameArchiveState`, plain ordered field comparison, `at` included — seeded
by `restore()` from the branch read-back; advanced only on a successful append) and skips the write
when the content already matches, retrying on the next real change after a failure. The write RATE
itself is pinned by `tests/archive/write-rate.test.ts` (24 h sweep simulation; red against both the
998dce27 at-rewrite and the 43d892fd id-flip forms, replayed as in-file counterfactuals):
docs/dev/web-hub/refresh-slow/archive-dedup-plan.md.

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
(route change / idle timeout / `relock("manual")` / tab hidden — the manual path is API-only since the
2026-11-03 header redesign: the header button is now the mark-state toggle, unmarked 「锁定」 marks and
marked 「解锁」 opens the 取消标记 flow, the card affordance's twin), and an old hub without `privacy.v1`
leaves the UI
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
commands; RPC/print never gets it). The `/mem` usage's scoped fragment is taken only from the
registered command description, which reflects whether a scoped router was actually wired;
missing descriptions fail closed to the unscoped static usage. Deny commands never complete and deny ITEMS are dropped
per-item (the execution path's own tables); budgets: agent 1.5s hard timeout + in-flight ≤2
(a SYNCHRONOUS third-party hang blocks the process — accepted residual, r1 #4), hub 4s route
deadline / in-flight ≤8 global ≤3 per principal / independent limiter, browser disconnect ⇒
slot released + audit `aborted` (r1 #6). Enter applies a candidate ONLY after explicit ↑↓
navigation (D2 拍板). `/webhub status` prints `cmd-args: <mode> · hub-cap on|off|n/a`
(`agent/cmd-args-status.ts`). Conformance: `tests/conformance/slash-args.test.ts` (real pi
rpc child + real InteractiveMode) before any pi peer bump.

## Unknown slash text（#40）

默认开启，无新设置：Composer 未在当前公布名单命中的 `/name` 只是 unresolved，不代表不存在（名单最多 400）。只有当前 agent 的 `StatusInfo.features` 含 `unknown-slash-text.v1` 且 Web commands 已开启时，才放行给权威 agent 分类。精确命中的 deny 不放行；Web commands 关闭仍沿用直接普通 prompt，无 A→B。旧 agent 无 token 保留旧命令拒绝；旧 hub 开放 status.features 透传即可，无 hub/hello cap、新字段、PromptArgs/result schema 或 PROTO bump。旧 UI 忽略 token。

`agent/slash.ts` 保留旧 `classifyCommand` 的 completion/shadow 容错语义；另增 dispatch-only `classifyCommandStrict`，成功验证完整注册表（不受 UI cap 限制）后才能证明 unknown；缺 port、throw、非数组、坏条目均 unavailable→E_UNSUPPORTED。bridge 只对确定未知返回 E_UNKNOWN_COMMAND。原有 source/name/大小写/重复名 `:n` 优先级不变。

Web 仅收到终态 E_UNKNOWN_COMMAND＋effect:none 后，用缓存的完整 composer 正文发送一次普通 prompt B。命令 A 和 B 使用不同 cmdId；A 不执行，不伪造 command history 成功卡，UI 移除 A 的未知失败占位，B 承担 message/ctl/recall 归因。附件不再次 compose；B 显式 expandPromptTemplates:false，不执行斜杠。BAD_REQUEST、策略拒绝、确认、handler 异常、timeout、网络失败或 effect:unknown 均不回退。页面内一次性意图在 await 前消费；token/epoch/session/online 状态变化或卸载取消，恢复旧值也不复活；断线/刷新不自动新建 B，B 效果未知只按已有 id 查询，不换 id 重发。

Unicode/路径/超长 token 等不满足旧 command wire-name regex 的输入走现有 prompt，但并不靠 E_BAD_REQUEST 回退：`handlePrompt` 在 beginOrReply 与 ctx/session/auth-admin/fabric/compaction 检查之后、任何 mention/thread/hold/origin/send 副作用之前，只对 Web commands 开启的非法 wire-name 做严格只读分类。已注册名拒绝 E_BAD_REQUEST，读取失败拒绝 E_UNSUPPORTED，均 settleAndReply；确证未知才继续。Feishu、thread metadata、dispatchHeld 重入、wire 合法名字、前置空白、`//`、单 `/`、commands-disabled 均不进入此分类。

普通消息仍经过 secure/input 等原链，不强迫模型绕过合法 handled：LOCKED 拦截、D8、reflex/topic-switch 的 slash-prefix veto 保持，未新增输入回灌 hook。接受 pi 1.4 TUI 提交前 trim；RPC/Web 不由本功能 trim；`@notify/#notify` 仍按已有通知 hook 去关键词并 trim。Web 按 whitespace 拆参数与 pi 扩展仅按 ASCII 空格拆名的差异不统一；`//` 的 Web 双斜杠保留、飞书去一根斜杠的旧约定不变。

**飞书来源边界**：只有已启用 bot 命令 `/list /use /cur /new /unbind /file /help`（以及启用时的 `/schedule`、`/main`）按 bot 命令处理；参数错保留 help，权限/执行错不改发文本。其余斜杠默认作为普通请求，包括 pi 的 `/model`、`/reload` 和关闭的 `/main`、`/schedule`，不显示 unknown，不执行 pi 命令；`/mainx` 不匹配 `/main`。普通请求仍需授权/绑定并经过持久接收、去重和既有 thread 路由；飞书没有完整 pi registry，不能拿 bot 名单假称区分 pi 已知/未知。详见 [Feishu bot README](../feishu-bot/README.md)。

门禁：`tests/conformance/unknown-slash-text.test.ts`（真实 pi 1.4.0 TUI/RPC＋fake provider，含 handler throw/重名/trim/notify）、`tests/integration/unknown-slash-text.test.ts`（真实 HTTP frontend→handler/bridge→真实 pi＋fake provider，飞书真实 admission/durable/dedup）、agent/UI/parser/optional features 定向测试。这些 runtime characterization 仅为实际安装 **pi 1.4.0** 的取证，不是全版本保证；1.0–1.3 未验证，pi 1.5 的 #45 适配仍在独立 clone、尚未集成主树。pi peer bump 必跑该 conformance（AGENTS checklist 已追加）。

**五个冻结比较测试的具名投影（root 裁定）**：`tests/integration/{fabric-xs-off-golden,fabric-xs-reply-off-golden,fabric-xs-channel-compat,thread-off-golden,thread-rebind-off-golden}.test.ts` 仅在历史比较前断言 `unknown-slash-text.v1` 恰一次，再剥离这一已声明的正交 token；其余 features 与所有 XS/thread 字段、帧顺序仍完整比较原 golden，不通用忽略 features。默认 on 独立专例还精确断言原始 features 为 `[resume.v1,cmd.history.v1,unknown-slash-text.v1]`；历史 cmdHistory-off 比较不因此伪造 history token。所有 A fixtures 保持原字节，不重录、不加生产测试开关。

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
custom tombstones + open `cmd` field (`protocol/keys.ts`); `runTail`'s ENOENT/TOO_LARGE
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

## #65 Web session-add 独立结果通路（B1 包4）

生产注入受 S1 硬门约束，只有 main/plain/session-memory-on 才提供可选 memoryWrite；没有端口
仍 fail closed。`wireWebHub` 仅在现有四处窄接线：completion 的内部 memorySessionAdd 能力投影、
bridge 的 write getter（闭包晚取 attached/remote readiness，避开 wireDialogs TDZ）、独立
memoryOwner=MODULE_INSTANCE、可选类型。hold owner、原 session/tree/reload 边界调用及注册顺序不变。

验收修订 B1/B2：S1 在 running/rejected/completed/unknown 每个阶段重新读取 DOM 的
`data-cmd-id`，与真实 ledger entry.id 严格比较，逐态记录 `commandIdentity`（phase/domPhase/
domCmdId/ledgerCmdId/ledgerState）；汇总输出 `/tmp/65-pkg4-s1-command-ids.json`，不以领域 n1
或运行开始时的样本代替终态身份。缺失的可选 rev 仍不补 wire 值，DetailDock 另显示
「Revision 不可得：宿主未提供版本标识，未生成推测值。」，history on/off DOM 测试钉住该提示。

commands/ledger 是唯一终态源：异步回执 reply-only，原 cmdId 查询，cancel 观察在 release 之前；
abort 自己的 ok 不是记忆已撤回证明。成功使用既有开放 command data 的
`memoryWrite:{id,rev?,persistence}`（没有新 op/cap/PROTO/schema），message/output 只放人读提示；
UI reducer 有界投影这些事实，DetailDock 直接渲染，不用正则从文案提取 id。坏字段转 unknown；
旧客户端仍读原 output。记忆独立卡与 history 开关无关，不接 beginExternal/sink/settle，不改 Composer。

验收入口：`tests/integration/memory-web-command-confirm.test.ts`、
`tests/conformance/memory-web-command-dispatch.test.ts`（真实 SDK、5s settled TTL）和
`npx tsx scripts/web-hub/memory-command-confirm-probe.ts`。probe 的 28 组真实浏览器/SDK场景验证
按钮→HTTP→handleAbort→task.cancel→真实 ledger→SSE/query→DOM、running/refused/completed/unknown，
以及 history on/off 的身份/权限/断网/隐藏/真实模型后启/页面刷新和迟到 ACK；完成 DOM id 与 ledger 结构化 id 精确比较。
完整输出、截图和 DOM 在 `/tmp/65-pkg4-s1-*`；它使用隔离测试 HTTP host，不冒充实际 Hub daemon
认证、生产部署或收费模型验收。浏览器不可用退出 2，不能据此打开生产写端口。

file-backed 的 `appended` 不保证 SDK 此刻 flush/fsync。会话级停止不能回滚已完成写入；断网/进程
退出/ledger 过期可能无法查询，unknown 永不显示成功。外部 writer 与最后 guard/SDK append 之间
竞态、同步 I/O 软预算和已提交标签不可回滚为已接受限界，见 memory 的设计附件与 README。

## History tail reads (`hub/history.ts`)

**Hub main-thread rule (perf incidents 2026-10-28, `docs/dev/web-hub/refresh-slow/`):** nothing
that runs on every leaf change — and nothing on the user-triggered history paths — may parse
the whole session file. A 193 MB live session first made `runTail` (500 ms debounce per
subscribed agent) re-read + `JSON.parse` the whole file — `FileCache` is keyed on size/mtime, so
an append-only file always misses — and project the whole branch (`canonicalJson` per custom
entry) only to keep the last `APPEND_TAIL_ENTRIES` (64): 1–6 s of synchronous main-thread CPU
per change, queueing EVERY hub request. The same whole-file path then made `snapshot()`/`page()`
cost ~7 s on a 30k-entry branch (only the last 400 entries were kept).

**`runTail`** uses `readBranchTail`: positioned reads from the end (512 KiB, ×4 until the leaf's
ancestry is covered, ≤ `TAIL_CHUNK_MAX_BYTES` 32 MiB — bounded by THAT budget, not by the file
size; the old `maxFileBytes` gate is gone, so a >256 MiB file with the ancestry in the tail
answers from the tail), cut at a newline byte, projecting newest-first until `count` PROJECTED
entries — result equals the full reader's `.slice(-count)`. `undefined` ⇒ not answerable from
the tail (chunk would cover the whole file, budget spent, leaf not on disk yet, corrupt
NON-trailing line inside the chunk) ⇒ fall back to the full cached reader, whose verdicts
(`PARSE`, `LEAF_NOT_FOUND`, …) are unchanged. On `ENOENT` (file not created yet,
pre-first-message — cmd-history §4.10) **or `TOO_LARGE`** (file over the 256 MiB full-read cap
AND the tail could not answer — refresh-slow §4.3) `runTail` falls back to the agent's
in-memory branch (`branch_req`, 256 KiB, cut at the pending leaf) so real-time appends never
silently stall on the far side of the cliff; the TOO_LARGE arm logs ONE `warn` per agent per
contiguous over-cap state (metadata only; any later successful file read re-arms it).
`PARSE`/`LEAF_NOT_FOUND` keep the plain retry-on-next-leaf-change behavior. Deliberate
relaxation: a corrupt line OUTSIDE the chunk no longer silences tail appends (the full reader
would answer `PARSE`). Residual (§4.3 disclosed): while a file stays over the cap with an
unanswerable tail and the leaf outside the agent's 256 KiB reply window, every leaf change
still fires one failing `branch_req` — a wasted round-trip per change (warned once; cheap once
the agent-side reverse projection lands).

**`snapshot()`/`page()`** ride a private second instance of `hub/run-file-reader.ts`
(`fullReaderParity`, 512 KiB scan chunks, cursor LRU 8 keyed `(realpath,size,mtimeMs,leafId)`):
backward scan with substring prefilter, cooperative `setImmediate` yields, single-flight, ≤2
concurrent scans, and a cursor page() and snapshot() SHARE — the first "Show earlier" after a
snapshot is mostly a cache slice. `snapshot()` reads the newest `max(tailEntries,
DELIVERED_CAP)` = 512 projected entries (the delivered baseline, `pushDelivered`'s last-512
keys, matches the old whole-branch read) and doubles the limit (≤ 8× ⇒ 4096, resuming the
cursor) while the merge window lacks `2×|recent|` message-like entries. Reads are bounded by
a file-read sub-deadline (`snapshotFileBudgetMs`, default half of `TIMING.snapshotMs` — busy
leaves time for the fallback) and the reader's cumulative-scan cap (256 MiB), NOT by the file
size — the 256 MiB cliff is gone (sparse >256 MiB fixtures answer `source:"file"` from the
Tail). Parity makes the reverse walk equal `walkBranch`: exact `hasMore` (after `limit`
entries the scan continues until one MORE projected entry appears or the walk ends — otherwise
remaining all-unprojectable ancestors would report hasMore:true and page an empty page); a
missing ANCESTOR at the file head ends the chain like `walkBranch`'s break (only the leaf
itself missing stays `leaf_missing`); a parentId cycle ends the chain likewise.

Fallback matrix (refresh-slow §2.3): `ok` ⇒ `source:"file"`; `file_missing` / `leaf_missing` /
`parse_error` / `too_large` / `busy` ⇒ `branch_req` (+`log.info`) — NEVER a whole-file read (any
verdict the full reader could add costs seconds of main-thread CPU to re-derive what the
reverse read already proved); `leafId:null` ⇒ empty history; `--no-session` ⇒ agent directly.
`page()` maps the reader's `busy` to `E_BUSY` (503, retryable; cursor progress kept) instead;
its `leaf_missing` means "the walk terminated (root / file head / truncated ancestry / cycle)
without ever crossing `before`" — `before` genuinely off-branch OR the file unable to express
the full chain — and falls to the agent path, which still ends in `E_NOT_FOUND` when the agent
does not know `before` either (same verdict the full reader used to reach, one extra
round-trip).

Deliberate relaxations vs the old whole-file reader, all local to this section:

- a corrupt line OUTSIDE the branch no longer forces the agent fallback (old: any bad line ⇒
  `PARSE` ⇒ agent);
- a corrupt line ON the branch that damages the `"id":"<want>"` needle bytes makes the
  substring prefilter MISS it — the walk silently truncates at that ancestor and snapshot/page
  still answer `source:"file"` with a truncated branch (old: `PARSE` ⇒ agent, which answers
  from memory). Corrupt lines that prefilter-HIT still fail `parse_error` ⇒ agent (review #2);
- duplicate ids (corrupted files): the reverse reader resolves the child-nearest previous
  occurrence, the full reader file-last — they differ only when a duplicate's later copy is
  written after its child, impossible in a healthy append-only file;
- delivered baseline: the newest 512 entries (not the whole branch) feed `pushDelivered` — a
  branch with >512 entries and keyless entries (compaction/branch_summary) among the newest
  512 may carry a few fewer delivered keys (only affects `/tree` jumps far back; same class
  of boundary the old >512 cap already had);
- cursor memory is LRU 8 × projected chain — deep pages can approach a whole-branch projection
  (still far below the old 1.6 GB RSS spikes); very long no-newline regions (sparse holes)
  make the reader's carried `rest` quadratic in `Buffer.concat` — bounded by the sub-deadline
  and the 256 MiB scan cap (busy/too_large), a pre-existing reader limitation.

`FileCache` is now used only by `runTail`'s full-reader fallback; its unbounded parsed-index
memory on big files is a known residual (refresh-slow plan §8 follow-up — the ≤32 MiB cache cap
proposed in plan §2.5 was dropped by main-session ruling). Test seams on `createHistoryService`
deps: `readerStats` (read-amount/round gates) and `snapshotFileBudgetMs` (0 forces the busy →
branch_req fallback). Tests: `tests/web-hub/hub/history.test.ts` (snapshot/page parity
equivalence, read gates, sparse cliff, busy, cursor handoff), `tests/web-hub/hub/history.perf.test.ts`
(~44 MB synthetic archive session: snapshot <1 s, event-loop gap <100 ms, scan <25% of file),
`tests/web-hub/hub/run-file-reader.test.ts` (parity group; the unchanged default groups pin
parity=false byte-identity for run transcripts), `tests/web-hub/hub/cmd-history-runtail.test.ts`
(runTail fallback matrix incl. the TOO_LARGE arm).
Diagnosing a stalled hub: `/proc/<pid>/task/<pid>/stat` utime sampling shows busy runs on the main
thread; a short `SIGUSR1` inspector CPU profile (close it again with
`process.getBuiltinModule('node:inspector').close()`) names the function.

## Run-transcript chain hardening (2026-11 defensive package)

Same main-thread rule as above, agent side: `agent/run-transcript.ts`'s `onReq` live answer used
to `projectSessionEntry` the WHOLE in-memory branch and only then trim to `limit`/`maxBytes` —
an unbounded synchronous CPU burst on long-lived runs. It now walks the RAW branch newest-first
and projects lazily: only the kept tail window plus at most one budget-overflow probe and one
`hasMore` probe are ever projected (`before` is located by id compare; only an id match pays one
projection to confirm projectability). Output stays byte-identical to "project all, then trim
the head" (same +1-per-line accounting as `snapshot.ts`'s `buildBranchReply`; `truncated` exactly
on budget overflow; `hasMore` ⇔ a projectable entry exists below the window) — pinned by
`tests/web-hub/agent/run-transcript-tail.test.ts` (projection-count asserts + a seeded matrix
against an inline reference of the old algorithm).

Observability: `hub/run-routes.ts` writes ONE `audit:"run"` line (audit.ts's `auditRun`, U7
whitelist — identifiers/status/code/ms only, runId as a sha256[0:12] `runTag`, never content)
per `/api/run/*` request AND per async `runTx.snapshot` settle (logged before the object-identity
discard, so a late discarded snapshot still leaves its ms/code). Triage: `op:"snapshot"` with
`ms` ≈ `RUN_TX.reqDeadlineMs` + `code:"E_DEADLINE"` ⇒ the agent `run_tx_req` round timed out; a
fast `ok:true` ⇒ the file/agent path answered. Format asserts: `tests/web-hub/hub/run-routes-audit.test.ts`.

## Peer-bump conformance premises (cmd-history)

**Also run `tests/conformance/cmd-history.test.ts`** (web-hub-cmd-history I1):
it pins the six pi premises the command-history feature stands on — custom `appendEntry` entries
never reach `buildSessionContext`/the provider payload/the system prompt; a custom entry with
no renderer renders nothing in InteractiveMode; extension commands run immediately while
streaming and defer ONLY inside the `_isEmittingAgentSettled` window (deferred actions in
order); `sendUserMessage` never executes slash text (`expandPromptTemplates:false` default);
`appendEntry` before the first conversation does not create the session file; `ctx.newSession()`
returns `{cancelled}` and every read of a replaced ctx throws the stale error.

## agentDir 与 hub 状态（#54 P4）

- hub 是每个 uid 一个的单例；状态目录、socket（既有 fallback 除外）、`hub.json`、外置 UI、uploads 仍固定在 `<home>/.pi/agent`，不跟随 `PI_CODING_AGENT_DIR`。
- hub 的 agentDir 由 hub 自己的环境通过 `protocol/agent-dir.ts` 解析，继承自拉起它的会话；仅驱动会话发现与 spawned children 的环境。网页新建的 headless 会话，其设置与 traffic 按 hub 的 agentDir 解析：目标目录没有设置文件时仍继承 `~/.pi/agent`，创建设置文件后隔离。这是 **hub 级单一 agentDir** 的限制；spawn 请求不携带 agentDir，wire / PROTO 不变。
- `PI_WEBHUB_CONFIG` 仍取自拉起 hub 的会话设置，不随其他会话连接改变。
- `hub.json.agentDir?: string` 只在 hub 解析来源为 `env` 时写入；未设变量、空串、显式默认目录或被忽略的相对值不新增字段，默认记录字节不变。既有 LAN/UI/spawn/proxy 更新保留该字段。
- agent 结构化读取该可选字段，非字符串/空串当缺失。`/webhub status` 复用已有 `alias.statusLines()` 的 status-only warning 通道输出中文诊断，不新增工具、命令注册或 wire 字段：hub 目录（缺字段按 `~/.pi/agent`）与本会话不同，提示网页新建会话使用 hub 的目录，并建议从目标环境执行 `/webhub restart`；字段缺失且本会话为 env 来源，另提示「hub 的 agentDir 未知（旧版 hub 或默认）」。无 hub 记录/损坏文件不诊断；路径中的控制字符在展示时剥除。
- 兼容：旧 hub × 新 agent 按缺字段处理；新 hub × 旧 agent 按字段挑选读取，忽略未知键。hub 边界白名单不变（I8），追加式可选磁盘字段（I10）。门禁：`tests/web-hub/agent/agent-dir-status.test.ts`、`tests/web-hub/hub/{hub,hub-json}.test.ts`（T-HB1）。

## Manual xs activation transport (#14 P3b)

No new HTTP endpoint: token/password `HubTransport.xsActivate` serializes a bounded
internal `fabric __xs` action over the existing /api/cmd auth/CSRF/command.v1 path.
`BuiltinBridge` checks the same fabric policy/current session and rejects Feishu,
unknown JSON fields, body/source/level claims and missing activation keys. Its
optional host xsActivation port comes only from activationOn main-session wiring.
The hub uses the original message relation (web supplies no target) and repeats
cap/key/eligibility/policy/quota checks; browser state cannot authorize a wake.
Receipt queries are pure reads, never a fallback activation. Activate timeout or
rejected promise is unknown/query-only and cached under the existing command id,
not retryable none; both paths remain bounded with unref'd/clamped deadline timers.
No new origin/model prompt, human grant or command-history key card is emitted.

The existing UI request store retains server control outcomes as a separate local
attempt hint: unknown/accepted/already_active only query, authoritative quota floor
is displayed, and query/activate cannot share the wrong outcome through singleflight.
Hints are session/key-scoped, bounded and non-persistent; server dedup/policy is still
the authority after refresh. See `docs/dev/fabric-xs-activation/P3b-report.md` for
changed-file list, gate logs, the narrow UI integration correction and audit verdict.

## xs activation: hub facts and gates (#14 P5)

The hub assembles the progress/activate services only when `HubConfig.crossSession.activation` is literal `true` (the
agent writes it when `xsOn ∧ fabric.crossSession.activation.enabled`; key absent ≡ pre-feature hub, byte-identical).
Caps `xs.state.v1` / `xs.activate.v1` ride `HubInfo.caps` and `hello_ack.caps`; an unsupported peer on any of the three
legs ⇒ no track fields, no `xs_state`, local `unsupported` for activate. Activation quota reuses the send/hub/pair/inbound
limits (pair 2/h, 30 s control spacing); audit adds only whitelisted token keys (no body/key/token). Gates:
`tests/integration/fabric-xs-activation-compat.test.ts` (mixed versions), `tests/conformance/fabric-xs.test.ts`
C-X13/C-X14, `tests/web-hub/boundary.test.ts`. Design: `docs/dev/fabric-xs-activation/{arch,plan}.md`.

## Registry epoch 刷新与 `epoch.up.v1`（#23 P-B）

`hub/registry.ts` 的 `register()` 在 reclaim（同 agentId 重连）时，epoch 刷新条件为
`epochChanged && prevPhase !== "stale" && (caps ∋ hold.v1 ∨ caps ∋ epoch.up.v1)`：命中则先发
`agent_up`（携带新 epoch 与新版本）后发 `gap`，顺序与 Y7.2/stale 路径一致；stale 分支仍只发一次
`agent_up`（永不双发），同 epoch 重连保持静默。两个 cap 互补：`hold.v1` 随默认配置（`holdWired =
control ∧ steerRecall`）声明；`epoch.up.v1` 只在 hold 缺席的配置（`control:false` 或
`steerRecall:false`）下由 agent **尾部唯一追加**（`agent/index.ts` 的 `capsExtra`），agent 面
专属 —— hub 不在任何 cap 面（`HubInfo.caps` / `hello_ack.caps`）广播它。**默认 hello 不得出现
`epoch.up.v1`**：五份 A 级 golden（thread-off / thread-rebind-off / fabric-xs-off /
fabric-xs-reply-off / schedule-off）逐字钉住默认 `hello.caps`，禁止重生。

兼容存证：`tests/fixtures/web-hub/epoch-up-compat-golden.json`（#23 P-B 在**未修改的实现**上
录制，唯一允许的新 fixture；`PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE=1` 且文件已存在时拒绝覆盖）。
s1（老 caps 无 hold：只有 `gap`）与 s2（有 hold：`agent_up` 先于 `gap`）在新实现上必须与
golden 逐字节相等（总线事件 + SSE 原文，clientId/端口归一化）；s3（老 hub × 新 agent：
`gap` + hub 内部 `caps` 事件）是老 hub 的存证，不与当前实现比对。老 hub 只把未知 cap 存下不
读取，`card()` 只派生布尔值，可观察输出不受影响。门禁：
`tests/web-hub/hub/{epoch-up-compat,registry,caps-coexist}.test.ts`、
`tests/web-hub/agent/wiring-hold.test.ts`（D13 describe）、`tests/web-hub/protocol/version.test.ts`。
设计：`docs/dev/web-update-stuck/plan.md`（r3）。

## Outdated reload 状态机（#23 P-A/P-C）

Web 上点击插件更新/重新加载后的每次请求都在**有限时间内结算**（done 或 failed 可重试）。
协调器在 `ui/src/logic/outdatedReload.ts`（框架无关纯逻辑），相：`idle → queued/sending →
awaiting/parked → done / failed`；entry 按 agentKey 保留，不随卡片消失清除。要点（决策号见
`docs/dev/web-update-stuck/plan.md` §2.1）：

- **总预算（D1）**：`request()` 起算绝对截止 `OR_QUEUE_TIMEOUT_MS`（30min），阶段切换不清除；
  到点按当前相结算（queued ⇒ `E_QUEUE_TIMEOUT`；parked ⇒ 先送 `reload cancel` 再
  `E_QUEUE_TIMEOUT`；awaiting ⇒ `E_TIMEOUT`；sending ⇒ `E_SEND_UNKNOWN`）；进入
  send/awaiting/parked 前也查截止（后台标签页计时器延迟兑底）；awaiting 的 90s 生效计时取
  `min(90s, 剩余预算)`，只是等待期内更早的失败，不是总上限。
- **send 上界（D2）**：`OR_SEND_TIMEOUT_MS`（60s，> 2×`CMD_REQUEST_TIMEOUT_MS`）⇒
  `E_SEND_UNKNOWN`（结果未知，**不自动重发**；命令若其实送达，版本到位后自动收敛 done）。
  #25 残留：transport 的 deadline 只盖响应头，`await r.json()` 的 body 无上界，彻底修复另立
  #25；本地兑底修好后保留。
- **attempt token（D3）**：每次 send 发单调 token，成功/失败/超时回调双核对 token+phase，
  修迟到 Promise 的 ABA。
- **下线判据（D4/D5）**：`agentOffline`（不在 agents ∨ `down` ∨ `card.state==="stale"`，
  precheck 与协调器共用同一函数）；`notifyTick` 先判版本到位（done 优先，failed 也收敛）
  再判下线（`E_OFFLINE`，只作用四个在飞相；parked 下线不发 `reload cancel`）。
- **`E_OFFLINE` 语义**：目标进程退出/正在重启，重新加载未完成；若会话已重启，请在新卡片
  上查看或重试。**`E_SEND_UNKNOWN` 语义**：命令结果未知（网络响应未完成）；若重新加载已
  生效，版本到位后会自动显示成功。
- **不跨 key 追认（D6/D8）**：failed → done 只在**同一个 key** 且版本到位时成立。断线后
  10–60s 内同 key reclaim ⇒ done（慢 reload 会先短暂 E_OFFLINE 再自动 done）；超过 reap 窗口
  后按 `register()` 实际返回的 key 结算：同进程同 identity ⇒ 同 key（`reclaimed:false`）⇒
  版本到位即 done；新进程新 identity ⇒ 新 key ⇒ 旧请求保持 `E_OFFLINE`，新卡片是独立实体。
  restore 导航（`useHub.ts` 的 `successorOf`）照常把旧 key 的查看者带到 successor，本方案不
  改导航语义。**不自动重试（D7）**；down 卡上的 chip 点了必然失败，隐藏并入 #24。
- **结果展示（D9/D10）**：`orFailReason(entry)` 是失败原因文案的唯一来源（wire message ⇒
  raw；本地错误码 ⇒ i18n），四个入口共用：详情横幅、AgentCard chip 失败态（danger 配色、
  title 含原因与「点击重试」，点击仍 `request`）、汇总失败行（人读原因 + 错误码进 title）、
  目标消失后的空态结果行（`OutdatedReloadResult.vue`，挂「已删除」「未连接」四种空态）。
  zh/en 键集合一致（i18n-parity 钉住）。
- RC3（跨版本 reload 后进程退出、新进程顶上）的完整处理另开 #24；本方案如实报告失败，不
  把「新进程顶上」当成成功。

门禁：`tests/web-hub/ui/{outdated-reload,outdated-reload-loop,outdated-reload-surfaces,dashboard-view}.test.ts`
（协调器/loop/DOM 级）；跨层闭环（真实 wiring hello → registry → HTTP/SSE → reduce → 协调器，
含正反对照、时间窗、reap 后两组、原始 bug 复现）在
`tests/integration/web-hub-outdated-reload-loop.test.ts`。设计：`docs/dev/web-update-stuck/plan.md`
（r3），交付记录见同目录 `PA-report.md` / `PB-report.md` / `PC-report.md`。

## Reload 结果回传 `status.reload`（#30）

Web 发起的 outdated reload 由 agent 回传**它能确认的**结局，#23 的状态机据此更早、更准地结算。
设计/决策（Q1–Q4、D1–D9）在 `docs/dev/reload-result/plan.md`（r3）；本节只记录开发者要点。

- **wire**：`StatusInfo.reload?: ReloadStatusWire`（`protocol/messages.ts`）——开放槽，无新帧、无
  cap、无 PROTO bump。字段：`v:1`、`life`（reload 生命周期 id）、`cmdIds`（归属该 life 的 web
  命令帧 id，1..4 FIFO）、`rev`（life 内单调，UI 去重）、`execId`（当前执行 token，旧执行的事实
  被 tracker 丢弃）、`state`、`open`、`at`；可选 `waitingFor`/`activeRuns`（deferred）、
  `code`/`message`（failed/cancelled；message 仅 `E_RELOAD_THREW`，≤256 B UTF-8 边界截断）、
  `version`/`epoch`（仅 completed，版本不可信/`0.0.0` 时不写）。**`state` 是最近一个事实，
  `open` 才表示请求是否结束**：`failed E_RELOAD_IDLE_WAIT` 带 `open:true`，后继的
  started/completed/cancelled 照常记录。`state ∈ deferred|started|cancelled|failed|completed`；
  `code ∈ E_RELOAD_{IDLE_WAIT,UNAVAILABLE,SETTLE,REFUSED,THREW}|user|superseded|session|quit`。
- **采集**：`src/reload/command-port.ts` 的采集点（arm/deferFire/idleWait/cancel/unavailable/
  settle/started/returned/threw）→ `web-hub/agent/reload-track.ts`（归属、投影、接管标记）→
  `publishStatus` 只在投影变化时发一帧。**TUI 发起的 reload 不回传**（Q1）：无 `by`（webCmdId）
  的事实只允许记入**已跟踪的** life（TUI 对已跟踪请求的 cancel/now 照常归属）；无记录则忽略。
  接管验证（D4）只信**下一个 activation**：只有真实发过 `started` 的 life 才写标记，新
  activation 的 `session_start{reload}` 逐项验证（sessionId/file、`originEpoch≠当前`、`shutdownAt`、
  120s 窗）后才写 `completed{version, epoch}`；任何一条不满足 ⇒ 记录保持 started，UI 走生效计时/
  版本推断。TUI 在 shutdown 后的加载失败不可采集——UI 据 started + 下线判 `E_RELOAD_LOST`。
- **存放与 TTL**：`Symbol.for("pi-subagent:web-hub:reload-track")` 纯数据（容量 1 记录 + 1 标记；
  未知 `v`/损坏/未来时间戳 ⇒ 按空处理并清除），存活于进程内、跨 in-process /reload。TTL 只约束
  读取（open 40min / closed 10min / 标记 120s），过期撤销借现有 1s `onTick` 只补发一帧无
  `reload` 字段的 status。hub 零改动、不持久化：槽是电平式的，重连/重订阅读到 registry 保留的
  最近一帧（#88 定向补发）；过期后的重新订阅不会看到残影。
- **UI 吸收**（`ui/src/logic/outdatedReload.ts` 的 `absorb`）：每次 send 用 `newCmdId()` 生成命令
  id，事实按 `cmdIds.includes(cmdId)` + `rev` 去重；completed 且 version===hub 版本 ⇒ done，不等
  ⇒ `E_RELOAD_NO_UPGRADE`，缺 version/epoch ⇒ 按未知（等版本/生效计时）；failed ⇒ 用其 code；
  cancelled ⇒ `E_RELOAD_CANCELLED`；deferred ⇒ parked（此后不再按 fleet 启发式迁移）；started ⇒
  awaiting（同一请求只建一次 90s 生效计时）。failed 相不复活（Q4）：只接受同请求迟到的
  completed，及 `E_OFFLINE|E_SEND_UNKNOWN|E_TIMEOUT`/`E_QUEUE_TIMEOUT→E_RELOAD_IDLE_WAIT` 的
  有限细化。IDLE_WAIT 立即判失败不 cancel，但绝对截止照常恰好 cancel 一次。
- **老 agent / 老 hub 兼容**：没有 `status.reload` ⇒ UI 走 #23 原推断路径，行为与
  `web-hub-outdated-reload-loop.test.ts` 钉住的一致；老 hub × 新 agent：开放槽原样转发（
  `decodeAgentFrame` 的开放 StatusInfoSchema 不解析未知字段）；旧 UI 忽略未知字段，
  composable 的 watch 签名对无 reload 的 agent 不变。off（webHub 关）/TUI/无跟踪场景帧序列
  逐字节不变（`tests/fixtures/web-hub/reload-result-compat-golden.json`，A 级勿重生）。
- 门禁：agent 侧 `tests/web-hub/agent/{reload-track,wiring-reload-status,reload-result-compat}.test.ts`；
  hub 直通 `tests/web-hub/hub/reload-status-passthrough.test.ts`（真实 agent-server socket →
  registry → SSE + #88 补发）；闭环 `tests/integration/web-hub-reload-result-loop.test.ts`（真实
  wiring × 两个真实 activation：`vi.resetModules` 重演 /reload 的模块重求值 ⇒ 新 MODULE_INSTANCE ⇒
  epoch 变化走 reclaim；正例 done 只能来自 completed 事实，对照组去掉字段后与 #23 结果一致）。
  设计：`docs/dev/reload-result/plan.md`（r3），交付记录见同目录 `PA-report.md` / `PU-report.md` /
  `PC-report.md`。

## Agent 下线原因区分表（#24 结案）

`agent down` 的 `reason` 来自 agent 的 `bye` 帧（`protocol/messages.ts:1229`），hub 原样记录
（`hub/registry.ts:266-283`）。**RC3（跨版本 reload 后进程退出、秒级新 pid 顶上）已在 #24 中
确认为非缺陷**：`quit` 只能由 pi 进程优雅退出产生（`/quit`、Ctrl+C/D、扩展 `shutdown()`、
SIGTERM/SIGHUP），reload 的任何结局都不会产生它；新 pid 是用户在终端里手动重启的，hub 对
非 managed 会话没有任何拉起手段。完整证据链见 `docs/dev/reload-quit/explore.md`。

| reason                 | 谁发出 · 什么条件                                                                                                                                                                                                                                                                                                                                                                                              | hub.log 里的样子（结构化 JSON，勿 grep 连写串）                                                                                                                                                                                                                                                                                                                                 | 前端该怎么理解                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `quit`                 | agent 侧唯一发送点 `agent/connection.ts:398-403`（`detach("quit")` → `close("quit")`）；触发条件是 pi 发 `session_shutdown` 且 reason 不是 reload/new/resume/fork（映射在 `agent/index.ts:1903-1906`），即进程**优雅退出**（pi 的 `AgentSessionRuntime.dispose()`）。崩溃不走这条路（不发 bye，无 crashes.json 之外的痕迹）。web 命令面 deny 了 `quit`/`exit`（`agent/command-policy.ts:57,59`），按钮点不出来 | `{"msg":"agent down","agentKey":…,"reason":"quit"}`                                                                                                                                                                                                                                                                                                                             | 进程真的退了（exit 0）。卡片转 down；非 managed 会话只能等人在终端重新起（新 agentKey、新卡片）。不是 reload、不是崩溃              |
| `handover`             | 同进程新 activation 接管旧连接时由 `existing.close("handover")` 发出（`agent/connection.ts:257-278`），即 in-process reload 成功落地的标志                                                                                                                                                                                                                                                                     | 先 `{"msg":"agent down","agentKey":…,"reason":"handover"}`，随后的重连 reclaim 有 `{"msg":"agent reclaimed","agentKey":…,"epochChanged":true}`（注意 `epochChanged` 与 msg 之间隔着 `agentKey` 等字段，**不存在** `agent reclaimed epochChanged:true` 这样的连写串，grep 必须分开匹配）；满足 `hold.v1 ∨ epoch.up.v1` 时还会先广播 `agent_up` 再 `gap`（`registry.ts:431-436`） | reload 成功，同 agentKey 换 epoch。前端可把「等待更新」收敛为完成（outdated reload 状态机的 D6/D8 同 key 追认）                     |
| `detach-timeout`       | 旧 activation 已 `session_detached`（10s 静默窗口，`agent/connection.ts:398-412`、`protocol/messages.ts:1373`）但新模块没起来 ⇒ `close("detach-timeout")`，即 **reload 失败/未完成**（新模块加载失败、reload 抛错被 TUI catch 成 `Reload failed: …` 等）                                                                                                                                                       | `{"msg":"agent down","agentKey":…,"reason":"detach-timeout"}`                                                                                                                                                                                                                                                                                                                   | reload 没有完成。卡片转 down；若 TUI 还活着，用户需在终端重试，前端按 `E_OFFLINE` 语义提示                                          |
| （无 bye）stale → reap | 进程崩溃 / socket 断开且没发 bye：hub 周期 tick 里发现 pid 已死 ⇒ 直接 `down(r, "pid-dead")`；否则先标 stale（`log.info("agent stale")` + `agent_stale` 广播），超 `reapMs`（60s）后 `down(r, "reaped")`（均在 `hub/registry.ts:713-718`，`reapMs/staleMs` 定义见 `protocol/messages.ts:1370-1372`）                                                                                                           | `{"msg":"agent down","agentKey":…,"reason":"pid-dead"}` 或 stale 后约 60s 的 `…"reason":"reaped"`（reason 非 quit；pi 侧崩溃另有 `crashes.json` 记录佐证）                                                                                                                                                                                                                      | 大概率崩溃或网络断。stale 期间 outdated reload 判据 `agentOffline` 已含 `card.state==="stale"`，会立即结算 `E_OFFLINE`，不必等 reap |

> 注意：上表日志示例是字段级的匹配指引，不是逐字 golden；实际字段顺序与完整行见
> `hub.log` 原文。

### hub.log 轮转与保留

`hub/log.ts` 的 `createHubLog` 按 `maxBytes`（默认 1MiB，`DEFAULT_LOG_MAX_BYTES`）轮转，保留
**3 份备份**：`hub.log` → `hub.log.1` → `hub.log.2` → `hub.log.3`（最老删除，`hub.log.4`
永不存在）。写入同步且 fail-soft（轮转/写入失败只重估 size，绝不抛进 hub）。#24 定位时曾因
只留 1 份备份丢失关键日志窗口，故扩为 3 份；门禁 `tests/web-hub/hub/idle.test.ts` 的
`createHubLog` describe。

## Left session-list activity (#46)

`toAgentCardView.activitySource` separates live main/child Agent activity from the unchanged
aggregate visualState (which also counts bash for sorting/grouping). Waiting only counts live
children, not the blocked main turn; down or raw stale snapshots never animate (even when waiting
takes visual precedence over stale), without suppressing retained counts. Both list densities
use `data-activity-source=agent|bash|none`: Agent activity wins the circular dot halo; bash-only
breathes the **whole terminal + count rounded-rectangle background** (#51), not an icon-circle
halo, card or meta row. `.agent-bash-activity` anchors an inset-zero, inherited-radius pseudo-layer
behind the foreground in an isolated stacking context: only that layer changes opacity, never the
icon/text or layout dimensions. Compact keeps its existing chip radius; detailed uses `--r-sm`
on just the bash segment without adding padding or a chip frame. Both active sources use CSS-only
3.2s breathing; reduced motion keeps a static background cue. Both-active never double-animates;
idle/stale/offline remain still. #43's screen-reader running label remains hidden visually. Independent
legacy cards without the optional field conservatively infer main activity only for running
without bash, or use an explicit child count. No transport/subscription changes.

## Current-turn hold stop (#47)

Composer's ring and provider-absent StopButton use `useHoldStop`: primary mouse/touch holds
700ms, fires once, and short pointer clicks never arm. Enter/Space keyup or independent
semantic click opens an explicit `StopConfirm` group with Cancel initially focused; an
independent focus-visible no-hold button keeps AT reachable without pointer-source guessing.
Pointer-derived clicks and key repeat cannot confirm. This is current-turn abort only, not
DetailHeader's managed-session stop; queued messages remain retained and the hold/confirm copy
says so.

Composer owns same-scope singleflight and provides the feature-local typed `HOLD_STOP_HOST`
read-only pending signal across ring/fallback remounts. It checks view permissions plus the
existing hub snapshot/connection and agent/session/epoch scope before the unchanged abort API;
missing scope fails closed, and an old Promise finalizer cannot release a newer scope's lock.
The reducer snapshot is read directly so a published scope/permission change cannot hide behind
parent-render batching. Root accepts native EventSource frame-task boundaries: published observable ABA must cancel;
artificial same-stack frames coalesced before the existing render gate publishes are not claimed
to be detectable. This feature does not change that transport/render contract.

Only one pointer/hold-deadline is active; a second finger is ignored. Touch contextmenu only prevents
default (a ~500ms menu must not cancel a 700ms hold), while mouse/pen contextmenu cancels.
Pointer cancel, movement beyond 8px/out, scroll, blur/hidden, unmount and observed busy/permission/
connection/scope changes cancel. Short taps show a neutral hold hint; real hold cancellation
says it did not stop. Feedback clears after 1.5s and on blur/scope/unmount. CSS-only progress
is independent of context usage, with static dashed feedback under reduced motion.

The rectangular transparent target is at least 44×44 while preserving the old 32px slot,
20px ring/11px icon and neighbouring attach/send geometry. Only the hit area expands; no
button background grows. The graphic anchors to the unchanged slot to preserve its legacy
vertical center on shorter phone cards. `useArmedConfirm` keeps its original settings-action
logic/signature; only its caller header changed.

Tests: `tests/web-hub/ui/{hold-stop,stop-button,context-ring,composer,use-control}.test.ts`.
Design, compiled-App evidence and manual physical-device/AT limits:
`docs/dev/hold-stop/{plan,runtime-notes}.md`. No wire/settings/schema changes.

## 助手回复 tokens/s（task58，UI 已实现并独验，尚未部署）

实现状态：P1 backend/protocol 与 P2 UI 已实现、合入并各自独立验收；**尚未部署，未做
真实服务/收费模型速度验证**。UI 通过 `entries.ts` 的唯一解析点和 production reducer
消费 core / 精确 mid 历史 map，在 `TxAssistant.vue` 以独立 span 显示费用和固定一位小数的
`20.0 tokens/s`，streaming 始终隐藏。设计定稿见
`docs/dev/web-hub-tokens-speed/plan.md`（r3.1 Root gate）。

> P2 补充：Responses 在有效 turn 内可由 raw `response.created` 建立单一候选，先到的
> `completed` 仅保存标量；之后每次 delta 的 binding、最终消息及 turn owner 必须精确匹配，
> 无 binding、候选冲突、重复终结或终结后同 ID/匿名 raw 均隐藏。此规则不放宽归属和终结门。

- **计时/信任**：分母为本地摄取点首个→最后一个非空 `text|thinking|toolcall` delta 的
  `performance.now()` 观测窗口；分子为 provider 上报、经原始事件证明且与最终 SDK
  `usage.output` 一致的总输出 token（含 reasoning，缺 reasoning 子字段不阻止显示）。
  同源计数不意味着本地 delta 完整覆盖服务端的隐式推理或所有生成耗时，不能视作 GPU 吞吐。
  Responses/Chat 依各自终结与身份关联门校验；Anthropic 因缺少逐事件响应 ID，采用保守
  单 lane 启发式，归属不确定即隐藏。无 delta/一次性返回/短窗口（<2 delta 或 <500ms）/
  streaming 中均无数字；失败、矛盾终结或非成功 stopReason 隐藏。已发 live 不因 turn_end
  未到而撤销，仅不持久。
- **持久 metadata 机制**：主 session metadata 持久化（显式 `turn_end.messageEntryId`
  mid，exact 最终对象引用 + 当前 ctx/session/loop/message generation + owner token 同步
  recheck，不匹配只跳过不写）；#77 批 2 明确扩大到 child 持久 metadata：同样只写
  `subagent:web-msg-speed` custom entry，不写 SDK assistant。child `/api/run/*` 详情在
  重新打开/刷新后由该 entry 恢复，旧历史不回填（recent 不兜底），已打开 drawer 的即时
  出数不在本批范围内。
  wire 唯一容器为 `WireEntry.piToolkitGeneration`（类型见 `protocol/messages.ts`，纯 optional
  追加，`WireEntrySchema` 开放、无 PROTO bump；投影在 `keys.ts` 条件展开，历史 map 上限
  512 已加载 entries）。`subagent:web-msg-speed` custom(data) 是 display:false 墓碑，
  旧 UI 不渲染。
- **边界**：不做收费/GPU 真实吞吐/字符估算/端到端兑底承诺，也不声称一般流式均支持
  tokens/s 显示（仅满足上述归属与本地观测窗口条件）。child 复用相同测速器/标量 binding
  与公开 `provider_stream_event` raw proof，口径仍是 **provider 总输出 token ÷ 本地首末非空
  delta 窗口**；不比主 session 更精确。缺 raw proof / usage 冲突 / 窗口不足 / 持久化失败 /
  换 owner / 锁定 / child extension 缺失一律跳过，不得估算。
  tests: `tests/web-hub/agent/{message-speed,message-speed-p0,wiring-message-speed}.test.ts`、
  `tests/web-hub/protocol/message-generation.test.ts`。

- **合并链回归**：`tests/integration/web-message-speed.test.ts`（自动归属 tier2）用真实
  SDK `createAgentSession` + `DefaultResourceLoader`（禁 user context/extensions 发现）和
  内存 fake Responses SSE，经公开 provider raw / message / turn 事件进入生产
  `wireMessageSpeed` / `eventTap`，所得 frames 进入生产 reducer / `buildTxEntries`；
  不手填最终 core。两条相同文本回复之间插入真实 SessionManager toolResult entry，
  断言公开 mid 精确匹配、10 tokens / 500ms / 2 delta → `20.0 tokens/s`、费用独立；第三条缺 raw reasoning 子字段仍显示；第四条缺合法 raw 总量则隐藏。实际 `manager.getBranch()`
  经 `projectSessionEntry` 新建 snapshot 恢复，并验证删除/replace metadata 无残留；
  metadata 不在 SDK assistant 对象、`buildSessionContext` 或后续模型 context 中。
- **真实浏览器验收**：同文件的 opt-in Chromium companion 使用已缓存的 Playwright
  （`PI_TOOLKIT_MESSAGE_SPEED_BROWSER=<已安装 Playwright 的绝对入口路径>`，不安装/联网），
  own `/tmp` Vite 页面加载真实 reducer / entries / `TxAssistant`，复用上述 SDK 产物，
  实跑 live → 刷新保留 → 删除 metadata 的替换 snapshot → 真刷新仍隐藏 → replace 后
  真刷新恢复，费用不变、767px 两 chip 不重叠。此为组件浏览器集成，不宣称真实 hub/App
  网络、真实 provider、收费覆盖率或物理移动设备已验证；默认 tier2 运行不启动浏览器，
  浏览器需显式设该环境变量。P2 的独立 App fakeHub 浏览器验收不替代本条删除链。
  child producer 的历史持久化见下；本批不 stamp child live core，已打开 drawer 仍不即时
  出数。UI 可消费合法 child live core 不意味着当前 child 请求会当场产生数值。
  旧历史永不回填，并非所有 Requests 都显示。

- **#77 批 2 child 接线/清理**：`src/index.ts` pre-guard child 分支经
  `src/child/wire.ts` 注入同步 `ctx => secureGuards?.recheckForWrite(ctx)` 权限闭包；plain 无
  guards 时明确返回 undefined，而未传闭包时测速器拒绝持久化。`src/child/message-speed.ts`
  仅在 `webHub.enabled && webHub.subagentTranscript !== "off"` 时安装 hooks/renderer，off 零注册
  零 append；复用 agent 叶子模块，不引入 hub runtime/client。`agent_start` lazy 建立
  sessionManager/sessionId + activation/session generation/owner token，`turn_start`、assistant
  `message_start`、原始未合并 `message_update`、`provider_stream_event`、`message_end` 与扩展
  `turn_end` 分别采样/验证/以公开 `messageEntryId` 关联后同步 append。raw port 同样复核当前
  ctx owner，观察到换 owner 即废弃整轮。无需 `session_start`；`agent_end`/`agent_settled`
  释放 pending/context，shutdown 仅作防御。无进程级注册表、外部订阅或 timer；hooks 只由
  child 自身持有，`AgentSession.dispose()` 不发 shutdown 也能整体 GC，不依赖 shutdown 退订。
  append 在扩展 `turn_end` 内完成，因此正常终态 runner seal 固定的 `finalLeafId` 祖先链可见
  metadata；seal 后补写不能用作兜底。验证：`tests/child/message-speed.test.ts` 的 fail-closed
  矩阵，以及 `tests/integration/subagent-message-speed.test.ts` 真实 SDK fake Responses 流 →
  RuntimeRunner seal → 持久 jsonl → run-file-reader → production reducer → RunTranscript drawer，
  同时验证 extension 缺失只隐藏、费用独立和 SDK/model context 不带 metadata。

### Activity drawer interaction

The Agents/commands rail is click-driven: opening stays open on pointer leave, without a pin control or hover preview. Close via the active rail button, ×, Escape, or an outside pointer in overlay mode. Docked open state remains in `webhub.fleetDrawer.open`; viewport breakpoints and their existing mode-transition reset behavior are unchanged.

## Composer inline schedule summary

The composer task popover retains its existing chip and open-only Todo section. Its read-only
schedule section starts as one keyboard-operable summary; opening it reveals the existing compact
`ScheduleRows`. The summary counts every task, shows the earliest enabled task's `relIn` token
when available, and separately counts paused tasks. The `pi-webhub:composer-schedule-expanded`
symbol stores a per-session fold map on the browser's hub instance: it survives composer remounts
and session switches, but not a page refresh. No storage, setting, or wire field is added. Empty
schedule projections do not render the section; a degraded projection still retains its existing
chip gate. The separate detail-header schedule dialog is unchanged.

## Subagent tool durations (#72)

Run transcripts reuse the main transcript renderer. The drawer passes the reducer's timing map
through to it; live `tool_execution_start` uses browser receipt time, and a snapshot taken after
start intentionally has no running timer. Completed results prefer the tap's measured duration;
when absent, newer pi toolResult messages carry their own per-execution `durationMs` (including
parallel executions), projected unchanged from JSONL. Older results without either value remain
unknown: batch timestamps are not per-tool measurements. No protocol or hub change is required.

## Feishu webhook 共存诊断（#70）

agent 侧 `feishu-admin.ts` 的通知共存检查与发送端复用
`feishu-notify/config.ts::resolveNotifyConfig`，读取统一 `feishuNotify` 覆盖、旧文件、环境和默认。
不再独立判断「env 或旧文件有 URL」：统一显式空 URL、enabled:false、secure/locked 都不能被旧文件
或环境重新打开。只向状态渲染输出 `configured` / `watchDefault` 两个布尔值；无凭据/wire/PROTO 改动。
建议用户编辑 `pi-toolkit.json` 的 `feishuNotify.watchDefault`，旧文件仍保留为回退。
字段优先级/空值/路径覆盖语义见 [plugin-merge README](../plugin-merge/README.md#70-统一通知设置与敏感面)。
门禁：`tests/web-hub/agent/feishu-admin.test.ts` + `tests/feishu-notify/extension.test.ts` 的发送/诊断一致性；
`feishu-spawn-http-golden.json` 等冻结件字节不变。
