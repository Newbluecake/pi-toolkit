# 跨会话请求状态、可信人类代发与幂等激活 — 实施计划

> 2026-11-04 · L3 plan · 基线：`docs/dev/fabric-xs-activation/arch.md`（架构契约，用户六项裁定 U1–U6 已闭合）。
> 本文件只做分包与验收安排；架构问题的答案一律以 arch 为准，本计划不重开任何产品问题。
> 前置：误报修复 `58f850a0` 已合入，不回退、不纳入本任务范围。
> 2026-11-04 修订：闭合 reviewer r_15CPHMYB 两个 major（§2 文件唯一 owner 裁决、§2/§3 默认 on 回归基线）与一个建议级（§3-P5 测试命名区分）；arch 与范围不变。

## 0. 范围与不做项

做（arch §1.1 六项裁定的全部落地）：

1. U1：跨会话进展四阶段 `queued / delivered / started / replied`，与三效果 `none / unknown / applied`、wake 执行轴三线分立。
2. U2：人类发起且带 `expectReply` 的请求省略 `wake` 时默认请求唤醒；agent 间普通消息默认 false 不变。
3. U3：唤醒降级原因端到端显式（工具 JSON/hint、hub audit、mention 投影、接收卡片、/fabric、web UI）。
4. U4：新幂等工具 `wake_session`（`action: "activate" | "query"`，默认 activate），仅激活已存在、已送达、未开始处理的 messageId，不重复投递正文。
5. U5：宿主一次性人类授权（grant）沿真实调用链传递，agent 代发 expectReply 可默认 wake；不信模型自报。
6. U6：activate 仅关联已送达未处理的原 messageId/receiptId + activationKey；无任意空唤醒、无重跑。

不做（arch §1.2/§5 限制，任何包不得越界；需要这些即停工上报 root）：

- 不重发正文、不自动周期 activate、不启动离线进程、不替用户 join/receive/fence reset；不做持久任务系统与跨进程 exactly-once。
- 不 bump `PROTO`；不改旧字段语义与 closed schema；不动 A-tier golden 字节（`fabric-xs-off`、`fabric-wake-off`、`fabric-xs-reply-off`、`secure-off`、`legacy-xs-v071/`、`agent-nested-surface-golden` 等）。
- 不改 message_agent / 广播 / Thread / schedule / goal 的现有默认值与链路；子会话无新 xs 工具（I6）；secure 域 fail closed 不变（I11）。
- 不放宽 hub/protocol boundary 白名单（I8）；grant 不进 wire/provider/prompt/model meta/dispatchMeta/诊断继承。
- 不新增第二 runner、不新增配额体系、不设人工免配额；不做「回执→自动 wake 原 sender」。
- 不碰工作区其他任务文件；不 stash/reset/`git add -A`/全树格式化。

## 1. 全局工程约定（每个包都要遵守）

- 开关：`fabric.crossSession.activation.enabled`（默认 **true**，非 live，activate/stack build 冻结；hub 侧仅当 `HubConfig.crossSession.activation` key 存在时组装新服务，key 缺失 ≡ 旧 hub）。effective = `xsOn ∧ activation.enabled`；secure 已由 `xsOn` fail closed（`src/config/settings.ts::applySecureDomainOverrides`），不为 activation 单设 D8 分支。
- 能力：`xs.state.v1`（四阶段/原因/messageId/查询/可信代发契约；effective 即宣告，wake off 也能解释原因）与 `xs.activate.v1`（effective ∧ 本地 wake on 才宣告）。两个 cap 都在 hub 双表面（`HubInfo.caps` + `hello_ack.caps`）与 agent `hello.caps` 追加；`XS_AGENT_CAPS` 常量本身不动（off golden）。
- I1/I5：所有期限 `clampSpanMs`，长延迟 segmented Clock，timer 全 unref。I4：跨 reload 纯数据只进 `Symbol.for("pi-subagent:*")`（容量/TTL 写明）；I7：不改运行时旧名。
- wire 预算：frame ≤16 KiB、id ≤64、sid ≤128、reason 英文 token ≤64（wake ≤48）；state 帧绝不带正文/hash/token/IP/原始异常。
- 降级观察轴（arch §3.2）：**本地 command** dispatched/observed/consumed；**远端正文** queued/delivered/started/replied；**wake 执行** requested/declined/dispatched/authorized/aborted/settled。HTTP ok、consumed、woke、busy、unread=0、模型自述收到，均不得跨轴推导。
- 工具/描述/schema 按本地 effective 冻结选取（提示词缓存前缀约定），不随 live peer 变化。
- 证据上限：receiver 反向扫描 ≤2000 条、待查 messageId ≤256；progress 袋 receiver/source 各 cap256、hub 关系 cap1024，满则该正文走旧路径 + tracking unavailable，不驱逐 live 窗口条目。
- 每包完成即由 root 派**异源 verifier**（验收模型 ≠ 开发模型）按本计划 §6 验收标准逐条裁定；一包一 commit（精确路径），整个任务完成才 push 一次。

## 2. 分包总览、依赖与并行冲突预检

