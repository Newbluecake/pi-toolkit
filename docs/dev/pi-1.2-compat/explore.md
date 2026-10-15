# pi 1.2.0 适配盘点（explore.md，2026-10-15）

取证基线：本工作区 HEAD = c807d62（pi devDeps 1.1.0）；对照 pi 1.2.0 全局安装
`/home/bluecake/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent`
（package.json version = 1.2.0，捆绑 pi-ai/pi-tui/pi-agent-core/pi-codemode/pi-mcp ^1.2.0）。
全部结论基于两侧 `dist/**/*.d.ts` 与 `dist/core/agent-session.js`/`extensions/runner.js`/`system-prompt.js`
逐文件 diff（`.d.ts` 实质变化仅 21 个文件，核心面只有 4 处，见 §6）。姊妹文档：`baseline.md`（真机测试结果，T1/C1/C2/R1）。

pi 1.2.0 运行时语义核实（对 diff 的解读，后续各节引用）：

- `_runAgentPrompt` 拆成 `_startRun(trigger)` + `_prepareRun(trigger)`；`_startRun` 第一行就置
  `_isAgentRunActive = true`（agent-session.js:1392），**before_agent_start handler 执行期间 isIdle()=false**
  （(B) 的机制），且 `_prepareRun` 对 user/custom 两种 trigger 都调 `emitBeforeAgentStart`（(A)）。
- `sendCustomMessage(triggerTurn:true)` 空闲时从 `_runAgentPrompt(appMessage)` 改为
  `_startRun({messageType:"custom", message})` —— 唤醒 run 现在**经过 before_agent_start**，
  handler 返回的 `message`/`systemPrompt` 一样生效；`_pendingNextTurnMessages` 也在 `_prepareRun`
  里随 custom run 一起投递。
- `sendUserMessage()` → `prompt(text,{streamingBehavior: deliverAs, source:"extension"})`；`prompt()`
  在 `isStreaming`（现含启动窗口）且无 `streamingBehavior` 时**仍抛** "Agent is already processing"——
  (B) 只是说 busy 窗口变宽，`sendMessage(triggerTurn)` 在 busy 时入队而非另起 run。
- `_emitAgentSettled` 仍在置 `_isAgentRunActive = false` 之后 emit（两版相同）⇒ agent_settled
  handler 里 `ctx.isIdle()` 行为不变。
- `system-prompt.js` 的 `forceSystemPrompt` 渲染路径 1.1↔1.2 逐字节相同；(C) 的原生修复
  （run 级 forced prompt 全程保持）在 `_runSystemPromptOptions` 生命周期内实现。

---

## 1. `before_agent_start` 注册点（src 全量共 4 处）

memory 的注入自 M3 起不再自有 hook（`src/memory/index.ts:9`、`src/memory/inject.ts:6` 注释），
折进 §1.1 的 hub；旧文档里的 `src/index.ts:394` 核心 hook 已合并进 hub（M2）。topic-switch **没有**
before_agent_start 注册（其判定在 `input` handler，见 §4 末尾）。

### 1.1 `src/sysprompt/hub.ts:357` — prompt-section hub（pre-guard，主/子会话都有）

- 注册：`pi.on("before_agent_start", onBeforeAgentStart)`（hub.ts:357）；pre-guard 装配在
  `src/index.ts:174-179`（hub 先建、memory 先注册，agent-types/models post-guard 补注册）。
- 读字段：**只读 `event.systemPrompt` 与 `event.systemPromptOptions?.cwd`**（hub.ts:292-296，
  `SectionProviderInput.promptText = event.systemPrompt`）——union 两种变体都带这两个字段
  （1.2 types.d.ts `BeforeAgentStartEventBase`），**typecheck 不炸、custom run 不会崩**。
