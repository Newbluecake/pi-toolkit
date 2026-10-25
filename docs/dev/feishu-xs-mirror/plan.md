# 飞书镜像「未唤醒的跨会话来信」— 施工方案 r3

> 作者：方案子 agent · r1 2026-10-23 11:34 · r2 11:57（处置评审 r1，见 §R1）· **r3 12:10**（处置复审 r2：0 Blocker / 3 Major / 2 Minor，见 §R2；镜像改为单队列 + 单 worker）
> 基线：`master` HEAD `9337d93d`（v0.8.0，含频道/别名）。前置调研：`explore.md`（§1 订正其关键结论与行号）。
> 本文是**唯一施工口径**；只是方案，不含代码改动。

---

## 0. 决策摘要（一页）

### 0.1 拍板（用户 2026-10-23，全部已定，无未决项）

| #      | 决策                                                                                                                                         | 本方案落实                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | 新开关 `feishuBot.xsMirror`，**默认开**，非 live（`/reload` 后 `/webhub restart`）                                                           | settings.ts / protocol/feishu.ts / setting-specs.ts 三处 + `buildHubConfig` 一行（§5）；关闭后重启**丢弃**已落盘未发出的镜像通知（§4.6） |
| D2     | 范围：所有**未唤醒**的跨会话来信——deliver-only 点对点、频道广播、迟到回复；**不含** NoticeGate 系统提示（`subagent:xs-reply`）               | 判定谓词 §3.2；NoticeGate 只在 agent 本地写，hub 观测点看不到，天然排除（§3.3）                                                          |
| D3     | 只推私聊（p2p）绑定，群聊绑定永不推                                                                                                          | `chatType==="p2p"` ∧ key 以 `p2p:` 开头，双重过滤（§4.3）                                                                                |
| D4     | 卡片带来源标注（别名=hub 核验、会话名=对方自报需标注、频道广播标记），正文截断 1500 字，全部走现有转义                                       | `renderXsMirror`（render.ts），只用仓库已真机验证过的卡片元素（§4.5）                                                                    |
| **Q1** | **路线 A′：hub 侧 xs_ack 观测**（不加 agent 帧、不加 cap）                                                                                   | §2；附录 B 留存方案 A 增量仅作记录                                                                                                       |
| **Q2** | **会话忙时排队的消息（`unknown{queued}`）也推**，卡片标「送达未确认」                                                                        | §3.2 真值表；常量 `XS_MIRROR_QUEUED = true`                                                                                              |
| **Q3** | **被 deny 用户的私聊绑定与现有 done 通知一致**，记残留 R3；**另开跟进**「deny 时清理该用户绑定」（同时修 done 通知与镜像，不在本特性分包内） | §6 R3；AGENTS.md 只按此口径记录                                                                                                          |

### 0.2 新的待拍板问题

无。r2/r3 引入的数值（逐卡预算、队列/在队/槽位/字节余量、单卡字节）均为实现参数，取值与理由见 §4.3/§4.4，后续只改常量。

### 0.3 可靠性边界（一句话承诺）

**A′ 是基于「及时、有效 ack」的 best-effort 镜像，不是「所有实际写入的来信必达飞书」。** ack 丢失、hub 超时后才到的迟到 ack、ack 已结算但通知尚未落盘时 hub 崩溃、镜像预算/容量超限，都可能使某条来信不被镜像（后者会以尾注计数提示）。绝不为补镜像而重发原 xs 消息。

---

## 1. 对调研的核实与订正（HEAD `9337d93d`）

| explore.md 说法                   | 核实结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| quiet xs 消息对 hub「完全不可见」 | **部分订正**：会话事件流（`ev`）确实看不到（K7④ 成立）；但 hub 的 xs 路由**转发**了这条消息，并收到 `xs_ack`。`router.ts:713-777`（send 结算）、`broadcast.ts:250-292`（逐行）+ `294-330`（整批聚合）在闭包里同时持有 `xs_deliver` 与 ack。→ A′ 依据。                                                                                                                                                                                                                                                                   |
| 写出路径 `receiver.ts:468-482`    | deliver-only 写入 `receiver.ts:466-483`（`sendMessage` 在 468），判决分支 535-576（`queued` 551-556、`applied` 558-570、`accept_unverified` 572-575）；Controller 唤醒路径 392-435。                                                                                                                                                                                                                                                                                                                                     |
| `stack.ts:1780 / 1893`            | 共享 host `stack.ts:1776-1801`（`sendMessage` 1780）；NoticeGate quiet host `1891-1896`；`deliver` 入口 `2011-2020`。                                                                                                                                                                                                                                                                                                                                                                                                    |
| agent 侧 ack 出口                 | `src/web-hub/agent/xs.ts:617-643`（`onDeliver`：同步 `stack.deliver` 得 verdict 后才发 `xs_ack`）。                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 飞书 `service.ts:1518-1540`       | `event()` 在 `service.ts:1505-1568`；runtime 内 outbox/budget/notify/security 在 449-494；`bindingTarget` 439-448；`label` 420；`link` 421；`settled()` 968-1012；runtime `start()` 1593-1610（`outbox.start()` 在 1606）。                                                                                                                                                                                                                                                                                              |
| `notify.ts:66-84`                 | `session()` 在 `notify.ts:66-101`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 设置 `settings.ts:1190-1203`      | `FeishuBotSettings` 50-66；`DEFAULT_FEISHU_BOT_SETTINGS` 1195-1205；`parseFeishuBotBlock` 2860 起；`setting-specs.ts` feishuBot 段 1162-1218。                                                                                                                                                                                                                                                                                                                                                                           |
| protocol                          | `FEISHU_BOT_DEFAULTS` `protocol/feishu.ts:663-673`；`FeishuBotHubConfig` 687-701；`normalizeFeishuBotHubConfig` 718-743；`buildHubConfig` 的 feishuBot 段 `agent/index.ts:1416-1428`；hub 侧重校验 `hub/main.ts:182-192`。                                                                                                                                                                                                                                                                                               |
| 其它关键事实（r2 补核）           | `createFeishuWork.run()` 关闭或满 256 槽时**返回 false 且不执行任务**（`runtime.ts:31-57`）；outbox notice 只能用 `cap − 64` 槽（`state.ts:1949-1954`），且受 4 MiB 状态字节预算；onSettled 正常返回后 outbox **立即删除**组记录（`outbox.ts` checkGroup，`FeishuOutboxDeps.onSettled` 注释）；notice 持久记录不存原始 key，只存派生 `sendId`（`deriveSendId(seed)`），但可存可选 `requestId`（`parseOutbox` 接受，`state.ts:650-689`）；`registry.ts:658-666` 首个匹配 ack 删除 pending，重复/迟到 ack 走 `onLateAck`。 |

---

## 2. 总体设计（A′）

### 2.1 数据流

```
发送方 agent ──xs_req──▶ hub xs router ──xs_deliver──▶ 接收方 agent（receiver：quiet 写入 → verdict）
                              ▲                                   │
                              └──────────────xs_ack───────────────┘
   send：   原有 limits.settle → settleOut(res+audit) ─▶ 新增 queueMicrotask(emit 单条)
   广播：   逐行 finish(audit) 只收集候选 ─▶ 原有 Promise.all → releaseSlot → req.res → auditLine ─▶ 新增 queueMicrotask(emit 全部候选)
                              │（observer = 同步轻量过滤 + work 入队，绝不 await，异常吞掉）
                              ▼
            hub.ts 晚绑定 bot?.xsMirror(e) ─▶ 无 runtime ⇒ 丢弃
                                            └▶ xs-mirror.ts deliver：去重 → 全部 p2p 绑定（最久未准入优先）→ 逐卡预算预占 → 有界 FIFO（16）
                                               单 worker（work 1 槽）：同步段内 渲染 → 槽位/字节检查 → outbox.enqueueNotice(tag "xsm:…") 的 store.add
```

### 2.2 进程内事件 schema（冻结；P1/P2 各自声明同形类型，hub.ts 直传）

```ts
// P2: src/web-hub/hub/xs/mirror.ts       export interface XsQuietDelivered
// P1: src/web-hub/hub/feishu/xs-mirror.ts export interface FeishuXsMirrorEvent   —— 字段逐一相同
{
  sessionId: string;            // 接收方（被镜像的）会话 = target.sessionId / row member.sessionId
  agentKey: string;             // 接收方 agentKey，仅用于生成 web 链接
  xid: string;                  // hub 生成的投递 id（`x` + 18 hex）= 去重键
  kind: "message" | "broadcast" | "reply";
  from: { ref: string; name?: string; alias?: string };
                                // ref = sessionId 前缀（REF_LEN）；name = 对方自报（已 slice NAME_MAX）；
                                // alias = 本次 xs_deliver 里 hub 盖的 from.alias（只有接收方 aliasUsable 时才有）
  channel?: string;             // 仅 broadcast：bc.channel（不含 #）
  late?: true;                  // 仅 reply ∧ ack.reason === "reply_late"（queued 回复无从得知是否迟到，§3.2）
  queued?: true;                // ack = unknown{queued}
  wakeDowngraded?: string;      // 已过 xsToken 的英文 token，来源见 §4.1
  text: string;                 // 原始正文（≤16 KiB，进程内传引用；截断在飞书侧做）
}
```

