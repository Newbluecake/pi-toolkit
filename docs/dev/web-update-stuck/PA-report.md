# #23 P-A（前端）交付报告

> 实施依据：`docs/dev/web-update-stuck/plan.md`（r3）§2.1 D1–D11、§3 P-A；根因坐标见 `explore.md`。
> 分支 dev，与 P-B（hub）同树并行。自验时间 2026-11-05 12:12–12:15（Asia/Shanghai）。

## 1 改动文件（全部在 P-A:ui 文件域内）

| 文件                                                             | 改动                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/outdatedReload.ts`                     | D1/D2/D3/D5/D6 + `orFailReason`（D9）：绝对截止时间与总预算计时器、`settleExpired` 相→错误码映射、入口截止检查、`OR_SEND_TIMEOUT_MS`、attempt token、notifyTick 先 settled 后 offline、头注/相语义注释同步 |
| `src/web-hub/ui/src/composables/useOutdatedReload.ts`            | D4：导出 `agentOffline`（precheck 与协调器 offline deps 共用）；deps 注入 `now`/`offline`；watch 签名每 agent 段追加 `:${offline?1:0}`                                                                     |
| `src/web-hub/ui/src/i18n/zh/outdated.ts` / `en/outdated.ts`      | D10：`errOffline` 改写、新增 `errSendUnknown`/`chipFailed`/`chipFailedTitle`/`resultPre`（zh/en 键集合一致，i18n-parity 钉住）                                                                             |
| `src/web-hub/ui/src/components/agents/AgentCard.vue`             | D9②：chip failed 态（danger 配色、`alert` 图标、`chipFailed` 文案、title/aria-label=`chipFailedTitle`，点击仍 `request`）；compact/detailed 两处                                                           |
| `src/web-hub/ui/src/components/agents/OutdatedSummaryBanner.vue` | D9③：失败行显示 `orFailReason` 人读原因，错误码进 `title`                                                                                                                                                  |
| `src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue`  | D9①：失败原因改用 `orFailReason`（删本地 switch）                                                                                                                                                          |
| `src/web-hub/ui/src/components/detail/OutdatedReloadResult.vue`  | D9④ 新组件：failed/done 各渲染一行结果，挂空态                                                                                                                                                             |
| `src/web-hub/ui/src/components/shell/DashboardView.vue`          | 「已删除」「未连接」空态（宽屏 2 + 窄屏 2，共 4 处）`#actions` 插槽加结果行（紧邻「返回列表」）；useOutdatedReload 注入 `now: () => Date.now()`                                                            |
| `tests/web-hub/ui/outdated-reload.test.ts`                       | 扩展：预算（假时钟）、sending 上界、ABA、下线、orFailReason（40 用例）                                                                                                                                     |
| `tests/web-hub/ui/outdated-reload-loop.test.ts`                  | 新建：真实 `reduce` + 真实 composable 全链路（7 用例）                                                                                                                                                     |
| `tests/web-hub/ui/outdated-reload-surfaces.test.ts`              | 新建：chip/汇总/横幅/结果行 DOM 级断言（11 用例）                                                                                                                                                          |
| `tests/web-hub/ui/dashboard-view.test.ts`                        | 扩展：4 处空态结果行 + 无 entry 回归（34 用例）                                                                                                                                                            |

冻结面未动：`tests/fixtures/**`（A 级 golden）、`ui/src/logic/{state,control,token-client,password-client}.js`、`useHub.ts`、hub/protocol、文件域外 `.vue`、`docs/dev/web-hub/README.md`。未做任何 git 写操作。

## 2 决策落实对照

