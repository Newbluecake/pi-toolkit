# workflow agent() 真正的 worktree 隔离（todo #10，L2）— 方案 v2.1

> 状态：v2.1。v2 复审结论为「有条件通过」（8 条中 5 条闭合、3 条部分闭合；新发现严重 2 条、一般 3 条），本版把这些条件逐条落实为可实施、可测的设计（D5a、D9 的 prompt 路径、D12、D13、§3 owner token），处置见文末「v2→v2.1 条件落地」。v1 的评审处置仍保留在文末。用户已确认的决定见 §0。依赖：workflow-experts 已合入 master（`56cbd1d` 严格 opts、`6994986` experts + chain-taint、`ee02801`）。
> 本方案只包含本文件。实现按 §5 的四个包**串行**进行。

## 0. 已定决定（用户确认 v1 + 主会话拍板 v2 / v2.1）

1. worktree 功能关闭时，`agent({ isolation })` **直接拒绝**，不降级（与顶层 Agent 的「no fallback」一致）。
2. **实现 `worktree.linkPaths`**：默认 `[]`，本机配置 `["node_modules"]`，同时作用于顶层 Agent。link path 是**只读共享依赖**，不加锁（§2 D9，已接受的风险）。
3. **consult cwd 本期必做（P3）**：worktree 隔离的提问方（顶层 Agent 或 workflow 子 run）发起的 consult，其 fork 和 spawn 都在提问方**自己的 worktree** 里进行。
4. 回放选 A：带 isolation 的调用，以及它之后提交的调用，都不读也不写 journal。「校验分支后回放」另记 todo。
   已由 `docs/dev/workflow-worktree/replay-verify-plan.md`（todo #13）取代：`workflow.isolationReplay="off"`（非默认）时仍为本方案 A；默认 `"verify"` 时按新方案的加载时快照校验回放。
5. 子 run 失败时 agent() 仍然返回 `null`，分支只在 outcome 文本里列出。
6. 自动提交**不加** `--no-verify`，用户 hook 照常执行。
7. 等待 disposition 的上限从**实际生效**的 reapMs 推导。`pending` 一旦出现在脚本返回值里就不会再变；晚到的 disposition 只进入 workflow 终态 outcome 和 run log，不会回填给 worker（§2 D5）。
8. 残留 worktree 不做自动 GC（有丢失未提交工作的风险），只做启动时发现 + `/agent status` + 一次性提示（P4）。
9. （v2.1）H2 必须可取消：超时后迟到完成的 H2 要做有界的补偿清理，失败则保留现场并交给 P4 提示（D12）。
10. （v2.1）晚到路径（等待者、timer、reapMs 表、disposition 回写）必须能 dispose。stack 重建或 shutdown 之后，晚到结果只写进当前会话的 durable sink，不再经过旧 stack 的 store（D13）。
11. （v2.1）owner marker 在 `worktree add` 之前预写为 `creating`，并携带 owner token（进程启动时刻 + 扩展实例 id），不再只看 pid 是否存活（§3）。

## 1. 需求与现状

### 1.1 目标

- 让 `SubagentWorkflow` 里的 `agent(prompt, { isolation: "worktree" })` 与顶层 `Agent({ isolation: "worktree" })` 走同一套机制，真正生效。
- 调度方（主会话）能拿到分支名或保留路径，合并由调度方负责。
- 顺带补齐隔离提问方的 consult cwd、未跟踪依赖（linkPaths）、残留提示这三处缺口。
- 零 hang 不变量不退化。

### 1.2 现状证据

| 位置                                                                                                  | 事实                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/host.ts:710-716`                                                                        | RP7 注释：`isolation` 没有传进 `ChildSpawner.spawn()`，不会真正隔离，只写进 TaskSemantics 和 journal。                                                                                                                                                                                                                                               |
| `src/workflow/host.ts:760`、`:841`、`:1141`                                                           | `isolation` 参与 taskKey、`journalMetaOf`、`buildEntry`，所以带隔离的调用**照样写 journal**，只是永不回放。                                                                                                                                                                                                                                          |
| `src/workflow/replay.ts:146-147`                                                                      | RP7 在 lookup **之后**才判断，下游调用的链不受影响。                                                                                                                                                                                                                                                                                                 |
| `src/workflow/host.ts:57-96`、`:1016-1030`                                                            | `ChildSpawner.spawn` 的请求里没有 `isolation`；`spawnRequestFor` 既不带 `isolation` 也不带 `cwd`。                                                                                                                                                                                                                                                   |
| `src/workflow/spawner-adapter.ts:62-98`                                                               | adapter 逐字段转发请求，同样没有 `isolation`。                                                                                                                                                                                                                                                                                                       |
| `src/workflow/agent-opts.ts:41,77,378-384`                                                            | 严格校验已接受 `isolation:"worktree"`。                                                                                                                                                                                                                                                                                                              |
| `src/workflow/worker-source.ts:337,364,767,774`                                                       | `fullResult` 返回 `{ text, runId, label }`；失败返回 `null`；settle 的缓冲区逐字段复制。                                                                                                                                                                                                                                                             |
| `src/tools/agent-tool.ts:146-155,362`                                                                 | 顶层 Agent 只把 `isolation` 放进 `SpawnRequest`，由 H2 扩展负责建 worktree。                                                                                                                                                                                                                                                                         |
| `src/service/runtime-adapter.ts:456` / `:547-549` / `:585-593`                                        | `let sessionSpec` 的顺序是：先注入 consult 工具（`selfCwd = spec.cwd ?? process.cwd()`，**H2 之前**），再执行 H2 `resolveSessionSpec`（受 `startupMs` 约束，失败 ⇒ `failed(config)`，这不是 spawn error）。                                                                                                                                          |
| `src/service/runtime-adapter.ts:310-321`                                                              | disposition 回写时，同时 patch live record 和 `deps.store`。                                                                                                                                                                                                                                                                                         |
| `src/stack.ts:1117-1118` + `src/adapters/pi-run-log.ts:22-31`                                         | readBack 模式下 store 由 `wrapWithRunLog` 包装，**每次 put 都会 appendEntry 一条 `subagent:run`**，所以晚到的 disposition 已经会进入 run log。                                                                                                                                                                                                       |
| `src/service/runtime-adapter.ts:661`                                                                  | 只有 H2 成功的 run 才会带 `diag.worktree:{state:"active"}`。                                                                                                                                                                                                                                                                                         |
| `src/extensions/worktree.ts:69-94`                                                                    | H2 依次执行 `rev-parse --show-toplevel`、`worktree add --detach <root>/<runId>`，每条命令受 `gitTimeoutMs` 约束（默认 30s，`settings.ts:510`），然后调 `recordWorktreeOrigin`。                                                                                                                                                                      |
| `src/extensions/worktree.ts:96-155`                                                                   | H3 不看 outcome 状态，依次执行 `status`、`switch -c`、`add -A`、`commit`、`worktree remove`，**每条 git 命令的超时都是 `ctx.deadlineMs` = reapMs**。任何一步失败 ⇒ `kept`，路径只打日志。                                                                                                                                                            |
| `src/runtime/runner.ts:740-758`（v2 引用的 :666-685 已因 `6228dc1` 下移）                             | beforeReap 由 `withTimeout(reapMs)` 包裹，但超时只是**放弃等待**：`withTimeout` 在 reject 后并不取消 hook 的 promise，hook 会继续执行剩下的 git 命令，之后仍可能调用 `setWorktreeDisposition`。最坏情况下 hook 在 reap 开始后约 `5 × reapMs` 才结束（5 条命令各自最多 reapMs）。另外，比 reapMs 慢的 commit hook 会被 exec 超时杀掉，结果是 `kept`。 |
| `src/service/spawn-service.ts:549`                                                                    | 每个 run 的实际预算 = `mergeBudget(deps.budget（即 settings.budget）, 类型 budgetOverride, 请求 budgetOverride)`，reapMs 在这里确定。`settings.budget` 的类型是完整的 `DeadlineBudget`（`settings.ts:398`）；`mergeBudget` 定义在 `settings.ts:655`。                                                                                                |
| `src/service/spawn-service.ts:231`、`:695-716`                                                        | `waitAll` 在 `finish(outcome)` 时返回，**早于** H3 完成。                                                                                                                                                                                                                                                                                            |
| `src/service/spawn-service.ts:652-659`                                                                | `markWorktreeDisposition` 只改 record，没有可订阅的等待者。                                                                                                                                                                                                                                                                                          |
| `src/core/types.ts:376-383`                                                                           | disposition 里没有 `path` 字段。                                                                                                                                                                                                                                                                                                                     |
| `src/consult/index.ts:51,381-386`、`src/consult/tool.ts:193,615-618,635-638`                          | `selfCwd: string` 在创建工具时就固定下来。fork 以它作为 fallback cwd，spawn cwd = `resolveForkCwd(file, selfCwd) ?? selfCwd`。                                                                                                                                                                                                                       |
| `src/consult/fork-store.ts:181-199,237-250,532-549`                                                   | 两级 cwd：专家会话头部的 cwd 存在就用它，否则用 fallback。`forkMainSessionSnapshot` 把 opts 透传给 `forkExpertSession`；`ForkMainSessionOptions extends ForkExpertSessionOptions`（:487）。                                                                                                                                                          |
| `src/runtime/runner.ts:585-590`、`src/runtime/session-driver.ts:393`                                  | fork 或 resume 文件用 `SpawnRequest.cwd` 打开，**这个 cwd 覆盖文件头里的 cwd**。                                                                                                                                                                                                                                                                     |
| `src/stack.ts:1375`、`:1540-1546`                                                                     | 这两处分别接入 consult 工厂和 fork-store。                                                                                                                                                                                                                                                                                                           |
| `src/tools/workflow-tool.ts:362-374,381-393` + `result-text.ts:20-35`                                 | outcome 文本整体做**头尾截断**（`resultMaxChars`），位于中间的 children 行可能被截掉。                                                                                                                                                                                                                                                               |
| `src/workflow/orchestrator.ts:838`                                                                    | 终态 outcome 的 children 在 stopOwned 和 terminate_worker **之后**才读取 `hostHandler.children`。                                                                                                                                                                                                                                                    |
| `src/index.ts:477-486`                                                                                | `/agent status` 的依赖通过 `holder.current` 取自当前 stack。                                                                                                                                                                                                                                                                                         |
| `.gitignore:1`、`.githooks/pre-commit`                                                                | `node_modules/` 只匹配目录，软链不受它约束，会被提交；本仓库的 hook 依赖 `npx prettier`。                                                                                                                                                                                                                                                            |
| `src/service/runtime-adapter.ts:153-185`（v2.1）                                                      | `withStartupTimeout` 到期后只 resolve 一个失败结果，**不取消** hook promise，也不向 hook 传 signal。                                                                                                                                                                                                                                                 |
| `src/service/runtime-adapter.ts:585-593`、`:673`、`:690-701`（v2.1）                                  | H2 超时或失败 ⇒ `settleConfigFailure` 返回，`runnerEntered` 保持 false，所以 runner 的 beforeReap 不会执行；`finally` 只清 consult fork。H2 成功之后、`runnerEntered = true`（:673）之前如果发生同步抛错，同样会泄漏。                                                                                                                               |
| `src/extensions/registry.ts:44-53`（v2.1）                                                            | `resolveSessionSpec` 在多个扩展之间串行执行，不传 signal；前一个扩展成功、后一个抛错时，前者建出的 worktree 没有人回收。                                                                                                                                                                                                                             |
| `src/core/types.ts:815`、`:875-877`（v2.1）                                                           | `SessionSpec`（v2 引用的 :758-780 已下移）；`SubagentExtensionPoints.resolveSessionSpec(spec, req)` 没有 ctx 参数。                                                                                                                                                                                                                                  |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/exec.d.ts:7-14`（v2.1）                       | `pi.exec` 的 `ExecOptions.signal` 支持取消，但 `createPiWorktreeExtension`（`worktree.ts:165-176`）没有转发 signal。                                                                                                                                                                                                                                 |
| `src/service/runtime-adapter.ts:223-227`、`:456-464`、`:633-641`，`src/runtime/runner.ts:673`（v2.1） | `buildPrompt(spec)` 只读取 agent 类型的 systemPrompt 和 `request.prompt`。请求组装为 `{ runId, ...sessionSpec, prompt: isConsultRun ? request.prompt : buildPrompt(spec), … }`，**H2 返回的 `SessionSpec.prompt` 会被覆盖**。runner 通过 `handle.prompt(req.prompt)` 发送这个 prompt。                                                               |
| `src/stack.ts:1005-1029`、`:1117-1118`、`:1346`、`:1383`（v2.1）                                      | stack 重建时只 dispose widget、coalescer、bashJobs、fabric、keepalive、adaptive、quota、workflow，**不 dispose** runtime-adapter（:1346）和 spawn-service（:1383）。旧 adapter 的 disposition 回写会闭包旧 stack 的 `wrapWithRunLog(MemoryRunStore)`，其中 `pi.appendEntry` 写到的是**当前**会话文件。                                               |
| `src/service/tombstone.ts:12-58`（v2.1）                                                              | TTL tombstone，惰性 `cleanup()`，不使用 timer。本方案的 reapMs 表按同样方式处理（D5a）。                                                                                                                                                                                                                                                             |

