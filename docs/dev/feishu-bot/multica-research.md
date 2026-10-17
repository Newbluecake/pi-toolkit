# multica × Feishu/Lark bot — research for a pi extension port

Source: shallow clone of `multica-ai/multica` (HEAD 2026-10-17). Paths relative to repo root.
Core code: `server/internal/integrations/lark/` (adapter, ~26k lines incl. tests) and
`server/internal/integrations/channel/engine/` (channel-agnostic Router/Supervisor/Session).
Public docs live on multica.ai/docs/channels (not in repo); README.md:105 says new Feishu/Lark
connections are mainland-Feishu-only for now. No scope list is documented in the repo — see §2.

## 1. Architecture

- **Host**: the Go backend server itself (`server/cmd/server`), same process as the REST API and event bus. Not a
  separate bot service. Postgres-backed (installations, bindings, dedup, audit, typing ledger).
- **Agents are NOT driven in-process.** A Feishu message becomes a `chat_session` row + `chat_message` row + an
  `agent_task_queue` task (`channel/engine/router.go:347+`, `tasks.EnqueuePreparedChannelChatTaskInTx` ~L420). A separate
  **daemon** (`multica daemon`, `server/internal/daemon/`) on the user's machine claims tasks (server pushes a WS wake
  signal; 30 s catch-up poll — `CLI_AND_DAEMON.md:305,316`) and spawns the local agent CLI (claude/codex/hermes…).
  Result returns via task completion → event bus `EventChatDone` / `EventTaskFailed` → `lark.Patcher`
  (`lark/outbound.go:190-260`) sends the reply. So the bot is a thin IM↔task-queue bridge; the agent is decoupled.
- **Layering** (`channel/engine/doc.go`): `channel.Channel` interface (Connect/Disconnect/Send/Capabilities,
  `channel/channel.go`) ← `Supervisor` (per-installation connection, lease, backoff) ← shared `Router` pipeline with a
  per-platform `ResolverSet` (installation/dedup/identity/session/audit/typing/media). Same engine hosts Slack,
  DingTalk, WeCom, Telegram. Feishu = `feishuChannel` (`lark/feishu_channel.go`).
- **One bot app per agent**: `lark_installation` is UNIQUE(workspace_id, agent_id) and UNIQUE(app_id)
  (`server/migrations/109_lark_integration.up.sql`). Each agent gets its own self-built "PersonalAgent" app.

## 2. Feishu side

- **Event intake = WebSocket long connection, no webhook.** Hand-rolled client of Feishu's long-conn protocol
  (deliberately not the official SDK): bootstrap `POST {host}/callback/ws/endpoint` with app_id/secret
  (`lark/ws_endpoint.go:135`) → dial returned URL (gorilla/websocket) → protobuf-ish frames decoded in
  `ws_frame.go`/`ws_frame_decoder.go`, multi-frame chunk reassembly (`ws_chunk_assembler.go`, 5 s TTL), app-level ping at
  the server-supplied interval (default 2 min), 6 min read deadline, ACK echoes inbound headers
  (`ws_connector.go:12-24, 60-110`). Enrichment must finish inside Feishu's ~3 s ACK window (`EnrichTimeout` 2 s,
  `ws_connector.go:55-66`). Because it's WS, there is **no verification token / encrypt key / public URL** to manage.
  Risk note in `ws_endpoint.go:43-50`: long-conn is documented for 企业自建应用; PersonalAgent archetype compat was an open
  question (it works in practice).
- **Events handled: only `im.message.receive_v1`.** Everything else is dropped with an info log
  (`ws_frame_decoder.go:19-22,75`, `ws_connector.go:356-360`). **No card-action callbacks, no bot-menu events, no
  reaction/read events** (grep for `card.action`/`menu` in the lark package: empty).
- Group vs p2p: `chat_type` p2p|group (`ws_frame_decoder.go:315-317`). In groups only messages that @-mention this bot
  are processed (`router.go:~350` `DropReasonNotAddressedInGroup`); p2p ingests everything. @-bot detection compares
  `mentions[].id.union_id` to the bot's union_id (captured at install via `/bot/v3/info` + contact lookup), falling back to
  open_id (`ws_frame_decoder.go:327-360`; migration 112) — needed because in a multi-bot group open_ids differ per app.
- **Auth: tenant_access_token only** (`POST /open-apis/auth/v3/tenant_access_token/internal`, cached per app_id,
  refresh-and-retry once on 99991663/99991664 — `http_client.go:196-312`). No user_access_token / OAuth for messaging.
