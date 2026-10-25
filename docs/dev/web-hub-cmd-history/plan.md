# web-hub 命令历史（命令输出进会话流，不进上下文）· 实施方案 v2

> 状态：v2 修订稿（2026-10-24），待复审。只给施工口径，不含代码。行号以 dev 分支 `8910d145`（含已提交的 `56c71cae` hub provisional-async 修复）为准。
> 需求来源：用户 2026-10-24 拍板（静态预览 `/tmp/cmd-history-preview.html` 已认可）+ 下列 Q1–Q5 拍板。

## 修订记录

| 版本 | 日期       | 说明                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1   | 2026-10-24 | 初稿                                                                                                                                                                                                                                                                                                                                                                                                                     |
| v2   | 2026-10-24 | 方案评审（kimi，`/tmp/cmd-history-review1.json`，2B/4M/8m/2N）打回后修订：全文对齐 Q1–Q5 拍板（删脱敏管线 / 原文覆盖 / 追加脱敏规则；内置命令全记并逐个定义）；删除 prompt op 登记意图（源码证伪）；重新论证延迟执行的唯一触发源；secure LOCKED 只读查询入冻结面；原文落盘凭据登记为已接受残留；异步 builtin 在真实结算处写 end；runTail 回落规格重写；会话离开类命令在离开前提交记录；其余 minor/nit 逐条处置（见下表） |
| #42  | 2026-10-25 | 用户要求：`/reload` 与 `/agent reload` 族（now/cancel/fire/裸）不进命令历史（修订 Q3「内置命令全记」对 reload 的适用）：policyFor 对 reload 族一律 skip，bridge 不再 noteIntent 且回复 `history:"none"`，离场行 LEAVE_LINE 删除 reload；其它命令不变                                                                                                                                                                     |

## 用户拍板（2026-10-24，正文已全部对齐）

- **Q1 原文落盘**（不脱敏，与终端所见一致）。唯一例外：Q5 的敏感子命令只记头部；另保留 editor 预填内容不落盘（§4.4，与脱敏无关）。
- **Q2** 网页按钮 / 控件触发的命令**也记**（不改协议）。
- **Q3** pi 内置命令**全都记**（能观测到的范围内：网页执行的 `/session /name /thinking /model /compact /new /reload` 以及网页恢复对话框的 `/resume` 各留一张卡，正文与写入时机见 §5.2）。**#42 修订：`/reload` 与整个 `/agent reload` 族（now/cancel/fire/裸）不再记录——无卡、不写会话历史、无「已离开本会话（重载）」离场行。**
- **Q4** 网页执行的第三方扩展命令记「输出仅在终端」占位卡；终端执行的第三方 / 内置命令观测不到，不记。
- **Q5** `/webhub` 敏感子命令（`open/token/2fa/passwd/user/unlock/feishu/lan` 及未知子命令）**只记头部**（命令名 + 状态，不记输出）。

## 评审处置表（review1）

| #   | 级别    | 评审要点                                                                                                                                                                               | 处置                                                                                                                                                                                                | 落点                             |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| B1  | blocker | 正文与 Q1/Q3 拍板脱节：仍含脱敏管线、原文 overlay、追加脱敏规则；builtin 仍写不记；§11 仍待拍板                                                                                        | **接受**。删除 `redactRecordText`/D6 overlay/§5.3 追加规则与相关测试；Q3 改为内置命令全记并逐个定义卡正文与写入时机；§11 改「已拍板」；保留 editor 预填不落盘例外                                   | §4.3、§4.4、§5.2、§5.3、§7、§11  |
| B2  | blocker | prompt op 的 slash 不执行（`handlePrompt` 传 `expandPromptTemplates:false`，`commands.ts:411`；pi `prompt()` 仅在为真时执行扩展命令，`agent-session.js:1609`），登记意图只会悬挂并错配 | **接受**。删除 `handlePrompt` 登记意图与 `commands.ts` 改动；意图账本只由 builtin-bridge 写；延迟执行的唯一源改为 `_isEmittingAgentSettled` 窗口（§1.1、§2），G7 验收改为该场景                     | §1.1、§2、§3.2、§4.3、§5.1、§8.5 |
| M1  | major   | `secureLocked` 无现成导出；LOCKED 拦 `input` 但扩展命令绕过 `input`，LOCKED 期间命令照样执行                                                                                           | **接受**。`src/secure/guards.ts` 的 `SecureGuardWiring` 新增只读查询 `recheckForWrite(ctx)`（复用 `recheckMount`），入 A1 文件域与冻结面 F6；明确 LOCKED 期间命令仍执行，recorder 不写              | §4.3、§5.4、§8.1、§8.2           |
| M2  | major   | 原文落盘使活凭据明文持久化，需登记残留与日志 grep 验收                                                                                                                                 | **接受**（不改为脱敏，按 Q1）。§5.3 登记已接受残留清单与外泄面；验收加 hub.log / agent 日志 grep                                                                                                    | §5.3、§8.5                       |
| M3  | major   | 异步 builtin 记录时机未定义；dispatch 时写 done 会误标 auth 拒绝；不得触碰 56c71cae 的 ledger 即时结算                                                                                 | **接受**。`/model` 在 `setModel` Promise 结算处、`/compact` 在 `onComplete/onError` 处写 end；auth 拒绝 ⇒ `failed`；bridge 返回值与 ledger 结算路径一字不改（记录是旁路观察）                       | §5.2、§8.3                       |
| M4  | major   | runTail 回落规格不自洽（--no-session、leaf 截断、超时口径、开关边界）                                                                                                                  | **接受**。不纳入 `--no-session`（保持早退；该类会话不声明 feature ⇒ UI 走 legacy）；按 pending leaf 截断；超时以 `TIMING.snapshotMs`（5 s）为准；如实写明回落是不受 `cmdHistory` 开关控制的通用修复 | §4.10、§1.3、§9                  |
| m1  | minor   | 意图匹配顺序；跨会话、/reload 错配                                                                                                                                                     | **接受**。最旧优先；意图带 sessionId，只在同会话匹配，会话切换即清；/reload 后意图丢失 ⇒ 本地 cmdId + 按 mode 标源，登记残留                                                                        | §4.3、§9 R4                      |
| m2  | minor   | `history` 提示须同样出现在异步通道（`cmd_late` 的 late 数据）                                                                                                                          | **接受**。同步回复、`sendLate` late 数据、builtin late 数据都带 `history`                                                                                                                           | §4.6                             |
| m3  | minor   | editor prefill 不落盘例外须显式保留                                                                                                                                                    | **接受**                                                                                                                                                                                            | §4.4                             |
| m4  | minor   | `appendEntry` 是同步 `appendFileSync`，pi 不 try/catch；LOCKED + 未落盘会话计数虚高                                                                                                    | **接受**。recorder 每次写都 try/catch，分计数 `appended/skipped/failed`；LOCKED 直接 skip 不调 appendEntry；写入成本登记                                                                            | §4.3、§4.9、§9 R11               |
| m5  | minor   | 「逐字节不变」过强                                                                                                                                                                     | **接受**。改述为「旧端忽略开放字段、行为不变」；只保留 UI DOM 在 legacy 路径逐字节不变的承诺                                                                                                        | §1.3、§6                         |
| m6  | minor   | 「或其它排队原因」不准确                                                                                                                                                               | **接受**。streaming 中扩展命令立即执行，唯一推迟源是 `_isEmittingAgentSettled`                                                                                                                      | §1.1、§2                         |
| m7  | minor   | G7 验收场景错；缺占位卡 60 s 降级与后到真卡并存的说明                                                                                                                                  | **接受**。验收改为 agent_settled 发射窗口（探针扩展拉长）；补占位降级状态机                                                                                                                         | §4.7、§8.5                       |
| m8  | minor   | 测试缺：嵌套命令 sink 隔离；deferred `unknown` 无 `cmd_late` 时 hub 账本不被污染（56c71cae 回归钉）；conformance 缺「`expandPromptTemplates:false` ⇒ slash 不执行」前提钉              | **接受**，三类全补                                                                                                                                                                                  | §8.3                             |
| n1  | nit     | 「字段缺失按 kind 推断 recorded」与「渲染只看数据」两套推断，可能死等                                                                                                                  | **接受**。统一：`history` 缺失 ⇒ 视同 `none`，不放占位；占位兜底文案唯一                                                                                                                            | §4.6、§4.7                       |
| n2  | nit     | 行号：`interactive-mode.js:3135`；5 s TTL 常量在 `command-capture.ts:70`                                                                                                               | **接受**，已更正                                                                                                                                                                                    | §2                               |

---

## 1. 背景与目标

### 1.1 要解决的问题

现状：网页执行命令（`/record status` 等）后，输出只在输入框上方弹一张临时卡片（`CommandResult.vue`，内容型不自动关，空结果 6 s 自动关）。问题：

1. **关了就没了**：刷新、换设备、换会话后都看不到；路径、链接点不了。
2. **终端执行的命令网页完全看不到**。
3. **agent_settled 发射窗口内发出的 web 命令输出丢失**。pi `prompt()` 遇 `/name` 会**立即**执行扩展命令（streaming 中也一样，`agent-session.js:1611`），唯一推迟源是 `_isEmittingAgentSettled`：一轮结束、`agent_settled` 扩展处理器正在 `await` 时（`_emitAgentSettled`，`:684-707`；本仓库 feishu-notify / hud 等处理器是 async），命令被压进 `_deferredSettledActions`，等全部处理器结束才执行。此时 `builtin-bridge.ts:dispatchExtension`（:186-245）在 `sendUserMessage` 返回后看到捕获窗**尚未打开**（`take()` 还没发生）⇒ `isActive` 为假 ⇒ 不注册 finish 监听 ⇒ 回答 `completion:"unknown"`；稍后 handler 执行时即便在 5 s 回退队列（`FALLBACK_TTL_MS`，`command-capture.ts:70`）内被认领、窗口收集了输出，也**没有任何通道**把它送回 UI；超过 5 s 则连认领都失败。**无论推迟多短，输出都丢**。

