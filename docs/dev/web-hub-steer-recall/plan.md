# web-hub 插话撤回（steer / followUp recall）— 实施计划 v4.2

> **v4.2 = 第二位复审对 v4.1「打回」后、按调度方裁定 R-A…R-D 的修订版**（§0.5；§13「v4.2」逐项对应意见 1–8）。核心：B1 **只由正面证据解除、绝不由超时解除**；阻塞时 agent_end 把剩余 held 项**退回浏览器**；30 s 只改显示态（`unconfirmed` 可升级）；确认阶段 timer **ref**、显示/tick timer unref；UI 用 per-cmdId tombstone + `{agentKey, sessionId, heldEpoch}` 作用域做单调合并；真实 driver 的 conformance 是第一个包的硬闸门。
> **v4.1 = 复审 gpt-6-astra 对 v4「打回」后的修订版**（修订项 1–7 见 §13「v4.1」；核心改动是 §0.4：pi 的 `sendUserMessage` 只是表面同步，入队发生在 input 链之后，所以 v4.1 把派发**串行化**——每个 hook 至多发一条，前一条没有「确定入队」的证据之前不发下一条——并以真机行 M24/M24b/M25 证明 FIFO）。
> **v4 = 复审 r_KKCSH5D5「有条件通过」后的重做版**。v1→v3 每轮都在修补旧问题的同时长出新的边界情况（链路绑定 `liveGen`、取消令牌、settled deferred epoch……）。v4 的做法不是再补一层，而是**砍掉产生这些边界的机制本身**：§0 逐条列出砍了什么、为什么砍得掉、保留了哪些已证明的保证。每条评审意见（1–12）的处理见 §13「v4」。
>
> 输入：`docs/dev/web-hub-steer-recall/arch.md` v1。**§11「用户裁定（2026-10-08）」具有约束力**，与 arch 正文冲突时以裁定为准：
>
> - **Q1**：`webHub.steerRecall` 默认 `true`。
> - **Q2**：arch §4.3 不实施。终端（TUI/rpc）插话立即交给 pi，可能排在更早发出、仍在暂存的网页消息之前；暂存消息保持可撤回。本计划**不**新增任何 `input` handler，**不**对 `input` 做任何拦截（矩阵行 M12 把这一顺序固定为「接受的行为」）。
> - **Q3**：pi 进程崩溃时，暂存消息只靠浏览器内存兜底，不落盘。
> - **Q4**：正文以 `@` 开头的消息一律绕过扣留。
> - **Q5**：`too_late` 不区分「另一标签页已撤回」和「已交给模型」。
> - **Q6**：`/reload` 发生在轮次中途时，暂存消息转为 returned。
> - **Q7**：TUI 显示紧凑英文标记 `held N`（N>0），追加在 web-hub 状态 token 之后，渲染为 `web ● held 2`。
>
> 车道 **L2**。证据基线：pi `@earendil-works/pi-coding-agent` **1.0.2**（全局安装与仓库 devDependency 同版本）。下文 `$PI` = `node_modules/@earendil-works/pi-coding-agent/dist/core`，`$AC` = `node_modules/@earendil-works/pi-agent-core/dist`。
> 用户需求只有三句话：**忙时从网页发出的 steer/followUp 在真正交给模型之前可以撤回、改了再发；任何消息不能静默丢失、不能投递两次；功能关闭时逐字节等同现状。** 本文每一处设计都要能回答「它服务于这三句中的哪一句」。
> 本文自包含：开发者读 §1–§6 加上自己那一包的小节即可动工。

---

## 0. v4 相对 v3 改了什么、为什么（先读这一节）

### 0.1 三条被砍掉的机制

| #   | v3 机制                                                                                                                                                                                                                                                                                             | v4                                                                                                                                                                                                                                                                                                                                                                  | 为什么砍得掉（证据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **链路绑定**：`binding=(connGen, liveGen, hasCap)`、`connection.ts` 新增 `liveGen` 并把 hello_ack 的 `notify()` 改为强制通知、`onLink()` 重评估、`cap_lost` 先交出后切投影（评审 item 1 要求写清 hello_ack 内部调用顺序）                                                                           | **纯函数** `holdCap() = conn.status().state==="live" && conn.caps.includes("hold.v1")`，与现有 `isLiveWithCap`（`index.ts:1145`，dialog.bg 同款）相同，**在扣留那一刻读取**，不缓存、不绑定。cap 不可用的持续时间由 1 Hz tick 采样（`capDownSince`），≥ 15 s 时同步交出或退回（§5.6）。**`connection.ts` 一行不改**，`connection.test.ts` 一条不改。                | ① 扣留判定只需要「此刻能不能撤回」，不需要知道「这是第几条链路」。② v3 担心的「视图完全相同的 socket 替换不触发 notify」窗口**不存在**：任何 socket 拆除都经 `enterBackoff()`（`connection.ts:792-800`，`link="backoff"` + `notify()`）与 `connectNow()`（`:458-462`，`link="connecting"` + `notify()`），视图必然经过中间状态，hello_ack 的 `notify()`（`:573`）一定会触发；`/reload` 的 handover（§0.4 D4）同样经过 `connecting`→`live` 两次 notify。③ 即使 hub 被换成无 cap 的版本，暂存项仍在 agent 缓冲里，照常在 turn_end 交接，**没有任何投递语义依赖 cap**——cap 只影响「浏览器能不能看见/撤回」。因此 cap 丢失只需要一条规则：持续 15 s 看不见就交出去。 |
| C2  | **取消令牌 + 600 ms watchdog**：异步批次逐项 `commitOne` 后 `await` 确认，watchdog 到期取消令牌，剩余项归下一个 hook（评审 item 2：令牌在 commitOne 中途取消需要逐阶段回滚）                                                                                                                        | **一次同步派发 + 一次有界等待**：每个 hook 先在一个**不含任何 `await` 的同步函数**里把本批全部项取出并 `sendUserMessage`，然后把 phase 置为 `between`，**之后**才 `await` 一个 ≤ 200 ms 的确认（§5.2）。没有 watchdog，没有令牌，没有「剩余项」。                                                                                                                   | 单线程：同步函数执行期间 timer 回调不可能插进来，所以「中途取消」在结构上不存在——不需要回滚。等待发生在所有派发之后，等待超时的唯一后果是 handler 提前 resolve（M13c：消息仍恰好投递一次，只是晚一个取队点）。确认等待期间新到的网页消息走原生路径（phase 已是 `between`），与原生同一取队点（M22）。                                                                                                                                                                                                                                                                                                                                                            |
| C3  | **agent_settled 同步交接 + deferred epoch**：settled 残留经 `sendUserMessage` 交出，pi 把它推入 `_deferredSettledActions`，失败会以**最初那次 `session.prompt()` 的 reject** 形式出现（R6/F28，评审 item 3）；为此又加了 `deferred` 表、`onDeferredStale`、`unconfirmed{stale}`、DS1–DS3、M11b、M19 | **agent_settled 绝不派发**。由于 C2 让每个 hook 的同步派发把缓冲清空、并且 `between` 期间不收新项，**到 settled 时缓冲按构造为空**（不变量 I-EMPTY，矩阵全部 23 个正常行实测 `heldAtSettled=0`）。settled 里若仍有残留（防御分支）⇒ `returned{stale}`，零次 `sendUserMessage`（M11 实测：故意塞入残留 + 鉴权失败 ⇒ 不发送、原 prompt 正常 resolve、无 ext error）。 | 空闲路径整个消失：没有 deferred、没有 `idleWatch` 耦合、没有 `not-started`/`stale` 的 unconfirmed、没有 R6。`handed` 一律发生在 `_isAgentRunActive===true` 期间（turn_start/turn_end/agent_end/tick 都在 run 内），`prompt()` 必走 `isStreaming` 入队分支（`$PI/agent-session.js:1515-1525`）。                                                                                                                                                                                                                                                                                                                                                                  |

### 0.2 其它简化

| #   | v3                                                                                           | v4                                                                                                                                                         | 理由                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C4  | 请求令牌 `reqToken/turnEndFor` 判断 turn_end 是否被跳过（X12）                               | **按 phase 判断**：`turn_start` 到达时 `phase==="armed"` ⇒ 上一请求的 turn_end 没有运行。只有 hook 改 phase，tick 派发不改 phase。**明确标为 best-effort** | 评审 item 5：令牌没有绑定到任何可观测身份。phase 本身就是可观测的转移序列；而且**误判无害**：`turn_start`（`$AC/agent-loop.js:113`）在本轮 Q1 取队（`:110-112`）之后，此时派发的消息下一个取队点是本轮 `:186`——与正常扣留到 turn_end 再交**同一取队点**，只损失这一轮的可撤回性，不丢不重。M9 实测 `skipFired≥1`，M16–M18 实测 `skipFired=0`。                                                                |
| C5  | 阶段 `idle/armed/handing/between/settling`                                                   | `idle/armed/between` 三个                                                                                                                                  | `handing` 的唯一作用是「批次期间新到项追加到同一批」；v4 在派发后立即置 `between`，新到项走原生（M22）。`settling` 的作用是阻止 settled 期间扣留，`canHold` 的 `!ctx.isIdle()` 与 phase≠armed 已覆盖。                                                                                                                                                                                                        |
| C6  | `peek()` + recall 前 48 KiB 防御性复核                                                       | 删除。hub 侧 `RecallResultDataSchema` + 字节上限校验保留（S4）                                                                                             | 正文在 prompt 入口已校验 ≤ 48 KiB，缓冲不可能被外部写入；校验保留在信任边界（hub）即可。                                                                                                                                                                                                                                                                                                                      |
| C7  | 常量 `HANDOFF_ITEM_BUDGET_MS/HANDOFF_BATCH_BUDGET_MS/HANDOFF_WATCHDOG_MS/HOLD_LINK_GRACE_MS` | `HANDOFF_CONFIRM_MS=200`、`HANDOFF_POLL_MS=2`、`HOLD_CAP_GRACE_MS=15_000`、`HOLD_MAX_MS=30 min`                                                            | 一次等待只需要一个上界。                                                                                                                                                                                                                                                                                                                                                                                      |
| C8  | 确认信号 = 自家 `input` 观测 + 1 个 macrotask                                                | 确认信号 = 自家 `input` 观测 **→ `ctx.hasPendingMessages()` 变为 true（2 ms 轮询）→ 1 个 macrotask**；派发前已有 pending 时退化为旧信号                    | `_queueSteer/_queueFollowUp` 把 `_steeringMessages/_followUpMessages` 的 push 与 `agent.steer/followUp` 放在同一个同步块里（`$PI/agent-session.js:1697-1720`；`pendingMessageCount` 读的就是这两个数组，`:1856-1858`），所以布尔值翻转 ⇔ 真正入队。旧信号只能覆盖**排在我们之前**的慢 handler；新信号覆盖排在我们**之后**的慢 handler（M13b：50 ms 第三方 handler 仍落同一取队点；v3 信号下会晚一个取队点）。 |
| C9  | P-conf-B 独立包                                                                              | 作为 P-agent PR 的最后一个 commit（同一文件名 `tests/conformance/steer-hold-driver.test.ts`）                                                              | 少一次合并协调；API 定稿时机不变。                                                                                                                                                                                                                                                                                                                                                                            |
| C10 | §5.8 把台账说成「落盘」                                                                      | 台账是**进程内存**（`Symbol.for` 袋），跨 `/reload` 存活、不跨 pi 进程                                                                                     | 评审 item 9。                                                                                                                                                                                                                                                                                                                                                                                                 |

### 0.3 保留的保证（逐条有证据）

- 交接点 = `turn_end` 扩展 handler（finishTurn 内、被 await、早于 `:186`），零额外取队延迟（M1–M3、M13）。
- arm 点 = `context`（M14/M15 反证）。
- 不能保证 exactly-once 的窗口一律关闭扣留、走原生路径：`between`、手动压缩、abort 之后、cap 不可用、缓冲满、`@` 开头（M4、M8、M22）。
- 撤回与交接的线性化点是同一个同步临界区（M2）。
- 中止 ⇒ returned（M6、M8）；会话边界/reload ⇒ returned；P12 跳过 ⇒ ≤1 轮（M9/M10）。
- 四类结局 handed-confirmed / handed-unconfirmed / returned / recalled，每个 cmdId 恰好一个（矩阵通用断言「无双终局」）。
- 关闭 ⇒ 不注册 handler、不加 cap、帧逐字节相同（W1/W2）。

---

### 0.4 v4.1 相对 v4 的修订（复审打回项）

| #   | 问题（复审）                                                                                                                                                                                                                                                                                                                                                                                                                                         | v4.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 证据                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| D1  | **`pi.sendUserMessage` 只是表面同步**：runtime 调 async `sendUserMessage` 并 `.catch()`（`loader.js:306-309`、`agent-session.js:2676-2683`），内部 `await prompt()` → `await _runInputHandlers`（`:1502`），**之后**才 `_queueSteer/_queueFollowUp`（`:1515-1524`）。v4 在一个「同步 pass」里连发 S1、S2 会启动两条并发 input 链：S1 上的慢第三方 handler 让 S2 先入队 ⇒ 乱序 / 跨取队点。I-SYNC 只证明 JS 栈内无 timer 插入，不证明异步副作用不交错 | **串行化派发**：每个 hook **至多发一条**；**本模块永远不让自己的两条发送同时在途**——下一条只在前一条「确定入队」（§5.2 的 enqueue 证据）、被消费（user `message_start`）或终局（30 s unconfirmed）之后才发（阻塞规则 B1）。pi 默认 `steeringMode/followUpMode = "one-at-a-time"`（`$PI/settings-manager.js:527,535`；`$AC/agent.js:60-82` 的 `peek()` 每次只取一条），所以每个取队点本来就只取一条，一个 hook 只发一条**零成本**。`"all"` 模式下第 2 条起晚一轮（M26，接受）。                                                                                                                            | M24（S1 慢 400 ms、S2 快 ⇒ 顺序保持）、**M24b 对照**（原生并发发送同一场景 ⇒ S2 越过 S1）、M25、M26 |
| D2  | `ctx.hasPendingMessages()` 只证明「某个队列非空」，不证明所有已发项都入队；`pendingBefore===true` 时跳过轮询                                                                                                                                                                                                                                                                                                                                         | 每条消息的 enqueue 证据只在**它是唯一在途发送且发送前布尔为 false** 时成立：false→true 翻转 **且**自家 `input` 观测器已看到它 ⇒ 这条确定入队。`pendingBefore===true` ⇒ 证据不可得，这条标为 `unverifiable`，由消费（`message_start`）解除阻塞（v4.1 还允许 30 s 终局解除，**v4.2 起删除**，§0.5 R-A）；在 one-at-a-time 下这与原生落点相同（M25：T、S1、S2 依次落 LLM#2/#3/#4，与原生队列 [T,S1,S2] 相同）。文中所有「同一取队点」表述都限定为「已确定入队的那一条」。                                                                                                                                    | M25、M13、M13b                                                                                      |
| D3  | `holdCap()` 为假时 `status.held` 不发、ctl 过滤 held ⇒ 浏览器可能在断链 / 换 hub / 刷新 / 多标签页时直接丢掉行，而不是显示 `unavailable`                                                                                                                                                                                                                                                                                                             | 投影**不再按 `holdCap()` 门控**：`status.held` 只按 `holdWired`（设置）门控，非空就发（`StatusInfoSchema` 开放，旧 hub 不会因此丢帧）；ctl 只在**链路 live 且 hub 明确没有 cap** 时过滤 held（断链期间不过滤，slot 存的是完整投影，回放到任何 hub 都正确）。UI 规则 U-KEEP：card 非 live 时保留最后一次 `held` 快照（`unavailable`），只有来自 live card 的 status 才替换快照。测试矩阵：held → cap 丢失 → 15 s 内 / 15 s 后 / 重连有 cap 的 hub / 另一标签页 / 刷新。                                                                                                                                    | §4.7、§7、W6/W7/W12、detail-dock-recall                                                             |
| D4  | §0.1 C1 事实错误：`/reload` **不**复用同一 `HubConnection`                                                                                                                                                                                                                                                                                                                                                                                           | 更正：`acquireConnection()`（`connection.ts:177-192`）按 `buildId#MODULE_INSTANCE` 判 implVersion，模块重求值 ⇒ 不同 ⇒ 旧连接 `close("handover")`（发 `bye{handover}`，`notify(true)`，`binding=undefined`，`:440-454`），新连接 `start()→connectNow()`（`connecting` notify）→ hello_ack（`live` notify）。C1 的结论不变——证明重新建立在真实的 handover 转移上：新连接必经 `connecting` 视图，hello_ack 的 `notify()` 必触发；旧 `MODULE_INSTANCE` 的 held 项由新实例 `adopt` ⇒ returned{reload}（Q6）；handover 期间 `holdCap()` 为假 ⇒ 不扣留，`capDownSince` 在新链路 live 时清零。新测试 W5-RELOAD。 | `connection.ts:177-192, 440-454, 458-462, 792-800`                                                  |
| D5  | `onReturned` 有两个所有者（dispatchHeld P6 与 flush）⇒ 可能重复 publish 或把成功项标 returned                                                                                                                                                                                                                                                                                                                                                        | **单一所有者**：`dispatchHeld` 只返回 `DispatchOutcome`，**不碰缓冲、不调 `onReturned`**；driver 在每次派发 / 每次 flush 之后对**恰好那一组失败项**调一次 `markReturned` + `onReturned`，再 `publish()` 一次。per-outcome 测试（sent / refused / threw 各自的 onReturned 调用集合与 publish 次数）。                                                                                                                                                                                                                                                                                                      | §5.3、hold-faults                                                                                   |
| D6  | 「每个 hook 至多一个 await」不准确（race + 轮询 + macrotask）                                                                                                                                                                                                                                                                                                                                                                                        | 改为「每个 hook 至多**一个有界确认阶段**，其中包含有限个 timer await（1 个 cap + ≤100 次 2 ms 轮询 + 1 个 macrotask），总上界 200 ms + 1 macrotask」。四层术语分开：**缓冲层**（held/handing/returned）、**调用层**（`sendUserMessage` 返回）、**入队层**（`_queueSteer` push，证据见 D2）、**消费层**（user `message_start`）。                                                                                                                                                                                                                                                                          | §5.2、§5.7、§6                                                                                      |
| D7  | phase 式 turn_start 跳过检测的「提前交出失去撤回窗口」应列为接受行为                                                                                                                                                                                                                                                                                                                                                                                 | 列入 §11「接受的行为」A-SKIP。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §11                                                                                                 |
| R7  | R7 描述过窄                                                                                                                                                                                                                                                                                                                                                                                                                                          | 重写为「确认窗口内到达的消息走原生路径：不可撤回，且与本模块已发出的那一条之间不再有 FIFO 保证（它们是并发的 input 链）」；并补充 D1 下的两条退化：慢 handler ⇒ 晚一个取队点（M13c）；最后一个 hook 上的慢 handler ⇒ 后续项 returned{stale}（M27）。                                                                                                                                                                                                                                                                                                                                                      | §11                                                                                                 |

