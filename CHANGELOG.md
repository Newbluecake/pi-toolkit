# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.1] - 2026-10-25

### Added

- **schedule**: wire scheduled tasks end to end (`e618b862`)
- **web-hub**: hub-side coordinator for scheduled tasks (`69170deb`)
- **schedule**: scheduler for timed messages (`d7124d4e`)
- **schedule**: schedule tool, /schedule command, prompt section and status bar (`0658b8ac`)
- **schedule**: background executor for scheduled tasks (`74c53459`)
- **web-hub**: preview paths shown in ask_user dialogs (`b3e27566`)
- **schedule**: wire scheduled tasks into the pi session (off by default) (`85961b04`)
- **feishu**: deliver scheduled task reports and missed-run notices (`7766997b`)
- **schedule**: core scheduling, state ledger and recovery for scheduled tasks (`47d07e95`)
- **web-hub**: add the scheduled tasks panel (`b272dfb9`)
- **schedule**: define the contracts for hub-hosted scheduled tasks (`ec4297b0`)
- **web-hub**: record command output in the session history (`1e5633fe`)
- **web-hub**: show command records as cards in the transcript (`a48559ea`)
- **web-hub**: let the hub announce command history and serve brand-new sessions (`b6cff217`)
- **secure**: check the mount location before convert or import asks anything (`17d031ca`)
- **web-hub**: define the command history record and its projection (`e33b984f`)
- **secure**: wire convert, export and import into pi-secure (`3f3bc1a5`)
- **web-hub**: archive finished agents and bash jobs (`998dce27`)
- **fabric**: show the sending agent's name on subagent messages (`390a349b`)
- **web-hub**: show providers and add sorting in the model picker (`93cc06cb`)
- **secure**: add the convert flow that turns a project into a vault (`ad6c8b6a`)
- **secure**: add vault export, import and relocation (`473b8a8f`)
- **secure**: add the directory engine for converting a project into a vault (`c35b5052`)
- **secure**: add the encrypted vault archive format (`31257b92`)
- **secure**: add session and memory copying for vault conversion (`2b97f87d`)
- **secure**: let lock clean up private sessions whose supervisor died (`e7345193`)
- **secure**: wire private instances into pi-secure commands (`ed33894e`)
- **secure**: keep the web hub out of private namespace sessions (`0f2a386a`)
- **secure**: add the private mount namespace launcher core (`3c53c3fd`)
- **secure**: mount vaults at ~/secure/<name> so pi shows a short path (`ea38a8b1`)
- **traffic**: wire the traffic recorder into the toolkit (`e53deb12`)
- **traffic**: attribute requests by ticket and harden the recorder page (`6e75de9c`)
- **web-hub**: highlight large virtual previews in a worker (`93291695`)
- **web-hub**: virtualize large source previews with in-window find (`8ab06bb4`)
- **web-hub**: add line index, window and find logic for virtual previews (`a229c3d4`)
- **traffic**: give the recorder a per-process lifecycle (still unwired) (`23b9f579`)
- **web-hub**: add virtual code renderer for large previews (unwired) (`ed0bb8fa`)
- **web-hub**: freeze virtual preview source and find interfaces (`3c0deb88`)
- **secure**: guard pi-secure vault sessions inside the plugin (`799f9ee4`)
- **traffic**: import pi-traffic-record sources as src/traffic (unwired) (`7d2a9ce4`)
- **secure**: add pi-secure launcher for gocryptfs session vaults (`6c24e813`)
- **web-hub**: mirror quiet cross-session messages to bound Feishu chats (`933b1f46`)
- **web-hub**: Feishu cards for quiet cross-session messages (`22a2a0aa`)
- **web-hub**: compact session list showing directory, title, alias and run state (`e905c935`)
- **web-hub**: observe quiet cross-session deliveries in the hub router (`86964010`)
- **web-hub**: show line numbers in source previews (`72fa2abe`)

### Fixed

- **ask-user**: send only one answer for a single-choice question (`e4d3e192`)
- **secure**: clean up after a failed pi-secure init (`e2e66bb2`)
- **web-hub**: allow deselecting a single-choice ask_user answer (`4afe376c`)
- **web-hub**: stop indenting the first line of code blocks (`b807d698`)
- **secure**: re-verify the backup when convert pauses before committing (`a490bcc9`)
- **web-hub**: show the output of commands that finish asynchronously (`56c71cae`)
- **web-hub**: label subagent messages as message instead of fabric (`8910d145`)
- **web-hub**: align the archived folds in the Agents and Bash lists (`dbfbd958`)
- **quota**: stop forecast-only notices from reading as low-quota warnings (`37fb7615`)
- **web-hub**: align the parked-question notice with the composer column (`679c9818`)

### Changed

- **secure**: expose launcher building blocks for vault conversion (`e249fc6d`)
- **web-hub**: stop the freeze when opening 20-30 KB code previews (`1dcca7d4`)
- **web-hub**: stop window drags from restyling whole preview contents (`1e768c70`)

### Documentation

- document scheduled tasks and recent features in the READMEs (`86111c4c`)
- **skills**: stop mounting consult experts; subagents ask the parent instead (`bbb88ba1`)
- **dev-flow**: add kimi-k3 as a planning fallback (`e54c14ad`)
- **dev-flow**: prefer kimi-k3 for frontend work and drop the droid line (`e73dfa59`)
- **schedule**: plan session-aware scheduled tasks with Feishu reports (`4608928b`)
- **secure**: document private mode and its acceptance steps (`13115159`)
- **secure**: plan private mode, vault conversion and export/import (`446857a1`)
- **traffic**: document the merged traffic recorder (`7b93c9b6`)
- **secure**: record the private mount namespace feasibility probe (`979faab9`)
- **secure**: document pi-secure vault sessions and their acceptance (`8609f7fd`)
- **web-hub**: plan large-file preview performance work (`841d07c1`)
- **traffic**: plan merging pi-traffic-record into the toolkit (`a339f820`)
- **secure**: plan a pragmatic gocryptfs vault for encrypted sessions (`8918c184`)
- **web-hub**: plan Feishu mirroring of quiet cross-session messages (`dba5dc7e`)

### Tests

- **web-hub**: integration and conformance coverage for command history (`8a23b236`)
- fix two integration tests broken by recent features (`3acdd1d9`)
- **traffic**: pin the pi behavior the recorder relies on (`88871ab1`)
- **web-hub**: gate the preview perf probe and add the acceptance checklist (`2c721f1d`)
- **web-hub**: keep the preview probe from overwriting its baseline (`ca876a11`)
- **web-hub**: add a real-build preview performance probe and baseline (`edb8639a`)
- **secure**: probe gocryptfs behaviour the vault launcher relies on (`8383a481`)

Stats: 46 feat, 10 fix, 3 refactor/perf, 14 docs, 7 test

## [0.8.0] - 2026-10-23

### Added

- **fabric**: finish session aliases with status, conformance and docs (`a25b0975`)
- **fabric**: wire session aliases into the session stack (`e79f1093`)
- **web-hub**: route cross-session messages by session alias in the hub (`18ac6c09`)
- **web-hub**: add the hub-owned session alias table (`f4a78187`)
- **web-hub**: show, set and take session aliases in the web UI (`8d252832`)
- **fabric**: resolve and complete @alias session mentions (`2079656d`)
- **fabric**: add /fabric alias commands and show aliases in message headers (`2347b44c`)
- **web-hub**: bridge session alias requests from the agent to the hub (`7a264775`)
- **fabric**: address cross-session sends by alias with a pinned session id (`bd8021ed`)
- **fabric**: add the session alias wire contract and settings (`14699003`)
- **fabric**: finish the channel rollout with status, conformance and docs (`07df01c1`)
- **fabric**: wire cross-session channels into the session stack (`296fd5cf`)
- **web-hub**: add shared session alias name rules (`3e86b9cc`)
- **fabric**: count unread cross-session mail in the HUD, web status and /fabric status (`b76e4e69`)
- **web-hub**: enforce channel scope and fan out channel broadcasts in the hub (`62f62d94`)
- **web-hub**: show channel broadcasts in the web transcript (`019a9dc1`)
- **web-hub**: add channel chips, a sidebar channel filter and a channel manager (`0a57e956`)
- **fabric**: add channel membership, receiver checks and /fabric channel commands (`96aca975`)
- **fabric**: add channel broadcast sending and a channel filter to list_sessions (`70fe3198`)
- **web-hub**: show a cross-session unread badge on cards and the detail header (`c9d7d030`)
- **web-hub**: project cross-session channels over the hub link (`017f0f04`)
- **fabric**: scope @session mentions to shared channels (`4aca048b`)
- **fabric**: add the cross-session channel contracts (`92ccc0ec`)
- **web-hub**: project the cross-session unread count into web status (`c82d766b`)
- **fabric**: add the cross-session inbox unread counter core (`8111bb4c`)
- **web-hub**: redesign the Feishu ask_user card into per-question blocks (`eab69a78`)

### Fixed

- **ui**: label pi-toolkit messages as toolkit: in the TUI (`b5814fd0`)
- **web-hub**: give the alias area in the channels dialog proper gutters (`6ae207ec`)
- **quota**: stop coloring quota displays by the exhaustion forecast (`e92f5f9b`)

### Documentation

- **fabric**: plan human-set session aliases for cross-session addressing (`03ae874e`)
- **fabric**: add a web channel manager dialog to the channel plan (`a32d1aff`)
- **fabric**: plan cross-session channels and an inbox unread indicator (`6c3f73c9`)

Stats: 26 feat, 3 fix, 3 docs

## [0.7.1] - 2026-10-22

### Added

- **web-hub**: offer joined sessions in the composer @ panel (`8631d8b3`)
- **fabric**: show cross-session messages to the user and let @session replies wake (`cce43117`)
- **fabric**: surface cross-session reply state and finish the reply rollout (`0939b5a9`)
- **mention**: wire @session mentions into the TUI and web input paths (`31b94936`)
- **fabric**: wire cross-session request-reply into the session stack (`5a2874e8`)
- **ui**: show fleet widget usage token counts with adaptive k/M units (`2eeb0308`)
- **web-hub**: show full session paths and an icon xs badge on agent cards (`acda22e7`)
- **tools**: show usage token counts with adaptive k/M units (`e873b788`)
- **fabric**: receive correlated cross-session replies and add receive=replies (`3ed8c087`)
- **fabric**: let message_session request and send correlated replies (`d34f38a9`)
- **mention**: resolve @session mentions to cross-session targets (`c1db8367`)
- **fabric**: add the cross-session reply ticket ledger and notice gate (`b3ecbfe8`)
- **web-hub**: route cross-session replies on the hub (`25bc75c8`)
- **web-hub**: carry cross-session reply fields over the agent link (`e85c86ce`)
- **fabric**: add cross-session reply contract and reply-off golden (`bd2fbd07`)
- **fabric**: allow /fabric mutation subcommands from web (webCommandPolicy.fabric, default allow); keep Feishu refused (`e74e8e9e`)
- **web-hub**: desktop preview-window maximize/restore (`7d929aea`)
- **fabric**: complete cross-session observability and conformance gates (`2c582093`)
- **fabric**: wire phase-2 cross-session stacks and lifecycle (`a515874d`)
- **fabric**: phase-2 X2 agent-side cross-session connection (`a5ade62e`)
- **web-hub**: agent-side / command argument completion (P1) (`d45b8960`)
- **fabric**: phase-2 X1 hub cross-session relay (`85718b28`)
- **fabric**: phase-2 X4 receiver pipeline and join control (`0bc902fe`)
- **web-hub**: /-command argument completion UI (slash-args P3) (`6d84f721`)
- **web-hub**: add cap-gated command argument completion route (`bff2cd1c`)
- **fabric**: phase-2 T1 session-change fence (`988f68a8`)
- **fabric**: phase-2 X3 cross-session sender and main-session tools (`4ee49bcb`)
- **fabric**: add supervised cross-session root wake controller (`3c09aad0`)
- **web-hub**: freeze / command argument-completion protocol (P0) (`4ff28a23`)
- **web-hub**: preview-windows W4 — wire W3 into PreviewHost, integration tests, real-device checklist (`b07a03c6`)
- **fabric**: phase-2 XS0 cross-session contracts (`4f0dcfb3`)
- **web-hub**: preview-windows W3 cross-cutting integration (`f2edde4b`)
- **web-hub**: preview window components and modeless shell (W2) (`9912f62f`)
- **web-hub**: mermaid rendering engine with pre-render defences (`a0d9502b`)
- **web-hub**: preview window manager and geometry (W1) (`cbc60647`)
- **web-hub**: mermaid diagram block components and wiring (P2) (`854a60a3`)
- **web-hub**: show a subagent's original task description in the agent tree (`95957124`)
- **web-hub**: clear the session name to hand the title back to auto-generation (`fe413bf1`)
- **compat**: support pi 1.3 (`1dab59a4`)
- **title**: add /title auto and /title status (`a96c189a`)
- **memory**: add /mem init to create a project core.md skeleton (`4c59cbe9`)

