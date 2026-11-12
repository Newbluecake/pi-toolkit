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

`src/feishu-notify/` — merged Feishu notification cards (passive triggers only: `@notify` keyword, `/watch` and `/feishu-test`); completion-class cards are background-idle gated — suppressed (never deferred) while subagents/background bash are still running, since a stopped main session with busy background is not task end. On session start an unconfigured webhook clears the notification status, including a previous session's status; `/feishu-test` still reports configuration errors.

### #70 统一通知设置与敏感面

- `feishuNotify` 从 `{enabled}` 扩展为 `enabled` + `core.Config` 的全部十二字段；
  `settings.ts` 的白名单 parser **只保存有效显式覆盖，不预填默认**，从而不掩盖旧配置。
- 唯一解析器 `src/feishu-notify/config.ts::resolveNotifyConfig` 被发送端和
  `web-hub/agent/feishu-admin.ts` 共存诊断共同使用：逐字段 **统一有效值 → 旧文件有效值 →
  两个既有环境变量 → core 默认**。`parseConfig` 仍是最终默认/工具名映射点。
  `enabled` 仅统一设置可控。secure/locked 冻结 verdict 优先于任何注入/旧文件/env，
  直接返回 disabled 且不做旧文件 I/O；直接调用通知注册函数也有此门禁。
- 缺省/null/错误类型/非有限数值不占优先级；false、0、负数、空串、空数组是显式有效值。
  空 URL 阻断回退并停止发送，空 secret 阻断回退并关闭签名。数组仅接受 string[]，复制后再映射工具名。
- `FEISHU_NOTIFY_CONFIG_PATH` 仅选择旧文件回退；空串不读文件，未设保持
  `~/.pi/agent/feishu-notify.json`，非空原样传 fs（相对 cwd，不展开 `~`）。
  统一文件照常跟随 agentDir/继承。解析读取均不写盘，不自动迁移/删除旧文件。
- 暴露路径审计：凭据 `webhookUrl` / `secret` **JSON-only**，不注册 SettingSpec，故普通 TUI 行、
  文本 list、补全和 set 回执均无凭据值；只有七个安全 Sec/boolean 叶加入 spec（unset=继承，reset 移除覆盖）。
  数组和两个旧 `*Ms` 叶也 JSON-only，不进统一时间迁移表。
  `AgentSettings` 保存凭据供解析，不能整体序列化成状态/日志；现有设置展示按 spec 白名单，
  hub 诊断只返回布尔投影，无 wire 字段变化。
- 错误审计：旧文件 JSON parse/IO 原文静默；统一 loader parse 告警与 persist 读/parse 错误改固定文案，
  因 Node JSON 异常会引用凭据片段；`sendToFeishu` 不回显响应正文/异常（可能含 URL、secret 或签名），
  只保留 HTTP 状态/固定失败文案，因此 UI 和 notify 日志消费者不拿到原始错误。
  本地 JSON 仍为明文，应保护权限/备份；不声称环境变量或同 UID 进程内存得到加密保护。
- 门禁：`tests/feishu-notify/{config,extension,core}.test.ts`、
  `tests/config/feishu-notify-settings.test.ts`（真实 settings flock，tier2）、spec pin/corpus
  仅登记本包七个新增键（不重录冻结件）、`tests/web-hub/agent/feishu-admin.test.ts`、
  web-hub pi-free closure 仅补精确零运行时依赖 parser（hub allowlist 不扩容）。
  完整用户字段表与兼容语义见 [通知配置指南](../ask-user-feishu-merge/feishu-notify.md)。

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

### Web tool diagnostic boundary (#84)

Search/fetch progress names the provider without echoing the query or URL. Public failures use a
fixed allowlist: structured HTTP 401/403 → auth, 402/429 → quota, 408/425/5xx → transient,
others → unknown; only valid structured HTTP status is exposed. Exception text, response bodies,
URLs and queries do not enter failure/progress messages, and no reset time is inferred. Internal
retry/failover classification remains unchanged; successful provider data remains unchanged and
may naturally contain source content. `tests/web-tools/{resilience,tool}.test.ts` cover these
boundaries; offline tests do not certify a live provider or deployment.
