# 静默后台 run（silent background run）实施方案

状态：设计定稿，待施工。前置探索交接包：`/tmp/exp_hold/handoff-full.json`（本文所有行号均已在当前 HEAD 复核）。

## 0. 需求与一句话结论

扩展内部（宿主侧）代码需要派生一种 run，同时满足：

1. **不触发嵌套委派校验**（canSpawn 白名单 + maxNestedDepth 深度上限）；
2. **不产生顶层完成通知**，不唤醒主会话起一轮模型调用；
3. **不被发起方取消级联杀掉**（发起方 run 被取消/超时/user_stop 时，静默 run 独立存活）。

**结论：现有接缝已完整覆盖三点，核心机制就一个——用「合成 parentRunId」（不是任何真实 run 的 id）调用宿主侧 `SpawnService.spawn()`。** 这正是 `SubagentWorkflow` 子女 run 的既有做法（`src/workflow/host.ts` ~L599-606，`parentRunId = workflowId`）。本方案把它封装成一个防误用的 helper（`src/service/silent-spawn.ts`），并补一个已发现的潜伏通知泄漏点（§2.4）。

三个需求与合成 parentRunId 的对应关系：

| 需求         | 接缝                                                                                                         | 合成 parentRunId 起的作用                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 免嵌套校验 | `spawn-service.ts` `spawn()` X3 段（~L334-357）                                                              | 校验只在 `nesting.get(req.parentRunId)` 命中「本服务正在跟踪的活 run」时触发；合成 id 永远 miss → depth 0、零白名单检查                                                  |
| 2 无顶层通知 | `runtime-adapter.ts` CC2（`childRunIds`，~L230-236/307/338/107）                                             | CC2 的判定就是 `spec.request.parentRunId !== undefined`（与父是否真实 run 无关）→ `enqueue_delivery`/config-failure/deadline 宽限三类通知全部被丢弃，**根本不进 outbox** |
| 3 免级联取消 | `spawn-service.ts` `childrenOf/parentOf`（~L430-441）+ `runner.ts` cancel handle `onChildAbort`（~L390-412） | 级联遍历的是 `childrenOf.get(发起方runId)`；静默 run 挂在合成 id 下，不在任何真实 run 的子女集合里                                                                       |

X3 段源码注释（`src/service/spawn-service.ts` ~L326-334）明确认可这一语义：untracked/foreign `parentRunId` 被当作「纯展示标签的历史用法，仍受支持」，按 depth 0 放行——**这是被设计文档化的行为，不是钻空子**。RPC 协议的 `SpawnParams` 本就允许任意 `parentRunId` 字符串（`src/rpc/protocol.ts` L45），说明该能力在外部调用面已经默认存在，本方案只是给内部代码一个安全的封装。

---

## 1. 机制分析（已逐条核实）

### 1.1 嵌套校验为何不触发（点 1）

校验位于 `src/service/spawn-service.ts` 的 `spawn()` 内（X3 段，~L334-357）：

```ts
let depth = 0;
if (req.parentRunId) {
  const parent = nesting.get(req.parentRunId);
  if (parent) {                       // ← 只有命中「活的、被本 SpawnService 跟踪的 run」才进校验
    if (!parent.canSpawn?.includes(req.type)) return { error: { kind: "config", ... } };
    depth = parent.depth + 1;
    if (depth > maxNestedDepth) return { error: { kind: "config", ... } };
  }
}
```

- `nesting` 表只含本服务 `spawn()` 出的真实 run（id 由 `src/core/ids.ts` `newRunId()` 生成，格式恒为 `r_[0-9A-HJKMNP-TV-Z]{8}`）。合成 id（如 `silent-<purpose>`，见 §3.1）格式不同且从未入表 → `nesting.get()` 恒为 `undefined` → depth 0 直接通过，**连发起方 agent type 的 canSpawn 都不会被读**。
- 静默 run 自身会被 `nesting.set(runId, {depth: 0, ...canSpawn})`（~L435）登记为 depth 0：它若通过注入的嵌套 Agent 工具派生子 run，走它**自己类型**的白名单（`runtime-adapter.ts` 的工具注入路径强制 `parentRunId = 本 run id` + `slotless`）。无提权面。
- 反面对照（坑）：**如果把 parentRunId 设为真实发起方 run 的 id**，发起方类型必须有 `canSpawn` 白名单且深度不越线，且静默 run 会进入发起方的 `childrenOf` → 三点中的第 1、3 点同时失败。**绝对不要这么传。**

