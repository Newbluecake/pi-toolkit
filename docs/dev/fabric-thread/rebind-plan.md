# 飞书话题派发自动换绑（主入口 → worker 主会话）方案

> 状态：**r3，待用户确认（1 项，见 §8）**。
> r1 评审 r_F5W1N0BV（3 Blocker + 6 Major + 1 Minor）→ r2 修订；r2 复审剩 5 条未闭合 → 本版（r3）按主会话
> 收敛裁定逐条闭合，处置见 §9。**这是最后一轮修订。**
> 探索依据：run r_8BW7S2NY 报告（2026-11-03）。文中所有源码坐标均为本次核实的行号。

## 1. 背景与目标

主入口会话（下称 Router）通过 fabric xs 派发任务给一个 worker 主会话后，把飞书话题的绑定
**自动转移**给 worker：此后该话题的消息直达 worker，Router 零参与。

**已拍板、本版不动的方向**：

1. 换绑走既有 agent→hub 通道 `thr_req`（不新开 fabric 层通道）；
2. **只有现持有者能转出**（`binding.sessionId === 调用者 sid`）；
3. 默认保持绑定 + 显式转回，不自动回绑；
4. 默认 **off**：`fabric.threads.rebind=false`，off 态逐字节一致。

**本版硬约束**：换绑是一个**共享写操作**（非裸 `bindings.set`）且必须保留 `/use` 的首次绑定与离线选择能力；
目录重开只由 hub 的可信应答驱动；wire 自带能力标记与按 op 唯一的回执形状；
**不改变** `threads`-on × rebind-off 的模型面。

约束来源：I9 关闭态逐字节、I10 追加式 wire 不 bump PROTO、I11/D8 secure 域强制关闭、I4 无模块级可变状态。

## 2. 现状摘要（源码核实）

### 2.1 换绑副作用只挂在「飞书 inbound 的 durable 包裹」上——**不是** store 的通用监听

- `state.bindings.set()` 只改内存并 `rev = revSeq + 1`（`state.ts:1759-1786`），不通知任何人；
  返回 `Admit<FeishuBinding>`（`state.ts:100`）。
- `onBindingClosed(key, before, reason)` 的唯一调用点：飞书 inbound 的 prepare→`durable()` 包裹
  —— `service.ts:954`（key）、`966`（before 快照）、`980-991`（`durable()` 内比对 `rev` 后调用，
  实际调用在 `990`）。
- `onBindingClosed` 本体（`thread-hub.ts:293-306`）：按 key 重算 `h`、`finalizeRetained`、给**旧 session** 推 `thr_closed`。
- `/use` 能"免费"拿到副作用，是因为它也走同一个 inbound 包裹（`router.ts:152-166`），不是 store 有钩子。
- **`/use` 可以创建原本不存在的绑定**：`router.ts:156` 直接 `state.bindings.set(key, {...})`，
  `set` 内部对 `prev === undefined` 是合法分支（只在 `bindings.size >= cap` 时拒，`state.ts:1779`）。
  ⇒ 任何共享写操作**必须**把「首次绑定」当正常路径，而不是 `NOT_BOUND` 错误。
- **`/use` 允许选离线会话**：`sessions.select` 只看 `/list` 代际与歧义（`sessions.ts:120-141`），
  不要求 live；`resolve` 才要求 live（`sessions.ts:54-61`）。⇒ 共享写操作的 `target` **不得**要求
  `agentKey` 必填，也不得强制 live。

### 2.2 两处接口形状

- `sessions.resolve(sessionId)`（`sessions.ts:54-61`）只接受**完整 sessionId**，过滤 `v.live`，
  返回 `{ok:false, code:"offline"|"ambiguous"|"read-only"}`（`sessions.ts:40-41`）或 `{ok:true, agentKey, view}`。
- 按 ref/别名/名字解析的是 `sessions.select(chatId, senderOpenId, selector)`（`sessions.ts:120-141`），
  需要聊天上下文 + 发送者 + `/list` 代际；xs 侧的阶梯在 `hub/xs/router.ts:225-300`（`resolveTarget`，
  未导出、带可见性与自排除语义）。
- `BindingInput`（`state.ts:220-228`）**必须** `chatId` + `chatType`；`threadId/label/offline` 可空。
  `parseBinding` 失败 ⇒ `{ok:false, refused:"invalid"}`。

### 2.3 `h` 与 `bindingKey` 同源 ⇒ 换绑**不改变 h**；目录关闭是**永久**的

- `h = "fs:" + b64url(HMAC-SHA256(installSecret, bindingKey))[0:12]`（`thread-hub.ts:60-63`）。
- `bindingKey = grp:<chatId>:<threadId>`（`sessions.ts:159-161`），与 `sessionId` 无关 ⇒ 换绑前后 `h` 不变。
- `directory.ts:1-10` 注释声称「rebound ⇒ bindingKey 变了 ⇒ 新 h」——**错**（只有换话题才成立），必须改写。
- `note()` 对已 `closed` 条目只更新 label、**永不复活**（`directory.ts:36-48`）；`isOpen` 要求 known ∧ !closed；
  `close()` 单向（`directory.ts:66-70`）。
- 订阅准入 `subscriptions.ts:120-133`：`directory.state(h)` 非 `open` 即拒（`thread_unknown` / `thread_closed`），
  且在 hub cap 检查之前，是硬门。
- 目录唯一填充来源是 hub 的 thread-bearing 帧（`engine.ts:198 noteThread`，由 `web-hub/agent/commands.ts:421-470`
  的 §6.1 路由步调用）。**xs 文本不登记任何 h。**
- ⇒ 旧持有者收到 `thr_closed{rebound}` 后目录永久 closed；要重新接手，必须有一条**可信的重开路径**。

### 2.4 wire / 路由现状

- `ThrReqSchema` 是 `post | handback` 的 `Type.Union`，两支 `additionalProperties:false`
  （`protocol/thread.ts:249-277`）；解码 `Value.Check`（`messages.ts:2503`）——未知 op 判非法。
- hub 的 `decodeAgentFrame` 对非法帧**静默丢弃**（`agent-server.ts:227-235`，只对超限 `xs_req` 回错）
  ⇒ 旧 hub 遇新 op 不报「不支持」，客户端只能等 5s 超时（`connection.ts:489-505`），与链路抖动不可区分。
- op 路由：`service.ts:1916-1952` 只把 `post` 转给 thread 模块，**其余 op 全落到** `requests.handback`；
  `thread-hub.ts:470-533` 的 `thrReq` 对非 `post` 直接 `E_THR_STATE`。只在 thread-hub 加分支不可达。
- hub cap：`assembly-channels.ts:186`；agent cap：`agent/index.ts:1683`。
- `FeishuThreadsHubConfig` 只有 5 个 int 叶（`protocol/feishu.ts:716-722`），
  `normalizeFeishuThreadsHubConfig` 是**白名单重建**（`protocol/feishu.ts:730-748`）。
