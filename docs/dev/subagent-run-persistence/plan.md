# 运行中 subagent 的重启可恢复性（非终态 run 日志）

> 状态：设计稿 v1（待评审）。只描述设计与施工分解，不含实现。
> 前置：2026-10-04 重启后 resume 断链事故的修复 `2b47d9b` + `53111e1`（终态快照种回内存 store）、
> `547635d`（label 回退解析 `labelFallback`）。本文补的是那次修复**没有覆盖**的一半：重启那一刻
> **还没终态**的 run。
> 方向（已由用户拍板）：子会话创建时就往主会话写一条**非终态** `subagent:run` 条目，终态条目照旧在后面
> 覆盖；重启后的种子逻辑把「只有非终态条目」的 run 按 aborted 语义种回，于是可 resume、可 get。

## 1. 背景与事故链

### 1.1 现在的持久化只有终态一条路

- run 的快照只在终态时写盘：状态机 `finish()` 产出 `persist_snapshot` effect（`src/core/state-machine.ts:368-384`），
  这是终态专属 effect（不变量 I4，`src/service/run-registry.ts:31-32`、`src/stack.ts:1587-1590` 都写明了）。
- effect 由 runtime adapter 执行：`deps.store.put(e.snapshot)`（`src/service/runtime-adapter.ts:347-351`）。
  stack 注入的 store 是 `wrapWithRunLog(baseStore, …)`（`src/stack.ts:1542-1544`），它的 `put` 先写内存，
  再 `pi.appendEntry("subagent:run", snapshot)` 写进**主会话** jsonl，异常一律吞掉（`src/adapters/pi-run-log.ts:26-35`）。
- stack 重建（每个 `session_start`）时，`seedRunStoreFromEntries` 把条目里的**终态**快照种回 base store
  （`src/adapters/pi-run-log.ts:70-98`，第 80 行 `TERMINAL_STATUSES` 过滤）；spawn-service 的解析器经
  `durableRecords: () => store.list()`（`src/stack.ts:1899`）读到它们，resume / get_subagent_result 才能跨进程工作。

### 1.2 遗留断链：重启时还在跑的 run 永远不能 resume

`resolveResumeTarget` 只接受 run id / 前缀 / label，最终从**终态**快照或 tombstone 取 `sessionFile`，
从不接受调用方给的路径（`src/service/resolve-target.ts:172-187`；终态过滤见 `snapshotWithSessionFile`，`:51-61`）。
所以只要没有终态快照，子会话文件即使完好躺在盘上也不可达。两条路径会落进这个洞：

1. **硬杀 / 崩溃**（SIGKILL、OOM、终端关闭、pi 崩溃）：`finish()` 根本没机会跑，主会话里没有任何该 run 的
   `subagent:run` 条目。
2. **`/reload`（以及 /new、/resume、/fork、quit）超时**：`session_shutdown` 给所有非终态 run 发
   `stop("shutdown")`，然后只等 `min(abortGraceMs×3, 15s)`（`src/index.ts:807-820`）。等不到的 run 之后才终态，
   但此时 pi 已在 shutdown 事件后调用 `invalidate()`（reload：`agent-session.js:2902-2903`；会话替换：
   `AgentSession.dispose()` → `_extensionRunner.invalidate(…)`，`agent-session.js:977-988`），旧 `pi.appendEntry`
   内部的 `assertActive()` 抛 stale（`extensions/loader.js:310-312`），被 `pi-run-log.ts:28-33` 静默吞掉。
   终态条目丢失，结局与崩溃相同。

用户可见症状：`Agent({ resume: "<label>" })` 返回 `resume target not found`，`get_subagent_result` 返回
`unknown run_id`，而子会话 jsonl 明明还在 `~/.pi/agent/sessions/` 下。

## 2. 现状取证（逐条核对过源码）

