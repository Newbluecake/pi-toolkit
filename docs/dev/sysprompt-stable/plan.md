# system prompt 稳定化：动态段改为「冻结快照折叠 + 尾部更新消息 + 唤醒轮回放」

> 状态：实施方案 **v3.1**（收口版，可开工）· 2026-09-26
> v3 → v3.1：处置 `review-3.md` 全部 15 条（2 严重 / 8 一般 / 5 建议，无阻塞），并落地用户拍板 U1–U8，逐条见文末「review-3 处置表」。
> 要点：① 回放层自带开关 `systemPrompt.wakeReplay`（U5），`wakeReplay=false` + `mode=legacy` 才等于「今天」（D7 更正）；
> ② 冻结快照写进会话条目 `subagent:prompt-sections`，跨 `/reload` 与跨进程 resume 恢复（U6，§4.9）；③ 默认不回放第三方强制文本
> （`adoptForeignForcedPrompt`，U7）；④ 尾部更新消息每段 ≤3 条 / ≤32KB，超限改发指针式消息（I9，U8）；⑤ `prefixFresh` 的清除点由
> `turn_end` 改为 `turn_start`（review-3 #9）；⑥ T-REAL 降级为手工验收 A 系列（review-3 #7，D13）；⑦ peer 升 0.87（U1），A3 改为静态断言。
> v2 → v3：处置 `review-2.md` 全部 14 条，选型由「`context_with_system` 请求时投影」改为「简路线」，逐条见「review-2 处置表」。
> v1 → v2 的处置表保留在「review-1 处置表」。
> 触发：`docs/dev/cache-ttl-adaptive/field-2026-09-24.md` §5 / §5.1。
> 用户已拍板：**system prompt 保持稳定，变化以消息形式追加到对话尾部**。本文全部决策已拍板（§0.2）。

### 源码坐标约定

所有 pi 行为论断给出 **0.87.1**（用户实际运行版本）的 file:line，并注明 **0.84.4**（仓库 `node_modules`）上是否存在。

| 缩写      | 路径                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `pc87:`   | `/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/`                      |
| `ai87:`   | `pc87:node_modules/@earendil-works/pi-ai/`                                                                          |
| `core87:` | `pc87:node_modules/@earendil-works/pi-agent-core/`                                                                  |
| `pc84:`   | `/home/bluecake/ai/pi-toolkit/node_modules/@earendil-works/pi-coding-agent/`（0.84.4；`ai84:` 同理指 pi-ai 0.84.4） |

行号随版本漂移；升级 peer 时按 §7.5 清单复核。

---

## 0. 前置条件与已拍板决策

### 0.1 版本事实

| 事实                                                                                                                 | 证据                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 仓库当前声明 peer `>=0.84.0 <0.86.0`，devDeps 同，`node_modules` 实装 0.84.4（D 包改为 `>=0.87.0 <0.88.0` / 0.87.1） | `package.json:42-46,60-63`                                                                                                        |
| 用户实际运行 `pi` = **0.87.1** ⇒ 扩展**已在声明范围外运行**                                                          | `pc87:package.json` `"version": "0.87.1"`；`~/.pi/agent/settings.json` `lastChangelogVersion: "0.87.1"`                           |
| 结构化 system prompt section（`sections`、transcript 里的 `role:"system"` 消息）是 **0.86.0** 引入                   | `pc87:CHANGELOG.md:87,93,105`（#9548）；`pc84:dist/core/system-prompt.d.ts` 无 `sections`                                         |
| **`context_with_system` 事件是 0.87.0 引入**（v3.1 中只有唤醒回放与播种用它）                                        | `pc87:CHANGELOG.md:27,32,48`；`pc87:dist/core/extensions/types.d.ts:525-533,992`；`pc84:dist/core/extensions/types.d.ts` 无此事件 |
| pi-ai 的 transcript 工具函数（`getCurrentSystemMessage` 等）自 0.86 起从包入口导出                                   | `ai87:dist/index.d.ts:32-33`；`ai87:dist/utils/transcript.d.ts:32`；`ai84:dist/index.d.ts` 无                                     |
| `pi-compat` 的「测试范围」仍写 0.84                                                                                  | `src/adapters/pi-compat.ts:101`（`TESTED_PI_RANGE = "0.84.1 - 0.84.4"`）、`:140-144`（`isWithinTestedRange` 写死 `minor === 84`） |

### 0.2 已拍板决策

| #   | 决策                         | 结论                                                                                                                                                                                                                              | 落点                      |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| U1  | peer / devDeps 版本范围      | **peer 三包 `>=0.87.0 <0.88.0`，devDeps `0.87.1`**；按 §7.5 清单单独一个 `chore(deps)` PR（D 包）。`pi-compat.ts:101,140-144` 照 C2 改；C9 经源码复核保留 v3 描述（review-3 的更正不成立，见处置表末行）；A3 改为静态断言（T-G5） | §7.1 D 包、§7.3、§7.5、D8 |
| U2  | 止血包 S1 先行交付           | **是**。S1 自带 U5 的开关；S1 注册在 post-guard ⇒ S1 阶段子会话唤醒轮不修，如实写入 §3.5 边界 4，M2 接管后补上                                                                                                                    | §3.5、§7.1                |
| U3  | 主方案默认模式               | **`systemPrompt.mode = "stable"`**                                                                                                                                                                                                | §3.2、§4.6                |
| U4  | 唤醒轮不投递更新消息         | **接受**（与 D3 一致）                                                                                                                                                                                                            | D3、R9                    |
| U5  | 回放层的开关形态             | **独立布尔 `systemPrompt.wakeReplay`（默认 true）**，不扩模式枚举；`false` = **不注册** `context_with_system`（不是注册后空转）                                                                                                   | §3.2、§3.5、§4.5、D7      |
| U6  | 快照是否跨 `/reload` 存活    | **会话条目持久化**（`pi.appendEntry`，与 `claude-code-todo-state` 同构），跨 `/reload` 与跨进程 resume 恢复；读回走 `getBranch()`（防 fork 废弃分支复活，goal MAJ-5 先例）；读不到 ⇒ 全新快照（一次刷新）                         | §4.9、D11                 |
| U7  | 对第三方强制文本的回放策略   | **B：保留采纳能力 + 开关 `systemPrompt.adoptForeignForcedPrompt`（默认 false）**；默认只回放我方生产的字节，R5a 降级为 WARN。_已按评审推荐采纳，用户保留推翻权。_                                                                 | §4.5、§4.8、D10           |
| U8  | 更新消息的累积上界与超限策略 | **A：每段自上次刷新起 ≤3 条整块更新 / 累计 ≤32KB，超限改发指针式消息**；写成不变量 I9 + §7.3 断言。_已按评审推荐采纳，用户保留推翻权。_                                                                                           | §4.1 I9、§4.3、D12、§7.3  |

---

## 1. 背景与目标

### 1.1 问题一：动态段让开头频繁变化

每次 `before_agent_start` pi-toolkit 都往 system prompt 末尾拼接三段动态内容，并**返回 `{ systemPrompt }`**：

| 段             | 位置                                                                                                                      | 变化来源                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 项目记忆块     | `src/memory/inject.ts:48-88` `createMemoryInjectHook`（`src/memory/index.ts:50-58` 注册，pre-guard），`:80-82` 返回拼接串 | 记忆写入后 `cache.delete(cwd)`，下一轮重新渲染                                                |
| agent 类型列表 | `src/index.ts:394-396` → `appendAgentTypesToSystemPrompt`（`src/config/agent-types.ts:249-256`）                          | `types.list()` 每轮实时读：增删改 agent `.md`                                                 |
| 可用模型列表   | `src/index.ts:397-413` → `appendAvailableModelsToSystemPrompt`（`src/config/available-models.ts:121-127`）                | `ctx.scopedModels` / `holder.current.models.available()` / `ctx.modelRegistry.getAvailable()` |

system prompt 位于请求**开头**，任何一个字节变化 ⇒ 之后所有缓存断点失效 ⇒ 整段对话按 5m 价全量重写（现场每次 14–42 万 token，$0.7–2.1）。
field-2026-09-24 §5 归因：约 6 次来自记忆 / agent 类型变化，另有约 8 次「无法解释」。

### 1.2 问题二：通知唤醒轮根本不走 `before_agent_start`

主会话已在 0.87.1 源码核实，三轮评审复核一致：

1. 返回 `{ systemPrompt }` ⇒ runner 把它写成 `currentOptions.forceSystemPrompt`（`pc87:dist/core/extensions/runner.js:1042-1043`），
   `prompt()` 把整个 options 存成 **run 级** `_runSystemPromptOptions`（`pc87:dist/core/agent-session.js:1318-1319`）；
   run 结束时 `_runAgentPrompt` 的 `finally` 清空它（`:1100`）。
2. 强制文本只经 `_installAgentForcedPromptProjection`（`:1044-1060`）在**该 run 的每次请求**投影成开头。
3. `pi.sendMessage(…, { triggerTurn: true })`（`src/stack.ts:412` bash job 完成、`:960` / `:973` 子 agent 完成通知、`:321` 空闲时的 steer）
   → `sendCustomMessage` 的空闲分支 `await this._runAgentPrompt(appMessage)`（`pc87:agent-session.js:1500-1507`）——
   **不调用 `emitBeforeAgentStart`**（全文件唯一调用点 `:1283`，属于 `prompt()`）。
4. ⇒ 唤醒 run 没有强制文本：开头 = transcript 重放出的 pi 自身 section，不含三段。

**后果**：用户轮开头 = `base + 三段`，唤醒轮开头 = `base`。两类 run 交替 ⇒ 开头来回切换 ⇒ 整前缀失效；
同时是**功能缺陷**：唤醒轮里模型看不到记忆、合法 `subagent_type`、可用模型。

**现场证据**（主会话 jsonl 统计，排除 >5min 空档与压缩后首轮，field-2026-09-24 §5.1）：

| 相邻两次 run 的触发类型      | 整前缀失效      |
| ---------------------------- | --------------- |
| 同类（用户→用户、通知→通知） | 3/30（10%）     |
| **跨类（用户↔通知）**        | **8/18（44%）** |

跨类失效 44% 而非 100%，与 field §3.2「两条交替前缀谱系」吻合：两种开头各自维持一条缓存链，只有另一条链已过期时跨类切换才落空
（**假设**，S1 上线后以谱系合并验证，见 §7.3 A1）。

0.84.4 上同一缺陷换了形态：`finally` 只清 `_systemPromptOverride`（`pc84:dist/core/agent-session.js:781`）不清 `agent.state.systemPrompt`，
唤醒 run 首个请求沿用上次的强制文本，后续轮次 `prepareNextTurn` 回落到 `_baseSystemPrompt`（`pc84:…:301`）（据源码推断）。

### 1.3 调研确认的 pi 事实（0.87.1）

F1–F4 是 v2 投影路线的依据，v3 起仅作背景；F12–F16 为 v3 新增；F17–F21 为 v3.1 新增（review-3 核查项）。

| #   | 事实                                                                                                                                                                                                                                                                                         | 0.87.1 证据                                                                                                                                                                         | 0.84.4         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| F1  | transcript 里的 system 消息带 `sections`；开头文本 = `content` + 各 section 值按插入顺序以 `\n\n` 连接（背景）                                                                                                                                                                               | `ai87:dist/utils/transcript.js:58-86`；`ai87:dist/utils/text.js:11-18`                                                                                                              | 无             |
| F2  | pi 内置 section 值形如 `<name>\n…\n</name>`，自定义 section 排在 `cwd` 之后（背景）                                                                                                                                                                                                          | `pc87:dist/core/system-prompt.js:105-115`                                                                                                                                           | 无             |
| F3  | pi 只 diff「transcript 重放出的 sections」与「本轮 options 生成的 sections」，缺失的键生成 `null`（背景：强制文本**不进** transcript，所以不触发 diff）                                                                                                                                      | `pc87:agent-session.js:1031-1032`；`pc87:system-prompt.js:135-146`                                                                                                                  | 无             |
| F4  | 非 capable 路由把所有 system 消息折叠回开头；当前生成目录里**没有任何模型**开启 `supportsMidConvoSystemMessages`                                                                                                                                                                             | `ai87:dist/utils/transcript.js:96-104`；`ai87:dist/models.generated.js`（0 次）                                                                                                     | 无此机制       |
| F5  | `context_with_system` 在每次 LLM 请求前触发，返回值原样发送；在 `context` 处理器之后、强制 prompt 投影之前运行；入参是 `structuredClone` 的副本，改不到 transcript；handler 被 `await` 且事件**无 `signal`**                                                                                 | 定义 `pc87:types.d.ts:525-533`；分发 `pc87:runner.js:902,930-958`（`:934` await）；每请求调用 `core87:dist/agent-loop.js:262-264`；强制投影在外层 `pc87:agent-session.js:1044-1047` | **无**         |
| F6  | 普通 `ExtensionContext` 的 `ctx.getSystemPrompt()` = `buildSystemPrompt(_runSystemPromptOptions ?? _baseSystemPromptOptions)`：强制 run 中返回强制文本本身                                                                                                                                   | `pc87:agent-session.js:878-881,2474`；`pc87:system-prompt.js:121-124`                                                                                                               | 有（语义不同） |
| F7  | `before_agent_start` 返回的 `message` 被收集为 `role:"custom"`，排在本轮用户消息之后，持久化并进入 LLM 上下文；同一返回值可同时带 `systemPrompt`                                                                                                                                             | `pc87:runner.js:1038-1044`；`pc87:agent-session.js:1296-1317`                                                                                                                       | 有             |
| F8  | 同一 handler 链共享一个 `currentOptions`：前面 handler 设置的强制文本对后续 handler 可见（`event.systemPromptOptions.forceSystemPrompt`；`event.systemPrompt` 是 getter，强制后返回强制文本）；链按「扩展 → 该扩展的 handler」两层迭代 ⇒ **同一扩展的 handler 连续执行**                     | `pc87:runner.js:1016-1017,1024-1025,1031-1035,1042-1043`                                                                                                                            | 无             |
| F9  | 每个 agent loop（含唤醒 run、run 内 `agent.continue()`）都发 `agent_start`；`_runAgentPrompt` 的 `finally` 发 `agent_settled`，**晚于** run 尾的 ③ 号压缩                                                                                                                                    | `core87:agent-loop.js:50,67`；`pc87:agent-session.js:1078-1104`（③ 在循环内 `_handlePostAgentRun` → `:1135`，settled 在 `finally` `:1103`）                                         | 有             |
| F10 | `session_compact` 对手动、阈值自动、扩展提供的压缩都会发出                                                                                                                                                                                                                                   | `pc87:agent-session.js:1904-1907,1938-1946`（手动，含 `fromExtension`）、`:2227`（自动）                                                                                            | 有             |
| F11 | 扩展**无法**持久改写 base options（`getSystemPromptOptions()` 只在命令上下文，返回的对象每次 `_rebuildSystemPrompt` 整体替换）                                                                                                                                                               | `pc87:types.d.ts:255-257`；`pc87:agent-session.js:991-1015,2475`                                                                                                                    | 同             |
| F12 | 压缩发生在三处：① `prompt()` 在 `emitBeforeAgentStart` **之前**（`_checkCompaction(lastAssistant)`）；② run 内每个后续助手回复之前（`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`）；③ run 尾 `_handlePostAgentRun` → `_checkCompaction`，之后可能 `agent.continue()` | ① `pc87:agent-session.js:1276-1279`；② `:297-307,385`；③ `:1084,1106,1135`                                                                                                          | 未逐一核对     |
| F13 | agent loop 事件顺序：`turn_end(N)` → `prepareNextTurn`（② 的压缩在此发 `session_compact`）→ `turn_start` → 请求 → `turn_end(N+1)`；错误 / 中止的回复同样发 `turn_end`                                                                                                                        | `core87:agent-loop.js:93,113,151,176-178`                                                                                                                                           | 有 `turn_end`  |
| F14 | run 内 `prepareNextTurnWithContext` 以 `_runSystemPromptOptions` 为底重建 options（`normalizeBuildSystemPromptOptions` 复制 `forceSystemPrompt`）⇒ **强制文本在整个 run 内冻结**；强制投影的 `toolsAdded` 每请求取当前值                                                                     | `pc87:agent-session.js:391-401`；`pc87:system-prompt.js:12`；`pc87:agent-session.js:1049-1058`                                                                                      | —              |
| F15 | `before_agent_start` 链结束后 pi 把 `result.systemPromptOptions`（同一个 `currentOptions`）原样赋给 `_runSystemPromptOptions` ⇒ 在我们的 handler 里读到的强制文本，与该 run 内请求时 `ctx.getSystemPrompt()` **逐字节相同**（除非更晚的 handler 又改了它）                                   | `pc87:runner.js:1016,1043,1058`；`pc87:agent-session.js:1283,1319,880`；`pc87:system-prompt.js:121-124`（review-2 #5）                                                              | —              |
| F16 | `getContextUsage()` 以 provider 实报的 input tokens 为锚（最近一次压缩后存在带 usage 的助手消息时），只有「压缩后尚无 usage」时回落纯估算且此时返回 `tokens: null`                                                                                                                           | `pc87:agent-session.js:3098-3131`（`:3120`）；`pc87:dist/core/compaction/compaction.js:158-189`（review-2 #7）                                                                      | —              |
| F17 | **`turn_end` 可被跳过**：`_dispatchTurnEndBoundary` 在 `messageEntryId` 解析不到时 `emitError` 后 `return false`，不分发给任何 handler。**`turn_start` 不可跳过**：每个请求之前必发（首轮紧随 `agent_start`；后续轮在 `prepareNextTurn` 之后），由 `_handleAgentEvent` 普通 `emit` 转发      | 跳过 `pc87:agent-session.js:332-345`；`turn_start` `core87:agent-loop.js:51,68,113`，转发 `pc87:agent-session.js:718-724`                                                           | 有             |
| F18 | 唤醒 run 的第 1 个请求 `_runSystemPromptOptions === undefined`（上一 run 的 `finally` 已清，唤醒路径不设）⇒ `ctx.getSystemPrompt()` 渲染 `_baseSystemPromptOptions`；第 2 个请求起被 `prepareNextTurnWithContext` 赋值（含 `selectedTools: getActiveToolNames()`）                           | `pc87:agent-session.js:1100,391-401,878-881`（review-3 #5）                                                                                                                         | —              |
| F19 | `ctx.getSystemPrompt()` 在 `bindCore` 之前的默认实现是 `() => ""`                                                                                                                                                                                                                            | `pc87:runner.js:183`；真实绑定 `:231`，由 `pc87:agent-session.js:2396` 触发（review-3 #4）                                                                                          | —              |
| F20 | `pi.appendEntry` → `appendCustomEntry` 写 `type:"custom"` 条目，作为当前叶子的子节点并**推进叶子**；`CustomEntry` **不进入 LLM 上下文**（`buildSessionContext` 忽略）                                                                                                                        | `pc87:dist/core/session-manager.js:900-912`；`pc87:dist/core/session-manager.d.ts:76-84`                                                                                            | 有             |
| F21 | `session_start.reason ∈ "startup" \| "reload" \| "new" \| "resume" \| "fork"`                                                                                                                                                                                                                | `pc87:dist/core/extensions/types.d.ts:420`                                                                                                                                          | 有             |

