# fabric 跨会话：别名增强 #72 —— 强制抢占 + 目录名默认别名 + /new 交接（实施方案 r2）

> 车道：**L2**。协议加两个可选字段、一个 hub→agent 帧和一个能力位；hub 绑定表多三类事务（auto、force、handoff）；agent 多一条自动认领路径、一个会话 entry 和一个 /new 交接槽。不改运行状态机、投递语义和工具 schema。
> 基线：dev@5406bf49。本文是 `alias-plan.md` r4 的增量；凡未提及处，沿用 r4 正文、拍板（Q1–Q11、NQ1–NQ5）和 §3.3 状态×行为矩阵。
> 用户需求（2026-10-27）：
>
> 1. 新增强制抢占。持有者在线或刚离线也能抢；仍要确认；被抢方在线时实时提示；飞书和 agent 都没有途径。
> 2. 会话接入 hub 时，如果没有别名，就自动认领规范化后的 cwd basename。名字被占用就不设，不加后缀，也不抢；人工设置或清除过别名的会话，以后不再自动设；带开关。
>
> 拍板 D1–D6 见文末「用户拍板」。评审 r1（kimi，有条件通过：0 blocker / 13 条 minor、nit）的落实见文末「r2 修订对照表」。

---

## 0. 一页摘要

| 项        | 结论                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 强制抢占  | 命令 `/fabric alias <名> --force`，只用于预览。确认框显示对方目录、在线或离线时长、是否为自动认领。执行沿用 `--take=<token>`，由 token 记住 mode=force。原 `--take` 不变                                 |
| 实时提示  | 提交后，hub 向被抢 sid 的每条在线连接推送 `xs_alias_evt`。agent 收到后走现有的 get 对账和 `lost` 一次性提示，文案为「被强制抢占」                                                                        |
| 不可通知  | 以下情况一律拒绝 force（`E_XS_ALIAS_TAKE{unnotifiable}`），只能走原 `--take`（持有者离线 ≥10 分钟）：持有者有任一在线连接未声明 v2；或持有者连着 hub、但不是 effective xs member（xs 关闭、未发 member） |
| 默认别名  | agent 在 attach、每次 hello_ack、join 之后的对账末尾，满足条件时发 `intent:"auto"`。hub 只在「名字没有 live 记录、也没有过期 held，且本会话名下没有 held/coolingLive/墓碑」时新建记录；否则静默跳过      |
| 人工标记  | 会话 entry `subagent:xs-alias-decided`，按 sessionId 校验。任何人工别名写操作在发出前先写入；标记存在 ⇒ 永不 auto                                                                                        |
| /new 交接 | AF7：在 `session_shutdown{reason:"new"}` 时把旧 sid 的别名与标记放进一次性进程槽，照搬 #70。新 sid 在 attach 后发 `intent:"handoff"`；hub 校验「同一连接刚从旧 sid 切到新 sid」后就地转移。fork 不交接   |
| 设置      | `fabric.crossSession.alias.autoFromCwd`，**默认 true**，非 live，只在 agent 侧生效，不写进 HubConfig                                                                                                     |
| 兼容      | 新能力位 `xs.alias.v2`，两个面都声明。新字段、新帧、新错误细节只写给声明了 v2 的对端。不 bump PROTO。三份 off golden 与 `legacy-xs-v071/` 不动                                                           |
| 规模      | 9 个包（AF0–AF4、AFU、AFW、AF6、AF7），约 9.25 人日，关键路径约 7 天（含 AF7）                                                                                                                           |

---

## 1. 现状要点（代码坐标）

| #   | 位置                                                                                                                                                                                                                                        | 现状                                                                                                                                         | 对本方案的影响                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1  | `src/web-hub/protocol/xs.ts:402-431` `XsReqSchema`                                                                                                                                                                                          | `additionalProperties:false`：旧 hub 收到带未知字段的帧会**静默丢弃整帧**，请求方要等到 5s 超时                                              | 新字段只在 hub caps ∋ v2 时发送                                                                                |
| S2  | `xs.ts:516-517` `xs_res.alias`                                                                                                                                                                                                              | 开放对象                                                                                                                                     | 预览和状态的新键可以放进去，但仍只写给 v2 请求方                                                               |
| S3  | `protocol/messages.ts:2388` `decodeWith`；`agent/connection.ts:723` hub 帧 switch                                                                                                                                                           | 未知 `t` ⇒ undefined，被忽略                                                                                                                 | 新帧 `xs_alias_evt` 即使发给旧 agent 也无害；仍只发给 v2，因为要靠这一点判定「能否通知」                       |
| S4  | `xs.ts:649` `XsStatusSchema`                                                                                                                                                                                                                | 严格对象                                                                                                                                     | **本方案不改 StatusInfo**                                                                                      |
| S5  | `hub/xs/aliases.ts:199-225` store 接口；`:453` `TokenEntry`；`:596` `offlineSinceOf`；`:929` `planTake`；`:1085` `takePreview`；`:1009` 加载后全员视为离线                                                                                  | token 绑定 `(请求方 sid, alias, 持有者 sid, rev, offlineSince)`；take 要求离线 ≥ takeMin                                                     | 扩展 force 的绑定元组；新增 `planAuto`、`planHandoff`                                                          |
| S6  | `aliases.ts:305` `parseTable`                                                                                                                                                                                                               | `version===1` 是硬条件；record/tombstone 用解构读取，**多余的键被忽略**；未知的 `tombstone.reason` ⇒ corrupt；`serializeTable` 只写已知字段  | 新数据只能是**可选键**，不能新增 reason 枚举值，否则 hub 降级后会 degraded                                     |
| S7  | `aliases.ts:913` `planClear`                                                                                                                                                                                                                | 没有 held 时是 noop，返回成功和 `state:none`                                                                                                 | 对空会话执行 `--clear` 可作为显式的「不要自动设置」                                                            |
| S8  | `hub/xs/router.ts:308-380` `handleAlias`；`:461-468` op 门控                                                                                                                                                                                | 子操作由字段组合推导（get/set/clear/preview/take）；alias op **不要求 joined**；audit 的 `reason` 取子操作名                                 | 新增按 intent 分派；auto 在 hub 侧强制要求 joined；audit 增加取值                                              |
| S9  | `router.ts:919` `createXsAliasBinding`（`isOnline` = 存在 effective member）；`:954` `withPresenceFeed`；`hub/registry.ts:76` `send`、`:346` `list()`；`hub/xs/members.ts:38` `XsRecordView{connected,phase,sessionId}`、`:265` `onSession` | 在线与否**只看 effective xs member**：持有者连着 hub 但 xs 关闭，也会被当作离线                                                              | 新增 `isLinked(sid)`（§4），供 force/handoff 判定；推送复用 `registry.send`；交接复用 `onSession` 的会话切换边 |
| S10 | `hub/assembly-channels.ts:183`                                                                                                                                                                                                              | `xs.alias.v1` iff `store.advertised`，在 cap 数组中追加                                                                                      | v2 紧跟 v1，门控相同                                                                                           |
| S11 | `agent/xs.ts:292` `aliasLostText`；`:465` `applyAliasState`（按 `(sid, lost.at)` 做进程级去重，上限 64）；`:496` `aliasOp`（只接受当前连接、当前 sid 的回包）；`:551` `reconcile`；`:572` caps                                              | 对账是只读 get；失败就等下一个时机                                                                                                           | auto 和 handoff 挂在 reconcile 末尾；evt 只触发 reconcile                                                      |
| S12 | `agent/index.ts:1366-1376` `onHubCaps`、`:1612-1616` attach                                                                                                                                                                                 | 两处都在 `publishMember()` 之后调用 `xsBridge?.onHubCapsAlias()`                                                                             | 不新增触发点（另有 join 后的 `refreshAlias`）                                                                  |
| S13 | `commands/fabric-xs.ts:755-860` `runAlias`；`:47` 飞书拒绝；`:282` 补全；`:714` status 行                                                                                                                                                   | `--take` 的预览、确认、执行与 web/RPC 确认行已齐备                                                                                           | 加 `--force` 分支和写前标记钩子                                                                                |
| S14 | `fabric/settings.ts:160-170,270,579`；`fabric/setting-specs.ts`                                                                                                                                                                             | alias 的 4 个键只能写在 JSON 里；`FABRIC_SETTING_SPECS` 里**没有任何 crossSession 键**，顺序由 `tests/config/setting-specs-pin.test.ts` 钉住 | §6                                                                                                             |
| S15 | `fabric/xs/activate.ts:401-416`（#70 `stashMembershipHandoff`/`beginSessionStart`）；`membership.ts:101-112` 进程槽；`src/index.ts:891` 在 shutdown 时调用                                                                                  | `/new` 用一次性进程槽交接 membership；任何 reason 的 session_start 都会清空这个槽，只有 `reason==="new"` 时采用                              | AF7 照搬这套做法                                                                                               |
| S16 | `fabric/xs/alias-suggest.ts`（cwd 末段原样作为候选）；`ui/.../detail/ChannelsDialog.vue:159,196-243`                                                                                                                                        | 推荐 chip 和 TUI 补全由各自的逻辑算出；web 抢占用 `useTrackedCommand` + `parseTakeConfirm`                                                   | cwd 那一段改为复用 `deriveAliasFromDirName`，保证 chip 与 auto 的结果一致；web 解析器不改                      |

