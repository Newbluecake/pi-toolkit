# 跨会话请求状态、可信人类代发与幂等激活架构

> 2026-11-04 · L3 architect · 最终架构契约，非实现完成报告。
> 基线：前置误报修复 `58f850a0` 已提交，本任务独立，不回退该修复。
> 2026-11-05：**已实现**（P0–P5 完成；验收记录见 `docs/dev/fabric-cross-session/README.md` 「P5 gates and acceptance」）。
> 调研：完整读取 `AGENTS.md`、`docs/dev/fabric-cross-session/README.md`、`docs/dev/web-hub/README.md`；核验 protocol、sender、receiver、RootWakeController、reply/wake/command ledger、mention 两条入口、调用链接线及 UI。旧计划仅作历史说明，冲突时以现行 README、代码和本次用户裁定为准。
> 本次仅写本文件，未改实现，未运行构建、测试、安装或运行探针。工作区其他任务改动不纳入设计。

## 1. 背景与目标

### 1.1 已拍板需求

| 编号    | 最终行为，不再作为开放问题                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------- |
| U1      | 跨会话进展拆成 `queued / delivered / started / replied`。                                             |
| U2      | 人类发起且有 `expectReply` 的请求，省略 `wake` 时默认请求唤醒；agent 间普通消息仍默认 false。         |
| U3      | 唤醒降级原因端到端显式展示，不能仅显示 `deliver`。                                                    |
| U4      | 新增幂等 `wake_session` / `activate`，不重复投递正文。                                                |
| U5（A） | **用户交代的 agent 代发也属于人类发起**：宿主沿真实调用链传递一次性人类授权，不能信模型自报 source。  |
| U6（B） | activate **仅关联已存在、已送达且未开始处理的 messageId/receiptId**；不做任意空唤醒或已处理请求重跑。 |

`wake:true` 是意图，不是必定启动的授权。人工或持有人类授权的代发仍受 receive、fence、quota、causal level、host capability、Controller 所有权及期限约束。

### 1.2 范围及不变式

- 三效果 `none / unknown / applied` 保留，与四阶段分轴；不将 queued 当作可重发或已启动。
- 不 bump `PROTO`，不改旧字段语义、closed schema、A-tier off golden、`legacy-xs-v071/`。新可选字段也需要 capability gate，不假设旧 decoder 忽略未知键。
- 覆盖 P2P message_session、TUI/web @session、关联回复、可信代发及既有请求激活。message_agent、广播、Thread、schedule、goal 自驱动默认值不变。
- 不自动重发正文、不自动周期 activate、不启动离线进程、不替用户 join/receive/fence reset，不做持久任务系统或跨进程 exactly-once。
- I1/I5：期限经 `clampSpanMs`，长延迟用 segmented Clock，timer 全部 unref，等待有界。
- I2/I3/I4/I6/I7：index 只组装，子会话无新 xs 工具；跨 reload 纯数据用 `Symbol.for("pi-subagent:*")`，不存 ctx/Promise/闭包，不改运行时旧名。
- I8：hub/protocol 不 import pi/fabric 实现；公共 shape 在 protocol，纯规则必要时按现行镜像约定共享，不放宽 boundary 白名单。
- I9/I11：xs off/secure 强制关闭无新 cap、hook、槽、工具、网络或磁盘路径。

### 1.3 两例运行证据及 #14 定性

Explore 已证实：`q0011be4d8364f39be6`、`q284b54002e05f8afd4` 两次显式 wake 均返回 **`wakeDowngraded:"pair_wake_rate"`**。hub 每会话对默认 **2 次/小时**，19:13 前两个相关 pair 已各占用 2 格；没有传输字段丢失或版本偏斜。

接收卡片显示 deliver 是**合法配额降级，不是 wake 传输失效**。真实缺口：工具 JSON 已有原因，但 hub audit 未记录、hint 未解释、mention 投影未透传、接收卡片只看 wake=false。本任务打通原因，不通过改配额、重复正文或绕限流“修好”实测。

q id 是 reply requestId，非 xid/wakeToken/runId；这些运行证据不自动证明后续是否 started，仍按逐正文观测判断。

## 2. 现状摘要与缺口

### 2.1 现有链路（文字版）

- `src/tools/message-session-tool.ts` → `src/fabric/xs/sender.ts` → `src/web-hub/agent/xs.ts` → `src/web-hub/hub/xs/router.ts`。
- hub `registry.request(xs_deliver)` → bridge → `src/fabric/xs/receiver.ts` → quiet host 或 `src/fabric/root-wake.ts` → pi。
- `src/fabric/xs/reply-ledger.ts` reserve/commit/release → receiver → reply-notice，凭证仅进程有效。
- TUI input → `src/mention/{mention,session,wire}.ts` → 同一 sender；同步 web mention 由 `web-hub/agent/commands.ts` 另行认领后异步 route。
- command ledger → closed ctl → `web-hub/ui/src/logic/control.js`；接收卡片由 `logic/xsMessage.ts` 解析正文首行。
- `src/fabric/xs/activate.ts` 是**现有启动接线模块**，不是本次业务 activate。

### 2.2 核验事实