| 包            | 内容                                                                                                       | 依赖                                                            | 冻结面冲突                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 协议与开关 | 新 wire 模块、caps、设置解析/spec、off 隔离改造                                                            | 无                                                              | **独占** `protocol/xs.ts` 接触面、`messages.ts`、settings/corpus                                                                                                                                                                |
| P1 进展证据   | progress 归并、receiver 观测、hub 关系袋、xs_state 双向帧                                                  | P0                                                              | 独占 `fabric/xs/progress.ts`、`hub/xs/activation.ts` 初形；receiver/stack 由 P1 owner 写入，P3 排队；**不写** `fabric/xs/activate.ts`（statusView 同步需求移交 P2 owner）                                                       |
| P2 可信代发   | human-grant 账本、调用链接线、默认 wake、sender 意图装饰与 outcome 透出、mention 后端面                    | P0、P1（progress 端口形状）                                     | 独占 `fabric/xs/human-grant.ts`；**唯一 owner**：`fabric/xs/activate.ts`、`fabric/xs/sender.ts`、mention 后端（`mention/wire.ts`/`mention/session.ts` + `web-hub/agent/commands.ts` mention 端口）；agent-tool/spawn 接线窗口短 |
| P3 激活       | wake_session 工具、session-activation、hub activate relay、Controller activateExisting、marker/claim/quota | P0、P1（资格判定读 progress）、P2（activate.ts/sender.ts 交接） | 与 P1 串行共用 receiver/stack/root-wake（同一 owner 或严格先后）；**不写** activate.ts/sender.ts/mention/commands.ts——接线需求交 P2 owner 应用                                                                                  |
| P4 web UI     | xsRequestState、请求区域、卡片徽标、activate 按钮、i18n                                                    | P0（冻结契约）+ P2（mention 端口契约），可与 P1–P3 并行         | 独占 `web-hub/ui/**` 相关文件；mention/commands.ts/control 端口**只作断言方**（实现属 P2）                                                                                                                                      |
| P5 集成与门禁 | integration/conformance、混合版本、reload/crash、golden/语料收尾、文档                                     | P0–P4 全绿                                                      | root 编排，集中刷新治理 trace                                                                                                                                                                                                   |

并行规则（冲突预检结论）：

- **串行硬约束**：`protocol/xs-activation.ts` + `messages.ts` + settings（P0）先行冻结；`fabric/xs/receiver.ts`、`fabric/xs/stack.ts`、`fabric/root-wake.ts`、`web-hub/agent/xs.ts` 在 P1/P3 间只能一个 owner 在写（B1/owner/teardown 不多包并写）；`tools/message-session-tool.ts` 在 P2（描述/hint 变体）与 P3（无重叠，wake_session 是新文件）间顺序接入。
- **可并行**：P1（fabric/hub 后端）∥ P4（UI 按冻结 wire 契约开发，fake 数据驱动）；P2 的纯账本部分 ∥ P1。
- **helper 共享面**：`tests/integration/helpers/fabric-xs-process.ts` 新环境旋钮由 P5 统一加（P1/P3 各包先提需求清单，不各自改）。
- **语料/trace 集中写**：`tests/config/__corpus__/setting-specs-pin.json` + `settings-corpus.json`（新开关属已声明 append，唯一改动是新 key）与 `tests/fixtures/governance/activate-trace.json`（新工具/注册顺序属声明变更）由 **P5 统一刷新**，任何开发包不得自行再生。
- **唯一 owner 裁决**（闭合 reviewer major-1，禁止并行双写）：
  - `src/fabric/xs/activate.ts`：唯一 owner = **P2**。P1 的 statusView 同步、P3 的 wake_session 注册与冲突扫描集合更新一律以「接线需求清单」移交 P2 owner 在对应包窗口应用；P1/P3 的任何提交不得触碰该文件。
  - mention 后端面：唯一 owner = **P2**，含 `src/mention/wire.ts`、`src/mention/session.ts`、`src/web-hub/agent/commands.ts`（`onSessionRouted`/control 端口定义与 mention 两分支同步实现）。P4 只按 P2 冻结的端口契约写 UI 断言，不改这三个文件。
  - `src/fabric/xs/sender.ts`：唯一 owner = **P2**（意图装饰 + `XsSendOutcome` 透出 messageId/activationKey）；P3 只消费透出字段，不改 sender。
- **默认 on 回归基线**（闭合 reviewer major-2）：`fabric.crossSession.activation.enabled` 默认 true，下列现存套件**一律默认 on 原样跑**（不得改其设置 JSON 补 `activation.enabled:false`），P1/P2/P3 各包验收跑其受影响子集（见各包验收段），P5 全量复跑：
  - XsHarness 真实 hub+stack 九套件：`fabric-xs`、`fabric-xs-inbox`、`fabric-xs-level-mixed`、`fabric-xs-alias`、`fabric-xs-alias-v2`、`fabric-xs-channel`、`fabric-xs-lifecycle`、`fabric-xs-mention`、`fabric-xs-reply`；
  - sandbox-home 注册/接线面六套件：`fabric-xs-activation`（**既有**，extension activate() tool-surface 注册，与本特性新文件同名不同义）、`fabric-xs-alias-wiring`、`fabric-xs-channel-compat`、`fabric-xs-child-scope`、`fabric-wiring`、`mention-autocomplete-wiring`；
  - 直驱/单元面六套件：`fabric-xs-topic-fence`、`fabric-wake`、`fabric-wake-level`、`fabric-wake-quiet`、`fabric-wake-revive`、`fabric-wake-subscribers`。
  - 中间态 off 策略：联调新链路时可用 helpers 旋钮（P5 提供的 `XW_ACTIVATION_OFF`/`XW_HUB_ACTIVATION_OFF`）或本地设置临时 pin off 来隔离变量，但这只是调试手段，不进任何提交；每个包的**提交态**必须是默认 on 下基线子集全绿。off 隔离只按 P0 声明改测试配置 JSON，不重生 A-tier golden。