### 1.2 顶层通知为何不发出（点 2）

通知全链路：`src/core/state-machine.ts` `finish()` 对每个终态无条件产出 `enqueue_delivery` 效果 → `src/service/runtime-adapter.ts` 的效果解释器 → `src/delivery/notifier.ts` outbox → `src/stack.ts` `sendFormatted`（~L911-958）→ `pi.sendMessage({customType: "subagent:notification", ...}, {triggerTurn: true})`。`triggerTurn: true` 就是「唤醒主会话起一轮模型调用」的机制（compact-hint/quota 刻意用 `triggerTurn: false` 以免唤醒，反证其效力）。

唯一的「谁的完成通知进主会话」过滤点就是 **CC2**（runtime-adapter.ts）：

```ts
const childRunIds = new Set<string>();
// run() 入口（L338）：CC2 判定条件就是 parentRunId !== undefined，与父是否真实无关
if (spec.request.parentRunId !== undefined) childRunIds.add(spec.runId);
```

`childRunIds` 命中时拦截三类通知，**在 `notifier.enqueue` 之前直接 return**（L230-236）：

1. **终态完成通知**（`enqueue_delivery` 效果，L230-236）；
2. **config-failure 通知**（`settleConfigFailure`，L307）；
3. **deadline 宽限/延长通知**（`deadlineNoticeHandler`，L104-108——这是 exported 函数，可直接单测）。

因为拦截发生在 enqueue 之前，**outbox（含其持久化 store）里根本没有这个 run 的记录**，跨会话的 reconcile 重投也不可能复活它。

已锁定该行为的现有测试：`tests/service/h2-failure-visibility.test.ts`（带 parentRunId 的 config-failure 不产生任何通知）、`tests/service/nesting.test.ts`。

**不要走 expectAck 路线**：`spawnAndWait`/`waitOutcome` 的 ack（`stack.ts` ~L1127-1133 `onOutcomeAcked → notifier.ack`）默认配置下抢不过发送——`ackWindowMs`/`coalesceWindowMs` 默认均为 0（`src/config/settings.ts` ~L376-389），`notifier.enqueue → attempt → send` 是同一同步链，先于任何 ack 微任务执行，fail-open 照发通知（`docs/dev/delivery-v2/architecture.md` L192-193 官方承认）。CC2 是结构性断路，expectAck 只是概率性抑制——两者可靠性完全不同量级。

### 1.3 取消级联为何杀不到它（点 3）

级联的数据基础：`spawn-service.ts` ~L430-441——**仅当请求带 `parentRunId` 时**才登记 `parentOf(runId)` / `childrenOf(parentRunId)`。两条触发链都以 `childrenOf` 为准：

- **链 a（owner 显式中止）**：`spawnService.abort(runId)`（abort_subagent 工具、`stopChildrenOf` 之外的一切入口）先 `cascadeChildren(runId)` 再杀自身（~L528-543）；
- **链 b（父 run 因任何原因取消）**：`runner.ts` ~L390-412——任何取消原因（user_stop/timeout/external/shutdown）都触发 `onChildAbort(runId, "parent_abort")`，经 `stack.ts` ~L1079 接线到 `spawnService.abort(runId)` 再级联。**即发起方 run 超时、被用户停、被 watchdog 杀，都只级联 `childrenOf.get(发起方runId)` 里的子女。**

静默 run 挂在合成 id 下：`childrenOf.get(真实发起方id)` 不含它 → 两条链都够不着。它能被杀的途径只剩：显式 `abort(它自己的runId)`、owner 调 `stopChildrenOf(合成id)`、它自己的 watchdog 预算、session_shutdown（§4.2）。

