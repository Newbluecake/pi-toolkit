# 20–30KB 预览「打开后 2–3 秒卡顿」测量定位（jank-20kb）

- 日期：2026-10-23 · 分支 dev（P5 `93291695` + `6e75de9c` 之后）· 只测量，未改任何产品代码
- 触发：用户反馈「web-hub 预览窗口打开 20 多 KB 代码文件，打开后 2–3 秒内浏览器非常卡顿」；既有探针 `hl-600` open warm 仅 ~63ms，说明卡顿在探针未覆盖的路径上。
- 结论先行（TL;DR）：**≤600 行的 20–30KB 非虚拟文件，打开后在 +150ms 去抖点起连续发生 2–3 个链式主线程 longtask：① 同步 Prism 分词（含深响应式化），② 60ms 后整块 DOM 换装（数千 tok span 的 insertBefore + style/layout/paint），③ GC 10–50ms**。本机（EPYC 7H12，快）单窗合计 0–141ms；**4× CPU 节流下复现用户报告：vue/单行 JSON warm 500–630ms、cold 580–760ms 连续冻结**。>600 行 + 行号开（默认）的文件走 P5 Worker 路径，4× 节流下仍 0 longtask——同一尺寸量级只要进了虚拟/Worker 路径就没有此问题。**根因是虚拟化门槛按「行数」而非「字节/工作量」划分，把用户最常打开的 20–30KB 文件全部留在了主线程同步高亮 + 整块换装的老路径上。**

## 1. 测量方法（可复现）

- **harness**：`/tmp/pwh-jank/`（独立，不触仓库）——`vite.config.ts` 复用产品同管线（vue 插件、`@logic` 别名、katex stub、motion-css、`worker:{format:"es"}`、es2020、cssCodeSplit false、assetsInlineLimit 0），入口 `jank.html`/`jank.ts`（改自 `csp-probe/preview-perf.ts`，同一套真实组件栈 PreviewHost + usePreviewWindows + PreviewWindow/PreviewText/VirtualCode），runner `run.ts`（改自 `scripts/web-hub/preview-perf-probe.ts` 的 CDP 采集：`Tracing`（devtools.timeline,toplevel）+ `Profiler`（500µs 采样，页面 `calib()` 忙循环对齐 Profiler↔performance.now 时钟）+ 页内 PerformanceObserver longtask/rAF 帧隙 + 首 tok span 时刻 + resource timing）。服务器带真实 CSP（`src/web-hub/hub/http.ts` 的 CSP 头）。
- **窗口**：点击 chip（PathText 真实点击路径）→ `collectOpen()`（click timeStamp → 第 2 个 rAF）→ 继续采到 click+3000ms；每文件 warm 3 轮（先 1 轮预热 Prism 分块）、cold 用全新 context。
- **语料**（确定性生成 `/tmp/pwh-jank/corpus/manifest.json`）：ts-400（19.7KB/400 行）、vue-450（23.6KB/351 行）、py-500（24.1KB/500 行）、css-400（24.7KB/175 行，单行规则）、oneline.json（24.6KB/1 行）、md-24k（26.2KB/681 行，含 ~20 个代码块+表格）、ts-620（30.5KB/620 行，虚拟）、ts-900（44.5KB/900 行，虚拟）、json-1100/json-dense（25–26KB/1116–1161 行，虚拟）、css-1600（27.5KB/1156 行，虚拟）、min.js（21.6KB/3 行）、stream-24k（ts-400 内容强制走分块流）。
- **两套构建**：`dist/`（压缩，主数据）与 `dist-nomin/`（`minify:false`，仅用于 CPU profile 归因——函数名保留）。两套数字一致（±噪声），归因取 nomin。
- 变体：行号开（默认）/关、`?virtual=0`（pre-P3 渲染器）、PathText 点击 vs `handle.open()` 直开、md 渲染↔源码切换、完整视图切换、`Emulation.setCPUThrottlingRate` 4×（模拟慢机）。
- 局限：headless Chromium 1243；测量机为快 CPU（单线程约为常见笔记本 3–6×）；探针页无真实 hub 的常驻 UI（transcript/SSE 等，只会让真实情况更差）；4× 节流是该差距的下界估计。

## 2. 复现矩阵

