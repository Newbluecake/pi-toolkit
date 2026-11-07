# #61 · Tree fabric 显式阻塞决策唤醒（r2 · 默认开启已定 / 条件评审收口）

## 一页决策摘要

- 目标：普通进度保持低噪音；**确实阻塞且需要 Root 裁定**的 child 请求，有显式身份、去重、关联答复和有限唤醒机会。
- 范围：同一 Root 所属树的 `message_agent`；不是 `message_session` xs、广播、任务恢复器或已完成任务通知。
- 车道：L3 风险面（文件数 2 + 模块边界 1 + 兼容接口 1 + 多取舍 2 + 激活授权 2 = 8）；采用本单份最小设计，不另造调度框架。
- 本次仅文档；方案模型 `localcodex/gpt-6-astra`。Root 已实际确认与 memory39P1/UI60 source 无写冲突；Sonnet `r_NQEPBVQZ` 条件通过，本轮仅收口六项。
- 用户已拍板：`fabric.wake.decisionRequests` **默认 true**，无需另写配置开启；新 variant 的工具 schema 增加 `decision`，Root 的 `steer_subagent` 增加关联答复字段。
- 推荐：普通 causal level 不改；阻塞通道用**每真人输入窗口最多 2 次**的独立 Root 决策预算，不增加 `maxLevel`，不清零 child level。
- 推荐：单 child 一个未决请求；显式关联答复关闭请求；重传复用稳定 ID；已投递正文绝不再投。
- 风险 / 门禁：pi 1.5.0 的 `InputEvent.source` 不是完整真人凭证；先验证可信入口，再开放对应入口的预算 reset。没有证据时只投递、不唤醒。
- 默认开启不再请用户重复确认；真实入口能力仍需 P0 证明，默认 on 不等于凭空获得预算或全渠道可用。
- 下一步：Root 核对六项收口后，按 `P0 → (P1 ∥ P2) → P3` 推进；本轮不改 source/config/README、不 reload、不 commit/push。

## 1. 已知事实与边界

1. 用户提供的实证：`r_YHA4X8JF` seq10 `report+wake:true`，accepted，约 11ms 投递，`wake:false / wakeDowngraded:level_limit`，未产生模型回合；child 与 Root 都 L4，默认 maxLevel=2，perRunQuota=3 未耗尽。本轮不读取用户会话原文重证。
2. 当前可发送 kind 只有 `progress/report/directive`；不存在 `question/urgent/query`。`directive` 仅父→子；`progress` 到 Root 仅展示。
3. `router.ts` 在 Root 显式 wake 准入时检查 sender level；`wake-level.ts` 的 run level 单调上升，真人输入只 reset Root。故 Root 回 L0 不能修复仍活跃 L4 child。
4. `fabric/stack.ts`：wake=false 用 triggerTurn=false；省略 wake 走 legacy steer+triggerTurn=true。**不能把省略 wake 当绕限技巧**。
5. `accepted` 是准入，不是送达，更不是 Root 开始处理；现有 sendRootContext 的成功也仅说明宿主接受注入。
6. #59 空闲 TODO 恢复是独立兜底；本方案不读取 TaskList 推导激活、不借其重置预算、不修改其实现。与 #59 共用原则：只有真实 human ingress 才能重置。
7. 不改 xs pair wake policy，不复活 consult，不创建定时任务，不扫描“请 Root”等自然语言推断意图。

## 2. 三个必要设计选择（均为推荐裁定）

| 选择       | 推荐及理由                                                                         | 排除                                                      |
| ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 显式入口   | feature-on `message_agent.decision` 对象，沿用 kind=report；Root 用关联 steer 回答 | 新 kind、NLP、滥用 directive、所有 report 自动变阻塞      |
| 权限与预算 | 独立 Root 窗口预算 2 + 每 child 每窗口最多 1 次决策激活尝试；普通 level/quota 保留 | maxLevel=5、所有 child reset、无界 level 豁免             |
| 交付与关联 | 稳定 ID + at-most-once 正文 + 显式 decisionReplyTo；未知发送保守消耗               | 任意 steer 等于解决、重复正文求醒、把 accepted 写成已处理 |