### Fixed

- **web-hub**: close the phone preview from the back button when there is no history (`c765148a`)
- **web-hub**: settle web prompts held by topic-switch across session shutdown (`12b059cb`)
- **web-hub**: right-align wrapped agent card badges with the cost (`fe01ecee`)
- **fabric**: complete /fabric receive modes after a trailing space (`0c9e6f46`)
- **web-hub**: move overflowing agent card badges after the session name (`9a23d0ac`)
- **web-hub**: keep the agent card cost top-right and pin the preview footnote (`c23d4793`)
- **web-hub**: clear the pending web prompt after topic-switch opens a new session (`171abbb4`)
- **fabric**: xs host adapters tolerate a ctx without isIdle/hasPendingMessages/abort (`8f25b265`)
- **web-hub**: show async toolkit command output in the web UI (`0a129f2a`)
- **web-hub**: ask_user long context on non-first tabs is expandable again (`67abdb2b`)
- **feishu-bot**: make login-approval approve/deny buttons visually distinct (`8f572271`)
- **web-hub**: preview windows verify:W2 rework — SE-only key resize, single title aria, drop dead i18n key (`b48c7bae`)
- **web-hub**: preview window resize keeps the opposite edge fixed (W1 rework) (`a0907a84`)
- **web-hub**: forward per-question skip through /api/dialog (`e3d33494`)
- **web-hub**: tell the user to restart the hub when the pi launcher changed (`f4de187d`)
- **consult-ab**: give verdict/v1 enum nodes an explicit string type (`28aaab04`)
- **memory**: let /mem tidy fill the /mem init skeleton and keep its menu predictable (`dc630abe`)
- **ui**: drop the [pi-subagent] tag from TUI warning notices (`8fe579d4`)

### Documentation

- **fabric**: plan cross-session request-reply correlation and @session mentions (`b1be07c9`)
- **web-hub**: slash-completion plan review and dispositions (`b441a1df`)
- **fabric**: phase-2 review round 2 and main-session rulings (r3) (`dd8f181f`)
- record rulings for fabric phase 2 (N1/N2) and slash-command completion (D1-D6) (`0e279e6d`)
- **fabric**: phase-2 plan r2 addressing review round 1 (`29796578`)
- **web-hub**: plan for slash-command argument hints and completion (`a84830fd`)
- **fabric**: phase-2 plan review round 1 (`37189c27`)
- **fabric**: record phase-2 rulings for cross-session joining and discovery (`fdd734cd`)
- **fabric**: phase-2 plan for root-to-root cross-session wake (`240aacd4`)
- **web-hub**: plans for mermaid rendering and multi-window previews (`ea62d9dc`)

### Tests

- **fabric**: derive the xs harness hub version from package.json (`8a3cbaf7`)
- **web-hub**: slash-args P4 integration, conformance, status line, docs (`91b0ead2`)
- **web-hub**: slash-args P1 golden cmdArgs/commands republish + cmdArgs-absent pins (`86b2e5a4`)
- **web-hub**: probe:mermaid real-browser gate (Chromium + Firefox) (`b18557bd`)
- **web-hub**: reserve proxy test port ranges through the shared allocator (`870ca05b`)
- make the T-F1 overflow and startup-cancel late-result tests deterministic (`91ef6a2c`)
- allocate test ports below the ephemeral range to stop EADDRINUSE flakes (`349f52ce`)

### Chores

- **web-hub**: provenance-bound mermaid chunks, licence gate and EPL notices (`95101924`)

Stats: 41 feat, 18 fix, 10 docs, 7 test, 1 chore

## [0.7.0] - 2026-10-21

### Added

- **fabric**: show wake activity in /agent status and subagent results (`1997fff7`)
- **fabric**: revived subagents finish quietly and report back to their wakers (`f6cc67a0`)
- **ask-user**: retire stale parked questions automatically (`b780982b`)
- **web-hub**: put preview copy next to download; hide plaintext-HTTP warnings by default (`26907869`)
- **fabric**: wake finished subagents when a message asks for it (`fc1c9e1c`)
- **fabric**: hand messages to a resuming subagent once it is running (`f58dd34f`)
- **fabric**: keep deliver-only messages for finished subagents until they resume (`2af6fea7`)
- **runtime**: record whether a resumed subagent actually received its prompt (`a4996cde`)
- **fabric**: let message_agent senders choose whether to wake the main session (`84d5c5c1`)
- **web-hub**: label the session stop button 「停止」 like its neighbours (`a37e8df1`)
- **web-hub**: put the session rename pencil right after the title (`a9ae427f`)
- **web-hub**: compact, freely draggable ask_user window (`b7d36925`)
- **external-agent**: hide droid models while the droid provider is unavailable (`c69307d1`)
- **web-hub**: confirm web slash commands with one click in a cleaner bar (`56271b89`)
- **web-hub**: recall Feishu ask_user cards once the question is answered elsewhere (`a35ed029`)

### Fixed

- **web-hub**: keep re-issued Feishu session-card buttons on the card's exact expiry (`0965e49e`)
- **web-hub**: drop the stale 「只读」 badge from the sign-in page (`1c103171`)
- **web-hub**: stop model names overlapping run names in the agents tree (`f9e9756d`)
- **web-hub**: make Feishu ask_user cards interactive and links phone-reachable (`e01d992e`)
- **web-hub**: ask to reload when an old tab can no longer load UI parts (`5aa44405`)
- **fabric**: expire subagent messages exactly at their TTL deadline (`9977e400`)
- **web-hub**: show full branch names in the worktree graph (`c1983049`)
- **cache-ttl**: stop keepalive per line after a proven cache write and resume on the next real request (`1bbc5968`)

### Changed

- **fabric**: add shared contracts for sender-controlled wake (`b08067b6`)

### Documentation

- **fabric**: plan sender-controlled wake and waking finished subagents (`4ec8afbb`)
- **dev-flow**: route to droid only when the models list advertises it (`201f6606`)

### Chores

- **web-hub**: give the detail header buttons meaningful colour (`d4b9f8f6`)

Stats: 15 feat, 8 fix, 1 refactor/perf, 2 docs, 1 chore

## [0.6.3] - 2026-10-20

### Added

- **web-hub**: show ask_user questions in a movable floating window (`4698a169`)
- **web-hub**: render images and layout HTML in Markdown file previews (`1d9e9bd0`)
- **web-hub**: keep LAN trusted IPs per account and require 2FA again after a kick (`48879e90`)
- **web-hub**: activate verified LAN second factors and device capabilities (LAN-I) (`377f8879`)
- **web-hub**: wire capability-gated two-factor login and cancellation (LAN-G) (`e6dba500`)
- **web-hub**: guide new-IP logins through authenticator or Feishu verification (LAN-G) (`171ed016`)
- **web-hub**: wire trusted local two-factor setup and socket controls (LAN-F) (`c0509c70`)
- **web-hub**: enroll and recover LAN second factors from the local terminal (LAN-F) (`7fc2f9b7`)
- **web-hub**: wire Feishu security alerts and LAN approval decisions (LAN-E) (`45b40ee7`)
- **web-hub**: alert on LAN security events and approve logins in Feishu (LAN-E) (`1fdb0c34`)
- **web-hub**: wire LAN device sessions and verification methods (LAN-D) (`920042e7`)
- **web-hub**: manage LAN login sessions and revoke devices (LAN-D) (`70a97446`)
- **web-hub**: wire checked LAN login and staged factor rollout (LAN-I) (`e8700935`)
- **web-hub**: unify LAN login completion and factor verification (LAN-C) (`bb208b11`)
- **web-hub**: wire LAN idle policy and secure store contracts (LAN-I) (`e8cb7332`)
- **web-hub**: persist secure LAN sessions and two-factor state (LAN-B) (`da825dd9`)
- **web-hub**: wire shared LAN client guards and allowlist status (LAN-I) (`14e5f29c`)
- **web-hub**: guard LAN and proxy clients with IP allowlists (LAN-A) (`f76fa713`)
- **web-hub**: LAN security frozen surfaces (P0, not wired) (`b5d2a7fd`)

### Fixed

- **web-hub**: parse external image hosts without a URL base literal (`c4d4b4fd`)
- **web-hub**: show the whole TOTP enrollment QR in /webhub 2fa enroll (`1e25e132`)
- **cache-ttl**: prove keepalive pings on lines that report cache usage only at stream end (`ec42b677`)
- **web-hub**: pull the proxy entry next to the settings gear and pad the gear off the edge on phones (`54e513db`)
- **web-hub**: drop the version dot next to the settings gear on phones (`b16333d1`)
- **cache-ttl**: make the keepalive no-usage breaker per line and lift it without cooldown (`87dfd7d3`)
- **web-hub**: don't push Feishu messages for prompts that can't be answered in Feishu (`8216c533`)
- **web-hub**: attribute ask_user prompts to their dialog so Feishu stops sending duplicate waiting notices (`99e3ab39`)

### Documentation

- document LAN security, 2FA and account commands in the README and web-hub guide (`7b6699eb`)
- describe LAN security in AGENTS.md (`efb7caaa`)
- **web-hub**: record LAN security phase-2 integration and final gates (LAN-I) (`638f091b`)
- **web-hub**: record LAN-D verify follow-ups and the session method ruling (`df26bbbf`)
- **web-hub**: record LAN phase-1 verify follow-ups for the integrator (`e945416b`)
- **web-hub**: LAN security integration follow-ups (`e42cf6ee`)
- **web-hub**: LAN security P0 surface addendum (package rulings) (`b382a345`)

### Tests

- **web-hub**: include two-factor setup in command completion contract (LAN-F) (`b8545237`)
- **web-hub**: supply explicit LAN guards in integration fixtures (LAN-D) (`186787f6`)

Stats: 19 feat, 8 fix, 7 docs, 2 test

## [0.6.2] - 2026-10-19

### Added