## 3. 各包实施细化

### P0 — 协议、开关与 off 隔离（1 个包）

文件域：

- 新 `src/web-hub/protocol/xs-activation.ts`：cap 常量（`XS_STATE_HUB_CAP`/`XS_STATE_AGENT_CAP` = `xs.state.v1`；`XS_ACTIVATE_HUB_CAP`/`XS_ACTIVATE_AGENT_CAP` = `xs.activate.v1`）、`XsPhase`/`XsEvidence`/`XsWakeView`/`XsProgress`（arch §4.1 逐字段）、`xs_state`/`xs_activate`/`xs_activate_ack` 帧 schema（strict，`additionalProperties:false`）、`xs_req` 新 op（`receipt`/`activate`）的形状与期限（receipt 3s、activate 8s、relay/expiry 5s）、activate 状态/原因枚举、激活 relation/trackUntil 的纯计算 helper。pi-free、只 import `node:*`/typebox/xs.js（boundary 白名单只收紧密追加）。
- `src/web-hub/protocol/xs.ts`：`XsReqSchema` op union 追加两个字面量（仅 schema 形状；不写任何可选字段进旧 op），`XS_REQ_DEADLINE_MS` 追加两项；**不改**既有常量/字段/key 序。
- `src/web-hub/protocol/messages.ts`：`XS_AGENT_FRAME_SCHEMAS`/`XS_HUB_FRAME_SCHEMAS` fold 新帧 schema；`StatusInfoSchema` 顶层 open 槽追加 `xsRequests`（`{sessionId, revision, rows≤…, omitted}` 有界 shape，仅新 live hub state 且本 session 有记录才写）。不动 ctl 的 closed state/op/reason。
- `src/fabric/settings.ts`：`FabricCrossSessionSettings` 增 `activation: { enabled: boolean }`，默认 true，解析容错逐字段；`parseFabricCrossSessionSettings` 追加；clone/defaults 同步。
- `src/fabric/setting-specs.ts`：`FABRIC_SETTING_SPECS` 追加 `fabric.crossSession.activation.enabled`（non-live 说明文案遵循 autoFromCwd 先例）。
- `src/web-hub/hub/xs/limits.ts`：`HubCrossSessionConfig` 增 `activation?: true` 归一化（key-absence-is-off；normalize 函数追加，旧配置字节不变）。

off 隔离改造（cmdHistory 先例：只调测试配置，不动 fixture 字节）：

- `tests/integration/fabric-xs-reply-off-golden.test.ts`、`tests/integration/fabric-xs-channel-compat.test.ts` 的设置 JSON 显式加 `activation: { enabled: false }`；断言 golden 逐字节不变。
- 新增 P0 自测：activation on 时 hello.caps 追加两 cap、`HubConfig.crossSession.activation` 出现；off 时与 reply-off golden 规范化相等（复用 channel-compat 的四配置骨架加第五配置）。

验收：typecheck 绿；新协议模块单测（shape/期限/枚举）；reply-off golden 与 channel-compat 原断言不改动且仍绿；`npm run test -- tests/web-hub/boundary` 绿。

### P1 — 进展证据轴（1 个后端包 + 纯状态子包）

文件域：

