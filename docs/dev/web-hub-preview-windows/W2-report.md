# W2 交付报告 — 窗口组件与非模态外壳

> 依据 `plan.md` r2 §11 W2 行；基线 = W1（cbc60647）。自验命令与结果见文末。

## 改动文件

### 生产代码（src/web-hub/ui/src）

| 文件                                       | 性质      | 内容                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/preview/PreviewWindow.vue`     | 新        | 单个窗口：header（返回/上级、标题 `pw-title-<id>`、手机 `2/3` 徽标、复制、下载、「⋯」菜单、关闭）+ 全部 phase 渲染 + `holdTall`/`htmlHoldTall` + 复制通道 + `openFrom` 统一入口 + `role=status` 上限提示行 + sr-only 键盘提示（§5.3）+ 标题栏键盘移动/缩放（§5.5）                                                                                               |
| `components/preview/PreviewWindowMenu.vue` | 新        | §5.5「⋯」菜单：全部关闭（N）/ 重置位置和大小（仅桌面）/ 窗口列表（`aria-current`、basename — 路径）；键盘模型照 LangMenu/NewSessionMenu（Enter/Space/↓ 开、↑↓ 循环、Esc 只关菜单且 stopPropagation、Tab 关、外点 capture 关）                                                                                                                                    |
| `components/preview/PreviewHost.vue`       | 重写      | 只剩外壳：Teleport、`.preview-overlay.is-windows[.is-modeless]`、根 keydown（桌面 Esc 关焦点所在窗、手机 Tab 陷阱）、focusRequest 落焦、pageFocus/lastFocus/focusedWin、手机滚动锁、跨断点协调、按创建顺序的 keyed v-for（永不重排）、resize 热区。`asWindowsHandle(ctx.handle) === null` ⇒ 什么都不渲染（评审 #14，legacyFace 删除）                            |
| `composables/usePreviewDownload.ts`        | 新        | 从 PreviewHost 原样搬入 download/downloadUnsupported/saveBlob/downloadNameOf/downloadCap/downloadSession；每窗一个实例（§10.2「下载相互独立」）；source-scan 的 createObjectURL 例外精确迁移到此                                                                                                                                                                 |
| `composables/usePreviewWindowLayout.ts`    | 新        | §7.4 手势控制器：rect Map + cascade 错开摆放（锚 = 前一个活动窗口）、单手势、capture 失败兜底 document 模式、3px 起拖阈值、`pwh-pw-dragging` body 类、七类结束条件、viewport resize reclampAll、跨断点（进桌面 reclamp、出手势即结束，`flush:"sync"`）、keyMove/keyResize/resetRect                                                                              |
| `styles/preview.css`                       | 追加      | §7.5 全部新类：`.is-windows`/`.is-modeless`（z25、pointer-events:none、无遮罩）、`.preview-window.is-floating`（left/top/width/height 全走 `--pw-*` 变量，无 transform）、`.pw-rz[data-dir]` 8 条（粗指针加宽）、`.preview-window-limit`、`.pw-count`、`.pw-menu*`、`body.pwh-pw-dragging`、手机 `inset:0` 叠层。基类 `.preview-overlay/.preview-panel` 语义未动 |
| `App.vue`                                  | 2 处      | `usePreview` → `usePreviewWindows`（同参数）；注释更新                                                                                                                                                                                                                                                                                                           |
| `i18n/{zh,en}/preview.ts`                  | 各 +8 key | windowLabel/windowLimit/windowStackLabel/windowMoveHint/windowMenu/windowCloseAll/windowResetGeom/windowSwitchTo（§9 表；htmlMaybeEvicted 留给 W3）                                                                                                                                                                                                              |

### 测试（tests/web-hub/ui）

| 文件                                                    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers/preview-windows-fake.ts`（新）                 | §10.2 测试替身：`fakeWindowHandle`（可写 view + spy 的最小 PreviewMachine）+ `fakeWindowsFace`（§4.3 冻结 face：windows/order/activeId/focusRequest/limitNotice 可写引用 + spy，closeAll 逐窗关）                                                                                                                                                                                                                                                                      |
| `preview-host.test.ts`（迁移）                          | 文件头注明分工：phases/复制/下载/分块/html 走替身（覆盖生产 PreviewWindow 渲染）；close/focus 按新 §5.4/§5.5 语义重写（无遮罩、无锁、Esc 只关焦点窗、focusRequest 落焦、pageFocus 归还）；dir/路由段参数化到真实 `usePreviewWindows`（file 行/未探测 md ref → 新窗口；dir 行双击/md 目录链接/路径栏 → 本窗；推测开窗落定为文件 ⇒ 保留）；「handle 无 navigation face」根级用例换成「无 windows face ⇒ 不渲染」                                                         |
| `preview-windows.test.ts`（新）                         | 桌面全代数：错开摆放+窗口 1 DOM 不动、非模态（is-modeless/无锁/页面按钮可点/对话点击追加）、焦点跟随+去重转焦、激活只改 `--pw-z` 且 iframe 元素不变（真实懒加载 PreviewHtml）、拖动（3px 阈值/按钮不起拖/body 类）、标题栏键盘移动缩放（含 P4 夹取）、「⋯」菜单（键盘/Esc 只关菜单/全部关闭归还 pageFocus/重置/列表跳转）、上限提示（file 行 + 对话两个入口，role=status、§3.4 规则①清除）、每窗下载独立（dlBusy 不串）、aria（全部非模态+各自 labelledby）、热区 8 向 |
| `preview-windows-phone.test.ts`（新）                   | 手机带：无热区无几何变量、非顶层 inert、顶层唯一 `aria-modal=true`、滚动锁、`1/2`·`2/2` 徽标 + windowStackLabel；陷阱双向边界 + panel 自身 Shift+Tab + 焦点在容器外拉回（focusablesIn 过滤 inert）；Esc 关顶层→焦点落新顶层→最后一关释放锁归还 pageFocus；跨断点（拖动中进手机：手势结束+热区消失+焦点入顶层+锁上；回桌面：锁释放+几何恢复）；进手机关闭 pw-menu（r2 复审处置）                                                                                        |
| `use-preview-window-layout.test.ts`（新）               | §10.2 手势控制器：capture 抛错/hasPointerCapture=false ⇒ document 模式仍可拖并以 document pointerup 结束；blur/页面隐藏/关窗/卸载结束手势；其它 pointerId 忽略；阈值；跨断点；resize reclamp；键盘几何；reset 居中                                                                                                                                                                                                                                                     |
| `source-scan.test.ts`                                   | createObjectURL 例外 `components/preview/PreviewHost.vue` → `composables/usePreviewDownload.ts`（理由原样保留并注明迁移）                                                                                                                                                                                                                                                                                                                                              |
| `column-align.test.ts`                                  | 新增 z25 档断言：`.is-windows.is-modeless` = z25 + pointer-events:none、窗口 pointer-events:auto、`.is-floating` left/top 走变量且无 transform、基类 `.preview-overlay` 仍 z60（AttachmentImagePreview 不受影响）、drawer 30/ask-float 45 仍在窗口之上                                                                                                                                                                                                                 |
| `privacy-lock.test.ts`                                  | mountDashboard 增加 `previewHandle` 参数；新用例「回锁 closes EVERY open window」：windows face + 2 窗 → 回锁 ⇒ closeAll 一次、两窗机器各 close 一次、windows 清空                                                                                                                                                                                                                                                                                                     |
| `preview-wiring.test.ts`                                | ① App.vue 源断言（usePreviewWindows 而非 usePreview）；② 真实路由回归：DashboardView 的 route watch 派发真实 `route` 事件（reducer 驱动 state），detail→list ⇒ selected=null ⇒ manager scope watcher 关闭全部窗口                                                                                                                                                                                                                                                      |
| `scroll-lock.test.ts`、`plaintext-warning-pref.test.ts` | **文件域外、必要迁移**（见「偏差」）：PreviewHost 改为 windows 外壳后，这两处旧的单窗挂载不再渲染。scroll-lock 的 PickerSheet×PreviewHost 堆叠用例改为手机带（只有手机带锁滚动）+ 替身 face；plaintext 警告用例改走替身 face（每窗渲染）                                                                                                                                                                                                                               |