- **web-hub**: preview intranet links in an in-page proxy dialog (LP3) (`a83b4d01`)
- **web-hub**: let proxied apps be framed by the hub and reuse proxy sessions on re-open (LP1) (`475ab02f`)
- **web-hub**: count hub-made folders inside the roots as known on plaintext LAN (P2) (`bb0fda52`)
- **web-hub**: recognize scheme-less IP:port and port-less http intranet links (LP0+LP2) (`b7f7f909`)
- **web-hub**: acknowledge new folders in the spawn picker and explain directory refusals (P3) (`0500afd5`)
- **web-hub**: created-dirs store and known-dir source for hub-made folders (P1) (`7c76b7e6`)
- **date**: show the injected [date] marker in the TUI and the web UI (`d390e684`)
- **quota**: drop the HUD `droid no-key` segment — no key is the normal state (`41c089b1`)

### Fixed

- **web-hub**: drop the note line under the [date] divider (`0ce4be03`)
- **web-hub**: reload the proxy preview in place instead of opening a new proxy session (`24d62f0a`)
- **web-hub**: right-align the cost on removable session cards (`0ff2b8a5`)
- **web-hub**: fence /webhub restart so another pi session can't respawn the hub with stale settings (`80393938`)

### Documentation

- **web-hub**: link preview browser acceptance checklist + framing fixtures (LP4) (`b522f16c`)
- **web-hub**: link preview plan r2 (in-page proxy dialog, wider link recognition) + review (`2934fad5`)
- **web-hub**: LAN security plan r2 (allowlist, alerts, sessions, 2FA) + review (`723fcd63`)
- **web-hub**: created-dirs plan r2 + review + mkdir diagnosis (`a676f6f7`)
- **dev-flow**: restore cr-response as gpt-6.1-sol's backup channel (`42bedf51`)

Stats: 8 feat, 4 fix, 5 docs

## [0.6.1] - 2026-10-19

### Added

- **feishu-bot**: mark the bound session on the /list card; fix the fused hint line (`e6fee78c`)
- **feishu-bot**: one-tap session switching via a reusable card on /list (`089d65de`)
- **web-hub**: show each subagent's context usage in the fleet panel (`f0e539eb`)
- **quota**: don't warn about a missing droid API key when the droid CLI is logged in (`1ee55872`)
- **cache-ttl**: /cache-ttl measure — measure the current route's prompt-cache TTL (`286f130e`)
- **cache-ttl**: OpenAI Responses/Completions support for cache TTL measurement (measure P2) (`b48cb477`)
- **web-hub**: show start and end time on agent and bash job rows (`694829d2`)
- **cache-ttl**: pure core for /cache-ttl measure (measure P3) (`91994bee`)
- **cache-ttl**: measurement mode for the keepalive pipeline transport (measure P1) (`92230b08`)
- **feishu-bot**: end-to-end integration test, user guide and real-tenant acceptance checklist (F10) (`4a7d4ea1`)
- **feishu-bot**: wire the bot service into the web hub (FA) (`b0b6e588`)
- **feishu-bot**: bot service assembly — runs, dialogs, files, owner notices (F8) (`f6d528da`)
- **cache-ttl**: stop keepalive after 1 hour when only a UI prompt is pending (`829ab4a3`)
- **feishu-bot**: single-connection long-connection connector with receive-before-ACK (F3) (`0649e688`)
- **cache-ttl**: derive the keepalive ping cap per window from model prices (`8bfebd06`)
- **date**: re-inject the current time after 1 hour idle instead of 3 (`35346cc9`)

### Fixed

- **feishu-bot**: accept the flat post shape (no locale wrapper) (`f114b6c8`)
- **feishu-bot**: stop paging the owner for stale or unsubscribed Feishu events (`73f9869e`)
- **bash**: re-arm the liveness poll when job recovery is cut short (`ba8c6388`)
- **web-hub**: don't let the bash row's date line squeeze the command column (`fc67923f`)
- **feishu-bot**: keep the text of rich (post) messages and label inbound file types (`cabee9af`)
- **cache-ttl**: build adaptive thinking for force-adaptive Anthropic models in measurement (`f995c26d`)
- **web-hub**: render the Feishu setup QR as a persistent widget component (`a373e988`)
- **web-hub**: show the Feishu setup QR as one scrollable message when it can't fit the widget (`7378cb6d`)
- **commands**: multi-token argument completions replace the whole prefix (`95d89bcd`)
- **cache-ttl**: request low reasoning in measurement, refresh the status footer after IO settles (`73ecbee2`)
- **cache-ttl**: don't stop TTL measurement on reasoning-token output (`b002b2d8`)
- **cache-ttl**: capture keepalive payload per request and replay via pi's provider pipeline (`fe54feb6`)
- **web-hub**: align tool name and command text on one baseline in tool cards (`d21606bc`)
- **quota**: don't warn at L1 while usage is under pace; show readings in the droid pool list (`850f59fd`)
- **cache-ttl**: count the 1-hour UI-prompt keepalive budget only while the prompt is the sole reason (`0748621c`)
- **feishu-bot**: start no state write after dispose; tests wait for the writer instead of retrying cleanup (`ce64c19c`)

### Documentation

- **cache-ttl**: ruling 15 — P5 decides marginal short-TTL routes by economics (`85e990b7`)
- **feishu-bot**: note the flat post shape in the message format section (`279edcc8`)
- **dev-flow**: prefer kimi k3-256k over k3 when the task fits (half the price) (`b61541f8`)
- **cache-ttl**: plan for /cache-ttl measure (route cache TTL + read-renewal measurement) (`457120ea`)
- **cache-ttl**: plans for keepalive capture via pi's provider pipeline and (paused) other-protocol keepalive (`ef8b1ba8`)
- **cache-ttl**: live probe of cache lifetime and keepalive pings on Responses/Completions routes (`cbbc3dbf`)
- **feishu-bot**: record V7 probe — un-ACKed events are redelivered to a new connection, two connections split events (`a22ca8a8`)
- add Web UI (desktop, dark, mobile) and TUI screenshots to the README (`ce512bc7`)
- **cache-ttl**: revise the dynamic keepalive cap plan after two review rounds (`41e3b88c`)

### Tests

- **feishu-bot**: update the frozen caps test for the session-card caps (`50964fef`)
- **quota**: expect usage readings in the droid pool list of the spawn-gate message (`06cc6a69`)
- **cache-ttl**: pin pi provider-hook facts for keepalive replay (`2ac160a8`)
- **session-nav**: pin that Alt+Up reaches app.message.dequeue through the session-nav and deferred-reload editor chain (`7c082740`)
- **feishu-bot**: retry temp-dir cleanup while a disposed state finishes its last write (`893164ea`)
- make the suite pass on CI (UTC, no droid, clean HOME) and de-flake timing tests (`88e8e838`)

Stats: 16 feat, 16 fix, 9 docs, 6 test

## [0.6.0] - 2026-10-18

### Added

- **tools**: show the subagent's name next to its run id in tool cards and results (`133ad02`)
- **consult**: cache anchor at the end of expert history and follow-up consult threads (B, C) (`05dc95e`)
- **feishu-bot**: inbound events, sender admission, session routing and durable requests (F6) (`be3d342`)
- **consult**: show consult cache warm/cold and hit share in the agent tree, results and web record (U) (`815e6da`)
- **feishu-bot**: reply rendering, byte-budgeted splitting and a durable outbox (F7) (`1dc8d14`)
- **consult**: analyze consult cache results, warm/cold prediction accuracy and follow-up threads (F) (`ed63341`)
- **web-hub**: install-as-app entry in settings, iOS home-screen icon and a PWA install guide (`81e362d`)
- **consult**: record cache anchor, follow-up thread and warm/cold result fields on consult runs (A) (`73554a3`)
- **feishu-bot**: QR registration, credential store and durable bot state (F4) (`8924a0e`)
- **feishu-bot**: /webhub feishu admin commands, terminal QR code and settings entries (F9) (`af78c0a`)
- **feishu-bot**: bounded HTTP client, tenant token cache and API wrappers (F2) (`439ca54`)
- **feishu-bot**: long-connection frame codec and fragment reassembly (F1) (`96a586f`)
- **feishu-bot**: protocol constants, fsb frames and feishuBot settings (F0) (`e508b7b`)
- **feishu-bot**: real-tenant probe script (F-probe) (`807a8a5`)
- **web-hub**: wire the local-service proxy into the hub (X1c) (`36f1ec4`)
- **web-hub**: local-service proxy hub engine (X1b) (`72c3d86`)
- **web-hub**: detail header buttons show text labels (清空 / 恢复 / 隐私 · 锁定) (`5e5b2d8`)
- **web-hub**: local-service proxy core — target fence, sessions, port map, header filters (`8f5a495`)
- **web-hub**: drop the agent-tree row actions (… / Steer / Stop) (`78f7fa1`)
- **web-hub**: local-service proxy UI — 「打开本机端口」 dialog and proxy links (`df9b3a4`)
- **web-hub**: agent tree expand arrow moves after the name, rows align with bash jobs (`e5fcba7`)
- **web-hub**: consult rows get a status note and nested rows align with their parent (`0be16cb`)
- **web-hub**: local-service proxy settings and frozen protocol surface (`cfcc845`)
- **web-hub**: two-line bash job rows with de-shelled commands (`1e626b8`)
- **web-hub**: roomier agent tree rows — letter type badge, short model names, cost on line 2 (`25a8c46`)
- **web-hub**: HTML preview routes — mint, /pv subresources, /pvw wrapper, revocation (`f1a4e43`)
- **web-hub**: HTML preview UI — sandboxed render/source toggle and new-tab open (`cd4fcab`)
- **web-hub**: HTML preview hub core — capability store, fd-anchored admission, PV IO quota (`f02dc9e`)
- **web-hub**: sysload pill opens on hover like the quota pill (`c5736f7`)
- **web-hub**: HTML preview frozen surface (preview.html.v1 cap, /pv capability types) (`1cebe4e`)
- **web-hub**: clickable version chip with backend versions, changelog and mismatch dot (`79a4aa3`)
- **web-hub**: GET /api/version — hub, served UI, repo HEAD and changelog (`9e6cde4`)
- **web-hub**: version panel frozen surface (version.v1 cap, /api/version wire types) (`926b370`)
- **web-hub**: agent tree rows show the model's provider, compressed by width (`2f8ee3b`)
- **web-hub**: desktop agent tree uses the two-line row layout like mobile (`ab9155e`)
- **web-hub**: expand short agent and bash lists in the agents drawer by default (`dc21746`)
- **web-hub**: show the context details on hover (`3cf535d`)
- **web-hub**: show context token counts in thousands (`309bdf2`)
- **web-hub**: resume past sessions from the web UI (`3e9cb68`)
- **web-hub**: let a web session list and switch to past sessions in place (`44fff86`)
- **session-nav**: hide subagent sessions from the resume list (`fa0e9d6`)
- **web-hub**: render get_subagent_result output as Markdown (`852e15d`)
- **web-hub**: add a one-tap clear button to the session header (`d1b4b37`)

### Fixed

