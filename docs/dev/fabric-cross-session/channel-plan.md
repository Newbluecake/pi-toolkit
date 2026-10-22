# fabric 跨会话：频道（channel）+ 收信箱未读提示，实施方案（r3）

> 车道：**L3**（跨进程协议要加字段和新 op、hub 扇出、多处授权关口、web 投影都要改）。
> 前置：phase2（XS0…X5、XW）与 reply（RX0…RX7、M、MW）已全部合入 dev（v0.7.1）。本文是 `phase2-plan.md` 和 `reply-plan.md` 的增量设计，凡未提及处均沿用它们的正文、r3 裁定和 2026-10-22 拍板。
> 坐标：文中所有 `文件:行` 都对照 dev@24b6b2f0 核实过。
> 评审：r1 被异源评审打回（2 Blocker、8 Major、6 Minor，共 16 项），处置见文末「§R1 评审处置」；r2 复审仍打回（0 Blocker、3 Major、3 Minor、1 Nit，全部集中在 §12 和兼容证明），处置见「§R2 复审处置」。用户拍板见 §0。
>
> **r3 的变化**：①§12 收信箱按主会话裁定，从「结构派生精确未读」**简化为事件计数**：宿主写出时 +1，一轮完成且该轮开始晚于写出时清零；计数存放在进程级全局里，跨 /reload 保留，进程重启后归零；删除 pending、扫描预算和 degraded。②§9.4 兼容证明改为「三角锚定」：reply-off golden 锚定 agent 侧形状，冻结的 v0.7.1 router 差分锚定 hub 侧帧，并给出确定性输入与规范化清单。③统计口径修正。
>
> **r2 的三处最大变化**（第 2 条已被 r3 的 §12 取代）
>
> 1. **默认频道兼容表冻结为一张写出规则表**（§3.2）。只在 `#default` 时，`via`、`rows.channels`、广播限额键、`status.xs.channels` 一律不写；例外只有 caps、工具表和 n>0 时的未读字段。兼容性改用**真实 activate 路径**做对照测试来证明，同时引入一个冻结的 v0.7.1 旧 hub 副本作为测试夹具（§9.4）。
> 2. **未读改为「结构派生 + 本进程已读集合」**（§12）。模型已读的判定是：消息进入了某一轮的上下文投影（每个 `turn_start`，包括首轮），或者在循环里作为本轮消息被发出（`message_end`）。compaction 不再清零任何东西；重建时也不再遇到 compaction 就停止扫描。观察点从「装饰 inbox.accept」改为「宿主写出 tap」，这是唯一的入口。
> 3. **能砍就砍**：广播唤醒预占**永不退还**；广播唤醒的人数和频率改为硬上限（只能调严）；去掉 `/agent status` 里的广播用量显示；参数补全只读缓存；侧栏筛选不做持久化。

---

## 0. 用户拍板（2026-10-22）

| #   | 结论                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 默认频道名为 `#default`（常量，不提供设置项）                                                                                                                                                                                                                           |
| Q2  | **`#default` 不能广播**（这是产品限制，不是兼容所需）                                                                                                                                                                                                                   |
| Q3  | `/fabric join #a` **不会**隐式加入 default。语义写死见 §2.2：join 是**增量**加入；从未加入的状态 `join #a` ⇒ 只在 `#a`；已在 `#default` 的会话 `join #a` ⇒ `[default,a]`，命令回显会明确提示「仍在 #default，与所有默认频道会话互通；如需隔离：/fabric leave #default」 |
| Q4  | **失去共享频道后回复不再送达**（失败关闭）。接收端在 stage 3、reserve 之前拒收，凭证**不会被消费**：如果截止前双方重新共享频道，B 重发同一条回复仍可被接收；否则 A 到期收到超时通知                                                                                     |
| Q5  | 广播唤醒需要同时满足：层级 0、发送方本地 `hopAllowed(level)`、≤4 人、每小时 ≤2 次、按人头计入出站唤醒配额。**4 人与 2 次/小时是硬上限**：设置只能调严（§6.4），工具描述可以如实写死                                                                                     |
| Q6  | `channels.enabled` 默认 **true**（接受工具表一次性变化）                                                                                                                                                                                                                |
| Q7  | 可以列出 hub 上所有频道的名字和人数（`op:"channels"`）                                                                                                                                                                                                                  |
| Q8  | 频道上限固定为 4（线上 schema 常量）                                                                                                                                                                                                                                    |
| Q9  | `@#频道` 广播本期不做                                                                                                                                                                                                                                                   |
| Q10 | 收信箱：**模型处理后自动清零；计入所有跨会话来信；只显示数量**。r3 主会话裁定的实现口径：一轮模型回合**完成**（turn_end）且该轮开始晚于来信写出 ⇒ 清零（§12.3）。这是近似，残留见 §12.8。NQ1（被摘要的来信等模型带摘要回应一轮后清零）已拍板，由这条规则自然满足        |

---

## 一页决策摘要（给用户）

**做什么**

1. **频道 = 通信范围**
   - 会话通过人工 `/fabric join #a #b` 增量加入命名频道，最多 4 个。
   - 发现（`list_sessions`、@ 补全）和寻址（`message_session`、`@会话`、`/fabric block` 的解析）只覆盖与我至少共享一个频道的会话，范围取并集。
2. **默认频道 `#default`**
   - 不带参数的 `/fabric join` 和 `autoJoin` 都加入它，等价于现在的行为。
   - 只在 `#default` 时，线上帧、持久化 entry 和 status 投影与现在**逐字节相同**（§3.2 写出规则表）。
   - 旧 agent 在新 hub 上视为 `#default` 成员。
3. **频道广播 `message_channel{channel,text,wake?}`**
   - hub 侧扇出，按人头准入，配额不够就整体拒绝。
   - 默认只投递；`wake:true` 的条件见 Q5，唤醒预占**永不退还**。
   - 不支持 expectReply；接收方的 receive 模式照常生效；`#default` 不能广播。
4. **治理**
   - 频道成员关系只能由人修改：本地 TUI、RPC 和 web（受 `webCommandPolicy.fabric` 控制）都可以；飞书硬拒；agent 没有任何途径。
   - hub 在 list/resolve/send/broadcast 四处强制同频道，且**唯一持有者判定先于可见性过滤**。
   - 接收端 stage 3 与 block 在同一关口，按 hub 盖章的 `via`/`bc` 再复核一次。
   - 连接旧 hub 时，本地按「链路有效频道」做门禁，失败关闭。
5. **web**
   - 卡片显示频道 chip（只在 default 时不显示）。
   - 侧栏增加频道筛选（内存态）。
   - @ 面板只列同频道会话。
   - 广播在转录里显示为 `#team · broadcast`。
   - `/fabric` 补全只用缓存的频道名。
6. **收信箱未读**
   - 每成功写出一条跨会话来信就 +1（主动消息、回复、迟到回复、通知、广播全部计入）；一轮模型回合完成、且该轮开始晚于写出时清零。这是 UX 近似，宁可提前清零，也不会永不清零。
   - 不展示内容。
   - TUI 显示 `inbox 3`，web 卡片与详情头部显示角标，`/fabric status` 加一行。

**不做**

- 跨 hub 频道、频道 ACL 或邀请制、频道历史。
- agent 用的 join 工具；广播带回复；`@#频道`；子 agent 参与。
- 未读内容预览；广播用量仪表（hub 不提供权威用量，§6.3）。

**关键取舍**

- 扇出放在 hub：一次准入、全有或全无，8s 截止不变。
- 频道变更会 bump epoch，并且 list/resolve 在 await 之后复核 epoch（§4.5）。
- 关闭频道（`channels.enabled=false`）时，已保存的命名频道被**挂起**而不是折叠成 default（§2.3）。
- 未读用事件计数（写出 +1、回合完成清零），存放在进程级全局里，跨 /reload 保留，进程重启后归零（§12）。

**风险**

1. 广播放大：靠人头计费、16 人上限和硬唤醒上限兜住。
2. 旧 hub 上，命名频道专属会话会失去所有跨会话能力：这是失败关闭，需要 `/webhub restart`。
3. 未读依赖「扩展 turn_end 晚于 assistant 持久化」与「每轮都会发 turn_start」这两条 pi 顺序事实，用 C-X10 锁定；不成立时以 agent_end 兜底。
4. 频道名不是秘密。

**规模**：13 个包，约 **15.5 人日**，关键路径约 **7 天**。UI 包在契约冻结后就能并行；未读这条线可以独立先发。

---

## 1. 现状与差距（对照代码核实）

