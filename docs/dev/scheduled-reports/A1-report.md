# A1 background 执行器包交付

依据：`plan.md` r3 §5/§6/§12 A1/§14；依赖 S0 `ec4297b0`、S1 `47d07e95`、A0 `85961b04`。仅修改本包独占域；未修改 spec/reader/writer、stack/index 或其他并行包；零 git 写操作。

## 1. 文件清单

| 文件（仓库相对路径）                       | 内容                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schedule/agent/bg.ts`                 | 安装入口、SpawnRequest 映射、consult-main 解析及显著降级、真实四态穷尽 switch、准入拒绝、bounded wait、防御关闭                         |
| `src/schedule/agent/note.ts`               | quiet/handoff 结果、sender intent CAS、session-proof 文件核验、一次跨进程补投、quiet timer、owner/epoch/mode 守卫                       |
| `src/schedule/agent/report-file.ts`        | UTF-8 有界截断、固定路径、writer 锁内终态/owner/dispose 检查、报告/终态/pendingReports 同事务                                           |
| `tests/schedule/agent/bg.test.ts`          | 13 条：四态、映射、consult、refused、unknown、重复 dispatch、shutdown、stale ctx、executor-only dispose、永不返回端口                   |
| `tests/schedule/agent/note.test.ts`        | 12 条：streaming >10 min、文件唯一证明、handoff、两视图领取、第二次跨进程拒发、活进程/同进程旧 epoch、不确定扫描、16 MiB、print/dispose |
| `tests/schedule/agent/report-file.test.ts` | 5 条：256 KiB/UTF-8、终态单调且不覆盖报告、关闭时仅写 state、容量拒绝、feishu off 与 foreign epoch                                      |
| `docs/dev/scheduled-reports/A1-report.md`  | 本报告                                                                                                                                  |

## 2. 行为及边界

### 2.1 background

- `installBackgroundExecutor(schedule, deps)` 内部注册 `setExecutor("background", api)`；同步 `dispatch` 不等待结果、不抛异步错误。运行中的 promise 按 runKey 去重；锁内要求该 run 仍为本 holder 的 `dispatching`。
- 请求严格使用既有 `SpawnRequest`：`type/prompt/label/cwd/modelOverride/thinkingOverride/budgetOverride.totalMs/timeoutPolicy:"fixed"/suppressDelivery:true/callerOwned:true/isolation/consultExperts`。不设置 `poolFullPolicy`/`loadPolicy`，cron 继续排队并豁免 load gate；spawn 前再跑 `schedule.gate(task)`。
- `consult.resolveExperts(["main"])` 抛错、缺少端口或 refs 为空时不带 consult 继续运行，报告与结果摘要前缀有显著原因；不请求其他专家、不复制主会话上下文。
- `mapBackgroundOutcome` 对 `completed/failed/timed_out/aborted` 穷尽 switch，`never` 收尾；失败含 error 摘要和部分输出，超时含 timeoutReason，aborted 含 stopCause（缺省 unspecified）。准入明确拒绝为 `refused(admission:<reason|kind>)`。
- 成功 spawn 后写 `running(runId)`。`waitOutcome(runId, <=60_000)` 的每次调用另有外层 deadline，累计 wall-independent 单调预算及 pending 次数预算双限；总等待 = timeoutS + 防御余量（缺省 105 s，可配置但 clamp 0–5 min）。pending 超限、wait 错误/卡死 ⇒ `unknown(no-outcome)`，不重跑。
- A0 正常 shutdown 先写 unknown；迟到 outcome 只追加 lateOutcome。executor-only `dispose` 也对捕获的活 run 发起 ctx-free 单调关闭事务。`drain()` 等当时已有的执行及关闭事务，不是交互 turn 上的阻塞接口。

### 2.2 报告

- 仅通过 **`writeReportLocked`** 落盘；路径由 `reportFileOf(sid, runKey)` 生成，单份 ≤256 KiB，UTF-8 边界截断并加截断说明。feishu off 仍保留本地报告，但不进待推索引。
- S1 `writeReportLocked` 先写文件再调 commit，故不能仅在 commit 中检查终态：本包使用窄 `SessionStore.transact` 装饰端口，**在同一 writer 锁内、任何报告 IO 之前**检查 current run/holder/terminal/disposed。正常才进入原 writer body。没有第二把锁，也没有“先 GC 后写”的容量竞态。
- 终态、reportFile、note pending/noteId 与可选 `pendingReports` 在 writer commit 中一起提交；容量拒绝仍保留结果消息、标 `report-skipped(cap)`、不进索引。
- 已终态：只补一次 lateOutcome，不覆盖报告；已 disposed：只写本 sid 的 state.json（unknown 和审计），不写报告/索引、不通过旧 ctx 发消息或 changed 帧。rename uncertain 不基于回调值投递；保留 pending 留待后续核验。

### 2.3 note

- 发送前取 S1 `sessionFileAnchor`，锁内 CAS note pending/id/holder，写 sender intent + offset 后才发送。sendMessage 返回值、内存队列、message_start/message_end 均不作证明。
- 同栈核验用内存锚点；跨栈没有持久锚点，始终 `offset:0` 全量扫描（≤16 MiB，100 ms chunk 间 deadline），遵守 S1 fail-closed 规则。found ⇒ written；too-large ⇒ unverified；inconclusive/refused ⇒ 保持 pending，不补投。
- 同进程（含不同 epoch、已知 disposed epoch）永不补投：旧 AgentSession 仍可能持有消息。不同进程只有 `judgeHolder(...).liveness === "dead"` 且文件 `absent` 才可领取；跨主机/不可证明/仍活着不扫描、不重发。领取时锁内再次核对 sender；两个视图至多一个受理。
- quiet 结果即使到达时 owner 已 idle，也安排一次 quiet-period 核验；`agent_settled` 同样安排。只有一枚 unref 的 `systemClock` timer，dispose 清除；没有自建轮询。内存 anchor 表有 8×20 上限。
- handoff 只交 A2，不自行 triggerTurn。`handoff` 端口明确返回 false（未受理）时改为 quiet recap；已经受理后的未知结果不盲目再次投递。同一随机 noteId 用 `handoff:` 前缀保留 handoff 意图，任务删除/修改后补投仍为 quiet `handoff-recap`（不新增 schema 字段）。

## 3. 后续集成接口（本包没有修改 stack/index）

```ts
import { installBackgroundExecutor } from "./schedule/agent/bg.js";

