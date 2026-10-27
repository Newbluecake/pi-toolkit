# 飞书机器人：从聊天控制本机 pi 会话

> 开发者要点（hub 实现不变式、残留风险、门禁）见文末「开发者要点」两节（自 AGENTS.md 下沉，原文搬运）。

飞书机器人把私聊或群话题接到 **本机 Web Hub 已连接的 pi 会话**：选择会话、发请求、收到带会话标签的最终回复、回答 `ask_user`，以及收发附件。它不是另一个模型服务，也不需要公网 webhook 或额外 SDK 依赖；hub 使用 Node 22 原生 WebSocket 维持长连接。

默认关闭。它与 [`feishuNotify`](../../../src/feishu-notify/) 的被动通知插件是两个功能：后者只发通知卡片，不接收指令；同时开启可能收到重复提醒。机器人只在主会话的 hub 中运行，子 agent 不另建连接。

> **一个飞书应用只连接一个 hub。** V7 实测：两个连接同时在线时，事件会分流，而不是各收到一份；这可能没有 `conn_limit` 报错。不要让另一台机器、探针或其他 SDK 客户端同时使用这套凭据。不同机器需要不同应用。重投延迟实测约 19.7 秒，平台重投上限仍未知，不能把它当即时消息总线。

## 安装与首次连接

1. 使用 Node.js ≥22（需原生 WebSocket），正常安装并启动 pi-toolkit，打开 **本地 TUI**。先确认 `/webhub status` 能看到本机 hub。
2. 在 `~/.pi/agent/pi-toolkit.json`（旧名 `pi-subagent.json`，跟随 `PI_CODING_AGENT_DIR`）合并以下设置，不要覆盖其他已有键：

   ```json
   {
     "webHub": { "enabled": true, "control": true },
     "feishuBot": { "enabled": true }
   }
   ```

   所有 `feishuBot.*` 设置均非 live：修改后先 `/reload`，再 `/webhub restart`。`webHub.control:false` 时机器人不启用。无需为机器人开放 LAN 监听，也无需在这个文件填写 app secret。

3. 在本地 TUI 执行 `/webhub feishu setup`，用飞书扫描持续显示的二维码并确认注册。也可用打印出的 HTTPS 链接完成授权。等待成功，再执行 `/webhub feishu status`，应看到 `status=open`。二维码过期重开 setup；取消用 `/webhub feishu cancel`，**不是 Esc**。
4. 在飞书打开该机器人私聊，发 `/help`，再 `/list`，根据列表发 `/use 1`。编号来自当前发送者最近一次列表，10 分钟内有效；也可用 `/use @别名`（或裸别名）或精确会话名；sessionId 前缀仍可用但不在文案中展示。绑定后发普通文本。
5. 原始请求会带一个由 hub 生成的 `[飞书 · … · #token]` 标头进入 pi；开始处理时原消息加 `Typing` 表情，结束后移除。回复带 `会话名 · sid前6位`，**只在 `agent_settled` 后发最终结果，不逐 token 刷新**。

可选：需要 `/new` 时还须启用 `webHub.spawn.enabled`（Linux，沿用托管会话的平台探测、目录与进程上限）。先在终端或网页打开目标目录，使其进入 known 目录集合；默认 `spawnScope:"known"` 对未知目录直接拒绝。不要只为了消除拒绝而放宽目录范围。

## 飞书内的命令

命令必须位于文本开头第一行；群内还须 **@ 机器人**。这些不是 pi 的任意 slash 命令转发接口。