### 0.5 v4.2 的调度方裁定（约束，不再讨论）

| 裁定 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 落点                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| R-A  | B1 **只由关于我们上一条发送的正面证据解除**：入队确认（唯一在途 + 布尔 false→true + 自家 `input` 观测，`source:"extension"` 且正文全等）或**归因于该发送的消费**（§5.2 归因机制）。**绝不由超时解除**。阻塞期间后续项保持 `held`（可撤回/编辑）；agent_end 时若仍阻塞 ⇒ 剩余 held 项全部 **returned**（回到浏览器，绝不自动发送）；settled 兜底同样 returned。30 s 台账 timer **只改上一条的显示态**为可升级的 `unconfirmed`（「可能已送达」），后续证据（input 观测 / 归因的 `message_start`）到达即升级为 handed——M27 的归属就是这条已有台账条目，不新增 prompt 状态。后果：吞掉我们消息（返回 handled）或永远挂起的第三方 handler ⇒ 其余 held 项在 run 结束时退回浏览器——可接受（不丢：用户可重发；不重；不乱序）。 | §1.1 I-SERIAL、§5.2、§5.4、M27–M30 |
| R-B  | 每个 hook 的确认阶段 timer（≤200 ms，有界）**ref**；30 s 显示 timer 与 1 Hz tick 保持 **unref**（它们从不门控 pi 正在 await 的 promise）。不变量 **T-REF**：pi 正在 await 的任何 promise 都不得依赖 unref 的 timer。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §5.5、§5.7、§6                     |
| R-C  | UI 单调合并：per-cmdId **终态 tombstone**（recalled / handed / returned / unconfirmed）压过任何 status 快照；快照只能**新增**未被 tombstone 的行；快照按 `{agentKey, sessionId, heldEpoch}` 作用域；`heldRev` 只在同一作用域内比较；不同作用域永不复活行。测试：标签页 A 撤回 → 标签页 B 收到陈旧 status → 重连；handed → 旧 held 快照；agent 重启（新 epoch）。                                                                                                                                                                                                                                                                                                                                                       | §2.3 S2（`heldEpoch`）、§7 U-MERGE |
| R-D  | 每个证明行标注 run / to-implement / to-accept；真实 driver 的 conformance（含 慢 handler × B1、吞消息 handler、跳过检测误触 × B1）是**第一个包**的硬闸门。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §1.2、§2、§3                       |

## 1. pi 路径证据、arm 点论证与路径矩阵

### 1.1 取队点与扩展事件的相对时序（pi 1.0.2）

`runLoop`（`$AC/agent-loop.js:83-206`）：

```
[首轮] agent_start → turn_start(:51) → 初始消息 message_* → runLoop:
  Q0  pendingMessages = getSteeringMessages()                       (:85)   ← 首个取队点
  loop:
    if lastCompletedTurn:                                          (后续轮)
      prepareNextTurn()   ← 自动压缩 ($PI:411-420, 527)
      if pending 为空: Q1 = getSteeringMessages()                  (:110-112)
      turn_start                                                   (:113)
    推入 pending → message_start/end                               (:116-121)
    prepareRequest()      ← 虚拟模型路由 + 阈值压缩 ($PI:423-470)  (:123)
    streamAssistantResponse → transformContext = 扩展 `context`   (:263-264; $PI/sdk.js:266-270)  ← ARM
    error/aborted: finishTurn(→扩展 turn_end) → turn_end → agent_end → return   (:147-153)
    执行工具
    finishTurn(→扩展 turn_end，被 await)                           (:179; $PI:510-519)
    turn_end
    Q2 pendingMessages = getSteeringMessages()                      (:186)  ← 本轮最后取队点
  停下前: Q3 followUps = getFollowUpMessages()                       (:192)
agent_end（扩展 agent_end 被 await，所有路径都发，$PI:870-871；:152/:182/:207）
_runAgentPrompt: _handlePostAgentRun → 重试 / 压缩 / hasQueuedMessages ⇒ agent.continue()   ($PI:1354-1414)
                 _runBeforeSettleBoundary（agent_before_settle）
_emitAgentSettled: _isAgentRunActive=false → 扩展 agent_settled（被 await）→ deferred actions  ($PI:671-690)
```

**arm 点 = 扩展 `context` 事件**：`context` 一定晚于本次请求之前的所有取队点（Q0/Q1/上一轮 Q2/Q3），一定早于本次请求之后的取队点（本轮 Q2；error 轮之后的 `continue()`/重试）。在 arm 与 turn_end 之间扣留的消息，交接后都落在「本轮之后第一个取队点」，与原生「当时立即发出」相同。

**`between` 窗口** = 上一个 hook 的同步派发之后到下一个 `context` 之前：含 turn_end/agent_end 的确认等待期、prepareNextTurn 自动压缩、prepareRequest、重试退避、post-run 压缩、agent_before_settle、settled。这段时间**扣留关闭**，消息走原生路径（M4、M22）。

**I-EMPTY（缓冲在 settled 时为空，除非最后一个 hook 的发送被慢 handler 拖住）**：缓冲非空 ⇒ 最近一次 `context` 之后有扣留 ⇒ 这次请求之后必然有且只有以下出口之一：(a) 正常 turn_end（handler 派发一条，并在确认阶段内等它入队）；(b) turn_end 被 P12 跳过 ⇒ 下一个 turn_start 派发一条（C4）或 (c) agent_end；**agent_end 在所有路径上都会发出**（`:152` error/aborted、`:182` end 决定、`:207` 自然停下）并派发一条。派发一条之后 pi 因 `hasQueuedMessages()` 继续（P18）⇒ 又有新的 turn_end/agent_end 派发下一条……直到缓冲为空。abort 路径在 (a)/(c) 里把全部项 returned。**唯一例外**：最后一个 hook 发出的那一条在 200 ms 内没有入队（第三方 input handler 更慢）⇒ pi 看不到队列、停下 ⇒ settled 时剩余项仍在缓冲。此时 agent_end 发现 B1 阻塞 ⇒ 剩余项 ⇒ `returned{stale}`（用户可见「run 已结束、未送达」，可重发；settled 兜底同样处理）；那条慢消息随后由 pi 作为新 prompt 送达一次，其台账条目从 `unconfirmed` 升级为 handed（M27）。矩阵每一行都断言 `heldAtSettled===0`，M11（故意注入）与 M27（故意慢 handler）除外。

**I-SERIAL（本模块的发送串行）**：任何时刻至多一条本模块发出的消息处于「已调用 `sendUserMessage`、尚未取得入队确认或归因消费」状态（§5.2 B1）。解除**只靠正面证据，永不靠超时**（R-A）。它保证网页消息之间的 FIFO，不保证与终端消息之间的顺序（Q2）。阻塞持续到 run 结束 ⇒ agent_end 把剩余 held 项退回浏览器（M27/M28）。

| 路径                           | 关键源码                                                          | arm/交接行为                                                                               | 矩阵行          |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------- |
| 首轮                           | `:51` turn_start 早于 `:85`；`:263` context 晚于 `:85`            | `turn_start#1` 时 phase=idle ⇒ 不扣留；`context#1` 起扣留                                  | M1              |
| 普通工具循环                   | `:179` await finishTurn → `:186`                                  | turn_end 同步派发 ⇒ 落 `:186`                                                              | M2、M20         |
| followUp 续轮                  | `:192`                                                            | 停下轮 turn_end 派发 followUp ⇒ 落 `:192`；工具轮扣留的 followUp 持有到停下轮              | M3、M23         |
| prepareNextTurn 自动压缩       | `$PI:411-420`                                                     | 压缩期间 between ⇒ 扣留关闭；压缩前交接的项留在 pendingMessages                            | M4              |
| 模型错误自动重试 / 非重试错误  | `:147-153` → `$PI:1390-1396` / `$PI:1412-1414`                    | error 轮 turn_end 派发 steer；agent_end 派发 followUp                                      | M5、M7          |
| 工具中途 abort / 手动 compact  | E6：`ctx.signal.aborted===true`；`$PI:2132-2134` compact 先 abort | 全部 returned{aborted}；压缩期间扣留被拒                                                   | M6、M8          |
| P12 找不到 assistant entryId   | `$PI:475-487`                                                     | 下一个 turn_start 时 phase 仍 armed ⇒ 同步派发 steer；最后一轮 ⇒ agent_end                 | M9、M10         |
| settled 残留（防御）           | `$PI:1481-1484`                                                   | **不派发**；returned{stale}                                                                | M11             |
| 终端插话与网页暂存顺序（Q2）   | —                                                                 | 终端在前（接受）                                                                           | M12             |
| 确认等待的有界性与覆盖范围     | `$PI:1697-1720, 1856-1858`                                        | 50 ms 下游 handler 仍同一取队点；400 ms ⇒ 200 ms 封顶后 handler 返回，消息晚到、仍恰好一次 | M13、M13b、M13c |
| 确认等待期间新到的网页消息     | —                                                                 | phase=between ⇒ 原生；FIFO 保持                                                            | M22             |
| tick 派发（30 min / cap 宽限） | —                                                                 | 同步派发，不改 phase，同轮后续扣留照常                                                     | M21             |

### 1.2 一次性脚本实测（如实标注证明范围）

脚本为一次性产物，**不入库**：`/tmp/steer-hold-exp6/matrix6.mjs`（v4.2 参考 driver：正面证据 B1、agent_end 阻塞即退回、显示态 timer 300 ms 代替 30 s，32 行），输出 `run1..8.out`。v4.1 的 `/tmp/steer-hold-exp5/matrix5.mjs`、v4 的 `/tmp/steer-hold-exp4/matrix4.mjs`（24 行，并发 pass 版本）、v3 的 `/tmp/steer-hold-exp2/matrix3.mjs` 与 architect 的 `/tmp/steer-hold-exp/exp*.mjs` 保留作对照。

搭建：真实 `createAgentSession`（1.0.2）+ 假 `modelRuntime`（脚本化 toolCall/text/error；`authFail` 开关）+ `SettingsManager.inMemory` + 探针扩展。探针内是 §5 的**参考 driver**：arm=context；三阶段；每个 hook **至多发一条** + 阻塞规则 B1 + 置 between + 一个 ≤200 ms 的确认阶段（观测 → `hasPendingMessages()` 翻转 → macrotask；`pendingBefore` 时标 `unverifiable`）；phase 式 turn_start 跳过检测；agent_settled 不派发。工具耗时可按行调为 300 ms（M24 需要 run 比 400 ms 的慢 handler 长）。**通用断言**：每个被扣留文本恰好一个终局（无 `a+b` 双终局）；`heldAtSettled===0`（M11、M27 除外）；全文不做墙钟断言。

> 脚本的确认阶段 timer 在这个合成 harness 里必须 **ref**（pi 正在 await 我们的 handler，进程中没有其它 ref'd handle，unref 会让 Node 直接退出）；生产代码里仍然 unref（pi 进程总有其它 handle）。P-conf-A 移植时用 ref'd 夹具 timer。

**v4.2 结果：32/32 PASS，连续 8 次运行无抖动**（v4.1 的 29 行全部保留并通过；新增 M28、M29、M30）。

**状态标签（R-D）**：**run** = 一次性脚本已在真实 pi 1.0.2 上运行通过；**to-implement** = 需要在 G0 中用 TS 重写（参考 driver 行）并由真实 driver 重跑（§3.1）；**to-accept** = 只能真机验收（§12 A-行）。下表每一行都是 **run ✓ + to-implement（G0）**；真机项见 §12。

| 行   | 场景                                                                           | 关键观测（run1）                                                                                                            | 证明状态                                     |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| M1   | 首轮：turn_start#1 扣留被拒，context#1 扣留                                    | `hold-refused(idle) PRE-ARM`；H1 在 LLM#2                                                                                   | ✅ 脚本                                      |
| M2   | 3 个工具轮各扣 1 条 + 第 2 轮扣留后立即撤回                                    | S1/S2/S3 在 LLM#2/#3/#4；RECALLME 0 次；`handlerResolvedCalls=[1,2,3]`                                                      | ✅                                           |
| M3   | 停下轮扣 followUp；续轮扣 steer                                                | FU1 在 LLM#2，S 在 LLM#3；agent_end 1 次                                                                                    | ✅                                           |
| M4   | prepareNextTurn 阈值压缩                                                       | `turn_end → compact(threshold) → turn_start`；H 在 LLM#2 位于 summary 之后；压缩中 `hold-refused(between)`；原生 N 1 次     | ✅                                           |
| M5   | 可重试模型错误                                                                 | `turn_end(error)` 派 steer，agent_end 派 followUp；S 在 LLM#3（重试请求），F 在 LLM#4                                       | ✅                                           |
| M6   | 工具中 `ctx.abort()`                                                           | `turn_end(completed,sig=true)` ⇒ 两项 `returned(aborted)`；所有请求不含                                                     | ✅                                           |
| M7   | 非重试错误轮                                                                   | 同 M5                                                                                                                       | ✅                                           |
| M8   | **真实手动压缩**（预置历史，`keepRecentTokens:1`，工具中 `session.compact()`） | `compactRes:{ok:true}`，存在 `compaction` 条目；两项 `returned(aborted)`；P2 请求 = [summary, P2]（长度 2）；压缩中扣留被拒 | ✅ **硬闸门**                                |
| M9   | P12（patch `_findPersistedMessageEntryId`），[tool,tool,text]                  | 无 turn_end 事件；`skipFired=2`（第二次 n=0 无动作）；H 在 LLM#3                                                            | ✅                                           |
| M10  | P12，最后一轮为文本                                                            | agent_end 派发；H 在 LLM#2；agent_settled 1 次                                                                              | ✅                                           |
| M11  | **防御**：settled 前强制塞入残留，同时置 `authFail=true`                       | `returned(stale)`；`sendCalls` 不含它；无 `input`；`promptThrew=no`；`ext_errors=[]`                                        | ✅ **硬闸门**（R6 不可能发生的直接证据）     |
| M12  | 网页扣留 W 后终端原生 steer T                                                  | T 在 LLM#2，W 在 LLM#3（Q2）                                                                                                | ✅                                           |
| M13  | 确认等待 vs `:186`                                                             | handler resolve 时 `calls.length===1`；`confirmTimeouts=0`；H 在 LLM#2                                                      | ✅（v3 标注「只能由 G0 证明」，v4 脚本已证） |
| M13b | 排在我们**之后**的 50 ms 第三方 input handler                                  | `confirmTimeouts=0`；H 在 LLM#2                                                                                             | ✅（C8 的直接证据；v3 信号下落 LLM#3）       |
| M13c | 排在我们之后的 400 ms handler（> 200 ms 上限）                                 | `confirmTimeouts=1`；handler 在上限处 resolve；H 作为 run 结束后的新 prompt 落 LLM#3，恰好 1 次；`promptThrew=no`           | ✅（E4 退化的有界性 + 不丢不重）             |
| M14  | `context#1` 内原生入队                                                         | 落 LLM#2                                                                                                                    | ✅（v3 仅有间接证据）                        |
| M15  | 首轮 `turn_start` 内原生入队                                                   | 落 LLM#1                                                                                                                    | ✅（v3 仅有间接证据）                        |
| M16  | 误报：多轮                                                                     | `skipFired=0`                                                                                                               | ✅                                           |
| M17  | 误报：重试                                                                     | `skipFired=0`                                                                                                               | ✅                                           |
| M18  | 误报：followUp 续轮                                                            | `skipFired=0`                                                                                                               | ✅                                           |
| M20  | 同一 turn_end 同步派发两条 steer                                               | S-A 在 LLM#2，S-B 在 LLM#3（one-at-a-time，FIFO）                                                                           | ✅                                           |
| M21  | 轮次中途模拟 tick 派发（不改 phase）                                           | H-OLD 在 LLM#2；之后同轮扣留 H-NEW 被接受，在 LLM#3                                                                         | ✅                                           |
| M22  | 确认等待期间到达的网页消息                                                     | `hold-refused(between)` ⇒ 原生；H22 在 LLM#2，W22-NATIVE 在 LLM#3；FIFO 保持                                                | ✅                                           |
| M23  | 工具轮扣留的 followUp 持有到停下轮                                             | FU 在 LLM#3（停下轮 turn_end → `:192`）；agent_end 1 次                                                                     | ✅                                           |

**脚本不证明的内容（to-implement，§3.1 真实 driver 闸门）**：真实 driver / commandHandler / 台账显示态（30 s 升级路径）/ 归因机制（mirror cmdId）/ hub / UI / tick 宽限 / `@` 绕过 / 容量 / 会话边界 / `/reload` handover。这些由 P-conf-B（真实 driver 重跑同名行）、单测与集成测试证明（§3.2、§9）。

## 2. 分包、冻结面与合并顺序

### 2.1 文件域（每个文件只属于一个包）

| 包               | 独占写的文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P-protocol**   | `src/web-hub/protocol/{messages,version,http-contract}.ts`；`src/web-hub/hub/{http,commands,registry,hub,agent-server}.ts`；测试 `tests/web-hub/protocol/messages-hold.test.ts`（新）、`tests/web-hub/protocol/version.test.ts`、`tests/web-hub/hub/{caps-coexist,commands,registry}.test.ts`、`tests/web-hub/http/api-cmd.test.ts`、`tests/integration/web-hub-recall-parse.test.ts`（新）                                                                                                      |
| **P-core**（G0） | `src/web-hub/agent/{hold.ts（新）,hold-driver.ts（新）,commands.ts,ledger.ts}`；**硬闸门** `tests/conformance/steer-hold-driver.test.ts`（新，真实 driver + 真实 commandHandler + 真实 ledger，§3.1）；辅助 `tests/conformance/steer-hold-ref-driver.ts`（新，`matrix6.mjs` 的 TS 移植，作为快速对照）与 `tests/conformance/steer-hold.test.ts`（新）；单测 `tests/web-hub/agent/{hold,hold.property,hold-driver,hold-faults,commands-hold}.test.ts`（新）、`tests/web-hub/agent/ledger.test.ts` |
| **P-wire**       | `src/web-hub/agent/{status.ts,index.ts}`；`src/config/{settings,setting-specs}.ts`；测试 `tests/web-hub/agent/{wiring-hold,ui-status}.test.ts`、`tests/config/web-hub-settings.test.ts`、`tests/integration/web-hub-steer-recall.test.ts`（新）。**不改 `connection.ts`**。                                                                                                                                                                                                                      |
| **P-ui**         | `src/web-hub/ui/src/**` 中：`logic/{control,state}.js`、`components/control/{QueueList,Composer}.vue`、`components/detail/{DetailDock,AgentDetail}.vue`、`composables/useControl.ts`、`contracts.ts`、`types.ts`、`transport/types.ts`、`i18n/{en,zh}/control.ts`、`styles/control.css`；测试 `tests/web-hub/ui/**` 对应文件                                                                                                                                                                     |

### 2.2 合并顺序（唯一）

