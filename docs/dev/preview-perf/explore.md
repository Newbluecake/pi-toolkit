# web-hub 预览大文本性能剖析（explore）

- 日期：2026-10-23 · 分支：dev（933b1f46）
- 现象（用户反馈）：预览窗口打开 ~3000 行 TypeScript（src/stack.ts / src/config/settings.ts）打开慢、滚动卡、浮动窗拖动/8 向缩放明显卡顿。
- 性质：**只测量与定位，不改产品代码**。所有测量脚本在 `/tmp/preview-perf/`（snap chromium 读不了 /tmp，harness 副本放在 `~/preview-perf/harness.html`，见 §5 方法）。

## 0. 结论速览

1. **瓶颈不在 JS/高亮**。字符串处理（stripAnsi/切行）<1ms；Prism tokenize 一个 90KB/2292 行文件只要 **17–20ms**；且 stack.ts/settings.ts 同时超过 100KiB 与 3000 行双闸，**根本不高亮**（`shouldHighlight=false`，纯文本行渲染）。
2. **瓶颈是「每行一个 DOM 块」的全量布局**（72fa2abe 行号栏引入）：3607 行 ⇒ 3607 个 `.pv-line` span（+ CSS counter + 绝对定位 `::before` + padding-left）。任何使面板几何失效的操作——**包括纯拖动**——都要对整棵子树做 layout walk：
   - 缩放（宽度变化）：**中位 58–60ms/次**，rAF 实测 **~4.7fps、帧隙 233ms、1.5s 内 9 个 longtask**；
   - 纯拖动（只改 left/top）：**中位 30ms/次**（行号栏出现前的单文本节点 DOM 只要 **0.1ms**）；
   - 打开：mount + 首布局 **~190ms**（中位，5 次取中）；
   - 滚动：软件渲染下 p95 帧隙 33ms / max 50ms（~43fps），`scrollTop` 本身不触发强制 layout（0ms）——滚动成本在 paint/raster。
3. **可高亮文件（<100KiB 且 <3000 行）另有 ~220ms 的二次卡顿**：先渲染纯文本，150ms 去抖后主线程 tokenize（~20ms）+ **整块 DOM 替换**（13k 节点 build 18.5ms + 替换后 layout **196ms**）。
4. 候选方案实测收益排序：**虚拟滚动（45×）≫ 手势期冻结内容宽（2×）> transform 移动（~0ms，但 plan R2 明令禁 transform）**；`contain: strict` 实测**无收益**；「默认不换行」单独做**救不了**（58→53ms，块布局主导而非换行计算主导）；Web Worker 高亮**不是当前瓶颈**（tokenize 本身才 20ms，贵的是替换后的 layout 196ms，Worker 不解决它）。

## 1. 渲染链路事实（读码结论，带坐标）

问题中几个疑问的答案：