- **`cmd.thread` 目前不带 rev**：`ThreadMeta = {h, label, sentAt, bypass?}`（`protocol/thread.ts:97-118`）；
  `ThreadDirectoryEntry = {h, label, closed, lastTouchedAt}`（`directory.ts:13-19`）。
- `status.threads` 槽只有 `{h, subs}`（`protocol/thread.ts:170-186`）。

### 2.5 在途 / 结果竞争、保留与**状态机合法性**

- dispatch：`received` → `dispatching`（`requests.ts:226-231`）→ `await commit()`（`236`）→
  `admission.dispatch`（`259`）。准入再校验 `binding.rev / sessionId / offline`
  （`admission.ts:88-93`，`binding-changed`）。
- 结果：`routedResultOk` ⇒ `routedOutcome`（`requests.ts:341-369`）：`detachRun` → 迁 `accepted{thr:routed}`
  → `commit` → emit。**该路径不看 `bindingRev`**。
- `lateRouted`（`requests.ts:371-383`）只处理 `uncertain` 的晚到 routed，同样不看绑定代际。
- 保留回调 `armRetention`（`thread-hub.ts:250-270`）到期只迁 `thread-routed`，不看绑定代际。
- **状态机铁律（关键）**：`REQUEST_TRANSITIONS`（`state.ts:130-142`）中
  `dispatching` 只能去 `accepted | rejected | uncertain`，**不能直接去 `replied`**；
  `accepted → replied` 合法；`uncertain → replied` 合法。`transition` 非法即返回 `{ok:false, reason:"illegal"}`
  （`state.ts:1695`）。⇒ 任何"代际失配就迁 replied"的写法从 `dispatching` 起都是**非法迁移**，
  r2 的 §4.9 规则 1 与 A11 因此错误。
- `committed(id, op, run)`（`requests.ts:112-116`）：`commit` 成功才执行 `run`，失败则 park 重试。

### 2.6 静态模型面与 golden

- `ThreadToolParams` / description 是模块常量，`threadsOn` 时固定（`tools/thread-tool.ts:19-52`、`src/index.ts:612-618`）；
  `/thread` USAGE 同理（`commands/thread.ts:31-32`）。
- 既有 golden `tests/fixtures/thread-off-golden.json` 只覆盖 **threads off**；threads-on × rebind-off 无基线。

## 3. 总体设计

### 3.1 结构

```
agent 侧（Router 主会话）                        hub 侧（feishu bot）
┌───────────────────────────┐                  ┌──────────────────────────────────────────┐
│ thread 工具 action:"rebind" │── thr_req ─────▶│ service.thrReq（op 路由，必须改）         │
│  （仅 rebind-on 注册）      │  op:"rebind"    │  └─ thread-hub.thrReqRebind               │
│ /thread rebind（同门口径）  │◀── thr_res ─────│       ├─ 权益/所有权/CAS/限速             │
└───────────────────────────┘  {rebound,…}     │       └─ bindingTransfer.transfer(…,       │
                                               │          notifyLifecycle:true)            │
worker 主会话                                   │            ├─ set → await commit（屏障）   │
┌───────────────────────────┐                  │            ├─ onBindingClosed（恰好一次）  │
│ thread 工具 action:"acquire" │── thr_req ────▶│            └─ reconcile 两侧               │
│ /thread acquire             │  op:"acquire"   └──────────────────────────────────────────┘
└───────────────────────────┘  ◀── {owned,…}
```

| 模块                                                    | 职责                                                                                    | 变更性质      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------- |
| `hub/feishu/bindings-transfer.ts`（新增）               | 唯一写操作：快照 →（可选 CAS）→ `set` → `commit` 屏障 →（可选）生命周期通知 → reconcile | 新增          |
| `hub/feishu/router.ts`（`/use`）                        | 改调 `transfer`，`notifyLifecycle:false`（通知仍由 inbound durable 钩子做，见 §4.4 R6） | 改一处        |
| `hub/feishu/service.ts`（`thrReq`）                     | op 路由加 `rebind` / `acquire` 两支；`runs.detach` 已注入（`service.ts:861`）           | 改一处        |
| `hub/feishu/thread-hub.ts`                              | `thrReqRebind` / `thrReqAcquire`：权益、CAS、目标解析、限速、目录应答                   | 加分支        |
| `hub/feishu/requests.ts`                                | 新增 `closedByRebind(id)` 终结序列；`lateRouted` 复核代际                               | 加函数 + 一处 |
| `agent`（`tools/thread-tool.ts`、`commands/thread.ts`） | `rebind` / `acquire` 两个 action（仅 rebind-on）；`fromRev` 由 agent 内部注入           | 门控新增      |
| `agent`（`web-hub/agent/index.ts`）                     | `capsExtra` 追加 `thr.rebind.v1`；`thr_req` 回执校验                                    | 尾追加        |
| `fabric/thread`（`directory.ts`、`engine.ts`）          | 目录条目加 `rev`；`reopen(h,label,rev)`；注释改写                                       | 改            |
| `stack.ts` 的 thread 面                                 | `acquire` / 目录 rev 传递                                                               | 加一个方法    |
| `protocol/thread.ts`                                    | `ThreadMeta.rev?`；`ThrRebind/ThrAcquire` 两支；`ThrResOkData` 两个分支                 | 追加          |

**为什么共享写操作而不是给 store 加监听**：`bindings.set` 被 5 处调用（`router.ts:156`、`session-card.ts:881`、
`service.ts:801/1136/1483/1640`），其中「标 offline」不是换绑；`state.ts` 是持久化层，不该知道 thread。
所以把编排**上移**成显式函数，由 `/use` 与 rebind 各自调用。

### 3.2 生命周期时序（一次自动换绑，含 worker 侧接手）

1. Router：`thread{action:"rebind", h, to}`（`to` = worker 的完整 sid / ref / 别名 / 精确名字）。
2. agent：cap 预检（无 `thr.rebind.v1` ⇒ `E_THR_UNSUPPORTED`，**零帧**）；`sessionId`=当前 sid；
   `fromRev` = 目录里该 `h` 的 `rev`（§4.7）；`rid` 随机；5s 截止。
3. hub：`sessionOf(agentKey) === frame.sessionId`（`thread-hub.ts:484-488`）→ 解析 `h` → 权益 →
   `to` 解析成唯一 live sid → `frame.fromRev === binding.rev` → 限速 → `transfer(..., notifyLifecycle:true)`。
4. `transfer`：`before` 快照 → 同目标 no-op 判定 → `set`（保留 chatId/chatType/threadId，清 offline）→
   `await commit()`。**commit 之前没有回执、没有 `thr_closed`。**
5. commit 成功 → 关闭通知（旧目录 closed、保留请求终结、`thr_closed{rebound}` 推给旧 agent）→
   `reconcile(旧)` + `reconcile(新)` → 回执 `{rebound:true, h, sessionId, rev, changed}`。