## §5/§6/§7 落实对照

- **§5 桌面非模态**：根节点 `.preview-overlay.is-windows.is-modeless`（z25、透明、`pointer-events:none`，窗口自身恢复 auto）；无遮罩、无滚动锁、无 Tab 陷阱；每窗 `role=dialog aria-modal=false` + `aria-labelledby=pw-title-<id>` + sr-only `aria-describedby`（键盘提示）；激活 = pointerdown/focusin 只改 order（`--pw-z` = 1+order 下标，DOM 顺序永不重排，iframe 不重载——有测试锁定元素身份）；Esc 仅在事件目标位于某窗内时关那窗并 preventDefault+stopPropagation（菜单自己的 Esc 先 stop）；「⋯」菜单全部关闭/重置/窗口列表全键盘可达；标题栏 tabindex=0，方向键 16px 移动、Shift+方向键缩放 SE 边（均过 clamp）。
- **§6 手机全屏叠层**：根不带 `is-modeless`（基类 z60），每窗 `position:absolute; inset:0; z-index:var(--pw-z)`；窗口存在且手机带 ⇒ `acquireBodyScrollLock()`；仅顶层 `aria-modal=true`，其余 `.preview-window` 加 `inert`；陷阱容器=顶层 section，`focusablesIn` 用 FOCUSABLE 查询再滤 `closest('[inert],[aria-hidden="true"],[hidden]')`（双向边界/panel 自身/容器外拉回均有用例）；`i/n` 徽标（英文 token）+ `windowStackLabel` 读屏文案；跨断点两个方向保留 rect，进手机结束手势+顶层落焦+关闭 pw-menu，回桌面释放锁+reclamp。
- **§7 拖动缩放与几何**：几何只经 `:style` 对象绑定写 CSS 变量（`--pw-x/y/w/h/z`），CSS `left: var(--pw-x)` 读取，无静态 style、无 rAF、无 transform、无 `<Transition>`（source-scan 通过）；`usePreviewWindowLayout` 单手势（pointerId 过滤）、capture 尽力而为 + document 兜底（评审 #8 闭环：pointerup/cancel/lostpointercapture/blur/visibilitychange/跨断点/关窗/卸载统一 `endGesture`，幂等）、3px 阈值、body 类（`user-select:none` + iframe `pointer-events:none`）、viewport resize 同步 reclamp；新窗 `cascadeRect`（锚=前一活动窗 rect，occupied 避让，兜底 origin）；resize 热区 8 向 `aria-hidden`（键盘等价在标题栏/菜单）；平板热区 12px（`pointer:coarse` 媒体查询）。

