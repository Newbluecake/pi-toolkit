# Feishu F-probe 租户事实记录

状态：**2026-10-18 首轮真实租户运行完成**（用户执行，主会话据脱敏报告填写）。V7（P4 跨连接重投）与 V12 尚未取得观察，见文末放行决定。

## 如何运行

需要 Node **22.22+**（原生 TypeScript 类型剥离），不需要安装探针依赖。也支持 `npx tsx`。
在仓库根目录先注册：

```sh
node scripts/dev/feishu-probe.ts --help
node scripts/dev/feishu-probe.ts --steps P1
```

扫码后凭据保存在 `~/.pi/agent/feishu-probe/credentials.json`，文件 0600、目录 0700，不会打印。
然后复用凭据完成其余步骤：

```sh
node scripts/dev/feishu-probe.ts --reuse --steps P2,P3,P4,P5,P6,P7,P8
# 可以拆开运行，每次重新 bootstrap，不复用 WS URL：
node scripts/dev/feishu-probe.ts --reuse --steps P2,P3
node scripts/dev/feishu-probe.ts --reuse --steps P4 --timeout 300
node scripts/dev/feishu-probe.ts --reuse --steps P5,P6,P7,P8
# 跳过某步：
node scripts/dev/feishu-probe.ts --reuse --skip P1,P4
```

每步开始可输入 `s` 跳过。`--timeout` 是每次交互/收事件的窗口，默认 90 秒，范围 5–600 秒；HTTP 8 秒、WS 握手 10 秒。
P1 轮询遵守服务端 interval（slow_down 加 5 秒），最多 600 秒。Ctrl-C 保存部分报告并退出 130。
返回码：0=完成（可能仍有 unknown/skipped），1=失败，2=参数错误，130=中断。
P4 重投观察建议使用 `--timeout 300` 或更长（上限 600 秒）；默认 90 秒只适合快速冒烟，不能据此判断不重投。

P1 的注册 POST 仍只发往 accounts.feishu.cn / accounts.larksuite.com；二维码是仅供展示的 HTTPS 链接，可为
`https://open.feishu.cn/page/launcher?user_code=…`，仅接受 .feishu.cn / .larksuite.com 子域、无 userinfo、无非 443 端口。
HTTP 400 的 `authorization_pending` / `slow_down` 是正常轮询状态，不代表注册失败；暂时网络错误最多连续重试 4 次并受总到期约束。

**退出 0 不代表所有能力通过，必须检查每个子观察项。**

安全准备：使用测试应用；先停止同应用的其他客户端；先不要手动开启订阅/权限，以便识别默认能力。
所有消息/图片/文件用无敏感测试内容。P6 上传的是探针生成的 16×16 PNG/文本；下载只在内存中计数并丢弃，限制 8 MiB。
P4 会故意不 ACK 并打开两条连接；P8 会用内存中的随机错误 secret 认证两次，可能留下平台失败审计。
探针不执行 pi 命令，不读取工作区文件，不删除应用/测试消息/附件。中断时可能留下测试 Typing 表情，可在飞书端清理。

每次生成 `~/.pi/agent/feishu-probe/report-<timestamp>.json`（0600）。仅保留脱敏观察：

- secret、token、device_code、WS URL/query 不入报告；身份、租户、会话/消息/话题 ID 哈希；消息正文只记长度。
- `steps.P#.status` 为 pass/fail/skipped/unknown；`facts.V#` 含分项观察。pass 表示取得相应观察，不是无限期平台保证。
- `liveAttempted` / `untestedLive` 表示是否实际尝试联网，**不表示步骤已通过**。连接错误/未收事件不能证明能力不存在。
- `droppedObservations` 记录限额丢弃；每步最多 256 条 / 512 KiB，单观察 32 KiB，超限只记大小；不得把缺失证据当成功。
- V3、V5、V7 等有多个子观察，汇总状态不能代替查看分项。权限拒绝代码需连同 `api-result` 一起看。
- 失败 `reason` 区分 unreachable / timeout / http-<status> / api-code-<n> / credential；`check` 标明 file-symlink、file-owner、file-mode、file-size 等具体凭据检查。错误 msg 不保留原文，只抽取已知命名空间和受限语法的 scope（如 im:resource）。
- 原生全局 WebSocket 不暴露失败升级响应的 HTTP body/headers：**握手阶段**的 1000040350 等平台代码只能表现为 `ws-handshake-failed`，无法从此错误还原具体代码；握手超时单列为 timeout。若同一代码在 bootstrap JSON 返回，则仍能准确记录。
- payload_encoding 仅作为观察值：与 pinned SDK 一样始终尝试 UTF-8/JSON；真正解码失败才记录并 ACK/drop。非 event 数据帧（含 legacy card）遵循 pinned SDK：忽略、不 ACK。
- 如开启了控制台开关，应在此模板补记具体路径/名称及前后结果。JSON 中仅记录已知开关枚举，其他输入不保留原文。

不要分享 `credentials.json` 或二维码链接；复查报告后再分享。不同运行间同一 ID 的 SHA-256 前 16 位可用于关联。

## 运行上下文

- 日期 / 飞书品牌：2026-10-18，`feishu`（大陆飞书）；全新 PersonalAgent（P1 扫码注册），控制台未改配置。
- 报告：`report-2026-10-18T04-01-55-723Z.json`（P1 pass）、`report-2026-10-18T04-03-04-478Z.json`（P2–P8；P1/P4 跳过）。
- 全局默认状态保持到首次 P3/P5：是（未手动开启订阅/权限）。
- 未测：P4（V7）跳过；P8 的第二用户子检查跳过（V12）。