| #   | 位置                                                                                                            | 现状                                                                                                                                                                                                                                                                                                                             | 差距                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| C1  | `src/fabric/xs/membership.ts:43-51,184-195,284-294`                                                             | entry 为 `{v:1,sessionId,joined,receive,receivePref?,blocked,joinedAt?}`；旧读者只读已知字段（`:73-110`）                                                                                                                                                                                                                        | 缺频道集合；可以复用 receivePref 的「多余字段无害 + 失败关闭」写法                   |
| C2  | `src/web-hub/protocol/xs.ts:212-232,250-286,350-388,437-454`                                                    | 所有 xs 帧和 `XsStatus` 都是 `additionalProperties:false`；`op` 是四值字面量联合                                                                                                                                                                                                                                                 | 新字段和新 op 必须 cap 门控                                                          |
| C3  | `src/web-hub/hub/xs/router.ts:131-162`                                                                          | resolve 先建 pool，再按 sessionId 分组判断重复持有者                                                                                                                                                                                                                                                                             | 频道过滤必须放到重复持有者判定之后（评审 #5）                                        |
| C4  | `src/web-hub/hub/xs/router.ts:208-215,254`                                                                      | origin 校验只有 send 要求 `self.joined`；未加入的会话也能 list/resolve                                                                                                                                                                                                                                                           | 旧 hub 上不能只靠 `joined:false` 封闭发现（评审 #3）                                 |
| C5  | `src/web-hub/hub/xs/limits.ts:154-196`                                                                          | reply 只**跳过** pair interval 检查，仍会更新时间戳；`settle` 对 `acked ∧ woke:false` 退还 wake 预占                                                                                                                                                                                                                             | `woke:false` 不能证明没有唤醒（见 C6）                                               |
| C6  | `src/fabric/xs/receiver.ts:391-405`                                                                             | Controller 已 dispatch 后，verify 失败返回 `unknown{accept_unverified}, woke:false`                                                                                                                                                                                                                                              | 按 woke 退额度会突破配额（评审 #6）                                                  |
| C7  | `src/fabric/xs/sender.ts:355-373,470-479`                                                                       | list 在 await 之后**有意**保留旧 rows；message 的 wake 走 `hopAllowed`                                                                                                                                                                                                                                                           | epoch 作废没闭合（评审 #10）；广播必须同样走 hopAllowed（评审 #7）                   |
| C8  | `src/stack.ts:1704-1710,1817`；`src/fabric/root-wake.ts:301-314`                                                | receiver 与 Controller 共用 stack 的 `host.sendMessage`；NoticeGate 的 quiet 写出走另一个 host；Controller 的 details 只转发固定字段                                                                                                                                                                                             | 未读的唯一观察点 = 这两处宿主写出（评审 #9）；`bc` 需要贯通 Controller（评审 #14）   |
| C9  | `src/fabric/xs/render.ts:47-72`；`src/web-hub/ui/src/logic/xsMessage.ts:42-67`；`TxCustom.vue:53-70`            | 人可见的渲染只有 wake/deliver/reply/late-reply 四种 kind                                                                                                                                                                                                                                                                         | 缺 broadcast/channel 展示（评审 #14）                                                |
| C10 | `src/stack.ts:1894-1900`；`src/fabric/xs/directory.ts:145-159`；`router.ts:278-279`                             | 目录 key 只包含本地 sessionId 和 epoch；list 截断到 20 行                                                                                                                                                                                                                                                                        | 裸名唯一只是缓存内唯一（RR8），截断时不能声称唯一（评审 #11）                        |
| C11 | `src/web-hub/agent/command-complete.ts:9-12`；`src/commands/fabric-xs.ts:117-159`                               | S-own completer 必须是纯函数；现有 `/fabric` completer 只读本地状态                                                                                                                                                                                                                                                              | 补全不能触发刷新（评审 #15）                                                         |
| C12 | pi 1.3 `agent-session.js:1392-1409,1848-1868`；`pi-agent-core/dist/agent-loop.js:43-55,113-121`                 | `_startRun` 先把会话置为 active，`_prepareRun`（含 before_agent_start）结束后 **flush 排队的 custom 消息**，然后才开始 loop；loop 中**每一轮（包括首轮）**都会发 `turn_start`；首轮的 trigger 消息在 turn_start **之后**以 `message_start/end` 进入上下文；streaming 时 quiet 消息在扩展的 turn_end 之后、before_settle 时 flush | r3：以「回合开始晚于写出」+「回合完成」作为清零条件，可覆盖首轮之前的 flush（§12.3） |
| C13 | pi `session-manager.js:194-228`（`buildContextEntries`）；`ReadonlySessionManager` 暴露 `buildContextEntries()` | 上下文 = 最新 compaction + 从 `firstKeptEntryId` 起保留的条目（可能位于 compaction entry 之前）+ compaction 之后的条目                                                                                                                                                                                                           | r3：compaction 不单独清零，统一等之后的回合完成（§12.3）                             |

---

## 2. 数据模型

### 2.1 频道名

- 规范形式：`^[a-z0-9][a-z0-9_-]{0,31}$`。
  - 输入可带或不带 `#`；`#` 剥掉，ASCII 大写转小写，非 ASCII 字符拒绝（防止同形字伪造）。
  - 展示一律写成 `#name`。
- 默认频道：`default`（常量 `XS_DEFAULT_CHANNEL`）。
- 保留名（不可加入）：`all`、`everyone`、`here`、`none`、`root`、`system`、`main`、`hub`、`session`、`xs`，以及 `pi-` 前缀。
- 纯函数模块：新建 `src/fabric/xs/channel.ts`（pi-free），提供 `normalizeChannel`、`channelSet`（去重、排序，default 排最前）、`intersect`、`XS_MAX_CHANNELS = 4`。
  - 频道名正则由 `protocol/xs.ts` 导出，hub 与 agent 共用。
  - UI 维护一份镜像常量，同 `SESSION_REF_LEN` 的先例。
- 上限 4 的理由：①并集与索引成本为 O(成员×4)；②帧和投影大小有界；③卡片宽度放得下；④广播面和审计面有界。

### 2.2 成员—频道关系与命令语义（Q3 写死）

`XsMembership` 内部状态由布尔值 `joinedState` 改为 `channelPref: string[]`。这是**偏好集合**，即落盘的集合。

| 操作                    | 语义                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/fabric join`（无参）  | `pref ∪= {default}`（与现在等价）                                                                                                                    |
| `/fabric join #a #b`    | `pref ∪= {a,b}`，**增量**，不碰 default；合并后超过 4 个、名称非法或命中保留名 ⇒ 整条拒绝，不部分生效                                                |
| `/fabric leave`（无参） | `pref = ∅`，包括挂起的频道（§2.3）                                                                                                                   |
| `/fabric leave #a`      | `pref −= {a}`；`/fabric leave #default` 是从默认频道隔离出去的唯一方式                                                                               |
| 回显                    | 每次变更都打印结果集合；如果结果同时包含 default 和命名频道，追加一行：「仍在 #default（与所有默认频道会话互通）；如需隔离：/fabric leave #default」 |

- 集合有变化 ⇒ bump epoch（与 join/leave 同一个计数器，`membership.ts:164-182`）；没有变化 ⇒ `already_joined` / `not_joined`。
- 只要涉及命名频道（join 或 leave 带参数），在 `channels.enabled=false` 时一律拒绝：「频道功能未启用」。

### 2.3 有效集合（同一个纯函数在三处使用）

```ts
effectiveChannels(pref, enabled)      = enabled ? pref : pref ∩ {default}            // 本地有效
linkChannels(pref, enabled, hubCap)   = hubCap ? effectiveChannels(pref, enabled)
                                               : effectiveChannels(pref, enabled) ∩ {default}   // 当前 hub 链路上的有效集合
joined ⇔ effectiveChannels(...) ≠ ∅       linkJoined ⇔ linkChannels(...) ≠ ∅
```

| 场景                                                          | 规则                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.enabled=false`，pref 中有命名频道（评审 #4）        | 命名频道被**挂起**：不生效、不上线、不可达；pref 原样保留在 entry 中（只要用户不修改，就不改写）。`/fabric status` 显示 `channels suspended #a (channels.enabled=false)`；重新启用并 `/reload` 后自动恢复。**绝不折叠成 default 来放宽范围** |
| receiver stage 3、sender 本地门禁、目录 `view()`、status 投影 | 一律读 `linkChannels` / `linkJoined`（评审 #3）。连接旧 hub 时，只在 `#a` 的会话 ⇒ `linkJoined=false` ⇒ list/resolve/send/block 解析在本地返回 `not_joined{hub-cap}`，不发帧；mention 原样放行；UI 角标显示为未加入                          |
| `member()`（`stack.ts:1907`）与 `publishMember`               | 写出 `effectiveChannels`；旧 hub 的降级交给 slotFlush（§3.2）                                                                                                                                                                                |

### 2.4 持久化

| pref        | entry 写出                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `∅`         | `{…, joined:false}`（与现在相同）                                                                     |
| `[default]` | `{…, joined:true}`，**不写 `channels`**（与 reply-off golden 的 `membershipEntry` 逐字节相同）        |
| 其他        | `{…, joined: pref ∋ default, channels:[…pref]}`。旧插件只认 `joined`，最多恢复到 `#default`，失败关闭 |

- 读回：`channels` 是合法数组 ⇒ 以它为准（逐项规范化，截断到 4 个）；否则 `joined ⇒ [default]`。
- fork 时 sessionId 不一致，不继承（P10）。
- autoJoin：`fabric.crossSession.autoJoin:true` ⇒ `join(channels.autoJoin)`，默认 `["default"]`；配置项**全部非法**时不自动加入，并在 status 里提示。

### 2.5 hub 端

- `XsMemberRecord` 增加 `channels`：帧里有就规范化后使用，否则 `joined ? ["default"] : []`。
- `XsEffectiveMember.channelCapable = caps ∋ xs.channel.v1`。
- 不建倒排索引：有效成员一般是同机几十个，线性过滤即可。

---

## 3. 协议（只加 cap 与可选字段，不升 PROTO）

### 3.1 能力位与 HubConfig（评审 #4：关闭契约）

- **hub cap `xs.channel.v1`**：`HubConfig.crossSession` 存在即宣告。频道是 hub 的协议能力，不由某一个 agent 开关决定；**不设 hub 级关闭键**（删除 r1 中 `!== false` 的写法）。
- **`HubConfig.crossSession.channels?: {maxRecipients, wakeMaxRecipients}`**：只承载 hub 全局参数。
  - spawner 在 `channels.enabled=true` 时写入；
  - 缺失 ⇒ hub 使用默认值（16 / 4）；
  - **缺失永远不表示关闭**；
  - `hub/main.ts` 复核时，非法值丢弃整个子键并回落默认值。
  - reply-off golden 的 `hubConfig` 来自没有频道端口的桥接，不写这个键，因此不变。
- **agent cap `xs.channel.v1`**：`xsOn ∧ channels.enabled`。
  - 关闭频道的 agent ≡ 旧 agent：不宣告 cap，不注册频道工具，命名频道挂起，线上一律旧形状。
- **未读**：不新增 cap，使用顶层开放字段（§12.6）。

### 3.2 默认频道兼容表（评审 #1，冻结；实现与测试都以此为准）

「只在 default」指本地 `effectiveChannels === [default]`；`via` 与 `rows.channels` 看的是「共享集合 === [default]」。

| 写出点                                             | default-only / 共享集合 = [default]                                                                                                        | 含命名频道                            | hub 无 cap（旧 hub）                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `xs_member.channels`                               | **不写**                                                                                                                                   | 写 `effectiveChannels`                | slotFlush 删除，`joined ← linkJoined`           |
| `xs_member.limits` 广播三键                        | **不写**（default 不能广播，用不到）                                                                                                       | 写入                                  | slotFlush 删除                                  |
| `xs_deliver.via`                                   | **不写**（接收端按缺失 = `[default]` 处理）                                                                                                | 目标 `channelCapable` 时写共享集合    | —（旧 hub 不写）                                |
| `xs_deliver.bc`                                    | —（default 不能广播）                                                                                                                      | 广播时写                              | —                                               |
| `xs_res.rows[].channels` / `candidates[].channels` | **不写**                                                                                                                                   | 请求方 `channelCapable` 时写共享集合  | —                                               |
| `StatusInfo.xs.channels`                           | **不写**                                                                                                                                   | 写入                                  | status slotFlush 删除，`xs.joined ← linkJoined` |
| membership entry                                   | 与现在逐字节相同                                                                                                                           | `joined: pref∋default` + `channels`   | 同左（entry 与 hub 无关）                       |
| `formatXsMessage`                                  | 与现在逐字节相同                                                                                                                           | 只有广播在头部追加 `channel` / `kind` | —                                               |
| **例外**（已知、一次性）                           | agent/hub caps 加 `xs.channel.v1`；工具表加 `message_channel`；`list_sessions` 多一个 `channel` 参数；未读 n>0 时出现 `StatusInfo.xsInbox` | 同左                                  | 同左                                            |

