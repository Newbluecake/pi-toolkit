# Thread 订阅直通（fabric-thread）— 实施要点

> 何时读：动 `src/fabric/thread/**`、`src/tools/thread-{tool,child-tool}.ts`、`src/commands/thread.ts`、
> `src/web-hub/protocol/thread.ts`（wire 契约）、`src/web-hub/hub/feishu/thread-hub.ts`、
> `src/web-hub/agent/commands.ts` 的 §6.1 路由步、`src/stack.ts` 的 thread 面或
> `tests/integration/fabric-thread-e2e.test.ts` 之前。
> 设计全文：`docs/dev/fabric-thread/arch.md`（r3，实施依据；本 README 只记实施后的不变式与测试索引）。

## 这是什么

飞书群话题里的后续事件，有订阅者时**不触发主会话 LLM 回合**：hub 在 cmd.prompt 上附 `cmd.thread`
（`{h,label,sentAt,bypass?}`），agent 侧在 mention 之后、topic-switch 之前做一次**同步判定**
（`src/web-hub/agent/commands.ts` §6.1 步），确认有 live 订阅者才入 lane 扇出
（`QueryService.steerThread` → `RuntimeRunner.steerThreadRun`，有界且保留 disposition）。
订阅随 run 生命周期（终态即解除），Worker 可退订或 handback（交回主会话，hub 是唯一权威）。

- 收益（P4 验收实测，`tests/integration/fabric-thread-e2e.test.ts` S1/S1′）：同一剧本
  开功能主会话**事件回合 = 0**（硬断言），关功能 = 每事件 1 回合；事件封装只进 Worker。
- 默认**关闭**（`fabric.threads.enabled=false`）；关闭态一切面缺席 = 逐字节一致
  （A 类 golden `tests/fixtures/thread-off-golden.json`，永不重生）。

## 分期落地（已全部合入 dev）

| 包  | 内容                                                                                                                                                  | 主要落点                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | 设置键、§7 wire 契约、窗口 clamp 纯函数、off golden                                                                                                   | `src/fabric/{settings,setting-specs}.ts`、`src/web-hub/protocol/thread.ts`                                                                                                            |
| P1  | agent 纯逻辑：ThreadDirectory、订阅状态机、lane、per-run 串行、EventRecord、Outcome 聚合、决策表 R0–R7                                                | `src/fabric/thread/**`（pi-free）                                                                                                                                                     |
| P2  | hub：routed 保留（`accepted{thr:routed}`）、`requests.handback`（§8.3 确定性 id + 持久化屏障）、thr_req/res/thr_closed、/main、回执、撤权/解绑终结    | `src/web-hub/hub/feishu/{thread-hub,requests,runs,service}.ts`                                                                                                                        |
| P3  | agent 接线：`steerThreadRun`、onSnapshot 挂点（首次 running 冲刷缓冲）、teardown 三路、§6.1 路由步、hello cap、主/子会话两个 `thread` 工具、`/thread` | `src/stack.ts`、`src/web-hub/agent/**`、`src/runtime/{runner,session-driver}.ts`、`src/service/{query-service,runtime-adapter}.ts`、`src/tools/thread-*.ts`、`src/commands/thread.ts` |
| P4  | E2E 验收 + 两个 minor 接线（`/agent status` thread 行、REVOKED display）+ 本 README                                                                   | `tests/integration/fabric-thread-e2e.test.ts`、`src/commands/status.ts`                                                                                                               |

## 不变式（改代码前对照）

1. **G2a 关闭态逐字节一致**：`fabric.threads.enabled=false`（或 fabric 关/secure 域）⇒ 工具、
   提示、hook、hello caps、hub 配置、帧、持久状态全部不变（`tests/integration/thread-off-golden.test.ts`）。
   D8：secure/locked 域强制关闭（`src/config/settings.ts`，I11）。
2. **G2b 一端缺 cap**：业务帧（cmd/cmd_result/status/ctl）逐字节一致，唯一差异是新端 hello caps
   的 `thr.v1`；`cmd.thread` 只在双端 cap 成立时附加（closed schema，旧端会丢帧）。
3. **安全回落集合 = {none}**（§6.4，r3-3）：`queued` 只证明「已转交」；`handled` ⇒ `unknown`。
   调用过 pi 之后的任何结果都**不**回落、**不**自动回流。自动回流仅当全部订阅者
   在调用前确定 `none`（§6.7）。
4. **绝对截止**（r3-4）：`deadlineAt = 到达 + clampSpanMs(min(steerTimeoutMs, frameDeadlineMs−1500))`；
   span 无效或 <500ms ⇒ R6 原生且 **steer 调用次数 = 0**。lane 等待、per-run 等待、steer 共用预算；
   截止 timer 一律 unref。冲刷（flush）无帧截止，单次上限 `steerTimeoutMs`。