最小化：**不传**发送方完整 sessionId、cwdLabel、agentId、level、reply 关联 id、token。

### 2.3 cap / 兼容矩阵

**无新 cap、无新帧**。`HubConfig.feishuBot` 多一个可选叶子 `xsMirror?: boolean`（hub 侧缺省视为 false，fail closed）。

| 组合                                          | 行为                                                                                         | 线上帧字节 | 钉住的测试                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| xs off（无 `config.crossSession`）            | 无 relay ⇒ 无观测点                                                                          | 不变       | `tests/integration/fabric-xs-off-golden.test.ts` + `fixtures/fabric-xs-off-golden.json`（不重生成） |
| feishuBot off（无 `config.feishuBot`）        | 不传 `onQuietDelivered` ⇒ router deps 与现状同形                                             | 不变       | 同上 + `tests/web-hub/agent/wiring-feishu.test.ts`「off ⇒ 无 feishuBot 键」不变                     |
| `xsMirror:false`                              | 不传观测回调；runtime 启动时清除存量 `xsm:` 通知（§4.6）                                     | 不变       | wiring 用例 + 集成 I7/I15                                                                           |
| 旧 hub × 新 agent                             | 旧 hub 无观测点；旧 normalizer 忽略未知键 `xsMirror`                                         | 不变       | `tests/web-hub/protocol/feishu.test.ts` 未知键断言                                                  |
| 新 hub（新 agent 拉起）× 旧 agent 接收方      | 可镜像（依据旧 agent 的 ack；pre-reply 旧 agent 不发 `reply_late` ⇒ 迟到回复显示为普通回复） | 不变       | 集成 I1-I14（fake agent 直接回 ack）                                                                |
| 新 hub 但由**旧 agent**拉起                   | HubConfig 无 `xsMirror` ⇒ off（残余 R1）                                                     | 不变       | —                                                                                                   |
| 降级回旧 hub 时 state.json 里尚有 `xsm:` 通知 | 旧 `parseOutbox` 接受 notice 上的 `requestId`，按普通 notice 在 10 min maxAge 内发完或过期   | 不变       | P1 state 兼容断言（parseOutbox 读带 requestId 的 notice）                                           |
| 飞书已配置但未运行                            | `bot.xsMirror` 无 runtime ⇒ 静默丢弃                                                         | 不变       | P1 service 单测                                                                                     |
| 三份 off golden                               | 不涉及                                                                                       | 不变       | `fabric-{xs,wake,xs-reply}-off-golden.test.ts`（不重生成）                                          |
| xs 路由线协议                                 | observer 有无都不改任何帧/审计                                                               | 不变       | `xs-router-v071-diff.test.ts` 原样保留 + **新增 observer-on/off 同输入对拍**（§7.1）                |
| hub caps 两面                                 | 无变化                                                                                       | 不变       | `tests/web-hub/hub/caps-coexist.test.ts` 不改                                                       |

---

## 3. 写点与「未唤醒」判定

### 3.1 观测点与结算路径的关系（r2 订正）

- receiver 判决在 agent 进程内完成后才发 ack；hub 观测发生在判决之后、另一进程，物理上不影响 receiver 的 `setDispatched`/`verifyDispatch`/inbox 记账/`xs_ack`。
- **send**：`settleOut`（回 sender `xs_res` + audit）在前、`limits.settle` 更前；观测在其后，并用 `queueMicrotask` 推迟执行——镜像工作不占用本次 `.then` 回调。
- **广播（r1 依据写错，r2 订正）**：逐行 `finish()` 只做 `auditRow`；真正的 `releaseSlot()` 与 sender `req.res(...)` 在 `Promise.all(pending).then` 里（`broadcast.ts:295-322`）。r2 规定：逐行 `.then` **只把候选事件 push 进本次广播的局部数组**（O(1)，不查绑定、不渲染、不调 observer）；在聚合 `.then` 里 `releaseSlot → req.res → auditLine` **全部完成之后**、以及 `.catch` 分支 `releaseSlot → req.res → log.warn` 之后，`queueMicrotask(() => for each → emitQuiet(...))`。行 promise、slot 释放与聚合回复的时序与现状完全一致。
- observer 本体（`bot.xsMirror`）是同步轻量过滤 + `work.run` 入队，永不 await；`emitQuiet` 包 try/catch，抛错只记 `log.warn("xs mirror observer failed", {code:"E_XS_MIRROR"})`。

### 3.2 判定谓词（P2 `quietVerdict`，纯函数，全真值表测试）

输入：`ack {effect, reason?, woke}`（reason 先过 `xsToken`）。

| ack                                                                 | 来源（receiver.ts）                                                                     | 镜像？                                       | 标注                                                                                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `woke:true`（任意 effect，含 `applied`、`unknown{start_deferred}`） | Controller 唤醒（392-435）                                                              | **否**（开了回合；不承诺一定会有 done 通知） | —                                                                                                                                                                                  |
| `applied, woke:false`，无 reason                                    | deliver-only + leaf 证据（558-570）；含 receiver 侧/Controller 降级与 hub 侧降级的 wake | **是**                                       | 有 `wakeDowngraded` ⇒「对方请求唤醒，但本会话未被唤醒（token）」                                                                                                                   |
| `applied, woke:false, reason:"reply_late"`                          | 迟到回复（宽限期内）                                                                    | **是**                                       | 「回复（迟到）」                                                                                                                                                                   |
| `unknown{queued}, woke:false`                                       | 会话忙，进 pi 内存队列（551-556）                                                       | **是**（Q2 拍板）                            | 「会话运行中，消息已排入当前回合（送达未确认）」；若为回复只标「回复」——busy 时 reason 恒为 `queued`，hub 无从判断是否迟到（`xs-receiver.test.ts:832-850` 佐证），**不为此加协议** |
| `unknown{accept_unverified}`                                        | 写入后会话身份变了 / idle 但 leaf 不是这条；含 Controller 已 dispatch 后 verify 失败    | **否**                                       | —                                                                                                                                                                                  |
| `unknown{receiver_error}` / `none{*}`                               | 失败或拒绝                                                                              | 否                                           | —                                                                                                                                                                                  |
| ack 未到（`deliver_deadline` / `link_lost` / `ack_mismatch`）       | hub 超时/断链                                                                           | 否（保守，漏推不误推）                       | —                                                                                                                                                                                  |
| 超时后的迟到 ack、重复 ack（走 `members.onLateAck`）                | registry 已删 pending                                                                   | 否（不接观测点）                             | —                                                                                                                                                                                  |

`kind`：send 路径 `isReply ? "reply" : "message"`（reply 的 `deliver.wake` 恒 false，必须看 ack 而非发出字段）；广播路径恒 `"broadcast"`。广播**按行**镜像：聚合结果为 `unknown{partial}` 时，成功的 quiet 行照样镜像。

### 3.3 NoticeGate 排除

`subagent:xs-reply` 由接收方本地 `XsReplyNoticeGate.quietWrite`（reply-notice.ts:249-263）写入，不经 hub xs relay ⇒ A′ 看不到，无需过滤代码；文档化即可。

---

## 4. hub 侧实现

### 4.1 P2：xs 路由观测点（pi-free）

- 新文件 `src/web-hub/hub/xs/mirror.ts`：
  - `export interface XsQuietDelivered`（§2.2）、`export type XsQuietObserver = (e: XsQuietDelivered) => void`；
  - `export const XS_MIRROR_QUEUED = true`（Q2）；
  - `export function quietVerdict(ack): { late: boolean; queued: boolean } | undefined`（§3.2）；
  - `export function emitQuiet(observer, events, log)`：`queueMicrotask(() => { for (const e of events) try { observer(e) } catch { log.warn(...) } })`；`observer` 缺省或 `events` 为空 ⇒ 直接 return，不排微任务。
