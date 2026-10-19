# 飞书机器人：`/list` 一键切换会话卡片（session-card）实施计划 r3

状态：计划 r3（2026-10-19，只读调研；响应 review r_AVHES5BY 的 F1–F9 与复审 r_8M8P13GG 的 N1–N6）。不改 plan.md；兼容 §4.3 nonce、§6.3 ask 卡、§R2-f、F6 `/use`。无新 settings。

## 修订记录

- r1 → r2：用户裁定 (A) 卡片**可复用**；(B) **已授权**的有效点击遇目标过期/离线 ⇒ 整卡关闭，未授权/nonce 不匹配永不触发关闭。重写每卡控制器、supersede 栅栏、PATCH 语义、nonce 配额、>8 会话规则、key 命名与测试（关闭 F1–F9）。
- r2 → r3（保留 r2 全部已通过机制，仅在 N 项迫使处修改）：**N1** 卡片生命周期改由持久化的**锚点记录**权威表示（不再用「兄弟 nonce 存活」推断）并加只读枚举端口；**N2** 开卡配额引入「槽位」（同步预占 → 落盘锚点计数 → 绝对过期定时回收，列明释放条件）；**N3** PATCH 逻辑 deadline 与物理 IO 所有权分离（`createFeishuWork` 持槽至真实 settle）；**N4** 所有持久化屏障显式检查 `commit()===true`，定义 persist-failure 处理；**N5** 每按钮 `active+pending` 映射与幂等补发；**N6** 出队顺序改为授权最先。
- 用户已冻结的裁定不动：可复用、失败关卡、>8 不分页、16/4 开卡上限 + 384/512 nonce 子配额、SW2 发布门槛、unknown-effect ⇒ 关卡、`route-${eventId}` 超长另案。

## 0. 决策

- **D1 不加 `/switch`**；`/list` 即一键入口。**D2 卡片是附加物，文本是底座**：`/list` 仍登记 list generation，降级纯文本时 `/use n` 照常。
- **D3 点击不依赖 list 窗口**：权威来自服务端自存的 nonce target（客户端只回传 `n`）+ 点击时 live 校验。**卡片不带编号**，用 `名称 · sid6 · 状态`，提示 `/use <sid前缀|名称>`。
- **D4 可复用（A）**：成功点击保留卡片，只为被消耗按钮补发 1 个 nonce 并刷新卡面。**D5 失败关卡（B）**：已授权有效点击遇离线/ambiguous/read-only/过期 ⇒ 整卡关闭。
- **D6 跨卡/文字**：后执行的 `bindings.set` 获胜；同 session 再点 ⇒ no-op。rev 变更只作废**尚未派发**的请求；已被 agent 接受的任务仍可能带原标签回原话题（既有 `/use` 语义）。
- **D7 不在 `/cur`/终回复加切换按钮。**

## 1. 卡面与 >8 会话规则（不变）

- 可点行 = live 且 `state ∈ {busy,idle,waiting}`；行序同 `sessions.rows()`。常量（`FEISHU_CAPS`）：`listCardMaxButtons:8`、`listCardMaxRows:40`、`listButtonLabelMax:36`cp、`listCardsOpenGlobal:16`、`listCardsOpenPerOperator:4`、`noncesReservedForOthers:128`、`listCardPatchIoMax:8`。
- 前 8 个可点行出按钮；全部行（≤40）以紧凑文字行 `名称(≤16cp)·sid6·状态` 列在正文，第 9 个起用 `/use <sid6>`；>40 行尾行「另有 M 个未显示」。不分页；JSON ≤20 000B，超出砍文字行到 20，仍超 ⇒ 文本降级。label 清洗按 code point 截断（surrogate 安全），sid6/state 不截。

## 2. 每卡控制器与持久化清单（`session-card.ts`）[N1][N5][N6]

