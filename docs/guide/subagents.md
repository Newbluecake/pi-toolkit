# Subagent 系统

pi-toolkit 的核心：一套带多层 deadline 的 subagent 运行时，以及围绕它的工具、编排、通知和扩展。

目录：[工具](#工具) · [Agent tree](#agent-tree) · [SubagentWorkflow](#subagentworkflow) · [定时任务](#定时任务) · [防卡死架构](#防卡死架构) · [Message fabric](#message-fabric) · [外部 droid agent](#外部-droid-agent)

## 工具

- **`Agent`** — 发起有边界的 subagent run：`description`、`prompt`、`subagent_type`，可选 `model`（严格 `provider/id` 或模糊 hint，如 `sonnet`）、`resume`（续跑已结束的会话）、`isolation: "worktree"`（每个 run 一个 git worktree）、`timeout_s`（显式总预算，1–604800 秒）、`schema`（结构化输出）。
  - 主会话的 `Agent` **一律后台运行**：立即返回 run_id，终态时推送完成通知。可在同一条消息里并行派发多个。
  - 子 agent 里注入的嵌套 `Agent` 保持默认阻塞，可选 `run_in_background`（子会话是 print 模式，本轮结束即 run 结束，等不到通知）。
  - 并发满时直接拒绝（`agent.queueWhenFull` 默认 `false`），不会创建 run/worktree；成功派发的返回里带槽位占用。
- **`get_subagent_result`** — 取结果。默认非阻塞，`wait: true` + `wait_ms` 为有界阻塞。也接受工作流 ID（`wf_…`）。
- **`steer_subagent`** — 给运行中的子 agent 追加指令，可要求它回复。
- **`abort_subagent`** — 停止子 agent；对终态 run 幂等。传 `wf_…` 则停止整个后台工作流。
- **`extend_subagent_timeout`** — 延长运行中 run 的总超时。到点先进宽限并通知主会话，宽限内可延长，宽限耗尽才终止。每次延长最多 1 小时（`budget.extendStepS`，默认 3600，`0` = 旧行为），次数与硬天花板双上限。程序派生的固定预算 run（workflow 子 run、`/goal` 验证、RPC）不能延长。也接受工作流 ID。
- **`set_model`** — 运行中切换模型（下一次 LLM 调用生效）：缺省切自己，也可按 run_id / 前缀 / label 切子 agent；可选 `thinking`。
- **Agent 类型** — 从 `.pi/agents/`、`.agents/agents/`、`~/.pi/agent/agents/` 发现 `.md` 定义并注入系统提示词；frontmatter `model:` 支持严格 id 或模糊 hint，`can_message:` 控制 fabric 关系。
- **`@mention`** — 编辑器输入 `@<label> <消息>`，引导运行中的子 agent，或复活已结束的。
- **成本** — 每个 run 的用量汇入会话总计；`/agent costs` 看明细。

常用设置（秒）：`concurrencyLimit`（6）、`maxNestedDepth`（3）、`resultMaxChars`（32000，`0` 不限）、`worktree.enabled`（`false`）、`extend.enabled`（`true`）、`rememberAgents`（`true`）。

## Agent tree

run 活跃期间，编辑器上方常驻实时 agent tree（`fleetWidget`，默认开）：

```
● 4 active Agents · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- 头部取全场最严重的高亮色，显示活跃数与实时花费。
- 每个 run 一行：标签、`#id`、类型、模型、相位（`🧠思考` / `🔧工具` / `♻ 重试2/3` / `⏸ 排队` / `🗜 压缩` / `⏹ 停止中`）、耗时、费用。嵌套 run 缩进在父级下（`↳`），workflow 渲染为 `⚙` 组头；后台 bash job 也在其中成组显示。
- 工具调用或思考中追加活动行：近期工具轨迹 + 在途 `▸工具`，或模型流式文本 `»` 尾部。
- 高亮：`!` 黄 = 空闲超过 idle 预算一半；`✗` 红 = 停止中或超过总 deadline。终态行按驻留时间淡出，通知发不出去时最多保留 10 分钟。

## SubagentWorkflow

沙箱化 JS 编排（`agent()` / `parallel()` / `pipeline()` / `phase()`），带独立 wall-clock 预算、runaway 检测和可回放 journal。默认关闭（`workflow.enabled`）。

- **一律后台运行**：调用返回 `wf_…` ID，终态时推送完成通知。用 `get_subagent_result(run_id: "wf_…")` 看进度或取结果（完整 ID、唯一前缀、脚本 `meta.name` 均可），用 `abort_subagent` 停止，用 `extend_subagent_timeout` 延长。
- 超出并发上限的 `agent()` 按 FIFO 排队而不是失败；停止或时间耗尽时排队中的调用解析为 `null`，派发失败则 reject。
- `agent(prompt, opts)` 的 `opts` 严格校验，只接受 `label` / `agentType` / `phase` / `fullResult` / `model` / `thinking` / `isolation`。`isolation: "worktree"` 真正给该调用开独立 worktree，结果里带 `worktrees:` 汇总块；工作流自己不合并分支。
- journal 回放：同一 journal 再跑时命中即复用（`workflow.replayScope` 默认 `chain`，`workflow.isolationReplay` 默认 `verify`——隔离调用仅在其分支仍指向记录的 commit 时才回放）。
- 会话关闭 / `/reload` 时运行中的工作流会被停止，其通知持久化进会话，下次加载该会话时补发一次。

设计：[workflow-background](../dev/workflow-background/plan.md)、[workflow-agent-queue](../dev/workflow-agent-queue/plan.md)、[workflow-worktree](../dev/workflow-worktree/plan.md)。

## 定时任务

定时任务已改为会话级功能：默认关闭，`schedule.enabled` 打开后用 `/schedule` 命令和 AI 的 `schedule` 工具管理，任务属于创建它的会话，AI 创建的任务须你批准。用法、批准规则与设置见 [README 的「定时任务」](../../README.md#定时任务schedule)。

旧的全局引擎（`~/.pi/agent/pi-subagent-schedules.json`）已退役，不再读取也不再写入，原文件里的任务不会迁移。

## 防卡死架构

每个 run 是一条纯状态机（`src/core/state-machine.ts`），由会话事件驱动：

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (超时/停止:→ abort_grace → reap → settled)
```

1. **信号**：每个会话事件（文本增量、工具 start/end/update、retry、compaction）都刷新 `lastEventAt`。正在流式输出的模型、有心跳的工具不算"卡住"。
2. **Deadline**：每个相位独立计时（`budget.*`，秒）：启动 30、首事件 120、模型 turn 空闲 `idleS` 240、单轮 `modelTurnS` 900、单工具 `toolS` 600、压缩 300、总计 `totalS` 1800。`EventWatchdog` 以 1Hz 派发 `deadline_fired`。
3. **升级**：超时 → `cancel_signal` + `soft_steer`（"wrap up now"）→ 10s abort 宽限 → 强制 abort。仍失败则 `EscalatingReaper` 逐级 L0 cancel → L1 steer → L2 requestAbort → L3 dispose，仍杀不掉的登记为 orphan，不遗忘。
4. **总预算宽限**：到总预算先进宽限（默认 90s）并通知，可延长；总寿命默认 ≤ 2× 原预算（`budget.maxTotalFactor`，次数 `budget.maxExtensions` 默认 3）。
5. **通知必达**：完成通知走持久化投递管线（staged → batched → delivered → consumed）；主会话不收就一直挂着，发不出去有 10 分钟硬兜底。

重试有独立 backoff 相位，不会误触 idle 计时器；并行工具调用让 run 停留在 `tool_exec` 直到最后一个兄弟调用结束。

设计：[delivery-v2](../dev/delivery-v2/architecture.md)、[timeout-notify](../dev/timeout-notify/arch.md)、[agent-background-only](../dev/agent-background-only/plan.md)。

## Message fabric

subagent 之间的可选 fire-and-forget 消息：`"fabric": { "enabled": true }`（默认 `false`）+ `/reload`。

- `message_agent` 的 `kind`：`progress` / `finding` / `directive`；返回值只表示消息进入投递队列，不代表对方已收到。
- 消息沿 agent tree 的边路由；关系由发送方类型的 `can_message` frontmatter 门控（`parent` / `child` / `ancestor` / `descendant` / `sibling` / `self`，默认仅 `parent`）。
- 平级消息是不可信输入，接收方应当作外部建议重新验证。
- 配额、TTL、死信、root 背压等设置见 [subagent-push 方案](../dev/subagent-push/subagent-push-plan.md)；交接与实验见 [fabric-v2](../dev/fabric-v2/plan.md)。

## 外部 droid agent

可选把 [Factory droid](https://factory.ai) 当虚拟 provider `droid/<model>` 派发：`Agent({ model: "droid/<id>" })`。默认关闭，关闭时行为与提示词字节不变。

```json
{ "externalAgents": { "droid": { "enabled": true, "binary": "droid", "advertiseMax": 12 } } }
```

- 前置：装好 droid CLI，已登录或设置 `FACTORY_API_KEY`。强烈建议在 `~/.factory/update-policy.json` 里 `{"disableAutoUpdate":true}`（自更新会导致协议漂移）。
- **模型白名单**：`externalAgents.droid.models` 非空时，既是系统提示里展示的模型，也是新 spawn 的白名单——名单外的 `droid/<id>` 在派发前被拒，额度提示与改派建议也只列名单内模型；空列表（默认）= 自动，沿用 droid 的模型目录。resume 已有 run 不受白名单影响。
- 计费：droid 用量 × 底层模型的 pi 单价折算；匹配不上显示 `unpriced`，不会推断为 0。
- 额度闸门见 [额度与负载](quota-load.md)。`toolDomain:"readonly"` 对 droid 不可用，所以 tidy 不会使用 droid。
- 权限：droid 以高自治级别运行并自动批准权限请求，同时会读取你的全局 skills / AGENTS.md / MCP，使用前请确认可接受。

完整说明：[docs/dev/external-agent/README.md](../dev/external-agent/README.md)。