| 路径 / 符号                                                      | 已有保障                                                                               | 缺口 / 设计影响                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `protocol/xs.ts` Req/Deliver/Ack/Res                             | 大多顶层strict；relay5s/send8s/16KiB；双向caps                                         | xs_res无woke；不能持续报告started；optional不是旧端兼容保证                        |
| `sender.ts::message`                                             | resolve后一次send；await身份guard；前send none、后send歧义unknown                      | woke推导值；无公开稳定messageId/持续状态；部分异常丢local downgrade                |
| `receiver.ts::pipeline`                                          | 同步准入、xid dedup、reply一次消费；quiet idle leaf匹配才applied，busy unknown/queued  | queued后无逐请求证据；异常/post-fence部分出口丢原因                                |
| `root-wake.ts` / `xs/wake-ledger.ts`                             | starting/deferred/bound/aborting/stuck、B1、orphan监管、绝对预算；cap8授权不按时间驱逐 | !isIdle/woke仅dispatch兼容证据；optimistic接受后可能context前abort；不得第二runner |
| `xs/dedup.ts/inbox.ts/unread.ts`                                 | expiresAt+1s去重、cap256满拒绝；inbox占位、unread尽力计数                              | 短TTL不适合activate重试；inContext时间/unread清零不是正文started证明               |
| `message-session-tool.ts::execute`                               | legacy/reply schema冻结；wake默认false，replyTo忽略wake                                | 当前忽略toolCallId；需宿主调用上下文，不能新增human/source参数                     |
| `wake-input.ts`                                                  | interactive/rpc；extension须web ledger归因，真实human重置level                         | hasPromptText的yes/no不是一次性代发凭证，不能整个轮次升级                          |
| `mention/wire.ts`                                                | 显式wake:true、human、levelOverride0；reply unsupported且none才fallback                | map丢wakeDowngraded/woke；无条件human不可用作通用来源                              |
| `commands.ts::handlePrompt` mention分支                          | 同步判定、async route，不改变native同步行为                                            | route后只observed，不走onInputHandled，不能等本地message_start                     |
| `58f850a0` onInputHandled                                        | handled前一次raw text报告，session/owner唯一匹配→consumed，30s不覆盖                   | 仅本地处理证明，非远端delivered/started                                            |
| `messages.ts` CtlItem/StatusInfo                                 | ctl state/reason/op closed，StatusInfo顶层open                                         | 不往旧ctl加delivered/replied，需独立xs投影                                         |
| `ui/.../logic/xsMessage.ts`                                      | 只解析首行wake，原正文稳定展示                                                         | 无原意图/理由；xs details不走现行web投影，不能从body猜                             |
| `tools/agent-tool.ts::prepareSpawn` / `service/spawn-service.ts` | model meta经parse进dispatchMeta；宿主记真实parent/onSpawnEdge                          | grant不能进model meta、diags继承或prompt，须沿实际run边传引用                      |

## 3. 总体设计

### 3.1 最小职责划分

| 模块                                    | 必须负责                                                                 | 不负责                         |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| `protocol/xs-activation.ts`（新）       | 新cap/shape/错误/期限，隔离冻结扩展                                      | pi/状态/授权                   |
| `fabric/xs/human-grant.ts`（新）        | input→context→toolCallId的一次性授权、调用链引用、CAS                    | NLP/模型source/自主签发        |
| `fabric/xs/progress.ts`（新）           | 四阶段归并、有限证据索引、source镜像、activation claim                   | 投正文/自动wake/替代B1         |
| `fabric/xs/session-activation.ts`（新） | 原消息激活准入及共用Controller                                           | 第二runner/正文fallback        |
| `web-hub/hub/xs/activation.ts`（新）    | 原send关联、state核验、receipt查询、activate单飞/缓存/配额               | 读pi/从StatusInfo授权/恢复正文 |
| 现有模块                                | sender意图、receiver正文、Controller唯一执行、bridge传输、mention/UI适配 | 重复发明去重/限流              |

文字版依赖图：

- 可信human入口 → grant → 宿主context与调用边 → 精确toolCallId → sender一次性claim；普通agent无grant，默认false。
- sender一次正文 → bridge → hub跟踪原xid → receiver写入证据 → Controller可选一次wake → context正文证据。
- progress → quiet state事件 → hub核验 → source镜像 → 状态槽/工具/mention/UI。
- wake_session activate → hub原关系及配额 → session-activation → **同一个Controller+B1**，仅固定控制marker。
- reply真实写入 → replied；state/receipt从不回到message_session或自动activate。

### 3.2 冻结开关、能力与兼容隔离

采用一个非live工程回滚开关 `fabric.crossSession.activation.enabled`（默认true），控制本次整组增强，不新增多套开关/配额。effective=`xsOn ∧ activation.enabled`，secure仍由xsOn fail closed。agent activate时冻结；hub仅在 `HubConfig.crossSession.activation` key存在时组装新服务，key缺失等同旧hub。`/reload`及hub `/webhub restart`生效。

