# web-hub 架构设计（arch v1，2026-09）

> 输入：`web-hub-requirements.md`（D1/D2/D3 已拍板，Q1–Q5 待定）、`explore.md`（能力核实交接包，坐标不再重复）。
> pi 源码坐标均相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`（0.87.1）。
> 本文对 Q1–Q5 给出结论；标 **〔需核实〕** 的点附核实方法，集中在 §12。

---

## 1. 背景与目标

浏览器单一 URL 渲染并控制本机多个 pi 进程：已开的 TUI 进程（接管）与网页新建的无头 `pi --mode rpc` 进程，同一注册协议。
硬约束：零 hang（所有等待都有 deadline，hub 不可达时 pi 静默降级）；`/reload` 同进程重激活不留幽灵节点；子会话 inert；print 模式所有句柄 `unref()`；
运行时依赖只有 `@sinclair/typebox`；pi 经 jiti 直接加载 TS 源（无构建步骤）；Node ≥ 22；runtime 标识沿用 `pi-subagent` 前缀。

非目标（v1）：远程（非 loopback）访问、多用户、hub 侧持久化第二份历史、TUI 模式下代答**其他扩展**的对话框（见 §6.2）。

## 2. 现状摘要（接入点）

| 现有模块                                                                                          | 用途                                                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` HOST_KEY 守卫（`:111-174`），post-guard 区                                         | agent-client 挂 post-guard（子会话 inert）                                                                      |
| `src/service/background-status.ts`                                                                | `Symbol.for` 进程级 global + identity-release 先例 → 连接持有者照抄                                             |
| `src/stack.ts` `buildSessionStack`                                                                | 每会话重建；只经 holder 取 per-session 数据源（fleet），**不放连接**                                            |
| `src/service/query-service.ts` `steer()/stop()`                                                   | 网页 steer / abort subagent                                                                                     |
| `src/ui/fleet-widget.ts` 行模型                                                                   | 网页 subagent 树数据形状对齐                                                                                    |
| `src/ask-user/index.ts`（TUI `ctx.ui.custom`；RPC `channel-handler.ts` `ASK_USER_MARKER` select） | 加网页竞速通道；RPC 模式 hub 直接解码 marker                                                                    |
| `src/reload/index.ts`                                                                             | `sendUserMessage("/cmd", {deliverAs:"followUp", expandPromptTemplates:true})` 注入命令拿 command context 的先例 |
| `src/bash/process.ts`                                                                             | detached spawn / 进程组 / 升级 kill 范式                                                                        |
| `src/rpc/protocol.ts`                                                                             | typebox 校验 + 版本字段的消息定义风格                                                                           |
| `src/hud/plugin-info.ts`                                                                          | 读包版本 / commit，用作握手 `pluginVersion`/`buildId`                                                           |

pi 侧关键事实（explore §Q1–Q6 + 本次补核）：

- 扩展事件面有 message/turn/agent/tool/session/model/input/`ui_prompt_start|end{kind,title?}`；**无 `queue_update`**（队列只能拉 `ctx.hasPendingMessages()`）。
- `message_update` 扩展事件带**累计** `message`；线上须自行转 delta-only。
- 扩展 `message_end` 在 `appendMessage` **之前**发出（`core/agent-session.js:579-595`：先 `await _emitExtensionEvent`，后持久化）→ 影响 §7 去重边界。
- TUI 回车在 streaming 中 = `steer`，Alt+Enter = `followUp`（`modes/interactive/interactive-mode.js:2620/3546`）。
- `newSession/switchSession` 仅 `ExtensionCommandContext`；lifecycle 内调用会死锁。
- SessionManager 首条 assistant 消息前可能未落盘（`core/session-manager.js:638-715` `flushed` 标志）。

## 3. 总体设计

### 3.1 组件图

```
┌──────── pi 进程 A（TUI）────────┐   ┌──── pi 进程 B（hub spawn 的 rpc）────┐
│ pi-toolkit activate()           │   │ pi-toolkit activate()                │
│  post-guard: wireWebHub()       │   │  post-guard: wireWebHub()            │
│   ├ binding(per activate)       │   │   binding  (同左, headless=true)     │
│   │  event-tap / cmd / dialogs  │   │                                      │
│   └ attach ─▶ HubConnection     │   │   HubConnection                      │
│      (Symbol.for 进程级 global) │   │                                      │
└───────────┬─────────────────────┘   └──────┬──────────────▲───────────────┘
            │ unix socket NDJSON             │ unix socket   │ stdin/stdout JSONL
            │ (注册/事件/命令/对话框)          │ (同一协议)     │ (仅 extension_ui + 生命周期)
            ▼                                ▼               │
┌──────────────────────── hub daemon（detached node 进程）───┴───────────────┐
│ singleton(lock+listen+fence) · agent-server · registry(lease/reaper)       │
│ headless-supervisor(spawn/drain/kill) · history(jsonl 分支读取)             │
│ http: 静态资源 + REST 命令 + SSE 推送 · auth(token→cookie) · idle-exit     │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ http://127.0.0.1:<port>  (SSE ↓ / POST ↑)
                                ▼
                     浏览器前端（无构建 ES modules，hub 从包目录直出）
```

依赖方向：`web-hub/agent → web-hub/protocol ← web-hub/hub`；`web/`（浏览器）只经 HTTP 契约耦合 hub。
**hub 与 protocol 不得 import 任何 pi 包**（pi 的 peer 别名只存在于 pi 进程内，hub 是裸 node 进程）；只允许 `node:*` + typebox。

### 3.2 pi 侧 agent-client（挂载与生命周期）

- **注册区**：post-guard（HOST_KEY 之后），`settings.webHub.enabled` 门控；子会话天然不注册，subagent 由主进程 `fleet` 帧上报。
- **两层对象**：
  | 层                        | 存放                                                              | 生命周期                                                                                        | 内容                                                                                                   |
  | ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | `AgentIdentity`（纯数据） | `globalThis[Symbol.for("pi-subagent:web-hub:agent-id")]`          | 进程级，首次 activate 创建后只读                                                                | `{pid, nonce}`（进程身份，跨一切重激活不变）                                                           |
  | `HubConnection`           | `globalThis[Symbol.for("pi-subagent:web-hub")]`，identity-checked | **模块实例级**：每次 activate（=每次 `/new` `/resume` `/fork` `/reload`，见下）新建并替换旧实例 | socket、`epoch`（=模块实例 nonce）、`seq`（每连接从 1 起）、重连状态机、写路径、状态槽、pending 命令表 |
  | `Binding`                 | `wireWebHub` 闭包                                                 | 每次 activate；`session_start` attach，`session_shutdown` detach                                | `pi.on` 事件 tap、命令处理器、最新 `ctx`、fleet port、ask_user 远程端口                                |
