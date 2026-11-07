# #61 · 宿主输入观察接口设计（r2 · review 收口；未实施；**已被 2026-11-08 裁定取代**）

> **历史文档（2026-11-08 标注）**：用户随后撤回了“专用 RPC + 一次性 ticket + 实际消费 callback”这条强路径，改为主会话运行态 + 每用户窗口两次唤醒预算 + 用户消息到达即重置。实际落地语义见 `docs/dev/fabric-cross-session/README.md` 的 root wake 小节；本文只保留当时的接口推演与证据坐标，**不作为现行设计依据**，SDK 侧补丁也未安装。

## 一页摘要 / 冻结边界

- 用户正式选择：**继续专用 RPC + 提交 ticket + 实际消费 callback**，不采用“TUI/Web 接受即开窗”；**新机制 on 时一并收紧未知 RPC 对旧 Root 因果级的归零，off 保留兼容**。这些强度/时序不再征询。
- `decisionRequests` 默认 true；Root 2/窗口、child 1/窗口、lazy checkpoint、decision causal 隔离不变。当前 HEAD `5312f6ec` 的 P0 ledger 已独验合主、无生产 wiring（Root 提供状态，本轮未执行 git）。P1/P2 继续暂停。
- **纠正威胁结论**：在信任宿主的模型下，原生 TUI `source=interactive` 可用作输入来源。可信宿主直接 `Root.session.prompt()` 能制造同形事件，**不等于 LLM 能通过正常工具伪造**；当前接口不能证明物理真人，并不使 TUI 必然不安全。
- SDK 改造的理由是用户选择的**实际消费时序、队列精确 identity 统一、专用 RPC 来源能力**，不是安全上唯一可能。只设计一个宿主私有 submission port/一次性 ticket + 只读 consumer observer；不接管 editor/stdin、不造认证平台。
- **已证版本**：installed/tested exactly `1.5.0`，peer `>=1.5.0 <1.6.0`。下述新 API 全是提议，未宣称现版本具备；不修改 SDK/pin，不授权 fork、安装、升级或重启。
- RPC 默认是机器通道；仅宿主注册的受信 terminal adapter 可走专用提交入口。Web 增 tree-only adapter，不依赖 xs enhanced、不靠同文归因。客户端尚未定位，不能宣称全 RPC 支持。
- 威胁边界仍是 LLM/机器消息自激活，信任宿主及获准终端代码，不防任意恶意 host JS/全部用户权限、不证明物理人。proof 不授予 child 权限；消费预算仍逐次验证树关系。

## 1. 已证事实与源码坐标

下表 `SDK/` 指本机 `node_modules/@earendil-works/pi-coding-agent/`；上游源码路径是 dist 对应的 **patch 建议落点**，不是本轮已读的上游源码。

| 证据                          | 已核坐标 / 复用来源                                                                                         | 结论及边界                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 TUI 与宿主程序 prompt 同形 | `SDK/dist/modes/interactive/interactive-mode.js:934–943`；session `1649–1711`；extensions types `926–939`   | P0 实验保留为“公开事件不认证物理人/调用方”的边界证据；撤销“因此正常模型可伪造/TUI 必须 patch 才安全”的推论                                                      |
| E2 正常扩展发送边界           | `SDK/dist/core/extensions/loader.js:306–312`；session `1928–1956,2783–2800`                                 | 暴露 sendMessage/sendUserMessage，后者固定 extension；custom steer 不触发 input（复用既有证据）；message_agent/goal/schedule/custom 不因此获得 Root interactive |
| E3 TUI 分支 / RPC             | interactive `2594–2600,2740–2790,3511–3521,3720–3751`；rpc-mode `293–328`                                   | TUI 来源在信任宿主模型下可用；RPC 三种提交都 source=rpc，不能据此区分受信终端与机器                                                                             |
| E4 公开合同 / 消费候选        | `SDK/docs/sdk.md` Prompting/events；`SDK/docs/extensions.md:1108–1161` 完整 Input Events；session `744–767` | input 可 handled/transform；已有 user message_start 观察，但现文本队列匹配不是 proof，原对象 ref 保留与 pre-model 时序仍需离线证明                              |
| E5 Web                        | `src/web-hub/agent/commands.ts:595–608,1197–1215`；P0 handoff entryCapability.web                           | admission 已证，noteWebProof 被 xs 门控；新强语义需要消费关联，不否定旧来源可信性                                                                               |
| E6 P0 proof DTO               | `src/fabric/decision-input.ts:1–70`；P0 handoff kernelShipped                                               | 当前 DTO v1 仅 web_prompt 是字段事实，不等于运行时 TUI source 不可信；新增 provenance 尚未实现                                                                  |
| E7 版本                       | `package.json:54–56,71–73`；`src/adapters/pi-compat.ts:130,249–251`；SDK package `1–4`                      | installed/tested 1.5.0；不改 pin/peer                                                                                                                           |
| E8 旧归零 / 交叉调用          | `src/fabric/wake-input.ts:29–54`；`src/index.ts:888–896`；`src/fabric/root-wake.ts:707–720`                 | interactive 或 rpc 都归零；共享 classifier 还服务 RootWakeController handover，必须局部 strict flag，不能全局改语义                                             |