- **D1 总预算**：`request()` 记 `deadlineAt = now() + OR_QUEUE_TIMEOUT_MS`；总计时器只在 request 设置（`armQueueCap`→`remainingMs`），阶段切换不清除，fail/succeed/reset/cancelQueue 清除（`deadlines.delete`）。回调 `settleExpired` 结算所有在飞阶段（queued⇒`E_QUEUE_TIMEOUT`；parked⇒先 `sendCancel` 再 `E_QUEUE_TIMEOUT`；awaiting⇒`E_TIMEOUT`；sending⇒`E_SEND_UNKNOWN`）。`enterAwaiting`/`enterParked`/`send` 入口先 `expired()` 检查（后台标签页计时器延迟兜底）；生效计时 `min(OR_EFFECT_TIMEOUT_MS, deadlineAt-now())`。
- **D2 sending 上界**：`OR_SEND_TIMEOUT_MS = 60_000`，测试钉住 `> 2×CMD_REQUEST_TIMEOUT_MS`（16s）。超时 `E_SEND_UNKNOWN`，不自动重发；迟到版本帧仍经 D6 收敛 done（测试覆盖）。
- **D3 attempt token**：`attempts: Map<key, number>` 每次 send 单调自增（**不随清场归零**——归零会让新 attempt 重用旧 token，恰是要修的 ABA；清场后 phase 不再是 sending，旧回调自然全部失效）。`.then` 成功/失败分支与 send 超时回调都双核对 token+phase。
- **D4 下线判据**：composable 导出 `agentOffline(agent)` = 不在 agents ∨ `down` ∨ `card.state==="stale"`；`precheck` 与协调器 `offline` deps 共用同一函数。
- **D5 判定顺序**：`notifyTick` 先 `isSettled`⇒done（failed 相同样收敛），再 offline⇒`E_OFFLINE`（四个在飞相；failed 不重复处理；parked 下线不发 `sendCancel`）。watch 签名每段追加 `:${offline?1:0}`；agent 移出 agents 后段消失即签名变化。
- **D6 迟到成功**：只在同 key 版本到位时收敛（isSettled 按 key 读该 agent 卡片，无跨 key 机制；loop 测试钉住「新 key 顶上 ⇒ 旧 key 保持 E_OFFLINE、新 key idle」）。
- **D7 不自动重试**：无任何自动重发路径（测试断言 send 只被调 1 次）。
- **D8 新进程顶上**：不改导航语义（`useHub.ts` 未动，restore `successorOf` 照常）；旧 key 空态保留结果（D9④）。
- **D9 结果展示**：`orFailReason(entry)` 唯一文案来源（wire message ⇒ raw；本地码 ⇒ i18n key；未知 ⇒ raw 错误码）。①横幅 ②chip 失败态 ③汇总失败行（错误码进 title）④`OutdatedReloadResult.vue` 放 4 处空态。协调器 entry 按 key 保留，不随卡片消失清除。
- **D10 文案**：见 §1 i18n 行；zh/en 同步。
- **D11 transport**：未改 `token-client.js`/`password-client.js`/`control.js`；D2 为本地兜底，#25 另立。

## 3 测试清单（plan P-A 第 4–6 条逐项）

`outdated-reload.test.ts`（纯协调器，40 用例）：

- **预算**：fleet 反复忙闲每段 60s（<90s）×14 轮跨到 30min，awaiting 时 ⇒ `E_TIMEOUT`；warp 越过截止后才进 parked ⇒ 立即 `E_QUEUE_TIMEOUT` 且 `sendCancel`；计时器延迟三态（awaiting⇒`E_TIMEOUT` / queued 放行前⇒`E_QUEUE_TIMEOUT` 不发帧 / send 迟到成功按 sending 相⇒`E_SEND_UNKNOWN`）；sending 上界被剩余预算收紧（min）。
- **sending**：永不 settle ⇒ 60s `E_SEND_UNKNOWN`、send 只调 1 次；之后版本到位 ⇒ done→toast→idle。
- **ABA**：attempt1 下线失败 → 重试 attempt2；attempt1 迟到 resolve / 迟到 reject 均不影响 attempt2（token 挡掉）；attempt2 resolve ⇒ awaiting；reset 清场后迟到 resolve 不复活。
- **下线**：queued/sending/awaiting/parked 四相 ⇒ `E_OFFLINE`、计时器清空、parked 不发 cancel、failed 不重复处理不重发；settled∧offline 同时真 ⇒ done。
- **orFailReason**：wire message 优先、五错误码映射、未知/缺失退 raw。