### 1.2 目标（已拍板）

| #   | 目标                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 命令输出成为对话流里的「命令」条目，随会话历史滚动回看；**不注入模型上下文**                                                                                                                                         |
| G2  | 卡片样式：紫色左边框；头部 `/name args`、来源 chip（web / tui）、「不进上下文」chip、状态 running → done / failed **原地更新**；正文 info/warning/error 行 + widget/status 块；超过约 6 行折叠「展开全部」；复制按钮 |
| G3  | 输出中的绝对路径 / 本机链接走现有预览（`PathText.vue` + proxy 链接）                                                                                                                                                 |
| G4  | 存进 pi 会话文件（`pi.appendEntry` 自定义条目）；刷新 / 换设备 / 重启都在；沿用 32 KiB / 64 条预算；**TUI 不渲染**；原文落盘（Q1）                                                                                   |
| G5  | 网页和终端执行的命令都记（Q2/Q3/Q4）；终端执行的 toolkit 命令也要捕获，**不改变终端原有显示**；抓不到的如实标注                                                                                                      |
| G6  | 去掉输入框上方临时卡片，只保留必要提示（需回终端操作、确认框、错误）                                                                                                                                                 |
| G7  | 条目在 handler **真正执行时**创建 / 填充（修掉 §1.1-3）                                                                                                                                                              |

### 1.3 约束

- 不变量：zero-hang（所有计时器 `unref`、所有等待有上限）；`/reload` 不留模块级状态；child session 保持 inert。
- 兼容：旧 hub / 旧 UI / 旧 agent 任意组合无害。新增信息只走开放面（`WireEntry` / `StatusInfo` / `CmdData`），**旧端忽略这些字段、行为不变**（同 `resume.v1` 先例）；帧本身会多出可选字段，不承诺逐字节相同。
- 承诺逐字节不变的只有：`historyMode` 为假时 UI 的 DOM（沿用今天的 `CommandResult` 路径）；`webHub.cmdHistory=false` 时 agent 不写任何条目、`wrapCommandApi` 走今天的透传分支。**hub 的 ENOENT 回落（§4.10）是独立的通用修复，不受 `cmdHistory` 开关控制**。
- 三个 off golden（`fabric-xs-off` / `fabric-wake-off` / `fabric-xs-reply-off`）、`tests/fixtures/web-hub-ui/keepalive-legacy-golden.json` 不得重生成。
- `CommandArgsSchema` 是**封闭**的（`messages.ts:1940`，`additionalProperties:false`）⇒ **不给 command op 加字段**（新 hub → 旧 agent 会被拒帧）。
- 不得改变 `56c71cae` 之后的 ledger 结算语义：扩展命令 `async` 只经 late 通道结算；builtin（`/compact`、`/model`）保持即时结算 + late 升级（`ModelSwitcher` 的 ctl-slot 收敛依赖它，`agent/commands.ts:876-890` 注释）。

---

## 2. 现状摘要

| 面           | 文件                                                                                      | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 命令包装     | `src/web-hub/agent/command-capture.ts`                                                    | `wrapCommandApi`（:528）是 `activate()` 第一行，代理 `registerCommand`；仅当 `capture.take(name,args)` 认领到 web 调用才走 `createCapturedCtx`/`createCapturedUi`（:470/:388），否则原样 `Reflect.apply`。捕获窗 8 KiB/条、32 KiB/64 条，`CAPTURE_MAX_MS=30s`（:68），`FALLBACK_TTL_MS=5s`（:70）；回退队列 `findIndex` 最旧优先                                                                                                                                                                 |
| web 派发     | `src/web-hub/agent/builtin-bridge.ts`                                                     | `dispatchExtension`（:186）arm → `sendUserMessage(..., {expandPromptTemplates:true, deliverAs:"followUp"})` → `settleArm` → 同步有输出答 `sync`、窗口仍开答 `async`（`sendLate`）、否则 `unknown`。`dispatchBuiltin`：`session/name/thinking` 同步；`model`（`setModel` Promise，`sendLate` 时答 `async`）；`compact`（`ctx.compact({onComplete,onError})`）；`new`（`armExec` → `/webhub __exec new <nonce>`）；`reload`（转发 `/agent reload`）；`resume`（`__list/__pick`，`resume-exec.ts`） |
| prompt op    | `src/web-hub/agent/commands.ts:411`                                                       | `sendUserMessage(text, {expandPromptTemplates:false})` ⇒ slash 文本**不执行**，作为普通文本进 LLM（飞书只走 prompt/dialog op）                                                                                                                                                                                                                                                                                                                                                                   |
| pi 执行时序  | pi 1.3 `agent-session.js:1599-1690`                                                       | 扩展命令先于 `input` 事件执行、streaming 中立即执行；唯一推迟源 `_isEmittingAgentSettled`（:1603）；deferred actions 按序 `await`（:696-702）；第三方 / 内置命令的 handler 拿 pi 自己的 ctx，无法代理                                                                                                                                                                                                                                                                                            |
| 会话控制     | pi `extensions/types.d.ts:290-322`                                                        | `newSession/fork/switchSession` 返回 `Promise<{cancelled}>`，`reload(): Promise<void>`；成功切换后旧 ctx 失效（取值抛错）                                                                                                                                                                                                                                                                                                                                                                        |
| 会话条目投影 | `src/web-hub/protocol/keys.ts:139`                                                        | hub（读 jsonl）与 agent（`snapshot.ts:buildBranchReply`）共用、逐字节一致。`custom` 默认墓碑；先例 `subagent:web-tool-timing` 墓碑 + 有界 `timing` 字段（:180）                                                                                                                                                                                                                                                                                                                                  |
| 实时追加     | `src/web-hub/hub/history.ts:387-420`                                                      | agent 1 Hz tick 发现 leaf 变 → `status` → hub `runTail`（500 ms debounce）读文件尾 64 条 → `diffAppended` → SSE `append`。`file===undefined` 早退（:397）；读失败直接 return（:401）。`loadBranch`（:450）是文件失败 → `branch_req` + leaf 截断（:466）的先例                                                                                                                                                                                                                                    |
| pi 落盘      | pi `session-manager.js:791-812`                                                           | 无 user/assistant 消息时不写文件；`_persist` 用同步 `appendFileSync`，无 try/catch                                                                                                                                                                                                                                                                                                                                                                                                               |
| TUI          | pi `interactive-mode.js:3135`                                                             | `custom` 条目无渲染器即不渲染；`/tree` 默认视图隐藏 `custom`（`tree-selector.js:262`）                                                                                                                                                                                                                                                                                                                                                                                                           |
| LLM 上下文   | pi `session-manager.js:163-195`                                                           | `custom` 不进上下文；`custom_message` 会进                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| secure       | `src/secure/guards.ts:235/260/298/372`                                                    | `wireSecureGuards` 返回 `{ lockedReason }`；挂载复核 `recheckMount` 只在 `tool_call`/`input` 时跑；扩展命令不触发 `input` ⇒ LOCKED 期间命令照样执行                                                                                                                                                                                                                                                                                                                                              |
| UI 入流      | `ui/src/logic/state.js:1189` `entryItem`                                                  | `custom`（墓碑）返回 `undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UI 临时卡片  | `components/control/CommandResult.vue`；`components/detail/DetailDock.vue:73-246,537-545` | `runCommand()` 读 `outcome.data.output`；异步 `watchCommandItem()` → `pendingCtl` → `queryOnly`                                                                                                                                                                                                                                                                                                                                                                                                  |
| 状态面       | `StatusInfo`（`messages.ts:571`，开放）                                                   | `features?: string[]`（`resume.v1` 仅在会话已持久化时声明，`agent/index.ts:899-907`）                                                                                                                                                                                                                                                                                                                                                                                                            |
| 能力 cap     | `protocol/version.ts:336`；`hub/hub.ts:443`                                               | 先例 `cmd.args.v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 预览         | `ui/src/components/preview/PathText.vue`                                                  | 纯文本分段，无 `PREVIEW_CTX` 时 DOM 等价裸文本；内置 proxy URL 识别                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 3. 总体设计

### 3.1 一句话

agent 在 **toolkit 命令 handler 真正执行时**（`wrapCommandApi` 内）开一个「记录」，旁路收集 `notify/setWidget/setStatus/交互`（终端照常显示）；网页执行的 builtin 与第三方命令由 bridge 在**真实结算点**记录；结束时 `pi.appendEntry("subagent:cmd", …)` **原文**落盘。hub 共享投影把它变成带有界 `cmd` 字段的 custom 墓碑（旧 UI 看不见），新 UI 渲染紫色命令卡、按 `cmdId` 折叠实现原地更新。

### 3.2 模块与依赖方向

