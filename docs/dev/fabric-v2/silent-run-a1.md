# 静默后台 run（silent run）实施方案 — fabric-v2 A1

> 状态：**待实施**。行号基于 `f9ac1c2`（master），实施时如有漂移按函数名定位。
> 定位：fabric-v2 的前置能力（plan §D-9 auto-revive、§6.3 root 应答等场景都需要"扩展内部代码
> 派生一个不打扰任何人的 run"），但本身不依赖 fabric，任何内部特性（scheduler、goal、未来的
> board 服务等）都可复用。

## 0. 需求与术语

扩展内部代码（host 侧装配层、hook、工具实现）需要派生一种 run，同时满足：

| #   | 需求                                 | 反面（默认行为）                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| S1  | 不触发嵌套校验                       | 普通子→孙派生走 canSpawn 白名单 + `maxNestedDepth`（默认 3）校验，不满足即 `failed(config)` 拒绝 |
| S2  | 不产生顶层完成通知，更不能唤醒主会话 | 终态 → outbox → `pi.sendMessage(..., {triggerTurn:true})`，空闲主会话会被拉起一轮模型调用        |
| S3  | 不被发起方取消级联杀掉               | 发起方 run 被取消/超时/用户停止时，其 `childrenOf` 里的所有子 run 以 `parent_abort` 级联中止     |

"静默"只覆盖以上三点；**可见性不在需求内**（见 §3.2，静默 run 仍出现在 fleet widget /
`/agent status` / `subagent:started` 事件里，且计入 background-status——这是刻意保留的，理由后述）。

## 1. 现状链路核实（读码证据，带行号）

### 1.1 S1 的接缝：嵌套校验只认"活的、被跟踪的"父

`src/service/spawn-service.ts` `spawn()` 的 X3 段（≈322-357 行）：

```ts
let depth = 0;
if (req.parentRunId) {
  const parent = nesting.get(req.parentRunId);   // ← 关键：查进程内 nesting 表
  if (parent) {
    if (!parent.canSpawn?.includes(req.type)) return { error: {...} };   // 白名单
    depth = parent.depth + 1;
    if (depth > maxNestedDepth) return { error: {...} };                 // 深度上限
  }
}
```

`nesting` 表只在 run 存活期间有项（`finish()` 里 `nesting.delete(outcome.runId)`，138 行）。
因此：

- **不传 `parentRunId`**，或传一个**从未被本 SpawnService 跟踪的合成 id**（如 workflow 的
  `wf_...`）：`nesting.get()` 返回 `undefined` → depth 0 直接通过，零白名单检查。
- 这是被注释**明确认可的设计**（≈324-334 行）："untracked/foreign parentRunId … is left
  unrestricted (depth 0, no canSpawn cap) rather than rejected"——理由是顶层 Agent 工具的
  model-facing 参数里根本没有 `parentRunId`，foreign id 只能来自内部调用方或陈旧引用。
- 反之，若传**真实发起方 run 的 id**（发起方还在跑）：必须过发起方 agent type 的 canSpawn
  白名单 + 深度上限。发起方结束后 `nesting.delete`，以其 id 为父的**新**派生不再受校验。

### 1.2 S2 的接缝：CC2 —— 唯一的"谁的终态通知进主会话"过滤点

通知链路（每个环节都已核实）：

1. `src/core/state-machine.ts` `finish()`：对**每个**终态无条件产出 `enqueue_delivery` 效果
   （无 per-run 开关）。
2. `src/service/runtime-adapter.ts` 效果解释器（≈230-236 行）：

   ```ts
   enqueue_delivery: (e) => {
     if (childRunIds.has(e.payload.runId)) return;   // CC2：子 run 的投递在这里被丢弃
     ...
     deps.notifier.enqueue(e.payload, ...);
   },
   ```

3. `childRunIds` 的入集条件在 `run()` 入口（**338 行**）：
   `if (spec.request.parentRunId !== undefined) childRunIds.add(spec.runId)` —— **判据是
   "请求里带没带 parentRunId"，与父是否为真实 run 完全无关**。合成 id 同样命中。
4. CC2 同样拦截另外两条旁路：config-failure 通知（`settleConfigFailure`，≈307 行）与
   deadline 宽限/延长通知（`deadlineNoticeHandler`，≈104-108 行，注释明确"CC2 filtering lives
   inside deadlineNoticeHandler"）。
5. 通过 CC2 的投递才进 notifier（outbox），最终由 `src/stack.ts` `sendFormatted`（≈911-957 行）
   发出：`pi.sendMessage({customType:"subagent:notification", ...}, {triggerTurn: true})`
   （941/954 行）。**`triggerTurn:true` 就是"唤醒主会话起一轮模型调用"的机制**——quota hint /
   compact-hint 刻意用 `triggerTurn:false` 以免唤醒（stack.ts 530/607/637/690/722 行），可作对照。

