# fabric 第二期：C1 跨会话唤醒，实施方案（phase2 r1）

状态：r1.1 草案（r1 后按用户收窄范围修订：**第二期只做独立启动的主会话之间的通信**，子 agent 参与跨会话整体推迟到第三期，见 §12.3），等评审，等用户拍板（拍板项见 §13）。作者：planning 子代理，2026-10-21。
基线：`dev` @ `ea62d9dc`（第一期 S0…G 已全部合入：b08067b6 … f6cc67a0，G-report 2026-10-21）。
输入：`plan.md`（v3，§12 是 C1 的 v2 存档）、`W2..W6-report.md`、`G-report.md`、AGENTS.md 的 fabric / runtime / tools / service / web-hub 段落。
锚点约定：**以符号名为准**，`~L` 行号只是截至 `ea62d9dc` 的提示。本文档不修改 `plan.md`。

> 一句话：第一期把树内消息做成可唤醒、可 park、至多一次。第二期**只做独立启动的 pi 主会话之间**（终端 pi、web-hub 托管的 rpc 会话）的 root ↔ root 通信：在**同一台机器、同一个 web hub、同一个 uid** 下，一个已显式加入的主会话可以发现、给**另一个已显式加入的主会话**发消息，并按需唤醒它。被唤醒的主会话 run 必须**受监管**（RootWakeController）且**可撤销**，会话变更期间一律拒收（栅栏），中继由 hub 负责，发送方身份由 hub 盖章。**默认一切关闭，会话不显式加入就不可发现、不可达。** 子 agent 发往别的会话、别的会话发往某个子 run（`CanMessage:"session"`、`toRun` 授权、回复给子 run）全部推迟到第三期，本期只保留扩展点（§12.3）。

---

## 0. 目录

1. 复核方法
2. 存档 vs 现状差异表（核心交付）
3. 总体架构与数据流
4. S0b：设置与工具面（`CanMessage:"session"` 推迟到第三期）
5. 发现、限制与加入控制（用户补充，单列）
6. R1：RootWakeController
7. T1/T2：会话变更栅栏
8. X1–X5：跨会话投递（hub 中继、旧版本、managed rpc、hub 重启、provider payload）
9. NQ3：去重 LRU
10. 安全与不变量
11. 拆包、依赖、验收锚点、规模、车道
12. 风险、明确不做、第三期扩展点
13. 需用户拍板

---

## 1. 复核方法

只读核对了以下代码（**以代码为准，不采信文档**）：

- fabric：`src/core/message.ts`（`NodeRef`/`MessageKey`/`CanMessage`/`authorize`/`formatMessage`）、`src/fabric/router.ts`（`admit`/`WakePolicy`/`tryPark`/`admitSystemResult`）、`src/fabric/mailbox.ts`（`successorRoute`/`pump`/`waitingFor`）、`src/fabric/wake.ts`（`WakeService.preflight/gate/revive/subscribe`、`inboxDurability`、`formatWakeResult`）、`src/fabric/wake-level.ts`（`createCausalLevel`、`WAKE_LEVEL_CUSTOM_TYPE`）、`src/fabric/wake-input.ts`。
- 装配：`src/stack.ts` `buildFabric()`（~L499-700，`sendRootContext` 形状）、`src/service/runtime-adapter.ts` `message_agent` 注入（~L758 正常注入，~L890 consult-preserve 影子源）、`src/runtime/tool-scope.ts` `RESERVED_TOOL_NAMES`。
- 设置：`src/config/settings.ts` `FabricSettings`/`FabricWakeSettings`/`parseFabricWakeSettings`（~L940-1000、~L1114-1135、~L1639-1665），`src/config/agent-types.ts` `can_message` 解析（~L103-111）。
- pi 边界：`src/adapters/pi-compat.ts` `readBeforeAgentStartTrigger`（~L257-273），pi 1.2 文档 `extensions.md` §before_agent_start。
- 会话变更：`src/web-hub/agent/compaction-state.ts`（D13）、`src/web-hub/agent/resume-exec.ts`（exec claim / `switchInFlight`）、`src/topic-switch/wire.ts`（B1 mid-switch 标记）、`src/goal/hook.ts`。
- web hub：`src/web-hub/protocol/{messages.ts,version.ts}`（`HelloSchema`/`HelloAckSchema`/`SessionInfo`/`PROTO`/`protoCompatible`/各 caps 常量）、`src/web-hub/hub/agent-server.ts`（agent→hub 请求帧的分派位置）、`src/web-hub/hub/registry.ts`（`Rec`、`request()`）、`src/web-hub/agent/connection.ts`（hub→agent 帧分派）、`src/web-hub/agent/index.ts` `buildHubConfig`/`capsExtra`（~L1144-1250）、`src/web-hub/hub/audit.ts`（审计字段白名单）。
- 测试面：`tests/conformance/`（含 `fabric-wake.test.ts` C-P1…C-P5、`consult-preserve.test.ts` C1–C7、`wake-run-sysprompt.test.ts`）、`tests/fixtures/fabric-wake-off-golden.json`。

---

## 2. 存档 vs 现状差异表

图例：**推翻** = 存档假设与现状冲突，必须改设计；**满足** = 第一期已经自然提供，直接复用；**缺口** = 存档默认存在、现状不存在，要新建；**待定** = 存档没覆盖，需要拍板。

### 2.1 接口与类型

| #   | 存档（§12）假设                                                          | 现状（代码）                                                                                                                                                                                                                                    | 结论                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | §12.5「主会话工具在 activate 时按设置冻结」，即主会话也有发送工具        | **主会话根本没有 `message_agent`**：它只由 `runtime-adapter.ts` 注入子会话（~L758，条件 `deps.fabric && !readonlyDomain && !isExternal`）；`src/index.ts` 不注册它                                                                              | **缺口**。本期发送方只有主会话 ⇒ 主会话注册**新工具** `message_session`/`list_sessions`（§4.3），不把 `message_agent` 搬进主会话（那会改变主会话工具表，并引入树内语义）                                       |
| A2  | 跨会话消息复用树内的 `NodeRef`/`MessageKey`/`FabricRecord`               | `NodeRef = RunId \| "root" \| "system"`；`makeMessageKey`/`parseMessageKey` 用 `validNode()` 拒绝其他取值；`router.admit()` 要求发送方在树里处于 `running`，并按 `tree.relation()` 授权；`authorize()` 对 `relation === "unrelated"` 返回 false | **推翻**。远端地址进不了 `NodeRef`。跨会话**不经过** `FabricRouter`/`FabricMailbox`/outbox；新建 `src/fabric/xs/` 独立模块（自己的记录与配额），只复用格式化、`CausalLevel`、审计、`Verdict.effect` 语义（§3） |
| A3  | `CanMessage` 加 `"session"`（Q5）                                        | `CanMessage` 联合（`message.ts` ~L143）没有 `session`；`agent-types.ts` ~L109 用写死的数组过滤 frontmatter，未知值**静默丢弃**                                                                                                                  | **推迟到第三期**（用户收窄范围）。本期不改 `CanMessage`、不改 agent-types 解析；frontmatter 里提前写 `session` 会照旧被静默丢弃（行为不变）。扩展点见 §12.3                                                    |
| A4  | `Verdict.effect` 区分 none / unknown，NQ3 交给模型                       | 第一期 W4 已实现（`mailbox.ts` verdict `effect`），G-report §7 明确建议复用                                                                                                                                                                     | **满足**。跨会话发送结果沿用同一套词汇：`applied` / `none` / `unknown`                                                                                                                                         |
| A5  | §12.4「L5 与每小时唤醒预算」                                             | `CausalLevel`（`wake-level.ts`）：`levelOf`/`raise`/`hopAllowed`，root 持久化在 `subagent:wake-level`（只读 `getBranch()`），**只有** `wake-input.ts` 证实的人类输入会把 root 归零                                                              | **满足**。接收端把 root `raise` 到 `senderLevel + 1`；`hopAllowed(senderLevel)` 不通过 ⇒ 降级为只投递。wire 上要携带发送方 level（hub 不改写，只做范围校验）                                                   |
| A6  | §12.4 格式：JSON 编码元数据 + 接收方 nonce 边界                          | `formatWakeResult`/`formatInbox`（`wake.ts`）已实现：`JSON.stringify(...).slice(0,64)`、`newRunId()` 作 nonce、`<<<fab-` 先中和                                                                                                                 | **满足**。抽出共用 helper（`src/fabric/format-fence.ts`），三处都用                                                                                                                                            |
| A7  | §12.1 `before_agent_start{messageType:"custom", details.wakeToken}` 绑定 | `readBeforeAgentStartTrigger` 只返回 `{kind:"custom"}`，**不暴露 `message`**；pi 1.2 文档确认 custom 触发会带上起始 `message`（含 `customType`/`details`），pi 1.0/1.1 不为 `sendMessage` 起的 run 触发该事件                                   | **缺口 + 兼容性**。扩展探针为 `{kind:"custom"; customType?: string; details?: unknown}`（结构化读取，I14）。pi < 1.2 读不到 ⇒ 无法绑定 ⇒ 按 §6.6 降级为「只投递」（不起 turn），绝不起一个没有监管的 run       |

### 2.2 状态机与 reducer 输入

