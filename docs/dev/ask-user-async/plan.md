# ask_user：后台完成打断（background interrupt）· 施工方案 v2（评审修订版）

> 状态：**方案 v2**（评审第 1 轮打回后修订，待复审）。制定：Plan 子代理（只读调研 + 本文）。
> 基线：HEAD `e96c0f7`（upload U1 已提交），pi `0.87.1`（devDependency 与全局安装同版本，下文 pi 行号均指
> `node_modules/@earendil-works/pi-coding-agent/dist/...`，与全局安装逐行一致，已核验）。
> 目录名 `ask-user-async/` 沿用立项名，实际范围见 §0′。

## 0. v2 修订记录（评审第 1 轮：1 blocker + 6 严重 + 4 一般 + 1 建议）

| 评审 | 级别    | 问题（摘要）                                                     | 处置                                                                                                                                                                           | 落点                |
| ---- | ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| #1   | blocker | S0 用 fake `ui.custom`，没覆盖真实 `showExtensionCustom.close()` | **全量吸收**：S0 改为真实 `InteractiveMode` + 假 `Terminal` 的进程内 harness（降级为 tmux 真进程 harness），三种时序 × 编辑器/焦点/dispose/ui_prompt 判据                      | §2.1、§2.2          |
| #2   | 严重    | FIFO 队列改变了同批多个 ask_user 的正常路径                      | **裁定为经批准的行为变更**（用户决策②）。另查明今天同批两个 ask_user 本身会挂死（第二个框把第一个挤掉、第一个永不 resolve），FIFO 同时是修复。补 R1–R4 回归                    | §0′、§5.3、§10 P1   |
| #3   | 严重    | `cancel()` 得到 `null`，`classifyOutcome` 识别不出 interrupted   | **按评审实现**：`runTuiInteraction`/`runRpcInteraction` 改返回 discriminated `InteractionOutcome`（带 winner），给出 race × `session.close` 规则表                             | §5.1                |
| #4   | 严重    | 达到上限后 sticky 重新阻塞                                       | **已定项**（用户拍板 3 次）：达上限后回到今天的阻塞行为，是**已接受的降级**；写明含义与验收                                                                                    | §5.2.4、§11         |
| #5   | 严重    | `noteSent` 在 `sendMessage` 后，未确认真正入队                   | **按评审实现**：发送适配层 `createCompletionSender`（同步抛错不记账）+ 兼容假设 A1–A4 写入 `pi-compat.ts` 注释 + conformance 断言 + 运行期自检（连续 2 次未确认 ⇒ 进程内停用） | §3.2、§3.4、§2.2    |
| #6   | 严重    | P2 的 settings 文件与 upload U1 冲突                             | **已过时**：U1 已提交（`e96c0f7`）；P2 在其后 rebase 即可。拆包表改写前提声明                                                                                                  | §10                 |
| #7   | 严重    | hub `dispose()` 未接入 teardown                                  | **全量吸收**：三条 teardown 路径（`buildSessionStack` 顶部 previous-instance、`session_start` 防御块、`session_shutdown` 首位），并规定先于 coalescer dispose；补测试          | §3.3、§10 P2        |
| #8   | 一般    | 时序参数无依据、优先级/起算点未定义                              | **全量吸收**：参数总表（默认/范围/起算/重置/优先级/0 与非法值）+ 截止时间公式 + 最大延迟 + fake clock 用例；`maxDefer` 60s→20s、`dwell` 15s→10s                                | §5.2                |
| #9   | 一般    | `queuedUnconsumed` 按业务 key 出队会错配                         | **全量吸收**：改为「每次 send 一枚 token、按 `message_start` 顺序 + 内容哈希确认」的状态机；digest/缺 key/同类型并发/重投/错序用例                                             | §3.4                |
| #10  | 一般    | web 新 `by` 值只改了 TS 联合；RPC 打开后客户端残留               | **全量吸收**：同步运行时 schema（`messages.ts:861-875`），新增 hub cap `dialog.bg.v1`，旧 hub 下降级为 `abort`；兼容测试清单；RPC 开关语义写明「关 = 不提供中途打断」          | §7                  |
| #11  | 一般    | 模型重问只是提示，compact/reload 后丢题                          | **语义已接受（尽力而非保证）+ 吸收健壮性**：parked 状态写 session entry（`getBranch` 恢复）、压缩后补一条不触发轮次的提醒；可测验收标准                                        | §4、§6.3、§6.4、§10 |
| #12  | 建议    | one-at-a-time 只是间接验证                                       | **吸收**：S0 直接断言 `steeringMode` = `one-at-a-time` / `all` 下 custom steer 的消费数量与顺序；写 pi 升级失败处理策略                                                        | §2.2 C9–C10、§2.4   |

## 0′. 范围（用户需求收窄，v1 作废）

用户原话：「对于 ask user，如果有 background 任务，bash 或 agent，当任务结束了，可以继续触发 agent turn，其他情况我觉得可以继续卡住」。

| 维度        | v1（作废）                  | 本方案                                                                             |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------- |
| 正常路径    | 非阻塞，返回 askId 占位     | **单个 ask_user 完全不变**：execute() 照旧 await 模态框，答案照旧是同步工具结果    |
| 新参数/协议 | `wait:true`、异步答案消息   | **无**（工具 schema、description、promptSnippet、promptGuidelines 一字不改）       |
| 新增机制    | 对话管理器 + 游离 ui.custom | 对话框挂起期间有后台任务**完成** ⇒ 从 execute 栈外打断，返回「被打断、未获答」结果 |
| 问题去向    | 管理器异步再呈现            | parked：**模型重问**（尽力提示，非保证），扩展负责草稿恢复、防抖、持久化与提醒     |
| 待答队列    | 管理器队列                  | 同批多个 ask_user 由 FIFO 串行呈现——**经批准的行为变更**（用户决策②，§5.3）        |

**明示的行为变更（且仅此一处）**：同一工具批次里多个 ask_user 由「并发调用 `ui.custom`」变为「按 execute 开始顺序逐个弹出」。
今天的并发行为本身是缺陷：`showExtensionCustom`（`interactive-mode.js:2290-2295`）对第二个框执行
`editorContainer.clear()` 后挂上第二个组件，第一个组件被移出界面、其 Promise 永不 resolve，只能靠 Esc 中止整个 agent。
单个 ask_user 的调用时序与结果保持字节级不变（§10 P1 回归 R1）。

## 1. 现状与关键事实（已按 `e96c0f7` 核验）

### 1.1 阻塞链