## 2. 设计

### D1 透传

- `ChildSpawner.spawn` 的请求增加 `isolation?: "worktree"`。
- `QueuedAgentCall` 增加 `isolation?`，由 `spawnRequestFor` 转发。立即派发和排队派发共用这一个函数。
- adapter 把它转成 `SpawnRequest.isolation`，**不传 cwd**：worktree 由 H2 从 `spec.cwd ?? process.cwd()` 建出来，与顶层 Agent 一致。
- 删除 `host.ts:710-715` 那段已经过时的 RP7 注释。

### D2 可用性门

- `ChildSpawner.worktreeAvailable?(): boolean`，stack 接成 `() => settings.worktree.enabled`。
- `handleAgent` 的 stage ④ 与 experts 解析放在同一位置。门不通过 ⇒ ack 失败，reject reason 为 `"isolation_unavailable"`，错误信息：`agent(): isolation:"worktree" requires worktree.enabled=true — there is no fallback to the shared checkout`。
- 非 git 仓库，或 `worktree add` 失败 ⇒ H2 返回 `failed(config)` ⇒ agent() 得到 `null`，错误原因见 preview。

### D3 回放（选项 A）

- `DecideReplayInput.isolation?: boolean`。判定顺序：`noReplay` → `deterministic` → `experts` → `tainted` → **`isolation` ⇒ `skip:isolation_worktree`** → `configHashAvailable` → lookup → 旧条目 RP7（兼容已落盘的条目）→ `truncated` → TTL。
- 带隔离的调用不写 `journalMetaOf`。D2 通过后置 `replayTainted = true`，之后提交的调用都是 `skip:chain_tainted`。被拒绝的隔离调用不染色。
- `journal.ts` 不改。taskKey 仍然包含 `isolation`。

### D4 分支命名

沿用 `pi-agent-<safeRunId(runId)>`，不把 wf id 或 label 编进分支名。label 与分支的对应关系在 outcome 里给出。

### D5 结果回传与等待上限（评审严重 #2）

**上限推导**：用实际生效的 reapMs，而不是 `DEFAULT_BUDGET`。

- spawn-service 在 `start()` 里记录每个隔离 run 的实际 `budget.reapMs`（来自 `:549` 的 mergeBudget 结果），按 run 生命周期保存，全路径清理，查不到时回落到 `settings.budget.reapMs`。v2 的 FIFO `reapMsOf` 作废，见 **D5a**。
- 两个时域都**从调用时刻开始计时**：
  - `settle = reapMs_eff + 1_000`：覆盖 runner 放弃等待前 hook 的正常耗时。
  - `late = 5 × reapMs_eff + 1_000`：覆盖 runner.ts:740-758 放弃等待之后，hook 仍在执行剩余 git 命令的最坏情况（5 条命令各自最多 reapMs）。
- host 的兜底上限 `worktreeSettleMaxMs = settings.budget.reapMs + 1_000`，由 `buildWorkflowRunBudget(settings)` 计算，使用生效的 settings，而不是常量。如果某个 agent 类型的 frontmatter 把 reapMs 调得比全局值大，host 的兜底会先到期 ⇒ `pending`，由晚到路径补上。这一点写进文档。

**接口**：

- `SpawnService.waitWorktreeDisposition?(runId, { horizon: "settle" | "late"; capMs?: number })`，返回 `{kind:"settled", disposition} | {kind:"none"} | {kind:"timeout"} | {kind:"disposed"}`（`disposed` 见 D13）。
  - `none`：run 不存在，或 `diag.worktree` 不存在（未隔离，或 H2 失败）。
  - 已经不是 active ⇒ 立即返回 `settled`。
  - 否则登记等待者，由 `markWorktreeDisposition` 唤醒；定时器用 `setTimeout(...).unref()`，与 spawn-service 已有写法一致。等待时长 = `min(capMs, horizon 对应的上限)`。
  - 超时和唤醒哪个先到算哪个，后到的无效。
- `ChildSpawner.awaitWorktree?(runId, { horizon, capMs? }): Promise<ChildWorktreeInfo>`，永不 reject。映射：`settled` → disposition，`timeout` 和 `disposed` → `{state:"pending"}`，`none` → `{state:"none"}`。晚到监听收到 `disposed` 时直接丢弃。
- `ChildWorktreeInfo = { state: "committed"|"clean"|"kept"|"pending"|"none"; branch?; path? }`。disposition 为 `kept` 时带 `path`（D5-core：`WorktreeDisposal` 和 `WorktreeDisposition` 都增加 `path?`，扩展在报告 `kept` 时填入）。

**host 流程**（`runBoundChild`，只对带隔离的调用）：

1. outcome 到达后，用 `withDeadline(awaitWorktree(runId, {horizon:"settle", capMs: b}), b, deps.clock)` 等待 disposition，其中 `b = max(1, min(remainingWorkflowMs(), worktreeSettleMaxMs))`。然后执行 `onOutcome(outcome, wt)`。等待期间这个调用**仍然占着自己的 maxParallel 槽位**。
2. 如果结果是 `pending`，它就是**写进脚本返回值、不会再变**的值：settle 信封里带 `worktree:{state:"pending"}`，worker 之后**永远不会**再收到这个调用的任何更新。
3. 同时启动一个晚到监听：`awaitWorktree(runId, {horizon:"late"})`，没有 cap，也没有 host 定时器，因为没有任何东西会 await 它，它的上限由端口保证。得到 settled 后写入 `lateWorktreeOf.set(callId, info)`。
4. `children` getter 每次读取时，把 `lateWorktreeOf` 合并成 summary 的 `worktreeFinal?` 字段并生成新对象。`worktree` 字段保留脚本看到的那个值。
   - orchestrator 在 `orchestrator.ts:838` 读取的那一次就是终态快照。**在这次读取之前**到达的 disposition 会进入终态 outcome 文本；之后到达的只进入 run log：同一个 stack 仍然存活时，走现有的 `runtime-adapter.ts:310-321` store patch 和 `wrapWithRunLog` 的 appendEntry，同时更新 fleet 的 `⎇` 标记；stack 已被 dispose 时，**只**走 D13 的当前 durable sink。
   - orchestrator 不需要改。
5. `forceSettleActive` 处理带隔离、已绑定 runId 的调用时，写入 `worktree:{state:"pending"}`，并同样启动晚到监听。`settleUnspawned` 不写这个字段。

**脚本侧**：

- `HostSettleEnvelope.worktree?` 只在 ok 的 settle 上携带。worker 的两个缓冲点都复制这个字段。
- `fullResult` 的返回对象**只在** settle 带了 worktree 时才增加 `worktree` 键，其余情况逐字节不变。
- 普通调用返回字符串，失败返回 `null`，都保持不变（决定 5）。

**渲染**（`workflow-tool.ts`）：

