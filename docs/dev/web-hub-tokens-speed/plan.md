# Web Hub · 助手回复 tokens/s 方案（task58，L2，方案阶段，不含实现）— r3.1 / Root gate

> baseline: `33b96ffc`，pi SDK peers `1.5.0`。r2 经两轮方案/异源 review 后，Root 按
> dev-flow 收敛规则集中裁定。本轮只闭合 `r_TZM9KYF9` 的 5 个真实 Blocker，不重新全架构，
> 不增加产品范围。本轮仓库内只编辑此文件；交接为 `/tmp/tokens58-plan-r3-handoff.json`。
> r3 作者不自评通过，最后由 Root 人工核对下列明确技术点，不开第四轮大评。

## 0. 已定口径与处置表

### 0.1 用户最终拍板（禁止改变）

1. **排除首字等待**：生成窗口为首个至最后一个非空生成 delta，不用端到端耗时兜底。
2. **含思考，且只有完整可观测才显示**：text、thinking、toolcall 参数 delta 全部计入。
   部分 thinking/summary 不等于完整原生思考；unknown 必须隐藏，不制造假精确。
3. **主 session metadata 持久化，刷新保留；child/run 详情仅 live；旧历史不回填**。

Root 已裁定、r3 不重开：至少 2 个非空 delta 且跨度至少 500ms；B1 删除、只用 B2 显式
`mid`；recent 不兜已磁盘对账历史；webHub off 的挂载语义、`tokens/s` 单位、费用独立显示、
streaming 无数字。保留三包 DAG，不加 6 包、图表、收费 benchmark 或 child 持久化。

### 0.2 原 review 8 项处理表（r3 替代 r2 的过早 closed 声明）

| 原项                        | 处理                                                                                               | r3 定稿位置 |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| 1 分子/分母与完整 thinking  | 非空 text∪thinking∪toolcall；删除 normalized reasoning=0 自证；仅 raw 正向 proof A；B 本期恒 false | §2、§3      |
| 2 首包偏差/阈值             | 固定 count≥2、span≥500ms，不调参、不 token 修正                                                    | §2          |
| 3 B1 关联错误               | B1 删除，持久化仅公开 turn_end.messageEntryId 显式 mid                                             | §4.3        |
| 4 secure/session/owner 写入 | 当前 ctx + session generation + 活有效 ownerToken + 同步 secure recheck，未知清槽                  | §4.3        |
| 5 生命周期/身份             | 直接记录 SDK turnIndex；loop generation 防重复 0；最终对象引用为强制条件                           | §4.1        |
| 6 recent 覆盖范围           | live 当场发；刷新仅已校验 custom entry；child 不承诺刷新                                           | §4.2、§5    |
| 7 字段与信任边界            | 单容器 piToolkitGeneration；pure core sanitizer + 持久 mid；显式 map cap                           | §5          |
| 8 I9/消费/UI                | off 不挂载；主/child view 都消费；费用独立、tokens/s、streaming 隐藏                               | §6          |

### 0.3 本轮剩余 5 项闭合表（仅此范围）

| r_TZM9KYF9 余项                      | 集中裁定与闭合                                                                                                                                 | 证据/实施门                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 normalized 0 非正证据/正向可用路径 | raw completed usage 自有属性 reasoning_tokens 严格为 0；公开 response.id↔AssistantMessage.responseId 可关联；一次性 proof port；B 本期恒 false | §3、§8；真实 SDK + fake SSE 正/负断言已运行；P0 必须扩为完整隔离与显示门 |
| 2 turnSeq 冒充 SDK index/引用可选    | 不再有 turnSeq 对比；记录公开 turn_start.turnIndex；owner/session/loop/message generation + 最终 AgentMessage 同引用强制匹配                   | §4.1；SDK 真引用传递源码与探针已核                                       |
| 3 message_end 与 turn_end 时机矛盾   | message_end 同步计算/校验/盖 wire 副本/emit；turn_end 只补 mid 和 guard 后一次性落盘                                                           | §4.1–4.3；不匹配只影响持久，不撤销 live                                  |
| 4 exact owner 与 map 有界            | 显式 ownerToken 身份、sessionId/generation、activation generation；append 前当前 ctx 与同步 recheck；历史 map ≤512 当前 loaded entries         | §4.3、§5.3；now/epoch 单独均非身份                                       |
| 5 字段契约漂移/输入伪造/双向兼容     | 所有消息唯一容器 message.piToolkitGeneration；core 与持久 mid 分层，统一数界；先剥输入，后本地/可信 custom entry 盖章                          | §5、§7；新旧双向用例，冻结 fixture/PROTO 不变                            |

