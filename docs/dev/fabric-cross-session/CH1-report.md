# CH1 报告：hub 侧频道（同频道强制 + 广播扇出 + NQ2）

## 改动文件

修改

- `src/web-hub/protocol/xs.ts`：`XsReqFrame.op` 放宽为 `XsAnyReqOp`，删除临时的 `XsChannelReqFrame`（CH0 偏离 #1 收口）
- `src/web-hub/hub/xs/members.ts`：`XsMemberRecord.channels`（§2.5，`joined ⇔ channels ≠ ∅`，失败关闭）、`XsEffectiveMember.channelCapable`；hub 侧频道纯函数镜像（`hubNormalizeChannel/hubChannelSet/hubIntersect/hubSharedField/memberChannelsOf`）；广播三键 clamp（缺失则保持缺失，读取时按下界取值，即 `broadcastLimitsOf`）；共用的 stamping helper（`XS_REF_LEN/XS_NAME_MAX/xsToken/abbreviateHome`，从 router 移过来，避免 router 与 broadcast 循环依赖）
- `src/web-hub/hub/xs/limits.ts`：NQ2 收紧；`admitBroadcast/settleBroadcast`；`HubCrossSessionConfig.channels` 及其复核
- `src/web-hub/hub/xs/router.ts`：list/resolve/send 强制同频道，M3 全表判重；§3.2 不写规则；`channels` op；`broadcast` 分派
- `src/web-hub/hub/hub.ts`：只要有 `crossSession` 就在两个 cap 面上宣告 `xs.channel.v1`，追加在末尾（排在 xs.v1 / xs.reply.v1 之后）
- `src/web-hub/hub/main.ts`：只补了注释。复核走 `normalizeHubCrossSessionConfig`，`channels` 子键非法时只丢这个子键
- `src/web-hub/hub/audit.ts`：`op` 增加 `broadcast|channels`；白名单在末尾追加 `bcast`(bool)、`recipients`(int)

新增

- `src/web-hub/hub/xs/broadcast.ts`：广播扇出 `runXsBroadcast`

测试（修改）

- `tests/web-hub/hub/xs-fixtures.ts`：agent 支持 `channels`、`receive:"replies"`；rig 支持 hub `channels` 参数；新增 `CHANNEL_CAPS/BCAST_LIMITS`
- `tests/web-hub/hub/xs-router.test.ts`：两处断言按新语义改写
  - 未加入成员 list 得到空、resolve 得到 NO_TARGET（§4.1 / C4）；
  - 原「unknown+woke:false 退还」改为「applied+woke:false 退还」，另加 NQ2 用例：unknown 不退还。
- `tests/web-hub/hub/xs-limits.test.ts`：退还用例补上 `effect`，另加 NQ2：unknown 或缺 effect 时都不退还
- `tests/web-hub/hub/caps-coexist.test.ts`：两组 cap 断言加入 `xs.channel.v1`（按 §3.2 是已知、一次性的例外）

测试（新增）

- `tests/web-hub/hub/xs-channel-hub.test.ts`（20 个用例）
- `tests/web-hub/hub/xs-broadcast.test.ts`（25 个用例）
- `tests/web-hub/hub/xs-broadcast.property.test.ts`
- `tests/web-hub/hub/xs-router-v071-diff.test.ts`（6 个用例）

## 实现要点

### 同频道强制（§4.1）

- `visible(m) = m.channels ∩ self.channels ≠ ∅`。未加入的请求方没有频道，所以看不到任何人。
- **M3**：resolve/send 在可见池里按原层级找命中；命中单个 sid 后，用 `holders(sid)` 在全部有效 ∧ joined 成员上计数（不看频道、receive、cap），`>1` ⇒ `E_XS_AMBIGUOUS`，候选只给可见持有者的 ref/name。
- reply 走精确 sessionId 分支，用的是同一个可见池，不可见 ⇒ NO_TARGET（Q4）。
- list：在原过滤上加 `visible`；`channel` 过滤要求规范名 ∈ self.channels，否则返回 `E_XS_BAD_TARGET` + `reason:"channel"`。这个判断先于 `listPerMin`，非法请求不扣额度。
- §3.2 写出规则：
  - `rows/candidates[].channels` = 共享集合，只在请求方 `channelCapable` 且共享集合 ≠ [default] 时写；
  - `xs_deliver.via` 只在目标 `channelCapable` 且共享集合 ≠ [default] 时写；
  - `target` 不加字段。