| 命令                         | 用法与结果                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                      | 短帮助，每个命令一行；未绑定也可使用。                                                                                                                                                                                                                                                          |
| `/list`                      | 列出可用会话，含名称、`@别名`（hub 持有别名才显示，没有就不展示；卡片/按钮/文字列表均不再出现 sid 短码）和状态；不会自动绑定。在线会话（≤8 个）带可点击按钮卡片：点按钮即绑定/切换当前私聊或群话题，卡片可复用；目标离线/失效时整卡关闭并提示重新 `/list`。卡片能力被拒或超额时退回纯文字列表。 |
| `/use <n\|@alias\|name>`     | 显式绑定当前私聊或群话题（别名匹配按 xs 别名规范化：NFKC + 小写；别名优先于名称；sid 前缀为隐藏能力）。匹配不唯一会拒绝。                                                                                                                                                                       |
| `/cur`                       | 显示当前绑定；离线时给出指引。符合 restore 条件的已终止托管会话可出现 Relaunch 按钮，仍受存活身份检查约束。                                                                                                                                                                                     |
| `/new <dir> [first message]` | 创建托管会话并在实际收到其 session 坐标后绑定；路径有空格可双引号包裹。后续行也可作为首条请求。需 spawn 开启。                                                                                                                                                                                  |
| `/unbind`                    | 解除当前私聊/话题绑定；目前回执文本为 `unbound`。不停止或删除 pi 会话。                                                                                                                                                                                                                         |
| `/file <absolute path>`      | 显式发送绑定会话主机上的文件；仍经过权限、绑定、大小与 preview 拒绝链检查。                                                                                                                                                                                                                     |
| （卡片，非命令）定时任务审批 | #61：AI 创建/修改 `schedule` 任务后，owner 的 p2p 绑定收到带完整定义的审批卡片，只有「批准 / 拒绝」两个按钮；不是命令、不能由文本触发，也不经 `admission.dispatch` 的 op 白名单（走 `port.decide → sched_decide`）。详见 `docs/dev/scheduled-reports/README.md`「当场确认」。                   |

未知首行命令（如 `/oops`）只回复“未知命令”加帮助，**不会送给 agent**。需要字面斜杠开头的请求时用 `//text`（转为 `/text`）。`/home/me/file.txt 帮我看看` 是路径类请求，不是未知命令；普通句子或后续行中的 `/` 不触发命令解析。

### 群话题

默认 `allowGroups:true`，但 `groupRootTopics:false`：请在已有话题中 @ 机器人，用 `/use` 或 `/new` 绑定。开启 `groupRootTopics:true` 后，在普通群的根消息中 @ 机器人会创建一个 **未绑定话题**，并提示在该话题中 @ 机器人执行 `/use` 或 `/new`。它不会继承私聊绑定，也不会因为仅有一个会话就替你选择。

每个话题独立绑定，回复只走该话题；原话题/消息失效时不降级到群主聊天发送。群成员能看到话题内的模型输出、路径和已发送文件，请先确认共享范围。

### `ask_user`、图片与文件

- 当前绑定会话出现 `ask_user` 时，机器人会发交互卡片。单问题可点选或按卡片短码发文字（如 `#a1b2c3 1`）；只有一个开放问题时可直接回答。初始卡片就列出题目和编号选项，交互更新失败时保留/更新为可文字作答的卡片，不再只剩“等待作答”占位。多问题只支持卡片表单，卡片不可用时仍列出问题并引导到 web；飞书表单“其他”输入最多 1000 字符。
- 飞书内的会话链接优先使用 `webHub.lan.externalOrigins[0]`，否则使用最近成功登录态请求访问的 LAN Host（仅内存、白名单复核），再退到第一个非回环 LAN Host；无可用 LAN 地址或未开启时退到 loopback。手机链接仍不对时，先从手机成功访问一次 LAN 页面，或正确配置反向代理 origin；未能生成有效链接时显示“web 会话页面”。源码更新后须 `/reload` → `/webhub restart` 才会替换旧 daemon。
- TUI、web、飞书竞争同一 dialog，先成功者生效；迟到的卡片点击不会再次回答或自动重试。**2026-10-20 更新：**在其他端作答、取消或后台关闭，以及权威列表中已消失/过期的问题卡片，机器人会尝试撤回；撤回失败（如权限、超时、超过平台可撤回时限）只回退更新为“已在其他端作答”“已取消”或“对话已过期”，不反复重试。通过本张飞书卡片作答的消息保留“已通过飞书作答”。发送途中结算的卡片在消息 ID 返回后立即撤回；召回尝试先落盘，重启不重复执行（崩溃发生在落盘与实际撤回之间时可能留下原卡片）。重新连接时等待 agent 的权威 dialog 列表；30 秒未取得则显示“状态未知 — 在 web 查看”，不冒充已回答或撤回。
- 入站图片/文件先下载到私有暂存区，再提交到共享 UploadStore，附本机路径进入请求。文件名会清理，长于 16 KiB 的文本转 `.txt` 附件，不静默截断。
- 默认 `files.outbound:"auto"`：仅**私聊、可证明归属的结果、会话 canonical cwd 子树内、识别为图片且 ≤10 MiB**，每次最多自动发 3 张。其他可读候选文件给“发送”按钮（最多 5 个），点击时重新检查；群聊从不自动发图。`buttons` 关闭自动发送但保留按钮，`off` 连同 `/file` 一起关闭出站。
- 出站文件最终仍受 hub uid 可读性、preview denylist、fd 身份检查与 30 MiB 上限限制。它**不是 cwd 白名单沙盒**：显式 `/file` 和按钮可发送 cwd 外的非拒绝文件。只授权你信任的人。

