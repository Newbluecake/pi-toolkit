# web-hub 探索交接包（Explore · zai/glm-5.3 · 2026-09）

pi 源码坐标均相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`。

## Q1 扩展可订阅的实时事件（`pi.on()`，全模式）

- 联合类型 `core/extensions/types.d.ts:918`，`on()` 重载 `types.d.ts:940-996`。
- 消息流 `message_start/update/end`（`types.d.ts:651-663`，`message_update` 带累计 `message` + `assistantMessageEvent`；RPC 线上是 delta-only，json.md:87-89）。
- turn：`turn_start/turn_end`（`types.d.ts:644-650`）；`agent_start/agent_end/agent_before_settle/agent_settled`（`types.d.ts:592-609`）。
- 工具：`tool_execution_start/update/end`（`types.d.ts:665-680`）、`tool_call`、`tool_result`。
- 会话/compaction/model：`session_start{reason}`、`session_compact(_failed)`、`session_shutdown`、`session_tree`、`model_select`、`thinking_level_select`、`session_info_changed`（`types.d.ts:336-507`）。
- 输入：`input{text,source,streamingBehavior?}`（`types.d.ts:700-712`）。**`queue_update/entry_appended` 仅 RPC 线事件，不在扩展面**；队列状态靠 `ctx.hasPendingMessages()`/`getSteeringMessages()` 拉取（`agent-session.js:1580-1591`）。

## Q2 外部注入控制

- `pi.sendUserMessage(content,{deliverAs:"steer"|"followUp"})`：总是触发 turn；streaming 中按 deliverAs 排队（`types.d.ts:1055-1060`，`agent-session.js:1547-1573`）。
- `pi.sendMessage(customType,…,{triggerTurn,deliverAs:"steer"|"followUp"|"nextTurn"})`（`types.d.ts:1046-1048`）。
- abort：`ctx.abort()`（ExtensionContext，`types.d.ts:243`）；`clearQueue` 只在 RPC 命令面。
- 切/新会话：**仅 ExtensionCommandContext**（`newSession/fork/navigateTree/switchSession/reload`，`types.d.ts:266-297`；lifecycle 内调用会死锁，extensions.md:160-163）。→ 网页触发需走「注入命令」路线（参考 `src/reload/` 的 followUp `/agent reload fire` 手法）。

## Q3 TUI 下代答其他扩展的 ctx.ui.* —— **不能（无官方契约）**

- UI 上下文由 runner 持有、全扩展共享：`runner.js:314 setUIContext`，`get ui()` 返回 `runner.uiContext`（`runner.js:553-557`）；`setUIContext` 不在导出面。
- 唯一信号：`ui_prompt_start/end {kind,title?}`（`types.d.ts:611-625`，`runner.js:318-359`），无 options、无返回通道 → 只能感知不能代答；`custom()` 连 title 都没有。
- RPC 模式：`rpc-mode.js:69-210 createExtensionUIContext()` 把 select/confirm/input/editor 转 `extension_ui_request`（stdout JSONL）+ stdin `extension_ui_response`（`rpc-mode.js:52-67`）；**所有扩展**的对话框天然桥接到宿主 → 无头进程免费通道。
- 降级建议：TUI 进程上他人对话框网页只显示「blocked on dialog(kind,title)」；自家 ask_user 做网页通道。monkey-patch `ctx.ui` 技术可行但无契约，不建议。

## Q4 仓库接入点

| 组件              | 坐标                                                                                                                                           | 复用                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| run-registry      | `src/service/run-registry.ts:30-51`                                                                                                            | subagent 树直接读 `stack.query.list()` 快照                                                |
| background-status | `src/service/background-status.ts:11-16`                                                                                                       | `Symbol.for` 跨激活 global 持有者 + identity-release 先例                                  |
| fleet widget      | `src/ui/fleet-widget.ts`（`:294,:362` 行模型）                                                                                                 | 网页树数据形状对齐                                                                         |
| ask-user          | `src/ask-user/index.ts:60-82`（TUI `ctx.ui.custom`；RPC `channel-handler.ts:55-60`），问答纯数据 `channel-handler.ts:15-24`，`answer-codec.ts` | 加网页通道，TUI/网页竞速先答先得                                                           |
| bash              | `src/bash/process.ts:378-392`（`detached` spawn 先例）                                                                                         | hub daemon 拉起参考                                                                        |
| src/rpc           | `src/rpc/protocol.ts:4-8`（进程内总线，非网络）                                                                                                | typebox 校验 + 版本字段模式可抄                                                            |
| index.ts          | `src/index.ts:111-174` HOST_KEY；pre-guard `:103-132`；post-guard `:152` 后；holder forwardRef `:525-533`                                      | 客户端挂 post-guard；连接本体放 `Symbol.for` 进程级 global，session_start 只重报会话元数据 |
| stack.ts          | `src/stack.ts:959-972`（每会话销毁重建）                                                                                                       | 仅放 per-session 数据源，不放连接                                                          |

## Q5 依赖现状

- src 内无 `node:net`/`createServer`/`ws`；child_process 仅 `src/bash/process.ts`、`src/hud/plugin-info.ts`。
- 运行时依赖只有 typebox（`package.json:62-63`）→ hub 用 `node:http`/`node:net` 内置模块；浏览器推送用 SSE（或自写极简 WS）避免新依赖。
- 进程内无头会话先例：`src/runtime/session-driver.ts:316-328`（SDK `createAgentSession`）；与 `pi --mode rpc` 子进程是两条路线，后者带 extension_ui 桥。

## Q6 `pi --mode rpc`

- 加载扩展（`rpc-mode.js:225-257`；extensions.md:180），`ctx.mode="rpc"`，`ctx.hasUI=true`（`runner.js:363-365`）。print/json 为 noOp UI。

## 已排除

- TUI 内替换 UI 上下文代答他人对话框（无 API）。
- 连接放 `buildSessionStack`（会随 /new、/resume 断连）。
- 引 `ws` npm 依赖（违反单运行时依赖）。