- **锚点记录（权威生命周期）**：每张卡在 nonce 表中有 1 个 `action:"session-card"` 的**锚点 nonce**（随机、不渲染进卡面、客户端无从得知；`target={c:cardId,k:key}`，operator/chat/message/`expiresAt` 同卡）。**卡片 open ⇔ 锚点存在且未过期**，与按钮 nonce 是否被 redeem 无关。锚点与全部按钮 nonce 在**同一次 commit(true)** 内落盘，且**先于**把按钮 PATCH 上卡面——所以任何点击都只可能发生在锚点已持久之后。nonce 表因此是唯一持久清单，不加新表/不改 state schema；空间 ≤16×(8+1)=144，仍在 384 自用上限内。
- 新增 state 只读端口 `nonces.list(match?)`（克隆、≤512，`live()` 守卫）；另 `nonces.purge(match)`、`issue(…, ttl, {maxTotal})`（§6）。
- `Ctl={cardId, operator, key, epoch, expiresAt, tail, queue(≤16), state:"open"|"frozen"|"closed"|"degraded", slots:Map<sessionId,{nonce?:string,pending:number}>, ioInFlight}`；对卡的一切副作用挂同一 `tail` 串行；`closedRecent` FIFO 64。
- **按钮映射与不变量 [N5]**：每个展示按钮的 slot 满足 `active(0|1)+pending==1`（pending=已 redeem、已入队、未执行的点击，视为「已欠一个 token」）。`pick()` 入队时同步 `slot.nonce` 置空、`pending++`（校验 `record.nonce===slot.nonce`，否则丢弃）。补发规则（幂等，以 sessionId 为键）：仅当 `active+pending==0` 才 issue；执行某点击时先 `pending--`，成功后若 `active+pending==0` 补发恰 1 个。对账（成功/重启/刷新）遇 `pending>0` 的按钮**不补**——其点击出队时自会补，故不会双发；静止（队列空）时每按钮恰 1 个 active。队列满拒绝的点击（token 已耗）靠下一次对账自愈。
- **出队顺序（N6，授权最先）**：①授权：`allowList.has(sender)` ∧ `admission.authorize(identity)` ∧ operator==Ctl.operator ∧ installGen 一致——任一不满足 ⇒ **静默 return，不发任何回复、不做清理副作用**（仅内部 `pending--`；被 deny 时 service 调 `sessionCard.revokeOperator(openId)` 静默丢弃该 operator 的 Ctl/槽位，不 PATCH、不 notice，nonce 已被 `purgeOperator` 清）；②卡状态：`closed/frozen/degraded` 或在 `closedRecent` ⇒ 回「卡片已关闭，请重新 /list」不改 binding；无 Ctl 时按锚点查（nonce 表中有该 messageId 的 `session-card` 锚点 ⇒ 懒重建，否则视为已关闭）；③过期（`record.expiresAt<=now` ⇒ 关卡）；④栅栏（§4）；⑤key 一致性（§3）；⑥`sessions.resolve` 失败 ⇒ 失败关卡（§5 屏障）；⑦成功：同 session no-op，否则 `bindings.set`，同步补发（按上条规则）与对账；`await barrier()`；再 notice → 刷新 PATCH。
- **绝对过期**：初始整卡先算一个 `expiresAt`，所有 nonce（含锚点、补发）用 `ttl=expiresAt−now`，不续期。Ctl 持有 unref 的 `clock.setTimeout(expiresAt−now)`（≤24h < 2³¹ms）：到点走关闭路径（purge+barrier+best-effort PATCH「已过期」）——因此过期回收**不依赖点击**，且 inbound 对过期 nonce 的拒绝不会让配额泄漏。
- **启动采纳**：`start()` 枚举锚点，过滤未过期、按 `createdAt` 取最新 16 张（超出者及同 `(operator,key)` 重复者防御 purge+commit），建立 Ctl/槽位/定时器；slot 从存活按钮 nonce 恢复，缺失者 `active+pending==0` ⇒ 自动补发并刷新一次 PATCH（串行、≤16 次）。**单按钮卡唯一 nonce 已被 redeem、或同卡兄弟被同时 redeem**：锚点仍在 ⇒ 卡仍 open，点击正常执行并补发——不再被误判为已关闭。

## 3. 绑定 key 校验（不变）

router **不改**；service 用 `feishuBindingKey` 重算 key 写入 nonce target（服务端自存）。点击解析 `k`：p2p ⇒ `p2p:<chat>`；群 ⇒ `grp:<chat>:<thread>`（threadId 必须存在）；`parsed.chatId===record.chatId`；已有 binding ⇒ chatType/chatId/threadId 全一致，否则拒绝（不关卡，日志）；无 binding ⇒ 用解析值首次建立（未绑定话题合法）；`bindings-full` 给文案；**绝不**回落 p2p。回执目标沿用 relaunch 做法。

## 4. 栅栏 + 开卡槽位 [F2][N2]