- `router.ts`：`XsRouterDeps` 加 `onQuietDelivered?: XsQuietObserver`；`createXsRelay` deps 同名透传（969-997）；send 结算 `ack.xid === xid` 分支 `settleOut(...)` 之后：`quietVerdict(ack)` 命中则 `emitQuiet(obs, [event])`，`wakeDowngraded = xsToken(ack.wakeDowngraded) ?? admit.wakeDowngraded`（与 settleOut 第三参同源）。`runXsBroadcast` 的 deps（478-495）加同名字段。
- `broadcast.ts`：`XsBroadcastDeps` 加同名可选字段；`const quiet: XsQuietDelivered[] = []`；逐行 `build(...)` 结果先存 `out` 供 request 与候选共用；`ack.xid === xid` 分支在 `finish(...)` 之后若 `quietVerdict` 命中则 `quiet.push(event)`；事件的 `wakeDowngraded = xsToken(ack.wakeDowngraded) ?? rowDowngrade ?? wholeDowngrade`（**r2：补整批降级来源** step1 `level_limit`/`sender_wake_disabled` 与 admit 的 `broadcast_wake_fanout`/`broadcast_wake_rate`/`outbound_wake_rate`；**只用于镜像事件，不改 `xs_res` 行形状或审计**）；聚合 `.then` 末尾与 `.catch` 末尾各调一次 `emitQuiet(obs, quiet)`。
- 不改任何帧构造、limits、audit 字段；observer 缺省 ⇒ 代码路径只多一次 `undefined` 判断。

### 4.2 P1：飞书服务入口

- `service.ts`：
  - runtime 内 `mirror = deps.config.xsMirror === true ? createFeishuXsMirror({...}) : undefined`；runtime 返回对象加 `xsMirror(e)`：`if (!active || !mirror) return; mirror.deliver(e)`。
  - **生命周期（r3 订正，保持既有顺序不变）**：runtime `stop()`（`service.ts:1638-1683`）现有顺序是 `connector.stop()`（**必须第一步**）→ `active = false` → 各模块 dispose（notify/budget/…）→ group commit → `work.drain`/`replies.drain`/`reactions.drain` → `outbox.stop` → `work.close()` → `state.flush` → `outbox.dispose`。镜像只在「各模块 dispose」这一段**追加** `mirror?.dispose()`（紧随 `notify.dispose()`），不挪动任何既有步骤。`mirror.dispose()` 置 `disposed = true`、清空待发队列（计 `xs-mirror-stopped`）；**不依赖 `work.close()` 取消任务**（它只拒绝新 run，不取消已排队回调）。已在执行中的唯一 worker 任务（至多 1 个 enqueue 在途，§4.3）由既有 `work.drain` 有界等待；worker 在每个 `await` 之后检查 `disposed`，为真即退出，**dispose 后不再写入任何窗口/omitted/seen 状态**。
  - 服务对外 `xsMirror(e: FeishuXsMirrorEvent): void`（同步、永不抛）：`runtime?.xsMirror(e)`；`disposed`/无 runtime ⇒ return。
  - `settled(group)`：**首行** `if (group.kind === "notice" && group.requestId?.startsWith("xsm:")) return;`（镜像 notice 借 requestId 做来源标记，§4.6；不进入 request/dialog/sendWaiter 逻辑；outbox 随后照常删除记录）。
  - runtime `start()`：在既有 `await state.commit()`（`outbox.start()` 之前，1603-1605）**之前**执行 §4.6 的存量清除。
  - 服务寿命计数 `mirrorDropped: Record<string, number>` 合入 `info().counters.dropped`（键见 §4.3）。`dropped` 是既有 `Type.Record`，**不改 `FsbInfoDataSchema`**（strict）。
- `outbox.ts`（P1 文件域，最小改动）：`EnqueueNoticeInput` 加可选 `tag?: string`（校验 `/^xsm:[A-Za-z0-9_-]{1,60}$/`，不合法 ⇒ `invalid-request`），`enqueueNotice` 把它作为 `storedRequestId` 传给 `enqueueGroup`（现状恒传 `undefined`）。seed 仍为 `notice\n<key>`，`sendId` 派生规则不变。现有调用方不传 `tag` ⇒ 行为与字节完全不变。
- `FeishuBotServiceDeps`/`FeishuServiceEvent` 不变（方法调用进来，不走 bus）。**`state.ts` 不改**：字节余量读既有 `state.usage()`（`{bytes, budget, reserve}`，`state.ts:827/1424`）。

### 4.3 P1：`src/web-hub/hub/feishu/xs-mirror.ts`（新，pi-free，闭包状态，无定时器）—— r3 单队列 + 单 worker

**r3 核心简化**：所有镜像卡片进入**一个有界 FIFO 队列**，由**唯一一个串行 worker** 逐张处理；同一时刻至多一张卡处于 enqueue 中。由此：

- 容量/字节检查与 `store.add` 落在**同一个同步段**（见 4.3-W3），不存在先查后插的竞态；
- omitted 记账只有一个写者，无并发扣减；
- 镜像占用共享 `work` 恒为 0 或 1 个槽；
- 不再需要 inflight 计数、快照扣减、`XSM_MAX_BINDINGS_PER_EVENT`。

```ts
createFeishuXsMirror(deps: {
  state: FeishuState; now(): number;
  label(sid: string): string; link(agentKey: string): string;
  target(b: FeishuBinding): OutboxTarget | undefined;
  enqueue(input: EnqueueNoticeInput): Promise<EnqueueResult>;   // = outbox.enqueueNotice
  run(task: () => Promise<unknown>): boolean;                   // = runtime work.run；冻结「false = 未执行」契约
  workSize(): number;                                            // = work.size
  log(e: { event: "xs-mirror"; reason: string; code?: string }): void;
  count(reason: string): void;                                   // → service mirrorDropped
}) → { deliver(e): void; pump(): void; dispose(): void }   // r3+: pump() 供 service maintain 调用（复审 m2）
```

常量（全部导出供测试）：

| 常量                                    | 值                 | 理由                                                                                                 |
| --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `XSM_PER_BINDING_PER_MIN` / `_PER_HOUR` | 6 / 60             | 单个私聊被刷屏的上限                                                                                 |
| `XSM_GLOBAL_CARDS_PER_MIN`              | 30                 | **按卡计**（扇出后每张），全局硬上限                                                                 |
| `XSM_QUEUE_MAX`                         | 16                 | 待处理卡片队列上限（内存，未入 outbox）                                                              |
| `XSM_MAX_QUEUED`                        | 16                 | outbox 中 `queued` 状态的 `xsm:` notice 上限                                                         |
| `XSM_OUTBOX_HEADROOM`                   | 128                | outbox 总占用 `size ≥ 512 − 64 − 128 = 320` 即拒绝镜像                                               |
| `XSM_MAX_CARD_BYTES`                    | 8 192              | 单卡 content 上限                                                                                    |
| `XSM_RECORD_OVERHEAD`                   | 512                | 一条 outbox 记录除 content 外的保守成本（sendId/requestId/target/时间戳/键名/分隔符）                |
| `XSM_BYTE_HEADROOM`                     | 262 144（256 KiB） | 镜像入队后状态文件**至少还剩** 256 KiB 给其它 durable 写入（告警/owner 单条 < 2 KiB ⇒ 可容 >100 条） |
| `XSM_WORK_HEADROOM`                     | 64                 | `work.size ≥ 256 − 64` 时 worker 不启动                                                              |

**deliver(e)**（同步，只做准入与入队，不碰 outbox）：

1. **字段防御**：`xid`/`sessionId`/`agentKey` 非空，否则 `count("xs-mirror-invalid")`。
2. **进程内去重**：`seen` FIFO（`${sessionId}\n${xid}`，512 / 30 min 惰性剪枝）命中 ⇒ `count("xs-mirror-dup")`；在此处写入 seen（同 xid 无合法二次投递路径，§4.6；后续拒绝以 omitted 尾注补偿）。
3. **绑定（r3：取消「前 8」）**：全部 `b.sessionId === e.sessionId && b.chatType === "p2p" && b.key.startsWith("p2p:") && b.offline === undefined` 的绑定（绑定表本身 ≤256；私聊绑定通常 1–3 个）；空 ⇒ 静默返回。**按「最久未被准入」排序**：`lastServed.get(b.key) ?? 0` 升序，平手按 `b.key` 字典序——一次扇出中若全局预算只剩 k 张，优先给最久没拿到卡的绑定；被跳过的绑定 `lastServed` 不变，下次自然排到前面 ⇒ 任一有效绑定在全局预算恢复后都会在有限轮内获得准入（不会永久饿死）。`lastServed` 为 Map（≤256，绑定删除后惰性清理）。
4. 对排序后的每个绑定 b（同步）：
   a. 每绑定窗口（6/min、60/h）不足 ⇒ `omit(b, "rate")`；
   b. 全局卡片窗口（30/min）不足 ⇒ `omit(b, "rate")`；
   c. 队列已满（`queue.length ≥ XSM_QUEUE_MAX`）⇒ `omit(b, "cap")`；
   d. 否则**预占** a/b 两个窗口各 1、`lastServed.set(b.key, now)`、`queue.push({ binding: b.key, chatId: b.chatId, event: e, queuedAt: now })`。预占不退还（保守）。