| #   | 存档                                                                   | 现状                                                                                                                                                             | 结论                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 没有提到 run 状态机                                                    | `state-machine.ts` 有 17 种输入（含第一期的 `wake_level`/`input_accepted`/`prompt_rejected`），矩阵和 property 测试从 `INPUT_KINDS` 生成                         | **第二期不新增 reducer 输入**。RootWakeController 监管的是**主会话 run**，主会话 run 不在 runner/reducer 里；本期子 run 不参与跨会话。矩阵和 property 测试不动                            |
| B2  | 「第二期起，显式 `wake:true` 唤醒空闲 root 也改走 RootWakeController」 | 第一期 `sendRootContext`：`wake === false` ⇒ `triggerTurn:false`；否则 legacy `deliverAs:"steer", triggerTurn:true`（省略和有效 `wake:true` 都走这里），不受监管 | **待定（行为变化）**。范围收窄后推荐：**Controller 只服务跨会话**，树内 root 投递（包括显式 `wake:true`）保持第一期 legacy，逐字节不变（golden）；树内改走 Controller 作为备选。见拍板 P7 |

### 2.3 设置键

| #   | 存档                                        | 现状                                                                                                                                       | 结论                                                                                                                   |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| C1  | `fabric.wake.crossSession.*`、`rootRunMaxS` | `FabricWakeSettings` 的注释写明「`rootRunMaxS` and `crossSession.*` belong to phase 2 and are intentionally NOT parsed」；解析器忽略未知键 | **满足（可加性）**：新键纯增量，旧配置文件不受影响                                                                     |
| C2  | `crossSession` 挂在 `wake` 下               | `fabric.wake.enabled` 默认 true（Q2）；跨会话「只投递」不需要 wake 也有意义                                                                | **改**：独立叶子 `fabric.crossSession.*`（§4.1）。`rootRunMaxS` 放在 `fabric.wake.rootRunMaxS`（它也管树内 root wake） |
| C3  | 「接收方默认 `wake`」（Q7）                 | —                                                                                                                                          | 保留 Q7，但前提是会话**已经加入**；加入本身默认关闭（§5.3）。见拍板 P2                                                 |
| C4  | 文档里的 fabric 默认值                      | 代码 `DEFAULT_SETTINGS.fabric`：见 §5.2 表。注意 **`maxPerRun` 实际是 progress 的配额**（`router.quota()`），不是每个 run 的总消息数       | 记录在 §5.2，第二期不修改它的语义                                                                                      |

### 2.4 持久化与 session entry

| #   | 存档                                  | 现状                                                                                                   | 结论                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 发送端 pending 授权「持久化，24h」    | 第一期有三级持久能力 `InboxDurability` 以及「只读 `getBranch()`」的先例（wake-level、prompt-sections） | **本期不需要**。回复授权（§12.5 存档）只是为了让对方能「回复曾给自己发过消息的 run」（Q8 后半句）；本期发送方只有主会话，而发送方必须已加入，它本身就是可寻址的，回复就是一次普通的 `message_session` 发给消息头里的 `from` 引用。授权存储随子 run 参与一起推迟到第三期（§12.3） |
| D2  | 没有提到会话成员资格的持久化          | —                                                                                                      | **缺口**。新 entry `subagent:xs-membership`（加入/退出/屏蔽列表，§5.3），`session_start` 时从 branch 读回                                                                                                                                                                        |
| D3  | 去重 LRU（R1 #11 裁掉，推迟到第二期） | 没有                                                                                                   | §9：只放内存、容量很小、靠 `expiresAt` 界定窗口                                                                                                                                                                                                                                  |

### 2.5 hub 协议与能力位

| #   | 存档（§12.3）                                                     | 现状                                                                                                                                                                                                                                                                    | 结论                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `xs.v1` / `xs.recv.v1` / `xs.send.v1` 三个 cap                    | caps 有两个面：agent 侧 `hello.caps`（`capsExtra()`，hello 时固定）和 hub 侧 `hello_ack.caps` 与 `HubInfo.caps`（必须**逐字节一致**，`caps-coexist` 测试锁定，经 `extraHubCaps` 同源展开）                                                                              | 简化为两个：hub `xs.v1`（仅当 `HubConfig.crossSession` 存在），agent `xs.v1`（构建具备收发能力，静态）。**是否加入是动态的**，不能放在 hello caps 里（加入是 live 开关），改走 `StatusInfo.xs`（§8.2）。`xs.send.v1` 删除                          |
| E2  | 新帧 `xs_resolve` / `xs_send`                                     | 已有 agent→hub 请求帧的先例：`fsb_req`/`lan_req`/`tfa_req`/`hub_ctl` 在 `agent-server.ts` 里**先于 registry 分派**、不进 bus、不进逐帧日志；hub→agent 请求/应答走 `registry.request(agentKey, frame, deadlineMs)`（cmd 先例）；未知帧类型 decode 为 `undefined`、被忽略 | **满足（照抄先例）**：agent→hub `xs_req{op:"list"\|"resolve"\|"send"}` / `xs_res`；hub→agent `xs_deliver` / agent→hub `xs_ack`（经 `registry.request`）。旧对端收到未知帧会忽略，但请求方会白等到超时，所以**必须按 cap 门控**，不能靠「忽略」降级 |
| E3  | 没有提到 PROTO 版本                                               | `PROTO = {1,2}`，`protoCompatible` 只比较 major                                                                                                                                                                                                                         | **不升 major**；推荐也不升 minor（只按 cap 门控，与 spawn/preview 等「不改帧形、只加能力」的先例一致；此处新增的是帧，但每一帧都在 cap 后面）。拍板 P9                                                                                             |
| E4  | `HubConfig.crossSession?: true`，non-live，需要 `/webhub restart` | 现有模式是「功能关闭 = 键缺失」（`avatar`/`privacy`/`proxy`/`feishuBot`），由 `buildHubConfig` 写入，`hub/main.ts` 复核                                                                                                                                                 | **满足（照抄）**。条件：`fabric.enabled ∧ fabric.crossSession.enabled ∧ webHub.enabled ∧ webHub.control !== false`                                                                                                                                 |
| E5  | 「hub 盖章发送方身份」                                            | `registry` 的 `Rec` 里有 `agentKey`、`agentId{pid,nonce}`、`kind` tui/rpc、`session: SessionInfo{sessionId,name,cwd,…}`、`phase`、`caps`                                                                                                                                | **满足**。hub 从**发送帧所在的 socket** 推导 `from={agentKey, agentId, sessionId, name, cwd}`，帧里自带的身份一律忽略                                                                                                                              |
| E6  | 「send 阶段只按 `agentId+sessionId` 精确匹配」                    | hub 重启后 `agentKey` 会重新分配；agent `/reload` 时 `agentId` 不变（进程级）；managed restore 是新进程 ⇒ 新 `agentId`，但用 `--session` 恢复时 sessionId 不变                                                                                                          | 保留思路，简化为：**投递地址 = `sessionId`**，send 时 hub 再校验「该 sessionId 恰好对应一个 live 且已加入的 agent」。不使用 `agentKey`；`agentId` 只用于审计和第三期的 run 级授权                                                                  |
| E7  | 认证与授权                                                        | agent socket 是 per-uid 状态目录下的 unix socket（`protocol/paths.ts`）；浏览器 / LAN / 飞书只能经 HTTP 与 `cmd`                                                                                                                                                        | **满足**：跨会话帧**只**存在于 agent socket 上，不开 HTTP 路由。LAN 用户只能间接触发（通过给某个会话发 prompt，让它去发消息），等价于他本来就能操作那个会话（U1 单用户裁决）。§10.3                                                                |

### 2.6 栅栏

| #   | 存档（§12.2）                                              | 现状                                                                                                                                                                                                                                               | 结论                                                                                                                                                                                       |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 压缩或分支摘要判定 = `!isIdle() && ctx.signal===undefined` | `compaction-state.ts` 的 D13 注释**明确否定**了这个启发式（会误判阈值压缩和分支摘要等路径），只跟踪 `session_before_compact{manual}` → `session_compact`/`_failed` 窗口；并且 pi 在清 controller 之前就发出 `session_compact`，必须延后一拍（D26） | **推翻**。栅栏改为**事件窗口跟踪**：`session_before_compact`（**任何 reason**）→ `session_compact`/`session_compact_failed`，外加 `setTimeout(0)` 延后释放（照搬 D26），30s 安全超时（§7） |
| F2  | 没有 `sessionGen`                                          | 全仓库没有 `sessionGen`；类似的机制只有：web resume 的 exec claim 与 `switchInFlight`（只在 web-hub 内部）、topic-switch 的 B1 mid-switch 标记（`Symbol.for` transfer map）、goal 的 hook 状态                                                     | **缺口**。新建 `src/fabric/xs/fence.ts`，三个现有源经**迟绑定端口**接入（不跨域 import）                                                                                                   |
| F3  | 「生效前校验 `sessionGen`；不做 hold，有界拒绝或重试」     | NQ3：跨会话不自动重试                                                                                                                                                                                                                              | 改为：**有界拒绝，不重试**。命中栅栏 ⇒ `effect:"none", reason:"fenced:<src>"` 回给发送方；goal 活动只把 wake 降级为只投递（存档原意）                                                      |

### 2.7 工具作用域与 consult-preserve

