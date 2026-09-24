# 静默后台 run（silent background run）——实施方案 A0

> 状态：**待评审**。本文是「扩展内部代码派生静默 run」的落地方案：三点硬需求的机制核实、
> 可直接落地的调用配方、建议的薄封装与一行缺陷修复、坑与做不到的部分、测试验收点。
> 所有代码引用均已读码验证（行号以当前 master 为准，标注文件路径 + 函数名，行号漂移时以
> 函数名/注释锚点为准）。

## 0. 需求与结论速览

扩展内部代码（goal 循环的 verifier、cache-keepalive 类后台服务、未来的 fabric v2
revive 等）需要派生一种 run，同时满足：

| #   | 需求                   | 一句话结论                                                                                                                                                                                |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 不触发嵌套委派校验     | `parentRunId` 传**合成 id**（非 `r_` 前缀、非任何在跑 run 的 id）：X3 校验只对 `nesting` 表命中的父 run 生效                                                                              |
| S2  | 不产生顶层完成通知     | 同一个合成 `parentRunId`：CC2 把「带 parentRunId 的 run」的 `enqueue_delivery`/config-failure/deadline 通知全部在 runtime-adapter 层丢弃，`pi.sendMessage(triggerTurn:true)` 根本不会发生 |
| S3  | 不被发起方取消级联杀掉 | 级联走 `childrenOf`/`parentOf`（按 parentRunId 登记）：合成 id 不在任何真实 run 的 children 里，`abort(发起方)` 与 `onChildAbort` 级联都够不着它                                          |

**三点共用同一个锚：合成 `parentRunId`。** 这不是新造机制，而是 SubagentWorkflow 已经在生产
使用的既有路径（`src/stack.ts:1434` `parentRunId: workflowId`，workflowId 形如
`wf_<uuid20>`，见 `src/tools/workflow-tool.ts:398`）。本方案把这条路径提炼成内部可复用的
显式约定 + 薄封装。

**先说做不到的**（详见 §6）：

- 静默 run **活不过主会话**：`session_shutdown` 对所有非终态 run 调 `query.stop(runId,
"shutdown")`（`src/index.ts:522-555`）。`/reload`、`/new`、`/resume`、fork、quit 都会杀掉它。
  bash job 有跨会话收养（`adoptOrphans`），subagent run 没有等价机制。**这是本方案明确的
  能力边界，不试图绕过**（绕过它等于在 shutdown 后留下无人认领的模型调用与不可回收的资源）。
- 静默 ≠ 隐身：run 仍出现在 fleet widget、`/agent status`、`subagent:started` 事件里，仍被
  background-status 计入 `runningSubagents`。CC2 只断「不通知」，不断「不可见」。
- watchdog 对每个 run 照常武装（预算仍生效）。这是仓库的核心不变量（zero-hang），**有意保留**。

---

## 1. 现状核实表（读码验证）

### 1.1 S1：嵌套委派校验的位置与豁免条件

校验唯一入口在 `src/service/spawn-service.ts` 的 `spawn()`（X3 段）：

```ts
let depth = 0;
if (req.parentRunId) {
  const parent = nesting.get(req.parentRunId);
  if (parent) {
    // ← 只在父 run「当前仍在跑且被本服务跟踪」时才校验
    if (!parent.canSpawn?.includes(req.type)) return { error: { ..."nested delegation is not permitted ..." } };
    depth = parent.depth + 1;
    if (depth > maxNestedDepth) return { error: { ..."nested delegation depth ... exceeds ..." } };
  }
}
```

关键事实：

- `nesting` 是**进程内、只含在跑 run** 的表；`finish()` 里 `nesting.delete(outcome.runId)`
  ——父 run 一旦终态，以其 id 为父的后续派生也不再受校验。
- 注释明确认可「untracked/foreign parentRunId … left unrestricted (depth 0, no canSpawn
  cap)」是设计而非漏洞：`parentRunId` 不是模型可传参数（顶层 Agent 工具 schema 没有它），
  合成 id 只能来自宿主侧代码或 RPC（`src/rpc/protocol.ts:45`
  `parentRunId: Type.Optional(Type.String())` 本就允许任意字符串）。
- 真实 RunId 格式为 `r_[0-9A-HJKMNP-TV-Z]{8}`（`src/core/ids.ts:10`）。**任何非 `r_` 前缀的
  合成 id 在结构上就不可能命中 `nesting`**（除非撞上某个在跑 run 的完整 id——前缀不同即可
  排除；workflow 用 `wf_` 前缀同理）。

反面陷阱（不要走的路）：

- 把 `parentRunId` 设为**真实发起方 run 的 id**：发起方 agent type 的 `canSpawn` 白名单 +
  `maxNestedDepth`（默认 3，`src/config/settings.ts:389`）照常生效，S1 失败。