### 1.4 目标 / 非目标

- **G1** 同一会话里，用户轮与唤醒轮看到**同一份**由 pi-toolkit 贡献的 system prompt 内容（修功能缺陷 + 消除跨类失效）。
- **G2** 两次刷新点之间，pi-toolkit 贡献的开头字节**严格不变**，与 provider compat 无关。
- **G3** 动态段的真实变化在下一个用户轮以尾部消息告知，「以这条为准」；同一内容不重复发送（压缩 / 分支后的一次重发除外，I3），且总量有上界（I9）。
- **G4** 只在本来就会整段失效的时机刷新快照；其余时机的变化只走尾部，不改开头。**`/reload` 不是这样的时机**（它不重写对话），快照必须跨 `/reload` 存活（U6）。
- **G5** 在新接缝缺席（`context_with_system` 不分发 / `wakeReplay=false`）时**不静默丢失**三段内容。peer 升 0.87 后这是健壮性要求，由静态断言 T-G5 守护（§7.3）。
- 非目标：pi 自身 section（skills、AGENTS.md）的变化；§5 中与唤醒无关的剩余不明重写（需抓线级载荷）；让自定义路由开启 `supportsMidConvoSystemMessages`；回放第三方扩展的 run 级强制文本（U7 默认关）。

---

## 2. 现状摘要

```
src/index.ts
 ├─ pre-guard:  wireMemory(pi, {settings.memory, isChildSession})          ← src/memory/index.ts:27-80（src/index.ts:125）
 │                 ├─ pi.on("session_start", frozenBlocks.clear)
 │                 └─ pi.on("before_agent_start", createMemoryInjectHook)  → {systemPrompt: prompt + "\n\n" + block}
 ├─ HOST_KEY guard（子会话到此为止）
 └─ post-guard: pi.on("before_agent_start", …)                            ← src/index.ts:394-414
                  sp = appendAgentTypesToSystemPrompt(event.systemPrompt, types.list(), …)
                  sp = appendAvailableModelsToSystemPrompt(sp, scoped || holder.current?.models.available() || registry)
                  return sp === event.systemPrompt ? undefined : { systemPrompt: sp }
```

- 三个拼接的形态完全一致：非空时 `prompt + "\n\n" + text`（`agent-types.ts:254-255`、`available-models.ts:125-126`、`memory/inject.ts:82`），
  记忆额外有横幅/哨兵去重（`inject.ts:81`）。这使一个通用折叠函数能逐字节复现现状（§4.2 `foldSections`）。
- 三段各有固定标题行：`## Available subagent types (pi-subagent)`（`agent-types.ts:225`）、`## Available models (pi-subagent)`
  （`available-models.ts:114`）、`## Memory (<slug>) — N file(s)`（`memory/render.ts:154`），记忆块尾部带哨兵 `<!-- pi-toolkit:memory <slug> -->`（`render.ts:27,192`）。
  更新消息按「以某前缀开头的标题行」引用它们（§4.3）。
- 格式化函数都是纯函数；`memoryFingerprint`（`render.ts:83`）/ `renderMemoryBlock`（`:140`）均为**同步**函数（review-2 已核）。
- 模型来源三条分支（`src/index.ts:406-411`）渲染结果逐字节相同（review-1 #7 已核）。
- pi-toolkit 内部的 `before_agent_start` 注册共三处：记忆（pre-guard）、核心（`src/index.ts:394`）、飞书（`src/feishu-notify/index.ts:504`，只读 `event.prompt`）。
  记忆与核心之间没有别的 handler ⇒ 把三段合并到一个 pre-guard handler 里折叠，与现状逐字节相同。
- 唤醒型 `sendMessage`：`src/stack.ts:321`（steer）、`:412`（bash job）、`:960`、`:973`（子 agent 通知）。bash job 在 stack 构建时 `recover()`（`src/stack.ts:1438`），
  ⇒ resume 后**第一个用户轮之前**就可能出现唤醒轮（§3.5 边界 1、§4.5 首唤醒播种）。
- 设置读取：pre-guard 用 `readSettingsNoMigrate()`（`src/index.ts:108`），post-guard 用 `loadSettingsFromFile()`（`:148`），均在 activate 时读一次。
- 会话条目持久化先例：`src/todo/`（`STATE_ENTRY = "claude-code-todo-state"`，`src/todo/state.ts:43`；`restore` 用 `getBranch()` 回放，`src/todo/index.ts:101-121`）、
  `src/goal/store.ts`（`subagent:goal`；读回走 `getBranch()` 防 fork 废弃分支复活、按 `reason` 分流、写失败只 WARN，`:1-65`）。
- 测试基础：`tests/integration/system-prompt-injection.test.ts:39-57`（`fakePi()`，`Map<string, Handler[]>` 接受任意事件名）、`tests/memory/inject.test.ts`、`tests/memory/wire.test.ts`、
  `tests/config/available-models.test.ts`；带种子 property 先例 `tests/core/message-property.test.ts`（`fast-check ^4.9.0` 已在 devDeps）。
- 其它扩展：用户当前加载 `pi-traffic-record` 与 `~/.pi/agent/extensions/orca-agent-status.ts`，均**不**返回 `systemPrompt`（review-2 复核）。

---

## 3. 总体设计

### 3.1 核心思路

> **开头的形态保持今天的样子**：三段仍折叠在 `before_agent_start` 返回的 `{ systemPrompt }` 里。变化只有四点：
> ① 折叠的是每段的**冻结快照**，只在免费时机刷新（G2 / G4）；② 快照与实时内容的差异由同一个 handler 返回的尾部
> custom 消息告知，总量有上界（G3 / I9）；③ 唤醒轮把最近一个用户 run 中**我方生产的**强制文本按 pi 自己的强制投影形态回放（G1）；
> ④ 快照状态写进会话条目，`/reload`、resume、fork 后从当前分支读回（G4 / U6）。

为什么不用 v2 的请求时投影：D1 逐目标对照。一句话——简路线兑现同样的 G1–G4，开头字节形态与今天相同、构造上与
pi 自己的强制 run 同构（且**幂等**，review-3 已核），因此 v2 投影层独有的一整类问题（合成头、capable 路由、后加载扩展静默覆盖、
每进程一次形态切换、锁存与模式交接）在这里**不存在**，而不是被逐个修补。

### 3.2 三个设置（两个正交维度 + 一个安全阀）

| 设置                                    | 取值 / 默认                    | 作用范围                                                                                                                                                                      | 读取时点                                                            |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `systemPrompt.mode`                     | `"stable"`（默认）/ `"legacy"` | 用户轮 `before_agent_start` 折叠**快照**（stable，+ 可能的尾部 `{ message }`，+ 写会话条目）还是**实时内容**（legacy，只返回 `{ systemPrompt }`，与今天逐字节相同，不写条目） | 每次 `before_agent_start` 读一次 ⇒ **整个 run 不变**（review-2 #6） |
| `systemPrompt.wakeReplay`               | `true`（默认）/ `false`        | `true` ⇒ 注册 `context_with_system`（唤醒回放 + 首唤醒播种 + R5a 检测）；`false` ⇒ **完全不注册**，唤醒轮与今天相同（U5）                                                     | activate 时读一次；改后 `/reload` 生效                              |
| `systemPrompt.adoptForeignForcedPrompt` | `false`（默认）/ `true`        | 回放范围是否扩到第三方扩展的强制文本：R5a 追加时采纳其最终文本、我方三段全空时捕获更早扩展的强制文本（U7）                                                                    | activate 时读一次                                                   |

回滚矩阵（D7 更正）：

| `wakeReplay` | `mode`   | 用户轮          | 唤醒轮             | 等价于               |
| ------------ | -------- | --------------- | ------------------ | -------------------- |
| `false`      | `legacy` | 今天            | 今天               | **今天，逐字节相同** |
| `true`       | `legacy` | 今天            | 回放用户轮强制文本 | S1 单独上线时的状态  |
| `false`      | `stable` | 快照 + 尾部更新 | 今天（只有 base）  | 只要 G2/G3，放弃 G1  |
| `true`       | `stable` | 快照 + 尾部更新 | 回放 / 播种        | **主方案（默认）**   |

- 没有「有效模式」概念、没有锁存：用户轮路径在所有 pi 版本上都相同；`context_with_system` 不分发时回放层自然惰性（G5 由构造保证，T-G5 守护）。
- `context_with_system` 的处理器**不读 `mode`**：它只回放 `before_agent_start` 捕获的文本，所以同一 run 内不会出现两种模式交错。
- 不把 `wakeReplay` 并进 `mode` 枚举：回放与快照是两个独立关注点，混进同一个枚举会再造一个「有效模式」概念（v2 已被否决的形态，review-3 U5 推荐 B）。

### 3.3 模块划分与依赖方向

```
src/prompt-sections/                          （新增）
 ├─ stable-section.ts   纯：SectionState / SKIP / POINTED / resolveAtTurn / resolveAtSeed / markStale / forgetAnnounced / UPDATE_LIMITS   ← 不 import pi
 ├─ fold.ts             纯：foldSections（= 今天三个 append* 的通用形态）
 ├─ update-message.ts   纯：渲染尾部更新消息（整块 / removed / 指针；只渲染，不解析）
 ├─ store.ts            纯：会话条目序列化 / 校验 / 从分支读回（U6，§4.9）
 ├─ wake-replay.ts      纯：buildReplayMessages + createWakeReplay（单状态 captured）
 ├─ s1-wiring.ts        S1 专用：wireWakeReplay（M2 合并时删除，由 hub 接管）
 ├─ hub.ts              面向 pi：createPromptSectionHub —— 段注册表 + 全部钩子（每 activate 注册一次）
 └─ core-sections.ts    types / models 两个 SectionRegistration 工厂（保持 index.ts 只做装配，I7）
        ▲ register(name, reg)                          ▲ register(...)
src/memory/index.ts（pre-guard，子会话也用）       src/index.ts（post-guard）
src/adapters/pi-compat.ts ← onContextWithSystem() / readForceSystemPrompt() / getTranscriptHelpers()（唯一接触新 API 的地方）
```

- 依赖方向：`memory` / `index.ts` → `hub` → `stable-section`、`fold`、`update-message`、`store`、`wake-replay` → `pi-compat`。纯模块不 import pi。
- 相比 v2 删除：`projection.ts`（`injectSections`、`SECTION_NAME_RE`）、`globalThis` 锁存及其测试 reset、`live` 模式与 `resolveLive*`、
  每请求的 `resolve*AtRequest`、`describe()` 的「有效模式」、`legacySkipIf` 的双路径语义。
- `hub` 在 `src/index.ts` **pre-guard** 于 activate 闭包内**无条件**创建（不放模块级，遵守 /reload 不变量）；记忆开启时由 `wireMemory` 注册记忆段，
  post-guard 注册 types / models。注册顺序 = 折叠顺序 = 今天的拼接顺序：记忆 → 类型 → 模型。
- 为什么需要 hub：三段必须在**同一个** handler 里折叠，才能共享一次快照决策、合成一条更新消息（一个 handler 只能返回一条 message，F7），
  并把最终强制文本交给回放层捕获。
- 为什么需要 `store.ts`：U6 已定走会话条目；把序列化 / 校验 / 读回做成纯函数（与 `src/goal/store.ts` 同构），hub 只负责「何时写、何时读」。

### 3.4 数据流

```
session_start(reason) ─ hub: states = readBack(getBranch(), reason) ?? 全新；replay.reset()；userTurnSeen = prefixFresh = false；firstRequestPending = true

用户轮  prompt()
  [F12①] 可能先压缩 → session_compact → hub: forgetAnnounced + prefixFresh = true
  before_agent_start ─ hub.onBeforeAgentStart(event, ctx)
      prefixFresh ? 全部 markStale（此刻刷新是免费的：本 run 首个请求本来就整段重写）
      stable : 各段 resolveAtTurn(state, live) → text = snapshot，收集 update（I9：超限改指针）
      legacy : text = live
      sp = foldSections(event.systemPrompt, texts)
      wakeReplay ? replay.capture(sp !== event.systemPrompt ? sp : (adoptForeign ? 更早扩展的强制文本 : undefined))
      stable ? persist()（状态有变才写一条 subagent:prompt-sections）
      return { systemPrompt?: sp, message?: 合并后的更新消息 }
  turn_start ─ prefixFresh = false（每个请求之前必发，F17）
  每个请求 context_with_system（仅 wakeReplay）─ 首个请求做 R5a 检测；replay.apply(messages)
      // 强制 run 中 pi 的强制投影随后以同一文本覆盖（F5 + F15），等于无操作（review-3 核：幂等）
  [F12②③] run 内压缩 → session_compact → forgetAnnounced + prefixFresh = true；随后的 turn_start → prefixFresh = false
  agent_settled ─ firstRequestPending = true

唤醒轮  sendMessage(triggerTurn) → _runAgentPrompt    （无 before_agent_start，无强制文本）
  turn_start ─ prefixFresh = false
  每个请求 context_with_system（仅 wakeReplay）─ hub.onContextWithSystem(event, ctx)
      有 captured      : 回放 captured（形态 = pi 强制投影）⇒ 开头与最近一个用户 run 逐字节相同
      无 captured、本会话（本次 activate）尚无用户轮、且为本 run 首个请求 :
                         首唤醒播种 captured = foldSections(ctx.getSystemPrompt(), resolveAtSeed(...)) 并回放
      否则             : 不改（最近一个用户轮本来就没有我方强制文本 ⇒ 两边都是 base）
```

### 3.5 止血包 S1（先行交付，独立 PR；自带开关）

**接缝 = `context_with_system`（F5）**，不改现有两个 `before_agent_start` handler，不依赖 U1 / D 包（compat 函数按窄类型设计，§4.7）。

原理：用户轮里 pi 用 run 级强制文本投影开头；唤醒轮没有强制文本。S1 在用户轮的 handler 链末端读出强制文本（F8；由 F15，
它与请求时 pi 实际使用的文本逐字节相同），在唤醒轮按 pi 强制投影**完全相同的形态**（`pc87:agent-session.js:1049-1058`：
`{ role:"system", content: forced, toolsAdded: current.toolsAdded, timestamp }` + 丢弃其余 system 消息）写回请求。

```
设置：systemPrompt.wakeReplay（默认 true，U5）；S1 在 settings.ts 引入 systemPrompt 子对象时只含这一个键（mode / adoptForeign 随 M2 加入）
      false 或子会话 ⇒ 下面四个 handler 一个都不注册
状态（activate 闭包）：chainStart: string | undefined；captured: string | undefined

pre-guard（src/index.ts:125 wireMemory 之前）：
  before_agent_start#start：chainStart = readForceSystemPrompt(event)
        // F8：同一扩展的 handler 连续执行 ⇒ 这里读到的就是「更早扩展设的强制文本」或 undefined
  context_with_system：return captured === undefined ? undefined : { messages: buildReplayMessages(event.messages, captured, helpers) }
        // 强制 run 中 pi 的强制投影在外层随后以同一文本覆盖本结果（F5 + F15），对用户轮无副作用
  session_start：captured = chainStart = undefined
post-guard（src/index.ts:414 核心 handler 之后，F8）：
  before_agent_start#end：end = readForceSystemPrompt(event)
        captured = end !== chainStart ? end : undefined      // 只回放「我方在链上改过」的文本（U7 默认口径）；恒返回 undefined
```

