# Feishu F-probe 租户事实记录（待真人运行）

状态：**未进行真实租户测试，V1–V12 全部待填**。这是结果模板，不是已通过的验收报告。

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

- 日期 / 飞书品牌 / 租户：待填（勿贴租户标识原文）
- App / 客户端版本：待填（勿贴 app_secret）
- 报告文件名（可多个）：待填
- 是否全新 PersonalAgent、控制台是否改过配置：待填
- 全局默认状态是否保持到首次 P3/P5：待填
- 未测试 / 跳过 / 超时的项：待填

## V1 — PersonalAgent bootstrap / 长连接（P2）

- 结论：待填
- bootstrap HTTP / API code：待填
- WS host（**不贴 URL/query**）及需冻结的后缀：待填
- ClientConfig（PingInterval / ReconnectCount / ReconnectInterval / ReconnectNonce）：待填
- ping / pong 计数、pong 配置：待填

## V2a — 默认 `im.message.receive_v1`（P3）

- 结论：待填
- 是否默认配置、是否收到 owner 私聊：待填
- envelope 字段与 schema：待填（仅字段名/脱敏报告）
- 若需控制台开关，具体开关及重测报告：待填

## V2b — 默认 `card.action.trigger`（P5）

- 结论：待填
- 默认状态下回调是否到达 / operator/context/app/tenant 是否一致：待填
- 回调 ACK 是否发送、客户端结果：待填
- 若需控制台开关，路径/名称（如 事件与回调→回调配置→card.action.trigger）及修改前后结果：待填

## V3 — 默认权限（P6 / P7）

- Typing reaction 添加 / 删除，HTTP/API code：待填
- 图片上传 / 发送：待填
- 文件上传 / 发送：待填
- 用户图片资源下载 / 字节数：待填
- 用户文件资源下载 / 字节数：待填
- 群 @ 消息及 mentions：待填
- 失败 reason / 提取的缺失 scopes：待填
- 额外授予的权限名称 / 是否发布新版本：待填

## V4 — 入群 / 话题群（P7）

- 普通群可添加机器人、@ 消息可达：待填
- 话题群可添加机器人、话题内 @ 消息可达：待填
- thread_id 是否存在（仅哈希）：待填

## V5 — schema-2.0 卡片 PATCH（P5）

- 无 `config.update_multi`：发送 / PATCH HTTP/API code / 客户端更新效果：待填
- `config.update_multi:true`：发送 / PATCH HTTP/API code / 客户端更新效果：待填
- 结论（是否必需 update_multi）：待填

## V6 — ACK / payload_encoding（P2 / P3）

- 接收到的 payload_encoding / payload_type：待填
- ACK 是否发送，回显 SeqID / LogID / service / method / headers / 6/7/9 + biz_rt：待填
- ACK payload `{"code":200}` 的服务端/客户端接受证据：待填
- 观察窗口及是否重复：待填
- 注意：WebSocket.send 成功不等于服务端确认，有限窗口无重投不能证明 ACK 被永久接受。

## V7 — 不 ACK 跨连接重投 / 双连接（P4）

- 初始事件 ACK=false、关闭后重新 bootstrap 建立新连接：待填
- 是否收到相同 event/message ID 的重投、延迟：待填
- 观察窗口 / 未能确认的 horizon：待填
- 双连接 A/B 分别收到多少条、是否同消息重复：待填
- 是否另有客户端干扰 / 连接数限制：待填
- 结论与对 §2.4/§5.4/§5.8 的影响：待填（负面或不确定结果不得直接放行 F3）

## V8 — 普通群 `reply_in_thread`（P7）

- HTTP/API code：待填
- 是否创建新话题（客户端观察）：待填
- 响应 thread_id、关联话题内后续消息 thread_id（仅哈希）：待填
- `groupRootTopics` 是否可启用：待填

## V9 — `Typing` emoji_type（P6）

- 添加 / 删除 API code：待填
- 是否存在、客户端可见效果：待填

## V10 — `create_time` 单位（P3）

- 原始数值 / 接收时刻毫秒：待填
- 推断 seconds / milliseconds / microseconds / unknown：待填
- 推断是否与客户端发送时刻相符：待填（脚本只在距接收时刻一天内推断，不盲猜）

## V11 — 错误凭据（P8）

- bootstrap HTTP / API code：待填
- tenant_access_token HTTP / API code：待填
- 与 §2.1 514 / 403 / 1000040350 / 1 / 1000040343 的映射区别：待填
- 正确凭据文件是否保持未变：待填

## V12 — 非创建者可见性（P8）

- 第二位用户能否搜索 / 打开应用：待填
- 是否收到第二位用户私聊（非 owner、app/tenant 一致）：待填
- 是否改过可见范围 / 权限 / 是否同租户：待填
- 对 allow 文档的影响：待填

## 开发放行 / 裁剪决定

- V# 依赖仍未验证的包：待填
- 需要修改计划后才能继续的项：待填
- 由用户确认的裁剪及原因：待填
