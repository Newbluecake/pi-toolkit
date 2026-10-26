# #65 outdated-reload 交付报告

web UI：会话插件版本落后于 hub 时提示并一键重新加载。交互以用户已确认的
`docs/dev/web-hub/outdated-reload-preview.html`（§1–§7，含 §6 汇总）为准。**纯前端实现**，
协议/后端零改动（`card.outdated`、`card.pluginVersion`、hub 帧 `version`、control-plane
`command` op 全是既有通道），`tests/fixtures/` 零变化。

## major 修复（2026-10-26 验收一轮）

**问题**：主会话 idle 但子 agent/workflow 在跑（background-only 主会话的最常见场景）时，
旧实现 `isBusy = status.busy`，直接送 `/agent reload`；后端 deferred reload 因 fleet 忙
park，命令帧立即 ok，90s 生效超时后误报 danger「重新加载失败（E_TIMEOUT）」。

**修法**（纯前端，协议零改动）：

1. 「忙」= 主会话流式（`status.busy`）∨ 有活跃子 agent/workflow。后者用**已上报**的
   `AgentState.fleet`（行 `status==="running" ∧ terminal!==true`，与
   `agentCardModel.runningSubCountOf` 同口径）+ `fleetOmitted.active`（投影截断的活跃数），
   纯函数 `fleetActiveCount()` 收在逻辑层。
2. 新增相 **parked**：已送达但 fleet 忙（送达时或 awaiting 中变忙）⇒ info 排队态「重新加载
   命令已送达，正在等待 N 个子 agent 结束后自动执行。」+【取消排队】（送
   `/agent reload cancel`，fire-and-forget；`command-policy` 里 `agent reload` 整组 confirm
   级，同样带 `confirm:true`）。90s 生效计时只在 awaiting 走：awaiting→parked 停表，
   parked→awaiting 重开 90s；30min 总上限从 request 起算覆盖 queued+parked（parked 超时
   先 cancel 后端再报 `E_QUEUE_TIMEOUT`）；只有 fleet 空闲后 90s 未生效才 `E_TIMEOUT`。
3. 新单测 7 例：idle+fleet 忙 ⇒ queued 不送不超时；送达时 fleet 忙 ⇒ parked 不计 90s；
   awaiting 中 fleet 变忙 ⇒ parked 停表、清空重开；parked cancel 发 cancel 帧、queued cancel
   不发；parked 超 30min ⇒ cancel+E_QUEUE_TIMEOUT；`fleetActiveCount` 口径；
   `orBannerView` 状态→tone/icon 映射（minor，映射表抽成逻辑层纯函数，组件与测试共用）。

## 改动文件

