# #39 三层记忆 · 实施计划 r1

> 状态：**Sonnet r_8F69X5TN conditional pass（无 Blocker），用户实施确认已通过；四条件已文档收口，待 Root 人工核对；本次未写实现**。Plan 模型按用户指定为 `localcodex/gpt-6-astra`。
> 架构基线：[arch.md](./arch.md) r3；本轮机械落实其中 Q1/Q2/Q3，并按用户追加批准纠正 SDK 1.5 的 conversation 缓冲边界。原 review3 已收敛，不再重开架构语义。P0 的能力门必须先行，不能以本计划代替生产验收。
> 本轮写域仅本文件、arch 的产品值/已批准单点缓冲事实修正和 own `/tmp`；49 UI frozen、58 UI/native 及其他在飞包不触碰。Root 已完成本次文档写域与 58-P3a 三 paths 的 conflict-check；**不代表未来实现写域已通过检查**。

## 0. 一页用户摘要

- **本轮交付完整三层**：session 保存会话约定；project 保持现有项目记忆；hub 保存同一 Hub 跨项目共享内容。普通 new 为空，resume 恢复原会话；fork/child 在分叉/受理时冻结继承，然后各自独立。
- **容量已定**：session 48 条 / 正文总 8 KiB，hub 32 条 / 4 KiB；单条正文 1024 B。Hub 自动全量注入。满了拒写，不截断，不自动淘汰/提升。
- **全局写入必须真人确认具体内容**：主 agent 请求后，TUI 或 Web 宿主对话框展示冻结原文与完整操作摘要；拒绝项第一。只有受信渠道的明确动作才能生成一次性 OpCap。缺渠道、来源未知、超时、取消、迟到答案都拒写。首次上线同时支持 TUI + Web。
- **子与 secure**：子只能写自己的 session agent 条目，不能伪造/改继承的 user 条目；project/hub 内容硬只读，旧 `allowWriteInChildSessions=true` 无效。secure/locked 强关 hub；session/project 沿既有加密路径，不造明文 sidecar。
- **兼容与回滚**：两个新 flags ~~默认 off~~ **产品默认开启（2026-11-08 用户裁定，见 arch.md §10 Q5；历史「默认 off」为 2026-11-07 设计裁定，已被覆盖）**；现有 files/tiered、Jev、#36 默认与数据不动。回滚：显式 false/false + 按现有重载流程生效，保留存储、不删除数据。本轮不实际启用、不迁移、不调用付费分类器。
- **落地顺序**：P0 真 SDK 能力与接口冻结 → session → seed 与 hub/auth 并行 →统一权限/装配 → 全链验收。共 6 包，独立异源 verifier；只有 Root/指定一名 gate 执行者跑全量。
- **技术未知不再抛产品选择**：生产 input 入口顺序/queued proof、首次落盘失败恢复、浏览器/TUI 全文确认属于 P0 硬门。局部 own/tmp 真 SDK 探针已成功证明正常即时派发可行，但**不等于生产 P0 已完成**。无新增产品问题。

### 0.1 Sonnet 条件闭合表（r_8F69X5TN）

| 条件                   | 本次处置                                                                                                                                  | 落点 / 证据                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1 idle 与范围          | P0 单 owner 冻结 `agent_settled` + 公开 `ctx.isIdle()` / `ctx.hasPendingMessages()` 的宿主准入；首期**不采用**任何新增 held/idle 重派队列 | §3.2；`src/goal/hook.ts:426-446`、`src/index.ts:716-730`；SDK types `:254-263,819-824` |
| 2 忙碌 Web 可见错误    | native queued hub 写请求确定性 `E_HUB_NEEDS_HUMAN_TURN`，零写/零自动重送，明确提示 idle 后新请求                                          | §5.1 单独验收行、A07                                                                   |
| 3 entry id/fromLeaf    | C5 从真实 createAgentSession 的 branch/leaf 采样并验证候选正则，不能以 sid 字符集代替 entry id 契约；不符先报 Root                        | §3.1 C5、arch §6.2/6.6                                                                 |
| 4 authorize 唯一 owner | P0 冻结 types；P1 独占 authorize.ts 与通用 op-cap.ts 实现/测试；P3 仅消费/注入 port 与 hub 提交复核                                       | §4 包表与热点；arch §9.1                                                               |

文档闭合不表示生产 P0 已过；不再开新架构评审，交 Root 核对后按原六包 DAG 施工。

## 1. 范围、容量与兼容基线

### 1.1 不变的用户语义

沿用 arch §1/§5：显式 human-global；宿主精确内容 OpCap；authority-first 去重；每操作一次 append（每第 32 次改为含 cause 的完整 snap）；独立 memorySeed、逐次 workflow agent() 捕获、显式 empty、深冻结与两层 FIFO；secure 最后 await 后复核；坏 snapshot 整条拒收并 visible warnings。Jev 子会话只允许既有召回冷却戳/diag 派生行为，不扩展自动打标、内容写或 promotion。

#36 G1/G2 未过：禁止翻 `memory.layout` blocks 默认、真实迁移、真实 PG 数据修补、自动 paid 分类器。旧 block `scope:global` 是**项目内常驻**，与新 `StorageScope:"hub"` 完全不同，不改其语义。

### 1.2 已定容量（只约束新 session/hub，不改 project）