---

## 2. 修订后的原则与不变式

**原则修订**：

- 原原则「只有人能设置」改为：**认领他人别名只能由人发起；自动认领只拿空闲名，且永远让位于人工操作；/new 交接只在同一连接的会话继承链上进行。**
- 原 Q5 / I5「在线持有者永不被抢」改为：**在线持有者只能被人工 force 抢走，且必须能被实时通知。**
- **r4 §5.2 的修订**：原句「别名在两步之间被抢占，被抢方此时必然已离线（⇒ NO_TARGET）」不再成立。force 之后，原持有者可能仍在线。新口径如下（钉住完整 sessionId 的机制不变）：
  - 消息仍发给 resolve 时确认的那个会话；
  - 原持有者仍在线 ⇒ 按 pin 送达原持有者，这是发送方当时解析到的目标，不是误投；
  - 原持有者已离线 ⇒ `NO_TARGET`；
  - 绝不改投给新持有者（§9 有集成测试）。

**在场的三态**（hub 读时判定）：

| 状态        | 判定                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| `xs-online` | 该 sid 至少有一个 effective member（等同 r4 的 isOnline）                           |
| `linked`    | 不是 xs-online，但 registry 中有 `connected ∧ phase≠stale ∧ sessionId===sid` 的记录 |
| `offline`   | 以上两者都不是                                                                      |

`linked` 只用于 force 和 handoff 的判定。take、过期判定和 offlineSince 盖戳仍按 r4，只看 xs-online，因此原 `--take` 的 10 分钟门槛保持不变。

| ID        | 不变式（追加到 r4 §3.1 表）                                                                                                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I5′       | 他人的 held 只能经以下途径转移：① 人工 `take`（持有者离线 ≥ takeMin）；② 人工 `force`；③ `set` 接管已过期的记录；④ `handoff`（同一连接的会话继承，见 I10）。①② 都要求 token 绑定元组在执行入口和 rename 前**两次**复核。② 还要求持有者 `notifiable`：持有者不是 `linked`，并且是 xs-online 时，它的**每一个** effective member 都声明了 `xs.alias.v2` |
| I7（新）  | auto 事务**只新建记录**。前置条件（按读时谓词判定）：x 没有 held（无论是否过期）也没有 coolingLive；过期的 cooling 视同不存在；S 名下没有 held、没有 coolingLive，也没有未满 30 天的墓碑；骨架不与其他 sid 冲突。因此 auto 的 G 恒为空操作，auto 永不修改、转移或降级任何已有记录                                                                     |
| I8（新）  | 「人工已决定」标记**先写后发**：任何人工别名写操作，都在 xs_req 发出之前同步写入内存标记和会话 entry。标记存在的 sid 永不发 auto。同一连接上先发出的 auto 在 hub 中按 FIFO 排在人工 op 之前，因此人工 op 总是最后生效                                                                                                                                 |
| I9（新）  | force 提交后（内存表更新时，包括 wedged 之后晚到的成功），hub 立即向被抢 sid 的每一个 v2 effective member 推送 `xs_alias_evt`。推送失败不回滚，由墓碑兜底                                                                                                                                                                                             |
| I10（新） | handoff 只在以下条件同时满足时转移：requester 的 agentKey 在 hub 内存中记录着「≤120s 前从 prevSid 切到当前 sid」的继承边；prevSid 是 `offline`（不是 xs-online，也不是 linked）；x 为 `held(prevSid)`；requester 名下没有 held。转移不留墓碑、不留 cooling、保留 origin                                                                               |

I1–I4、I6 不变。I6「记录只由事务修改」仍然成立：auto、handoff 也走 §3.3 事务；在场判定、继承边和推送都从不触发写入。

---

## 3. 协议变更（全部 append-only，不 bump PROTO）

### 3.1 能力位

- `XS_ALIAS_V2_HUB_CAP = "xs.alias.v2"`：hub 的声明条件与 v1 相同（`store.advertised`），在 cap 数组中紧跟 v1。
- `XS_ALIAS_V2_AGENT_CAP = "xs.alias.v2"`：agent 的声明条件与 v1 相同（`xsOn ∧ alias.enabled`），在 hello caps 中紧跟 v1。
- 语义：hub 侧理解 `intent`（auto、force、handoff），并推送 evt；agent 侧能处理 evt、`lost.forced` 和预览扩展键。
- AF7 要和 AF0–AF6 在**同一个发版**里出现（§10）。万一 v2 hub 尚未实现 handoff，它会对 handoff 回 `E_XS_BAD_FRAME`，agent 把这当作「交接失败」并回落到 auto 路径，结果无害。

### 3.2 帧与字段

