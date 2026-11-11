# #59 阶段 B：有界 TODO 空闲恢复生产接线设计

## 1. 背景与目标

本文只定义生产接线，不修改代码，不重设计 B1/B2 内核。基线为调用方指定的 `HEAD 1a1b18e4`；行号来自本次工作区只读核验。SDK 核验对象为本地 `@earendil-works/pi-coding-agent` **1.5.0**（`node_modules/@earendil-works/pi-coding-agent/package.json:1-4`）。本文未执行 git、安装、构建或测试；末尾另记文档格式检查。

目标是：在可信人类到达开窗后，仅当整个 root 真正空闲，检查原授权范围内可推进的既有任务；不抢用户、不抢已有自动工作，不把任务列表当授权。

**结论先行：当前普通 pi 插件拓扑不能通过“补几根线”安全启用。** 生产入口拿不到真实 `AgentSession.subscribe`，而且 subscribe 本身也不证明隐藏 deferred input、异步命令、跨 reload 待发 custom 已清空。本设计将“可装配”与“可启用”分开：可以实现宿主适配与生产门禁，但普通 SDK 1.5.0 root 仍必须 effective-off，直到公开宿主能力及真实拓扑 conformance 获得证据。不得把一个测试里全 clear 的依赖表当成生产能力。

保持以下既有语义：

- 候选、依赖/环检测、metadata 只能收窄：`src/todo/idle-recovery.ts:13-43,277`。
- 每可信到达窗口最多 2 次，session 内 `(fingerprint, progressKey)` 一次，seen 256 满闭锁；不是定时重试服务。
- `reserve` 先扣账再发；异常、投递 unknown、不确定持久化不退款。
- aborted settled 锁 Stop，只有新的合格真人到达可以开新窗口；历史消息不构成人类证据。
- 尝试起点起算 900,000 ms 固定期限；只 abort 自己绑定的运行，10,000 ms 宽限后 stuck。
- 各 busy 源全 clear 才通过；缺失、过期、异常、初始化未完成均不等于空。

### 1.1 历史裁定与本设计的边界

`docs/dev/todo-idle-recovery/plan.md:20` 记录用户已确认 `todo.idleRecovery.enabled=true`，同时要求安全门不完整时 effective-off。本文保留该默认，不擅自改成默认 false；灰度靠**认证宿主范围**及显式关闭，而不是跳过安全门。

下文标注“新增契约”的符号均是待开发的项目内部口，不是声称 SDK 已有该 API。必须评审裁定的宿主来源与窄范围解冻列于 §6.5；这些问题未裁定前，不得宣称生产已启用。

## 2. 现状摘要

### 2.1 已有模块及职责

- `src/todo/index.ts:158-203,645-651`：`wireTodo` 负责 Task 工具、nudge、TODO restore；`getTodoSnapshot()` 返回完整内存态，含归档依赖，不是 Web 的截断投影。
- `src/todo/idle-recovery-host.ts:40-63,107-184`：可信 arrival 与同步 busy 汇总，缺口为 unknown；不注册生产 hook。
- `src/todo/idle-recovery-runner.ts:29-60,100-158,240-327,348-442`：订阅、one-shot 复核、预算提交、token/BAS/context 绑定、期限和清理。
- `src/todo/idle-recovery-store.ts:104-135,139-239`：全树 append-only 账本；只有 host proof 能打开 live window；无 timer/send。
- `src/index.ts:209-220`：当前只装配 `wireTodo` 的 nudge/archive，**没有 recovery**。`tests/todo/idle-recovery-production.test.ts:23-96` 钉住这一现状。
- `src/stack.ts:591-602,2450-2457` 与 `src/stack-teardown.ts:159-269`：每 session stack 的所有权、三路有序 teardown。
- `tests/conformance/todo-idle-recovery.test.ts:539-670`：真实 SDK session + B2 的受控集成，但时钟为 FakeClock，busy 源在 609 行全部人为置 clear，不能代表生产验收。

### 2.2 真实 SDK 事件源及缺口

实际公开 API：

```text
createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>
CreateAgentSessionResult.session: AgentSession
AgentSession.subscribe(listener: AgentSessionEventListener): () => void
AgentSessionEventListener = (event: AgentSessionEvent) => void
AgentSessionEvent 包含 { type: "agent_settled"; aborted: boolean }
```

出处：SDK `dist/core/sdk.d.ts:66-74,116`，`dist/core/agent-session.d.ts:49-58,113,381-386`。本节所有 SDK 路径均相对 `node_modules/@earendil-works/pi-coding-agent/`。

真正的适配形式是已有测试 `tests/conformance/todo-idle-recovery.test.ts:626` 的：

```text
subscribeSession: (listener) => session.subscribe(listener)
```

其中 `session` 必须是宿主实际持有的当前 root AgentSession，不能是新建的旁路 session，不能是 child driver 的 session，也不能把 sessionManager 强转成 session。

`dist/core/extensions/types.d.ts:232-272` 的 `ExtensionContext` 只有只读 sessionManager、`isIdle()`、`hasPendingMessages()`、`abort()` 等，没有 session/subscribe。`src/index.ts:131` 收到的是 ExtensionAPI；现有生产入口没有上述 session 来源。因此：

1. **当前可执行的安全接线**：能力缺席就不构造有效 runner，仍 off。
2. **可有效启用的前置条件**：拥有真实 session 的 SDK 宿主通过正式公开、同生命周期的适配口交付订阅与 admission/替换保证。
3. **需评审裁定**：普通 CLI 的能力交付是请求上游公开宿主口，还是另立 SDK-owned host 适配项目。推荐先取得上游公开能力；本任务不默认新增启动器、不修改 node_modules、不 patch prototype、不读 SDK 私有字段。

### 2.3 为什么 extension 的 agent_settled hook 不能排恢复

SDK `dist/core/agent-session.js:696-716` 的实际顺序是：

```text
await extensionRunner.emit(agent_settled)
同步 session._emit(agent_settled) → subscribe listeners
清除 emitting 标志
逐个 await deferredSettledActions
```

extension hook 内排一个 immediate，可能在后面的异步 extension hook 尚未返回时执行。`tests/conformance/todo-idle-recovery.test.ts:236-283` 已证明此时 `idle=true, pending=false` 仍会误发。真实 subscribe 在 awaited hooks 之后，但仍在 deferred actions 之前；673-731 行证明 deferred input 的异步 input handler 可以继续隐身。

所以 extension hook 只可调用 `runner.onSettled(event)` 记 Stop/收尾；该方法实际使用 `settle(event, false)`（runner:366），**不得调用评估入口或伪造 subscribe**。唯有真实 session subscribe 才能触发已有 one-shot 评估；其他队列是否安全仍由 `otherRoot` 门证明。

## 3. 总体设计

### 3.1 装配边界与依赖方向

新增一个窄装配文件 `src/todo/idle-recovery-wire.ts`（拟新增）。它只做宿主翻译、生命周期及探针组合；Host/Runner/Store 保持既有算法。新增文件的必要性是避免把所有 busy 源、身份守卫和 hook 业务堆入 assembly-only 的 `src/index.ts`，也避免让 TODO Task 工具依赖整个 Stack。

```text
activate（HOST_KEY 主会话 guard + 兼容检查之后）
  ├─ 原 wireTodo：工具/nudge/restore，不承担恢复自启
  ├─ idle-recovery-wire：仅开关 on 时注册转发 hooks
  │    ├─ 可信 TUI input / Web admitted chat → Host → Store
  │    ├─ BAS/context/extension settled → Runner（不在 hook 排恢复）
  │    └─ SDK-owned root port → 真正 AgentSession.subscribe → Runner
  └─ buildSessionStack
       ├─ query/spawn/workflow/jobs/notifier/goal/fabric/schedule
       └─ session-owned recovery group
            ├─ Store（全树账本）
            ├─ Host（完整 TODO + 同步只读探针）
            └─ Runner（唯一订阅、immediate、deadline/grace）

web commands / schedule / fabric 只暴露局部只读口或真实 admission 观察者
                              ↓
                      recovery-wire 组合
```