**证明方式**：保留三份 golden，**不把它们当作开启路径的证据**，另见 §9.4。

### 3.3 字段与新 op（全部可选；只有确认对端声明了 `xs.channel.v1` 才写入）

| 帧                   | 新增                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xs_member`          | `channels?: string[]`（maxItems 4）；`limits` 增加可选键 `broadcastsOutPerHour`(0..60)、`broadcastMinIntervalMs`(10 000..3 600 000)、`broadcastWakesOutPerHour`(0..**2**)。hub clamp 对缺失的键取**下界**（0 = 不能广播） |
| `xs_req`             | `op` 增加 `"broadcast"`、`"channels"`；新字段 `channel?: string`（broadcast 必填；作为 list 过滤可选）                                                                                                                    |
| `xs_res`             | `rows[].channels?`、`candidates[].channels?`、`fanout?: {total,applied,none,unknown,woke}`、`results?: [{ref,name?,effect,reason?,wakeDowngraded?,woke}]`（≤32）、`channels?: [{name,members,joined}]`（≤32）             |
| `xs_deliver`         | `via?: string[]`、`bc?: {channel}`                                                                                                                                                                                        |
| `XsStatusSchema`     | `channels?: string[]`                                                                                                                                                                                                     |
| `XS_REQ_DEADLINE_MS` | `broadcast: 8000`、`channels: 3000`                                                                                                                                                                                       |

16 KiB 预算：广播 `xs_res` 最坏 32×160 B ≈ 5 KiB；`xs_deliver` 的 `via`/`bc` 最坏约 150 B；hub 最坏形状预检（`router.ts:337`）要把它们算进去。

### 3.4 新旧互通矩阵

| 组合                                | 结果                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 agent（default-only）× 任意 hub  | 线上逐字节等同旧 agent（只多 cap）                                                                                                                                                                                                 |
| 新 agent（`[a]`）× **旧 hub**       | `linkJoined=false`：hub 视为未加入；本地对 list/resolve/send/block/mention 全部门禁（§2.3）；`message_channel` 返回 `channel_unsupported`；status 显示 `channels #a (hub-cap off: not joined on this hub)`；提示 `/webhub restart` |
| 新 agent（`[default,a]`）× 旧 hub   | `linkChannels=[default]`：按默认频道互通，`#a` 不生效，status 中说明                                                                                                                                                               |
| 旧 agent × 新 hub                   | 视为 `[default]`；不会收到 `via`/`bc`/广播                                                                                                                                                                                         |
| 新 hub，两端都旧                    | hub 不写任何新字段                                                                                                                                                                                                                 |
| 新接收方收到不带 `via`/`bc` 的投递  | 按 `[default]` 判定（§4.4）                                                                                                                                                                                                        |
| `channels.enabled=false` 的新 agent | 等同旧 agent；已保存的命名频道挂起（§2.3）                                                                                                                                                                                         |

---

## 4. 发现与寻址

### 4.1 hub 关口（`router.ts`）：先判唯一持有者，再判可见性（评审 #5）

```
holders(sid) = 全部有效 ∧ joined 成员中 sessionId === sid 的记录       // 不看频道、receive、cap
visible(m)   = shares(self, m)   // 共享频道 ≠ ∅
```

- **resolve 与 send**（`:118-170`、`:301-339`）：
  1. 按原层级在「可见成员」上找命中的 sessionId 集合；
  2. 对每个命中的 sid，用 `holders(sid)` 判断重复：`>1` ⇒ `E_XS_AMBIGUOUS`（候选只包含可见持有者的 ref/name，不暴露不可见持有者的其他信息）；
  3. 没有任何可见命中 ⇒ `E_XS_NO_TARGET`。
  4. reply 的精确 sessionId 分支走同一套规则（Q4：不可见 ⇒ NO_TARGET）。
  5. `build()` 在写出 `via` 时遵守 §3.2。
- **list**（`:233-263`）：在原有过滤上加 `visible`；`frame.channel` 存在 ⇒ 要求 `channel ∈ self.channels` 且 `m.channels ∋ channel`。行的 `channels` 遵守 §3.2。
- **channels**（新）：调用方必须是有效成员；计入 `listPerMin`；返回 hub 上所有有效 joined 成员的频道名和人数（≤32 个，Q7），并标出自己已加入的频道。
- **broadcast**：见 §5。

### 4.2 重名

名称解析层级不变，只是池子缩小到可见并集；同名时返回候选，由调用方改用 ref。`message_session` 不加 `channel` 限定参数。

### 4.3 @会话（评审 #11：收窄承诺）

- 目录数据 = hub list 投影，已按频道过滤；频道变化 ⇒ 本地 epoch bump ⇒ 缓存清空。
- **但他人换频道不会清空本地缓存**：裸名的唯一性只是「最近一次目录快照内唯一」，沿用 reply 的 RR8，10 分钟后过期。
- 发送时，hub 会对缓存选出的 ref 做权威解析：对方已不再共享频道 ⇒ `NO_TARGET`，不会发错对象。
- **截断规则**：list 返回正好 20 行（`XS_LIST_MAX_ROWS`）时，目录标记为 `truncated`，`lookupExact` 返回 undefined，裸名一律放行给 pi；显式的 `@session:<ref>` 不受影响。改动在 `directory.ts`，协议不变。
- 补全描述：`session · #a,#b · <cwd> · <receive> · <busy|idle>`；default-only 时与现在相同。

### 4.4 接收端复核（`receiver.ts` stage 3，与 `senderAllowed` 同一个关口，位于 reserve 之前）

```
chs = frame.bc ? [frame.bc.channel] : (frame.via ?? ["default"])
none{rejected} unless intersect(chs, linkChannels) ≠ ∅
```

### 4.5 epoch 作废与线性化点（评审 #10）

| 点                                                  | 规则                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发送端 list/resolve/channels（`sender.ts:355-373`） | await 之后复核 `(sessionId, epoch)`：变化 ⇒ `origin_changed`，**不返回旧 rows**。这条修正对 default-only 同样生效，删除 `:365` 的例外；不涉及线上格式                              |
| hub 准入                                            | 以准入时刻的成员表快照为准（同 phase2）                                                                                                                                            |
| 接收端                                              | **stage 3 是频道复核的线性化点**：本地 leave 发生在 stage 3 之前 ⇒ `none{rejected}`；发生在 dispatch 之后 ⇒ 效果已经产生，ack 保留 `applied`/`unknown`，**不承诺回滚**（同 r3 M2） |
| 发送后本端 leave                                    | 远端结果原样保留（同 r3 M2：未收到结果则为 `unknown{origin_changed_after_send}`）                                                                                                  |

---

## 5. 广播

### 5.1 为什么在 hub 扇出

- agent 侧循环需要 N 次往返，会被 `sendsOutPerMin` / pair 间隔限流成部分送达，而且 list 与 send 之间成员可能变化。
- hub 扇出只需一次准入（全有或全无），N 个 `xs_deliver` 并行（每个 5s），回复约 5.1s，落在 8s 之内，结果一次聚合。
- 注意：「全有或全无」只针对**发送方和 hub 的配额准入**；各接收方的 block / allowFrom / fence / inbox 仍然各自决定，因此部分失败的回执是必要的。

### 5.2 hub 流程（新文件 `src/web-hub/hub/xs/broadcast.ts`）

1. **前置检查**：origin 绑定；`self.joined`；`channel` 合法 ∧ ∈ `self.channels`，否则 `E_XS_BAD_TARGET{channel}`；`channel === default` ⇒ `E_XS_BAD_TARGET{default}`（Q2）；`text` 非空。
2. **收件会话集合 S**（**单位 = 逻辑会话，即不同的 sessionId**）：
   - 先取候选成员：有效 ∧ joined ∧ `m.channels ∋ channel` ∧ `m.channelCapable` ∧ `receive ∉ {off,replies}` ∧ sessionId ≠ self.sessionId ∧ agentKey ≠ self.agentKey（**发送方不回环**）；
   - S = 这些候选成员的 sessionId 去重；
   - 对 S 中每个 sid 用 `holders(sid)` 判重（全表判定，与频道和 receive 无关，评审 #5）：`>1` ⇒ 结果行 `none{ambiguous}`，不投递。
   - **N = |S|**：ambiguous 行**计入** N，也计入配额，`applied + none + unknown = N`。
3. **规模检查**：`N = 0` ⇒ `{ok:true, effect:"none", reason:"no_recipients"}`；`N > maxRecipients` ⇒ `E_XS_FANOUT_TOO_LARGE`（none）。
4. **准入**（`limits.admitBroadcast`，全有或全无，不满足 ⇒ `none{reason}`，不消耗任何额度）：
   - `sendsOutPerMin/Hour` 与 `hubSendsPerMin` 的剩余量都 ≥ N；
   - `broadcastsOutPerHour` 剩余 ≥ 1；
   - 距上次广播 ≥ `broadcastMinIntervalMs`；
   - inFlight 占 1 格；
   - pair interval：**跳过检查，但对每个收件人更新时间戳**（与 reply 实际行为一致，`limits.ts:154-179`）。
5. **唤醒判定**（`wake:true` 时按顺序判定，任一不满足 ⇒ 整体降级为只投递，`wakeDowngraded` 取第一个不满足的原因）：
   1. `frame.level === 0`，否则 `level_limit`（frame 不带 level 视为发送方 wake 关闭，⇒ `sender_wake_disabled`）；
   2. `N ≤ wakeMaxRecipients`（硬上限 4），否则 `broadcast_wake_fanout`；
   3. `broadcastWakesOutPerHour` 剩余 ≥ 1（硬上限 2），否则 `broadcast_wake_rate`；
   4. `wakesOutPerHour` 剩余 ≥ N，否则 `outbound_wake_rate`；
   5. 都满足 ⇒ 预占 1 次广播唤醒 + N 次出站唤醒；然后逐个收件人检查 `pairWakesPerHour`，不足的那一行单独降级为 `pair_wake_rate`，**该行不预占出站唤醒**（在扇出之前判定，不存在退还）。
6. **投递**：每个收件人生成独立 xid，各调用一次 `registry.request(xs_deliver{bc, wake: row.wake, level})`；hub 从不重发。
7. **结算**（评审 #6，保守）：
   - 每行按 ack 或截止结算，截止 / 断链 / ack 不匹配 ⇒ `unknown`；
   - **广播的唤醒预占与发送计数一律不退还**（不论 `woke` 或 `effect` 是什么）；
   - 所有行结算后释放 inFlight。
