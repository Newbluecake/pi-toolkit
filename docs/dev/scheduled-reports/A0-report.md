# A0 agent 骨架包报告：定时任务（#32）

> 依据：`docs/dev/scheduled-reports/plan.md` r3 §12 A0 行，重点 §3.3（模式矩阵）、§4.4（sweep / 容差 / 心跳）、§4.5a/§4.5b（两种 claim 的调用方）、§4.6（恢复与关闭）、§7.1/§7.4/§7.5（帧）、§7.6（`assertExecutable`）、§10.1/§10.3（帧、HubConfig）。
> 契约基线：S0 `ec4297b0`、S1 `47d07e95`。`spec.ts`、`protocol/schedule.ts`、S1 core 全部未改。
> 本包零 git 写操作。

## 1. 改动清单

| 文件                                                        | 内容                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schedule/agent/mode.ts`（新）                          | §3.3 矩阵 `resolveScheduleMode`；工具动作级拒绝 `actionRefusal`（给 A3）；统一执行门 `assertExecutable`（§7.6）                                                                                                                                                                                                                  |
| `src/schedule/agent/clock.ts`（新）                         | `createSessionClock`：armedSince、分段 unref 定时器、启动 sweep+恢复、补充 sweep、30 s stat 轮询（rev 变化 ⇒ sweep；外部持有者 ⇒ 恢复）、60 s 墙钟/单调钟心跳、`poke`、uncertain 提交的后续处理                                                                                                                                  |
| `src/schedule/agent/coordinator.ts`（新）                   | 会话级 `createHubCoordinator` / `NULL_SCHEDULE_COORDINATOR`；activate 级 `createScheduleHubRouter`（= `WebHubDeps.schedule` 端口）                                                                                                                                                                                               |
| `src/schedule/agent/wire.ts`（新）                          | activate 级 `wireSchedule`；会话级 `createScheduleAgent`（模式、身份/epoch、惰性 store、clock、coordinator、执行器注册表、`runNow`、`shutdown`）；进程级 disposed-epoch 表                                                                                                                                                       |
| `src/index.ts`                                              | post-guard、compat 闸门之后按 `schedule.enabled` 调 `wireSchedule`；传给 `buildSessionStack` 与 `wireWebHub`；`session_start` 末尾 `void stack.schedule?.start()`；`session_shutdown` 第二步 `await stack.schedule?.shutdown()`；防御性重建 `schedule?.dispose()`；删除旧 `scheduler.start/stop`                                 |
| `src/stack.ts`                                              | `Stack.schedule?: ScheduleAgent`（替换 `scheduler`）；`buildSessionStack` 末尾新增可选参数 `scheduleWiring`，由它 `createAgent({ ctx })`                                                                                                                                                                                         |
| `src/web-hub/agent/index.ts`                                | `WebHubDeps.schedule?: ScheduleWebHubPort`；`bindLink`（ready = live ∧ hub caps ∋ `sched.v1`）；`onSchedRun/onSchedReceipts` 钩子；`onHubCaps` 转发；`HubConfig.schedule`（端口 ∧ control）；agent caps 尾部追加 `sched.v1`                                                                                                      |
| `src/web-hub/agent/connection.ts`（**扩域，主会话已批准**） | `BindingPort` 加可选 `onSchedRun?` / `onSchedReceipts?`；`onFrame` 加两个 live-link-only case（与 `xs_deliver` 同形）。钩子缺省 ⇒ 静默忽略                                                                                                                                                                                       |
| 删除 `src/schedule/{scheduler,store,cron}.ts`               | 旧引擎退役（`cron.ts` 只被 `scheduler.ts` 引用，一并删除，见 §5）                                                                                                                                                                                                                                                                |
| 删除 `tests/schedule/{cron,scheduler,store}.test.ts`        | 旧引擎测试；仍有价值的两条 cron 行为迁到 `tests/schedule/core/legacy-cron-migrated.test.ts`                                                                                                                                                                                                                                      |
| 新测试 `tests/schedule/agent/*.test.ts`                     | `mode` / `clock` / `coordinator` / `wire` / `webhub-wiring` / `stack-wiring`（共 6 个文件）                                                                                                                                                                                                                                      |
| `tests/web-hub/agent/connection.test.ts`                    | 追加 3 条：帧分发到钩子、无钩子静默、非 live 不分发                                                                                                                                                                                                                                                                              |
| `tests/secure/guard-points.test.ts`                         | 旧「D8: cron refused」两条改写为新引擎（secure ⇒ mode secure、`E_SECURE`、无 store、无 webHubPort、不建目录；plain ⇒ interactive）                                                                                                                                                                                               |
| 10 个测试的清理行（机械替换）                               | `X.scheduler.stop()` → `X.schedule?.dispose()`：`tests/integration/{compact-hint-wiring,external-disabled-bytes,goal-wiring,load-stack-wiring,quota-wiring,unknown-model-admission,worktree-orphans-notify,worktree-orphans-real-fs}.test.ts`、`tests/integration/helpers/external-droid.ts`、`tests/secure/stack-roots.test.ts` |

没有碰 H1（`src/web-hub/hub/**`、`protocol/http-contract.ts`）、F1（`hub/feishu/**`）、前端（`ui/**`）的文件，也没有碰任何 fixture、golden 或 AGENTS.md。

## 2. 关键设计

### 2.1 两级装配

- **activate 级**（`wireSchedule`，`schedule.enabled` 才调用）：
  - 解析 `storeDir = schedule.dir ?? <agentDir>/schedules`；
  - vault 谓词 = 所有已登记 vault 的 `inVaultDir`，字面路径与 `canonicalPath` 各查一次；
  - **只在 plain 域且 `webHub.enabled ∧ control !== false` 时**建 hub router（进程级，跨会话切换存活）；
  - 注册唯一的 `turn_start` 钩子，经 `holder.current?.schedule` 晚绑定做 rev poke。
- **会话级**（`createAgent`，`buildSessionStack` 内调用）：模式判定 → 身份与 epoch → 惰性 store → clock（只在 interactive）→ coordinator（有 router 且 interactive 时为 Hub，否则 Null）→ 执行器注册表。

### 2.2 模式矩阵（§3.3）

判定顺序：secure/locked → 子会话文件 → 无会话文件 → print/json → tui/rpc。

- 子会话文件 = 会话头部条目（前 8 条，内存读取，无 IO）含 `custom/subagent:child` 标记，**或**会话文件位于 `consultSessionDir()` 下。
- 未知的 pi 模式按 print 处理（fail closed）。
- `assertExecutable` 的检查顺序：已 dispose ⇒ `E_NOT_OWNER`；矩阵 ⇒ `E_MODE` / `E_SECURE` / `E_CHILD` / `E_EPHEMERAL`；运行期 LOCKED（`secureGuards.lockedReason()`）⇒ `E_SECURE`；当前 sid ≠ 归属 sid（或 ctx 已失效抛错）⇒ `E_NOT_OWNER`；带任务时 `ownerCwd` 的字面或 realpath 在 vault 内 ⇒ `E_SECURE`，realpath 失败 ⇒ `E_INVALID`。
- 加密域进程**不读身份、不解析 store、不建目录**，也不向 web-hub 提供端口，因此没有 `sched.v1` cap、没有 `HubConfig.schedule`。

### 2.3 SessionClock

- `armedSince` = stack 构建时刻。候选 occurrence：`T > decidedThrough`、`T ≥ armedSince`、高于本 clock 的每任务已尝试下限（防止 ineligible 时原地重入）。已越过容差的 T 也会去 claim，由 `autoClaim` 的迟到分支记 `missed(late)`，所以定时器晚到不会留下未裁决的 T。
- 启动：`sweep`（`more` 时最多 8 轮）→ `recoverRuns` → arm。
- 补充 sweep：来源有三个——sweep 的 `plan.supplementalAt`；preflight 拒绝；锁内 ineligible（`early` 除外）。后两者在 `T + tol + 1 s` 补一次 sweep。待办时刻用集合去重（≤64 个），单个定时器指向最早的一个。
- 30 s 轮询：只 `stat` state.json（ino/size/mtime）。有变化 ⇒ 读 rev，rev 变了 ⇒ sweep + rearm；存在**他人持有**的非终态 run ⇒ `recoverRuns`（避免每 30 s 空拿锁）。store 根目录还不存在时，store 端口每 30 s 重试一次只读解析。
- 60 s 心跳：`|Δwall − Δmono| > 60 s` ⇒ sweep + rearm。
- `autoClaim` 返回 `error{uncertain}`（S1 M5）⇒ **不 dispatch**；5 s 后重读，若该 runKey 仍是本 holder 的非终态 run ⇒ `finishRun(unknown, "no-outcome")`。E_BUSY 且仍在容差内 ⇒ 2 s 后重试一次。
- 所有定时器都经注入的 `Clock` 创建（生产环境用 unref 的分段 `systemClock`）；异步工作串行在一条链上，每次 await 之后都复查 `disposed`；`dispose()` 清空所有定时器（测试断言 `pendingTimers === 0`）。

### 2.4 执行器注册表（A1/A2 的接口）

- `agent.setExecutor("background" | "message", { dispatch(run, task) })`。
- 自动 `fired` 和手动 `started`（非 replay）后，在**锁外**调用 `dispatch`。从这一刻起，run 的终态写入归执行器负责。
- 兜底：claim 时没有对应执行器，或 `dispatch` 抛错 ⇒ 锁内写终态。background 写 `refused(admission:E_UNSUPPORTED | admission:executor-error)`，message 写 `dropped(capability)`，run 不会停留在非终态。
- preflight（锁外）同样要求该 form 有执行器，否则 `E_UNSUPPORTED`，不 claim。因此**只有 A0 时任何任务都不会执行**；到点的 occurrence 越过容差后由补充 sweep 记为 missed。

### 2.5 Coordinator

- 只在 `link.ready()`（live ∧ hello_ack.caps ∋ `sched.v1`）时发帧，否则什么都不做、什么都不排队（§10.1；hub 自己每 60 s 兜底扫描）。
- `changed()` 按 tick 合并后发 `sched_changed{sessionId}`；每次 hello_ack 补发一次。
- `sched_run`：每收到一帧**恰好回一个** ack。sessionId 不符或 router 上没有挂接会话 ⇒ `refused(E_NOT_OWNER)`；`expiresAt ≤ now` ⇒ `refused(E_INVALID:expired)`；同一 reqId 在途时只执行一次，但每帧都回 ack；handler 抛错 ⇒ `refused(E_BUSY)`；已 dispose ⇒ `refused(E_NOT_OWNER)`。
- `sched_receipts`：只处理本会话；锁内 `removePendingReports`，写入后推送 `sched_changed`；E_BUSY 时 5 s 后重试一次（hub 在 hello 和每次状态变化时都会重推，条目 24 h 后也会过期）。

### 2.6 HubConfig 与 caps

- `HubConfig.schedule = { dir: <realpath>, toleranceS: 60 }`，仅在「端口存在（schedule.enabled ∧ plain 域 ∧ webHub）∧ `control !== false`」时写入。
- hub 启动时要 pin 这个目录，所以 `hubConfig()` 会用 `ensureStoreRoot` 创建 storeDir（0700）。这是 schedule 开启时**唯一**的主动建目录点；vault 内或不可用 ⇒ 省略整个 key，并且只告警一次。
- agent caps 在尾部追加 `sched.v1`（位于 `!control` 早退之后）。

### 2.7 关闭顺序（§4.6）

- `session_shutdown` 中紧跟 `backgroundCompletions.dispose()` 之后执行 `await schedule.shutdown()`：置 disposed、在进程级表中登记 epoch、清定时器、摘下 coordinator；然后用 500 ms 锁等待的 store 执行 `closeEpoch`，把本 epoch 的非终态 run 写成 `unknown(owner-closed)` / `dropped(owner-closed)`。这一步排在 run drain 之前，所以 shutdown 产生的 `aborted` 只能记为 `lateOutcome`。
- store 从未解析过（本会话没有账本）⇒ 跳过 closeEpoch，零 IO。
- 防御性重建（session_start 时没有配对的 shutdown）只做 `dispose()`；新 stack 的 `recoverRuns` 通过进程级 disposed-epoch 表把旧 epoch 判为 `unknown(reload)`。

### 2.8 进程级状态

唯一的进程级状态是 `Symbol.for("pi-subagent:sched-disposed-epochs")`：一个 FIFO 集合，上限 256。它必须跨越 /reload 的新模块实例，做法与 worktree-origin 相同。其余状态全部在 activate / stack 的闭包里。

## 3. 给下游包的接口说明

### A1（background / note）

- 在 `buildSessionStack` 里（`schedule` 构建之后，能拿到 `spawn` / `consult` / `query` 的位置）调用 `schedule?.setExecutor("background", { dispatch })`。
- `dispatch(run, task)` 收到的 run 处于 `dispatching`、holder 是本 epoch。必须同步返回、不得抛错；之后所有写入走 `schedule.store()!`（此时一定存在）。终态和报告**只能**用 `writeReportLocked`（S1），写完调用 `schedule.changed()`（推 `sched_changed` 并触发 clock poke）。
- 所有回调先检查 `schedule.isDisposed()`；已 dispose 时只允许写 state.json（单调规则），不得通过旧 ctx 写会话。
- 跨进程判死时用 `judgeHolder(..., { currentEpoch: schedule.epoch, epochDisposed: isEpochDisposed })`（`wire.ts` 导出）。
- `consultMain` 需要的 sid 用 `schedule.sessionId`；进程身份用 `schedule.self`。

### A2（消息调度器）

- `schedule?.setExecutor("message", { dispatch })`：run 处于 `queued`。
- 发送前的执行门：`schedule.gate(task)`（与定时 claim 同一套 `assertExecutable`，含执行器存在性）。
- §7.5 的绑定帧：`schedule.coordinator.bound(agentKey, runKey)`（同步发送；Null 或无 cap 时为 no-op）。
- D13、占位等已由 S1 `autoClaim` 处理。调度器自己的 fence、能力门控、token 等全部在 A2 自己的文件里；需要的 pi 事件请在 `wire.ts` 以外自行注册（建议同样经 `holder.current?.schedule` 晚绑定）。

### A3（工具 / 命令 / 段 / 状态栏）

- 模式判定：`actionRefusal(schedule.mode, action)`；未启用时工具不注册（`E_DISABLED` 仅用于命令面）。
- 读取：任何模式都用 `schedule.readState()`（只读，不建目录）；写入：interactive 下用 `schedule.ensureStore()`（首次 create 时建目录）+ S1 的 `changeTask` / `approveTask` / `removeTask`，写完调用 `schedule.changed()`。
- 立即运行（工具 `run_now`、`/schedule run`、web `run`）：`schedule.runNow({ taskId, reqId, defHash? })`。web 用 cmdId 作 reqId；本地用 `SCHED_REQ_ID_RE` 兼容的随机 id（16–64 位 `[A-Za-z0-9_-]`）。返回 `started{runKey, replay}` 或 `refused{code, detail?}`。
- 状态栏：`schedule.clock?.status()` 给出 `{nextAt, nextTaskId, rev, degraded}`。
- 状态栏 / 段 / digest 都不在 A0 内；`turn_start` 钩子已由 A0 注册（只做 rev poke），A3 若还需要 turn_start，请另行注册，不要改这一个。

### H1 / F1（hub 侧，对照用）

- agent 只在 hello_ack.caps ∋ `sched.v1` 时发 `sched_changed` / `sched_bound` / `sched_run_ack`。
- `sched_run` 一定回 ack，reason 为 `ScheduleErrorCode`，或 `E_INVALID:expired`（≤128 字符）。
- `sched_receipts` 无回复。agent 不会去重回执 id，重复推送是幂等的。

## 4. 与方案的偏差及处理

| #   | 方案                                                                     | 实际 / 冲突                                                                                                                                                                            | 处理                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §12 A0 文件域不含 `connection.ts`                                        | hub→agent 帧在 `connection.ts` 的 switch 里分发，没有通用钩子                                                                                                                          | 主会话裁定扩域：只加两个可选 BindingPort 钩子和两个 live-only case，并补测试。schedule 关闭时不传钩子，行为不变                                                                                            |
| 2   | §7.6 `assertExecutable` 含 `ownerCwd` 检查，而 S1 `ClaimGate` 不接收任务 | 锁内 gate 无法看到任务                                                                                                                                                                 | 锁内 gate 只做无任务的部分；`ownerCwd` 与执行器检查在锁外 preflight（基于快照）。`ownerCwd` 是禁改字段（`SCHED_UPDATE_FORBIDDEN_FIELDS`），所以快照与锁内一致；form 被并发修改的竞态由 §2.4 的兜底终态覆盖 |
| 3   | §10.1「hello_ack 不含 cap ⇒ 用 NullCoordinator」                         | coordinator 在 stack 构建时就要确定，而 cap 随连接变化                                                                                                                                 | web-hub 端口存在 ⇒ HubCoordinator，每次发送都检查 `link.ready()`（无 cap 时等价 Null，不排队、不持久化）；web-hub 关闭或非 plain 域 ⇒ 真正的 `NULL_SCHEDULE_COORDINATOR`                                   |
| 4   | §4.5a 第 6 步写入后崩溃 ⇒ §4.6；S1 建议 uncertain 由 A0 收尾             | `SCHED_UNKNOWN_REASONS` 里没有专门描述「提交不确定而未派发」的原因                                                                                                                     | 用 `unknown(no-outcome)`（最接近：运行结果不存在）                                                                                                                                                         |
| 5   | §3.3「独立打开的子会话文件」按会话头标记判定                             | 方案说「session-nav 同款判定」（读文件头）                                                                                                                                             | 改为读 `sessionManager.getEntries()` 的前 8 条（line-2 标记就是第 2 条），无 IO；另加 consult fork 目录判定                                                                                                |
| 6   | `HubConfig.schedule.dir` = realpath                                      | hub 启动时用 `resolveStoreRoot` pin 根目录，目录必须存在                                                                                                                               | `hubConfig()` 用 `ensureStoreRoot` 创建 storeDir（0700），只在 schedule 开启 ∧ webHub 开启时发生                                                                                                           |
| 7   | 加密域「工具注册、调用返回 E_SECURE」（S0 偏差 #3）                      | —                                                                                                                                                                                      | 会话级 agent 照常构建（mode secure），给 A3 提供拒绝码；但不提供 web-hub 端口（无 cap / HubConfig），不读 /proc 身份，不碰 storeDir                                                                        |
| 8   | 启动探测 flock（S1 遗留）                                                | —                                                                                                                                                                                      | 第一个 interactive 会话构建时 `flock -V`（2 s 超时，进程内只探测一次）；缺失时告警一次（事务仍按 S1 fail closed）                                                                                          |
| 9   | 段落 / 状态栏 / digest / 工具                                            | 属 A3                                                                                                                                                                                  | A0 只提供 `mode`、`actionRefusal`、`readState`、`clock.status()`                                                                                                                                           |
| 10  | TDD 纪律                                                                 | 本包是先写实现、再补测试，**不是**严格的「先红后绿」（接口要与 S1 core 一起推敲）。补测后做了两次撤销验证：去掉候选的 `armedSince` 下界 ⇒ 3 条失败；去掉 uncertain 后续处理 ⇒ 1 条失败 | 如实披露                                                                                                                                                                                                   |

## 5. 旧引擎退役与兼容

- 删除 `src/schedule/scheduler.ts`、`store.ts`，以及只被它们引用的旧 `cron.ts`（本地 `Date`、无时区）。`Stack.scheduler` 字段同时删除。
- **没有任何生产代码调用过旧引擎的 `register()`**（方案 §2.1 已复核）。所以旧全局文件 `~/.pi/agent/pi-subagent-schedules.json` 正常情况下只有 `[]`——每次 `start()` 都会写回它。退役后的行为：
  - 不再读、不再写这个文件（旧引擎在每个 plain 进程启动时都会写它，这是唯一预期的行为差异，与方案 §1 一致）；
  - **不删除**已有文件，也不迁移：旧格式（interval / 任意 SpawnRequest / 无归属会话）与新模型（按会话归属、需批准、无 interval）不对应，自动迁移会绕过批准（S2）。手写过该文件的用户需要在归属会话里用 `/schedule add`（A3）重建。I1 的 off golden 可以钉住「不写旧文件」；`stack-wiring.test.ts` 已断言 off 时该文件不存在。
- 旧测试中仍有价值的行为：cron 列表/步长解析、跨小时/跨月取 next，已迁到 `tests/schedule/core/legacy-cron-migrated.test.ts`（显式 UTC）。旧 scheduler 的 interval（新模型不支持）、「错过不补跑」（新模型改为记 missed）、「once 只触发一次 / stop 后不再回调」（由 `clock.test.ts` 的 dispose 用例覆盖）不再迁移。
- `tests/secure/guard-points.test.ts` 的 D8 用例改为断言新引擎在加密域的拒绝。

## 6. 自验

| 命令                                                                                                                                                                                                                                                                                                          | 结果                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/schedule tests/web-hub/agent tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/secure tests/web-hub/ui/keepalive-golden.test.ts tests/web-hub/boundary.test.ts --maxWorkers=3` | 140 个文件中 139 个通过；3240 passed / 1 failed。唯一的失败是 S1 的 `tests/schedule/core/fault-injection.test.ts`「8 processes race」，断言为 `expected null to be 'SIGKILL'`（受害子进程在被杀前已退出，属于测试时序问题，不是重复触发）。单独重跑 8 次失败 2 次；A0 没有改动 core 和该测试，详见 §7 |
| `npx vitest run tests/schedule/agent/stack-wiring.test.ts`（在上一轮之后新增）                                                                                                                                                                                                                                | 3 passed                                                                                                                                                                                                                                                                                              |
| 改了清理行的 8 个集成测试 + `tests/integration/web-hub-disabled.test.ts`                                                                                                                                                                                                                                      | 9 个文件，67 passed                                                                                                                                                                                                                                                                                   |
| `npm run typecheck`                                                                                                                                                                                                                                                                                           | 第 1 段 `tsc -p tsconfig.json` 通过；第 2 段 `tsconfig.typecheck.json` 只有 4 个错误，全部在并行包 H1 施工中的 `src/web-hub/hub/schedule/{scan,service,hub-state}.ts`；单跑 `vue-tsc` 的错误也只在前端包的 `PreviewHost.vue`。本包文件 0 错误                                                         |
| 临时 tsconfig 对本包新增和改写的测试文件做类型检查（`tests/schedule/agent/*.ts`、迁移的 cron 测试、`guard-points.test.ts`）                                                                                                                                                                                   | 0 错误（`tests/secure/helpers.ts` 有 1 个既有错误，不是本包引入）                                                                                                                                                                                                                                     |
| `npx prettier --check`（全部改动文件 + 本报告）                                                                                                                                                                                                                                                               | 通过                                                                                                                                                                                                                                                                                                  |

三份 fabric off golden、`secure/off-golden`、`launcher-off-golden`、`keepalive-golden`、`boundary` 全部通过，**fixtures 零改动**（off 测试没有因为装配变化变红，不需要额外关闭正交特性）。

## 7. 遗留与提示

- **心跳漂移**没有独立的端到端用例：FakeClock 推进墙钟时会同时触发到期定时器，难以单独构造「只有墙钟跳、单调钟不动」。逻辑很短（`clock.ts` 的 `scheduleBeat`），建议 I1 在 C-S 或集成层覆盖。
- **control:false 时不写 `HubConfig.schedule`** 只经代码审阅确认（判断与 avatar 同形）：在测试夹具里 control:false 的会话不会走自动拉起 hub 的路径，因此 `webhub-wiring.test.ts` 没有这一条用例。
- **只有 A0 时**，开启 schedule 也不会执行任何任务（没有执行器 ⇒ preflight 拒绝）。A1/A2 注册执行器之后才会真正执行。
- `index.ts` 中 `session_start` 不 await `schedule.start()`（不让锁等待拖慢会话启动）。启动 sweep 与恢复因此是异步的；`/schedule` 在会话刚打开的瞬间读到的可能是 sweep 之前的账本，这无害（下一次读取即一致）。
- 30 s 轮询里的外部持有者恢复，在存在**跨主机**持有者时每 30 s 会拿一次锁（S1 判为 unprovable、不改写）。代价是每次一个 `spawnSync(flock)`，可以接受；如需优化，可以只在存在同主机外部持有者时才拿锁。
- AGENTS.md 的 `src/schedule/` 描述按约定留给 I1 更新。
- **S1 测试偶发失败**：`fault-injection.test.ts`「8 processes race」偶尔报 `expected null to be 'SIGKILL'`，即持锁的受害子进程在测试发出 SIGKILL 前已经正常退出（负载高时更容易出现）。断言的业务部分（恰好 fired 一次）没有失败过。这属于 S1 测试的时序问题，建议 S1 / I1 让受害进程在持锁点阻塞等待信号。
