# PB · 预览性能真实构建探针 + 改动前基线（报告）

- 日期：2026-10-23 · 分支：dev（HEAD 799f9ee4；P0 已在 1e768c70 提交，本基线含 P0）
- 方案：`plan.md` §6.1（PB 包）· 机器可读数据：`baseline.json`（同目录，schema `preview-perf-baseline/1`）
- 命令：`npm run probe:preview-perf`（不进 CI，与 `probe:mermaid` 同类人工门）
- 基线口径：**record-only**——§6.1 的门槛表面向 P3 之后的虚拟渲染器，改动前数字本来就应超标；此后每个包（P1/P2/P3/P5）附 before/after 对比，同一探针、同一语料、同一口径。

## 1. 探针结构

```
npm run probe:preview-perf
 ├─ 1. 校验语料 sha256（tests/fixtures/preview-perf/manifest.json，不匹配拒绝运行，exit 1）
 ├─ 2. vite --mode csp-probe 生产构建（与产品同一 vite.config.ts / CSS 管线，
 │     产物在 node_modules/.cache/pwh-csp-probe/，不进 dist/web-hub-ui/）
 ├─ 3. 本机 HTTP 服务：探针产物 + /corpus/* 语料路由，套真实 CSP 头（import hub/http.ts）
 ├─ 4. Playwright 驱动：Chromium（必测）+ Firefox/WebKit（可选，缺失→skip+安装提示）
 │     真实鼠标/滚轮事件；Chromium 额外走 CDP（Tracing）
 └─ 5. 输出 baseline.json + stdout 表（exit 0 通过 / 1 失败 / 2 浏览器不可用）
```

### 1.1 页面（`src/web-hub/ui/csp-probe/preview-perf.{html,ts}`）

- 挂载**真实产品组件链**：`usePreviewWindows`（窗口管理器）→ `PreviewHost` / `PreviewWindow` / `PreviewText` / `CodeLines`，全局样式按 `main.ts` → `App.vue` 的顺序全量 import；「点击路径 → 开窗」走真实 `PathText`（`findPathRefs` 识别 → `PREVIEW_CTX.open`）。
- **内存 fake transport**：`fetch` 按路径返回语料；`chunk:true`/`{offset,ident}` 驱动**真实的**流式状态机（`usePreview` 的 continuation + `classifyChunkOutcome`）。语料在页面加载时经 HTTP 拉取一次后驻留内存——打开计时测的是渲染，不含网络。ident `i1.ABCDEFGHIJKLMNOPQRSTUva` 满足 `PREVIEW_IDENT_RE`。
- fake hub state：caps = `preview.v1, preview.lan.v1, preview.abs.v1, preview.chunk.v1`；session cwd=`/work`（语料路径 `/work/<file>` 全部在 cwd 内）。
- 假 transcript 固定在**左下角、z-index 70**（`:style` 对象绑定 = CSSOM 写，CSP 干净，即 `probe:csp` 验证过的那类绑定）：级联窗口会盖住页面顶部的原始位置，挡住真实点击路径。这是一处探针专属布局，不影响被测组件本身。
- `window.__pp` 驱动 API：`armOpen/collectOpen`（open-to-frame）、`winInfo`（窗口几何 + `.pw-rz` 把手）、`scrollInfo/setScrollTop`、`beginGaps/endGaps`（rAF 帧隙 + longtask 观察器）、`streamInfo`（读真实 stream 状态）、`toSourceView`（md 渲染→源码切换）、`violations`（CSP 违规收集）。
- **VirtualCode 开关**：`?virtual=1`（runner `--virtual`）——本基线关闭；P3 落地后打开，虚拟用例（`pv-virtual` 块断言、虚拟滚动/选区/查找的 §6.1 功能项）随包补上。

### 1.2 语料（`tests/fixtures/preview-perf/`，sha256 定版）

| 文件                     | 内容                                                                                                                    | 作用                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `stack-3609.ts`          | `src/stack.ts` 定版拷贝（3609 行 / 170,811 B，超 100 KiB 高亮闸门 ⇒ 纯文本）                                            | 大文件全量 DOM（拖/缩/滚/激活/窄屏）  |
| `hl-600.ts`              | uploads.ts 前 600 行（22,585 B，闸门内 ⇒ 高亮）                                                                         | 虚拟阈值上沿的高亮文件                |
| `hl-601.ts`              | 前 601 行                                                                                                               | 阈值外第一行（P3 后进虚拟）           |
| `uploads-2292.ts`        | uploads.ts 全量（2292 行 / 90,526 B，闸门内 ⇒ 高亮）                                                                    | 打开后分词成本                        |
| `longline.js`            | 701 行，其中第 350 行单行 200 KB（合成，种子 0x1016c0de）                                                               | 超长行                                |
| `wide-1200.md`           | 1201 行 CJK/emoji/tab/组合字符/İ/Σ（合成，种子 0x21de0b17）                                                             | 宽字符（默认渲染 md 视图 + 源码切换） |
| `log-8mib`（运行时生成） | 固定种子 0x0b1701，恰 8,388,608 B；每 1024 行一条 emoji 行；`aaaa`/`a` 连续段；**第 5 个 chunk 边界强制切在代理对中间** | 流式（P3 查找差分的前置条件已备）     |

