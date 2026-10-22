# CHW 报告：频道装配

> 规格：`channel-plan.md` §10 CHW 行，以及 §2.3/§2.4、§3.2、§4、§5.3、§6、§9.2 1–7、§9.4-2。依赖 CH0–CH5、IBW，都已在 dev 上。没有 commit。

## 1. 接线清单

### `src/stack.ts`（`buildStackXs`）

| 接线                     | 内容                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel 视图             | `new XsMembership({… channelsEnabled: config.channels.enabled})`：频道关闭时命名频道挂起，不折叠成 default。`StackXs.channelView = () => membership`，即 CH2 的 `XsStackPort.channelView`                                                                                                                                                                                                                     |
| autoJoin（§2.4）         | 布尔 `fabric.crossSession.autoJoin` 仍是总开关。条件 `autoJoin ∧ reason≠fork ∧ 无持久化 entry ∧ !channels.autoJoinInvalid` 成立时，调用 `membership.join(names)`。频道开启时 `names = channels.autoJoin`，默认值 `["default"]`，与旧的 `join()` 写出逐字节相同。频道关闭时只取 `autoJoin ∩ {default}`，结果为空就不加入。注意：`join([])` 在 CH3 里等于加入 default，所以「配置项全部非法」必须在调用前就挡掉 |
| hub cap 端口             | `StackXsInput.hubChannelCap?`，晚绑定，抛错时按 false 处理 → `XsReceiver({hubChannelCap})`，用于 stage 3 的 linkChannels 复核                                                                                                                                                                                                                                                                                 |
| reply 可接收性           | `reply.receivable` 改为读 `membership.linkJoined(hubCap)`，与 receiver stage 3 口径一致                                                                                                                                                                                                                                                                                                                       |
| 目录（§4.3）             | `view()` 与 `fetch()` 都以 `linkJoined(hubCap)` 为门；身份键在非 default-only 时折入 `channels: link(hubCap)`，因此本地换频道或 hub cap 翻转都会清空缓存。default-only 时键与旧形状完全相同                                                                                                                                                                                                                   |
| status 投影（§3.2）      | `xs.channels` 只在频道开启且有效集合不是 default-only 时写，使用 `channelsFieldToWrite`。旧 hub 的降级（`joined ← linkJoined`）仍由 CH2 的 slotFlush 负责                                                                                                                                                                                                                                                     |
| NoticeGate `joined`      | **不改**，仍读 `membership.joined`（有效集合非空）。本会话自己请求产生的通知不随 hub 链路变化                                                                                                                                                                                                                                                                                                                 |
| IBW 未读 tap / turn 事件 | 原样保留                                                                                                                                                                                                                                                                                                                                                                                                      |

### `src/index.ts`

