# #23 Web 插件更新卡在「等待更新」· 实施方案（r3）

> 输入：`explore.md`（同目录）、AGENTS.md I9/I10/Frozen、`docs/dev/web-hub/README.md`、`docs/dev/deferred-reload/README.md`。车道 L2：P-A ∥ P-B 并行，之后做 P-C。
> r1 → r2：处理 GPT 评审第 1 轮（0B/5M/3m），见文末「评审处置表」。 r2 → r3：按 root 裁定闭合第 7 条（reap 后不保证换 key），改 L19/L34/L105/L112/处置表 #7。
> 用户已确认：范围 **A+B**；cap 名 **`epoch.up.v1`**；**不自动重试**；down 卡 chip 隐藏并入 **#24**；RC3（跨版本 reload 后进程退出）不在本方案范围。

## 0 需求

- **目标**：Web 上点击插件更新或重新加载后，不会再永远停在「等待更新」。**每一次请求都要在有限时间内结算**，结果为 done 或 failed（可重试）。
- **A（前端，RC1）**：等待期间目标下线或 stale ⇒ 立即进入 `E_OFFLINE`，给出中文原因和重试入口，清掉计时器。版本帧先到时仍判 done。所有用户能看到这个请求的入口（卡片 chip、汇总行、详情横幅、目标消失后的空态）都要显示人能读懂的结果。
- **B（hub，RC2）**：会话 epoch 变化时，hub 也能对没有 `hold.v1` 的新 agent 广播 `agent_up`，开关是追加的 agent cap `epoch.up.v1`。
- **不做**：RC3（#24）；改 deferred reload 后端语义；新增 HTTP 端点；改 transport（见 D11，另立任务）；隐藏 down 卡 chip（#24）。
- **验收（兼容口径见 §2.3）**：四种新老组合按 §2.3 逐项断言；A 级 golden 一律不得重生；B 级 `web-hub-ui/*` golden 与 web-hub boundary 测试不变；P-C 的合流门禁（§3）全部通过。

## 1 方案制定期的事实（影响取舍）

1. **默认配置下 RC2 不会触发。** `holdWired = control ∧ steerRecall`，两项默认都为 true（`agent/settings.ts:185,656`），所以默认 hello 自 v0.4.0 起就带 `hold.v1`，`registry.ts:425` 已经会在 epoch 变化时发 `agent_up`。本机日志 0 条 reclaim 的真实原因是 RC3。B 只对 `steerRecall:false` 或 `control:false` 的会话生效。
2. **新 cap 不能进默认 hello。** 五份 A 级 golden（`thread-off`、`thread-rebind-off`、`fabric-xs-off`、`fabric-xs-reply-off`、`schedule-off`）逐字钉住了默认配置的 `hello.caps`，并且都包含 `hold.v1`。末项各不相同：`thread-rebind-off` 以 `thr.v1` 结尾，`fabric-xs-reply-off` 以 `xs.v1` 结尾，其余以 `hold.v1` 结尾。这不影响结论：只要「仅在缺 `hold.v1` 时追加」，默认配置下就不会追加。
3. **registry 时间窗**（`protocol/messages.ts:1372-1373`）：断线后 10s（`detachGraceMs`）进入 stale，60s（`reapMs`）后 `down("reaped")`。`down()` 会删除记录和 `byAgentId`（`registry.ts:266-269`），但不留历史 key 墓碑；`newAgentKey()` = `a${pid}-${nonce.slice(0,6)}`，base 不在 records 时直接返回（`:284-290`，新注册路径 `:436-437` 同样走它）；同进程 reload 保留 agentId（pid+nonce，`agent/connection.ts:21-28,86-93`）。因此：10–60s 内、记录仍在的同 key reclaim 可收敛为 done（stale 后 reclaim 必发 `agent_up`，与 caps 无关）；reap 后走新注册路径，但**不保证 key 改变**——同进程通常拿回原 base key。同 key 重新出现且版本到位时仍收敛为 done；出现实际的新 key 时，旧请求保持失败。
4. **transport 并非一定会 settle。** `token-client.js:153-193` 和 `password-client.js:264-303` 的 deadline 只覆盖到拿到响应头；`outcomeFromResponse`（`control.js:635-641`）随后 `await r.json()`，没有上界。`withRelogin` 最多发两次请求，每次 `CMD_REQUEST_TIMEOUT_MS = 16s`。
5. 现有协调器的 30min 计时器（`outdatedReload.ts:316-327`）只结算 queued 和 parked；`parked→awaiting` 每次都会重新开 90s（`:278-289`）。如果 fleet 在每个 90s 内反复切换忙闲，就可以无限等下去。