## 设置（源码默认值）

以下键在**顶层 `feishuBot`**，不是 `webHub.feishuBot`。默认值来自 `src/config/settings.ts` 的 `DEFAULT_FEISHU_BOT_SETTINGS`。

| 键                              | 默认值    | 含义                                                                                                                     |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `feishuBot.enabled`             | `false`   | 总开关；还需 `webHub.enabled:true` 与 `webHub.control !== false`。                                                       |
| `feishuBot.allowGroups`         | `true`    | 是否接收群内 @ 请求。                                                                                                    |
| `feishuBot.groupRootTopics`     | `false`   | 普通群 @ 时开未绑定话题；随后显式 `/use` 或 `/new`。                                                                     |
| `feishuBot.notify`              | `"bound"` | `bound` / `off`；对已绑定会话发原生 done/failed 提醒（等待输入只推可在飞书直接作答的问题卡片），不等于关闭请求最终回复。 |
| `feishuBot.spawnScope`          | `"known"` | `known` / `roots`；known 拒绝未知目录。roots 允许 spawn roots 内未知目录，经真实路径确认卡片后创建。                     |
| `feishuBot.debounceMs`          | `1500`    | 合并相同路由与身份上下文的连续请求；0–10000 **毫秒**。JSON-only，不在 TUI 设置编辑器展示。                               |
| `feishuBot.staleMessageS`       | `300`     | 拒绝过旧请求，30–3600 **秒**；重复事件仍走去重。                                                                         |
| `feishuBot.files.outbound`      | `"auto"`  | `auto` / `buttons` / `off`，见上。                                                                                       |
| `feishuBot.files.inbound`       | `true`    | 接收图片/文件附件。                                                                                                      |
| `feishuBot.files.maxInboundMiB` | `30`      | 配置可解析 1–100 MiB，但实际还被文件适配器/UploadStore 限制为 **最多 30 MiB**；调大不能绕过。                            |

已配置（包括 auth_failed/degraded）的机器人使 hub 在没有 agent 时也保持存活；这不是另一个设置项。`/webhub stop` 仍可明确停止整个 hub，`/webhub feishu reset` 删除凭据后不再保活。

## 本地管理命令

管理仅在本地 TUI，不能从飞书、web、LAN 或 headless RPC 管理。

