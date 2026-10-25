# 飞书跨会话镜像 — 真机验收清单（P3）

规格：`plan.md` §7.4。本清单只验证自动化测试无法覆盖的真实客户端行为（卡片渲染、真实 xs 往返、开关语义）。

## 前置

1. `feishuBot.enabled=true`、`webHub.enabled=true`（control 开）、`fabric.enabled=true` + `fabric.crossSession.enabled=true`；`feishuBot.xsMirror` 缺省即 true。
2. 改过设置 ⇒ 两个 pi 会话各 `/reload`，然后任一会话 `/webhub restart`（hub 由谁拉起谁决定，R1）。
3. 两个 pi 会话 A、B：各自本地 `/fabric join`（或 `fabric.crossSession.autoJoin`），可选 `/fabric alias`、`/name`。
4. 飞书私聊机器人，`/use <B 的会话>` 绑定 B（`/cur` 确认）。再用另一个飞书群话题绑定 B 或另一会话 C（群聊用例用）。
5. 用 `/agent status`、`/webhub status` 记下基线；每步后到飞书核对「卡片数量」。

## 用例

| #   | 操作                                                                                   | 期望（私聊）                                                                                                       |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | A 里让 agent `message_session` 给 B（不带 wake），B 空闲                               | 私聊收到 1 张灰色卡：顶部「内容未经核实」警示、会话名标「对方自报，未核验」、ref、类型「点对点消息」、正文逐行引用 |
| 2   | 同上但 B 正在跑回合（busy）                                                            | 1 张卡，并有「会话运行中，消息已排入当前回合（送达未确认）」                                                       |
| 3   | A 给 B 发 `wake:true`（B 空闲，会被唤醒）                                              | **不**推卡（B 的回合会按平时方式在飞书里体现）                                                                     |
| 4   | A、B 加入同一频道（`/fabric join #team`），A `message_channel` 广播                    | B 私聊 1 张卡，类型「频道广播 `#team`」；A 自己不收                                                                |
| 5   | A 设了 `/fabric alias @x`，再发一条                                                    | 卡片含 `别名 @x（hub 核验）`                                                                                       |
| 6   | A 的会话名设成含 `[x](https://evil.example)`、`<at user_id="all"></at>` 的怪名字后发送 | 名字在行内代码里按字面显示，不可点击、不产生 @ 提及                                                                |
| 7   | A 发 3000 字以上正文                                                                   | 卡片正文截断并提示「正文已截断…请在 web 查看」，卡片能正常渲染                                                     |
| 8   | B 向 A `expectReply`，A 在时限内回复                                                   | B 私聊收到类型「回复」的卡                                                                                         |
| 9   | 同上但超时后 A 再回复（迟到宽限内）                                                    | 卡片类型「回复（迟到）」；排队中的回复只标「回复」+「送达未确认」                                                  |
| 10  | 只有群话题绑定了 B（解绑私聊）后 A 给 B 发消息                                         | 群里**不**出现任何卡                                                                                               |
| 11  | 私聊+群话题同时绑定 B                                                                  | 仅私聊 1 张                                                                                                        |
| 12  | 1 分钟内对同一绑定连发 ≥7 条                                                           | 最多 6 张；下一次成功的卡带「此前另有 N 条…未能推送」；`/webhub feishu status` 的 dropped 含 `xs-mirror-rate`      |
| 13  | 卡片上找按钮/表单                                                                      | 没有任何可点击操作，仅文字「本卡片仅供查看」                                                                       |

## 关闭开关（R9）

1. 先让飞书暂时不可达（例如断网/拦截 open.feishu.cn）并发 2 条用例 1 的消息，使镜像卡积压在 outbox。
2. 设置 `feishuBot.xsMirror=false`，各会话 `/reload`，再 `/webhub restart`，恢复网络。
3. 期望：**既不推新消息，也不发出关闭前积压的镜像卡**；`/webhub feishu status` 的 dropped 出现 `xs-mirror-purged=2`；普通回复/通知照常。
4. 只做 `/reload` 不 `/webhub restart` 时 hub 不变，仍按旧设置运行（符合 R1/R9）。
5. 改回 true + `/reload` + `/webhub restart` 后恢复推送。

## 回归

- `feishuBot.enabled=false` 或未配置 crossSession：跨会话消息照常往返，飞书无任何新增消息。
- 会话重启/`/reload` 期间已发出的镜像不重复发送（同一条只出现一次）。