**外部信号（Esc/turn 中止）**：不传 `signal` 即无链接。若在主会话 turn 上下文内发起（如某工具回调里），传调用点的 turn signal + `detachSignalOnStart: true`——`runner.ts` L414 在 cancel handle 创建后立即 `cancel.detach()`（解绑外部 listener）。`src/core/types.ts` L176-188 的字段注释明确说明这是为 fire-and-forget 后台 spawn 设计的（`src/tools/agent-tool.ts` ~L283-292 `run_in_background` 是现成先例）。注意它**只解除外部 listener**；走 `activeCancels` 的路径（abort_subagent、watchdog 超时）不受影响；admission 前已 aborted 的 signal 仍会立即取消（`createCancelHandle` 的已中止检查不受 detach 影响）。

---

## 2. 落地改动清单（文件 × 函数）

改动总量：**新增 1 个模块 + 2 处接线 + 1 个一行防御修复 + 测试**。不动状态机、不动 delivery、不动 runner。

### 2.1 新增 `src/service/silent-spawn.ts`（核心，pi-free）

与 `spawn-service.ts` 同层、只依赖 `SpawnService` 类型与 `src/core/types.ts`，无 pi import → 可直接用 `tests/service/nesting.test.ts` 的 harness 单测。API 草案：

```ts
import type { SpawnService } from "./spawn-service.js";
import type { BoundedWaitResult } from "../core/types.js"; // 实际从 spawn-service/ports re-export 的类型

/** 合成父 id。真实 run id 恒为 r_[0-9A-HJKMNP-TV-Z]{8}（core/ids.ts），本前缀零碰撞。 */
export const SILENT_PARENT_PREFIX = "silent-";

export interface SilentSpawnerDeps {
  spawn: Pick<SpawnService, "spawn" | "stopChildrenOf" | "waitOutcome" | "waitAll">;
}

export interface SilentSpawner {
  /** 本实例的合成父 id（确定性：`silent-<purpose>`），也即 stopChildrenOf 的 owner 句柄。 */
  readonly parentRunId: string;
  /** 派生一个静默 run。req 内不应再出现 parentRunId/signal/expectAck（见 §3 约定）。 */
  spawnSilent(req: Omit<SpawnRequest, "parentRunId" | "expectAck">): Promise<{ runId: string } | { error: ErrorInfo }>;
  /** 非阻塞取结果（内部 stopChildrenOf 收尸时也用它确认）。 */
  waitOutcome(runId: string, waitMs?: number): Promise<BoundedWaitResult>;
  /** owner 收尸：循环 stopChildrenOf + waitAll 清 OS4 pending，有界重试。 */
  stopAll(cause?: StopCause): Promise<void>;
}

export function createSilentSpawner(deps: SilentSpawnerDeps, purpose: string): SilentSpawner;
```

实现要点：

- `spawnSilent` 内部固定注入 `parentRunId: this.parentRunId`（`silent-<purpose>`，确定性、每用途一个），调用方**无法**误传真实发起 run 的 id（类型层面 `Omit` 掉 `parentRunId`）。`purpose` 做合法性检查（`/^[a-z0-9-]+$/`，防调用方把任意字符串当 purpose 塞进 id）。
- `detachSignalOnStart`: 若调用点给了 `signal`，helper 强制同时置 `detachSignalOnStart: true`（把「传了 signal 忘了 detach」这个坑在封装层堵死）；不给 signal 就两个字段都不传。
- `stopAll`：`stopChildrenOf(parentRunId, cause)` 返回的 `pending` 是尚未真正 settle 的子女（OS4 语义：cascade 的 `service.abort` 不立即从 `childrenOf` 摘除，只有最终 `finish()` 才摘），因此循环 `{ stopChildrenOf → waitAll({runIds: pending, waitMs: 2s}) }` 直至 pending 空，上限 3 轮防死循环（收不干净就 warn 并返回，供调用方诊断）。
- 语义边界（写进模块 doc comment）：helper **不提供跨会话存活**（§4.2）、**不隐藏可见性**（§4.4）。