```
xs_req (op:"alias") 新增可选字段（仅当 hub caps ∋ xs.alias.v2 时发送）：
  intent?: "auto" | "force" | "handoff"
  prevSessionId?: string              // SessionIdSchema，仅 intent:"handoff"
  {alias:X, intent:"auto"}                              → auto 认领
  {alias:X, take:"preview", intent:"force"}             → force 预览
  {alias:X, take:<token>}                               → 执行（与现状相同；mode 由 token 决定，执行帧上的 intent 被忽略）
  {alias:X, intent:"handoff", prevSessionId:S1}         → /new 交接
  其他组合（intent 与 clear 同时出现、auto 或 handoff 带 take、prevSessionId 不配 handoff 等）→ E_XS_BAD_FRAME
xs_res.alias（开放对象；新键只写给 v2 请求方）
  state:   { alias?, state, origin?:"auto", lost?:{alias, reason:"taken"|"expired", at, forced?:true} }
  preview: { take:{ cwdLabel, offlineForS, token, expiresAt, online?:true, auto?:true } }   // online 时 offlineForS=0
hub→agent 新帧（进入 XS_HUB_FRAME_SCHEMAS；严格 schema；受 xs 16 KiB 上限约束）
  xs_alias_evt { t:"xs_alias_evt", sessionId, at }   // 只是提醒，不携带别名文本；只发给 v2 effective member
错误：E_XS_ALIAS_TAKE 新增细节 {unnotifiable}（只会回给 v2 请求方）；handoff 的所有失败一律返回 TAKE{stale}
```

### 3.3 落盘（`xs-aliases.json`，`version` 保持 1）

- record 新增可选键 `origin:"auto"`：人工授予时不写；handoff 时保留。
- tombstone 新增可选键 `forced:true`：reason 仍为 `taken`。
- **不新增 reason 枚举值**（S6）。

### 3.4 降级矩阵

| 组合                             | 行为                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 agent × 旧 hub（v1 或无 cap） | 不发 intent。auto 和 handoff 静默关闭（`/fabric status` 显示 `auto skip:hub-cap`）；`--force` 本地拒绝：「hub 不支持强制抢占，需 /webhub restart」；`--take` 照旧。线上帧与当前 alias 版逐字节相同，只有 hello caps 多一项，旧 hub 会忽略 |
| 旧 agent × 新 hub                | hub 不向它写新键，也不推送；它的请求不带 intent，行为与当前版本相同。它作为在线持有者时，force 返回 `unnotifiable`；它离线后可以被 force，回来时 get 拿到 `lost{reason:"taken"}`（不带 forced），提示走旧文案                             |
| 新 hub 读旧文件                  | 没有新键 ⇒ 视为人工记录、非 forced                                                                                                                                                                                                        |
| 旧 hub 读新文件                  | 多余的键被忽略，**不会 degraded**；旧 hub 下一次写盘会丢掉 `origin`/`forced`（只影响显示，R18）                                                                                                                                           |
| `alias.enabled=false`            | 没有 v1、v2 cap；不 auto；不交接；不写标记（`/fabric alias` 本身在本地就被拒）。与当前版本逐字节相同                                                                                                                                      |
| `autoFromCwd=false`              | 不发 auto；status 不加后缀。与当前 alias 版的差别只有 hello caps 多了 v2、多了 force 和 handoff 能力                                                                                                                                      |
| web UI                           | UI 与 hub 同版本，「强制抢占」按钮按 hub caps ∋ v2 显示。对端是旧 agent 时，`--force` 返回用法错误，界面原样显示                                                                                                                          |

`hub.json.alias`（degraded 状态行）**不变**。

---

## 4. hub 状态机增量（追加到 r4 §3.2 表）

读时谓词：

- `presence3(H)` ∈ {xs-online, linked, offline}（§2）。
- `presenceKey(H)`：xs-online 时为 `"on"`，offline 时为 `"off:<offlineSince>"`。linked 时不签发 token。
- `notifiable(H)`：`presence3(H)` 为 offline；或为 xs-online，且 H 的每一个 effective member 都具备 `aliasV2Capable`。linked ⇒ 永远是 `¬notifiable`。

`isLinked(sid)` 由 `createXsAliasBinding` 新增的 dep 提供，实现为 `registry.list()` 中存在 `connected ∧ phase≠"stale" ∧ sessionId===sid` 的记录。router 构造 binding 时传入 registry 闭包。只读，无锁。

| 事件（S 发起）               | 前置条件（事务内校验；rename 前再复核）                                                                                                 | 结果                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto x`                     | S joined ∧ S 名下无 held、无 coolingLive、无未满 30 天的墓碑 ∧ x 无 held、无 coolingLive ∧ 骨架不撞他人 ∧ 未满 256 条                   | 新建 `x:held(S)`，`origin:"auto"`；G 为空操作（I7）。过期的 cooling 由本事务的 prune 删除                                                        |
| `auto x`                     | S 已有 held y                                                                                                                           | ok，返回当前状态（`held y`），**不写盘**                                                                                                         |
| `auto x`                     | x 有 live 记录（未过期的 held、coolingLive）**或过期的 held**（I7：auto 不接管过期记录）；或 S 有 coolingLive、有未满 30 天的墓碑       | `E_XS_ALIAS_TAKEN{taken}`。这是**同步前置检查**，不占队列名额；过期的 cooling 与超过 30 天的墓碑按读时谓词视为不存在，不会阻塞                   |
| `auto x`                     | 骨架撞他人 / 不合法 / 表满 / 队列或 IO 异常                                                                                             | `TAKEN{confusable}` / `INVALID{…}` / `FULL` / `BUSY{queue\|io}`                                                                                  |
| `auto x`                     | S 未 joined                                                                                                                             | `E_XS_BAD_FRAME`（agent 不会发出这种请求）                                                                                                       |
| `force preview x`            | `held(H≠S)` ∧ `notifiable(H)` ∧ token 未满 32                                                                                           | 签发 token，绑定 `(S, alias, H, rev, mode:"force", presenceKey(H))`，5 分钟有效；返回 `cwdLabel, offlineForS, online?, auto?`；计入 `listPerMin` |
| `force preview x`            | H 是 linked，或 xs-online 且有非 v2 的 member / x 不是他人的 held（cooling、无记录、属于自己）                                          | `TAKE{unnotifiable}` / `TAKE{not_held}`                                                                                                          |
| `take <token>`（mode=force） | token 有效 ∧ `R.sessionId===H` ∧ `R.rev` 未变 ∧ `presenceKey(H)` 与 token 一致 ∧ `notifiable(H)` ∧ 请求方仍在线（同一 sid、同一 epoch） | 先执行 G，再**就地转移**给 S（`rev+1`，删除 origin）；写入 Tombstone(H, taken, forced:true)；提交后推送（I9）                                    |
| `take <token>`（mode=force） | 任一条件不满足（包括 H 期间变成 linked）                                                                                                | `TAKE{stale}`。token 一律消耗                                                                                                                    |
| `take <token>`（mode=take）  | —                                                                                                                                       | 与 r4 相同：绑定 offlineSince，要求离线 ≥ takeMin，在场只看 xs-online。mode=take 的 token 不能按 force 语义执行，反之亦然                        |
| `handoff x (prev=P)`         | I10 全部条件 ∧ `R.state==="held" ∧ R.sessionId===P`                                                                                     | G（S 是新 sid，通常为空操作），然后就地转移给 S（`rev+1`，**保留 origin**，**不写墓碑**，P 不留 cooling）；同时删除 P 的墓碑（如果有）           |
| `handoff x`                  | 任一条件不满足                                                                                                                          | `TAKE{stale}`（agent 回落到 auto 路径）                                                                                                          |
| 人工 set/take/force 授予记录 | —                                                                                                                                       | 与 r4 相同；授予的记录**删除 `origin`**                                                                                                          |

**补充说明**：

- **token 元组扩展**：`offlineSince` 字段改名为 `presenceKey`，并新增 `mode`。mode=take 的 token 只在离线时签发，presenceKey 总是 `off:<t>`，比较结果与现状等价。持有者在 token 有效期内「在线 → 断开 → 重新在线」时，presenceKey 仍为 `on`，校验放行：人确认的本来就是「抢在线的持有者」（R15）。
- **推送**：在提交回调中（内存更新之后），从 `members.effectiveAll()` 中取出 `sessionId===H ∧ aliasV2Capable` 的 member，逐个 `registry.send(agentKey, xs_alias_evt)`。rename 在 wedged 之后晚到成功 ⇒ 在补做内存更新时推送；晚到失败 ⇒ 不推送。
- **继承边**（AF7，`members.ts`）：`onSession(agentKey, sid)` 与 `onMember(agentKey, frame)` 在旧记录的 sid ≠ 新 sid 时，在删除或覆盖旧记录**之前**写入 `succession.set(agentKey, {from: 旧 sid, at: now})`。每个 agentKey 只占一个槽，读时检查 TTL 120s；`effective()` 发现 view 已消失时一并删除。只在内存里，hub 重启后丢失（R22）。读接口为 `members.predecessorOf(agentKey)`。
- **队列压力**：「已被占用」类 auto 走同步前置检查；只有会成功的 auto 和 handoff 才进入队列。
- **audit**（AF2）：`handleAlias` 的子操作类型 `sub` 扩展为 `"get"|"set"|"clear"|"preview"|"take"|"auto"|"force-preview"|"handoff"`，作为 audit 的 `reason` 写出（`XsAuditRecord.reason` 仍是 string，类型注释同步更新）。mode=force 的执行 audit 为 `take`，另附 `code`。audit 仍然**不写**别名文本、token、cwdLabel、prevSessionId。

---

## 5. agent 侧

### 5.1 自动认领与交接（挂在 `agent/xs.ts` reconcile 的末尾；纯判定在 `fabric/xs/alias-auto.ts`）

```
reconcile():
  get → 应用（规则不变：只应用当前连接、当前 sid 的回包）
  若 本次 get 已应用 ∧ state==="none"：
    ① 若 pendingHandoff（AF7，§5.5）∧ hub v2 ∧ 本 sid 尚未尝试过 handoff：
         aliasOp({alias, intent:"handoff", prevSessionId}, "write")；无论结果如何都清空 pendingHandoff
         ok ⇒ 结束；失败（含 BAD_FRAME、stale）⇒ 继续 ②
    ② 若 shouldAutoClaim(...) ∧ 去重键 (connGen, sessionId, membershipEpoch) 尚未尝试：
         candidate = deriveAutoAlias(cwd, {home, tmpdir})    // 失败 ⇒ 记录跳过原因 dir|invalid
         aliasOp({alias:candidate, intent:"auto"}, "write")
         BUSY{queue|io} ⇒ 等 1–5s 随机时长后重试一次（定时器 unref，时长经 clampSpanMs），仍失败则等下一个时机
         ok ∧ held ⇒ 一次性 notify