- **复用判据（评审修订 + spike 更正）**：`implVersion = buildId + "#" + MODULE_INSTANCE`（`MODULE_INSTANCE` 为模块作用域 `const`，每次模块求值新生成）。**实测（`spike-results.md` K4）**：`/new` `/resume` `/fork` **不**重求值模块（inst 不变，仅 activate 重跑），只有 `/reload` 重求值；globalThis 全程存活。读码解释：pi 进程级 `extensionCache`（`core/extensions/loader.js:85-100`）按路径缓存已加载模块，会话替换时新建的 ResourceLoader `loaded=false` 不清缓存；`/reload` 走 `reload()` 且 `loaded=true` ⇒ `clearExtensionCache()`（`core/resource-loader.js:263-267`）；另 `useExtensionCacheCwd` 在**cwd 变化**时也清缓存 ⇒ 跨 cwd 的 `/resume`/`/fork` 同样会重求值。`-e` 与已安装包都经 `loadExtensionsCached(extensionPaths,…)`（`resource-loader.js:404-412`）同一缓存，行为应一致，但本机只实测了 `-e`，故设计对两条路径都成立：
  - **路径 1（同模块实例：/new、同 cwd 的 /resume /fork）**：global 中连接 implVersion 相同 ⇒ 直接复用 socket，不重连不重握手；`session_shutdown` 发 `session_detached`，`session_start` 发新 `session` 帧（新 sessionFile / leafId），hub 对订阅者推 `session` + `gap` 触发按新会话文件重新快照。
  - **路径 2（模块重求值：/reload、跨 cwd 的 /resume /fork）**：implVersion 不同 ⇒ 旧实例发 `bye{reason:"handover"}` 并关闭，新实例用**同一 `agentId`**（进程级纯数据 global）重连。
  - 注：AGENTS.md「/reload 不清 Node 模块缓存」指 Node 自身的 ESM/CJS 缓存（`node_modules` 依赖如 typebox 仍命中）；扩展模块由 pi 自己的 `extensionCache` + jiti `moduleCache:false` 管理，`/reload` 时重新求值——两层缓存不是一回事。
  - activate 次数可能多于 session_start（实测 `/resume` 时 act 2→4），连接只在 `session_start` 取得，未配对的 activate 不产生连接。
  - 路径 2 的不闪断由 hub 保证：同 `agentId` 在 **10s 认领窗口**内重连（`handover` 或无 bye 断开）⇒ 静默改绑，**不推** `agent_down/agent_up`（agentKey 不变），仅在 `epoch` 变化时向订阅者推 `gap` 触发重新快照；窗口超时才推 `agent_stale`；`pidAlive(pid)=false` 立即 reap。
- detach 原因 `quit` → 发 `bye` 并关闭；其余原因 → 发 `session_detached`，起 **10s unref 宽限定时器**，期间无新 attach 则关闭（杜绝幽灵节点）。
- `session_start` 只重报会话元数据（`session` 帧），**不**重连。
- 所有 socket / 定时器 `unref()`；事件 handler 内只做同步入队，绝不 await 网络。

### 3.3 hub daemon（Q4 结论）

| 项                | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态              | 随包 TS 源 `src/web-hub/hub/main.ts`，由 agent 以 `spawn(process.execPath, [<pi 自带 jiti>/lib/jiti-cli.mjs, main.ts], {detached:true, stdio:"ignore"}).unref()` 拉起。不做 pi 子命令（pi 无扩展子命令入口）。jiti 路径：从 `process.argv[1]`（pi cli）向上找 `@earendil-works/pi-coding-agent/package.json`，`createRequire` 解析 `jiti/package.json`；可被 `webHub.nodeLoader` 覆盖。解析失败 ⇒ 不拉起，状态 `hub✗loader`。〔需核实 K1〕                                                                                                                           |
| 状态目录          | `~/.pi/agent/web-hub/`（0700）：`hub.json`（pid/nonce/version/buildId/proto/socket/port/startedAt）、`token`（0600）、`hub.log`（1 MiB 轮转 1 份）、`start.lock`                                                                                                                                                                                                                                                                                                                                                                                                     |
| socket            | `<stateDir>/hub.sock`（0600）；路径 > 100 字节时回落 `$XDG_RUNTIME_DIR/pi-webhub.sock`，再回落 `/tmp/pi-webhub-<uid>/hub.sock`（目录 0700，校验 owner）                                                                                                                                                                                                                                                                                                                                                                                                              |
| 去重（单例）      | ①`open(start.lock,"wx")` 取启动锁（内容 pid+ts；持有者死或 >10s 视为陈旧，unlink 后重试 1 次）②`listen(sock)`；`EADDRINUSE` ⇒ 以 500ms deadline 连接探测 hello：活 ⇒ 退出(0)；拒连 ⇒ unlink 后再 listen 一次，仍失败 ⇒ 退出 ③写 `hub.json`，释放启动锁。**真机验收后补强（2026-09）**：Linux 上 hub 整个生命周期另持有一个 abstract-namespace socket 守卫（进程死亡即由内核回收，`rm` 删不掉），后来者先问守卫持有者 pid，活且同用户 ⇒ 直接 `exists` 退出，不动任何文件；探测只把 `ECONNREFUSED`/`ENOENT` 判为死（`EAGAIN` = backlog 满的活 hub）。非 Linux 只有 ①–③ |
| 自我隔离（fence） | 启动后 2s 首检，此后每 30s `stat(sock).ino` 与自身 listen 时记录的 inode 比对；不符（被别的 hub 抢占或 socket 文件被删）⇒ 优雅退出                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| pid 存活判定      | `src/web-hub/protocol/pid.ts`：Linux 读 `/proc/<pid>/stat` 状态位，`Z`/`X`（僵尸）视为死亡；读不到回落 `kill(pid,0)`。registry 快速 reap 与 agent 读 hub.json 共用                                                                                                                                                                                                                                                                                                                                                                                                   |
| 空闲自退出        | 无 agent 连接 且 无 SSE 客户端 且 无 headless 子进程 持续 `idleExitMinutes`（默认 10）⇒ 退出；30s 检查一次                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 版本升级替换      | 见 §4.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 拉起限流          | 每个 pi 进程每 30s 至多拉起一次；拉起后按 250ms→4s 退避重连，总 deadline 8s，超时进入常规重连退避                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### 3.4 浏览器前端（Q3 结论）

- **原生 ES modules + 手写 JS（JSDoc 注解）**，放 `src/web-hub/web/`（`index.html`、`app.js`、`render/*.js`、`style.css`），hub 从包目录静态直出，零构建、零打包。`.js` 不在 tsc `include` 的 allowJs 范围内，不影响 typecheck/build；prettier 照常格式化。
- 渲染安全：所有模型/工具输出一律 `textContent`；markdown 用自写**白名单**渲染器（代码块/行内码/粗斜体/列表/链接 `http(s)` only），禁止 `innerHTML` 拼接原文。
- 若后续复杂度上升，可 vendor 单文件 preact+htm（带 LICENSE，放 `web/vendor/`），不引 npm 依赖。v1 不做。

## 4. 协议

### 4.1 pi ↔ hub（unix socket）