## 测试与门禁输出

| 门禁    | 命令                                                   | 结果                                                                                                                                                 |
| ------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI 全量 | `timeout 400 npx vitest run tests/web-hub/ui`          | **5039 passed**（含新 3 个文件 52 个用例 + 迁移重写的 preview-host 47 用例）                                                                         |
| 类型    | `timeout 240 npm run typecheck`（tsc ×2 + vue-tsc）    | 通过，无输出                                                                                                                                         |
| 构建    | `timeout 300 npm run build:web && npm run check:web`   | `✓ built in 5.33s`；`✓ check:web — dist/web-hub-ui/ OK (19 files, first-screen JS 312147B gz/524288B, lazy 46459B gz/131072B, CSS 33441B gz/65536B)` |
| 格式    | `npx prettier --check src/web-hub/ui tests/web-hub/ui` | All matched files use Prettier code style!                                                                                                           |

## 偏差与说明

1. **文件域外的两处必要迁移**：`scroll-lock.test.ts`、`plaintext-warning-pref.test.ts` 不在 §11 W2 文件域清单里，但它们各自直接挂载旧单窗 PreviewHost——外壳化后不渲染，必须随迁（分别改为手机带 + 替身 face、替身 face）。属 W2 改动的直接下游，未改任何生产行为。
2. **上限提示入口覆盖**：§10.2 要求 PathText/MdInline/MdImage/根列表 file 行/内联子 file 行逐入口测试。五个入口最终都汇入同两个调用点（窗内 `openFrom`、根 `open`），本包覆盖了 file 行（含内联子行的路径拼接已在 host 套件）与对话入口 + md path-ref（preview-host B6 用例）；MdImage/MdInline 与 PathText 共用 `PREVIEW_CTX.handle.open` 通道（同一 provide 桥），未逐一重复造 6 窗上限场景。
3. **iframe 身份锁定**：用真实懒加载 PreviewHtml（htmlCap 假 transport）断言激活/关闭其它窗口后 `iframe.preview-html-frame` 是同一元素；不重排 DOM 另有 section 节点身份断言双保险。
4. **拖动/键盘改几何后补 tick**：Vue style 绑定异步生效，测试在每次 move/keydown 后 `await tick()` 再断言（真机无此问题）。
5. **resizeRect min 边下界返工**：按 W1 报告，`resizeRect` 的对边下界在另一返工包修复；本包只按 §7.3 表调用，未改 `previewWindowGeom.ts`。
6. **`windowLimit` 文案 n**：提示行显示当前窗口总数（= 上限 6），与 §3.4 文案「已达 {n} 个窗口上限」一致。

