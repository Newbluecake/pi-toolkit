# context-switch 实施方案（把 compact-hint 换成「模型自写交接内容」的上下文切换工具）· v2（已施工）

> 需求原话：「能否将压缩 hint 模块替换成一个上下文切换工具，工具参数上当前上下文需要传递到
> 下一个会话的（对应现有状态压缩后的状态）内容」。
>
> 即：不再由 pi 再起一次 LLM 做通用摘要、也不再只是"提醒模型去调 `compact_context`"，
> 而是让模型**直接把要带到下一段上下文的状态写进工具参数**，这份文本就是压缩后的上下文。
>
> 本文是方案，§6 三个待拍板项已由用户确认（彻底替换 + 设置可回退、`keep_recent` 默认 true、
> 工具名 `switch_context`），实现已落地；§0 是源码接缝核实（行号按当时
> `node_modules/@earendil-works/pi-coding-agent` dist 复核），§7 是实际落地清单。

## 0. 源码接缝核实表

| 断言                                                                                                                                  | 位置                                                                                            | 结论                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `session_before_compact` handler 的返回值 `SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult }`          | `dist/core/extensions/types.d.ts:857-860`、`:913`                                               | **关键接缝**：扩展可以直接"交作业"，pi 就不再跑摘要 LLM          |
| 手动压缩路径：hook 返回 `compaction` ⇒ `fromExtension = true`，跳过 `_runDefaultCompaction`，直接 `appendCompaction(summary, …)`      | `dist/core/agent-session.js:1490-1536`                                                          | `ctx.compact()` = 我们的执行通道，零额外 LLM 调用                |
| 自动压缩（threshold / overflow）走同一 hook，同样接受 `compaction`                                                                    | `dist/core/agent-session.js:1751-1795`                                                          | 自动线也能吃交接文本；但只在"交接文本新鲜"时用（§3.3）           |
| `CompactionPreparation = { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, tokensBefore, previousSummary?, fileOps }`      | `dist/core/compaction/compaction.d.ts:116-132`                                                  | hook 里能拿到切点、before token 数、**文件操作清单**（机械附录） |
| `CompactionResult = { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details? }`                             | `dist/core/compaction/compaction.d.ts:18-27`                                                    | 我们要构造的就是它；`usage` 省略 = 本次压缩零 token 成本         |
| 上下文重建：compaction 条目之前的条目，只有从 `firstKeptEntryId` 起才保留；**id 不匹配任何条目 ⇒ 之前的全部丢弃**                     | `dist/core/session-manager.js:198-226`（`buildContextEntries`）                                 | `keepRecent:false` = 传哨兵 id ⇒ 真正的"只剩交接文本"            |
| `ctx.compact()` 先 `await this.abort()`，同步打断当前 turn；工具内不得 await 压缩完成（否则死锁）                                     | `dist/core/agent-session.js:1468`、`src/tools/compact-tool.ts` 头注释                           | 新工具沿用 compact-tool 的 fire-and-forget + resume 消息形态     |
| 后台 subagent 因 `detachSignalOnStart` 不被压缩的 abort 波及                                                                          | `src/tools/compact-tool.ts` 头注释、`src/tools/agent-tool.ts:286`                               | 压缩路线不会误杀 fleet                                           |
| `newSession()` 只在 `ExtensionCommandContext` 上（命令才有），且 `teardownCurrent` 会 `await session.abort()` + 发 `session_shutdown` | `dist/core/extensions/types.d.ts:254-305`、`dist/core/agent-session-runtime.js:147-172,219-230` | 真·新会话路线要绕命令分发，代价见 §1                             |
| 我们自己的 `session_shutdown` 会 **stop 掉所有未终结的 subagent run** 并 drain                                                        | `src/index.ts:468-500`                                                                          | 真·新会话 = 灭掉在跑的 fleet；这是路线 A 的致命伤                |
| 命令可由工具间接触发：`pi.sendUserMessage("/agent …", { deliverAs:"followUp", expandPromptTemplates:true })` 立即派发（即便流式中）   | `src/reload/index.ts:12-45`                                                                     | 路线 A 若真要做，通道是现成的                                    |
| 现有三层阈值机（tick / hint / force）与其状态机                                                                                       | `src/compact-hint/threshold.ts`、`src/stack.ts:507-680`（`createCompactHintHook`）              | 触发器可以整体复用，只换"让模型做什么"                           |