### 2.1 本机 1×（每格 = 3 轮 warm 的代表值；LT=longtask(>50ms)；busy=3s 窗口主线程 RunTask 总忙时）

| 语料                              | 路径             | open     | tok 到达     | tok span 数    | 3s 内 LT 总/最大            | busy（S/Sty/Lay/Pnt）    |
| --------------------------------- | ---------------- | -------- | ------------ | -------------- | --------------------------- | ------------------------ |
| ts-400                            | 非虚拟+主线程    | 62ms     | +200ms       | 4126           | 0–54 / 54                   | 125–176（74/13/20/25）   |
| vue-450                           | 非虚拟+主线程    | 63ms     | +208ms       | **8338**       | **111–129 / 56–72（2 个）** | 149–179                  |
| py-500                            | 非虚拟+主线程    | 63ms     | +192ms       | 4604           | 0                           | 123–223                  |
| css-400                           | 非虚拟+主线程    | 47–64ms  | +190ms       | 4534           | 0–92 / 92                   | 100–198                  |
| oneline.json                      | 非虚拟+主线程    | 47–63ms  | +207ms       | **9861**       | **113–123 / 57–72（2 个）** | 163–300                  |
| min.js                            | 非虚拟+主线程    | 46ms     | +202ms       | 5305           | 0–80 / 80                   | 134–157                  |
| md-24k（渲染视图）                | md 解析+围栏高亮 | 97–115ms | +156ms       | 684            | 50–68 / 68（+0ms 一个）     | 57–179                   |
| ts-620 / ts-900                   | **虚拟+Worker**  | 46–62ms  | **+16–37ms** | 挂载块内 ~1000 | **0**                       | 32–85                    |
| json-1100 / json-dense / css-1600 | **虚拟+Worker**  | 46–48ms  | +14–19ms     | ~450           | **0**                       | 32–205（GC 可到 ~100ms） |

变体（1×）：cold（每语言首开）在 warm 基础上 +1 个 LT、open 95–164ms、多出 `focus()` ~13ms 与 Prism 分块 eval；行号**关** → ts-620 变非虚拟（6360 span，1×LT 54ms）；完整视图开 → ts-620 全量 DOM（LT 59–70ms×2）；`?virtual=0` → ts-900 LT 141–154ms（2 个）；**流式 0 LT**；**PathText vs 直开无差异**（LT 相同；直开的 busy 数字含测量窗杂质，勿引用）。

### 2.2 4× CPU 节流（复现用户「2–3 秒内非常卡顿」；cold=每语言首开）

| 语料              | 路径            | open  | 3s 内 LT 明细（时刻:时长）           | Σ         |
| ----------------- | --------------- | ----- | ------------------------------------ | --------- |
| ts-400 warm       | 非虚拟          | 174ms | +0:107 · +177:**204** · +382:**183** | 494ms     |
| vue-450 warm      | 非虚拟          | 128ms | +0:64 · +163:**238** · +401:**209**  | 511ms     |
| oneline.json warm | 非虚拟          | 78ms  | +163:**333** · +497:**297**          | 630ms     |
| min.js warm       | 非虚拟          | 79ms  | +163:171 · +334:156                  | 327ms     |
| md-24k warm       | md              | 298ms | +0:179                               | 179ms     |
| **ts-620 warm**   | **虚拟+Worker** | 177ms | **0 个**                             | 0         |
| ts-400 cold       | 非虚拟          | 260ms | +0:187 · +400:**243** · +644:150     | 580ms     |
| vue-450 cold      | 非虚拟          | 246ms | +0:176 · +386:**368** · +755:217     | **761ms** |
| oneline.json cold | 非虚拟          | 224ms | +2:147 · +364:**334** · +698:268     | 749ms     |
| md-24k cold       | md              | 621ms | +0:**496** · +521:56                 | 552ms     |
| ts-620 cold       | 虚拟+Worker     | 225ms | +0:156（首帧挂载+focus，无分词 LT）  | 156ms     |

> 4× 节流下从点击起到 ~1.2s 内连续 2–3 次 150–370ms 级冻结（期间 style/layout/paint 再各占 15–20%），期间滚动/拖动全部掉帧——与「打开后 2–3 秒非常卡顿」吻合；更慢的机器（6×+，或还有其它 tab 占用）按比例放大到 1–2s 量级。1× 下帧隙 max 也已有 78–160ms 的掉帧记录。