- 借嵌套 Agent 工具派生：`src/service/runtime-adapter.ts` 注入嵌套工具时强制
  `parentRunId: spec.runId` 且 `forceSlotless: true`（`src/tools/agent-tool.ts:276-277`），
  调用方无法换成合成 id。
- 在子会话里拿 SpawnService：子会话的扩展实例因 HOST_KEY 守卫（`src/index.ts:114-142`）是
  inert 的，`holder.current` 为空。**静默派生必须发生在宿主侧（主进程）代码里。**

### 1.2 S2：完成通知的链路与过滤点

完整链路（每一跳都已核实）：

```
core/state-machine.ts finish()            ← 每次终态无条件产出 enqueue_delivery 效果（:335）
  → service/runtime-adapter.ts 效果解释器  ← CC2：childRunIds 命中 ⇒ 直接 return，不进 notifier
  → delivery/notifier.ts enqueue/attempt   ← enqueue→attempt→send 是同步链（无 await 间隔）
  → stack.ts sendFormatted                 ← pi.sendMessage({customType:"subagent:notification"}, {triggerTurn:true})
```

CC2 的实现（`src/service/runtime-adapter.ts`）：

- `const childRunIds = new Set<string>()`（:215）；
- `run()` 开头、任何 await 之前：`if (spec.request.parentRunId !== undefined)
childRunIds.add(spec.runId)`（:338）；`finally` 里删除（:537）；
- 四个消费点全部查它：
  1. `enqueue_delivery` 解释器（:232）——子 run 的终态通知不进 outbox；
  2. `settleConfigFailure`（H2 resolveSessionSpec 抛错/超时、CC4 已过期 deadlineAt 等
     config-failure 路径，:307）；
  3. `deadlineNoticeHandler`（宽限/延长通知，:101-108，独立导出的纯函数）；
  4. `finally` 里的 `notifier.finalize`（:526-536）——`policyPendingRunIds` 只在
     `enqueue_delivery` 通过 CC2 后才会写入（`hold = schemaRunIds.has(...)` 在 child 早退
     之后），所以带 `schema` 的静默 run 也不会留下 staged 记录、不会触发 finalize。

`triggerTurn: true` 就是「唤醒主会话起一轮模型调用」的机制（`src/stack.ts:941/954`）；
CC2 在它上游整条掐断，主会话零感知、零 token。

为什么不走 `expectAck` 这条理论路径：`ackWindowMs` 与 `coalesceWindowMs` 默认均为 0
（`src/config/settings.ts:384-386`），`notifier.enqueue → attempt → send` 是同一同步链
（`src/delivery/notifier.ts` `enqueue()` 内直接 `attempt(record, ...)`），先于调用方的
ack 微任务执行——fail-open 发通知。`expectAck: true` 只有在用户把 `ackWindowMs` 调大于 0
时才有抑制效果，不可依赖。

**已发现的缺口（潜伏缺陷，正常路径不可达）**：`src/service/spawn-service.ts` `start()` 的
catch 安全网 `deps.notifyTerminalFailure?.(failed)`（:243）**不查 childRunIds**——若
`runner.run()` 本身抛异常（而非 run 走到 failed 终态），子 run 仍会发一条顶层通知（接线在
`src/stack.ts:1134-1160`，直接 enqueue 进 notifier）。workflow 子女今天同样暴露于此。修法见
§4.2（一行）。

### 1.3 S3：取消级联的数据基础与豁免条件

级联的两张表（`src/service/spawn-service.ts`）：`childrenOf`/`parentOf` **仅当请求带
`parentRunId` 时登记**，run 终态时清理。两条触发链：

- (a) 显式 `spawnService.abort(runId)`：先 `cascadeChildren(runId, "parent_abort")` 再杀
  自身（`abort_subagent`、`/agent` 命令走这里）；
- (b) 任何原因取消某个 run（user_stop / timeout / external signal）：runner 的 cancel
  handle `onCancel` 调 `onChildAbort(runId, "parent_abort")`（`src/runtime/runner.ts:399-411`），
  接线 `src/stack.ts:1079` `onChildAbort: (parentRunId, cause) => void spawnRef.current?.abort(parentRunId, cause)`
  ——即**父 run 超时或被用户停，都会经 (a) 带走它在 childrenOf 里的全部子 run**。

豁免：合成 id 作父 ⇒ 静默 run 不在任何真实 run 的 `childrenOf` 里，(a)(b) 都够不着。能杀掉
它的只剩：

1. 显式 `abort(静默runId)`（自己或任何知道 runId 的代码）；
2. owner 主动 `stopChildrenOf(合成id, cause)`——专为「owner 自身不是 tracked run」设计的
   收尸入口（workflow 正是用它，`src/workflow/host.ts:868-875`）；