| 接线                   | 内容                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 冻结开关               | `channelsOn = xsEnabled ∧ channels.enabled`，每次 activate 冻结一次                                                                                                                                                                                                                                                            |
| sender（CH4）          | `port` 增加 `hubChannelCap` / `broadcast` / `channels`，都晚绑定到 bridge，bridge 缺失时返回 `off`。`channels: xsChannelView` 是一个委托视图，指向当前 stack 的 membership；stack 未 attach 时返回空集合、视为未加入                                                                                                           |
| 工具注册（§6）         | `createListSessionsTool({sender, channels: channelsOn})`：频道开启用新 schema，关闭用 legacy 实例（= golden）。`message_channel` 只在 `channelsOn` 时注册，位于 post-guard 的 xs 块里，所以只在主会话、子会话永不注册                                                                                                          |
| 碰撞检测               | `own` 表改为本次 activate 实际注册的实例：`listSessionsParamsFor(channelsOn)`、`messageSessionParamsFor(replyEnabled)`，频道开启时加上 `message_channel → MessageChannelParams`；同时传 `{channels: channelsOn}`                                                                                                               |
| `/fabric` deps（CH3）  | `channels` → `sender.channels()`，映射成 listing；它同时是补全缓存的刷新源，status/channels/join/leave 之后由命令自己非阻塞刷新，completer 不发起任何 I/O。其余：`broadcast`（有效配置）；`hubChannelCap`（只有 live 链路才给 true/false，否则 `n/a`）；`directoryChannels`（目录行里的频道并集，只读缓存）；`autoJoinInvalid` |
| `/fabric block` 解析   | 频道开启 ∧ `!linkJoined(hubCap)` 时不发 resolve 帧，返回 `offline`，回落到命令自己的离线全 id 规则。这对应 §2.3「block 解析本地门禁」：旧 hub 会为未加入的会话做 resolve（C4）                                                                                                                                                 |
| mention（§2.3/§4.3）   | `joined` 改为 `membership.linkJoined(channelsOn ∧ hubCap)`；补全条目把 `row.channels` 传给 CH5                                                                                                                                                                                                                                 |
| web-hub xs 端口（CH2） | `channelsEnabled: () => channelsOn`（agent cap `xs.channel.v1`）；`channelsHubConfig` 取 `{maxRecipients, wakeMaxRecipients}`；`memberLimits` 在频道开启时附带三个广播键（`outPerHour`、`minIntervalS×1000`、`wakeOutPerHour`），bridge 只在命名频道帧里写出这三个键，default-only 帧不受影响                                  |
| `bc` 贯通（§5.3）      | CH3 已实现 receiver → `RootWakeRequest.bc` → Controller details，以及 quiet 写出的 `details.bc`。装配层不需要额外接线，宿主 `sendMessage` 原样转交 details。集成测试 #3 断言被唤醒的消息带 `details.bc` 且 `xsWake:true`                                                                                                       |

### 不变量

- 新闭包状态（`channelsOn`、`xsChannelView`、`xsHubChannelCap`）都在 `activate()` 内部，没有 module-scope 可变状态。
- 没有新增定时器。
- HOST_KEY 守卫与子会话惰性不变：所有新注册都在 post-guard 的 `if (xsEnabled)` 块内。

## 2. 改动他包文件

