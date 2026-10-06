# web-hub：composer 旁快速切换模型（+ thinking level）— 实施方案 v2（r1 评审修订）

> 状态：方案 v2（未开工）。v1 被评审 `review:model-switch`（gpt-5.6-sol）打回：1 条阻塞 + 21 条严重/一般/Minor。
> 逐条处置见 **§R「r1 评审处置」**；正文已同步。用户最终拍板见 **§13**。
>
> 范围：web-hub 详情页 composer 上方细工具行的模型 chip / thinking chip；下发「可选模型列表」；切换复用已有 `/model`、`/thinking` 命令通道。
>
> 在途关联方案（冲突面见 §10.3）：
>
> - `docs/dev/worktree-web/plan.md`（W2 `protocol/messages.ts` StatusInfo 段；W3 `agent/index.ts` onTick/status；W4 `DetailHeader.vue` + `i18n/{en,zh}/detail.ts`）。
> - `docs/dev/web-hub-delete-session/plan.md`（P0 `protocol/{http-contract,spawn}.ts`——工作区已有未提交改动；P1 `hub/{registry,http,ports,hub}.ts`；P2 `ui/src/logic/state.js`、`ui/src/types.ts`、`components/agents/*`、`i18n/{zh,en}/detail.ts`）。
> - `docs/dev/web-hub-close-session/`（探索中，可能动 `DetailHeader.vue` 中部）。
> - title 线未提交改动：`src/index.ts`、`src/config/*`、`src/title/*`。
>
> **设计目标**：零 hub 源码、零 `state.js`/`contracts.ts`/`http-contract.ts`、零 `src/index.ts`、零 settings 文件、零 `DetailHeader.vue`/`detail.ts` i18n；不 bump proto，不新增帧类型/cap/SSE 事件。v2 相比 v1 **新增**触碰：`agent/command-policy.ts`（#14）、`ui/src/types.ts` 一行 + `composables/useControl.ts`（#6，调用方 cmdId）、新 `protocol/models.ts`（#11 共享校验）。

---

## R. r1 评审处置

严重度沿用评审原文（阻塞/严重/一般/Minor）；「处置」= 本版做法；「章节」= 正文落点。

