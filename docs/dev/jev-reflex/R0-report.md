# R0 报告 · 契约冻结 + 关着的骨架

日期 2026-11-05 · 分支 dev · 未提交任何 git 写操作（工作区改动待 root 验收提交）。

## 1. off golden 捕获证据（plan 步骤 1，PD8）

捕获时（任何 `src/` / 热点面改动之前）：

```
HEAD=1e69e50a
?? tests/fixtures/reflex-off-golden.json
?? tests/integration/reflex-off-golden.test.ts
```

- `git status --short` 捕获前为空（root 前置核实），捕获时只有该测试文件及其产物。
- 生成命令：`PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE=1 npx vitest run tests/integration/reflex-off-golden.test.ts`（文件已存在拒绝覆盖）。
- **诚实记录**：第一次捕获的 `secure` 场景因 `makeFakeVault()` 默认设置里没写 `secure.vaults`，实际落在 plain 域（与 default 字节相同）。发现后在**仍未改任何 `src/`** 时修正测试（vault 设置补 `secure.vaults`，并断言 `domain.kind === "secure"`），删除自己刚生成的未提交 fixture 并重新捕获。最终 golden：default / explicit-off 工具 12、命令 6、input handler 4；secure 多 `/secure` 命令、input handler 5；child 工具 3、命令 0、无 input handler；四场景 `reflexEntryCount=0`、`sendMessage=0`。
- fixture 经 prettier 格式化（语义不变）；sha256 `e0046ce0c56b5c9181f6edf66f32d2c21c977031bf64f31adf951ae36a981292`，实现全部落地后仍逐字节通过。
- 场景用 `BASELINE`（webHub/memory/hud/sessionNav/askUser/feishuNotify/webSearch/todo 关）以保证 fake ctx 小且确定，与 schedule-off golden 同口径。

## 2. 改动文件清单

新建：

- `/home/bluecake/ai/pi-toolkit/src/reflex/core/types.ts`、`core/settings.ts`
- `/home/bluecake/ai/pi-toolkit/src/reflex/setting-specs.ts`、`ports/index.ts`、`wire.ts`、`command.ts`、`render-tui.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/README.md`、`R0-report.md`
- `/home/bluecake/ai/pi-toolkit/tests/integration/reflex-off-golden.test.ts`、`tests/fixtures/reflex-off-golden.json`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/reflex.test.ts`、`tests/config/reflex-settings.test.ts`、`tests/reflex/wire-skeleton.test.ts`

修改：

- `/home/bluecake/ai/pi-toolkit/src/index.ts`、`src/config/settings.ts`、`src/config/setting-specs.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/setting-specs-pin.json`、`settings-corpus.json`
- `/home/bluecake/ai/pi-toolkit/tests/governance/trace-profiles.ts`、`tests/fixtures/governance/activate-trace.json`
- `/home/bluecake/ai/pi-toolkit/tests/integration/stack-teardown-matrix.test.ts`、`tests/secure/settings-override.test.ts`、`tests/boundary/pi-free.test.ts`
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`（25,141 → 25,617 B，<32 KiB）

未触碰 plan X1 列表中的任何文件。

## 3. trace diff（仅 `max` 条目，+6 行）

```
@@ -618,6 +618,12 @@
       "on(agent_settled)",
       "registerCommand(webhub)",
       "on(input)",
+      "on(agent_settled)",
+      "on(session_start)",
+      "on(session_shutdown)",
+      "registerMessageRenderer(subagent:reflex)",
+      "registerCommand(reflex)",
+      "on(input)",
       "on(agent_start)",
@@ -626,7 +632,7 @@
-    "count": 248,
+    "count": 254,
```

即 reflex 的 input 插在 session-nav input 与 topic-switch input 之间（git 对齐把新增的 6 行显示在第一个 `on(input)` 之后，实际为 `on(input)` + 其余 5 项）；phase2 不变；default / minimal / child / compat-failure / thread-main / thread-child 档逐字节不变。刷新命令 `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance/activate-trace.test.ts`（未跑整个 governance 目录刷新，bundle-parity 另行验证）。

