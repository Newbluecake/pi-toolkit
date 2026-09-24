# fabric v2 — 非阻塞、任意寻址、点对点 + 广播的 agent 间通信织网（实施方案 v1.3）

> ## ⛔ 状态：**已打回，搁置中（2 轮评审后）**
>
> 本文档 §0–§14 是 v1.3 原稿，**不得据此实施**。两轮独立评审（`cloudrouter-kimi/kimi-k3`
> 事实核查 + `cloudrouter-anthropic/claude-opus-5-5` 结构批判）共报出 **3 Blocker / 15 Major**，
> 其中一条推翻了本方案赖以成立的成本前提（见 §15.1）。
>
> **逐条处置与更正见 §15。** 下一步不是修文重写，而是先跑
> [`baseline-experiment.md`](./baseline-experiment.md) 量化收益，再决定工程投入规模。
> 需求方已拍板走这条路线。

## 0. 背景与需求

### 0.1 问题陈述（需求方原话要点）

主 agent 作为调度器，把前一个 agent 的结果以文件/上下文的形式转接给下一个 agent，但下一个
agent 仍然做大量重复调研。需求方要求的机制是：**新 agent 可以向主 agent 或已结束的 agent
请教知识，而不是反复自己调研。**

### 0.2 三条硬需求（需求方明确约束）

| #   | 需求                     | 含义                                                                        |
| --- | ------------------------ | --------------------------------------------------------------------------- |
| R1  | 点对点 + 广播            | 任意两个 agent 之间可通信；也可一对多广播                                   |
| R2  | **不能阻塞**             | 不能保证对方知道发送者需要的信息，也不能保证对方有能力回复 ⇒ 发送方绝不等待 |
| R3  | **不限制发送消息的能力** | 不设"谁能给谁发"的权限白名单                                                |

### 0.3 由 R1–R3 推出的核心语义转换

R1 + R3 合在一起的后果是：无限制广播 + 推送式投递 = context 投毒 + turn 放大（N 个接收者
= N 份 context + N 次模型 turn）。因此：

> **约束不能放在"谁能给谁发"（发送权限），必须放在"什么进得了我的 context"（接收侧摄取预算）。**

本仓库已有该模式的先例：`rootInboxCap: 12`（`src/fabric/router.ts` `rootInbox()`）是纯接收侧
摄取上限。v2 把它**泛化到每个接收者**，同时拆掉 `can_message` 发送权限闸。

配套原则：**超限不拒收，只降响度**（push → notify → pull）。全链路不存在
`message not authorized`，R3 得到字面满足。

### 0.4 已拍板决策（需求方）

| 决策                 | 选择                                                                   | 落点 |
| -------------------- | ---------------------------------------------------------------------- | ---- |
| 直达消息默认投递纪律 | **分级**：对「我发出的 query」的 answer/nack → push；其他直达 → notify | D-1  |
| `can_message` 字段   | **彻底删除**                                                           | D-2  |
| 看板持久化范围       | **仅当前主 session**（`appendEntry` 读回）                             | D-3  |

---

## 1. 现状核实表（读码验证，带行号）

| 接缝                                                                                                                                            | 位置                                                         | v2 影响                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `MessageKind` = progress/finding/directive/result/dead_letter                                                                                   | `src/core/message.ts:5`                                      | 新增 query/answer/nack/announce                             |
| `NodeRef` = RunId \| "root" \| "system"；`validNode()`                                                                                          | `src/core/message.ts:7,41-43`                                | 新增 `"board"`                                              |
| `makeMessageKey(from,to,generation,seq)` = correlation id 天然载体                                                                              | `src/core/message.ts:46-56`                                  | `replyTo` 直接复用该 key                                    |
| `authorize({kind,relation,canMessage,from,mention})`                                                                                            | `src/core/message.ts:105-117`                                | 删 `canMessage`/`mention`，只留方向性规则                   |
| `effectiveChannel(kind, progressChannel, canRenderEntries, to)`                                                                                 | `src/core/message.ts:119-126`                                | 重构为 `resolveDiscipline()`                                |
| `formatMessage()` 带 `不可信输入: from -> to` 头                                                                                                | `src/core/message.ts:128-136`                                | 保留，新 kind 复用                                          |
| `FabricRecord` 状态 pending/claimed/delivered/consumed/dropped/abandoned                                                                        | `src/core/message.ts:23,37`                                  | **不新增状态**（见 §4）                                     |
| `rejected: {reason: "quota_exhausted"\|"target_backpressure"}`                                                                                  | `src/core/message.ts:32`                                     | 新增 `"duplicate"` / `"hop_exhausted"`                      |
| `FabricRouter.admit()`：发送方 per-kind 配额 + root ingress cap + progress supersede + truncate                                                 | `src/fabric/router.ts:97-170`                                | 配额语义改写；discipline 在 admit 定；扇出裁定              |
| `rootInbox()` 接收侧占用统计                                                                                                                    | `src/fabric/router.ts:172-184`                               | **泛化为 `inboxOf(node)`**                                  |
| `issueDeadLetters()` 原子序 + 去重（`dlRefs`/`dlPlaceholders`）                                                                                 | `src/fabric/router.ts:196-256`                               | 保留；新增"转存看板"作为优先终结方式                        |
| `FabricMailbox.pump()/dispatch()/boundedSend()/verdict()/rescheduleWake()`                                                                      | `src/fabric/mailbox.ts:41-215`                               | **只处理 `discipline==="push"` 记录**                       |
| `boundedSend` 用 `fabricSteerTimeoutMs = settings.budget.steerMs`（5s）赛跑                                                                     | `src/fabric/mailbox.ts:118-146`；`deadline.ts:16`            | 不变                                                        |
| `FabricThrottle`：per-link `minIntervalMs`(30s) + `rootMinIntervalMs`(10s) + 指数 backoff                                                       | `src/fabric/throttle.ts`                                     | per-link 保留；root 专属项泛化为 per-receiver               |
| `FabricTree`：edges/tombstones/relation/lca/hops/isRootChild/targetState                                                                        | `src/fabric/tree.ts`                                         | **从授权判据退化为溯源标注**；`isRootChild` 不再 gating     |
| `createMentionChannel()`：终态目标 → `spawn({resumeFrom})` 携带消息 resume                                                                      | `src/fabric/mention.ts:29-70`                                | 复用为**非阻塞 auto-revive**；删 `canMessage`/root 直属校验 |
| `buildFabric()`：DeliveryEngine `allowed` 转移表、tree 从 `subagent:run` prefetched 条目重建、三个 port                                         | `src/stack.ts:234-334`                                       | 加 board store；port 增 `postBoard`                         |
| port `inject` = `runner.steer`；`sendRootContext` = `pi.sendMessage(deliverAs:"steer", triggerTurn:true)`；`sendRootDisplay` = `pi.appendEntry` | `src/stack.ts:290-322`                                       | push 用前两者；notify 对 root 用第三者                      |
| `fabric.enabled` 总开关（默认 **false**）                                                                                                       | `src/stack.ts:877`；`settings.ts:425`                        | 保留为唯一全局开关                                          |
| `mailbox.pump(runId)` / `onRunSettled(runId)` 生命周期接线                                                                                      | `src/stack.ts:1127-1130`                                     | 不变                                                        |
| `message_agent` 仅注入**子会话**（`customTools` + `grantedReserved`）                                                                           | `src/service/runtime-adapter.ts:378-405`                     | **主会话也需注册**（否则 root 无法回答，见 §6.3）           |
| `RESERVED_TOOL_NAMES` 含 `message_agent`，deny-by-default                                                                                       | `src/runtime/tool-scope.ts:22-38`                            | 新增 `read_board`                                           |
| `can_message` 类型与解析                                                                                                                        | `src/core/types.ts:133`；`src/config/agent-types.ts:104-110` | **删除**（§9）                                              |
| `pi-outbox-store`：`appendEntry` + 读回校验（append-only）                                                                                      | `src/adapters/pi-outbox-store.ts:8-52`                       | 看板持久化直接复用该模式                                    |
| `before_agent_start` 预算化注入钩子（memory 先例：pin/围栏/指纹缓存）                                                                           | `src/memory/index.ts:51`                                     | 看板摘要注入复用同一套                                      |
| `DEFAULT_BUDGET.toolMs = 600_000`；tool 阶段不吃 `idleMs`                                                                                       | `src/core/deadline.ts:12`；`:72`                             | 非阻塞设计下不再需要（记录备查）                            |
| `SpawnRequest`：`resumeFrom`/`schema`/`deadlineAt`/`slotless`/`budgetOverride`/`parentRunId`                                                    | `src/core/types.ts:150-215`                                  | auto-revive 直接复用，无需新增入参                          |
| `SessionSpec`：`tools`/`excludeTools`/`noTools`/`customTools`                                                                                   | `src/core/types.ts:592-614`                                  | 备查（v2 不做只读 consult 会话）                            |
| `resumeLocks` 对同目标串行；resume 命中同 label 会 `repoint`                                                                                    | `src/service/spawn-service.ts:371-419`                       | auto-revive 的并发与改名约束（§8 结局③）                    |

