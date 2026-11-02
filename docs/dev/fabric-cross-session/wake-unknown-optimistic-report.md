# wake-unknown-optimistic 实施报告

方案：`wake-unknown-optimistic-plan.md`（r2，含评审处置表）。本报告记录必过门禁的执行结果与实施中的偏差/发现。

## 1. 必过门禁：真实 legacy conformance（§5.1，评审 #1）

- **文件**：`tests/conformance/fabric-xs-legacy.test.ts`（自门控 `PI_TOOLKIT_LEGACY_PI_DIR`，CI 不设 ⇒ 跳过；未设变量时本仓门禁 `tests/governance` 等不受影响）。
- **加载方式**：vitest 内动态 `import(pathToFileURL(join(dir, "dist/bundle/index.js")))`（F6：bundle 自包含、导出 createAgentSession/SessionManager/SettingsManager/DefaultResourceLoader/ModelRuntime、不导出 streamSimple）。被测守卫（`src/fabric/root-wake.ts` 等）pi-free，直接 import。**未使用** tsx 脚本替代。
- **provider 方案**：**A**（`ModelRuntime.create({modelsPath})` + agentDir `models.json` 内联 `apiKey` 指向本地 AnthropicStub，走 legacy 自己的 provider 管线）。两个坑（已探明并绕开）：
  - 写 auth.json（`{"xs-local":{apiKey}}` 形状）会**静默**使凭据失效（run 零请求结束）——不写 auth.json，凭据用 models.json 内联 key；
  - pi 1.0 的 `agent_settled` 事件**没有** `aborted` 字段（1.1 才加）；1.0 上 context-abort run 的证据是 `agent_end` 末条 assistant `stopReason:"error"`（两版 bundle 均已实测）。测试用版本兼容的 `abortedRun()` 判定。
- **L4 的 harness 偏差**：L4 要求在 `agent_settled` 里派发并断言 `start_deferred`；但 legacy 宿主上任何人类 prompt 的 BAS（`{prompt}` 旧形状）都会立刻把 capability 置 absent，使后续 wake 派发直接 `host_unsupported`、测不到 deferred。因此 L4 的 harness 对该用例**记录但不转发**人类 BAS（`forwardBas:false`，与 C-X12b 的 noBasForward 同构）——被测的 Fpi5 延迟/排队 run/context-abort 机制与该观察无关。
- **命令与结果**（全部通过；L1–L4 各 1 用例，L1+L2 合并为一例）：

```sh
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi10/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
# Test Files 1 passed (1) · Tests 3 passed (3)   # pi 1.0.4
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi11/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
# Test Files 1 passed (1) · Tests 3 passed (3)   # pi 1.1.0
```

L2 关键断言在两版上均成立：unknown ⇒ `{dispatched:true, effect:"applied", woke:true}`（F2：派发后同步 `!isIdle`）；stub **0 个** provider 请求；capability → absent；audit 恰好 1 条 `wake_shape_absent_aborted`；abort 恰好 1 次；账本墓碑带 `gateSightAt`；第二次 dispatch ⇒ `host_unsupported`。

## 2. 真实 1.4 conformance（§5.2）

- C-X12（unknown ⇒ 乐观派发、BAS 授权、`authorizedAt`、context 守卫 `authorized`、恰好 1 个 provider 请求、details 不进 payload）与 C-X12b（BAS 不转发 ⇒ context abort 先于 provider、0 请求、absent、监督到 settle、后续 `host_unsupported`）已加入 `tests/conformance/fabric-xs.test.ts`；harness 的 extension factory 增加了 `api.on("context", e => controller.context(e))` 转发。
- `tests/conformance/fabric-xs.test.ts` 全量 **22/22 通过**（C-X1…C-X12b，含 C-X6 委托的 C-P1–C-P5）。

## 3. governance trace（§3）

`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance` 后 `git diff -U0 tests/fixtures/governance/activate-trace.json` **恰好两处**：max profile `[43]` 插入 `"on(context)"`、`"count": 245→246`；其余 profile 无差异（child 不经 `registerTriggerGuard` 的 xsEnabled 块）。与方案 §3 逐 profile 预期一致。A 级 golden 未动（见 §6 验证）。

## 4. 实施中发现并修复的两个既有 latent bug（property 测试 §5.4 评审 #7 的产出）