## 1. 已知代码边界（沿用 r1/r2 已核事实）

- UI 显示点：`TxAssistant.vue:34,73-76` 的 msg-meta 费用行；`entries.ts:27-33,114-131`
  的 AssistantView/assistantView。不改费用计算。
- `event-tap.ts` 原始 onMessageUpdate 在 50ms delta 合并前；在这里记录单调时钟，避免合并
  改写观测窗口。message_start/update/end、turn_start/end 已在现有事件路径。
- public 扩展 `TurnEndEvent` 有 `turnIndex`、`message`、`messageEntryId`；裸 agent-core
  的 turn 事件没有 index/mid。必须接扩展事件，不能从裸事件臆造字段。
- `WireMessage`/`WireEvent` 有开放字段，只 append optional 容器，不升 PROTO。
- `protocol/keys.ts:100-113` reconcileRecent 剔除已被 branchTail 按 messageKey 命中的 recent；
  不能靠 recent 承诺已落盘消息的刷新恢复。
- `tool-timing.ts` 仅是 custom entry 零渲染的形状先例，**不是安全写入先例**。
  `command-record.ts:374-396` 有 recheck/session 校验，但本功能异常必须 skip，不能沿用其
  throw 视为可写的策略。

## 2. 指标与不可变边界

分子固定 `AssistantMessage.usage.output`，不估、不加减 reasoning。分母固定
`genMs=tLast-tFirst`，时间戳在原始摄取点响应非空 `text_delta`/`thinking_delta`/
`toolcall_delta`；起止 block/end 事件不算 delta。用 `performance.now()` 的 DI 默认时钟，
不是功能开关。`tokens/s=tokens*1000/genMs`。

全部满足才显示：完整订阅到本条 assistant 的 start→end；§3 正向 proof；无 redacted；
finite 且合法的 usage/output、时间与计数；`deltaCount≥2`、`genMs≥500`；非 streaming。
无 delta、一次性返回、短窗口、未知 proof、异常时钟均 hide，无端到端 fallback。
固定边界 `deltaCount∈{0,1,2,3}` × `genMs∈{0,499,500,501}`；不按分布调参，
不做首包偏差修正。极大首包使窗口偏快，是披露的 client 可观测局限，不是 GPU 吞吐。

abort/error 若没有成功 completed 的正向 proof 自然 hide；即使 turn_end 不到，已发 live
不撤销，仅不持久。重试/新 assistant start 丢弃旧观测与待写槽，只测新的完整尝试。

## 3. 完整可观测性：真实 SDK 能力与一次性 proof port

### 3.1 核验结论与显示条件

**`usage.reasoning === 0` 绝不是证据**。SDK `openai-responses-shared.js:502` 使用
`response.usage.output_tokens_details?.reasoning_tokens || 0`，缺失也归一为 0。
`Usage` 是归一结果，不能反推出 raw 是否明确报告。

本期证据 A 收窄为：来自已核验 Responses 语义的**归一化前**公开 provider stream event，
严格 `data.type === "response.completed"`，且 `response.status === "completed"`；
`response` 自有非空 id，`usage` 自有 `output_tokens`，`usage.output_tokens_details` 自有
`reasoning_tokens`，后者为 number 且严格等于 0。每层只接受普通数据属性（拒绝原型继承/
getter 等非数据形状），不做 truthy/default/coerce。raw output_tokens 必须是合法正整数，
与最终 usage.output 精确相等。**缺失、null、unknown、normalized 0 均 hide**。

