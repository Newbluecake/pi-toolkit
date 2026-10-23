# pi-toolkit

**中文** | [English](README.en.md)

[pi](https://github.com/earendil-works/pi) 的工具箱扩展。旗舰是一套**零卡死 subagent 系统**（`Agent` / `get_subagent_result` / `steer_subagent` / `SubagentWorkflow`），外加一组可按需开关的日常模块：项目记忆、上下文交接与缓存保活、额度与负载感知、bash 自动转后台、任务工具、`/goal`、飞书通知，以及可选的浏览器控制面（Web Hub）。单一安装入口，统一 settings 门控。

<p align="center">
  <img src="docs/images/hero-web-desktop.png" alt="Web UI：会话列表、对话与代理树" width="100%">
  <br>
  <sub>Web UI：会话列表、对话、代理树（阶段 / 成本 / consult 缓存命中）与订阅额度一屏可见</sub>
</p>

<p align="center">
  <img src="docs/images/web-desktop-dark.png" alt="Web UI 深色主题" height="320">
  <img src="docs/images/web-mobile-list.png" alt="手机端会话列表" height="320">
  <img src="docs/images/web-mobile-chat.png" alt="手机端对话" height="320">
  <img src="docs/images/web-mobile-agents.png" alt="手机端代理抽屉" height="320">
  <br>
  <sub>深色主题 · 手机端（会话列表 / 对话 / 代理抽屉）</sub>
</p>

## 核心特点

<p align="center">
  <img src="docs/images/tui-agent-tree.png" alt="终端中的代理树小组件与 HUD 页脚" width="100%">
  <br>
  <sub>终端内：代理树小组件 + HUD 页脚</sub>
</p>

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

| 模块                      | 说明                                                                                                                                                                                                                                                                                             | 指南                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Subagent 工具             | `Agent` / `get_subagent_result` / `steer_subagent` / `abort_subagent` / `extend_subagent_timeout` / `set_model`，后台运行、可延长超时、可 worktree 隔离。                                                                                                                                        | [subagents](docs/guide/subagents.md#工具)                        |
| Agent tree                | 编辑器上方的实时 subagent 树：相位、工具轨迹、费用、超时高亮。                                                                                                                                                                                                                                   | [subagents](docs/guide/subagents.md#agent-tree)                  |
| SubagentWorkflow          | 沙箱化 JS 编排（`agent()` / `parallel()` / `pipeline()`），后台运行，带 journal 回放。默认关闭。                                                                                                                                                                                                 | [subagents](docs/guide/subagents.md#subagentworkflow)            |
| 定时任务                  | 从 JSON 文件加载 cron / interval / once 任务，到点自动派发 subagent。                                                                                                                                                                                                                            | [subagents](docs/guide/subagents.md#定时任务)                    |
| 防卡死架构                | 分相 deadline、升级阶梯、orphan 登记、持久化通知投递。                                                                                                                                                                                                                                           | [subagents](docs/guide/subagents.md#防卡死架构)                  |
| Message fabric            | subagent 间沿 agent tree 的 fire-and-forget 消息（`message_agent`）。默认关闭。                                                                                                                                                                                                                  | [subagents](docs/guide/subagents.md#message-fabric)              |
| consult 专家咨询          | 子 agent 在一轮内同步咨询已结束的专家 run 或主会话（`consult`）。                                                                                                                                                                                                                                | [subagents](docs/guide/subagents.md#consult-专家咨询)            |
| 外部 droid agent          | 把 Factory droid 当作 `droid/<model>` 虚拟 provider 派发，带模型白名单与额度闸门。默认关闭。                                                                                                                                                                                                     | [subagents](docs/guide/subagents.md#外部-droid-agent)            |
| 项目记忆                  | cwd 为键的被动记忆，分层注入 + `memory` 工具 + `/mem doctor` / `tidy`。                                                                                                                                                                                                                          | [memory](docs/guide/memory.md)                                   |
| bash 自动转后台           | 覆盖内置 `bash`：长命令转后台不杀，`bash_job` 管理，宽限与续期。                                                                                                                                                                                                                                 | [bash](docs/guide/bash.md)                                       |
| 上下文交接与用量提示      | `switch_context` / `compact_context`，用量阶梯提示与强制线。                                                                                                                                                                                                                                     | [context](docs/guide/context.md#switch_context--compact_context) |
| cache TTL 与保活          | Anthropic prompt cache 的 TTL 模式与保活 ping，带熔断与证据层。                                                                                                                                                                                                                                  | [context](docs/guide/context.md#cache-ttl-与保活)                |
| system prompt 稳定化      | 动态段落折叠成冻结快照，变化走尾部更新消息，保住缓存前缀。                                                                                                                                                                                                                                       | [context](docs/guide/context.md#system-prompt-稳定化)            |
| 日期注入                  | 首轮、跨日和长闲置后给模型注入 `[date]`。                                                                                                                                                                                                                                                        | [context](docs/guide/context.md#date-日期注入)                   |
| 额度感知                  | GLM / Kimi 订阅与 droid Standard / Core 池额度：阶梯预警、派发闸门、Core→Standard 回落。                                                                                                                                                                                                         | [quota-load](docs/guide/quota-load.md#额度感知quota)             |
| 负载感知                  | CPU / 内存 / IO / 磁盘采样，本机繁忙时暂缓新派发。                                                                                                                                                                                                                                               | [quota-load](docs/guide/quota-load.md#负载感知派单load)          |
| 任务工具                  | `TaskCreate` 等五个工具 + widget + `/tasklist`，完成项折叠与自动归档。                                                                                                                                                                                                                           | [tools](docs/guide/tools.md#任务工具todo)                        |
| `/goal`                   | 目标驱动循环：确定性命令或 verifier subagent 判定，带轮数 / 预算 / 时长刹车。                                                                                                                                                                                                                    | [tools](docs/guide/tools.md#goal-目标循环)                       |
| `ask_user` / `web_search` | 结构化交互提问；四供应商 failover 的联网搜索。                                                                                                                                                                                                                                                   | [tools](docs/guide/tools.md#ask_user)                            |
| HUD footer                | 接管 pi 底部 footer：git、token / 费用、上下文、额度 / 负载。                                                                                                                                                                                                                                    | [tools](docs/guide/tools.md#hud-footer)                          |
| 飞书通知                  | 被动触发的结果 / 汇总 / 心跳卡片（`@notify`、`/watch`）。                                                                                                                                                                                                                                        | [tools](docs/guide/tools.md#飞书通知)                            |
| 会话导航                  | `/resume-recent`、`/clear`、裸 `exit`，会话标题清洗。                                                                                                                                                                                                                                            | [tools](docs/guide/tools.md#会话导航)                            |
| topic-switch              | 新请求与当前会话无关且缓存已冷时，建议开新会话。                                                                                                                                                                                                                                                 | [tools](docs/guide/tools.md#topic-switch)                        |
| 自动标题 / 延迟 `/reload` | 小模型生成会话标题；有 subagent 在跑时延后 `/reload`。                                                                                                                                                                                                                                           | [tools](docs/guide/tools.md#自动标题)                            |
| Web Hub（可选）           | 浏览器查看与控制会话：网页发消息、`ask_user` 竞速、托管会话与恢复、文件 / HTML 沙箱预览、本机端口代理、worktree diff / 图、版本面板、LAN 密码与安全（IP 白名单、二次验证、登录会话管理、飞书安全告警）、隐私锁；可安装为 PWA（[安装到手机 / 桌面](docs/guide/web-hub.md#安装到手机--桌面pwa)）。 | [web-hub](docs/guide/web-hub.md)                                 |
| 加密会话（pi-secure）     | gocryptfs 保险库：项目与会话记录加密落盘，插件守护拦截跨域读写。未配置时零接线。                                                                                                                                                                                                                 | 本文 [加密会话](#加密会话pi-secure)                              |
| 流量录制（traffic）       | `/record` 把 provider 请求 / 响应 / 流式 chunk 录进本地 SQLite，票据归属 + jq 改写规则 + 加固的网页查看 / 重放。默认关闭。                                                                                                                                                                       | 本文 [流量录制](#流量录制traffic)                                |
| 从独立插件迁移            | 旧插件的卸载与残留识别。                                                                                                                                                                                                                                                                         | [migration](docs/guide/migration.md)                             |

## 命令

| 命令                                                                      | 内容                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/agent`（`status [runId]` / `costs` / `settings` / `budget` / `reload`） | 运行诊断、费用明细、设置编辑器、延迟 reload                                                                         |
| `/task <描述>`                                                            | 启动一个后台 general-purpose subagent                                                                               |
| `/goal`                                                                   | 目标循环（`status` / `pause` / `resume` / `clear`）                                                                 |
| `/mem`                                                                    | 项目记忆：`list` / `path` / `import` / `doctor` / `tidy` / `restore`                                                |
| `/tasklist`                                                               | 任务面板（`clear` 清空）                                                                                            |
| `/cache-ttl`                                                              | `on` / `off` / `auto` / `save` / `keepalive on\|off\|reset` / `status` / `probe`                                    |
| `/topic-switch`                                                           | 查看状态（`status`），`last [--send]` 取回上次截留的请求                                                            |
| `/webhub`                                                                 | `status` / `open` / `restart` / `stop` / `start` / `token rotate` / `passwd` / `unlock` / `2fa` / `user` / `feishu` |
| `/watch`                                                                  | 本会话每次任务结束都通知飞书                                                                                        |
| `/feishu-test`                                                            | 发送飞书测试卡片                                                                                                    |
| `/pi-hud-refresh`                                                         | `git fetch` 并刷新 HUD                                                                                              |
| `/resume-recent`                                                          | 恢复最近 48 小时的会话（`--all` 全量）                                                                              |
| `/secure status`                                                          | 加密会话判定与挂载状态（配置过 `secure` 段才注册）                                                                  |
| `/record`                                                                 | 流量录制：`on` / `off` / `status`（需 `traffic.enabled`，Node ≥22.13；网页端 `on` 需确认）                          |
| `/clear`                                                                  | 开新会话                                                                                                            |

## 配置

用户配置文件：`~/.pi/agent/pi-subagent.json`（沿用历史文件名；缺失或格式错误一律用默认值，不抛错）。

- `/agent settings` 打开交互式编辑器（↑↓ 选择、回车编辑、空格切换布尔、`r` 重置默认，改动即时落盘）；脚本场景用 `/agent settings list` / `set <key> <value>` / `reset <key>`。
- **时间字段通常以整数秒配置**（键名以 `S` 结尾，如 `budget.idleS`）；旧版毫秒键首次加载时自动迁移。例外：下表 `feishuBot.debounceMs` 保持毫秒，不迁移。
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
  "feishuBot": { "enabled": false }, // 飞书机器人；依赖 Web Hub 控制面
  "traffic": { "enabled": false }, // 流量录制（/record；需 Node ≥22.13）
}
```

`web_search` 的供应商凭证在另一处，见 [tools 指南](docs/guide/tools.md#web_search)。

### 飞书机器人设置（可选）

以下为 `pi-subagent.json` 的**顶层** `feishuBot.*`（不是 `webHub.feishuBot`）；改动后 `/reload` → `/webhub restart`，还需 `webHub.enabled:true` 与控制面开启。[配置/命令/安全说明](docs/dev/feishu-bot/README.md) · [真租户验收](docs/dev/feishu-bot/acceptance.md)。**一个应用只连接一个 hub**，双连接会分流事件。

| 键                              | 默认值    | 含义                                                       |
| ------------------------------- | --------- | ---------------------------------------------------------- |
| `feishuBot.enabled`             | `false`   | 总开关，默认仅 owner 可用。                                |
| `feishuBot.allowGroups`         | `true`    | 接收群内 @ 请求。                                          |
| `feishuBot.groupRootTopics`     | `false`   | 群根 @ 时开未绑定话题，随后显式 /use 或 /new。             |
| `feishuBot.notify`              | `"bound"` | bound / off，已绑定会话的主动 done/failed/waiting 提醒。   |
| `feishuBot.spawnScope`          | `"known"` | known 拒绝未知目录；roots 经路径确认；/new 另需 spawn。    |
| `feishuBot.debounceMs`          | `1500`    | 0–10000 **毫秒**；JSON-only，不在 TUI 设置编辑器展示。     |
| `feishuBot.staleMessageS`       | `300`     | 30–3600 秒，拒绝过旧请求。                                 |
| `feishuBot.files.outbound`      | `"auto"`  | auto / buttons / off；仅归属明确的私聊 cwd 图片自动发送。  |
| `feishuBot.files.inbound`       | `true`    | 接收入站图片/文件附件。                                    |
| `feishuBot.files.maxInboundMiB` | `30`      | 解析范围 1–100 MiB，实际仍受共享上传的 30 MiB 上限约束。   |
| `feishuBot.securityAlerts`      | `true`    | LAN 安全告警：新 IP 登录、白名单拒绝、会话下线、2FA 变更。 |

## 加密会话（pi-secure）

把项目连同它的全部会话记录放进一个 gocryptfs 加密目录（保险库）：挂载后正常使用，卸载后磁盘上只剩密文。插件做轻量守护——加密会话写不到库外、普通会话读不到库内。**这是加固，不是「绝不写明文」的承诺**：web-hub / 飞书里的明文副本、swap、终端回滚等残留见[设计文档](docs/dev/data-encryption/plan.md) §5。

### 前提与安装

- Linux（依赖 FUSE）；
- `gocryptfs` ≥ 1.8（Ubuntu 22.04 可直接 `sudo apt install gocryptfs`）、`fusermount3`、`flock`（util-linux 自带）；
- 安装启动器（把仓库内的启动器链接到 `~/.local/bin`，确保该目录在 PATH 里）：

  ```sh
  ln -s <仓库路径>/src/secure/bin/pi-secure ~/.local/bin/pi-secure
  # git 安装的仓库路径通常是 ~/.pi/agent/git/github.com/Newbluecake/pi-toolkit
  ```

  配置过保险库后，会话内 `/secure status` 也会打印这条安装命令（未配置时该命令不注册）。

### 初始化

```sh
pi-secure init acme        # 需要真实终端；会提示输入两次新口令
```

- **master key 只在 init 时由 gocryptfs 在终端打印一次**（64 个十六进制字符），务必当场抄写并离线保存——口令丢失且没有 master key 时数据无法恢复。工具本身不读取、不保存口令与 master key。
- 打印后建议执行 `clear` 和 `tmux clear-history`（尽力清理终端回滚，算不上安全擦除）。
- init 会自动完成首次挂载、创建目录、登记保险库并写好项目 sessionDir，结束时自动卸载。

### 迁移已有项目到 ~/secure/acme

```sh
pi-secure init acme                 # ① 若还没建
pi-secure unlock acme               # ② 输入口令挂载
rsync -a ~/ai/acme/ ~/secure/acme/  # ③ 整个仓库都要搬进去（含 .git）
pi-secure run acme --version        # ④ 冒烟（不带 `--` 分隔；-- 之后的内容会被当成消息）
cd ~/secure/acme                    # ⑤ 确认 git 仓库完整：
git status
git rev-parse --git-common-dir      #    输出应位于 ~/secure/acme 内；库外 common-dir 会被插件警告
# ⑥ 旧会话按需导入（务必用绝对路径）：
pi-secure run acme --fork /home/me/.pi/agent/sessions/旧会话.jsonl
# ⑦ 项目 memory 按 cwd 存放，新路径是空 memory；需要时把
#    ~/.pi/agent/memory/<旧slug>/ 复制到 ~/.local/share/pi-toolkit-secure/acme/mnt/state/memory/<新slug>/
# ⑧ 确认无误后删除原目录和旧备份（SSD / CoW 上删除不等于擦除）
# ⑨ 更新 IDE 工作区、脚本、cron、docker compose 等处的绝对路径
```

### 日常使用

| 命令                           | 作用                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `pi-secure run acme`           | 解锁（提示口令）→ 在项目根启动 pi → pi 退出后自动尽力卸载（10 秒有界收尾；卸不掉会告警并保留挂载） |
| `pi-secure run acme -C sub`    | 从项目的子目录 `sub` 启动（任意目录都可调用，不必先 cd）                                           |
| `pi-secure unlock acme`        | 挂载；已挂载则直接返回。之后在项目根直接 `pi` 也可以（sessionDir 已写进项目设置）                  |
| `pi-secure lock acme [--lazy]` | 有界卸载；`--lazy` 延迟卸载（有占用者时仍可卸）                                                    |
| `pi-secure status [acme]`      | 挂载状态、布局完整性、swap / core 警告、traffic-record 适配                                        |

会话内用 `/secure status` 查看判定、锁定原因、各保险库挂载状态与 traffic-record 适配情况。

### 私有模式（--private）

默认（普通模式）下，解锁后的保险库对**所有同用户进程**可见。`--private` 把明文挂载改进为：只存在于本次 pi 进程树的**私有挂载命名空间**里，其他程序按路径只能看到哨兵占位文件。

```sh
pi-secure init demo --private        # 登记为私有库（此后 run 缺省即私有）
pi-secure run demo --private         # 单次私有运行；--no-private 强制普通模式
pi-secure lock demo --lazy           # 摘除该命名空间里的挂载路径（既有访问可能继续）
pi-secure lock demo --kill           # 结束 --private 会话并收尾
pi-secure unlock demo --global       # 私有库默认拒绝全局解锁，--global 仅解除这条默认
```

- `--private`/`--no-private` 只在紧跟库名的位置识别；缺省取 `secure.vaults.<名字>.private`。
- `run` 结束（或 `lock --kill`）后自动收尾：终止有证明归属的进程、卸载、释放记录与租约，退出码透传 pi。
- web-hub 不会在私有会话内拉起（会被困在命名空间里）；需要网页时在普通终端的 pi 里执行 `/webhub start`。
- 详细的进程链、互斥规则、实例状态与退出码见[设计文档](docs/dev/data-encryption/plan.md) §2.8 与 [private-plan](docs/dev/data-encryption/private-plan.md)；真机验收清单见 [acceptance](docs/dev/data-encryption/acceptance.md) J 节。

安全边界（统一措辞，与 `pi-secure --help` 一致）：

> --private：明文挂载只存在于本次 pi 进程树的私有挂载命名空间里。其他程序按路径访问保险库只会看到占位文件，find/grep/备份工具/其他 agent 的无意识访问都会被挡住。它不能防御同一用户下有意的恶意进程：这类进程可以经 /proc/<pid>/root、/proc/<pid>/cwd 读到明文，或用 setns 加入该命名空间。若需要硬边界，请用独立的系统用户运行 pi-secure。

### 注意事项

- **`--fork` / `--session` / `@file` 一律用绝对路径**：相对路径按 pi 的 cwd（库内）解析。
- **注册新保险库后需重启 pi 进程**：`pi-secure init` 写入的登记在 `/reload` 后不会重新判定。
- 加密会话**不能写保险库外**（write/edit 被拦截，bash 尽力而为）；普通会话**不能读保险库**（read/write/edit/grep/find/ls 与 bash 命令文本被拦截）。
- worktree 隔离在加密会话中被拒绝；飞书通知卡片、跨会话消息（xs）、droid、cron 新建在加密会话中关闭。
- traffic-record 需 **v0.2.1+**（声明遵守 `PI_SECURE_SESSION=1`）：旧版本会把请求正文写进明文 traffic.db，`/secure status` 会警告。
- 运行中保险库被外部卸载 ⇒ 会话转为 LOCKED（输入与工具全部拦截）；重新挂载后重开会话即可。
- 未挂载时 `~/secure/acme` 指向一个普通文件，`cd` 会失败——这是设计使然（哨兵）。
- pi 原生 `/debug` `/export <库外路径>` `/share` `/copy`、绕过 `pi-secure` 直接在子目录里跑 `pi`，这些路径插件拦不到；一律走 `pi-secure run`。完整残留清单见[设计文档](docs/dev/data-encryption/plan.md) §5。

### 故障排除

| 症状                                 | 处理                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lock` 报 busy / EBUSY，列出占用 pid | 有进程的 cwd 还在库内（IDE、shell 等）：退出后重试 `pi-secure lock <name>`；不急的话用 `--lazy` 延迟卸载                                   |
| `status` 显示 stale（ENOTCONN）      | gocryptfs 守护进程异常退出：`pi-secure unlock <name>` 会先清理再重新挂载，或 `pi-secure lock <name>` 清理                                  |
| 退出码 75「卸载未完成」              | 保险库可能仍挂载：稍后 `pi-secure status` 查看，再 `pi-secure lock <name>`；必要时手动 `fusermount3 -uz <dir>/mnt`                         |
| 退出码 77                            | 口令连错 3 次（间隔 1s/2s/4s），重新执行命令                                                                                               |
| 退出码 73                            | 另一个 pi-secure 正在挂载/卸载（mount.lock 被占），稍后重试                                                                                |
| 状态栏 `secure:locked`、输入被拦     | 会话被 LOCKED：保险库未挂载、会话与所属库不一致或跨域打开。按提示重开（如 `pi-secure run acme -C sub`）；LOCKED 不会自动退出，`/quit` 可用 |
| 状态栏 `secure:invalid`              | `pi-subagent.json` 的 `secure` 段无法解析：修复 JSON 后重启 pi                                                                             |

## 流量录制（traffic）

把发往 provider 的请求与响应（含流式 chunk）录进本地 SQLite：`~/.pi/agent/records/traffic.db`，与独立插件 pi-traffic-record 同库同表，历史、改写规则与计数自动沿用。配合 jq 改写规则和一个加固的网页查看 / 重放界面。默认关闭，开启需 Node ≥22.13（`node:sqlite`）；off 时零注册、零 IO。内部设计见 [traffic-merge 方案](docs/dev/traffic-merge/plan.md)，真机验收清单见 [acceptance](docs/dev/traffic-merge/acceptance.md)。

- 命令：`/record on` / `off` / `status`，在主会话注册（包括 print / json 模式），子会话不注册；print / json 模式只录制、不启动网页服务、不能重放；网页端执行 `on` 需要确认。
- 请求归属靠一次性票据头（铸造后在上游 fetch 层剥离，provider 看不到）；改写只作用于能证明归属的请求，无法证明的按原样发送并记 `unattributed`。改写白名单：anthropic-messages / openai-completions / openai-responses（Codex 的 WS 握手绕过 fetch，票据剥不掉，只能录不改写）。
- 库内含 API key 明文（原设计），文件本身不加密——录制默认关，请自行控制本机访问。
- 网页默认只绑 `127.0.0.1`（4177 起，被占用自增）；全部 `/api/*` 要 token（回环也不例外），响应带反嵌入 / no-store 头；会话结束（含 `/reload`）中止在途重放。

### 配置

| 键                      | 默认值      | 含义                                                                         |
| ----------------------- | ----------- | ---------------------------------------------------------------------------- |
| `traffic.enabled`       | `false`     | 总开关；off ⇒ 零注册、零 IO、不加载 `node:sqlite`。                          |
| `traffic.childSessions` | `true`      | 子会话请求是否落库。`false` 只禁止落库，**不**禁止子会话请求被改写规则作用。 |
| `traffic.web.host`      | `127.0.0.1` | 绑定地址；`"0.0.0.0"` 显式开启 LAN（见下方风险）。                           |
| `traffic.web.port`      | `4177`      | 起始端口，被占用自增，最多 20 次。                                           |

以上键均非 live：改完 settings 文件后 `/reload` 生效；库路径固定在 `~/.pi/agent/records/traffic.db`，不随 `PI_CODING_AGENT_DIR`，也无可配置项。

### 数据范围（拍板①）

开启后默认**也录子 agent 流量**：consult fork、`/goal` verifier、workflow 子 agent 的完整 prompt 与输出都会落库，数据量约随子 agent 用量线性增长。toolkit 自身的保活 ping、额度查询、会话标题、topic 判定请求结构上不经过录制钩子，不录也不改写（拍板⑥）。另有两点共存行为：改写规则启用期间，cache 保活 ping 被否决（HUD 显示 `ping off:traffic-rewrite`）、pi 原生 cache warming 被叫停；观测到 warming 决策后改写会暂停（fail closed，`/record status` 可见），`/record off → on` 恢复。

### LAN 风险

`traffic.web.host = "0.0.0.0"` 会把查看 / 重放页面开放给同网段，但走的是**明文 HTTP**：token、请求正文与 API key 都可被同网段嗅探。Host 白名单与 token 校验不替代传输加密；需要跨机访问时建议走 SSH 隧道并保持默认绑定。

### 从独立 pi-traffic-record 迁移

1. 所有运行中的 pi 执行 `/record off`。
2. 升级 pi-toolkit。
3. 从 `~/.pi/agent/settings.json` 的 `packages` 删掉 `"../../ai/pi-traffic-record"`（装过 `~/.pi/agent/extensions/traffic-dump.ts` 的一并删）。
4. `~/.pi/agent/pi-subagent.json` 写 `"traffic": { "enabled": true }`（或用 `/agent settings`）；需要 LAN 再加 `"web": { "host": "0.0.0.0" }`。
5. **重启 pi**（只 `/reload` 不够）。
6. 验证：只有一个 `/record`；`/record status` 计数与迁移前一致（库、规则、引擎设置在 DB 中自动沿用）；网页历史可浏览。
7. 回滚：`traffic.enabled=false` 并把 package 加回去（另一个进程仍在跑旧版时，两者可共享同一个库，schema 不变）。

暂时保留外部包也可以：toolkit 只在「确有活动的外部录制器」时让位——旧版 v0.2.x 实际在跑 ⇒ toolkit 让位并在 session_start 提示从 settings 移除；外部墓碑版 v0.3.0 则反过来对 toolkit 让位。任何加载顺序下活动录制器都恰为 1，不会双写。

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