### 2.1 schema 与开关

- `fabric.wake.decisionRequests: boolean`：默认 leaf=true，缺省/非法类型回落 true，显式 false 走旧路径；effective= fabric.enabled ∧ wake.enabled ∧ 本开关。不改变 fabric.enabled 原有默认。
- 默认对象/default dump 加该 leaf；parser、SETTING_SPECS、editor default/current round-trip 一致。已有 `tests/config/fabric-wake-settings.test.ts` 的默认对象与 keys 两处 8-leaf pin 合法更新为 9-leaf（不是 golden），valid parse 期望与 editor 枚举也同步覆盖新 leaf。
- 非 live；需装载新 code 后才出现新能力，不替用户 reload/写配置。激活时冻结 schema，host 注入给 child 的 closure 携带开关与 owner；旧活跃工具不热改 schema。
- feature-on 新增 `decision?: { id: string, action?: "request" | "wake" | "status" | "cancel" }`；action 缺省=request。
- id 为调用方为**同一个逻辑问题**选定的稳定 ID（1–64 个 ASCII 字母/数字/`_-`）；宿主真实主键是 `(sessionId, rootOwner, runId, generation, id)`，ID 不是权限凭证。
- request 只允许 `to:"root", kind:"report", wake:true`；text 是阻塞问题与建议默认做法；无 wake 或 false、@label、其他 kind/目标均明确拒绝，不默默走 legacy。
- wake/status/cancel 沿用同一 envelope（to=root/kind=report/text=""）；wake 要求 wake=true，其他操作不得带 wake=true；不产生正文 seq，不占 report 配额。
- Root 增加 `steer_subagent.decisionReplyTo?: string`（只 feature-on），按 run_id 解析到请求所属 child；要求 reply=none，text 必须非空。
- 该字段表示**裁定/拒绝/明确关闭**，不是“我收到”的 ACK；仅收悉可普通 steer，但请求仍未决。普通 steer、web steer、子完成都不隐式假装回答。
- source factory 使用显式 `decisionOn`：旧 `createMessageAgentTool({wakeOn:true})` 未传 decisionOn 仍旧 schema/description/omitted-wake；生产接线才传 effective flag。**新 on-schema** 的普通 report omitted wake 归一 false；普通显式 true/false 执行路径不变，true 仍过原 level/perRunQuota。
- 上述 on-only 默认变化是声明的外观行为变化：防止新通道开启后通过省略 wake 绕限；off/旧 schema 调用仍逐字节兼容。旧 caller 不自动获得新意图能力。
- feature-on steer 的 reply=ack/report 提示明确要求 child `wake:false`，不再承诺报告会唤醒；旧版本 framing 保留。

### 2.2 authority / budget

- 新 `DecisionWakeLedger` 是小型请求账本，不是工作队列。仅宿主登记的**当前 Root 直接 child**可用；nested child 仍按现有父链逐级请示，不扩 can_message。
- 每次检查：当前 sessionId、Root owner incarnation、live generation、树边、sender running、未 abort、Root 未 closing/fenced。readonly/external/no-tool run 不新增授权。
- 真人输入窗口为 `{epoch, humanInputId, used<=2}`；每 child 记录本窗是否尝试。无证明时可用额度为 0；每个新的已证明 inputId 独立递增 epoch，包括新 session 第一条、Root 已为 L0、连续两条真人输入；重复 ID 不递增。
- epoch 与 legacy.resetRoot() 的数值变化/持久回调完全独立，禁止挂 onPersistRootLevel；Root 保持 0 时也必须开新窗。
- 普通 wake 仍用 `maxLevel/perRunQuota`；决策 wake **不扣也不重置旧 perRunQuota**，改扣专用 2/窗口与 1/child/窗口；正文仍扣原 reportQuota/rootInboxCap/throttle。
- 单 child 一个未决请求，答复/取消也不返还已用窗口额度；一个 child 连续制造新 ID不能在同窗再激活，两个 child 合计最多 2。
- **因果隔离（Root 选方案 a）**：decision 正文、wake-only 与降级投递都走专用 send 分支，不进入普通 mailbox `onDelivered`。决策不增加也不降低 Root/child level，不人为注入 originLevel=0；L4 child 仍 L4，Root0 决策后仍 0，无关 child 的普通 spawn/steer 仍继承原 Root0。普通非 decision 的因果传播完全不变。
- 真人输入后：只开新窗口并允许**仍归当前 owner、仍 running 的旧 child**申请；不遍历清零 children、不 revive terminal run、不把旧树/旧 session ID 迁入。
- 已未决旧请求可显式 `action:wake` 申请新窗口一次机会；不自动扫描激活，不自动重发正文。TTL 不因窗口变化延长。
- Root 正在运行时只 steer，但也保守计一次决策激活尝试；简化并发预算，避免 busy→idle 竞态免费唤醒。

