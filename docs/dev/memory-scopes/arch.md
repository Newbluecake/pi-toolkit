# #39 三层记忆作用域（session / project / hub）· 架构设计（r3）

> 状态：**架构已定，用户实施确认已通过；Plan conditional pass 四条件收口待 Root 核对，本次仅改文档**。本文不改 src/tests/既有 README/用户记忆/设置/私有 PG 数据。
> 下游：Root 核对 r3 / review3 收敛表 → 用户一页确认（HARD GATE）→ Plan → 分包开发。
> r2.1（同日）：用户经 ask_user 拍板**首期同时支持 TUI 与 Web 授权**；Web 复用现有远程问答通道（`AskUserRemotePort`），见 §0.3、§5.2。
> 依据：上游 GLM 只读探索、r1 本轮核验、异源评审 r_F3CH8TTF 的 10 条（§0.1 闭合表）、用户两次 ask_user 拍板（§1.2）。

## 0. r3 集中修订与闭合表

### 0.1 review3 收敛表（r_715HH3GK，Root 裁定）

本轮只修三处真实缺口；不启动第四轮架构评审。下表「闭合」指架构约束明确，**不是实现或 conformance 已通过**。r2.1 中的同 HOME 推算槽位、同文本 ledger 来源判断、raw 字节当作 JSON 字节的论断均撤回。

| 原评审 # | 状态         | r3 处置 / 保留边界                                                                                                                                                                                           | 证据与落点                                                                                         |
| -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1        | 本轮修订     | memory 接收 WebHub 同一次解析的 effective stateDir；launchHome / paths override 不得二次猜 HOME；off 才走显式 default-slot                                                                                   | `src/web-hub/agent/index.ts:610-618`；§3.4                                                         |
| 2        | 本轮修订     | 可信派发点产生一次性本地 proof，绑定 cmdId/owner/session/generation；文本只能候选。即时输入与 SDK 排队分开；新增本地 dispatch scope 接缝，未证明路径 fail closed；真人 exact-content + 私有 OpCap 仍是硬授权 | `commands.ts:595-605,660-700`；SDK `agent-session.js:1649-1705,1928-1955,2792-2800`；§5.1、§9.0 P0 |
| 3        | 已闭合，保留 | 拒绝项第一；TUI select 与 Web remote host confirm；取消/超时/未知来源拒写                                                                                                                                    | §5.2                                                                                               |
| 4        | 已闭合，保留 | 私有 OpCap 冻结原文/target/rev/owner/branch，生命周期撤销，出队/锁内/提交复核                                                                                                                                | §5.2                                                                                               |
| 5        | 已闭合，保留 | session user 独立真人确认，authority-first 去重                                                                                                                                                              | §5.3、§6.7                                                                                         |
| 6        | 已闭合，保留 | 独立 memorySeed；逐次 workflow agent() 受理冻结；FIFO、显式 empty、deep freeze                                                                                                                               | §6.3                                                                                               |
| 7        | 已闭合，保留 | 子 project/hub 内容硬只读，legacy true 不绕；Jev 仅现有冷却戳/diag 派生例外，不扩打标/晋升                                                                                                                   | §5.4                                                                                               |
| 8        | 已闭合，保留 | 每操作一次 append；每 32 次以含 cause 的完整 snap 替代；buffered 不等于 fsync                                                                                                                                | §6.2                                                                                               |
| 9        | 已闭合，保留 | 最后 await 后 secure guard + session owner 复核                                                                                                                                                              | §8.2                                                                                               |
| 10       | 本轮修订     | raw/render/serialized DTO 三预算；先验证不可信形状，再构造纯 DTO；每次 append/snap/seed 实测 JSON UTF-8；坏 snap 整拒且 visible warning                                                                      | §6.6、§9.0 P0                                                                                      |

### 0.3 r2.1 追加裁定（Root + 用户，2026-11-07）

| #   | 裁定                                                                                                                                                                                                                                           | 落点            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| D1  | **首期同时支持 TUI 与 Web 授权**（用户经 ask_user 拍板）；r2 的 Q4「TUI-only」撤回                                                                                                                                                             | §5.2、§10       |
| D2  | Web 优先复用现有远程问答通道（`AskUserRemotePort` + `dialogs.ts` 桥），不另造交互系统；只做 agent 侧的**只追加**补强：`RemoteOutcome.originKind` 与可信派发的本地 proof-port（§5.1）；ledger 来源只作诊断。**不改 wire、不加 cap、不升 PROTO** | §5.2 Web 绑定表 |
| D3  | 取消、超时、hub 断连、`webHub.remoteAskUser` 关闭、hub 不支持 dialogs（旧 hub）⇒ Web 通道不可用；再没有 TUI ⇒ 拒写。**不会**退化成参数同意                                                                                                     | §5.2            |
| D4  | 飞书、xs、wake、无法证明来源的 rpc **不因 Web 支持而放行**：前置条件与答案来源都要求结构化的非飞书 web 来源                                                                                                                                    | §5.1、§5.2      |
| D5  | 「项目/Hub 对子只读」按**内容**的窄义解释；Jev 派生侧车只保留现有的只读消费派生行为（召回冷却戳、diag），不得以「派生」之名混入内容写入或权限变化；scopes 关闭时原样                                                                           | §5.4            |

### 0.2 r1 → r2 的其他更正

| 位置           | r1 表述                         | r2 更正                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4 compact 行  | 「下一轮全量重注入」            | PromptSectionHub 是**冻结快照 + 有界尾部更新**，section 只在 `before_agent_start`（每次 agent run 开始）计算。准确说法是：compaction 后的**下一次 agent start** 会重新快照（`hub.ts:339-341`）；run 中途发生 compaction 时，本 run 剩余部分仍用 run 开始时的快照，期间以 `view` 为准（残留 R5） |
| §4 workflow 行 | 「workflow 受理时捕获一次」     | 错误。fast 先例是在**每次 `agent()` 调用**、结构校验之后捕获（`host.ts:923-928`）；memory 同样逐次捕获                                                                                                                                                                                          |
| K5 / F1        | 复用 `classifyHumanInput`       | 撤回：它信任 rpc 和 web ledger，同文本可能来自飞书                                                                                                                                                                                                                                              |
| K2 / §3.4      | hub 根 = `<memoryRoot>/.hub`    | 撤回，见 #1                                                                                                                                                                                                                                                                                     |
| §6.2 写入      | put + 每 32 次额外追加一条 snap | 撤回，见 #8                                                                                                                                                                                                                                                                                     |

---

## 1. 背景与目标

### 1.1 要解决的问题

1. **会话内的事实没有确定性载体**：当前任务里的约定只活在对话里，compact/switch_context 后只能靠模型手写的 summary 带过去。`PendingHandoffStore` 是 TTL 120s、只消费一次的 summary 替代品，不是会话记忆（`src/context-switch/store.ts:28`）。
2. **跨项目的偏好没有可写的共享层**：项目记忆按 cwd 隔离（`src/memory/paths.ts:44-46`）；`~/.pi/agent/AGENTS.md` 是用户手写的文件，agent 不应去改。
3. **#36 的 `scope:global` 只是「项目内常驻」**（`src/memory/blocks/format.ts:11,45-46`；`jev/questions.ts:288-297`），不能挪作跨项目语义。

### 1.2 用户已拍板（不再重问）

| #   | 决策                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | fork 继承分叉点的会话记忆快照并带来源；之后独立，不回写                                                                                                                |
| U2  | resume 恢复同一 session；不是有意继承的新普通 session 从空开始                                                                                                         |
| U3  | 只有显式才写全局；分类器/模型不得自动提升到全局                                                                                                                        |
| U4  | 允许主 agent 代写全局，但必须是用户明确要求；不能只凭工具里的 `storageScope=hub`；保留授权来源；要有宿主可核验的授权/交互确认，防止模型自授权；不能只凭字面声明 `user` |
| U5  | 新子 agent 继承父会话 session 快照：受理时冻结、来源可见、之后独立、不回写；project/hub 对子只读；子不能提升到 hub；父为空则子也为空                                   |
| U6  | 跨 compact/switch_context 确定性恢复；项目隔离；同 Hub 会话全局共享，来源可区分且不泄漏                                                                                |
| U7  | secure/locked：全局层强制关闭且不能被恢复，不跨 vault；会话/项目保留原有加密存储；不新增明文 sidecar                                                                   |

### 1.3 约束

- I1–I12。#36 门禁：G1 正例 10<20 BLOCKED，G2 无有效 live（`docs/dev/memory-governance/pg-report.md` §状态）；不翻 `memory.layout` 默认，不迁移真实数据，不自动开启付费调用；线上为 files/tiered，`migrate.auto` 为 false。
- 不加定时任务，不做多机同步，不让模型/分类器自动改写。

---

## 2. 现状摘要（已核验坐标）