旧 P0 handoff 的实验事实继续复用，但其 TUI 强结论由本稿取代；preflightResult/ui_prompt_start/user_bash/slash 等旧排除路径不重跑。

## 2. 最小私有合同（全部为拟新增 API）

```ts
// 上游内部类型；不进入 PromptOptions/InputEvent/RPC 通用 JSON/模型工具参数。
interface HostSubmissionV1 {
  capability: "host-submission-v1";
  sessionId: string;
  bindingId: string; // SDK runtime incarnation；toolkit 私有映射到当前 Root owner
  inputId: string; // 宿主签发，不使用客户端 request id
  ingress: "tui" | "human-terminal-rpc" | "web";
  operation: "prompt" | "steer" | "followUp";
}
interface HostSubmissionObserverV1 {
  // 只报告已通过 admission 且真正进入当前模型输入的提交；无 text/images/token。
  onCommitted(event: Readonly<HostSubmissionV1>): void;
}
// 示意内部接线，不是现存导出名：
// trusted producer -> issueTicket(binding, operation) -> submitWithTicket(ticket, input)
// core admission -> identity-bound pending item -> consumeOnce -> onCommitted(event)
// extension host 的只读 subscribeHostSubmissionsV1(observer) -> unsubscribe()
```

- ticket 是不可由 JSON 构造的宿主对象/私有注册表引用；公开 prompt 的 `human:true/source/inputId/preflightResult` 不被读取为权限。观察端只可订阅，不能 issue/commit；SDK CLI 将 issuer closure 仅交 TUI 实际提交分支及获准 adapter。
- 优先 coding-agent 内部 `WeakMap<UserMessage, Ticket>`/sidecar 绑定**原 UserMessage 对象身份**，不是 text、时间邻近或“下一条 input”；transform 仍关联原 ticket，handler 自行另发消息不继承 ticket。
- host 生成不可复用 ID（incarnation namespace + 单调计数），绑定 sessionId、bindingId、operation、producer；toolkit 检查 live owner 后映射 proof。客户端 id 仅重试关联，不能决定额度身份。
- pending/seen 有界（每 binding 至多 256，满则 fail-closed，不淘汰后重认）；取消、handled、拒绝、session replacement 均销毁未消费 ticket。无需新增轮询/定时器；错误只诊断 provenance_unavailable，不阻断原输入。
- SDK consumeOnce 在通知前永久标记 ticket spent；重复回调由 toolkit inputId 去重。callback 同步且不 await：抛错被隔离；toolkit 序列化 checkpoint，持久化成功前不发布新预算，失败不能改用 legacy/source 兜底。
- toolkit 在现 `DecisionHumanProof` 之外做边界映射，后续显式扩展 provenance（TUI/RPC）；保留 v1 web 记录可读。读不了新证明的旧端只 deliver-only；本稿不擅改现 DTO/schema 版本。
- ticket/连接能力是秘密：不进模型上下文、消息 metadata、流量记录、RPC 公共输出、日志、用户环境变量；只持久化预算必需的非秘密 ID/epoch/绑定，不存 bearer/token。短 English capability 状态可见，无 secret 细节。