- 新 `src/fabric/xs/progress.ts`（pi-free 纯状态）：`XsProgress` 袋（messageId 索引、revision 单调归并：offline/miss/旧 revision 不退 phase；unknown→applied 可升、timeout 不造 none；direct delivered 合法；reply 可跳 replied 不补 startedAt）、activation claim 状态机（`available→reserved→dispatched/unknown→consumed`）、source 侧镜像归并。属性测试 `tests/fabric/xs-progress.property.test.ts`（乱序/重复/迟到快照不退场）。
- `src/fabric/xs/receiver.ts`：deliver 管线内写证据点——queued（busy 受理）、delivered（leaf.details.xid 匹配）、started（合法模型回合 context 观察点含原 xid；只看 marker/BAS/!isIdle 不算）、replied（requester ledger 关联 + 回复确认写入）；`entryId` 仅真实 xid 匹配到 branch 条目时填。queued→delivered 确认用 context 正匹配或既有 event flush 点的一次有界 branch 扫描（≤2000/≤256，超限 unknown，不每消息 poll）。
- `src/fabric/xs/stack.ts`：progress 袋挂 StackXs，context/turn flush 点驱动；dispose 卸 observer（stack-teardown 顺序由 `tests/integration/stack-teardown-matrix.test.ts` 钉住，新清理步骤按既有 GAP 注释规则追加）。
- `src/web-hub/hub/xs/activation.ts`（新，hub 侧）：原 send 关系登记（xid/messageId、source 进程/sid/rid、target 进程/sid、createdAt、trackUntil、key、lastProgress；cap1024，满则旧路径发送 + tracking unavailable、无 key）；`trackUntil = createdAt + clampSpanMs(expect ? timeoutMs+lateGraceMs : 30min)`，上限沿 `reply.maxTimeoutS + lateGraceS`。
- `src/web-hub/hub/xs/router.ts`：send 路径在 relay 前登记关系（新 cap 三端协商才写 track 字段）；`xs_state` 接收（receiver→hub）：核验 socket/xid/sid/revision，错则忽略诊断，不信 receiver 自报 source；向原 source 转发（hub→source）附 sourceRid（hub 关系关联）。
- `src/web-hub/agent/xs.ts`：bridge 收发 `xs_state`（BindingPort 新回调，参照 `onXsAliasEvt` 先例）；source 侧镜像进 progress 袋并驱动 StatusInfo 重发；`hubPort()` 增 `receipt`（只读 3s）。
- `src/web-hub/agent/index.ts`：publishStatus 组 `xsRequests`（有记录才写）；`HubConfig.crossSession.activation` key 仅 effective 时写（`hubCrossSessionConfig()` 追加，off ⇒ key 缺失字节不变）。
- `src/web-hub/hub/assembly-channels.ts`：caps 双表面追加两 cap（条件：`crossSession.activation` key 存在）；`createXsRelay` 传新服务。
- `src/web-hub/hub/agent-server.ts`：`xs_req` 新 op 进入 router 前的既有前置校验（16 KiB/rid 形状）覆盖新 op；无服务时按旧行为拒。
- `src/web-hub/agent/connection.ts`：帧路由 case 追加（`xs_state` 双向、`xs_activate`/`xs_activate_ack` 由 P3 用，P1 先建 schema 接线点但 agent 不宣告 `xs.activate.v1`）。
- `src/commands/fabric-xs.ts`：`/fabric status` 新行（有信息才加：阶段计数/原因；usage 未知显示 n/a 不伪造 0；legacy 无 cap 显示 unavailable）。**`fabric/xs/activate.ts` 的 statusView 同步不在本包**——本包只交付数据组装（progress 袋读取端口），activate.ts 触点以接线需求清单移交 P2 owner 统一应用（§2 唯一 owner 裁决）。
- reload/restart 语义：同 sid 同进程 reload 纯数据恢复 + observer 替换，授权/claim/deadline 不重置；new/fork/switch 撤销资格；hub/pi restart 关系丢失 ⇒ unavailable，不从磁盘恢复凭证。

验收：单测 + 属性测试绿；`xs_state` 帧混合版本差分逐字节（old hub × new agent 无 track/state/新 op；new hub × old agent 不加字段不 push；key 序不变）；off ⇒ 全链路字节同 reply-off golden。**默认 on 回归**：§2 基线中 XsHarness 九套件 + `fabric-wiring` + 既有 `fabric-xs-activation`（tool surface）在本包落地点原样全绿（本包落地点即中间态之一，不得借 off 躲过；off 隔离仅为调试手段，见 §2）。

### P2 — 可信人类代发（U5/U2，1 个包）

文件域：