同时要求本条没有 thinking/summary 迹象（任何 thinking block 或 thinking_delta；raw
reasoning/summary 事件、completed.output reasoning item 都为否决），没有 redacted 块，
并且 start→end 订阅完整、responseId 不变。不能用 summary 文字推算 token，也不能把
summary+raw 0 矛盾响应判为可显示。raw 明确 0 的完整 text/toolcall 流是本期正向显示路径。
未知 API/raw 语义不套这个 parser；这是经过核验的事件结构/字段语义解析器，不是按模型
名称放行的名单，更不是看到 thinking 就放行。

**证据 B（full-native-thinking）本期恒 false**。没有本方案核验过的完整原生 thinking
协议；开发包无权凭文档、抓包、provider/model 名或零散 thinking_delta 自行放开。
reasoning>0、summary-only、不能证明完整的推理模型均隐藏；不承诺推理模型会出数。
未来改变 B 必须另行 Root/产品裁定，不属于本期实施包。

### 3.2 public 接口证据（不是拟造 SDK 接口）

- `pi-coding-agent/dist/core/extensions/types.d.ts:731-738`：public provider_stream_event 有
  provider/api/model/data:unknown；**没有 requestId 或 responseId 顶层字段**。
- `pi-coding-agent/dist/core/sdk.js:240-251`：将 adapter 回调的原始 data 原样交给该扩展事件。
- `pi-ai/dist/types.d.ts:382`：最终 AssistantMessage 有 public `responseId?: string`。
- `openai-responses-shared.js:530-533`：先 await onProviderStreamEvent(event,model)，再归一；
  created 写 output.responseId；`:489-502,684-685` completed 的 response.id 写同一公开
  responseId，usage 在其后归一。`openai-responses.js:156-158` 转接 public 回调。
- Codex SSE 路径 `openai-codex-responses.js:537-570` 在 map 归一前回调 raw，再 map 到
  completed；不能误用 map 后补默认值证明 raw。未知 event 类型仍 hide，不扩新 provider。

因此存在 public `raw response.id ↔ final AssistantMessage.responseId` 关联；无需改 SDK、
新建 provider 目录、真实付费 API 或捕捉用户流量。

### 3.3 最小一次性 proof port 与并发隔离

**r3.1 Root gate：保留 tap 内部 delta-only 硬边界。** `event-tap.ts:5-9,148-183`
规定 onMessageUpdate 不访问 `event.message` 或 assistantMessageEvent 的 partial/message/error
累积快照。计时/count/kind/delta 继续沿原始 delta 管线，不为 proof 读取这些快照。

仅在 **host/observer 接线层**新增极窄身份元数据适配：用公开
`Object.getOwnPropertyDescriptor(event, "message")` 取得 own data value，再逐个用 own data
property descriptor 提取该对象的 responseId/provider/api/model 标量；拒绝继承、accessor、
非字符串/超界值，descriptor 操作（含 Proxy trap）抛错捕获为 binding 缺失。绝不调用 getter，
不读 content/usage，不 spread/枚举/序列化 snapshot，也不把整个 snapshot 交给 tap/proof port。
这是**有意新增的外层元数据只读行为**，不修改 SDK 对象，不放宽 tap 的内容来源不变式。
缺失/不安全元数据只使本条 proof 失效、speed hide；原始事件仍无条件沿既有 delta-only
管线转发，适配失败不能 return 掉转发或断流。

外层提取的 binding 必须与同一事件的 delta 同步提交（同步调用栈、先绑定再处理该 delta，
不异步缓冲），并附当前 owner/session/loop/turn/message generation；可用一次性调用关联
序号供 port 消费，不得把“上次 binding”当本次缺失 binding。kind/delta 仍只从原管线取；
本地 proof port 接收已拷贝身份标量，tap.onMessageUpdate 本身不读上述 snapshot。

包 1 在既有 web-hub activation 路径注册 public provider_stream_event handler，将其接入 tap
的只读观测入口（这是**本地拟新增 port**，不是声称 SDK 已有的方法）。child/run 若没有
同等公开 raw port 能力就 hide，不因仅 live 而放宽 gate；本期不拓 child 落盘范围。

