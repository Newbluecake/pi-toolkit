# P3 报告 — 装配 + 集成 + 文档（feishu-xs-mirror）

## 改动

- `src/web-hub/hub/hub.ts`：`xsMirrorOn = config.feishuBot?.xsMirror === true && config.crossSession !== undefined`；为真时 `createXsRelay({..., onQuietDelivered: (e) => bot?.xsMirror(e)})`（`bot` 惰性读取）；为假不传该键。接口名按 P1/P2 报告核对无偏差。
- `tests/integration/web-hub-feishu-bot.test.ts`：harness 扩展（`boot` 增 `xs/xsMirror/noCreds`；`send` 可指定 chat；`bindChat`、`xsAgent`（xs_member + 发送/收/ack）、`cards`、`mirrorDropped`；子进程增 `netFail` op 与 `F10_NO_CREDS`）；新增 describe「feishu-xs-mirror」8 个用例。
- `AGENTS.md`：feishu bot 段补镜像一段；`docs/dev/feishu-xs-mirror/acceptance.md`（新）。

## I1–I16 覆盖

| 用例                                                           | I#                    |
| -------------------------------------------------------------- | --------------------- |
| p2p 点对点（on/off 对拍 + caps 字节相等）                      | I1 I2 I3 I4 I5 I7 I10 |
| 准时/迟到/排队回复                                             | I11 I12               |
| 超时后迟到 ack、重复 ack                                       | I13                   |
| 广播（两接收方各 1 张）+ 混合结果广播（on/off 对拍聚合结果）   | I6 I14                |
| 7 条/分钟限流，`xs-mirror-rate===1`                            | I8                    |
| 无凭据 / feishuBot 关                                          | I9                    |
| 存量清除（false ⇒ purged=2 不发；true 对照 ⇒ 重启后发出 2 条） | I15                   |
| 10 绑定 × 4 条：恰 30 张、10 绑定全覆盖、drop 守恒             | I16                   |

## 偏离 / 说明

- I8 的「下一窗口尾注」按方案只断言计数（尾注由单测覆盖）。
- I15 用 fake Feishu 的 `networkError`（可重试）让镜像 notice 留在 queued，而非鉴权失败，效果等价（notice 持久化为 queued）。
- 发送方 pair 间隔最小 5 s，故同一接收方的多条消息由多个发送方 agent 发出。

## 自验

见下方（实际输出已贴于最终回复）。