`manifest.json` 记录每个磁盘文件的 sha256/bytes/lines 与 log-8mib 的种子/块计划；runner 每次运行前校验，不匹配 exit 1。再生成：`node tests/fixtures/preview-perf/gen-corpus.mjs`（pinned 拷贝行数不符会直接报错，逼人显式重钉）。

**磁盘后缀**：语料在磁盘上写作 `<canonical>.txt`（如 `hl-600.ts.txt`）——它们是文本载荷而非源码模块（切片在语法上不完整、longline 是关键字汤），不能让 prettier 当 `.ts`/`.js` 解析（仓库 format 门检查一切文件）；`.txt` 不在 prettier 扩展名清单内，免改 `.prettierignore`。manifest 键与页面请求的路径保持真实扩展名（`/work/hl-600.ts`），预览的语言识别/高亮链路照实演练。

### 1.3 固定环境

- viewport 1440×900（DPR 1）；窄屏用例 390×844；headless（各引擎 executable 记录在 `baseline.json.meta.engines`）。
- `pwh_fontscale` = 1 与 3 两档（页面加载前由 Playwright `addInitScript` 写入 localStorage）；`pwh_linenumbers="1"`（产品默认开）。
- 报告记录实际解析字体（`getComputedStyle(.preview-text-body).fontFamily`）与 `document.fonts.status`（见 §4 环境行）。
- 每项 7 轮，median/p95（流式 3 轮；Firefox/WebKit 缩减面，见 §5 偏差）。
- 打开分 warm（同 context 反复开/关）与 cold（每轮全新 context：Prism chunk 未缓存）。

## 2. 指标口径

| 指标                            | 口径                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **open-to-frame**               | t0 = PathText `click` 的 `ev.timeStamp`（capture 监听器）；t1 = 滚动容器出现首个 `.pv-line`/`.preview-text-body`/`.preview-md`/`.preview-seg` 后的**第 2 个 rAF**。真实鼠标点击（Playwright `page.click`）。 |
| **每轮平均每步（拖/缩/滚）**    | 60 步 `mouse.move`（间距 ~8ms；缩放用 `.pw-rz[data-dir=e                                                                                                                                                     | s   | se]`真实把手）/ 40 步`mouse.wheel(400px)`；每轮一次 CDP `Tracing`（`devtools.timeline,toplevel`），每步成本 =（Σ 输入 `EventDispatch`+ Σ`UpdateLayoutTree`+ Σ`Layout`）÷ 步数。 |
| **单步峰值（stepMax/stepP95）** | 同一份 trace：每个输入 `EventDispatch` 自身 + 其后到下一个输入事件为止的 `UpdateLayoutTree`/`Layout` 切片之和，按步分布取 max/p95。                                                                          |
| **主线程忙时（busy）**          | 渲染**主线程**（`CrRendererMain`，thread_name 元数据定位）上 `RunTask`/`ThreadControllerImpl::RunTask` 切片 Σ dur——整线程口径的上界交叉核对，不与逐事件口径混用。                                            |
| **激活每次点击**                | 6 窗口轮转，每轮 20 次真实点击（级联暴露的窗口顶条，避免点到被覆盖区域/按钮），每轮一次 tracing，按 click `EventDispatch` 分段。                                                                             |
| **远跳**                        | `scrollTop = scrollHeight × {0.25,0.5,0.75,1,0}`（页面内设置，同方案），每次单独 tracing，取主线程 busy。                                                                                                    |
| **打开后分词任务**              | uploads-2292：从**点击前**起 tracing 到首个 `tok-*` span 出现（覆盖 Prism 动态 import + 分词 + 补丁），报 busy 总量与 style+layout 分量 + longtask 列表。                                                    |
| **帧隙 / longtask**             | 页内 rAF 循环（`beginGaps/endGaps` 窗口）与 `PerformanceObserver('longtask')`（特性检测，无 API 则记 `longtaskSupported:false`）。                                                                           |
| **流式**                        | log-8mib：开窗后每轮 poll 钉 `scrollTop` 到底（真实 IO 哨兵驱动 loadMore），整段 tracing；per-chunk = 整段主线程 busy ÷ chunk 数（**均摊值**，峰值看 longtask 列表）。                                       |