5. `pump()`。

**pump() / worker**（唯一执行者，`pumping` 布尔保证单实例）：

- W1 `if (pumping || disposed || queue.length === 0) return;` 若 `deps.workSize() ≥ 256 − XSM_WORK_HEADROOM` ⇒ 本次不启动；`pump` 同时由下一次 `deliver` 与 service 既有 30 s `maintain()` 调用（`mirror?.pump()`），不新增定时器。
- W2 `pumping = true; if (!deps.run(drain)) { pumping = false; for (const c of queue.splice(0)) omit(c, "work"); }` ——**冻结 false 路径**：work 已关闭/满时整队转为 omitted，不静默丢。
- `drain = async () => { try { while (!disposed && queue.length > 0) { const c = queue.shift()!; await sendOne(c); } } finally { pumping = false; if (!disposed && queue.length > 0) pump(); } }`
- **W3 `sendOne(c)` 的同步临界段**（从第一行到 `deps.enqueue(...)` 调用**之间没有任何 await**）：0. `now − c.queuedAt > 10 min`（与 notice maxAge 同）⇒ `omit(c, "stale")`，return。
  1. 重新取绑定 `b = state.bindings.get(c.binding)`；已删除/改绑（`sessionId` ≠ 事件会话）/改 offline ⇒ 丢弃（`count("xs-mirror-unbound")`，不计 omitted）。
  2. `target = deps.target(b)`；undefined ⇒ `omit(c, "refused", "target")`，return。
  3. `base = reported[c.binding]`、`pending = unreported(c.binding)`（见 4.3-O）；`message = renderXsMirror({..., omitted: pending, maxBytes: XSM_MAX_CARD_BYTES})`。
  4. **槽位**：`queuedMirror() < XSM_MAX_QUEUED`（遍历 `state.outbox.list({state:"queued"})` 计 `kind==="notice" && requestId?.startsWith("xsm:")`）且 `state.outbox.size < 512 − 64 − XSM_OUTBOX_HEADROOM`；否则 `omit(c, "cap")`，return。
  5. **字节**：`const u = state.usage(); const cost = utf8(JSON.stringify(message.content)) + XSM_RECORD_OVERHEAD;` 要求 `u.bytes + u.reserve + cost + XSM_BYTE_HEADROOM ≤ u.budget`；否则 `omit(c, "bytes")`，return。（`JSON.stringify(content)` 计入了状态 JSON 中对卡片字符串的二次转义；512 覆盖记录元数据，偏保守。）
  6. `const p = deps.enqueue({ target, message, key: tag, tag, laneKey: c.chatId })`——`enqueueNotice → enqueueGroup` 在**同一同步段**内完成 `store.add` + `indexRecord`，直到 `await deps.state.commit()` 才让出（`outbox.ts:782-845`）。因此 4/5 的检查与插入之间不可能插入任何其它生产者（含其它镜像卡——worker 唯一；含告警——JS 单线程同步段）。⇒ 镜像在队数**严格 ≤16**、outbox 总占用在镜像插入后**严格 ≤320**、镜像插入后字节余量**严格 ≥256 KiB**。
  7. `const r = await p;` → `if (disposed) return;` → `r.ok` ⇒ `markReported(c.binding, base, pending)`，`log(r.durable ? "accepted" : "accepted-nondurable")`；`!r.ok` ⇒ `omit(c, "refused", r.refused)`。`catch` ⇒ `if (disposed) return;` 再 `omit(c, "refused", "throw")`（复审 m1：dispose 后的拒绝/抛错不得重写已清空的 dropped/omitted，守 S9）。
  - `tag = "xsm:" + feishuKey(`${c.binding}\n${c.event.xid}`)`。

**4.3-O omitted 记账（r3：单调计数 + 已报告水位）**：每绑定两个计数 `dropped[b]`（只增）与 `reported[b]`（只增），`unreported(b) = dropped[b] − reported[b]`。`omit(c, reason, code?)`：`dropped[c.binding] += 1`、`count("xs-mirror-" + reason)`、采样审计（每绑定每 10 min 至多一行）。渲染时记下 `base = reported[b]` 与 `shown = unreported(b)`；`markReported(b, base, shown)`：`reported[b] = min(dropped[b], max(reported[b], base + shown))`——worker 唯一，渲染与确认之间只有本卡一个 await、期间无其它卡读写 `reported`，故实际就是 `+= shown`；max/min 写法让任何意外的重复或乱序确认既不会超扣（吞掉未展示的新丢弃），也不会让水位超过 `dropped`。失败（`!ok`/throw/disposed）**不推进** `reported`，尾注留给下一张成功卡。守恒：任意时刻 `dropped = reported + unreported`，且 `reported` 只在「携带该数字的卡被 outbox 接受」后推进。两个 Map 上限 256（绑定上限），绑定删除时一并删除。

**durable 口径（r3 订正）**：`enqueue` 返回 `{ok:true}` 表示 outbox **已接受入队**；`durable:false`（commit 失败/超时）时记录在内存中，outbox `pump` 会先 `ensureDurable()`、**持久化之前绝不发送**（`outbox.ts:468-470`）。审计分 `accepted` / `accepted-nondurable` 两档；`omitted` 水位按「已接受」推进（之后若该记录因长期无法持久化而到期，属 outbox 既有语义，记残余 R6，不重造消息重试）。

**审计**：`log({event:"xs-mirror", reason, code?})`，`reason ∈ accepted | accepted-nondurable | dup | rate | cap | bytes | work | refused | stale | unbound | invalid | stopped | purged`；`code` 只取 `EnqueueRefusal` 枚举或静态词——**不含**正文、会话名、别名、ref、sessionId、chatId、tag。`dropped` 键 `xs-mirror-<reason>`（≤64 字符）。

`dispose()`：`disposed = true`；队列中剩余条目计 `xs-mirror-stopped`（不进 omitted，Map 一并清空）；清 `seen`/窗口/`lastServed`/`dropped`/`reported`。

### 4.4 与安全告警/其它通知的资源隔离（r3：同步临界段 + 真实字节余量）

| 共享资源                                                    | 风险                               | 隔离机制                                                                                                                                                               | 硬性质                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 全局通知节流 `createNoticeBudget`（20/min）                 | 镜像突发挤掉 security/owner        | 镜像**不使用**，走自有逐卡预算                                                                                                                                         | 完全隔离                                                                                                   |
| `work`（256 槽）                                            | 镜像任务占满                       | 单 worker ⇒ 镜像恒占 0–1 槽；剩余 <64 不启动                                                                                                                           | 镜像占用 ≤1                                                                                                |
| outbox 槽（notice 可用 448）                                | 镜像耗尽 notice 槽                 | 检查与 `store.add` 同一同步段（W3-4/6）；镜像 queued ≤16；镜像插入后总占用 ≤320                                                                                        | 普通 notice 恒有 ≥128 槽                                                                                   |
| 状态文件字节（4 MiB，`tracked + delta + reserve ≤ budget`） | 镜像吃掉最后的字节 ⇒ 告警 `budget` | 用 `state.usage()` 真实账本 + 保守完整记录成本，要求插入后仍余 ≥256 KiB（W3-5，同一同步段）                                                                            | 镜像插入后余量恒 ≥256 KiB；**若非镜像写入本身已把余量压到 <256 KiB，镜像一律退出**，不再与告警竞争最后字节 |
| outbox 发送（20/s、≤4 HTTP 在途、per-lane 250 ms）          | 镜像拖慢 owner 私聊                | 镜像 lane = 绑定 `chatId`；owner/security 以 owner `open_id` 为 target，lane 分离；镜像全局 ≤30 卡/min；单 worker 也使镜像在 outbox 中的新增速率受串行 commit 节拍限制 | 不另设优先级调度器；共享 4 个 HTTP 在途槽是既有设计，调用有期限（接受）                                    |
| notice maxAge 10 min                                        | —                                  | 积压镜像到期 `failed(expired)`                                                                                                                                         | —                                                                                                          |

测试见 §7.1 `xs-mirror-isolation.test.ts`（含「已有 15 个 queued 镜像 + 一次扇出 8 张 ⇒ 镜像 queued 恰 16」「总占用 319 + 扇出 ⇒ 至多再插 1 张」「非镜像状态接近字节预算时告警准入在有/无镜像下一致」）。

### 4.5 卡片渲染 `renderXsMirror`（`render.ts`，只用已验证元素）

只使用仓库已真机验证过的形状：`buildCard(title, "grey", markdown)`（schema 2.0 + `plain_text` header + 单个 `markdown` 元素）。**不使用** `div/plain_text` 正文、`hr`、按钮或任何 `behaviors`。