1. **P-protocol** 最先（冻结面 S1–S4 只是追加；P-core 的类型依赖它）。P-ui 可基于其首个 commit（S1–S3）开工。
2. **P-core（G0）** 第二：模块 + **真实 driver conformance 作为硬闸门**（R-D；§3.1）。参考 driver 行只是快速对照，不是闸门。任一硬闸门行失败即停工，回报 architect。
3. **P-wire** 等 P-core 合并后开工（装配、设置、集成测试要用真实模块与 hub 侧 S4）。
4. **P-ui** 最后合并。

设置相关文件只属于 P-wire；P-protocol 不改 `src/web-hub/agent/**` 与 `src/config/**`。

### 2.3 冻结面（P-protocol 首个 commit；逐字照抄）

**S1 `src/web-hub/protocol/version.ts`（追加）**

```ts
/** web-hub-steer-recall plan §2.3 S1. Agent advertises iff holdWired(settings) (hold.ts); the hub
 *  advertises on BOTH cap surfaces (HubInfo.caps / hello_ack.caps), same rule as DIALOG_BG_HUB_CAPS.
 *  The agent only ever HOLDS while `holdCap()` — link live ∧ hello_ack.caps ∋ hold.v1 — is true at
 *  that instant (pure read, no binding); it never needs the cap to DELIVER what it already holds. */
export const HOLD_CAP = "hold.v1";
export const HOLD_AGENT_CAPS = ["hold.v1"] as const;
export const HOLD_HUB_CAPS = ["hold.v1"] as const;
```

**S2 `src/web-hub/protocol/messages.ts` —— 类型（只追加成员）**

```ts
export type CmdOp =
  "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "dialog_answer" | "dialog_cancel" | "command" | "recall";

export type CmdArgs =
  | { op: "prompt"; text: string; deliver: "steer" | "followUp"; expect?: CmdExpect }
  | { op: "abort"; expect?: CmdExpect }
  | { op: "steer_subagent"; runId: string; text: string }
  | { op: "abort_subagent"; runId: string }
  | { op: "dialog_answer"; dialogId: string; epoch: string; answers: DialogAnswerWire[] }
  | { op: "dialog_cancel"; dialogId: string; epoch: string }
  | { op: "command"; name: string; args: string; confirm?: true; deliver?: "steer" | "followUp"; expect?: CmdExpect }
  | { op: "recall"; target: string };

export type PromptDelivery = "observed" | "unobserved" | "held";

export type RecallResultData =
  | { op: "recall"; outcome: "recalled"; from: "held" | "returned"; deliver: "steer" | "followUp"; text: string }
  | { op: "recall"; outcome: "too_late" };
export type CmdData = /* …existing members unchanged… */ RecallResultData;

export interface CtlItemWire {
  cmdId: string;
  op: CmdOp;
  state:
    | "dispatched"
    | "observed"
    | "started"
    | "queued"
    | "consumed"
    | "dropped"
    | "unconfirmed"
    | "running"
    | "ok"
    | "failed"
    | "late_ok"
    | "late_failed"
    | "held"
    | "recalled"
    | "returned";
  behavior?: "idle" | "steer" | "followUp";
  reason?: "unobserved" | "not-started" | "not-delivered" | "session" | "timeout" | "aborted" | "reload" | "stale";
  code?: CmdErrorCode;
  at: number;
  updatedAt: number;
}

export type HeldReturnReason = "aborted" | "session" | "reload" | "stale";
export const HELD_WIRE_MAX_ITEMS = 32;
export const HELD_CLIP_CHARS = 200;
export const RECALL_TEXT_MAX_BYTES = 48 * 1024;
export interface HeldItemWire {
  cmdId: string;
  text: string; // ≤ HELD_CLIP_CHARS UTF-16 units, clipped on a code-point boundary
  deliver: "steer" | "followUp";
  state: "held" | "returned";
  reason?: HeldReturnReason; // present iff state === "returned"
  sessionId: string;
  at: number;
}
export interface StatusInfo {
  /* …existing… */
  held?: HeldItemWire[]; // absent ⇔ empty / steerRecall off / holdWired false (NOT gated on holdCap(), D3)
  heldRev?: number; // monotonic per agent process; present iff `held` present
  heldEpoch?: string; // R-C merge scope: MODULE_INSTANCE of the publishing activate() (same value as CtlFrame.epoch); present iff `held` present
}
```

**S2' —— schema 的逐字改动**（`CmdSchema` 是封闭 union，必须加入 union 本身）：

```ts
const RecallArgsSchema = Type.Object(
  { op: Type.Literal("recall"), target: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }) },
  { additionalProperties: false },
);
// CmdSchema（现 messages.ts ≈L1213）：cmd: Type.Union([... CommandArgsSchema, RecallArgsSchema]),
// CtlItemSchema（≈L1341）：op union 末尾追加 Type.Literal("recall")；
//   state union 末尾追加 Type.Literal("held"), Type.Literal("recalled"), Type.Literal("returned")；
//   reason union 末尾追加 Type.Literal("aborted"), Type.Literal("reload"), Type.Literal("stale")。
const HeldItemSchema = Type.Object(
  {
    cmdId: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }),
    text: Type.String({ maxLength: 200 }),
    deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
    state: Type.Union([Type.Literal("held"), Type.Literal("returned")]),
    reason: Type.Optional(
      Type.Union([Type.Literal("aborted"), Type.Literal("session"), Type.Literal("reload"), Type.Literal("stale")]),
    ),
    sessionId: Type.String(),
    at: Type.Number(),
  },
  { additionalProperties: false },
);
// StatusInfoSchema（≈L924）追加：
  held: Type.Optional(Type.Array(HeldItemSchema, { maxItems: 32 })),
  heldRev: Type.Optional(Type.Integer({ minimum: 0 })),
  heldEpoch: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
export const RecallResultDataSchema = Type.Union([
  Type.Object(
    {
      op: Type.Literal("recall"),
      outcome: Type.Literal("recalled"),
      from: Type.Union([Type.Literal("held"), Type.Literal("returned")]),
      deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
      text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ op: Type.Literal("recall"), outcome: Type.Literal("too_late") }, { additionalProperties: false }),
]);
```

`CmdDataSchema` 仍是 `Type.Unknown()`。recall 结果由 hub 用 `RecallResultDataSchema` 另行校验（S4）。

**S3 `src/web-hub/protocol/http-contract.ts`**：`AgentCard` 追加 `hold?: true;`（仅当 agent caps 含 `hold.v1` 时写入）。

**S4 hub 契约**

- `parseCmdBody`（`hub/http.ts` ≈L1680-1707）新增 `case "recall"`：`target = field(body,"target")`，必须是字符串且通过 `CMD_ID_RE`，否则 400 `E_BAD_REQUEST`（"target required"）。转发帧**只**包含 `{ op:"recall", target }`，body 中其它字段一律丢弃。
- `requiredCaps("recall") = ["cmd.v1", "hold.v1"]`（`hub/commands.ts` ≈L90-100）。缺 cap ⇒ 409 `E_UNSUPPORTED`，不发帧，审计 `phase:"reject"`。
- recall 结果校验：`createCommandRouter` 执行路径的 `capOutputBudget(toBody(reply))`（≈L307）之后，若 `frame.cmd.op === "recall" && body.ok`，要求 `Value.Check(RecallResultDataSchema, body.data)` 且 `Buffer.byteLength(text) ≤ RECALL_TEXT_MAX_BYTES`，否则改为 `{ ok:false, code:"E_UNSUPPORTED", retryable:false, effect:"unknown", message:"bad recall result" }`，LRU 照常缓存。queryOnly 路径（≈L404）内嵌结果同样校验。
- `card()`（`hub/registry.ts` ≈L190-202）：`if (r.caps.includes("hold.v1")) c.hold = true;`；`toCard()`（`hub/http.ts` ≈L395-398）白名单补 `hold`。
- `HubInfo.caps`（`hub.ts`）与 `hello_ack.caps`（`agent-server.ts`）都在 `...DIALOG_BG_HUB_CAPS,` 之后插入 `...HOLD_HUB_CAPS,`。

**S5 agent 侧 cmd_result 语义**（P-agent 实现；P-ui 依赖）

| 情况                                                                                                                    | 回执                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| prompt 被扣留                                                                                                           | `ok {op:"prompt", delivery:"held", behavior}`，立即返回     |
| recall 命中 held / returned                                                                                             | `ok {op:"recall", outcome:"recalled", from, deliver, text}` |
| 目标已交给 pi（台账 `promptState ∈ {dispatched, observed, started, queued, consumed, dropped, unconfirmed, recalled}`） | `ok {op:"recall", outcome:"too_late"}`                      |
| 目标未知或不是 prompt                                                                                                   | `E_NOT_FOUND`（不可重试，会被缓存）                         |
| driver 不存在时收到 recall                                                                                              | `E_UNSUPPORTED`                                             |
| 同 id 重投                                                                                                              | 台账 dup，原样回放第一次的结果（含 text）                   |

**S6**：P-agent 的模块 API 见 §4.3（A1/A2），真实 driver 的 conformance 只依赖这些签名。

---

## 3. 测试闸门包

### 3.1 G0：真实 driver 路径矩阵（P-core 的硬闸门，R-D）

**文件**：`tests/conformance/steer-hold-driver.test.ts`。**搭建**：真实 `createAgentSession`（1.0.2）+ 假 `modelRuntime`（脚本化 toolCall/text/error，`authFail` 开关，工具 `sleep 0.05|0.3`）+ 探针扩展内装配**真实** `createHoldBuffer({ bag })` / `createHoldDriver()` / `createCommandHandler()` / `createCommandLedger({ bag })` / `createOriginEntry(pi)` / `queueMirror` / `compactionState`；`builtinBridge` stub；prompt 经 `commandHandler.handle(CmdFrame{op:"prompt"})` 注入；`holdCap` 用可切换布尔 stub（默认 true）；`setTimer`/`now` 用夹具——**确认阶段 timer 用 ref 的真实 timer**（R-B），30 s 显示 timer 与 tick 用可推进夹具。探针内**不使用任何测试开关**。**隔离**：`beforeEach` 删除 `globalThis[Symbol.for(...)]` 两个袋并重建；`afterEach` dispose driver / commandHandler / session，断言夹具无活动 timer。

**断言规则（每行）**：(a) 每个扣留 cmdId 恰好一个四类终局；(b) `session.messages` 中该正文作为 user 消息出现次数：handed ⇒ 1，其余 ⇒ 0；(c) 首次出现在第几个 LLM 请求；(d) 关键事件片段；(e) settled 时 `countHeld===0`、`phase==="idle"`、`inflight===undefined`；(f) 原 `session.prompt()` resolve；(g) 台账显示态序列（§5.4）。**不做墙钟断言**。

**行**：§1.2 的 D-M1…D-M30（M24b 对照除外），加：

- **D-ORIGIN**：origin 条目下标严格介于交接轮 assistant 条目与对应 user 条目之间；不断言相邻。
- **D-NATIVE-EQ**：M2 扣留版与原生立即发送版 `calls.length` 相同、首次出现下标相同。
- **D-ATTRIB**：归因机制（§5.2）：queueMirror 项带我们的 cmdId 仅当 `input.source==="extension"` 且正文全等且该 cmdId 是唯一在途；`message_start` 经 `dequeueByText` 命中带 cmdId 的项 ⇒ `consumed` ⇒ `onConsumed(cmdId)` ⇒ B1 解除。反例：同一正文的 TUI 消息（`source:"interactive"`）先入 mirror、无 cmdId ⇒ 它的 `message_start` 不解除 B1。
- **D-UPGRADE**（M27/M29 真实版）：推进显示 timer 30 s ⇒ 台账 `unconfirmed{unobserved|timeout}`；随后 input 观测 / 归因 `message_start` ⇒ 升级为 `observed→queued→consumed`，`text` 仍保留直到 consumed。
- **D-SWALLOW**（M28 真实版）：吞消息 handler ⇒ S1 永远 `unconfirmed`，S2 在 agent_end `returned{stale}`，`sendUserMessage` 对 S2 0 次。
- **D-TICK / D-CAP-GRACE / D-RELOAD / D-LEFTOVER**：见 v4.1 定义（§3.2 旧文），改为 B1 下每 tick 至多一条且阻塞时不发。

**硬闸门**：D-M1–D-M5、D-M8、D-M9–D-M11、D-M13、D-M13b、D-M14、D-M16–D-M18、D-M20、D-M22、D-M24、D-M25、**D-M27、D-M28、D-M29、D-M30**、D-ATTRIB、D-UPGRADE、D-SWALLOW。**验收**：全绿，连跑 20 次无抖动，单文件 < 60 s。

### 3.2 参考 driver 快速对照（同包，非闸门）

`tests/conformance/steer-hold-ref-driver.ts` = `matrix6.mjs` 的 `makeProbe` TS 移植；`tests/conformance/steer-hold.test.ts` 跑 §1.2 的 32 行。作用：pi 升级时的廉价绊线、与真实 driver 行的差分定位。所有行标注 run ✓（脚本）→ to-implement（本文件）。

## 4. P-protocol 与 P-agent 详细说明

### 4.1 P-protocol

修改清单见 §2.1，内容见 §2.3 S1–S4。**不碰 `src/web-hub/agent/**` 和 `src/config/**`。**

| 测试                                                   | 增量    | 固定的行为                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/web-hub/protocol/messages-hold.test.ts`（新）   | +14     | `decodeHubFrame({t:"cmd",…,cmd:{op:"recall",target}})` 通过；带 `expect`、多余键、target 不合法 ⇒ undefined；ctl 帧新 state/reason/op 通过；status 中 `held`（≤32 项、text≤200、严格键）与 `heldRev` 通过，越界 ⇒ undefined；`RecallResultDataSchema` 两分支通过，多余键 / `text:""` ⇒ 拒绝；不含新字段的 status/ctl 帧与改动前 fixture 逐字节相同 |
| `tests/web-hub/protocol/version.test.ts`               | +1      | `HOLD_*` 常量                                                                                                                                                                                                                                                                                                                                      |
| `tests/web-hub/hub/caps-coexist.test.ts`               | 改 1 +1 | 两个 cap 面集合相等且都含 `hold.v1`；只有 agent caps 含 `hold.v1` 时才有 `card.hold`，否则 `"hold" in card === false`                                                                                                                                                                                                                              |
| `tests/web-hub/hub/commands.test.ts`                   | +5      | 缺 cap ⇒ 409 且 socket 零帧；有 cap ⇒ 转发 `{op:"recall",target}`；结果不合 schema / text 超 48 KiB ⇒ `E_UNSUPPORTED effect:"unknown"`；queryOnly 内嵌结果同样校验；同 id 命中 LRU                                                                                                                                                                 |
| `tests/web-hub/http/api-cmd.test.ts`                   | +3      | target 缺失或不合法 ⇒ 400；body 里的 `expect` 不出现在转发帧；LAN 与 loopback 一致                                                                                                                                                                                                                                                                 |
| `tests/web-hub/hub/registry.test.ts`                   | +1      | re-hello 去掉 cap ⇒ card 不再有 `hold`                                                                                                                                                                                                                                                                                                             |
| `tests/integration/web-hub-recall-parse.test.ts`（新） | +3      | 真实 HTTP 前端 + 真实 unix socket + 假 agent 端：`POST /api/cmd {op:"recall", target, expect:{…}, junk:1}` ⇒ agent 侧原始帧 `decodeHubFrame` 成功且 `cmd` 严格等于 `{op:"recall",target}`；agent 回 `cmd_result` ⇒ HTTP 200 body 一致；agent 不广播 cap ⇒ 409 且无帧                                                                               |

### 4.2 P-agent：文件改动

| 文件                                     | 改动摘要                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/agent/hold.ts`（新）        | A1：进程级缓冲（纯数据，pi-free）+ `holdWired()` 门控纯函数                                                                                                                                          |
| `src/web-hub/agent/hold-driver.ts`（新） | A2：三阶段机、同步派发 + 有界确认、tick 规则                                                                                                                                                         |
| `src/web-hub/agent/commands.ts`          | A3：`handlePrompt` 扣留分支（先写台账）；`dispatchHeld` 同步两阶段提交；`handleRecall`；`handleAbort` 先通知 driver；`onInputEvent` 回调 `onObserved`                                                |
| `src/web-hub/agent/ledger.ts`            | A4：新状态；patch 可带 text；sweep 规则；`frame(…, {holdCap})` 降级                                                                                                                                  |
| `src/web-hub/agent/status.ts`            | A5：`readStatus` 第 9 参数 `held`                                                                                                                                                                    |
| `src/web-hub/agent/index.ts`             | A6：装配、handler 注册（唯一 owner）、`holdCap` 纯函数、TUI 标记、`onStateChange` 在 live 时 republish；`WebHubSettings.steerRecall?: boolean`                                                       |
| `src/config/settings.ts`                 | 默认（≈L896）`steerRecall: true`；`parseWebHubSettings`（≈L1672 附近）解析 boolean，非法值回落 `true`                                                                                                |
| `src/config/setting-specs.ts`            | `"webHub.steerRecall": bool("webHub.steerRecall", "web-hub: hold busy web steer/follow-up until pi's next queue drain so they can be recalled (default on)")`（放在 `webHub.autoStart` 之后，≈L253） |
| ~~`src/web-hub/agent/connection.ts`~~    | **不改**（C1）                                                                                                                                                                                       |

### 4.3 P-agent：模块 API（冻结）

**A1 `hold.ts`（pi-free，只 import 协议类型）**

```ts
import type { CmdOrigin, HeldItemWire, HeldReturnReason } from "../protocol/messages.js";

export const HOLD_MAX_ITEMS = 16;
export const RETURNED_MAX_ITEMS = 16;
export const RETURNED_TTL_MS = 30 * 60_000;
export const HOLD_MAX_MS = 30 * 60_000;

export function holdWired(s: { control?: boolean; steerRecall?: boolean }): boolean {
  return s.control !== false && s.steerRecall !== false;
}

export type HoldState = "held" | "handing" | "returned";
export interface HoldItem {
  readonly cmdId: string;
  readonly sessionId: string;
  readonly owner: string; // MODULE_INSTANCE of the activate() that held it
  readonly text: string;
  readonly deliver: "steer" | "followUp";
  readonly origin: CmdOrigin;
  readonly at: number;
  state: HoldState;
  reason?: HeldReturnReason;
  updatedAt: number;
}
export type RecallOutcome =
  | { kind: "recalled"; item: HoldItem; from: "held" | "returned" }
  | { kind: "too_late" } // state === "handing"
  | { kind: "unknown" }; // not in the buffer

export interface HoldBuffer {
  hold(item: Omit<HoldItem, "state" | "updatedAt">, now: number): boolean; // false ⇔ held(session) ≥ HOLD_MAX_ITEMS
  held(sessionId: string): readonly HoldItem[]; // FIFO by `at`
  countHeld(sessionId: string): number;
  /** linearization point: held → handing; undefined unless currently held. */
  takeForHandoff(cmdId: string, now: number): HoldItem | undefined;
  /** handing → removed (sent). */
  release(cmdId: string): void;
  /** held|handing → returned{reason}. */
  markReturned(cmdIds: readonly string[], reason: HeldReturnReason, now: number): HoldItem[];
  /** every held item of `sessionId` → returned{reason}; idempotent. */
  returnSession(sessionId: string, reason: HeldReturnReason, now: number): HoldItem[];
  /** session_start of a (possibly new) module instance: foreign-owner held → returned{reload};
   *  foreign-session held → returned{session}; foreign handing → dropped (already on pi's side). */
  adopt(owner: string, sessionId: string, now: number): { returned: HoldItem[]; droppedHanding: string[] };
  /** linearization point: held|returned → removed. */
  recall(cmdId: string, now: number): RecallOutcome;
  /** current session's held + every returned (any session), ascending `at`, clipped. */
  project(sessionId: string, now: number): HeldItemWire[];
  rev(): number; // bumps on every mutation
  sweep(now: number): string[]; // evicted cmdIds (returned TTL / cap)
  dispose(): void; // process-level bag: no-op on the data
}
export interface HoldBufferOptions {
  bag?: HoldBag;
} // tests inject a fresh bag (item 8)
export function createHoldBuffer(opts?: HoldBufferOptions): HoldBuffer;
```