| #   | 存档                                     | 现状                                                                                                                                        | 结论                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `list_sessions` 的 reserved 名与影子工具 | `RESERVED_TOOL_NAMES`（`tool-scope.ts`）是 deny-by-default 名单；consult-preserve 的 `shadow-tools.ts` 为专家声明过的适配器自有工具生成影子 | **部分缺口**。`list_sessions`、`message_session` 加入 `RESERVED_TOOL_NAMES`（子会话里任何同名的 MCP 或迟注册工具都会被剥离）。本期**不注入子会话**，所以专家快照里不会出现它们 ⇒ 影子清单本期不改；consult 的 `"main"` 专家走只读工具表（AGENTS.md Q1 例外），也不受影响。第三期注入子会话时再补影子与 C9 |
| G2  | 与 consult 专家名表共存                  | 专家名的保留字只有 `"main"`（`consult/index.ts`），作用在 `Agent({experts})`；与工具名、会话名不在同一个命名空间                            | **无冲突**。会话名解析只在 `message_session`/`list_sessions` 内部发生，不碰 `experts`。约束：`message_session` 不接受 `"root"`/`"main"`/`r_…` 形式的地址，防止与树内地址混淆（§4.3）                                                                                                                      |

### 2.8 测试锚点

| #   | 存档                                                                      | 现状                                                                                                                                                                                                         | 结论                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | 「consult-preserve C9」                                                   | `consult-preserve.test.ts` 有 C1–C7（C8 跳过，等 Q5），**没有 C9**                                                                                                                                           | 本期只要求 C1–C7 不回归（工具不注入子会话）；C9 推迟到第三期                                                                                                                                                |
| H2  | 「hub 精确匹配 / 旧版本对端 / managed rpc / hub 重启 / provider payload」 | 有现成的 harness 可复用：`tests/integration/web-hub-headless.test.ts`（真实 hub 子进程 + `fixtures/fake-rpc-pi.mjs`）、`tests/conformance/rpc-spawn.test.ts`、`tests/integration/web-hub-feishu-bot.test.ts` | 新建 `tests/integration/fabric-xs-*.test.ts`（真实 hub 子进程 + 两个 fake agent socket）以及 `tests/conformance/fabric-xs.test.ts` C-X1…C-X6                                                                |
| H3  | 关闭状态 golden                                                           | `fabric-wake-off-golden.json`（W 系列一直未变，sha `7706698a…`）                                                                                                                                             | 第二期新增 `fabric-xs-off-golden.json`（先采集）：crossSession 关闭时，主会话工具表、`HubConfig`、hello caps、`StatusInfo` 都逐字节不变；**开启时子会话工具表也必须不变**（本期不注入）；旧 golden 不允许改 |

---

## 3. 总体架构与数据流

```
发送方会话 S（pi 进程 A）                         hub（per-uid 守护进程）                     接收方会话 R（pi 进程 B）
┌──────────────────────────┐   xs_req{send}   ┌────────────────────────────┐  xs_deliver  ┌──────────────────────────────┐
│ message_session 工具      │ ───────────────▶ │ xs/router: 盖章 from、     │ ───────────▶ │ xs/receiver:                  │
│  (仅主会话 root)            │                 │  精确匹配 sessionId、限额、 │              │  expiry→membership/policy→   │
│ xs/sender: 配额、resolve、   │ ◀─────────────── │  审计(无正文)、in-flight     │ ◀─────────── │  sessionId→fence→auth→level/ │
│  (from = 本会话，hub 盖章)   │   xs_res{effect}  │  超时 = effect:"unknown"    │   xs_ack     │  预算→dispatch(RootWake/steer/ │
└──────────────────────────┘                   └────────────────────────────┘              │  triggerTurn:false)          │
                                                                                            └──────────────────────────────┘
```

- **模块边界**：`src/fabric/xs/` 是 pi-free 核心（sender、receiver、fence、membership、format），只依赖注入端口；pi 侧装配在 `src/stack.ts`（每会话）和 `src/index.ts`（activate）；hub 侧在 `src/web-hub/hub/xs/`；agent 侧连接在 `src/web-hub/agent/xs.ts`。**不经过** `FabricRouter`/`FabricMailbox`/outbox（A2）。
- **为什么不复用 outbox**：跨会话不自动重试（NQ3），不 park（本期没有子 run 目标），接收方投递是同步的（`sendMessage` 一次调用），所以不需要 claim 协议和持久化的投递状态机。唯一需要持久化的是接收方（也是发送方）的会话级成员资格与屏蔽列表。
- **at-most-once**：发送方对每条消息只尝试一次。hub 转发后等 `xs_ack`（截止 `expiresAt`），收到 ack ⇒ `applied`；接收方确证没有生效（拒绝） ⇒ `none`；超时、断链或 hub 重启 ⇒ `unknown`。接收方用 `expiresAt` 加 LRU 拒绝重复投递（§9）。**没有任何自动重发路径**，所以不会重复注入。

---

## 4. S0b：设置与工具面

### 4.1 设置（non-live：stack 构建和 activate 时读取，改动后需 `/reload`；hub 侧另需 `/webhub restart`）

```jsonc
"fabric": {
  "enabled": false,                      // 既有总开关
  "wake": {
    // …第一期键不变…
    "rootRunMaxS": 900                   // NQ1；Controller 执行看门狗；解析时限定 60..3600；0 = 不启用 Controller（树内 wake:true 回到 legacy）
  },
  "crossSession": {
    "enabled": false,                    // Q2：默认关。只有 fabric.enabled ∧ webHub.enabled ∧ webHub.control!==false 时才生效
    "autoJoin": false,                   // 默认会话不加入；true ⇒ 每个新主会话启动即加入（§5.3）
    "receive": "wake",                   // 已加入会话的接收策略：off | deliver | wake（Q7 = wake）
    "discoverScope": "hub",              // hub | cwd：list_sessions 的可见范围（§5.1）
    "allowFrom": [],                     // 空 = 任何已加入的会话；非空 = 只接收这些 sessionId 前缀或会话名（大小写不敏感）
    "limits": { /* §5.2 表，全部可选，解析时按上下界限定 */ }
  }
}
```

- 解析：新增 `parseFabricCrossSessionSettings`，逐字段容错，从不抛错；`rootRunMaxS` 进入 `parseFabricWakeSettings`。**旧配置文件的解析结果逐字节不变**（新键有默认值，仅在新代码路径读取）。
- 生效条件 `xsOn = fabric.enabled ∧ crossSession.enabled ∧ webHub.enabled ∧ webHub.control !== false`，**在 activate 时冻结**（决定工具是否注册、schema 是否变化，因为工具 schema 属于缓存前缀）。`receive`/`allowFrom`/`limits` 在 stack 构建时读取。会话是否加入是 live 的（命令，§5.3）。

### 4.2 `CanMessage:"session"`（推迟到第三期）

本期不实现。只保留扩展点（§12.3）：`CanMessage` 不改；`runtime-adapter.ts` 不注入跨会话工具；wire 帧 `from` 里预留可选的 `run` 字段，本期 hub 遇到带 `run` 的帧一律拒绝（`E_XS_BAD_FRAME`），这样第三期开启时旧 hub 的行为是可预期的。

### 4.3 工具面