## 2 决策

### 2.1 前端（P-A）

| #   | 议题                           | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 总预算                         | `request()` 时记录**绝对截止时间** `deadlineAt = deps.now() + OR_QUEUE_TIMEOUT_MS`（deps 新增 `now()`，composable 注入 `Date.now`）。总计时器只在 request 时设置，阶段切换不清除，只有 fail、succeed、reset、cancel 会清除。计时器回调**结算所有在飞阶段**：queued ⇒ `E_QUEUE_TIMEOUT`；parked ⇒ 先 `sendCancel` 再 `E_QUEUE_TIMEOUT`；awaiting ⇒ `E_TIMEOUT`；sending ⇒ `E_SEND_UNKNOWN`。另外，`enterAwaiting`、`enterParked`、`send` 进入前都检查 `now() >= deadlineAt`，成立就按上面的映射立即结算，防止后台标签页计时器延迟时漏掉。`enterAwaiting` 的生效计时取 `min(OR_EFFECT_TIMEOUT_MS, deadlineAt - now())`。不改 deferred reload 的后端语义。                                                                                                            |
| D2  | sending 上界                   | 新增 `OR_SEND_TIMEOUT_MS = 60_000`，大于 2×16s 加 relogin 的开销，用测试钉住 `> 2*CMD_REQUEST_TIMEOUT_MS`。sending 超时 ⇒ `fail(key,"E_SEND_UNKNOWN")`，表示结果未知，**不自动重发**。如果命令其实已经送达，版本到位后由 D6 收敛到 done。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D3  | attempt token                  | 协调器维护 `attempts: Map<key, number>`。每次 `send` 自增并记下本次的 token；`.then` 的成功和失败分支、send 超时回调都要求 **token 一致且 phase 为 sending** 才生效。`clearAllTimers`（fail、succeed、reset、cancelQueue、request 都会调用）同时使 token 失效，修掉 ABA 问题。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D4  | 下线判据                       | `offline = agent 不在 agents ∨ agent.down ∨ card.state==="stale"`，抽成 composable 内的 `agentOffline(agent)`，与 `precheck` 共用。claiming 状态在 UI 上不可见，所以 handover 的 10s 内不会误判。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D5  | 判定顺序                       | `notifyTick` 中先 `isSettled` ⇒ done，再看 offline ⇒ `E_OFFLINE`，作用于 queued、sending、awaiting、parked 四个阶段。`failed` 阶段不重复处理。parked 状态下线时**不发** `reload cancel`。watch 签名每个 agent 段追加 `:${offline?1:0}`；agent 被移出 agents 后它的段消失，签名自然变化，不需要额外字段。                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D6  | 迟到成功                       | 已有的 failed→done 收敛规则保留，边界：**只在同一个 key 出现在 agents 且版本到位时**收敛。10–60s 内、记录仍在的同 key reclaim 可收敛为 done；reap 后走新注册路径，但不保证 key 改变——同 key 重新出现且版本到位时仍收敛为 done；出现实际的新 key 时，旧请求保持失败。协调器**不跨 key 追认成功**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D7  | 不自动重试                     | 保持不自动重试。用户已确认。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D8  | 新进程顶上（新 key）           | 旧 key 保持 `E_OFFLINE`。新卡片是独立实体。现有 restore 路由（`useHub.ts:316-328` 的 `successorOf`）**照常**把旧 key 的查看者带到 successor；本方案不改导航语义，只在旧 key 的空态里保留结果（D9）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D9  | 结果展示（所有入口）           | `outdatedReload.ts` 新增纯函数 `orFailReason(entry): { key: OutdatedMsgKey } \| { raw: string }`，作为原因文案的唯一来源：有 wire message 用 raw，否则按错误码映射到 i18n。① **详情横幅**改用它。② **AgentCard chip**：phase 为 failed 时显示错误态（danger 配色、`alert` 图标、文案 `chipFailed`），title 和 aria-label 为 `chipFailedTitle`（「{reason} — 点击重试」），点击行为不变，仍然 `request`。③ **汇总失败行**显示人能读懂的原因，错误码放进 `title`。④ **目标消失**：新组件 `detail/OutdatedReloadResult.vue`（prop agentKey）只在 entry 为 failed 或 done 时渲染一行结果，放进 `DashboardView.vue` 中「已删除」「未连接」两种空态（宽屏和窄屏共 4 处）的 `#actions` 插槽，紧邻已有的「返回列表」按钮。协调器的 entry 按 key 保留，不随卡片消失而清除。 |
| D10 | 文案（zh/en 同步，键集合一致） | 改 `errOffline`：「会话已离线（进程已退出或正在重启），重新加载未完成；若会话已重启，请在新卡片上查看或重试」。新增 `errSendUnknown`（「命令结果未知（网络响应未完成）；若重新加载已生效，版本到位后会自动显示成功」）、`chipFailed`（「更新失败」）、`chipFailedTitle`、`resultPre`（「重新加载结果：」）。chip 沿用现有「需更新」chip 的 i18n 惯例。                                                                                                                                                                                                                                                                                                                                                                                                             |
| D11 | transport                      | 本方案**不改** `token-client.js`、`password-client.js`、`control.js`（全部控制操作共用，影响面大）。另立任务（建议 #25：让 deadline 同时覆盖响应头和 body）。D2 是本地兜底，无论 #25 是否修好都保留。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 2.2 hub / agent（P-B）