- 新 `src/fabric/xs/human-grant.ts`：`HumanGrantRef`/`InvocationRef`/`HumanGrantClaim`/`HumanGrantPort`（arch §4.3.B 逐签名）；进程内 side registry `Symbol.for("pi-subagent:xs-human-grants")`，cap64、纯数据、lazy 清理；签发 ≤30min 且调用链存活；new/fork/switch/restart 撤销，same-sid reload 可保留但新 owner 不可猜旧 invocation 接管；满/过期/缺上下文 ⇒ 退 agent（显式 wake 走原准入）。一份 human 输入 = 一份全调用链共享额度，传播同 ref 不复制；首合格 expectReply 代发 CAS 成功默认 wake，并行其他默认 false；多目标需显式 `wake:true`。
- `src/fabric/wake-input.ts` / `src/index.ts` input 链：签发入口接 classifyHumanInput 同源判定——TUI interactive / RPC（same-uid 信任模型）/ web（hub 鉴权+CSRF 盖章 origin 与确切 cmdId，HTTP body 不可覆盖）/ extension 仅当前 session/owner 唯一 web ledger 关联；xs receipt/reply、message_agent 通知、goal/schedule/Thread/Feishu 自动链不签发。**busy 排队中的新 input 不得授权正在执行的旧 assistant 工具**。
- context 绑定与 toolCall 登记：宿主 run/context 代际跟踪（runKey/contextSeq）+ `pi.on("tool_call")` 或 execute 首参捕获真实 toolCallId；并行调用独立引用，禁止跨 await 读 global currentGrant。
- `src/tools/message-session-tool.ts`：execute 入口捕获 InvocationRef 经注入 port 查证；模型自报 source/human/grantId 一律忽略、schema 不宣告。省略 wake + expectReply 时：resolve pin 目标、guard/receivability/size 通过后 reserve 精确 call grant，成功 ⇒ human 委托默认 wake true，否则 false；explicit true/false 永远优先；replyTo 排除。同步段 issue reply ticket，**port.send 离开前 commit**；pre-send 证明 none 释放；remote 明确 none 可释放到同一已绑定 call/target 的未生效重试（不转目标、不自动重试）；explicit false 不被覆盖；grant 不绕 level/quota，真实 human input 只重置 root level 一次。默认便利仅三端 `xs.state.v1` 协商齐全的新链路启用；old peer 保持原省略 wake 帧（I10）。
- `src/tools/agent-tool.ts` + `src/service/spawn-service.ts`：真实 spawn 准入成功取得 childRunId 后，父 InvocationRef 沿真实 onSpawnEdge（`src/stack.ts` 1686 行既有接线点）登记同 ref；nested 沿已验证 parent 边；失败 spawn 无边。可选 dep 端口注入，absent ⇒ 字节不变；model params.meta/dispatchMeta/诊断继承不得携带授权；`tests/fixtures/tools/agent-nested-surface-golden.json` 不动。
- `src/fabric/xs/sender.ts`（本包唯一 owner；P3 只消费不改）：意图装饰——`requestedWake`/`senderDowngrade` 进 track 字段（三端 state cap 才写）；所有出口统一 decorate 已存 wake view（arch §4.8：首个真正停止 wake 的原因不被覆盖，sender 本地降级原因保留）。**`XsSendOutcome` 透出**（闭合 arch §2.2「无公开稳定 messageId/持续状态」缺口）：新增可选 `track?: { messageId: string; activationKey?: string }`，仅三端 `xs.state.v1` 协商且 hub 关系登记成功时填；tracking unavailable/关系袋满/旧 peer/off ⇒ 字段整体缺失，既有 outcome 字节不变。wake_session 的 messageId/key 只能来源于此透出或 receipt 查询，不得从正文/日志猜。
- `src/fabric/xs/activate.ts`（本包唯一 owner）：registerSurface 把 grant port 注入 sender 与工具（effective 才接；off ⇒ 现路径逐字节）；`wake-input` hook 组合（注册顺序进 trace，由 P5 声明刷新）；并吸收 P1 移交的 statusView 同步需求。
- mention 后端面（本包唯一 owner；P4 只作断言方）：`src/mention/wire.ts`、`src/mention/session.ts`（outcome 形状）与 `src/web-hub/agent/commands.ts`——保留 onHandled(rawText) 一次 report（58f850a0 不动、旧签名不变）；新增 `onSessionRouted` control 端口（新 cap 才接）透传 message/progress 引用；**同步 web 分支**在 route 完成后以确切 frame.id consumed + message 关联（不依赖 onInputHandled 的文本匹配，也不等不会出现的本地 message_start）；legacy observed 回执保持；route throw 按 pre/post-send 证据（pre 证明才 none，否则 unknown）；30s CAS 不覆盖。
- hint/audit 前段（#14）：工具 JSON 保留 `wakeDowngraded` 并加中文 hint（「唤醒因 pair_wake_rate 降级（hub，每会话对2次/小时）；正文按 deliver 投递，不要重发；已确认送达未开始可原 receipt 人工 activate，但须等待配额」；无写入证据不断言 delivered）；`src/web-hub/hub/audit.ts::auditXs` 追加可选 `wakeRequested/wakeEffective/wakeDowngraded/wakeStage`（token 形状过滤沿用；旧 off/legacy 行 key 序不变；不记正文/hash/wakeToken/IP）；mention map（`src/mention/wire.ts::mapMentionSendOutcome` + `src/mention/session.ts` outcome 形状）透传 wake/progress，提示区分 queued/delivered/dispatch pending/started。

验收矩阵要点（§5 详表）：TUI/RPC/web 三入口；extension 多同文本/错 owner/topic-switch 重注入/第三方 sendUserMessage 不签发；伪 source/meta/grantId 忽略；真 input→context→call→spawn/nested 共 ref；并行 CAS 恰好一次；pre-none 释放/post-unknown 消费；自动续轮/跨 xs/历史诊断无继承；human/grant×expect×wake 三值全组合；old cap 帧不变。**sender 透出验收**：新单测断言 `XsSendOutcome.track`（messageId/activationKey）经 message-session-tool outcome JSON 与 mention `mapMentionSendOutcome` 透传至 cmd_result 投影；off/旧 cap/tracking unavailable ⇒ 字段缺失、既有 outcome 快照逐字节不变。**默认 on 回归**：§2 基线中 `fabric-xs-mention`、`fabric-xs-reply`、`fabric-xs`、`fabric-wake`/`fabric-wake-level`/`fabric-wake-quiet`/`fabric-wake-revive`/`fabric-wake-subscribers` + `fabric-wiring` + 既有 `fabric-xs-activation`（tool surface，message_session 描述冻结）原样全绿；`agent-nested-surface-golden` 不动。

### P3 — 幂等激活（U4/U6，1 个包，与 P1 串行共用接收面）

文件域：

