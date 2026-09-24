## e1-r1 — Q

我是 fabric v2 消息投递层实施方案的制定者，已读完 /tmp/exp5-repo 下 fabric v1 全部代码（src/fabric/{router,mailbox,tree,throttle,mention}.ts、src/core/message.ts、src/stack.ts buildFabric、src/tools/message-agent-tool.ts）与 docs/dev/subagent-push、docs/dev/fabric-mention 两份设计文档。请把前序讨论中与用户拍板的设计决策完整转述给我，尽量给出决策内容与理由。我关心以下问题（可一次全部回答）：

1. R1「任意两个 agent 点对点通信 + 一对多广播」：v2 的发送权限模型怎么定的？还是基于 can_message frontmatter 的关系门控吗？有没有放开到"任意两个 agent"？点对点还需要树关系/mention 吗？广播（broadcast）的目标集合语义是什么（兄弟？全树？订阅制？），谁可以广播？
2. 消息类型（kind）列表在 v2 定成什么？保留 progress/finding/directive/result/dead_letter 吗？广播/看板消息是新 kind 还是复用？
3. 投递方式：push（steer 注入）/ notify（等下次轮次）/ pull（接收方主动拉取）分别由什么决定？是按消息 kind、接收方状态、还是收件箱水位决定？
4. 唤醒规则：什么消息能让一个 idle/正在运行的 agent 起一轮新的模型调用？已结束（terminal）的 agent 能否被消息"复活"（resume）？复活的边界条件（label？runId？成本上限？）？
5. 看板（共享公告板/bulletin）的存储方式与有效范围定成什么？存 session entry？内存？作用域是全树还是全 session？
6. 配额与收件箱满时的处理：v2 的配额维度、收件箱 cap、溢出处理（拒绝/挤压/降级为 pull？）怎么定的？
7. 发送永不阻塞（R2）在 v2 有没有新的语义（比如广播部分失败怎么算）？
8. 有没有拍板的兼容性决策（v1 记录/envelope 是否迁移、settings 键、默认开关、MVP 切割、命名）？
9. 有没有讨论中明确「不做」的事（非目标）？
10. 其他你认为下游实施方案必须遵守的硬约束或用户偏好（例如文档语言、评审关注点、与 delivery engine 复用等）。

请直接、详细地回答，引用讨论中的原话或结论最好。

## e1-r1 — A

收到。以下转述全部以 plan.md 的**最终结论**为准：文首状态块 + §15 评审处置优先于 §0–§14 正文（正文多处被 §15 推翻）。先给你最重要的一条总决策，再按 10 问逐条展开。

## 总状态（需求方的最高拍板）

plan.md 文首原文：「**⛔ 状态：已打回，搁置中（2 轮评审后）**……本文档 §0–§14 是 v1.3 原稿，**不得据此实施**……下一步不是修文重写，而是先跑 `baseline-experiment.md` 量化收益，再决定工程投入规模。**需求方已拍板走这条路线**。」§15.6 结论原文：「**先量化，再投工程**」。所以你的投递层实施稿有一条元约束：**每一条设计都要过一遍 §15 的处置表**，正文与 §15 冲突处以 §15 为准（D-1、urgent、T13/mutation、roster、hop 等均已作废）。

## 1. 发送权限模型与广播

- **发送权限整体废除，不再是 can_message 门控**。拍板决策 D-2：「`can_message` 彻底删除」。推导（§0.3）：「约束不能放在『谁能给谁发』（发送权限），必须放在『什么进得了我的 context』（接收侧摄取预算）」——因为 R1+R3（无限制广播+推送投递）= context 投毒 + turn 放大，唯一相容解是把闸移到接收侧。R3 字面满足靠 D-6：「超限不拒收，只降响度」，全链路不存在 `message not authorized`。
- `authorize()` 只保留**方向性协议自洽规则**（§3.4，「不是权限，是协议自洽」）：dead_letter 只能 from system；result 只能上行（child）；directive 只能下行（parent）；「progress / finding / query / answer / nack / announce：任意关系全开（R3）」——跨树、任意深度、同级、self/unrelated 全通。**点对点不需要树关系，也不需要 mention**。
- 树与 mention 降级为溯源标注（D-11）：tree.ts 保留，`via.lca/hops`、relation 仅供 `formatMessage` 展示、供接收方判断可信度；`isRootChild` 不再 gating；mention 退化为「用 `@label` 做寻址」的语法糖，`MentionRoute` 删除，`via.mode` 仅作溯源展示。
- **广播语义**：不是枚举兄弟/全树，也不做订阅制——audience 为 `{kind:"topic", topic}` 或 `{kind:"roster", selector}`（running/type/subtree），落点是**一条** `to:"board"` 记录。D-5：「广播 = 1 条看板记录，恒 O(1)，绝不 N 路 push——唯一能让 R1 的广播不炸成本的结构」。任何人可广播（无权限）；D-12：announce 强制带 topic（或 scope.files，后者已被裁）。**§15.5 之后 roster selector 被砍**（「I-W 下与 topic 效果相同」）。注意一处含糊：§15.5 最小集只列「3 个新 kind（query/answer/nack）」，没有点名 announce——announce 作为独立 kind 是否保留需要你在实施稿里定（我的读法：广播退化为「带 topic 写 `to:"board"`」）。
- 兼容：删除不可逆，需求方已确认；旧 frontmatter 只保留一次性 WARN（「v2 已移除，发送不再受限，该声明被忽略」）。§15.3 M-2/M-5 补的清理点：`effectiveChannel` 在 throttle.ts 有 3 处、mailbox.ts 1 处调用；删 can_message 别漏 `agent-types.ts` 的 `configHashInput` 与赋值处、`message-agent-tool.ts` 的 admit 透传。
- 已知未处置的洞（§15.4 如实记录）：删闸后「任意深度、正在处理 web 内容的 agent 都能唤醒拥有全部工具的 root」，暴露面远大于 v1 的「仅 root 直属子 run」。

## 2. kind 列表

- 正文 §3.2：v1 五个 kind **全保留**（progress/finding/directive/result/dead_letter），新增 query/answer/nack/announce。nack 是一等公民（D-7，理由：R2 直接后果，「让发送方尽早转自查，比等超时快一个数量级」）。
- **§15.5 最小集：新 kind 只剩 query/answer/nack**。dead_letter 保留。FabricRecord **不新增状态**（D-4）；新增 terminalReason：`board`、`board_fallback`、`duplicate`（`hop_exhausted`/`answered` 随裁剪作废）。
- envelope 新字段正文列了 8 个，最小集收敛为 **`replyTo` / `topic` / `evidence?`** 三个（D-12：answer 强制 evidence，「答案是『另一个 LLM 的记忆』，可能幻觉或过期；强制证据让接收方 O(1) 抽查而非 O(n) 重查」）。作废：audience.roster、urgent（§15.1 取消）、hop/maxHops（§15.4 判死代码）、mutation（与 I-W/T15 直接矛盾，M-4/M7：「删 T13 与该注释；mutation 字段一并砍掉」）、scope.symbols。digest 去重没被点名砍、也没进最小集，且 §15.4 已指出「digest 只拦逐字重复」——去留需你拍板。

## 3. 投递纪律由什么决定

这是被 §15.1 **推翻重写**最狠的一块。正文原设计：三级 push/notify/pull，由 kind + 「是否对我发出的 query 的回答」（`isReplyToOpenQueryOf`，router 为每个 run 维护 `openQueries: Set<MessageKey>`）+ urgent + 接收方水位在 `resolveDiscipline()` 裁定，admit 时一次定死、永不变更（D-4）。

§15.1 实测推翻成本前提：「pi 的 steer 语义是 'Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call'……⇒ **对运行中的子 agent，push 的真实成本只有 context token，没有额外轮次**」。连锁后果（原文）：

- 「**D-1 作废，由 D-1′ 取代：discipline 按接收方状态划分**——运行中子 agent → push（受 `inboxCap` 约束 token 量）；root → push 但受 `wakeRoot` 开关 + 配额（前台忙时降 display）；终态 → 落看板或 revive」；
- 「三级 discipline **塌缩为两级（push / board）**；对运行中 agent，notify 与 pull 无区别」；
- 「`urgent` 字段取消（其存在理由随成本模型一起消失）」；「§13 闸门 G1 **关闭**（前提不成立，无需签字）」。**需求方已确认 D-1′ 与 G1 关闭。**

仍保留的裁定要素：协议类 kind（result/directive/dead_letter）恒 push（v1 语义）；接收方水位满 ⇒ push 降级 board（D-6 绝不拒收）；M6 修正优先级反转：「**answer/nack 设保留配额或协议类 kind 不计入 inboxUsed**」，且「§10 如实改为**速率上界**」（「总量比 v1 更强」的说法不成立）。

落地路径（M3）：board 纪律记录「**先写 board 成功后直接 `engine.put({...state:"delivered"})`（put 不查转移表）**」，不进 mailbox；`pump()` 候选筛选加 `r.discipline === "push"`。M-3 顺序 bug 修正：规则① 必须是 `audience !== undefined && audience.kind !== "direct"`，否则「系统死信、/reload 后 v1 残留 pending」全被判 pull——「死信永不泵送、残留记录连 TTL 分支都进不去」；系统死信显式盖 `discipline:"push"`。legacy 映射：`progressChannel`「'display' 映射为 root 的 notify 走 sendRootDisplay，'context' 映射为 root 的 notify 走 push」——保留解析、标记 legacy。诚实边界（§3.6，两级化后转给 board）：「board 纪律是 best-effort，可能永远不被看到——这正是 R2 承认的前提」。

## 4. 唤醒规则

- **I-W 不变量**（D-14，v1.2 加入的需求方硬约束原话：「广播不能唤醒 agent，只有点对点可以唤醒」）：「只有 `audience.kind === "direct"` 的消息可以产生 W1（turn 唤醒：`runner.steer`；对 root 为 `sendRootContext(deliverAs:"steer", triggerTurn:true)`）或 W2（复活唤醒：auto-revive）。任何广播恒不唤醒。」升级通道：「若一条广播确实重要到需要唤醒某人，发送方必须**显式对该接收方再发一条点对点消息**——唤醒因此永远是具名、可审计、计入接收方 inboxCap 的动作」。
- **W2 触发面**：「必须同时满足 `direct` 且 `kind === "query"`（或 result/directive 协议路径）。progress/finding/announce 发给终态目标一律落看板，绝不 revive——把一个已结束的 agent 拉起来只为听一条通报是纯烧钱」；roster 命中终态 run 先按 running 过滤且不 revive（roster 已砍，剩原则意义）。
- **复活边界**（D-9 + §8）：复用 mention 的 resume 分支 + `spawn({resumeFrom, slotless:true, deadlineAt, parentRunId})`，**fire-and-forget**（不等 spawn 结果即返回 `{status:"reviving"}`）；slotless 不进槽池；`deadlineAt` 由发起方剩余 deadline 夹紧（CC4 只收紧不放松）；`autoReviveMaxPerSession: 10` 兜成本；`reviveOnDirectQuery` / `autoRevive` 开关；寻址用 runId（@label 是语法糖）。
- **B2（Blocker，处置=「前置设计」，即尚无成文解法，需要你补）**：「auto-revive 两种写法都坏：带 `parentRunId` 触发 canSpawn 嵌套校验 → config error 被 fire-and-forget 静默吞掉；不带则复活 run 不受 CC2 过滤，结束时以 `triggerTurn:true` 唤醒 root ⇒ **一条绕过 I-W 的唤醒路径**，`wakeRoot:false` 也管不到」。处置：「revive 需专属 owner 锚点（不被追踪）+ 显式跳过 canSpawn + 抑制 notifier 入队；**答案只经 fabric 回流**」。
- **M8**：resumeLocks 实际行为是**拒绝**不是合并（`"already has a resume in progress"`），fire-and-forget 会吞掉、「第二个提问者的 query 静默消失」；处置：「router 维护 `reviving: target → newRunId`，revive 期间到达的同目标 query 在新 run running 后 steer 进去」。同 label 不得 repoint（否则 `@expert` 被问答 run 抢走），spawn-service 的 repoint 分支需新增第三态 `"keep"`。
- root 唤醒：direct → root 的 push 在用户空闲时也起主会话一轮，「这是『向主 agent 请教』的必要代价」，由 `rootInboxCap: 12` 约束；`wakeRoot: false` ⇒ root 一切入站降级 `sendRootDisplay` + 看板（T17）。**M2**：root 在前台 `Agent` 调用期间收不到提问（steer 投不进，`foregroundAutoBackgroundMs: 600_000`）——「『向主 agent 请教』在**最常见的前台调度下不成立**」；处置二选一：「明确『请教 root 只在 `run_in_background` 调度下有效』，或在前台 Agent 等待循环里把指向 root 的 query 暴露为 tool update」。
- **I-W 的执行方式**（§15.4 结论）：§3.7 的「三个落点不完整，应改为**在唯一出口处断言**——所有 `sendRootContext` / `runner.steer` / `spawn({resumeFrom})` 调用点检查来源是否 direct 且 kind 合规」。v1 的 `mention.ts` resume 分支今天就会对终态目标复活任意 kind——这是 B3 的 M1 中间态雷区，处置：「M1 不动 mention 的 resume 分支，只放开对运行中目标的寻址；**或**把 W2 收紧 + revive 上限前移并与 M2 合并交付」。

