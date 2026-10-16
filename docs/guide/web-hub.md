# Web Hub 浏览器控制面

一台机器一个 hub 守护进程，各 pi 会话（TUI 或 rpc）连上它，你在浏览器里统一查看和操作。**默认关闭**（`webHub.enabled: false`）：关闭时零接线、零网络、零磁盘。子 agent 会话不接入。

启用：

```json
{ "webHub": { "enabled": true } }
```

`/reload` 后用 `/webhub open` 打开浏览器。没有 hub 在跑时会话会自动拉起一个（`webHub.autoStart`，默认 `true`），默认监听 `127.0.0.1:7878`（`webHub.port`），空闲 `idleExitMinutes`（10）分钟后退出。多数 `webHub.*` 子键非 live：`/reload` 之后还需 `/webhub restart` 才到达运行中的 hub。

## `/webhub` 命令

| 命令                     | 作用                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `/webhub`（`status`）    | hub 状态、监听地址、UI 构建状态、LAN / 隐私锁摘要           |
| `/webhub open`           | 打开浏览器                                                  |
| `/webhub restart`        | 重启 hub（改了非 live 设置后用）                            |
| `/webhub stop` / `start` | 停止 / 启动；`stop` 之后不会被自动拉起，直到 `start` 或重启 |
| `/webhub token rotate`   | 轮换访问 token                                              |
| `/webhub passwd`         | 设置 LAN 登录密码                                           |
| `/webhub unlock`         | 解除 LAN 登录锁定                                           |

## 查看（P1，只读）

会话列表、详情与转录、子 agent 转录（`webHub.subagentTranscript`，默认 `all`）、编辑器之上的状态：

- **fleet 抽屉**：子 agent 与后台 bash 成组显示，徽标与会话卡片计入运行中的 bash。
- **只读面板**（会话详情头部）：任务（可折叠）、worktree、后台 bash job、cache 保活。
- **额度胶囊**与 **CPU / 负载胶囊**：随屏宽分档收缩，悬停看明细；额度含 droid Standard / Core 池（需 hub 通告 `quota.pools.v1`）；胶囊的数据陈旧会标出。关闭用 `webHub.quota` / `webHub.load`（默认 `true`）。
- **worktree 面板**：会话 cwd 所在仓库的 worktree 列表（只跑本地 git，从不 fetch）。展开后可看**逐文件 diff** 与**提交图**（≤200 个提交，合并提交淡化）；二者随 `webHub.preview` 开关，仅 Linux（需要 `/proc/self/fd`）。

## 控制（P2）

`webHub.control`（默认 `true`）开启写通道：

- 网页发消息、中断、steer；子 agent 操作（`steer_subagent` / `abort_subagent`）。
- **一键清屏按钮**：会话头部的「清空 / Clear」按钮，等同在 TUI 里输入 `/clear`——在同一个 pi 进程里开新会话，无确认框；仅在允许网页斜杠命令的地方显示，agent 忙时排在当前回复之后，页面自动跟到新会话。
- **`ask_user` 双通道竞速**（`webHub.remoteAskUser`，默认 `true`）：TUI 与网页同时显示同一个问题，先答的生效，另一边收到"已关闭"。
- **网页斜杠命令**（`webHub.webCommands`，默认 `true`）：pi-toolkit 自己的命令，输出回显到网页；第三方扩展的命令只在终端处理。`webHub.webCommandPolicy` 是 JSON 覆盖项，可把某条命令设为 `allow` / `confirm` / `deny`。
- **steer 撤回**（`webHub.steerRecall`，默认 `true`）：忙时发出的 steer / 追加消息先暂存，下一次队列清空前可在浏览器里撤回并改写。
- 附件上传（`webHub.uploads`：`on` = 本机 + LAN，`loopback`，`off`；默认 `on`），整页拖放；上传的附件可被同一会话的查看者预览。
- 高低版本 pi-toolkit 接入同一 hub 时自动版本替换，顶栏给升级提醒，不会来回切换。
- 会话切换保活：浏览器保留最近 K 个会话的订阅（本地偏好 `pwh_keepalive`，默认 3，`1` = 旧的单槽行为），切回时保留滚动位置。

## 托管会话（spawn）

`webHub.spawn.enabled`（默认 `false`；仅 Linux，不满足平台探测时失败即关闭）：由 hub 自己在你选定的目录里拉起 `pi --mode rpc` 子进程，网页上就能新建会话。

