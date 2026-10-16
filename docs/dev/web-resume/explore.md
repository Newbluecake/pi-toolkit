# web-resume explore report (explore:web-resume, GLM, 2026-10-16)

I have everything needed. Compiling the final report now.

---

**Note on the deliverable**: my role here is strictly read-only (no file-creation tools, no redirects), so I could not create `docs/dev/web-resume/explore.md`. Below is the complete explore-doc content, ready to be saved verbatim to that path, followed by the short summary.

# Web-Resume Exploration (planned feature: web `resume` + subagent-session filtering)

## 0. Feature recap

1. Web UI should support `resume`/`/resume` (and likely a button) like the TUI: open a session list, pick one, and switch the **current** pi process (the one the web detail view is attached to) to that session — same as the TUI.
2. Both the TUI list and the web list should **filter out subagent sessions** (today the TUI marks them `[sub:type]` instead).

---

## 1. TUI side — `src/session-nav/`

Wiring: `src/index.ts:90` (import), `src/index.ts:998-1000` — `if (settings.sessionNav.enabled) wireSessionNav(pi);` — **post-guard** (main/host session only; a hub-spawned `pi --mode rpc` is its own process and its own host, see §6), self-gates on `ctx.mode`. Ordering constraint: `src/index.ts:1013-1017` — deferred-reload must wire **after** session-nav because its editor wrapper layers on top of `SessionNavEditor` (registration order = wrapping order).

### 1.1 Input rewriting (`resume` → `/resume-recent`)

- `src/session-nav/index.ts:56-61` `rewriteResumeInput`: exact `/resume` or bare `resume` → `/resume-recent`; `/resume --all` / `resume --all` (regex `^\/?resume\s+--all$`) → `/resume-recent --all`.
- `src/session-nav/index.ts:63-80` `SessionNavEditor extends CustomEditor`: `handleInput` intercepts plain Enter (`\r`/`\n` only) and rewrites the text **before submit** — this is what bypasses pi's built-in `/resume` handler (pi intercepts exact `/resume` at the TUI layer, §2). Installed only in TUI mode: `session_start` handler at `src/session-nav/index.ts:174-179` (`ctx.ui.setEditorComponent(...)` behind `ctx.mode === "tui"`). Bare `exit` is intercepted by the `input` event handler (`src/session-nav/index.ts:165-172`, `source === "interactive"` only).
- Why the rewrite exists (module header, `src/session-nav/index.ts:29-34`): rewriting into an **extension command** is what gives the handler an `ExtensionCommandContext` (with `switchSession`), and prevents pi's built-in full-list `/resume` from consuming it first.

### 1.2 The `/resume-recent` handler

`src/session-nav/index.ts:85-153`:

- `:89-92` — `ctx.mode !== "tui"` → notify "Recent resume is only available in TUI mode" and return (RPC sessions get this text fallback).
- `:94-97` — `!ctx.isIdle()` → "Agent is busy — press Esc before switching sessions" (**busy guard**).
- `:99` — `RECENT_SESSION_HOURS = 48` (`:46`).
- `sessionDir = ctx.sessionManager.getSessionDir()` (`:100`) — the **cwd-scoped** session dir (`<agentDir>/sessions/--encoded-cwd--/`).
- `--all` loader (`:102-107`): `SessionManager.list(ctx.cwd, sessionDir, onProgress)` → `cleanSkillTitles` → `collectSubagentMarks(await listSessionFiles(sessionDir), sessionDir)` → `markSubagentSessions`. Note: session-nav's `--all` is **same-dir full history**, not pi's cross-cwd `listAll`.
- 48h loader (`:109-111`): `listRecentSessions(ctx.cwd, sessionDir, 48, onProgress)`.
- Picker (`:113-137`): `ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => new SessionSelectorComponent(recentLoader, allLoader, onPick, onCancel, onExit, requestRender, {keybindings, showRenameHint, renameSession}, ctx.sessionManager.getSessionFile()))` — the last arg is the **current session file** (the picker highlights/excludes it). Rename support: `SessionManager.open(sessionFilePath, sessionDir).appendSessionInfo(next)` (`:128-133`), only when non-empty.
- The switch (`:139-144`): `await ctx.switchSession(selectedPath, { withSession: async (replacementCtx) => replacementCtx.ui.notify("Resumed session", "info") })`.

### 1.3 48h window implementation — `src/session-nav/recent-sessions.ts`

