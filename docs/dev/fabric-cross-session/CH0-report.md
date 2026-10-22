# CH0 报告：频道契约包

## 改动文件

新增

- src/fabric/xs/channel.ts — 频道名规则、保留名、`channelSet`/`intersect`/`shares`、`effectiveChannels`/`linkChannels`/`linkJoined`、§3.2 写出规则纯函数（`channelsFieldToWrite`/`sharedFieldToWrite`/`viaOrDefault`）
- src/fabric/xs/types-channel.ts — 冻结的内部端口类型（原文见 types-channel.ts，要点见下）
- tests/fixtures/legacy-xs-v071/{README.md,SHA256SUMS,src/web-hub/hub/audit.ts,src/web-hub/hub/xs/{router,limits,members}.ts,src/web-hub/protocol/xs.ts}
- tests/fabric/xs-channel.test.ts、tests/fabric/legacy-xs-v071-fixture.test.ts
- tests/config/settings-fabric-xs-channels.test.ts、tests/web-hub/protocol/xs-channel-frames.test.ts
  修改
- src/web-hub/protocol/xs.ts（只追加）、src/config/settings.ts、.prettierignore（加 legacy-xs-v071/）
- tests/web-hub/protocol/xs-frames.test.ts（deadline 常量 toEqual 增加 broadcast/channels 两键）、tests/config/settings-fabric-xs.test.ts（默认值 toEqual 增加 channels 块）。均为非 golden 的字面量钉；golden 及其测试未动。

## 冻结的端口签名（types-channel.ts）

- `XsChannelView { pref(); effective(); link(hubCap: boolean); linkJoined(hubCap: boolean): boolean }`（方案写作 `linkJoined`，无调用形状；按方法实现）
- `XsUnreadTap { written(id: string): void }`（IB1 对齐；未创建 unread.ts）
- `XsBroadcastMark { channel: string }` ⇒ `RootWakeRequest.bc?: XsBroadcastMark`（CH3 加字段）
- `XsSenderBroadcastArgs { channel; text; wake?; signal? }`；返回 `XsBroadcastOutcome { status: XsBroadcastStatus; effect; reason?; code?; channel; fanout?; results?; wakeDowngraded?; truncated? }`
- hub：`XsLimitsBroadcast { admitBroadcast(args: XsBroadcastAdmitArgs): XsBroadcastAdmit; settleBroadcast(ticket: XsBroadcastTicket): void }`；`XsBroadcastAdmit = {ok:true, ticket, wake, wakeDowngraded?, rows[{wake, wakeDowngraded?:"pair_wake_rate"}]} | {ok:false, reason}`；settle 只释放 inFlight，永不退还。

## protocol/xs.ts 追加

cap `XS_CHANNEL_HUB_CAP`/`XS_CHANNEL_AGENT_CAP`（`XS_AGENT_CAPS` 不变）；`XS_CHANNEL_NAME_RE`、`XS_MAX_CHANNELS`；`xs_member.channels` + limits 三个广播键（wake ≤2）；`xs_req` op `broadcast|channels` + `channel`；`xs_res.fanout/results/channels`；`xs_deliver.via/bc`；`XsStatusSchema.channels`；deadline `broadcast 8000/channels 3000`；wire 类型；新错误码/原因/降级枚举。

## 与方案的偏离 / 歧义处理

1. **`XsReqFrame.op` 未并入新 op**：并入会使 `hub/xs/router.ts:200`（audit op 窄类型）报错，router 属 CH1。改为 `XsReqOp` 保持原四值，新增 `XsChannelReqOp`/`XsAnyReqOp`/`XsChannelReqFrame`；schema（运行时）已接受新 op。**CH1 须把 `XsReqFrame.op` 放宽为 `XsAnyReqOp` 并删除 `XsChannelReqFrame`**。
2. 线上频道名 schema 仅限长度（1..40）、不套正则：非法名由 hub 规范化/答 E_XS_BAD_*，避免静默丢帧（沿用 reply 的 permissive 先例）。
3. `FabricCrossSessionSettings` 新增 `channels` 字段（含 `autoJoinInvalid`），并因此更新两处默认值钉；旧配置解析结果其余字段不变（有测试）。`channels.autoJoin` 与既有布尔 `autoJoin` 并存，语义由 CHW 装配时处理（布尔仍是 legacy 开关，方案 §2.4 的 `join(channels.autoJoin)` 归 CHW）。
4. 夹具含 `hub/audit.ts`（router 的运行时 import `auditXs`），目录整体不在 tsconfig include，prettier 忽略。tag v0.7.1 指向 c89a37d4，这些路径内容与 dev@24b6b2f0 一致。
5. 保留名判定放在 `checkChannelName`（join/autoJoin/tool 使用），`normalizeChannel` 仅语法；非 ASCII 先于 lowercase 拒绝（防 KELVIN SIGN 折叠）。

## 自验

- `npx vitest run tests/fabric tests/web-hub/protocol tests/config 三份 off golden --maxWorkers=3` → Test Files 115 passed；Tests 2635 passed | 3 skipped
- `npm run typecheck`（tsc + typecheck tsconfig + vue-tsc）通过；`npx prettier --check .` 全绿
- 全量 `npx vitest run` 受 280s timeout 截断，未取得完整总结（其间 conformance fabric-xs 13 tests 通过），未声称全绿。