**CDP `Performance.getMetrics` 弃用说明（重要）**：实测（playwright 1.63 / chromium-1243 headless，2026-10-23）`ScriptDuration`/`RecalcStyleDuration`/`LayoutDuration` 计数器**恒为 0**——300ms 忙循环 + 2 万节点布局后纹丝不动（只在 DevTools 面板式 timeline 激活时才累计）。因此 §6.1 的「getMetrics 前后差值」在本机不可用，全部逐事件指标改为 trace 派生（`EventDispatch`≈同步 script、`UpdateLayoutTree`=style、`Layout`=layout，与方案公式同义）；主线程 busy 另用 RunTask 总和交叉核对。方案 §6.1 的门槛表照旧适用——P3 复测用同一探针，前后口径一致。

## 3. 基线数字（Chromium headless，fs-scale 1，7 轮 median / p95，单位 ms）

| 指标                        | 条件         | median |   p95 | 佐证                                          |
| --------------------------- | ------------ | -----: | ----: | --------------------------------------------- |
| `open.warm.stack-3609.ts`   | fs1 1440x900 |    148 |   173 |                                               |
| `open.warm.stack-3609.ts`   | fs1 390x844  |    164 |   197 |                                               |
| `open.warm.stack-3609.ts`   | fs3 1440x900 |    165 |   198 |                                               |
| `open.warm.hl-600.ts`       | fs1 1440x900 |  64.60 | 64.80 |                                               |
| `open.warm.hl-601.ts`       | fs1 1440x900 |  64.50 | 64.70 |                                               |
| `open.warm.uploads-2292.ts` | fs1 1440x900 |    113 |   115 |                                               |
| `open.warm.longline.js`     | fs1 1440x900 |  81.00 | 97.80 |                                               |
| `open.warm.wide-1200.md`    | fs1 1440x900 |    181 |   198 |                                               |
| `stream.longtasks`          | fs1 1440x900 |    119 |   127 |                                               |
| `stream.wall.total`         | fs1 1440x900 |   2688 |  2809 |                                               |
| `stream.append.perChunk`    | fs1 1440x900 |    117 |   125 |                                               |
| `open.cold.stack-3609.ts`   | fs1 1440x900 |    231 |   247 |                                               |
| `gesture.drag`              | fs1 1440x900 |   1.22 |  1.39 | stepMax 18.30 · frameMax 45.50 · longtasks 0  |
| `gesture.drag`              | fs3 1440x900 |   1.44 |  1.64 |                                               |
| `gesture.resize.e`          | fs1 1440x900 |  21.47 | 22.22 | stepMax 61.67 · frameMax 200 · longtasks 413  |
| `gesture.resize.s`          | fs1 1440x900 |   0.80 |  0.93 | stepMax 17.12 · frameMax 92.50 · longtasks 13 |
| `gesture.resize.se`         | fs1 1440x900 |  20.54 | 23.38 | stepMax 55.24 · frameMax 138 · longtasks 420  |
| `gesture.resize.e.softwrap` | fs1 1440x900 |   5.94 |  6.22 | stepMax 22.13 · frameMax 80.20 · longtasks 0  |
| `activate.perClick`         | fs1 1440x900 |   0.01 |  0.03 |                                               |
| `scroll.wheel.perStep`      | fs1 1440x900 |   0.00 |  0.00 | longtasks 0                                   |
| `scroll.wheel.perStep`      | fs3 1440x900 |   0.00 |  0.00 |                                               |
| `scroll.farjump`            | fs1 1440x900 |  13.03 | 22.45 |                                               |
| `highlight.busy`            | fs1 1440x900 |    269 |   475 |                                               |
| `highlight.styleLayout`     | fs1 1440x900 |    109 |   138 |                                               |
| `highlight.longtasks`       | fs1 1440x900 |  94.00 |   114 |                                               |

**firefox**

| 指标                      | 条件         | median |   p95 | 佐证 |
| ------------------------- | ------------ | -----: | ----: | ---- |
| `open.warm.stack-3609.ts` | fs1 1440x900 |    181 |   215 |      |
| `open.warm.stack-3609.ts` | fs1 390x844  |    180 |   196 |      |
| `open.warm.hl-600.ts`     | fs1 1440x900 |  66.00 | 82.00 |      |
| `open.warm.wide-1200.md`  | fs1 1440x900 |    215 |   298 |      |
| `stream.wall.total`       | fs1 1440x900 |   2697 |  2755 |      |

**webkit**: SKIPPED — launch 即退（缺系统库 libevent-2.1.so.7，exit 127；修复命令见 §5.4）

### 3.1 关键读数（对照 §6.1 门槛表，均为改动前）

