# Deferred reload · 开发者要点

> 何时读：改动 `src/reload/**`、`/agent reload`、主会话 Agent / SubagentWorkflow 的 reload 准入前。

## 不变式

- **I1 / I2**：不改 run/workflow 的 deadline、reaper 或结果持久化；`src/index.ts` 只装配 controller 引用、命令端口与工具依赖，业务逻辑留在 `reload/`。**fire 永不 abort 模型回合**，自然等待有 30 分钟上界；只有显式 now 保留强制中止。
- **I3 / I6**：reload 接线及准入依赖只在 HOST_KEY 之后创建。子会话不消费主会话继续标记，嵌套 Agent 保持原有行为。
- **I4**：controller/命令端口/等待 token 均为每次 activate 的实例或闭包状态。唯一跨 activate 状态是 `Symbol.for("pi-subagent:reload-continue")` 全局槽，**容量 1、TTL 120 秒**；同时匹配 sessionId 与会话文件（文件可 undefined）。任何主会话 session_start 都读后即删，过期、不匹配、非 reload、无身份均不继续。无磁盘标记。
- **I5**：所有等待计时器通过 `clampSpanMs` / `systemClock`（分段时钟，每个底层 timer 都 unref）；成功、取消、now、session_start/session_shutdown 清除自然等待 timer，并以 token 身份使旧 Promise 回调失效。标记 TTL 惰性校验，不用常驻清理 timer。
- **I7 / I9 / I10**：保留旧运行时命名；不改 wire 协议或 fixture。`reload.defer=false` 时编辑器不改写，内置 `/reload` 不经本流程；显式 `/agent reload` 不受 defer 设置限制。无有效继续标记不发继续消息。
- **I8 / I11 / I12**：不向 pi-free 模块引入 pi，不变更 secure 强制关闭项，工具机械准入逻辑不写进 skill。
- **钩子数不变**：复用 reload 原有 session_start/session_shutdown；等待通过现有 `ctx.waitForIdle()` 的完成回调重发 fire，**不新增 pi.on**、不轮询，维持 schedule-off 等冻结 golden 的 handlerCounts。

## 流程

1. TUI 精确 `/reload`（仅忽略首尾空白）经 editor wrapper 改写为 `/agent reload`；其他输入原样交给原编辑器。wrapper 在 session-nav 之后安装。
2. 命令重数 registry 非终态 runs、SpawnService admission-time IDs 的并集，加上活跃后台 workflows。后台 bash 不算忙。print/json 或缺 reload API 时仅提示，不 arm、不注入模型消息、不写标记。
3. 忙时首次 arm 保存首次流式快照及当前分支末条 assistant entry ID，发 `subagent:reload-pending`（display:true）中文消息：暂停新 Agent / SubagentWorkflow 派发，仍可收结果、使用 bash。流式 steer，空闲 nextTurn，不唤醒。重复 arm 仅刷新数量，不重复通知、不覆盖首次快照。无子任务但模型忙时，直接请求也 arm(0)，走同一自然等待流程。
4. 两个主会话工具 execute 在参数准备/预算读取/spawn 前检查注入的 `isReloadPending()`。拒绝返回 `isError:true`，details.error 携带 `E_RELOAD_PENDING` / config / retryable，正文提示等继续通知或请用户 `/agent reload cancel`。Agent resume 同样受限。共享 SpawnService、嵌套 Agent、已运行 workflow 的内部 agent()、查询/steer/abort/get_run_result 不经过此门。
5. completed/failed/workflow:settled 总线事件重数忙数，归零只排队一次带 `deliverAs:"followUp", expandPromptTemplates:true` 的 `/agent reload fire`。**pending 保持 true**，覆盖排队及自然等闲窗口。fire 到达时若 `!ctx.isIdle()`，登记最长 30 分钟的自然等待后**立即从命令返回**，不 await、不 abort。重复 fire 共用同一个等待，不重置其 deadline。
6. `waitForIdle()` 完成且再次确认 idle 后，清 timer，重发 fire；新命令使用新 ctx **重新 countBusy**。发现新的活跃 run/workflow 就重新 arm，等待其 settle；仍为空且 idle 才 reload。等闲期间见过流式会记录为未完成工作证据。
7. 自然等待超过 30 分钟，或等待失败/错误地提前返回：ui.notify 告知用户，保持挂起和派发门，**不自动 abort/reload**。晚到的 idle 回调失效；之后的 settle 也不会自动重启超时等待。用户可 `/agent reload` 重试、now 强制或 cancel 取消。
8. cancel 仅在确实挂起时清状态、timer/token 并注入取消消息（当前流式 steer，否则 nextTurn；不唤醒）。已排队 fire 在 pending=false 时不做事。session_start（含换会话）及 shutdown 同样使旧等待失效。
9. **now 独立强制路径**：先使自然等待失效，保存未完成状态；TUI 非 idle 且 abort/waitForIdle 可用时 abort，有界等待 idle（5 秒），然后 reload。失败/超时/等待中取消不写标记、不 reload，保留原有错误提示。now 不发挂起/取消消息，不采用正常结束的续跑抑制规则；RPC 保持自身 reload API 行为。
10. 真正 reload 前按下节计算 needsContinue。需要时写全局标记后调用 ctx.reload；异常按对象身份回滚，避免误删更新标记。新 activate 的已有 session_start 仅在 reason=reload 且标记有效时发 `subagent:reload-continue`（display:true），提示继续未完成任务、用 get_run_result 收未处理结果，`triggerTurn:true`；若当时仍流式，指定 followUp。

