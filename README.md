# pi-toolkit

**中文** | [English](README.en.md)

[pi](https://github.com/earendil-works/pi) 的工具箱扩展：旗舰是一套**零卡死 subagent 系统**（`Agent` / `get_subagent_result` / `steer_subagent` / `SubagentWorkflow`），外加九个可按需开关的日常基础设施模块——项目记忆、HUD footer、`web_search`、任务工具、`ask_user`、飞书通知、bash 自动转后台、会话导航、`/goal` 目标循环。单一安装入口，统一 settings 门控。

## 核心特点

1. **零卡死保证** — 每个 subagent run 都是一条带分相 deadline 的纯状态机：1Hz 看门狗触发超时，升级阶梯（cancel → steer → abort → dispose）物理回收资源，杀不掉的登记为 orphan 绝不遗忘。**每个 run 必然到达终态**——模型 API 中途停滞、工具调用永不返回、session 拒绝退出，这些"spawn + await"封装看不见的失败方式在这里都有明确的死法和善后。
2. **全程可观测** — run 活跃期间，编辑器上方常驻实时 **agent tree**：相位、在途工具、模型流式尾部、实时费用，一目了然；`/agent status` 给出逐 run 的完整工具时间线。
3. **结果必达** — 完成通知走持久化、可确认的投递管线（staged → delivered → consumed）：主会话不收就一直挂着，发不出去有 10 分钟硬兜底，绝不静默丢失。
4. **派完即走** — 主会话的 `Agent` 调用一律后台运行，立即返回 run_id，完成通知驱动下一步（可在同一条消息里并行派发多个）；bash 命令超过阈值自动转后台（默认 290 秒，刻意低于 5 分钟 prompt 缓存 TTL）。
5. **工具箱，不是单体** — 除 subagent 核心外每个模块都可独立开关（`hud.enabled`、`memory.enabled`、`webSearch.enabled`……），装一个包，按需取用。

## 安装

pi 直接加载 TypeScript 源码（经 jiti），无需构建：

```sh
pi install git:github.com/Newbluecake/pi-toolkit
# 更新：
pi update --extension git:github.com/Newbluecake/pi-toolkit
```

也可以从 [GitHub Releases](https://github.com/Newbluecake/pi-toolkit/releases) 下载 zip（已含编译产物），解压后 `pi install ./pi-toolkit`（本地路径方式，不参与 `pi update`）。

## Subagent 系统

- **`Agent` 工具** — 发起有边界的 subagent run：`description`、`prompt`、`subagent_type`，可选 `model` 覆盖（严格 `provider/id` 或模糊 hint 如 `sonnet`、`kimi-k3`）、`resume`（续跑已结束的会话）、`isolation: "worktree"`（每个 run 一个 git worktree）、`timeout_s`（显式超时为硬顶，不宽限不延长）、`schema`（结构化输出，经 schema 校验）。主会话的 `Agent` **一律后台运行**：立即返回 run_id，终态时推送完成通知（不再有前台阻塞模式与 `run_in_background` 参数）；子 agent 里注入的嵌套 `Agent` 保持默认阻塞、可选 `run_in_background`（子会话是 print 模式，本轮结束即 run 结束，等不到通知）。
- **`get_subagent_result`** — 完成通知到达后取结果；默认非阻塞，`wait: true` + `wait_ms` 为有界阻塞（兜底用）。也接受 `SubagentWorkflow` 的工作流 ID（`wf_…`）。
- **`steer_subagent`** — 向运行中的子 agent 发送追加指令。
- **`abort_subagent`** — 停止运行中的子 agent；对终态 run 幂等。传工作流 ID（`wf_…`）则停止整个后台工作流及其全部子 run。
- **`extend_subagent_timeout`** — 延长运行中 run 的总超时（次数与硬天花板双上限）。默认预算的 run 到点时先进续跑宽限并通知主会话，宽限内可延长，宽限耗尽未处理才终止。
- **`set_model`** — 运行中切换模型（下一次 LLM 调用生效，不打断当前 turn）：缺省切自己，也可按 run_id / 前缀 / label 切运行中的子 agent；可选 `thinking` 档位；切换写入 transcript，resume 后沿用。
- **Agent 类型** — 从 `.pi/agents/`、`.agents/agents/`、`~/.pi/agent/agents/` 发现 `.md` 定义并注入系统提示词；frontmatter `model:` 支持严格 id 或模糊 hint。
- **`@mention` 引导** — 编辑器输入 `@<label> <消息>`，可引导运行中的子 agent，或复活已结束的。
- **成本核算** — 每个 run 的用量汇入会话总计；`/agent costs` 查看明细。

### SubagentWorkflow

沙箱化 JS 编排（`agent()` / `parallel()` / `pipeline()` / `phase()`），带独立 wall-clock 预算、runaway 检测和可回放 journal。默认关闭（`workflow.enabled`）。

工作流**一律后台运行**：调用立即返回工作流 ID（`wf_…`），到达终态时向主会话推送一条完成通知（名称、状态、结果摘要（受 `resultMaxChars` 截断）、花费）。用 `get_subagent_result(run_id: "wf_…")` 查看进度或取完整结果（ID、唯一前缀或脚本 `meta.name` 均可），用 `abort_subagent` 停止。每个工作流仍受「总预算 + 宽限」约束，必达终态；会话关闭 / `/reload` 时运行中的工作流会被停止，其通知持久化到会话里、在下一次加载该会话时补发一次。设计见 [docs/dev/workflow-background/plan.md](docs/dev/workflow-background/plan.md)。

### Agent tree

```
● 4 active Agents · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
    bash ▸grep monthlyQuota
  修订方案:月额度纳入调度 #81ab2a94 Plan kimi-k3 🧠思考 6s $0.0021
  » 调度模块需要支持月额度,我倾向于在 quota-bucket 里加一个 monthly 窗口
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- 头部 bullet 取全场最严重的高亮色，显示活跃数与实时花费。
- 每个 run 一行主行：标签、`#id`、类型、模型、人性化相位（`🧠思考` / `🔧工具` / `♻重试2/3` / `⏸排队` / `🗜压缩` / `⏹停止中`）、耗时、费用；嵌套 run 缩进在父级下方（`↳`），workflow 渲染为 `⚙` 组头。
- 工具调用或思考中时追加**活动行**：近期工具轨迹 + 高亮的在途 `▸工具`，或模型流式文本的 `»` 尾部。并行工具调用的状态同样准确。
- 高亮：`!` 黄 = 空闲超过 idle 预算一半；`✗` 红 = 停止中或超过总 deadline。终态行按驻留时间淡出，通知发不出去时最多保留 10 分钟硬兜底。

### 定时任务

session 启动时从 `~/.pi/agent/pi-subagent-schedules.json` 加载，到点自动发起 subagent run（走正常的 slot 队列与防卡死看管）：

```json
[
  {
    "id": "nightly-review",
    "schedule": { "kind": "cron", "expression": "0 3 * * *" },
    "request": { "type": "general", "prompt": "审查昨晚的提交并汇报风险", "label": "nightly-review" }
  }
]
```

- `schedule.kind`：`"cron"`（五段表达式）/ `"interval"`（`intervalMs`）/ `"once"`（`at` 为 ISO 时间，触发后自动移除）
- `request` 与 `Agent` 工具的 spawn 参数同构（`runId` 除外）
- 启动时已过期的任务不补跑；编辑文件后 `/reload` 生效

## 项目记忆（memory）

Claude Code 风格的 cwd-keyed 被动记忆：每个会话自动把当前项目的 memory（`~/.pi/agent/memory/<cwd-slug>/*.md`）注入 system prompt——不需要任何 skill 调用，子 agent 会话同样生效。

- **预算感知注入**：全部文件索引（≤15 条）+ 最新 3 个文件内联全文（4KB UTF-8 字节预算），超出的只留索引；空目录不注入（不白烧 token）；注入块尾部带哨兵注释防重复注入；结果按目录指纹缓存。
- **`memory` 工具** — 模型可调用：`list` 查看；`write` / `append` 自主沉淀跨会话记忆（目录围栏 + 文件名白名单 + 双字节上限 + 0600；写入自动带 `source: agent` 溯源，注入时加"数据非指令"围栏行）。**子会话默认只读**（`memory.allowWriteInChildSessions` 放开）。
- **frontmatter `pin: true`** — 让重要文件永远留在内联区，不被 mtime 挤出去。
- **`/mem` 命令** — `list` / `path` / `import [--force] [slug|all]`：一键把 `~/.claude/projects/*/memory/` 复制到 pi 侧（幂等、0600、CC 原件不动）。
- **`memory.freezeInjectionAfterWrite`** — 写入后冻结本会话注入块（默认关）：长会话中频繁写 memory 时避免 prompt 缓存前缀反复失效。

## 工具箱模块

- **HUD footer** — 安装即接管 pi 底部 footer（`hud.enabled: false` 一键还原）。显示 pwd/git 分支与工作树、token/费用统计（含 subagent 实时费用）、上下文用量、模型与 thinking 档位、LLM 计时与生成速率。
- **`web_search` 工具** — Codex / SerpAPI / Bocha / Tavily 四供应商自动 failover（网络错误/超时/429/5xx 指数退避后切换），主会话与子会话均可用；凭证见「配置」。
- **任务工具** — `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskDelete` + 编辑器上方的任务 widget + `/tasklist` 面板，状态持久化在会话文件里（fork/resume 无损恢复）。
- **`ask_user` 工具** — 交互式澄清：结构化多选问题（≤4 题批量），TUI/RPC 均支持；多问题缺 header 时自动从问题文本派生标签页标题（超长截断、派生撞车自动加后缀，显式重复 header 仍拒绝；单问题只做 trim/截断，不会凭空补 header）；仅主会话可用（子 agent 会话是 print 模式，注册了也只能返回 headless 错误，因此不对子会话注册）。
- **飞书通知** — `@notify` 关键词、`/watch`、`/feishu-test` 与结果/汇总/心跳/等待输入卡片（被动触发，无 AI 主动调用面）。完成类通知默认等后台 subagent 与后台 bash 全部空闲才发（`requireBackgroundIdle`，忙时抑制不补发）。
- **会话导航** — `/resume` 默认只扫最近 48 小时（Tab / `--all` 全量），skill 会话标题清洗、subagent 会话标注 `[sub:类型]`；`/clear` 开新会话；裸 `exit` 直接退出。
- **`/goal` 目标循环** — 给一个目标和结束条件，每轮结束自动评估并续跑直到达成或撞线（详见下文）。
- **cache TTL** — `/cache-ttl on|off|auto` 即时切换 Anthropic prompt cache 的 TTL 处理（`on` 强制 `ttl: "1h"`），`/cache-ttl save` 持久化；状态栏显示 `⏱ cache: 1h|5m`。adaptive 模式下的 1h 升级受**双写预算**约束：美元边际成本主闸 `cacheTtl.adaptiveWriteBudgetUsd`（默认 `1.0`，`0` = 关闭美元闸；口径 = 账本 `cost.cacheWrite` × 0.375，即 1h 写 2.0× 对 5m 写 1.25× 的边际差）+ token 兜底 `adaptiveWriteBudgetTokens`（200k 不变，`0` = 禁止一切升级），任一撞线即整会话熔断。探针地板随实测前缀缩放（`min(64k, max(4k, 0.5×P))`）：小前缀路由上一次近全量重写即熔断，P ≥ 128k 时与原固定 64k 地板行为完全一致。
- **额度感知派单（quota）** — 拉取 GLM / Kimi 订阅额度（TTL 缓存、零周期定时器），turn_end 阶梯预警（L1 `[quota]` tick 行 → L2 回退链降位建议 → L3 禁用建议），spawn 阶段对超额 provider 快速失败（陈旧快照只提示不阻断），HUD 带状态行；降位标记持久化到 `~/.pi/agent/quota-state.json`，`quota.*` settings 可关，设计见 `docs/dev/quota/`。
- **system prompt 稳定化** — 三段动态内容（项目记忆 / agent 类型 / 可用模型）折叠成冻结快照折叠进开头，真实变化改走对话尾部的更新消息，不再让开头字节每轮变化而使整段 prompt cache 失效；通知唤醒轮（`triggerTurn`）默认回放最近一次用户轮的开头，消除「用户轮/唤醒轮」两条前缀交替失效的问题。`systemPrompt.mode`（`stable`/`live`/`legacy`）、`systemPrompt.wakeReplay`、`systemPrompt.adoptForeignForcedPrompt` 三键可调；**回滚到今天的逐字节行为**：`{ "systemPrompt": { "mode": "legacy", "wakeReplay": false } }`。设计见 `docs/dev/sysprompt-stable/plan.md`，手工验收见 `docs/dev/sysprompt-stable/acceptance.md`。

## bash 自动转后台

默认开启（仅 POSIX）：以同名方式覆盖 pi 内置 `bash` 工具，短命令行为与内置**逐字节一致**（前台路径直接复用 pi 自己的实现）。只有跑过阈值的命令改变行为：调用提前返回 `job_id`，**进程不杀**、输出继续落日志，退出时以 `bash-job:notification` 注入完成通知（带输出尾巴，并触发新 turn）。明知是长命令可直接传 `run_in_background: true`。

`bash_job` 工具管理这些 job（`job_id` 支持唯一前缀）：`status`（状态 + 日志尾部 + 路径）/ `wait`（有界阻塞，默认 30s 硬顶 120s）/ `kill`（杀整个进程组，幂等 + pid 复用防护）/ `list`。**没有 `output` 动作**——日志就是 `~/.pi/agent/bash-jobs/<sessionId>/<job>.log` 普通文件，`read`/`tail`/`grep` 直接分析比任何工具参数都灵活。

| 键                           | 默认                     | 含义                                                                        |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `bashJobs.autoBackgroundS`   | `290`                    | 前台 bash 超过该时长转后台；`0` = 整个功能关闭（内置 bash 零变化）          |
| `bashJobs.maxLogBytes`       | `10485760`               | 单 job 日志上限；写满停写标记截断，**进程继续跑**                           |
| `bashJobs.maxBackgroundJobs` | `8`                      | 并发后台 job 上限                                                           |
| `bashJobs.retentionS`        | `86400`                  | 终态 job 的 JSON/日志保留时长；`<=0` 关闭清理                               |
| `bashJobs.shutdownPolicy`    | `"keep"`                 | pi 真退出时对仍在跑的 job：`keep` / `kill`；reload/new/resume/fork 一律保留 |
| `bashJobs.dir`               | `~/.pi/agent/bash-jobs`  | job 状态与日志的 root（按 `<sessionId>/` 分层）                             |
| `bashJobs.shellPath`         | `$SHELL`(白名单)→ `bash` | 执行命令的 shell（`$SHELL` 仅 basename ∈ {bash, zsh, sh} 时采用）           |

行为要点：

- **win32 不覆盖**：无进程组语义，内置 `bash` 原样保留。
- **目录清理**：session 启动时扫一次，之后每次新建 job 时最多每 10 分钟再扫一次（不新增定时器）。只碰 `.json` / `.log` / `.tmp` 三种后缀，非终态 job 永不删。
- **敏感输出会落盘**（0600/0700，与 session 文件同威胁模型），直到 `retentionS` 过期——仍应重定向敏感输出。
- **日志自洽**：进程终态时日志尾部追加一行结论（形如 `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s`），`tail -3` 即知结局；写满 `maxLogBytes` 也照样追加。
- **重启/reload 后收养**：仍在跑的 job 在下一个 session 被重新接管并继续通知；pid 归属无法确认的 job 只标记不杀。

## /goal 目标驱动持续运行

```
/goal 修复 issue #42 并补测试 --until-cmd "npm test" --max-turns 15
/goal 完成订单模块重构 --until "npm run build 通过且旧 api 目录已删除" --budget-tokens 2000000
/goal                  # 查看状态
/goal pause | resume | clear
```

- **判定器两种可叠加**（AND 语义）：`--until-cmd` 每轮跑确定性命令（exit 0 通过，零模型成本先行短路）；`--until "自然语言条件"` 由独立 verifier subagent 评估（默认 `claude-sonnet-5`，与干活模型隔离，只读取证 + schema 结构化提交），未达成时其差距说明注入为下轮指引。
- **刹车系统**：轮数（默认 20）、token/成本预算、时长（默认 120 分钟）。撞线后注入终止报告指令让 agent 总结进展与卡点，不静默消失。
- **急停**：Ctrl+C 中断自动暂停 goal（不续跑），`/goal resume` 恢复。
- **持久化**：goal 随会话文件走，崩溃/`/reload` 后读回并**降级为 paused**（绝不自动续跑）。
- 运行期间状态栏显示 `🎯 goal 3/20`；goal 运行期间模型被禁止调用 `ask_user`。

## Message fabric

subagent 之间的可选 fire-and-forget 消息协议（`"fabric": { "enabled": true }` + `/reload`）。`message_agent` 支持三种 kind：`progress`（进展）、`finding`（发现）、`directive`（指令）；返回值表示消息是否进入投递队列，而不是目标已收到。消息沿 agent tree 的边路由，由发送方类型的 `can_message` frontmatter 门控关系（`parent`/`child`/`ancestor`/`descendant`/`sibling`/`self`，默认仅 `parent`）。平级消息是不可信输入，接收方应按外部建议重新验证。配额、TTL、死信、root 背压等完整设置见 [`docs/dev/subagent-push/subagent-push-plan.md`](docs/dev/subagent-push/subagent-push-plan.md)。

## 防卡死架构

每个 run 都是一条纯状态机（`src/core/state-machine.ts`），由会话事件驱动：

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (超时/停止:→ abort_grace → reap → settled)
```

1. **信号**：每个会话事件（文本增量、工具 start/end/update、retry、compaction）都刷新 `lastEventAt`。空闲 = `now - lastEventAt`——正在流式输出的模型、有心跳的工具永远不算"卡住"。
2. **Deadline**：每个相位挂独立计时器——启动 30s、首事件 120s、模型 turn 空闲 240s、单工具 600s、压缩 300s、总计 30min（全部可配）。`EventWatchdog` 以 1Hz tick 派发 `deadline_fired`。
3. **升级**：运行中相位超时 → `cancel_signal` + `soft_steer`（"wrap up now"，给 agent 体面收尾的机会）→ 10s abort 宽限 → 强制 abort。若仍失败，`EscalatingReaper` 逐级爬升 L0 cancel → L1 steer → L2 requestAbort → L3 dispose（强杀进程句柄）→ 仍杀不掉的登记为 **orphan**，绝不遗忘。

重试有独立的 backoff 相位，不会误触 idle 计时器；并行工具调用让 run 停留在 `tool_exec` 直到**最后一个**兄弟调用结束。

## 配置

用户配置：`~/.pi/agent/pi-subagent.json`（文件名沿用历史名称；文件缺失/格式错误一律用默认值，绝不抛错）。

`/agent settings` 打开**交互式设置编辑器**（↑↓ 选择、回车编辑、空格切换布尔、`r` 重置默认、Esc 关闭，改动即时落盘）；脚本场景用 `/agent settings list` / `set <key> <value>` / `reset <key>`，`/agent budget` 是限定到 `budget.*` 的别名。

**所有时间字段以整数秒配置**（键名以 `S` 结尾）；旧版毫秒键（`*Ms`）首次加载时自动迁移。

```jsonc
{
  "concurrencyLimit": 6,
  "fleetWidget": true, // 编辑器上方的 agent tree
  "maxNestedDepth": 2, // 子 agent 再 spawn 子 agent 的深度上限
  "resultMaxChars": 8000, // 结果文本上限；0 不限，live 生效
  "worktree": { "enabled": false },
  "memory": { "enabled": true }, // 项目记忆（注入 + memory 工具 + /mem）
  "hud": { "enabled": true }, // HUD footer；false 还原 pi 内置 footer
  "webSearch": { "enabled": true }, // web_search 工具
  "todo": { "enabled": true }, // Task* 任务工具 + /tasklist
  "askUser": { "enabled": true }, // ask_user 交互提问
  "feishuNotify": { "enabled": true }, // 飞书通知卡片（仅主会话）
  "sessionNav": { "enabled": true }, // 会话导航增强
  "workflow": { "enabled": false },
  "goal": { "enabled": true }, // /goal（maxTurns/maxMinutes/budget*/verifier* 等子键可调）
  "budget": {
    "idleS": 240, // 模型 turn 静默多久算超时
    "modelTurnS": 900, // 单轮模型调用硬上限
    "toolS": 600, // 单次工具调用上限
    "totalS": 1800, // 整个 run 的上限
    // … queueWaitS, startupS, bindS, firstEventS, compactionS,
    //   abortGraceS, steerS, reapS, startupRetries, retrySlackS
  },
}
```

**`web_search` 的供应商凭证在另一处**：环境变量，或 `~/.config/pi/web-search.env`（建议 0600）：`CODEX_SEARCH_API_KEY` + `CODEX_SEARCH_BASE_URL`（可选 `CODEX_SEARCH_MODEL`、`CODEX_SEARCH_TLS_INSECURE`）、`SERPAPI_API_KEY`、`BOCHA_API_KEY`、`TAVILY_API_KEY`，至少配一家；`PI_WEB_SEARCH_ENV_FILE` 可覆盖该路径。

## 命令

| 命令                    | 内容                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `/agent status`         | 所有非终态 run 的诊断：相位、最近事件、空闲时长、孤儿 session                  |
| `/agent status <runId>` | 单个 run 的完整工具时间线                                                      |
| `/agent costs`          | 按花费降序的逐 run 明细                                                        |
| `/agent settings`       | 交互式设置编辑器                                                               |
| `/task <任务描述>`      | 启动一个后台 general-purpose subagent 执行任务；主会话会收到启动记录与完成通知 |
| `/mem`                  | 项目记忆：`list` / `path` / `import [--force] [slug\|all]`                     |
| `/tasklist`             | 任务列表面板（`/tasklist clear` 清空）                                         |
| `/goal`                 | 目标驱动循环（status / pause / resume / clear）                                |
| `/watch`                | 标记本会话，每次任务结束都通知飞书                                             |
| `/pi-hud-refresh`       | git fetch 并刷新 HUD footer                                                    |
| `/cache-ttl`            | prompt cache TTL 模式（on/off/auto/save）                                      |
| `/resume-recent`        | 恢复最近 48 小时的会话（`--all` 全量；裸输 `resume` 等效）                     |
| `/clear`                | 开新会话（裸输 `clear` 等效）                                                  |

## 从独立插件迁移

下列独立插件已逐一融合进本包。迁移 = **卸载旧包 + 升级本包 + `/reload`**：

- `@getpipher/armory-memory` → `pi remove` 即可，memory 数据（`~/.pi/agent/memory/**`）零迁移生效。
- `@bluecake/pi-ask-user` → `pi uninstall`；飞书配置 `~/.pi/agent/feishu-notify.json` 原样保留。
- pi-hud / web-search / pi-claude-todo / session-nav 等散装扩展 → 删除 `~/.pi/agent/extensions/` 下的对应文件/目录。

**残留识别**：pi 对重名命令会加后缀——看到 `/mem:1` `/mem:2`、`/tasklist:1` `/tasklist:2` 而**裸命令消失**，即说明旧插件仍在加载；同名工具则是 first-wins 静默遮蔽（看工具 description 是否含新能力即可判定生效方）。

## 开发

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest：2600+ 测试——状态机迁移矩阵、
                     # 带种子的属性不变量、组件渲染……
npm run typecheck
npm run format
```

版本化 pre-commit hook（对暂存文件跑 prettier）：`git config core.hooksPath .githooks`

目录结构：`core/` 纯状态机 + deadline（无 I/O）· `runtime/` 看门狗、会话驱动、回收器 · `service/` spawn/query/registry · `tools/` 面向 LLM 的工具面 · `ui/` agent-tree 视图 + 设置编辑器 · `workflow/` 沙箱编排器 · `memory/` 项目记忆 · `fabric/` 消息 fabric · `goal/` 目标循环 · `bash/` bash 自动后台 · `delivery/` 通知投递管线 · `hud|web-search|todo|ask-user|feishu-notify|session-nav|compact-hint|context-switch|cache-ttl/` 工具箱模块 · `sysprompt/` + `prompt-sections/` system prompt 稳定化 hub · `adapters/` 面向 pi 的胶水层。

Node.js ≥ 22（用了 `fs.globSync`）。

## License

MIT