| #   | 事实                                                                                                                                                                                                           | 位置                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E1  | `persist_snapshot` 只在 `finish()` 里产出；`handleEffectFailed` 的重试也只在已有 `outcome` 时重发                                                                                                              | `state-machine.ts:345-440`、`:1080-1135`                                                                                 |
| E2  | `session_created` 在 `session_create / extension_bind / prompt_dispatch` 三个启动 phase 里只做 diag patch（写 `sessionFile`、`model`），**零 effect**；`abort_grace` 里被吞                                    | `state-machine.ts:218`、`:772-788`                                                                                       |
| E3  | runner 每个 generation 只派发一次 `session_created`，紧跟在 `driver.create/resume` 成功之后                                                                                                                    | `runtime/runner.ts:838-850`                                                                                              |
| E4  | generation 是 `RuntimeRunner` 进程内按 runId 自增（`?? 0) + 1`）；resume 会分配**新 runId**，所以实践中 generation 恒为 1                                                                                      | `runner.ts:689-690`、`spawn-service.ts:710-739`                                                                          |
| E5  | 子会话文件是**懒创建**的：pi 只在出现第一条 user/assistant message 时才 `openSync(…, "wx")`；`session_created` 时文件**尚未落盘**                                                                              | pi `session-manager.js:785-813`                                                                                          |
| E6  | 内存 store 按 `runId:generation` 存（`MemoryRunStore.put`）；多处代码依赖「运行中 `store.get(runId)` 恒为 undefined」                                                                                          | `core/store.ts:40-49`、`runtime-adapter.ts:644-648`                                                                      |
| E7  | 已存在的「一个 run 多条终态条目」：schema 策略复验后再 put（`runtime-adapter.ts:963-968`）、worktree 处置回写再 put（`:414-420`）、persist 重试 ≤3 次                                                          | 同左                                                                                                                     |
| E8  | 种子去重：每个 runId 取 `updatedAt` 最大者，同刻比 generation；**同刻同 generation 保留先出现者**                                                                                                              | `pi-run-log.ts:82-88`                                                                                                    |
| E9  | `query.list()` 合并 live records 与 store（`createLiveRunRegistry`），fleet widget、background-status、`/agent status`、`list_subagents`、consult 候选、shutdown pending 过滤**全部**从它取数                  | `run-registry.ts:34-50`、`index.ts:243-249`、`index.ts:813-815`、`ui/fleet-panel.ts:443-465`、`consult/index.ts:184-190` |
| E10 | `get_subagent_result` 非阻塞读：有 `outcome` 就 `formatOutcome`，否则输出 `Run … is still <status>`；`query.wait` 对「终态且有 outcome」立即返回，否则按 deadline 等                                           | `tools/result-tool.ts:377-410`、`service/query-service.ts:90-112`                                                        |
| E11 | fabric tree 回放直接扫原始条目：`appendEdge(parent, runId)`（会把节点放进 `pendingStarts`）；`status==="running"` 才 `markRunning`；终态才 `tombstone`。投递只看**目标**状态，`pending_start` 目标会被一直挂起 | `stack.ts:471-483`、`fabric/tree.ts:13-30,76-82,105-107`、`fabric/mailbox.ts:59-65`                                      |
| E12 | consult `ExpertIndex.rebuildFromEntries` 自己扫条目，`terminalStatus()` 过滤掉非终态；fork 副本按 consultDir 结构性排除                                                                                        | `consult/expert-index.ts:80-90,135-166`                                                                                  |
| E13 | session-nav 扫 `"subagent:run"` 行只取 `diag.sessionFile/agentType/label` 做标题标记，不看 status；同一子会话多条时保留第一条                                                                                  | `session-nav/subagent-sessions.ts:69-97,141-145`                                                                         |
| E14 | pi 的 custom 条目是会话树节点（`appendCustomEntry` 推进 leaf），`getEntries()` 返回文件里**所有**条目（不含 header）；compaction 只追加 compaction 条目，不重写文件；`_rewriteFile` 只用于版本迁移/空文件/分支 | pi `session-manager.js:754-761,900-912,1107-1109`                                                                        |
| E15 | `/fork`（`createBranchedSession`）只复制 leaf 路径上的条目，路径上的 custom 条目随之进入新文件                                                                                                                 | pi `session-manager.js:1255-1290`                                                                                        |
| E16 | worktree run 的子会话文件由 `SessionManager.create(cwd=worktree 路径)` 创建，落在 `~/.pi/agent/sessions/--<worktree 路径转义>--/`，**不在 worktree 目录里**；worktree 根是 `tmpdir()/pi-subagent-worktrees`    | `runtime/session-driver.ts:713-733`、pi `session-manager.js:290-302`、`extensions/worktree-orphans.ts:13-16`             |
| E17 | resume 走 `driver.resume(sessionFile, req)`，cwd 取 resume 请求自己的 `req.cwd`（覆盖 header cwd）                                                                                                             | `runner.ts:805-814`、`session-driver.ts:735-745`                                                                         |
| E18 | pi-ai 在回放历史时为「有 toolCall 无 toolResult」的悬空调用合成 `No result provided` 结果，并跳过 `stopReason` 为 error/aborted 的 assistant 消息——硬杀留下的半截会话可以直接 resume                           | pi-ai `api/transform-messages.js:128-200`（`:142` 合成结果、`:165` 跳过 error/aborted）                                  |
| E19 | `StopCause` 是封闭五值联合；consult 计划 §15 #1 明确拒绝为展示级区分扩它（会波及状态机 stop 分支、转移矩阵与属性测试）                                                                                         | `core/types.ts:33`、`consult/watcher.ts:3-11`                                                                            |
| E20 | 晚到的 worktree 处置已有一个「当前会话」死信落点 `subagent:worktree-disposition`，但**没有任何读取方**                                                                                                         | `stack.ts:2029-2036`、`adapters/worktree-disposition-sink.ts`                                                            |

### 2.1 条目体积实测

扫描本机 `~/.pi/agent/sessions` 下 207 个含 `subagent:run` 的主会话（3785 条终态条目，按 UTF-8 字节计）：

| 指标                                                                       | p50     | p90     | p99    | max    |
| -------------------------------------------------------------------------- | ------- | ------- | ------ | ------ |
| 现有终态条目（整行）                                                       | 30.2 KB | 54.7 KB | 126 KB | 248 KB |
| 模拟 session_created 时刻的非终态条目（`taskPrompt` 原样，上限 4096 字符） | 3.2 KB  | 5.5 KB  | 7.4 KB | 8.5 KB |
| 同上，`taskPrompt` 截到 1024 字符                                          | 2.5 KB  | 2.8 KB  | 3.0 KB | 3.4 KB |
| 同上，`taskPrompt` 截到 512 字符                                           | 1.7 KB  | 1.9 KB  | 2.1 KB | 2.3 KB |

- 现状 `subagent:run` 已占这些主会话总字节的约 22%（125 MB / 569 MB）。
- 每 run 条目数：1 条 3579 个 run，2 条 103 个（E7 的复写路径）。
- 体积大头是 `taskPrompt`：p50 1397 字符、p90 2833 字符（中文按 3 字节计）。终态条目的大头是
  `outcome.text` + `diag.text` 双份正文和 `toolHistory`，非终态条目在 session_created 时这些字段都还不存在。

## 3. 设计决策

### D1 写入时机：`session_created`，且只在首次拿到 `sessionFile` 时写一次

**结论**：在状态机 `session_created && startingPhase` 分支里，当 `input.sessionFile !== undefined` 且
`input.sessionFile !== state.diag.sessionFile` 时，额外产出一个新 effect `journal_snapshot`（D2）。
`abort_grace` 里的 `session_created` 维持零 effect（stop 已在途，没必要再记）。

依据与备选：

- **备选 enqueued**：排除。enqueue 时没有 `sessionFile`，条目对 resume 毫无用处；还会给每个被准入拒绝/
  排队超时的 run 多写一条，而这些 run 本来就会在 drain 窗口内正常终态（排队 run 一 stop 就立即 `finish`，
  `state-machine.ts:756-758` stop_requested@queue_wait 分支）。
- **备选 prompt_dispatch（等子会话文件真正落盘）**：排除。E5 表明 session_created 时文件尚未创建，但
  这并不需要推迟写入：种子侧本来就 `existsSync(sessionFile)` 过滤（`pi-run-log.ts:93`），在
  「建会话后、第一条 user 消息前」崩溃的 run 自然被滤掉——它的子会话里本来也什么都没有，无可恢复。
  写在 session_created 的好处是状态机里已有现成分支和 `sessionFile`，不必新增 phase 判定。
- **只写一次**的条件用 `sessionFile` 变化判断，而不是「phase === session_create」：`session_created` 理论上
  可在三个启动 phase 被接受（E2），以文件变化为准可防御重复派发。

**generation 语义**：条目携带 `state.generation`，与终态条目同一 `(runId, generation)` 键。由于 E4，
实践中恒为 1；种子按 D4 的优先级规则处理，不依赖 generation 区分新旧。

### D2 新 effect `journal_snapshot`，不复用 `persist_snapshot`，不进内存 store

**结论**：

```ts
// core/types.ts RunEffect 联合追加一员
| { kind: "journal_snapshot"; snapshot: RunSnapshot }
```