| #   | 严重度 | 评审问题（摘要）                                                                                            | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 章节                |
| --- | ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 1   | 阻塞   | `scopedModels` 是 `ScopedModel[] {model, thinkingLevel?}` 不是模型数组；`getAvailable()` 只读异步刷新的快照 | **修**。投影显式解包 `entry.model`（复用 `readScopedModels`，`available-models.ts:35-38` 本就按 `entry.model` 取），按 `provider/id` 去重保留首个；scoped 的 `thinkingLevel` **忽略**（见 #12）。写明列表 = `ModelRuntime.snapshot.available` 的当前快照（`model-registry.js:21-22` → `model-runtime.js:327-329`；快照在 `refresh()`/`refreshProviderAvailability()` 异步替换，`:224-260,581+`），5 s 指纹门捕捉替换后重发。fixture 用真实 `ScopedModel` 形状。                                        | §1.3、§4.1、§4.2    |
| 2   | 严重   | levels 手写回退与 pi-ai 不完全一致；xhigh/max 边界、帧乱序未定义                                            | **修**。删除手写复刻。优先 `import * as piAi from "@earendil-works/pi-ai"` + `typeof piAi.getSupportedThinkingLevels === "function"` 探测（pi-ai 主入口 `dist/index.js:7` `export * from "./models.js"`，实现 `models.js:681-692`；探测写法同 `src/sysprompt/compat.ts:2,19-24`）；不可用 ⇒ **不下发 `levels`**（thinking chip 只读），不推导。conformance 探针钉住导出存在。UI 一律以 session 帧最终 `thinkingLevel`/`levels` 为准；乱序与 clamp 各加测试。                                           | §4.1、§6、§9        |
| 3   | 严重   | `Type.Unknown()` 无界透传，4 MiB 只限整帧                                                                   | **修**。改为**开放但有界** schema（对象不设 `additionalProperties:false`；已知字段 `maxItems`/`maxLength` 取投影上限 2 倍；枚举类字段用有界 `String` 而非字面量 union，免得未来新值丢帧）。超界 ⇒ 整个 session 帧被拒（`decodeWith` 语义不变）——因此 agent 投影**必须**永不超界，由属性测试钉住；另加「超大 models 被拒」与「未知字段放行」测试。                                                                                                                                                      | §3.2、§9            |
| 4   | 严重   | 指纹生命周期未覆盖重连/handover/detach                                                                      | **修**。指纹键 = `connGen + sessionId + fp(wire − sampledAt)`；`connGen` 在每次 `connectWith` 自增；attach 路径**强制**发送并写键；`session_start` 清键；handover（`/reload`）是新 activate、新闭包，天然强制。同一 Connection 内的链路重连由 `connection.ts` 槽位重放（`:373-381`），槽内容恒为最新。                                                                                                                                                                                                 | §4.2                |
| 5   | 严重   | 未保证所有 session 构造路径同步更新指纹；投影 `undefined` 时删除还是保留未定义                              | **修**。唯一函数 `emitSession(mode, override?)` 负责「读 ctx → 投影 → 更新键 → 写槽（attach 或 setSlot）」，`:390`/`:673` 两个调用点都改走它。`undefined` 语义：字段缺席 ⇔ 本次 activate 内功能关闭（`control:false` 或 `webCommands:false`），整帧替换即清除（hub `registry.ts:382` 整存、UI `applySession` 整替）；读取失败**不**返回 `undefined`，而是 `status:"error"`。                                                                                                                           | §4.2、§3.1          |
| 6   | 严重   | 按 `kind+name+时间` 匹配 pending 会误认                                                                     | **修**。`ControlHandle.runCommand` 的 opts 追加可选 `id`（`types.ts:283` 一行；`useControl.ts:156` `const id = cmdOpts?.id ?? newCmdId()`），调用方 `newCmdId()` 生成后传入——先例 `AgentDetail.vue:234,370` `trackOwnDialogCmdId` + `answerDialog(…, id)`（`types.ts:281`）。按 id 精确跟踪本地 `pendingCtl` 与 agent 账本 `ctl` 槽（`CtlItemWire.cmdId`）。                                                                                                                                           | §5.2、§10           |
| 7   | 严重   | `cmd_late` 只带 code，细分文案无法兑现                                                                      | **按裁定**：UI 只按 code 映射通用文案（`E_SUBAGENT_REJECTED`=凭据缺失/被拒、`E_BAD_REQUEST`=未知模型、超时=未确认）；bridge reject 带 message 降为可选增强（queryOnly 能拿到时透传显示），不作正确性前提。                                                                                                                                                                                                                                                                                             | §4.3、§5.2          |
| 8   | 严重   | busy 时「当前请求旧、下一请求新」未覆盖工具循环/steer/重试                                                  | **按裁定**收窄文案：只承诺「当前正在输出的请求不受影响，之后的请求使用新模型」。新增 `tests/conformance/model-switch.test.ts`（复用 `pi-boundary.test.ts:57` 的 `fakeModelRuntime` 脚本化 turn 套路）：turn1 工具调用期间 `setModel(B)` ⇒ 第 2 次请求用 B；harness 扩展成本超半天则降为手工验收 A4。                                                                                                                                                                                                   | §1.4、§5.3、§9、§12 |
| 9   | 严重   | 快照语义；「无模型」与「读取失败」混淆                                                                      | **修**。wire 增 `status`（`ok` / `empty` / `error`）与 `sampledAt`；`registry.getError()` 非空或读取抛错 ⇒ `error`（仍列出能读到的条目），列表为空 ⇒ `empty`；control/命令关闭 ⇒ 字段缺席（三态 + 缺席）。不做客户端 stale 计时器（见 §3.1 说明）。                                                                                                                                                                                                                                                    | §3.1、§4.1、§5.3    |
| 10  | 一般   | 预算混用字符/码点/字节                                                                                      | **修**。统一 UTF-8 字节：字段截断按字节（码点边界安全），整体预算用 `Buffer.byteLength(JSON.stringify(wire))`，**每一段削减后重测**；测试覆盖非 ASCII（CJK/emoji）与需转义字符（`"`、`\`、`\n`）。                                                                                                                                                                                                                                                                                                     | §3.3、§9            |
| 11  | 一般   | provider/id 无长度与控制字符约束；`modelRef` 拼接无界                                                       | **修**。新 `protocol/models.ts`（纯函数，agent 与 UI 共用）：`isValidProvider`（非空、≤128 B、无 `/`、无空白/控制/格式字符）、`isValidModelId`（非空、≤128 B、无空白/控制字符，可含 `/`）、`sanitizeModelName`、`modelCommandArg(p, id)`（两者都过校验才返回 `${p}/${id}`，否则 `undefined`）。不合格条目丢弃并计入 `invalid`。bridge 以第一个 `/` 切分（`builtin-bridge.ts:249-253`）与「provider 无 `/`」规则一致。                                                                                  | §3.1、§4.1、§5.2    |
| 12  | 一般   | 丢弃 scope 显式 thinkingLevel；alias/dated/重复排序未验证                                                   | **写明忽略**：列表只用 `entry.model`；chip 选中走 `/model p/id` ⇒ `setModel` 不带显式档位，pi 用 per-model/全局默认（`agent-session.js:2066-2077`），与 TUI `/model <ref>` 一致；scope 的 `:high` 只在 pi 自己 cycle 时生效。alias/dated/glob 已由 pi resolver 解析成具体模型；投影按解析结果去重。测试优先用真实 `resolveModelScopeWithDiagnostics`（pi-coding-agent 导出，`index.d.ts:14`）+ fake runtime 构造 fixture，跑不通则用 `ScopedModel` 类型化 fixture，覆盖 alias/dated/重复/跨 provider。 | §4.1、§9            |
| 13  | 一般   | control off/cap 缺失/旧 agent/models 缺失 显示规则矛盾                                                      | **修**。§5.4 四态表 + `status` 细分，逐项定义模型 chip、thinking chip 是否渲染/可展开/禁用；旧 agent fixture 验证。                                                                                                                                                                                                                                                                                                                                                                                    | §5.4、§9            |
| 14  | 一般   | 伪造 args 推导 policy；第三方同名命令                                                                       | **修**。`command-policy.ts` 新增 `parameterizedBuiltinPolicy(name, overrides?)`（name 限 `model` / `thinking`）（override 优先，否则走 `builtinPolicy` 的「有参数」分支，抽出 `hasArgs` 布尔参数，不再拼假 args）；投影另用 `classifyCommand(pi, name)`（`slash.ts:76`，扩展命令优先于 builtin）判定是否被同名扩展命令遮蔽 ⇒ `policy:"deny"` + `shadowed`。测试：override、同名第三方命令、busy。                                                                                                      | §4.1、§10           |
| 15  | 一般   | `resources_discover` 不可靠；并发/去抖/异常                                                                 | **写明 best-effort**：tick（5 s）与 `resources_discover` 都调同一 `refreshModelsIfChanged()`，同步执行（单线程无并发），统一过指纹门（等价去抖），异常折叠为 `status:"error"`。                                                                                                                                                                                                                                                                                                                        | §4.2                |
| 16  | 一般   | media 判定混用 viewport/pointer；sheet 焦点/滚动/返回键未闭合                                               | **修**。viewport（`(max-width: 640px)`）决定 sheet vs popover；pointer（`@media (pointer: coarse)`）只放大行高。sheet 复用 `PreviewHost.vue` 的 Teleport + 焦点进入/循环/归还 + body 滚动锁（`:1-14,69-122`）；popover 复用 `ContextRing.vue` 的 Esc/外部点击模式。iOS/Android 真机列手工验收（A10）。Android 返回键不拦截（与 PreviewHost 一致），列为已知限制。                                                                                                                                      | §5.1、§12           |
| 17  | 一般   | 20 s 超时回 idle 会导致重复切换/旧结果覆盖                                                                  | **修**。超时进入 `unknown` 态：chip 显示 `?`，**禁止再次发送**直到按 id 收敛（迟到 `cmd_late`/`ctl` 槽、或 `control.query(key, id)` 的 queryOnly 结果、或 `session.model === target` 证明已执行、或 `E_UNKNOWN_ID` ⇒ `notExecuted` 解锁）。任一时刻只跟踪一个 id；其它 id 的迟到结果不影响本组件状态。                                                                                                                                                                                                 | §5.2                |
| 18  | 一般   | `models.policy` 在 settings reload 后过期                                                                   | **写明**：`webHub.webCommandPolicy` 非 live 设置（`setting-specs.ts:275-279` 无 `live`），生效必须 `/reload` ⇒ 新 activate ⇒ attach 强制重发，policy 随之刷新；policy 只是 UI 提示，执行结果（`E_COMMAND_DENIED`/`E_CONFIRM_REQUIRED`）为准，UI 收到即按结果走。                                                                                                                                                                                                                                       | §3.1、§5.2          |
| 19  | Minor  | M3 自行复制 fixture 易漂移                                                                                  | **修**。M1 产出并提交 `tests/fixtures/web-hub-models/*.json`（由投影生成，防漂移比对）；M2/M3 测试**导入**同一批 fixture，不得复制。                                                                                                                                                                                                                                                                                                                                                                   | §9、§10             |
| 20  | Minor  | 未验证 reducer/snapshot 保留新字段                                                                          | **修**。`logic-state.test.ts` 补：SSE `session`（含/不含 models）与 `agents`/`agent_up` 卡片快照路径下 `a.session.models` 深相等/被清除；新 hub 测试 `registry-session-models.test.ts` 钉 registry→card→SSE 透传（只加测试，不改 hub 源码）。                                                                                                                                                                                                                                                          | §9、§12             |
| 21  | Minor  | A5 未区分观测层级                                                                                           | **修**。A5 拆为四层计数：agent 发出的 `t:"session"` 帧、hub 总线 `session`/`gap` 事件、SSE `session`/`gap` 事件、浏览器 `applySession` 次数；每层允许值写明。                                                                                                                                                                                                                                                                                                                                          | §12                 |
| 22  | Minor  | 单组件承担过多                                                                                              | **按裁定**保留 thinking chip（用户已拍板），M3 拆成 **M3a**（模型 chip + 精确 id 跟踪 + 桌面 popover + 窄屏全宽上弹面板）与 **M3b**（thinking chip + 移动底部 sheet 细节），各自可独立验收。                                                                                                                                                                                                                                                                                                           | §5、§10、§12        |

**附加发现（评审外，本版顺带处理）**：`DetailDock.vue:317` QueueList 对 `notExecuted` 的 command 条目重试时用 `runCommand(item.name, "")`——参数丢失，`/model` 无参 ⇒ `E_COMMAND_DENIED`。chip 发出的命令同样会进 QueueList，故 M3a 让 `useControl` 的乐观条目追加 `args` 字段、`DetailDock` 重试改用 `item.args ?? ""`（同时修好手打命令的同一问题）。

---

## 0. 决策摘要

| #   | 决策                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 模型列表挂在 **`SessionInfo.models`（session 槽）**，不挂 StatusInfo、不开新帧。session 帧只在 attach / session_start / `model_select` / `thinking_level_select` / `session_info_changed` 与「列表指纹变化」时发——低频 + 槽位缓存 + 重连重放；hub 侧零源码改动（`registry.ts:379-388` 整存透传、`card()` `:192`、`http.ts:373` toCard、`:743-744` SSE 均为整对象搬运）。 |
| D2  | hub schema 对 `models` 采用**开放但有界**的结构（#3）：对象允许未知字段，已知字段有 `maxItems`/`maxLength`（投影上限的 2 倍）；agent 投影永不超界（属性测试）。满足用户「宽松校验、不因加字段丢帧」的意图。                                                                                                                                                              |
| D3  | 数据源：`ctx.modelRegistry.getAvailable()`（已配凭据模型的**当前快照**）+ `ctx.scopedModels`（`ScopedModel[]`，解包 `.model`）。scoped 条目必须也在 available 中（`recommendableModels` 交集语义），带 `scoped:true` 排前（用户顺序），其余按 registry 顺序。scope 的显式 thinkingLevel 忽略。不下发「是否当前」，UI 由 `session.model` 推导。                           |
| D4  | 上限（UTF-8 字节）：160 条；provider/id 各 ≤128 B；name ≤96 B；整体 ≤16 KiB；三段削每段后重测。                                                                                                                                                                                                                                                                          |
| D5  | 单一 `emitSession()` 负责读取+投影+指纹+写槽；指纹绑定 `connGen + sessionId`；attach 强制发；tick 每 5 s 与 `resources_discover` 走同一指纹门（best-effort）。                                                                                                                                                                                                           |
| D6  | 执行通道 = 现有 `cmd{op:"command"}`（name 为 `model` 或 `thinking`）（`builtin-bridge.ts:236-275`），命令参数由 `modelCommandArg()` 结构化生成；LAN/鉴权/限流/审计/幂等全沿用。                                                                                                                                                                                          |
| D7  | 运行中允许切换；文案只承诺「当前正在输出的请求不受影响，之后的请求使用新模型」（#8）。                                                                                                                                                                                                                                                                                   |
| D8  | UI：`ModelSwitcher.vue`（M3a 模型 chip）+ `ThinkingChip`（M3b）放在 DetailDock 内 composer 上方细工具行；调用方生成 cmdId 精确跟踪（#6/#17）。                                                                                                                                                                                                                           |
| D9  | thinking chip 同期做（用户拍板），`levels` 只来自 pi-ai `getSupportedThinkingLevels`；不可用即只读。                                                                                                                                                                                                                                                                     |
| D10 | 切换只对本会话生效（扩展 API `setModel` 不改全局默认，同 TUI `/model <ref>` 的 `persist:false`，`interactive-mode.js:4265`）。                                                                                                                                                                                                                                           |

---

## 1. 现状核实（带行号）

### 1.1 agent 侧执行能力（已具备）

- `src/web-hub/agent/builtin-bridge.ts`
  - `:236-246` `/thinking <level>`：校验 `THINKING_LEVELS`（`:70`）→ `pi.setThinkingLevel`，**sync**；pi 按模型能力 clamp（`agent-session.js:2016-2034`，档位不变则不发事件）。
  - `:247-275` `/model provider/id`：以**第一个** `/` 切分 → `modelRegistry.find` 不到 ⇒ `E_BAD_REQUEST "unknown model"` → `pi.setModel`：无鉴权 resolve `false` ⇒ late `E_SUBAGENT_REJECTED`（带 message）；内层 `checkAuth` throw（`agent-session.js:1910-1913`）⇒ reject ⇒ late `E_SUBAGENT_REJECTED`（无 message）；有 `sendLate` 时 `completion:"async"`。SSE `cmd_late` 只带 code。
  - `:331-370` `execute()`：`expect.sessionId` 不匹配 ⇒ `E_SESSION_CHANGED`；`classifyCommand`（`slash.ts:76-85`）**扩展命令优先于 builtin**；policy = `resolveCommandPolicy` + `effectivePolicy(busy)`。
- `command-policy.ts:65-79` `builtinPolicy`：`model`/`thinking` 带参数 allow、无参数 deny，无 `policyBusy`；`:182-195` override 整体优先。`commands` 槽的 `model` 行按 args="" 算（`slash.ts:97-117`）⇒ 恒 `deny`，UI 不能用它判定 chip。
- `index.ts:345-353` bridge 已注入 `sendLate`；`:642` `webCommands !== false` 才宣告 `command.v1`。

### 1.2 现有 session 投影与传播

- `messages.ts:69-79` `SessionInfo`；`:537-545` `SessionInfoSchema` 顶层开放；`:661` `SessionFrameSchema`；`:1168-1181` `decodeWith` 校验失败整帧丢弃。
- `agent/index.ts`：`:224` `SESSION_EVENTS`；`:386-391` `publishSession`；`:393-428` `onTick`；`:673` attach；`:696-726` session_start；`:750-753` `resources_discover`；`:778-779` 事件分发；`:995-1013` `sessionInfo()`；`:1015-1025` `sessionOverride()`。
- `connection.ts:310-314` attach 写 session 槽；`:373-381` `setSlot` 缓存 + live 时发送，重连按 `SLOT_ORDER` 重放。
- hub `registry.ts:379-388` 整存 session；已有 session 再收到 ⇒ 额外 publish `gap`（今天每次切模型就会发两次）。
- 浏览器 `state.js:346-348` → `applySession`（`:710-730`）整替 `a.session`；`sameSession`（`:694-702`）只比 id/file/cwd。`types.ts:88` `session?: Record<string, unknown>`。
- 命令跟踪设施：`useControl.ts:70-77` `sendCmd` 先同步 `ctl_send` 乐观条目再发请求；`:156-178` `runCommand`；`control.js:196-290` `pendingTransition`（command ok+async ⇒ `running`；`effect:"unknown"` ⇒ `unknown`；query_result `E_UNKNOWN_ID` ⇒ `notExecuted`）；`state.js:528-543` `cmd_late` 按 id 迁移；`state.js:507` `ctl` 槽 = agent 账本（`CtlItemWire.cmdId/state/code`，`messages.ts:340-360`）。

### 1.3 模型数据源

| 源                                                                                      | 语义                                                                                                                                                                                                                                                 | 用法                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ctx.modelRegistry.getAvailable()`（`model-registry.js:21-22`）                         | 同步，返回 `[...runtime.getAvailableSnapshot()]`；快照 `snapshot.available`（`model-runtime.js:327-329`）由异步 `refresh()`（`:581+`）/`refreshProviderAvailability()`（`:224-260`）整体替换；`getError()`（`model-registry.d.ts`）汇总配置/刷新错误 | 主源；明确是「当前快照」，变化靠指纹门捕捉                                                                |
| `ctx.scopedModels`（`types.d.ts:228-232`，`ScopedModel` 见 `model-resolver.d.ts:9-13`） | `{ model, thinkingLevel? }[]`，已由 resolver 解析 alias/glob/dated；live getter，可能抛（stale ctx）                                                                                                                                                 | 解包 `.model` ⇒ `scoped:true` + 排序；`thinkingLevel` 忽略（#12）                                         |
| `resolvePromptModels`（`available-models.ts:141-149`）                                  | 系统提示用；有 scope 时只给 scoped                                                                                                                                                                                                                   | 不直接用；复用其纯函数 `readScopedModels`/`availableModelsFromRegistry`/`recommendableModels`（`:35-80`） |

注册表变化没有扩展事件（`registerProvider` 等只调 `_refreshCurrentModelFromRegistry`，`agent-session.js:2750-2765`）。

### 1.4 pi 运行中切换语义

- `setModel`（`agent-session.js:1910-1926`）立即写 `agent.state.model`，重设 thinking（发 `thinking_level_select`），再 `model_select`。
- `prepareNextTurnWithContext`（`:522-551`）每个后续 turn 返回 `model: this.agent.state.model`，`agent-loop.js:92-104` 覆盖 config。
- 对外承诺仅限：**当前正在输出的请求不受影响，之后的请求使用新模型**（#8）；conformance 测试证实同一 run 内工具调用后的请求换模（§9），重试/steer 等细节不承诺。

---

## 2. 下发方式比较（不变，结论 D）

| 方案                        | 结论 | 理由                                                                                                                                      |
| --------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A. `StatusInfo.models` 全量 | 否   | status 帧 run 中约 1 Hz，每帧多 ≤16 KiB；与 worktree W2/W3 正面重叠                                                                       |
| B. 新 `models` 槽帧         | 否   | 需 cap + `connection.ts` + hub registry/ports/http/http-contract + `state.js`；`commands` 槽曾漏白名单（accfix-N2）；与删除会话全面撞文件 |
| C. hash + HTTP 按需拉       | 否   | 新请求帧 + 新端点，改动比 B 大                                                                                                            |
| **D. `SessionInfo.models`** | ✅   | 低频；hub 透传；旧 hub 放行；会话级语义（scopedModels、当前模型档位）                                                                     |

---

## 3. Wire 形状、schema 与预算（M1）

### 3.1 类型（`protocol/messages.ts`，仅追加）

```ts
/** web-model-switch §3：一条可切换模型。新增字段只追加。 */
export interface ModelOptionWire {
  provider: string; // isValidProvider：非空、≤128 B、无 "/"、无空白/控制/格式字符
  id: string; // isValidModelId：非空、≤128 B、无空白/控制字符（可含 "/"）
  name?: string; // sanitizeModelName 后 ≤96 B；等于 id 时省略
  ctx?: number; // contextWindow，有限非负整数
  reasoning?: true;
  scoped?: true;
}

