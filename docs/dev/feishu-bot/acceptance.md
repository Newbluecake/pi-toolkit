# 飞书机器人：真实租户验收

这是一份**待用户执行**的清单，不是已通过的验收记录。离线 F10 测试使用真 hub 子进程与假飞书服务，只证明本机组装/协议行为；二维码注册、真实飞书 UI、权限/可见性和网络恢复需要在租户中验证。

依据：[plan.md](plan.md) 的 v2、review dispositions、§R2 与末尾裁定；[probe-results.md](probe-results.md) 的 V1–V12；[用户指南](README.md)。**§R2-b 已禁止从 snapshot 补回结果**，不要按旧 FB7 文句期待“重启后快照回填”。

## 准备与取证

- [ ] 使用测试应用、测试群、无秘密的临时 git 项目。项目中准备一张小 PNG、一个小 `.txt`、一个 cwd 外的测试文件；不要拿真实密钥、私人照片或生产数据测试。
- [ ] Node.js ≥22、当前 pi-toolkit；本地 TUI 与浏览器均可用。记录版本/commit、Node 版本、飞书客户端版本、日期、租户类型（无需写 tenant key）。
- [ ] 确认**同一应用没有其他 hub、探针、SDK 或旧机器在连**。V7 已证明双连接会分流事件；即使状态仍为 `open`，也可能漏到另一端。一个应用 ↔ 一个 hub。
- [ ] 保留另一个本地 TUI 用于 `/webhub feishu status`、取消 setup、停止 hub；测试期间不要并行运行 probe。
- [ ] 开启设置并完成重载：

  ```json
  {
    "webHub": { "enabled": true, "control": true },
    "feishuBot": { "enabled": true }
  }
  ```

  修改的是 `~/.pi/agent/pi-subagent.json` 中的**顶层** `feishuBot`。合并而非覆盖。运行 `/reload` → `/webhub restart`；`/webhub status` 检查实际 hub 版本/地址，`/webhub feishu status` 取得机器人状态。

通用故障观察点（下表简称）：

- **B**：本地 `/webhub feishu status`，看 status/reasons、`counters`、`outbox`、`bindings`、`caps`、`keepalive`；`?` 是能力尚未观察，不代表失败。
- **H**：`/webhub status` 与 hub 的脱敏日志（默认 `~/.pi/agent/web-hub/hub.log`，以实际配置为准）；查 `web-hub feishu:`、拒绝码/平台 code，不贴日志中未经检查的其他内容。
- **A**：目标 pi 的 TUI/web 实际会话、用户输入、工具调用、dialog 与任务/后台 bash 状态。
- **F**：飞书当前私聊/话题、原消息表情、卡片与租户应用的权限/可用范围/菜单配置。

每项填写：`通过 / 失败 / 不适用（原因）`、时间、观察到的结果及必要的脱敏截图。不要保存 app secret、token、device_code、完整二维码授权 URL、WS endpoint、凭据或 state.json 原文。

## 检查表

