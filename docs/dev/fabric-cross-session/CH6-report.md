# CH6 报告：终局（文档 + C-X9 + `/agent status` + 真机清单 + 全量门禁）

> 规格：`channel-plan.md` §10 CH6、§9.3（C-X9）、§12。无 commit。

## 1. 改动

| 文件                                                  | 改动                                                                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                           | `src/fabric/` 段 request-reply 之后新增「Channels + broadcast + unread inbox」段（模型、不变量、设置键、cap、门控、off 字节一致、gates、残留）；web-hub 段（Session switching 之前）新增「Channels in the web UI」。其余内容未动 |
| `src/commands/status.ts`                              | `/agent status` 增加一行 `xs channels #a #b (n/4)[ · suspended …][ · inbox N]`，仅当有命名频道 / 有挂起 / 未读 > 0 时输出；default-only 且无未读时字节不变。对 membership 缺方法的假对象做了防御                                 |
| `tests/commands/status-xs.test.ts`                    | 新用例：default-only 无该行；命名频道、挂起、未读、`99+` 各形态。原 status-xs 用例未改且通过                                                                                                                                     |
| `tests/conformance/fabric-xs.test.ts`                 | 新增 C-X9（排在 C-X10 `describe` 之前，文件内顺序在 C-X7 之后；C-X10 不受影响）                                                                                                                                                  |
| `docs/dev/fabric-cross-session/channel-acceptance.md` | 真机验收清单（前置 /reload + /webhub restart；join/leave/#default 隔离、/fabric channels、list_sessions 过滤、跨频道拒绝、广播与唤醒门槛、@ 范围、web chip/筛选/管理弹窗、inbox、旧 hub、`channels.enabled=false` 挂起、签收表） |
| `docs/dev/fabric-cross-session/CH6-report.md`         | 本报告                                                                                                                                                                                                                           |

## 2. C-X9 说明

真实 pi + 本地 Anthropic stub + 真实 `XsReceiver`/`RootWakeController`，成员关系为 `channelsEnabled` 且已 `join(["team"])`，投递带 hub 盖章的 `via:["team"]`、`bc:{channel:"team"}` 的帧：

1. 只投递广播（idle）：不发 provider 请求、不起 run，下一次人类 prompt 才可见正文。
2. `wake:true, level:0` 广播：触发 Controller run，绑定 token；trigger 的 `details` 含 `xsWake`、`wakeToken`、`bc:{channel:"team"}`（Controller 贯通）。
3. 模型可见文本首行匹配 `[fabric xs from=… channel="#team" kind="broadcast"]`，并含宿主说明句。
4. 全部 provider 请求体不含 token、`wakeToken`、`xsWake`、两个 xid、发送方 sessionId、`"bc"`、`"via"`；各请求 `system`/`tools` 彼此相等。
   注：不检查裸词 `details`（工具描述里本来就有这个词，首次尝试因此失败，已去掉）。不含 `message_channel` schema 稳定性断言：conformance host 不装配 toolkit 的工具表，该项由 `tests/integration/fabric-xs-channel*.test.ts` / activation 测试覆盖。

## 3. 门禁（全部通过）

```
npm run format:check && typecheck && build && build:web && check:web  → exit 0
  ✓ check:web — dist/web-hub-ui/ OK (82 files, first-screen JS 329472B gz/524288B, lazy JS 49555B gz/131072B, mermaid JS 1421015B gz/2097152B in 61 mmd files, CSS 34317B gz/65536B, 57 packages)

npm test
 Test Files  1351 passed (1351)
      Tests  25711 passed | 22 skipped (25733)
   Duration  354.65s

npm run test:conformance
 Test Files  24 passed (24)
      Tests  260 passed | 17 skipped (277)
   Duration  114.46s   (DONE 0)
tests/conformance/fabric-xs.test.ts 单跑：19 passed（含 C-X9、C-X10）
```

（新增 CH6 文件后的 `format:check` 已在写报告前对 AGENTS.md / acceptance 文档 / 改动的 ts 逐个 `prettier --write`；报告本身在下方复核。）

## 4. 修复的回归

无。三份 off golden、`legacy-xs-v071` 夹具、`xs-alias.ts`、`xs-alias-corpus.json` 均未触碰。

## 5. 遗留

- C-X9 不含工具 schema 稳定性（见 §2）。
- 真机清单需用户执行，未代跑。