## 3. 提交次序与三个 producer

### TUI（来源已可用；下列适配为落实已选消费语义）

1. SDK 现有 `setupEditorSubmitHandler` 的实际任务提交分支及 `handleFollowUp` 获得 issuer；保留原 editor/onSubmit、历史、图片/粘贴、快捷键语义。纯 UI 命令先处理，不铸有效 proof。
2. 内部 `pendingUserInputs/getUserInput` 改为携带 submission envelope；compaction-held item 同样携带，不按文本找回。启动 initialMessages、恢复 transcript、程序 session.prompt 不走 issuer。
3. core 在 commands/input handlers、模板、模型/auth admission 后确认 disposition。handled/rejected/空输入不 commit；构造原 UserMessage 时绑定 ticket，在 session 观察该消息真正进入模型前 consume，而非 input 接受或 prompt Promise resolve 时。
4. steer/follow-up 入队只 pending；**出队且确定进入本次模型输入时** commit，先于该输入引起的工具/子请求。取消/clear_queue/还原到 editor 使旧 ticket 失效；重新手动提交产生新 ID。
5. 优先复用 session 已有 user `message_start` 观察位置，新增原对象 WeakMap 查询；须先离线证明原 ref 从队列到事件保留且通知早于模型/工具执行，不能凭事件名猜测。能在 coding-agent 内完成就不改 agent-core；只有无法保留 identity/时序才另批最小 core patch。
6. 只读 observer 向 toolkit 当前 stack 投递；输入不携 proof 字段，旧扩展 InputEvent 字节/顺序保持。actual consume 前本提交不给 child/tool 新预算（不否定此前合法窗口的剩余额度）。

### 受信 human-terminal RPC（新增显式能力，不普惠泛 RPC）

- **谁注册/签发**：CLI/嵌入宿主的启动装配层显式批准终端 adapter 实现，创建独立私有控制连接并签发 connection capability；不由 RPC 请求、模型设置参数或普通扩展消息申请。默认不注册任何未知客户端。
- 推荐第一版只接一个经评审的本地 human-terminal adapter。宿主以专用继承 IPC handle 绑定该进程，普通 RPC stdin/socket 不提供注册/issue 方法；handle 不传给模型工具子进程，不经 argv/env/stdout 下发。远程终端认证不属于自动支持范围。
- 可信客户端仅在真实编辑器 Enter/steer/follow-up 提交 handler 发送私有 submit；自动重连、脚本/API、UI 自动关闭、程序发送函数不得走此 handler。宿主信任此实现约束，不要求键盘密码学证明。
- 私有连接用 server-issued nonce/connection generation + 客户端单调 submission sequence 做一次性重试关联；宿主验证连接/session/operation 后铸内部 inputId，保存 seq→inputId 映射及 payload digest，重试不重铸，换文拒绝。机器连普通 RPC 即便逐字段伪称也无该 capability。
- prompt/steer/follow_up 路由到同一 core 生命周期；request id、human/source 字段均不授权。连接断开/会话切换撤销未消费 ticket，重连不恢复旧权限；已消费预算不返还。离线验收必须包含真实获准 adapter 正例，不仅 fake callback。

### Web（已有可证 admission；新增 tree-only 接线）

- 在 server ledger begin + digest/origin/owner 校验之后、实际 dispatch 前，由独立 tree-only adapter 登记 ticket；只允许已证 Web user origin，Feishu/机器 origin 不铸证，不能仅见 op=prompt 就授权。
- cmdId 是 ledger 关联键而非身份凭证；hold/release/replay 复用同一 ticket/ID，held 未 dispatch 不 commit。SDK 需新增宿主私有 submit port 将该 ticket 精确传到 core；不把 proof 塞给通用 sendUserMessage options，不靠 text 匹配回收。
- 这比现 noteWebProof 的“send 前观察”更严格：登记是 pending，真正消费才 commit；send 失败/input handled/队列取消均不续预算。xs noteWebProof 现有语义及门控不动。

