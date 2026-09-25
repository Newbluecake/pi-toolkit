# 主会话 Agent 工具只保留后台模式

> 状态：已实施（2026-09-26）。取代 [docs/dev/auto-background/plan.md](../auto-background/plan.md)
> 中的前台 auto-background 机制；`abort_subagent` 不受影响。

## 1. 动机

- **前台调用会把主会话锁死**：前台 `Agent` 调用阻塞整个 agent loop，run 期间用户不能输入新命令。
  auto-background 阈值（默认 10 分钟）只是给这种阻塞设了上限，并没有去掉它。
- **两条路径，两套语义**：模型要在「前台直接拿结果」和「`run_in_background: true` + 通知驱动」之间
  做选择。实际使用中（skills/dev-flow 的「默认后台」原则）几乎总是选后台，前台路径主要带来误用：
  串行派发、干等、并行任务被一个前台调用挡住。
- **维护成本**：前台路径需要一整套专属机制——`ForegroundProgressPort`、1Hz 进度流、relay
  AbortController、`waitOutcome` 限时等待、`markAutoBackgrounded` / `diag.autoBackgroundedAt`
  标记、fleet widget 的 `⇣后台` 字段、deadline-notice 的 auto-background 豁免分支，以及
  `foregroundAutoBackgroundMs` 设置。这些代码只服务一个很少被真正需要的模式。

## 2. 设计

### 2.1 顶层工具：一律后台

- 主会话的 `Agent` 工具（`createAgentTool` 不传 `allowedTypes`）每次调用都走原
  `run_in_background: true` 的路径：`spawn({ ...baseRequest, detachSignalOnStart: true, signal })`，
  立即返回 run_id + label marker + expert echo，details 为 `{ runId, label, background: true }`。
  结果通过通知 outbox 送达，模型用 `get_subagent_result` 收取。
- 参数 schema `AgentToolParams` 删除了 `run_in_background`。**兼容旧习惯**：TypeBox 的
  `Type.Object` 默认允许额外属性，pi 的 `validateToolArguments`（pi-ai `utils/validation.js`：
  `Value.Convert` + `Check`）既不剔除也不拒绝多出来的字段，所以模型仍传 `run_in_background`
  （包括 `false`）时调用照常执行，该字段被忽略。这一点由测试直接调用 pi-ai 的
  `validateToolArguments` 锁定。
- 零挂起保证不变：后台 run 仍受分相 deadline、总预算、reaper 约束，结果走持久化、可确认的投递管线。
  `detachSignalOnStart` 保证 Esc / compact 打断主会话本轮时不会连带取消 run。

### 2.2 嵌套工具：保持阻塞

- 子会话里注入的嵌套 `Agent`（`src/service/runtime-adapter.ts`，按 agent type 的 `canSpawn`）使用
  独立的 `NestedAgentToolParams`（在顶层字段基础上保留 `run_in_background`），行为完全不变：
  默认 `spawnAndWait` 阻塞、保持整轮 signal 联动（Esc 能停掉被等待的子 run），`run_in_background: true`
  时走后台分支。
- 理由：子会话是 print 模式，本轮结束即 run 结束，没有「等通知再醒来」的机会；让子 agent 阻塞等待
  自己派出的孙 run 是唯一能拿到结果的方式。
- 类型：`createAgentTool` 用重载区分——`NestedAgentToolDeps`（`allowedTypes` 必填）返回
  `ToolDefinition<typeof NestedAgentToolParams>`，`TopLevelAgentToolDeps`（无 `allowedTypes`，
  `spawn` 只需 `spawn()`）返回 `ToolDefinition<typeof AgentToolParams>`。

### 2.3 删除的前台专属机制

| 删除项                                                                                     | 说明                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `ForegroundProgressPort`、`deps.progress`、`deps.autoBackgroundMs`                         | 顶层前台 1Hz 进度流与 auto-background 返回分支 |
| `renderResult` 的 partial 分支、`AgentToolDetails.progress` / `.autoBackgrounded`          | 只服务前台进度流；嵌套路径不发 partial         |
| `SpawnService.markAutoBackgrounded`、`RunDiagnostics.autoBackgroundedAt`                   | 唯一调用方是前台 auto-background 分支          |
| fleet widget 的 `⇣后台` 字段（`FleetRow.autoBackgrounded`）                                | 数据源 `autoBackgroundedAt` 已不存在           |
| `shouldDeliverDeadlineNotice` 的 `autoBackgrounded` 参数                                   | 规则收敛为 `!expectsAck`（见 §2.4）            |
| `foregroundAutoBackgroundMs` 设置 / `foregroundAutoBackgroundS` 设置项                     | 见 §3                                          |
| `formatAgentTypesForPrompt` 的 `foregroundAutoBackgroundMs` 选项、`agentTypesSection` 传参 | 系统提示协议改为只描述后台（§2.5）             |

