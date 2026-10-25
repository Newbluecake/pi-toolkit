# Web Hub 托管 spawn / restore / 历史 · 开发者要点

> 何时读：改动 `src/web-hub/hub/spawn/**`、`webHub.spawn.*` 设置键、`/api/headless*`、会话重启恢复、删除/重启卡片之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`arch.md`、`plan.md`、`acceptance.md`、`created-dirs-plan.md`、`../web-hub-spawn-restore/`、`../web-hub-delete-session/`、`../web-hub-session-history/`

## Managed spawn

**Managed spawn (S1, `webHub.spawn.enabled`, default off; Linux-only, fail-closed platform probe)**: the hub
itself forks `pi --mode rpc` children in user-chosen directories (`known ∪ roots` admission, loopback-only
by default — `spawn.lan` off/known/roots) via `/api/headless*` + the `spawns` SSE event (Public projection;
owner-only fields per-request; the first-prompt body never persists anywhere). Identity is
`bootId+starttime+uid` ONLY (pi rewrites `process.title`, so cmdline never identifies a child); children
inherit the USER's umask (main.ts captures its pre-0o077 mask and the supervisor swaps it around each fork).
Orphan invariants L1–L5: intent on disk before fork, an independent reaper watchdog child TERM→KILLs
tracked orphans ≤12s after ANY hub death, boot-time recovery re-verifies identity before signaling, and
every signal is preceded by a sync identity re-verify. `spawn.v1` rides both cap surfaces only when
`config.spawn` exists. `webHub.spawn.lanConfirm` (default true; 2026-10-13 U1 拍板) gates the LAN
per-spawn `E_CONFIRM_REQUIRED` round-trip — `false` drops LAN to loopback's `unknown-dir` rule (the
session-open fork confirm is a real decision and never skipped); the waiting state after a 202 lives
on the sidebar SpawnRow (the picker closes on `awaiting`). SP13's
`tests/integration/web-hub-headless.test.ts` (H1–H8 hard gates, real hub
child processes + `fixtures/fake-rpc-pi.mjs`) and `tests/conformance/rpc-spawn.test.ts` (real pi) are the
S1 merge gates — design: `docs/dev/web-hub-spawn/{arch,plan,acceptance}.md`.

## Created dirs

**Created dirs (created-dirs plan r2)**: a folder made through `POST /api/headless/mkdir` inside `spawn.roots` is recorded (`hub/spawn/created-dirs.ts`, `<stateDir>/spawn/created-dirs.json`) as known source ④ — fully `known:true` (skips the unknown-dir confirm; `lan:"known"`/Feishu `spawnScope:"known"` widen the same way; LAN `confirm:"always"` unchanged), admission re-checks TTL/identity/fresh roots and the fresh-start pin adds `{canonical:true}`; plaintext-LAN scope cap stays (accepted cookie-sniff residual, arch §6.1); LAN-only `E_DIR{not-allowed}.detail` (`plaintext-lan|lan-known|outside-roots`, loopback byte-identical). Design: `docs/dev/web-hub-spawn/created-dirs-plan.md`; golden deltas: `created-dirs-golden-delta.md`.

## Restore across hub restarts

**Restore across hub restarts (`webHub.spawn.restore`, default true, only under `spawn.enabled`)**: a
graceful restart / crash re-forks every recoverable managed session on the new hub as kill-old-then-fork
(`--session <file>` or `--session-id <id>`, never `--model`), same spawnId, new agentKey carrying
`restore.prevAgentKey`; L6 — never fork while the old identity's death is not `confirmed`; intent persisted
before every fork; `/webhub stop` leaves a one-shot `<stateDir>/spawn/restore.veto` (restart clears it);
`restore:false` is byte-identical to pre-restore behavior. HR1–HR7 / CR1–CR3 gates — design:
`docs/dev/web-hub-spawn-restore/plan.md`.

## Relaunch