因此：**只要请求带任意 `parentRunId`（合成 id 即可），该 run 的完成/config-failure/deadline
通知就彻底不进 outbox、不 sendMessage、不唤醒主会话**。

**为什么不用 expectAck/ack 抑制**：`spawnAndWait`/`waitOutcome` 会经 `onOutcomeAcked →
notifier.ack`（stack.ts ≈1127-1133 行）消费通知，但 `ackWindowMs` 与 `coalesceWindowMs` 默认均
为 0（`src/config/settings.ts` `DEFAULT_SETTINGS`，≈384-386 行），`notifier.enqueue → attempt →
send` 是同一条同步链、先于 ack 微任务执行——fail-open 发通知（`docs/dev/delivery-v2/
architecture.md` 192-193 行明确承认）。只有把 `ackWindowMs` 调 >0 且 caller 在窗口内 ack 才能
抑制，且仅限 completed 类。**expectAck 单独不构成通知抑制，不要走这条路。**

**已发现的缺口**：`src/service/spawn-service.ts` `start()` 的 catch 安全网（**243 行**
`deps.notifyTerminalFailure?.(failed)`，即 `runner.run()` 本身抛异常时）**不查 parentRunId**——
带父的 run 在该异常路径上仍会发顶层通知并唤醒主会话（`src/stack.ts`
`notifyTerminalFailure` ≈1134-1167 行直接 `notifier.enqueue`）。正常代码路径构造不出这个异常，
属潜伏缺陷；但对"静默"是硬语义漏洞，§2.3 一并修掉。

### 1.3 S3 的接缝：级联中止只沿 childrenOf 走，登记只认请求里的 parentRunId

数据基础（`src/service/spawn-service.ts` ≈425-441 行）：**仅当请求带 `parentRunId`** 才登记
`parentOf` / `childrenOf`（以及 fabric 树边 `onSpawnEdge`）。两条触发链都已核实：

- **(a) 显式中止**：`spawnService.abort(runId)`（≈528-535 行）先 `cascadeChildren(runId)` 再杀
  自身——只级联 `childrenOf.get(runId)`。
- **(b) 任意取消都级联**：run 因任何原因（user_stop / timeout / external）进入取消时，runner
  的 cancel handle 回调（`src/runtime/runner.ts` ≈390-412 行）调
  `onChildAbort(runId, "parent_abort")`，在 `src/stack.ts` **1079 行**接线为
  `spawnService.abort(runId)` → 级联其子。即**父 run 超时/被用户停都会带走它在 childrenOf
  里的子 run**。

推论：

- 静默 run 的 `parentRunId` 若用**真实发起方 id** → 登记进发起方的 `childrenOf` → 发起方任何
  原因的取消都会杀死它 → **S3 不成立**。
- 用**合成 id** → 它只存在于 `childrenOf.get(合成id)` 下，不在任何真实 run 的子女集合里 →
  发起方怎么死都波及不到它。能杀它的只有：显式 `abort(它自己的 id)`、owner 主动
  `stopChildrenOf(合成id)`（≈536-547 行，唯一不要求 parentId 是 tracked run 的 owner 停止
  入口）、watchdog 超时、session_shutdown。

**外部信号层**：`SpawnRequest.signal` 链接外部 turn signal；`detachSignalOnStart: true`（runner.ts
**414 行**，cancel handle 注册进 `activeCancels` 之后立即 `cancel.detach()` 解绑外部 listener）
让 run 启动后免疫 Esc / `compact_context` / compact-hint 强制压缩这类**turn 中止**。现成先例：
Agent 工具 `run_in_background`（`src/tools/agent-tool.ts` ≈283-292 行，`detachSignalOnStart: true`

- turn signal）。注意边界（types.ts ≈174-188 行注释）：detach 只移除外部 listener——
  `abort_subagent` / watchdog 走 `activeCancels` 的路径不受影响；**admission 前已 aborted 的
  signal 仍会立即取消**（`createCancelHandle` 的 `external?.aborted` 检查不归 detach 管）。

### 1.4 先例与反例

| 例子                                                                                                                                                                                                                                                             | 结论                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **workflow 子女 run**（正例，可照抄）：`src/workflow/host.ts` ≈599-606 行 spawn 请求带 `parentRunId: deps.parentRunId`（即 `workflowId`，合成 id `wf_<20hex>`，`src/tools/workflow-tool.ts` 398 行）；收尸用 `stopChildrenOf(workflowId)`（host.ts ≈868-871 行） | 三点全满足的生产先例：不 slotless（保留排队超时保护）、通知被 CC2 吞、不挂在任何真实 run 下 |
| **goal verifier**（反例的一半）：`src/goal/hook.ts` 用 `spawnAndWait` + schema 派生，**不带 parentRunId**，靠 expectAck 抑制通知                                                                                                                                 | 默认 `ackWindowMs=0` 下完成通知 fail-open 照发、照唤醒——证明 expectAck 不是抑制机制（§1.2） |
| **cron scheduler**（纯反例）：`src/schedule/scheduler.ts` 74 行 `deps.spawn.spawn({ ...task.request })` 裸派生，无 parentRunId                                                                                                                                   | 内部派生但完成时发顶层通知并唤醒主会话——正是本方案要治的病                                  |