## 3. human ingress 的具体接口门（先证据后启用）

- 新内部端口 `observeHumanInput({sessionId, owner, inputId, provenance})`，仅宿主可信入口持有；模型参数、消息 role/content、TaskList/任务状态绝不构造该凭证。
- 同一 inputId 重放只观察一次；按下述 lazy activation 管理，**不得每次 human 无条件写 ledger**。证明失败不 reset；已激活时 checkpoint 失败不发布新额度；普通输入仍正常处理。
- **从未使用 decision：**只有宿主内存观察已证明 inputId/epoch（有界 dedup，满则 fail-closed）；零额外持久 ledger、预算消费、计时器。第一次合法 request 才原子 checkpoint 当前 proof/epoch + 请求 reservation/attempt/预算（无 proof 则 0 可用额度），成功后才发送。
- 第一次 checkpoint 前 admission/quota 拒绝不激活账本；checkpoint 失败无发送/无预算权限。无请求的 status/wake/cancel 不创建账本。reload 丢失未激活 proof 时保守无额度，直到新 proof。
- **已激活后：**每个新证明 inputId 持久化新 epoch，再发布新窗额度；同 sid 重建恢复已用高水位，不靠 reload 洗预算。inputId dedup 与高水位一起 checkpoint，重放/未知来源不算新 proof。
- 证据：`wake-input.ts` 现判 interactive/rpc 为真人，extension 用 web 文本归因；SDK `InputEvent` 仅 text/images/source/streamingBehavior，没有不可伪造 inputId/origin。
- SDK `AgentSession.prompt()` 的 source 缺省 interactive；RPC prompt/steer/follow_up 都标 rpc，机器客户端也能调用。因此 **不能直接复用 classifyHumanInput 作为新预算重置的充分条件**。
- `ui_prompt_start` 是扩展阻塞对话，不是用户提交输入；user-role custom 注入、agent_settled、completion、schedule、fabric、xs、replay 均不重置。
- 最小先支持可证的 Web 用户 prompt：在 `web-hub/agent/commands.ts` 已通过 admission 的真实用户提交处，以 cmdId/session/owner 登记一次性 provenance；同 ID held-release/replay 不再给额度。
- 不能用 `hasPromptText()` 认人（同文机器输入可误中）；不得把现有 xs enhanced 的 `noteWebProof` 当通用凭证或打开 xs。新增可选 tree-only callback，off 时不接线。
- P0 必须用离线宿主/SDK 测试，检查既有可信输入接缝是否提供 private 提交观察点，可绑定一次 inputId；分别证明真人、机器注入、重复派发的行为，不只复述 InputEvent.source 弱。Web 候选需追溯 cmdId/origin，区分机器/重放/Feishu bot；证明不成立则该入口不 reset，证据先于 P1/P2 开放入口。
- 威胁边界是 LLM/机器消息自激活；不升级到已掌握任意 host JS/用户权限的恶意宿主攻击，不要求对宿主自身提供不可伪造密码学证明。
- TUI / 泛 RPC 在现 SDK 下缺少独立提交来源证明：需确认可信 SDK/UI 提交回调携带一次性 inputId 的接口，未满足前保持 provenance_unavailable，不声称全入口可用。
- 若用户实际 TUI/泛 RPC 入口经 P0 仍不能提供证明，明确报告该入口 decision wake 不可用（只有投递），不得声称全渠道可用；交 Root 决定补齐接口，不用正文、#39 未完成 memory 模块或 #59 兜底替代。
- 不改旧 causal-level reset 行为；这里只加严新预算的 reset。#59 如后来具备相同证明端口，可再共享接口，但不是本方案前置依赖。