- `src/ask-user/index.ts:267` `execute()` → `:288-291` 按 mode 调 `runRpcInteraction`（`:144`）/ `runTuiInteraction`（`:50`）。
- TUI：`:75` `await ctx.ui.custom(...)`；组件 `submit()`/`cancel()` 在 `src/ask-user/component.ts:368-379`（`_resolved` 保证只 `done` 一次）。
- RPC：`:169` `await askUserInteract(...)` → `src/ask-user/channel-handler.ts:57-80` 的 `ctx.ui.select(ASK_USER_MARKER, …)`。
- pi 工具循环：`pi-agent-core/dist/harness/runtime/drive/tools.js:240` `performToolInvocation` await execute；`:445-447`
  默认并行批次，批次全部 settle 才进 boundary。**推论：同批里只要还有一个 ask_user 挂着，整批都卡住**（§5.2 广播打断的理由）。
- `ui.custom` 经 `core/extensions/runner.js:325` `withUIPrompt` 包装（`:328-339`，深度计数，`.finally(finish)` 发 `ui_prompt_end`）。
- TUI 实现 `modes/interactive/interactive-mode.js:2237-2307` `showExtensionCustom`：
  - `close()`（`:2250-2266`）：`closed` 闩锁 → `restoreEditor()`（`:2240-2246`：editorContainer 换回编辑器、`setText(savedText)`、
    `setFocus(editor)`、`requestRender`）→ `resolve` → `component?.dispose?.()`。
  - 挂载在 `Promise.resolve(factory(...)).then(c => …)`（`:2267-2297`），即 **factory 返回后的一个 microtask** 才
    `editorContainer.addChild(component)` 与 `setFocus`；若此前已 `close()`，`.then` 见 `closed` 直接返回（不挂载，也不 dispose，
    因为 `component` 尚未赋值）。这是 §2 时序 T2 的来源。

### 1.2 「栈外打断」先例：web 应答路径

`index.ts:66-73`：web 回调在 execute 栈外 `race.claim("web")` 成功后 `component?.cancel()`；`:87` 处理「factory 运行时已有赢家」
（`queueMicrotask(() => component?.cancel())`）；`:97-106` 按 winner 合成结果。RPC 同款 `:162-166`（claim 后 `localAbort.abort()`，
经 `combinedSignal` `:131-143` 并入 select 的 signal）。仲裁原语 `src/ask-user/remote.ts:35-46` `createDialogRace`：同步 first-claim-wins。
**打断 = 在这个 race 上加 claimant `"background"`，不另造机制。**

### 1.3 后台完成通知的发送点

全部在 `src/stack.ts`，全是 `pi.sendMessage(…, { triggerTurn: true })`：

| 来源                 | 位置                                                                                                                                | customType                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| subagent run 终态    | `sendFormatted`（`:1518`）内 `:1541`（单条）/ `:1554`（digest）；coalescer/ackHold（`:1593-1613`）延迟后同样经 `sendFormatted` 发出 | `subagent:notification`           |
| workflow 终态        | sink 注入 `:2466-2473`（`sendMessage` 在 `:2469`），调用方 `src/adapters/workflow-notice.ts:120-130` live 分支                      | `subagent:workflow-notification`  |
| 后台 bash job settle | `buildBashJobManager`（`:579`）的 `notify`（`:642-659`）                                                                            | `bash-job:notification`（`:237`） |

子 run / caller-owned run 在 `src/service/runtime-adapter.ts:352-359`（`notificationSuppressedRunIds`）前就被挡掉；caller-ack、coalesce
都在 send 之前。**挂在 send 点天然继承所有既有抑制策略**——不用 `subagent:completed` 生命周期事件（`stack.ts:1749-1750`，含嵌套 run）。
不接的发送点：bash grace/extended（`:621-640`，用户拍板不打断）、workflow 重投（`:2489`，不 triggerTurn）、`subagent:timeout`。

### 1.4 pi 的投递语义（S0 要锁定的兼容假设来源）

- `ExtensionAPI.sendMessage` 返回 `void`：`core/agent-session.js:2397-2405` 把 `sendCustomMessage(...)` 的 Promise `.catch` 到
  `runner.emitError`，扩展侧抓不到异步失败（`src/adapters/pi-compat.ts:82-86` 已记录 `sendUserMessage` 同类事实）。
- `sendCustomMessage`（`:1481-1519`）：streaming 且 `triggerTurn !== false` ⇒ `agent.steer(appMessage)`（`:1494-1500`），在函数第一个
  `await` 之前同步执行；`appMessage.content` 直接取自调用方（`:1486`）。
- boundary 注入：`pi-agent-core/.../drive/boundary.js:32-35`，`steeringMode === "all"` 取全部，否则只取 1 条；默认 `"one-at-a-time"`
  （`core/settings-manager.js:485`）。注入时触发 agent 事件 `message_start/message_end`（role `custom`），`agent-session.js:583-588`
  在 `message_end` 上持久化。
- `ctx.hasPendingMessages()` 不可用：`pendingMessageCount`（`:1591-1593`）只数文本 steer（`_steeringMessages`，`:1433` 入队），custom steer 不在其中。

推论：(1) 打断 → 批次 settle → boundary 注入通知 → 下一次请求里模型同时看到「被打断」结果与通知，**无需额外 triggerTurn**；
deliverAs 不改（steer 正确，followUp 要等 agent 本想停下）。(2) one-at-a-time 下 N 条完成只有 1 条随打断进上下文，模型立刻重问会再把其余卡住 ⇒ §5.4 deferred。

### 1.5 其他相关现状

- 工具文案被 `tests/ask-user/prompt-quality.test.ts:45-47` 逐字钉死——**不改**，模型叙事全在结果文本里。
- web：`attributePrompt`（`src/web-hub/agent/dialogs.ts:312`）在生产中**未接线**（`src/web-hub/agent/index.ts:250` 传恒等函数），零改动。
- hub 对 agent 帧做运行时校验：`decodeAgentFrame` → `Value.Check`（`messages.ts:1038-1056`），`dialogs` 帧 schema 在 `:877-885`，
  `DialogClosedSchema.by` 是 5 个字面量的联合（`:861-875`）。**未知 `by` 会让整个 dialogs 帧被丢弃**（§7.2 的兼容问题根源）。
- caps 机制：agent 侧 `connection.caps`（`src/web-hub/agent/connection.ts:122-123,341`）来自 `hello_ack.caps`；hub 侧广告点
  `src/web-hub/hub/hub.ts:229`、`src/web-hub/hub/agent-server.ts:153`（U1 的 `UPLOAD_HUB_CAPS` 刚按同法加入，可照抄）。
- 持久化先例：`src/todo/index.ts:180-203`（`restore` 用 `getBranch()` + `replayState`）、`:202-204`（`persist` = `appendEntry` 全量快照，
  在工具 execute 内调用，如 `:330-334`）、`:458-460`（`session_start/session_tree/session_compact` 三处 restore）。
- 子会话没有 ask_user（`src/index.ts:281-287`），无交互。

## 2. S0：真实 TUI close 路径 + pi 投递语义（第一步，阻断 P1/P2）