- 误触发副作用（custom-message run 现在也会进 handler，全部为新行为、无崩溃）：
  - `userTurnSeen = true`（hub.ts:285）：唤醒 run 也算"见过用户轮" ⇒ `handleContextWithSystem`
    的首请求 seeding 分支（hub.ts:344-353 `!first || userTurnSeen` 拒绝）在"进程首个 run 是唤醒 run"
    场景下不再触发——但 1.2 下该唤醒 run 自己已走 onBeforeAgentStart 折叠+capture，seeding 本就多余，属死路径而非 bug。
  - `prefixFresh` 消费 + `markStale`（hub.ts:287-290）：session_compact/model_select 后紧接着来的
    唤醒 run 现在**就会**刷新冻结快照（1.1 要等下一个用户轮）；§4.5"只在新鲜轮边界刷新"不变量仍成立
    （唤醒 run 也是新鲜轮边界），行为差为快照刷新时机提前。
  - 尾部更新 `message`（hub.ts:312-321）：section 更新消息现在也会**加到唤醒 run 上**（(A)：handler
    messages 两种 run 都挂）——1.1 唤醒轮从不携带 section 更新消息；语义上与 pi 设计一致，但唤醒轮
    transcript 会多出更新条目。
  - `replay.capture(...)`（hub.ts:303-311）：见 §2。
  - memory 注入：经 hub 折叠（`src/memory/inject.ts` provider 只读 ctx/systemPrompt，不读用户
    prompt）——1.2 下唤醒 run 的 system prompt 也带 memory 段（1.1 唤醒轮没有 memory 段，这正是
    当年 prefix 反复失效的根源之一）。方向正确。
- compat 探测（`getTranscriptHelpers`/`tryGetSystemPrompt`/`readForceSystemPrompt`）不受 (A)/(B)
  影响，`forceSystemPrompt` 字段 1.2 仍在（system-prompt.js:12,127 两版相同）。

### 1.2 `src/title/index.ts:234-238` — 首标/里程碑标题（post-guard，仅主会话）

- 读字段：`trigger.onBeforeAgentStart(event.prompt, ...)`（index.ts:238）**无条件读 `event.prompt`**。
- 1.2 后果：typecheck 报错（T1，baseline 已证）；运行时 custom 变体上 `event.prompt === undefined`，
  传进 `title.ts` 后 `const trimmed = prompt.trim()`（title.ts:436）对 undefined 调用会同步 throw，
  被 pi 的 per-handler catch 吞成 emitError——触发条件=会话未命名 + 无在途生成 + 首个 run 恰为唤醒
  run（如启动即收到通知），此时首标生成失败。
- 计数副作用：`inputSeq++ / inputsSinceGen++`（title.ts:429-432）无条件执行——**唤醒 run 现在也计数**，
  与 v1 拍板"唤醒轮不计入用户输入"（docs/dev/title/plan.md:97）相反；里程碑刷新会提前到达。
- 修法方向：handler 首行 `if (event.messageType !== "user") return;`（或对 custom 只跳过计数与首标）。

### 1.3 `src/date/index.ts:103-125` — 日期注入（pre-guard）

- 读字段：**不读任何 event 字段**（只收 ctx）——union 安全，typecheck/运行时都无恙。
- 副作用：`firstTurnPending` 的首轮注入现在可能**落在唤醒 run 上**（1.1 等用户轮或走 turn_end 的
  `sendMessage(triggerTurn:false)`）；内容幂等（同日只注入一次，`lastInjected` 闸门），影响仅是"首轮"
  记录挂进 custom run 的 transcript。无需适配。

### 1.4 `src/feishu-notify/index.ts:504-506` — taskPrompt 捕获（post-guard）

- 读字段：`if (event.prompt) taskPrompt = event.prompt;` —— 有守卫，custom run 上 prompt 缺失时
  **保留上一个用户任务的 taskPrompt**，恰是想要的语义（唤醒轮延续当前任务）。
- 但 typecheck 仍炸：union 上访问 `.prompt` 本身就是编译错误（baseline T1 的两处 `.prompt` 之一），
  需改成 `event.messageType === "user" && event.prompt` 或 narrow。行为面无需适配；配合其
  agent_start 的 `isUserRun` 判定（`userInputPending`/`taskStartedAt`，feishu-notify/index.ts:517-531），
  唤醒 run 依旧按"扩展触发续跑"抑制结果卡，不受 (A) 影响。

---