- criticality 走默认 `best_effort`（`envelope()` 只把四种列为 critical，`state-machine.ts:264-273`，无需改）。
- runtime adapter 的处理器**只调 `deps.journal?.(snapshot)`**，绝不 `store.put`。`deps.journal` 由 stack
  接到 run-log 的新方法 `journal()`：`try { pi.appendEntry(RUN_CUSTOM_TYPE, snapshot) } catch {}`。

理由：

- **I4 不能破**：E6 列出的多处代码（message_agent 的 generation 读取、mentionNotes 的 diagOf、worktree
  回写）依赖「运行中 store 里没有这个 run」。若复用 `persist_snapshot` 或让 journal 走 `store.put`，
  运行中的 run 会以过期快照出现在 store 里，`createLiveRunRegistry` 虽然 live 优先，但 store 层读者
  （`runtime-adapter.ts:414/966` 的 `deps.store.get`）会读到非终态快照并把它重新 put 成「终态」——直接是 bug。
- **不复用 `persist_snapshot`**：它是 critical、带 3 次 durable-retry 与 `persistFailed` 语义（E1），
  journal 是尽力而为的日志，不该触发 `diag.degraded` 补偿链或把 `outcome.persistFailed` 置位。
- **不新增 customType**（见 D9）。

由此得到本设计的核心不变量：

- **J1**：内存 `SnapshotStore` 永远只含终态快照——运行期如此（I4），种子后也如此（D4 把非终态映射成
  aborted 再种）。E9 的全部 `query.list()` 读者因此**无需任何改动**就不会把旧 run 显示成运行中。
- **J2**：journal 条目只经 `pi.appendEntry` 落盘，从不进入 base store，也从不被种子写回文件。
- **J7**：journal 写入同步、不 await、不抛（零挂起约束）。

### D3 条目内容：瘦身投影 + 每 run 最多 2 条非终态条目

**结论**：新增纯函数 `journalSnapshotFromState(state, at, mark)`（`src/core/run-journal.ts`），产出
`RunSnapshot` 的**白名单投影**：

- 顶层：`runId`、`generation`、`status`、`phase`、`deadlines`、`updatedAt = at`、`parentRunId?`、
  新增可选字段 `journal: RunJournalMark`；**不带 `outcome`**。
- `diag` 只保留：`createdAt enqueuedAt startedAt promptDispatchedAt phase phaseEnteredAt lastEventAt
lastEventType pendingTools turns usage contextUsage model label agentType taskPrompt worktree toolCounts
stopRequestedAt stopCause timeoutReason error orphaned generation deadlineAt hardDeadlineAt overtime
staleInputs sessionFile childExtensionMissing`；数组型必填字段 `escalation / degraded / unkillable` 置 `[]`。
- 丢弃：`text textFinal thinkingText toolHistory currentTool retry compacting absorbedRunIds
contextSwitches compactionFailures exitFacts finalLeafId persistStatus deliveryKey lastWarn lastTurnStartAt`。
- `taskPrompt` 截到 `JOURNAL_TASK_PROMPT_CAP = 1024` 字符（与 `TASK_PROMPT_CAP = 4096` 分开，终态条目不变）。

```ts
export const JOURNAL_TASK_PROMPT_CAP = 1024;
export interface RunJournalMark {
  kind: "session_created" | "shutdown_flush";
  /** shutdown_flush only: pi 的 session_shutdown reason（"reload" | "new" | "resume" | "fork" | "quit"）。 */
  shutdownReason?: string;
}
// core/types.ts RunSnapshot 追加
journal?: RunJournalMark;
```

**每 run 条目数上限**：非终态条目每 `(runId, generation)` **至多 2 条**——`session_created` 一条（D1），
`shutdown_flush` 一条（D5，仅当 shutdown drain 超时时它还没终态）。**不随 phase 推进重复写**。

- 成本：按 §2.1，截断后每 run 多 ≈2.5 KB，相对终态条目 p50 30 KB 约 +8%；flush 条目只出现在 shutdown
  超时的少数 run 上，体量同级（多了 usage/turns/toolCounts，少量字节）。
- 不按 phase 重复写的理由：resume 只需要 `sessionFile`，第一条就够；增量信息（usage、turns、部分正文）
  的权威来源是子会话文件本身（resume 后模型能看到全部历史）。每个 model_turn 写一条会让长 run 写出几十到
  上百条、主会话体积成倍增长，而崩溃后的 `get_subagent_result` 只多显示几个计数，收益不对称。
- 截断 1024 而非 512：1024 字符足够 `/agent status`、fleet 行、consult 的任务摘要（`EXPERT_TASK_SUMMARY_CHARS = 160`，
  `consult/expert-index.ts:48`）使用，且把 p99 压在 3 KB 内；512 只再省 0.8 KB。

### D4 种子侧：终态优先 → 非终态映射成 aborted（重启中断）

**结论**：改写 `seedRunStoreFromEntries`：

1. 收集所有 `subagent:run` 条目（不再在入口处按 `TERMINAL_STATUSES` 丢弃），保留既有的畸形防御
   （`runId` 字符串、`diag` 存在、`updatedAt` 为数字）。
2. **每个 runId 的选择规则（替换 E8 的比较）**：
   - 有任何终态条目 ⇒ 只在终态条目里选；否则在非终态条目里选；
   - 同类内 `updatedAt` 大者胜；相等时**文件中靠后者胜**（`>=`）。
     不再用 generation 做 tie-break（E4：恒为 1，且不同 generation 不会同 runId 同时活跃）。
3. 选出的若是非终态条目，经 `interruptedFromJournal(snapshot)` 合成一条**终态 aborted** 快照再种入。
4. 文件存在性过滤照旧（`fileExists(diag.sessionFile)`），对两类都生效。
5. 读取同批条目里的 `subagent:worktree-disposition`（E20）折叠进去，见 D7。

「同刻取先出现者」是现有代码的潜在缺陷：同一毫秒内 session_created 与终态（例如启动即失败）时，旧规则会
保留非终态那条。新规则「终态类优先」与 updatedAt 无关，天然正确；即使 shutdown flush 与终态竞争（flush
过滤后 run 恰好终态，终态条目先写、flush 条目后写且 updatedAt 更大），也是终态胜出。

**合成规则**（`interruptedFromJournal`，纯函数）：

```ts
export interface RestartInterruptedInfo {
  lastStatus: RunStatus;          // 条目里的 status（starting/running/stopping/queued）
  lastPhase: RunPhase;
  lastSeenAt: Millis;             // = 条目 updatedAt
  source: RunJournalMark["kind"]; // 条目缺 journal 字段时按 "session_created"
  shutdownReason?: string;
}
// core/types.ts RunDiagnostics 追加（可选，仅种子合成的内存快照会有）
restartInterrupted?: RestartInterruptedInfo;
```

