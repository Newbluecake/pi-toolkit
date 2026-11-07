# 实施报告：带 schema 的 pi 子 agent 自动补交一轮 StructuredOutput（方案 r2 + 复审裁定）

> 对应方案：`docs/dev/subagent-core/structured-output-repair-plan.md`（修订版 r2 + 文末「复审 r2 主会话裁定」）。
> 实施分支：`dev`（未 commit —— 提交由主会话按 §3.7 拆分执行）。
> 日期：2026-11-02。

## 改动文件清单

| 文件                                                                  | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/structured-repair.ts`（新）                                 | pi-free 纯函数：`STRUCTURED_REPAIR_PROMPT`、`StructuredRepairLimits`/默认值、`phaseDueAt`（run+watchdog budget 取较早子阶段 due，仅 OVERTIME_PHASES）、`structuredRepairWindow`（资格+窗口，≥15s/120s/5s tail，NaN→skipped_budget）、`structuredRepairCloseAt`（动态收口点 = min(窗口, 有效截止−tail, 子阶段 due−tail)）、`structuredRepairSuffix`                                                                                                                                                               |
| `src/core/json-schema.ts`                                             | `applyStructuredOutputPolicy` 追加可选第 5 参 `repair?: StructuredRepairNote`；仅 `captured === undefined` 分支的消息追加 `structuredRepairSuffix(repair)`；值导入 `structuredRepairSuffix`（评审 #7）                                                                                                                                                                                                                                                                                                           |
| `src/core/types.ts`                                                   | `RunDiagnostics.structuredRepair?: "succeeded" \| "failed"`（append-only，I10；注释写明只存 store、只在补交真正发生时出现，R8）                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/runtime/watchdog.ts`                                             | `Watchdog` 接口追加可选只读 `budget?: DeadlineBudget`；`EventWatchdog` 暴露 `get budget()`；tick 逻辑不变                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/runtime/runner.ts`                                               | `ResolvedSpawnRequest.structuredRepair?: StructuredRepairSpec`（runtime-only，非 SpawnRequest 字段，Gate A/B/C 不动）；bind 监听器末尾追加 `repairCtl.onEvent`（终态守卫）；原结算 IIFE 逐字抽成 `selfcheckErrorFor(turnErr)` + `settleErrorFor(p)`；结算段按 §2.5.5（同步 plan → 可选 await 补交 → 同步 closeCapture + 取消重查 + repairRan 门控自检重查）；新增 `planStructuredRepair`（同步资格判定，§1h 顺序）与 `runStructuredRepair`（同 handle 一次补交、动态收口、Clock 端口计时器、取消边界同步关捕获） |
| `src/service/runtime-adapter.ts`                                      | `RuntimeAdapterDeps.structuredRepair?: false \| Partial<StructuredRepairLimits>` 测试缝（stack.ts 不传 ⇒ 默认开启，定案 1）；`captureOpen` + onSubmit 关窗拒绝（错误串逐字按 §1f）；组装 `structuredRepair` spec 并 thread 进 req；pi 路径 policy 传 `repairNote`；`repairNote === "attempted"` 时把 `structuredRepair: succeeded/failed` 写进 `outcome.diag` 并在 post-policy `store.put` 同步带上 `snapshot.diag` 与 `outcome`；外部分支不动                                                                   |
| `tests/core/structured-repair.test.ts`（新）                          | §3.1 全部用例（phaseDueAt 跨预算取较早/各相位/非 OVERTIME；window 的 grace/19s/850s/890s/20s idle/不受限/NaN；closeAt 三取小；提示词 ASCII/无内部词汇；suffix 映射；默认值）                                                                                                                                                                                                                                                                                                                                     |
| `tests/core/json-schema.test.ts`                                      | 不传第 5 参逐字不变；attempted/skipped_budget 后缀；已捕获分支（成功/再校验失败）不受影响                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/service/runtime-adapter-structured-repair.test.ts`（新）       | §3.2 全部 23+1 用例（#1–#23 + #17e），harness：FakeClock + 真实晚绑定 `EventWatchdog`（`budget: DEFAULT_BUDGET`，getState/dispatch 接 adapter，同 stack.ts 接法）+ fake handle（`getActiveTools` 含 StructuredOutput）                                                                                                                                                                                                                                                                                           |
| `tests/workflow/spawner-adapter.test.ts`                              | 补：`createWorkflowChildSpawner` 发出的 SpawnRequest 不含 `schema`/`schemaPreset`/`inheritSchema` 键                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/workflow/agent-opts.test.ts`                                   | 补：`agent({ schema })` 被拒且 hint 逐字为「structured output is not supported here — …」                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/workflow/structured-repair-not-applied.test.ts`（新）          | 真实 SpawnService + adapter；child handle 刻意含 StructuredOutput 且不提交 → prompt 恰好 1 次、终态 lifecycle 1 次、journal 记录 1 条                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/integration/structured-repair-real-session.test.ts`（新）      | §3.4 A–D：真实 `createAgentSession`（driver.create 用 `spec.customTools`/`spec.tools` 建会话）+ 真实 `PiSessionDriver.bind` + 真实 `wireChildSession`（cacheTtl.keepalive/childKeepalive、compact.childSessions 开启）+ `childSwitchContextGrant: () => true`                                                                                                                                                                                                                                                    |
| `tests/tools/model-facing-strings.test.ts`                            | §3.5「可加一条」：REPAIR_PROMPT 纯 ASCII、无内部词汇（`/[§]                                                                                                                                                                                                                                                                                                                                                                                                                                                      | architecture | watchdog | reducer | adapter | runner/`） |
| `docs/dev/subagent-core/README.md`                                    | `## src/runtime/` 下新增 **Structured-output repair turn** 一段：位置、资格、时钟语义、结算优先级、捕获窗口四关闭点、不收窄工具理由、§1g 子会话消费者表（keepalive 首轮 settled 后永久 disposed）、capWatcher 照常计入、diag 只存 store                                                                                                                                                                                                                                                                          |
| `docs/dev/subagent-core/structured-output-repair-report.md`（本文件） | 实施报告                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 与方案的偏离（及理由）