6. Router 用回执里的**完整 `sessionId`** 发 `message_session`。派发文本里带 `h`。
7. **worker 接手（由谁触发）**：worker 收到的是 xs 消息，消息体由 Router 的模型写；Router 的派发模板
   （`skills/agent-handoff` 与 `message_session` 的工具描述补充一行）要求 worker 先
   `thread{action:"acquire", h}` 再处理正文。`acquire` 是**唯一**的目录登记入口：
   agent 先查本地目录（`isOpen` ⇒ 幂等返回），否则发 `thr_req{op:"acquire"}`；hub 仅当
   `binding.sessionId === 该 agent 当前 sid` 才回 `{owned:true, label, rev}`；agent 收到后
   `directory.reopen(h, label, rev)`，然后才能 `subscribe`。
8. worker `subscribe`：准入此时 `directory.state(h) === "open"` ⇒ 成功。此后该话题事件直达 worker。

**若 worker 不 acquire**：`subscribe` 报 `thread_unknown`（目录里没有），事件仍走主会话原生路径——
这是**安全降级**，不是错误状态；工具描述与验收（A13/A20）按此写。

## 4. 接口契约

### 4.1 设置

```ts
// src/fabric/settings.ts — FabricThreadSettings
/** 默认 false。off ⇒ 不注册 rebind/acquire action、不广告 thr.rebind.v1、
 *  hub 不认 rebind/acquire op（E_THR_STATE）。 */
rebind: boolean;
```

- `setting-specs.ts` 加 `"fabric.threads.rebind": bool(...)`（非 live，与 `enabled` 同栏）。
- 限速参数**不进配置**（见 §4.5 末）。
- `DEFAULT_SETTINGS` 在 rebind=false 时必须逐字节不变（实施第一步先跑 `tests/config/settings-corpus.test.ts`；
  若该 corpus 因新增键而失败，则把键放到独立块 `fabric.threadRebind.enabled`，corpus 本身只在基线提交重生成）。

### 4.2 能力标记

```ts
// src/web-hub/protocol/version.ts
export const THREAD_REBIND_CAP = "thr.rebind.v1";
export const THREAD_REBIND_HUB_CAPS = [THREAD_REBIND_CAP] as const;
export const THREAD_REBIND_AGENT_CAPS = [THREAD_REBIND_CAP] as const;
```

- hub 面：`assembly-channels.ts` 在 `THREAD_CAP` 之后尾追加，条件 = threads 键存在 **且** `rebind === true`。
- agent 面：`agent/index.ts` 的 `capsExtra` 在 `THREAD_CAP` 之后尾追加，条件 `threadsCapOn() && rebindOn()`。
- 为让 hub 判 rebind 是否开，`FeishuThreadsHubConfig` 增加**可选** `rebind?: boolean`；
  `normalizeFeishuThreadsHubConfig` 只在 `typeof === "boolean"` 时带上它，缺省不带该键
  （旧 hub 的白名单会丢掉它，但旧 hub 本来也不认 `thr.rebind.v1`，语义正确）。

### 4.3 wire（追加式，不 bump PROTO）

```ts
export interface ThrRebindReqFrame {
  t: "thr_req";
  rid: string;
  op: "rebind";
  h: string;
  sessionId: string;
  to: string; // 目标 selector（≤128）
  fromRev: number; // 调用者目录里最近一次可信观察到的 binding rev（§4.7），≥0
}
export interface ThrAcquireReqFrame {
  t: "thr_req";
  rid: string;
  op: "acquire";
  h: string;
  sessionId: string;
}
```

回执（`ThrResOkData` 追加两个**互斥**分支，按 op 唯一对应）：

```ts
| { rebound: true; h: string; sessionId: string; rev: number; changed: boolean; label: string }
| { owned: true; h: string; label: string; rev: number }
```

- `sessionId` 是解析后的**完整 sid**，Router 直接用它派发（避免二次解析漂移）。
- `rev` 是本次写入后的 binding rev；`acquire` 的 `rev` 是**当前** rev（目录据此更新新鲜度）。
- `changed:false` 仅表示「本次请求是同目标 no-op」，**不代表**一次成功换绑（见 §4.4 R1 与 §4.8 文案）。

失败码（`THREAD_ERROR_CODES` 追加）：

| 码                                                               | 含义                                                                      | effect      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------- |
| `E_THR_UNSUPPORTED`                                              | 对端无 `thr.rebind.v1`（agent 本地判定，**不发帧**）                      | none        |
| `E_THR_NO_OWNER`                                                 | 调用者不是该话题现持有者                                                  | none        |
| `E_THR_STALE`                                                    | `fromRev` 与当前 `binding.rev` 不符                                       | none        |
| `E_THR_TARGET_UNKNOWN` / `_AMBIGUOUS` / `_OFFLINE` / `_READONLY` | `to` 解析结果四类失败                                                     | none        |
| `E_THR_NOT_BOUND`                                                | `h` 对应的绑定已不存在                                                    | none        |
| `E_THR_COMMIT`                                                   | 内存已改、`commit` 失败                                                   | **unknown** |
| `E_THR_PENDING`                                                  | 同一 `(h,to)` 的换绑正在进行（去重命中，见 §4.4 末「rebind 的请求去重」） | **unknown** |
| `E_THR_RATE`（复用）                                             | 换绑限速                                                                  | none        |

`thrFrameOk`（`protocol/thread.ts:355-371`）需为 `op:"rebind"` 增加 `to.length ≤ 128` 门；整体 12 KiB 门已有。

### 4.4 hub 写操作契约（`bindings-transfer.ts`）

```ts
export interface TransferInput {
  key: string;
  /** 目标会话。agentKey OPTIONAL：/use 允许离线选择（§2.1），只有 rebind 要求 live+agentKey。 */
  target: { sessionId: string; label: string; agentKey?: string };
  /** 可选 CAS：rebind 带；/use 不带。 */
  expect?: { sessionId?: string; rev?: number };
  reason: "rebound";
  /** true ⇒ 本函数负责生命周期通知（终结保留 + thr_closed）；
   *  false ⇒ 调用方已有等价钩子（/use 的 inbound durable 包裹），本函数只做写+commit+reconcile。 */
  notifyLifecycle: boolean;
}
export type TransferResult =
  | { ok: true; created: boolean; changed: boolean; binding: FeishuBinding }
  | { ok: false; code: string; effect: "none" | "unknown" };

export function createBindingTransfer(deps: {
  state: FeishuState;
  threads?: FeishuThreads;
  scheduleConfirm?: { reconcile(sessionId: string): void };
  log: HubLog;
}): { transfer(input: TransferInput): Promise<TransferResult> };
```

**规则（每条可断言）**：

- **R1 首次绑定是正常路径**：`before === undefined` **不是**错误。此时跳过 CAS 与 no-op 判定，
  直接 `set`，返回 `{ok:true, created:true, changed:true}`。
  `E_THR_NOT_BOUND` **只**由 `expect !== undefined`（即 rebind 路径）且 `before === undefined` 时产生。
  （`/use` 首次绑定的现状：`router.ts:156` 本来就能创建；`session-card.ts:881` 同理。）