`listRecentSessions` (`:20-79`): `readdir(sessionDir)` → keep `.jsonl` files with `mtimeMs >= Date.now() - hours*3600e3` (`:27-46`) → **symlink candidates into a mkdtemp dir** (`:51-64`) → `SessionManager.list(cwd, tempDir, onProgress)` (`:66`, reusing pi's native SessionInfo parsing/search/sort without reading old JSONL) → restore real paths (`:67-71`) → `collectSubagentMarks(candidates)` → `markSubagentSessions(cleanSkillTitles(...))` (`:70-72`). Temp dir always removed (`finally`).

### 1.4 Title cleaning — `src/session-nav/skill-titles.ts`

`cleanSkillTitles` (`:76-101`): strips `<skill name="…">…</skill>` envelopes from `firstMessage` → `[skill名] 真实输入`; falls back to the **next** real user message (`findNextUserText`, `:36-64`); also scrubs `allMessagesText` for fuzzy search. Renamed sessions (`session.name`) are left alone.

### 1.5 Subagent detection — `src/session-nav/subagent-sessions.ts`

- Signal (legacy): `subagent:run` **custom entries in MAIN session files** carry `diag.sessionFile` (child path) + `diag.agentType`/`diag.label`. Child files themselves are unmarked (module header `:9-16`).
- `collectSubagentMarks(sessionFiles, sessionDir)` (`:103-153`): scans with a 16-way concurrency pool (`SCAN_CONCURRENCY = 16`, `:42`); per-file line scan `scanFileMarks` (`:68-100`) does a cheap `line.includes('"subagent:run"')` prefilter before JSON.parse. Results cached at `<agentDir>/cache/session-nav/subagent-marks.json` (`cachePathFor`, `:44-46` — `dirname(dirname(sessionDir))`), keyed by resolved path with `mtimeMs+size` staleness (`:127-135`); fire-and-forget write.
- `listSessionFiles(sessionDir)` (`:157-165`): all `.jsonl` in the dir (for `--all`).
- `markSubagentSessions(sessions, marks)` (`:168-180`): if a mark exists **and the session has no user rename**, retitle to `[sub:agentType] label` or prefix `[sub]`; renamed sessions stay untouched.

### 1.6 What "filter out subagent sessions" would change

- Filter point: after `markSubagentSessions` in **both** loaders — `src/session-nav/index.ts:102-107` (all) and `recent-sessions.ts:70-72` (recent) — drop sessions whose resolved `path` is in the marks map. `markSubagentSessions` becomes either `filterSubagentSessions` or gains a mode (`mark | filter`).
- Semantics decisions: renamed child sessions are currently exempt from _retitling_ (`:172`) — filtering by identity should still catch them (or the rename exemption carries over); the `[sub:*]` marking could be kept behind a toggle (`--all`-style) for debugging.

### 1.7 Other subagent-session signals (should also count)

1. **`subagent:child` custom entry** — the modern, self-describing marker. `src/runtime/session-driver.ts:53` `SUBAGENT_CHILD_CUSTOM_TYPE = "subagent:child"`; `markChildSession` (`:63-70`) appends it as the **first entry after the header (file line 2)** of every persisted child session at `create()` (`:816-823`). Consult forks are deliberately unmarked (`isConsultForkSpec`, `:65`), `resume()` never marks. Detection = read the first ~2 lines of each candidate file — far cheaper than the reverse scan and **survives parent-file deletion** (the legacy reverse scan's blind spot: a child whose parent main-session file is gone shows up unmarked).
2. **Reverse `subagent:run` marks** (§1.5) — legacy sessions created before the marker existed; also the only source of the nice `[sub:type] label` titles.
3. **Hub head-parser classification** (existing precedent, `src/web-hub/hub/spawn/history/head.ts`): `computeKind()` (`:190-195`): `subagent:child` ⇒ `"sub"`; `pi-hud-session-start` / `subagent:web-origin` / `subagent:prompt-sections` **with** `"pi_subagent_types":` ⇒ `"main"`; `subagent:prompt-sections` without it ⇒ `"sub"` (heuristic); else `"unknown"`. Constants pinned at `:23-36`.
4. **`parentSession` header** — `SessionHeader.parentSession?` (pi `session-manager.d.ts:15-22`), surfaced as `SessionInfo.parentSessionPath`. **NOT a subagent signal**: child sessions are created via `SessionManager.create(cwd)` with no options (`session-driver.ts:817`). It marks **forks** (pi `/fork`, `SessionManager.forkFrom`, topic-switch `newSession({parentSession})`, web-hub history forks).
5. **Child session location**: same cwd-scoped session dir as the main session (that's why they pollute the list). **Consult fork files live elsewhere**: `~/.pi/agent/cache/consult-sessions` (`src/consult/fork-store.ts:77-79`), deleted on reap — not a list-pollution concern, and unmarked by design.

Recommended filter rule: `subagent:child` marker (line-2 read) **OR** legacy reverse-scan mark.

---

## 2. pi built-ins

### 2.1 Built-in `/resume`

- Intercepted at the **TUI layer**, before the prompt pipeline: `dist/modes/interactive/interactive-mode.js:2676-2680` — exact `/resume` → `showSessionSelector()`.
- `showSessionSelector()` (`interactive-mode.js:4759-4786`): `SessionSelectorComponent` whose recent loader is `SessionManager.list(getCwd(), getSessionDir(), onProgress, signal)` and whose all loader is `SessionManager.listAll(...)` — **cross-cwd** when the session dir is the default (`usesDefaultSessionDir()`), same-dir otherwise. Also keybinding action `app.session.resume` (`:2467`).
- `handleResumeSession` (`:4796-4824`): `runtimeHost.switchSession(sessionPath, { withSession, projectTrustContextFactory })`; on `MissingSessionCwdError` prompts for a cwd and retries with `cwdOverride`.
- `switchSession` runtime (`dist/core/agent-session-runtime.js:128-146`): `emitBeforeSwitch("resume", path)` (cancellable `session_before_switch`), `SessionManager.open(path, undefined, cwdOverride)`, `assertSessionCwdExists`, then `teardownCurrent("resume", …)` — which **aborts any active response first** so the aborted turn is persisted (`:103-111`) — then `createRuntime({ cwd: sessionManager.getCwd(), …, sessionStartEvent: {reason:"resume", previousSessionFile} })`. **Switching to a session in another cwd re-creates the runtime with that session's own cwd** (process effectively changes project).
- `ExtensionCommandContext.switchSession` impl: `dist/core/extensions/runner.js:749-753` (delegates to the host's `switchSessionHandler`; the TUI wires its own richer variant at `interactive-mode.js:1525`).

### 2.2 API usable from an extension

- `SessionManager` is exported from the package root (`src/session-nav/index.ts:35-39` imports `SessionManager`, `SessionSelectorComponent`, `CustomEditor` from `@earendil-works/pi-coding-agent`).
- `SessionManager.list(cwd, sessionDir?, onProgress?, signal?)` → `Promise<SessionInfo[]>`; `SessionManager.listAll(onProgress?, signal?)` / `listAll(sessionDir?, …)` — cross-project listing (`dist/core/session-manager.d.ts:352-370`). `SessionInfo` = `{path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage, allMessagesText}` (`:193-205`).
- `ReadonlySessionManager` (`:206`) — what `ExtensionContext.sessionManager` gives you (includes `getSessionDir`, `getSessionFile`, `getSessionId`; **not** the static list — but the statics are on the class, usable anywhere).
- **Contexts**: `ExtensionContext` (`dist/core/extensions/types.d.ts:213-268`) has `sessionManager`, `isIdle()`, `ui`, `mode`, `cwd` — **no** `switchSession`/`newSession`. `ExtensionCommandContext` (`:286-325`) adds `waitForIdle`, `newSession` (`:292`), `fork`, `navigateTree`, **`switchSession(sessionPath, { withSession? })`** (`:316-321`), `reload`. `ReplacedSessionContext` (`:327-336`) adds `sendMessage`/`sendUserMessage`. `ExtensionUIContext.custom<T>()` (`:121`) is the custom-component dialog surface (dialog-capable in TUI **and RPC** — `hasUI`, `:220`).
- `docs/extensions.md:209-222`: session-replacement ops are **command-only** "because calling them from lifecycle handlers can deadlock the runtime"; old ctx is invalidated after a switch — do post-switch work in `withSession`.
- `session_start` reasons: `"startup" | "reload" | "new" | "resume" | "fork"` (`types.d.ts:578`).

---

## 3. web-hub agent side

### 3.1 `builtin-bridge.ts` — the `/new` re-entry precedent

- Module doc (`src/web-hub/agent/builtin-bridge.ts:1-40`): `commands.ts`'s `handleCommand` delegates the whole `command` op to `BuiltinBridge.execute(frame)`: validate → classify (`slash.ts`) → policy (`command-policy.ts`) → dispatch (template/skill → prompt; extension → capture-wrapped; builtin → direct calls).
- `/new` (`:299-314`): `armExec("new")` mints a nonce, then `pi.sendUserMessage("/webhub __exec new <nonce>", {expandPromptTemplates: true, deliverAs: "followUp"})`; result `completion: "unknown"`.
- **Why the re-entry** (`:206-212`): `ctx.newSession()` / `ctx.switchSession()` / `ctx.reload()` exist only on `ExtensionCommandContext`; the bridge runs from an event-context call site, never a registered command handler (§2.2 docs reason). The re-injected slash text goes through pi's command pipeline, so the `/webhub` handler runs with a full command context.
- Nonce slot: `src/web-hub/agent/index.ts:389-406` — closure-scoped `pendingExec {op, nonce, expiresAt}`, **one-shot, 5s TTL** (`EXEC_NONCE_TTL_MS = 5_000`), consumed by `takeExec`.
- `internalExec` (`src/web-hub/agent/index.ts:1548-1567`): parses `op nonce`, `takeExec("new", nonce)` guards, then `ctx.newSession()`. The `/webhub` command's `__exec` subcommand: `src/commands/webhub.ts:363-373` (invalid nonce → warning notify).
- Busy/policy in `execute()` (`builtin-bridge.ts:319-357`): `expect.sessionId` check → `E_SESSION_CHANGED`; classify → policy (`effectivePolicy(decision, busy)`); deny → `E_COMMAND_DENIED`; confirm without `confirm:true` → `E_CONFIRM_REQUIRED`.

### 3.2 `command-policy.ts`

- `BUILTIN_BRIDGE_NAMES` (`:21-30`): `session, name, thinking, model, compact, new, reload`.
- `BUILTIN_DENY_NAMES` (`:33-59`): includes **`"resume"`** (pi's TUI-only session picker — not implementable via a plain ExtensionContext), plus `fork, clone, quit, exit, …`.
- `builtinPolicyFor` (`:61-78`): `new`/`reload` → **confirm** (the clear button bakes `confirm:true` in, `d1b4b37`); `compact` → allow / busy→confirm.
- pi-toolkit table: **`"resume-recent"` → deny** (`:175-180`, "always opens a TUI-only session picker; no text fallback"); `"clear"` → confirm (`:171-174`). Overrides: `webHub.webCommandPolicy` wins outright (`resolveCommandPolicy`, `:216-224`).

### 3.3 `slash.ts`

- `parseSlashCommand` (`:18-24`), `classifyCommand` (`:66-79`): `pi.getCommands()` hit ⇒ extension/template/skill; else the builtin name tables ⇒ builtin; else `undefined` ⇒ `E_UNKNOWN_COMMAND` (never falls back to plain text).
- `listSlashCommands` (`:110-137`): the `commands` slot payload — every command pi reports + both builtin tables, dedup, cap 400, with base policy/policyBusy/output badges. Recomputed on `session_start`/`resources_discover` (`src/web-hub/agent/index.ts:1254-1262`).

### 3.4 `commands.ts` — cmd op handling

- `handle()` dispatch (`src/web-hub/agent/commands.ts:528-542`): `prompt | abort | steer_subagent | abort_subagent | command | recall` (`dialog_answer/cancel` routed to the dialog bridge by the caller). `queryOnly` → ledger query.
- `handleCommand` (`:466-504`): ledger `beginOrReply` (idempotency by cmdId, digest check, 16-capacity) → `builtinBridge.execute(frame)` → `settleAndReply`; success also `originEntry.notify`.
- Async settle precedent: the mention path settles from a promise (`:246-284`); steer/stop settle late via `cmd_late`. `handle()` itself stays synchronous/never-blocking.
- **`switch_session` does not exist on the wire today.** `CmdOp` (`src/web-hub/protocol/messages.ts:651-653`) = `prompt | abort | steer_subagent | abort_subagent | dialog_answer | dialog_cancel | command | recall`. The AGENTS.md control-plane blurb lists `switch_session` aspirationally; the only in-code reference is a comment, `src/web-hub/hub/spawn/supervisor.ts:1576` ("a live session switch (web /new, switch_session) moves the restore target").

### 3.5 Output capture / return channel

- Extension-command output: `dispatchExtension` (`builtin-bridge.ts:147-186`) arms `CommandCapturePort` (`command-capture.ts`, `wrapCommandApi` proxy at `src/index.ts:128`) and returns `CommandOutputWire {entries: [{kind: notify|widget|status|text|error|interactive, text ≤8 KiB/entry}], truncated?, needsTerminal?}` (`messages.ts:690-703`; hub-side second cap `capOutputBudget`, `hub/commands.ts:149-184`). **`resume-recent` in rpc mode would capture only its warning notify** — the picker itself is `ctx.ui.custom`, which has no web rendering.
- Request/response channel suitable for a **session list**: the existing `cmd`/`cmd_result` channel (HTTP `POST /api/cmd` → `CmdFrame` → agent → `cmd_result`, with ledger idempotency + `cmd_late` for late completion). What a new op needs (all additive, following the `recall` precedent — steer-recall plan S2/S4):
  - `protocol/messages.ts`: extend `CmdOp`, `CmdArgs` (e.g. `{op:"sessions", scope?}` / `{op:"switch_session", path, expect}`), `CmdData` (typed result, capped items/bytes like `CommandsFrame`'s 400-item cap).
  - `hub/http.ts` `parseCmdBody` (`:1866-1956`; default branch rejects unknown ops with 400 "unknown op" — old hubs reject new ops, so a **cap** gates the UI).
  - `hub/commands.ts`: `requiredCaps` (`:94-108`) + `cmdFields` (`:189-211`) + typed-result validation (like `recallDataOk`).
  - `agent/commands.ts`: a `handle` branch; the async `SessionManager.list` settles from a promise (mention-path precedent) under the frame deadline.
  - `protocol/version.ts` conventions: additive caps only, no PROTO bump while no new frames (every cap's doc block; `PROTO 1.2` owned by fleet F0). A dedicated cap (e.g. `resume.v1`, agent-advertised like `hold.v1`) matches the pattern; `SLOT_REQUIRED_CAP` (`version.ts`) is the precedent if a pushed slot is preferred over request/response.
  - Alternative without new ops: reuse the `command` op with a new builtin-bridge name `resume` (today deny) + extend `__exec` to `resume <nonce> <sessionPath>` (path args are whitespace-tokenized in `internalExec` — paths in `<agentDir>/sessions/<dir>/<timestamp>_<id>.jsonl` have no spaces today, but an op with a structured payload is cleaner); the **list** would still need some return channel (`CommandOutputWire` text entries could carry a capped list, at 8 KiB/entry).

### 3.6 Session frames around a switch (agent side)

- `session_start` (`src/web-hub/agent/index.ts:1180-1224`): attaches for **tui and rpc only**; resets caches, re-attaches the connection (`emitSession("attach")`).
- `session_shutdown` (`:1227-1252`): reason `new|resume|fork|reload` is a **reset, not a kill** — connection detaches with that reason and `session_start` re-enters on the same activation.
- `emitSession` (`:683-703`) — the single `session` frame construction path; `SESSION_EVENTS` → `publishSession` (`:1313`).

---

## 4. web-hub UI side

### 4.1 Composer command flow

- `Composer.vue` never executes commands: it detects `/`-prefixed text (`parseSlash`, `commandMode`), shows `CommandPalette` completions from the **`commands` slot** (`view.commands`, refreshed from the agent's `CommandsFrame`), Tab-completes, and emits plain `send(text, deliver)` (`Composer.vue` script; key map + palette layer `paletteKeydown`). Deny rows are greyed; Enter on deny never emits (gate in `sendGate`).
- `DetailDock.vue` `onSend` (`src/web-hub/ui/src/components/detail/DetailDock.vue:214-231`): slash + `commandsEnabled` → `commandPolicyFor`; deny → drop; else `runCommand(name, args, false)`.
- `runCommand` (`:98-155`): `ControlHandle.runCommand` (useControl → `POST /api/cmd` `command` op); `E_CONFIRM_REQUIRED` → inline `CommandConfirm.vue` (two-click arm/confirm, re-issues with a NEW id + `confirm:true`); async/unknown completions tracked via the pendingCtl watcher + `queryOnly`.
- Bare `resume` (no slash) on web is just a prompt today; `/resume` is builtin-deny (greyed with reason). A web `resume` affordance must be added explicitly (button and/or intercept in `onSend`, mirroring the TUI rewrite).

### 4.2 Existing session-list dialog (hub-level `spawn.history`)

- `SessionHistoryDialog.vue` (「历史会话…」 in `NewSessionMenu`): Teleport modal + PickerSheet contract; list state via `@logic/sessionHistory.ts`'s `historyListReducer` (search debounce, cursor pages, auto-continue ≤3, token-bucket 429 retry); rows = title/badges/rel-time + cwd + actions (**resume / fork / goto**), rendered via interpolation (textContent only — titles are untrusted).
- Data source: `GET /api/headless/history` (`hub/spawn/routes.ts:508/1622`), scanning **`<agentDir>/sessions` across all cwd dirs** (`hub/spawn/history/generation.ts:318-330`), gated on `config.spawn?.history === true` (`SPAWN_HISTORY_HUB_CAP = "spawn.history.v1"`, `protocol/version.ts`).
- **Why it differs**: its actions resume/fork in a **NEW hub-spawned process** (`POST /api/headless` with a `session` ref; in-place resume requires kind `main` + a best-effort occupancy proof; anything unclear → fork). The planned feature is the complementary **in-process** switch on an existing live card.
- Reusability: the dialog shell, `history.css` row styles, `formatRelTime`, keyboard listbox pattern, and the untrusted-title rendering discipline are all reusable; `historyListReducer`/`HistoryRowModel` are coupled to the hub wire (cursors, generations, `forkOnly`/`proofGap`/occupancy badges) — an in-process list is much simpler (no cursor/occupancy). Cleanest: a new lightweight dialog (or a generalized reducer) reusing the visual language, fed by the new agent-side list op; transport is `POST /api/cmd`, not the spawn-gated history endpoint (the feature must work with `webHub.spawn` off).

### 4.3 Button precedent

`d1b4b37` "one-tap clear button" (`DetailHeader.vue`): gating = `CONTROL_VIEW.enabled && commandsEnabled`; `runCommand(agentKey, "new", "", {confirm: true})`; never busy-gated (builtin `new` has no `policyBusy`; bridge dispatches `followUp`, so a busy agent queues like typing `/new`); local `clearing` double-submit guard; one-line role=alert error; **success needs no UI work** — see §5. A resume button would follow the same shape (plus the list dialog and a busy decision, §7).

---

## 5. Does the detail view follow an in-process switch? — Yes

- Agent: `switchSession` → `session_shutdown{reason:"resume"}` (connection detach = reset) → `session_start{reason:"resume"}` → `emitSession("attach")` sends a fresh `session` frame (`src/web-hub/agent/index.ts:1180-1224`, `:683-703`).
- Hub: the `session` frame updates the registry card / republishes; managed-spawn records **adopt the new session coords** (`hub/spawn/supervisor.ts:1571-1582`, RS3 — the restore/relaunch target moves with the switch).
- Browser: `state.js` `applySession` (`src/web-hub/ui/src/logic/state.js:1150-1173`) — session replaced ⇒ transcript cleared, `needsResync`, fresh `history` fetch; `sameSession` compares `sessionId` + `sessionFile` + `cwd` (`:1133-1146`). The agentKey never changes, so the route/detail view stays; the session-switch plan's `snapshot_reply.sessionId` guard drops in-flight snapshots of the replaced session. This is exactly the mechanism the clear button's "view follows automatically" claim rests on (`d1b4b37` commit message + code comment).
- Queue: `commandHandler.onSessionBoundary()` on both boundaries drops queued mirror items (`reason:"session"`, `agent/commands.ts` `onSessionBoundary`) — queued-but-unsent prompts at switch time are **dropped**, not carried to the new session.

---

## 6. RPC-mode managed sessions (hub-spawned `pi --mode rpc`)

- Host guard: a hub-spawned RPC process is a fresh process — `HOST_KEY` unclaimed at `activate()` ⇒ `isChildSession = false` (`src/index.ts:141-150`) ⇒ it **is** its own host; post-guard wiring (session-nav, web-hub, `/webhub` command at `src/index.ts:1110-1114`, no TUI gate) all runs there.
- web-hub attaches in rpc mode: `session_start` guard `c.mode !== "tui" && c.mode !== "rpc"` (`src/web-hub/agent/index.ts:1181`); `sessionInfo.mode: "rpc"` (`:1610`). The full control plane (cmd/dialog/commands slots) works — the clear button's `/webhub __exec new` path already proves extension-command execution in rpc mode.
- session-nav in rpc mode: `/resume-recent` early-returns with the TUI-only warning (`src/session-nav/index.ts:89-92`); the editor rewrite never installs (`:174-179`); bare `exit` interception applies (any mode) — but web prompts are `source:"rpc"`/`"extension"`, and the guard requires `source === "interactive"`, so it never fires from the web.
- An in-process switch **works** in rpc mode: `ExtensionCommandContext.switchSession` is mode-agnostic; either the `__exec resume <nonce> <path>` re-entry or a new `switch_session` op reaches a command context the same way `/new` does. After the switch, the managed record's session coords move (RS3, §5) so restore/relaunch follow the new session file.
- Right path for rpc: same code path as TUI-web (feature is per-agent, not per-mode); only the _picker UI_ differs (web dialog instead of `ctx.ui.custom`). Note `hasUI` is true in rpc mode, so `ctx.ui.custom` exists there in principle, but there is no web rendering for arbitrary TUI components — the web dialog must be browser-side.

---

## 7. Risks / edge cases

1. **Busy/streaming agent**: pi's `switchSession` **aborts the in-flight turn** (persisted) before replacing (`agent-session-runtime.js:103-111`). The TUI guards with `ctx.isIdle()`; the web `/new` deliberately queues. Decision needed: refuse while busy (`E_BUSY*`/disable), confirm-while-busy, or queue — but note extension commands execute **immediately** even while streaming (pi `interactive-mode.js:2716-2721` for TUI; the re-entry is a command), so "queue" semantics are really "switch now, aborting the turn" unless the bridge itself adds an idle check. Recommend mirroring the TUI: refuse unless idle (or two-step confirm).
2. **Current session in the list**: pass `getSessionFile()` so the picker marks/excludes it (TUI precedent, `index.ts:135`); switching to the current file is a teardown+reopen (reason `resume`) — harmless but should be avoided in UI.
3. **Very many sessions**: `SessionManager.list` parses every file's metadata (supports `onProgress` + `AbortSignal`); the hub request budget is ~13s end-to-end (`computeAgentBudgets`/`WRITE_TOTAL_MS` caps in `hub/http.ts`), and the agent handler must reply or go late within `deadlineMs`. Default to the 48h-window + a capped page (the symlink trick or equivalent), lazy `--all`. The marks scan adds IO (16-way pool, cached); its cache file grows unboundedly (no pruning of deleted files' entries).
4. **Sessions in other cwds**: both TUI loaders are cwd-scoped by design. A cross-cwd switch **recreates the runtime with the target session's cwd** (`agent-session-runtime.js:138`) — memory/worktree/preview/HUD scopes all re-anchor; bigger blast radius. Recommend v1 = current session dir only (parity with TUI).
5. **Privacy lock**: marks are per-sessionId (`hub/privacy/store.ts`); after a switch the sessionId changes, `viewUnlock` auto-invalidates (relock, `usePrivacyLock.ts:152-165` re-validates against the current sessionId), and a marked target session locks the detail view as usual. No new work needed, but verify the lock screen appears without a manual refresh (rides the `session` frame → card refresh).
6. **LAN**: the command surface is LAN-equal to loopback (no per-listener narrowing for `command.v1`; only preview distinguishes). A session **list** exposes titles/first-messages of every session in the cwd to any authenticated LAN user — same principal already reads prompts, consistent with prior rulings, but worth stating in the plan.
7. **TOCTOU / wrong session**: use `expect:{sessionId}` (exists on `command`, would be needed on a new op) → `E_SESSION_CHANGED` if the process already switched (double-click, two tabs).
8. **Idempotency**: ledger dedups by cmdId; a retried switch to the same path is near-idempotent; `running` dup ⇒ `E_DEADLINE` retryable. The `__exec` nonce is one-shot 5s — fine for a click-driven flow (armed and consumed within the same dispatch), but a structured op avoids nonce+path parsing entirely (`internalExec` splits on whitespace).
9. **Dropped queue on switch**: queued prompts are dropped (`onSessionBoundary`, reason `"session"`). The UI should surface this (or drain/flush before switch).
10. **Composer draft / scroll**: drafts are per-agentKey and survive the switch (stale text from the previous session remains in the composer); per-agent scroll position memory (`web-hub-session-switch` plan) may key stale positions — minor UX.
11. **File gone at switch time**: `SessionManager.open` throws (also `assertSessionCwdExists` if the header cwd vanished) → surface as a clean error, refresh the list.
12. **Subagent filtering gaps**: legacy children without the `subagent:child` marker and with a deleted parent file are undetectable by the reverse scan — combine both signals (§1.7). Renamed children: decide identity-based filtering vs the retitle exemption.
13. **`/resume` name collision**: pi's built-in `/resume` is TUI-intercepted and web-denied; if the web implements `/resume` via the builtin-bridge builtin table, TUI behavior is untouched (bridge only serves web cmd ops). Keep `resume-recent` deny or re-scope its policy once a web fallback exists.
14. **Old hub / old browser**: new op ⇒ old hub 400s "unknown op" — gate the UI on a new cap; old browser + new hub just never sends (cap-ignored), per `version.ts` conventions.

## Key files touched by the likely implementation (for the plan doc)

- Agent: `src/web-hub/agent/{commands,builtin-bridge,command-policy,index}.ts`, `src/commands/webhub.ts` (`__exec`), `src/session-nav/{subagent-sessions,recent-sessions,index}.ts` (filter + marker), possibly a new `src/web-hub/agent/sessions.ts` list module.
- Protocol/hub: `src/web-hub/protocol/{messages,version}.ts`, `src/web-hub/hub/{http,commands}.ts`.
- UI: a new dialog (reuse `history.css` + `logic/sessionHistory.ts` helpers), `Composer.vue`/`DetailDock.vue` (`resume` intercept), `DetailHeader.vue` (button), `logic/state.js` (no change — `applySession` already follows), i18n.
- Tests: `tests/session-nav/*`, `tests/web-hub/agent/{command-policy,builtin-bridge}.test.ts`, `tests/web-hub/ui/detail-header-clear.test.ts` (pattern), new op tests.

---

## Short summary

The TUI path is `src/session-nav`: a TUI-only `CustomEditor` rewrites bare `resume`/`/resume` into the extension command `/resume-recent` (48h window via symlink+`SessionManager.list`, `--all` = same-dir full history, `[skill:]`/`[sub:type]` title cleaning, disk-cached reverse scan of `subagent:run` marks), which shows pi's `SessionSelectorComponent` via `ctx.ui.custom` and switches with `ctx.switchSession(path, {withSession})`. pi exposes `SessionManager.list/listAll` (statics, root export) for listing, but `switchSession`/`newSession` exist **only** on `ExtensionCommandContext` — which is exactly why the web `/new` re-enters through `/webhub __exec new <nonce>` (5s one-shot nonce, `builtin-bridge.ts` → `commands/webhub.ts` → `internalExec` → `ctx.newSession()`); pi's own `/resume` is a TUI-layer intercept pi-side and is web-**denied** (`command-policy.ts`), as is `resume-recent` (TUI-only picker). There is no session-list return channel today: the cmd op union is closed (`prompt|abort|steer|abort_sub|dialog_*|command|recall`), so the feature needs either a new additive op pair (`sessions` + `switch_session`, hub `parseCmdBody`/`requiredCaps` + typed capped result, following the `recall`/cap conventions) or a builtin-bridge `resume` + extended `__exec`; the hub's `spawn.history` endpoint cannot serve it (spawn-gated, cross-cwd, and its actions fork/resume in a _new_ process — though its dialog's shell/rows and its `subagent:child` kind-classification are reusable precedent). The view already follows an in-process switch: `session_shutdown{resume}` is a reset, `session_start` re-emits the `session` frame, `state.js:applySession` clears/resyncs the transcript on the same agentKey, managed records adopt the new session coords (RS3) — the just-landed clear button (d1b4b37) is the end-to-end precedent, and everything works identically in hub-spawned RPC processes (own host claim; session-nav's TUI gates are the only inert parts). For subagent filtering, the modern self-describing `subagent:child` marker (driver-appended at child creation, line 2) should join the legacy reverse-scan marks; `parentSession` headers identify forks, not subagents, and consult forks live outside session dirs. Main risks: switch aborts a streaming turn (decide busy policy), cwd-scoping (cross-cwd switch re-homes the whole runtime), list latency/budget caps, dropped queued prompts on switch, and old-hub/old-browser cap gating.