- 装配：`src/prompt-sections/s1-wiring.ts` 导出 `wireWakeReplay(pi, { enabled }): { registerCapture(): void }`；`src/index.ts` pre-guard 调一次、post-guard 调
  `registerCapture()`——保持 I7（`src/index.ts` 不含逻辑）。M2 合并时删除此文件，hub 接管（hub 自身是单一 handler，`event.systemPrompt` 即链起点，不再需要 `chainStart`）。
- v2 的 `pendingCapture` 与「延迟到请求时捕获」删除（review-2 #5）：由 F15 二者逐字节相同。
- `context_with_system` 不分发时 S1 天然惰性，无需探测；`forceSystemPrompt` 字段不存在 ⇒ `captured` 恒为 `undefined`。
- `buildReplayMessages` 需要 pi-ai 的 `getCurrentSystemMessage`（取 `toolsAdded`）：经 `pi-compat.getTranscriptHelpers()` 获取（§4.7），缺失则不回放。
- 已知边界（均为「退回今天的行为」，不会更差）：
  1. /reload、/new、resume 后、第一个用户轮之前的唤醒轮：无捕获（M2 的首唤醒播种 + U6 读回补上，§4.5 / §4.9）。
  2. 用户轮之后工具集变化：回放文本里 pi 的 `tools` 说明段是旧的，但 `toolsAdded`（真正的工具声明）取当前值——与强制用户 run 内的行为完全相同（F14）。
  3. 更晚加载的扩展在我们之后改写强制文本：S1 不检测；M2 的 R5a 检测 + U7 开关处理（§4.5 / D10）。
  4. **子会话的唤醒轮在 S1 阶段不修**（review-3 #10）：S1 的捕获 handler 必须排在核心 handler（`src/index.ts:394`，post-guard）之后才满足 F8，所以只能 post-guard；
     而子会话确有唤醒轮（嵌套 subagent 的「子 agent 完成通知」投给父会话，父会话本身可以是子会话，`src/stack.ts:960/973`，`triggerTurn: true`）且默认带记忆段
     （`memory.injectInChildSessions` 默认 true，`src/config/settings.ts:503`）。M2 的 hub 是 pre-guard 单一 handler，子会话随之生效。
- 主方案落地后回放逻辑**不删除**（`wake-replay.ts` 保留，由 hub 接管钩子）；它是简路线兑现 G1 的永久组件。

---

## 4. 接口契约

### 4.1 `src/prompt-sections/stable-section.ts`（纯函数）

```ts
/** provider 无法得到可信内容（抛错、返回 Promise、注册表未就绪等）。与 "" 不同："" 表示「此刻确实没有内容」。
 *  用 Symbol.for：与 HOST_KEY 同约定，防同一模块被两个 jiti 实例各加载一次产生两个不相等的哨兵（review-3 #13）。 */
export const SKIP: unique symbol = Symbol.for("pi-subagent:prompt-section-skip") as never;
export type Live = string | typeof SKIP;

/** announced 的特殊值：本段已发过指针式消息（I9），模型被告知「以工具 / 下次刷新为准」。 */
export const POINTED: unique symbol = Symbol.for("pi-subagent:prompt-section-pointed") as never;

export const UPDATE_LIMITS = { maxCount: 3, maxBytes: 32 * 1024 } as const; // U8；字节按 UTF-8（TextEncoder）计

export interface SectionState {
  /** 折叠进开头的文本；undefined = 本会话尚未成功取过快照 */
  snapshot: string | undefined;
  /** 模型有效视图中的内容（snapshot，或其后最近一条整块更新的内容）；POINTED = 已发指针 */
  announced: string | typeof POINTED | undefined;
  /** 下一次解析需要刷新快照 */
  stale: boolean;
  /** 自最近一次刷新以来发出的整块更新（含 removed）条数 / 累计字节（I9） */
  sentCount: number;
  sentBytes: number;
}

export const initialSectionState = (): SectionState => ({
  snapshot: undefined,
  announced: undefined,
  stale: true,
  sentCount: 0,
  sentBytes: 0,
});
export const markStale = (s: SectionState): SectionState => ({ ...s, stale: true });
/** 「忘掉已通知」：上下文里可能已没有讲这段的更新消息（压缩摘要掉 / 分支导航），下一个用户轮若 live ≠ snapshot 会重发。
 *  不改开头、不清计数（计数是「已进入上下文的上界」，保守高估只会更早转指针）。 */
export const forgetAnnounced = (s: SectionState): SectionState => ({ ...s, announced: s.snapshot });

export type SectionUpdate = { kind: "update"; content: string } | { kind: "removed" } | { kind: "pointer" };

/** 用户轮（before_agent_start）。唯一可能产出 update 的地方。text = 本轮折叠进开头的文本。 */
export function resolveAtTurn(
  state: SectionState,
  live: Live,
  limits?: { maxCount: number; maxBytes: number }, // 缺省 UPDATE_LIMITS
): { state: SectionState; text: string; update?: SectionUpdate };

/** 首唤醒播种（context_with_system，本次 activate 尚无用户轮）。从不产出 update；live 为惰性 thunk，只在需要刷新时调用。 */
export function resolveAtSeed(state: SectionState, live: () => Live): { state: SectionState; text: string };
```

**状态机（规范性定义，测试以此为准）**：

```
refresh(state, live):                                   // 刷新分支（两处共用）
    if live === SKIP: return state 不变                 // 不落快照、不清 stale，下一次重试
    return { snapshot: live, announced: live, stale: false, sentCount: 0, sentBytes: 0 }

resolveAtTurn(state, live, limits):
    if state.stale || state.snapshot === undefined:
        s = refresh(state, live); return { state: s, text: s.snapshot ?? "" }          // 刷新点：不发消息
    if live === SKIP || live === state.announced: return { state, text: state.snapshot }   // 未知 / 未变 / 已通知
    if state.announced === POINTED: return { state, text: state.snapshot }               // 指针态：至多一条指针，直到刷新或 forgetAnnounced
    if live === "":
        return { state: { ...state, announced: "", sentCount: state.sentCount + 1 }, text: state.snapshot, update: { kind: "removed" } }
    b = utf8Bytes(live)
    if state.sentCount + 1 > limits.maxCount || state.sentBytes + b > limits.maxBytes:
        return { state: { ...state, announced: POINTED }, text: state.snapshot, update: { kind: "pointer" } }
    return { state: { ...state, announced: live, sentCount: state.sentCount + 1, sentBytes: state.sentBytes + b },
             text: state.snapshot, update: { kind: "update", content: live } }

resolveAtSeed(state, liveThunk):
    s = (state.stale || state.snapshot === undefined) ? refresh(state, liveThunk()) : state
    return { state: s, text: s.snapshot ?? "" }
```

不变量：

- **I1** 某段折叠进开头的 `text` 只在刷新分支成功执行的那次解析后改变。
- **I2** 在每次 `before_agent_start` 返回后，有效视图（snapshot 被最近一条整块更新覆盖后的结果）== `live`；例外：`live` 为 SKIP、该段本轮 `skipIf` 为真、
  或该段处于指针态（`announced === POINTED`：模型已被明确告知该段过时及取得当前内容的途径，I9）。
- **I3** 同一段不会在两次上下文重写之间连续发出两条内容相同的整块更新。`forgetAnnounced` 之后**允许重复，代价已知**：压缩通常保留最后一个用户轮附近的更新消息
  （`pc87:agent-session.js:2220` 的 `firstKeptEntryId`），此时重发的是与上下文里已有消息相同的块——这是**常态**而非例外（review-3 #15，D3），总量受 I9 约束；更省的做法列为 E7。
- **I4** `SKIP` 永不推进状态：不落快照、不改 `announced`、不清 `stale`、不动计数。
- **I5** hub 永远不会因为自身错误使某段从「已有快照」变为缺席（§4.5 末段）；只有本会话从未成功过时才允许缺席。
- **I6**（G1）有捕获时，唤醒轮每个请求的开头文本 === `captured`，且 `captured` === 最近一个用户 run 中我方生产的强制文本（或首唤醒播种的结果；`adoptForeign` 开启时可为 R5a 采纳的最终文本）。
- **I7**（review-2 #10）provider **同步、无异步 IO 等待、有界**；返回 thenable ⇒ 视为 `SKIP` 并记一次日志。`context_with_system` 处理器只做内存操作，
  例外仅两处且都限定在**每个 run 的第一个请求**：R5a 检测与首唤醒播种各调一次 `ctx.getSystemPrompt()`（播种另调 provider）；处理器**从不写会话条目**。
- **I8** 我们从不构造 pi 自己不会构造的开头形态：`buildReplayMessages(messages, t)` 的输出 == pi 强制投影在 `forceSystemPrompt = t` 时的输出（review-3 已核：且幂等）。
- **I9**（U8）自最近一次刷新以来，每段发出的整块更新（`update` + `removed`）≤ `UPDATE_LIMITS.maxCount`（3）条且 `update` 内容累计 ≤ `UPDATE_LIMITS.maxBytes`（32KB）；
  超限后改发**指针式**消息，且在下一次刷新或 `forgetAnnounced` 之前至多一条。单条内容本身 > 32KB（记忆 `byteCap` 上限 65536）⇒ 直接发指针。
  计数随会话条目持久化（§4.9），`/reload` 不清零。

### 4.2 `src/prompt-sections/fold.ts`（纯函数）

```ts
/**
 * 按顺序对每个非空 text 执行 `prompt + "\n\n" + text`；全空 ⇒ 返回值 === 入参 prompt（hub 据此不返回 systemPrompt）。
 * 与 appendAgentTypesToSystemPrompt / appendAvailableModelsToSystemPrompt / 旧记忆 hook 的串联输出逐字节相同（回归 oracle，§7.3）。
 * 不含去重逻辑：记忆的横幅/哨兵去重在 hub 层以 skipIf 判定（§4.5），判定对象是 event.systemPrompt（记忆是第一段，与今天等价）。
 * 不对 prompt === "" 做短路：那会破坏与现有 append* 的 oracle 等价；「空 base 不得播种」的护栏放在 hub 播种分支（review-3 #4）。
 */
export function foldSections(prompt: string, texts: readonly string[]): string;
```

### 4.3 `src/prompt-sections/update-message.ts`（纯函数，只渲染）

```ts
export const SECTION_UPDATE_CUSTOM_TYPE = "subagent:prompt-section-update";

export function renderSectionUpdateMessage(
  updates: ReadonlyArray<{ section: SectionName; title: string; pointerHint?: string } & SectionUpdate>,
): {
  customType: typeof SECTION_UPDATE_CUSTOM_TYPE;
  content: string;
  display: false;
  details: { v: 1; updates: Array<{ section: SectionName; kind: SectionUpdate["kind"] }> };
};
```

正文（英文，每段一块）。开头里没有 XML 标签，所以按**标题行前缀**引用（§2；review-3 #11：记忆段实际标题行是 `## Memory (<slug>) — N file(s)`，
`title` 只是它的稳定前缀，所以措辞必须是「beginning with」），新块用一对标记包住以界定范围：

```
[pi-toolkit] System prompt section update. The block below REPLACES the section of your system prompt headed by the line beginning with
"## Available subagent types (pi-subagent)" and any earlier update of it; treat it as authoritative until a newer update appears.
<pi_section_update name="pi_subagent_types">
## Available subagent types (pi-subagent)
…完整的新内容…
</pi_section_update>
```

`removed`：`… The section of your system prompt headed by the line beginning with "<title>" no longer applies; ignore it and any earlier update of it.`

`pointer`（I9 超限）：
`… The section of your system prompt headed by the line beginning with "<title>" has changed again; further full copies are withheld to bound context size.
Treat that section and its earlier updates as possibly outdated. <pointerHint> It will be rewritten in your system prompt at a later refresh point.`

- `title` 由各段 registration 提供（§4.5）：类型 / 模型为完整标题行；记忆为 `## Memory (<slug>)`。**约束**：`title` 必须是该段格式化输出首行的前缀（单测守护）。
- `pointerHint` 由 registration 提供（可选）：记忆 = `Use the memory tool (action: 'list') to read the current entries.`（`src/memory/tool.ts:72`）；
  类型 = `The Agent tool rejects an unknown subagent_type with the current list of valid types.`（`src/service/spawn-service.ts:293-294`）；模型不提供（无读取工具）。
- 发完整新块，不发差量；`display: false`，不注册 renderer；v1 的 `parseSectionUpdate` / `hash` / `resync` 保持删除（E4）。

### 4.4 `src/prompt-sections/wake-replay.ts`（纯）

```ts
/** 最小结构类型：不 import pi。 */
export type MessageLike = { role: string } & Record<string, unknown>;
export type GetCurrentSystemMessage = (
  messages: readonly MessageLike[],
) => { toolsAdded?: unknown[]; timestamp?: number } | undefined;

/** 与 pc87:agent-session.js:1049-1058 同构：[{role:"system", content: forced, toolsAdded?, timestamp}, ...非 system 消息]。不改入参。 */
export function buildReplayMessages(
  messages: readonly MessageLike[],
  forced: string,
  getCurrentSystemMessage: GetCurrentSystemMessage,
  now?: () => number, // 缺省 Date.now；timestamp 取 current?.timestamp ?? now()，与 pi 一致
): MessageLike[];

export interface WakeReplay {
  /** undefined ⇒ 清空 */
  capture(forced: string | undefined): void;
  captured(): string | undefined;
  /** 无捕获或 helpers 不可用 ⇒ undefined（不改请求） */
  apply(messages: readonly MessageLike[]): MessageLike[] | undefined;
  reset(): void;
}
export function createWakeReplay(deps: { getCurrentSystemMessage: GetCurrentSystemMessage | undefined }): WakeReplay;
```

`captured` **不持久化**（§4.9）：它含 pi 的整个 base（AGENTS.md ~13KB + skills），且 `/reload` 后可由读回的快照 + 首唤醒播种构造性重建。

### 4.5 `src/prompt-sections/hub.ts`（面向 pi）

```ts
export type SectionName = "pi_project_memory" | "pi_subagent_types" | "pi_subagent_models";
export type SystemPromptMode = "stable" | "legacy";

export interface SectionProviderInput {
  ctx: ExtensionContext;
  /** 用户轮 = event.systemPrompt；首唤醒播种 = ctx.getSystemPrompt() */
  promptText: string;
  /** 用户轮 = event.systemPromptOptions?.cwd；播种时 undefined */
  optionsCwd?: string;
}
/** 必须同步（I7）；可抛错（hub 统一兜底为 SKIP）。返回 "" = 此刻无内容。 */
export type SectionProvider = (input: SectionProviderInput) => Live;

export interface SectionRegistration {
  provider: SectionProvider;
  /** 更新消息里引用该段用的标题；必须是格式化输出首行的前缀（§4.3） */
  title: string | ((input: SectionProviderInput) => string);
  /** 指针式消息里告诉模型如何取得当前内容（§4.3，可选） */
  pointerHint?: string;
  /** 为真 ⇒ 该段本轮完全惰性：不调 provider、不折叠、不改状态、不发更新（记忆横幅/哨兵去重，inject.ts:81） */
  skipIf?: (input: SectionProviderInput) => boolean;
}

export interface PromptSectionHubOpts {
  /** 设置值；只在 before_agent_start 读取（§3.2） */
  mode: () => SystemPromptMode;
  /** activate 时的设置快照（§3.2）：false ⇒ 不注册 context_with_system */
  wakeReplay: boolean;
  /** activate 时的设置快照（§3.2，U7） */
  adoptForeignForcedPrompt: boolean;
  log?: (msg: string) => void; // 默认 console.warn，前缀 "[pi-subagent]"
}

export interface PromptSectionHub {
  /** activate 期间调用；重复注册同名 ⇒ 抛错（编程错误，单测守护）。注册顺序 = 折叠顺序 */
  register(name: SectionName, reg: SectionRegistration): void;
  /** 仅测试 */
  _state(name: SectionName): SectionState | undefined;
}

export function createPromptSectionHub(pi: ExtensionAPI, opts: PromptSectionHubOpts): PromptSectionHub;
```

**hub 闭包状态**：`states: Map<SectionName, SectionState>`、`replay: WakeReplay`、`userTurnSeen: boolean`、`prefixFresh: boolean`、
`firstRequestPending: boolean`、`lastPersisted: string | undefined`（上次写入 / 读回的序列化串）、`warnedPersist: boolean`。全部在 activate 闭包内，无模块级可变状态。

**钩子（每 activate 注册一次；主会话与子会话相同，review-2 #8）**：