- `slots(fence): Map<"operator\nkey",{epoch, ctl?}>` 同时是**开卡配额槽位**：全局 ≤16、每 operator ≤4。`/list` **同步**占槽（`size>=16` 或 operator 已 4 ⇒ 文本降级；同 `(operator,key)` 复用原槽并 `epoch=++seq`）——预占发生在 `sendCard` 返回 messageId **之前**，故并发 `/list` 不会超卖。
- 流程（每个 await 后重验 `slots.get(k).epoch===mine`，不属于本卡 ⇒ 停止，不 issue/PATCH）：purge 旧卡（谓词 `messageId` 属该 key 的旧 Ctl，含锚点）+ `barrier()` →（false ⇒ 不发卡，文本降级）→ `sendCard`（无按钮）→ 重验 → issue 锚点+按钮 + `barrier()` → 重验 → PATCH。旧卡走 supersede 链（关 Ctl、best-effort PATCH「已被新列表取代」）。
- **槽位释放条件**：卡关闭（失败/过期/取代后新卡也失败）、`sendCard` 返回 `undefined`（含 30 s 超时）、屏障 false 且无法建卡、`revokeOperator`、dispose（内存清空，锚点留盘待 TTL/下次采纳）。启动时槽位由未过期锚点重建（重启即满额仍满额）。在途 `sendCard` 晚到：槽已被释放/换 epoch ⇒ 不 issue，留下的只是无 nonce 的文字卡。
- 持久化不变量：同 `(operator,key)` 最多一张持锚点的卡。

## 5. PATCH 的逻辑 deadline 与物理 IO 所有权 [F4][N3]

- 端口 `patchTracked(ctl, card) → {ok:true,version}|{ok:false,effect:"none"|"unknown",denied?}`，内部分两层：
  - **物理 IO 由 `createFeishuWork(clock,onError,listCardPatchIoMax=8)` 持有**（槽位随真实 promise 生命周期，同 `runtime.ts` 既有语义）：`run(()=>api.patchCard({messageId,card,signal,timeoutMs:8000}))`；`run` 返回 false（满载/含 zombie）⇒ **未发起**，`effect:"none"`，该卡按失败处理。**禁止**用 `bounded()` 放弃式竞速；每卡 `ioInFlight` 仅在真实 promise settle 时清除，**未 settle 前绝不发第二个 PATCH**。`token.get` 等待受同一 `AbortSignal` 约束；abort 后仍不 settle 的调用保留其 IO 槽（zombie），直到真实结束或 dispose。
  - **逻辑 deadline（`clock.setTimeout` 8 s，unref）独立于 IO**：到点 ⇒ Ctl `frozen` + `abort()` + 同步 purge nonce + `barrier()`；不等 IO。frozen 卡不再 PATCH；真实 promise 之后 settle 时做**至多 1 次**收尾 PATCH（「已停用，请重新 /list」），仍失败放弃。仅可证明被拒（校验/明确 4xx/`card-too-large`）为 `none`，网络/超时/abort 一律 `unknown`；denied ⇒ `capability("cards",false)`。`sendList` 发卡前若 `work.size>=8`（zombie 占满）⇒ 文本降级。
  - dispose：abort 全部 controller、`work.close()`；zombie 晚结果被 `disposed` 代际丢弃，不再 commit/notice/PATCH。
- 既有 service `patch()`（`bounded` 会 throw）**不动**，session-card 不用。顺序：barrier(true) → notice（独立入队、异常隔离）→ PATCH；PATCH 失败不回滚 binding，也不吞 notice。
- 逻辑发送身份（≤100，符合 `REQUEST_ID_RE`/`NOTICE_KEY_RE`）：初始卡 `fl${feishuKey("list:"+gen+":"+operator+":"+m.messageId)}`；文本降级 key `fx${feishuKey("listtext:"+gen+":"+m.messageId)}`；点击回执 `fp${feishuKey("pick:"+eventId)}`；关卡回执 `fq${feishuKey("pickq:"+messageId)}`。同 requestId 的 outbox 重试沿用同 uuid。降级：`caps.cards==="denied"` 或 `sendCard` 返回 `undefined` ⇒ 今天的文本列表（`renderListText` 原样保留）。

## 6. 持久化屏障与 persist-failure [N4]、nonce 配额 [F5]

