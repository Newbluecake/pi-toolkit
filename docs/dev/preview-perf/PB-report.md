# PB · 预览性能真实构建探针 + 改动前基线（报告）

- 日期：2026-10-23 · 分支：dev（HEAD 799f9ee4；P0 已在 1e768c70 提交，本基线含 P0）
- 方案：`plan.md` §6.1（PB 包）· 机器可读数据：`baseline.json`（同目录，schema `preview-perf-baseline/1`；改动前定版，此后仅经 `--write-baseline` 显式更新，`--virtual` 态写 `baseline.virtual.json`）
- 命令：`npm run probe:preview-perf`（不进 CI，与 `probe:mermaid` 同类人工门）。JSON 输出（P3 跟进 #1，2026-10-23 起）：
  - 默认 → `node_modules/.cache/pwh-preview-perf/last-run.json`（scratch，不入库）；
  - `--json <path>` → 指定路径；
  - `--write-baseline` → 显式覆写被跟踪的 `docs/dev/preview-perf/baseline.json`（配 `--virtual` 写 `baseline.virtual.json`）——普通测量运行不再弄脏定版基线；与 `--json` 同时给出时 `--json` 优先并 WARN；
  - 其余：`--virtual`（切页面 VirtualCode 开关）、`--quick`（2 轮）/缺省 7 轮、`--skip-build`（复用上次 csp-probe 构建）、`--engines csv`、`--rounds n`、`--fs csv`。
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
 └─ 5. 输出 JSON（默认 scratch `node_modules/.cache/pwh-preview-perf/last-run.json`；仅显式
       `--write-baseline` 才写定版 baseline.json，`--virtual` 时写 baseline.virtual.json）
       + stdout 表（exit 0 通过 / 1 失败 / 2 浏览器不可用）
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

## 7. P3 后复测（2026-10-23，跟进 #3）

P3（`8ab06bb4`，虚拟渲染接线 + §5.2 首帧即高亮）合入后，用跟进 #1/#2 之后的探针（默认写 scratch JSON、`lines.*` 虚拟感知）在 P3 代码上重跑两组 7 轮：r0（开关关，`PREVIEW_VIRTUAL_KEY=false` 三分支）与 virtual（生产默认）。两组 **failures=0**（exit 0）；WebKit 照旧 skip（launch 即退，缺系统库，提示见 §5.4）；机器可读数据在 `node_modules/.cache/pwh-preview-perf/p3-{r0,virtual}-full.json`（scratch，未入库）。

### 7.1 数字（Chromium headless，fs1 1440×900，7 轮 median / p95，ms）

| 指标                        | 改动前基线（§3） |      r0 复测（P3 后，开关关） |                    virtual（P3 后，开关开） |
| --------------------------- | ---------------: | ----------------------------: | ------------------------------------------: |
| `open.warm.stack-3609.ts`   |        148 / 173 |               147.50 / 198.60 |                           **47.80 / 63.70** |
| `open.warm.hl-600.ts`       |    64.60 / 64.80 |                 81.20 / 98.00 |                        **97.60 / 114.60** ⚠ |
| `open.warm.hl-601.ts`       |    64.50 / 64.70 |                97.70 / 181.70 |                           **47.90 / 48.10** |
| `open.warm.uploads-2292.ts` |        113 / 115 |               247.30 / 280.60 |                           **50.30 / 51.20** |
| `open.warm.longline.js`     |    81.00 / 97.80 |                 96.80 / 97.20 |                           **47.90 / 48.10** |
| `open.warm.wide-1200.md`    |        181 / 198 |               197.70 / 296.10 |                             197.90 / 219.60 |
| `open.cold.stack-3609.ts`   |        231 / 247 |               230.50 / 230.80 |                           **97.20 / 97.50** |
| `gesture.drag`（每步）      |      1.22 / 1.39 |                   1.34 / 1.53 |               **0.35 / 0.50**（longtask 0） |
| `gesture.resize.e`（每步）  |    21.47 / 22.22 | 21.85 / 23.06（longtask 413） | **0.46 / 0.56**（stepMax 5.53，longtask 0） |
| `scroll.wheel.perStep`      |      0.00 / 0.00 |                   0.00 / 0.00 |         0.79 / 0.92（longtask 0，含块挂载） |
| `scroll.farjump`（单次）    |    13.03 / 22.45 |                 12.79 / 16.51 |                            **7.08 / 15.37** |

