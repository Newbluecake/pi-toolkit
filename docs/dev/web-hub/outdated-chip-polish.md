# outdated chip 收敛（会话卡片「需更新」提示）— 交付报告

2026-10-27。纯 web UI 改动，wire/协议/hub 零改动；`tests/fixtures/` 零变化；非 outdated 会话的
卡片 DOM/样式逐字节不变。预览（用户已确认）：`docs/dev/web-hub/outdated-chip-preview.html`，
截图在 `docs/dev/web-hub/outdated-chip-preview/`（`full.png` 整页、`wide-2x.png` §1 高清）。

## 问题（用户现场截图，8 个会话落后于 hub 0.10.1）

1. **重复提示**：顶部汇总条已写「8 个会话的插件版本落后于 hub 0.10.1」并带【全部重新加载】；
   每张卡片又同时显示长文案状态 pill「ⓘ 插件旧于 hub，需 /reload」**和** chip「ⓘ 需更新」——
   同一件事说三遍。
2. **挤压溢出**：compact 密度下 `.agent-chips` 是 `flex:none` 不收缩整组，长 pill 把同一行的
   `@alias` / `#频道` / 未读角标挤出卡片右缘（被 sidebar 裁掉）；目录名（`.agent-title`
   `flex:0 1 auto`）被压到只剩一个字符。
3. **状态被顶替**：`statusLabelOf` 在 `card.outdated === true` 时返回
   `common.status.outdated`，把 idle/running/stale 等真实状态整条替换掉，运行中的会话在
   列表上看不到「运行中」。

## 改法（与预览一致）

1. **pill 只表达真实状态**：`agentCardModel.statusLabelOf` 删掉 outdated 分支（idle ⇒
   `null`、busy ⇒ `common.status.running`，offline/waiting/stale 优先级不变）；i18n 的
   `common.status.outdated`（zh/en）随之删除。AgentCard 两处的 pill 不再在 outdated 时塞
   info 图标。
2. **唯一的「需更新」chip，可点击**：compact/detailed 两处 chip 由 `<span>` 改为
   `<button type="button">`（沿用 `privacy-lock-btn` 的卡片内嵌按钮先例，
   `@click.prevent.stop` 不导航外层 `<a>`），tooltip 用新键 `outdated.chipTitle` 带完整
   说明。点击复用 #65 的 `OUTDATED_RELOAD_CTX`：`idle/failed/done` ⇒ `request(key)`（忙自动
   排队，走 OrCoordinator 的 queued/parked/awaiting 全套保护）；`queued/parked` ⇒ 再点
   `cancelQueue(key)`；进行中的相 chip 显示 `outdated.chipQueued`（loader 图标 + spin）。
   无 provider（单测/独立挂载）⇒ 纯展示 chip，点击无操作。**无新协议通道**——复用既有
   control-plane `command` op（`/agent reload`，confirm 级）。
3. **溢出收敛只作用于 outdated 卡片**：卡片根节点新增 `data-outdated="true"`（`undefined`
   时不渲染属性）；`agents.css` 新增
   `.agent-card[data-density="compact"][data-outdated="true"] .agent-chips { flex: 0 1 auto; min-width: 0; overflow: hidden }`——
   放不下时尾部 chip 按既有 DOM 顺序（状态 pill → 需更新 → 计数 → @alias → #频道 → 未读 →
   ⏰）从右侧截断，目录名与状态标识不再被裁。detailed 密度沿用既有 Teleport 整体折行机制，
   不需要此规则。banner（汇总条/详情页提示条）行为不变。
4. `useOutdatedReload.ts` 头注同步更新（chip 从「不需要它」改为可选注入）。

## 改动文件

