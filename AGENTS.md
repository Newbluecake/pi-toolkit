# AGENTS.md

Guidance for AI coding agents working in this repository.

> **硬规则**：改动 `src/<x>/**`（含其测试、设置键、wire 字段）前，先 read 下表『必读』列的 README；README 里是该子系统的不变式、门禁和残留风险。表外的设计细节在 `docs/dev/<feature>/`。新的实现细节写进对应 README，不要再写回本文件。

## What this is

`pi-toolkit` (formerly `pi-subagent`) — a toolbox extension for [pi](https://github.com/earendil-works/pi)
(the `@earendil-works/pi-coding-agent` CLI) whose flagship is an anti-hang subagent system: a drop-in
replacement for the core of `@tintinweb/pi-subagents`: it provides the `Agent` / `get_subagent_result` / `steer_subagent` /
`abort_subagent` tools (the main-session `Agent` is background-only — every call returns a run_id and completion is
notified; only the nested `Agent` injected into a child keeps the blocking default, see
`docs/dev/agent-background-only/plan.md`), the `SubagentWorkflow` orchestration tool (also background-only: returns a
`wf_…` id, notifies on terminal state, managed through `get_subagent_result` / `abort_subagent` — see
`docs/dev/workflow-background/plan.md`), the `/agent` command, a live
fleet widget (agent tree), a notification delivery subsystem, and session-aware scheduled tasks (`src/schedule/`). Beyond that
core it optionally (settings-gated) overrides pi's built-in `bash` with auto-backgrounding plus
a `bash_job` manager tool, provides `switch_context` / `compact_context` / `set_compact_threshold`
for model-authored context handoff, manual and threshold-triggered compaction, and implements the
message fabric (`message_agent`, fire-and-forget inter-agent messaging routed along the agent tree).

The whole point of the project is **zero-hang guarantees**: every run has layered deadlines
(watchdog sub-phase budgets + total budget), an escalating reaper for orphans, and persistent,
acknowledgeable delivery of results. Preserve these invariants when editing.

Renamed `pi-subagent` → `pi-toolkit` (2026-09): runtime identifiers keep the old name on purpose —
the settings file `~/.pi/agent/pi-subagent.json`, `Symbol.for("pi-subagent:*")` host guards,
`subagent:*` customTypes/event channels, widget/status keys and the `[pi-subagent]` log prefix all
carry existing session data and cross-module contracts. Do NOT "finish the rename" inside `src/`.

The eight merged plugins (HUD, web_search, todo, ask_user, Feishu notify, session-nav, memory, traffic) and their pre/post-guard registration are summarised in invariant I3; full text: `docs/dev/plugin-merge/README.md`.

## Commands

```sh
npm install          # dev setup (Node >= 22, enforced by engines + CI)
npm run build        # tsc -p tsconfig.build.json → dist/
npm run build:web    # web-hub UI (vite) → dist/web-hub-ui/ — toolchain needs Node ≥22.12 (mermaid's engines; CI has a 22.12.0 job)
npm run check:web    # UI bundle gates (CSP/size/provenance/licences) · npm run probe:mermaid = real-browser mermaid gate (Chromium+Firefox, not in CI)
npm test             # vitest run — 17,000+ tests; must stay green
npm run typecheck    # tsc --noEmit (strict; see tsconfig flags)
npm run format       # prettier --write .
npm run format:check # CI gate
```

CI (`.github/workflows/ci.yml`) runs format:check → typecheck → test → build on Node 22.
Run all four locally before pushing. `fs.globSync` is used, so Node < 22 is unsupported.

## Global invariants

Each holds for every task; details and the evidence live in the README of the subsystem.

- **I1 zero-hang**: every run has layered deadlines (watchdog sub-phases + total budget), an escalating reaper, and persistent acknowledgeable delivery. Every computed deadline goes through `clampSpanMs`; long delays use `createSegmentedClock`.
- **I2 assembly only**: `src/index.ts` registers tools/commands/hooks once per `activate()`; no logic there. `src/stack.ts` rebuilds the session stack on every `session_start`.
- **I3 HOST_KEY guard**: `initSecureDomain()` is the FIRST statement of `activate()`. Pre-guard (child sessions keep them): secure guards, command capture, web_search, date, todo, prompt-section hub, memory, child wiring (`wireChildSession`, bash child, traffic recording hooks). Post-guard (main session only): hud, feishu-notify, session-nav, ask_user, title, topic-switch, web-hub, schedule, traffic host wiring.
- **I4 no module-scope mutable state**: `/reload` re-activates in the same process without busting the module cache. Cross-activation sharing only via `Symbol.for("pi-subagent:*")` globals with stated capacity/TTL.
- **I5 `unref()` every timer** (a ref'd timer wedges `pi -p`).
- **I6 child sessions stay inert**; child extensions are discovered only from settings.json (use `pi install`, never `-e`).
- **I7 runtime old names stay**: `pi-subagent.json`, `Symbol.for("pi-subagent:*")`, `subagent:*` customTypes/events, widget/status keys, `[pi-subagent]` log prefix. Never "finish the rename" in `src/`.
- **I8 pi-free boundaries**: `src/core`, `src/prompt-sections`, `src/git` import no pi (`tests/boundary/pi-free.test.ts`); hub/protocol import only `node:*`, typebox and whitelisted files (`tests/web-hub/boundary.test.ts`) — the whitelist only tightens; share code via a mirror copy in `web-hub/protocol/`.
- **I9 off ⇒ byte-identical**: a settings-gated feature that is off leaves hooks, prompts and output unchanged, proven by the golden files below. Non-live settings need `/reload` (hub side also `/webhub restart`).
- **I10 append-only wire**: `StatusInfo` open slots, optional frame fields and caps; no PROTO bump; old hub × new agent (and reverse) must stay byte-identical.
- **I11 secure domain**: D2/D3/D4 guards and D8 forced-off features (`fabric.crossSession`, `externalAgents.droid`, `feishuNotify`, `traffic`, schedule) cannot be re-enabled by any settings path.
- **I12 tool vs skill**: tool mechanics live in tool/parameter descriptions; strategy lives in `skills/` (the only copy — none under `~/.agents/skills/`).

## Frozen artifacts

Check before and after any refactor: `git diff --quiet origin/dev -- tests/fixtures/`.

<!-- prettier-ignore -->
| 等级 | 文件 | 规则 |
| --- | --- | --- |
| A 永不重生 | `tests/fixtures/` `fabric-xs-off-golden.json`, `fabric-wake-off-golden.json`, `fabric-xs-reply-off-golden.json`, `compact-hint-golden.json`, `schedule-off-golden.json`, `secure-off-golden.json`, `secure-contract-parity.json`, `web-hub-ui/keepalive-legacy-golden.json`, `bash-tools-golden.json` (test refuses `UPDATE_BASH_GOLDEN` once the file exists), `quota-kimi-zai-golden.json` ("NEVER regenerate"), `tools/agent-nested-surface-golden.json` (FROZEN byte-for-byte), `legacy-xs-v071/` (prettier must not touch) | a change means behaviour changed; refactors must leave them identical |
| A′ 仅 USAGE | `secure-launcher-off-golden.json` | update only when the launcher USAGE text is changed on purpose |
| B 契约 golden | `available-models-golden.txt`, `feishu-spawn-http-golden.json`, `memory-legacy-golden.json` (+ `memory/{tiered,doctor}-golden`), `message-agent-wake-schema-golden.json`, `web-hub-ui/quota-legacy-golden.json`, `version/version-anchor-golden.html`, `quota/topbar-no-quota-golden.html` | update only for a declared outward behaviour change; say why in the commit |
| C 按规则刷新 | `preview-denylist-corpus.json` (bump `PREVIEW_DENYLIST_VERSION` + run `node scripts/dev/preview-denylist-audit.mjs`), `docs/dev/preview-perf/baseline*.json` (only `npm run probe:preview-perf -- --write-baseline`) | per its own rule |

## pi peer bump checklist

1. Change the pi peer range in `package.json` (now `>=1.0.0 <1.4.0` for each of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) only deliberately, and re-check `src/adapters/pi-compat.ts`.
2. Run `npm run test:conformance` (= `vitest run tests/conformance`, the whole directory): `pi-boundary`/context-switch capability, `consult-preserve.test.ts` C1–C7 (remove with #40), `fabric-wake.test.ts` C-P1–C-P5, `fabric-xs.test.ts` C-X1–C-X11, `schedule.test.ts` C-S1–C-S8 (C-S6 skips without tsx), `traffic.test.ts` + `traffic-coexist.test.ts`, `cmd-history.test.ts`, `slash-args.test.ts`, `rpc-spawn.test.ts`, `keepalive-pipeline.test.ts`, `web-resume.test.ts`, `secure-gocryptfs.test.ts` C1–C5 (self-gating), and the rest. The premises each suite pins are in the matching README (traffic → `docs/dev/traffic-merge/README.md`; cmd-history → `docs/dev/web-hub/README.md`; fabric → `docs/dev/fabric-cross-session/README.md`; schedule → `docs/dev/scheduled-reports/README.md`; consult → `docs/dev/consult/README.md`).
3. Before upgrading pi or droid also run `PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts`; before upgrading gocryptfs run `tests/conformance/secure-gocryptfs.test.ts`.
4. Confirm the A-tier frozen artifacts did not change (above).

## Repository layout

Format: entry — one-line role | README to read first and when. `src/*` rows without a README are covered by their own header comments.

<!-- prettier-ignore -->
| 条目 | 必读 README · 何时读 |
| --- | --- |
| `index.ts` — package-root entry **for pi** (the sole `pi.extensions` manifest target). pi loads extensions through jiti (runtime TypeScript), so git installs need no build step. Thin re-export of `./src/index.js` (jiti maps the `.js` suffix to the `.ts` file). Keep it thin. | — |
| `index.js` — companion entry for plain Node consumers, re-exporting `./dist/index.js` (package.json `main`/`exports`). Not used by pi. | — |
| `skills/` — agent skills shipped with the package (`pi.skills` in package.json; also in npm `files`): `dev-flow` (dev workflow lanes, model routing, parallel dispatch) and `agent-handoff` (structured handoffs and consult usage, backed by `docs/dev/fabric-v2` experiments). They are the source of truth — do not keep a second copy under `~/.agents/skills/` (pi keeps the first skill of a name and warns on collisions). Tool mechanics belong in tool/parameter descriptions; skills carry strategy, evidence and costs. | — · 改 skill 前先读 `skills/*/SKILL.md` 自身 |
| `src/index.ts` — **assembly only** (invariant I7): register tools/commands/hooks once per `activate()`, own the HOST_KEY host-claim guard, rebuild the session stack on every `session_start`. No logic lives here. | — |
| `src/stack.ts` — the per-session stack builder (`buildSessionStack`): constructs stores/services/watchdog/reaper/scheduler/widget from `ExtensionContext`. The previous session's pieces are disposed at the top of the next build (no stack dispose hook). | — |
| `src/core/` — pure domain (no pi imports): state machine, deadline budgets (`clampSpanMs`, `createSegmentedClock`), ids, types, worktree-origin registry. | `docs/dev/subagent-core/README.md` · 动 run 状态机/deadline/budget/延长前 |
| `src/runtime/` — runner, session driver, watchdog, reaper, slot pool, dynamic tool scoping, child-extension-missing diagnostic. | `docs/dev/subagent-core/README.md` · 动 runner/driver/watchdog/reaper 前 |
| `src/service/` — spawn/query services, run registry, target resolution, spawn admission (pool-full, model registry, `timeoutPolicy`). | `docs/dev/subagent-core/README.md` · 动 spawn 准入/Agent 工具派发前 |
| `src/child/` — child-session assembly entry point (`wire.ts`'s `wireChildSession`, called from `src/index.ts` pre-guard when `isChildSession`, alongside `wireMemory`/`wireChildBashJobs`): composes `wireChildContextSwitch` + `wireChildKeepalive`, wiring their one cross-cutting signal (a committed boundary switch invalidates the keepalive prefix like a compaction does). Reads only the existing `isChildSession` boolean — does not touch `HOST_KEY`. | `docs/dev/context-switch/README.md`、`docs/dev/cache-ttl-keepalive/README.md` · 动子会话接线前 |
| `src/ask-user/` — merged interactive `ask_user` tool + TUI/RPC question components; optional web-hub remote port. | `docs/dev/ask-user-async/README.md` · 动 ask_user/远程作答前 |
| `src/feishu-notify/`, `src/hud/`, `src/web-search/` — merged plugins: Feishu notify cards, HUD footer, `web_search` tool. | `docs/dev/plugin-merge/README.md` · 动这三个插件或判断 pre/post-guard 注册前 |
| `src/session-nav/` — `/resume-recent`, `/clear`, bare `exit`, resume-list title cleaning; subagent sessions hidden from resume lists. | `docs/dev/web-resume/README.md` · 动 session-nav/web resume 前 |
| `src/bash/` — bash auto-background override, `BashJobManager`, persisted job store, child settle-hold, timeout grace. | `docs/dev/bash-timeout-grace/README.md` · 动 bash/bash_job 前 |
| `src/compact-hint/` — context-usage tick/nudge/force-compaction hints, dynamic price-aware threshold; compact tools. | `docs/dev/compact-hint/README.md` · 动 compact.* 设置/提示逻辑前（golden 勿重生） |
| `src/context-switch/` — model-authored handoff (`switch_context`), pending store, `session_before_compact` hook, child-session capability state machine. | `docs/dev/context-switch/README.md` · 动 handoff/子会话 switch 前 |
| `src/cache-ttl/` — prompt-cache TTL modes, keepalive pings + breakers, provider evidence, `/cache-ttl`, child keepalive, warmth. | `docs/dev/cache-ttl-keepalive/README.md` · 动 keepalive/断路器/TTL 前 |
| `src/fabric/` — inter-agent message fabric: tree routing, wake phase 1, cross-session xs (reply, channels, broadcast, unread inbox, aliases). | `docs/dev/fabric-cross-session/README.md` · 动 message_agent/message_session/xs 协议前（三个 off golden 勿重生） |
| `src/consult/` — in-turn expert consultation (`consult` tool). **#40 将删除。** | `docs/dev/consult/README.md` · 动 consult 前（#40 将删除） |
| `src/todo/` — Claude Code-style task tools + aboveEditor widget + web projection. | `docs/dev/todo-web/README.md` · 动 todo 前 |
| `src/memory/` — cwd-keyed project memory (tiered injection, `memory` tool, `/mem`, journaled tidy/restore). | `docs/dev/memory/README.md` · 动 memory/tidy 前（memory golden 勿重生） |
| `src/sysprompt/` + `src/prompt-sections/` — frozen-snapshot system-prompt sections with tail updates; pi-free half in `prompt-sections`. | `docs/dev/sysprompt-stable/README.md` · 动任何 system prompt 动态段前 |
| `src/web-hub/` — browser UI over a per-machine hub daemon (`webHub.enabled`, default off): protocol/hub/agent/ui, control plane, LAN, Feishu bot, panels. | `docs/dev/web-hub/README.md`（索引 + 总体不变式）· 动 hub/协议/wire/UI 前；子系统另读下面子行 |
| ↳ `src/web-hub/hub/feishu/` — Feishu bot, durable receive, cross-session mirror. | `docs/dev/feishu-bot/README.md` · 动飞书 bot/xs mirror 前 |
| ↳ `src/web-hub/hub/spawn/` — managed spawn, restore, relaunch, delete, session history. | `docs/dev/web-hub-spawn/README.md` · 动 spawn/restore/历史前 |
| ↳ `src/web-hub/hub/preview/` — content/dir/HTML preview, denylist. | `docs/dev/web-hub-preview/README.md` · 动预览/denylist 前 |
| ↳ worktree diff / graph endpoints (`/api/worktree-diff/*`, `/api/worktree-graph`, `src/git/` graph args). | `docs/dev/worktree-diff/README.md` · 动 diff/graph 或升级 git 前 |
| ↳ `src/web-hub/hub/proxy/` — local-service proxy and in-page link preview. | `docs/dev/web-hub-proxy/README.md` · 动代理/链接预览前 |
| ↳ channels / aliases in the web UI. | `docs/dev/fabric-cross-session/README.md` · 动频道/别名 UI 前 |
| `src/archive/` — fleet-drawer archive control (`webHub.archiveAfterMin`); design in the web-hub README. | `docs/dev/web-hub/README.md` · 动归档前 |
| `src/topic-switch/` — new-request relevance judge → suggest a clean new session. | `docs/dev/topic-switch/README.md` · 动 topic-switch 前 |
| `src/git/` — pi-free bounded git executor (`run.ts`: hard deadline, process-group kill, stdout/stderr caps, unref'd timers) + `git worktree list --porcelain` parse/scan (`worktrees.ts`) + `~` path labels (`path-label.ts`). | `docs/dev/worktree-diff/README.md` · 动 graph/diff 的 git 参数前 |
| `src/config/` — agent-type registry (Markdown frontmatter), fuzzy model hints, settings file. | — |
| `src/external-agent/` — external agent provider framework (virtual provider `droid/<model>`). | `docs/dev/external-agent/README.md` · 动 droid adapter 前 |
| `src/quota/` — quota-aware dispatch: provider adapters, laddered warnings, spawn fast-fail gate, droid pools. | `docs/dev/quota/README.md` · 动 quota 前 |
| `src/sysload/` — load-aware dispatch: /proc samplers, sustain/recover state machine, spawn gate, hub load frames. | `docs/dev/sysload/README.md` · 动 load.* 前 |
| `src/secure/` — encrypted session vaults over gocryptfs (`pi-secure` launcher + plugin guards). | `docs/dev/data-encryption/README.md` · 动 secure 或新增读设置/写盘功能前（D8 强制关闭） |
| `src/traffic/` — provider traffic recording (`node:sqlite`, default off), rewrite rules, web viewer. | `docs/dev/traffic-merge/README.md` · 动 traffic 前 |
| `src/schedule/` — session-aware scheduled tasks (cron/once; default off). | `docs/dev/scheduled-reports/README.md` · 动 schedule 前（schedule-off golden 勿重生） |
| `src/reload/` — deferred `/reload` (settings-gated by `reload.defer`): an editor wrapper rewrites exact `/reload` submissions to `/agent reload`, which parks the reload while subagents/workflows are active and fires it (via a followUp `/agent reload fire` message) once the fleet settles; `now` forces, `cancel` cancels. | — |
| `src/goal/` — `/goal` objective-driven loop: pure state machine (four phases), text builders, appendEntry session store, `agent_settled` loop hook (until-cmd via `pi.exec`, verifier via `spawnAndWait` + schema, delivery/eval watchdogs), `/goal` command. See `docs/dev/goal/goal-plan.md` (v4 评审修订为最终施工口径). | — |
| `src/delivery/` — notification outbox: staged → finalize → batched → delivered → consumed, with caller-ack suppression and a coalescer for hold-window merges. | — |
| `src/workflow/` — `SubagentWorkflow` engine: orchestrator, journal/replay, background registry, `agent()` queue/experts/worktree. | `docs/dev/workflow/README.md` · 动 workflow 前 |
| `src/adapters/` — pi-facing shims (compat probing, outbox store, run log). | — |
| `src/tools/`, `src/commands/`, `src/ui/`, `src/mention/`, `src/rpc/`, `src/extensions/` — tool surfaces, `/agent` command (status/settings/costs), fleet widget + TUI settings editor, `@label` mentions, RPC, extension points (worktree isolation). RPC spawn success replies weakly carry `{ runId, label? }`; keep the schema result opaque. | — |
| `src/date/`, `src/title/`, `src/vendor/` — `[date]` message injection; session-title generation; vendored `qrcodegen`. | —（无专属 README；title 设计见 `docs/dev/title/plan.md`） |
| `tests/` — mirrors `src/` plus `integration/` and `fixtures/`. | — |
| `docs/dev/` — per-feature design docs (agent-background-only (supersedes auto-background), workflow-background, workflow-agent-queue (agent() 排队 + workflow 宽限/延长), delivery v2, bash-auto-background, subagent-push/fabric, compact-hint, timeout-notify (宽限+延长), consult, sysprompt-stable (system prompt 冻结快照 + 唤醒回放), ...); read the matching one before changing that subsystem. Subsystem developer notes live in `docs/dev/<x>/README.md` — see the 必读 column above. | — |
| `scripts/release/package.sh` — stage 9 of the git-release flow (zip + sha256 + notes). | — |

## Conventions

- **TypeScript strict**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride` are on. ESM (`module: NodeNext`) — relative imports need the `.js`
  suffix (`import { x } from "./foo.js"`).
- **Prettier** formats everything; a versioned pre-commit hook does it automatically —
  enable once with `git config core.hooksPath .githooks`.
- **UI text language split**: compact inline markers — HUD status lines, tick lines,
  badge/suffix fragments — use English tokens only (`5h 62%`, `·stale 12m`, `⤓demoted`);
  never mix Chinese words into them. Chinese is reserved for prose blocks aimed at the
  user/model (multi-line advice/warning copy).
- **Conventional Commits** (`feat|fix|docs|refactor|perf|test|chore|ci(scope): ...`); the
  CHANGELOG is generated from them.
- Tool parameters use `@sinclair/typebox` schemas. It is host-provided (pi aliases it to its bundled
  `typebox` at load time), so it lives in `peerDependencies` with a `"*"` range (+ `devDependencies`
  for local tests) — never in `dependencies`: pi ≥1.0 warns, since an installed copy can bypass the
  loader's module mapping and duplicate runtime modules. There are no runtime `dependencies`.
- Peer dependencies on `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` are pinned to
  `>=1.0.0 <1.4.0`; bump deliberately and re-check `src/adapters/pi-compat.ts`. Before bumping, run
  `npm run test:conformance` (real `AgentSession` boundary-draft contract + runtime capability
  self-check, `tests/conformance/`) — it never gates pi-compat's structural probes (I14), it just
  tells you ahead of users whether `src/context-switch/capability.ts` still reaches `verified`.

  Full peer-bump procedure: see the **pi peer bump checklist** above (the traffic and cmd-history conformance premises moved to `docs/dev/traffic-merge/README.md` and `docs/dev/web-hub/README.md`).

## pi-extension specifics (easy to get wrong)

- pi loads this package straight from TypeScript source (`index.ts` → `src/`) via jiti —
  that is what makes `pi install git:...` work despite `dist/` being gitignored (pi's git
  install runs no build). `dist/` is still built in CI and published to npm for the Node
  `main`/`exports` entry, but pi never reads it. The pi peers are `peerDependenciesMeta`
  optional (pi aliases them to its own bundled modules at load time) and duplicated in
  `devDependencies` for local typecheck/tests.
- The extension re-activates on pi's `/reload` in the same process without busting Node's
  module cache. Never keep mutable state at module scope; rebuild per `activate()` (see the
  `HOST_KEY` globalThis guard and its identity-checked release in `src/index.ts`).
- Child subagent sessions re-import this extension; they must stay inert (host-claim guard).
- Ref'd timers wedge `pi -p` (print mode) — `unref()` any interval/timeout you add.

## Testing expectations

Vitest. Suites include a state-machine transition matrix and seeded property invariants —
when you change the run state machine (`src/core/state-machine.ts`) or delivery lifecycle,
update the matrix/property tests in lockstep. Integration tests live in `tests/integration/`.

## Releasing

Releases are cut by `scripts/release/release.sh <version>` (copied from `~/ai/claude2api`'s
dev/main release flow; `main` there is `master` here), and only when the user explicitly asks for one:

- **Branch strategy (铁律)**: day-to-day development happens on `dev`. A **patch** release is cut
  directly on `dev` (release commit + tag on dev, no merge into `master` first). A **minor/major**
  release must first merge `dev` into `master` via PR, then the release commit + tag are made on
  `master`; releasing minor/major on `dev` is forbidden. Before releasing, pull the target branch and
  confirm the commits to release are on it; the tag must be on the release branch's ancestor chain.
  The script derives the bump kind from the requested version vs the latest tag and enforces this
  (up-to-date check, ancestor check and push all use the release branch). Consequence: `master` only
  advances on minor/major, so `pi install git:` users on the default branch get patches only at the
  next minor. After a minor/major, sync dev (`git switch dev && git merge --ff-only master`) — the
  script only prints this reminder.
- **Transition rule**: while neither a local `dev` nor `origin/dev` exists, a patch release from
  `master` is allowed with a WARN (create dev afterwards: `git switch -c dev && git push -u origin dev`);
  once dev exists the strict rules above apply.

- **Version bump rule**: default **patch** — fix/refactor/perf/chore/docs/test/ci are always patch;
  **minor** only after at least 50 `feat` commits accumulated since the latest existing `vX.Y.0` tag
  (patch tags don't reset the count); **major** only on `BREAKING CHANGE` (`!:` subject or footer).
  The script prints its suggestion and WARNs on a mismatch. When unsure, choose patch.
- **CHANGELOG is generated, never hand-edited**: feature/fix commits do not touch `CHANGELOG.md`;
  the release script builds the version section from the Conventional Commits since the last tag
  (anything already under `[Unreleased]` is merged in) and updates the compare links. Commit
  subjects/bodies therefore ARE the changelog — write them for users. Do not hand-edit released
  sections either; to change the output, change the script.
- **Flow**: on the release branch (`dev` for patch, `master` for minor/major), clean tree, up to date with `origin/<branch>` ⇒ sync `package.json` /
  `package-lock.json` ⇒ generate CHANGELOG ⇒ `format:check` → `typecheck` → `build` →
  `build:web` + `check:web` → `test` (any failure aborts before commit/tag) ⇒ commit
  `chore(release): bump version to vX.Y.Z` ⇒ annotated tag carrying the section (verified on the branch's ancestor chain) ⇒ push branch + tag ⇒
  `scripts/release/package.sh` (zips + sha256 + notes) ⇒ `gh release create`. Flags: `--dry-run`,
  `--changelog`, `--skip-tests` (emergency only), `--skip-push`, `--skip-publish`.