1. **§3.2 #1 的 journal 断言**：run journal 按设计只写非终态 `session_created`（+ shutdown_flush），不存在「终态 journal 记录」。「各 1 次」的实质（无重复结算/投递）由 enqueue(hold)=1、finalize=1、终态 lifecycle=1 钉住；journal 记录数在 workflow 测试（sessionFile 存在 ⇒ session_created 1 条）断言。
2. **§3.2 #17(d)「收口后、policy 前提交」**：从 run promise 链外侧无法确定性地插进 closeCapture 与 adapter policy 之间的单个微任务位；实现为同一 tick 内「收口后、结算前」的提交并断言 run 结局 failed(schema)（(c) 已单独断言工具结果 ok:false）。
3. **§3.2 #19 的 beforeReap late-sink 部分**：方案标注「（若设了 beforeReap）」为条件项；本实现断言 dispose 期间补交照常完成、policy/store 写回正常（D13 late-sink 本身是既有逻辑，未动）。
4. **§3.2 #10/#18 的「requestAbort 1 次」**：reaper L2 在 run 结算后也会调 requestAbort，故计数口径为「repair prompt 挂起期间的 requestAbort」= 1（测试内有注释说明）。
5. **§3.3「replay 读回 summary 只有 1 条」**：a2 式 harness 没有工作流 journal replay 消费者；以「该 child 的 journal 记录恰好 1 条 + store 终态 outcome 1 份」等价钉住「没有补交引发的第二条记录」。
6. **`runStructuredRepair` 显式增加 `spec` 形参**（方案伪代码从 `req` 隐式取）：机械性签名差异，语义一致。
7. **`structuredRepairWindow` 增加防御分支**：`clampSpanMs(min(maxMs, available)) === undefined ⇒ skipped_budget`（I1：任何计算出的 deadline 必经 clampSpanMs；畸形 limits 不产出 NaN dueAt）。
8. **#4 首轮超时用例的 budget 追加 `extendStepMs: 0`**：默认 extendStepMs 会把硬顶抬到 T+3×1h，宽限窗在测试时限内杀不掉 run（与 child-switch-runner T-S8 同一注记）；非行为差异。

其余全部按方案落地：不加 settings 开关（§5.1）、不收窄工具（§5.2）、不重置子阶段时钟、不派发 `phase_entered`、状态机与 wire/journal 白名单零改动、reducer 矩阵/property 测试零改动、工具描述与 `src/memory/tidy/prompt.ts` 零改动。

## 自验命令与结果

```text
$ timeout 600 npx vitest run tests/core/structured-repair.test.ts tests/core/json-schema.test.ts \
    tests/service/runtime-adapter-structured-repair.test.ts tests/integration/structured-repair-real-session.test.ts \
    tests/workflow/structured-repair-not-applied.test.ts tests/workflow/spawner-adapter.test.ts tests/workflow/agent-opts.test.ts
 Test Files  7 passed (7)
      Tests  118 passed (118)

$ timeout 900 npx vitest run tests/core tests/runtime tests/service tests/memory tests/goal tests/workflow \
    tests/tools tests/boundary tests/governance tests/integration/child-switch-runner.test.ts \
    tests/integration/readonly-domain-shadow-real-session.test.ts tests/integration/timeout-grace-wiring.test.ts
 Test Files  240 passed (240)
      Tests  4478 passed (4478)

$ timeout 600 npm run typecheck     # 三个 tsc/vue-tsc 全过（无输出即通过）
$ timeout 300 npm run format        # 已跑
$ timeout 300 npm run format:check
All matched files use Prettier code style!

$ git diff --quiet origin/dev -- tests/fixtures/
# 非 0：origin/dev 落后本地 1 个提交（fe615cf9，B 级 activate-trace.json 的已提交差异），非本次改动
$ git diff --quiet HEAD -- tests/fixtures/ && echo FIXTURES-CLEAN-VS-HEAD
FIXTURES-CLEAN-VS-HEAD

$ git diff --quiet origin/dev -- src/memory/tidy/prompt.ts src/tools/agent-tool.ts src/tools/structured-output-tool.ts \
    src/core/state-machine.ts src/service/request-threading.ts && echo FROZEN-SURFACES-UNCHANGED
FROZEN-SURFACES-UNCHANGED
```

未跑全量 `npm test`（按任务约定由主会话执行；上方第二条命令已覆盖方案 §3.6 列出的全部目录 + 三个回归集成文件）。

## 遗留项

- 无阻塧行为遗留。方案 §4 的 R1–R9 全部按其处置落地（R1/R2/R4/R5：三重上限 + tailMs + watchdog 兜底；R3：capWatcher 计入，README 已写；R6/R7：README 已写、§3.4-A 验收；R8：diag 只存 store；R9：#7 用例钉住）。
- 建议主会话提交时按 §3.7 的 5 个 Conventional Commits 拆分（core → runtime+service+§3.2 测试 → workflow 测试 → 集成测试 → docs；本报告文件可并入 docs 提交或单独 `docs(subagent-core): structured-output repair implementation report`）。