注册位置：post-guard，且在 mention/topic-switch 等可能 handled 输入的 hook 之前，参考现有 `src/index.ts:900-917` 的 wake-input 次序；不得为了恢复移动 secure 的前置守卫。只有真实送达该 input observer 的 `mode=tui && source=interactive` 事件能开窗。未经过公开 input 回调的 slash/idle ESC 不猜作 arrival。

创建位置：`buildSessionStack` 已建完 query/workflow/goal/schedule/fabric 后、返回前（当前 `src/stack.ts:2450-2519`），调用 activation-local wiring 的 open 方法。创建时即写入本 build 的 parts，订阅必须最后安装。Web/goalHook/scheduleSurface 等 activation 级对象用明确传入的 getter；getter 未 ready 就 unknown，不能用 `?? false` 抹掉缺口。

`src/index.ts:978-991` 仍按现有顺序发布 stack、reconcile、启动 schedule；这些启动过程未完成前 recovery 不获 clear。不调整原通知/调度策略。

### 3.2 生命周期与唯一性

1. **activate**：每次激活创建一个 wiring 闭包；只在取得 `HOST_KEY` 的主会话构造。`src/index.ts:319-321,397-399` 的 claim/identity release 保持原样。重复 activation/child 在 guard 返回，不能取得第二个 runner。开关 off 不调用 wiring 工厂、不加 recovery hooks。
2. **session_start**：旧 stack 先按 defensive / rebuild-handoff 清理；新 group 固定 sid、逻辑 owner=`root`、独立 incarnation 对象。`owner` 不是每 reload 随机变更的任务 owner；随机 token 已由 Runner 管理。incarnation 仅在宿主边界拒绝旧回调。
3. **ready**：完整 TODO restore 已完成、全树账本可读、宿主能力已认证、所有同步探针可用。此时最多一只 runner 订阅。ready 不开窗、不补发；仍等可信 arrival 和之后的非 aborted settled。
4. **reload/new/resume/fork/shutdown**：宿主必须先阻止新自动 admission，并保证 abort-and-settle-before-replacement。group 关闭 admission 后，在身份仍精确指向旧 session 时先 `runner.dispose()`，再 `host.dispose()`、`store.dispose()`，最后撤销 incarnation/清理局部 observer。这样 runner 可以识别并 abort 自己的 bound run，但不会 abort unknown claim 或新 session。不能先清 identity 再期待 dispose abort 旧运行。
5. **tree**：`src/index.ts:364-375` 明确 tree 不重建 Stack。拟在 wiring 的 `session_before_tree` 同步前缀关闭该 group 的执行权，取消 immediate/订阅/期限；`session_tree` 只标记 TODO restore 完成，不直接发起恢复。为不引入新的可重开窗口机制，**本步采用保守策略：tree 后本 group 保持关闭，下一次完整 session_start 重建才可重新具备能力，且仍需新 arrival**。tree 被取消也不自动复活旧 runner。这个可用性取舍须在启用说明中披露，不把树操作当真人重授权。
6. **compaction**：复用宿主 admission fence；压缩未完成、旧快照失效时 busy/unknown。不重置 Store、Stop、seen；完成只恢复探针读能力，不主动调度。未知的自主 pre-start compaction 组合不认证。
7. **构建失败**：open 内部创建失败就关闭已创建部分；parts 在返回前已可达。`index.ts` build catch 同样关闭本次 activation 的待建 group（不可清理其他 incarnation）。之后 late subscribe/input/async completion 一律因 owner 失效而拒绝。

关闭必须同步幂等，不等待模型、不新增 shutdown 等待预算。若宿主不能保证已经发出的 deferred custom 不跨替换执行，该宿主不认证；仅 dispose timer 并不能解决 SDK 待发消息。

### 3.3 teardown step 列表：必要的最小例外，需评审放行

本设计**不建议偷挂**到已有 goal/memory/xs 的 dispose：

- goalHook 的 step 只在 C 路（`src/stack-teardown.ts:269`），覆盖不了 A/B。
- memoryScopes/Fast/xs 均是独立开关和独立 owner，recovery 不能依赖它们开启。
- 只在 index 的 shutdown handler 清理，漏掉 `runRebuildHandoff(previousParts)`（`src/stack.ts:597`）和部分构建异常；另造 module/global cleanup 又违反 I4。
- 改 Stack.dispose 外层偷偷 pre-dispose 虽然不改数组，却破坏“有序 step 列表是唯一真相”的约定。

因此申请一个**论证后的最小例外**：在 `TeardownParts`/`Stack` 添加可选 recovery group，并在 A/B/C 三列表各添加一条 `idleRecovery`，紧随现有 `memoryScopes`，早于任何 xs、通知、goal、schedule、run drain。所有既有 step 相对顺序、sync/async 属性和 C1/C2/C3 独立 handler 均不改。`idleRecovery` 只调用同步幂等 group.dispose，不改 I1 budget。

这是必须由评审明确放行的结构变更，本文没有实施。若不允许增加该独立 step，则本步仅交付适配设计/关闭态接线，**不通过借用其他 step 实现生产启用**。验收扩展 `tests/integration/stack-teardown-matrix.test.ts`，验证三路、C→A、部分 build、旧实例晚 dispose；不得为新功能删除旧顺序断言。

### 3.4 时钟

继续使用 `systemClock`（`src/core/clock.ts:103-116`）和 Runner 的 `setImmediate().unref()`（`idle-recovery-runner.ts:71-74`）。900,000/10,000 ms 仍通过 `clampSpanMs`；不要另加轮询、idle countdown、backoff 或 TTL timer。新增探针的 ready/busy 为同步状态投影，不需要 timer。订阅 off/dispose 后必须移除 listener；所有晚回调先查 incarnation。

## 4. 接口契约与真实探针

### 4.1 既有契约直接复用

Host 使用 `IdleRecoveryHostDeps`（host:40-56），Runner 使用 `IdleRecoveryRunnerDeps`（runner:29-47），Store 使用 `IdleRecoveryStoreDeps`（store:104-118）。`RecoveryBusy` 只有 `clear | busy | unknown`，禁止 undefined 被默认转换为 clear。

- `getEntries`：真实 `ctx.sessionManager.getEntries()`，**全树**，不能 `getBranch()`。每次调用先检查绑定 sid/incarnation；读失败闭锁。
- `appendCustomEntry`：可用 `pi.appendEntry(type,data)`；SDK `dist/core/agent-session.js:2801-2802` 同步转到 `sessionManager.appendCustomEntry`。wrapper 在写前验证固定 sid/owner；异常原样交 Store 处理，不能 swallow 成成功。正常 append 不承诺 fsync。
- `sendMessage`：传原 `RecoveryCheckMessage` 与 `{triggerTurn:true}` 给 `pi.sendMessage`；不转 `sendUserMessage`，不改 customType，不登记新模型授权。
- `abort`：只交给 Runner 的既有所有权判断调用；宿主 wrapper 也检查当前精确身份，不能经 holder 找到“当前任意会话”再 abort。
- `readTodo`：`todoWiring.getTodoSnapshot()`；任何 restore 未完成/队列未认证则 undefined。工具的序列化位于 `src/todo/index.ts:400-415`，读取快照不等于证明仍有未完成写入时也安全；正常 SDK settle 要覆盖工具执行，额外外部 Task 调用须纳入 otherRoot。

### 4.2 拟新增的 wiring 与局部只读口

以下是**项目内部待实现契约**，非 SDK API：

```text
IdleRecoveryWiring.open(input: {
  stack: Stack;
  ctx: ExtensionContext;
  incarnation: object;
  rootPort?: RecoveryRootPort;
}): RecoveryGroup | undefined

RecoveryGroup:
  dispose(): void                  // 同步、幂等、只关本实例
  beforeTree(): void               // 本步永久关闭该 group；不补发
  readStatus(): {
    configured: boolean;
    effective: boolean;
    reason?: string;
    phase?: RecoveryRunnerPhase;
  }                               // 本地只读诊断，不上 wire

RecoveryRootPort:
  subscribeSession: NonNullable<IdleRecoveryRunnerDeps["subscribeSession"]>
  readAdmission(): RecoveryBusy    // 同步、精确当前 session、完整宿主 admission 视图
```