```
                    ┌──────────────────────────── agent（主会话，post-guard 接线）────────────────────────────┐
 TUI 输入 /x ──────▶│ pi prompt() ─▶ wrapCommandApi 包装的 handler                                            │
                    │                                                                                        │
 web cmd op ─▶ builtin-bridge ┬ 扩展命令：recorder.noteIntent(cmdId,match,display,sessionId) + capture.arm     │
                    │         │            └ sendUserMessage("/x") ─▶ 同上 handler（可能被 agent_settled 推迟）│
                    │         ├ 第三方扩展：sendUserMessage 后 recordImmediate(terminal-only)                  │
                    │         ├ session/name/thinking：pi 调用成功后 recordImmediate                           │
                    │         ├ model/compact：recorder.beginExternal → 在 Promise / onComplete 结算处 settle  │
                    │         ├ new：execGate.armNew(cmdId) → internalExec 执行点 → recordImmediate → newSession│
                    │         ├ reload：#42 不记录（无 noteIntent），仅转发 /agent reload       │
                    │         └ resume __pick：resume-exec 最后一道同步检查之后、switchSession 之前 record      │
                    │                                                                                        │
                    │  handler 包装：invocation = capture.take() ; rec = recorder.begin()                     │
                    │    ├ 认领（web 窗口）：createCapturedUi 现有行为 + tee → rec.sink                          │
                    │    └ 未认领（TUI / 被推迟的 web / rpc）：createObservedUi（全透传，旁路记账）→ rec.sink     │
                    │    ctx 代理拦截 newSession/fork/switchSession/reload：离开前 rec.commitBeforeLeave()（reload 不写离场行）      │
                    │  rec：懒 start(400ms) → settle → secure.recheckForWrite → try pi.appendEntry             │
                    │  StatusInfo.features ∋ "cmd.history.v1"（仅已持久化会话）；StatusInfo.cmdRunning          │
                    └────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ session.jsonl（首条对话前在内存）
                                   ▼
 hub：history.ts ─▶ protocol/keys.ts projectSessionEntry（subagent:cmd ⇒ custom 墓碑 + cmd）
      caps ∋ "cmd.history.v1"；runTail：persisted 会话文件 ENOENT ⇒ branch_req 回落（按 pending leaf 截断）
                                   │ SSE history / append / status
                                   ▼
 UI：state.js（custom+cmd ⇒ kind:"cmd"）─▶ entries.ts 按 cmdId 折叠 ─▶ TxCommand.vue（紫卡，PathText）
     DetailDock：historyMode = hubCaps∋cap ∧ status.features∋cap ⇒ 不挂 CommandResult；本地占位卡 + 精简提示
```

依赖方向：`protocol/`（纯、无 pi）← `agent/`、`hub/`、`ui/`；`agent/command-record.ts` 只依赖 protocol + 注入的 deps（便于单测）；secure 只读查询经 `src/index.ts` 注入，web-hub 不 import `src/secure/`。

### 3.3 新增 / 修改模块职责

| 模块                                                                                                                                                  | 新/改 | 职责                                                                                       | 为什么必须存在                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `src/web-hub/protocol/cmd-record.ts`                                                                                                                  | 新    | `CMD_RECORD_ENTRY_TYPE`、`CmdRecordData`/`CmdRecordWire` 类型、`sanitizeCmdRecord()`       | 持久化格式冻结、三方共用                       |
| `src/web-hub/protocol/keys.ts`                                                                                                                        | 改    | `projectSessionEntry` 加 `subagent:cmd` 分支                                               | 唯一投影点                                     |
| `src/web-hub/protocol/{messages,version}.ts`                                                                                                          | 改    | `WireEntry.cmd?`、`StatusInfo.cmdRunning?`、`CmdData(command).history?`、`CMD_HISTORY_CAP` | 开放面，无 PROTO bump                          |
| `src/web-hub/agent/command-record.ts`                                                                                                                 | 新    | 记录器：策略表、懒 start、会话守卫、secure 守卫、意图账本、写条目、running 列表、计数      | 与捕获窗生命周期不同（30 min、落盘、TUI 透传） |
| `src/web-hub/agent/command-capture.ts`                                                                                                                | 改    | `wrapCommandApi` 第 5 参 `getRecorder`；observe 模式；认领模式 tee；ctx 离开拦截           | 唯一能看到 toolkit handler 的地方              |
| `src/web-hub/agent/builtin-bridge.ts`                                                                                                                 | 改    | `noteIntent`；builtin / 第三方记录；结果（同步与 late）带 `history`                        | web 派发唯一入口                               |
| `src/web-hub/agent/resume-exec.ts`                                                                                                                    | 改    | `ExecGate.armNew(cmdId?)`/`consumeNew` 返回 cmdId；`__pick` 执行点记录                     | `/new`、`/resume` 的真实执行点在这里           |
| `src/web-hub/agent/index.ts`                                                                                                                          | 改    | 构造 recorder、`internalExec("new")` 记录、`features`、`cmdRunning`、`/webhub status` 行   | 装配点                                         |
| `src/web-hub/agent/cmd-history-status.ts`                                                                                                             | 新    | `/webhub status` 的 `cmd-history:` 行                                                      | 同 `cmd-args-status.ts`                        |
| `src/secure/guards.ts`                                                                                                                                | 改    | `SecureGuardWiring.recheckForWrite(ctx)` 只读查询                                          | LOCKED 期间命令仍执行，必须有写前复核（M1）    |
| `src/index.ts`                                                                                                                                        | 改    | `commandRecorderRef` + 把 `secureGuards?.recheckForWrite` 注入 web-hub deps                | 包装发生在 activate 第一行                     |
| `src/config/settings.ts`                                                                                                                              | 改    | `webHub.cmdHistory: boolean`（默认 true，非 live）                                         | 可关闭                                         |
| `src/web-hub/hub/{history,hub}.ts`                                                                                                                    | 改    | `runTail` ENOENT 回落；cap 声明                                                            | §4.10 / §4.6                                   |
| `ui/src/logic/cmdRecord.ts`                                                                                                                           | 新    | 纯函数：校验、折叠、状态判定、复制文本、行数                                               | 可单测                                         |
| `ui/src/components/transcript/TxCommand.vue`                                                                                                          | 新    | 紫色命令卡                                                                                 | 新条目类型                                     |
| `ui/src/composables/useCmdHistory.ts`                                                                                                                 | 新    | 每 agentKey 的本地占位、seenRunning；provide 给 Transcript                                 | DetailDock 与 Transcript 是兄弟                |
| `ui/src/{logic/state.js,logic/transcript.js,types.ts,components/transcript/{entries.ts,Transcript.vue},components/detail/DetailDock.vue}`、样式、i18n | 改    | 接入                                                                                       | —                                              |

`CommandResult.vue` **保留不改**（legacy 路径）。

---

## 4. 接口契约

### 4.1 持久化条目（冻结面 F1）

customType **`subagent:cmd`**。只经 `pi.appendEntry` 写（type `custom`，不进 LLM 上下文），**永不注册 `registerEntryRenderer`**。

```ts
// src/web-hub/protocol/cmd-record.ts
export const CMD_RECORD_ENTRY_TYPE = "subagent:cmd";

export type CmdRecordSource = "web" | "feishu" | "tui" | "rpc" | "other";
//  feishu：仅当认领到的 web 调用 origin 带 hub 内部飞书标记（isFeishuCmdOrigin）时；今天飞书不转发 command op ⇒ 不可达，保留以防将来放宽
export type CmdRecordState = "done" | "failed" | "timeout";
export type CmdRecordNotice =
  | "terminal-only" // 第三方扩展命令：已发送，输出只在终端
  | "sensitive" // Q5 敏感子命令：只记头部
  | "no-output" // 正常结束但没有任何可记录输出
  | "left-session"; // 命令执行中离开了本会话（新建 / 切换 / 分叉；#42 起重载不写此提示），之后的输出不在本会话

export interface CmdRecordData {
  v: 1;
  cmdId: string; // ^[A-Za-z0-9_-]{16,64}$；web = 帧 id；本地 = "c" + 20 位 base64url
  phase: "start" | "end";
  name: string; // 卡片显示的命令名（与 CommandArgsSchema.name 同 pattern；见 §4.3 display；#42 起 web /reload 不记录，不再用作示例）
  args: string; // 原文，≤512 字符（超出截断 + "…"）
  source: CmdRecordSource;
  startedAt: number; // epoch ms
  // ↓ 仅 phase:"end"
  endedAt?: number;
  state?: CmdRecordState;
  output?: CommandOutputWire; // 原文（Q1）；预算同捕获引擎（8 KiB/条、32 KiB/64 条）；header-only 时缺省
  notice?: CmdRecordNotice;
  error?: string; // 失败原因原文，≤512 字符
}
```

规则：

- **end 自包含**（带 name/args/source/startedAt），start 可省（懒 start）。
- 读方容忍未知字段；`v!==1` ⇒ 投影为纯墓碑。
- `state`：抛错 / 执行失败 / 被取消 ⇒ `failed`；正常 ⇒ `done`（哪怕只 notify 了 error 行）；超过 `RECORD_MAX_MS` ⇒ `timeout`。
- 崩溃 / 未写 end 的「中断」不落盘，由 UI 推断（§4.7）。
- 文本只经 `sanitizeText`（去 ANSI/控制字符，现有函数）与预算截断，**不做任何脱敏**（Q1）。

### 4.2 原地更新：两条条目 + UI 按 cmdId 折叠（D1）

- 快命令（handler 在 `START_DELAY_MS = 400` 内结束）只写 1 条 end；慢命令 400 ms 时写 start，结束写 end。`/compact` 不写懒 start（§5.2）。
- UI 折叠（纯函数 `foldCmdRecords`）：
  1. 同 `cmdId` 第一次出现的位置决定卡片位置；
  2. 有 end ⇒ 用**最后一条** end 的数据渲染（取消切换会追加第二条 `failed`，§4.4），end 行本身隐藏；
  3. 只有 end（start 不在已加载窗口或没写）⇒ 在 end 位置独立渲染；
  4. 向前翻页把 start 加载进来 ⇒ 卡片上移到 start 位置（一次重排，滚动锚走现有 E1-1 机制）。