## 4. 有界状态机与 at-most-once

### 4.1 数据与线性化

- 新 session entry `subagent:decision-wake` v1；只存 ID/绑定/计数/状态/摘要 hash/原 fabric key，不再存一份正文。预算与请求摘要由同一账本操作串行更新。
- 正文仍在既有 fabric outbox。新请求先 reserve stable key，再 enqueue；key/request 映射写成功才触发 pump；崩溃恢复按 key 对账，不生成新 seq 补送。
- 正文 FabricRecord 仅追加可选 decision metadata，持久化基础始终 `wake:false`。新 Host 验证 ledger 许可后调用独立 `sendDecision` 原语/专用分支（非普通 sendRootContext 完成回调）；禁止临时把 normal record 改成 wake=true，专用完成路径不调用 causal.onDelivered。旧 reader 只 deliver-only，不获决策权限。
- 正文 dispatch 与后续 wake-only 信号各有独立 persisted attempt；先写 attempt + 扣额度，再调用宿主。正文还须在 outbox 标为 terminal consumed（decision_attempt）后才发送，防旧 reader 不识别新 ledger 而重放；投递结果另在 decision metadata/账本记录，不回退到 pending。写失败不发送；effect unknown/崩溃已 attempt 都保守消费，不重复发送。
- 第一次 request 有额度时，专用原语单次注入正文并独立设置 triggerTurn；无额度则专用分支 triggerTurn=false；两者均不触 causal 更新。后续显式 wake 仅发 ID+原 key 引用控制提示，不重发正文、也不更新 causal。
- wake-only 必须正文已知 delivered 且请求仍 pending；正文 unknown 不能通过 wake 重试；同窗口已 attempt 的重复调用只返回快照。
- 两阶段非事务存储允许安全方向的损失：reserve 有 key 但正文缺失且无发送 attempt，可用同 key 补全；任何不确定发送证据禁止补送。失败中间态需可审计，不能当成功。
- 请求正文 hash 在首次 admission 前计算；同 ID 不同正文拒绝 id_conflict；同 ID 同正文返回原 key/状态，不占第二次 quota/seq/预算。

### 4.2 状态 / 事件矩阵

| 事件                                 | 状态与处理                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首个合法 request                     | pending，delivery=queued；竞争 child slot/预算同步 CAS；另一 ID 得 pending_exists                                                                                         |
| 原配额/inbox/cap 拒绝                | 不发送、不占决策额度；返回明确 rejected，不谎称已送达                                                                                                                     |
| 专用预算耗尽/无 human proof          | 正文走专用 deliver-only 分支且不更新 causal；activation=downgraded；请求继续 pending                                                                                      |
| 发送成功                             | delivery=delivered；activation=requested 或 none；不是 processing                                                                                                         |
| 超时/未知发送                        | delivery 或 activation=unknown；attempt 保守消费；本 child 同窗 action:wake/status 均返回 unknown，无注入/重送/退额，不声称 Root 已处理                                   |
| 明确 effect=none                     | 发送前准备失败可同 key 有界重试；dispatch attempt 后 none 也消费/结束请求；本 child 同窗 action:wake/status 明确 downgraded(effect_none)，不重送/退额，不声称 Root 已处理 |
| status/重复 request                  | 返回快照；无注入/唤醒/续 TTL/预算 reset；不是轮询建议                                                                                                                     |
| 显式 wake                            | 仅 delivered+pending，当前窗合格才发一次引用提示；其余直接返回 downgrade/unknown                                                                                          |
| Root decisionReplyTo                 | 校验 owner+child+id，先 reply_attempt；有界 steer 成功→resolved；未知→reply_unknown（不重发）                                                                             |
| reply_unknown                        | 仍占未决 slot；不再决策唤醒；Root 可用相同关联字段+相同文本查询原结果；TTL/child cancel 才释放                                                                            |
| 普通 steer / 接收 ACK                | 不 resolve；不得以任何 steer 已发出推断问题已解决                                                                                                                         |
| cancel / 超时                        | canceled / expired；不发唤醒；保留去重 tombstone，迟到答复标 late、不 reopen                                                                                              |
| child aborted/terminal / parent dead | closed(reason)；撤销未开始 attempt；终态源不能新请求；不 revive；已开始未知不追回                                                                                         |
| Root abort / session switch/new/fork | 立即关权限/窗口，取消未发尝试；新 session 无额度；不自动迁移请求                                                                                                          |
| reload / stack rebuild               | 先冻结旧 owner，恢复同 sid 已消费计数；旧请求因 owner/源失效关闭；无 reload 洗额度                                                                                        |
| 持久化缺失/损坏/不支持               | fail-closed：decision wake 禁用并清晰降级；不退化到 legacy wake；不影响普通 fabric                                                                                        |

