# 日常工具模块

可单独开关的日常基础设施：任务工具、`ask_user`、`web_search`、HUD、飞书通知、会话导航、topic-switch、自动标题、延迟 `/reload`。除特别说明外，开关都在 `~/.pi/agent/pi-toolkit.json`（旧名 `pi-subagent.json` 保留为兼容链接；跟随 `PI_CODING_AGENT_DIR`），改动 `/reload` 生效。

## 任务工具（todo）

`todo.enabled` 默认 `true`。`TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskDelete`，加编辑器上方的任务 widget 与 `/tasklist` 面板（`/tasklist clear` 清空）。主会话与子会话均可用。

- 状态存在会话文件里（`claude-code-todo-state` 条目），fork / resume 无损恢复。
- **折叠与归档**：已完成任务从默认视图折叠；压缩时（`todo.archive.onCompact`，默认 `true`）和 `todo.archive.afterTurns`（默认 30）轮后自动归档。`TaskList` 传 `includeCompleted: true` 可列出全部（含归档）。
- **催办**（`todo.nudge.*`，默认开）：任务悬而未决时按 `graceTurns` 2 / `fallbackTurns` 20 / `cooldownTurns` 8 提醒模型更新状态。
- Web hub 详情页头有只读、可折叠的任务面板。

设计：[todo-archive](../dev/todo-archive/plan.md)、[todo-web](../dev/todo-web/plan.md)。

## `/task`

`/task <任务描述>` 启动一个后台 general-purpose subagent；主会话收到启动记录和完成通知。

## `ask_user`

`askUser.enabled` 默认 `true`。结构化多选澄清，一次最多 4 题，TUI / RPC 都支持；每道题都可单独跳过。

- 多问题缺 header 时从问题文本派生标签页标题（截断、撞车加后缀；显式重复 header 仍被拒绝；单问题不凭空补 header）。
- 仅主会话注册——子 agent 会话是 print 模式，注册了也只能返回 headless 错误。
- 后台任务完成时会在你空闲的间隙才中断提问（`askUser.backgroundInterrupt.*`，默认开）。
- 开着 Web hub 时 TUI 与网页竞速作答，见 [Web Hub](web-hub.md)。

## `web_search` / `web_fetch`

`webSearch.enabled` 默认 `true`，两个工具同开关注册，主会话与子会话均可用。凭证放环境变量或 `~/.config/pi/web-search.env`（建议 0600）：`CODEX_SEARCH_API_KEY` + `CODEX_SEARCH_BASE_URL`（可选 `CODEX_SEARCH_MODEL`、`CODEX_SEARCH_TLS_INSECURE`）、`SERPAPI_API_KEY`、`DEEPSEEK_API_KEY`、`BOCHA_API_KEY`、`TAVILY_API_KEY`，至少配一家；`PI_WEB_SEARCH_ENV_FILE` 可覆盖该路径。

- `web_search`：Codex / SerpAPI / DeepSeek / Bocha / Tavily 五供应商自动 failover（auto 顺序即此序，网络错误 / 超时 / 429 / 5xx 指数退避后切换；只派有 key 的供应商）。DeepSeek 结果给模型看的是官方响应里 600-800 字的 `summary` 字段（比 UI 用 snippet 信息量大）。
- `web_fetch`：抓单个 http(s) URL，经 DeepSeek Fetch API 返回标题 + Markdown 正文；需要 `DEEPSEEK_API_KEY`（缺 key 直接报错，不发请求）。

## HUD footer

`hud.enabled` 默认 `true`，仅主会话 TUI。接管 pi 底部 footer：pwd / git 分支与工作树、token 与费用统计（含 subagent 实时费用）、上下文用量、模型与 thinking 档位、LLM 计时与速率、额度 / 负载状态，行尾显示 toolkit 版本与提交。`hud.autoFetchMinutes`（默认 5，`0` 关闭）周期性 `git fetch` 以刷新 ↑/↓ 计数；`/pi-hud-refresh` 手动 fetch 并刷新。`hud.enabled: false` 还原 pi 内置 footer。