存储：`globalThis[Symbol.for("pi-subagent:web-hub:hold-buffer")]` → `{ v: 1, rev, items: Map<cmdId, HoldItem> }`。与台账同模式；跨 `/reload` 存活，不跨 pi 进程。

**A2 `hold-driver.ts`**

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CmdOrigin } from "../protocol/messages.js";
import type { HoldBuffer, HoldItem, RecallOutcome } from "./hold.js";

export const HANDOFF_CONFIRM_MS = 200; // the ONE bounded await per hook
export const HANDOFF_POLL_MS = 2; // hasPendingMessages() poll granularity inside that await
export const HOLD_CAP_GRACE_MS = 15_000; // cap continuously unavailable this long ⇒ tick hands out / returns
export type HoldPhase = "idle" | "armed" | "between";
export type DispatchOutcome = "sent" | "threw" | "refused";

export interface HoldRequest {
  cmdId: string;
  text: string;
  deliver: "steer" | "followUp";
  origin: CmdOrigin;
}
export interface TurnEndLike {
  message?: { content?: unknown };
  outcome?: string;
}

export interface HoldDriverDeps {
  buffer: HoldBuffer;
  owner: string;
  getSessionId(): string;
  /** PURE read of the current link: conn live ∧ hello_ack.caps ∋ hold.v1 (index.ts isLiveWithCap). */
  holdCap(): boolean;
  /** commands.dispatchHeld — synchronous CALL (the enqueue underneath is async, §5.2); never touches
   *  the buffer, never calls onReturned (D5: the driver is the single owner of markReturned/onReturned). */
  dispatchToPi(item: HoldItem): DispatchOutcome;
  onReturned(items: readonly HoldItem[]): void; // ledger → returned{reason}; called ONCE per hook/tick with the failed set
  publish(): void;
  now(): number;
  setTimer(ms: number, fn: () => void): { cancel(): void }; // unref'd
  nextMacrotask(): Promise<void>;
}
export interface HoldDriver {
  canHold(req: HoldRequest, ctx: ExtensionContext): boolean;
  hold(req: HoldRequest): boolean;
  recall(target: string): RecallOutcome;
  onContext(ctx: ExtensionContext): void; // → armed (unless signal aborted / abortLatched)
  onAssistantMessageStart(ctx: ExtensionContext): void; // fallback arm from idle/between
  onTurnStart(ctx: ExtensionContext): void; // phase still armed ⇒ turn_end was skipped ⇒ sync pass (steers)
  onTurnEnd(ev: TurnEndLike, ctx: ExtensionContext): Promise<void> | undefined;
  onAgentEnd(ctx: ExtensionContext): Promise<void> | undefined;
  onAgentSettled(ctx: ExtensionContext): void; // NEVER dispatches
  onObserved(cmdId: string): void; // commands.onInputEvent matched this cmdId (input layer)
  onConsumed(cmdId: string): void; // commands.onMessageStart consumed OUR cmdId (attributed via mirror cmdId) ⇒ lifts B1 — the ONLY lift besides enqueue-confirmed
  onWebAbort(): void;
  onSessionStart(ctx: ExtensionContext): void;
  onSessionShutdown(reason: string): void;
  onTick(ctx: ExtensionContext | undefined): void; // HOLD_MAX_MS, cap grace, sweep — never touches phase
  heldCount(): number;
  phase(): HoldPhase;
  dispose(): void;
}
export function createHoldDriver(deps: HoldDriverDeps): HoldDriver;
```

闭包状态：`phase`、`abortLatched`、`capDownSince: number | undefined`、`inflight: { cmdId; enqueued: boolean } | undefined`（B1）、`waiters: Map<cmdId, () => void>`（确认等待表）、`sessionId` 快照。**模块作用域没有可变状态；没有批次对象、没有令牌、没有 deferred 表。**

### 4.4 P-agent：`commands.ts` 改动（A3）

1. 新增 deps：`hold?: () => HoldDriver | undefined`。
2. **`handlePrompt` 扣留分支**（先写台账）：前置校验（`beginOrReply`、ctx、`expect.sessionId`、空白/48 KiB、`manualCompacting`）全部保留，在现有 `updatePrompt(dispatched)`（≈L209）之前插入：
   ```ts
   const drv = deps.hold?.();
   const req = { cmdId: frame.id, text: cmd.text, deliver: cmd.deliver, origin: frame.origin };
   if (drv !== undefined && drv.canHold(req, ctx)) {
     deps.ledger.updatePrompt(frame.id, { promptState: "held", behavior: cmd.deliver }, deps.now());
     if (drv.hold(req)) {
       deps.onChanged();
       return settleAndReply(frame, okResult({ op: "prompt", delivery: "held", behavior: cmd.deliver }));
     }
   }
   deps.ledger.updatePrompt(frame.id, { promptState: "dispatched", text: cmd.text }, deps.now()); // 原生路径；也覆盖 hold() 失败的回滚
   ```
   origin entry 不在扣留时写（撤回的消息不留孤儿 origin 行），改在 `dispatchHeld` 里写。
3. **`dispatchHeld(item): DispatchOutcome`** —— **一个不含 `await` 的同步函数**（它的**调用**是同步的；`sendUserMessage` 底下的入队是异步的，由 driver 的确认阶段与 B1 处理，§5.2）。它**只做台账 + origin + 调用**，不碰缓冲、不调 `onReturned`（D5）：
   - 实际调用 = `deps.pi.sendUserMessage(item.text, { deliverAs: item.deliver, expandPromptTemplates: false })`。调用链：`ExtensionAPI.sendUserMessage`（`$PI/extensions/loader.js:306-309`）→ runtime（`$PI/agent-session.js:2676-2683`，`.catch → emitError`）→ `AgentSession.sendUserMessage`（`:1812-1838`，`source:"extension"`）→ `prompt()`（`:1481`）→ 因 `isStreaming` ⇒ `_queueSteer/_queueFollowUp`（`:1515-1525`）。
   - 观测在发送**之前**登记（现有 finding 3 的规则），**复用现有 `onInputEvent`**：input 带 `streamingBehavior` ⇒ `observed(behavior) → queued`、入 queueMirror、`scheduleQueuedTimeout`；之后 user `message_start` ⇒ `consumed`。匹配到台账项时调用 `drv.onObserved(cmdId)`（输入层证据）；`onMessageStart` 经 mirror 项的 cmdId 把它标为 `consumed` 时调用 `drv.onConsumed(cmdId)`（归因的消费层证据，解除 B1）。**升级路径（R-A / M27）**：`findDispatchedByText` 改为匹配 `promptState ∈ {dispatched, unconfirmed}` 且保留 `text` 的条目（`unconfirmed` 不再清 `text`，直到 `consumed`/`dropped`），所以 30 s 之后迟到的 `input` 仍能把条目从 `unconfirmed` 升级为 `observed → queued → consumed`。held 路径的 HTTP 回执早已发出，所以**不**调用 `registerObservation`（它会再回一次 HTTP），只做 `scheduleUnobservedFinalize(cmdId)`（抽出现有 30 s `unobserved` 终结 timer 为独立函数，CAS 条件 `promptState==="dispatched"` 不变）。
   - 步骤见 §5.3。
4. **`handleRecall`**：`beginOrReply(frame)`；driver 缺失 ⇒ `E_UNSUPPORTED`；`drv.recall(target)`；结果经唯一构造点 `toRecallResult(outcome, item?)` 产出 `RecallResultData`；`recalled` ⇒ 同时把目标台账项 `updatePrompt(target, { promptState: "recalled" })`；`too_late`/`unknown` 按 S5 映射（查台账 `op==="prompt"` 与 `promptState`）；**先 `ledger.settle`，再 `try { deps.send(frame) } catch {}`**（台账是内存，发送失败后 hub/浏览器经 queryOnly 取回，§5.8）。
5. `handleAbort`：在 `ctx.abort()` 之前调用 `drv?.onWebAbort()`。
6. `handle()`：把 `recall` 路由到 `handleRecall`。

### 4.5 P-agent：`ledger.ts`（A4）

- `PromptSubState` 加 `"held" | "recalled" | "returned"`；`PromptReason` 加 `"aborted" | "reload" | "stale"`。
- `updatePrompt` 的 patch 类型扩为 `Partial<Pick<LedgerEntry, "promptState" | "behavior" | "reason" | "text">>`；进入 `recalled | returned` 时与其它终态一样清 `text`。
- `sweep`（≈L135）：跳过 `promptState==="held" && now - updatedAt ≤ 60*60_000` 的条目（即使台账与缓冲不一致，held 条目也不会永久残留）。
- **`frame(sessionId, epoch, now, opts?: { filterHeld?: boolean })`**：`filterHeld === true`（链路 live 且 hub 明确没有 cap，§4.7 第 11 条）时：`op==="recall"` 条目整条过滤；`held` 条目**整条过滤**；`recalled | returned` ⇒ `"dropped"` + reason `"not-delivered"`；其余条目上 reason 为 `aborted | reload | stale` ⇒ `"not-delivered"`。不传 opts 且台账无新状态时输出与现状逐字节相同。断链期间（`filterHeld` 为假）投影完整，slot 回放到任何 hub 都正确；旧 hub 的封闭 schema 会丢弃含新 state 的 ctl 帧，直到 live 后的 republish（§4.7 第 9 条）给它过滤版。
- 台账是**进程内存**（`Symbol.for` 袋），不落盘。

### 4.6 P-agent：`status.ts`（A5）

`readStatus` 加第 9 个可选参数 `held?: () => { items: HeldItemWire[]; rev: number; epoch: string } | undefined`（现有 8 个：ctx, tap, fleet, queueMirror, todo, worktrees, bashJobs, quota）。`items` 非空时写 `status.held = items; status.heldRev = rev; status.heldEpoch = epoch`，否则三个字段都缺省。

### 4.7 P-agent：`index.ts` 装配（A6）

**唯一 owner**：`wireWebHub()` 是所有新 handler 的唯一注册者，每个 `activate()` 只被调用一次；`/new`、`/resume`、`/fork` 不重新注册；`/reload` 时 pi 丢弃旧 runner，新实例在 `session_start` 时 `adopt` 进程级缓冲。

`holdOn = holdWired(settings)` 为假时：不创建 driver、不注册 handler、不加 cap。为真时：

1. `holdBuffer = createHoldBuffer()`。
2. `const holdCap = () => conn?.status().state === "live" && (conn?.caps.includes(HOLD_CAP) ?? false);`（与 `isLiveWithCap` 同式，≈L1145）。
3. 创建 `commandHandler`（≈L627），deps 加 `hold: () => holdDriver`。
4. 创建 `holdDriver`，deps：`buffer`, `owner: MODULE_INSTANCE`, `getSessionId`, `holdCap`, `dispatchToPi: (it) => commandHandler.dispatchHeld(it)`, `onReturned`（写台账 `returned{reason}`）, `publish: () => { publishStatus(); publishCtl(); refreshStatusLine(); }`, `now`, `setTimer`（unref 版本，同 ≈L643）, `nextMacrotask: () => new Promise(r => setImmediate(r))`。
5. 在 FORWARDED 循环（≈L975）**之后**依次 `on("context")`、`on("turn_start")`、`on("turn_end")`、`on("agent_end")`、`on("agent_settled")`。每个 handler 首行 `if (!attached) return undefined; if (c !== undefined) ctx = c;`。`turn_end`/`agent_end` 只返回 `undefined | Promise<void>`，**永不返回 `entries`/`continue`**。
6. FORWARDED 循环的 `message_start` 分支（≈L981）：assistant 消息时调用 `holdDriver.onAssistantMessageStart(ctx)`。
7. `session_start`（≈L918 之前）/ `session_shutdown`（≈L950 之前）：在 `commandHandler.onSessionBoundary()` 之前分别调用 `onSessionStart(ctx)` / `onSessionShutdown(reason)`。
8. `onTick`（≈L541）末尾调用 `holdDriver.onTick(ctx)`。
9. `binding.onStateChange(v)`（≈L755）：追加 `if (attached && v.state === "live") { publishStatus(); publishCtl(); }`——新链路拿到按当前 `capKnownAbsent()` 过滤的 ctl（slot 回放发生在 `notify()` 之前，`connection.ts:562-573`）。这是对现有消费者**唯一**的改动，幂等 setSlot。
10. `publishStatus`：`readStatus(..., holdOn ? () => ({ items: holdBuffer.project(sid, now()), rev: holdBuffer.rev(), epoch: MODULE_INSTANCE }) : undefined)`（`heldEpoch`，R-C）——**只按 `holdWired` 门控，不按 `holdCap()`**（D3）：`StatusInfoSchema` 开放，旧 hub 不会丢帧；断链期间存入 slot 的投影是完整的，回放到新 hub 时正确。
11. `publishCtl`（≈L620）：`commandLedger.frame(sessionId, MODULE_INSTANCE, now(), { filterHeld: capKnownAbsent() })`，其中 `capKnownAbsent = () => conn?.status().state === "live" && !(conn?.caps.includes(HOLD_CAP) ?? false)`——只有**链路 live 且 hub 明确没有 cap**（它的封闭 `CtlItemSchema` 会整帧丢弃 `state:"held"`）才过滤；断链期间不过滤。
12. **`/reload` handover**（D4）：`acquireConnection()` 发现 implVersion 不同 ⇒ 旧连接 `close("handover")`、新连接建立（`connecting`→`live`）。期间 `holdCap()` 为假 ⇒ 不扣留；旧实例在 `session_shutdown("reload")` 把 held ⇒ returned{reload}；新实例 `onSessionStart` 的 `adopt` 兜底处理旧 owner 的残留；新链路 live ⇒ republish 带 `held`（returned 项）的 status。
13. `capsExtra()`（≈L833）：`holdWired(settings)` ⇒ 追加 `HOLD_AGENT_CAPS`。
14. TUI 标记：`statusLineText(v, theme, extra?: { held?: number })`，`held > 0` ⇒ 在 web token 后追加 ` held N`，渲染 `web ● held 2`；不传 extra 时输出不变。

## 5. 暂存消息状态机

### 5.1 阶段机（每个 driver 一个）

| 当前阶段         | 触发                      | 动作 → 下一阶段                                                                                                                                                                                                              |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任意             | `onSessionStart(ctx)`     | `adopt(owner, sid)` ⇒ `onReturned`；phase=`idle`；清 `abortLatched`、`capDownSince`、`waiters`；publish                                                                                                                      |
| 任意             | `onSessionShutdown(r)`    | `returnSession(sid, r==="reload" ? "reload" : "session")` ⇒ `onReturned`；phase=`idle`；清 `waiters`；publish                                                                                                                |
| `idle`/`between` | `onContext`               | `ctx.signal?.aborted !== true && !abortLatched` ⇒ `armed`                                                                                                                                                                    |
| `idle`/`between` | `onAssistantMessageStart` | 同 `onContext`（兜底：pi 版本漂移导致没有 `context` 事件时仍能 arm；同一请求内 `context` 已 arm 时无动作）                                                                                                                   |
| `armed`          | `onTurnStart`             | **跳过检测（best-effort）**：有 held ⇒ 同步派发 steer（§5.2 pass，`allowFU=false`）；无论有无 ⇒ `between`                                                                                                                    |
| 其它             | `onTurnStart`             | 无动作                                                                                                                                                                                                                       |
| 任意             | `onTurnEnd`               | aborted ⇒ 全部 returned{aborted}，`between`，返回 `undefined`；缓冲为空 ⇒ `between`，`undefined`；否则 §5.2 hook（`allowFU` = 停下轮规则）。不看当前 phase：有 held 就交（按 I-EMPTY，held 非空只可能发生在本请求 arm 之后） |
| 任意             | `onAgentEnd`              | aborted ⇒ returned；缓冲为空 ⇒ `between`；否则 §5.2 hook（`allowFU=true`）                                                                                                                                                   |
| 任意             | `onAgentSettled`          | 残留 ⇒ `markReturned(all held, "stale")` + `onReturned`（**零次 dispatch**）；phase=`idle`；清 `abortLatched`；publish                                                                                                       |
| 任意             | `onWebAbort`              | `abortLatched=true`；当前会话全部 held ⇒ returned{aborted}；publish                                                                                                                                                          |
| 任意             | `onTick`                  | §5.6；**不改 phase**                                                                                                                                                                                                         |

**`canHold(req, ctx)` 为真的条件（全部满足）**：`deps.holdCap()`；phase === `armed`；`!ctx.isIdle()`；`ctx.signal?.aborted !== true`；`!abortLatched`；文本首个非空白字符不是 `@`；`countHeld(sid) < HOLD_MAX_ITEMS`；`ctx.sessionManager.getSessionId() === getSessionId()`。

### 5.2 hook 算法（turn_end / agent_end 共用；turn_start 跳过检测与 tick 只用第 2–4 步）

四层术语（D6）：**缓冲层**（held/handing/returned，本模块拥有）→ **调用层**（`pi.sendUserMessage` 同步返回；底下 runtime 的 async `sendUserMessage` 被 `.catch()`）→ **入队层**（`prompt()` `await _runInputHandlers` **之后** `_queueSteer/_queueFollowUp` push，`$PI/agent-session.js:1502, 1515-1524`）→ **消费层**（取队点 drain ⇒ user `message_start`）。本模块能直接观测的只有缓冲层、调用层和消费层；入队层只有 `ctx.hasPendingMessages()` 这个布尔值（`pendingMessageCount > 0`，`:1856-1858, 2728`）。

**B1（阻塞规则，I-SERIAL，R-A）**：`inflight` 记录最近一次发出、尚未取得正面证据的 cmdId。`blocked() = inflight !== undefined && !inflight.enqueued && !inflight.consumed`。两种解除证据，**都关于我们这一条**：(E1) 入队确认——发送前 `hasPendingMessages()` 为 false、我们只有这一条在途、确认阶段内翻为 true、且自家 `input` 观测器已见到它；(E2) **归因消费**——`commands.onInputEvent` 在 `ev.source === extension` 且正文全等于这条在途项时把 queueMirror 项打上它的 cmdId（这是现有 control-plan 的 web 来源归因，终端消息（source interactive/rpc）永不带 cmdId），随后 `onMessageStart` 经 `dequeueByText` 命中**带该 cmdId** 的项 ⇒ `consumed` ⇒ `onConsumed(cmdId)`。**没有超时解除**。`blocked()` 为真时任何 hook / tick 都不发送，后续项保持 held（可撤回/编辑）；**agent_end 时若 `blocked()` ⇒ 当前会话全部 held ⇒ `returned{stale}`**（回到浏览器，绝不自动发）；settled 兜底同样处理。

```
hook(trigger, ctx, allowFU):
  1. aborted ⇒ 全部 returned{aborted}；phase=between；return undefined
  2. if blocked():  trigger==="agent_end" ⇒ 全部 held → returned{stale}（R-A）     // run 要结束了，退回浏览器
                    否则 phase=between；publish；return undefined                 // 本 hook 不发；项保持 held
  3. pick = 首个 held steer，否则（allowFU 时）首个 held followUp；无 ⇒ phase=between；return undefined
     pendingBefore = ctx.hasPendingMessages()
     outcome = dispatchHeld(pick)                                      // 同步调用，§5.3
     "sent"    ⇒ release(pick)；inflight = { cmdId: pick, enqueued: false }
     其它      ⇒ markReturned([pick], "stale")；onReturned([pick])       // driver 是唯一所有者（D5）
  4. phase = between；publish()                                          // 在任何 await 之前
  5. outcome !== "sent" ⇒ return undefined
  6. return confirm(pick, ctx, pendingBefore)                           // 唯一的有界确认阶段