另一个佐证（说明这条路并非藏在深处的 hack）：RPC 协议 `src/rpc/protocol.ts` **45 行**的
`SpawnParams` 本就允许外部传任意 `parentRunId` 字符串直达 `spawn.spawn`——外部面已默认暴露
"合成父"用法。

## 2. 方案设计

### 2.1 核心思路

**一句话：给静默 run 发一个合成 owner id（`silent_<20hex>`，仿 workflow 的 `wf_` 前缀）作
`parentRunId`，从宿主侧 SpawnService 直接派生，自己持有 runId 收结果、自己负责收尸。**

`parentRunId` 是唯一的载重参数，三点语义全部由它触发：

| 点  | 机制                                                             | 合成 id 的效果                                           |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| S1  | X3 只在 `nesting.get(parentRunId)` 命中活 run 时校验（§1.1）     | 未命中 → depth 0 通过，零白名单检查                      |
| S2  | CC2 判据是 `parentRunId !== undefined`（§1.2），与父真假无关     | 命中 → enqueue_delivery / config-failure / deadline 全拦 |
| S3  | 级联只沿 `childrenOf` 走，登记键是请求里的 `parentRunId`（§1.3） | 挂在合成 id 下 → 不在任何真实 run 的级联半径里           |

RunId 格式是 `r_` + 8 位 Crockford（`src/core/ids.ts` `newRunId`），`silent_` 前缀天然不可能与
真实 RunId 撞车（workflow 的 `wf_` 同理，已生产验证）。

### 2.2 新增 `src/service/silent-run.ts`（helper，唯一新文件）

放 service 层（依赖 `SpawnService` 类型，pi-free，可单测）。**API 面原则：调用方传业务字段，
三点语义由 helper 强制保证——调用方就算传了 `parentRunId` / `expectAck` /
`detachSignalOnStart` 也会被剥掉重设**（防止未来某个调用方手滑传了真实发起方 id，把 S3 炸掉）：

```ts
// src/service/silent-run.ts
import { randomUUID } from "node:crypto";
import type { ErrorInfo, RunId, SpawnRequest, StopCause } from "../core/types.js";
import type { BoundedWaitResult, SpawnService } from "./spawn-service.js";

/** 仿 workflow 的 `wf_` 前缀（tools/workflow-tool.ts:398）；与 RunId 格式 `r_XXXXXXXX` 天然不撞。 */
export function newSilentOwnerId(): string {
  return `silent_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export interface SilentRunHandle {
  readonly ownerId: string;
  readonly runId: RunId;
  readonly label: string | undefined;
  /** 有界等待（转 SpawnService.waitOutcome）；结果文本在 outcome.text（受 resultMaxChars 截断）。 */
  wait(waitMs?: number): Promise<BoundedWaitResult>;
  /** 杀这一个 run（会级联它自己的子 run）。 */
  stop(cause?: StopCause): Promise<boolean>;
  /** owner 收尸入口：杀这个合成父下的所有 run（spawn-service.ts stopChildrenOf，唯一不要求
   *  parentId 是 tracked run 的停止路径）。OS4：返回的 pending 需调用方稍后复查。 */
  stopAll(cause?: StopCause): Promise<{ stopped: RunId[]; pending: RunId[] }>;
}

export async function spawnSilentRun(
  spawn: Pick<SpawnService, "spawn" | "waitOutcome" | "abort" | "stopChildrenOf">,
  req: SpawnRequest,
): Promise<SilentRunHandle | { error: ErrorInfo }> {
  // 剥掉调用方可能误传的语义字段——parentRunId/expectAck/detachSignalOnStart 由本函数独占定义。
  const { parentRunId: _p, expectAck: _a, detachSignalOnStart: _d, ...rest } = req;
  const ownerId = newSilentOwnerId();
  const admitted = await spawn.spawn({
    ...rest,
    parentRunId: ownerId, // 载重参数：S1 绕过 + S2 静默 + S3 脱钩，全由此触发（§2.4）
    // 有外部 signal 才需要解绑：signal 只把守准入期，启动后 turn 中止（Esc/压缩）不再波及。
    // 无 signal 时传 detachSignalOnStart 无意义（types.ts 注释：只作用于外部 signal listener）。
    ...(req.signal !== undefined ? { detachSignalOnStart: true } : {}),
  });
  if ("error" in admitted) return { error: admitted.error };
  return {
    ownerId,
    runId: admitted.runId,
    label: admitted.label,
    wait: (waitMs) => spawn.waitOutcome(admitted.runId, waitMs),
    stop: (cause = "user_stop") => spawn.abort(admitted.runId, cause),
    stopAll: (cause = "parent_abort") => spawn.stopChildrenOf(ownerId, cause),
  };
}
```

（`exactOptionalPropertyTypes` 下可选字段必须用条件展开，不能写 `expectAck: undefined`——上面
的解构剥离写法同时解决了这个问题。）

### 2.3 生产代码修改（仅 1 处，加固 §1.2 的缺口）

`src/service/spawn-service.ts` `start()` 的 catch 安全网，**243 行**：

```diff
       finish(failed);