- 新增 `renderWorktreeBlock(outcome)`，自带上限：最多 64 行，每行不超过 300 字符，总长不超过 8 KiB，超出部分写成 `…N more; git branch --list 'pi-agent-*'`。
- 每行格式：`label|callId → pi-agent-x | kept <path> | pending[→ <final>] (expected branch pi-agent-<runId>)`。`clean` 和 `none` 不列。
- `formatWorkflowResultText` 与 `formatWorkflowNotification` 把这一段放在**被截断的 body 之外**（body 之后、trailer 或 hint 之前），所以 outcome 被头尾截断时分支仍然可见（评审 #7）。`renderOutcomeText` 本身不包含这一段，避免在 body 里重复。
- `renderChildren` 的行尾追加英文标记 `⎇ <branch>`、`⎇ kept`、`⎇ pending`。

### D5a reapMs 表的生命周期（v2.1 条件 5）

`worktreeWait: Map<RunId, { reapMs: number; expiresAt?: number }>`，放在 spawn-service 实例的闭包里，取代 v2 的 FIFO `reapMsOf`。

- **写入**：只在 `start()` 中、且 `req.isolation === "worktree"` 时写入，值取该 run 在 `spawn-service.ts:549` 由 mergeBudget 得到的 `budget.reapMs`。表已满 4096 项时（**超限**）不写入。
- **按 run 生命周期（tombstone）清理，覆盖全部路径**：
  - `finish(outcome)`：`outcome.diag.worktree` 不存在（worktree 没建成）⇒ 删除；存在 ⇒ 转为 tombstone，`expiresAt = now + late(reapMs)`，即这个 run 最晚可能收到 disposition 的时刻。
  - `markWorktreeDisposition` ⇒ 先唤醒等待者，再删除。
  - 等待返回 `none` ⇒ 删除；`late` 时域返回 `timeout` ⇒ 删除；`settle` 时域返回 `timeout` ⇒ 保留，因为之后还可能有 late 等待。
  - `dispose()`（D13）⇒ 清空。
  - 惰性过期：每次 `start`、`finish`、`waitWorktreeDisposition`、`markWorktreeDisposition` 时，顺手删除 `expiresAt <= now` 的项。写法与 `TombstoneStore.cleanup`（`tombstone.ts:43-53`）一致，不使用 timer。
- **fallback**：表中查不到时（因超限没有写入、已经过期、或者 run 在本 spawn-service 实例之前就已启动），reapMs 取 `deps.budget.reapMs`，即实际生效的 `settings.budget.reapMs`。
- 不设固定 FIFO 淘汰，所以正在进行中的 run 不会因为别的 run 数量多而丢失自己的 reapMs。

### D6 合并

不自动合并。工具描述写明：由调度方来 merge 或 cherry-pick；`gate("git merge …")` 可以用，但不推荐。

### D7 失败 / 超时 / abort / stop

- H3 不看 outcome 状态：非 completed 的子 run 也可能把半成品提交到分支。只有提交链失败时才是 `kept`（这时报告 path）。
- workflow stop 或 killAt：`stopOwned` 在 `abortGraceMs` 内收集真实 settle；超时的调用被强制 settle 为 `aborted` + `pending` + 晚到监听。**H3 在 workflow 终态之后仍然会继续执行**（runner 只是放弃等待），最终状态进入 run log 和 fleet 标记。
- 会话关闭、崩溃、`/reload` 留下的残留：**不做自动 GC（非目标）**，见 P4 的发现与提示机制。

### D8 并发（评审一般 #3，改写）

- `maxParallel` 限制的是**同时活跃的 workflow agent() 调用数**，包括 admission、pre_runner、running，以及本方案新增的 settle 等待期。它**不是**磁盘上 worktree 数量的上限。
- 下面这些**不受它保护**：
  - 等待超时（pending）之后仍在后台执行 H3 commit/remove 的 run；
  - 被强制 settle 的调用；
  - 被 kept 的目录；
  - 顶层 Agent 与其他 workflow 建的 worktree。
- 磁盘上的 worktree 数 ≈ 活跃调用数 + 后台 H3 数 + kept 数。后台 H3 的时长受 `5 × reapMs` 约束。
- **不引入新的 semaphore**。并发 `git worktree add` 的安全性由真实 git 集成测试验证（4 个同时创建）。

### D9 linkPaths（评审严重 #4、一般 #5）

**设置**：`worktree.linkPaths: string[]`，只能在 settings 文件里配置，默认 `[]`。默认值下，git 命令序列和 prompt 都与现状**逐字节一致**。

**规范化校验**（新文件 `src/extensions/worktree-link-paths.ts`，纯函数 `canonicalLinkPath(raw)`）。settings 加载阶段和 H2 阶段调用的是同一个函数，拒绝项会记入 diag：

- 必须是字符串，长度 1-255，首尾没有空白，不含 NUL 或控制字符。
- 拒绝：绝对路径（以 `/` 开头）、以 `-` 开头、包含反斜杠 `\`、包含 git pathspec 元字符 `: * ? [ ] !`。
- 按 `/` 切段：拒绝空段（所以 `a//b` 和结尾的 `/` 都不行）、`.`、`..`。
- 规范形式 `segments.join("/")` 必须**等于原值**，不做静默纠正。
- 去重，最多 16 项。

**H2 中的执行顺序**（先完成 canonical 校验，再调 git）：

1. 对 `repoTop/p` 的每一级前缀以及它本身做 lstat：**任何一级是 symlink 都拒绝**，包括源路径本身。最终必须是目录。另外再核对一次 `realpath(repoTop/p) === join(realpath(repoTop), p)`。
2. 执行 `git check-ignore -q -- <p>`（cwd = repoTop，受 `gitTimeoutMs` 约束），只接受退出码 0（被忽略且未跟踪）。
3. 目标 `wt/p` 已存在或父目录不存在 ⇒ 跳过。否则 `symlink(repoTop/p, wt/p)`，并记入 `record.links`。

**H3**：`status --porcelain` 和 `add -A` 都加上 pathspec `-- . ':(exclude,literal)<p>'`（literal 关闭通配）。所以软链永远不会被提交，只有软链的 worktree 按 clean 处理。

**只读约定（已接受风险，不加锁）**：

- link path 被当作**只读依赖**：子 agent 不得在 worktree 里执行安装类命令，也不得写入 link path。
- 通过 `SessionSpec.promptNotes?: readonly string[]`（`core/types.ts:815` 的 SessionSpec 新增字段，不引入 pi 依赖）注入提示。只有实际建出了至少一个 link 时，H2 才写入这个字段。它进入实际 prompt 的路径见下面的「只读提示的 prompt 路径」。
- 提示文本：`Worktree isolation note: <p…> are symlinks into the main checkout — shared, READ-ONLY dependencies. Do not run install/update/prune commands (npm/pnpm/yarn install|ci|add|update, pip install, …) and do not write, delete or modify anything under them; they are never committed.`
- 同一段约定写进 `agent-tool.ts` 的 isolation 参数描述、workflow 工具描述和 dev-flow 文档。
  **只读提示的 prompt 路径（v2.1 条件 4）**：

- 现状：`buildPrompt(spec)`（`runtime-adapter.ts:223-227`）只看 `spec.type` 和 `spec.request.prompt`。`sessionSpec` 在 `:456-464` 初始化，H2 在 `:585-593` 覆写 `sessionSpec`，请求在 `:633-641` 组装，其中 `prompt` 字段（`:640`）会覆盖 SessionSpec 里的同名字段。runner 通过 `handle.prompt(req.prompt)`（`runner.ts:673`）发送。所以扩展没法通过改 `SessionSpec.prompt` 注入提示。
- 改法（P1，`runtime-adapter.ts`）：
  1. 在 `:633` 之前拆出字段：`const { promptNotes, ...sessionFields } = sessionSpec`。请求改为展开 `sessionFields`，这样 `promptNotes` 不会传到 driver 和 `createAgentSession`。
  2. `prompt: isConsultRun ? spec.request.prompt : appendPromptNotes(buildPrompt(spec), promptNotes)`。
  3. 新增导出的纯函数 `appendPromptNotes(prompt, notes?)`：notes 为 undefined 或空数组 ⇒ **原样返回同一个字符串**，逐字节不变；否则返回 `` `${prompt}\n\n${notes.join("\n\n")}` ``。
  4. resume（`resumeFrom`）同样会追加，因为续跑时这条约定依然有效。consult run 不追加。
- 验收：fake driver 捕获 `handle.prompt()` 的实参，断言其**字节**以 `buildPrompt(spec)` 开头、以提示文本结尾；driver 收到的 `create/resume` 参数里没有 `promptNotes` 键；`linkPaths=[]` 时实参 `===` `buildPrompt(spec)`。
- **验收条件**：顶层 Agent 与 workflow 子 run **同时**通过同一个 link path 只读访问依赖时，二者都能正常提交，主 checkout 的 `node_modules` 内容哈希在前后保持不变，分支里不含软链。
- 违反约定（在 worktree 里执行 install）造成的共享目录污染，属于**已接受风险**，不做检测。

### D10 consult cwd（评审严重 #1，本期必做）

**冻结契约**：cwd getter 从 runtime-adapter 一路传到 fork 和 spawn。

```ts
// src/consult/tool.ts
export interface ConsultAskerCwd { readonly cwd: string; readonly isolated: boolean }
ConsultDeps.selfCwd: () => ConsultAskerCwd;               // 原来是 string
ConsultForkStore.forkExpertSession(sourceFile, fallbackCwd, opts?: { forceCwd?: boolean });
ConsultForkStore.forkMainSession?(sourceFile, fallbackCwd, opts?: { forceCwd?: boolean });
// src/consult/index.ts
ConsultWiring.depsFactory(selfRunId, selfCwd: () => ConsultAskerCwd, whitelist);
// src/service/runtime-adapter.ts（结构类型，不 import consult）
RuntimeAdapterDeps.consult?: (selfRunId, selfCwd: () => { cwd: string; isolated: boolean }, whitelist) => ToolDefinition | undefined;
// src/consult/fork-store.ts
ForkExpertSessionOptions.forceCwd?: boolean;             // 生产字段，不是测试接缝
```

