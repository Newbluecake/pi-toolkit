# preview-perf P2 实施报告 — 虚拟渲染组件

- 日期：2026-10-23 · 分支 dev · 方案：`plan.md` r3（§4.2–§4.5、§6.3 P2 行、§8.1 P2 行）
- 文件域（全部新建，未动任何既有文件）：
  - `src/web-hub/ui/src/components/shared/VirtualCode.vue` — 窗口/几何/选区状态机 + 滚动容器
  - `src/web-hub/ui/src/components/shared/VirtualBlock.vue` — 32 行块的哑渲染器（render function）
  - `src/web-hub/ui/src/styles/preview-virtual.css` — 虚拟体样式（由 VirtualCode 组件内 import）
  - `tests/web-hub/ui/virtual-code.test.ts` — P2 名下 18 条用例
  - `tests/web-hub/ui/helpers/virtual-source-stub.ts` — **测试目录内**的 `VirtualTextSource` 桩（P1 合入后由对接包删除）
- 依赖面：只 import 冻结接口 `@logic/previewVirtualTypes.js`（类型 + 常量）与既有的
  `@logic/previewLines.js#lineNumberDigits`、`useSharedResize`、`useI18n`。**没有 import 任何 P1 新文件**；
  `CodeLines.vue` 零改动（`git status` 确认未触碰）。

## 1. 组件 API

### VirtualCode.vue（P3 在 PreviewText 的虚拟分支里整体替换 `<pre class="preview-text-body">`）

Props（全部只读语义）：

| prop              | 类型                        | 说明                                                                                                                                                        |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`          | `VirtualTextSource`（必填） | 冻结接口 §4.2 的文本模型。组件**不拥有**它，只读。                                                                                                          |
| `sourceRevision`  | `number`（可选，默认 0）    | **响应式 tick**：模型本身是普通对象（冻结接口无响应性），父组件在每次 `append`/`setHighlight` 后把它 +1。漏 bump ⇒ DOM 停在旧 revision（接线契约，见 §5）。 |
| `rowHeight`       | `number`（可选）            | 测试注入行高（happy-dom 测不出探针）。给了就跳过探针测量；运行时变化走重锚点路径（§4.3）。                                                                  |
| `viewportHeight`  | `number`（可选）            | 测试注入视口高；不给则 mount 时读 `clientHeight` 并 `observeResize(scrollEl)` 跟随。                                                                        |
| `selectionActive` | `() => boolean`（可选）     | 测试注入：整体替换内部选区活跃判定（§4.5 同步判定的注入缝）。                                                                                               |

Expose：`scrollToLine(line, where?: "start" | "center")`（§0：本期唯一行导航 API）、`scrollEl`（P3 流式 IO 的 root）。

DOM 结构（模板已核对：`<pre>` 内部**无空白文本节点**，编译产物无 textVNode——`white-space: pre` 下不会有幻影行盒）：

```
div.pv-vwrap                      ← 接管 .preview-text-body 原来的 flex 槽（flex:1/min-height:0），探针的定位上下文
├ pre.preview-text-body.pv-virtual[tabindex=0][aria-describedby]  ← 滚动容器；white-space:pre、overflow-anchor:none
│ ├ span.pv-spacer[.is-all-selected]     ← CSSOM 内联：--pvline-w / --pv-row-h / height / min-width（纯 ch 字面量 + var(--sp-3)）
│ │ └ VirtualBlock（每块一个，绝对定位 top=bi×32×rowH）
│ ├ span.pv-cap-note[role=note]          ← 仅 lineCount > maxLines 时渲染
│ └ <slot/>                              ← P3 接线点：流式哨兵 + 状态行（§4.8 要求在 spacer 之后、滚动容器之内）
├ span.pv-vprobe[aria-hidden]            ← 行高探针，pre 的同级兄弟（§4.3），observeResize 跟随字号/字体加载
├ span.sr-only#pv-vdesc-N                ← §4.7 的 sr-only 说明（aria-describedby 指向）
└ span.sr-only[role=status]              ← 全选拨报 / 选区超限提示
```

事件（组件内消费，不外发）：`keydown`（Ctrl/⌘+A 逻辑全选、Esc/Shift 系取消）、`pointerdown`（取消全选 + 拖选起点）、`copy`（全选时写全文）、passive `scroll`（手动 addEventListener，模板 v-on 无法声明 passive）、document 级 `pointerup`/`selectionchange`。

### VirtualBlock.vue（哑渲染器，render function）

Props：`lines: readonly DisplayLine[]`、`start: number`（首行行号，`counter-reset = start−1`）、`topPx: number`（绝对定位 top）、`clipLabel: (n:number)=>string`。根 `span.pv-lines.pv-vblock[data-start]`；**块根不设 `--pvline-w`**（§4.2 差异点 1，gutter 统一在 spacer）。行结构严格按 r3 §R2 #1：`parts →（clipped>0 时）空 span.pv-vclip[data-clip][data-clip-label] → eol 文本节点（恒为最后一个子节点）`；标记只有 `::before` 生成内容，不进 DOM 文本/选区/复制；行号 `::before` 用 `content: counter(pvline) / ""`（alt 空串，§4.2 读屏决策）。四个 props 全是原语或稳定引用——这正是 §4.5「props 引用冻结 ⇒ Vue 浅比较跳过子树」的机制基础（测试断言到了文本节点级 identity）。

## 2. 选区冻结状态机（§4.5）

状态：`frozenLines: Map<blockIndex, DisplayLine[]> | null`（非空 = 冻结中）+ `blockCache: Map<blockIndex, {rev, lines}>`（常规路径）。

```
updateWindow()（每次 scroll/resize/tick/selectionchange/props 变化都先跑）
  ├─ 同步调 selectionActiveNow()（注入优先；否则 pointerdown-in-body 期间 ‖ getSelection 非折叠且 intersectsNode(spacer)）
  ├─ active ∧ 未冻结 ⇒ startFreeze()：把当前已挂载块的 lines 数组**按引用**快照进 frozenLines
  ├─ ¬active ∧ 冻结中 ⇒ endFreeze()：清 frozenLines + 清 blockCache（保守：全部按当前 revision 重算）
  ├─ 算 fresh 窗口 [lo,hi)（连续块区间）
  ├─ active：union(min lo, max hi)——只增不减；若 (hi−lo)×32 > 2048 ⇒ 回退 fresh 窗口 + role=status 提示（每次冻结只提示一次）
  └─ pruneTo(lo,hi)：窗口外缓存逐出