## 5. 看板存储与范围

- **D-3（拍板）：仅当前主 session**。「`appendEntry(customType: "subagent:board", entry)` + 读回校验，完全复用 `src/adapters/pi-outbox-store.ts` 的模式（append-only、无 ack、写后读回）。`session_start` 时从 prefetched 条目重建……**不跨会话：新主会话看板归零**。」作用域既非全树也非跨 session，而是**单主 session 内全树共享**（与 fabric 记录同构：无 readBack 时退化为内存 store——这是按 v1 装配的推断，方案未明写，你定）。
- 容量：全局 FIFO `boardCap: 500`、每 topic `boardTopicCap: 50`；「截断时优先保留 ①最新、②被 replyTo/ref 引用过的条目」。公平份额 `boardSenderSharePct` 被裁（「会淘汰尚未回答的 query」）。
- **B1（Blocker）**：「`before_agent_start` 启动注入**在子会话里根本不触发**，M3 核心交付为空」（HOST_KEY 守卫先 return）。处置：「注入改为**宿主侧 spawn 时拼进 prompt**（runtime-adapter.ts 的 `buildPrompt`）或 SessionSpec 的 system prompt 追加项；resume 的 run 同理」。注入内容为预算化的 topic 目录 + 一行摘要（`boardInjectBudgetChars: 2000`），复用 memory 的预算化渲染先例。
- 看板同时是 D-8 的归宿：「迟到/无法投递的 answer **转存看板**，不发死信——非阻塞把『迟到』从失败变为知识沉淀」。**M4 收窄**：「board_fallback **只用于 answer/nack**；directive/finding 仍签死信，死信内附 board 引用」（否则「发送方失去失败信号，父 agent 会看到 delivered 而以为送达」）。时序约束（§15.4）：「board_fallback 必须在 `issueDeadLetters` 按 sender 分批**之前**逐条判定」，保住「一条原始消息至多一条死信」。
- 收益的最终评估（§15.6，需求方已认可）：「看板只收录 agent 主动 announce 的内容，面对的是与 result **同一个压缩瓶颈**……增量只有两类……且这两类都依赖 §8.1 的 prompt 纪律才会产生」；「§8.1 第 1 条『开工先广播』在 I-W 下**基本无效**」。

## 6. 配额与收件箱

- **维度转换：发送侧 per-kind 配额 → 接收侧摄取预算**。`inboxOf(node)`（`rootInbox()` 泛化）统计「该接收方 `pending|claimed` 且 `discipline==="push"`」的条数；默认 `inboxCap: 8`，root 沿用 12。旧 per-kind 配额键「保留解析但降级为存储上限，不再作为发送权限」。
- **溢出处理：降级，绝不拒收**（D-6/D-10；T4 锚：「inboxCap 饱和后新 push 一律降级 notify，且**永不返回失败**——R3 回归锚」）。`rejected.reason` 新增 `"duplicate"`。
- 四道幅度闸（D-10，全是非权限闸）：摄取预算、digest 去重（`sha256(kind+topic+normalizedText)`，同 `(digest,to)` 窗口内 ⇒ dropped，`dedupeTtlMs: 600_000`）、~~hop 上限~~（死代码，砍）、存储/扇出天花板（boardCap/boardTopicCap）。速率：per-link `receiverMinIntervalMs: 30_000`（`minIntervalMs` 泛化，root 10s 独立更严），「超时只推迟不拒收」。M6 的优先级反转修正见第 3 问。

## 7. R2 非阻塞语义

- `message_agent` 同步返回（§8 文案原话：「已投递，不阻塞。若收到回答会作为消息进入你的上下文。**不要为此等待**——继续当前工作，或先做粗筛」）；T6 锚：四结局每个断言「发送方工具调用耗时 < 50ms」；auto-revive fire-and-forget；`boundedSend` 仍与 `steerMs`(5s) 赛跑。§10：「阻塞式 consult 的 slot 死锁 / resumeLocks 互等 / A↔B 环等待在 v2 中**不可能出现**」。§15.4 附加条件：「revive 必须真正脱离当前调用且 reject 被捕获。但**回复延迟无上界**（前台 root 最长 600s）」。
- **广播没有「部分失败」概念**：恒 1 条记录、0 次投递（T3：任意 roster 规模 ⇒ 1 条记录 0 push），无按接收者扇出。board 写失败本身怎么办方案没写死（M3 只定了成功路径），留给你定义——注意别造出被 `discipline==="push"` 过滤器挡在 TTL 之外的 pending 僵尸。

## 8. 兼容性拍板

- **v1 记录不迁移结构，但必须补 /reload 规则**（M-3/M-7）：v1 残留 pending 与系统死信无 `audience`/`discipline` 字段——规则①守卫 `undefined` + 系统死信显式盖 push；`openQueries`「从 engine 内 `kind==="query"` 未超 TTL 的记录 hydrate」，否则「迟到 answer 无法命中，push 升级静默退化」。看板/树同 fabric 记录一样走 session_start prefetched 重建。
- **settings**：`fabric.enabled` 唯一全局开关（默认 **false**）。§7.4 中被裁的键：`maxHops`、`boardSenderSharePct`、`relevanceImplicitInterest`、`relevanceMutationPriority`；存活：`inboxCap`/`rootInboxCap`、`receiverMinIntervalMs`/`rootMinIntervalMs`、`boardCap`/`boardTopicCap`、`boardInjectBudgetChars`、`wakeRoot`、`reviveOnDirectQuery`、`autoRevive`/`autoReviveMaxPerSession`（`dedupeTtlMs` 待你确认）；legacy 键（maxPerRun/findingQuota/directiveQuota/deadLetterQuota/maxChars/progressTtlMs/progressChannel）保留解析、降级。
- **MVP 切割**：正文 §12 为 M1（删 can_message+authorize 重写+任意寻址）→M2（discipline+inboxCap）→M3（board+read_board）→M4（query/answer/nack+主会话注册）→M5（广播+四闸）→M6（auto-revive+board_fallback）；B3 修正 M1 不得动 mention resume 分支（或 W2 收紧+上限前移并入 M2）；§15.6 又推翻了「M3 性价比最高」的判断（「没有依据」）。**总闸门：先跑 baseline-experiment**。
- **命名**：`NodeRef` 增 `"board"`、`validNode()` 同步；customType `"subagent:board"`；工具 `read_board`（`RESERVED_TOOL_NAMES` += read_board）；**主会话也注册 `message_agent`+`read_board`**（post-guard、fabric.enabled 门控，否则 root 无法回答）。遵守 AGENTS.md：pi-subagent 运行时标识不得改名。
- **lockstep 真相（M-1）**：§4.4 原文指错文件——`core/state-machine.ts` 是 run 状态机，`tests/core/state-machine.test.ts` 不存在；真正转移表在 `stack.ts` 的 `allowed` 字面量，被 **7 处测试 fixture 逐字复制**（共 8 处）；但走 M3 的「put 直写 delivered」路径后「那条 pending→delivered 增量与 8 处 fixture 改动**全部可省**」。M-6：mailbox 里硬编码 `kind==="finding"||"directive"` 的终结分支（方案说「扩为三处」；我在代码里数出 **4 处**：pump 的 ttl 与 pre-claim target_gone、verdict 的 attempts_exhausted 与 target_gone）必须统一走 board_fallback 判定，「否则新 kind 会被静默丢弃」。

## 9. 明确「不做」（非目标）

阻塞式 consult（一切等待点）；跨会话看板（「需要时用现有 memory 子系统手动沉淀」）；只读 consult 会话；恢复任何发送权限白名单（不可逆已确认）；**广播破格唤醒**（「不接受『广播破格唤醒』作为缓解（违反 I-W）」，R-W 残余风险接受）；转发/hop 机制（无转发路径，死代码）；语义相关性分类器（L4「不造分类器，模型是最终裁判」）；隐式兴趣域推断（L2 三来源全砍：「新 agent 无工具历史 ⇒ 恒空；显式来源无落点」）；`answered` supersede（死代码）；**在 baseline 实验出结论前投任何工程**。

## 10. 其他硬约束与偏好

- **评审方法**：两轮一路「事实核查」（行号/调用点/pi 源码实测——§15.1 就是读 pi 源码推翻成本模型的），一路「结构批判」（不变量攻击，§10 七条攻破四条）。你的实施稿会被同样对待：**成本断言要有 pi 源码或实测依据**；不变量表要如实写「守住/有洞」。
- **§15.7 环境纪律**：「fabric v2 **不得与 quota 工作并行开发**；须等 quota 落地后 rebase，或将共享文件（stack.ts/settings.ts/spawn-service.ts/index.ts/tests）列为冻结面由单一方改」；「§1 必须改为**符号锚点**（函数/常量/类型名），行号仅作『截至某 git rev』的提示」。（我今日核对：工作区已干净、quota 改动已不在未提交状态；但行号漂移属实——plan 写 stack.ts:246，现码在 247。）
- 项目不变量（AGENTS.md）：零挂起第一不变量；「一条原始消息至多一条死信」；`formatMessage` 的「不可信输入： from -> to」头必须覆盖全部新 kind；改投递生命周期须同步转移矩阵/属性测试（按上条 M-1 的真实位置）；/reload 重激活共享模块缓存——**不得有模块级可变状态**、计时器 unref、子会话保持 inert（HOST_KEY）。
- **§8.1 prompt 纪律是机制的一部分**（「与机制同等重要」），三条必须写死进注入文案：开工先问、问完继续、**答案到了就转向**（「缺了第 3 条，模型会无视 push 进来的答案继续傻干——这是同类机制最常见的失效模式」）；但注意 §15.6 已判定第 1 条在 I-W 下基本无效。
- 文档语言：设计文档中文（docs/dev/ 先例）；AGENTS.md 的 UI 文案分离规则适用——紧凑行内标记/徽标一律英文 token，面向用户或模型的劝诫性散文块可用中文。
- delivery engine 复用的隐式契约：M3 方案依赖「`engine.put` 不查 `allowed` 表」这一**实现事实而非接口承诺**——你的实施稿要么把它写成显式契约+测试，要么给 put 加显式 bypass 参数。
- 最后再压一遍总路线（§15.6）：「**真正能绕过压缩瓶颈的只有『向终态专家定向提问 + revive』（M6）**，而这恰恰排在最后且目前有 B2/M8 两个 Blocker 级缺陷。其成本是一次带完整 context 的 run，缓存过期后**可能高于提问方自己重新调研**」。若你的投递层要先动工，合理顺序是按 M6 的需求倒推最小正确面（revive 语义 + I-W 出口断言 + board_fallback + /reload 迁移），而不是按正文 §0–§14 的顺序铺开。[subagent label: "请教-fabric-v2-拍板决策" · run_id: r_NFXEZK2V · status: completed] — 用户可 @请教-fabric-v2-拍板决策 直接向它发消息

