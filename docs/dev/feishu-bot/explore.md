# Feishu bot — reusable pi-toolkit infrastructure map (explore, 2026-10-17)

Source: read-only Explore run (deepseek-v4-pro), condensed. Companion: `multica-research.md`.

## 1. `src/feishu-notify/` today — outbound only

- Passive notification cards (`@notify`/`#notify`, `/watch`, `/feishu-test`); no AI tool, **no inbound**
  (`src/feishu-notify/index.ts:1-28`).
- Auth = custom-bot **webhook** + optional HMAC secret (`core.ts:14-42`, `feishuSign` `core.ts:130`,
  `sendToFeishu` `core.ts:365-400`). No app_id/app_secret / tenant_access_token / event subscription anywhere.
- Config `~/.pi/agent/feishu-notify.json` or env `FEISHU_WEBHOOK_URL`/`FEISHU_WEBHOOK_SECRET` (`index.ts:51-85`).
- `buildCard` (`core.ts:250-330`) reusable for reply cards; 5 s timeout, 2 retries, no rate limiting.
- Completion cards gated on background idle (`index.ts:320-350`, `service/background-status.js`).

## 2. `src/web-hub/` — natural home for a bot

- Per-machine singleton daemon, never imports pi (`hub/main.ts`, `hub/hub.ts`, `hub/singleton.ts`).
- Sees **every** pi session: agents connect over a unix socket (`agent/connection.ts`), `hub/registry.ts:36-68`
  (`send` / `broadcast` / `request(agentKey, frame, deadlineMs)`); identity = agentKey + sessionId.
- Control plane `CmdOp` (`protocol/messages.ts:659-660`): prompt | abort | steer_subagent | abort_subagent |
  dialog_answer | dialog_cancel | command | recall; routed by `hub/commands.ts` → agent `agent/commands.ts`;
  cmdId idempotency (hub LRU 2048/10 min + `agent/ledger.ts`); `prompt` carries `expect.sessionId`;
  session switch rides `command` (`/webhub __exec resume`, `agent/resume-exec.ts`).
- ask_user dual-channel race (`src/ask-user/remote.ts` `createDialogRace`, `agent/dialogs.ts` `DialogBridge`):
  a Feishu channel = new winner tag + `dialogBridge.answer()` from the hub — arbitration already exists.
- Managed spawn (`hub/spawn/routes.ts`): fork `pi --mode rpc` in a dir, stop, relaunch/restore, history resume/fork.
- Streaming reaching the hub (`agent/event-tap.ts`, `FORWARDED_EVENTS` `protocol/messages.ts:613-633`): message
  text/thinking/toolcall deltas (50 ms coalesced), message_end, tool_execution__, compaction, model select, input,
  ui_prompt__; strings capped 64 KiB; `inflight-accumulator.ts` rebuilds the streaming message.
- Auth/principals: loopback token + LAN password sessions; per-principal rate limits (`hub/ratelimit.ts`,
  `hub/cmd-limit.ts`).

## 3. Multi-session

- Hub holds many agentKey→session records; UI keeps K subscriptions alive (`ui/src/logic/sessionKeepAlive.ts`).
- A bot only needs its own `chat → {agentKey, sessionId}` routing table + "active session per chat"; everything
  downstream already keys on agentKey/sessionId.

## 4. Reusable patterns

- Bounded HTTP: `src/quota/http.ts createFetchJson` (never throws, unref'd timeout, 2 attempts), web-search
  resilience helpers (`isRetryableError`, `backoffDelay`, `redactSecrets`).
- Secrets: `~/.config/pi/*.env` (web-search) or `~/.pi/agent/<feature>.json` (feishu-notify). No runtime deps.

## 5. Constraints (AGENTS.md)

Zero-hang (every network call bounded), unref'd timers, no module-scope mutable state, settings-gated default off
with zero wiring, hub never imports pi, child sessions inert (post-guard). Note: the package has **no runtime
dependencies** — using `@larksuiteoapi/node-sdk` would be the first; alternatively hand-roll the long-connection
client (multica does, in Go).

## Candidate integration points

1. Hub-side Feishu adapter (`src/web-hub/hub/feishu/`): WS long connection, `chat → agentKey` routing, calls the
   existing cmd router (prompt/abort/steer/command), cmdId idempotency, per-principal limits.
2. Third ask_user channel ("feishu") via `DialogRace` + `dialogBridge.answer()` / card button callbacks.
3. Outbound cards: reuse `buildCard`; app-credential client (tenant_access_token) on `createFetchJson`.
4. Session lifecycle via managed spawn / history resume; stream replies from the same `ev` frames the web UI uses.
5. Settings `feishuBot.enabled` (default off); app id/secret in `~/.pi/agent/feishu-bot.json`.