| 命令                             | 说明                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/webhub feishu setup`           | 首次二维码注册；已有凭据不会被悄悄替换。                                                                |
| `/webhub feishu setup --replace` | TUI 确认后注册替换；新注册成功才接管，旧 generation 的 nonce/未决工作失效。                             |
| `/webhub feishu status`          | 状态、重连/丢弃计数、outbox、绑定、能力、保活、脱敏 owner/allow。                                       |
| `/webhub feishu cancel`          | 取消当前注册并清理二维码。                                                                              |
| `/webhub feishu allow <open_id>` | 增加该应用下的 `ou_…` 身份；**不会**使应用变成对全组织可见。                                            |
| `/webhub feishu deny <open_id>`  | 移除授权并撤销该发送者未决工作/nonce；已在 agent 内执行的 shell 效果不保证撤回。                        |
| `/webhub feishu repair`          | 仅用于 state-corrupt；需确认，保留凭据、重建状态、白名单重新以 owner 起步；旧绑定/去重/卡片不再可依赖。 |
| `/webhub feishu reset`           | 需确认，删除凭据和机器人状态/暂存；下次重新 setup。不会删除 pi 会话文件。                               |

## 安全模型与恢复边界

- **定时任务审批卡片（#61，owner-only fail-closed）**：只发 p2p、在线、且 **证明是 owner** 的绑定——`lastRequest(binding).senderOpenId` 必须存在并逐字等于凭据 owner（不复用 `operator()` 的 `?? owner` 回退；无请求记录 / 超过 24 h 元数据保留期 ⇒ 视为未证明、不发卡，该私聊里再发任意一条消息即恢复）；群与话题从不发卡，owner 还须在 allow-list。回调走一次性 nonce（anchor `sched-card` + 按钮 `sched-ok`/`sched-no`，绑定安装代/租户/owner/聊天/消息）→ `admission.callback` → sender 必须等于当前 owner → offer 仍在且 hash 相同 → agent 侧再校验。批准绑定 `defHash`（卡片超 20 KB 只截断 prompt，hash 绑全文）；飞书批准记 `approval.via:"web"`。无法证明的一切（owner、offer 已关闭、任务已删除/已批准）都不推进安全动作：只 PATCH 中性文案或保留卡片。
- 默认仅注册 owner 在 allow-list；陌生人请求不送 agent，owner 可收到限流的授权卡片。卡片只给 owner 决策，授权后也不补跑陌生人的旧请求。使用 **每应用 open_id**，不是无通讯录权限时为 null 的 user_id。
- `allow` 代表授权使用本机 pi（可能执行 shell、读写本机文件），与受信 LAN 用户同等级，**不是只读聊天权限**。V12 非创建者能否看到个人应用尚未实测；以实际租户可见性为准。
- 入站必须匹配 app/tenant；回调 nonce 一次性且绑定安装代、操作者、聊天、消息与 action。hub 命令账本使用私有品牌选择 `fsb:<gen>:<openId>` 命名空间，普通 origin 文本不能伪造。agent 自己的账本仍以 cmdId 为键：受信 LAN 用户刻意复用 bot cmdId 属于已接受的自攻击风险。
- 凭据为 `<stateDir>/feishu-bot/credentials.json`（默认 stateDir 为 `~/.pi/agent/web-hub`），文件 0600、目录 0700，校验 owner/文件类型/符号链接；token 只在内存。**不要分享凭据、完整二维码授权链接、WS endpoint 或状态文件原文**。请求正文与附件在持久状态/上传区内，备份也应按敏感资料处理。
- 先持久化接收记录再 ACK，event_id/message_id 去重 72 小时；不承诺平台的无限重投期限或无限期 exactly-once。处理状态不明时只查询、不自动重派；“重发”按钮是你核实后的显式选择。
- **hub 重启、agent 重连、ev gap、epoch 变化都会破坏结果归属证明**。窗口必须从 token-bearing user anchor 到 settle 连续可见，否则只发“已送达，结果无法确认归属 — 在 web 查看”，绝不从 idle snapshot 猜补正文。已证明且已持久化的最终 outbox 则可继续投递，仍用原 uuid；这不是快照回填。
- `/new` 首条请求必须等实际会话坐标、原子绑定后才送；启动失败/超时会说明。重启不重复 fork、不自动发送存下的首条请求。托管会话自身是否恢复由 `webHub.spawn.restore` 控制，与机器人“重派请求”是两回事。
- 原生 WebSocket 在 1 MiB 检查前已分配整帧，且没有公开 `terminate()`。逻辑停止/非 ACK 保证有界，物理卡死 socket 可留诊断 zombie；达到上限暂停拨号并报 `close-timeout`，并非无限新建连接。
- 出站 uuid 的约 1 小时平台去重窗未实测；未知发送效果超过保守 50 分钟停止重试。重启可能丢失仅在内存中的已发消息/话题坐标；部分投递/卡片状态可能只能在 web 核实。Markdown 会中和标签和危险链接，极长代码片段的最后分段可能不完美；长输出附件失败会明确截断，不应当作完整结果。
- 原生 `done` 提醒要求新鲜、完整的 fleet **和** bash 空闲证据；缺失/截断/仍忙则**抑制而非延后**。failed 不用该空闲门；在飞书无法直接作答的提问不推送；来自飞书的请求不另发重复的原生完成提醒。被动 feishuNotify 可独立发同类通知。

主要限额：allow-list 32、绑定 256、未终结请求 256、去重记录 16384、状态 4 MiB、outbox 512 部分、开放卡片 64；满时拒绝新工作或降级，不静默挤掉安全状态。卡片每部分 ≤20000 UTF-8 JSON 字节、最多 4 部分，超长结果优先 `.md` 文件；终结请求元数据保留 24 小时。单发送者指令 10/3 秒、全局 60/分钟、回调 20/分钟，另共享 HTTP 的 per-agent 限流。附件单文件处理限时 30 秒、暂存总额 100 MiB。

## 故障排查

先看 `/webhub status`（hub、spawn、版本）和 `/webhub feishu status`（机器人）。再看 hub 日志（默认 `~/.pi/agent/web-hub/hub.log`，实际位置以 `/webhub status` 为准）中的 `web-hub feishu:` 与脱敏拒绝代码；不要把凭据或消息正文贴到 issue。

| 状态/现象                                              | 检查与处理                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` / 缺少 `fsb.v1` / “当前 hub 尚不支持”            | 核对顶层 enabled、webHub control；`/reload` → `/webhub restart`；确认运行的是新版 hub，不是旧 daemon。                                                                                                                                        |
| `unconfigured` / `setup`                               | 执行 setup 或完成扫码；过期重开；取消用 cancel。仅 `/webhub feishu` 不带子命令会显示用法，不会开始注册。                                                                                                                                      |
| `connecting` / 重连增加                                | 检查网络、代理、防火墙、飞书服务；不要同时开探针/第二个 hub。                                                                                                                                                                                 |
| `auth_failed`                                          | 凭据被撤销或错误（如 1000040345 / 10014）；确认应用后 `setup --replace`。自动重试至少间隔 10 分钟。                                                                                                                                           |
| `conn_limit`                                           | 同应用连接冲突，先停另一端；自动重试约 5 分钟。没有这个报错也不能排除双连接分流。                                                                                                                                                             |
| `degraded(credentials-unsafe)`                         | 检查文件 owner、0600/目录0700、是否软链/非普通文件；不自动覆盖。确认来源后安全修复权限或 reset 重新注册。                                                                                                                                     |
| `degraded(state-corrupt)`                              | 先留存私有备份；连接器不会启动。TUI repair 会重建状态，或确认 reset；不手改 JSON 绕过校验。                                                                                                                                                   |
| `degraded(persist-failed)`                             | 检查磁盘、目录权限、I/O；持久化恢复后自动恢复接收，失败时不会抢先 ACK。                                                                                                                                                                       |
| `degraded(ws-unavailable/close-timeout)`               | 检查 Node 原生 WebSocket、目标安全校验/网络；卡死连接需停止 hub 后重启。                                                                                                                                                                      |
| `degraded(undecodable-events)`                         | 平台事件格式/编码变化；看 dropped 计数和脱敏日志，保留版本信息上报。                                                                                                                                                                          |
| `capability-denied:cards/reactions/files/cardCallback` | 核对应用权限/事件订阅与租户策略；`caps` 的 `?` 是未证明而非禁止，`✗` 是拒绝。后续成功观察可清除对应降级。                                                                                                                                     |
| 问题卡停在文字卡、没有按钮/表单                        | 看 `dialog-refresh-skipped` 的静态 gate reason、`card-patch-failed` 的 API code/安全 msg，以及 `dialog-text-fallback`。单问题仍可用 `#短码 编号`；多问题到 web。相同原因每分钟最多记录一次（总计最多 20 条/分钟），不记录题目或原始平台回显。 |
| `/use` ambiguous/offline、回复“无法确认归属”           | `/list` + 更长 sid 明确选择；到 web 看实际运行，不凭同正文自行重派。                                                                                                                                                                          |
| `/new` 拒绝                                            | 查 spawn 开关、Linux probe、known/roots、真实路径确认与进程限额；known 下未知目录是设计拒绝。                                                                                                                                                 |
| 已绑定但没提醒/没自动发图                              | 查 notify、完整后台空闲证据、是否飞书发起、图片 canonical cwd/私聊/大小条件；不满足自动条件可有按钮。                                                                                                                                         |