`rootPort` 只能由 SDK owner 实际能力注入；不存在时不造默认 port。正式生产交付该 port 的载体尚待 §6.5 裁定，不能把上述类型名写成 `ctx.rootPort` 并声称已实现。

`readAdmission` 必须覆盖：正在执行或排队的非恢复 root action、deferred input/custom、异步 input/command、树/切换/reload、UI prompt、topic-switch 以及未被显式认证的扩展。若存在无法观测的第三方队列，直接 unknown；设置 `enabled=true` 不是证明。它不包含本 recovery 自己的 token 占用，避免 BAS/context 自阻塞；这不是对“同 customType”任意放行，自己 token 的判断仍在 Runner。

局部增量口统一同步返回 `RecoveryBusy`，不改变原执行顺序，不创建队列。跨子系统可用结构型字符串联合以免 schedule/fabric 反向依赖 todo 实现：

```text
CommandLedger.recoveryPending(sessionId: string): RecoveryBusy
CommandHandler.recoveryBusy(): RecoveryBusy
CommandHandler.takeAcceptedRecoveryCommand(cmdId: string): "fresh" | "replay" | "unknown"
WebHubControl.recoveryBusy?(): RecoveryBusy

MessageScheduler.recoveryBusy(): RecoveryBusy
MessageSchedulerInstall.recoveryBusy(agent?: ScheduleAgent): RecoveryBusy
SessionClock.recoveryBusy(): RecoveryBusy
ScheduleNotes.recoveryBusy(): RecoveryBusy
ScheduleDigest.recoveryBusy(): RecoveryBusy
ScheduleSurface.recoveryBusy(): RecoveryBusy
RootBudgetPort.recoveryBusy(): RecoveryBusy
```

这些新增 getter 在 off 时不得被调用，observer 不注入；不得为了暴露它们改变已有 wire/status schema。必要的 async-work 计数必须在入队的同步前缀增加，在 finally 减少，初始化失败/未知失败保持 unknown，不能用 Promise 已创建推断工作结束。不要新增通用 root 调度器、通用 event bus 或跨会话预算。

### 4.3 逐项真实探针、翻译和缺口

#### SDK

读取 `ctx.isIdle()`、`ctx.hasPendingMessages()`，真实 API 见 SDK `extensions/types.d.ts:254-263`。`mode` 读公开 ctx，生产仅认证主会话的 TUI 与可信 Web 控制的 RPC；print/json/child 此步不启用。缺方法、抛错、非 boolean 或过期 ctx ⇒ unknown。即使均符合也只是 SDK 子门，不代表 root 所有队列为空。

#### query

入口：`src/service/query-service.ts:26,117` 的 `stack.query.list()`。必须同时读 `stack.spawn.runningIds()`，复用 `countActiveRuns`（`src/reload/defer.ts:29-55`）；真实组合先例在 `src/index.ts:383-394`。只读 registry 会漏“已准入但未落首 snapshot”的 resume。两者联合非终态数大于零 ⇒ busy；未知 status 不能当终态。未建 stack/任一读失败 ⇒ unknown。全部同步，无缓存。

#### workflow

入口：`stack.workflow.activity.list()`，装配于 `src/stack.ts:2397-2400`；定义与实现 `src/workflow/activity.ts:208-214,600-606`。非空 ⇒ busy。不得使用 `listForDisplay()`，它混入 terminal linger；也不得只看子 agent 数，因为 workflow 两个 child 间仍可运行。同步，无缓存；registry 尚未装好 ⇒ unknown。

#### jobs

入口：`stack.bashJobs.backgroundJobCount()`（`src/bash/manager.ts:2285-2291`），必要时 `list()`（manager:365,2318）。前者只计当前 host 已后台化 running，**不证明启动恢复已结束**。真实恢复异步入口为 `scheduleBashJobRecovery`（`src/bash/host.ts:221-269`），当前仅返回 dispose。

新增最小 readiness 投影由 stack 的 runRecovery/runCleanup wrapper 在同步前缀置 busy，两个阶段成功结束才 ready；超时、失败、不确定 adoption ⇒ unknown，不能在 catch 后一律 clear。ready 后当前 manager 的 running/staged 等未决本会话记录也阻止恢复；有未识别 status ⇒ unknown。后台完成通知另由 notifier 门保护。bash feature 经实际 `bashJobsEnabled(settings)` 明确禁用且无遗留恢复工作才可给 clear，不能因 manager 缺席给 clear。同步内存读取，不缓存盘上 PID 猜测。

#### notifier

入口：`stack.notifier.stats`（`src/delivery/notifier.ts:41-59,392-405`）。`staged + pending + batched > 0` ⇒ busy，覆盖 coalescer、ackHold、retry 的未投递记录；delivered/consumed 不算待投递。读取 `degraded` 有不确定投递/恢复问题时保守 unknown，不把内存空统计当恢复完成。必须在 `notifier.reconcile()`（index:981）完成后才 ready。同步，无缓存，不修改 notifier 生命周期。

#### web

已有 `WebHubControl.webExecBusy()` 只有 resumeExec/execGate（`src/web-hub/agent/index.ts:2499`），**不够**。

真实数据入口：

- `CommandLedger` 双轨：`src/web-hub/agent/ledger.ts:10-17,55-80,96-161`。HTTP state=ok 不代表 prompt 已 consumed。
- handler 的 `pendingObservation`：`commands.ts:263,692-703`。
- `QueueMirror.items()`：`queue-mirror.ts:57-88`；getter 是观察，不调用 `clearIfEmpty` 改队列。
- hold：`hold-driver.ts:85-110` 的 `heldCount()/inflightCmdId()/phase()`。
- promptGate/topic-switch 和 switchInFlight：`commands.ts:98-128`；Web exec/switch 门仍叠加。

拟在 ledger 内添加 `recoveryPending(sid)`，扫描**未截断的真实 bag**，非 `frame()`（`ledger.ts:159,169` 的 ctl 最多 32 条）。本 sid 的 running command，以及 prompt 的 dispatched/observed/started/queued/held ⇒ busy；unconfirmed、缺 sid/owner 的未决旧条目 ⇒ unknown；consumed/dropped/recalled/returned 且无未决 effect 才是终态。表容量/TTL 丢弃不能成为“未知投递已经完成”的证据；发生不能证明的丢失时，本 activation 的 Web recovery 能力保持 unknown。

handler 汇总 ledger、pendingObservation、queue、hold、promptGate 与执行 fence；未初始化/方法缺席/错误 ⇒ unknown。Web 明确从未启用且没有旧 activation 遗留证据才 clear；“连接断开”不等于无工作。完整 observer 缺失时 Web-enabled 组合不认证。

#### scheduleMemory

入口：`MessageScheduler.status()/diagnostics()`（`src/schedule/agent/dispatch.ts:195-230,258-267,1519-1541`），installer 入口 `src/schedule/agent/message.ts:211-225`。读取 queued/inflight/stuck/uiPrompts/fence；队列、flight、开放 fence/UI、dispatch、stuck 任一存在 ⇒ busy。

缺口：现有 diagnostics 不含 `work.size`（dispatch:543-544,1538-1541），不能以 `queued=0 && inflight=undefined` 判 clear。新增 recoveryBusy 必须包含 work；Promise 工作只读计数，不调用 `idle()` 等待。

还需折入 schedule 的异步先占用空档：

- clock 的串行 chain/初始化/claim/retry：`agent/clock.ts:114-145,351-371,426-464`，目前 status 将未初始化 lastRev=-1 压成 0，不可据此猜 ready。
- notes 的串行工作：`agent/note.ts:66-98,256-290`。
- digest 的串行工作/待验发送：`agent/digest.ts:142-153,279-286`，surface 在 `agent/surface.ts:50-73,101-112` 持有它。
- surface.start 未完成、executor 写账本/启动中的状态同样阻止 clear。定期健康 poll、未来 fire timer、无待处理 note 的 quiet timer 本身不永久占用；实际异步链未完成或 due/retry 工作才占用。