- **分帧**：NDJSON，仅按 `\n` 切（去可选 `\r`），**不用 `readline`**（U+2028/2029）。单帧上限 4 MiB，超限 ⇒ 断开并记日志。
- **信封**：`{ "t": <type>, ... }`；需要应答的带 `rid`（请求 id）。typebox schema 定义于 `src/web-hub/protocol/messages.ts`，两端 `Value.Check`，未知 `t` 忽略（前向兼容）。
- **版本**：`PROTO = { major: 1, minor: 0 }`；major 不同 = 不兼容；minor 以 `caps: string[]` 协商。

**握手 / 心跳 / 租约**

| 步骤        | 帧                                                                                                                             | deadline / 行为                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 连接        | `net.connect`                                                                                                                  | 1s；ENOENT/ECONNREFUSED ⇒ （允许时）拉起 hub |
| agent → hub | `hello{proto, pluginVersion, buildId, agentId:{pid,nonce}, kind:"tui"\|"rpc", ticket?, launcher:[execPath, argv1], cwd, caps}` | —                                            |
| hub → agent | `hello_ack{hubVersion, buildId, proto, agentKey, pingMs:10000, leaseMs:30000}` / `hello_reject{code, message, retryAfterMs}`   | agent 等 ack 2s，超时断开退避                |
| 心跳        | 双向 `ping{ts}`/`pong{ts}`，间隔 10s                                                                                           | 任一方向 30s 未收到任何帧 ⇒ 该方断开         |
| 租约        | hub：30s 无帧 ⇒ agent 标 `stale`（网页置灰）；60s ⇒ reap（注销、断 socket、撤销其对话框）                                      | —                                            |
| 重连        | 指数退避 0.5s→30s 上限 + 20% 抖动；成功后重发 `hello` + `session`，hub 以 `agentId` 认领旧记录（agentKey 不变）                | —                                            |

**背压（评审修订：内存有界）**：

- 仅 `live` 态写 socket；`connecting/handshaking/backoff` 态**不入队**，只更新覆盖式**状态槽**（最新 `session`/`status`/`fleet`/`prompts` 各一份），`ev` 直接丢弃但 `seq` 照常递增并记 `gapFrom`；进入 `live` 后先发 `hello` 后的状态槽，再发 `gap{fromSeq}`。
- socket `close`/`error` ⇒ **立即清空**写缓冲与合并中的 delta（`seq` 不回退，保持单调）、记 `gapFrom`，转 backoff；重连后以 `gap` 让 hub 重新快照兜底。
- `live` 态软上限：`socket.writableLength + 合并缓冲 > 1 MiB` ⇒ 丢弃 droppable 帧（`ev` 中 delta/partial、tool update）并记 `gapFrom`，排空（`drain`）后发 `gap{fromSeq}`；控制面帧（hello/session/status/pong/snapshot_reply/cmd_result/dialog_*）不在软上限内丢。
- **硬上限**：总字节（含非 droppable）`> 4 MiB` ⇒ `socket.destroy()` + 清空 + 记 `gapFrom` + backoff。结合 2s hello_ack 与 30s 静默断开，hub 被 `kill -STOP`（内核仍 accept 但进程不读）时 agent 常驻内存 ≤ 4 MiB + 一帧。`message_update` delta 在 agent 侧 50ms 合并；`tool_execution_update` 250ms latest-wins；单个工具结果/partial 文本超 64 KiB 截断并标 `truncated:true`（全文以 jsonl 历史为准）。

**消息类型清单**

| 方向 | `t`                             | 关键字段                                                                                              | 说明                                                                                                                            |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| a→h  | `hello` / `bye{reason}`         | 见上                                                                                                  | `bye` 仅 `quit`                                                                                                                 |
| a→h  | `session`                       | `sessionId, sessionFile?, name?, cwd, reason, leafId, model{provider,id}?, thinkingLevel?, mode`      | `session_start` / 重连时发                                                                                                      |
| a→h  | `session_detached`              | `reason`                                                                                              | reload/切会话宽限期                                                                                                             |
| a→h  | `ev`                            | `seq, e`                                                                                              | e ∈ 白名单事件（§4.1.1），delta-only                                                                                            |
| a→h  | `status`                        | `busy, pending:boolean, contextUsage?, costUsd?`                                                      | turn/agent 边界 + 命令后拉取（弥补无 `queue_update`）                                                                           |
| a→h  | `fleet`                         | `runs: FleetRow[]`                                                                                    | 1Hz 节流、有变化才发；`FleetRow` 对齐 fleet-widget 行模型（runId,label,type,status,parentRunId,elapsedMs,costUsd,lastActivity） |
| a→h  | `snapshot_reply`                | `rid, seq, leafId, sessionFile?, recent: FinalMsg[], inflight?, dialogs: DialogOpen[], status, fleet` | §7                                                                                                                              |
| a→h  | `branch_reply`                  | `rid, entries[], truncated`                                                                           | 文件不可读时的回落（≤2 MiB，超则尾部）                                                                                          |
| a→h  | `dialog_open` / `dialog_closed` | §6                                                                                                    | 仅 TUI 模式发                                                                                                                   |
| a→h  | `cmd_result`                    | `rid, ok, code?, message?, data?`                                                                     |                                                                                                                                 |
| h→a  | `hello_ack` / `hello_reject`    | 见上                                                                                                  |                                                                                                                                 |
| h→a  | `snapshot_req` / `branch_req`   | `rid`                                                                                                 | deadline 5s                                                                                                                     |
| h→a  | `cmd`                           | `rid, op, args, deadlineMs`                                                                           | §5                                                                                                                              |
| h→a  | `dialog_answer`                 | `dialogId, answer, clientId`                                                                          | §6                                                                                                                              |
| h→a  | `superseded`                    | `nextVersion`                                                                                         | hub 即将被替换，agent 立即断开并按常规重连                                                                                      |
| 双向 | `ping` / `pong`                 | `ts`                                                                                                  |                                                                                                                                 |

#### 4.1.1 转发事件白名单

`agent_start/agent_end/agent_settled`、`turn_start/turn_end{turnIndex,messageEntryId,toolResultEntryIds}`、`message_start/message_end{message}`、`message_update{contentIndex,type,delta|content|toolCall}`（去累计 message）、`tool_execution_start/update/end`、`session_compact`（摘要 + firstKeptEntryId）/`session_compact_failed`、`model_select`、`thinking_level_select`、`session_info_changed`、`input{text,source,streamingBehavior?}`（TUI 键入也可见）、`ui_prompt_start/end{kind,title?}`。其余不转发。

### 4.2 hub ↔ 浏览器（HTTP，127.0.0.1）

选择 **SSE 下行 + JSON POST 上行**（零依赖、`EventSource` 自带重连与 `Last-Event-ID`）。