- `status: "aborted"`、`phase: "settled"`、`updatedAt = lastSeenAt`（**不用重启时刻**：候选列表的
  `ageMinutes`、fleet 的 recentTerminal 排序、labelFallback 的「最新者胜」都应反映 run 最后活着的时刻，
  而不是把历史中断 run 全部伪装成「刚结束」挤进 fleet 前三行）。
- `diag`：在投影 diag 上设 `phase:"settled"`、`phaseEnteredAt/settledAt = lastSeenAt`、
  `stopCause: diag.stopCause ?? "shutdown"`、`error`（见下）、`restartInterrupted`。
- `outcome`：`{ runId, status:"aborted", turns, durationMs: max(0, lastSeenAt - deadlines.enqueuedAt),
usage?, error, diag }`——**必须有 outcome**：E10 表明没有 outcome 的快照会让 `get_subagent_result`
  输出「still running」、让 `query.wait` 一直等到 deadline。
- `error: { kind: "aborted", retryable: false, message }`，message 由 `restartInterruptedMessage()` 生成
  （模型读，英文，与 `formatOutcome` 现有文案同语种）：

  ```
  interrupted by a pi restart (<shutdownReason 或 "crash/kill">): the run was still <lastStatus>
  (phase <lastPhase>) when last recorded at <ISO lastSeenAt>; its final result was never recorded.
  The child session is intact — continue it with Agent({ resume: "<runId>", ... }).
  ```

  `formatOutcome` 的非 completed 分支取 `error.message`（`result-tool.ts:552`），于是读到
  `Subagent run aborted: interrupted by a pi restart …`，无需改 result-tool。`retryable:false`：补救手段是
  resume，不是自动重试。

**StopCause 不扩**：`StopCause` 封闭（E19），合成快照永远不经过 reducer，用既有 `"shutdown"` 表达「被宿主
关停」，精确区分放在新增的可选 `diag.restartInterrupted` 上（与 consult 的 `capReason` 同一取舍）。
对 `/reload` 超时这条路径，`"shutdown"` 本来就是真实 stopCause（`index.ts:816`）。

### D5 `/reload` 等关停：session_created 条目已闭合 resume 断链；再加一次 shutdown flush 补 usage

**结论**：

1. 有了 D1，凡是已经建出子会话的 run，无论终态条目是否因 stale 丢失，下一个 stack 都能种回并 resume——
   **resume 可用性的窗口已完全闭合**，不需要任何「迟到终态改投」机制。
2. 额外在 `session_shutdown` 里、drain 等待之后**同步**做一次 best-effort flush：对仍未终态的 run 各写一条
   `journal.kind = "shutdown_flush"` 条目（带最新 usage/turns/toolCounts/stopCause、`shutdownReason = event.reason`）。

顺序（`src/index.ts:776-830` 内）：

```
… stack.fabric?.dispose();
stack.workflow.runs.shutdown();
const pending = …;                       // 现有
await stop(pending, "shutdown");          // 现有
await Promise.all([waitAll(drainMs), workflow.drain(drainMs)]);   // 现有
stack.runJournal.flushPending(pending.map(s => s.runId), event.reason);  // ← 新增，同步
stack.workflow.runs.seal();               // 现有
…
```

- 可行性：pi 是先 `await emitSessionShutdownEvent(...)`，**之后**才 `invalidate()`（reload 与会话替换两条路径都是，
  §1.2），所以 handler 内的 `pi.appendEntry` 仍然有效，且写入目标就是**这个 run 所属的会话文件**
  （/new、/fork 时也不会写进新会话）。
- 为什么 flush 值得做：被 shutdown 停掉的 run，其真实终态必然是 `aborted(shutdown)` 加部分输出——flush 条目
  已经携带除正文外的全部信息；缺了它，重启后 `/agent costs`、HUD 子 agent 花费、fleet 行都会丢掉这个 run
  已经花掉的 usage（session_created 时 usage 为空）。
- **不做的备选：迟到终态改投当前会话**（仿 `writeLateWorktreeDisposition`，E20）。排除：只有 `/reload` 时
  「当前会话 == 原会话」，/new、/resume、/fork 时改投会把旧 run 复活进错误的会话（D13 已记录过这个风险）；
  而它相对 flush 唯一多出的信息是部分正文，正文在子会话文件里，resume 即可见。复杂度不对称。
- **硬杀/崩溃**没有 flush，只有 session_created 条目：种回后 usage 未知（显示为空），这是可接受的降级。

### D6 各消费面的行为（逐个结论）

| 消费面                                            | 结论                                                                                                                                                                                                                                                                                                                                                                                                                  | 改动                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `resolveResumeTarget`                             | 种回的是终态 aborted 快照，`snapshotWithSessionFile` 通过；`existsSync/statIsFile` 校验照旧。按 id、前缀、label（`labelFallback` 扫 `diag.label`）都能解析，候选列表显示 `(aborted, Nm ago)`                                                                                                                                                                                                                          | 无                                            |
| spawn-service resume 准入                         | `running.has(targetId)` 不命中（新进程），走正常 resume；`resumeLocks` 照旧防重入                                                                                                                                                                                                                                                                                                                                     | 加 D8 的「同进程旧 stack 仍持有该子会话」守卫 |
| `get_subagent_result`                             | 非阻塞读：`Subagent run aborted: interrupted by a pi restart …` + `(duration: …)`；`wait:true` 立即返回同一文本（E10）；`tryAck` 对无 outbox 记录的 run 是空操作（与现有种回的终态 run 相同）                                                                                                                                                                                                                         | 无                                            |
| fleet widget / `/agent status` / `list_subagents` | 合成快照是终态：不计入 active、不显示为 running；只在 recentTerminal（按 `updatedAt` 排序）里出现，而 `updatedAt` 是最后活着的时刻，旧中断 run 不会挤到前面                                                                                                                                                                                                                                                           | 无                                            |
| background-status（feishu-notify 的忙闲门）       | 只数 `queued/starting/running/stopping`（`index.ts:246-248`），合成快照不计入                                                                                                                                                                                                                                                                                                                                         | 无                                            |
| shutdown pending 过滤                             | 合成快照是终态，不会被再次 `stop()`（若种回的是非终态快照，这里会对一个不存在的 run 发 stop 并空等 drain）                                                                                                                                                                                                                                                                                                            | 无                                            |
| deferred `/reload`（`src/reload/`）               | 以 fleet 是否 settled 为准，经 `query.list()`，不受影响                                                                                                                                                                                                                                                                                                                                                               | 无                                            |
| consult `ExpertIndex`                             | 自扫条目且 `terminalStatus()` 过滤（E12），原始非终态条目被忽略；同 runId 的终态条目照常收录                                                                                                                                                                                                                                                                                                                          | 无（加回归测试）                              |
| consult live 候选（`query.list()`）               | 合成 aborted 快照会作为候选出现。顶层 `Agent({ experts })` 本来就接受 aborted 专家；workflow 的 `completedOnly` 会以 `ended as aborted` 拒绝。与现有 aborted 专家一致，接受                                                                                                                                                                                                                                           | 无（文档化）                                  |
| fabric tree 回放                                  | **必须改**：原逻辑对非终态条目 `appendEdge` 后既不 `markRunning`（status 是 `starting`）也不 `tombstone`，节点永久 `pending_start`，发给它的消息会被 mailbox 一直挂起（E11）。改为每个 runId 取「终态优先、否则最新」的条目，`appendEdge` 后**一律 `tombstone`**——stack 构建时刻不可能有旧 run 活着（session_shutdown 已 stop 全部 run，新 runner 是新实例），死去的发送方不影响已有记录投给 root（投递只看目标状态） | `stack.ts:471-483`                            |
| session-nav 标题标记                              | 只取 `sessionFile/agentType/label`（E13），非终态条目与终态条目三字段相同（label/agentType 在 enqueue 时就定了），「保留第一条」得到同一标题；附带收益：崩溃 run 的子会话现在也能被标成 `[sub:type]`                                                                                                                                                                                                                  | 无（加回归测试）                              |
| worktree 处置死信                                 | 种子顺带读取，见 D7                                                                                                                                                                                                                                                                                                                                                                                                   | `pi-run-log.ts`                               |

