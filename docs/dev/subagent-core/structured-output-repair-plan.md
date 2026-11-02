# 方案（修订版 r2）：带 schema 的 pi 子 agent 自动补交一轮 StructuredOutput

> 路径：`docs/dev/subagent-core/structured-output-repair-plan.md`（覆盖 r1）
> 范围：只改 pi 路径。外部 droid 路径（从 ```json 文本块提取）不动。
> 车道：L2。改 core（纯函数）、runner、adapter，加单测和真实 session 集成测试。状态机（reducer）不改，wire 不改，冻结 golden 不碰。
> r1 → r2 的变化：处理评审 #1–#7（见文末处置表）。两项默认已定案：①不加 settings 开关，②不收窄工具集。

---

## 0. 结论

- **位置**：补交轮放在 `RuntimeRunner.run()` 里，时机是第一次 `handle.prompt()` 结束之后、`sealBeforeTerminal` 和 `prompt_settled` 之前。在同一个 `SessionHandle` 上再调一次 `prompt(REPAIR_PROMPT)`。不另起 run，不改 runId，也不换 generation。
- **runner 保持通用**：它只读 adapter 组装的运行时字段 `req.structuredRepair`，里面是这几样：
  - `pending` 谓词
  - 提示词
  - 上报回调
  - **捕获窗口关闭回调 `closeCapture`**

  这个字段跟 `toolScope`、`inputBudget` 一样只在 runner 内部用，从不传给 pi。

- **不重置 watchdog 子阶段时钟**：补交期间 run 保持 `running`。reducer 的 `model_turn` 分支对普通事件只刷新活性，不重新 `enter`，所以 `phaseEnteredAt` 和 `modelTurnMs` 硬上限照常生效。补交可用的时间窗取「总 deadline」和「当前子阶段 dueAt」中较早的那个，再减去安全余量；不够阈值就跳过。补交过程中如果子阶段或 deadline 逼近，本地会**先于 watchdog**收口。
- **只补一次**：只有一个调用点，没有循环。另有三道上限：时间窗、turn 上限、外层 watchdog。
- **契约不变**：补交提交的结果仍要经过工具校验和宿主 `applyStructuredOutputPolicy` 的双重校验。捕获窗口在收口那一刻同步关闭，迟到的提交一律拒绝。
- **结算优先级**（最终派发前同步重查）：cancel / timeout / input-budget > context-switch 自检失败 > completed（交给宿主 schema 策略）。用户 abort 永远赢。
- **失败消息**：只追加后缀，基础消息一字不改。没有冻结 golden 含这句（`tests/fixtures` 已 grep）。Agent 工具描述「If the run ends without a schema-valid submission it is reported as failed」仍然准确，不改。

---

## 1. 关键设计决定

### 1a. 插入点：runner 层（不复用 resume）

| 方案                                    | 结论     | 依据                                                                                                                                                                                                                                                            |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| service 层复用 resume                   | 否决     | `runtime.run()` 返回时 run 已终态：terminal snapshot 已写，`enqueue_delivery` 已发（schema run 有 hold），reaper 已开始 dispose。resume 等于新起 run，要重新占槽、入队、走 journal/delivery，违反「同 runId」。tidy 是 journal-suppressed，也没有 resume 语义。 |
| 扩展 SessionDriver 接口                 | 不需要   | `PiSessionHandle.prompt()` 就是 `session.prompt()`，对空闲会话可以再次调用（交互式 pi 本来就这么用）。集成测试 §3.2-A 用真实 pi 钉住这一点。                                                                                                                    |
| **runner 在 `prompt_settled` 前插一轮** | **采用** | 此时会话、槽、cancel handle、watchdog 都还在。`sealBeforeTerminal`（bash 封存、`finalLeafId`）在补交之后执行。delivery 只在最终那次 `prompt_settled` 产生一次。                                                                                                 |

**状态机核查**：第一次 prompt 结束后 `phase=model_turn`、`status=running`。补交轮的 `turn_start` 和 `message_*` 走 `state-machine.ts` 约 L1041–1042 的分支（running 相位内只刷新 base）。`tool_start→tool_exec`、`tool_end→model_turn` 走现有分支。`settled` 事件在 running 相位同样只刷新 base。**reducer 不改。**

### 1b. 子阶段时钟语义（#2）

**决定：补交不重置任何子阶段时钟，runner 也不派发 `phase_entered`。** 证据：

1. `dueAtFor("model_turn")` 返回 `min(lastEventAt + idleMs, phaseEnteredAt + modelTurnMs)`（`src/core/deadline.ts` L45–58）。补交 prompt 产生的事件只推进 `lastEventAt`，不推进 `phaseEnteredAt`。只有 `enter()` / `clearAndArm` 才会重写 `phaseEnteredAt`，比如 `tool_end→model_turn` 或 `phase_entered`。
2. 仓库原则：`state-machine.ts` 约 L309–311 写明「extending a deadline must not reset the phase clocks, or a stuck tool/idle would get a free lifetime refill」。补交轮若重置时钟，等于给一个本该结束的 turn 续命，违反 I1。
3. watchdog 的子阶段 due 用 `dueAtFor(state.phase, state.diag, watchdog.deps.budget)` 计算，其中 budget 是 **settings.budget**（`src/stack.ts` L675–682，`src/runtime/watchdog.ts` L52–62），不是 per-run budget。所以 runner 算 due 时，要对 run budget 和 watchdog budget 各算一次，取较早者。

**可用窗口与收口**：用 `src/core/structured-repair.ts` 里的纯函数计算。

```text
phaseDue(now) = min(dueAtFor(phase, diag, runBudget), dueAtFor(phase, diag, watchdogBudget))   // 仅 OVERTIME_PHASES
资格:  phase === "model_turn"（否则 skipped_phase）
       graceUntil 未设（否则 skipped_grace）
       available = min(effectiveDeadlineAt, phaseDue) − tailMs − now
       available ≥ minRemainingMs(15s)（否则 skipped_budget）