| 钩子                  | 行为                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_agent_start`  | 见下方 `onBeforeAgentStart`                                                                                                                                                                                                                                          |
| `context_with_system` | **仅 `wakeReplay === true` 时注册**（U5），经 `pi-compat.onContextWithSystem`。见下方 `onContextWithSystem`                                                                                                                                                          |
| `session_start`       | `states = readBackSectionStates(getBranch(), event.reason, 已注册段名)`（§4.9；`undefined` ⇒ 全部 `initialSectionState()`）；`lastPersisted = 读回条目的序列化串 ?? undefined`；`replay.reset()`；`userTurnSeen = prefixFresh = false`；`firstRequestPending = true` |
| `session_compact`     | 所有段 `forgetAnnounced`；`prefixFresh = true`（**不写条目**：读回时由「最后一条我方条目之后出现过 compaction 条目」推导，§4.9）                                                                                                                                     |
| `model_select`        | **只** `prefixFresh = true`，不 `forgetAnnounced`（review-3 #12：换模型不重写对话，更新消息仍在上下文里）                                                                                                                                                            |
| `session_tree`        | 从新分支读回（`reason = "tree"`，§4.9），读回结果或（分支上无条目时）内存态一律 `forgetAnnounced`；**不**刷新快照（切回仍存活的旧分支时刷新会打掉活缓存，review-2 #4）                                                                                               |
| `turn_start`          | `prefixFresh = false`（F17：每个请求之前必发、不可跳过 ⇒ 此后开头已按旧快照重新写入缓存，再刷新就不免费；取代 v3 的 `turn_end`，review-3 #9）                                                                                                                        |
| `agent_settled`       | `firstRequestPending = true`（下一个请求是下一个 run 的第一个请求；F9：settled 在 `_runAgentPrompt` 的 `finally`，覆盖 run 内的 `agent.continue()`）                                                                                                                 |

**`onBeforeAgentStart(event, ctx)`**：

```
userTurnSeen = true
if prefixFresh: 所有段 markStale; prefixFresh = false         // F12①（本 run 之前的压缩 / 换模型）后首个请求本来就整段重写
input = { ctx, promptText: event.systemPrompt, optionsCwd: event.systemPromptOptions?.cwd }
texts = []; updates = []
for (name, reg) of 注册表（注册顺序）:
    try:
        if reg.skipIf?.(input): continue
        live = callProvider(reg, input)                         // 抛错 / thenable ⇒ SKIP（I7）
        if mode() === "legacy": texts.push(live === SKIP ? "" : live); continue
        r = resolveAtTurn(states[name], live); states[name] = r.state; texts.push(r.text)
        if r.update: updates.push({ section: name, title: titleOf(reg, input), pointerHint: reg.pointerHint, ...r.update })
    catch: texts.push(mode() === "stable" ? (states[name].snapshot ?? "") : "")       // I5
sp = foldSections(event.systemPrompt, texts)
if opts.wakeReplay:
    // hub 是本扩展唯一改 systemPrompt 的 handler ⇒ event.systemPrompt 即「更早扩展的产出」（F8）
    replay.capture(sp !== event.systemPrompt ? sp                                   // 我方生产的字节（可能以更早扩展的强制文本为底，与今天用户轮相同）
                 : opts.adoptForeignForcedPrompt ? readForceSystemPrompt(event)     // U7：默认不捕获他人的强制文本（review-3 #3 (a) 路径）
                 : undefined)
if mode() === "stable": persist()                               // §4.9：序列化串 !== lastPersisted 才写；失败只 WARN 一次
message = updates.length > 0 ? try renderSectionUpdateMessage(updates) catch undefined   // 渲染失败只丢消息，不丢开头
return 组装 { systemPrompt: sp（仅当 sp !== event.systemPrompt）, message（仅当存在）}，两者皆无 ⇒ undefined
```

**`onContextWithSystem(event, ctx)`**（仅 `wakeReplay`；整体 try/catch，异常 ⇒ `undefined`）：

```
first = firstRequestPending; firstRequestPending = false
c = replay.captured()
if c !== undefined:
    if first:                                                   // R5a 检测只在每个 run 的第一个请求做（review-3 #14；F14：第三方强制文本 run 内冻结，一次就够）
        cur = try ctx.getSystemPrompt() catch undefined         // ctx 失效时 assertActive 会抛
        if cur !== undefined && cur !== c && cur.startsWith(c): // R5a：更晚的 handler 在我们之后追加了强制文本（F6：强制 run 中 cur = 最终强制文本）
            log("R5a …")                                        // 每个 run 至多一次（检测本身每 run 一次）
            if opts.adoptForeignForcedPrompt: replay.capture(cur)
    return replay.apply(event.messages)
if first && !userTurnSeen && 注册表非空:                          // 首唤醒播种（§3.5 边界 1），只在本 run 第一个请求（review-3 #5）
    cur = try ctx.getSystemPrompt() catch undefined
    if cur === undefined || cur === "": return undefined        // review-3 #4：F19 的未绑定默认值 "" 会产出丢掉整个 base 的灾难开头
    texts = 同上循环，但 input = { ctx, promptText: cur }、stable 用 resolveAtSeed、legacy 用 live、不收集 update
    seeded = foldSections(cur, texts)
    if seeded !== cur: replay.capture(seeded); return replay.apply(event.messages)
return undefined
```

要点：

- **强制 run 与唤醒 run 不需要区分**：强制 run 中 `captured` 就是本 run 我方的强制文本（F15），回放结果被 pi 的强制投影以同一文本覆盖（F5），且幂等（review-3 结论 1）；
  v2 的 `pendingCapture` / 锁存 / 模式交接因此都不需要。
- **R5a 判据为何不会误伤唤醒 run**：唤醒 run 中 `cur` = pi 的 base 渲染，不以 `captured`（= base + 三段）为前缀；base 若变化，也只会在其自身 section 处变化，
  不会恰好长出我们的整段文本。
- **首唤醒播种的等价性（构造性，review-3 #5）**：播种结果与随后第一个用户轮的折叠逐字节相同，前提是：
  **P1** `bindCore` 已跑过——`cur !== ""` 护栏保证（F19），否则不播种；
  **P2** 播种发生在唤醒 run 的**第一个**请求——`firstRequestPending` 保证；此时 `_runSystemPromptOptions === undefined`，`cur` 渲染 `_baseSystemPromptOptions`（F18），
  与下一个用户轮 `event.systemPrompt` 渲染的是同一个 options 对象（`pc87:runner.js:1016-1033`）；第 2 个请求起 options 带 `getActiveToolNames()`，可能与 base 不同，故不播种；
  **P3** 快照在播种时已刷新、用户轮不再刷新（`stale` 已清）；
  **P4** 没有更早加载的扩展返回 `{ systemPrompt }`（否则用户轮的 `event.systemPrompt` 是其强制文本而非 base）。
  P4 不成立、或 pi 自身 base 在两者之间变化（`setActiveTools` / reload 资源）⇒ 开头变一次——那是 pi / 第三方的变化，登记为 R11。
- **全程 try/catch，永不抛**。provider 抛错 ⇒ `SKIP`；单段 resolve 异常 ⇒ 该段用现有快照（I5）；渲染更新消息失败 ⇒ 只丢消息；写条目失败 ⇒ 只 WARN（§4.9）。
- 子会话钩子集合与主会话相同：所有失效钩子都是 O(1) 状态翻转，子会话同样会轮中压缩（`pc87:agent-session.js:2152-2231`）、同样能换模型；
  按会话类型分支反而多一处逻辑。子会话只注册记忆段；`injectInChildSessions` 为 false 时 provider 返回 `""`。`wakeReplay` 开关对子会话同样生效（review-3 不变量检查）。

### 4.6 各段调用方契约

**`src/prompt-sections/core-sections.ts`**（新增）

```ts
export function agentTypesSection(deps: {
  types: { list(): readonly AgentTypeConfig[] };
  foregroundAutoBackgroundMs: number;
}): SectionRegistration; // title: "## Available subagent types (pi-subagent)"；pointerHint: 见 §4.3
export function availableModelsSection(deps: {
  stackModels: () => (() => readonly AvailableModelEntry[]) | undefined;
}): SectionRegistration; // title: "## Available models (pi-subagent)"；无 pointerHint
```

provider 分别调用 `formatAgentTypesForPrompt` / `formatAvailableModelsForPrompt(resolvePromptModels(ctx.scopedModels, stackModels(), ctx.modelRegistry))`。
标题字符串与格式化函数里的标题行同源（导出常量，单测守护二者一致）。

**`src/config/available-models.ts`**：新增 `resolvePromptModels(scoped, stackAvailable, registry): AvailableModelEntry[]`，优先级不变（scoped → stack port → registry），
`ctx.scopedModels` 抛错视为空。理由是收敛来源（把 `src/index.ts:397-411` 的内联优先级逻辑移出装配层，I7）。`appendAvailableModelsToSystemPrompt` **保留**作 oracle。

**`src/config/agent-types.ts`**：`appendAgentTypesToSystemPrompt` 保留作 oracle。

**`src/memory/inject.ts`**：从 handler 改为 registration 工厂：

```ts
export function memorySection(deps: MemoryInjectDeps): SectionRegistration;
// provider：子会话且 !injectInChildSessions ⇒ ""；
//           rawCwd = input.optionsCwd ?? tryCtxCwd(input.ctx) ?? process.cwd()   // 三级回退保留（review-2 #12）：
//                    ctx.cwd 是带 assertActive() 的 getter（pc87:runner.js:565-568），runner 失效时会抛，此时回落 process.cwd()
//           cwd = resolveWorktreeOrigin(rawCwd) ?? rawCwd；冻结块 ?? 缓存/渲染块 ?? ""
// title：`## Memory (${slug})`（是 render.ts:154 首行 `## Memory (<slug>) — N file(s)` 的前缀）
// pointerHint：见 §4.3
// skipIf：input.promptText 已含本 slug 的 injectionSentinel 或原插件横幅 `## Memory (<slug>)`（与 inject.ts:81 相同）
```

`freezeInjectionAfterWrite` 语义保留：为 true 时 provider 返回冻结块 ⇒ stable 下写入后不发更新消息。

**`src/memory/index.ts`**：`WireMemoryOpts` 增加 `sections: PromptSectionHub`；`wireMemory` 改为 `sections.register("pi_project_memory", memorySection(...))`，不再自己注册 `before_agent_start`。

**`src/index.ts`**（仍只做装配）：

- S1：pre-guard（`:125` 之前）`const s1 = wireWakeReplay(pi, { enabled: preGuardSettings.systemPrompt.wakeReplay && !isChildSession })`；post-guard（`:414` 之后）`s1.registerCapture()`。
- M2：pre-guard 无条件创建 hub（`wakeReplay` / `adoptForeignForcedPrompt` 取 `preGuardSettings.systemPrompt`，`mode` 为 getter），记忆开启时传给 `wireMemory`；
  post-guard 以 `hub.register("pi_subagent_types", …)`、`hub.register("pi_subagent_models", …)` 替换 `:394-414` 的 handler；删除 S1 的两处接线与 `s1-wiring.ts`。

**`src/config/settings.ts`**：新增 `systemPrompt: { mode: "stable" | "legacy"; wakeReplay: boolean; adoptForeignForcedPrompt: boolean }`，默认 `{ "stable", true, false }`；
非法值逐键回落默认（沿用 `cacheTtl.mode` 的解析约定，`settings.ts:330,440,685,756`）。S1 只引入 `wakeReplay`，M2 补另两键。`src/ui/` 设置编辑器加三行（P2，可选）。

### 4.7 `src/adapters/pi-compat.ts` 新增（唯一接触 0.87 新 API 的地方）

```ts
/** 窄类型包装：pi.on("context_with_system", …)。<0.87 上注册成功但永不分发（pc84:…/loader.js:233-238 接受任意事件名）。 */
export function onContextWithSystem(
  pi: ExtensionAPI,
  handler: (
    event: { messages: MessageLike[] },
    ctx: ExtensionContext,
  ) => { messages: MessageLike[] } | undefined | Promise<{ messages: MessageLike[] } | undefined>,
): void;

/** event.systemPromptOptions?.forceSystemPrompt 的窄读取；非 string ⇒ undefined。 */
export function readForceSystemPrompt(event: unknown): string | undefined;

/** 命名空间导入 pi-ai 后探测 getCurrentSystemMessage；缺失 ⇒ undefined。 */
export function getTranscriptHelpers(): { getCurrentSystemMessage: GetCurrentSystemMessage } | undefined;
```

`getTranscriptHelpers` 的实现（review-2 #13）：`import * as piAi from "@earendil-works/pi-ai"` 在运行期不会因缺名导致链接失败，但在 0.84.4 的**类型**下
`piAi.getCurrentSystemMessage` 是 TS2339，`typeof` 救不了。D 包升 devDeps 0.87.1 后类型上已存在，但 S1 可能先于 D 合并，窄化保留且只在此处出现：

```ts
const ns = piAi as unknown as { getCurrentSystemMessage?: GetCurrentSystemMessage };
return typeof ns.getCurrentSystemMessage === "function"
  ? { getCurrentSystemMessage: ns.getCurrentSystemMessage }
  : undefined;
```

假设登记（R1）写进该文件的注释表，与现有 `/goal` 假设同格式。

### 4.8 错误约定

| 情况                                                | 行为                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| provider 抛错 / 返回 thenable / 注册表未就绪        | `SKIP`：状态不推进（I4），折叠现有快照（I5）；首次即失败 ⇒ 本次缺席、`stale` 保留、下个用户轮重试；thenable 额外记一次日志（I7）                             |
| hub 内部异常                                        | 见 §4.5 末段；永不抛出到 pi                                                                                                                                  |
| pi-ai `getCurrentSystemMessage` 不可用              | 不回放（退回今天的唤醒行为）                                                                                                                                 |
| `ctx.getSystemPrompt()` 返回 `""`（未 `bindCore`）  | 不播种（review-3 #4）                                                                                                                                        |
| 更早加载的扩展返回 `{ systemPrompt }`，我方三段非空 | `event.systemPrompt` 已是其强制文本（F8），我们折叠在其后，与今天相同；`captured` 含它（我方在其上生产的字节）                                               |
| 更早加载的扩展返回 `{ systemPrompt }`，我方三段全空 | `adoptForeign = false`（默认）⇒ 不捕获，唤醒轮 = 今天；`true` ⇒ 捕获其文本（review-3 #3 (a)）                                                                |
| 更晚加载的扩展**追加**强制文本（R5a）               | 用户轮保留我们的三段；每个 run 第一个请求检测到时 WARN（每 run 至多一次）；`adoptForeign = false` ⇒ 唤醒轮回放不含其追加（R14）；`true` ⇒ 改为回放其最终文本 |
| 更晚加载的扩展**整块替换**强制文本（R5b）           | pi 语义「最后一个强制者获胜」：用户轮丢我们的三段——与今天完全相同，不是本方案引入；唤醒轮回放我们的文本 ⇒ 两类 run 不一致。已论证风险（D10）                 |
| `session_tree` 后上下文缺少更新消息                 | 读回 + `forgetAnnounced`，下一个用户轮自动补发（review-2 #4）                                                                                                |
| 会话条目写入失败                                    | WARN 一次（`warnedPersist`），内存态照常生效，下次状态变化再写（goal 先例 `src/goal/store.ts:26-35`）                                                        |
| 会话条目读不到 / 校验失败 / `reason === "new"`      | 全新快照 ⇒ 下一个用户轮（或首唤醒播种）刷新一次；若恰逢 `/reload` 则付一次整前缀重写（= v3 行为，U6 退化上界）                                               |

### 4.9 `src/prompt-sections/store.ts`：快照持久化（U6，review-3 #2）

**条目格式**（`pi.appendEntry(customType, data)`；`CustomEntry` 不进 LLM 上下文，F20）：

```ts
export const PROMPT_SECTIONS_ENTRY_TYPE = "subagent:prompt-sections"; // 沿用 subagent:* 约定（AGENTS.md：运行期标识符保留旧名）

export interface PersistedSectionV1 {
  snapshot: string;
  /** 省略 ⇒ === snapshot */
  announced?: string;
  /** true ⇒ announced 为 POINTED（此时 announced 字段省略） */
  pointer?: true;
  /** 省略 ⇒ false */
  stale?: true;
  sentCount: number;
  sentBytes: number;
}
export interface PromptSectionsEntryV1 {
  v: 1;
  /** 只写 snapshot !== undefined 的段 */
  sections: Partial<Record<SectionName, PersistedSectionV1>>;
}

export function serializeSectionStates(states: ReadonlyMap<SectionName, SectionState>): PromptSectionsEntryV1;
/** 结构校验：v !== 1 ⇒ undefined；单段非法（snapshot 非 string、计数非有限非负整数）⇒ 丢该段，其余保留；未知段名忽略。never throws。 */
export function sanitizePromptSectionsEntry(raw: unknown): PromptSectionsEntryV1 | undefined;

export type ReadBackReason = "startup" | "reload" | "new" | "resume" | "fork" | "tree";
/**
 * 从 `sessionManager.getBranch()` 的条目数组倒序找最后一条 PROMPT_SECTIONS_ENTRY_TYPE（与 src/goal/store.ts:47-65 同口径）。
 * - reason === "new" ⇒ undefined（不继承）
 * - 找不到 / 校验失败 ⇒ undefined
 * - 只恢复 `registered` 中的段；registered 中但条目缺的段 ⇒ initialSectionState()
 * - exact = reason === "reload" && 该条目之后的分支上没有 type === "compaction" 的条目
 * never throws。
 */