3. watchdog 预算超时（zero-hang 不变量，不可豁免）；
4. `session_shutdown` 全停（§0 边界）。

外部信号层面：不传 `signal` 即无链接。若确需在主会话 turn 上下文里发起又想免疫 Esc/强制
压缩的 turn 中止，可传 `detachSignalOnStart: true`（`src/runtime/runner.ts:414`
`cancel.detach()`，只解除外部 listener；`activeCancels` 路径——abort_subagent/watchdog——
不受影响）。**不传 signal 时该参数无意义，省略。**

### 1.4 每个相关参数的语义（`src/core/types.ts` `SpawnRequest`，:130-246）

| 参数                                                               | 静默配方取值        | 语义/理由                                                                                                       |
| ------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `type`                                                             | 必填，已注册类型    | `deps.types.get(req.type)` 未命中即 config error；内部代码选轻量类型（如 `general`）                            |
| `prompt`                                                           | 必填                | 经 `buildPrompt` 与类型 systemPrompt 组合（`promptMode: append` 时拼接）                                        |
| `label`                                                            | 建议显式传          | 不传则从 prompt 首行派生标签并注册进 label/mention 索引——显式短标签可控、可预测、便于收尸排查                   |
| `parentRunId`                                                      | **合成 id**（§3.1） | 三点保证的锚：绕 X3、进 CC2、登记到合成 owner 名下而非真实父                                                    |
| `slotless`                                                         | `true`              | 不占 `concurrencyLimit=6` 的槽、无排队等待；代价是无 queue-timeout 保护（§6.5）                                 |
| `budgetOverride`                                                   | 可选 `{ totalMs }`  | 显式 `totalMs` ⇒ `applyBudgetPolicy` 钳 `maxTotalFactor=1`（硬顶、无宽限无延长）；不传则用全局预算+宽限/延长    |
| `signal`                                                           | **不传**            | 外部取消零链接（turn 中止、Esc、compact 都够不着）                                                              |
| `detachSignalOnStart`                                              | 不传                | 无 signal 即无 listener 可 detach                                                                               |
| `expectAck`                                                        | 不传                | 不进 `claimedRunIds`；ack 语义对静默 run 无意义（CC2 已断通知）且默认窗口为 0 不可靠                            |
| `schema`                                                           | 可选                | X10 双重校验照常工作；CC2 先于 schema-hold 判定，不会在 outbox 留 staged 记录（§1.2 第 4 点）                   |
| `cwd` / `modelOverride` / `modelHintOverride` / `thinkingOverride` | 按需                | 与普通 run 完全同语义；quota gate / model-hint 准入照常生效（fail 返回 error，不发跑注定失败的 run）            |
| `resumeFrom` / `deadlineAt` / `isolation`                          | 不用                | resume 走同一准入（目标在跑会被拒并提示改 steer）；`deadlineAt` 是绝对时刻上限，内部代码用相对 `totalMs` 更自然 |

---

## 2. 核心配方（零生产代码改动，今天就能用）

任何**宿主侧**持有 `Stack` 的内部代码（`src/index.ts` 的 `holder`、stack 闭包内、经
`GoalHookStack` 式窄接口注入的 hook——先例：`src/goal/hook.ts:54-57` 只暴露
`spawnAndWait` 一个方法）都可以直接这样调：

```ts
// ① 合成 owner id：前缀 != "r_" ⇒ 结构上不可能命中 nesting 表（真实 RunId 恒为 r_ 前缀）
//    先例：workflow 的 `wf_${randomUUID().replace(/-/g, "").slice(0, 20)}`（workflow-tool.ts:398）
const owner = `sr_<feature>_<rand8>`; // 例：sr_goal_followup_6XK3P9QA

// ② 派生（fire-and-forget；spawn() 在准入后立即返回，run 异步执行）
const spawned = await stack.spawn.spawn({
  type: "general",
  prompt: "<任务指令>",
  label: "goal-followup", // 显式标签，避免从 prompt 首行派生
  parentRunId: owner, // ★ S1 绕 X3 + S2 进 CC2 + S3 挂到合成 owner 名下
  slotless: true, // 不占并发池（内部后台任务不应挤占用户配额）
  budgetOverride: { totalMs: 10 * 60_000 }, // 可选：显式硬顶（无宽限无延长，防失控）
});
if ("error" in spawned) {
  // config error：unknown type / quota gate / label 派生失败等——照常处理，这里没有 run
  throw new Error(spawned.error.message);
}
const { runId, label } = spawned; // 自己保存 runId（合成 owner 不在 /agent status 的树里，只能靠它找回）

// ③ 收结果：不阻塞发起方。两种姿势：
//   a) 有界轮询（timer 已 unref，不卡 print 模式）：
const waited = await stack.spawn.waitOutcome(runId, 1_000);
if (waited.kind === "pending") {
  /* 下一轮再看，或用 query.get 查中间态 */
}
//   b) 查快照（终态时带 outcome；waitOutcome 对不存在的 outbox 记录 ack 是无害 no-op，
//      notifier.ack 查不到记录直接返回 false，且调用点有 try/catch 兜底）：
const snap = stack.query.get(runId); // diag.phase / status / outcome

// ④ 收尾兜底（仅在发起方自己异常退出、需要主动放弃时）：
await stack.spawn.stopChildrenOf(owner, "user_stop");
// 注意：abort(owner) 不行——owner 不是 tracked run，abort() 第一行 running.has(owner)=false
// 直接 return false 且不级联（这正是 stopChildrenOf 存在的原因，spawn-service.ts CC1 注释）。
```