confirm(cmdId, ctx, pendingBefore):                                      // 总上界 200 ms + 1 macrotask
  deadline = now + HANDOFF_CONFIRM_MS；cap = setTimer(200)（unref；结束后 cancel）
  await race(waiters[cmdId], cap)                                        // 输入层：自家 input 观测
  if (!timedOut && !pendingBefore):
      while (!ctx.hasPendingMessages() && now < deadline) await setTimer(HANDOFF_POLL_MS)   // ≤100 次
      if (ctx.hasPendingMessages() && observed(cmdId)) inflight.enqueued = true   // 入队层证据：唯一在途 + false→true 翻转
      else timedOut = true
  if (!timedOut) await nextMacrotask()
  cancel(cap)
```

- **每个 hook 至多发一条**。pi 默认 one-at-a-time（`$AC/agent.js:60-82` `peek()` 每次一条），每个取队点本来只取一条，所以这**不增加任何延迟**（M20：S-A/S-B 落点与 v4 并发版、与原生相同）。`"all"` 模式下第 2 条起晚一轮（M26，接受）。
- **入队证据（E1）的精确含义**：发送前布尔为 false ⇒ 此刻队列为空且本模块只有这一条在途 ⇒ 之后的 false→true 翻转只能是它（或一条恰好同时到达的终端消息——残余风险见 §11 R9）。再要求自家 `input` 观测器已看到它（必要条件）。满足 ⇒ `enqueued=true`，B1 立即解除。`pendingBefore===true` ⇒ E1 不可得：这条标为 `unverifiable`，B1 **只**由 E2（归因消费）解除；one-at-a-time 下这与原生落点相同（M25）。
- **确认阶段超时（慢第三方 handler）**：handler 在 200 ms 处 resolve 让 pi 继续；那条消息仍在 pi 的 `prompt()` 链上，显示态由台账决定（30 s 后 `unconfirmed`，证据到达即升级，§5.4）；**后续项保持 held、可撤回**，被 B1 阻塞直到 E1/E2（M24：S2 在 S1 被 `:186` 取走、归因消费后的下一个 turn_end 发出；M29：显示 `unconfirmed` 之后 S1 落地升级，S2 才发）。若 run 在此之前结束 ⇒ agent_end 阻塞 ⇒ 后续项 `returned{stale}`（M27）；吞消息 / 永久挂起的 handler 同理（M28）——不丢（可重发）、不重、不乱序。
- `allowFU`（turn_end）= `outcome==="completed" && assistant 无 toolCall && 本批无 steer && !ctx.hasPendingMessages()`；agent_end 恒为 true；turn_start 跳过检测恒为 false。
- **不变量 I-SYNC**（收窄表述）：第 3 步是一个不含 `await` 的同步块；它只保证缓冲层/台账/调用层的原子性，**不**保证入队层——入队层的交错由 B1（串行）消除。
- **不变量 I-EMPTY**（§1.1）与例外 M27。
- turn_end handler 只在实际发出一条时返回 Promise，否则同步返回 `undefined`；无扣留时零开销。

### 5.3 `dispatchHeld(item)`：同步调用层（commands.ts）与缓冲层所有权（driver）

| 步骤 | 位置                  | 动作                                                                                                                                        | 失败处理                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P1   | driver                | `buffer.takeForHandoff(cmdId)`（held → handing，线性化点；与 `recall` 互斥）                                                                | undefined ⇒ 跳过（已被撤回）                |
| P2   | commands.dispatchHeld | 前置检查：`ctx` 存在且会话一致、`!manualCompacting`                                                                                         | ⇒ `"refused"`                               |
| P3   | commands.dispatchHeld | 台账 `dispatched` + `text`；`scheduleUnobservedFinalize(cmdId)`（30 s，CAS）                                                                | 抛错 ⇒ `"refused"`（撤销 P3 已做的部分）    |
| P4   | commands.dispatchHeld | `appendOrigin("prompt", cmdId, origin, deliver)`（自吞异常）                                                                                | 不影响后续                                  |
| P5   | commands.dispatchHeld | `deps.pi.sendUserMessage(text, { deliverAs, expandPromptTemplates:false })`（**调用同步返回；入队异步**）                                   | 同步抛 ⇒ 撤销 P3 登记，返回 `"threw"`       |
| P6   | **driver**            | `"sent"` ⇒ `release(cmdId)` + `inflight=…`；`"refused"/"threw"` ⇒ `markReturned([cmdId],"stale")` + `onReturned([…])`（**唯一调用点**，D5） | `onReturned` 抛错被吞；台账由 30 s 规则收敛 |
| P7   | driver                | `publish()`（每个 hook / tick **一次**）                                                                                                    | 忽略                                        |

`dispatchHeld`（P2–P5）**不碰缓冲、不调 `onReturned`**；用局部变量 `sentCalled` 标记 P5 是否已执行：执行之后的任何异常一律视为 `"sent"`（绝不出现「已发出又被退回」）。P1–P7 全部同步。故障注入测试：hold-faults（P2 / P3 抛错 / P4 / P5 同步抛 / P5 之后抛 / onReturned 抛 / publish 抛），**per-outcome**：`sent` ⇒ `onReturned` 0 次、`publish` 1 次；`refused`/`threw` ⇒ `onReturned` 恰 1 次且参数恰为该项、`publish` 1 次。

### 5.4 单条消息状态与四类结局

| 缓冲       | 台账                                       | ctl          | status.held                 |
| ---------- | ------------------------------------------ | ------------ | --------------------------- |
| `held`     | `held`                                     | `held`       | `{state:"held"}`            |
| `handing`  | `dispatched`(text)                         | `dispatched` | 不出现                      |
| （移除）   | `observed → queued → consumed`；未确认见下 | 同台账       | 不出现                      |
| `returned` | `returned{reason}`                         | `returned`   | `{state:"returned",reason}` |
| （移除）   | `recalled`                                 | `recalled`   | 不出现                      |

**每个被扣留的 cmdId 最终恰好落入一类**（测试分别断言）：

1. **handed-confirmed**：P5 返回 `sent`，台账到达 `observed`（之后 `queued`/`consumed`）。
2. **handed-unconfirmed**：P5 返回 `sent`，台账显示态 `unconfirmed{unobserved}`（30 s 内 input 未观测到——被前序 handler `handled`，或 `.catch → emitError`）或 `unconfirmed{timeout}`（现有 queued 超时规则）。**R-A：这是「可能已送达」的可升级显示态，不是硬终局**——迟到的 input 观测 / 归因 `message_start` 把同一条目升级为 1（M27/M29），UI 文案 `unconfirmedNote`「可能已送达；若模型读到会自动更新」。**没有** `not-started`/`stale` 分支。
3. **returned**：从未调用 `sendUserMessage`，或同步抛错，或前置拒绝；台账 `returned{aborted|session|reload|stale}`。
4. **recalled**：用户在 held / returned 状态下取回；台账 `recalled`。

`prompt()` 的异步结局表：

| 结局                                                 | 台账终局                          | 类别        |
| ---------------------------------------------------- | --------------------------------- | ----------- |
| 流式入队（唯一的正常路径）                           | observed → queued → consumed      | confirmed   |
| input 之前失败（前序 handler `handled`；emitError）  | 30 s 后 unconfirmed{unobserved}   | unconfirmed |
| 入队后 pi 队列被清（TUI abort 收回编辑器、会话边界） | dropped（现有 queue-mirror 规则） | 现状        |

### 5.5 timer 所有权与 CAS 规则（评审 item 6）

| timer                                    | 所有者                   | 取消                       | 回调写入前的 CAS 条件                          |
| ---------------------------------------- | ------------------------ | -------------------------- | ---------------------------------------------- |
| 确认上限 200 ms（`cap`）                 | 当次 `confirm()` 调用    | race 结束后立即 `cancel()` | 不写任何状态，只结束等待                       |
| 2 ms 轮询                                | 当次 `confirm()` 调用    | 自然到期                   | 同上                                           |
| 30 s `unobserved` 终结                   | commands（现有）         | 不取消；靠 CAS             | `ledger.get(id)?.promptState === "dispatched"` |
| `queued` 超时                            | commands（现有）         | 不取消；靠 CAS             | `promptState === "queued"`                     |
| `HOLD_MAX_MS` / 宽限 / `RETURNED_TTL_MS` | 1 Hz tick（现有，unref） | —                          | 读缓冲当前状态                                 |

**T-REF（R-B）**：pi 正在 await 的任何 promise 都不得依赖 unref 的 timer——确认阶段的 cap/轮询 timer 是 ref 的（≤200 ms，有界，不会 wedge `pi -p`）；30 s 显示 timer 与 1 Hz tick 从不门控 pi await 的 promise，保持 unref。

规则：**每个终结回调都重新读取条目，只在条目仍处于它被武装时的状态才写**；没有任何回调持有对旧对象的引用后直接写。`waiters` 表在 `onObserved`、`onSessionStart/Shutdown` 与 `dispose` 时清理；一个不再被等待的 `onObserved` 是 no-op。`inflight` 只在 `enqueued=true`、`onConsumed(cmdId)`、会话边界与 `dispose` 时清除——**没有任何 timer 清除它**（R-A）。

### 5.6 tick 规则（`onTick(ctx)`，每秒，不改 phase）

```
1. cap：if (!deps.holdCap()) capDownSince ??= now else capDownSince = undefined
   if (capDownSince !== undefined && now - capDownSince ≥ HOLD_CAP_GRACE_MS && countHeld > 0) flush(all held)
2. 寿命：flush(held items with now - at ≥ HOLD_MAX_MS)
3. sweep：buffer.sweep(now) ⇒ 台账同步删项（recalled/returned 条目按现有 TTL 自然淘汰）

flush(items)（同步；每 tick 至多派发一条，受 B1 约束 —— I-SERIAL）:
  returnedSet = []
  for item: if (ctx === undefined || item.sessionId !== getSessionId()) ⇒ returnedSet += markReturned([item], stale)
            else if (ctx.signal?.aborted || abortLatched) ⇒ returnedSet += markReturned([item], aborted)
            else if (ctx.isIdle()) ⇒ returnedSet += markReturned([item], stale)          // 按 I-EMPTY 不可能，防御
            else if (!blocked() && !sentThisTick) { outcome = dispatchHeld(item)；P6（sent ⇒ inflight）；sentThisTick = true }
            else 留在 held，下一 tick 再派                                               // 结局类别由台账决定
  returnedSet 非空 ⇒ onReturned(returnedSet)（一次）；publish()（一次）
```

flush 受 B1 约束：每 tick 至多一条，且前一条无证据时不发；因此 **没有「≤16 s」的 SLA**（意见 6）——上界是 run 结束（agent_end 把剩余项退回）。期间项保持 held、可撤回。

- `holdCap()` 为假的那一刻起 `canHold` 为假 ⇒ **不创建新的扣留**（新 prompt 走原生）。已有扣留照常在 turn_end/agent_end 交接；只有当 cap 持续 15 s 不可用（hub 停止 / 重启失败 / 被换成无 cap 的 hub）才在 tick 中交出：此时浏览器既看不到也撤回不了它们，继续扣留只增加延迟；busy 时交出等价于原生在该时刻发送。15 s 依据：hello_ack 超时 2 s + hub 拉起 + 退避 0.5/1/2/4/8 s ≈ 15.5 s，覆盖常规 `/webhub restart` 与版本替换。
- 新 hub（任何版本）连上后：`onStateChange(live)` republish ⇒ 新 hub 拿到按 `holdCap()` 投影的 status/ctl。无 cap 的 hub 收到的 ctl 不含 held 条目（§4.5 过滤），status 不含 `held`。有 cap 的 hub 立即看到当前 held 列表，撤回继续可用——**不要求同一 hub 实例**（撤回只依赖 agent 侧缓冲与台账）。
- 没有 `onLink`、没有 binding、没有「cap_lost 先交出后切投影」：投影永远是 `holdCap()` 此刻的纯函数。

### 5.7 有界等待与 timer 清单

| 项目                        | 上界                  | 实现                                     |
| --------------------------- | --------------------- | ---------------------------------------- |
| 每个 hook 的 await          | 200 ms + 1 macrotask  | `confirm()`：一个 unref cap timer + race |
| cap 不可用宽限              | 15 s（tick 粒度 1 s） | 1 Hz tick                                |
| held 寿命                   | 30 min                | tick                                     |
| returned                    | 30 min / 16 项        | tick                                     |
| unobserved / queued timeout | 30 s / 现有           | 现有 unref timer + CAS                   |

### 5.8 recall 结果的类型化边界

- agent：`toRecallResult(outcome, item?)` 是唯一构造点，返回 `{ ok:true, data: RecallResultData }`。**先 `ledger.settle(result)`，再 `try { deps.send(frame) } catch {}`**。台账在进程内存中（不是磁盘）；发送失败时 hub 侧表现为 503 `E_AGENT_GONE{effect:"unknown"}` / 504 `E_DEADLINE`，浏览器发起 queryOnly，`handleQueryOnly` 返回 `{op:"query", state:"ok", result}` 内嵌类型化结果，hub 校验（S4）后交给浏览器。重连后同 id 重投命中台账 dup。
- hub：执行路径与 queryOnly 路径都用 `RecallResultDataSchema` + 48 KiB 字节上限，不通过即改写为 `E_UNSUPPORTED{effect:"unknown"}` 并记审计。
- 测试：**RB1**（commands-hold）`deps.send` 抛错 ⇒ queryOnly 返回内嵌结果含 text；**RB2**（integration）hub 丢弃 `cmd_result` ⇒ 503/504 → queryOnly 拿到 recalled+text；**RB3**（hub commands）伪造超长/多余键 ⇒ 改写。

## 6. 有界性声明

**本模块保证：不新增任何无上界的 await。** 每个 hook 至多**一个有界确认阶段**，其中包含**有限个** timer await（1 个 200 ms cap + ≤ 100 次 2 ms 轮询 + 1 个 macrotask），总上界 200 ms + 1 macrotask；每次等待都与本模块自己的 unref timer race。确认阶段开始前已经完成了本 hook 的全部缓冲层/调用层副作用（恰好一条），所以**等待超时不会留下任何「发到一半」的项**：未发的项仍在缓冲里（held，可撤回），已发的那条由台账收敛。B1 阻塞**不靠 timer**：由 E1/E2 证据解除，否则在 agent_end 把剩余项退回浏览器（R-A）。确认阶段 timer ref、其余 unref（T-REF，R-B）。

**不保证**：pi 与第三方 handler 的耗时；`sendUserMessage` 触发的 input 链何时完成（M13c/M24：超过上限时那条消息晚一个取队点或成为 run 后的新 prompt，仍恰好一次；M27：run 结束 ⇒ 后续项 returned{stale}）。测试：让观测永不触发 ⇒ 200 ms 后 promise settle、cap timer 已 cancel；B1 在 30 s 后**仍然**阻塞（D-SWALLOW），agent_end 退回剩余项。

## 7. P-ui

与 v3 相同，加上 v4.2 的 **U-MERGE 规则**（R-C，取代 v4.1 的 U-KEEP）：(1) per-cmdId **tombstone**：一旦本地看到某 cmdId 的终态（ctl `recalled` / `returned` / `dispatched`及之后的 handed 态 / `unconfirmed`，或本地 recall 成功），该 cmdId 永不再由任何 status 快照复活；(2) 快照只能**新增**未 tombstone 的行、更新已有行；(3) 快照作用域 `{agentKey, sessionId, heldEpoch}`——`heldRev` 只在同一作用域内比较（更小的丢弃），作用域不同（agent 重启 / `/reload` 新 epoch / 换会话）⇒ 整体替换但 tombstone 仍生效。再加 v4.1 的 U-KEEP：浏览器把 `status.held` 当作服务端快照，但**只有来自 live card 的 status 才替换本地快照**；card 非 live（stale/down/hub 不可达）时保留最后一次快照并以 `unavailable` 模式渲染；一行只在三种情况下消失：(i) live card 的新快照里没有它且 ctl 显示它已 `dispatched/observed/queued/consumed`（handed）或 `recalled`；(ii) 用户 recall/discard 成功；(iii) card 被移除（`forgetAgent`）。另一标签页 / 刷新：hub 回放最后一次 status slot（agent 侧投影不再按 cap 门控，§4.7 第 10 条），所以快照里有 held/returned 行，按 card 状态渲染。

**UI 冻结面（P-ui 首个 commit）**：

- `transport/types.ts`：`CmdRequest.op` 加 `"recall"`，加 `target?: string`。
- `types.ts` `ControlHandle` 追加：`sendPrompt(agentKey, text, deliver, original?: string)`、`recall?(agentKey, target)`、`originalText?(agentKey, sessionId, cmdId)`、`forgetAgent?(agentKey)`。
- `contracts.ts`：`QueueListProps.holdEnabled?: boolean`、`QueueListProps.holdLink?: "live" | "unavailable"`；`QueueListEmits` 加 `recall` / `edit` / `discardHeld` / `copyHeld`；`ComposerProps.injectDraft?: { text; rev }`。

**行模式**：纯函数 `heldRowMode(row, { hubLive, cardLive, holdAvailable })`：

| 模式          | 条件                                                                                       | 可用操作                                                                 | note                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `recallable`  | 浏览器 SSE 已连接（`HubState.conn === "live"`）且 card `state==="live"` 且 `holdAvailable` | held：撤回；returned：编辑、丢弃                                         | heldNote / returned*                                                                                |
| `unavailable` | 上述任一不满足                                                                             | **只有「复制原文」**（本地原文优先，否则截断文本）；不提供撤回/编辑/丢弃 | `holdUnavailable`：「连接中断：无法撤回。恢复后若仍未交出会重新可撤回，否则将自动交给模型或已退回」 |

原因：agent 侧在 cap 持续不可用 15 s 后会自动交出（§5.6）；若此时允许基于本地原文「编辑重发」，同一内容可能投递两次。恢复判定：重连后 hub 推送新的 agents 快照与 status（新 `heldRev`），行模式重新计算；已交出的项不再出现在 `status.held`，其 ctl 条目显示 handed。**D3 测试矩阵**（detail-dock-recall / logic-state）：held → cap 丢失（card stale）⇒ 行保留为 `unavailable`；15 s 内恢复 ⇒ 行恢复 `recallable`；15 s 后恢复 ⇒ 行从 held 消失且 ctl 为 handed（或 returned 行出现）；重连到有 cap 的新 hub ⇒ 同上；另一标签页 / 刷新（hub 回放 slot）⇒ 快照含行；陈旧 status（更小 `heldRev`）不覆盖。

| 文件                                | 改动                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logic/control.js`                  | `holdAvailable`；`heldRowMode`；`mergeQueue(serverQueue, optimistic, dropped, held, { holdEnabled, rowMode, dismissed })`；`pendingTransition`（result `held` 不倒退；ctl `dispatched` 且当前 held ⇒ `handed`；ctl `updatedAt` 早于已应用值 ⇒ 丢弃；recall 项 recalled ⇒ null、too_late ⇒ `tooLate`）；`mergeRecalledDraft`；`acceptHeld(prevRev, status)`；`validRecallText` |
| `logic/state.js`                    | `status` case：`acceptHeld` ⇒ 写入 `held` / `heldRev`                                                                                                                                                                                                                                                                                                                         |
| `composables/useControl.ts`         | 原文缓存 `Map<agentKey, Map<sessionId, Map<cmdId, {text, at}>>>`，每 agentKey 上限 128，`forgetAgent`；`recall()` 不带 expect                                                                                                                                                                                                                                                 |
| `components/detail/AgentDetail.vue` | 计算 `hubLive` 与 `cardLive`，传给 `mergeQueue` / `QueueList`；card 被移除时 `forgetAgent`                                                                                                                                                                                                                                                                                    |
| `components/detail/DetailDock.vue`  | `onSend` 传原文；`onQueueRecall` / `onQueueEdit` / `onQueueDiscardHeld` 仅在 `recallable` 下执行；同一 recall id 只回填一次（`appliedRecalls`）；`onQueueCopyHeld` 走 `useClipboard`                                                                                                                                                                                          |
| `components/control/Composer.vue`   | 监听 `injectDraft.rev` ⇒ 拼接回填（`[recalled, draft].filter(nonblank).join("\n\n")`，同 pi TUI `restoreQueuedMessagesToEditor`）、persist、聚焦、grow                                                                                                                                                                                                                        |
| `components/control/QueueList.vue`  | 各行型；`unavailable` 只渲染「复制」与 note；按钮 `aria-label`（含文本前 40 字）；recalling 时 `disabled` + `aria-disabled`；键盘可达；撤回成功后焦点移到 composer 并播报                                                                                                                                                                                                     |
| `i18n/{en,zh}/control.ts`           | chip（两套都用英文）：`stateHeld` `stateRecalling` `stateReturned` `stateHanded` `stateUnavailable`；文案：`recall` `recallAria` `edit` `editAria` `discardHeldAria` `heldNote` `handedNote` `tooLate` `returnedAborted` `returnedSession` `returnedReload` `returnedStale` `previousSession` `recalledAnnounce` `holdUnavailable` `copyHeld` `copyHeldAria`                  |
| `styles/control.css`                | `data-state="held"                                                                                                                                                                                                                                                                                                                                                            | "returned" | "recalling" | "handed" | "unavailable"` |