- **fork**：分支路径被复制，记录随之复制；fork 出的会话里未结束的 start ⇒「结果未记录」。
- **compaction / context-switch**：条目留在文件里，hub 读整条分支，卡片照常显示；本来就不进上下文。
- **`/tree`**：卡片属于所在分支。命令执行中 `/tree` 切走 ⇒ end 落在新分支 ⇒ 按规则 3 独立渲染。
- **getBranch 读回**：hub 读文件与 agent `branch_req` 回落都走同一 `projectSessionEntry`。

### 4.3 记录器（agent 内部契约）

```ts
// src/web-hub/agent/command-record.ts
export interface CommandRecorderDeps {
  appendEntry(customType: string, data: unknown): void; // = pi.appendEntry（同步 fs 写，可能抛）
  sessionId(): string | undefined; // 现取 live ctx 的 getSessionId，抛错 ⇒ undefined
  now(): number;
  setTimer(ms: number, fn: () => void): { cancel(): void }; // 必须 unref
  recheckForWrite?(ctx: ExtensionContext | undefined): string | undefined; // = secureGuards?.recheckForWrite；返回 LOCKED 原因 ⇒ 不写
  onChange(): void; // = publishStatus
}
export type RecordPolicy = "record" | "header-only" | "skip";
export interface CommandRecorder {
  policyFor(
    name: string,
    args: string,
    kind: "extension" | "builtin" | "template" | "skill",
    owned: boolean,
  ): RecordPolicy;
  /** 仅 builtin-bridge 调用（B2：prompt op 不登记）。按 match 精确匹配，display 写进记录。 */
  noteIntent(i: {
    cmdId: string;
    source: "web" | "feishu";
    sessionId: string;
    at: number;
    match: { name: string; args: string }; // 实际会执行的命令
    display?: { name: string; args: string }; // 卡片显示；缺省 = match
  }): void;
  /** toolkit handler 进入时（wrapCommandApi 调用）。skip / 停用 ⇒ undefined。 */
  begin(i: {
    name: string;
    args: string;
    ctx: ExtensionCommandContext;
    claimed?: { cmdId: string; source: "web" | "feishu" };
  }): RecordHandle | undefined;
  /** bridge 的异步 builtin（/model /compact）：无 handler ctx，懒 start 可关。 */
  beginExternal(i: {
    cmdId: string;
    name: string;
    args: string;
    source: "web";
    lazyStart: boolean;
  }): RecordHandle | undefined;
  /** bridge 的同步记录（单条 end）：第三方 terminal-only、session/name/thinking、new、resume。
   * 返回 boolean（A1 验收 m1 同步）：该 end 是否真的落盘 —— resume-exec 用它驱动 `ticket.recorded`
   * （late `history` 字段：写成功 ⇒ "recorded"，检查失败/守卫跳过 ⇒ "none"）。 */
  recordImmediate(r: {
    cmdId: string;
    name: string;
    args: string;
    source: CmdRecordSource;
    startedAt: number;
    state: CmdRecordState;
    output?: CommandOutputWire;
    notice?: CmdRecordNotice;
    error?: string;
  }): boolean;
  running(): string[];
  counters(): { appended: number; skipped: number; failed: number };
  dispose(): void;
}
export interface RecordHandle {
  readonly cmdId: string;
  sink(entry: CommandOutputEntry): void; // 关闭后静默丢弃并释放 buffer
  commitBeforeLeave(kind: "new" | "fork" | "switch" | "reload"): void; // 立即写 end(done, notice:"left-session") 并关闭；kind="reload" 时不带离场行/notice（#42，防御性分支——reload 族已 skip，通常无 handle）
  afterLeaveCancelled(error?: string): void; // 离开被取消 / 抛错：再写一条 end(failed)，同 cmdId（最后一条生效）
  settle(outcome: { error?: unknown; failed?: string }): void; // 只生效一次；commitBeforeLeave 之后为 no-op
}
```

常量：

| 常量                   | 值          | 说明                                           |
| ---------------------- | ----------- | ---------------------------------------------- |
| `START_DELAY_MS`       | 400         | 懒 start 阈值                                  |
| `RECORD_MAX_MS`        | 30 min      | 到点写 `end{timeout}` + 已收集输出，之后不再记 |
| `INTENT_TTL_MS` / 上限 | 10 min / 16 | 意图账本，FIFO 淘汰                            |
| `RUNNING_MAX`          | 16          | `cmdRunning` 上限（最新优先）                  |

**cmdId / source 解析**（`begin`）：`claimed`（认领到的 web 调用）→ 意图账本命中（被 agent_settled 推迟、5 s 后才执行的 web 调用 —— **G7 的修复**）→ 本地生成，source 按 `ctx.mode`：`"tui"`→`tui`，`"rpc"`→`rpc`，其它→`other`。

- 意图匹配：**同 sessionId** ∧ `(match.name, match.args)` 精确相等 ∧ 未过期，取**最旧**一条（与 capture 回退队列 `findIndex`、pi deferred actions 按序执行一致）；命中即删。认领路径按 cmdId 删除对应意图。
- 会话切换（recorder 观察到 `sessionId()` 变化，或 web-hub 的 session 事件）⇒ 清空其它会话的意图。
- `/reload` 重建 recorder ⇒ 意图全丢；之后才执行的被推迟 web 调用按本地 cmdId + mode 标源（残留 R4）。

**为什么认领路径还需要意图账本**：推迟 <5 s 的调用能被 capture 回退队列认领（`claimed` 带 cmdId），但 bridge 早已答了 `unknown`；推迟 >5 s 的调用认领失败，只能靠账本对回 cmdId。两种情况记录都在 handler 执行时创建，与 ledger 是否已结算无关。

**写入守卫**（每次写 start / end 前，按序）：

1. `recheckForWrite?.(ctx)` 返回原因 ⇒ skip（计 `skipped`），**不调 appendEntry**（LOCKED 期间命令照样执行，§5.4）；
2. `sessionId()` 与 begin 时不等或为 undefined ⇒ skip；
3. `try { appendEntry(...) } catch { failed++ }`——`appendEntry` 是同步 `appendFileSync`，pi 不 catch，IO 异常会直抛到 recorder；成功 ⇒ `appended++`（未落盘会话在内存中「成功」，首条对话时随整体刷盘，计数语义是「已交给 pi」）。

任何失败静默，不影响命令本身、不抛进 pi。

### 4.4 `wrapCommandApi` 改造（契约 F2）

签名追加可选第 5 参 `getRecorder?: () => CommandRecorder | undefined`（每次调用现取，不缓存）。

```
capture  = getCapture(); invocation = capture?.take(name, args)
handle   = getRecorder()?.begin({ name, args, ctx, claimed: invocation ? {cmdId, source} : undefined })
if (!invocation && !handle)  return Reflect.apply(handler, this, [args, ctx])        // 与今天逐字节相同
ctxProxy = invocation ? createCapturedCtx(ctx, capture, cmdId, origin, handle)        // 现有语义 + tee + 离开拦截
                      : createObservedCtx(ctx, handle)                                 // observe 模式 + 离开拦截
return runRecorded(...)   // finally：capture?.finish(cmdId) + handle?.settle({error})
```

**observe 模式**（TUI 捕获，「不改变终端原有显示」的硬契约）：

1. 每个 `ctx.ui.*` 调用以**相同参数**转发给真实 UI，**原样返回**其返回值（交互方法返回原 Promise 对象）；不吞、不改、不替换。
2. 旁路记账：`notify` → `{kind:"notify",level,text}`；`setWidget(key, string[])` → `{kind:"widget",key,text}`，组件工厂 → `"(rendered in terminal)"`，`undefined` 不记；`setStatus(key,text)` → `{kind:"status"}`；`confirm/select/input/editor/custom` → `{kind:"interactive", title, text:<方法名>}`，**不记用户答案、不记 input 值、不记 editor 预填**；`setEditorText/pasteToEditor` 不记。
3. `ctx` 代理**不加** `webInvocation`/`feishuInvocation`；其余属性委托同现有 `createCapturedCtx`。
4. handler 抛错：记 `error` 条目后**原样重抛**。
5. 同步 handler 包装成 async 后主体仍同步执行；pi 本就 `await command.handler`。

**认领模式**（web）：`createCapturedUi` 现有行为一字不改，只在每个 `collect` 处追加 `handle?.sink(entry)`。例外（**与脱敏无关，保留**）：落盘记录里 `kind:"text"`（editor 预填）只保留 title，正文替换为 `"(编辑器内容未记录)"`——预填可能是草稿或密钥，web 实时窗口仍按今天显示。

**会话离开拦截**（两种模式都有）：ctx 代理拦截 `newSession / fork / switchSession / reload`（#42：reload 仍被拦截并提交记录，但不写离场行；reload 族命令本身 policy=skip，通常无记录可提交）：

- 调用前 `handle.commitBeforeLeave(kind)`：立刻写 end（`state:"done"`、已收集输出 + 一行 `{kind:"notify",level:"info",text:"→ 已离开本会话（新建/分叉/切换；reload 不写此行，#42）"}`、`notice:"left-session"`），记录关闭；
- 以相同参数转发，**返回原 Promise 对象**；另挂一个吞错的 `.then` 观察：结果 `{cancelled:true}` 或 Promise 拒绝 ⇒ `handle.afterLeaveCancelled(...)` 写第二条 `end{failed}`（此时没离开，ctx 仍有效；写失败照常吞掉）；
- 切换成功后旧 ctx 失效，handler 后续的 `settle` 是 no-op。
- 这让 `/clear`、`/resume-recent`、`/topic-switch` 的非内部子命令都能正常记录，不需要排除。

### 4.5 hub 投影（契约 F3）

`projectSessionEntry` 的 `custom` 分支，在 tool-timing 分支之后：

