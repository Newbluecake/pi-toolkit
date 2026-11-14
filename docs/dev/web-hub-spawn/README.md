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
S1 merge gates — design: `docs/dev/web-hub-spawn/{arch,plan,acceptance}.md`. 出厂默认 2026-11-04 起
`maxProcesses=10, maxPerPrincipal=10`（原 4/2，见 arch §6.2 表）。

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
`E_SPAWN_GONE{session-missing|session-invalid}`. Terminal relaunch now requires an explicit
provable ordinary default-tree `sessionFile`; custom/unknown/id-only targets are rejected
with `410 E_SPAWN_GONE{session-invalid}`, without locate-by-id or content scanning (Q1=1).
Unmarked nonterminal live/custom boot restores retain their legacy D7 contract. Idempotent: a non-terminal record ⇒ 202 `dup:true`, never
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

## Retained exited discovery (`spawn.exited.v1`, r3)

With `spawn.restore === true` **and** a passed platform probe, both hub cap surfaces append
`spawn.exited.v1` from the same array tail (no PROTO change, no new record wire fields).
The UI's history dialog can consume existing `spawns.items` for recent exited records and
`failed` records carrying restore evidence, including after registry removal/reconnect/Hub
restart. The action is explicit **same-spawnId relaunch**, not fresh create, history-ref
fabrication or automatic fork/prompt replay. The parallel UI package owns presentation.
`restore:false` retains the exact old disk/cap behavior and performs zero retention IO.

### Default-tree provenance, not domain attestation (Q1=1/Q2=1)

Only direct JSONL children of `<agentDir>/sessions/<pi cwd encoding>/` can gain terminal
coordinates. Lexical `resolveAgentDir`, `sessionPersisted`, and disk JSON are not authority.
`retained-session.ts` opens from `/`, then each ancestor through a private parent fd under
proc-fd with `O_DIRECTORY|O_NOFOLLOW`, comparing expected dev/ino **before descending**.
Sessions/cwd directories must be owned; leaf lstat must show owned regular, nlink=1, no
symlink. Missing leaf ENOENT is allowed; missing directories and other errors fail closed.
Metadata capture never reads content, enumerates candidates, creates directories or consults
secure registrations/vaults. Custom/secure/unknown coordinates cannot gain new terminal
retention or manual restore authorization. This relies on the product contract that agentDir
is not nested in a registered vault; it is not general bind-mount/domain attestation.

Each supervisor owns its guard factory. Opaque runtime certificates bind factory, full
`{spawnId,cwd,sessionId,sessionFile}` and coordinate revision. Proofs are prepared only on
adoption/real tuple change, the first actual file observation, a single boot-terminal batch,
or the current relaunch/job target. Repeated same-coordinate session/status events do not
walk the chain. A first file observation revalidates the previous missing-leaf parent chain,
not a newly captured replacement. An invalidated revision has no retained authorization.

**`toStored`/`storedSnapshot`/save/debounce/expired shutdown flush do zero new retention FS**:
only matching cached provenance can preserve terminal or guarded-state coordinates. No
cache means stripping the three coordinates, keeping the sticky restricted marker/expected
baseline. Finalize/recovery, fork→identity-save→reaper.track, and remove→save→stop do not
prepare proofs. Boot adoption runs only after original reaper assembly/tracking/enqueue;
shutdown flush precedes runtime-cache disposal. No new timer or background scan is added.

One monotonic work budget caps a target preparation (or the **whole boot batch**) at
20 ms / 512 operations / 128 segments. Each operation/candidate checks the same budget
before starting, and checks cumulative time afterwards. All acquired fds close in finally,
including after exhaustion. The clamp is a local hub mirror, not a core/secure dependency.
A synchronous syscall itself cannot be interrupted: this is a no-further-work bound, **not**
a hard wallclock guarantee for kernel D-state IO. Budget failure conservatively loses
retention, never delays safety bookkeeping to prepare unrelated records.

### Sticky disk constraint and D7 leases

Store envelope remains v2. Optional disk-only `sessionGuard:{kind:"default-tree-v1",
baseline?,lazyIntent?}` is strictly validated; baseline holds a tuple SHA-256 digest, exact
root-to-parent dev/ino chain and optional previously observed leaf identity. Digest is a
binding/error check, not a signature. New bytes count in the unchanged store budget.
Neither coordinates nor guard/baseline/lazyIntent appear in Public/Owner/SSE/GET projections.