port 不保存原始 response/body/headers/secret，仅复制必要标量与拒绝标志。最多一个 proof
候选，属于当前完整 GENERATING 槽；key 为：
`{sessionId, sessionGeneration, activationGeneration, ownerToken, loopGeneration,
turnIndex, messageGeneration, responseId}`。ownerToken 是对象身份，不序列化。

1. 只有已观察到有效 turn_start + assistant message_start 的槽可接收 proof。用上述外层
   own-data 标量适配得到的**本条 delta 同步 binding.responseId**锁定 activeResponseId；
   tap 不读取 message_update.message。id≤256，后续更换或缺失使本条无证据；不能沿用前次
   binding。message_start 的对象是浅拷贝，不用于最终引用匹配。
2. raw completed 仅在当前 owner/session/loop/turn/message generation 仍有效，且 raw id
   等于 activeResponseId，provider/api/model 与该 assistant 公开值一致时，解析标量候选。
   不缓存别的 response 的完成事件，不用“最近完成请求”兜底。无 delta id 的 late/raw 先到
   场景不建证据。summary/reasoning 标志用本条原始 thinking delta kind、message_end 最终
   content 及能精确归属该 id 的 raw 信息共同否决；不读 update 累积 content/usage，不能归属
   时不据此产生正证据。
3. nativewarmer/其它请求可能与主流重叠，**不能仅按时间、session、provider/model 归属**。
   不同 id 的 raw 不得覆盖当前候选；同 id 重复 completed/冲突 proof 判歧义、整条 hide。
   流中别的 response.created 不改 activeResponseId。信任 provider 的响应 ID 唯一性；无法
   验证/ID 被复用导致歧义时 fail closed，不发明未公开的 request owner 接口。
4. message_end 消费候选一次：再次核对全部 key、最终 responseId/usage/provider/api/model、
   无 summary/redaction、时间/计数边界；复制出纯 core 后立即清 proof。所有 reset/新 start/
   owner 撤销/settled/dispose 都清它，不跨消息、跨 session 或跨 activation 复用。

### 3.4 P0 能力门（包 1 先跑，不增加第四包）

本轮已在 `/tmp/tokens58-r3-probe.mjs` 用真实 SDK 1.5.0 Responses adapter + agentLoop，
注入 fake fetch 返回内存 SSE，断言：raw explicit0 与 raw 缺失最终 normalized reasoning
都为 0；仅前者 own-property 为真；两条 delta 的公开 responseId 与 raw/final id 相同；
message_end/turn_end 为同一最终对象。结果 `/tmp/tokens58-r3-probe-result.json`，全部通过。
探针没有运行产品实现，也未测试真实 provider 是否一定上报字段；无真实网络/收费。
r3.1 探针的每条 update 身份改为上述 own-data descriptor 标量提取，不再直接访问
`e.message.responseId`；额外用当前真实 tap 验证 event.message 与 partial/message/error 的
throw getter 均零调用、delta 输出原样。外层拒绝 inherited/accessor/throwing descriptor，
仍转发原 delta；content/usage getter 也零调用。这些是适配能力与既有 tap 行为探针，
不是对尚未实现的产品计时/proof 接线自评通过。

实施前 P0 必须把这个正向能力接到 public extension port + tap：两次非空 delta、注入
单调时钟跨度 500ms、raw explicit0→message_end 当场**真有数字**→匹配 turn_end 持久 mid；
并验证缺失/summary/redacted/nonzero/不同 id warmer/重复 id/owner 换代都 hide 或 skip。
P0 还必须断言新增计时逻辑在 event.message/partial/message/error 为 throw getter 时从不
访问它们，原 delta 输出与计时 count/span 仍正确；host 元数据缺失/getter/descriptor throw
仅 hide 且流不坏。warmer 的不同 ID completed 在本条 binding 前/后、跨 delta 插入，都不能
覆盖或复用 binding；每条 delta 的同步关联与最终 ID 强匹配仍须成立。
不能只测“没抛异常”，不能把全 hide 当完成。若完整公开链条不能产生正向数字，包 1 停工
上报 Root 为能力不足，不交一个永远无数字的功能，更不放宽 proof/B。当前 SDK 能力探针
已找到可实现正向路径，但不等于产品 P0 已通过。

## 4. 生命周期、live 时机与持久写入

