# pi-toolkit

[中文](README.md) | **English**

A toolbox extension for [pi](https://github.com/earendil-works/pi): the flagship is a **zero-hang subagent system** (`Agent` / `get_subagent_result` / `steer_subagent` / `SubagentWorkflow`), plus nine everyday-infrastructure modules you can toggle independently — project memory, a HUD footer, `web_search`, task tools, `ask_user`, Feishu notifications, bash auto-backgrounding, session navigation, and the `/goal` objective loop. One install entry, one settings gate.

## Why pi-toolkit

1. **Zero-hang guarantee** — every subagent run is a pure state machine with per-phase deadlines: a 1Hz watchdog fires them, an escalation ladder (cancel → steer → abort → dispose) physically reclaims resources, and anything that still refuses to die is registered as an orphan, never forgotten. **Every run reaches a terminal state** — the failure modes a naive "spawn + await" wrapper cannot see (model API stalling mid-turn, tool calls that never return, sessions that refuse to exit) all have a defined death and a defined cleanup here.
2. **Fully observable** — while runs are active, a live **agent tree** sits above your editor: phase, in-flight tool calls, model streaming tails, real-time cost. `/agent status` gives a per-run tool timeline.
3. **Results always delivered** — completion notifications flow through a persistent, acknowledgeable pipeline (staged → delivered → consumed): a notification that can't enter context is retried with a 10-minute hard backstop, never silently dropped.
4. **Dispatch and walk away** — main-session `Agent` calls always run in the background and return a run_id immediately; completion notifications drive the next step (dispatch several in one message to run them in parallel). bash commands auto-background past a threshold (default 290s, deliberately under the 5-minute prompt-cache TTL).
5. **A toolbox, not a monolith** — every module beyond the subagent core has its own switch (`hud.enabled`, `memory.enabled`, `webSearch.enabled`, …). Install one package, take what you need.

## Install

pi loads TypeScript source directly (via jiti) — no build step:

```sh
pi install git:github.com/Newbluecake/pi-toolkit
# update:
pi update --extension git:github.com/Newbluecake/pi-toolkit
```

Or download the zip (prebuilt) from [GitHub Releases](https://github.com/Newbluecake/pi-toolkit/releases), extract, and `pi install ./pi-toolkit` (local-path installs don't participate in `pi update`).

## The subagent system

- **`Agent` tool** — spawn bounded subagent runs: `description`, `prompt`, `subagent_type`, optional `model` override (strict `provider/id` or a fuzzy hint like `sonnet` / `kimi-k3`), `resume` (continue a finished session), `isolation: "worktree"` (git worktree per run), `timeout_s` (an explicit timeout is a hard cap — no grace, no extension), and `schema` (structured, schema-validated output). The main-session `Agent` **always runs in the background**: it returns a run_id immediately and pushes a completion notification on terminal state (there is no foreground/blocking mode and no `run_in_background` parameter). The nested `Agent` injected into a subagent keeps its blocking default plus opt-in `run_in_background` (a child runs in print mode — its run ends with its turn, so it cannot wait for a notification).
- **`get_subagent_result`** — collect a result after its completion notification arrives; non-blocking by default, `wait: true` + `wait_ms` for bounded blocking (a fallback). Also accepts a `SubagentWorkflow` id (`wf_…`).
- **`steer_subagent`** — send a follow-up instruction into a running subagent.
- **`abort_subagent`** — stop a running subagent; idempotent on terminal runs. Given a workflow id (`wf_…`) it stops the whole background workflow and every child run.
- **`extend_subagent_timeout`** — extend a running run's total deadline (capped in count and by a hard ceiling). Default-budget runs enter a grace window at expiry with a notification to the main session; only an unattended grace elapse terminates the run. Also accepts a workflow id (`wf_…`, a unique prefix or the script's `meta.name`) to extend a whole background workflow; a workflow's child runs are pinned to the workflow's hard ceiling and cannot be extended individually (the tool points you at the owning workflow).
- **`set_model`** — switch models mid-run (takes effect on the next LLM call, without interrupting the current turn): defaults to your own session, or targets a running subagent by run id / unique prefix / label; optional `thinking` level; the switch is written to the transcript and survives resume.
- **Agent types** — discovered from `.md` definitions in `.pi/agents/`, `.agents/agents/`, `~/.pi/agent/agents/` and injected into the system prompt; frontmatter `model:` accepts strict ids or fuzzy hints.
- **`@mention` steering** — type `@<label> <message>` in the editor to steer a running subagent, or revive a finished one.
- **Cost accounting** — every run's usage rolls into the session total; `/agent costs` for the breakdown.

### SubagentWorkflow

Sandboxed JS orchestration (`agent()` / `parallel()` / `pipeline()` / `phase()`) with its own wall-clock budget, runaway detection, and a replayable journal. Off by default (`workflow.enabled`).

Workflows **always run in the background**: the call returns a workflow id (`wf_…`) immediately, and a completion notification (name, status, result summary capped by `resultMaxChars`, spend) is pushed to the main session on terminal state. Use `get_subagent_result(run_id: "wf_…")` for progress or the full outcome (the id, a unique prefix or the script's `meta.name` all work) and `abort_subagent` to stop it. `agent()` calls beyond the workflow's concurrency limit queue FIFO instead of failing (a call still queued when the workflow stops or runs out of time resolves to `null`; a failed dispatch rejects). Every workflow is still bounded by its total budget plus a grace window (a default-budget workflow enters grace at expiry with a notice and can be extended via `extend_subagent_timeout`; an explicit `timeout_s` is a hard cap) and always reaches a terminal state; on session shutdown / `/reload` a running workflow is stopped and its notice is persisted into the session and re-delivered once the next time that session loads. Design: [docs/dev/workflow-background/plan.md](docs/dev/workflow-background/plan.md), [docs/dev/workflow-agent-queue/plan.md](docs/dev/workflow-agent-queue/plan.md).

### Agent tree

```
● 4 active Agents · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
    bash ▸grep monthlyQuota
  修订方案:月额度纳入调度 #81ab2a94 Plan kimi-k3 🧠思考 6s $0.0021
  » 调度模块需要支持月额度,我倾向于在 quota-bucket 里加一个 monthly 窗口
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- The header bullet takes the most severe highlight on the field, with the active count and live spend.
- One main line per run: label, `#id`, type, model, a humanized phase (`🧠思考` / `🔧工具` / `♻重试2/3` / `⏸排队` / `🗜压缩` / `⏹停止中`), elapsed time, cost. Nested runs indent under their parent (`↳`); workflows render as `⚙` group headers.
- While a run is in a tool call or thinking, an **activity line** follows: a recent tool trail plus the highlighted in-flight `▸tool`, or a one-line `»` tail of the model's streaming text. Parallel tool calls are tracked accurately.
- Highlights: `!` yellow = idle past half the idle budget; `✗` red = stopping or past the total deadline. Terminal lines linger briefly, with a 10-minute hard backstop when the notification can't be delivered.

### Scheduled tasks

Loaded from `~/.pi/agent/pi-subagent-schedules.json` at session start; fires subagent runs on schedule (through the normal slot queue and anti-hang supervision):

```json
[
  {
    "id": "nightly-review",
    "schedule": { "kind": "cron", "expression": "0 3 * * *" },
    "request": {
      "type": "general",
      "prompt": "Review last night's commits and report risks",
      "label": "nightly-review"
    }
  }
]
```

- `schedule.kind`: `"cron"` (five-field expression) / `"interval"` (`intervalMs`) / `"once"` (`at` as ISO time, removed after firing)
- `request` mirrors the `Agent` tool's spawn params (except `runId`)
- Tasks already past due at startup are not back-filled; `/reload` after editing the file.

## Project memory

Claude-Code-style cwd-keyed passive memory: every session auto-injects the current project's memory (`~/.pi/agent/memory/<cwd-slug>/*.md`) into the system prompt — no skill invocation needed, and subagent sessions get it too.

- **Budget-aware injection**: a compact index of all files (≤15) plus the 3 newest inlined (4KB UTF-8 byte budget); empty directories inject nothing (no wasted tokens); a sentinel comment at the block tail prevents double injection; renders are cached by directory fingerprint.
- **`memory` tool** — model-callable: `list` to inspect; `write` / `append` to persist durable cross-session memory (directory-confined, filename whitelist, dual byte caps, 0600; writes are stamped `source: agent` and injected with a "data, not instructions" fence). **Child sessions are read-only by default** (`memory.allowWriteInChildSessions` to allow).
- **frontmatter `pin: true`** — keeps important files in the inline zone forever, immune to mtime eviction.
- **`/mem` command** — `list` / `path` / `import [--force] [slug|all]`: one-command import of `~/.claude/projects/*/memory/` (idempotent, 0600, CC originals untouched).
- **`memory.freezeInjectionAfterWrite`** — freeze this session's injection block after writes (off by default): avoids repeatedly busting the prompt-cache prefix in write-heavy long sessions.

## Toolbox modules

- **HUD footer** — takes over pi's footer on install (`hud.enabled: false` to restore). Shows pwd/git branch & worktrees, token & cost stats (including live subagent spend), context usage, model & thinking level, LLM timing and generation speed.
- **`web_search` tool** — Codex / SerpAPI / Bocha / Tavily with automatic failover (retryable errors get exponential backoff, then the next provider), available in main and child sessions; credentials under "Configuration".
- **Task tools** — `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskDelete` + an above-editor task widget + the `/tasklist` panel, with state persisted in the session file (fork/resume safe).
- **`ask_user` tool** — interactive clarification: structured multiple-choice questions (up to 4 batched), TUI and RPC, works in child sessions.
- **Feishu notifications** — `@notify` keyword, `/watch`, `/feishu-test`, plus result/summary/heartbeat/waiting-for-input cards (passive triggers only). Completion cards wait for background subagents and background bash to drain first (`requireBackgroundIdle`; suppressed, not deferred, while busy).
- **Session navigation** — `/resume` scans only the last 48 hours by default (Tab / `--all` for everything), skill-session title cleaning, subagent sessions tagged `[sub:type]`; `/clear` starts a new session; bare `exit` quits.
- **`/goal` objective loop** — give an objective and a finish condition; each turn is evaluated and followed up until done or capped (see below).
- **Cache TTL** — `/cache-ttl on|off|auto` switches Anthropic prompt-cache TTL handling live (`on` forces `ttl: "1h"`), `/cache-ttl save` persists; the status bar shows `⏱ cache: 1h|5m`.
- **Quota-aware dispatch** — fetches GLM / Kimi subscription quotas (TTL-cached, zero periodic timers), injects laddered turn_end warnings (L1 `[quota]` tick line → L2 demote-in-fallback-chain advice → L3 skip-provider advice), fast-fails spawns to over-quota providers (stale snapshots warn but never block), and adds a HUD status line; demotion marks persist in `~/.pi/agent/quota-state.json`. Toggled by `quota.*` settings; design in `docs/dev/quota/`.

## Bash auto-backgrounding

On by default (POSIX only): overrides pi's built-in `bash` under the same name — short commands behave **byte-for-byte identically** (the foreground path reuses pi's own implementation). Only commands crossing the threshold change behavior: the call returns early with a `job_id`, the **process keeps running** in its own process group, output keeps flowing to a log file, and completion arrives as a `bash-job:notification` (with the output tail, triggering a new turn). Pass `run_in_background: true` to background immediately.

The `bash_job` tool manages jobs (`job_id` accepts a unique prefix): `status` (state + log tail + path) / `wait` (bounded, 30s default, 120s hard cap) / `kill` (whole process group, idempotent, pid-reuse safe) / `list`. **No `output` action** — the log is a plain file at `~/.pi/agent/bash-jobs/<sessionId>/<job>.log`; analyze it with `read`/`tail`/`grep` directly.

| Key                                 | Default                     | Meaning                                                                                                                  |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bashJobs.autoBackgroundS`          | `290`                       | Foreground bash auto-backgrounds past this; `0` = feature off (built-in untouched)                                       |
| `bashJobs.maxLogBytes`              | `10485760`                  | Per-job log cap; writing stops with a truncation mark, **the process keeps running**                                     |
| `bashJobs.maxBackgroundJobs`        | `8`                         | Concurrent background job cap                                                                                            |
| `bashJobs.retentionS`               | `86400`                     | Retention for terminal job JSON/logs; `<=0` disables cleanup                                                             |
| `bashJobs.shutdownPolicy`           | `"keep"`                    | On real pi quit, keep or kill running jobs; reload/new/resume/fork always keep                                           |
| `bashJobs.dir`                      | `~/.pi/agent/bash-jobs`     | Job state/log root (laid out per `<sessionId>/`)                                                                         |
| `bashJobs.shellPath`                | `$SHELL`(whitelist)→ `bash` | Shell for commands (`$SHELL` only when basename ∈ {bash, zsh, sh})                                                       |
| `bashJobs.timeoutGraceS`            | `60`                        | Grace window once a backgrounded job with an explicit `timeout` hits it; `0` = no grace                                  |
| `bashJobs.maxExtensions`            | `3`                         | Max `bash_job(action:"extend")` calls per job; `0` = extend disabled (D-6 ⇒ no grace either)                             |
| `bashJobs.maxTimeoutFactor`         | `3`                         | Hard ceiling for grace+extensions = this many times the original `timeout`; `1` = zero headroom                          |
| `bashJobs.childSessions`            | `true`                      | Whether child (subagent) sessions register their own `bash`/`bash_job`; `false` = none, no grant                         |
| `bashJobs.childSettleHold`          | `true`                      | Whether a settling child run with non-terminal background jobs is reminded and held instead of ending immediately        |
| `bashJobs.childSettleHoldMaxRounds` | `0`                         | Cap on settle-hold reminder rounds; `0` = auto-derived (bounded) from the run's own deadline/extension budget, plan §3.5 |

Behavior notes:

- **No override on win32** (no process-group semantics; built-in `bash` stays).
- **Directory cleanup**: one scan at session start, then at most every 10 minutes when new jobs are created (no timers added). Only touches `.json` / `.log` / `.tmp`; non-terminal jobs are never deleted.
- **Sensitive output lands on disk** (0600/0700, same threat model as session files) until `retentionS` expiry — redirect secrets away.
- **Self-contained logs**: when a process reaches a terminal state, a conclusion line is appended (e.g. `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s`) — `tail -3` tells you the ending; appended even past `maxLogBytes`.
- **Adoption after restart/reload**: still-running jobs are re-adopted in the next session and keep notifying; jobs whose pid ownership can't be confirmed are marked, never killed.
- **Job-level timeout grace + extension** (only for backgrounded jobs with an explicit `timeout`): hitting the deadline first enters the `timeoutGraceS` grace window with a notice (main session: a `bash-job:timeout` message + TUI); whoever called `bash` decides whether to extend via `bash_job(action:"extend", job_id, extend_s)` (bounded by `maxExtensions` calls, total length capped at `maxTimeoutFactor`× the original timeout). Child (subagent) sessions add a settle layer: a settling run with non-terminal background jobs is reminded across a bounded number of rounds instead of ending immediately (`childSettleHold`, round cap `childSettleHoldMaxRounds`), until the jobs finish or the round budget runs out; when the run does end, every still-running job is sealed and killed, and both a released job and a settle-held one surface in the terminal notice. Design: [`docs/dev/bash-timeout-grace/plan.md`](docs/dev/bash-timeout-grace/plan.md).

## /goal — objective-driven loop

```
/goal fix issue #42 with tests --until-cmd "npm test" --max-turns 15
/goal finish the orders-module refactor --until "npm run build passes and the old api dir is gone" --budget-tokens 2000000
/goal                  # status
/goal pause | resume | clear
```

- **Two composable finish judges** (AND semantics): `--until-cmd` runs a deterministic command each turn (exit 0 = pass, zero model cost, short-circuits first); `--until "<natural-language condition>"` is evaluated by an independent verifier subagent (default `claude-sonnet-5`, isolated from the working model, read-only evidence + schema-validated verdict); its gap analysis feeds the next turn.
- **Braking system**: turns (default 20), token/cost budgets, wall-clock (default 120 minutes). Hitting a cap injects a wrap-up instruction so the agent summarizes progress and blockers — never a silent stop.
- **E-stop**: Ctrl+C auto-pauses the goal (no follow-up), `/goal resume` continues.
- **Persistence**: the goal lives in the session file; after a crash/`/reload` it is restored **as paused** (never auto-resumed).
- The status bar shows `🎯 goal 3/20`; while a goal runs, the model is barred from `ask_user`.

## Message fabric

An optional fire-and-forget messaging protocol between subagents (`"fabric": { "enabled": true }` + `/reload`). `message_agent` supports three kinds: `progress`, `finding`, `directive`; the return value means the message entered the delivery queue, not that the target received it. Messages route along agent-tree edges, gated by the sender type's `can_message` frontmatter (`parent`/`child`/`ancestor`/`descendant`/`sibling`/`self`, default `parent` only). Sibling messages are untrusted input — receivers should re-verify them as external advice. Full settings (quotas, TTLs, dead letters, root backpressure) in [`docs/dev/subagent-push/subagent-push-plan.md`](docs/dev/subagent-push/subagent-push-plan.md).

## The anti-hang architecture

Every run is a pure state machine (`src/core/state-machine.ts`) driven by session events:

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (timeout/stop:→ abort_grace → reap → settled)
```

1. **Signal**: every session event (text delta, tool start/end/update, retry, compaction) refreshes `lastEventAt`. Idle = `now - lastEventAt` — a streaming model or a heartbeating tool is never "stuck".
2. **Deadlines**: each phase carries its own timer — startup 30s, first event 120s, model-turn idle 240s, single tool 600s, compaction 300s, total 30min (all configurable). The `EventWatchdog` ticks at 1Hz and dispatches `deadline_fired`.
3. **Escalation**: a running phase timing out → `cancel_signal` + `soft_steer` ("wrap up now" — a chance to finish gracefully) → 10s abort grace → forced abort. If that still fails, the `EscalatingReaper` climbs L0 cancel → L1 steer → L2 requestAbort → L3 dispose (kill the process handle) → anything unkillable is registered as an **orphan**, never forgotten.

Retries get their own backoff phase so they never trip the idle timer; parallel tool calls keep the run in `tool_exec` until the **last** sibling finishes.

## Configuration

User settings: `~/.pi/agent/pi-subagent.json` (the filename keeps its historical name; a missing or malformed file falls back to defaults, never throws).

`/agent settings` opens an **interactive settings editor** (↑↓ to select, Enter to edit, Space to toggle booleans, `r` to reset, Esc to close; changes persist immediately). For scripts: `/agent settings list` / `set <key> <value>` / `reset <key>`; `/agent budget` is an alias scoped to `budget.*`.

**All time fields are integer seconds** (keys end in `S`); legacy millisecond keys (`*Ms`) migrate automatically on first load.

```jsonc
{
  "concurrencyLimit": 6,
  "fleetWidget": true, // the agent tree above the editor
  "maxNestedDepth": 2, // depth cap for subagents spawning subagents
  "resultMaxChars": 8000, // result text cap; 0 = unlimited, live
  "worktree": { "enabled": false },
  "memory": { "enabled": true }, // project memory (injection + memory tool + /mem)
  "hud": { "enabled": true }, // HUD footer; false restores pi's built-in footer
  "webSearch": { "enabled": true }, // web_search tool
  "todo": { "enabled": true }, // Task* tools + /tasklist
  "askUser": { "enabled": true }, // ask_user interactive questions
  "feishuNotify": { "enabled": true }, // Feishu cards (main session only)
  "sessionNav": { "enabled": true }, // session navigation enhancements
  "workflow": { "enabled": false },
  "goal": { "enabled": true }, // /goal (sub-keys: maxTurns/maxMinutes/budget*/verifier*…)
  "budget": {
    "idleS": 240, // model-turn silence before timeout
    "modelTurnS": 900, // hard cap on a single model turn
    "toolS": 600, // single tool call cap
    "totalS": 1800, // whole-run cap
    // … queueWaitS, startupS, bindS, firstEventS, compactionS,
    //   abortGraceS, steerS, reapS, startupRetries, retrySlackS
  },
}
```

**`web_search` credentials live elsewhere**: environment variables, or `~/.config/pi/web-search.env` (0600 recommended): `CODEX_SEARCH_API_KEY` + `CODEX_SEARCH_BASE_URL` (optional `CODEX_SEARCH_MODEL`, `CODEX_SEARCH_TLS_INSECURE`), `SERPAPI_API_KEY`, `BOCHA_API_KEY`, `TAVILY_API_KEY` — at least one provider; `PI_WEB_SEARCH_ENV_FILE` overrides the path.

## Commands

| Command                 | What it does                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/agent status`         | Diagnostics for all non-terminal runs: phase, last event, idle time, orphans                                      |
| `/agent status <runId>` | Full tool timeline of one run                                                                                     |
| `/agent costs`          | Per-run cost breakdown, most expensive first                                                                      |
| `/agent settings`       | Interactive settings editor                                                                                       |
| `/task <description>`   | Start a background general-purpose subagent; the main session gets a start record and the completion notification |
| `/mem`                  | Project memory: `list` / `path` / `import [--force] [slug\|all]`                                                  |
| `/tasklist`             | Task list panel (`/tasklist clear` to wipe)                                                                       |
| `/goal`                 | Objective loop (status / pause / resume / clear)                                                                  |
| `/watch`                | Watch this session; notify Feishu on every task end                                                               |
| `/pi-hud-refresh`       | git fetch and refresh the HUD footer                                                                              |
| `/cache-ttl`            | Prompt-cache TTL mode (on/off/auto/save)                                                                          |
| `/resume-recent`        | Resume a session from the last 48h (`--all` for everything; bare `resume` too)                                    |
| `/clear`                | New session (bare `clear` works too)                                                                              |

## Migrating from standalone plugins

These standalone plugins have been merged into this package one by one. Migration = **remove the old package + upgrade this one + `/reload`**:

- `@getpipher/armory-memory` → just `pi remove` it; memory data (`~/.pi/agent/memory/**`) keeps working untouched.
- `@bluecake/pi-ask-user` → `pi uninstall` it; the Feishu config `~/.pi/agent/feishu-notify.json` is preserved.
- Loose extensions like pi-hud / web-search / pi-claude-todo / session-nav → delete the corresponding files/dirs under `~/.pi/agent/extensions/`.

**Leftover detection**: pi suffixes duplicate command names — seeing `/mem:1` `/mem:2` or `/tasklist:1` `/tasklist:2` while the **bare command disappears** means an old plugin is still loaded; duplicate tools are first-wins silent shadowing (check the tool description for the new capabilities to tell which one won).

## Development

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest: 2600+ tests — state-machine transition
                     # matrix, seeded property invariants, rendering…
npm run typecheck
npm run format
```

Versioned pre-commit hook (prettier on staged files): `git config core.hooksPath .githooks`

Layout: `core/` pure state machine + deadlines (no I/O) · `runtime/` watchdog, session driver, reaper · `service/` spawn/query/registry · `tools/` LLM-facing tool surface · `ui/` agent tree + settings editor · `workflow/` sandboxed orchestrator · `memory/` project memory · `fabric/` message fabric · `goal/` objective loop · `bash/` bash auto-background · `delivery/` notification pipeline · `hud|web-search|todo|ask-user|feishu-notify|session-nav|compact-hint|context-switch|cache-ttl/` toolbox modules · `adapters/` pi-facing glue.

Node.js ≥ 22 (uses `fs.globSync`).

## License

MIT