- `xs.state.v1`：四阶段、原因、messageId、查询、可信代发契约；effective时宣告，wake off仍可解释原因。
- `xs.activate.v1`：原消息激活；effective且本地wake开启才宣告，实时policy仍可拒绝。
- schema/描述按本地effective冻结，不随live peer变化。wake_session在effective的主会话注册；wake off仍能query，activate返回明确拒绝。
- 三条轴：**本地command**dispatched/observed/consumed；**远端正文**queued/delivered/started/replied；**wake执行**requested/declined/dispatched/authorized/aborted/settled。HTTP ok、consumed、woke、busy、unread=0、模型说收到均不能跨轴推导。

## 4. 接口契约

文档内签名是待实施契约，不是实现代码。严格optional，缺字段不得填false/0/空数组而改变旧字节。

### 4.1 进展数据与效果

```ts
type XsPhase = "queued" | "delivered" | "started" | "replied";
type XsEvidence = "none" | "unknown" | "applied";
interface XsWakeView {
  requested: boolean;
  defaulted?: boolean; // source私有事实，remote不能覆盖
  stage?: "sender" | "hub" | "receiver" | "host";
  decision: "deliver_only" | "downgraded" | "dispatch_accepted" | "unknown";
  reason?: string;
  authorizedAt?: number;
  ended?: "settled" | "aborted" | "deadline" | "stuck";
  retryAfterAt?: number; // 只有权威配额提供，未知不填0
}
interface XsProgress {
  messageId: string; // 原正文hub xid，非q/rid/token/runId
  revision: number; // receiver进程+messageId内单调
  deliveryEffect: XsEvidence;
  phase?: XsPhase;
  queuedAt?: number;
  deliveredAt?: number;
  startedAt?: number;
  repliedAt?: number;
  requestId?: string;
  replyState?: "pending" | "timed_out" | "late" | "invalidated";
  observation: "live" | "offline" | "expired" | "unavailable";
  reason?: string; // 正文/观测原因，与wake原因独立
  wake: XsWakeView;
  activationKey?: string;
  activationUntil?: number;
  entryId?: string; // receiver真实xid匹配到的branch条目，仅展示
}
```

原send.effect即时含义不变；progress最新证据unknown可升applied，不能因timeout改none。四阶段单调保留最远事实，允许direct delivered，真实reply可跳replied但不补造startedAt；offline/miss/旧revision不退phase。

started是**合法模型回合context观察点包含原正文xid**，不是provider已收包或成功；wake-run须B1已授权且未abort。只看marker/BAS/!isIdle不足。后续context handler/provider仍可失败，UI须说明观察点而非业务完成。

replied须requester ledger关联合法且回复**确认写入requester会话**；consuming/commit的unknown、replier调用工具、hub受理replyTo不算。排队回复保留pending，写入后推进；late/timed_out/invalidated独立，晚回复quiet、不自动wake。

### 4.2 端到端状态机

| 事件                                                           | 正文效果/阶段                      | wake与处置                                               |
| -------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| resolve失败、源变化在send前、目标离线/未join、policy/fence预拒 | none/无phase                       | 可修正后新send，不启动离线进程                           |
| send后client/hub deadline、link loss、ack mismatch             | unknown/保留已知phase              | 只读查询，不盲重正文                                     |
| quiet受理时busy                                                | unknown/queued                     | 原意图wake则receiver/busy降级，非started                 |
| quiet idle，当前sid/gen的leaf.details.xid匹配                  | applied/delivered                  | deliver-only或真实原因，无started承诺                    |
| queued后来当前branch确认xid                                    | applied/delivered                  | 新revision，旧ack不改、不添turn                          |
| Controller已接受、压缩/延迟                                    | 有写入证明才delivered，否则unknown | dispatch_accepted，root预算已开始，非started             |
| BAS绑定合法token但无正文context证明                            | 保留phase                          | authorizedAt，不能标started                              |
| 合法context包含正文xid                                         | applied/started                    | 不承诺provider成功/回复                                  |
| optimistic失形/无授权abort                                     | 保留真实写入证据，不started        | host/host_unsupported、ended=aborted，不复制正文fallback |
| 合法reply确认写入                                              | applied/replied                    | credential一次消费，通知quiet                            |
| root deadline/abort/stuck                                      | 保留phase                          | ended相应，不自动第二轮                                  |
| reply dueAt                                                    | 保留phase+timed_out                | NoticeGate沿用，不自动activate                           |
| new/fork/switch、原文移出branch                                | 历史保留+unavailable               | 原资格撤销，不继承新sid                                  |
| reload同sid同进程                                              | 纯数据/observer恢复                | 授权/claim/deadline不重置                                |
| hub/pi重启、tracking满、扫描超限                               | 已知保留，其余unavailable          | 不恢复磁盘凭证，不猜activate资格                         |

观察实现：Controller guard先行，再读raw context custom details，反向最多2,000条、待查最多256个id，集合匹配而非每id全扫；不改event.messages。queued写入可在context正匹配或既有event flush点一次有界branch扫描确认，超限unknown，不每消息poll、不全文件解析。inbox时间/unread不作逐消息证明。观察连续性丢失时未见started不等于未处理，activate fail closed。

### 4.3 可信human来源与U5调用链

#### A. 签发入口

