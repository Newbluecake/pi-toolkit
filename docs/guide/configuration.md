# 集中配置指南（新环境）

新机器 / 新用户从零装好并配好 pi-toolkit 的单一入口。本文只给**入口级**信息：安装前置、配置文件位置、开关总表、凭证放哪、改动何时生效；各模块的完整键与默认值在对应的模块指南里（本文一律给链接），默认值如有出入以代码为准。

## 前置要求与最小安装

| 前置                    | 说明                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node.js ≥ 22            | `package.json` `engines` 钉死；用了 `fs.globSync`，更低版本不可用                                                       |
| Node.js ≥ 22.13（按需） | 使用 `node:sqlite` 的功能需要：流量录制（`traffic.enabled`）与 Web Hub 的数据库功能（LAN 登录会话等）；基础安装只需 ≥22 |
| pi 已安装并可运行       | 即 `@earendil-works/pi-coding-agent` CLI                                                                                |
| Linux（可选功能）       | `webHub.spawn` 托管会话、pi-secure 加密会话仅 Linux；bash 自动转后台仅 POSIX，win32 保留内置                            |

安装（git 方式，推荐；pi 经 jiti 直接加载 TypeScript 源码，**无需构建、无需 npm install**）：

```sh
pi install git:github.com/Newbluecake/pi-toolkit
# 更新：
pi update --extension git:github.com/Newbluecake/pi-toolkit
```