---

## 2. 决策留存表

| ID       | 决策                                                                                                                                | 理由                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **D-1**  | 地址与投递纪律**正交**：地址由发送方定（不设限），纪律由系统+接收侧定                                                               | R3 与 context 有界性唯一的相容解（§0.3）                                                                                       |
| **D-1a** | ⚠️ **待签字**：directed `query` 默认 notify，发送方可置 `urgent:true` 请求 push                                                     | 严格遵从 D-1 会让运行中目标永不回答（§13 G1）                                                                                  |
| **D-2**  | 删除 `can_message`；`authorize()` 只保留方向性协议规则                                                                              | R3。方向性规则不是权限而是协议自洽（result 必须上行等）                                                                        |
| **D-3**  | 看板仅当前主 session（`appendEntry` 读回），不跨会话                                                                                | 需求方选择；无陈旧治理成本。跨会话复利留 v2（memory 子系统已可承载）                                                           |
| **D-4**  | **不新增 FabricRecord 状态**；discipline 在 `admit()` 一次定死，永不变更                                                            | 保持状态机纯净，最小化 AGENTS.md 要求的转移矩阵/属性测试 lockstep 改动                                                         |
| **D-5**  | 广播 = **1 条看板记录**（`to:"board"`），恒 O(1)，绝不 N 路 push                                                                    | 唯一能让 R1 的广播不炸成本的结构                                                                                               |
| **D-6**  | 超限**降级**（push→notify→pull），不拒收                                                                                            | R3 字面满足：任何一次发送都不会失败                                                                                            |
| **D-7**  | `nack`（"我不知道"）是一等公民 kind                                                                                                 | R2 直接后果：让发送方尽早转自查，比等超时快一个数量级                                                                          |
| **D-8**  | 迟到/无法投递的 `answer` **转存看板**，不发死信                                                                                     | 非阻塞把"迟到"从失败变为知识沉淀——下一个碰到同问题的 agent 直接读到                                                            |
| **D-9**  | 终态目标 → **后台非阻塞 auto-revive**（复用 mention resume 分支 + `slotless` + `deadlineAt`）                                       | 满足"已结束的 agent 可重新拉起"，且不引入阻塞 consult 的 slot 死锁/resumeLocks 互等                                            |
| **D-10** | 四道**幅度闸**（非权限闸）：接收侧摄取预算、digest 去重、hop 上限、存储/扇出天花板                                                  | 非阻塞下环不再死锁，只会放大；这四道掐死放大                                                                                   |
| **D-11** | `tree.ts` 保留但降级为溯源标注（`via.lca/hops`、relation 仅作展示供接收方判断可信度）                                               | 审计价值高、成本零；删掉会丢失消息溯源                                                                                         |
| **D-12** | `announce` 强制带 `topic` 或 `scope.files` 之一；`answer` 强制带 `evidence[{file,lines}]`                                           | 答案是"另一个 LLM 的记忆"，可能幻觉或过期；强制证据让接收方 O(1) 抽查而非 O(n) 重查                                            |
| **D-13** | 相关性 = **接收方兴趣域 × 消息结构化检索键**的交集；**默认不相关**。文件域优先于 topic（§6.5）                                      | topic 是自然语言必然漂移；文件/符号域机器可判定且本就是工作拆分单位。这是 §0.3 语义转换的下半场：摄取预算管"量"，兴趣域管"质"  |
| **D-14** | **唤醒权只属于点对点**：只有 `audience.kind === "direct"` 可产生 W1（turn 唤醒）或 W2（复活唤醒）；广播恒不唤醒（不变量 I-W，§3.7） | 需求方硬约束。广播命中 N 个文件域就唤醒 N 个 agent，会把"广播恒 O(1)"炸回 O(N)；唤醒必须是具名、担责、计入接收方预算的定向动作 |

---

## 3. 协议设计

### 3.1 NodeRef 扩展

```ts
export type NodeRef = RunId | "root" | "system" | "board";
```

`validNode()` 增加 `"board"`。`makeMessageKey` 的 generation 规则不变（`from === "system"` 恒
0；其余 ≥ 1）——广播记录的 `from` 是发送 run，generation 取其活跃 generation。

### 3.2 MessageKind 扩展

```ts
export type MessageKind =
  | "progress"
  | "finding"
  | "directive"
  | "result"
  | "dead_letter" // v1 保留
  | "query" // 提问：无义务、无阻塞、可被忽略
  | "answer" // 回答：replyTo 指回 query
  | "nack" // 「我不知道 / 不在我的范围」
  | "announce"; // 广播公告（恒落看板）
```

### 3.3 信封增量（`src/core/message.ts`）

```ts
export interface MessageEnvelope {
  // ... v1 字段不变（key/from/to/kind/seq/generation/payload/ref/via/ttlMs/createdAt）
  audience?:
    { kind: "direct"; to: NodeRef } | { kind: "topic"; topic: string } | { kind: "roster"; selector: RosterSelector };
  replyTo?: MessageKey; // 问答关联；v1 的 from:to:generation:seq 即 correlation id
  topic?: string; // 看板归档键；announce 必填
  urgent?: boolean; // D-1a：发送方请求 push（仍受接收侧降级）
  hop?: number; // 转发跳数，默认 0
  digest?: string; // 内容哈希，去重用
  discipline?: "push" | "notify" | "pull"; // 系统裁定结果，非发送方请求
  scope?: { files?: string[]; symbols?: string[] }; // 结构化检索键；files 支持 glob（D-13）
  mutation?: boolean; // 声明「我改了 scope.files」⇒ 触发失效预警破格 push（§6.5 L3）
  evidence?: Array<{ file: string; lines?: string; quote?: string }>; // answer 必填
  freshness?: { gitHead?: string; at: Millis };
}

export type RosterSelector =
  { kind: "running" } | { kind: "type"; name: AgentTypeName } | { kind: "subtree"; root: RunId };
```

### 3.4 `authorize()` 重写（删 `can_message`）

```ts
export function authorize({ kind, relation, from, to }: AuthorizationInput): boolean {
  if (!MESSAGE_KINDS.includes(kind)) return false;
  // 方向性协议规则（不是权限，是协议自洽）：
  if (kind === "dead_letter") return from === "system";
  if (kind === "result") return relation === "child"; // 结果只能上行
  if (kind === "directive") return relation === "parent"; // 指令只能下行
  // progress / finding / query / answer / nack / announce：任意关系全开（R3）
  return true;
}
```

`relation === "unrelated" | "self"` 不再被拒（跨树、任意深度、同级全通）。`mention` 分支与
`MentionRoute` 随 `can_message` 一并删除——mention 退化为"用 `@label` 做寻址"的语法糖，不再是
一种独立的授权模式（`via.mode` 保留，仅作溯源展示）。

### 3.5 `resolveDiscipline()` —— 替代 `effectiveChannel()`

纯函数，在 `admit()` 内调用一次，结果写进记录后**永不变更**（D-4）。