证明宿主入口因果，不从正文含义签发。source human、用户要求字样、level0、expectReply或model meta均非凭证。

- TUI interactive与RPC source按既有same-uid信任模型（RPC非生物认证）。
- web handlePrompt从hub鉴权/CSRF盖章origin及确切cmdId签发，HTTP body不能覆盖。
- extension input仅当前session/owner下**唯一**web ledger关联可签发；多同文本、错owner、topic-switch重注入、第三方sendUserMessage不新增授权。
- direct mention认领时可使用；普通human input等真实user消息进入context才绑定run，**busy尚排队的新input不能授权正在执行的旧assistant工具**。
- xs receipt/reply、message_agent通知、goal/schedule/Thread/Feishu自动链不签发。既有显式wake行为不改，本期不扩这些来源链。

#### B. 一次性账本及接口

```ts
interface HumanGrantRef {
  readonly id: string;
} // 内部opaque，不进工具/wire/prompt
interface InvocationRef {
  sessionId: string;
  runKey: string; // 主会话宿主run/context代际，或真实runId
  contextSeq: number;
  toolCallId: string;
  toolName: string;
  owner: string;
}
interface HumanGrantClaim {
  grantId: string;
  claimId: string;
  call: InvocationRef;
  targetSessionId: string;
}
interface HumanGrantPort {
  issue(input: {
    inputId: string;
    sessionId: string;
    via: "interactive" | "rpc" | "web";
    issuedAt: number;
    owner: string;
  }): HumanGrantRef | undefined;
  bindContext(ref: HumanGrantRef, runKey: string, contextSeq: number): boolean;
  linkInvocation(parent: InvocationRef, childRunId: string): void;
  resolve(call: InvocationRef): HumanGrantRef | undefined;
  reserve(ref: HumanGrantRef, call: InvocationRef, targetSessionId: string): HumanGrantClaim | undefined;
  commit(claim: HumanGrantClaim): void;
  releaseNone(claim: HumanGrantClaim): void;
  revokeSession(sessionId: string): void;
}
```

`Symbol.for("pi-subagent:xs-human-grants")` cap64、纯数据、lazy清理；签发后≤30min且所属调用链存活，新/fork/switch/restart撤销。same-sid reload可保留，但新owner不能猜旧tool invocation接管。满/过期/缺上下文退agent，显式wake仍原准入。

一份human输入只有**一份全调用链共享额度**，子调用传播同ref不复制。首个合格expectReply代理代发CAS成功默认wake，并行其他默认false；多个目标可显式wake:true，仍受quota。工具描述讲清，不做NLP暗签多份授权；这是一次性授权的工程边界，不是整轮布尔值。

#### C. 实际传递与消费

1. human消息归因后context建立runKey/contextSeq；宿主tool_call/执行入口登记真实toolCallId。并行调用独立引用，不能跨await读取global currentGrant。
2. message-session execute入口捕获InvocationRef，经注入port查证；模型额外source/human/grantId忽略，schema不宣告。
3. Agent真实spawn准入成功取得childRunId后，捕获的父InvocationRef沿真实onSpawnEdge登记同ref，nested沿已验证parent边。失败spawn无边；model params.meta/dispatchMeta/diags继承不能授权。
4. 只用进程内provenance side registry/依赖端口，不写core持久diags/子prompt，不增加子xs工具；子会话仍inert，已有宿主工具执行层只读引用。
5. 根及继承链都结束时撤销；root因通知自动再醒不能捡历史grant。无法严格归因默认agent。**grant不随xs正文/回执跨会话传播**，receiver wake-run仍agent causal hop。
6. replyTo排除，explicit true/false优先；无expectReply普通agent默认false。省略wake+expectReply在resolve pin目标、guard/receivability/size通过后reserve精确call grant，成功为human委托默认true，否则false。
7. 同步段issue reply ticket，**port.send可能离开前commit**。不能HTTP回来才扣额度；后send未知保留消费。pre-send证明none释放；remote明确none可释放到同一已绑定call/target的未生效重试，不转另一目标/自主链，不自动重试正文。
8. explicitfalse不被覆盖；grant不绕level/quota，真实原human input只重置root level一次，代理/receipt不重复reset。
9. 默认便利仅完整新三端state协商后的代理路径启用；old peer保持原省略wake帧，本地提示可显式true，不为U5破坏I10。

### 4.4 工具接口：激活与纯查询共用同一surface

message_session参数仍`to,text,wake?,expectReply?,replyTo?`；legacy/reply冻结schema保留，TypeBox全局default不改true。新description/result变体按本地effective选取，讲明human委托一次性、explicitfalse优先和原因。旧XS_MAIN_TOOL_NAMES常量不改，新tool冲突集合单独追加。

现行direct mention已显式wake:true，不补发第二wake；可信origin来自入口。reply unsupported且none才一次plain fallback，unknown/deliver/quota/timeout不能重正文。

