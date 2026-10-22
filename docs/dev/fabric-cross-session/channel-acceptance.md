# 频道 + 收信箱 真机验收清单（CH6）

> 规格：`channel-plan.md`。自动化门禁覆盖协议与行为；本清单只验自动化覆盖不到的真实终端 / 浏览器体验。
> 约定：**A / B / C / D** 是四个独立的 pi 主会话（四个终端），**cwd 各不相同**（便于从卡片区分）。每步写「操作 → 预期」，不符即记录并停止。

## 0. 前置（只做一次）

1. `~/.pi/agent/pi-subagent.json` 至少包含（频道默认开启，无需单独配置）：
   ```json
   {
     "webHub": { "enabled": true },
     "fabric": { "enabled": true, "crossSession": { "enabled": true } }
   }
   ```
   `autoJoin` 保持默认 false（验证人工加入）。
2. **四个会话都执行 `/reload`**，然后在任意一个里执行 `/webhub restart`（设置均为非 live；hub 需要用新的 caps 重启）。
3. `/webhub status` 应显示 hub 在线；浏览器打开 `/webhub open` 给出的地址，侧栏应出现 A–D 四张卡片。
4. 每个会话执行 `/fabric status`：应看到 `not joined`（或 left），以及 `channels #default (…)`、`hub-cap on` 的频道行。若 `hub-cap off`，说明 hub 没有重启成功，回到第 2 步。

## 1. join / leave / `#default` 隔离（TUI）

| #   | 操作                                                                           | 预期                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | A、B、C 执行 `/fabric join`（无参数）                                          | 回显加入 `#default`；`/fabric status` 为 joined，频道行 `channels #default (1/4)`；web 卡片 **不显示频道 chip**（只在 default 时不显示）                   |
| 1.2 | A 的模型调用 `list_sessions`（或让它「列出其他会话」）                         | 看到 B、C（不含 D：D 未加入，不含自己）；行里不带 `channels`（default-only）                                                                               |
| 1.3 | A、B 执行 `/fabric join #team`                                                 | 回显含 `#default` 与 `#team`，并带一句「想隔离请 `leave #default`」提示；status 频道行 `#default #team (2/4)`；web 上 A、B 卡片出现 `#team` chip（C 没有） |
| 1.4 | A、B 执行 `/fabric leave #default`                                             | 回显有效集合只剩 `#team`；`/fabric status` 频道行 `channels #team (1/4)`                                                                                   |
| 1.5 | A 的模型 `list_sessions`                                                       | 只看到 B（C 不可见）；行带 `channels:["team"]`；`list_sessions{channel:"team"}` 同样只有 B；`list_sessions{channel:"nope"}` ⇒ 被拒（`bad_channel`）        |
| 1.6 | C 的模型 `list_sessions`                                                       | 看不到 A、B（C 只在 default，A、B 已离开 default）                                                                                                         |
| 1.7 | A 的模型对 C 的 ref / 完整 sessionId 调 `message_session`；反向 C→A 也试一次   | 双向都 **no_target**，且文案与「会话不存在」不可区分（不泄露 C 存在）                                                                                      |
| 1.8 | A 的模型对 B 调 `message_session`（不带 wake）                                 | `effect:"applied"`；B 的 TUI 显示 `xs ← …` 消息；B 页脚出现 `inbox 1`                                                                                      |
| 1.9 | D 执行 `/fabric join #a b`（含非法名，如 `#Bad name`、`#default2` 之外的大写） | 非法名被拒并给出规则；`/fabric join #a #b #c #d #e` 超过 4 个 ⇒ 拒绝 `too_many`；不会部分加入                                                              |

## 2. `/fabric channels` 与 `/agent status`

| #   | 操作                               | 预期                                                                                                                                                            |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | A 执行 `/fabric channels`          | 本地行：偏好 / 有效 / 挂起集合；hub 行：每个频道 **只有名字和人数**（`#default n`、`#team n`），无成员明细                                                      |
| 2.2 | A 输入 `/fabric join #` 后按 Tab   | 补全候选来自本地缓存（本地偏好 ∪ 目录行频道 ∪ 上一次 `channels` 结果），不卡顿                                                                                  |
| 2.3 | A 执行 `/agent status`             | 在 `xs joined · recv …` 行之后有一行 `xs channels #team (1/4)`；**C**（只在 default）执行 `/agent status` 则 **没有** `xs channels` 行（default-only 字节不变） |
| 2.4 | A 的收信箱有未读时 `/agent status` | 该行末尾追加 ` · inbox N`                                                                                                                                       |