8. **聚合**：`effect` 全部 applied ⇒ applied；全部 none ⇒ none；否则 `unknown{partial}`。审计记一行 `op:"broadcast"`，外加每个收件人一行 `op:"send", bcast:true`，不记正文。

**顺带修正（同一文件，保守方向）**：点对点 `settle` 的退款条件从 `acked ∧ woke:false` 收紧为 `acked ∧ woke:false ∧ effect ≠ "unknown"`（`limits.ts:188-196`），堵住 C6 的突破路径。效果：unknown 的唤醒预占不再退还。这一条单列在 CH1 的验收里（NQ2，用户已拍板收紧）。

### 5.3 接收端与展示

- **接收管道不新增 stage**：stage 3 按 `bc.channel` 复核；replies 模式拒收（unsolicited）；deliver ⇒ `receiver_policy`；栅栏 / goal / busy / `wakesInPerHour` / `recvPerHour` / `inboxCap` 不变。
- **level**：被唤醒 ⇒ `L+1 ≥ 1`，这个 run 无法再发起带唤醒的广播。
- **Controller 贯通（评审 #14）**：`RootWakeRequest` 增加 `bc?: {channel}`，`root-wake.ts:301-314` 把它写进 details；receiver 的 quiet 写出同样带 `details.bc`。details 不会进入 provider，由 C-X9 锁定。
- **模型可见文本**：`formatXsMessage` 带 `bc` 时，头部追加 `channel="#x" kind="broadcast"`；宿主说明区加一行：「这是频道广播；若需回应请用 message_session 发给 from.ref，不要用 message_channel 回应全频道。」无 `bc` 时输出逐字节不变。
- **人可见渲染**：
  - TUI：`render.ts` 的 `XsDisplayKind` 增加 `"broadcast"`，头部渲染为 `xs ← <from> · <cwd> · #team broadcast`，优先读 `details.bc`；
  - web：`logic/xsMessage.ts` 从**首行**解析 `kind="broadcast"` 与 `channel`（正文仍不可信），`TxCustom.vue` 显示 `#team · 广播`；
  - 无 `bc` 的路径输出不变。

### 5.4 至多一次

每个（广播，收件人）至多派发一次，由三点保证：hub 单次投递、接收端按 xid 去重、发送端没有重试路径。这**不是**请求级的幂等：模型重新调用工具就是一次新的广播。工具文本写明：unknown 或 partial 时不要重发；需要补发时，对 none 的 ref 单独用 message_session。

### 5.5 发送端（`sender.ts` 的 `broadcast()`，评审 #7）

- **守卫**：origin 快照与三处守卫与 `message()` 相同；await 之后复核 epoch（§4.5）。
- **本地预检**，不通过就不发帧：
  - `linkJoined`；
  - `channel` 合法、∈ `linkChannels`、不是 default；
  - hub 具备 cap；
  - 最坏形状的字节数不超限。
- **唤醒**：`wakeUsable = wake.enabled ∧ level.hopAllowed(levelOfRoot()) ∧ levelOfRoot() === 0`，与 `sender.ts:470-479` 同口径，**再加上** level 0 条件。不满足时本地降级为 `sender_wake_disabled` 或 `level_limit`，不带 `wake` 发出；满足时帧带 `level`，hub 再判一次，接收方照常执行自己的 maxLevel。
- **返回**：`{status, effect, reason?, channel, fanout?, results?, wakeDowngraded?}`。

---

## 6. 工具、命令与设置

### 6.1 `message_channel`（新文件 `src/tools/message-channel-tool.ts`）

schema 为 `{channel, text, wake?}`，`additionalProperties:false`，在 activate 时冻结。只在主会话、`xsOn ∧ channels.enabled` 时注册，子会话永不注册。wake 参数的描述按硬上限写死：「仅限人类发起的链，≤4 人，每小时 ≤2 次；否则只投递」。同名工具冲突检测并入 `detectXsToolCollisions`。

### 6.2 `list_sessions`

两个冻结实例：关闭频道时用 `ListSessionsParamsLegacy`（与现在逐字节相同）；开启时追加 `channel?`。行文本只在共享集合 ≠ [default] 时追加 `channels=#a,#b`。

### 6.3 `/fabric`（`commands/fabric-xs.ts`）

| 子命令                 | 行为                                                                                                                                                                                                  | 飞书 | web                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------- |
| `join` / `join #a…`    | §2.2                                                                                                                                                                                                  | 硬拒 | 策略门控（默认 allow）                       |
| `leave` / `leave #a…`  | §2.2                                                                                                                                                                                                  | 硬拒 | 同上                                         |
| `channels`（新，只读） | 列出本地 pref 和有效集合（含挂起频道），以及 hub 频道和人数（`op:"channels"`）；**它是补全缓存的唯一刷新入口之一**                                                                                    | 允许 | 受 `fabric` 整名 override 约束（基线 allow） |
| `status`               | 加一行 `channels #default #team (2/4) · hub-cap on · suspended -`；广播只显示有效配置 `broadcast ≤6/h · wake ≤2/h ≤4 rcpt · usage n/a`（评审 #16：hub 没有用量端口，不伪造数字）；另加 §12.6 的未读行 | 允许 | 同上                                         |

- `SUBS`、`USAGE`、`FABRIC_KNOWN_SUBS` 加入 `channels`；未知子命令仍 deny；prompt 文本拒绝的正则已经覆盖 `join … / leave …`。
- **参数补全只读本地缓存**（评审 #15，满足 S-own 纯函数约束）：
  - 候选来源 = 本地 pref ∪ 目录行中的频道 ∪ 最近一次 `channels` 结果；
  - 缓存只在以下时机刷新：`/fabric channels`、`/fabric status`、join/leave 成功之后（命令里非阻塞地发一次 `op:"channels"`）；
  - completer 本身不发起任何 I/O。

### 6.4 设置（non-live）

```jsonc
"fabric": { "crossSession": { "channels": {
  "enabled": true,                  // Q6
  "autoJoin": ["default"],
  "broadcast": {
    "outPerHour": 6,                // 0..60（随 xs_member 下发；0 = 禁止广播）
    "minIntervalS": 60,             // 10..3600
    "wakeOutPerHour": 2,            // 0..2（硬上限 2，Q5；只能调严）
    "maxRecipients": 16,            // 2..32（hub 全局，随 HubConfig）
    "wakeMaxRecipients": 4          // 1..4（硬上限 4，Q5；hub 全局）
  }
}}}
```

`parseFabricXsChannelSettings`：逐字段容错，从不抛错，越界值夹紧；旧配置的解析结果不变。

---

## 7. web

- **卡片**：`xsChannelsOf(agent, hubCaps)` 要求 hub caps ∋ `xs.channel.v1`；读 `status.xs.channels`，缺失时若 joined 则视为 `[default]`；只在集合 ≠ `[default]` 时渲染 chip。
- **侧栏筛选**（`AgentList.vue`）：存在非 default 频道时才出现 chip 行；选择保存在**组件内存**，不持久化（评审建议的 MVP）。
- **@ 面板**（`sessionMention.ts`）：hub 有 cap 时按共享频道过滤；这只是 UI 提示，权威判定在 hub。
- **转录**：广播渲染见 §5.3。
- **未读角标**：见 §12.6。

---

## 8. 安全

| 面             | 处置                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注入           | 频道名限定为小写 ASCII，消息头经 JSON 编码；正文在 nonce 围栏内；web 解析只读首行。这些都是卫生措施，不是权限隔离（XR3）                                                                                                                 |
| 广播放大       | 按人头计费、全有或全无；≤16 人；每小时 6 次、间隔 60s；hub 每分钟总量按 N 计。唤醒的**硬上界**：每个发送方每小时 ≤2 次广播唤醒 × ≤4 人，且只能来自 level 0 并通过 hopAllowed；预占不退还；被唤醒的 run（level ≥1）无法再发起带唤醒的广播 |
| 频道名伪造     | 频道是范围而不是凭证；拒绝非 ASCII；`via`/`bc` 只由 hub 根据成员表盖章                                                                                                                                                                   |
| 双持有者       | 唯一性在全表上判定（§4.1），不会因为频道过滤而绕过 XR5                                                                                                                                                                                   |
| agent 自加频道 | 不存在这样的工具                                                                                                                                                                                                                         |
| web/飞书       | web 受策略门控；飞书三层硬拒；不新增任何飞书通路                                                                                                                                                                                         |
| 枚举           | 不同频道的会话与不存在的会话不可区分（XI5）；`op:"channels"` 只给名字和人数（Q7 已拍板）                                                                                                                                                 |
| 旧 hub         | 本地按 `linkChannels` 门禁，失败关闭（§2.3）                                                                                                                                                                                             |

---

## 9. 测试计划

### 9.1 单测

| 包  | 要点                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CH0 | 名称规则；`effectiveChannels` / `linkChannels` 真值表；帧中新字段可选、旧形状仍能通过；设置夹紧（wakeOutPerHour 不能大于 2，wakeMaxRecipients 不能大于 4）                                                                                                                                                                              |
| CH1 | 同频道过滤；**跨频道双持有者 ⇒ AMBIGUOUS**（另有 off/replies、缺 cap 的双持有者变体）；不可见的精确 id ⇒ NO_TARGET；§3.2 中 hub 侧的不写规则；广播的 S 集合与 N 的计数单位；准入的每个拒绝原因；唤醒五步；**广播永不退还**；P2P 下 unknown 不退还（顺带修正）                                                                           |
| CH1 | `xs-broadcast.property.test.ts`：**使用真实 receiver 实例作为 ack 来源**（包含「Controller 已 dispatch 后 verify 失败 ⇒ `unknown + woke:false`」的路径）以及随机的截止/断链/dispose。不变量：每个收件人 `xs_deliver` ≤1；`applied+none+unknown = N`；整体为 none ⇔ 所有行都可证明 none；inFlight 恰好释放一次；广播唤醒窗口计数单调不减 |
| CH2 | slotFlush 按 §3.2 逐格测（新 hub / 旧 hub / 新→旧→新 的重放顺序）                                                                                                                                                                                                                                                                       |
| CH3 | entry 三种形状；挂起：保存 `[a]` → 关闭 → reload ⇒ 未加入、entry 不变 → 开启 → reload ⇒ `[a]`；增量 join 的回显；stage 3 的 `via`/`bc`/`linkChannels` 复核；Q4：无共享频道 ⇒ 不 reserve，重新共享后重发可被接收；broadcast 在 render 与 format 中的展示；Controller 转发 `bc`                                                           |
| CH4 | 广播的本地预检；**发送方 maxLevel=0 ⇒ 本地降级 `level_limit`**；list/resolve 在 await 后 epoch 变化 ⇒ `origin_changed`；两个 list 实例                                                                                                                                                                                                  |
| CH5 | 截断（正好 20 行）⇒ 裸名放行；可见并集内的唯一性                                                                                                                                                                                                                                                                                        |