### 4.3 有界存储、清理与零挂起

- TTL：请求 15min（到期只关闭，不启动模型）；至多 32 pending、256 请求条目/Root owner；满则拒绝新 ID，不淘汰仍有效的去重记录让它重发。
- tombstone 至少保留到该请求 TTL；过期 id 不能重新生效：每 run 保存有界已用 ID 摘要直到 terminal；达到总 256 ID 上限即拒绝该 owner 新请求。
- 已激活窗口的 epoch/消费计数是 session 高水位，**不按 TTL 遗忘**；reload/树回滚从本 sid 的 getEntries 恢复，而非仅 getBranch；fork copied sid 不继承权限。未激活阶段不写此 entry。
- 不写全局配置/新用户目录；只用当前 session persistence。无持久化证明的模式不提供决策 wake，不能 session-memory 丢失后赠额。
- live 表按 TTL/cap 有界；历史 session append-log 沿用既有保留策略，不宣称整个 session 文件有固定大小。
- 仅存在实际请求截止时间时才启一只最近 deadline timer，或复用 mailbox scheduling；未用 decision 零 timer。用 clampSpanMs/segmented clock，全部 unref、dispose 幂等；无 per-request poll/无限 timer。
- 所有宿主发送/steer 受现有 steerMs 与 maxAttempts/TTL 约束；关闭→停止新 admission→撤销未发送→dispose，沿 Stack 三条 teardown 路径。
- I4：不加模块作用域可变状态；owner 失效立即隔离旧 closure；如未来需要跨 activation 缓存，只允许有声明 cap/TTL 的旧前缀 Symbol，但本版不需要。
- secure：不绕 D2/D3/D4/D8，不开启 xs/threads；沿既有 tree fabric 域规则，账本仅当前 session 内；locked/readonly 不产生新决策许可，无外部写盘。

## 5. 回执、可见性与策略 owner

- feature-on 回执新增 `decision:{id,state,delivery,activation,reason?,key?}`；保留原 accepted/key/seq/wake 字段语义，不把 admitted 等同 delivered。
- queued+downgraded：`已受理，尚未确认送达；未请求唤醒，Root 未必看到。` delivered+downgraded：`已送达但未唤醒，Root 未必看到。`
- requested：`已请求唤醒，不代表 Root 已开始处理。` unknown：`发送结果未知，禁止换 ID 或盲重正文。`
- 根侧沿既有 fabric entry renderer 显示一次阻塞/降级提示；decision 的 consumed 记录仅在最终 delivery metadata 已落定时投影一次（attempt 中间记录不展示），旧 delivered 分支不动；简短标记用 English，解释段可中文；未开启且无 metadata 的旧 entry 输出逐字节不变。
- UI 不新增 wire frame/PROTO；优先沿现有 custom entry 的正文/details 展示。若需追加 optional 字段，旧 reader 忽略即可，禁止扩 xs 协议。
- mechanics（参数、状态、去重、限制）写工具 description/参数说明；策略唯一 owner 是 `skills/agent-handoff/SKILL.md` 的“问父 agent”段。
- 策略：普通进度 progress；需要上下文但不阻塞的 report 显式 wake=false；真阻塞才 decision；同一问题固定 ID；降级后做可并行工作，不能省略 wake 绕门、定时重问或声称 Root 已接手。
- `skills/dev-flow/SKILL.md` 仅引用该策略与“Root 收到后关联裁定”职责，不复制 mechanics；两份 skill 已读。不得复制至用户全局 skills/agent 文件。