| 预算                      | session |                        hub | 校验依据              |
| ------------------------- | ------: | -------------------------: | --------------------- |
| 活跃项数                  |      48 |                         32 | 全量有效状态          |
| 单条 raw 正文             |  1024 B |                     1024 B | UTF-8 原文            |
| 活跃 raw 正文总和         |  8192 B |                     4096 B | UTF-8 求和            |
| 单个 put/del DTO cap      |  8704 B |                     8704 B | `6*1024 + 512 + 2048` |
| snap/seed/capture DTO cap | 75776 B | 43008 B（对应 corpus DTO） | `6*B + N*512 + 2048`  |
| 最终 render cap           | 63488 B |                    34816 B | `2048 + 6*B + N*256`  |

`META_MAX=512`、`ENVELOPE_MAX=2048` 不翻倍；历史 fold 64 项、每项 raw 1024 B、总 raw 65536 B，历史 DTO 428032 B、render 411648 B 不变。JSON 上界系数 6 只是保守界，**先 shape 验证，重建纯 DTO，再实际 `Buffer.byteLength(JSON.stringify(dto),'utf8')`**；每个 append、snap、capture wrapper、seed 和 driver 最终 seed snap 都检查。NUL、反斜杠、引号、CJK、emoji 的 raw/render/JSON 不混算。参数 getter/toJSON/循环/额外字段拒绝，坏 snap 不部分采纳。

Hub 每次 agent start 自动全量快照；stable 模式仍沿现有尾更新限额（≤3 块/32 KiB，超限 pointer，下次快照刷新），不能把它偷偷改成“产品索引模式”。34 KiB 最坏 Hub render 大于 32 KiB 尾限额时，按已有 pointer 语义提示 `view`；首轮快照/下次刷新全量、不截正文。

### 1.3 设置、schema 与存储对照

| 面                                            | 新增 / 保留                                                                                | 兼容要求                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `memory.scopes.session` / `memory.scopes.hub` | boolean，~~默认 false~~**默认 true（2026-11-08 用户裁定）**，非 live，依附 memory.enabled  | off 不注册新工具/section/hook/port、不解析槽位；D8 覆盖 hub=false，接线再验 plain                 |
| `scoped_memory`                               | 新独立工具；`storageScope`、`command`、`id/text/rev/topic/from/authority`                  | 主 enum 只含开启层；子只含 session；不更改旧 memory 三套 schema；机制写工具描述，策略仅仓库 skill |
| customType                                    | 新 `subagent:memory-session`，v1 put/del/snap + cause/inherit                              | 旧扩展忽略未知 entry；不直接成为模型 context；通过 section 注入                                   |
| session 文件                                  | 现有 SessionManager JSONL，或 inMemory                                                     | 无新 plain 文件；fork 保持 data、owner sid 可分辨；new 不读取父                                   |
| project 文件                                  | 原 `<memoryRoot>/<slug>` files/tiered/blocks（依原设置）                                   | 不迁移、不改默认、不套用新容量、不改 Jev authority 语义                                           |
| hub 文件                                      | `<effectiveStateDir>/hub-memory/{namespace.json,blocks/,.layout.json,.trash/,audit.jsonl}` | 只在新根首次授权写时初始化；无既有项目导入/迁移；namespace 失败惰化；清理仅已知文件、不误删 store |
| BlockMeta                                     | 仅追加可选 grant/src，用于 hub                                                             | 旧文件字节/ORDER 已有键不变；项目 store 不因此换布局                                              |
| core/spawn/workflow                           | 可选 memorySeed，empty/captured；私有 capture ports                                        | 不进公共 Agent 参数、worker opts、journal/hash 或外部 provider；显式剥除外部伪造                  |
| RemoteOutcome                                 | 可选 originKind，agent 本地追加                                                            | 缺字段不授权；无新 wire/protocol cap/PROTO bump                                                   |
| registry/section                              | 两个新 section 注册，沿现有 lifecycle                                                      | off trace 原样；新 on 测试申报追加，既有 golden 不重生                                            |

## 2. 已取得证据：设计 probe ≠ 生产 P0

### 2.1 可复跑 own/tmp 探针

脚本 `/tmp/task39-plan-probe/probe.mts`；结果 `/tmp/task39-plan-probe/result.json`；stderr 同目录。安装 SDK 实测为 **1.5.0**。用真实 `createAgentSession`、ExtensionAPI、SessionManager、生产 `createDialogBridge`；provider 是纯进程内 scripted runtime，transport 是本地直接调用。无网络 listener、真实模型/凭证/用户 session；cwd/agentDir/HOME 均 own/tmp，loader 禁用用户 extensions/skills/context discovery，tools=[]。

```sh
HOME=/tmp/task39-plan-probe/home \
PI_CODING_AGENT_DIR=/tmp/task39-plan-probe/agent \
timeout 45s node --import /home/bluecake/ai/pi-toolkit/node_modules/tsx/dist/loader.mjs \
  /tmp/task39-plan-probe/probe.mts
```