```ts
if (r.customType === CMD_RECORD_ENTRY_TYPE) {
  const cmd = sanitizeCmdRecord(r.data); // 失败 ⇒ undefined
  return {
    id: r.id,
    parentId,
    type: "custom",
    timestamp: r.timestamp,
    customType: r.customType,
    dataKey: customKey(r.customType, r.data),
    display: false,
    ...(cmd !== undefined ? { cmd } : {}),
  };
}
```

`sanitizeCmdRecord`：确定性纯函数，按不可信输入再校验——`v===1`、cmdId/name pattern、枚举、有限数字；args/error ≤512 字符；output 重套预算（kind/level 白名单、text ≤8 KiB、key ≤64、title ≤200、≤64 条、总 ≤32 KiB，超出计入 `truncated`）；丢弃未知字段。只做结构与大小校验，不改内容。`WireEntry.cmd?: CmdRecordWire`；`WireEntrySchema` 本就开放。

### 4.6 能力与开放字段（契约 F4）

| 面                                                    | 字段                     | 规则                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub caps（HubInfo.caps + hello_ack.caps）             | `"cmd.history.v1"`       | 新 hub 静态声明                                                                                                                                                                        |
| `StatusInfo.features`                                 | 追加 `"cmd.history.v1"`  | recorder 已接线（`webHub.enabled ∧ cmdHistory !== false`，主会话）**且会话已持久化**（`getSessionFile()` 有值，同 `resume.v1`）；顺序 `[resume.v1?, cmd.history.v1?]`；都无 ⇒ 字段缺省 |
| `StatusInfo.cmdRunning?: string[]`                    | 未结束记录 cmdId（≤16）  | 非空才出现                                                                                                                                                                             |
| `CmdData`（command）`.history?: "recorded" \| "none"` | 本次调用是否会出现命令卡 | 新 agent **在同步回复、扩展命令的 `sendLate` late 数据、builtin 的 late 数据里都写**；ledger 保留                                                                                      |

`--no-session` 会话不声明 feature ⇒ UI 走 legacy 临时卡片（记录仍写进内存，刷新时经 `branch_req` 可见）；与 §4.10 不对它做实时回落一致。

**UI 门控** `historyMode = hubCaps ∋ "cmd.history.v1" ∧ status.features ∋ "cmd.history.v1"`。为假 ⇒ DetailDock/CommandResult 走今天的代码，DOM 逐字节不变。卡片渲染只看数据（合法 `cmd` 字段即渲染）；临时卡片的去留只看门控。

`history` 取值（bridge，按 §5.2 策略）：

| 调用                                                               | history                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| toolkit 扩展命令 policy=record / header-only（含被推迟执行）       | `recorded`                                                                                               |
| toolkit 扩展命令 policy=skip（只剩内部跳板，§5.2）                 | `none`                                                                                                   |
| 第三方扩展命令                                                     | `recorded`                                                                                               |
| builtin `session/name/thinking/model/compact/new`，`resume __pick` | `recorded`；执行前就被拒的（参数错、exec 被占、ctx 失效等 effect-none 错误）返回错误本身，不出现 history |
| `resume __list`、template、skill                                   | `none`                                                                                                   |
| **字段缺失**（防御）                                               | 一律视同 `none`（不放占位）——唯一推断规则（n1）                                                          |

### 4.7 UI 契约

**数据流**：`entryItem`：`entry.type==="custom" && isCmdRecordWire(entry.cmd)` ⇒ `{kind:"cmd", entry}`；其它 custom 墓碑不变。`Item.kind` 加 `"cmd"`。

**纯函数**（`ui/src/logic/cmdRecord.ts`）：

```ts
export interface CmdCardView {
  cmdId: string;
  name: string;
  args: string;
  source: CmdRecordSource;
  startedAt: number;
  endedAt?: number;
  state: "running" | "done" | "failed" | "timeout" | "unrecorded";
  output?: CommandOutputWire;
  notice?: CmdRecordNotice;
  error?: string;
  local?: true;
  anchorEntryId?: string;
}
export function foldCmdRecords(items: readonly Item[]): { byIndex: Map<number, CmdCardView>; hidden: Set<number> };
export function resolveCmdState(
  rec: { hasEnd: boolean; endState?: CmdRecordState; cmdId: string },
  live: { running: ReadonlySet<string>; seenRunningAt?: number; now: number },
): CmdCardView["state"];
export function cmdPlainText(v: CmdCardView): string;
export function cmdLineCount(v: CmdCardView): number;
```

`resolveCmdState`：有 end ⇒ 最后一条 end 的 state；仅 start：`status.cmdRunning ∋ cmdId` ⇒ `running`；本标签页 5 s 内见过它 running（end 的 append 帧比 status 帧晚到）⇒ `running`；否则 ⇒ `unrecorded`（「结果未记录：会话中断或已切换」）。

**本地占位卡**（`useCmdHistory`，仅 `historyMode`）状态机：

- DetailDock `runCommand` 自生成 cmdId（`runCommand(..., {id})`），立刻放 `local:true, state:"running"` 卡于 transcript 末尾；
- 同 cmdId 的记录条目到达 ⇒ 占位移除，真卡在其文件位置渲染；
- 回复（同步或 late）`history:"none"` 或 `history` 缺失 ⇒ 占位移除，改一行精简提示「已执行 /x」（4 s 自动消失）；
- 派发失败（effect none 的错误）⇒ 占位移除 + 精简错误提示；
- 60 s 内无记录 ⇒ 占位移除，改精简提示「结果暂未记录（可能仍在排队或已中断）」（可手动关，不自动消失）；**之后真卡若到达**（例如被长时间推迟的命令终于执行），真卡照常出现在其位置，同时移除该 cmdId 的精简提示——二者不会同时存在。

**DetailDock（historyMode）**：不设置 `cmdResult`、不挂 `CommandResult`；`E_CONFIRM_REQUIRED` ⇒ `CommandConfirm` 不变；第三方命令 2 s 内出现非 ask_user `ui_prompt_start` ⇒「需回终端操作」提示保留。异步 `watchCommandItem`/`queryOnly` 在 historyMode 下不再需要（输出来自记录），仅保留读取 late 数据的 `history` 字段以驱动占位状态机。

**TxCommand.vue**（对齐预览）：

- `article.msg-cmd.tx-item`，复用 `.msg-assistant` 网格；头像 ⌘；who「命令」+ 时间；
- chips：来源（`web`/`tui`/`飞书`/`rpc`/`other`）、「不进上下文」、状态（running 旋转符 / done / failed / 已截止 / 结果未记录）；右侧「复制」（复用 `CopyButton.vue`，复制 `cmdPlainText`）；
- 正文：notify ⇒ level 徽标 + `<pre>`；widget/status ⇒ 按 key 分组；text/error ⇒ `<pre>`；interactive 收成一行（认领：「以下交互步骤需在终端完成：…」；observe：「已在终端交互：…」）；`truncated` 页脚；`clipped` 尾标；
- notice：`terminal-only`「已发送，输出仅在终端」、`sensitive`「敏感命令，输出未记录」、`no-output`「无输出」、`left-session`（正文中的离开提示行即可，无额外横幅）；
- 折叠：`cmdLineCount > 6` ⇒ 默认约 6 行 +「展开全部 / 收起」（本地状态）；
- **只用文本节点**，每行 `<PathText :text="line" />`；禁 `v-html`。

**v-memo**：`itemRenderKey` 对 `kind:"cmd"` 返回 `${it.id}|${foldSig}`，`foldSig` 含最后一条 end 的条目 id 与 resolve 后的 state——否则 end 到达时卡片不刷新。

### 4.8 PathText 接入（G3）

正文逐行交给 `PathText`，受 `PREVIEW_CTX` 与 probe 管理；本机 / 局域网 `http://` 由内置 `findProxyUrlRefs` 走代理。原文落盘 ⇒ `/record` 的带 `?token=` 查看页链接在任何设备都可直接点开（Q1 的直接收益，也是 §5.3 的残留来源）。

### 4.9 设置与可见性

- `webHub.cmdHistory: boolean`，默认 `true`，非 live（`/reload`）。`false` 或 `webHub.enabled=false` ⇒ 不构造 recorder，`wrapCommandApi` 走今天分支，不声明 feature，不写条目。
- `/webhub status` 追加 `cmd-history: on|off · hub-cap on|off|n/a · appended <n> · skipped <m> · failed <k>`（英文标记）。

### 4.10 hub `runTail` ENOENT 回落（M4 规格）

- **触发条件**（全部满足）：`file !== undefined`（会话有路径）∧ `readBranch` 返回 `ENOENT` ∧ agent 在线。`--no-session`（`file===undefined`）**保持今天的早退，不纳入**；`TOO_LARGE/PARSE/LEAF_NOT_FOUND` 维持现逻辑。
- **动作**：`registry.request(branch_req{maxBytes: 256 KiB})`，按 pending leaf 截断（`findIndex(e.id===leaf)`，同 `loadBranch:466`；**找不到 leaf ⇒ 视同读失败，等下一次 leaf 变化**，避免重复 diff），再取尾 `APPEND_TAIL_ENTRIES`，照常 `diffAppended` → `append`。
- **超时**：`TIMING.snapshotMs`（5 s），unref；超时 / 出错 ⇒ `log.info` 后 return，不抛；沿用 `st.reading` 单飞与 500 ms debounce。
- **成本界**：只在会话文件尚不存在（首条 user/assistant 消息前）时发生，此时 branch 很小。
- **开关边界（如实）**：hub 不知道 agent 的 `cmdHistory`，回落无条件生效。对 `cmdHistory=false` 或旧 agent 的已持久化会话，「首条消息前」窗口内的其它 idle custom 条目（例如 fabric 显示消息）也会因此**开始**实时 append——这是行为变化（改善），不在「开关关闭即不变」的承诺范围内（§1.3）。