-      deps.notifyTerminalFailure?.(failed);
+      // CC2 对齐（silent-run-a1 §2.3）：带 parentRunId 的 run（workflow 子女 / 静默 run）
+      // 终态只归 owner 消费——runner.run 抛异常的安全网同样不得发顶层通知（会唤醒主会话）。
+      // 判据与 runtime-adapter.ts:338 的 CC2 完全一致：parentRunId 有无，不问真假。
+      // （start() 首参名为 req；调用点传入的是 threading 后的 resolvedReq，parentRunId 已穿透。）
+      if (req.parentRunId === undefined) deps.notifyTerminalFailure?.(failed);
```

- 选调用点守卫而非改 `stack.ts` `notifyTerminalFailure` 回调，因为 childRunIds 集合活在
  runtime-adapter 的 `run()` 闭包里，stack 侧拿不到；而异常路径上 store 里也未必有带
  `parentRunId` 的快照可查（`runner.run` 抛出 = 快照效果链没跑完）。`start()` 首参 `req` 就是
  threading 后的 resolvedReq（`parentRunId` 在 `request-threading.ts` 26 行的 THREADED 白名单里，
  保证穿透），这是唯一权威判据位置。
- 行为变化面：只影响"带父 run + runner.run 抛异常"的组合——正常路径不可达（§1.2），对
  workflow 子女是修正了同一潜伏 bug（它们今天在这条路径上也会漏发顶层通知）。
- 除此之外**不改任何生产代码**。X3/CC2/级联三处接缝维持原样——方案的全部价值就在于复用
  它们，而不是新增开关（新增 per-run "silent" 标志反而要三处联动改，且扩大状态面）。

### 2.4 调用配方（逐参数）

完整调用（以 fabric-v2 auto-revive 场景为例）：

```ts
import { spawnSilentRun } from "../service/silent-run.js";

const handle = await spawnSilentRun(stack.spawn, {
  type: "general-purpose", // 必填：目标 agent type（走正常 registry 解析 + quota 闸门）
  prompt: revivePrompt, // 必填：任务全文（auto-revive 场景含 resume 上下文则另用 resumeFrom）
  label: "revive-<原label>", // 可选：会注册进 mention（仅 resolve，不进 root 自动补全）；
  //   建议 silent 场景统一前缀，便于人肉分辨
  cwd: "/repo", // 可选：默认继承宿主 cwd
  budgetOverride: { totalMs: 10 * 60_000 }, // 强烈建议：fire-and-forget 必须自带上限（见下）
  signal, // 可选：仅当在主会话 turn 上下文内发起且持有 turn signal 时传
  // resumeFrom / schema / modelOverride / thinkingOverride / isolation —— 均为 SpawnRequest
  // 透传字段，按需传，语义与普通 run 完全一致（resume 走 resumeLocks 准入；schema 走 X10 双校验）
});
if ("error" in handle) {
  /* 准入失败（unknown type / quota gate / label 派生失败…），零副作用 */
}
```

逐参数 rationale（helper 固定的三个字段 + 调用方字段）：

| 参数                                                                                                    | 值                                   | 为什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentRunId`（helper 定）                                                                              | `silent_<20hex>` 合成 id             | **载重参数**。S1：不在 nesting 表 → depth 0、无 canSpawn 检查（spawn-service ≈335-357）。S2：CC2 判据 `parentRunId !== undefined` → 三类通知全拦（runtime-adapter 338/232/307/107）。S3：只登记进 `childrenOf.get(silent_...)`，不在任何真实 run 级联半径内（spawn-service ≈432-441）。**绝不能传真实发起方 run id**——S1 会撞白名单、S3 会被发起方任何原因的取消级联杀死（runner ≈390-412 + stack 1079）。                                                                      |
| `detachSignalOnStart`（helper 定）                                                                      | `req.signal !== undefined` 时 `true` | 仿 agent-tool `run_in_background` 先例（≈283-292 行）。signal 只把守准入；启动后解绑，Esc / `compact_context` / 强制压缩不再波及。无 signal 时传它无意义（只作用于外部 listener）。`abort_subagent` / watchdog / `stopChildrenOf` 走 `activeCancels`，不受影响（types.ts ≈174-188 注释）。边界：admission 前已 aborted 的 signal 仍立即取消——**发起时刻 turn 已在取消中，静默 run 也救不回来**。                                                                                |
| `expectAck`（helper 剥掉）                                                                              | 不设                                 | CC2 已让通知根本进不了 outbox；expectAck 只影响 ack-window 抑制（需 `ackWindowMs>0`，默认 0，fail-open）和 `shouldDeliverDeadlineNotice` 的 caller-ack 判定（对子 run 无通知可抑）。设了无增益，徒增 `claimedRunIds` 语义。若调用方用 `spawnAndWait`（helper 之外的路径）会被强制 `expectAck:true`（spawn-service ≈445-447），对静默 run 无害。                                                                                                                                 |
| `slotless`                                                                                              | **默认不传（false），按需 true**     | false：占 `concurrencyLimit=6`（settings.ts）中的一个槽，获得 queue-timeout 保护（排队超预算 → `queue_timeout` 终态，零 hang 不变量保持）；**workflow 子女故意不 slotless 正是为此**（spawner-adapter.ts 51 行无 slotless）。true：`SingleSlotPool.acquire` 直接发 ticket（slot-pool.ts ≈40-43），池满也立即启动，但**没有排队超时保护**。建议：除非"池满也不能等"是硬需求，一律 false。注意非 slotless 时池满会推迟启动，排队预算耗尽的静默 run 会死于队列——这是保护不是 bug。 |
| `budgetOverride.totalMs`                                                                                | 强烈建议显式给                       | 不传则用全局预算 + watchdog 照常武装（有界，但那是全局默认值）。给了则 `applyBudgetPolicy` 钳成**硬顶**（`explicitTotal: true` → `maxTotalFactor=1`，无宽限无延长，spawn-service ≈425-431 附近调用）。fire-and-forget 的静默 run 没有人盯，**必须自带上限**，否则 abandoned run 会占槽活到全局预算尽头。                                                                                                                                                                        |
| `label`                                                                                                 | 可选，建议前缀                       | 唯一性自动派生（`deriveUniqueLabel`）；`isRunId` 防呆已有。注册进 mention（`onLabel` → `mention.register`）——可被 `@label` resolve 但**不进 root 直属 run 的自动补全列表**（补全只列 root 直属）。                                                                                                                                                                                                                                                                              |
| 其余（`resumeFrom`/`schema`/`modelOverride`/`thinkingOverride`/`isolation`/`deadlineAt`/`cwd`/`runId`） | 按需透传                             | 语义与普通 run 完全一致：resume 走 `resumeLocks` 双键互斥 + "still running → 拒绝并提示 steer"；`deadlineAt` 只收紧不放宽（CC4）；`schema` 走 X10 双重校验；`isolation:"worktree"` 照常可用。helper 不碰它们。                                                                                                                                                                                                                                                                  |