为什么每一步这样传（对回三点需求）：

- `parentRunId: owner`：
  - S1 —— owner 不在 `nesting` 表 ⇒ depth 0、零白名单检查（§1.1）；
  - S2 —— `runtime-adapter.run()` 见 `parentRunId !== undefined` ⇒ 进 `childRunIds` ⇒
    终态/config-failure/deadline 通知全灭，`pi.sendMessage(triggerTurn:true)` 不发生（§1.2）；
  - S3 —— `parentOf.set(runId, owner)` 挂在合成 owner 下，真实发起方的 `childrenOf` 里没有
    它 ⇒ 两条级联链都够不着（§1.3）。
- `slotless: true`：内部后台任务不该和用户模型派生的 run 抢 6 个并发槽。代价见 §6.5。
- `budgetOverride.totalMs`：给 watchdog 一个显式硬顶。**必传与否的权衡**：不传则继承全局预算
  （有宽限+延长），run 可能活得比预期久；传了则是硬顶无宽限。内部后台任务建议传。
- 不传 `signal` / `expectAck` / `detachSignalOnStart`：见 §1.4 表。

### 2.1 配方的已知副作用（调用方必须知晓）

1. **可见性**：run 出现在 fleet widget（`ui/fleet-widget.ts` 按 `parentRunId` 分组——合成
   owner 不在 workflowIds 集合里，会落到 general 区普通展示）、`/agent status`、
   `subagent:started`/`subagent:completed|failed` 事件（`src/stack.ts:1176`）、1Hz usage 广播。
2. **background-status 计数**：`src/index.ts:151-159` 把它计入 `runningSubagents` ⇒
   feishu-notify 的完成卡会被压制到它结束（「主会话停了但后台还在跑 ≠ 任务结束」的既有
   语义，对静默 run 同样成立——通常正是想要的行为，但要知情）；cache-keepalive /
   cache-adaptive 的「有 subagent 在跑」信号同样会被它点亮。
3. **label/mention 注册**：`onLabel` 会把 label 注册进 mention 索引 ⇒ 用户可能在 @ 补全里
   看到它，但 mention 路由要求 `tree.isRootChild(target)`（`src/fabric/router.ts:98`）——静默
   run 的父是合成 owner，不是 root ⇒ 实际 @ 它会在 route 时抛 "mention target is not a root
   child"。观感瑕疵（补全里出现一个 @ 不了的目标），workflow 子女今天同样如此。
4. **fabric 树路由**：`onSpawnEdge(owner, runId)` 登记边 owner→runId，但 owner 自身无边 ⇒
   `relation(runId, "root") = "unrelated"` ⇒ `authorize()` 拒绝（`src/core/message.ts`
   `if (relation === "unrelated" || relation === "self") return false`）。即：**静默 run 里的
   `message_agent` 到不了主会话（root），主会话也发不进 directive**——它只能收到树内
   （owner 子树）的消息，而 owner 不可寻址 ⇒ 实际上完全隔离。与 workflow 子女等价。需要
   回传结果就走 §2 的 ③ 显式收结果，不走 fabric。
5. **fabric 树残留**：owner 节点永不被 tombstone（只有真实 run settle 时才 tombstone），
   `edges` 里每个静默 run 留一条永不过期的边。量级：每 run 一个 Map entry，可忽略；洁癖式
   收尾可在 `stopChildrenOf` 后无操作可用（树无删边 API——如实记录，不改）。

---

## 3. 建议落地：薄封装 `createSilentRunSpawner`（新代码）

配方本身是纯调用约定，但散落在各内部特性里迟早有人传错（尤其是误传真实父 id——三点全毁）。
建议新增一个 pi-free 的纯封装，把约定钉死在一处：

### 3.1 新增 `src/service/silent-run.ts`