| 文件                                                             | 内容                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/outdatedReload.ts`                     | 新增。纯逻辑层：落后判定（`sessionOutdatedInfo`/`sessionReloadedToHub`）、snooze 记忆键（`pwh_or_snooze_v1`，`agentKey → hub 版本`，FIFO 64 帽）、`OrCoordinator` 状态机（idle → queued/sending → awaiting → done/failed，QUEUE 30min / EFFECT 90s / TOAST 4s 全部注入定时器）、`outdatedSessions` 汇总 |
| `src/web-hub/ui/src/composables/useOutdatedReload.ts`            | 新增。Vue 装配：hub 帧 watch → `notifyTick()`（busy 翻转放行排队、版本到位判成功）；`send()` 经 `ControlHandle.runCommand(key,"agent","reload",{confirm:true})`；snooze 双写内存 + `browserLocalStorage()`（source-scan 白名单路径，未改扫描规则）                                                      |
| `src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue`  | 新增。详情页顶部提示条（§1–§4：warning 主态 / info 排队 / danger 失败 / success toast）                                                                                                                                                                                                                 |
| `src/web-hub/ui/src/components/agents/OutdatedSummaryBanner.vue` | 新增。列表汇总条（§6：≥2 落后时出现，【全部重新加载】逐个执行+进度行，忙的自动排队，【查看】跳 `#/`）                                                                                                                                                                                                   |
| `src/web-hub/ui/src/styles/outdated-reload.css`                  | 新增。`.or-banner`/`.or-toast`/`.or-progress`/`.chip-outdated`；颜色全走 tokens（深色自动跟随），mono 片段用 `color-mix(surface)` 单写双色；≤480px 按钮换行占满 + 44px                                                                                                                                  |
| `src/web-hub/ui/src/i18n/{en,zh}/outdated.ts`                    | 新增。`outdated` 命名空间（glob 自动拾取；zh `satisfies` en，i18n-parity 测试覆盖）                                                                                                                                                                                                                     |
| `src/web-hub/ui/src/components/agents/AgentCard.vue`             | 「需更新」chip（§5，warning 配色，compact/detailed 两版；原有 outdated statusLabel pill 保留）                                                                                                                                                                                                          |
| `src/web-hub/ui/src/components/shell/DashboardView.vue`          | 创建唯一 manager 并 `provide(OUTDATED_RELOAD_CTX)`；unmount 时 dispose                                                                                                                                                                                                                                  |
| `src/web-hub/ui/src/components/detail/AgentDetail.vue`           | `.detail-main` 顶部挂载 `OutdatedReloadBanner`                                                                                                                                                                                                                                                          |
| `src/web-hub/ui/src/components/agents/AgentList.vue`             | `sidebar-head` 后挂载 `OutdatedSummaryBanner`                                                                                                                                                                                                                                                           |
| `src/web-hub/ui/src/App.vue`                                     | 引入 `outdated-reload.css`                                                                                                                                                                                                                                                                              |
| `tests/web-hub/ui/outdated-reload.test.ts`                       | 新增。17 例：判定/成功判据、snooze 读写/失效/封顶、状态机全路径（排队/取消/超时/失败/重试/幂等/批量）、汇总列表                                                                                                                                                                                         |

未动：`src/reload/**`、`src/commands/status.ts`、`src/index.ts`（并行包范围）；无协议/wire 变更
（I10 append-only 无从谈起——零新增字段）；`webHub` 设置键零新增。

## 送达命令的实证（要求 1 的关键确认）

- web → 会话的写路径只有一条：control-plane `command` op（UI `ControlHandle.runCommand` →
  hub `commands.ts` → agent `commands.ts` 的 `handleCommand` → `builtinBridge.execute`）。
  **该路径不经 TUI 编辑器**，`src/reload/editor.ts` 的「精确 `/reload` ⇒ `/agent reload`」
  改写只在 `session_start` 包装的编辑器提交上生效，web 送 `/reload` 会裸执行 pi 内建
  reload（立即 teardown，子 agent 被 session_shutdown 停掉）。
- 因此本特性固定送 **`/agent reload`**（name `agent`, args `reload`）——pi-toolkit 自己的
  命令，走 `src/reload/` 的 deferred reload：fleet 忙时 park、settle 后自动
  `/agent reload fire`，保护完整保留。
- 政策面：`command-policy.ts` 的 `PI_TOOLKIT_TABLE.agent.reload` 是 `confirm` 级；横幅的
  【重新加载】按钮即用户确认，故调用带 `confirm: true`（`useControl.runCommand` 的既有
  `cmdOpts.confirm` 通道，与 NewSessionMenu 的 `/new` 同款）。用户若设
  `webCommandPolicy.agent:"deny"` 则得 `E_DENIED*`，如实进 danger 态。
- 成功判据：`/reload` 后 agent 侧模块重评估 ⇒ `bye{handover}` + 同 agentId 新 epoch
  重连（`agent/connection.ts` spike K4 注释），hello 带新 `pluginVersion`，hub
  `registry.ts` 重算 `outdated` 并广播；UI watch 到 `pluginVersion == hub.version ∧
outdated !== true` ⇒ done toast「已重新加载到 X」。此判据与路径无关——哪怕命令
  结果帧在 handover 中丢失（`effect:"unknown"`），版本到位仍收敛成功。

## 设计取舍