| 已实际断言                                                                                        | 结论与边界                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 真实扩展 `pi.sendUserMessage` → 首个 input 同步认领 → 后续 async input await → before_agent_start | ALS 正常链保留 cmdId，token 一次消费；InputEvent 自身没有 cmdId。只证明受控第一 ingress 的局部能力                                |
| 旧文本再次由无 scope extension 输入；同 token 重放                                                | 两者都没有 eligible human proof，不用文本 claim                                                                                   |
| 真实运行中排队 followUp                                                                           | 入队前 input 含 streamingBehavior=followUp；实际 queue drain **不再 emit input**。入队 proof 不足以授权消费回合                   |
| 本地持有 cmdId/owner/sid 后 idle 重新 send（能力实验，不是普通 Web 队列改造）                     | 新 generation 可以正向关联；只是 fake-local held bridge，不是生产 hold/recall 集成                                                |
| custom-only append、首次 user、EISDIR 追加失败                                                    | custom-only 尚无 session 文件；首次 **user** 即落盘；已 flushed 文件追加遇实际 EISDIR 时 branch/leaf 回滚                         |
| synthetic appendCompaction + 真 createBranchedSession/open                                        | getBranch 仍含 custom data；fork 新 sid 且数据保留。未跑真实 compact 模型摘要                                                     |
| provider context                                                                                  | custom memory sentinel 与 cmdId 不混入 provider messages                                                                          |
| 生产 dialog bridge                                                                                | 不同 nonce/toolCallId 的 open 得到不同 dialogId；错 epoch/错选项/关闭后迟到拒绝；当前 outcome **没有 originKind**，新增工作仍未做 |

**已同步 arch 的 SDK 事实纠正（用户追加批准）**：安装 SDK `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:786-794` 的 `_hasConversation()` 接受 user **或** assistant；`:795-815` 在无 conversation 时不 flush，首次形成 conversation 即开始落盘；`:816-831` 是单次 append 抛错后内存 branch/leaf 回滚。实测首个 user 即落盘，append 成功仅表示 `appended`，不等于 `persisted/fsync`。partial-write、首次 flush 中途失败与 torn-tail 恢复仍未测，P0 必测，不从 EISDIR 推导磁盘事务原子性。

桥的 id 不是独立随机生成：`src/web-hub/agent/dialogs.ts:301` 使用 `ask:${request.toolCallId}`。因此 host 必须为每次确认生成并登记全新 nonce（含 activation/owner 绑定），不得复用 toolCallId；P0 增加重复 nonce/旧 epoch/旧回调测试。上述两次 open 探针只证明**不同 nonce**的寻址隔离，不声称桥能安全处理重复 nonce。

### 2.2 关键源码坐标（复用 r3，不全库重研）