## needsContinue 的精确规则

- 基线：`interruptedAtArm || waitedWhileStreaming || !ctx.isIdle() || ctx.hasPendingMessages()`。缺探针/历史 API 时只使用可用证据，不推断正常结束。
- **仅 deferred/fire 路径**允许抑制续跑，且必须同时满足：
  1. 当前 idle；
  2. 当前无 pending messages；
  3. 可读取当前分支，发现一条**不同于首次 arm 快照**的 assistant 消息，`stopReason === "stop"`；
  4. 此 assistant 后没有新的 user/toolResult 消息（元数据和 custom 通知不视为新任务）。
- 这证明模型自然完成了本轮工作，不因曾在 arm/等待时流式而无意义地再唤醒。前一轮遗留的旧 stop、不完整 toolUse、aborted/error/缺 stopReason、后续 user/toolResult、无法读历史均不构成证明；基线为 true 时仍继续。
- 正常完成但 pending messages=true 仍继续，以便处理队列；now 永远使用基线，不把被强制中止的回合当正常完成。

## pi API 与 await 调用链核对

以本仓库安装的 pi 1.3 `node_modules/@earendil-works/pi-coding-agent/dist/` 为证据：

- `core/extensions/types.d.ts`：ExtensionContext 有 isIdle/hasPendingMessages，ExtensionCommandContext 有 waitForIdle/reload；sessionManager 可读 getSessionId/getSessionFile/getBranch。SessionStartEvent.reason 包含 `reload`；`core/agent-session.js` 的 reload 实现确实发出该 reason。
- `core/extensions/runner.js` 的 createCommandContext.waitForIdle 转发宿主动作；TUI/RPC 宿主转发到 AgentSession.waitForIdle。该方法在非 idle 时等待 `_getIdleWaitPromise()`，由 `_emitAgentSettled()` 完成已有 settled hooks/延迟动作后 `_resolveIdleWaitIfIdle()` 兑现，不需要新增事件处理器。
- `core/agent-session.js` 的 prompt 在处理普通输入前 `await _tryExecuteExtensionCommand()`，后者 `await command.handler()`；`modes/interactive/interactive-mode.js` 的 onSubmit 流式/压缩分支又会 `await session.prompt()`。在命令内长期 await 会延长输入提交调用栈；若从结束钩子的同步派发链进入，还可能反向等自己的结束。因此选择**登记 Promise 回调、命令立即返回**，兑现后用 pi 已有 sendUserMessage 重发 fire，而不是在输入/结束钩子内 await 自然结束。
- `modes/interactive/interactive-mode.js` 的 handleReloadCommand 在 streaming/compacting 时只提示返回，所以 deferred 必须等 idle；now 的 abort+5 秒有界等待保留。
- sendMessage 支持 steer/followUp/nextTurn 与 triggerTurn；pi-agent-core 的 AgentToolResult 支持直接 `isError:true`，无需抛异常。sendUserMessage 的 expandPromptTemplates=true 是扩展命令派发的必要开关。
- 安装版 print 模式虽暴露 reload 函数，本扩展显式不支持 print/json 下的 /agent reload；TUI/RPC 才是支持路径。缺 waitForIdle 的最小宿主会提示并保持挂起，不退回 fire abort。

## 残留风险 / 范围

- **定时任务的后台 run 本次不拦**；它们仍能在 pending 时进入 SpawnService，可能延后 reload。fire 的 admission-ID 并集重数仍防止打断刚准入的 run。
- `/task`、RPC、goal/tidy 等非上述两个主会话工具入口也未加门，避免在共享服务层破坏内部 workflow/nested dispatch。
- **继续标记仅同进程有效**；退出/重启、reload 超过 120 秒、加载失败或不同会话会丢弃，不承诺跨进程恢复。容量一不是跨会话队列。
- **print 模式无法通过此功能 reload**（json 同样禁用）。**RPC 模式 reload 后会按 needsContinue 自动续跑，这是有意行为**；正常 stop 且无队列时仍按上述规则不唤醒。
- **idle 时 nextTurn 的挂起消息可能在 reload 后首回合出现一次**。它不立即唤醒，其是否计入 pending 队列依宿主实现；不改写已进入宿主队列的消息。
- waitForIdle 的底层 Promise 无取消 API；本地 token/timer 会及时失效，旧 Promise 将来兑现不会 reload/通知。反复人工重试可在宿主保留失效 Promise 的轻量回调，直到自然 idle 或宿主释放它。
- 命令重投递或 reload 本身失败，用户可 now/cancel 恢复；不引入轮询。30 分钟自然等待超时后不会自动 abort。
- 内置 `/reload`（defer off）不主动建立继续标记；只有显式 `/agent reload` / now / fire 经此生命周期。
- bash job 同会话接管由 `src/bash/` 负责，本次不更改其生命周期。

## 验证

`tests/reload/` 覆盖消息、准入、一次性标记、自然结束证明与 force/deferred 分离；fire 测试真实断言命令在 idle Promise 未兑现时返回、没有 abort、兑现后重投递并重数 busy、cancel/now/30 分钟 timeout 与 late callback，以及 timer unref/生命周期清理。装配测试只读 schedule-off fixture 验证完整 handlerCounts。另跑 commands/tools/service/integration、conformance，冻结物以 `git diff --quiet HEAD -- tests/fixtures/` 校验；输出和建议提交说明见 [report.md](./report.md)。