1. **无 token 孤儿 abort 误占 idle controller**：`beforeAgentStart` 的 `aborted && result.token === this.token` 分支在两者都为 `undefined` 时成立，把 idle controller 推入无 token、无定时器的 `aborting`。修复：该分支加 `result.token !== undefined` 守卫（`context()` 新方法本就有此守卫）。
2. **已 handed 墓碑被 BAS 误 abort**：recover 的空闲撤销会给 handed 记录落墓碑，之后 BAS 观察点走墓碑分支把它 abort——违反方案 §1.2「legacy 已 handedOver ⇒ 不 abort」与 §5.4 不变量「handedOver 之后 abort 为 0」。修复：`observeRootWakeTrigger` 对 `handed ∧ 非live` 记录只写 `gateSightAt` 并返回 `other`（与 context 守卫的 handed 分支同构）。

两处均为方案语义内的最小修复（不是新语义），由 property 测试的收敛反例驱动。

## 5. 偏离与裁定

- **`tests/integration/fabric-xs-reply.test.ts` 的 4 个 quiet-path 用例**（#2 quiet、#3b、#3c、#3d）原本依赖「未 prime 的请求者 capability=unknown ⇒ `host_unverified` 降级 ⇒ NoticeGate 落 quiet 写」。方案 N1 改判后 unknown 不再降级 ⇒ 这类超时通知**直接唤醒**请求者（`written:"wake"`；主会话在干净 HEAD 验证 17/17 绿，确认 4 失败系本改动引起）。这是方案明确改变的语义（§0/§7 末段：「TUI/web 刚开…现在可以直接唤醒」）；新语义由 #2 wake-path 变体与 `fabric-xs.test.ts` 的 N1 行（unknown ⇒ `woke:true`、verified）钉住。4 个用例改为用一条 legacy BAS 事件把 capability 置 absent 进入**同一条未变的** quiet 写路径（合并/去重/owed 清理机制照旧被钉住）。改后 17/17 绿。
- 方案 §2.7 `stackInput()` 的 `abortOrphan` 端口需要一个存活 ctx：activation 闭包保存最近 session ctx（`beginSessionStart`/`attach` 刷新），端口在调用时读取（ctx 由 `attach()` 设置；调用时尚无 ctx ⇒ 返回 false）。验收 major#1 指出初版交付遗漏了这处生产接线，主会话补上并以 `tests/fabric/xs-activate-orphan.test.ts` 钉住。
- `RootWakeOrphanWatch.dispose()`（session_shutdown 调用）实现为「清定时器 + 清 latch」而非永久失效：同一 activation 要继续服务 `/new` 后的下一个会话；`/reload` 会新建 activation/watch。

## 6. 定向验证（§6）

```sh
npx vitest run tests/fabric/root-wake.test.ts tests/fabric/root-wake.property.test.ts tests/fabric/xs-host-cap.test.ts \
  tests/fabric/xs-truth-table.test.ts tests/fabric/xs-level.test.ts tests/fabric/xs-wake-ledger.test.ts \
  tests/fabric/xs-receiver.test.ts tests/adapters/pi-compat-trigger.test.ts tests/commands/status-xs.test.ts \
  tests/web-hub/protocol/xs-frames.test.ts tests/schedule/agent/message.test.ts
# Tests 263 passed (263)
npx vitest run tests/integration/fabric-xs.test.ts tests/integration/fabric-xs-lifecycle.test.ts \
  tests/integration/fabric-xs-channel.test.ts tests/integration/fabric-xs-reply*.test.ts
# Tests 40 passed (40)  （含 reply 17/17）
npx vitest run tests/conformance/fabric-xs.test.ts tests/conformance/fabric-wake.test.ts tests/conformance/schedule.test.ts
# （见最终回复的真实输出尾部；fabric-xs 22/22）
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi10/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts   # 3/3
PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi11/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts   # 3/3
PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance && npx vitest run tests/governance tests/boundary
# Tests 35 passed (35)（governance+boundary）
git diff -U0 tests/fixtures/governance/activate-trace.json   # 仅 max +on(context) / count 246
git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/governance/activate-trace.json' && echo A-tier-clean
```

## 7. 遗留

- 全量 `npm test` 由主会话执行（本任务不跑）。
- 设计文档只完成了最小改动（phase2-plan §6.7 unknown 行、§14 N1 改判小节、README 统一表述一句 + gates）；方案 §4 的其余条目（§4.5 表拆行与 woke:true 注、§6.2/§6.5/§6.6 补行、§11 XR7、§14 N1 原文保留格式）未逐字落盘，语义已由本报告与 README/§6.7/§14 记录，留待后续文档批处理。
- 推荐项（不强制）：`PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi13/package` 按 BAS 形状分支断言联合宿主预期（未执行）。