`outdated-reload-loop.test.ts`（真实 reduce + composable，7 用例）：agent_up 新版本⇒done；agent_down⇒E_OFFLINE；agent_stale⇒E_OFFLINE 后同 key agent_up 新版本⇒done；agent_removed⇒E_OFFLINE 且 entry 保留；快照不含目标⇒E_OFFLINE / 含新版本⇒done；parked 期间新 key 顶上⇒旧 key E_OFFLINE、不调 sendCancel、新 key idle；agentOffline 判据。

`outdated-reload-surfaces.test.ts`（DOM 级，11 用例）：chip 失败态（danger class、chipFailed 文案、title 含离线原因与「click to retry」、aria-label 同步、点击 request、wire message 优先、非 failed 回归）；汇总失败行人读原因+错误码 title；横幅 errSendUnknown/errOffline/wire message；OutdatedReloadResult failed/done/idle/空 key/无 provider。

`dashboard-view.test.ts`（+5 用例）：真实 DashboardView 点击侧边栏 chip → 目标消失 → 「已删除」（宽/窄）与「未连接」（宽/窄）空态显示结果行 + 返回列表链接；无 entry 空态不渲染（回归）。

## 4 自验（真实输出摘要；全量日志 /tmp/pa-*.log）

| 门禁                                       | 结果                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/web-hub/ui`          | ✅ `Test Files 282 passed (282)` / `Tests 6180 passed (6180)`（/tmp/pa-vitest-ui.log）                                                                                                                                                                                                 |
| `npm run typecheck`                        | ⚠️ 失败于 `src/fabric/xs/activate.ts(667,87): TS2339 'progressPhaseOf'`——**并行 #20 包的未完成改动**（HEAD 版该文件无此引用；本包域 `vue-tsc -p src/web-hub/ui/tsconfig.json` 0 错误，/tmp/pa-vuetsc.log 为空；两个 tsc 步骤除该文件外无其它报错，/tmp/pa-tsc1.log、/tmp/pa-tsc2.log） |
| `npm run build:web`                        | ✅ `✓ built in 28.84s`（/tmp/pa-buildweb.log）                                                                                                                                                                                                                                         |
| `npm run check:web`                        | ✅ `✓ check:web — dist/web-hub-ui/ OK (85 files, first-screen JS 385058B gz/524288B, …)`（/tmp/pa-checkweb.log）                                                                                                                                                                       |
| `npx prettier --check` 13 个改动文件       | ✅ `All matched files use Prettier code style!`                                                                                                                                                                                                                                        |
| `git diff --quiet HEAD -- tests/fixtures/` | ✅ exit 0（tracked fixture 零改动；`?? tests/fixtures/web-hub/epoch-up-compat-golden.json` 为 P-B 新增，非本包）                                                                                                                                                                       |

## 5 遗留与交接

1. **typecheck 红灯非本包**：`src/fabric/xs/activate.ts` 属并行 #20 包（`src/fabric/xs/**`）；按任务约束未触碰。合流门禁（P-C）在两包合入后重跑即可。
2. **CSS 越界请示未达**：`message_agent` 发 root 返回 "message not authorized"。D9 的 danger chip 与结果行样式默认落在**文件域内 `.vue` 的对象式 `:style`**（source-scan 允许 `{` 起头的绑定；CSSOM 写入不受 CSP `style-src 'self'` 限制，与 DashboardView `layoutStyle` 同款先例；颜色全部引 tokens 变量）。建议 P-C 文档收口时把 `CHIP_FAILED_STYLE`/`RESULT_*` 迁回 `styles/outdated-reload.css`（该文件不在任何包的文件域，追加需 root 裁定）。
3. **#25 transport body deadline**（D11）：`token-client.js`/`password-client.js` 的 deadline 仍只盖响应头；`OR_SEND_TIMEOUT_MS` 是本地兜底，#25 修好后保留。
4. down 卡上点 chip 必然失败（用户已裁定并入 #24，本次不做隐藏）。