```ts
import type { RunId, RunOutcome, SpawnRequest } from "../core/types.js";
import type { SpawnService } from "./spawn-service.js";

export type SilentOwnerId = string;

export interface SilentRunDeps {
  spawn: SpawnService;
  /** Test seam; default `sr_<feature>_<crockford8>`（前缀 != "r_"，结构性避开 nesting 表）。 */
  newOwnerId?: (feature: string) => SilentOwnerId;
}

export interface SilentRunRequest {
  type: string;
  prompt: string;
  label?: string;
  feature: string;                      // 合成 id 的语义段，如 "goal"、"fabric-revive"
  cwd?: string;
  modelOverride?: SpawnRequest["modelOverride"];
  modelHintOverride?: SpawnRequest["modelHintOverride"];
  thinkingOverride?: SpawnRequest["thinkingOverride"];
  /** 建议总是传：静默 run 的失控保护。undefined 则继承全局预算。 */
  totalMs?: number;
  schema?: SpawnRequest["schema"];
}

export interface SilentRunHandle {
  owner: SilentOwnerId;
  runId: RunId;
  label?: string;
}

export function createSilentRunSpawner(deps: SilentRunDeps) {
  return {
    /** 三点保证（S1/S2/S3）由 parentRunId=合成 owner 单点承载，调用方无参可传错。 */
    async spawnSilent(req: SilentRunRequest): Promise<SilentRunHandle | { error: ... }> {
      const owner = (deps.newOwnerId ?? defaultOwnerId)(req.feature);
      const spawned = await deps.spawn.spawn({
        type: req.type,
        prompt: req.prompt,
        ...(req.label !== undefined ? { label: req.label } : {}),
        parentRunId: owner,             // ★ 唯一锚点
        slotless: true,
        ...(req.totalMs !== undefined ? { budgetOverride: { totalMs: req.totalMs } } : {}),
        ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        // 其余可选字段按 SilentRunRequest 白名单透传；signal/expectAck/detachSignalOnStart
        // 刻意不在白名单里——静默语义下它们都是误用。
        ...(req.modelOverride !== undefined ? { modelOverride: req.modelOverride } : {}),
        ...(req.modelHintOverride !== undefined ? { modelHintOverride: req.modelHintOverride } : {}),
        ...(req.thinkingOverride !== undefined ? { thinkingOverride: req.thinkingOverride } : {}),
        ...(req.schema !== undefined ? { schema: req.schema } : {}),
      });
      if ("error" in spawned) return { error: spawned.error };
      return { owner, runId: spawned.runId, ...(spawned.label !== undefined ? { label: spawned.label } : {}) };
    },
    /** 有界等待；pending 时由调用方决定重试节奏。 */
    waitOutcome(handle: SilentRunHandle, waitMs?: number) {
      return deps.spawn.waitOutcome(handle.runId, waitMs);
    },
    /** 主动放弃（owner 收尸入口；对已 settle 的 children 是 no-op）。 */
    abandon(handle: SilentRunHandle) {
      return deps.spawn.stopChildrenOf(handle.owner, "user_stop");
    },
  };
}
```

设计要点：

- **`SpawnService` 之外零依赖**（pi-free、stack-free），与 `src/service/ports.ts` 的分层一致，
  可直接单测（同 `tests/service/nesting.test.ts` 的 controllableRunner 手法）。
- 刻意**不暴露** `signal` / `expectAck` / `detachSignalOnStart` / `parentRunId`——这三点语义
  里它们全是误用面（§1.4、§6.8）。`spawnAndWait` 也不暴露（阻塞语义与后台矛盾）。
- 调用方接线：与 goal 完全同构——`src/index.ts` 组装 hook 时从 `holder.current` 取
  `stack.spawn` 构造（或给 `Stack` 加一个 `silent` 字段；**建议前者**，避免动 `Stack` 接口
  面）。合成 owner 的**生命周期归调用方特性自己管**（像 goal 管 `GoalSession` 一样），封装
  不做全局 owner 注册表——那是过度设计，`childrenOf` 已经是注册表。

### 3.2 不改的东西（明确列出）

- `spawn-service.ts` 的 X3 段、CC2 过滤、cascade 实现——**一行不动**。本方案是既有机制的
  显式化，不是新机制。
- 不给 `SpawnRequest` 加新字段（不搞 `silent: true`）。合成 parentRunId 已是完整表达，加
  冗余标志位只会制造第二个真源（parentRunId 说 A、silent 说 B 时听谁的？）。
- 不改 RPC 协议（SpawnParams 已允许任意 parentRunId 字符串，外部面默认可达）。
- 不加 settings 开关。这是内部调用约定，不是用户可感知特性；用户若不想让某内部特性用
  静默 run，关那个特性（如 `goal.enabled`）即可。

### 3.3 修潜伏缺陷：`notifyTerminalFailure` 不查子 run（一行，建议随本方案一并落）

`src/service/spawn-service.ts` `start()` catch 块（:243）：

