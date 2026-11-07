# #61 C2 包报告：agent↔hub 链路

## 结论

C2 完成（plan §7 C2 行、§4.4 coordinator/connection/index 条、§8 测试 12 的 agent 侧）：agent 宣告 `sched.confirm.v1` cap、coordinator 补 `offers` / `confirmReady` / `onDecide`（`sched_decide` → `confirm.decide` → 恰好一个 `sched_decide_ack`）、`onHubCaps` 转发 confirm 重发全量。**零 git 写操作**；未碰 C0 协议文件、H2/F2/W2 文件、`tests/fixtures/`（`git diff --quiet HEAD` 干净，activate-trace 未变——本包不新增任何 `pi.on`/注册）。

## 改动

- `src/schedule/agent/coordinator.ts`
  - `SchedHubLink` 追加**可选** `confirmReady?()`（`ready() ∧ hello_ack.caps ∋ sched.confirm.v1`；可选 ⇒ pre-C2 link / 无 cap hub 天然退化为 TUI-only、零新帧，`tests/schedule/agent/wire.test.ts` 的旧 fake 不受影响）。
  - `ScheduleCoordinator` 追加 `offers(frame)` / `confirmReady()` / `onDecide(frame)`；`NULL_SCHEDULE_COORDINATOR` 对应 no-op / `false`（surface 的结构化可选读取保持不变，C1 文件未动）。
  - `createHubCoordinator`：
    - `offers()`：门控 `!disposed ∧ link.confirmReady?.()`，不满足即丢（无队列——confirm 的下次 publish / hello_ack 会重发全量，含空列表）；发送补 `t:"sched_offers"`。
    - `confirmReady()`：`!disposed ∧ link?.confirmReady?.() === true`。
    - `onHubCaps()`：原 `sched_changed` 宣告 + 调 `deps.confirm?.()?.onHubCaps()`（confirm 重发权威全量；异常吞掉不破坏 link hook）。
    - `onDecide(frame)`（照 `onRun` 形状）：disposed/sessionId 不符 ⇒ `refused E_NOT_OWNER`；过期 ⇒ `refused expired`；无 confirm ⇒ `refused offer-gone`；否则 `confirm.decide({taskId, defHash, decision, via:"feishu", offerId})`，`DecideResult` 映射 ack（`approved|rejected|refused`，refused 的 `reason = code`，≤128 字符）；decide 抛错 ⇒ `refused E_BUSY`；按 `reqId` 在途去重（复用同一 promise，**每帧仍各回一个 ack**）。
    - `HubCoordinatorDeps.confirm?: () => ScheduleConfirm | undefined`（晚绑定；confirm 由 surface 在 coordinator 之后创建）。
  - `ScheduleWebHubPort` / `ScheduleHubRouter` 追加 `onSchedDecide(frame)`；router 无会话 attach 时回恰好一个 `refused E_NOT_OWNER`。
- `src/web-hub/agent/connection.ts`：`BindingPort.onSchedDecide?`（文档注明恰好一 ack 契约、live-link-only、无 hook 由 hub 的 ack 等待兜底）；`onFrame` switch 追加 `case "sched_decide"`（live-only）。
- `src/web-hub/agent/index.ts`：`bindLink` 提供 `confirmReady`（live ∧ caps ∋ `sched.v1` ∧ `sched.confirm.v1`）；binding 的 schedule 分支追加 `onSchedDecide` 转发；`capsExtra` 在 `schedulePort` 存在时尾追加 `SCHED_CONFIRM_CAP`（schedule off ⇒ 无 cap、无 binding 成员、无新帧，I9）。
- **衔接组装（超出 §7 C2 文件清单，依据 C1 报告「给 C2 的衔接」"由 createAgent/index 组装"，最小改动）**：
  - `src/schedule/agent/wire.ts`：`ScheduleWireOpts.confirm?` / `ScheduleAgentDeps.confirm?`（均为 `exactOptionalPropertyTypes` 条件展开），传入 `createHubCoordinator`。
  - `src/index.ts`：`wireSchedule` opts 加一行 `confirm: (): ScheduleConfirm | undefined => scheduleSurface?.confirm()`（闭包晚绑定，绕过 scheduleWiring↔scheduleSurface 的声明顺序；显式返回类型注解消除 TS7022 循环推断）。无新注册 ⇒ activate-trace golden 不变。
