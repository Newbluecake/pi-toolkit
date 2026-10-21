# W3 实施报告 — 跨切面集成（overlayRoots / 切换环 / HTML 凭据账本）

> 基线：HEAD `cbc60647`（W1 已合）。方案：`plan.md` r2 §11 W3 行 + §15 拍板 + r2 复审结论。
> W2（窗口组件、PreviewHost 外壳、preview.css、App.vue）并行开发，本包**未触碰任何 W2 文件域**。

## 改动文件

**新增（生产）**

| 文件                                                         | 内容                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/ui/src/logic/overlayRoots.ts`                   | §5.2 共享常量 `MODAL_OVERLAY_ROOTS = ".spawn-scrim, .picker-scrim, .preview-overlay:not(.is-modeless), .privacy-scrim"`                                                                                                                                                                                                                                                  |
| `src/web-hub/ui/src/logic/previewWindowCycle.ts`             | §5.6 纯函数：`previewCycleRing`（`["page", …order 倒序]`，防御性去重）、`previewCycleStep`（冻结环上 ±1 步进、环绕、未知条目 → null）                                                                                                                                                                                                                                    |
| `src/web-hub/ui/src/logic/htmlCapLedger.ts`                  | §8.2 纯类 `HtmlCapLedger`：mint-time 先清 TTL（idle=unmountedAt+`PV_IDLE_TTL_MS`、hard=mintedAt+`PV_HARD_TTL_MS`），`live ≥ PV_CAPS_PER_PRINCIPAL` 时 FIFO 逐个标 `evicted`（evicted 不再占位但保留 flag），`unmounted` 只记时、继续占位；常量全部从 `@protocol/preview-html.js` 导入                                                                                    |
| `src/web-hub/ui/src/components/preview/previewHtmlLedger.ts` | 注入键 `PREVIEW_HTML_LEDGER` + 响应式包装 `createPreviewHtmlLedger()`（单 `version` ref 驱动 `isEvicted` 重算）                                                                                                                                                                                                                                                          |
| `src/web-hub/ui/src/composables/usePreviewWindowCycle.ts`    | §5.6 composable：window keydown（bubble）监听，`code==="Backquote" && ctrlKey && !altKey && !metaKey`，Shift 定方向；守卫（无窗口 / `isComposing` / 文档存在 `[aria-modal="true"]`）；快照复用条件 `document.activeElement === lastFocused`；落窗 `focusWindow(id,{moveFocus:true})`、落页 `pageFocus() → .composer textarea → blur`；陈旧环落已关窗口时重取快照再走一步 |

**修改（生产）**

| 文件                                                                     | 改动                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirPicker.vue` / `SessionHistoryDialog.vue` / `PrivacyUnmarkDialog.vue` | 删除本地 `const OVERLAY_ROOTS`，改为 import 共享常量（选择器语义变化见下）                                                                                                                                                                                                                                                                                     |
| `ProxyDialog.vue`                                                        | 同上，本地 `PROXY_OVERLAY_ROOTS = MODAL_OVERLAY_ROOTS + ", .proxy-scrim"`（§5.2 规定的附加项）                                                                                                                                                                                                                                                                 |
| `PreviewHtml.vue`                                                        | ① inject 账本（缺省 null ⇒ 行为与现在逐字节一致）；② mint 成功记 `ledger.minted(cap.url)`、卸载记 `ledger.unmounted(cap.url)`；③ `evictedHint` computed → 工具条下 `<p class="preview-html-note" role="status">`（i18n `htmlMaybeEvicted`）；④ 工具条「重新加载」**常驻**（原 maybeStale 条件删除；`maybeStale` 仅保留提示文字，`expired` 横幅保留自己的按钮） |
| `styles/ask-float.css`                                                   | 层级表登记 25 档（`.preview-overlay.is-windows.is-modeless`），并把 60 档注释补上手机叠层说明。**仅注释**——实际 z25 规则在 W2 的 `preview.css`                                                                                                                                                                                                                 |
| `i18n/{zh,en}/preview.ts`                                                | 新增 `htmlMaybeEvicted`（zh 按 §8.2 原文），i18n-parity 通过                                                                                                                                                                                                                                                                                                   |

## 各项落实 vs 方案