- **R2 同目标 no-op**：`before !== undefined && before.sessionId === target.sessionId &&
before.offline === undefined` ⇒ 返回 `{ok:true, created:false, changed:false}`，**不 set、不涨 rev、
  不 commit、不发通知**。（`set` 每次调用都 `rev++`，`state.ts:1767`。）
- **R3 CAS**：`expect?.rev !== undefined && before.rev !== expect.rev` ⇒ `E_THR_STALE`；
  `expect?.sessionId !== undefined && before.sessionId !== expect.sessionId` ⇒ `E_THR_NO_OWNER`。
- **R4 写入保留身份字段**：显式拼
  `{ chatId: before.chatId, chatType: before.chatType, ...(before.threadId ? {threadId: before.threadId} : {}),
sessionId: target.sessionId, label: sanitizeHeaderField(target.label), offline: null }`
  （`BindingInput` 要求 `chatId/chatType`，`state.ts:220-228`）。
  `before === undefined` 时由调用方提供 `chatId/chatType/threadId`（`/use` 从 message 取；
  rebind 从既有 binding 取，故 rebind 不会走到这一支）。
- **R5 检查 `Admit`**：`{ok:false, refused}` ⇒ `E_THR_STATE` / effect none（内存未变）。
- **R6 持久化屏障 + 生命周期通知的**唯一**归属**：`await state.commit()`；失败 ⇒ `E_THR_COMMIT`/`unknown`。
  commit 成功后才调用 `threads.onBindingClosed(key, before, "rebound")`——**仅当 `notifyLifecycle === true`**。
  最后 `scheduleConfirm?.reconcile(...)` 两侧（照 `requests.transfer` 的 `service.ts:804-806`）。
- **R7 `/use` 迁移的去重边界（恰好一次）**：
  `/use` 通过 `transfer(..., notifyLifecycle:false)` 写+commit；**通知仍由 inbound 的 `durable()` 钩子**
  （`service.ts:988-991`）按 `beforeBinding.rev !== afterBinding.rev` 触发。
  为了让"两个来源"永不双发，`onBindingClosed` 自身加**幂等键 `(key, before.rev)`**：
  内部 `Set<string>`（上限 64，FIFO 淘汰，I4 实例级），命中即直接返回。
  这样即使将来 `/use` 也切成 `notifyLifecycle:true`，也只会产生一次真正生效的通知。
  断言：`/use` 一次换绑 ⇒ `thr_closed`/终结各**恰好 1 次**（A1b）。
- **R8 不吞异常**：任何 throw ⇒ `E_THR_STATE` / `unknown`，并 `log("binding-transfer", ...)`。

**rebind 的请求去重（与 R1/R2 的恢复路径配套，见 §4.9）**：`thread-hub` 维护
`rebindSeen: Map<dedupKey, {state:"pending"|"done", res?: ThrResFrame}>`，key =
`h + "\u0000" + frame.sessionId + "\u0000" + frame.to + "\u0000" + String(frame.fromRev)`，上限 128，LRU。

- 命中 `done` ⇒ 直接回放同一 `thr_res`（幂等重试）。
- 命中 `pending` ⇒ 回 `E_THR_PENDING` / effect `unknown`（不并发执行第二次）。
- 未命中 ⇒ 插入 `pending` → 执行 → 成功/失败后置 `done` 并保存回执。

### 4.5 权限模型

**保护范围**：只保护这条绑定的**当前归属**。`h` 是可读可复制的稳定标识，**不是**授权凭证。

换绑成功必须同时满足：

1. `sessionOf(agentKey) === frame.sessionId`（既有，`thread-hub.ts:484`）；
2. `binding.sessionId === frame.sessionId`（现持有者）；
3. `frame.fromRev === binding.rev`（新鲜度，§4.7）；
4. `to` 经 `selectSession` + `sessions.resolve(sid)` 后 `ok`（拒 `offline`/`ambiguous`/`read-only`）。

**明确不保护的**：持有者可转移它持有的**其他**已知话题（合法授权范围）；注入内容不能转移它不持有的话题。
该界限写进工具描述与 `/thread` 帮助文本。

**限速**：按 `h` 的桶 `3/min + 20/h`，成功与失败都计数，`Map` 上限 64 LRU，超限 `E_THR_RATE`；
与 `post` 的 `replyPerThread*` 桶**独立**（不同 Map），互不消耗。

### 4.6 `to` 的解析（唯一口径）

```ts
// hub/feishu/session-selector.ts（不依赖 xs 内部函数）
export function selectSession(
  q: string,
  views: readonly FeishuSessionView[],
  aliasOf: (sessionId: string) => string | undefined,
):
  | { ok: true; sessionId: string; agentKey: string; label: string }
  | {
      ok: false;
      code: "E_THR_TARGET_UNKNOWN" | "E_THR_TARGET_AMBIGUOUS" | "E_THR_TARGET_OFFLINE" | "E_THR_TARGET_READONLY";
    };
```

阶梯（顺序固定；某档命中 >1 ⇒ ambiguous，不再下探）：`完整 sid` → `唯一前缀（≥6）` → `精确别名` → `精确 name`。
命中后：无 live ⇒ `OFFLINE`；live >1 ⇒ `AMBIGUOUS`；`state === "read-only"` ⇒ `READONLY`。
`aliasOf` 由 service 注入（xs relay 的别名存储可选，`hub/xs/router.ts:1080-1093`）。

### 4.7 `fromRev` 的可信来源、保存与失效规则

**只有三个可信来源**（其余一律视为"无可信 rev"）：

| 来源                                  | 携带位置                                               | 何时写入目录                                                       |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| hub 附在 `cmd.thread` 的绑定 rev      | `ThreadMeta.rev?`（新增，`protocol/thread.ts:97-118`） | §6.1 路由步调用 `noteThread(h,label,rev)`（`commands.ts:421-470`） |
| `acquire` 的回执 `{owned:true, rev}`  | `thr_res`                                              | `engine.reopenThread(h,label,rev)`                                 |
| `rebind` 的回执 `{rebound:true, rev}` | `thr_res`                                              | 成功后 `noteRev(h, rev)`（只升不降）                               |

**保存规则**：`ThreadDirectoryEntry` 增 `rev?: number`（`directory.ts:13-19`）；
`note(h, label, now, rev?)` 与 `reopen(h, label, now, rev?)` 一律 `rev = max(旧, 新)`（单调，防乱序帧回退）；
`get/hasRev(h)` 只读。

**使用规则**：`rebind` 的 `fromRev` = 目录当前 `rev`。若目录**没有** rev（从未收到带 rev 的帧、或 hub 是
旧版本不带 `ThreadMeta.rev`），agent **不猜**：先发 `thr_req{op:"acquire", h}` 取一次可信 rev，再发 rebind。
`acquire` 的 `owned:true` 顺带证明"我确实是持有者"，与 rev 一起构成 rebind 的前置观察。

