# fabric 跨会话唤醒 + 唤醒已结束子 agent：架构设计（plan v3）

状态：v3（最后一轮设计）。按第二轮评审 r_XXQEHSVQ（CONDITIONAL，只覆盖第一期）修订；修订后由主会话自行核对。
作者：架构子代理 · v1 2026-10-20 16:52 · v2 17:27（评审 r_0HK1XY2S）· v3 17:53（评审 r_XXQEHSVQ）
基线：`dev` @ `56271b89`。工作区里有 external-agent 的未提交改动（§10 R7）。
锚点约定：**以符号名为准**，`~L` 行号只是截至该 rev 的提示。
修订记录：第一轮见 **§R1**，第二轮见 **§R2**。终局裁决（Q1–Q10、NQ1–NQ3、「用户拍板 r2」）见 **§11**。

> **分期（用户拍板 r2，终局）**：**第一期只做树内**（S0、F0、W1–W6）：wake 参数、因果 level、持久 park 与预约、继任 run 合并、revive、静默完成通知。**跨会话（C1）放第二期**，等第一期稳定后再开（§12 存档了 v2 的 C1 设计，第二期开工前需要复核）。正文 §3–§9 只描述第一期。

---

## 0. 需求与裁决

| #                | 内容                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U0               | 用户原话：「subagent 通过 message_agent 给其他会话发消息时，可以触发 agent loop 吗」                                                                     |
| U1（C1，第二期） | 跨会话唤醒                                                                                                                                               |
| U2（C2，第一期） | 发给已结束子 agent 的消息不再签死信，而是以这条消息作为下一轮输入 resume 它；受预算、槽位、quota/load 闸门和零挂起约束；结果投递给 owner                 |
| U3               | `wake: boolean` 由发送方模型逐条决定；`false` = 只投递（永不起 turn、永不 resume）；`true` = 唤醒；树内省略 = 旧行为（逐字节不变）；`wake:true` 是昂贵类 |
| 裁决             | 见 §11                                                                                                                                                   |

---

## 1. 背景与约束

- **零挂起**：新增的每个等待点都必须有界，所有定时器 `unref()`。
- fabric 默认关闭（`fabric.enabled:false`）。第一期的所有新行为都要求 `fabric.enabled ∧ fabric.wake.enabled`（后者默认开，Q2）。
- **第一期不新增任何不受管的主会话 run 路径**（§3.1）：受管的自治唤醒 run（RootWakeController）和会话变更栅栏都随 C1 放到第二期。
- 已搁置的 fabric-v2 §15 列出的问题在本方案中的落点：B2 → D-W4/D-W5；M8 → §3.4；I-W → §3.3；B3 → D-W8。

---

## 2. 现状（读码核实，带 seam）

### 2.1 fabric

| seam                                                                             | 事实                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/message-agent-tool.ts` `MessageAgentParams`（~L7-14）                 | `to`/`kind`/`text`，没有 `wake`                                                                                                                                                                                                                                                                                              |
| `src/service/runtime-adapter.ts` ~L747-773                                       | `message_agent` 由 adapter 注入、在**宿主进程**执行；`from` 和 generation 由宿主钉死                                                                                                                                                                                                                                         |
| `src/core/message.ts` `authorize()`（~L107-119）、`formatMessage()`（~L131-138） | 授权 = kind × relation × `can_message`；消息头带「不可信输入」                                                                                                                                                                                                                                                               |
| `src/fabric/router.ts` `admit()`（~L93-171）                                     | 发送方必须处于 running；有配额和 `rootInboxCap`；目标是否终态不影响接收                                                                                                                                                                                                                                                      |
| `src/fabric/mailbox.ts` `pump()`                                                 | ~L53 **`now - record.createdAt > record.ttlMs`**（TTL 判定）；~L59-63 目标已结束 ⇒ finding/directive 签死信，progress 丢弃；~L66 一个目标同时只有一个在途（`inFlight`）                                                                                                                                                      |
| `mailbox.ts` `rescheduleWake()` ~L200-209                                        | `if (ttlAt > now) due = …` ⇒ 结合 ~L53 的 `>`，**恰好在 `createdAt+ttlMs` 触发的唤醒不会让记录过期**，也不会再排程（F0 要修的既有缺陷）                                                                                                                                                                                      |
| `mailbox.ts` `verdict()` ~L151-186                                               | ~L154 **`if (!record \|\| record.state !== "claimed" \|\| record.claimToken !== token) return;` 在 ~L185 `inFlight.delete(target)` 之前**：一旦 record 被别人移出 `claimed`，该目标的 `inFlight` 永远不会被清除                                                                                                              |
| `mailbox.ts` `boundedSend()` ~L114-149                                           | 和 `steerMs` 赛跑；超时 ⇒ `{retryable:true, reason:"steer_timeout"}`，**但 steer 之后仍可能真正送达**                                                                                                                                                                                                                        |
| `mailbox.ts` `toVerdict()` ~L218-223                                             | `/no active session/` ⇒ `target_gone`；其他错误 ⇒ 可重试                                                                                                                                                                                                                                                                     |
| `src/delivery/engine.ts`                                                         | `put()` ~L85-93：store 抛错时**直接抛出**，内存不变。`transition()` ~L115-125 和 `annotate()` ~L139-153：**先改内存，再写 store；store 抛错只调用 `onDegraded`**（内存已经前进）。`claim()` ~L129-138：只把 `pending` 改成内存态的 `claimed`。加载时把内存态的 state 规范化为 `pending` 并去掉 `memoryOnlyFields`（~L52-56） |
| `src/adapters/pi-outbox-store.ts` `update()` ~L46-56                             | 把 patch 合并进 store **自己的缓存**（其中保存的是已持久化的状态，从来不会是 `claimed`），然后 `appendEntry` 追加整条记录 ⇒ 对处于 `claimed` 的记录做 annotate，落盘的形态是 `pending + patch`                                                                                                                               |
| `src/stack.ts` `buildFabric()` ~L494-620                                         | `readBack ? createPiOutboxStore : MemoryOutboxStore`；~L526-545 已经把 `subagent:run` 条目按 runId 折叠成 `replayed`（终态优先，否则取最新的 journal）；`ports.sendRootContext` ~L580-591 = `sendMessage(…,{deliverAs:"steer",triggerTurn:true})`                                                                            |
| `stack.ts` ~L1702 `const readBack = probeReadBackEntries(ctx)`                   | readBack 只表示「能读回条目」，**不表示落盘**（`--no-session` / `SessionManager.inMemory` 也是 readBack）                                                                                                                                                                                                                    |
| `stack.ts` ~L1077、~L1204、~L1242、~L1310、~L1384                                | 已经有多处 `sendMessage(…,{triggerTurn:false})`，没有任何栅栏（第一期 root `wake:false` 沿用同一种调用形状，§3.1）                                                                                                                                                                                                           |
| `src/fabric/mention.ts` `send()` ~L41-67                                         | `@label` 指向终态 run ⇒ 直接 `spawn({resumeFrom})`（legacy，第一期不改）                                                                                                                                                                                                                                                     |

### 2.2 run / spawn

| seam                                                                                                                                        | 事实                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/service/spawn-service.ts` ~L874                                                                                                        | `const runId = newRunId(…)`（准入期间同步执行）                                                                                                                                                                                                  |
| `spawn-service.ts` ~L957-997                                                                                                                | resume 分支：运行中 ⇒ 报错；`isLiveSessionFile(resume.sessionFile)`（~L974，`src/core/live-session-files.ts`，run-persistence D8）⇒ 报错；`resumeLocks.add(targetId)` 与 `resumeLocks.add(resume.sessionFile)`（~L986-987）；`lockKeys`（~L997） |
| `spawn-service.ts` ~L1060-1078                                                                                                              | 同步注册块：`nesting.set` → `parentOf.set` / `onSpawnEdge` → **`void start(resolvedReq, runId, …)`（~L1077）** → `return {runId}`。`start()`（~L500 起）在第一个 await 之前同步写入 `running` 和临时快照                                         |
| `spawn-service.ts` ~L810-820                                                                                                                | quota 闸门 `retryable:false`；load 闸门 `retryable:true`；所有准入错误都是 `kind:"config"`，**没有原因码**                                                                                                                                       |
| `spawn-service.ts` ~L683                                                                                                                    | `admittedModel = req.modelOverride ?? config.model`：普通 resume 不 pin 模型 ⇒ quota 检查的是类型默认模型                                                                                                                                        |
| `src/runtime/runner.ts` ~L1071 → ~L1078                                                                                                     | 先 `dispatch({kind:"phase_entered", phase:"prompt_dispatch"})`，**再同步**调用 `handle.prompt(req.prompt)`（经 `guardUntil`）。`GuardResult`（~L363）= `ok:true` / `{ok:false, reason:"timeout"                                                  | "cancelled"}`/`{ok:false, reason:"error", error}`（~L1352-1354：prompt 被拒绝） |
| `src/core/types.ts` ~L1175 `promptDispatchedAt?: Millis`、`src/core/run-journal.ts` ~L49                                                    | **字段已经定义、也在 journal 字段表里，但没有任何写入方**（评审 #2）                                                                                                                                                                             |
| `src/runtime/session-driver.ts` `mapEvent()` ~L385-400                                                                                      | 把 pi 事件映射成 `DriverEvent`（`turn_start`、`message_end` 等）；`prompt()` ~L570-574 = `session.prompt(text)`                                                                                                                                  |
| `src/core/state-machine.ts` ~L518 / ~L934                                                                                                   | 每个 driver 事件都会刷新 `lastEventAt`；`turn_start` 会写 `lastTurnStartAt`（进入某个相位时也会刷新 `lastEventAt`，所以 `lastEventAt` 不能当作「prompt 之后有没有事件」的证据）                                                                  |
| `src/service/query-service.ts` `steer()` ~L146                                                                                              | 根会话的 `steer_subagent`（`src/tools/steer-tool.ts` ~L123）、web 的 `steer_subagent` op（`web-hub/agent/commands.ts` ~L591）、TUI @mention 的 steer 都经过这里，**绕过 fabric**                                                                 |
| `src/service/runtime-adapter.ts` `notificationSuppressedRunIds`、`stack.ts` ~L1633 `sendCompletion = backgroundCompletions.createSender(…)` | 完成通知 `{triggerTurn:true}`；`createSender` 在流式期间铸 token 并广播 `BackgroundCompletion`（会中断 `ask_user`）                                                                                                                              |
| `tests/service/request-threading.test.ts` + `tests/fixtures/ff4-unclassified/spawn-request.ts`                                              | 新增的请求字段必须分类                                                                                                                                                                                                                           |