### 4.1 身份与单槽状态机

显式 identity：sessionId、sessionGeneration（每次 session reset 单调递增）、activationGeneration
（本次 activation 独有）、ownerToken（有效持有者对象）、loopGeneration（每次公开 agent_start
递增）、SDK turnIndex、messageGeneration（每次 assistant start 递增）。**不使用本地 turnSeq
冒充 SDK turnIndex**。公开 turn_start.turnIndex 原样记录，非负安全整数；首次通常是 0，
agent_start 后 SDK 又重置为 0，因此必须组合 loopGeneration，而不是把 index 当全局序号。

```text
EMPTY --合法 turn_start 后 assistant message_start--> GENERATING{identity,tFirst?,tLast?,count,proof?}
GENERATING --原始非空 delta + 外层同步标量 binding--> 更新时间/count；proof port 核对 responseId
GENERATING --assistant message_end--> 当场计算、校验、剥容器、本地盖 wire 副本、emit 一次
    成功: COMPLETED_PENDING{identity,finalMessageRef,core}（只待主会话持久）
    失败: EMPTY（照常发原消息 wire 副本，但无容器）
COMPLETED_PENDING --匹配 turn_end--> take-and-clear；核对/guard/append 一次；EMPTY
COMPLETED_PENDING --不匹配 turn_end--> 清空，不持久；已发 live 不撤销、不重发
任何状态 --新 assistant start / session reset / agent_start / agent_end / settled / dispose /
            owner 撤销--> 清旧槽/proof；新 start 仅在合法 turn 身份下开新槽
```

turn_end 必须同时匹配完整 identity 的当前有效值、原样 SDK turnIndex，且
`turn_end.message === pending.finalMessageRef`。**无引用或不一致必须 skip**，内容/timestamp/
responseId 相同都不能替代对象身份。finalMessageRef 只从最终公开 message_end 取，不能从
message_start 或 update 的浅拷贝取。非 assistant end 不触碰助手槽。

真实 SDK 引用证据：agent-loop.js:325-326 发出 finalMessage 并原样 return，:144-156/185
用返回的 message 发 turn_end；agent-session.js:519-525 直接传 message 到边界，:948-953
直接传到扩展 message_end，:896-908 的 replacement 以原对象就地替换保持引用。引用核验
是运行时硬条件，不是“以后测试成立再加”的可选断言。core 探针也断言了 ===。

首次 turnIndex=0 正常接受；下一 loop 又 0 但 generation 不同；new/session/reload 全部清空。
late subscription 若未亲眼见到该 loop 的 agent_start/turn_start/start，或 midstream 只见
update/end，均不补建槽。新 tap 在下一个完整 agent_start 才 armed；宁可丢本轮，不猜 index。
同 loop 中新 turn_start 替换 turn 身份并清未完成值。整套最多一生成槽+一待写值（状态互斥），
无队列/新 timer，不以时间戳当身份，I1/I5 不变。

### 4.2 live 必须 message_end 当场 emit

在现有 message_end handler 投影 wire 副本时完成计算、sanitizer 和本地盖章，**该 handler
当场 emit message_end 并 recentRing.push**，不等待 turn_end，不延迟/重发消息。绝不修改
SDK AgentMessage 原对象，避免 metadata 被当作 SDK/provider 输入持久化或污染上下文。
只保留相同 finalMessageRef 的 pending core。child 在这条 live 路径消费，绝不 appendEntry。

live 仅承诺 emission 时在线接收者；reconcileRecent 对磁盘已命中消息不补字段。主会话刷新
仅依赖 §4.3/§5 的 metadata；child 刷新消失是预期。turn_end 不匹配/不到不撤销已发 live。

### 4.3 主 session：B2 显式 mid 与 exact-owner 写入

customType 定为 `subagent:web-msg-speed`，data 为
`{piToolkitGeneration:{v:1,mid,tokens,genMs,deltaCount}}`。只有匹配 turn_end 公开
`messageEntryId` 可提供 mid；B1 相邻/上一条/内容推断已删除，永不回填旧历史。

take-and-clear pending 后，append 前同步执行，任何缺失/异常/不确定 skip，不排队重试：