## 可选：飞书自定义机器人菜单

如果当前应用类型/租户控制台支持自定义菜单，可添加 **“发送文本”** 类型的条目：

| 菜单名   | 发送文本  |
| -------- | --------- |
| 会话列表 | `/list`   |
| 当前会话 | `/cur`    |
| 解绑     | `/unbind` |
| 帮助     | `/help`   |

不要选择“打开链接”或假定自定义事件会被机器人解析。带参数的 `/use`、`/new`、`/file` 仍手输；菜单发布、生效延迟和非创建者可见性由飞书控制，须按 [真租户验收](acceptance.md) 实测。此菜单是便利入口，不影响授权与命令校验。

## 验证与设计依据

- [真租户验收清单](acceptance.md)（二维码、真实客户端卡片/表单、V12、网络重连等尚须用户执行）。
- [设计与最终裁定](plan.md)、[V1–V12 探针事实](probe-results.md)、[F10 覆盖与自验报告](F10-report.md)。设计中旧 FB7 “proof-backed snapshot backfill” 已被 §R2-b 禁止，以后者与实现为准。
- 离线集成：`timeout 180 npx vitest run tests/integration/web-hub-feishu-bot.test.ts`。使用真 hub 子进程/组装、真实本地 socket/WS/HTTP/上传与 fake-pi 子进程，不访问飞书或模型服务；不是租户验收通过的证据。