- 新 `src/tools/wake-session-tool.ts`：`{to, messageId, activationKey, action?: "activate"|"query"}`（默认 activate；query 严格只读：不 reserve wake、不签发 grant、miss 不执行、只计 listPerMin 读额度）；effective 的主会话注册；wake off 仍能 query、activate 返回明确拒绝；`XS_MAIN_TOOL_NAMES` 不动，冲突集合单独追加常量。unknown hint 固定要求 `action:"query"` 及原 message/key；无另造 get_receipt 工具。
- 新 `src/fabric/xs/session-activation.ts`：`XsActivationPort`（activate/receipt，arch §4.4 签名）；准入同一同步段顺序（arch §4.5 六步：expiry/to.sid/epoch/成员/频道/allowFrom/block/receive/fence 重验 + hub 盖章 from → 原记录存在且原文在当前 branch 实际确认 → started/replied no-op、deferred/starting/aborting/stuck 或 claim 未决 already_active → Controller policy/wake/预算/capability/goal/owner/inbound quota/当前 causal level → 先 message 级 claim + Controller owner 后 host 无 await → 仅调 Controller 新 `activateExisting` 入口）。
- `src/fabric/root-wake.ts`：Controller 增 `activateExisting`——复用 dispatch/ledger/B1，发**固定小型宿主控制 marker**（customType 仍 `subagent:xs`，details 含 xsWake/wakeToken/控制动作 xid 及内部 activateFor=原 messageId；固定 content 仅说明宿主激活，不含调用方正文/header/q/alias/key/token）；ledger 绑定控制动作与 activateFor；context 含原文 xid 才 started；不 issue 新 reply 凭证、不调 receiver.deliver/sender.message、不计 inbox/unread（tap 识别 activateFor）。
- `src/fabric/xs/receiver.ts` + `src/fabric/xs/stack.ts`（P1 owner 交接后）：activate 判定读 progress 证据；观测断档 fail closed；`activateExisting` 出口装饰 ended（settled/aborted/deadline/stuck）。
- `src/web-hub/hub/xs/activation.ts`（P1 初形上扩展）：`xs_req{op:"activate"}`——先原关系/幂等命中再限流（dup/query 不占 wake 格）；真新 attempt 同步 reserve 后 relay `xs_activate`；`xs_activate_ack` 精确 pending 匹配；配额复用 send/min/hour、hub/min、inFlight、out wakes/h、pair 2/h、receiver inbound wakes，跳过原 pairMinInterval 但另有 30s/pair 控制 attempt 间隔；send/控制 attempt 计数不退款，证明 none 释放**此 attempt** wake reservation，unknown 不退款；already_active/started no-op 不占格不开 turn。retryable/retryAfterAt：滑动窗口最旧有效占用到期（非整点 reset），多项限额取可执行最晚约束，receiver 未知不猜。
- `src/web-hub/agent/xs.ts`：bridge 收发 `xs_activate`/`xs_activate_ack`（三端 cap 才发帧；old peer ⇒ 本地 unsupported，不拿 text 模拟）。
- `src/fabric/xs/activate.ts`：**本包不写**（§2 唯一 owner 裁决）——registerSurface 注册 wake_session（effective）与冲突扫描集合更新以接线需求清单移交 P2 owner 在 P3 窗口应用；本包只交付 `wake-session-tool.ts`/`session-activation.ts` 新文件与注册规格说明。

验收矩阵要点：pair 满（2/h）⇒ hub/pair_wake_rate 拒、不 relay marker、不占新 wake 格、不重正文；retryAfter 准确；原 key 恢复后恰好一次；原 wake 未决 no-op；dup/query/迟到 ack 不重复扣退；过期不续票（票据期限早于配额恢复要提示会过期，不自动延票/新 key）；marker 无正文/header/q/token；并发只一新增执行；已 context 处理不添 turn；after-call 异常 consume tombstone；`action:"query"` 全程零副作用。**默认 on 回归**：§2 基线中 `fabric-wake` 五套件 + `fabric-xs-lifecycle` + `fabric-xs-reply` + 既有 `fabric-xs-activation` 原样全绿；stack-teardown-matrix 绿。

### P4 — web UI（1 个包，与 P1–P3 并行）

文件域：