```ts
export function resolveDiscipline(input: {
  kind: MessageKind;
  audience: Envelope["audience"];
  replyTo?: MessageKey;
  urgent?: boolean;
  isReplyToOpenQueryOf: (to: NodeRef, replyTo?: MessageKey) => boolean; // 接收方确实问过
  inboxUsed: number; // 接收方当前摄取占用
  inboxCap: number;
  canRenderEntries: boolean;
}): "push" | "notify" | "pull" {
  // ① 广播恒不 push，且恒不唤醒（D-5 / D-14 / 不变量 I-W）
  if (input.audience?.kind !== "direct") return "pull";
  // ② 协议消息保持 v1 语义
  if (input.kind === "result" || input.kind === "directive" || input.kind === "dead_letter") return "push";
  // ③ D-1：对「我发出的 query」的回答/婉拒 → push
  const answering =
    (input.kind === "answer" || input.kind === "nack") &&
    input.isReplyToOpenQueryOf(/* to */ input.audience.to, input.replyTo);
  // ④ D-1a（待签字）：发送方显式请求
  const wants = answering || input.urgent === true;
  if (!wants) return "notify";
  // ⑤ D-6：接收侧摄取预算耗尽 ⇒ 降级，绝不拒收
  return input.inboxUsed < input.inboxCap ? "push" : "notify";
}
```

`progressChannel` 设置项保留解析但标记 legacy：`"display"` 映射为"root 的 notify 走
`sendRootDisplay`"，`"context"` 映射为"root 的 notify 走 push"（行为等价于旧配置）。

### 3.7 唤醒模型与不变量 I-W（D-14）

「唤醒」在 v1 文档里与「投递」混着说，v1.2 起显式拆为两种形态：

| 形态   | 含义                                       | 机制                                                                                        |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **W1** | turn 唤醒：让**运行中**的 agent 立刻起一轮 | `push`（`runner.steer`；对 root 为 `sendRootContext(deliverAs:"steer", triggerTurn:true)`） |
| **W2** | 复活唤醒：让**终态** agent 重新起一个 run  | auto-revive（`spawn({resumeFrom})`，D-9）                                                   |

> **不变量 I-W**：只有 `audience.kind === "direct"` 的消息可以产生 W1 或 W2。
> 任何广播（`topic` / `roster`）**恒不唤醒**任何 agent。

三个强制落点（缺一条即违反 I-W）：

1. `resolveDiscipline()` 对非 direct 恒返回 `"pull"`（已有，D-5）——封住 W1；
2. **W2 的触发条件必须同时满足** `audience.kind === "direct"` **且** `kind === "query"`
   （或 `result`/`directive` 的协议路径）。`progress`/`finding`/`announce` 发给终态目标一律
   落看板，绝不 revive——把一个已结束的 agent 拉起来只为听一条通报是纯烧钱；
3. **roster selector 命中终态 run 时不得 revive**：`{kind:"type"}` / `{kind:"subtree"}` 会匹配到
   已结束的 run，扇出时必须先按 `targetState === "running"` 过滤，且该过滤不产生任何 W2。

**升级通道**：若一条广播确实重要到需要唤醒某人，发送方必须**显式对该接收方再发一条点对点
消息**。唤醒因此永远是具名、可审计、计入接收方 `inboxCap` 的动作，滥用面天然收窄。

**root 的唤醒**：direct → root 的 push 会在用户空闲时也启动主会话的一轮。这是"向主 agent 请教"
的必要代价，由既有 `rootInboxCap: 12` 约束；需要彻底禁止时置 `fabric.wakeRoot: false`
（此时 root 的一切入站消息降级为 `sendRootDisplay` + 看板，主 agent 只能主动 `read_board`）。

### 3.6 投递纪律的真实语义（**必须如实记录的能力边界**）

| 纪律     | root 接收方                                                            | 运行中子 agent 接收方                                                                                                                           | 终态 agent 接收方             |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `push`   | `sendRootContext`（`deliverAs:"steer"` + 触发一轮）                    | `runner.steer` 注入并触发一轮                                                                                                                   | 触发 auto-revive（D-9）       |
| `notify` | `sendRootDisplay`（`appendEntry`，**display-only，不进模型 context**） | **看板落地 + 机会式提示**：pi 没有"不触发 turn 就注入运行中会话"的原语，所以只能等该 agent 下次调用 `read_board` / 我们自己的工具时捎带一行提示 | 落看板，等未来某个 agent 读到 |
| `pull`   | 需主动 `read_board`                                                    | 需主动 `read_board`；新 spawn 的 agent 由 `before_agent_start` 注入看板摘要                                                                     | 同上                          |

> **这是全方案最重要的诚实声明**：`notify` 对运行中的接收方是 **best-effort，可能永远不被看到**。
> 这正是 R2 承认的前提（"不能保证对方知道，也不能保证有能力回复"）；但它直接决定了 D-1a 的必要性
> （§13 G1）。

---

## 4. 状态机与转移表

### 4.1 不新增状态（D-4）

沿用 `pending / claimed / delivered / consumed / dropped / abandoned`，**不新增状态**。

> **v1.3 更正（自查发现，原 v1 表述错误）**：`src/stack.ts:246` 的实际转移表是
> `pending: ["claimed", "consumed", "dropped", "abandoned"]` —— **`pending → delivered` 当前
> 并不被允许**。因此 §4.2 的 notify/pull 路径**必须**给 `pending` 的允许集合追加 `"delivered"`
> 一项（单条增量，仍不新增状态）。原稿"`allowed` 表结构不变"的说法不成立，已更正。
> 备选方案（不采用）：让 notify/pull 也走 `pending → claimed → delivered`，以保表不变——
> 但为一次本地看板写入走一遍 claim/token 协议是纯仪式性开销，无收益。

### 4.2 按 discipline 分岔的两条路径

```
discipline = "push"    → pending → claimed → delivered | consumed | dropped | abandoned
                          （完全沿用 v1 mailbox 的 claim/boundedSend/verdict/backoff/死信链路）

discipline = "notify"  → pending → delivered            （看板写入成功即 delivered）
discipline = "pull"    → pending → delivered            （同上）
                          terminalReason = "board"
                          ⚠️ 需给 allowed.pending 追加 "delivered"（见 §4.1 v1.3 更正）
```

**关键简化**：`notify`/`pull` 记录在 `admit()` 内同步落看板即 `delivered`，**不进 mailbox**。
"turn 边界提示"是看板的一个**视图**（由 read cursor 算出），不是消息记录 ⇒ 不产生额外记录、不产生
额外转移。`FabricMailbox.pump()` 的候选筛选条件加一条 `r.discipline === "push"`。

### 4.3 新增终结原因

| terminalReason   | 触发                                                                      | 终态                                           |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `board`          | notify/pull 记录落看板成功                                                | `delivered`                                    |
| `board_fallback` | push 失败（target_gone/attempts_exhausted）且有 `topic` ⇒ 转存看板（D-8） | `delivered`                                    |
| `duplicate`      | digest 命中去重窗口                                                       | `dropped`（`rejected.reason="duplicate"`）     |
| `hop_exhausted`  | `hop > maxHops`                                                           | `dropped`（`rejected.reason="hop_exhausted"`） |
| `answered`       | query 收到对应 answer/nack ⇒ 同 link 其余 pending 同题 query 可 supersede | `consumed`                                     |

死信只在 push 失败**且无 topic 可转存**时签发，保留 v1 的原子序与"一条原始消息至多一条死信"
（`dlRefs`/`dlPlaceholders`）。

### 4.4 lockstep 更新清单（AGENTS.md 硬要求）

- `src/stack.ts:246` `allowed.pending` 追加 `"delivered"`（§4.1 v1.3 更正；**易漏，必须逐条核对**）
- `src/core/state-machine.ts` 转移矩阵 + `tests/core/state-machine.test.ts`
- fabric 状态属性测试（seeded invariants）
- `tests/fabric/router.test.ts` 配额→摄取预算的语义切换
- `tests/fabric/mailbox.test.ts` push-only 筛选、board_fallback 路径

---

## 5. 组件设计（文件级）