| #   | 议题       | 决策                                                                                                                                                                                                             |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D12 | cap        | `protocol/version.ts`，放在 `HOLD_*` 之后：`EPOCH_UP_CAP = "epoch.up.v1"`、`EPOCH_UP_AGENT_CAPS`。头注写明：与 hold.v1 互补；只出现在 agent 面；hub **不在任何 cap 面**（HubInfo.caps / hello_ack.caps）广播。   |
| D13 | agent 声明 | 原 `capsExtra` 的函数体改名为 `baseCapsExtra()`，外层为 `capsExtra = () => { const c=[...baseCapsExtra()]; if (!c.includes(HOLD_CAP)) c.push(...EPOCH_UP_AGENT_CAPS); return c; }`。所有配置都**只在末尾追加**。 |
| D14 | hub 条件   | `epochRefresh = epochChanged && prevPhase!=="stale" && (caps∋HOLD_CAP ∨ caps∋EPOCH_UP_CAP)`。顺序不变：先 agent_up 后 gap，stale 分支只发一次。同一 epoch 重连保持静默（Y7.2 已钉住）。                          |

### 2.3 兼容口径（取代 r1 的「混搭字节不变」）

| 组合                | 断言（P-B / P-C 用测试证明）                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 agent 自身 hello | **默认配置**：字节与 A 级 golden 相同。**hold 关闭的配置**（steerRecall:false 或 control:false）：等于原数组 + 尾部唯一追加的 `epoch.up.v1`，用真实 `wireWebHub` 捕获的 hello 断言。                                                                                                                                              |
| 老 hub × 新 agent   | 老 hub 只把 caps 存下，不读取未知 cap；`card()` 只派生布尔值，不暴露 caps。可观察输出（hub cap 面、agent_up/gap 序列、SSE 原文）与「老 hub × 老 agent」相同。唯一差别是 hub 内部的 `caps` 事件（`registry.ts:397,432-435`，只给 run-transcript 重新校验，不进 SSE）：caps 集合变化时会触发。这与任何一次带新 cap 的升级行为一致。 |
| 新 hub × 老 agent   | 两个 cap 都没有时，事件序列和 SSE 原文与改动前**逐字节相同**（只有 gap）；带 hold.v1 时也与改动前相同。                                                                                                                                                                                                                           |
| 新 hub × 新 agent   | 每次 epoch 变化都发 agent_up 再发 gap；hub cap 面不变（不含 `epoch.up.v1`）。                                                                                                                                                                                                                                                     |