| 文件                                                        | 坐标 / 事实                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/agent/index.ts`                                | 610–618：launchHome/paths 优先序；2417–2424 同文本 attributeInput 不作授权                                          |
| `src/web-hub/agent/commands.ts`                             | 595–605、660–700 真实派发持有 frame.id/origin/session；1204–1211 noteWebProof 是 advisory，不复用                   |
| `src/web-hub/agent/ledger.ts`                               | 55–75 owner/session；333–350 同文本候选，不是当前输入关联                                                           |
| SDK `extensions/types.d.ts` / `runner.js`                   | 929–943 / 1201–1234：InputEvent 无 cmdId，handlers 顺序 await                                                       |
| SDK `agent-session.js`                                      | 1649–1705 input-before-queue/settled deferral；1928–1955 sendUserMessage→extension；2792–2800 bridge 不返回 promise |
| SDK `session-manager.js`                                    | 786–815 conversation/flush；816–831 单次内存回滚；1217 起 fork 保留 data                                            |
| `src/ask-user/remote.ts` / `src/web-hub/agent/dialogs.ts`   | 端口全文 / 235–262、300–349：唯一 id、epoch/选项验证、结构 origin 目前被压成 string                                 |
| `src/workflow/host.ts` / `tests/workflow/host-fast.test.ts` | arch §6.3 的逐 agent 捕获位置 / 131–185 起 immutable 与 FIFO 先例；不复用 Fast 字段/hash                            |
| `src/secure/memory-gate.ts`                                 | 9–55：实时 mount、identity、write-zone 先例；新 session 门须同口径                                                  |

## 3. P0：先证明、再冻结共享契约

### 3.1 硬门（未全部完成）

P0 owner 把临时探针转为隔离测试，使用真实公开 SDK + fake-local runtime。以下**能力前提**全绿才冻结生产接口；使用可执行最小本地接缝证明，不要求在 P0 先实现 P1–P4 全功能。C2/C3 必须在与现有注册顺序等价的真实 SDK fixture 中证实所需 ingress/start 信号；C4 证明现有桥能携带结构来源并准确绑定冻结 nonce；C5 用纯 fixture 验证解析/预算契约，另必须用真实 createAgentSession 取得 entry id/fromLeaf 样本验证，不只造字符串。对应生产集成断言在 P3/P4/P5 再跑，不能拿 fixture 替代。失败定位 blocking interface 回 Root，不能先铺后续“已可行”实现。

| 门                     | 必须断言                                                                                                                                                                                                                                                                                | 本轮状态                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C0 session persistence | custom-only buffered、first-user flush、单次失败内存回滚、首次 flush/partial tail/重载边界；不承诺 fsync/崩溃事务                                                                                                                                                                       | 局部通过，异常矩阵待测                                                 |
| C1 branch/context      | 真 compact 流程用 fake summarizer；fork/new/resume/tree；custom 不进 context；provider 注入与 secure 空读                                                                                                                                                                               | synthetic compact/fork/context 局部通过                                |
| C2 dispatch proof      | 真实装配顺序、早期 async/transform/handled/nested、相同文本并发、抛错、错误 owner/sid/generation、reload/abort、新输入撤销；token 单消费                                                                                                                                                | 正常即时链通过，生产顺序未测                                           |
| C3 queued proof        | native steer/followUp 不给旧 run 授权；入队与实际处理区分；确定性 E_HUB_NEEDS_HUMAN_TURN；普通 prompt 投递语义不变；首期不新增 held/重派；settled 延后无 proof 拒绝                                                                                                                     | native followUp 不足已证实；临时 idle 重派仅能力实验，不采用为首期实现 |
| C4 approval            | remote nonce/full opDigest/owner/branch/source；TUI/Web 先胜、拒绝第一；no channel/old hub/Feishu/迟到都无写；全文可见                                                                                                                                                                  | 现有桥 id/epoch/选项通过；新增字段与真实 UI 未测                       |
| C5 slot/budgets        | effective paths 同源矩阵；所有字段 shape 与最终 JSON cap；off 依赖注入为 absent；真实 createAgentSession 产生的 branch entry.id/getLeafId() 作为 fromLeaf 样本，验证候选正则与长度，含普通消息/custom/compaction/fork；不直接套 sid 字符集，不符先报 Root 冻结 type，禁放宽为路径字符串 | 待实现测试                                                             |

### 3.2 可信派发与排队的具体契约

**新增本地 port，不是 SDK 字段**：activation 私有 `HumanDispatchProofPort`，实现持有 `AsyncLocalStorage`，不使用 module mutable/global park。仅可信 web command 实际派发点可创建 `DispatchTicket {cmdId, owner, sid, branchGen, dispatchGeneration, originKind}`；所有成员由宿主获取，token 不可进入工具参数、prompt、wire、日志、journal。

- **唯一 idle 准入机制（P0 冻结，P1/P3 不各猜）**：沿用仓库 `/goal` 的 `agent_settled` loop hook 机制（`src/goal/hook.ts:426-446`，注册 `src/index.ts:716-730`）；公开 SDK `ExtensionContext.isIdle(): boolean` 与 `hasPendingMessages(): boolean` 在 `extensions/types.d.ts:254-263`，`AgentSettledEvent` 的“无 retry/compaction/queued continuation”契约在 `:819-824`。activation-local gate 在 session_start 为新 owner 初始化、agent_start/新输入/切换/abort 时失效，agent_settled 仅记录已 settle 状态；普通初始 idle session 不要求虚构一个先前 settled 事件。可信正常 Web dispatch **当场同步**复核 owner/epoch、`ctx.isIdle()===true && ctx.hasPendingMessages()===false` 和当前 gate 状态，再进入 scope/send，中间不 await。方法缺失/抛错/状态未知拒绝记忆授权准入，但不拦普通 prompt 投递。hook 本身不自动发送/重派消息；不把单独 isIdle（仅 not streaming）或 settled 记录当作来源 proof。P0 必须测其他 loop/续跑竞争与 settled 延后路径，正常 idle 正向必须过，无法证明路径 fail closed。
- `runDispatch(ticket, send)` 在真实 `sendUserMessage` 周围建立 scope。**最早的可信 ingress**（secure guard 之后、可重入/转换 handler 之前）同步 consume；后续 await 只携带已认领的私有 candidate。handled/throw/生命周期变化则销毁；不是给任意后代异步 input 继承一次授权机会。
- 只在该次 dispatch 确认进入对应 idle run 后激活 `humanTurnId`；`input` 只认领 candidate，不凭模型文本设权限。P0 验证 `before_agent_start` 的同 scope/owner，或等价明确宿主回执；禁止退成同文本 `message_start`。未证实 start、被拦截/失败就无回合 grant。
- **native queued steer/followUp**：input 是 enqueue-time 不是 consume-time，故不激活 authorization turn，也不保留一个“下次任意输入可领”的 token。**普通 Web prompt 的 steer/followUp/忙碌投递语义逐项保持原样**，绝不为制造 proof 把它们改成等待 idle 重派。无法从该 native 队列证明来源时，只拒绝该次 hub/user-authority 授权发起；用户可以通过新的明确 Web 授权动作（或 idle 时新的 Web 请求）重新建立可信来源。此限制不是全 Web 不可用。
- **Root 首期范围裁定：不采用新增 held adapter / PendingHumanDispatchCap / idle 重派队列**，也不实现专用延后授权模式（用户未要求）。此前 own/tmp held/idle 重派只是能力实验；可选专用接缝留作未来设计，**不进入本期 P0 接口或 P1/P3 写域**。现有普通 Web hold/steer/followUp 行为不变，不能把 native queued 复制到另一个队列；writer 无权自行引入“为了 proof 等 idle 重发”。
- 本轮首期验收必须存在正向 **idle Web → input proof → agent 请求 → Web 确认 → 写入**，不能以“native queued fail closed”为由让所有 Web 不可用。首期仅支持可证明的正常 idle Web 授权；不新增通用 Web 投递模式/wire/held 接缝。native queued proof 仍标不支持，不能因 idle 成功就宣称两条路径全闭合；生产实现不可闭合时停在 P0 报 Root，不发明公开 API。
- 普通 TUI interactive 与 Web 回合只是弹框前置；真正的 `PrivateOpCap` 仍在冻结 op/target/rev/text 的 **真人 exact-content confirmation 后**铸造。natural-language classifier 不参与授权。

### 3.3 P0 单 owner 冻结的端口/类型

| 契约                                                 | 关键输入输出                                         | 归属与禁止                                                               |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `MemoryParentPort.snapshot(parentRunId?)`            | 同步返回 frozen empty/captured                       | 当前父 session，不查全局 active stack；宿主只读                          |
| `MemoryWorkflowPort.capture()`                       | 每次 agent() 受理冻结                                | 本地 FIFO 之前，不进 worker/journal/hash                                 |
| `SessionWriteGate.check({sessionFile?,sessionDir?})` | 同步 ok/reason                                       | runtime 最后 await 后；locked 先拒绝                                     |
| `EffectiveHubSlotPort`                               | 同次有效解析的 stateDir/uid；明确 default-slot       | WebHub paths override 与 memory 同源；不能二次猜 HOME                    |
| `HumanDispatchProofPort`                             | dispatch scope、ingress claim、start confirm、revoke | activation 私有；SDK event 无新字段；native queue 不伪装确认             |
| `ApprovalPort`                                       | 冻结操作 + owner/turn → 私有 minted cap 或明确拒绝   | requestOpApproval 复用 AskUserRemotePort，不另造 RemoteQuestionPort/wire |
| `MemoryScopesReadPort` / `SessionMemoryPort`         | fold/view/render/snapshot/queued op                  | P1 导出稳定接口，P2/P3/P4 不跨模块碰内部缓存                             |
| `RemoteOutcome.originKind?`                          | loopback/lan/feishu，缺省 unknown                    | 从 CmdOrigin 结构派生；字符串不可证明                                    |

`StorageScope`、seed DTO、constants、typed errors、approval input 在 `src/memory/scopes/types.ts` 单源；core 仅 type import/re-export/可选字段，不反向 import pi。cap 私有内部结构不暴露为 schema。取消/timeout 统一 clampSpanMs + unref，所有 port teardown 生命周期按 owner 撤销。

## 4. 六个实施包与真实 DAG

**施工前置**：用户确认已通过、Sonnet conditional pass 无 Blocker；Root 人工核对本次四条件闭合后放行原包序。本表是未来写域，当前未写这些文件。每包开工先读 AGENTS 对应 README。P0 owner 掌管共享 contracts；之后变更由 Root 收口，不允许并行 writer 顺手改它们。

| 包 / owner                                    | 输出、明确 source 写域                                                                                                                                                                                                                                                                                                                | test 写域 / 完成门                                                                                                                                                                           | 依赖                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P0 能力与 contracts（单 owner）               | 先能力门，后冻结 `src/memory/scopes/types.ts`、`src/memory/{settings,setting-specs}.ts`、`src/config/settings.ts`、`src/core/types.ts`、`src/ask-user/remote.ts` 的追加类型；flags/D8/schema 单 owner                                                                                                                                 | 新 `tests/conformance/memory-scopes-sdk.test.ts`、`memory-scopes-input.test.ts`；新 `tests/memory/scopes/contracts.test.ts`、配置/D8对应定向测试；C0–C5 未证实部分有阻塞判据，不能签空白接口 | 人类/评审双批准                             |
| P1 session 内核与注入 provider                | 新 `scopes/{limits,session-fold,session-ops,session-store,render,session-section,op-cap,authorize}.ts`；`src/secure/memory-gate.ts` 新 session gate；纯 provider factory，不碰 index/stack；独占通用 OpCap 状态机与 TUI/Web authorize，实现时来源/remote port 可 mock，生产接线后再验                                                 | 新 `tests/memory/scopes/{limits,session-fold,session-ops,session-section,op-cap,authorize}.test.ts`、`tests/secure/memory-session-gate.test.ts`（fake mountinfo/own tmp，无真实 mount）      | P0 冻结                                     |
| P2 独立 seed 管线                             | `src/service/{spawn-service,runtime-adapter,request-threading}.ts`、`src/runtime/session-driver.ts`、`src/workflow/{host,spawner-adapter}.ts`；不改 core/types/stack                                                                                                                                                                  | 新 `tests/service/memory-seed.test.ts`、`tests/workflow/host-memory.test.ts`、`tests/integration/memory-scopes-seed.test.ts`；真实 FIFO/empty/deepfreeze/失败拒创建                          | P1 read/capture 接口完成                    |
| P3 hub + host authorization                   | 新 `scopes/{hub-slot,hub-store,hub-section}.ts`；`src/memory/blocks/format.ts`；`src/web-hub/agent/{index,commands,ledger,dialogs}.ts` 与新 `human-dispatch-proof.ts`、`effective-paths.ts`（纯 local resolve）；只消费/注入 P1 ApprovalPort/OpCap，不重写 authorize/op-cap；不改 src/index/stack、protocol wire/UI                   | 新 `tests/memory/scopes/{hub-slot,hub-store,hub-commit-approval}.test.ts`；`tests/web-hub/agent/memory-{proof,approval,paths}.test.ts`；新 `tests/integration/memory-scopes-hub.test.ts`     | P1 limits/render + P0 contracts；与 P2 并行 |
| P4 工具/命令/权限与唯一装配                   | 新 `scopes/{tool,command,wire}.ts`；`src/memory/{index,command,doctor,tool,tool-v2,tool-v3}.ts`（后三者仅确有必要的硬门适配，优先 effectiveSettings）；`src/index.ts`、`src/stack.ts`；`src/web-hub/agent/command-policy.ts` 仅 scopes-on 新只读子命令策略（off 不变）；`tests/tiers.ts`、boundary/registration trace gate 的唯一收口 | 新 `tests/memory/scopes/{tool,command,child-readonly,wire}.test.ts`；`tests/integration/memory-scopes-{assembly,secure-off,authorization}.test.ts`；旧三套工具/命令/Jev golden 定向回归      | P2 + P3 全部完成                            |
| P5 集成验收/文档（Root 指定 sole gate owner） | `docs/dev/{memory,data-encryption,web-hub}/README.md` 必要不变式，`skills/memory-jev/SKILL.md` 单副本，本 feature 验收记录；必要 AGENTS I11 仅 Root 决定收口，不扩大设计正文                                                                                                                                                          | 新 `tests/integration/memory-scopes-e2e.test.ts`、隔离 browser fixture / TUI harness；现有 conformance/boundary/governance；所有修复回原包 owner，不让验收者重写生产                         | P4 完成 + 每包 verifier 已通过              |

DAG：`批准 → P0 → P1 → (P2 ∥ P3) → P4 → P5`。P0 冻结后 P3 的 host/UI fixture 可以用 mock ApprovalPort 做**只读设计/测试准备**，不提前并发修改 P0 文件；不把此准备伪称 P3 backend 已完成。无需新产品 UI；复用现有 dialogs。若真实 browser fixture 暴露必须改 49/58 frozen UI 的问题，先报 Root 解冻/协调，不能擅改。

### 4.1 热点和冲突纪律

- P4 必须在 assembly 阶段先构造同一个 activation-local proof port，再把它注入可信 ingress 和晚注册的 WebHub dispatcher；不能因 memory pre-guard / WebHub post-guard 的顺序造两份实例。secure guard 保持第一个，子会话不接 human 授权；index 只调用 factory/透传，不写状态机逻辑。新增 hook 的开启配置 trace 单独验收，off 不注册。
- **authorize/op-cap 单 owner**：P0 仅冻结 `scopes/types.ts` 的输入/端口/私有cap类型边界；P1 唯一写 `src/memory/scopes/authorize.ts` 与 `op-cap.ts`（mint/reserve/consume/revoke、HumanTurnTracker、同步 TUI/Web race）及其单测。P3 只写 hub store 的 CAS/提交复核与 host proof/RemoteOutcome 结构来源，调用 P1 接口，不复制/修改通用状态机或 authorize。接口缺口回 P0/Root，通用实现缺口回 P1；不允许两个 writer 同文件。
- settings/specs/config/core types/remote interface：P0 唯一 owner；P2/P3 只能消费。后续字段变更回 P0/Root，重新冻结再继续。
- memory index/tools/command、webhub command-policy、src/index、stack：P4 唯一 owner（装配 only），此前包只提供 factories/ports。
- workflow host / driver：P2；webhub agent/index/commands/ledger/dialogs/effective-paths：P3。两包无共享写文件，才允许并行。
- secure gate：P1；protocol messages/schemas/version/paths.ts **本计划冻结只读**（effective-paths 新模块调用已有 paths 纯函数）；若发现必须改 wire，先停工报 Root。
- `blocks/format.ts` 与 #36、webhub agent 与其他任务可能冲突：开包前重新做精确 paths conflict-check，无法确定租约则串行；Root 的“文档包无交集”不替代此检查。
- 每包返回立即异源 verifier（不是开发模型，按 dev-flow；Plan 后 Sonnet 审查由 Root 派）。writer 只跑定向测试；verifier 只跑对应定向/抽查。**仅 P5 指定一人**跑 tier1/tier2/全量门，禁止多个 agent 同时 npm test。

## 5. 按用户可见行为验收

### 5.1 工具与命令

`scoped_memory`：create/update/delete/view；update/delete 必须 rev；session authority 缺省 agent，主请求 user 需单独精确确认；子 authority 参数拒绝，且继承 user 项不可改/删。hub 只有主会话、恒 user，由 grant 推导。枚举/错误/参数含义写进 tool description，非工具策略只写现有仓库 skill，绝不复制到 `~/.agents/skills`。

| 操作                                                          | 可见行为                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧 `/mem path`、`/mem list`、无参 `/mem`                      | 保持 project 语义与 off 字节；不静默把旧命令解释为 hub                                                                                                                                                                                                            |
| 新 `/mem session path\|list\|status`                          | path 为当前 session 文件或 `memory-only`；list 明示 authority、继承来源、rev；status 为 item/raw 使用量、dropped、append 状态（不泄漏内容）                                                                                                                       |
| 新 `/mem hub path\|list\|show <id>\|status`                   | 有效槽位（不从 memoryRoot 推算）、namespace 正常/惰化/disabled、容量与来源；读取不创建目录                                                                                                                                                                        |
| `/mem session add <text>`、`/mem hub add\|rm\|restore\|adopt` | 沿 arch TUI 人类命令权限；Web 走 agent 请求 + remote exact-content approval；子/非可信命令拒绝                                                                                                                                                                    |
| 显式 promote                                                  | 只是带 from 的 hub create，完整授权，原条目不变；没有自动 promotion                                                                                                                                                                                               |
| 忙碌期间 Web steer/followUp 引出的本次 hub 写请求             | **必然返回 `E_HUB_NEEDS_HUMAN_TURN`**（首期无 consume-source proof，不是 flaky）；未写入、不弹授权框。提示：“此请求来自忙碌期间的 Web 队列，无法证明当前授权来源；请在会话 idle 后发起新的请求/明确授权动作。”不自动 duplicate/重送原 prompt，不改变普通 Web 投递 |
| `E_HUB_NEEDS_HUMAN_TURN` / `E_HUB_CONFIRM_UNAVAILABLE`        | 说明当前来源/渠道无法证明，未写；Web 原生排队路径提示 idle 重发；不建议传 `authorized:true` 绕过                                                                                                                                                                  |
| 拒绝/超时/旧答案                                              | `E_HUB_DECLINED` / stale，未写；不自动降为 agent，不暗中重试                                                                                                                                                                                                      |
| 满容量/超字节                                                 | `E_FULL` / `E_TOO_LARGE`，给当前计数与限额，旧状态不变，不截断正文                                                                                                                                                                                                |
| namespace 不符 / 锁忙 / CAS 冲突                              | 显式 inert / busy / conflict；不自动 adopt/迁移/覆盖                                                                                                                                                                                                              |
| session append                                                | 无 sessionFile：memory-only；成功：appended（SDK 可缓冲，不承诺 fsync）；确定抛错：E_PERSIST；效果未能核对：E_PERSIST_UNKNOWN，不自动重试                                                                                                                         |
| 坏 snapshot                                                   | 整条拒收；section dropped 标记、主会话通知、doctor H05 id/reason，不把正文写日志                                                                                                                                                                                  |

### 5.2 分层注入与权限

- session/hub 通过已有 PromptSectionHub 注册，不另造动态 system prompt 通路；project section 保持原路径；authority-first 然后具体性去重，低权威 session 副本不能遮蔽 hub user。
- 生命周期：每次 agent start 重快照；run 内 compact 后本轮快照仍可旧，view 即时为准；switch_context 续跑/下次 start 刷新。new 空、resume 同 sid、fork/child 独立冻结副本。
- 子内容门覆盖 legacy/v2/v3、所有 `/mem` 写子命令、blocks/internal writeGate 与未来 write-port；scopes 任一 on 时旧 allow=true 无效。子自己的 session agent 写另走 session gate；不是把 session 也全部锁死。
- LOCKED provider **先检查再读**，getBranch/readCorpus/slot resolve 调用计数均为 0。secure hub 无端口/目录/section；session/seed 最后 await 后实时 mount + owner/file/epoch/signal 复核，不因先前 guard 已过而省略。

## 6. 验收矩阵与执行纪律

| ID  | 验收组        | 真实行为断言 / 证据层                                                                                                                                                                                                                                    | 包                   |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A01 | off / schema  | 两 flags off：零新 hook/tool/port/section/slot IO；files/tiered/Jev 与原 golden 字节相同；旧 memory schema 未变                                                                                                                                          | P0/P4                |
| A02 | 容量          | 48/32 与 raw sum、单条1024；JSON/render 边界±1；满字段与控制字符；getter/toJSON 不执行；第32 snap/driver seed 最终 DTO 再验                                                                                                                              | P1/P3                |
| A03 | 状态机        | put/del/snap 参考模型性质；每操作恰好一次 append；坏 snap 整拒；user 优先级与去重                                                                                                                                                                        | P1                   |
| A04 | SDK lifecycle | 真 SDK new/resume/fork/tree/compact/switch_context；实际 provider context 断言；成功/确定失败/unknown、无 fsync 承诺                                                                                                                                     | P0/P5                |
| A05 | seed          | 主队列与 workflow FIFO 真实受理顺序；捕获后父变不改已排队；两次 agent() 可获不同快照；empty 不回源、全嵌套深冻；外部剥除、resume不种、append失败不创建                                                                                                   | P2                   |
| A06 | hub identity  | launchHome/paths/HOME/agentDir/ARMORY_MEMORY_ROOT enabled/off/sandbox 组合；同 effective 同根；不同 override 不合并；uid/real/dev/ino/host 不符 inert；no cleanup deletion                                                                               | P3                   |
| A07 | host proof    | old observed web + xs/wake 同文本不能 claim；owner/session/generation 一次性；handled/nested/并发/settled；native queue 不授权且普通 steer/followUp/忙碌投递完全不变；本期无新增held；忙碌Web hub写必然E_HUB_NEEDS_HUMAN_TURN且零重送；idle Web 正向成功 | P0/P3/P4             |
| A08 | OpCap         | 全文冻结、完整 opDigest+nonce+rev+branch、TUI/Web 同步 race；拒绝第一；cancel/timeout/oldhub/nochannel/Feishu拒绝；出队/锁内/提交三次复核，审计仅cap字段                                                                                                 | P1/P3                |
| A09 | 子权限        | 三套工具+命令+内部 writeGate，旧 allow=true；session agent允许、继承user拒绝；Jev派生例外无内容改变                                                                                                                                                      | P4                   |
| A10 | secure        | fake mountinfo + temp dirs：实时卸载、换owner、路径越界零append；locked零branch/disk读取；D8无法重开hub；无新明文文件                                                                                                                                    | P1/P4                |
| A11 | 真 UI fixture | 现有 Web dialogs 真实浏览器渲染全文+选项、拒绝/确认实际回执；TUI harness/终端尺寸验证原文可见；不能用 jsdom snapshot 替代真人可读门                                                                                                                      | P5（P0冻结呈现前置） |
| A12 | 边界与兼容    | pi-free、hub/protocol import 边界；old/new hub dialogs无新wire；goldens不重生；新测试 tier 明确登记                                                                                                                                                      | P4/P5                |

**测试分层**：纯单元在 tier1；`tests/conformance/**`、`tests/integration/**` 为 tier2；真实 browser fixture 单独隔离本地服务，不访问用户 hub；secure fake mountinfo 用普通 temp 测试（不调用 gocryptfs）。真正 secure mount conformance 仅列未来授权/独占机器发布门，本轮 **不执行**、不把 fake gate 当加密挂载已通过。模型/分类器全 scripted，不启用 live env，不读取用户 PG/记忆。

定向命令示例（实现后文件存在才执行；本轮不是已通过报告）：

```sh
# writer/verifier：每次只跑自己目录/文件，workers<=2
PI_TOOLKIT_TEST_WORKERS=2 timeout 180s npx --no-install vitest run tests/memory/scopes
PI_TOOLKIT_TEST_WORKERS=2 timeout 180s npx --no-install vitest run tests/conformance/memory-scopes-sdk.test.ts tests/conformance/memory-scopes-input.test.ts
PI_TOOLKIT_TEST_WORKERS=2 timeout 180s npx --no-install vitest run tests/service/memory-seed.test.ts tests/workflow/host-memory.test.ts tests/integration/memory-scopes-seed.test.ts
# P5 sole gate owner：串行执行，真实 secure/live 门不擅自启用
npm run format:check
npm run typecheck
npm run build
PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1
# 先定向 task39 tier2 与其受影响 conformance；全仓 tier2/secure 按既有批准与环境门另排
```

Root 记录 suite/版本/退出码/日志与未测项；修复失败必须重跑对应 gate。tier2 timing 按仓库独立重跑规则，不用 skip 消红；A 级 golden、旧 B 键绝不重生。新工具 surface 可增加新的申报 fixture；activate trace 只在刻意注册变化按既有 gate 操作，不覆盖 default/off 冻结证据。

## 7. 回滚、发布与剩余技术门

- ~~默认 flags off~~ **默认 flags on（2026-11-08 用户裁定，历史「默认 off」裁定保留记录）**，完成实现也不擅自修改实际用户设置或开启全局。当前 project 不迁移。Hub 初始化只能针对新根，不“收编”现有数据。
- 回滚（默认开启后同样适用）：用户/Root 决定显式关 flags（session/hub 均 false），按非 live 设置的正常重载要求生效；custom entries/hub 文件保留，旧扩展忽略；不删除存储、不把关闭等同于擦除敏感历史。
- namespace 损坏/host不符仅惰化 + doctor；adopt 仅显式 TUI 用户动作并验证，无自动修库。Hub stop/restart/token rotation 的清理回归必须证明 store 保留。
- 不 commit/push/release；不安装，不清私有数据，不挂载，不翻 #36 gates。实施完成后的发布另按仓库流程授权。
- **剩余技术门，不是产品 open questions**：生产 proof ingress 排序与 handled/nested 清理；正常 idle 准入与 settled deferral（首期无新 held）；partial-write/首次 flush 异常；完整 op/source UI 绑定和可见性；effective paths 生产透传与 cleanup。P0 证据失败则报告准确接口，调整局部技术实现，不私自放宽权限或重问已定产品语义。

## 附录 · 交接

结构化交接：`/tmp/handoff/task39-memory-scopes-plan.json`，含 fileIndex/evidence/ruledOut/openQuestions、DAG、验收索引、已跑 probe 与未测清单。下游按坐标选择性核验；已排除的文本 proof、FastSeed 复用、HOME 二次推算、raw=JSON、TUI-only 均不重开。

### 2026-11-08 P4c source assembly 交接状态

- Stage A：pi-free child bind + public SDK loader bus barrier，实际 manager/reason/frozen parent slot；
  memory-only internal Runner cancellation（经精确追加的 runtime-adapter 可选 boolean 两缝），不改 #62 budgets。
- Stage B：early unique owner/context/proof/approval/store/command/provider，实际 Stack gate/parent/workflow ports，
  连续 P4a2 projection 与 SOURCE freeze/clear/delete，child project content hardreadonly 和 Web exact policy。
- Gate：仅定向测试、strict noEmit、project typecheck、私有 `/tmp` backend build；最终命令日志及未覆盖项
  由 `/tmp/memory39-p4c-handoff.json` 报告。旧 A/B fixtures 冻结，不 UPDATE_TRACE、不全树 format。
- 不宣称 SDK append=fsync；actual-manager weak poison 和 legacy process-restart 限界见 memory README。
- P5 **未做**：真实原生 viewport/keyboard 与 browser dialogs acceptance，payload 断言不等价于可读屏幕；
  如裁切后续 feature-local scroll adapter，不升级 SDK。无真实资源迁移/paid API/reload/commit/push/release。