```ts
      finish(failed);
-     deps.notifyTerminalFailure?.(failed);
+     // CC2 对齐：带 parentRunId 的 run（workflow 子女/静默 run）的异常路径同样不得发
+     // 顶层通知——settleConfigFailure 与 enqueue_delivery 解释器均已按 childRunIds 过滤，
+     // 此处是唯一漏网点（runner.run() 整体抛异常的安全网）。
+     if (req.parentRunId === undefined) deps.notifyTerminalFailure?.(failed);
```

`req` 在 `start()` 闭包里现成可用，零新状态。这同时修复 workflow 子女的同一暴露面。
风险：无——该路径正常不可达（runner.run 的 promise reject 意味着适配器/状态机之外的
内部错误），收紧它只会少发一条本就不该发的通知。

---

## 4. 坑、约束与残余风险（如实清单）

### 4.1 做不到的部分

1. **活不过主会话**（§0 已述）。`/reload`、`/new`、`/resume`、fork、quit ⇒
   `query.stop(runId, "shutdown")` + `waitAll(drainMs ≤ 15s)`。没有跨会话收养。如果某特性
   真的需要跨会话存活，正确路径是给 subagent run 造 bash-job 式的收养机制（独立立项，
   涉及 sessionFile 所有权、下一个 stack 的重建/对账，绝不是本方案的「顺手」范围）。
2. **watchdog 不可豁免**。全局预算或显式 totalMs 到点即超时（显式硬顶无宽限无延长，
   `applyBudgetPolicy` D-10）。想要长活就传大 `totalMs`，别指望绕开预算——那是仓库的
   核心不变量。
3. **通知静默 ≠ 观感静默**（§2.1.1-2：fleet widget、事件、计数器全看得见）。若未来要
   「完全隐身」，得动 fleet-widget/background-status 的过滤面——那是另一个需求，本方案
   不做（静默 run 计入 runningSubagents 对 feishu 完成卡压制反而通常是正确语义）。
4. **fabric 双向不通**（§2.1.4）。静默 run 与主会话之间没有 message_agent 通路；结果回传
   只能走显式收结果（waitOutcome/query.get），或它写文件/副作用。
5. **不能被 @、不能 resume 到手**——`get_subagent_result`/`resume` 面向模型的是 runId/
   label 句柄，技术上模型**能**用 `get_subagent_result` 查到静默 run（它在 query registry
   里），这是可接受的（只读）；但 `@label` 路由不通（§2.1.3）。

### 4.2 必须防的坑

1. **绝不用真实发起 run 的 id 作 parentRunId**——S1（白名单+深度）、S3（级联）双双失效，
   S2 的语义也从「无主静默」变成「归发起方所有」。这是本方案唯一致命的误用，薄封装的存在
   就是为了让它不可表达。
2. **合成 id 前缀卫生**：必须非 `r_` 开头（`RUN_ID_RE = /^r_[0-9A-HJKMNP-TV-Z]{8}$/`）。
   `sr_`/`wf_` 均可。另避免与 label 语义混淆：`isRunId(label)` 的 run 会触发 fallback 警告
   （spawn-service 标签规划段），合成 owner id 不会成为 label，无此问题。
3. **`abort(owner)` 是 no-op**：owner 不是 tracked run，`abort()` 第一行 `!running.has` 直接
   return false。收尸必须 `stopChildrenOf(owner)`。已 settle 的 child 会被 finish() 从
   childrenOf 摘除，所以迟到的 stopChildrenOf 是安全 no-op。
4. **发起方在 turn 上下文里别顺手把 turn 的 AbortSignal 传进去**——那会重新建立外部链接
   （Esc/压缩即杀）。配方就是不传 signal；确要传必须配 `detachSignalOnStart: true`（且明白
   它只保护「启动之后」，启动窗口内 aborted 的 signal 仍会立即取消——createCancelHandle 的
   immediate-check 在 detach 之前，`src/runtime/runner.ts:399-414`）。
5. **slotless 无排队保护**：不占槽也不会 queue_timeout——`pool.acquire` slotless 分支直接
   放行。同时跑 N 个 slotless 静默 run 不受 `concurrencyLimit=6` 约束，唯一的闸是各自的
   watchdog 预算。内部特性应自限并发（如 goal 的 verifier 天然串行）。
6. **`spawnAndWait` 不可用于静默 run**：它强制 `expectAck: true` 且阻塞到终态——阻塞语义
   与后台矛盾（且虽然 CC2 会让通知不发出，ack 语义完全是空转）。要等待用 `waitOutcome`
   的有界轮询。
7. **`expectAck` 抑制不可依赖**（§1.2 末段）：即便误传了 `expectAck: true`，默认
   `ackWindowMs=0` 下通知照样同步发出。CC2 是唯一可靠过滤点——再次说明锚必须在
   parentRunId 上。