export function readBackSectionStates(
  branch: readonly unknown[],
  reason: ReadBackReason,
  registered: readonly SectionName[],
): { states: Map<SectionName, SectionState>; exact: boolean; serialized: string } | undefined;
```

**写**（hub 唯一写点）：`onBeforeAgentStart` 末尾、`mode === "stable"` 时调用 `persist()`——
`s = JSON.stringify(serializeSectionStates(states))`；`s === lastPersisted` ⇒ 不写；否则 `try pi.appendEntry(TYPE, data); lastPersisted = s` / `catch` WARN 一次。

- 只在用户轮 handler 里写：不在 `context_with_system` 写（I7：请求路径只做内存操作），不在 `session_compact` 写（run 中途推进叶子没有必要，读回时可推导），
  不在 `session_tree` 写（下一个用户轮自然会写）。首唤醒播种产生的状态随下一个用户轮写入。
- 写入频率 = 状态真实变化的用户轮（刷新 / 整块更新 / 指针 / 读回后的 `forgetAnnounced`），一个会话通常个位数次；单条 ≈ 2 × 三段之和（默认 10–30KB）。
- 写在 `before_agent_start` 内 ⇒ 条目位于本轮用户消息**之前**（F20：推进叶子，用户消息成为其子节点）；与 `claude-code-todo-state` 在工具执行中写条目同属常规用法。

**读**（hub 两个读点）：

| 时机            | reason                        | 读回后                                                                                                                                                       |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_start` | `reload`                      | `exact` ⇒ 原样恢复（`/reload` 在 run 之间发生，叶子在末尾，条目与其后的更新消息都在分支上）；否则（其后有压缩）⇒ `forgetAnnounced`                           |
| `session_start` | `startup` / `resume` / `fork` | 恢复 + `forgetAnnounced`：叶子可能落在「我方条目」与「本轮更新消息」之间（fork 的切点是用户消息；崩溃窗口），重发至多一条 / 段，受 I9 约束                   |
| `session_start` | `new`                         | 不继承                                                                                                                                                       |
| `session_tree`  | `tree`                        | 恢复新分支上的快照 + `forgetAnnounced`（理由同 fork：导航目标通常是用户消息，叶子落在其父节点——正是我方条目）；分支上无条目 ⇒ 保留内存态 + `forgetAnnounced` |

- **为什么走 `getBranch()` 而不是 `getEntries()`**：`getEntries()` 含 fork / tree 导航留下的废弃分支，最后一条可能来自另一条分支，读回它会把那条分支的快照「复活」到当前分支，
  开头随之变成当前缓存链上从未出现过的字节。与 goal 的 MAJ-5（`docs/dev/goal/goal-plan.md:311`、`src/goal/store.ts:6-7`）同一口径。
- `prefixFresh` **不持久化**：它的清除发生在请求路径（`turn_start`），写入会破坏「请求路径不写条目」；丢失的后果是 `/reload` 恰在「压缩后、首个请求前」时少一次免费刷新，
  退化为尾部更新消息，不产生额外重写。
- `captured` **不持久化**（§4.4）：`/reload` 后第一个唤醒轮由首唤醒播种以读回的快照重建（P1–P4 成立时与 reload 前逐字节相同），第一个用户轮以读回的快照折叠。
- `legacy` 模式不写条目（D7 回滚等价性要求），但仍读回：从 legacy 切回 stable 后读到的是较早的 stable 条目，开头可能变一次——模式切换是有意操作，可接受。
- 退化：读不到 ⇒ 全新快照 ⇒ 一次刷新（= v3 行为）；写失败 ⇒ 内存态继续，`/reload` 后退化为读到更早的条目或全新快照。

---

## 5. 关键决策

### D1 选型：简路线（冻结快照折叠 + 尾部更新 + 唤醒回放），否决 v2 的请求时投影（review-2 阻塞 #1）

v2 以「`{systemPrompt}` 是 run 级、唤醒轮拿不到」否决折叠路线，而 S1 正是解决这一点的——该理由不成立。下面把两条路线逐目标对照。

| 目标                    | v2 投影路线                                                                                                                                                                               | v3 简路线                                                                                                                                                                                                                                                                         | 判定                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **G1** 用户 / 唤醒一致  | 每请求注入同一快照（v2 I6）；覆盖首个用户轮前的唤醒                                                                                                                                       | 有捕获：回放用户 run 的强制文本，由 F15 逐字节相同（I6）；首个用户轮前：首唤醒播种（§4.5）。残余：第三方整块替换（R5b）——投影路线在同一情形下是 R5「用户轮静默丢三段」，更糟                                                                                                      | 持平（简路线残余更小） |
| **G2** 刷新点间字节不变 | 快照注入为 section 键；capable 路由下若 `messages[0]` 非 system 触发合成头：系统提示只剩三段、`initialTools = []`（review-2 #2(b)，`ai87:anthropic-messages.js:790-800`），靠修补分支规避 | 快照折叠进强制文本；开头形态 = pi 自己的强制投影（I8），在任何路由、任何 transcript 形态下与 pi 强制 run 相同；开头字节形态与今天相同 ⇒ 部署时、每进程都没有形态切换                                                                                                              | **简路线胜**           |
| **G3** 变化以尾部告知   | 用户轮 `before_agent_start` 返回 `{ message }`                                                                                                                                            | 完全相同（同一 handler 同时返回 `systemPrompt` 与 `message`，F7）                                                                                                                                                                                                                 | 持平                   |
| **G4** 只在免费时机刷新 | `stale` ⇒ 下一个请求（任何 run 类型）刷新，永远免费                                                                                                                                       | 强制文本 run 内冻结（F14），只能在 `before_agent_start` 刷新：压缩 / 换模型后若尚无请求（F12①、空闲时手动 /compact）⇒ 刷新免费；若之间已有请求（F12②③、中间插了唤醒轮）⇒ 不刷新，只 `forgetAnnounced`，由尾部消息补发。**两者都不产生额外重写**；差别只在开头快照的新鲜度，不在钱 | 投影路线略优（非成本） |
| **G5** 低版本不丢内容   | 需要观测锁存：未锁存 ⇒ 退化 legacy；≥0.87 每进程第一个用户轮 legacy、之后切 section 形态 ⇒ **每进程一次必然的整前缀重写**（v2 R6）                                                        | 用户轮路径在所有版本相同，无锁存；`context_with_system` 不分发时回放惰性，唤醒轮 = 今天                                                                                                                                                                                           | **简路线胜**           |

投影路线唯一不可替代的优势（review-2 #1 已指出）：强制 run 内 pi 自身的 section 冻结（F14），投影模式下 pi 的那一半在 run 内是实时的。评估其价值：

- 这是**今天已有**的行为，不是简路线引入的退化；
- 冻结只影响 pi 的 `tools` 说明文字，真正的工具声明 `toolsAdded` 每请求取当前值（`pc87:agent-session.js:1051-1055`），模型能调用的工具始终正确；
- run 内工具切换在本仓库只出现在子会话的 tool-scope（`src/runtime/tool-scope.ts:120`，turn_end 边界），主会话 `ask_user` 的 `setActiveTools`（`src/ask-user/index.ts:33`）在激活期；
- 反过来看缓存：投影模式下 run 内 pi 一改 section 就追加补丁，非 capable 路由折叠回开头 ⇒ run 内整前缀重写；冻结恰好避免了这次重写。
  ⇒ 用一整层机制换「run 内一段说明文字的新鲜度」，不划算。

投影路线**独有**的问题（简路线里结构上不存在）：review-2 #2 合成头（capable 路由引信）、#3 / R5 后加载扩展静默覆盖、#6 锁存与 LegacyReplay 交接、#11 `globalThis` 锁存污染 vitest、
v2 R6 每进程形态切换、v2 R8 token 估算（F16 已证其本就不成立）、以及每个 stale 请求都在请求路径上调 provider（#10 的零挂死面更大）。

规模对照：简路线删除 `projection.ts`、锁存访问器与测试 reset、`live` 模式、`resolve*AtRequest` 四个函数、`describe()`；hub 从「三模式 × 两钩子」变为「二模式 × 一个折叠循环」。
v3.1 新增的都是评审指出的**缺失**机制而非扩展：`prefixFresh` / `firstRequestPending` 两个布尔、首唤醒播种一个分支、R5a 一个前缀判据、`store.ts` 一个写点两个读点、I9 两个计数。

**被否决的备选（全表）**

| 备选                                                              | 否决理由                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 请求时投影（`context_with_system` 注入 section）               | 见上表：G1/G3 持平、G2/G5 更差、G4 的优势不涉及成本；独有问题一整类。保留为 E5（hub 接口不变，可作内部演进）                                                         |
| 写 `systemPromptOptions.sections`（v1）                           | 只在 `before_agent_start` 可写；唤醒轮 `prepareNextTurn` 用不含我们键的 base options diff，生成 `null` 删除补丁并持久化（F3），用户轮再加回——新增震荡                |
| 通知改 `deliverAs: "nextTurn"`                                    | 改变投递语义：空闲主会话不再被子 agent / bash job 完成唤醒，违背通知子系统的存在理由                                                                                 |
| 持久改写 base options                                             | 无公开接口（F11）                                                                                                                                                    |
| `before_provider_request` 改写载荷                                | 载荷按 provider 格式各异；pi 的 cache warmer 捕获的是 context 而非载荷（`pc87:sdk.js:233-241`），会与实际请求分叉；cache-ttl 已占用该钩子                            |
| 唤醒轮每请求重算 `fold(ctx.getSystemPrompt(), 快照)` 而非回放捕获 | 需要在每个唤醒请求区分「强制 run / 唤醒 run」，且把 provider 调用带回请求路径；回放捕获由 F15 天然逐字节一致。只在无捕获的唯一窗口（首个用户轮前）用它（首唤醒播种） |
| 上游 issue：让 `_runAgentPrompt` 也 emit `before_agent_start`     | 值得提（E6），但不能阻塞                                                                                                                                             |

### D2 快照 + 尾部消息仍然必要

F4：非 capable 路由把 system 补丁折叠回开头，当前目录无 capable 模型；强制文本本身也只能整块替换。所以「刷新点之间开头不变」只能靠快照；
变化只能走普通对话消息（custom → user 角色，任何 provider 都原地发送）。

### D3 更新消息：用户轮 `before_agent_start` 返回 `{ message }`；唤醒轮不投递（U4）

拉模式、天然防抖、与快照决策同一 handler。**已知取舍**（U4 已拍板）：唤醒轮不会收到新更新；变化推迟到下一个用户轮。多数变化是模型自己造成的（写记忆、改 agent `.md`），模型本来就知道。
压缩之后：`forgetAnnounced` 保证被摘要掉的更新会在下一个用户轮重发（或随免费刷新直接进入开头）。**重发是常态**（review-3 #15）：压缩常保留最近的更新消息，
此时重发与上下文里已有的块重复；代价已知且受 I9 约束（D12）。按 `firstKeptEntryId` 判断「更新消息仍在保留区」即不忘记的优化列为 E7。

### D4 刷新点与失效处理（逐事件对照）