局部 busy getter 没有补齐前，schedule enabled 的此门保持 unknown；不得把现有 status 当完整证据。明确 disabled 且不存在遗留 scheduled action 才 clear。

#### schedulePersistent

**真实 readState 是同步函数，不是 Promise。** `ScheduleAgent.readState(): SessionStateRead` 定义及实现见 `src/schedule/agent/wire.ts:160-197,521-533`。读取经验证的全账本，不读 UI 投影：

- `runs` 中任一 `!isTerminalRunState(run.state)`；判定函数 `src/schedule/core/spec.ts:454-455`，只对通过 reader 校验的状态使用。
- `run.note` 为 pending/unverified（spec:205,219-242）。
- `pendingReports.length > 0` 或 `digest.inflight`（spec:273-295）。
- 真实 clock.status 的 `degraded` / `nextAt`（`agent/clock.ts:85-105,448-450`）。nextAt 已到期 ⇒ busy；未来排期不单独阻止恢复。

`kind=degraded` ⇒ unknown；`kind=absent` 仅在明确定义的无任务、初始化完成、无在途 writer/admission 时可 clear。clock rev 与本次新读 ledger.rev 不一致 ⇒ unknown，等待原 schedule 自行 reconcile，恢复模块不主动 poke/写账本。`nextAt=undefined` 只有在确认 clock 已初始化、无 due/supplemental/retry 工作时才归一成 helper 的 null。

同一 session 允许外部进程修改 schedule 时，单次同步读仍有跨进程 TOCTOU；TTL 无法修复它。没有 writer 排他/宿主 fence 的组合不认证，返回 unknown。初始灰度可以关闭 schedule，不强行扩大 schedule 的锁协议。

#### otherRoot

至少同步读取：`stack.xs?.controller?.busy`、`stack.rootWakeRecovery?.busy`（getter `src/fabric/root-wake.ts:412-414`），已有 xs fence 的 compaction/tree/switch/webExec/topicSwitch，以及 deferred reload `isReloadPending`（`src/index.ts:333-334`）。功能不存在只有被明确判定为 disabled 才是 clear。

**#61 不等同于上述两个 controller。** 实际 in-tree root 准入在 `src/fabric/stack.ts:189-205`，rootPlans 持有已准入/待投递计划（115-129），送达后才释放 reservation（321-327）。`RootBudgetPort.snapshot()`（41-44）只有 sessionId/window/used/dedupCount（`root-wake-budget.ts:4-9`），没有 pending，不能用额度统计推 busy。

新增 `RootBudgetPort.recoveryBusy()` 应由 fabric stack 组合 rootPlans 及 budget 的 pending reservation。pending 的真实所有者在 `root-wake-budget.ts:63,121-161`；必要时只给预算对象增加只读 pending getter，再由 stack 暴露。pending 或 root 目标尚未解决的计划 ⇒ busy；terminal cleanup 的未知 ⇒ unknown；**不要清 reservation 来给 TODO 腾位置**。

最后与 `RecoveryRootPort.readAdmission()` 合并。这个完整宿主证明目前不存在于普通插件；即使所有 toolkit reader 都 clear，隐藏 deferred/第三方队列仍可使 otherRoot=unknown。xs 的宽松 capability/乐观 dispatch 策略不能复用为 TODO 的 clear 证明。

#### goal

真实入口：`goalHook.goalBusy()`（`src/goal/hook.ts:392-399`）与 `stack.goal.record?.state`，stack 初始化 `src/stack.ts:2190-2197`。前者含 evalInFlight，却不阻止 paused；所以必须两者合并。

注意真实 `GoalPhase` 是 `none | active | paused | stopped`（`src/goal/state.ts:18`），而 `recoveryGoalBusy` helper（host:79-84）接受 null/completed/aborted 作为空闲值。**不能直接传真实 stopped**。adapter 精确归一：已初始化 record 缺席/none/stopped → null；active/paused 保留；evaluating=`goalHook.goalBusy()`；未知状态/未初始化/缺读取口 → undefined。goal paused 即使没有模型运行也 busy，恢复绝不替 `/goal resume`。

### 4.4 同步读取与缓存 TTL

本设计**不缓存 clear 结论**，clear 的 TTL 为 **0：仅当前同步判定有效**。Runner 在 subscribe、immediate、reserve 后、send 前、BAS/context 已有多次重读；每次都直接读取本实例真实源。

- query/workflow/jobs/notifier/web/goal/fabric 的内存 getter：同步读，不需要定时缓存。
- schedule readState：同步、受既有文件大小校验约束的盘读；一次 host snapshot 内可共享一次采样，但不得跨下一次 snapshot 复用 clear。
- 异步初始化/串行工作：需要的是同步的 owner-scoped `initializing/inflight/failed` 投影，不是“等 1 秒后假装 ready”。入队前置 busy，完成后按真实结果解锁；旧 generation 的完成不得解锁新实例。
- busy/unknown 可以保守保持到下一次实证更新；绝不因为过了 TTL 自动变 clear。无正确失效源的外部缓存一律不能授权发送。

因此本步不增加刷新轮询；若同步盘读成本不可接受，先维持 schedule-enabled 组合关闭，另案设计带 writer generation 的安全快照，而不是先用 1s/5s TTL 上线。

### 4.5 可信 arrival 与 Web Stop

TUI：在真实 `pi.on("input")` 回调调用 `host.onTuiInput(event,{sid,owner:"root",mode:ctx.mode})`，然后原样 continue；不能从 role/text、RPC JSON、工具参数、memory proof 或 BAS 反推。Host 自带 WeakSet 去重（host:167-173）。同一到达可各自重置 #61 与 #59 的独立预算，不共享消耗。

Web：新 observer 仅挂到 `commands.ts` 的真实 prompt admission：`handle` 已通过 controlEnabled（1355-1364），`beginOrReply` 必须为 new（328-355），再通过 ctx/session/text/security/compaction/switch 校验（371-444），在 mention/topic-switch/hold/native 分流之前通知一次。旧 held release（709 行后）不重走 producer；`queryOnly`、重复 cmdId、被拒请求、机器通道均不开窗。浏览器 chat 的可信来源由现有控制链证明；Feishu/thread/bot 先不作为新的可信 producer，除非后续单独认证。

`takeAcceptedRecoveryCommand` 的 fresh 只在这次同步已准入 callback 的局部 scope 有效：保存 `{cmdId,taken:false}`，调用 observer 时 Host 消耗一次，finally 清 scope；它不是历史 ID Set、不是用 ledger.get(id) 的存在性推 freshness。unknown/replay 不开窗。正常 native/hold 分支不因 observer 失败而改变准入结果；恢复失败只闭锁自己。

Web abort 在 `commands.ts:855-873` 的 begin/new 与 session 校验后、调用 ctx.abort 前，新增可选 observer 执行 `store.noteStop("aborted")` 并 `runner.handover()`；这是实际已准入 Stop，不要求本来 busy。失败不能导致预算恢复，重复 abort 不开新窗口。TUI idle ESC 没有同等事件，本步不实现。

## 5. 关键决策：并发、账本、守卫与回滚

### 5.1 并发优先级与线性化

优先级为：生命周期撤销/Stop → 真实人类到达及已准入输入 → 已有 `/goal`、#61 fabric、schedule 等 root 工作 → TODO 恢复。既有自动工作之间保持原策略，TODO 不给它们重新排序。

这里的优先级指**恢复只在其他工作没有被准入时才尝试**，不是抢占已经启动的模型回合，也不是强行令同一 tick 中未来事件逆时间插队。