```ts
interface WakeSessionParams {
  to: string; // resolve后pin完整sid；query只验证原绑定，不改地址
  messageId: string;
  activationKey: string; // 原receipt发行，始终复用
  action?: "activate" | "query"; // 默认activate；query严格read-only
}
interface XsActivateOutcome {
  status: "accepted" | "already_active" | "already_started" | "already_replied" | "refused" | "unknown" | "unsupported";
  effect: "none" | "unknown" | "applied"; // activate效果，不是正文效果
  messageId: string;
  activationKey: string;
  reason?: string;
  wakeDowngraded?: string;
  retryable: boolean;
  retryAfterAt?: number;
  dup?: true;
  progress?: XsProgress;
}
interface XsActivationPort {
  activate(
    args: WakeSessionParams & { origin: XsOriginSnapshot; level?: number; signal?: AbortSignal },
  ): Promise<XsActivateOutcome>;
  receipt(args: {
    origin: XsOriginSnapshot;
    messageId: string;
    activationKey?: string;
  }): Promise<XsProgress | undefined>;
}
```

query返回`{status:"known"|"unavailable"|"unsupported",messageId,progress?,activation?}`，不调用activate、不reserve wake、不因miss执行；只计读额度。工具unknown hint固定要求`action:"query"`及原message/key。web同样只读端口，不能查询未找到就执行。无需另造get_receipt工具。

messageId就是receipt确认的原xid，不造第二个正文receiptId地址空间；无text/prompt/expectReply/join参数。key非bearer授权，还验source进程/sid、target、频道、receiver原from。accepted表示控制动作已提交，progress可能仅delivered；after-call异常unknown。already_started/replied为none no-op；none暂态可原key人工再activate，unknown只query/去重。

### 4.5 Activate关系、线性化及控制marker

hub在原relay前记无正文关系：xid/messageId、source进程/sid/rid、target进程/sid、createdAt、trackUntil、key、lastProgress。receiver/source袋cap256，hubcap1024；live窗口不容量驱逐，满则原正文旧路径发送但tracking unavailable、无key，不猜资格。

`trackUntil=createdAt+clampSpanMs(expect ? timeoutMs+lateGraceMs : 30min)`，最高沿reply.maxTimeoutS+lateGraceS；activationUntil=trackUntil，不开任意TTL。过期包先拒绝才lazy清理，换key无效。reload同sid纯数据恢复/observer替换；new/fork/switch撤销，hub/pi restart旧key失效，不能从磁盘正文恢复授权/发行替代key。B1 token另算，仍可能执行的授权/tombstone不因progress过期清除。

Receiver同一同步段顺序：

1. expiry/to.sid/epoch、当前member/channel/allowFrom/block/receive/fence重验，hub盖章from匹配原source。
2. 原记录存在且**原文在当前branch实际确认**；缺失/queued未证实/扫描超限/原文移出/host队列未清拒绝；观测断档未见started不是未处理证明。
3. started/replied no-op；原wake deferred/starting/aborting/stuck或activation claim未决already_active，不能第二trigger。
4. 当前Controller policy/wake/root预算/capability/goal/owner/inbound quota/当前causal level准入，card badge不是授权。
5. **先message级claim+Controller owner，后host**，无await；只调用Controller新activateExisting入口，内部复用dispatch/ledger/B1。
6. 明确准入/host同步none才释放claim；after-call异常/未知consume tombstone；不同key不能绕messageclaim，settled没reply也不能把有效activate重开为催第二轮。

公开pi API没有已验证可token归因裸continue，使用**固定小型宿主控制marker**：仍customType subagent:xs，details含xsWake/wakeToken/控制动作xid及内部activateFor原messageId，B1照常验。固定content仅说明宿主激活、处理上下文未处理跨会话请求、不重复已处理内容；不含调用方正文/header/q/alias/key/token。ledger绑定控制动作及activateFor，context含**原文xid**才started。

不issue新reply凭证、不调用receiver.deliver/sender.message、不增加正文inbox/unread；tap识别activateFor，state通知也不计正文。卡片仅原正文一份，activate为附着操作。accepted后失形/抹文/timeout不得quiet复制正文fallback或再activate。

### 4.6 配额及人工重试（#14）

activate复用send/min/hour、hub/min、inFlight、out wakes/hour、**pair默认2/h**、receiver inbound wakes。仅跳过原正文send造成的pairMinInterval检查，另有30s/pair控制attempt间隔；旧send不改。不设人工免配额。

- 先原关系/幂等命中再限流：dup/query不再占wake，query计listPerMin。
- 真新attempt同步reserve后relay；send/控制attempt计数不退款，证明none可释放**此attempt**wake reservation，unknown不退款。
- 原pair_wake_rate降级没占新wake格；正文send已计费，不在activate重复“补扣正文”。以后真正activate增加一格wake和一笔控制操作，是新控制成本，非重复正文计费。
- 原wake已可能有效且未决already_active，started no-op，不再占格/开turn。grant只改默认，不增quota。
- activate用调用者当前level，不借原human旧0；reply returnLevel仅replyTo。

**两例现在pair各2格满**：activate仍拒hub/pair_wake_rate，不relay marker、不占新wake格、不重正文。回retryable及权威retryAfterAt：滑动窗口最旧有效占用到期，非整点reset；多项已知限额取可执行的最晚约束时间，receiver未知不猜。