## 4. 预算语义（与普通 causal level 完全独立）

| 输入/事件                                                                               | 新窗口                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 已证新任务 prompt / steer / follow-up 被消费                                            | 每 distinct inputId 独立 epoch；新 session 首条、Root0、连续 ID 都开窗                                                                    |
| accepted 但 held/queued 尚未消费；取消、拒绝、handled、重复派发                         | 不开；多个输入同批消费按提交次序各一次，最后窗口生效，不累加额度                                                                          |
| model select/普通快捷键/UI 对话关闭；机器 RPC/custom/notification/timer/fabric/schedule | 不开；不能把 toolResult/user role 当 human                                                                                                |
| 真正 human ask_user 答案                                                                | **当前方案有意收紧，本次不计；不是用户既定要求**：属于既有任务工具答案，自动关闭/重放易混淆；未来另议 answer-proof，不升级所有 toolresult |

- 新 epoch 本身只补 decision 窗口，不改变普通 perRunQuota、child level，不依赖 resetRoot/onPersistRootLevel。**另一个独立的 causal 输入处理器**按下表归零 Root；不是 decision delivery/onDelivered 更新。receipt 不能创建 child、改变 direct-child/live-generation/owner 权限或 revive 终态。
- 未用 decision：内存观察、零额外 ledger 写/消费/timer；首合法 request 原子 checkpoint proof+reservation 后发送。已激活：新 epoch checkpoint 成功后才发布额度，失败保持旧账本；不因失败赠额。
- reload 先冻结旧 observer/owner、注销连接，丢弃未激活 proof；新 owner 无新额度，恢复同 session 已用高水位不洗预算。new/switch/fork 不迁移 proof；旧 closure、旧连接 replay 一律拒绝。

### 同事件两套权威（用户已授权 strict RPC，非全局 human-delegation 改造）

| 输入 / effective decisionOn | 旧 Root causal reset 时点                                                                             | 新 decision epoch 时点                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| on：原生 TUI interactive    | 保留原 input hook 时点；来源可信，不等于消费 proof                                                    | 只在 ticket 实际消费且 checkpoint 成功后发布            |
| on：未知/普通机器 RPC       | 普通 source=rpc **不 reset**，即使无新 SDK capability 也不得回退                                      | 不给额度；自称 human/inputId 无效                       |
| on：获准 terminal RPC       | 普通 rpc input hook 仍不 reset；私有 ticket 消费、live 绑定核验后由独立 causal handler resetRoot 一次 | 同一消费事件驱动独立 epoch/checkpoint；Root 已0仍开新窗 |
| on：Web extension           | 保留既有 Web attribution input hook 的 causal 时点；本次不扩 xs 权限                                  | tree-only ticket 消费后才开窗，不用文本匹配作新 proof   |
| off / old factory           | interactive 或 rpc 以及既有 Web attribution 的旧行为原样保留                                          | 不启用新机制                                            |

- `createWakeInputHook` 拟加显式 `strictRpc?: boolean`（旧 factory 缺省 false；生产仅传 effective decisionOn），只局部屏蔽 rpc 归零；不为此改变共享 `classifyHumanInput` 默认语义。on 无能力时 RPC 仍 strict；off 不新增 hook/副作用，A/B 不重生。
- observer 校验失败不 reset；checkpoint 失败不给**新预算**，但独立 causal handler 对已验证消费可 reset，不能拿该 reset 反推额度。回调失败不得拦原输入；新 epoch 与 Root0、连续 ID、去重、持久高水位独立。
- 精确交叉点：`src/index.ts:894–896` 另向 xs/controller 或 rootWakeRecovery 传 input，`root-wake.ts:712` 用同 classifier 做 handover。Root 须协调 strict 接线的测试边界；本包不顺手收紧该 handover、XS human-delegation 或其它已上线来源规则，也不得让它们旁路新预算/Root strict reset。