### 2.1 harness

**S0-A（首选，进程内）**：`InteractiveMode` 已导出（`dist/index.d.ts:28`），且 `InteractiveModeOptions.terminal?: Terminal`
（`modes/interactive/interactive-mode.d.ts:39-40`；`tui-renderer.js:7` `options.terminal ?? new ProcessTerminal()`）。新增
`tests/conformance/tui-harness.ts`：

- `FakeTerminal implements Terminal`（接口 `pi-tui/dist/terminal.d.ts:20-39`）：`start(onInput)` 保存输入回调，`write` 累积输出，固定 `columns/rows`；
  暴露 `type(data)`（同步调 `onInput`）与 `screen()`（按最后一帧解析出可见行）。
- 运行时：`createAgentSessionRuntime(...)`（`dist/index.d.ts:19`）+ 复用 `tests/conformance/pi-boundary.test.ts:15-60` 的脚本化 fake model，
  `extensionFactories` 注入被测扩展；`new InteractiveMode(runtime, { terminal, tuiMode: "inline" })` → `await mode.init()`（`d.ts:138`），不调 `run()`。
- 被测扩展：S0 阶段为 60 行探针扩展 `ask_probe`（在 execute 里 `await ui.custom` 挂一个记录 `render/handleInput/dispose` 调用的组件，暴露
  `fire(timing)`：先经 `pi.sendMessage({customType:"bash-job:notification",…},{triggerTurn:true})` 投一条通知，再 claim + cancel）。
  P1+P2 落地后同一测试切到真 `wireAskUser` + 真 hub + 真后台 bash（`sleep 1` 后台 job）复跑。
- 时间盒：0.5 天。若 `InteractiveMode.init()` 依赖真实 TTY/全局主题等无法在 vitest 内起来，转 S0-B。

**S0-B（降级，真进程）**：tmux 起真 `pi`（按 memory `live-acceptance-tmux` 流程），provider 用 `models.json` 指到本地脚本化
OpenAI 兼容 mock server（确定性回放 tool call），探针扩展经 `-e` 加载（只测主会话，`-e` 可用）；`capture-pane` 断言屏幕，
`send-keys` 注入按键。S0-B 进 `scripts/acceptance/ask-user-interrupt.sh`，不进 CI。

### 2.2 判据

时序（均在 dialog 所在工具挂起时、编辑器预先输入 `draft-xyz` 后触发）：

- **T1 factory 前**：`ui.custom` 调用前 race 已有 background 赢家 → factory 内 `queueMicrotask(cancel)`（`index.ts:87` 同款）。
- **T2 factory 后、挂载前**：factory 同步返回后、`.then` 挂载前（同一 microtask 间隙）claim+cancel → `close()` 先于挂载。
- **T3 挂载后与输入并发**：同一 tick 内 (a) 先 `type("1")` 后 claim；(b) 先 claim 后 `type("1")`；(c) `type("\r")` 提交与 claim 竞争。

| #   | 判据                                                                                                                                           | 时序     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1  | execute 在 1 个宏任务内 resolve，outcome 为 interrupted；无 unhandled rejection                                                                | T1–T3    |
| C2  | 关闭后屏幕可见编辑器且内容为 `draft-xyz`；随后 `type("abc")` 进入编辑器（焦点已恢复），编辑器文本为 `draft-xyzabc`                             | T1–T3    |
| C3  | 组件 `dispose` 恰好调用 1 次（T3）或 0 次且组件从未 `render`（T1/T2，与 `close()` 源码一致）；之后再无该组件的 `render/handleInput`            | T1–T3    |
| C4  | `ui_prompt_start`/`ui_prompt_end` 成对，第二次 `ui.custom`（重问）正常挂载、可输入、可提交                                                     | 全部     |
| C5  | T3(b)：claim 后的按键落到编辑器而非组件；T3(c)：先到者赢——提交先到则 outcome=answered 且通知仍在答案之后到达                                   | T3       |
| C6  | 下一次模型请求上下文顺序为 `assistant(toolCall) → toolResult → custom(bash-job:notification)`，期间无额外 agent run                            | 任一     |
| C7  | 扩展收到该 custom 的 `message_start`，`message.content` 与发送时的字符串 `===`（§3.4 内容哈希的前提）                                          | 任一     |
| C8  | 发送确认：`pi.sendMessage` 同步返回后，同一 tick 内 `session.agent.hasQueuedMessages() === true`（`agent-session.d.ts:196` `readonly agent`）  | 任一     |
| C9  | `setSteeringMode("one-at-a-time")`（`agent-session.d.ts:557`），工具挂起时连发 3 条：请求 k 依次各含 1 条，顺序 = 发送顺序，共经 3 个 boundary | 直接断言 |
| C10 | `setSteeringMode("all")`：同一请求含全部 3 条，顺序 = 发送顺序                                                                                 | 直接断言 |
| C11 | 非 streaming 时 send（agent 空闲）：立即起新 run，`message_start` 在该 run 内到达（§3.4「不记 token」规则的前提）                              | 直接断言 |

C6–C11 不依赖 TUI，放 `tests/conformance/ask-user-interrupt.test.ts`（`withSession` 风格 + `bindExtensions({ uiContext, mode:"tui" })`，
`agent-session.d.ts:143-145,597`），归入 `npm run test:conformance`；C1–C5 放 `tests/conformance/ask-user-interrupt-tui.test.ts`（S0-A）或 S0-B 脚本。

### 2.3 不成立时的处置

| 失败                      | 处置                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| C2/C3/C5                  | TUI 路径不安全：方案止步，`backgroundInterrupt.enabled` 默认 false，回报主会话                              |
| C6                        | 通知不随下一次请求到达：机制无意义，止步                                                                    |
| C7                        | 内容被改写：§3.4 退化为「按 customType FIFO」确认，接受同类型并发错配（只影响 deferred 计数）并记入已知限制 |
| C8                        | 非同步入队：发送适配层改为在 `message_start` 确认前不广播 → 打断无法触发（循环依赖），止步                  |
| C9 与预期不符（一次全取） | 删除 §5.4 deferred                                                                                          |
| C11                       | 非 streaming send 也记 token                                                                                |

### 2.4 pi 升级失败处理

- 遵循 AGENTS.md：升 pi peer 范围前先 `npm run test:conformance`；本组任一用例失败 ⇒ **不升**，或同一 PR 把
  `askUser.backgroundInterrupt.enabled` 默认改 false 并在 CHANGELOG 写明。不引入版本号门控（I14：`pi-compat.ts:1-6` 禁止按版本分支）。
- 运行期兜底（结构性、非版本）：§3.4 自检——一次打断依赖的 token 在该 agent run 的 `agent_settled` 前未被 `message_start` 确认，记一次失败；
  **连续 2 次**失败 ⇒ 本进程内停用打断（sticky 到重启），WARN 一次（同 `src/context-switch/capability.ts` 的「post-verified 连续 2 次才停用」先例）。