### D7 worktree run：前提纠正 + 退化链

**纠正**：调用方设想「分支已删时 sessionFile existsSync 为 false，被种子自然过滤」不成立。E16：worktree
run 的子会话文件在 `~/.pi/agent/sessions/--<worktree 路径转义>--/` 下，与 worktree 目录、`pi-agent-<runId>`
分支的生死无关；`git worktree remove`、删分支、清 tmp 都不会动它。只有用户手工删 sessions 目录时
`existsSync` 才为 false（那时过滤照样成立）。

**实际退化链**：

1. 非终态条目照常写（`diag.worktree = { state: "active" }`，enqueue 时折入）。
2. 种子：sessionFile 在 ⇒ 种回、可 resume。
3. resume 的 cwd 取 resume 请求自己的 `req.cwd`（E17）：默认是主会话 cwd，**不会**回到原 worktree——
   这与今天 resume 一个已终态的 worktree run 完全相同，不是新行为。
4. 硬杀时 H3（beforeReap 提交）没跑：worktree 目录作为孤儿留在 `tmpdir()/pi-subagent-worktrees` 下，
   未提交改动还在；启动时的只读孤儿扫描（`extensions/worktree-orphans.ts`，无 GC）会提示用户。
5. `/reload` 超时时 H3 可能在旧 stack 里继续跑完，处置经死信落点写进**当前**会话（reload 下就是同一文件）的
   `subagent:worktree-disposition` 条目（E20）。

**设计**：

- 合成时 `diag.worktree.state === "active"` ⇒ 改为 `{ state: "kept" }`（「目录留在盘上、未确认提交」，
  `WorktreeDisposition` 现有最接近的状态；fleet 行不会出现一个已终止却仍 `active` 的 `⎇` 标记）。
- 种子同批扫描 `subagent:worktree-disposition` 条目（`LateWorktreeDisposition`：runId/state/branch/path/at），
  对**任何**被种回的快照（终态或合成），若其 `diag.worktree` 缺席或为 `active/kept-无-path`，用该 runId
  `at` 最大的一条覆盖 `diag.worktree`（committed 带 branch）。这让 E20 那个只写不读的落点第一次有了读取方，
  代价是种子里多一个分支判断。
- `restartInterruptedMessage` 在 `diag.worktree` 存在时追加一句：
  `Its worktree changes may be uncommitted on disk — check /agent status for orphan worktrees before resuming.`

### D8 同进程 `/reload` 后立即 resume 的双写守卫

**风险**（本设计引入的新可达路径）：`/reload` drain 超时后，旧 stack 的 run 仍在 abort_grace / reap 里收尾，
其子会话可能还在写同一个 jsonl；新 stack 已把它种成「可 resume」。此时立刻 resume 会出现两个 `AgentSession`
往同一文件 `appendFileSync`，树结构（parentId）分叉。崩溃路径不受影响（旧进程已死）。

**结论**：新增进程级（`Symbol.for` 全局，同 `core/worktree-origin.ts` 的豁免类）登记表
`src/core/live-session-files.ts`：

```ts
export function markLiveSessionFile(file: string, owner: string /* runId */): void;
export function releaseLiveSessionFile(file: string, owner: string): void; // 按 owner 身份释放
export function isLiveSessionFile(file: string): boolean;
```

- `RuntimeRunner` 在派发 `session_created` 前 mark（`handle.sessionFile` 存在时），在 `notifyReaped`
  （`runner.ts:1060-1066`，每条回收路径的汇合点）release。
- spawn-service resume 准入在 `resolveResume` 成功后、写 `resumeLocks` 前检查
  `isLiveSessionFile(resume.sessionFile)`，命中则返回
  `config` 错误：`run <id>'s session is still being closed by the previous session stack; retry in a few seconds`。
- 不可杀孤儿（reaper L4 `unkillable`）永远不 release ⇒ 该文件在本进程内永远不能 resume——这是正确的
  （它可能还在写），且是准入拒绝而非挂起，不违反零挂起。
- 备选「resume 前比较文件 mtime 是否稳定」：排除，竞态窗口不可证明关闭。

### D9 customType 不变：仍是 `subagent:run`

**结论**：非终态条目沿用 `customType: "subagent:run"`，用 `status` 非终态 + 可选 `journal` 字段区分。

- 用新 type（如 `subagent:run-journal`）的代价：种子、fabric 回放、session-nav 都得合并两路流并重新实现
  「同 runId 取最新」，ExpertIndex 反而要显式忽略一个它本不认识的 type；而本设计的「终态覆盖」恰好依赖两类
  条目在同一流里按文件顺序排列。
- 旧读者的安全性逐个核过（§6.2）：唯一的瑕疵是旧版 fabric 回放会把崩溃 run 留成 `pending_start`，影响仅限
  「旧版本读取新版写的会话、且有人给那个死 run 发消息」，消息按 reconcile TTL 过期，不造成挂起。

### D10 只读域 run 不写 journal