- 帧校验：`broadcast/channels` op 要求请求方 `channelCapable`；`channel` 字段只允许出现在 list/broadcast 上。不满足都返回 `E_XS_BAD_FRAME`（none）。
- `channels` op：计入 `listPerMin`；统计全部有效 joined 成员的频道，人数按**逻辑会话**（去重 sessionId）计；排序为「我加入的在前 → 人数降序 → channelSet 序」，≤32 条。未加入但有效的成员也可以查。

### 广播（§5.2，broadcast.ts）

1. **前置检查**：
   - 文本非空，否则 `BAD_FRAME`；
   - 名称非法或不在 self.channels ⇒ `E_XS_BAD_TARGET{reason:"channel"}`；
   - `#default` ⇒ `E_XS_BAD_TARGET{reason:"default"}`；
   - 未加入 ⇒ `E_XS_STALE_ORIGIN`，与 send 一致。
2. **收件集合 S**：候选成员条件为 有效 ∧ joined ∧ ∋channel ∧ channelCapable ∧ receive∉{off,replies} ∧ 非本 sid ∧ 非本 agentKey，按 sid 去重（代表取最近活跃的那条）。
   - 全表 holders>1 的 sid 记一行 `none{ambiguous}`，不投递，但计入 N 和配额；
   - 行序：活跃时间降序，再按 sid 排。
3. **规模**：N=0 ⇒ `{ok:true,effect:none,reason:no_recipients}`，什么都不占；N>maxRecipients ⇒ `E_XS_FANOUT_TOO_LARGE`。
4. **准入**：
   - 先对每个可投递行做最坏形状 16 KiB 预检（含 via/bc），不过 ⇒ `E_XS_TOO_LARGE`，不占额度；
   - 然后调 `admitBroadcast`，全有或全无：inFlight、sendsMin/Hour 和 hub 的剩余量都 ≥N，broadcastsOutPerHour 剩余 ≥1，满足间隔；
   - 被拒 ⇒ `{ok:true,effect:none,reason}`，**什么都不消耗**；
   - pair interval 不检查，但对每个收件人打时间戳。
5. **唤醒**：
   - 5.1 在 router 侧判：不带 level ⇒ `sender_wake_disabled`，level≠0 ⇒ `level_limit`；
   - 5.2–5.5 在 limits 里判，第一个不满足的原因作为整体 `wakeDowngraded`：
     - `wakeMaxRecipients` 先 `min(4, 配置)`，N 超过 ⇒ `broadcast_wake_fanout`；
     - `broadcastWakesOutPerHour` 取 `min(2, 声明)`，没有剩余 ⇒ `broadcast_wake_rate`；
     - 出站唤醒剩余 <N ⇒ `outbound_wake_rate`；
   - 都满足 ⇒ 预占 1 次广播唤醒；然后逐行检查 pair 唤醒，不足的行单独降级为 `pair_wake_rate`，该行不预占出站唤醒。
6. **投递**：每个可投递行生成独立 xid，各调一次 `registry.request(xs_deliver{…, via?, bc:{channel}})`；`level` 与 send 同口径，有就带上；hub 从不重发。
7. **结算**：
   - ack 的 xid 不匹配 ⇒ `unknown{ack_mismatch}`；截止 ⇒ `unknown{deliver_deadline}`；断链、dispose 或同步抛错 ⇒ `unknown{link_lost}`；
   - **不退还任何东西**：`settleBroadcast` 只释放 inFlight，并且只在所有行结算后调一次。