### 9.2 集成（`tests/integration/fabric-xs-channel.test.ts`，复用 harness：真实 hub 子进程 + 3–5 个真实 stack）

1. A、B 在 `#a`，C 只在 default：A 的 list 只有 B；A→C 与 C→A 都是 NO_TARGET。
2. 并集：A 在 `[a,b]`，B 在 `[a]`，D 在 `[b]` ⇒ A 能看到 B 和 D，B 看不到 D。
3. 广播：fanout、自己不回环、deliver 模式降级、replies 模式不可见；level 0 时能唤醒；被唤醒的 run 再广播 wake ⇒ `level_limit`；发送方 `maxLevel=0` ⇒ 本地降级。
4. 限额：第 7 次/小时、间隔小于 60s、超过 16 人、default 广播，都被拒。
5. **线性化拆成两条**：(a) 接收方在 stage 3 之前已经 `leave #a`（让 B 先在本地 leave，再让 hub 投递在途帧）⇒ `none{rejected}`；(b) dispatch 之后、ack 回到发送方之前 leave ⇒ 发送方得到的是 applied/unknown，**不是 none**。
6. 跨频道双持有者 ⇒ AMBIGUOUS。
7. hub 重启、reload、fork（不继承）、挂起与恢复。

### 9.3 conformance（真实 pi + 本地 stub）

- **C-X9**：quiet 广播不起 run；带唤醒的广播触发的 run 能绑定 token，level = 1；`details.bc`/`via`/token 不进入 provider 请求体；`message_channel` 与 `list_sessions` 的 schema 在多次请求之间稳定。
- **C-X10**：见 §12.7（收缩为 pi 顺序事实）。
- pi peer 升级前，与 C-X1…C-X8、C-P1…C-P5、consult-preserve C1–C7 一起跑。

### 9.4 兼容证明（评审 B1、M1；复审 R2-5 三角锚定）

证明链分三条，不能只用新版代码自己和自己比：

1. **三份 off golden 不重新生成，也不修改**。它们锚定的是「xs 关闭、wake 关闭、reply 关闭 + 工厂/桥接默认路径」的旧形状。
2. **agent 侧锚定到旧基线**（新文件 `tests/integration/fabric-xs-channel-compat.test.ts`）。用真实 `activate()` + 真实 stack + 真实桥接（对端是假 hub socket，与 reply-off golden 的接线方式相同）采集：`hello`、slot 序列、`xs_member`、status 帧、membership entry、`formatXsMessage` 的固定样例。配置分四组：①`channels.enabled=true` 且 default-only；②`channels.enabled=false`；③④分别为 ①② 再加 `reply.enabled=false`。
   - **锚定**：③④ 规范化之后，与 `fabric-xs-reply-off-golden.json` 的 `wiring.memberFrame`、`wiring.statusFrame`、`wiring.slotSequence`、`membershipEntry`、`formatXsMessage` **逐字节相等**；`hello.caps` 在去掉恰好一个 `"xs.channel.v1"` 之后（只有 ③ 应该含它）与 golden 相等。
   - **对照**：① 与 ②、③ 与 ④ 之间逐字节相等（只有例外项不同）。
   - golden 在 v0.7.1 上通过，所以「与 golden 相等」就是「与 v0.7.1 相等」。
   - **等价面限定（R3-2）**：上述等价只覆盖帧形状、成员/状态投影与 list/resolve/send 的路由结果；**不覆盖** NQ2 已拍板的行为收紧（unknown ack 不再退还 wake 预占）——它是有意的差异，由 CH1 的定向断言单独验证：同一输入下 v0.7.1 夹具退还、当前实现不退还，且只在 `effect:"unknown"` 时出现差异。
3. **hub 侧差分锚定**（CH1：`tests/web-hub/hub/xs-router-v071-diff.test.ts`）：用 CH0 冻结的 `tests/fixtures/legacy-xs-v071/` router（`git show v0.7.1:` 原样复制，并记录来源提交 `c89a37d4` 和内容 sha256）与当前 router，在**同一份成员表**（全部 default-only、`channelCapable` 混合）、同一个固定 `now` 下，跑同一组 list / resolve（含歧义候选）/ send，比较产出的 `xs_res` 与 `xs_deliver`。规范化后逐字节相等。旧的薄 decoder 只用冻结的 `XS_*_FRAME_SCHEMAS`，**不导入**当前的 `messages.ts`。负对照：把带 `channels`/`via`/`bc` 的帧或新 op 交给夹具，断言会被拒绝。

**确定性输入**：

- `vi.setSystemTime(FIXED_NOW)`；
- membership 注入固定 clock，使用全新的 `XsEpochCounter`（`resetGlobals()`）；
- `buildInfo` 固定 pluginVersion/buildId；
- hub 侧 router 注入固定 `now`。

**规范化**（只替换值，**不删键、不排序**，所以掩盖不了多出来的 `via`/`limits` 键）：

- xid `x[0-9a-f]{18}` → `<xid>`；
- 围栏 nonce `<<<fab-r_[0-9A-HJKMNP-TV-Z]{8}` → `<<<fab-<nonce>`（与 golden 的 `normalizeFence` 相同）；
- uuid、agentId、tmp 路径、node 路径：沿用 golden 的 `normalize()`；
- 真实 sessionId 按首次出现的顺序映射为 golden 的 `sess-golden123456`（及 `<sid2>`…）；ref 取映射后的前缀；
- `epoch` 数值按首次出现映射为 golden 的数值序列。

**例外项（单独断言，不参与相等比较）**：

- agent/hub caps 中的 `xs.channel.v1`：断言出现条件；
- 工具表：另由 `message-channel-tool` / `list-sessions-tool` 测试断言 legacy 实例与 golden 相等；
- `StatusInfo.xsInbox`：采集发生在任何来信之前，所以字段不出现；另有用例断言它只在 n>0 时出现。

**旧 hub 行为**（CH2，`tests/web-hub/agent/xs-legacy-hub.test.ts`）：新 agent `[a]` 连接夹具组装的旧 hub 替身后，list/resolve/send/block/mention 全部在本地门禁、零帧发出；`[default,a]` 按 default 互通；不发出任何新形状的帧。

---

## 10. 分包（冻结面随修订更新）

规则沿用 phase2 §11.1：`src/stack.ts`、`src/index.ts` 只属于装配包，且串行。**CH0 冻结的不只是线上协议，还包括跨包消费的内部端口签名**（评审建议）：

- `XsChannelView`：`{pref(), effective(), link(hubCap), linkJoined}`；
- `XsUnreadTap`：§12.2 的 `written(id)`（宿主写出观察契约）；
- `RootWakeRequest.bc?`；
- `XsSender.broadcast()` 的返回类型；
- hub 侧 `admitBroadcast` 的签名。

| 包                          | 文件域（允许新建）                                                                                                                                                                                         | 冻结面                                  | 依赖                                                         | 验收                                                                                                  | 估时  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----- |
| **CH0** 契约                | `fabric/xs/channel.ts`（新）、`protocol/xs.ts`、`config/settings.ts`、内部端口类型（`fabric/xs/types-channel.ts`，新）；`tests/fixtures/legacy-xs-v071/`（新：v0.7.1 冻结副本 + README + 来源提交/sha256） | 三份 golden；旧帧形状；夹具内容永不修改 | —                                                            | §9.1 CH0；夹具 sha256 自检                                                                            | 1.75d |
| **CH1** hub                 | `hub/xs/{router,members,limits}.ts`、`hub/xs/broadcast.ts`（新）、`hub/{hub,main,audit}.ts`                                                                                                                | default 下 send/list/resolve 的行为     | CH0                                                          | §9.1 CH1 + property + §9.4-3 差分                                                                     | 2.5d  |
| **CH2** agent 连接          | `agent/xs.ts`、`agent/connection.ts`                                                                                                                                                                       | slot 顺序                               | CH0；与 IBP 串行（同文件）                                   | §9.1 CH2 + §9.4 旧 hub 行为                                                                           | 1.5d  |
| **CH3** 成员/接收/渲染/命令 | `fabric/xs/{membership,receiver,format,render}.ts`、`fabric/root-wake.ts`、`commands/fabric-xs.ts`、`agent/command-policy.ts`                                                                              | 原真值表；无 bc 时的 format/render 输出 | CH0                                                          | §9.1 CH3                                                                                              | 2.5d  |
| **CH4** 发送端与工具        | `fabric/xs/sender.ts`、`tools/list-sessions-tool.ts`、`tools/message-channel-tool.ts`（新）                                                                                                                | legacy 实例 = golden                    | CH0                                                          | §9.1 CH4                                                                                              | 1.5d  |
| **CH5** mention             | `fabric/xs/directory.ts`、`mention/{session,autocomplete}.ts`                                                                                                                                              | `parseMention` 不变                     | CH0                                                          | §9.1 CH5                                                                                              | 0.5d  |
| **CHU** web（纯部分）       | `ui/.../agents/{AgentCard.vue,agentCardModel.ts,AgentList.vue}`、`control/sessionMention.ts`、`logic/xsMessage.ts`、`transcript/TxCustom.vue`、i18n                                                        | 无 cap / 无字段时 UI 字节不变           | CH0；与 IBU 串行（同文件）                                   | UI 单测；真机验收放到 CH6                                                                             | 1.5d  |
| **IB1** 未读核心            | `fabric/xs/unread.ts`（新，pi-free：全局 bucket、序号、FIFO、清零规则）                                                                                                                                    | —                                       | 无（`XsUnreadTap` 类型可先放在本包，CH0 再引用；零共享文件） | §12.7 单测 + property                                                                                 | 0.5d  |
| **IBP** 未读投影            | `protocol/messages.ts`（`StatusInfo.xsInbox?`）、`agent/xs.ts`（`XsStackPort.unread?`）、`agent/index.ts`                                                                                                  | 无端口 ⇒ status 字节不变                | IB1；排在 CH2 之前                                           | `status-xs-inbox.test.ts`                                                                             | 0.5d  |
| **IBU** 未读 UI             | `AgentCard.vue`、`detail/DetailHeader.vue`                                                                                                                                                                 | 字段缺失 ⇒ 字节不变                     | IBP；排在 CHU 之前                                           | UI 单测                                                                                               | 0.5d  |
| **IBW** 未读装配            | `stack.ts`（两处宿主写出 tap）、`index.ts`（`turn_start` / `turn_end` / `agent_end` 转发，`setStatus`）、`commands/fabric-xs.ts`（status 行）；`tests/conformance/fabric-xs.test.ts`（C-X10）              | —                                       | IB1, IBP, CH3（同文件）                                      | §12.7 集成 + C-X10                                                                                    | 0.75d |
| **CHW** 装配                | `stack.ts`、`index.ts`（工具注册、channel 视图、autoJoin、目录、补全缓存刷新、`bc` 贯通）                                                                                                                  | —                                       | CH1–CH5, IBW                                                 | §9.2 1–7 + §9.4-2 agent 侧锚定                                                                        | 1d    |
| **CH6** 终局                | AGENTS.md、`tests/conformance/fabric-xs.test.ts`（C-X9；排在 IBW 的 C-X10 之后，串行）、`docs/dev/fabric-cross-session/channel-acceptance.md`（真机清单）                                                  | —                                       | CHW, CHU                                                     | C-X9；`format:check && typecheck && build && build:web && test && test:conformance`；三份 golden 不变 | 1d    |