| ID     | 操作                                                                                                                                      | 预期结果                                                                                                                                                                                                                                              | 失败时先看                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| SET1   | 本地 TUI 执行 `/webhub feishu setup`，扫码并确认；也测试 URL 打开方式。                                                                   | 二维码持续可见，成功后清理；B 从 setup/connecting 到 open。凭据不出现在回复或日志中。botInfo/实际应用名称与机器人身份一致。                                                                                                                           | B/H 的错误码；F 应用注册页。仅 `/webhub feishu` 会给用法，需带 `setup`。                                    |
| SET2   | 再开 setup，使用 `/webhub feishu cancel`；单独测试等待 QR 过期。已有凭据时无 replace 再 setup。                                           | cancel/expired 有明确结果，旧 poll 不会晚写凭据；已有安装要求 `setup --replace` 和 TUI 确认。不要求 Esc 取消。                                                                                                                                        | B、TUI 提示、H；勿反复扫码制造多个实例。                                                                    |
| FB1    | 机器人私聊 `/help` → `/list` → `/use 1`；发一条要求简短延迟后返回 `FB1_OK` 的安全请求。                                                   | A 收到带 `[飞书 · … · #token]` 标头的唯一请求；原消息出现 Typing，结束后消失；F 收到一次最终结果，带会话名/sid 短码，不逐 token 刷屏。                                                                                                                | B 的 reactions/cards 能力与 outbox；A 是否真正 settle；F 权限。若运行太快看不清，使用可控短等待重试。       |
| FB2    | 同时打开两个命名会话；`/list`、`/use <编号>`、`/cur`，再用较长 sid 前缀切换。试一次有歧义的名称/前缀。                                    | 列表/当前标签一致；只往显式选中的会话送。歧义拒绝，不猜一个；列表编号过期提示重新 list。                                                                                                                                                              | B bindings 的 offline/amb；A sessionId，不按 cwd 猜。                                                       |
| CMD1   | 未绑定时 `/help`、`/oops`；绑定后发普通句子中的 `/foo`、`//literal`、绝对路径类请求。                                                     | help 每命令一行；unknown 提示加帮助，A 无输入。正常句子不误作命令，`//literal` 成为 `/literal`，路径类请求正常转发。                                                                                                                                  | A 输入；F 原文是否含首行斜杠、空格或 @ 的客户端变化；H dropped。                                            |
| CMD2   | `/unbind` 后 `/cur`，再发普通请求，最后重新 `/use`。                                                                                      | 解绑回执目前为 `unbound`；未绑定不派发，不停止原会话；重新绑定恢复。                                                                                                                                                                                  | B bindings、A 无新增输入。                                                                                  |
| FB3    | 设置 `allowGroups:true`；在同一群的两个已有话题分别 @ 机器人 `/use <不同sid>`，再发不同标记请求。                                         | 每个话题只去自己的会话；回复带请求者 mention 和正确会话标签，留在原话题，不跨话题/落到群根。                                                                                                                                                          | F 是否真的在话题且有 @；B 的绑定数；A 两边输入。                                                            |
| GRP1   | 设置 `groupRootTopics:true`，`/reload` → `/webhub restart`；普通群根消息 @ 机器人。进入新话题 @ 机器人 `/use` 或 `/new` 再发请求。        | 首次只创建**未绑定话题**并提示选择会话；不继承私聊、不随便挑唯一会话。显式绑定后才运行，随后回复仍在该话题。关闭该设置后群根只提示去话题。                                                                                                            | F 话题与 thread_id 行为（V8）；B bindings；A 初次不应有请求。                                               |
| FB4    | 在绑定会话触发单问题 `ask_user`，点击飞书选项；再触发一次，由 web/TUI 与飞书近同时作答。试迟点旧卡片与重复点击。                          | 答案准确回到同一 dialog；每轮仅一个答案胜出。失败方显示已关闭/E_DIALOG_CLOSED，不二次运行或自动重试。                                                                                                                                                 | A dialog 状态；B cardCallback/cards；F 卡片是否已 PATCH。                                                   |
| ASK2   | 测单题短码文字回答、Other、skip/cancel（若问题允许）；再测多问题表单、单/多选。断开/恢复 agent 后看旧卡片。                               | 单题选项/Other 精确（超出选项范围的数字在允许 Other 时作文字）；多题仅卡片，文字提示去卡片/web。30 秒无权威列表时“状态未知”，不假称已回答。                                                                                                           | A 题目约束；F 表单校验/按钮；B capability-denied、H。真实 schema-2.0 多题表单渲染不由 fake 测试证明。       |
| FB5    | 私聊先发图片，再发小文件（含非 ASCII/有空格文件名）；让 agent 读内容，不执行附件。                                                        | A 收到共享 UploadStore 的附件块和本机路径，字节/图片内容正确，文件名安全；F 下载成功。                                                                                                                                                                | B files；A 附件块；H 上传/暂存错误；F `im:resource` 等权限。                                                |
| FILE1  | 发超过配置上限的测试文件；单独测试 `files.inbound:false`，改设置后重启。                                                                  | 明确附件失败/不可用，不把半文件当成功；不静默截断。上限还受共享 UploadStore 的 30 MiB 限制。                                                                                                                                                          | B/H 的限额与文件能力；A 不应看到损坏成功附件。                                                              |
| FB6    | 让 agent 在 cwd 内产出 PNG，并在结果中给绝对路径；同时引用 `.txt` 与 cwd 外测试图片。                                                     | 私聊内 cwd 图片可自动发送（每回复最多3张）；其他只给发送按钮，点击后才上传。群话题不自动发图。文件字节可下载核对。                                                                                                                                    | A 结果归属/路径；B files/outbox；H preview 拒绝链；F 上传/发送权限。                                        |
| FILE2  | 私聊 `/file <测试文件绝对路径>`；再用 `files.outbound:"buttons"` 与 `"off"` 各重启测试。                                                  | 显式文件可发送但仍受安全检查；buttons 无自动图；off 连 `/file` 都明确关闭。危险/拒绝路径不泄露内容，不使用真实秘密做正向测试。                                                                                                                        | B/H；实际 canonical cwd、文件大小、denylist，不能只凭后缀判断图片。                                         |
| NOT1   | 默认 notify=bound；在已绑定会话从 TUI/web 发一个安全任务，等主会话、fleet 与后台 bash 全结束。再分别触发一个受控失败与等待用户的 dialog。 | 原生 `done`/`failed` 带会话标签到已绑定目标；ask_user 只出可作答的问题卡片，无额外 `waiting` 文字提醒（2026-10-19 裁决）。done 需 ≤10秒的新鲜完整 fleet+bash 证据，未知/截断/仍忙时抑制而非延后；failed 不用该门。飞书请求最终回复不再叠加原生 done。 | A 的后台与实际状态；B notify 配置；缺 bash/fleet 证据本身不是错误。若 feishuNotify 同开，辨认两种通知来源。 |
| NOT2   | notify 改 off 后重启，重复原生任务与飞书请求。                                                                                            | 不再有原生 bound 提醒；飞书请求最终回复、ask_user 仍正常。                                                                                                                                                                                            | B/H；不要把 off 当成全局禁发。                                                                              |
| FB7    | 飞书发起可控长请求，确认 A 已收到后 `/webhub restart`；任务可以在 A 完成。再 `/cur` 与重新 `/use` 核实绑定。                              | 不自动重跑请求，不用 snapshot 补正文；可能发“已送达，结果无法确认归属 — 在 web 查看”。只有断线前已证明并持久化的 final outbox 可续发。查看 web 后由用户决定是否显式重发。                                                                             | A 的实际输入次数/结果；B outbox、bindings；H 重启时序。通知链接为 loopback，不保证手机直达主机。            |
| FB8    | 受控断开 hub 到飞书的网络后恢复，不开第二客户端；观察同一消息是否重投。                                                                   | 新连接恢复；同 event/message 不产生第二条 agent 输入/最终回复。B reconnects/dup 可增加；没有观察到重投只能记“未观察”，不能判 dedup 通过。                                                                                                             | B/H 与 A 输入。V7 重投上限未知，离线太久可能被 stale 拒绝。不要故意在生产阻断 ACK。                         |
| FB9    | 开启 spawn，用 `/new <known测试目录> [安全首条请求]`；另试 known 下未知目录。可选 roots + 受控 roots 目录确认卡片。                       | 真正 fork 后收到 sessionId 才绑定/派首条；首条带 token。known 未知目录直接拒绝；roots 的未知目录需真实路径确认。重复事件/重启不重复 fork 或补送未决首条。                                                                                             | `/webhub status` spawn、A 新会话；H spawn stderr/拒绝码、B。检查 Linux probe、目录 known 集合、进程限额。   |
| FB10   | `feishuBot.enabled:false`，`/reload` → `/webhub restart`；使用原来的 web 会话/提示/预览功能。不要删除凭据作为测试前提。                   | 无 bot 连接/请求、无 fsb.v1 能力，原 hub 功能不受影响；已有凭据只保留磁盘，不表示仍连接。重新开启后可恢复。                                                                                                                                           | H 版本/设置快照；F 不应再收到机器人回复；原生 web 行为。                                                    |
| AUTH1  | 未在 allow-list 的第二用户发请求；owner 收到批准卡片后批准，再由第二用户发新请求；随后 TUI deny。                                         | 旧陌生请求不派发/不补跑；只有 owner 可批准。批准后新请求才允许，deny 后新请求拒绝且未决授权/nonce 撤销。不能保证撤回已执行 shell。                                                                                                                    | B allow 脱敏列表、H dropped、A 输入次数；权限与可见性见 V12。                                               |
| V12    | 让**非应用创建者**通过实际租户入口找机器人、私聊、加测试群，并在 allow 前/后分别试 `/help` 或安全请求。                                   | 分别记录“能否看到/能否发消息”和“bot 是否授权”两个事实。allow 不能改变飞书应用可用范围；看不到应用不是 allow 校验失败。当前 V12 仍待实测。                                                                                                             | F 应用类型/发布/可用范围、租户策略；B allow。不得把创建者自己的成功当 V12 通过。                            |
| MENU   | 可选：在飞书应用控制台设“发送文本”菜单 `/list`、`/cur`、`/help`、`/unbind` 并发布。                                                       | 点击等同发送文本，仍走当前聊天绑定与授权；不依赖自定义事件或网页链接。                                                                                                                                                                                | F 菜单类型/发布与客户端缓存；A 不应把菜单未知事件当请求。                                                   |
| RENDER | 安全测试长 Markdown、代码围栏、中文/emoji、标签样式的字面文本、长结果。可在测试话题删除回复源消息后观察发送失败。                         | 代码/分段/序号可读，模型文字不能制造全员 @；长文有完整 `.md` 或明确截断/不完整标记。话题消失不回退群主聊天。                                                                                                                                          | F 真实渲染；B outbox last code；H。target-gone 的平台码与 uuid 去重窗仍须租户观察，别强行记为已证。         |
| SW1    | ≥2 会话私聊 `/list`，含中文/emoji/超长名；点 A、再点 B、再点回 A。                                                                        | label 不乱码/溢出（≤36 码点，sid6/状态不截断）；每次点击后 ≤3 s 卡面刷新、`/cur` 一致、请求只送当前会话；卡片可复用不关闭。                                                                                                                           | F、B outbox                                                                                                 |
| SW2    | 观察点击后客户端表现（ACK 无卡片响应）；让某会话离线后点其按钮。                                                                          | **可接受**：短暂提示且按钮仍可再点、效果正确；已授权点击离线目标 ⇒ 整卡关闭并提示重新 `/list`，非发起人点击无效且不关卡。**不可接受**：持续错误态/重复回调/卡片点不动 ⇒ 卡片能力不随版发布（`sendList` 退回文本），另立 card-response-in-ACK 议题。   | F、B、A                                                                                                     |
| SW3    | 群两话题各 `/list`；非发起人点击；未绑定话题首次点击。                                                                                    | 非发起人无效且卡不关；话题各自独立绑定；未绑定话题首次点击即绑定该话题，绝不回落私聊指针。                                                                                                                                                            | F thread、B bindings                                                                                        |
| SW4    | 9+ 在线 / 21+ 行 / 41+ 行；cards 被拒时 `/list`。                                                                                         | 前 8 个在线会话有按钮，其余文字可见并可 `/use <sid6>`；>40 行有尾行「另有 M 个未显示」；cards 被拒时回纯文本列表（`/use n` 照常）。                                                                                                                   | B caps                                                                                                      |
| SW5    | 卡片点击与 TUI/web 切换、`/list` 重发近同时；hub 重启后点旧卡（含只剩一个按钮的卡）；卡片放置超过 24 h。                                  | 无陈旧绑定；旧卡被取代（旧 nonce 全消）；重启后旧卡仍可点（锚点存活即开卡）；过期卡不再可点且名额回收。                                                                                                                                               | A、B                                                                                                        |
| LIFE   | 保持已配置机器人且关闭所有 agent，观察超过 hub idleExitMinutes；然后 `/webhub stop`。可选确认后 reset 再观察空闲退出。                    | 配置加载时（包括 auth_failed/degraded）保活；显式 stop 仍能退出。reset 删除凭据/状态、不再 bot 保活，需重新 setup，不删除 pi 会话。                                                                                                                   | B keepalive、H；reset 是破坏性测试，先确认可接受。                                                          |