| 工具              | 注册位置                                                                       | 参数                                                                                   | 返回                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`   | **仅主会话**：`src/index.ts` post-guard，仅 `xsOn`（子会话不注入，第三期再议） | `{ query?: string }`（按名称或 id 前缀过滤）                                           | ≤20 行：`{ ref, name?, cwd(~标签), kind, receive:"deliver"\|"wake", busy, lastActiveAgoS }`。`ref` 是 sessionId 前 12 位。**不返回** agentKey、pid、对方工具或模型。自己的会话不出现在列表里 |
| `message_session` | 同上                                                                           | `{ to: string, text: string, wake?: boolean }`；`to` = `ref` / 完整 sessionId / 会话名 | `{ status, effect:"applied"\|"none"\|"unknown", reason?, to:{ref,name}, wakeDowngraded? }`                                                                                                   |

- **为什么新开 `message_session`，不扩展 `message_agent` 的 `to`**：① 主会话本来就没有 `message_agent`（A1），新工具不会引入树内语义；② `message_agent` 的 schema 有 C-P4 golden，子会话缓存前缀不受影响；③ 关闭时工具直接不存在，最容易保证逐字节不变。备选（扩展 `message_agent`）见拍板 P4。
- `to` 的保留形式：拒绝 `root`/`system`/`main`/`r_…`/`@…`/`wf_…`（`E_XS_BAD_TARGET`，提示用 `message_agent`），与树内地址和 consult 的 `"main"` 互不冲突（G2）。
- `kind` 固定为 finding 语义（没有 kind 参数）：跨会话没有 parent/child 关系，`directive` 的权威含义不成立；`progress` 永不跨会话。拍板 P5。
- 省略 `wake` ⇒ `false`（Q1）。`wake:true` 是昂贵类：受发送方 root 的 causal level（`hopAllowed(root)`）和 `limits.wakesOutPerHour` 约束；本期没有子 run 发送方，不涉及第一期的 `perRunQuota`。
- `from` 不由模型提供：工具在主会话进程里执行，经本进程的 web-hub 连接发出，hub 按 socket 盖上会话身份（sessionId、name、cwd、agentId）。消息头里显示 `from` 的 `ref` 与 `name`，接收方想回复，就对这个 `ref` 调 `message_session`（前提是发送方也已加入，而发送必须先加入，所以一定成立，除非对方随后退出或屏蔽）。

### 4.4 web-hub 是否暴露

- **只读暴露（推荐纳入 X5）**：`StatusInfo.xs?: { joined: boolean; receive: "off"|"deliver"|"wake"; blocked: number }`，append-only 的可选字段（与 `todo`/`worktrees` 先例相同），AgentCard 上显示一个 `xs` 徽标。crossSession 关闭 ⇒ 字段不存在 ⇒ 帧逐字节不变。
- **UI 开关（推荐不做，放到第三期）**：浏览器端「加入/退出」会给 LAN 会话开出写路径，需要走 cap、CSRF、`cmd` 策略整套流程。本期加入控制只在 TUI/RPC 命令里（§5.3）。拍板 P3。

---

## 5. 发现、限制与加入控制

### 5.1 发现机制

**第一期（树内）对照**：

| 维度     | 树内（第一期，现状）                                                                                           | 跨会话（第二期，推荐）                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址形式 | run id（`r_…`）、`"root"`、`@label`（需 `can_message: mention`，只能指向 root 的直接子 run）                   | `list_sessions` 返回的 `ref`（sessionId 前 12 位）、完整 sessionId、会话名；**只能指向主会话**                                                                  |
| 怎么知道 | 派发时 Agent 工具返回 run id；`list_subagents`（只在主会话）；父子关系是天然已知的；子 agent 通常只知道 parent | `list_sessions`（只在主会话），返回范围见下；收到消息时从消息头得知对方 `ref`；**没有**被动广播，不会把会话清单注入 system prompt（避免缓存前缀抖动和信息泄露） |
| 授权     | `authorize()` = kind × relation × `can_message`；关系由树决定                                                  | 发送方：工具存在（`xsOn`）且本会话已加入；接收方：已加入 ∧ `receive ≠ off` ∧ `allowFrom` ∧ 不在屏蔽列表。没有关系或类型维度                                     |
| 范围     | 同一个宿主进程内的同一棵树                                                                                     | 同一个 hub（per-uid，同机）上**已加入**的主会话（独立启动的终端 pi、web-hub 托管的 rpc 会话一视同仁）                                                           |

**`list_sessions` 的返回范围**（三层过滤，全部在 hub 侧执行，agent 侧再校验一次）：

1. **同 hub / 同用户**：天然成立（hub 是 per-uid 的，agent socket 在 per-uid 状态目录下）。不同用户、不同机器不可达，本期不做跨机器。
2. **显式 opt-in 才可被发现**：只列出 `StatusInfo.xs.joined === true` 且 hello caps 含 `xs.v1` 的 live agent。未加入的会话**不可见也不可达**（对它的 send 返回与「不存在」相同的 `E_XS_NO_TARGET`，防止探测）。
3. **`discoverScope`**：`hub`（默认，所有已加入会话）| `cwd`（只列出与发送方 cwd 相同或互为父子目录的会话）。两种模式下 send 都套用相同的范围，否则 `list` 的限制没有意义。

**防枚举**：list 限流（§5.2）；每次最多 20 行；按名称过滤时只做前缀和精确匹配；hub 只回投影字段。解析歧义（前缀匹配多个）⇒ 返回 ≤5 个候选（只含 `ref`/`name`），不自动选。

### 5.2 限额

**第一期现有限额（代码默认值，`DEFAULT_SETTINGS.fabric`，已核对）**：

| 键                                                               | 默认           | 作用（按代码）                                                                  |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `fabric.enabled`                                                 | `false`        | 总开关                                                                          |
| `fabric.maxPerRun`                                               | 20             | **每个发送 run 的 `progress` 配额**（`router.quota("progress")`，名称有误导性） |
| `fabric.findingQuota`                                            | 10             | 每个发送 run 的 finding 配额                                                    |
| `fabric.directiveQuota`                                          | 5              | 每个发送 run 的 directive 配额                                                  |
| `fabric.deadLetterQuota`                                         | 5              | 每个接收者的死信与系统回执配额                                                  |
| `fabric.maxChars`                                                | 2000           | 正文截断（前 75% + 后 25%）                                                     |
| `fabric.minIntervalMs`                                           | 30 000         | 同一链路（from→to）的最小投递间隔                                               |
| `fabric.rootMinIntervalMs`                                       | 10 000         | 投递到 root 的最小间隔（解析时下限 1s，0 = 关）                                 |
| `fabric.rootInboxCap`                                            | 12             | root 未消费的 context 消息上限 ⇒ 超出时 `target_backpressure`                   |
| `fabric.progressTtlMs`                                           | 900 000        | progress 的 TTL（finding/directive 用 `reconcileTtlMs` = 24h）                  |
| `fabric.wake.maxLevel`                                           | 2              | 因果跳数上限（Q9），超出降级为只投递                                            |
| `fabric.wake.perRunQuota`                                        | 3              | 每个发送 run 有效的 `wake:true` 次数（root wake 与 revive 共享）                |
| `fabric.wake.resumesPerHour`                                     | 6              | 全局 revive 次数/小时                                                           |
| `fabric.wake.resumesPerTargetPerHour`                            | 2              | 每个目标会话文件的 revive 次数/小时                                             |
| `fabric.wake.parkCapPerTarget`                                   | 8              | 每个已结束目标可 park 的消息数                                                  |
| `fabric.wake.resumeBudgetS`                                      | 600            | revive 出来的 run 的固定预算（60..3600）                                        |
| （其他）`deliveryAttempts` / `reconcileTtlMs` / `budget.steerMs` | 3 / 24h / 既有 | 投递重试、记录 TTL、steer 超时                                                  |

**第二期新增（`fabric.crossSession.limits.*` 与 `fabric.wake.rootRunMaxS`；括号内为解析上下界）**：

| 维度                | 键                              | 默认                    | 执行方                          | 说明                                                                |
| ------------------- | ------------------------------- | ----------------------- | ------------------------------- | ------------------------------------------------------------------- |
| 正文                | （复用 `fabric.maxChars`）      | 2000 字符               | 发送端截断；hub 帧硬上限 16 KiB | hub 对序列化后超过 16 KiB 的帧直接拒绝（`E_XS_TOO_LARGE`），不截断  |
| **每会话出站**      | `sendsOutPerMin`                | 10 (1..60)              | hub（权威）+ 发送端（预检）     | 按发送方主会话计                                                    |
|                     | `sendsOutPerHour`               | 60 (1..600)             | hub                             |                                                                     |
|                     | `wakesOutPerHour`               | 6 (0..60)               | hub                             | 有效 `wake:true` 次数；0 = 本会话只能只投递                         |
| **每会话入站**      | `recvPerHour`                   | 30 (1..600)             | 接收端（权威）+ hub             | 超出 ⇒ `effect:"none", reason:"inbound_rate"`                       |
|                     | `wakesInPerHour`                | 12 (0..60)              | 接收端                          | 存档值；超出 ⇒ 降级为只投递（`wakeDowngraded:"inbound_wake_rate"`） |
|                     | （复用 `fabric.rootInboxCap`）  | 12                      | 接收端                          | 跨会话消息与树内 root 消息共享同一个收件箱上限                      |
| **每对会话**        | `pairMinIntervalMs`             | 30 000 (5 000..600 000) | hub                             | 存档值；同一个 (S→R) 两次发送之间的最小间隔                         |
|                     | `pairWakesPerHour`              | 2 (0..20)               | hub                             | 同一对会话的有效 wake 次数，防止两个会话互相 ping-pong              |
| **全局（hub）**     | `inFlightPerSession`            | 4 (1..16)               | hub                             | 存档值；在途的 send（尚未收到 ack）                                 |
|                     | `hubSendsPerMin`                | 60 (1..600)             | hub                             | 全 hub 合计（`HubConfig.crossSession.limits` 下发）                 |
|                     | `listPerMin`                    | 6 (1..60)               | hub                             | `list_sessions` 与 resolve 调用（每个发送方会话）                   |
| 时效                | `expiresMs`                     | 5 000（固定，不可配）   | hub 盖章、接收端校验            | 存档值；过期 ⇒ 接收端拒收（`none`）                                 |
| **主会话 wake run** | `fabric.wake.rootRunMaxS`       | 900 (60..3600；0 = 关)  | 接收端 Controller               | NQ1；启动看门狗 10s、`abortGraceMs` 10s 是常量                      |
| 跳数                | （复用 `fabric.wake.maxLevel`） | 2                       | 发送端预检 + 接收端权威         | 跨会话一跳与树内一跳等价，两者在同一条因果链上累计                  |

> 默认值的取向：入站比出站宽（12 vs 6 wake/h），这样多个发送方各自都在出站配额内时，接收方仍是最后一道闸门；每对会话 2 次/小时用于压制会话之间的循环唤醒；全局上限防止单个 hub 被刷屏。

### 5.3 加入控制

**原则**：加入跨会话网络 = 允许别的会话往本会话的上下文里写文本并起 turn。这是**人**的决定，不是 agent 的决定（消息本身就是不可信输入，如果 agent 能自己加入，一条提示注入就能把会话拉进网络）。默认保守：**不加入**。

**推荐方案（两层，全部由人控制）**：

| 层           | 谁  | 机制                                                                                                                                                                       | 默认    | live？                                                                                                                               |
| ------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ① 能力开关   | 人  | 设置 `fabric.crossSession.enabled`（以及 fabric、webHub、control 三个前置开关）                                                                                            | `false` | non-live（`/reload` + `/webhub restart`）                                                                                            |
| ② 会话级加入 | 人  | 命令 `/fabric join` · `/fabric leave` · `/fabric status`（TUI；RPC 客户端发同名命令也可以；**web 命令策略为 deny**，见下）；或设置 `autoJoin:true`（每个新主会话自动加入） | 不加入  | live；持久化 `subagent:xs-membership`（只读 branch 读回；`/new` 得到新会话，按 `autoJoin` 重新决定；`/resume` 读回该会话自己的状态） |

- **接收端拒收与屏蔽**：`/fabric receive off|deliver|wake`（会话级，覆盖设置里的 `receive`）；`/fabric block <ref|name>` / `/fabric unblock …`（会话级屏蔽列表，按发送方 `sessionId` 记录，上限 64，持久化在同一个 membership entry 里）；设置 `allowFrom`（全局白名单）。被屏蔽的来源得到 `effect:"none", reason:"rejected"`——与「对方未加入」不同，但不区分具体是被屏蔽、策略为 off 还是 allowFrom 不匹配，以免泄露策略细节。
- **agent 能不能自己控制**：**不能加入**（防注入）。是否允许 agent **退出**（安全方向）列为备选 B：提供一个 `fabric_leave` 的工具形态。不推荐，因为工具面多一个名字，而人随时可以 `/fabric leave`。
- **web 端**：本期 `/fabric join` 在 `webCommandPolicy` 里为 deny（LAN 会话不能把会话拉进网络）；`/fabric status` 允许。web UI 开关是拍板 P3。
- **managed rpc 会话**（hub 拉起的无人会话）：默认不加入；`autoJoin:true` 时也加入。它没有人类输入，Controller 的「人类介入撤销」不会触发，靠 `rootRunMaxS` 兜底（§6）。

**备选**：

- A（推荐）：上表两层；加入即同时具备收、发能力（发送必须先加入，保证对方总能回复）。
- B：A，再加 agent 可调用的「只退出」工具。
- C：只有设置 `enabled` + `autoJoin`，没有会话级命令（实现最省，但无法只让某一个会话加入）。
- D：拆开「可发送」与「可被发现/接收」两个开关（例如只发不收）。本期不推荐：只发不收的会话无法被回复，交互不对称；如需要可在第三期与子 agent 参与一起设计。

---

## 6. R1：RootWakeController

### 6.1 定位

**主会话上由跨会话消息触发的自治 run 的唯一入口**。负责：跨会话 `wake:true`。不负责（P7 推荐）：树内 root 投递，包括显式 `wake:true`（保持第一期 legacy）；完成通知（第一期 quiet/normal 路径保持不变）；`/goal`、topic-switch 回注等扩展自己发起的 run。Controller 的接口（`dispatch(message, opts)`）是通用的，P7 若选备选，树内只需在 `sendRootContext` 加一处调用。

文件：`src/fabric/root-wake.ts`（pi-free 状态机）+ `stack.ts` 装配（每个 stack 一个实例）+ `index.ts` 事件转发（`before_agent_start`、`agent_settled`、`input`、`session_start`/`session_shutdown`）。

### 6.2 状态机

```
idle ──dispatch(ok)──▶ armed{token, expiresAt=now+startupMs(10s)}
armed ──before_agent_start{custom, details.wakeToken===token}──▶ bound{runSince}
armed ──startup watchdog 到点（没看到绑定事件）──▶ idle  [不 abort；审计 wake_unbound；计数]
armed ──before_agent_start{user | 别的 token}──▶ idle  [别的 run 抢先启动：本次唤醒的消息已作为 steer 进入那个 run，不再监管]
bound ──agent_settled──▶ idle  [正常结束]
bound ──人类输入（wake-input 判定为人类：interactive/rpc/web_prompt）──▶ idle  [撤销监管，run 交还给人]
bound ──session_start / session_shutdown──▶ idle  [stack 重建，监管随之消失；新 stack 不会认领旧 token]
bound ──执行看门狗 rootRunMaxS 到点──▶ aborting  [只在 bound 且自 runSince 以来没有人类输入时；调用 ctx.abort()，不等待]
aborting ──agent_settled──▶ idle
aborting ──abortGraceMs(10s) 到点──▶ idle  [只告警：console.warn + 计数 abortStuck；绝不二次 abort、绝不阻塞]
```

- **dispatch 前置条件**（同步检查，任一不满足就**不起 run**，降级为只投递，`wakeDowngraded` 写明原因）：`ctx.isIdle()` ∧ `!ctx.hasPendingMessages()` ∧ 栅栏通过（§7）∧ 当前状态为 `idle`（同一时刻只监管一个 run）∧ `now < expiresAt`（消息自身的过期时间，派发前检查）∧ pi 能力探针 `beforeAgentStartCustomDetails === true`（A7；pi < 1.2 ⇒ 降级）。
- **派发**：`pi.sendMessage({customType:"subagent:xs" | "subagent:fabric", content, display:false, details:{…, wakeToken}}, {triggerTurn:true})`。token 是 `newRunId()` 风格的随机串，**只放在 `details` 里**（不进 `content`，不发给 provider，§8.5）。
- **root 正忙时**（不满足 idle）：跨会话消息如果没有命中栅栏，就按 `deliverAs:"steer"` 投进当前 run（不起新 run，不监管——那个 run 属于人或别的发起者）；`wake:false` 走 `triggerTurn:false`。
- **定时器**：全部用 `systemClock.setTimer`（分段、unref）；`dispose()` 在 stack 销毁时清空。

### 6.3 与第一期的关系

| 第一期机制                                          | 与 Controller 的关系                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WakeService.revive`（唤醒已结束的子 run）          | **无关、互不调用**。revive 出来的 run 是 runner 管理的子 run（fixed 600s + watchdog 全套）；Controller 管的是主会话 run。跨会话**不会** revive 远端的子 run（§12 不做）                                                                                 |
| 预约所有权（`reserveStrict` 等）、`inputAcceptedAt` | 不涉及。跨会话没有 outbox 记录；接收端的「已接受」证据是 `sendMessage` 同步返回不抛错（pi 已入队或追加）⇒ ack `applied`。pi 在流式期间把 `triggerTurn:false` 的消息放在 `_pendingCustomMessages`（只在内存里），崩溃会丢——属于 NQ2 的至多一次，记录在案 |
| `CausalLevel`                                       | dispatch 前 `raise("root", senderLevel+1)`；人类输入会归零（`wake-input.ts`，**不新增**归零点）。Controller 的「人类介入撤销」**复用同一个判定**（在 `wake-input.ts` 增加一个回调），保证两者口径一致                                                   |
| 树内 root 投递（`sendRootContext`）                 | P7 推荐：**不接入**，保持第一期逐字节不变。备选：`record.wake === true` 且 Controller 可用 ⇒ 交给 `controller.dispatch(...)`，Controller 拒绝（忙、栅栏、版本）⇒ 退回第一期 legacy steer 调用                                                           |