1. 真实 subscribe 收到非 aborted settled：若全 clear 且窗口可用，只排一只 unref immediate。
2. 用户/goal/fabric/schedule 在 immediate 前先到：其 admission 同步置门；回调重读后取消。用户 arrival 先 handover 撤旧 deadline，再写新窗口（host:114-137）。
3. immediate 中再次同步验证 identity/window/candidates/busy，然后 `prepare → reserve`。**reserve 是扣账点**（runner:250-257），不是 send 成功、BAS 或模型开始。
4. reserve/append 重入后 generation 或门变化：该次账仍消费，commit unknown；不发送、不退款。最后 guard 到 send 无 await（runner:268-304）。
5. send 返回 void/抛错均 unknown；既有 token claim 和 BAS/context 是运行归属证据，不是送达回执。不能因无模型输出再发一遍。
6. 恢复已发后，用户或另一来源的 BAS 到达：Runner 对非本 custom trigger 只 handover、不 abort 外来 run（runner:367-410）。如果竞争导致自己的旧 check 才迟到，只能凭本实例 issued marker 拒绝它，不能 abort 同 customType 的外来标记。
7. schedule/fabric 在恢复启动后到达，走各自现有 busy/队列逻辑；恢复不得反向修改其配额、清空 pending 或“借一次 TODO 唤醒”处理未获准 fabric 消息。异步 hidden admission 未被门覆盖的组合不支持，不靠延时猜安全。

`/goal` active/paused 永远阻止新的 recovery attempt。用户输入仍最高优先，不能要求用户等恢复的 15 分钟；新可信到达撤销恢复自己的 abort 权，绝不让旧 timer 杀用户接手的回合。

### 5.2 reload 与账本

`idle-recovery-store.ts:16-29,161-187` 的合同不变：

- 同 sid 全树 fold 恢复 attempts/seen/Stop/unresolved；`open=false`，不恢复 live window、不重发未决 attempt。
- 新 sid（new/fork/switch）不继承旧 sid 的尝试权，必须等新 session 真人到达。
- 新 arrival 可以开新额度窗口，但旧 `(sid,fingerprint,progressKey)` 的 seen 不清；256 满或 persist-uncertain latch 不被新 arrival 绕过。
- 读回缩短、坏记录、append 不确定闭锁，不清日志、不修写历史账本。
- Runner 读 supervision，旧 claim 非 settled/handed 则 `old-supervision-unresolved`（runner:329-346），不是恢复旧定时器。普通用户输入不会自动修复该持久化不确定性；不要因“有新窗口”重建 runner 绕过此门。
- 不承诺崩溃掉电 fsync、不做跨进程统一配额。正常 reload 在相同 session 全树账本上不赠重试。

### 5.3 守卫钉子 584b929d 的更新方式

保留 `tests/todo/idle-recovery-production.test.ts`，不是删掉或把 expect(send).toBe(0) 改为任意值。

现测试在 49 行只调用 wireTodo，63-64 行断言两工厂未调用。设计将 recovery 放在生产 post-guard/stack，因此这个旧测试**可能不会自然变红**——这是它只覆盖工具局部拓扑的局限，不能拿继续绿当接线成功。

必须在接线提交前把该文件提升为**真正生产组合测试**（activate + buildSessionStack 或同一生产 wiring 工厂及真实局部 adapter），保留原 case 作为 `wireTodo alone remains inert`。新增一条接线正例先在未接线基线上确认 red：

- 配置 on、认证 SDK owner、真实 admitted arrival、完整探针 clear、一个合法 in_progress；断言生产路径创建恰好一个 Host/Runner、一次真实 subscribe，非 aborted public settled 后恰好一次 marker send/attempt append。
- mutation/红灯证明：删掉生产 wiring 调用，或把 subscribe 换成只有 extension hook，正例必须失败。不能只把 mock 工厂手工调用补成绿。

原“不得自启”升级为以下**正向安全断言**：

1. 配置 off：没有 recovery 工厂、hook、entry、send、timer；旧工具/nudge 行为不变。
2. 配置 on 但真实 subscribe 缺失：有效状态 off，原 `root-session-subscription-unavailable` 核心断言保留。
3. 接线已存在但没有真人 live window、任一 busy/unknown、goal paused、Stop、预算/seen 满：零 send/零 attempt；不能以“未创建工厂”蒙混。
4. 只调用 extension agent_settled：即使门全 clear 也零 send；真实 subscribe 才允许评估。
5. 所有门满足只发一次；重复 activation/session_start 后不产生双订阅/双计费。

用户所说“必须变红”以新增真实拓扑正例的 red→green 和 mutation 证据落实；不谎称移动装配后原局部断言天然会失败。A 类 frozen fixtures 不重生；activation trace 若新增注册需单独声明并按治理流程更新，不能为消除红灯批量刷新。

### 5.4 开关、I9、灰度与回滚

新设置键：`todo.idleRecovery.enabled`，boolean，**默认 true**，非 live，需要 `/reload`；依赖 `todo.enabled`、主会话、plain/unlocked、认证宿主能力。与 `todo.nudge.enabled` 独立；nudge 仍 `triggerTurn:false`。

实现落点为 `src/todo/settings.ts:25-30,53-62,93-97` 与 `src/todo/setting-specs.ts:9-43`，按现有深拷贝默认/字段级解析模式追加。非法/缺失值回默认 true，但不能绕过能力门。900,000/10,000 ms、2 次、256 上限本步不变成配置项。

关闭态 I9 要求：从关闭态启动时，恢复工厂/订阅/hook/观察者/诊断输出/消息/写盘均为零增量，现有提示、Task 工具、wire 内容字节等价。设置目录可以声明式增加新键，这是新增配置表面，不应伪称设置列表字节不变；业务 off-parity 必须单列测。禁用能力不默默新增 UI badge 或每轮 warning。

灰度顺序：

1. 合入关闭态装配与 probe 测试，普通 CLI 仍 effective-off；明确诊断原因，不宣称已发布自动恢复。
2. SDK-owned 受控宿主：固定扩展集合、全入口可观测、无未认证 deferred action、禁用未补齐探针的 Web/schedule/第三方组合；真实时钟验收。
3. Web/schedule/#61 混合组合逐个通过全拓扑 conformance 才加入认证范围。认证范围必须来自宿主代码/测试，不新增用户可填的“我保证安全”设置。
4. 普通 CLI 只有上游公开能力交付并验证后才能成为支持目标；默认 true 不等于提前扩大认证范围。

回滚：先停止当前自动检查（已有 Stop/abort 语义），设置 false，再通过已认证的 abort-and-settle-before-replacement reload 路径关闭。保留账本，不删 seen/Stop/supervision。回退旧版本不会重播日志，因为旧版无生产 wiring。

**关闭不能抹掉已发 deferred custom**：真实反例在 conformance:341-484。若当前会话已经有无法清除的 unknown marker，不得把“设置 false + 任意 reload”宣传为安全撤回；应关闭该 SDK session 的宿主实例、确认运行结束再重新打开，旧版不自动执行日志消息。生产准入必须在发送前就排除此组合，不能靠增设 off-mode orphan hook 悄悄违反 I9。

## 6. 实施要点、验收与风险

### 6.1 建议实施顺序

1. 先裁定 SDK-owner 公开能力来源和 teardown 最小例外；未裁定不启用。
2. 加生产组合 red test、off parity、busy 缺口测试，不动候选/预算算法。
3. 先补局部只读 reader、实际 admission observer；未完整覆盖的组合保持 unknown。
4. 加 activation-local wiring / per-stack group / 最小 teardown step；集中装配，不向 index 塞判断业务。
5. 在认证 SDK-owned 宿主跑真实 session + 完整生产 adapter 的集成，不允许 Object.fromEntries(all clear) 替代 probe。
6. 跑真实时钟验证，再由最终验收评估能否扩大灰度。更新对应 README 的现状与认证边界，下游实施时做；本次只写本文。

### 6.2 仿真时钟验收矩阵

使用现有 `Clock` 注入及可控 immediate；以下是计划，不是本次已运行结果。