8. **聚合**：
   - 全部 applied ⇒ applied；全部 none ⇒ none；**全部 unknown ⇒ unknown，不带 reason**；混合 ⇒ `unknown{partial}`；
   - 回执带 `fanout{total,applied,none,unknown,woke}` 和 `results[]`（ref/name/effect/reason/wakeDowngraded/woke）；
   - 审计：一行 `op:"broadcast"`（含 recipients N），外加每个收件人一行 `op:"send", bcast:true`（ambiguous 行没有 xid），都不记正文。

### NQ2（limits.ts）

点对点 `settle` 只在 `acked ∧ woke===false ∧ effect ∈ {applied, none}` 时退还唤醒预占；`unknown` 或缺 effect 都不退还。router 现在会把 `ack.effect` 传进 settle。

### HubConfig

`crossSession.channels = {maxRecipients 1..32, wakeMaxRecipients 0..4}`，两项都必须是范围内整数，否则只丢这个子键（回落默认 16/4）。**缺失不表示关闭**；cap 只看 `crossSession` 是否存在。

## 差分测试（§9.4-3，`xs-router-v071-diff.test.ts`）

**被测对象**：`tests/fixtures/legacy-xs-v071/` 冻结的 router（经它自己的 limits/members/audit/protocol 副本）对比当前 router。

**相同的输入**：

- 同一份成员表，全部 default-only，`xs.channel.v1` 与 `xs.reply.v1` 混合，包含 receive off/deliver/replies、名字大小写冲突、前缀冲突、双持有者、未加入成员；
- 同一个固定 `now`（`vi.setSystemTime` + rig 时钟）；
- 同一个确定性脚本：info；5 种 list；12 种 resolve（含 many/dup/bad/none）；send，覆盖 wake 退还（applied+woke:false）、dup、off、replies、保留地址、空文本、过大、pair 间隔、expect/replyTo/坏 expect/目标无 reply cap、截止 unknown、xid 伪造、rejectTooLarge；
- 请求方分别为 A（新）、B（旧带 reply）、D（旧不带 reply）、H（旧带 reply）。

**解码方式**：旧侧只用冻结的 `XS_AGENT_FRAME_SCHEMAS` 做薄解码，并断言两侧产出的每个 `xs_deliver` 都能通过冻结的 `XS_HUB_FRAME_SCHEMAS`。

**比较方式**：把 `xs_res`、`xs_deliver` 和 xs 审计行串成 transcript，**只**把 xid 规范化为 `<xid>`（只替换值，不删键、不排序），然后逐字节比较。

**有效性检查**：

- 变异检查：把 `hubSharedField` 改成对 [default] 也写出，或把 list 里的 replies 过滤去掉，4 个差分用例全部变红。
- 负对照：带 `channels`、广播键、`via`、`bc` 的帧以及新 op，都会被冻结 decoder 拒绝。

**NQ2 定向用例**：同一输入下，effect 为 applied 或 none 时两侧 transcript 相同；只有 `unknown ∧ woke:false` 时出现差异：v0.7.1 第二次唤醒为 true（退还了），当前实现为 false（没有退还）。

**等价面排除项**：NQ2，以及未加入的请求方（它不属于 default-only；§4.1 有意封闭了它的发现能力，由 xs-router.test.ts 单独钉住）。

## property（`xs-broadcast.property.test.ts`）

- **设置**：120 个种子 × 1–4 轮。ack 来源是**真实的 `XsReceiver` + `XsMembership`（join `[team]` / `[default,team]`）+ 真实 fence**。
- **Controller 模式随机**：
  - none；
  - applied；
  - verify_fail：dispatch 时打开 webExec 端口 ⇒ receiver 返回 `unknown{accept_unverified}, woke:false`，即 C6 路径，并断言确实覆盖到了；
  - downgrade；
  - deferred。
- **扰动**：对端随机 silent（hub 截止）或 disconnect，router 随机 dispose，随机出现跨频道双持有者。
- **不变量**：
  - I1：每个收件人每轮 ≤1 个 deliver；
  - I2：applied+none+unknown = total = |results|，`woke` 计数一致；
  - I3：整体为 none ⇔ 每行都是 none；非 ambiguous 的 none 只可能来自已应答的接收方；未应答的行一定是 unknown；
  - I4：每张 ticket 的 `settleBroadcast` 恰好调用一次，且调用时 ticket 尚未结算；
  - I5：一小时内带唤醒预占的广播 ≤2（不退还 ⇒ 不可能突破）。

