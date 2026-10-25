# J1 — 20–30KB 预览卡顿基础修复（jank-20kb LT-2/LT-3 + md 冷开 + focus 小项）

- 日期：2026-10-23 · 分支 dev（P5 `93291695` 之后）· 对应剖析：`docs/dev/preview-perf/jank-20kb.md`
- 范围拍板（用户）：基础修复 + Markdown 打开优化；**不改虚拟化准入阈值**（`PREVIEW_VIRTUAL_MIN_LINES=600` 及 `chooseSourceRenderer` 分支原样），用户可见行为不变；探针未带 `--write-baseline`，`baseline*.json` 未触碰（`git status` 干净）。

## 1. 改动清单

| 文件                                                              | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/shared/highlight-core.ts`          | ① `useHighlightParts` 重构：debounce 后改经 `getHighlightWorkerClient()` 请求（worker 分词），回包 `decodeHighlightSpans` → parts；`fallback` ⇒ §5.1 idle 主线程路径（`scheduleIdleTask` + 手势/滚动回避，`highlightInteractionBusy()`——共享版 §5.1 `busy` 信号：`PW_DRAGGING_CLASS` + 150ms 滚动窗，惰性装一个 passive capture 监听）；epoch 作废 + 卸载取消。② `parts` `ref`→`shallowRef`，`flattenTokens`/decode 结果 `markRaw`（任务 3）。③ 新增 `startHighlightBatches`：分批应用调度器（setTimeout(0)/批，选区推迟，取消语义），常量 `HIGHLIGHT_BATCH_MAX_PARTS=512`。④ `scheduleIdleTask` 导出（MdPreviewBody 复用）。`immediate`（§5.2 ≤200 行/≤8KiB 同步首帧）**保持在主线程同步执行**，语义不变；流式仍不高亮。 |
| `src/web-hub/ui/src/components/shared/highlight-worker-client.ts` | `request(text, lang, opts?)` 可选 `maxTokens` 透传（缺省字段 ⇒ worker 默认 80k，虚拟路径字节不变）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/web-hub/ui/src/components/shared/highlight-worker.ts`        | `HighlightWorkerRequest` 可选 `maxTokens`：良构值覆盖该请求的 `flattenTokens` 预算；缺失/NaN/非正 ⇒ 保持 `HIGHLIGHT_WORKER_MAX_TOKENS`=80k（**回归修复**：初版误把缺省预算降到 20k，被 `probe:preview-perf` 的 `highlight.stack-3609` 抓到——170KiB/3609 行在 20k 预算下被降级为 plain）。                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/web-hub/ui/src/components/shared/NumberedCode.vue`           | 分批应用（任务 2）：`appliedParts` 游标走**扁平 parts 数组**，`nextCursor` 先按 ~512 parts 推进、再**扩展到行尾**（批边界永不切开逻辑行 ⇒ 每个 `.pv-line` 块只被一个批次弄脏）；staged 视图 = parts 前缀 + 剩余文本一个 plain blob（`splitPartsIntoCodeLines` 切行），textContent 逐阶段字节一致；`lines` 计算值 `markRaw`。`immediate` 跳过分批（首帧即全量高亮）。                                                                                                                                                                                                                                                                                                                                                      |
| `src/web-hub/ui/src/components/shared/HighlightedCode.vue`        | 同上（parts 前缀 + plain 尾文本节点，512 parts/批）；行号关/降级/md 围栏/`CodeBlock` 共用此路径。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/web-hub/ui/src/components/preview/PreviewHost.vue`           | 任务 4：`focusRequest` 落焦推迟到渲染后一个宏任务（`nextTick` → `setTimeout(0)`），focus() 的强制布局不再骑在打开长任务里；新请求取代未决 timer；关闭路径的 landFocus 不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/web-hub/ui/src/composables/usePreviewWindowCycle.ts`         | 适配 4：`landOnWindow` 等待宿主落焦**可观察**（nextTick×2 + 有界宏任务轮询 ≤20 轮）——否则 `lastFocused` 永不记录、每次 Ctrl+` 都重取快照，激活重排会翻转环方向。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/web-hub/ui/src/components/preview/MdPreviewBody.vue`（新增） | 任务 5：渲染视图 md 渐进挂载——首帧只挂前 `MD_PREVIEW_FIRST_BLOCKS=8` 个顶层块，其余 idle 批（`MD_PREVIEW_BATCH_BLOCKS=24`，`scheduleIdleTask`）；**追加式**（已有 DOM 绝不重写、滚动不跳、选区安全），最终 DOM 与全量 `MdBlock` 字节一致（它就是对增长前缀切片的一个真 `MdBlock`）。流式渲染视图与 transcript 不走此组件。围栏高亮自动经第 1 项的 worker 通路（各 fence 的 150ms 去抖从各自挂载时刻起算，渐进挂载天然错峰 + 共享 worker 串行合并——即「合并调度」）。                                                                                                                                                                                                                                                      |
| `src/web-hub/ui/src/components/preview/PreviewText.vue`           | 渲染视图 `MdBlock` → `MdPreviewBody`（仅此一处；流式 mdSegs 分支原样）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 测试                                                              | 新增 `tests/web-hub/ui/highlight-j1-worker.test.ts`（非虚拟 worker 通路、20k 预算透传、epoch/卸载、fallback、plain、原闸门不动、worker 协议 maxTokens）、`highlight-j1-batches.test.ts`（分批可见的中间态、最终 DOM 完整、**选区推迟/外部选区不推迟**、文本变更取消、immediate 不分批、plain blob 尾节点、降级）、`md-preview-mount.test.ts`（首帧 8 块、idle 补齐、最终 DOM 与直挂 MdBlock `innerHTML` 相等、只增不减、卸载停链、PreviewText 集成 + 渲染⇄源码往返）。既有测试更新（时序适配，非语义）：`preview-host` / `preview-window-cycle` / `preview-windows` / `preview-windows-phone` 的 tick/settle 加一个宏任务冲刷（对应任务 4 的推迟落焦）；`preview-line-numbers` 3000 行计数测加「分批落定」等待。          |

## 2. 闸门选择（任务 1 的「写明你的选择」）

**非虚拟路径的准入闸门维持原值，不放宽**：字节 100 KiB、行数 3000（`shouldHighlight` 默认）、token 预算 20k——并且 **worker 请求显式携带 `maxTokens=20000`**，使 worker 侧 `flattenTokens` 的降级集合与改动前主线程路径**逐字节一致**（哪些文件被高亮完全不变；`highlight-j1-worker.test.ts` 断言 `maxTokens===20000` 与 >100KiB 不发请求）。plan §5 的放宽规则（256 KiB / 80k / 行数不限）继续**仅属虚拟路径**：把它套到非虚拟体会 (a) 改变用户可见的高亮范围，(b) 允许最多 80k span 灌进全量 DOM 正文——正是本任务要消灭的 LT-3 放大。回落腿（worker 不可用/超时/错误）同样走原闸门 + §5.1 idle 调度 + 手势/滚动回避（与虚拟回落同一套规则，现已挂在两条路径上）。

## 3. 选区 / 查找 / 复制语义（任务 2 的说明）

- **纯文本与高亮行内容逐字相同**（同一个 parts 源，classed 与否不影响字符），任何阶段的 `textContent` 都等于全文 ⇒ `copyValue`（读 `shownSource`，从不读 DOM）、Ctrl+A、浏览器查找语义不变。
- **P3 窗内查找只存在于虚拟视图**（`findable = virtualized`），非虚拟路径不涉及；虚拟路径本包未触碰。
- **选区**：批次应用会重写该行的子节点，无法在原位保持跨子节点的 DOM 选区——按任务书采用推迟策略：`startHighlightBatches` 在每批前检查 `document.getSelection()`，**非折叠选区与本体重写子树相交（任一端点在 `root` 内，含跨越选区）即推迟剩余批次**（`selectionchange` 立即恢复 + 500ms 兜底轮询，防「一直按住选区」静默卡死）；选区在别处不影响。已有选区在已应用行内不会被再次重写（行只被一个批次触碰）。immediate 小文件同步换装语义不变（PB §7.3）。
- **md 渐进挂载是纯追加**：不重写任何已挂节点，无选区/滚动影响。

## 4. 数字（harness：`/tmp/pwh-jank`，与 jank-20kb.md 同一方法学；4× = `Emulation.setCPUThrottlingRate`）

### 4.1 4× CPU 节流（3s 窗口；「前」= jank-20kb.md §2.2）

| 语料               | 前 warm Σ（明细）  | **后 warm Σ（明细）** | 前 cold Σ               | **后 cold Σ**               |
| ------------------ | ------------------ | --------------------- | ----------------------- | --------------------------- |
| ts-400             | 494（107/204/183） | **59**（单 59）✔      | 580（187/243/150）      | **171**（LT-1 单个，见下）✔ |
| vue-450            | 511（64/238/209）  | **56**（单 56）✔      | 761（176/368/217）      | **185**（LT-1 单个）✔       |
| oneline.json       | 630（333/297）     | **312**（105+207）✘   | 749（147/334/268）      | **504**（132/144/228）✘     |
| min.js             | 327（171/156）     | **227**（78+149）✘    | ~（171/156 @warm 口径） | **398**（136/109/153）✘     |
| md-24k             | 179（单 179）      | **0** ✔               | 552（**496**/56）       | **149 单冻结 ✔（<150）**    |
| ts-620（虚拟对照） | 0                  | 0 ✔                   | 156（LT-1）             | 0 ✔                         |

- ts-400 / vue-450 warm：**Σ<100 且 max<80 达标**；cold 只剩 LT-1（171/185ms：fetch+挂载+Prism chunk eval+首帧布局，任务书允许「cold 首开 LT-1 存在」，写明于此）——分词与换装长任务均消失（tok 到达 +470/+500ms，全程无分词/换装 LT）。
- md-24k：warm 0 LT；cold 单冻结 **149ms < 150** ✔（剖析时 496ms）。首帧块数取 8（16 时 cold 190ms，8 后 147–149ms 两轮稳定）。
- **oneline.json / min.js 未达标（残留，见 §6）**：但相对剖析值改善 2–2.5×（630→312、327→227 warm）。

### 4.2 1×（对照 jank-20kb.md §2.1「前」）

| 语料           | 前 warm 3s LT 总/最大 | 后 warm     | 前 cold         | 后 cold   |
| -------------- | --------------------- | ----------- | --------------- | --------- |
| ts-400         | 0–54 / 54             | **0 / 0**   | +1 LT、95–164ms | 55 / 55   |
| vue-450        | 111–129 / 56–72（×2） | **0 / 0**   | 580（@4× 口径） | **0 / 0** |
| oneline.json   | 113–123 / 57–72（×2） | **52 / 52** | 749（@4× 口径） | **0 / 0** |
| min.js         | 0–80 / 80             | **0 / 0**   | —               | **0 / 0** |
| md-24k         | 50–68 / 68            | **0 / 0**   | 552（@4× 口径） | **0 / 0** |
| ts-620（虚拟） | 0                     | 0           | 156（@4× 口径） | **0 / 0** |

### 4.3 虚拟路径不回退（`npm run probe:preview-perf -- --virtual --gate`，对照 `baseline.virtual.json`，chromium fs1 1440×900，median）

| 指标                      | baseline | 本次 run1 / run2                    | 结论                |
| ------------------------- | -------- | ----------------------------------- | ------------------- |
| open.warm.hl-600.ts       | 63.5     | 64.2 / 65.2                         | 持平 ✔              |
| open.warm.uploads-2292.ts | 47.7     | 47.4 / 47.5                         | 持平 ✔              |
| open.warm.stack-3609.ts   | 51.5     | 51.7 / 51.9                         | 持平 ✔              |
| open.cold.stack-3609.ts   | 80.3     | 96.5 / 96.3                         | **+16ms，见 §6 注** |
| highlight.busy            | 23.0     | 18.3 / 19.6                         | 更优 ✔              |
| gate                      | —        | **11/11 rows pass，exit 0**（两次） | ✔                   |

## 5. 自验

| 命令                                                   | 结果                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/web-hub/ui --maxWorkers=2`       | **251 文件 / 5613 测试全过**（含新增 3 文件 24 测试）                                                                                                                                                                                                                                                |
| `npx vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json` | 通过                                                                                                                                                                                                                                                                                                 |
| `npm run typecheck`                                    | 通过（本次无 traffic 并行包报错）                                                                                                                                                                                                                                                                    |
| `npm run build:web && npm run check:web`               | 通过（first-screen 347317B gz / 524288B 上限）                                                                                                                                                                                                                                                       |
| `npm run probe:csp`                                    | PASS（含 P5 worker CSP 实测 Chromium+Firefox）                                                                                                                                                                                                                                                       |
| `npm run probe:preview-perf -- --virtual --gate`       | **exit 0，11/11**（期间抓出并修复 worker 缺省预算回归，见 §1）                                                                                                                                                                                                                                       |
| 上述 4×/1× 性能数字                                    | 见 §4（`/tmp/pwh-jank/out-j1c-throttle4.json`、`out-j1d-1x.json`；未带 `--write-baseline`，`git status docs/dev/preview-perf/baseline*.json` 干净）                                                                                                                                                  |
| `prettier --check`（本包全部改动文件）                 | 全过。注：未跟踪的 `tests/conformance/traffic.test.ts`、`tests/conformance/fixtures/openai-stub.ts`、`tests/conformance/__dbg2.test.ts`、`scripts/dev/secure-ns-probe.sh`、`docs/dev/data-encryption/*` 系**外部已有**的在制文件，本包未触碰（prettier 对其中 conformance 两文件报错亦非本包所致）。 |