export interface SessionModelsWire {
  /** "ok" | "empty" | "error"（schema 为有界 String，未来可追加值）。error = registry 读取抛错或 getError() 非空，items 为能读到的部分。 */
  status: string;
  /** scoped（用户顺序）在前，其余 registry 顺序；≤160。 */
  items: ModelOptionWire[];
  /** 去重 + 校验通过后的全量条数。 */
  total: number;
  omitted?: number; // total - items.length（>0 才有）
  invalid?: number; // 被 provider/id 校验丢弃的条数（>0 才有）
  scoped?: true; // ctx.scopedModels 非空
  /** 当前模型可用 thinking 档位（pi-ai getSupportedThinkingLevels）；导出不可用 / 无当前模型 ⇒ 缺席。 */
  levels?: string[];
  /** 带参数 /model、/thinking 的 UI 预判策略（parameterizedBuiltinPolicy + 遮蔽检测）；执行结果为准。 */
  policy: { model: string; thinking: string }; // "allow" | "confirm" | "deny"
  /** 被同名扩展命令遮蔽（policy 已为 deny），供 tooltip。 */
  shadowed?: { model?: true; thinking?: true };
  /** agent 采样时刻（ms）。不进指纹；含义 = 「此快照的产生时刻」，agent 连接期间每 5 s 复查。 */
  sampledAt: number;
}