## 6. 兼容 / 冻结门

- effective off 或旧 factory 未传 decisionOn：旧 schema INSTANCE/说明/运行路径及既有 off golden 字节相同；未知 decision 不获权限。默认设置 dump **声明新增 true leaf**，不承诺新版完整 defaults 对象字节不变；这不要求改 A/B frozen。
- A 级 `tests/fixtures/tools/agent-nested-surface-golden.json` 与 `fabric-{wake,xs,xs-reply}-off-golden.json` **不改、不重生**；nested Agent schema 本来不是 message_agent，勿误伤。
- B `message-agent-wake-schema-golden.json` 保留旧 wake schema 作为 opt-out/旧 factory 契约；A/B 测试 factory 显式 flags 不变，新 on-schema 独立 fixture。默认 on 不与这些冻结工厂硬冲突；不重生、不放宽断言。
- 新 host × 旧工具/schema 保留旧路径；旧 host × 新参数不构成 capability（不能推断支持）；host 注入新工具必须同时具备新账本端口，禁止只有 schema 没有执行能力。
- 降级到旧版本读取新记录：基础 wake=false，最多 deliver-only；未知 decision ledger 不给权限。不承诺旧软件理解关联答复。
- off golden 保留旧行为也意味着旧省略-wake 的兼容风险仍在；只在新工具分支堵住该入口，不能为了“修复”改冻结面。

## 7. 文件域 / DAG（实施 ≤4 包，前置双闸门）

| 包                | 精确 writer paths（均仓库相对；新文件注明）                                                                                                                                                                                                                                                                                                                     | 验收 / 依赖                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P0 合同/账本/证明 | 新 `src/fabric/decision-wake.ts`、新 `src/fabric/decision-input.ts`；`src/fabric/settings.ts`、`src/fabric/setting-specs.ts`、`src/core/message.ts`；新 `tests/fabric/decision-wake.test.ts`、新 `tests/fabric/decision-input.test.ts`；已有 `tests/config/fabric-wake-settings.test.ts`；新 `tests/conformance/fabric-decision-input.test.ts`                  | 状态机+property、9-leaf/default dump/editor；P0 私有入口证据先行                      |
| P1 交付           | `src/fabric/router.ts`、`src/fabric/mailbox.ts`、`src/fabric/stack.ts`；新 `tests/fabric/decision-delivery.test.ts`                                                                                                                                                                                                                                             | 依赖 P0 合同；原正文/未知发送/预算 CAS 不双送                                         |
| P2 宿主/工具      | `src/tools/message-agent-tool.ts`、`src/tools/steer-tool.ts`、`src/tools/register.ts`、`src/service/runtime-adapter.ts`、`src/stack.ts`、`src/index.ts`、`src/web-hub/agent/commands.ts`、`src/web-hub/agent/index.ts`、`src/adapters/fabric-entry-renderer.ts`；新 `tests/tools/decision-wake.test.ts`、新 `tests/fixtures/message-agent-decision-schema.json` | 依赖 P0；与 P1 按既定 ports 并行，index assembly-only；无新注册顺序                   |
| P3 集成/文档      | 新 `tests/integration/fabric-decision-wake.test.ts`；`tests/integration/stack-teardown-matrix.test.ts`、`tests/tiers.ts`；`docs/dev/fabric-cross-session/README.md`、本 plan、`skills/agent-handoff/SKILL.md`、`skills/dev-flow/SKILL.md`                                                                                                                       | P1+P2 后；异源验收；fabric README 写默认 on、lazy ledger、因果隔离及旧 schema variant |