1. 用注入的 **getCurrentContext()** 取得执行当下 ctx（本地依赖 port，不是臆造 SDK API）；
   缺失/抛错 skip。由 ctx.sessionManager 的公开当前 session ID 校验 pending.sessionId。
   当前持有者记录 sessionGeneration/activationGeneration 必须与 pending 精确相等。
2. 接线持有者维护一个**对象 ownerToken**；当前 owner port 必须返回同一个有效 token，
   owner 仍 active/not disposed。重挂载/接管/reload 先 revoke 旧 token，再建新 token；
   session reset 换 generation 并清所有 pending/proof。时间 now 不是 identity，epoch
   相同也不足以证明当前 owner；不得拿 moduleInstance 的时间数值替代对象身份。
3. 必需注入同步 `deps.secureRecheckForWrite(ctx)`，返回 undefined 才继续；缺依赖、LOCKED、
   throw 或意外 thenable 都 skip。紧接着复核 current owner/session/generation，随即同步
   `pi.appendEntry`，两者之间没有 await。append 抛错即丢弃，不保留槽。

零渲染、不进 LLM 上下文，沿用 custom entry 机制注册空渲染器；需要新 customType 的
conformance 断言，不能把 tool-timing/cmd-history 的现有测试当本功能证明。

## 5. 唯一容器、pure sanitizer 与有界历史

### 5.1 契约（全文唯一命名）

- 消息 wire：`message.piToolkitGeneration = {v:1,tokens,genMs,deltaCount}`（shared core）。
- 持久 custom entry：`data.piToolkitGeneration = {v:1,mid,tokens,genMs,deltaCount}`，mid 必需。
- 投影 custom WireEntry：`entry.piToolkitGeneration` 为同一已校验持久形状；不是另起 speed/
  genMs 顶层字段。历史折叠到消息后只有 shared core，不把 mid 当 live 必填。
- UI view 只从 `message.piToolkitGeneration` 构建可选展示值；不造第二套 wire 名称。

protocol 边界内提供**一个 pure core sanitizer**，live/历史/UI 均复用：只接受对象自有数据
属性，`v===1`；拷贝白名单生成新对象，不透传额外字段。持久 wrapper 先调用此 core，再
单独验证必需 mid。core 不需要 mid，持久不能省 mid。

| 字段                                        | 固定校验（数界一致，不各包自选）                                       |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| tokens                                      | finite 安全整数，1…10,000,000                                          |
| genMs                                       | finite number，500…86,400,000ms；允许单调时钟小数，不强行取整          |
| deltaCount                                  | finite 安全整数，2…1,000,000                                           |
| v                                           | number 严格等于 1，不 coercion，不接未知版本                           |
| mid / responseId / sessionId（关联所用 ID） | 非空 string，≤256 UTF-16 code units，拒绝控制字符；不 trim 后匹配      |
| ratio                                       | tokens*1000/genMs 为 finite 且 >0；非法整条 hide，不夹断、不返回半成品 |

这些是防异常的保守上界，不是调优阈值。超限 hide；新增版本另议，不扩大本期。

### 5.2 信任边界：先剥、再盖章

live 与历史的 SDK 消息投影**先在 wire 副本显式删除 piToolkitGeneration**，无论形状
看起来多合法都不信任；严禁 spread 后保留输入容器。只允许本地通过 §3/§4 观测的 core，
或已校验指定 customType 的持久 metadata 重新盖章。不能从 SDK 同名字段“恢复”速度。
custom entry 也只投影白名单新容器，乱版本/乱 mid/非法数字不盖章。历史没有匹配 metadata
则无字段，不能从墙钟、相邻 entry、usage 或 recent 反推。已校验 custom entry 是持久信任
边界，不声明能防拥有 session 文件写权限者篡改文件。

### 5.3 历史 Map 真正有界（与观测单槽不是一回事）

每个当前 session/run 视图只对 **当前 loaded entries** 建 metadata Map，cap 固定 **512**。
键为精确 mid；只匹配 loaded assistant entry.id，不跨 session/run、分支或文件。超过 cap
按 loaded entry 顺序只保留最后 512 个合法匹配，较旧项隐藏，不另读全文件找速度。