- **APIs used** (= effective scopes needed; names inferred from endpoints, repo doesn't list them): send/reply/patch
  messages `im/v1/messages[/{id}/reply]` (http_client.go:333-341,492), get/list messages (quoted-reply + recent-group
  history context, 612-703), download message resources (766), reactions add/delete/list (947-1024), `bot/v3/info`,
  `contact/v3/users[/batch]` (names/union_id; degrade gracefully if contact scope denied, 1084/1187).
  Implied scopes: im:message (send/read), im:message.group_at_msg + p2p_msg receive, im:resource, im:message.reactions,
  contact:user.base:readonly (optional).
- **App creation is automated**: RFC 8628 device flow against `accounts.feishu.cn/oauth/v1/app/registration`
  (`archetype=PersonalAgent`, `auth_method=client_secret`) — user scans a QR in Feishu, app + app_id/secret are created and
  returned with the scanner's open_id (`lark/registration.go:15-80`, `registration_service.go`). Region (feishu/lark) is
  auto-switched mid-poll via `tenant_brand`. No manual developer-console setup — a big UX win.

## 3. Message → session/agent routing and persistence

- **Mapping**: `(installation, BindingKey) → chat_session` (`channel/engine/session.go:260-300`, UNIQUE
  (installation_id, channel_chat_id)). Feishu key (`lark/feishu_resolvers.go:195-210`): p2p or plain group → `chat_id`
  (one continuous session per chat); group **topic (话题, thread_id present) → `chat_id:thread_id`** (one session per
  topic). Real chat id kept in binding `config` for outbound.
- **Concurrency** = many sessions simultaneously, one per chat/topic; same-session messages are serialized (binding row
  lock, `session.go:670`) and **debounced 3 s** into one agent run (`engine/batcher.go:8-12`, per session+context
  generation; crash inside window drops the pending trigger, redelivery recovery exists: `scheduleRecoveredRun`).
- **Commands** (parsed engine-wide, first line only, case-sensitive — `engine/fresh_command.go`): `/new [text]` rotates to a
  new chat route generation (old retired, `route_revision`+1, atomic in tx; `session.go:437-530`); `/clear [text]` = fresh
  context within the session; `/issue <title>` creates a tracker issue (`engine/issue_command.go`). **No list/switch/stop
  commands**; sessions can't be re-selected from IM (old ones live in web UI). Concurrency across sessions is implicit
  via chats/topics, not managed.
- **Per-user**: p2p session creator = the sender; **group session creator = installer** (`router.go:~410`
  `sessionCreator = inst.InstallerUserID`), but identity + invoke permission are checked per _sender_, so one group
  session is shared by all members (single transcript, multiple authors). Group history context ("recent messages",
  quoted/forwarded content) is fetched on demand (`inbound_enricher.go`, topic-scoped for threads).
- **Persistence**: everything in Postgres; sessions survive restarts; WS ownership via per-installation DB lease
  (`ws_lease_token/expires_at`; TTL 180 s, renew ≤60 s, `engine/supervisor.go:189-214`) so only one replica connects.
  Agent-side transcript resume handled by the daemon (per-agent session store, e.g. Codex/Hermes stores, GC'd by TTL).

## 4. Output path

- **No streaming.** The original thinking→streaming→final card lifecycle was removed after user feedback that cards felt
  like system notifications; now exactly one reply per `EventChatDone` (`outbound.go:190-210`). Card-patch plumbing
  (`CardStatus`, `PatchInteractiveCard`, `update_multi`) still exists but only the **error card** (`EventTaskFailed`) is used.
- **Format selection** (`markdown_detect.go:39`, `outbound.go:437-490`): no markdown → `msg_type=text`; any markdown →
  schema-2.0 interactive card with a single `markdown` element. Replies prepend an @mention of the sender in groups.
- **Reply targeting**: topic trigger → `reply_in_thread`; plain group → native reply to the trigger message; p2p → chat send;
  fallback to chat-level send only when the reply target is unusable, never on ambiguous/timeouts/rate-limit (230020) to
  avoid duplicates (`outbound.go:565-620`, `http_client.go:1351-1395`). Topic session with no trigger → reply skipped rather
  than leaking into parent group (`outbound.go:469`).
- **Progress display**: only a "Typing" emoji reaction on the user's message while the run is active, removed on
  reply/fail/cancel (`typing_indicator.go:19-50`); skipped for messages >2 min old (reconnect replays); durable cleanup
  ledger + cross-process sweep (`docs/lark-typing-cleanup.md`). **No tool-call display** in IM.
- **Long outputs**: no explicit splitting found in the lark package (relies on card/text limits; failures surface as errors).
- **Files/images**: inbound handled (resource download streamed with size/time bounds, `media_ingest.go`,
  `http_client.go:766-834`, media bound async to the chat message). **No outbound file/image upload** implemented
  (no `im/v1/images|files` calls), despite `CapAttachment` being declared.

## 5. Interactivity

- **Essentially none inside Feishu.** No approval prompts, buttons, card callbacks, or ask-user flows (no card-action
  handler). Agents run unattended in the daemon; the IM is request/response.
- Only interactive card: **binding prompt** for an unbound sender — a card/link with a 15-min single-use token
  (`binding_token.go:65-117`, `outcome_replier.go:19-56`) pointing to `apps/web/app/lark/bind/page.tsx` (user logs in to
  web, binds open_id ↔ account). Other canned outcomes (agent offline/archived, /new started, /issue usage) are text replies.
- **Interrupt/stop**: no IM command; cancel via web/CLI.

## 6. Security

- Per-installation scope: events routed by app_id → installation; revoked installation → drop (`router.go:~300`).
- **Identity**: every sender must be bound open_id→Multica user (`lark_user_binding` UNIQUE(installation, open_id));
  composite FK to `member(workspace_id,user_id)` ON DELETE CASCADE so a removed member's binding vanishes
  (`109_…up.sql`); re-verified at each message (`ErrSenderNotMember`). Then **invoke permission** per agent
  (`TaskService.MemberMayInvokeAgent`, `service/task.go:1854`) judged on the sender, not the installer, before anything is
  stored. Unbound/non-member/denied → audit row (routing+reason, **never message body**: `lark_inbound_audit`).
- No explicit tenant_key allow-list beyond the app being tenant-scoped; app_secret stored encrypted (secretbox,
  `installation.go`). Sandboxing: none at the bot; execution happens in the user's own daemon/worktrees.

## 7. Ops

- Config: DB-backed per-installation (app_id, encrypted secret, region/domain, bot ids); no env needed for the bot
  itself beyond the server's secret-box key. Router tunables: `RouterConfig` (reply/media timeouts, batch window).
- **Dedup**: two-phase claim `channel_inbound_message_dedup` PK (installation_id, message_id), `claim_token` fencing,
  mark processed vs release on failure so redelivery gets another chance (`router.go:303-340`, `migrations/113…`);
  24 h purge. Keyed per installation because multiple bots in one group each receive the same message_id.
- Retry/rate: token refresh-once; send errors classified (rate limit 230020 / 5xx / ambiguous not retried at chat level).
  Reconnect with exponential backoff + jitter under lease (`supervisor.go`). Router `Drain` on shutdown flushes debouncers.
- WS reply path is stateless HTTP so any replica can send (SELF_HOSTING.md:393).

## Ideas worth borrowing

1. **WS long connection, no webhook** — zero public URL / no verification+encryption setup; perfect for a local CLI extension.
   Use the official `@larksuiteoapi/node-sdk` WSClient (multica hand-rolled only because it's Go and wanted lease control).
2. **QR device-flow app registration** (`/oauth/v1/app/registration`, archetype PersonalAgent) → one-scan bot creation,
   returns app_id/secret + owner open_id (which doubles as the allow-list seed).
3. **Session key = chat_id, or chat_id:thread_id for topics**; one session per chat, topic isolation in groups.
4. **3 s debounce** to merge bursts into one agent turn; `/new`, `/clear` as engine-level first-line commands.
5. **Dedup by message_id with claim/mark/release** (persist so replays after reconnect don't re-run); drop reaction/typing for
   messages older than 2 min.
6. **"Typing" reaction** as cheap progress signal; text vs markdown-card auto-selection; reply-in-thread for topics;
   never chat-level-retry ambiguous sends.
7. Group rule: only respond when @-bot (match by union_id, not just open_id); fetch recent group/quoted/forwarded context
   on demand with a small timeout and graceful degrade.
8. Audit drops without bodies; per-sender (not per-installer) permission checks in shared group sessions.
9. Channel abstraction (`Channel` + capability bitmask) for later Slack etc.

## Things to avoid / gaps multica leaves open (our differentiators)

- No streaming/progress/tool visibility → pi can do card PATCH streaming (update_multi cards / CardKit streaming) and
  tool-call summaries; multica proves plain final-only felt better than noisy "system" cards, so keep cards subtle.
- No approvals / ask_user / stop / session list-switch in IM — pi has `ask_user`, abort, and session machinery; these need
  `card.action.trigger` (WS supports it) that multica never wired.
- No outbound file/image upload; no explicit long-text splitting — plan chunking (~30 KB text limit / card limits) and
  `im/v1/files|images` upload.
- Group chats share one transcript with installer as owner; consider per-user isolation or explicit shared-session notice.
- Heavy DB/lease/multi-replica machinery (leases, Postgres ledgers, Redis relay) is unnecessary for a single local process;
  a JSON file for dedup/bindings is enough. The 3 s ACK budget forces any slow work (enrichment) off the ACK path.
- Single event type means menu/reaction-driven UX untested; bot-menu and card events will need extra subscription config
  in the app (RFC flow may not pre-enable them).