| 事件                                                                     | 本方案                                                                   | cache-ttl `invalidateBoth`（`src/cache-ttl/cache-ttl.ts:272-281`） | 说明                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`（`new`）                                                 | 全新状态（下一个用户轮或首唤醒播种时刷新）                               | —                                                                  | 新会话，缓存本来就冷                                                                                                                               |
| `session_start`（`reload` / `startup` / `resume` / `fork`）              | 从 `getBranch()` 读回快照（§4.9），**不刷新**                            | —                                                                  | `/reload` 不重写对话：base 字节不变时前缀仍热，刷新是纯亏（review-3 #2）；resume 可能冷也可能热（快速 `pi -c`），读回是安全侧，冷时的免费刷新列 E1 |
| `session_compact`                                                        | `forgetAnnounced` + `prefixFresh`；无请求先到的用户轮 ⇒ 刷新，否则只补发 | ✓                                                                  | 压缩后首个请求整段重写：刷新赶上它就免费，赶不上（run 内压缩 / 先来了唤醒轮）就不动开头                                                            |
| `model_select`                                                           | **只** `prefixFresh`                                                     | ✓                                                                  | 换缓存命名空间，下一个请求本来就整段重写；对话未重写 ⇒ 不 `forgetAnnounced`（review-3 #12）                                                        |
| `session_tree`                                                           | 从新分支读回 + `forgetAnnounced`，不刷新                                 | ✓                                                                  | 切回活分支时刷新会打掉活缓存；新分支可能没有那些更新消息（review-2 #4）                                                                            |
| `turn_start`                                                             | 清 `prefixFresh`                                                         | —                                                                  | F17：每个请求前必发、不可跳过；此后开头已按旧快照写入缓存                                                                                          |
| `agent_settled`                                                          | 置 `firstRequestPending`                                                 | —                                                                  | 标出下一个 run 的第一个请求（R5a / 播种）                                                                                                          |
| `thinking_level_select`                                                  | 不处理                                                                   | ✓                                                                  | 不影响 system 块缓存                                                                                                                               |
| `session_compact_failed` / `resources_discover` / `session_info_changed` | 不处理                                                                   | ✓                                                                  | 没有发生对话重写                                                                                                                                   |

**被否决**：

- 「压缩后一律在下一个用户轮刷新」（v2 语义搬过来）——run 内压缩时强制文本冻结（F14），压缩后的请求已按旧快照建好缓存，下一个用户轮再刷新是一次额外的
  「压缩后上下文」全量重写（量级取 3–4 万 token；按 field §5 的实际费率「14–42 万 token ≈ $0.7–2.1」约 $0.15–0.2 / 次，且只在该段内容恰好变化时发生）。「缓存已冷时顺便刷新」需读 cache-ttl 内部状态，列为 E1。
- 以 `turn_end` 清 `prefixFresh`（v3）——可被跳过（F17），`prefixFresh` 卡 true ⇒ 下一个用户轮非免费刷新（review-3 #9）。
- 以 `agent_settled` 清 `prefixFresh`——它晚于 run 尾的 ③ 号压缩（F9），会把 ③ 之后本该免费的刷新清掉。
- 以 `getContextUsage().tokens` 增长判断「已有请求」——压缩后回落窗口返回 `tokens: null`（F16），判据在最需要的时刻不可用。
- `session_start` 一律刷新（v3）——违反 G4，见 D11。

### D5 删除 resync

刷新分支已把真相写进开头；更新消息正文声明「until a newer update appears」；`forgetAnnounced` 覆盖了「上下文丢了更新消息」的情形。降级为 E4。

### D6 子会话：同一 hub、同一钩子集合

子会话 activate 在 guard 前创建自己的 hub，只注册记忆段；钩子集合与主会话相同（§4.5 末段理由）。相比 v2 按 review-2 #8 加入 `session_compact`，
并顺带统一 `model_select` / `session_tree`（省掉反而要多一处 `isChildSession` 分支）。子会话的 `customPrompt` 替换 preamble 与本方案无关——
我们只在 `event.systemPrompt` 末尾折叠，与今天相同。S1 阶段子会话不生效（§3.5 边界 4），M2 起生效。

### D7 回滚语义（review-3 #1 更正）

v3 写的「`legacy` = 今天的输出逐字节相同」只对用户轮成立：回放层在两种模式下都生效，而唤醒轮恰是本方案唯一真正改变字节的地方。v3.1 的回滚语义：

- **`wakeReplay = false` + `mode = legacy` = 今天，逐字节相同**：不注册 `context_with_system`；用户轮折叠实时内容（`foldSections` 以现有三个拼接函数的串联为 oracle，§7.3）；不写会话条目。
- 单独关回放（`wakeReplay = false`）即可在不 revert 的情况下撤掉「每次请求都运行、会丢弃非首条 system 消息」的那一层（§3.2 回滚矩阵）。
- `wakeReplay` 在 activate 时读取，改后 `/reload` 生效（与「不注册」语义一致）；`mode` 每个用户轮读取，run 内不变。

### D8 版本策略（U1 已拍板）

peer 三包 `>=0.87.0 <0.88.0`、devDeps `0.87.1`：唤醒回放依赖 0.87.0 的 `context_with_system`；用户实际运行 0.87.1，扩展今天已在声明范围外运行。
快照 + 更新消息不依赖任何新 API。上界 `<0.88.0` 保护 R1 的未文档化假设：升 0.88 必须重跑 §7.5 清单。0.84 不再是支持目标；G5 由静态断言 T-G5 守护（§7.3），不做真机 0.84 验收。

### D9 止血包先行（U2 已拍板）

S1 约 70 行 + 测试，与 M1 正交；自带 `wakeReplay` 开关（它是第一个上线、触及每一次请求的 PR）。主方案落地后由 hub 接管其钩子，回放逻辑不变。
它单独兑现 G1（跨类失效）与功能修复（主会话），主方案再兑现 G2 / G3 / G4 与子会话。

### D10 第三方强制文本（review-2 严重 #3 → review-3 #3，U7）

v2 的 R5 是投影层特有的：我们的投影在强制投影**之前**运行，被后加载扩展的强制文本整块覆盖，用户轮静默丢三段。简路线里我们仍在 handler 折叠链内，这一形态不存在。
剩下的是回放范围问题。review-3 #3 指出：第三方强制文本完全可以是 **run 级**内容（把本轮用户问题、时间、选中的 skill 摘要拼进 system prompt——`event.prompt` 就在事件上，
`src/feishu-notify/index.ts:504` 自己就在读它），把它回放到后续每个唤醒轮，是**静默**地把别人的 run 级内容变成会话级内容。因此（U7 = B，已按评审推荐采纳，用户保留推翻权）：

- **默认只回放我方生产的字节**：`captured` 仅在我方折叠改变了强制文本时设置（S1：`end !== chainStart`；M2：`sp !== event.systemPrompt`）。我方三段全空而更早扩展有强制文本 ⇒ 不捕获，唤醒轮 = 今天。
  我方三段非空时 `captured` 以更早扩展的强制文本为底——这与今天用户轮的字节相同，回放它不引入用户轮里没有的内容。
- **R5a 追加**（`return { systemPrompt: event.systemPrompt + extra }`）：每个 run 第一个请求若 `ctx.getSystemPrompt()` 以 `captured` 为严格前缀 ⇒ WARN（每 run 至多一次，review-3 建议）；
  `adoptForeignForcedPrompt = true` 时采纳其最终文本为新 `captured`（v3 的行为），默认不采纳 ⇒ 唤醒轮缺第三方追加的内容（R14，与今天唤醒轮相比只多不少）。
- **R5b 整块替换**：无法在请求时与唤醒 run 区分（两者 `cur` 都不含 `captured`），降级为**已论证风险**：
  ① 用户轮丢我们的三段是 pi 的「最后一个强制者获胜」语义，与今天相同，也同样吞掉所有其他扩展的 prompt 贡献，不是本方案引入；
  ② 唤醒轮相对今天只多了我们的三段、没有少任何东西；
  ③ 当前用户环境无此类扩展（review-2 复核）；AGENTS.md 与 `pi-compat.ts` 假设表注明。

### D11 快照持久化：会话条目（U6 已拍板，review-3 严重 #2）

`/reload` 重新 `activate()` ⇒ 闭包状态全新；而 `/reload` 本身不重写对话，base 字节不变时前缀仍热，v3 在此刷新是纯亏的整前缀重写，违反 G4。
这与项目记忆里 cache-ttl 的同类现场事故（熔断 / 预算不跨 `/reload`，一次 reload 白付约 $5，`docs/dev/cache-ttl-adaptive/field-2026-09-24.md`）同构。

| 方案                                                                      | 取舍                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B：`appendEntry` 会话条目（采纳，用户拍板）**                           | 跨 `/reload` **且**跨进程（快速 `pi -c` / resume 时前缀仍可能热）；天然按会话隔离，不需要 session id 键控与 FIFO 上限；fork / tree 语义由 `getBranch()` 给出（防废弃分支复活）。代价：一个持久化格式（`v: 1` + 校验）、会话文件增长（个位数条 × 10–30KB）、一个写点 |
| A：`Symbol.for` 全局（与 `src/core/worktree-origin.ts` 同构，评审原推荐） | 改动最小、无格式负担；但不跨进程，需按 session id 键控 + FIFO，fork / tree 需要另行推导                                                                                                                                                                             |
| C：不做                                                                   | 每次 `/reload` 付一次整前缀重写；须改写 G4 的字面承诺                                                                                                                                                                                                               |

`captured` 与 `prefixFresh` 不持久化（§4.9 理由）。

### D12 更新消息上界（U8 已拍板，review-3 #6）

更新消息发完整新块；记忆 `byteCap` 默认 4000（`src/config/settings.ts:507`，上限 65536）且是变化最频繁的一段。无上界时一个写 20 次记忆的长会话尾部堆 ~80KB，
且模型面前同时存在 20 个互相声称权威的版本（放大 R2）。I9：每段自上次刷新起 ≤3 条整块更新 / ≤32KB，超限后至多一条指针消息（直到刷新或 `forgetAnnounced`）。
上界是常量而非设置（简单优先；需要时再暴露）。**被否决**：B「超限强制下一个用户轮刷新开头」——那是一次非免费的整前缀重写，正是本方案要消除的东西；C「不设上界」。
（U8 = A，已按评审推荐采纳，用户保留推翻权。）

### D13 T-REAL 降级为手工验收 A 系列（review-3 #7）

v3 的 T-REAL（`createAgentSession` + faux provider + inline 加载 hub）有两个实测障碍：
① `CreateAgentSessionOptions` **没有 inline extension 入口**（`pc87:dist/core/sdk.d.ts:9-57`；`extensionsResult` 是返回值；`loadExtensionFromFactory` 不在包入口导出，`dist/index.d.ts:9`）；
② `prompt()` 有 auth 前置检查（`pc87:agent-session.js:1260-1275`），faux provider 需自造 `ModelRuntime` / models.json 才能过闸。
「加载真实扩展包的子进程验收」同样不划算：需要一个说 Anthropic 协议的本地 mock 服务器、在 print 模式下构造确定性的唤醒轮（`pi -p` 在 prompt settle 后退出），
成本与四个场景的收益不成比例。机制层的承重论断（I8 幂等、F15、F13/F17 时序、压缩请求不经回放）已由 review-3 逐条在源码上核实，并由单测 + `pi-compat.ts` 假设登记守护。
⇒ T-REAL 移出交付，验收改为可判定的手工步骤 A1 / A2（§7.3，给出具体命令与取数字段）。评审发现的进程内接缝（`DefaultResourceLoaderOptions.extensionFactories` +
唤醒轮不经 auth 闸）登记为 E8，若将来需要 CI 级回归再做。

---

## 6. 原任务七个问题的逐条回答（v3.1 更新）

1. **稳定快照**：每段在本会话第一次需要时取快照——第一个用户轮的 `before_agent_start`，或更早的唤醒轮（首唤醒播种）；快照写进会话条目，`/reload` / resume / fork 后从当前分支读回。刷新时机见 D4。
2. **变化消息**：用户轮 `before_agent_start` 返回 `{ message: { customType: "subagent:prompt-section-update", display: false, content, details } }`；去重靠 `announced`（I3），
   失效靠 `forgetAnnounced`，总量靠 I9。
3. **压缩后的一致性**：压缩后若用户轮是第一个请求 ⇒ 刷新，开头即真相；否则开头保持旧快照（已按旧快照重建缓存），下一个用户轮对每个变化段补发一条更新消息（或指针）。
   两种情况下有效视图都等于 live 或处于指针态（I2）。
4. **子会话**：D6。
5. **模型列表会不会抖**：只有真实变化（scope、认证、models.json 重载、目录更新），快照机制覆盖。
6. **文件清单 / 测试 / 顺序 / 风险**：§7、§8。
7. **与 cache-ttl 的交互**：§7.4。

---

## 7. 实施要点

### 7.1 交付拆分与顺序

| 包                   | 内容                                                                                                                                                                                                                                                                               | 依赖           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **S1 止血**（先行）  | `wake-replay.ts` + `s1-wiring.ts` + `pi-compat.ts`（`onContextWithSystem`、`readForceSystemPrompt`、`getTranscriptHelpers`）+ `settings.ts` 的 `systemPrompt.wakeReplay`（U5）+ `src/index.ts` pre/post-guard 各一行接线 + 测试                                                    | 无（不依赖 D） |
| **D 升级**（可并行） | §7.5 清单（peer / devDeps / lockfile / `pi-compat.ts:101,140-144` / AGENTS.md）                                                                                                                                                                                                    | U1（已定）     |
| **M1**               | `stable-section.ts`（含 I9 计数与 `POINTED`）/ `fold.ts` / `update-message.ts`（含 pointer）/ `store.ts` + 单测 / property                                                                                                                                                         | 无             |
| **M2**               | `hub.ts`（折叠循环、失效钩子、`prefixFresh`（`turn_start`）、`firstRequestPending`、接管 S1、首唤醒播种、R5a + U7、持久化读写）+ `settings.ts`（`mode`、`adoptForeignForcedPrompt`）+ `core-sections.ts` + `resolvePromptModels`；迁移 types/models；删除 `s1-wiring.ts`；hub 单测 | M1、S1         |
| **M3**               | 记忆迁移为 registration（含 `pointerHint`）；改写 memory 测试                                                                                                                                                                                                                      | M2             |
| **M4**               | 文档（AGENTS.md 布局加 `src/prompt-sections/` 与三个设置、`docs/dev/memory/memory-plan.md` §5.2 注记）、`pi-compat.ts` 假设登记、手工验收 A1 / A2                                                                                                                                  | M2、M3         |

**开工顺序**：S1（先行，可与 D、M1 并行）→ M2（需 M1 + S1；U6 持久化、U7 开关、U8 上界、#9 清除点都随 M2 落地）→ M3 → M4。建议 D 与 S1 同期合并（用户运行 0.87.1）。
M2 与 M3 可以分开合并：M2 合并后记忆仍由旧 handler 注入（pre-guard，先于 hub 的折叠循环），顺序仍是记忆 → 类型 → 模型，逐字节不变；
此间唤醒回放捕获的是 hub 的 `sp`（已含旧 handler 的记忆），行为正确。每一步四门禁（format:check → typecheck → test → build）保持绿色。

### 7.2 文件级改动清单

| 文件                                          | 改动                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompt-sections/wake-replay.ts`          | **新增**（S1，§4.4）                                                                                                                                                       |
| `src/prompt-sections/s1-wiring.ts`            | **新增**（S1，§3.5）；M2 **删除**                                                                                                                                          |
| `src/prompt-sections/stable-section.ts`       | **新增**（§4.1）                                                                                                                                                           |
| `src/prompt-sections/fold.ts`                 | **新增**（§4.2）                                                                                                                                                           |
| `src/prompt-sections/update-message.ts`       | **新增**，只渲染（§4.3）                                                                                                                                                   |
| `src/prompt-sections/store.ts`                | **新增**（§4.9）                                                                                                                                                           |
| `src/prompt-sections/hub.ts`                  | **新增**（§4.5）                                                                                                                                                           |
| `src/prompt-sections/core-sections.ts`        | **新增**（§4.6）                                                                                                                                                           |
| `src/adapters/pi-compat.ts`                   | `onContextWithSystem`、`readForceSystemPrompt`、`getTranscriptHelpers`（§4.7）；假设登记 A1–A7；D 包更新 `TESTED_PI_RANGE`（`:101`）与 `isWithinTestedRange`（`:140-144`） |
| `src/index.ts`                                | S1：pre-guard `wireWakeReplay`、post-guard `registerCapture()`；M2 后改为 pre-guard 建 hub、post-guard `register`，删除 `:394-414` handler 与 S1 接线                      |
| `src/memory/index.ts` / `inject.ts`           | registration 化（§4.6）                                                                                                                                                    |
| `src/config/available-models.ts`              | 新增 `resolvePromptModels`；导出标题常量；`append*` 保留作 oracle                                                                                                          |
| `src/config/agent-types.ts`                   | 导出标题常量；`append*` 保留作 oracle                                                                                                                                      |
| `src/config/settings.ts`                      | `systemPrompt.{ wakeReplay (S1), mode, adoptForeignForcedPrompt (M2) }`                                                                                                    |
| `AGENTS.md`、`docs/dev/memory/memory-plan.md` | 布局 / 注入方式 / 三个设置注记；R5b 注明；D 包更新 peer 说明                                                                                                               |

### 7.3 测试锚点与验收标准

**单元 / 性质（纯函数）**

- `tests/prompt-sections/stable-section.test.ts`：首轮取快照无消息；不变 N 轮无消息且 text 不变；A→B 发 update(B)、再 B 无消息（I3）、回 A 发 update(A)；
  B→"" 发 removed；stale 后刷新无消息且计数清零；首轮 SKIP ⇒ text ""、`stale` 仍为 true、下一次非 SKIP 即落快照；已有快照时 SKIP ⇒ 快照不变；
  `forgetAnnounced` 后 live ≠ snapshot ⇒ 下一轮发 update，live == snapshot ⇒ 不发；`resolveAtSeed` 从不产出 update、非 stale 时不调 thunk。
  **I9**：连续 3 次变化发 3 条 update、第 4 次发 pointer、第 5 次无消息；累计字节越过 32KB 的那一次发 pointer；单条 > 32KB 直接 pointer；
  pointer 后 `forgetAnnounced` ⇒ 下一次变化再发一条 pointer（计数未清）；刷新后计数归零、恢复整块更新。
- **property**（沿用 `tests/core/message-property.test.ts` 带种子风格）：随机序列 {改 live, 注入 SKIP, 用户轮, 唤醒请求, compact, model_select, session_tree, turn_start, agent_settled,
  session_start(reload|resume|new), persist→readBack 往返} ⇒ I1–I4、I5「snapshot 永不从非空变为 undefined/''，除非 live 真的是 ''」、I6「有捕获时唤醒请求开头 === 最近用户轮强制文本」、
  **I9**「任意两次刷新之间每段整块更新 ≤ 3 条且 update 字节 ≤ 32KB；两次（刷新 | forgetAnnounced）之间 pointer ≤ 1」、**收敛**（review-2 #4）：任意插入 `session_tree` / `session_compact` 后，
  下一个 live 非 SKIP 的用户轮结束时有效视图 == live 或处于指针态；**持久化往返**：`readBack(serialize(s), "reload")` 在无压缩时 == s。
- `fold.test.ts`（review-2 #14）：① 三段齐全时 `foldSections(base, [mem, types, models])` **逐字节等于** 旧记忆 hook → `appendAgentTypesToSystemPrompt` →
  `appendAvailableModelsToSystemPrompt` 串联的结果（顺序必须是 记忆 → 类型 → 模型）；② 全空时返回值 === 入参，hub 据此返回 `undefined`（不走强制投影路径）；
  ③ 任意子集为空时与串联结果相等。
- `wake-replay.test.ts`：回放形态与 `pc87:agent-session.js:1049-1058` 同构（`toolsAdded` 取当前、无 system 消息时不带 `toolsAdded`、其余 system 消息全部丢弃、不改入参）；
  **幂等**：对回放输出再做一次 `buildReplayMessages` 结果不变；`capture(undefined)` 清空；helpers 缺失时 `apply` 返回 `undefined`。
- `update-message.test.ts`：按「beginning with」引用、标记包裹、多更新合并成一条、pointer 正文含 `pointerHint`（缺省时不含占位）；
  **每个段的 `title` 是其格式化函数输出首行的前缀**（review-3 #11；记忆段用带文件数的真实首行断言）。
- `store.test.ts`：序列化省略规则（announced === snapshot、pointer、stale）；`sanitize` 拒绝 `v !== 1`、逐段丢弃非法段、忽略未知段名；`readBack` 走分支倒序取最后一条、
  `new` 不继承、条目之后有 `compaction` ⇒ `exact = false`、只恢复 `registered` 段；传入含废弃分支条目的 `getEntries()` 风格数组与 `getBranch()` 数组时结果不同（守护调用方必须传 branch）。

**S1（fake pi）** `tests/prompt-sections/s1-wiring.test.ts`：`enabled: false` ⇒ 四个 handler 都未注册（`context_with_system` 的 handler 列表为空，U5）；子会话同；
我方改过强制文本 ⇒ 唤醒请求回放；链起点已有更早扩展的强制文本且我方未改 ⇒ 不捕获（U7）；`session_start` 清空。

**hub（fake pi）** `tests/prompt-sections/hub.test.ts`：每 activate 各钩子只注册一次；主 / 子会话钩子集合相同；**`wakeReplay: false` ⇒ 不注册 `context_with_system`**（U5）；
stable 下返回 `{ systemPrompt, message? }`、legacy 下只返回 `{ systemPrompt }` 且**不调用 `appendEntry`**；全空返回 `undefined`；provider 抛错 ⇒ 折叠旧快照（I5）；
**provider 返回 Promise ⇒ SKIP + 一条日志**（I7）；`skipIf` 为真 ⇒ 该段不折叠、不改状态、不发更新；
`prefixFresh`：compact → 用户轮 ⇒ 刷新无消息；compact → **turn_start** → 用户轮 ⇒ 开头不变 + 补发更新；compact → （无 turn_end）→ turn_start → 用户轮 ⇒ 同上（review-3 #9 回归）；
compact → agent_settled → 用户轮 ⇒ 刷新（③ 号压缩后免费刷新不被 settled 清掉）；
**model_select → turn_start → 用户轮 ⇒ 不重发已发过的更新**（review-3 #12）；`session_tree` ⇒ 下一轮补发；
`context_with_system`：有捕获 ⇒ 回放；首个用户轮前 ⇒ 播种且与随后用户轮的 `systemPrompt` 相等；用户轮后无捕获 ⇒ 不改；
**`getSystemPrompt: () => ""` ⇒ 不播种、不回放**（review-3 #4）；**唤醒 run 第 1 个请求三段为空、第 2 个请求非空 ⇒ 第 2 个请求不播种**（review-3 #5）；
**`ctx.getSystemPrompt` 在同一 run 内只被调用一次**（review-3 #14）；
R5a：`ctx.getSystemPrompt()` = captured + 追加 ⇒ `adoptForeign: false` 时仍回放 captured 且 WARN、`true` 时改为回放追加后的文本；两个 run 各 WARN 一次；
更早扩展强制 + 我方全空 ⇒ `adoptForeign: false` 不捕获、`true` 捕获（review-3 #3）；`ctx.getSystemPrompt` 抛错 ⇒ 仍按 captured 回放；
**持久化**：状态不变的用户轮不写条目；`session_start(reload)` 读回后下一个用户轮的 `systemPrompt` 与 reload 前逐字节相同且不发更新（review-3 #2 回归）；
`session_start(resume)` 读回后对 live ≠ snapshot 的段补发一次；`appendEntry` 抛错 ⇒ WARN 一次、返回值不受影响；`getBranch` 缺失 ⇒ 全新状态。
hub 不持有任何进程级状态，测试间无需 reset（review-2 #11）。