DAG：`P0 → (P1 ∥ P2) → P3`。P2 只消费 P0 的证明接口，不触 #59 或 memory；无法确认 human 入口则反馈 Root，不私自扩大到 SDK/其他文件域。
共享冻结面由表中唯一 owner 写；P1/P2 所需 ports 在 P0 固定；新增 teardown 槽若需要改 stack-teardown.ts，先报 Root 重新划域，不抢写。

## 8. 离线验收矩阵（断言行为，不跑真实模型）

| 场景                  | 必须断言                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本次 L4 / 因果隔离    | oldchild4 + Root0 的 decision 唤醒后 Root仍0、child仍4；随后无关 child 普通 steer仍0，spawn继承0；普通 wake=true 仍 level_limit；decision完成回调不调用onDelivered |
| epoch独立             | new-session first human、Root already0 human、连续两条不同inputId均递增/开窗；重复ID/nohuman不reset；不依赖resetRoot持久回调                                       |
| lazy activation       | 默认on但从未decision：0 ledger写/0预算消费/0 timer；首次合法request checkpoint后发送；未激活reload丢proof→无额度；已激活reload不洗预算                             |
| 真人 reset + 旧 child | 旧child4仅current owner/live generation可申请新窗；不清level；root0不妨碍新epoch                                                                                   |
| 非真人输入            | user-role custom、completion、timer、TaskList、xs/machine RPC、同文extension不reset；private宿主观察点须有正反例证据                                               |
| 多 child / 重传       | 3 child同窗合计≤2、同child≤1；同ID同正文只有一个key/seq/正文；不同正文冲突                                                                                         |
| 已送达未wake          | 后续action:wake仅引用提示一次，正文数仍1；同窗重传不再扣/送；不宣称Root已处理                                                                                      |
| 答复关联              | wrong id/owner/run拒绝；普通steer不resolve；关联成功关闭；reply unknown不重发不返额                                                                                |
| 生命周期              | abort/new/fork/parentdead/terminal/TTL/cap/reload/tree rollback全覆盖；旧闭包不可用                                                                                |
| effect none / unknown | attempt消费后同child同窗wake/status分别downgraded(effect_none)/unknown；0双送、0退额、无“Root已处理”；persist fail→0 send                                          |
| 显式 / omitted        | 普通显式wake:true/false保持旧调用参数/level/quota路径；新on-variant omitted→false；旧factory无decisionOn omitted仍legacy，不混称所有旧caller兼容                   |
| settings / frozen     | default leaf=true、parser显式false、default dump/editor一致；已有8-leaf两处pin更新9-leaf；A/三off/B旧schema字节不动，新on fixture独立                              |
| 零挂起 / 离线         | fake clock TTL边界、unref、三路dispose无timer；假端口断言调用参数/次数；无网络/API/mount                                                                           |

实施自验：`npm run typecheck`、`npm run build`、限并发 `npm run test:tier1`，另跑上述定向 integration/conformance；禁止真实 API/modelbench/mount。文档阶段只需格式、结构/哈希与类型检查（不宣称已实现矩阵）。

## 9. 剩余门与交接

- 默认 on 已定；尚待 P0 落地既有可信宿主 private 输入观察点证据，尤其用户实际 TUI/泛 RPC 入口。不能仅凭 source，也不能仅因公开 InputEvent 缺字段就断言所有 private 接缝不可能；无证明则报告对应入口限制。
- 预算耗尽、网络/宿主未知、Root 自身不可用时，本机制不保证即时处理；提供清楚回执与既有可见记录；#59 仅可能后续兜底，不是此状态机依赖。
- 请求超时不替用户拍板；child 继续无关工作或报告阻塞，不擅自越过需要决策的边界。
- 交接：`/tmp/fabric61-plan-handoff.json`（fileIndex/evidence/ruledOut/openQuestions + plan SHA-256）；按证据选择性核验，不重查 xs 广播。