## 飞书通知

`feishuNotify.enabled` 默认 `true`，仅主会话。被动触发，无模型可调用的面：

- `@notify` 关键词；`/watch` 标记本会话每次任务结束都通知；`/feishu-test` 发测试卡片。
- 结果 / 汇总 / 心跳 / 等待输入卡片。
- 完成类通知默认等后台 subagent 与后台 bash 全部空闲才发，忙时抑制不补发（统一 `feishuNotify.requireBackgroundIdle: false` 可关）。

配置在 `pi-toolkit.json` 顶层 `feishuNotify`；逐字段优先于旧 `~/.pi/agent/feishu-notify.json`，后者仍兼容保留，最后回退既有环境变量和默认值。凭据 JSON-only，不进入普通设置 UI；完整字段/安全与空值语义见 [通知配置指南](../dev/ask-user-feishu-merge/feishu-notify.md)。

## 会话导航

`sessionNav.enabled` 默认 `true`，仅主会话 TUI。

- `/resume-recent`：只列最近 48 小时的会话（`--all` 全量；裸输 `resume` 等效）。
- 推荐 Pi 内置 `/new` 开新会话；`/clear`（裸输 `clear` 等效）仍是兼容入口。裸 `exit` 直接退出。
- 会话列表标题清洗 skill 信封，并过滤 subagent 会话。

## topic-switch

`topicSwitch.enabled` 默认 `true`，仅主会话。你提交一个看起来和当前会话无关的新请求时，如果当前上下文很大且 prompt cache 已冷，会先拦下来，由便宜的判定模型判断相关性，并**建议**开一个干净的新会话（TUI / 网页都会弹确认）。

- 只在能证明"划算"时才问：缓存已冷（缓存仍热则不问）、预估成本超过 `topicSwitch.costThresholdUsd`（0.5）、判定置信度 ≥ `minConfidence`（0.7）；后台有 subagent / 后台 bash 在跑 运行中、过短或续写式输入也不拦。判定超时（`judgeTimeoutS`=6）、模型失败、无法证明冷缓存时一律放行，不拦。确认超时（`confirmTimeoutS`=30）算拒绝。
- 判定模型链 `topicSwitch.model`（逗号分隔或 JSON 数组）→ `title.model` → 当前会话模型，运行时依序 failover。
- 同意后在新会话里自动送出原请求；中途出问题可用 `/topic-switch last [--send]` 取回。`/topic-switch`（或 `status`）看开关、阈值、冷却和统计。
- 目前仅对 Anthropic 路由判断缓存冷热，其他路由视为未知（不拦）。

设计：[topic-switch](../dev/topic-switch/arch.md)、[plan](../dev/topic-switch/plan.md)。

## 自动标题

`title.enabled` 默认 `true`：用小模型（`title.model`，默认 `zai-coding-cn/glm-5.3-flash`）给会话生成并按需刷新标题（`refreshEveryInputs` 4、`refreshAfterMinutes` 15、最多 `maxRefreshes` 5 次）。主会话可用 `/title` 查看和管理标题；即使 `title.enabled=false` 命令仍注册，但自动生成关闭。

## 高级命令导航

- `/reflex`：只读自省功能的状态与诊断入口。`reflex.enabled` 默认关闭；仅在主会话启用且安全域为 plain 时注册。
- `/thread`：飞书群话题订阅管理入口。仅主会话在 `fabric.enabled` 和 `fabric.threads.enabled` 均有效开启时注册；secure / locked 域强制关闭。

## 延迟 `/reload`

`reload.defer` 默认 `true`：输入 `/reload` 时若有 subagent / workflow 在跑，会把 reload 挂起，等舰队全部结束后自动执行。`/agent reload now` 强制立即，`/agent reload cancel` 取消挂起。