```
标题(plain_text)：跨会话来信 · <sanitizeLabel(label)>
markdown：
**⚠️ 来自另一会话的消息，内容未经核实，请勿据此操作**
**别名** `@<alias>`（hub 核验）                      ← 仅有 alias
**会话名** `<name>`（对方自报，未核验）              ← 仅有 name
**ref** `<ref>`
**类型** 频道广播 `#<channel>` | 点对点消息 | 回复 | 回复（迟到）
对方请求唤醒，但本会话未被唤醒（`<token>`）            ← wakeDowngraded
会话运行中，消息已排入当前回合（送达未确认）            ← queued
（空行）
> 正文…（逐行引用）
> …（正文已截断，共 N 字，完整内容请在 web 查看）      ← 超 1500 code point
（空行）
本卡片仅供查看，不提供任何操作。在 web 查看：<link>   ← link = safeFeishuLink(deps.link(agentKey))；无可用 origin 时它自己回落为文字「web 会话页面」
此前另有 N 条跨会话来信未能推送到这里，请到 web 查看    ← omitted>0（N = 该绑定的 omitted 快照）
```

转义：

- `alias`/`name`/`ref`/`channel`/`token`：`markupSafeLabel(v, 40)` 后把 `` ` `` 换成 `ˋ`，包进行内代码——自报名里的 `[x](https://…)`、`**`、`<at>` 按字面显示；`token` 另过 `xsToken`，不合法则不显示原因。
- 正文：`[...sanitizeText(text)]` 按 code point 截 1500 → `neutralizeMarkdown(...)` → 每行加 `> `（同 `leadFor` 失败信息），防止正文伪造上方元信息行。
- 尺寸：`utf8(content) ≤ min(maxBytes, FEISHU_REPLY_LIMITS.maxCardBytes)`；超出（多字节 + 转义密集时可能触及 8 KiB）⇒ 逐步缩短正文（每次 −25% code point，最多 4 次）并标「已截断」；仍超 ⇒ 只含静态文案 + 「正文过长，请在 web 查看」。

### 4.6 关闭开关后的存量丢弃 + 去重承诺（r2 Minor 处置）

**来源标记**：镜像 notice 经 `tag` 以 `requestId = "xsm:<hash>"` 持久化（`parseOutbox` 已接受可选 `requestId`，无 schema/键变化；`REQUEST_ID_RE` 兼容；hash 为 base64url 不含 `~`，不会被 indexRecord 误拆为 variant）。

**清除机制（`service.ts` runtime `start()`）**：在 `await state.commit()` / `outbox.start()` 之前：

```ts
if (deps.config.xsMirror !== true) {
  let n = 0;
  for (const p of state.outbox.list({ state: "queued" }))
    if (p.kind === "notice" && p.requestId?.startsWith("xsm:") && state.outbox.remove(p.sendId)) n++;
  if (n) {
    mirrorDropped["xs-mirror-purged"] += n;
    log("xs-mirror", "purged");
  }
}
```

随后既有 `commit()` 持久化删除，`outbox.start()` 的 `load()` 看不到这些记录 ⇒ 关闭并 `/webhub restart` 后**不再发出任何存量镜像**。已处于在途（unknown-effect）的那一次尝试可能已被平台接收——这是关闭前就已发生的发送，不属于重启后发送。`xsMirror:true` 时不清除，存量按 outbox 既有恢复语义发送（10 min maxAge）。

**去重承诺（收窄，r1 引用的 1h 保留期不成立）**：选「**接受重启窗口残留、不新增持久墓碑**」。理由：hub ack 链路本身不重放——registry 首个 ack 即删 pending，hub 不持久化 xs_deliver，重启不会重发原 xid，agent 也不补发；因此需要防的只有：

| 边界                                      | 由谁保证                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 同一 pending request 只结算一次           | `registry.ts:658-666`（重复/迟到 ack 走 onLateAck）                                                                            |
| 进程内重复调用                            | xs-mirror `seen`（512 / 30 min）                                                                                               |
| 同 tag 仍在 outbox 中（queued/未 settle） | `enqueueGroup` 首个 sendId 已存在 ⇒ `duplicate:true`，不新增发送                                                               |
| 崩溃后恢复 queued 部件重试                | outbox 确定性 sendId = 平台 uuid，平台约 1 h 去重；超出 `uuidSafeWindowMs` 的 unknown-effect 部件判 `expired-uncertain` 不重试 |
| settle 后 outbox 立即删除记录             | **不承诺**本地去重；由于上游不会重放，同 xid 不会再入队——这是被接受的边界，写进残余 R7                                         |

---

## 5. 设置（三处 + 装配一行）

