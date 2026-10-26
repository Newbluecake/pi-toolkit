# Deferred reload 交付报告（验收修订版）

日期：2026-10-26；分支：dev。已落实用户对 sonnet 有条件验收 major 的拍板：**fire 等本回合自然结束，不再 abort；显式 now 保留 abort+reload**。仅工作区修改，未执行 add/commit/stash/checkout 或其他 git 写操作，未修改 tests/fixtures/；任务范围外 UI 工作未触碰。

## 本轮修订与设计取舍

1. **fire 命令立即返回，不在输入/回合调用栈 await idle**。`deferFire()` 登记 controller 单槽等待：现有 `ctx.waitForIdle()` 完成后通过既有 fire 回调重发 `/agent reload fire`（followUp + expandPromptTemplates=true）。重发命令使用新 ctx 再次 countBusy；如有新的活跃 run/workflow 就重新 arm，不 reload。无子任务但模型忙的普通 `/agent reload` 同样自然等闲；仅显式 now 可强制中止。
2. **30 分钟有界等待**：使用 clampSpanMs + systemClock/unref。重复 fire 共用同一 timer，不延长 deadline；超时/失败保持 pending/派发门并 ui.notify，不 abort、不 reload，晚到的 idle 回调和随后 settle 不自动复活此等待。可用 `/agent reload` 重试、now 强制或 cancel 取消。
3. **取消与生命周期隔离**：cancel/now/session_start/session_shutdown 清 timer、作废 token；底层 Promise 无取消 API，但迟到兑现不发送 fire。未新增任何 pi.on，复用原有 reload hooks；真实 activate 的冻结表检查仍通过。
4. **续跑精确规则**：基线为 arm 时流式、自然等待期间见过流式、当前非 idle 或有 pending messages。仅 deferred 路径在证明当前 idle、无 pending、当前分支出现不同于 arm 快照的新 assistant `stopReason:"stop"`、且其后没有 user/toolResult 时抑制续跑；旧 stop、toolUse、aborted/error、缺探针/历史均不冒充正常完成。now 不做此抑制。
5. **模式边界**：明确禁用 print/json 的 `/agent reload`，即使最小宿主暴露函数也只提示、无 arm/消息/标记。RPC 的 needsContinue 自动续跑是有意行为。idle 的 nextTurn 挂起通知可能在 reload 后首回合出现一次，已写进 README。

## 宿主 API/await 证据

已读取安装的 pi 1.3 dist 实现：

- `core/extensions/runner.js` createCommandContext 的 waitForIdle 转发到宿主；TUI/RPC 均绑定到 AgentSession.waitForIdle。
- `core/agent-session.js` 的 waitForIdle 等 `_getIdleWaitPromise()`；`_emitAgentSettled()` 处理既有 hooks/延迟动作后兑现 idle wait。
- prompt 会 `await _tryExecuteExtensionCommand()`，后者 `await command.handler()`；TUI onSubmit 的流式/压缩分支还会 `await session.prompt()`。为避免长期占住输入提交栈或从结束钩子反等自身，采用非 await 的登记回调，而不是在 fire 内长期 await。
- TUI handleReloadCommand 在 streaming/compacting 时直接提示返回；fire 等 idle 后调用才能真正 reload。now 的 abort + 5 秒有界等待保持。

## 维持的 minor / 原始能力

- 首次挂起与真正取消才注入 `subagent:reload-pending`（display:true）：流式 steer，空闲 nextTurn，不唤醒。重复 arm 不重复通知，不覆盖首次流式快照。
- 两个主会话工具 execute 用注入的 isReloadPending 阻止新 Agent/resume/SubagentWorkflow，返回 isError:true / E_RELOAD_PENDING，不抛异常、不 spawn/start。嵌套、运行中 workflow 的内部 agent()、查询/steer/abort/get_run_result 不拦。
- pending 覆盖排队 fire 和自然等待窗口。忙数保留 registry 与 admission IDs 并集及活跃 workflow，避免准入可见性窗口。
- 跨 activate 继续标记仍为 Symbol.for("pi-subagent:reload-continue")，容量 1、TTL 120 秒、同 sessionId/会话文件匹配、读后即删；仅有效 reload start 发 continue 并 triggerTurn，流式 followUp，异常按对象身份回滚。
- defer=false 不改写编辑器/内置 reload；显式 /agent reload 仍有效。index 只装配，无新增 pi.on、依赖或 fixture 改动。

## 改动文件（累计 20 个，绝对路径）

- `/home/bluecake/ai/pi-toolkit/AGENTS.md`
- `/home/bluecake/ai/pi-toolkit/src/commands/status.ts`
- `/home/bluecake/ai/pi-toolkit/src/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/reload/defer.ts`
- `/home/bluecake/ai/pi-toolkit/src/reload/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/reload/admission.ts`
- `/home/bluecake/ai/pi-toolkit/src/reload/command-port.ts`
- `/home/bluecake/ai/pi-toolkit/src/reload/continue.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/agent-tool.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/workflow-tool.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/defer.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/status-reload.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/wiring.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/activation.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/admission.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/command-port.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/continue.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reload/fire-idle.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/deferred-reload/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/deferred-reload/report.md`

