# #30 P-C 交付报告 · 闭环与文档

依据 `docs/dev/reload-result/plan.md`（r3）§2「P-C」、§3 归属 P-C 的验收行（C1、C2）、§4 P-C 门禁。前置：P-A（`204da159`，agent 与协议）、P-U（`10e58a53`，前端）均已合入；本包零 `src/**` 改动、零 `tests/fixtures/**` 改动（逐路径核验），只写测试与文档。

## 1. 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/reload-status-passthrough.test.ts`（新建，4 用例）— **C1**：真实 agent-server（unix socket，`connectClient` 发 NDJSON）→ `decodeAgentFrame` 开放 decoder → registry 原样存储 → HTTP/SSE 广播 + **#88 订阅定向补发**。断言：`reload` 逐字节原样通过（SSE 原文包含 agent 所写对象的精确序列化，键序不变）；补发携带**最新**保留 status（rev 2 胜 rev 1）且不入 replay ring（无 id）；过期撤销（无 `reload` 字段的后续 status）后**新订阅者**的定向补发无残影（该客户端全文不含 `"reload":`）；未来 agent 的未知载荷（`v:99` 奇形）同样原样转发（hub 不解析开放槽）。
- `/home/bluecake/ai/pi-toolkit/tests/integration/web-hub-reload-result-loop.test.ts`（新建，**5 用例**，integration 目录自动 tier2）— **C2**：真实 `wireWebHub` 组合（wrapCommandApi + DeferredReloadController + reload command port + `/agent` status command）经**真实 agent-server socket** → 真实 registry → 真实 HTTP/SSE → 未修改的 `reduce` + 真实 `useOutdatedReload`。**第二个 activation 是真实的**：`vi.resetModules()` + 动态重导入重演 /reload 的模块重求值 ⇒ `connection.ts` 的 `MODULE_INSTANCE` 刷新 ⇒ `acquireConnection` 对旧连接 `bye{handover}`（claim window，非 down）⇒ 新 hello 带新 epoch ⇒ registry **reclaim**（agent_up + gap）；reload-track 的 `Symbol.for` store 天然跨重求值存活——started 事实与接管标记在新 activation 的 `session_start{reload}` 验证后变 completed，随新连接 hello_ack 的槽重放回到 UI。
  - **正例**：deferred→parked（`waitingFor:"runs"`）→started→接管（epoch 变化、走 reclaim、无 agent_down）→completed（`version`=repo 版本 = hub 版本、`epoch`=接管方实例、`cmdIds` 含 UI 生成的命令帧 id、`open:false`）→**done，早于 90s**（90s 生效计时从未触发，succeed 后仅剩 4s toast）。隔离证据：两个 activation 的 buildInfo 都报 `0.0.1`，卡片全程 outdated，done **只能**来自 completed 事实的版本比对（Q2 相等分支），不是 #23 的版本到位。
  - **对照组**（去掉字段的老 agent）：port 的 phase sink 不接 ⇒ wire 上从未出现 `status.reload`（全部 status 事件 + SSE 全文断言）；reload 照常发生，接管报新版本 ⇒ UI 走 #23 的版本到位路径收敛 done——与 `web-hub-outdated-reload-loop.test.ts` 钉住的结果一致（该文件本包只读复跑，通过）。
  - **U7 跨层（验收追加）**：hub 版本固定为 `9.9.9`（≠ completed.version = repo 版本）⇒ completed 到达即判 `E_RELOAD_NO_UPGRADE`（立即失败、计时器全清、不重发不 cancel，不等版本到位）。
  - **Q3 跨层（验收追加）**：请求 park 后按 D5 进程内接口改写 tracker store 注入 `failed{E_RELOAD_IDLE_WAIT, open:true}`（同一真实 life/cmdIds，rev+1），由真实 wiring 的 1s onTick 探测投影变化后经真实 socket→registry→SSE 发出 ⇒ UI **立即失败且当下不 cancel**；用 fake timer 推进到总截止（30min）⇒ **恰好一次** `reload cancel`（真实 /api/cmd 链路，后端真的收到并回出 `cancelled{user, open:false}`，最终原因保持 IDLE_WAIT 不被细化/改写，重复触发同截止不重发）。
  - **U6 跨层（验收追加）**：started 后目标退出（`bye{test-teardown}`+close ⇒ registry 立即 down ⇒ agent_down）⇒ UI 判 **`E_RELOAD_LOST`**（已启动但新模块未接管，计时器全清）；随后同 key 新 activation（重演模块求值 + 全新连接，接管标记在 store 存活）发来匹配的 completed ⇒ **复活 done**（Q4 允许的唯一复活路径），全程不重发不 cancel。