每次 snapshot/replace/remove/branch change 从当前 loaded entries 清空重建；增量 append
也受相同 cap 和 loaded assistant 集约束，不无限记忆已删除 mid。custom entry 与消息到达
顺序可不同：只在当前 loaded 集内重算，不靠“上一条”绑定。重复 metadata 对同一 mid：
最后一个合法 custom entry 生效；非法项忽略；删除/replace 后重新按当前集决定，不留下
旧值。session/run 切换/dispose 清 Map。消息投影先剥容器，即使同一 mid 旧盖章值仍在输入
副本也不能在 metadata 删除后残留。map 不持有 SDK 引用，不新增 timer/模块可变全局态。

## 6. off/UI/兼容（已裁定，不重开）

- webHub.enabled=false 不挂载新 tap/proof handler/持久路径，既有 off 行为 byte-identical；
  不新开设置键。`monotonicNow` 默认是 DI，不是开关。
- 主 session（live+历史）和 child（仅 live）的 entries.ts/AssistantView 都必须消费唯一
  容器。streaming===true 始终隐藏 speed；只在完成后的盖章消息显示。
- cost 与 speed 两个 span 独立 v-if；无 cost 仍能显示 speed，无 speed 不影响 cost。
  固定单位 `tokens/s`，例如 `12.4 tokens/s`；不是 t/s。移动端 ≤767px 不重叠。
- 旧 hub × 新 agent：开放容器可转发，旧 UI 忽略，不崩溃、不改变旧字段/PROTO；
  新 hub × 旧 agent：缺容器/无 custom metadata 就隐藏，费用/历史/streaming 行为不变。
  两向都要显式用例，不能只写一向；不更新任何冻结 fixture。

## 7. 实施门与三包 DAG（只细化 5 项，不加包）

### 包 1：agent 核心，单一 owner（先 P0）

文件域：`src/web-hub/agent/{event-tap.ts,index.ts}`、tool-timing 旁持久化姊妹文件、
`src/web-hub/protocol/` 的 pure core sanitizer/keys（共享热点同一 owner），对应
`tests/web-hub/{agent,protocol}/`。先读 web-hub/secure README，保持 pi-free 边界。
公开 raw proof 接线只能走既有 activation/webHub 路径；若确需越过该文件域，先报 Root，
不能悄悄在 SDK/新 provider 里绕门。

交付：§3 P0 正向显示门 + raw unknown/summary/normalized0 负门；§4 最终引用/turnIndex/
owner 状态机；§5 shared contract/sanitizer/有界历史投影。类型就绪供包 2 消费。

### 包 2：前端，消费包 1 契约（可 mock 先行）

文件域：`ui/src/components/transcript/{TxAssistant.vue,entries.ts,tool-index.ts}`、
`ui/src/{format.ts,contracts.ts,logic/state.js}` 与对应 UI 测试。只用协议 pure sanitizer，
不反向 import agent。实现主/child 同容器消费、独立费用、单位、streaming 隐藏与 map 清理。
共享契约由包 1 单写；热点 entries/state 不与其它在飞任务并发写。

### 包 3：集成/conformance/浏览器 + README 补档

依赖包 1+2；文件域 `tests/integration/`、`tests/conformance/`、
`docs/dev/web-hub/README.md`（**仅实施期**，本轮不改）。新测试 tier 声明按仓库门禁由 Root
集中处理共享热点，不增加无关测试/配置范围。

必须断言行为的测试门：

- 真实 1.5 SDK + fake fetch/provider：显式 raw0 正向出数，缺 raw 字段但 normalized0 不出；
  nonzero/summary/redacted/unknown hide，B 不可开启；warmer 重叠不同 id 不污染，同 id 歧义 hide。
- 首次 turn 0、同 session 下一 loop 再 0、session/new/reload 换代、late/midstream subscribe、
  重试、新 start 抢占、agent_end/settled/dispose 清空；message_end 最终对象 === turn_end，
  浅拷贝/无引用/错误引用/index 不符 skip 持久；message_end 当场只 emit 一次，turn_end 不重发。