| 文件                             | 改动                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/settings.ts`         | `FeishuBotSettings.xsMirror?: boolean`（沿用 `securityAlerts?` 可选先例）；`DEFAULT_FEISHU_BOT_SETTINGS.xsMirror = true`；`parseFeishuBotBlock` 加 `xsMirror: bool(r.xsMirror, d.xsMirror ?? true, "xs-mirror-invalid")`；警告类型加 `"xs-mirror-invalid"`。 |
| `src/web-hub/protocol/feishu.ts` | `FEISHU_BOT_DEFAULTS.xsMirror = true`；`FeishuBotHubConfig.xsMirror?: boolean`（缺省 = false）；`normalizeFeishuBotHubConfig`：非 boolean ⇒ 整键作废（同 `securityAlerts`），存在则拷贝。                                                                    |
| `src/config/setting-specs.ts`    | `"feishuBot.xsMirror": bool("feishuBot.xsMirror", "Feishu bot: mirror cross-session messages that did not wake the session to bound p2p chats (default on; change: /reload then /webhub restart)")`，置于 `feishuBot.notify` 之后。                          |
| `src/web-hub/agent/index.ts`     | `buildHubConfig` feishuBot 段加 `xsMirror: bot.xsMirror ?? true`（1416-1428）。                                                                                                                                                                              |
| `src/commands/webhub.ts`         | 警告文案表（~504）加 `"xs-mirror-invalid": "xsMirror 类型应为布尔，已回退默认"`。                                                                                                                                                                            |

---

## 6. 安全与残余

**不变式**

- S1 跨会话消息是不可信输入：卡片首行固定不可信提示；会话名标「对方自报，未核验」；仅 hub 盖章的 alias 标「hub 核验」。
- S2 卡片零动作：无按钮、无 `behaviors`、不签发 nonce；测试断言 JSON 不含 `"button"`/`"behaviors"`/`"callback"`。
- S3 正文与来源字段走 §4.5 转义；1500 code point 截断；单卡 ≤8 KiB；正文整体引用。
- S4 群聊永不推（chatType + key 前缀双重过滤）。
- S5 观测失败吞掉、微任务推迟；不影响 sender 的 `xs_res`、hub limits、广播 slot 释放、receiver 判定。
- S6 审计/日志不含正文、名字、别名、会话/聊天标识、tag。
- S7 不改 strict schema（只往 `dropped` Record 加键；outbox 复用既有可选 `requestId`）。
- S8 镜像不能使安全告警/owner 通知因槽位/字节/work/节流被拒：镜像的槽位与字节检查与其 `store.add` 处于同一同步段（单 worker），插入后普通 notice 恒余 ≥128 槽、状态文件恒余 ≥256 KiB；非镜像写入自身把余量压低时镜像退出（§4.3-W3、§4.4）。
- S9 镜像在 dispose 后不再改动任何状态；不改变 runtime stop 既有顺序（`connector.stop()` 仍为第一步，§4.2）。

**残余（AGENTS.md 按此口径记录）**

- R1 谁拉起 hub 谁决定：旧 agent 拉起的新 hub 无 `xsMirror` ⇒ off；设置改动需 `/reload` + `/webhub restart`。
- R2 正文中白名单链接（http/https/mailto）仍可点击，与助手回复卡同宽；正文已整体引用并有不可信提示。可选后续加固：正文改 `plain_text`（先真机验证）。
- R3 **（Q3 拍板）** 被 `deny` 的用户的 p2p 绑定仍会收到镜像，与现有 done 通知一致；跟进项「deny 时清理该用户绑定」另开，不在本特性分包内。
- R4 **（Q2 拍板）** 排队（`queued`）来信可能最终未进上下文，卡片已标「送达未确认」；排队的回复无法标「迟到」。
- R5 best-effort（§0.3）：ack 丢失 / 超时后迟到 ack / ack 结算后通知落盘前 hub 崩溃 ⇒ 永久漏推；不补发原 xs 消息。
- R6 预算/队列/槽位/字节/work 超限会丢条目，以按绑定的尾注计数提示（尾注只在「携带该数字的卡被 outbox 接受」后才算已报告）；outbox 10 min 内发不出（auth paused、长期无法持久化等）亦过期丢弃，已报告的尾注随之丢失——不另造重试。runtime 停止时队列中未处理的卡计 `xs-mirror-stopped`，不进尾注（重启后 omitted 状态本就清零）。
- R7 settle 后 outbox 立即删记录，不提供 settle 后的本地去重；依赖上游不重放（§4.6）。
- R8 alias 只在接收方 `aliasUsable` 时出现（取自本次 xs_deliver 盖章）。
- R9 关闭开关只在 `/webhub restart`（runtime 重新 start）时清存量；仅 `/reload` 不触达 hub。

---

## 7. 测试计划

### 7.1 单测

**P2** `tests/web-hub/hub/xs-mirror-tap.test.ts`（新，复用 `tests/web-hub/hub/xs-fixtures.ts`）

- `quietVerdict` 全真值表（§3.2 每行，含 reason 非 token、`XS_MIRROR_QUEUED`）。
- send：applied/woke:false ⇒ 微任务后观测恰 1 次、字段正确（message/reply/late；wakeDowngraded 来自 ack 与 admit 两种）；woke:true / none / accept_unverified / 超时 / ack_mismatch / 超时后迟到 ack / 重复 ack ⇒ 0 次。
- 广播：混合结果（applied、queued、none、unknown{accept_unverified}、woke:true、ambiguous）⇒ 只对 applied/queued 行各观测 1 次；`channel` 正确；`wakeDowngraded` 依次覆盖 ack 降级、`pair_wake_rate`（row）、`level_limit`/`sender_wake_disabled`（step1 whole）、`broadcast_wake_fanout`/`broadcast_wake_rate`（admit whole）。
- **时序**：广播在 `releaseSlot` 与 `req.res` **之后**才调用 observer（observer 内断言 `limits` 广播 slot 已释放、`res` 已调用）；send 在 `settleOut` 之后；`.catch` 聚合失败路径同样在 res 后观测。
- **observer-on/off 对拍**：同一输入下 `xs_deliver` 帧、sender `xs_res`、audit 行逐字节相同；observer 抛错时亦相同。
- 回归：`xs-router.test.ts`、`xs-broadcast*.test.ts`、`xs-router-v071-diff.test.ts`、`xs-channel-hub.test.ts`、`xs-alias-router.test.ts` 不改、全绿。

**P1**

- `tests/web-hub/hub/feishu/xs-mirror.test.ts`（新，fake enqueue 可手动 resolve，控制交错）：
  - 过滤：p2p/群/话题/offline/会话不匹配；seen 去重；tag/key 形状。
  - 预算：每绑定 6/min、60/h；**全局按卡计**（10 绑定 × 6 条 ⇒ 1 分钟内被接受恰 30 张）。
  - **公平性（M3）**：10 个稳定绑定、全局预算每分钟只够 3 张、低频连续来信且每轮等 worker 空闲 ⇒ `lastServed` 轮转，4 分钟内 10 个绑定**全部**至少 1 张，且每个被跳过的绑定在其下一张卡上显示正确尾注。
  - **单 worker**：任意时刻 `enqueue` 未决调用数 ≤1；`run` 被调次数 = 启动 drain 次数；`work.size` 中镜像占用 ≤1。
  - **omitted 守恒（M2）**：双成功、成功+拒绝、成功+抛错、确认期间新增丢弃、dispose 打断——每一步断言 `dropped = reported + unreported`，且 `reported` 只在 `ok:true` 后推进、永不超过 `dropped`。
  - `run()` 返回 false ⇒ 整队转 omitted（`work`）、不调 enqueue、`pumping` 复位、之后可再次启动。
  - durable：`{ok:true,durable:false}` ⇒ 审计 `accepted-nondurable`、水位推进；`{ok:false}` ⇒ 水位不动。
  - stale（>10 min）出队计 omitted；绑定在排队期间被删/改绑 ⇒ `unbound`，不计 omitted。
  - **生命周期（m2）**：worker 在 `await enqueue` 中时 `dispose()` ⇒ resolve 后不再写窗口/omitted/seen/lastServed；队列剩余计 `stopped`；dispose 后 `deliver`/`pump` 无动作。
  - log spy 断言不含正文/名字/别名/ref/sessionId/chatId/tag 子串。
- `tests/web-hub/hub/feishu/xs-mirror-isolation.test.ts`（新，§4.4，真 `createFeishuState` + 真 `createFeishuOutbox` + fake api 暂停）：
  - 已有 15 个 queued 镜像，一次扇出 8 张 ⇒ 镜像 queued 恰 16，其余 `cap`；
  - 预置非镜像 notice 使 outbox 总占用 319，再扇出 ⇒ 至多插入 1 张镜像，随后 security/owner `enqueueNotice` 仍 ok，普通 notice 余量 ≥128；
  - 以大体积非镜像记录把状态字节推到「余量 < 256 KiB + 1 张卡」⇒ 镜像全部 `bytes` 拒绝；告警 `enqueueNotice` 的准入结果在有/无镜像流量两组下**完全一致**；
  - 交错：worker 的同步段与一次告警 enqueue 在同一宏任务中先后发生 ⇒ 边界仍严格成立；
  - 非镜像 `work.run` 在镜像持续流量下始终返回 true。
- `outbox.test.ts` 增：`tag` 合法 ⇒ 记录带 `requestId`、seed/sendId 与无 tag 时一致；非法 tag ⇒ `invalid-request`；不传 tag ⇒ 字节不变；同 tag 未 settle 时二次 enqueue ⇒ `duplicate:true`；onSettled 正常返回后记录删除（钉现状，§4.6 R7）。
- `state.test.ts` 增：带 `requestId` 的 notice 可持久化/重载（降级兼容依据）。
- `render.test.ts` 增 `renderXsMirror`：控制/双向剥离、`<at …>` 中和、名字 markdown 链接/反引号字面、正文全 `> `、1500 截断、header plain_text、无 button/behaviors、最坏输入 ≤8 192 字节且有截断提示、omitted 尾注。
- `service.test.ts`：`xsMirror` 缺省/false ⇒ `xsMirror()` 无副作用；true + 运行中 ⇒ 入 outbox；未运行/disposed ⇒ 无副作用；`settled()` 对 `kind:"notice"` 的 `xsm:` 组直接返回；**stop 顺序**：`connector.stop` 仍是第一个调用、`mirror.dispose` 在其后、已在途的镜像 enqueue 由 `work.drain` 有界等待且完成后无状态写入；`maintain()` 调用 `mirror.pump()`；**`xsMirror:false` 启动清除存量**（预置 queued `xsm:` notice + 普通 notice ⇒ 只删前者、`dropped["xs-mirror-purged"]` 正确、普通 notice 仍发）；`xsMirror:true` 启动保留存量。
- 设置：`tests/config/feishu-bot-settings.test.ts`、`tests/config/setting-specs-feishu.test.ts`、`tests/web-hub/protocol/feishu.test.ts`（DEFAULTS 镜像一致；normalize 缺省/布尔/非布尔；未知键忽略）、`tests/web-hub/agent/wiring-feishu.test.ts`（enabled ⇒ `xsMirror:true`；false ⇒ false；off ⇒ 无 feishuBot 键）。

### 7.2 集成（P3，扩展 `tests/integration/web-hub-feishu-bot.test.ts` 的 F10 harness）

harness 扩展：`boot()` 增可选 `crossSession`（形状以 `hub/main.ts` normalizer 为准）与 `xsMirror`；fake agent 增 xs 能力：hello caps 带 `xs.v1`、`xs.reply.v1`（回复用例双端都带）、`xs.channel.v1`（广播用例），发 `xs_member`（joined、receive=deliver），发送方发 `xs_req op:"send"|"broadcast"`（回复用例 `replyTo`、`to` = 完整 sessionId），接收方按用例回 `xs_ack`（可延迟、可重复）。断言对象：fake Feishu `inspect().sent` 与 `fsb_req info` 的 `counters.dropped`。**所有「不推」用例都与同输入 `xsMirror:true/false` 对拍 sender 的 `xs_res`，而不是与其它用例比较。**

| #   | 场景                                                                                                                       | 期望                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 点对点 `applied/woke:false`                                                                                                | 绑定 p2p 恰 1 张：不可信提示、「对方自报」、ref、正文；JSON 无 button/behaviors                                                                    |
| I2  | `woke:true`                                                                                                                | 0 张                                                                                                                                               |
| I3  | `none{rejected}`、`unknown{accept_unverified}`                                                                             | 0 张；`xs_res` 与 off 对拍一致                                                                                                                     |
| I4  | `unknown{queued}`                                                                                                          | 1 张，标「送达未确认」                                                                                                                             |
| I5  | 只有群话题绑定；p2p+群混合                                                                                                 | 0 张；只 p2p 1 张                                                                                                                                  |
| I6  | 广播 `#team` 到两会话（各绑不同 p2p）                                                                                      | 各 1 张，含「频道广播 `#team`」                                                                                                                    |
| I7  | `xsMirror:false`                                                                                                           | 0 张；`hello_ack.caps` 与 true 时逐字节相等                                                                                                        |
| I8  | 同绑定 1 分钟 7 条                                                                                                         | 6 张；`dropped["xs-mirror-rate"]===1`；下一窗口的下一张卡带尾注「此前另有 1 条」（集成里用两次运行间隔不可行时，改由单测验证尾注、此处只断言计数） |
| I9  | 飞书无凭据（feishuBot 有键）                                                                                               | xs 往返照常，hub 无异常                                                                                                                            |
| I10 | 正文 3000 字                                                                                                               | 截断提示，卡 ≤8 192 字节                                                                                                                           |
| I11 | **准时 quiet 回复**（`applied/woke:false`，无 reason）                                                                     | 1 张，类型「回复」                                                                                                                                 |
| I12 | **迟到回复**（`applied, reason:"reply_late"`）；**queued 回复**（`unknown{queued}`）                                       | 前者「回复（迟到）」；后者「回复」+「送达未确认」，不标迟到                                                                                        |
| I13 | **超时后迟到 ack**（接收方 >5 s 才回 applied）；**重复 ack**（立即回两次）                                                 | 前者 0 张、sender 得 `deliver_deadline`；后者恰 1 张                                                                                               |
| I14 | **混合结果广播**（3 接收方：applied / none / unknown{accept_unverified}，另 1 方 woke:true）                               | 只 applied 方 p2p 1 张；sender 聚合 `unknown{partial}` 与 off 对拍一致                                                                             |
| I15 | **存量清除**：fake Feishu 对 send 返回鉴权失败使 outbox 暂停 → 产生 2 条镜像积压 → 以 `xsMirror:false` 重启 hub → 恢复鉴权 | 0 张镜像发出、`dropped["xs-mirror-purged"]===2`；对照组 `xsMirror:true` 重启 ⇒ 各发 1 次                                                           |
| I16 | **扇出 + 全局上限 + 公平**：1 会话绑 10 个 p2p，每条间隔等 worker 空闲，连发 4 条（40 张候选）                             | 1 分钟内被接受的镜像卡 ≤30；10 个绑定**每个都 ≥1 张**；`dropped` 中 `rate`+`cap` 合计 = 40 − 被接受数                                              |