| 文件                                             | 改动                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/message.ts`                            | NodeRef +`board`；4 个新 kind；信封 8 个新字段；`authorize()` 重写；`resolveDiscipline()` 取代 `effectiveChannel()`；`digestOf()`             |
| `src/core/state-machine.ts`                      | 新 terminalReason 归属                                                                                                                        |
| `src/fabric/board.ts`（新）                      | 主题看板：append-only 写入、topic 索引、per-reader cursor、容量截断、`entriesFor(reader, since)`                                              |
| `src/fabric/router.ts`                           | 配额→`inboxOf(node)` 摄取预算；discipline 裁定；扇出裁定（direct→1 条 / 广播→1 条 `to:"board"`）；digest 去重；hop 检查；`answered` supersede |
| `src/fabric/mailbox.ts`                          | `pump()` 只取 `discipline==="push"`；`verdict()` 失败分支优先 `board_fallback`                                                                |
| `src/fabric/throttle.ts`                         | `rootMinIntervalMs` 泛化为 `receiverMinIntervalMs`（root 保留独立更严的值）                                                                   |
| `src/fabric/tree.ts`                             | 删 `isRootChild` 的 gating 用法（函数保留供展示）；`relation` 仅供 `formatMessage` 标注                                                       |
| `src/fabric/mention.ts`                          | 删 `canMessage`/root 直属校验；resume 分支改为 fire-and-forget（不等 spawn 结果即返回 `{status:"reviving"}`）                                 |
| `src/tools/message-agent-tool.ts`                | 新参数 `topic`/`audience`/`replyTo`/`urgent`/`evidence`；返回文案显式写明「不阻塞，别等」                                                     |
| `src/tools/read-board-tool.ts`（新）             | `read_board({topic?, since?, limit?, from?})`，推进 cursor                                                                                    |
| `src/service/runtime-adapter.ts`                 | 注入 `read_board`；`grantedReserved` 加 `read_board`                                                                                          |
| `src/index.ts` / `src/stack.ts`                  | **主会话也注册 `message_agent` + `read_board`**（§6.3）；board store 装配；`postBoard` port；`before_agent_start` 注入看板摘要                |
| `src/runtime/tool-scope.ts`                      | `RESERVED_TOOL_NAMES` += `read_board`                                                                                                         |
| `src/config/settings.ts`                         | `fabric.*` 新键（§7.4）；旧 per-kind 配额键保留解析但降级为存储上限                                                                           |
| `src/core/types.ts`、`src/config/agent-types.ts` | 删 `can_message`（§9）                                                                                                                        |
| `src/adapters/fabric-entry-renderer.ts`          | 渲染新 kind（query/answer/nack/announce）与 notify 提示行                                                                                     |

---

## 6. 看板（`src/fabric/board.ts`）

### 6.1 职责

广播的落地载体 + 迟到答案的归宿 + 新 agent 的启动知识来源。**同时取代"主 agent 手动转接文件"
这个动作**——这是本方案对原始问题（重复调研）的主要回答。

### 6.2 持久化（D-3）

`appendEntry(customType: "subagent:board", entry)` + 读回校验，完全复用
`src/adapters/pi-outbox-store.ts:8-52` 的模式（append-only、无 ack、写后读回）。
`session_start` 时从 prefetched 条目重建（与 `src/stack.ts:255-266` 重建 tree 的写法同源）。
**不跨会话**：新主会话看板归零。

容量：全局 FIFO 上限 `boardCap`；每 topic 上限 `boardTopicCap`；截断时优先保留
①最新、②被 `replyTo`/`ref` 引用过的条目。

### 6.3 主会话也必须持有 `message_agent`

当前 `message_agent` 只注入子会话（`src/service/runtime-adapter.ts:378-405`）。需求场景
"新 agent 向**主 agent** 请教"要求 root 能回答 ⇒ 主会话必须注册 `message_agent` + `read_board`
（post-guard、`fabric.enabled` 门控）。root 收到 directed `query` 时：

- `urgent` 且预算充足 ⇒ push 进 root context（主 agent 当轮就能回答）；
- 否则 ⇒ `sendRootDisplay` 一行提示 + 落看板，主 agent 可用 `read_board` 主动取。

### 6.4 新 agent 的启动注入

`before_agent_start` 注入 `## 看板` 块，复用 `src/memory/` 的预算化渲染（pin/agent-source 围栏/
指纹缓存/tail sentinel）。注入 **topic 目录 + 命中兴趣域条目的一行摘要**（不是全文），并给出
`read_board` 取全文的指引——topic 目录的作用是让 agent 至少知道"存在哪些话题"，缓解兴趣域声明不全。

### 6.5 相关性判定（D-13）

> 回答"agent 如何确认一条消息是否和自己相关"。**默认不相关**：发送无限制，但只有命中接收方
> 兴趣域的消息才进入它的视野。与 §7 的关系：**摄取预算管"量"，兴趣域管"质"**。

### L0 寻址即相关（机器可证，零成本）

| 信号                                                    | 强度 | 备注                                                                                            |
| ------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `replyTo` ∈ 接收方发出过的 query key 集合               | 最强 | **机器可证明**（我发过 key K，这条 `replyTo === K`），零语义判断。这正是 D-1 让该类 push 的依据 |
| `audience.kind === "direct" && to === me`               | 强   | 但"发给我"≠"对我有用"，仍需 L1/L2 过滤                                                          |
| `audience.roster.selector` 命中（type/subtree/running） | 中   | 发送方侧定向                                                                                    |

路由器需为每个 run 维护 `openQueries: Set<MessageKey>`（发出即入，收到对应 answer/nack 即出，TTL
清理）；§3.5 `resolveDiscipline()` 的 `isReplyToOpenQueryOf` 即查此集合。

### L1 结构化检索键：**文件域优先于 topic**

`topic` 是自由文本，必然漂移（`fabric-routing` / `消息路由` / `router` 指同一件事）。编码 agent
场景下最可靠的检索键是 **文件/符号域**：机器可判定（glob 交集）、不漂移，且**本就是工作拆分的
单位**——dev-flow 的文件域拆包与 `conflict-check.mjs` 算的正是它，调度方派单时已经持有该信息。

### L2 接收侧兴趣域（三来源，逐级兜底）

| 来源         | 机制                                                                                                                                                                                                              | 可靠性                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **显式下发** | spawn 时写入 `interests: {topics, files, symbols}`——调度方拆包时已知文件域                                                                                                                                        | 高，**推荐主路径**                                                                           |
| **自主订阅** | agent 运行中 `subscribe({topics, files})` 追加                                                                                                                                                                    | 高                                                                                           |
| **隐式累积** | 从 `diag.toolHistory[].argsPreview` 提取 read/edit/write 的路径——`previewToolArgs` 的 preferred key 含 `path`/`file_path`（`src/runtime/session-driver.ts:105-125`，`src/core/types.ts:222-230`），**零新增埋点** | best-effort：80 字符截断 + ring 淘汰 + `bash` 优先取 `command`。**只能兜底，不可作唯一依据** |

`read_board` 默认视图 = 按调用方兴趣域过滤；`read_board({ all: true })` 为逃生阀。

### L3 失效预警：负相关也是最强相关（**但不唤醒**）

`scope.files ∩ 接收方文件域 ≠ ∅` 且 `mutation === true` ⇒ 该条目对接收方**优先级最高**：
在看板默认视图与 `before_agent_start` 注入摘要中**置顶**，并标注 `⚠️ 你依赖的文件已被修改`。

> **v1.2 修正（D-14 / I-W）**：v1.1 原写"破格 push"——**已撤销**。`mutation` 通常由 `announce`
> 携带，而 announce 是广播，广播恒不唤醒。一条广播命中 N 个 agent 的文件域就唤醒 N 个，
> 会把"广播恒 O(1)"的成本结构炸回 O(N)，正是 I-W 要防的事。

因此失效预警是**被动**机制：接收方在下一次自然取用（turn 边界提示 / `read_board` /
启动注入）时看到置顶条目。**残余风险**：接收方可能在看到之前就基于失效前提干完了活（§13 R-W）。
两条缓解——① 调度方（主 agent）判断严重时用**点对点 directive** 主动唤醒，这是合规的 W1；
② 修改方在广播之外，对已知受影响的 agent 追发点对点消息。

副产品不变：看板同时是 dev-flow 冻结面/文件域纪律的运行时预警通道，只是预警"不敲门"。

### L4 语义判定（最后才动模型）

不造分类器，模型是最终裁判；系统只保证 headline 自带判别信息，形式为
`[topic] [scope.files] 结论一句 (from, 年龄, gitHead)`：

```
[fabric/router] src/fabric/router.ts,throttle.ts — admit() 配额按 from 计数，改语义须同步 hydrate  (@explorer, 12m, abc1234)
```

只读 headline 的 token 成本决定是否 pull 全文。