1. **状态机放纯逻辑层（`OrCoordinator`）**，定时器/send/precheck 全注入——单测不碰 Vue；
   composable 只做响应式桥（`entryTick` bump + 帧签名 watch）。
2. **排队在前端**（预览允许）：页面刷新丢失，见残留风险 R1。busy 判据 =
   `status.busy ∨ fleetActiveCount>0`（major 修复；fleet 用已上报的 fleet 投影，未改协议）；
   30min 总上限（规则 3「不得无限等」），超时落 `E_QUEUE_TIMEOUT` danger 态可重试。
3. **生效等待 90s**（`OR_EFFECT_TIMEOUT_MS`）只在 fleet 空闲的 awaiting 相走；deferred
   reload park（fleet 忙）是独立的 parked 相，如实显示等待中而非误报失败。
4. **snooze 按 (agentKey, hub版本) 记 localStorage**（要求 4）：hub 版本再变自动重新提示；
   单键 JSON 表，64 帽 FIFO；storage 不可用时降级为内存表。未新增 source-scan 白名单条目
   （经 `themeStorage.ts` 的 `browserLocalStorage()` 访问）。
5. **汇总条无 snooze**（预览 §6 无关闭按钮，落后数 <2 自隐）；进度行直接映射协调器各相，
   全 done ⇒ 4s toast，有 failed ⇒ 行保留（可再点【全部重新加载】，`request` 幂等 +
   failed 相重试）。
6. **送帧走 `runCommand` 而非静默 transport**（区别于 `setArchived` 先例）：命令在 dock
   队列留一张真实卡片（ModelSwitcher `/model` 同款），可查询、可审计。
7. i18n 中英双写；版本号/错误码用 `.mono` 片段组件拼接（no-innerhtml 约束下不能插值
   HTML，故文案拆 pre/mid/suffix 三段，两种语言语序均成立）。

## 残留风险

- **R1（预览已接受）**：排队/在飞状态是页面级内存，刷新即丢。丢的是「 UI 记忆」，不是
  命令本身——已送达的 reload 照常执行；队列里未送达的刷新后不再补发（会话仍落后，提示
  条刷新后重新出现，可再点）。
- **R2**：`/agent reload cancel` 送达失败（fire-and-forget 不重试）时，后端 arm 着的 reload
  仍会在 fleet 清空后执行——UI 已回 idle/暂不，版本到位后卡片 outdated 消失，无错误呈现，
  可接受（取消本就是 best-effort）。
- **R3**：`effect:"unknown"` 的送达失败（如 E_DEADLINE）先落 failed，若 reload 实际执行
  则版本到位后自动转 done toast——两种态都会如实出现一次，未做抑制。
- **R4**：汇总条把离线/无控制面的落后会话也计入 N（预览不区分）；【全部重新加载】对它
  们立即落 `E_OFFLINE`/`E_UNSUPPORTED` 失败行，如实展示。

## 自验

- `npm run typecheck` — 通过（tsc ×2 + vue-tsc）
- `npm run build:web && npm run check:web` — 通过（first-screen 365111B/524288B gz，CSS 37562B/65536B gz）
- `npx vitest run tests/web-hub --maxWorkers=4` — 698 文件全过，15472 passed / 3 skipped（含新增 24 例）
- `npx prettier --check <改动文件>` — 全部通过
- `git diff --quiet HEAD -- tests/fixtures/` — 无变化（version-anchor / topbar-no-quota /
  keepalive-legacy 三个 golden 均未触碰）

## 建议 commit message

```
feat(web-hub): 会话插件落后于 hub 时 web 提示并一键重新加载 (#65)

详情页顶部提示条（warning/info 排队/danger 失败/成功 toast），送 /agent reload
保留 deferred-reload 保护；忙会话前端排队、空闲自动续上；暂不/关闭按 hub 版本
记忆；侧边栏卡片加「需更新」chip；仪表盘 ≥2 落后时汇总条批量重载带进度。
纯前端实现，协议零改动。
```