// buildSessionStack：schedule 建好后、能拿到 spawn/consult 的位置；每个 session 只装一次。
const background =
  schedule &&
  installBackgroundExecutor(schedule, {
    spawn, // Pick<SpawnService, "spawn" | "waitOutcome">
    ...(consult ? { consult } : {}), // Pick<ConsultWiring, "resolveExperts">
    notes: {
      currentSessionId: () => ctx.sessionManager.getSessionId(),
      sessionFile: () => ctx.sessionManager.getSessionFile(),
      isIdle: () => ctx.isIdle(),
      sendMessage: (message, options) => pi.sendMessage(message, options),
      // 可选：适配 A2 messageScheduler.enqueueHandoff；必须返回其受理 boolean。
      handoff: ({ run, task, message }) =>
        messageScheduler.enqueueHandoff({
          runKey: run.runKey,
          taskId: task.id,
          task,
          noteId: message.details.noteId,
          content: message.content,
          onEnd: () => {
            /* A2 管运行；A1 只从文件核验落盘，不凭回调标 written/重发 */
          },
        }),
    },
  });
```

返回 `BackgroundExecutor`：`dispatch`、`notes.{deliver,flush,settled,idle,dispose}`、`dispose`、`drain`。建议作为可选字段保留在 Stack，事件 hook 均经 `holder.current` 晚绑定：

| 位置                                      | 调用                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`：A0 `schedule.start()` 旁 | `void background?.notes.flush()`（跨进程核验/补投）                                                                                |
| `agent_settled`                           | `background?.notes.settled()`（quiet period + isIdle，非事件即证明）                                                               |
| 需要重试 inconclusive / 未持久化文件时    | idle 的 `turn_start`/显式 refresh 再调 `notes.flush()`；不建议高频轮询                                                             |
| 正常 shutdown                             | **先 `await schedule.shutdown()`**，再 `background.dispose()`，然后原栈 drain/abort 子会话；不得先等 `background.drain()` 再关 run |
| 防御重建                                  | 与 `schedule.dispose()` 同步调用 `background.dispose()`；所有迟到回调只写旧 sid 账本                                               |

没有 handoff 端口时按 quiet 结果降级；不新增旧 ctx 的模块级捕获，不修改通用 notifier。注入自定义 `Clock` 时必须保持生产 `systemClock` 的 unref 语义。

## 4. 与方案偏差及裁定