- **runtime-adapter**：注入 consult 工具（:547-549）之前，先建一个 cell：`askerCwd = { cwd: spec.cwd ?? process.cwd(), isolated: false }`，把 getter `() => askerCwd` 交给工厂。
  - H2 成功之后（:593）只写一次：`askerCwd = { cwd: sessionSpec.cwd ?? pre, isolated: spec.request.isolation === "worktree" && sessionSpec.cwd !== undefined && sessionSpec.cwd !== pre }`，之后冻结。
  - 工具只会在 session 建好之后执行，而 session 建立一定在 H2 之后，所以 getter 读到的必然是 H2 之后的值。万一在 H2 之前被调用，返回 H2 之前的值，测试会锁定这一行为。
- **consult 工具**：每次调用 execute 时读取一次快照 `a = deps.selfCwd()`。
  - `a.isolated` ⇒ fork 调用 `forkExpertSession/forkMainSession(file, a.cwd, { forceCwd: true })`，文件头 cwd 写成提问方的 worktree；spawn 的 `cwd = a.cwd`，**不调用** `resolveForkCwd`。
  - 未隔离 ⇒ 与现状逐字节一致：fork 的 fallback 为 `a.cwd`，spawn 的 `cwd = resolveForkCwd(file, a.cwd) ?? a.cwd`。
  - `"main"` 专家同样遵循这条规则。
- **fork-store**：`targetCwd = opts.forceCwd ? resolvePath(fallbackCwd) : pickForkCwd(header.cwd, fallbackCwd)`。
- **stack.ts:1540-1546**：fork-store 的接线改成包装函数，因为位置参数不兼容（第三个参数是 `dir`）：`(f, c, o) => forkExpertSession(f, c, undefined, o?.forceCwd ? { forceCwd: true } : {})`，main 同理。`:1375` 只做透传，签名推断自动跟随。
- **描述**（`tool.ts:389`）改为：`runs in the asking agent's own worktree when the asker is worktree-isolated; otherwise in the expert's original checkout if it still exists, else the asker's checkout`。
- 这是**顶层 Agent 的行为变化**：隔离的顶层提问方也会改到自己的 worktree 里执行 consult。未隔离的路径作为回归基线锁死。

### D12 H2 可取消与迟到补偿（v2.1 条件 1，严重）

**问题**：`withStartupTimeout`（`runtime-adapter.ts:153-185`）到期后只 resolve 一个失败结果，hook promise 仍在执行。worktree 已经建好之后才超时，runner 就从未进入（`runnerEntered=false`，`:673`），beforeReap 不会执行，`finally`（`:690-701`）也只清理 consult fork。结果是 worktree 目录、owner marker 和 origin 注册全部残留。另有两个同类泄漏：多扩展链中 worktree 扩展成功、后一个扩展抛错（`registry.ts:44-53`）；H2 成功之后、`runnerEntered = true` 之前发生同步抛错。

**契约**（`core/types.ts:875-877` + `extensions/registry.ts`）：

```ts
resolveSessionSpec?(spec: SessionSpec, req: SpawnRequest, ctx?: { signal: AbortSignal }): Promise<SessionSpec> | SessionSpec;
abandonSessionSpec?(runId: RunId, ctx: { reason: "startup_timeout" | "h2_failed" | "pre_runner_exit" }): Promise<void> | void;
```

- registry 的合并逻辑：`resolveSessionSpec` 透传 `ctx`，调用每个扩展之前检查 `ctx.signal.aborted`，已中止就 throw。`abandonSessionSpec` 分发给**所有**扩展，每个都单独 try/catch 并 warn，写法与 `beforeReap` 相同，某个扩展抛错不影响其他扩展。
- 老扩展不声明第三个参数和 `abandonSessionSpec`，行为不变。

**runtime-adapter**（`:585-593`、`:690-701`）：

1. 调用 H2 之前创建 `const h2 = new AbortController()` 并置 `h2Invoked = true`，然后执行 `withStartupTimeout(Promise.resolve().then(() => hook(sessionSpec, spec.request, { signal: h2.signal })), startupMs, clock)`。
2. 超时 ⇒ `h2.abort()`，`abandonReason = "startup_timeout"`；hook 抛错 ⇒ `abandonReason = "h2_failed"`。
3. `finally` 中：`h2Invoked && !runnerEntered` ⇒ `fireAbandon(abandonReason ?? "pre_runner_exit")`，即 `void Promise.resolve().then(() => merged.abandonSessionSpec?.(spec.runId, { reason })).catch(warn)`。
   - **不 await**，不影响已经定下的 `failed(config)` outcome；
   - 上界由扩展内部每条 git 命令的 `gitTimeoutMs` 保证（最多 3 条，见下文）；
   - 与 consult fork 的清理互不影响。

**worktree 扩展**：

- 状态机：`creating → active → (beforeReap) → 删除`；或者 `creating | active → compensating → 删除 | abandoned`。
- H2 的执行顺序：
  1. `records.set(runId, { state: "creating", path, repo, branch })`，预写 marker `state:"creating"`（§3），把路径加入进程级 tracked 集合；
  2. 执行 `git worktree add`，把 `ctx.signal` 透传给 exec；
  3. add 返回后：`signal.aborted || rec.abandonRequested` ⇒ `await compensate(rec)`，然后 throw `Error("resolveSessionSpec aborted")`（adapter 已经丢弃这个结果）；
  4. 否则：state 设为 `active`，marker 改写为 `active`，调用 `recordWorktreeOrigin`，返回。**origin 只在 active 之后才登记**。
- add 失败（非 0 退出码、抛错、被 signal 杀掉）⇒ `await compensate(rec)` 之后再抛出原错误。被杀掉的 add 可能留下半截目录和 `.git/worktrees/<n>` 管理项。
- `abandonSessionSpec(runId)`：
  - 没有对应 record ⇒ no-op；
  - `creating` ⇒ 只置 `abandonRequested = true`，由 H2 自己在 add 返回后补偿，避免与 add 同时删除；
  - `active`（runner 没有进入）⇒ `compensate(rec)`。
  - 幂等：对同一个 runId 的重复调用，以及与 H2 自身补偿同时发生的调用，共用同一个 compensate promise。
- `compensate(rec)`：有界、串行执行，每条命令受 `gitTimeoutMs` 约束，**不带** signal。
  1. path 存在 ⇒ 执行 `git worktree remove --force <path>`。这是安全的：runner 从未进入，worktree 里只有 HEAD 内容，没有 agent 的改动。`--force` 删除 linkPaths 软链时不会跟随到目标（测试 #4、#28 断言目标目录完好）。
  2. remove 失败且 path 已经不存在 ⇒ 执行 `git -C <repo> worktree prune`，只清理目录已缺失的管理项。
  3. path 已不存在 ⇒ 删除 marker，调用 `forgetWorktreeOrigin(path)`，从 tracked 集合移除，`records.delete(runId)`。
  4. path 仍然存在 ⇒ marker 改写为 `state:"abandoned"`（保留，**不删**），从 tracked 集合移除，通过 `onDiagnostic` 发出警告（`worktree abandoned at <path>; see /agent status`）。P4 的扫描会以 `abandoned` 报告它。
- `createPiWorktreeExtension`（`worktree.ts:165-176`）把 `opts.signal` 转给 `pi.exec`（`ExecOptions.signal`）。
- 零 hang：add 本身受 `gitTimeoutMs` 和 signal 约束；补偿最多 3 条命令，每条受 `gitTimeoutMs` 约束；没有任何调用方 await 补偿；不引入 timer。

### D13 晚到路径的 dispose 与当前 durable sink（v2.1 条件 2，严重）

**问题**：stack 重建时（`stack.ts:1005-1029`）不 dispose spawn-service（`:1383`）和 runtime-adapter（`:1346`）。D5 的等待者、unref timer、reapMs 表，以及 adapter 的 disposition 回写闭包（`runtime-adapter.ts:310-321`，其中 `deps.store` 是旧 stack 的 `wrapWithRunLog(MemoryRunStore)`，`stack.ts:1117-1118`），在旧 stack 被替换之后仍然存活。H3 如果在重建之后才报告，就会把旧 run 的快照 put 进旧的内存 store，并通过 `pi.appendEntry` 以 `subagent:run` 写进**当前**会话文件，新会话的 read-back 可能因此把旧 run 当作本会话的 run 复活。

**设计**：

- `SpawnService.dispose?()`，幂等：
  - 清除所有 worktree 等待者的 timer，并以 `{kind:"disposed"}` resolve 它们；
  - 清空 reapMs 表（D5a）；
  - 之后 `waitWorktreeDisposition` 立即返回 `disposed`，`markWorktreeDisposition` 变为 no-op。
- `Runner.dispose?()`（`service/ports.ts:53` 的 Runner 接口，runtime-adapter 实现）：
  - 置 `disposed = true`；
  - 之后 `setWorktreeDisposition` 的包装（`:310-321`）**不再**访问 `deps.store` 和 `deps.worktreeDiag`，改为调用 `writeLateWorktreeDisposition({ runId, state, branch?, path?, at })`。
- **进程级 durable sink**，新文件 `src/adapters/worktree-disposition-sink.ts`：
  - pi-free，状态存放在 `Symbol.for("pi-subagent:worktree-disposition-sink")` 上，属于与 worktree-origin 注册表同一类的豁免；
  - API：`registerDispositionSink(token, write)`、`releaseDispositionSink(token)`（按身份比对后释放，与 HOST_KEY 的释放方式相同）、`writeLateWorktreeDisposition(entry)`（存在当前 sink ⇒ `write(entry)`；不存在 ⇒ 只打 `console.warn`）。
  - 主会话的 stack 在构建时注册 `write = (e) => pi.appendEntry("subagent:worktree-disposition", e)`。这是一个独立的 customType，read-back **从不**读取它，所以不会复活旧 run，只作为当前会话文件（即 run log 文件）里的持久记录。
  - `/reload` 之后，新模块的 stack 会重新注册，所以跨 reload 的晚到结果也能写进新会话。
  - 同一个 stack 内、尚未 dispose 时的晚到结果，仍然走原来的路径（store patch → `subagent:run`），不变。