### 7.2 读数

- **虚拟化兑现了 §3.1 的全部方向性预期**：stack-3609 warm 148→47.8、cold 231→97.2、resize.e 21.5→0.46（413 个 >50ms longtask → 0）、远跳 13→7.1；滚动引入受控的块挂载成本（0.79ms/步、longtask 0），远好于门槛 ≤4ms。`wide-1200.md` 走 md 渲染路径，两态同价（≈198），符合预期。
- **r0 三分支未被 P3 弄脏**：stack-3609（纯文本大文件）、cold、drag、resize.e、scroll 与基线在噪声内一致——P3 报告 §1.1「r0 分支逐字节不变」在性能面成立。
- **r0 态的高亮类 warm open 全面上移**：hl-601 64.5→97.7、uploads-2292 113→247.3、hl-600 64.6→81.2——机制即 §5.2：闸门内文件的 `NumberedCode`/`HighlightedCode` 现在传 `immediate`，分词从「首帧后异步」搬进了首帧。r0 态只是对照态（生产默认是虚拟），但见下条——hl-600 在虚拟态同样走这条路径。

### 7.3 hl-600 稳定回归（确认）

hl-600（600 行 ≤ 阈值）在**两种模式下都不过虚拟渲染器**（`chooseSourceRenderer`：`>600` 才虚拟），走的都是 `NumberedCode immediate`——所以回归与开关无关，两种模式都测得到：

| 口径（chromium fs1，7 轮） | median |    p95 | 轮内分布                                                           |
| -------------------------- | -----: | -----: | ------------------------------------------------------------------ |
| 改动前基线                 |  64.60 |  64.80 | 64.6…64.7（极稳）                                                  |
| r0 复测                    |  81.20 |  98.00 | 80.5, 64.7, 81.2, 64.7, 98.0, 97.8, 97.2（双峰：两轮踩回异步路径） |
| virtual 复测               |  97.60 | 114.60 | 114.6, 97.6, 97.0, 98.0, 97.7, 97.5, 97.4（单峰极稳）              |

P3 验收观察到的 114.3ms 即本分布的 p95 档。14 个实测轮里 12 轮 >80ms、除 r0 双峰两轮（64.7）外全部 >64.8 基线 p95——**稳定回归成立**：§5.2 把 ~30ms 的主线程分词（600 行 / 22.6KB）放进了首帧，median 64.6→81.2（r0）/ 97.6（virtual），距 §6.1 门槛 `hl-600 warm ≤50ms` 更远（基线本就未达，见 §3.1；同 `resize.e.softwrap` 先例「不达标时调阈值，回报用户」）。

**可选改进方向（供主会话决策，本包未动产品代码）**：

1. **首帧前分词设上限**（本任务点名方向）：`immediate` 仅对分词成本可证小的文本生效（如 ≤200 行，或按 3000 行/20k token 闸门等比例收缩到「预估 ≤10ms」）；超限回到 §5.1 路径——纯文本首帧 + 空闲高亮（约 50–150ms 后到达）。效果：hl-600 warm 回到 ~65ms 一线，代价是首帧到高亮之间有一段纯文本闪烁（§5.2 本要消除的正是这个闪烁——回退即权衡）。
2. **接受回归，调门槛**：hl-600 是闸门内文件的上沿样本（600 行恰好压线）；97.6ms median / 114.6ms p95 仍在「点击后有感知但不卡」区间。把 §6.1 的 `hl-600 warm ≤50ms` 调成与实现一致的值（如 ≤120ms），并把「首帧即高亮」写进该行的取舍说明。
3. **折中**：`immediate` 保留但把 tokenize 拆成同步预算 + 余量空闲补（首帧只保证前 N 行已高亮）——实现面最重（要改 `useHighlightParts` 的分块分词），不建议在本线内做。

