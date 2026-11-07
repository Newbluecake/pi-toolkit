# 合并插件总览 · 开发者要点

> 何时读：改动 `src/hud/`、`src/web-tools/`、`src/feishu-notify/`，或 `hud.*`/`webSearch.*`/`feishuNotify.*` 设置键，或判断某插件在 pre-guard/post-guard 哪一侧注册之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`merge-plan.md`、`../traffic-merge/README.md`

## 合并插件总览（原 What this is 第 4 段）

It also absorbs eight formerly-standalone plugins (see `docs/dev/plugin-merge/merge-plan.md` and
`docs/dev/traffic-merge/plan.md`), all settings-gated and all wired from the single `pi.extensions` entry (`src/index.ts`):
a HUD footer (`src/hud/`, `hud.enabled`, main-session TUI only), the `web_search`/`web_fetch` tools (`src/web-tools/`,
`webSearch.enabled`), Claude Code-style task tools (`src/todo/`, `todo.enabled`), the interactive
`ask_user` tool (`src/ask-user/`, `askUser.enabled`), Feishu notification cards
(`src/feishu-notify/`, `feishuNotify.enabled`), session-navigation enhancements
(`src/session-nav/`, `sessionNav.enabled`), cwd-keyed project memory (`src/memory/`,
`memory.enabled`), and provider traffic recording (`src/traffic/`, `traffic.enabled`, merged from the
standalone pi-traffic-record — default off ⇒ zero wiring/IO and `node:sqlite` never loads; the main
session wires at the very END of `activate()`, after cache-ttl so it records the final payload, while
child sessions wire recording hooks only, pre-guard; a one-way claim protocol yields to a
proven-active external pi-traffic-record still installed in settings; secure domains force it off on
both settings load paths; armed rewrite rules veto cache-ttl keepalive pings and stop pi-native cache
warming; the web viewer binds 127.0.0.1 by default — LAN needs `traffic.web.host="0.0.0.0"`).
web_search / todo / memory register **before**
the HOST_KEY guard so child sessions keep them; hud / feishu-notify / session-nav / ask_user are
post-guard (main-session only — a subagent runs in print mode, so ask_user could only ever return
its headless error there and is therefore not registered in child sessions at all); traffic
straddles the guard (child recording hooks pre-guard, host command/web wiring post-guard at the end
of `activate()`).

## src/feishu-notify/

`src/feishu-notify/` — merged Feishu notification cards (passive triggers only: `@notify` keyword, `/watch` and `/feishu-test`); completion-class cards are background-idle gated — suppressed (never deferred) while subagents/background bash are still running, since a stopped main session with busy background is not task end.

## src/hud/

`src/hud/` — merged pi-hud: full footer takeover (git/worktrees, token & cost stats incl.
live subagent cost, LLM timing/speed, own `toolkit v<ver>@<commit>[*] <commit time>` at the end of the cwd/git line with the model right-aligned on it — read once per activate by `plugin-info.ts`, git fields only when the package root is itself the git toplevel) + status key `pi-hud` + `/pi-hud-refresh` + settings-gated
periodic `git fetch` (`hud.autoFetchMinutes`, default 5, 0 = off — the ↑/↓ counts compare against
the local remote-tracking ref, so without fetch they never see remote commits pushed elsewhere). State lives
in a per-session `HudSession` (single `live` flag, all timers unref'd, all `pi.events`
subscriptions unsubscribed on session_shutdown — the bus survives /reload).

## src/web-tools/

`src/web-tools/` (renamed from `src/web-search/` when DeepSeek + web_fetch landed; the settings key
stays `webSearch.*`, the credentials file stays `~/.config/pi/web-search.env` — user-facing
identifiers never move) — two tools, both registered pre-guard by the single entry
`registerWebSearchTool(pi)` under `webSearch.enabled` (default on):

- `web_search` — Codex/SerpAPI/DeepSeek/Bocha/Tavily failover with retry policy; auto order
  `codex → serpapi → deepseek → bocha → tavily` (a provider participates only when its key is
  configured). DeepSeek is the official Search API (`POST https://api.deepseek.com/v1/tools/search`,
  Bearer `DEEPSEEK_API_KEY`); the model-facing snippet is the response's 600-800 char `summary`
  field (falling back to the 100-200 char UI `snippet`), `rerank_score` maps to `score`,
  `site_name` to `source`; `need_content` stays `false` (full content is web_fetch's job).
- `web_fetch` — DeepSeek Fetch API (`POST /v1/tools/fetch`, `{url}` ⇒ `{title, content}` where
  content is Markdown). http(s) URLs only; needs `DEEPSEEK_API_KEY` and fails fast (no request)
  without it; same resilience discipline as search (15s `withRequestTimeout`, 1+2 attempts with
  backoff on retryable errors, secrets redacted from every error path).

Credentials from env or `~/.config/pi/web-search.env`: `CODEX_SEARCH_API_KEY` +
`CODEX_SEARCH_BASE_URL`, `SERPAPI_API_KEY`, `DEEPSEEK_API_KEY`, `BOCHA_API_KEY`, `TAVILY_API_KEY`.