窗口:  windowDueAt = now + clampSpanMs(min(maxMs=120s, available))
收口时刻（动态）: closeAt = min(windowDueAt, effectiveDeadlineAt − tailMs, phaseDue − tailMs)   // tailMs = 5s
```

- `closeAt` 是**动态**的。bind 监听器每派发一个补交期事件，就重算一次。值变小就重新挂计时器，比如补交中进入 `tool_exec` 而 `toolMs` 很短，或进入 `compaction`、`retry_backoff`。值变大就不动，计时器到点时会重算并后挪，覆盖 idle 随事件后移的情况。这样本地收口总是在 watchdog 1Hz tick 能看到的子阶段 due 之前至少 tailMs 发生。watchdog 本身**不关闭**，仍然是外层兜底。
- 例：默认 `modelTurnMs=900s`，首轮已在 `model_turn` 耗 850s。available = 50 − 5 = 45s，补交窗口 45s，第 45s 本地收口，按 schema 失败结算，不会是 `timed_out`。如果已耗 890s，available = 5s < 15s，直接跳过并保持原失败语义（后缀 `skipped_budget`）。
- 计时器：复用 `this.d.clock.setTimer/clearTimer`（Clock 端口）。生产用的 `systemClock` 本身 unref（`src/core/clock.ts` L106–113，满足 I5），有界，收口和 finally 时一定清掉。外层 `guardUntil` 只负责总 deadline 和 cancel，跟主 prompt 一样。

### 1c. 工具域：不收窄（定案）

- 不调 `setActiveTools(["StructuredOutput"])`。改 tools 会让整段会话的 provider prompt cache 失效，pi 也会重建 system prompt 里的工具片段。
- 约束靠三样：提示词、§1b 的时间窗、补交 turn 上限 `maxTurns=3`（未捕获时连续 3 个 `turn_end` 就收口）。
- 前置条件：`handle.getActiveTools()` 里要有 `StructuredOutput`，否则 `skipped_tool`。现有测试的 fake handle 都不含它，所以不会触发补交，字节不变，包括 A′ `jev-off-golden.json` 的 off-harness（`getActiveTools` 返回 read/bash/edit/write/memory）。
- 补交提示词（英文、模型可见，不含内部词汇）：

```text
You finished without calling the StructuredOutput tool, so your result has not been delivered.
Call StructuredOutput now, passing your final result as the tool's arguments (they must match the
requested JSON Schema). Do not redo the task and do not call any other tool. A plain-text or JSON
reply in chat is not accepted; only the StructuredOutput call counts.
```

### 1d. 结算与取消语义（#1）

**问题**：r1 有两处缺口。一是入口处已取消时返回普通 `skipped`。二是方法返回与外层 `await` 恢复之间有微任务窗口。这期间如果发生 stop/deadline，runner 仍会派发不带 error 的 `prompt_settled`。reducer 按 `input.error` 定终态（`state-machine.ts` L1045–1066），run 会变成 `completed`，再被宿主改成 schema failed，取消语义被吞。

**修法**：

1. 资格判定 `planStructuredRepair()` 是**同步**函数。跳过路径不引入任何 `await`，时序和现状完全一致。
2. **无论补交与否**，只要 `promptError === undefined && req.structuredRepair` 成立，就在 `sealBeforeTerminal` / `prompt_settled` 之前**同步**做一次实时重查：

```ts
req.structuredRepair.closeCapture(); // #4：同步关闭捕获窗口
if (cancel.signal.aborted || state.status === "stopping" || isTerminalStatus(state.status))
  promptError = settleErrorFor({ ok: false, reason: "cancelled" }); // input-budget > timeout > aborted（原映射）