```

- **冻结期的 revision 到达**（watcher：`sourceRevision` 变化）：不触碰任何缓存，只 `queued=true` + `updateWindow()`（append 仍可能让新块挂载——新块按**当前 revision** 计算并随即入 frozenLines，「已挂载 ⇒ props 冻结」对后挂载的块同样成立）。
- **非冻结期的 revision 到达**：`lastChange.kind === "append"` 且 tick 增量恰为 1 时，只删「块内末行 ≥ fromLine」的缓存项（⇒ 只有最后一个未完成行所在块 + 新块重绘，其余块的数组引用与文本节点不变——§6.3/§4.8 断言到 textNode identity）；highlight / init / 增量 >1（一次 flush 合并多跳，lastChange 不足以判定）⇒ 全清（保守）。
- **解除**：`selectionchange`（异步即可，§4.5 只用于收缩）→ `updateWindow()` → endFreeze。
- **逻辑全选**：`allSelected` 是与 DOM 无关的布尔。Ctrl/⌘+A（pre 内、非合成输入）preventDefault + `removeAllRanges()` + spacer `.is-all-selected`（Highlight/HighlightText 系统色）+ 拨报「已选中全部 N 行」。copy 事件写**复制当下**的 `source.text()`。取消矩阵只含明确新选择动作：体内 pointerdown、Shift+方向/PageUp/PageDown/Home/End、Esc、selectionchange 出现新非折叠选区；scroll/append/highlight/blur 不取消（矩阵有逐条用例）。

## 3. 与方案的偏离 / 内部化实现（对接清单）

1. **窗口数学内联**（`computeWindowRange` + 半块滞回 + overscan 1/1.5 屏 + `min(500k, floor(15e6/rowH))` + 重锚点公式）：语义按 §4.3/§4.5 实现，但代码在 VirtualCode 内——**P1 合入后对接包应换成 `logic/previewVirtual.js` 的 `computeWindow` / `maxLines` / `reanchor`**。函数已按该签名语义隔离（一个纯计算函数 + reanchor 一个），替换是机械的。
2. **UI 文案本地字典**：`STRINGS{zh,en}`（clip 标记 alt「本行超长，已截断 {n} 个字符」、全选拨报、选区超限提示、上限尾注、sr-only 说明——全部方案定稿文案）放在 VirtualCode 内、经 `useI18n().lang` 选语言。原因：`i18n/{zh,en}/preview.ts` 是 P3 独占文件域。**P3 接线时应迁成 `t("preview.*")` 键**（键形状已按现有 preview 命名空间风格准备好）。
3. **`PREVIEW_VLINE_MAX_PARTS`（>1000 part 的行按纯文本）**：冻结接口把该规则描述为「check happens on the main thread, only affects rendering」。P2 渲染器按 displayLine **逐字渲染**，未实现该闸门——理解为 P1 `displayLine` 的职责（§5.3 原文「在 displayLine 中按纯文本显示」）。若作者意图是渲染器做，对接时在 `freshLines` 加一行即可。
4. **重锚点的写序**：方案要求 RO 回调内同步写 spacer 高度 + scrollTop。实现为 `rowH` 响应式更新 + `nextTick` 里重写 scrollTop（Vue 的补丁在微任务 flush，仍先于 paint；happy-dom 与真实浏览器行为一致）。若 PB 探针发现首帧跳动，可改为 RO 回调里直接 CSSOM 写 spacer 再同步写 scrollTop。
5. **`overflow-anchor: none`** 加在 `.pv-virtual`（方案未提）：防止原生滚动锚定与虚拟窗口互搏（块卸载会撤销锚点节点）。属防御性补充。
6. **`sourceRevision` prop**：方案没规定模型变化的通知通道（冻结接口无响应性）；这是 P2 引入的接线契约，P3 必须在每次 append/setHighlight 后 bump（漏 bump ⇒ 停在旧内容，不会崩）。

## 4. 测试（18 条，全绿）

§6.3 P2 行逐项：初始只挂窗口内块 + 每行 textContent/counter 起点等于 `displayLine(i)/i+1`；scroll 块集变化且存活块节点 identity 保持；append 只重绘最后一块和新块（其它块元素与**文本节点** identity 不变）；高亮到达重绘可视块；选区活跃（注入判定）只增不减、连续、2048 上限回退 + 提示、props 引用冻结（跨 append 文本节点 identity）、折叠后 flush；Ctrl+A 取消矩阵（scroll/append/blur 不取消 × pointerdown/Shift/Esc/新非折叠 selectionchange 取消）+ copy 全选写全文（含 append 后复制取新全文）；截断行结构（空 `.pv-vclip` 在 parts 后、`"\n"` 恒为末子节点、标记不进 textContent、data-clip/alt label）+ 代理安全截断；`scrollToLine`；行数上限尾注 + spacer 高度封顶；gutter 位数跨界只重设一次；探针在 pre 外；VirtualBlock 单元（counter-reset/top/data-start/verbatim）。

## 5. 留给 P3 的接线点

1. `PreviewText.vue` 虚拟分支：行号开、非流式 >600 行 / 流式一律渲染 `<VirtualCode :source="…" :source-revision="rev" />`（替换整个 `<pre>`——VirtualCode 自带 `pre.preview-text-body.pv-virtual`，外层 flex 槽由 `div.pv-vwrap` 承接）；`chooseSourceRenderer` 表（P1）决定何时到达这里。
2. `rev`：`ref(0)`，每次 `source.append(copyValue)` / `setHighlight` 后 `rev.value = source.revision`。
3. 流式：哨兵 `.preview-stream-sentinel` 与 more/loading/waiting/cap/changed/error 状态行放 VirtualCode 的默认 slot（已在 spacer 之后、滚动容器之内）；IO root 用 expose 的 `scrollEl`。
4. Ctrl+F（§4.6）与「完整视图」按钮（§4.7）在 PreviewWindow/PreviewText 层做；命中滚动用 expose 的 `scrollToLine(line, "center")`。
5. i18n：把 §3.2 的本地字典迁入 `i18n/{zh,en}/preview.ts`。
6. P1 对接：`computeWindowRange`/重锚点换 `logic/previewVirtual.js`，测试桩换 `previewLineIndex.js` 真实现并删除 `helpers/virtual-source-stub.ts`。

## 6. 自验结果（本机，2026-10-23）

- `npx vitest run tests/web-hub/ui/virtual-code.test.ts tests/web-hub/ui/source-scan.test.ts --maxWorkers=2`：**virtual-code 18/18 通过**；source-scan **1 条失败，系并行 PB 包的在途未跟踪文件 `src/web-hub/ui/csp-probe/preview-perf.ts`（rAF）**——方案 §6.1 明确测量脚本可用 rAF，但 source-scan 的 glob 覆盖 csp-probe，该豁免应由 PB 包自己处理（加白名单或挪注入脚本）。P2 五个文件零 offender（逐文件核对）。
- `npx vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json`（typecheck 的 UI 段）：**通过，零输出**。
- `npm run build:web && npm run check:web`：**通过**（first-screen JS 334134B gz / 512KiB，CSS 34901B / 64KiB；VirtualCode 未被任何入口引用，尚不在产物图里——P3 接线后才进 chunk）。
- `npx prettier --check`（五个新文件）：**通过**。
- 附带核对：模板编译产物中 `<pre>` 内无空白文本节点（`white-space: pre` 下不产生幻影行盒）；happy-dom 逐点验证了 scrollTop 直存、Selection/intersectsNode、PointerEvent 可用性。

## 7. 遗留 / 风险登记

- 真浏览器布局断言（§4.2 (a)–(e) 单行盒/行盒高/标记位置/复制不含标记）归 PB（三引擎），happy-dom 只能钉 DOM 结构。
- `.pv-vclip::before` 的 alt-text 语法（`content: … / attr()`）在旧引擎回落为 `…(+N)`，读屏表现 P4 实测（K9）。
- 选区跨 >2048 行、Shift+点击已卸载位置不保证——状态提示已实现（K6）。