- 新 `src/web-hub/ui/src/logic/xsRequestState.ts`：按 session/进程/messageId/revision 归并；HTTP/ctl/snapshot 乱序不退 phase；generic unconfirmed 不覆盖远端证明；hub restart 关系丢失 ⇒ unavailable；本地历史非恢复授权。
- `src/web-hub/ui/src/logic/control.js` + `useControl.ts`/`useHub.ts` + `contracts.ts`：消费 `StatusInfo.xsRequests` 与 `cmd_result.mention.session` 的 progress/messageId 引用（新 cap 门；旧 peer 完全剥除 ⇒ DOM 连空容器都不加，byte-identical）。
- `src/web-hub/ui/src/components/control/QueueList.vue` 旁轻请求区域（不建全机任务面板）：主行英文 token 四 phase/unknown/not delivered + reply 状态 + `wake↓ <reason>` 并列；中文解释证据；activate 按钮须三端 cap + key 有效 + delivered 未 started + online（服务端复验），singleflight 原 key，unknown 只 query，quota 显示 retryAfter/期限不自动执行；业务 key 稳定（双击/刷新/新 cmdId 不重复计费）。
- `src/web-hub/ui/src/components/transcript/TxCustom.vue` + `logic/xsMessage.ts`：接收卡片正文格式不变；新 status/host metadata 紧凑徽标（`deliver · wake↓ pair_wake_rate`，英文 token）+ 中文详情；真实 xid→entryId 才附着卡片，缺 entryId 列请求区域；`parseXsMessage` 只读首行的契约不动，body 文本写 wake/reason 不得污染状态。
- `src/web-hub/ui/src/components/agents/agentCardModel.ts`：新 cap 镜像常量；无 cap 不渲染。
- i18n：惰性命名空间（`alias-extra.ts` 先例）新 `xs-extra.ts`，不进 detail.ts 主包。
- mention 两分支**断言**（实现与 `src/web-hub/agent/commands.ts`/`onSessionRouted` 端口属 P2 唯一 owner，本包不写后端文件）：按 P2 冻结的端口契约验收——onHandled(rawText) 一次 report 保留（58f850a0 不动、旧签名不变）；新 cap 下 `onSessionRouted` 透传 message/progress 引用；同步 web 分支以确切 frame.id consumed + message 关联（不依赖 onInputHandled 文本匹配、不等本地 message_start）；legacy observed 回执保持；route throw 按 pre/post-send 证据（pre 证明才 none，否则 unknown）；30s CAS 不覆盖。

验收：off/legacy DOM 逐字节（空容器都不加）；cap on 全套渲染；activate 按钮门全部生效；SSE 重连/reply timeout/quota 到期不自动 activate、不签 grant；错 session 丢弃。

### P5 — 集成、门禁与文档（root 编排，可再拆子包但串行）

- `tests/integration/helpers/fabric-xs-process.ts`：新环境旋钮 `XW_ACTIVATION_OFF` / `XW_HUB_ACTIVATION_OFF`（配置面）与 `XW_STRIP_STATE` / `XW_HUB_STRIP_STATE`（wire 剥 cap，stripAliasV2OnWire 先例）——唯一 owner 一次性加入。
- 新集成：`tests/integration/fabric-xs-progress.test.ts`（真实 hub child × 2–3 stacks：queued→delivered→started→replied 全链、降级原因链、乱序/重连补发 ≤256 最新 state 分帧 metadata 绝不重正文）、`tests/integration/fabric-xs-activation-wake.test.ts`（activate 端到端：幂等、配额、marker 形状、B1 复用、reload 不重置、restart 资格失效）、`tests/integration/fabric-xs-activation-compat.test.ts`（old/new hub×agent 四组合逐字节 + key 序；复用 channel-compat 锚定法）。串行 boot（UUIDv7 ref 16ms 冲突规避沿用）。**命名区分**（reviewer 建议级）：既有 `fabric-xs-activation.test.ts` 是 extension activate() 的 tool-surface 注册套件，与本特性无关；两个新文件头部注释首行写明各自范围（wake_session 幂等激活端到端 / 混合版本兼容），并显式标注与既有 tool-surface 套件的互补关系；本包顺手给既有 `fabric-xs-activation.test.ts` 头部加一行 scope 注释（只加注释，不改断言）。
- conformance `tests/conformance/fabric-xs.test.ts` 追加 **C-X13**（state/progress 卫生：started 证据语义、marker/控制动作与 details/token 不进 provider payload、reason 枚举 token 形状）与 **C-X14**（activate 真实 pi：幂等 at-most-once 有效 trigger、B1 对控制 marker 照常验、过期/失形 abort 不复制正文 fallback）；与 C-X1…C-X12 同跑。pi peer bump 前全套 + legacy pi 1.0.4/1.1.0（`PI_TOOLKIT_LEGACY_PI_DIR`）+ C-P1–C-P5 重跑。
- governance：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 由本包集中刷新 activate-trace（声明变更：wake_session 注册 + 新 input/tool_call 接线顺序）；`tests/config/__corpus__` 两个文件同步刷新（唯一 diff = 新开关 key），commit message 写明原因（B 级契约 golden 规则）。
- off golden 回归：三个 xs off golden + secure-off + legacy-xs-v071 diff 必须零变化（P0 的测试配置改造是唯一触点）。
- 默认 on 全量回归（reviewer major-2 闭合）：§2 基线清单**全量**在默认 on 下复跑全绿——XsHarness 九套件 + sandbox-home 六套件 + 直驱六套件，逐套以原设置（不写 `activation.enabled`）运行；任一红按 Tier 2 分诊，禁止靠给旧套件补 off 配置过关。
- 收尾门禁：root 跑 `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web` 全绿；`git diff --quiet origin/dev -- tests/fixtures/` 逐包核对。
- 文档：`docs/dev/fabric-cross-session/README.md` 增新小节（四阶段轴、grant、wake_session、caps、门禁清单、已接受残留），`docs/dev/web-hub/README.md` 补 hub 侧事实（activation 服务、audit 键、配额口径）；AGENTS.md 表行只加指向，不回写细节。完成后 arch 标注「已实现」状态。

## 4. 端到端状态机落地核对表（每包自验用）