8. **异常路径的通知泄漏（修复前）**：§3.3 的缺陷意味着在修复落地前，若 runner 内部抛出
   未捕获异常（正常路径不可达），静默 run 会发一条顶层通知。若本方案的封装先于修复上线，
   文档里要如实标注这个残余窗口。

### 4.3 行为涟漪（知情即可，不处理）

- **switch_context 的 session-facts** 会把静默 run 列进 live runs（`src/context-switch/
session-facts.ts` 的「live runs」段）——模型在写交接包时会看到它。一般是有益的（交接
  完整性），但如果某特性想要真·无人知晓，这里是另一个泄露面。
- **cache-keepalive / cache-adaptive** 把「有 subagent 在跑」当作信号源：一个长活的静默
  run 会让 keepalive 认为主会话仍活跃。影响是「多 ping 几次」量级，无正确性问题。
- **quota 阶梯预警 / gate** 照常生效：静默 run 的 spawn 会被额度闸门快速失败（这是特性，
  不是坑）。
- **tombstone**：终态快照进 tombstone store（30 分钟 TTL），`resolveRun` 在此后仍能按
  runId 找到它——收结果的时间窗很宽裕。

---

## 5. 验证点（测试方案）

### 5.1 单测：`tests/service/silent-run.test.ts`（新增，若落 §3.1 封装）

用 `tests/service/nesting.test.ts` 同款 `controllableRunner()` + `typesRegistry()` 手法：

1. **S1 绕过校验**：注册一个 `canSpawn: []`（无任何白名单）的受限类型 `capped`；
   `spawnSilent({ type: "capped", ... })` 成功，而对照的
   `spawn.spawn({ type: "capped", parentRunId: <真实在跑 run id> })` 被
   `nested delegation is not permitted` 拒绝。再验证深度：直接以在跑 run 为父连续派生到
   `maxNestedDepth+1` 被拒，`spawnSilent` 永远 depth 0（断言返回的 runId 可正常 start）。
2. **S3 级联豁免**：
   - spawn 一个真实 parent run + 一个 `spawnSilent`；
   - `svc.abort(parentRunId, "user_stop")`；
   - 断言 `abortCalls` **不含**静默 runId，且 `svc.snapshots()` 里静默 run 仍非终态。
   - 反向：`abandon(handle)`（即 `stopChildrenOf(owner)`）后断言 abortCalls **含**静默
     runId、cause 为 `user_stop`。
   - onChildAbort 链等价性：在 controllableRunner 的 abort 触发处模拟 runner cancel handle
     调 `onChildAbort(parentRunId, "parent_abort")`（或直接集成测试覆盖，见 5.3），断言同样
     不触及静默 run。
3. **合成 id 卫生**：`newOwnerId` 产出的 id 断言 `!isRunId(id)` 且以非 `r_` 前缀开头
   （防回归：有人改前缀改成 `r_` 会被 `RUN_ID_RE` 撞上）。
4. **参数白名单**：TypeScript 层面已由 `SilentRunRequest` 类型钉死（编译期保证无
   signal/expectAck 误用）；运行时断言透传字段出现在 controllableRunner 收到的
   RunnerSpec.request 里（`slotless === true`、`parentRunId === owner`、
   `budgetOverride.totalMs` 合并进 budget）。

### 5.2 单测：CC2 既有覆盖 + 缺陷修复回归

- 既有锚点：`tests/service/runtime-adapter-extend.test.ts:40`（deadlineNoticeHandler 的
  child 过滤）——**静默 run 无需新增 adapter 测试**，因为 CC2 判据是
  `parentRunId !== undefined`，与 workflow 子女共用同一分支；但补一条
  「`spawn()` 直连（不经 Agent 工具）+ parentRunId ⇒ notifier.enqueue 零调用」的
  adapter 级用例值得加（用 stub Notifier 记录 enqueue 调用，驱动 run 到终态，断言
  enqueue 从未收到该 runId 的 payload）。
- 缺陷修复回归（§3.3）：借 `tests/integration/stack-terminal-failure.test.ts` 的 harness
  （它已暴露 `spawnDeps.notifyTerminalFailure`）——spawn 一个带 `parentRunId` 的 run，让
  runner 抛异常，断言 `notifyTerminalFailure` **不再**被调用；对照：不带 parentRunId 的
  run 在同路径下仍会调用（顶层安全网不回退）。

### 5.3 集成测试：`tests/integration/silent-run-wiring.test.ts`（新增）

用 `buildSessionStack` + `sandboxHome()`（**测试卫生**：必须沙盒 home，否则本机真实 key
会发真请求——见 memory 记录），mock/spy `pi.sendMessage`：