### 2.3 pi（1.2.0）

- `sendCustomMessage`：流式 ⇒ steer；空闲 + trigger ⇒ 起 run；`triggerTurn:false` 时，流式中放进内存的 `_pendingCustomMessages`，空闲时 `_appendCustomMessage`。
- `isIdle = !run && !isCompacting`（`isCompacting` 包括分支摘要）。
- custom message 在发给 provider 时会被转成 `role:"user"`。
- `SessionManager.getSessionFile()` 在内存会话中返回 `undefined`（只读 SessionManager 也暴露这个方法）。pi 会**延迟落盘**（session 文件在第一条 assistant 消息之后才写出）。
- `session.prompt()` 接受输入时，会为 prompt 的 user 消息发出 `message_end{message.role:"user"}`，并把它追加进会话。在启动 run 之前就校验失败的话，会直接 reject，并且不发 `turn_start`。这些都要由 conformance 锁定（§8 C-P1）。

---

## 3. 第一期设计

### 3.1 第一期矩阵（评审 #1：选「显式 wake:true 发给 root ≡ legacy」）

| 目标 \ wake                      | 省略（legacy）                                 | `wake:false`                                                                                                  | `wake:true`                                                                                                                                            |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| root，finding/directive          | `sendRootContext` = steer + `triggerTurn:true` | `pi.sendMessage({customType:"subagent:fabric", content, display:false, details:record}, {triggerTurn:false})` | **与 legacy 完全相同的调用**；另外计入 `perRunQuota`、过 L5 level 闸门（超限 ⇒ 改走 `wake:false` 那一列，并标记 `level_limit`）、按 L3 抬高 root level |
| root，progress                   | legacy                                         | legacy；但 context 通道改用 `triggerTurn:false`                                                               | `invalid_wake`                                                                                                                                         |
| 运行中的 run                     | steer                                          | steer                                                                                                         | steer（按 L3 传播 level）                                                                                                                              |
| `pending_start` 的 run           | 等 running                                     | 等 running                                                                                                    | 等 running                                                                                                                                             |
| 终态 run，finding/directive      | 签 `target_gone` 死信                          | park（§3.5；要求 inbox 持久能力，§3.8）                                                                       | revive（§3.4–§3.6）                                                                                                                                    |
| 终态 run，progress               | 丢弃                                           | 丢弃                                                                                                          | `invalid_wake`                                                                                                                                         |
| 终态 run，`@label`               | `mention.ts` 直接 resume                       | park                                                                                                          | revive（经 WakeService）                                                                                                                               |
| 终态 run，但同一会话链有继任 run | —                                              | 继任 run 正在启动 ⇒ 等它（§3.4）；正在运行 ⇒ redirect steer（§3.4c）                                          | 同左（合并）                                                                                                                                           |

**为什么这样选**：

- (a) `wake:true` 发给 root 就是今天已经存在的 legacy 路径，现有的 `rootInboxCap`、`rootMinIntervalMs`、`findingQuota` 继续约束它。第一期**没有新增任何不受管的主会话 run**，RootWakeController 没有必要存在；它只服务于 C1（root 被本棵树之外的会话唤醒），随 C1 放到第二期。
- (b) `wake:false` 发给 root，用的是 stack.ts 里已经在 5 处使用的 `sendMessage(…,{triggerTurn:false})` 调用形状，压缩或分支摘要期间的风险与现状属于同一类。所以第一期**不需要栅栏**；栅栏和 C1 一起放到第二期。
- (c) 省略 = legacy，逐字节不变。

### 3.2 第一期模块