## 2. `wake-replay.ts` / `compat.ts` / `hub.ts`：唤醒回放与 1.2 原生修复的关系

机制（1.1 语义）：

- **capture**：每次 before_agent_start（hub.ts:303-311）把折叠后的 systemPrompt（与
  `event.systemPrompt` 不同时；或 `adoptForeignForcedPrompt` 时的外来强制文本，
  `readForceSystemPrompt`＝读 `event.systemPromptOptions.forceSystemPrompt`，compat.ts:9-16）存进
  `WakeReplay` 闭包（wake-replay.ts:88-106，单状态捕获细胞）。
- **apply**：每个 provider 请求的 `context_with_system`（compat.ts:29-35 注册；hub.ts:329-353
  `handleContextWithSystem`）：captured 存在 ⇒ `buildReplayMessages`（wake-replay.ts:63-79）按 pi
  强制投影形态重建消息头（`[ {role:"system", content: forced, toolsAdded, timestamp}, …非 system ]`）。
- **"唤醒 run"的判定是隐式的**：没有标志位——只要 captured 非空就对**每个**请求回放；用户轮请求
  本身已被 pi 用同一 forced 字节投影，回放幂等（wake-replay.ts:37-46 文档化不变量：对自身输出再投影
  是 no-op）。1.1 下唤醒 run 不走 before_agent_start、无 forced 文本，正是回放补的对象。

1.2（(A)+(C) 原生修复）之后的评估：

1. **不会重复注入**：唤醒 run 现在自己经过 before_agent_start ⇒ hub 返回折叠后的 `{systemPrompt}`
   ⇒ pi 以 run 级 force 渲染整个 run（(C) 保证工具调用后不丢）；回放 handler 对同一请求再套一次投影
   形态 ⇒ 幂等 no-op（字节相同，且回放是**替换**头消息而非追加）。stable 模式下快照确定性保证两次
   capture 字节一致，无漂移。
2. **capture 在唤醒 run 上刷新**（hub.ts:303）——stable 模式产出相同字节，无害；live 模式每次刷新
   本就如此。seed 分支（hub.ts:344-353）退化为死路径（见 §1.1）。
3. **R5a 外来强制文本收编**（hub.ts:333-343）机制不变：`tryGetSystemPrompt(ctx)` 在 1.2 仍渲染
   currentOptions（含 forceSystemPrompt），`context_with_system` 事件与 `pi.on` 重载都在
   （1.2 types.d.ts:688/1081/1201；`emitContext` runner.js 两版相同）。
4. **结论/决策点**：`systemPrompt.wakeReplay`（默认 on，settings.ts:514-518）在 1.2 下变成冗余但
   字节安全的层；可以保留（幂等），也可以在升级时把默认改为 off（off ⇒ `registerContextWithSystem`
   根本不注册，hub.ts:358，行为=回放层不存在）。风险只剩维护面：若 pi 未来改投影形态，
   `buildReplayMessages` 会与原生投影分叉（GetCurrentSystemMessage 仍由 pi-ai 1.2 提供，未变）。
   建议升级 PR 里二选一拍板并更新 `docs/dev/sysprompt-stable/*`。标记：**待验证**（真机抓一次 1.2 下
   唤醒 run 的首请求字节，确认与用户轮同谱系——baseline 未覆盖此项）。

---

## 3. `sendUserMessage(` 调用点（src 生产代码全量）

类型面：`ExtensionAPI.sendUserMessage(content, {deliverAs?, expandPromptTemplates?})` 1.1↔1.2
**签名完全未变**（两版 types.d.ts 逐字相同，仅行号平移）；(B) 的"必须带 deliverAs"只是 busy 窗口
内的运行时约束（无 deliverAs ⇒ prompt() 抛 "Agent is already processing"）。

不带 deliverAs（busy 窗口内会抛、靠本地 catch 吞掉 ⇒ resume 文本丢失；1.1 下同类风险只在流式中）：