- **调用点**：
  - `Stack.worktreeLate = { dispose(): void }`，实现为 `spawn.dispose?.(); runner.dispose?.()`；
  - `stack.ts` 顶部增加模块级交接 `previousWorktreeLate?.dispose()`，写法与 `:1005-1029` 相同；
  - `index.ts` 的 session_shutdown 在 `stack.workflow.runs.seal()` 之后调用 `stack.worktreeLate?.dispose()` 和 `releaseDispositionSink(token)`。
- **验收**：stack 重建或 shutdown 之后，旧 spawn-service 不再有 timer（`vi.getTimerCount()` 与重建前的基线相比）；dispose 之后，旧 store 的 `put` 和旧 run-log 的 `appendEntry("subagent:run")` 调用次数为 0；随后 H3 报告 ⇒ 当前 sink 恰好收到一次 `subagent:worktree-disposition`；没有 sink 时只 warn。

### D11 零 hang

| 等待                             | 上界                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| H2 建 worktree 与 linkPaths 检查 | 每条 git 命令受 `gitTimeoutMs` 约束，整体受 `startupMs` 约束；超时会 abort signal 杀掉进行中的 git（D12）；fs 操作是同步的，且最多处理 16 项 |
| H2 迟到补偿（D12）               | 没有东西 await 它；最多 3 条 git 命令，每条受 `gitTimeoutMs` 约束，不使用 timer                                                              |
| dispose（D13）                   | 同步执行：清除 timer，resolve 等待者，清空表                                                                                                 |
| H3                               | runner 用 `withTimeout(reapMs)` 放弃等待，hook 自身受约 `5 × reapMs` 约束（每条命令都有 exec 超时）                                          |
| host settle 等待                 | `min(remainingWorkflowMs, worktreeSettleMaxMs)`，端口定时器（unref）与 host 的 `deps.clock` 双重约束                                         |
| 晚到监听                         | 没有东西 await 它；端口保证在 `5 × reapMs_eff + 1s` 内结束，stack dispose 时立即以 `disposed` 结束                                           |
| stopOwned                        | 仍然只受 `abortGraceMs` 约束；`background.ts` 的 runBoundMs 和 stopSettleBoundMs 不变                                                        |
| P4 扫描                          | 同步 fs，最多 500 项，不执行 git，不删除任何东西                                                                                             |
| consult getter                   | 同步读取 cell，没有等待                                                                                                                      |

## 3. P4：残留 worktree 的发现与提示（评审一般 #6）

**非目标**：自动删除任何 worktree 或分支。

**owner 标记与 owner token**（P1 实现，v2.1 条件 3）：

- owner token：`WorktreeOwnerToken = { pid, procStartedAt, instanceId }`。
  - `procStartedAt`：本进程的启动时刻（ms），每个进程只计算一次：`Math.round(Date.now() - process.uptime() * 1000)`，缓存在 `Symbol.for("pi-subagent:process-started-at")`。
  - `instanceId`：worktree **扩展实例**的 id，每次 activate 生成一个 randomUUID。`records` 属于扩展实例（per activate，`index.ts:88` 的 `wireWorktree`），会话 stack 的重建（new/resume/fork）不会改变 worktree 的归属，所以 token 里放扩展实例 id 而不是会话 stack id；`/reload` 会新建实例，id 也随之改变。
- marker 的生命周期：
  - `worktree add` **之前**预写 `<root>/.owners/<safeRunId>.json`，内容为 `{v:1, state:"creating", owner, runId, repo, path, createdAt}`，权限 0600，best-effort；
  - add 成功后改写为 `state:"active"`；
  - beforeReap 的 finally 或 D12 补偿成功之后删除；
  - D12 补偿失败时改写为 `state:"abandoned"`。
  - kept 的目录在 finally 里同样会删除 marker，所以下次启动时它会以 `no-owner` 被提示出来。
- 进程内 tracked 集合：`Symbol.for("pi-subagent:worktree-tracked")`，类型为 `Map<path, instanceId>`。预写 marker 时加入，finally 或补偿结束时移除。`/reload` 之前的旧实例如果还在执行 H3，它的路径仍然在集合里。

**扫描**（P1 实现纯函数 `scanWorktreeOrphans({ root, isPidAlive, procStartOf, tracked, self, now, cap: 500 })`，放在新文件 `src/extensions/worktree-orphans.ts`，所有外部依赖都可注入）：

- 列出 root 下除 `.owners` 以外的目录，逐个判定：
  1. marker 为 `state:"abandoned"` ⇒ 残留，原因 `abandoned`。
  2. **同 PID**（`marker.owner.pid === self.pid`）：
     - `procStartedAt` 与本进程一致（±2s）⇒ 在 tracked 中则活跃；不在 tracked 中则为残留 `owner-gone`。这覆盖了同 PID `/reload` 之后旧实例已经结束的情况。
     - `procStartedAt` 不一致 ⇒ 是之前某个用过同一 PID、现已退出的进程留下的，残留 `owner-dead`。
  3. **其他 PID**：
     - `isPidAlive(pid)` 为 false（`process.kill(pid, 0)` 返回 ESRCH）⇒ `owner-dead`；
     - 为 true 时，比较 `procStartOf(pid)` 与 marker 里的 `procStartedAt`，相差超过 2s ⇒ `owner-dead`（**PID 复用**）。在 Linux 上，`procStartOf` 的算法是：`/proc/<pid>/stat` 最后一个 `)` 之后第 20 个字段（即 starttime，单位 1/100 s）÷ 100，加上 `/proc/stat` 的 `btime`，再换算成 ms；
     - 一致，或者无法读取（非 Linux）⇒ 活跃。非 Linux 下 PID 复用会漏报，这是已接受的风险。
  4. marker 为 `state:"creating"`：按 2、3 判定 owner；owner 存活 ⇒ 活跃（正在创建）；owner 已退出 ⇒ `creating-abandoned`。
  5. 没有 marker：目录 mtime 在 120s 宽限期内 ⇒ 跳过，避免与旧版本或其他实现建目录时的竞态；否则 ⇒ `no-owner`。
  6. 没有 `.git` 文件 ⇒ 额外标注 `not-a-worktree`，与上面的原因一起报告。
- 从 `.git` 文件的 `gitdir: <repo>/.git/worktrees/<n>` 解析出 repo，不调用 git。
- 只有 marker、没有对应目录 ⇒ 忽略（不删除，属于非目标）。root 不存在 ⇒ 返回空结果。

**接线**（P4）：

- stack 在 session_start 时扫描一次。如果残留数大于 0 且 `ctx.hasUI`，发一次 `ctx.ui.notify`：
  - 每个进程只发一次，用 `Symbol.for("pi-subagent:worktree-orphans-notified")` 做全局标记（与 HOST_KEY 属于同一类豁免）。
  - 提示内容为中文：数量、root、前 5 个路径，以及清理命令：`git -C <dir> status --short` → 提交并合并，或 `git -C <repo> worktree remove --force <dir>` → `git -C <repo> worktree prune`。另注明「可能被其他 pi 进程使用，删除前先确认」。
- `/agent status` 每次都重新扫描，结果受 cap 约束，并新增一行 `worktrees: 3 orphaned (<root>)`（英文 token），再列出至多 5 条路径。`src/index.ts:477-486` 通过 `holder.current?.worktreeOrphans?.()` 传入扫描结果。

**验收**：

- (a) 没有残留 ⇒ 既不提示，status 也不显示这一行。
- (b) 有 3 个没有 marker 的目录 ⇒ 提示一次，内容包含数量和命令；同一进程里再次 session_start 不再提示；status 每次都显示。
- (c) 其他 PID 的 marker：pid 存活且 `procStartOf` 一致 ⇒ 不计入；pid 已死 ⇒ 计入 `owner-dead`。
- (d) root 不存在，或目录不可读 ⇒ 不抛错。
- (e) spy 证明扫描不调用 exec，也不做 unlink/rm。
- (f) 超过 cap 时，计数显示为 `500+`。
- (g) 子会话（guard 之后）不扫描。
- (h) `creating` 状态：owner 存活 ⇒ 不计入；owner 已退出 ⇒ `creating-abandoned`。没有 marker 且 mtime 在 120s 内的目录 ⇒ 跳过。
- (i) **同 PID `/reload`**：同一 pid、同一 `procStartedAt`，但 instanceId 属于旧实例且路径不在 tracked 中 ⇒ `owner-gone`；旧实例仍在执行 H3（路径在 tracked 中）⇒ 不计入。
- (j) **PID 复用**：其他 pid 存活但 `procStartOf` 与 marker 相差超过 2s ⇒ `owner-dead`；同 pid 但 `procStartedAt` 不一致 ⇒ `owner-dead`；`procStartOf` 返回 undefined ⇒ 不计入（非 Linux 的行为）。
- (k) `abandoned` 状态（D12 补偿失败）⇒ 一定计入，并出现在提示里。

## 4. 接口变更汇总（冻结面）