### 6.4 与 switch_context / compaction / topic-switch 并发

- **compaction**（阈值、手动、溢出均算）：栅栏窗口内拒绝 dispatch（§7）。Controller 已经 `bound` 时发生压缩：压缩发生在 run 内部或 turn 边界，**不撤销**监管，执行看门狗照常计时（压缩时间计入 900s——上限是墙钟，宁紧勿松）。
- **switch_context**（主会话）：handoff 在 turn_end 暂存，到 `session_before_compact` 才生效，因此由 compaction 窗口覆盖；暂存期间如果有新的唤醒请求，root 必然不处于 idle，消息作为 steer 进入当前 run，合法。
- **topic-switch**：它的 `input` 处理器只 hold `interactive`/`rpc` 来源的输入，custom 消息不经过 `input` ⇒ 不会被 hold。但「hold 等待确认」与「PONR 迁移中」两个窗口里起一个自治 run，会让被 hold 的人类请求排到它后面，或者落进错误的会话 ⇒ 两个窗口都进入栅栏（§7）。
- **web resume / `/new`**：exec claim 持有期间与 `switchInFlight` 期间进入栅栏（§7）。Controller `bound` 时发生会话切换：`session_start` ⇒ 撤销监管；pi 在切换前会 abort 当前 run（pi 自身语义），与 Controller 无关。
- **`/goal` 活动**：只阻止唤醒（降级为只投递），不阻止投递（存档原意）。

### 6.5 零挂起

每个状态都有出口：armed ≤10s；bound ≤ `rootRunMaxS`；aborting ≤10s，之后只告警。Controller 自己从不 await pi，`ctx.abort()` 发出即走。这里不存在不受管的路径：凡是 Controller 拒绝的，都只做只投递或 legacy steer（legacy steer 本身是第一期就有的路径，不是新增）。

### 6.6 pi 版本降级

`readBeforeAgentStartTrigger` 扩展后读不到 `details`（pi 1.0/1.1，或未来形状变化）⇒ 能力探针为 false ⇒ **跨会话 `wake:true` 一律降级为只投递**（`wakeDowngraded:"host_unsupported"`），树内 `wake:true` 退回第一期 legacy。conformance C-X1 锁定 pi 1.2 的形状；pi peer 升级前必须跑。

---

## 7. T1/T2：会话变更栅栏

### 7.1 何时需要

- **T1（接收端栅栏）**：接收端每一次 dispatch（含 `triggerTurn:false` 的只投递）之前。原因：在会话变更窗口内写入 custom 消息，会落进即将被替换或压缩的上下文，或在切换时被丢弃，而发送方已经拿到 `applied`。
- **T2（地址绑定）**：本期没有回复授权（D1），T2 收窄为「地址只认 sessionId」：hub 投递时精确匹配目标 sessionId；接收端在 dispatch 的同步块里再比较一次「当前 sessionId === 帧里的目标 sessionId」，`/new`、`/resume`、`/fork` 之后旧地址自然失效 ⇒ `none / reason:"session_changed"`。发送方在 hub 往返期间切换了会话：工具调用随旧 run 结束，结果丢弃即可（hub 已经按发送时的身份盖章，不会冒用新会话的身份）。第三期加入 run 级回复授权时，再引入「本地会话链 + gen」的完整 T2。