### 7.4 附注

- 本次复测的 runner 即跟进 #1/#2 之后的版本（默认 scratch 输出、`lines.*` 虚拟感知断言：virtual 态断言 `.pv-virtual` 在场、挂载块数 3–16、`.pv-line` 数 = 块数 × 32 且 < 全文行数；r0 态保持 3609/701 全量断言）。
- `--quick --virtual` 与 `--quick`（r0）各跑一遍，failures 均 = 0；`git status docs/dev/preview-perf/baseline.json` 无改动（本次未用 `--write-baseline`）。

## 8. P4 收口：`--gate` 落地 + P5 后虚拟基线（2026-10-23）

- runner（P4 版）新增：`--gate` 按 §6.1 门槛表判定（**要求 `--virtual`**，r0 仍是 record-only 对照态）；
  `highlight.stack-3609` 断言分叉——r0 维持「>100 KiB 闸门 ⇒ 无 tok」，virtual 改为「tok 必须经 Worker 到达
  （放宽闸门 256 KiB 下 170,811 B 入闸；回落路径按原闸门必拒，tok 在场即 Worker 证明）+ 打开后主线程
  0 个 >50 ms longtask」（无 longtask API 的引擎如实记录，不判失败）；`activate.perClick` 补记 longtaskCount。
- 命令与结果（三连，均 exit 0、failures=0；`git status docs/dev/preview-perf/baseline.json` 全程干净）：
  `npm run probe:preview-perf -- --virtual --gate`（7 轮全量，gate 11/11 行过）；
  `npm run probe:preview-perf -- --quick`（r0）；
  `npm run probe:preview-perf -- --virtual --write-baseline` → **`baseline.virtual.json`**（P5 后定版基线，提交物）。
  WebKit 三次均 skip（launch 即退，补测命令见 `acceptance.md` §H）。

### 8.1 虚拟基线数字（baseline.virtual.json，Chromium headless fs1 1440×900，7 轮 median / p95，ms）

| 指标                                 | r0 基线（§3） | virtual·P3 复测（§7.1） | virtual·P5 后定版 | 备注                                                        |
| ------------------------------------ | ------------: | ----------------------: | ----------------: | ----------------------------------------------------------- |
| `open.warm.stack-3609.ts`            |       148/173 |               47.8/63.7 |     **51.5/52.3** |                                                             |
| `open.warm.stack-3609.ts`（390×844） |       164/197 |                       — |     **64.2/68.1** |                                                             |
| `open.cold.stack-3609.ts`            |       231/247 |               97.2/97.5 |     **80.3/95.9** |                                                             |
| `open.warm.hl-600.ts`                |     64.6/64.8 |            97.6/114.6 ⚠ |     **63.5/79.8** | P5 尺寸闸门（≤200 行/8 KiB）把 600 行档回异步路径，回归消除 |
| `open.warm.uploads-2292.ts`          |       113/115 |               50.3/51.2 |     **47.7/48.1** |                                                             |
| `gesture.drag`                       |     1.22/1.39 |               0.35/0.50 |     **0.47/0.59** | stepMax 3.83 · longtask 0                                   |
| `gesture.resize.e`                   |   21.47/22.22 |               0.46/0.56 |     **0.67/0.89** | stepMax 3.42 · longtask 0（r0 曾 413 个 longtask）          |
| `gesture.resize.e.softwrap`          |     5.94/6.22 |                       — |     **6.57/7.01** | stepMax 24.94 · longtask 0（hl-600 非虚拟路径）             |
| `activate.perClick`                  |     0.01/0.03 |                       — |     **0.01/0.04** | longtask 0                                                  |
| `scroll.wheel.perStep`               |     0.00/0.00 |               0.79/0.92 |     **1.31/1.59** | 含块挂载；longtask 0                                        |
| `scroll.farjump`                     |   13.03/22.45 |              7.08/15.37 |     **12.5/33.6** | 方差大，未设闸（§8.2）                                      |
| `highlight.busy`（uploads-2292）     |       269/475 |                       — |     **23.0/27.6** | Worker 路径主线程忙时（r0 是主线程 Prism 全程）             |
| `stream.append.perChunk`             |       117/125 |                       — |     **36.7/49.9** |                                                             |