## e1-r2 — Q

你好，我接手了 fabric v2 消息投递层的实施方案制定。我已读过 v1 代码（src/fabric/ 的 router/mailbox/tree/throttle/mention、src/core/message.ts、src/tools/message-agent-tool.ts、stack.ts 的 buildFabric、docs/dev/subagent-push/subagent-push-plan.md）。

需求是 R1（任意 agent 点对点 + 一对多广播）和 R2（发送永不阻塞）。你参与过前序阶段与用户的设计讨论和评审，其中拍板了若干关键决策，但交接单没有逐条展开。请把这些拍板决策完整、具体地讲给我（我一次问了多个问题，请逐条回答，每条给出结论 + 关键理由 + 你记得的任何边界条件/数值约定）：

1. 消息模型：v2 的 kind 列表最终定了哪些？是在 v1 的 progress/finding/directive/result/dead_letter 之上新增还是重新划分？broadcast 是独立 kind 还是一个投递模式？envelope 字段有没有新增/修改（比如 topic、fanout 相关字段）？

2. 发送权限与路由规则：v1 是 agent 类型 frontmatter 的 can_message（默认 parent）+ 树关系授权。v2 说"任意两个 agent 可点对点"，最终权限模型是什么？can_message 如何扩展（新增了哪些可取值，比如 all/everyone/peer）？是否保留树关系校验？root 和 system 的地位有没有变化？

3. 广播语义：广播的目标集合怎么定义（整个 fleet？兄弟？某个 scope/subtree）？广播是"一条消息扇出多条记录"还是别的表示？谁可以广播？

4. 投递方式：点对点和广播各自用 push（steer 注入）/ notify（提示收件方拉取）/ pull（收件方主动读）中的哪种？由什么决定（kind？目标状态？消息大小？）？

5. 唤醒规则：什么消息能让一个正在运行的 agent 起一轮模型调用（steer）？什么消息只是存入收件箱等它下一轮自然读到？已结束（settled/gone）的 agent 能否被消息复活？如果能，是哪种消息、复活的机制是什么（resume？）

6. 看板（共享公告板）：最终定的存储方式（内存？session entry？文件？）和有效范围（同 stack？跨 stack/reload？哪些 agent 可见？）？谁可以发公告、有没有 TTL/上限？

7. 配额与收件箱满：v2 的配额维度怎么定（v1 是 per-sender per-kind）？收件箱满时的处理拍板是什么（拒绝？排队？降级为看板公告？）？广播的配额怎么算？

8. 其他重要拍板：R2"发送永不阻塞"在实现上意味着什么约束（admission 全同步、不 await 投递）？v2 与 v1 的关系是替换还是叠加（settings 迁移？灰度开关？）？有没有定过哪些 v1 语义必须保留（dead letter、at-least-once、六态状态机）？有没有定过默认值、命名（工具名还叫 message_agent 吗）、或明确排除的范围（non-goal）？

如果某条你记得讨论过但最终没拍板，也请明说"未拍板 + 当时的倾向"。请尽量具体，我要据此直接写实施方案。

## e1-r2 — A

先说明两点，再逐条回答。

**关于信息来源：** 在这次会话里，我不记得参与过你说的设计讨论和评审，所以不能凭记忆作答。我在当前仓库外找到了一套设计记录：`/home/bluecake/ai/pi-toolkit/docs/dev/fabric-v2/`，包括 `plan.md` v1.3 + §15 评审处置，以及 `baseline-experiment.md` 和 `baseline-results.md`。下面的回答全部来自这套文档。前后有冲突时，以 §15 的更正为准。另外，`baseline-results.md` §18 描述的实验 5 布置和这次对话完全吻合：`/tmp/exp5-repo`、下游 resume `upstream-expert` 来请教。你可能需要考虑这一点。

**在写实施方案之前，必须知道的状态：**

- `plan.md` 顶部写着**"已打回，搁置中"**，并注明"§0–§14 不得据此实施"。两轮评审共报出 3 个 Blocker、15 个 Major。
- 最新结论（results §13 和 §17.3）是：fabric v2 继续搁置。建议的最小落地形态是**一个轮内同步的 `ask_expert`/`consult` 工具**，本质是受控封装的 `Agent({resume})`，而不是完整的 fabric v2。
- 硬需求不止 R1 和 R2，还有 **R3：不限制发送能力，不设"谁能给谁发"的白名单**。后面好几条决策都是从 R3 推出来的。

建议先和需求方确认，要写的到底是 fabric v2 还是 consult 工具。下面按"如果复活 fabric v2"来回答。

---

### 1. 消息模型

- **结论：在 v1 基础上新增，不重新划分。** v1 的五种 kind 全部保留。原稿新增了 `query / answer / nack / announce` 四种。
- 裁剪后（§15.5）的最小集是 **3 个新 kind（query/answer/nack）+ `to:"board"`**。`announce` 不在最小集里。
  - 我的理解是，最终广播靠地址 `to:"board"` 来表达，是一种投递形态，不再作为独立 kind。
  - 但文档没有写明"删除 announce"，**这一点不确定**。
- **nack（"我不知道"）是一等公民（D-7）。** 理由：发送方不会阻塞，所以要让它尽早转去自查，不必干等超时。
- **NodeRef** 新增 `"board"`。
- **信封字段：** 最小集只新增 `replyTo`、`topic`、`evidence?` 三个。
  - `replyTo` 直接复用 v1 的 `makeMessageKey`（from:to:generation:seq）作为关联 id。
  - 原稿要求 answer 必须带 `evidence[{file,lines}]`。最小集里写成 `evidence?`，可选还是必填**不确定**。
  - 原稿里的 `urgent`、`hop`、`mutation`、`scope.symbols`、roster selector **都已砍掉**。
  - `audience`、`digest`、`discipline`、`freshness` 在 §15.5 里没有明确表态。其中 `discipline` 作为系统内部的裁定结果，大概率保留。

### 2. 发送权限与路由

- **结论：彻底删除 `can_message`（D-2）。没有新增 all/everyone/peer 之类的取值。**
  - 旧 frontmatter 如果还写着 `can_message:`，只打一次 WARN（"v2 已移除，该声明被忽略"），不报错。
  - 理由：R3 要求不设发送权限。约束要从"谁能发"转到"什么能进我的 context"，也就是接收侧的摄取预算。
- **`authorize()` 只保留方向性协议规则。** 这些规则是为了协议自洽，不是权限：
  - `dead_letter` 只能由 `system` 发；
  - `result` 只能上行（relation 必须是 child）；
  - `directive` 只能下行（relation 必须是 parent）；
  - 其余 kind 在任意关系下都放行，包括跨树、同级、任意深度。
- **树关系：** `tree.ts` 保留，但降级为溯源标注（D-11），relation 只用于展示可信度，不再做门控。mention 退化为 `@label` 寻址语法糖。
- **root 的地位：** 主会话也要注册 `message_agent` 和 `read_board`（post-guard，受 `fabric.enabled` 控制），这样"向主 agent 请教"才成立。
- **评审提出的代价（§15.4）：** 任意深度、正在处理 web 内容的 agent 都能唤醒持有全部工具的 root。暴露面比 v1 大得多。需求方接受了"不可逆"，但这个风险**没有给出解法**。

### 3. 广播语义

- **结论：广播就是 1 条看板记录（D-5），恒为 O(1)，绝不扇出成 N 路 push。** 理由：只有这种结构能让广播不把成本放大 N 倍。
- **目标集合：** 原稿设计了 topic 和 roster（running/type/subtree）两种，roster 已被裁掉，理由是在"广播不唤醒"之下它和 topic 效果相同。
  - 所以最终的目标集合就是"看板读者"，靠读者主动拉取，不存在"扇出目标"这个概念。
- **谁能广播：** 任何 agent（R3）。原稿要求广播必须带 `topic`（或 `scope.files`，已砍）。
- **重要提醒：** 评审认为，原稿"开工先广播：谁知道 X"的纪律在"广播不唤醒"之下基本无效（§15.6）。

### 4. 投递方式

- **结论：原稿的 D-1（"回答走 push，其他直达走 notify"）和 D-1a（`urgent`）都已作废，由 D-1′ 取代。**
- **D-1′ 按接收方状态决定投递方式**，三级塌缩成两级（push / board）：
  - 运行中的子 agent → **push**（`runner.steer`），受 `inboxCap` 约束；
  - root → push，但受 `wakeRoot` 开关和配额约束，前台忙时降级为 display；
  - 终态 agent → 落看板，或者 revive（见第 5 条）；
  - 广播 → 一律落看板（pull）；
  - 协议类 kind（`result`/`directive`/`dead_letter`）保持 v1 的 push。
- **决定因素是接收方状态和 kind**，不看发送方的意愿（`urgent` 已取消），也不看消息大小。
- **推翻原稿的关键事实（§15.1）：** steer 会并入同一个 turn 里的下一次 LLM 调用，所以对运行中的子 agent，push **不会额外产生一轮**，只花 context token。只有空闲的 root 和终态目标，才会真的"打断一轮"。
- **未解决的问题（Major M2）：** root 正阻塞在前台 `Agent` 调用里时，收不到提问。评审给了两个方向：
  - 一是明确"请教 root 只在 `run_in_background` 调度下有效"；
  - 二是在前台等待循环里，把发给 root 的 query 以 tool update 的形式暴露出来。
  - **未拍板。**

### 5. 唤醒规则

- **结论：不变量 I-W，唤醒只由点对点消息产生（D-14，需求方硬约束）。广播永远不唤醒任何人。**
  - 唤醒分两种：**W1** 是让运行中的 agent 起一轮（push/steer），**W2** 是复活终态 agent（`spawn({resumeFrom})`）。
  - 如果一条广播确实重要到需要叫醒某人，发送方要**另外单独发一条点对点消息**。
- **W2 的触发条件：** `audience` 为 direct **且** kind 为 `query`（或走 result/directive 的协议路径）。
  - `progress`、`finding`、公告发给终态目标时，一律落看板，**不复活**。
- **复活机制（D-9）：** 后台 fire-and-forget 的 auto-revive，约束如下：
  - `slotless: true`，不占 `concurrencyLimit: 6` 的槽位；
  - `deadlineAt` 按发起方剩余的 deadline 收紧；
  - label 不能被 repoint，需要给 repoint 新增第三态 `"keep"`；
  - 配置项 `autoRevive: true`、`reviveOnDirectQuery: true`、`autoReviveMaxPerSession: 10`。
- **但这条路目前走不通：**
  - **B2（Blocker）：** 两种写法都坏。带 `parentRunId`，会触发 canSpawn 校验并被静默吞掉；不带，复活的 run 结束时会以 `triggerTurn:true` 唤醒 root，绕过 I-W。前置设计要求：给复活 run 一个专属的 owner 锚点、跳过 canSpawn、抑制 notifier，答案只经 fabric 回流。
  - **M8：** `resumeLocks` 的实际行为是拒绝，不是合并。需要 router 维护一张 `reviving: target → newRunId` 表，复活期间到达的 query 等新 run 起来后再 steer 进去。
- **I-W 的落实方式：** 原稿的三个检查点不完整。评审要求改为在唯一出口统一断言，出口包括 `sendRootContext`、`runner.steer`、`spawn({resumeFrom})`。

### 6. 看板