### L5 防误判元数据（让接收方正确地**不**相信）

`freshness.gitHead` 对不上即标 ⚠️ 可能过期；`evidence` 支持 O(1) 抽查；`不可信输入: from -> to` 头；
`from` + relation 作为信任先验。

### 失效模式（如实记录）

| 失效                   | 缓解                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| topic 命名漂移         | `scope.files` 兜底（机器判定不漂移）+ 调度方下发 topic 词表 + topic 前缀层级（`fabric/router`） |
| 兴趣域声明不全         | `{all:true}` 逃生阀 + 启动注入给 **topic 目录**（§6.4）                                         |
| 真相关但发送方未打标签 | 不可避免。只能靠 D-12 强制标签 + headline 质量约束缓解                                          |

---

## 7. 摄取预算与四道幅度闸（D-10）

| 闸               | 机制                                                                                                                      | 默认                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 接收侧摄取预算   | `inboxOf(node)` 统计该接收方 `pending\|claimed` 且 `discipline==="push"` 的条数；满 ⇒ 降级 notify                         | `inboxCap: 8`（root 沿用 12）        |
| 内容去重         | `digest = sha256(kind + topic + normalizedText)`；同 `(digest, to)` 在窗口内已存在 ⇒ `duplicate`                          | `dedupeTtlMs: 600_000`               |
| 跳数上限         | 转发/回声时 `hop+1`；超限 ⇒ `hop_exhausted`                                                                               | `maxHops: 3`                         |
| 扇出与存储天花板 | 广播恒 1 条记录；outbox FIFO 上限；看板容量截断                                                                           | `boardCap: 500`、`boardTopicCap: 50` |
| 唤醒闸（新）     | 只有 direct 消息可产生 W1/W2；广播（topic/roster）恒不唤醒；W2 另需 `kind==="query"`（§3.7）                              | 不变量 I-W，无配置项（硬规则）       |
| 公平份额（新）   | per-sender 看板份额上限：一个话痨不能挤占看板。**fairness 不是 permission**——超限时淘汰该 sender 自己最旧的条目，而非拒收 | `boardSenderSharePct: 25`            |

per-link 平滑沿用 `FabricThrottle.minIntervalMs`（30s），但**超时只推迟不拒收**（v1 已如此）。

### 7.4 settings 增量

```jsonc
"fabric": {
  "enabled": false,              // 保留，唯一全局开关
  "inboxCap": 8,                 // 新：per-receiver 摄取预算
  "rootInboxCap": 12,            // 保留（root 更宽）
  "receiverMinIntervalMs": 30000,
  "rootMinIntervalMs": 10000,
  "dedupeTtlMs": 600000,
  "maxHops": 3,
  "boardCap": 500,
  "boardTopicCap": 50,
  "boardSenderSharePct": 25,          // 新：单发送方看板份额上限（公平闸）
  "boardInjectBudgetChars": 2000,
  "relevanceImplicitInterest": true,  // 新：是否用 toolHistory.argsPreview 兜底推断兴趣域
  "relevanceMutationPriority": true,  // 新：失效预警置顶看板（**不唤醒**，§6.5 L3 / I-W）
  "reviveOnDirectQuery": true,        // 新：W2 仅由 direct + kind==="query" 触发（§3.7）
  "wakeRoot": true,                   // 新：允许 direct 消息唤醒主会话；false ⇒ root 入站一律降级
  "autoRevive": true,            // D-9 开关
  "autoReviveMaxPerSession": 10,
  // legacy（解析但降级为存储上限，不再作为发送权限）：
  "maxPerRun": 20, "findingQuota": 10, "directiveQuota": 5, "deadLetterQuota": 5,
  "maxChars": 2000, "progressTtlMs": 900000, "progressChannel": "display"
}
```

---

## 8. 非阻塞问答的完整生命周期

```
A: message_agent({ to:"@expert", kind:"query", topic:"arch-decisions",
                   text:"你当时为什么否决了方案 X?" })
   → 工具立即返回：
     「已投递，不阻塞。若收到回答会作为消息进入你的上下文。
       不要为此等待——继续当前工作，或先做粗筛。」
   → A 继续干活（关键：它没有停下来）
```

| 结局                | 处理                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 对方在跑且知道    | 回 `answer`（带 `replyTo` + `evidence`）⇒ `isReplyToOpenQueryOf` 命中 ⇒ **push** 进 A 的 context                                                                                                         |
| ② 对方在跑但不知道  | 回 `nack` ⇒ 同样 push（D-7）⇒ A 立刻转自查，不等超时                                                                                                                                                     |
| ③ 对方已终态        | **后台 auto-revive**（D-9；W2 仅在 direct + `kind==="query"` 时触发，§3.7）：`spawn({resumeFrom, slotless:true, deadlineAt, parentRunId:A})` fire-and-forget；专家复活后发 `answer` 回来；A 早已在做别的 |
| ④ 没人回 / A 已结束 | 不发死信：答案按 `topic` **转存看板**（D-8）。A 用不上，但下一个碰到同问题的 agent 直接读到                                                                                                              |

**auto-revive 的三条约束**（源自 §1 核实）：

- 走 `slotless: true`，不进 `concurrencyLimit: 6` 槽池；
- `deadlineAt` 由发起方剩余 deadline 夹紧（CC4 只收紧不放松）；
- `resumeLocks` 对同目标串行 ⇒ 同一专家的并发 revive 请求合并为一次（按 `(target, digest)` 去重），
  且必须走 **不 repoint label** 的路径，否则 `@expert` 会被问答 run 抢走
  （`spawn-service.ts:376-388` 的 `repoint` 分支需新增第三态 `"keep"`）；
- `autoReviveMaxPerSession` 兜住成本。

### 8.1 prompt 纪律（与机制同等重要）

机制只提供通道，**不产生行为**。必须在注入文案里写死三条：

1. **开工先问**：动手调研前，先 `read_board` + 广播「我要查 X，谁知道」——迟到的答案救不了已经
   干完的活；
2. **问完继续**：提问不等待，立刻继续当前工作或先做粗筛；
3. **答案到了就转向**：若 push 进来的 `answer` 覆盖了你正在做的事，**立刻停止并采用**（附
   `evidence` 抽查指引）。

缺了第 3 条，模型会无视 push 进来的答案继续傻干——这是同类机制最常见的失效模式。

---

## 9. 删除 `can_message` 的完整清理清单（D-2）