## 开发者要点：Feishu bot

**Feishu bot (feishu-bot plan v2 + §R2/rulings, F0–F10)**: `hub/feishu/*` under
`src/web-hub/` owns the zero-dependency native-fetch/WebSocket pbbp2 long connection, durable
receive-before-ACK, requests/bindings/dialogs/files/outbox and owner-only-by-default admission.
Ask-user cards settled elsewhere are recalled once (durable attempt claim; failure ⇒ neutral Chinese
PATCH); an answer from that Feishu card keeps 「已通过飞书作答」 (`by:"web"` + matching `cmdId`).
Top-level `feishuBot.enabled` requires `webHub.enabled` + control; non-live (`/reload` then
`/webhub restart`). `HubConfig.feishuBot` key absent ⇒ byte-identical legacy hub: no bot
service/network/disk/idle count or `fsb.v1` (shared cap fold on both surfaces). One app ↔ one
hub/active connection — V7 proved two connections SPLIT events. `bot.stop()` is FIRST in every
cleanup path, with bounded stop/dispose before registry/uploads/spawn/HTTP teardown. Local-TUI-only
`/webhub feishu setup|status|cancel|allow|deny|repair|reset` uses `fsb_req`/`fsb_res` on the trusted
agent socket (no web/LAN admin); the hub ledger's private branded `fsb:<gen>:<openId>` namespace
cannot be selected by ordinary origin fields. Reply proof requires token anchor → settle on one
uninterrupted stream; restart/reconnect/gap ⇒ unattributed, never snapshot backfill or automatic
redispatch. Gates: `tests/web-hub/{hub/feishu,hub/hub-feishu.test.ts}` + caps/idle/cleanup tests,
`tests/integration/web-hub-feishu-bot.test.ts` (real child hub + fake Feishu/fake-pi), typecheck/build.
Design/user/tenant gates: `docs/dev/feishu-bot/{plan,README,acceptance,probe-results,F10-report}.md`;
V12 non-creator visibility and real client card/form behavior still need tenant acceptance.

