# #21 包 B3（接线 + 闭环门禁 + 文档）实施报告

> 基线 `dev@a820b356`（A `d05552ac`、B2 `13cc2946`、B1 已合入）。依据 `docs/dev/xs-ask-redirect/plan.md`（r3）§2「包 B3」、§3 T11–T13 与 C-X16、§4。
> **状态：部分交付。** 接线、wiring 测试、C-X16、T11 门禁主链路 + timeout + unavailable 为绿；T11 的 not_woken/limit 两例与 T12 harness 未完成（详见「未完成」）。root 已裁定按时间盒收尾。

## 改动文件清单（绝对路径）

| 文件                                                                                    | 改动                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/index.ts`                                             | **唯一源码改动**：`wireAskUser` 调用处加一行条件展开 `...(xs.askRedirectOn ? { redirect: () => holder.current?.xs?.askRedirect } : {})`（B1 的 `StackXs.askRedirect` 结构即 §2.0 端口，无需类型桥接）。无新增 `pi.on`/`registerTool` ⇒ activate-trace 不刷新（tests/governance 未跑全量，见自验）                                                    |
| `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-ask-redirect-wiring.test.ts`  | **新建**（真实 `activate()` × 假 hub socket，alias-wiring 同族 harness）：默认开 ⇒ 委派回合重定向（q2 上 wire、U 文本、零本地对话框、none 退还 askUsed=0、ledger askOrigin 捕获）；leaf off ⇒ 同一委派回合走本地 rpc 对话框、无 q2、无 askOrigin（I9 无痕）；D8/secure ⇒ 真实 loader 强制 crossSession off、无 message_session 工具、ask_user 原路径 |
| `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-xs-ask-redirect-session.test.ts` | **新建（T11 上线门禁）**：两个真实 `AgentSession`（createAgentSession + bindExtensions rpc + 脚本模型）× 真实 `wireAskUser`（B3 接线行）× 两个真实 `buildStackXs`/`createXsSender` × 进程内真实 `createXsRelay`+`createXsAgentBridge`（`rig()`），rootRunMaxS=900。5 例：full loop ✓ / timeout ✓ / unavailable ✓ / not_woken（todo）/ limit（todo）  |
| `/home/bluecake/ai/pi-toolkit/tests/conformance/fabric-xs.test.ts`                      | 追加 **C-X16**（✓）：工具 execute 期间 `sendMessage(triggerTurn:false)` 排在 toolResult 之后入库（branch 断言）、出现在同一 run 下一次 provider 请求的 toolResult 之后（context 事件断言）、details/token 哨兵不进已录 HTTP body；同一 run 无第二次 agent 启动                                                                                       |
| `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/README.md`                  | 新增「Ask redirect (#21)」一节：门控/不变式（D3 来源信任、D4 计费、D5 期限、D7 分类）、门禁清单、残留风险（R1 双份正文、R2 等待计入 rootRunMaxS、busy 请求方窗口、handed⇒O）、harness 注意事项（rig 时钟、member limits 双写）                                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/docs/dev/ask-user-async/README.md`                        | 加一句指引（redirect 端口与 off 字节不变的指针）                                                                                                                                                                                                                                                                                                     |
| `/home/bluecake/ai/pi-toolkit/docs/dev/xs-ask-redirect/B3-report.md`                    | 本报告                                                                                                                                                                                                                                                                                                                                               |

未动：`tests/fixtures/**`（`git diff --quiet HEAD -- tests/fixtures/` 通过）、B1/B2/A 文件、`tests/integration/helpers/fabric-xs-process.ts`（T12 的 XW_ROOT_RUN_MAX_S 旋钮未做）、`tests/integration/fabric-xs-ask-redirect.test.ts`（T12 未建）、`vitest.config.ts`/`tests/tiers.ts` 等 #27 P1 域文件、无 git 写操作。

## T11 五例的最后真实结果