shouldAutoClaim = autoFromCwd ∧ 主会话 ∧ aliasUsable ∧ hub caps ∋ v2 ∧ membership joined ∧ ¬decided(sid) ∧ ¬pendingHandoff
```

- **去重键**：三元组 `(connGen, sessionId, membershipEpoch)`。
  - `connGen`：`agent/index.ts` 每次 attach 都递增的连接世代。
  - `membershipEpoch`：`membership.ts` 的进程级 epoch，在 attach、join、leave 时递增。

  所以每次 join 都会重新获得一次尝试机会。`/fabric status` 引发的 reconcile 遇到已经尝试过的键，直接跳过，不产生写入。

- **触发点**：沿用 S12 的两处，再加上 `/fabric join` 成功后的 `refreshAlias(deps)`。
- **auto 成功通知的去重**：使用**独立**的小集合 `Symbol.for("pi-subagent:xs-alias-auto-noticed")`，上限 32，FIFO，只存 sid。不与 lost 共用 64 的上限。
- **子会话**：bridge 只在主会话构造，`wireChildSession` 不涉及 xs，所以天然不会 auto 或交接。补单测断言。
- **secure**：D8 强制 `crossSession.enabled=false` ⇒ 没有 bridge，I11 不变。

### 5.2 basename 规范化与降级（`protocol/xs-alias.ts` 新增纯函数 `deriveAliasFromDirName`）

1. **跳过（原因 `dir`）**：cwd 为 `/`、等于 `$HOME` 或 `os.tmpdir()`，或 basename 为空。这一步由 `alias-auto.ts` 的 `deriveAutoAlias` 包装层负责。
2. `normalizeAlias(basename)` 成功 ⇒ 直接采用。
3. **`invalid`**：
   - 先做 NFKC；
   - 把不在白名单里的码点替换为 `-`（导出 `isAliasCodePoint`，与 §2.1-4 共用同一份）；
   - 合并连续的 `-`，去掉开头的 `[-_ー]` 和结尾的 `[-_]`；
   - 重新规范化。

   例：`pi.toolkit → pi-toolkit`、`My Project → my-project`、`.dotfiles → dotfiles`、`🚀app → app`、`项目 v2 → 项目-v2`。

4. **`too_long`**（第 2 步或第 3 步之后）：在字形簇边界截到 ≤16 个字形簇且 ≤48 字节，去掉结尾的 `[-_]`，再规范化。
5. **仍然失败，或原因为 `id_like` / `reserved`** ⇒ **跳过**（原因 `invalid`）。不试父目录，不加后缀，**不剥保留前缀**（D4）。本仓库 `pi-toolkit` 命中保留前缀 `pi-`，会被跳过。
6. **chip 与 auto 一致**：`fabric/xs/alias-suggest.ts` 的 cwd 末段候选改为 `deriveAliasFromDirName(末段)` 的结果（失败就不出这一项）。web `ChannelsDialog.vue` 推荐 chip 的 cwd 末段同样改用它。会话名首词和 CJK 片段这两类候选不变。

### 5.3 「人工已决定」标记（新文件 `fabric/xs/alias-decided.ts`）

- **entry**：`customType:"subagent:xs-alias-decided"`，`data:{v:1, sessionId, at, via:"set"|"clear"|"take"|"force"|"inherit"}`。customType 前缀保持 `subagent:*`（I7 旧名）。
- **读取**：stack 构建时扫描 `ctx.sessionManager.getEntries()`（**不用 getBranch**），只认 `sessionId === 当前 sid` 的条目。理由：
  - `/tree` 回退不能撤销人工决定；
  - fork 复制过来的条目带的是旧 sid，会被忽略。
- **写入**：`runAlias` 的 set、clear、执行 take/force token 三条写路径，在**发出 xs_req 之前**调用 `port.markDecided(via)`：同步置内存标志，然后 `appendEntry`。append 失败就吞掉，内存标志照样生效。get 和预览不写。失败的人工写操作同样算已决定（D6）。
- **显式退出**：对没有别名的会话执行 `/fabric alias --clear`，hub 返回 noop 成功（S7），标记照写。文案「已关闭本会话的目录名自动别名」。
- **入口覆盖**：web 命令在 agent 进程内执行，与 TUI 同一路径。飞书在 handler 第一行硬拒，不写标记。

### 5.4 实时提示

- `connection.ts` 新增 `case "xs_alias_evt"`（只在 live 链路上处理）→ `binding.onXsAliasEvt` → `agent/index.ts` 透传给 `xsBridge.onAliasEvt(frame)`。
- `onAliasEvt`：`frame.sessionId` 等于当前 sid ⇒ `reconcile()`，否则忽略。get 拿到 `lost{forced}` 后，经 `applyAliasState` 去重提示，并调用 `publishStatus()`，卡片上的 `@alias` 随之消失。

### 5.5 /new 交接（AF7，照搬 #70 `stashMembershipHandoff` 先例）

- **新文件 `fabric/xs/alias-handoff.ts`**（不依赖 pi）：
  - `XS_ALIAS_HANDOFF_KEY = Symbol.for("pi-subagent:xs-alias-handoff")`；
  - `stashXsAliasHandoff({fromSessionId, alias?, decided, at})`；
  - `takeXsAliasHandoff(now)`：一次性消费；`now-at > 60s` 视为不存在。

  只占一个全局槽，容量 1，TTL 60s，满足 I4。

- **放入**：`fabric/xs/activate.ts` 的 `stashMembershipHandoff(reason)` 中，与 membership 同一时机（`src/index.ts:891`，`session_shutdown`）。只在 `reason==="new"` 时，从 alias cache 读出当前 sid 的 held 别名，并读取 decided 标志。两者都没有 ⇒ 什么也不放（与 #70「原样未动不放」一致）。读失败就吞掉，不交接。
- **取出**：在 `beginSessionStart(ctx, reason)` 里，任何 reason 都先清空槽；只有 `reason==="new"` 时才把取出的内容存为 `pendingAliasHandoff`。fork、resume 永不采用。
- **采用**：
  - 新 stack 构建时，如果 `shot.decided` 为真，立即为**新 sid** 写一条 `via:"inherit"` 的标记，保证 `/reload` 之后仍在；
  - 如果 `shot.alias` 存在，交给 bridge 作为 `pendingHandoff`，由 §5.1 的 ① 在第一次 reconcile 时发出。不要求 joined：交接是延续，不是认领。
- **hub**：继承边（§4）+ `planHandoff`（I10）。router 校验 `predecessorOf(agentKey)?.from === frame.prevSessionId`，且未超过 TTL，否则 `TAKE{stale}`。
- **失败回落**：hub 重启导致继承边丢失、P 在另一进程在线、记录已被他人拿走等 ⇒ stale ⇒ 清空 pending，走 ② auto（新 sid 没有继承到 decided 时才会 auto）。

---

## 6. 设置键

| 键                                      | 类型、默认值 | 生效时机                                  | 落点                                                                                                                                                                                                                  |
| --------------------------------------- | ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fabric.crossSession.alias.autoFromCwd` | bool，`true` | 非 live（stack 构建时冻结，需 `/reload`） | `fabric/settings.ts`：`FabricXsAliasSettings` 加字段；`parseFabricXsAliasSettings` 加 boolean 解析；`DEFAULT_FABRIC_SETTINGS:579` 加 `autoFromCwd:true`。**不写入** `hubCrossSessionConfig`：hub 不感知，hub 字节不变 |