export interface SessionInfo {
  // …既有字段不动…
  /** 缺席 ⇔ 本 activate 内 web 控制或 web 命令关闭（或旧 agent）。读取失败 ≠ 缺席（status:"error"）。 */
  models?: SessionModelsWire;
}
```

**快照/陈旧语义（#9）**：不做客户端 stale 计时器——列表只在变化时重发，`sampledAt` 只表示该快照的产生时刻。陈旧通过三条路径暴露：agent 离线/stale ⇒ switcher 不渲染（§5.4）；`status:"error"`；选中后 `E_BAD_REQUEST` ⇒「列表可能过期」。弹层脚注显示「snapshot {相对时间}」。

### 3.2 Schema（`messages.ts`，开放但有界，#3）

在 `SessionInfoSchema`（`:537-545`）之前新增，并在其末尾追加 `models: Type.Optional(SessionModelsSchema)`：

```ts
// web-model-switch §3.2: open (no additionalProperties:false) but bounded at 2× the projection
// caps. A session frame failing this is dropped WHOLE (decodeWith), so agent/models.ts must never
// exceed the projection caps (pinned by tests/web-hub/agent/models-projection.test.ts property test).
// Enum-ish fields are bounded Strings, not literal unions, so future values never drop the frame.
const ModelOptionSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 256 }),
  id: Type.String({ minLength: 1, maxLength: 256 }),
  name: Type.Optional(Type.String({ maxLength: 192 })),
  ctx: Type.Optional(Type.Number({ minimum: 0 })),
  reasoning: Type.Optional(Type.Boolean()),
  scoped: Type.Optional(Type.Boolean()),
});
const SessionModelsSchema = Type.Object({
  status: Type.String({ maxLength: 32 }),
  items: Type.Array(ModelOptionSchema, { maxItems: 320 }),
  total: Type.Integer({ minimum: 0 }),
  omitted: Type.Optional(Type.Integer({ minimum: 0 })),
  invalid: Type.Optional(Type.Integer({ minimum: 0 })),
  scoped: Type.Optional(Type.Boolean()),
  levels: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 16 })),
  policy: Type.Object({ model: Type.String({ maxLength: 16 }), thinking: Type.String({ maxLength: 16 }) }),
  shadowed: Type.Optional(
    Type.Object({ model: Type.Optional(Type.Boolean()), thinking: Type.Optional(Type.Boolean()) }),
  ),
  sampledAt: Type.Number(),
});
```

最坏情况（320 条 × 每条 ≤704 UTF-16 码元）约 <1 MiB，有界且远低于 4 MiB 帧上限。TypeBox `maxLength` 计 UTF-16 码元；agent 侧 128 B 字节上限 ≤128 码元，2 倍余量成立。

### 3.3 预算（`protocol/models.ts` 导出常量，测试钉住）

| 常量                       | 值    | 单位                                      |
| -------------------------- | ----- | ----------------------------------------- |
| `MODELS_WIRE_MAX_ITEMS`    | 160   | 条                                        |
| `MODEL_REF_MAX_BYTES`      | 128   | UTF-8 字节（provider、id 各自）           |
| `MODEL_NAME_MAX_BYTES`     | 96    | UTF-8 字节                                |
| `MODELS_WIRE_BUDGET_BYTES` | 16384 | `Buffer.byteLength(JSON.stringify(wire))` |

削减顺序（每段后重测整体字节）：① 截条数到 160（scoped 在前不先被截）；② name 已在投影时按字节截断（码点边界 + `…` 计入字节）；③ 超预算则从尾部起逐条删 `name`；④ 仍超则从尾部删行 → `omitted`。超长 provider/id 不截断而是整条丢弃（截断会产生不存在的模型引用）→ `invalid`。

---

## 4. agent 侧

### 4.1 新 `src/web-hub/protocol/models.ts`（M1，纯函数，无 TypeBox / pi 依赖，agent 与 UI 共用）

- 常量（§3.3）；`utf8Bytes(s)`（`TextEncoder`，浏览器/Node 通用）；`truncateUtf8(s, max)`（码点边界）；
- `isValidProvider(s)`、`isValidModelId(s)`（规则见 §3.1；控制/格式字符用 `/[\p{Cc}\p{Cf}\s]/u`，id 允许 `/`）；
- `sanitizeModelName(name, id)`：去 `\p{Cc}\p{Cf}`、空白折叠、trim、按字节截断；等于 id 或空 ⇒ `undefined`；
- `modelCommandArg(provider, id)`：两者校验通过 ⇒ `${provider}/${id}`，否则 `undefined`。

### 4.2 新 `src/web-hub/agent/models.ts`（M1，投影）

```ts
export interface ModelsInput {
  available: () => readonly AvailableModelEntry[]; // availableModelsFromRegistry(ctx.modelRegistry)
  registryError: () => string | undefined; // ctx.modelRegistry.getError?.()
  scoped: () => readonly ScopedModelLike[]; // ctx.scopedModels（ScopedModel[]），由 readScopedModels 解包
  current: () => unknown; // ctx.model（原对象，供 levels）
  policy: (name: "model" | "thinking") => CommandPolicy; // parameterizedBuiltinPolicy + 遮蔽
  shadowed: (name: "model" | "thinking") => boolean; // classifyCommand(pi, name)?.kind !== "builtin"
  now: () => number;
}
export function projectModels(input: ModelsInput): SessionModelsWire; // 永不抛
export function modelsFingerprint(wire: SessionModelsWire): string; // JSON（去掉 sampledAt）
export function supportedLevels(model: unknown): string[] | undefined; // piAi 探测；不可用 ⇒ undefined
```

规则：

1. 每个 getter 独立 try/catch；`available`/`scoped` 抛错 ⇒ 视为 `[]` 且 `status:"error"`；`registryError()` 非空 ⇒ `status:"error"`。
2. `scopedEntries = readScopedModels(scoped())`（解包 `entry.model`，忽略 `thinkingLevel`）→ `recommendableModels(scopedEntries, available)`（交集、scope 顺序、去重）→ 标 `scoped:true`；`rest = available − 上述`（registry 顺序）；整体按 `provider/id` 去重保留首个；逐条过 `isValidProvider`/`isValidModelId`，不合格计 `invalid`。
3. `items` 空且非 error ⇒ `status:"empty"`；否则 `"ok"`。**不返回 undefined**（缺席只由 §4.3 的功能开关决定）。
4. `levels = supportedLevels(current())`：`import * as piAi from "@earendil-works/pi-ai"`，`typeof piAi.getSupportedThinkingLevels === "function"` 才调用，返回值过滤为字符串数组且 ≤16；任何异常/不可用 ⇒ `undefined`。**不手写复刻**。
5. `policy.x = shadowed(x) ? "deny" : policy(x)`；`shadowed` 为真时写 `shadowed.x = true`。
6. 预算三段削（§3.3），每段后 `utf8Bytes(JSON.stringify(wire))` 重测。

### 4.3 `command-policy.ts`（M1，#14）

- `builtinPolicy(name, args)` 内部改为 `builtinPolicyFor(name, hasArgs: boolean)`，原函数保留为薄包装（`hasArgs = args.trim() !== ""`），行为不变。
- 新导出 `parameterizedBuiltinPolicy(name: "model" | "thinking", overrides?: Record<string, CommandPolicy>): PolicyDecision`：override 命中 ⇒ `{policy: override}`；否则 `builtinPolicyFor(name, true)`。
- 投影用 `effectivePolicy(decision, false)`；今天两者都无 `policyBusy`。若将来加 `policyBusy`，wire 追加 `policyBusy?: {model?, thinking?}`（append-only），UI 用 `busy` 选择——在本方案中只写注释预留。

### 4.4 接线（M2，`src/web-hub/agent/index.ts`）

- 闭包新增：`let connGen = 0; let lastModelsKey: string | undefined; let modelsTick = 0;`
- 功能开关：`const modelsEnabled = settings.control !== false && settings.webCommands !== false;`（activate 内静态；`webCommands:false` 时本就不宣告 `command.v1`，`:642`）。
- 唯一构造/发送函数（#4/#5）：

  ```ts
  /** The ONLY place a session frame is composed: reads ctx, projects models, updates the
   *  fingerprint key, writes the slot. mode "attach" = c.attach (always sends); "update" = setSlot. */
  const emitSession = (mode: "attach" | "update", override?: Partial<SessionInfo>): void => { … };
  ```
  - `info = { ...sessionInfo(x, sessionReason), ...override }`；`modelsEnabled` 时 `info.models = projectModels(inputsFrom(x))`，并 `lastModelsKey = `${connGen}|${info.sessionId}|${modelsFingerprint(info.models)}``；否则不设字段、`lastModelsKey = undefined`。
  - `"attach"` ⇒ `c.attach(binding, info)`；`"update"` ⇒ `c.setSlot("session", {t:"session", ...info})`。

- `connectWith`（`:673`）：`connGen += 1` 后 `emitSession("attach")`（取代原 `c.attach(binding, sessionInfo(...))`）。
- `publishSession(override)`（`:386-391`）改为 `emitSession("update", override)`；`SESSION_EVENTS` 分发（`:778-779`）不变。
- `refreshModelsIfChanged()`：`modelsEnabled && attached && conn` 时投影一次，算键；与 `lastModelsKey` 不同 ⇒ `emitSession("update")`。同步执行，无并发；异常已在投影内折叠。
  - `onTick`（`:393-428`）：todo 块之后独立块 `if (++modelsTick % 5 === 0) refreshModelsIfChanged();`
  - `resources_discover`（`:750-753`）：`if (attached) refreshModelsIfChanged();`（best-effort，#15）。
- `session_start`（`:696-726`）：与 `lastTodoFp` 同处 `lastModelsKey = undefined; modelsTick = 0;`。
- `model_select`/`thinking_level_select` 走 `publishSession` ⇒ 经 `emitSession` 刷新键 ⇒ 后续 tick 不会因 `levels` 变化重复补发。
- `sessionInfo()`（`:995`）签名不变；**不改** `src/index.ts`（数据全来自 `ctx`、`pi`、`deps.settings`）。

### 4.5 bridge（M2，可选增强，#7）

`builtin-bridge.ts:268` 的 reject 分支带 `message`（`e instanceof Error ? e.message.slice(0, 200)`）。UI 只在 queryOnly 结果里拿到 message 时附加显示，**不依赖**。

---

## 5. UI

### 5.1 位置与形态

- **挂点**（用户拍板）：DetailDock 控制态分支、`CommandConfirm` 之后、`.dock-row` 之前一条细工具行 `<div class="dock-tools"><ModelSwitcher /></div>`（`DetailDock.vue:351-360` 之间）。不改 `Composer.vue`。
- **模型 chip**（紧凑英文 token，en/zh 同值）：`[cpu] opus-4-5 ▾`；短名 = `shortModelLabel(id)`（去末尾 `-YYYYMMDD`），CSS `max-width: 18ch` + ellipsis，`title` = `provider/id`，`translate="no"`。
- **thinking chip**（M3b）：`[sparkle] high ▾`；`levels` 缺席或 `["off"]` ⇒ 只读。
- **弹层**：
  - viewport `> 640px`：chip 上方绝对定位 popover（360px、`max-height: 50vh`），交互沿用 `ContextRing.vue`（Esc 关闭并还焦点、document capture 外部点击关闭）。
  - viewport `≤ 640px`：M3a 为全宽上弹面板（同一 DOM、不 Teleport）；**M3b** 升级为 `<Teleport to="body">` 底部 sheet，复用 `PreviewHost.vue:69-122` 的焦点进入/Tab 循环/焦点归还/body 滚动锁（关闭与卸载两条路径都恢复），遮罩 `@click.self` 关闭、`env(safe-area-inset-bottom)`、`max-height: 75vh`、搜索框不自动聚焦。
  - `@media (pointer: coarse)` 只把行高提到 ≥44px，不决定形态（#16）。
  - 内容：搜索（`provider/id` + name 子串、大小写不敏感）；`scoped` 为真时 `scoped | all` 两 tab（默认 scoped，保持用户顺序平铺）；`all` 按 provider 分组（粘性组头）；行 = 勾（当前）+ id（mono）+ name（muted）+ `200k` / `R` 徽标；当前模型不在列表时置顶一行 `current`；脚注：busy 提示、`omitted`/`invalid` 计数、`snapshot {相对时间}`；`status:"error"` 顶部横幅「Couldn't read the full model list」；`empty` 显示「No models with credentials」。
  - ARIA：`listbox`/`option`/`aria-selected`/`aria-expanded`；↑↓/Enter/Esc。

### 5.2 执行与精确跟踪（#6/#17）

- 选中 ⇒ `arg = modelCommandArg(m.provider, m.id)`（`undefined` ⇒ 不发、提示 invalid）→ `id = newCmdId()` → `view.control.runCommand(key, "model", arg, { id })`；thinking ⇒ `runCommand(key, "thinking", level, { id })`。选中当前项 = 关闭弹层，不发。
- `policy:"confirm"` ⇒ 弹层内联确认后用**新 id** + `{ confirm: true }` 重发；`policy:"deny"` ⇒ chip 禁用 + tooltip（`shadowed` 时文案不同）。执行结果优先于预判：收到 `E_CONFIRM_REQUIRED` 也进入确认态，收到 `E_COMMAND_DENIED` 显示禁止文案（#18）。
- 组件状态机（只跟踪一个 id）：

| 状态      | 进入                      | 出口                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`    | 初始 / 收敛后             | 选中 ⇒ `pending`                                                                                                                                                                                                                                                                                                                                                        |
| `pending` | 发送                      | 同步 `!ok` ⇒ `error(code)`（`E_CONFIRM_REQUIRED` ⇒ 确认态）；`ok`+`sync`（thinking）⇒ `idle`；`ok`+`async` ⇒ 等 id 收敛：本地 `pendingCtl` 中该 id 变 `failed` ⇒ `error(item.error)`、被移除（cmd_late ok）⇒ `idle`；`ctl` 槽中 `cmdId===id` 的 `ok/late_ok` ⇒ `idle`、`failed/late_failed` ⇒ `error(code)`；`session.model===target` ⇒ `idle`；20 s 无结论 ⇒ `unknown` |
| `unknown` | 超时 / 本地条目 `unknown` | 自动 `control.query(key, id)` 一次，并提供「check」按钮；收敛条件同上；query `E_UNKNOWN_ID` ⇒ `notExecuted` ⇒ `idle`（可重试）。**`unknown` 期间禁止再次发送**                                                                                                                                                                                                          |
| `error`   | 失败                      | 6 s 后或手动 × ⇒ `idle`                                                                                                                                                                                                                                                                                                                                                 |