### 7.2 实现（`src/fabric/xs/fence.ts`，pi-free）

```ts
interface FenceSource {
  name: "compaction" | "switch" | "tree" | "web_exec" | "topic_switch" | "goal";
  active(): boolean;
}
interface SessionFence {
  gen(): number; // session_start 时 +1；session_before_switch / _fork / _tree 也 +1（供诊断和第三期 T2 使用）
  check(expect: { sessionId: string; gen: number }): { ok: true } | { ok: false; reason: string; wakeOnly?: true };
  dispose(): void;
}
```

- 事件窗口（pi 事件在 `index.ts` 转发；每个窗口都有 30s 安全超时，unref，超时自动关窗并 `console.warn`）：
  - `session_before_compact`（任意 reason）→ `session_compact` / `session_compact_failed`，关窗经 `setTimeout(0)` 延后（照搬 `compaction-state.ts` 的 D26：pi 在清 controller 之前就发出 `session_compact`）。
  - `session_before_switch` → `session_start`（或 30s）。
  - `session_before_fork`、`session_before_tree` → 对应的 `session_*` 完成事件。
- 迟绑定端口（`() => boolean | undefined`，undefined 视为不活动，抛错视为**活动**，失败关闭）：
  - `web_exec`：`resumeExec.switchInFlight()` ∨ exec claim 被持有（`src/web-hub/agent/index.ts` 加一个只读 getter）。
  - `topic_switch`：存在 pending hold ∨ 存在 B1 mid-switch 标记（`src/topic-switch/wire.ts` 导出只读 `fenceActive()`）。
  - `goal`：goal 处于 running ⇒ `wakeOnly`（降级为只投递，不拒收）。
- 校验时机：接收端在 dispatch 的**同一个同步块**里先 `check()` 再 `sendMessage()`，中间没有 await ⇒ 不存在 TOCTOU。`gen` 用于 T2，以及 hub 往返期间的会话变化（ack 前再比较一次 sessionId）。
- **失败路径**：栅栏命中 ⇒ ack `{effect:"none", reason:"fenced:<name>"}`；**不 hold、不排队、不重试**（NQ3）。发送方模型看到 `effect:"none"`，自己决定稍后重发。

---

## 8. X1–X5：跨会话投递

### 8.1 X1：hub 中继（`src/web-hub/hub/xs/`）

- `xs/router.ts`：处理 `xs_req{op}`（分派位置：`agent-server.ts`，与 `fsb_req` 同一层，不进 registry、bus、逐帧日志）。
  - `list`：遍历 registry，筛选 `phase==="live"` ∧ caps 含 `xs.v1` ∧ `status.xs.joined` ∧ 不是发送方自身 ∧ 满足 `discoverScope` ⇒ 投影。
  - `resolve`：sessionId 精确 → 前缀（≥8）→ 名称精确 → 名称忽略大小写；歧义 ⇒ ≤5 个候选；没有匹配 ⇒ `E_XS_NO_TARGET`（未加入的会话也返回这个）。
  - `send`：先**再次精确匹配** `sessionId`（恰好一个 live、已加入、带 cap 的 agent；匹配到两个，比如同一个会话文件被两个 pi 打开 ⇒ `E_XS_AMBIGUOUS`，不投递），然后检查限额（§5.2 中由 hub 执行的部分），盖章 `from={sessionId, name, cwd, agentId, fromRun?}`、`xid`（hub 生成）、`expiresAt=now+5s`，再 `registry.request(target, {t:"xs_deliver",…}, 5_000)`。
- `xs/limits.ts`：令牌桶 / 滑动窗口，全部在内存里，hub 重启即清零（可接受：重启本身就有成本，频率上限只是防风暴）。
- 审计：`audit.ts` 增加 `xs` 行（白名单字段：`op`、`xid`、`fromSession`/`toSession` 的前 8 位、`textLen`、`wake`、`outcome`、`reason`），**不记正文，也不记正文哈希**（U7 先例）。
- 装配：`hub.ts` 只在 `config.crossSession` 存在时构建，`xs.v1` 进入 `extraHubCaps`（两个面同源）；`main.ts` 复核配置，不合法就丢弃该键。

### 8.2 X2：agent 侧连接（`src/web-hub/agent/xs.ts`）

- 发送：`request({t:"xs_req",…}, "xs.v1")`，截止 = 5s（resolve/list）或 `expiresAt + 1s`（send）。没有 cap、断链、超时 ⇒ 交给发送端核心分别映射为 `E_XS_OFF{hub}` / `unknown`。
- 接收：`connection.ts` 增加 `case "xs_deliver"`（`link==="live"` 才处理，否则回 `E_STALE_CTX`/`none`），交给 binding 的 `onXsDeliver`，再由迟绑定端口交给当前 stack 的 receiver；没有 stack ⇒ 回 `none / stack_unavailable`。
- 成员资格上报：`StatusInfo.xs`（§4.4），fingerprint 门控发布。
- hello caps：`capsExtra()` 在 `xsOn` 时推入 `xs.v1`（静态）。

### 8.3 旧版本对端降级

| 情形                                       | 行为                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 发送方新、hub 旧（hello_ack 没有 `xs.v1`） | 工具返回 `E_XS_OFF{reason:"hub"}`，提示 `/webhub restart`（照搬 launcher 变更提示的先例） |
| 接收方旧（hello 没有 `xs.v1`）             | 不出现在 list 里；send ⇒ `E_XS_NO_TARGET`（与未加入相同）                                 |
| hub 新、两端都旧                           | hub 不会主动发 `xs_*` 帧，无影响                                                          |
| 接收方新，但 crossSession 关闭             | 不带 cap ⇒ 同「接收方旧」                                                                 |

### 8.4 X3/X4：managed rpc 与 hub 重启

- **managed rpc**：`kind:"rpc"` 的 agent 与 TUI 一视同仁。区别只有：没有人类输入 ⇒ Controller 只靠 `rootRunMaxS` 兜底；restore 重新 fork 的进程有新的 `agentId`，但 sessionId 不变 ⇒ 发往该会话的消息照常可达（成员资格从会话 entry 读回，restore 后仍是已加入）。
- **hub 重启**：在途的 send 全部变成 `unknown`（发送方超时），**不补发**；registry 重建，agentKey 变了也不影响（我们不用 agentKey）；限额计数清零；接收端 LRU 在 agent 进程里，不受影响。回复授权存放在发送方会话的 entry 里，绑定 `agentId+sessionId`，hub 重启后依然有效。
- **回复**：本期没有回复授权（D1）。回复就是一次普通的 `message_session`，发给消息头里的 `from.ref`；受同样的成员资格、策略和限额约束。第三期如果允许子 run 发送，「回复给那个子 run」需要 run 级授权（§12.3）。

### 8.5 X5：provider payload 不被污染

- `details`（含 `wakeToken`、`xid`、来源元数据）不会发给 provider：pi 把 custom 消息转换为 `role:"user"` 时只取 `content`。**这必须由 conformance C-X5 锁定**（真实 pi + 本地 Anthropic stub，断言请求体里没有 token，`tools`/`system` 前缀字节不变）。
- `content` 的格式：宿主说明放在边界外，元数据 JSON 编码后截断到 64 字符，正文放在接收方生成的 nonce 边界之间（A6）；头部写明「不可信输入」。
- system prompt 不受影响：不注入会话清单；`list_sessions`/`message_session` 只在 activate 时注册一次（工具表冻结，sysprompt hub 不新增 section）。
- 子会话缓存前缀：本期不向子会话注入任何新工具，子会话工具表逐字节不变（golden）。

---

## 9. NQ3：去重 LRU

- **范围**：只在接收端，按 hub 生成的 `xid` 去重（发送方不重试，所以重复只可能来自 hub 侧的异常重放或重连竞态）。
- **容量与 TTL**：256 条 / 60s（TTL 远大于 `expiresMs`=5s；过期的消息本来就会被拒收，LRU 只需覆盖过期窗口内的重复）。只放内存，每个 stack 一份；`/reload` 后丢失也无妨，因为窗口已经被 `expiresAt` 界定。
- **命中**：回放第一次的 ack（`applied`/`none`），不再次 dispatch。
- **与 `wake_result` 的关系**：没有关系。`wake_result` 是第一期树内的系统回执（`admitSystemResult`，`route.kind:"wake_result"`），跨会话**不回传**结果（Q10），也不产生 `wake_result`；远端 root 被唤醒后的 run 结束了，发送方什么都收不到，要结果只能由对方主动 `message_session` 回发。

---

## 10. 安全与不变量

### 10.1 不变量（每条都对应测试，见 §11）