证明方式：P-B **在修改 registry 之前**，先写 `tests/web-hub/hub/epoch-up-compat.test.ts`，经 `tests/web-hub/http/helpers.ts` 启动真实 hub HTTP，在**未修改的实现**上录制 `tests/fixtures/web-hub/epoch-up-compat-golden.json`。环境变量 `PI_TOOLKIT_EPOCH_UP_GOLDEN_CAPTURE=1` 控制录制，文件已存在时拒绝覆盖。录制三个场景，每个场景记 HubEvent 序列和 SSE 原文：S1 老 caps 不含 hold、S2 老 caps 含 hold、S3 老 hub 收到新 agent 非默认 caps。改动后，测试断言 S1、S2 在新实现上逐字节相等，S3 只作为老 hub 的存证。verifier 用 `git archive origin/dev | tar -x -C <tmp>` 加软链 node_modules，在旧实现上重跑录制并与 golden 比对（只读，不做 git 写操作）。hub cap 面不变由 `caps-coexist.test.ts` 加断言 `!caps.includes(EPOCH_UP_CAP)` 证明。

## 3 分包

**P-A ∥ P-B 同树并行**。冲突预检已按 r2 文件域重跑：`node skills/dev-flow/scripts/conflict-check.mjs spec.json --cwd .` ⇒ 「无交集，可同树并行」。P-C 等两包都合入后再开始（barrier）。

```json
[
  {
    "id": "P-A:ui",
    "globs": [
      "src/web-hub/ui/src/logic/outdatedReload.ts",
      "src/web-hub/ui/src/composables/useOutdatedReload.ts",
      "src/web-hub/ui/src/i18n/zh/outdated.ts",
      "src/web-hub/ui/src/i18n/en/outdated.ts",
      "src/web-hub/ui/src/components/agents/AgentCard.vue",
      "src/web-hub/ui/src/components/agents/OutdatedSummaryBanner.vue",
      "src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue",
      "src/web-hub/ui/src/components/detail/OutdatedReloadResult.vue",
      "src/web-hub/ui/src/components/shell/DashboardView.vue",
      "tests/web-hub/ui/outdated-reload.test.ts",
      "tests/web-hub/ui/outdated-reload-loop.test.ts",
      "tests/web-hub/ui/outdated-reload-surfaces.test.ts",
      "tests/web-hub/ui/dashboard-view.test.ts"
    ]
  },
  {
    "id": "P-B:hub",
    "globs": [
      "src/web-hub/protocol/version.ts",
      "src/web-hub/hub/registry.ts",
      "src/web-hub/agent/index.ts",
      "tests/web-hub/hub/registry.test.ts",
      "tests/web-hub/hub/caps-coexist.test.ts",
      "tests/web-hub/hub/epoch-up-compat.test.ts",
      "tests/fixtures/web-hub/epoch-up-compat-golden.json",
      "tests/web-hub/protocol/version.test.ts",
      "tests/web-hub/agent/wiring-control.test.ts",
      "tests/web-hub/agent/wiring-hold.test.ts",
      "tests/web-hub/agent/wiring-private-ns.test.ts"
    ]
  }
]
```

**冻结面**（不得修改，越界先上报）：`tests/fixtures/**` 中已有的文件（P-B 只允许新建上面那一份 golden）、`docs/dev/web-hub/README.md`（归 P-C）、`ui/src/logic/{state,control,token-client,password-client}.js`、`ui/src/composables/useHub.ts`、`hub/http.ts`、`protocol/{messages,http-contract}.ts`，以及文件域之外的所有 `.vue`。**所有 A 级 golden 禁止重新生成。**