会话切换（`session.sessionId` 变化）⇒ 丢弃跟踪回 `idle`。

- thinking 的 clamp：同步 ok 后若最终 `session.thinkingLevel ≠ 请求值`，chip 旁显示一次「clamped to {level}」（UI 以 session 帧最终值为准，#2）。
- 错误文案（只按 code，#7）：

| code                  | 文案键             | en                                                           |
| --------------------- | ------------------ | ------------------------------------------------------------ |
| `E_SUBAGENT_REJECTED` | `modelErrRejected` | No credentials for this model's provider, or it was rejected |
| `E_BAD_REQUEST`       | `modelErrUnknown`  | Model not found — the list may be out of date                |
| `E_COMMAND_DENIED`    | `modelErrDenied`   | Model switching is disabled by webCommandPolicy              |
| `E_SESSION_CHANGED`   | `modelErrSession`  | The session changed — pick again                             |
| `unknown`（超时）     | `modelUnconfirmed` | Not confirmed yet — check the session                        |
| 其它                  | `modelErrGeneric`  | Couldn't switch model ({code})                               |

- 附加修复：`useControl.ts` 的 command 乐观条目追加 `args`；`DetailDock.vue:317` 重试改为 `runCommand(item.name, item.args ?? "", false)`。

### 5.3 busy