- **存储：** session entry，`appendEntry(customType:"subagent:board")` + 写后读回，沿用 pi-outbox-store 的模式。`session_start` 时从 prefetched 条目重建。
- **有效范围（D-3）：** 仅当前主 session，跨 /reload 保留，**不跨会话**，新会话看板清零。跨会话的沉淀交给 memory 子系统。
- **谁能发、谁能看：** 任何 agent 都能发。任何 agent 都能用 `read_board` 读，root 也可以。
- **启动注入：** 原稿用 `before_agent_start` 注入看板摘要，但这个 hook 在子会话里根本不触发（**B1**）。改为在宿主侧 spawn 时拼进 prompt（`buildPrompt`），或者追加到 `SessionSpec` 的 system prompt 里；resume 的 run 也一样。
- **上限：**
  - `boardCap: 500`、`boardTopicCap: 50`、`boardInjectBudgetChars: 2000`；
  - 截断时优先保留最新的条目，以及被 `replyTo`/`ref` 引用过的条目；
  - 看板本身没有 TTL；
  - `boardSenderSharePct` 已被砍掉，理由是它会淘汰尚未得到回答的 query。
- **遗留风险：** 容量淘汰会删掉从没被读过的条目；看板内容会注入之后每一个 agent 的 prompt，构成持久化 prompt 注入。

### 7. 配额与收件箱满

- **维度：** 从 v1 的"发送方 × kind 配额"改为**接收方的摄取预算**。
  - `inboxCap: 8`，root 沿用 12；
  - 统计的是该接收方处于 `pending|claimed` 状态、且投递方式为 push 的记录数。
- **满了怎么办（D-6）：** 降级为落看板，**绝不拒收**。全链路不存在 "not authorized" 或 "quota exceeded"。
  - v1 的 per-kind 配置键仍会解析，但降级为存储上限，不再限制发送。
- **限速：** per-link 限速保留，`receiverMinIntervalMs: 30000`，root 为 `10000`。超限只推迟，不拒收。
- **去重：** 按 `digest = sha256(kind+topic+normalizedText)`，`dedupeTtlMs: 600000`，命中则 dropped（原因 duplicate）。
- **广播：** 只有 1 条记录，不产生 push，不占任何接收方的 `inboxCap`。最终没有单独的广播配额。
- **必须修的问题（M6）：** 协议类 kind 会占满 `inboxUsed`，把接收方自己问来的 answer 挤成降级。修法是给 answer/nack 留保留额度，或者协议类 kind 不计入预算。另外，§10 里"总量上界"的说法不成立，要如实改成"只有速率上界"。

### 8. 其他拍板

- **R2 意味着什么：**
  - `message_agent` 同步返回，文案写明"已投递，不阻塞，别等"；
  - revive 采用 fire-and-forget，并且 reject 必须被捕获；
  - `boundedSend` 仍然和 `steerMs` 赛跑；
  - 测试锚点：发送方的工具调用耗时 < 50ms。
- **状态机：**
  - 不新增 FabricRecord 状态（D-4），仍是 pending/claimed/delivered/consumed/dropped/abandoned 六态，投递方式在 `admit()` 时一次定死。
  - 落看板的路径改为**先写看板成功，再直接 `engine.put({state:"delivered"})`**（M3 的修法）。这样**不用改转移表**，原稿的 `pending→delivered` 增量和 8 处测试 fixture 都能省掉。
  - 注意 `src/core/state-machine.ts` 是 run 的状态机，和这里无关。
- **保留的 v1 语义：**
  - push 路径完整沿用 claim/attempts/backoff/死信；
  - "一条原始消息至多一条死信"不变；
  - `board_fallback`（迟到的答案转存看板）**只用于 answer/nack**。directive/finding 仍然签发死信，死信里附看板引用（M4）；
  - 新增的 terminalReason 保留 `board`、`board_fallback`、`duplicate`，`hop_exhausted` 和 `answered` 属于死代码，已砍。
- **其他必修点：**
  - `resolveDiscipline()` 取代 `effectiveChannel()`（throttle 里 3 处、mailbox 里 1 处调用都要改）。
  - 第①条规则要改成 `audience !== undefined && audience.kind !== "direct"`，否则存量死信和 v1 残留的记录会被误判成 pull（M-3）。
  - `mailbox.pump()` 里 ttl 和 target_gone 两个分支硬编码了 kind 判断，要一起改（M-6）。
  - `openQueries` 在 /reload 后，要从 engine 里未超 TTL 的 query 记录重建（M-7）。
- **与 v1 的关系：** 原地替换，仍由唯一的全局开关 `fabric.enabled`（默认 false）控制，没有单独的灰度开关。
  - `progressChannel` 保留为 legacy 映射；
  - 新增配置项 `wakeRoot: true`，设为 false 时 root 的所有入站消息都降级。
- **命名：** 工具名仍叫 `message_agent`，新增 `read_board`，并加入 `RESERVED_TOOL_NAMES`。
- **排除的范围：** 跨会话看板、roster、`urgent`、`hop/maxHops`、`mutation` 与失效预警、兴趣域三来源（含隐式推断）、`scope.symbols`、发送方公平份额、语义分类器。
- **施工约束：**
  - **B3：** M1 阶段不能动 mention 的 resume 分支，否则中间态会违反 I-W。
  - 不要和 quota 特性并行开发（§15.7），两者共享 `stack.ts`、`settings.ts`、`index.ts`。
  - 代码锚点用符号名（函数、常量、类型名），不要用行号。

**来自评审但本身未拍板的有：** root 在前台时收不到提问的处理方式（M2）、revive 的 owner 锚点设计（B2）、answer 的 evidence 是否必填、announce 是否作为独立 kind 保留，以及整体是否还要做 fabric v2 而不是 consult 工具。建议逐条和需求方确认后再动笔。[subagent label: "请教-fabric-v2-拍板决策" · run_id: r_TT59Q3TR · status: completed] — 用户可 @请教-fabric-v2-拍板决策 直接向它发消息

## e1-r3 — Q

我在为 pi-toolkit 的 fabric v2（消息投递层）制定实施方案。已知需求：R1 任意两个 agent 之间可点对点通信，也可一对多广播；R2 发送永不阻塞——发送方绝不等待对方回复。

现有 v1（src/fabric/）：message_agent 工具按 agent 类型 frontmatter 的 can_message 路由（默认仅 parent），有 mailbox（push 投递：对运行中的 run 用 runner.steer 注入、对 root 用 pi.sendMessage steer）、tree（spawn 边自持树）、throttle（per-link 限速 + root ingress gate）、mention 通道（@label 复活已结束的 root child）、router（admission + per-kind 配额 + 死信）。

请你把前序阶段与用户讨论并拍板的全部关键设计决策详细告诉我，尤其以下方面（请逐项给出结论和理由/取舍）：

1. 发送权限：v2 中任意 agent 之间点对点通信的授权规则是什么？还是基于 can_message frontmatter 吗？默认值是什么？与 v1 的 authorize() 有何差异？
2. 广播语义：一对多广播是怎么定义的？广播的目标集合如何确定（子树？兄弟？标签组？）？广播消息的 envelope/记录怎么表示（一记录多目标还是 fan-out 多记录）？
3. 唤醒规则：什么消息能让一个 agent 起一轮新的模型调用（turn）？接收方是运行中（steer 注入）vs 已结束（复活/resume）的判定规则？是否允许复活已结束的 agent，哪些 kind 允许？
4. 看板（共享公告）：这是什么概念？存储方式（session entry？内存？）、有效范围（单会话/跨会话/子树内）、读写接口、与点对点消息的关系？
5. 超限处理：配额/收件箱满时的行为——拒绝、退避、还是降级到看板/拉取？死信是否保留？
6. 消息类型（kind 列表）：v2 的 kind 集合与 v1（progress/finding/directive/result/dead_letter）相比有何增删？各 kind 的投递通道（push/notify/pull）由什么决定？
7. push / notify / pull 三种投递方式的划分规则：什么情况用 push（steer 注入）、什么情况用 notify（仅提示有新消息、不打断）、什么情况用 pull（接收方主动拉取/看板）？
8. 其他已拍板的决策：发送永不阻塞（R2）如何保证（写入即返回？）、幂等/去重、TTL、与 delivery engine 的关系、新工具签名（message_agent 是否要加 broadcast 参数或新工具）、配置项新增、有哪些被否决的备选方案。

请尽量完整地转述已拍板的结论（包括用户明确同意的细节、数值默认值、被否决的方案及理由），这些将直接决定我的实施方案的口径。

## e1-r3 — A

以下转述以 `/tmp/.p5x/plan.md`（fabric v2 方案 v1.3 + §15 两轮评审处置）为唯一依据，并与 `src/fabric/` v1 代码核对过。**优先级规则：§15 的处置与更正覆盖正文 §0–§14 的早期设计**；下文每项先给最终口径，再给被推翻/被裁剪的原设计。注意文档整体状态是 **⛔ 已打回、搁置中**（3 Blocker / 15 Major），需求方已拍板“先跑 baseline-experiment.md 量化收益，再决定工程投入”——这是所有以下决策的外壳前提。另外 §15.7 警告：仓库存在 quota 并行改动（22 文件 +620 行）与 fabric 改动面高度重叠，§1 的行号锚点已漂移，复活方案时须改为符号锚点。

---

## 1. 发送权限

**最终结论（D-2，需求方拍板）：`can_message` 彻底删除，v2 不存在任何发送权限白名单。**

- `authorize()` 重写后只剩三条**方向性协议自洽规则**（不是权限）：`dead_letter` 只能 `from==="system"`；`result` 只能上行（relation==="child"）；`directive` 只能下行（relation==="parent"）。其余 kind（progress/finding/query/answer/nack/announce）**任意关系全放行**——包括 unrelated/self/跨树/任意深度/同级。
- 默认值：无——字段整体删除（v1 默认“仅 parent”随之消失）。旧 frontmatter 出现 `can_message:` 时保留一次性 WARN（“v2 已移除，发送不再受限，该声明被忽略”），不报错。
- 与 v1 差异：v1 的 `authorize()` 检查 `canMessage` + mention 特例 + 拒绝 unrelated/self；v2 全拆。mention 退化为“用 @label 寻址”的语法糖，`MentionRoute` 删除，`via.mode:"mention"` 保留仅作溯源展示。
- 理由：R3 字面满足——约束从“谁能给谁发”移到“什么进得了我的 context”（接收侧摄取预算管量；正文还配了兴趣域管质，但大半被 §15.5 裁剪，见第 2 点）。
- 清理清单（§9 + §15.3 M-2 补全）：`types.ts:133`、`message.ts`（CanMessage/effectiveCanMessage/MentionRoute/authorize 分支）、`agent-types.ts` 解析 + `configHashInput` 与赋值处、`router.ts` 的 `AdmissionInput.canMessage/route`、`mention.ts:53`、`message-agent-tool.ts`（canMessage dep + admit 透传 + schema 描述）、`runtime-adapter.ts` 两处透传、`throttle.ts` 3 处 `effectiveChannel` 调用点。
- 不可逆性已由需求方确认接受；已知代价（§15.4 攻击结论）：删闸后任意深度、正在处理 web 不可信内容的 agent 都能唤醒拥有全部工具的 root，“不可信输入边界”判为有洞，属已接受残余风险（`formatMessage()` 的“不可信输入： from -> to”头覆盖全部新 kind + answer 强制 evidence 是仅有的缓解）。

## 2. 广播语义

**最终结论（D-5 + D-14 + §15.5 裁剪）：广播 = 发往 `to:"board"` 的一条看板记录，恒 O(1)，绝不 fan-out、绝不 N 路 push。**