| 疑问                                         | 结论                                                                                                                                                                                                                                                                                                          | 证据坐标                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 高亮是自研还是第三方？                       | **第三方 Prism（prismjs 1.30）+ 自研封装**：flattenTokens 把 token 树拍平成 `[{cls,text}]`，渲染层用 Vue VNode `<span class="tok-*">`（绝无 v-html/innerHTML）；引擎+语言包走单个懒加载 chunk                                                                                                                 | `src/web-hub/ui/src/components/shared/highlight-impl.ts`、`highlight-core.ts:31-40`、`src/web-hub/ui/src/logic/highlight.js`（flattenTokens）                |
| 首屏先纯文本再替换？                         | **是**。`useHighlightParts` 的 watch 每次变更先把 `parts=null`（立即渲染纯文本 DOM），150ms 去抖后才 tokenize 并整块替换                                                                                                                                                                                      | `highlight-core.ts:64-86`（`setTimeout(recompute, HIGHLIGHT_DEBOUNCE_MS)`，`highlight.js:33` = 150ms）                                                       |
| 高亮在主线程同步全量做？                     | **是**。tokenize/flatten/split 全部同步跑在主线程，无 Worker、无分块回传                                                                                                                                                                                                                                      | `highlight-core.ts:44-60`（recompute）                                                                                                                       |
| 每行一个 DOM 节点还是一个大 `<pre>`？        | **每行一个**：`CodeLines.vue` 渲染函数对每行 `h("span", {class:"pv-line"}, …)`，行号是 CSS counter `::before`（非 DOM 节点）；每个带类 token 再加一个 span。非流式源视图外层仍是 `<pre class="preview-text-body">`                                                                                            | `CodeLines.vue:52-62`（`props.lines.map(...)`）、`PreviewText.vue:565`（`<NumberedCode>`）、`styles/preview.css:442-470`                                     |
| token span 数量级？                          | 2292 行/90KB 的 TS：flat parts **18,813**（其中带类 10,890）⇒ 2292 行 span + 10,890 token span ≈ **13.2k DOM 节点**（token 上限 20000，`highlight.js:31`）                                                                                                                                                    | Node 实测（§3 表 2）                                                                                                                                         |
| 换行（wrap）开关与行高？                     | **无换行开关，默认软换行**：`white-space: pre-wrap; overflow-wrap: anywhere`；行高 `line-height: 1.5`（13px 字号 ⇒ 19.5px/行，**非固定像素行高**，换行行随内容变高）                                                                                                                                          | `preview.css:406-421`（`.preview-text-body`）                                                                                                                |
| 拖动/缩放是否触发整块重排？                  | **是，且每个 pointermove 一次**：`onPointerMove` 直接 `r.value = moveRect/resizeRect(...)`，Vue `:style` 把 `--pw-x/y/w/h` 写进面板（注释明言 no rAF、no transform，R2 约束）。宽度变化 ⇒ pre-wrap 全量重排行；**纯移动也走整子树 layout walk**（3607 个行块让 fixed 元素的几何变更不再是纯 compositor 操作） | `usePreviewWindowLayout.ts:315`（r.value 赋值）、`PreviewHost.vue:289-293,322`（geomVars :style）、`preview.css:1091-1094`（left/top/width/height 全走 var） |
| 是否有 watch/computed 在窗口尺寸变化时重算？ | **没有 JS 侧重算**。行数据在挂载时一次算好（`splitTextIntoCodeLines`），窗口几何不触发任何 watch/computed——**全部卡顿都是浏览器 layout/paint 成本**，不是 Vue 响应式成本                                                                                                                                      | `NumberedCode.vue`、`previewLines.ts`（纯函数，无尺寸输入）                                                                                                  |

大文件双闸事实（解释用户案例为什么不高亮）：`HIGHLIGHT_MAX_BYTES=100KiB`、`HIGHLIGHT_MAX_LINES=3000`（`highlight.js:27-29`）。stack.ts = 170,618B / 3,607 行、settings.ts = 181,226B / 3,646 行，**双双超限 ⇒ parts 恒为 null ⇒ 纯文本行渲染**；行数 ≤ 8000（`PREVIEW_NUMBERED_LINES_MAX`，`previewLines.ts:39`）⇒ 仍走 `NumberedCode` 的逐行 DOM。

## 2. 测量方法

- **Node 侧**（`/tmp/preview-perf/measure-node.mjs`）：直接 import 仓库真实模块（`logic/highlight.js`、`logic/ansi.js`）+ 仓库 node_modules 里的 prismjs 1.30；`previewLines.ts` 是 TS，其切行函数按原文复制进脚本（语义逐字一致）。每个数字 7 次取中位。
- **浏览器侧**（`gen-harness.mjs` → `harness.html`）：自包含页面，**复刻 preview.css 的关键规则**（`.preview-window > .preview-panel` 的 `--pw-*` 定宽高、`.preview-text-body` 的 pre-wrap/13px/1.5 行高/mono 字体、`.pv-line` counter+padding、tok-* 类），**内联真实文件内容**（stack.ts 全文、uploads.ts 全文及其真实 Prism 高亮切行结果，base64 注入）。测量电池：
  - mount：新建 DOM→挂载→强制 layout（5 次取中位）；
  - 缩放：`--pw-w` 900↔600px 交替 30 次每次强制 layout（去抖预热 4 次）；
  - 纯移动：`--pw-x` 交替 30 次；
  - 变体：无 counter/padding 的裸行块（定位行号栏成本）、只渲染 80 行（虚拟化收益上界）、缩放期间冻结内容宽度（pre 固定 876px）、transform 移动（R2 违禁项的收益量化）、`contain: strict`；
  - 高亮替换：把 2292 行纯文本 DOM 一次性 replaceChildren 成 13k 节点高亮 DOM；
  - 异步：rAF 帧隙 + PerformanceObserver longtask，1.5s 脚本化滚动 / 1.5s 脚本化宽度变化（headless chromium 155，CDP 取回 `window.__final`）。