- `barrier()` = `(await state.commit())===true && !state.persistFailed()`（`commit` 失败/1.5 s 超时返回 **false 而非 throw**，且 false≠「一定未落盘」，一律按未知处理）。**每个**屏障（失败关卡、supersede purge、补发/锚点 issue、过期关闭）都显式检查：
  - 失败关卡 barrier false ⇒ 不声称已关闭、不 PATCH：Ctl→`degraded`（内存已 purge，不再接受点击/补发/PATCH），尽力发一条「状态保存失败，请稍后重试 /list」notice（吞异常）。
  - 成功路径 barrier false ⇒ binding 已在内存变更但不报成功；撤销本步新发 nonce（内存 purge），不刷新卡面；Ctl→`degraded`。
  - supersede/初始 issue barrier false ⇒ 不发卡 / 不 PATCH 按钮（卡保持文字），回滚本步 nonce，释放槽位。
  - **恢复**：`onHealth(persistFailed:false)` 时 service 调 `sessionCard.onPersistRecovered()`：对每个 `degraded` Ctl 至多重试一次「purge+barrier(true)→PATCH 封闭卡→补发最后一次成功 notice」；仍 false 则保持 degraded（等下次恢复事件，无定时重试）。崩溃时以落盘状态为准（卡可能 open，点击仍全量重验）。
- nonce 配额：`issue(…,{maxTotal})`，session-pick/锚点以 `maxTotal=cap−128` 发行（别的卡永远保有末 128）；每卡活跃 ≤8+锚点；任何 `cap/budget/maxTotal` 拒绝 ⇒ 该行无按钮/整卡文本；purge 仅限本模块谓词，不踢他人 nonce。

## 7. 文件归属