| 模块                                                                                                                                                                                                 | 职责                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/fabric/wake.ts` **WakeService**                                                                                                                                                                 | 唯一的 revive 出口；inbox（park、预约、提交、释放、对账）；继任 run 合并；订阅者；结果投递  |
| `src/fabric/wake-level.ts` **CausalLevel**                                                                                                                                                           | 因果 level：run 的有效值存在 run 的 diag 里（经 reducer 输入），root 的值持久化在会话条目里 |
| 修改：`mailbox.ts`、`engine.ts`、`spawn-service.ts`、`runner.ts`、`session-driver.ts`、`state-machine.ts`、`query-service.ts`、`stack.ts`、`index.ts`、`message-agent-tool.ts`、`runtime-adapter.ts` | seam 见 §4，所有权见 §9                                                                     |

依赖方向：`message_agent` → router → mailbox → WakeService → SpawnService/QueryService；SpawnService 在同步准入阶段回调 WakeService（`InboxPort`，经 late-bound ref 注入，沿用 spawnRef 模式）。`src/core/` 只加类型、纯函数和 reducer 分支。

### 3.3 因果 level（评审 #8）

| 规则                                                                      | 第一期定义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 存储                                                                   | run 的有效 level = `diag.wakeLevel`，经新增的 reducer 输入 `{kind:"wake_level", at, level}` 更新：只在 diag 上起作用，单调取 max，所有非终态相位都接受，终态后忽略，不产生 effect。终态条目（以及顺带写出的 journal 快照）会携带**最终有效值**。root 的值：`CausalLevel.root`，持久化到 `subagent:wake-level` 条目                                                                                                                                                                          |
| L2 发送                                                                   | 由宿主盖章：`record.level = levelOf(sender)`（run ⇒ runner 状态里的 `diag.wakeLevel ?? 0`；root ⇒ `CausalLevel.root`）                                                                                                                                                                                                                                                                                                                                                                      |
| L3 投递即传播                                                             | 生效的唤醒（turn / revive）⇒ `raise(X, L+1)`；其他投递（steer、park 被带入、redirect、只投递）⇒ `raise(X, L)`                                                                                                                                                                                                                                                                                                                                                                               |
| L4 spawn 初始化（在 spawn-service ~L1077 之前的同步块里写入 `wakeLevel`） | wake revive ⇒ `max(origin.level+1, prevFinal)`，其中 `prevFinal = 被 resume 的 run 的 diag.wakeLevel ?? 0`（同一段对话里继承过往的影响）；legacy @mention resume ⇒ 同一公式，但**永远不被阻拦**；**其他所有 spawn**（Agent 工具，包括 `Agent({resume})`、RPC、`/task`）⇒ `levelOf(spawner)`（有 parentRunId 时取父 run 的 level，否则取 root），**不继承 prevFinal**。这是新的人类纪元：由 root 派出的 resume 继承的是 root 当前的 level；如果 root 刚因人类输入归零，就从 0 开始           |
| L5 闸门                                                                   | `L+1 ≤ maxLevel`（默认 2，Q9）⇒ 唤醒生效；否则降级为只投递                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L6 root 持久化                                                            | root level 变化时 `pi.appendEntry("subagent:wake-level", {v:1, level, at})`（只在开关开启时）；stack 重建时从 `ctx.sessionManager.getBranch()` 取最后一条。`/new`/resume 到别的会话 ⇒ 读那个会话自己的值                                                                                                                                                                                                                                                                                    |
| L7 只有 root 会归零                                                       | `src/index.ts` 的 `pi.on("input")` 钩子：`source ∈ {interactive, rpc}` ⇒ 归零；`source==="extension"` ⇒ 只有 web-hub 的归属端口 `webHub.attributeInput(text) === "web_prompt"` 时才归零。这个端口查的是 `commands.ts` 的账本（它在调用 `sendUserMessage` 之前就登记了 dispatched 状态的 cmdId，同步按 text 匹配，与 `onInputEvent` 用的是同一个查找）。webHub 关闭 ⇒ 端口不存在 ⇒ extension 输入一律不归零。topic-switch 回注、goal 循环、`/agent reload fire` 都不归零。**run 永远不归零** |
| seam A：mailbox 投递成功                                                  | `verdict()` 的 delivered 分支 ⇒ `level.onDelivered(record)`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| seam B：`QueryService.steer`（query-service.ts ~L146）                    | 签名扩展为 `steer(id, text, origin?: { level: number })`，成功后调用 `deps.onSteered?.(id, origin?.level ?? levelOf("root"))`。调用方：steer-tool.ts ~L123（root 工具）⇒ 不传，即 root level；commands.ts ~L591（web 人类）⇒ `{level:0}`；TUI @mention 的 steer ⇒ `{level:0}`                                                                                                                                                                                                               |
| seam C：`wake_result`                                                     | 由 system 投递给唤醒方，`level = 继任 run 终态时的 diag.wakeLevel` ⇒ `raise(waker, L)`                                                                                                                                                                                                                                                                                                                                                                                                      |
| legacy 例外                                                               | 省略 wake 的 root 唤醒和 @mention resume 永远不被阻拦，但照样参与传播                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 3.4 继任 run 所有权与合并（评审 #5、#6、#7、#9）

**(a) 登记**：spawn-service 的 `resumeLocks: Set<string>` 改为 `resumeOwners: Map<string, RunId>`，在 ~L986-987 写入 `(targetId → runId)` 和 `(sessionFile → runId)`（runId 已在 ~L874 铸造，整段同步）；释放点与今天释放 `resumeLockKeys` 的位置相同（终态、`start()` 的 catch）。对外暴露 `successorOf(sessionFile): RunId | undefined`。**所有 resume 入口**（Agent、@mention、revive、RPC、`/task`）都经过这里。

**(b) mailbox 遇到「目标已终态」**（`pump()` ~L59-63 之前插入）：`sf = query.get(to)?.diag.sessionFile`，`s = sf && successorOf(sf)`：

- `s` 处于 `pending_start` ⇒ `waitingFor.set(key, s)`（mailbox 私有的内存 Map），**不 claim、不改状态**；pump 跳过它，`rescheduleWake()` 只为它排 TTL 唤醒。
- `s` 处于 running ⇒ redirect steer（c）。
- `s` 的 running 快照 ⇒ `mailbox.drainSession(sf)`：清除该会话链的 `waitingFor`，然后 `pump()`。**只排出没有被预约的 pending 记录**（§3.6）。
- `s` 没进 running 就终态 ⇒ 清除 `waitingFor` ⇒ 回到普通处理。

**(c) redirect steer 的持久尝试所有权**（#7）：只适用于「发给已结束 run、被转给继任 run」的记录（legacy 的普通 steer 不变）。

1. 照常 `claim(key, token)`；
2. `engine.annotateStrict(key, {state:"claimed", claimToken:token}, {steerAttempt:{runId:s, at}})`；持久化失败 ⇒ 不 steer，按可重试 verdict 处理（attempts+1，走 backoff）；
3. `ports.inject(record, {target:s})`；
4. verdict：`ok` ⇒ `claimed → delivered`（普通 `transition`；如果这一步写盘失败，重启后看到的是 `pending + steerAttempt`，按 (5) 审计后 consume，结果是正确的）；`effect:"none"`（steer 的 promise 被拒绝，或 `target_gone`）⇒ 用 `annotateStrict` 清掉 `steerAttempt`，然后 `claimed → pending`，回到普通处理；`effect:"unknown"`（`steer_timeout`）⇒ `transitionStrict(claimed → consumed, {terminalReason:"steer_unverified"})` 并写审计，**不重试**；
5. 重启或 reload 后发现 `pending + steerAttempt` ⇒ 在 `reconcile()` 里 consume，`terminalReason:"steer_unverified"`。

`Verdict` 增加 `effect?: "none" | "unknown"`：`boundedSend` 的超时 ⇒ `unknown`；`sender` 的 promise 被拒绝 ⇒ `none`。legacy 的判定不读这个字段 ⇒ 不变。

**(d) 订阅者**（#6、#9）：`subscribers: Map<RunId(继任 run), { wakers: Set<NodeRef>; done: Set<NodeRef> }>`。

- **trigger 的发送方在同步准入阶段登记**：`InboxPort.onResumeAdmitted`，位于 spawn-service ~L1077 `void start` 之前，此时 run 不可能已经完成；
- 被合并进来的发送方（redirect 投递成功、且原记录是 `wake:true`）⇒ `subscribe(s, sender)`：先插入，再**同步检查** `query.get(s)` 是否已经终态；若已终态且 `done` 里没有它 ⇒ 立即投递并加入 `done`（只取一次）；
- 每个继任 run 最多 8 个订阅者；超出 ⇒ 不登记，给仍在运行的发送方发一条 system receipt：`subscriptionUnavailable: subscriber_cap`（占用死信的配额维度）；
- 继任 run 终态 ⇒ 对每个尚未投递的订阅者投递一次，然后在 10 分钟后清理这一项（unref）。

### 3.5 park、预约与线性化点（评审 #2、#3、#4、#5）

**park**：`wake:false` 的 finding/directive 发给终态 run、且没有继任 run ⇒ 保持 `pending`，在 admission 时一次写入持久字段 `parked:{at, reason:"wake_false"}`；revive 降级时，经 `claimed → pending`（普通 `transition`，带 patch）写入 `parked:{at, reason}`。每个目标最多 8 条，超出 ⇒ `target_backpressure`。inbox 持久能力为 `stack-memory` 时不可用（§3.8）。

**接受标记（#2）**，只对 `trackInput === true` 的 run 生效（由 spawn-service 在绑定了预约时设置，§4.6）：

| 标记                                         | 生产者                                                                                                                                                                                                                                         | 含义                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `diag.promptDispatchedAt`                    | reducer 在处理 `phase_entered{phase:"prompt_dispatch"}`（runner.ts ~L1071）时写入（write-once）                                                                                                                                                | 已经开始尝试。因为它同步先于 `handle.prompt()`（~L1078），**字段不存在 ⇒ prompt 从未交出** |
| `diag.inputAcceptedAt`                       | `session-driver.ts` `mapEvent`：`message_end` 且 `message.role === "user"` ⇒ 新的 `DriverEvent {t:"input_accepted"}`；runner 把它转成 reducer 输入 `input_accepted`（write-once；第一条 user 消息就是这个 prompt，因为 prompt 先于任何 steer） | 输入已被接受（已经在子会话的上下文和会话里）                                               |
| `diag.promptOutcome = "rejected_pre_accept"` | runner 在 `guardUntil` 返回 `{ok:false, reason:"error"}`（~L1078 之后）时 dispatch `prompt_rejected`；reducer 只在 `inputAcceptedAt === undefined && lastTurnStartAt === undefined` 时写入                                                     | pi 在启动 run 之前就拒绝了 ⇒ 证明没有接受                                                  |

三个字段都随终态条目持久化。`input_accepted` 不额外触发 journal（对账不需要它，见下表）。

**claim-aware 的预约操作（#3）**，新增到 `engine.ts`：

```ts
reserveStrict(key: string,
  expect: { state: "pending" } | { state: "claimed"; claimToken: string },
  reserved: { rsv: string; runId: RunId; at: Millis }, now: Millis, ttlMs: number):
  { ok: true } | { ok: false; reason: "conflict" | "expired" | "frozen" | "persist_failed" };
// 1. 冻结 ⇒ frozen；当前状态/claimToken 与 expect 不符 ⇒ conflict；now >= createdAt + ttlMs ⇒ expired（与 F0 用同一个比较）
// 2. **先持久化**：store.update(key, withoutMemoryOnly(withoutState({ reserved, updatedAt })))
//    store 自己的缓存里是已持久化的 pending ⇒ 落盘形态 = pending + reserved（已规范化）；抛错 ⇒ persist_failed，内存不动
// 3. 成功后再改内存：{ ...current, reserved, state: "pending", claimToken: undefined, updatedAt }
//    claimed 的 trigger 在内存里被规范化为 pending ⇒ 所有权从 mailbox 移交给预约
annotateStrict(key, expect, patch): 同样的 CAS 加先持久化（用于 steerAttempt、清除 reserved、quarantine 之外的场景）
transitionStrict(key, from, to, patch): 先写 store（update），成功后再改内存；失败 ⇒ persist_failed
```

**InboxPort.onResumeAdmitted**（spawn-service ~L1077 `void start` 之前，同步执行，**不读任何文件**，#4）：

```ts
onResumeAdmitted(a: { runId: RunId; sessionFile: string; trigger?: { key: MessageKey; claimToken: string; sender: NodeRef } }):
  { block?: string; trackInput: boolean; persistFailed?: true };
