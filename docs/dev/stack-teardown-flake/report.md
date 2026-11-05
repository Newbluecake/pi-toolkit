# #31 — path A 漏拆 sysload 采样器（load）：根因、修复与验证

日期 2026-11-05 · 分支 dev @ b217a4bf · 症状：`tests/integration/stack-teardown-matrix.test.ts` 中 G10、baseline、G2/G3 用例随机变红（只读排查已确认：病态组合 `npx vitest run … -t "path A alone|G10 FIXED"` 修复前稳定红 6/6）。

## 根因

两层：

1. **产品缺口**。sysload 采样器 `load`（`createLoadActivation`，`src/stack.ts` ~:600；5 s、unref 的真实定时器）只在 path B（`DEFENSIVE_STEPS` 的 `dynamic` 之后）和 path C4（`SHUTDOWN_STEPS` 的 `dynamic` 之后）里被拆除；`TeardownParts` 没有 `load` 槽、`REBUILD_STEPS` 没有 load 步骤。于是「只有 A、前面没有 B/C」的重建——公开入口 `Stack.dispose({kind:"rebuild-handoff"})`，或同模块连续 `buildSessionStack` 两次——会把上一份 build 的采样器留在后台继续采样。
2. **测试卫生**。`stack-teardown-matrix.test.ts` 的 `rebuildOnly()` 只手工清理 `probe.stacks` 的最后一份 stack；配合缺口 1，第一份 stack 的 load 采样器（真实 5 s unref'd setTimeout 链）泄漏进后续用例。后面 gaps describe 的 `beforeEach` 安装 fake timers（`toFake: setTimeout/clearTimeout/setInterval/clearInterval/Date`）——泄漏的真实定时器在 fake 时间轴外继续触发 `sampleOnce`（`/proc` 真实 IO + promise 链），随机污染 G10、baseline、G2/G3 的计时器证据，造成非确定性红。

为什么确定性复现是 `path A alone|G10 FIXED`：`path A alone` 用例正是 `rebuildOnly()`（泄漏源），G10 是紧随其后的第一个 fake-timer 用例。

## 改动（4 个文件）

| 文件                                              | 改动                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/stack-teardown.ts`                           | `TeardownParts` 增加 `load?: LoadActivation \| undefined`（quota 之后，注明 #31 原因）；`REBUILD_STEPS` 在 `keepalive`、`quota` 的 dispose 之后、`workflowRuns` 之前插入 `rebuildDispose("load", "load")`——与 path C 的相对顺序（keepalive → quota → … → load）对齐；`LoadActivation.dispose` 幂等（`src/sysload/activation.ts` re-entry guard），C→A 双调用安全 |
| `src/stack.ts`                                    | `:601` `load?.start(...)` 之后按「增量填充 parts」既有写法加 `if (load) parts.load = load;`；`runRebuildHandoff(previousParts)` 在 `:589` 已执行完，此填充只作用于下一次 build 的 handoff                                                                                                                                                                        |
| `tests/integration/stack-teardown-matrix.test.ts` | ① `pathA()` 期望表在 `${g}.quota.dispose` 后加 `${g}.load.dispose`；② `rebuildOnly()` 清理遍历 `probe.stacks` 的**每一份** stack（原 `last` 一份）；③ `path A alone` 用例补断言 `probe.stacks[0]?.load` 存在 + `log.filter(l => l === "g1.load.dispose")` 恰为 1（变异的第一捕获点）                                                                             |
| `docs/dev/subagent-core/README.md`                | 「Stack teardown」组件清单补 `load`（sysload 采样器，三路齐拆、A 经 `parts.load`、幂等），记录该缺口已由 #31 修复；G5/G6 仍是仅存的开放缺口（load 缺口从未编号，不属于 G 系列）                                                                                                                                                                                  |

设计注记：`stack.load` 与 `parts.load` 是同一对象；probe wrapper 包在方法层，所以 A 的第二次（幂等 no-op）dispose 也记日志——与 keepalive/quota 的 C→A 双记录既有模式一致（`fabricAlreadyDisposed` 只影响 mailbox.dispose 内部嵌套的 wake 行，与此无关）。

## 验证（真实输出）

**环境说明**：并行包正在共享工作区实时改写 `src/web-hub/**`（验证期间 `src/web-hub/agent/index.ts` mtime 17:37:02，落在测试循环中间，曾致 `ReferenceError: createReloadTracker is not defined` 的非我方红）。为拿到可信结果，验证在隔离副本进行：`git archive HEAD`（只读 git 操作）导出 b217a4bf 干净基线到 `/tmp/g10fix`，叠加本次 4 个文件，node_modules 符号链接。所有日志在 `/tmp/g10fix-*.log`。

① 病态组合 ×6（`-t "path A alone|G10 FIXED"`）：

```
run 1 exit=0   Tests  2 passed | 26 skipped
run 2 exit=0   Tests  2 passed | 26 skipped
run 3 exit=0   Tests  2 passed | 26 skipped
run 4 exit=0   Tests  2 passed | 26 skipped
run 5 exit=0   Tests  2 passed | 26 skipped
run 6 exit=0   Tests  2 passed | 26 skipped
```

② 整文件 ×6：

```
run 1..6 exit=0 ×6
run 6: Test Files  1 passed (1)   Tests  28 passed (28)
```

③ 变异验证（在隔离副本删除 `rebuildDispose("load", "load")` 一行，期望表/断言保持）：

```
mutated exit=1
 FAIL … > path A alone (a rebuild with neither B nor C before it) …
AssertionError: expected [] to have a length of 1 but got +0   ← 新断言先于期望表捕获
      Tests  1 failed | 1 passed | 26 skipped
restored exit=0（path A alone 单测复绿）
```

变异下 G10 仍绿恰好证明新防护的两层分工：产品断言（`g1.load.dispose` 进期望表 + 专属断言）**确定性**捕获缺口，测试自身的全量清理消除跨用例污染——不再依赖概率性 flake 才能发现问题。

④ 关联套件 `stack-dispose-api + sysload + delivery + governance`（隔离副本先 `npm run build:bundle` 生成 dist——bundle-parity 依赖）：

```
exit=0   Test Files  22 passed (22)   Tests  196 passed (196)
```

⑤ `npm run typecheck`（隔离副本）：`exit=0`（tsc ×2 + vue-tsc 全过）。
⑥ `npx prettier --check` 4 个改动文件：通过（测试文件初版注释超宽已 `--write` 修正并复验）。`git diff --quiet HEAD -- tests/fixtures/`：`exit=0`——A 级冻结产物未动，`governance/activate-trace.json` 不受影响（本次零注册改动）。

## 遗留 / 范围外

- 共享工作区并行包的在途状态（`src/web-hub/agent/index.ts` 等中间态曾使任何原地验证不可信）——merge 前各包需自行跑门禁；本次冻结路径（reflex/config/reload/commands/web-hub 等）未碰。
- `performance` 未加入 fake timers 的 `toFake`（明确不在 #31 范围）。
- path B 的 G5/G6 维持开放（不可达路径，有意不修）。