A cached adoption certificate is **not read permission**. Both `relaunch()` preflight and
`restoreForkSync()` acquire a fresh fd-anchored reader before `planSessionArgv` D7. Expected
ancestors/leaf are checked before header read; the exact-file reader uses only the verified
fd (`NOFOLLOW|NONBLOCK`, fstat again) and expires at callback return. It cannot cross await,
queue or restart. `sessionGuard` stays sticky through starting phases, failed retries, live
stability cleanup and reload; a restricted-but-unproven record cannot fall into legacy
reading. History=false still assembles this guard, but no HistoryService/generation/scanner.
Existing history capture/goLive pin remains an additional check when history is enabled.

A replaced chain between 202 and job execution, or between starting save and a new Hub,
therefore fails before content read/new fork. L6 death confirmation remains prior to new
fork; existing fence/veto/restore-intent and native unmarked live-crash recovery remain.
Pi itself still opens PATH after fork: existing W-class concurrent swap-and-restore races
and same-uid/mount residuals are **not** claimed eliminated by the fd header reader.

### Lazy never-seen file binding

Pi 1.5 `--session-id` can report a new ISO-timestamp basename without creating a JSONL until
conversation starts. Only a D7-verified never-seen missing leaf (no persisted evidence or
old leaf identity), with the actual exact `--session-id <id>` tail, gets a one-attempt runtime
permit. A disk `lazyIntent:{attempt}` is saved before fork; the permit activates only after
actual child identity-save and reaper.track, by assignment only (no new FS in that window).
The first registering child's identity/id/cwd/deadline/attempt/revision must match. The
**actual session frame's cwd** must byte-match the original record (and thus the permit),
independently of a correct hello cwd, before any candidate proof or permit consumption.
Guarded exact binds and subsequent session switches check this too, even for unchanged
id/file. A mismatch stops via `protocol_error`/`session-swapped`, preserving the old
coordinates and any unresolved lazy intent; it cannot substitute the old record cwd for
the report. One reported same-parent pi ISO-basename is reverified nofollow against the expected parent
chain. Success atomically moves coordinates/revision/cache, consumes the permit and clears
intent before the pure live save. It does not create files or replay a prompt.

Actual `--session <file>` remains exact; ever-observed then missing is still 410
`session-missing`, never lazy recreation. Forking/registering restart or actual-child failure
before binding cannot revive a permit from JSON: unresolved lazyIntent rejects new forks
with existing `session-invalid`, bounded detail `lazy-binding-unresolved`, no scan/guessing.
Only authoritative never-forked paths clear intent for another explicit retry (including
pre-fork store/cwd failures, synchronous spawn throw and no child). Relaunch retains
`noProcess` through both the persisted reaping transition and the restore job's L6 check;
only the existing synchronous new-fork intent stretch clears it with the old identity.
Missing pid without this evidence remains unknown, never implicitly confirmed. An actual
fork with failed identity persistence keeps its unresolved intent, even after verified exit.
Migration whose live save fails can leave old unresolved disk intent; the next Hub conservatively
refuses it instead of guessing a possibly conversation-bearing new filename.

### Retention budgets and compatibility

The runtime Map's regular terminal limit remains 20, oldest updatedAt first. The store's
16 nonterminal / 20 terminal / 64 KiB soft write target / 256 KiB read cap / 200 ms debounce
are unchanged. Disk trimming removes whole terminal records, never guard/file/evidence
individually. Nonterminal identities alone can exceed 64 KiB and evict **all** terminal
records; no promise of 20 or even one across restart. Store trimming does not mutate the
runtime Map: browser refresh can see an item that a later Hub restart cannot. JSONL is not
deleted. There is no second unbounded index or automatic recovery of removed records.

Old v2 records without guard still load; old terminal coordinates need first current proof,
and old records already lacking coordinates cannot be repaired by guessing. New Hub×old UI
keeps field/request/state-enum parsing compatible, not entire retained sets/state sequences
byte-identical. Custom terminal refusal and ordinary retained relaunch are declared behavior
changes. An old Hub may ignore/drop the optional disk guard: **downgrade does not preserve
the new security guarantee**. No frozen fixture was regenerated for this implementation.