| 例                              | 结果         | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full loop（**上线门禁主链路**） | ✅ 绿        | A 委派（q1）→ B 真实 run 调 ask_user → 重定向 q2 过真实 relay 唤醒 A 的第二个真实 run → A 用 q2 replyTo 回答 `1: ship it` → B **同一 run** 内 ask_user 返回 D8 answered 文本（含原 replyTo id）→ 答复 custom 消息位于 toolResult 之后（D1 前提）→ B 用原 q1 交付、`accepted` → A 第三个 run 收尾。断言含 wakeToken/xsWake 不进 payload、`askUsed=1`（tool_result 时刻快照）                                                                                     |
| timeout                         | ✅ 绿        | A 收到 q2 但脚本不答 ⇒ 真实 60s（parser 下限）后 `timeout after 60s (1/2 this run)`，计费=1，原 q1 票据仍接受 final                                                                                                                                                                                                                                                                                                                                             |
| unavailable                     | ✅ 绿        | A 为 replies 模式 ⇒ hub 准入拒绝 q2 ⇒ `send_none:rejected`、退订（askUsed=0）、无 q2 到达 A、final（inReplyTo）仍送达                                                                                                                                                                                                                                                                                                                                           |
| not_woken                       | ⬜ `it.todo` | 失败点：本 rig 中第二问的 q2 被hub pair-interval 准入拒绝（`send_none:rate_pair_interval`），永远到不了 pair-wake 配额 ⇒ `pair_wake_rate` 降级无法在此 harness 显现。判断原因：本地 FIFO（settings 6s）与 hub 侧 pair.lastAt（发送回执后盖章）的边界竞态 + B1 报告已记录的「hub 侧拒绝以 send_none 兜底为设计接受」；已试过 local>declared 的间隔错开与 bridge memberLimits 双写对齐，仍未消除。not_woken 的分类本身由 B1 单测（T10 穷举矩阵）+ B2 文本单测钉住 |
| limit                           | ⬜ `it.todo` | 同一根因（第二问即被 pair-interval 拒绝，流程到不了第三问）。limit 拒绝由 B1 单测（T5）+ B2 文本单测钉住                                                                                                                                                                                                                                                                                                                                                        |

调试中钉住并写进代码注释的 harness 事实（对后手有用）：rig 时钟必须做成活钟（`Object.defineProperty(r.clock,"t",{get:()=>Date.now()})`，否则 5s 后所有帧 expired）；bridge 会重发 `xs_member`，其 `memberLimits()` 必须与 rig 注册值一致（否则默认 30s pair interval 覆盖声明值）；ask 的模型回合必须 gate 到请求方 `agent_settled` 之后（q2 落在请求方 busy 窗会被降级 deliver-only，唤醒丢失——这正是 D7 `queued` 分支等待到期的真实场景）。

## 自验（真实输出；root 时间盒裁定后未完成全套 3× 轮次）