- B2 mid、工具结果夹入、两条相同内容回复、abort/缺 turn_end；只正确 mid 得到历史盖章；
  未匹配 turn_end 不撤销已发 live。SDK agent-loop.js:148-158 的 error/aborted 分支仍 emit
  turn_end；持久 ID 无法解析时扩展边界不发（agent-session.js:507-513），因此不能依赖必到。
- 当前 ctx 缺失/抛错、session/generation 不符、旧 ownerToken（即使 epoch 相同）、LOCKED/
  recheck throw/thenable/缺依赖、append throw：skip 且 pending 清空；无明文 metadata 写入。
- sanitizer 数界/NaN/Infinity/非整数计数/版本/ID 长度/ratio；live 无 mid 可过、持久缺 mid 不过；
  SDK 伪造同名容器在 live/历史都剥离。Map 512/513、replace/remove、重复合法/非法、切 session
  不留旧值。custom entry 不进 buildSessionContext/provider payload。
- 新旧 hub/agent 两向兼容与 PROTO 不变，冻结 fixtures 不动；浏览器完成 live、主刷新保留、
  child live/刷新消失、旧历史不回填、streaming hide、独立费用、移动端布局。

Root 施工前做热点冲突检查。DAG 1→2→3；2 可在 1 契约产出后 mock 先行，不先于 1 合并。
实施验收跑精确受影响测试 + 仓库 typecheck/build/每日 tier1（限 workers），不让不同包并发
全量测试。本轮仅文档与 own /tmp 探针，不执行 fulltests/install/global/reload/git 写操作。

## 8. 源码坐标、证据强度与真正外部约束

r3.1 Root gate 额外核验：`src/web-hub/agent/event-tap.ts:5-9,148-183` 明确并落实
update 的 delta-only snapshot 禁读；本轮只读该文件、不修改。§3.3 的 host 标量适配是分层
修正，不是对该硬规则的例外。Root 已人工接受其余五项闭合，本轮不重开。

| 路径（均 node_modules/@earendil-works/ 下）     | 行号                      | 已核事实                                                           |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| pi-ai/dist/types.d.ts                           | 118、382                  | public raw 回调与 AssistantMessage.responseId                      |
| pi-coding-agent/dist/core/extensions/types.d.ts | 731-738、841-875          | public raw data unknown；turnIndex/messageEntryId；最终 message    |
| pi-coding-agent/dist/core/sdk.js                | 240-251                   | adapter raw data 转 public extension event，未补 usage 默认值      |
| pi-ai/dist/api/openai-responses.js              | 138-158、230-237          | 可注入 fetch；raw callback 转接                                    |
| pi-ai/dist/api/openai-responses-shared.js       | 489-502、530-540、684-685 | final id；缺 reasoning 归一 0；callback 先于归一；summary 独立类型 |
| pi-ai/dist/api/openai-codex-responses.js        | 537-570                   | Codex raw callback 先于 map；不把 map 后默认值当原始证据           |
| pi-agent-core/dist/agent-loop.js                | 144-158、185、325-338     | 最终对象引用贯穿 message_end/turn_end；aborted/error 也有 turn_end |
| pi-coding-agent/dist/core/agent-session.js      | 500-526、768-785、896-953 | mid 解析；落盘对象；替换保持引用；agent_start index 重置 0         |

本轮 probe 真实断言与结果见 §3.4；源码核对与 fake 流能力证明不是独立 review，也不是对
未来实现通过验收的背书。Root 最后人工核对 raw own-property/公开 ID 链、最终引用、
message_end 时机、exact-owner、单容器/数界五个点。

真正外部约束只剩：真实 provider 必须确实明确上报 raw reasoning_tokens=0 并提供唯一响应
ID；未知/summary/非零推理流不显示。fake SSE 已证明 SDK public 关联路径可行，但不能保证
某个真实模型/网关一定给这个字段；本期不以收费探针验证覆盖率。B 本期恒 false，无完整
原生 thinking 证据，不承诺推理模型出数。这不是许可交付全 hide：产品 P0 正向门失败必须
停工上报 Root，不放宽产品口径。其余需做的是实施测试门，不留“引用以后可选”等方案空洞。