人工原key再试，须原attempt证明none、到retryAfter、原文仍delivered未started、资格未过期/目标在线/policy允许；自然回合已处理则no-op。票据期限早于quota恢复须提示会过期，不自动延票/授权、不新key。

claim状态`available→reserved→dispatched/unknown→consumed`；pre-dispatch none回available但保留同key绑定/notBefore。并发reserved已active；after-sendunknown只query，不再次relay。重复/迟到ack不重复settle/refund；双击/刷新/新外围cmdId仍保留业务key。

状态/降级/完成通知quiet；SSE重连、reply timeout、quota到期不自动activate；grant不跨xs，causal hop保留，不实现回执→自动wake原sender。

### 4.7 Wire追加与I10

旧cap常量/PROTO不改，新xs帧仍strict，只明确追加optional；新shape在xs-activation.ts、xs/messages接入。

| 方向/帧                    | 新内容                                                      | 门禁                                                 |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| xs_req send                | track requestedWake/senderDowngrade                         | source+hub state，实际track须target state            |
| xs_res resolve open target | xsState/xsActivate true及既有完整sid                        | 新source/hub、target实际cap，旧请求不加              |
| xs_deliver                 | track until/requestedWake、sender或hub盖章downgrade         | 三端state                                            |
| xs_ack/xs_res              | progress snapshot                                           | 对应tracked路径；defaulted仅source归并               |
| receiver→hub xs_state新帧  | messageId/revision/phase/证据/时间/wake/entryId             | receiver state、hub核原target身份                    |
| hub→source xs_state        | snapshot、sourceRid                                         | 原source state、rid由hub关系关联                     |
| xs_req receipt新op         | messageId/key可选                                           | source绑定，纯读3s                                   |
| xs_req activate新op        | to/messageId/key/level，绝无text                            | 三端activate，8s                                     |
| hub→receiver xs_activate   | rid/to sid epoch/盖章from/messageId/key/expiry/level        | target activate，relay/expiry5s                      |
| xs_activate_ack            | rid/message/key/status/effect/retryable/retryAfter/progress | 精确pending匹配                                      |
| StatusInfo顶层             | xsRequests sessionId/revision/rows/omitted                  | 新live hub state、本session有记录；不塞closed xs/ctl |
| cmd_result mention session | progress或messageId引用                                     | 新cap，旧peer完全剥除                                |

frame≤16KiB、id≤64、sid≤128、reason英文token≤64/wake≤48，整数safe nonnegative。reason可追加，未知generic显示不drop整帧。state不带正文/hash/token/IP/raw异常；错socket/xid/sid/revision忽略诊断，不信receiver自报source。grant不进wire/provider。

old hub×newagent：legacy send/ack/res/status及key顺序不变，无track/新op/state/status，activate/query unsupported，不拿text模拟。**代发默认便利完整新协商才启用**，old省略wake帧不变，explicittrue仍旧行为。newhub×oldagent不加字段/push，不改resolve排序/发送字节，不经activate唤醒旧agent。new/new/oldtarget普通正文旧路径，无key，本地解释unsupported。handshake cap追加是声明的协商扩展，业务帧混合版本差分必须逐字节。

不扩closed ctl state/op/reason；StatusInfo顶层open也不免oldhub门禁。开关off与旧端缺能力的serializer均剥除新字段，不重写旧实例。

### 4.8 真实原因链及surface（#14）