## 3. 广播 `message_channel`

先让 A、B、C、D 都加入 `#team`（`/fabric join #team`；C 此前在 default，现在是 `#default #team`；D 同理）。把 D 设为 `/fabric receive deliver`，C 设为 `/fabric receive wake`，B 保持 `wake`。

| #    | 操作                                                                           | 预期                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | A 的模型 `message_channel{channel:"team", text:"hello"}`（不带 wake）          | 回执 `fanout 3/3`、`effect:"applied"`；A 自己 **没有**收到（不回环）；B/C/D 都收到只投递消息，TUI 头部形如 `xs ← <from> · <cwd> · #team broadcast`，**不起新 run**；各自页脚 `inbox 1`   |
| 3.2  | 查看 B 的模型可见文本（`/tree` 或会话转录）                                    | 首行形如 `[fabric xs from=… wake=false channel="#team" kind="broadcast"]`，后附宿主说明「这是频道广播；若需回应请用 message_session 发给 from.ref，不要用 message_channel 回应全频道。」 |
| 3.3  | A 的模型 `message_channel{channel:"default", …}`                               | 被拒 `default_channel`（`#default` 禁广播）                                                                                                                                              |
| 3.4  | A 立刻再发一条广播                                                             | 被拒 `rate_broadcast_interval`（间隔 < 60s，不消耗额度）                                                                                                                                 |
| 3.5  | 等 60s 后 A 带 `wake:true` 再发（A 的会话是人发起的 level 0，收件人 3 人 ≤ 4） | `fanout 3/3`；B、C 被唤醒起 run（`woke:true`）；D 是 deliver 模式 ⇒ 该行降级为 `receiver_policy`（仍投递）；`wakeDowngraded` 为空（整体唤醒条件满足）                                    |
| 3.6  | 等 60s，A 再发 `wake:true`（第 2 次/小时）                                     | 仍可唤醒（上限 2 次/小时）                                                                                                                                                               |
| 3.7  | 再等 60s，A 第 3 次 `wake:true`                                                | 整体 **降级为只投递**，`wakeDowngraded:"broadcast_wake_rate"`；消息仍送达                                                                                                                |
| 3.8  | 让 E（第 5 个会话）也加入 `#team`，A 再带 `wake:true`（此时收件人 > 4）        | `wakeDowngraded:"broadcast_wake_fanout"`，仍投递（也可在等额度窗口后验证）                                                                                                               |
| 3.9  | B 被广播唤醒后，B 的模型自己 `message_channel{wake:true}`                      | `wakeDowngraded:"level_limit"`（被唤醒的 run level ≥ 1，不能再发起带唤醒的广播）；B 回应请用 `message_session` 发给 A 的 ref                                                             |
| 3.10 | A 把自己的 `/fabric receive replies` 后，B 广播给 `#team`                      | A **收不到**（replies 模式对未请求的流量拒收，广播也不例外）                                                                                                                             |

## 4. @会话 的频道范围

| #   | 操作                                                                  | 预期                                                              |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 4.1 | 先把 A 设成只在 `#team`、C 设成只在 default、B 在 `#team`。A 输入 `@` | 补全只列出 `#team` 内的会话（B），不列 C                          |
| 4.2 | A 输入 `@session:<C 的 ref> hi` 并发送                                | 不命中（不在共享频道）：按普通文本处理 / 提示无此会话；C 不会收到 |
| 4.3 | A 输入 `@<B 的名字> hi`                                               | 命中 B 并投递                                                     |

## 5. web 界面

在浏览器中（桌面宽度 ≥ 768px 与手机宽度各看一遍）：