| 项                   | 偏差                                                  | 理由/处置                                                                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6.3 补投次数        | **从最多 2 次收窄为最多 1 次跨进程补投**              | S0 冻结 RunRecord 无持久次数，2026-10-24 用户明确裁定不改冻结 spec/reader。首次 noteHolder 必须等于 run.holder；补发后更新 holder，之后再遇已死 sender 且确认缺失，只标 unverified，不再投。宁漏勿重。测试同时覆盖真实第一次领取后的第三进程，以及预置第二 sender。 |
| 准入卡死             | spawn 60 s 不返回时记 unknown(no-outcome)，非 refused | 端口可能已创建 child，不能把 timeout 当作确认拒绝；不自动重试。明确 throw/返回 error 仍按方案 refused。                                                                                                                                                             |
| 报告 IO 入口         | `writeReportLocked` 前通过 transact 装饰做锁内 guard  | S1 不提供 pre-write callback，报告若先写再判 late 会覆盖首次报告。此适配仅本包文件，不改冻结 S1。                                                                                                                                                                   |
| handoff 跨进程 recap | 随机 noteId 带 handoff: 前缀                          | 不扩展存储契约，删除任务后仍知道 recap 类型；id 保持原样，不编码补投次数。                                                                                                                                                                                          |

## 5. TDD、撤销验证

先写三组测试并运行：3 suites 因 bg/note/report-file 模块不存在失败，之后实现。不是把缺依赖失败冒充完整行为红灯：实现后进一步执行真实 mutation/reversal，脚本 `/tmp/sched-a1-reversal.py`，每次 finally 还原原内容，零 git 操作。

| 临时撤销                                            | 真实结果                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| aborted 不读取 stopCause、恒记 unspecified          | bg `maps aborted` 1 failed                                              |
| 移除 `noteHolder != run.holder` 一次补投限制        | note 两个跨进程测试 2 failed                                            |
| 移除 report 的锁内 terminal guard                   | report first-terminal 1 failed（迟到覆盖报告）                          |
| 本包临时引入 `future_status` 作为 RunOutcome 第五态 | tsc 在 `const exhaustive: never = outcome.status` 报 TS2322；还原后通过 |

日志：`/tmp/sched-a1-reversal-{stopCause,resend-limit,terminal-report,exhaustiveness}.log`。

## 6. 自验

| 命令                                                                                                                                       | 结果                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run tests/schedule --maxWorkers=3`                                                                                             | 最终整组：23 文件 350 passed（本包 30 条）。首次 347 passed / 1 failed，S1 `fault-injection.test.ts:113` expected SIGKILL / actual null（A0 已披露的被害进程提前退出时序 flake）；未改该冻结测试；第二次整组通过。 |
| `npx vitest run tests/schedule/agent/bg.test.ts tests/schedule/agent/note.test.ts tests/schedule/agent/report-file.test.ts --maxWorkers=3` | 最终定向 30 passed（13 + 12 + 5）                                                                                                                                                                                  |
| `npx tsc --noEmit -p /tmp/sched-a1-tests-tsconfig.json`                                                                                    | 通过；额外把本包测试本身纳入 strict 检查                                                                                                                                                                           |
| `npx tsc --noEmit -p tsconfig.json 2>&1 \| grep -v "web-hub/hub/schedule" \| tail`                                                         | 本包 0 错误；并行 H1/F1 hub 联调期间曾显示 hub.ts 三个接口错误和 at 类型残余。最终过滤输出为空；另跑未过滤 `npx tsc --noEmit -p tsconfig.json` 明确 exit=0。过滤命令的退出码本身不是 tsc 通过证明。                |
| `npm run build`                                                                                                                            | 最终通过（exit=0）。此前被并行 `src/web-hub/hub/{hub.ts,schedule/*}` 未完成接口阻塞，详见下节；其他包自行闭合，本包未越域修复。                                                                                    |
| `npx prettier --check` 本报告及本包 6 个 TS 文件                                                                                           | 通过（All matched files use Prettier code style!）                                                                                                                                                                 |

## 7. 遗留与范围外问题

- 接线明确留给 I1/A3：安装函数本身已测试，但没有改 stack/index；尚未运行真实 pi C-S 一致性、真实飞书/手机或全仓 17k+ 测试。
- 整组测试曾遇 S1 SIGKILL fixture flake，后续整组通过，不能把该时序问题说成已修复。
- `writeReportLocked` 的全局 2000/128 MiB 上限仍按 S1 软上限约定处理；本包只依赖其会话硬准入，不另加全局 GC/锁。
- report 写入/账本提交 I/O 失败时不发送未确认结果。报告可能成为未引用孤儿，由 S1 GC 处理；run 留给 A0 恢复。ctx 在 sender intent 写入后失效，宁可留下 pending 不发送。
- 同进程旧 epoch 可能长期 pending，这是方案已接受的内存队列证据缺口。inconclusive 不自行循环重试：下一次 flush/settled 再核验；持续活跃文件可能宁漏勿重。
- 本次 build 的范围外阻塞（22:49）：H1/F1 的 `ScheduleBotIntegration/botConfigured/bindBot`、`ScheduleReceiptState`、`SchedHubStoreFs.exists`、reader StoreRoot 参数、ScanOpts/ScanResult、FeishuScheduleRow readonly、service `ts` 未定义等；已 message_agent root，上述文件均未改。