- **候选**：合法 in_progress 可选；pending/归档/依赖未完成/环/metadata.disabled/waiting/非法 progressKey 不可选；Task 文本与 metadata 不开窗。
- **预算**：一个 arrival 下变换 3 组合法进度，最多 2 次；同一组即使新 arrival 也不再试；seen 达 256 时新组被拒，不能 LRU 淘汰赠额。
- **扣账顺序**：append attempt 在 send 前；append 抛错零 send 且闭锁；send 抛错/返回 void 均占额；reserve/claim 回调重入只扣一次，不退款。
- **Stop**：aborted=true 锁定；重复 settled、后台完成、时间推进、Task 操作、reload/tree 不解；新可信 TUI/Web arrival 可开新窗口，RPC/机器/重放/held release 不可。
- **每个门**：对九源逐个注入 busy、unknown、缺口、throw，断言无发送；query 加“仅 spawn.runningIds 可见”；goal 加 paused/stopped 归一；Web 加第 33 条未决 ledger；schedule 加 work/clock chain/digest pending。
- **竞态**：在 subscribe→immediate、prepare→reserve、reserve→send、send→BAS、BAS→context 各边界分别插入用户/#61/goal/schedule/tree/reload；确保取消或 handover，不 abort 外来 run、不重发 unknown。
- **期限**：899,999 ms 不 abort；900,000 ms 精确只 abort 本 bound serial 一次；10,000 ms 宽限无 settled ⇒ stuck；unknown 到期 tombstone 不 abort；用户交接后推进旧 deadline 不影响用户。
- **生命周期**：三路 teardown、C→A、同 sid reload、新 sid fork、半构建失败、重复 activation、晚回调；listener/所有 timer 归零，旧 dispose 不伤新 owner。
- **账本**：真实 getEntries 全树模拟 tree rollback，预算不减少；same-sid 重建 open=false；未提交 reservation unresolved；账本收缩/损坏 fail-closed；旧 supervision 不重建 live deadline。
- **I9/I5**：关闭无注册/消息/entry 差异；真实 timer 和 immediate 均 unref，非交互退出不被保持；新增测试按 `tests/tiers.ts` 登记。

### 6.3 真实时钟端到端

必须使用真实 SDK 1.5.0、完整生产 wiring 与局部探针、实际 session 文件、真实 `systemClock`/immediate。可用本地 scripted provider 使响应可控，不能以它代替真实事件源。普通 CLI 的缺能力负例也应保留。下述时长为验收窗口，不是新增产品参数。

**快速 E2E（约 2 分钟）**：

1. 创建一个原授权 in_progress 任务，不发送合格真人输入，等待 30 秒：零检查。由真实用户 arrival 开窗，在实际输入回合尚运行时再等 10 秒：零额外检查。
2. 安排一个实际后台 job 或受控 workflow，使 root settled 时 busy；等待 30 秒：仍零检查。它完成后仅有后台通知不保证立即重评，不新增轮询。
3. 用一个真实已授权工作回合产生新的 public settled，确保九门及 SDK 全 clear。**不是空闲 15 分钟后醒来**：正常事件循环下应在该 settled 后下一次 immediate 复核时发送；验收 watchdog 5 秒内观测恰好一个 `subagent:todo-idle-recovery-check`，耗时不作为硬实时承诺。
4. 模型看到“自动检查 / 原授权范围 / 1/2”，先核对授权/依赖/人工闸门，只完成明确获准工作并验证后 TaskUpdate；若等人/外部/定时则说明等待并停止。检查本身不能批准计划、提交、发布。
5. 保持同 fingerprint/progressKey，再观察 30 秒和额外 settled：零第二次同组检查。发送 Stop，再进真实用户到达，核对只改变对应窗口，不清 seen。

**真实期限 E2E（约 15 分 15 秒，发布前至少一次）**：

- 绑定一轮可阻塞但可 abort 的检查，用真实计时记录 reservation/send/BAS/abort/settled 时间。
- 从 attemptAt 开始前 15 分钟不触发该期限 abort；到 900 秒后的事件循环调度允许小幅延迟，但不得提前、不得在 BAS 重起 15 分钟。
- 若 abort 后真实 settled 到达，立即取消宽限；另一个故障用例故意不 settle，约 910 秒进入 stuck。测试 watchdog 例如 930 秒，超时算失败，不能无限等待。
- 一次独立用例在中途真实用户接手，等到旧 deadline 后确认没有 abort 用户运行。

仅快速 E2E 通过不能声称“真实时钟期限已验收”；现有 conformance:578 使用 FakeClock，必须明确区分。真实时钟测试归 tier2/人工 release gate，避免塞入每日 tier1 的 15 分钟等待。

### 6.4 #61 互不替代与真实组合验收

#61 是显式 child report 的唤醒准入；#59 是既有 TODO 的自查。两者有独立窗口/seen/扣费，不共享 permit，也不互相借额度。

组合必须覆盖：

- #61 已 reserved、尚未 send/送达：TODO otherRoot busy，零 attempt。
- #61 已降级 deliver-only：TODO 不因“有未处理消息”自动补 wake，也不修改其降级原因。
- TODO 已发后收到显式报告：fabric 按现有 busy 策略处理，不能再启动并发 root；TODO 不吞掉报告。
- `/goal` paused 与活跃 eval、schedule due/queued/notes/digest 同时存在：各自读口确实阻止 TODO，而不是测试硬填 busy。
- 用户与多个自动源同 tick 到达：用可控制 admission 的真实 host 测两种事件顺序，不承诺重排未来输入；没有跨 owner abort/重复预算。

若发现 #61 的 admission 问题，单独修 #61；不得放宽 TODO 门或让 TODO 检查循环充当消息补投递机制。

### 6.5 需评审裁定的问题与放行前置

1. **SDK root 能力来源**：当前 ExtensionAPI/Context 无 session。是否先推动上游公开具备真实 subscribe、完整 admission 可见性、替换安全性的 host port？这是生产启用前置，不是可用代码的最后一行 TODO。
2. **teardown 最小例外**：是否批准 §3.3 三数组各增独立 idleRecovery step？若不批准，只允许关闭态适配，不偷挂别的 owner。
3. **只读口窄解冻范围**：历史 plan:145 仅列 commands/index/dispatch/message；本次发现 ledger 全量 reader、#61 rootPlans/pending、clock/notes/digest/surface 的缺口，必须评审扩大这些只读观察口的范围，或者首批认证组合关闭相应功能。不得照抄历史清单声称完整。
4. **认证组合**：含任意第三方扩展、异步 input、SDK deferred custom/reload、跨进程同 sid schedule writer 的普通环境，目前无完整证明。批准前保持 unknown；不能把 tests 里 all-clear stub 当认证。
5. **tree 可用性取舍**：本步 tree 后该 group 关闭到下一完整 session_start，避免新建执行窗口/重放 live 权利。若要求 tree 后无需 reload 即恢复，需另审明确的 owner 轮换和不确定账本继承合同，不顺手改 B1/B2。

默认值 true 已有历史用户裁定，不列为待重新选择项。需要用户拍板的事项由主会话按项目规则用 ask_user 汇总处理；本文仅记录技术阻塞与推荐，不擅自扩大实现范围。

### 6.6 风险与不做项

- 不做 idle TUI ESC 捕获、跨会话 TODO 扫描/恢复、自动批准/提交/发布、后台轮询自激链、第三种预算。
- 不改 #61 准入/降级策略，不把任何 recovery message 当真人输入，不复用 memory 强消费 proof 替代到达。
- 不读取 SDK 私有 `_deferredSettledActions`/`_isEmittingAgentSettled`，不 prototype patch，不给 sessionManager 伪造 subscribe。
- 不承诺 send 前绝无任何 provider 调用：已有 conformance:490-535 证明 pre-start compaction 可先于 BAS；不得将 BAS 拒绝描述为“一定零 provider 成本”。
- 不因 busy 持续很久而超时解锁；宁可不恢复，也不抢用户。持续 unknown 是可诊断的能力缺失，不是要靠默认 clear 修复的 bug。
- 不把 settings off 解释成撤回已发送的消息；不能认证安全关闭的宿主不能获准发送。
- 不改变 runtime `subagent:*` 命名、不加协议帧/cap、不突破 secure 域。不把 plain-only 初始范围说成 secure 已支持。
- 不保证掉电持久化、任意跨进程互斥或 wall-clock 大幅跳变时的硬实时截止；沿用已有 Clock/runner 合同，相关更强要求另立项。