## 3. 数据源、发送适配与生命周期

### 3.1 消费方端口（`src/ask-user/background.ts`，新，pi-free）

```ts
export type BackgroundCompletionKind = "subagent" | "workflow" | "bash";
export interface BackgroundCompletion {
  kind: BackgroundCompletionKind;
  count: number; // digest 时 >1
  token: number | undefined; // §3.4；非 streaming 发送时 undefined
  at: number;
}
export interface AskUserBackgroundPort {
  subscribe(listener: (event: BackgroundCompletion) => void): () => void;
  /** 已同步入 steer 队列、尚未被 message_start 确认的 token 数。 */
  pendingTokens(): number;
  /** §2.4 自检：token 是否已确认；undefined = 未知（已 dispose / 不存在）。 */
  tokenState(token: number): "pending" | "consumed" | "orphaned" | undefined;
  readonly disabled: boolean; // 自检停用后为 true
}
```

### 3.2 提供方：`src/service/background-completions.ts`（新，pi-free）

`createBackgroundCompletionHub({ isStreaming, now })` 返回 `AskUserBackgroundPort` 加：

- `createSender(send: SendMessageFn)` → `sendCompletion(kind, message, options)`：
  1. `const streaming = isStreaming()`（发送**前**取样）；
  2. `send(message, options)`——**同步抛错原样上抛，不记账、不广播**（workflow sink `workflow-notice.ts:120-130` 依赖抛错走落盘重投，保持不变）；
  3. 正常返回 ⇒ `streaming` 为真时铸 token（兼容假设 A1：此刻已同步入队，C8 锁定）；广播 `BackgroundCompletion`（每个监听器 try/catch 隔离）。
- `noteMessageStart(message)`、`noteAgentEnd()`、`noteAgentSettled()`（§3.4）、`dispose()`（清监听器、置 `disposed`，此后 `sendCompletion` 只转发不记账不广播）。

兼容假设写进 `src/adapters/pi-compat.ts` 头注释的「Honesty note」段（不新增门控逻辑）：

- **A1** streaming 中 `sendMessage(…, {triggerTurn:true})` 在返回前同步入 steer 队列（C8）。
- **A2** 注入时发 role `custom` 的 `message_start`，`content` 不被改写（C7）。
- **A3** boundary 注入顺序 = 入队顺序；数量由 `steeringMode` 决定（C9/C10）。
- **A4** 非 streaming 发送立即起 run（C11）。

### 3.3 接线与 teardown（assembly only，I7）

`src/stack.ts`：

- 模块级 `let previousBackgroundCompletions`（与 `:171-234` 一组）；`buildSessionStack`（`:1332`）**第一行**（`:1341` 之前，先于
  `previousCoalescer?.dispose()` `:1347` 与 `prevBashJobs?.dispose()` `:1354`）dispose 上一实例——旧 coalescer/bash manager 在 dispose
  过程中若还 flush 通知，旧 hub 已不广播。
- 构造 hub（`isStreaming: () => !ctx.isIdle()`），`Stack`（`:840`）加字段 `backgroundCompletions`。
- `:1541`、`:1554` 改用 `sender.sendCompletion("subagent", …)`（digest 带 `count: items.length`）；`:2469` 改为
  `sendMessage: (m, o) => sender.sendCompletion("workflow", m, o)`（`:2489` 重投不改）；`buildBashJobManager` 增可选第 4 参
  `send?: SendMessageFn`，`notify`（`:644`）用它，`:2083` 传入 `(m, o) => sender.sendCompletion("bash", m, o)`；`onDeadline` 不改。

`src/index.ts`：

- `:313` 旁每 activate 注册一次（经 holder 路由，同 `createNotificationReceiptHook` 先例）：
  `message_start` → `noteMessageStart`；`agent_end` → `noteAgentEnd`；`agent_settled` → `noteAgentSettled`。
- `session_start` 防御块（`:722-733`）加 `holder.current.backgroundCompletions.dispose()`；`session_shutdown`（`:751`）**首行**（`:762` fleetWidget 之前，
  先于 `:777-789` 的 drain/seal）加同一调用——shutdown 期间 drain 出来的完成不得打断任何东西。三处幂等。
- `:287` 改为 `wireAskUser(pi, { remote, background: () => holder.current?.backgroundCompletions, interrupt: () => settings.askUser.backgroundInterrupt })`
  （`holder` 声明于 `:229`）。compat gate 失败 ⇒ `holder.current` 恒空 ⇒ 端口 undefined ⇒ 与今天逐字节一致。

ask-user 侧（activate 级，`wireAskUser` 闭包）：端口在对话框打开时现取并订阅、settle 时退订；`session_shutdown` 清全部计时器与订阅；
`session_start/session_tree/session_compact` 从分支恢复 parked（§6.3）。

### 3.4 token 状态机（替代 v1 的业务 key 出队）

每次 streaming 中成功 `sendCompletion` 铸一枚 token：`{ seq, customType, contentHash, count, kind, sentAt, state }`，`seq` 单调递增；
`contentHash = sha1(typeof content === "string" ? content : JSON.stringify(content))`。

```
pending ──(message_start: 同 customType 且同 contentHash 的最老 pending)──▶ consumed
pending ──(message_start: 同 customType、无同哈希，取最老 pending；diag.mismatch++)──▶ consumed
pending ──(agent_settled 且 seq ≤ endSeq)──▶ orphaned（diag.orphaned++，喂 §2.4 自检）
```

- `endSeq` 在 `agent_end` 时记录为当前 `seq`；`agent_end` 与 `agent_settled` 之间铸的 token（其他 settled 处理器触发的发送）保留。
  依据：streaming 中入队的 steer 在 run 结束前必被注入（agent 在队列非空时继续，`agent-session.js:1140,1154`），所以 settle 时仍 pending 即异常——
  这是**显式检测**而非清零掩盖。
- `message_start` 无可匹配 pending（如 `:2489` 重投、非 streaming 发送）⇒ `diag.unmatched++`，不改状态。
- digest：一次 send 一枚 token（`count` 记条数），不再按 runId 拆。同类型并发：内容含各自 id，哈希区分；内容完全相同则不可区分，FIFO 即正确。
- 上限：pending 超过 64 枚时最老的转 orphaned（不计入自检）。
- `pendingTokens()` = pending 数；诊断计数经 `/agent status` 的 ask-user 行可见（P2 可选）。

## 4. 再呈现：模型重问（语义已定：尽力提示，非保证）

自动重开需要在 execute 之外打开 `ui.custom` 并以异步消息送回答案——正是被砍掉的 v1 协议；且后台结果可能已让问题失去意义。
因此由**模型重问**，扩展用四件事尽力不丢题：