## V1 — PersonalAgent bootstrap / 长连接（P2）

- 结论：**pass**。bootstrap HTTP 200 / code 0。
- WS host：`msg-frontier.feishu.cn`（冻结后缀 `.feishu.cn`）。
- ClientConfig：PingInterval 90、ReconnectCount −1（不限次）、ReconnectInterval 90、ReconnectNonce 25；pong 回带同一配置。
- ping 1 / pong 1（P2）；P7 的长连接 6 分钟内 pong 稳定、按 90 s 节奏。

## V2a — 默认 `im.message.receive_v1`（P3）

- 结论：**pass**，默认即订阅，无需控制台开关。owner 私聊收到。
- envelope：`schema:"2.0"`，header `{event_id, token, create_time, event_type, tenant_key, app_id}`；sender `{sender_id{open_id,union_id,user_id:null}, sender_type:"user", tenant_key}`；message `{chat_id, chat_type:"p2p", content, create_time, message_id, message_type, update_time}`。`user_id` 为 null（无通讯录权限），身份一律用 open_id。
- 另观察到 `im.chat.member.bot.added_v1`（机器人被拉进群）也默认投递。

## V2b — 默认 `card.action.trigger`（P5）

- 结论：**pass**，默认投递，无需控制台开关；schema 2.0 `behaviors:[{type:"callback"}]` 按钮回调到达。
- 回调 envelope：header 同上（`event_type:"card.action.trigger"`，`create_time` 16 位 = 微秒）；event `{operator{tenant_key,open_id,union_id}, token, action{value, tag}, host:"im_message", context{open_message_id, open_chat_id}}`；header/operator 的 app_id、tenant_key 一致（§R2-e 一致性检查可行）。
- ACK `{code:200}` 被接受（未见重投）。

## V3 — 默认权限（P6 / P7）

- 结论：**pass**，默认 scope 全够：reaction 增删、图片上传并发送、文件上传并发送、下载用户发来的图片（200 KB）和文件（4.85 MB）、群内 @ 收到 mentions。无 scope 拒绝。

## V4 — 入群 / 话题群（P7）

- 结论：**pass**。机器人可被拉进普通群，@ 消息到达（mentions 含机器人自身 open_id）；话题内消息带 `thread_id`、`root_id`、`parent_id`。

## V5 — schema-2.0 卡片 PATCH（P5）

- 结论：**pass**。卡片 PATCH 在 `update_multi` 为 false 与 true 时**都成功**（响应 `{}`）——单人卡片不必强制 `update_multi`；多人可见卡片仍按计划带上。

## V6 — ACK / payload_encoding（P2 / P3）

- 结论：**pass**。ACK 帧（回显 headers + `biz_rt`，payload `{"code":200}`）被接受，窗口内无重复投递；`payload_encoding` 实测为空串，payload 直接是 UTF-8 JSON。
- 帧 headers 实测还带 `x_frontier_recieved_time`、`x_frontier_arriverate`、`instance_id`、`trace_id`（未知 header 按计划忽略）。

## V7 — 不 ACK 跨连接重投 / 双连接（P4）

- 结论：**未测（P4 跳过）**。需补跑：`node scripts/dev/feishu-probe.ts --reuse --steps P4 --timeout 300`。

## V8 — 普通群 `reply_in_thread`（P7）

- 结论：**pass（据证据人工判定；探针自动标成 fail 是探针缺陷）**。对普通群 @ 消息调用 `/messages/:id/reply` 且 `reply_in_thread:true`：HTTP 200 / code 0，响应**直接返回 `thread_id`**（及 root_id/parent_id）；随后用户在该话题里的 @ 回复携带**同一个** `thread_id`，证明话题已建立且可绑定。
- 探针缺陷：等待「在话题里回复」的提示超时（用户回复晚于 90 s 窗口）抛出的异常被 catch 记成 V8 fail；补救不影响结论（后续 topic-group 阶段收到的正是该话题里的消息）。
- 对计划的影响：`groupRootTopics`（普通群 @ 自动开话题并绑定）可以启用，binding 直接取 reply 响应里的 `thread_id`。

## V9 — `Typing` emoji_type（P6）

- 结论：**pass**，`Typing` 存在，添加 / 移除成功。

## V10 — `create_time` 单位（P3）

- 结论：消息事件 `create_time` 为 **13 位毫秒**（与本地接收时间差约 0.5 s）；卡片回调 header 的 `create_time` 为 **16 位微秒**——stale 规则按位数归一化。

## V11 — 错误凭据（P8）

- 结论：**pass**。错误 secret：bootstrap HTTP 200 + `code 1000040345`；`tenant_access_token` 接口 HTTP 200 + `code 10014`。两者都映射为 `auth_failed`（连同计划已列的 514/10003）。

## V12 — 非创建者可见性（P8）

- 结论：**未测**（第二用户子检查跳过）。只影响「allow 白名单」文档措辞，不阻塞开发。

## 开发放行 / 裁剪决定

- V1–V6、V8–V11 已取得正向观察：§2 协议、§4 身份、§6 卡片/PATCH、§7 文件、§5.2 群话题（含普通群自动开话题）按计划实现。
- **V7 未知**：F3（连接器 / 持久化 ACK 策略）开工前须补跑 P4；在此之前 F0–F2 等不依赖重投语义的包可先行。
- V12 未知：不阻塞；`allow` 文档暂写「其他用户能否看到个人应用以实际为准」。