**可编辑性保证（如实）**：只有 `recallable` 且原文可得时才能编辑（agent 在线且项仍在缓冲 ⇒ recall 返回全文；或本标签页持有本地原文）。`unavailable` 只能复制。

**跨会话可见范围**：held 只显示当前会话；returned 显示本进程内所有会话（标注上一会话），截断 200 字符；全文只经 recall（需 `cmd.v1` 控制权限）；不跨 agentKey、不跨 pi 进程。

**测试**：

| 测试                                          | 增量 | 固定的行为                                                                                                                                                                                                                |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/web-hub/ui/logic-control.test.ts`      | +22  | mergeQueue 新旧签名；按 held cmdId 去重；recall 项不单独成行；`handed`；result `held` 不倒退；ctl `updatedAt` 乱序丢弃；`acceptHeld`；`validRecallText`；`mergeRecalledDraft`；`holdAvailable`；`heldRowMode` 真值表 4 格 |
| `tests/web-hub/ui/queue-list.test.ts`         | +12  | 既有 8 条不改；各行型与 note；`aria-label`；recalling disabled；Enter/Space emit；`unavailable` 只有复制                                                                                                                  |
| `tests/web-hub/ui/composer-inject.test.ts`    | +3   | rev 变化 ⇒ 拼接回填；rev 不变不触发；空草稿无多余空行                                                                                                                                                                     |
| `tests/web-hub/ui/use-control.test.ts`        | +6   | recall 请求形状；原文分区；128 上限；`forgetAgent`；sendPrompt 第 4 参数可省略                                                                                                                                            |
| `tests/web-hub/ui/logic-state.test.ts`        | +3   | 写入 held / heldRev；旧 rev 丢弃；缺省时清空                                                                                                                                                                              |
| `tests/web-hub/ui/detail-dock-recall.test.ts` | +6   | dup 只回填一次；SSE 断开不发 recall；card stale 不发 recall；复制用本地原文；重连后 rev 更新、行恢复可撤回；撤回成功后焦点在 composer                                                                                     |

## 8. 开关、能力协商与版本矩阵

### 8.1 门控

`holdWired(settings)`（hold.ts）是**唯一**门控函数，同时决定 cap 广播与 handler 注册；真值表 `control ∈ {true,false,undefined} × steerRecall ∈ {true,false,undefined}`，只有 `control!==false && steerRecall!==false` 为真。agent 实际扣留还需要 `holdCap()`（此刻 live 且 hub 有 cap）。wiring 测试断言：`holdWired` 为假 ⇒ hello caps 不含 `hold.v1` **且**新 handler 数为 0。

### 8.2 版本矩阵（每格：recall 的 HTTP 结果 / socket 帧 / agent 台账 / prompt 行为）

| hub \ agent                | 新 agent，steerRecall 开                                                                                   | 新 agent，steerRecall 关            | 旧 agent |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- |
| 新 hub，新 UI              | 200 / 转发 / recall 条目 / busy+armed 时扣留                                                               | 409 E_UNSUPPORTED / 无帧 / — / 现状 | 同左     |
| 新 hub，旧 UI 标签页       | 旧 UI 不会发 recall；prompt 回执 `held` 显示为「未确认」，直到 ctl 推进（接受，刷新即恢复）                | 现状                                | 现状     |
| 旧 hub                     | hello_ack 无 cap ⇒ `holdCap()` 恒假 ⇒ 从不扣留；帧与现状逐字节相同；recall 在旧 hub 返回 400「unknown op」 | 现状                                | 现状     |
| **链路断开 / hub 重启中**  | `holdCap()` 假 ⇒ 新扣留关闭（原生路径）；已有扣留照常交接；≥ 15 s ⇒ tick 交出或退回；UI `unavailable`      | —                                   | —        |
| 同一 hub 重连 / 换一个 hub | 恢复 live 后 `onStateChange` republish；有 cap ⇒ 撤回继续可用，无需同一 hub 实例                           | —                                   | —        |
| 新 hub → 旧 hub            | `holdCap()` 假：投影立即过滤 held；15 s 后交出 / 退回；之后不再扣留                                        | —                                   | —        |
| 旧 hub → 新 hub            | `holdCap()` 真：开始扣留                                                                                   | —                                   | —        |
| agent 在途时 hub 崩溃      | 503/504（effect unknown）⇒ 浏览器 queryOnly ⇒ agent 台账裁决（§5.8）                                       | —                                   | —        |

### 8.3 recall 幂等窗口

| 时间（自首次 recall）         | 同 id 重投的结果                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ≤ 10 min                      | hub LRU 命中，回放（含 text）                                                                                                           |
| 10–30 min                     | hub LRU 已淘汰 ⇒ 转发给 agent ⇒ 台账 dup（TTL 30 min）⇒ 回放同一结果（含 text）                                                         |
| > 30 min，或 agent 进程已重启 | 当作新请求：缓冲未命中 ⇒ S5 映射（台账也已淘汰 ⇒ `E_NOT_FOUND`）。浏览器不会在 10 min 之后重投，这种情况只可能出自手工重放              |
| 任何时刻首次判定之后          | 胜负**不会被重新判定**：首次 `too_late` 之后不可能变 `recalled`；首次 `recalled` 回放仍是 `recalled`，UI 用 `appliedRecalls` 只回填一次 |

## 9. P-agent 测试锚点（完整清单）

| 测试                                                   | 增量     | 固定的行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold.test.ts`（新）                                   | +21      | FIFO；上限；take / release / markReturned；`returnSession` 幂等；`adopt`（外来 owner 的 held ⇒ returned{reload}，外来会话 ⇒ returned{session}，外来 handing ⇒ 丢弃）；recall 三种结局；跨会话投影；returned TTL 与上限；clip 不截断代理对；`rev` 单调；袋结构复用与注入；`holdWired` 9 格真值表                                                                                                                                                                                                                                                                                                                                                            |
| `hold.property.test.ts`（新）                          | +2       | 带种子随机交错 hold/take/release/recall/markReturned：每个 cmdId 恰好一个终局；投影无重复、无 handing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `hold-driver.test.ts`（新）                            | +44      | §5.1 每一格；`canHold` 每个条件逐一取反（含 `holdCap()` 假、`@`、容量、会话不一致、signal、abortLatched）；hook：followUp 三条件、error/aborted 轮、空缓冲同步返回 `undefined`、**派发后立即 between**（await 期间 `canHold` 为假）、确认信号三步（观测 → hasPending → macrotask）、`pendingBefore` 退化、200 ms 超时后 settle 且 cap timer 已 cancel；turn_start 跳过检测（armed ⇒ 只派 steer；非 armed 无动作；误报场景 skipFired=0）；settled：残留 ⇒ returned{stale} 且 dispatch 0 次；tick：30 min 到期只派到期项、cap 宽限两分支（busy ⇒ dispatch；ctx 不一致 ⇒ stale）、**tick 不改 phase**（M21）、恢复后 `capDownSince` 清零；§6 有界性；`@` 绕过 |
| `hold-faults.test.ts`（新）                            | +8       | P2 / P3 抛错 / P4 / P5 同步抛 / P5 之后抛（仍 `sent`）/ onReturned 抛 / publish 抛 / 连续失败后 phase 为 between；**I-SYNC**：在 `dispatchToPi` stub 内推进假 timer 到 30 min 与 15 s ⇒ tick 回调不会在 pass 中途运行，`taken === sent + returned`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `commands-hold.test.ts`（新）                          | +22      | 台账先于缓冲；`hold()` 失败回滚到原生路径（台账 `dispatched` + text）；held 时立即回执且 `sendUserMessage` 0 次；`dispatchHeld` 在发送前完成登记（假 pi 在 `sendUserMessage` 内同步触发 input）；`dispatchHeld` 不调用 `registerObservation`（无第二次 HTTP 回执）；observed ⇒ `onObserved`；refused / threw / sent；30 s ⇒ unobserved；recall 全部结局（S5 的 8 种台账状态）；dup 含 text；driver 缺省 ⇒ E_UNSUPPORTED；abort 时序（`onWebAbort` 先于 `ctx.abort`）；**RB1**；两个标签页撤回同一项 ⇒ 第二个 too_late                                                                                                                                      |
| `ledger.test.ts`                                       | +8       | 新状态投影；`holdCap:false` 时过滤 held / recall，returned/recalled ⇒ dropped{not-delivered}；sweep 对 held 的 60 min 上界；patch 带 text 且终态清 text；不传 opts 时 golden 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `wiring-hold.test.ts`（新）                            | +11      | **W1** 关闭时 caps 与 handler 数；**W2** 关闭时出站帧逐字节相同；**W3** 开启但 hub 无 cap ⇒ 与 W2 差分相同且 `holdCap()` 假；**W4** `statusLineText` 不传 extra 不变；**W5** new / resume / fork / reload 后 handler 数不变并 adopt；**W6** live 时 `onStateChange` republish 的 status/ctl 按当前 `holdCap()` 投影；**W7** 换到无 cap hub ⇒ 投影立即过滤 held，15 s 后交出；**W8** 断链 < 15 s 重连同一 hub ⇒ held 不受影响且有 republish；**W9** 断链期间到达的 prompt 不扣留；**W10** 断链 ≥ 15 s ⇒ tick 交出（busy）/ 退回（ctx 不一致）；**W11** `onStateChange` 非 live 状态不 republish                                                             |
| `ui-status.test.ts`                                    | +3       | `held` 标记的三种渲染                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests/config/web-hub-settings.test.ts`                | 改 2 +2  | 默认值补 `steerRecall: true`；`false` 保留；非 boolean 回落                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/integration/web-hub-steer-recall.test.ts`（新） | +9       | I1 扣留 → 撤回拿回全文；I2 撤回与交接竞态（注入 turn_end，恰一方胜出，重投 dup 一致）；I3 hub 重启后 dup；I4 hub 无 cap；I5 agent 关闭；I6 LAN；I7 10–30 min 窗口；**RB2**；**断链 ≥ 15 s 后重连** ⇒ status 无 held、台账为 handed；**I8 断链 < 15 s 期间刷新页面** ⇒ hub 回放的 status 含 held（D3）                                                                                                                                                                                                                                                                                                                                                      |
| `connection.test.ts`                                   | **不改** | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `input-order.test.ts`                                  | 不改     | `input` handler 数量不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 10. 失败模式 → 测试映射

| #     | 情况                             | 处理                                                              | 类别                | 测试                                 |
| ----- | -------------------------------- | ----------------------------------------------------------------- | ------------------- | ------------------------------------ |
| F1    | 撤回与交接竞态                   | 同步线性化点 `takeForHandoff` vs `recall`                         | recalled ⊕ handed   | hold.property、hold-driver、I2、D-M2 |
| F2    | 网页 abort                       | `onWebAbort` 先于 `ctx.abort`                                     | returned            | commands-hold、D-M6                  |
| F3    | TUI Esc / 其它扩展 abort         | `ctx.signal.aborted`（E6）                                        | returned            | M6、D-M6                             |
| F4    | 手动 compact                     | 先 abort ⇒ returned；`manualCompacting` 前置拒绝                  | returned            | **M8**、D-M8、hold-faults            |
| F5    | 自动压缩 / 重试 / post-run 窗口  | between ⇒ 扣留关闭                                                | —                   | M4、M5、M7                           |
| F6    | /new /resume /fork / quit        | `returnSession` + `adopt`                                         | returned            | hold、W5                             |
| F7    | /reload                          | returned{reload}；新实例 adopt                                    | returned            | W5                                   |
| F8    | hub 重启 / 断链（< 15 s）        | 新扣留关闭；已有照常交接；恢复后 republish                        | —                   | W8、W9、I3                           |
| F9    | hub 降级为无 cap / 断链 ≥ 15 s   | 投影过滤；tick 交出（busy）或退回                                 | handed-* / returned | W7、W10、集成                        |
| F10   | pi 崩溃                          | 内存丢失（Q3）；UI `unavailable`，只能复制                        | （丢失）            | detail-dock-recall、A9(a)            |
| F11   | sendUserMessage 同步抛错         | `"threw"` ⇒ returned{stale}                                       | returned            | hold-faults、commands-hold           |
| F12   | prompt 异步失败 / 被 `handled`   | `"sent"` ⇒ 30 s unconfirmed{unobserved}                           | handed-unconfirmed  | D-ASYNC-FAIL、commands-hold          |
| F13   | 下游 input handler 慢            | ≤ 50 ms：同一取队点；> 200 ms：handler 封顶返回，消息晚到、恰一次 | handed-*            | M13b、M13c、hold-driver（§6）        |
| F14   | turn_end 被跳过（P12）           | phase 式 turn_start 检测 / agent_end                              | handed-confirmed    | M9、M10、D-M9、D-M10                 |
| F15   | 跳过检测误判                     | 不会（M16–M18）；即使误判也只是同一取队点提前派发，不丢不重       | —                   | M16–M18、hold-driver                 |
| F16   | 极长单轮                         | 30 min tick 派发，不改 phase                                      | handed              | M21、D-TICK、hold-driver             |
| F17   | 缓冲满                           | 原生路径                                                          | —                   | hold、commands-hold                  |
| F18   | 派发副作用抛错                   | 同步两阶段提交                                                    | 四类之一            | hold-faults                          |
| F19   | 两个标签页撤回同一项             | 第二个 too_late                                                   | recalled            | commands-hold                        |
| F20   | settled 时有残留（按构造不可能） | returned{stale}，零次 dispatch，原 prompt 不受影响                | returned            | **M11**、D-LEFTOVER、hold-driver     |
| F21   | 确认等待期间新到网页消息         | between ⇒ 原生，FIFO 保持                                         | —                   | M22、hold-driver                     |
| F22   | 同一 hook 派发多条               | FIFO + one-at-a-time                                              | handed              | M20                                  |
| F23   | recall 回复丢失 / 写失败 / 超长  | 台账先写（内存）；queryOnly 取回；hub 校验                        | —                   | RB1–RB3                              |
| F24   | 断链期间 UI 上的残留扣留         | `unavailable`，只能复制                                           | —                   | detail-dock-recall、queue-list       |
| F-ORD | 终端插话越过网页暂存（Q2）       | 接受                                                              | —                   | M12                                  |
| F-AT  | `@label` 开头                    | 绕过                                                              | —                   | hold-driver、commands-hold           |

## 11. 风险、开工前验证与回滚

**开工前必须验证（按顺序）**：

1. **G0 = P-conf-A 24 行全绿**（硬闸门见 §3.1，含真实压缩的 M8 与 R6 绊线 M11），连跑 20 次。
2. `rg -n 'on\("turn_end"' src` 确认主会话中没有其它扩展的 turn_end handler 返回 `continue:true`，结果记入 PR 描述。

**风险**：

| R   | 风险                                                                                             | 缓解                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| R1  | pi 升级后时序改变（turn_end 不再由 finishTurn 分发、`context` 时序、`pendingMessageCount` 语义） | P-conf-A 作为绊线；失败时发版把默认值改为 false                                                                |
| R2  | 每个有扣留的 turn_end 最多增加 200 ms + 1 macrotask                                              | 只在派发了项时发生；无扣留零开销                                                                               |
| R3  | Q2 顺序反转                                                                                      | 接受；M12                                                                                                      |
| R4  | recall 正文进入台账与 hub LRU                                                                    | 48 KiB 上限，hub 侧校验                                                                                        |
| R5  | 新 hub + 旧 UI 标签页显示「未确认」                                                              | 接受                                                                                                           |
| R6  | ~~settled deferred 失败冒泡到原 prompt~~                                                         | **已消除**：settled 不派发（M11）。残余：第三方扩展自己在 settled 里发消息仍会触发 pi 的这一行为，与本功能无关 |
| R7  | 确认等待期间（≤200 ms/轮）到达的网页消息不可撤回                                                 | 接受：与原生同一取队点、同一延迟，只是失去该窗口的撤回；M22                                                    |
| R8  | 下游第三方 input handler 持续 > 200 ms                                                           | 退化为 E4：晚一个取队点或 run 后新 prompt，恰好一次（M13c）                                                    |