| 文件                                             | 改动                                                                                                                                                           | 理由                                                                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/agent/xs.ts`（CH2）                 | `hubPort()` 增加三项：`hubChannelCap`（与 `channelCapable` 同一判据）、`broadcast`、`channels`，复用 `roundTrip` 已有的旧 hub 零帧守卫；同时新增两个帧构造函数 | CH4 的 `XsHubPort` 要求的是 `hubChannelCap` / `broadcast` / `channels`，CH2 只提供了 `channelCapable`，也没有实现这两个 op（CH4 报告里明确写了「CH2 的 adapter 需实现这三项」）。纯追加，不改变已有字段和帧 |
| `tests/integration/fabric-xs-activation.test.ts` | 默认配置下 `list_sessions` 改为断言频道实例、`message_channel` 已注册；新增两个用例：频道关闭 ⇒ legacy 实例且无 `message_channel`；xs 关闭 ⇒ 永不注册          | Q6 让 `channels.enabled` 默认开启，旧断言「默认即 legacy」必须跟着改                                                                                                                                        |
| `tests/integration/helpers/fabric-xs-process.ts` | 纯追加：环境变量 `XW_CHANNELS_JSON`、`XW_WAKE_MAX_LEVEL`、`XW_HUB_CHANNELS_JSON`，以及 `settingsChannels` op                                                   | §9.2 场景需要                                                                                                                                                                                               |

**顺带修复**：碰撞检测原先拿 legacy `MessageSessionParams` 做比较。reply 开启（默认）时，本插件自己注册的 `message_session` 会被误报为碰撞。现在改为与本次 activate 实际注册的实例比较，`list_sessions` 的频道实例也一样。

## 3. §9.2 场景与测试名（`tests/integration/fabric-xs-channel.test.ts`，真实 hub 子进程 × 2–5 个真实 stack）

| §9.2  | 测试                                                     | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 + 2 | `#1 same-channel scope, #2 union visibility …`           | A、B 在 `#a`，C 只在 default ⇒ A 的列表里只有 B，A↔C 双向 `no_target`。A 在 `[a,b]` ⇒ 能看到 B 和 D；B 和 D 互不可见。行的 `channels` 是共享集合；list 的 `channel` 过滤可用；对非本人频道过滤 ⇒ `bad_channel`；`/fabric status` 有 channels 行，`/fabric channels` 列出 hub 频道                                                                                                                                                      |
| 3     | `#3 broadcast: …`                                        | C 发只投递广播：fanout 3/3，不回环，replies 模式的 D 不可见，接收方带 `details.bc` 且首行有 `channel="#team" kind="broadcast"`，接收方 TUI 显示 `inbox 1`（§12.7「广播计入」补跑）。A 发 level 0 唤醒广播：B 被唤醒（`woke:true`，`details.bc`），C（deliver 模式）这一行降级为 `receiver_policy`，F（maxLevel=0）这一行降级为 `level_limit`。被唤醒的 B 再发带唤醒的广播 ⇒ 本地 `level_limit`。发送方 maxLevel=0 ⇒ 本地 `level_limit` |
| 4     | `#4 limits: …`                                           | hub `maxRecipients=2` ⇒ `E_XS_FANOUT_TOO_LARGE`。`outPerHour=1` ⇒ 第 2 次 `rate_broadcast_hour`（规格写的是「第 7 次」，缩比为「上限 +1 次」以免拖慢测试）。间隔不足 60s ⇒ `rate_broadcast_interval`。`#default` / `#Default` ⇒ `default_channel`                                                                                                                                                                                      |
| 5     | `#5 linearization: …`                                    | (a) hub 已盖章 `via=[a]`，接收方在 stage 3 之前 `leave #a`（仍在 `#b`）⇒ `none{rejected}`，消息未写入；(b) dispatch 之后、ack 回到发送方之前 leave ⇒ `applied`，不回滚                                                                                                                                                                                                                                                                 |
| 6     | `#6 a cross-channel double holder is AMBIGUOUS …`        | 第二个进程恢复同一 session，并加入 A 看不到的 `#z` ⇒ A 发送得到 `ambiguous`，两边都没有收到                                                                                                                                                                                                                                                                                                                                            |
| 7     | `#7 hub restart, /reload, fork …, suspend … and restore` | hub 重启后成员 slot 带频道重放；/reload 保留频道集合；fork 不继承。`channels.enabled=false` + reload ⇒ 状态显示 `not joined` 与 `suspended #a (channels.enabled=false)`，B 看不到 A，membership entry 未改写，`message_channel` 消失；重新开启并 reload ⇒ 回到 `#a`                                                                                                                                                                    |

harness 两个注意点：

- **agent 共享同一个 HOME**，设置文件在 boot 时写入。并行 boot 会让 env 配置互相覆盖（实测会让 `XW_RECEIVE` 串号），所以本文件一律**串行 boot**。
- **UUIDv7 的 12 位 ref 粒度约 16ms**，并行创建的会话会出现 ref 碰撞（实测出现过）。串行 boot 同时也避免了这个问题。
- `sees()` 每次轮询间隔 400ms，以免撞上 hub 的 `listPerMin=60` 限流。

## 4. §9.4-2 compat 测试（`tests/integration/fabric-xs-channel-compat.test.ts`）

**接线**：

- 真实 `activate()` → 真实 `buildSessionStack`（`SessionManager.create`）→ activate 自己调用的 `wireWebHub`。
- 用 `vi.mock` 包一层薄壳，只替换确定性输入：golden 的 `SETTINGS`（autoStart + nodeLoader）、`env`/`paths`、`buildInfo`（`0.0.0-golden` / `golden-build`）、`argv1=/nonexistent/pi`、`now`、`netConnect`（fakeNet，与 golden 相同）、`spawnImpl`（捕获 HubConfig）。
- xs 端口（stack、memberLimits、replyEnabled、channelsEnabled、channelsHubConfig）全部是 activate 原样传入的。
- 对端走 golden 的 ENOENT → 自启动 → 第二个 socket → `hello_ack` 流程。ack 的 caps 比 golden 多了 `xs.reply.v1` 和 `xs.channel.v1`，目的是让开启的功能真正生效；④ 两者都不会用到。

**确定性输入**：