**T-G5（取代 v3 的 A3，review-3 #8）**：hub 单测中用 `fakePi()` 模拟「`context_with_system` 永不触发 + `event.systemPromptOptions` 无 `forceSystemPrompt`」，
断言三段仍以今天的形态出现在 `{ systemPrompt }` 里（stable / legacy 各一次）、`replay.captured()` 在无我方改动时为 undefined、记忆写入后下一轮出现更新消息且开头不变。
真机 0.84 验收不再要求（D8）。

**T-REAL**：移出交付（D13），接缝登记为 E8。

**手工验收（可判定；复用 `docs/dev/cache-ttl-adaptive/` 的取证方法）**

取数：`/record on` 后 `~/.pi/agent/records/traffic.db`，
`sqlite3 -readonly ~/.pi/agent/records/traffic.db "SELECT id, ts, length(json_extract(payload,'$.system')), substr(hex(sha3(json_extract(payload,'$.system'))),1,16) FROM requests WHERE session_id=? ORDER BY id"`
（`sha3` 不可用时导出 `json_extract(payload,'$.system')` 再 `sha256sum`）；会话 jsonl `~/.pi/agent/sessions/<cwd-slug>/*.jsonl` 中 assistant 消息的
`message.usage.{input, cacheRead, cacheWrite, cacheWrite1h}`，以及 `type:"custom"`、`customType:"subagent:prompt-sections"` 条目。「上一请求前缀」取上一条 assistant 的 `input + cacheRead + cacheWrite`。

- **A1（S1）**：在 `cloudrouter-anthropic` 上，用户轮 → 等一次子 agent 完成通知唤醒 → 用户轮；三次请求的 `system` 哈希相等；唤醒请求与其后用户请求的
  `cacheRead ≥ 上一请求前缀 × 0.9`。再次运行 §1.2 的 jsonl 统计（≥15 个跨类样本）：跨类整前缀失效率 ≤ 同类失效率 + 5 个百分点；field §3.2 的「两条交替谱系」不再出现。
  对照：`wakeReplay: false` + `/reload` 后重复一次，唤醒请求的 `system` 哈希与用户轮不同（可证伪）。
- **A2（主方案，stable）**：连续两个用户轮之间写一条记忆，期间插一次通知唤醒：三次请求 `system` 哈希相等；第二个用户轮 `cacheRead ≥ 上一前缀 × 0.9`；
  更新消息（`customType:"subagent:prompt-section-update"`）位于最后一条 user 消息之后；随后执行 `/reload`，其后第一个用户轮 `system` 哈希不变、`cacheRead ≥ 上一前缀 × 0.9`、
  jsonl 中无新的 `subagent:prompt-sections` 条目（review-3 #2）；再空闲 `/compact`，其后第一个用户轮 `system` 含新记忆且不再有更新消息。

### 7.4 与 cache-ttl keepalive / adaptive 的交互

- **keepalive**（逐字节回放上一次捕获的请求）：G1 之后唤醒轮与用户轮共享同一前缀链，保活续的就是下一次请求要读的链；此前两条链各自被保活或各自过期（§1.2 的 44%）。
- **adaptive**：刷新点与 cache-ttl 事件的关系见 D4。更新消息只给 Δ 增加几 KB，落在现有 `delta-too-large` / 尾巴 + Δ 判据内；不改前缀 ⇒ 不触发额外 1h 命名空间重写（plan §16.3 / §18）。
  **量级上界**（review-3 不变量检查）：由 I9，任意两次刷新之间尾部更新消息总量 ≤ 3 段 × 32KB ≈ 96KB（默认 `byteCap` 下实际 ≤ 3 × 4KB 记忆 + 类型 / 模型块），此后只有百字节级的指针消息。
- `/reload` 不再刷新快照（U6）⇒ 不再有「reload 后整前缀重写」这一 cache-ttl 入场费的放大源（与 field-2026-09-24 的 reload 事故互不叠加）。
- cache-ttl 的 `before_provider_request`（`cache-ttl.ts:301`）改的是载荷上的 `cache_control`，在 `context_with_system` 与强制投影之后运行，两者不冲突；
  pi 自己的 cache warmer 捕获的是 transform 之后的 context（`pc87:sdk.js:241`），回放结果会被一并预热。
- 预期收益：跨类失效（现场 44%）降到同类水平；field §5「记忆/agent 类型变化」约 6 次整前缀重写变成尾部写入。

### 7.5 peer 升级影响面与检查清单（U1 / D 包）

AGENTS.md 要求「bump deliberately and re-check `src/adapters/pi-compat.ts`」。0.84.4 → 0.87.1 跨越三个次版本；**0.85.x 无 Breaking Changes 段**（`pc87:CHANGELOG.md:174-240`），
0.86.0 三条、0.87.0 五条（`:35-41,97-101`）。以下按「会让 typecheck 变红的改动」→「机械改动」→「验证性复核」排序：

| #   | 类别   | 项                                                                                                                                                                                                                                                                                                                                                                | 检查动作 / 依据                                                                                                                                                          |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C5  | 改动   | 0.86.0：`ToolCall.arguments` / `ToolResultMessage.details` 限定为 JSON 兼容值，`ToolResultMessage` 变条件类型，`JsonValue` 数组只读                                                                                                                                                                                                                               | typecheck；仓库大量工具返回 `details`（含 `undefined` 字段、类实例、可变数组），预计是主要工作量                                                                         |
| C9  | 改动   | 0.86.0：`pi.on()` 返回 unsubscribe（0.84 返回 `void`，`pc84:…/loader.js:233-238`；0.87 `api.on` 返回退订闭包，`pc87:dist/core/extensions/loader.js:202-218`）；`user_bash` fail-closed。**复核结论**：review-3「已核查项」称 0.87 的 `pi.on()` 也不返回 unsubscribe，经本次源码复核**不成立**（`:208` 即 `return () => { … handlers.splice(…) }`），v3 原描述保留 | typecheck 找 `void` 上下文约束（如把 `pi.on(...)` 作为声明返回 `void` 的箭头函数体——返回值由 `void` 变函数，通常不报错，但显式标注的返回类型会）；仓库未注册 `user_bash` |
| C1  | 机械   | `package.json` peer ×3、devDeps ×3、lockfile                                                                                                                                                                                                                                                                                                                      | `>=0.87.0 <0.88.0` / `0.87.1`；`peerDependenciesMeta` 不变                                                                                                               |
| C2  | 机械   | `pi-compat.ts`：`TESTED_PI_RANGE`（`:101`）、`isWithinTestedRange`（`:140-144` 写死 `minor === 84`）、`/goal` 假设注释（`:62-75`）                                                                                                                                                                                                                                | 改为 0.87（`minor === 87`）；逐条复核 goal 的四条假设                                                                                                                    |
| C10 | 机械   | AGENTS.md「Peer dependencies … pinned to `>=0.84.0 <0.86.0`」                                                                                                                                                                                                                                                                                                     | 同步更新                                                                                                                                                                 |
| C3  | 验证性 | 0.87.0：`agent_settled` 处理器里请求的 run 被推迟到所有 settled 处理器结束                                                                                                                                                                                                                                                                                        | 仓库 `shouldStopAfterTurn` 0 处；复核 `src/goal/`、`src/reload/`、`src/feishu-notify/index.ts:583`、`src/hud/index.ts:391`、`src/cache-ttl/cache-ttl.ts:232` 的时序假设  |
| C4  | 验证性 | 0.87.0：`TurnEndEvent` 新增必填边界字段；`ExtensionEvent` 并入新事件；`SessionEntry` 并入 `context_edit`                                                                                                                                                                                                                                                          | 仓库 `ExtensionEvent` 0 处、手工构造 `type:"turn_end"` 0 处（6 处 `pi.on("turn_end")` 只用 `_event`）；typecheck 兜底                                                    |
| C6  | 验证性 | 0.86.0：transcript 出现 `role:"system"` 消息                                                                                                                                                                                                                                                                                                                      | 复核按 role 遍历消息的代码：`src/runtime/session-driver.ts:132-136`、`src/hud/`、`src/session-nav/skill-titles.ts:46`、`src/context-switch/session-facts.ts`、成本统计   |
| C7  | 验证性 | 0.87.0：`SessionManager` 成为 provider 上下文唯一来源；`context` 处理器不再看到 system 消息                                                                                                                                                                                                                                                                       | `agent.state.messages` 赋值 0 处、`pi.on("context"` 0 处；复核 `src/runtime/session-driver.ts:313-328`                                                                   |
| C12 | N/A    | 0.86.0：pi-ai provider stream 输入 `Context` → `TranscriptContext`                                                                                                                                                                                                                                                                                                | 仓库不注册自定义 provider（`registerProvider` / `streamSimple` 0 处）⇒ 不适用                                                                                            |
| C8  | 记录   | 0.86.0：pi 自带成本感知的 prompt-cache warming                                                                                                                                                                                                                                                                                                                    | 与 cache-ttl keepalive 可能重复保活——单独记录为后续议题                                                                                                                  |
| C11 | 门禁   | 四门禁 + 在 0.87.1 上冒烟：spawn 前台/后台 subagent、通知唤醒、`/goal` 一轮、`/agent reload`、bash 自动后台                                                                                                                                                                                                                                                       | 全部通过后再合并                                                                                                                                                         |

---

## 8. 风险与扩展点

| #   | 风险                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 应对                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | 依赖 pi 未文档化行为：A1 `context_with_system` 每请求触发且在强制投影之前（F5）；A2 强制 run 中 `ctx.getSystemPrompt()` = 强制文本（F6，仅 R5a 与播种用）；A3 `forceSystemPrompt` 在 handler 链上可见且即为 run 的强制文本、同一扩展 handler 连续（F8、F15）；A4 强制投影形态（`agent-session.js:1049-1058`）；A5 pi-ai 包入口导出 `getCurrentSystemMessage`；A6 压缩点与 `turn_start` / `agent_settled` 时序（F9、F12、F13、F17）；A7 run 内强制文本冻结、唤醒 run 首请求渲染 base（F14、F18） | 登记到 `pi-compat.ts`；单测以 fake pi 固化假设下的行为；手工验收 A1 / A2 在真机上覆盖 A1–A4、A6；peer 上界 `<0.88.0`，升级时按 §7.5 复核                           |
| R2  | 模型更信 system prompt 而不是后面的 user 角色消息                                                                                                                                                                                                                                                                                                                                                                                                                                               | 覆盖声明写明 REPLACES / authoritative，按标题前缀一一对应；刷新点把真相写回开头；I9 限制同时在场的版本数                                                           |
| R3  | 长会话更新消息堆积                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | I9：每段自上次刷新起 ≤3 条 / ≤32KB，此后至多一条指针（D12）；压缩后的重发是常态重复（I3），计入同一上界                                                            |
| R4  | ~~子会话 promptMode=replace~~                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 结案（D6）                                                                                                                                                         |
| R5  | v2 形态（投影被后加载扩展静默覆盖）**不存在**；R5a（追加）默认 WARN 不采纳，可开关采纳；R5b（整块替换）为已论证风险                                                                                                                                                                                                                                                                                                                                                                             | D10                                                                                                                                                                |
| R6  | ~~一次性开头形态切换~~                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 结案：开头形态与今天相同，无部署切换、无每进程切换                                                                                                                 |
| R7  | memory 的 mtime 排序：只 touch 也算变化                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 真实渲染变化，只产生一条尾部消息，计入 I9                                                                                                                          |
| R8  | ~~三段不在 pi 的上下文 token 估算中~~                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 结案：简路线的三段在强制文本里，与今天一样被计入；`getContextUsage` 以 provider 实报为锚（F16，review-2 #7）                                                       |
| R9  | 唤醒轮看到的内容可能比 live 旧（U4）                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 至多到下一个用户轮；多数变化由模型自己造成                                                                                                                         |
| R10 | 回放文本与强制用户 run 内，pi 的 `tools` 说明段在工具集变化后是旧的（F14，今天已有）                                                                                                                                                                                                                                                                                                                                                                                                            | `toolsAdded` 始终取当前；影响限于一段说明文字；若需要实时，走 E5                                                                                                   |
| R11 | 首唤醒播种与随后第一个用户轮不逐字节相同：P4 不成立（更早扩展强制）或 pi 自身 base 在两者之间变化（`setActiveTools`、reload 资源）                                                                                                                                                                                                                                                                                                                                                              | 开头变一次，那是 pi / 第三方的变化；P1（`cur !== ""`）与 P2（首请求）由护栏保证（§4.5）                                                                            |
| R12 | `prefixFresh` 清除点：v3 的 `turn_end` 可被跳过（F17，**可触发**）⇒ 卡 true ⇒ 一次非免费的「压缩后上下文」重写                                                                                                                                                                                                                                                                                                                                                                                  | 改为 `turn_start`（每请求前必发、不可跳过）；残余方向是「turn_start 后请求前被 abort ⇒ 少一次免费刷新」，退化为尾部消息，不产生额外重写、不丢内容、不挂住          |
| R13 | 会话条目：会话文件增长；fork / tree 下读到错误分支的快照                                                                                                                                                                                                                                                                                                                                                                                                                                        | 只在状态变化的用户轮写（个位数条 × 10–30KB）；读回只走 `getBranch()`（MAJ-5 口径），非 `reload` 一律 `forgetAnnounced`；格式带 `v: 1` 与逐段校验，读不到即全新快照 |
| R14 | `adoptForeignForcedPrompt = false`（默认）时，第三方追加 / 更早强制的内容不进唤醒轮                                                                                                                                                                                                                                                                                                                                                                                                             | 与今天的唤醒轮相比只多（我方三段）不少；R5a 每 run WARN 让用户知情，需要时打开开关                                                                                 |

**扩展点（本次不实现）**

- E1 缓存已冷时顺便刷新（需 cache-ttl 暴露只读 `isPrefixCold()`）；同样适用于「resume 时前缀已冷 ⇒ 读回改为刷新」。
- E2 capable 模型：若将来目录开启 `supportsMidConvoSystemMessages`，可评估把更新改为 system 补丁；强制 run 下 pi 仍会折叠，需先验证。
- E3 其它每轮动态内容：`hub.register` 一个新段即可。
- E4 resync：若观察到模型引用已被开头覆盖的旧更新消息，再恢复刷新时对账。
- E5 请求时投影（v2 主方案）：若将来需要 run 内 pi 半段实时，可在 hub 内部把「折叠进强制文本」换成「`context_with_system` 注入 section」，`register` 接口不变；
  届时必须先处理 review-2 #2 / #3 / #6 / #11 与 v2 R6。
- E6 向上游提 issue：唤醒路径也 emit `before_agent_start`，或提供持久登记扩展 section 的接口。
- E7 压缩感知的 `forgetAnnounced`：`session_compact` 时若我方最近的更新消息位于 `compactionEntry.firstKeptEntryId` 之后（保留区），就不忘记，消除常态重复（review-3 #15；需一次分支条目查询）。
- E8 进程内 T-REAL：`new DefaultResourceLoader({ …, extensionFactories })`（`pc87:dist/core/resource-loader.d.ts:67-76`，`DefaultResourceLoader` 自 `dist/index.d.ts:18` 导出）注入扩展；
  T-REAL-a 只跑唤醒轮（`sendCustomMessage` → `_runAgentPrompt` 不经 auth 闸，`pc87:agent-session.js:1502-1507`），T-REAL-b 用户轮需注入 `modelRuntime` 过 auth 闸（review-3 #7）。

---

## review-2 处置表