- **setting-specs**：在 `src/fabric/setting-specs.ts` 的 `FABRIC_SETTING_SPECS` **末尾**（`fabric.wake.parkCapPerTarget` 之后）追加 `bool("fabric.crossSession.alias.autoFromCwd", "Auto-claim the cwd basename as this session's alias when free (needs crossSession + alias)")`。这是第一个进入 `/agent settings` 的 crossSession 键。需要**有意更新** `tests/config/setting-specs-pin.test.ts`，并在 commit 中写明理由。
- **默认 true**（D2）：auto 只在 xs on ∧ alias on ∧ joined ∧ hub v2 时动作。代价见 R17。

---

## 7. 文案与确认流程

| 面                         | 文案与规则                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用法                       | `/fabric alias [<名>\|--clear] · /fabric alias <名> --take · /fabric alias <名> --force`。**`--force` 只用于预览，与 `--take`/`--take=<token>`/`--clear` 互斥；任意组合同时出现，或 `--force=<值>` ⇒ 用法错误**，不发任何请求。补全增加 `--force`（「强制抢占（持有者在线也可，需确认）」） |
| TUI force 确认             | 标题 `强制抢占别名「前端」？`；正文 `持有会话：~/ai/foo（自动认领），当前在线。对方会立即收到「别名被强制抢占」提示；此后发给「前端」的消息将改投本会话（已发出的仍送达对方）。`。离线时把「当前在线」换成「已离线 3 分钟」；不是自动认领时省略「（自动认领）」                             |
| web/RPC force              | 回显上面的正文，最后一行仍是固定的 `确认抢占请执行：/fabric alias 前端 --take=<token>（5 分钟内有效）`。`XS_ALIAS_TAKE_CONFIRM_RE` 和 `parseTakeConfirm` **不改**                                                                                                                           |
| take 被拒（online/recent） | 原文案后，若 hub 支持 v2，追加 `可用 /fabric alias 前端 --force 强制抢占（需确认）`                                                                                                                                                                                                         |
| unnotifiable               | `持有会话在线但无法实时通知（版本较旧或未启用跨会话），不能强制抢占；请待其离线 ≥10 分钟后用 --take。`                                                                                                                                                                                      |
| 被抢方提示（forced）       | `别名「前端」已被其他会话强制抢占（对方已人工确认），可以用 /fabric alias 重新设置`                                                                                                                                                                                                         |
| auto 成功（一次）          | `已按目录名自动设置别名 @pi-tools；/fabric alias <名> 可改名，/fabric alias --clear 可取消（之后不再自动设置）`                                                                                                                                                                             |
| /new 交接成功              | 不弹通知。`/fabric status` 照常显示 held                                                                                                                                                                                                                                                    |
| `/fabric status`           | `alias @x held (auto) · lease 7d · cool 10m`；没有别名时 `alias - · auto skip:<off\|decided\|not-joined\|dir\|invalid\|taken\|busy\|hub-cap>`（英文 token）。`autoFromCwd=false` 时不加后缀，与当前版本相同                                                                                 |
| web ChannelsDialog         | 「尝试抢占」返回 online/recent 拒绝，且 hub caps ∋ v2 时，在回显下方显示危险按钮「强制抢占…」。点击后执行 `alias X --force` → 从**本次输出**解析 token → 复用现有确认框（显示该输出和倒计时）→ 执行。i18n 新增 2 条                                                                         |
| 飞书 / agent               | 不变：飞书在 handler 第一行硬拒；prompt 文本正则已覆盖 `alias`（`--force` 属于同一子命令）；没有工具入口                                                                                                                                                                                    |

`webCommandPolicy.fabric=confirm` 时，force 的预览和执行各弹一次通用确认，与 take 相同。

---

## 8. 场景论证