## 5. 兼容矩阵与发布门

| SDK / 宿主能力                                | TUI                                          | human-terminal RPC      | 泛机器 RPC                                  | Web                            |
| --------------------------------------------- | -------------------------------------------- | ----------------------- | ------------------------------------------- | ------------------------------ |
| 当前 1.5.0（未改）                            | 原生来源可信；用户所选消费合同未就绪         | 专用来源/消费合同未就绪 | 当前旧 hook 会归零；未来 on strict 必须阻止 | admission 可信；消费关联未就绪 |
| 将来 consumer capability 缺失/producer 未注册 | 新预算 provenance_unavailable，非 TUI 不可信 | unavailable             | on 不归零、不获新额度                       | 新预算 unavailable             |
| 将来 V1 + 已验 producer/原对象消费关联        | 可启用强语义                                 | 仅选定获准 adapter      | 永无自声明授权                              | tree-only 强语义，不要求 xs    |
| feature off / old factory                     | 旧路径                                       | 旧路径                  | 旧归零路径                                  | 旧路径；A/B 字节保持           |

- probe 检查明确 capability revision、只读 observer、对应 producer 与消费合同，不凭版本号/方法同名/source 猜支持。缺能力时新策略显式 `provenance_unavailable`、无新额度、只投递；不得误称所有来源都不可信。
- 新 API 全是提议。若需 SDK patch，优先上游供给并保留明确审批 + peer-bump conformance 门；**未授权 fork、修改 installed 包或 pin**，不写不存在的未来支持版本。
- 用户只授权设计先齐：生产首期入口范围仍待明确。受信 terminal 最小合同/正向 harness 可先设计，不要求立即指定未知客户端；未选定实际 client、未过能力门就不能宣称支持全 RPC。P1/P2 仍暂停。

## 6. 预计 repo 边界 / 最小 DAG（只列建议，不授权写）

| 边界                                   | 建议 patch 文件与责任                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pi 上游 coding-agent                   | `src/modes/interactive/interactive-mode.ts` 提交/held envelope；`src/core/agent-session.ts` admission+私有 item 关联；`src/core/sdk.ts` 宿主装配端口；`src/core/extensions/{types,runner}.ts` 只读 capability/observer bridge；`src/modes/rpc/rpc-mode.ts` 私有 adapter 接入，不扩通用 RPC 自授权字段；`src/cli.ts` producer 注册/撤销；对应 docs 与离线测试 |
| pi 上游 agent-core（仅消费接缝确需时） | `src/agent.ts` 队列消费的同步私有通知/identity 传递（现 dist `263–268,335–342` 是 drain 候选，drain 本身不等于消费）；优先在 coding-agent 新增 message identity sidecar，现 session `744–763` 的文本队列匹配不可复用为 proof；若 identity 无法在 coding-agent 保留，才另行申请最小 core patch，离线证明通知在模型/工具之前                                   |
| 获准终端客户端仓库                     | 实际 editor submit handler + 私有 transport 生命周期；不明客户端不预先承诺，先选定一个                                                                                                                                                                                                                                                                       |
| pi-toolkit                             | `src/adapters/pi-compat.ts` probe；`src/fabric/decision-input.ts` proof 映射；`src/fabric/wake-input.ts` 局部 strictRpc 工厂参数及测试；`src/stack.ts` owner 生命周期，`src/index.ts` 仅装配；`src/web-hub/agent/{commands,index}.ts` tree-only adapter；后续 P1/P2 仍按独立原包划域                                                                         |
| 验收/文档                              | 上游 SDK/TUI/RPC 离线 harness；toolkit conformance/decision-input/teardown/off golden 断言；README 以后跟实现更新，不重生 A/B                                                                                                                                                                                                                                |

DAG：`本稿收口 → 异源复审 → coding-agent 原对象 identity/消费时序离线证明 → 必要 SDK 供给审批 + 选定 terminal/harness → 明确首期生产范围与能力门 → toolkit adapter/strictRpc → (P1 ∥ P2) → 集成验收`。不重写旧 r2 DAG；附录只声明新前置门。P0 已合主是 Root 提供状态，非本轮重复验收；memoryP2/P3a/UI61 另包不触碰。