else if (repairRan) promptError = selfcheckErrorFor(handle.getTurnError?.()); // #3
```

注意：判断条件**不能**写成 `status !== "running"`。没有事件的 fake 会停在 `prompt_dispatch`，那会把现有测试误判成取消。

3. 补交期间被 cancel 时，即使之前已捕获合法提交，也判为 aborted 或 timed_out，用户 abort 永远赢。
4. 补交 prompt 被拒、补交轮 turnError、本地收口、turn 上限：全部**忽略**，按第一次 prompt 的 completed 和原始 `finalText` 结算，交给宿主策略。
5. 补交 prompt **不**派发 `prompt_rejected`（那是首轮的 C-P2 契约）。

### 1e. context-switch 自检（#3）

- 首轮的自检失败本来就会让 `promptError` 有值，于是不补交。
- 补交轮可能调 `switch_context`（工具不收窄）。子会话的 `agent_end` handler（`context-switch/child.ts` L517–529）会写 selfcheck 失败条目，并对 capability 调 `noteFatal("run-ended")`。runner 的 bind 监听器会锁存 `selfcheckLatch`（runner.ts 约 L927–929）。
- 把现有 IIFE 里的自检段抽成 `selfcheckErrorFor(turnErr)`：`selfcheckLatch ?? getSwitchTail()` 返回 tail 且 `!assistantAfter` ⇒ error `"context switch self-check failed: …"`，kind 为 `model`。首轮路径调用同一个函数，语义逐字不变。补交后用 `repairRan` 门控再调一次，确保「切换已提交但之后没有模型请求」仍然判 failed(model)，不会以 completed 交给 schema 策略。

### 1f. 捕获窗口与截止共用一个关闭点（#4）

- adapter 里维护 `let captureOpen = true`：
  - `onSubmit`：`captureOpen` 为 false 时返回 `{ ok:false, errors:["the result window for this run has closed; this submission was not accepted"] }`，不写 `structured.value`。
  - `closeCapture = () => { captureOpen = false }`，幂等。
  - `pending = () => captureOpen && structured.value === undefined`。
- runner 在三个时刻**同步**调用 `closeCapture()`：
  1. 时间窗收口
  2. turn 上限触发
  3. 最终派发前（§1d 第 2 步，所有带 spec 且将要 completed 的 run 都执行）

  4. **取消边界（复审 r2 #4，主会话裁定）**：补交开始时向 run 的 abort signal（以及 runner 的 cancel 源）注册一个**同步** listener，触发即 `closeCapture()`；注册时若已 aborted 则立即关闭；在补交 finally 中移除 listener。这样「`abort()` → 同一同步调用栈里的 onSubmit」也会被拒绝，不依赖 await 恢复后的 finally。测试须在 `abort()` 之后、不让出微任务就调用工具提交，断言返回 rejected 且 `structured.value` 未写入。
  - 术语：本节「dispose」指**实际子会话 dispose**（reaper/teardown 关闭 SessionHandle），不是 `adapter.dispose()`（后者只设置重定向标志，不停止也不关闭子会话）。子会话 dispose 走同一个 cancel 源，因此同样同步关闭捕获。

  关闭之后才排 `queueMicrotask(requestAbort)`，不等 requestAbort 生效，也不等 reaper。

- 关闭前已接受的值保留，关闭后的提交一律拒绝。adapter 的 policy 只读 `structured.value` 一次。

### 1g. 子会话里的 settled 消费者（#5）

区分两个概念：pi 的「prompt-settled」是每次 `prompt()` 返回前发出的 `agent_end` + `agent_settled`；宿主的「run-terminal」是 runner 的 `prompt_settled`。补交之后的序列是：首轮 `agent_end/agent_settled` → 补交 `before_agent_start … agent_end/agent_settled` → run-terminal。

子会话里注册的 handler（pre-guard，依据 `src/index.ts` L176–259；title、hud、xs、goal、ask_user、feishu、schedule 都是 post-guard，只在主会话）：

| 消费者                                                              | 钩子                                                  | 在「首轮 settled → 补交 → 终态」下的行为                                                                                                                                                                                                                                                                                                  | 副作用                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| cache-ttl child keepalive（`src/cache-ttl/child.ts` L182–208）      | turn_end / agent_end / **agent_settled**              | 首轮 `agent_settled` 时 `disposed=true` 并 `svc.dispose()`。之后 `ensureService` 返回的是**已 disposed 的原 service**（不是 undefined）；补交轮的 turn_end、agent_end、第二次 settled 由 service 自身的 disposed/accept 门禁（`keepalive-service.ts` disposed 检查）保证全部空操作、不发 ping。**keepalive 在补交期间及之后都不会恢复。** | 无。按裁定：补交是活跃轮，且不超过 120s，keepalive 只管空闲间隙。该行为写入 README，并由集成测试验收（不会发出额外的 provider 请求）。 |
| context-switch child（`src/context-switch/child.ts`）               | turn_end / context / agent_end / session_compact      | 每次 prompt 独立处理 `pendingCommit`。补交中如果 switch 后没有后续请求，`agent_end` 会写失败条目并 `noteFatal`，runner 按 §1e 重查。                                                                                                                                                                                                      | 与任何「run 以 switch 结尾」的现有语义一致，没有新增副作用。                                                                           |
| sysprompt hub（`src/sysprompt/hub.ts` L425–427）                    | agent_settled                                         | 置 `firstRequestPending=true`，补交 prompt 按「新一次用户请求」折叠 section。                                                                                                                                                                                                                                                             | 与主会话第 N 条用户消息走的是同一条正常路径。                                                                                          |
| traffic child 录制（`src/traffic/index.ts` L629–634）               | agent_settled                                         | 丢弃本次 prompt 未配对的票据，属于逐 prompt 记账。                                                                                                                                                                                                                                                                                        | 无。                                                                                                                                   |
| bash child settle-hold（`src/bash/child.ts` L384 起）               | **agent_before_settle**（不是 agent_settled）         | 每次 prompt 结束前若有后台作业就 hold，门控是 `registry.isSealed(sessionId)`。封存发生在补交**之后**的 `sealBeforeTerminal`。补交里新起的作业可能被 hold，但这段等待受本地收口约束，之后 seal 会解除。                                                                                                                                    | 无新增。                                                                                                                               |
| memory / jev（`src/memory/jev/wire.ts` L1665 起）                   | before_agent_start / turn_end / tool_*                | 补交 prompt 会触发一次 `reinject` 和 `recallU(event.prompt)`，后者受 `recall.waitMs` 约束。没有 settled 钩子。                                                                                                                                                                                                                            | 多一次 recall 查询，记为残留 R6。                                                                                                      |
| date（`src/date/index.ts`）                                         | before_agent_start / turn_end                         | 按既有规则注入（首轮、跨日、距上次注入 ≥1h）。补交轮可能因首轮已超过 1h 或补交跨午夜而正常注入一次——这是既有规则的正常结果，不由第二次 settled 引起，也不会额外启动模型轮。                                                                                                                                                               | 无。                                                                                                                                   |
| todo（子会话）                                                      | 无 settled 钩子，nudge 只在主会话                     | —                                                                                                                                                                                                                                                                                                                                         | 无。                                                                                                                                   |
| title                                                               | post-guard，子会话没有                                | —                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                      |
| runner 自己                                                         | `settled` DriverEvent（session-driver.ts L366）       | 在 running 相位只刷新 base。                                                                                                                                                                                                                                                                                                              | 无。                                                                                                                                   |
| 父侧 observeRun / web 转录（`src/web-hub/agent/run-transcript.ts`） | 转发 `agent_settled`，但结束由 runner 的 `onEnd` 决定 | 转录里会多看到一组 agent_* 事件，结束时间点不变。                                                                                                                                                                                                                                                                                         | 无。                                                                                                                                   |

### 1h. 不补交的情形（汇总）

| 情形                                                                            | 判定位置                                                                      | 结局                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| 无 schema / 外部 droid / `deps.structuredRepair === false`                      | adapter 不设 spec                                                             | 现状                                      |
| 首轮 `promptError` 有值（turnError、被拒、自检、input-budget、timeout、cancel） | runner                                                                        | 现状                                      |
| 入口处已 cancel、stopping 或终态                                                | §1d 重查                                                                      | 原取消/超时映射（**不是** schema failed） |
| 已捕获                                                                          | `pending()`                                                                   | 现状（成功）                              |
| phase 不是 `model_turn`                                                         | plan                                                                          | `skipped_phase`，无后缀                   |
| StructuredOutput 不在活跃工具里                                                 | plan                                                                          | `skipped_tool`，无后缀（字节不变）        |
| 在宽限窗口内 / 可用窗口 < 15s                                                   | plan                                                                          | 后缀 `skipped_grace` / `skipped_budget`   |
| workflow `agent()`                                                              | `spawner-adapter.ts` 不传 schema；`agent-opts.ts` L184 明确拒绝 `schema` 选项 | 永远不补交，journal/replay 不受影响       |

受益的路径：Agent 工具带 schema 或 preset（verdict/v1）的 run、#68 resume 继承 schema、`/goal` verifier（`GOAL_EVAL_SCHEMA`）、`/mem tidy`（readonly 域）。

### 1i. 调用方上限（tidy capWatcher）

补交轮的 `turn_start` 会被 `createCapWatcher` 看到（`src/runtime/cap-watcher.ts`）。如果 `turns >= maxTurns` 或 cost 超限，它照常 abort，按 §1d 结算为 `aborted`，tidy 显示 "turn cap reached"、零写入。补交计入上限，不会偷偷超支。现场那次只跑了 1 轮，低于默认上限 4，会正常补交。

### 1j. 可观测性

- 失败后缀：`applyStructuredOutputPolicy` 的第 5 个参数只影响 `captured === undefined` 分支。
  - `attempted` → ` (after one repair turn)`
  - `skipped_budget` → ` (repair turn skipped: not enough time left before a deadline)`
  - `skipped_grace` → ` (repair turn skipped: run is past its deadline)`
  - `skipped_tool` / `skipped_phase` / 未传 → 无后缀
- `RunDiagnostics.structuredRepair?: "succeeded" | "failed"`（append-only，只在 `attempted` 时出现）。由 adapter 在 post-policy `store.put` 里写入（先例：H3 worktree 写回）。不进 journal 白名单，不进 StatusInfo，不进 `get_run_result` 文本，因此不影响任何 golden。

---

## 2. 改动清单（按文件）

### 2.1 新建 `src/core/structured-repair.ts`（pi-free，I8）

```ts
import { clampSpanMs, dueAtFor, OVERTIME_PHASES } from "./deadline.js";
import type { DeadlineBudget, Millis, RunDeadlines, RunDiagnostics, RunPhase } from "./types.js";