## 3. 根因（调用栈级证据 + 坐标）

三个链式 longtask 的归因（nomin 构建，`/tmp/pwh-jank/results-nomin.jsonl`；`highlight-impl-*.js` = Prism 引擎分块，`jank-*.js` = 主包）：

**LT-1（+0ms，打开本身）**：fetch → `PreviewText` 挂载纯文本行 + `PreviewHost` 的 focus。cold 额外含 Prism 分块 eval 与 `focus()` 13ms（`PreviewHost.vue:118-119`，`.preview-panel` 聚焦在数千节点上触发布局）。md 文件则是 `parseMarkdown(26KB)` 同步 computed（`PreviewText.vue:299-303`）+ `MdBlock` 全量挂载 + ~20 个围栏各自去抖高亮——md cold @4× 单任务 496ms。

**LT-2（+150ms 去抖点，分词任务，最大单项）**：`useHighlightParts` 的 watch 在 `HIGHLIGHT_DEBOUNCE_MS=150` 后**同步**执行 `recompute()`（`highlight-core.ts:95-108`，`parts.value = flattenTokens(p.tokenize(text, grammar))`；去抖定时器 `highlight-core.ts:131`）。profile 热点：`matchGrammar`@highlight-impl:715、`matchPattern`@highlight-impl:705、`tokenize`@highlight-impl:606、`DFS`@highlight-impl:405，加上 **Vue 深响应式的反噬：`parts` 是普通 `ref`（`highlight-core.ts:87`），`flattenTokens` 产出的 4–10k 个 `{cls,text}` 对象每个都被 `createReactiveObject`/`walk`/`track` 代理化**（profile 可见 `createReactiveObject`、`walk`、`track` 各 2–8ms）。关键结构问题：§5.1 的 idle 调度/手势滚动规避**只挂在虚拟体的回落路径上**（`highlight-core.ts` 的 `createVirtualHighlighter`→`queueMainThread`），非虚拟的 `NumberedCode/HighlightedCode` 路径完全没有规避——一个大任务一口气跑完。

**LT-3（分词后 ~60ms，整块 DOM 换装）**：`parts` 变更触发 `NumberedCode` 的 `lines` computed 重新 `splitPartsIntoCodeLines`（`NumberedCode.vue:34-36` → `previewLines.ts:67`）→ `CodeLines` 渲染函数重建**全部**行的 VNode（`CodeLines.vue:56-66`）→ Vue 一个同步 flush 里 `insertBefore`/`setElementText`/`patchClass` 插入 4–10k 个 span（profile：insertBefore 6–15ms 自身 + 大量原生耗时计入 (program)，随后 style 12–27ms / layout 17–38ms / paint 23–41ms @1×；oneline.json 9861 span 时 insertBefore 自身 14–66ms）。没有增量/分块上色：虚拟渲染器「只重绘挂载块」的 P2 契约不覆盖这条路径。

**GC**：每次打开 10–50ms（1×，个别轮 108ms）——短命对象（parts+代理+VNode）的分配曲线直接来自上述两段。

**结构性根因**：虚拟化/Worker 高亮的准入是**行数**（`previewVirtualTypes.ts:136` `PREVIEW_VIRTUAL_MIN_LINES = 600`；`previewVirtual.ts` 的 `chooseSourceRenderer`：`lineCount > 600 → virtual`，且 `!lineNumbers || fullView → legacy`），而 Worker 高亮又只服务虚拟体（`PreviewText.vue:559` `active: () => virtualized.value && !isStream.value`）。20–30KB 代码文件绝大多数 ≤600 行 → 全部落入「主线程同步分词 + 整块换装」路径；行号关或完整视图开时连 >600 行文件也被拽回这条路径（实测 ts-620 行号关 1×LT 54ms、完整视图 LT 59–70ms×2）。语言复杂度放大系数明显：vue（内嵌 markup+ts+css 三文法）8338 span、单行 JSON 9861 span 是最重两档。

**排除项**（测过、无罪）：流式加载（0 LT，分块 append 摊薄）；PathText → 预览的路径识别本身（与直开无差异）；Prism 分块网络加载（localhost 3ms、58KB）；`splitTextIntoCodeLines`/CSS counter 行号（CodeLines 行号是 ::before，无每行 DOM）；ResizeObserver/watch 循环（3s 静默段 busy 仅 17–41ms）；Custom Highlight API（本路径未用）。