可切换；弹层脚注：「Current reply is unaffected; later requests use the new model」（zh：「当前正在输出的回复不受影响，之后的请求使用新模型」）。

### 5.4 显示四态（#13）

| 状态                                                                   | 判定                                                                 | 模型 chip                                                                                           | thinking chip                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ① control off（hub 无 `cmd.v1` / agent card 无 control）               | `view.enabled === false` 且 `readonlyReason` 为 Hub/Agent            | 不渲染（只读 dock 分支，模型见详情头 SessionInfo）                                                  | 不渲染                                                        |
| ② offline / stale                                                      | `view.enabled === false` 且 `readonlyReason === dockReadonlyOffline` | 不渲染                                                                                              | 不渲染                                                        |
| ③ command cap missing（`webCommands:false` 或 pre-`command.v1` agent） | `view.enabled && !view.commandsEnabled`                              | 不渲染（无法发命令）                                                                                | 不渲染                                                        |
| ④ models missing（`commandsEnabled` 但无 `session.models`，旧 agent）  | `modelsOf(session) === null`                                         | 只读：当前短名、无 ▾、tooltip「Update pi-toolkit to pick models here — or type /model provider/id」 | 只读：`session.thinkingLevel`（有则显示）                     |
| ④a `status:"empty"`                                                    | —                                                                    | 可展开，显示 empty 提示                                                                             | 按 `levels`                                                   |
| ④b `status:"error"`                                                    | —                                                                    | 可展开，横幅 + 能读到的条目                                                                         | 按 `levels`                                                   |
| ⑤ 正常                                                                 | —                                                                    | 可展开；`policy` deny ⇒ 禁用                                                                        | `levels` 缺席/`["off"]` ⇒ 只读；`policy.thinking` deny ⇒ 禁用 |

托管 RPC 会话与 TUI 会话同样适用（web-hub 两种 mode 都 attach，`index.ts:697`；bridge 走扩展 API）。

### 5.5 文件

- M3a：新 `ui/src/logic/models.js`（`modelsOf` 防御性窄化——任何字段类型不符就丢条目/降级，不信任 hub 已校验；`shortModelLabel`；`filterModels`；`groupByProvider`；`switchErrorKey`；`trackSwitch`——纯状态机 reducer，输入 `{pendingCtl, ctl, session, now}`、输出状态，供组件与测试共用）；新 `components/control/ModelSwitcher.vue`；新 `styles/models.css`（组件内 import，先例 `TodoPanel.vue:28`）；`DetailDock.vue`（import + 工具行 + 重试 args 修复）；`composables/useControl.ts`（`id` 透传 + 条目 `args`）；`types.ts:283`（opts 加 `id?: string`）；`i18n/{en,zh}/control.ts` 尾部追加 `model*` 键。
- M3b：新 `components/control/ThinkingChip.vue`（被 `ModelSwitcher` 并排渲染，或 `ModelSwitcher` 内第二个子组件）；新 `components/control/PickerSheet.vue`（Teleport 底部 sheet 外壳，供两个 chip 共用）；`styles/models.css` 追加；`i18n` 追加 `thinking*` 键。

---

## 6. thinking level（用户已拍板：同期做，M3b）

- 数据：`models.levels`（仅来自 pi-ai `getSupportedThinkingLevels`）；当前值：`session.thinkingLevel`。
- 执行：`/thinking <level>`（sync）。pi clamp 后档位可能 ≠ 请求值，UI 以最终 session 帧为准并提示一次 clamp。
- 乱序：切模型时 agent 先后发 `thinking_level_select` 与 `model_select` 两帧，二者都在发出时刻从 live ctx 重算 `models`（含 `levels`），后到者覆盖先到者；UI 只渲染最新 session，测试覆盖两种到达顺序结果一致。

---

## 7. 协议兼容与权限

### 7.1 兼容矩阵（不 bump `PROTO`，不新增 cap/帧/SSE）

| 组合                                  | 行为                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| 新 agent + 旧 hub（≤30 min 替换窗口） | 旧 `SessionInfoSchema` 顶层开放 ⇒ 透传；旧 UI 不读                                          |
| 旧 agent + 新 hub/UI                  | 字段缺席 ⇒ §5.4 ④                                                                           |
| 未来 agent 加字段/新 status 值        | 新 hub schema 开放 + 有界 String ⇒ 放行；UI `modelsOf` 忽略未知键，未知 status 按 `ok` 渲染 |
| models 超界                           | 整个 session 帧被拒——agent 投影由属性测试保证不会发生（§9）                                 |

### 7.2 LAN / 权限

- 执行：沿用 `/api/cmd` command 通道（CSRF、principal 限流、在途上限、审计、幂等 id、`expect.sessionId`；`hub/http.ts:1881-2078`）。LAN 用户本可手打 `/model`，chip 不引入新权限。
- 读：列表随 session 帧下发给所有已鉴权浏览器（含 LAN），仅 provider/id/name/ctx/reasoning/scoped，无 baseUrl/key/headers/错误原文；`status:"error"` 不带错误文本。
- `policy` 只是 UI 预判；agent 执行时再按 `webCommandPolicy` 判一次。

---

## 8. 冻结面（M1 合入后 M2/M3 只读）

- `ModelOptionWire`/`SessionModelsWire` 字段名与语义；`SessionInfo.models` 键名；`SessionModelsSchema` 上限表（§3.2）；`protocol/models.ts` 的常量与四个校验/拼接函数签名。
- 「缺席 ⇔ 功能关闭；读取失败 = `status:"error"`」规则；「不含 current」规则；`sampledAt` 不进指纹。
- `parameterizedBuiltinPolicy` 签名。
- `ControlHandle.runCommand` opts `{ confirm?: true; id?: string }`（M3a 合入后冻结）。
- `tests/fixtures/web-hub-models/*.json`（M1 生成提交，其余包只导入）。

---

## 9. 测试计划