| 命令                                                                      | 结果                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit -p tsconfig.json`                                       | 0 错误（多轮，含最终态）                                                                                                                                                                                            |
| `npx vitest run tests/integration/fabric-xs-ask-redirect-wiring.test.ts`  | 3/3 绿（首绿后多次复跑均绿；日志 /tmp/b3-wiring-2.log 等）                                                                                                                                                          |
| `npx vitest run tests/integration/fabric-xs-ask-redirect-session.test.ts` | 3 绿 + 2 todo（最后一轮 /tmp/b3-t11-full2.log 及后续定向复跑；timeout 例含真实 60s 等待，全套 ~65s）                                                                                                                |
| `npx vitest run tests/conformance/fabric-xs.test.ts -t C-X16`             | 1/1 绿（最终态）                                                                                                                                                                                                    |
| `npx prettier --check`（全部改动文件）                                    | 通过                                                                                                                                                                                                                |
| `git diff --quiet HEAD -- tests/fixtures/`                                | 零 diff                                                                                                                                                                                                             |
| 时间盒内**未跑**                                                          | 三个新测试各 3 次的完整轮次、`tests/conformance/fabric-xs.test.ts` 全量（C-X1…C-X16）、三个 xs off golden、tests/governance、tests/fabric、tests/ask-user、`npm run typecheck`（双工程）、`npm run build`、T12 全部 |

## 未完成项（接手者从这里继续）

1. **T12 `tests/integration/fabric-xs-ask-redirect.test.ts`（真实 hub 子进程 harness）— 未建**。计划：在 `tests/integration/helpers/fabric-xs-process.ts` 加 `XW_ROOT_RUN_MAX_S`（默认 60，本套件 600）与 `XW_ASK_USER=1`（config 的 askUser.enabled 改 true，让真实 activate 的 B3 接线在子进程内生效）两个旋钮；用现有 `XsHarness`：A 以 expectReply+wake 委派 B（fixture pi 自动 BAS）→ 测试用 `toolContent` op 驱动 B 的 ask_user → 断言 answered 文本与 `details.redirected` → A 经 socket 收 q2 并 replyTo 回答 → B 的 final replyTo q1 `accepted`（原票据在问答后仍可用）+ 同一 q2 二次回复被拒；pair 间隔（fixture 5000ms，早期重发 ⇒ `rate_pair_interval` none 可断言）与 pair-wake 降级（fixture 默认 pairWakesPerHour 20，需先用一条 B→A wake 消息耗掉配额或加 `XW_LIMITS_JSON` 旋钮调小）。模拟边界（peer 宿主是 fixture 假 pi）已在 T11 文件头部的先例格式里。
2. **T11 not_woken/limit 两例**：根因与已试方案见上表；下一步建议直接在 hub `admitSend` 的 pair-interval 分支处打印 `now/lastAt/limits` 一次定位（怀疑 hub 侧 `limits.pairMinIntervalMs` 实际取值仍是 30000——bridge 重发 xs_member 的路径虽然对齐了 `memberLimits()`，但可能还有 `setSlot` 之外的发布路径未覆盖；或本地 FIFO 未按预期等待 6s——可在 `createXsAskRedirect` 的队首发送处加临时日志确认）。修好后把两例从 `it.todo` 还原。
3. **自验缺口**：按任务书补跑三测试各 3 次、`tests/conformance/fabric-xs.test.ts` 全量、三个 xs off golden、`tests/governance`、`tests/fabric`、`tests/ask-user`、`npm run typecheck`、`npm run build`、prettier 复检。
4. **#27 P1 分层门禁**：若 P1 先合入，需把三个新测试文件登记进其 tiers（本包未碰那些文件；由 root 处理）。

## 冻结面与边界核查

- `tests/fixtures/**` 零 diff；B1/B2/A 已提交文件未改（B1 的 `StackXs.askRedirect` 与 B2 的 `AskUserRedirectPort` 结构兼容，`src/index.ts` 无需类型桥接——typecheck 证明）。
- 未跑 secure 测试、未跑全量 `npm test`（遵任务书）；无 git 写操作。

---

## B3b（接手者）：T11 全绿

### 根因（产品缺陷，已修）

`rate_pair_interval` 来自 **本地 FIFO 的间隔计时起点不对**，不是 limits 数值/单位不一致（`pairMinIntervalMs` 经 `stack.ts:583` 取自 `config.limits`，与 hub `admitSend` 同值同单位 ms）。两处缺口，均在 `src/fabric/xs/ask-redirect.ts`：

1. `lastSentAt` 存在 per-token `TokenQueue` 上，而 `pump()` 在队列清空且无 in-flight 时 `queues.delete(token)`。同一 run 里第一问答完后，模型的下一轮才发第二问，新建的队列 `lastSentAt` 为空 ⇒ 立即发送 ⇒ hub 拒绝。
2. hub 的 `pair.lastAt` 在每次 **准入**（包括请求方的回复）时盖章：回复只跳过间隔 _检查_，不跳过 _盖章_（`limits.ts` admitSend 末尾 `p.lastAt = now`；pair 键对称）。所以间隔应从 `max(q2 发送, 请求方答复到达)` 起算，而本地只从 q2 发送起算。

### 修复

- 新增 `pairStamp: Map<token, number>`（队列删除后仍保留；>64 项时清掉已过期项；dispose 清空）。
- 在 q2 `onIssued` 与 `answered` 终态处盖章；`pump` 用它计算 `earliest`。
- 测试：`tests/fabric/xs-ask-redirect.test.ts` 把旧用例的预期从「+30s 发 #2」改为「+40s（答复在 +10s 起算）」，queue_window 用例同步调整，新增「队列清空后的后续 ask 仍等满间隔」用例（修复前红）。
- T11 文件：`it.todo` 还原为 `it`；`askResultTexts` 去重（每个 provider 请求都重放整段历史，原实现把同一结果重复计入，导致 `asks[1]`/长度断言误判）。断言未放宽。

### 最终结果

- T11 五例全绿，连跑 3 次（/tmp/b3b-t11-2.log、b3b-t11-r2.log、b3b-t11-r3.log，5/5 ×3）。
- wiring 3/3 ×3；C-X16 1/1 ×3。
- 指定门禁 vitest 命令：100 files / 1449 tests 全绿（/tmp/b3b-gate.log）。
- `npm run typecheck` 0、`npm run build` 0、prettier 改动文件通过、`git diff --quiet HEAD -- tests/fixtures/` 干净。
- 未跑 secure / 全量 npm test；无 git 写操作。

### 未完成：T12

`tests/integration/fabric-xs-ask-redirect.test.ts`（真实 hub 子进程）与 `XW_ROOT_RUN_MAX_S` 旋钮 **未做**（按任务书允许如实记未完成；T11 门禁已覆盖真实 session × 真实 stack × 进程内真实 relay）。子进程 harness 的 peer 是 fixture 假 pi，需要额外让其跑真实 activate + ask_user 接线，工作量较大；上一位的 T12 方案（本报告上文「未完成项 1」）仍有效。另：登记新测试到 tiers 的事归 #27 P1。