- `src/index.ts:355` — compact-hint 的 RESUME 重发（ctx.compact onComplete 内）。
- `src/index.ts:563` — switch_context 工具的 resume。
- `src/index.ts:593` — compact_context 工具的 resume。
- `src/tools/compact-tool.ts:163`、`:173` — 上两条的工具内落点（透传，无 options）。
- `src/tools/switch-context-tool.ts:371`、`:382` — 同上。
  这五处都只在 `ctx.compact({onComplete/onError})` 回调里可达；扩展手动 compact 通常发生在 idle
  （turn_end 触发/工具调用后 settle），1.2 新增的启动 busy 窗口是否可能覆盖这些回调：**待验证**
  （`_prepareRun` 开头的 pi 内部预压缩不经过扩展 onComplete，主嫌疑仅剩"压缩排队到 settle 后紧接着
  新 run 启动"的竞态）。稳妥修法：统一补 `{deliverAs:"followUp"}`。

带 deliverAs（无 (B) 风险）：

- `src/index.ts:672` — goal 续跑 `pi.sendUserMessage(text, {deliverAs:"followUp"})`。
- `src/goal/hook.ts:151`、`:188`、`:342` — goal 的 deps 落点（选项由 index.ts:672 装配决定）。
- `src/reload/index.ts:46` — 延迟 reload 的 `/agent reload fire`（followUp + expandPromptTemplates:true）。
- `src/topic-switch/release.ts:82`（item.deliverAs）、`:99`（"followUp" 兜底）。
- `src/topic-switch/command.ts` — deps 形参强制 `deliverAs: "steer"|"followUp"`，无裸调用。
- `src/web-hub/agent/commands.ts:346`、`:437` — `{deliverAs: cmd.deliver}`：**cmd.deliver 可为
  undefined**（浏览器未指定时）；busy 窗口/流式中会抛 → 已被 catch 映射为 `E_STALE_CTX` 回执，
  语义可接受（1.1 流式中同样如此），仅出现频率会随 busy 窗口变宽而升高。
- `src/web-hub/agent/builtin-bridge.ts:149`（deliverAs ?? "steer"）、`:174`（?? "followUp"）、
  `:306`、`:318`（均为 followUp）。

---

## 4. `sendMessage(` 带 `triggerTurn` 的调用点 + isIdle/报错依赖

### 4.1 `triggerTurn: true`（唤醒主会话；1.2 下这些唤醒 run 会经过 before_agent_start，且若落在

另一 run 的启动 busy 窗口内则**并入该 run**（steer 入队），不再另起 run——与既有"流式中排队"契约同构）

- `src/stack.ts:574` — fabric `sendRootContext`（`{deliverAs:"steer", triggerTurn:true}`，W1 唤醒）。
- `src/stack.ts:735` — bash job 完成通知（`bash-job:notification`）。
- `src/stack.ts:1783`（单条）/`:1797`（digest） — subagent 完成通知（outbox 发送口 sendFormatted；
  `/task` 的完成通知也走这里；`/goal` verifier、mention 复活等经 spawn→notifier 同路）。
- `src/stack.ts:2732` — workflow 宽限通知（`workflowDeliveryOptionsFor`：grace⇒true，extended⇒false）。
- `src/adapters/workflow-notice.ts:129` — 存活期 workflow 落定通知（true）；`:230` 重投递为 false。
- `src/delivery/deadline-notice.ts:123`（`deliveryOptionsFor`，grace⇒true）被 `src/stack.ts:1818`
  消费。
  这些调用点**都不期望独占新 run**，并入启动中的 run 是等价或更优语义；无适配需求。

### 4.2 `triggerTurn: false` / 无 options（纯上下文，(A)/(B) 零影响，仅罗列核对）

- false：`src/quota/hook.ts:287`、`src/sysload/hook.ts:99`、`src/todo/index.ts:555`、
  `src/bash/child.ts:300`（子会话宽限提醒，E11 明令永不 true）、`src/context-switch/child.ts:350`、
  `src/date/index.ts:140`、`src/ask-user/index.ts:562`、`src/commands/task.ts:186`（/task 启动记录）、
  `src/adapters/workflow-notice.ts:230`。