| 区域                     | 坐标                                                                                                                                                                                                                                                                | 事实                                                                                                                                                                                                                                                                                                                                                                                             | 对设计的意义                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Hub 槽位                 | `src/web-hub/agent/index.ts:612-618`；`protocol/paths.ts:164-166,265-287`；web-hub README「agentDir 与 hub 状态」                                                                                                                                                   | agent 拉起 hub 时 `home = deps.launchHome ?? HOME非空 ?? homedir()`，但 `deps.paths` 优先于 `resolveHubPaths({home, uid})`；有效 stateDir 取最终 paths，不可再由 HOME 推导；不跟随 agentDir；`hub.json.nonce` 每次进程启动都变                                                                                                                                                                   | Hub 稳定身份 = (uid, stateDir)                              |
| 项目层根                 | `src/memory/paths.ts:25-30`                                                                                                                                                                                                                                         | `ARMORY_MEMORY_ROOT ‖ homedir()/.pi/agent/memory`；secure 会改写它                                                                                                                                                                                                                                                                                                                               | **不能**作为 hub 身份（#1）                                 |
| 注入枢纽                 | `src/sysprompt/hub.ts:40-69,166-181,225-232,333-345,410-420`；`prompt-sections/store.ts:117-146`；`fold.ts:2-5`                                                                                                                                                     | provider 拿到 ctx；`sessionScoped` 按 sid 判定归属；section 只在 `before_agent_start` 计算；compaction ⇒ forgetAnnounced + prefixFresh ⇒ 下次 agent start markStale；空文本不进 fold                                                                                                                                                                                                             | session/hub 两个新 section；恢复时点是「下次 agent start」  |
| 会话条目 SDK（pi 1.5.0） | `session-manager.d.ts:81-85,280,318,372,401`；`session-manager.js:1217-1261`；`extensions/types.d.ts:1295`                                                                                                                                                          | CustomEntry 不进 context；`getBranch` 包含全部条目；fork 复制时保留原 data；单次 append 抛错时回滚这一条内存条目，但不回滚此前的其他 append（Root 已确认）；无 conversation 时只缓冲；首个 user 或 assistant 形成 conversation 即开始落盘（SDK `session-manager.js:786-815`）；append 成功仅表示 appended，不等于 fsync                                                                          | 每次操作只做一次 append；fork 时用 sid 判定继承             |
| 会话态先例               | `src/goal/store.ts:1-60`；`src/todo/index.ts:294-355`；`src/archive/state.ts:25,151`                                                                                                                                                                                | 从 `getBranch()` 倒序读；new 不继承；不用 `getEntries()`                                                                                                                                                                                                                                                                                                                                         | 沿用同一口径                                                |
| 迟到写入的坑             | `src/stack-teardown.ts:~103`                                                                                                                                                                                                                                        | 旧 control 迟到的 `appendEntry` 会污染新会话                                                                                                                                                                                                                                                                                                                                                     | owner/epoch 复核                                            |
| fast seed 管线           | `core/types.ts:210-218,1401-1403`；`spawn-service.ts:995-1015`；`runtime-adapter.ts:654-656`；`session-driver.ts:736-740,828-860`；`workflow/host.ts:60-72,400-410,923-928,1183-1186,1329-1331`；`workflow/spawner-adapter.ts:48,78,141`；`request-threading.ts:51` | spawn 在所有 admission gate 之后、队列之前捕获；workflow 在每次 `agent()` 结构校验后、hash/replay/两层队列之前捕获并冻结；外部 agent 剥除；driver 在 `createAgentSession` 之前追加；fast 追加失败即致命                                                                                                                                                                                          | memorySeed 只复用**位置**                                   |
| 人类输入                 | `extensions/types.d.ts:929-939`；`src/fabric/wake-input.ts:28-40`                                                                                                                                                                                                   | `InputEvent.source ∈ interactive/rpc/extension`；`classifyHumanInput` 把 rpc 也当人类                                                                                                                                                                                                                                                                                                            | 只接受 `interactive`                                        |
| UI                       | `extensions/types.d.ts:40-45,83-87,231`                                                                                                                                                                                                                             | `select(title, options, {signal, timeout})` 返回 `string\|undefined`；`ExtensionMode = tui\|rpc\|json\|print`                                                                                                                                                                                                                                                                                    | 用 select 并把拒绝项放第一个                                |
| 远程问答通道             | `src/ask-user/remote.ts:1-45`；`src/web-hub/agent/dialogs.ts:22-35,82-91,235-262,289,346-349`；`src/web-hub/agent/index.ts:2416`；`src/topic-switch/confirm.ts:100-175`                                                                                             | `AskUserRemotePort.open({toolCallId, questions, allowCancel, attributionTitle?})` 返回会话；`createDialogRace` 同步裁决先到者；web 答案经 hub `cmd dialog_answer`（dialogId + epoch + 选项校验）回调 `onRemote({kind, answers, origin: string})`；`origin` 目前被 `originText` 压成 `user@ip` 字符串；topic-switch 已用它做 TUI ⟂ web 竞速确认；端口仅在 `webHub.remoteAskUser` 开启且连接时存在 | Web 授权直接复用；补结构化 `originKind`                     |
| 飞书来源判定             | `src/web-hub/protocol/messages.ts:968-985`                                                                                                                                                                                                                          | `CmdOrigin{listener, ip, user?, reqId}`；`isFeishuCmdOrigin = ip==="feishu"`，只有 hub 侧 F6 准入能构造，浏览器无法伪造                                                                                                                                                                                                                                                                          | 结构化排除飞书                                              |
| web prompt 归属          | `src/web-hub/agent/ledger.ts:55-70,333-339`；`src/web-hub/agent/index.ts:2417-2424`                                                                                                                                                                                 | `attributeInput` = `hasPromptText(text, sid)`，**不记录来源**，飞书 prompt 同样命中                                                                                                                                                                                                                                                                                                              | 文本查询只作候选；授权前置改为可信派发 proof（§5.1）        |
| web 观察对话框           | `src/web-hub/agent/event-tap.ts:344-360`；`dialogs.ts:358-380`                                                                                                                                                                                                      | web 只把 `ui_prompt_start` 的 kind/title 作为横幅镜像；只有显式登记了 `attributionTitle` 的 select 才会接受 web 作答                                                                                                                                                                                                                                                                             | 不登记 ⇒ 只能本地 TUI 作答；title 会出现在 web 横幅（§8.2） |
| secure 门                | `src/secure/memory-gate.ts:9-40`；`src/secure/domain.ts:183-199`；`src/config/settings.ts:436-457`                                                                                                                                                                  | 实时 `vaultMountState` + `inVaultWriteZone`；D8 克隆后覆盖                                                                                                                                                                                                                                                                                                                                       | 新增同口径的 session 门                                     |
| 子会话写闸               | `src/memory/tool.ts:96`；`tool-v2.ts:585`；`tool-v3.ts:647`；`settings.ts:454`                                                                                                                                                                                      | 三套工具都读 `settings.allowWriteInChildSessions`（默认 false）                                                                                                                                                                                                                                                                                                                                  | 用有效设置强制覆盖                                          |
| block 原语               | `src/memory/blocks/store.ts:64-228`；`lock.ts:45-58`                                                                                                                                                                                                                | readCorpus / create / replace(CAS) / trash；锁默认 2000ms、unref                                                                                                                                                                                                                                                                                                                                 | hub 存储复用这些原语                                        |

---

## 3. 总体设计

### 3.1 三层模型

| 层      | 权威源                                                             | 生命周期                                           | 可见范围                      | 写入者（首期）                                                                                       | 注入                                 |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| session | 会话文件 `CustomEntry subagent:memory-session`（沿 `getBranch()`） | 同会话文件；resume 恢复，new 为空，fork/子继承快照 | 本会话（fork/子各持冻结副本） | 本会话 agent（user 级须走 §5.3）；子会话只能写自己的会话，且恒为 agent                               | `pi_session_memory`（sessionScoped） |
| project | `<memoryRoot>/<slug>/`（现状）                                     | 现状                                               | 同一 cwd                      | 现状；scopes 开启后对子会话强制只读                                                                  | `pi_project_memory`（不改）          |
| hub     | `<stateDir>/hub-memory/blocks/*.md`                                | 持久，删除进 `.trash`                              | 同一 Hub 槽位内的所有会话     | **仅主会话**：`/mem hub add`（TUI 用户亲手输入），或 agent 请求 + TUI/Web 对话框中的人类授权（§5.2） | `pi_hub_memory`                      |

### 3.2 模块与文件地图