- **发送时不确定任何显式目标集合**——这是与“子树/兄弟/标签组”类设计的本质区别。正文曾设计 `audience: direct | topic | roster`（roster selector = `{running} | {type,name} | {subtree,root}`），**§15.5 已把 roster 整个砍掉**（理由：I-W 下与 topic 效果相同，白付扇出裁定复杂度）。相关性在**读取侧**判定：topic 匹配、`scope.files` glob 交集（D-13：文件域机器可判定不漂移，优先于必然漂移的自由文本 topic）、`replyTo` 命中自己发过的 query（L0，最强且机器可证）。
- 正文 §6.5 的 L2 兴趣域三来源（显式下发/自主订阅/隐式 toolHistory 提取）与 L3 mutation 失效预警已被 §15.5 整体裁剪（新 agent 无工具历史 ⇒ 恒空；显式来源无落点）。
- 记录表示：1 条记录，`from` 是发送 run，generation 取其活跃 generation（`makeMessageKey` 规则不变，`from==="system"` 恒 0）。
- 正文 `announce` kind（D-12：强制带 topic 或 scope.files）**未进入 §15.5 最小集**（最小集只列 query/answer/nack 三个新 kind），但也未进裁剪清单——广播 kind 的去留复活时需确认。
- 公平份额闸 `boardSenderSharePct`（默认 25）已砍——会淘汰尚未回答的 query。
- 被否决备选：每接收者一条记录的 fan-out（把广播炸回 O(N)，违反 D-5）；roster selector（如上）。

## 3. 唤醒规则

**最终结论（D-14/不变量 I-W + §15.1 + B2/B3 处置）：**

- **I-W（需求方 v1.2 硬约束）：只有 direct 点对点消息可产生唤醒；广播（topic/board）恒不唤醒任何人。** 正文给的三个落点被 §15.4 判“不完整”，最终要求改为**在唯一出口处断言**——所有 `sendRootContext` / `runner.steer` / `spawn({resumeFrom})` 调用点检查来源是否 direct 且 kind 合规。
- **W1（turn 唤醒，运行中目标）= push**：子 agent 走 `runner.steer`；root 走 `sendRootContext(deliverAs:"steer", triggerTurn:true)`。
- **§15.1 推翻性更正（需求方已确认）**：pi 的 steer 在“当前 assistant turn 的 tool calls 结束后、下一次 LLM 调用前”投递，并入**同一外层 turn**——**push 给运行中子 agent 不产生额外轮次，成本只有 context token**。“打断一轮”只对空闲 root 和终态目标成立。这直接推翻了正文 D-1“回答 push/其他 notify”的成本前提。
- **W2（复活唤醒，终态目标）**：仅 `direct && kind==="query"`（及 result/directive 协议路径）触发 auto-revive；progress/finding/announce 发终态目标一律落看板。复活约束：`slotless:true` 不占并发槽、`deadlineAt` 由发起方剩余 deadline 夹紧（CC4 只收紧）、label **不得 repoint**（`spawn-service.ts` 的 resume 同 label 会抢走 `@expert`，需新增 `"keep"` 第三态）、`autoReviveMaxPerSession: 10` 兜底成本；`reviveOnDirectQuery`/`autoRevive` 默认 true。
- **B2（Blocker，处置仍是“前置设计”未成文）**：带 `parentRunId` 的 revive 撞 canSpawn 嵌套校验返回 config error、被 fire-and-forget 吞掉；不带则复活 run 不进 `childRunIds`，其完成通知以 `triggerTurn:true` 唤醒 root——**绕过 I-W 且 `wakeRoot:false` 管不住**。处置方向：专属 owner 锚点（不被 notifier 追踪）+ 显式跳过 canSpawn + 抑制 notifier 入队，答案只经 fabric 回流。
- **B3**：M1 中间态违反 I-W（删 mention 闸后 progress/finding 也会触发 resume）。处置二选一：M1 不动 mention 的 resume 分支、只放开对**运行中**目标的寻址；或把 W2 收紧 + revive 上限前移并与 M2 合并交付。
- root 唤醒：direct→root 的 push 在用户空闲时也起主会话一轮，由 `rootInboxCap: 12` 约束；`fabric.wakeRoot:false` ⇒ root 一切入站降级为 `sendRootDisplay` + 看板（T17）。升级通道：广播重要到要唤醒某人 ⇒ 发送方必须显式再发一条点对点消息（具名、可审计、计入对方 inboxCap）。
- **M2（未决）**：root 阻塞在前台 Agent 调用期间（`foregroundAutoBackgroundMs: 600_000`）收不到 steer——“向主 agent 请教”在最常见的前台调度下不成立。两个处置（文档明示“请教 root 仅 run_in_background 有效” / 前台等待循环里把指向 root 的 query 暴露为 tool update）**均未拍板**。

## 4. 看板（共享公告）

- **概念（§6.1）**：广播落地载体 + 迟到答案归宿 + 新 agent 启动知识来源，取代“主 agent 手动转接文件”。（但 §15.6 已推翻其收益依据，见下。）
- **存储（D-3，需求方拍板：仅当前主 session）**：`appendEntry(customType:"subagent:board")` + 写后读回校验，复用 `pi-outbox-store` 模式（append-only、无 ack）；`session_start` 从 prefetched 条目重建（与 tree 重建同源）。**不跨会话**：新主会话看板归零，跨会话沉淀留给 memory 子系统。容量：`boardCap: 500` 全局 FIFO、`boardTopicCap: 50` 每 topic；截断优先保留最新与被 replyTo/ref 引用过的条目。
- **读写接口**：读——新工具 `read_board({topic?, since?, limit?, from?})`，推进 per-reader cursor；写——`message_agent` 发 `to:"board"`（`admit()` 内同步落板）。启动注入：topic 目录 + 命中条目的一行摘要（非全文）+ read_board 指引，预算 `boardInjectBudgetChars: 2000`，复用 memory 的预算化渲染（pin/围栏/指纹缓存/tail sentinel）。
- **B1（Blocker）**：`before_agent_start` 在子会话根本不触发（HOST_KEY 守卫在注册前 return）——照正文实施 M3 核心交付为空。处置：注入改为**宿主侧 spawn 时拼进 prompt**（`runtime-adapter.ts` 的 buildPrompt 或 SessionSpec system prompt 追加项），resume 的 run 同理。
- **与点对点的关系**：看板是超限降级目标（push→board）、迟到/无法投递 answer 的归宿（D-8，经 M4 修正仅限 answer/nack，见第 5 点）、notify/pull 记录的同步落地处（落板即 delivered）。
- **§15.6 收益再评估（需求方已认可）**：看板只收录 agent 主动 announce 的内容，与 result 面对同一个压缩瓶颈；增量仅“运行中发过但 result 漏掉的”与“负面知识”，且都依赖 prompt 纪律才产生。正文“M3 能消掉大半重复调研”没有依据；“开工先广播谁知道”在 I-W 下基本无效。**真正绕过压缩瓶颈的只有“向终态专家定向提问 + revive”**（带完整原始会话回答），而它排在 M6 且有 B2/M8 两个 Blocker 级缺陷，其成本（一次带完整 context 的 run，缓存过期后可能高于提问方自己重查）原稿没算。

## 5. 超限处理

**最终结论（D-6 + M3/M4/M6/M7 处置）：超限不拒收，只降级；死信保留但收窄。**

- 总原则：全链路不存在“配额拒绝/未授权”，超限一律 push→board 降级（§15.1 后三级塌缩为两级）。
- 摄取预算：v1 的 `rootInbox()` 泛化为 `inboxOf(node)`——统计该接收方 `pending|claimed` 且 `discipline==="push"` 的条数；满 ⇒ 新 push 降级 board。默认 `inboxCap: 8`、root 沿用 12。
- **M7 优先级反转修正**：协议类 kind（result/directive/dead_letter）在预算检查前就返回 push 却仍占 `inboxUsed`，会挤掉接收方自己问来的 answer。处置：answer/nack 设保留配额，或协议类 kind 不计入 inboxUsed；§10 的“接收方 context 总量有界”声明如实降级为“**速率上界**”（v1 发送方总量配额降为 legacy 后只剩速率约束）。
- **死信保留**：v1 原子序 + `dlRefs`/`dlPlaceholders`“一条原始消息至多一条死信”不变；board_fallback 必须在 `issueDeadLetters` 按 sender 分批**之前**逐条判定（二者互斥的前提）。**M4 修正：board_fallback 只用于 answer/nack**；directive/finding 失败仍签死信（死信内附 board 引用）——否则发送方看到 `delivered` 会误判送达、失去失败信号。
- **M-6 修正**：`mailbox.pump()` 的 TTL 分支与 pre-claim target_gone 分支（加 verdict 失败分支共三处）硬编码 `kind==="finding"||"directive"`——新 kind 会被静默丢弃、board_fallback 无触发点；三处须统一走 board_fallback 判定。
- 去重：`digest = sha256(kind + topic + normalizedText)`，同 `(digest, to)` 在 `dedupeTtlMs: 600_000` 窗口内 ⇒ `dropped` + `rejected.reason:"duplicate"`（只拦逐字重复，是 §15.4 判“消息放大有界有洞”的原因之一）。`hop`/`maxHops` 是死代码，§15.5 已砍。
- 限速：per-link `minIntervalMs: 30s` 保留，**超时只推迟不拒收**；`rootMinIntervalMs: 10s` 泛化为 `receiverMinIntervalMs: 30s`（root 保留更严独立值）。`answered` supersede 已砍（死代码）。
- push 失败**且无 topic 可转存**时仍走 v1 死信链路（claim/attempts/backoff 不变）。

## 6. 消息类型（kind 集合）

- v1 五个 kind 全保留：progress/finding/directive/result/dead_letter。
- v2 新增（正文）：**query**（提问：无义务、无阻塞、可被忽略）、**answer**（`replyTo` 指回 query，**强制 `evidence[{file,lines}]`**——答案是“另一个 LLM 的记忆”可能幻觉/过期，强制证据让接收方 O(1) 抽查）、**nack**（“我不知道/不在范围”，D-7 一等公民——让发送方立刻转自查，比等超时快一个量级）、**announce**（广播公告恒落板，强制 topic 或 scope.files）。
- **§15.5 最小集只保留 query/answer/nack 三个新 kind** + `to:"board"` + `replyTo`/`topic`/`evidence?` 三个字段——announce 未入最小集也未入裁剪清单（去留待确认）；`mutation`、`scope.symbols`、`urgent`、`hop` 已明确砍掉。
- 投递通道由什么决定：正文设计是 `admit()` 内 `resolveDiscipline()` 一次裁定、写入记录后**永不变更**（D-4：不新增 FabricRecord 状态）。**最终口径是 D-1′（§15.1）：按接收方状态**——运行中子 agent → push（受 inboxCap 管 token 量）；root → push 但受 wakeRoot + 配额（前台忙时降 display）；终态 → 落看板或 revive；协议类（result/directive/dead_letter）恒 push。**注意：§3.5 的伪码实现的是已作废的 D-1（answer/nack push、其余 notify、urgent 升级），且规则①有 M-3 指出的顺序 bug**（`audience` 可选，无 audience 的存量消息——系统死信、/reload 后 v1 残留 pending——会被判 pull ⇒ 死信永不泵送）；修正：`audience !== undefined && audience.kind !== "direct"` 才 pull，系统死信显式盖 `discipline:"push"`，并补 /reload 迁移规则。照 §3.5 原文实施会建出被撤销的版本。

## 7. push / notify / pull 的划分

**最终结论（§15.1）：三级塌缩为两级（push / board）——对运行中 agent，notify 与 pull 无区别。**