## 恢复/安全边界的判定

- 归属不明、发送效果未知、部分已投递应有诚实提示或可见状态，**不以“最终收到过文字”替代正确性**。
- 实测两个连接会分流；这里不要求再启动第二连接制造干扰。不同机器使用不同应用。平台不会替本机保证单应用单 hub。
- 允许的飞书用户拥有与本机 pi 控制相当的能力，可能读写文件或执行命令；群成员能读话题输出。preview denylist 是 best-effort 黑名单，不是任意文件不泄漏的证明。
- 原生 WebSocket 物理 close 卡死时没有公开 terminate；逻辑 fence 与 shutdown deadline 有界，socket zombie 的物理关闭不作保证。观察 `close-timeout` 时停止 hub、确认旧进程退出后再启。
- 出站 unknown-effect 重试受保守 uuid 安全窗约束；平台约 1 小时 dedup 未做 live 证明。restart 可能丢失只存内存的已发卡片/话题坐标。不能由 fake 的无重复发送推导跨天 exactly-once。

## 验收记录模板

```text
Date / toolkit commit / Node / Feishu client:
Tenant: mainland Feishu | Lark (no tenant key)
App use: single hub confirmed [ ]
SET1–SET2:
FB1–FB10:
CMD1–CMD2 / GRP1 / ASK2 / FILE1–FILE2 / NOT1–NOT2:
AUTH1 / V12 / MENU / RENDER / LIFE:
Skipped + reason:
Failures + sanitized codes / screenshots:
Remaining release/rollout decision:
```

二维码/权限/真实 card rendering 与多题表单、真实 TUI/web/飞书三方 race、真实资源上传下载、V12、菜单及平台网络重投/目标消失码属于**真租户门**；本清单未执行前一律不得写成“全功能真机通过”。离线覆盖明细见 [F10-report.md](F10-report.md)。