**并行图**

```
CH0 → { CH1 ∥ CH3 ∥ CH4 ∥ CH5 ∥ (IBP → CH2) ∥ (IBU → CHU) }
IB1 ∥ CH0（零共享文件）
CH3 → IBW → CHW → CH6        （CHU 在 CH6 之前合入）
```

**工作量**：约 15.5 人日（r2 为 16，r1 为 15）。

- r3 减少：未读线从 3 人日降到 2.25 人日（删除结构派生、pending、扫描与 degraded）。
- r3 增加：v0.7.1 夹具前移到 CH0 并加 sha256 自检（+0.25）；hub 侧差分测试（并入 CH1，不另计）。

关键路径：CH0(1.75) → CH3(2.5) → IBW(0.75) → CHW(1) → CH6(1) ≈ **7 天**。

---

## 11. 风险与残留

| #   | 风险                                                                         | 处置                                                 |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| CR1 | 旧 hub 上命名频道专属会话失去所有跨会话能力                                  | 失败关闭；status 与工具文本提示 `/webhub restart`    |
| CR2 | 频道名不是秘密                                                               | 产品定位就是「范围」；需要隔离时配合 allowFrom/block |
| CR3 | partial 结果诱导模型重发                                                     | 工具文本明确写不要重发                               |
| CR4 | 频道变更使本会话正在进行的请求失效                                           | 人主动操作的代价，与 join/leave 一致                 |
| CR5 | 广播唤醒预占不退还，导致额度被保守地消耗                                     | 有意选择：以简单换取不可突破                         |
| CR6 | 裸名的唯一性只基于缓存（RR8 延续），他人换频道后最多 10 分钟内仍按旧快照判定 | hub 对选中的 ref 做权威解析；显式 ref 不受影响       |
| CR7 | `level === 0` 依赖发送方如实上报                                             | 同 uid 可信；接收端照常执行 maxLevel                 |

---

## 12. 收信箱未读提示（独立包 IB1/IBP/IBU/IBW；r3 简化为事件计数）

> **r3 主会话裁定**：收信箱是 UX 提示，**不是正确性不变量**。用户要的只是「有消息到达 + 数量」，允许近似。因此 r2 的「结构派生精确未读」（扫描 branch、投影判定、pending 晋升、degraded）**整体删除**，改为下面的事件计数模型。原则：**宁可偶尔提前清零，也不能永不清零**。

### 12.1 定义（用户语义不变）

| 项     | 内容                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计入   | 本会话经两个宿主写出口（§12.2）**成功写出**的每一条跨会话来信：主动消息（wake/deliver）、回复、迟到回复、超时/失效/离开期间汇总通知、频道广播                 |
| 不计入 | 树内 `message_agent`、本会话自己的工具结果、被拒收（effect:none）的消息                                                                                       |
| 清零   | 一轮模型回合**完成**（扩展 `turn_end`，在 assistant 持久化之后触发，见 §12.3），且该轮**开始**晚于这条消息的写出 ⇒ 清掉这条消息。也就是「模型处理后自动清零」 |
| 展示   | 只显示数量，不显示内容                                                                                                                                        |
| 已拍板 | 被压缩或摘要掉的来信**不单独清零**，等之后的一轮完成时清零。这就是 NQ1「模型带着摘要回应一轮后清零」，主会话按用户拍板裁定                                    |

### 12.2 计入点：宿主写出 tap（沿用 r2，契约收窄）

`src/stack.ts:1709` 是 receiver 与 Controller 共用的 host，NoticeGate 的唤醒也经 Controller 走这里；`:1817` 是 NoticeGate 的 quiet 写出（恢复失效通知、离开汇总也走这里）。复审已核实：在跨会话 receiver / Controller / NoticeGate 管道内，**只有这两个出口**。IBW 给这两个 lambda 各包一层：

```ts
// CH0 冻结（types-channel.ts）
interface XsUnreadTap {
  written(id: string): void;
}
// id = details.xid（receiver / Controller / 广播都有）；NoticeGate quiet 写出没有 xid ⇒ tap 自行合成 "n:" + seq（只在内存中，不写进 details）
```

- `pi.sendMessage` 同步抛错 ⇒ 不计入（可证明没有效果）；正常返回 ⇒ `written(id)`。
- 覆盖 dispatch 之后的 receiver_error 与 verify 失败：宿主调用已经发生，按「可能送达」计入，这是 UX 的保守方向。
- tap 只观察：内部异常一律吞掉，绝不改变投递结果或凭证消费；不依赖 receiver 的 verdict，也不碰 `XsInbox`。
- **不再需要**：pending、`triggerTurn` 或 `idleBefore` 分类、`details.nid`、Controller 的 idle/tombstone 通知端口。

### 12.3 清零点与 pi 时序事实（复审 R2-4）

| 事件                              | 动作                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| tap `written(id)`                 | `seq += 1`；记录 `{id, seq}`（同一 id 已存在则忽略，即去重）                                                                             |
| 扩展 `turn_start`（每轮，含首轮） | `seq += 1`；`turnStartSeq = seq`；`overflowEligible += overflowPending`，`overflowPending = 0`（§12.5）                                  |
| **扩展 `turn_end`**               | 若存在 `turnStartSeq`，清掉所有 `entry.seq < turnStartSeq` 的条目，以及整个 `overflowEligible`（§12.5）；然后 `turnStartSeq = undefined` |
| 扩展 `agent_end`（兜底）          | 与 turn_end 规则相同；覆盖 turn_end 因为异常没有触发的情况。规则幂等                                                                     |

**为什么选 `turn_end` 而不是 `message_end`**：

- pi 会先 await 扩展的 `message_end` 处理器，然后才 `appendMessage`（`agent-session.js:752-768,920-936`，复审 R2-4），所以在 message_end 里看不到刚结束的 assistant。
- `turn_end` 是 boundary 事件，由 `finishTurn` 派发，并携带**已经持久化**的 `messageEntryId`；pi 解析不到时会报错 "turn_end could not resolve the persisted assistant entry ID"（`agent-session.js` 中的 `_dispatchTurnEndBoundary`）。因此它晚于 assistant 的持久化。
- error/aborted 的回合同样经过 `finishTurn`，也会触发 turn_end。
- C-X10 锁定这一顺序（§12.7）。

**用单调序号而不是时间戳**：序号避免同一毫秒的先后歧义和时钟回拨。序号是进程级的，与 bucket 存放在一起（§12.4）。

**这条规则在主要路径上为什么正确**（每条都由 C-X10 或集成测试覆盖）：

| 路径                                                     | 结果                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| idle 时到达的 quiet 消息                                 | 写出序号 < 下一个 run 首轮的 turnStartSeq ⇒ 首轮完成时清零                              |
| before_agent_start 期间到达（startRun 在首轮之前 flush） | 写出 < 首轮开始 ⇒ 首轮完成时清零                                                        |
| Controller 唤醒的 trigger                                | tap 发生在 `sendMessage(triggerTurn:true)` 时，早于这个 run 的首轮开始 ⇒ 首轮完成时清零 |
| 忙时（turn k 中）到达、在 turn_end 时 flush              | 写出 > turn k 开始 ⇒ turn k 完成时**不**清零；turn k+1（或下一个 run）完成时清零        |
| before_settle 时 flush、之后没有下一轮                   | 保持计数，直到下一个 run 的某一轮完成                                                   |
| 被压缩保留或摘要                                         | 都等之后某一轮完成时清零（NQ1）                                                         |
| run 启动失败（没有任何回合）                             | 保持计数，直到真正有一轮完成。会话一直不跑模型时一直计数，这是正确语义                  |

### 12.4 存放、/reload 与重启（复审 R2-3）

| 选择                                                                                                                                                                                                        | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **进程级 `Symbol.for("pi-subagent:xs-unread")`**：`Map<sessionId, Bucket>`，最多 32 个会话，按 FIFO 淘汰最久未触碰的；`Bucket = {seq, turnStartSeq?, ids: Map<id, seq>, overflowPending, overflowEligible}` | 仓库先例：`xs-wake-ledger`、`xs-reply-ledger`、`xs-dedup`、`xs-epoch` 都用 `Symbol.for` 全局跨 `/reload` 保留状态，`/reload` 时不重建模块缓存。pi 的 reload（包括 SDK/RPC 在忙时触发的 reload）**保留**同一个 AgentSession 的 `_pendingCustomMessages`（`agent-session.js:2969-3002`），未读计数随全局一起保留，**两者一致**；队列稍后 flush 时虽然不会再经过 tap，但计数早在写出时就已计入。stack 重建时**不清空**（修正 r2 的漏计） |
| **不使用 session entry**                                                                                                                                                                                    | 每条来信写一条 entry，会让 branch 膨胀，fork 和 /tree 时还会被复制或误读；而这个计数只是 UX                                                                                                                                                                                                                                                                                                                                           |
| `/new`、`/resume`、web resume 切到别的会话                                                                                                                                                                  | 新 sessionId 使用独立 bucket；**切回原会话时恢复原计数**（同一进程内 bucket 仍在）                                                                                                                                                                                                                                                                                                                                                    |
| fork                                                                                                                                                                                                        | 新 sessionId ⇒ 计数从 0 开始，**不继承**（与成员关系不继承 P10 同向）                                                                                                                                                                                                                                                                                                                                                                 |
| **pi 进程重启**                                                                                                                                                                                             | **归零**。理由：①重启后 pi 的内存队列本来就不存在；②来信在转录中可见（`display:true`）；③不为 UX 计数引入持久化。与 reply 凭证「重启即失效」的口径一致                                                                                                                                                                                                                                                                                |