- 划分依据从“消息内容/发送方意愿”改为“**接收方状态**”（D-1′）：
  - **push**：运行中子 agent → `runner.steer`（无额外轮次，成本=context token）；root → `sendRootContext`（空闲时真起一轮，受 wakeRoot/rootInboxCap，前台阻塞时收不到，见 M2）；终态 → auto-revive（direct+query，全新 run 全价）。
  - **board**（原 notify/pull 合并）：root 的 notify 形态 = `sendRootDisplay`（appendEntry，display-only **不进模型 context**）；运行中子 agent = 落板 + 机会式提示（正文 §3.6 诚实声明：pi 没有“不触发 turn 注入运行中会话”的原语，notify 是 best-effort、可能永远不被看到——这正是原 G1 的根源，随 §15.1 成本更正后 G1 关闭）；pull = `read_board` 主动拉。
- `mailbox.pump()` 只处理 `discipline==="push"` 的记录。
- notify/pull 落板的最终实现（**M3 处置，取代正文的转移表增量**）：**先写板成功后直接 `engine.put({...state:"delivered"})`**（put 不查转移表），`terminalReason:"board"`——由此省掉 `stack.ts:246` 给 `allowed.pending` 追加 `"delivered"` 的改动和 8 处测试 fixture 同步，也消除“pending 僵尸”（board 写失败或 /reload hydrate 后，TTL 判断在 pump 候选循环内、而候选已被 push 过滤掉，记录永不终结）。

## 8. 其他已拍板决策

- **R2 的保证机制**：`message_agent` 同步返回（写入即返回），返回文案写死「已投递，不阻塞。若收到回答会作为消息进入你的上下文。不要为此等待——继续当前工作，或先做粗筛」；auto-revive fire-and-forget（不等 spawn 结果，返回 `{status:"reviving"}`——但 B2/M8 要求 reject 必须被捕获处理而非吞掉）；`boundedSend` 仍与 `fabricSteerTimeoutMs`（`budget.steerMs`，5s）赛跑。零挂起不变量保持：阻塞式 consult 的 slot 死锁 / resumeLocks 互等 / A↔B 环等待在 v2 结构上不可能（§15.4 注：回复**延迟**无上界，前台 root 最长 600s）。
- **prompt 纪律（§8.1，与机制同等重要，注入文案写死三条）**：①开工先问（read_board + 广播“谁知道”——§15.6 判定在 I-W 下基本无效）；②问完继续；③**答案到了就转向**——push 进来的 answer 覆盖正在做的事时立刻停止并采用（附 evidence 抽查指引）；缺第 3 条模型会无视答案继续傻干，是同类机制最常见失效模式。
- **问答四结局（§8）**：①对方在跑且知道 → answer push 回来；②在跑但不知道 → nack push 回来（立刻转自查）；③已终态 → 后台 auto-revive，专家复活后发 answer，A 早已在做别的；④没人回/A 已结束 → answer 按 topic 转存看板（不发死信）。
- **resumeLocks 真实行为（M8）**：是**拒绝**不是合并（`spawn-service.ts` 返回 "already has a resume in progress"），fire-and-forget 会吞掉 ⇒ 第二个提问者的 query 静默消失。处置：router 维护 `reviving: target → newRunId`，revive 期间到达的同目标 query 在新 run running 后 steer 进去。
- **与 delivery engine 的关系**：不新增 FabricRecord 状态（D-4）；memoryOnly（claimed/claimToken）不变；**M-1 更正**：真正的转移表在 `stack.ts` 的 `allowed` 字面量 + `delivery/engine.ts`，被 **7 处测试 fixture 逐字复制**（5 个文件）——若改表即 8 处同步；`core/state-machine.ts` 是 **run** 状态机、与 FabricRecord 无关（正文 §4.4 lockstep 指错了文件）。新增 terminalReason：`board` / `board_fallback`（`duplicate` 保留，`hop_exhausted`/`answered` 随裁剪消失）。
- **工具签名**：`message_agent` 增 `topic`/`audience`/`replyTo`/`urgent`/`evidence`（urgent 已取消、roster 已砍 ⇒ 实际最小集塌缩为 `replyTo`/`topic`/`evidence` + `to:"board"` 寻址；`audience` 结构化字段最终形态未明说）；新工具 `read_board({topic?, since?, limit?, from?})`；`read_board` 加入 `RESERVED_TOOL_NAMES`（deny-by-default）；**主会话也必须注册 `message_agent` + `read_board`**（post-guard、`fabric.enabled` 门控）——否则 root 无法回答，“向主 agent 请教”不成立；子会话沿用 customTools + grantedReserved 注入。
- **配置项（§7.4，含裁剪标注）**：`enabled:false`（唯一全局开关）；`inboxCap:8` / `rootInboxCap:12`；`receiverMinIntervalMs:30000` / `rootMinIntervalMs:10000`；`dedupeTtlMs:600000`；`boardCap:500` / `boardTopicCap:50`；`boardInjectBudgetChars:2000`；`reviveOnDirectQuery:true` / `wakeRoot:true` / `autoRevive:true` / `autoReviveMaxPerSession:10`；**已砍**：`maxHops`、`boardSenderSharePct`、`relevanceImplicitInterest`、`relevanceMutationPriority`；**legacy（解析但降级为存储上限）**：`maxPerRun:20` / `findingQuota:10` / `directiveQuota:5` / `deadLetterQuota:5` / `maxChars:2000` / `progressTtlMs:900000` / `progressChannel:"display"`。
- **被否决的备选方案汇总**：①阻塞式 consult_agent（原方案整体改写为非阻塞——slot 死锁/resumeLocks 互等/环等待）；②保留 `can_message`；③notify/pull 走 claim/token 协议落板（仪式性开销且产生 pending 僵尸）；④G1 三选项（query 默认 notify+urgent / query 恒 push / 严格 notify 无 urgent）——I-W 排除了选项 3，§15.1 推翻成本模型后 **G1 整个关闭、`urgent` 取消**；⑤“广播破格唤醒”作为失效预警缓解（违反 I-W，明确不接受）；⑥跨会话看板（D-3 否决，留 memory）；⑦board_fallback 覆盖所有 kind（M4 限 answer/nack）；⑧`pending→delivered` 转移表增量（M3 改为直 put）；⑨独立的“知识交接包”机制（并入看板）。
- **实施切割（正文 §12，经 B1/B3 修正）**：M1 删 can_message + authorize 重写 + 任意寻址（不动 mention resume 分支）；M2 resolveDiscipline + inboxCap（B3 备选：W2 收紧 + revive 上限前移并入此阶段）；M3 board + read_board + 重建 + 注入（注入机制按 B1 改宿主侧）；M4 query/answer/nack + replyTo 闭环 + 主会话注册；M5 announce + 幂四闸（roster 部分已砍）；M6 auto-revive + board_fallback（前置设计 B2/M8 未做）。正文“M3 性价比最高”已被 §15.6 推翻。
- **TTL/幂等补遗**：progress 用 `progressTtlMs`（900s，legacy）、其余用 `reconcileTtlMs`；`openQueries` 需 TTL 清理——若保留（D-1′ 下其对 discipline 的职能大减），M-7 要求从 engine 内 `kind==="query"` 未超 TTL 记录 hydrate（/reload 重建原完全未规定）。

---

**仍未设计/未拍板、实施方案必须先补的缺口**：B2 的 revive owner-anchor 机制（含跳过 canSpawn、抑制 notifier）；M8 的 `reviving` 映射 + spawn `"keep"` 第三态；M2 的 root 前台二选一；B1 注入的具体落点（buildPrompt vs SessionSpec）；announce kind 与 `audience`/`scope.files` 字段的最终形态；以及 baseline-experiment 的量化结果本身——它决定这套设计是否值得按最小集复活。[subagent label: "请教-fabric-v2-设计决策" · run_id: r_R0AEGMWY · status: completed] — 用户可 @请教-fabric-v2-设计决策 直接向它发消息

## e1-r4 — Q

我是 fabric v2 消息投递层实施方案的制定者。我已经读过 v1 代码（src/fabric/ 的 router/mailbox/tree/throttle/mention + core/message.ts + tools/message-agent-tool.ts + stack.ts buildFabric）。任务交接说前序阶段已与用户拍板了若干关键设计决策（涉及发送权限、广播语义、唤醒规则、看板范围、超限处理、消息类型等），但没有逐条展开。请把这些已拍板的决策尽量完整、逐条地告诉我，包括每条决策的理由/讨论中提到的取舍。我特别需要知道：

1. **消息模型**：v2 的消息 kind 列表是什么？新增了哪些（相对 v1 的 progress/finding/directive/result/dead_letter）？消息字段有什么变化（如广播目标、看板相关字段）？
2. **发送权限**：v2 里"任意两个 agent 点对点通信"（R1）的授权规则最终怎么定的？还是走 can_message frontmatter 吗？无关agent（unrelated）之间能不能发？root/系统有什么特殊权限？mention 路由保留吗？
3. **广播语义**：一对多广播怎么定义的？广播的目标集合怎么确定（订阅制？全员？按 can_message？）？广播是 fan-out 成多条点对点消息还是单独的实体？
4. **投递方式**：点对点与广播各自的 push / notify / pull 由什么决定？（v1 里 running 目标走 steer 注入、root 走 sendMessage/display；v2 有没有引入 pull 模式——收件人主动拉取？看板是不是就是 pull 的一部分？）
5. **唤醒规则**：什么消息能让一个 agent 起一轮模型调用？已结束的 agent 能否被"复活"（v1 mention 有 resume-from-terminal 的先例）？广播要不要唤醒所有目标？root 的唤醒呢？
6. **看板（共享公告）**：存储方式（内存？持久化到 session entry？）与有效范围（整个会话树？还是只在同一父节点下？）定了没有？谁可以读/写/清除看板？看板有容量或 TTL 限制吗？
7. **配额/收件箱满**：超限处理最终怎么定的？发送方配额（每 run 配额）与接收方收件箱满分别怎么处理——丢弃、退回 dead letter、背压、还是溢出到看板？
8. **发送永不阻塞（R2）**：有没有讨论到与 v1 不同的保证机制？
9. 其它我没想到但前序讨论拍板过的决策（比如与 workflow、label 路由、`@label` 提及、persist/reload 恢复、settings 配置项相关的），也请一并告知。
10. 有没有评审中明确否决掉的备选方案（我方案里不要再提的）？

请按条目详细回答，谢谢！

## e1-r4 — A

收到。以下按你的 10 个问题逐条交接。**先说一个压倒一切的前置结论**：plan.md 文档头已标 ⛔「**已打回，搁置中**」——§0–§14 是 v1.3 原稿，**不得据此实施**；两轮评审（3 Blocker / 15 Major）的处置全部在 **§15**，§15 的结论**优先于正文**。需求方已拍板的路线是：**先跑 `baseline-experiment.md` 量化收益，再决定工程投入规模**（不是先修文重写）。所以下面每条我都以「§15 修订后的最终口径」为准，被推翻的早期设计会标注。

---

## 1. 消息模型

**Kind 列表**（v1.3 正文 §3.2 新增 4 个，§15.5 裁剪后剩 3 个）：

- 保留 v1 全部：`progress / finding / directive / result / dead_letter`
- 新增且保留：**`query`**（提问：无义务、无阻塞、可被忽略）、**`answer`**（回答，`replyTo` 指回 query）、**`nack`**（「我不知道/不在范围」，一等公民，D-7：让发送方尽早转自查，比等超时快一个量级）
- `announce` 在正文里是第 4 个新 kind，但 **§15.5 的「剩余最小集」只列了 3 个新 kind**（query/answer/nack），announce 未进最小集（裁剪清单未逐字点名它，但以最小集为准）。§15.6 的批评正是围绕这点：看板只收录 agent 主动 announce 的内容 ⇒ 面对与 result 同一个压缩瓶颈。

**剩余最小集**（§15.5，最终口径）：`3 个新 kind + to:"board" + replyTo / topic / evidence? 三个字段 + 两级 discipline + 看板 + read_board`，设计面砍掉一半以上。

**字段变化**（§3.3 全量 → 标注裁剪结果）：