- **consult**: tighten follow-up thread admission and keep the OAuth anchor baseline (`2c1fc12`)
- **web-hub**: render relative markdown links as clickable previews instead of raw syntax (`5eb0d4e`)
- **web-hub**: make bare http(s) URLs in messages clickable (`78f45c4`)
- **external-agent**: show droid the JSON Schema it must answer with (`ec41b95`)
- **web-hub**: show a consult's question and answer when its session file is gone (`2287435`)
- **consult**: raise the default answer limit from 2000 to 6000 characters (`5a0f8e0`)
- **web-hub**: proxy engine follow-ups (shared-open race, upload cancel, log throttling) (`66ac97d`)
- **web-hub**: agent tree model names right-align across rows (`aab9894`)
- **bash**: run the bash tool with bash like pi does, not $SHELL (`09b1ded`)
- **web-hub**: settings shows the version card on narrow screens only (`153c64f`)
- **web-hub**: version popover opens like the quota card, with hover peek (`afed823`)
- **web-hub**: no synthesized italics, so CJK in comments and em stays crisp (`7c859af`)
- **web-hub**: load card shows how long the level held and 「实时」 when fresh (`046aaa6`)
- **web-hub**: resume list shows real titles instead of 「无标题」 (`d005962`)
- **web-hub**: center the resume dialog horizontally on wide viewports (`901b12e`)
- **memory**: allow 300-byte descriptions and trim over-long ones in /mem tidy (`c36fc76`)
- **memory**: let /mem tidy split files that /mem doctor flags as too large (`0118001`)
- **topic-switch**: suggest a new session when a request no longer needs this conversation (`1f2ffec`)
- **web-hub**: word the Droid overage badge as a policy and flag when Core is used up (`801388d`)
- **web-hub**: create web folders with your own umask, like a terminal (`33a89f1`)
- **web-hub**: no double divider in the agents drawer when only bash jobs are listed (`7ef4cae`)
- **web-hub**: report the web resume result after the session actually switches (`39c81c7`)
- **web-hub**: show a million context tokens as 1m, not 1,000k (`28ac0d5`)
- **web-hub**: make the folder picker's create button actually create the folder (`2ccb2fa`)
- **quota**: label a pool past its first warning line as 预警, not 告急 (`f62b793`)

### Changed

- **web-hub**: extract managed-session creation into startFresh (F5) (`74c4263`)
- **web-hub**: resolve hub login cookies once and fan out revocations on a bus (`b9832b6`)
- **topic-switch**: judge relevance with minimal thinking for a faster answer (`f15b975`)

### Documentation

- **cache-ttl**: plan for a price-derived keepalive ping cap (`3702613`)
- **dev-flow**: replace the mandatory dev-clarify step with lightweight ask_user clarification (`7d603b3`)
- **dev-flow**: use deepseek-flash instead of deepseek-v4-pro as the fallback verifier (`4d4f926`)
- **consult**: plan for cache reuse across consults, follow-up threads, warm/cold display and expert keepalive (`6c2e5ac`)
- **feishu-bot**: record first real-tenant probe results; probe no longer marks a late topic reply as V8 failure (`15c9a06`)
- Web Hub guide covers the local-port proxy, HTML preview and version panel (`3728b6e`)
- **feishu-bot**: Feishu bot plan v2 (two review rounds + §R2), research notes (`c657268`)
- **web-hub**: local-service proxy plan v2 (approved) (`801c3a0`)
- **skills**: slim dev-flow down to rules and move evidence into references (`a0d2392`)
- turn the README into an overview and move details into guides (`b4a12e0`)

### Tests

- **consult**: production-chain conformance for cache anchors and follow-up threads (E1) (`0c09b77`)
- **consult**: live probe confirms the expert-history cache anchor, per-request replay and keepalive pings (P0) (`2edeacb`)
- **web-hub**: proxy end-to-end test against a real hub process + browser acceptance checklist (X3) (`ead2315`)
- **web-hub**: HTML preview starvation suite, browser self-check page and acceptance guide (`c0a9d5f`)
- **web-hub**: settings-view media mock passes a real event to listeners (`bc5041e`)
- **web-hub**: wait for the upload recover audit line instead of racing it (`de6a278`)
- **web-resume**: pin web resume against a real pi and document it (`194dfa7`)

### Chores

- **web-hub**: code comments are color-only, no italic (GitHub style) (`bb2a195`)
- **web-hub**: keep the version-anchor golden out of prettier (`5f7f227`)

Stats: 43 feat, 25 fix, 3 refactor/perf, 10 docs, 7 test, 2 chore

## [0.5.5] - 2026-10-16

### Added

- **external-agent**: treat externalAgents.droid.models as an allowlist (`d24a933`)
- **web-hub**: collapse finished and archived tasks in the web todo panel (`1a08300`)
- **todo**: collapse finished tasks and archive them automatically (`9327dcf`)
- **web-hub**: shrink the quota pill in tiers and show details on hover (`3937277`)
- **date**: include the time of day and re-inject after 3h idle (`8ae3080`)
- **tools**: let steer_subagent ask the subagent to reply (`94f85d5`)
- **quota**: list Droid models per pool and hide subscriptions without data (`8611406`)
- **web-hub**: count running bash commands in the fleet badge and session cards (`d2637ca`)

### Fixed

- **quota**: let droid core models fall back to the Standard pool (`9f801af`)
- **cache-ttl**: give failed keepalive pings room to retry (`55a84e3`)
- **web-hub**: open files from an expanded subfolder at the right path (`ff9ad77`)
- **web-hub**: truncate the quota pill mid-text instead of blanking a group (`0f77422`)

### Tests

- cap the vitest fork pool at 8 workers (`2acadf5`)
- **workflow**: bound real-worker waits by the registry's own settle bound (`1638012`)

Stats: 8 feat, 4 fix, 2 test

## [0.5.4] - 2026-10-15

### Added

- **compat**: support pi 1.2.x (`9149c75`)
- **web-hub**: lead the fleet drawer title with the bot icon (`9204a6c`)
- **quota**: suggest droid pool models when a pi subscription runs out (`e928db7`)
- **web-hub**: show background bash jobs as a group in the fleet drawer (`aef6c67`)

### Fixed

- **web-hub**: label the fleet drawer back button and tree 'Agents' (`64837de`)
- **compat**: queue resume messages as followUp on pi 1.2 (`a401758`)
- **web-hub**: title the fleet drawer 'Agents' and the bash group 'Bash' (`f291284`)
- **web-hub**: match the fleet bash group title to the drawer title type (`bee72f5`)
- **web-hub**: keep the terminal icon only on the fleet bash group title (`f7421e3`)
- **web-hub**: drop the status accent bar from fleet bash rows (`7d55d3e`)
- **web-hub**: square the left corners of fleet bash rows (`ede633e`)
- **external-agent**: bump droid protocol pin to 1.265.0 (`9a2c123`)
- **web-hub**: preview ANSI-colored terminal logs as text (`fd38405`)
- **ask-user**: drop the pause glyph from the parked-question status (`29f81c6`)
- **sysload**: count CPU cores from the per-core /proc/stat lines (`04aab2f`)

### Documentation

- **skills**: drop the cr-response and zhipu-pool lines from dev-flow (`46bd4ba`)
- **skills**: route gpt-6.1-sol through the copilot channel by default (`d563a7f`)
- **dev-flow**: route droid subscription pools into explore/frontend/dev stages (`7909213`)

### Tests

- **web-hub**: wait for the preview audit line instead of racing it (`e52e2ba`)
- fix three load-sensitive flakes in the full suite (`b0910eb`)
- **external-agent**: move the fake droid fixture to protocol 1.265.0 (`c807d62`)
- clean up temp dirs in ~35 suites that leaked into /tmp (`1355ffb`)
- **web-hub**: clean up wtdiff linked worktrees after each test (`5b3491e`)
- **web-hub**: wait for a live link before firing tool-timing events (`11728e3`)
- **web-hub**: register test agents with a live pid (`1c9923c`)

Stats: 4 feat, 11 fix, 3 docs, 7 test

## [0.5.3] - 2026-10-15

### Fixed

- **stack**: keep quota/droid/bash-job warnings from corrupting the TUI (`9fe76db`)

### Tests

- **web-hub**: make wtdiff D6 reach mid-C2 reliably, skip only if unreachable (`aa47a6e`)
- deflake starvation, wtdiff D6 and tool-timing under load (`5470079`)

Stats: 1 fix, 2 test

## [0.5.2] - 2026-10-15

### Added