### 2.2 接线 `src/stack.ts`（`buildSessionStack`）

- 在 `createScheduler({ spawn })`（~L1358）附近构造并持有：`const silentSpawner = createSilentSpawner({ spawn }, "<feature-purpose>")`——按第一个使用方定 purpose；多个特性各自实例化（合成父 id 不同，收尸互不干扰）。
- `Stack` 接口（~L487 附近的类型声明）加 `silentSpawner: SilentSpawner` 字段并返回（~L1453 的返回对象处）。
- session_shutdown 不需要改：现有清理（`src/index.ts` ~L543-547 对所有非终态 run `query.stop(runId, "shutdown")`）已覆盖静默 run，这是**有意保留**的存活上限（§4.2）。

### 2.3 （可选）`src/index.ts` holder 暴露

若使用方是 index.ts 装配的外围特性（非 stack 内部），经 `holder.current?.silentSpawner` 取（与 L175-176 `keepalive()/adaptive()` 同款转发模式）。**只有宿主侧实例需要**：子会话内的扩展实例因 `HOST_KEY` 守卫是 inert 的，拿不到 stack——静默派生天然只能由宿主侧代码发起（这是边界不是缺陷，见 §4.6）。

### 2.4 防御修复：`src/service/spawn-service.ts` `start()` 的 catch 安全网（~L243）

**已发现的潜伏缺口**：`start()` 里 `await deps.runner.run(...)` 抛异常时，catch 分支 `finish(failed)` 后调用 `deps.notifyTerminalFailure?.(failed)`（L243）→ `stack.ts` ~L1134-1167 的实现**不查 childRunIds** → 静默 run（以及今天的一切子 run）在这条异常路径上仍会发顶层通知并唤醒主会话，违反点 2。

- 可达性：需要效果解释器/reducer 在 adapter 的 catch 路径上再次抛错，正常代码路径构造不出（交接包 openQuestion #2，未验证可实际触发）——属**潜伏缺陷**，但点 2 的正确性不该依赖「异常不会发生」。
- 修法（一行，最小改动）：在 `spawn-service.ts` L243 按 CC2 的同一谓词设门：

```ts
if (req.parentRunId === undefined) deps.notifyTerminalFailure?.(failed);
```

`req` 此处是 `ResolvedSpawnRequest`，`parentRunId` 经 `src/service/request-threading.ts` 穿透保留（该文件表白名单含 parentRunId）。不选「让 stack.ts 的实现自查 childRunIds」——那个 Set 在 adapter 闭包里，stack 够不着；在调用点按谓词设门与 CC2 语义完全一致。

### 2.5 不需要改的部分（明确排除）

- `src/core/state-machine.ts`：`finish()` 无条件产出 `enqueue_delivery` 是对的——CC2 在解释器层过滤，状态机保持无 per-run 开关（不动转移矩阵 → 无需改 matrix/property 测试，符合 AGENTS.md 的 lockstep 要求）。
- `src/delivery/`（notifier/coalescer/engine）：CC2 在 enqueue 之前断路，delivery 层无需感知。
- `src/runtime/runner.ts`：`detachSignalOnStart` 现成；`onChildAbort` 级联行为保持（它就是点 3 靠「不在集合里」躲开的对象）。
- watchdog/reaper：无 per-run 关闭开关，静默 run 照常武装预算（§4.3 讲如何调预算）。

---

## 3. 可直接落地的调用配方

### 3.1 派生

````ts
// 前置：宿主侧代码（stack 内部服务，或经 index.ts holder），持有一个
// createSilentSpawner({ spawn: stack.spawn }, "memory-refresh") 实例。