## 1. 三条路线与取舍

| 路线                                                                | 机制                                                                     | 代价                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 真·新会话**：`newSession({ setup, withSession })` 播种交接文本 | 工具 → followUp 命令 → `ctx.newSession()`                                | 触发 `session_shutdown("new")` ⇒ **在跑的 subagent 全被 stop**、todo/goal 会话态清零、HUD/成本归零、fleet widget 重建；还要绕命令分发避免死锁  |
| **B. 模型自写摘要的压缩（推荐）**                                   | 工具存交接文本 → `ctx.compact()` → `session_before_compact` 回传 summary | 复用 pi 压缩机制：**零摘要 LLM 调用**、subagent 不受影响、会话文件延续（历史仍可回看）、resume 机制现成；`keepRecent:false` 时语义等同"换会话" |
| C. 只改文案                                                         | hint 文案改写，机制不动                                                  | 仍要跑一次通用摘要 LLM，模型对保留内容只有 `instructions` 的间接控制                                                                           |

**推荐 B**：需求的本质是"交接内容由模型自己写"，而不是"必须换一个 session 文件"。B 用
`firstKeptEntryId` 一个参数就能在「保留最近消息的压缩」与「只剩交接文本的硬切换」之间选择，
且不牺牲 fleet / todo / 成本统计。

## 2. 工具形状

`switch_context`（主会话，HOST_KEY 之后注册；print/json 拒绝，同 `compact_context`）。

```ts
SwitchContextParams = {
  goal: string;            // 必填：用户的原始诉求 + 当前总目标（要求复述用户原话要点）
  progress: string;        // 必填：已完成什么、当前停在哪
  next_steps: string;      // 必填：下一步有序计划
  decisions?: string;      // 已定的决策/用户偏好/明确禁止项及其理由
  key_files?: string[];    // 关键文件路径（带一句话作用）
  pitfalls?: string;       // 踩过的坑、失败过的尝试（防止下一段重犯）
  open_questions?: string; // 未决问题 / 等待用户确认的事项
  keep_recent?: boolean;   // 默认 true：保留最近若干条消息；false = 只留交接文本
  resume?: boolean;        // 默认 true：切换后自动继续当前任务
}
```

- **校验（拒绝敷衍）**：三个必填字段非空、`goal + progress + next_steps` 合计 ≥ N 字符
  （建议 200），否则工具直接返回错误并要求重写，不触发压缩。
- **机械附录（扩展补齐，模型最爱漏的部分）**：hook 里把以下内容拼到模型文本之后 ——
  `preparation.fileOps` 最近文件读写清单、活跃 todo（`src/todo` 会话态）、未终结 subagent
  run 摘要、后台 bash job、当前 model/thinking、上一段 session 文件路径（可回溯原文）。
- **渲染**：`renderCall` 同 compact-tool，显示 goal 首行截断。

执行序（与 compact-tool 同构，避免死锁）：

```
execute() → 校验 → 暂存 pendingHandoff{text, keepRecent, createdAt, seq}
          → ctx.ui.notify(...) → ctx.compact({ onComplete, onError }) → 立即 return
session_before_compact hook → 取 pendingHandoff（新鲜且未消费）
          → return { compaction: { summary, firstKeptEntryId, tokensBefore } }
onComplete → sendUserMessage(RESUME_TEXT 变体) → 模型带着自写状态继续
```