**Schedule approval cards (#61)**: `hub/feishu/schedule-confirm.ts` (pi-free, closure state, injected clock; persistence is the
existing nonce table only — no new state key, D9) + taps in `service.ts`. Port: `FeishuSchedulePort.offers?/closedOffers?/decide?`
(absent ⇒ no confirm controller). Card ownership is judged by `closed(offerId, by)` only — never by reqId. When the offer is
neither open nor closed (agent `/reload` after a decide) the card consults the hub's ledger evidence port
(`HubSchedulePort.ledgerTask(sid, taskId, {since: anchor.createdAt})`): `deleted` ⇒ neutral 「任务已删除」, same-hash `approved` ⇒
「已批准」, anything else (`unknown/stale/degraded`, no port, throwing port) ⇒ keep the card (fail-closed, never recall by guess).
Gates: `tests/web-hub/hub/feishu/schedule-confirm.test.ts`; `tests/integration/web-hub-feishu-bot.test.ts` block
「#61 I2 — owner-only schedule approval cards」; full chain `tests/integration/schedule-confirm.test.ts`. Design:
`docs/dev/scheduled-reports/README.md`「当场确认」.

## 开发者要点：Cross-session mirror

**Cross-session mirror (feishu-xs-mirror plan r3 + §R1–R3, `docs/dev/feishu-xs-mirror/`; packages P1/P2/P3, reports `P*-report.md`)**:
`feishuBot.xsMirror` (default **true**, non-live: `/reload` then `/webhub restart`) pushes a read-only Feishu card to every
bound **p2p** chat (never group/topic bindings, never offline ones) when a cross-session message lands in the bound session
WITHOUT waking it — point-to-point, `message_channel` broadcast, reply (late ones marked), and `unknown{queued}` (marked
「送达未确认」); `woke:true`, `none`, `accept_unverified`, deadline/late/duplicate acks never mirror. **A′ = no wire change**: no
new frame, cap, PROTO bump or agent code — the hub observes its own xs relay (`hub/xs/mirror.ts`, `XsRouterDeps.onQuietDelivered`,
fired on a microtask AFTER the sender's `xs_res`/audit/limits settled; observer errors are swallowed) and `hub.ts` passes the
observer only when `feishuBot.xsMirror === true ∧ config.crossSession` (key absent otherwise ⇒ hub byte-identical; the three off
goldens and `xs-router-v071-diff` stay frozen). Delivery is a bounded FIFO(16) with ONE worker (`hub/feishu/xs-mirror.ts`):
per-card budgets (6/min·60/h per binding, 30 cards/min global, least-recently-served first), mirror outbox slots ≤16 queued /
total <320, ≥256 KiB state headroom, work-lane headroom ⇒ security alerts/owner notices are never starved; overflow becomes a
per-binding 「此前另有 N 条」 tail note (monotone `dropped` + `reported` watermark) and `xs-mirror-<reason>` counters in
`info().counters.dropped`. Cards are schema-2.0, zero buttons/behaviors/nonces, untrusted-input banner, sender-claimed names
marked 「对方自报，未核验」 (only hub-stamped alias is 「hub 核验」), body quoted + markdown-neutralized, 1500 code points,
≤8 KiB. Mirror notices carry `requestId:"xsm:<hash>"`; **turning the switch off + `/webhub restart` purges stranded queued
`xsm:` notices at `start()` (counted `xs-mirror-purged`)**. Residuals R1–R9 (plan §6): old-agent-spawned hub ⇒ off; whitelisted
links stay clickable; deny'd users' bindings still receive (as done-notices do); queued messages may never reach context and
queued replies can't be marked late; best-effort (lost/late ack ⇒ permanent miss, no resend of the xs message); budget/outbox
expiry drops with a tail note; no post-settle dedupe; alias only when receiver `aliasUsable`; `/reload` alone doesn't clear
stranded notices. Gates: `tests/web-hub/hub/feishu/{xs-mirror,xs-mirror-isolation}.test.ts`, `tests/web-hub/hub/xs-mirror-tap.test.ts`,
`tests/integration/web-hub-feishu-bot.test.ts` (「feishu-xs-mirror」 block, I1–I16, real hub child × fake Feishu × fake xs
agents; every no-card case is compared with the same input under `xsMirror:false`). Real-device checklist:
`docs/dev/feishu-xs-mirror/acceptance.md`.