| 文件                                                    | 改动                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/protocol/feishu.ts`                        | `FEISHU_CAPS` 加 §1 常量                                                                                                                                                                   |
| `src/web-hub/hub/feishu/state.ts`                       | `nonces.list/purge`、`issue` 第三参 `{maxTotal?}`；接口+实现                                                                                                                               |
| `src/web-hub/hub/feishu/session-card.ts`（新，pi-free） | 卡面/label/`renderListText`；控制器、槽位栅栏、锚点/slots、IO work、屏障与 degraded；`sendList/pick/revokeOperator/onPersistRecovered/start/dispose`                                       |
| `src/web-hub/hub/feishu/service.ts`                     | 装配：`list` 分支→`sendList`；`inboundIntent` 加 `session-pick`；`patchTracked` 适配（含 work 构造）；deny/replace 处调 `revokeOperator`；`onHealth` 恢复钩子；`start` 采纳；HELP；dispose |
| `router.ts` / `sessions.ts`                             | 不改（断言：未绑定话题 `/list` 产生 intent 且 key 可重算）                                                                                                                                 |
| `README.md` / `acceptance.md`                           | `/list` 行补卡片/复用/降级；新增 SW1–SW5（§9）                                                                                                                                             |

## 8. 测试

`session-card.test.ts`（新；ports 用**受控 deferred promise** 卡住 commit/sendCard/PATCH，commit 可注入 `false`）：

- T1 A→B→A 复用：binding 三次 set；每步恰补发 1 个；静止时每按钮 1 active、总数 ≤8；绝对过期不延。
- T2 失败关卡：授权点击遇离线 ⇒ purge→barrier→notice→PATCH 顺序；**commit=false ⇒ 不 PATCH、不声称关闭、degraded**，恢复后补完；未授权/mismatch 不关卡；已 redeem 排队点击被 closed 拒绝。
- T3 排队：A、B 两点击先后 redeem、卡在 commit；断言两次合法切换**按序**执行、无重复 token（A 补发时 B 不补，B 出队再补），最终 A2/B2 各一个。
- T4 卡住的 `sendCard` + 新 `/list`（栅栏）；supersede barrier=false ⇒ 不发新按钮、文本降级；在途 PATCH 期间 supersede 不并发 PATCH。
- T5 PATCH：永不 settle ⇒ 8 s 逻辑 deadline 后 frozen+purge+barrier(true)、IO 槽仍占、无第二个 PATCH；晚完成 ⇒ 槽释放、恰 1 次收尾；dispose ⇒ abort、无后续副作用；8 个 zombie 满载 ⇒ `sendList` 文本降级；`commit=false` 变体；PATCH 抛错不吞 notice、binding 不回滚。
- T6 过期：补发 `expiresAt` 不延；定时到点关闭回收；**无点击也回收**；inbound 拒绝的过期点击不泄漏槽位。
- T7 配额：并发 17 个 `/list`（卡住 `sendCard`）⇒ 恰 16 卡 +1 文本；重启即满额仍满额；`cap−128` 拒发而 ask/approval/file 仍可发；每 operator 4；跨 chat 耗尽后 ask/approval 存活。
- T8 key：未绑定群话题首次绑定；既有 binding 不一致拒绝；不回落 p2p；200 字符 eventId/messageId 下各 key 合规；同一 `/list` 重投幂等。
- T9 重启：**单按钮卡其唯一 nonce 已被 redeem**、**全部兄弟同时被 redeem** ⇒ 锚点仍在，卡 open，点击正常执行并补发；多卡/超 16 防御清理；采纳时缺失按钮自动补发。
- T10 授权：**排队期间 sender 被 deny** ⇒ 无 notice、无 binding 变化、无 PATCH、无「已关闭」回复；`revokeOperator` 静默。
- `state.test.ts`：`list/purge/maxTotal`、过期扫描、持久化往返。`service.test.ts`：沿 `rig/callbackEnvelope/sentContent` 端到端 + cards denied 降级 + `cardCallback` 置 ok。回归：`router/sessions` 既有全绿。
- 集成 `web-hub-feishu-bot.test.ts`（沿 FB2/FB4，重启用既有 `crash/stop`）：`SW1` A→B→A；`SW2` agent 下线点击 ⇒ 卡关闭、第二用户点击不关卡；`SW3` 快速两次 `/list` 旧 nonce 全消；`SW4` 重启后点旧卡（含单按钮卡）；群话题独立。
- 门：`npm run format:check && npm run typecheck && timeout 900 npx vitest run tests/web-hub/hub/feishu tests/integration/web-hub-feishu-bot.test.ts && npm run build`。

## 9. acceptance.md 新增行（真租户）

| ID  | 操作                                                                                                   | 预期 / **可接受线**                                                                                                                                                              | 先看        |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| SW1 | ≥2 会话私聊 `/list`，中文/emoji/超长名；点 A、再点 B、再点回 A                                         | label 不乱码/溢出；每次点击后 ≤3 s 卡面刷新、`/cur` 一致、请求只送当前会话                                                                                                       | F、B outbox |
| SW2 | 观察点击后客户端表现（ACK 无卡片响应，R1 cut）；离线某会话后点其按钮                                   | **可接受**：短暂提示且按钮仍可再点、效果正确；**不可接受**：持续错误态/重复回调/卡片点不动 ⇒ 卡片能力不随版发布（`sendList` 退回文本，一行回滚），另立 card-response-in-ACK 议题 | F、B、A     |
| SW3 | 群两话题各 `/list`；非发起人点击；未绑定话题首次点击                                                   | 非发起人无效且卡不关；话题独立；未绑定话题可首次绑定                                                                                                                             | F thread、B |
| SW4 | 9+ 在线 / 21+ 行 / 41+ 行；cards 被拒时 `/list`                                                        | 前 8 有按钮，其余文字可见并可 `/use <sid6>`；>40 有尾行；cards 被拒回纯文本                                                                                                      | B caps      |
| SW5 | 卡片点击与 TUI/web 切换、`/list` 重发近同时；hub 重启后点旧卡（含只剩一个按钮的卡）；卡片放置超过 24 h | 无陈旧绑定；旧卡被取代；重启后卡仍可用；过期卡不再可点且名额回收                                                                                                                 | A、B        |

## 10. 残留（披露）

PATCH 结果 unknown 时客户端可能暂留失效按钮（点击静默无效，文字仍可用）；persist-failure 期间 binding 可能已在内存生效而用户暂未收到成功回执（恢复后补发，崩溃则以落盘为准）；`closedRecent` 等进程内状态重启后靠锚点兜底；>40 行不可见名称；label 长度上限与 toast 行为待真租户（SW1/SW2）。

## 施工门槛（r3 复审 pass-with-changes，2026-10-19）

- G1: session-pick 用控制器自持有的同步入队，或显式处理外层 `work.run` 的 false 返回（修复按钮状态/忙提示）；不改通用 work 池。补外层满载时的消费/恢复/无 binding 写入测试。
- G2: 装配硬约束——库存/槽位初始化完成后才 `connector.start()`；T9 分测启动后首次点击 / 同进程排队 / 崩溃后只补新按钮不重放旧点击。
- G3: degraded 恢复只补偿「尚未确认回执的成功分支」，用原稳定 key；失败关闭不生成成功回执；恢复进同一 tail、防重入；成功封闭后 closed + 释放槽。
- G4: `revokeOperator` 要真正取消：标记撤销、清定时器、abort；所有迟到收尾/恢复副作用检查撤销与代际；物理 IO 名额仍等真实 settle。补 deny 后迟到完成与到期触发测试。
- 复审附带核对：锚点计入 nonce 表上限与字节预算（≤144 条）；purge 要同时删锚点与按钮；锚点签发失败整卡文本化；T7 的 17 个并发 /list 要分布到 ≥5 个 operator。
