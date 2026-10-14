# 外部 agent provider：需求与已定决策（#22）

> 2026-10-14 用户拍板。首个落地对象：**Factory droid**（本机 `droid` 0.241.1）；后续 Codex、Claude Code 复用同一框架。

## 目标

让 pi-toolkit 的子 agent 能由外部 CLI agent 执行：新增一个外部驱动，实现 `SessionDriver` / `SessionHandle`，
把 `droid exec` 当子进程运行，并把它的无头 JSON 事件翻译成 `DriverEvent`。上层的超时 / 宽限 / 延长、看门狗、
reaper、通知投递、agent 树、web-hub、worktree 隔离原样复用。主要收益是用上 droid 自己的订阅额度和工具链。

## 已定决策（用户拍板，不再讨论）

| #   | 决策                                                          | 内容                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | **调用方式 = 虚拟 provider**                                  | 用 `model: "droid/<droid 内的模型 id>"` 指定（例：`droid/<model>`）。droid 作为一个 provider 出现在系统提示的「Available models」列表里，Agent 工具、workflow `agent({model})`、dev-flow 路由表都能直接写；额度 / 费用按 `droid` 一个池管理。spawn 准入的「host 模型注册表校验」需要认得这个虚拟 provider（不能把 `droid/*` 当拼写错误拒掉）。                                                 |
| U2  | ~~权限 = 按角色分级~~ **（已被下方 U2′ 推翻：一律完整权限）** | 只读角色（`verifier` / `reviewer` / `Explore` / `Plan` / `architect`、以及 `toolDomain:"readonly"` 的请求）→ droid 的只读档；开发类（`general` / `frontend-dev` / `general-purpose` 等）→ 允许改文件 + 跑命令、**不联网**的那一档。具体映射到 droid 哪个自治级别，以 P0 实测（`droid-protocol.md`）为准；若 droid 没有真正的只读档，必须在方案里给出替代方案（如禁用写类工具），不能静默放开。 |
| U3  | **首版范围 = Agent 工具 + workflow `agent()`**                | 两个入口都能派 droid，包括 worktree 隔离、超时延长（`timeout_s` 可延长）、resume（续跑 droid 会话）。依赖子会话里加载 pi-toolkit 扩展的能力（consult、`schema`/StructuredOutput、`message_agent`、嵌套 Agent、`switch_context`、bash settle-hold、cache keepalive、memory 注入、`set_model` 等）在 droid 上**降级或明确拒绝并报清楚原因**，不能静默失效。consult 的专家是 droid run 时同理。   |

## 硬约束（项目既有）

- **零卡死**：任何 droid run 都必须在分层截止时间内终止；进程组可被 reaper 整组杀掉，不留孤儿进程。所有计时器 `unref()`。
- 不在 `src/` 内做 `pi-subagent → pi-toolkit` 改名；`~/.pi/agent/pi-subagent.json` 设置文件沿用。
- 新功能必须有设置开关（建议 `externalAgents.droid.enabled`，默认值由方案提出并说明理由），关闭时行为与现状字节一致。
- 不得打印 / 持久化任何 droid 凭据。
- 需要真机一致性测试（`tests/conformance/` 模式，真实 droid），在 droid 升级时能提前发现协议变化。

## 第二轮拍板（2026-10-14，读完 arch.md §14.1 后；**与 arch.md 冲突处以此为准**）

| #   | 决策                                           | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U2′ | **权限：一律完整权限（推翻 U2 的按角色分级）** | 用户原话「先不考虑权限问题，使用完整权限运行」。所有角色（含 verifier/reviewer/Explore/Plan/architect）都以 droid 最高自治运行（`autonomyLevel:"high"` 或 spike 确认的等价「全放行」项）。arch.md 的三档白名单、角色→档位映射、策略拒绝自动续跑、越界检测在 v1 **删除**（Q1/Q2/Q3/Q9 作废）。droid 的反向 `request_permission` 一律自动批准（形状由 spike S2 确认）。**主会话裁定的唯一例外**：`SpawnRequest.toolDomain:"readonly"`（程序内部只读请求，如 memory tidy 提案）不是角色，仍保持只读保证——用工具白名单（Read/LS/Glob/Grep）或直接拒绝路由到 droid，二选一由方案给出。 |
| U4  | **费用：pi 按 usage 自己算美元**               | 不用 Factory credits 当费用。用 droid 上报的 token 用量（input/output/cacheRead/cacheWrite/thinking）× **底层模型**单价算 `costUsd`：droid `availableModels` 给出每个模型的底层 provider/模型，按 pi 模型注册表里同一底层模型的价格计费（匹配规则由方案给出；匹配不到 ⇒ `costUsd` 不填/未定价，并在诊断里标 `unpriced`，不能填 0 冒充免费）。credits 只作诊断信息。fleet/HUD/`/agent costs`/成本上限照常消费 `costUsd`。                                                                                                                                                          |
| U5  | **注入项目记忆**                               | 与 pi 子 agent 一致，把项目记忆拼进 droid 任务首条消息（Q7 推荐）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| U6  | 采纳推荐                                       | Q4 `externalAgents.droid.enabled` 默认 **false**；Q5 协议版本漂移默认 **fail closed**，保留 `protocolCheck:"warn"`；Q8 schema 提取失败 v1 **不做**修复轮。                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 环境事实（2026-10-14 实测）

- **凭据直接继承 pi 的进程环境，不做专门加载**（用户确认）：`FACTORY_API_KEY` 由 `~/.factory/env.sh` 在 zsh 启动时
  自动导出；本次 402（「Organization does not have an active paid subscription」）只是因为 pi 进程早于该文件生效启动、
  环境里是旧值，pi 重启即恢复。驱动只需：①把 droid 的 402 / 鉴权失败映射成清楚的终态错误（提示检查
  `FACTORY_API_KEY`、必要时重启 pi），不能被当成普通模型失败反复重试；②全程不打印、不持久化任何凭据值。

## 输入产物

- `docs/dev/external-agent/droid-protocol.md` + `samples/` — P0 droid 无头协议实测（事实来源）
- `docs/dev/external-agent/explore-seams.md` — 我们这边的接入接缝调研