export const STRUCTURED_REPAIR_PROMPT = "You finished without calling the StructuredOutput tool, …"; // §1c 全文
export interface StructuredRepairLimits {
  minRemainingMs: Millis;
  maxMs: Millis;
  tailMs: Millis;
  maxTurns: number;
}
export const STRUCTURED_REPAIR_DEFAULTS: StructuredRepairLimits = {
  minRemainingMs: 15_000,
  maxMs: 120_000,
  tailMs: 5_000,
  maxTurns: 3,
};
export type StructuredRepairNote = "attempted" | "skipped_budget" | "skipped_grace" | "skipped_tool" | "skipped_phase";

/** Runtime-only (never sent to pi); built by service/runtime-adapter.ts for pi-path schema runs. */
export interface StructuredRepairSpec {
  readonly toolName: string;
  readonly prompt: string;
  readonly limits: StructuredRepairLimits;
  readonly pending: () => boolean; // captureOpen && nothing captured
  readonly closeCapture: () => void; // idempotent, synchronous
  readonly report: (note: StructuredRepairNote) => void;
}

/** Earliest sub-phase due across the run budget and the watchdog budget (watchdog uses settings.budget). */
export function phaseDueAt(
  phase: RunPhase,
  diag: RunDiagnostics,
  budgets: readonly DeadlineBudget[],
): Millis | undefined;
export function structuredRepairWindow(i: {
  now: Millis;
  deadlines: RunDeadlines;
  phaseDue: Millis | undefined;
  limits: StructuredRepairLimits;
}): { dueAt: Millis } | { skip: "skipped_grace" | "skipped_budget" };
export function structuredRepairCloseAt(i: {
  windowDueAt: Millis;
  deadlines: RunDeadlines;
  phaseDue: Millis | undefined;
  tailMs: Millis;
}): Millis; // min(windowDueAt, effectiveDeadline − tail, phaseDue − tail)
export function structuredRepairSuffix(note: StructuredRepairNote | undefined): string; // §1j
```

`phaseDueAt` 只对 `OVERTIME_PHASES` 里的 phase 返回值，用 `dueAtFor` 实现（与 watchdog 同一来源）。

### 2.2 `src/core/json-schema.ts`（`applyStructuredOutputPolicy`，约 L177）

- **值导入**：`import { structuredRepairSuffix, type StructuredRepairNote } from "./structured-repair.js";`，core 内部引用，仍然 pi-free。
- 签名追加可选参数 `repair?: StructuredRepairNote`。`captured === undefined` 分支的 message 改为 `基础串 + structuredRepairSuffix(repair)`。其他分支不变。外部路径不传，字节不变。

### 2.3 `src/core/types.ts`（`RunDiagnostics`，约 L963）

追加 `structuredRepair?: "succeeded" | "failed";`，注释写明「只存 store，不进 journal；只在补交轮真正发出过时出现」。

### 2.4 `src/runtime/watchdog.ts`

`Watchdog` 接口追加可选只读字段 `readonly budget?: DeadlineBudget`。`EventWatchdog` 暴露 `get budget() { return this.deps.budget; }`。纯只读，`tick` 逻辑不变。

### 2.5 `src/runtime/runner.ts`

1. `ResolvedSpawnRequest` 追加 `structuredRepair?: StructuredRepairSpec`。它不是 `SpawnRequest` 字段，`request-threading.ts` 的 Gate A/B/C 不动。
2. `run()` 局部变量：
   ```ts
   let repairCtl: { onEvent(e: DriverEvent): void } | undefined;
   let repairRan = false;
   ```
3. bind 监听器：在现有 dispatch 和 X11 处理**之后**追加
   ```ts
   if (repairCtl && !isTerminalStatus(state.status)) repairCtl.onEvent(e);
   ```
4. 现有 IIFE（约 L1112–1158）原样搬成两个局部函数，语义逐字不变：
   - `selfcheckErrorFor(turnErr: string | undefined): ErrorInfo | undefined`
   - `settleErrorFor(p: GuardResult<void>): ErrorInfo | undefined`：ok 分支先调 `selfcheckErrorFor(turnError)`，然后走 `turnInfo`、`turnError`；非 ok 分支走 timeout、error、cancel 映射。
5. 结算段：
   ```ts
   let promptError = settleErrorFor(prompted);
   const repair = req.structuredRepair;
   if (promptError === undefined && repair && req.external === undefined && handle) {
     const plan = this.planStructuredRepair(repair, handle, cancel, state, budget); // 同步：skip ⇒ report(note)，无 await
     if (plan.kind === "attempt") {
       repairRan = true;
       await this.runStructuredRepair(
         req,
         gen,
         handle,
         cancel,
         () => state,
         budget,
         plan.windowDueAt,
         (c) => {
           repairCtl = c;
         },
       );
     }
     // —— 从这里到 dispatch 全部同步 ——
     repair.closeCapture();
     if (cancel.signal.aborted || state.status === "stopping" || isTerminalStatus(state.status))
       promptError = settleErrorFor({ ok: false, reason: "cancelled" });
     else if (repairRan) promptError = selfcheckErrorFor(handle.getTurnError?.());
   }
   this.sealBeforeTerminal(req.runId, gen);
   dispatch({
     kind: "prompt_settled",
     at: now,
     ...(promptError ? { error: promptError } : {}),
     ...(finalText === undefined ? {} : { text: finalText }),
   });
   ```
   `finalText` 仍是**首轮**的 `getLastAssistantText()`。reducer 在无 error 时用 `input.text` 覆盖流式 `diag.text`，补交轮的文本不会污染 `outcome.text`。
6. `planStructuredRepair`（同步）按 §1h 顺序检查，返回 `{ kind: "skip" }` 或 `{ kind: "attempt", windowDueAt }`：
   - `cancel.signal.aborted || status ∈ {stopping, 终态}` → skip，不 report，由重查处理
   - `!pending()` → skip
   - `phase !== "model_turn"` → `skipped_phase`
   - `!getActiveTools().includes(toolName)` → `skipped_tool`（`getActiveTools` 抛错视同不可用）
   - `structuredRepairWindow({ now, deadlines, phaseDue: phaseDueAt(phase, diag, [budget, this.d.watchdog.budget].filter(Boolean)), limits })` → skip 时报对应 note
   - 否则 `report("attempted")` 并返回 attempt
7. `runStructuredRepair`（async）：
   ```ts
   let closed = false,
     promptDone = false,
     turnEnds = 0;
   let timer: TimerHandle | undefined,
     armedAt = Number.POSITIVE_INFINITY;
   let resolveClosed!: () => void;
   const closedP = new Promise<"closed">((r) => (resolveClosed = () => r("closed")));
   const target = () => {
     const s = getState();
     return structuredRepairCloseAt({
       windowDueAt,
       deadlines: s.deadlines,
       phaseDue: phaseDueAt(s.phase, s.diag, budgets),
       tailMs: spec.limits.tailMs,
     });
   };
   const close = () => {
     if (closed) return;
     closed = true;
     spec.closeCapture();
     if (timer) {
       this.d.clock.clearTimer(timer);
       timer = undefined;
     }
     if (!promptDone)
       queueMicrotask(() => {
         try {
           void handle.requestAbort();
         } catch {}
       });
     resolveClosed();
   };
   const rearm = () => {
     if (closed) return;
     const t = target(),
       now = this.d.clock.now();
     if (t <= now) return close();
     if (t >= armedAt && timer) return; // 只在提前时重挂；后移由到点重算处理
     if (timer) this.d.clock.clearTimer(timer);
     armedAt = t;
     timer = this.d.clock.setTimer(t - now, () => {
       timer = undefined;
       armedAt = Infinity;
       rearm();
     });
   };
   setCtl({
     onEvent: (e) => {
       if (e.t === "turn_end" && ++turnEnds >= spec.limits.maxTurns && spec.pending()) return close();
       rearm();
     },
   });
   rearm();
   const p = (() => {
     try {
       return handle.prompt(spec.prompt);
     } catch (err) {
       return Promise.reject(err);
     }
   })();
   try {
     await this.guardUntil(
       Promise.race([
         p.finally(() => {
           promptDone = true;
         }),
         closedP,
       ]),
       () => effectiveDeadlineAt(getState().deadlines),
       cancel,
       "structured_repair",
       () => {
         const s = getState();
         const timerId = s.deadlines.graceUntil !== undefined ? "total_grace" : "total";
         this.fireDeadline(req.runId, gen, {
           kind: "deadline_fired",
           at: this.d.clock.now(),
           timer: timerId,
           reason: "total",
         });
       },
     );
   } finally {
     promptDone = true;
     setCtl(undefined);
     close();
   } // close() 幂等：清计时器、关捕获
   ```
   - `p.finally` 的拒绝由 `guardUntil` 内部的 `.catch` 吞掉。`Promise.race` 的落败分支已挂了处理器，不会产生 unhandled rejection。
   - 只用了 Clock 端口的有界计时器，三条路径（finally、close、到点重算）都会清理。

### 2.6 `src/service/runtime-adapter.ts`

1. `RuntimeAdapterDeps` 追加 `structuredRepair?: false | Partial<StructuredRepairLimits>`，作为测试缝。`stack.ts` 不传，即默认开启（定案）。
2. StructuredOutput 注入处（约 L725）：
   ```ts
   let captureOpen = true;
   onSubmit: (value) => {
     if (!captureOpen) return { ok: false, errors: ["the result window for this run has closed; this submission was not accepted"] };
     const r = validateAgainstSchema(schema, value); if (r.ok) structured.value = value; return r;
   },
   ```
3. 组装 `req` 时：
   ```ts
   let repairNote: StructuredRepairNote | undefined;
   const structuredRepair =
     !isExternal && grantedReserved.includes("StructuredOutput") && deps.structuredRepair !== false
       ? {
           toolName: "StructuredOutput",
           prompt: STRUCTURED_REPAIR_PROMPT,
           limits: { ...STRUCTURED_REPAIR_DEFAULTS, ...(deps.structuredRepair || {}) },
           pending: () => captureOpen && structured.value === undefined,
           closeCapture: () => {
             captureOpen = false;
           },
           report: (n: StructuredRepairNote) => {
             repairNote = n;
           },
         }
       : undefined;
   // req literal: ...(structuredRepair === undefined ? {} : { structuredRepair }),
   ```
4. pi 路径的 policy（约 L1023）：`applyStructuredOutputPolicy(outcome, schema, structured.value, semantic, repairNote)`。`repairNote === "attempted"` 时把 `structuredRepair: structuredResult ? "succeeded" : "failed"` 写入 `outcome.diag`，post-policy `store.put` 同步带上 `diag`。其他情况 snapshot 和 outcome 字节不变。
5. 外部分支不动，注释「no repair round (U6)」对 droid 仍成立。

### 2.7 文档

- `docs/dev/subagent-core/README.md` 的 `## src/runtime/` 下新增 **Structured-output repair turn** 一段，内容包括：位置；资格；时钟语义（不重置，取 run/watchdog budget 中较早的子阶段 due，可用窗口 ≥15s，收口 min(120s, 可用窗口)，动态提前收口）；结算优先级；捕获窗口关闭；不收窄工具的理由；§1g 的子会话消费者表（含 keepalive 在首轮 settled 后永久 disposed、补交期间不恢复）；调用方上限照常计入；diag 只存 store。
- 本方案文件。