### P-A（frontend-dev）

1. `outdatedReload.ts`：落实 D1–D3、D5、D6 和 D9 中的 `orFailReason`。deps 新增 `now`、`offline`，常量新增 `OR_SEND_TIMEOUT_MS`。同步更新头注里的状态机描述。
2. `useOutdatedReload.ts`：D4，以及签名追加 offline 段，注入 `now`、`offline`。
3. 落实 D9 涉及的四个 `.vue`（含新组件）和 D10 的 i18n 文案。
4. 测试（fake clock / 可控 Promise）。`outdated-reload.test.ts`：
   - **预算**：fleet 反复忙闲，每段不足 90s；30min 时刚好处于 awaiting ⇒ `E_TIMEOUT`。另一条：30min 后才进入 parked ⇒ 立即 `E_QUEUE_TIMEOUT` 并且调用 `sendCancel`。计时器延迟场景：`now` 已超过截止时间但计时器还没触发，此时 `enterAwaiting` 也会结算。
   - **sending**：send 永不 settle ⇒ 60s 后 `E_SEND_UNKNOWN`，`send` 只被调用 1 次；之后版本到位 ⇒ done。
   - **ABA**：attempt1 进入 sending 后因 offline 失败；key 恢复但版本仍旧；重试进入 attempt2。attempt1 迟到 resolve ok、迟到 reject 都**不影响** attempt2；attempt2 resolve 后进入 awaiting。
   - **下线**：四个在飞阶段遇到 offline 都进入 `E_OFFLINE`，计时器全部清空；settled 与 offline 同时为真时判 done；parked 下线不调用 `sendCancel`；E_OFFLINE 后不自动重发。
5. `outdated-reload-loop.test.ts`（真实 `reduce` 加 composable）：agent_up 新版本 ⇒ done；`agent_down` ⇒ `E_OFFLINE`；`agent_stale` 后同 key `agent_up` ⇒ done；`agent_removed` ⇒ `E_OFFLINE`，entry 保留；`agents` 快照不含目标 ⇒ `E_OFFLINE`；快照中目标已是新版本 ⇒ done；parked 期间新 key 顶上 ⇒ 旧 key `E_OFFLINE`、不调用 `sendCancel`、新 key 为 idle。
6. `outdated-reload-surfaces.test.ts` 和 `dashboard-view.test.ts`（挂载组件，**要断言 DOM 而不是 `entryOf()`**）：chip 失败态的文案、title 含离线原因，点击会调用 `request`；汇总失败行显示人读原因；横幅显示 `errSendUnknown` 和 `errOffline`；「已删除」「未连接」空态里显示结果行和「返回列表」链接。
7. 门禁：`npx vitest run tests/web-hub/ui`、`npm run typecheck`、`npm run build:web`、`npm run check:web`、`npx prettier --check <改动文件>`，以及 `git diff --quiet origin/dev -- tests/fixtures/`。

### P-B（dev）

1. **第 0 步（先于任何 src 改动）**：写 §2.3 的 compat 测试，在未修改的实现上录制 golden。
2. 落实 D12、D13、D14，并补注释（写明 §1.2 的 A 级 golden 约束和 #23 的出处）。
3. 测试：
   - `version.test.ts`：常量值稳定。
   - `registry.test.ts`：新增 #23 describe，覆盖 claiming 或 live 下 epoch 变化且带 `epoch.up.v1` ⇒ 先 agent_up（携带新 epoch 和新版本）后 gap；stale ⇒ 只发一次；同 epoch ⇒ 静默。Y7.2 原有的 control 用例保留，断言不改。
   - `caps-coexist.test.ts`：hub 两个 cap 面都不含 `epoch.up.v1`。
   - `wiring-control.test.ts`：`control=false` 行追加该 cap（属于声明式更新）。
   - `wiring-hold.test.ts`：hold 关闭时 hello 以 `epoch.up.v1` 结尾，且只多这一个；默认配置不含该 cap。
   - `wiring-private-ns.test.ts`：只在有精确数组断言时才改。