| #   | 严重度 | 处置                                                                                                                                                                   | 方案改动位置                | 理由 / 证据                                                                                                           |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞   | **采纳，改选型**：简路线作为一等公民逐目标对照（G1 持平、G2/G5 简路线胜、G3 持平、G4 投影路线仅在快照新鲜度上略优且不涉成本）；主方案按简路线重写，投影路线降为 E5     | 文首、§3、§4、D1、D7、§7.1  | 投影唯一真实优势（run 内 pi 半段实时）是今天已有行为、只涉一段说明文字、且冻结反而避免 run 内重写；投影独有问题一整类 |
| 2   | 严重   | **消解**：简路线没有 `injectSections`、没有合成头；回放形态与 pi 强制投影同构（I8），任何 transcript 形态 / 路由下与 pi 自己的强制 run 相同                            | §4.4、I8、D1 G2 行          | 无 system 消息时 pi 的强制投影同样不带 `toolsAdded`，我们逐字复刻而非自创                                             |
| 3   | 严重   | **消解 + 补护栏**：v2 形态不存在（仍在折叠链内）；R5a 追加 ⇒ 请求时前缀判据采纳 + WARN 一次；R5b 整块替换 ⇒ 降级为已论证风险（与今天相同 / 唤醒轮只多不少 / 环境复核） | §4.5、§4.8、D10、R5         | R5b 在请求时与唤醒 run 无法区分，任何判据都会误伤；论证见 D10。v3.1 按 review-3 #3 / U7 改为默认不采纳                |
| 4   | 一般   | **采纳**：`session_tree` ⇒ `forgetAnnounced`（不刷新快照）；property 加收敛断言                                                                                        | §4.1、§4.5 钩子表、D4、§7.3 | 同一原语也用于压缩后「刷新赶不上」的情形                                                                              |
| 5   | 一般   | **采纳**：S1 单状态 `captured`，在 handler 链末读取；删除 `pendingCapture` 与边界 4                                                                                    | §3.5、§4.4                  | F15 逐字节相同；延迟捕获多买到的「更晚 handler 追加」改由 R5a 在请求时处理                                            |
| 6   | 一般   | **消解**：无锁存；模式只在 `before_agent_start` 读取，`context_with_system` 不读模式 ⇒ run 粒度天然不变；§3.2 表加「模式解析时点」列                                   | §3.2、§4.5                  | 交接问题源自锁存，锁存已删除                                                                                          |
| 7   | 一般   | **采纳**：R8 结案并记录更正后的事实（usage-anchored；回落窗口 `tokens: null`），删除「阈值压缩略晚触发」推论                                                           | §1.3 F16、R8                | 简路线下三段本就在强制文本里被计入                                                                                    |
| 8   | 一般   | **采纳并扩展**：子会话加 `session_compact`；并统一 `model_select` / `session_tree`（钩子集合与主会话相同）                                                             | §4.5、D6                    | 均为 O(1) 状态翻转，省掉反而要 `isChildSession` 分支                                                                  |
| 9   | 一般   | **采纳**：C5/C9 置顶、C3/C4/C6/C7 标「验证性」并附 grep 0 命中依据；补 C12（provider 输入 Breaking，N/A）；注明 0.85.x 无 Breaking                                     | §7.5                        | 已复核 `registerProvider` / `streamSimple` 0 处；C9 描述经 v3.1 复核保留                                              |
| 10  | 建议   | **采纳**：升格为不变量 I7；provider 返回 thenable ⇒ SKIP + 日志；加单测。简路线下 provider 只在 `before_agent_start` 与首唤醒播种被调用，请求路径上的暴露面已比 v2 小  | §4.1 I7、§4.5、§4.8、§7.3   | `before_agent_start` 同样被 `await` 且无 signal                                                                       |
| 11  | 建议   | **消解**：无 `globalThis` 锁存，hub 全部状态在 activate 闭包内，测试间无需 reset                                                                                       | §3.3、§7.3                  | —                                                                                                                     |
| 12  | 建议   | **采纳**：`optionsCwd ?? tryCtxCwd(ctx) ?? process.cwd()` 三级回退，注释写明 `assertActive`                                                                            | §4.6                        | 首唤醒播种时没有 `optionsCwd`，回退链更重要                                                                           |
| 13  | 建议   | **采纳**：`getTranscriptHelpers` 用一次 `as unknown as { getCurrentSystemMessage?: … }` 窄化，集中在 `pi-compat.ts`                                                    | §4.7                        | 运行期命名空间导入不失败，编译期 TS2339                                                                               |
| 14  | 建议   | **采纳**：`fold.test.ts` 断言三段齐全时与现状串联逐字节相等（顺序 记忆 → 类型 → 模型）、全空时返回值 === 入参且 hub 返回 `undefined`                                   | §4.2、§7.3                  | 在简路线里折叠是唯一路径，oracle 同时守护 stable 与 legacy                                                            |

---

## review-1 处置表

| #   | 严重度 | 处置                                                                                                                                                                                             | 方案改动位置                       | 理由                                                                                                                              |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞   | **采纳并扩展**：版本溯源全部改为 0.87.1 并逐条标注 0.84.4 是否存在；推荐 peer `>=0.87.0 <0.88.0` + 检查清单（待用户确认 U1）；结构化探测改为「观测锁存」，未确认即 legacy，<0.87 永不丢内容      | §0、§1.3、§4.6、D7、D8、§7.5       | 评审建议的 `sections` 探针只能判 ≥0.86，而 v2 的接缝是 0.87 的 `context_with_system`；直接观测该事件触发比任何间接标记都可靠      |
| 2   | 阻塞   | **采纳，改机制**：注入改为 `context_with_system` 请求时投影，唤醒轮与用户轮由构造保证一致（I6）；现场 10% / 44% 证据写入 §1.2；新增止血包 S1；否决 2a（改 nextTurn）、2c（带病上线），2b 列为 E6 | §1.2、§3、§3.5、§4.4、D1、D9、§7.1 | 评审三条出路都不修功能缺陷或改投递语义；0.87.1 源码里存在每请求接缝（F5），比三条出路都好                                         |
| 3   | 严重   | **采纳**：任何失败路径注入上一次成功的快照；新增不变量 I5 + property                                                                                                                             | §4.1 I5、§4.4 末段、§4.7、§7.3     | 投影模式下「不注入」同样等于删除该段并改开头，是最坏结果                                                                          |
| 4   | 严重   | **采纳**：`SKIP` 哨兵，刷新分支遇 SKIP 不落快照、不清 stale，下次重试；I4 改写；加单测与 property                                                                                                | §4.1 状态机、I4、§7.3              | 瞬时 readdir 失败不应让 agent 类型列表整会话消失                                                                                  |
| 5   | 严重   | **采纳**：`systemPrompt.mode = stable \| live \| legacy`；legacy 与现状逐字节相同（`foldLegacy` 以现有 `append*` 为 oracle），`append*` 保留不删                                                 | §3.2、§4.2、§4.5、D7、§7.3         | 同一分支兼作低版本退化，一套代码两个用途                                                                                          |
| 6   | 一般   | **采纳**：逐事件对照 cache-ttl 集合并说明差异；删除 `session_tree` 刷新点                                                                                                                        | D4、§7.4                           | resync 删除后 `session_tree` 无刷新理由，且切回活分支时刷新有成本                                                                 |
| 7   | 一般   | **采纳**：删除「伪抖动」论断；`resolvePromptModels` 理由改为收敛来源（I7）；假锚点删除（T-REAL 取代端到端断言）                                                                                  | §2、§4.5、§6.5、§7.3               | 三条分支渲染逐字节相同，原断言恒真                                                                                                |
| 8   | 一般   | **采纳并加强**：I2 限定为「每次 `before_agent_start` 返回后」；`session_compact` 置 stale 后由下一个请求刷新，轮中压缩窗口缩到一个请求                                                           | §4.1 I2、§4.4、D3、§6.3            | 请求时投影让刷新不必等下一个用户轮；未采纳 `compactedMidRun` 标记（投影后已无必要）                                               |
| 9   | 建议   | **采纳**：删除 resync / hash / `parseSectionUpdate` / `visible()` / `session_tree` 刷新点，降级为 E4                                                                                             | §4.3、D5、§8 E4                    | 与刷新语义重复；同时砍掉对 `buildContextEntries` 形态的依赖                                                                       |
| 10  | 建议   | **已消解**：v2 不再写 `systemPromptOptions.sections`，`delete` 逻辑不存在；`injectSections` 对空文本直接跳过并注明原因                                                                           | §4.2                               | 机制变更后该细节不复存在                                                                                                          |
| 11  | 一般   | **采纳**：删除模型名单，改为「当前生成目录无任何模型开启」，D2 / E2 收益更正为零                                                                                                                 | §1.3 F4、D2、§8 E2                 | 评审核实 `models.generated.js` 中 0 次                                                                                            |
| 12  | 一般   | **采纳**：手工验证升格为可判定验收 A1–A3；新增真实 pi 测试 T-REAL（`createAgentSession` + faux provider，直接断言 provider 输入的开头字节）                                                      | §7.3                               | 评审建议的「调 `diffSystemPromptSections`」只适用于 v1 机制；v2 的等价物是用真 AgentSession 跑用户轮 / 唤醒轮并比对 provider 输入 |
| 13  | 建议   | **采纳**：① 随 #5 定型为 `systemPrompt: { mode }` 子对象（与 `cacheTtl.mode` 同构）；② 子会话只注册 `before_agent_start` / `context_with_system` / `session_start`                               | §4.4、§4.5、D6                     | 子会话保持惰性                                                                                                                    |

> review-1 表为 v2 当时的处置，章节号指 v2。v3 / v3.1 对其中几条的后续演变：#1 的「观测锁存」、#5 的 `live` 模式、#8 的「下一个请求刷新」随 D1 选型改变而删除 / 改写
> （见 review-2 处置表 #1、#6）；#12 的 T-REAL 在 v3.1 移出交付（review-3 #7，D13）、A3 改为静态断言 T-G5（review-3 #8）；#13② 被 review-2 #8 扩展为与主会话相同的钩子集合。

---

## review-3 处置表

统计：15 条全部处置——**12 条按建议采纳**，**3 条采纳但改法调整**（#2 按用户拍板用会话条目而非评审推荐的 `Symbol.for` 全局；#7 按用户指示降级为手工验收 + E8，而非落地进程内 T-REAL-a；
#9 清除点改为 `turn_start`，否决评审备选之一 `agent_settled`）。C9 经复核**不按** review-3 更正（其核查项与源码不符，见表末行）。

| #   | 严重度 | 处置                                                                                                                                                                                                                                                         | 方案改动位置                                              | 理由 / 证据                                                                                                                                                                   |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 严重   | **采纳（U5 = 独立布尔）**：`systemPrompt.wakeReplay`（默认 true），`false` 不注册 `context_with_system`；S1 自带该开关；D7 更正为「`wakeReplay=false` + `legacy` = 今天」；§3.2 改为三设置表 + 回滚矩阵，删除「与模式无关」措辞                              | §0.2、§3.2、§3.5、§4.5 钩子表、§4.6、D7、D9、§7.1         | 回放层是唯一触及每次请求的一层，必须可单独撤下；AGENTS.md「all settings-gated」约定                                                                                           |
| 2   | 严重   | **采纳，改法按拍板（U6 = 会话条目）**：新增 `store.ts`（§4.9），`subagent:prompt-sections` 条目，`before_agent_start` 末尾唯一写点，`session_start` / `session_tree` 从 `getBranch()` 读回；`reload` 精确恢复，其余读回 `forgetAnnounced`；读不到 ⇒ 全新快照 | §0.2、§1.4 G4、§3.1、§3.4、§4.5、§4.8、§4.9、D4、D11、R13 | 跨进程 resume 也受益；getBranch 防 fork 废弃分支复活（goal MAJ-5）；`captured` / `prefixFresh` 不持久化的理由见 §4.9                                                          |
| 3   | 一般   | **采纳（U7 = B）**：默认只回放我方生产的字节（S1 `end !== chainStart`，M2 `sp !== event.systemPrompt`）；(a) 路径与 R5a 采纳均受 `adoptForeignForcedPrompt`（默认 false）控制；R5a 改为每 run WARN；风险表补 R14                                             | §3.2、§3.5、§4.5、§4.8、D10、R5、R14                      | 第三方强制文本可能是 run 级内容，默认不应被静默提升为会话级                                                                                                                   |
| 4   | 一般   | **采纳**：播种分支 `cur === undefined \|\| cur === ""` ⇒ 不播种（注释引 F19）；**不**在 `foldSections` 加空串短路（会破坏 oracle 等价），护栏只放 hub；单测补 `() => ""` 夹具                                                                                | §1.3 F19、§4.2、§4.5、§4.8、§7.3                          | 代价灾难级、护栏一次比较                                                                                                                                                      |
| 5   | 一般   | **采纳（评审方案一）**：播种限定在每个 run 的第一个请求（`firstRequestPending`，`agent_settled` 置位）；§4.5 等价性改为构造性表述并列出前提 P1–P4，P4 / base 变化写入 R11；单测补「第 1 请求空、第 2 请求非空」                                              | §1.3 F18、§4.5、R11、§7.3                                 | 第 2 个请求起 `_runSystemPromptOptions` 带 `getActiveToolNames()`（F18）；用 `agent_settled` 而非 `agent_start` 置位，因为 run 内 `agent.continue()` 也发 `agent_start`（F9） |
| 6   | 一般   | **采纳（U8 = A）**：I9（每段 ≤3 条 / ≤32KB，超限至多一条指针）；`SectionUpdate` 加 `pointer`，registration 加 `pointerHint`；计数随条目持久化；§7.3 单测 + property 断言；§7.4 补量级上界                                                                    | §4.1、§4.3、§4.5、§4.9、D12、R3、§7.3、§7.4               | 记忆 `byteCap` 默认 4000、上限 65536，写得最频繁                                                                                                                              |
| 7   | 一般   | **采纳，改法调整**：T-REAL 移出交付，降级为手工验收 A1 / A2 并写明具体命令与取数字段（traffic.db SQL、jsonl `usage` 字段、条目类型）；两个障碍与「子进程验收」不划算的理由写入 D13；进程内接缝登记为 E8                                                      | §7.1 M4、§7.3、D13、E8、R1                                | inline extension 入口不存在 + auth 闸；子进程需 mock provider 与确定性唤醒轮，成本不成比例；机制论断已在源码层核实并由单测守护                                                |
| 8   | 一般   | **采纳**：删除 §7.5 末段与 §0.2 的「U1 若选 C」；A3 改为静态断言 T-G5（fakePi：`context_with_system` 永不触发 + 无 `forceSystemPrompt` ⇒ 三段仍在 `{ systemPrompt }`、`captured` 为 undefined）；真机 0.84 验收取消；C2 行号更正为 `:140-144`                | §0.1、§0.2、§1.4 G5、D8、§7.3、§7.5                       | U1 已定 peer `>=0.87.0`，0.84.4 在范围外                                                                                                                                      |
| 9   | 一般   | **采纳，改法调整**：`prefixFresh` 清除点由 `turn_end` 改为 `turn_start`（每请求前必发、非 boundary 分发不可跳过）；否决 `agent_settled`（晚于 ③ 号压缩，会清掉免费刷新）与 token 增长判据（回落窗口 `tokens: null`）；R12 改写为「可触发 → 已修」            | §1.3 F9 / F17、§3.4、§4.5 钩子表、D4、R12、§7.3           | `pc87:agent-session.js:332-345`；`core87:agent-loop.js:51,113`；`pc87:agent-session.js:1078-1104`                                                                             |
| 10  | 建议   | **采纳（接受边界并写明）**：§3.5 边界 4——S1 post-guard ⇒ 子会话唤醒轮 S1 阶段不修，M2 hub（pre-guard）接管                                                                                                                                                   | §0.2 U2、§3.5、D6、D9                                     | S1 的捕获必须在核心 handler 之后（F8）                                                                                                                                        |
| 11  | 建议   | **采纳**：更新 / removed / pointer 正文统一为「headed by the line beginning with」；约束 `title` 为格式化首行前缀，`update-message.test.ts` 断言                                                                                                             | §2、§4.3、§4.6、§7.3                                      | 记忆段真实首行 `## Memory (<slug>) — N file(s)`（`render.ts:154`）                                                                                                            |
| 12  | 建议   | **采纳**：`model_select` 只置 `prefixFresh`，不 `forgetAnnounced`；hub 单测加「model_select → turn_start → 用户轮 ⇒ 不重发」                                                                                                                                 | §4.5 钩子表、D4、§7.3                                     | 换模型不重写对话                                                                                                                                                              |
| 13  | 建议   | **采纳**：`SKIP`（及新增的 `POINTED`）改用 `Symbol.for("pi-subagent:…")`                                                                                                                                                                                     | §4.1                                                      | 与 `HOST_KEY` 同约定，防 jiti 双实例                                                                                                                                          |
| 14  | 建议   | **采纳**：R5a 检测限定在每个 run 的第一个请求（与 #5 共用 `firstRequestPending`）；I7 改写为「请求路径只做内存操作，例外仅首请求的一次 `getSystemPrompt()`」；单测断言同一 run 内只调用一次                                                                  | §4.1 I7、§4.5、§7.3                                       | F14：第三方强制文本 run 内冻结                                                                                                                                                |
| 15  | 建议   | **采纳**：I3 改写为「`forgetAnnounced` 之后允许重复，代价已知、属常态」；D3 写明常态并交由 I9 约束；按 `firstKeptEntryId` 不忘记的优化列为 E7                                                                                                                | §4.1 I3、D3、E7                                           | 压缩常保留最后一个用户轮附近的更新消息（`pc87:agent-session.js:2220`）                                                                                                        |
| —   | 机械   | **C9 未按 review-3 更正**：review-3「已核查项」称 `pi.on()` 在 0.87 也不返回 unsubscribe，复核源码不成立——`pc87:dist/core/extensions/loader.js:202-218` 的 `api.on` 返回退订闭包（0.84 `pc84:…/loader.js:233-238` 确为 `void`）。C9 保留 v3 描述并补证据     | §7.5 C9                                                   | 用户指示「按已核查项更正」，但该核查项与源码不符；如实记录，不照改                                                                                                            |