```ts
// src/core/types.ts
WorktreeDisposition { state; branch?; path? }  ;  WorktreeDisposal { state; branch?; path? }
SessionSpec.promptNotes?: readonly string[]
// src/service/spawn-service.ts
waitWorktreeDisposition?(runId, { horizon: "settle" | "late"; capMs?: number }):
  Promise<{ kind: "settled"; disposition: WorktreeDisposal } | { kind: "none" } | { kind: "timeout" }>
// src/extensions/worktree-settings.ts
WorktreeSettings.linkPaths: readonly string[]   // 默认 []
// src/extensions/worktree-link-paths.ts
canonicalLinkPath(raw: unknown): { ok: true; path: string } | { ok: false; reason: string }
// src/extensions/worktree-orphans.ts
scanWorktreeOrphans(opts): { root; count; capped; entries: { path; repo?; reason }[] } ; worktreeRoot(): string
// src/consult/*、src/service/runtime-adapter.ts —— 见 D10
// src/workflow/types.ts
ChildWorktreeInfo ; WorkflowChildSummary.worktree? / worktreeFinal? ; WorkflowRunBudget.worktreeSettleMaxMs?
// src/workflow/host.ts
ChildSpawner.spawn({ …, isolation? }) ; worktreeAvailable?() ; awaitWorktree?(runId, { horizon, capMs? })
WorkflowChildRejectReason += "isolation_unavailable" ; HostSettleEnvelope.worktree?
// src/workflow/replay.ts
DecideReplayInput.isolation?: boolean
// 脚本侧：agent(..., { fullResult: true }) → { text, runId, label, worktree? }（只有隔离调用才带 worktree）
// —— v2.1 新增 ——
// src/core/types.ts
SubagentExtensionPoints.resolveSessionSpec?(spec, req, ctx?: { signal: AbortSignal })
SubagentExtensionPoints.abandonSessionSpec?(runId, ctx: { reason: "startup_timeout" | "h2_failed" | "pre_runner_exit" })
// src/service/spawn-service.ts
waitWorktreeDisposition 的结果增加 { kind: "disposed" } ; dispose?(): void
// src/service/ports.ts + runtime-adapter.ts
Runner.dispose?(): void ; export function appendPromptNotes(prompt: string, notes?: readonly string[]): string
// src/adapters/worktree-disposition-sink.ts
registerDispositionSink(token: object, write: (e: LateWorktreeDisposition) => void) ; releaseDispositionSink(token) ; writeLateWorktreeDisposition(e)
LateWorktreeDisposition { runId; state: "committed" | "kept" | "clean"; branch?; path?; at }  // customType "subagent:worktree-disposition"
// src/extensions/worktree-orphans.ts
WorktreeOwnerToken { pid; procStartedAt; instanceId } ; processStartedAt() ; procStartOf(pid): number | undefined
scanWorktreeOrphans({ root, isPidAlive, procStartOf, tracked, self, now, cap }) ; reason ∈ abandoned | owner-gone | owner-dead | creating-abandoned | no-owner (+ not-a-worktree)
// src/stack.ts
Stack.worktreeLate?: { dispose(): void }
```

## 5. 包拆分（串行 P1 → P3 → P2 → P4）

`runtime-adapter.ts` 由 P1 和 P3 共用；`stack.ts` 由四个包共用（v2.1 起 P1 也要改它，用于 D13 的 dispose 和 sink 注册）；`index.ts` 由 P1 和 P4 共用。因此四个包按顺序串行，每个包合入 master 之后下一个再开工。

- **P1 `wt-core`**：
  - core 类型（path、promptNotes、扩展点 ctx 与 `abandonSessionSpec`）和 registry 合并；
  - worktree 扩展（kept path、linkPaths、预写 marker 与 owner token、signal、D12 补偿）；
  - link-paths 与 orphans 两个纯模块；
  - settings；
  - spawn-service 的等待者、D5a 的 reapMs 表与 dispose；
  - runtime-adapter（promptNotes 进 prompt、H2 signal 与 abandon、dispose 与晚到改道）和 `ports.ts` 的 `Runner.dispose`；
  - durable sink 模块；
  - stack.ts 与 index.ts 的 dispose 和 sink 注册接线；
  - agent-tool 的描述。
- **P3 `consult-cwd`**：D10 全部内容。
- **P2 `wf-isolation`**：workflow 层、stack 的 `worktreeEnabled` 接线、工具描述与渲染、dev-flow 与 AGENTS.md 文档。
- **P4 `wt-orphans`**：stack 扫描与提示、status 段、index.ts 的依赖传入。

```json
[
  {
    "id": "wt-core",
    "globs": [
      "src/core/types.ts",
      "src/extensions/worktree.ts",
      "src/extensions/worktree-settings.ts",
      "src/extensions/worktree-link-paths.ts",
      "src/extensions/worktree-orphans.ts",
      "src/config/settings.ts",
      "src/service/spawn-service.ts",
      "src/service/runtime-adapter.ts",
      "src/tools/agent-tool.ts",
      "src/extensions/registry.ts",
      "src/service/ports.ts",
      "src/adapters/worktree-disposition-sink.ts",
      "src/stack.ts",
      "src/index.ts",
      "tests/extensions/registry.test.ts",
      "tests/adapters/worktree-disposition-sink.test.ts",
      "tests/service/runtime-adapter-prompt-notes.test.ts",
      "tests/integration/worktree-h2-compensation.test.ts",
      "tests/integration/worktree-late-dispose.test.ts",
      "tests/extensions/worktree.test.ts",
      "tests/extensions/worktree-git-integration.test.ts",
      "tests/extensions/worktree-link-paths.test.ts",
      "tests/extensions/worktree-orphans.test.ts",
      "tests/service/spawn-service.test.ts",
      "tests/service/spawn-worktree-wait.test.ts",
      "tests/service/extension-hooks.test.ts",
      "tests/integration/worktree-link-paths.test.ts",
      "tests/config/settings-worktree.test.ts"
    ]
  },
  {
    "id": "consult-cwd",
    "globs": [
      "src/service/runtime-adapter.ts",
      "src/consult/index.ts",
      "src/consult/tool.ts",
      "src/consult/fork-store.ts",
      "src/stack.ts",
      "tests/consult/consult-tool.test.ts",
      "tests/consult/fork-store.test.ts",
      "tests/consult/wire.test.ts",
      "tests/service/runtime-adapter-consult.test.ts",
      "tests/integration/consult.test.ts",
      "tests/integration/consult-wiring.test.ts",
      "tests/integration/consult-worktree-cwd.test.ts"
    ]
  },
  {
    "id": "wf-isolation",
    "globs": [
      "src/workflow/host.ts",
      "src/workflow/replay.ts",
      "src/workflow/types.ts",
      "src/workflow/worker-source.ts",
      "src/workflow/spawner-adapter.ts",
      "src/workflow/run-budget.ts",
      "src/stack.ts",
      "src/tools/workflow-tool.ts",
      "tests/workflow/host.test.ts",
      "tests/workflow/host-worktree.test.ts",
      "tests/workflow/replay.test.ts",
      "tests/workflow/replay-taint.property.test.ts",
      "tests/workflow/spawner-adapter.test.ts",
      "tests/workflow/worker-host-call.test.ts",
      "tests/workflow/journal-replay-e2e.test.ts",
      "tests/config/workflow-settings.test.ts",
      "tests/tools/workflow-tool.test.ts",
      "tests/integration/workflow-worktree.test.ts",
      "skills/dev-flow/SKILL.md",
      "skills/dev-flow/references/subagent-workflow.md",
      "AGENTS.md"
    ]
  },
  {
    "id": "wt-orphans",
    "globs": [
      "src/stack.ts",
      "src/index.ts",
      "src/commands/status.ts",
      "tests/commands/status.test.ts",
      "tests/integration/worktree-orphans-notify.test.ts"
    ]
  }
]
```

### 5.1 开工前冲突预检（评审建议 #8）

每个包开工前，在仓库根目录执行下面三步（每条命令都加 timeout）：

````sh
# ① 提取 spec；与已声明的串行重叠作比对
awk '/^```json/{f=1;next} /^```/{f=0} f' docs/dev/workflow-worktree/plan.md > /tmp/wf-wt-spec.json
node skills/dev-flow/scripts/conflict-check.mjs /tmp/wf-wt-spec.json
# ② 本包文件在工作区必须没有别人的未提交改动（以 P2 为例）
node -e 'const s=require("/tmp/wf-wt-spec.json").find(p=>p.id===process.argv[1]);console.log(s.globs.join("\n"))' wf-isolation \
  | xargs git status --short --
# ③ 若要与本方案之外的在途包 X 并行：把 X 的 {id,globs} 追加进 spec 后，只保留「本包 + X」两项再跑一次 conflict-check
````

**失败判据**：

- ① **预期退出码为 1**，且交集**只能是**下面这些已声明的串行重叠（v2.1 实测结果，见文末）：`src/service/runtime-adapter.ts`（wt-core × consult-cwd）、`src/stack.ts`（wt-core、consult-cwd、wf-isolation、wt-orphans 两两之间，共 6 对）、`src/index.ts`（wt-core × wt-orphans）。出现任何其他交集，或退出码为 2 ⇒ 停下来修订方案。
- ② 有任何输出 ⇒ 停下来，先弄清是谁的改动，按 memory pitfalls 的做法改到 worktree 里开发。
- ③ 退出码不为 0 ⇒ 不能并行，改为排队。
- 前一个包必须已经 `--ff-only` 合入 master，并在干净的 worktree 里通过四道门禁，下一个包才能开工。

## 6. 测试清单（评审一般 #7 全量）

**P1 `wt-core`**：

1. spawn-worktree-wait：
   - `none`、`settled`（已完成或 mark 后）、`timeout` 三种结果；
   - 等待者在超时后注销，mark 与超时竞争时结果幂等；
   - 定时器是 unref 的；
   - 用**配置化 reapMs** 验证两个时域（settings.budget.reapMs=2000 ⇒ settle 3000、late 11000），以及 agent 类型 budgetOverride.reapMs 取更大值的情况（fake timers）；
   - **D5a 全路径清理**（v2.1）：finish 时未建成 ⇒ 删除；finish 时已建成 ⇒ 变为 tombstone 并带 `expiresAt`；mark ⇒ 删除；`none` ⇒ 删除；late 时域 timeout ⇒ 删除；settle 时域 timeout ⇒ 保留；过期项在下一次访问时被惰性清除；表满 4096 项时不写入，等待改用 `settings.budget.reapMs`（fallback 时长可断言）；dispose ⇒ 清空。每条路径结束后都要断言表的大小。
2. worktree.test：kept 时带 `path`；owner marker 在 H2 写入、在 finally 删除（包括 kept 的情况）；默认 `linkPaths=[]` 时 exec 调用序列与现状逐字节一致（spy）。
3. worktree-link-paths.test（canonical 校验）：
   - 拒绝：空串、`.`、`..`、`a/../b`、`a//b`、`a/`、`/abs`、`-x`、`a\b`，以及 `:*?[]!` 中的每一个字符、控制字符、首尾空白；
   - 去重与 16 项上限；
   - 源路径是 symlink，或某一级父目录是 symlink ⇒ 拒绝；
   - `check-ignore` 退出码 1 或 128 ⇒ 跳过。