| 文件                                                                          | 内容                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/agents/agentCardModel.ts`                      | `statusLabelOf` 删 outdated 分支（签名随之去掉 `agent` 参数）                                                                                        |
| `src/web-hub/ui/src/components/agents/AgentCard.vue`                          | chip → button（compact + detailed 两处）；根节点 `data-outdated`；pill 去掉 outdated info 图标；注入 `OUTDATED_RELOAD_CTX`，点击 request/cancelQueue |
| `src/web-hub/ui/src/styles/agents.css`                                        | compact+outdated 的 `.agent-chips` 收缩截断规则                                                                                                      |
| `src/web-hub/ui/src/styles/outdated-reload.css`                               | `button.chip-outdated` 字体继承 + hover/focus                                                                                                        |
| `src/web-hub/ui/src/i18n/{zh,en}/common.ts`                                   | 删 `status.outdated`                                                                                                                                 |
| `src/web-hub/ui/src/i18n/{zh,en}/outdated.ts`                                 | 新增 `chipTitle` / `chipQueued` / `chipQueuedTitle`                                                                                                  |
| `src/web-hub/ui/src/composables/useOutdatedReload.ts`                         | 头注更新（无逻辑改动）                                                                                                                               |
| `tests/web-hub/ui/agent-list-density.test.ts`                                 | 新增 7 例：模型层 pill 不再被顶替、compact idle/running、detailed、非 outdated 不变、点击 request/取消、prevent 导航、无 provider 降级               |
| `docs/dev/web-hub/outdated-chip-preview.html` + `outdated-chip-preview/*.png` | 改前/改后预览（宽 400px / 窄 360px / detail 侧）与渲染截图                                                                                           |

断言意图未弱化：新测试钉住了「pill 恢复真实状态」「chip 唯一且可点击」「点击进入既有
reload 状态机」「非 outdated 逐字节不变」四个核心意图。

## 自验

- `npm run typecheck` ✅（tsc ×2 + vue-tsc 全过）
- `npx vitest run tests/web-hub/ui --maxWorkers=4` ✅ 268 文件 / 5917 测试全过
- `npm run build:web && npm run check:web` ✅（dist 门禁全绿）
- `npx prettier --write <改动文件>` + `npm run format:check` ✅
- `git diff --quiet HEAD -- tests/fixtures/` ✅ 零变化
- 截图核对：headless Chromium 渲染预览页（deveye 的 content script 在 localhost 页面不可
  注入，改用 `chromium --headless --screenshot`），改前列复现了现场的全部三个问题，改后列
  名称完整、pill 显示真实状态、尾部 chip 右侧截断、排队态可见。未动用户运行中的 hub。

## 建议 commit message

```
fix(web-hub): collapse the outdated-session prompt to one clickable chip per card

The sidebar banner already says N sessions are behind the hub, yet each
outdated card repeated it twice: a long status pill ("插件旧于 hub，需 /reload")
that replaced the real run state, plus a "需更新" chip. The long pill also
pushed @alias/#channel/unread chips off the card edge and squeezed the
directory name down to a single character.

- the status pill shows the real state again (idle/running/…); the
  `common.status.outdated` label is retired
- the card keeps a single compact "需更新" chip (warning tone) whose tooltip
  carries the full explanation; clicking it reloads that session through the
  existing outdated-reload coordinator (queued/parked phases show a spinner
  and click again cancels) — no new protocol path
- only outdated cards (new data-outdated attr) let the chip group shrink and
  clip trailing chips from the right, so the name and state marker are never
  cut off; non-outdated cards render byte-identical

Web UI only; wire/protocol/hub untouched. Preview: docs/dev/web-hub/
outdated-chip-preview.html (before/after, wide/narrow/detail).
```

## 残留风险

- R1：chip 的 tooltip 不含具体版本号（`AgentCardView` 是冻结契约，不带 `pluginVersion`；
  版本对比仍在详情页提示条/汇总条完整展示）。如需在 tooltip 里带版本，需扩契约，留待后续。
- R2：compact 行极端拥挤时尾部 chip 是「截断」而非「收进溢出菜单」；所有被截 chip 都有
  title/tooltip，详情页信息完整，可接受。