---

## 3. 测试清单

### 3.1 core 单测（Tier 1）

**`tests/core/structured-repair.test.ts`（新）**

- `phaseDueAt`：对 run budget 和 watchdog budget 取较早者；`model_turn` 取 min(idle, cap)；`tool_exec` / `compaction` / `retry_backoff`；非 OVERTIME 相位返回 undefined。
- `structuredRepairWindow`：
  - 在宽限窗口 → `skipped_grace`
  - deadline 剩 19s → available 14s → `skipped_budget`
  - 默认 budget 下 model_turn 已耗 850s → `dueAt = now + 45s`；已耗 890s → skip
  - `idleMs = 20s` → available 15s 恰好通过
  - 不受限时 → `now + 120s`
  - NaN → `skipped_budget`
- `structuredRepairCloseAt`：取三者最小值。
- 提示词：包含 `StructuredOutput` 和 `Do not redo`，不匹配 `/[§]|architecture/`，纯 ASCII。suffix 映射。

**`tests/core/json-schema.test.ts`（补）**：不传第 5 参时消息逐字不变；`attempted` / `skipped_budget` 的后缀；已捕获分支不受影响。

### 3.2 runner + adapter 单测（Tier 1）

文件 `tests/service/runtime-adapter-structured-repair.test.ts`（新）。