| 场景                       | 行为                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同目录多会话并发接入       | 各会话都发 `auto x`。hub 单写者按到达顺序处理：第一个通过前置检查的进入队列并提交；后来者在前置检查或事务复核时看到记录 ⇒ `TAKEN`，静默跳过（I1）                                                                                                                                                                             |
| `/new`（含 web 清空）      | AF7：旧 sid 的别名经进程槽和继承边就地转给新 sid，decided 标记也随之继承。交接失败 ⇒ 走 auto，通常因旧 sid 仍持有而跳过（R22）                                                                                                                                                                                                |
| fork                       | 新 sid，不采用交接槽，不继承标记（按 sid 校验）⇒ 父会话通常仍持有该名 ⇒ auto 跳过                                                                                                                                                                                                                                             |
| resume / web 恢复          | sid 不变 ⇒ get 返回 held ⇒ 不做任何事；标记从 getEntries 读回                                                                                                                                                                                                                                                                 |
| hub 重启                   | 记录保留；重连时 get 返回 held 或 none；none 且满足条件 ⇒ 再试一次（前置检查很便宜）。继承边丢失 ⇒ 正在进行的 /new 交接回落                                                                                                                                                                                                   |
| 离线超过 7 天              | auto **不接管**过期的 held（I7），只有人工 `set` 能接管；原持有者回来照常持有（R20）                                                                                                                                                                                                                                          |
| cooling 与墓碑             | 他人的 coolingLive ⇒ 跳过；自己的 coolingLive ⇒ 跳过，通常也已有标记。**被 take/force 抢走的一方，凭未满 30 天的墓碑跳过 auto**，这是有意设计，用来防止「被抢 → 重连自动认领 → 再被抢」的来回翻转，以及人与自动路径之间的拉锯。墓碑满 30 天被清理后，或本会话的人执行 set/clear 删除墓碑后（这同时会写入标记），auto 恢复资格 |
| 子会话 / secure            | 不会 auto，也不会交接（§5.1）                                                                                                                                                                                                                                                                                                 |
| 持有者 xs 关闭但连着 hub   | 是 `linked` ⇒ force 返回 unnotifiable；take 仍按 r4（只看 xs-online），离线满 10 分钟后可以抢（不会有实时提示，持有者以后开启 xs 时由墓碑补提示）                                                                                                                                                                             |
| 自动认领挤掉人工意图？     | ① auto 只新建，不动任何已有记录（I7）；② 本会话的人工操作通过「先写后发」的标记永久压过 auto（I8）；③ 别的会话的人可以 take 或 force，预览会标出「（自动认领）」，撞名时提示 `--force`（D5）；④ 人工与 auto 竞争同一空闲名时先到先得，后到的人仍有 force 兜底                                                                 |
| 同名误投（R10 及别名优先） | 寻址规则不变：别名命中即定，不可达 ⇒ NO_TARGET，send 钉住完整 sessionId，degraded 时守卫别名形状的名字。新增风险只有：常见目录名成为某会话的别名（R14）；force 之后，持有过期列表的发送方新发的消息会投到新持有者（R15）。resolve 早于 force 的消息仍按 pin 送达原持有者（§2 对 r4 §5.2 的修订）                              |
| 冷却与步骤 G               | auto 和 handoff 只在 S 名下没有 held 时进行，G 为空操作，不制造 cooling。人工改名后，G 把自动名降为 cooling(S)（与 r4 相同）。force 授予时，G 照常降级 S 原有的 held；被抢的 H 不留 cooling（与 take 相同）                                                                                                                   |

---

## 9. 测试清单

| 层                                                                                                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测 protocol                                                                                        | `deriveAliasFromDirName` 语料：合法、点号、空格、emoji、首字符非法、超长截断（ASCII、CJK、扩展汉字在 16 字形簇和 48 字节边界）、`id_like`、`reserved`（`pi-toolkit` 跳过，不剥前缀）；`isAliasCodePoint` 与 `normalizeAlias` 白名单一致；`xs_alias_evt` schema；带 intent 或 prevSessionId 的 XsReq 能 decode，在旧 schema 快照下整帧被丢弃                                                                                                                                                                                                                                                                                                                                                                                        |
| 单测 alias-suggest                                                                                   | cwd 末段候选 ≡ `deriveAliasFromDirName`（`pi.toolkit` 与 auto 结果相同；跳过的目录不出候选）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 单测 store（`tests/web-hub/hub/xs-alias*.test.ts` + AL1 property 扩展）                              | auto 各行（§4）：过期 cooling 与满 30 天的墓碑**不阻塞**、过期 held **阻塞**、被抢方墓碑阻塞；队列满时「已被占用」的 auto 仍立即返回；force 覆盖 xs-online / linked / 刚离线 / 离线 ≥10 分钟 / 有非 v2 member；presence、rev 变化 ⇒ stale；同一 token 并发两次；mode=take 与 mode=force 不互通；wedged 后晚到成功或失败时是否推送；handoff 的 I10 各条件（P 是 linked 或 xs-online、记录被他人拿走、超过 TTL、S 已有 held）；`forced`、`origin` 的落盘与读回，handoff 保留 origin；**旧版 parseTable 读带新键的文件，结果不是 degraded**；property 新增不变式 I5′、I7、I10                                                                                                                                                         |
| 单测 router / members                                                                                | intent 分派与非法组合 ⇒ BAD_FRAME；无 v2 请求方带 intent ⇒ BAD_FRAME；非 v2 请求方的回包不出现新键；推送只发给被抢 sid 的 v2 member；auto 要求 joined；`isLinked` 闭包（connected、phase、sessionId）；继承边在 onSession 与 onMember 两条路径都写入、TTL、view 消失时清除；audit 新增 reason 取值且不含别名文本、token、prevSessionId；`xs-router-v071-diff` 不变；`hub.json.alias` 不变                                                                                                                                                                                                                                                                                                                                          |
| 单测 agent                                                                                           | `shouldAutoClaim` 真值表；去重键 `(connGen, sid, membershipEpoch)` 只尝试一次、join 后重新获得机会；BUSY 只重试一次（定时器 unref）；auto 通知走独立集合（与 lost 集合互不挤占）；evt → reconcile → `lost` 只提示一次；evt 的 sid 不是当前 sid ⇒ 忽略；旧 hub 不发 intent；标记先写后发（spy 断言 appendEntry 先于 roundTrip）；getEntries 读回、sid 不匹配被忽略、`/tree` 后仍有效；子会话不构造 auto                                                                                                                                                                                                                                                                                                                             |
| 单测 AF7                                                                                             | 只在 `reason==="new"` 时放入；任何 reason 都会消费；fork、resume 不采用；超过 60s 视为不存在；decided 被继承（为新 sid 写 `via:"inherit"` entry）；handoff 失败回落 auto；pending 期间不 auto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 单测命令                                                                                             | `--force` 解析；`--force` 与 `--take`/`--take=<t>`/`--clear` 的各种组合以及 `--force=x` ⇒ 用法错误且零请求；TUI 确认文案（在线、离线、自动认领）；web/RPC 确认行能被 `parseTakeConfirm` 往返解析；飞书在任何请求之前被拒；take 被拒时提示 force；unnotifiable 文案；status 的 auto 后缀；`autoFromCwd=false` 时 status 字节不变                                                                                                                                                                                                                                                                                                                                                                                                    |
| 集成（`tests/integration/fabric-xs-alias-auto.test.ts`，真实 hub 子进程 × 3 个真实 stack，串行启动） | ① A、B 同 cwd 并发 attach ⇒ 恰好一个拿到 basename，另一个 `skip:taken`；② A 持有并在线，C 执行 force（TUI 确认）⇒ 成功，A **不重连**就收到 forced 提示，status 更新；③ **pin 屏障**：B 已 resolve「前端」→ A，随后 C force 拿走「前端」→ B 的 send 仍送达 A；A 离线后再重放同样的顺序 ⇒ NO_TARGET，绝不送达 C；④ 刚离线（`skew` 3 分钟）可以 force、不能 take；⑤ `webCommandPolicy.fabric=confirm` 下 web force 全链路；⑥ A 人工 `--clear` 后重连、hub 重启 ⇒ 不再 auto；⑦ 被 force 的 A 重连 ⇒ 因墓碑不 auto；⑧ 混跑：旧 agent（不声明 v2）在线持有 ⇒ unnotifiable；agent 连着 hub 但 xs 关闭 ⇒ unnotifiable；⑨ `/new` ⇒ 新 sid 拿到原别名（origin 不变），旧 sid 无墓碑；fork ⇒ 不交接；hub 在 /new 之后、attach 之前重启 ⇒ 回落 |
| conformance                                                                                          | **C-X11 不受影响**：工具实例与描述按本地 `alias.enabled` 冻结；头部字段不变；新 entry 是 custom entry，不进入 provider 上下文。不新增 C-X 用例；pi peer 升级前照常跑 C-X1…C-X11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 门禁                                                                                                 | `git diff --quiet origin/dev -- tests/fixtures/`（三份 off golden 和 `legacy-xs-v071/` 不动）；`setting-specs-pin` 有意更新；`governance/activate-trace.json` 不变（不新增注册）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 10. 拆包与文件域