| 模块                                                                                                           | 新/改              | pi-free | 职责                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/scopes/types.ts`                                                                                   | 新                 | 是      | DTO、`StorageScope`、硬上限与产品上限常量、seed/cap 类型、端口接口                                                                                                                            |
| `src/memory/scopes/limits.ts`                                                                                  | 新                 | 是      | UTF-8 计量与校验（`validateItem/Entry/Snap/Seed`）、render 预算公式                                                                                                                           |
| `src/memory/scopes/session-fold.ts`                                                                            | 新                 | 是      | `foldSessionMemory`（整条 snap 校验、继承标注、丢弃诊断）                                                                                                                                     |
| `src/memory/scopes/session-ops.ts`                                                                             | 新                 | 是      | `planSessionOp` ⇒ 单个 entry（put/del/snap-with-cause）                                                                                                                                       |
| `src/memory/scopes/op-cap.ts`                                                                                  | 新                 | 是      | `OpCap` 状态机（mint/reserve/consume/revoke）、绑定比对、审计行生成                                                                                                                           |
| `src/memory/scopes/hub-slot.ts`                                                                                | 新                 | 是      | `resolveHubSlot({effectiveStateDir, uid})`、namespace 读取/规划/比对                                                                                                                          |
| `src/memory/scopes/hub-store.ts`                                                                               | 新                 | 是      | 薄封装 blocks 原语、marker/namespace 初始化、审计                                                                                                                                             |
| `src/memory/scopes/render.ts`                                                                                  | 新                 | 是      | 两个 section 的渲染、优先级说明、去重                                                                                                                                                         |
| `src/memory/scopes/wire.ts`                                                                                    | 新                 | 否      | 注册 section、工具 `scoped_memory`、读型 `input`/`agent_end` hook、写队列、owner 守卫、对话框、子会话写闸叠加                                                                                 |
| `src/memory/index.ts`                                                                                          | 改                 | 否      | scopes 开启时：调用 `wireMemoryScopes`；对子会话强制有效设置；叠加 writeGate                                                                                                                  |
| `src/memory/blocks/format.ts`                                                                                  | 改（追加）         | 是      | `BlockMeta` 追加可选 `grant`、`src`（ORDER 末尾，仅 hub 目录有效）                                                                                                                            |
| `src/memory/{settings,setting-specs}.ts`                                                                       | 改                 | 是      | `memory.scopes.session`、`memory.scopes.hub`                                                                                                                                                  |
| `src/config/settings.ts`                                                                                       | 改                 | —       | D8：`memory.scopes.hub=false`                                                                                                                                                                 |
| `src/secure/memory-gate.ts`                                                                                    | 改（追加）         | —       | 新增导出 `secureSessionWriteGate(domain, deps?)`                                                                                                                                              |
| `src/core/types.ts`                                                                                            | 改                 | —       | `MemorySeedCapture`；`SpawnRequest.memorySeed?`、`SessionSpec.memorySeed?`                                                                                                                    |
| `src/service/{spawn-service,runtime-adapter,request-threading}.ts`                                             | 改                 | —       | 捕获、剥除、透传                                                                                                                                                                              |
| `src/workflow/{host,spawner-adapter}.ts`                                                                       | 改                 | —       | 每次 `agent()` 捕获，`QueuedAgentCall`/`ChildSpawner.spawn` 透传                                                                                                                              |
| `src/runtime/session-driver.ts`                                                                                | 改                 | —       | seed 追加（失败即拒绝创建）                                                                                                                                                                   |
| `src/memory/scopes/authorize.ts`                                                                               | 新                 | 否      | `requestOpApproval(...)`：TUI select ⟂ `AskUserRemotePort` 竞速（`createDialogRace`），按 confirm.ts 先例实现；返回 `{approved, channel, who?}`                                               |
| `src/web-hub/agent/human-dispatch-proof.ts`                                                                    | 新（本地设计接缝） | 否      | activation 私有 async dispatch scope；commands 派发/input 入口共享同一实例，核验后一次消费；P0 先证明真实 SDK 链，不改 wire                                                                   |
| `src/ask-user/remote.ts`                                                                                       | 改（追加）         | —       | `RemoteOutcome` 追加可选 `originKind?: "loopback" \| "lan" \| "feishu"`（缺省 ⇒ 视为未知）                                                                                                    |
| `src/web-hub/agent/dialogs.ts`                                                                                 | 改（追加）         | —       | `answer/cancel` 由 `CmdOrigin` 结构推导 `originKind`（`isFeishuCmdOrigin` / `listener`）；字符串 origin ⇒ 不填                                                                                |
| `src/web-hub/agent/ledger.ts` + 命令接收处                                                                     | 改（追加）         | —       | ledger 可追加结构来源供诊断；新增 activation 私有 `HumanDispatchProofPort`，在真实 sendUserMessage 调用处绑定 frame.id / owner / sid / generation，一次性消费（§5.1）；禁止文本查询充当 proof |
| `src/web-hub/agent/index.ts`                                                                                   | 改（追加）         | —       | 透传同一 effective paths 的 stateDir 与本地 proof-port；不扩 wire；未知来源恒拒绝                                                                                                             |
| `src/index.ts`、`src/stack.ts`                                                                                 | 改（只透传）       | —       | 端口接线（I2）                                                                                                                                                                                |
| `src/memory/{command,doctor}.ts`                                                                               | 改                 | 否      | `/mem hub …`、`/mem session add`、子会话写子命令拒绝、H01–H05                                                                                                                                 |
| `skills/memory-jev/SKILL.md`、`docs/dev/memory/README.md`、`docs/dev/data-encryption/README.md`、AGENTS.md I11 | 改                 | —       | 策略与不变式                                                                                                                                                                                  |

### 3.3 依赖方向

| 上游                        | 下游                                                                                                           | 约束                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `src/index.ts` / `stack.ts` | `wireMemory`、spawn/workflow deps                                                                              | 只透传端口                    |
| `scopes/wire.ts`            | `scopes/*`（pi-free）、`sysprompt/hub.ts`、`blocks/store.ts`、`lock.ts`、`web-hub/protocol/paths.ts`（纯函数） | 不 import `jev/*`、`govern/*` |
| `scopes/hub-store.ts`       | `blocks/*`                                                                                                     | 单向                          |
| `service/*`、`workflow/*`   | `scopes/types.ts` 中的端口接口与 DTO                                                                           | 只依赖接口                    |
| `runtime/session-driver.ts` | `SESSION_MEMORY_ENTRY_TYPE` 常量、seed DTO、`SessionWriteGate` 接口                                            | 不理解记忆语义                |
| web-hub（hub 侧）           | 无                                                                                                             | 首期不读 hub-memory           |

### 3.4 「同 Hub」的身份与根（#1）

**槽位解析** `resolveHubSlot({effectiveStateDir, uid})`：memory 不自行猜 HOME。WebHub 开启（即使 daemon 尚未运行）时，装配层从 **WebHub 同一次有效路径解析结果**传入 `paths.stateDir`；`deps.paths` 优先，否则使用 `deps.launchHome ?? (HOME 非空 ? HOME : homedir())` 调用 `resolveHubPaths`，准确对应 `src/web-hub/agent/index.ts:610-618`。需新增的是本地依赖透传，不是 wire。不得为了 memory 再运行一份「看似相同」的 HOME 解析。test/sandbox 的 paths override 也必须同源注入 memory。

**WebHub off 的 default-slot**：装配层明确调用同一个路径解析入口，以显式测试 override（若有）为优先，否则 `launchHome ?? HOME非空 ?? homedir()`，结果传给 memory；普通运行即 `<home>/.pi/agent/web-hub`。这只是现有默认单例槽位在 daemon 关闭时的定位，不增加新 Hub 模式。`root = <effectiveStateDir>/hub-memory`。`ARMORY_MEMORY_ROOT` 与 `PI_CODING_AGENT_DIR` 均不参与。secure 下不解析、不创建。

| 文件 / 目录                           | 内容                                                                                                                | 创建时机                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `<stateDir>/`                         | Hub 状态目录（STATE_DIR_POLICY：0700、属主 uid、非 symlink）                                                        | 已存在则只做只读校验；不存在时只在首次授权写入时按 `ensurePrivateDir(STATE_DIR_POLICY)` 创建 |
| `hub-memory/`                         | 0700，不允许 symlink                                                                                                | 首次授权写入时                                                                               |
| `hub-memory/namespace.json`           | `{v:1, uid, stateDirReal, stateDev, stateIno, host: sha256(/etc/machine-id ‖ os.hostname())[:16], createdAt}`，0600 | 同上（锁内）                                                                                 |
| `hub-memory/blocks/` + `.layout.json` | block 文件 + marker（复用 `blocks/marker.ts`）                                                                      | 同上                                                                                         |
| `hub-memory/.trash/`、`audit.jsonl`   | 软删除；审计（无正文，≤256 行）                                                                                     | 按需                                                                                         |

**身份比对**（每次读写都做，纯只读）：`namespace.json` 与 blocks 都不存在 ⇒ 空库。任一字段不符、blocks 存在但 namespace 缺失/损坏、stateDir 不满足策略 ⇒ **惰化**：不读不写，主会话通知一次，doctor H01 给出修复路径（P3 的 `/mem hub adopt` 是 TUI 用户动作，核对后重新盖章）。

**验收矩阵**：

| 场景                                                                 | 期望                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| 同 uid、同 effective stateDir，改变 HOME / memoryRoot / agentDir     | 同根；有效注入优先，不再猜 HOME                             |
| 无 paths override，分别给 launchHome / HOME / 二者都无               | 按 WebHub 优先序选择；memory 得到该次解析产物               |
| 同 HOME，两个不同 paths.stateDir override                            | 不同根；不能声称同 HOME 必然同 Hub                          |
| launchHome 与 paths.stateDir 故意不一致                              | paths 优先，memory 与 WebHub 使用相同 effective stateDir    |
| headless/test/sandbox 注入 × memoryRoot override × agentDir override | 交叉矩阵逐个核对实际 effective path；不得仅用 HOME 未变推断 |
| webHub off / enabled 但 daemon 未运行                                | off 走明确 default-slot；enabled 仍取 WebHub 有效解析结果   |
| 不同 uid、属主不符                                                   | 属主校验失败惰化；同字符串路径不等于可共享身份              |
| 同槽位跨主机 / stateDir dev或ino改变                                 | host 或 dev/ino 不符惰化，待用户 adopt                      |
| secure / locked                                                      | 强关，不解析槽位                                            |

**为什么首期无 wire**：有效槽位来自 agent 的同一解析对象，而不是 hub 远程确认；namespace 在该路径下再验证 uid/realpath/dev/ino/host。memory 读写不要求 daemon 在线，但 **Web 授权仍要求可用 dialogs 通道**（§5.2）。不声称所有 HOME/override 组合自动一致；同源透传和矩阵是 Plan P0 的实现前置。

**Plan 需核实**：hub 的管理流程（`/webhub stop/restart/token rotate`、状态目录清理）不会删除 `hub-memory/`（只删已知文件名）；如果有通配清理，hub-memory 要列为保留项。

---

## 4. 生命周期矩阵

| 事件                               | session 层                                                                                                                                                      | project 层           | hub 层                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| compaction（任意原因）             | 条目不被删 ⇒ 折叠结果不变；**下一次 agent start** 时枢纽重新快照，section 反映当前状态。run 中途 compaction ⇒ 本 run 剩余部分仍用 run 开始时的快照，`view` 为准 | 现状                 | 同 session（每次 agent start 从盘读取）            |
| switch_context                     | 同上；`resume:true` 的自动续跑消息会开启新的 agent run ⇒ 立即刷新；不依赖 handoff 文本                                                                          | 现状                 | 同上                                               |
| `/reload`                          | 闭包重建；`session_start(reload)` 重新折叠；**撤销所有 cap**                                                                                                    | 现状                 | 同上；撤销 cap                                     |
| 重启 + resume                      | 同一文件 ⇒ 恢复                                                                                                                                                 | 现状                 | 照常                                               |
| `/new`、新启动                     | 空                                                                                                                                                              | 现状                 | 照常注入                                           |
| `/fork`、`forkFrom`                | 复制来的条目带原 sid ⇒ 继承分叉点状态（标为 `inherited·fork`）；之后只追加到新文件；撤销 cap                                                                    | 新 cwd 的项目        | 照常                                               |
| `/tree` 换叶                       | branch-local（从新叶折叠）；`branchGen++`；撤销 cap                                                                                                             | 现状                 | 照常                                               |
| cwd 变化 / worktree                | 不受影响                                                                                                                                                        | worktree 映射主 repo | 不受影响                                           |
| 子 agent 新建                      | 受理时冻结父快照；driver 写首个 seed snap；之后独立；父为空 ⇒ `empty`，不写条目                                                                                 | 强制只读             | 只读注入，工具 enum 里没有 hub                     |
| workflow `agent()`                 | **每次调用**在宿主受理时（结构校验后、hash/replay/两层队列前）捕获                                                                                              | 同上                 | 同上                                               |
| 子 agent resume                    | 不再种子                                                                                                                                                        | 同上                 | 同上                                               |
| 外部 agent                         | 剥除 seed                                                                                                                                                       | 现状                 | 不导出                                             |
| 嵌套子                             | 从直接父 run 的会话冻结                                                                                                                                         | 只读                 | 只读                                               |
| secure                             | 允许；append 前复核挂载与写区                                                                                                                                   | 现状                 | 强制关闭                                           |
| 运行中被卸载（LOCKED）             | provider 返回空且不读 branch；写入在 append 前被门拦截                                                                                                          | guard 拦截           | 关闭                                               |
| `--no-session`                     | 只在内存中，回显标 `memory-only`                                                                                                                                | 现状                 | 照常                                               |
| print/json 模式                    | session 可用；user 级与 hub 授权不可用（无 TUI、也无 Web 回合）⇒ fail closed                                                                                    | 现状                 | 只读                                               |
| rpc 模式（含 web 派生的 headless） | session 可用；授权**只走 Web 通道**，且回合必须有已消费的可信 web dispatch proof；不用本地 select（rpc 客户端身份无法证明）；Web 不可用 ⇒ fail closed           | 现状                 | 只读 / Web 授权写                                  |
| hub daemon 断连 / 关闭             | 无影响                                                                                                                                                          | 无影响               | 读层不受影响；Web 授权不可用且待决授权拒绝（§5.2） |
| 旧版扩展                           | 忽略未知 customType                                                                                                                                             | —                    | 不读 hub-memory                                    |

---

## 5. 授权、authority 与权限

### 5.1 人类回合跟踪（只用作前置条件）

`HumanTurnTracker` 状态机仍在 pi-free `op-cap.ts`；宿主 wire 的 input hook 恒返回 `continue`。它仅防非人类来源轰炸授权框，**不能替代真人具体内容确认与 OpCap**。

| 事件                                                                               | 动作                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| TUI `source==="interactive"` 且 `ctx.mode==="tui"` 的即时输入                      | 新 humanTurnId，清空 rejected/dialogs，撤销旧 cap                          |
| Web `source==="extension"`，本次输入成功消费可信派发 proof，且非排队路径           | 新 humanTurnId/channel=web；绑定 proof 的 owner/sid/generation，撤销旧 cap |
| rpc/飞书/xs/wake/goal/schedule；无 proof；只有同文本记录；排队但未证明实际消费关联 | 清空 humanTurnId，撤销 cap；不弹框                                         |
| agent_end / session_start / tree / shutdown / reload / abort                       | 撤销回合、cap 与未消费 proof                                               |

**真实路径与最小新增本地接缝（设计，尚未实现/实测）**：

1. `commands.ts:595-605` 的即时派发和 `:660-700` 的 held/release 派发在调用 `pi.sendUserMessage` 时确实持有 cmdId、结构化 CmdOrigin、session 和 owner；`beginOrReply(:286-300)` 将 owner/session 写入 ledger。现有 `noteWebProof(:1204-1211)` 仅为其他功能的 advisory 记录，**不复用为本授权证明**。`ledger.ts:333-339` 与 `index.ts:2417-2424` 的同文本查询哪怕唯一、哪怕带 originKind，也不能证明当前 input 来自该 dispatch；旧 observed web + 后 xs/wake 同文本必须拒绝。
2. 新 `HumanDispatchProofPort` 在 **每 activation 私有闭包**内拥有 `AsyncLocalStorage`（宿主适配层，非 pi-free 核心）。仅可信命令派发点可 `runDispatch({cmdId, owner, sid, generation, originKind}, send)`；generation 每次真实派发递增，结构来源先排除飞书。store 持有不可由工具参数取得的一次性 token；input 入口以 `getStore()` 取 token、核对当前 owner/sid/generation 后原子消费。缺失/已消费/撤销即拒绝；相同 text/digest 只可作为额外一致性检查，不能查 ledger 反向铸造 token。proof 只为本次 dispatch → input；consume 后形成回合记录，不让后续异步后代重复认领。
3. 真实 SDK：`extensions/types.d.ts:929-943` 的 InputEvent 只有 text/images/source/streamingBehavior，**没有 cmdId/owner/generation**。`agent-session.js:1928-1955` 将 sendUserMessage 转为 source=extension 的 prompt；`:2792-2800` 的扩展桥不返回该 Promise；`runner.js:1201-1234` 顺序 await input handlers。因此不能用同步临时全局变量包一次调用就宣称成立；选 activation 私有 async 调用上下文保留正常 await 链，generation/一次性消费/撤销控制其寿命。P0 必须核对入口顺序（在可重入/转换 hook 前认领，或提供等价的宿主 ingress 接缝），验证并发、嵌套、handled/throw 的 token 不串用。不得把 async context 自动继承等同于授权。
4. **排队不是即时回合**：SDK `agent-session.js:1649-1705` 在 input 后才入 steer/followUp 队列，实际消费没有可依赖的 consume-source proof。首期 native queued 引出的 hub 写请求**必然 `E_HUB_NEEDS_HUMAN_TURN`**，零写/不弹授权框，提示 idle 后新的 Web 请求/明确授权动作；不自动 duplicate/重送原 prompt。首期保留正常 idle Web 正向授权，**Root 裁定不采用新增 held adapter、通用 idle 重派或专用延后授权模式**；此前 held 接缝只是未来可选设计，不进入本期接口/写域，普通 Web 队列语义不改。
5. **idle 准入单源**：P0 冻结仓库已有 `agent_settled` loop hook + 公开 `ctx.isIdle()` / `ctx.hasPendingMessages()` 机制（`src/goal/hook.ts:426-446`、`src/index.ts:716-730`；SDK `extensions/types.d.ts:254-263,819-824`）。hook 仅记录 settled，绝不自动派发；可信正常 Web dispatch 当场同步核 owner/epoch、idle=true、pending=false 与 activation gate，再建立 scope/send。初始 idle session 由 session_start 初始化，不要求先出现 settled；新 run/input/切换撤销旧状态。缺 API/抛错/状态未知 fail closed（只拒记忆授权，不拦普通 prompt）。这仅是前置准入，仍须实际 dispatch→input→start proof 与真人 exact-content OpCap；P0 测生产顺序/续跑竞争/settled 延后，不把临时 probe 当生产过。公开 API 若不能闭合立即报 Root，不发明 SDK 字段。

回合 channel 不限制 TUI/Web 哪个通道作答。人类在真实 host dialog 中明确选择具体全文操作即硬授权，无需自然语言分类器。新增 proof-port 是 **本地接缝的方案**，不是声称已有 API 或已过真实 SDK 探针（§9.0）。

### 5.2 hub 写入：对话框授权 + 操作级 cap（#2/#3/#4）

**流程**（agent 代写；`/mem hub add|rm` 是用户亲手输入，走 §6.8）：

| 步  | 动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 失败                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 校验参数；**冻结**操作：深拷贝 `text`/`topic`/`from`，计算 `textDigest = sha256(text)` 与覆盖 scope/op/targetId/topic/text/from/expectRev 的 `opDigest = sha256(canonicalFrozenOp)`（在 expectRev 固定后计算；展示 digest8=opDigest[:8]）；update/delete 先读出 `expectRev`（调用方必须提供，且与盘上一致）                                                                                                                                                                                                                                                                                  | `E_*` 参数错误；`E_CONFLICT`                                                               |
| 2   | 前置条件：主会话 ∧ hub 开启 ∧ 槽位正常 ∧ `humanTurnId` 存在（§5.1） ∧ 至少有一个授权通道可用（TUI：`ctx.mode==="tui"` 且有 `ui.select`；Web：`AskUserRemotePort.open` 成功返回会话） ∧ 本回合未被拒绝过 ∧ 本回合弹框次数 <3 ∧ 当前没有其他待决授权                                                                                                                                                                                                                                                                                                                                           | `E_HUB_NEEDS_HUMAN_TURN`、`E_HUB_CONFIRM_UNAVAILABLE`、`E_HUB_DECLINED_TURN`、`E_HUB_RATE` |
| 3   | `requestOpApproval`：生成 `nonce = randomBytes(16)`；TUI 通道 `ctx.ui.select(title, [REJECT, AFFIRM], {timeout: 120_000, signal})` ⟂ Web 通道 `remote.open({toolCallId: "memory-op:" + nonce, questions:[{question: title, header:"HUB", options:[{label:REJECT},{label:AFFIRM}], allowOther:false}], allowCancel:true, attributionTitle: title})`，经 `createDialogRace` 先到者胜，败者被关闭/abort。`REJECT = "拒绝（不写入）"` 放第一个；`AFFIRM = "授权并写入 HUB（所有项目共享）· <digest8>"`。title（中文正文块）依次列出：目标 HUB、操作、id、**冻结原文全文**、digest8、当前项目标签 | —                                                                                          |
| 4   | TUI 胜：返回值 `=== AFFIRM`。Web 胜：`outcome.kind==="answer"` ∧ 唯一问题的选择 `=== AFFIRM` ∧ `originKind ∈ {loopback, lan}`（飞书或缺字段 ⇒ 拒绝）∧ 回调时**同步**复核待决授权的绑定（nonce、opDigest、incarnation、sid、branchGen、humanTurnId，见下表）仍然有效——不满足则回调返回 false（桥会给 web 返回 `E_DIALOG_CLOSED`）。满足 ⇒ 铸造 `OpCap`，记录 `channel` 与 `who = sha256(user@ip)[:8]`。其余所有结局 ⇒ 本回合 `rejected=true`                                                                                                                                                  | `E_HUB_DECLINED`                                                                           |
| 5   | 进入写队列；出队时同步复核 cap（§5.2 表）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `E_HUB_CAP_STALE`                                                                          |
| 6   | `withMemoryDirLock(root)`；锁内复核：槽位身份、`expectRev`、容量、`sha256(待写正文) === cap.textDigest`、cap 仍为 reserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `E_CONFLICT`、`E_FULL`、`E_HUB_CAP_STALE`、`E_NAMESPACE`                                   |
| 7   | 写入 block（`authority:"user"`，`grant`/`src` 由 cap 生成）；按 cap 字段写审计行；cap 置为 consumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `E_BUSY`（锁超时）等，cap 置为 revoked                                                     |

**`OpCap`**（宿主私有，只存在于闭包，永不进入参数、prompt、诊断或 wire）：

| 字段                               | 来源                                                                                | 复核时机                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| `capId`                            | `randomBytes(16)`                                                                   | 存在且 state=minted/reserved         |
| `incarnation`                      | `wireMemoryScopes` 激活令牌 + `sessionEpoch`（session_start 时递增）                | 出队、锁内                           |
| `sid`、`sessionFile`               | 弹框时的 `ctx.sessionManager.getSessionId()/getSessionFile()`                       | 出队、append/写入前                  |
| `branchGen`                        | session_start/session_tree 时递增                                                   | 出队                                 |
| `humanTurnId`                      | tracker 当前值                                                                      | 出队（必须仍是当前回合）             |
| `toolCallId`                       | 工具调用 id                                                                         | 出队                                 |
| `scope`、`op`、`targetId`、`topic` | 冻结值                                                                              | 锁内                                 |
| `textDigest`、`frozenText`、`from` | 冻结值                                                                              | 锁内比对 digest                      |
| `expectRev`                        | 冻结值（create 时为 undefined）                                                     | 锁内 CAS                             |
| `opDigest`                         | 冻结完整操作的 SHA-256；digest8 只供展示，不作为唯一身份                            | 授权回调、出队、锁内与提交前全值比对 |
| `nonce`                            | 授权请求时生成，等于 Web 对话框 `toolCallId` 的后缀                                 | Web 回调时比对                       |
| `via` / `channel` / `who`          | `"dialog"`；`"tui"\|"web"`；Web 为 `sha256(user@ip)[:8]`（session 的 cap 同样如此） | —                                    |

- **撤销**：new/resume/fork（`session_start` 任意原因）、`session_tree`、`session_shutdown`（含 reload）、tool/session signal abort、任何新 `input`、`agent_end`。撤销待决授权时同时 abort 本地 select，并以 `close("abort","aborted")` 关闭远程会话（桥随之关闭 web 卡片）。
- 时间戳只用于展示和审计，**不参与身份判定**。
- **审计**：`{at, op, id, rev, via, channel, who?, by:"agent"|"user", turn: humanTurnId 前 8 位, cap: capId 前 8 位, project: slugSha12, sid8}`，全部由 cap 生成，模型声明的任何字段都不进入。
- **不可伪造性**：模型能触发授权请求，但答案只来自本地 TUI 键盘，或经 hub 认证、带结构化 `CmdOrigin` 的浏览器 `dialog_answer`。工具参数、行内 meta（`<!-- mem user -->`、`scope=global`）、文件内容、跨会话消息都无法产生这两者；飞书答案由 `isFeishuCmdOrigin` 结构排除（只有 hub 的 F6 准入能构造）。不调用 `classifyHumanInput`，rpc 与同文本 ledger 都不构成前置条件。

**Web 通道的绑定与边界**（复用现有通道，只做 agent 侧追加）：

| 关注点             | 机制                                                                                                                                                                                       | 现有 / 新增                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 通道               | `AskUserRemotePort`（`webHub.remoteAskUser` 开启且已连接才存在）；hub 端渲染同一种 dialogs 卡片                                                                                            | 现有                                       |
| 一次性 nonce       | `toolCallId = "memory-op:" + nonce`；桥为每次 open 分配 dialogId，答案按 dialogId + 连接 epoch 寻址；关闭后的迟到答案 ⇒ `E_DIALOG_CLOSED`                                                  | 现有（Plan 核实 dialogId 唯一性）          |
| 操作摘要           | AFFIRM 标签里带 digest8，题干包含冻结原文全文；桥按选项校验答案，回调再逐字比对 AFFIRM                                                                                                     | 现有校验 + 本设计的比对                    |
| 属主               | 回调同步复核待决授权的 incarnation/sid/branchGen/humanTurnId；不匹配 ⇒ 不认领                                                                                                              | 本设计                                     |
| 来源               | `RemoteOutcome.originKind` 由桥从 `CmdOrigin` 结构推导：`ip==="feishu"` ⇒ `feishu`；否则按 `listener` 为 `loopback`/`lan`；字符串 origin（测试/旧路径）⇒ 不填。授权只接受 `loopback`/`lan` | **新增可选字段**（agent 本地，不上 wire）  |
| 回合来源           | 可信派发一次性 proof（cmdId/owner/sid/generation），同文本只作候选（§5.1）                                                                                                                 | **新增**（activation 私有本地 proof-port） |
| 取消 / 超时 / 断连 | web cancel、120s 超时（与本地共享一个计时器，unref + clampSpanMs）、hub 断连、端口不存在 ⇒ 拒绝                                                                                            | 现有语义                                   |
| 旧 hub             | 没有 dialogs 能力的 hub 永远不会产生 `dialog_answer` ⇒ 超时拒绝；若没有 TUI，则在第 2 步因端口不可用直接拒绝。**不新增 cap**，因为不需要新的帧                                             | —                                          |
| LAN                | LAN 浏览器已经过 hub 的 LAN 认证（含 2FA 策略），作为人类通道接受；审计记 `channel:"web"` 与 `who`                                                                                         | 现有                                       |
| 不会做的事         | 不降级成参数同意；不把飞书/xs/rpc 当作人类；不新增 HTTP 端点或帧                                                                                                                           | —                                          |

- **自然语言**：工具描述告诉模型「用户要求记到全局/所有项目时，用 `storageScope:"hub"` 调用，宿主会在屏幕上询问」。用户的原话只是促使模型发起请求，授权只来自对话框。

### 5.3 session 的 authority（#5）

| 来源                                                                                                                                                                                | 结果 authority                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 模型 `authority` 参数缺省或为 `agent`                                                                                                                                               | agent                                                                                        |
| 模型请求 `authority:"user"`（主会话，满足 §5.2 第 2 步同款前置条件）⇒ 经 `requestOpApproval`（TUI ⟂ Web）弹出 `[拒绝, 以用户令记录到本会话 · <digest8>]`，选中确认 ⇒ `SessionOpCap` | user，`grant:{via:"dialog", channel, turn, cap}`                                             |
| 同上但前置条件不满足或用户拒绝                                                                                                                                                      | **请求失败**（`E_USER_AUTH_DECLINED`），不悄悄降成 agent 写入；回显建议去掉 `authority` 重试 |
| 用户输入 `/mem session add <text>`（TUI 交互主会话）                                                                                                                                | user，`grant:{via:"command"}`                                                                |
| 子会话（任何参数）                                                                                                                                                                  | agent；参数 `authority` 被拒绝（`E_CHILD_AUTHORITY`）                                        |
| fork/seed 继承的条目                                                                                                                                                                | 保持来源 authority，并标继承来源                                                             |

- agent 修改或删除 user 条目：主会话中需要同样的对话框 cap，否则 `E_AUTHORITY`。子会话一律 `E_AUTHORITY`（包括继承来的 user 条目）。
- **为什么请求失败而不是悄悄降级**：降级会让模型以为已经记成用户令。改成显式失败 + 回显，符合「不能悄悄降成有人类回合 + 工具参数」的要求。

### 5.4 读写权限矩阵（scopes 开启时）

| 主体                           | session 读     | session 写                 | project 读 | project 写                                                      | hub 读    | hub 写                      |
| ------------------------------ | -------------- | -------------------------- | ---------- | --------------------------------------------------------------- | --------- | --------------------------- |
| 主会话 agent                   | ✓              | ✓（user 级须 cap）         | ✓          | ✓（现状）                                                       | ✓         | 仅凭对话框 cap              |
| 用户（TUI `/mem`）             | ✓              | `/mem session add`         | ✓          | ✓                                                               | ✓         | `/mem hub add\|rm\|restore` |
| 用户（Web 浏览器，非飞书）     | ✓（注入/卡片） | 通过 agent 请求 + Web 授权 | 现状       | 现状                                                            | ✓         | 通过 agent 请求 + Web 授权  |
| 子 agent                       | ✓              | 仅自己的会话，agent 级     | ✓          | **✗ 强制**（三套工具 + 命令 + writeGate；旧的 `true` 不能解除） | ✓（注入） | ✗                           |
| Jev / write-port / P 层 / 治理 | ✗              | ✗                          | 现状       | 现状（子会话内容写入被门挡住）                                  | ✗         | ✗                           |
| web-hub daemon / 外部 agent    | ✗              | ✗                          | 现状       | ✗                                                               | ✗         | ✗                           |

**子会话硬门的实现面**（#7）：

| 写路径                                                                   | 机制                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legacy / v2 / v3 工具                                                    | `wireMemory` 构造 `effectiveSettings = isChild && scopesOn ? {...settings, allowWriteInChildSessions: false} : settings`，三套工具都读这个字段（`tool.ts:96`、`tool-v2.ts:585`、`tool-v3.ts:647`）                                                               |
| `/mem` 写子命令（init/import/tidy/restore/migrate/hub/session/jev 写类） | 命令入口：`isChildSession && scopesOn && !readonly` ⇒ `E_CHILD_READONLY`                                                                                                                                                                                         |
| blocks store / 内部写口（`createBlockLocked` 等经 `checkWrite`）         | `writeGate` 叠加子会话谓词：`check()` 返回 `{ok:false, reason:"locked"}`（复用已有 reason，不改 #36 冻结的 `MemoryWriteGate` 联合类型），对外报错映射为 `E_CHILD_READONLY`                                                                                       |
| 治理 sweep / 迁移                                                        | 已经只在主会话运行（`index.ts:138,193`）                                                                                                                                                                                                                         |
| **窄例外（D5）**                                                         | 只保留 Jev **现有的只读消费派生行为**：召回时的 `aInjectedAt`/`pInjectedAt` 冷却戳与 `diag.jsonl`。子会话里打标与关系执行只由内容写入触发，内容写入被挡住后自然不会发生。不得借「派生」之名写入记忆正文、改 authority/scope/status 或执行取代。scopes 关闭时原样 |
| scopes 关闭                                                              | 全部维持原状（I9）                                                                                                                                                                                                                                               |

### 5.5 provenance（可区分、不泄漏）

| 场景         | 持久化                                                                      | 注入给模型                                                             | 人类视图 |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| hub 条目     | `src:{project: slugSha12, label≤40B, sid8}`；`grant:{via, by, turn8, cap8}` | `src=this-project` 或 `src=other#<6hex>`；不注入其他项目名、路径或 sid | 完整     |
| fork 继承    | 条目原 `sid`                                                                | `(inherited · fork <sid8>)`                                            | —        |
| 子 seed      | `inherit:{kind:"spawn", fromSid, fromLeaf, frozenAt}`                       | `(inherited · parent <sid8> @ HH:MM)`                                  | —        |
| 显式「提升」 | `from`（只记录来源）                                                        | 不注入                                                                 | 显示     |

「提升」= 带 `from` 的 hub create，完整走 §5.2 流程；原条目不动。没有任何自动提升路径。

---

## 6. 接口契约

### 6.1 设置

> **2026-11-08 用户裁定：产品默认开启**。下表「默认 false」是 2026-11-07 设计时裁定，已被覆盖；当前默认为 `memory.scopes = { session: true, hub: true }`，parser 尊重显式 `false` 与部分覆盖，`memory.enabled=false` 只阻止接线，非 live 需 `/reload` 生效。回滚 = 显式 false/false + reload，数据保留不擦除；secure 域 D8 继续强制 hub:false 且现有装配要求 plain，secure/locked 实际不创建 scoped shell/工具/section/store——默认翻转不等于 secure 内已启用。

| 键                      | 默认                                              | live | 备注                                                       |
| ----------------------- | ------------------------------------------------- | ---- | ---------------------------------------------------------- |
| `memory.scopes.session` | ~~false~~ **true**（2026-11-08）                  | 否   | 含子 agent seed、子会话 project 只读硬门                   |
| `memory.scopes.hub`     | ~~false~~ **true**（2026-11-08；D8 仍强制 false） | 否   | D8 强制为 false；接线时再校验 `secureDomainKind==="plain"` |

依附于 `memory.enabled`。任一开关开启 ⇒ 子会话硬门生效。

### 6.2 会话条目与持久化（#8）

**customType** `subagent:memory-session`（I7）。**一次操作只做一次 append**。

| 字段      | 类型                                                           | 硬上限                                                                    |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `v`       | `1`                                                            | —                                                                         |
| `sid`     | 写入时的会话 id                                                | `[A-Za-z0-9_-]{1,64}`                                                     |
| `op`      | `"put" \| "del" \| "snap"`                                     | —                                                                         |
| `item`    | `SessionItem`（put）                                           | 见 §6.6                                                                   |
| `id`      | del 的目标                                                     | `n\d{1,6}`                                                                |
| `items`   | `SessionItem[]`（snap，全量）                                  | ≤ `FOLD_HARD_ITEMS`                                                       |
| `nextN`   | int（snap）                                                    | 1..999999                                                                 |
| `cause`   | `{op:"put"\|"del"; id}`（snap 由本次操作触发时）               | —                                                                         |
| `inherit` | `{kind:"spawn"; fromSid; fromLeaf?; frozenAt}`（仅 seed snap） | sid 规则同上；leaf 正则须经 P0 真 SDK entry-id 样本验证；时间 24 字符 ISO |

`SessionItem = {id; text; authority; grant?: {via:"dialog"|"command"; turn: hex8; cap: hex8}; created; updated; from?; originSid?}`；`rev = sha1(canonicalJson(item))[:8]`，在折叠时计算。

**写入协议**：

| 步  | 动作                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 冻结请求，按需走 §5.3 拿 cap，进入会话内串行队列                                                                                                                                       |
| 2   | 出队：从真实 `getBranch()` 重新折叠得到当前状态（缓存键为 leafId + 条目数），校验 rev、上限、authority                                                                                 |
| 3   | `planSessionOp` 生成**一个** entry：`opsSinceSnap+1 < 32` 时为 put/del；否则为包含本次效果的完整 snap，带 `cause`                                                                      |
| 4   | **最后一个 await 之后**同步复核：owner（`getSessionId()===ownerSid`、`getSessionFile()===ownerFile`、epoch 未变）、signal 未 abort、cap（若有）、`sessionWriteGate.check(...)`（§8.2） |
| 5   | 先按 §6.6 验证最终 entry 的实际 JSON UTF-8，再 `pi.appendEntry(type, entry)`。抛错 ⇒ `E_PERSIST`（SDK 已回滚这一条）；状态以折叠结果为准                                               |
| 6   | 重新折叠 `getBranch()`，核对本次效果确实可见；不可见 ⇒ `E_PERSIST_UNKNOWN`（不自动重试）                                                                                               |
| 7   | 回显，附持久化状态                                                                                                                                                                     |

**持久化状态与失败矩阵**：

| 情形                                                       | 回显 / 结果                                                                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSessionFile()` 为 undefined（`--no-session`/inMemory） | `memory-only`：进程结束即失                                                                                                                                                      |
| 有会话文件                                                 | `appended`：已进入会话管理器；无 conversation 时只缓冲，首个 user **或** assistant 形成 conversation 即开始落盘（SDK `session-manager.js:786-815`）。append 成功**不等于 fsync** |
| append 抛错                                                | `E_PERSIST`，状态不变（SDK 回滚这一条）；可以重试（create 会分配新 id，update 需要新的 rev）                                                                                     |
| 第 32 次操作的 snap append 抛错                            | 整次操作失败，`E_PERSIST`；**不存在**「put 成功、snap 失败」的半态，因为只有一次 append                                                                                          |
| append 成功，但之后首次落盘失败或进程崩溃                  | 由 pi 的持久化语义决定；重载后以文件为准。残缺的末行由 pi 加载器丢弃（conformance 用例确认），sanitize 再兜底；本层不承诺崩溃原子性                                              |
| 重载后折叠结果比内存旧                                     | 以折叠为准；丢失的最后一次操作需要用户重做（R3）                                                                                                                                 |
| seed（子会话）append 抛错                                  | 拒绝创建子会话（§6.3）                                                                                                                                                           |

**折叠** `foldSessionMemory(branch, currentSid)`：

1. 倒序找最近一条**整体合法**的 snap（`validateSnap`：每一项都合法、项数与字节都在硬上限内、id 不重复）；不合法的 snap 整条忽略，继续向前找；
2. 从该 snap 往后顺序应用合法的 put/del；不合法的条目丢弃，记入 `dropped[]`（`{entryId, reason}`，最多 16 条）；
3. 标注继承：最后写入方的 sid ≠ currentSid ⇒ 标为 fork 继承；seed snap 内的条目 ⇒ 标为 spawn 继承；
4. `currentSid` 为 undefined ⇒ 全部视为继承，且禁止写入；
5. **丢弃要可见**：`dropped.length > 0` 时，section 标题追加 `· dropped <k>`；主会话每个 session_start 通知一次；doctor H05 列出 entryId 与原因（不含正文）。

### 6.3 子 agent seed（#6）

**DTO 与端口**（`scopes/types.ts`，与 Fast 完全独立）：

| 名称                  | 定义                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionMemorySeedV1` | `{v:1; fromSid; fromLeaf?; frozenAt; items: readonly SessionItem[]; nextN}`，深拷贝后对每个 item 与数组都 `Object.freeze`；经 `validateSeed` 校验（含实际 JSON 字节），driver 构造最终 snap 后再次校验 §6.6 上限 |
| `MemorySeedCapture`   | `{v:1; state:"empty"} \| {v:1; state:"captured"; seed: SessionMemorySeedV1}`（冻结）                                                                                                                             |
| `MemoryParentPort`    | `snapshot(parentRunId?: RunId): MemorySeedCapture`。主会话从闭包持有的当前 ctx 折叠；子 run 经 registry 会话句柄的 `getBranch()` 折叠；开关关闭 ⇒ 端口不注入                                                     |
| `MemoryWorkflowPort`  | `capture(): MemorySeedCapture`（宿主侧，不会转发给 worker）                                                                                                                                                      |

**字段落位**（只追加可选字段 `memorySeed?: MemorySeedCapture`）：

| 位置                                            | 规则                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpawnRequest`（`core/types.ts:216` 旁）        | 调用方不可信：spawn 入口先剥除外部传入的值，只有宿主路径可以设置                                                                                                                                                                                                  |
| `spawn-service.ts`（与 `:995-1000` 同位置）     | `memorySeed !== undefined` ⇒ 保留（**包括 `empty`**，阻止出队重读）；否则 `deps.memoryParent?.snapshot(req.parentRunId)`；外部 agent 剥除（同 `:1012-1014`）；捕获抛错 ⇒ spawn 错误 `kind:"config"`，`message:"memory seed capture failed"`，retryable:false      |
| `request-threading.ts` 的 `NOT_THREADED`        | 加 `memorySeed`，说明为「只经 SessionSpec 显式转移」                                                                                                                                                                                                              |
| `runtime-adapter.ts`（`:654` 旁）               | `!isExternal && memorySeed?.state==="captured"` ⇒ `SessionSpec.memorySeed = seed`                                                                                                                                                                                 |
| `SessionSpec`（`core/types.ts:1403` 旁）        | 只接受 `SessionMemorySeedV1`                                                                                                                                                                                                                                      |
| `session-driver.ts` `toCreateOptions`（`:736`） | 从 create options 中剥除 `memorySeed`（同 fastSeed）                                                                                                                                                                                                              |
| `session-driver.ts` create（`:799-816` 之间）   | `markChildSession` 之后、`createWithHuman` 之前：`sessionWriteGate.check` ⇒ `sm.appendCustomEntry(type, {v:1, sid: sm.getSessionId(), op:"snap", items, nextN, inherit:{…}})`；门拒绝或 append 抛错 ⇒ **reject**（`"memory seed append failed"`），子会话不会创建 |
| `session-driver.ts` resume                      | 不种子                                                                                                                                                                                                                                                            |
| `workflow/host.ts`（`:923-928` 同位置）         | 每次 `agent()` 在结构校验后、hash/replay/队列前调用 `(deps.memoryWorkflow ?? deps.spawner.memoryWorkflow)?.capture()`；结果放进 `QueuedAgentCall.memorySeed`（`:1183-1186`）与 `ChildSpawner.spawn` 请求（`:1329-1331`、`:406` 类型）                             |
| `workflow/spawner-adapter.ts`（`:48,78,141`）   | 透传 `memorySeed`，并接收 `memoryWorkflow` 选项                                                                                                                                                                                                                   |
| journal / replay                                | `memorySeed` **不进入** call hash、chain digest 或 journal 条目（含记忆正文；replay 命中时不 spawn，不需要 seed）                                                                                                                                                 |

### 6.4 hub 存储 API（`scopes/hub-store.ts`）

| 函数                                                          | 语义                                                              | 错误                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `resolveHubSlot({effectiveStateDir, uid})`                    | §3.4                                                              | —                                                                        |
| `checkHubSlot(slot): "absent" \| "ok" \| {inert: reason}`     | 只读                                                              | —                                                                        |
| `readHubCorpus(slot, state?)`                                 | 包装 `readCorpus(root/blocks)`；过滤非 active 与过期条目          | 不抛                                                                     |
| `commitHubOpLocked(slot, cap: Readonly<HubOpCap>, now, gate)` | 只接受 cap；锁内复核；按 op 分派 create/replace/trash；返回审计行 | `E_CONFLICT`、`E_FULL`、`E_NAMESPACE`、`E_HUB_CAP_STALE`、`E_WRITE_GATE` |
| `commitHubUserCommandLocked(slot, req, now, gate)`            | `/mem hub` 专用（`grant.via:"command", by:"user"`）               | 同上                                                                     |

锁超时 2000ms ⇒ `E_BUSY`。**对话框绝不在锁内弹出**。

### 6.5 工具 `scoped_memory`（开关开启时注册）

| 参数                                 | 说明                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `storageScope`                       | 必填。enum 在 activate 时生成：主会话为开启的层；子会话恒为 `["session"]` |
| `command`                            | `view \| create \| update \| delete`                                      |
| `id`、`text`、`rev`、`topic`、`from` | 同 r1；update/delete 必须带 rev                                           |
| `authority`                          | 仅 session 有效，按 §5.3 判定                                             |

- 错误码：`E_SCOPE_DISABLED`、`E_CHILD_READONLY`、`E_CHILD_AUTHORITY`、`E_AUTHORITY`、`E_HUB_NEEDS_HUMAN_TURN`、`E_HUB_CONFIRM_UNAVAILABLE`、`E_HUB_DECLINED`、`E_HUB_DECLINED_TURN`、`E_HUB_RATE`、`E_HUB_CAP_STALE`、`E_USER_AUTH_DECLINED`、`E_REV_REQUIRED`、`E_CONFLICT`、`E_FULL`、`E_TOO_LARGE`、`E_META_INVALID`、`E_NOT_FOUND`、`E_STALE_SESSION`、`E_PERSIST`、`E_PERSIST_UNKNOWN`、`E_BUSY`、`E_NAMESPACE`、`E_WRITE_GATE`、`E_FROM_INVALID`。
- 描述须写明：「hub is shared by ALL projects of this Hub; a write needs the user to approve it in a dialog (terminal or web). `scope=global` inside `memory` text is NOT cross-project.」
- `project` 不进 enum（不出现双路径）。为什么独立成工具见 §7 K4。

### 6.6 容量（#10）

**元数据硬上限**（固定，与产品选择无关；校验失败 ⇒ `E_META_INVALID`，不截断）：

| 字段                                | 上限                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`（session）                     | `n\d{1,6}`                                                                                  |
| `id`（hub）                         | `[a-z0-9-]{1,48}\.\d{3}`                                                                    |
| `topic`                             | `[a-z0-9-]{1,48}`                                                                           |
| `sid` / `fromSid` / `originSid`     | `[A-Za-z0-9_-]{1,64}`                                                                       |
| `fromLeaf`                          | ≤64 B；候选 `[A-Za-z0-9_-]{1,64}` 必须由 P0 真 SDK entry-id 样本验证，不直接以 sid 规则盖章 |
| 时间（created/updated/frozenAt/at） | 恰好 24 字符 ISO-8601 UTC                                                                   |
| `from`                              | ≤120 B，`^(session:n\d{1,6}\|project:[A-Za-z0-9._/-]{1,100})$`                              |
| `grant`                             | via 为枚举；turn/cap 各 8 位 hex                                                            |
| `src.label`                         | ≤40 B，剥除控制字符                                                                         |
| 单个 item 的元数据序列化            | `META_MAX = 512 B`                                                                          |

**产品上限**（Q1 已定：用户选择翻倍，2026-11-07）：`T_MAX`（单条正文）、`N_MAX`（活跃条数）、`B_MAX`（活跃正文总和）。

| 层      | T_MAX  | N_MAX | B_MAX  |
| ------- | ------ | ----- | ------ |
| session | 1024 B | 48    | 8192 B |
| hub     | 1024 B | 32    | 4096 B |

**三种预算不可混用**（均以 byte 计，1 KiB=1024 B）：

- `rawBodyBytes = Buffer.byteLength(text, "utf8")`；T_MAX/B_MAX 仅约束原文，不是 JSON 串。512 个 NUL 原文为 512 B，而 JSON 字符串内部 `\u0000` 共 3072 B，另有引号。
- `renderBytes = Buffer.byteLength(renderedSection, "utf8")`；正文如做控制字符转义，必须按最终渲染计量，不用 rawBodyBytes 代替。
- `serializedDtoBytes = Buffer.byteLength(JSON.stringify(dto), "utf8")`；**最终 DTO 的实测值才是拒收/拒写依据**，覆盖每次 put/del append、每第 32 次完整 snap、seed capture wrapper、seed DTO、driver 构造的最终 seed snap。seed 校验一次不能代替包装后的校验。session 的 SDK envelope 不在本 DTO cap 内，不声称限制整个 transcript。

**先验形状再序列化**：输入 unknown 先检类型、允许字段、深度、数组长度、数值整数范围与有限性；字符串逐字段限 UTF-8，id/枚举/time/来源沿表验证。只接受普通/null-prototype 数据记录及普通数组的 own data descriptors，拒绝 accessor、额外字段、稀疏数组、自定义 prototype/toJSON、循环；数组成员也递归验证，不能直接 spread/JSON.stringify 不可信对象以免触发 getter。仅从校验后的原始值重建固定 schema 的无 getter/toJSON 纯 DTO，再 stringify。Proxy 不提供「无副作用反射」保证，不接受任意插件对象为受信入口；反序列化数据以 JSON.parse 来源为边界，其他未知对象 fail closed。shape 检查必须先限项数/深度，防无限递归。冻结请求、fold、seed 都走同一 validator；诊断无正文。

元数据界限覆盖完整 DTO：item 除 text 外的 **最终序列化**部分（含键/引号/分隔符）≤ `META_MAX=512 B`；`grant` 的 via/channel/by 枚举、turn/cap/who 为定长 hex，`src` 的 project/sid8 为定长 hash/ID、label≤40 B；`from`/originSid/created/updated 按上表；未知字段拒绝。entry/cause/inherit、seed/capture wrapper 的固定键、版本、state/op/kind 枚举、sid/fromLeaf、nextN、24 字符时间在 shape 验证后，各包装开销≤ `ENVELOPE_MAX=2048 B`（包括数组分隔符与嵌套包装）。Plan 用全部可选字段同时存在的构造断言验证，不以「平均值」估算。

**硬 cap 公式**：任意合格正文 JSON 转义负载保守上界 `6 × rawBodyBytes`（控制字符最坏转义；不接受非标字符串对象），引号/键算元数据。公式只是安全上界，实际 stringify 后还必须比对 cap。

| 对象                      | cap（B）                                                               | Q1 已定值                     |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| put / del DTO             | `6*T_MAX + META_MAX + ENVELOPE_MAX`                                    | 8704                          |
| snap / seed / capture DTO | `6*min(B_MAX,N_MAX*T_MAX) + N_MAX*META_MAX + ENVELOPE_MAX`             | session 75776；hub 对应 43008 |
| 最终 render               | `2048 + 6*B_MAX + N_MAX*256`；逐项展示元数据≤256 B，最终 UTF-8 实测    | session 63488；hub 34816      |
| 历史 fold 硬上限          | `FOLD_HARD_ITEMS=64`，每条 raw `FOLD_HARD_TEXT=1024 B`，总 raw≤65536 B | 固定技术界限                  |
| 历史 snap/seed DTO 硬上限 | `6*65536 + 64*512 + 2048`                                              | 428032                        |
| 历史 render 硬上限        | `2048 + 6*65536 + 64*256`                                              | 411648                        |

- 超过产品 T/N/B 或最终 DTO cap ⇒ 拒写，旧状态不变，正文不截断；同样适用于替代 put 的第 32 次 snap。原文容量 Q1 已由用户选择翻倍，JSON 系数与技术硬 cap 按公式重算，不另问用户。
- 历史状态超过产品上限但在 fold 硬上限内仍可折叠/完整展示，阻止新增；其修复性更新/删除使用历史硬 cap 且不得增加已有超限维度。不能为了换一档产品容量丢失历史正文。大 render 经现有 section 的尾部 pointer 策略；完整 view 不截断正文，不能把 raw 预算当作 render 承诺。
- snap 任一 item/包装/总字节不合法 ⇒ 整条拒收并按 §6.2 visible warnings；不得部分恢复后宣称原 snap 合法。
- 边界门：NUL/其他 controls、反斜杠、双引号、CJK、emoji 与混合文本，分别测试 raw 与 serialized cap 的恰好等于/超 1 B；全部可选字段、满项数组、put/del/第32次snap/capture/driver seed snap；getter/toJSON 不被执行的行为断言。不能只断言「未抛错」。

### 6.7 注入、优先级与去重（#5）

| 项       | session                                                                                                                  | hub                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| section  | `pi_session_memory`（sessionScoped），在 `pi_project_memory` 之后                                                        | `pi_hub_memory`，在 session 之后 |
| 主/子    | 主 + 子                                                                                                                  | 主 + 子（只读）                  |
| locked   | provider 先检查实时 locked 状态 ⇒ 返回 `""`，不调用 `getBranch`                                                          | 同左，不碰盘                     |
| 空       | `""` 不进 fold                                                                                                           | 同左                             |
| 刷新时点 | 每次 agent start（stable 模式：冻结快照 + ≤3 块 / 32KB 尾部更新，之后变 pointer，`pointerHint` 写 `scoped_memory view`） | 同左                             |

**优先级**（两层都非空时渲染一行说明）：

1. **先比真实 authority**：user > agent（authority 来自 §5.2/§5.3 的宿主判定，不来自字面声明）；
2. **authority 相同再比具体性**：session > project > hub；
3. 因此 session 里的 agent 条目永远压不过 hub 的 user 条目；session 的 user 条目（对话框或命令）可以压过 hub 的 user 条目。

**去重**：正文规范化（NFKC、压缩空白、去掉行内 meta）后 sha1 相同 ⇒ 保留 **authority 最高**的那份；authority 相同时保留最具体层的那份；其余层显示 `(dup of hub general.002)`。**不允许**用低权威的具体副本遮蔽高权威副本。不做语义去重，不调用模型。

### 6.8 `/mem` 子命令（P3）

| 子命令                                 | 权限                                               | 说明                                                                                                      |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hub list\|show <id>\|path`            | 主会话（web 允许）                                 | 只读                                                                                                      |
| `hub add <text>`                       | `isInteractive(ctx)` ∧ `ctx.mode==="tui"` 的主会话 | user 亲手输入 ⇒ `grant:{via:"command", by:"user"}`                                                        |
| `hub rm <id>`、`hub restore <trashId>` | 同上                                               | 内部先读 rev 再 CAS                                                                                       |
| `hub adopt`                            | 同上                                               | 槽位不符时，核对后重新盖章（对话框，拒绝项在前）                                                          |
| `session add <text>`                   | 同上                                               | 本会话 user 条目                                                                                          |
| 所有写子命令（子会话或非 TUI）         | —                                                  | 拒绝（Web 用户走「agent 请求 + Web 授权」；首期不放开 web 来源的 `/mem hub add`，以免多出一条命令授权面） |

`/mem` 的描述字符串不改（jev-off golden）。

---

## 7. 关键决策

| #   | 决策                                                                                                                                                    | 被否决的备选                                                                                                                             | 理由                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | session 权威 = CustomEntry + 折叠                                                                                                                       | sidecar 文件；CustomMessageEntry；靠 summary                                                                                             | 不新增明文存储；不进 context；有确定性；五处先例                                                                                                                                                                                                                       |
| K2  | hub 根 = Hub 槽位 stateDir 派生，agent 侧直写，锁 + CAS                                                                                                 | ①hub daemon 权威存储；②agentDir 根；③memoryRoot 根（r1）；④`~/.pi/agent/AGENTS.md`                                                       | ①webHub 默认关闭、I8 进程边界、需要新帧与断连 cache；②③都能被逐会话的环境变量拆散（#1）；④用户手写文件。槽位派生与 hub 单例判定口径一致，且 daemon 不在线也能用                                                                                                        |
| K3  | hub 复用 block 原语，不接治理/Jev                                                                                                                       | 新写一套格式                                                                                                                             | CAS/原子写/.trash 已经成熟；不碰 #36 的门禁                                                                                                                                                                                                                            |
| K4  | 独立工具 `scoped_memory`                                                                                                                                | 扩展 `memory` 工具                                                                                                                       | 三套冻结的 schema；v2 没有 rev；会耦合 Jev guard                                                                                                                                                                                                                       |
| K5  | hub 授权 = 人类在 TUI 或 Web 对话框中的动作 + 操作级 cap；Web 复用 `AskUserRemotePort`；前置条件只接受可证明来源（TUI interactive / 结构化 web prompt） | ①关键词；②`classifyHumanInput` + confirm（r1）；③独立的预授权命令 `/mem hub allow` 再由 agent 消费；④为 Web 新做一套授权帧/端点 + 新 cap | ①否定句、引用会误判；②rpc/同文本 ledger 不可证明，confirm 默认是；③多一步交互，最终仍要逐条核对原文；④现有远程问答通道已经具备 dialogId/epoch 寻址、选项校验、竞速与关闭语义，答案侧补结构化来源；回合侧另外需要可信派发一次性本地 proof（§5.1），不能仅加 ledger 字段 |
| K6  | hub 条目 authority 恒为 user（由 grant 推导）                                                                                                           | agent 级 hub 条目                                                                                                                        | U3/U4                                                                                                                                                                                                                                                                  |
| K7  | seed 独立 DTO，复用管线位置，逐次 `agent()` 捕获，empty 显式落位                                                                                        | 复用 FastSeed；workflow 只捕获一份                                                                                                       | 评审 #6；fast 先例本身就是逐次捕获                                                                                                                                                                                                                                     |
| K8  | 一次操作一次 append                                                                                                                                     | put + snap 两次追加                                                                                                                      | SDK 只回滚单次 append，两次追加会出现半态（#8）                                                                                                                                                                                                                        |
| K9  | 写入时拒绝，不截断                                                                                                                                      | 注入时截断                                                                                                                               | 确定性                                                                                                                                                                                                                                                                 |
| K10 | `/tree` 为 branch-local                                                                                                                                 | 会话全局最新态                                                                                                                           | 与 todo/goal 一致；避免复活废弃分支                                                                                                                                                                                                                                    |
| K11 | 子会话硬门用有效设置 + 命令入口 + writeGate，Jev 侧车例外                                                                                               | 只改 `allowWriteInChildSessions` 的默认值                                                                                                | 旧设置为 `true` 时仍要被挡住（#7）                                                                                                                                                                                                                                     |
| K12 | 用户拒绝 user 授权 ⇒ 请求失败                                                                                                                           | 悄悄降成 agent                                                                                                                           | 避免模型误以为已记成用户令                                                                                                                                                                                                                                             |

---

## 8. 兼容、安全与不变式

### 8.1 off / 兼容

| 场景                                                                    | 保证                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两个开关都关（~~默认~~显式 off；默认已于 2026-11-08 用户裁定翻转为 on） | 不注册工具/section/hook；不追加条目；不注入端口 ⇒ `memorySeed` 永远不存在；不解析槽位；子会话行为不变；activate-trace default、memory-tool-surface、jev-off、secure-off、schedule-off 等 golden 全部不变 |
| 新 golden（B 级，申报式）                                               | `scoped-memory-tool-surface.json`（enum 变体 × 描述）；activate-trace 新增「scopes on」配置                                                                                                              |
| 旧扩展                                                                  | 忽略未知 customType；不读 hub-memory                                                                                                                                                                     |
| 回滚                                                                    | 显式 `scopes:{session:false,hub:false}` + `/reload`（2026-11-08 默认开启后回滚即此路径）；数据保留、不擦除历史；手动删除 `hub-memory/` 才彻底清除                                                        |

### 8.2 安全边界（#9）

- **`secureSessionWriteGate(domain, deps?)`**（新导出，`src/secure/memory-gate.ts`）：`check({sessionFile?, sessionDir?})`。plain ⇒ ok；locked ⇒ 拒绝；secure ⇒ 实时 `vaultMountState(...)==="mounted"`，并且 `realpath(dirname(sessionFile) ‖ sessionDir)` 满足 `inVaultWriteZone`。sessionFile 为 undefined（inMemory）时只检查挂载。
- **调用点**：会话写入的最后一个 await 之后（§6.2 第 4 步）；driver 追加 seed 之前；hub 写在 secure 下本来就不会接线。
- **locked**：provider 不读 branch、不碰盘；工具与输入本来就被 guard 拦截。
- **D8**：`memory.scopes.hub` 进入 `applySecureDomainOverrides`；接线时双重校验。
- **不落正文**：错误信息、诊断、审计、doctor、日志只含 id/rev/哈希，不含正文；不新增临时文件；hub 的 `E_CONFLICT` 正文只出现在工具结果里（会话 transcript）。
- **泄漏面**：注入给模型的 hub 条目不含其他项目的名称、路径或 sid。授权对话框的 title 会被 web 横幅镜像（`event-tap.ts:344-360`）——同样的原文已经出现在工具调用参数的 transcript 里，不是新的泄漏面；在 §9.3 记作 R11。
- **删除语义**：session `del` 不擦除历史（与 transcript 一样）；hub 删除进 `.trash`。

### 8.3 不变式

| 不变式 | 落实                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| I1     | 锁 ≤2000ms；对话框 120s + signal；所有计算期限经 `clampSpanMs`                                               |
| I2     | index/stack 只透传                                                                                           |
| I3     | pre-guard；hub 写入与 tracker 只在主会话                                                                     |
| I4     | cap、tracker、队列、owner、缓存全部在闭包中；不新增 `Symbol.for`（cap 不需要跨 reload，reload 本来就要撤销） |
| I5     | 不新增定时器                                                                                                 |
| I8     | `scopes/*` 中除 `wire.ts` 外都加入 pi-free 白名单                                                            |
| I9/I10 | §8.1；无 wire；条目和 BlockMeta 都只追加字段                                                                 |
| I11    | §8.2                                                                                                         |
| I12    | 机制写在工具描述；策略写进 skill                                                                             |

---

## 9. 实施要点

### 9.0 Plan P0（实现前置，不是已通过证据）

Plan/方案制定按本会话用户指定 `localcodex/gpt-6-astra`。先完成以下公开路径 conformance / 本地接缝验证，不能用文档闭合替代实测：

1. 同源 effective stateDir 透传：launchHome、paths、memoryRoot、agentDir 交叉矩阵（§3.4），包括 enabled/off 与 sandbox；核清 stop/restart/rotate 清理不会删 hub-memory。
2. 真实 pi 1.5.0 公开扩展 API 的 sendUserMessage→input 链：正常/异步早期 hook/并发相同文本/嵌套/handled/throw/reload/session switch；证明 dispatch scope token 仅被本次 input 消费一次；**旧 observed web + 后 xs/wake 同文本必须无法获得 humanTurnId**。测试使用本地 fake provider，不调用真实模型或付费服务。
3. 按 §5.1 单源 idle 准入，测试正常 idle Web 正向、native steer/followUp 确定性 E_HUB_NEEDS_HUMAN_TURN、agent_settled 延后/续跑竞争；普通 Web 投递不变且零自动重送。首期不采用新增 held/idle 重派接缝。公开 API 无法闭合须报 Root，不宣称 SDK 有额外字段，不擅改 SDK/wire。
4. Web 答案的 originKind/nonce/完整操作 digest/owner 复核；dialogId 唯一性；取消/超时/old hub/no channel/飞书拒绝；TUI 全文展示探针。操作 digest 应覆盖冻结 op/target/topic/text/from/expectRev，不只正文 hash；保留 cap 的 textDigest 再单独核对正文。
5. 从真实 createAgentSession 的 branch entry.id/getLeafId() 取得普通消息/custom/compaction/fork 样本，验证 fromLeaf 候选正则/长度；不能将 sid 字符集直接当 entry-id 契约。不符先报 Root 再冻结 type，不任意放宽为路径字符串。§6.6 全部预算与不可信形状断言；完整 DTO stringify 实测覆盖普通 append、snap、两层 seed 包装及最终 driver snap；禁止将 raw UTF-8 长度当 JSON 大小。

这些是技术门，不是新的用户决策；§10 的 Q1–Q3 已全部拍板。此轮仅做源码静态核验，**未跑上述真实 SDK 行为探针**。

### 9.1 分包

| 包  | 内容                                                                                                                                                                              | 依赖    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| S0  | 设置、D8、`types/limits`、`secureSessionWriteGate`                                                                                                                                | —       |
| S1  | session：fold/ops/op-cap/render/wire、section、工具（session）、`/mem session add`、子会话硬门、`authorize.ts`（TUI ⟂ Web）、`RemoteOutcome.originKind`、本地 dispatch proof-port | S0      |
| S2  | seed：core/service/workflow/driver                                                                                                                                                | S1 端口 |
| S3  | hub：slot/store/format 追加、section、工具（hub）、OpCap 提交路径（复用 S1 的 `authorize.ts` 与 Web `originKind`/dispatch proof 补强）                                            | S1      |
| S4  | `/mem hub`、doctor、skill、README、AGENTS.md I11                                                                                                                                  | S3      |

**实施 owner 对齐（Sonnet 条件 4）**：本节 S 为架构逻辑分组，实际写租约以 Plan P0–P5 为准。P0 单 owner 冻结 `scopes/types.ts` 的 OpCap/ApprovalPort 契约；**Plan P1 唯一拥有 `src/memory/scopes/authorize.ts` 与通用 `op-cap.ts` 实现/单测**（对应此处 S1 前移）。Plan P3 仅消费/注入 port，负责 hub 提交复核及 Web 来源桥，不重写 authorize/op-cap；P4 单 owner 装配。不得从逻辑 S 分组推导第二个文件 writer。

热点的实际写租约：`memory/index.ts`、`scopes/wire.ts` 与 index/stack 由 Plan P4 集中装配；`authorize.ts`/`op-cap.ts` 由 P1 前移实现，P3 只消费；`RemoteOutcome.originKind` 类型由 P0 冻结，Web 来源桥/proof 接线由 P3 实现。改 `src/web-hub/agent/**` 与 `src/ask-user/**` 前须读对应 README。`blocks/format.ts` 与 #36 冲突时串行/冻结；`memory/command.ts` 由 P4 唯一收口。Plan P2 与 P3 无写域交叉才可并行。

### 9.2 门禁草案

| 类别              | 用例                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 槽位              | §3.4 矩阵逐行；不同 `ARMORY_MEMORY_ROOT` 落到同一根；host/dev/ino 不符 ⇒ 惰化                                                                                                                                                                                                                                                                                                                         |
| Web 授权          | web 胜且选 AFFIRM 且 originKind=loopback/lan ⇒ 写入；飞书 origin、字符串 origin、web cancel、超时、断连、端口不存在 ⇒ 拒绝；TUI 先答后 web 迟到 ⇒ `E_DIALOG_CLOSED`；回调时会话已换/tree/新输入 ⇒ 不认领；飞书来源的 prompt 回合 ⇒ 不发起；旧 observed web + 后 xs/wake 同文本 ⇒ 不发起；重放 proof/错误 owner/sid/generation/已消费 token ⇒ 不发起；排队未证明关联 ⇒ 拒绝；rpc 模式不调用本地 select |
| 授权              | 非 TUI 且无 Web、rpc/xs/wake 来源、无人类回合 ⇒ 不弹框；select 返回 undefined/REJECT/其他字符串/超时/abort ⇒ 不写；参数里的授权声明无效；被拒后同回合再请求 ⇒ `E_HUB_DECLINED_TURN`；第 4 次 ⇒ `E_HUB_RATE`                                                                                                                                                                                           |
| cap TOCTOU        | 弹框期间新输入/tree/fork/reload/abort ⇒ 出队时 `E_HUB_CAP_STALE`；rev 变化 ⇒ `E_CONFLICT`；正文摘要不符 ⇒ 拒绝；审计字段只来自 cap                                                                                                                                                                                                                                                                    |
| session authority | 拒绝 ⇒ `E_USER_AUTH_DECLINED`（不降级）；子会话 authority 参数 ⇒ 拒绝；agent 改 user 条目没有 cap ⇒ `E_AUTHORITY`；去重保留高权威副本                                                                                                                                                                                                                                                                 |
| 持久化            | 每次操作恰好一次 append（计数断言）；append 抛错状态不变；第 32 次 snap 抛错不留半态；重新折叠核对；`memory-only` 回显                                                                                                                                                                                                                                                                                |
| 折叠性质          | 随机序列等价于参考模型；插入 compaction 不变；fork 前缀换 sid 后继承正确；坏 snap 整条拒收；丢弃可见                                                                                                                                                                                                                                                                                                  |
| seed              | 受理后父再写子看不到；captured-empty 不被出队重读（父后来再写也不影响）；workflow 两次 `agent()` 之间父写入 ⇒ 第二个子拿到新快照；seed 不进 journal/hash；外部 agent 剥除；seed append 失败 ⇒ spawn 失败、不创建子会话                                                                                                                                                                                |
| 子会话硬门        | `allowWriteInChildSessions:true` + scopes on ⇒ 三套工具都拒绝；`/mem` 写子命令拒绝；writeGate 拒绝；scopes off ⇒ 原行为                                                                                                                                                                                                                                                                               |
| secure            | 写入前卸载 ⇒ 拒绝且零 append；locked provider 不调用 getBranch；hub 设为 true 仍然关闭                                                                                                                                                                                                                                                                                                                |
| I9                | 默认配置下各 golden 逐字节不变                                                                                                                                                                                                                                                                                                                                                                        |
| conformance       | fork 保留 custom data；`getBranch` 含 compaction 前条目；单次 append 抛错回滚；残缺末行被加载器丢弃；`ui.select` 支持 timeout/signal、多行 title 完整渲染                                                                                                                                                                                                                                             |

### 9.3 风险与残留

| #   | 风险                                                                   | 缓解 / 残留                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R1  | 用户机械地选「授权」                                                   | 拒绝项在前且默认；原文全文；同回合被拒后不再弹；每回合最多 3 次；`/mem hub rm/restore`                                        |
| R2  | print/json、无 Web 连接的 rpc、飞书/xs 发起的会话不能由 agent 代写 hub | 设计如此（D3/D4）；用户可以从 TUI 或 Web 发起                                                                                 |
| R2b | LAN 浏览器账户被盗用即可授权                                           | 依赖 hub 的 LAN 认证与 2FA；审计记录 `who`；`/mem hub rm/restore`                                                             |
| R3  | append 成功但未落盘就崩溃                                              | pi 的持久化语义；重载以文件为准                                                                                               |
| R4  | 会话文件膨胀                                                           | 按 §6.6 实测 DTO cap（已定容量普通 put/del≤8704 B，snap≤75776 B）；每 32 次用 snap 替代                                       |
| R5  | run 中途 compaction 到下次 agent start 之间，section 是旧快照          | `view` 为准；switch_context 的续跑会立即刷新                                                                                  |
| R6  | `format.ts` 与 #36 的并行冲突                                          | 串行 / 冻结面                                                                                                                 |
| R7  | session `del` 不擦除历史                                               | 文档写明                                                                                                                      |
| R8  | 两个记忆工具让模型混淆                                                 | 描述互指 + skill                                                                                                              |
| R9  | seed 让子 agent 的 prompt 变大                                         | 上限约束；父为空则无开销                                                                                                      |
| R10 | pi 升级后语义漂移                                                      | conformance + pi bump 清单                                                                                                    |
| R11 | 授权题干（含原文）进入 web dialogs 卡片                                | 与工具参数 transcript 同级，不是新的泄漏面；飞书侧若镜像 dialogs，Plan 须确认飞书不展示或不可作答（作答已被 originKind 拒绝） |
| R12 | TUI 多行 title 被截断，导致用户看不全原文                              | conformance 探针；不通过就改用 `ctx.ui.custom` 的只读视图（Plan 决定）                                                        |
| R13 | hub 管理流程误删 `hub-memory/`                                         | §3.4 的 Plan 核实项                                                                                                           |

---

## 10. 产品决策（已全部确定）

用户最终拍板（2026-11-07），不再重问：

| #   | 问题         | 已定值                                                                                                                                    |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 产品上限     | 容量翻倍：session 48 条 / 正文总 8 KiB；hub 32 条 / 正文总 4 KiB；单条正文 1024 B。满了拒写，不截断；技术 DTO/render cap 按 §6.6 公式重算 |
| Q2  | hub 注入形态 | 自动全量注入（受 Q1 限制），不是索引 + 按需读取模式                                                                                       |
| Q3  | 分期         | 本轮完成 session / project / hub 三层，不把 Hub 留待后续；首期 TUI + Web 授权                                                             |

**Q4 已定（用户 2026-11-07）**：首期同时支持 TUI 与 Web 授权；Web 复用现有远程问答通道（§0.3 D1–D4、§5.2）。

**Q5 已定（用户 2026-11-08）**：`memory.scopes`（session+hub）改为**产品默认开启**（§6.1 已就地更正）；历史裁定「默认 off」保留记录但被本裁定覆盖。secure 域不受影响：D8 仍强制 hub:false，默认翻转不等于 secure 内已启用（§8.1/§8.2）。

已定、不再列出：fork/子 snapshot 语义、U4 授权须明确且宿主可核验、TUI+Web 授权、secure 强制关闭、子会话只读的窄义（D5）。已由本文裁定：槽位根（K2）、独立工具（K4）、对话框授权（K5）、单次 append（K8）、branch-local（K10）、子会话硬门例外（K11）。

---

## 附录 A · 交接

`/tmp/handoff/task39-memory-scopes-arch-r3.json`（r2.1 交接保留在 `/tmp/handoff/task39-memory-scopes-arch-r2.json`；r1 版本保留在 `/tmp/handoff/task39-memory-scopes-arch.json`）。

### P4c source assembly fact sheet（2026-11-08）

实现以 `scopes/wire.ts`（early root shell/child receiver）和 `scopes/owner.ts`（exact manager owner）为装配边界。
`scopes/child-bind.ts` 是 pi-free local bus contract，不是 DTO/wire/security platform。原 SDK manager 对象
与 literal created/resume 在 after-create/before-prompt barrier 传递；同 parent Hub slot 冻为纯 data。
Driver 第五 gate 不变，第六才是 memory port。Fastoff memoryon 也建 loader/bus，并经可选 adapter boolean
接原 Runner 内部取消；off 无该 key。三条 Stack teardown lists 第一项同步关闭 exact group。

共享 poison I4 例外只含有界 tombstone 和无 manager backref 的 weak identity/first-attempt metadata；
legacy shape 不被替换，不可用 reload 清除，恢复需要 process restart + actual reopen。正常 buffered
SDK append 不承诺 fsync 或 crash transaction，首 SDK flush 及 writer 之外 flush 仍是明确限制。

Native session add / Hub add-rm 为 host-private direct commands；adopt/restore 才是一轮完整确认；
模型 scoped_memory 的 Hub/user exact sharedApproval 不变。普通 LLM 无 direct /mem 路由，任意 host JS
不属于本功能威胁模型。Web scoped reads allow、writes deny 且不可 override；不另造 slash human proof。

实际 prompt 接单个 P4a2 coordinator，project/session/Hub 同 input 连续同步注册；freeze 是 SOURCE+manifest，
不是 marked string。child project hardreadonly 只在 scopes-on 强制生效；Jev cooldown/diag 保原 secure gate。
此为 source 实装事实，不是 P5 native viewport/browser 验收结论；SDK #61 PAUSED，与 #39 无依赖。