5. **handback 幂等**（r3-2）：hub 侧「先认后继、再验源」+ `await commit()` 持久化屏障后才回
   `dup`；确定性 id ⇒ 每事件至多一个后继。agent 侧准入只有三条本地规则（§5.5 #1），
   原文是否保留**只由 hub 裁决**。
6. **结果竞争**（r3-5）：thread 候选 tracker 在结果返回前遇到 gap/epoch/session 变化不立即
   finish；routed 分支在内存迁移**之前**同步 `runs.detach(id)`；`finishRun` 跳过 `accepted{thr:}`。
7. **保留预算**（§8.2）：H/S/R 窗口参数用 `clampThreadWindowParams`（agent/hub 同一纯函数），
   clamp ⇒ 每字段一行 WARN + `/agent status` thread 行追加 ` · cfg clamped`
   （解析记号 `FabricThreadSettings.windowClamped`）。保留 ≤32 条 / 512 KiB。
8. **不新增持久形状**（§8.4）：第一期不新增请求状态、顶层键、字段或 ID 形状；
   `REQUEST_STATES`/`TOP_KEYS`/`FEISHU_CMD_ID_RE` 由 T-state pin 钉死；旧 hub 可解析（多余的
   unattributed 提示 ≤32 条，已接受残余）。
9. **teardown**：三条路径（A rebuild-handoff / B defensive / C4 shutdown）threads 都在
   fabric（mailbox）之前 dispose（§9.4；`tests/integration/stack-teardown-matrix.test.ts`）。
   dispose 期间终结的 run 不触发自动回流；晚到 steer 结果因代际令牌失效而丢弃。
10. **显示面**：routed 事件 / 未送达通知 / REVOKED 交回各写一条 `subagent:thread` **display**
    entry（不进上下文）；handback 降级（GONE/REBOUND）发 finding（进上下文、唤醒）；
    REVOKED **不发** finding（撤权内容不再传播）。
11. **Runner 透传**：`runtime-adapter` 必须暴露 `steerThreadRun`/`hasActiveSession`
    （`service/ports.ts` Runner 可选成员；P4 E2E 抓到过缺失导致 cast 调 undefined 的真 bug）。
12. **I4/I5**：订阅表/lane/EventRecord 归 stack 实例（无模块级可变状态）；所有 timer unref。

## 关键接线坐标

- 主会话工具 `/thread`（status/drop/sub）+ 模型工具 `thread{list,subscribe,unsubscribe}`：
  post-guard、`threadsOn` 门控（`src/index.ts`）；子会话 `thread{list,reply,unsubscribe,handback}`
  是**宿主闭包**经 `customTools` 注入（`service/runtime-adapter.ts`），`extraReserved:["thread"]`
  每 run 剥离未授权同名工具（§9.2；`RESERVED_TOOL_NAMES` 不变）。
- origin 口径（已拍板）：最近 10 分钟送达主会话的飞书 thread 恰好 1 个 ⇒ 成功；0/多个 ⇒ `no_origin`/
  `ambiguous_origin` 自纠。事件封装为**事件级单文本**（§9.1，含句柄 `h`、共订阅者、scope、不可信标注）。
- `/agent status` thread 行：`thread subs n · routed a · slow b · handback c · unknown d[ · cfg clamped]`
  （`src/commands/status.ts` 的 `threads` dep ← `holder.current?.threads?.statusLine()`）。
- hub cap：`HubConfig.feishuBot.threads`（窗口/回帖限额，**clamp 后**的值）；agent cap：hello
  `thr.v1`（`threadsCapOn`，activate 级，不随栈重建漂移）。

## 测试索引