**harness 要求**：

- 用 FakeClock 和**真实接线的** `EventWatchdog`：`getState` / `dispatch` 晚绑定到 `adapter.getRunState` / `fireDeadline`（同 `stack.ts` L675–682），`budget: DEFAULT_BUDGET`。**不要**为了好写测试调大 watchdog 预算。
- fake handle 设 `getActiveTools: () => ["read", "StructuredOutput"]`。bind 时捕获 `onEvent`，每次 prompt 发 `turn_start`、`message_end`、`turn_end`，让 phase 进入 `model_turn`。
- `prompt` 用 `vi.fn` 记录调用文本；`requestAbort` 和 `dispose` 也用 spy。

| #   | 用例                                                                                                                                         | 断言                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首轮未提交，补交成功                                                                                                                         | completed；`structuredResult` 正确；prompt 调用 2 次，第 2 次是 REPAIR_PROMPT；`outcome.text` 为首轮文本；`diag.structuredRepair = "succeeded"`；runId 不变；`notifier.enqueue` 和 `finalize` 各 1 次；`deps.journal` 的终态记录与 `onLifecycle` 终态事件**各 1 次** |
| 2   | 补交仍未提交                                                                                                                                 | failed(schema)，消息带 `(after one repair turn)`；prompt 恰好 2 次；`diag = "failed"`                                                                                                                                                                                |
| 3   | 首轮已提交 / 无 schema / 外部路径 / `deps.structuredRepair: false` / 工具不在活跃集                                                          | prompt 1 次，消息和字段与现状一致（工具不在活跃集时无后缀）                                                                                                                                                                                                          |
| 4   | 首轮失败：turnError / 被拒 / 首轮 abort / 首轮超时                                                                                           | prompt 1 次，原终态                                                                                                                                                                                                                                                  |
| 5   | **#1 跳过路径取消**：首轮 prompt resolve 后、planning 之前（`queueMicrotask` 内）调 `runner.abort`                                           | aborted，不是 schema failed，prompt 1 次                                                                                                                                                                                                                             |
| 6   | **#1 补交 resolve 与 abort 同 tick**：补交 prompt 的 resolve 与 `runner.abort` 在同一微任务批次                                              | aborted                                                                                                                                                                                                                                                              |
| 7   | **#1 方法返回后、外层恢复前取消**：通过 `closeCapture` spy 在其同步回调前插入 abort（或补交 resolve 后排一个微任务 abort）                   | aborted；已捕获的合法提交也不改变 aborted                                                                                                                                                                                                                            |
| 8   | 补交中用户 abort / **父 signal abort**（`request.signal`，`detachSignalOnStart` 未设）                                                       | aborted（parent_abort）；run promise resolve；`dispose` 被调用                                                                                                                                                                                                       |
| 9   | 补交中 input-budget abort（`inputBudget` + 注册表 `abort`）                                                                                  | failed(config, input-budget)                                                                                                                                                                                                                                         |
| 10  | **#2 默认 modelTurnMs 邻近**：首轮在 model_turn 内推进 850s 后结束，补交 prompt 永不 resolve                                                 | 第 45s 本地收口：failed(schema, after one repair turn)，**不是** timed_out；`requestAbort` 1 次；watchdog 未触发 deadline_fired                                                                                                                                      |
| 11  | **#2 余额不足**：已耗 890s                                                                                                                   | prompt 1 次，后缀 `skipped_budget`                                                                                                                                                                                                                                   |
| 12  | **#2 短 idle**：`idleMs = 20s`，补交里只发一个事件然后静默                                                                                   | 在 lastEventAt + 15s 收口，不是 timed_out(idle)                                                                                                                                                                                                                      |
| 13  | **#2 短 tool**：`toolMs = 10s`，补交中 `tool_start`（非 StructuredOutput）后挂起                                                             | 在进入 tool_exec 后 5s 收口（动态提前），不是 timed_out(tool)                                                                                                                                                                                                        |
| 14  | **#2 短 compaction**：`compactionMs = 12s`，补交中 `compaction_start` 后挂起                                                                 | 同上                                                                                                                                                                                                                                                                 |
| 15  | **#2 watchdog budget ≠ run budget**：watchdog 用更短的 `idleMs`                                                                              | 收口以较早者为准                                                                                                                                                                                                                                                     |
| 16  | **#3 自检**：补交中 bind 发 `switch_selfcheck_failed`，或 `getSwitchTail` 返回 `{assistantAfter:false}`，同时补交里也提交了 StructuredOutput | failed(model)，消息为 "context switch self-check failed"，**不是** completed                                                                                                                                                                                         |
| 17  | **#4 迟到提交**（分 4 个子例）                                                                                                               | 截止前提交 → 成功；同 tick 先提交再收口 → 成功；同 tick 先收口再提交 → 拒绝，工具结果 `ok:false`；收口后、policy 前提交 → 拒绝，结果 failed；abort/dispose 期间提交 → 拒绝                                                                                           |
| 18  | turn 上限：补交内 3 个 `turn_end` 都没提交                                                                                                   | 收口；`requestAbort` 1 次；failed 带后缀。另一变体：第 2 个 turn 已提交，之后的 turn_end 不触发收口                                                                                                                                                                  |
| 19  | **#6 adapter dispose**：补交中调 `adapter.dispose()`                                                                                         | 补交照常完成；policy 正常；H3 写回改走 late sink（若设了 beforeReap）                                                                                                                                                                                                |
| 20  | **#6 真实 capWatcher**：`perRun` 的 `onSnapshot` 接 `createCapWatcher`；`maxTurns=1` 时补交的 turn_start 触发 abort                          | aborted，`capReason = turn_cap`；`maxTurns=4` 时补交成功                                                                                                                                                                                                             |
| 21  | readonly 域（tidy 形状：`toolDomain:"readonly"`、`suppressDelivery`、schema）                                                                | 补交照常；`journal` 未被调用；不 enqueue                                                                                                                                                                                                                             |
| 22  | trackInput + 补交被拒                                                                                                                        | 不派发 `prompt_rejected`；`diag.promptOutcome` 保持首轮值                                                                                                                                                                                                            |
| 23  | verdict/v1                                                                                                                                   | 语义非法的提交被工具拒绝，合法的成功；通知预览走 `renderStructuredForHost`                                                                                                                                                                                           |