| 层                       | 文件                                                                                                                                                                                             | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 共享校验（M1）           | 新 `tests/web-hub/protocol/models.test.ts`                                                                                                                                                       | provider/id 合法/非法（空、`/`、空白、`\u0000`、`\u200b`、>128 B 的 CJK/emoji）；`truncateUtf8` 码点边界；`sanitizeModelName`；`modelCommandArg` 拒绝非法输入、id 含 `/` 时正确拼接                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 投影（M1）               | 新 `tests/web-hub/agent/models-projection.test.ts`                                                                                                                                               | 真实 `ScopedModel` 形状解包（`{model, thinkingLevel:"high"}` ⇒ 档位被忽略）；alias/dated/重复/跨 provider fixture（优先 `resolveModelScopeWithDiagnostics` + fake runtime，否则类型化 fixture）；scoped∩available；registry 顺序；`status` 三态（空 / `getError()` 非空 / getter 抛错）；levels：探测可用（reasoning false ⇒ `["off"]`，`thinkingLevelMap` 的 `xhigh:null`/`max` 映射）与探测不可用 ⇒ 缺席；policy：无 override、override confirm/deny、同名第三方扩展命令 ⇒ deny+shadowed；**属性测试**（200 个随机 registry：0–10 000 条、超长/非 ASCII/控制字符字段、重复）⇒ 投影输出 100% 通过 `SessionModelsSchema` 且字节 ≤16 KiB；每段削减后字节单调不增 |
| 协议（M1）               | `tests/web-hub/protocol/messages.test.ts` 补；新 `tests/web-hub/protocol/session-models-compat.test.ts`；`tests/fixtures/web-hub-models/{v1-session,legacy-session,future-field,oversized}.json` | ① 旧 schema 副本（不含 models）解码 v1 通过；② legacy 无字段通过；③ future-field（条目多 `foo`、wire 多 `bar`、`status:"partial"`）通过且透传深相等；④ oversized（`items` 321 条 / `id` 300 字符）⇒ 整帧被拒（钉住后果，说明为何投影必须有界）；⑤ v1 fixture 由投影生成后提交，测试比对防漂移                                                                                                                                                                                                                                                                                                                                                                   |
| policy（M1）             | `tests/web-hub/agent/command-policy.test.ts` 补                                                                                                                                                  | `parameterizedBuiltinPolicy` 与 `resolveCommandPolicy(args 非空)` 结果一致；`builtinPolicy` 原有行为不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 接线（M2）               | 新 `tests/web-hub/agent/wiring-models.test.ts`（导入 M1 fixture）                                                                                                                                | attach 帧带 models；`control:false`/`webCommands:false` ⇒ 缺席且帧与改动前相等（既有 `wiring.test.ts:66-130` 零改动）；registry 快照替换后第 5 个 tick 补发一次、第 10 个不发；`model_select` 后 levels 更新且后续 tick 不重复补发；重连（同 Connection）槽重放内容为最新；handover/`connectWith` 再次进入强制重发；session_start 后键清空；stale ctx getter 抛 ⇒ `status:"error"`、不抛；`resources_discover` 无变化不发                                                                                                                                                                                                                                       |
| conformance（M2，#2/#8） | 新 `tests/conformance/model-switch.test.ts`                                                                                                                                                      | ① `@earendil-works/pi-ai` 导出 `getSupportedThinkingLevels` 且非 reasoning 模型返回 `["off"]`；② 复用 `pi-boundary.test.ts:57` 套路：两个 fake 模型，turn1 工具执行期间 `session.setModel(B)` ⇒ 第 2 次请求的 model 为 B、第 1 次为 A（harness 扩展超半天则降为手工 A4）                                                                                                                                                                                                                                                                                                                                                                                        |
| bridge（M2，可选）       | `tests/web-hub/agent/builtin-bridge.test.ts` 补                                                                                                                                                  | reject(Error) ⇒ late `E_SUBAGENT_REJECTED` 带 message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| hub 透传（M2）           | 新 `tests/web-hub/hub/registry-session-models.test.ts`                                                                                                                                           | session 帧 models 经 registry → `card()` → SSE `session`/`agents` 原样（只加测试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| reducer（M3a，#20）      | `tests/web-hub/ui/logic-state.test.ts` 补                                                                                                                                                        | SSE `session` 含/不含 models ⇒ `a.session.models` 深相等/被清除；`agents`/`agent_up` 卡片路径同样；同会话补发不清 transcript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| useControl（M3a）        | `tests/web-hub/ui/use-control.test.ts` 补                                                                                                                                                        | 传入 `id` 被原样用于请求与乐观条目；条目带 `args`；不传 id 行为不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| UI 逻辑（M3a）           | 新 `tests/web-hub/ui/logic-models.test.ts`（导入 M1 fixture）                                                                                                                                    | `modelsOf` 畸形输入；`shortModelLabel`；过滤/分组；`switchErrorKey`；`trackSwitch` 全部迁移（同步失败、async ok via 条目移除 / via `ctl` late_ok、late_failed、`session.model` 证明、超时 ⇒ unknown、query E_UNKNOWN_ID ⇒ notExecuted、其它 id 的结果不影响、会话切换丢弃）                                                                                                                                                                                                                                                                                                                                                                                     |
| 组件（M3a）              | 新 `tests/web-hub/ui/model-switcher.test.ts`；`detail-dock.test.ts` 补                                                                                                                           | 四态表逐行（§5.4，含旧 agent fixture）；搜索/tab/分组/当前置顶；选中 ⇒ `runCommand(key,"model","p/id",{id})`；选中当前不发；confirm 流程新 id；`unknown` 期间禁用；error 文案；busy 脚注；窄屏全宽面板；DetailDock 控制态挂载、只读态不挂；QueueList 重试带 args                                                                                                                                                                                                                                                                                                                                                                                                |
| 组件（M3b）              | 新 `tests/web-hub/ui/thinking-chip.test.ts`、`picker-sheet.test.ts`                                                                                                                              | levels 缺席/`["off"]` 只读；选中 ⇒ `/thinking`；clamp 提示；两种帧到达顺序结果一致；sheet：焦点进入/循环/归还、滚动锁在关闭与卸载都恢复、遮罩关闭、Esc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 自动守卫                 | `i18n-parity.test.ts`、`source-scan.test.ts`                                                                                                                                                     | 全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 全量                     | `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`；`npm run test:conformance`                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 10. 拆包、文件域与冲突

### 10.1 拆包

| 包                            | 文件域（独占）                                                                                                                                                                                                                                                                                                                                                                                | 依赖                            | 执行者       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------ |
| **M1 协议 + 投影 + policy**   | `protocol/messages.ts`（类型 + schema，仅追加）；新 `protocol/models.ts`；新 `agent/models.ts`；`agent/command-policy.ts`（§4.3）；新 `tests/web-hub/protocol/{models,session-models-compat}.test.ts`；`tests/web-hub/protocol/messages.test.ts`；新 `tests/web-hub/agent/models-projection.test.ts`；`tests/web-hub/agent/command-policy.test.ts`；新 `tests/fixtures/web-hub-models/*.json` | —                               | 后端 dev     |
| **M2 接线**                   | `agent/index.ts`（§4.4）；`agent/builtin-bridge.ts`（§4.5，可选）；新 `tests/web-hub/agent/wiring-models.test.ts`；`tests/web-hub/agent/builtin-bridge.test.ts`；新 `tests/conformance/model-switch.test.ts`；新 `tests/web-hub/hub/registry-session-models.test.ts`                                                                                                                          | M1                              | 后端 dev     |
| **M3a 模型 chip + 精确跟踪**  | 新 `ui/src/logic/models.js`、`components/control/ModelSwitcher.vue`、`styles/models.css`；`components/detail/DetailDock.vue`；`composables/useControl.ts`；`ui/src/types.ts`（`:283` 一行）；`i18n/{en,zh}/control.ts`（尾部 `model*`）；新 `tests/web-hub/ui/{logic-models,model-switcher}.test.ts`；`tests/web-hub/ui/{detail-dock,use-control,logic-state}.test.ts`                        | M1（与 M2 并行，用 M1 fixture） | frontend-dev |
| **M3b thinking + 移动 sheet** | 新 `components/control/{ThinkingChip,PickerSheet}.vue`、`tests/web-hub/ui/{thinking-chip,picker-sheet}.test.ts`；`ModelSwitcher.vue`（挂 ThinkingChip、窄屏改用 PickerSheet）；`styles/models.css`；`i18n/{en,zh}/control.ts`（尾部 `thinking*`）                                                                                                                                             | M3a                             | frontend-dev |

顺序：M1 → (M2 ∥ M3a) → M3b。每包返回即派 verifier（验收模型 ≠ 开发模型）。

### 10.2 明确不碰

`src/web-hub/hub/**` 源码、`ui/src/logic/state.js`、`ui/src/contracts.ts`、`protocol/{http-contract,spawn,version}.ts`、`agent/{connection,status,slash}.ts`、`components/detail/{DetailHeader,SessionInfo,AgentDetail}.vue`、`components/control/Composer.vue`、`i18n/*/detail.ts`、`src/index.ts`、`src/config/**`、`src/stack.ts`。

### 10.3 共享文件冲突