1. **草稿恢复**：打断时快照组件状态，按单题指纹存 parked；重问命中时恢复，并显示 `resumed` 标记行。
2. **防抖与预算**（§5.2）。
3. **持久化**：parked 写 session entry，跨 `/reload`、resume、compact、switch_context 恢复（§6.3）。
4. **可见性与提醒**：状态栏 `ask⏸N`（英文 token）；`agent_settled` 时仍有本 run 产生的 parked 未被重问 ⇒ 一次 `ui.notify`（中文，列出 header）；
   compact/switch_context 之后若有 parked ⇒ 追加一条 `triggerTurn:false` 的提醒消息（§6.4），把题目重新带回上下文。**不**自动触发轮次催模型。

## 5. 打断协调器

### 5.1 交互结果协议（评审 #3）

`runTuiInteraction` / `runRpcInteraction` 改返回：

```ts
type InteractionOutcome =
  | { kind: "answered"; by: "tui" | "web"; result: Result }
  | { kind: "cancelled"; by: "tui" | "web" }
  | { kind: "aborted" }
  | { kind: "interrupted"; info: InterruptInfo; draft?: DraftSnapshot }
  | { kind: "deferred"; info: InterruptInfo };
```

`DialogRace`（`remote.ts:6-9`）claim/winner 联合加 `"background"`；`AskUserRemoteSession.close`（`:16`）的 `by` 加 `"background"`。
`execute` 只做 outcome → 文本/details 映射；`classifyOutcome`（`index.ts:203-216`）保留，仅作用于非 background 赢家，以保持 M-1 语义
（`tests/ask-user/index.test.ts:158`）不变。

| 赢家 / 结局               | outcome                        | `session.close`                           | 说明                           |
| ------------------------- | ------------------------------ | ----------------------------------------- | ------------------------------ |
| tui 提交                  | answered(tui)                  | `("tui","answered")`                      | 今日行为                       |
| tui Esc / 组件自身 cancel | cancelled(tui)                 | `("tui","cancelled")`                     | 今日行为                       |
| web 答 / web 取消         | answered(web) / cancelled(web) | 不调用（bridge `finish` 已记录）          | 今日行为（`index.ts:97-106`）  |
| abort（signal）           | aborted                        | `("abort","aborted")`                     | 今日行为                       |
| background                | interrupted                    | `("background","aborted")`                | 新；`cancelLocal` 后返回       |
| 开框前检查命中            | deferred                       | 若远端已 open：`("background","aborted")` | 新；不调 `ui.custom`           |
| 抛错                      | 抛出                           | `("error","aborted")`                     | 今日行为（`index.ts:126,198`） |

### 5.2 触发、防抖与预算（评审 #8）

#### 5.2.1 参数总表

文件存整数秒（`*S`，`src/config/time-units.ts` 约定），内部毫秒；逐字段解析，非 number / NaN / 非有限 / 非整数 / 越界 ⇒ 该字段回落默认，不抛（同 `parseHudSettings` `settings.ts:1343-1353`）。

| 参数（内部名）            | 默认 | 合法范围                             | 起算点                                                | 重置条件                             | 0 的含义                       |
| ------------------------- | ---- | ------------------------------------ | ----------------------------------------------------- | ------------------------------------ | ------------------------------ |
| `delayMs` 合并窗口        | 1s   | 0–10s                                | 首个完成到达、且存在可打断 PendingAsk、且窗口未武装   | 不重置（固定窗口，窗口内完成只累计） | 下一个宏任务（`setTimeout 0`） |
| `quietMs` 安静期          | 4s   | 0–30s                                | 该框最后一次 `handleInput`（`component.ts:149-151`）  | 每次按键                             | 无活跃保护                     |
| `maxDeferMs` 活跃推迟上限 | 20s  | 0–120s，且 ≥ quiet（否则钳为 quiet） | 窗口到点时刻 `windowFire`                             | 不重置                               | 不因活跃推迟                   |
| `reaskDwellMs` 驻留期     | 10s  | 0–60s                                | 重问框挂载（factory 返回）时刻                        | 不重置                               | 无驻留                         |
| `maxPerQuestion` 打断预算 | 3    | 1–10（用户拍板 3）                   | 按单题指纹累计，跨重问、跨 reload（随 parked 持久化） | 该题被回答或用户取消                 | 非法，回落 3                   |
| `DEFER_CAP` deferred 上限 | 3    | 常量                                 | 按单题指纹累计                                        | 同上                                 | —                              |

选择依据：1s——同批并行 agent / workflow 子任务的完成通知间隔通常是毫秒到亚秒级（`coalesceWindowMs` 默认 0，`settings.ts:670`），1s 能合并且相对
agent 工作时长（分钟级）无感；4s——录入 Other 文本时的击键停顿通常 <2s，取 2 倍裕度；20s——限制「一直在打字」造成的饥饿，草稿反正会恢复；
10s——重问框重新出现后，用户重新读题并选一项所需时间；3——用户拍板。以上为启发式默认值，全部可配。

#### 5.2.2 截止时间公式与优先级

对每个 PendingAsk，在 `windowFire` 及之后的每次重估时：

```
dwellDue = isReask ? mountedAt + reaskDwellMs : 0
quietDue = lastActivityAt === undefined ? 0 : min(lastActivityAt + quietMs, windowFire + maxDeferMs)
due      = max(windowFire, dwellDue, quietDue)
```

`now ≥ due` ⇒ `race.claim("background")`，成功则 `cancelLocal()`；否则在 `due` 重排一次重估（每个 PendingAsk 至多 1 个计时器，`unref()`）。
优先级：驻留期 > 安静期（受 maxDefer 封顶）> 合并窗口。queued（未显示）项 `lastActivityAt`、`dwellDue` 均为 0 ⇒ `due = windowFire`。
**最大打断延迟**（首个完成 → 打断）= `delayMs + max(reaskDwellMs, maxDeferMs)`，默认 21s。

#### 5.2.3 广播

一次窗口作用于本 activate 全部可打断 PendingAsk（含 queued 未显示者），各自按 §5.2.2 的 due 落下；否则批次不 settle，通知照样卡住（§1.1）。
所有 PendingAsk settle 后清窗口状态。端口 `disabled`（§2.4）或 `backgroundInterrupt.enabled=false` ⇒ 不订阅、不检查。

#### 5.2.4 预算耗尽（已接受的降级，用户拍板）

调用中任一题打断次数已达 `maxPerQuestion` ⇒ 该 PendingAsk 不可打断：**回到今天的阻塞行为**，直到用户回答或 Esc；期间完成通知照旧在 steer 队列等候。
含义：最多 3 次打断后，最坏情况与今天相同（不会更坏）；后台舰队排空后自然不再有新完成，循环必然终止——无限「打断—重问」比回退阻塞更糟。
框内指示切为 `N bg done · answer to continue`。验收见 §10 P1-9。