- **external-agent**: wire the droid provider into the session stack (P5) (`3b9dc0e`)
- **date**: tell the model the current date on the first turn and at day rollover (`2958e62`)
- **web-hub**: project droid quota pools to the hub when it supports them (P7wa) (`4b64584`)
- **quota**: Factory droid quota pools with per-model gating (P7) (`4d052c0`)
- **web-hub**: read-only cache keepalive panel in the session header (P-B) (`68cc3a8`)
- **web-hub**: show droid quota pools in the web UI (P7w) (`125e461`)
- **web-hub**: load large text previews chunk by chunk as you scroll (P2b) (`b2ddbc7`)
- **web-hub**: publish cache keepalive state to the web hub (P-A) (`5b07c41`)
- **web-hub**: StatusInfo.cacheKeepalive wire contract (keepalive panel P0) (`95f7a6f`)
- **cache-ttl**: keep retrying keepalive pings until the cache expires (`2dc2a90`)
- **external-agent**: Factory droid adapter (P3) (`658d045`)
- **external-agent**: spawn, runtime and tool gating for droid runs (P4b) (`42d6a0e`)
- **external-agent**: provider-agnostic framework for external CLI agents (P2) (`b707053`)
- **external-agent**: prompt, settings and memory hooks for droid (P4a) (`fa9d63f`)
- **web-hub**: chunked text preview on the hub (P1) (`40bb5ab`)
- **web-hub**: chunked preview client logic (P2a) (`0599845`)
- **external-agent**: show unpriced external-agent costs (P4c) (`2002ffa`)
- **cache-ttl**: line-level keepalive breaker with reset on success (`77b1cda`)
- **external-agent**: freeze droid provider shared surface (P1) (`df2957f`)
- **web-hub**: chunked preview protocol and preview.chunk.v1 cap (#23) (`6ea6c55`)
- **cache-ttl**: show the HTTP status when keepalive pings are switched off (`8f25203`)

### Fixed

- **external-agent**: resume droid sessions with load_session so the model remembers (`a7e079f`)
- **external-agent**: don't rely on stdin EOF to stop a busy droid (`645b57d`)
- **quota**: read Factory's overagePreference billing field (`dd4ea4a`)
- **bash**: SIGKILL the whole job group when members outlive the leader (`fc40fa9`)
- **memory**: warn when no core file means nothing is injected every turn (`3eaa290`)
- **memory**: read frontmatter behind the /mem import drift banner (`ea3cebe`)
- **memory**: keep the cursor in place when toggling /mem tidy --batch selections (`8d4ded7`)
- **memory**: stop /mem doctor D13 flagging identifiers and placeholders as secrets (`1e50685`)
- **web-hub**: drop content-visibility:auto on transcript items — Aw Snap root cause (#11) (`6e62b7b`)

### Documentation

- **external-agent**: droid resume memory loss root cause (#31) (`25945cd`)
- **external-agent**: droid provider user guide, AGENTS entry and dev-flow routing (P6) (`2b27d92`)
- **dev-flow**: anti-patterns for shared git stash and parallel full test runs (`7b80f39`)
- **bash**: #27 orphan root cause and fix plan r2 (`2fdb4e0`)
- **external-agent**: P5 tracking items from P7 acceptance (`d3edd62`)
- **quota**: record droid pools and month window deviations (`6ac1247`)
- **cache-ttl**: mark keepalive web-hub sync implemented; AGENTS pointer (P-C) (`ac3be1a`)
- **web-hub**: chunked preview acceptance checklist and AGENTS note (P3) (`c27e840`)
- **external-agent**: droid quota plan r2 (P7/P7w/P7wa) + reviews (`1c14859`)
- **cache-ttl**: web-hub keepalive panel plan r2 + review r1 (`f981df4`)
- **cache-ttl**: keepalive breaker recovery plan + review r1 (`7fcf545`)
- **memory**: field study of a large imported project memory (`10a4ec8`)
- **web-hub**: chunked preview loading plan and review (#23) (`eb5fd45`)
- **external-agent**: droid provider requirements, protocol study, architecture and plan (`a195301`)
- **dev-flow**: treat safety-policy refusals differently from transport errors (`ceeff29`)
- **dev-flow**: never use GPT-family models for verification (`ff67abd`)
- **dev-flow**: never route verifiers to zhipu-pool (`3e4f5c5`)

### Tests

- **external-agent**: make the resume-cwd echo case real and race-free (`dee8b88`)
- **web-hub**: pre-warm the lazy graph chunk in the GraphPanel expand case (`3a4d5c0`)
- **bash**: wait for the job record to settle before the pipe-holder kill case (`e963d43`)
- **integration**: disable the date module in the system-prompt wiring suite (`3316763`)
- **external-agent**: opt-in real droid conformance suite (D1-D14) (`e75060f`)
- **external-agent**: droid chain, hang and disabled-bytes integration suites (`8ccd3cf`)
- **quota**: pin kimi/zai quota output with a golden fixture (`caff590`)

### Chores

- **web-hub**: remove Aw Snap investigation diagnostics (#11) (`f379b5e`)
- **web-hub**: print a full-state [pwh-diag] dump at boot + pwhDiag() (#11) (`13caf1d`)

Stats: 21 feat, 9 fix, 17 docs, 7 test, 2 chore

## [0.5.1] - 2026-10-14

### Added

- **web-hub**: privacy lock /webhub status lines + plan/AGENTS wrap-up (P3) (`9e87a91`)
- **web-hub**: privacy lock UI (P2) — lock screen, marks, four-way relock (`811415f`)
- **web-hub**: trim the top-left brand to icon + "pi" (`29f2ff5`)
- **web-hub**: privacy lock hub package (P1) — per-session privacy marks (`c580a47`)
- **web-hub**: Ctrl+Enter drills into a dir row (keyboard parity for double-click) (`e644986`)
- **web-hub**: dir-tree single-click expands, double-click drills in (`178be72`)
- **web-hub**: tree-style inline expansion in the directory preview dialog (`009650a`)
- **web-hub**: image preview fullscreen + wheel zoom down to 50% (`8dfd3cf`)
- **web-hub**: session relaunch, streamlined spawn flow, and page-wide uploads (`c4fe4a6`)
- **cache-ttl**: provider evidence layer gates warmth, keepalive TTL, and dead-line breaker (`bb8a5e4`)
- **ask-user**: per-question skip on every surface (`d18bdcd`)
- **web-hub**: slim spawn dialog, dir browser with mkdir, preview downloads (`7976638`)
- **web-hub**: allow attachments on slash commands (block rides in args) (`76ec41e`)
- **compat**: support pi 1.1.x (`b86b86a`)
- **web-hub**: roomier phone top bar and Chinese load labels (`56a5bf2`)

### Fixed

- **web-hub**: collapse shrinks the sidebar column even after a drag-resize (`6e9f685`)
- **web-hub**: tolerate a trailing slash in preview-admission paths (`d99d4b8`)
- **web-hub**: top-anchor the new-session dialog so its top edge never jumps (`b243117`)
- **web-hub**: stop the new-session dialog jittering on each typed path letter (`58d2a99`)
- **web-hub**: SSE connect timeout + visible boot failure (was: eternal splash) (`298e334`)
- **web-hub**: LAN clipboard, load-top overflow, narrow-viewport sidebar, restore order stability (`f831052`)
- **web-hub**: keep stop inside the ring shell while usage is pending (`1a41b32`)
- **web-hub**: quota pill hoist ranks data freshness, marks stale wires (`72ac5d4`)
- **sysload**: show a disk mount only once when both display paths resolve to it (`2fe00ea`)
- **web-hub**: keep the session-history dialog stable while typing (`2ff4140`)
- **sysload**: stop announcing "load too high" on an idle machine (`02bb49f`)
- **web-hub**: show the load card's top processes (`b0a1ae7`)
- **web-hub**: give LAN top-process requests the normal auth budget (`946a105`)
- **web-hub**: slim quota and CPU pills on phones (`e267ee7`)
- **hud**: keep the web-hub status off a line of its own (`e19f4e4`)

### Documentation

- **web-hub**: aw-snap — LAN-only wedge evidence chain (trace + offline replay + headless profiler) (`5135815`)
- **web-hub**: scroll-rollback investigation file (breadcrumb live, awaiting repro) (`dc8b6c7`)
- **web-hub**: aw-snap investigation — second reproduction forensics (`ea6c02a`)
- **web-hub**: aw-snap crash investigation handoff (`be230b1`)

### Tests

- **web-hub**: allowlist Transcript.vue localStorage in source-scan (pwh_diag_scroll) (`e0d31bc`)

### Chores

- **web-hub**: freeze tracer (pwh_diag_trace) + HP3 stream test deflake (`85026ea`)
- **web-hub**: scroll-rollback diagnostic breadcrumbs (pwh_diag_scroll) (`21a1eeb`)
- **web-hub**: rebase the CSS budget on the measured size (`afd70fa`)

Stats: 15 feat, 15 fix, 4 docs, 1 test, 3 chore

## [0.5.0] - 2026-10-11

### Added

- **web-hub**: custom user avatar shared across devices [avatar:W] (`da8e7e8`)
- **web-hub**: hub-side avatar store, strict validation and routes [avatar:H] (`b9cddd6`)
- **web-hub**: avatar settings card and user-message avatar [avatar:U] (`14bbd19`)
- **web-hub**: avatar transport for token and password clients [avatar:C] (`1306fc1`)
- **web-hub**: smooth trapezoid branch lines and per-row message indent in the git graph (`bcdc2ba`)
- **web-hub**: avatar protocol surface and strict PNG validator [avatar:A0] (`680ce49`)
- **todo**: remind the main session to track work when nothing is in progress (`0a9eb88`)
- **consult**: record expert/consult identity drift in consult cache diagnostics [consult-c2] (`5cf100d`)
- **consult**: snapshot-preserving consult with per-call cache probes [consult-c2:D] (`d3e2adf`)
- **consult**: host-side prefix probe and request-level usage capture [consult-c2:E] (`7c5c54e`)
- **memory**: /mem tidy --batch for oversized memory directories [tidy-batch:P3a] (`6ea35e3`)
- **consult**: C2 preserve guard and snapshot-built consult sessions [consult-c2:B+C] (`6c1c11c`)
- **consult**: frozen surface for C2 preserve — expert snapshot, guard contract, cache probes [consult-c2:A] (`be74a0a`)
- **exp**: consult cache analysis script with retro mode [consult-c2:F] (`be5ffc3`)
- **runtime**: dispatch-time input budget for subagent runs [tidy-batch:P-RT] (`5442a91`)
- **memory**: settings for /mem tidy --batch [tidy-batch:P4] (`c9b7046`)
- **memory**: journaled transaction executor, strict manifests and txn-backed restore [tidy-batch:P2b] (`c577d49`)
- **sysload**: load-aware dispatch gate wired into the session [sysload:P2a] (`f2a5fa5`)
- **web-hub**: hub-side system load frames and /api/load/top [sysload:P3] (`326794d`)
- **memory**: journaled storage primitives and owner-token locks [tidy-batch:P2a] (`7e4873e`)
- **memory**: journal decisions, batch planning and run ledger for batched tidy [tidy-batch:P1] (`24103a2`)
- **workflow**: agent() calls wait while the load gate is closed [sysload:P2b] (`65ea6b3`)
- **sysload**: bounded load sampler, tracker and top processes [sysload:P1] (`e9c09c8`)
- **memory**: frozen types for batched tidy [tidy-batch:P0] (`8a0ac1f`)
- **web-hub**: system load pill, card and drawer banner [sysload:P4] (`bb6db5c`)
- **sysload**: frozen types, settings and protocol surface [sysload:P0] (`1a93950`)
- **web-hub**: git graph as its own detail panel (`c238090`)
- **web-hub**: preview ~/ paths and a directory path bar (`80cf4b2`)
- **web-hub**: worktree graph hub endpoint (`6fbf39d`)
- **web-hub**: worktree git graph panel UI (`72ea452`)
- **timeout**: each extension may add up to 1h (`756adba`)
- **fleet**: show subagent thinking level in agent tree, web fleet and list_subagents (`bff2340`)
- **title**: rolling-window refresh cap and post-compaction refresh (`fecf162`)
- **web-hub**: worktree graph layout logic (`33f9889`)
- **git**: bounded worktree graph git layer (`6bb44c1`)
- **web-hub**: worktree graph client transport (`cb169b5`)
- **web-hub**: worktree graph wire protocol (wtgraph.v1) (`16b9974`)
- **bash**: omit the log-path hint when the message already shows the whole log (`867bb37`)
- **web-hub**: compact stop-session control — icon button that expands into an inline confirm pill (`d21821a`)
- **consult**: record experts, consult outcomes, dispatch meta and verdict preset on every run (`4545fa7`)
- **agent**: Agent tool meta param and verdict/v1 schema preset (`13070da`)
- **consult**: core types for consult A/B instrumentation — dispatch meta, consult summary, verdict/v1 schema (`897baf5`)
- **exp**: consult A/B arm-draw and analysis scripts (`8ebf1e0`)
- **release**: one-shot release script — version bump rule, CHANGELOG generated from commits, pre-release checks, tag, push, publish (`6f55ace`)
- **topic-switch**: judge model chain is a configurable list with runtime failover (`3bb87a2`)
- **topic-switch**: suggest a clean new session when a new request is unrelated and resuming would be expensive (`003877b`)
- **cache-ttl**: CacheWarmthPort answers whether the next request would read the prompt cache (`f2bf9a3`)
- **web-hub**: optional prompt-gate port lets topic-switch claim an idle web prompt before dispatch (`c513380`)
- **topic-switch**: pi-free decision core — gates, filters, cost estimate (calculateCost parity), judge, hold reducer, recovery records (`1fbbbe9`)
- **topic-switch**: confirm dialog racing the TUI select against the web-hub remote dialog (`f76720f`)
- **web-hub**: preview attached images before sending, with zoom (`057fa85`)
- **web-hub**: compact session-history dialog; history entry pinned at the sidebar bottom (`955cceb`)
- **web-hub**: tool progress rides the card border; web badge and time share a row (`3062936`)
- **web-hub**: user messages get an avatar mirroring the assistant's; tool progress inset (`8f54b24`)
- **web-hub**: rename live sessions from the agent list (`f4e339e`)
- **web-hub**: floating '子 Agent' tab on the detail pane's right edge; title shows in full (`e93a98d`)
- **web-hub**: click the session title to collapse / expand the header rows (`5bfe745`)
- **web-hub**: slash palette — Tab completes, keep typing to filter, focus stays in the composer (`9900edf`)
- **web-hub**: content-less command notices auto-dismiss after 6 s (`88ded57`)

### Fixed

- **release**: build the web UI before running tests (`40d632c`)
- **release**: keep the generated CHANGELOG prettier-clean (`c976b69`)
- **cache-ttl**: resume keepalive pings after a successful request when they stopped on transient errors (`8e32e65`)
- **web-hub**: hide the top bar brand label instead of showing a clipped sliver (`7fb7dd8`)
- **web-hub**: long quota pill no longer pushes the settings and sign-out buttons off narrow screens (`b4c8dc4`)
- **web-hub**: wrapped inline-code paths no longer get covered by the next line on touch screens (`2f8474f`)
- **memory**: /mem tidy --batch --status shows the directory lock holder (`d21ab20`)
- **web-hub**: keep the hub process alive until close() finishes its teardown (`a352014`)
- **web-hub**: fence-loss diagnostics, test HOME sandbox guard and explicit launchHome (`5a20d48`)
- **sysload**: gate duration, HUD layout and full rejection detail (`7436b1c`)
- **web-hub**: LAN auth database breaker restarts the hub instead of staying off (`2b3e74f`)
- **web-hub**: @agent mentions behave like the terminal (`2f94172`)
- **consult-ab**: enforce verdict blocker counts, report unenrolled packages, let verifiers declare an arm (`9b401b2`)
- **web-hub**: git graph date column fits the full timestamp (`e8db15e`)
- **web-hub**: distinct avatars for subagent and plain notices (`9db94cf`)
- **web-hub**: CJK-adjacent paths, stable git graph rows and session order (`1d9f8a9`)
- **web-hub**: don't label every toolkit notice as a subagent message (`7e63676`)
- **web-hub**: close-safe hub startup and coordinated admin restart (`890afb1`)
- **subagent**: a run dispatched right before a deferred /reload no longer vanishes (`d460746`)
- **web-hub**: agent card shows the total cost only, breakdown in the tooltip, so the cwd title is no longer squeezed out (`fc38836`)
- **consult**: accept the listed 'label (r_xxx)' expert form; cap/timeout messages state the real cause and elapsed time (`64a2337`)
- **topic-switch**: /topic-switch last shows user-facing state labels instead of raw transfer states (`7e8a7bd`)
- **bash**: job-store drops a write whose directory vanished twice instead of rejecting unhandled (`0610d4b`)
- **web-hub**: ask_user card matches the composer row width; attach button no longer jumps while typing (`0f26a6e`)
- **web-hub**: composer row aligns with the transcript column edges (`309e2c3`)
- **web-hub**: composer polish — cmd badge in the sub row, card widths, armed stop halo, quieter control notice (`ee4459b`)
- **web-hub**: path links re-probe after a negative result; full-width punctuation ends a path (`6b47b7e`)
- **web-hub**: history enumeration no longer drops a dir on a self-induced budget timeout; CI-only test fixes (`5ec696f`)
- **web-hub**: rename pencil no longer reserves a blank column; fleet tab counts running only (`0dcb0e3`)
- **web-hub**: bot icon instead of the sideways '子 Agent' label; title aligns with the row icons (`58f489e`)
- **web-hub**: outdated badge says the plugin is OLDER than the hub (and to /reload) (`347d566`)

### Changed

- **cache-ttl**: remove adaptive mode and automatic 1h cache upgrades (`6203d41`)

### Documentation

- **web-hub**: record avatar implementation baseline (`73cf655`)
- **consult**: document C2 preserve consult, correct the old consult plan [consult-c2:H] (`6694048`)
- **memory**: AGENTS.md journal/lock model, tidy-batch implementation record [tidy-batch:P5] (`bd8b9c5`)
- **sysload**: AGENTS.md entry, implementation record and UI budget [sysload:P5] (`22d32e7`)
- **memory**: /mem tidy --batch plan v3.2 (journaled archive + batched rewrite) (`99986e0`)
- **consult**: record the main-expert ruling for C2 (`fa49e82`)
- **consult**: C2 preserve-tools + per-request cache instrumentation plan v3.1 (review conditional pass) (`460e891`)
- **web-hub**: user avatar upload plan v2.1 (review conditional pass) (`4e8d1a5`)
- **sysload**: load-aware dispatch plan v2.1 (review conditional pass) (`80c1b3a`)
- **web-hub**: hub resilience plan v2 + triage (self-restart replaces reversible LAN recovery) (`fe6e2c4`)
- **sysload**: load-aware dispatch plan v1 + user rulings (`9b11bd6`)
- **web-hub**: hub resilience plan (db recovery, fence false-positive, supersede TDZ) (`28421f0`)
- **skills**: route sonnet to claude-sonnet-5-5 with sonnet-5 fallback (`6d6fdea`)
- **web-hub**: worktree git graph plan (v2, reviewed) (`8cf9eaa`)
- **dev-flow**: consult A/B protocol — meta on every write-package dispatch, verdict/v1 for verifiers, arm draw and analysis (`d19ade5`)
- **consult**: A/B instrumentation plan (reviewed, conditional pass folded in) (`6a9e7e5`)
- **dev-flow**: cr-glm/glm-5.3 as the API-billed backup line for glm-5.3 (`bf6ea7e`)
- **dev-flow**: the available-models list mirrors enabledModels — registered models outside it can still be dispatched (`1f7bc7a`)
- **dev-flow**: gpt-6.1-sol stays the review/verification first choice; never silently substitute gpt-6-astra when it is missing from the model list (`c1798b8`)
- adopt the release rules (bump rule, generated CHANGELOG, release.sh flow); drop the hand-written [Unreleased] entry (`e1ee3fe`)
- **skills**: consult dispatch rules from the 2026-10 production evaluation (`944367a`)
- **consult**: production effectiveness evaluation 2026-10 (observational, 3.8k runs) (`f5037f2`)
- **topic-switch**: requirements, exploration, architecture and reviewed plan (r2 + r3 rulings) (`dd1eba3`)

### Tests

- **web-hub**: real-hub avatar integration [avatar:T] (`7610e92`)
- **consult**: real-pi conformance for C2 preserve; fix relative breakpoint rule in prefix comparison [consult-c2:G] (`962b20d`)
- **web-hub**: cross-domain resilience matrix (self-restart cookies/SSE, DB slowness bounds, silent successor, concurrent close) [hub-resilience:P-Int] (`d9a8d00`)
- **web-hub**: load capability matrix, rate limit, lifecycle and import-closure gates [sysload:P3] (`2aea630`)
- **web-hub**: worktree graph integration gate, acceptance checklist and docs (`7f9e17e`)
- **topic-switch**: real-pi conformance probes S1–S9 for the session hop, re-inject and recovery assumptions (`c595bc9`)

### Chores

- **web-hub**: budget first-screen JS separately from lazy chunks (`0539ddf`)

Stats: 59 feat, 31 fix, 1 refactor/perf, 23 docs, 6 test, 1 chore

## [0.4.0] - 2026-10-09

两天的 web-hub 冲刺（110 commits）：历史会话列表与恢复、steer 撤回/重新编辑、worktree diff、目录与任意路径预览、订阅额度展示，以及一大批界面打磨与流式渲染修复。

### Added

- **历史会话列表 + 恢复（`webHub.spawn.history`，默认开）** — 网页上浏览本机全部过往 pi 会话（分页、搜索、近似按修改时间排序），一键经 managed spawn 原地恢复（`--session`）；会话正被在线卡片/托管记录/本机 pi 进程占用时自动改为副本打开（hub 自建快照，原文件不动）。占用检测为尽力而为（W1–W7 已在界面与文档披露）；fd 锚定遍历、有界 IO、恢复重开同样核验会话文件身份。需启动 hub 的 pi 已 `/reload` 后再 `/webhub restart` 才会声明 `spawn.history.v1`。
- **steer 撤回 / 重新编辑（`webHub.steerRecall`，默认开）** — 网页发出的插话/后续消息先暂存在 agent 侧，逐条交给 pi（仅凭归属到的消费证据放行下一条，绝不靠计时器）；交出前可在队列里撤回或拿回输入框改完再发，已交付则显示「已交付」只可复制。TUI 状态栏 `web held N`。关闭时与旧行为逐字节一致；上一轮遗留未确认项时新消息退回原生发送（不可撤回）以保活性。
- **worktree diff** — 会话仓库各 worktree 的逐文件 diff（split/unified），hub 侧经三 fd 钉住的 `diff-index` 计算，外部驱动三层中和，只读、按当前 HEAD 钉死、拒绝名单隐藏；随 `webHub.preview` 门控。
- **预览扩展** — 任意绝对路径（凭据拒绝名单兜底）与相对路径（read/write/edit 工具卡）可预览；目录浏览（下钻/返回、三重上限）；Markdown 默认渲染并可切源码；候选路径先探测存在再可点；会话 cwd 一键打开目录预览。
- **订阅额度展示** — 顶栏额度药丸 + 详情卡片：每个订阅的 5h/7d 可用性、降级与重置时间、耗尽预测；GLM 与 GLM 国际始终合并为一个「GLM」（逐窗口取更紧的一侧）。
- **界面与设置** — 工具卡显示执行耗时；语言改为下拉菜单（按钮显示当前语言）；设置新增「隐藏明文 HTTP 警告」「动态效果（跟随系统/始终开启/始终关闭）」；默认模型改为与输入框切换按钮同款的只选不输选择器；会话订阅保活（切回不再重拉）与按会话记忆滚动位置；动态/静态资源 gzip 协商；思考面板随最新行滚动；PWA 图标与名称更新为 π 品牌。
- **hub 进程可识别** — hub / 登录数据库子进程 / reaper 的进程名分别为 `pi-webhub` / `pi-webhub-auth` / `pi-webhub-reap`（只写 `/proc/self/comm`，命令行不变，身份核验不受影响）。
- **显式 `timeout_s` 也享有宽限 + 延长** — `Agent` 与 `SubagentWorkflow` 显式超时进入宽限窗口并可 `extend_subagent_timeout`，`timeoutPolicy` 随 run 持久化与 resume 继承。
- 子会话写入 `subagent:child` 标记条目，历史列表据此区分主会话与子代理会话。

### Fixed

- 流式思考/正文首个片段偶发重复（「AllAll」）：assistant `message_start` 不再携带 pi 仍在改写的共享 content，快照的 inflight 改由已发出的增量重建。
- 历史分页：每读一个会话头泄漏一个 fd 预留（约 28 个文件后永久失效）；续翻时页内未按修改时间排序；fd 预留恰好释放一次。
- 网页 `message_agent` 回复根会话在 transcript 中不可见；控制操作在切换会话后仍指向首个打开的会话。
- 超过 `setTimeout` 2³¹−1 ms 的延时改为分段重排；终态 run 的耗时冻结在 settle 时刻。
- 一批布局问题：顶栏图标被挤压/被连接状态遮挡、语言与设置按钮间距、手机额度卡片过窄、fleet 树空箭头列、bash 任务行长命令换行错乱、composer 在短会话中悬空、思考/工具/diff/代码区滚动卡死、长路径换行、worktree 面板与 diff 列表状态保持等。
- 会话列表称谓由「代理」改为「会话」；git `--untracked-files` 绑定方式导致 worktree 探测漏报改动；hub 从 `/proc/self/cmdline` 记录 argv。

### Changed

- 网页 UI JS gzip 预算提升到 232 KiB（steer 撤回 + 历史会话 UI）。
- worktree 采样时间移入摘要提示；worktree 面板默认折叠。

## [0.3.0] - 2026-10-07

一个月的主线累积（652 commits）：web-hub 浏览器端从零到全功能、consult 专家请教、系统提示词冻结快照、cache-ttl 自适应、workflow 编排体系、subagent 崩溃恢复，以及一批移动端体验打磨。

### Breaking / Migration

- **主会话 `Agent` 工具改为后台制** — 每次调用立即返回 `run_id`，完成时推送通知，用 `get_subagent_result` 收取结果；派发后不再阻塞当前回合。嵌套 `Agent`（子会话内注入的那个）保持阻塞语义不变。
- **`SubagentWorkflow` 同样改为后台制** — 返回 `wf_…` id，终态推送通知；同样经 `get_subagent_result` / `abort_subagent` 管理。
- **任务清单面板命令更名**：`/tasklist`（原 `/tasklist clear` 语义不变）；旧命令名不再注册。
- **模型面工具参数 `timeout_ms` 更名为 `timeout_s`**（`Agent` / `SubagentWorkflow`），语义不变。
- **`compact_context` 默认不再注册**：`compact.switchTool`（默认 `true`）开启后，模型面只暴露 `switch_context`。需要旧工具并存时设 `compact.keepCompactTool: true`；要完全回到旧行为设 `compact.switchTool: false`。强制压缩安全网不受影响——它在扩展内部直接调用 pi 的压缩，不依赖工具是否注册。

- Remove the standalone `@bluecake/pi-ask-user` package before enabling the merged entries. Existing Feishu configuration is reused; a startup conflict warning indicates the old package is still loaded.

### Added

- **web-hub 浏览器端（`webHub.*`）** — 一台机器一个 hub 守护进程，浏览器里看/控所有 pi 会话：P1 只读面板（fleet 列表、会话详情、transcript 回放），P2 控制面（发 prompt、abort、steer/abort subagent、网页侧 slash 命令、ask_user 双通道抢答），LAN 模式（用户名密码 + SQLite 会话 + 可信反代源站），附件上传，会话内文件预览（cwd 子树 + 上传件，256KiB 文本 / 16MiB 图片上限），会话卡片两步删除（身份探针确认死亡才落删），worktree 面板、bash-jobs 面板、run transcript 抽屉、模型/thinking 切换 chips，managed spawn（hub 在用户选定目录里 fork `pi --mode rpc` 子会话，含孤子收割与身份核验），以及 **spawn restore**——hub 重启后 managed 会话经「停旧进程 + `--session` 重开」自动恢复，恢复上限 3 次防循环。配套移动端体验全线打磨（登录页、抽屉、composer 卡片、设置浮层、Prism 高亮、PWA manifest+图标）。
- **`consult` 工具（in-turn 专家请教）** — 派发时挂 `experts` 白名单的 subagent 可在自己回合内同步请教已完成的专家 run（只读 fork 会话作答，首轮成本/上下文预检 + 回合边界上限）。保留字 `"main"` 让子 agent 以同样方式请教主会话（实时读 session 文件/模型/上下文用量，带一致性复检）。
- **系统提示词稳定化（sysprompt-stable）** — 项目记忆 / agent 类型 / 可用模型三个动态段落不再每轮重 appended（整段缓存前缀失效），改为冻结快照 + 有界尾部更新消息（≤3 chunks / ≤32KB），快照经 `subagent:prompt-sections` 条目跨 /reload、跨进程续命。`systemPrompt.mode: stable|live|legacy` 三态，唤醒回放与外来 forced-prompt 各自有开关。
- **cache-ttl 自适应 + 子会话保活** — 按实测经济学自动决定 5m/1h 缓存档位：美元边际预算门（`adaptiveWriteBudgetUsd`）为主、token 预算兜底；一次入场费独立预算；warm/cold 判据把保活的 proven-hit 读起点算进来；保活与 1h 按空档择一（`keepaliveGapHorizonMs`）；已覆盖前缀续期读崩塌时学习路由 1h 寿命上界。子会话保活 capture-only，11/窗 · 24/run · $1.5/run · $10/24h 限额，成本计入子 run。
- **SubagentWorkflow 编排体系增强** — `agent()` 超并发上限时 FIFO 排队而非失败；`opts.model`/`opts.thinking` 真·按次覆盖且进 journal key；`experts` 让 workflow 子调用也能 consult（本 workflow 同名 call 优先）；`isolation:"worktree"` 真隔离（H2/H3 worktree，workflow 永不替你 merge）；`isolationReplay:"verify"` 下已提交分支的隔离调用可安全 replay（分支仍指向记录 commit 才命中）；journal 预加载有 5s 上限，超时降级为全 live。
- **subagent 崩溃恢复（run-persistence + labelFallback）** — run 在 `session_created` 即落非终态 journal，pi 崩溃/重启后以 `aborted` 种回注册表，`resume` 可按 run_id **或 label**（重启后 label → run_id 映射丢失时回退扫描 journal）恢复；`get/steer/abort` 同享 label 回退。
- **compact-hint 动态阈值** — 价格感知的动态提示线（`compact.dynamicThreshold.mode=on`），可用时取代静态线；窗口缩小时强制线自动上浮（1M→88，200k→91）；强制层先礼后兵——先要求模型本回合 `switch_context`，不照办才回落通用强制压缩。
- **bash 超时宽限与子会话 settle-hold** — 带显式 `timeout` 的后台 job 到期先进入宽限窗口而非直接杀，`bash_job(action:"extend")` 可延期（`bashJobs.timeoutGraceS` / `maxExtensions` / `maxTimeoutFactor`）；子会话有非终态 job 时 `agent_before_settle` 挂住 run 完成，按有界轮次提醒。
- **memory v2（cwd 键控项目记忆）** — tiered 注入布局 + v2 工具面为默认（legacy 设置字节兼容退出）；整文件/整段准入 + UTF-8 字节预算渲染；`/mem doctor`（D01-D14 体检）、`tidy`、`restore`；所有写操作串行于目录锁。
- **子会话 `switch_context`（child-context-switch）** — 非 consult 子 run 按进程级能力状态机（unknown → static-ok → observed → ready → verifying → verified）授予上下文交接，L0-L3 逐级探针，任何 pre-verified 失败立即禁用；拒绝理由进 `diag.contextSwitches.rejected[]`。
- **todo 面板上网页** — 只读摘要经 `StatusInfo.todo` 槽到 web 详情页头部的可折叠 TodoPanel（32 任务 / 240B 描述上限）。
- **HUD 增补** — 版本戳（`toolkit v<ver>@<commit>`）、周期 `git fetch`（`hud.autoFetchMinutes`）、quota 常驻行。
- **额度感知派单（`src/quota/`）** — 定时拉取 GLM / Kimi 订阅额度（懒触发、TTL 缓存，零周期定时器），turn_end 注入阶梯预警（L1 tick `[quota]` 合并行 → L2 建议「回退链降一位」 → L3 禁用建议），spawn 阶段对越过 `quota.gateLevel` 的 provider 快速失败（不消耗 run；陈旧快照只提示不阻断），HUD 常驻状态行（`·stale`/`⤓demoted` 标记）；降位标记持久化到 `~/.pi/agent/quota-state.json`，跨重启存活到窗口重置。`quota.*` settings 全量可关，设计见 `docs/dev/quota/`。

- **`switch_context` tool（上下文切换）** — 模型把「要带到下一段上下文的状态」直接写进工具参数（`goal` / `progress` / `next_steps` / `decisions` / `key_files` / `pitfalls` / `open_questions`），这段文本经 `session_before_compact` 直接成为 pi 压缩条目的 summary：**不再跑第二次摘要 LLM**，保留什么完全由模型决定。`keep_recent:false` 时压缩点之前的消息全部丢弃（真正的「换到下一个会话」语义），但会话文件、在跑的 subagent、后台 bash 任务、todo 与成本统计都不受影响。扩展还会自动补一段机械附录：本段读/改过的文件、仍在跑的 subagent 与 bash 任务、未完成的 todo、上一段会话文件路径。交接内容过短或缺必填字段会被工具当场打回，不触发压缩。

- **Merged `ask_user` and Feishu notifications** — the package now exposes the interactive clarification tool and Feishu notification extension through three pi entries. Completion, subagent-summary, and idle cards wait for a background-idle session; heartbeat, waiting-input, and explicit notifications remain immediate.
- **Background status provider** — the host publishes live subagent and background-bash counts through a reload-safe global provider.

- **Background status provider** — the host publishes live subagent and background-bash counts through a reload-safe global provider.

- **`compact_context` tool** — the model can proactively trigger context compaction (equivalent to `/compact`) instead of waiting for the automatic threshold. Registered only in the host session; an in-flight guard plus cooldown refuses back-to-back triggers, and an optional follow-up message resumes the task on the summarized context. Configured via `compact.enabled` (default on).

- **message fabric** — an opt-in, fire-and-forget message protocol for subagent runs. The `message_agent` tool sends `progress`, `finding`, or `directive` messages through tree-edge routing with `canMessage` relationship gating; delivery is bounded by per-link quotas and throttling, with dead-letter handling for failed actionable messages and a root ingress gate for context traffic. Agent-type frontmatter can declare allowed relationships, and the 11-key `fabric.*` configuration surface is disabled by default for gradual rollout.

### Changed

- **compact-hint 三层改为催「自写交接」** — usage tick 与 L1 提示改为推荐 `switch_context`；L2 强制层改为先礼后兵：越过强制线时先硬性要求模型在本回合调用 `switch_context`（次数由 `compact.forceDemandTurns` 控制，默认 1），只有它不照办才回落到原来的通用强制压缩。交接文本已暂存、压缩尚未完成时，既不再催也不会抢先强制压缩。

- **`get_subagent_result` description** — now states the poll-guard contract explicitly (reads never consume the run; rapid repeated polling of the same run returns a warning — await the completion notification), matching the wording `bash_job` has carried since the guard landed.

- **poll guard retuned to real loop shapes** — the frequency window for non-blocking reads (`get_subagent_result` without wait, `bash_job` status) is now 120s/3 calls per key, up from 10s: each poll costs a full model turn (seconds to tens of seconds), so a 10s window only ever caught same-message bursts and never a real cross-turn polling loop. Blocking waits are no longer frequency-counted at all; instead a consecutive-timeout streak guards them — a wait blocks up to its budget by design, so the loop signal is the same run/job timing out again and again. The first timeout already states the two ways out (raise `wait_ms`, or end the turn and await the completion notification); from the 2nd consecutive timeout the message escalates with the streak count and cumulative time spent blocked, and any terminal outcome resets the streak.

### Fixed

- **web-hub 修复批次（111 项）** — 移动端排版/触控（登录节奏、抽屉宽度、composer chips、上下文环、标题行距）、协议与状态一致性（caps 两面同源、epoch 竞态、dialog 409/closed 语义）、上传/预览边界（sha256 复核、O_NOFOLLOW、/proc/self/fd 复验）、LAN 会话与代理源站校验等；另修复 fabric 路由/配额（11 项）、bash job 生命周期（11 项）、cache-ttl 判定（13 项）、quota 窗口与 HUD 计数（7 项）、workflow 终态与 journal 边角（6 项）。
- **`/reload` 与重启后的状态存活** — fleet widget 闪烁、handover 竞态、cron 调度器跨 reload 交接、通知补投递（`subagent:workflow-notice` 条目由下一个 stack 重投）等一批重启/重载路径修复。

## [0.2.1] - 2026-09-05

### Fixed

- **subagent result text** — completed runs now use the final assistant message as their outcome text, including the value returned to workflow `agent()` calls, instead of concatenating all streamed narrative deltas.

- **fleet widget** — the agent tree no longer blinks off/on after `/reload`. pi's reload re-imports the extension as a fresh module (jiti `moduleCache:false`), so the module-level `previousFleetWidget` handoff never saw the pre-reload controller; and since the stale `ctx.ui` closures keep working (`setWidget` has no `assertActive`), the old controller's self-rescheduling 1Hz tick outlived its session forever, pushing `setWidget(undefined)` over the new session's frames — one extra blink per reload. `Stack` now exposes `fleetWidget` and `session_shutdown` disposes it.

### Changed

- **subagent result tools** — completed text returned by `Agent`, `get_subagent_result`, and nested `Agent` calls is capped by the live `resultMaxChars` setting (default 8000, 0 for unlimited), with a session transcript path for full output.

- **fleet widget / tool card** — the thinking phase label is now animated: the icon cycles through four emoji frames (`🧠思考 → 💭思考 → 🤔思考 → 💡思考`) derived from wall time (1s quantum), so the 1Hz widget/panel tick advances it by exactly one frame with no render-side animation state. Frames are deliberately unambiguous-width emoji — an earlier braille-spinner version wrap-flickered CJK terminals (braille is East Asian Ambiguous: terminals render it 2 columns, string-width measures 1). `phaseLabel(phase, diag)` without a `now` keeps the static `🧠思考` form.

- **bash jobs** — `bashJobs.dir` is now a root containing one sanitized `<sessionId>/` directory per pi session; flat records are migrated when their owner is dead, list/status visibility is session-scoped, and in-process reload/new/fork transfers live jobs. Cold starts adopt owner-dead orphan jobs. Session directories are garbage-collected with the same `.json`/`.log`/`.tmp` safety rules as the job store; this is visibility isolation, not an OS security boundary.

### Added

- **bash auto-backgrounding** — the built-in `bash` tool is overridden by name (POSIX only) so a
  foreground command that outlives `bashJobs.autoBackgroundS` (default 120s) no longer blocks the
  turn: the call returns a `job_id`, **the process is not killed**, its merged stdout/stderr keeps
  streaming into `~/.pi/agent/bash-jobs/<job>.log`, and a `bash-job:notification` message (with the
  output tail, `triggerTurn`) is injected exactly once when it exits — including after a `/reload` or
  a pi restart, where still-running jobs are re-adopted from disk and a job whose pid ownership
  cannot be verified is marked, never killed. Short commands are byte-for-byte the built-in tool's
  own result (the foreground path delegates to pi's bash implementation, including its `timeout`,
  abort and truncation semantics), so the only intentional behaviour change is that a command past
  the threshold returns a `job_id` instead of blocking indefinitely. New `bash` parameter
  `run_in_background: true` backgrounds immediately; the new `bash_job` tool inspects and stops jobs with four
  actions (`status` / `wait` / `kill` / `list`): `status` returns a state summary **plus the tail of the log**
  (last 20 lines / 2KB, context-guarded), `wait` is bounded, `kill` is idempotent and pid-reuse guarded, `list`
  enumerates known jobs. There is deliberately no `output` action — the log is a plain file
  (`~/.pi/agent/bash-jobs/<job>.log`) and every model-facing string (tool descriptions, the backgrounding replies,
  the completion notice, `/agent status`) says so, so the model reads it with the `read` tool or with
  `tail`/`grep`/`awk` instead of being confined to a tool's parameters. The log is also self-contained: a single
  footer line — `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s`, with no exit code invented for
  killed / timed-out / exit-code-lost jobs — is appended once when the process settles, counted in the log's byte
  total, and written even past `maxLogBytes` so a `tail -3` always reveals the outcome. Configured under `bashJobs.*` (`autoBackgroundS` — `0` disables the whole
  feature and registers no override, `maxLogBytes`, `maxBackgroundJobs`, `retentionS`,
  `shutdownPolicy`, plus JSON-only `dir` / `shellPath`) and surfaced in `/agent status`. Only jobs
  that actually reached the model as a `job_id` are retained: a command that finished in the
  foreground already returned its full result through the tool call, so its record and log are
  dropped shortly after it settles instead of lingering for `retentionS` and burying `bash_job
list` under every `echo`. Retention itself is a whole-directory sweep: besides expired terminal
  records it also reaps the litter that never becomes a record — unreadable/badly named `.json`
  files, orphan `.log` files with no record beside them (aged by file mtime, and never while the
  job is still tracked in memory) and `.tmp` debris from an interrupted atomic write (fixed 1h
  TTL) — each such deletion is WARNed. Only `.json` / `.log` / `.tmp` names are ever touched, a
  file whose mtime cannot be compared to the clock is always kept, and a non-terminal record is
  never pruned. The sweep runs on session start **and**, throttled to once per 10 minutes, when a
  new bash job is created, so a session that stays open for days still cleans up — without adding
  a single timer.
- **Zero-build git installs** — the `pi.extensions` manifest now points at a source-form
  root entry (`./index.ts` → `./src/index.js`), which pi loads through its bundled jiti
  TypeScript runtime. `pi install git:github.com/Newbluecake/pi-subagent` and
  `pi update --extension ...` now work end to end despite `dist/` staying gitignored (pi's
  git install runs no build). The `@earendil-works/pi-*` peers are marked
  `peerDependenciesMeta.optional` (pi aliases them to its own bundled modules) and duplicated
  in `devDependencies`, so pi's `npm install --omit=dev` in the clone no longer pulls a
  second copy of pi. The compiled `index.js`/`dist` entries remain for npm/Node consumers.

## [0.2.0] - 2026-09-02

### Added

- **Caller-ack notification suppression (delivery v2 P3)** — foreground callers can acknowledge completed outcomes to suppress undelivered notifications; the `ackWindowMs` hold window is disabled by default and fails open on persistence or cancellation errors.
- **`abort_subagent` tool** — stop a running subagent by run id, unique prefix, or Agent label; terminal runs return an idempotent already-finished result.
- **Foreground auto-backgrounding** — foreground Agent calls now return after 10 minutes by default when the run is still active; the run is not stopped and can be collected with `get_subagent_result`.
- **Fuzzy model hints** (parity with upstream @tintinweb/pi-subagents) — agent
  frontmatter `model:` and the Agent tool's `model` param now accept a bare model
  id (`kimi-k3`) or a case-insensitive substring alias (`sonnet`, `haiku`) in
  addition to a strict `provider/id`, resolved against pi's available models at
  spawn admission (`src/config/model-hint.ts`; matching tiers: strict pair →
  exact id → id prefix → id substring → display-name substring, candidate order
  breaks ties). Unresolvable hints are rejected with a self-correcting config
  error before any state write — never silently downgraded to the parent/default
  model. Pinned models are shown in the injected "Available subagent types"
  prompt section, and `modelHint` participates in the agent-type config hash so
  editing a hint correctly misses workflow journal replays.

### Fixed

- **Extension shows as "pi-subagent/index.js" in pi's resource list** — pi names
  package extension items after the entry file's location
  (`<parentDir>/<fileName>`), so the old `./dist/index.js` entry displayed as
  "dist/index.js". The `pi.extensions` entry now points at a thin package-root
  `index.js` re-export; the compiled implementation still lives in `dist/`.

- **Sub-phase deadline enforcement is real now** — the `EventWatchdog` was constructed with
  `getState`/`dispatch` no-op stubs ("M1 documented limitation"), so `idleMs`, `firstEventMs`,
  `toolMs`, etc. were computed and armed but never fired; only the runner's total-budget
  `setTimeout` race actually terminated a wedged run. A slow-but-trickling provider stream
  therefore hung the run until `totalMs`. The watchdog is now late-bound to the live runner
  (`getRunState` + new `fireDeadline`, which folds `deadline_fired` into the state machine
  and cancels the run's CancelHandle so the prompt guard unblocks immediately).
- **`retry_backoff` blind spot** — `dueAtFor` had no branch for it and `deadline_fired` was
  explicitly ignored there, so a wedged pi auto-retry could keep a run alive forever.
  Now backed by `idleDueAt` (covers the current backoff delay + slack).
- **`model_turn` idle semantics** — the old `phaseEnteredAt + idleMs` rule would have
  false-killed legitimately long thinking turns once enforcement was on. Now the idle
  deadline is silence-based (`lastEventAt + idleMs`), plus a new per-turn hard cap
  `modelTurnMs` (default 15 min) so a trickling turn still dies bounded.
- **Timeout outcomes no longer misreported as `aborted`** — cancelling the prompt guard
  after a watchdog deadline now yields `timed_out` with the original `timeoutReason`
  (e.g. `idle`), not `aborted`/`"total"`.
- **`prompt_dispatch` phase actually entered** — the runner never dispatched it, so a hung
  `prompt()` sat in `extension_bind` and would have reported a misleading bind timeout.
- New budget field: `modelTurnMs` (default `900_000`, `0` disables).

## [0.1.0] - 2026-09-01

First public release: anti-hang subagent extension for pi — drop-in replacement for
`@tintinweb/pi-subagents` core (`Agent` / `get_subagent_result` / `steer_subagent`).

### Features

- **Core**: pure run state machine with per-phase deadline budget (`d295ade`)
- **Runtime/service**: slot pool, session driver, runner, watchdog, escalating reaper, spawn/query services, notifier outbox (`6421dbd`)
- **Tools**: `Agent`, `get_subagent_result`, `steer_subagent` + `/agent status` command (`049e7a0`)
- **Presentation**: live execution visibility — model/label/tool-trail in diagnostics, streaming foreground tool card, agent-tree widget above the editor, completion notifications (`d713afb`)
- **Agent tree**: workflow group headers, theme colors, human-friendly phase labels, live activity line (thinking stream + tool trail with args preview on its own row) (`e287942`, `2d25b32`, `46c9cf7`, `d51f07a`)
- **Tools**: subagent spend flows into pi's session cost totals; real-time 1Hz usage broadcast (`a477efe`, `0450568`)
- **Delivery**: human-first notification head — `Subagent "label" (#shortId) status` (`65f2dab`)
- **Index**: inject registered agent types into the system prompt via `before_agent_start` (`735143b`)
- **Tools**: `renderCall` for the Agent tool card — task label, type, background/resume/isolation markers (`9c5f830`)
- **Workflow**: sandboxed `SubagentWorkflow` engine — worker + VM isolation, two-phase host-call protocol, script API (`agent`/`parallel`/`pipeline`/`phase`), abort propagation, journal & replay (`edbdd91`…`745e831`)
- **M2**: worktree isolation, resume, nested delegation (X3), structured output (X10), dynamic tool scope (X11), usage accumulation (`0c04d6b`, `6afc6de`, `5ba2a41`)
- **M3**: scheduler (X5), `@mention` steering (X6), RPC wiring (X8) (`b8baa40`)
- **Config**: built-in `general-purpose` and `Plan` agent types; user settings from `~/.pi/agent/pi-subagent.json` (`91deff8`, `6bc4cef`)

### Bug Fixes

- **state-machine**: keep `tool_exec` until the LAST parallel tool settles — the tree's tool-vs-model distinction was wrong mid-parallel-calls (`535e717`)
- **presentation**: model always shown as `provider/id` — the bare id is ambiguous across providers (`f2cfd9c`)
- **index**: release the globalThis host claim on `session_shutdown` so pi `/reload` re-activation works; child sessions stay inert (`04ac9b5`, `d4ff8b6`, `a82b5f1`)
- **runtime**: map pi `Usage.cost.total` to `costUsd` — raw pass-through NaN-poisoned the accumulator (`0ccbb37`)
- **query/delivery**: in-flight runs visible in registry; no duplicate notifications on restart (`e6ca57b`)
- **driver**: resolve model overrides via ModelRegistry + surface turn errors (`7df9307`)
- **resume**: release both resume lock keys — P1 lock leak (`4b2189a`)

### Documentation

- README — features, agent tree anatomy, anti-hang architecture, configuration (`58aa4ed`)

Stats: 30 feat, 12 fix, 1 refactor, 1 docs, 3 chore/test · 970+ tests (state-machine transition matrix, seeded property invariants, widget rendering)

[Unreleased]: https://github.com/Newbluecake/pi-toolkit/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/Newbluecake/pi-toolkit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Newbluecake/pi-toolkit/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Newbluecake/pi-toolkit/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Newbluecake/pi-toolkit/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/Newbluecake/pi-toolkit/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/Newbluecake/pi-toolkit/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Newbluecake/pi-toolkit/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Newbluecake/pi-toolkit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Newbluecake/pi-toolkit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Newbluecake/pi-subagent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Newbluecake/pi-subagent/compare/v0.2.1...v0.3.0
[0.2.0]: https://github.com/Newbluecake/pi-subagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Newbluecake/pi-subagent/releases/tag/v0.1.0