### 3.3 workflow 定向断言（Tier 1）

- `tests/workflow/spawner-adapter.test.ts`（补）：`createWorkflowChildSpawner` 发出的 `SpawnRequest` **不含 `schema` 键**。
- `tests/workflow/agent-opts.test.ts`（补或确认）：`agent({ schema })` 被拒，消息为「structured output is not supported here …」。
- `tests/workflow/structured-repair-not-applied.test.ts`（新，复用 `a2-window-real-spawn-service.test.ts` 的真实 SpawnService + adapter 接法）：child 的 fake handle 刻意让 `getActiveTools` 包含 `"StructuredOutput"`，且 prompt 不提交 → prompt 恰好 1 次；`settled` 事件和 journal 的 child 记录各 1 次；replay 读回的 summary 只有 1 条。

### 3.4 真实 session 集成测试（Tier 1/2 交界，确定性）

文件 `tests/integration/structured-repair-real-session.test.ts`（新）。

**harness**：参照 `child-switch-runner.test.ts`：

- 真实 `createAgentSession`，配脚本化 `fakeModelRuntime` / streamFn
- `PiSessionHandle`，bind 用真实 `PiSessionDriver.bind`
- `createRuntimeRunnerAdapter`
- driver 的 `create(spec)` 用 `spec.customTools` / `spec.tools` 建 session
- `DefaultResourceLoader.extensionFactories` 加载**真实的** `wireChildSession(pi, settings)`（同时含 keepalive 和 context-switch），settings 开启 `cacheTtl.keepalive`、`cacheTtl.childKeepalive`、`compact.childSessions`
- adapter 设 `childSwitchContextGrant: () => true`

| #   | 场景                                                                          | 断言                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | turn1 回复纯文本 JSON → 补交 turn 调 `StructuredOutput{…}` → 收尾文本         | completed；`structuredResult` 正确；session messages 里有补交 user message；`diag.turns = 3`；`outcome.text` 为 turn1 文本；**provider 请求数 = 脚本轮数**（没有 keepalive ping 插进来）；child keepalive ledger 对该 session 无记录 / 0 ping（首轮 settled 后已 disposed，补交期间不恢复） |
| B   | 补交 turn 仍回复文本                                                          | failed，带 `(after one repair turn)`                                                                                                                                                                                                                                                        |
| C   | 补交 turn 调 `switch_context` 后 run 结束，切换后没有模型请求                 | failed(model)，消息为 "context switch self-check failed"；`getSwitchTail().assistantAfter === false`                                                                                                                                                                                        |
| D   | readonly 域：`READONLY_DOMAIN_TOOLS` + StructuredOutput，policy 带 provenance | 补交成功（enforcer 在 turn_start/turn_end 复检不会剥掉 StructuredOutput）                                                                                                                                                                                                                   |

### 3.5 回归与冻结面

- 不改的必须原样全绿：`tests/core`（状态机矩阵和性质测试）、`tests/runtime/**`、`tests/service/**`（现有 schema 用例的 `getActiveTools` 都不含 StructuredOutput）、`tests/memory/**`（含 `tests/memory/jev`，A′ `jev-off-golden.json`）、`tests/goal`、`tests/workflow`、`tests/tools/model-facing-strings.test.ts`（可加一条：断言 REPAIR_PROMPT 不含内部词汇）、`tests/boundary/pi-free.test.ts`、`tests/governance`（没有新注册）、`tests/integration/child-switch-runner.test.ts`、`tests/integration/readonly-domain-shadow-real-session.test.ts`、`tests/integration/timeout-grace-wiring.test.ts`。
- conformance：不新增。§3.4-A 已用真实 pi 钉住「空闲会话可再次 prompt」。

### 3.6 定向验证命令

```sh
timeout 600 npx vitest run tests/core/structured-repair.test.ts tests/core/json-schema.test.ts \
  tests/service/runtime-adapter-structured-repair.test.ts tests/integration/structured-repair-real-session.test.ts \
  tests/workflow/structured-repair-not-applied.test.ts tests/workflow/spawner-adapter.test.ts tests/workflow/agent-opts.test.ts
timeout 900 npx vitest run tests/core tests/runtime tests/service tests/memory tests/goal tests/workflow \
  tests/tools tests/boundary tests/governance tests/integration/child-switch-runner.test.ts \
  tests/integration/readonly-domain-shadow-real-session.test.ts tests/integration/timeout-grace-wiring.test.ts
timeout 600 npm run typecheck
timeout 300 npm run format:check
git diff --quiet origin/dev -- tests/fixtures/ && echo FIXTURES-UNCHANGED
git diff --quiet origin/dev -- src/memory/tidy/prompt.ts src/tools/agent-tool.ts src/tools/structured-output-tool.ts \
  src/core/state-machine.ts src/service/request-threading.ts && echo FROZEN-SURFACES-UNCHANGED
timeout 1800 npm test   # 提交前全量
```

### 3.7 提交拆分（Conventional Commits，用精确路径 add）

1. `feat(core): structured-output repair window, close point and failure suffix`：core 三个文件及其测试。
2. `feat(runtime): one structured-output repair turn before settling a schema run`：`runner.ts`、`watchdog.ts`、`runtime-adapter.ts`，以及 §3.2 的测试。
3. `test(workflow): workflow children never get a structured-output repair turn`
4. `test(integration): real-session structured-output repair turn with child wiring`
5. `docs(subagent-core): document the structured-output repair turn`

---

## 4. 风险与残留