**/tree**：bucket 不变。旧分支上的来信继续计数，直到新分支上有一轮完成时清零。即使模型没在新分支上读到它，也会被清掉：这是提前清零的方向，已列为残留。

**永不清零的保证**：bucket 里的每一项（包括 overflow）都在「下一个开始于它之后的回合完成」时清零；没有其他保留条件。

### 12.5 上限

- `ids` 是 FIFO 集合，上限 128。超出时淘汰最旧的 id：若当前有活动回合（`turnStartSeq` 已定义）且被淘汰项的 `seq < turnStartSeq`（本轮开始前写出）则 `overflowEligible += 1`；否则——包括**无活动回合（`turnStartSeq` 未定义）**时——一律 `overflowPending += 1`，等下一轮 turn_start 晋升后在该轮完成时清零。IB1 单测须覆盖：无活动回合淘汰、本轮内淘汰旧/新项、turn_start 无配对 turn_end（agent_end 兜底）三种情形。被淘汰的 id 失去去重能力；同一 id 被写出两次本来就很少见，可以接受。
- **overflow 两段桶（R3-1 修正）**：不再用单个 `overflowMaxSeq`（持续跨轮溢出会把它不断推高，使旧 overflow 永远等不到清零）。`turn_start` 记下 `turnStartSeq` 时把 `overflowPending` 整体并入 `overflowEligible` 并清零 `overflowPending`；`turn_end` 清空 `overflowEligible`。因此任一溢出计数最多经过「它之后开始的那一轮」完成即被清掉，与普通条目同一活性规则；两段都是有界整数，不随溢出持续时间增长任何结构。
- 计数 = `ids.size + overflowPending + overflowEligible`。显示时 >99 写作 `99+`。
- 不再有 degraded 状态，也不再有扫描预算。

### 12.6 展示

- **TUI**：`ctx.ui.setStatus("pi-subagent:xs-inbox", n > 0 ? "inbox " + (n > 99 ? "99+" : n) : undefined)`，计数变化时更新（ask-user parked 先例；HUD 读 `getExtensionStatuses()`，`src/hud/footer.ts:454`），只在主会话。
- **web**：`StatusInfo.xsInbox?: { unread: number }`，放在顶层开放字段（todo/worktrees 先例，不加 cap、不升 PROTO）。只在 n>0 时写入，unread 为 1..9999 的整数（饱和处理）；计数变化时调用 `publishStatus()`。UI 的门控为 hub caps ∋ `xs.v1` ∧ 字段存在，满足时在卡片与 `DetailHeader.vue` 显示角标。
- **`/fabric status`**：`inbox unread 3`。
- **off**：xs 关闭时零接线；`XsStackPort.unread` 是可选端口，golden 的假 stack 不提供它，因此 status 帧不变。

### 12.7 测试

- **IB1 单测**（`tests/fabric/xs-unread.test.ts`）：
  - 计入与去重；
  - 序号规则：写出 < turnStart ⇒ turn_end 时清零；写出 > turnStart ⇒ 保留；
  - agent_end 兜底与幂等；
  - 没有 turnStartSeq 时 turn_end 不清零；
  - 128 的 FIFO 与 overflow 在下一轮清零；
  - 99+；
  - 32 个 bucket 的 FIFO；
  - 模拟 /reload（同一个全局，新 stack）计数保留；
  - 切走再切回会话后恢复；
  - fork 和新 sessionId 从 0 开始。
- **IB1 property**：随机组合写出 / turn_start / turn_end / agent_end / reload / 切换。不变量：计数 ≥0；每个 id 至多计一次（未被淘汰时）；**任何条目在其后开始的回合完成后一定不存在**（永不清零不可能出现）。
- **IBW 集成**（`tests/integration/fabric-xs-inbox.test.ts`，复用 harness，覆盖真实 stack 的两个写出口）：
  - idle 收到 deliver ⇒ `inbox 1`，人类发言、一轮完成后清零；
  - 忙时排队 ⇒ 当前轮完成时不清零，下一轮完成时清零；
  - 回复、超时通知（`:1817` 出口）计入；
  - 广播计入（CHW 之后补跑）；
  - `/reload` 后保留；
  - web 字段在 0 时缺失。
- **C-X10（真实 pi，收缩为顺序事实）**：
  1. 扩展 `turn_end` 触发时，`event.messageEntryId` 已经能被 `ctx.sessionManager.getEntry()` 解析，即 assistant 已持久化；
  2. idle 时写出的 quiet 消息，写出序号早于首轮的 `turn_start`；
  3. 在 before_agent_start 异步处理器 await 期间写出的 quiet 消息，在首轮 `turn_end` 时被清零；
  4. turn k 中写出的 quiet 消息在 turn k 的 turn_end 时**不**清零，在 turn k+1 的 turn_end 时清零；
  5. error/aborted 回合也会触发 turn_end；
  6. 在流式中经 `session.reload()` 后，计数保留，并在之后的一轮完成时清零。

  如果 pi 升级后第 1 条或第 5 条不再成立，则以 agent_end 兜底（只会让清零变晚）。

### 12.8 已知残留（接受的近似）

| #   | 残留                                                                         | 方向                                       |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| IR1 | 被 `context_edit` 删除、模型实际没读到的来信，在下一轮完成时被清零           | 提前清零                                   |
| IR2 | turn_start 之后、请求之前发生压缩，消息被摘要，模型只看到摘要                | 按 NQ1 视为已处理                          |
| IR3 | 回合开始后 provider 出错或被 abort，消息被视为已处理                         | 提前清零（消息仍在上下文中，下一轮会读到） |
| IR4 | `/tree` 切到不含该消息的分支，下一轮完成时被清零                             | 提前清零                                   |
| IR5 | pi 进程重启后归零                                                            | 少计（转录中仍可见）                       |
| IR6 | fork 不继承计数                                                              | 少计                                       |
| IR7 | 消息被 FIFO 淘汰进 overflow 后失去去重能力                                   | 极少数情况下多计，下一轮清零（两段桶保证） |
| IR8 | 宿主调用已经发生但消息可能没真正落地（receiver_error / verify 失败）时也计入 | 多计，下一轮清零                           |

---

## 13. 新问题（已全部拍板）

- NQ2（2026-10-22 用户拍板：**收紧**）：点对点唤醒退款收紧为 `acked ∧ woke:false ∧ effect ≠ "unknown"`，unknown 的 wake 预占不再退还（修复 C6 的既有突破路径，见 §5.2 顺带修正与 CH1 验收）。
- NQ1（被摘要的来信何时清零）已由用户拍板：模型带着摘要回应一轮后清零；r3 §12.3 的规则自然满足。
- Q1–Q10 均已在 §0 拍板。

---

## §R1 评审处置

评审：gpt-6.1-sol，r1 打回（reject）。下表逐条列出 finding → 处置 → 落到哪一节。