const started = await silent.spawnSilent({
  type: "general-purpose", // ① 必填：agent-type registry（src/config/agent-types.ts）里真实存在的类型
  //    （内置兜底 BUILTIN_AGENT_TYPES 含 "general-purpose"；仓库 .pi/agents/ 下
  //    有 reviewer/verifier 等可用；专用静默任务可新增一个 .md 类型，
  //    建议 frontmatter 不写 canSpawn——静默 run 不该再委派）。
  prompt: "<完整任务指令，静默 run 的结果只会回给调用方代码，不会进主会话上下文，指令需自包含>",
  //    ② 必填：自包含性比普通 run 更重要——没有完成通知兜底，调用方
  //    只能靠 waitOutcome/query.get 拿结果，模型无处追问澄清。
  // parentRunId: —— 由 helper 强制注入 "silent-memory-refresh"。
  //              ③ 三点全靠它：X3 nesting miss（点1）、CC2 childRunIds 命中（点2）、
  //              不进任何真实 run 的 childrenOf（点3）。绝不手工传真实发起 run 的 id。
  label: "mem-refresh-20260924",
  //    ④ 可选：省略则 spawn() 会派生默认 label（同样注册）。
  //    给了就给唯一值——labels 唯一，撞名会被加后缀。
  //    label 注册进 mention registry 无害：@ 自动补全只列 root 直属 run，
  //    但 resolve 仍可命中（特性不是 bug，见 §4.4）。
  // signal: turnSignal,     // ⑤ 仅当在 turn 上下文内发起才传（工具回调/agent_settled 钩子等）；
  //    helper 会强制配 detachSignalOnStart:true（⑥），Esc/强制压缩不再波及。
  //    宿主侧无 turn 上下文（cron 式、session_start 式）则两个字段都不传——
  //    无链接即无解绑必要。
  // detachSignalOnStart:    // ⑥ 不手传；helper 在「传了 signal」时自动置 true。
  //    语义见 core/types.ts L176-188 注释：只解绑外部 listener，
  //    activeCancels 路径（abort_subagent/watchdog）不受影响。
  // slotless: false,        // ⑦ 默认不传（false）：占并发池槽（concurrencyLimit=6，
  //    src/runtime/slot-pool.ts），享排队超时保护——与 workflow 子女 run 的
  //    故意选择一致（保留背压）。仅当「池饱和也必须立即启动」时才 true：
  //    SingleSlotPool 直接发票、无排队保护，静默 run 数量将不受池约束
  //    （每个都是独立子会话 + 模型调用，别无限开）。
  // budgetOverride: { totalMs: 30 * 60_000 },
  // ⑧ 可选：不传则用全局预算，watchdog 照常武装（含子阶段预算）。
  //    需要长于全局 totalMs 的后台任务才传；注意 D-10：显式 totalMs
  //    ⇒ 硬顶（maxTotalFactor=1，无宽限无延长）。也可用 deadlineAt
  //    （绝对墙钟，只收紧不放松）。
  // expectAck:              // ⑨ 不传（false）。CC2 已结构性断路通知，ack 无意义；
  //    spawnAndWait/waitOutcome 触发的 notifier.ack 是 try/catch 包的
  //    best-effort no-op（stack.ts L1127-1133），无害但也没必要主动开。
  // schema: {...}           // ⑩ 可选：X10 结构化输出。注意已知坑（memory: agent-tool-schema-bug）：
  //    必须传 JSON Schema **对象**（字符串会变成字符索引垃圾且延迟爆炸）；
  //    或干脆不传 schema、在 prompt 里要求 ```json 块、调用方自行 parse。
  // resumeFrom:             // ⑪ v1 不用：resume 走同一准入（目标在跑会拒绝），且 resolveResumeTarget
  //    只认本服务已知 run 的 id/前缀/label，不认任意路径。
});
if ("error" in started) {
  /* config 错误（未知类型/模型/额度闸门），照常处理 */
}
````

### 3.2 收结果（非阻塞，不要用 spawnAndWait）

```ts
// 有界等待（到期返回 { kind: "pending" } 不抛错；timer unref，不挂 print 模式）：
const r = await silent.waitOutcome(runId, 5_000);
if (r.kind === "settled") useOutcome(r.outcome);

// 或轮询快照（含 status/outcome/di）：
const snap = stack.query.get(runId);
```

**不要 `spawnAndWait`**：它阻塞调用点并强制 `expectAck`（`spawn-service.ts` L445-447），后台语义下两者都不对。