```

1. 选出候选：trigger（如果有）加上该会话链里所有 `parked` 且未过期的记录（按 createdAt 排序，最多 8 条）。会话链 = `to` 的 `diag.sessionFile === sessionFile` 的记录；
2. 逐个 `reserveStrict`（`rsv = newRunId()`）。`expired` ⇒ 跳过（交给 TTL 路径），`conflict` ⇒ 跳过；
3. 某个 `persist_failed` ⇒ 用 `annotateStrict` 回滚已经预约的那些（清除 `reserved`）；**回滚本身也失败 ⇒ quarantine**：给这条记录打上内存字段 `quarantined:true`（加入 `memoryOnlyFields`），它将不可投递，由 §3.6 的处置清扫按审计后 consume（`reservation_quarantined`）；下一个 stack 的 `reconcile()` 会看到一条绑定到「不存在的 run」的预约 ⇒ 按含糊处理并 consume（与 NQ2 一致）；
4. 返回值：
   - 有 trigger 且 trigger 预约失败 ⇒ `{persistFailed:true}` ⇒ spawn-service 以 `AdmissionReason "inbox_persist_failed"` 拒绝准入（同步释放 `resumeOwners`，与今天的错误路径相同）；
   - 没有 trigger（普通 `Agent({resume})`）⇒ **永远不让人类的 resume 失败**：预约失败的消息不放进 block；
   - 否则 ⇒ `{block, trackInput:true}`，spawn-service 设置 `resolvedReq.prompt = req.prompt + "\n\n" + block`、`resolvedReq.trackInput = true`。

block 的格式：`[fabric inbox n=<k>] 不可信输入: 以下是你结束期间收到的消息……`，后面每条消息一行头部加原文（转义规则见 §4.9）。普通 `Agent({resume})` 也会预约，**不需要捏造 `wakeOrigin`**（只设 `trackInput`）。

**mailbox 的所有权移交（#3）**：revive 路径上，`ports.revive(record)` 同步进入 spawn 的准入代码（`spawn()` 在第一个 await 之前跑完整个准入并调用 `onResumeAdmitted`），所以在 `boundedSend` 拿到 promise 时，「是否已经预约」已经确定，`steerMs` 计时器不可能插进中间。`verdict()` 改为（替换 ~L154 的早退）：

```ts
const owned = record?.state === "claimed" && record.claimToken === token;
if (!owned) {
  // 所有权已经移交（预约）或者被别人终结
  if (this.inFlight.get(target) === key) {
    this.inFlight.delete(target);
    this.pump(target);
  }
  return; // reserved 记录不可投递 ⇒ 不会出现重泵自旋
}
```

`inFlight` 从 `Map<NodeRef, string>` 中只按**同一个 key** 清除（身份校验）。

**处置表**（线性化点 = `inputAcceptedAt`）：

| 绑定的 run R 的证据                                          | 实时（`WakeService.onSnapshot`）                                                                                 | 对账（`reconcile()`，buildFabric 中 hydrate 之后、第一次 pump 之前）                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R 的快照出现 `inputAcceptedAt`（运行中也算）                 | **立即提交**：`transitionStrict(pending → consumed, {terminalReason:"resume_injected", revivedAs:R})`            | R 的终态条目里有 ⇒ 提交                                                                                                                                                                                                                                                                 |
| R 终态，没有 `promptDispatchedAt`                            | 释放：`annotateStrict` 清除 `reserved`；trigger 回到可投递的 pending（`wake:true` 不变），park 记录重新成为 park | 同左（终态条目 = R 已经物理结束，不会再有人写，满足 #5）                                                                                                                                                                                                                                |
| R 终态，`promptOutcome === "rejected_pre_accept"`            | 释放                                                                                                             | 同左                                                                                                                                                                                                                                                                                    |
| R 终态，其他情况（已尝试但没有接受：超时、取消、卡住后被杀） | 含糊 ⇒ 审计后 consume：`resume_unverified`（NQ2）                                                                | 同左                                                                                                                                                                                                                                                                                    |
| R 没有终态条目（只有 journal，或什么都没有）                 | —                                                                                                                | `isLiveSessionFile(sessionFile)` ⇒ 前一个 stack 还在关闭它：**暂缓**（保持 reserved，不可投递），在 R 的 `onReaped`（runner.ts ~L1243 的回调经 stack 转发）或 60s 安全超时（unref）时，用一次新的 `getBranch()` 重新判定；仍然没有终态 ⇒ 含糊并 consume。不是 live ⇒ 立即按含糊 consume |
| 写盘失败                                                     | 提交/释放用的都是 strict 操作；失败 ⇒ 内存不动，记录保持 reserved，由下一次快照或 `reconcile()` 收敛             |                                                                                                                                                                                                                                                                                         |

**第一期不做任何文件内容扫描，也不做「读到文件末尾仍没有标记 ⇒ 证明未投递」的推断**（#4、#5）：只有终态条目能证明「没有交付」；其余一律按 NQ2 处理。

### 3.6 预约记录的优先级、TTL 与处置清扫（评审 #6）

- `pump()` 每次开始时先调用 `wake.sweep(now, 32)`：为「绑定的 run 已经终态但还没处理」或「超过预约硬上限」的 reserved/quarantined 记录做处置。硬上限 = R 在 registry 里时取 `R.deadlines.hardDeadlineAt + budget.reapMs + 60s`，否则取 `reserved.at + 24h`；超过 ⇒ 审计后 consume（`reservation_expired`）。每次最多处理 32 条，剩下的排到下一次唤醒（加入 `rescheduleWake` 的唤醒源）。
- 候选循环中：`reserved` / `quarantined` ⇒ **在 TTL 判定之前** `continue`（TTL 永远不对进行中或含糊的预约下结论）；`parked` / `waitingFor` / `steerAttempt` 记录 ⇒ 只做 TTL 判定。
- `drainSession` 只排出没有 `reserved` 的 pending 记录。
- 同一时刻：`reserveStrict` 用 `now >= createdAt + ttlMs` 判断过期 ⇒ 恰好在过期时刻的记录**不会被预约**，走 TTL 死信（测试）。

### 3.7 revive 与完成结果的投递

**revive**（`WakeService.revive(record)`，mailbox 的端口，第一个 await 之前全部同步）：

1. `successorOf` 已存在 ⇒ 不会走到这里（§3.4b）；防御性返回 `{park:"resume_in_progress"}`；
2. 可唤醒性（§4.5）⇒ 不可唤醒 ⇒ `{refuse}` ⇒ `wake_refused` 死信；
3. 频率上限（`resumesPerHour`、`resumesPerTargetPerHour`、发送方的 `perRunQuota`）和 L5 ⇒ `{park:<reason>}`；
4. `spawn({type, label(repoint), prompt: 带横幅的 trigger 文本, resumeFrom: target, modelOverride: diag.model, thinkingOverride: diag.thinkingLevel, wakeOrigin: {by, key, level, via:"fabric", trigger:{key, claimToken}}, poolFullPolicy:"reject", loadPolicy:"reject", timeoutPolicy:"fixed", budgetOverride: {totalMs: clampSpanMs(resumeBudgetS*1000)}})`。`resumeBudgetS` 在设置解析时限定在 60–3600；
5. 结果：成功 ⇒ `{ok:true, runId}`（trigger 已被预约）；`error.reason` 按 §4.6 的表映射。

**owner 通知（Q3、#16）**：revive 出来的 run 是 root 直属、不带 `suppressDelivery` 的普通 run；`wakeOrigin` 存在 ⇒ `DeliveryPayload.quiet = true`。`stack.ts` 的完成通知 sink（~L1795-1830）对 quiet 条目**绕过 `sendCompletion`（createSender）**，直接调用 `pi.sendMessage(msg, {triggerTurn:false})`：不铸 token、不广播、不中断 `ask_user`。digest 里混有 quiet 和非 quiet 条目时，拆成两次发送。

**订阅者**：§3.4d；投递内容 = system → waker 的 `result` 记录（`route:{kind:"wake_result", runId}`，最多 maxChars，走 steer，按 L3 用继任 run 的 level 传播）。订阅者是 root ⇒ owner 通知已经覆盖，不重复投递；订阅者已结束 ⇒ 跳过，**不会唤醒它，也不会 revive 它**。

### 3.8 inbox 持久能力（评审 #10）

在 `buildFabric` 中计算：`durability = !readBack ? "stack-memory" : typeof ctx.sessionManager.getSessionFile?.() === "string" ? "disk" : "session-memory"`。

| 能力                                                           | park / 预约                                                                                                                                                               | 语义                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `disk`                                                         | 可用                                                                                                                                                                      | 受 pi 延迟落盘的约束：第一条 assistant 消息之前追加的条目，在崩溃时可能丢失（与会话本身同命运） |
| `session-memory`（`--no-session` / `SessionManager.inMemory`） | 可用；结果里带 `inboxDurability:"session-memory"`                                                                                                                         | 能撑过 `/reload`（条目保存在 SessionManager 里），进程退出即丢失，与会话本身同命运              |
| `stack-memory`（readBack=false）                               | **不可用**：`wake:false` 发给终态 run ⇒ 按 legacy 签 `target_gone` 死信，结果里带 `parkUnavailable:"stack_memory"`；revive 仍然可用（预约只在内存里保证本进程内的正确性） |                                                                                                 |

root level 条目（L6）只在 `disk` / `session-memory` 时写入。

### 3.9 关闭状态与 golden（评审 #11）

`wakeOn = settings.fabric.enabled && settings.fabric.wake.enabled`，在 stack 构建时读取一次，并传给 runtime-adapter（schema）、spawn-service（`deps.inbox`）、mailbox（`ports.revive`）、CausalLevel（是否装配）。

`wakeOn === false` 时：

- 不构建 WakeService；`deps.inbox` 不存在 ⇒ 不写 `wakeExclusion`/`wakeLevel`/`trackInput`；
- runner 只在 `spec.request.trackInput` 时 dispatch `input_accepted`/`prompt_rejected`，reducer 也只在这个标志下写 `promptDispatchedAt` ⇒ 所有 run 的条目与今天逐字节相同；
- 不写 `subagent:wake-level` 条目、不注册 `input` 钩子（钩子本身在 activate 时注册一次，handler 内首先检查 `holder.current?.wake`）；
- `message_agent` schema 是今天的实例；不设 `FabricPorts.revive`。

**唯一有意的行为变化**：F0 的 TTL 比较对所有 fabric 记录生效（修复既有缺陷）。

golden（S0 在任何行为改动之前，从当前 dev 上采集）：`tests/fixtures/fabric-wake-off-golden.json`，包含 wake 关闭时以下三种 run 的终态条目，以及 `message_agent` 的 schema：

- (a) 成功的 run；
- (b) 准入被拒绝的 run（只有错误，没有条目，断言没有条目）；
- (c) `startup_failed` 的 run。

---

## 4. 接口契约（第一期）

### 4.1 类型（`src/core/types.ts`、`src/core/message.ts`）

```ts
interface SpawnRequest { wakeOrigin?: WakeOrigin }          // 只有程序能写；request-threading：不透传进 child
interface WakeOrigin { by: NodeRef; key: MessageKey; level: number; via: "fabric";
                       trigger?: { key: MessageKey; claimToken: string } }
