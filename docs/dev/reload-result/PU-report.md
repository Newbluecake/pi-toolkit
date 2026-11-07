# #30 P-U（前端）交付报告

依据 `docs/dev/reload-result/plan.md`（r3）D8、§3 U1–U11（P-U 行）、§4 P-U 门禁。2026-11-05。

## 改动文件

- `src/web-hub/ui/src/logic/outdatedReload.ts`：`parseReloadStatus`（本地 `ReloadStatus` 类型，未碰 protocol）；协调器新增 `absorb()`（deps 新增可选 `newCmdId/reloadOutcome/hubVersion`，`send(key, cmdId)`）；cmdId+rev 去重、固定 effectDeadline（同一请求只建一次）、deferred⇒parked（此后不再按 fleet 迁移）、started⇒awaiting、completed 判定（done / `E_RELOAD_NO_UPGRADE` / 缺 version·epoch·hub 版本 ⇒ 按未知=started）、下线时最近事实为 started ⇒ `E_RELOAD_LOST`、failed 相规则（仅 completed⇒done，`E_OFFLINE|E_SEND_UNKNOWN|E_TIMEOUT` 可细化为 `E_RELOAD_*`/cancelled，迟到 deferred/started 忽略）、Q3：IDLE_WAIT 立即 fail 不 cancel，另设 cancelAt=绝对截止；`cancelOnce` 保证总截止与 IDLE_WAIT 竞态下 `sendCancel` 恰好一次、原因统一 `E_RELOAD_IDLE_WAIT`（`settleExpired` 先 absorb，两种处理顺序同结果；`E_QUEUE_TIMEOUT→E_RELOAD_IDLE_WAIT` 为唯一例外细化）；`orFailReason` 新增 8 个码映射；`OrEntry.waitingFor`。
- `src/web-hub/ui/src/composables/useOutdatedReload.ts`：`newCmdId`（复用 `@logic/control.js`）、`runCommand(..., {confirm:true,id})`、`reloadOutcome`、`hubVersion`；watch 签名追加 `:${life}/${rev}`（无 reload 时不追加，老 agent 签名不变）。
- `src/web-hub/ui/src/i18n/{zh,en}/outdated.ts`：新增 `errReloadLost/NoUpgrade/Cancelled/Unavailable/Settle/IdleWait/Refused/Failed`、`parkedIdle`；改写 `errQueueTimeout`（“网页端 30 分钟总时限已到…”）。
- `src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue`：parked 且 `waitingFor==="idle"` 显示 `parkedIdle`。
- `tests/web-hub/ui/outdated-reload-result.test.ts`（新建，24 用例）：U1–U10 + 端到端（真实未改 `state.js` reduce + composable：命令带自生成 id，deferred→started→completed，坏 reload 被忽略）。

绝对路径前缀 `/home/bluecake/ai/pi-toolkit/`。冻结面未动（`state/control/token-client/password-client.js`、`useHub.ts`、fixtures、protocol/hub/agent、loop 集成测试只读复跑）。U11 为 P-A 行。无 git 写操作。

## 自验

- `npx vitest run tests/web-hub/ui` → `Test Files 283 passed (283) / Tests 6204 passed (6204)`（/tmp/pu-ui.log）。#23 既有用例断言零修改（U9），全绿。
- `npm run build:web` exit 0；`npm run check:web` → `✓ check:web — dist/web-hub-ui/ OK (85 files, first-screen JS 387086B gz/524288B …)`。
- `npx vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json` exit 0（UI 域类型检查；未跑全仓 typecheck，按要求只看本包文件）。
- `npx prettier --check`（6 个改动文件）通过。
- `npx vitest run tests/integration/web-hub-outdated-reload-loop.test.ts` → `Tests 8 passed (8)`。

## 遗留 / 说明

- `errQueueTimeout` 文案按 plan 改写，原有断言只检查 key，未受影响。
- 横幅 `parkedIdle` 未加 DOM 级单测（逻辑层 `waitingFor` 透传已测）；AgentCard chip/汇总行自动经 `orFailReason` 获得新文案。
- 本地 `ReloadStatus` 与 P-A 的 `ReloadStatusWire` 字段按 plan 对齐，合流后可由 P-C 核对。
