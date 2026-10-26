# ⑤ index.ts 抽子 wire · 实施报告

基线：`69d2c6f2`（dev，④ 已合入）。分支 `gov/step5`，8 个提交，未 push。

## 提交

| 步骤 | hash     | 标题                                                                                   |
| ---- | -------- | -------------------------------------------------------------------------------------- |
| 5-0  | c7f64159 | test(governance): pin activate() call traces as a registration-order golden            |
| 5-0b | 35b0d807 | refactor(index): drop imports left behind by the stack extraction                      |
| 5-1  | f37dff17 | refactor(index): move holder forwarders to src/holder.ts                               |
| 5-2  | b60c2c4f | refactor(index): register the subagent core tools from tools/register.ts               |
| 5-3  | fc01617a | refactor(bash): register the bash tools from bash/host.ts                              |
| 5-4  | ba993743 | refactor(compact-hint): register compact hooks and tools from compact-hint/register.ts |
| 5-5  | 8a910a87 | refactor(fabric): wire cross-session activation from fabric/xs/activate.ts             |
| 5-6  | a5956671 | refactor(mention): wire mentions from mention/wire.ts                                  |

5-7 按拍板取消。

## 激活调用轨迹 golden（B 档契约）

- 文件：`tests/fixtures/governance/activate-trace.json`；测试 `tests/governance/activate-trace.test.ts`；画像 `tests/governance/trace-profiles.ts`。
- 记录器：`tests/secure/activation-trace.ts` 挪到 `tests/helpers/activation-trace.ts`（secure 测试只改导入），新增 `omit`（被 omit 的属性在 Proxy 上读出 `undefined`）和 `onHandler`（捕获 `pi.on` 的 handler，用于阶段 2 重放）；`describe` 对带 `customType` 的参数输出 `name(customType)`（secure golden 只比较场景之间是否一致，不受影响）。
- 5 个画像（阶段 1 调用数 / 阶段 2 调用数）：default 182/31、minimal 112/27、max 232/33、child 32/0、compat-failure 50/0（`omit:["appendEntry"]`，钉住早退桩 `Agent (unavailable)`，只跑阶段 1）。`count`/`phase2Count` 写进 golden 并单独断言。
- 阶段 2：`session_start(startup) → session_shutdown(new) → session_start(new) → session_shutdown(quit)`，记录 `sendMessage / appendEntry / ui.setStatus / ui.setWidget / ui.notify / ui.addAutocompleteProvider`（ctx 用 `hasUI:true`，autocomplete 也在轨迹里）。
- `max` 不含 feishuNotify / feishuBot / traffic / externalAgents.droid（需要凭据、数据库或 droid 二进制）。真实 socket / 子进程由 `tests/setup/sandbox-home.ts` 的守卫兜底，测试没有触发。
- 额外测试：同一画像连续录制两次结果相同（防抖动）；本地连跑 4 次稳定。
- 更新规则（B 档）：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`，仅在有意改注册时刷新。已同步 AGENTS.md「Frozen artifacts」B 行；`tests/docs` 通过。
- ⑤ 的所有重构提交都没有刷新它（5-0 之后 golden 零 diff）。

## 移动清单

- 5-0b：删除 17 个死导入（14 个值导入 + 3 个类型导入），`tsc --noUnusedLocals` 对 index.ts 归零。`entry-loader`、`traffic-lifecycle-process` 通过。
- 5-1 `src/holder.ts`：`StackHolder`、`requireStack`、`mapTidySpawnRequest`（私有）、`forwardSpawn/ResolveRun/Query/Workflow/WorkflowQuery/BashJobs/Orphans/Notifier`；新增 `createTidyPort(holder)`（原 `attachTidy({…})` 字面量逐字搬入）。wc14 `productionGlobs` 追加 5 个新路径（只增不减）。`memory/contracts.ts` 两处注释指向更新。原来挂在 `mentionAutocompleteEntries` 前面那段「Each session_start rebuilds…」注释并入 holder.ts 头注释。
- 5-2 `src/tools/register.ts`：`registerSubagentTools`（`resolveMarkdownTheme` + Agent、get_run_result、legacy renderer、list_subagents、steer、set_model、abort、extend）。
- 5-3 `src/bash/host.ts`：`registerBashTools`（调用点仍有 `bashJobsEnabled(settings)` 门控）、`killBashJobsBounded`（→导出）。
- 5-4 `src/compact-hint/register.ts`：`registerCompactHooks`（turn_end/tool_call/session_compact/model_select）、`registerCompactTools`（switch_context + before_compact + compact_failed + shutdown C3 + compact_context + set_compact_threshold）。两个调用点留在原位置。
- 5-5 `src/fabric/xs/activate.ts`：`createXsActivation`——xs 门控与全部状态（`xsAttached`、inbox 三变量、`xsSessionId`、`xsCollisions`、`xsHubLimits`、`xsSender` 等 `let` 都在闭包内）；`registerTriggerGuard`（a）、`registerFenceHooks`（b）、`registerSurface`（c）在原位置调用；`beginSessionStart / defensiveTeardown / stackInput / attach / webHubDeps` 替换 session_start 与 web-hub deps 里的 xs 片段。`rg xsAttached|xsEnabled|xsLedger|replyEnabled src/index.ts` 无代码命中（只剩一条注释）。
- 5-6 `src/mention/wire.ts`：`createMentionWiring`（`sessionParseDeps`、`sessionNoticeMessage`、`mentionSessions`、`routeDeps`、`install`、`attachAutocomplete`）、`mentionAutocompleteEntries`、`mapMentionSendOutcome`。`src/index.ts` 保留 `export { mentionAutocompleteEntries } from "./mention/wire.js"`。

没有垫片；除上面这条公开导出外没有 re-export。

## 证明

- 轨迹 golden：每个提交都比对，全绿、零更新。
- 声明比对（文本 + 绑定，复用 ④ 的脚本，改成以 `src/index.ts` 为基线；`/tmp/sg5-decl-check.mjs`，跑完已从 worktree 删除）：`--step all`：

```
requireStack | src/index.ts | src/holder.ts | whitelisted holder type | 2 identical / 0 diff
mapTidySpawnRequest | … | identical | 28 identical / 0 diff
forwardSpawn | … | whitelisted holder type | 40 identical / 0 diff
forwardResolveRun | … | 4 / forwardQuery | 25 / forwardWorkflow | 8 / forwardWorkflowQuery | 33
forwardBashJobs | 2 / forwardOrphans | 25 / forwardNotifier | 34  （均为 identical / 0 diff）
killBashJobsBounded | src/index.ts | src/bash/host.ts | identical | 23 identical / 0 diff
mentionAutocompleteEntries | src/index.ts | src/mention/wire.ts | whitelisted holder type | 16 identical / 0 diff
mapMentionSendOutcome | … | identical | 32 identical / 0 diff
I5 unref occurrences: 5 -> 5   （index.ts + 6 个新/改文件合计，基线对比）
```

holder 窄类型只允许 `{ current?: Stack }` → `StackHolder` 这一处签名差异；比对时两边都去掉 `current` 属性（旧版里它声明在被忽略的内联类型内部）。`mentionAutocompleteEntries` 比对时剔除了上面说的那段被并入 holder.ts 的游离注释。

- 函数体抽取（5-2、5-4、5-5、5-6 的注册段）不是声明，靠轨迹 golden + A 档 golden + 源码钉证明。
- 每步：`npm run typecheck`、`tsc --noUnusedLocals`（index.ts 与 6 个新文件 0 条）、prettier、`/tmp/sg5-quick.sh`（轨迹、schedule-off、fabric-xs-off/reply-off/wake-off、merged-plugins-wiring、entry-loader、mention-autocomplete-wiring、fabric-xs-activation、secure off-golden、measure-command 源码钉、input-order、reload、wc14、docs、boundary、compact-hint；417 条）、`git diff --quiet 69d2c6f2 -- tests/fixtures/ ':!tests/fixtures/governance'` 均通过。5-3/5-4/5-5 另跑了 `tests/bash`、`tests/context-switch` + compact-dynamic-off-golden、fabric-xs 全部集成、`tests/web-hub/agent`、conformance fabric-xs/fabric-wake。
- 收口：`npm run test:conformance` 33 文件 / 341 通过（16 跳过）；`npm run format:check` 通过；`/tmp/sg5-verify.sh`（governance + 整个 tests/integration + secure off-golden + 源码钉 + reload + wc14 + docs + bash + compact-hint + boundary）结果：176 文件里 175 通过；唯一失败是 `tests/integration/fabric-xs-inbox.test.ts` 的真实 socket harness 启动超时（`timeout: …`，`XsHarness.boot`，与 3 worker 并发负载有关），单跑连续 2 次 6/6 通过，已判定为负载型抖动；fixtures 零 diff。

## 体量

`activate()`：1751 行（166–1916）→ 1033 行（121–1153，index.ts 文件尾）。`src/index.ts` 总行数 2123 → 1153。

## 偏差

1. 方案 5-0 是「删死导入」，因为这个 worktree 没有 4-0，用户拍板把轨迹守卫放到 5-0，所以死导入成了 5-0b。
2. `XsActivation.beginSessionStart` 返回 `nextXsSessionId`，`defensiveTeardown` 和 `attach` 把它作为参数接收（方案接口是 void / 无参）。原代码里它是 session_start handler 的局部常量，保存在 activation 状态里会改变两次重叠 session_start 的语义。
3. `MentionWiringDeps` 去掉了 `pi`（`install(pi)` 已经接收；其余用不到）。`sessionNoticeMessage` 返回类型的 `display` 声明为 `boolean`（原推断类型）。
4. `notifyCapabilityCtx` 的声明提前到 xs activation 之前（纯对象，注释留在 `onDisabled` 处）；`webHubRef`、`xsFencePorts` 也在同一位置声明。`scheduleMessage` 通过晚绑定闭包 `() => scheduleMessage` 传入。
5. `wakeAttributeRef` 没有提前声明（它只被延迟执行的闭包引用，mention wire 不用它），位置不变。
6. `registerSubagentTools` 的 `caps` 收窄为 `Pick<PiCapabilities, "canSetModel">`。
7. 没有跑全量 `npm test`（任务要求）。