- 无 options（idle 追加、永不唤醒）：`src/mention/mention.ts:116`、`src/index.ts:1011`（mention 错误）。
- `deliverAs:"nextTurn"` 无生产使用（仅 `src/commands/task.ts:19` 注释解释为何不用；注意 1.2 下该
  注释的理由已弱化——nextTurn 消息现在也随 custom-message run 投递）。

### 4.3 依赖 `ctx.isIdle()` / "Agent is already processing" 的逻辑

- 报错字符串：src **零依赖**（grep 仅 docs 命中）；`sendMessage` 路径本就不抛该错。
- `src/stack.ts:1597` — ask-user backgroundCompletions 的 `isStreaming = !ctx.isIdle()`：启动窗口
  现在也算 streaming ⇒ 更保守（记 token/中断方向安全），无需适配。
- `src/goal/hook.ts:182` — 投递看门狗把 `!ctx.isIdle()` 视为"已观察到新 run"：1.2 下若看门狗触发时
  恰有别的 run 在启动，会误判"已送达"而跳过重试——无害（重试只是兜底）；`:393` onAgentSettled 的
  `!ctx.isIdle()` 兜底：settled 在 `_isAgentRunActive=false` 后 emit（两版相同），行为不变。
- `src/web-hub/agent/commands.ts:309` — prompt-gate 只在 idle 认领：busy 窗口变宽 ⇒ 认领变少、
  走原生分发（fail-open 方向），符合设计。
- `src/web-hub/agent/hold-driver.ts:286`（canHold 要求 busy）、`:460` — 启动窗口也算可 hold 的
  busy，与 steer-recall 语义一致。
- `src/web-hub/agent/status.ts:52`、`src/web-hub/agent/builtin-bridge.ts:347` — busy 展示/检查，
  展示面略变宽，无碍。
- `src/session-nav/index.ts:96` — `/resume-recent` 在 busy 时拒绝：启动窗口也会被拒（略更保守）。
- `src/topic-switch/wire.ts:309`（streamingPending 屏障）、`:620`（status idle）— 屏障另有
  `sawAgentStart` 信号，不受影响；`src/topic-switch/command.ts:76`（`__go` 跳板 preflight
  `!ctx.isIdle()` 拒绝）— 命令分发发生在 prompt() 的 `_tryExecuteExtensionCommand`，早于
  streaming 检查与 `_startRun`，handler 时刻仍 idle：**待验证**（真机确认 1.2 下跳板路径不回退）。
- topic-switch 判定本身在 `input` handler（只 hold interactive/rpc，永不 hold 自己的 extension
  重注），(A)/(B) 不改 `InputEvent`（1.2 types.d.ts 无该 hunk）⇒ 无直接影响；但 baseline C1
  （topic-switch-hop S4 modelRuntime.callCount 3→2）正是 (B)：连续 followUp 重注在启动窗口内并成
  一轮——需按 1.2 语义改测试等待条件，I2（每条恰好一个 input 事件）仍成立。

---

## 5. 版本范围与锁定它们的测试

- `src/adapters/pi-compat.ts:130` — `TESTED_PI_RANGE = "1.0.0 - 1.1.0"`；`:248-255`
  `isWithinTestedRange` 只认 minor 0|1 ⇒ **1.2.0 仅 WARN 不拒绝**（assertCompatible :239-244）。
  放宽=改常量+`minor === 2`（或区间化）。
- `package.json:48-50` — peers `>=1.0.0 <1.2.0`（pi-ai / pi-coding-agent / pi-tui 三个都要一起放）；
  `:65-67` devDeps `^1.1.0`（升 `^1.2.0`）。pi 1.2.0 自身捆绑 pi-ai 1.2.0。
- `src/web-hub/protocol/spawn.ts:695` — `SUPPORTED_PI_RANGE = {min:"1.0.0", maxExclusive:"1.2.0"}`
  —— **硬失败**：`src/web-hub/hub/spawn/launcher-check.ts:200-204` 判 incompatible ⇒ managed
  spawn / session history / relaunch / restore 在 pi 1.2.0 上全部关闭（baseline C2，conformance
  `tests/conformance/history-restore.test.ts` RH1–RH4 因此失败）。