### 3.3 owner 收尸（唯一合法的批量停止入口）

```ts
await silent.stopAll("user_stop"); // 循环 stopChildrenOf("silent-<purpose>") + waitAll 清 pending
```

`abort(合成id)` 无效（`running.has` 首行 guard 返回 false）——`stopChildrenOf` 就是为「父不是 tracked run」设计的 owner 停止入口（接口注释 CC1/OS1-OS4 原文）。这正是 workflow 用 `stopChildrenOf(workflowId)` 收尸的同款机制。

---

## 4. 坑、约束与残余风险（做不到的如实说）

### 4.1 必死路径仍然存在（不是缺陷，是边界）

静默 run 会被以下途径杀掉，**无法也不应该防御**：

- 它自己的 watchdog 预算超时（§3.1 ⑧ 可调）；
- 显式 `abort_subagent`/`abort(它自己的 runId)`（用户在 /agent 面板/工具层可见它，见 §4.4）；
- `stopAll`/`stopChildrenOf(合成id)`（owner 收尸，特性不是缺陷）；
- **session_shutdown**：`src/index.ts` ~L543-547 对所有非终态 run `query.stop(runId, "shutdown")`——`/reload`、`/new`、`/resume`、fork、quit 全部触发。**静默 run 活不过主会话本身**，这是硬上限。bash job 有跨栈收养（`handoffInProcess`/`adoptOrphans`）而 subagent run 没有等价机制；若未来要求 /reload 后存活，那是新增工程（跨栈收养/持久化 run 注册表），不在本方案范围。**调用方必须把静默 run 视为「本会话内的一次性后台任务」设计**（结果落盘，重启后由使用方自查补跑）。
- 进程退出。

### 4.2 通知抑制的一个残余路径（修复前）

§2.4 的 `notifyTerminalFailure` 缺口：在修复落地前，`runner.run` 抛异常的静默 run 会在顶层发一条通知。正常路径不可达（需要 adapter 内部 bug 才能触发），但**点 2 的严格满足依赖 §2.4 的一行修复**——实施时与 helper 同 PR 落地。修复后的残余风险为零（CC2 三类 + 安全网四路通知全部有门）。

### 4.3 预算与排队

- 不传 `budgetOverride` → 全局预算 + watchdog 子阶段预算照常武装；静默 run 挂死照样被 watchdog 收掉（零挂保证的受益者，不是受害者）。
- 传显式 `totalMs` ⇒ D-10 硬顶语义（无宽限无延长），想保宽限就调全局预算而不是 per-run override。
- 非 slotless 的静默 run 在池饱和时排队，可能死于排队超时（`queueWaitMs`）——「必须启动」优先则 slotless（代价见 §3.1 ⑦）。

### 4.4 可见性副作用（点 2 只断「不通知」，不断「不可见」）

静默 run **仍然可见**，这是残余事实，调用方与用户要知道：

- **fleet widget / `/agent status`**：出现，父是合成 id（渲染为孤儿/顶层组，与 workflow 子女同款观感——交接包 openQuestion #3 未实际启动 UI 验证过视觉效果，属低风险展示问题）；
- **`subagent:started` 等 lifecycle 事件**：照发（display 平面，不触发模型 turn）；
- **background-status 的 `runningSubagents` 计数**（`src/index.ts` ~L149-157）：包含它 → **feishu 完成卡被继续抑制**（busy 门控）、**cache-keepalive 的 busy 判定**把它算进去——大概率是期望行为（它确实在耗资源），但两个消费方的语义都被它影响；
- **HUD 成本行**：它的 live 成本照常累加进 subagent 成本显示；
- **label/mention**：注册可 resolve，@ 补全不列（只列 root 直属）；
- **fabric tree**：`onSpawnEdge(合成id, runId)` 加边（与 workflow 相同）；沿树路由的 `message_agent` 默认「只可达父」→ 父是合成节点，**静默 run 基本收不到 fabric 消息**——不要把 fabric 通信设计进静默 run 的调用面。

### 4.5 并发与孤儿收尸的竞态