- 准入范围：已知目录 ∪ `webHub.spawn.roots`；默认只允许本机回环访问（`spawn.lan`：`off` / `known` / `roots`）。限额：`maxProcesses` 4、`maxPerPrincipal` 2、`ratePerMinute` 3、`maxLifetimeMinutes` 720。
- **跨 hub 重启恢复**（`spawn.restore`，默认 `true`）：hub 优雅重启或崩溃后，把可恢复的托管会话在新 hub 下重新拉起（同一 spawnId，`--session` 指向原会话文件）。`/webhub stop` 会留下一次性否决，重启时清除。
- **重新启动离线会话**：点击已离线、属于托管记录的会话卡片，通过同一套恢复流程重新拉起；死亡未被确认时拒绝（409），不会出现两份进程。
- **会话历史**（`spawn.history`，默认 `true`）：浏览 agent 目录下所有历史会话，原地续接或从快照 fork；占用检查是尽力而为，UI 底部披露了已知窗口。
- **删除会话**：两步确认，只删卡片（托管会话先停进程），会话 jsonl 文件永不删除；只有读到进程确实已死才会摘除记录。
- 进程由独立 reaper 看护：hub 无论怎么死，孤儿进程最迟约 12 秒内被回收。
- LAN 下每次 spawn 默认需要二次确认（`spawn.lanConfirm`，默认 `true`）。

## 预览

`webHub.preview`（`"on"` / `"loopback"` / `"off"`，默认 `"on"`）：消息、用户气泡和工具卡片输入里已稳定的**绝对路径**可点开只读预览对话框；文本按块滚动加载（桌面 8 MiB 上限）、图片全屏 + 滚轮缩放、Markdown 默认渲染并可切源码、目录可浏览（单击展开、双击进入）。

- 准入是"上传 + 任意绝对路径"：经认证的用户（LAN 也包括）可读 hub 进程 uid 能读且不在**凭据黑名单**里的任何文件，并浏览目录。这个范围是明确接受的单用户信任模型；黑名单只是尽力而为，不是白名单。
- `"loopback"`：LAN 侧该端点不存在（与 `off` 在 LAN 上字节一致），本机仍可预览。
- 改动非 live：`/reload` 后 `/webhub restart`。

## 局域网访问与密码

`webHub.lan.enabled`（默认 `false`）：用户名 + 密码认证，明文 HTTP 监听 `0.0.0.0:<webHub.lan.port>`（7879）。

- `webHub.lan.extraHosts`：额外允许的 Host；`trustProxyFrom` / `externalOrigins`：前置可信反向代理做 HTTPS 终止时使用（均为逗号分隔字符串）。
- 登录会话存 SQLite，运行在可被 SIGKILL 的子进程里；用 `/webhub passwd` 设置密码、`/webhub unlock` 解锁。
- **安装为 PWA**：UI 带 `manifest.webmanifest`（无 service worker，数据是实时的）。Chrome 的完整独立安装要求安全上下文；纯 HTTP 的局域网地址需要在 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 把该来源加入白名单一次，或者走 HTTPS 反向代理。

## 隐私锁与头像

- **隐私锁**（`webHub.privacy`，默认 `true`）：防肩窥。对单个会话打标记后，每次查看都要重新验证——LAN 需要输入密码，本机回环只能降级为点击确认。仅桌面宽度（≥768px）生效；会在切换路由、闲置超时、手动和标签页隐藏时重新上锁。派生会话继承标记。
- **头像**（`webHub.avatar`，默认 `true`）：上传一张校验过的 PNG 作为头像；`control: false` 或关闭该项则整个功能不接线。

## 设计文档

[arch](../dev/web-hub/arch.md) · [control-plan](../dev/web-hub/control-plan.md) · [lan-plan](../dev/web-hub/lan-plan.md) · [vue-plan](../dev/web-hub/vue-plan.md) · [spawn](../dev/web-hub-spawn/) · [restore](../dev/web-hub-spawn-restore/plan.md) · [session-history](../dev/web-hub-session-history/plan.md) · [preview](../dev/web-hub-preview/) · [worktree-diff](../dev/worktree-diff/plan.md) · [worktree-graph](../dev/worktree-graph/plan.md) · [bash-jobs-panel](../dev/web-hub/bash-jobs-panel-plan.md) · [keepalive 面板](../dev/cache-ttl-keepalive/webhub-plan.md) · [privacy](../dev/web-hub-privacy/plan.md) · [avatar](../dev/web-hub-avatar/plan.md)