- 测试：
  - `tests/schedule/agent/coordinator.test.ts` +8 例：offers 门控（有/无 cap、掉线、dispose；丢后下次全量重发；`decodeAgentFrame` 回读）、onHubCaps 双动作、onDecide 三结果映射与参数（`via:"feishu"`）、错 sid/过期不调 decide、无 confirm ⇒ offer-gone、decide 抛错 ⇒ E_BUSY、同 reqId 在途去重双 ack、disposed 仍回 E_NOT_OWNER、router 未 attach ⇒ E_NOT_OWNER / attach 后到达、NULL 三成员。
  - `tests/schedule/agent/webhub-wiring.test.ts` +3 例：hello 带 `sched.confirm.v1`（有 port）/不带（无 port）；hub caps 缺 confirm cap ⇒ `ready()=true` 但 `confirmReady()=false`；`sched_decide` 帧经真连接解码路由到 port。

## 与计划的差异 / 判断

1. **组装落在 wire.ts + src/index.ts（各 ≤5 行）**：§7 C2 文件清单未列这两个文件，但 C1 已把 confirm 建在 surface（coordinator 之后创建），coordinator 要拿到 confirm 只能经 `createAgent`/`index` 组装——C1 报告衔接节明确如此建议。纯组装、无逻辑、无新注册。若不接这两处，`onDecide` 在生产永远 `offer-gone`，功能不通。
2. ack 发送门用 `link.ready()`（sched.v1）而非 confirmReady——与 `sched_run_ack` 一致：hub 发出 decide 即因 agent 宣告过 confirm cap，ack 是同一 socket 上的回包，不应因 cap 刷新时序丢失。
3. `offers()` 的 frame 直接信任 confirm 构造的 `sessionId`（同源 `agent.sessionId`）；hub 侧另有 sid×agentKey 校验兜底（H2）。
4. 无 confirm 模块（surface 未 start / 非交互）⇒ `offer-gone`：语义上此刻不存在任何活 offer 注册表，hub 侧卡片走「已在其他端处理/重读」分支（H2/F2 已覆盖该 reason）。

## 自验

- `npm run typecheck`：0 error（TS7 ×2 + vue-tsc）。
- `npx vitest run tests/schedule tests/web-hub/agent tests/governance --maxWorkers=4`：115 文件 / **2119 全过**（含 `tests/governance/activate-trace.test.ts` —— C1 commit 已刷新 golden；本包无新注册，trace 不变）。
- `npx vitest run tests/integration/schedule-off-golden.test.ts tests/integration/schedule-hub.test.ts tests/integration/schedule-surface-wiring.test.ts --maxWorkers=2`：3 文件 10 测试全过（off 画像字节不变；真 hub 子进程链路不回归）。
- `npx prettier --write`（本包 7 文件）：仅 coordinator.test.ts 被重排，复跑 27 测试全过。
- `git diff --quiet HEAD -- tests/fixtures/`：干净。

## 给 I2（集成包）的提示

端到端三渠道竞速所需的 agent 侧链路已齐：`sched_offers`（confirm publish → coordinator.offers → 真连接）、`sched_decide` → ack。可用真 hub + fake pi 验证：hello caps 双方、offers 到达 hub（H2 投影 `offer`）、飞书 decide 回调全链路、旧 hub（无 confirm cap）⇒ TUI-only 零新帧。

## 建议 commit message

```
feat(schedule): wire the confirm channel agent↔hub — sched_offers / sched_decide (#61 C2)

The agent advertises sched.confirm.v1 next to sched.v1 while the schedule port exists, and the
session coordinator gains the confirm link: offers() republishes the confirm module's authoritative
snapshot (cap-gated, no queue — the next publish or hello_ack resends the full list), onHubCaps()
lets confirm re-announce, and onDecide() forwards a Feishu-card sched_decide to confirm.decide()
with exactly one sched_decide_ack per frame (E_NOT_OWNER / expired / offer-gone / E_BUSY, in-flight
reqId dedup). connection.ts routes live sched_decide frames; wire.ts/index.ts only assemble the
late-bound confirm (no new registrations, activate-trace unchanged). A hub without the cap (or a
pre-C2 link) degrades to TUI-only with zero new frames.
```

## 改动文件清单

- src：`src/schedule/agent/coordinator.ts`、`src/schedule/agent/wire.ts`（组装 4 行）、`src/web-hub/agent/connection.ts`、`src/web-hub/agent/index.ts`、`src/index.ts`（组装 1 行 + import）
- tests：`tests/schedule/agent/coordinator.test.ts`、`tests/schedule/agent/webhub-wiring.test.ts`
- docs：`docs/dev/scheduled-reports/confirm-C2-report.md`
