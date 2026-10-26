# pi-toolkit

[中文](README.md) | **English**

A toolbox extension for [pi](https://github.com/earendil-works/pi). The flagship is a **zero-hang subagent system** (`Agent` / `get_run_result` / `steer_subagent` / `SubagentWorkflow`), plus a set of everyday modules you can toggle independently: project memory, context handoff and cache keepalive, quota and load awareness, bash auto-backgrounding, task tools, `/goal`, Feishu notifications, and an optional browser control plane (Web Hub). One install entry, one settings gate.

<p align="center">
  <img src="docs/images/hero-web-desktop-en.png" alt="Web UI: sessions, transcript and agent tree" width="100%">
  <br>
  <sub>Web UI: sessions, transcript, agent tree (phases / cost) and subscription quota in one view</sub>
</p>

<p align="center">
  <img src="docs/images/web-desktop-dark.png" alt="Web UI dark theme" height="320">
  <img src="docs/images/web-mobile-list.png" alt="Mobile session list" height="320">
  <img src="docs/images/web-mobile-chat.png" alt="Mobile chat" height="320">
  <img src="docs/images/web-mobile-agents.png" alt="Mobile agent drawer" height="320">
  <br>
  <sub>Dark theme · mobile (sessions / chat / agent drawer)</sub>
</p>

## Core properties

<p align="center">
  <img src="docs/images/tui-agent-tree.png" alt="Agent-tree widget and HUD footer in the terminal" width="100%">
  <br>
  <sub>In the terminal: agent-tree widget + HUD footer</sub>
</p>

1. **Zero-hang** — every subagent run is a pure state machine with per-phase deadlines: a 1Hz watchdog fires them, an escalation ladder (cancel → steer → abort → dispose) reclaims resources, and anything that still refuses to die is registered as an orphan. Every run reaches a terminal state.
2. **Observable** — a live agent tree sits above the editor (phase, in-flight tool, streaming tail, real-time cost); `/agent status` gives a per-run tool timeline; Web Hub shows the same.
3. **Results always delivered** — completion notices flow through a persistent, acknowledgeable delivery pipeline and are never silently dropped.
4. **Dispatch and walk away** — main-session `Agent` and `SubagentWorkflow` calls always run in the background and return an id immediately; completion notices drive the next step. bash commands past a threshold (default 290s) are moved to the background without being killed.
5. **A toolbox, not a monolith** — every module beyond the subagent core has its own switch. Install one package, take what you need.

## Install

pi loads TypeScript source directly (via jiti) — no build step:

```sh
pi install git:github.com/Newbluecake/pi-toolkit
# update:
pi update --extension git:github.com/Newbluecake/pi-toolkit
```

Or download the total zip from [GitHub Releases](https://github.com/Newbluecake/pi-toolkit/releases). Extract it, then run in the extracted directory:

```sh
cd pi-toolkit
npm install --omit=dev
pi install .
```

The total zip installs as a local pi extension (local-path install, not covered by `pi update`). The Web UI also ships as a separate `pi-toolkit-web-ui-<version>.zip` asset: extract it into `~/.pi/agent/` to install it under `~/.pi/agent/web-hub-ui/<version>/`, no hub restart needed.

## Modules

Detailed guides live in [`docs/guide/`](docs/guide/) and are **written in Chinese only**; internal design docs are in [`docs/dev/`](docs/dev/) (also Chinese).

| Module                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Guide (zh)                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Subagent tools                    | `Agent` / `get_run_result` / `steer_subagent` / `abort_subagent` / `extend_subagent_timeout` / `set_model`; background, extendable timeouts, optional worktree isolation.                                                                                                                                                                                                                                                                                                                           | [subagents](docs/guide/subagents.md#工具)                        |
| Agent tree                        | Live subagent tree above the editor: phases, tool trail, cost, deadline highlights.                                                                                                                                                                                                                                                                                                                                                                                                                 | [subagents](docs/guide/subagents.md#agent-tree)                  |
| SubagentWorkflow                  | Sandboxed JS orchestration (`agent()` / `parallel()` / `pipeline()`), background, journal replay. Off by default.                                                                                                                                                                                                                                                                                                                                                                                   | [subagents](docs/guide/subagents.md#subagentworkflow)            |
| Scheduled tasks (`schedule`)      | Session-owned cron / one-off tasks: a background subagent produces a report, or a timed message; AI-created tasks need your approval; reports can go to Feishu. Off by default.                                                                                                                                                                                                                                                                                                                     | this README [schedule](#scheduled-tasks-schedule)                |
| Anti-hang architecture            | Per-phase deadlines, escalation ladder, orphan registry, persistent notice delivery.                                                                                                                                                                                                                                                                                                                                                                                                                | [subagents](docs/guide/subagents.md#防卡死架构)                  |
| Message fabric                    | Fire-and-forget messages between subagents along the agent tree (`message_agent`). Off by default.                                                                                                                                                                                                                                                                                                                                                                                                  | [subagents](docs/guide/subagents.md#message-fabric)              |
| External droid agent              | Dispatch Factory droid as the virtual provider `droid/<model>`, with a model allowlist and quota gate. Off by default.                                                                                                                                                                                                                                                                                                                                                                              | [subagents](docs/guide/subagents.md#外部-droid-agent)            |
| Project memory                    | cwd-keyed passive memory: tiered injection, `memory` tool, `/mem doctor` / `tidy`.                                                                                                                                                                                                                                                                                                                                                                                                                  | [memory](docs/guide/memory.md)                                   |
| bash auto-background              | Overrides built-in `bash`: long commands move to the background unkilled; `bash_job` manages them; grace and extension.                                                                                                                                                                                                                                                                                                                                                                             | [bash](docs/guide/bash.md)                                       |
| Context handoff and usage hints   | `switch_context` / `compact_context`, stepped usage ticks and a force line.                                                                                                                                                                                                                                                                                                                                                                                                                         | [context](docs/guide/context.md#switch_context--compact_context) |
| cache TTL and keepalive           | Anthropic prompt-cache TTL modes and keepalive pings with breakers and an evidence layer.                                                                                                                                                                                                                                                                                                                                                                                                           | [context](docs/guide/context.md#cache-ttl-与保活)                |
| System-prompt stabilization       | Dynamic sections become a frozen snapshot; changes ride tail messages so the cached prefix survives.                                                                                                                                                                                                                                                                                                                                                                                                | [context](docs/guide/context.md#system-prompt-稳定化)            |
| Date injection                    | Injects `[date]` on the first turn, at day rollover and after long idle.                                                                                                                                                                                                                                                                                                                                                                                                                            | [context](docs/guide/context.md#date-日期注入)                   |
| Quota awareness                   | GLM / Kimi subscription and droid Standard / Core pool quota: laddered warnings, dispatch gate, Core→Standard fallback.                                                                                                                                                                                                                                                                                                                                                                             | [quota-load](docs/guide/quota-load.md#额度感知quota)             |
| Load awareness                    | CPU / memory / IO / disk sampling; defers new dispatches while the machine is busy.                                                                                                                                                                                                                                                                                                                                                                                                                 | [quota-load](docs/guide/quota-load.md#负载感知派单load)          |
| Task tools                        | Five `Task*` tools + widget + `/tasklist`; finished tasks collapse and auto-archive.                                                                                                                                                                                                                                                                                                                                                                                                                | [tools](docs/guide/tools.md#任务工具todo)                        |
| `/goal`                           | Objective-driven loop judged by a deterministic command or a verifier subagent, with turn / budget / time brakes.                                                                                                                                                                                                                                                                                                                                                                                   | [tools](docs/guide/tools.md#goal-目标循环)                       |
| `ask_user` / `web_search`         | Structured interactive questions; web search with four-provider failover.                                                                                                                                                                                                                                                                                                                                                                                                                           | [tools](docs/guide/tools.md#ask_user)                            |
| HUD footer                        | Takes over pi's footer: git, tokens / cost, context, quota / load.                                                                                                                                                                                                                                                                                                                                                                                                                                  | [tools](docs/guide/tools.md#hud-footer)                          |
| Feishu notifications              | Passively triggered result / summary / heartbeat cards (`@notify`, `/watch`).                                                                                                                                                                                                                                                                                                                                                                                                                       | [tools](docs/guide/tools.md#飞书通知)                            |
| Session navigation                | `/resume-recent`, `/clear`, bare `exit`, title cleaning.                                                                                                                                                                                                                                                                                                                                                                                                                                            | [tools](docs/guide/tools.md#会话导航)                            |
| topic-switch                      | Suggests a fresh session when a new request is unrelated and the cache is cold.                                                                                                                                                                                                                                                                                                                                                                                                                     | [tools](docs/guide/tools.md#topic-switch)                        |
| Auto title / deferred `/reload`   | A small model titles sessions; `/reload` waits while subagents are running.                                                                                                                                                                                                                                                                                                                                                                                                                         | [tools](docs/guide/tools.md#自动标题)                            |
| Web Hub (optional)                | Browser view and control: web prompts, `ask_user` race (paths in the dialog open a preview, single-choice answers can be deselected), managed sessions and restore, file / sandboxed HTML preview, local-port proxy, worktree diff / graph, version panel, LAN password and security (client IP allowlist, two-factor login, login session management, Feishu security alerts), privacy lock, command output in session history, archiving of finished agents / bash jobs, a scheduled-tasks panel. | [web-hub](docs/guide/web-hub.md)                                 |
| Encrypted sessions (pi-secure)    | gocryptfs vaults: projects and session records encrypted on disk, with plugin guards against cross-domain reads/writes. Zero wiring when not configured.                                                                                                                                                                                                                                                                                                                                            | this README [pi-secure](#encrypted-sessions-pi-secure)           |
| Traffic recording (traffic)       | `/record` logs provider requests / responses / stream chunks into local SQLite; ticket attribution, jq rewrite rules, hardened web viewer / replay. Off by default.                                                                                                                                                                                                                                                                                                                                 | this README [traffic](#traffic-recording-traffic)                |
| Migrating from standalone plugins | Uninstalling the old plugins and spotting leftovers; upgrade notes for the `get_run_result` tool rename.                                                                                                                                                                                                                                                                                                                                                                                            | [migration](docs/guide/migration.md)                             |

## Commands

| Command                                                                  | What it does                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agent` (`status [runId]` / `costs` / `settings` / `budget` / `reload`) | Run diagnostics, cost breakdown, settings editor, deferred reload                                                                                                               |
| `/task <description>`                                                    | Start a background general-purpose subagent                                                                                                                                     |
| `/goal`                                                                  | Objective loop (`status` / `pause` / `resume` / `clear`)                                                                                                                        |
| `/mem`                                                                   | Project memory: `list` / `path` / `import` / `doctor` / `tidy` / `restore`                                                                                                      |
| `/tasklist`                                                              | Task panel (`clear` empties it)                                                                                                                                                 |
| `/cache-ttl`                                                             | `on` / `off` / `auto` / `save` / `keepalive on\|off\|reset` / `status` / `probe`                                                                                                |
| `/topic-switch`                                                          | Show state (`status`); `last [--send]` retrieves the last held request                                                                                                          |
| `/webhub`                                                                | `status` / `open` / `restart` / `stop` / `start` / `token rotate` / `passwd` / `unlock` / `2fa` / `user` / `feishu`                                                             |
| `/schedule`                                                              | Scheduled tasks (needs `schedule.enabled`): `list` / `add` / `edit` / `show` / `log` / `approve` / `pause` / `resume` / `rm` / `run` / `repair`; `--all` manages other sessions |
| `/watch`                                                                 | Notify Feishu every time a task ends in this session                                                                                                                            |
| `/feishu-test`                                                           | Send a Feishu test card                                                                                                                                                         |
| `/pi-hud-refresh`                                                        | `git fetch` and refresh the HUD                                                                                                                                                 |
| `/resume-recent`                                                         | Resume sessions from the last 48 hours (`--all` for everything)                                                                                                                 |
| `/secure status`                                                         | Encrypted-session verdict and mount state (registered only when a `secure` section is configured)                                                                               |
| `/record`                                                                | Traffic recording: `on` / `off` / `status` (needs `traffic.enabled`, Node ≥22.13; web `on` asks for confirmation)                                                               |
| `/clear`                                                                 | Start a new session                                                                                                                                                             |

## Configuration

User settings file: `~/.pi/agent/pi-subagent.json` (historical file name kept; a missing or malformed file falls back to defaults and never throws).

- `/agent settings` opens an interactive editor (↑↓ select, Enter edit, Space toggle booleans, `r` reset to default; changes persist immediately). For scripts use `/agent settings list` / `set <key> <value>` / `reset <key>`.
- **Time fields normally use integer seconds** (keys end in `S`, e.g. `budget.idleS`); legacy millisecond keys are migrated on first load. Exception: `feishuBot.debounceMs` below remains in milliseconds and is not migrated.
- Per-module keys and defaults are in the matching guide (Chinese).

Top-level enable switches (defaults in the comments):

```jsonc
{
  "workflow": { "enabled": false }, // SubagentWorkflow
  "fabric": { "enabled": false }, // message_agent
  "worktree": { "enabled": false }, // isolation: "worktree"
  "memory": { "enabled": true },
  "hud": { "enabled": true },
  "webSearch": { "enabled": true },
  "todo": { "enabled": true },
  "askUser": { "enabled": true },
  "feishuNotify": { "enabled": true },
  "sessionNav": { "enabled": true },
  "goal": { "enabled": true },
  "quota": { "enabled": true },
  "load": { "enabled": true },
  "topicSwitch": { "enabled": true },
  "date": { "enabled": true },
  "externalAgents": { "droid": { "enabled": false } },
  "webHub": { "enabled": false },
  "feishuBot": { "enabled": false }, // Feishu bot; requires Web Hub control
  "traffic": { "enabled": false }, // traffic recording (/record; needs Node ≥22.13)
  "schedule": { "enabled": false }, // scheduled tasks (/schedule + schedule tool)
}
```

`web_search` provider credentials live elsewhere; see the [tools guide](docs/guide/tools.md#web_search) (Chinese).

### Feishu bot settings (optional)

These are **top-level** `feishuBot.*` keys in `pi-subagent.json`, not `webHub.feishuBot`. Changes require `/reload` then `/webhub restart`. Requires `webHub.enabled:true` and control enabled. [Setup, commands and security](docs/dev/feishu-bot/README.md) · [real-tenant checklist](docs/dev/feishu-bot/acceptance.md) (Chinese). **One app connects to one hub**; concurrent connections split events.

| Key                             | Default   | Meaning                                                                               |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `feishuBot.enabled`             | `false`   | Enable bot (owner-only by default).                                                   |
| `feishuBot.allowGroups`         | `true`    | Accept group @bot messages.                                                           |
| `feishuBot.groupRootTopics`     | `false`   | Open an unbound topic from a group-root @; then explicitly /use or /new.              |
| `feishuBot.notify`              | `"bound"` | bound / off; proactive done/failed/waiting for bound sessions.                        |
| `feishuBot.spawnScope`          | `"known"` | known refuses unknown dirs; roots requires path confirmation. /new also needs spawn.  |
| `feishuBot.debounceMs`          | `1500`    | 0–10000 **milliseconds**; JSON-only, not in the TUI editor.                           |
| `feishuBot.staleMessageS`       | `300`     | 30–3600 seconds; refuse stale requests.                                               |
| `feishuBot.files.outbound`      | `"auto"`  | auto / buttons / off; auto only for attributed p2p cwd images.                        |
| `feishuBot.files.inbound`       | `true`    | Accept inbound image/file attachments.                                                |
| `feishuBot.files.maxInboundMiB` | `30`      | Parses 1–100 MiB; effective ceiling is 30 MiB with shared upload limits.              |
| `feishuBot.securityAlerts`      | `true`    | LAN security alerts: new-IP logins, allowlist denials, revoked sessions, 2FA changes. |

## Scheduled tasks (schedule)

Attach cron or one-off tasks to the current session. At the due time the session either dispatches a background subagent that runs in a clean context (its final reply is the report) or sends itself a message. Off by default (`schedule.enabled`, non-live: `/reload` after editing). When off there is no `schedule` tool, no `/schedule` command, and the system prompt and status bar are unchanged. Design (Chinese): [scheduled-reports plan](docs/dev/scheduled-reports/plan.md).

> The old global scheduler (`~/.pi/agent/pi-subagent-schedules.json`) is retired: it is no longer read or written.

**Forms**

- `background`: a background subagent runs the task; the result is written back to the owning session as a message, so the model can refer to it later. By default it does not wake the main session; a task can opt in to a main-session handoff (`--handoff`). Pushed to Feishu by default.
- `message`: sends a message into the owning session at the due time. While the session is busy it queues, keeping only the latest message per task. Not pushed to Feishu by default.
- The `message` form and `--handoff` depend on a trigger capability of the host pi: when it is missing, creating a task with these forms (or switching a task to them) is refused (`E_UNSUPPORTED`), and the status bar shows `msg off` while such tasks exist. A main-session run triggered by a scheduled message or handoff is aborted after at most 3600 s (the cap is lifted if someone types into the session meanwhile); not configurable.
- At most 8 tasks per session.
- Time: a 5-field cron expression (`--cron`) or a one-off time (`--at YYYY-MM-DDTHH:mm`), evaluated in the task's time zone (`--tz`, an IANA name).

**Ownership and missed runs**

- A task belongs to the session that created it and only ticks and runs while that session (an interactive main session) is open. If the session is not open at the due time the run is **skipped**: no catch-up, no temporary session.
- The next time the session opens, a digest lists what was missed. If the hub is running and the Feishu bot is available, a "missed" notice is pushed, merged per task per hour.
- If the session is closed mid-run, the run is recorded as "result unknown" and you are notified; it is never re-run.
- Encrypted sessions, `--no-session` sessions and subagent child sessions never execute tasks; print / json mode can only view them.

**Approval**

- Tasks you create with `/schedule add` take effect immediately.
- **Tasks the AI creates or changes through the `schedule` tool need your approval.** Approval is bound to a hash of the task definition (`defHash`): if anything changes the schedule, form, prompt or other execution fields afterwards, the old approval stops matching. The AI has no approve action, and `resume` only un-pauses; it does not approve.
- To approve, run `/schedule approve <id>` in the terminal (it shows the full definition and hash and asks for confirmation), or review it in the web panel. Editing a task that is still pending does not approve it as a side effect.

**Commands**

| Subcommand                                                                  | What it does                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/schedule [list] [--all]`                                                  | List this session's tasks (`--all`: every session)                                                                                                                                                                                         |
| `/schedule add <name> --cron "<expr>" \| --at <time> [options] -- <prompt>` | Create. Options: `--tz` `--form background\|message` `--feishu` / `--no-feishu` `--type` `--model` `--thinking` `--timeout <s>` `--handoff` `--worktree`                                                                                   |
| `/schedule edit <id> [options] [-- <prompt>]`                               | Edit (owning session only)                                                                                                                                                                                                                 |
| `/schedule show <id>` / `log [<id>]`                                        | Full definition and hash / run history                                                                                                                                                                                                     |
| `/schedule approve <id> [<hash>]`                                           | Review and approve                                                                                                                                                                                                                         |
| `/schedule pause\|resume\|rm <id>`                                          | Pause / resume / delete; pausing or deleting also cancels the task's queued, not-yet-sent scheduled messages                                                                                                                               |
| `/schedule run <id>`                                                        | Run once now (owning session only, approved tasks only)                                                                                                                                                                                    |
| `/schedule repair`                                                          | Quarantine a corrupt ledger; with a healthy ledger, reset a stuck message scheduler (dialog count, session fence). Local terminal only, always refused from the web; with cross-session enabled, `/fabric fence reset` does the same reset |

With `--all`, other sessions' tasks can be listed, shown, logged, paused, resumed, removed and approved; `edit` and `run` only work in the owning session.

**Visibility**

- The AI's `schedule` tool: `list` / `get` / `create` / `update` / `pause` / `resume` / `delete` / `run_now` / `history`.
- A session-scoped task-definition section in the system prompt (definitions only, no next-run time, so the cached prefix is not disturbed; forked sessions do not inherit it).
- TUI status bar, e.g. `sched 2 · next 08:00 · run 1 · pending 1`.
- Web: the "schedule" button in the detail header opens a panel with tasks, run history and pending items. It is mostly read-only at first; the only write is approval. Needs `webHub.enabled`.

**Feishu**

- Reports from background tasks are pushed by Web Hub to the Feishu bot owner's p2p chat; this needs `feishuBot` and the Web Hub control plane (see "Feishu bot settings" above). Reports finished while the hub was down, or in local mode, are pushed after the hub recovers if they are under 24 hours old.
- Sending `/schedule` in the Feishu p2p chat returns a read-only task list, and `/schedule run <n>` runs one immediately (the owning session must be online; otherwise the reply says it is offline). The Feishu entry cannot create, edit or approve tasks.

**Settings** (all non-live)

| Key                        | Default | Meaning                                                                      |
| -------------------------- | ------- | ---------------------------------------------------------------------------- |
| `schedule.enabled`         | `false` | Master switch.                                                               |
| `schedule.defaultTimeoutS` | `1800`  | Timeout for background tasks without `--timeout`; integer seconds, 60–14400. |
| `schedule.maxTimeoutS`     | `14400` | Ceiling for a task's `--timeout`; integer seconds, 60–14400 (hard limit).    |
| `schedule.dir`             | unset   | Absolute path, JSON-only; defaults to `~/.pi/agent/schedules`.               |

There is no autostart for the hub in this release: for "missed" notices to work while the session is offline, the hub has to be running on its own.

## Encrypted sessions (pi-secure)

Puts a project and all of its session records into a gocryptfs-encrypted directory (a vault): use it normally while mounted; only ciphertext is left on disk once unmounted. The plugin adds light guarding: an encrypted session cannot write outside the vault, and a plain session cannot read inside it. **This is hardening, not a "never writes plaintext" guarantee**: plaintext copies in web-hub / Feishu, swap, terminal scrollback and other residuals are listed in the [design doc](docs/dev/data-encryption/plan.md) §5 (Chinese).

### Requirements and install

- Linux (needs FUSE);
- `gocryptfs` ≥ 1.8 (Ubuntu 22.04: `sudo apt install gocryptfs`), `fusermount3`, `flock` (ships with util-linux);
- Install the launcher (link it into `~/.local/bin`, which must be on your PATH):

  ```sh
  ln -s <repo path>/src/secure/bin/pi-secure ~/.local/bin/pi-secure
  # for a git install the repo path is usually ~/.pi/agent/git/github.com/Newbluecake/pi-toolkit
  ```

  Once a vault is configured, `/secure status` inside a session prints this install line too (the command is not registered when no vault is configured).

### Init

```sh
pi-secure init acme        # needs a real terminal; asks for a new password twice
```

- **The master key is printed by gocryptfs exactly once, at init** (64 hex characters). Copy it down on the spot and store it offline: if you lose the password and have no master key, the data cannot be recovered. The tool itself never reads or stores the password or master key.
- After printing, run `clear` and `tmux clear-history` (best-effort scrollback cleanup, not a secure wipe).
- init does the first mount, creates the directories, registers the vault, writes the project's sessionDir, and unmounts when done.
- A failed init cleans up after itself. If `gocryptfs -init` fails (for example the two new passwords differ), it revokes the registration and deletes the objects this run created, reporting each one (anything it cannot prove it created is kept, with a manual-cleanup hint). If the first-mount password is wrong three times (exit code 77), it asks in the terminal whether to delete the empty vault it just created; only `y` deletes. Any other answer, or a non-TTY stdin, keeps it, and you can finish later with `pi-secure init <name> --fix-settings`.

### Migrating an existing project: `convert` (recommended)

```sh
pi-secure convert ~/ai/acme acme   # real terminal: type the vault name + three passwords (init twice, mount once)
pi-secure status acme              # origin: ~/ai/acme · backup: ~/ai/acme.pi-secure-backup-… (still present)
```

- One command does it all: create the vault → copy in (including `.git`) → read every file back through the mount and run `git fsck` → copy sessions and memory (sources untouched) → write the project's sessionDir → replace the original path with a symlink to `~/secure/acme/work`. While the vault is unlocked, old absolute paths keep working.
- **The original directory is not deleted.** It is renamed to a read-only sibling backup `acme.pi-secure-backup-<time>-<4 chars>`. `status` keeps reminding you it exists and prints the delete command. Delete it yourself once you have checked the vault contents; the same goes for old sessions and old memory (deleting is not erasing on SSD / CoW).
- Prerequisites: `getfattr` (`sudo apt install attr`) and git. The home directory and every ancestor of the mount point must not be group- or other-writable, otherwise it exits 78 before any confirmation or password.
- Directories with ACLs/xattrs, setgid, other-group files, linked worktrees or in-tree mounts are refused (65) with each reason listed. After an interruption: `pi-secure convert --resume acme` (only finishes the link) or `--abort acme` (renames the backup back).
- A refused project can fall back to manual migration: `pi-secure init acme` → `pi-secure unlock acme` → `rsync -a ~/ai/acme/ ~/secure/acme/work/` → `pi-secure run acme --version` (smoke test, no `--` separator); import old sessions with `pi-secure run acme --fork <absolute path of the old session>`; finally delete the original directory yourself and update absolute paths elsewhere.

### Export and import (new machine / legacy-layout vaults)

```sh
pi-secure export acme ~/acme.tar                    # vault must be unmounted; ciphertext only, as sensitive as the cipher dir
pi-secure import ~/acme.tar acme --verify-password  # validate, publish as a new vault, verify the password and relocate
pi-secure init acme --fix-settings                  # finish the relocation if import ran without --verify-password
pi-secure import --resume acme                      # continue an interrupted import; --abort undoes it
```

- Reading a package checks the path allow-list, size budgets, header checksums and MANIFEST; anything malformed ⇒ 65, zero residue. When the mount point has moved, `run` / `unlock` / `export` are refused until the relocation (rewriting session headers, the memory directory and sessionDir) finishes.
- A legacy-layout vault (`status` shows `layout legacy`) can only be `export`ed and then `import`ed as a new-layout vault under a new name; delete the old vault after verifying.
- Full details (flow, every `status` line, exit codes, resuming, cleaning up `.aborted-<txid>` / `.init-failed-*`) are in [plan.md](docs/dev/data-encryption/plan.md) §2.9 「转换与迁移」 (Chinese); the real-machine checklist is [acceptance](docs/dev/data-encryption/acceptance.md) sections K–M.

### Everyday use

| Command                        | What it does                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-secure run acme`           | Unlock (password prompt) → start pi at the project root → after pi exits, unmount on a best-effort basis (10 s bounded finalize; if it cannot unmount it warns and leaves the mount) |
| `pi-secure run acme -C sub`    | Start from the project subdirectory `sub` (callable from any directory, no need to `cd` first)                                                                                       |
| `pi-secure unlock acme`        | Mount; returns immediately if already mounted. Afterwards a plain `pi` at the project root works too (sessionDir is already in the project settings)                                 |
| `pi-secure lock acme [--lazy]` | Bounded unmount; `--lazy` defers the unmount (works even with users still inside)                                                                                                    |
| `pi-secure status [acme]`      | Mount state, layout integrity, swap / core warnings, traffic-record compatibility; extra lines for unfinished convert/import, pending relocation, or a surviving backup              |

Inside a session, `/secure status` shows the verdict, lock reason, per-vault mount state and traffic-record compatibility.

### Private mode (--private)

In the default (normal) mode, an unlocked vault is visible to **every process of the same user**. `--private` narrows the plaintext mount so it exists only in a **private mount namespace** of this pi process tree; other programs that look at the path only see sentinel placeholder files.

```sh
pi-secure init demo --private        # register as a private vault (run defaults to private afterwards)
pi-secure run demo --private         # one private run; --no-private forces normal mode
pi-secure lock demo --lazy           # detach the mount path inside that namespace (existing access may continue)
pi-secure lock demo --kill           # end the --private session and finalize
pi-secure unlock demo --global       # private vaults refuse global unlock by default; --global lifts just that default
```

- `--private` / `--no-private` are recognized only right after the vault name; the default comes from `secure.vaults.<name>.private`.
- After `run` ends (or `lock --kill`) it finalizes: terminates processes with proven ownership, unmounts, releases the record and lease; the exit code passes through from pi.
- web-hub is not started inside a private session (it would be trapped in the namespace); to use the web UI, run `/webhub start` from a pi in a normal terminal.
- Process chain, mutual-exclusion rules, instance state and exit codes are in [plan.md](docs/dev/data-encryption/plan.md) §2.8 and [private-plan](docs/dev/data-encryption/private-plan.md) (Chinese); the real-machine checklist is [acceptance](docs/dev/data-encryption/acceptance.md) section J.

Security boundary (same wording as `pi-secure --help`):

> --private: the plaintext mount exists only in the private mount namespace of this pi process tree. Other programs that access the vault by path see only placeholder files, which blocks find/grep/backup tools and unintentional access by other agents. It does not defend against a deliberately malicious process under the same user: such a process can read the plaintext via /proc/<pid>/root or /proc/<pid>/cwd, or join the namespace with setns. If you need a hard boundary, run pi-secure under a separate system user.

### Notes

- **Always use absolute paths for `--fork` / `--session` / `@file`**: relative paths resolve against pi's cwd (inside the vault).
- **Restart the pi process after registering a new vault**: the registration `pi-secure init` writes is not re-judged on `/reload`.
- Encrypted sessions **cannot write outside the vault** (write/edit are blocked, bash best-effort); plain sessions **cannot read the vault** (read/write/edit/grep/find/ls and bash command text are blocked).
- Worktree isolation is refused in encrypted sessions; Feishu notification cards, cross-session messages (xs), droid and creating cron tasks are disabled there.
- traffic-record needs **v0.2.1+** (honours `PI_SECURE_SESSION=1`): older versions write request bodies into the plaintext traffic.db, and `/secure status` warns about it.
- If the vault is unmounted externally while running ⇒ the session turns LOCKED (all input and tools blocked); re-mount and reopen the session.
- While unmounted, `~/secure/acme` points at a plain file and `cd` fails — by design (sentinel).
- pi's native `/debug`, `/export <path outside the vault>`, `/share`, `/copy`, and running `pi` directly in a subdirectory without `pi-secure` are not interceptable by the plugin; always go through `pi-secure run`. The full residual list is in [plan.md](docs/dev/data-encryption/plan.md) §5.

### Troubleshooting

| Symptom                                    | What to do                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock` reports busy / EBUSY and lists pids | Some process still has its cwd in the vault (IDE, shell, …): exit it and retry `pi-secure lock <name>`; if not urgent use `--lazy`                                                          |
| `status` shows stale (ENOTCONN)            | The gocryptfs daemon exited abnormally: `pi-secure unlock <name>` cleans up and re-mounts, or `pi-secure lock <name>` cleans up                                                             |
| Exit code 75 "unmount not finished"        | The vault may still be mounted: check `pi-secure status` later, then `pi-secure lock <name>`; if needed `fusermount3 -uz <dir>/mnt` by hand                                                 |
| Exit code 77                               | Password wrong 3 times (1s/2s/4s backoff); run the command again                                                                                                                            |
| Exit code 73                               | Another pi-secure is mounting/unmounting (mount.lock is held); retry later                                                                                                                  |
| Status bar `secure:locked`, input blocked  | The session is LOCKED: vault not mounted, session and vault disagree, or a cross-domain open. Reopen as prompted (e.g. `pi-secure run acme -C sub`); LOCKED never auto-exits, `/quit` works |
| Status bar `secure:invalid`                | The `secure` section of `pi-subagent.json` cannot be parsed: fix the JSON and restart pi                                                                                                    |

## Traffic recording (traffic)

Records provider requests and responses (including stream chunks) into a local SQLite DB — `~/.pi/agent/records/traffic.db`, the same database the standalone pi-traffic-record plugin used, so history, rewrite rules and counters carry over automatically. jq rewrite rules plus a hardened web viewer / replayer. Off by default; recording needs Node ≥22.13 (`node:sqlite`); off means zero wiring, zero IO. Design doc (Chinese): [traffic-merge plan](docs/dev/traffic-merge/plan.md); real-machine checklist: [acceptance](docs/dev/traffic-merge/acceptance.md).

- `/record on | off | status`, registered in interactive main sessions only. print / json modes record but never start the web service or replay; the web command path asks for confirmation on `on`.
- Requests are attributed by a one-shot ticket header (minted in the headers hook, stripped at the fetch trampoline — providers never see it). Rewriting only touches provably-attributed requests; anything unprovable is sent verbatim and counted `unattributed`. Rewrite whitelist: anthropic-messages / openai-completions / openai-responses (codex WS handshakes bypass fetch, so codex sessions are recorded but never rewritten).
- The DB stores API keys in clear text (unchanged from the original design) and the file itself is not encrypted — recording is off by default for a reason.
- The web viewer binds `127.0.0.1` only by default (port 4177, auto-increments); every `/api/*` call needs a token (loopback included); responses carry anti-framing / no-store headers; session end (including `/reload`) aborts in-flight replays.

### Configuration

| Key                     | Default       | Meaning                                                                                                       |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `traffic.enabled`       | `false`       | Master switch; off ⇒ zero wiring, zero IO, `node:sqlite` never loads.                                         |
| `traffic.childSessions` | `true`        | Whether child-session requests are persisted. `false` stops DB rows, never stops rewriting of those requests. |
| `traffic.web.host`      | `"127.0.0.1"` | Bind address; `"0.0.0.0"` opts into LAN (see the risk below).                                                 |
| `traffic.web.port`      | `4177`        | First port, auto-increments for up to 20 tries.                                                               |

None of these keys is live: edit the settings file, then `/reload`. The DB path is fixed at `~/.pi/agent/records/traffic.db`; it does not follow `PI_CODING_AGENT_DIR` and is not configurable.

### Data scope

Enabled recording includes **child-agent traffic** by default: `/goal` verifiers and workflow children land with their full prompts and outputs, growing roughly linearly with child usage. The toolkit's own keepalive / quota / title / topic-judge requests never pass the recording hooks and are never recorded or rewritten. Two co-existence behaviors: while rewrite rules are armed, cache keepalive pings are vetoed (HUD `ping off:traffic-rewrite`) and pi-native cache warming is stopped; after any observed warming decision rewriting is suspended (fail closed, visible in `/record status`) until `/record off → on`.

### LAN risk

`traffic.web.host = "0.0.0.0"` opens the viewer / replayer to the local network over **plaintext HTTP**: the token, request bodies and API keys can all be sniffed on the same segment. The Host allowlist and token check are no substitute for transport encryption; for cross-machine access prefer an SSH tunnel and keep the default bind.

### Migrating from the standalone pi-traffic-record

1. Run `/record off` in every running pi.
2. Upgrade pi-toolkit.
3. Remove `"../../ai/pi-traffic-record"` from `packages` in `~/.pi/agent/settings.json` (and `~/.pi/agent/extensions/traffic-dump.ts` if you installed it).
4. Set `"traffic": { "enabled": true }` in `~/.pi/agent/pi-subagent.json` (or use `/agent settings`); for LAN also add `"web": { "host": "0.0.0.0" }`.
5. **Restart pi** (`/reload` alone is not enough).
6. Verify: there is exactly one `/record`; the `/record status` counts match those from before the migration (the DB, rules and engine settings carry over); the web history is browsable.
7. Roll back: set `traffic.enabled=false` and add the package back (while another process still runs the old version, both can share the same DB; the schema is unchanged).

You can also keep the external package for now: the toolkit yields only to an external recorder that is actually active. A running old v0.2.x makes the toolkit yield and notify at session_start to remove it from settings; the v0.3.0 tombstone release yields to the toolkit instead. Whatever the load order, exactly one recorder is active, so nothing is written twice.

## Development

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest: 17,000+ tests (state-machine matrix, property invariants, component rendering, …)
npm run typecheck
npm run format
```

Node.js ≥ 22. Versioned pre-commit hook (runs prettier on staged files): `git config core.hooksPath .githooks`. Repository layout and per-subsystem design constraints are in [AGENTS.md](AGENTS.md); per-feature design docs are in [`docs/dev/`](docs/dev/).

## License

MIT