4. worktree-git-integration（真实 git）：
   - 同时建 4 个 worktree，全部成功；
   - linkPaths：只有软链时算 clean 并删除，目标目录仍在；有源码改动时提交内容里不含软链（`git show --stat`）；
   - **commit hook 慢于 reapMs**（hook 里 `sleep`，reapMs=1000）⇒ exec 超时，结果为 `kept` 并带 path，worktree 仍在；
   - **commit hook 约 6s 且 reapMs 调大到 10000** ⇒ 结果为 `committed`，分支确实存在（最终分支状态）。
5. runtime-adapter-prompt-notes（v2.1 改写）：
   - fake driver 捕获 **`handle.prompt()` 的实参字节**：建出 link 时等于 `buildPrompt(spec) + "\n\n" + note`；append 和 replace 两种 promptMode 都要覆盖；resume 同样追加；
   - driver 收到的 `create/resume` 参数里没有 `promptNotes` 键；
   - consult run 不追加；
   - `linkPaths=[]` 时实参 `===` `buildPrompt(spec)`；
   - `appendPromptNotes` 纯函数的边界情况。
6. integration/worktree-link-paths（**顶层 Agent 的影响 + 并发只读**）：
   - 顶层 Agent 在 `linkPaths=["node_modules"]` 下，子 run 的 prompt 带只读提示，分支不含软链；
   - 顶层 Agent run 和 workflow 子 run **同时**只读访问同一个 link path（fake driver 读取 `wt/node_modules/x`）⇒ 两边都能提交，主 checkout 的 node_modules 哈希前后不变；
   - 默认 `[]` 时顶层 Agent 的 prompt 逐字节不变。
7. settings-worktree：`linkPaths` 的合并与校验，非数组或非法元素被丢弃，并对每一项告警。
8. worktree-orphans.test：§3 验收 (a)-(f)、(h)-(k) 中的纯函数部分，**重点覆盖三种情况**：`creating` 状态加宽限期、同 PID `/reload`（owner-gone 与 tracked 在集合中两种）、PID 复用（其他 pid 的 procStartOf 不一致，同 pid 的 procStartedAt 不一致）。`procStartOf` 的 `/proc` 解析用 fixture 字符串测试，comm 里带空格和 `)` 的情况也要覆盖。
9. **integration/worktree-h2-compensation**（v2.1 条件 1），使用真实 runtime-adapter、worktree 扩展、fake exec 和 FakeClock：
   - **「add 完成时 startup timeout 已经返回」**：`worktree add` 在 `startupMs + 1s` 才以 0 返回并建出目录，run 在 `startupMs` 时已经是 `failed(config)`（超时文案）。add 返回后，exec 依次收到 `worktree remove --force <path>`；marker 被删除；`resolveWorktreeOrigin(path)` 为 undefined；records 为空；beforeReap 从未被调用；tracked 集合为空；
   - 同一场景下 remove 失败 ⇒ marker 为 `abandoned` 并保留，`scanWorktreeOrphans` 报告 `abandoned`，`onDiagnostic` 被调用；
   - 超时时刻 exec 收到的 `opts.signal.aborted === true`；add 被 signal 杀掉（非 0 退出）⇒ 补偿后抛错，没有残留；
   - `h2_failed`：两个扩展串联，worktree 扩展成功，后一个扩展抛错 ⇒ worktree 被补偿；
   - `pre_runner_exit`：H2 成功之后注入同步抛错 ⇒ 被补偿；
   - 补偿幂等：abandon 与 H2 自身补偿同时发生，git remove 只执行一次；
   - 没有人 await 补偿：failed(config) 的 outcome 时间点不受补偿耗时影响。
10. worktree-git-integration 补充（真实 git）：add 完成后再执行补偿 ⇒ 目录和 `.git/worktrees/<n>` 管理项都被清理（`git worktree list` 不再包含它）；带 linkPaths 时，补偿之后目标 node_modules 仍然完好。
11. registry.test：`resolveSessionSpec` 透传 ctx；`signal.aborted` 时不再调用后续扩展；`abandonSessionSpec` 分发到所有扩展，某个抛错不影响其他的；老扩展（不声明 ctx 和 abandon）行为不变。
12. **integration/worktree-late-dispose**（v2.1 条件 2）：
    - 真实 spawn-service 加 runtime-adapter，隔离 run 的 H3 被 fake exec 挂住；同时 workflow 风格的 late 等待者和 settle 等待者都在等待；
    - 调用 `worktreeLate.dispose()`，模拟 stack 重建：`vi.getTimerCount()` 回到基线，等待者以 `disposed` 结束；
    - 放开 H3：旧 store 的 `put`、旧 run-log 的 `appendEntry("subagent:run")`、`worktreeDiag.current` 在 dispose 之后调用次数都是 0；当前 sink 恰好收到一次 `subagent:worktree-disposition`，内容包含 state、branch 和 path（kept 时）；
    - release 之后没有 sink ⇒ 只 warn，不抛错；
    - 用 `buildSessionStack` 连续构建两次（配合 `sandboxHome()`）：第二次构建会调用第一个 stack 的 `worktreeLate.dispose()`（spy），新 stack 的 sink 取代旧的。
13. worktree-disposition-sink.test：register、release 的身份校验（旧 token 不能 release 新 sink）；write 被路由到当前 sink；没有 sink 时 warn；跨模块实例共享 `Symbol.for` holder（模拟 `/reload`）。
14. worktree.test 补充（v2.1 条件 3）：marker 在 `worktree add` **之前**已经是 `creating`（exec spy 在 add 调用时读取 marker 文件）；add 成功后变为 `active`；token 包含 pid、procStartedAt 和 instanceId；两个扩展实例的 instanceId 不同；tracked 集合的加入和移除。

**P3 `consult-cwd`**：

9. fork-store：`forceCwd` 时文件头 cwd = fallback（即使专家头部的 cwd 存在）；不带时两级规则不变。
10. consult-tool：
    - `isolated:true` ⇒ fork 调用带 `forceCwd`，spawn 的 cwd 是提问方 worktree，`resolveForkCwd` 未被调用（spy）；
    - `isolated:false` ⇒ 调用参数与现状逐字节一致；
    - getter 每次调用只读一次；
    - `"main"` 专家遵循同样规则。
11. runtime-adapter-consult：getter 在 H2 之前返回 H2 之前的 cwd，H2 之后返回 worktree 路径加 `isolated:true`；未隔离时 `isolated:false`；H2 失败时工具不会执行。
12. integration/consult-worktree-cwd：
    - 真实 SpawnService、RuntimeRunner、worktree 扩展（fake exec 建临时目录）加 consult 接线；
    - **隔离的提问方**在它自己的 worktree 里完成 fork（文件头 cwd）和 spawn（请求 cwd），专家分别覆盖未隔离、隔离且 committed、隔离且 kept 三种情况；
    - **顶层 Agent 回归**：未隔离的顶层提问方加 experts 时，consult 的 cwd 与现状一致。
13. consult / consult-wiring 已有的集成测试在签名变更后保持绿（只调整 fake）。

**P2 `wf-isolation`**：

14. host-worktree：
    - 透传：立即派发和排队派发都带 `isolation`；不带隔离的调用请求里没有这个键；
    - D2 拒绝：reason 为 `isolation_unavailable`，不进 registry 和 expertScope，也不染色。
15. host-worktree 的 settle 等待：
    - 先 outcome 后 mark，settle 带 branch；
    - mark 先到，立即 settle；
    - 超时 ⇒ `pending`，等待期间占着槽位，第 maxParallel+1 个调用排队；
    - `awaitWorktree` 返回 reject 的端口 ⇒ `pending`；
    - host 兜底上限随 `settings.budget.reapMs` 变化（`buildWorkflowRunBudget`）。
16. **晚到 mark**：
    - 脚本拿到的是 `pending`，之后 worker 不再收到任何消息（spy `workerHost.send` 只调用一次）；
    - 在 orchestrator 读取终态 children **之前**到达 ⇒ `worktreeFinal` 出现在 outcome 文本里；**之后**到达 ⇒ outcome 不变，但 store 或 run log 有一次包含 disposition 的 put（appendEntry spy）。
17. **workflow timeout/killAt 之后 H3 继续执行**：
    - FakeClock 驱动到 killAt，子 run 被 abort，fake exec 延迟 commit；
    - workflow 终态中该调用为 `aborted` 加 `pending`；
    - 随后 exec 完成 ⇒ run log 里是 committed，fleet 的 live record 是 committed；
    - host 没有残留定时器，spawn-service 的等待者被清空。
18. stopOwned 发生在 settle 等待期间 ⇒ 强制 settle 且标记 pending；迟到的 outcome 不会产生重复记录。
19. worker-host-call，**null 兼容**：失败或 abort 的隔离子 run 调 agent() 得到 `null`，`fullResult` 下同样是 `null`，不抛错；children 里有 worktree 字段，outcome 列出分支。
20. worker-host-call，**fullResult 字段兼容**：未隔离时 `Object.keys` 严格等于 `["text","runId","label"]`；隔离时多出 `worktree`；普通调用返回字符串。
21. replay：`isolation:true` 时从未调用 lookup；判定顺序正确；旧条目上的 RP7 仍然生效。replay-taint.property：被接受的隔离调用是染色源，被拒绝的不是。journal-replay-e2e：隔离调用不写条目，重跑时其后的调用全部 live。
22. spawner-adapter：透传；`awaitWorktree` 的三种映射；端口缺少对应方法时返回 `none`；`worktreeAvailable` 读取 getter 的实时值。
23. workflow-tool：
    - **outcome 截断时仍能看到分支**：`resultMaxChars` 很小，children 和 result 都很长时，worktree 段完整出现在结果文本和通知里，并受自身上限约束（64 行、8 KiB、`…N more`）；
    - 渲染 `⎇` 标记和 `pending→final`；
    - 描述里不再出现「isolation 不生效」。