- 锁死范围的测试（对照 b86b86a 的 1.1.x 放宽提交，文件清单一致）：
  - `tests/adapters/pi-compat.test.ts:33-43` — 断言 1.2.0 落在"warning 档"；放宽后要翻成"无 warning"
    并补 1.2.x 在范围内的正例（同提交里 1.1 时的写法）。
  - `tests/web-hub/hub/spawn/launcher-check.test.ts:129-135`（`["0.99.0","1.2.0","2.0.0"]` ⇒
    incompatible）、`:138-143`（1.1.0 在范围内）— 1.2.0 要从坏例挪出，加 1.2.x 正例。
  - `tests/web-hub/hub/spawn/supervisor.test.ts:1147-1155` — `badPkgFs("1.2.0")` ⇒
    `E_LAUNCHER/incompatible`，同样要换坏例边界（改为 1.3.0 / 2.0.0）。
  - `tests/web-hub/protocol/spawn.test.ts:307-314` — **双重锁**：断言 SUPPORTED_PI_RANGE 与
    package.json peerDependencies 字符串互镜 + 字面量 `{min:"1.0.0",maxExclusive:"1.2.0"}`。
  - `tests/web-hub/hub/hub-spawn.test.ts:71-76` — launcher fixture 写死 1.0.0 pkg（范围内，不必改）。
  - `AGENTS.md:735` — "pinned to `>=1.0.0 <1.2.0`" 的行文要同步（b86b86a 同款）。
  - b86b86a 还动了 `package-lock.json` 与 `tests/conformance/tui-harness.ts:94`
    （`FakeTerminal.setProgramStatus()`，pi-tui 1.1 新增）——pi-tui 1.2 若再添 Terminal 方法，需
    同点补 stub：**待验证**（diff pi-tui 1.1↔1.2 的 Terminal 接口）。
- 升级闸门（仓库规矩）：`npm run test:conformance`（consult-preserve C1–C7、context-switch
  capability、ask-user TUI、web-hub history restore）——pi-compat 的结构探测本身不锁版本（I14）。

---

## 6. 引用 API 的签名差异（全局 1.2.0 vs 本地 1.1.0 `.d.ts`）

`extensions/types.d.ts` 全部实质 diff 只有 4 个 hunk；其余变动文件与我们的引用面交叉如下：