## 附录 A. 交接数据

以下 JSON 是同一 Markdown 内的交接载荷。`readFully=false` 表示只核验了所列片段；下游应按 evidence 定点复核，不能把“已读”理解成已测试。

```json
{
  "baseline": "caller-specified HEAD 1a1b18e4; no git command executed",
  "conclusion": "B1/B2 不重设计。新增 activation-local wiring 与 per-stack group，真实 AgentSession.subscribe 才能排评估；普通 SDK1.5 插件无该能力，当前生产仍 effective-off。全门同步 fail-closed，reserve 先计费，未知不退款。默认 enabled=true 沿用历史用户裁定，不等于认证宿主可用。",
  "document": "docs/dev/todo-idle-recovery/production-wiring-design.md",
  "implementationChanged": false,
  "testsRun": false,
  "fileIndex": [
    {
      "path": "docs/dev/todo-web/README.md",
      "role": "TODO 当前契约与未接生产声明",
      "readFully": true
    },
    {
      "path": "docs/dev/todo-idle-recovery/plan.md",
      "role": "历史默认 true、忙门与解冻范围裁定",
      "readFully": false,
      "lines": "1-24,65-90; grep 接口/阶段/解冻段 109-165"
    },
    {
      "path": "docs/dev/subagent-core/README.md",
      "role": "Stack 三路 teardown 与单一有序列表约定",
      "readFully": false,
      "lines": "Stack teardown 与后续 Fast/memory owner 章节（长输出被截断）"
    },
    {
      "path": "docs/dev/web-hub/README.md",
      "role": "Web/control-plane 边界",
      "readFully": false,
      "lines": "1-180"
    },
    {
      "path": "docs/dev/scheduled-reports/README.md",
      "role": "schedule off、模式、消息占用与持久账本合同",
      "readFully": true
    },
    {
      "path": "docs/dev/fabric-cross-session/README.md",
      "role": "#61 root admission、xs 与 off 不变式",
      "readFully": false,
      "lines": "1-150"
    },
    {
      "path": "docs/dev/bash-timeout-grace/README.md",
      "role": "job 恢复/认领与真实存活风险",
      "readFully": false,
      "lines": "1-72"
    },
    {
      "path": "docs/dev/data-encryption/README.md",
      "role": "secure domain/D8/写盘边界",
      "readFully": false,
      "lines": "1-60"
    },
    {
      "path": "src/todo/idle-recovery-host.ts",
      "role": "arrival、busy tri-state 与 goal/schedule helper",
      "readFully": true
    },
    {
      "path": "src/todo/idle-recovery-runner.ts",
      "role": "真实订阅、计费发送、所有权、期限与 dispose",
      "readFully": true
    },
    {
      "path": "src/todo/idle-recovery-store.ts",
      "role": "同步全树账本、恢复无 live window",
      "readFully": false,
      "lines": "1-255"
    },
    {
      "path": "src/todo/index.ts",
      "role": "完整 TODO getter、序列化和 restore 生命周期",
      "readFully": false,
      "lines": "1-210,400-475; grep 645-651"
    },
    {
      "path": "src/todo/settings.ts",
      "role": "设置解析与默认值落点",
      "readFully": true
    },
    {
      "path": "src/todo/setting-specs.ts",
      "role": "新增非 live 设置表面",
      "readFully": true
    },
    {
      "path": "src/index.ts",
      "role": "HOST_KEY、todo/goal/schedule/Web 装配、session 生命周期",
      "readFully": false,
      "lines": "1-340,350-400,570-622,735-753,894-1024,1190-1220; 其他 wiring grep"
    },
    {
      "path": "src/stack.ts",
      "role": "parts handoff、goal 初始化、真实 stack 口",
      "readFully": false,
      "lines": "585-613,2180-2205,2438-2519; workflow/schedule/rootWake 符号 grep"
    },
    {
      "path": "src/stack-teardown.ts",
      "role": "三数组与已有 owner 的清理范围",
      "readFully": false,
      "lines": "1-290"
    },
    {
      "path": "src/service/query-service.ts",
      "role": "query.list 只转 registry",
      "readFully": false,
      "lines": "grep 26,100,117"
    },
    {
      "path": "src/reload/defer.ts",
      "role": "准入 run 与 registry union",
      "readFully": false,
      "lines": "1-78"
    },
    {
      "path": "src/workflow/activity.ts",
      "role": "live list 与 display linger 区别",
      "readFully": false,
      "lines": "grep 208-214;590-610"
    },
    {
      "path": "src/delivery/notifier.ts",
      "role": "stats/degraded 同步接口",
      "readFully": false,
      "lines": "30-62,382-416"
    },
    {
      "path": "src/bash/manager.ts",
      "role": "backgroundJobCount 的范围限制",
      "readFully": false,
      "lines": "2280-2300; list/recovery grep"
    },
    {
      "path": "src/bash/host.ts",
      "role": "恢复和 cleanup 异步未完成空档",
      "readFully": false,
      "lines": "220-270"
    },
    {
      "path": "src/goal/hook.ts",
      "role": "goalBusy 含 evaluating 但不含 paused",
      "readFully": false,
      "lines": "385-405; 其他 goalBusy/evaluate grep"
    },
    {
      "path": "src/goal/state.ts",
      "role": "真实 GoalPhase 枚举",
      "readFully": false,
      "lines": "1-45"
    },
    {
      "path": "src/goal/store.ts",
      "role": "恢复 stopped/none 不继承",
      "readFully": false,
      "lines": "grep 38-65"
    },
    {
      "path": "src/web-hub/agent/commands.ts",
      "role": "真实 admission、abort、pendingObservation 与 held 分流",
      "readFully": false,
      "lines": "68-138,326-450,850-876,1345-1370; pending/hold/routing grep"
    },
    {
      "path": "src/web-hub/agent/ledger.ts",
      "role": "双轨账本、全量判空与展示截断风险",
      "readFully": false,
      "lines": "1-185"
    },
    {
      "path": "src/web-hub/agent/queue-mirror.ts",
      "role": "真实队列与延迟清空语义",
      "readFully": false,
      "lines": "25-94,160-192"
    },
    {
      "path": "src/web-hub/agent/hold-driver.ts",
      "role": "hold/inflight 公开只读口",
      "readFully": false,
      "lines": "85-123"
    },
    {
      "path": "src/web-hub/agent/index.ts",
      "role": "WebControl 透传与现有 webExecBusy 不完整",
      "readFully": false,
      "lines": "grep 571,1270-1507,1924-2057,2462-2499"
    },
    {
      "path": "src/web-hub/agent/hold-wire.ts",
      "role": "hold 接线的可选性",
      "readFully": false,
      "lines": "grep 37-83"
    },
    {
      "path": "src/schedule/agent/wire.ts",
      "role": "ScheduleAgent/readState 同步真实入口",
      "readFully": false,
      "lines": "153-200,505-545"
    },
    {
      "path": "src/schedule/agent/dispatch.ts",
      "role": "内存队列、诊断与未暴露 work",
      "readFully": false,
      "lines": "195-235,254-275,1510-1548; work/fence grep"
    },
    {
      "path": "src/schedule/agent/message.ts",
      "role": "installer 与结果落账",
      "readFully": false,
      "lines": "30-180,200-248"
    },
    {
      "path": "src/schedule/agent/clock.ts",
      "role": "nextAt/degraded 与未暴露初始化/串行工作",
      "readFully": false,
      "lines": "79-150,344-407,425-465"
    },
    {
      "path": "src/schedule/agent/note.ts",
      "role": "note 异步链、quiet、pending proof",
      "readFully": false,
      "lines": "65-145,255-310; pending/verify grep"
    },
    {
      "path": "src/schedule/agent/digest.ts",
      "role": "digest 异步链与 inflight",
      "readFully": false,
      "lines": "125-160,275-335; inflight grep"
    },
    {
      "path": "src/schedule/agent/surface.ts",
      "role": "startup 与持有 digest 的 activation closure",
      "readFully": false,
      "lines": "35-120"
    },
    {
      "path": "src/schedule/agent/bg.ts",
      "role": "后台 schedule 结果和等待相关入口定位",
      "readFully": false,
      "lines": "status/pending grep 30-57,217-239"
    },
    {
      "path": "src/schedule/core/spec.ts",
      "role": "runs/note/reports/digest 数据结构",
      "readFully": false,
      "lines": "175-242,270-299,448-464"
    },
    {
      "path": "src/schedule/core/reader.ts",
      "role": "经校验的 SessionStateRead 入口定位",
      "readFully": false,
      "lines": "grep 232-337"
    },
    {
      "path": "src/fabric/stack.ts",
      "role": "#61 真正的 admission/rootPlans 与释放点",
      "readFully": false,
      "lines": "30-52,100-145,175-235,300-335"
    },
    {
      "path": "src/fabric/root-wake-budget.ts",
      "role": "snapshot 没有 pending，预算独立",
      "readFully": false,
      "lines": "1-65,80-125,160-185; pending grep"
    },
    {
      "path": "src/fabric/root-wake.ts",
      "role": "xs/rootRecovery controller 的 busy",
      "readFully": false,
      "lines": "408-422; busy/pending grep"
    },
    {
      "path": "src/fabric/wake-input.ts",
      "role": "#61 arrival 入口定位，不复用为 #59 证据",
      "readFully": false,
      "lines": "grep 19-20,51"
    },
    {
      "path": "src/fabric/xs/stack.ts",
      "role": "xs 现有宽松 busy 读取不可作 recovery attestation",
      "readFully": false,
      "lines": "busy/status/pending grep 415,590,729-864"
    },
    {
      "path": "src/topic-switch/wire.ts",
      "role": "topic-switch 持有输入 fence 的位置",
      "readFully": false,
      "lines": "busy/pending grep 82-107,181-188"
    },
    {
      "path": "src/reflex/wire.ts",
      "role": "第三方/其他输入处理器不应假定无异步工作",
      "readFully": false,
      "lines": "pending/queue grep 132-678"
    },
    {
      "path": "src/core/clock.ts",
      "role": "分段时钟与 unref",
      "readFully": false,
      "lines": "1-118"
    },
    {
      "path": "tests/todo/idle-recovery-production.test.ts",
      "role": "原生产守卫需升级为全拓扑正例及抑制矩阵",
      "readFully": true
    },
    {
      "path": "tests/conformance/todo-idle-recovery.test.ts",
      "role": "真实 SDK 时序、deferred/reload 反例、受控 B2 集成",
      "readFully": false,
      "lines": "1-45,230-284,490-735; unsupported/reload grep"
    },
    {
      "path": "tests/todo/idle-recovery-store.test.ts",
      "role": "现有 reload/Stop/seen 验证坐标",
      "readFully": false,
      "lines": "grep 280-332,541,643-667"
    },
    {
      "path": "tests/todo/idle-recovery-runner.test.ts",
      "role": "已有订阅与 immediate/unref 测试定位",
      "readFully": false,
      "lines": "grep 93,572"
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts",
      "role": "真正 session 持有者是 createAgentSession 返回值",
      "readFully": true
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts",
      "role": "真实 AgentSessionEvent 与 subscribe 签名",
      "readFully": false,
      "lines": "45-63,374-388; listener grep 113"
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
      "role": "awaited hooks 后 subscribe、随后 deferred actions；同步 append",
      "readFully": false,
      "lines": "640-716,988-1020; appendEntry grep 2801-2802"
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
      "role": "ExtensionContext 无 subscribe，实际 settled shape",
      "readFully": false,
      "lines": "232-292,806-833"
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
      "role": "appendEntry 同步转发定位",
      "readFully": false,
      "lines": "grep 314-316"
    },
    {
      "path": "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
      "role": "ctx.hasPendingMessages 的绑定定位",
      "readFully": false,
      "lines": "grep 180,212,233,670-672"
    }
  ],
  "evidence": [
    {
      "claim": "普通 ExtensionContext 没有真实 root session.subscribe",
      "file": "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
      "lines": "232-272"
    },
    {
      "claim": "subscribe 晚于 awaited extension hooks，但早于 deferred actions",
      "file": "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
      "lines": "696-716"
    },
    {
      "claim": "真实 SDK 测试证明 post-subscribe 仍有隐藏 deferred input 竞态",
      "file": "tests/conformance/todo-idle-recovery.test.ts",
      "lines": "673-731"
    },
    {
      "claim": "query 判空必须 union spawn admission",
      "file": "src/index.ts",
      "lines": "383-394"
    },
    {
      "claim": "goal 真实 stopped/none 需归一，不能直传 recovery helper",
      "file": "src/goal/state.ts",
      "lines": "18"
    },
    {
      "claim": "Web HTTP ok 不是 prompt 消费，展示帧不能做全量判空",
      "file": "src/web-hub/agent/ledger.ts",
      "lines": "10-17,159-169"
    },
    {
      "claim": "schedule readState 是同步读，clear 不需要异步 TTL 缓存",
      "file": "src/schedule/agent/wire.ts",
      "lines": "175-176,521-533"
    },
    {
      "claim": "#61 rootPlans/reservation 不在 xs controller busy 中",
      "file": "src/fabric/stack.ts",
      "lines": "115-129,189-205,321-327"
    },
    {
      "claim": "原守卫只调用 wireTodo，移到 stack 接线不一定使旧断言自然红",
      "file": "tests/todo/idle-recovery-production.test.ts",
      "lines": "49-66"
    },
    {
      "claim": "现有默认 true 为历史用户裁定",
      "file": "docs/dev/todo-idle-recovery/plan.md",
      "lines": "20"
    }
  ],
  "ruledOut": [
    {
      "target": "extension agent_settled + setImmediate 作为真实订阅替代",
      "why": "后续 async hook 未结束时 idle/noPending 仍可能为 true；有真实反例"
    },
    {
      "target": "ctx.sessionManager.subscribe 或强转 AgentSession",
      "why": "公开 SDK 无此形状，manager 不持有 root 事件流"
    },
    {
      "target": "把所有 busy probe 的 undefined 默认 clear",
      "why": "把能力缺失变授权，违反现有 fail-closed 内核"
    },
    {
      "target": "借 goal/memory/xs dispose 偷挂 recovery",
      "why": "开关、owner、三路覆盖不同；应申请独立 step 最小例外"
    },
    {
      "target": "ledger.frame / workflow.listForDisplay / Web TODO projection 判空",
      "why": "展示截断、linger 或缺失归档依赖，不是完整执行真相"
    },
    {
      "target": "给 clear 快照 1s/5s TTL",
      "why": "TTL 不能保证新 admission 或外部 writer 不在缓存期发生"
    },
    {
      "target": "#59 帮 #61 降级消息补 wake",
      "why": "独立授权域与预算，不能绕过 fabric 准入"
    }
  ],
  "openQuestions": [
    "评审裁定 SDK owner 的正式公开能力交付路径；当前普通 CLI 不支持",
    "批准三 teardown 数组各增独立 idleRecovery step 的必要最小例外",
    "批准扩展只读 reader 的窄解冻范围，或首批认证组合禁用对应 subsystem",
    "认证的扩展/输入/deferred/reload/schedule writer 组合清单与 conformance 证据",
    "确认 tree 后保守关闭至下一 session_start 的本步可用性边界"
  ],
  "nextSteps": [
    "主会话按需用 ask_user 汇总真正需要用户裁定的范围问题",
    "下游按 evidence 定点复核 SDK 时序、全量 reader 和默认值裁定",
    "先补真实生产组合红灯用例，再实现窄 observer/reader 与装配",
    "不得重设计 B1/B2；所有未认证组合保持 effective-off",
    "真实时钟快速 E2E 与 15 分钟期限 E2E 分别留证，不以 FakeClock 冒充"
  ]
}
```