| 层        | 文件                                                                                                                                    | 钉住                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A golden  | `tests/integration/thread-off-golden.test.ts` + `tests/fixtures/thread-off-golden.json`                                                 | 关闭态工具表/保留名/hello/槽帧/HubConfig 逐字节（**永不重生**）                                                                 |
| P1 单元   | `tests/fabric/thread/**`（engine.property/decision/lane/buffer/records/…）                                                              | 状态机、决策表顺序（R1→R6）、去重、至多一次回流、deadline 计算                                                                  |
| 设置      | `tests/fabric/threads-settings.test.ts`                                                                                                 | 六组窗口 clamp 组合、WARN 行、`windowClamped`、hub≡agent clamp                                                                  |
| P2 单元   | `tests/web-hub/hub/feishu/thread-{hub,requests,runs,service,state}.test.ts`                                                             | routed 分支、S4b–S4d 幂等、S9 gap 竞争、S10 detach、T-state pin、/main、回执                                                    |
| P3 接线   | `tests/integration/stack-teardown-matrix.test.ts`、`tests/tools/thread-tools.test.ts`、`tests/web-hub/agent/**`（wiring/commands 系列） | 三路 dispose 顺序、子工具降级表（含 REVOKED 的 display-only）                                                                   |
| P4 E2E    | `tests/integration/fabric-thread-e2e.test.ts`                                                                                           | 真 hub 子进程 × fake 飞书 × 真 stack × 真 wireWebHub：S1/S1′/S2/S3/S3b/S4/S4b③/S5/S6/S7a-c/S9/S11/S12（见文件头注释的覆盖矩阵） |
| status 行 | `tests/commands/status-thread.test.ts`                                                                                                  | `/agent status` thread 行缺席⇔字节一致                                                                                          |

### P4 E2E 的已知边界（如实记录）

- **hub 内部故障竞争**（S4b①②④ commit 失败/撤权、S9 的 routed/plain-ok/fallback × gap、S10 慢
  commit、S2 保留期外 GONE）需要 hub 进程内注错，留在 P2 单元（thread-requests/thread-runs）。
  E2S S9 只钉真线可验的部分：gap ⇒ 候选落 **uncertain**（而非提前 unattributed）、
  该回执按既有规则发给 uncertain 候选、agent 重连 + 重新 /use 恢复。
- **S12 短 deadline**：生产接线把 admission `deadlineMs` 硬编码 8000（`service.ts` 不透传），
  真线造不出 1500/1900 的帧；E2E 经同一 `ThreadPromptPort.handleEvent`（与 live 命令处理器
  同一入口）合成帧断言 R6 原生 + steer 调用 = 0。
- **测试内双 hub**：同一测试里 stop 掉第一个 hub 子进程后，下一个 hub 的 fake 飞书不再摄入
  prompt（未定因，疑似机器级共享 seam）；S7 因此拆成 S7a/S7b/S7c 三个单 hub 测试。
- 真机（token/完成时长）对比是 live-acceptance 项，不在 CI E2E 内。

## 话题换绑（rebind，rebind-plan r3）

> 设计全文：`docs/dev/fabric-thread/rebind-plan.md`（r3）。分期：P0a/P0b = 地基（共享写操作
> `bindings-transfer.ts`、wire/cap/设置门、off golden，3ef29397）；P1 = hub 侧业务逻辑（本行）；
> P2 = agent 侧工具/目录（未做）。

P1 落点与不变式：

- `thread-hub.ts` 的 `thr_req{op:"rebind"/"acquire"}` 两支自门控于 `feishuBot.threads.rebind`
  （off ⇒ `E_THR_STATE`，逐字节不变由 `thread-rebind-off-golden.json` 钉住）。rebind 顺序：
  dedup（`h\0sessionId\0to\0fromRev`，LRU 128；pending⇒`E_THR_PENDING`，done⇒回放原回执并
  重盖当前 rid）→ 权益（`binding.sessionId===frame.sessionId`）→ CAS（`fromRev===binding.rev`）→
  §4.6 阶梯（`session-selector.ts`，唯一解析口径）→ 限速（按 h 3/min+20/h，独立桶 LRU64，
  仅过校验的尝试计数；被限流的尝试**不**入 done 缓存）→ `transfer(notifyLifecycle:true)`。
  acquire 是只读探针： holder 回 `{owned:true,label,rev}`，其余一律 `E_THR_NO_OWNER`，不限速不去重。
- `requests.closedByRebind(id)`（§4.10）：代际失配的合法终结链 `dispatching/uncertain→accepted→
replied{thread-closed}`（`accepted{thr:routed}` 从第 3 步进），detachRun 先行、不 emit、
  commit 失败走既有 park 重试。三个调用点：dispatch 的 routed 分支复核、lateRouted 复核、
  armRetention 到期复核（经 service.ts 的迟绑定 seam）。
- 验收：`tests/web-hub/hub/feishu/thread-rebind.test.ts`（A1/A2/A4/A5/A6/A7/A7b/A8/A11c/A14/A15/A19
  - off 门）、`session-selector.test.ts`、`thread-requests.test.ts` 的 A11/A11b。

## 残余风险 / 第二期入口

- 飞书 `@label` 显式寻址、`run:` Thread、休眠订阅、自动订阅策略（arch §11.2）。
- Worker 已部分执行副作用后 handback（已接受残余，工具描述要求「交回前不执行副作用」）。
- hub 重启丢失 post 去重记录 ⇒ 回帖可能重复（已接受残余，§7.3）。
