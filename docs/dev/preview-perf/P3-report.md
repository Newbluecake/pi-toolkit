# preview-perf P3 实施报告 — 接线、查找、完整视图

- 日期：2026-10-23 · 分支 dev · 方案：`plan.md` r3（§0 已拍板项、§4 全部、§5.1/§5.2、§6.3 P3 行、§8.1 P3 行）
- 依赖（已提交）：冻结接口 `3c0deb88`（P1a）· P1 纯逻辑 + highlight codec `a229c3d4` · P2 虚拟组件 `ed0bb8fa` · P0 几何变量 `1e768c70`（前置）
- 文件域（全部在 P3 独占清单内）：

| 文件                                                                      | 改动                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/preview/PreviewText.vue`                   | 渲染选择接线（`chooseSourceRenderer`）、虚拟文本模型生命周期、§5.1 空闲高亮、§4.6 查找引擎与 Range 绘制、`update:findable` / `update:virtualizable` 通道、`openFind()` expose、流式哨兵入 VirtualCode slot                                                                                                            |
| `src/web-hub/ui/src/components/preview/PreviewWindow.vue`                 | Ctrl/⌘+F 拦截（面板根 keydown）、窗口级 `fullView` 状态与头部按钮、通道消费、`virtualEnabled` 测试缝透传                                                                                                                                                                                                              |
| `src/web-hub/ui/src/components/preview/PreviewFind.vue`                   | **新建**：查找栏（输入 + Aa + 计数 live region + prev/next/close + 常驻说明 + 截断区旁注；Enter/F3/⌘G/Shift 系；Esc 只关栏）                                                                                                                                                                                          |
| `src/web-hub/ui/src/composables/useFindHighlights.ts`                     | **新建**：文档级 CSS Custom Highlight 单例管理器（`pv-find` / `pv-find-cur`，按 owner 取并集）+ `::highlight` 规则的一次性 `insertRule` 注入                                                                                                                                                                          |
| `src/web-hub/ui/src/components/shared/highlight-core.ts`                  | §5.2：模块级 `resolvedPrism` 同步缓存 + `immediate` 模式（setup 内同步分词，首帧即高亮）                                                                                                                                                                                                                              |
| `src/web-hub/ui/src/components/shared/{NumberedCode,HighlightedCode}.vue` | `immediate` 透传 prop（§5.2 一次性调用方）                                                                                                                                                                                                                                                                            |
| `src/web-hub/ui/src/i18n/{zh,en}/preview.ts`                              | find/full-view 文案键（zh/en 同步，i18n-parity 绿）                                                                                                                                                                                                                                                                   |
| 测试                                                                      | 新建 `use-find-highlights` / `preview-find` / `preview-full-view` / `highlight-first-frame` / `highlight-load-failure`；改 `preview-line-numbers`（r0 用例改在 `virtualEnabled=false` 下跑 + 新增虚拟路径用例）、`preview-text`（stream 套件注入 `virtualEnabled:false`）、`preview-host`（stream wiring 选择器更新） |

**未动**：P1/P2 文件与冻结接口（`CodeLines.vue` 零改动；`VirtualCode/VirtualBlock/preview-virtual.css` 原样消费）、`CodeLines` 的 r0 流式分支、`source-scan.test.ts`、任何 CSS 文件、PB 包文件。

## 1. 接线点（对照 P2-report §5）

1. **渲染选择（§4.1 表）**：`PreviewText` 的 `rendererChoice` 走 P1 的 `chooseSourceRenderer`（`virtualEnabled` 优先级：`virtualEnabled` prop > `PREVIEW_VIRTUAL_KEY` provide > 构建期常量）。`virtual` ⇒ `<VirtualCode>` 整体替换 `<pre>`（非流式 >600 行；流式一律）；`legacy` / `numbered` / `numbered-capped` / `stream-lines` 保持 r0 三分支逐字节不变，只在开关为 true 时不可达。`linesCapped`/`nonStreamNumbered` 两个旧 computed 删除，模板条件改为 `rendererChoice === …`。
2. **rev tick**：`vRev = ref(source.revision)`；每次 `append` / `setHighlight` / 非流式整文重建后 `vRev.value = source.revision`（P2 的接线契约）。
3. **流式（§4.8）**：模型 setup 时 `forStream()` 并用当前已消费的 `copyValue` 播种（watcher 只在变化时触发——初始块不播种则首帧空体，已修）；此后 `watch(copyValue)` 增量 `append`。**不按 `virtualized` 门控**（渲染 md/fullView 期间也要追平，否则切回视图会静默缺尾巴）。哨兵 `.preview-stream-sentinel` 放 VirtualCode 默认 slot（spacer 之后、滚动容器之内）；IO root 用 expose 的 `scrollEl`；`more/loading/waiting/cap/changed/error` 状态行与按钮留在 actions row（原位不动，§6.3 回归测试钉住）。
4. **§5.1 空闲高亮**：首帧纯文本 → `loadPrism()` → `scheduleIdle`（`requestIdleCallback`，缺省回落 `setTimeout 50`，`timeout:500`）→ 手势期（`body.pwh-pw-dragging`）或 150 ms 内有 scroll 则重排队 → 主线程 `tokenize + flattenTokens + encodeHighlightSpans` → `setHighlight` → 只重绘已挂载块。闸门维持原值（`shouldHighlight` 默认 100 KiB/3000 行/20k token）；**流式不高亮**（§5.3，与 r0 一致）；文本整体变化（同路径重试）使 epoch+1 作废在途分词后重排。
5. **§5.2 首帧即高亮**：`highlight-core` 增 `resolvedPrism` 同步缓存（promise 落定时写入）；`useHighlightParts(source, { immediate })` 在引擎已落定时 **setup 内同步算出 parts**（首帧就是高亮 VNode）；冷加载先纯文本、到达后替换一次；失败永久纯文本。`PreviewText` 的一次性 `NumberedCode`/`HighlightedCode` 调用传 `immediate`；transcript `CodeBlock` 不传（150 ms 契约逐字节不变）。
6. **查找（§4.6）**：引擎 = P1 `createPreviewFinder`（owner: PreviewText）；`PreviewFind` 纯展示 + 键位；命中 Range 只为**已挂载块**构建（post-flush `nextTick`），交 `useFindHighlights` 单例；当前项 `scrollToLine(line,"center")`。不支持 Custom Highlight 的引擎回落为「当前项设为原生 selection」（§4.5 选区规则随之生效，属预期）。查询输入 120 ms 去抖；append 增量补搜；流式终态 `finder.flush()`。
7. **完整视图（§4.7）**：`fullView` 是 PreviewWindow 的窗口级 ref（跨文件导航保留、关窗即弃）；传入 PreviewText 后 `chooseSourceRenderer` 走 `legacy`（与行号关同一 DOM——测试钉了 `outerHTML` 逐字节相同）；头部按钮由 `update:virtualizable`（按 `fullView:false` 计算，按下时仍可见可取消）驱动，`aria-pressed` + 方案定稿 tooltip。

## 2. Ctrl+F 规则（写实实现）

PreviewWindow 面板根 `@keydown`：`Ctrl/⌘+F` 且 ① `findable`（当前视图**是**虚拟源码视图）② 焦点不在 `.pv-find-input`（在查找框内 ⇒ 放行给浏览器**页面查找**）③ 非 IME 组合（`!isComposing && keyCode!==229`）④ 未被 `defaultPrevented` ⇒ `preventDefault` + `PreviewText.openFind()`（聚焦输入并全选）。完整视图开 / 行号关 / 非虚拟体 / 焦点在窗口外 ⇒ 一律不拦截（拦截矩阵有逐条用例）。查找栏键位：Enter/Shift+Enter、F3/Shift+F3、Ctrl/⌘+G(+Shift) 全部 `preventDefault`（不落给浏览器 find-again）；组合中的 Enter 忽略；**Esc `preventDefault + stopPropagation`，只关查找栏**，焦点回滚动容器——PreviewHost 的 Esc 分支读 `defaultPrevented`，窗口存活（联测钉住）。常驻说明（含 Mac ⌘G/⇧⌘G 变体、页面查找只含可见行的提示）与计数 live region（`role=status`，`cur / n`，上限 `10000+`）齐备。

## 3. 完整视图

见 §1.7。全局行号开关不受影响；兄弟窗口不受影响（两窗并测）；窗口内导航后保持（loading→新 text 视图仍 legacy，按钮可取消回虚拟）。

## 4. 选区与高亮时序（P3 侧的责任边界）

- 选区冻结/逻辑全选/2048 上限状态机在 VirtualCode（P2，未改）。P3 保证的时序：**每次** `append`/`setHighlight`/重建后 bump `vRev` ⇒ P2 watcher 按语义失效（append 且 delta==1 ⇒ 只动 `[fromLine,…)` 触及的块——文本节点 identity 保持；highlight/init/多跳 ⇒ 全清；**冻结期一律排队**，折叠后 flush）。§6.1 的真机选区断言归 PB/P4。
- 高亮到达（§5.1）只经 `setHighlight` 一条路；文本变化（重试）重建模型并作废在途分词，不会出现旧分词落到新文本。
- 流式 append 期间选区活跃 ⇒ P2 冻结已挂载块，同时新块按当前 revision 挂载并入冻结集（P2 语义，P3 不干预）。

## 5. 与方案的偏离 / 内部化决策（逐条）

1. **VirtualCode 的窗口数学未换成 P1 纯函数**（P2-report §5.6 接线点）：`VirtualCode.vue` 是 P2 独占文件域，P3 不得改。其内联实现按 §4.3/§4.5 语义编写（P2 报告 §3.1 自证），`logic/previewVirtual.ts` 的 `computeWindow/maxLines/reanchor` 由 P1 测试覆盖。**留给后续小包/下任 owner**（机械替换）。
2. **VirtualCode 本地 STRINGS 字典未迁 i18n**（P2-report §5.5）：同上（P2 文件）。P3 的 i18n 键只覆盖新面（查找栏/完整视图）；`i18n/{zh,en}/preview.ts` 预留了同形键位可迁。
3. **查找查询输入剥离 CR/LF**（UI 层归一化）：`PreviewFind` 在 input 事件把 `\r\n` 去掉。方案 §4.6 的贪心/折叠语义不变——只是单行输入框不产生跨行命中，使「命中⇔DOM Range」保持在单行内（截断钳制、节点映射都因此简单可靠）。多行查找的逃生口是完整视图 + 浏览器原生查找（与 K1 同路）。
4. **`::highlight` 样式与查找栏布局无 CSS 文件可用**（P3 文件域无 CSS；`<style>` 块被 source-scan 全禁；JS 建 `<style>` 元素会被 `style-src 'self'` 拒）：`useFindHighlights` 用 **`insertRule` 注入既有同文档样式表**（纯 CSSOM、CSP 干净、一次性、带 try/catch——不支持的引擎只是不画色，不崩）；`PreviewFind` 的少量布局规则走**对象 `:style` 绑定**（csp-probe 验证过的 CSSOM 形态）+ 既有 `btn btn-ghost btn-icon` 类。视觉微调可随后续 CSS 包落地。
5. **`viewportTopLine()` 用首个已挂载块的 `data-start` 当视口顶的代理**（「查询变化后当前项落到 ≥ 视口首行的第一个命中」）：VirtualCode 未 expose 几何（P2 冻结），块覆盖视口 ± overscan，代理足够（首块起点 ≤ 视口首行）。已注释说明。
6. **withDefaults(undefined) 修 Boolean casting**：`fullView` / `virtualEnabled` 这类可选布尔 prop，Vue 会把「缺省」cast 成 `false`——PreviewText 直接挂载时虚拟开关被静默关掉（这正是先跑旧用例全绿的原因：它们一直在测 `virtualEnabled=false`！）。两个组件都用 `withDefaults(…, { …: undefined })` 显式退出 cast，并在注释里写明。**这是接线层最大的坑，值得记住。**
7. **PB source-scan 失败（见 §7）**：不是本包文件。
8. `preview-host.test.ts` 的 stream wiring 用例选择器从 `.preview-stream` 改为 `pre.pv-virtual` + `.preview-stream-sentinel`（流式现在一律虚拟；r0 容器在 `virtualEnabled:false` 下由 preview-text/preview-line-numbers 钉住）——符合 §6.3 preview-host 行「断言改为新现实」的精神。

## 6. 自验（2026-10-23，本机）

- `npx vitest run tests/web-hub/ui --maxWorkers=2`：**5550/5551 通过**。唯一失败：`source-scan.test.ts` 扫出 **PB 包在途未跟踪文件** `src/web-hub/ui/csp-probe/preview-perf.ts` 的 rAF——P2 报告 §6 已把该豁免（加白名单或挪注入脚本）派给 PB 包；该文件不属 P3，未动。P3 触碰的 17 个文件零 offender（失败清单只含上述一个文件）。
- `npm run typecheck`：**通过，零输出**（本次运行没有出现 src/traffic 并行包报错，无需忽略项）。
- `npm run build:web && npm run check:web`：**通过**（first-screen JS 345080B gz / 512KiB——比 PB 基线 +≈10.9 KiB gz，方案预估 +8~10 KiB，略超但仍在预算内且不拆块；CSS 35126B / 64KiB，+≈225B）。
- `npx prettier --check`（P3 全部触碰文件）：**通过**。

## 7. PB 开关位置（待接）

- **开关**：runner `--virtual` → 页面 `?virtual=1`（`csp-probe/preview-perf.ts` 的 `virtualOn`，现只写 `data-pp-virtual` 与 `window.__pp.virtual`，对渲染**尚无作用**——P3 之前虚拟路径不存在，P3 之后**生产默认即虚拟**（>600 行 / 流式）。
- **待接一行**：`preview-perf.ts` 需要 `provide(PREVIEW_VIRTUAL_KEY, virtualOn)`（key 从 `components/preview/PreviewText.vue` 命名导出，测试缝优先级 prop > provide > 常量）。这样 `--virtual` 跑虚拟用例、缺省跑 r0 基线，正好复用 PB 的双态结构。该文件属在途 PB 包（与 source-scan 白名单一起），P3 未改。
- PB 报告 §1.1 承诺的「虚拟用例（pv-virtual 块断言、滚动/选区/查找 §6.1 功能项）随包补上」仍待 PB/P4 侧补——P3 侧全部前提（虚拟默认开启、几何/查找 expose、哨兵/IO root）已就绪。

## 8. 遗留 / 风险登记

- 多行查询（含 \n）不进窗内查找（§5.3 偏离），走完整视图/页面查找。
- 命中 Range 不跨行；跨块命中正常（逐块二分）；跨「已挂载↔未挂载」边界的命中只有滚动到附近才有标记（§4.6 原文如此）。
- `requestIdleCallback` 在 happy-dom 不可用 ⇒ setTimeout 50ms 回落（§5.1 原文路径）；真机 idle 行为 PB/P4 复测。
- 查找栏视觉是最小可用版（对象 :style + 既有按钮类），非最终视觉——见 §5.4。
- VirtualCode 窗口数学/字典迁移两件机械活留给下任 owner（§5.1/§5.2）。