- `stopChildrenOf` 与子 run 尚在 `start()` 异步启动段之间存在竞态：cascade 一轮可能漏掉刚入表的孩子——`stopAll` 的循环 + `waitAll`（OS4 快照扫尾）就是为它设计的，测试要覆盖（§5 T6）。
- 合成父 id 按 purpose 确定性生成：同一进程内两个同 purpose 的 spawner 实例共享 `childrenOf[silent-x]` 集合，`stopAll` 会互相误伤——**约束：每个 purpose 全栈只建一个实例**（在 `buildSessionStack` 里集中构造，不放权给特性模块自建）。

### 4.6 使用边界：只能宿主侧发起

- 子会话（subagent run）内的扩展实例因 `HOST_KEY` 守卫 inert，拿不到 SpawnService——**模型在子 run 里无法派生静默孙 run**。这是点 1 的自然边界：X3 防的就是模型绕过白名单，「内部代码的静默派生」与「模型的静默派生」是两回事，本方案只开前者（合理：内部代码是扩展作者写的，不是模型沙箱逃逸面）。
- 嵌套 Agent 工具注入路径（runtime-adapter，canSpawn 驱动）强制 `parentRunId=本 run id` + `slotless`，**无法**借它做静默派生——静默派生必须直接持宿主侧 `SpawnService`。

### 4.7 其它已知小坑

- **schema 参数**：传字符串会延迟爆炸成字符索引对象（memory: agent-tool-schema-bug），只传 JSON Schema 对象，或走 prompt+自行 parse 的绕过路线。
- **pi 端 `triggerTurn` 行为**：本方案不依赖它（CC2 根本不发 sendMessage），交接包 openQuestion #1（pi 核心对空闲/忙碌会话的唤醒差异）对本案无影响。
- **`/reload` 后 `holder` 指新栈**：静默 run 已被 shutdown 杀掉，旧 spawner 实例随旧栈作废——不要缓存 spawner 引用跨会话使用。

---

## 5. 验证点（测试怎么写、断言什么）

新增三个测试文件 + 一处现有回归确认。harness 复用 `tests/service/nesting.test.ts` 的 `controllableRunner()`（手动 settle 的 Runner）+ `typesRegistry()`（内存 agent-type 注册表）模式，`pool` 用无条件发票的 fake。

### T1 `tests/service/silent-spawn.test.ts` — helper 行为（spawn-service 层）

- **T1.1 免嵌套校验（点1）**：注册一个**无 canSpawn** 的类型 `"worker"`（`canSpawn` 字段缺失）+ `maxNestedDepth: 0`；`createSilentSpawner(..., "test").spawnSilent({type:"worker", prompt:"x"})` → 返回 `runId` 无 error。对照断言（已有 `nesting.test.ts` 锁定，此处只做差异）：把 `parentRunId` 手工指向一个活 run 的受限类型 → config error——证明合成父与真实父行为分叉。
- **T1.2 合成父登记正确**：spawn 后 `svc.stopChildrenOf("silent-test")` 能拿到该 runId（即 `childrenOf` 挂对了地方）；同时 `svc.abort(发起场景里任何真实runId)` 的 abortCalls 不含它。
- **T1.3 signal 强制 detach**：传已**未**中止的 signal → 请求里带 `detachSignalOnStart: true`（对 runner 的 fake 记录 spec 断言）；不传 signal → 两字段皆缺席。
- **T1.4 purpose 合法性**：`createSilentSpawner(deps, "Bad Purpose!")` 抛错（防 id 注入空格等）。
- **T1.5 stopAll 扫尾**：起 2 个静默 run，其中一个手动 settle（模拟已完）、一个不 settle；`stopAll()` → 未 settle 的收到 abort（abortCalls 断言），且循环在 pending 清空后退出。

### T2 `tests/service/silent-spawn-cascade.test.ts` — 点 3 核心断言