interface ResolvedSpawnRequest { trackInput?: true }          // spawn-service 内部字段；分类：runner-only
interface RunDiagnostics {
  wakeOrigin?: WakeOrigin;                                    // write-once（持久化时去掉 trigger.claimToken）
  wakeLevel?: number;                                         // 有效值，单调（reducer 输入 wake_level）
  wakeExclusion?: WakeExclusion | "none";                     // admission 时 write-once（仅 wakeOn）
  inputAcceptedAt?: Millis;                                   // write-once（仅 trackInput）
  promptOutcome?: "rejected_pre_accept";                      // write-once（仅 trackInput）
  // promptDispatchedAt?: 已存在；从这一版起有写入方（仅 trackInput）
}
interface ErrorInfo { reason?: AdmissionReason }
type AdmissionReason = "pool_full" | "load" | "quota" | "resume_locked" | "session_closing" | "target_running"
  | "stack_closed" | "unknown_type" | "external_unavailable" | "inbox_persist_failed" | "config";
type DriverEvent = … | { t: "input_accepted" };
// reducer 输入：{kind:"wake_level", at, level} | {kind:"input_accepted", at} | {kind:"prompt_rejected", at}
interface MessageEnvelope { wake?: boolean; level?: number; route?: { kind: "wake_result"; runId: RunId } }
interface FabricRecord {
  parked?: { at: Millis; reason: "wake_false" | WakeDowngrade };
  reserved?: { rsv: string; runId: RunId; at: Millis };
  steerAttempt?: { runId: RunId; at: Millis };
  quarantined?: true;                                         // memoryOnlyFields
  revivedAs?: RunId;
  deadLetter?: { reason: "ttl_expired" | "target_gone" | "attempts_exhausted" | "wake_refused"; … };
}
interface DeliveryPayload { quiet?: true }
```

`authorize()`：`route.kind === "wake_result"` ⇒ 只允许 `kind === "result" && from === "system"`。**转移表不变**：所有新状态都用 strict annotate/CAS 表达，**不加自转移边**。

### 4.2 `message_agent`（W1）

`messageAgentParams({ wake: wakeOn })`：`false` ⇒ 返回今天的 `MessageAgentParams` 实例（golden）。`true` ⇒ 追加可选的 `wake: Boolean`，描述写明：省略 ⇒ 旧行为；`false` ⇒ 只投递；`true` ⇒ 唤醒（很贵）；progress 永不唤醒。结果追加 `wake?`、`wakeDowngraded?`、`parkUnavailable?`、`inboxDurability?`；新增 `{ok:false,status:"invalid_wake"}`，以及 `{ok:false,status:"not_wakeable",reason}`（只在同步预检就能确定时返回）。

### 4.3 mailbox 修改清单

| seam                       | 修改                                                                                                                                                  | 包                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| ~L53                       | `now >= record.createdAt + record.ttlMs`                                                                                                              | F0                                       |
| ~L48-50 候选循环开头       | 先 `wake?.sweep(now, 32)`；reserved/quarantined ⇒ 在 TTL 之前 `continue`                                                                              | W3                                       |
| ~L59-63 目标已结束         | 先查 `successorOf` ⇒ waitingFor / redirect；然后 `wake:true` ⇒ `ports.revive`；`wake:false` / 已 park ⇒ 跳过（stack-memory 时按 legacy）；legacy 不变 | W4（继任）、W5（revive）                 |
| ~L114-149 `boundedSend`    | 超时 ⇒ `effect:"unknown"`；promise 被拒绝 ⇒ `effect:"none"`                                                                                           | W4                                       |
| ~L151-186 `verdict()`      | §3.5 的 owned 检查加身份校验后的 `inFlight` 清理；redirect 与 steerAttempt 处理（§3.4c）；delivered ⇒ `level.onDelivered`                             | W3（owned）、W4（redirect）、W1（level） |
| ~L189-216 `rescheduleWake` | waitingFor/parked 只排 TTL；sweep 的待办作为唤醒源                                                                                                    | W3/W4                                    |
| 新增 `drainSession(sf)`    | §3.4b                                                                                                                                                 | W4                                       |

### 4.4 WakeService（`src/fabric/wake.ts`）

```ts
export interface WakeServiceDeps {
  spawn(): Pick<SpawnService, "spawn" | "successorOf"> | undefined;
  query(): Pick<QueryService, "get"> | undefined;
  steer(runId: RunId, text: string): Promise<void>; // 窄端口
  engine: Pick<
    DeliveryEngine<FabricRecord, FabricRecord["state"]>,
    "select" | "get" | "transition" | "reserveStrict" | "annotateStrict" | "transitionStrict"
  >;
  router: Pick<FabricRouter, "admitSystem">; // 只接受 route.kind === "wake_result"
  level: CausalLevel;
  settings(): FabricWakeSettings;
  durability: "disk" | "session-memory" | "stack-memory";
  isLiveSessionFile(path: string): boolean;
  runEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>; // getBranch()，只在 reconcile 暂缓重判时调用
  now(): number;
  setTimer: Clock["setTimer"]; // unref
}
export interface WakeService extends InboxPort {
  preflight(target: RunId): { ok: true } | { ok: false; reason: WakeExclusion };
  revive(record: FabricRecord): Promise<ReviveVerdict>;
  onSnapshot(s: RunSnapshot): void; // 接受即提交 / 终态处置 / 订阅者投递 / 释放所有权
  onReaped(runId: RunId): void; // reconcile 暂缓的重判
  sweep(now: number, max: number): void;
  reconcile(): void;
  subscribe(successor: RunId, waker: NodeRef): "ok" | "cap";
  stats(): { resumesLastHour: number; parked: number; reserved: number; quarantined: number; unverified: number };
}
type ReviveVerdict = { ok: true; runId: RunId } | { park: WakeDowngrade } | { refuse: WakeExclusion };
```

### 4.5 可唤醒性（评审 #10 已在 v2 解决，v3 只加开关门控）

`wakeExclusion` 在 admission 时写入（仅 wakeOn）：`forkSessionFrom` ⇒ `consult_fork`；`toolDomain:"readonly"` ⇒ `readonly_domain`；`suppressDelivery || expectAck` ⇒ `caller_owned`；外部 provider ⇒ `external_agent`（Q4）；其余 ⇒ `"none"`。

revive 时依次检查：

- 字段缺失 ⇒ `legacy_unknown`（失败关闭；park 仍然允许）；
- 没有 sessionFile ⇒ `no_session`；
- worktree 不是 `kept` 或路径已不存在（同步 `existsSync`，单个路径）⇒ `worktree_gone`；
- agent type 已不存在 ⇒ `unknown_type`；
- `stopCause` 由用户发起 ⇒ `user_aborted`（Q6）。

### 4.6 SpawnService（S0 加字段，W3/W5 加行为）

| seam                             | 修改                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每个 `return {error}` 准入分支   | 加上 `reason`（S0；不改变行为）。映射：pool-full 分支 ⇒ `pool_full`；load ⇒ `load`；quota（~L810）⇒ `quota`；resume lock ⇒ `resume_locked`；`isLiveSessionFile` ⇒ `session_closing`；运行中 ⇒ `target_running`；未知 type ⇒ `unknown_type`；外部 provider 不可用 ⇒ `external_unavailable`；其他 ⇒ `config` |
| ~L986-997                        | `resumeOwners`（S0）                                                                                                                                                                                                                                                                                       |
| ~L1060-1077（`void start` 之前） | `wakeLevel`/`wakeExclusion` 写入（W1/W5）；`deps.inbox?.onResumeAdmitted(…)`（W3）；结果 `persistFailed` ⇒ 返回 `{error:{kind:"config", reason:"inbox_persist_failed", retryable:true}}`，并走与今天相同的锁释放路径                                                                                       |
| `start()` 的 catch（~L573-590）  | `deps.inbox?.onRunGone(runId)`（runner 抛错且没有快照时释放预约）（W3）                                                                                                                                                                                                                                    |

revive 对 `AdmissionReason` 的映射（W5）：

| 原因                                                             | revive 的处理                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `pool_full`、`load`、`quota`、`session_closing`、`resume_locked` | park                                                           |
| `inbox_persist_failed`                                           | 可重试 verdict（attempts+1，最终签 `attempts_exhausted` 死信） |
| `target_running`                                                 | 按继任 run 处理                                                |
| `stack_closed`                                                   | 保持 pending                                                   |
| `unknown_type`、`external_unavailable`、`config`                 | `wake_refused` 死信                                            |

### 4.7 runner / driver / reducer（W1、W2）

| seam                           | 修改                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-driver.ts` `mapEvent` | `message_end` 且 `e.message?.role === "user"` ⇒ 额外产出 `{t:"input_accepted"}`（与既有的 message_end 映射并存）                                                                                                                                                                                                                     |
| `runner.ts` 事件转发           | `input_accepted` ⇒ 只在 `spec.request.trackInput` 时 dispatch reducer 输入 `input_accepted`                                                                                                                                                                                                                                          |
| `runner.ts` ~L1078 之后        | `!prompted.ok && prompted.reason === "error" && spec.request.trackInput` ⇒ 在既有的错误处理之前 dispatch `prompt_rejected`                                                                                                                                                                                                           |
| `state-machine.ts`             | `phase_entered{prompt_dispatch}` ⇒ 若 `state.trackInput`（在 `createInitialState` 时从请求复制）则写 `promptDispatchedAt`；`input_accepted` ⇒ write-once `inputAcceptedAt`；`prompt_rejected` ⇒ 条件写 `promptOutcome`；`wake_level` ⇒ `wakeLevel = max(...)`。都是只改 diag 的输入，所有非终态相位都接受，终态时忽略，不产生 effect |
| `runner.ts` 新方法             | `noteWakeLevel(runId, level)` ⇒ dispatch `wake_level`（CausalLevel 使用）                                                                                                                                                                                                                                                            |
| tests                          | state-machine 的转移矩阵和 seeded property 测试与新输入同步更新（AGENTS.md 硬要求）                                                                                                                                                                                                                                                  |

### 4.8 设置（第一期）