| #   | 严重度  | finding 摘要                                                                                             | 处置               | 说明                                                                                                                                                                                                                                                                                                      | 落点                       |
| --- | ------- | -------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| B1  | Blocker | 「仅 default 时逐字节不变」与 via、rows.channels、广播 limits 的写出冲突；假端口 golden 不能证明开启路径 | **采纳**           | 冻结 §3.2 写出规则表：共享集合为 [default] 时，via/rows/candidates.channels/status.channels 不写；广播三键只在含命名频道时写；例外逐项列出。证明方式改为真实 activate + 桥接的「channels 开启 default-only」vs「channels 关闭」×「reply 关闭」逐字节对照；三份 golden 不重生成，也不再作为开启路径的证据  | §3.2、§9.4-2               |
| B2  | Blocker | session_compact 无条件清零 + 重建遇 compaction 即停，永久隐藏被保留的未读                                | **采纳**           | 删除 compaction 清零；未读改为「branch 路径上最后一个 assistant 之后的 xs 条目 ∪ pending − 本进程已读」，compaction 不作为停止点；已读只在 turn_start 时按 `buildContextEntries` 投影判定；被保留的条目继续未读，被摘要的在模型回应后清零（NQ1）；补「保留 → compact → reload → 首轮」的集成与 C-X10 用例 | §12.2、§12.4、§12.5、§12.8 |
| M1  | Major   | 旧 hub 上 `joined:false` 不能封闭发现（旧 router 允许未加入的 list/resolve）                             | **采纳**           | 新增 `linkChannels` / `linkJoined`：hub 无 cap 时，有效集合与 {default} 取交集；本地对**所有** list/resolve/send/block/mention/directory 门禁（零帧发出）；status 与 UI 一致降级；兼容测试改用冻结的 v0.7.1 router/decoder 夹具，不用「新 hub 删 cap」冒充旧 hub                                          | §2.3、§3.4、§9.4-3、CH2    |
| M2  | Major   | channels.enabled=false 缺完整关闭契约；hub 缺失即开启；已保存命名频道的恢复未定义                        | **采纳**           | 删除 hub 级关闭键：hub cap 只取决于 crossSession 是否存在，`crossSession.channels` 只承载参数，缺失 = 默认值，从不表示关闭；agent 关闭频道 ≡ 旧 agent；已保存的命名频道**挂起**（不生效、不上线、entry 不改写），重新启用后恢复；补「保存 → 关闭 → reload → 开启」测试                                    | §2.3、§3.1、§9.1 CH3       |
| M3  | Major   | 先按频道过滤再判重复持有者会绕过 XR5；广播 N 与 ambiguous 的单位未冻结                                   | **采纳**           | 唯一持有者在全部有效 joined 成员上判定，之后再做可见性过滤；候选只暴露可见持有者；广播 N = 逻辑会话数，ambiguous 行计入 N 与配额，`applied+none+unknown=N`；补跨频道、off/replies、缺 cap 的双持有者测试                                                                                                  | §4.1、§5.2-2、§9.1 CH1     |
| M4  | Major   | `woke:false` 不能证明未唤醒（dispatch 后 verify 失败），退额度可突破配额                                 | **采纳（更保守）** | 广播的唤醒预占与发送计数**一律不退还**；pair 唤醒不足在扇出前判定，不存在退款；property 使用真实 receiver（含 verify 失败路径）作为 ack 来源。另把 C6 视为点对点的既有缺陷，顺带收紧退款条件（NQ2）                                                                                                       | §5.2-5/7、§9.1 CH1、NQ2    |
| M5  | Major   | 广播只看 level===0，漏了发送方 hopAllowed/maxLevel                                                       | **采纳**           | `wakeUsable = wake.enabled ∧ hopAllowed(level) ∧ level===0`；hub 再判 level 0；接收方照常执行 maxLevel；补发送方 maxLevel=0 的端到端用例                                                                                                                                                                  | §5.5、§9.1 CH4、§9.2-3     |
| M6  | Major   | 只在第二轮起的 turn_start 对账，漏了首轮前 flush 的消息                                                  | **采纳**           | 已读判定在**每一个** turn_start（含首轮）按上下文投影执行；另加 loop 消息的 `message_end`（首轮 trigger 在 turn_start 之后才进入）；C-X10 增加「before_agent_start 期间到达」与「NoticeGate 在 beforeAgentStart 内写出」两条路径                                                                          | §12.4、§12.8 C-X10-2/3/6   |
| M7  | Major   | 装饰 accept 覆盖不全，没有冻结 effect/token/notice id 的观察契约                                         | **采纳**           | 观察点改为两处宿主写出 tap（`stack.ts:1709`、`:1817`），这是所有写入 pi 的唯一出口，覆盖 dispatch 之后的 receiver_error、verify 失败、notice 的唤醒与 quiet；契约 `XsUnreadTap` 冻结在 CH0；notice 增加附加字段 `details.nid`；不依赖 verdict 或 XsInbox，tap 只观察，异常一律吞掉                        | §12.3、§10 CH0             |
| M8  | Major   | epoch bump 不会让在途 list 失效；「转发后、ack 前 leave ⇒ none」的验收过宽                               | **采纳**           | list/resolve/channels 在 await 后复核 epoch，变化就不返回旧 rows（删除 `sender.ts:365` 的例外）；明确线性化点：hub 准入、接收端 stage 3、dispatch 之后不回滚；集成测试拆成 dispatch 前 leave ⇒ none，dispatch 后 ⇒ applied/unknown                                                                        | §4.5、§9.2-5               |
| m1  | Minor   | 他人换频道不会清空缓存；20 行截断不能证明唯一                                                            | **采纳**           | 删除过强表述，明确只是缓存内唯一（RR8 延续，CR6）；hub 对选中的 ref 做权威解析；list 返回正好 20 行时标记 truncated，裸名一律放行                                                                                                                                                                         | §4.3、§11 CR6、§9.1 CH5    |
| m2  | Minor   | 99 条之后丢 id；扫满 256 条不能当作「不存在」；start 之后 reload 与 IR1 冲突                             | **采纳**           | 显示饱和（99+）与内部完整集合分离；预算耗尽 ⇒ degraded，从不判定 lost；明确选择「活跃时以 turn_start 为水位、重建时以 assistant 为水位」，并写清两者的差异窗口                                                                                                                                            | §12.2、§12.4               |
| m3  | Minor   | join 是并集，会保留 default，与 Q3「隔离」表述矛盾                                                       | **采纳**           | 写死增量语义：从未加入时 `join #a` 只进 `#a`；已在 default 时保留 default 并给出提示；`leave #default` 是隔离方式；不提供「替换集合」命令                                                                                                                                                                 | §0 Q3、§2.2                |
| m4  | Minor   | 广播元数据没有贯通 Controller 和人可见渲染；文件未分配                                                   | **采纳**           | `RootWakeRequest.bc` 写入 details；TUI `render.ts` 增加 broadcast kind；web `xsMessage.ts` 从首行解析，`TxCustom.vue` 展示；文件分别分到 CH3 与 CHU                                                                                                                                                       | §5.3、§10                  |
| m5  | Minor   | 补全中触发网络刷新，违反 S-own 纯函数约束                                                                | **采纳**           | completer 只读缓存；刷新只发生在 `/fabric channels`、`/fabric status`、join/leave 成功之后                                                                                                                                                                                                                | §6.3                       |
| m6  | Minor   | 展示 `bcast a/6h`，但没有权威数据源                                                                      | **采纳**           | 删除 `/agent status` 中的广播用量；`/fabric status` 只显示有效配置与 `usage n/a`；不新增 hub 用量端口（MVP 收缩）                                                                                                                                                                                         | §6.3、§10 CH6              |
| —   | 建议    | 评审第 6 点：MVP 收缩（全局目录、动态补全、侧栏持久化、广播用量）                                        | **部分采纳**       | 去掉动态补全刷新、侧栏持久化、广播用量；`op:"channels"` 全局目录**保留**，因为用户已拍板 Q7。pair interval 不再写成「不检查也不打戳」，按 reply 的实际行为写为「跳过检查、照常打戳」                                                                                                                      | §5.2-4、§6.3、§7           |
| —   | 建议    | 契约包应冻结内部端口；UI 可提前并行                                                                      | **采纳**           | CH0 冻结 `XsChannelView`、`XsUnreadTap`、`RootWakeRequest.bc`、`broadcast()` 返回类型、`admitBroadcast`；CHU 在 CH0 之后就能并行，真机验收放到 CH6；conformance 文件的写入顺序为 IBW（C-X10）→ CH6（C-X9）                                                                                                | §10                        |

评审共 16 项：B1、B2、M1–M8、m1–m6，另有两条建议性意见。全部采纳或部分采纳，**没有驳回**。

---

## §R2 复审处置

复审：gpt-6.1-sol，r2 打回（reject）：0 Blocker、3 Major、3 Minor、1 Nit。r3 依据主会话裁定作答：收信箱是 UX 提示，不是正确性不变量，允许近似。

| #    | 严重度 | finding 摘要                                                                                                                                       | 处置                 | 说明                                                                                                                                                                                                                                                                                                                                     | 落点                       |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| R2-1 | Major  | `buildContextEntries` 不是实际投影（`context_edit` 删除的条目仍在其中）；turn_start 之后还可能在请求前压缩                                         | **消解（设计替换）** | 删除「投影判定已读」。改为事件计数：回合**完成**（turn_end）且回合开始晚于写出 ⇒ 清零。`context_edit` 删除、请求前压缩这两种情况被**明确接受为近似**（IR1/IR2：提前清零或按摘要视为已处理），不再声称精确                                                                                                                                | §12.1、§12.3、§12.8        |
| R2-2 | Major  | pending 缺少与 read 分开的落 branch 晋升规则，也缺 Controller idle/tombstone 通知端口 ⇒ 被摘要来信永不清零、切分支后的幽灵未读、启动失败后悬挂计数 | **消解（设计替换）** | 删除 pending、branch 晋升和 Controller 终止端口。每条记录只有一个退出条件：「下一个开始于它之后的回合完成」，**不可能永不清零**（property 断言）。切分支后旧分支来信会在下一轮完成时被清零（IR4，提前清零）；启动失败时没有回合，计数保留，直到真有一轮完成，这是正确语义                                                                | §12.2、§12.3、§12.4、§12.7 |
| R2-3 | Major  | stack 重建清空 pending，漏计仍在 pi 内存队列中的来信；pi reload 不清空队列，也不会再经过 tap                                                       | **采纳**             | 计数放在进程级 `Symbol.for("pi-subagent:xs-unread")` 全局里（wake/reply ledger 先例），**stack 重建不清空**；写出时就计入，所以队列 flush 时不需要再经过 tap。按 sessionId 分 bucket：切走再切回恢复，fork 和新会话从 0 开始，进程重启归零（IR5，和队列一起消失）。C-X10-6 覆盖「流式中 session.reload → 计数保留 → 之后的回合完成清零」 | §12.4、§12.7               |
| R2-4 | Minor  | 扩展 `message_end` 早于 SessionManager 持久化，assistant message_end 里重扫看不到这个 assistant                                                    | **采纳**             | 不再使用 message_end。清零改在扩展 `turn_end`：boundary 事件，携带已持久化的 `messageEntryId`，pi 解析不到时会报错。另以 `agent_end` 兜底。C-X10-1 锁定「turn_end 时 messageEntryId 可被 getEntry 解析」                                                                                                                                 | §12.3、§12.7               |
| R2-5 | Minor  | 新版开/关对照不能单独证明与 v0.7.1 相等；非确定性值需要固定或规范化；未读字段需列为例外                                                            | **采纳**             | 三角锚定：①三份 off golden；②agent 侧采集规范化后与 reply-off golden（在 v0.7.1 上通过）逐字节相等；③hub 侧用冻结的 v0.7.1 router 做差分（记录来源提交与 sha256，薄 decoder 只用冻结的 schema，配负对照）。列出确定性输入与规范化清单（只替换值、不删键、不排序）；caps、工具表、`xsInbox` 单独断言                                      | §9.4、§10 CH0/CH1/CHW      |
| R2-6 | Minor  | degraded 且 n=0 时被 n>0 门禁隐藏；overflow 只在重建时清零；通知数量上界的证明不成立                                                               | **消解（设计替换）** | 删除 degraded 和扫描预算；overflow 记录 `overflowMaxSeq`，与普通条目一样在下一轮完成时清零；不再依赖任何「通知总量上界」：ids 是 128 的 FIFO，超出部分进 overflow，显示 `99+`                                                                                                                                                            | §12.5                      |
| R2-7 | Nit    | 文首统计应为 2 Blocker、8 Major、6 Minor                                                                                                           | **采纳**             | 文首改为「2 Blocker、8 Major、6 Minor，共 16 项」                                                                                                                                                                                                                                                                                        | 文首                       |

**对 §R1 处置的影响**：r1 的 B2、M6、M7、m2 在 §R1 中的「落点」指向的是 r2 的结构派生设计，现在由 r3 §12 取代。语义（模型处理后自动清零、计入所有跨会话来信、只显示数量、压缩不单独清零）保持不变，实现改为事件计数。M7 的「两处宿主写出口」结论保留，契约收窄为 `written(id)`。其余 §R1 条目不受影响。

## §R3 第三轮复审处置（主会话直接修订）

| #     | 级别  | 问题                                                                    | 处置     | 落点                                                                                                |
| ----- | ----- | ----------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| R3-1  | Major | `overflowMaxSeq` 合并新旧溢出，持续跨轮溢出会不断推迟清零，违反活性保证 | **采纳** | 改为 `overflowPending`/`overflowEligible` 两段桶：turn_start 晋升、turn_end 清空；§12.3、§12.5、IR7 |
| R3-2  | Minor | v0.7.1 差分等价承诺未排除 NQ2 行为收紧                                  | **采纳** | §9.4 限定等价面，NQ2 差异由 CH1 定向断言覆盖                                                        |
| R3b-1 | Minor | 无活动回合时淘汰的入桶规则未写明                                        | **采纳** | §12.5：`turnStartSeq` 未定义 ⇒ 入 `overflowPending`；IB1 单测覆盖三种情形                           |