**失效规则**：`thr_closed` 到达时删掉该 `h` 的 rev（`directory.close` 同时清 rev，因为关闭后不再新鲜）；
`acquire` 每次都**刷新** rev（hub 的当前值）；命中 `E_THR_STALE` 后，agent 必须重新 `acquire` 取 rev 再重试一次，
**不得**用本地值硬重试。

**open 快路径**：`acquire` 在 `isOpen(h)` 为真时直接返回 `{ok:true}` **但不刷新 rev** ——
因此 `rebind` **禁止**把"open 快路径返回"当作 rev 来源；`rebind` 只看目录 `rev`，
没有就强制走一次真实 `acquire` 往返（`isOpen` 为真时也发帧，因为目的是取 rev，不是登记）。
即 `acquire` 增加参数 `{ force?: boolean }`：`force:true` ⇒ 跳过 open 快路径，总是向 hub 取最新 rev。

**为什么不在 rebind 执行时临时取最新 rev**：那会把 CAS 降级成"总是匹配"，等于取消新鲜度检查。
rev 必须来自**调用方此前的观察**，这也是它能拒绝「`/use` 往返后的旧请求」的唯一依据（A4/A4b）。

**与 `thr_closed{rebound}` 的口径一致性（两条必须一起读）**：换绑**仍然关闭**旧持有者的目录条目
（`thr_closed{h, reason:"rebound"}` 照发 → `engine.threadClosed` → `directory.close`；`close()` 的单向性不改，
`directory.ts:66-70`）。关闭依然是终态，只是"重新获得归属"这条合法路径存在：
**新**持有者用 `acquire` 拿到 `{owned:true}` 后 `reopen(h, label, rev)` 把条目重新置 open；
**旧**持有者重开不了——hub 对它回 `E_THR_NO_OWNER`，`reopen` 根本不会被调用。
`directory.ts:1-10` 的注释按此改写（原文「rebound ⇒ 新 h」是错的）。`close()` 同时清 `rev`（见上「失效规则」），
保证 reopen 后拿到的是 hub 的当前 rev，而不是关闭前的旧值。

### 4.8 agent 面（仅 rebind-on 注册）

- `ThreadToolParams` 拆两个冻结实例（同 `message-session-tool.ts:26-64` 的 Legacy/Reply 写法）：
  - `ThreadToolParamsLegacy`：**逐字节等于现状**（三个 action，无 `to`/`h` 变化）；
  - `ThreadToolParamsRebind`：legacy + `action` union 增 `rebind`/`acquire` + `to`。
  - 选择 `threadParamsFor(rebindOn)`；`threads on ∧ rebind off` ⇒ Legacy，description 不追加（满足 Major 8）。
- **`fromRev` 不出现在模型的参数里**：工具描述只要求 `{action:"rebind", h, to}`，`fromRev` 由 agent 内部按 §4.7 注入。
  （模型不该、也无法为声明式工具提供绑定代际。）
- `/thread`：`USAGE` / `USAGE_REBIND` 双份；`/thread rebind <h|origin> <to>`、`/thread acquire <h|origin>`。
- 工具结果（`details` 机读 + text 人读）：

```json
{ "rebound": true, "h": "fs:…", "sessionId": "<完整 sid>", "rev": 41, "changed": true, "label": "…" }
```

失败文案必须区分三类：`E_THR_UNSUPPORTED`（对端不支持，**别重试**）；
`effect:"none"`（确定没生效，可修正后重试）；`effect:"unknown"`（可能已生效 —— **不得**按"重试直到成功"的直觉处理，
恢复方式见 §4.9）。

### 4.9 三种恢复路径（把 r2 的"no-op 兜底重试"彻底替换）

先分清三件事，它们**不是**同一个 no-op：

**P1 普通 no-op（真的无事可做）**：`binding.sessionId` 已等于目标，且本次调用者**就是持有者**。
例：worker 收到两次相同派发，第二次 rebind 到自己 ⇒ `changed:false`，仅提示"本就归你"。
这是唯一可以回 `changed:false` 的成功形状。

**P2 成功回执丢失（换绑已生效，Router 已不是持有者）**：
Router 重试**会先在权益门被拒**（`binding.sessionId !== frame.sessionId` ⇒ `E_THR_NO_OWNER`），
**不可能**再进 no-op 分支——r2 的"A7 重试得 changed:false"是错的。正确恢复：

1. agent 侧：`E_TIMEOUT` / `effect:"unknown"` 时**先查状态**，不重发：
   `thr_req{op:"acquire", h}` —— 若回 `{owned:true}` ⇒ 换绑**没生效**（我仍持有），可安全重发一次同 `rid`；
   若回 `E_THR_NO_OWNER` ⇒ 换绑**已生效**（归属已变），直接继续派发（sid 用最近一次 `cmd.thread` 或
   `status.threads` 看到的归属方，或让用户在话题里 `/cur` 确认）。
2. 去重：同 `dedupKey` 的重发在 hub 命中 `done` ⇒ 回放原回执（`E_THR_REBOUND` 不会出现）。

**P3 commit 失败（`E_THR_COMMIT` / effect `unknown`；内存已指向目标、磁盘未落）**：

- 该状态**不产生成功回执**，也**不发** `thr_closed`（R6）；旧订阅者仍在工作。
- 恢复：agent **不重发 rebind**（重发会走到 `E_THR_NO_OWNER`，因为内存里已不是自己）。
  正确动作是发 `thr_req{op:"acquire", h}`：
  - 回 `{owned:true}` ⇒ 内存确实已切走但持久化未完成（hub 处于 degraded）；agent 报
    "换绑未确认（持久化失败），请勿据此派发"，并让 Router 走普通 `message_session`（不带话题语义）。
  - 回 `E_THR_NO_OWNER` ⇒ 同上语义（已切走但未持久化）。
  - 无论哪种，**hub 侧的重试由 `state.commit` 的既有 retry 循环承担**（`state.ts` 的 `retryMs` 周期），
    rebind 不自行重试。
- 幂等性由 `rebindSeen` 的 `done` 回执 + 目标态判定共同保证：再次收到**同一** dedupKey 的请求时，
  若 `bindings.get(key).sessionId === 目标` 且 `rev` 已 ≥ 记录值 ⇒ 视为已完成，回
  `{rebound:true, changed:false}`（此时是 P2 语义，调用方已非持有者，只能由 hub 内部去重路径给出）。

**明确删除**：r2 的"A5/A7 同目标重试得 changed:false"与"A7 Router 重试"——前者只适用于 P1（调用者仍是持有者），
后者在 P2/P3 下不可达。

### 4.10 在途语义与**合法终结序列**