| ID   | 不变量                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XI1  | crossSession 关闭（或任一前置开关关闭）⇒ 工具表、`message_agent` schema、`HubConfig`、hello caps、`StatusInfo`、session entry 全部逐字节不变（`fabric-xs-off-golden.json`）；第一期 golden 不改 |
| XI2  | 主会话新增的自治 run **只有**一条路径：`RootWakeController.dispatch`；其余全部是只投递，或第一期已有的 legacy 调用                                                                              |
| XI3  | 每条跨会话消息**最多** dispatch 一次（发送端不重试 + 接收端 `expiresAt` + LRU）                                                                                                                 |
| XI4  | 发送方身份**只**来自 hub 对 socket 的盖章；帧里的身份字段一律忽略；带第三期预留字段（`from.run`）的帧本期一律拒绝                                                                               |
| XI5  | 未加入的会话对 list 不可见、对 send 不可达，与「不存在」不可区分                                                                                                                                |
| XI6  | 正文不进 hub.log、`console.warn`、审计行、telemetry；只记长度与计数                                                                                                                             |
| XI7  | 每个等待点都有界：hub request ≤5s；Controller 10s / `rootRunMaxS` / 10s；栅栏窗口 30s 安全超时；所有定时器 unref                                                                                |
| XI8  | 栅栏检查与 dispatch 在同一个同步块里                                                                                                                                                            |
| XI9  | `wake:true` 跨会话的一跳计入 `maxLevel`；只有人类输入会让 root 归零                                                                                                                             |
| XI10 | `details.wakeToken` 永不出现在 provider 请求体里                                                                                                                                                |

### 10.2 零挂起

hub 侧 `registry.request` 带截止时间；agent 侧 `connection.request` 带截止时间；接收端 dispatch 是同步的（`sendMessage` 不 await）；Controller 不 await pi；授权写盘走 `appendEntry`（同步、失败吞掉）。print 模式（`pi -p`）：web hub 在 print 模式下本来就不装配 ⇒ xs 惰性；即使装配了，所有定时器也都 unref。

### 10.3 认证与授权

- 能发消息的只有：本机、同 uid、连着同一个 hub 的 pi 进程（agent socket）。浏览器、LAN、飞书**没有**直接的 xs 入口。
- LAN 用户 / 飞书用户能否「触发」：只能通过已有的 prompt 路径让某个会话里的模型去调工具，等价于他本来就有该会话的控制权（U1 单用户裁决）。`/fabric join`、`/fabric receive` 对 web 命令策略为 deny（防止 LAN 会话自行改变成员资格）。
- 死信与审计：跨会话**没有**死信记录（不持久化投递状态），失败通过工具结果同步回给发送方；hub 审计行与接收端的 `console.warn("[pi-subagent] fabric xs …")`（不含正文）计数，并进入 `/agent status` 的 xs 行（§11 X5）。

### 10.4 门禁

- source-scan：`src/fabric/xs/**` 禁止 import pi（I1 风格的扫描测试，照抄 `tool-scope` 的「零 `@earendil-works/*`」断言）；`src/web-hub/hub/xs/**` 禁止 import pi（hub 从不 import pi）。
- 审计字段白名单测试：构造带正文的帧，断言 hub.log 里没有正文子串。
- conformance：C-X1…C-X6（§11），并入 `npm run test:conformance`；pi peer 升级前与 consult-preserve、fabric-wake 一起跑。

---

## 11. 拆包

### 11.1 文件所有权与顺序

| 文件 / 域                                                                                                                                                                  | 包                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `src/config/settings.ts`、`src/runtime/tool-scope.ts`、`src/web-hub/protocol/{messages.ts,version.ts}` + 新建 `protocol/xs.ts`、`tests/fixtures/fabric-xs-off-golden.json` | XS0                            |
| `src/adapters/pi-compat.ts`（扩展 `readBeforeAgentStartTrigger`）、新建 `src/fabric/root-wake.ts`、`src/fabric/wake-input.ts`（撤销回调）                                  | R1                             |
| 新建 `src/fabric/xs/fence.ts`；`src/topic-switch/wire.ts`（只加只读 `fenceActive()`）；`src/goal/hook.ts`（只加只读 getter）                                               | T1                             |
| 新建 `src/web-hub/hub/xs/*`；`src/web-hub/hub/{agent-server.ts,hub.ts,main.ts,audit.ts}`                                                                                   | X1                             |
| 新建 `src/web-hub/agent/xs.ts`；`src/web-hub/agent/{connection.ts,index.ts}`（caps、`buildHubConfig`、`StatusInfo.xs`、exec-claim getter）                                 | X2                             |
| 新建 `src/fabric/xs/{sender.ts,format.ts}`、`src/tools/{list-sessions-tool.ts,message-session-tool.ts}`                                                                    | X3                             |
| 新建 `src/fabric/xs/{receiver.ts,lru.ts,membership.ts}`、`src/commands/fabric-xs.ts`                                                                                       | X4                             |
| `src/stack.ts`、`src/index.ts`（只加装配）                                                                                                                                 | R1 → T1 → X3 → X4 → X5（串行） |
| `src/commands/status.ts`、`src/fabric/wake.ts`（`WakeStatusView` 增加 xs 计数）、AGENTS.md                                                                                 | X5                             |

### 11.2 包表

| 包                           | 内容                                                                                                                                                                                                                                                                                                                                                                                                      | 依赖                             | 验收锚点（每包都要求 typecheck、format:check、全量 `npm test` 通过）                                                                                                                                                                                                                                                                                                                                                                                                                  | 估时 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **XS0** 契约                 | **先采集** off golden；设置 `fabric.crossSession.*` + `wake.rootRunMaxS` 的解析；`RESERVED_TOOL_NAMES` 加两个名字；`protocol/xs.ts`（帧的 TS 类型、typebox schema、cap 常量，`from.run` 预留字段；只加，不装配）；`xsOn` 判定函数                                                                                                                                                                         | —                                | `tests/config/settings-fabric-xs.test.ts`（容错、上下界、未知键）；`tests/web-hub/protocol/xs-frames.test.ts`（decode/reject、16 KiB、带 `from.run` 的帧被拒）；`tests/integration/fabric-xs-off-golden.test.ts`；第一期 `fabric-wake-off-golden` 不变                                                                                                                                                                                                                                | 1d   |
| **R1** Controller            | pi-compat 探针扩展；`root-wake.ts` 状态机；`wake-input` 撤销回调；stack/index 装配（只服务跨会话，P7 推荐）                                                                                                                                                                                                                                                                                               | XS0                              | `tests/fabric/root-wake.test.ts`（FakeClock：全部转移；启动看门狗不 abort；只在 bound 且没有人类介入时 abort；abortGrace 后只告警；别的 run 抢先启动；session_start 撤销；dispose 清空定时器）；`tests/integration/fabric-root-wake.test.ts`（真实 stack：Controller 起 run、撤销、超时 abort；树内 `wake:true` 仍是 legacy，golden 不变）；**C-X1**（真实 pi 1.2：custom 起的 run 的 `before_agent_start` 带有 `message.details.wakeToken`；`ctx.abort()` 后会发出 `agent_settled`） | 1.5d |
| **T1** 栅栏                  | `fence.ts`；事件窗口（含 D26 延后）；三个端口的只读 getter                                                                                                                                                                                                                                                                                                                                                | XS0（与 R1 并行）                | `tests/fabric/xs-fence.test.ts`（每个窗口的开关窗、30s 安全超时、端口抛错视为活动、goal ⇒ wakeOnly、gen 递增）；**C-X2**（真实 pi：`session_compact` 先于 controller 清理 ⇒ 关窗延后；手动与阈值压缩都覆盖）                                                                                                                                                                                                                                                                          | 1d   |
| **X1** hub 中继              | `hub/xs/{router,limits}.ts`；`agent-server` 分派；`audit` 的 xs 行；`hub.ts` caps 与装配；`main.ts` 配置复核                                                                                                                                                                                                                                                                                              | XS0（与 R1、T1 并行）            | `tests/web-hub/hub/xs-router.test.ts`（list 过滤、resolve 顺序与歧义、send 精确匹配与 `E_XS_AMBIGUOUS`、盖章忽略帧内身份、`expiresAt`）；`xs-limits.test.ts`（每一行限额）；`caps-coexist` 更新（两个面一致）；`audit` 正文不出现                                                                                                                                                                                                                                                     | 1.5d |
| **X2** agent 连接            | `agent/xs.ts`；`connection` 的 `xs_deliver` 分支；`capsExtra`/`buildHubConfig`/`StatusInfo.xs`                                                                                                                                                                                                                                                                                                            | XS0（可与 X1 并行，用 fake hub） | `tests/web-hub/agent/xs-client.test.ts`（没有 cap ⇒ `E_XS_OFF`，超时 ⇒ unknown，断链，stale link 拒绝 deliver）；`StatusInfo` 关闭时逐字节不变                                                                                                                                                                                                                                                                                                                                        | 1d   |
| **X3** 发送端与工具          | `sender.ts`（发送端预检配额、resolve→send、`effect` 映射、`wake` 的 level 预检）；`list_sessions`/`message_session` 两个工具，只在主会话注册                                                                                                                                                                                                                                                              | X2                               | `tests/fabric/xs-sender.test.ts`；`tests/tools/message-session-tool.test.ts`（保留地址被拒、省略 wake 视为 false、结果形状、未加入 ⇒ `E_XS_NOT_JOINED`）；`tests/integration/fabric-xs-child-scope.test.ts`（xs 开启时子会话工具表逐字节不变，同名 MCP 工具被剥离）                                                                                                                                                                                                                   | 1d   |
| **X4** 接收端与加入控制      | `receiver.ts`（过期→成员资格与策略→sessionId→栅栏→level 与预算→dispatch）；LRU；`membership.ts` + `/fabric` 命令（join/leave/status/receive/block，web 策略）                                                                                                                                                                                                                                             | R1, T1, X2                       | `tests/fabric/xs-receiver.test.ts`（管道每一级的拒绝原因；没加入与不存在不可区分；屏蔽；入站速率；wake 降级；同步块）；`tests/commands/fabric-xs.test.ts`；`tests/integration/fabric-xs.test.ts`（**真实 hub 子进程 + 两个真实 stack**：主→主只投递与唤醒、回复（反向普通发送）、栅栏命中、旧对端、hub 重启得到 unknown、managed rpc restore 后可达、fork 不继承成员资格）                                                                                                            | 1.5d |
| **X5 / G2** 可观测与终局闸门 | `/agent status` 的 xs 行（`xs joined · recv wake · in 3/30h · out 2/60h · wakes 1/12h · fenced 1 · unbound 0 · abortStuck 0`，只用英文标记）；`StatusInfo.xs` 只读字段与 AgentCard 徽标（P3）；AGENTS.md；**C-X3** 静默与 ask_user 互不干扰；**C-X4** 内存会话（`SessionManager.inMemory`）下成员资格的 durability；**C-X5** provider payload；**C-X6** 第一期 C-P1…C-P5 与 consult-preserve C1–C7 不回归 | X3, X4                           | `npm run format:check && npm run typecheck && npm run build && npm test && npm run test:conformance`；两份 off golden 逐字节不变；零挂起审计（新定时器全部 unref）                                                                                                                                                                                                                                                                                                                    | 1d   |