`firstKeptEntryId`：`keepRecent !== false` ⇒ `preparation.firstKeptEntryId`（pi 的正常切点）；
否则 ⇒ 哨兵值（如 `"__switch_context_none__"`），据 `buildContextEntries` 的实现即"全丢"。

## 3. compact-hint 的处置

阈值引擎（tick / hint / force 三层 + 滞回闩锁 + 窗口缩放）是**触发器**，与"让模型做什么"
正交，保留并整体复用；改的是每一层的动作与文案：

| 层         | 现在                             | 改为                                                                                                                          |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| tick       | 通报用量，提到 `compact_context` | 文案改为 `switch_context`                                                                                                     |
| hint (L1)  | 建议调用 `compact_context`       | 建议调用 `switch_context`，并强调"交接内容由你写，写全才不丢"                                                                 |
| force (L2) | 直接 `ctx.compact()` 跑通用摘要  | **先发硬性要求**：本回合必须调用 `switch_context`；未照办（下一次 turn_end 仍越线 / 用量再涨 K 点）才回落到现在的强制通用压缩 |

安全网（回落通用压缩）**不能拆**：模型无视要求时必须仍有人兜底，否则直接撞 pi 自动压缩线/溢出。

模块与命名：新增 `src/context-switch/`（工具 + 交接文本 builder + pendingHandoff 存储），
`src/compact-hint/threshold.ts` 保留为阈值引擎（文案 builder 迁移/改写）。运行期标识符沿用
`subagent:*` 前缀惯例（`subagent:compact-hint` / `subagent:usage-tick` 键名不改，避免破坏既有会话数据）。

### 3.3 自动压缩（threshold / overflow）如何对待交接文本

hook 对 `reason === "threshold" | "overflow"` 只在 `pendingHandoff` **新鲜**（由本次
`switch_context` 调用产生、未被消费、时间窗内）时注入；否则返回 `undefined` 让 pi 跑默认摘要。
陈旧交接文本比通用摘要更危险。

## 4. 风险与对策

| 风险                                   | 对策                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| 模型写得敷衍 ⇒ 比 LLM 摘要更差         | 必填字段 + 最小长度校验；机械附录兜底；`keep_recent` 默认 true（保留最近消息做缓冲） |
| `keep_recent:false` 丢掉用户原话       | `goal` 字段要求复述用户诉求；附录写入上一段 session 文件路径，必要时可回读           |
| 工具内 await 压缩 ⇒ 死锁               | fire-and-forget + `onComplete` 里发 resume 消息（照抄 compact-tool 头注释的结论）    |
| pendingHandoff 泄漏（压缩失败/被取消） | `onError` / `session_compact_failed` 清理；带 seq 与 TTL，hook 消费即清              |
| 双工具并存让模型犹豫                   | §6 决策点：默认**替换** `compact_context`（设置可回退共存）                          |
| 压缩必然废掉 prompt 前缀缓存           | 与现状一致，cache-ttl 侧无新增处置                                                   |
| print/json 模式                        | 同 `compact_context`：拒绝，返回 `non_interactive_mode`                              |

## 5. 施工清单（预估：源码 ~450 行 + 测试 ~350 行）

1. `src/context-switch/handoff.ts`（纯函数）：参数校验、交接文本渲染、机械附录拼装。
2. `src/context-switch/store.ts`：pendingHandoff（seq + TTL + 消费即清），无模块级可变状态。
3. `src/tools/switch-context-tool.ts`：工具定义（deps 注入 store / sendUserMessage / now）。
4. `src/context-switch/hook.ts`：`session_before_compact` handler + `session_compact_failed` 清理。
5. `src/stack.ts`：force 层改为"硬性要求 + 未照办才回落"，state 增加 demand 计数。
6. `src/compact-hint/threshold.ts`：文案 builder 改写（tick/hint/force 三处）。
7. `src/config/settings.ts`：`compact` 块新增 `switchTool: boolean`（默认 true）、
   `keepCompactTool: boolean`（默认 false）、`forceDemandTurns: number`（默认 1）。