| #   | 风险或残留                                                                                                                   | 处置                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | 首轮 resolve 后 pi 仍在忙（比如后台 compaction），补交 prompt 被拒，报 "already processing"。                                | 按「忽略」处理，结局与现状相同（failed 带后缀），不会更坏。§3.4-A 钉住了正常情况。 |
| R2  | 动态收口依赖 bind 事件触发重算。若事件流中断，计时器仍按上次的 closeAt 到点重算，最坏在 watchdog 之前 tailMs 收口。          | 有 tailMs = 5s 余量，watchdog 1Hz tick 是外层兜底。                                |
| R3  | 调用方上限（capWatcher）会把「用满 maxTurns 后的补交」报成 `aborted / turn cap reached`。                                    | 两种情况都是零写入，提示语义准确，写入 README。                                    |
| R4  | 工具不收窄，模型可能在补交轮调用其他工具。                                                                                   | 提示词禁止，再加 3-turn、动态时间窗、外层 watchdog 三重上限。迟到的提交会被拒。    |
| R5  | 失败路径增加成本和时延，每次最多约 2 分钟加 3 个 turn。                                                                      | 只发生在原本就会失败的路径上。成本计入 `diag.usage`。                              |
| R6  | 子会话的 jev 会在补交 prompt 上多做一次 `reinject` 和 `recallU`（受 `recall.waitMs` 限制）；hub 把补交当新请求折叠 section。 | 属于正常的多 prompt 语义，可接受。                                                 |
| R7  | child keepalive 在首轮 `agent_settled` 后永久 disposed，补交期间及之后都不 ping。                                            | 按裁定接受，README 写明，§3.4-A 验收。                                             |
| R8  | `diag.structuredRepair` 只存在 store，跨进程（journal / 墓碑）不保留，hub 和 `get_run_result` 不显示。                       | 有意为之，最小 append-only。以后需要显示时单独评估 result-text 的 golden。         |
| R9  | 补交期间被 abort 时，即使已经收到合法提交也判 aborted。                                                                      | 有意为之：用户 abort 永远赢。                                                      |

## 5. 定案（原「待确认」）

1. **不加 settings 开关。** 默认常开，只在 `RuntimeAdapterDeps.structuredRepair` 留测试缝和日后接设置的口子。
2. **补交轮不收窄工具集。** 理由：收窄会让 prompt cache 失效。约束改由提示词、时间窗、turn 上限承担。

---

## 评审处置表

| #   | 级别    | 问题                                                                                                               | 处置                                                                                                                                                                                                                                                                                                                                                                                                                     | 落点                                                 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 1   | Blocker | 入口已取消时返回普通 skipped；方法返回后外层恢复前有微任务竞态，取消语义被 schema failed 吞掉                      | **接受。** 资格判定改成同步（跳过路径零 `await`）。所有「带 spec 且将要 completed」的 run，在 `sealBeforeTerminal` / `prompt_settled` 之前同步重查 `cancel.signal.aborted`、`stopping`、终态，命中就走原取消映射（input-budget > timeout > aborted）。判断条件不用 `status !== "running"`，避免误伤停在 prompt_dispatch 的 fake。新增「跳过路径取消」「同 tick」「返回后恢复前」「父 signal」「input-budget」用例。      | §1d；§2.5 第 5、6 步；§3.2 #5–#9                     |
| 2   | Major   | `model_turn` 受 `phaseEnteredAt + modelTurnMs` 硬上限，补交沿用旧时钟会被提前 `timed_out`；短 tool/compaction 同理 | **接受（按裁定）。** 不重置任何子阶段时钟，并给出证据：reducer 在 model_turn 不重新 enter，「不得续命」原则见 state-machine.ts 约 L309–311。可用窗口 = min(总 deadline, 当前子阶段 due) − 5s，<15s 就跳过；收口时刻 = min(120s, 可用窗口)，补交中按实时子阶段 due 动态提前。子阶段 due 对 run budget 和 watchdog budget（settings.budget）取较早者。watchdog 不关闭。测试使用默认 DEFAULT_BUDGET 和真实接线的 watchdog。 | §1b；§2.1；§2.4；§2.5 第 6、7 步；§3.1；§3.2 #10–#15 |
| 3   | Major   | 补交轮绕过 context-switch 自检门禁                                                                                 | **接受。** 抽出 `selfcheckErrorFor`；补交后用 `repairRan` 门控，重查 `selfcheckLatch` 和 `getSwitchTail()`，保留 failed(model)。单测和真实 child wiring 集成测试各覆盖一次。                                                                                                                                                                                                                                             | §1e；§2.5 第 4、5 步；§3.2 #16；§3.4-C               |
| 4   | Major   | 本地收口与捕获没有共同截止点，迟到提交会被判成功                                                                   | **接受。** adapter 增加 `captureOpen` 和 `closeCapture`；runner 在时间收口、turn 上限、最终派发前三处同步关闭，关闭后才排 requestAbort，不等 abort 或 reaper。截止前接受的值保留，之后的提交拒绝。四类迟到提交都有测试。                                                                                                                                                                                                 | §1f；§2.5 第 7 步；§2.6 第 2、3 步；§3.2 #17         |
| 5   | Major   | pi 每次 prompt 都发 agent_settled；child keepalive 首次 settled 后永久 disposed                                    | **接受（按裁定）。** keepalive 在补交期间及之后都不恢复，写入 README。列出全部子会话 settled 及相关消费者（keepalive、context-switch、sysprompt hub、traffic、bash settle-hold、jev、date、todo、title 不在子会话、runner、父侧转录）在新序列下的行为，确认没有因第二次 settled 产生的副作用。集成测试加载真实 `wireChildSession`，覆盖 keepalive 和 context-switch。                                                    | §1g；§2.7；§3.4-A/C；R6/R7                           |
| 6   | Major   | 测试覆盖不足                                                                                                       | **接受。** 去掉人为调大的 watchdog 预算，改用 DEFAULT_BUDGET 加真实接线的 watchdog。补齐：父 signal、adapter dispose、补交完成边界取消、迟到提交、真实 capWatcher、终态 journal/lifecycle 只写 1 次。workflow 定向断言：不传 schema、`agent({schema})` 被拒、真实 SpawnService 下不补交且 settled/journal/replay 各 1 次（不扩 API）。                                                                                   | §3.2 #1、#5–#20；§3.3                                |
| 7   | Minor   | json-schema 的导入写法；「不新增计时器」措辞不准；待确认段                                                         | **接受。** 明确写成值导入 `structuredRepairSuffix`；措辞改为「复用 Clock 端口的有界计时器，systemClock 自带 unref，收口和 finally 时一定清理」；删去待确认段，改为 §5 定案。                                                                                                                                                                                                                                             | §2.2；§1b；§2.5 第 7 步；§5                          |

## 复审 r2 主会话裁定（评审收敛规则：两轮后由主会话裁定，不开第三轮）

- r2 复审：#1/#2/#3/#6/#7 闭合；#4 取消边界未同步关闭捕获、#5 两处证据文本错误。
- #4：已在 §1f 第 4 条补「补交期间 abort/子会话 dispose 同步关闭捕获」并写明测试方式与 dispose 术语；主会话核对闭合。
- #5：§1g keepalive 行改为「返回已 disposed 的原 service，由 disposed 门禁保证空操作」；date 行改为「按既有规则可能正常注入」。主会话核对闭合。