| 阶段                                 | 判定依据                                  | 换绑后行为                              |
| ------------------------------------ | ----------------------------------------- | --------------------------------------- |
| A 已接收未 dispatch（`received`）    | 准入 `bindingRev`（`admission.ts:88-93`） | `binding-changed` ⇒ `rejected`（现状）  |
| B 已 `dispatching` 未 forward        | 同上                                      | 同上（现状）                            |
| C 已 forward 未回执（`dispatching`） | **新增**：结果到达时复核代际              | 见下（必须走合法迁移）                  |
| D 普通 `accepted`（非 routed）       | `committed()` 回调                        | 不劫走，结果回原话题（现状）            |
| E `accepted{thr:routed}` 保留中      | `onBindingClosed`                         | 终结为 `replied{thread-closed}`（现状） |

**C 段终结函数（新增 `requests.closedByRebind(id)`，`requests.ts`）**：

```
前提：record.state ∈ {dispatching, uncertain}，且绑定代际失配
步骤（全部同步，一个 tick 内完成）：
  1. deps.detachRun?.(id)                       // 与 routedOutcome 同序，先断 tracker（service.ts:861 已注入）
  2. transition(id, "accepted", { code: "thr:routed" })        // dispatching→accepted 合法；uncertain→accepted 合法
     （若第 2 步返回 illegal，则退回 transition(id, "rejected", { code: "thread-closed" })：
       dispatching→rejected 合法、uncertain→rejected 合法）
  3. transition(id, "replied", { code: "thread-closed" })      // accepted→replied 合法；uncertain→replied 也合法
  4. await commit()（失败 ⇒ 既有 park 重试，不 emit、不 arm 保留）
  5. 不 emit 任何 routed/accepted 事件 ⇒ 无回执、无保留、无 Typing 依赖
```

- **禁止**从 `dispatching` 直接迁 `replied`（`state.ts:132` 不允许）。
- 第 2 步的 `accepted` 只是合法中转；**不 emit**，因此不会触发 `requestEvent` 的 accepted 分支
  （`service.ts:1098-1100` 的 `files.settle`）——附件由步骤 1 之后的终态清理路径释放（`replied` 属终态，
  `state.ts:1703` 删 payload；`files.settle` 的 missed 引用由 `files.sweep()` 兜底，与 `routedOutcome` 的
  `retained:false` 分支同一兜底）。
- **`routedOutcome` 的代际复核（在步骤 2 之前做）**：若 `routedResultOk` 非空但代际失配，
  **不要**走 `routedOutcome`，改调 `closedByRebind(id)`；这封住"换绑后晚到 routed 复活保留"。
- **保留回调复核**（`thread-hub.ts:250-270`）：到期时若代际失配 ⇒ 不发 `thread-routed`，改由
  `closedByRebind` 处理（从 `accepted` 起：第 2 步跳过，直接第 3 步 `replied{thread-closed}`）。
- **`lateRouted`**：`uncertain` → 复核 → 失配则 `closedByRebind`（uncertain→accepted→replied）。

## 5. 关键决策

| #   | 决策                                                                       | 理由                                                                                | 被否备选                                                            |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D1  | 共享编排 `bindings-transfer.ts`，`/use` 与 rebind 共用；首次绑定是正常路径 | 副作用必须与 commit 同序；store 不该知道 thread；`/use` 的首次绑定/离线选择必须保留 | 给 store 加监听（会把"标 offline"当换绑）；两处内联复制（语义漂移） |
| D2  | `onBindingClosed` 加 `(key, before.rev)` 幂等键                            | 让"写了不一定通知"与"已有钩子通知"可以安全共存                                      | 只靠调用方纪律（迁移期必双发）                                      |
| D3  | 独立 cap `thr.rebind.v1` + 本地预检                                        | 旧 hub 对未知 op 静默丢帧（`agent-server.ts:227`）                                  | 复用 `thr.v1`（unsupported 与 timeout 不可分）                      |
| D4  | 回执按 op 唯一分支（`rebound`/`owned`）                                    | 两种形状混装客户端无法判别                                                          | 万金油 `{ok:true,data:{…}}`                                         |
| D5  | 目录重开只由 `acquire` 往返驱动（hub 应答）                                | 无新 hub→agent 帧；push 丢帧后仍要兜底                                              | 新增 `thr_opened` push（不可靠链路 + 还要兜底）                     |
| D6  | `fromRev` 只取目录里的可信观察值，缺失则强制一次 `acquire`                 | CAS 才有意义；执行时现取 = 取消检查                                                 | 无 CAS（无法拒过期请求）                                            |
| D7  | 终结走 `dispatching→accepted→replied` 合法链，不 emit 中间态               | 状态机铁律（`state.ts:130-142`）                                                    | 直接 `dispatching→replied`（illegal）；改状态机（门禁外溢）         |
| D8  | 限速参数用 hub 常量，不进配置                                              | 配置键白名单重建（`protocol/feishu.ts:730`）                                        | 放 `FeishuThreadsHubConfig`（同键两代语义）                         |
| D9  | 自动化在 agent 工具层（先 rebind 拿 sid，再派发）                          | hub 不知道"派发意图"；fabric 层不该碰绑定                                           | hub 在 `xs_deliver` 自动换绑（需信任意 xs 文本）                    |

## 6. 实施要点

1. **先落 `bindings-transfer.ts` 并把 `/use` 改过去**（`notifyLifecycle:false`），全套 feishu 测试须绿；
   同时给 `onBindingClosed` 加幂等键（D2），并补 A1b。
2. `service.ts:1916` 的 op 路由**必须**同步加两支，否则 rebind/acquire 永远落到 `requests.handback`
   拿 `E_THR_STATE`。
3. `agent-server.ts` 无需改（`thr_req` 已整体转给 `deps.threads`，`hub.ts:475-489`）。
4. `ThreadMeta.rev?` 是**可选追加**：hub 在 `feishuThreadMetaFor`（`thread-hub.ts:92-112`）里带上
   `record.bindingRev`；旧 agent 的 closed schema 会丢掉整个 `cmd.thread`？——**不会**：`ThreadMetaSchema`
   是 `additionalProperties:false`，多一个字段会让**旧 agent**拒帧。因此 `rev` 必须**同时**把
   agent 侧 schema 更新并 cap 门控（`ThrMeta` 出现在 `cmd` 的 prompt 变体里，`protocol/thread.ts:97`）。
   **结论：`ThreadMeta.rev` 只在双端都有 `thr.rebind.v1` 时附带**，否则字段缺席、字节不变（G2b 照旧成立）。
5. `ThreadToolParamsLegacy` 逐字节等于现状（先复制原文再派生）。
6. `directory.ts` 头注释与 `reopen`/`rev` 同一次提交改完。
7. `acquire` 在途 promise 在 `dispose()` 后不得写目录（照 `engine.subscribe` 的 `disposedFlag`）。
8. 计时器全部 `unref`（I5；`thread-child-tool.ts:86-92` 的 `sleep` 可复用）。
9. secure 域：`fabric.threads.enabled` 已被 D8 强制 false；单测断言 secure ⇒ `rebind=false`。