`buildProgressLines` / `formatOutcomeSummary` 保留：`get_subagent_result` 的 wait 流与
`SubagentWorkflow` 复用它们，嵌套阻塞结果也用 `formatOutcomeSummary`。

### 2.4 保留的共享机制

- `SpawnService.waitOutcome`：consult 端口（`src/consult/tool.ts`）在用。
- `SpawnService.expectsAck` / `SpawnRequest.expectAck` / caller-ack 抑制（`ackWindowMs` hold、
  coalescer、deadline-notice 的 `background` 策略）：`spawnAndWait` 内部固定 `expectAck: true`，
  嵌套 `Agent`、workflow、`/goal` verifier、consult 都走它。deadline-notice 的规则从
  `!(expectsAck && !autoBackgrounded)` 收敛为 `!expectsAck`——`autoBackgrounded` 只可能在顶层前台
  run 上为真，而顶层 run 现在从不 `expectAck`，两者等价。
- feishu-notify 的 `subagentForegroundSummary`：它针对的是「无通道 B 投递」的 `spawnAndWait` run
  （workflow / goal 仍会产生），与本改动无关，保留。
- bash 的 auto-background（`src/bash`、`bashJobs.*`）完全不动。

### 2.5 系统提示与工具描述

- `formatAgentTypesForPrompt` 的协议行改为：Agent 一律后台、立即返回 run_id；终态时推送完成通知；
  通知到达后用 `get_subagent_result(run_id)` 取结果；运行中可 `steer_subagent` / `abort_subagent`；
  不要轮询或阻塞等待；独立任务可在同一条消息里并行派发多个 Agent 调用。
- 这是 sysprompt 冻结快照（docs/dev/sysprompt-stable）中 `pi_subagent_types` 段的一次预期文本变化：
  已有会话的快照在下一次 refresh 时按正常 tail-update 流程更新；仓库里没有针对该段文本的
  golden/fixture（`tests/fixtures/compact-hint-golden.json` 与之无关）。
- Agent 工具 description / promptSnippet 去掉 `run_in_background` 与 foreground / auto-background
  措辞，明确 "always runs in the background"；`get_subagent_result` 去掉 "(run_in_background: true)"；
  `abort_subagent` 去掉 "including one that was auto-backgrounded"。

## 3. 设置键移除与兼容

- `AgentSettings.foregroundAutoBackgroundMs`、默认值、`loadSettings` 解析、`TIME_SETTING_MS_PATHS`
  条目、`SETTING_SPECS.foregroundAutoBackgroundS` 一并删除（`/agent settings` 编辑器与 `list` 不再显示）。
- 用户 `~/.pi/agent/pi-subagent.json` 里的残留键——秒制 `foregroundAutoBackgroundS` 或更早的毫秒制
  `foregroundAutoBackgroundMs`——**静默忽略**：`loadSettings` 只读取已知字段；该路径已不在时间单位
  迁移表里，所以不会触发 WARN，也不会因它写回文件。若同一文件里有别的旧 `*Ms` 键触发迁移写回，
  残留键原样保留（不转换、不提及），不改动用户内容。
- 由 `tests/config/agent-background-only.test.ts` 覆盖（loadSettings / loadSettingsFromFile /
  readSettingsNoMigrate、字节级不写回、迁移时不转换不提及）。

## 4. 影响面

- 模型侧：主会话不能再「同步拿结果」，必须通知驱动；dev-flow skill 原本就是这个策略，措辞已同步。
- 子会话：无变化。
- UI：fleet widget 不再显示 `⇣后台`；顶层 Agent 卡片不再显示 `background` 标记（每个调用都是后台）。
- 设置：`foregroundAutoBackgroundS` 消失；残留键无害。
- 文档：README / README.en / AGENTS.md / skills/dev-flow 已同步；auto-background 设计文档标注已被取代。