- 只伪造计时器和 Date，`vi.setSystemTime(FIXED_NOW)`。
- 每组配置采集前清空 `pi-subagent:{host,xs-epoch,xs-unread,xs-host-cap,xs-wake-ledger,xs-reply-ledger,xs-dedup}` 全局，并 `resetGlobals()`。
- ctx 对齐 golden 的 fakeCtx 事实：`getLeafId → "e1"`、`mode tui`、contextUsage 1000/200k、cwd `/tmp/wa`。
- 设置里的 `limits` 取 golden 的 7 个值，`hubSendsPerMin=60`；`askUser` 开启，因为 golden 的 hello 带 `dialog.v1`。
- membership entry 来自真实 autoJoin 写出（`pi.appendEntry`），断言恰好 1 条。

**规范化**（只替换值，不删键，不排序）：

- golden 原有规则：tmp 路径、agentId、node 路径、uuid；
- `x[0-9a-f]{18}` → `<xid>`；
- 围栏 nonce → `<<<fab-<nonce>`；
- 真实 sessionId 按首次出现顺序映射为 `sess-golden123456` / `<sidN>`，先于通用 uuid 规则执行；
- `xs_member.epoch` 按首次出现顺序映射为 7、8…

**断言**：

- ③④：`memberFrame` / `statusFrame` / `slotSequence` / `membershipEntry` / `formatXsMessage` 与 golden 的 JSON 串逐字节相等。
- `hello.caps`：③ 断言 `xs.channel.v1` 恰好出现一次，去掉后与 golden 相等；④ 的整个 `hello` 与 golden 相等。
- 额外锚定：④ 的 HubConfig 与 golden 相等；③ 删除 `crossSession.channels` 后相等，并断言这个键等于 `{16,4}`。
- ①≡②、③≡④：去掉例外项（cap、HubConfig 的 channels 键）之后，七个面逐字节相等。
- 工具表例外：`message_channel` 当且仅当频道开启时存在；四组都没有 `xsInbox`。

**有效性（变异检查）**：把 stack 的 status 改成 default-only 时也写 `channels`，compat 测试立刻失败（`"channels":["default"]`），随后已恢复原文件。

## 5. 冻结面

- 三份 off golden（`fabric-xs-off`、`fabric-wake-off`、`fabric-xs-reply-off`）未修改、未重新生成，全部通过。
- `tests/fixtures/legacy-xs-v071/` 未动。
- legacy `ListSessionsParamsLegacy` / `MessageSessionParamsLegacy` 实例不变；频道关闭时注册的就是 legacy 实例（activation 测试用 `toBe` 断言）。

## 6. 自验

```
npx vitest run tests/fabric tests/commands tests/tools tests/mention tests/web-hub/agent tests/web-hub/hub tests/integration/fabric-xs*.test.ts tests/integration/fabric-wake*.test.ts tests/web-hub/boundary.test.ts --maxWorkers=3
 Test Files  381 passed (381)
      Tests  7751 passed (7751)
   Duration  248.56s

npm run test:conformance
 Test Files  2 passed (2)    Tests  21 passed | 1 skipped (22)
 Test Files  24 passed (24)  Tests  259 passed | 17 skipped (276)
（单跑 tests/conformance/fabric-xs.test.ts：18 passed）

npm run typecheck    → 通过（tsc ×2 + vue-tsc）
npm run format:check → All matched files use Prettier code style!
```

## 7. 遗留 / 说明

- `/agent status`（`src/commands/status.ts`）仍只显示 joined/left，不显示频道。不在本包文件域，可交给 CH6。
- `/fabric status` 的 `hub-cap` 用 `currentConnection()` 判断 live 状态，未连接时显示 `n/a`。
- 收紧：频道开启时，**未加入**的会话执行 `/fabric block` 不再发 resolve 帧，直接走离线全 id 规则。新 hub 本来也已对未加入的请求方关闭 resolve（CH1 偏离 #5），所以结果等价。
- 范围外观察：UUIDv7 的 12 位 ref 在同一时刻（约 16ms 内）创建的会话之间可能碰撞。hub 会按候选或 AMBIGUOUS 处理，不会发错对象，但 list 行 ref 的可区分性受影响。这是既有协议性质，不是 CHW 引入的。