## 6. 残留与已知问题

1. **oneline.json / min.js 未达 `<100ms Σ / <80ms 单个`**（4× warm 312/227）。结构性原因（测量实证）：
   - 其正文是**一（极少）条巨行**。挂载本身（纯文本 + 首帧布局 200 个软换行视觉行）就是 105/78ms 的 LT-1——**即使高亮零成本也已越过单只 80ms 与 Σ100 门槛**；
   - 行内再细分批是**二次方**（实测 Σ1.7s @4×）：任何行中插入都会让整块重排，批越多次数越多；本包的行尾对齐游标让每块只脏一次（单批 ≈ 改动前的整块换装，300→207ms）。
   - 可达成的两条结构性出路都在本任务拍板之外：**(a)** 虚拟化准入按字节补一刀（jank-20kb §4.4——用户已裁定不改阈值）；**(b)** 渲染机制换 Custom Highlight API（零 DOM 写入、无布局，只重绘——`::highlight()` 仅支持 color/background/decoration，需把 `.tok-*` 主题翻成 highlight 规则 + K9 无 API 回落，属渲染机制改造）。建议作为独立后续包裁决。
2. **stack-3609 cold +16ms（80.3→96.3/96.5，两次一致）**：warm 全平、gate t=110 绿。该路径（虚拟）本包无逻辑改动；cold 单轮采样 + 本机当日负载差异是主要嫌疑（剖析报告记录的虚拟 cold open @1× 本就在 95–164ms 区间，本次 /tmp harness ts-620 cold 96ms 落在区间内）。列为观察项：若后续复测仍 >90ms 再归因。
3. **PreviewHost 落焦推迟一个宏任务**：紧邻的多个 focusRequest 只落最后一个（旧行为是同帧内依次聚焦、最终态相同）；焦点/读屏契约（落点、关闭返回、环方向）由更新后的测试与 `usePreviewWindowCycle` 的可观察等待保持。
4. **`landOnWindow` 的有界轮询**（≤20×宏任务）是对「宿主推迟落焦」时序的适配；正常 1–2 轮即命中。
5. **行号关（HighlightedCode）路径**的游标是纯 parts 计（无行尾对齐）：多行文件行为与行号开一致；**巨行 + 行号关**（不在验收矩阵）仍会是单个大批次，与 §6.1 同因。
6. md 首帧块数=8/批 24 是拍板值（cold 149ms 达标）；超大 md 的后续块在 idle 补齐期间快速滚动会先看到已挂部分（最终 DOM 一致，纯追加不跳滚动）。

## 验收裁定（主会话，2026-10-23）

- kimi 验收 conditional_pass：md-24k cold @4× 单冻结独立复现 158/163/192ms（目标 <150ms；验收机 loadavg≈3）。方向成立（496ms → 约 160–190ms，约 3×）。主会话裁定：作为已接受残留合入，真机按 acceptance.md 复核；若真机仍明显卡，再降 `MD_PREVIEW_FIRST_BLOCKS`（现 8）或把首帧改为按字节预算。
- `jank-20kb.md` 的 prettier 表格格式已修。