1. **S2 端到端**：`stack.spawn.spawn({ ..., parentRunId: "sr_test_x" })`，驱动 run 完成
   （最小 agent type + 快速预算），断言：
   - `pi.sendMessage` 从未以 `customType: "subagent:notification"` + 该 runId 被调用
     （⇒ 无 triggerTurn、无主会话唤醒）；
   - outbox store（stack.notifier.peek / stats）无该 runId 的 delivery key。
2. **S3 端到端**：spawn 真实发起 run A（可完成的慢 run）+ 静默 run B；`stack.query.stop(A.runId,
"user_stop")`（等价 abort_subagent 的 L3 路径）；断言 B 继续跑并最终 completed，
   `query.get(B.runId)?.outcome.status === "completed"`。
3. **收尸**：`stopChildrenOf("sr_test_x")` 后 B 变 aborted。
4. **shutdown 边界（负向断言，文档化行为）**：触发 session_shutdown 等价逻辑（直接调
   index.ts 的 handler 或对 stack 做同构调用），断言 B 被 stop（cause "shutdown"）——把
   「活不过主会话」钉进测试，防止未来有人以为它是 bug 而「修」出无人认领的 run。

### 5.4 不需要新测试的部分（说明理由）

- X3 的 nesting 表生命周期（父终态后删除）——`tests/service/nesting.test.ts` 已有矩阵；
- CC2 的四个过滤点——`runtime-adapter` 现有测试 + 5.2 补的一条；
- watchdog 对 slotless run 照常武装——runner 层既有测试覆盖（slotless 只跳过池，不跳过
  预算）。

---

## 6. 开放问题（评审时定）

1. **`Stack` 接口是否暴露 `silent`**：倾向不暴露（调用方从 `holder.current.spawn` 自取 +
   自建 spawner，与 goal 的 `GoalHookStack` 同构）。若未来 ≥3 个特性使用，再上移。
2. **owner 生命周期归属**：封装不做全局注册表（§3.1）。若将来需要在 `/agent status` 里把
   静默 run 按 owner 分组展示（fleet-widget 的 workflow 分组同款），再加——但那会把「静默」
   变成「半公开」，需求方需明确要不要。
3. **notifyTerminalFailure 修复的时机**：建议与本方案同 PR（一行 + 一个回归测试，风险面
   极小）；若要拆分，本方案文档的 §4.2.8 必须随封装代码一起暴露给调用方。

## 7. 引用索引（本方案核实时读过的关键位置）

| 主题                                                                             | 位置                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| X3 嵌套校验 / nesting / childrenOf / parentOf / cascadeChildren / stopChildrenOf | `src/service/spawn-service.ts` `spawn()`、`finish()`、`abort()`                                                      |
| CC2 通知过滤（4 个消费点）                                                       | `src/service/runtime-adapter.ts` `createRuntimeRunnerAdapter()`、`deadlineNoticeHandler()`、`settleConfigFailure()`  |
| 终态无条件 enqueue_delivery                                                      | `src/core/state-machine.ts` `finish()`                                                                               |
| 通知出口 triggerTurn                                                             | `src/stack.ts` `sendFormatted()`                                                                                     |
| notifyTerminalFailure 接线（缺陷点）                                             | `src/service/spawn-service.ts` `start()` catch；`src/stack.ts:1134`                                                  |
| onChildAbort 级联接线                                                            | `src/runtime/runner.ts` cancel handle；`src/stack.ts:1079`                                                           |
| detachSignalOnStart                                                              | `src/runtime/runner.ts:414`；`src/core/types.ts:188`                                                                 |
| workflow 先例（合成 parentRunId + stopChildrenOf 收尸）                          | `src/stack.ts:1434`；`src/tools/workflow-tool.ts:398`；`src/workflow/host.ts:868`；`src/workflow/spawner-adapter.ts` |
| session_shutdown 全停                                                            | `src/index.ts:522-555`；`src/service/query-service.ts` `stop()`                                                      |
| 子会话 inert（HOST_KEY）                                                         | `src/index.ts:114-142`                                                                                               |
| RunId 格式 / isRunId                                                             | `src/core/ids.ts`                                                                                                    |
| 默认设置（ackWindowMs/coalesceWindowMs=0、concurrencyLimit=6、maxNestedDepth=3） | `src/config/settings.ts:375-394`                                                                                     |
| RPC 允许任意 parentRunId                                                         | `src/rpc/protocol.ts:45`                                                                                             |
| fabric 树 unrelated ⇒ authorize 拒绝                                             | `src/fabric/tree.ts`；`src/core/message.ts` `authorize()`                                                            |
| mention 要求 root-child                                                          | `src/fabric/router.ts:98`                                                                                            |
| slotless 语义                                                                    | `src/runtime/slot-pool.ts`；`src/runtime/runner.ts:443-452`                                                          |
| notifier 同步发送链                                                              | `src/delivery/notifier.ts` `enqueue()`/`attempt()`                                                                   |