#### 5.2.5 对话框内指示（P1 必做）

`AskUserComponent` 新增 `setNotice(text: string | undefined)`：在 `render()`（`component.ts:78-126`）边框内最后一行之前插入一行 dim 文本，
`undefined` 时输出与今天逐字节相同（既有 `component.test.ts` 不动）。文案（英文 token，AGENTS.md 行内标记规范）：

- 等待落下中：`⏸ N bg done · pausing when idle`
- 预算耗尽：`⏸ N bg done · answer to continue`
- 重问恢复：首行 `resumed · draft restored`（有草稿时）

### 5.3 待答队列（经批准的行为变更）

`src/ask-user/queue.ts`：每 activate 一个 FIFO 互斥，仅 TUI 使用（RPC 客户端按 request id 自管）。

- **快路径同步**：互斥空闲时 `acquire()` 同步返回，`runTuiInteraction` 在与今天相同的同步段内调用 `ui.custom`——单个 ask_user 时序不变（R1）。
- 排队中：signal abort ⇒ 出队返回 aborted；被打断 ⇒ 出队返回 interrupted（不弹框）；web 赢 ⇒ 出队返回 answered/cancelled(web)。
- 远端 session 在**入队时** `open`（web 能看到并回答整条队列）。

### 5.4 开框前检查（deferred）

获得互斥、调用 `ui.custom` 之前：`port.pendingTokens() > 0` 且本调用各题 deferred 计数均 < `DEFER_CAP` ⇒ 不弹框，返回 deferred。
理由：§1.4 推论 (2)。deferred 不计入 `maxPerQuestion`；token 记账错误由 §3.4 orphan 检测与 §2.4 自检兜底。

## 6. 配置、结果文本、parked 持久化

### 6.1 设置

`askUser: EnabledGroup`（`settings.ts:575`、默认 `:822`、解析 `:1053`）改为 `AskUserSettings extends EnabledGroup`（照 `TodoSettings` `:612` /
`parseTodoSettings` `:1362-1371`）：

```ts
backgroundInterrupt: {
  enabled: boolean; // 默认 true
  delayMs;
  quietMs;
  maxDeferMs;
  reaskDwellMs; // §5.2.1
  maxPerQuestion: number; // 3
  rpc: boolean; // 默认 false（§7.1）
}
```

四个时间键登记 `TIME_SETTING_MS_PATHS`（`:893`）；`setting-specs.ts:338` 旁补 `askUser.backgroundInterrupt.*` 规格。

### 6.2 结果文本与 details

`types.ts:99` `AskUserDetails = Result` 改为 `Result & { interrupted?: InterruptInfo }`，`ResultSchema`（`:92`）不动：

```ts
interface InterruptInfo {
  kind: "background" | "deferred";
  completions: { kind: BackgroundCompletionKind; count: number }[];
  attempt: number;
  limit: number;
  draftSaved: boolean;
}
```

`details` 仍为 `questions` + `answers: {}` + `cancelled: true`。文本（英文，模型面，单测逐字钉）：

- background：`ask_user was interrupted before the user answered: {summary} finished in the background and the completion notice(s) arrive right after this result. The question(s) are NOT answered — do not assume an answer and do not answer on the user's behalf. First handle the notice(s); if the decision is still needed, call ask_user again with the same questions (the user's partial input is restored). If the background result already settles the question, proceed and say so explicitly. [interrupt {attempt}/{limit}]`
- deferred：`ask_user was not shown yet: {n} background completion notice(s) are queued and will arrive next. Do not assume an answer. Read them, then call ask_user again with the same questions if the decision is still needed.`

`renderResult`（`index.ts:338-349`）在 cancelled 分支前判 `details.interrupted`：`⏸ paused · bg done · will re-ask`。

### 6.3 parked 注册表与持久化（`src/ask-user/parked.ts`，pi-free 状态 + `index.ts` 内接线）

- 单题指纹：`sha1(JSON([question, options.map(label), multiSelect === true]))`（`normalizeQuestions` 之后）。
- 条目：`{ fp, question, header?, interrupts, deferrals, draft?: QuestionStateSnapshot, parkedAt, lastReaskAt?, runSeq }`；上限 16（FIFO），TTL 24h（恢复时过滤）。
- 草稿：`AskUserComponent` 新增 `snapshotDraft()` 与构造选项 `initialDraft`（`component.ts:45-58`），快照 `QuestionState`（`Set` 存数组）与 `activeTab`；
  恢复时逐题校验选项数一致，不一致丢弃该题草稿。
- **持久化**：customType `ask-user:parked`，每次 parked 变化（打断、deferred、重问被回答/取消、TTL 剪枝）`pi.appendEntry` 全量快照
  `{ v: 1, items }`——在工具 execute 内 appendEntry 有 todo 先例（`todo/index.ts:330-334`）。
- **恢复**：`session_start` / `session_tree` / `session_compact` 读 `ctx.sessionManager.getBranch()` 中最后一条 `ask-user:parked`（**禁用 `getEntries`**，
  否则会复活被放弃分支的快照；同 `todo/index.ts:196-198`）。
- 草稿含用户在 Other 里输入的文字，落入会话文件——它本就是要进会话的用户输入，可接受。

### 6.4 生命周期