**接受的行为（明示）**：A-Q2 终端插话越过网页暂存（M12）；A-SKIP phase 式跳过检测在 P12 下提前交出一条 ⇒ 该条失去本轮撤回窗口，落点不变（M9；评审 item 7）；A-WIN 确认阶段窗口内的网页消息不可撤回（R7）；A-ALL `steeringMode:"all"` 晚一轮（M26）；A-END 最后一个 hook 的慢 / 吞消息 / 挂起 handler ⇒ 后续项 returned{stale}（M27、M28），用户重发；A-UNC `unconfirmed` 是可升级显示态，不是硬终局。

**回滚**：运行时 `webHub.steerRecall:false` + `/reload` ⇒ 逐字节回到现状（W1/W2）。只回滚 hub：hub 不带 cap ⇒ 15 s 后交出全部扣留，之后不再扣留。代码：按 P-ui → P-agent → P-protocol 倒序 revert；协议改动全是追加。

## 12. 真机验收（tmux，沿 `live-acceptance-tmux.md`）与 DoD

TUI 与 managed rpc 各跑一遍，模型执行长工具（`sleep 20`）：

- **A1** 网页 steer ⇒ held 行；TUI 状态行 `web ● held 1`。
- **A2** 撤回 ⇒ 正文回到 composer，焦点在 composer，读屏播报；编辑后重发。
- **A3** 不撤回 ⇒ 工具结束后在同一取队点被模型读到；行显示 `handed`。
- **A4** 工具执行中 Esc ⇒ returned ⇒ 可编辑 / 丢弃。
- **A5** `/new` ⇒ returned（上一会话）⇒ 编辑后在新会话发送。
- **A6** Alt+Enter followUp 在最终答复后才被处理，且只有一次 agent_end。
- **A7** 网页先发 S1（held），终端再插话 S2 ⇒ 模型先看到 S2（Q2）。
- **A8** `steerRecall:false` + `/reload` ⇒ 与改动前一致。
- **A9（断链）**：(a) 暂存期间 kill pi ⇒ card stale，held 行 `unavailable`，只能复制；(b) 刷新后重复 (a) ⇒ 复制截断文本；(c) 标签页 B 看到 A 的 held 项 ⇒ agent 在线时撤回拿到全文；(d) TUI quit 后 `/resume` ⇒ 原 returned 不复存在；(e) `/webhub restart` 10 s 内恢复 ⇒ 断链期间 `unavailable`，恢复后重新可撤回，消息未被交出；(f) `/webhub stop` 超过 15 s ⇒ 扣留自动交给模型；`/webhub start` 后队列无 held 行；(g) 断链期间终端插话 ⇒ 立即进入 pi。
- **A10** 键盘操作；recalling 时按钮不可点。
- **A11** 新 hub + 未刷新的旧 UI ⇒ 显示「未确认」，交接后恢复。
- **A12（M8 真机复验）** 工具执行中扣留后终端 `/compact` ⇒ returned（已中止）；压缩后的新 prompt 不带旧扣留；编辑后可重发。
- **A13（M20/M24）** 工具执行中连发两条网页 steer ⇒ 工具结束后模型依次在两个相邻轮次看到它们（one-at-a-time，FIFO）；第二条在第一条被取走之前仍显示为 held、可撤回。
- **A14（D3）** 暂存期间 `/webhub restart`：断链期间行保留为 `unavailable`；在另一标签页打开同一会话 ⇒ 同样看到该行；恢复后行回到可撤回。

**DoD**：四个 CI 闸门全绿（P-ui 另加 `npm run build:web`）；本包测试锚点全部存在；新增 timer 全部 unref；每个 hook 至多一个 await 且与本模块 timer race；`dispatchHeld` 与 hook 第 3 步不含 await、`dispatchHeld` 不碰缓冲/不调 onReturned（code review 项）；每 hook 至多一次 `sendUserMessage`；模块作用域没有可变状态；`connection.ts` / `connection.test.ts` diff 为空；Conventional Commits，`git add` 精确路径；验收模型 ≠ 开发模型。

**测试总数影响**：新增约 **+300**（P-conf-A 29、真实 driver conformance ≈ 30、P-protocol ≈ 29、P-agent ≈ 160、P-ui ≈ 57）；修改既有用例约 3–5 条（caps-coexist 1、web-hub-settings 2、可能存在的 caps 精确列表断言），不删除任何用例。

## 13. 修订记录

### v2（评审 r_FWBS0SXK 打回 → 修订）