### 2.5 结果收集与收尾

```ts
// 非阻塞轮询（推荐给 fire-and-forget 场景）：
const r = await handle.wait(5_000); // {kind:"settled", outcome} | {kind:"pending"}
if (r.kind === "settled") useText(r.outcome.text);

// 或阻塞等待（helper 之外直接用 spawnAndWait —— 注意它强制 expectAck:true，无害）：
const outcome = await stack.spawn.spawnAndWait({ ...同上参数, parentRunId: ownerId });

// 快照 / 诊断（任何时刻）：
const snap = stack.query.get(handle.runId); // RunSnapshot：status/phase/deadlines/diag/parentRunId

// 收尸（owner 责任，workflow 同款）：
const { stopped, pending } = await handle.stopAll(); // stopChildrenOf(ownerId)
// OS4：pending 是"cascade 已发起但尚未真正 finish"的子 run，需稍后复查或 waitAll 兜底
```

不收尸的后果：静默 run 会自然跑完（预算/watchdog 兜底）、reaper 正常回收、`finish()` 自清
`childrenOf`/`parentOf`——不会泄漏，只是白烧预算。所以 `stopAll` 是"提前止损"而非"必须配对"。

### 2.6 内部代码如何拿到宿主侧服务

- **stack.ts 装配层内**（fabric ports、scheduler 接线等）：直接引用局部变量（`spawnRef`/构造
  参数），与 `buildFabric` 的 ports 同源。
- **index.ts 注册的 hook / 工具 / 命令内**：走 holder 模式——`requireStack(holder).spawn`
  （index.ts 620-637 行的 `forwardSpawn` 就是现成转发器；`holder` 在 149 行，每次
  `session_start` 重建，522-546 行 `session_shutdown` 排空）。
- **绝无第三条路**：子会话内的扩展实例因 HOST_KEY 守卫是 inert 的（index.ts 141 行
  `if (g[HOST_KEY]) return`），拿不到宿主 SpawnService——静默派生只能发生在宿主侧代码里。
- **/reload 边界**：holder 换新实例，但旧栈的 run 已在 session_shutdown 全部 stop（§3.1），
  异步代码握着旧引用只会看到终态 run，无悬挂危险；反之，跨 reload 存活是做不到的（§3.1）。

## 3. 坑、约束与残余风险（如实清单）

### 3.1 做不到的：活不过主会话（硬上限）