- `/home/bluecake/ai/pi-toolkit/tests/tiers.ts` — 仅一行登记（按 `:196` epoch-up-compat 先例）：passthrough 命中 `.listen(`/`createServer(` 词法标记，登记为 `TIER1_DECLARED` `kind:"proc"`（`tests/integration/` 下的 loop 测试自动 tier2，无需登记）。
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub/README.md` — 目录加一行 + 新增「Reload 结果回传 `status.reload`（#30）」一节：wire 字段与 `state`/`open` 之分、状态与原因码全集、采集点与 **TUI 发起不回传**（Q1 归属规则）、接管标记验证（D4）、store/TTL/1Hz 撤销、UI 吸收规则（cmdId+rev 去重、failed 不复活、IDLE_WAIT/绝对截止）、**老 agent/老 hub 兼容**（无字段 ⇒ #23 行为；开放槽原样转发；off/TUI 帧序列逐字节不变 + compat golden）、门禁与设计文档索引。
- 本报告。

## 2. 验收对照（P-C 行）

| 行  | 覆盖                                                                                                       | 位置                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| C1  | `reload` 原样通过（decoder→registry→SSE）；#88 补发取最新、无 id；过期撤销后重订阅无残影；未知载荷开放转发 | reload-status-passthrough（4 用例）         |
| C2  | 正例全链按期望结算、早于 90s、epoch 变化走 reclaim；对照组去掉字段与 #23 结果一致且帧序列无新字段          | web-hub-reload-result-loop（正例 + 对照组） |
| U7  | 跨层：completed 版本 ≠ hub ⇒ 立即 `E_RELOAD_NO_UPGRADE`（不等版本到位）                                    | web-hub-reload-result-loop（验收追加）      |
| Q3  | 跨层：IDLE_WAIT 立即失败不 cancel；总截止恰好一次 cancel，后端真收到（cancelled{user} 回帧）               | web-hub-reload-result-loop（验收追加）      |
| U6  | 跨层：started 后下线 ⇒ `E_RELOAD_LOST`；同 key 迟到 completed ⇒ 复活 done（Q4）                            | web-hub-reload-result-loop（验收追加）      |
| nit | passthrough 的「TTL retraction」用例标题/注释写明模拟的是 P-A onTick 撤销后的 wire 形态，非端到端 TTL      | reload-status-passthrough                   |

另按 plan §3 备注：P-A 报告残留 2/3（completed 帧在真实第二 activation 的线上时机、真实 socket 上 shutdown 前 started 落 wire）由本包闭环覆盖——正例里 `started` 与 `completed` 都以真实 socket→SSE 原文断言（`'"state":"started"'` / completed 事件逐字段）。

## 3. 自验命令与真实输出

门禁（plan §4 P-C，含治理与 #23 只读复跑）：

```
npx vitest run tests/web-hub/hub tests/governance/test-tiers.test.ts \
  tests/integration/test-tiers-actual.test.ts \
  tests/integration/web-hub-reload-result-loop.test.ts \
  tests/integration/web-hub-outdated-reload-loop.test.ts
 Test Files  245 passed (245)
      Tests  5569 passed (5569)
exit=0（无 Unhandled/Uncaught；日志 /tmp/pc-gate1.log）
```

新闭环测试连跑 3 次（格式化后最终代码）：

```
for i in 1 2 3: npx vitest run tests/integration/web-hub-reload-result-loop.test.ts
 Tests  2 passed (2)   × 3（/tmp/pc-c2-stable-{1,2,3}.log，343ms 级，稳定）
```

验收追加后（5 用例）连跑 3 次：

```
for i in 1 2 3; do timeout 600 npx vitest run tests/integration/web-hub-reload-result-loop.test.ts > /tmp/pc2-loop-$i.log 2>&1; echo "run $i exit=$?"; done
run 1 exit=0 / run 2 exit=0 / run 3 exit=0
 Tests  5 passed (5) × 3（/tmp/pc2-loop-{1,2,3}.log）