- **坑**：snap chromium 的 AppArmor 禁止读 `/tmp`（`file:///tmp/...` → `chrome-error://`），harness 副本放 `~/preview-perf/`；`--dump-dom` 在 load 后立即截取，异步结果必须走 CDP。
- **限制**：headless 软件渲染（`--disable-gpu`）会放大 paint/raster 类成本（滚动帧隙数字偏悲观），layout 类数字（resize/move/mount 强制 layout）与真实浏览器同机制、可信。异步「虚拟 80 行滚动」的滚动范围只有内容自身高度（vmax 小），该行数字只作方向性参考。

## 3. 数据

### 表 1 · Node：JS 侧成本（中位 ms，7 次）

| 文件                       | 字节    | 行数  | shouldHighlight            | stripAnsi | shouldHighlight 扫描 | 切行 split | tokenize | flatten(含tokenize) | splitParts |
| -------------------------- | ------- | ----- | -------------------------- | --------- | -------------------- | ---------- | -------- | ------------------- | ---------- |
| src/stack.ts               | 170,618 | 3,607 | **false**（字节+行数双超） | 0.006     | 0.001                | 0.40       | —        | —                   | —          |
| src/config/settings.ts     | 181,226 | 3,646 | **false**                  | 0.006     | 0.001                | 0.46       | —        | —                   | —          |
| src/web-hub/hub/uploads.ts | 90,526  | 2,292 | true                       | 0.003     | 0.40                 | 0.28       | **17.1** | 20.3                | 1.7        |
| src/bash/manager.ts        | 87,398  | 2,099 | true                       | 0.002     | 0.28                 | 0.51       | 12.9     | 14.2                | 0.8        |

uploads.ts 高亮产物：flat parts **18,813**（带类 10,890）⇒ 2,292 行 span + 10,890 token span = **13,182 节点**。

### 表 2 · Chromium headless：布局电池（中位 ms；n=30 除 mount n=5）

| case（DOM 形态）                              | mount+首布局 | 缩放 wrap 开 | 缩放 wrap 关 | 冻结内容宽缩放 | 纯移动   | transform 移动     | `contain:strict` 缩放 |
| --------------------------------------------- | ------------ | ------------ | ------------ | -------------- | -------- | ------------------ | --------------------- |
| **stack 3607 `.pv-line`+counter**（用户现状） | **190.7**    | **58.0**     | 54.2         | 29.6           | **30.2** | —                  | 58.9（无收益）        |
| 同上但去掉 counter/padding（裸行块）          | 101.3        | 29.4         | 24.9         | —              | 10.5     | —                  | —                     |
| **只渲染 80 行**（虚拟化上界）                | **7.4**      | **1.3**      | 1.2          | —              | **0.8**  | —                  | —                     |
| 单文本节点（72fa2abe 之前的 legacy DOM）      | 47.8         | 8.8          | 4.8          | —              | **0.1**  | —                  | —                     |
| uploads 2292 行纯文本行块                     | 109.7        | 35.7         | 32.2         | —              | 19.1     | —                  | —                     |
| stack 3607 行（transform 移动变体）           | —            | —            | —            | —              | 30.2     | **0.0**（p95 0.2） | —                     |

（缩放列为 `--pw-w` 900↔600 每次强制 layout 的中位；p95 见 sync-results.json，约为中位的 1.4–1.6×。两次独立重跑数字一致：58.4/61.1/58.0、29.8/31.9/30.2；wrap 关与 contain 列各次浮动 52.8–54.2 / 58.9–62，结论不变。）

### 表 3 · 高亮替换（uploads.ts，gate 通过的文件打开 150ms 后发生）

| 步骤                                          | 耗时                                        |
| --------------------------------------------- | ------------------------------------------- |
| build 高亮 DOM（2292 行 + 10,977 token span） | 18.5 ms                                     |
| replaceChildren + 强制 layout                 | **196–201 ms**                              |
| 合计二次卡顿                                  | **~215 ms**（叠在打开的 ~110ms mount 之上） |

### 表 4 · rAF 帧隙 / longtask（1.5s 脚本化操作，软件渲染）