### 7.3 off goldens / 兼容（必须全绿、**禁止重生成**）

`fabric-xs-off-golden`、`fabric-wake-off-golden`、`fabric-xs-reply-off-golden`（三份 JSON 不动）；`tests/fixtures/legacy-xs-v071/` 相关 diff 测试；`caps-coexist.test.ts`；`fabric-xs-channel-compat.test.ts`；F10 既有用例。

### 7.4 真机验收（P3 产出 `docs/dev/feishu-xs-mirror/acceptance.md`）

两个 pi 会话 join 同频道、其一 `/use` 绑到飞书私聊：A→B `wake:false`；A→B `wake:true`（不推）；广播；B 忙时发送（排队标注）；带 alias；自报名含 `[x](https://…)` 与 `<at>`；超长正文；群话题绑定不推；带 `expectReply` 的准时与迟到回复；`xsMirror:false` + `/reload` + `/webhub restart` 后既不推新消息、**也不发出关闭前积压的镜像**。

---

## 8. 分包

| 包                    | 内容                                                                                                                                                                                                                                                                                                                                                                            | 文件域（互斥）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 依赖                   | 估时    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------- |
| **P1 飞书侧**         | 设置三处 + buildHubConfig + 警告文案；`xs-mirror.ts`（逐卡预算、最久未准入轮转、有界 FIFO + 单 worker、同步段槽位/字节准入、单调水位 omitted）；`renderXsMirror`；outbox `tag`；service 方法/`settled` 早退/启动清除/stop 中追加 dispose/`maintain` 调 pump/计数                                                                                                                | `src/config/settings.ts`、`src/config/setting-specs.ts`、`src/commands/webhub.ts`、`src/web-hub/protocol/feishu.ts`、`src/web-hub/agent/index.ts`、`src/web-hub/hub/feishu/{xs-mirror.ts(新),render.ts,outbox.ts,service.ts}`；测试 `tests/config/{feishu-bot-settings,setting-specs-feishu}.test.ts`、`tests/web-hub/protocol/feishu.test.ts`、`tests/web-hub/agent/wiring-feishu.test.ts`、`tests/web-hub/hub/feishu/{xs-mirror(新),xs-mirror-isolation(新),render,outbox,state,service}.test.ts` | 无（按 §2.2 冻结接口） | 5–5.5 h |
| **P2 xs 观测点**      | `mirror.ts` 谓词/事件/emitQuiet；router 单条 + 广播候选收集与聚合后投递；整批降级回退；relay 透传                                                                                                                                                                                                                                                                               | `src/web-hub/hub/xs/{mirror.ts(新),router.ts,broadcast.ts}`；测试 `tests/web-hub/hub/xs-mirror-tap.test.ts(新)`                                                                                                                                                                                                                                                                                                                                                                                     | 无（与 P1 并行）       | 2–2.5 h |
| **P3 装配+集成+文档** | `hub.ts`：`const xsMirrorOn = config.feishuBot?.xsMirror === true && config.crossSession !== undefined`，为真时 `createXsRelay({..., onQuietDelivered: (e) => bot?.xsMirror(e)})`（`bot` 为 320 行的 `let`，闭包惰性读取；为假时不传该键）；F10 集成 I1–I16；AGENTS.md feishu bot 段补一句（范围、默认开、A′ 无 cap、关闭即清存量、残余 R1–R9 口径、门禁测试）；`acceptance.md` | `src/web-hub/hub/hub.ts`、`tests/integration/web-hub-feishu-bot.test.ts`、`AGENTS.md`、`docs/dev/feishu-xs-mirror/acceptance.md(新)`                                                                                                                                                                                                                                                                                                                                                                | P1 + P2                | 3.5–4 h |

合计 3 包、约 10.5–12 h（r2 为 10.5–12.5 h：单 worker 去掉了 inflight/快照扣减/前 8 截尾等逻辑，省下的时间投入并发/公平/字节余量测试；r1 为 7–9 h）。建议车道 L2：P1/P2 同消息并行派发，各自返回即派 verifier（验收模型 ≠ 开发模型）；P3 后跑全量 `format:check → typecheck → test → build`。

---

## 附录 A：被否决/未采用的细节

- 复用 `createNoticeBudget`：会与安全告警/owner 通知争 20/分钟，且「按键最小间隔」会吞连续来信。
- 扩 `FeishuServiceEvent` 联合、走 `events.subscribe`：要改 registry bus 投影，且 xs 结算不是 bus 事件。
- 往 `FsbInfoData` 加字段：strict schema，旧 agent 解码失败；改用既有 `dropped` Record。
- 正文用 `div/plain_text`：更严，但未真机验证；列为后续加固（R2）。
- 持久去重墓碑（settle 后保留 1 h）：上游不重放，收益近零，却要新增状态表/字节预算与文件域；按 §4.6 收窄承诺。
- outbox 记录新增 `origin` 键做来源标记：`parseOutbox` 是 `onlyKeys` 严格解析，旧 hub 读到会**丢弃整条记录**；改为复用既有可选 `requestId`。
- 按会话（而非按绑定）计每会话预算：一条来信扇出多绑定时会让后几个私聊系统性饿死；r2 改为每绑定窗口 + 全局按卡上限。
- r2 的「每条来信最多扇出前 8 个绑定（按 updatedAt）」：第 9 个起永久饿死（复审 M3）；r3 取消，改为全部 p2p 绑定 + 最久未准入优先。
- r2 的「专用 inflight ≤8 + 准入时检查 outbox 容量」：检查与真实插入之间隔着 work 微任务，可越界（复审 M1）；r3 改为单 worker，检查与 `store.add` 同步段。
- r2 的「omitted 按快照扣减」：同绑定并发任务重复扣同一快照会吞计数（复审 M2）；r3 单写者 + 单调水位。
- 在 `state.ts` 新增镜像专属字节预留/优先级：需改 state 准入核心与所有调用方；r3 只读既有 `state.usage()` 做镜像侧余量门控即可达到同一隔离目标。

## 附录 B：方案 A（agent 帧 + cap）增量（Q1 已否决，仅存档）