`src/index.ts` `session_shutdown`（**522-546 行**）对**所有**非终态 run 调
`query.stop(runId, "shutdown")`——`/reload`、`/new`、`/resume`、fork、quit 全部触发。bash job 有
跨会话收养（`handoffInProcess` / `adoptOrphans`），**subagent run 没有等价机制**。静默 run 的
寿命上限 = 宿主会话。若 fabric-v2 未来需要"跨 reload 存活的 revive"，那是新增工程（类似 bash
job 的收养链），不是本方案的接缝，明确出范围。

### 3.2 刻意不做的：不可见

CC2 只断"通知"，不断"可见性"。静默 run 仍然：

- 出现在 **fleet widget**（数据源 `QueryService.list()` → `buildFleetViewModel`，
  fleet-panel.ts 397 行 `nested: snapshot.parentRunId !== undefined` ——渲染为一条 nested 行，
  合成父 id 不是行节点，workflow 子女已长期如此渲染，无崩溃路径）与 **`/agent status`**；
- 发出 **`subagent:started`** 事件（stack.ts ≈1176 行，`pi.events.emit`，不触发 turn）；
- 被计入 **background-status 的 `runningSubagents`**（index.ts ≈151-160 行，按
  `["queued","starting","running","stopping"]` 数）→ 两个消费方：
  - feishu 完成卡门控（feishu-notify/core.ts 236 行：`runningSubagents === 0` 才发"任务完成"卡）；
  - cache-keepalive 的 `backgroundBusy`（stack.ts ≈1222 行，直读 `query.list()`）——静默 run 在跑
    时 keepalive 判忙。

  这通常是**正确**的（真有活在飞，此时报"任务完成"才是错的），但调用方必须知道。

- label 进 mention 命名空间（见 §2.4 label 行）。

隐藏它们（widget 过滤、计数剔除）需要动 `buildFleetViewModel` / background-status 组装，且会
剥夺用户对失控静默 run 的可见性和手动 abort 把柄——**A1 不做**，作为明确的非目标记录。

### 3.3 残余风险与坑

1. **X3 旁路是"被注释祝福"而非被类型保证**：spawn-service ≈324-334 行注释明确允许 foreign
   parentRunId，但任何未来收紧（比如"拒绝未知 parentRunId"）都会无声地破坏静默 run——必须用
   测试锁死该行为（§4 T1），并在该注释附近无权改动的前提下依赖它。
2. **`notifyTerminalFailure` 缺口修完前，S2 是"正常路径成立"**：修完（§2.3）后仍有理论残余——
   notifier 自身的 reconcile 重投只针对已入 outbox 的记录，而子 run 的记录根本没入过，无重投
   面；但若未来有人在 CC2 之前的效果解释器里再加旁路，静默就会破。测试 T3 锁住现有三条旁路。
3. **detachSignalOnStart ≠ 不死之身**：能杀静默 run 的完整清单：`abort(它自己)`、
   `stopChildrenOf(ownerId)`、watchdog 超时（全局/显式预算，**没有 per-run 关闭开关，也不该
   有**——零 hang 是项目不变量）、queue_timeout（非 slotless 排队超时）、session_shutdown、
   admission 时 signal 已 aborted。发起方的 turn 中止不在此列（这是 S3 的全部内容）。
4. **slotless 与排队超时的取舍**（§2.4 表）：非 slotless 可能死于 `queue_timeout`（保护），
   slotless 失去该保护。没有两全。
5. **owner 抛弃**：忘了 `stopAll` 不会泄漏（§2.5），但会白烧预算/槽位直到预算尽头——所以
   `budgetOverride.totalMs` 是强烈建议而非可选。
6. **quota 闸门照常适用**：spawn 准入会对 admitted model 跑 `quotaGate`（spawn-service ≈317-321），
   静默 run 会被额度快速失败拒绝——这是特性不是 bug；调用方要处理 `{error}` 返回。
7. **fabric 树边**：`onSpawnEdge(ownerId, runId)` 会往 fabric tree 加一条从合成节点出发的边
   （stack.ts 1126 行）——workflow 同款，tree 容忍 foreign 节点；`fabric.enabled=false` 时无此边。
   未来 fabric-v2 的 tree 溯源（D-11）会看到 `silent_*` 节点，展示层需把它当 owner 标注而非
   run 处理（v2 实施时注意）。
8. **`triggerTurn` 在 pi 核心的确切行为未验证**：本仓库只能从用法推断（quota/compact hint 用
   `triggerTurn:false` 表明 `true` 会唤醒）。对静默 run 无实际影响（它什么都不发），记录在案
   供 fabric-v2 的 W1 唤醒设计参考。
9. **深度记账**：静默 run 自身以 depth 0 进 nesting 表（带自己 type 的 canSpawn）——它**内部**
   再用嵌套 Agent 工具派生子 run 时走正常校验（depth 1，白名单查静默 run 的 type）。即静默
   run 不是"嵌套特权"的跳板，只是自己免检。