| 场景                                    | 帧数             | p95 帧隙     | max 帧隙     | longtask 数 |
| --------------------------------------- | ---------------- | ------------ | ------------ | ----------- |
| 滚动 stack 3607 行全量 DOM              | 64（~43fps）     | 33.3 ms      | 50.1 ms      | 3           |
| 滚动 80 行虚拟 DOM（方向性参考）        | 83（~55fps）     | 16.8 ms      | 33.5 ms      | 1           |
| **缩放（宽度正弦变化）3607 行 wrap 开** | **7（~4.7fps）** | **233.3 ms** | **233.3 ms** | **9**       |

另：`scrollTop` 变化后强制读 layout ≈ 0ms（滚动本身不触发 relayout）——「滚动卡」是 paint/raster/大 layer 成本 + 帧预算被长任务挤占，不是 layout。

## 4. 瓶颈清单（按实测影响排序）

### B1 · 缩放手势：每 pointermove 全量子树 relayout（最痛）

- **现象**：拖 8 向 resize 把手时 ~5fps、肉眼可见卡死感。
- **证据**：表 2 缩放列 58ms/次（中位）；表 4 帧隙 233ms、9 longtask/1.5s。每个 pointermove（60–125Hz）都触发一次。
- **坐标**：`usePreviewWindowLayout.ts:315`（onPointerMove 直写 rect）→ `PreviewHost.vue:291-293,322`（:style 写 `--pw-*`）→ `preview.css:1091-1094`（width/height 走 var）→ `preview.css:406-421`（pre-wrap 全量重排行）+ `preview.css:446-462`（3607 个 `.pv-line` 块）。
- **方向**：见 §6 候选 1/2/3。冻结内容宽只到 29.6ms（仍超帧预算 2×）；虚拟化到 1.3ms 才是数量级解。

### B2 · 纯拖动也 30ms/次（行号栏 DOM 的连带伤害）

- **现象**：拖标题栏移动窗口卡。
- **证据**：表 2「纯移动」列：3607 行块 30.2ms vs legacy 单文本节点 **0.1ms** vs 虚拟 80 行 0.8ms。机理：面板 left/top 变更本应近似免费，但 3607 个带 counter/::before/相对定位的行块让 Blink 对 fixed 子树做整棵 layout walk（去 counter 后降到 10.5ms，说明 counter/padding 使 walk 成本再 ×3）。
- **坐标**：同 B1 前两跳 + `CodeLines.vue:57-62`（每行一 span）+ `preview.css:446-462`。
- **方向**：虚拟化（0.8ms）或 transform 移动（0.0ms，撞 R2 约束需拍板）。

### B3 · 打开慢：~190ms mount+首布局；可高亮文件再叠 ~215ms 二次替换

- **现象**：打开 stack.ts 明显迟滞；打开 <100KiB/<3000 行的 TS 文件先快后「顿一下」。
- **证据**：表 2 mount 列 190.7ms（3607 行）/ 109.7ms（2292 行）；表 3 替换 196ms+18.5ms。legacy 单文本节点 mount 仅 47.8ms——**逐行 DOM 让打开成本 ×4**。
- **坐标**：`PreviewText.vue:565`（NumberedCode 分支）、`highlight-core.ts:64-86`（plain-first→去抖→整块替换）、`highlight.js:27-33`（闸门/去抖常量）。
- **方向**：虚拟化把 mount 降到 7.4ms；二次替换可用「非流式一次性文件在闸门通过时同步 tokenize（17ms 可接受）」消除替换，见 §6 候选 5。

### B4 · 滚动卡：paint/raster + 帧预算被挤占

- **现象**：滚动 3000 行文件不流畅。
- **证据**：表 4 全量 DOM p95 帧隙 33ms vs 虚拟 80 行 16.8ms（软件渲染，偏悲观但方向可信）；`scrollTop` 强制 layout ≈0ms 排除 relayout 归因。
- **坐标**：同 B2 的 DOM 形态（`CodeLines.vue` + `preview.css:442-470`）。
- **方向**：虚拟化直接缩 DOM 面；固定行高让滚动定位 O(1)。

### B5 · 行号栏（72fa2abe）本身的定量贡献