**规则**：`src/stack.ts`、`src/index.ts`、`fabric/xs/activate.ts`、`fabric/xs/stack.ts` 只属于 AFW。**唯一例外是 AF7**：它要改 `activate.ts`、`members.ts`、`aliases.ts`、`router.ts`、`agent/xs.ts`，与 AF1–AFW 都有文件重叠，因此**必须在 AF6 合入之后单独排期**，并且与 AF0–AF6 进入同一个发版（§3.1）。

| 包                | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 冻结面                                 | 依赖     | 估时  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------- | ----- |
| **AF0** 契约      | `protocol/xs.ts`（v2 cap；`intent` 含 `"handoff"`；`prevSessionId`；`XsAliasEvtSchema` 进 `XS_HUB_FRAME_SCHEMAS`；预览与状态新键的类型；`unnotifiable`）；`protocol/messages.ts`（只追加 HubFrame 联合）；`protocol/xs-alias.ts`（`deriveAliasFromDirName`、`isAliasCodePoint`）；`fabric/xs/alias-suggest.ts`（cwd 段改为复用）；`fabric/xs/types-alias.ts`；`fabric/xs/alias-auto.ts`（新，纯函数 `shouldAutoClaim`、`deriveAutoAlias`）；`fabric/settings.ts`；`fabric/setting-specs.ts` + pin 测试 | 旧帧形状；off golden                   | —        | 1d    |
| **AF1** hub 表    | `hub/xs/aliases.ts`（`autoClaim` 含同步前置检查；`forcePreview`；token 的 mode 与 presenceKey；`isLinked` dep 与 `notifiable`；origin/forced 读写；提交钩子 `onForcedCommit`）                                                                                                                                                                                                                                                                                                                         | r4 全部行为                            | AF0      | 1.75d |
| **AF2** hub 路由  | `hub/xs/router.ts`（intent 分派、v2 门控、推送、binding 注入 `isLinked`、audit 的 `sub` 类型扩展）；`hub/xs/members.ts`（`aliasV2Capable`）；`hub/audit.ts`（`XsAuditRecord.reason` 注释列出新取值，类型仍为 string）；`hub/assembly-channels.ts`（cap）。**`hub.json.alias` 不改**                                                                                                                                                                                                                    | 无 v2 请求方的输出与 v0.7.1 差分一致   | AF1      | 1.25d |
| **AF3** agent 桥  | `agent/xs.ts`（caps、intent op、auto 引擎、重试、独立通知集合、`onAliasEvt`）；`agent/connection.ts`（evt case）；`agent/index.ts`（binding 透传）                                                                                                                                                                                                                                                                                                                                                     | slot 顺序；旧 hub 下帧不变             | AF0      | 1d    |
| **AF4** 命令      | `commands/fabric-xs.ts`（`--force` 与互斥校验、标记钩子、文案、status 后缀、补全）；`fabric/xs/alias-decided.ts`（新：entry 类型、读回、`markDecided` 端口类型）                                                                                                                                                                                                                                                                                                                                       | `autoFromCwd=false` 时 status 字节不变 | AF0      | 0.75d |
| **AFU** web       | `ui/.../detail/ChannelsDialog.vue`（force 按钮、cwd chip 复用 derive）；`ui/src/i18n/{zh,en}/detail.ts`                                                                                                                                                                                                                                                                                                                                                                                                | 无 v2 时 UI 字节不变                   | AF0      | 0.5d  |
| **AFW** 装配      | `fabric/xs/stack.ts`（用 getEntries 读标记、persist 端口）；`fabric/xs/activate.ts`（alias 端口增加 `markDecided`、`decided`、`autoFromCwd`、cwd）；`src/stack.ts`、`src/index.ts`（仅在必要时改）                                                                                                                                                                                                                                                                                                     | activate-trace 不变                    | AF1–AF4  | 0.5d  |
| **AF6** 终局      | 集成 ①–⑧；`README.md`（Session aliases 与 Web UI 两节）；`alias-acceptance.md` 增补 §7（force 与 auto 的真机步骤）                                                                                                                                                                                                                                                                                                                                                                                     | —                                      | AFW、AFU | 1.25d |
| **AF7** /new 交接 | `fabric/xs/alias-handoff.ts`（新）；`fabric/xs/activate.ts`（放入、取出、为新 sid 写 inherit 标记）；`hub/xs/members.ts`（继承边、`predecessorOf`）；`hub/xs/aliases.ts`（`planHandoff`）；`hub/xs/router.ts`（handoff 分派与继承边校验）；`agent/xs.ts`（`pendingHandoff` 与 reconcile 的 ①）；集成 ⑨；README 补一句                                                                                                                                                                                  | 同上                                   | AF6      | 1.25d |

```
AF0 → { {AF1 → AF2} ∥ AF3 ∥ AF4 ∥ AFU } → AFW → AF6 → AF7
```

- 合计约 **9.25 人日**。
- 关键路径：AF0(1) → AF1(1.75) → AF2(1.25) → AFW(0.5) → AF6(1.25) → AF7(1.25) ≈ **7 天**。
- AF3、AF4、AFU 只依赖 AF0 的类型，与 AF1/AF2 没有文件重叠，可以并行。AF3 的 auto 引擎可以用 fake hub socket 单测。

---

## 11. 残留风险（续 r4 R1–R13）