**Relaunch an offline managed session (`POST /api/headless/relaunch`, cap `spawn.relaunch.v1` —
advertised only when `spawn.restore === true` AND the platform probe passed)**: clicking a
stale/offline AgentList card bound to a TERMINAL managed record re-forks its session through
the SAME restore job (`supervisor.relaunch()` rewrites the record to `starting{reaping}` with
`restore.prevAgentKey` = the old card, then `runRestoreJob`: L6 death re-check → D7 session
preflight → `forkInto` with `--session <file>` / `--session-id <id>`, never `--model`).
Refusals: unknown spawnId or restore-off ⇒ 404; death not `confirmed` ⇒ 409
`E_AGENT_ONLINE{exit-unconfirmed}` (B-alive); no/invalid sessionId or a pending delete ⇒ 409
`E_BAD_REQUEST{no-session|removing}`; the persisted session file gone/tampered ⇒ 410
`E_SPAWN_GONE{session-missing|session-invalid}`; a record without a `sessionFile` gets ONE
bounded locate-by-id in pi's default session dir (`restore-plan.ts`'s `locateSessionFile`)
before the `--session-id` fallback. Idempotent: a non-terminal record ⇒ 202 `dup:true`, never
a second fork. A relaunch re-anchors the lifetime (`lifetimeAnchorAt`, runtime-only — restore
D14's createdAt anchor stays untouched for boot restores). UI: `logic/spawn.js`'s
`relaunchableFor` gates the affordance on the cap; the whole stale card becomes the action
(capture-phase intercept, the × / rename buttons pass through), success navigates to the old
key's detail where the existing `successorOf` follow lands on the new live card.

## Delete session

**Delete session (`POST /api/agents/remove`, web-hub-delete-session plan v2)**: an AgentCard / SpawnRow two-step
delete removes the card (and, for a managed session, stops the process first); the session jsonl is never deleted.
Three invariants: **B-alive** — a record/card is dropped only after a read-only identity probe confirms death (or
`noProcess` evidence); alive/unknown ⇒ 409 `E_AGENT_ONLINE{exit-unconfirmed}` and the card comes back, an online TUI
is refused (`online`), an offline TUI/external rpc card is dropped with no signal at all; **B-fork** — replaying the
same create `id` within the dedup TTL after a delete ⇒ 409 `E_BAD_REQUEST{spawn-gone}`, never a fresh fork;
**B-stream** — `agent_removed` is published only after dropAgent + clearing that agent's SSE subscriptions.
`removeIntent` persists synchronously so a hub crash mid-delete converges on the next boot. LAN with `spawn.lan:"off"`
cannot delete a live managed card (403 `lan-off`). Design: `docs/dev/web-hub-delete-session/plan.md`.

## Session history

**Session history (`webHub.spawn.history`, default on; cap `spawn.history.v1` only when config.spawn exists AND the
flag is true AND the platform probe passes; `hub/hub.ts` is the sole assembly point — session-history plan P-int)**:
`GET /api/headless/history` lists every past session under the agent dir (continuable fd-anchored enumeration — a
swapped/symlinked dir is never followed, HH14), and a POST with a `session` ref resumes it in place
(`--session <abs>`, never `--model`) or forks it through a hub-made snapshot in `<stateDir>/spawn/fork-src/` (the
source file is never touched; the new header's `parentSession` dangles at the deleted snapshot by design). In-place
resume requires kind positively `main` AND a best-effort occupancy check (live card / managed record / full same-uid
`/proc` scan + a synchronous re-stat for pid reuse); anything detected or unclear forces a fork with an explanatory
`proofGap`. **The check is best-effort by user ruling (§14.1)** — residual windows W1–W7 are disclosed in the UI
footer, incl. that pid reuse right after a pi exits (W5) and swap-and-restore during startup (W7) are undetectable,
and that **restore re-forks deliberately skip the occupancy proof** (W6 product exception — RH4 pins it as a
documented limitation). Paths are fd-anchored (three-level `O_NOFOLLOW` + dev/ino + nlink + realpath re-checks before
spawn and again at goLive — a swapped file stops the child with `session-swapped` and its coordinates are never
adopted); restore re-forks get the same capture/verify when history is on (v3.4 X1: every `--session` restore, no
origin distinction). History's local IO is budgeted (≤2 concurrent fs ops via its IO gate + fd ledger, no background
timers; the starvation suite pins that preview/uploads/scrypt stay live). The `historyProcFs` test seam is
programmable ONLY through `HubDeps.spawnSeams` (`main.ts` never sets it; env/config cannot reach it — pinned by
`tests/web-hub/hub/hub-history-assembly.test.ts`). Gates: HC1–HC7 conformance (real pi argv/header facts), HH1–HH14
integration (real hub × fake pi + starvation), RH1–RH4 conformance (real pi + real hub restore). Off ⇒ the hub stays
byte-identical (no cap, no service, routes 404, restore carries no path pin). Design:
`docs/dev/web-hub-session-history/plan.md`.