```

`npx vitest run tests/web-hub/hub/reload-status-passthrough.test.ts`：`Test Files 1 passed (1) / Tests 4 passed (4)`（/tmp/pc2-passthrough.log）。

`npm run typecheck`（TS7 ×2 + vue-tsc）：`exit=0`，无输出错误（/tmp/pc-typecheck.log；验收追加后复跑 /tmp/pc2-typecheck.log 同绿）。

`npx prettier --check`（4 个改动文件）：`All matched files use Prettier code style!` exit=0（先 --write 过一次）。

`git diff --quiet HEAD -- tests/fixtures/`：**DIRTY，但全部来自并行包**（见 §5-1）：`fabric-wake-off-golden.json`、`fabric-xs-off-golden.json`、`message-agent-wake-schema-golden.json` 各一行 `message_agent` kind 枚举 `finding`→`report`，是 fabric-kind-rename 包的工作树改动。本包对 `tests/fixtures/` 的改动经逐路径 `git status` 核验为 **0**；已用 `message_agent`（kind:finding，r_588002AG）向 root 报备。未跑全量与 secure。

## 4. 实现要点 / 取舍

1. **真实第二 activation 的获得方式**：进程内 `MODULE_INSTANCE` 是模块级常量，两个 `wireWebHub` 实例同 epoch ⇒ registry 静默重连（非 reclaim）。用 `vi.resetModules()` + 动态 `import()` 重演 /reload 的模块重求值：新 `MODULE_INSTANCE` ⇒ `acquireConnection` 走 implVersion 不匹配分支（旧连接 `bye{handover}` 关闭、同 agentId 新 epoch 连接）——与生产 /reload 的接管路径逐帧一致；`Symbol.for` 的 reload-track store 与 agent-id 全局天然跨重求值共享（I7/D5 的设计本意）。静态导入的 hub/UI 模块不受影响（绑定不随 reset 变）。验收追加后此法同时支撑 U6：down 之后同一机制再起一个「新进程形状」的同 key activation。
2. **`fleet` dep 必须传 `[]`**：RunSnapshot 形状缺失会让 `projectFleet`（1s tick）与 `readStatus` 抛未捕获异常（`escalation`/`diag.usage`）。park 条件用 status command 自己的 `query.list()`（与 wiring-reload-status.test.ts 同法），UI 侧由 deferred 事实进 parked（即 U3 的「事实先于 fleet 启发式」顺序），不依赖 fleet 帧。
3. **UI harness 的 pump**：SSE 事件由测试手动喂 reduce，所有相位等待用 `pumpUntil`（轮询里持续 pump），否则等待会死锁在自己的事件源上。
4. **done 的判定隔离**：hub 版本 = repo `packageVersionSync()` 值，activation buildInfo 恒 `0.0.1` ⇒ 卡片永不版本到位，done 只能来自 completed 事实（正例）；对照组反向（buildInfo = repo 版本、无字段）⇒ done 只能来自版本到位。两条路径互证。U7 追加用第三种 hub 版本（`9.9.9`）钉 Q2 的不等分支。**Q3 的注入点**是 D5 的进程内 store 接口：保留真实链路写下的 life/cmdIds/execId，仅改写事实本身（state/code/open、rev+1），发出仍走真实 wiring 的 1s onTick→publishStatus→socket→SSE；「到总截止」用 UI 侧 fake timer（`fireTimers(1_800_000)`）推进，cancel 走真实 `/api/cmd`，后端回出真实的 `cancelled{user, open:false}` 帧。
5. C1 的逐字节断言依赖 hub 对开放槽的存储/转发不改键序（`registry.onFrame` 解构 + SSE `JSON.stringify`）——正是「hub 零解析」要钉的行为。

## 5. 遗留问题 / 范围外发现

1. **并行包的 fixture 改动混入工作树**（范围外，未动）：见 §3。三份 golden 属 A/B 级冻结面，`finding`→`report` 是否为该包声明的行为变更由其报告与 root 裁定；合流时 `git diff --stat origin/dev -- tests/fixtures/` 的核对会把它们算进该包。
2. **P-A 报告残留 5**（fire-idle/capture-commands 两文件未按清单追加用例）本包未处理——属 P-A 范围，plan §2 的 P-C 清单不含它们。
3. 闭环正例覆盖「fleet 忙→settle→接管」主路径；验收追加（U7/Q3/U6 跨层）后，#23/#30 交叉时序里剩下的跨层缺口是「同一 tick 内 IDLE_WAIT 与总截止竞争的两种处理顺序」（U5 的跨层版）——UI 侧两种顺序已由 P-U 单测钉住，如评审仍要求跨层版可按同一 harness（注入 IDLE_WAIT 后同时把 hub.clock 推到截止再 fire）追加。