```jsonc
"fabric": { "wake": {
  "enabled": true,               // Q2；仅在 fabric.enabled 时生效；stack 构建时读取
  "maxLevel": 2,                 // Q9
  "perRunQuota": 3,
  "resumeBudgetS": 600,          // 解析时限定在 60..3600
  "resumesPerHour": 6,
  "resumesPerTargetPerHour": 2,
  "parkCapPerTarget": 8
} }
```

`rootRunMaxS` 和 `crossSession.*` 都属于第二期，S0 不解析它们。

### 4.9 消息格式

park block、revive 横幅和 `wake_result` 都使用 v2 §4.11（§12.4 存档）的转义规则：元数据一律 `JSON.stringify` 并截断到 64 字符；正文放在宿主生成的 nonce 边界线之间，正文里出现的 `<<<fab-` 先替换掉。理由已经更正：custom 消息在发给 provider 时是 user 角色，格式化**不是**信任边界。

---

## 5. 关键决策（第一期，v3 增删）

| ID    | 决策                                                                                                                   | 理由与备选方案                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-W1  | `wake` 可选，省略 = legacy                                                                                             | —                                                                                                                                                            |
| D-W2  | `wake:false` 发给终态 run ⇒ park，持久性随会话                                                                         | —                                                                                                                                                            |
| D-W3  | 可唤醒性在 admission 时写入；旧条目失败关闭                                                                            | —                                                                                                                                                            |
| D-W4  | revive：root 直属、pin 模型和 thinking、fixed 预算（秒数 ×1000 后 clamp）                                              | —                                                                                                                                                            |
| D-W5  | owner 静默通知，绕过 createSender；订阅者各收到一次                                                                    | —                                                                                                                                                            |
| D-W6  | 继任 run 所有权在所有 resume 准入时同步登记；waitingFor 标记；只排出未预约的记录                                       | —                                                                                                                                                            |
| D-W7  | 因果 level 存在 run 的 diag 里（reducer 输入）；root 持久化；只有 root 归零；steer 的 seam 在 QueryService             | 另起一个独立 Map：stack 重建后会丢失，也无法随终态条目持久化                                                                                                 |
| D-W9′ | **线性化点 = `inputAcceptedAt`**；区分「已尝试」和「已接受」；对账**不读文件**；只有终态条目能证明「未交付」           | v2 依赖一个没有写入方的 `promptDispatchedAt`，还要同步扫描文件（会阻塞 event loop），而且「读到文件末尾没有标记」并不能证明未交付（前一个 stack 可能还在写） |
| D-W11 | 一个 claim-aware 的 `reserveStrict`（CAS + 先持久化 + 规范化），所有权移交时按身份清理 inFlight，回滚失败就 quarantine | 普通 `transition` 无法进入内存态的 `claimed`，而且会先改内存再吞掉写盘错误                                                                                   |
| D-W12 | redirect steer 有持久的尝试所有权；超时或重启后按 NQ2 consume                                                          | steer 超时之后仍可能送达；legacy 的重试路径对这类记录会造成重复                                                                                              |
| D-W13 | 第一期显式 `wake:true` 发给 root ≡ legacy；`wake:false` 发给 root 用无栅栏的 `triggerTurn:false`                       | 引入 RootWakeController 或栅栏，会在第一期新增风险面，而第一期并不需要它们                                                                                   |
| D-W8  | progress 永不唤醒，也永不 park                                                                                         | —                                                                                                                                                            |

---

## 6. 零挂起与安全（第一期）

| 等待点            | 上界                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| revive            | `boundedSend`（steerMs）；准入是同步的                                                 |
| waitingFor        | 继任 run 的 queueWait 加 startup 上界；记录本身受 TTL 约束（F0 修复后 TTL 一定会触发） |
| 预约              | 绑定的 run 有 hardDeadline；处置清扫有硬上限，每次最多 32 条                           |
| reconcile 暂缓    | 60s 安全超时（unref）                                                                  |
| revive 出来的 run | fixed 600s，外加全套 watchdog                                                          |
| 主会话            | 第一期不新增任何主会话 run 路径                                                        |

**同步 I/O**：准入阶段没有新的文件读取；`worktree_gone` 只做一次 `existsSync`。reconcile 只遍历内存里的条目，暂缓重判时调用一次 `getBranch()`（内存读）。

**提示注入**：§4.9。**防风暴**：level、配额、频率上限（v2 §6.3）。

---

## 7. 可观测性（第一期）

- `/agent status`：`wake on · lvl≤2 · root L1 · resumes 2/6h · parked 3 · reserved 0 · unverified 1 · quarantined 0 · durability disk`。
- `get_subagent_result`：`Woken by <label> (level n)`、`+N inbox messages`。
- 审计：每次 `resume_unverified`、`steer_unverified`、`reservation_expired`、`reservation_quarantined` 都写一条 `console.warn("[pi-subagent] fabric inbox …")`（不含正文），并计入 stats。

---

## 8. 测试（第一期；包号见 §9）

| 包                  | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0                  | `transitionStrict`/`annotateStrict`/`reserveStrict`：store 抛错 ⇒ 内存不动；CAS 冲突；claimed 被规范化；落盘形态不含 `claimToken`/`quarantined`。request-threading 对 `wakeOrigin`/`trackInput` 的分类。diag 新字段经 journal、tombstone、终态重建的往返。`AdmissionReason` 表（每个分支一条）。采集 wake 关闭时的 golden                                                                                                                                                                                                                                   |
| F0                  | FakeClock：恰好在 `createdAt+ttlMs` 时过期；在 `ttlAt` 触发的唤醒能让记录过期；同一时刻的预约被拒绝（`expired`）                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| W1                  | schema golden（关闭/开启）；`invalid_wake`；root 矩阵三列；level：autonomous root（L1）用 `steer_subagent` ⇒ 子 run ≥1；web 的 steer op 不抬高；`wake_result` 把唤醒方抬高到继任 run 的 level；revive 的 `max(origin+1, prevFinal)`；人类 `Agent({resume})` 在人类输入之后为 0；终态条目携带最终有效 level；reload 恢复 root level；topic-switch 回注、goal 不归零；web prompt 归零。state-machine 矩阵/property 与 `wake_level` 同步                                                                                                                       |
| W2                  | reducer：`promptDispatchedAt`、`inputAcceptedAt`、`rejected_pre_accept` 的条件写入；`trackInput=false` ⇒ 一个字段都不写。runner：**同步拒绝**（prompt reject，没有 turn_start ⇒ `rejected_pre_accept`）；**延迟接受**（接受事件在长时间创建之后才到 ⇒ 照样写入）；**接受后失败**（接受后模型报错 ⇒ `inputAcceptedAt` 存在，状态 failed）；超时或取消且未接受 ⇒ 不写这两个字段。conformance 草案 C-P1（真实 pi：resume prompt 产生 `message_end{role:user}`；模型无效 ⇒ reject 且没有 turn_start）                                                           |
| W3                  | park（上限、TTL、stack-memory 时不可用、session-memory 时的提示）；`onResumeAdmitted`：trigger 处于 claimed ⇒ 规范化；部分持久化失败 ⇒ 回滚；回滚失败 ⇒ quarantine 并按审计 consume；`verdict()` 在所有权移交后清理 inFlight（身份校验，没有自旋）；处置表的每一行（实时和对账）；**崩溃窗口**：①预约后、start 前崩溃 ⇒ 对账时没有条目 ⇒ 含糊并 consume；②接受后崩溃 ⇒ 没有终态条目 ⇒ consume；③终态条目且没有 `promptDispatchedAt` ⇒ 释放；④`isLiveSessionFile` ⇒ 暂缓，`onReaped` 后再判；⑤60s 超时。普通 `Agent({resume})` 带走 park 消息（integration） |
| W4                  | waitingFor：不可投递；FakeClock 推进后 microtask 在有限步内排空；TTL 仍然触发；继任 run 进入 running ⇒ 排出（不包括 reserved）；继任 run 没进 running 就失败 ⇒ 回到普通处理；**redirect steer 在超时之后才送达 ⇒ 只有一份，审计 consume**；**在 steer 被接受之后、verdict 写盘之前 reload ⇒ 审计 consume，不再 steer**；steer 被拒绝（`effect:"none"`）⇒ 回到 pending；手动 `Agent({resume})` 启动期间到达的消息被送进继任 run                                                                                                                              |
| W5                  | 可唤醒性矩阵（包括 `legacy_unknown`）；`AdmissionReason` 映射表的每一行；模型 pin（quota 闸门看到的是会话模型）；`resumeBudgetS` 被换算成绝对截止时间（`deadlineAt === enqueuedAt + 600_000`）；频率上限；端到端 revive（integration）                                                                                                                                                                                                                                                                                                                      |
| W6                  | 静默通知：TUI/RPC 上有正在进行的 `ask_user` 提问时，不铸 token、不广播、不中断；混合 digest 被拆开；订阅者：**两个发送方合并**，各收到一次；**快速完成**（继任 run 在第二个发送方订阅之前就终态 ⇒ 同步检查后立即投递一次）；第 9 个订阅者 ⇒ `subscriptionUnavailable` receipt                                                                                                                                                                                                                                                                               |
| G（第一期终局闸门） | 见 §9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

conformance（新文件 `tests/conformance/fabric-wake.test.ts`，并入 `npm run test:conformance`）：C-P1 接受标记；C-P2 rejected-pre-accept；C-P3 静默完成通知不起 turn（真实 pi，流式和空闲各一次）；C-P4 `message_agent` schema 关闭/开启的 golden；C-P5 **真实内存会话**（`SessionManager.inMemory`）：`durability === "session-memory"`，park 在 stack 重建后仍在，并带有 `inboxDurability` 提示。