## 4. pin / corpus 比对（步骤 12）

`/tmp/r0-pin-corpus.txt` 输出摘要：

```
pin specs old/new 336 338 · old prefix identical: true · added: ["reflex.enabled","reflex.autoResolve"] · baseline true
corpus: baseline/seed/randomCount/blocksPerKey 均未变 · template diff: [ '+.reflex' ] · timePaths equal: true
captured len 368/368 · captured inputs identical: true
```

corpus 的 `captured[i].sha` / `defaultsSha` / `randomShas` / `blockShas` 全部变化，原因是每个解析输出都多了 `reflex` 子树（预期；输入集合不变，取自 `git show origin/dev:…` 的 `captured[i].input`）。生成命令：`GOV_SPECS_GENERATE=1 …setting-specs-pin.test.ts`、`GOV_CORPUS_GENERATE=/tmp/r0-captured.json …settings-corpus.test.ts`，随后 prettier。

## 5. teardown 计数基线

HEAD（R0 之前）FULL 档：`session_shutdown` = 15、`session_start` = 17（与 plan 旧估计一致；实测加 reflex 后首次失败信息 "expected 16 to be 15"）。R0 后：16 / 18；BASELINE 档 8 / 8 不变。

## 6. 自验命令与结果

- `PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/integration/reflex-off-golden.test.ts tests/config tests/secure/settings-override.test.ts tests/boundary tests/governance tests/integration/stack-teardown-matrix.test.ts tests/integration/topic-switch.test.ts tests/docs/agents-md.test.ts tests/conformance/reflex.test.ts tests/reflex` → 全文 `/tmp/r0-vitest.log`：61 文件 / 826 测试，**仅** `tests/governance/bundle-parity.test.ts` 3 例失败（"bundle/max call count expected 248 to be 254"）。原因：该测试读 `dist/` 里的旧 bundle，而我同一时间在跑 `npm run build`（bundle 是上一次构建，未含 reflex）。build 完成后单独重跑 `npx vitest run tests/governance/bundle-parity.test.ts` → `/tmp/r0-bundle.log`：1 文件 / 28 测试全绿。除此之外 60 文件 822 测试全绿（1 todo = C-R6 引用）。
- `git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-off-golden.json' ':!tests/fixtures/governance/activate-trace.json'` → exit 0。
- `npm run format:check` → exit 0；`npm run typecheck` → exit 0（`/tmp/r0-typecheck.log`）；`npm run build` → exit 0（`/tmp/r0-build.log`）。
- 全量 `npm test` 按任务要求未跑，留给 root。

## 7. 要点 / 偏差 / 遗留

- C-R7 **做成了自动化**：tui-harness 只调 `init()`，主循环在 `InteractiveMode.run()`；`init()` 幂等，测试里 `void harness.mode.run()` 即可启动真实主循环，实测第二次提交排队、顺序执行。无需降级为手动步骤（README 仍留手动复核说明）。C-R8 同样通过 TUI harness（`"tui"`）与 SDK session（非 `"tui"`）。
- `ReflexWiring` 在 arch 的 `snapshot()` 之外追加了 `isStale(gen)` / `generation()`（plan 步骤 8 要求 R0 落地 `isStale`，测试需要读它）。
- `executePort` 为占位：返回 `{kind:"unavailable", reason:"skeleton"}`（R2a 填）；`createPortRegistry` 为空实现。
- `renderReflexMessage` 骨架返回 `undefined`（pi 退回默认渲染）；`/reflex` 仅回 `reflex: enabled (skeleton)`。
- `ReflexStatusSnapshot` 字段为 R0 自拟（enabled/generation/disposed/inFlight/scripts/counters/unknownAutoResolve）；R2b 如需增字段只许追加。
- 活跃设置键存放：`reflex.autoResolve` 为 `live:true` 的 csv 键，文件内可写 csv 字符串或数组。
- 不在范围、未处理：trace 文件里 #16 相关 diff（HEAD 上已无冲突，本次刷新只出现 reflex 6 行）。