- **T2.1 发起方取消不级联**：先 spawn 真实发起 run I（手动不 settle），再 `spawnSilent` 得 S；`svc.abort(I.runId, "timeout")` → `abortCalls` 含 `I` 不含 `S`；`S` 的 settle 回调仍在 pending map（即未被要求结束）。同理断言 `cause: "user_stop"`。
- **T2.2 runner 级 onChildAbort 接线**（若在 spawn-service 层 runner 是 fake，接线在 stack 层——此条挪到 T3）：stack 级断言发起方 run 因 timeout 被 watchdog/stop 杀掉后，silent run 仍 running。

### T3 `tests/integration/silent-spawn.e2e.test.ts` — 全链路（buildSessionStack + fake pi）

**必须 `sandboxHome()`**（`tests/integration/helpers/home-sandbox.ts`）——直接调 `buildSessionStack` 的测试不沙箱会读到家目录真实配置/key（本仓库既有教训）。

- **T3.1 无顶层通知（点2，最强断言）**：fake pi 记录全部 `sendMessage` 调用；spawnSilent → settle（真实 runner 或可控 fake）→ 断言所有消息里**没有** `customType === "subagent:notification"` 且 `options.triggerTurn === true` 的组合；进一步断言 notifer 层无该 run 的 delivery key（`peek` 不可达则断言 sendMessage 全集）。连同 deadline 通知：把预算调小触发宽限 → 断言无 `subagent:timeout` 类注入。
- **T3.2 不唤醒主会话**：fake pi 上 `triggerTurn:true` 的调用计数为 0（跨整个静默 run 生命周期）。
- **T3.3 级联存活（点3 全链路）**：起一个普通 run I（作为「发起方」占位，用工具或直接 spawn），起静默 run S；`stack.query.stop(I.runId, "timeout")`（走真实 onChildAbort 接线）→ 断言 `stack.query.get(S.runId).status` 仍为 running/starting，最终手动 settle S 成功完成。
- **T3.4 Esc 免疫（detachSignalOnStart）**：在带 turn signal 的上下文 spawnSilent（signal 由测试构造）→ `signal.abort()` → 断言 S 仍 running。对照：admission 前 signal 已 aborted → run 立即取消（语义保持）。
- **T3.5 session_shutdown 边界锁定**：触发 shutdown 钩子 → 断言 S 被 stop（把 §4.1 的「必死路径」作为**契约**固化，防止未来有人误以为它是 bug 而「修复」掉）。

### T4 `tests/service/`（并入 h2 或新文件）— §2.4 修复锁定

- runner.run 直接 reject；`parentRunId` 有值（合成 id）→ 断言 `deps.notifyTerminalFailure` **未**被调用；`parentRunId` 缺席 → 仍被调用（安全网对顶层 run 保持）。修复前先写红测（文档化缺口），再落一行修复转绿。

### T5 现有回归

- `tests/service/nesting.test.ts`、`tests/service/h2-failure-visibility.test.ts` 必须保持绿（CC2/X3 语义未变，只是新增消费者）。
- 状态机未动 → `tests/core/` 转移矩阵与 property 测试无需改动（AGENTS.md lockstep 要求的自然满足）。

### 门禁

`npm run format:check && npm run typecheck && npm test && npm run build`（CI 四连，AGENTS.md 要求）；`exactOptionalPropertyTypes` 开着——helper 里条件展开字段用 `...(x !== undefined ? { x } : {})` 模式（与 `spawn-service.ts` 现有代码一致）。

---

## 6. 施工顺序与规模

1. `silent-spawn.ts` helper + T1/T2（纯新增，可独立合并）；
2. §2.4 一行修复 + T4 红转绿（独立小 PR 亦可先行——它对今天的 workflow 子女 run 同样是正确性修复）；
3. stack 接线 + T3 集成；
4. （首个使用方接入时）新增专用 agent type `.md`（若需要）+ `docs/dev/` 设计文档归档。

总量估计：helper ~80 行 + 修复 1 行 + 接线 ~10 行 + 测试 ~300 行。无生产代码行为变更（除 §2.4 修复），风险集中在「约束被误用」（真实 run id 作父、跨会话缓存 spawner）——全部由 helper 的类型层面（`Omit`）与 §4.5 的集中构造约束堵住。