| 事件                          | parked 状态                                 | 模型侧                                                                                                                                                       |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/reload`、resume、进程重启   | 从分支恢复（计数、草稿都在）                | 上下文未变，工具结果仍在                                                                                                                                     |
| compact / switch_context      | `session_compact` 时从分支恢复              | 若有 parked：`pi.sendMessage({customType:"ask-user:parked-reminder", display:true, content: 题目列表}, {triggerTurn:false})`，把题目带回新上下文；不起新 run |
| `/new`、fork 到无 parked 分支 | 分支里没有 ⇒ 空                             | —                                                                                                                                                            |
| session 切换时框正开着        | 既有 abort 路径（`AGENT_ABORTED_TEXT`）不变 | —                                                                                                                                                            |
| 用户回答/取消重问             | 删除对应条目并持久化                        | —                                                                                                                                                            |

## 7. RPC / web 面

### 7.1 RPC（默认关）

- `backgroundInterrupt.rpc = false`（默认）：**RPC 模式不提供中途打断，也不做开框前 deferred**——RPC 路径与今天逐字节一致（回归 R4）。
- `rpc = true`：`cancelLocal = () => localAbort.abort()`（`index.ts:153,165`）。已知限制：pi 的 `createDialogPromise`（`modes/rpc/rpc-mode.js:47-79`，
  onAbort `:59-62`）只在本地 resolve，**不向客户端发撤回**，客户端对话框残留，迟到回答被丢弃（`:53-58`）；重问会产生新的
  `extension_ui_request`。撤回/关联需要 pi 的 RPC 协议支持，不在本方案范围；文档与设置描述写明。

### 7.2 web-hub（评审 #10）

| 改动              | 位置                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS 类型           | `messages.ts:261` `DialogClosedWire.by` 加 `"background"`                                                                                                                                                                                         |
| **运行时 schema** | `messages.ts:864-870` `DialogClosedSchema.by` 的 `Type.Union` 加 `Type.Literal("background")`                                                                                                                                                     |
| 新 cap            | `src/web-hub/protocol/version.ts` 新增 `DIALOG_BG_HUB_CAPS = ["dialog.bg.v1"]`；hub 广告点 `hub/hub.ts:229`、`hub/agent-server.ts:153` 追加（照 `UPLOAD_HUB_CAPS`）                                                                               |
| 旧 hub 降级       | `dialogs.ts` `createDialogBridge` 选项加 `hubCaps?: () => readonly string[]`，`frame()` 构建时若 hub 无 `dialog.bg.v1` 把 `by:"background"` 映射为 `"abort"`；内部记录保留原值。`web-hub/agent/index.ts:388` 传 `hubCaps: () => conn?.caps ?? []` |
| 关闭透传          | `dialogs.ts:168` `finish` / `:289` `close` 透传 `"background"`                                                                                                                                                                                    |
| UI 文案           | `ui/src/components/detail/AgentDetail.vue:251-262` `resolveClosedNote` 加 `case "background"`；`ui/src/i18n/{en,zh}/dialog.ts:27` 旁加 `closedBackground`（zh：「后台任务完成，问题已暂挂，模型会重新提问」）                                     |
| 队列可见          | 入队即 `open`（§5.3）；UI 本就渲染全部 `dialogs.open`（`AgentDetail.vue:146,374`）                                                                                                                                                                |
| 不改              | `attributePrompt`（§1.5）；dialogId `ask:${toolCallId}`（`dialogs.ts:256`，重问 = 新 dialogId，正确）                                                                                                                                             |

为何必须做 cap 降级：旧 hub 的 `decodeAgentFrame` 遇未知 `by` 会丢弃整个 dialogs 帧（§1.5），而 closed 记录在 bridge 里保留 120s / 8 条
（`dialogs.ts` `CLOSED_TTL_MS`/`CLOSED_LIMIT`），期间该 agent 的**所有** dialogs 帧都会被拒，web 端对话框列表冻结。降级为 `abort` 时旧 UI 显示
「Agent 已中止」——语义最接近，不显示为 error。

## 8. 不做什么

- 不做非阻塞 / askId / `wait` 参数 / 答案异步消息协议；不在 execute 之外打开 `ui.custom`；不做扩展自动重开。
- 不因 bash grace/extended、`subagent:timeout`、workflow 重投、用户自己输入的 steer 打断。
- 不改工具 description / promptSnippet / promptGuidelines。
- 不在 `agent_settled` 自动触发轮次催模型重问（只 notify + 状态栏；压缩后的提醒消息 `triggerTurn:false`）。
- 不做 RPC 客户端撤回协议；RPC 默认不打断。
- 不引入 pi 版本号门控（I14）。
- 子会话不涉及。

## 9. 威胁与风险

| 风险                        | 对策                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 焦点被抢：打字中框消失      | 安静期 + 推迟上限 + 框内「pausing when idle」预告 + 草稿恢复。残余：关闭瞬间的 Esc 落到编辑器 `onEscape`（streaming 时 = 中断 agent），C5 测得实际行为后写入已知限制 |
| 打断风暴 / 闪烁             | 固定合并窗口 + 驻留期 + 每题 3 次预算后回退阻塞（§5.2.4）                                                                                                            |
| 消息洪水                    | 打断不产生新消息；通知数量仍由既有 coalescer/ackHold 管；deferred 每题 ≤ 3                                                                                           |
| 模型乱答 / 不重问           | `cancelled:true` + 文本明令禁止代答 + `[interrupt k/N]`；parked 持久化、状态栏、settle notify、压缩后提醒；验收含真模型抽样（§10 P1-11）                             |
| 记账漂移 / pi 行为变化      | token 内容哈希确认 + orphan 显式检测 + 连续 2 次自检失败停用 + conformance（§2.4）                                                                                   |
| 旧 hub 冻结 dialogs 帧      | cap 降级（§7.2）                                                                                                                                                     |
| 旧栈在 rebuild 后打断新会话 | 三条 teardown 路径 + 旧 hub 先于旧 coalescer dispose（§3.3）                                                                                                         |
| feishu 重复「等待输入」卡   | 重问重新计时 120s（`feishu-notify/index.ts:537-543`）；可接受，后续可按指纹去重                                                                                      |
| ref'd timer 卡 print 模式   | 所有计时器 `unref()`；ask_user 只在 tui/rpc 跑                                                                                                                       |

## 10. 拆包、顺序与验收

**前提声明**：upload U1 已于 `e96c0f7` 提交，`src/config/{settings,setting-specs}.ts` 当前无他人在途改动；P2 基于 U1 之后的 master，合并前对 master rebase 一次即可。
P1 首个提交先冻结 §3.1 端口、§5.1 `InteractionOutcome`、§6.2 `InterruptInfo`，之后 P1/P2 文件域不重叠可并行。

| 包     | 文件域                                                                                                                                                                                                                                                               | 依赖    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **S0** | `tests/conformance/{tui-harness.ts,ask-user-interrupt.test.ts,ask-user-interrupt-tui.test.ts}`（新）；或 `scripts/acceptance/ask-user-interrupt.sh` + mock provider（S0-B）                                                                                          | —       |
| **P1** | `src/ask-user/{background,interrupt,parked,queue}.ts`（新）、`src/ask-user/{index,component,remote,types}.ts`、`tests/ask-user/{interrupt,parked,queue,outcome,regression}.test.ts`（新）                                                                            | S0 通过 |
| **P2** | `src/service/background-completions.ts`（新）、`src/stack.ts`、`src/index.ts`、`src/adapters/pi-compat.ts`（仅注释）、`src/config/{settings,setting-specs}.ts`、`tests/service/background-completions.test.ts`、`tests/integration/ask-user-interrupt.test.ts`（新） | S0 通过 |
| **P3** | `src/web-hub/protocol/{messages,version}.ts`、`src/web-hub/hub/{hub,agent-server}.ts`、`src/web-hub/agent/{dialogs,index}.ts`、`src/web-hub/ui/src/components/detail/AgentDetail.vue`、`src/web-hub/ui/src/i18n/{en,zh}/dialog.ts`、对应测试                         | P1      |

### 通用

`tests/ask-user/` 现有文件一行不改全绿；`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`；`npm run test:conformance` 绿。

### S0

§2.2 C1–C11 全过（C1–C5 在 S0-A 或 S0-B 任一 harness 上），或按 §2.3 选定处置并回写本文。

### P1（fake port + fake clock，harness 同 `tests/ask-user/remote-race.test.ts:28-63`）

回归（评审 #2）：

- **R1** 单个 ask_user、无端口：`ui.custom` 在 execute 的同一同步段内被调用（调用顺序 spy，期间无 microtask 让出）；content/details 与基线快照逐字节一致。
- **R2** 单个 ask_user、有端口但无完成：同 R1，且 settle 后 fake clock 无残留计时器、端口无残留订阅。
- **R3** 同批两个 ask_user、无完成：第二个在第一个 settle 后才调 `ui.custom`，两者各自得到自己的答案；记录「旧行为 = 第二个挤掉第一个」的对照用例（用 fake `ui.custom` 模拟 `editorContainer.clear` 语义）。
- **R4** RPC、`rpc:false`：`askUserInteract` 调用参数与结果与今天一致，有完成也不打断、不 deferred。

功能：

1. 打开时 fire 一次 ⇒ `delayMs` 后 outcome=interrupted，`done` 只调一次，`close("background","aborted")`。
2. 窗口内 fire 3 次 ⇒ 只打断一次，`completions` 合计 3；窗口不因后续完成延长。
3. 安静期：按键持续 ⇒ 推迟；停手 `quietMs` 后落下；持续打字到 `windowFire + maxDeferMs` 仍落下；推迟期内提交 ⇒ answered。
4. 驻留期：重问框挂载后 `reaskDwellMs` 内不落下，到点落下；`due` 取 max 的各组合边界（fake clock 精确到 ms）。
5. 参数：0 值语义、越界/NaN/字符串回落默认、`maxDefer < quiet` 钳制。
6. 同批两个 + fire ⇒ 两个都 interrupted（第二个从未调 `ui.custom`）。
7. `pendingTokens() > 0` ⇒ 不调 `ui.custom`，deferred；同题第 4 次不再 deferred。
8. 竞态：abort vs background、tui 提交 vs background、web vs background，先 claim 者赢，`session.close` 按 §5.1 表。
9. 预算：同题第 4 次 fire ⇒ 不打断、框内指示为 `answer to continue`，回答后返回 answered（已接受的降级）。
10. 框内指示：落下等待中 / 预算耗尽 / resumed 三种文案；`setNotice(undefined)` 时 render 输出与基线逐字节一致。
11. 模型侧（评审 #11）：
    - **不重问**：集成用例中脚本化模型在打断后只输出文本结束 ⇒ 分支里有 `ask-user:parked`，状态栏 `ask⏸1`，`ui.notify` 恰 1 次且含 header，LLM 请求数 = 脚本轮数（无额外 run）。
    - **错误自答**：结果文本逐字单测（含 `NOT answered`、`do not answer on the user's behalf`、`[interrupt k/N]`），`details.cancelled===true && answers` 为空；
      真机抽样（tmux，2 个模型 × 5 次）：伪造「用户选了 X」= 0 次，「重问 + 明确声明问题已无意义」≥ 4/5；不达标只改文本不改机制。
    - **压缩后丢题**：打断 → 触发压缩 ⇒ `session_compact` 后 parked 从 `getBranch` 恢复，下一次请求上下文含 `ask-user:parked-reminder` 且列出题目；重问恢复草稿。
    - **reload**：打断 → 新 activate（模拟 `/reload`）⇒ parked 计数与草稿恢复，重问时 `resumed` 出现，预算计数延续。