---

## 5. 范围、捕获边界与安全

### 5.1 记什么 / 抓不到什么

| 场景                                                                                                      | 能否看到                                                                  | 处理                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| TUI 执行的 toolkit 命令                                                                                   | 能                                                                        | observe 模式，source `tui`                           |
| web 执行的 toolkit 命令（含 agent_settled 推迟）                                                          | 能                                                                        | 认领或意图账本对回 cmdId，source `web`               |
| web 执行的第三方扩展命令                                                                                  | 只知道派发                                                                | 记 `notice:"terminal-only"`（Q4）                    |
| web 执行的 builtin（session/name/thinking/model/compact/new；reload 除外，#42）、网页恢复对话框 `/resume` | 能                                                                        | 全记（Q3），见 §5.2                                  |
| GUI 控件触发的命令（ModelSwitcher、ThinkingChip、RenameButton、频道 / 别名对话框、`/title auto`）         | 能                                                                        | 全记（Q2）                                           |
| prompt op 里的 `/x` 文本（飞书、未开命令模式）                                                            | 不是命令                                                                  | pi 不执行，作为普通用户消息进 transcript（B2）；不记 |
| TUI 执行的第三方扩展命令 / pi 内置命令                                                                    | **看不到**（pi 自己的 ctx；扩展命令不触发 `input`；内置命令在交互层处理） | 不记（Q4）                                           |
| template / skill                                                                                          | 变成用户消息                                                              | 不记                                                 |

toolkit 命令内部抓不到的输出：经**之前存下的其它 ctx** 调 `ui.notify`；handler 结束之后的异步通知；`pi.sendMessage` 的 custom_message（本来就进 transcript）；`setWidget` 组件工厂与 `ui.custom` 的画面（只记标记）；`console.*`。

### 5.2 策略表与 builtin 卡片定义（冻结面 F5）

**skip（完全不记）**——只剩内部跳板：

| 规则                                                      | 原因                                |
| --------------------------------------------------------- | ----------------------------------- |
| 任意命令，args 首 token 以 `__` 开头（`/webhub __exec new | resume`、`/topic-switch __go`）     | 内部 nonce 跳板；它们代表的用户动作由 bridge 记录（`/new`、`/resume`） |
| `agent reload`（含 now/cancel/fire）、`/reload`           | #42：reload 族一律不记录（修订 Q3） |
| `resume __list`                                           | 恢复对话框的只读轮询                |
| template / skill                                          | 见 §5.1                             |

**header-only（`notice:"sensitive"`，不落 output）**——Q5：`/webhub` 的 `open`（`#t=` 令牌 URL）、`token`、`2fa`、`passwd`、`user`、`unlock`、`feishu`、`lan` 及**未知子命令**（fail-closed）。可完整记录的 `/webhub` 子命令白名单：`status`（含裸 `/webhub`）、`restart`、`stop`、`start`。

**record**：其余全部 toolkit 命令（含 `/clear`、`/resume-recent`、`/topic-switch status|last`，借 §4.4 离开拦截）、第三方 terminal-only 占位、以及下列 builtin。

**builtin 卡片定义**（全部 source `web`，cmdId = 帧 id，均由 bridge 写；bridge 的返回值与 ledger 结算路径**一字不改**，记录是旁路观察，M3）：

| 命令                                 | 写入时机                                                                                                                                                                                                                                                | done 正文                                              | failed                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/session`                           | `buildSessionText` 之后，`recordImmediate`                                                                                                                                                                                                              | `{kind:"text"}` = 现有会话信息文本                     | —                                                                                                                               |
| `/name <x>`                          | `pi.setSessionName` 成功返回后                                                                                                                                                                                                                          | notify：`会话名称：<x>`                                | `setSessionName` 抛错 ⇒ 不记（返回 `E_STALE_CTX`，effect none）                                                                 |
| `/thinking <lv>`                     | `pi.setThinkingLevel` 成功返回后                                                                                                                                                                                                                        | notify：`思考等级：<lv>`                               | 同上                                                                                                                            |
| `/model <p/m>`                       | `beginExternal(lazyStart:true)` 于 `setModel` 调用前；在**同一个 `pending` Promise 上另挂**的观察回调里 settle（不改原 `.then` 链与返回值，`sendLate` 有无都挂）                                                                                        | `accepted===true` ⇒ notify：`模型：<p/m>`              | `accepted===false` ⇒ `failed`，error：`authentication not configured for that model`；Promise 拒绝 ⇒ `failed`，error 为拒绝消息 |
| `/compact [指令]`                    | `beginExternal(lazyStart:false)`（**不写 start**，避免在压缩进行中追加条目）；把 `ctx.compact` 的 `onComplete/onError` 包一层：先调原回调（`sendLate`，若有），再 settle；`sendLate` 缺失时也传入仅用于记录的回调                                       | notify：`上下文已压缩`（有指令时追加一行 `指令：<…>`） | `onError(e)` ⇒ `failed`，error：`e.message`                                                                                     |
| `/new`                               | bridge `armExec("new", cmdId)`；`internalExec("new")` 在 `consumeNew` 成功之后、`ctx.newSession()` 之前 `recordImmediate(done, notice:"left-session")`；`newSession` 返回 `{cancelled:true}` 或抛错 ⇒ 再 `recordImmediate(failed)`（最后一条 end 生效） | notify：`已新建会话并切换过去（之后的对话在新会话中）` | `新建会话被取消` / 抛错消息。nonce 过期 ⇒ 不记（TUI 已有 warning）                                                              |
| `/reload`（#42：不记录）             | 仅转发 `/agent reload`；reload 族 policy=skip，bridge 不 `noteIntent`、不写卡，回复 `history:"none"`                                                                                                                                                    | —                                                      | —                                                                                                                               |
| `/resume`（网页恢复对话框 `__pick`） | `resume-exec.ts` 执行点：**全部权威同步检查（含「源会话未变」）通过之后**、`ctx.switchSession` 之前 `recordImmediate(done, notice:"left-session")`——必须在检查之后，否则写入会让「源会话未变」检查自我失败；`switchSession` 取消 / 失败 ⇒ 再记 `failed` | notify：`已切换到会话 <标题或 id 前 8 位>`             | 取消 / `resume:mismatch` 等错误码                                                                                               |

执行前就被拒的调用（参数错误、`exec:in-flight`、ctx 失效等 effect-none 错误）不记录，UI 显示精简错误提示——「记录」的定义是「真正执行了的调用」。

### 5.3 原文落盘的已接受残留（M2，按 Q1 拍板，不得改为脱敏）

会话文件（0600，位于 `~/.pi/agent/sessions` 或保险库内）将**明文保存命令输出**。已知会落盘的活凭据：

| 来源                                      | 内容                                              | 有效期                                                                |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `/record on                               | status`                                           | 流量查看页 URL 的 `?token=`（可 LAN 可达，取决于 `traffic.web.host`） | 本次查看页服务存续期间 |
| `/fabric alias <名> --take[=<token>]`     | args 与输出两处的 take token                      | 5 min、单次、绑定请求者                                               |
| `/agent settings`                         | 若设置里配置了飞书 webhook，其 URL 路径尾部即凭据 | 长期                                                                  |
| 其它命令中由用户自己写进设置 / 记忆的密钥 | 视内容                                            | —                                                                     |

外泄面：pi 原生 `/export`、`/share`；web 预览的任意路径准入（会话文件本身可被预览，U4 已接受）；LAN 上的 transcript 查看；secure 会话的 web-hub 明文副本（既有 R12）。缓解：Q5 敏感子命令只记头部（hub 凭据不落盘）；editor 预填 / input 值不落盘；文档与 `/webhub status` 无需额外提示。**日志卫生**：命令输出只进会话文件，hub.log 与 agent 侧日志不得出现输出正文（已核实现有日志点干净；验收 §8.5 #7）。

### 5.4 secure 域 / 隐私锁 / 大小

- **secure 域**：会话文件在保险库内 ⇒ 照常写（静态加密）。**LOCKED**：扩展命令绕过 `input` 事件，LOCKED 期间命令仍会执行；recorder 每次写前调用注入的 `recheckForWrite(ctx)`（`src/secure/guards.ts` 新增只读查询：内部跑一次 `recheckMount(ctx)`——与 `tool_call`/`input` 相同的一次 `/proc` 读，发现卸载会照常进入 LOCKED 并提示——然后返回 `lockedReason()`），有原因 ⇒ 不调 `appendEntry`、计 `skipped`。plain 域无保险库时 guards 不接线 ⇒ deps 缺省 ⇒ 视为可写。
- **隐私锁**：锁整个会话详情视图，命令卡是 transcript 的一部分，自动覆盖。
- **大小**：单条记录 ≤ ~34 KiB；大量大输出会挤占首屏历史深度（`hasMore` 分页兜底）。截断提示：条目级 `clipped`、窗口级 `truncated`。

---

## 6. 兼容矩阵

| agent                   | hub | UI         | 结果                                                                                                                                                                            |
| ----------------------- | --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧                      | 新  | 新         | 无记录、无 feature ⇒ legacy 临时卡片，DOM 不变                                                                                                                                  |
| 新                      | 旧  | 旧         | 旧 hub 投影为纯墓碑，旧 UI 看不见；status 多出的 `features`/`cmdRunning`、回复多出的 `history` 被旧端忽略；agent 的 `output`/`cmd_late`/`queryOnly` 通道原样保留 ⇒ 临时卡片照常 |
| 新                      | 新  | 旧标签页   | 条目是墓碑 + 多余 `cmd` ⇒ 看不见；临时卡片照常                                                                                                                                  |
| 新                      | 旧  | 新（理论） | 无 hub cap ⇒ legacy；`branch_req` 回落路径带 `cmd` 时卡片也能显示（无害）                                                                                                       |
| 新                      | 新  | 新         | 完整功能                                                                                                                                                                        |
| 旧 toolkit 读新会话文件 | —   | —          | 无渲染器 ⇒ TUI 不显示；旧 hub 墓碑；不进上下文                                                                                                                                  |
| 其它模块                | —   | —          | session-nav（标题、子会话判定、provenance）、consult fork（custom 不进 payload）、context-switch 附录（只扫 tool call）、traffic 不受影响，测试钉住                             |

无 PROTO bump、不改 `CommandArgsSchema`、不新增帧。

---

## 7. 关键决策

| #   | 决策                                                                                | 理由                                                                      | 否决的备选                                                                      |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D1  | start/end 两条 + 懒 start + 按 cmdId 折叠，最后一条 end 生效                        | `appendEntry` 只能追加；多数命令只写 1 条；end 自包含；取消切换可追加纠正 | 只写 end（无 running 态）；增量写（条目爆炸）                                   |
| D2  | 崩溃类中断不落盘，UI 用 `cmdRunning` + 5 s 宽限推断；会话离开类在离开**前**提交     | 不在 shutdown/resume 时改写会话文件；离开前提交覆盖了可预期的离开         | 启动扫描孤儿补写                                                                |
| D3  | 墓碑 + `cmd` 字段                                                                   | 旧 UI 天然看不见                                                          | 投影成 `custom_message`（旧标签页出怪卡）                                       |
| D4  | 门控 = hub cap ∧ agent feature（仅持久化会话）；渲染只看数据；`history` 缺失 = none | 两端都新才敢去掉临时卡片；单一推断规则不死等                              | 只看 hub cap；按 kind 推断                                                      |
| D5  | recorder 独立于捕获引擎                                                             | 捕获窗 web 语义已冻结；记录要 30 min、落盘、TUI 透传                      | 扩展引擎 Window                                                                 |
| D6  | **原文落盘**（Q1）                                                                  | 与终端所见一致；链接可直接点开；残留登记 §5.3                             | 脱敏（用户否决）                                                                |
| D7  | 意图账本只由 bridge 写，同会话、最旧优先                                            | agent_settled 推迟多久都能对回 cmdId（G7）                                | 拉长回退 TTL（推迟很久后套用 web 合成取消语义）；prompt op 登记（源码证伪，B2） |
| D8  | 不给 command op 加字段                                                              | 封闭 schema                                                               | composer 标志（Q2 已拍板不需要）                                                |
| D9  | `runTail` ENOENT 回落，排除 `--no-session`                                          | pi 首条对话前不落盘；`--no-session` 不声明 feature、保持现状              | recorder 直推帧                                                                 |
| D10 | 不注册 TUI 渲染器                                                                   | 用户要求                                                                  | —                                                                               |
| D11 | builtin 记录挂在真实结算点、旁路观察                                                | 不误标失败；不碰 56c71cae 与 ModelSwitcher 的 ledger 语义                 | dispatch 时写 done                                                              |
| D12 | secure 写前复核用新增只读查询                                                       | LOCKED 拦不住扩展命令；避免向卸载的挂载点写                               | 只读 `lockedReason()`（复核只在 tool_call/input 发生，可能过期）                |

---

## 8. 分包、文件域、冻结面、测试

### 8.1 分包与依赖

```
P0 协议冻结（串行，先做）
 ├─► A1 agent（recorder + 包装 + bridge + secure 查询）┐
 ├─► H1 hub（cap + runTail 回落）                      ├ 并行
 └─► U1 UI（fixture 先行）                             ┘
                 └─► I1 集成 / conformance / 真机验收