**结论**：`readonlyDomain`（consult fork `forkSessionFrom !== undefined` 或 `toolDomain === "readonly"`，
`runtime-adapter.ts:550-557`）的 run **不写** journal，shutdown flush 也跳过。

- consult fork 的子会话是 consultDir 下的临时副本，终态后回收时删除；崩溃时副本残留，若写了 journal 就会被
  种成「可 resume」——consult 副本不该被 resume。
- `/mem tidy` 的 run 是调用方持有、`suppressDelivery` 的只读整理任务，没有续跑语义。
- 实现：adapter 维护 `journalSuppressedRunIds`，在计算出 `readonlyDomain` 时加入，在 run 的 `finally` 里删除
  （与 `notificationSuppressedRunIds` 同位置、同生命周期，`runtime-adapter.ts:539/1004`）。
  不用 diag 标记判定：`RunDisplayMeta.consultOf` 并不折进 diag（`state-machine.ts` enqueued 分支只折 5 个字段）。

## 4. 接口契约汇总

```ts
// ── src/core/types.ts（全部为可选/新增成员，向后兼容）
export type RunEffect = /* … */ | { kind: "journal_snapshot"; snapshot: RunSnapshot };
export interface RunSnapshot { /* … */ journal?: RunJournalMark }
export interface RunDiagnostics { /* … */ restartInterrupted?: RestartInterruptedInfo }
// RunJournalMark / RestartInterruptedInfo 定义在 core/types.ts（被 RunSnapshot/RunDiagnostics 引用）

// ── src/core/run-journal.ts（新，pi-free）
export const JOURNAL_TASK_PROMPT_CAP = 1024;
export function journalSnapshotFromState(state: RunState, at: Millis, mark: RunJournalMark): RunSnapshot;
export function interruptedFromJournal(snapshot: RunSnapshot): RunSnapshot;    // 输出恒为终态 aborted + outcome
export function restartInterruptedMessage(runId: RunId, info: RestartInterruptedInfo, worktree?: WorktreeDisposition): string;

// ── src/core/live-session-files.ts（新，pi-free，Symbol.for("pi-subagent:live-session-files")）
export function markLiveSessionFile(file: string, owner: string): void;
export function releaseLiveSessionFile(file: string, owner: string): void;
export function isLiveSessionFile(file: string): boolean;

// ── src/adapters/pi-run-log.ts
export function wrapWithRunLog(base, pi): SnapshotStore & {
  verifyLanded(runId, generation): boolean;
  /** J2: 只 appendEntry，不碰 base；永不抛。 */
  journal(snapshot: RunSnapshot): void;
};
export function seedRunStoreFromEntries(base, entries, fileExists?): number;   // 签名不变，语义按 D4/D7
export const WORKTREE_DISPOSITION_CUSTOM_TYPE = "subagent:worktree-disposition"; // 从 stack.ts 字面量提出

// ── src/service/runtime-adapter.ts
interface RuntimeAdapterDeps { /* … */ journal?: (snapshot: RunSnapshot) => void }

// ── src/service/ports.ts  Runner
/** D5: 同步、尽力而为；返回实际写入条数。只写仍非终态、有 sessionFile、非只读域、本 stack 尚未 flush 过的 run。 */
flushJournal?(runIds: readonly RunId[], mark: RunJournalMark): number;

// ── src/stack.ts  Stack
runJournal: { flushPending(runIds: readonly RunId[], shutdownReason: string): number };
```

错误约定：journal 链路上任何异常（appendEntry stale、序列化失败）一律吞掉，不进 `effect_failed`
（处理器内部 try/catch，effect 本身永不失败），不 WARN（每 run 至多两条，stale 在 reload 时是常态）。
种子对畸形条目静默跳过（现有约定）。

## 5. 施工分解

> 各包可独立合入且每包后 `npm test` 绿；P1→P2→P3 有依赖，P4 只依赖 P1。

### P1 core：类型、journal 投影、状态机 effect

改动：

- `src/core/types.ts`：`RunEffect` 加 `journal_snapshot`；`RunSnapshot.journal?`；`RunDiagnostics.restartInterrupted?`；
  `RunJournalMark`、`RestartInterruptedInfo` 类型。
- `src/core/run-journal.ts`（新）：`JOURNAL_TASK_PROMPT_CAP`、`journalSnapshotFromState`、`interruptedFromJournal`、
  `restartInterruptedMessage`（D3/D4/D7 规则）。
- `src/core/state-machine.ts`：`session_created && startingPhase` 分支（`:774-788`）在 D1 条件成立时改为
  `emit(next, [{ kind: "journal_snapshot", snapshot: journalSnapshotFromState(next, input.at, { kind: "session_created" }) }])`；
  条件不成立时保持现状（零 effect）。注意用 `emit()` 以推进 `effectSeq`。

测试：

- `tests/core/run-journal.test.ts`（新）：白名单字段保留 / 丢弃；`outcome` 不出现；taskPrompt 截断到 1024；
  体积预算——构造「所有保留字段取上限」的最大夹具，`JSON.stringify` 字节数 < 6 KiB；`interruptedFromJournal`：
  status/phase/outcome 齐全、`updatedAt = lastSeenAt`、`stopCause` 缺省为 `"shutdown"`、已有 stopCause 保留、
  usage 透传、`durationMs` 非负、`worktree active→kept`、缺 `journal` 字段时 `source = "session_created"`；
  message 含 runId 与 `resume`。
- `tests/core/core.test.ts`：手写用例——session_create phase 带 `sessionFile` 的 `session_created` 产出恰好一个
  `journal_snapshot`（criticality `best_effort`，snapshot.status `starting`，无 outcome）；同一 sessionFile 重复派发零
  effect；无 sessionFile 零 effect；`abort_grace` 零 effect；终态后零 effect。**转移矩阵不改**（`buildInput` 的
  `session_created` 不带 sessionFile，168 格 oracle 照旧，`diagSessionCreated` 的 `effects=[]` 断言照旧成立）。
  新增属性 P15（独立生成器，序列中的 `session_created` 随机带/不带 sessionFile）：每个 generation
  `journal_snapshot` ≤ 1、只从非终态状态产出、从不 critical、终态后从不出现。
- 回归：grep 测试中对「完整 effect 序列 / effect audit 列表」做精确断言、且 fake handle 提供了 `sessionFile`
  的用例（`tests/runtime/*`、`tests/integration/child-bash-exit-facts.test.ts` 等），按需把 `journal_snapshot`
  加进期望序列。

### P2 种子与 run-log

改动：

