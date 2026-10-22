# CH2 报告 — agent 侧 hub 连接（channel-plan §3.2 / §9.4）

## 改动

- `src/web-hub/agent/xs.ts`
  - `XsStackPort.channelView?(): XsChannelView`（保留 IBP 的 `unread?`）；`XsAgentPort.channelsEnabled?()` / `channelsHubConfig?()`。
  - `caps()`：`channelsEnabled` 时在末尾追加 `xs.channel.v1`（关闭/缺省 ⇒ 与旧字节相同）。
  - `hubCrossSessionConfig()`：仅在 channels 开启且端口给出参数时写 `channels:{maxRecipients(1..32),wakeMaxRecipients(0..4)}`。
  - `publishMember()`：存储帧在有效集合非 default-only 时写 `channels`（`channelsFieldToWrite`）、`joined:true` 与 clamp 后的三个广播键；default-only/空 ⇒ 无 `channels`、无广播键（逐字节同旧）。
  - `slotFlush`：对每次写出（live + hello_ack 重放）按当前 hub 的 `xs.channel.v1` 降级——旧 hub 删除 `channels` 与广播三键、`joined ← linkJoined`（成员帧与 status 的 `xs`）；与 replies 降级叠加；default-only 帧不受影响。
  - `roundTrip`：`broadcast`/`channels` op 或带 `channel` 字段的 `xs_req` 在旧 hub 上不发帧，直接返回 `{kind:"off"}`；`reqOfList` 转发可选 `channel`；`hubPort().channelCapable?()`。
- `src/web-hub/agent/connection.ts`：**无需改动**（slot 顺序、SlotFlush 机制已足够）。
- 新测试 `tests/web-hub/agent/xs-legacy-hub.test.ts`（10 例）：default-only × 新/旧 hub、`[a]` 新/旧、`[default,a]` 旧、新→旧→新重放、channels 关闭挂起、status 降级、caps/HubConfig、旧 hub 的 channel-op 零帧。

## 自验

- `npx vitest run tests/web-hub/agent tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts --maxWorkers=3` → 87 files / 1496 tests 全过（含三份 golden，未重生成）。
- `npx prettier --check` 两个改动文件通过。
- `npm run typecheck`：仅余 CH1 在途错误 `src/web-hub/hub/xs/router.ts(200,9) XsAnyReqOp`；本包无报错。

## 说明 / 遗留

- 约定（供 CHW 装配）：stack 的 `member().joined` 仍表示 pref∋default；status 的 `xs.joined` 请给 `effective≠∅`，`xs.channels` 非 default-only 时才写（flush 依此降级）。`XsXs.status()` 本包不改。
- CH4 需把 `XsPortListArgs` 加 `channel?`，并通过 `roundTrip` 类似路径发 broadcast/channels（本包只做了 hub-cap 守卫，未扩 `XsHubPort`，因其在 sender.ts）。
- 本包 wire 的 `joined` 对命名频道会话写 true（hub 以 `channels` 为准）。
