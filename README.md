# pi-toolkit

**中文** | [English](README.en.md)

[pi](https://github.com/earendil-works/pi) 的工具箱扩展。旗舰是一套**零卡死 subagent 系统**（`Agent` / `get_subagent_result` / `steer_subagent` / `SubagentWorkflow`），外加一组可按需开关的日常模块：项目记忆、上下文交接与缓存保活、额度与负载感知、bash 自动转后台、任务工具、`/goal`、飞书通知，以及可选的浏览器控制面（Web Hub）。单一安装入口，统一 settings 门控。

## 核心特点

1. **零卡死** — 每个 subagent run 是一条带分相 deadline 的纯状态机：1Hz 看门狗触发超时，升级阶梯（cancel → steer → abort → dispose）回收资源，杀不掉的登记为 orphan。每个 run 必然到达终态。
2. **可观测** — 编辑器上方常驻实时 agent tree（相位、在途工具、流式尾部、实时费用）；`/agent status` 给出逐 run 的工具时间线；Web Hub 里同样可见。
3. **结果必达** — 完成通知走持久化、可确认的投递管线，不会静默丢失。
4. **派完即走** — 主会话的 `Agent` 和 `SubagentWorkflow` 一律后台运行，立即返回 id，完成通知驱动下一步；bash 命令超过阈值（默认 290 秒）自动转后台，进程不杀。
5. **工具箱，不是单体** — 除 subagent 核心外，每个模块都能独立开关，装一个包按需取用。

## 安装

pi 直接加载 TypeScript 源码（经 jiti），无需构建：

```sh
pi install git:github.com/Newbluecake/pi-toolkit
# 更新：
pi update --extension git:github.com/Newbluecake/pi-toolkit
```

也可以从 [GitHub Releases](https://github.com/Newbluecake/pi-toolkit/releases) 下载总 zip。下载后解压，并在解压目录执行：

```sh
cd pi-toolkit
npm install --omit=dev
pi install .
```

总 zip 可直接作为本地 pi 扩展安装（本地路径方式，不参与 `pi update`）。Web UI 另有 `pi-toolkit-web-ui-<version>.zip` 附件：手工解压到 `~/.pi/agent/`，即可安装到 `~/.pi/agent/web-hub-ui/<version>/`，无需重启 hub。

## 模块总览

详细用法在 [`docs/guide/`](docs/guide/)（中文）；内部设计在 [`docs/dev/`](docs/dev/)。

| 模块                      | 说明                                                                                                                                                      | 指南                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Subagent 工具             | `Agent` / `get_subagent_result` / `steer_subagent` / `abort_subagent` / `extend_subagent_timeout` / `set_model`，后台运行、可延长超时、可 worktree 隔离。 | [subagents](docs/guide/subagents.md#工具)                        |
| Agent tree                | 编辑器上方的实时 subagent 树：相位、工具轨迹、费用、超时高亮。                                                                                            | [subagents](docs/guide/subagents.md#agent-tree)                  |
| SubagentWorkflow          | 沙箱化 JS 编排（`agent()` / `parallel()` / `pipeline()`），后台运行，带 journal 回放。默认关闭。                                                          | [subagents](docs/guide/subagents.md#subagentworkflow)            |
| 定时任务                  | 从 JSON 文件加载 cron / interval / once 任务，到点自动派发 subagent。                                                                                     | [subagents](docs/guide/subagents.md#定时任务)                    |
| 防卡死架构                | 分相 deadline、升级阶梯、orphan 登记、持久化通知投递。                                                                                                    | [subagents](docs/guide/subagents.md#防卡死架构)                  |
| Message fabric            | subagent 间沿 agent tree 的 fire-and-forget 消息（`message_agent`）。默认关闭。                                                                           | [subagents](docs/guide/subagents.md#message-fabric)              |
| consult 专家咨询          | 子 agent 在一轮内同步咨询已结束的专家 run 或主会话（`consult`）。                                                                                         | [subagents](docs/guide/subagents.md#consult-专家咨询)            |
| 外部 droid agent          | 把 Factory droid 当作 `droid/<model>` 虚拟 provider 派发，带模型白名单与额度闸门。默认关闭。                                                              | [subagents](docs/guide/subagents.md#外部-droid-agent)            |
| 项目记忆                  | cwd 为键的被动记忆，分层注入 + `memory` 工具 + `/mem doctor` / `tidy`。                                                                                   | [memory](docs/guide/memory.md)                                   |
| bash 自动转后台           | 覆盖内置 `bash`：长命令转后台不杀，`bash_job` 管理，宽限与续期。                                                                                          | [bash](docs/guide/bash.md)                                       |
| 上下文交接与用量提示      | `switch_context` / `compact_context`，用量阶梯提示与强制线。                                                                                              | [context](docs/guide/context.md#switch_context--compact_context) |
| cache TTL 与保活          | Anthropic prompt cache 的 TTL 模式与保活 ping，带熔断与证据层。                                                                                           | [context](docs/guide/context.md#cache-ttl-与保活)                |
| system prompt 稳定化      | 动态段落折叠成冻结快照，变化走尾部更新消息，保住缓存前缀。                                                                                                | [context](docs/guide/context.md#system-prompt-稳定化)            |
| 日期注入                  | 首轮、跨日和长闲置后给模型注入 `[date]`。                                                                                                                 | [context](docs/guide/context.md#date-日期注入)                   |
| 额度感知                  | GLM / Kimi 订阅与 droid Standard / Core 池额度：阶梯预警、派发闸门、Core→Standard 回落。                                                                  | [quota-load](docs/guide/quota-load.md#额度感知quota)             |
| 负载感知                  | CPU / 内存 / IO / 磁盘采样，本机繁忙时暂缓新派发。                                                                                                        | [quota-load](docs/guide/quota-load.md#负载感知派单load)          |
| 任务工具                  | `TaskCreate` 等五个工具 + widget + `/tasklist`，完成项折叠与自动归档。                                                                                    | [tools](docs/guide/tools.md#任务工具todo)                        |
| `/goal`                   | 目标驱动循环：确定性命令或 verifier subagent 判定，带轮数 / 预算 / 时长刹车。                                                                             | [tools](docs/guide/tools.md#goal-目标循环)                       |
| `ask_user` / `web_search` | 结构化交互提问；四供应商 failover 的联网搜索。                                                                                                            | [tools](docs/guide/tools.md#ask_user)                            |
| HUD footer                | 接管 pi 底部 footer：git、token / 费用、上下文、额度 / 负载。                                                                                             | [tools](docs/guide/tools.md#hud-footer)                          |
| 飞书通知                  | 被动触发的结果 / 汇总 / 心跳卡片（`@notify`、`/watch`）。                                                                                                 | [tools](docs/guide/tools.md#飞书通知)                            |
| 会话导航                  | `/resume-recent`、`/clear`、裸 `exit`，会话标题清洗。                                                                                                     | [tools](docs/guide/tools.md#会话导航)                            |
| topic-switch              | 新请求与当前会话无关且缓存已冷时，建议开新会话。                                                                                                          | [tools](docs/guide/tools.md#topic-switch)                        |
| 自动标题 / 延迟 `/reload` | 小模型生成会话标题；有 subagent 在跑时延后 `/reload`。                                                                                                    | [tools](docs/guide/tools.md#自动标题)                            |
| Web Hub（可选）           | 浏览器查看与控制会话：网页发消息、`ask_user` 竞速、托管会话与恢复、预览、worktree diff / 图、LAN 密码、隐私锁。                                           | [web-hub](docs/guide/web-hub.md)                                 |
| 从独立插件迁移            | 旧插件的卸载与残留识别。                                                                                                                                  | [migration](docs/guide/migration.md)                             |

## 命令

| 命令                                                                      | 内容                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/agent`（`status [runId]` / `costs` / `settings` / `budget` / `reload`） | 运行诊断、费用明细、设置编辑器、延迟 reload                                             |
| `/task <描述>`                                                            | 启动一个后台 general-purpose subagent                                                   |
| `/goal`                                                                   | 目标循环（`status` / `pause` / `resume` / `clear`）                                     |
| `/mem`                                                                    | 项目记忆：`list` / `path` / `import` / `doctor` / `tidy` / `restore`                    |
| `/tasklist`                                                               | 任务面板（`clear` 清空）                                                                |
| `/cache-ttl`                                                              | `on` / `off` / `auto` / `save` / `keepalive on\|off\|reset` / `status` / `probe`        |
| `/topic-switch`                                                           | 查看状态（`status`），`last [--send]` 取回上次截留的请求                                |
| `/webhub`                                                                 | `status` / `open` / `restart` / `stop` / `start` / `token rotate` / `passwd` / `unlock` |
| `/watch`                                                                  | 本会话每次任务结束都通知飞书                                                            |
| `/feishu-test`                                                            | 发送飞书测试卡片                                                                        |
| `/pi-hud-refresh`                                                         | `git fetch` 并刷新 HUD                                                                  |
| `/resume-recent`                                                          | 恢复最近 48 小时的会话（`--all` 全量）                                                  |
| `/clear`                                                                  | 开新会话                                                                                |

## 配置

用户配置文件：`~/.pi/agent/pi-subagent.json`（沿用历史文件名；缺失或格式错误一律用默认值，不抛错）。

- `/agent settings` 打开交互式编辑器（↑↓ 选择、回车编辑、空格切换布尔、`r` 重置默认，改动即时落盘）；脚本场景用 `/agent settings list` / `set <key> <value>` / `reset <key>`。
- **所有时间字段以整数秒配置**（键名以 `S` 结尾，如 `budget.idleS`）；旧版毫秒键（`*Ms`）首次加载时自动迁移。
- 各模块的详细键与默认值见对应指南。

顶层启用开关（括号内为默认值）：

```jsonc
{
  "workflow": { "enabled": false }, // SubagentWorkflow
  "fabric": { "enabled": false }, // message_agent
  "worktree": { "enabled": false }, // isolation: "worktree"
  "memory": { "enabled": true },
  "hud": { "enabled": true },
  "webSearch": { "enabled": true },
  "todo": { "enabled": true },
  "askUser": { "enabled": true },
  "feishuNotify": { "enabled": true },
  "sessionNav": { "enabled": true },
  "goal": { "enabled": true },
  "consult": { "enabled": true },
  "quota": { "enabled": true },
  "load": { "enabled": true },
  "topicSwitch": { "enabled": true },
  "date": { "enabled": true },
  "externalAgents": { "droid": { "enabled": false } },
  "webHub": { "enabled": false },
}
```

`web_search` 的供应商凭证在另一处，见 [tools 指南](docs/guide/tools.md#web_search)。

## 开发

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest：17,000+ 测试（状态机迁移矩阵、属性不变量、组件渲染……）
npm run typecheck
npm run format
```

Node.js ≥ 22。版本化 pre-commit hook（对暂存文件跑 prettier）：`git config core.hooksPath .githooks`。仓库结构与各子系统的设计约束见 [AGENTS.md](AGENTS.md)，逐功能的设计文档在 [`docs/dev/`](docs/dev/)。

## License

MIT