- `src/adapters/pi-run-log.ts`：
  - `wrapWithRunLog` 返回值加 `journal(snapshot)`（try/catch 包 `appendEntry`，不碰 base）。
  - `seedRunStoreFromEntries` 按 D4 重写选择规则（终态类优先 → 同类 updatedAt → 文件序靠后），非终态经
    `interruptedFromJournal` 合成；同批扫描 `subagent:worktree-disposition` 并按 D7 折叠；存在性过滤照旧。
  - 导出 `WORKTREE_DISPOSITION_CUSTOM_TYPE`。
- `src/stack.ts:2032`：字面量改用该常量（零行为变化）。

测试（`tests/adapters/pi-run-log.test.ts`）：

- **修改**现有用例 `seeds terminal snapshots … skips running and dead files`：其 `r_running` 夹具带 `diag` 与
  `updatedAt`，新语义下会被种成 aborted——期望改为种入 3 条、`r_running` 状态 `aborted` 且带 `restartInterrupted`。
- 修改 `keeps only the latest snapshot per runId` 的标题与断言（tie-break 从 generation 改为文件序）。
- 新增：终态条目 updatedAt 更小也胜过非终态条目；同类同 updatedAt 后出现者胜；`session_created` + `shutdown_flush`
  两条非终态取后者（`source = "shutdown_flush"`、usage 来自它）；非终态条目 sessionFile 缺失/不存在被滤掉；
  旧版无 `journal` 字段的非终态条目也能合成；worktree-disposition 折叠（committed 覆盖 active、`at` 最大者胜、
  不覆盖已有 committed）；种子后 base store 里不存在任何非终态快照（J1）；种子不经写穿包装、零 appendEntry（沿用现有用例）。
- `wrapWithRunLog.journal`：只 append 不 put（`base.get` 仍 undefined）；`appendEntry` 抛错被吞。

### P3 adapter 接线、shutdown flush、fabric 回放

改动：

- `src/service/runtime-adapter.ts`：
  - `RuntimeAdapterDeps.journal?`。
  - `BasicEffectInterpreter` handlers 加 `journal_snapshot`：被 `journalSuppressedRunIds` 命中则跳过，否则
    `deps.journal?.(e.snapshot)`；处理器内 try/catch。
  - `journalSuppressedRunIds`：`readonlyDomain` 算出后加入（`:557` 之后），`finally`（`:1004` 附近）删除。
  - 实现 `flushJournal(runIds, mark)`：对每个 id，跳过「被抑制 / 已 flush 过 / `runtime.getRunState(id)` 缺失或
    终态 / 无 `diag.sessionFile`」，否则 `deps.journal?.(journalSnapshotFromState(state, clock.now(), mark))`；
    用本 adapter 内的 `journalFlushed` Set 保证每 run 至多一次（J3）。
- `src/service/ports.ts`：`Runner.flushJournal?`。
- `src/stack.ts`：
  - `createRuntimeRunnerAdapter({ …, ...(readBack ? { journal: store.journal } : {}) })`（`store` 即
    `wrapWithRunLog` 返回值；`readBack=false` 时不注入，journal 整体失效，与 run-log 降级一致）。
  - `Stack.runJournal = { flushPending: (ids, reason) => runner.flushJournal?.(ids, { kind: "shutdown_flush", shutdownReason: reason }) ?? 0 }`。
  - `buildFabric` 回放（`:471-483`）：先按 runId 归并（终态优先、否则最新），再对每个 runId
    `appendEdge(parent ?? "root", runId)` + `tombstone(runId, now, reconcileTtlMs)`；删除不再可达的 `markRunning` 分支。
    归并后每个 runId 只 `appendEdge` 一次，顺带消除「同 runId 多条目重复 appendEdge」对 `append` 抛错的依赖。
- `src/index.ts`：`session_shutdown` 中 drain 之后、`stack.workflow.runs.seal()` 之前插入
  `stack.runJournal.flushPending(pending.map((s) => s.runId), event.reason)`（I7：只是一行装配调用）。

测试：

- `tests/service/runtime-adapter-journal.test.ts`（新，仿 `tests/integration/worktree-late-dispose.test.ts` 的
  real adapter + fake driver 套件）：fake handle 带 sessionFile 时 `deps.journal` 被调用恰好一次、快照是瘦身
  非终态形状；运行中 `deps.store.get(runId)` 仍为 undefined（I4）；consult fork 与 `toolDomain:"readonly"` 的 run
  不写；`flushJournal` 只写非终态 run、每 run 一次、对已终态/无 sessionFile/被抑制者返回 0；`deps.journal` 抛错不影响
  run 结局。
- `tests/integration/restart-resume.test.ts`（新，端到端，核心验收）：
  1. 「进程 1」：`entries` 数组充当主会话（同 `fabric-wiring.test.ts` 的 harness 思路），`wrapWithRunLog` 写入它；
     real adapter + spawn-service + fake driver，fake handle 的 `sessionFile` 指向临时目录下真实写过一行的文件，
     `prompt()` 永不 resolve；spawn 一个带 label 的 run，等到 `journal_snapshot` 落入 `entries`；**不 settle、直接丢弃**
     进程 1 的全部对象（模拟硬杀）。
  2. 「进程 2」：新 `MemoryRunStore` + `seedRunStoreFromEntries(entries)` + 新 spawn-service（`durableRecords`）：
     `query.get(runId)` 为 aborted 且 outcome.error 含 `interrupted by a pi restart`；`query.wait` 立即返回；
     `spawn({ resumeFrom: label })` 与 `resumeFrom: runId` 都成功，fake `driver.resume` 收到的就是那个 sessionFile。
  3. `/reload` 变体：进程 1 在丢弃前调用 `runner.flushJournal([...], { kind:"shutdown_flush", shutdownReason:"reload" })`，
     进程 2 的合成快照 `restartInterrupted.source === "shutdown_flush"`、usage 来自 flush。
  4. 负例：sessionFile 被删除后进程 2 不种回、resume 返回 `resume target not found`。
- `tests/integration/fabric-wiring.test.ts`：保持 T17/T18'/T19 绿（T17 用 `runEntry("running")` 作夹具；改造后该 run 被
  tombstone，但 pending 记录的目标是 root，投递只看目标状态，期望不变——施工时务必实跑确认）；新增：仅有非终态
  `subagent:run` 条目的 run 在回放后 `targetState === "gone"`，发往它的 pending 记录按 `target_gone` 处理而不是挂起。
- `tests/integration/background-status-wiring.test.ts`：种入一条非终态条目后 `runningSubagents` 仍为 0。
- `tests/consult/expert-index*.test.ts`：非终态原始条目被忽略；其后的终态条目照常收录。
- `tests/session-nav/*`：同一子会话的非终态 + 终态条目产出同一个标记。
- `index.ts` shutdown 顺序：若已有覆盖 `session_shutdown` 的集成套件（如 `tests/integration/worktree-late-dispose.test.ts`、
  `fleet-widget-lifecycle.test.ts`）便于注入一个 drain 超时的 run，则补一条「flush 在 seal 之前、写入当前会话」的断言；
  否则以 adapter 层用例为准。