| 端点                                                                               | 鉴权        | 说明                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`、`GET /assets/*`                                                           | 无          | 静态资源，不含数据                                                                                                             |
| `GET /healthz`                                                                     | 无          | `{ok, version}`（不泄露 agent 信息）                                                                                           |
| `POST /api/login {token}`                                                          | token       | 常量时间比较；成功 `Set-Cookie: pwh_sid=<32B>; HttpOnly; SameSite=Strict; Path=/`，sid 内存表，12h 滑动过期；5 次失败/分钟限流 |
| `GET /api/events`（SSE）                                                           | cookie      | 帧 `id:<hubSeq>`；`Last-Event-ID` 在 hub 环形缓冲（每 agent 2000 条）内则补发，否则发 `resync`                                 |
| `POST /api/subscribe {agentKey}`                                                   | cookie+CSRF | 触发 §7 快照，结果经 SSE 推 `history`                                                                                          |
| `GET /api/history?agent=&before=<entryId>&limit=`                                  | cookie      | 分页上翻（默认尾部 400 条）                                                                                                    |
| `POST /api/cmd {agentKey, op, args}`                                               | cookie+CSRF | 同步等 `cmd_result`，deadline 10s，超时 504 `E_DEADLINE`                                                                       |
| `POST /api/dialog {agentKey, dialogId, answer}`                                    | cookie+CSRF | 先到先得，迟到 409 `E_DIALOG_CLOSED`                                                                                           |
| `POST /api/headless {cwd, model?, sessionFile?}` / `POST /api/headless/:key/close` | cookie+CSRF | §5.3                                                                                                                           |
| `GET /api/sessions?cwd=`                                                           | cookie      | 读 `~/.pi/agent/sessions/--<cwd>--/*.jsonl` 头与名称，供切会话列表（P3）                                                       |

SSE 下行帧 `event` 名：`hub`（版本/自身状态）、`agents`（全量）、`agent_up/agent_down/agent_stale`、`session`、`history`、`ev{agentKey,seq,e}`、`status`、`fleet`、`dialog_open/dialog_closed`、`gap`、`resync`、`ping`（15s）。客户端 45s 无帧 ⇒ 关闭重连。
每个 SSE 连接 `writableLength > 2 MiB` ⇒ 关闭该连接（慢消费者），客户端重连后重新快照。
一个标签页只开 **一条** SSE（多 agent 复用），规避 HTTP/1.1 每源 6 连接上限。

### 4.3 版本不符与 hub 替换

| 情况                                  | 处理                                                                                                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| major 不同                            | `hello_reject{code:"E_PROTO"}`；agent 状态 `hub✗proto`，10min 后再试；若 agent 版本更高 ⇒ 按下行「替换」                                                                                                                                       |
| agent `pluginVersion` > hub（semver） | hub 置 `supersedePending`；**静默期**（无 busy headless、无打开的对话框）到达即：SSE 推 `hub{restarting}`、给 agent 发 `superseded`、优雅关闭 headless、退出。首个重连的 agent 从**它的磁盘路径**拉起新 hub。限流：同一 hub 60s 内至多触发一次 |
| agent 版本 ≤ hub                      | 正常服务（minor/caps 降级），网页 agent 卡片标 `outdated`                                                                                                                                                                                      |

只向严格更高版本替换 ⇒ 不会乒乓。注：已运行的旧 TUI 进程拉起的是磁盘上的**当前**代码（jiti 现读源），跨安装位置（dev checkout vs 已安装）才会出现版本差。

## 5. 控制面

### 5.1 命令表（`cmd.op`）

| op                                            | pi 侧实现                                                                                                                 | 前置/语义                                                                                                                                                          | 错误码                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `prompt{text, deliver?:"steer"\|"followUp"}`  | idle ⇒ `pi.sendUserMessage(text)`；streaming ⇒ `sendUserMessage(text,{deliverAs: deliver ?? "steer"})`（与 TUI 回车一致） | `expandPromptTemplates:false`；网页以 `/` 开头的输入按普通文本发（显式「作为命令」勾选才开 `true`，且只能触发扩展命令）。回 `cmd_result` 后立即拉 `status.pending` | `E_STALE_CTX`                                   |
| `abort`                                       | `ctx.abort()`                                                                                                             | 幂等                                                                                                                                                               | `E_STALE_CTX`                                   |
| `steer_subagent{runId,text}`                  | `stack.query.steer()`                                                                                                     | 经 holder 取当前 stack                                                                                                                                             | `not_running/steer_timeout/steer_rejected` 透传 |
| `abort_subagent{runId}`                       | `stack.query.stop(runId,"user_stop")`                                                                                     |                                                                                                                                                                    |                                                 |
| `new_session` / `switch_session{sessionFile}` | 注入命令路线（§5.2）                                                                                                      | **必须 idle**，否则 `E_BUSY`（网页提示先 abort）                                                                                                                   | `E_BUSY/E_CANCELLED/E_DEADLINE`                 |
| `set_model{provider,id}`（P3）                | `pi.setModel`                                                                                                             |                                                                                                                                                                    |                                                 |

- 「最新 ctx」保存在 Binding；ctx 在会话替换后 `assertActive` 抛错 ⇒ 捕获转 `E_STALE_CTX`，网页等下一个 `session` 帧后重试。
- 所有命令在 agent 侧有独立 deadline（`deadlineMs`，默认 8s，比 hub 的 10s 短），超时回 `E_DEADLINE`，不悬挂 pending 表。
- 队列展示：扩展面无 `queue_update`，网页对自己提交的 steer/followUp 做**乐观列表**，在对应 `message_start{role:user}` 到达或 `status.pending=false` 时对账消除。

### 5.2 切会话：注入命令路线

1. hub → `cmd{op:"switch_session", rid}`；agent 校验 idle，生成一次性 `nonce`（TTL 10s）存入连接 pending 表。
2. `pi.sendUserMessage("/webhub __exec <nonce>", { deliverAs:"followUp", expandPromptTemplates:true })`（`expandPromptTemplates:true` 是必需的，见 `src/reload/index.ts` 头注）。
3. 隐藏子命令 `__exec` 取出 pending op，用 `ExtensionCommandContext.switchSession/newSession` 执行；参数只来自 pending 表，文本中不含路径（模型无法伪造，nonce 单次）。
4. 结果 → `cmd_result`；会话替换后新 activate 经 global 连接 attach，发新 `session` 帧。nonce 过期未执行 ⇒ `E_DEADLINE`。

〔需核实 K3〕注入命令在 idle 时是否同样立即分派、是否会在 TUI 历史里留下可见用户消息。

### 5.3 无头进程生命周期（Q5 结论）

| 阶段          | 行为                                                                                                                                                                                                                                                                                                             | deadline        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 创建          | `spawn(launcher[0], [launcher[1], "--mode","rpc", ...(sessionFile? ["--session", f]:[]), ...(model? ["--model", m]:[])], {cwd, stdio:"pipe", env:{…, PI_WEBHUB_TICKET, PI_WEBHUB_HEADLESS:"1"}})`；`launcher` 取自 hub 拉起者（env `PI_WEBHUB_LAUNCHER`）或最近 TUI agent 的 hello，可被 `webHub.piCommand` 覆盖 | —               |
| 注册          | 子进程内插件以 `ticket` 发 `hello`，hub 把 socket agent 与子进程记录绑定                                                                                                                                                                                                                                         | 20s 未注册 ⇒ 杀 |
| 运行          | hub **持续读** stdout（否则 pi 被背压卡住）；只处理 `extension_ui_request`（对话框/notify），其余会话事件丢弃（事件以 socket 通道为准）；stderr 保留 64 KiB 环形缓冲供诊断                                                                                                                                       | —               |
| 网页关闭      | **不**结束进程                                                                                                                                                                                                                                                                                                   | —               |
| 空闲回收      | `agent_settled` 且无 subagent 运行 且 无 SSE 订阅者 持续 `headlessIdleMinutes`（默认 30）⇒ 关闭                                                                                                                                                                                                                  | —               |
| 关闭          | 关 stdin（pi 有序退出）→ 5s → SIGTERM → 3s → SIGKILL                                                                                                                                                                                                                                                             | 共 8s           |
| hub 退出/崩溃 | 子进程 stdin EOF ⇒ 自行有序退出（headless 生命周期 ≤ hub）                                                                                                                                                                                                                                                       | —               |
| 上限          | `maxHeadless`（默认 4），超出 `E_LIMIT`                                                                                                                                                                                                                                                                          | —               |

无头进程内插件：`PI_WEBHUB_HEADLESS=1` ⇒ **永不拉起 hub**（防 hub 死后被子进程复活的回环）。

## 6. 对话框桥接（Q1 / Q2 结论）

### 6.1 能力矩阵

| 对话框来源                             | TUI 进程                                                                                                            | RPC 无头进程                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自家 `ask_user`                        | **双通道竞速**（TUI 组件 ∥ 网页表单）                                                                               | 走 `ctx.ui.select(ASK_USER_MARKER, [payload])` → `extension_ui_request`；hub 识别 marker 渲染结构化表单，回 `extension_ui_response{value: JSON answers}` |
| 其他扩展 `select/confirm/input/editor` | **不桥接**，网页显示只读 `blocked on dialog (kind, title)` 横幅（源自 `ui_prompt_start/end`），提示「请到终端作答」 | hub 作为 extension_ui 客户端，网页原生作答                                                                                                               |
| `custom()`                             | 同上（无 title，显示 `custom`）                                                                                     | RPC 下 `custom()` 返回 `undefined`，无对话框可答                                                                                                         |
| `notify/setStatus/setWidget`           | 不转发（v1）                                                                                                        | hub 转网页 toast/状态条（P2）                                                                                                                            |

### 6.2 为何 TUI 不代答其他扩展

UI 上下文由 runner 持有（`runner.setUIContext` 非导出面），唯一官方信号是 `ui_prompt_start/end{kind,title?}`，无 options、无返回通道。
补核发现 `runner.uiContext` 是可写普通对象、所有扩展共享（`core/extensions/runner.js:314-357,553-556`），monkey-patch 技术上可行，但：非契约、每次 rebind 生成新对象需重打补丁、`editor()` 无 `signal` 无法从外部撤销 TUI 侧、与其他改写 ui 的扩展顺序不可控。**v1 明确否决**，列为「pi 若提供官方 UI 代理钩子再做」。

### 6.3 ask_user 双通道（TUI）

- `wireAskUser(pi, { remote })` 新增可选 late-bound 端口：`remote(): AskUserRemotePort | undefined`（web-hub 未启用或未连接时返回 `undefined` ⇒ 行为与现状逐字节一致）。
- 流程：`dialogId = "ask:"+toolCallId` → `remote.open({dialogId, questions(proto 形状), allowCancel})` → 同时挂 TUI 组件；`Promise.race(TUI done, remote answer)`。
  - 网页先答：`component.cancel()` 关闭 TUI 组件（`done(null)` 被忽略），以网页答案返回；
  - TUI 先答/取消：`remote.close(dialogId, {by:"tui"})`，hub 广播 `dialog_closed` 撤销网页表单；
  - 工具 `signal` abort：两侧同时撤销，按现有 `AGENT_ABORTED_TEXT` 返回。
- 网页答案经 `isAskUserAnswers` + `protoAnswersToResult` 同一解码路径，保证两通道结果形状一致。

### 6.4 仲裁规则

| 规则              | 内容                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1 仲裁者         | **pi 进程（agent）是唯一仲裁者**（单线程事件循环，天然原子）；RPC 模式由 hub 作仲裁（它是唯一 extension_ui 客户端） |
| R2 先到先得       | 以到达仲裁者的**提交**为准，无锁、无抢占期（锁会引入 hang）；多个浏览器标签同样先到先得                             |
| R3 迟到           | 迟到答案 → `E_DIALOG_CLOSED`（409），网页提示「已在 <by> 作答」                                                     |
| R4 超时           | 对话框自带 `timeout` 时以 pi 侧为准，到期两侧同撤；hub 不另设超时                                                   |
| R5 失联           | hub 断连 / agent reap ⇒ 网页撤销该 agent 所有表单；TUI 侧不受影响                                                   |
| R6 输入提示（软） | 网页正在输入时可发 `dialog_typing`（仅展示「网页端正在作答」，不锁 TUI）；反向复用 `ask-user:activity`。P3，可不做  |
| R7 普通消息       | 双端同时发消息不仲裁，按到达 pi 的顺序进 steer/followUp 队列                                                        |

`dialog_open{dialogId, source:"ask_user", questions, allowCancel, openedAt}` / `dialog_closed{dialogId, by:"tui"|"web"|"timeout"|"abort"|"reaped"}`。

## 7. 历史回放与去重

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 浏览器 `POST /api/subscribe` → hub 开始缓冲该 agent 的 `ev`，发 `snapshot_req`                                                                                                                                                                                                                                                                                                                                                                                |
| 2    | agent **同一 tick** 读取 `leafId = sessionManager.getLeafId()`、当前 `seq`、`recent`（最近 64 条已转发 `message_end` 的完成消息，含其 seq）、`inflight`（当前未结束的 assistant 累计消息 + 进行中工具），回 `snapshot_reply`                                                                                                                                                                                                                                  |
| 3    | hub 读 `sessionFile`，从 `leafId` 沿 `parentId` 回溯得分支（getBranch 语义，不读废弃分支）；文件不存在或找不到 leaf（未落盘）⇒ `branch_req` 回落                                                                                                                                                                                                                                                                                                              |
| 4    | 拼接：以快照同 tick 的 `leafId` 为唯一对齐点（文件中该 leaf 之后的条目忽略）：`branch` → `recent` 经**多重集对账**后仍未落盘的补尾（覆盖「扩展 message_end 先于 appendMessage」的窗口）→ `inflight` → 缓冲中 `seq > snap.seq` 的 `ev`。**不得**用 `turn_end.messageEntryId` 判「文件已追平 leaf」：实测工具轮中它指向 assistant(toolCall) 条目，leaf 已是 toolResult；它只证明该条目已落盘。`session_compact` 的 compactionEntry.id 恒等于 leaf，可作硬对齐点 |
| 5    | 之后实时 `ev` 直通；`gap` 或 SSE `resync` ⇒ 重做 1–4                                                                                                                                                                                                                                                                                                                                                                                                          |

- **messageKey**：普通消息（user/assistant/toolResult/system）= `role + ":" + message.timestamp`（toolResult 追加 `toolCallId`）；custom 两型（`custom_message` 用 content、`custom` 用 data）= `custom:<customType>:<fnv1a(规范化载荷)>`——实测 jsonl 不落 `message.timestamp`。内容键非唯一，只能多重集对账。浏览器端非 custom 同键去重兜底，custom 以 seq 去重。
- **事件盲区（spike K7④）**：idle 时 `sendMessage(…,{triggerTurn:false})` 先落盘、再只发应用总线事件，**不经扩展 runner** ⇒ 扩展收不到 message_end。故回放不能纯事件驱动：agent 在 1Hz tick 检测 `getLeafId()` 变化并发 `status{leafId}`，hub 据此读会话文件尾部、对账后以 `append` 推送事件流未覆盖的条目。
- 大会话：首屏只给尾部 400 条，`/api/history` 上翻；compaction 条目渲染为分隔标记（与 TUI 一致展示全分支）。
- hub 不持久化任何历史；环形缓冲仅服务断线补发。

## 8. 零 hang 与故障矩阵

| 故障                           | 检测                                 | deadline                | 降级 / 恢复                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 未运行                     | connect ENOENT/ECONNREFUSED          | 1s                      | `autoStart` ⇒ 限流拉起 + 8s 重连窗；否则/失败 ⇒ 状态 `hub✗`，退避重连，pi 功能无影响                                                                                                                                      |
| hub 崩溃                       | socket close/error                   | 即时                    | agent 退避重连（可重拉起）；headless 随 stdin EOF 自退；浏览器 EventSource 自动重连（固定端口时透明，token 文件不变）                                                                                                     |
| hub 卡死（不读 socket）        | 30s 无 pong；写队列 > 1 MiB          | 30s                     | agent 丢流式帧 → 断开重连；hub 侧 fence/空闲逻辑独立                                                                                                                                                                      |
| pi 进程崩溃/SIGKILL            | socket close 或 30s 无帧             | 30s stale / 60s reap    | 注销、撤销对话框、网页卡片 `down`；headless 同时触发进程回收                                                                                                                                                              |
| pi 主循环忙（长同步计算）      | 心跳延迟                             | 30s                     | 租约内容忍；超期 reap，恢复后重连重认领                                                                                                                                                                                   |
| 浏览器断开                     | SSE close / 写失败                   | 即时                    | 丢弃连接；不影响 agent；重连按 `Last-Event-ID` 补发或 `resync`                                                                                                                                                            |
| 浏览器慢消费                   | writableLength > 2 MiB               | 即时                    | 关闭该 SSE，客户端重连重快照                                                                                                                                                                                              |
| 命令无响应                     | pending rid                          | agent 8s / hub 10s      | `E_DEADLINE`，pending 清除                                                                                                                                                                                                |
| 快照无响应                     | rid                                  | 5s                      | 网页显示「快照超时」并提供重试；实时流照常                                                                                                                                                                                |
| 版本不符                       | hello                                | 2s                      | §4.3                                                                                                                                                                                                                      |
| 重复 hub 竞争                  | 启动锁 + listen + 探测 + inode fence | 锁陈旧 10s；fence 30s   | 败者退出(0)；被抢占者优雅退出                                                                                                                                                                                             |
| 状态文件被外部删除（真机 #13） | fence 首检 2s（inode/ENOENT）        | 2s                      | 原 hub 自退；abstract 守护期间挡住后来者；已连接 agent 断线后按 `autoStart` 重拉起（每进程 30s 限流）⇒ 短暂无 hub、自愈                                                                                                   |
| hub 被 SIGSTOP 冻结            | 探测 connect 成功 / `EAGAIN` 判活    | 无上界（已知限制）      | 不自动接管；agent 侧 30s 标记 `web ✗` 并丢流式帧，需人工 `kill -CONT` 或 `kill`                                                                                                                                           |
| 无头进程启动失败/不注册        | exit 事件 / 20s                      | 20s                     | 杀进程，网页报 stderr 尾部                                                                                                                                                                                                |
| 无头进程拒绝退出               | 关 stdin 后                          | 8s                      | SIGTERM → SIGKILL                                                                                                                                                                                                         |
| `/reload` / 切会话             | session_shutdown                     | 10s 宽限 / 10s 认领窗口 | 同模块实例（/new、同 cwd /resume /fork）：直接复用连接，只换 `session` 帧；模块重求值（/reload、跨 cwd）：旧连接 `bye{handover}`，新连接同 agentId 重连，hub 窗口内静默改绑（不推 down/up）；无接手则超时关闭，无幽灵节点 |
| print 模式                     | `ctx.mode==="print"/"json"`          | —                       | 不 attach（不连 hub）；即便连接也全部 `unref()`                                                                                                                                                                           |

## 9. 安全

| 威胁                 | 措施                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 远程访问             | HTTP 只 `listen(port, "127.0.0.1")`；设置项不允许改绑定地址                                                                                                                                                   |
| DNS rebinding        | `Host` 必须 ∈ {`127.0.0.1:<port>`, `localhost:<port>`}，否则 421                                                                                                                                              |
| 凭据泄露             | token 32B base64url，`~/.pi/agent/web-hub/token` 以 `wx`+`0600` 创建；启动时校验 mode，宽于 0600 ⇒ 修正并写日志；URL 用 fragment（`/#t=`，不进服务端日志/Referer）；`/webhub token rotate` 轮换并作废全部 sid |
| CSRF                 | 变更类 POST 要求 `Content-Type: application/json` + 自定义头 `X-PWH: 1`（触发预检，hub 不应答 CORS ⇒ 跨源必败）+ `Origin` 若存在须同源 + cookie `SameSite=Strict`                                             |
| XSS                  | CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`，无内联脚本；渲染只用 `textContent` / 白名单 markdown                         |
| 点击劫持（诱导作答） | `frame-ancestors 'none'` + `X-Frame-Options: DENY`                                                                                                                                                            |
| 本机其他用户         | 状态目录 0700、socket 0600、`/tmp` 回落目录校验 owner=uid                                                                                                                                                     |
| 同用户进程           | 视为已完全可信（hub 等价远程 shell，文档明示）；headless `ticket` 一次性，防伪装绑定                                                                                                                          |
| 暴力猜 token         | `/api/login` 每分钟 5 次失败限流                                                                                                                                                                              |

浏览器端 token 存 `localStorage`（hub 重启后 sid 失效可静默重登）——取舍：XSS 下本就全失守，CSP 为主防线。

> **S1 LAN 更新（2026-09，S1-W3 LI）**：§1 的非目标「远程（非 loopback）访问」已被 S1 取代——`webHub.lan.enabled`
> （默认关）额外绑定 `0.0.0.0:<webHub.lan.port>`，走用户名/密码鉴权（不是本表的 token），host 白名单 +
> 可选受信任反向代理（`trustProxyFrom`/`externalOrigins`，代理终止 HTTPS）+ 每 IP/全局限流 + SQLite 会话。
> 上表仍是 P1（loopback + token）的威胁模型，两套鉴权面完全隔离（不同 cookie、不同会话存储）；LAN 的完整
> 威胁模型、决策与测试矩阵见 `docs/dev/web-hub/lan-plan.md` §1–§12（尤其 §1.1 的信任边界表）。

## 10. 关键决策

| #    | 决策                                                                                                | 备选                                          | 理由                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| K-1  | 独立 detached hub（D1）                                                                             | pi 进程间 leader election；各进程各自监听端口 | 见 §11 已排除                                                                                                                            |
| K-2  | `agentId` 进程级纯数据 + 连接按模块实例替换（identity-checked global）+ hub 10s 同 agentId 静默认领 | 放 stack / activate 闭包；按 buildId 复用连接 | 模块每次会话替换都重新求值，复用旧实例会跑旧代码；不闪断改由 hub 认领窗口保证；满足「无模块级可变状态」与「无幽灵节点」（§3.2 评审修订） |
| K-3  | 两类进程都走 socket 注册协议；RPC stdio 只承担 extension_ui + 生命周期                              | 无头进程全走 RPC stdio                        | 单一控制/事件代码路径（D2 要求同协议）；stdio 只做 socket 做不到的对话框代答                                                             |
| K-4  | SSE + POST                                                                                          | 自写 WebSocket；引 `ws`                       | 零依赖、EventSource 自带重连/Last-Event-ID；自写 WS 帧解析易错；`ws` 违反单运行时依赖。代价：每源 6 连接 ⇒ 每标签单流复用                |
| K-5  | hub 由 pi 自带 jiti 运行 TS 源                                                                      | 纯 `.mjs` hub；Node 原生 strip-types          | 协议 schema 两端共用且受 typecheck；原生 strip-types 不解析项目的 `.js`→`.ts` 后缀约定，且 22.0–22.17 需 flag                            |
| K-6  | 网页切会话走注入命令 + nonce                                                                        | 直接在 lifecycle 调 switchSession             | 后者官方声明会死锁；nonce 使参数不经消息文本                                                                                             |
| K-7  | 对话框先到先得、pi 仲裁、无锁                                                                       | 编辑锁 / 抢占期                               | 锁需要租约与释放，任一端失联即 hang；先到先得失败模式仅为「迟到被拒」                                                                    |
| K-8  | TUI 下不代答其他扩展，显示 blocked 横幅                                                             | monkey-patch `ctx.ui`                         | 非契约、editor 不可撤销、重绑定脆弱（§6.2）                                                                                              |
| K-9  | headless 生命周期 ≤ hub；网页关闭不杀；空闲 30min 回收                                              | 独立于 hub 常驻（FIFO/detached stdin）        | stdin EOF 即有序退出是零 hang 的天然兜底；常驻需额外重接管协议                                                                           |
| K-10 | 默认 `webHub.enabled=false`                                                                         | 默认开                                        | hub = 远程 shell，需用户显式开启                                                                                                         |

## 11. 已排除方案

| 方案                                                                          | 否决理由                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi 进程间 leader election（某个 pi 兼任 hub）                                 | leader 随用户关闭终端/`/reload`/崩溃而漂移 ⇒ 浏览器断连、无头子进程失去父进程；选主需要租约 + 围栏 + 状态迁移，复杂度高于独立 daemon；leader 的事件循环同时跑 agent，负载互相拖累，违背零 hang |
| 每个 pi 各自监听端口                                                          | 浏览器需要发现多个 URL/端口，无单一入口；跨进程无法统一对话框/会话列表；无头进程无人托管；每进程一份 token/端口，安全面成倍                                                                    |
| 引入 `ws`/`express` 等依赖                                                    | 违反「运行时依赖只有 typebox」                                                                                                                                                                 |
| hub 持久化历史（SQLite/自有日志）                                             | 需求明令不做第二份持久化；jsonl 已是事实源                                                                                                                                                     |
| 网页通过 pi RPC 新建 TUI 进程之外的「SDK 进程内会话」（`createAgentSession`） | 无 extension_ui 桥，与 D2「同一注册协议」不符                                                                                                                                                  |
| 前端构建产物（Vite/esbuild）                                                  | 违反无构建约束，git 安装不跑构建                                                                                                                                                               |
| monkey-patch `ctx.ui` 代答他人对话框                                          | §6.2                                                                                                                                                                                           |

## 12. 需核实清单

| #   | 事项                                                                                                                              | 核实方法                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K1  | pi 全局/本地安装下均能从 `process.argv[1]` 定位 pi 包并解析 `jiti/lib/jiti-cli.mjs`；jiti-cli 能以 `.js` 后缀 import 同目录 `.ts` | 写一个 10 行探针脚本在 npm 全局 / `pi install git:` 两种安装下 `node jiti-cli.mjs probe.ts`；grep `jiti/package.json` `bin` 字段；✅ 已实测 npm 全局 + `pi install git:` 两形态均通过（spike-results.md）          |
| K2  | jiti 运行的 hub 能解析 pi-toolkit 自身 `node_modules/@sinclair/typebox`                                                           | 同上探针 import typebox                                                                                                                                                                                            |
| K3  | `sendUserMessage("/webhub __exec …",{expandPromptTemplates:true})` idle 与 streaming 下均立即分派、是否在 TUI 转录中留痕          | 真机 tmux 验收（见 memory `live-acceptance-tmux.md`）；grep `agent-session.js` `_tryExecuteExtensionCommand`                                                                                                       |
| K4  | ✅ 已实测（spike-results.md）：仅 `/reload`（及跨 cwd 替换）重求值模块，`/new` `/resume` `/fork` 只重跑 activate；见 §3.2         | spike 仅确认 `session_shutdown → activate → session_start` 时序与 globalThis 存活                                                                                                                                  |
| K5  | `ctx.abort()` 对 compaction/retry 阶段的效果                                                                                      | grep `agent-session.js` `abort()`；真机                                                                                                                                                                            |
| K6  | `pi --mode rpc` 下 `--session <file>` 恢复既有会话、`--model` 语法                                                                | `pi --help`；真机                                                                                                                                                                                                  |
| K7  | 扩展 `message_end` 早于 `appendMessage` 在 custom 消息、compaction 路径上的一致性                                                 | 读 `agent-session.js:579-600` 及 compaction 路径；单测覆盖 §7 步骤 4；✅ 已实测：①成立；②`turn_end.messageEntryId` 工具轮≠leaf，不能作追平栅栏；③普通消息键对齐；④custom 无时间戳且 idle 直发不经扩展事件（见 §7） |
| K8  | `ui_prompt_start/end` 在 TUI 下对 `ask_user` 的 `custom()` 也触发（避免与 `dialog_open` 双重显示）                                | 真机；若触发，网页以 `dialog_open` 优先、按时间窗合并；✅ 已实测：触发且 `tool_execution_start{ask_user}` 先于 `ui_prompt_start`，但 `kind:"custom"` 非 ask_user 专属（/resume 选择器同型），P2 归因须叠加工具事件 |
| K9  | TUI 回车 streaming 默认 steer 是否受 settings（steeringMode）影响                                                                 | grep `interactive-mode.js:2600-2630`                                                                                                                                                                               |

## 13. 分期与文件域

### 13.1 分期

| 期              | 范围                                                                                                                                                                                        | 验收要点                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **P1 MVP 只读** | protocol、hub 单例/空闲退出/auth/SSE/静态、agent-client（连接/握手/心跳/事件 tap/快照）、历史回放、网页只读渲染（对话、工具、subagent 树、成本、`blocked on dialog` 横幅）、`/webhub status | open`                                                                            | 多 TUI 同时接入；kill -9 hub/pi 各一次零 hang；`/reload` 后无幽灵节点；print 模式 `pi -p` 不被拖住 |
| **P2 控制**     | `prompt/abort/steer_subagent/abort_subagent`、乐观队列、ask_user 双通道、版本替换、`/webhub stop                                                                                            | token rotate`                                                                    | TUI/网页同时作答 ask_user 仅一方生效；命令 deadline 覆盖                                           |
| **P3 完全接管** | 无头进程（spawn/注册/extension_ui 客户端/空闲回收）、切会话/新会话（注入命令）、会话列表、notify/status 转发、`set_model`                                                                   | 网页新建 → 作答他扩展对话框 → 关网页 → 30min 回收；hub 退出时 headless 8s 内全退 |

### 13.2 文件域（可并行拆包，括号内为所属期）

| 包                     | 文件                                                                                                                                                           | 依赖                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A protocol（P1，先行） | `src/web-hub/protocol/{messages,ndjson,paths,version}.ts`                                                                                                      | 仅 typebox/node       |
| B hub 核心（P1）       | `src/web-hub/hub/{main,singleton,agent-server,registry,history,idle,log}.ts`                                                                                   | A                     |
| C hub HTTP（P1）       | `src/web-hub/hub/{http,sse,auth,static}.ts`                                                                                                                    | A、B 的 registry 接口 |
| D agent-client（P1）   | `src/web-hub/agent/{index,connection,launcher,event-tap,snapshot,status}.ts`                                                                                   | A                     |
| E 前端（P1→P3）        | `src/web-hub/web/{index.html,app.js,style.css,render/*.js}`                                                                                                    | 仅 HTTP 契约          |
| F 控制面（P2/P3）      | `src/web-hub/agent/{commands,exec-command}.ts`、`src/web-hub/hub/commands.ts`                                                                                  | A、D                  |
| G ask_user 通道（P2）  | `src/ask-user/index.ts`（加 `remote` 端口）、`src/web-hub/agent/dialogs.ts`                                                                                    | A、D                  |
| H headless（P3）       | `src/web-hub/hub/{headless,rpc-stdio,extension-ui}.ts`                                                                                                         | A、B                  |
| I 装配/配置            | `src/config/settings.ts`（`webHub` 组 + parse）、`src/index.ts`（post-guard `wireWebHub`，传 fleet port 与 ask_user remote ref）、`src/commands/`（`/webhub`） | D、G                  |
| 测试                   | `tests/web-hub/{protocol,hub,agent,history,security}/…`、`tests/integration/web-hub-*.test.ts`（真 unix socket + 临时 HOME，必须 `sandboxHome()`）             | —                     |

包 A 定稿后 B/C/D/E 可并行；G、H 依赖 D/B 的接口但互不相交。

### 13.3 新增 settings（`~/.pi/agent/pi-subagent.json` → `webHub`）

| 键                           | 默认    | 说明                                            |
| ---------------------------- | ------- | ----------------------------------------------- |
| `webHub.enabled`             | `false` | 总开关（post-guard，主会话）                    |
| `webHub.autoStart`           | `true`  | hub 不在时自动拉起                              |
| `webHub.port`                | `7878`  | 占用时回落随机端口并写入 `hub.json`；`0` = 随机 |
| `webHub.idleExitMinutes`     | `10`    | hub 空闲自退出                                  |
| `webHub.headlessIdleMinutes` | `30`    | 无头进程空闲回收；`0` = 不回收                  |
| `webHub.maxHeadless`         | `4`     | 无头进程上限                                    |
| `webHub.remoteAskUser`       | `true`  | ask_user 网页通道（关闭 = 仅 TUI）              |
| `webHub.piCommand`           | `""`    | 覆盖无头进程启动命令（空 = 用 launcher）        |
| `webHub.nodeLoader`          | `""`    | 覆盖 hub 的 jiti-cli 路径（K1 失败时的逃生口）  |

hub 读取的是拉起者经 env 传入的有效配置快照（hub 不读 pi 设置文件，避免与迁移写入竞争）。

## 14. 实施要点与风险

- **不变量**：agent 侧任何 `pi.on` handler 内禁止 await socket；全部 socket/定时器 `unref()`；`HubConnection` 释放必须 identity-checked（同 `background-status.ts`）。
- **性能**：`message_update` 扩展事件带累计 message，严禁直接 `JSON.stringify(event)`（O(n²) 流量）；必须按 contentIndex 取 delta。
- **历史一致性**：§7 步骤 4 的 `recent` 补尾是必须的（持久化晚于扩展事件），单测构造「message_end 已转发、leaf 未前移」的时序。
- **协议测试**：NDJSON 解码器覆盖 U+2028/2029、半包、超长帧；状态机（重连/租约/替换）写表驱动单测，与项目 state-machine 矩阵测试风格一致。
- **hub 可单独测试**：hub 不 import pi，可在 vitest 中以临时目录直接起 `singleton` + `agent-server`；并发起 3 个 hub 验证仅 1 个存活。
- **风险**
  | 风险                             | 影响            | 缓解                                                          |
  | -------------------------------- | --------------- | ------------------------------------------------------------- |
  | K1 jiti 定位失败                 | hub 无法拉起    | `webHub.nodeLoader` 逃生口；状态行明确 `hub✗loader`           |
  | pi 0.88 改扩展事件/`ui_prompt_*` | 渲染缺失        | peer 锁 `<0.88`；`src/adapters/pi-compat.ts` 增加探测项       |
  | 注入命令在转录留痕               | 用户困惑        | K3 核实；若留痕则命令名语义化（`/webhub switch`）并在网页注明 |
  | 超大会话首屏                     | hub 读 jsonl 慢 | 逆向读取尾部 + 分页；读取在 hub 进程，不影响 pi               |
  | 多标签 > 5                       | SSE 占满连接    | 每标签单流；文档说明；后续可切 WS（传输层已隔离在 `sse.ts`）  |
  | 用户误开 hub 于共享机器          | 同机他人访问    | loopback + 0700/0600 + token；默认关闭                        |