| #   | 残留                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R14 | 常见目录名（`web`、`app`、`src`）被第一个接入的会话占成 hub 全局别名；不同父目录下的同名目录之间也是先到先得                                                                                                                                                                                                                                                          |
| R15 | force 之后，持有过期列表或 mention 缓存的发送方，新发的消息会投到新持有者（比 R5 更强：旧持有者是在线时被抢走的）。确认文案已明示                                                                                                                                                                                                                                     |
| R16 | 同一会话在两个进程中打开时，标记只在写入它的进程立即生效。另一个进程要等它看到的 cooling 和墓碑都消失后，才可能在下次 hello 时 auto（I7 已拦住大部分情况）                                                                                                                                                                                                            |
| R17 | 升级前做过的人工 clear 没有标记：cooling 被清理后，该会话可能 auto 一次（再执行一次 `--clear` 即可关闭）                                                                                                                                                                                                                                                              |
| R18 | hub 降级到旧版后，下一次写盘会丢掉 `origin`/`forced`（只影响显示）                                                                                                                                                                                                                                                                                                    |
| R19 | 旧版 agent，或 xs 关闭但连着 hub 的持有者，在线时不能被 force，只能等它离线（xs 意义上）满 10 分钟后 take，而且没有实时提示                                                                                                                                                                                                                                           |
| R20 | auto 从不接管过期记录：已经不再使用的会话会一直占着 basename，直到人执行 set、take 或 force                                                                                                                                                                                                                                                                           |
| R21 | hub 重启后的首次认领潮可能出现 BUSY；agent 只重试一次，失败则等下一次 hello                                                                                                                                                                                                                                                                                           |
| R22 | /new 交接的窗口是 hub 内存中的继承边（120s）加进程槽（60s）。hub 在此期间重启、或新 stack 迟迟未 attach ⇒ 不交接，旧名留在旧 sid 上直到 take 或 force                                                                                                                                                                                                                 |
| R23 | 推送是尽力而为。socket 写失败时，被抢方要到 reattach 才收到提示（墓碑兜底）。**如果被抢方永不 reattach**（推送丢失但链路仍判 live，或进程长期挂起），它本地的 `/fabric status`、卡片 `@alias`（`StatusInfo.xs.alias`）会一直陈旧，直到下一次 hello_ack、attach 或 `/fabric status` 触发对账。hub 侧权威数据已经改变，寻址与投递不受影响，只是显示陈旧。**判定为接受** |

---

## 12. 待拍板

无。D1–D6 已拍板（见下）。

---

## 用户拍板（2026-10-27）

- D1：命名用 `--force`，执行沿用 `--take=<token>`（主会话按推荐定）。
- D2：`autoFromCwd` 默认 true（主会话按推荐定）。
- D3：做 AF7，`/new`（含 web 清空）把别名交接给新会话；fork 不交接。
- D4：目录名命中保留前缀或像 id ⇒ 直接跳过（不剥前缀）。
- D5：人工 set 撞上自动认领的名字 ⇒ 照常「已占用」并提示 `--force`。
- D6：任何人工写操作（含失败）都算「人工已决定」（主会话按推荐定）。

---

## r2 修订对照表

| #   | 评审（kimi r1）要点                                               | 处置                                                                                                                                                                                  | 落点                                     |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | 持有者连着 hub 但 xs 关闭，被判为离线，force 可立即抢走且永不提示 | 采纳（主会话裁定）：引入在场三态，`linked` ⇒ 永远 `¬notifiable` ⇒ force 返回 unnotifiable；take 仍按 r4 只看 xs-online（10 分钟门槛）；新增 `isLinked` dep（registry 闭包）；写入 I5′ | §0、§2、§4、§7、§8、§9 store/集成 ⑧、R19 |
| 2   | 显式修订 r4 §5.2「被抢方必然已离线」，并补集成测试                | 采纳：§2 写明新口径（resolve 早于 force ⇒ 按 pin 送达原持有者；原持有者离线 ⇒ NO_TARGET；绝不改投）；新增集成 ③ pin 屏障                                                              | §2、§7 确认文案、§8、§9 集成 ③           |
| 3   | `--force` 与 `--take=<token>`、`--clear` 互斥                     | 采纳：`--force` 只用于预览；与 `--take`/`--take=`/`--clear` 任意组合或 `--force=x` ⇒ 用法错误，零请求                                                                                 | §7 用法行、§9 单测命令                   |
| 4   | auto 表第 3 行的条件                                              | 采纳：x 有 live 记录（未过期 held、coolingLive）⇒ TAKEN；过期 cooling 与墓碑经 prune 或读时谓词视为无记录；过期 held 仍阻塞（I7）；I7 同步改写                                        | §2 I7、§4                                |
| 5   | §8 cooling 行：说明墓碑的作用                                     | 采纳：被抢方凭 30 天墓碑跳过 auto，有意防止来回翻转；墓碑清理后或本会话人工 set/clear 后恢复资格                                                                                      | §8                                       |
| 6   | 依赖图与表格不一致                                                | 采纳：`AF0 → { {AF1→AF2} ∥ AF3 ∥ AF4 ∥ AFU } → AFW → AF6 → AF7`                                                                                                                       | §10                                      |
| 7   | 拆包规则需注明 AF7 例外                                           | 采纳：AF7 是唯一可以碰 AFW 独占文件的包，须在 AF6 合入后单独排期，并与 v2 同一发版                                                                                                    | §10 规则、§3.1                           |
| 8   | 去重键措辞                                                        | 采纳：三元组 `(connGen, sessionId, membershipEpoch)`，并说明三项各自的来源                                                                                                            | §5.1                                     |
| 9   | alias-suggest 复用 derive，保证 chip 与 auto 一致                 | 采纳：`alias-suggest.ts` 与 web chip 的 cwd 段都改用 `deriveAliasFromDirName`；`alias-suggest.ts` 列入 AF0，web 列入 AFU                                                              | §1 S16、§5.2-6、§9、§10                  |
| 10  | auto 通知去重不应挤占 lost 的 64 上限                             | 采纳：独立集合 `pi-subagent:xs-alias-auto-noticed`，上限 32                                                                                                                           | §5.1                                     |
| 11  | 估时偏低                                                          | 采纳：AF6 改为 1.25d，AF1 改为 1.75d（含 linked），AF2 改为 1.25d，AF0 改为 1d（含 handoff 字段和 suggest）；合计 9.25 人日，关键路径 7 天                                            | §0、§10                                  |
| 12  | audit reason 新取值、类型同步；`hub.json.alias` 不动              | 采纳：`sub` 扩展为含 `auto`/`force-preview`/`handoff`，`XsAuditRecord.reason` 注释同步，audit 不写敏感字段；声明 `hub.json.alias` 不变；AF2 文件域补 `hub/audit.ts`                   | §3.4、§4 audit、§10 AF2                  |
| 13  | R23 补写「永不 reattach」的陈旧窗口                               | 采纳：写明本地 status 和卡片显示陈旧、寻址不受影响，判定为接受                                                                                                                        | R23                                      |
| —   | D3 已拍板「做」：确认 AF7 足以施工                                | 补全 §5.5（进程槽 API、放入与取出时机照搬 #70 的 `stashMembershipHandoff`/`beginSessionStart`、decided 继承、回落路径）、§4 继承边、I10、AF7 文件域与测试                             | §2 I10、§4、§5.5、§9 AF7/集成 ⑨、§10     |
| —   | D4 已拍板「跳过、不剥前缀」                                       | 正文统一为跳过；从 D 选项中移除剥前缀方案                                                                                                                                             | §5.2-5                                   |