10. **RPC 外部面**：`rpc/protocol.ts` 45 行本就允许外部传任意 parentRunId——本方案没有扩大
    攻击面，但若将来想收紧 RPC，注意别把内部 `silent_*` 用法一起收掉。

## 4. 验证点（测试计划）

### T1 `tests/service/nesting.test.ts` 追加（或新文件 `tests/service/silent-run.admission.test.ts`）

复用该文件现成的 `controllableRunner()` + `typesRegistry()` harness（无 pi 依赖）：

- **合成父免检**：注册一个 `canSpawn: []`（谁都不能生）的 type A；先 spawn 一个 A 的真实 run
  P（顶层，allowed）；再以 `parentRunId: "silent_x"` spawn type B —— 断言**返回 runId 而非
  error**。对照组：以 `parentRunId: <P 的真实 id>` spawn B —— 断言 `error.kind === "config"`
  且 message 含 "nested delegation is not permitted"（锁定 X3 只认活父）。
- **深度**：以合成父 spawn 的 run，其 nesting depth 为 0——由"它内部再派生 depth 1 不被拒"
  间接断言（controllableRunner 下用 adapter 派生，或直接断言 grandchildren spawn 成功）。
- **真实父结束后**：settle P，再以 P 的 id 为 `parentRunId` spawn B —— 断言**通过**
  （`nesting.delete` 后同 depth 0，锁定"陈旧引用不受限"现状，防未来误收紧）。

### T2 `tests/service/h2-failure-visibility.test.ts` 同款 harness 新增静默用例

复用 `buildAdapter(clock, [ext], sink)`：

- **完成静默**：`runner.run(spec(type, { parentRunId: "silent_x" }))` → 正常 settle completed →
  断言 sink（notifications）**为空**。对照组（已有用例）：无 parentRunId → 恰好 1 条。
- **deadline 通知静默**：构造超时宽限场景，断言带合成父的 run 不产生 deadline notice
  （CC2 第三条旁路；参照 `tests/delivery/deadline-notice.test.ts` 的构造方式）。

### T3 `tests/service/silent-run.gap.test.ts`（§2.3 加固的锁定）

- controllableRunner 变体：`run()` 直接 `throw`；`deps.notifyTerminalFailure` 用 spy。
  - 带 `parentRunId` 的 run 抛异常 → 断言 spy **未被调用**（修复后行为）；
  - 无 `parentRunId` 的 run 抛异常 → 断言 spy 被调用（顶层安全网不回退）。
- 存量回归：`tests/integration/stack-terminal-failure.test.ts` 不需改（它直接调
  `deps.notifyTerminalFailure` 回调，测的是 stack.ts 侧回调本体，与调用点守卫正交）。

### T4 `tests/service/silent-run.test.ts`（helper 单测）

- `newSilentOwnerId()`：格式 `^silent_[0-9a-f]{20}$`、两次调用不同、不匹配 RunId 格式
  `^r_[0-9A-Z]+$`。
- `spawnSilentRun`：fake SpawnService 捕获请求 —— 断言 `parentRunId === ownerId`（silent_ 前缀）、
  调用方传入的 `parentRunId`/`expectAck`/`detachSignalOnStart` 被剥离覆盖、无 `signal` 时**不**
  设 `detachSignalOnStart`、有 `signal` 时设 `true`。
- error 透传：spawn 返回 `{error}` → 原样返回。
- handle 委托：`wait/stop/stopAll` 分别转发 `waitOutcome(runId, ms)` / `abort(runId, cause)` /
  `stopChildrenOf(ownerId, cause)`（参数逐个断言）。

### T5 `tests/runtime/`（detach 语义，若无既有覆盖则补）

- 传 `signal` + `detachSignalOnStart:true`：run 启动后 abort 该 controller → 断言 run **未被取消**
  （仍能正常 settle）；对照组不传 detach → abort controller 后 run 进入 stopping/终态。
- admission 前 aborted 的 signal + detach → 断言立即取消（边界锁定）。

### T6 `tests/integration/silent-run.test.ts`（端到端，走真 stack）

`sandboxHome()`（`tests/integration/helpers/home-sandbox.ts`，防真 key 发真请求——quota 记忆
里的测试卫生要求）+ `buildSessionStack` + 捕获 `pi.sendMessage` 的 fake ctx（参照
`tests/integration/context-receipt-wiring.test.ts` 的 sendMessage 捕获写法）：

- 静默 run（`spawnSilentRun(stack.spawn, {...})`）跑到 completed → 断言**从未**出现
  `customType === "subagent:notification"` 且 `details.runId === 静默 runId` 的 sendMessage
  （即零唤醒）；对照组普通 run → 恰好 1 次且 `options.triggerTurn === true`。
- 级联隔离：起一个真父 run + 一个静默 run；`query.stop(父id, "user_stop")` → 断言静默 run
  snapshot 仍非终态；随后 `handle.stopAll()` → 断言静默 run 终态为 aborted。
