# #21 包 B1（fabric 侧）实施报告

> 基线 `dev@e31968b1`（plan r3 探索基线为 `bfa16784`，其 corpus/pin 已含于 HEAD）。plan：`docs/dev/xs-ask-redirect/plan.md` r3 §1 D2–D9、§2.0、§2 包 B1、§3 T1/T3–T10（B1 部分）、§4。并行包 A（`src/tools/message-session-tool.ts`、`skills/agent-handoff/`）与 B2（`src/ask-user/**`）的工作区改动不属于本包，未触碰。

## 改动清单（全部文件，绝对路径）

| 文件                                                                                                                                             | 改动                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/wake-ledger.ts`                                                                                      | `XsWakeRecord` 追加 `askOrigin?` / `askUsed?`（D3/D4；`MutableFields` 自动可写；`put`/`release`/容量未动）                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/sender.ts`                                                                                           | `XsSenderMessageArgs.onIssued?`（§2.0 契约）；签票成功后、发帧前同一同步块内调用（try/catch 吞异常）。其余未动                                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/ask-redirect.ts`                                                                                     | **新文件（pi-free）**：§2.0 本地结构等价类型（含 root 增量 `answered.originRequestId`）、`classifyAskSend`（D7）、`createXsAskRedirect`（D2–D8）                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/src/fabric/settings.ts`                                                                                            | `FabricXsAskRedirectSettings` + bounds（timeoutS 60..3600、maxPerRun 1..2）+ parser + crossSession 字段/clone/默认值（默认开，D9）                                                                                                                     |
| `/home/bluecake/ai/pi-toolkit/src/fabric/setting-specs.ts`                                                                                       | 追加 `fabric.crossSession.askRedirect.enabled` bool spec（仅此一个，D9）                                                                                                                                                                               |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/stack.ts`                                                                                            | `StackXsInput.askRedirect?`、`StackXs.askRedirect?`；controller+replyLedger+leaf+input 四者齐备时于 Controller 构造后创建；`host.sendMessage` 在 `tapWritten` 后调 `observeWrite`（try/catch）；`dispose` 在 `controller?.dispose()` 前结算 `disposed` |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/activate.ts`                                                                                         | `askRedirectOn`（activate 冻结：xs ∧ reply ∧ wake ∧ leaf）；`stackInput()` 注入 `send/wakeHopAllowed/attached`                                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-ask-redirect.test.ts`                                                                              | **新**：37 测试（T1 栈级、T4–T10）                                                                                                                                                                                                                     |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-ask-redirect-origin.test.ts`                                                                       | **新**：22 测试（T3 伪造与歧义）                                                                                                                                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-sender-on-issued.test.ts`                                                                          | **新**：7 测试（T14 sender 半）                                                                                                                                                                                                                        |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-reply-ledger.test.ts`                                                                              | 仅源码扫描列表加入 `ask-redirect.ts`（plan 指定）                                                                                                                                                                                                      |
| `/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/settings-corpus.json`                                                                      | template 补 askRedirect 块 + 全量哈希刷新（见「corpus 迁移」，root 已同意）                                                                                                                                                                            |
| `/home/bluecake/ai/pi-toolkit/tests/config/__corpus__/setting-specs-pin.json`                                                                    | 追加 1 个 spec 哈希 + 重算 `all`                                                                                                                                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/tests/config/settings-fabric-xs.test.ts`、`settings-fabric-xs-alias.test.ts`、`fabric-activation-settings.test.ts` | 三处钉住 crossSession 设置面的既有断言按追加序最小更新（root 已同意；B 级声明式刷新，commit 正文说明）                                                                                                                                                 |

冻结面核验：`tests/fixtures/**` 对 HEAD 零 diff；`receiver.ts`、`reply-ledger.ts`（除测试扫描列表外）、`src/index.ts`、`src/ask-user/**`、`src/tools/**`、`skills/**` 未触碰；无 git 写操作。

## 实现要点与微观决策（plan 未逐字规定处）

- **O/U 判定顺序**（D2）：controller 缺席/非 `bound`/无 activeToken → 记录缺失/异会话/tombstone/`abortIssuedAt`/无 `authorizedAt`/`handed`/无 `askOrigin` 全部 O（同步返回 `undefined`）；之后依次 U 检查 `detached → origin_window/run_window → level_limit → limit → too_large`（render 前置且不预留，D8「不预留」），全部同步、任何 await 之前。
- **预留失败兜底**：`ledger.update(token,{askUsed})` 返回 undefined（记录在 get 与 update 之间被释放）⇒ 返回 U(`limit`)——run 已终态，显式文字比回落本地对话框安全。
- **两个绝对期限**（D5）：`waitUntil=min(t0+timeoutS·s, deadlineAt−60s, dueAt−60s)`；`<60s` ⇒ U（取先约束项，tie 归 run_window）。队首发送前重算 `q2TimeoutS=⌈剩余/1000⌉`，`<60` ⇒ U(`queue_window`)+退还。wait 回执后按 `onIssued.dueAt` 把宿主等待收紧到 `min(waitUntil, q2DueAt)` 并重挂计时器。
- **期限命中于 resolve 往返中**（sendStarted ∧ 未签票）：置 `deadlineHit` 并 `ctl.abort()`——sender 的 post-resolve guard 会因 signal aborted / `invocationLive()`=false 答 `none(origin_changed)`，不会发帧；continuation 侧 `deadlineHit ∧ 已签票 ⇒ timeout`（帧已出的罕见竞态兜底）。
- **仍在排队时期限到**（未发送）：U(`queue_window`)+退还（D4「从未发送」同类的退还面）。
- **per-token 串行**（D4）：FIFO 队 + `inFlight` 槽；队首须等上一问**终态**且距上次**发帧**（以 `onIssued` 时刻记）≥ `pairMinIntervalMs`；第 3 个并行调用在预留时即 `limit`。`wait` 结果的调用保持 inFlight（token 串行直到终态）。
- **classify 补充分类**：`deps.send` 返回 `undefined`（无 sender）或同步抛出 ⇒ `send_none:no_sender` / `send_none:send_threw` + 退还（适配器在端口往返前可证未发帧）；`send_none:<reason ?? code ?? status>`（D7 原文顺序）。
- **attempt 字段**：所有 U 结果都带 `attempt`（被拒的下一序号）；`requestId` 仅在已签票时携带。
- **D8 文本**：首行 `[ask_user→requester] attempt n/2 · origin <id>` + plan 原文中文说明；预算 = `maxChars − (首行+说明+4)`，code-point 计长；render 返回 `undefined` ⇒ `too_large` 不发送不预留。
- **D3 tap**：`xsWake:true ∧ wakeToken:string ∧ activateFor:undefined ∧ reply:object`，全量核对 rec（存在/本会话/xid/live/askOrigin 未写）+ `controller.activeToken` + from/requestId(RE)/dueAt(有限数)。答复帧（`inReplyTo`、无 `reply`）天然不会撞上捕获分支——回复唤醒的 run 保持 O 类（栈级测试钉住）。NoticeGate 静默写出口 customType 为 `subagent:xs-reply`，结构上不可能命中。
- **计时器**：全部经注入 `Clock`（生产 `systemClock`：分段 + unref，I1/I5），span 经 `clampSpanMs`。

## root 增量（2026-11-05 steer）

`answered` 新增必填 `originRequestId`（= ledger `askOrigin.requestId`，原委派 replyTo）；各变体 `requestId` 一律为本次 q2。本地类型与 `ask()` 构造已同步；单测断言 answered 同时带 `requestId=q2` 与 `originRequestId=原委派 id`（两处：单元 + 栈级真实链路）。

## corpus / pin 迁移（§4，root 已同意）

- 基线 dump（改码前）与改后 dump 各 1331 个输出（`GOV_CORPUS_DUMP`），逐输出脚本比对（剥去 `settings.fabric.crossSession.askRedirect` 后 JSON 全等 + 新增块恰为 `{enabled:true,timeoutS:600,maxPerRun:2}`）：**1331/1331 全部且仅差该块**（含 DEFAULT_SETTINGS；脚本对 defaults.txt 单独校验，其余 1330 个走 `{settings,warns,files}` 包装结构）。比对脚本输出：`files=1331 differing=1331 identical=0 failures=0`。
- template 按先例 `eab22312`（autoFromCwd）外科手术式补块——`settings-corpus.test.ts` 的 `stripRetired(template)===DEFAULT_SETTINGS` 断言要求 template 跟踪默认值，不改则套件恒红（测试文件不在本包文件域）。template 补块后重 dump，`captured-*`/`defaults` 与补块前逐字节一致（template 无关性双向验证）；`random/block` 因生成输入流随 template 偏移而整体重算（与先例一致）。
- `captured` 输入、`timePaths`、`seed/randomCount/blocksPerKey`、`baseline` 一律未动；`GOV_CORPUS_GENERATE` 未使用。
- pin：追加 `fabric.crossSession.askRedirect.enabled` 一个哈希（恰在 `activation.enabled` 之后，fabric shard 末尾）+ 重算 `all`；diff 仅 3 行（1 spec + `all` 新旧）。

## 自验（定向命令，真实输出摘录）

| 命令                                                                                                                                                                                                                       | 结果                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npx vitest run tests/fabric`                                                                                                                                                                                              | `Test Files 66 passed (66)` / `Tests 1090 passed (1090)`         |
| `npx vitest run tests/config`                                                                                                                                                                                              | `Test Files 50 passed (50)` / `Tests 689 passed (689)`           |
| `npx vitest run tests/governance tests/boundary tests/web-hub/boundary.test.ts`                                                                                                                                            | `Test Files 5 passed (5)` / `Tests 86 passed (86)`               |
| `npx vitest run tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-xs-activate-session.test.ts` | `Test Files 4 passed (4)` / `Tests 20 passed (20)`               |
| `npx vitest run tests/conformance/fabric-xs.test.ts`（真实 pi）                                                                                                                                                            | `Test Files 1 passed (1)` / `Tests 27 passed (27)`（C-X1…C-X15） |
| 合并重跑 `tests/fabric tests/config tests/governance tests/boundary tests/web-hub/boundary.test.ts`                                                                                                                        | `Test Files 121 passed (121)` / `Tests 1865 passed (1865)`       |
| `npx prettier --check`（16 个改动/新建文件）                                                                                                                                                                               | `All matched files use Prettier code style!`                     |
| `npx tsc -p tsconfig.build.json --noEmit`                                                                                                                                                                                  | 本包文件 0 错误（全仓亦 0 错误；并行包当前无半成品错误）         |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                                                                                                                 | 零 diff（A 级 fixture 未动）                                     |

新增测试：`xs-ask-redirect.test.ts` 37、`xs-ask-redirect-origin.test.ts` 22、`xs-sender-on-issued.test.ts` 7。

栈级 E2E（`xs-ask-redirect.test.ts` 末 describe）：真实 `buildStackXs` × 真实 Controller dispatch（askOrigin 捕获于真实 wake ledger）× 真实 BAS 绑定 × 真实 receiver 答复分类（solicited、busy 降级、deliver-only 写出 `inReplyTo`）× tap 解开等待——`answered{requestId:q2, originRequestId:q1}`，`askUsed=1`。T1 半项：leaf off / 未接线 ⇒ `stack.askRedirect` 为 undefined。

## 遗留 / 交接 B3

- B3 接线点已备好：`XsActivation.askRedirectOn` + `StackXs.askRedirect`（结构即 §2.0 `AskUserRedirectPort`）；`src/index.ts` 只需 `xs.askRedirectOn` 时传 `redirect: () => holder.current?.xs?.askRedirect`。
- D8 结果文本渲染、`details.redirected`、`renderResult` 属 B2；hub 子进程 harness 旋钮与 C-X16 属 B3。
- T5/T6 中 pair 间隔知识随 stack 生命周期（reload 后队列丢失）；hub 侧 `rate_pair_interval` 拒绝会以 `send_none:rate_pair_interval` U 文本兜底（D7 路径），已按设计接受。
- `docs/dev/test-speed/`（工作区未跟踪目录）非本包产物，未处理。