**风险点**

| 风险 | 描述                                          | 缓解                                                                                 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| R1   | worker 换绑瞬间下线                           | `selectSession`+`resolve` 在当刻校验；之后下线属正常 `/use` 覆盖                     |
| R2   | 新设置键撞 `settings-corpus`                  | 先跑该测试；不通过则改为独立块 `fabric.threadRebind`                                 |
| R3   | `E_THR_COMMIT` 后旧订阅者仍在收事件           | effect unknown 且不发 `thr_closed`，旧订阅者继续工作（正确降级）；文案不宣称"已转交" |
| R4   | `ThreadMeta.rev` 让旧 agent 拒帧              | 只在双端 `thr.rebind.v1` 时附带（见实施要点 4）                                      |
| R5   | `closedByRebind` 吞掉本该重试的 `commit` 失败 | 复用 `committed()` 的 park 重试，不自行吞                                            |

## 7. 验收（可断言矩阵）

单元：`tests/web-hub/hub/feishu/thread-rebind.test.ts`、`tests/web-hub/hub/feishu/bindings-transfer.test.ts`；
集成：`tests/integration/fabric-thread-rebind-e2e.test.ts`。

| ID   | 场景                                                | 断言                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Router 持话题，rebind → worker                      | `bindings.get(key)` 的 `{sessionId, rev: before.rev+1, chatId, chatType, threadId}` 全等；`thr_closed` 给旧 agent **恰好 1 次**；`thr_res.sessionId` = worker 完整 sid                                                                                                              |
| A1b  | `/use` 迁移后（`notifyLifecycle:false`）            | 一次 `/use` 换绑 ⇒ `onBindingClosed` 实际生效 **恰好 1 次**（幂等键命中第二次为 no-op）；`thr_closed` 1 次；终结 1 次                                                                                                                                                               |
| A2   | 换绑前存在 `accepted{thr:routed}`                   | 终态 `replied{thread-closed}`；`retainedCount` −1                                                                                                                                                                                                                                   |
| A3   | 首次绑定（key 不存在）经 `transfer`                 | `{ok:true, created:true, changed:true}`，**不是** `E_THR_NOT_BOUND`；`bindings.size` +1                                                                                                                                                                                             |
| A3b  | 解绑后再绑（`remove` 后同 key）                     | 同上；`rev` 比 remove 前更大（store-wide 计数器）                                                                                                                                                                                                                                   |
| A3c  | `/use` 选一个离线会话                               | 成功写入（`offline:null`、sessionId=该离线 sid），**不**因 `agentKey` 缺失被拒                                                                                                                                                                                                      |
| A4   | `fromRev` 过期（`/use` 走掉再切回后旧请求）         | `E_THR_STALE`，无写入、无 `thr_closed`                                                                                                                                                                                                                                              |
| A4b  | 目录无 rev，rebind 前强制 `acquire`                 | 先看到 1 次 `acquire` 往返，其 `rev` 被用作 `fromRev`；hub 侧 CAS 通过                                                                                                                                                                                                              |
| A5   | 普通 no-op（调用者仍是持有者、目标=自己）           | `changed:false`，rev 不变，`thr_closed` 0 次，commit 0 次                                                                                                                                                                                                                           |
| A6   | 目标 offline / read-only / ambiguous / unknown      | 四码分别返回，`bindings` 不变                                                                                                                                                                                                                                                       |
| A7   | `commit` 失败（P3）                                 | `E_THR_COMMIT` + `effect:"unknown"`；内存有新值、磁盘无；**不发** `thr_closed`；Router 随后 `acquire` ⇒ `E_THR_NO_OWNER`（内存已切走）；**不**出现 `changed:false`                                                                                                                  |
| A7b  | 成功回执丢失（P2）                                  | Router 重试同 dedupKey ⇒ 回放原回执（`rebound:true`），**不**出现 `E_THR_NO_OWNER`；若去重表已被淘汰 ⇒ `E_THR_NO_OWNER`（文档化降级）                                                                                                                                               |
| A8   | 限速                                                | 第 N+1 次 `E_THR_RATE`；按 `h` 计，不同 `h` 不互相影响；与 `post` 桶独立；失败计数                                                                                                                                                                                                  |
| A9   | 旧 hub × 新 agent                                   | 本地 `E_THR_UNSUPPORTED`，**零帧**（write 计数 0），不退化为超时                                                                                                                                                                                                                    |
| A10  | 新 hub × 旧 agent                                   | 旧 agent 不广告 `thr.rebind.v1` ⇒ hub 不发 `ThreadMeta.rev`、`cmd.thread` 字节不变                                                                                                                                                                                                  |
| A11  | **从真实 `dispatching` 状态**换绑后收到 routed 回执 | 记录终态 `replied{thread-closed}`；**无** `accepted{thr:routed}` 保留、`retainedCount` 不增；无 routed 事件 emit；`commit` 1 次；转移序列为 `dispatching→accepted→replied`（`transition` 全部 `ok`）                                                                                |
| A11b | 同上但走 `uncertain`（晚到 `cmd_late`）             | `uncertain→accepted→replied`，同样无保留、无 emit                                                                                                                                                                                                                                   |
| A11c | 保留回调到期时代际失配                              | 终态 `replied{thread-closed}`，`code !== "thread-routed"`                                                                                                                                                                                                                           |
| A12  | worker 首次接手（目录 unknown）                     | `subscribe` 先 `thread_unknown`；`acquire` 后 `reopen` 使 `isOpen(h)=true`，随后 `subscribe` 成功；目录条目 `rev` = `acquire` 回执 rev                                                                                                                                              |
| A13  | 同一 worker 二次接手（转回后再转来）                | 第一次换走后目录 `closed`；二次 `acquire`（`force:true`）⇒ `open`，`subscribe` 成功                                                                                                                                                                                                 |
| A14  | 伪造 `h`/`sessionId` 注入                           | 注入文本的 `fs:…` 不产生 `acquire`；伪造 `sessionId` ⇒ `E_THR_STATE`                                                                                                                                                                                                                |
| A15  | 同持有者多话题注入                                  | 持有者的**另一个**已知话题仍可转移；未持有的话题 `E_THR_NO_OWNER`                                                                                                                                                                                                                   |
| A16  | `threads on × rebind off` 字节一致                  | 新基线 `thread-rebind-off-golden.json`：工具 schema/description、`/thread` USAGE、hello caps、`HubConfig.feishuBot.threads`、`cmd.thread` 字段集全等于加功能前                                                                                                                      |
| A17  | secure 域                                           | `rebind` 恒 false；hello 无 `thr.rebind.v1`；工具无 `rebind` action                                                                                                                                                                                                                 |
| A18  | E2E 全链                                            | Router：`thread{rebind}` → `message_session{to: sid}`；worker：**先 `thread{acquire}` 再 `thread{subscribe}`**，之后断言其目录 `open`、话题后续事件 `cmd.thread.h` 命中、worker 被 steer；Router 回合数 = 1；**未 acquire 的子场景**：`subscribe` 报 `thread_unknown`，事件走主会话 |
| A19  | 保留期外 GONE（回归）                               | 换绑后旧持有者 handback 得 `E_THR_REBOUND`/`E_THR_HANDBACK_GONE`                                                                                                                                                                                                                    |