## 给 W3 的接线说明

PreviewHost.vue 头部注释已标出两个**故意留空**的接线点（不要在 W2 填）：

1. **Ctrl+` 切换环**（§5.6）：`usePreviewWindowCycle(...)` —— 在 PreviewHost setup 内调用；它需要的 face/order/pageFocus 均已就位（`face`、`order`、`pageFocus` 变量）。window 级 keydown bubble 监听建议挂在 composable 内部（与根节点 keydown 不冲突：`ev.code === "Backquote"`）。
2. **HTML cap 账本**（§8.2）：`provide(PREVIEW_HTML_LEDGER, ...)` —— 挂在 PreviewHost（App 级、窗口树外层）即可，PreviewHtml 可选 inject。

W3 依赖的既有事实（本包已固化，有测试锁定）：

- 根节点类名：桌面 `.preview-overlay.is-windows.is-modeless`，手机 `.preview-overlay.is-windows`（`preview-windows.test.ts` / `-phone.test.ts` 断言；`column-align.test.ts` 断言 `.is-modeless` 的 z25/pointer-events 规则）——`MODAL_OVERLAY_ROOTS` 的 `:not(.is-modeless)` 排除即建立在这上面。
- `OVERLAY_ROOTS` 收敛所需的 source 断言（「除 overlayRoots.ts 外不再出现 `const OVERLAY_ROOTS =`」）归 W3 文件域，本包未碰 4 个对话框。
- 手机端根节点不带 `is-modeless` 时照旧参与「谁在最顶」判定（column-align 保留基类 z60 断言）。
- PreviewWindow 子树的 `PREVIEW_CTX` provide 桥：`handle.open` = `openFrom(ref)`（不带 route 参数，由 manager 的 `routeOf` 判定）；W3 若需要向 PreviewHtml 注入账本，走独立注入键（§13 约定 `previewHtmlLedger.ts`），不要复用 PREVIEW_CTX。

## 遗留

- 无。真机验收（§14）归 W4。