## 7. 离线验证门（未来实施；本轮未运行这些测试）

| 门                | 行为断言                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| real SDK 正负     | 受信 TUI 实际提交一次 commit；正常 sendUserMessage 保持 extension/custom 不触发 input；无 ticket 的宿主程序 prompt 零 commit 是产品合同测试，不充当 LLM 攻击证据    |
| TUI 完整性        | Enter idle/stream steer、Alt+Enter follow-up、粘贴/多行/图片、自定义 editor、compaction-held 保留身份；不接管 stdin、不重复 onSubmit；启动 initialMessages 零 proof |
| 生命周期          | accepted≠consumed；handled/rejected/clear_queue/取消/恢复 editor 不开窗；重复 dispatch、重试、同 ID 换文不续；callback 抛错/checkpoint 失败原输入仍正常             |
| RPC 分界          | 获准 terminal 实际 submit 正例；普通机器连接伪造全部字段仍拒授权；连接重放/断开/换 sid 拒绝；同连接自动消息不用提交通道                                             |
| epoch / authority | Root0 首条和连续不同 ID 各 +1，重复零；三 child 合计≤2、每 child≤1；旧 child level 不变；proof 不下放 child 权限                                                    |
| 负面来源          | 通知/定时/custom/机器/ask dialog 自动关闭/模型选择不 reset；human ask 答案本次也不 reset                                                                            |
| Web / 旧版        | xs=false 的 tree-only 正例；held/Feishu/replay/digest conflict 负例；旧 SDK 新消费合同 unavailable（非 TUI 不可信），feature-off/旧 factory A/B 原字节              |
| reload / 安全     | 老 owner callback、旧 session/fork/连接票据拒；已用高水位不减；lazy 零写；无 secret 到模型/traffic/log，dispose 无残留 listener/timer                               |
| strict RPC 专项门 | on 普通 rpc 不 resetRoot、不增 epoch；on 受信 ticket 消费两处理器各按合同执行；off/未传 strictRpc 恢复旧 rpc reset；共享 classifier/XS handover 无顺手变更          |

## 8. Review 1–4 处置与剩余实施门

| review          | 处置                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 威胁越界      | 已纠正 E1/摘要/TUI/兼容表；保留同形实验事实，撤销“宿主可调用 ⇒ LLM 可伪造”的强结论；区分 DTO 字段与来源可信性                                             |
| 2 改造过重      | 收敛为一个 submission port/ticket + readonly observer；优先 coding-agent 原 UserMessage WeakMap/sidecar，原 ref/时序未证前不宣称可用，不默认扩 agent-core |
| 3 消费时序      | accepted≠consumed 现为用户正式选择，排队取消零新增额度；同文匹配禁止；ask_user 答案不计标为本方案保守收紧，非用户旧要求                                   |
| 4 两套权威/兼容 | 已加入 on strict RPC 旧级归零门、两处理器时点及 off/旧 factory 字节兼容；不改变共享 XS 权限；来源/供给未定位不再包装为马上必须拍板                        |

剩余真正 implementation gates（仅两项；不是要求现在重新选择产品强度）：

1. **接口证据与供给门**：先离线证明 coding-agent 原对象 identity/消费时序、strictRpc 正负/兼容及故障降级；只有证实必要才申请 agent-core patch。SDK 上游接口/供给与版本审批未完成，不改 installed 包、不授权 fork。
2. **入口落地与投产门**：实施前定位实际受信 terminal client 并用其真实提交 handler 做正向离线 harness，配普通机器 RPC 负例；TUI/Web/目标客户端能力通过、Root 异源复审和用户明确首期生产范围后才解冻 P1/P2。不因尚未选客户端声称全 RPC 支持。

默认 on、专用 RPC、消费时序、RPC 归零收紧均已定，不再讨论是否必要；当前仅设计收口，不批准 SDK 修改或生产接线。
