# CH4 报告：发送端与工具

## 改动

- `src/fabric/xs/sender.ts`
  - `XsHubPort` 新增可选方法：`hubChannelCap()`（live hub 声明 `xs.channel.v1` 且本端也声明）、`broadcast(args)`、`channels(args)`；`XsPortListArgs.channel?`。**CH2 的 adapter 需实现这三项**（缺省 ⇒ fail-closed：`channel_unsupported`）。
  - `XsSenderDeps.channels?: XsChannelView`（CHW 在 channels.enabled 时注入；缺省 ⇒ 所有频道门禁跳过，行为 = 旧 sender）。
  - `XsSender` 新增 `broadcast(XsSenderBroadcastArgs): Promise<XsBroadcastOutcome>`（按 CH0 冻结类型）与 `channels()`（`op:"channels"`，返回 `XsChannelsOutcome`）。`list` 增加 `channel` 参数。
  - 门禁：list/message 在 view 存在时按 `linkJoined(hubCap)` 本地拒绝（新状态 `not_joined`）；broadcast 顺序：非法名 ⇒ `bad_channel`；`#default` ⇒ `default_channel`（Q2）；无 view/无 hub cap/port 无 broadcast ⇒ `channel_unsupported`（旧 hub 上 `[a]` 即此）；`!linkJoined` ⇒ `not_joined`；不在 `link(true)` ⇒ `bad_channel`；字节预检 ⇒ `too_large`。
  - 唤醒：`wakeOn ∧ level ∧ hopAllowed(root) ∧ root===0`，否则本地降级 `sender_wake_disabled`/`level_limit`（不带 wake 发出）；帧携带 `level` 当 wake 可用。hub 的 `wakeDowngraded` 优先。
  - M8：list/channels 在 await 后复核 `(sessionId,epoch)`，变化 ⇒ `origin_changed`，不返回旧 rows（default-only 同样；旧测试 "post-reply identity change keeps them" 按 plan 反转）。
  - 结果映射：ok ⇒ `sent`（fanout/results/wakeDowngraded 透传）；provable-none code 集 ⇒ none，其余 ⇒ unknown；deadline/link_lost ⇒ `unanswered unknown`，发送后 origin 变且无 verdict ⇒ `origin_changed_after_send`。
  - `detectXsToolCollisions(existing, {channels?})`、`XS_CHANNEL_TOOL_NAME`：默认集合不变。
- `src/tools/list-sessions-tool.ts`：`ListSessionsParamsLegacy`（=旧 schema，`ListSessionsParams` 别名保持，逐字节不变）+ `ListSessionsParamsChannel`（只多 `channel?`）+ `listSessionsParamsFor(enabled)`；`createListSessionsTool({sender, channels?})` 选实例/描述；行文本仅在行带 `channels` 时追加 `channels=#a,#b`。注意：`ListSessionsParams` 的 **类型**现在指向 Channel 实例的 Static（legacy 值不含 channel，工具内按实例丢弃）。
- 新 `src/tools/message-channel-tool.ts`：`{channel,text,wake?}`、`additionalProperties:false`、无 expectReply；描述写死 ≤4 人 / ≤2 次每小时、#default 禁广播、回应用 message_session；unknown 时追加不要重发提示。
- 测试：`tests/fabric/xs-sender-channel.test.ts`、`tests/tools/message-channel-tool.test.ts`；更新 `tests/fabric/xs-sender.test.ts` 一条（M8）。

## 给 CHW/CH2 的接线说明

- 注册 `message_channel`、传 `createListSessionsTool({sender, channels:true})`、`createXsSender({..., channels: view})`（view=CH3 membership 的 XsChannelView）；index.ts 的碰撞检测 `own` map 需加 `message_channel`→`MessageChannelParams`，list_sessions 在 channels 开启时应登记 `ListSessionsParamsChannel`（目前登记 legacy，开启后会误报碰撞）。
- hub 对默认频道广播的 `E_XS_BAD_TARGET` 约定 `reason:"default"`（sender 据此映射 `default_channel`，否则 `bad_channel`）；如 CH1 用别的 reason 需对齐。

## 自验

- `npx vitest run tests/fabric tests/tools tests/integration/{fabric-xs-off,fabric-xs-reply-off,fabric-wake-off}-golden.test.ts --maxWorkers=3` → 71 files / 1266 tests passed（含新测试）
- `npm run typecheck` → 通过
- `npx prettier --check` 改动文件 → 通过
- golden fixtures 未改动。