读数：§3.1 的方向性预期全部兑现——resize.e 21.5→0.67 ms/步、cold 231→80、hl-600 的 §5.2 回归被 P5 尺寸闸门
消除（97.6→63.5，回到基线一线）、Worker 把闸门内文件的打开→高亮主线程忙时 269→23 ms；stack-3609 的
Worker 高亮断言两引擎（Chromium/Firefox；WebKit 因缺系统库 skip）全过（tok 到达 + 0 longtask）。

### 8.2 门槛表定稿与取舍（`--gate` 启用 11 行，未启用 5 项均登记在 JSON `gate.disabled[]`）

- **启用**：drag ≤1 · resize e/s/se ≤2 · activate ≤2 · softwrap ≤8（仅均值/p95）· scroll ≤4（均值/p95 + longtask=0）
  · warm open stack-3609 ≤60 · cold ≤110 · hl-600 ≤80 · 窄屏 open ≤80。规则：median ≤t、p95 ≤1.5t、
  单步峰值 ≤min(4t,16)、交互期 longtask=0。
- **调整过门槛（非默改，note 里带出处）**：warm open（plan 50：P3 测 47.8 / P4 测 52.0，骑线于 headless
  ±5 ms 噪声 → 取 60；50 ms 保留在真机清单）；cold（**plan §6.1 的 cold 80 未达成**：headless 噪声带 80–97（P3 97.2 / P4 80.7 /
  复跑 95.7，含 localhost 懒块拉取，主会话裁定统一取 110，真机由 acceptance.md 复核）；
  **hl-600 ≤80 = 实际取舍**：plan ≤50 从未达成（改动前基线已 64.6），P5 尺寸闸门后实测 63.5/79.8，
  取 80（p95 界 120，P3 期间最差 114.6 也覆盖）。
- **不启用**：帧隙 max ≤33（headless rAF 离群点是调度抖动——46 ms 帧隙与 stepMax 2.77/0 longtask 并存，
  r0 基线同形态；记录保留，真机清单终裁）；滚动单步峰值 ≤16（该指标**从未录到过**——wheel 输入切片不进
  devtools.timeline 的 EventDispatch，PB 起即如此，均值行已覆盖）；远跳 ≤10（7.08/10.56 跨线 + 方差随跳距
  走，record-only）；uploads-2292 主线程 ≤30 ms（被 P5 取代：该文件 >600 行走 Worker）；stack-3609 主线程
  0 长任务（**升格为功能断言**，强于均值闸）。

### 8.3 残留登记

- softwrap（hl-600）单步峰值 23.6–24.9 ms 超 16 ms 通用上限、7 轮偶发 1 个 longtask——≤600 行不虚拟化的
  已知代价（plan 该行原文「不达标时调阈值，回报用户」），均值 6.0–6.6 达标；真机清单 A4 终裁手感。
- WebKit 三连 skip（launch 即退）；补依赖命令见 `acceptance.md` §H。
- Firefox 面无 CDP，维持 open/流式/功能断言；`highlight.stack-3609` 在 Firefox 通过（tok 经 Worker 到达；
  longtask API 可用，0 条）。