| 文件                        | 在途方                               | 风险 | 处理                                                                                                                                                           |
| --------------------------- | ------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/messages.ts`      | worktree W2（StatusInfo 段）         | 低   | 只动 `SessionInfo`（`:69-79`）与 `SessionInfoSchema` 前后（`:537-545`）；与 StatusInfo 段不相邻；后合者 rebase                                                 |
| `agent/index.ts`            | worktree W3（onTick、publishStatus） | 中   | 本方案 onTick 为 todo 块后的独立块；其余在 `connectWith`/`publishSession`/`resources_discover`/session_start；与 W3 的冲突只在 onTick 相邻 hunk，后合者 rebase |
| `ui/src/types.ts`           | 删除会话 P2                          | 低   | 仅 `ControlHandle.runCommand` 一行（`:283`）；删除会话 P2 改的是 agents/view model 段                                                                          |
| `composables/useControl.ts` | 无已知                               | 低   | —                                                                                                                                                              |
| `DetailDock.vue`            | 无已知                               | 低   | 3 处小改                                                                                                                                                       |
| `i18n/{en,zh}/control.ts`   | 无已知                               | 低   | 尾部追加                                                                                                                                                       |
| `agent/command-policy.ts`   | 无已知                               | 低   | 内部重构 + 新导出，原导出行为不变                                                                                                                              |

---

## 11. 风险与非目标

- R1 列表陈旧 ≤5 s（加 pi 自身异步刷新延迟）；用错 ⇒ `E_BAD_REQUEST` 文案。
- R2 session 补发触发 hub `gap`（`registry.ts:384-385`），浏览器重新快照；今天切模型已触发两次，列表变化极少。可选后续（不在本方案）：hub 只在 sessionId/sessionFile 变化时发 gap——属 `hub/registry.ts`，待删除会话 P1 合入后另议。
- R3 `agents` 初始快照每卡多 ≤16 KiB；必要时只调常量。
- R4 运行中换模型使 prompt cache 失效，下一次请求全价读前缀；用户主动行为，不提示。
- R5 Android 返回键不关闭 sheet（与 PreviewHost 一致），已知限制。
- 非目标：设为默认模型、编辑 scoped models、AgentCard/fleet 子 agent 的切换入口、per-model thinking 默认值展示。

---

## 12. 验收锚点

| #   | 包     | 场景                                                                            | 期望                                                                                                                                                                                                                                                                                                                           |
| --- | ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | M3a    | TUI 会话 + web，控制可用                                                        | composer 上方出现 `[cpu] <短名> ▾`；tooltip 为完整 `provider/id`                                                                                                                                                                                                                                                               |
| A2  | M1/M3a | 配置 `enabledModels`（含 `:high` 后缀与 glob）                                  | 默认 `scoped` tab、顺序同解析结果；`all` 按 provider 分组；未配凭据 scoped 不出现；选 `:high` 那项后档位按 pi 默认规则而非 `high`                                                                                                                                                                                              |
| A3  | M3a    | 空闲时切模型                                                                    | chip loader → 短名更新；TUI 发一句话，assistant 消息 provider/model 为新值                                                                                                                                                                                                                                                     |
| A4  | M2/M3a | busy 时切模型（长任务，含工具调用）                                             | 脚注显示「当前正在输出的回复不受影响…」；当前流不中断；之后的请求为新模型（conformance 自动化或手工观察 traffic）                                                                                                                                                                                                              |
| A5  | M2     | 切一次模型后静置 30 s，四层计数                                                 | ① agent 发出 `t:"session"` ≤2（thinking+model 各一，档位不变时 1）；② hub 总线 `session` ≤2、`gap` ≤2；③ SSE `session` ≤2、`gap` ≤2；④ 浏览器 `applySession` ≤2（外加 gap 引起的快照）；静置期间四层均为 0。自动化：`wiring-models.test.ts`（①）+ `registry-session-models.test.ts`（②③）；手工：DevTools EventSource 流（③④） |
| A6  | M3a    | 选未配凭据 provider 的模型（fake 注册）                                         | 「No credentials … or it was rejected」；模型不变                                                                                                                                                                                                                                                                              |
| A7  | M3a    | `webCommandPolicy: { model: "confirm" }` + `/reload`                            | 内联确认；确认后切换成功（新 cmdId）                                                                                                                                                                                                                                                                                           |
| A8  | M3a    | `webCommandPolicy: { model: "deny" }` + `/reload`；或装一个注册 `/model` 的扩展 | chip 禁用；tooltip 分别为 policy / 被扩展命令遮蔽                                                                                                                                                                                                                                                                              |
| A9  | M3a    | 托管 RPC 会话                                                                   | 同 A1/A3                                                                                                                                                                                                                                                                                                                       |
| A10 | M3b    | iOS Safari / Android Chrome 真机（手工）                                        | 底部 sheet；44px 行；搜索框不自动弹键盘；遮罩关闭；焦点归还；背景不滚动                                                                                                                                                                                                                                                        |
| A11 | M3b    | 切到不支持 thinking 的模型 / 请求 xhigh 被 clamp                                | thinking chip 只读 `off` / 显示「clamped to …」；TUI footer/HUD 显示新值                                                                                                                                                                                                                                                       |
| A12 | M3a    | 旧 agent 连新 hub                                                               | §5.4 ④：模型 chip 只读 + tooltip；无报错                                                                                                                                                                                                                                                                                       |
| A13 | M3a    | 只读 hub / agent 离线 / `webCommands:false`                                     | §5.4 ①②③：不渲染                                                                                                                                                                                                                                                                                                               |
| A14 | M3a    | 断网模拟（hub 挂起 cmd 响应 >20 s）                                             | chip 进入 `?`；期间不可再发；恢复后按 id 收敛（成功或失败），不重复切换                                                                                                                                                                                                                                                        |
| A15 | M3a    | 刷新页面 / 第二个标签页打开                                                     | 列表与当前模型立即可见（卡片快照路径保留 `session.models`）                                                                                                                                                                                                                                                                    |
| A16 | 全部   | CI 四门 + `build:web` + `test:conformance`                                      | 全绿；`i18n-parity`/`source-scan` 通过                                                                                                                                                                                                                                                                                         |

真机验收按 `live-acceptance-tmux` 惯例（tmux 起真 pi + 浏览器/deveye）。

---

## 13. 用户拍板（最终决策）

| #   | 问题          | 用户决策                                                                                               |
| --- | ------------- | ------------------------------------------------------------------------------------------------------ |
| Q1  | thinking chip | **同时做**（相邻第二 chip）——实现上拆到 M3b 独立验收（#22）                                            |
| Q2  | chip 挂点     | **composer 上方细工具行**（DetailDock 内）                                                             |
| Q3  | 列表范围      | **全部已配凭据模型，scoped 排前**（scoped/all 两 tab）                                                 |
| Q4  | busy 时切换   | **允许**，提示「下一次请求生效」——文案按 #8 收窄为「当前正在输出的回复不受影响，之后的请求使用新模型」 |
| Q5  | hub 侧校验    | **宽松校验，不因加字段丢 session 帧**——按 #3 落为「开放但有界」，超界由 agent 侧属性测试保证不发生     |

## M2 实施记录

- 接线测试已覆盖真实 `setInterval(onTick, 1000)`：使用 `vi.useFakeTimers()` 与 `advanceTimersByTimeAsync` 驱动 interval；attach 的同步初始 `onTick` 计为第 1 次，替换 registry 快照后第 5 次 `onTick` 恰好补发一次 session，随后 5 次无变化 tick 不再发送。
- conformance ①（pi-ai thinking-level capability）已自动化。conformance ②（busy 时 turn1 工具调用期间 `setModel(B)`，第 2 次请求使用 B）本轮降级为手工 A4：现有 `pi-boundary.test.ts` 的 `fakeModelRuntime` 只绑定单一模型，扩展为可在工具调用期间切换并让 runtime 暴露双模型，需要重建 AgentSession/tool-call 脚手架，预计明显超过本轮 1 小时预算；没有用恒真 stub 替代。
- A4 手工验收：启动真实 TUI + web hub，使用可持续产生工具调用的长任务；首个请求输出期间通过 composer 选择模型 B，确认当前流不中断；观察 traffic/session 或下一轮 assistant message，确认第 2 次模型请求的 `provider/id` 为 B，且第 1 次仍为 A。