- **NodeRef 增加 `"board"`**（`validNode()` 同步）；广播记录的 `from` 是发送 run，generation 取其活跃 generation；`makeMessageKey` 的 generation 规则不变（system 恒 0）
- **`replyTo?: MessageKey`**——问答关联，复用 v1 的 `from:to:generation:seq` 作 correlation id
- **`topic?: string`**——看板归档键
- **`evidence?: Array<{file, lines?, quote?}>`**——`kind=answer` 时强制必填（D-12：答案是「另一个 LLM 的记忆」，可能幻觉/过期，强制证据让接收方 O(1) 抽查）
- **`discipline`**——系统裁定结果（见 §4），admit 时一次定死永不变更（D-4）
- 被砍字段：`urgent`（§15.1 随成本模型一起取消）、`hop`/`maxHops`（死代码，方案内无转发路径）、`mutation`（v1.1 残留，与 D-14/I-W 矛盾，M-4/M7 定论砍掉）、`scope.symbols`、`boardSenderSharePct`、`answered` supersede
- `scope.files`、`audience`（roster selector 已砍）、`digest`、`freshness` 未出现在最小集三字段里；`digest` 作为去重闸未被明确砍（§15.4 只指出它「只拦逐字重复」的弱点）；`audience` 在 roster 砍掉后大概率冗余（direct vs 广播可由 `to === "board"` 区分）——**这两处方案未明说，实施前需确认**

**FabricRecord 状态**：D-4 **不新增状态**（pending/claimed/delivered/consumed/dropped/abandoned 沿用）。§15.3 M3 的最终处置：notify/pull 改为「**先写板成功后直接 `engine.put({...state:"delivered"})`**」（`put` 不查转移表）⇒ 正文 §4.1 那条 `pending→delivered` 表增量**不必做**，8 处测试 fixture 改动**全部可省**。`rejected.reason` 新增 `"duplicate"`（`"hop_exhausted"` 随 hop 砍掉成为死项）。terminalReason 新增 `board` / `board_fallback`。

---

## 2. 发送权限（R1/R3 → D-2）

- **`can_message` 彻底删除**（D-2，需求方确认，且确认为**不可逆**：将来要限制某类 agent 发言需重新设计机制；旧 frontmatter 只保留一次性 WARN「v2 已移除，发送不再受限」）。
- `authorize()` 只留**方向性协议规则**（是协议自洽不是权限）：`dead_letter` 仅 `from==="system"`；`result` 仅上行（`relation==="child"`）；`directive` 仅下行（`relation==="parent"`）；`progress/finding/query/answer/nack/announce` **任意关系全开**——`unrelated`/`self` 不再被拒，跨树、任意深度、同级全通。
- **核心语义转换**（§0.3）：R1+R3（无限制广播+推送投递）= context 投毒 + turn 放大，所以约束不放在「谁能给谁发」，放在「**什么进得了我的 context**」（接收侧摄取预算）。这是整个方案的地基。
- **mention 路由删除**：`MentionRoute`、`canMessage`、`effectiveCanMessage()` 全删；mention 退化为「用 `@label` 寻址」的语法糖，不再是独立授权模式；`via.mode:"mention"` 保留仅作溯源展示。
- **root**：普通可寻址节点，无特殊发送权限；接收侧特殊项是 `rootInboxCap: 12`（比通用 8 宽）、`rootMinIntervalMs: 10s`、`wakeRoot` 开关。v2 还要求**主会话也注册 `message_agent`**（§6.3，post-guard、`fabric.enabled` 门控），否则「向主 agent 请教」不成立。**system**：只发死信。
- 清理清单（§9 + §15.3 M-2/M-5 补漏）：`types.ts:133` 删字段；`agent-types.ts` 删解析 + **`configHashInput` 与赋值处**；`message-agent-tool.ts` 删 dep + **admit 透传**；`runtime-adapter.ts` 两处 `spec.type.canMessage` 透传；docs 加废弃横幅；测试删授权矩阵 can_message 用例、新增「任意关系放行」+「方向性仍生效」两组。
- 发送方仍须 running（v1 admit 的 `sender is not running` 检查未变）。

---

## 3. 广播语义（D-5 / D-14）

- **广播 = 1 条看板记录（`to:"board"`），恒 O(1)，绝不 N 路 push**（D-5：唯一让广播不炸成本的结构；「N 路 fan-out」是被明确否决的备选）。
- 正文里目标集合曾由 `audience` 三态定义：`direct` / `topic` / `roster(selector: running|type|subtree)`。**§15.5 把 roster 砍了**（I-W 下与 topic 效果相同）。
- 相关性模型（D-13）：**默认不相关**，接收方兴趣域 × 消息结构化检索键的交集；**文件域优先于 topic**（topic 是自然语言必然漂移，`fabric-routing`/`消息路由`/`router` 指同一件事；files glob 机器可判定且本就是工作拆分单位）。摄取预算管「量」，兴趣域管「质」。**但 §15.5 把 §6.5 L2 的三来源（显式下发/自主订阅/隐式累积）全砍了**——新 agent 无工具历史 ⇒ 隐式恒空，显式来源无落点。所以最终形态里「目标集合」实际退化为「**所有会读板的 agent**」：广播不做投递面计算，靠 `read_board` 主动拉取 + 启动注入 topic 目录。
- 升级通道：广播重要到需要唤醒某人 ⇒ 发送方**显式再发一条点对点**（具名、可审计、计入接收方 inboxCap）。

---

## 4. 投递方式（§15.1 推翻性更正：D-1 → D-1′）

**最重要的更正**：正文 §3.6 的成本模型「push = 打断对方一轮」**是错的**（实测复核：pi 的 steer 在当前 assistant turn 的工具调用执行完之后、下一次 LLM 调用之前送达，并入同一外层 turn）。⇒ 对**运行中子 agent**，push 的真实成本只有 context token，没有额外轮次。连锁后果（需求方已确认）：

- **三级 discipline（push/notify/pull）塌缩为两级（push / board）**；对运行中 agent，notify 与 pull 无区别
- **D-1 作废，由 D-1′ 取代：discipline 按接收方状态划分**——运行中子 agent → push（受 `inboxCap` 约束 token 量）；root → push 但受 `wakeRoot` + 配额（前台忙时降 display）；终态 → 落看板或 revive
- **`urgent` 字段取消**；§13 闸门 G1（directed query 默认纪律）**关闭**，无需签字
- 「唤醒想引起注意的唯一途径是点对点」的推论仍成立（I-W）

其它定死的点：

- `resolveDiscipline()` 纯函数在 `admit()` 内一次裁定、写死不变（D-4）。**§15.3 M-3 的顺序修正必须落实**：规则① 改为 `audience !== undefined && audience.kind !== "direct"` 才判非 direct——否则不带 audience 的存量消息（系统死信、/reload 后 v1 残留 pending）被判 pull，被 pump 的 `discipline==="push"` 过滤后**连 TTL 分支都进不去**，静默饿死。系统死信显式盖 `discipline:"push"`；补 /reload 迁移规则。
- `mailbox.pump()` 候选筛选加 `r.discipline === "push"`；notify/pull **不进 mailbox**，写板成功即 delivered（见 §7 的 M3 处置）。
- `boundedSend` 与 `steerMs`（5s）赛跑不变；`progressChannel` 保留解析但标 legacy（display→root notify 走 `sendRootDisplay`；context→等价旧配置）。
- **root 前台盲区（§15.3 M2，处置方向二选一，未最终定）**：root 阻塞在前台 `Agent` 工具调用里（`foregroundAutoBackgroundMs: 600_000`）时 `deliverAs:"steer"` 送不进去 ⇒ 要么明确「请教 root 只在 `run_in_background` 调度下有效」，要么在前台 Agent 等待循环里把指向 root 的 query 暴露为 tool update。
- 诚实声明（§3.6，被 15.1 部分缓解但仍是能力边界）：pi 没有「不触发 turn 就注入运行中会话」的原语；root 的 display 条目**不进模型 context**。

---

## 5. 唤醒规则（D-14 / 不变量 I-W）

- **I-W（硬规则，无配置项）：只有 `audience.kind === "direct"`（点对点）可产生唤醒**；任何广播恒不唤醒。唤醒分两形态：**W1** turn 唤醒（运行中：`runner.steer`；root：`sendRootContext(deliverAs:"steer", triggerTurn:true)`）、**W2** 复活唤醒（终态：`spawn({resumeFrom})`）。
- **W2 触发面收紧为 `direct + kind === "query"`**（§3.7 落点 2 也承认 result/directive 的协议路径）；`progress`/`finding`/`announce` 发给终态目标一律落看板，绝不 revive（把已结束的 agent 拉起来只为听通报是纯烧钱）。
- **auto-revive（D-9）**：后台非阻塞，fire-and-forget；复用 mention resume 分支。四条约束：`slotless:true`（不进 concurrencyLimit 槽池）；`deadlineAt` 由发起方剩余 deadline 夹紧（CC4 只收紧）；`autoReviveMaxPerSession: 10` 兜成本；**label 不 repoint**——`spawn-service.ts:376-388` 的 repoint 分支需新增第三态 `"keep"`，否则 `@expert` 会被问答 run 抢走。
- **root 唤醒**：direct→root 的 push 会在用户空闲时也起主会话一轮（「向主 agent 请教」的必要代价），由 `rootInboxCap` 约束；`fabric.wakeRoot: false` ⇒ root 一切入站降级 `sendRootDisplay` + 看板。`reviveOnDirectQuery` 开关门控 W2。
- **评审攻破的四个洞（§15.4，实施时必须按新口径收口）**：① B2——revive 完成通知带 `triggerTurn:true` 唤醒第三方；② `tree.targetState("board")` 返回 `gone` ⇒ 滞留 board 记录会向广播者 push 死信（广播者是 root 即间接自唤醒）；③ B3 中间态（见 §9 的 M1 约束）；④ T13 自身要求违反 I-W（已删）。**处置方向：三个落点不够，改为「在唯一出口处断言」——所有 `sendRootContext` / `runner.steer` / `spawn({resumeFrom})` 调用点检查来源是否 direct 且 kind 合规。**
- **B2（Blocker）**：revive 两种写法都坏——带 `parentRunId` 撞 `canSpawn` 嵌套校验、config error 被 fire-and-forget 吞掉；不带则复活 run 不入 `childRunIds`（runtime-adapter.ts:343），settle 通知以 `triggerTurn:true` 唤醒 root，`wakeRoot:false` 也管不到。**处置：revive 需专属 owner 锚点（不被 notifier 跟踪）+ 显式跳过 canSpawn + 抑制 notifier 入队，答案只经 fabric 回流——这是 revive 特性的前置设计，尚未成文。**
- **M8（Major）**：`resumeLocks` 实际是**拒绝**不是合并（"already has a resume in progress"），fire-and-forget 会吞掉 ⇒ 第二个提问者的 query 静默消失。**处置：router 维护 `reviving: target → newRunId`，revive 期间到达的同目标 query 在新 run running 后 steer 进去。**
- 残余风险 R-W（已知且接受）：失效预警不唤醒 ⇒ 接收方可能在看到预警前基于失效前提干完活；缓解只允许点对点路径，**「广播破格唤醒」被明确排除**。
- 成本警告（§15.6）：revive 是一次带完整 context 的 run，缓存过期后**可能高于提问方自己重新调研**，原稿没算这笔账。

---

## 6. 看板