- **横向缩放是最大痛点**：`resize.e` 21.5 ms/步（门槛 ≤2）、`resize.se` 20.5，单步峰值 61.7 ms、7 轮共 413 个 >50ms longtask、帧隙 max 200 ms——全量 3609 行软换行重排，验证 §1 的方向性结论；虚拟化（不换行 + 少量在场行）应直接吃掉。
- **拖动/激活已被 P0 解决**：drag 1.22 ms/步（门槛 ≤1）、激活每次点击 0.01 ms（门槛 ≤2）——P0 的非继承几何变量到位后已达标，后续包不得回退。
- **open-to-frame 差门槛 3 倍**：stack-3609 warm 148 ms（门槛 ≤50）、cold 231 ms（≤80）、窄屏 164 ms（≤80）——3609 行 CodeLines 全量挂载；虚拟化后目标在场 ~200 行。
- **滚动本身零成本**（0.00/步、longtask 0）——全量 DOM 已在场；虚拟化后滚动将引入块挂载成本，届时此项是新重点（P3 复测重点）。
- **分词/高亮**：打开→高亮到达主线程忙时 269 ms（含 Prism 动态 import + 分词 + 2292 行补丁），style+layout 109 ms，longtask 中位 94 ms——闸门内的主线程分词仍超 50ms 长任务阈值，印证 §5.1 的「单独计量」与 P5 Worker 的必要性。
- **流式**：8 MiB 全量到位 ~2.7s（受 300ms 最小间隔支配）；1 MiB 大块 append 均摊忙时 117 ms/块、longtask 峰值 127 ms——真实 hub 64 KiB 小块会平缓得多（偏差 3）。

## 4. 环境与版本

- chromium: /home/bluecake/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome · font `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragi` · fonts.status=loaded
- firefox: /home/bluecake/.cache/ms-playwright/firefox-1543/firefox/firefox · font `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragi` · fonts.status=loaded
- webkit: skipped — launch 即退（缺系统库 libevent-2.1.so.7；`npx -y -p playwright@1.63.0 playwright install-deps webkit` 可修复）
- playwright 1.63.0 (offline) · headless · viewport 1440×900 DPR1 · rounds 7
- 失败项：无

## 5. 已知偏差与登记

1. **P0 已含**：基线不是 r0 裸状态，几何变量已注册为非继承（1e768c70）。拖动/激活的数字是 P0 之后、P1-P5 之前的状态——方案的对照目标是 P3 虚拟化，不是回滚 P0。
2. **6 激活窗口 = 6 个不同语料**：`openWindow` 对同路径去重，「6×stack-3609」在真实 UI 里不可达；6 窗总 DOM 行数 3609+600+601+2292+701+1201 ≈ 8.9k 行。
3. **流式 chunk 尺寸 256 KiB + 1 MiB**：真实 hub 每 64 KiB 一片（UI 侧 300ms 最小间隔不变）；探针用更大块减少轮数，单块 append 成本相应更大。`stream.append.perChunk` 是**均摊**值，峰值见 `stream.longtasks`。
4. **Firefox/WebKit 面缩减**：无 CDP，只有 open-to-frame + 流式 + 窄屏 + 功能断言（帧隙在 open/流式窗口内采集）；WebKit 本机有缓存构建但缺系统库 `libevent-2.1.so.7`，launch 即退（exit 127）——按「不可用则明确报告」处理，skip 原因与安装提示落盘在 JSON 与 stdout，**不假通过**。修复：`npx -y -p playwright@1.63.0 playwright install-deps webkit`。
5. **cold 打开含 localhost chunk 下载**：新 context 无缓存，Prism chunk 经本机回环拉取——真实冷加载含网络面，数字略偏保守（对基线方向安全）。
6. **手步进节拍 ~8ms**：真实拖动按帧对齐（~16ms）；更密的步进让「每轮平均每步」略偏小、单步峰值不受影响。前后对比同一节拍，内部一致。
7. **探针专属 transcript 布局**（左下角 z70）：不影响被测窗口组件；见 §1.1。
8. **`wide-1200.md` 打开计时的是默认渲染 md 视图**（源码切换为功能断言，另测）；md 解析成本包含在 open-to-frame 内。
9. **runTasks 双计数规避**：busy 只取渲染主线程（`CrRendererMain`）的 top-level 切片；找不到线程元数据时退化为 EventDispatch 所在线程。
10. **headless**：无真实合成器 vsync 压力，帧隙数字偏乐观；真机（P4）另测。

## 6. 下一步（P1a/P1/P2/P3）

- 每包合入前重跑 `npm run probe:preview-perf`，把 before/after 对照表附进各自的 `P*-report.md`。
- P3 打开 `--virtual`：虚拟用例（600/601 行分界、截断行 (a)–(e)、选区/查找功能断言、`pv-virtual` 块）随包落地；`--gate` 届时实现 §6.1 门槛表。