本轮修改域为 reload 生命周期源码、status 的 fire 分流、reload 下对应测试及上述两份文档；`fire-idle.test.ts` 是本轮新建。`src/reload/editor.ts` 仅读取，未修改；AGENTS.md 累计仅替换 src/reload/ 的一行 README 列。工具准入/index 装配维持上轮实现。

## 最终自验与输出尾部

所有以下最终命令退出码为 0；跳过项沿用原有环境门，未修改测试或 fixture 来消除跳过。

### `npm run typecheck`（两段 TypeScript + vue-tsc）

```text
> pi-toolkit@0.9.0 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### `npm run build`

```text
> pi-toolkit@0.9.0 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json
```

### `npx vitest run tests/reload --maxWorkers=4`：9 文件、130 项通过

```text

 Test Files  9 passed (9)
      Tests  130 passed (130)
   Start at  11:41:42
   Duration  6.15s (transform 3.87s, setup 269ms, collect 9.13s, tests 160ms, environment 2ms, prepare 470ms)
```

### `npx vitest run tests/reload tests/commands tests/tools tests/service tests/integration --maxWorkers=4`：222 文件通过、2231 通过 / 2 跳过

```text

 Test Files  222 passed (222)
      Tests  2231 passed | 2 skipped (2233)
   Start at  11:42:03
   Duration  363.27s (transform 10.06s, setup 2.72s, collect 127.87s, tests 1215.91s, environment 39ms, prepare 12.02s)
```

### `npm run test:conformance`（PI_TOOLKIT_TEST_WORKERS=2）：33 文件通过、341 通过 / 16 跳过

```text

 Test Files  33 passed (33)
      Tests  341 passed | 16 skipped (357)
   Start at  11:42:03
   Duration  310.21s (transform 6.51s, setup 443ms, collect 26.35s, tests 573.84s, environment 6ms, prepare 1.76s)
```

### 精确文件 prettier 与只读 diff 检查

```sh
npx prettier --check AGENTS.md src/commands/status.ts src/index.ts src/reload/defer.ts src/reload/index.ts src/reload/admission.ts src/reload/command-port.ts src/reload/continue.ts src/tools/agent-tool.ts src/tools/workflow-tool.ts tests/reload/defer.test.ts tests/reload/status-reload.test.ts tests/reload/wiring.test.ts tests/reload/activation.test.ts tests/reload/admission.test.ts tests/reload/command-port.test.ts tests/reload/continue.test.ts tests/reload/fire-idle.test.ts docs/dev/deferred-reload/README.md docs/dev/deferred-reload/report.md
git diff --check
git diff --quiet HEAD -- tests/fixtures/
```

结果均为退出码 0；Prettier 输出尾部：

```text
Checking formatting...
All matched files use Prettier code style!
```

fixture 相对 HEAD 保持 byte-identical；AGENTS.md diff 为一行替换。冻结表完整 handlerCounts 与工具/命令表由 tests/reload/activation.test.ts 只读核对；完整 integration 中的 off golden 也通过。

## 残留风险与验收边界

- 定时任务后台 run 本次不拦；/task、RPC、goal/tidy 等非两个主会话工具入口也不扩大拦截。它们可能延后 reload，空闲后 fire 仍会重数忙数。
- 继续标记仅同进程、120 秒有效；退出、超时、会话身份变化会丢弃。
- print/json 模式不支持此 reload；RPC 自动续跑为有意行为；nextTurn 挂起通知可能在 reload 后首回合出现一次。
- waitForIdle 底层 Promise 无取消 API；清 token/timer 后旧回调不会产生动作，但失效轻量回调可能保留到宿主 idle/释放。缺 waitForIdle 的最小宿主只提示并保持挂起，不回退 fire abort。
- 本轮自验由当前会话完成，没有独立 verifier 工具可调用；不宣称已完成二次 sonnet 复验或新增实机 TUI E2E。行为测试真实断言 Promise 未兑现时命令已返回、abort 未调用、重发 fire 后才 reload、30 分钟边界及 timer unref，不用恒真 stub。
- 相关流程、不变式、API 调用链和精确续跑规则以 README 为准。

## 建议 commit message（仅建议，未提交）

```text
feat(reload): wait for natural turn completion before deferred reload

reload 挂起期间暂停新的 Agent、resume 和 workflow 派发；延迟执行时等待模型自然完成当前回合，不再自动中止。

显式 reload now 仍可强制执行，cancel 可随时撤销；仅有未完成工作时在 reload 后自动继续。
```