## 4. 修复方向与预估收益（按性价比排序）

1. **让非虚拟体也走 P5 Worker 高亮**（最大头，直接消灭 LT-2）：`useHighlightParts` 对闸门内文本改经 `getHighlightWorkerClient()` 请求（Worker 侧 tokenize+flatten+encode 已就绪），回包 `decodeHighlightSpans` → parts；主线程 `loadPrism` 仅留作 Worker 不可用时的回落（§5.1 原样）。改动集中在 `highlight-core.ts` 的 `recompute()` 一处。预估：LT-2（@4× 171–368ms）整体移出主线程；剩 LT-1/LT-3。虚拟路径实测 tok +14–37ms 全程 0 LT，证明 Worker 吞吐足够。
2. **分块应用/增量上色，消灭 LT-3**：spans 到达后不一次性重建全部行，而是复用虚拟渲染器的思路按行块（如 64 行/批，rAF 或 idle 间隔）应用；或把 `lines`/parts 通道改成 `shallowRef`+`markRaw` 后用 key 化逐行 patch。预估：@4× 156–333ms 的换装任务切为 <50ms 批次，滚动期不再整块卡死；1× 下帧隙 max 从 ~100–160ms 回到 <40ms。
3. **`parts`/`lines` 去 deep-reactive**（一行级改动，顺带减 GC）：`highlight-core.ts:87` `ref` → `shallowRef`，`flattenTokens` 结果 `markRaw`（`NumberedCode.vue` 的 lines 同理）。预估：LT-2/LT-3 各省 10–30%（profile 中 track/createReactiveObject/walk 合计 5–15ms @1×），GC 10–50ms → 明显回落。
4. **准入门槛按字节补一刀**（结构性）：`chooseSourceRenderer` 增加「字节预算」维度（如 >16–20KB 即虚拟，无论行数），让 20–30KB 大文件直接进 P2/P3 虚拟 + P5 Worker 路径（实测该路径 1×/4× 全 0 LT）。需权衡：<600 行短文件的完整视图/选择行为差异（虚拟化对选择冻结、找字符等已有 P2 契约，风险可控）；行号关/完整视图时也应允许 Worker 高亮（配合 1 一起解决）。
5. **md 打开**：`parseMarkdown` + `MdBlock` 挂载 + 围栏去抖高亮集中在一个任务（cold @4× 496ms）。低收益版：把 md AST 计算挪出首帧（idle 分段渲染段落）；或围栏高亮合并为一次 tokenize。预估：单冻结 496ms → <150ms。
6. **小项**：cold 打开时 `focus()`（`PreviewHost.vue:118-119`）延到首帧后（@1× 13ms、@4× 33ms）；`HIGHLIGHT_DEBOUNCE_MS` 对大文本可加长（150→300ms）让用户先滚起来（不解决问题，只错峰）。

组合预估：1+2+3 落地后，20–30KB 非虚拟打开在 4× 节流下的 3s 窗口 LT 总量从 500–760ms 降到 <100ms（对照虚拟路径实测 0–156ms），与用户体感「打开即卡 2–3 秒」直接对齐消除。

## 5. 附注

- 数据与 harness 全部在 `/tmp/pwh-jank/`（`results.jsonl` 81 项 1×、`results-throttle4.jsonl` 4×、`results-nomin.jsonl` 归因 24 项、`out*.json` 汇总）；未写 `docs/dev/preview-perf/baseline*.json`，未带 `--write-baseline`，未触碰 `src/` 与既有探针（仓库 `scripts/web-hub/preview-perf-probe.ts` 的未提交改动系外部已有，未动）。
- 变异性说明：1× 下部分轮次 LT 为 0（任务恰在 50ms 阈下或被 GC 错峰），比较请用 busy 总量与 4× 数据；「tok 到达」时刻 = 首个 `tok-*` span 出现（+150ms 去抖 + 任务耗时）。
- 探针未覆盖（后续可补）：多窗口级联下的打开（第 2–6 窗）、真实 hub 常驻 UI 叠加、移动端 390×844、Firefox/WebKit（longtask API 无差异预期）。