| API（我们引用处）                                                                                                                                                                 | 1.1 → 1.2 变化                                                                                                                                                                                                                      | 影响                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BeforeAgentStartEvent`（`src/sysprompt/hub.ts:2,284`；`src/title/index.ts:238`；`src/feishu-notify/index.ts:505`）                                                               | 改为 union：`BeforeAgentStartUserEvent`（`messageType:"user"` + `prompt`/`images`）｜`BeforeAgentStartCustomEvent`（`messageType:"custom"` + `message`，**无 `prompt`**）；`systemPrompt`/`systemPromptOptions` 留在 base，两态都有 | **编译失败 2 个文件**（title:238、feishu-notify:505，即 T1）；hub 只读 base 字段，安全。修法：按 `event.messageType === "user"` narrow                                                                                                |
| `ExtensionAPI.sendMessage` / `sendUserMessage` / `ReplacedSessionContext.*`（§3/§4 全部调用点）                                                                                   | **签名逐字未变**（deliverAs 仍是可选）                                                                                                                                                                                              | 无类型影响；(B) 是纯运行时行为（busy 窗口）                                                                                                                                                                                           |
| `ExtensionContextActions.isIdle`（§4.3 各点）                                                                                                                                     | 未变（注释同）                                                                                                                                                                                                                      | 无                                                                                                                                                                                                                                    |
| `ContextWithSystemEvent` + `pi.on("context_with_system")`（`src/sysprompt/compat.ts:29-35`）                                                                                      | 未变（types.d.ts:688/1081/1201；runner `emitContext` 相同）                                                                                                                                                                         | 无；wake-replay 通道仍在                                                                                                                                                                                                              |
| `NormalizedBuildSystemPromptOptions.forceSystemPrompt`（`src/sysprompt/compat.ts:9-16`）                                                                                          | 未变（system-prompt.js 两版相同）                                                                                                                                                                                                   | 无                                                                                                                                                                                                                                    |
| `ToolNamespace.aliases?`、`ToolDefinition.reachesTools?`、`ToolInfo += reachesTools`（`src/runtime/tool-scope.ts`、`src/consult/preserve-identity.ts` 消费 `ToolInfo`/tool 定义） | 纯新增可选字段                                                                                                                                                                                                                      | 类型兼容（我们只读 name/description/parameters 等）；consult C2 preserve 对声明做字节级快照——若快照序列化整对象，**新字段会进指纹**：待验证（看 preserve-identity 的指纹范围；pi 自有工具的声明多一字段不破坏匹配，因为我们照抄快照） |
| `ExtensionRunner.emitBeforeAgentStart(trigger, options)`（runner.d.ts）                                                                                                           | 签名从 `(prompt, images, options)` 改为 `(BeforeAgentStartTrigger, options)`                                                                                                                                                        | 内部 API；src 仅 `src/date/index.ts:14` 注释提及，无调用；conformance 不直接调                                                                                                                                                        |
| `AgentSession._runAgentPrompt` → `_startRun`/`_prepareRun`（agent-session.d.ts）                                                                                                  | 私有方法重命名/新增                                                                                                                                                                                                                 | src/tests 无引用（grep 证实）；仅文档引用（如 `docs/dev/**` 的 1.1 行号考据会过期，不锁行为）                                                                                                                                         |
| `serializeConversation`（compaction/utils.d.ts）                                                                                                                                  | (D)：不再包含 thinking 块（注释明示）                                                                                                                                                                                               | src/tests/scripts **零引用**（grep 证实）⇒ 无影响                                                                                                                                                                                     |
| `pi mcp list --json`（(D)）                                                                                                                                                       | 格式变化                                                                                                                                                                                                                            | src/tests/scripts **零引用** ⇒ 无影响                                                                                                                                                                                                 |
| `settings-manager.d.ts`                                                                                                                                                           | 大规模类型搬移重导出（Settings 系列挪走）                                                                                                                                                                                           | 我们只 `import { SettingsManager, DefaultResourceLoader }`（`src/runtime/session-driver.ts`），root export 未变 ⇒ 无影响                                                                                                              |
| `model-config.d.ts`                                                                                                                                                               | TypeBox 形状抖动（thinkingLevelMap 键序、`Type.Enum`、compat Omit）                                                                                                                                                                 | 我们不镜像该 schema（`src/config/available-models.ts` 走 registry）⇒ 无影响                                                                                                                                                           |
| 主题/TUI（theme.d.ts、status-indicator.d.ts）                                                                                                                                     | 有变动                                                                                                                                                                                                                              | 我们只 `getMarkdownTheme()`（`src/index.ts` 经由 re-export，签名未变）；conformance FakeTerminal 见 §5 待验证项                                                                                                                       |

---

## 结论速览（供方案阶段直接引用）

1. **必改（编译）**：`src/title/index.ts:238`、`src/feishu-notify/index.ts:505` 按 `messageType`
   narrow（title 同时决定唤醒轮是否计数/首标，建议直接 `"user"` 早退）。
2. **必改（硬门）**：`SUPPORTED_PI_RANGE` + peers + TESTED_PI_RANGE + §5 列出的 4 个测试 +
   AGENTS.md（照抄 b86b86a 模式，maxExclusive → 1.3.0，TESTED → 1.0.0 - 1.2.0）。
3. **行为面待拍板**：`systemPrompt.wakeReplay` 保留（幂等冗余）或默认关（§2.4）；title 唤醒轮计数
   语义（§1.2）；hub 在唤醒轮上的快照刷新/尾部更新消息（§1.1，可接受现状）。
4. **建议顺手加固**：§3 的 5 个无 deliverAs 的 `sendUserMessage` 补 `{deliverAs:"followUp"}`；
   `/topic-switch __go`、compact onComplete 时序按 1.2 真机复验（两处"待验证"）。
5. **测试面**：topic-switch-hop S4 等待条件按 (B) 修（baseline C1）；conformance 全套（含
   history-restore）在放宽后必须全绿。