24. integration/workflow-worktree：真实 SpawnService 加 fake exec 扩展，端到端验证 H2 改写 cwd → H3 报告 → host 收到 branch；abort 用例里 children 带 worktree，没有 orphan。

**P4 `wt-orphans`**：

25. status.test：有残留时显示 `worktrees: N orphaned` 行，最多 5 条路径；没有残留时不显示。
26. integration/worktree-orphans-notify：覆盖 §3 验收 (b)、(g)，每个进程只提示一次；用 `Symbol.for` 标记实现幂等，测试之间要清理这个全局标记。`abandoned` 的条目出现在提示里（(k)）。

**门禁**：每个包在干净的 worktree 里通过 `npm run format:check && npm run typecheck && npm test && npm run build`。

## 7. 风险（已接受或已缓解）

- **行为变化**：
  - 已有脚本写了 isolation 但 worktree 关闭时，会被拒绝（决定 1）；
  - 隔离的顶层提问方，其 consult 的 cwd 改变（决定 3）；
  - `linkPaths` 非空时，prompt 里多出提示。
- **reapMs 与慢 hook**：commit hook 慢于 reapMs 会被 exec 超时杀掉，结果是 `kept`（不丢数据）。要让慢 hook 能提交成功，需要调大 `budget.reapMs`，测试 4 锁定了这个行为。
- **pending 不可逆**：脚本拿到的状态可能比最终状态旧，以终态 outcome 或 run log 为准。
- **agent 类型把 reapMs 调得比全局值大**：host 兜底先到期 ⇒ pending，由晚到路径补上。
- **linkPaths 共享写入**：违反只读约定会污染主 checkout，不加锁，属于已接受风险。
- **并发**：磁盘上的 worktree 数量可能超过 maxParallel（D8），不加 semaphore。
- **worktree 里看不到主 checkout 的未提交改动**：worktree 从 HEAD 建出，写进描述。
- **设置不一致**：扩展在 activate 时读取 `worktree.enabled`，与可用性门读到的值可能不同，修改后需要 `/reload`，写进文档。
- **残留提示可能误报**：其他 pi 进程用旧版本建的、没有 marker 的活跃 worktree 会被报成残留。提示文案要求删除前先确认。
- `pi-agent-*` 分支不会自动清理。
- （v2.1）**H2 补偿删除失败**：保留现场，marker 标为 `abandoned`，由 P4 提示，不做强制 `rm -rf`。
- （v2.1）**跨会话的晚到记录**：stack 已被 dispose 时，晚到的 disposition 会以 `subagent:worktree-disposition` 写进**当前**会话文件，而不是 run 所属的旧会话。这是有意为之：旧会话已经关闭，写进当前会话才能被用户看到。这类条目不参与 read-back。
- （v2.1）**非 Linux 的 PID 复用**：无法读取进程启动时刻时，存活的 pid 一律视为活跃，可能漏报残留。
- （v2.1）**reapMs 表超限**：超过 4096 项时新 run 回落到 `settings.budget.reapMs`，如果 agent 类型调大了 reapMs，等待可能提前结束 ⇒ pending，之后由晚到路径补上。

## 8. 需用户确认的问题

无。

## v1→v2 处置

| #   | 评审意见                                                                              | 级别 | 处置                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P3 consult cwd 是可选项，契约没有冻结                                                 | 严重 | 已改。删除「可选」和「不改变 consult」的表述；D10 冻结了 getter 契约（runtime-adapter 的 cell 在 H2 之后写一次 → depsFactory → ConsultDeps.selfCwd → fork 的 `forceCwd` 与 spawn cwd），stack 接线包装 fork-store；新增测试 9-13，包括隔离提问方的集成测试和顶层 Agent 回归测试。P3 成为必做包。                                                                  |
| 2   | 等待上限用了 DEFAULT_BUDGET；忽略了 beforeReap 超时后 hook 仍在执行；pending 语义不清 | 严重 | 已改。D5 改用每个 run 实际 mergeBudget 得到的 reapMs（settle = reapMs+1s，late = 5×reapMs+1s），host 兜底取 `settings.budget.reapMs`；写明 runner.ts:671-685 只放弃等待、不取消 hook；pending 定义为写进脚本返回值、不会再变的值；晚到的 disposition 只进入终态 outcome（在 orchestrator.ts:838 读取之前到达时）和 run log，不回填 worker。新增测试 1、4、15-17。 |
| 3   | 「并发上限 = maxParallel」表述不准确                                                  | 一般 | 已改。D8 改写为「活跃 workflow 调用上限」，明确后台 H3、pending、kept 以及其他来源的 worktree 不受它保护；不引入新的 semaphore。                                                                                                                                                                                                                                  |
| 4   | linkPaths 共享 node_modules 存在写冲突                                                | 严重 | 已改。不实现锁；D9 写入只读约定（promptNotes 注入提示，并同步到文档和工具描述）、显式验收条件和已接受风险；新增测试 6，覆盖顶层 Agent 与 workflow 并发只读同一个 link path。                                                                                                                                                                                      |
| 5   | linkPaths 校验不充分                                                                  | 一般 | 已改。D9 定义 canonical 规则：拒绝空段、`.`、`..`、绝对路径、反斜杠、`:*?[]!`、控制字符、以 `-` 开头、源路径或某级父目录是 symlink；先做 canonical 校验和 lstat/realpath 检查，再调 git；pathspec 使用 `:(exclude,literal)`。新增测试 3。                                                                                                                         |
| 6   | 崩溃或 reload 后的残留没有处理                                                        | 一般 | 已改。自动 GC 列为非目标；新增 P4：owner marker 加启动扫描，`/agent status` 显示，每个进程提示一次，给出清理命令；§3 列出验收 (a)-(g)，测试 8、25、26。                                                                                                                                                                                                           |
| 7   | 测试矩阵不全                                                                          | 一般 | 已改。§6 覆盖评审列出的全部场景：P3 cwd（10-12）、顶层 linkPaths 的影响（6）、配置化 reapMs（1、15）、慢于 reapMs 以及约 6s 的 commit hook（4）、晚到 disposition（16）、killAt 之后 H3 继续执行（17）、失败或 abort 的 null 兼容（19）、fullResult 字段兼容（20）、outcome 截断时仍能看到分支（23）。                                                            |
| 8   | 「重新跑 conflict-check」不够具体；标题和待确认表述需要清理                           | 建议 | 已改。§5.1 给出具体命令、预期退出码和失败判据；标题改为 v2，删除已经解决的「待确认」表述，§8 为「无」。                                                                                                                                                                                                                                                           |

## v2→v2.1 条件落地

| #   | 复审条件                                                                                                 | 级别 | 落地位置                                                                                                                                                                                                                                                                          | 验收（测试）                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | H2 的 `withStartupTimeout` 超时后不取消 hook；worktree 建成之后才超时，会残留 worktree、marker 和 origin | 严重 | D12：扩展点增加 `ctx.signal` 与 `abandonSessionSpec`，registry 分发；adapter 在超时时 abort，并在 `finally`（`!runnerEntered`）中 fire-and-forget abandon；扩展按状态机补偿（remove --force → prune → 删 marker、撤 origin），失败则标 `abandoned` 交给 P4；`pi.exec` 转发 signal | #27（「add 完成时 startup timeout 已经返回」加 5 个变体）、#28、#29，§3 (k)                                                                                     |
| 2   | 晚到监听的 timer 和等待者没有 dispose；旧 stack 重建之后仍会调用旧 store 和 run log                      | 严重 | D13：`SpawnService.dispose` 和 `Runner.dispose`，接入 stack 顶部的交接与 session_shutdown；dispose 之后的晚到结果只写进进程级当前 sink（`subagent:worktree-disposition`，写入当前会话文件），不经过旧 store                                                                       | #30（重建后没有残留 timer，没有旧 store 或 run-log 调用，sink 恰好一次），#31                                                                                   |
| 3   | owner marker 应在 add 之前预写 `creating`；需要 owner token，不能只靠 pid 存活判断                       | 一般 | §3：预写 `creating` 状态，无 marker 的目录有 120s 宽限；token 为 `{pid, procStartedAt, instanceId}`，配合进程内 tracked 集合与 Linux `/proc` 的启动时刻比对；说明了用扩展实例 id 而不是 stack id 的原因                                                                           | #8（三种情况）、#32，§3 (h)(i)(j)                                                                                                                               |
| 4   | 只读提示没有说明如何真正进入 prompt                                                                      | 一般 | D9「只读提示的 prompt 路径」：H2 → `sessionSpec.promptNotes` → 在 `:633` 之前拆出 → `appendPromptNotes(buildPrompt(spec), notes)` → `req.prompt` → `handle.prompt(req.prompt)`（`runner.ts:673`），driver 参数里不含该字段                                                        | #5（断言 `handle.prompt()` 实参字节，覆盖两种 promptMode 加 resume）                                                                                            |
| 5   | reapMsOf 需要全路径清理、定义超限 fallback、按 run 生命周期保存                                          | 一般 | D5a：finish、none、timeout(late)、mark、dispose 全路径清理，加 TTL tombstone 的惰性过期；超过 4096 项或查不到时回落到 `settings.budget.reapMs`；取消固定 FIFO 淘汰                                                                                                                | #1 的 D5a 子项（每条路径结束后断言表大小）                                                                                                                      |
| —   | 同步项                                                                                                   | —    | §1.2 更新了 `6228dc1` 之后下移的行号（runner.ts:740-758 与 :585-590、core/types.ts:815 与 :875-877、settings.ts:510），并补充 v2.1 的证据行；§4 冻结面；§5 的 P1 文件域增加 registry、ports、sink、stack、index 以及 5 个测试文件；§5.1 重新跑了预检                              | 预检实测：退出码 1，交集只有 runtime-adapter.ts（wt-core×consult-cwd）、stack.ts（4 个包两两之间 6 对）、index.ts（wt-core×wt-orphans），与 §5.1 的失败判据一致 |

## 用户确认（v2.1，开工）

- 2026-09-26 用户确认 v2.1 开工：P1 → P3 → P2 → P4 串行，每包验收后合入 master。
