# T1 交付报告：会话变更栅栏（`src/fabric/xs/fence.ts`）

状态：已完成。基线 `dev` @ `4f0dcfb3`（XS0 契约已含）。依据 `phase2-plan.md` §7、§11.1 T1 行、§11.2 T1 行，**文末 r3 主会话裁定 M1 优先于正文**。

## 交付物

| 文件                                                          | 改动                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/xs/fence.ts`                                      | **新建**，pi-free（只 import `src/core/clock.js`）。`createSessionFence(options)` 返回 `SessionFence`：`onEvent` / `check` / `generation` / `beginDispatch` / `verifyDispatch` / `status` / `reset` / `dispose`。      |
| `src/topic-switch/wire.ts`                                    | 只加只读 `fenceActive(): boolean`（`TopicSwitchWiring` 新增字段）：pending hold（本 activation 存活且 `currentHold !== undefined`）∨ 进程级 B1 mid-switch 标记（`transferGlobal().inFlight` 非空）。无副作用、不抛错。 |
| `src/goal/hook.ts`                                            | 只加只读 `goalBusy(): boolean`（`GoalLoopHook` 新增方法）：`evalInFlight` ∨ record.state === `"active"`。                                                                                                              |
| `tests/fabric/xs-fence.test.ts`                               | **新建**，验收锚点（§11.2 T1 行 + r3 M1 两条补测），25 用例。                                                                                                                                                          |
| `tests/topic-switch/wire.test.ts` / `tests/goal/hook.test.ts` | 追加两个 describe 钉住两个只读端口的语义（均为加法，不动既有用例）。                                                                                                                                                   |

未触碰 `src/stack.ts` / `src/index.ts`（XW 集成包所有）；未改任何其它文件。

## M1 裁定的落实（相对 r2 §7.2 的差异）

1. **删除「后续 input / before_agent_start / run 启动 = 切换已取消」推断。** `FenceEvent` 联合里保留 `input` / `before_agent_start` 两个成员（XW 可原样转发），`onEvent` 对其**显式忽略**（代码注释与测试双重钉住）。tree / switch 的取消路径（Fpi9：无完成事件）⇒ 窗口保持关闭直到 `session_start` / `reset`；30s 只进 `stuck`（`status().stuck` + 一次 `console.warn`，unref 定时器只打标记），`check()` 继续拒收。
2. **删除「完成事件后 `setTimeout(0)` 即证明 controller 已清理」。** 完成事件（`session_compact` / `session_compact_failed` / `session_tree` / `session_shutdown` / `session_start`）在 `onEvent` 内**同步关窗**，模块内不存在任何关窗定时器。
3. **派发点同步复核 `sessionGen` 与栅栏状态。** 新增 `beginDispatch()`（= `check()` + gen 快照）与 `verifyDispatch(gen)`（gen 未变 ∧ `check()` 通过，否则 `{ok:false, reason:"gen_changed"}`）；`generation()` 只被 `session_start` / `session_shutdown` 递增（`reset()` 不递增——会话身份未变，在途 guard 仍有效）。X4 接收管道按 §7.4 在同一同步块里 `beginDispatch → pi.sendMessage → 取证 → verifyDispatch`。
4. **栅栏只因真实完成事件 / `session_start` / 人类本地 `reset()` 打开。** 开/关矩阵：compaction `session_before_compact` → `session_compact|session_compact_failed|session_start`；tree `session_before_tree` → `session_tree|session_start`；switch `session_before_switch|session_before_fork` → `session_shutdown|session_start`（`session_shutdown` 只关 switch，逐字按 §7.2 表）。

## 端口与 wakeOnly

- 端口约定逐字按 §7.2：`() => boolean | undefined`，`undefined`/`false` = 不活动，`true` = 活动，**抛错 = 活动**（fail closed，三个端口各自测试）。
- `goal` 活动只降级不拒收：`check()` ⇒ `{ok:false, reason:"fenced:goal", wakeOnly:true}`；与任一拒收窗口同时活动时**拒收窗口优先**（无 `wakeOnly`）。
- reason 顺序固定：compaction → tree → switch → web_exec → topic_switch → goal（确定性，测试钉住）。
- `status()`：`open`（开窗事件窗口 + 检查时活读的端口，固定顺序）、`stuck`（仅事件窗口，端口无年龄永不 stuck）、`oldestOpenMs`（最老开窗年龄，无开窗时省略——`exactOptionalPropertyTypes`）。

## 其它实现决定

- **重复开窗**（首窗未关又来 before_*）：保留**原** `openedAt`（stuck 计时不重启）、不重复 arm 定时器、不重复告警；每 stuck 周期恰好 warn 一次。
- **定时器全部经注入 `Clock`**（默认 `systemClock`，其 `set` 已 unref——仓库铁律）；测试用 `src/core/clock.ts` 的 `FakeClock`。
- **`dispose()`**：取消在途 stuck 定时器、忽略后续事件；窗口记录保留（被误用时仍 fail closed 报最后一态）。
- **`session_before_fork`** 开 switch 窗（§7.2 原文）。

## r3 要求的两条补测（均在 `tests/fabric/xs-fence.test.ts`）

1. **慢 `before_switch` 期间插入人类输入 ⇒ 栅栏仍关**：`before_switch` → `input` + `before_agent_start` → 仍 `fenced:switch`；推进 30s 进 stuck、只告警一次；再推进 600s 仍拒收。另测 tree 取消路径（无完成事件）只有 `session_start` 能重开。
2. **完成事件后续 handler 长时间 await ⇒ 派发点复核拦住**：完成链（`session_shutdown` → `session_start`）落地后 `beginDispatch()` 拿到 gen 快照；模拟在途派发期间身份再次变化（`session_shutdown`，即后置 handler 长时间 await 后才落地的链尾）⇒ `verifyDispatch(gen)` 返回 `{ok:false, reason:"gen_changed"}`；对照：快照之后新取的 guard 任意长时间后仍 verify 通过（复核是同步状态比对，不依赖定时器/异步链）。另测开窗型中途变化（`fenced:switch`）与 goal 端口中途激活（`wakeOnly`）。

## 自验（均带 timeout，未跑全量 npm test）

| 命令                                                                       | 结果                 |
| -------------------------------------------------------------------------- | -------------------- |
| `vitest run tests/fabric/xs-fence.test.ts`                                 | 25/25 通过           |
| `vitest run tests/topic-switch tests/goal tests/fabric/xs-fence.test.ts`   | 19 文件 395/395 通过 |
| `vitest run tests/integration/goal-wiring.test.ts`（goal hook 加法无回归） | 4/4 通过             |
| `npm run typecheck`（含 `tsconfig.typecheck.json` + vue-tsc）              | 通过                 |
| `npm run format:check`                                                     | 通过                 |

## 给下游包的接缝（X2 / X4 / XW）

- XW 装配：`createSessionFence({ ports })` 每 stack 一份；把 pi 事件映射到 `FenceEvent` 转发（多余字段丢弃）；`ports.webExec` 绑 X2 在 `src/web-hub/agent/index.ts` 新增的 exec-claim 只读 getter，`ports.topicSwitch` 绑本包的 `wireTopicSwitch(...).fenceActive`，`ports.goal` 绑 `goalHook.goalBusy`。
- X4 接收管道：同一同步块 `beginDispatch → pi.sendMessage → 取证 → verifyDispatch(gen)`；`ok:false, wakeOnly:true` = 只投递降级；`gen_changed`/fenced ⇒ 证据不可记 `applied`（M2 的阶段区分在发送端，另包处理）。
- `/fabric fence reset` 命令（X4 所有）调 `fence.reset()`；web 来源拒绝属命令层门禁（§5.3），不在本包。
- `/fabric status` 的 `fence stuck: <name> <age>` 行直接消费 `status()`。