| #   | 级别    | finding                         | 修订                                                                                                                                                                                         | 位置                       |
| --- | ------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Blocker | context arm 未覆盖各路径        | 逐路径源码论证；G0 改为 15 行路径矩阵；一次性脚本实证 13/13 × 5 次；新增 turn_start 跳过检测（X1）；凡不能保证 exactly-once 的窗口一律关闭扣留（between / settling / 手动压缩 / abort 之后） | §1、§3.1、§5.1             |
| 2   | Blocker | agent_settled fire-and-forget   | settled 改为同步批次（无 await、无在途 promise），先置 `settling`，依赖 pi deferred FIFO（源码 + M11 实测）；新增测试                                                                        | X2、§5.2、M11、hold-driver |
| 3   | Blocker | dispatchHeld 未在发送前登记观测 | §5.4：发送前完成台账 dispatched+text、confirm 登记、30s timer；台账迁移全表                                                                                                                  | §5.3、§5.4、commands-hold  |
| 4   | Major   | CmdSchema 封闭 union            | 列出 union 的逐字改动；新增 parse→帧端到端集成测试                                                                                                                                           | S2'、§4.1                  |
| 5   | Major   | 版本矩阵不一致                  | §8.2 hub × agent × UI × 断链 / 替换全矩阵，每格给出 HTTP / 帧 / 台账                                                                                                                         | §8.2                       |
| 6   | Major   | cap 丢失时 ctx stale / 跨会话   | 粘性能力（X6）+ session epoch；cap_lost 分 stale / aborted / 投递三支                                                                                                                        | §5.6                       |
| 7   | Major   | Symbol 袋清理不可靠             | 条目带 `owner` / `sessionEpoch`；`returnSession` 幂等；session_start 时 `adopt` 清理遗留                                                                                                     | A1、§5.1、W5               |
| 8   | Major   | 批次异常导致不一致              | §5.5 逐项两阶段提交 + 故障注入测试                                                                                                                                                           | §5.5、hold-faults          |
| 9   | Major   | tryHold 成功但台账失败产生孤儿  | `canHold` / `hold` 拆分，台账先写，`hold` 失败回滚到原生路径                                                                                                                                 | §4.4                       |
| 10  | Major   | hub LRU 与 agent 台账窗口不一致 | §8.3 幂等窗口表；UI `appliedRecalls` 防止重复回填；I7                                                                                                                                        | §8.3、§7                   |
| 11  | Major   | 可编辑承诺不成立                | 改为「只有原文可得时才能编辑」的如实表述 + A9 验收                                                                                                                                           | §7、§12                    |
| 12  | Major   | C9 origin 时序与实现不符        | 用真实 dispatchHeld 测试（D-ORIGIN），只保证先后顺序，**放弃相邻保证**（M4 中 compaction 会插入）                                                                                            | §3.2                       |
| 13  | Minor   | handler owner / 生命周期        | wireWebHub 是唯一 owner，注册顺序明确；W5 验证 new / resume / fork / reload 后数量不变                                                                                                       | §4.7、W5                   |
| 14  | Minor   | 共享文件争用                    | 设置归 P-agent，P-protocol 不碰 agent/** 与 config/**；合并顺序唯一                                                                                                                          | X10、§2                    |
| 15  | Minor   | P-conf-B 用墙钟断言             | 改为断言同一取队点 + LLM 调用数相同（D-NATIVE-EQ）；全文不做墙钟断言                                                                                                                         | §3.2                       |
| 16  | Minor   | 有界性夸大                      | 收窄为「本模块不新增无界 await」+ 600 ms watchdog + 假 timer 测试                                                                                                                            | §6                         |
| 17  | Minor   | cap 丢失时投影伪装 queued       | 先交接 / 退回再切投影；降级时 held 整条过滤（不映射为 queued）；W7                                                                                                                           | §4.5、§5.6、W7             |
| 18  | Minor   | 事件乱序                        | `heldRev` + ctl `updatedAt` 丢弃旧事件；HTTP `held` 结果不倒退                                                                                                                               | S2、§7                     |
| 19  | Minor   | 原文缓存键碰撞                  | agentKey → sessionId → cmdId 三层 Map，按 agentKey 上限与清理                                                                                                                                | §7                         |
| 20  | Nit     | recall 结果无协议约束           | `RecallResultDataSchema` + 48 KiB 字节上限，hub 校验，UI 再校验                                                                                                                              | S2'、S4、§7                |
| 21  | Nit     | 跨会话可见范围未定义            | 明确可见者、截断规则、全文获取权限与隔离边界                                                                                                                                                 | §7                         |
| 22  | Nit     | 异步失败被当作成功              | `DispatchOutcome` 三值并定义语义；异步失败 ⇒ unconfirmed；D-ASYNC-FAIL                                                                                                                       | §5.4、§3.2                 |
| 23  | Nit     | cap 条件不一致                  | `holdWired()` 单一纯函数 + 9 格真值表                                                                                                                                                        | A1、§8.1                   |
| 24  | Nit     | 无障碍                          | aria-label / disabled / 键盘 / 焦点 / 播报，加测试与 A10                                                                                                                                     | §7、§12                    |
| —   | —       | 已删除的终端顺序机制的残留      | 全文只在头部的 Q2 裁定中提及；不新增 input handler，不对 input 做任何拦截。评审已撤回「残留」判断，本版仍改写了相关措辞                                                                      | 头部、§9                   |

### v3（复审 r_5EXY8BKD 有条件通过 → 修订）

| #   | 级别   | 意见                              | 修订                                                                                                                                                                                                                            | 位置                       |
| --- | ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | 严重   | 粘性能力未绑定链路                | 绑定 `(connGen, liveGen)`；断链期间不创建新扣留；15 s 宽限期后在 tick 中交出或退回（附理由）；A7 的 `liveGen` + 强制 notify 处理未观察到 live=false 的 socket 替换和换 hub；只看 cap 不看 hub 身份（附理由）；测试 W9–W13       | X6、§4.3 A2、§4.7 A7、§5.6 |
| 2   | 严重   | watchdog 到期后批次仍会继续发送   | 取消令牌，在 P0 以及每次派发之前检查；未发出的项保持 held，唯一归属下一个 hook；批次只复位自己的 phase；测试 WD1–WD4（分别与 agent_end / agent_settled / 30 min tick 并发）                                                     | X11、§5.2、§5.5            |
| 3   | 严重   | M8 并未真正压缩                   | 一次性脚本 V3-M8 已真实执行压缩：`compactRes:{ok:true}`，存在 compaction 条目；两项均 returned(aborted)，4 次请求都不含；压缩后的 P2 请求 = [summary, P2]；压缩期间扣留被拒。M8 列为**硬闸门**，并新增真机复验 A12              | §1.2、§3.1、§12            |
| 4   | 严重   | agent_settled 顺序保证范围不清    | 范围限定为「本扩展经 `sendUserMessage` → `prompt()` 的发送，相对于在我们 handler 之后发出的发送」；V3-M11b 实测三个 handler 按注册顺序 EARLY < H < LATE；新增 M11b 行                                                           | §5.2、§1.2、§3.1           |
| 5   | 一般   | 结局分类太粗                      | 四类结局 handed-confirmed / handed-unconfirmed / returned / recalled，分别断言                                                                                                                                                  | X13、§5.3、§3.2            |
| 6   | 一般   | dispatchHeld 调用与观测路径未写明 | 写明真实调用 `deps.pi.sendUserMessage(...)` 及其完整调用链；流式路径与空闲路径（idleWatch）都复用 `onInputEvent`；D-ASYNC-FAIL 改用真实接线：(a) watchdog 夹具 + 鉴权失败；(b) 前序 handler 返回 handled；不 monkeypatch prompt | §4.4、§3.2、§5.4           |
| 7   | 一般   | turn_start 跳过检测会误报         | 改为请求令牌（X12）；误报测试覆盖正常多轮 / 重试 / followUp（一次性脚本 skipFired=0）、一个请求内多个 assistant message_start、首轮                                                                                             | §5.1、§3.1 M16–M18、§9     |
| 8   | 一般   | settled deferred 遇到会话边界     | 用 `deferred` 记录 epoch；会话边界时未被观测的项 ⇒ unconfirmed{stale}，取消其 timer；迟到的 input 不改写台账；测试 DS1–DS3                                                                                                      | §5.4                       |
| 9   | 一般   | recall 结果缺少类型化边界         | `toRecallResult` 是唯一构造点；先 `peek` 校验再移除；先 settle 再 send（try/catch）；hub 执行路径与 queryOnly 路径都改写；测试 RB1–RB4                                                                                          | §5.8、§4.4                 |
| 10  | 一般   | 分包时序                          | P-agent 等 P-protocol 完整合并后才开工；P-conf-B 排在 P-agent API 与命令接线定稿之后；删除「P-protocol 负责设置」的残留表述                                                                                                     | §2.2、X10                  |
| 11  | 建议   | UI 在 hub 不可用时的表现          | `heldRowMode`：`unavailable` 时只能复制，绝不显示为可撤回或可编辑（避免与宽限期后的自动交出重复投递）；可编辑性保证随之收窄；测试与 A9(e)(f)(g)                                                                                 | §7、§12                    |
| 12  | 建议   | §1.2 证明范围表述                 | 逐行标注：一次性脚本已证明 M1–M12、M8（v3 真压缩）、M11b、M19，M16–M18 部分证明；M13 只能由正式 G0 证明；M14/M15 仅有 architect 的间接证据；脚本不覆盖真实 driver / hub / UI / 链路 / watchdog                                  | §1.2                       |
| —   | 新发现 | M19 的失败传播路径                | 空闲路径的 deferred 失败会以最初那次 `prompt()` 调用的 reject 形式出现，而不是走 emitError；记为 R6 与 F28，M19 作为绊线                                                                                                        | §1.2、§11、§10             |

### v4（复审 r_KKCSH5D5 有条件通过 → 重做）

评审意见按调度方转述编号。1–3 为必须修复项；4–12 为一般/建议项，转述中按主题列出 7 条，这里逐一对应到 4–10；转述未单列出 11、12 的独立文本，若评审原文另有两条，调度方请对照 §0 补映射。

| #   | 级别 | 意见                                                                                                                                                                                                                       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 位置                                 |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | 严重 | hello_ack 内部调用顺序（liveGen++ → live/caps → onLink → cap_lost/republish → slot 回放）未定；强制 notify 对每个 `onStateChange` 消费者的副作用（runTx.onLink、status/ctl republish、gap 重试、sampler/watch 幂等）未评估 | **机制整体删除**（C1）：不再有 `liveGen`、binding、`onLink`、强制 notify；`connection.ts` 零改动，`connection.test.ts` 零改动。`holdCap()` 是读取当前链路的纯函数（与现有 `isLiveWithCap` 同式），在扣留时与每个 tick 读取；cap 丢失 = 持续 15 s 为假 ⇒ tick 交出/退回。对 `onStateChange` 的唯一追加是「live 时 republish status/ctl」（幂等 setSlot，W6/W11）。顺便证明 v3 担心的「视图相同不通知」窗口不存在（`enterBackoff`/`connectNow` 必经 notify）。    | §0.1 C1、§4.7、§5.6、§8.2            |
| 2   | 严重 | watchdog 在 commitOne 中途取消（已 take / 已写台账 / 已登记观测但未发送）需要逐阶段 P1–P4 回滚                                                                                                                             | **问题在结构上消失**（C2）：hook = 一个不含 `await` 的同步 pass（take→台账→登记→send，逐项）+ 置 between + 之后才 await。单线程下 timer 不能插入同步函数，不存在「中途」；没有 watchdog、没有令牌。不变量 I-SYNC 由 hold-faults 测试（在 dispatch stub 内推进假 timer，断言 `taken === sent + returned`）固定。                                                                                                                                                 | §0.1 C2、§5.2、§5.3、§9              |
| 3   | 严重 | R6/F28：在 agent_settled 内交出的残留若 deferred `prompt()` 失败，会让用户最初的 `session.prompt()` reject，错误归因于已成功的 prompt                                                                                      | **agent_settled 不再派发任何消息**（C3）。残留按构造不可能（I-EMPTY：每个 hook 同步派发全部允许项；agent_end 在所有路径都发出并派发全部；between 期间不收新项），矩阵 23 个正常行实测 `heldAtSettled=0`。防御分支：残留 ⇒ `returned{stale}`，零次 `sendUserMessage`。M11 实测：强制残留 + `authFail=true` ⇒ 不发送、原 prompt 正常 resolve、无 ext error。空闲路径（deferred、idleWatch 耦合、`not-started`/`stale` unconfirmed、DS1–DS3、M11b、M19）全部删除。 | §0.1 C3、§1.1、§5.1、M11、D-LEFTOVER |
| 4   | 一般 | 宽限期交出的项不能预先标为 handed（应为 handed-unconfirmed，由观测决定）                                                                                                                                                   | tick 派发走同一个 `dispatchHeld`，类别**只由台账决定**：观测到 ⇒ confirmed，30 s 未观测 ⇒ unconfirmed{unobserved}。计划文本不再预先分类；D-CAP-GRACE / W10 分别断言两种结局。                                                                                                                                                                                                                                                                                   | §5.6、§3.2、§9                       |
| 5   | 一般 | 请求令牌（reqToken/turnEndFor）没有绑定到可观测身份，否则应降级为 best-effort                                                                                                                                              | 令牌删除（C4）。跳过检测 = `turn_start` 时 phase 仍为 `armed`，**明确为 best-effort**，并证明误判无害：`turn_start`（`:113`）在本轮 Q1（`:110-112`）之后，此时派发与正常 turn_end 交接落同一 `:186`，只损失该轮可撤回性。M9 `skipFired≥1`，M16–M18 `skipFired=0`。                                                                                                                                                                                              | §0.2 C4、§5.1、M9/M16–M18            |
| 6   | 一般 | 终结回调的 timer 所有权 / CAS 不明                                                                                                                                                                                         | §5.5 表：每个 timer 的所有者、取消点、回调写入前的 CAS 条件（`promptState` 必须等于武装时的状态）；确认 cap timer 由当次 `confirm()` 拥有并在 race 后 cancel；`waiters` 表的清理点列明。                                                                                                                                                                                                                                                                        | §5.5、hold-driver 测试               |
| 7   | 一般 | R6 需要真实接线下的 conformance                                                                                                                                                                                            | R6 已消除，但绊线保留并升级为真实接线：D-LEFTOVER（真实 driver + 真实 commandHandler，settled 前塞入残留 + 鉴权失败 ⇒ 0 次发送、原 prompt resolve、无 onError）；D-EMPTY 在每一行断言缓冲为空且 phase=idle。                                                                                                                                                                                                                                                    | §3.2                                 |
| 8   | 一般 | 测试隔离（进程级 Symbol 袋、timer 泄漏）                                                                                                                                                                                   | `createHoldBuffer({ bag })` / 台账袋可注入；`beforeEach` 删除 `globalThis[Symbol.for(...)]` 并重建；`afterEach` dispose driver/commandHandler/session 并断言夹具无活动 timer。                                                                                                                                                                                                                                                                                  | §3.2、A1                             |
| 9   | 一般 | 「台账已落盘」措辞错误                                                                                                                                                                                                     | 全文改为「台账是进程内存（`Symbol.for` 袋），跨 `/reload`，不跨 pi 进程」（C10）。                                                                                                                                                                                                                                                                                                                                                                              | §4.5、§5.8                           |
| 10  | 一般 | G0 状态要如实                                                                                                                                                                                                              | §1.2 逐行标注：一次性脚本 `matrix4.mjs` 证明 24 行（8 次运行无抖动），其中 M13/M14/M15 由 v3 的「仅间接证据/只能由 G0 证明」变为脚本直接证明；脚本不证明真实 driver/台账/hub/UI/tick，由 §3.2、§9 覆盖。                                                                                                                                                                                                                                                        | §1.2                                 |
| 11  | —    | （转述未单列）                                                                                                                                                                                                             | 若为「UI 在断链时的可编辑性/重复投递」：§7 `unavailable` 模式保留，与 §5.6 的 15 s 规则一致。                                                                                                                                                                                                                                                                                                                                                                   | §7                                   |
| 12  | —    | （转述未单列）                                                                                                                                                                                                             | 若为「connection.test 次数断言的影响面」：不再适用——`connection.ts` 不改。                                                                                                                                                                                                                                                                                                                                                                                      | §9                                   |
| —   | 新增 | 确认信号升级                                                                                                                                                                                                               | `input` 观测 → `ctx.hasPendingMessages()` 翻转 → macrotask（C8）；M13b 证明覆盖排在我们之后的 50 ms 第三方 handler；M13c 证明 200 ms 上限与「晚到但恰好一次」。                                                                                                                                                                                                                                                                                                 | §0.2 C8、§5.2                        |
| —   | 新增 | 确认窗口内的新消息                                                                                                                                                                                                         | phase 在 await 之前置 between ⇒ 原生路径，FIFO 保持（M22）；记为 R7 接受项。                                                                                                                                                                                                                                                                                                                                                                                    | §5.2、§11                            |

### v4.1（复审 gpt-6-astra 打回 → 修订）

复审确认保留：liveGen 删除、agent_settled 不派发（R6 消除）、timer CAS、测试隔离、M8 真压缩、matrix4 24/24 × 8（评审方自行复跑）。

| #   | 级别    | 意见                                                                                                                                                                       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 位置                                       |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | BLOCKER | `pi.sendUserMessage` 表面同步：入队在 `_runInputHandlers` 之后；同步 pass 连发两条 ⇒ 两条并发 input 链，慢 handler 让后者先入队 ⇒ 乱序 / 跨取队点；I-SYNC 不覆盖异步副作用 | **串行化**（D1）：每 hook 至多一条；B1 阻塞规则——前一条未「确定入队 / 消费 / 终局」前不发下一条 ⇒ 本模块的发送永远不并发（I-SERIAL）。one-at-a-time 下零成本（每取队点本来只取一条，M20 落点不变）。I-SYNC 收窄为「缓冲/台账/调用层原子」。**真机证明**：M24（第 1 条慢 400 ms、第 2 条快 ⇒ S1 在 LLM#3、S2 在 LLM#4，顺序保持，`blocked=1`）；M24b 对照（原生并发发送同场景 ⇒ N2 越过 N1）。未发项在上界到期后保持 held / 可撤回，最后一个 hook 上 run 结束 ⇒ returned{stale}（M27），绝不丢、绝不重。 | §0.4 D1、§1.1 I-SERIAL、§5.2、M24/M24b/M27 |
| 2   | MAJOR   | `hasPendingMessages()` 只证明「某队列非空」；`pendingBefore===true` 时跳过轮询                                                                                             | 证据语义精确化（D2）：仅当「唯一在途 + 发送前为 false + 自家观测已见」时 false→true 翻转才算该条入队；否则 `unverifiable`，由消费层（`onConsumed`）或 30 s 终局解除 B1。M25（已有 TUI pending + 两条网页）证明落点与原生 one-at-a-time 相同；M26 记录 `"all"` 模式退化；D-BLOCK-30S 证明阻塞有界。文中「同一取队点」限定为「已确定入队的那一条」。                                                                                                                                                      | §0.4 D2、§5.2、M25/M26                     |
| 3   | MAJOR   | `holdCap()` 为假时投影消失 ⇒ 浏览器可能丢行而不是显示 `unavailable`（断链 / 换 hub / 刷新 / 多标签页 / 陈旧 status）                                                       | 投影不按 cap 门控（D3）：`status.held` 只按 `holdWired`，非空就发（开放 schema）；ctl 只在「live 且 hub 明确无 cap」时过滤（`filterHeld`）；断链期间 slot 存完整投影。UI **U-KEEP**：只有 live card 的 status 替换快照，非 live 保留快照为 `unavailable`。测试矩阵：held → cap 丢失 → 15 s 内 / 后 → 重连有 cap hub → 另一标签页 / 刷新 → 陈旧 rev；W6/W7/W12、I8、detail-dock-recall、logic-state。                                                                                                    | §0.4 D3、§4.7 第 10/11 条、§7、§8.2        |
| 4   | MINOR   | C1 事实错误：`/reload` 不复用 `HubConnection`                                                                                                                              | 更正（D4）：`acquireConnection()` 按 implVersion 判定 ⇒ `close("handover")` + 新连接；证明改基于真实转移（`connecting`→`live` 两次 notify）；新增 W5-RELOAD / D-RELOAD（handover 期间 held ⇒ returned{reload}，adopt，`capDownSince` 清零，live 后 republish）。                                                                                                                                                                                                                                        | §0.1 C1、§0.4 D4、§4.7 第 14 条、§9        |
| 5   | MINOR   | `onReturned` 两个所有者 ⇒ 重复 publish / 误标 returned                                                                                                                     | 单一所有者（D5）：`dispatchHeld` 只返回 outcome；driver 在每次派发 / flush 后对恰好失败集调一次 `markReturned`+`onReturned`，`publish` 一次。per-outcome 测试。                                                                                                                                                                                                                                                                                                                                         | §5.3、§5.6、hold-faults                    |
| 6   | MINOR   | 「每 hook 至多一个 await」不准确                                                                                                                                           | 改为「一个有界确认阶段，含有限个 timer await（1 cap + ≤100 轮询 + 1 macrotask）」；四层术语（缓冲 / 调用 / 入队 / 消费）在 §5.2 开头定义并全文使用。                                                                                                                                                                                                                                                                                                                                                    | §0.4 D6、§5.2、§5.7、§6                    |
| 7   | NIT     | phase 式跳过检测的「提前交出失去撤回窗口」应列为接受行为                                                                                                                   | §11「接受的行为」A-SKIP。                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §11                                        |
| R7  | —       | 描述过窄                                                                                                                                                                   | 重写：窗口内消息与已发那条之间无 FIFO 保证；补 R8（慢 handler 退化）、R9（入队证据残余误判）、R10（`"all"` 模式）。                                                                                                                                                                                                                                                                                                                                                                                     | §11                                        |

证明：`/tmp/steer-hold-exp5/matrix5.mjs` **29/29 PASS × 8 次运行**（`run1..8.out`）；v4 的 24 行全部保留。

### v4.2（第二位复审打回 → 按调度方裁定 R-A…R-D 修订）

| #   | 级别    | 意见                                                                                                    | 修订                                                                                                                                                                                                                                                                                           | 位置                                    |
| --- | ------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | BLOCKER | B1 由 `unconfirmed`/`dropped`（30 s）解除，不证明异步链已停止；> 30 s 的 handler 可让 S1 在 S2 之后入队 | R-A：B1 **只由正面证据解除**（E1 入队确认 / E2 归因消费），**没有任何 timer 解除**；`isDispatchSettled` 从 deps 删除。阻塞到 run 结束 ⇒ agent_end 退回剩余项。M29（600 ms handler > 300 ms 显示 timer）：S2 的发送严格晚于 S1 的 `message_start`，顺序保持；M28（吞消息）：S2 从未发送、退回。 | §0.5、§5.2 B1、§4.3、M28/M29、D-SWALLOW |
| 2   | SEVERE  | M27 迟到入队无归属：台账 `unconfirmed` 而模型实际读到了                                                 | R-A：`unconfirmed` 是可升级显示态；台账保留 `text`，`findDispatchedByText` 匹配 `{dispatched, unconfirmed}`，迟到的 input / 归因 `message_start` 把**同一条目**升级为 observed→queued→consumed。M27/M29 显示态序列 `dispatched→observed→unconfirmed→consumed`。UI 文案「可能已送达」。         | §4.4、§5.4、D-UPGRADE                   |
| 3   | SEVERE  | U-KEEP 无跨标签页/重连的单调合并；`heldRev` 进程级，未绑定作用域；陈旧 status 可复活已撤回/已交出的行   | R-C：U-MERGE——per-cmdId tombstone 压过快照；快照只增不复活；作用域 `{agentKey, sessionId, heldEpoch}`（新增 wire 字段 `heldEpoch` = `MODULE_INSTANCE`，与 ctl `epoch` 同值）；`heldRev` 仅同域比较。三例测试。                                                                                 | §2.3 S2、§4.6/4.7、§7、logic-state      |
| 4   | SEVERE  | 确认 / 30 s / tick timer 全 unref 依赖「总有别的 ref handle」                                           | R-B：确认阶段 timer **ref**（≤200 ms 有界）；30 s 显示 timer 与 tick unref（从不门控 pi await 的 promise）。不变量 T-REF。                                                                                                                                                                     | §5.5、§5.7、§6                          |
| 5   | SEVERE  | `pendingBefore===true` ⇒ unverifiable 靠 onConsumed 或 30 s，消费未归因到我们的 cmdId                   | R-A：归因机制 = 现有 queueMirror 的 web 来源归因：`input.source==="extension"` ∧ 正文全等 ∧ 唯一在途 ⇒ mirror 项带 cmdId；`message_start` 经 `dequeueByText` 命中带 cmdId 的项才算我们的消费；终端消息永不带 cmdId。30 s 不解除。D-ATTRIB（含同正文 TUI 消息反例）。                           | §5.2 E2、D-ATTRIB                       |
| 6   | —       | cap-loss flush「≤16 s」忽略 B1                                                                          | 删除 SLA：flush 受 B1 约束，上界 = run 结束（agent_end 退回）。                                                                                                                                                                                                                                | §5.6                                    |
| 7   | —       | 跳过检测误触 × B1 × 慢 handler 未门控                                                                   | 跳过检测路径同样走 `sendOne` + B1（阻塞时不发）；M30 真机：P12 下 K1 慢 400 ms，后续 turn_start 跳过检测均阻塞，K1 消费后才发 K2，顺序保持。                                                                                                                                                   | §5.2、M30                               |
| 8   | —       | 证明行需标 run / to-implement / to-accept；真实 driver conformance 应最先                               | R-D：§1.2 每行标 run ✓ + to-implement（G0）；to-accept = §12 A-行。分包重排：P-protocol → **P-core（G0 = 真实 driver conformance 硬闸门，含 D-M24/27/28/29/30、D-ATTRIB、D-UPGRADE、D-SWALLOW）** → P-wire → P-ui。参考 driver 行降为非闸门对照。                                              | §0.5、§1.2、§2、§3                      |

证明：`/tmp/steer-hold-exp6/matrix6.mjs` **32/32 PASS × 8 次运行**（`run1..8.out`）；v4.1 的 29 行全部保留；新增 M28、M29、M30；M27 的退回点改为 agent_end。

## v4.3 增补（调度方裁定，评审 r_2Z2T7YE0 → v4.3，2026-10-09）

本节优先级高于正文与之前各版；冲突处以本节为准，实施时同步改正文对应段落。

### Y1 — 删除 E1，B1 只由 E2 解除（评审 #1）

- **E1（`hasPendingMessages()` false→true + 我方 input 观测）不再作为解除 B1 的证据**：pi 在 input handler 跑完之后才 push 队列，期间 TUI 或其他扩展可能先 push，布尔翻转无法归因到我方这条。E1 只保留为**显示**用途（ledger 从 `dispatched` 进到 `observed/queued`），不影响能否发送下一条。
- **B1 只由 E2 解除**：模型真正开始消费我方这条消息——user `message_start` 命中带**我方 cmdId 标记**的 queueMirror 项（标记规则见 Y4）。
- 代价：下一条暂存消息最早在上一条被模型取走之后才交给 pi。pi 默认 `one-at-a-time` 每个取队点只取一条，所以下一条照样赶得上下一个取队点，延迟不变；`steeringMode:"all"` 的降级已在 R-* 中记录。
- 不新增任何 TUI/rpc 顺序屏障（遵守 arch §11 Q2）。
- G0 新增真实 driver 用例：慢 S1（400 ms input handler）+ S1 处理期间 TUI steer 入队 + 暂存 S2 ⇒ S2 在 S1 被消费前从不发送，网页消息之间顺序保持，三条各送达一次。

### Y2 — held 快照按当前 scope 严格过滤（评审 #2）

- UI 只接受 `heldEpoch === 当前 AgentCard.epoch` 且 `sessionId === 当前 sessionId` 的 `status.held` 快照；scope 不匹配一律丢弃，**不比较新旧**（epoch 是随机值，不可比较）。卡片 epoch 变化时，旧 scope 的本地暂存行转成 `unavailable`（只能复制），直到新 scope 的快照或终态到来。
- ctl 列表被截断（超过 32 项）后重连：没有 tombstone 的旧行只能由当前 scope 的快照确认；当前 scope 快照里没有的行，视为已离开暂存区，标为 `unavailable`（只能复制），不显示成可撤回。
- 测试：旧 epoch 快照晚于新 epoch 到达 ⇒ 丢弃；handed 之后再到一个旧快照 ⇒ 不复活；ctl 截断后重连 ⇒ 不出现可撤回的幽灵行。

### Y3 — 计时器契约统一（评审 #3）

- 计时器分两种 API：`setRefTimer`（只给每个 hook 的确认阶段用，总时长 ≤200 ms，有界）和 `setUnrefTimer`（30 s 显示计时器、1 Hz tick 等其余一切）。不变量 **T-REF**：pi 正在 await 的 promise 不得依赖 unref 计时器。
- §4.3 API、§5.2 伪代码、§5.7、§6 与完成标准中所有「新增计时器全部 unref」的表述，改为「除确认阶段的 ref 计时器外全部 unref」。G0 增加验证：在没有其他 ref 句柄的进程里，确认阶段能正常结束，进程随后正常退出。

### Y4 — 迟到证据按 session/owner 限定、候选必须唯一（评审 #4）

- `findDispatchedByText` 的匹配条件增加 `sessionId` 与 owner（本 command handler 实例）；同时有多个同文本候选时返回「不唯一」，**不按最早一条匹配**，此时不做 E2 归因（B1 保持，后续消息留在暂存区，最终在 agent_end 退回）。
- 旧 session 的迟到证据只能更新旧 ledger 条目的显示状态，不得写进当前 session 的 queueMirror。`/new`、`/resume`、`/reload` 之后旧 handler 的证据一律按旧 scope 处理。
- 测试：跨 session 迟到 input；同文本两条暂存消息；`/reload` 期间的迟到 message_start。

### Y5 — 文档一致性（评审 #5、#6、#7）

- §1.2 证明表补齐 M24–M30、D-ATTRIB、D-UPGRADE、D-SWALLOW 及 Y1/Y2/Y4 新用例，每行标注 run / to-implement / to-accept；§11 的第一闸门统一为 G0 真实 driver 套件（`steer-hold-driver.test.ts`），删除「P-conf-A 24 行」等旧说法。
- TUI 标记全文改为字面 `web held N`（arch §11.1），并加精确字符串测试。
- M22 只断言「送达一次、不丢失、不可撤回」，删除「FIFO 保持」（R7：确认窗口内不保证顺序）。

### Y6 — 评审 r_2Z2T7YE0 的实施条件（全部接受，作为开发验收项）

1. `inflight` 在调用 `dispatchToPi` 之前建立（pi 快路径会在调用内部同步触发 input）。
2. `unconfirmed` 状态保留全文直到 `consumed`/`dropped`（当前 `ledger.ts` 对多数状态会清掉 text，需要覆盖）并有迟到升级测试。
3. E2 归因拒绝同文本多候选（Y4）。
4. 确认计时器与显示/tick 计时器使用不同 ref 策略；G0 的计时器泄漏断言同时覆盖 ref 与可取消的 unref 计时器。
5. `status.held` 空快照、epoch/session 切换、ctl 截断后重连都有明确的删除 / unavailable 语义（Y2）。
6. R7、Q2、TUI 标记以 arch §11/§11.1 为验收基准。
7. G0 通过之前不进入 P-wire / P-ui。

### Y7 — 评审 r_QTTM6FGS（v4.3 有条件通过）的实施条件（全部接受，作为开发验收项）

1. **E2 归因失败一律收口**：当前 scope 内任何原因导致的 E2 无法归因（文本被变换、附件、多段内容、模板、同文本多候选），B1 保持；`agent_end` 时把所有剩余暂存项一次性 `returned`，不自动重发、不重复投递；上一条保持 `unconfirmed`（可能已送达）。G0 增加文本变换 / 附件 / 多段内容用例，断言每条消息恰好出现一次；`agent_end` hook 的真实接线由 G0 覆盖。
2. **重连换 epoch 必须刷新卡片 epoch**：registry 在 `claiming` 状态下重连且 epoch 变化时，当前只发 `gap`、不发 `agent_up`，UI 的卡片 epoch 因此不更新，Y2 会把新 scope 的快照全部丢掉。实施时让 epoch 变化发布能刷新卡片 epoch 的事件（或让 `gap` 携带并应用新 epoch），并测试「claiming 重连 + 新 epoch ⇒ 新快照被接受、旧快照被丢弃」。
3. **按文本查找带 scope/owner，且不误伤其他来源**：`findDispatchedByText` / `dequeueByText` 显式接收 scope 与 owner，多个候选返回「不唯一」；E2 没有唯一确认时不 dequeue 任何项，绝不移除 TUI 或其他扩展的条目；`unconfirmed` 保留全文直到 `consumed`/`dropped`；覆盖 reload、跨 session、迟到事件测试。

**评审结论：v4.3 有条件通过（r_QTTM6FGS，2026-10-09）。**