arch §4.2 全表逐行可测，实现时按行对号：none 预拒（可修正后新 send）；send 后 deadline/link loss/ack mismatch ⇒ unknown 只读查询；busy ⇒ unknown/queued（原意图 wake 记 receiver/busy 降级）；idle leaf 匹配 ⇒ applied/delivered（deliver-only 或真实原因）；queued 后 branch 确认 ⇒ 新 revision 升 delivered（旧 ack 不改）；Controller 接受/压缩中 ⇒ dispatch_accepted（root 预算已开始，非 started）；BAS 绑定合法 token 无正文证明 ⇒ 仅 authorizedAt；合法 context 含正文 xid ⇒ started（不承诺 provider 成功/回复）；optimistic 失形/无授权 abort ⇒ 保留真实写入证据 + host/host_unsupported + ended=aborted；合法 reply 确认写入 ⇒ replied；root deadline/abort/stuck ⇒ ended 保留 phase；reply dueAt ⇒ timed_out 不自动 activate；new/fork/switch ⇒ unavailable 不继承；reload 同 sid 纯数据恢复；hub/pi 重启/tracking 满/扫描超限 ⇒ 已知保留其余 unavailable。

## 5. 必测矩阵（分包映射）

arch §6.3 全表为强制门禁，此处给出包归属：

- P0：I10 混合版本逐字节/key 序（四组合）、off golden 零变化、新 schema strict、16 KiB 预算、boundary 白名单。
- P1：phase/effect 全行（none 预拒、unknown 运输、queued→delivered→started、direct delivered、reply 跳跃、乱序不退、timeout 不造 none）；有界（64/256/1024 满不驱 live；2000 扫描超限 unknown；observer 卸载/timer unref；重连 metadata 有界无正文）；期限/生命周期（3/5/8s 嵌套、root 900s 含压缩、断线 unknown 不起进程、reload 不补时间、迟 token B1 abort）。
- P2：来源（TUI/RPC/web、extension 伪源全系、busy 新 input 不授旧调用）；U5 链（共 ref、并行 CAS、pre/post 释放消费、无继承）；默认三值组合；#14（pair 2 格满 ⇒ hub pair_wake_rate；JSON/hint/audit/mention/卡片同因；不误判传输 bug）；其他原因（sender level/wake off、hub outbound、receiver policy/busy/goal/root0/cap/inbound/ledger full；异常保因、host 后 abort 独立）。
- P3：人工/quota（pair 满拒无 marker 不扣新 wake、retryAfter 准确、原 key 一次、未决 no-op、dup/query/迟 ack 不重复扣退、过期不续）；去重 property（正文有效 dispatch ≤1；每 message 可能有效 activate ≤1；同 key 并发/伪新 key/多 message 同 target/ack loss/reentry/after throw/host none）；不重复（原 text 一份、marker 无正文/header/q/token、inbox/unread 一次、并发只一执行、已处理不添 turn）；reply（unknown 消费不 replied、写入才 replied、late quiet、timeout/invalidated 不重投）；query 纯读全行。
- P4：UI/循环（双轴展示、unknown 无 resend、业务 key 稳定、quota 不自动执行、错 session 丢、SSE/status/reply/timeout 不签 grant 不 wake）；mention（handled 一次、同步 web 精确 cmdId consumed + 远端状态、31s 无误报、none/throw 边界、native/hold/off 不变）。
- P5：权限/I10（channel/allowFrom/block/fence/current policy 重验、错 from/rid/key/xid 拒、activate 用当前 level、secure/child 无入口、default/channel/alias/reply off 组合、PROTO/golden 不变）；真实 hub/pi 与 provider stub 执行计数；pair 条件受控复现用**新测试请求**，不重发用户原正文。

## 6. 验收标准（root 裁定口径）

1. 六项裁定行为全部可演示：四阶段与效果分轴展示；人类 mention/grant 代发 expectReply 省略 wake 默认请求唤醒；agent 间默认 false；降级原因四处（tool hint/audit/receiver/web UI）一致且为真实原因；wake_session query/activate 语义与幂等、配额、原 key 人工重试不重复计费全部符合 arch §4.4–§4.6。
2. 证据：两例历史 `pair_wake_rate` 不再被展示为传输失效；受控复现走新测试请求；无正文重投、无第二 runner、无自动 wake 循环。
3. 回滚：`fabric.crossSession.activation.enabled=false` + `/reload`（hub 侧 `/webhub restart`）后，off golden/secure-off/legacy diff 零变化；旧 hub×新 agent、新 hub×旧 agent 逐字节兼容（I10）。
4. 门禁：format:check / typecheck / test / build / build:web+check:web 全绿；governance trace 与 config corpus 为声明刷新且 commit 说明原因；C-X1…C-X14 + C-P1–C-P5 + legacy pi conformance 通过；stack-teardown-matrix 与 boundary 测试绿。
5. 文档：fabric-cross-session 与 web-hub README 反映新事实与门禁；无遗留「待拍板」项——工程窗口/容量如需调整由 plan 评审消化，变更泛唤醒/持久授权/quota 豁免/grant 复制/正文重投范围必须停工上报 root 走 ask_user。