- session_shutdown：触发 shutdown → 断言静默 run 被 stop（cause "shutdown"）——**把 §3.1 的
  硬上限作为行为锁定下来**，防止未来误以为它是 bug 去"修"。

**lockstep 检查**：本方案不改 `src/core/state-machine.ts` 与 delivery 生命周期 →
AGENTS.md 要求的转移矩阵/属性测试**无需**更新（明确记录，避免误判漏改）。

## 5. 实施顺序与工作量

| 步骤 | 内容                                                                      | 规模          |
| ---- | ------------------------------------------------------------------------- | ------------- |
| 1    | §2.3 加固（spawn-service.ts 243 行守卫）+ T3                              | ~5 行 + 测试  |
| 2    | `src/service/silent-run.ts` helper + T4                                   | ~60 行 + 测试 |
| 3    | T1/T2 用例补充（嵌套豁免与通知静默的行为锁定）                            | 测试 only     |
| 4    | T5 detach 边界（若已有覆盖则跳过）+ T6 集成                               | 测试 only     |
| 5    | （fabric-v2 实施期）D-9 auto-revive / §6.3 root 应答改用 `spawnSilentRun` | 消费侧        |

验收口径：T1–T6 全绿 + `npm run typecheck` + `npm test` + `npm run build`（CI 四件套）。

## 附录 A. 行号索引（f9ac1c2）

| 接缝                                                     | 文件:行                                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| X3 嵌套校验（只认 nesting 表中的活父）                   | `src/service/spawn-service.ts:322-357`                |
| childrenOf/parentOf 登记（仅当带 parentRunId）           | `src/service/spawn-service.ts:425-441`                |
| `finish()` 清 nesting/childrenOf                         | `src/service/spawn-service.ts:132-148`                |
| `spawnAndWait` 强制 expectAck                            | `src/service/spawn-service.ts:445-447`                |
| `abort()` 先级联后自杀                                   | `src/service/spawn-service.ts:528-535`                |
| `stopChildrenOf`（合成父唯一停止入口）                   | `src/service/spawn-service.ts:536-547`                |
| **notifyTerminalFailure 调用点（待加固）**               | `src/service/spawn-service.ts:243`                    |
| CC2 入集判据 `parentRunId !== undefined`                 | `src/service/runtime-adapter.ts:338`                  |
| CC2 拦 enqueue_delivery                                  | `src/service/runtime-adapter.ts:230-236`              |
| CC2 拦 config-failure                                    | `src/service/runtime-adapter.ts:306-345`              |
| CC2 拦 deadline notice                                   | `src/service/runtime-adapter.ts:102-108`              |
| cancel handle → onChildAbort（任何取消都级联）           | `src/runtime/runner.ts:390-412`                       |
| `detachSignalOnStart` → `cancel.detach()`                | `src/runtime/runner.ts:414`                           |
| onChildAbort 接线到 spawnService.abort                   | `src/stack.ts:1079`                                   |
| `sendFormatted` → sendMessage(triggerTurn:true)          | `src/stack.ts:911-957`                                |
| onOutcomeAcked → notifier.ack                            | `src/stack.ts:1127-1133`                              |
| notifyTerminalFailure 回调本体                           | `src/stack.ts:1134-1167`                              |
| onSpawnEdge（fabric 树边）                               | `src/stack.ts:1126`                                   |
| `subagent:started` 事件                                  | `src/stack.ts:1176`                                   |
| holder / background-status                               | `src/index.ts:149-160`                                |
| session_shutdown 停所有非终态 run                        | `src/index.ts:522-546`                                |
| forwardSpawn（holder 转发器）                            | `src/index.ts:624-638`                                |
| workflow 子女 spawn（合成父先例）                        | `src/workflow/host.ts:599-606`                        |
| workflowId 格式 `wf_<20hex>`                             | `src/tools/workflow-tool.ts:398`                      |
| workflow 收尸 stopChildrenOf                             | `src/workflow/host.ts:868-871`                        |
| Agent 工具 run_in_background detach 先例                 | `src/tools/agent-tool.ts:283-292`                     |
| THREADED 穿透白名单                                      | `src/service/request-threading.ts:26`                 |
| slotless 直发 ticket                                     | `src/runtime/slot-pool.ts:40-43`                      |
| 默认值（concurrency 6 / ackWindow 0 / maxNestedDepth 3） | `src/config/settings.ts:376-389`                      |
| RunId 格式 `r_XXXXXXXX`                                  | `src/core/ids.ts:13-21`                               |
| RPC 允许任意 parentRunId                                 | `src/rpc/protocol.ts:45`                              |
| cron 裸 spawn（反例）                                    | `src/schedule/scheduler.ts:74`                        |
| fail-open 官方承认                                       | `docs/dev/delivery-v2/architecture.md:192-193`        |
| CC2 行为既有锁定测试                                     | `tests/service/h2-failure-visibility.test.ts:188-202` |