| #   | 操作                                                                                            | 预期                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 5.1 | 看侧栏卡片                                                                                      | 非 default-only 的会话卡片有频道 chip；default-only 的没有                                               |
| 5.2 | 侧栏出现频道筛选 chip 行（仅当存在命名频道）；点 `#team`                                        | 列表只显示 `#team` 成员；再点取消恢复；**刷新页面后筛选不保留**（仅内存态）                              |
| 5.3 | 进 A 的详情页，头部点「频道」按钮                                                               | 弹窗列出 hub 上现有频道与人数；A 已加入的打勾；`#default` 的离开项附说明「离开后不再与默认频道会话互通」 |
| 5.4 | 在弹窗里勾选一个未加入的频道                                                                    | 发出 `/fabric join #x`；**不做乐观更新**：命令回显出现后，随 status 更新才打勾，卡片 chip 随后更新       |
| 5.5 | 在弹窗里取消勾选 / 在底部输入框新建频道（输入大写或空格）                                       | 取消 ⇒ `/fabric leave #x`；非法名被前端预校验拦住；已满 4 个时其余项禁用并提示                           |
| 5.6 | 设置 `webCommandPolicy.fabric` 为 `deny` 后再试 5.4（改设置后需 `/reload` + `/webhub restart`） | 命令被策略拒绝，弹窗显示失败信息，状态不变；恢复为 allow 后再继续                                        |
| 5.7 | 触发一次广播（3.1），在 B 的详情页转录里查看                                                    | 显示 `#team · 广播`（而不是普通 xs 消息）；正文不能伪造头部（正文里写 `kind="broadcast"` 不会改变渲染）  |
| 5.8 | 在 web composer 输入 `@`                                                                        | 面板只列同频道会话                                                                                       |

## 6. 收信箱（inbox）计数与清零

| #   | 操作                                                             | 预期                                                                                          |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 6.1 | B idle 时让 A 发 deliver 消息（`message_session`），再发一条广播 | B 页脚 `inbox 2`；web 上 B 的卡片与详情头部显示角标 `2`；`/fabric status` 有 `inbox unread 2` |
| 6.2 | 在 B 里人工输入一句话，等该轮模型回合完成                        | `inbox` 页脚消失（清零）；web 角标消失；`/agent status` 的 `· inbox N` 消失                   |
| 6.3 | B 正在运行一轮长回合期间，A 发来消息                             | 当前轮完成时 **不清零**（消息写出晚于该轮开始）；下一轮完成时清零                             |
| 6.4 | B 有未读时执行 `/reload`                                         | 计数保留                                                                                      |
| 6.5 | B 有未读时 `/new`，再 `/resume` 回原会话                         | 新会话从 0 开始；切回原会话后恢复原计数                                                       |
| 6.6 | B 有未读时退出 pi 并重启                                         | 归零（已知残留：重启后少计，转录中仍可见）                                                    |
| 6.7 | 超过 99 条（可用脚本循环发，或接受跳过）                         | 显示 `99+`                                                                                    |

## 7. 旧 hub 兼容（失败关闭）

1. 用上一个发行版的 hub（或把 hub 保持在旧版本进程里不重启）而 agent 已升级：A、B 为命名频道专属会话。
2. `/fabric status`：`hub-cap off` 且 `link -`（或 `link #default`…）并提示 `hub-cap off: … /webhub restart`；
3. A 的模型 `list_sessions` / `message_session`：命名频道专属会话 **不可用**（视为未加入，失败关闭），工具文本提示 `/webhub restart`；default-only 会话行为与升级前完全一致；
4. `/webhub restart` 后恢复。

## 8. `channels.enabled=false` 挂起

1. 在 A（已在 `#team`）里：把设置改为 `fabric.crossSession.channels.enabled=false`，`/reload` + `/webhub restart`。
2. `/fabric status`：`not joined`，频道行 `suspended #team (channels.enabled=false)`；`/agent status` 有 `xs channels - (0/4) · suspended #team`。
3. B 的 `list_sessions` 看不到 A；A 的工具表里 **没有** `message_channel`，`list_sessions` 是旧形态（无 `channel` 参数）。
4. 会话 entry 未被改写：恢复 `channels.enabled=true`，`/reload` + `/webhub restart` 后 A 回到 `#team`（无需重新 join）。
5. 若设置为 `fabric.crossSession.channels.autoJoin` 全部非法值：status 提示 `autoJoin: every configured channel is invalid — nothing auto-joined`。

## 9. 回归快检

- 全部会话 `/fabric leave` 后，`list_sessions` 报未加入；`/fabric join` 回 `#default` 与升级前一致。
- fork 一个会话：新会话 **不继承** 频道成员关系、收信箱计数为 0。
- hub 重启（`/webhub restart`）：成员 slot 带频道重放，卡片 chip 恢复。

## 签收

| 项                 | 结果 | 备注 |
| ------------------ | ---- | ---- |
| §1 join/leave/隔离 |      |      |
| §2 channels/status |      |      |
| §3 广播与唤醒门槛  |      |      |
| §4 @ 范围          |      |      |
| §5 web             |      |      |
| §6 收信箱          |      |      |
| §7 旧 hub          |      |      |
| §8 挂起            |      |      |
| §9 回归            |      |      |