**并行**：XS0 → {R1 ∥ T1 ∥ X1 ∥ X2} → X3 → X4 → X5。`stack.ts`/`index.ts` 的装配改动按 R1 → T1 → X3 → X4 → X5 串行（每包只追加装配代码，合入时 rebase）。
**规模**：约 8.5 人日（收窄后去掉了子会话注入、consult 影子、回复授权存储）；关键路径 XS0(1) → R1(1.5) → X4(1.5，同时等 X3) → X5(1) ≈ 6 天。新代码约 3–3.5k 行（含测试约 60%）。
**车道**：**L3（复杂）**：跨进程协议 + 新的主会话自治 run 路径 + 安全边界。每包返回后立即派 verifier（验收模型 ≠ 开发模型）；XS0 合入前先做一轮方案评审（本文）。

---

## 12. 风险与明确不做

### 12.1 风险

| #   | 风险                                                                  | 处置                                                                                                                                 |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| XR1 | pi 的 `before_agent_start` custom 形状变化 ⇒ Controller 无法绑定      | 探针失败关闭 ⇒ 只投递；C-X1 在 peer 升级前必跑                                                                                       |
| XR2 | 两个会话互相 `wake:true` 形成循环                                     | 每对会话 2 次/小时 + maxLevel 2 + 出站和入站 wake 配额；人类输入才归零                                                               |
| XR3 | 提示注入：远端消息诱导模型泄露本地信息                                | 不可信头 + nonce 边界；只能发给显式加入的会话；Q10 不回传结果；agent 不能自己加入                                                    |
| XR4 | 流式期间 `triggerTurn:false` 的消息只在 pi 内存里，崩溃会丢           | NQ2 至多一次，已记录；发送方已拿到 `applied`（文档写明 applied = 已入队，不代表已被模型读到）                                        |
| XR5 | 同一个会话文件被两个 pi 打开                                          | hub `E_XS_AMBIGUOUS`，拒绝投递                                                                                                       |
| XR6 | 第三期若把树内 `wake:true` 也改走 Controller（P7 备选），会是行为变化 | 本期不做；Controller 接口通用，届时只需在 `sendRootContext` 加一处调用                                                               |
| XR7 | 会话级成员资格放在 session entry 里，fork 会继承                      | fork 出来的会话继承「已加入」——推荐 fork 时**不继承**（读回时校验 entry 里记录的 sessionId 与当前 sessionId 一致，不一致视为未加入） |
| XR8 | hub 重启导致在途消息 unknown                                          | NQ3 交给模型决定；工具结果里写清楚                                                                                                   |
| XR9 | 第三期子会话注入新工具后 consult-preserve 影子清单漏项                | 第三期 C9 门禁；本期由 `fabric-xs-child-scope` 测试保证子会话完全不受影响                                                            |

### 12.2 明确不做（本期）

- 跨机器、跨用户、跨 hub 的投递；HTTP / LAN / 飞书直接发送跨会话消息。
- **所有子 agent 参与跨会话的形态**（推迟到第三期，见 §12.3）。
- 跨会话 revive 远端已结束的子 run；跨会话 park。
- 跨会话自动重试（NQ3）；远端唤醒结果回传（Q10）；跨会话 `wake_result`。
- web UI 的加入/退出开关（拍板 P3，默认推迟）。
- `directive`/`progress` 跨会话（P5）。
- 把会话清单注入 system prompt。
- 修改第一期的树内语义、outbox、reducer 输入、golden。
- 消除第一期 `/reload` 的 60s 回退（G-report 残留 1），另行处理。

### 12.3 第三期（子 agent 参与跨会话）：只列范围与扩展点，不设计

| 第三期议题                                                                                                           | 本期留的扩展点                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanMessage:"session"`：允许子 agent 获得跨会话发送工具（Q5）                                                        | `CanMessage` 联合与 `agent-types.ts` 过滤数组本期不改；`list_sessions`/`message_session` 已进 `RESERVED_TOOL_NAMES`，届时只需在 `runtime-adapter.ts` 的注入块加一个条件分支 |
| 子 run 发往别的会话（`from.run`）                                                                                    | wire 帧 `from` 预留可选 `run` 字段，本期 hub 拒绝；发送端核心 `sender.ts` 的 `SendOrigin` 是判别联合（本期只有 `{kind:"root"}`）                                            |
| 回复给发过消息的子 run（Q8 后半句）与回复授权（§12.5 存档：send 前安装、绑定 `agentId+sessionId` 与本地会话链、24h） | `agentId` 已在 hub 盖章并进入审计；`fence.gen()` 已经提供；本期 `D1` 明确不建授权存储                                                                                       |
| 别的会话把消息投给某个子 run 的 `toRun` 授权（§12.4 存档）                                                           | 接收管道是有序的阶段数组（`receiver.ts`），`toRun` 授权作为新阶段插在栅栏与 level 之间；本期地址联合 `XsAddress` 只有 `{kind:"session"}`                                    |
| 子会话注入后的 consult-preserve 影子与 C9、`can_message` 文档                                                        | `shadow-tools.ts` 本期不改；C9 预留编号                                                                                                                                     |
| 树内 `wake:true` 改走 Controller（P7 备选）                                                                          | `RootWakeController.dispatch` 的接口不绑定 xs                                                                                                                               |

---

## 13. 需用户拍板

| #   | 问题                                                | 推荐（放第一位）                                                                                                                | 备选                                                                                                                |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P1  | 加入控制模型（只针对主会话）                        | **A：两层，全部由人控制**（设置 `enabled` + 会话级 `/fabric join` 或 `autoJoin`），默认不加入，agent 不能自己加入；加入即可收发 | B：A + agent 可调用「只退出」工具；C：只有设置（enabled + autoJoin），没有会话级命令；D：拆开「可发送」与「可接收」 |
| P2  | 已加入会话的默认接收策略                            | **保留 Q7 = `wake`**（加入本身已经是显式 opt-in）                                                                               | `deliver`（更保守：加入后默认只投递，需要再 `/fabric receive wake`）                                                |
| P3  | web-hub 暴露程度                                    | **只读**：`StatusInfo.xs` + AgentCard 徽标；`/fabric join` 对 web 为 deny                                                       | 本期加 UI 开关（需要 cap、CSRF、策略）；或完全不暴露                                                                |
| P4  | 工具形态                                            | **新工具** `message_session` + `list_sessions`，只在主会话注册（不动 `message_agent` 及其 golden）                              | 在主会话注册 `message_agent` 并扩展 `to` 支持 `session:…`（引入树内语义，改 schema）                                |
| P5  | 跨会话允许的 kind                                   | **只有 finding 语义**（工具没有 kind 参数）                                                                                     | 允许 directive（无 parent 关系，语义存疑）                                                                          |
| P6  | `list_sessions` 默认范围                            | **`hub`**：所有已加入的会话（加入已经是 opt-in）                                                                                | `cwd`：只列同一目录树                                                                                               |
| P7  | Controller 是否也接管树内显式 `wake:true` 唤醒 root | **本期不接管**：Controller 只服务跨会话，树内保持第一期 legacy（零行为变化，golden 不变）                                       | 本期接管（多一个 900s 上限，Controller 拒绝时退回 legacy；属于对 fabric 用户的行为变化）                            |
| P8  | 新增限额默认值                                      | **按 §5.2 表**（出站 10/min、60/h、wake 6/h；入站 30/h、wake 12/h；每对 30s、wake 2/h；在途 4；全 hub 60/min）                  | 更紧：入站 wake 6/h、每对 wake 1/h                                                                                  |
| P9  | 协议版本                                            | **只加 cap `xs.v1`，不升 PROTO**                                                                                                | 升 minor 到 1.3（与 fleet F0 的先例一致，但 `protoCompatible` 只比较 major，实际没有作用）                          |
| P10 | fork / 复制会话是否继承成员资格                     | **不继承**（读回时校验 sessionId）                                                                                              | 继承                                                                                                                |

---

## §13 拍板结果（用户，2026-10-21）

- P1 加入控制：**两层人控**（`fabric.crossSession.enabled` + 会话级 `/fabric join|leave` / `autoJoin`），默认不加入，agent 无权加入或退出。
- P2 加入后默认接收模式：**wake**（可唤醒，受 RootWakeController 900s 与限额约束）。
- P6 发现范围：**hub 上所有已加入会话**（同目录过滤作为可选参数）。
- P3、P4、P5、P7、P8、P9、P10：**全部按推荐**。