- **范围（D-3，需求方拍板）：仅当前主 session**，不跨会话；新主会话看板归零。理由：无陈旧治理成本；跨会话复利留给后续（memory 子系统已可手动承载）。
- **持久化**：`appendEntry(customType: "subagent:board")` + 读回校验，完全复用 `pi-outbox-store.ts` 模式（append-only、无 ack、写后读回）；`session_start` 从 prefetched 条目重建（与 stack.ts 重建 tree 的写法同源）。
- **容量**：全局 FIFO `boardCap: 500`；每 topic `boardTopicCap: 50`；截断优先保留 ①最新 ②被 `replyTo`/`ref` 引用过的。`boardSenderSharePct` 公平份额闸**被砍**（会淘汰尚未回答的 query）。TTL 未单独规定（容量截断即上限）。
- **读写**：`read_board({topic?, since?, limit?, from?})`，推进 per-reader cursor；谁可写 = 经 `message_agent` 落板的消息（answer/nack 转存、query 落板；announce 已出最小集）；**主动清除机制未规定**，只有截断。
- **启动注入（B1 Blocker 的最终处置）**：`before_agent_start` 在子会话**根本不触发**（注册在 HOST_KEY 守卫之后，index.ts:142 vs :394）——注入必须改为**宿主侧 spawn 时拼进 prompt**（runtime-adapter 的 buildPrompt）或 `SessionSpec` 的 system prompt 追加项；**resume 的 run 同理**。注入内容 = topic 目录 + 命中兴趣域条目的一行摘要（非全文）+ read_board 指引，复用 memory 的预算化渲染（`boardInjectBudgetChars: 2000`）。
- **收益再评估（§15.6，需求方已认可）**：看板只收录 agent 主动 announce 的内容 ⇒ 与 result 同一个压缩瓶颈；增量只有「A 运行中发过但 result 漏掉的」+「负面知识」，且都依赖 prompt 纪律才会产生。正文「M3 能消掉大半重复调研」**没有依据**。「开工先广播：谁知道」在 I-W 下基本无效（广播不唤醒任何人）。真正绕过压缩瓶颈的只有「向终态专家定向提问 + revive」——它排在 M6 且带 B2/M8 两个 Blocker 级缺陷。⇒ 先量化再投工程。

---

## 7. 配额 / 收件箱满

- **超限一律降级，绝不拒收（D-6）**：push → 落板（两级化后）；全链路不存在发送失败，R3 字面满足（T4 回归锚：永不返回失败）。发送方 per-kind 配额（maxPerRun/findingQuota/directiveQuota/deadLetterQuota）**降级为 legacy 存储上限**，语义上被接收侧预算取代。
- **接收侧摄取预算**：`rootInbox()` 泛化为 `inboxOf(node)`，统计 `pending|claimed` 且 `discipline==="push"` 的条数；`inboxCap: 8`（root 沿用 12）；满 ⇒ 新 push 降级落板。
- **M6 修正（必须落实）**：`resolveDiscipline` 里 result/directive/dead_letter 在预算检查**之前**返回 push 却仍占 `inboxUsed`，会把接收方自己问来的 answer 挤成落板（优先级反转）⇒ **answer/nack 设保留配额，或协议类 kind 不计入 inboxUsed**；§10 的「总量上界比 v1 更强」不成立，如实改为**速率上界**。
- **速率**：per-link `minIntervalMs: 30s` 保留；`rootMinIntervalMs: 10s` 泛化为 `receiverMinIntervalMs`（root 保留独立更严值）；**超时只推迟不拒收**。
- **死信 vs 转存（D-8 + M4 + M6 修正）**：`board_fallback` **只用于 `answer`/`nack`**；`directive`/`finding` 的 push 失败**仍签死信**（死信内附 board 引用）——否则发送方看到 `delivered` 会误判送达（失去失败信号）。死信只在 push 失败**且无 topic 可转存**时签发；「一条原始消息至多一条死信」不变（`dlRefs`/`dlPlaceholders` 原子序），前提是 board_fallback 判定必须在 `issueDeadLetters` 按 sender 分批**之前**逐条做。**M-6 补漏**：pump 的 ttl 分支和 pre-claim `target_gone` 分支也硬编码了 `finding||directive` 死信——三处统一走 board_fallback 判定，否则新 kind 在这两条路径被静默丢弃。
- **去重**：`digest = sha256(kind + topic + normalizedText)`，同 `(digest, to)` 在 `dedupeTtlMs: 600_000` 窗口内 ⇒ `dropped`（`rejected.reason:"duplicate"`）。已知弱点：只拦逐字重复（§15.4）。
- 广播话痨的防线定位：非权限手段（工具描述写成本、强制 topic、容量截断），「真实防线是 prompt 纪律不是配额」。

---

## 8. R2 非阻塞

- 机制与 v1 同源且更强：`message_agent` **同步返回**（T6 回归锚：工具调用耗时 < 50ms），返回文案显式写「已投递，不阻塞…不要为此等待——继续当前工作，或先做粗筛」；`boundedSend` 仍与 `steerMs` 赛跑；auto-revive fire-and-forget。**阻塞式 consult（v1 之前的方案）被整体否决**：slot 死锁 / resumeLocks 互等 / A↔B 环等待在 v2 结构上不可能出现。
- §15.4 的限定：零挂起「守住」有条件——**revive 必须真正脱离当前调用且 reject 被捕获**；且回复延迟无上界（前台 root 最长 600s）。
- **§8.1 prompt 纪律三条（与机制同等重要）**：①开工先问（read_board + 广播「我要查 X」）——但注意 §15.6 已指出此条在 I-W 下基本无效；②问完继续；③**答案到了就转向**（push 进来的 answer 覆盖正在做的事时立刻停止并采用，附 evidence 抽查指引）——缺第 3 条模型会无视答案继续傻干，是同类机制最常见失效模式。

---

## 9. 其它已拍板 / 已修正的点

- **D-4**：不新增 FabricRecord 状态（动机：最小化 AGENTS.md 要求的状态机转移矩阵/属性测试 lockstep 改动）。
- **D-11**：`tree.ts` 保留但**降级为溯源标注**（`via.lca/hops`、relation 仅作展示与信任先验）；`isRootChild` 不再 gating。
- **D-12**：answer 强制 `evidence`（保留）；announce 强制 topic/scope.files（announce 已出最小集）。
- **M1 阶段约束（B3）**：删 mention 两道闸的中间态会让 `progress`/`finding` 也触发 resume，违反 I-W ⇒ **M1 不动 mention 的 resume 分支，只放开对运行中目标的寻址**；或把 W2 收紧 + revive 上限前移并与 M2 合并交付。
- **工具面**：主会话也注册 `message_agent` + `read_board`（post-guard、`fabric.enabled` 门控）；子会话经 `grantedReserved`；`RESERVED_TOOL_NAMES += read_board`；`message-agent-tool.ts` 新参数（裁剪后：`to`/`kind`/`replyTo`/`topic`/`evidence`，`audience`/`urgent` 已无意义）。
- **/reload 与恢复**：M-7——`openQueries` 必须从 engine 内 `kind==="query"` 未超 TTL 的记录 hydrate，否则迟到 answer 无法命中、push 升级静默退化；M-3 的 audience 缺省规则与系统死信 `discipline:"push"` 盖章（见 §4）；T8 看板 session_start 重建 + /reload 回归。注意 `/reload` 不清 Node 模块缓存，board/router 状态须可从 prefetched 条目完整重建。
- **settings（§7.4 减去裁剪）**：保留 `enabled`(默认 false，唯一全局开关)、`inboxCap: 8`、`rootInboxCap: 12`、`receiverMinIntervalMs: 30000`、`rootMinIntervalMs: 10000`、`dedupeTtlMs: 600000`、`boardCap: 500`、`boardTopicCap: 50`、`boardInjectBudgetChars: 2000`、`reviveOnDirectQuery: true`、`wakeRoot: true`、`autoRevive: true`、`autoReviveMaxPerSession: 10` + legacy 键。已砍：`maxHops`、`boardSenderSharePct`、`relevanceImplicitInterest`、`relevanceMutationPriority`。
- **实施顺序（M1–M6）经 §15.6 修订后**：不再是「M1→M3 先合跑真实任务」，而是**整体搁置、先跑 baseline-experiment 量化**，再决定规模。M1=删 can_message+任意寻址；M2=discipline+摄取预算；M3=board+read_board+重建+注入；M4=query/answer/nack+主会话注册；M5=announce 广播（收益存疑）；M6=auto-revive+board_fallback。
- **测试锚点**：T1–T17 中 T13（mutation 破格 push）**已删**（与 T15 矛盾）、T14（公平份额）随 `boardSenderSharePct` 砍掉而失效；T15（I-W 属性：任意 roster×kind×mutation 下广播 push=0 且 revive=0）与 T16（W2 触发面）、T17（wakeRoot:false 零 turn）是硬锚。
- **§15.7 环境警告（对你的施工直接相关）**：评审期间工作区有 quota 特性的 22 文件 +620 行未提交改动，与 fabric 改动面高度重叠（stack.ts / settings.ts / spawn-service.ts / index.ts / tests/integration/fabric-wiring.test.ts）⇒ **不得并行开发**，须等 quota 落地后 rebase 或将这些文件列为冻结面；§1 核实表的**行号锚点已观察到 30–55 行漂移**，复活方案时必须改为符号锚点（函数/常量/类型名）。
- **不可信输入边界（§15.4 攻击结论，未给出处置、需你补设计）**：删 can_message 后任意深度、正在处理 web 内容的 agent 都能唤醒持有全部工具的 root（暴露面远大于 v1 的「仅 root 直属子 run」）；看板经启动注入进入后续每个 agent 的 prompt，构成**持久化 prompt 注入**（类存储型 XSS），围栏标签只能降险不能消除；消息放大四闸中 hop 是死代码、digest 只拦逐字、revive 链只受会话级 10 次上限。
- **workflow / label 路由**：方案里**没有**针对 `SubagentWorkflow` 的专门决策；label 相关只有「revive 不 repoint label（需第三态 `"keep"`）」和 mention 退化为寻址语法糖。这两块没有更多拍板内容，不要臆造。

---

## 10. 明确否决 / 已撤销的备选（不要再提）

1. **阻塞式 `consult_agent`**（初稿前身）——slot 死锁/resumeLocks 互等，整体改写为非阻塞织网。
2. **发送权限白名单**（`can_message` 任何形态的保留/增强）——D-2 删除；「谁能给谁发」类约束整体让位于接收侧预算。
3. **广播 N 路 fan-out**——D-5 恒 1 条 board 记录。
4. **超限拒收/报错**——D-6 只降级。
5. **失效预警「破格 push」**（v1.1 的 mutation push / T13）——v1.2 撤销，M-4/M7 定论连 `mutation` 字段一起砍。
6. **「广播破格唤醒」作为 R-W 的缓解**——§13 明文「不接受」。
7. **G1 的三个选项**（query 默认 notify + urgent / 一律 push / 严格 notify）——前提（push 打断一轮）被 §15.1 推翻，**整个闸门关闭**，`urgent` 取消，D-1 由 D-1′ 取代。
8. **`pending→delivered` 转移表增量及其 8 处 fixture 改动**——M3 处置后全部可省；「notify/pull 走 claim/token 协议保表不变」的备选也不采用（仪式性开销）。
9. **roster selector、hop/maxHops、L2 三来源与隐式兴趣域、scope.symbols、boardSenderSharePct、answered supersede**——§15.5 裁剪清单，全部砍掉（R1–R3 仍满足）。
10. **只读 consult 会话**（SessionSpec noTools 方向）——§1 表注明不做。
11. **「知识交接包（L1）」独立机制**——被看板吸收（v1 修订记录）。
12. **「先修文重写方案再实施」**——被否；拍板路线是先跑 baseline-experiment 量化收益。

最后一个提醒：以上「§15 之后的口径」也有两处**未闭环**的点需要你施工前找需求方确认——① root 前台盲区的两个处置选项（限 background / tool update）二选一；② `digest`、`freshness`、`scope.files`、`audience` 是否保留（最小集未列，裁剪清单也未点名）。其余我按文档最终结论如实交接，没有读到的不做推测。[subagent label: "请教-fabric-v2-设计决策" · run_id: r_3E0QRGPQ · status: completed] — 用户可 @请教-fabric-v2-设计决策 直接向它发消息