- 逐行块（无 counter）已把缩放成本从 8.8ms 抬到 29.4ms（×3.3）、移动 0.1→10.5ms（×100）；**counter+padding 再翻倍到 58/30ms**。即：逐行 DOM 是主要增量，counter 机制在其上再 ×2。
- 含义：只优化 counter 实现（如 gutter 用表格列/单独 flex 列）收益有限（≤2×），减少「同时在场的行块数」才是根治。

### B6 · 「大文件默认不换行」单独做收益小

- wrap 关只把 58→52.8ms（行块布局主导，非换行计算主导）；legacy DOM 上倒是 8.8→4.8（×1.8）。nowrap 的真正价值是**给虚拟化提供固定行高前提**，不是独立缓解手段。固定行高（现在 `line-height:1.5` 依赖字号缩放，换行行高可变）同理是虚拟化的前置。

## 5. 候选优化评估（content-visibility 已被否决，不列入）

| 候选                                                                                                     | 实测/预估收益                                                                                                       | 成本与风险                                                                                                                                                                                       | 建议                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **1. 虚拟滚动**（只渲染可视行 ±缓冲；`CodeLines.vue` 头注释已预留「之后换虚拟列表只动这里」，约束 ①）    | 缩放 58→**1.3ms**（45×）、移动 30→0.8ms、mount 190→7ms、滚动 p95 33→17ms                                            | 需固定行高/nowrap（前置 B6）；选区跨虚拟区、浏览器查找、`textContent` 字节一致契约（`tests/web-hub/ui/logic-preview-lines.test.ts` pin）都要重做；流式 append-only 段结构（`srcLineSegs`）需适配 | **首选**，收益唯一数量级；分两步：先 nowrap+固定行高，再虚拟化 |
| 2. 拖动/缩放手势期冻结内容宽度（内层固定宽度 wrapper，手势结束提交）                                     | 缩放 58→29.6ms（2×）；对纯拖动无效（仍 30ms）                                                                       | 实现小、无契约风险；手势期间滚动条/换行视觉冻结                                                                                                                                                  | 过渡方案，可与 3 组合                                          |
| 3. transform 移动（拖动改 `translate`，resize 仍走 width/height）                                        | 移动 30→**0ms**；缩放不变                                                                                           | **撞 plan R2**（preview-windows r2 §7.4 明言 no transform；需产品拍板改约）；z 序/命中测试需回归                                                                                                 | 若 R2 可放宽，拖动问题立解；否则依赖候选 1                     |
| 4. `contain: strict`（面板级）                                                                           | 实测 **58.9 vs 58.0ms，无收益**（内容仍在面板内重排）                                                               | —                                                                                                                                                                                                | 不推荐                                                         |
| 5. 去掉纯文本→高亮二次全量替换（非流式一次性文件：闸门通过即同步 tokenize，17–20ms；或首帧只渲染首屏行） | 消除打开后 ~215ms 二次卡顿（可高亮文件）；plain-first 流式契约（去抖）保留给流式路径                                | `highlight-core.ts` 需区分流式/一次性调用方；同步 tokenize 20ms 在打开场景可接受                                                                                                                 | 推荐（与 1 正交）                                              |
| 6. Web Worker 高亮按行分块回传                                                                           | tokenize 本身 17–20ms（90KB 文件），stack.ts 根本不 tokenize——**不是当前瓶颈**；替换后的 196ms layout Worker 管不了 | 通信/分块复杂度高                                                                                                                                                                                | 低优先级；若未来调大闸门（让 3000+ 行也高亮）再评估            |
| 7. 大文件默认不换行 + 固定行高（单独上线）                                                               | 缩放 58→53ms（弱）；为 1 铺路                                                                                       | 无                                                                                                                                                                                               | 作为 1 的前置而非独立方案                                      |

## 6. 复现与原始数据

- 脚本（/tmp/preview-perf/）：`measure-node.mjs`（Node 侧）、`gen-harness.mjs`（生成 harness.html）、`drive-cdp.mjs`（CDP 取异步数据）。
- 数据：`node-results.json`、`sync-results.json`（布局电池全量含 p95/total）、`async-results.json`（rAF/longtask）。
- 运行方式：`node measure-node.mjs`；`node gen-harness.mjs && cp harness.html ~/preview-perf/ && chromium --headless=new --no-sandbox --disable-gpu --dump-dom file:///home/bluecake/preview-perf/harness.html`；`node drive-cdp.mjs`（页面 URL 已指到家目录副本）。
- 本文档之外无任何产品文件改动；未 commit。