12. 持久化：快照只经 `getBranch()` 读取；放弃分支上的快照不复活（构造两条分支用例）。

### P2

1. hub 单测（fake clock）：A1 下 streaming 发送铸 token、非 streaming 不铸；`sendMessage` 同步抛错 ⇒ 上抛、不铸、不广播；监听器异常隔离；
   token 状态机：单条、digest（1 token / count）、缺内容哈希匹配走 customType 回退并计 mismatch、同类型并发不同内容、同内容 FIFO、重投（unmatched）、
   错序 `message_start`（先到后发的那条）、`agent_end` 后 `agent_settled` 前新铸的 token 不被 orphan、上限 64；自检连续 2 次 orphan ⇒ `disabled`。
2. 集成（真 stack）：subagent 单条 / digest / coalescer 延迟发送 / ackHold 延迟发送 / workflow live / bash notify 各铸 token 并广播；
   workflow 重投、bash grace、`notificationSuppressedRunIds` 中的子 run **不**触发。
3. teardown（评审 #7）：`/reload`（新 activate + 新 holder）、`/new`、`/resume`、`session_start` 无配对 shutdown 三条路径下，旧 hub `dispose` 后：
   旧栈 coalescer/bash 在 dispose 中 flush 的通知不广播；旧端口订阅者收不到任何事件；新会话的 ask_user 不被旧栈完成打断。
4. 设置：`askUser.backgroundInterrupt.*S` 读写、时间单位迁移、`/agent settings` 显示与编辑。
5. S0 测试切到真 `wireAskUser` + 真 hub + 真后台 bash 复跑 C1–C11。

### P3（评审 #10 兼容清单）

1. 运行时 schema：`decodeAgentFrame` 接受 `by:"background"`，拒绝未知值（如 `"bogus"`）。
2. 新 UI 收到旧值 `tui/web/abort/session/error` 渲染不变（既有用例）；收到 `background` 显示 `closedBackground`。
3. 旧 UI（`resolveClosedNote` 无 background 分支的构建）收到 `background`：不抛错，对话框从 open 列表移除，显示通用文案。
4. 旧 hub（caps 无 `dialog.bg.v1`）：bridge `frame()` 输出 `by:"abort"`，旧 schema `Value.Check` 通过；hub 升级后同一记录重新发帧为 `background`。
5. `dialogs.close("background","aborted")` 广播 `closed[].by` 正确；web answer 与 background 同 tick ⇒ 一方 `E_DIALOG_CLOSED`。
6. 入队即 open：web 回答 queued 项 ⇒ TUI 不再弹该框。

## 11. 已定项（用户 / 主会话拍板，不再讨论）

1. 每题最多打断 **3 次**，之后回到今天的阻塞行为——已接受的降级（§5.2.4）。
2. 对话框内「N 个后台任务已完成」指示 **P1 就做**（§5.2.5）。
3. bash 超时宽限通知**不**打断；RPC 模式默认**关**，关 = 不提供中途打断（§7.1）。
4. 待答队列保留，作为经批准的行为变更（§0′、§5.3），以 R1–R4 回归锁定。
5. 评审 #6 已过时（U1 已提交）；#11 模型重问 = 尽力提示而非保证，但 parked 持久化与可测验收必须做。
6. #3 discriminated outcome、#5 发送适配层 + 兼容假设 + conformance，按评审建议实现。

剩余开放问题：无。