### P4 同进程双写守卫

改动：

- `src/core/live-session-files.ts`（新）：`Symbol.for("pi-subagent:live-session-files")` 上的 `Map<file, Set<owner>>`，
  无 pi 依赖、无定时器。
- `src/runtime/runner.ts`：`session_created` 派发前 `markLiveSessionFile(handle.sessionFile, runId)`；`notifyReaped`
  内 `releaseLiveSessionFile(…)`（需要把 sessionFile 记进现有 `activeHandles` 条目或单独 Map）。
- `src/service/spawn-service.ts`：resume 分支（`:730-739`）在 `resolveResume` 成功后检查 `isLiveSessionFile`。

测试：

- `tests/core/live-session-files.test.ts`（新）：mark/release 按 owner 身份；同文件多 owner；release 未知 owner 无副作用。
- `tests/service/resume.test.ts`：live 登记命中时 resume 被拒且**不写** `resumeLocks`、不登记 label；release 后可 resume。
- `tests/runtime/*`：正常回收路径与启动失败回收路径都 release（防泄漏）。

## 6. 兼容性与回滚

### 6.1 新 toolkit 读旧条目

- 旧条目全是终态，种子行为与现在相同（选择规则只在「同 runId 多条」时有差别：原 generation tie-break → 文件序，
  E4 下等价）。
- 旧版本若在某处写过非终态 `subagent:run`（实际没有：persist 一直是终态专属）也能被合成，`journal` 缺省按
  `session_created` 处理。

### 6.2 旧 toolkit 读新条目（降级）

| 旧读者                                          | 行为                                   | 影响                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seedRunStoreFromEntries`（`2b47d9b` 之后版本） | `TERMINAL_STATUSES` 过滤丢弃非终态条目 | 无（回到今天的断链行为）                                                                                                                                           |
| `2b47d9b` 之前版本                              | 不种子                                 | 无                                                                                                                                                                 |
| `ExpertIndex`                                   | `terminalStatus()` 过滤                | 无                                                                                                                                                                 |
| session-nav                                     | 同一标题标记                           | 无                                                                                                                                                                 |
| fabric 回放                                     | 崩溃 run 节点留在 `pending_start`      | 发往该死 run 的消息挂到 reconcile TTL 过期；不阻塞其他投递                                                                                                         |
| `verifyLanded`                                  | 按 `(runId, generation)` 匹配任意条目  | 终态写入失败时可能被非终态条目「误判已落盘」——但 `verifyLanded` 在现有代码里没有调用方（`grep` 仅定义处），无实际影响；新代码若启用它须加 `TERMINAL_STATUSES` 条件 |

新增字段（`RunSnapshot.journal`、`RunDiagnostics.restartInterrupted`、`RunEffect` 新成员）全部可选；
`restartInterrupted` 只存在于内存合成快照，从不落盘。

### 6.3 回滚

直接 revert 代码即可：已写入的非终态条目留在主会话文件里，按 §6.2 被旧代码忽略；不需要数据迁移，
不需要清理脚本。`/reload` 后立刻生效（模块重新加载）。

### 6.4 体积与清理

- 条目永久留在主会话 jsonl（E14：pi 不重写、不 GC custom 条目；`/fork` 只沿 leaf 路径复制，E15）。
  新增量按 §2.1 约为每 run +2.5 KB（+8%），不设清理机制——与现有终态条目同一生命周期，清理主会话即清理它们。
- 硬上限由白名单投影保证：所有可能变长的保留字段（label、model、sessionFile 路径、toolCounts、usage、
  contextUsage）都有界，taskPrompt 已截断；P1 用最大夹具测试把它钉在 6 KiB 以内。

## 7. 已知取舍与残余风险

1. **建会话后、首条 user 消息前崩溃**的 run（E5）：子会话文件不存在，被种子滤掉，`get_subagent_result` 仍是
   `unknown run_id`。窗口约等于 extension_bind 耗时（通常亚秒到数秒），且无可恢复内容，接受。
2. **主会话自身尚未落盘**（主会话还没有任何 user/assistant 消息时由 `/task`、cron 发起的 run）：`appendEntry`
   停在内存，崩溃即丢——与终态条目相同的既有限制。
3. **不推送中断通知**：重启后不会为中断 run 自动发完成通知。每次 stack 重建都会重新种回全部历史中断 run，
   自动通知需要另建持久 ack 账本；本设计只保证「问得到」（`get_subagent_result`、`list_subagents`、`/agent status`）。
   扩展点：在 `session_start` 时对 `lastSeenAt` 晚于上次 stack 构建时刻的中断 run 发一次性提示。
4. **workflow 本身不可恢复**：后台 workflow 注册表在内存里（`src/workflow/background.ts`），重启后只有它的
   子 run 以中断 aborted 种回；workflow 级别的续跑不在本文范围。
5. **跨进程同时打开同一主会话**（两个 pi 进程 resume 同一会话文件）：P4 的守卫是进程级的，不覆盖这种用法；
   与现有终态 run 的 resume 风险相同，不新增。
6. **`/fork` 后的两个会话都能 resume 同一子会话**：fork 复制了 journal 条目（E15）。现有终态条目同样被复制，
   不是新风险；`resumeLocks` 与 P4 都只在进程内生效。
7. 中断 run 的 usage 在硬杀路径下未知；在 shutdown 路径下取 flush 时刻值，漏掉 flush 之后到真正终止之间的
   少量花费（abort_grace 期间通常为零或一轮）。

## 8. 给下游的实施提示

- 先做 P1 并跑全量测试，观察哪些「精确 effect 序列」断言因 `journal_snapshot` 变化，再决定是改期望还是让对应
  fake handle 不带 sessionFile——**不要**为了让旧断言通过而把 journal 条件放宽到「无 sessionFile 也写」。
- 种子是唯一的「非终态 → 终态」映射点（J1）。任何读 `query.list()` / `store.list()` 的新代码都不应再自己处理
  非终态原始条目；需要直接扫条目的模块（fabric、ExpertIndex、session-nav）在本文 §D6 已逐个定论。
- `src/index.ts` 只加一行装配调用（I7）；flush 逻辑在 adapter，可测。
- 所有新增代码不得引入定时器；若将来需要，必须 `unref()`（print 模式约束）。
- 合入前按 AGENTS.md 跑 `format:check → typecheck → test → build`。