- **§5.1 层级登记**：25 档已进 `ask-float.css` 唯一权威表（20 之下、30 之上，含语义说明）。`column-align.test.ts` 的 `.is-modeless` z25 断言属 W2 文件域，未动。
- **§5.2 OVERLAY_ROOTS 收敛**：4 个文件全部 import 共享常量；`:not(.is-modeless)` 保证桌面非模态根节点不参与「谁在最顶」判定。手机叠层与 AttachmentImagePreview 复用 `.preview-overlay` 基类、不带 `is-modeless`，语义原样保留（两个对话框测试反向钉住：后挂的模态 `.preview-overlay` 仍会挡）。
- **§5.6 切换**：键位按拍板 3（`Ctrl+`` / `Ctrl+Shift+``，`ev.code` 判定）；不生效条件三项全实现；MRU 环冻结防打转（专项用例：3 窗连续前进 3→2→1，重建环的实现会 2→3 反弹）；IME 组合、模态在场、无窗口、Enter/Tab 等作曲家键不受影响均有用例。
- **§8.2 HTML 凭据**：拍板 1（首版不做 W-H）落实为纯前端账本；「可能已被挤掉」提示 + 常驻「重新加载」；重铸造（新 token）天然清除提示；未注入账本时 byte-identical（专项用例）。
- **r2 复审处置**：pageFocus「任何落在窗口外的 focusin 都刷新」属 W2 的 §5.4 记录侧；本包通过 `pageFocus()` getter 每次落页现取，天然配合。账本 idle 假阳性、cycle MRU 抖动两条复审意见按方案不改（真机观察）。

## 自验

```
timeout 400 npx vitest run tests/web-hub/ui   → 210 files / 5056 tests 全绿（含 5 个新文件 56 用例 + 3 个对话框文件各 +1/+2 用例）
timeout 240 npm run typecheck                 → 0 错误（三段 tsc + vue-tsc）
prettier --check（全部改动文件）               → 通过
```

worktree 无 node_modules，测试/类型检查经符号链接到主仓依赖执行（`node_modules` 已 gitignore）。

## 偏差与说明

1. **evicted 提示复用 `.preview-html-note` 类**：方案 §9 把 `preview.css` 划给 W2，为避免与并行的 W2 改写冲突，提示段落复用既有 note 样式类、以 `role="status"` 区分语义（常驻沙箱说明仍是 `role="note"`）。若 W2 想要独立视觉，加一条 `.preview-html-evicted` 即可，无需改本包。
2. **`preview-html.test.ts` 一处既有断言适配**：PreviewText 的 toggle 用例原来 `findAll(".preview-toggle-btn")` 恰为 2；常驻 reload 也带该类，改为在 `.preview-toggle` 组内计数（断言语义不变）。这是「重新加载常驻」的必然后果，已在用例中注明。
3. **账本 `evictedOf` 对已被 TTL 清理的条目返回 false**：死亡凭据由 PreviewHtml 自己的 `expired` 横幅覆盖（60 分钟视野内 FIFO 提示与 TTL 提示不会互相竞争），`logic-html-cap-ledger.test.ts` 有边界用例。
4. **cycle 落窗的 `lastFocused` 记录是异步的**（host 落焦后两个 nextTick 读 `activeElement`）；期间再按键会走「重取快照」路径——方向仍正确，只是极端连按下环会重建。微任务级窗口，真机验收观察。
5. `PrivacyUnmarkDialog` 此前没有专属测试文件，按 §10.2「privacy-unmark 各加一条」新建 `privacy-unmark-dialog.test.ts`（只覆盖 topmost 语义，其余行为仍在 DashboardView 侧覆盖）。

## 需要 W2 配合的接线（PreviewHost 的两行，本包未改 PreviewHost）

```ts
import { createPreviewHtmlLedger, PREVIEW_HTML_LEDGER } from "./previewHtmlLedger.js";
import { usePreviewWindowCycle } from "../../composables/usePreviewWindowCycle.js";

// ① 账本 provide（setup 顶层，一次）：
provide(PREVIEW_HTML_LEDGER, createPreviewHtmlLedger());

// ② 切换 composable（face = asWindowsHandle(ctx.handle) 的结果；pageFocus 为 §5.4 的记录 ref）：
const winFace = asWindowsHandle(previewCtx.handle); // W2 本就持有
usePreviewWindowCycle({ face: winFace!, pageFocus: () => pageFocus.value });
```

W2 需保证的 DOM 契约（方案 §5.3/§7.2 已定，本包依赖并已写进 `previewCycleWindowIdOf` 的导出注释）：
每个 `.preview-window` 内含 `.preview-panel[aria-labelledby="pw-title-<id>"]`——该 id 是窗口身份在 DOM 里的唯一通道（v-for 的 `:key` 不进入 DOM）。`preview-window-cycle.test.ts` 的 harness 就是按这个契约搭的，W2 合入后可直接对生产 DOM 复用。