## 偏离与需要对齐的点

1. **错误码细节放在 `reason` 里，不用花括号后缀**：方案写的是 `E_XS_BAD_TARGET{channel}` / `{default}`；我实现为 `code:"E_XS_BAD_TARGET"` + `reason:"channel"|"default"`。这是为了对齐 CH4 sender 已经按 `reason:"default"` 写好的映射（见 CH4-report），也因为花括号后缀在线上从未真正使用（`E_XS_OFF{hub}` 只出现在注释里）。
2. **hub 侧没有直接 import `src/fabric/xs/{channel,types-channel}.ts`**：`tests/web-hub/boundary.test.ts` 不允许 hub 从 {protocol,hub} 以外导入，type-only 也不行。处理方式：
   - 频道纯函数在 `members.ts` 镜像一份，`xs-channel-hub.test.ts` 用语料逐项断言与 `channel.ts` 等价；
   - `XsLimitsBroadcast` 等端口类型在 `limits.ts` 按结构逐字段复制；`xs-broadcast.test.ts` 把实现赋给 CH0 冻结的 `XsLimitsBroadcast` 类型。测试目录不在 `npm run typecheck` 范围内，这条另用临时 tsconfig 跑 `tsc` 验证通过。
3. **hub 复核的取值范围比 §6.4 宽**：`crossSession.channels` 接受 maxRecipients 1..32、wakeMaxRecipients 0..4，而 §6.4 是 2..32 / 1..4。原因是 agent 侧 `hubCrossSessionConfig` 现有的 clamp 是 1..32 / 0..4，不放宽会把合法下发的值整体丢掉。0 只会让唤醒更严。
4. **聚合在「全部 unknown」时不写 `partial`**：方案原文是「否则 unknown{partial}」，我只对混合情况写 partial。
5. **未加入的请求方 list/resolve 不再可见任何人**（C4 封闭）：这对 v0.7.1 旧 agent 未加入时的发现能力是一处收紧，因此改了 xs-router.test.ts 的一个旧断言，并排除在差分等价面之外。
6. `channels` op 的人数按逻辑会话（去重 sessionId）计。

## 遗留和他包事项

- **`tests/web-hub/boundary.test.ts` 有 1 个用例失败，原因在 CH0**：CH0 的 `src/config/settings.ts` 新增了值导入 `../fabric/xs/channel.js`，而 `SYSLOAD_FILE_CLOSURE` 钉死的导入集合没有它。这个文件不在 CH1 文件域，也不在本次指定的自验集合里，所以我没改。需要 CH0 或装配包决定：更新闭包表，把 `src/fabric/xs/channel.ts` 和它的闭包加进 allowlist。
- **property 测试依赖 CH3 在途代码**：用到 `XsMembership.join(channels)`、`XsReceiver` 的 `hubChannelCap`/`via`/`bc` 复核。CH3 若改签名，需要同步改这个测试。

## 自验

```
npx vitest run tests/web-hub/hub tests/web-hub/protocol tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-reply.test.ts --maxWorkers=3
 Test Files  236 passed (236)
      Tests  6033 passed | 3 skipped (6036)
   Duration  168.43s

npx vitest run tests/web-hub/agent tests/fabric/legacy-xs-v071-fixture.test.ts tests/fabric/xs-channel.test.ts --maxWorkers=3
 Test Files  86 passed (86)
      Tests  1544 passed (1544)

npm run typecheck   → exit 0（tsc ×2 + vue-tsc；当前他包在途文件也无报错）
npx prettier --check <改动文件>   → All matched files use Prettier code style!
```

- 三份 off golden 与 `tests/fixtures/legacy-xs-v071/` 未改动，`git status` 中没有这些路径。
- 未 commit。