---

## 9. 第一期工作包（每包 ≤1 天）

**文件所有权**（同一时间一个包；箭头表示顺序）：

| 文件                                                                                                                                                                  | 包                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/core/types.ts`、`src/config/settings.ts`、`src/delivery/engine.ts`、`tests/fixtures/fabric-wake-off-golden.json`                                                 | S0                                                 |
| `src/fabric/mailbox.ts`                                                                                                                                               | F0 → W1（delivered 时的 level 钩子）→ W3 → W4 → W5 |
| `src/service/spawn-service.ts`                                                                                                                                        | S0 → W1（wakeLevel 写入）→ W3 → W5                 |
| `src/core/state-machine.ts` + 矩阵/property 测试                                                                                                                      | W1 → W2                                            |
| `src/runtime/runner.ts`                                                                                                                                               | W1（`noteWakeLevel`）→ W2                          |
| `src/runtime/session-driver.ts`                                                                                                                                       | W2                                                 |
| `src/service/query-service.ts`、`src/tools/steer-tool.ts`、`src/web-hub/agent/commands.ts`（只改 steer 的 origin 参数）、`src/web-hub/agent/index.ts`（只加归属端口） | W1                                                 |
| `src/index.ts`                                                                                                                                                        | W1（`input` 钩子）                                 |
| `src/tools/message-agent-tool.ts`、`src/service/runtime-adapter.ts`、`src/core/message.ts`                                                                            | W1                                                 |
| `src/fabric/wake.ts`                                                                                                                                                  | W3 → W4 → W5 → W6                                  |
| `src/stack.ts`                                                                                                                                                        | W1 → W3 → W4 → W5 → W6（每个包只加装配代码）       |
| `tests/integration/fabric-wake.test.ts`                                                                                                                               | W3 起逐包追加                                      |
| `tests/conformance/fabric-wake.test.ts`                                                                                                                               | W2（C-P1/2 草案）→ W6（C-P3）→ G（C-P4/5）         |

| 包                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                  | 依赖                                       | 闸门（每包都要求：typecheck、format:check、全量 `npm test` 通过）             | 估时 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- | ---- |
| **S0**               | 第一期契约：`fabric.wake` 设置；§4.1 的所有类型；`AdmissionReason` 标注（不改行为）；`resumeOwners`/`successorOf`（不改行为）；engine 三个 strict 操作；request-threading 分类；**先采集** wake 关闭时的 golden                                                                                                                                                                                                       | —                                          | §8 S0 一行                                                                    | 1d   |
| **F0**               | TTL 比较修复                                                                                                                                                                                                                                                                                                                                                                                                          | —                                          | §8 F0 一行；在 CHANGELOG 用的 commit message 里写明这是唯一的关闭状态行为变化 | 0.5d |
| **W1**               | wake 参数、root 矩阵、CausalLevel（reducer `wake_level`、runner `noteWakeLevel`、root 条目、`input` 钩子、web 归属端口、QueryService steer seam、mailbox delivered 钩子）                                                                                                                                                                                                                                             | S0, F0                                     | §8 W1 一行，包括 state-machine 矩阵/property 同步更新；golden 未变            | 1d   |
| **W2**               | 接受标记（driver `input_accepted`、runner `prompt_rejected`、reducer 三个字段，`trackInput` 门控）                                                                                                                                                                                                                                                                                                                    | W1（state-machine 和 runner 的所有权顺序） | §8 W2 一行；C-P1/C-P2 conformance 通过                                        | 1d   |
| **W3**               | park、`onResumeAdmitted` 预约、mailbox 所有权移交、处置（实时和对账）、sweep、quarantine、持久能力                                                                                                                                                                                                                                                                                                                    | W2                                         | §8 W3 一行，包括五个崩溃窗口                                                  | 1d   |
| **W4**               | 继任 run：waitingFor、`drainSession`、redirect steer 与 steerAttempt、`effect` 字段                                                                                                                                                                                                                                                                                                                                   | W3                                         | §8 W4 一行                                                                    | 1d   |
| **W5**               | revive：可唤醒性、准入原因映射、模型 pin、预算 ×1000、频率上限、预检、trigger 在准入时订阅                                                                                                                                                                                                                                                                                                                            | W4                                         | §8 W5 一行；integration 端到端                                                | 1d   |
| **W6**               | 静默通知路径、`wake_result`（带 level 传播）、合并订阅者与快速完成、上限 receipt、`/agent status` 与 `get_subagent_result` 文本                                                                                                                                                                                                                                                                                       | W5                                         | §8 W6 一行；C-P3                                                              | 1d   |
| **G 第一期终局闸门** | `npm run format:check && npm run typecheck && npm run build && npm test`；`tests/integration/fabric-wake.test.ts` 全套（崩溃窗口、两个发送方、恰好到期、park → `Agent({resume})`、端到端 revive、静默 + ask_user）；`npm run test:conformance`（C-P1…C-P5 全部，加上既有的 consult-preserve C1–C7 不回归）；state-machine 矩阵/property 与新增的三个输入同步；wake 关闭 golden 逐字节相同；AGENTS.md 的 fabric 段更新 | W6                                         | 全部通过才算第一期完成                                                        | 0.5d |

**并行**：S0 ∥ F0 → W1 → W2 → W3 → W4 → W5 → W6 → G。因为 mailbox、spawn-service、state-machine、stack 的所有权是串行的，第一期基本是一条串行链，关键路径约 8 天。能并行的只有 S0 ∥ F0，以及每个包内部「测试编写 ∥ 实现」。

**第二期（开工前另行复核）**：S0b（`crossSession` 设置、`CanMessage:"session"`、`list_sessions` 的 reserved 与影子工具）、R1（RootWakeController + 栅栏）、X1–X5、T1/T2，见 §12。

---

## 10. 风险（第一期）

| #   | 风险                                                                                                                    | 处置                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R2  | revive 时 cache 已冷，成本高                                                                                            | fixed 预算加频率上限                                                                                            |
| R4  | 含糊时按至多一次处理，会丢消息                                                                                          | 有审计；只发生在「已尝试但没有接受证据」或「崩溃 / 没有终态条目」时（NQ2）                                      |
| R6  | 开了 fabric 的用户的 schema 会变一次                                                                                    | Q2，预期内                                                                                                      |
| R7  | 工作区里有 external-agent 的未提交改动                                                                                  | 等它们提交后再开工                                                                                              |
| R8  | 嵌套的原 run 被 revive 后变成 root 直属                                                                                 | 有意为之，diag 里的 `wakeOrigin` 可以追溯                                                                       |
| R10 | 接受标记依赖 pi「prompt 的 user 消息 ⇒ `message_end{role:user}`」以及「启动前就拒绝 ⇒ 没有 `turn_start`」这两个事件契约 | conformance C-P1/C-P2；pi peer 升级前必须跑。如果契约变了，结果是全部落入「含糊 ⇒ consume」，属于安全方向的失败 |
| R11 | 第一期的 root `wake:false` 走无栅栏的 `triggerTurn:false`                                                               | 与 stack.ts 里已有的 5 处调用属于同一风险类；栅栏随第二期                                                       |

---

## 11. 裁决（终局）

**Q1–Q10（2026-10-20）**，全部采纳推荐方案：

- Q1 跨会话省略 `wake` ⇒ `false`；树内省略 ⇒ legacy。
- Q2 `fabric.wake.enabled` 默认开（仅 fabric 开启时生效）；跨会话默认关。
- Q3 revive 完成后通知 root，不唤醒。
- Q4 不唤醒外部 agent 的 run。
- Q5 子 agent 跨会话发送需要 `can_message` 含 `"session"`。
- Q6 用户主动中止的 run 不可唤醒。
- Q7 接收方默认 `"wake"`。
- Q8 只能发给对方主会话，或回复曾给自己发过消息的 run。
- Q9 跳数上限 2，超限降级。
- Q10 远端回复唤醒的结果不回传。

**NQ1–NQ3**：

- NQ1 `rootRunMaxS` 默认 900s（第二期）。
- NQ2 证据含糊 ⇒ 至多一次（审计，不盲注）。
- NQ3 跨会话不自动重试（第二期）。

**用户拍板 r2**：

- 分两期：第一期只做树内（S0、F0、W1–W6）；跨会话（R1、X1–X5）放第二期，第一期稳定后再开；S0 中只服务跨会话的部分推迟到第二期。
- NQ1：`rootRunMaxS` 默认 900s。
- NQ2：park 交接证据含糊 ⇒ 至多一次（审计，不盲注）。
- NQ3：跨会话不自动重试，`effect:"unknown"` 交模型决定。

**v3 没有新增需要用户决定的问题。**

---

## 12. 第二期（C1）设计存档（v2 已评审两轮；第二期开工前必须复核）

摘自 v2，要点如下；与第一期的接口差异，在第二期开工时以第一期实际落地的代码为准。

- **12.1 受管的自治唤醒 run（RootWakeController）**：派发前检查 `expiresAt`；用 `before_agent_start{messageType:"custom", details.wakeToken}` 绑定所有权；启动 watchdog 10s（观察不到就不 abort）；执行 watchdog `rootRunMaxS`（NQ1 = 900s），只 abort 属于自己、且没有人类介入的 run，abort 后不等待，`abortGraceMs` 之后只告警；人类输入、`agent_settled`、`session_start`、或别的 run 的 `before_agent_start` ⇒ 撤销监管。第二期起，显式 `wake:true` 唤醒空闲 root 也改走这条路径（与第一期的 legacy 等价相比，这是有意的变化）。
- **12.2 会话变更栅栏**：压缩或分支摘要（`!isIdle() && ctx.signal===undefined`）、`session_before_*` 与对应的完成事件之间（30s 安全超时）、web resume / `/new` 执行认领、topic-switch 迁移或 hold、goal 活动（只阻止唤醒）；生效前校验 `sessionGen`；不做 hold，有界地拒绝或重试。
- **12.3 协议与 hub**：`xs.v1`/`xs.recv.v1`/`xs.send.v1`；先 `xs_resolve`（sessionId 精确 → 前缀 ≥8 → name 精确 → name 忽略大小写；歧义时附 ≤5 个候选）再 `xs_send`，send 阶段只按 `agentId+sessionId` 精确匹配；hub 盖章发送方身份；`expiresAt = now + 5s`；限额常量（16 KiB、20 次发送/分钟、12 次唤醒/小时、同一对会话 30s、在途 4）；审计不含正文；`HubConfig.crossSession?: true` 作为开关（non-live，需要 `/webhub restart`）。
- **12.4 接收端与格式**：过期 → 策略（`receive` / `allowFrom`）→ sessionId → 栅栏 → `toRun` 授权 → L5 与每小时唤醒预算 → 派发；格式：JSON 编码的元数据、接收方生成的 nonce 边界线、宿主说明放在边界外。
- **12.5 发送端与授权**：`E_XS_OFF` 检查 → 配额 → resolve → **在发送之前**安装 pending 授权（绑定远端 `agentId+sessionId` 和本地会话链，持久化，24h，只在确证 `effect:"none"` 时撤销）→ send；只尝试一次（NQ3）；主会话工具在 activate 时按设置冻结。
- **12.6 第二期闸门矩阵、持久性与测试**：见 v2 §4.12/§4.13/§8 的 C1 部分（hub 精确匹配、旧版本对端、managed rpc、hub 重启、provider payload、consult-preserve C9）。

---

## §R1 评审修订记录（r_0HK1XY2S → v2）

| #   | 问题                         | 处理（v3 中的位置）                                                                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `successor_starting` 自旋    | waitingFor 标记（§3.4b）                                                                               |
| 2   | 唤醒起的主会话 run 无上界    | v2 设计了 RootWakeController；v3 将其随 C1 移到第二期，第一期 root `wake:true` ≡ legacy（§3.1、§12.1） |
| 3   | hop 不是因果的               | §3.3（v3 再次细化）                                                                                    |
| 4   | park 交接不持久              | §3.5（v3 重写）                                                                                        |
| 5   | 合并漏消息                   | §3.4a/b                                                                                                |
| 6   | 合并后的结果所有权           | §3.4d                                                                                                  |
| 7   | TTL 边界                     | F0                                                                                                     |
| 8   | 预算 ×1000                   | §3.7                                                                                                   |
| 9   | 准入原因、模型 pin           | §4.6、§3.7                                                                                             |
| 10  | 旧 run 失败关闭              | §4.5                                                                                                   |
| 11  | 去重 LRU                     | 裁掉（第二期，NQ3）                                                                                    |
| 12  | 重试会重新解析地址           | 先 resolve 再 send（§12.3）                                                                            |
| 13  | 回复授权                     | §12.5                                                                                                  |
| 14  | `!isIdle()` 不等于可以 steer | 栅栏（§12.2，第二期）；第一期不需要（§3.1）                                                            |
| 15  | 信任边界、转义               | §4.9、§12.4                                                                                            |
| 16  | quiet 中断 ask_user          | §3.7                                                                                                   |
| 17  | consult-preserve             | 第二期 S0b                                                                                             |
| 18  | 持久性措辞                   | §3.8                                                                                                   |
| 19  | 注册依赖 hub                 | §12.5                                                                                                  |
| 20  | 正文矛盾                     | 已清理                                                                                                 |
| 21  | 工作包                       | §9（v3 重排）                                                                                          |
| 22  | 冗余                         | 已裁剪                                                                                                 |

## §R2 评审修订记录（r_XXQEHSVQ → v3）

| #   | 评审问题                                                                 | 修订                                                                                                                                                                                                                                                                                                                                                                                                                       | 位置                                                            |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | 推迟 R1 后，第一期仍依赖 RootWakeController 和栅栏；W1 的钩子被分给了 R1 | **选择：第一期显式 `wake:true` 发给 root ≡ legacy 调用**（不新增不受管的路径）；`wake:false` = `sendMessage(…, {triggerTurn:false})` 只投递、不触发；省略 = legacy；第一期不需要栅栏（理由：与 stack.ts 已有 5 处同形调用属于同一风险类）。`input` 钩子、web 归属端口、root level 持久化都归 W1。发布了第一期矩阵                                                                                                          | §3.1、§3.3 L6/L7、§9 W1、D-W13、R11                             |
| 2   | `promptDispatchedAt` 没有写入方；dispatch 相位先于 `handle.prompt()`     | 区分「已尝试」（`promptDispatchedAt`，在 `phase_entered{prompt_dispatch}` 时写入）和「已接受」（新增 `inputAcceptedAt`，生产者是 driver 的 `message_end{role:user}` ⇒ `input_accepted`）；新增 `rejected_pre_accept`（GuardRejected 且没有 turn_start）；已尝试但没有接受证据 ⇒ 含糊并按 NQ2 审计 consume；普通 `Agent({resume})` 只设 `trackInput`，不捏造 `wakeOrigin`；测试覆盖同步拒绝、延迟接受、接受后失败和崩溃窗口 | §2.2、§3.5（接受标记、处置表）、§4.1、§4.7、§8 W2/W3、C-P1/C-P2 |
| 3   | strict 预约与 claim 协议冲突                                             | 一个 claim-aware 的 `reserveStrict`（期望状态加 token 的 CAS，先持久化，落盘形态已规范化，内存里 claimed → pending 表示所有权移交）；`verdict()` 的早退改为按身份清理 inFlight；回滚失败 ⇒ quarantine ⇒ NQ2 含糊。**更正**：engine 的 `put()` 会抛出，而 `transition()`/`annotate()` 先改内存再吞掉错误                                                                                                                    | §2.1、§3.5、§4.1、§4.3、D-W11                                   |
| 4   | 同步 `statSync` 和 4 MiB 扫描阻塞 event loop                             | **删除所有文件读取**：准入阶段不读文件；对账只用内存中的条目和终态证据，其余按 NQ2 consume                                                                                                                                                                                                                                                                                                                                 | §3.5、§6                                                        |
| 5   | 「读到文件末尾没有标记」不能证明未交付                                   | 删掉这项优化；只有终态条目（R 已经物理结束）才能证明「未交付」；`isLiveSessionFile` ⇒ 暂缓，`onReaped` 或 60s 后再判；不确定 ⇒ 含糊                                                                                                                                                                                                                                                                                        | §3.5 处置表                                                     |
| 6   | reserved 记录的优先级                                                    | 每次 pump 先做处置清扫（最多 32 条）；reserved/quarantined 在 TTL 判定之前跳过；只排出未预约的记录；预约有硬上限；同一时刻：预约用 `>=` 判断过期，过期的记录不能被预约；测试                                                                                                                                                                                                                                               | §3.6、§8 F0/W3                                                  |
| 7   | park 排出用的 steer 绕过预约，超时之后仍可能送达                         | redirect steer 采用持久的尝试所有权（`steerAttempt`，经 `annotateStrict`）；`Verdict.effect` 区分 none 和 unknown；超时或 reload ⇒ 审计 consume，legacy 不变；测试覆盖超时后才送达、接受与写盘之间的 reload                                                                                                                                                                                                                | §3.4c、§4.3、D-W12、§8 W4                                       |
| 8   | 因果 level 的 seam 不完整                                                | `QueryService.steer` 增加 origin 参数（覆盖 root 工具、web、@mention）；`wake_result` 继承继任 run 的 level；有效值经 reducer `wake_level` 写进 diag（持久化最终值）；resume 继承规则：wake revive 用 `max(origin+1, prevFinal)`，其他 spawn 是新的人类纪元（取 spawner 的 level）；测试清单                                                                                                                               | §3.3、§4.7、§8 W1                                               |
| 9   | 订阅者在 `await spawn()` 之后才登记，与快速完成竞争                      | trigger 的发送方在同步准入阶段（`void start` 之前）登记；合并进来的发送方先插入再同步检查终态，只取一次；超过 8 个 ⇒ `subscriptionUnavailable` receipt；测试                                                                                                                                                                                                                                                               | §3.4d、§8 W6                                                    |
| 10  | readBack=true 不等于持久                                                 | 三级持久能力 `disk` / `session-memory` / `stack-memory`（依据 `getSessionFile()`）；stack-memory ⇒ park 不可用，按 legacy 签死信并带提示；session-memory ⇒ 带提示；用真实内存会话做 conformance（C-P5）                                                                                                                                                                                                                    | §3.8、§8 C-P5                                                   |
| 11  | 关闭状态                                                                 | 所有写入都按 `wakeOn`/`trackInput` 门控；golden 覆盖成功、准入被拒、启动失败三种 run，外加 schema，并在 S0 先采集；F0 是唯一的关闭状态行为变化                                                                                                                                                                                                                                                                             | §3.9、§9 S0/F0                                                  |
| 12  | 工作包                                                                   | S0 裁剪为第一期所需（跨会话的设置、`CanMessage:"session"`、`list_sessions` 与影子工具都推迟到第二期 S0b）；runner、reducer、adapter、index、tests 都有明确的所有者；W1–W6 拆分（接受标记单独成为 W2）；新增第一期终局闸门 G（build/typecheck、目标 integration、真实 pi conformance、矩阵/property 同步）；新状态一律用 strict annotate/CAS，不加自转移边                                                                  | §9、§4.1                                                        |