- 帧 `fsb_xs_mirror`（agent→hub，`additionalProperties:false`）：`{ t, sessionId, xid, kind, from{ref,name?,alias?}, channel?, late?, queued?, wakeDowngraded?, text(≤1501 cp), truncated? }`；cap `fsb.xsmirror.v1` 仅 hub 宣告。
- 写点 `src/web-hub/agent/xs.ts` `onDeliver` 发 `xs_ack` 之后；需 bridge 内 xid LRU 防 dedup replay；hub `agent-server.ts` 新分支校验 sessionId 后转 `bot.xsMirror`。
- 代价：多改 `protocol/messages.ts`、`agent-server.ts`、`agent/xs.ts`、`hub.ts` caps，并新增新旧端组合测试；旧 agent 作为接收方无法被镜像。

---

## §R1 评审处置（gpt-6.1-sol，r1 判 reject：1 Blocker / 2 Major / 5 Minor；评审确认 A′ 成立）

| #   | 严重度  | 评审意见（摘要）                                                               | 处置                                                                                                                                                                                                                                                                                                                                  | r2 位置                           |
| --- | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | Blocker | Q2/Q3 未拍板却已成施工默认/「接受」残余                                        | **闭合**：用户 2026-10-23 拍板 Q1=A′、Q2=queued 也推并标「送达未确认」、Q3=与 done 通知一致记残留并另开跟进；移入 §0.1，§0.2 清空，R3/R4 注明拍板来源                                                                                                                                                                                 | §0.1、§3.2、§6 R3/R4              |
| 2   | Major   | 预算按来信计数、扇出后可超全局 30；独立预算未隔离共享 work/outbox              | **采纳**：改为逐卡（扇出后每张）预占预算，每绑定 6/min·60/h + 全局 30 卡/min + 单条扇出 ≤8；隔离 work（专用在途 ≤8、剩余 <64 即停）、outbox（镜像在队 ≤32、普通 notice 恒留 ≥128 槽）、字节（单卡 ≤8 KiB）；lane 分离；新增隔离测试与 I16（**r3 注**：在途 ≤8/前 8/32 槽已被 §R2 M1/M3 的单 worker、全绑定轮转、16 槽同步段准入取代） | §4.3、§4.4、§7.1、§7.2 I16        |
| 3   | Major   | 漏 `work.run()` false 拒绝路径；omitted 在 enqueue 成功前清零                  | **采纳**：冻结 `run(): boolean` 契约，false ⇒ `work` 计数 + omitted+1 + 无正文审计；omitted 改按绑定，**仅 enqueue `ok:true` 后按快照扣减**，拒绝/抛错保留尾注；审计 `sent` 改名 `enqueued`；seen 在准入点写入并说明为何不影响补救（**r3 注**：快照扣减与 `enqueued` 口径已被 §R2 M2/m1 取代）                                        | §4.3、§7.1                        |
| 4   | Minor   | 广播 finish 不负责 slot/回复，同步观测仍在结算关键路径                         | **采纳**：逐行只 push 候选；聚合 `releaseSlot → req.res → auditLine` 之后（及 `.catch` 分支 res 之后）`queueMicrotask` 投递；send 也改微任务；新增时序测试                                                                                                                                                                            | §3.1、§4.1、§7.1                  |
| 5   | Minor   | 「settled 后保留 1h 持久去重」与 onSettled 立即删除不符                        | **采纳（二选一：接受重启窗口残留）**：不新增墓碑；逐项列出 registry 单次结算 / 进程内 seen / outbox 在队同 key / 平台 uuid 的边界；记 R7；`outbox.test.ts` 钉现状                                                                                                                                                                     | §4.6、§6 R7、附录 A               |
| 6   | Minor   | 广播 wakeDowngraded 未回退 wholeDowngrade                                      | **采纳**：镜像事件用 `xsToken(ack.wakeDowngraded) ?? rowDowngrade ?? wholeDowngrade`，不改 xs_res/审计；定向断言覆盖 step1/admit/pair/ack 来源                                                                                                                                                                                        | §4.1、§7.1                        |
| 7   | Minor   | 集成缺准时/迟到回复、超时后迟到 ack、重复 ack、混合广播；queued 回复无法判迟到 | **采纳**：新增 I11–I14（fake agent 双端带 `xs.reply.v1`）；明确 queued 回复只标「回复」不标迟到、不加协议；「不推」用例改为同输入 on/off 对拍                                                                                                                                                                                         | §3.2、§7.2                        |
| 8   | Minor   | `xsMirror:false` 不能阻止已持久化镜像在重启后被恢复发送                        | **采纳（给机制）**：镜像 notice 以 `requestId="xsm:<hash>"` 作持久来源标记（复用既有可选字段，旧 hub 可读）；runtime `start()` 在 `outbox.start()` 前，`xsMirror!==true` 时删除所有 queued `xsm:` notice 并计数；`settled()` 对 `xsm:` 早退；新增 I15 与 service 单测                                                                 | §4.2、§4.6、§6 R9、§7.1、§7.2 I15 |

---

## §R2 复审处置（r2 判 reject：0 Blocker / 3 Major / 2 Minor；确认 r1 的 8 项中 6 项已闭合）

| #   | 严重度 | 复审意见（摘要）                                                                                   | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                             | r3 位置                                    |
| --- | ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| M1  | Major  | outbox 容量检查在异步 enqueue 前且不预占，可越过 32/320；单卡/总量上限未给共享状态文件保留告警字节 | **采纳（结构性消解）**：镜像改为**有界 FIFO + 单一串行 worker**；worker 在**同一同步段**内完成渲染、槽位检查（镜像 queued ≤16、总占用 ≤320）、字节检查（`state.usage()` 真实账本 + `JSON.stringify(content)` + 512 B 记录开销，插入后余量 ≥256 KiB）与 `enqueueNotice → store.add`，无先查后插窗口；非镜像写入自己压低余量时镜像退出，不与告警争最后字节。新增「15+8 扇出」「总占用 319」「近满字节下告警准入有/无镜像一致」「同宏任务交错」测试 | §4.3（W1–W3）、§4.4、§6 S8、§7.1 isolation |
| M2  | Major  | omitted 快照扣减并发重复扣减丢计数                                                                 | **采纳**：单 worker 使 omitted 只有一个写者；记账改为每绑定**单调 `dropped` + 已报告水位 `reported`**（只在携带该数字的卡被 outbox 接受后以 max 推进），失败/抛错/dispose 不推进；守恒式 `dropped = reported + unreported` 逐步断言                                                                                                                                                                                                              | §4.3-O、§7.1                               |
| M3  | Major  | 固定按 updatedAt 取前 8 个绑定会永久饿死其余绑定                                                   | **采纳**：取消「前 8」，取全部有效 p2p 绑定（绑定表 ≤256，私聊通常极少）；全局预算不足时按 `lastServed` 最久未准入优先轮转，被跳过者下轮优先；新增「10 个稳定绑定、预算每分钟 3 张」公平性单测与 I16 每绑定 ≥1 断言                                                                                                                                                                                                                              | §4.3-3、§7.1、§7.2 I16、附录 A             |
| m1  | Minor  | `ok:true` 不等于持久化（`durable:false`）                                                          | **采纳**：`ok:true` 口径收窄为「outbox 已接受入队」；审计分 `accepted` / `accepted-nondurable`；注明 outbox 持久化前绝不发送（`outbox.ts:468-470`），之后若长期无法持久化而过期属既有语义（R6），不另造重试；补 durable:false 单测                                                                                                                                                                                                               | §4.3（W3-7、durable 口径）、§6 R6          |
| m2  | Minor  | 生命周期说明与现状不符（stop 顺序、work.close 不取消已排队任务）                                   | **采纳**：写明 runtime stop 既有顺序 `connector.stop()`（第一步）→ `active=false` → 模块 dispose（**在此追加** `mirror.dispose()`）→ commit → drain → `outbox.stop` → `work.close` → flush → `outbox.dispose`，不挪动任何步骤；不依赖 `work.close` 取消；至多 1 个在途 enqueue 由既有 drain 有界等待，worker 每个 await 后查 `disposed`，dispose 后不写任何状态；队列剩余计 `stopped`；补 stop 交错单测                                          | §4.2、§4.3 dispose、§6 S9、§7.1            |

## §R3 复审处置（r3 判 pass-with-changes：0 Blocker / 0 Major / 2 Minor）

| #   | 级别  | 问题                                            | 处置                                           | 落点          |
| --- | ----- | ----------------------------------------------- | ---------------------------------------------- | ------------- |
| m1  | Minor | W3-7 的 catch 在 dispose 后仍调用 omit，违反 S9 | **采纳**：catch 分支先 `if (disposed) return;` | §4.3 W3-7     |
| m2  | Minor | 冻结端口缺 `pump()`，service `maintain` 需调用  | **采纳**：端口返回值加 `pump(): void`          | §2.2 冻结接口 |