4. 门禁：`npx vitest run tests/web-hub/hub tests/web-hub/protocol tests/web-hub/agent tests/web-hub/http/sse.test.ts tests/web-hub/boundary.test.ts tests/governance`；A 级套件 `npx vitest run tests/integration/{thread-off,thread-rebind-off,fabric-xs-off,fabric-xs-reply-off,schedule-off}-golden.test.ts tests/integration/fabric-xs-channel-compat.test.ts tests/reload/activation.test.ts`；`npm run typecheck`；`git diff --stat origin/dev -- tests/fixtures/` 只允许出现新增的那一份 golden。

### P-C（dev，等 A、B 都合入）· 跨层闭环 + 文档 + 合流门禁

1. `tests/integration/web-hub-outdated-reload-loop.test.ts`：
   - hello 由**真实 `wireWebHub`** 捕获（`tests/web-hub/agent/helpers.ts` 的 fakeNet）。正例为 steerRecall:false，hello 带 `epoch.up.v1`。对照组使用不含 `epoch.up.v1` 的老 caps，结果应为只有 gap ⇒ awaiting ⇒ 90s 后 `E_TIMEOUT`，把老 agent 的残留行为显式写进测试。
   - 用 hello 驱动真实 registry 和 hub HTTP（`tests/web-hub/http/helpers.ts`），读取**真实 SSE 原文**，解析成 `{event,data,id}` 喂给 UI 的 `reduce` 和 composable，走到 done。
   - 时间窗（注入 now/tick）：stale 后 10–60s 内同 key reclaim ⇒ done。超过 60s 被 reap（`agent_down`）后，**断言用 `register()` 真实返回的 key，不预设是否换 key**：(a) 同进程同 identity（同 pid+nonce）以新 epoch、新版本重新注册 ⇒ 返回 key 与旧 key 相同（`reclaimed:false`）⇒ 新注册路径发 `agent_up` ⇒ 版本到位即 done；(b) 新进程新 identity（不同 pid/nonce）顶上 ⇒ 返回新 key ⇒ 旧请求保持 `E_OFFLINE`，新 key 为 idle。
2. `docs/dev/web-hub/README.md`：registry 一节写明 epoch 刷新条件（hold.v1 ∨ epoch.up.v1）、两个 cap 互补、不得进入默认 hello，以及 compat golden 的规则；outdated reload 一节写明 D1–D10（总预算、send 上界、attempt token、下线判据、不跨 key、结果展示），并记录 #25 transport 残留。
3. **合流门禁（按顺序，全部在合入后的树上跑）**：`npm run format:check` → `npm run typecheck` → `set -o pipefail; PI_TOOLKIT_TEST_WORKERS=4 npm test 2>&1 | tee /tmp/wus-test.log`（不用 tail）→ `npm run build` → `npm run build:web` → `npm run check:web`；然后 `git diff --stat origin/dev -- tests/fixtures/` 只允许出现 P-B 新增的那一份 golden（A 级一律不动）。

## 4 风险与残留

- **RC3 修好之前（#24）的表现**：点击更新后目标进程退出 ⇒ 卡片 down ⇒ chip、横幅、汇总行**立即**显示离线失败原因。如果 restore 拉起了新进程，现有路由会把详情页查看者带到 successor（D8）；旧 key 的空态里保留失败结果。这是如实报告失败，不是成功。
- **慢 reload**：10–60s 内、记录仍在的同 key reclaim 会先短暂显示 E_OFFLINE，再自动变为 done；reap 后走新注册路径但不保证 key 改变——同 key 重新出现且版本到位时仍收敛为 done，出现实际的新 key 时旧请求保持失败（D6）。
- **E_SEND_UNKNOWN**：body 迟迟不结束时报「结果未知」，彻底修复要等 #25；之后命令若其实生效了，会自动转为 done。
- **B 的收益有限**（§1.1），只对非默认配置有效；老 agent（无两个 cap）reload 成功后仍要等 90s 才报 `E_TIMEOUT`（P-C 的对照组把这一点钉住）。
- down 卡上的 chip 点了必然失败：用户已决定并入 #24。