```

| 包     | 文件域                                                                                                                                                                                                                                                                                                                                                           | 内容              | 估时    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------- |
| **P0** | `src/web-hub/protocol/{cmd-record.ts(新),keys.ts,messages.ts,version.ts}`；`tests/web-hub/protocol/{keys.test.ts,cmd-record.test.ts(新),messages*.test.ts}`                                                                                                                                                                                                      | §4.1/§4.5/§4.6    | 0.5 d   |
| **A1** | `src/web-hub/agent/{command-record.ts(新),command-capture.ts,builtin-bridge.ts,resume-exec.ts,index.ts,cmd-history-status.ts(新)}`；`src/secure/guards.ts`（仅新增 `recheckForWrite`）；`src/index.ts`（`commandRecorderRef`、注入 secure 查询）；`src/config/settings.ts`（`webHub.cmdHistory`）；对应 `tests/web-hub/agent/**`、`tests/secure/guards*.test.ts` | §4.3/§4.4/§4.6/§5 | 2 d     |
| **H1** | `src/web-hub/hub/{hub.ts,history.ts}`；`tests/web-hub/hub/{history*.test.ts,caps-coexist.test.ts}`                                                                                                                                                                                                                                                               | §4.6 cap、§4.10   | 0.5 d   |
| **U1** | `src/web-hub/ui/src/{logic/cmdRecord.ts(新),logic/state.js,logic/transcript.js,types.ts,composables/useCmdHistory.ts(新),components/transcript/{TxCommand.vue(新),entries.ts,Transcript.vue},components/detail/DetailDock.vue,styles/transcript.css,i18n/*}`；`tests/web-hub/ui/**`                                                                              | §4.7/§4.8         | 2 d     |
| **I1** | `tests/integration/web-hub-cmd-history.test.ts`(新)、`tests/conformance/cmd-history.test.ts`(新)、`docs/dev/web-hub-cmd-history/acceptance.md`(新)、AGENTS.md 一段（含 conformance 进 peer bump 清单）                                                                                                                                                           | §8.3/§8.5         | 0.5–1 d |

合计约 **5.5–6 人日**，按 L3：P0 复审通过后并行派 A1/H1/U1，每包独立 verifier。`commands.ts` 不在任何文件域内（B2）。

### 8.2 冻结面

- F1 `subagent:cmd` 条目 v1（持久化，永久兼容）；
- F2 `wrapCommandApi` 第 5 参、observe 模式五条契约、会话离开拦截；
- F3 投影形状（墓碑 + `cmd`，`dataKey` 对完整 data）；
- F4 `cmd.history.v1`、`StatusInfo.cmdRunning`、`CmdData.history`（含 late 通道）；
- F5 §5.2 策略表与 builtin 卡片定义（写入时机、正文、failed 条件）；
- F6 `SecureGuardWiring.recheckForWrite(ctx): string | undefined`（只读查询；`lockedReason` 不变）；
- 不变：`CommandOutputWire`、`CommandArgsSchema`、捕获引擎 web 语义、bridge 返回值与 ledger 结算（含 56c71cae）、`cmd_late`/`queryOnly` 通道、三个 off golden、keepalive-legacy golden。

### 8.3 测试清单

**协议（P0）**

- 投影：合法 start/end；非法（`v:2`、坏 cmdId、坏枚举、非对象）⇒ 纯墓碑；预算再套（65 条、9 KiB 单条、40 KiB 总、未知 kind 丢弃、`truncated` 累加）；内容原样不改；`dataKey` 对完整 data；其它条目类型投影逐字节不变；hub/agent 同输出。
- `StatusInfo.cmdRunning`、`WireEntry.cmd`、`CmdData.history` 被旧 schema fixture 接受。

**agent（A1）**

- recorder（fake timers）：<400 ms ⇒ 1 条 end；>400 ms ⇒ start+end；抛错 ⇒ `failed` + 原样重抛；30 min ⇒ `timeout`；会话变化 ⇒ skip；`recheckForWrite` 有原因 ⇒ 不调 appendEntry、`skipped++`；`appendEntry` 抛错 ⇒ 吞、`failed++`；`dispose` 后不写；计时器全 `unref`。
- 输出原文落盘（含 `?token=`、`--take=` 样例原样存在）；editor 预填与 input 值不落盘。
- 策略表 §5.2 每行；`/webhub` 未知子命令 ⇒ header-only。
- 意图账本：agent_settled 推迟 <5 s（认领成功但 bridge 已答 `unknown`）与 >5 s（认领失败）两种 ⇒ 记录 cmdId=帧 id、source `web`、含完整输出 **← G7 回归钉**；同名同参多意图 ⇒ 最旧优先；跨会话不匹配、会话切换清空；TTL 过期 ⇒ 本地 id；`display` 覆写生效（以非 reload 命令验证；reload 族 skip，#42）。
- observe 契约：真实 ui 每个方法 spy，参数相同、返回同一对象、调用次数相同；无 `webInvocation`。
- 认领模式：web 窗口输出与今天相同（现有 capture 测试全绿）+ 记录 tee。
- 会话离开拦截：`newSession` 成功 ⇒ 仅 1 条 end（left-session），后续 settle no-op；`{cancelled:true}` ⇒ 第二条 end `failed`；拒绝 ⇒ 同；返回的 Promise 与原对象同一。
- **嵌套命令**：handler 内 `sendUserMessage("/另一个toolkit命令", {expandPromptTemplates:true})` ⇒ 两条独立记录，sink 互不串扰（m8①）。
- 并发交错调用 sink 隔离；recorder 未接线 ⇒ 与今天逐字节等价。
- bridge builtin：§5.2 表每行的写入时机与正文；`/model` auth 拒绝 ⇒ `failed`；`/compact` onError ⇒ `failed` 且不写 start；**bridge 返回值与 `sendLate` 调用序列与改前完全一致**（快照比对，M3）；`/new` 取消 ⇒ 两条 end；`/resume __pick` 记录写在全部检查之后（检查失败路径无记录）。
- `history` 字段：同步回复、扩展 late、builtin late 三处都有。
- status：feature 仅在接线 ∧ 已持久化时出现；`cmdRunning` 空则缺省。
- secure：`recheckForWrite` 在挂载丢失时返回原因并进入 LOCKED；未接线 guards ⇒ 视为可写。
- 永不调用 `registerEntryRenderer("subagent:cmd")`。

**hub（H1）**

- `runTail`：persisted + ENOENT ⇒ `branch_req` ⇒ 按 leaf 截断 ⇒ append；leaf 不在回复中 ⇒ 不推送、下次重试；`file===undefined` ⇒ 早退不变；超时 5 s 不挂；TOO_LARGE/PARSE/LEAF_NOT_FOUND 原逻辑。
- **56c71cae 回归钉**（m8②）：agent 对被推迟命令答 `completion:"unknown"` 且永无 `cmd_late` ⇒ hub 账本按 56c71cae 后语义结算，不被记录写入或 status 变化污染。
- caps-coexist：两面都有 `cmd.history.v1`。
- 集成（真 hub 子进程 × fake agent）：文件含记录 ⇒ history 带 `cmd`；leaf 变化 ⇒ append 带 `cmd`；首条对话前（无文件）⇒ 回落 append。

**UI（U1）**

- `cmdRecord.ts`：折叠（start+end、仅 end、仅 start、翻页、多条 end 取最后）；`resolveCmdState` 全矩阵；复制文本；行数。
- `logic-state.test.ts`：只有合法 `cmd` 的 custom 成 item；其它不变。
- `tx-entries`：位置、隐藏 end、占位、`renderKeys` 随 end / state 变化。
- 占位状态机：记录到达、`history:"none"`、`history` 缺失、失败、60 s 降级、降级后真卡到达移除提示。
- `TxCommand`：折叠、notice、无 `PREVIEW_CTX` 裸文本、路径 / URL、复制。
- DetailDock：`historyMode` 假 ⇒ 现有 `command-result`/`command-confirm` 测试全绿、DOM 不变；真 ⇒ 无 `CommandResult`、确认框不变、「需回终端」保留。
- `source-scan`：无 `v-html`；keepalive-legacy golden 不动。

**session-nav / 其它**：含 `subagent:cmd` 的会话 ⇒ resume 列表标题、子会话判定、provenance 不变；web resume `__list` 不受影响；consult fork 前缀比对不变。

**conformance（真 pi，peer bump 前必跑）** `tests/conformance/cmd-history.test.ts`：

1. `appendEntry` 的 custom 不进 `buildSessionContext`、不进 provider payload；
2. 无渲染器时 InteractiveMode 不渲染；
3. 扩展命令 streaming 中立即执行，仅 `_isEmittingAgentSettled` 时推迟，deferred actions 按序执行；
4. `sendUserMessage(text, {expandPromptTemplates:false})` 的 `/x` **不执行**扩展命令（m8③，B2 的前提钉）；
5. 无对话时 `appendEntry` 不落盘（§4.10 前提）；
6. `newSession` 返回 `{cancelled}`、成功后旧 ctx 取值抛错（§4.4 离开拦截前提）。

### 8.4 生效方式

| 改动                              | 生效                            |
| --------------------------------- | ------------------------------- |
| agent（A1，含设置与 secure 查询） | `/reload`（git 安装需 pi 重启） |
| hub（P0 投影 + H1）               | `/webhub restart`               |
| UI                                | hub 重启后浏览器刷新            |

任意先后顺序安全；三者都新且会话已持久化才进入 `historyMode`。

### 8.5 真机验收（`acceptance.md` 要点，tmux 真机）

1. TUI 执行 `/record status`：终端显示与改前截图一致；网页 ≤2 s 出现 `tui` 卡，`?token=` 链接可点开查看页。
2. 网页执行 `/fabric status`（await 型）、`/mem doctor`、`/cache-ttl status`：卡片 running→done 原地更新。
3. **G7**：额外 `-e` 加载一个探针扩展，其 `agent_settled` 处理器 `await` 8 s；发一条消息，助手回复结束、探针保持期间，从网页发 `/record status` ⇒ 探针结束后卡片出现且有完整输出（改前：legacy 卡片无输出）。再测 2 s 保持（<5 s 认领路径）。
4. 新开会话、无任何消息时网页跑命令 ⇒ 卡片实时出现（§4.10）。
5. 网页依次执行 `/session`、`/name x`、`/thinking high`、`/model <有效>`、`/model <无凭据>`（应 failed）、`/compact`、`/new`、恢复对话框切会话 ⇒ 每个一张卡、正文符合 §5.2；`/new`、`/resume` 的卡在**旧**会话末尾。（`/reload` 不应出现卡片，#42）
6. ModelSwitcher、频道对话框勾选、RenameButton 操作 ⇒ 各出卡（Q2）。
7. **日志卫生**：上述操作后 `grep` hub.log（`<stateDir>`）与 agent 侧日志，找不到任何命令输出正文（以 `/record status` 的 token 和 `/session` 的会话文件路径为探针字符串）。
8. `/webhub open`（TUI）⇒ 卡片只有头部 +「敏感命令，输出未记录」；会话文件 grep 不到 `#t=`。
9. 刷新、手机打开、pi 重启后历史仍在；`/tree`、`/fork`、`/compact` 后符合 §4.2。
10. 长输出折叠 / 展开 / 复制；路径预览；`http://127.0.0.1:…` 走代理。
11. 隐私锁锁定时命令卡不可见；secure 会话照常写；在另一终端 `pi-secure lock` 后执行 `/secure status` ⇒ 命令执行、会话进入 LOCKED、无记录写入（`/webhub status` 的 `skipped` 增加）。
12. 占位降级：让一条命令被探针推迟 >60 s ⇒ 先出现「结果暂未记录」提示，真卡到达后提示消失、卡片出现。
13. 旧标签页（不刷新）看不到新卡片且临时卡片仍工作。

---

## 9. 风险

| #   | 风险                                                                                                                                                                         | 级别         | 缓解                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| R1  | observe / 离开拦截改变了某个命令的终端行为                                                                                                                                   | 中           | §4.4 契约 + spy 全方法测试 + 真机截图；`cmdHistory:false` 一键回退 |
| R2  | v-memo 漏折叠签名                                                                                                                                                            | 中           | 专项测试                                                           |
| R3  | F1 持久化格式永久                                                                                                                                                            | 中           | P0 单独评审；`v` + 容忍未知字段                                    |
| R4  | 意图错配残留：10 min 内同会话 TUI 输入与仍被推迟的 web 调用同名同参 ⇒ 最旧优先下可能标错；`/reload` 后推迟执行的 web 调用丢失 cmdId（本地 id + mode 标源，占位按 60 s 降级） | 低           | 同会话限定 + 最旧优先 + 认领优先；接受                             |
| R5  | 会话文件增长、首屏历史被挤占                                                                                                                                                 | 低           | 预算 + 分页 + 开关                                                 |
| R6  | **原文落盘凭据**（§5.3 清单）                                                                                                                                                | 中（已接受） | Q1 拍板；Q5 只记头部；预填 / input 值不落盘；日志卫生验收          |
| R7  | 「结果未记录」短暂误判                                                                                                                                                       | 低           | 5 s 宽限 + seenRunning                                             |
| R8  | GUI 操作（切模型、改名、频道）刷卡                                                                                                                                           | 低           | Q2/Q3 已拍板接受                                                   |
| R9  | ENOENT 回落改变了 `cmdHistory=false` / 旧 agent 会话首条消息前的 idle custom 实时性                                                                                          | 低           | 改善方向；如实写入 §1.3/§4.10                                      |
| R10 | 命令长期持有代理 ctx                                                                                                                                                         | 低           | settle 后释放 buffer                                               |
| R11 | `appendEntry` 同步写：每条记录 ≤34 KiB 的 `appendFileSync`，secure FUSE 上更慢，在 handler settle 的微任务里阻塞事件循环数毫秒                                               | 低           | 单条有上限；懒 start 让多数命令只写一次；吞错计数                  |
| R12 | `/resume` 记录写入时机不当会破坏「源会话未变」检查                                                                                                                           | 中           | §5.2 明确「全部检查之后」+ 专项测试                                |

---

## 10. 已拍板项对照

| 拍板                                                     | 落点                                            |
| -------------------------------------------------------- | ----------------------------------------------- |
| 进对话流、不进上下文                                     | `pi.appendEntry` custom（§4.1）+ conformance #1 |
| 紫卡、chips、原地更新、折叠、复制                        | §4.7、§4.2                                      |
| 路径 / 本机链接走预览                                    | §4.8                                            |
| 会话文件、刷新/换设备/重启都在、32 KiB/64 条、TUI 不渲染 | §4.1、§4.3、D10                                 |
| 网页和终端都记、终端不改显示、抓不到如实标注             | §4.4、§5.1                                      |
| 去掉临时卡片，只留必要提示                               | §4.7、D4                                        |
| 延迟执行在 handler 执行时创建 / 填充                     | D7、§8.5 #3                                     |
| Q1 原文落盘                                              | D6、§5.3 残留登记                               |
| Q2 按钮触发也记                                          | §5.1、§8.5 #6                                   |
| Q3 内置命令全记                                          | §5.2 builtin 卡片定义                           |
| Q4 第三方占位卡 / 终端观测不到不记                       | §5.1、§5.2                                      |
| Q5 `/webhub` 敏感只记头部                                | §5.2、§8.5 #8                                   |

## 11. 已拍板（无待决项）

Q1–Q5 均已于 2026-10-24 由用户拍板（见文首），本版无新增需用户决策的问题。