8. `src/index.ts`：注册新工具 + hook（HOST_KEY 之后），按设置决定是否仍注册 `compact_context`。
9. 文档：README/README.en 工具表、AGENTS.md 模块行、CHANGELOG。
10. 测试：
    - `tests/context-switch/handoff.test.ts`：校验规则、渲染快照、附录拼装。
    - `tests/context-switch/hook.test.ts`：新鲜/陈旧/失败清理、`keepRecent` 两种 firstKeptEntryId、
      `reason` 分支。
    - `tests/tools/switch-context-tool.test.ts`：print 模式拒绝、in-flight/cooldown、
      compact 抛错时状态复位、resume 消息。
    - `tests/integration/context-switch-wiring.test.ts`：假 pi 上跑完整 turn_end→force→工具→hook→resume。

## 6. 已拍板

1. **彻底替换 `compact_context`**：模型面只留 `switch_context`；`compact.keepCompactTool=true` 可恢复
   共存，`compact.switchTool=false` 完全回到旧行为。强制安全网在扩展内部直接调 pi 压缩，
   不依赖工具是否注册。
2. **`keep_recent` 默认 true**（交接文本 + 最近消息双保险），模型可显式传 false 做干净切换。
3. 工具名：`switch_context`。

## 7. 实际落地（与 §5 清单的差异）

| 文件                                  | 内容                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/context-switch/handoff.ts`       | 校验（必填字段 + 码点计最小长度 120 + key_files 归一化）、正文渲染、机械附录、fileOps 提取  |
| `src/context-switch/store.ts`         | `PendingHandoffStore`：seq + TTL（默认 120s）+ 消费即清，`clear(seq)` 不误删后来者          |
| `src/context-switch/hook.ts`          | `session_before_compact` handler；`DROP_ALL_SENTINEL` 实现 keep_recent=false                |
| `src/context-switch/session-facts.ts` | 活跃 run（经 mention 反查 label）/ 后台 bash job / 未完成 todo / 会话文件，每一项都静默降级 |
| `src/tools/switch-context-tool.ts`    | 工具本体；print/json 拒绝、in-flight/cooldown、校验不通不压缩、resume/fallback 两种续跑文案 |
| `src/compact-hint/threshold.ts`       | 新增 `buildSwitchHintText` / `buildSwitchDemandText`；`buildUsageTickText` 增加工具名参数   |
| `src/stack.ts`                        | `CompactHintState` 新增 `switchTool` / `forceDemandTurns` / `demandCount`；force 层先礼后兵 |
| `src/config/settings.ts`              | `compact.switchTool`（true）/ `keepCompactTool`（false）/ `forceDemandTurns`（1，钳 0–5）   |
| `src/index.ts`                        | 注册工具 + 钩子 + `session_compact_failed`/`session_shutdown` 清理；仅 assembly             |

实现与方案的两处微调：

- 机械附录的采集放在 `session-facts.ts` 而非 index.ts（保持 I7 assembly-only），并通过
  `createSessionFactsProvider(holder, settings)` 注入。
- 工具在 `onComplete` 里用“本次 seq 是否仍在 store 上”判断钩子是否真的吃下了交接文本：未被采用时
  发 `SWITCH_FALLBACK_TEXT` 告知模型“当前是通用摘要”，避免它误以为自己的交接已生效。

测试：`tests/context-switch/{handoff,store,hook,session-facts}.test.ts`、
`tests/tools/switch-context-tool.test.ts`、`tests/integration/compact-hint-wiring.test.ts` 新增
“switch_context mode” 块（demand → 回落、handoff 在途不抢、计数归零、forceDemandTurns=0 等价旧行为、
文案路由、buildSessionStack 映射），共 3035 个用例全绿。