## 5 开放问题

无。r1 的 Q1–Q3 已由用户拍板：B 照做；cap 名为 `epoch.up.v1`；chip 隐藏并入 #24。新增的 #25（transport body deadline）是否立项，由主会话在收尾时提出。

## 评审处置表（GPT 第 1 轮）

| #   | 级别  | 问题                                              | 处置                                                                                                                                                                                                                                                                                                                                                      | 改动位置                                                |
| --- | ----- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Major | 30min 预算会被阶段切换绕过，可永久等待            | 接受：改用绝对截止时间，回调结算所有在飞阶段，进入 awaiting/parked/send 前检查截止；补反复忙闲、30min 时处于 awaiting、超时后才 parked、计时器延迟的测试                                                                                                                                                                                                  | §1.5、D1、P-A 第 4 条「预算」                           |
| 2   | Major | send promise 不一定 settle                        | 接受：协调器本地加 60s sending 上界，超时报 `E_SEND_UNKNOWN`，不重发；transport 修复另立 #25                                                                                                                                                                                                                                                              | §1.4、D2、D11、P-A 第 4 条「sending」、§4               |
| 3   | Major | 只改 errOffline，chip、汇总、消失目标都看不到原因 | 接受：用 `orFailReason` 作为唯一文案来源，chip 加失败态，汇总行显示人读原因，新组件 OutdatedReloadResult 放进空态；解冻 4 个 `.vue`，补 DOM 级组件测试                                                                                                                                                                                                    | D9、D10、§3 spec 与冻结面、P-A 第 3、6 条               |
| 4   | Major | 迟到 Promise 的 ABA 问题                          | 接受：引入 attempt token，回调同时校验 token 和 phase，各种清理都使 token 失效；补两次可控 Promise 乱序结算的测试                                                                                                                                                                                                                                         | D3、P-A 第 4 条「ABA」                                  |
| 5   | Major | 「混搭字节不变」口径自相矛盾；golden 末项描述有误 | 接受：重写为四组合分项口径，改动前录制 compat golden 并只读复验，hub cap 面加断言；更正 golden 末项描述                                                                                                                                                                                                                                                   | §1.2、§2.3、P-B 第 1、3 条                              |
| 6   | Minor | P-C 闭环覆盖被夸大                                | 接受：改用真实 wiring 捕获的 hello 和真实 HTTP/SSE，保留正反对照；在 P-A 第 5 条补 agent_removed、快照、parked 期间新 key 顶上；写明不跨 key 追认、restore 路由照常跟随                                                                                                                                                                                   | P-C 第 1 条、P-A 第 5 条、D6、D8                        |
| 7   | Minor | 慢 reload 自动 done 缺时间边界                    | 接受：限定为同 key 且记录仍在；补 10–60s 内 reclaim 和超过 reap 两组用例。**r3**：按复审证据（`registry.ts:266-269,284-290,436-437`、`connection.ts:21-28,86-93`）更正「reap 后必然换 key」——reap 后不保证换 key，同 key 重现且版本到位仍 done，实际新 key 时旧请求才保持失败；P-C 用例改用 `register()` 真实返回的 key，分同 identity / 新 identity 两组 | §1.3（L19）、D6（L34）、P-C 第 1 条（L105）、§4（L112） |
| 8   | Minor | 门禁缺 build、pipefail，未明确 A 级禁止重生       | 接受：P-C 合流门禁按顺序列全，加 `set -o pipefail` 和 tee；冻结面和验收明确 A 级禁止重生                                                                                                                                                                                                                                                                  | §0 验收、§3 冻结面、P-C 第 3 条                         |