或从 [GitHub Releases](https://github.com/Newbluecake/pi-toolkit/releases) 下载总 zip，解压后在解压目录执行（本地路径方式，不参与 `pi update`）：

```sh
cd pi-toolkit
npm install --omit=dev
pi install .
```

装完即可启动 pi：默认配置就是安全配置，可以先不写任何设置文件（见下文「配置示例」）。

## 配置文件：pi-toolkit.json

用户配置文件是 `<agentDir>/pi-toolkit.json`；`<agentDir>` 默认 `~/.pi/agent`，跟随环境变量 `PI_CODING_AGENT_DIR`。**文件缺失或格式错误一律用默认值，不抛错**——一份 `{}` 与不存在等价。

- **时间字段以整数秒配置**：键名以 `S` 结尾（如 `budget.idleS`、`bashJobs.autoBackgroundS`）；旧版毫秒键（`*Ms`）首次加载时自动迁移并回写。例外 `feishuBot.debounceMs` 与通知的 `feishuNotify.subagentFlushDebounceMs` / `subagentDeliveryGraceMs` 保持毫秒，不迁移；通知的旧 `*Sec` 字段直接用秒。
- 飞书通知已融合进顶层 `feishuNotify`，旧 `~/.pi/agent/feishu-notify.json` 保留为回退，不自动改动/删除。web_search 凭证文件等仍独立（见下文）。

### PI_CODING_AGENT_DIR 与继承

设了 `PI_CODING_AGENT_DIR` 但该目录下**没有** `pi-toolkit.json` 时，读写都回落到 `~/.pi/agent`（`/agent settings` 标题与 `list` 输出会标注 `inherited from ~/.pi/agent`）。想隔离：在 `$PI_CODING_AGENT_DIR` 下放一个 `pi-toolkit.json`（哪怕是 `{}`），之后即切到该目录——不做自动复制。**相对路径的变量值一律被忽略**（回落默认目录并告警一次）。

跟随 agentDir 的还有 `traffic.db`（同继承规则）与 bash-jobs、quota-state、cache-ttl 测量数据；memory、workflows journal、Web Hub 状态、`feishu-notify.json` 等不跟随。完整表格见 [README「PI_CODING_AGENT_DIR 与本插件」](../../README.md#pi_coding_agent_dir-与本插件)。

### 旧 pi-subagent.json：迁移与冲突

升级后主会话自动迁移：旧名内容发布为 `pi-toolkit.json`，旧名保留为指向它的**兼容符号链接**（旧版插件、pi-secure 经链接照常读写）。

- **请编辑 `pi-toolkit.json`**。`sed -i` 或编辑器原子保存会把符号链接改回普通文件，造成两份并存且分叉：此时以 `pi-toolkit.json` 为准并给出可见告警——把改动合并进 `pi-toolkit.json`，再删除或改名 `pi-subagent.json`（两份的 `secure` 段不一致时 secure 域 fail-closed）。
- 没有 `flock` 的主机（常见 macOS）**不自动迁移**：继续读写旧名，功能完整。
- 回滚到旧布局：退出所有 pi 后 `mv ~/.pi/agent/pi-toolkit.json ~/.pi/agent/pi-subagent.json`。

## 查看与修改：/agent settings

| 命令                                | 作用                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `/agent settings`                   | 交互式编辑器：↑↓ 选择、回车编辑、空格切换布尔、`r` 重置默认，改动即时落盘 |
| `/agent settings list`              | 列出全部键与当前值（脚本可用；显示设置文件路径与来源标注）                |
| `/agent settings set <key> <value>` | 写入一个键（脚本可用）                                                    |
| `/agent settings reset <key>`       | 恢复默认并移除文件覆盖（脚本可用）                                        |

大多数设置**非 live**：改完需要 `/reload` 才生效（例外见「生效矩阵」）。推荐 `/agent settings`；`/agent budget` 仍是 budget 键的兼容快捷别名。

## 顶层模块开关与默认值

默认值以当前代码（各模块 `settings.ts`）为准，下表已逐一核对。高级键不必在此穷举——点对应指南看完整清单。

### 默认开启

| 模块             | 键                         | 默认   | 一句话                                                                                                                                 | 详文                                                  |
| ---------------- | -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| HUD footer       | `hud.enabled`              | `true` | 接管底部 footer：git、费用、上下文、额度 / 负载                                                                                        | [tools](tools.md#hud-footer)                          |
| web_search/fetch | `webSearch.enabled`        | `true` | 五供应商 failover 联网搜索（凭证另配，见下文）                                                                                         | [tools](tools.md#web_search--web_fetch)               |
| 任务工具         | `todo.enabled`             | `true` | `TaskCreate` 等五工具 + widget + `/tasklist`                                                                                           | [tools](tools.md#任务工具todo)                        |
| ask_user         | `askUser.enabled`          | `true` | 结构化交互提问（仅主会话）                                                                                                             | [tools](tools.md#ask_user)                            |
| 飞书通知         | `feishuNotify.enabled`     | `true` | `@notify`、`/watch` 被动卡片                                                                                                           | [tools](tools.md#飞书通知)                            |
| 会话导航         | `sessionNav.enabled`       | `true` | `/resume-recent`、`/clear`、裸 `exit`                                                                                                  | [tools](tools.md#会话导航)                            |
| topic-switch     | `topicSwitch.enabled`      | `true` | 无关新请求建议开新会话                                                                                                                 | [tools](tools.md#topic-switch)                        |
| 自动标题         | `title.enabled`            | `true` | 小模型生成会话标题                                                                                                                     | [tools](tools.md#自动标题)                            |
| 延迟 `/reload`   | `reload.defer`             | `true` | 有 subagent 在跑时延后 reload                                                                                                          | [tools](tools.md#延迟-reload)                         |
| 项目记忆         | `memory.enabled`           | `true` | cwd 键控被动记忆 + `memory` 工具 + `/mem`                                                                                              | [memory](memory.md)                                   |
| 记忆 Jev 分类器  | `memory.jev.enabled`       | `true` | 召回 / 打标 / 整理的小分类器；须 `enabled` + tiered 布局 + v2 工具面 + 非 secure 域 + classifiers 非空，且宿主提供分类器 API（见详文） | [memory](memory.md#jev自动分类器)                     |
| 日期注入         | `date.enabled`             | `true` | `[date]` 首轮 / 跨日 / 长闲置注入                                                                                                      | [context](context.md#date-日期注入)                   |
| 上下文交接       | `compact.switchTool`       | `true` | `switch_context` 模型自写交接                                                                                                          | [context](context.md#switch_context--compact_context) |
| 用量提示         | `compact.enabled`          | `true` | 阶梯用量行 + 提示线 / 强制线                                                                                                           | [context](context.md#用量提示compact-hint)            |
| cache 保活       | `cacheTtl.keepalive`       | `true` | 缓存到期前 ping 续命（`mode` 默认 `auto`）                                                                                             | [context](context.md#cache-ttl-与保活)                |
| 超时宽限         | `extend.enabled`           | `true` | 到点先进宽限，可 `extend_subagent_timeout` 延长                                                                                        | [subagents](subagents.md#工具)                        |
| bash 自动转后台  | `bashJobs.autoBackgroundS` | `290`  | 超阈值转后台不杀进程；`0` = 关闭（仅 POSIX）                                                                                           | [bash](bash.md)                                       |
| 额度感知         | `quota.enabled`            | `true` | 订阅额度阶梯预警 + 派发闸门                                                                                                            | [quota-load](quota-load.md#额度感知quota)             |
| 负载感知         | `load.enabled`             | `true` | 本机繁忙暂缓新派发                                                                                                                     | [quota-load](quota-load.md#负载感知派单load)          |

> 注：`compact.switchTool` 不在 `/agent settings` 的设置面（`SETTING_SPECS`）里，只能直接编辑 `pi-toolkit.json`（改完 `/reload`）。

### 默认关闭

| 模块             | 键                             | 默认    | 一句话                                     | 详文                                         |
| ---------------- | ------------------------------ | ------- | ------------------------------------------ | -------------------------------------------- |
| SubagentWorkflow | `workflow.enabled`             | `false` | 沙箱化 JS 编排（`agent()` / `parallel()`） | [subagents](subagents.md#subagentworkflow)   |
| Message fabric   | `fabric.enabled`               | `false` | subagent 间 `message_agent`                | [subagents](subagents.md#message-fabric)     |
| worktree 隔离    | `worktree.enabled`             | `false` | `Agent` 的 `isolation: "worktree"`         | [subagents](subagents.md#工具)               |
| 外部 droid agent | `externalAgents.droid.enabled` | `false` | `droid/<model>` 虚拟 provider              | [subagents](subagents.md#外部-droid-agent)   |
| Web Hub          | `webHub.enabled`               | `false` | 浏览器控制面（关 = 零接线零网络零磁盘）    | [web-hub](web-hub.md)                        |
| 飞书机器人       | `feishuBot.enabled`            | `false` | 飞书 bot（依赖 Web Hub 控制面）            | [README](../../README.md#飞书机器人设置可选) |
| 流量录制         | `traffic.enabled`              | `false` | `/record` 录进 SQLite（需 Node ≥22.13）    | [README](../../README.md#流量录制traffic)    |
| 定时任务         | `schedule.enabled`             | `false` | `/schedule` + `schedule` 工具              | [README](../../README.md#定时任务schedule)   |
| hub 托管会话     | `webHub.spawn.enabled`         | `false` | hub 拉起 `pi --mode rpc`（仅 Linux）       | [web-hub](web-hub.md#托管会话spawn)          |
| 本机端口代理     | `webHub.proxy.enabled`         | `false` | 浏览器打开 hub 机器上的 HTTP 服务          | [web-hub](web-hub.md#本机端口代理)           |
| LAN 访问         | `webHub.lan.enabled`           | `false` | `0.0.0.0` 密码认证（默认 7879）            | [web-hub](web-hub.md#局域网访问与密码)       |

## 飞书 webhook 通知配置

`pi-toolkit.json` 顶层 `feishuNotify` 支持旧独立文件全部十二个字段（另含统一专属 `enabled`）。
逐字段优先：**统一有效值 → 旧 `feishu-notify.json` → `FEISHU_WEBHOOK_URL` /
`FEISHU_WEBHOOK_SECRET`（仅凭据）→ 内置默认**。省略/null/错误类型继续回退，false/0 不回退；
空 URL 停止发送，空 secret 关闭签名。旧文件不会被本包迁移或删除。
`FEISHU_NOTIFY_CONFIG_PATH` 只覆盖旧文件回退路径（空串禁用旧文件读取），不取代统一文件或环境回退。
secure/locked 强制关闭且不尝试旧文件/环境重新开启。

凭据 `webhookUrl` / `secret` 只在手工 JSON 中配置，**不进入普通 TUI/list/补全/set 明文面**；
本地 JSON 仍为明文，建议权限 `0600`。改动后 `/reload`，无需重启 hub。
全部字段/默认值、空值和路径语义见 [完整通知配置指南](../dev/ask-user-feishu-merge/feishu-notify.md#配置与优先级70)。

## web_search / web_fetch 凭证

凭证**不放** `pi-toolkit.json`：放进程环境变量，或专用凭证文件 `~/.config/pi/web-search.env`（建议 `chmod 600`）。该文件**刻意保留旧名、不随改名、也不与设置文件合并**——凭证与配置分离，路径可用环境变量 `PI_WEB_SEARCH_ENV_FILE` 覆盖。文件格式是 `KEY=value` 行（支持 `export ` 前缀、`#` 注释、成对引号）。

可用 key 名（**至少配一家**；failover 自动顺序 codex → serpapi → deepseek → bocha → tavily，只派凭证齐全的供应商，codex 需 API key 与 BASE_URL 成对，见下表）：

| Key                    | 供应商   | 说明                                                                                                                                                        |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEX_SEARCH_API_KEY` | codex    | Codex 参与搜索须与 `CODEX_SEARCH_BASE_URL` **同时**配置（缺任一即跳过 codex）；可选 `CODEX_SEARCH_MODEL`（缺省 `gpt-5.6-sol`）、`CODEX_SEARCH_TLS_INSECURE` |
| `SERPAPI_API_KEY`      | serpapi  |                                                                                                                                                             |
| `DEEPSEEK_API_KEY`     | deepseek | `web_fetch` 首选线路                                                                                                                                        |
| `BOCHA_API_KEY`        | bocha    |                                                                                                                                                             |
| `TAVILY_API_KEY`       | tavily   | `web_fetch` 的 fallback 线路                                                                                                                                |

示例（占位符，不要写真实 key 进文档或仓库）：

```sh
chmod 600 ~/.config/pi/web-search.env
cat >> ~/.config/pi/web-search.env <<'EOF'
SERPAPI_API_KEY=your-key-here
DEEPSEEK_API_KEY=your-key-here
EOF
```

一家都没有时 `web_search` 报无可用供应商。`web_fetch` 是独立的 DeepSeek → Tavily failover：优先 DeepSeek，DeepSeek 无 key 或失败时回退 Tavily，`DEEPSEEK_API_KEY` / `TAVILY_API_KEY` **任配其一即可用**，两者皆无才报错（不发请求）。

## 改动何时生效（生效矩阵）

| 改动对象                                                                                                             | 生效方式                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| pi 侧绝大多数设置（模块开关、budget 之外的键；activate 时快照）                                                      | `/reload`                                                                                                                       |
| 少数 live 键：`budget.*`、`concurrencyLimit`、`agent.queueWhenFull`、`resultMaxChars`，经 `/agent settings set` 修改 | 立即生效（budget 对新 run 生效；手改文件仍需 `/reload`）                                                                        |
| hub 服务端设置（`webHub.*`、`feishuBot.*`）                                                                          | **先 `/reload` 再 `/webhub restart`**（顺序不可反：hub 配置由拉起它的 pi 进程传入，未 reload 的旧 pi 可能抢先拉起旧配置的 hub） |
| 网页 UI 代码（开发者改 `src/web-hub/ui` 后 `npm run build:web`）                                                     | 构建完成即生效，**无需** `/webhub restart`；PWA 偶尔需彻底划掉重开                                                              |

模块指南里标注「非 live」的键都落在第一、三行；不确定时一律 `/reload`（+ 涉及 hub 再 restart），多 reload 无害。

## 配置示例

最小示例——**全部省略即安全默认**，空对象就够：

```json
{}
```

按需开启 Web Hub / 定时任务 / 流量录制（各自生效方式见上一节）：

```json
{
  "webHub": { "enabled": true },
  "schedule": { "enabled": true },
  "traffic": { "enabled": true }
}
```

- `webHub` 打开后 `/reload`，再 `/webhub open`（无 hub 在跑时自动拉起，默认 `127.0.0.1:7878`）。
- `schedule` 打开后有 `/schedule` 命令与 AI 的 `schedule` 工具；用户或 AI 创建、修改任务写入后立即生效，无独立 schedule 审批流程。
- `traffic` 需 Node ≥22.13；库默认 `~/.pi/agent/records/traffic.db`，**库里含 API key 明文**，请自行控制本机访问。
- web_search 凭证仍独立，droid 用 `FACTORY_API_KEY` 环境变量或 droid CLI 登录；飞书 webhook URL/secret 可放统一 `feishuNotify`，但只能手工编辑 JSON，不进入普通设置 UI；也可继续用环境变量。含凭据文件建议 0600。

## 安装后验证清单

1. `node -v` ≥ 22（要用 traffic 或 Web Hub 的 LAN / 数据库功能则 ≥22.13）。
2. 启动 pi：启动横幅后**没有** `[pi-subagent] settings …` 告警行（有迁移 / 冲突 / 相对路径告警时按提示处理）。
3. 底部出现 HUD footer（`hud.enabled` 默认开）；`/agent status` 正常返回。
4. `/agent settings list` 首行显示设置文件路径；非默认来源会标注 `inherited from ~/.pi/agent` 或 `PI_CODING_AGENT_DIR`。
5. 派一个后台 subagent 冒烟：`/task 报告当前目录的 git 状态`，应立即返回并收到完成通知。
6. 配过凭证：让模型 `web_search` 一次确认链路；`web_fetch` 需 `DEEPSEEK_API_KEY` 或 `TAVILY_API_KEY` 任一。
7. 开了 Web Hub：`/webhub status` 显示监听地址，`/webhub open` 打开浏览器。

## 常见坑

- **编辑了旧文件名**：`sed -i` / 编辑器把 `pi-subagent.json` 兼容链接改成普通文件 ⇒ 两份分叉，以 `pi-toolkit.json` 为准并告警。合并改动后删掉旧名。macOS 无 `flock` 不自动迁移，读写都走旧名属正常。
- **`PI_CODING_AGENT_DIR` 是相对路径**：被忽略，回落 `~/.pi/agent` 并告警一次；必须用绝对路径。
- **继承不符合预期**：设了变量但目录下没有设置文件 ⇒ 实际在读写 `~/.pi/agent` 的那份（是特性不是坑，放一个 `{}` 即可隔离）。
- **缺 API key**：`web_search` 一家 key 都没有 ⇒ 报无可用供应商；`web_fetch` 需 `DEEPSEEK_API_KEY` 与 `TAVILY_API_KEY` 至少其一，两者皆无直接报错。凭证文件权限建议 0600。
- **secure 域强制关闭**：加密会话（pi-secure）里 fabric 跨会话 / thread、droid、feishuNotify、traffic、schedule、memory.jev 被强制关闭，**任何设置路径都开不回来**；`secure` 段两份文件不一致时 fail-closed（`secure:invalid`）。
- **默认关闭的模块没有命令面**：`/schedule`、`/record`、`/webhub` 在对应开关打开前不存在，不是坏了。
- **只 `/reload` 没restart hub**：`webHub.*` / `feishuBot.*` 改动到不了运行中的 hub——`/reload` 之后还要 `/webhub restart`。
- **平台限制**：win32 不覆盖 bash（内置原样）；`webHub.spawn` 仅 Linux；pi-secure 仅 Linux + gocryptfs。