| 位置                                             | 动作                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/core/types.ts:133`                          | 删 `canMessage` 字段                                                                                         |
| `src/core/message.ts`                            | 删 `CanMessage`、`effectiveCanMessage()`、`MentionRoute`、`authorize` 的 `canMessage`/`mention` 分支         |
| `src/config/agent-types.ts:102-110`              | 删解析；**保留一次性 WARN**：检测到 frontmatter `can_message:` 时提示"v2 已移除，发送不再受限，该声明被忽略" |
| `src/fabric/router.ts`                           | 删 `AdmissionInput.canMessage` / `route` / mention 前置校验                                                  |
| `src/fabric/mention.ts:53`                       | 删 `canMessage?.includes("mention")` 与 `target.parent !== "root"` 校验                                      |
| `src/tools/message-agent-tool.ts:17-24`          | 删 `canMessage` dep 与 schema 描述里的 "requires can_message: mention"                                       |
| `src/service/runtime-adapter.ts:378-405`         | 删两处 `spec.type.canMessage` 透传                                                                           |
| `docs/dev/fabric-mention/fabric-mention-plan.md` | 加"v2 已废弃"横幅，保留历史                                                                                  |
| 测试                                             | 删授权矩阵中的 `can_message` 用例；新增"任意关系放行"与"方向性规则仍生效"两组                                |

不可逆性提示：删除后若将来需要限制某个 agent type 的发言（如运行不可信输入的 agent），需重新设计
机制。需求方已确认接受。

---

## 10. 不变量证明结构

| 不变量                                  | v2 论证                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **零挂起**（项目第一不变量）            | 全链路无等待点：`message_agent` 同步返回；auto-revive fire-and-forget；`boundedSend` 仍与 `steerMs` 赛跑。**阻塞式 consult 的 slot 死锁 / resumeLocks 互等 / A↔B 环等待在 v2 中不可能出现**                                     |
| **至少一次投递，或以带审计的方式终结**  | push 保留 v1 的 claim/attempts/backoff/死信链路；新增 `board_fallback` 作为**优先于死信**的终结方式（信息不丢，反而更可用）；notify/pull 落看板即 delivered                                                                     |
| **一条原始消息至多一条死信**            | `dlRefs`/`dlPlaceholders` 原子序不变；`board_fallback` 在死信签发**之前**判定，二者互斥                                                                                                                                         |
| **接收方 context 速率与总量有真实上界** | 比 v1 **更强**：v1 只有 root 有 ingress cap，v2 每个接收方都有 `inboxCap` + per-link 间隔；广播恒 O(1) 不产生 push；超限降级而非排队堆积                                                                                        |
| **唤醒只由点对点产生（I-W）**           | `resolveDiscipline()` 对非 direct 恒返回 `"pull"`（封 W1）；revive 触发点显式要求 `audience.kind==="direct" && kind==="query"`（封 W2）；roster 扇出先按 `targetState==="running"` 过滤且不产生 W2。三处均有属性测试（T15/T16） |
| **消息放大有界**                        | digest 去重 + `maxHops` + 扇出天花板（D-10）。非阻塞下环不死锁，只放大，这三者把放大掐死                                                                                                                                        |
| **不可信输入边界**                      | `formatMessage()` 的 `不可信输入: from -> to` 头覆盖全部新 kind；`answer` 强制 `evidence` 且注入文案要求抽查                                                                                                                    |

---

## 11. 测试锚点

| #   | 锚点                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `authorize()`：任意 relation 下 query/answer/nack/announce/progress/finding 全放行；result/directive/dead_letter 方向性仍生效                                          |
| T2  | `resolveDiscipline()` 真值表（含 D-1a 的 `urgent` 与摄取预算降级）                                                                                                     |
| T3  | 广播扇出：`audience.kind !== "direct"` ⇒ 恒 1 条记录、0 次 push（属性测试：任意 roster 规模）                                                                          |
| T4  | 摄取预算：`inboxCap` 饱和后新 push 一律降级 notify，且**永不返回失败**（R3 回归锚）                                                                                    |
| T5  | digest 去重 + `maxHops`：构造 A→B→A 回声环，断言消息数有界且无死锁                                                                                                     |
| T6  | 问答闭环四结局（§8 ①②③④），每个断言"发送方工具调用耗时 < 50ms"（R2 回归锚）                                                                                            |
| T7  | `board_fallback`：目标 gone 且有 topic ⇒ 落看板且**不产生死信**；无 topic ⇒ 仍走 v1 死信                                                                               |
| T8  | 看板 `session_start` 重建（prefetched `subagent:board` 条目）+ /reload 回归                                                                                            |
| T9  | auto-revive：`slotless`、`deadlineAt` 夹紧、同目标并发合并、**label 不 repoint**                                                                                       |
| T10 | 状态机转移矩阵 + seeded 属性测试 lockstep（§4.4）                                                                                                                      |
| T11 | `can_message` 清理：旧 frontmatter 只 WARN 不报错；跨树/任意深度直达打通                                                                                               |
| T12 | 相关性判定（§6.5）：`openQueries` 的进出与 TTL；兴趣域 glob 交集；隐式兴趣域从 `argsPreview` 提取（含截断/ring 淘汰的退化路径）；`read_board` 默认过滤 vs `{all:true}` |
| T13 | 失效预警破格 push：`mutation && files ∩ 我的域 ≠ ∅` ⇒ push（即使 D-1 默认 notify），且仍受 `inboxCap` 降级                                                             |
| T15 | **I-W 属性测试**：任意 roster 规模 × 任意 kind × 任意 `mutation` 标记下，广播产生的 push 次数 = 0 且 revive 次数 = 0                                                   |
| T16 | W2 触发面：direct + `query` ⇒ revive；direct + `progress`/`finding` ⇒ 只落看板不 revive；roster 命中终态 run ⇒ 不 revive                                               |
| T17 | `wakeRoot: false` ⇒ root 的一切入站降级为 `sendRootDisplay` + 看板，零 turn 触发                                                                                       |
| T14 | 公平份额：单 sender 超 `boardSenderSharePct` 时淘汰其**自己**最旧条目，不影响他人、不返回失败（R3 回归锚）                                                             |

---

## 12. 实施顺序与 MVP 切割

| 阶段   | 内容                                                                         | 可独立交付                                      |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| **M1** | `can_message` 删除 + `authorize()` 重写 + 任意寻址打通（跨树/任意深度/同级） | ✅                                              |
| **M2** | `resolveDiscipline()` + per-receiver `inboxCap` + 降级语义（替换发送侧配额） | ✅                                              |
| **M3** | `board.ts` + `read_board` + `session_start` 重建 + `before_agent_start` 注入 | ✅（此阶段已能消掉"重复定位/重复试错"两类浪费） |
| **M4** | `query`/`answer`/`nack` + `replyTo` 闭环 + 主会话注册 `message_agent`        | ✅                                              |
| **M5** | `announce` 广播 + roster selector + 幅度四闸完整化                           | ✅                                              |
| **M6** | auto-revive（D-9）+ `board_fallback`（D-8）                                  | ✅                                              |

M3 是**性价比最高的单点**：不依赖 M4/M5，就能把"下一个 agent 重复调研"的主因（缺少可寻址的
定位索引与负面知识）解掉大半。建议 M1→M2→M3 先合一轮，跑真实任务量化收益，再决定 M4–M6。

---

## 13. 风险与待确认闸门

### G1（⚠️ 需签字）D-1a：directed `query` 的默认纪律

需求方已选"回答 push，其他直达 notify"。但 directed `query` 属于"其他直达" ⇒ notify。结合
§3.6 的能力边界（pi 无"不触发 turn 就注入运行中会话"的原语），后果是：

- 对**运行中**目标：query 躺在看板上，对方可能永不读到 ⇒ **问答闭环实际不成立**；
- 对 **root**：notify = `appendEntry`（display-only，不进模型 context）⇒ **主 agent 永远看不到问题**，
  而"向主 agent 请教"是原始需求。

本方案的处置：默认仍 notify（遵从决策），但提供 `urgent: true` 让发送方显式请求 push（R3 精神：
不限制发送能力），并仍受接收侧预算降级。**三个选项供签字**：

1. **（本方案默认）** query 默认 notify + `urgent` 可选 push；
2. directed `query` 一律 push（问答闭环最可靠，代价是每个问题打断对方一轮）；
3. 严格 notify、不提供 `urgent`（则须接受"绝大多数提问不会被回答"，收益全部来自看板累积）。

> **v1.2 连带推论（D-14 / I-W 引入后）**：广播恒不唤醒 ⇒ **想引起任何人注意，唯一途径是点对点
> 消息**。若 G1 选 3（严格 notify 且无 `urgent`），则运行中的 agent 永远无法被唤醒，问答闭环
> 彻底失效，M4 失去意义。**因此 I-W 事实上排除了选项 3**，签字请在 1 / 2 之间选。

### 其他风险

| 风险                                                                     | 处置                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 广播话痨（不限制发送 ⇒ 模型滥发）                                        | 非权限手段：工具描述里写明成本；`announce` 强制 `topic` + 禁止空话；看板容量截断。真实防线是 prompt 纪律不是配额                                                                                  |
| 迟到答案做了无用功                                                       | prompt 纪律「开工先问」（§8.1）；auto-revive 成本由 `autoReviveMaxPerSession` 兜底                                                                                                                |
| 删除 `can_message` 不可逆                                                | 已由需求方确认；旧 frontmatter 保留 WARN 兼容                                                                                                                                                     |
| 看板不跨会话（D-3）⇒ 跨会话仍重复调研                                    | 已知取舍。需要时用现有 `memory` 子系统手动沉淀；跨会话看板留 v2                                                                                                                                   |
| topic 命名漂移导致看板烂掉                                               | `scope.files` 为主检索键、topic 为辅（D-13 / §6.5 L1）；调度方派单时下发 topic 词表                                                                                                               |
| 隐式兴趣域误判（截断 / ring 淘汰）                                       | 仅作兜底且权重低于显式声明；`relevanceImplicitInterest` 可关                                                                                                                                      |
| **R-W**：失效预警不唤醒 ⇒ 接收方可能在看到置顶预警前已基于失效前提干完活 | 已知残余风险（§6.5 L3）。缓解：① 调度方用**点对点 directive** 主动唤醒（合规 W1）；② 修改方对已知受影响 agent 追发点对点消息；③ 看板置顶 + 启动注入。**不接受"广播破格唤醒"作为缓解**（违反 I-W） |
| 状态机 lockstep 漏改                                                     | §4.4 清单 + T10 属性测试；PR 模板加勾选项                                                                                                                                                         |
| notify 对运行中子 agent 近乎无效                                         | 已如实记录（§3.6）。这是 pi 当前能力边界，不是本方案缺陷；若将来 pi 提供"静默注入"原语，notify 可无损升级                                                                                         |

---

## 14. 修订记录

- v1（本稿）：基于需求方三条硬需求（R1–R3）与三条决策（D-1/D-2/D-3）首次成文；由阻塞式
  `consult_agent` 方案整体改写为非阻塞织网。前序讨论中的"知识交接包（L1）"已被 §6 的看板吸收。
- v1.1：补 §6.5 相关性判定（D-13）——回答"agent 如何确认一条消息是否和自己相关"；信封增
  `scope`/`mutation`；新增公平份额闸、失效预警破格 push、隐式兴趣域（复用已有
  `toolHistory.argsPreview`，零新增埋点）；测试锚点 +T12/T13/T14。
- v1.2：新增需求方硬约束「**广播不能唤醒 agent，只有点对点可以唤醒**」⇒ D-14 + 不变量 I-W
  （§3.7 唤醒模型：W1 turn 唤醒 / W2 复活唤醒）。**撤销 v1.1 的"失效预警破格 push"**（§6.5 L3
  改为看板置顶的被动预警，残余风险记为 §13 R-W）。W2 触发面收紧为 `direct + kind==="query"`；
  roster 扇出先按 `targetState==="running"` 过滤且不产生 W2。设置项 `relevanceMutationPush`
  → `relevanceMutationPriority`，新增 `reviveOnDirectQuery` / `wakeRoot`。测试锚点 +T15/T16/T17。
  §13 G1 追加连带推论：I-W 已排除 G1 选项 3。
- v1.3：自查更正 §4.1/§4.2——`src/stack.ts:246` 实际转移表不含 `pending → delivered`，
  notify/pull 路径须给 `allowed.pending` 追加 `"delivered"`（单条增量，仍不新增状态）；
  §4.4 lockstep 清单同步补该行。原稿"`allowed` 表结构不变"的说法作废。

---

# 15. 评审处置与事实更正（2 轮评审合并，v1.3 → 搁置）

## 15.1 推翻性更正：push 给运行中的子 agent **不产生额外一轮**

原稿 §3.6 的成本模型「push = 打断对方一轮」**是错的**（实测复核）：

- pi 的 steer 语义是 "Delivered after the current assistant turn finishes executing its tool
  calls, before the next LLM call"（`@earendil-works/pi-coding-agent/dist/core/agent-session.js`，
  `steer()` 的 JSDoc）；
- agent-loop 的内层循环是 `while (hasMoreToolCalls || pendingMessages.length > 0)`
  （`@earendil-works/pi-agent-core/dist/agent-loop.js:90`），steer 内容进 `pendingMessages`
  （同文件 :111 在循环内取），**并入同一外层 turn 的下一次 LLM 调用**。

⇒ 对**运行中的子 agent**，push 的真实成本只有 context token，没有额外轮次。
「打断一轮」只在**空闲 root**（真起一轮，且该轮可直接调写工具）与**终态目标**（revive = 全新 run）上成立。

**连锁后果**：

| 原设计                              | 更正后                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1「回答 push / 其他 notify」      | **作废**，由 **D-1′** 取代：discipline 按**接收方状态**划分——运行中子 agent → push（受 `inboxCap` 约束 token 量）；root → push 但受 `wakeRoot` 开关 + 配额（前台忙时降 display）；终态 → 落看板或 revive |
| 三级 discipline（push/notify/pull） | **塌缩为两级**（push / board）；对运行中 agent，notify 与 pull 无区别                                                                                                                                    |
| `urgent` 字段（D-1a）               | **取消**（其存在理由随成本模型一起消失）                                                                                                                                                                 |
| §13 闸门 **G1**                     | **关闭**（前提不成立，无需签字）                                                                                                                                                                         |

需求方已确认 D-1′ 与 G1 关闭。

## 15.2 Blocker（全部经独立复核属实）

| ID     | 问题                                                                                                                                                                                                                                                                                                        | 证据                                                                                                                                                                                                                                            | 处置                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | 看板的 `before_agent_start` 启动注入**在子会话里根本不触发**，M3 核心交付为空                                                                                                                                                                                                                               | `src/index.ts` 的 `if (g[HOST_KEY]) return;` 在 `before_agent_start` 注册**之前**，且源码注释写明 "Child sessions never see this hook"。memory 能在子会话生效是因为 `wireMemory` 在 pre-guard 区注册且只用自身闭包状态；看板状态在宿主 stack 里 | 注入改为**宿主侧 spawn 时拼进 prompt**（`runtime-adapter.ts` 的 `buildPrompt`）或 `SessionSpec` 的 system prompt 追加项；resume 的 run 同理 |
| **B2** | auto-revive 两种写法都坏：带 `parentRunId` 触发 `canSpawn` 嵌套校验 → config error 被 fire-and-forget 静默吞掉；不带则复活 run 不受 CC2 过滤（`runtime-adapter.ts` 的 `if (childRunIds.has(...)) return;`），结束时以 `triggerTurn:true` 唤醒 root ⇒ **一条绕过 I-W 的唤醒路径**，`wakeRoot:false` 也管不到 | 同左                                                                                                                                                                                                                                            | revive 需专属 owner 锚点（不被追踪）+ 显式跳过 canSpawn + 抑制 notifier 入队；答案只经 fabric 回流。作为 revive 特性的前置设计              |
| **B3** | M1 中间态违反 I-W：删掉 mention 两道闸后 `progress`/`finding` 也会触发 resume，而「W2 只由 query 触发」与 revive 上限要到 M6 才上                                                                                                                                                                           | `src/fabric/mention.ts` 的 resume 分支                                                                                                                                                                                                          | M1 不动 mention 的 resume 分支，只放开对**运行中**目标的寻址；或把 W2 收紧 + revive 上限前移并与 M2 合并交付                                |

## 15.3 Major（摘要，含各自处置方向）

| 来源                       | 问题                                                                                                                                                                                                                                                                                                                                                                                                          | 处置                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事实核查 M-1               | §4.4 lockstep 指错文件：`src/core/state-machine.ts` 是 **run 状态机**（与 FabricRecord 无关），`tests/core/state-machine.test.ts` **不存在**。真正的转移表在 `src/stack.ts` 的 `allowed` 字面量 + `src/delivery/engine.ts`，且被 **7 处测试 fixture 逐字复制**（`tests/core/message-property.test.ts` ×2、`tests/fabric/router.test.ts` ×3、`tests/fabric/mailbox.test.ts`、`tests/delivery/engine.test.ts`） | 改动面从 1 处放大到 8 处；§4.4 重写                                                                                                                              |
| 结构批判 M3                | notify/pull 走 `pending → delivered` 会产生**永不终结的 pending 僵尸**（board 写失败或 /reload hydrate 后，TTL 判断在 pump 候选循环内，而候选已被 `discipline==="push"` 过滤掉）                                                                                                                                                                                                                              | 改为**先写 board 成功后直接 `engine.put({...state:"delivered"})`**（`put` 不查转移表）⇒ §4.1 那条 `pending→delivered` 转移表增量与 8 处 fixture 改动**全部可省** |
| 事实核查 M-3               | `resolveDiscipline()` 顺序 bug：`audience` 可选，规则① 把所有不带 audience 的存量消息（系统死信、/reload 后 v1 残留 pending）判成 pull ⇒ 死信永不泵送、残留记录连 TTL 分支都进不去                                                                                                                                                                                                                            | 规则① 改为 `audience !== undefined && audience.kind !== "direct"`；系统死信显式盖 `discipline:"push"`；补 /reload 迁移规则                                       |
| 结构批判 M1                | 见 §15.1                                                                                                                                                                                                                                                                                                                                                                                                      | D-1′                                                                                                                                                             |
| 结构批判 M2                | **root 在前台 `Agent` 调用期间收不到提问**：`sendRootContext` 走 `deliverAs:"steer"`，而 root 正阻塞在 Agent 工具调用里（`foregroundAutoBackgroundMs: 600_000`）⇒「向主 agent 请教」在最常见的前台调度下不成立                                                                                                                                                                                                | 明确「请教 root 只在 `run_in_background` 调度下有效」，或在前台 Agent 等待循环里把指向 root 的 query 暴露为 tool update                                          |
| 结构批判 M4                | `board_fallback` 优先于死信，使 **directive/finding 的发送方失去失败信号**（父 agent 会看到 `delivered` 而以为送达）                                                                                                                                                                                                                                                                                          | board_fallback **只用于 `answer`/`nack`**；directive/finding 仍签死信，死信内附 board 引用                                                                       |
| 结构批判 M6                | `inboxCap` 优先级反转：result/directive/dead_letter 在预算检查**之前**返回 push 却仍占用 `inboxUsed`，可把接收方自己问来的 answer 挤成 notify。且 §10「总量比 v1 更强」不成立——v1 的发送方总量配额被降级后只剩速率约束                                                                                                                                                                                        | answer/nack 设保留配额或协议类 kind 不计入 `inboxUsed`；§10 如实改为**速率上界**                                                                                 |
| 结构批判 M8                | `resumeLocks` 实际行为是**拒绝**不是「合并」（`spawn-service.ts` 返回 "already has a resume in progress"），fire-and-forget 会吞掉，第二个提问者的 query 静默消失                                                                                                                                                                                                                                             | router 维护 `reviving: target → newRunId`，revive 期间到达的同目标 query 在新 run running 后 steer 进去                                                          |
| 事实核查 M-2/M-5           | 遗漏调用点：`effectiveChannel` 在 `src/fabric/throttle.ts` 有 3 处、`mailbox.ts` 1 处；删 `can_message` 漏 `agent-types.ts` 的 `configHashInput` 与赋值处、`message-agent-tool.ts` 的 admit 透传                                                                                                                                                                                                              | §5/§9 补全                                                                                                                                                       |
| 事实核查 M-6               | `mailbox.pump()` 的 **ttl / pre-claim target_gone 两个分支**同样硬编码 `kind === "finding" \|\| "directive"`，新 kind 会被静默丢弃，D-8 在这两条路径无触发点                                                                                                                                                                                                                                                  | §5 扩为三处统一走 board_fallback 判定                                                                                                                            |
| 事实核查 M-7               | `openQueries` 的 /reload 重建完全未规定 ⇒ 迟到 answer 无法命中，push 升级静默退化                                                                                                                                                                                                                                                                                                                             | 从 engine 内 `kind==="query"` 未超 TTL 的记录 hydrate                                                                                                            |
| 事实核查 M-4 / 结构批判 M7 | **T13 与 §3.3 `mutation` 注释是 v1.1 残留**，与 D-14/I-W 及 T15 直接矛盾（两组测试不可能同时通过）                                                                                                                                                                                                                                                                                                            | 删 T13 与该注释；`mutation` 字段一并砍掉                                                                                                                         |

## 15.4 不变量攻击结果（§10 七条，攻破四条）

| 不变量                   | 结论                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 零挂起                   | **守住**（有条件）：revive 必须真正脱离当前调用且 reject 被捕获。但**回复延迟无上界**（前台 root 最长 600s）                                                                                                                                                                                                                                                                          |
| 至少一次投递或带审计终结 | **有洞**：pending 僵尸、directive 被转看板致发送方误判、board 容量淘汰删掉从未被读的 delivered 条目、resumeLocks 拒绝被吞                                                                                                                                                                                                                                                             |
| 至多一条死信             | **守住**，前提是 board_fallback 必须在 `issueDeadLetters` 按 sender 分批**之前**逐条判定                                                                                                                                                                                                                                                                                              |
| 接收方 context 有界      | **有洞**：优先级反转；且只剩速率上界，非总量上界                                                                                                                                                                                                                                                                                                                                      |
| **I-W（广播不唤醒）**    | **有洞**：① B2 的 revive 完成通知带 `triggerTurn:true` 唤醒第三方；② `tree.targetState("board")` 返回 `gone`，滞留的 board 记录会触发向广播者 push 死信（广播者若是 root 即间接自唤醒）；③ B3 中间态；④ T13 自身要求违反。**§3.7 的三个落点不完整，应改为在唯一出口处断言**（所有 `sendRootContext` / `runner.steer` / `spawn({resumeFrom})` 调用点检查来源是否 direct 且 kind 合规） |
| 消息放大有界             | **有洞**：`hop`/`maxHops` 是**死代码**（方案内无转发路径）；digest 只拦逐字重复；revive 链（A→B→C→A）每步都是带完整 context 的 run，只受会话级 10 次上限                                                                                                                                                                                                                              |
| 不可信输入边界           | **有洞**：删 `can_message` 后任意深度、正在处理 web 内容的 agent 都能唤醒拥有全部工具的 root（暴露面远大于 v1 的「仅 root 直属子 run」）；看板经启动注入进入**之后每一个** agent 的 prompt，构成**持久化 prompt 注入**（类存储型 XSS），围栏标签只能降险不能消除                                                                                                                      |

## 15.5 裁剪清单（砍掉后 R1–R3 仍全部满足）

`roster` selector（I-W 下与 topic 效果相同）、`urgent`（§15.1）、`hop`/`maxHops`（死代码）、
§6.5 L2 三来源与隐式兴趣域（新 agent 无工具历史 ⇒ 恒空；显式来源无落点）、`mutation` 与 L3、
`scope.symbols`、`boardSenderSharePct`（会淘汰尚未回答的 query）、`answered` supersede（死代码）。

**剩余最小集**：3 个新 kind（query/answer/nack）+ `to:"board"` + `replyTo`/`topic`/`evidence?`
三个字段 + 两级 discipline + 看板 + `read_board`。设计面砍掉一半以上。

## 15.6 对原始痛点的收益再评估（评审核心结论，需求方已认可）

> **看板只收录 agent 主动 `announce` 的内容，面对的是与 result 同一个压缩瓶颈**——A 愿意写进
> 看板的东西，通常也会写进 result。增量只有两类：A 运行中发过但最终 result 漏掉的，以及负面知识。
> 而这两类都依赖 §8.1 的 prompt 纪律才会产生。原稿 §12「M3 能消掉大半重复调研」**没有依据**。

且 §8.1 第 1 条「开工先广播：谁知道」在 I-W 下**基本无效**（广播不唤醒任何人）。

**真正能绕过压缩瓶颈的只有「向终态专家定向提问 + revive」**（它带完整原始会话回答），而这恰恰
排在最后（M6）且目前有 B2/M8 两个 Blocker 级缺陷。其成本是一次带完整 context 的 run，缓存过期后
**可能高于提问方自己重新调研**——原稿没有算这笔账。

⇒ 结论：**先量化，再投工程**。见 [`baseline-experiment.md`](./baseline-experiment.md)。

## 15.7 实施环境警告：仓库存在并行改动

评审期间发现工作区有 **22 个文件、+620 行未提交改动**（quota 特性，`docs/dev/quota/quota-plan.md`），
涉及 `src/stack.ts`(+79) / `src/config/settings.ts`(+126) / `src/service/spawn-service.ts` /
`src/index.ts` / `tests/integration/fabric-wiring.test.ts`——**与 fabric v2 的改动面高度重叠**。

两个后果：

1. **§1 核实表的行号锚点本质上是脆的**（本轮已观察到 `stack.ts` 内目标行下移 30–55 行，两份评审
   的行号证据因此互相矛盾，实为文件在其间被修改）。复活本方案时，§1 必须改为**符号锚点**
   （函数/常量/类型名），行号仅作「截至某 git rev」的提示。
2. 按 dev-flow 冻结面纪律，fabric v2 **不得与 quota 工作并行开发**；须等 quota 落地后 rebase，
   或将上述共享文件列为冻结面由单一方改。