| 阶段                 | 真实原因                                                                                                               | 含义                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 未请求               | explicitfalse/agent省略                                                                                                | deliver_only，不叫降级                             |
| sender               | sender_wake_disabled/level_limit                                                                                       | 原意图true，frame省略wake，保留sender原因          |
| hub                  | outbound_wake_rate/**pair_wake_rate**                                                                                  | effectivewakefalse，仍投正文；盖章、audit/hint可见 |
| receiver             | wake_disabled/controller_disabled/host_unsupported/receiver_policy/busy/goal/level_limit/inbound_wake_rate/ledger_full | quiet content(false)，阶段可queued或delivered      |
| fence                | goal只降级，其余fenced:name拒绝                                                                                        | none拒收不是delivered成功                          |
| host后执行           | 失形/无授权abort/deadline/stuck                                                                                        | 保留dispatch与ended，不伪装pre-dispatch降级        |
| transport/post-fence | client/deliver_deadline/link_lost/accept_unverified/receiver_error                                                     | unknown，不猜policy/busy                           |

固定主原因带stage，首个真正停止wake的原因不被覆盖，另附host ended，不造无界trace。sender所有出口统一decorate已存wake view，receiver异常/host_rejected/post-fence保留已知downgrade，effect独立。

- 工具JSON保留wakeDowngraded并加中文hint：两例“唤醒因pair_wake_rate降级（hub，每会话对2次/小时）；正文按deliver投递，不要重发；已确认送达未开始可原receipt人工activate，但须等待配额”。没有写入证据不直接断言delivered。
- `hub/audit.ts::auditXs`追加可选稳定wakeRequested/wakeEffective/wakeDowngraded/wakeStage，在新诊断路径写；旧off/legacy行不变。不记录正文/hash/wakeToken/IP/raw异常，原xid/枚举足够。hub原因不能只靠ack.reason。
- mention map透传wake/progress，提示区分queued/delivered/dispatch pending/started；quiet不启requester。
- sourceweb按messageId归并，generic unconfirmed不覆盖远端证明。
- receiverweb/TUI原正文格式不变，新status/host metadata紧凑`deliver · wake↓ pair_wake_rate`、中文详情。真实xid→entryId才附着卡片，缺entryId列请求区域，不按正文/hash/时间猜。
- /fabric、/agent新cap有信息才加阶段/原因行，usage未知n/a非0，状态不是授权；legacy缺原因显示unavailable，没cap没按钮。

requested经source track→hub盖章只作展示，不能requestedtrue绕framewakefalse；parseXsMessage只读首行，body写wake/reason不可污染状态。

### 4.9 Mention两条入口与UI

input链保留onHandled(rawText)在handled前一次report，旧签名不变；新cap另接onSessionRouted透传message/progress，session/owner唯一匹配、miss/歧义no-op。**同步web分支**自行在route完成后以确切frame.id consumed+message关联，新cap路径处理；legacy observed回执保持。不等不会出现的本地message_start。

consumed仅本地路由处理，远端none也不再generic误报，失败单独显示；30sCAS不覆盖。新route throw按pre/post-send证据，pre证明才none，否则unknown，不借机改其他mention/hold/native/Thread。xs表与command genericok/TTL独立。

UI复用QueueList旁轻请求区域，不建全机任务面板。主行英文四phase/unknown/not delivered，reply状态与wake↓并列，中文解释证据。activate须三端cap/key有效/delivered未started/online，服务端复验；singleflight原key，unknown只query，quota显示retryAfter/期限不自动执行。原正文卡片只一份。

session/进程/message/revision归并，HTTP/ctl/snapshot乱序不退phase。重订阅用既有定向status补发，同hubreceiver至多256条latest state分帧补metadata，绝不重正文。hubrestart关系丢失unavailable；本地历史非恢复授权。old/off原DOM连空容器都不加。

## 5. 关键决策、取舍与未决项

| 决策                       | 理由 / 排除方案                                          |
| -------------------------- | -------------------------------------------------------- |
| 效果/进展/wake分轴         | 防queued误读为started/可重发，保留旧effect               |
| 独立cap及顶层槽，不扩ctl   | closed旧decoder会drop整帧                                |
| 宿主grant精确call+CAS      | 接受U5，排除模型source/meta、整轮bool/global lastHuman   |
| 同grant真实边共享、不跨xs  | 不复制human额度/不形成唤醒循环                           |
| 同Controller+B1            | 保留owner/deadline/orphan，排除内部裸continue/第二runner |
| 原message/key、无text      | U6排除空唤醒/重跑/重复正文                               |
| none人工原key，unknown只读 | at-most-once可能有效trigger，不虚称exactly-once          |
| 原quota、dup不重复计费     | 两例合法降级，不用human/activate突破2/h                  |
| 有界进程内，不恢复磁盘凭证 | restart失可用性而不复活工作                              |
| started正文合法context     | woke/!isIdle仅dispatch事实，不承诺provider成功           |

限制：有效activate后没reply不可催第二次；扫描/压缩/legacy可unknown；过期/restart不可激活；plain tracking30min、expect沿ticket；grant首合格代理消费一份，多目标可显式wake。一个回滚开关隔离新增强，不新增自动策略。

**无未拍板产品分支**：A/B已经U5/U6，不重新提问。工程窗口/容量可由Plan评审，但需变更泛唤醒、持久授权、quota豁免、复制grant或正文重投范围才由root ask_user，不能自行扩大。

## 6. 实施要点、测试矩阵与文件域

### 6.1 分阶段

1. P0冻结开关/cap/frame、progress/grant/activate端口、旧字节差分。
2. P1正文写入/context/reply观测、progress袋、hub关系/state；quiet，先无activate。
3. P2human input/context/toolCallId/真实spawn边、默认/消费、原因audit/hint/mention两分支。
4. P3依P1资格实现Controller共用、key/quota/marker/claim。
5. P4 UI依冻结契约与后端可并行，不自造started/text resend。
6. P5真实hub/pi、混合版本、reload/crash、provider stub执行计数及pair条件受控复现；每包异源verifier，root一次全量门禁。

### 6.2 文件域与冻结面

| 包                     | 文件域                                                                                            | 注意                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P0/config              | protocol新xs-activation、xs/messages/version；fabric设置解析/spec及config corpus                  | 一位owner，开关非live，PROTO不改                                      |
| P1纯状态               | `fabric/xs/progress.ts`新、property tests                                                         | 无pi/正文/自动wake                                                    |
| P2授权                 | `fabric/xs/human-grant.ts`新、wake-input、xs/activate接线、宿主tool_call/context ports            | postguard，不global lastHuman                                         |
| P2调用链               | tools/agent-tool、service/spawn-service、runtime/session-driver内部provenance、tests              | 先读subagent-core，modelmeta/diags/子prompt/nested frozen surface不变 |
| P1/P3接收（一个owner） | xs/receiver/stack/wake-ledger/host-cap、fabric/root-wake、tests                                   | B1/owner/teardown不可多包并写                                         |
| hub                    | hub/xs/activation新、router/limits/members、registry/agent-server/caps、audit                     | 无fabricimport，auditwhitelist明确，不改Feishu正文                    |
| bridge（一个owner）    | agent/xs/connection/index、fabric/xs/activate、stack组装                                          | bounded，src/index仅assembly                                          |
| sender/tools           | xs/sender/session-activation新、tools/wake-session-tool新、message-session变体                    | execute真实toolCallId，旧schema/集合不改                              |
| mention/control        | mention三文件、agent/commands/ledger/control端口                                                  | 58f850a0保留，两分支测试，不扩ctl                                     |
| UI                     | logic/xsRequestState新、control/xsMessage适配、QueueList旁/TxCustom、useHub/useControl/types/i18n | off/legacy DOM不变，不body推身份                                      |
| 集成                   | activation integration/conformance、旧mention/reply/wake suites、helper fabric-xs-process         | helper共享，真实peer probe                                            |
| 下游文档               | fabric-cross-session/web-hub README新事实/门禁                                                    | architect只写本文，完成后才更新事实                                   |

protocol/grant/sender/Controller/bridge/helper为共享冻结面，唯一owner或串行接入。新tool治理trace由root集中声明刷新。已有reply-off/channel-compat golden测试按cmdHistory先例**显式activation.enabled=false/旧port缺callback=false**隔离新独立增强，只调整测试配置，不改A-tier fixture字节；新增on测试固定新变体。新开关corpus为已声明append，不授权多包并写。工作区bash/memory不碰，不stash/reset/add-A/全树格式化。

### 6.3 必测矩阵

| 维度          | 判据                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase/effect  | none预拒、unknown运输、queued→delivered→started、directdelivered、reply跳跃、乱序不退、timeout不造none                                                                                      |
| 来源          | TUI/RPC/web、extension多同text/错owner/reinject、伪source/meta/grantId、busy新input不授旧调用                                                                                               |
| U5链          | 真input→context→call→spawn/nested共ref；parallelCAS一次、pre-none释放/postunknown消费；自动续轮/跨xs/历史diags无继承                                                                        |
| 默认          | human/grant×expect×wake三值；普通agentfalse、replyTo忽略、oldcap帧不变                                                                                                                      |
| mention       | handled一次、同步web精确cmdIdconsumed+远端状态；31s无误报；none/throw边界；native/hold/off不变                                                                                              |
| #14           | pair已有2格→hubpair_wake_rate；JSON/hint/audit/mention/接收卡片同因；不误判传输bug                                                                                                          |
| 其他原因      | senderlevel/wakeoff、huboutbound、receiverpolicy/busy/goal/root0/cap/inbound/ledgerfull；异常保因、host后abort独立                                                                          |
| 人工/quota    | pair满拒无marker/新wake扣；retryAfter准确；原key恢复后一次；原wake未决no-op；dup/query/迟ack不重复扣退；过期不续                                                                            |
| 去重property  | 正文有效dispatch≤1；每message可能有效activate≤1；同key并发/伪新key/多message同target/ackloss/reentry/afterthrow/hostnone                                                                    |
| 不重复        | branch/provider原text只一份，marker无正文/header/q/token，inbox/unread一次；并发只一新增执行，已context处理不添turn                                                                         |
| reply         | unknown消费不replied，写入才replied；latequiet、timeout/invalidated不重投；凭证/returnLevel原样                                                                                             |
| query         | actionquery/miss/unknown纯读，不reserve/relay/签grant；默认activate清晰、oldcapunsupported，无查不到自动执行                                                                                |
| 期限/生命周期 | 3/5/8嵌套、root900含压缩；send后断线unknown、不起进程；reload不补时间，new/fork/switch拒，restart不恢复凭证，迟tokenB1abort                                                                 |
| 有界          | 64/256/1024满不驱live；2000扫描超限unknown；observer卸载/timerunref；重连metadata有界无正文                                                                                                 |
| UI/循环       | 双轴、unknown无resend、业务key稳定、quota不自动执行、错session丢；SSE/status/reply/timeout不签grant不wake                                                                                   |
| 权限/I10      | channel/allowFrom/block/fence/currentpolicy重验、错from/rid/key/xid拒、activate当前level；secure/child无入口；old/new各组合逐字节/key顺序、default/channel/alias/replyoff，PROTO/golden不变 |

### 6.4 验证与交接

下游才运行，architect未跑：A-tier fabric-xs-off/fabric-wake-off/fabric-xs-reply-off/legacy-xs-v071/secure-off不可重生；purematrix/property、真实hub×2/3 stacks、C-X1…C-X12/C-P1…C-P5、legacy pi1.0.4/1.1.0、新marker/context/B1及工具身份probe、boundary/activationtrace/teardownmatrix；收尾format:check/typecheck/test/build及webbuild/check由root安排。

Plan按§2坐标核验，不重做全仓探索；两例运行原因已闭合，受控复现用**新测试请求**，不重发用户原正文。先冻结协议/共享owner再并行；若需要正文重投、第二Controller、模型human、quota豁免、泛唤醒或持久授权才能完成，立即停下上报。