## 8. 需用户拍板（1 项，保持现状）

**触发方式**（A/B）：

- **A（推荐默认，本方案按 A 写）**：模型显式两步——`thread{action:"rebind"}` 拿回执 sid →
  `message_session{to:sid}`；工具描述写死顺序。半途失败可见。
- **B**：`message_session` 自动先换绑。代价：给高频工具塞隐式副作用；用户既有话题对话被静默改归属；
  且该工具 schema 是冻结常量（`tests/fixtures/fabric-xs-*-golden.json`）。

A 与已拍板方向不冲突，故本版按 A 写；选 B 需改写 §4.8 与 A18。

## 9. 评审处置

### 9.1 第一轮 r_F5W1N0BV（r1 → r2，已闭合）

| #   | 级别    | 处置                                                                                                                       | 落点                      |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Blocker | 接受：改为共享写操作 `bindings-transfer.ts`（快照→CAS→身份字段→`Admit`→commit 屏障→生命周期通知→reconcile），`/use` 一并改 | §2.1、§4.4、D1            |
| 2   | Blocker | 接受：`to` 经独立阶梯解析成完整 sid 再 `resolve` 复核，四类失败分列；写入保留 chat/thread 身份；检查 `Admit`               | §2.2、§4.4 R3/R4/R5、§4.6 |
| 3   | Blocker | 接受：`h` 换绑不变、目录 close 永久、xs 不登记 ⇒ 新增 `acquire` + `reopen`，只认 hub 应答；改写 `directory.ts` 注释        | §2.3、§4.7、§4.8          |
| 4   | Major   | 接受：独立 cap `thr.rebind.v1` + 本地预检 + 请求字段统一 + 回执按 op 唯一分支                                              | §4.2、§4.3、D3/D4         |
| 5   | Major   | 接受：同目标 no-op、持久化屏障、`E_THR_COMMIT`+unknown、恢复规则（r3 已重写，见 9.2 #3）                                   | §4.4 R2/R6、§4.9          |
| 6   | Major   | 接受：`h` 非授权凭证、只保护当前归属、CAS 拒过期、写明合法转移范围                                                         | §4.5                      |
| 7   | Major   | 接受：四段语义 + 代际复核（r3 已改为合法迁移序列，见 9.2 #5）                                                              | §2.5、§4.10               |
| 8   | Major   | 接受：Legacy/Rebind 双冻结实例、USAGE 双份、新增 rebind-off golden                                                         | §4.8、A16/A17             |
| 9   | Major   | 接受：自动化在 agent 工具层、唯一顺序、同步改 op 路由、E2E 真链                                                            | §3.2、§4.8、A18、§8       |
| 10  | Minor   | 接受：限速独立口径（按 h、3/min+20/h、成功失败都计数、LRU 64、`E_THR_RATE`）+ 可断言矩阵                                   | §4.5 末、§7               |

### 9.2 复审第二轮（r2 → r3，本轮闭合）

| #   | 未闭合点                                                                                       | 核实结论                                                                                                                                                                                   | 修订                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 共享操作破坏首次绑定/解绑后重绑；`agentKey` 必填与 `/use` 离线选择冲突；双重 `onBindingClosed` | 属实：`router.ts:156` 的 `set` 对 `prev===undefined` 合法（`state.ts:1779` 只在 cap 拒）；`select` 不要求 live（`sessions.ts:120-141`）；`onBindingClosed` 现有唯一调用点 `service.ts:990` | `transfer` 增 `created`、`before===undefined` 为正常路径（R1）、`E_THR_NOT_BOUND` 仅限带 `expect` 的 rebind（R1/R3）、`target.agentKey` 改可选（R3/R4）、`notifyLifecycle` 开关 + `onBindingClosed` 幂等键 `(key,before.rev)`（R6/R7）；新增 A3/A3b/A3c/A1b |
| 2   | A20 未执行 acquire 就断言目录 open；注释口径与"仍发 thr_closed{rebound}"矛盾                   | 属实：xs 文本不登记目录（`engine.ts:198` 仅由 `commands.ts:421-470` 的 cmd 帧驱动）                                                                                                        | §3.2 第 7/8 步写明"由 Router 派发模板要求 worker 先 acquire"；A18 改为"worker 先 acquire 再 subscribe 再断言"，并加"未 acquire 的安全降级"子场景；§2.3 与 §4.7 统一口径：**rebound 仍关闭旧目录**，重新获得归属后经可信 `acquire` 重开                      |
| 3   | "同目标 no-op 兜底重试"不成立；P2/P3 下不可达                                                  | 属实：P2 时 Router 已非持有者 ⇒ 权益门先拒（`thread-hub.ts:440` 的 `E_THR_REBOUND`/§4.5 第 2 条）；P3 时内存已指向 worker                                                                  | §4.9 拆成 P1/P2/P3 三条恢复路径；P2 用 `acquire` 判状态 + `rebindSeen` 回执去重（`E_THR_PENDING`）；P3 明确"不重发、由 state commit retry 承担"；删除 r2 的 A7 错误指引，A7 重写、新增 A7b                                                                  |
| 4   | `fromRev` 无获取/保存/失效规则；`acquire` 接口丢 rev；open 快路径不取 rev                      | 属实：`ThreadMeta` 无 rev（`protocol/thread.ts:97-118`）、`ThreadDirectoryEntry` 无 rev（`directory.ts:13-19`）、`status.threads` 只有 `{h,subs}`                                          | 新增 §4.7：三个可信来源（`ThreadMeta.rev?` / `acquire.rev` / `rebind.rev`）、单调 `max` 保存、`thr_closed` 清 rev、`force:true` 跳过 open 快路径、缺失 rev 时强制一次 `acquire`；`fromRev` 不进模型参数（§4.8）；A4/A4b 覆盖 `/use` 往返                    |
| 5   | 代际失配直接迁 `replied` 对 `dispatching` 非法                                                 | 属实：`REQUEST_TRANSITIONS`（`state.ts:130-142`）`dispatching` 无 `replied` 出口，`transition` 非法即拒（`state.ts:1695`）                                                                 | §4.10 改走合法链 `dispatching→accepted→replied`（同步一步、`detachRun` 先行、不 emit 中间态、失败退回 `rejected`），并给 `uncertain` 同规则；A11 改为**从真实 `dispatching` 起测**并断言两次 `transition().ok`；新增 A11b/A11c                              |

**遗留确认**：§8 触发层（A 推荐，保持现状；用户选 B 则改 §4.8/A18）。
