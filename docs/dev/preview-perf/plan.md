# web-hub 预览大文本性能 · 施工方案（plan r3）

- 日期：2026-10-23 · 分支：dev（r1 写于 933b1f46；r2 核对时 HEAD 为 6c24e813，预览 UI 路径只有 P0 在途改动）· 上位：`explore.md`（剖析数据与代码坐标）
- 范围：预览窗口**文本源码视图**（非流式 `<pre>` + 流式源码段）的打开、滚动、拖动、8 向缩放。Markdown 渲染视图、HTML、图片、目录的 DOM 不改，只顺带吃到 P0 的收益。
- r2 起因：评审 r1（gpt-6.1-sol，`/tmp/preview-perf-review-r1.json`）判打回，2 Blocker / 7 Major / 4 Minor，逐条处置见文末 **§R1**。r2 的总体取向是**缩小承诺换取可靠性**：
  - 原生选区只保证覆盖「已挂载的连续范围」；
  - 新增**窗口级「完整视图」**作为读屏、原生查找、原生选择的逃生口；
  - 高亮放宽改由 **Worker** 承担（单独一包），在它落地之前维持原闸门；
  - 验收门槛改为在**真实构建产物**上测量。
- r3 起因：r2 复审（`/tmp/preview-perf-review-r2.md`）两项 Blocker 已闭合，剩 2 项严重：
  - 截断标记被排到了行终止符之后；
  - 查找的增量补搜与全量搜索结果不一致。

  另有若干项部分闭合。按 dev-flow 收敛规则，第三轮由主会话裁定、作者修订、主会话核对闭合，不再开评审。逐条处置见文末 **§R2**。

- 用户已于 2026-10-23 接受 r2 全部五项收窄与工期。§0 原「需用户复核」改为「已拍板」。
- **P0（§3）已开发完成，正在验收；本节冻结，r2 / r3 都未改动其正文。**

---

## 0. 决策摘要（一页）

**结构**：P0（几何变量注册为非继承，在途）→ PB（真实构建性能探针 + 改动前基线）→ P1a（冻结接口，单一 owner 先提交）→ P1（纯逻辑）∥ P2（虚拟渲染组件）→ P3（接线、查找、完整视图）→ P5（Worker 高亮，兑现闸门放宽）→ P4（多浏览器、真机、读屏验收）。

**与用户已拍板项的对照**

| 已拍板                             | r3 状态                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| >600 行虚拟化                      | 保持（`PREVIEW_VIRTUAL_MIN_LINES = 600`；PB 用真实构建实测 600 行高亮 / 长行 / 窄屏后再定稿，若不达标回报而不是硬上）                           |
| 虚拟模式不换行                     | 保持                                                                                                                                            |
| 拦截 Ctrl+F 打开窗口内查找         | 保持；规则写实为「焦点在窗口内且不在查找框里就拦截」，并把浏览器原生查找改称「页面查找（只含可见部分）」，不再叫逃生口（§4.6）                  |
| 高亮闸门放宽到 256 KiB / 80k token | 保持目标；**实现改为 Worker（P5）**，Worker 落地前及 Worker 不可用时，虚拟模式沿用原闸门（100 KiB / 3000 行 / 20k）——**已拍板 ①（2026-10-23）** |
| 超长行屏显截到 4096                | 保持；截断标记改为 CSS 生成内容（不进入 DOM 文本；r3：挂在行终止符之前的空 span 上，§4.2），原生复制只得到屏显前缀——**已拍板 ②（2026-10-23）**  |
| `path:123` 跳行以后做              | 保持（本期只暴露 `scrollToLine`）                                                                                                               |
| 行号关时保持单文本 DOM             | 保持；r2 另外把同一条 DOM 路径做成**窗口级「完整视图」开关**——**已拍板 ③（2026-10-23）**                                                        |

**已拍板（2026-10-23，用户接受 r2 全部五项收窄与 13.5 人日；r3 只修正确性，不改这五项）**

1. **高亮放宽分两步**：P3 先以原闸门上线虚拟化，P5 再用 Worker 兑现 256 KiB / 80k token；Worker 不可用时回落原闸门。
2. **超长行**：屏显截到 4096。截断部分原生拖选复制拿不到；完整内容走「复制全部」（头部复制或 Ctrl+A）、完整视图或下载。
3. **窗口级「完整视图」开关**：只影响当前窗口，渲染与「行号关」相同的单文本 DOM，作为读屏、原生查找、原生选择的出口。
4. **原生选区收窄**：选区期间挂载范围只增不减、保持连续，上限 2048 行。超出上限或 Shift+点击已卸载位置时不保证。Ctrl+A 为逻辑全选。
5. **读屏验收**：最低 Orca + Firefox；NVDA / VoiceOver 有条件再做。

其余技术决策（不需要拍板）：

- 行数上限按实测行高动态计算：`floor(15e6 px / rowH)`，最多 50 万行。300% 字号下约 25.6 万行。
- 字号变化时按逻辑行重新定位滚动位置。
- 大小写不敏感查找使用**保持长度的逐码点折叠**（`İ` 这类长度会变的映射按原样比较）。
- CSS Custom Highlight 由全局单例管理器统一管理。
- `CodeLines.vue` 零改动：虚拟模式使用新的 `VirtualBlock.vue` 渲染器，CodeLines 继续服务 ≤600 行的路径。

**估时**：PB 1.5 · P1a 0.5 · P1 2.25 · P2 3.25 · P3 3 · P5 2 · P4 1.5，合计约 **14 人日**（不含 P0）。墙钟约 8～9 天：PB ∥ P1a → (P1 ∥ P2) → P3 → (P5 ∥ P4 前半)。r3 比已拍板的 13.5 多出 +0.5，原因有两项：

- P1：查找的码点 carry 加增量与全量的差分属性测试，+0.25；
- P2：截断行的结构与三引擎布局断言，+0.25。

关停开关（§4.1）沿用原有分支，不增加工期。

---

## 1. 现状与 r1 的补测结论（不变部分从简）

- 拖动和激活卡顿的主因是**继承型自定义属性引起整子树样式重算**（`--pw-*` 写在 `.preview-window` 上），不是 layout。P0 用 `@property … inherits:false` 处理。按评审意见：它不是对子树 layout/paint 的免疫，宽高变化仍会引起子孙布局；0.0 ms 是有限计时精度下的读数，不代表零成本；P0 的收益以 PB 在真实构建上的 trace 为准。
- 横向缩放剩下的约 34 ms 是软换行重排，只能靠减少同时在场的行数，也就是虚拟化。
- 开窗口时点击激活会给**每个**窗口重写 `--pw-z`，原来是 N×30 ms。P0 已覆盖。

## 2. 微基准数据（口径说明）

r1 的表 A–D（`/tmp/preview-perf/exp/gen*.mjs`、`~/preview-perf/exp1–5.html`）在 r2 中**降级为「同步 flush 微基准，只看方向」**，不作为验收依据。评审指出的口径缺陷如实登记：

- exp5 的 mount 计时从 `build()` 之后开始，只覆盖 replace + layout；
- 600 行高亮那一格是插值，不是实测；
- 几何循环先写 CSS 再开始计时，漏掉了写入阶段；
- exp1 的 mount 每轮只取一次；
- exp3 是 128 行一块、exp4 是 32 行一块；
- 全部是手写 DOM，没有 Vue VNode、真实事件、ResizeObserver、查找、高亮和选区保护。

验收一律以 §6 的 PB 真实构建探针为准；r1 表格保留在 git 历史里，正文不再引用具体毫秒数作为门槛。

方向性结论仍然成立，PB 需要复测确认：

- 继承变量是拖动和激活的主因；
- 块式虚拟（32 行一块、窗口为可视区 ±1 屏）能把在场 DOM 压到约 200 行；
- Prism 对 170 KB 的 TS 分词约 38 ms（Node，桌面）。

---

## 3. P0 · 拖动/缩放：注册几何变量（不改 R2）

### 3.1 改动（只动 `src/web-hub/ui/src/styles/preview.css`）

在 `.preview-window.is-floating` 规则（约 1089 行）前加：

```css
/* preview-perf P0: geometry vars are NON-inherited — a change must restyle the window box
 * only, never its (possibly 10k-node) content subtree. Without this every drag/activate
 * recalculated the whole text body (30 ms on a 3.6k-line file). Unsupported engines ignore
 * @property and fall back to the old inherited behaviour (slower, never wrong). */
@property --pw-x {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --pw-y {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --pw-w {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --pw-h {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --pw-z {
  syntax: "<integer>";
  inherits: false;
  initial-value: 0;
}
```

- 前置核对（已做）：`var(--pw-*)` 只在 `preview.css:1090-1094`（`.preview-window.is-floating` 自身）和 `:1361`（手机带同一元素的 `z-index`）读取，没有任何后代依赖继承值。`grep -rn "var(--pw-" src/web-hub/ui/src` 共 6 处，全在这两个规则里。
- `varsOf()` 写的是 `"${x}px"`（`usePreviewWindowLayout.ts:171-176`），满足 `<length>`；`--pw-z` 是 `String(1+index)`，满足 `<integer>`。注册后，非法值会回落 initial 而不是 guaranteed-invalid。按现有写法不可能出现非法值，测试会钉住。
- CSP：`@property` 是样式表 at-rule，`style-src 'self'` 下合法。esbuild/vite 原样保留（P0 验收时 grep `dist/web-hub-ui/assets/*.css` 确认）。
- 兼容：Chrome/Edge 85+、Safari 16.4+、Firefox 128+。更老的引擎忽略这条规则，行为与今天一致。
- 文档：在 `docs/dev/web-hub-preview-windows/plan.md` 的修订记录追加一行：「§7.1 变量以 `@property inherits:false` 注册（preview-perf P0）；R2（不用 transform）不变」。usePreviewWindowLayout 头注释的 CSP 段补一句指向这里。

### 3.2 不做的手段及理由

- **transform 移动**：P0 已经把拖动做到 0.0ms，transform 没有剩余收益，反而撞 R2（fixed 后代的 containing block）。不进拍板。
- **rAF 节流 / pointer 合并**：source-scan 禁用 rAF（`tests/web-hub/ui/source-scan.test.ts:54`）；pointermove 在 Chromium/Firefox 本来就按帧对齐，`getCoalescedEvents` 只用于取更多点，减少不了次数。P0 之后单次成本已在 1ms 以下，没有必要。
- **手势期冻结内容宽**：只对 ≤600 行的全量 DOM 横缩有意义，而这一档已经 ≤6ms；虚拟模式不换行，横缩本来就不重排。删掉这个候选。
- `contain: strict`：explore 实测无收益，不做。

### 3.3 测试

- 新增 `tests/web-hub/ui/preview-geom-vars.test.ts`（node 环境，读源 CSS）：五条 `@property` 存在，`inherits: false`，syntax 与上面一致；`var(--pw-` 只出现在白名单选择器里，用来防止以后有后代去依赖继承值。
- 现有 `column-align.test.ts:99-100`、`preview-windows-maximize.test.ts:97-100` 读的是 inline 变量值，不受影响，保持绿。

---

## 4. 虚拟滚动设计

### 4.1 渲染器选择（纯函数 `chooseSourceRenderer`，P1）

| 条件（按顺序判定；r3：先判 kill switch）                      | 渲染器                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`virtualEnabled === false`**（kill switch，见下）           | **委托 r0 选择**：行号关 ⇒ legacy；行号开、非流式 ≤8000 行 ⇒ `NumberedCode`，>8000 行 ⇒ `HighlightedCode` 加 `linesTooMany` 提示；行号开、流式 ⇒ 每段一个 `CodeLines`，累计超过 8000 行后降级为 plain `.preview-seg`。三条与今天逐字节一致 |
| 行号关（`pwh_linenumbers="0"`），**或**当前窗口开启了完整视图 | legacy：非流式为 `<pre><HighlightedCode>`，流式为 `.preview-seg` div。**逐字节不变**（§4.7）                                                                                                                                               |
| 行号开、非流式、`countCodeLines(shownSource) ≤ 600`           | 今天的 `NumberedCode` → `CodeLines` 全量 DOM，只改 §5.2 的首帧高亮时机                                                                                                                                                                     |
| 行号开、非流式、> 600 行                                      | `VirtualCode`                                                                                                                                                                                                                              |
| 行号开、流式                                                  | `VirtualCode`（一律虚拟，避免中途切换渲染器）                                                                                                                                                                                              |

- **kill switch（r3 修正，§R2 #4）**：r2 的「把 `PREVIEW_VIRTUAL_MIN_LINES` 设成 `Infinity` 就整体回到 r0」**作废**。原因有两条：流式路径与阈值无关，而且 8000 行降级不会因此自动恢复。r3 改为：
  - 新增独立常量 `PREVIEW_VIRTUAL_ENABLED = true`，放在 P1a 的 `previewVirtualTypes.ts`；
  - `chooseSourceRenderer(input, { virtualEnabled })` **首先**判断它，为 false 时整体委托 r0 选择（上表第一行）；
  - `PREVIEW_VIRTUAL_MIN_LINES = 600` 只是阈值。

  因此 P3 **必须保留** r0 的三条分支（`NumberedCode` 的 8000 行降级、流式 `srcLineSegs` 逐段 `CodeLines` 及其续行头逻辑），不得删除，只是在开关为 true 时不可达。开关是构建期常量（改值后需要重新 `build:web`），不是运行时设置，用户侧的运行时出口仍是完整视图和行号关。

  测试（§6.3）：`virtualEnabled=false` 时覆盖：
  - 非流式 601 行、非流式 >8000 行（降级加提示）；
  - 流式（行号开，段编号、续行头、累计 8000 降级）。

  逐项与今天的 DOM 断言相同。这些是**原有用例原样保留**，在 `virtualEnabled=false` 下运行，不再迁到 `code-lines.test.ts`（见 §6.3 修订）。

- `PREVIEW_NUMBERED_LINES_MAX`（8000）和 `preview.linesTooMany` 在开关为 true 时不可达，开关为 false 时仍然生效。保留，不清理。

### 4.2 冻结接口（P1a 单一 owner 先提交 `logic/previewVirtualTypes.ts`；P1、P2、P3 只消费，不改）

```ts
/** One displayed fragment; `cls` "" = plain text node, else a `tok-*` class list. */
export interface DisplayPart {
  readonly cls: string;
  readonly text: string;
}

/** One logical line AS DISPLAYED (P1 builds it; VirtualBlock renders it verbatim).
 *  r3: the terminator is a SEPARATE field — the clip marker must render BEFORE it (§4.2 below). */
export interface DisplayLine {
  /** Display parts WITHOUT the line terminator: the line's first ≤ PREVIEW_VLINE_DISPLAY_MAX
   *  code units (surrogate-safe: never ends on a lone high surrogate). A token part that
   *  carried the "\n" in the source (cross-line comment/string) is cut: its "\n" moves to `eol`. */
  readonly parts: readonly DisplayPart[];
  /** The line's own terminator ("\n"), or "" for an unterminated last line. Always rendered as
   *  the line element's LAST child, a plain text node (block-final ⇒ swallowed by the browser,
   *  exactly CodeLines' mechanism) — never inside a token span, never after the clip marker. */
  readonly eol: "\n" | "";
  /** Hidden code units after the display cut (0 ⇒ not clipped). Rendered ONLY as CSS generated
   *  content on an EMPTY marker span placed between `parts` and `eol`, never as DOM text. */
  readonly clipped: number;
}

/** The single text model behind a virtual body (source = ANSI-stripped LOADED text). */
export interface VirtualTextSource {
  /** Monotone; bumps on append AND on highlight arrival. */
  readonly revision: number;
  /** What the last bump changed — drives incremental consumers (find, renderer). */
  readonly lastChange:
    | { readonly kind: "init" }
    | { readonly kind: "append"; readonly fromLine: number; readonly fromOffset: number }
    | { readonly kind: "highlight" };
  /** Logical line count (countCodeLines semantics: a source-final "\n" adds no phantom line). */
  readonly lineCount: number;
  /** Total loaded length (UTF-16 code units) == text().length. */
  readonly length: number;
  /** The whole loaded text (same string instance PreviewText already holds — no copy). */
  text(): string;
  /** text().slice(start, end) — bounds clamped. */
  slice(start: number, end: number): string;
  /** Offset of line i's first code unit; lineStart(lineCount) === length. */
  lineStart(i: number): number;
  /** Line i incl. its "\n" (the last line may lack one — and may still GROW on append). */
  lineText(i: number): string;
  /** Display form of line i (clip + highlight applied). Cached per (i, revision class). */
  displayLine(i: number): DisplayLine;
  /** Upper-bound display width in `ch` over ALL lines' DISPLAYED prefix (§4.4); monotone. */
  readonly maxDisplayCols: number;
  /** Binary search: the line containing `offset` (0 ≤ offset ≤ length). */
  lineOf(offset: number): number;
}

export interface VirtualSourceFactory {
  /** Non-stream: one-shot text (+ later highlight). */
  fromText(text: string): MutableVirtualSource;
  /** Stream: starts empty, grows via append. */
  forStream(): MutableVirtualSource;
}

export interface MutableVirtualSource extends VirtualTextSource {
  /** Stream only: the new FULL text (the old text must be its prefix — asserted; violations
   *  throw in dev, rebuild in prod). Scans only [oldLength, newLength). */
  append(fullText: string): void;
  /** Highlight arrival (main-thread or Worker result), see §5. Null ⇒ stay plain. */
  setHighlight(spans: HighlightSpans | null): void;
}

/** Compact, transferable highlight result over SOURCE offsets (Worker-friendly, §5.3). */
export interface HighlightSpans {
  readonly classes: readonly string[]; // index → "tok-…" class list
  /** Triples [start, end, classIdx] sorted by start, non-overlapping; gaps are plain text. */
  readonly spans: Uint32Array;
}
```

- **CodeLines.vue：零改动，说实话的版本**：虚拟模式**不使用** CodeLines。新渲染器 `components/shared/VirtualBlock.vue`（render function，P2 独占）输出与 CodeLines **同一套 DOM 语法**：块根 `span.pv-lines.pv-vblock`，`counter-reset` 等于块起始行号减 1；每行一个 `span.pv-line`；带类的 part 输出 `span.tok-*`。区别有三点：
  - 块根**不设** `--pvline-w`，gutter 宽度由 spacer 统一设置（§4.4）；
  - 被截断的行在 `parts` 与 `eol` 之间插入一个**空** `span.pv-vclip`（`data-clip="<N>"`、`data-clip-label`），标记由它的 `::before` 生成（r3，见下）；
  - 块根带 `data-start`，只用于测试和诊断。

  CodeLines 继续服务 ≤600 行的路径。它的 `continuation` 能力只在关停开关为 false 时的 r0 流式分支里使用（§4.1，r3）。代码和原有测试都原样保留。**禁止** P2 绕过 Vue 直接改 DOM。

- **截断标记与无障碍表达**（`styles/preview-virtual.css`，P2）：

行结构（r3）：

```html
<span class="pv-line"
  >…parts…<span class="pv-vclip" data-clip="N" data-clip-label="本行超长，已截断 N 个字符"></span>"\n"</span
>
```

```css
/* r3 (§R2 #1): the marker is an EMPTY inline span BEFORE the terminator text node, so the
 * terminator stays block-final (swallowed — the line remains ONE line box) and the marker
 * sits on the line's single visual row. Its glyphs exist only as generated content: not DOM
 * text, not in Selection/copy. It contributes no extra line-box height (line-height:inherit,
 * same font, baseline-aligned); the fixed row height then holds by construction. */
.pv-vblock .pv-vclip::before {
  content: "…(+" attr(data-clip) ")"; /* fallback: engines without alt-text read the marker */
  content: "…(+" attr(data-clip) ")" / attr(data-clip-label);
  user-select: none;
  color: var(--c-text-3);
  font: inherit;
  line-height: inherit;
  vertical-align: baseline;
}
```

- 为什么不用 `.pv-line::after`：在 `white-space: pre` 下，行元素里最后一个子节点是 `"\n"` 文本，`::after` 会生成在它之后，标记因此掉到第二个视觉行，和固定行高冲突，会盖住下一行（r2 复审 #1）。改成空 span 放在 `eol` 之前之后，`"\n"` 仍是块末节点，被浏览器吞掉，与 CodeLines 现有的行尾机制完全相同。
- 备选的定位式伪元素（`position:absolute` 贴在行尾）**不采用**：它的水平位置要靠估算文本宽度，而 §4.4 用的是上界估计，标记会与文本之间留出空隙，或者盖到文本上。
- **真实浏览器断言**（PB 功能项，Chromium / Firefox / WebKit 都跑；§6.1）：构造「截断行后紧接一个普通行」，断言：
  - (a) 截断行 `getClientRects()` 中所有矩形的 top 相同（单行盒），且 `getBoundingClientRect().height` 与 rowH 相差不超过 0.5 px；
  - (b) `.pv-vclip` 的包围盒满足 `top ≥ line.top − 0.5`、`bottom ≤ line.top + rowH + 0.5`，且 `left ≥` 文本 Range 的 `right − 0.5`，即标记在该行文本之后；
  - (c) 下一行的 top 等于截断行 top 加 rowH（误差 0.5 px 以内），且下一行文本 Range 的包围盒与 `.pv-vclip` 的包围盒不相交；
  - (d) 选中「截断行 + 下一行」：Chromium 授予 `clipboard-read` 后真实 Ctrl+C，再用 `navigator.clipboard.readText()` 读回；Firefox / WebKit 用 `getSelection().toString()` 作代理。结果都等于「屏显前缀 + `"\n"` + 下一行」，不含 `…(+`；
  - (e) 普通行（未截断）同样满足 (a)，以此确认 `eol` 放在块末确实被吞掉。

`data-clip-label` 由 VirtualBlock 写入 i18n 文案「本行超长，已截断 N 个字符」。生成内容不属于 DOM 文本，也不进入原生复制；读屏通过 alt text 读到说明，不支持 alt 的引擎读到 `…(+N)`。P4 实测（§6.4）。

- **行号的可访问性（如实登记）**：CSS 生成内容在 Chromium/Firefox 会进入可访问树，所以 `::before` 行号**很可能会被读出**。r1 写的「不进入可访问树」是错误推论。虚拟模式下 `.pv-vblock .pv-line::before` 改用 `content: counter(pvline) / ""`，不支持 alt 的引擎继续读出行号。非虚拟路径（`preview.css` 的 `.pv-line::before`，P0 在途的文件）本期不动，在 P4 实测后另立小包。

### 4.3 行高、坐标与上限

- 虚拟体：`pre.preview-text-body.pv-virtual`，规则为 `white-space: pre; overflow-wrap: normal;`。其余样式沿用。
- **行高测量**：探针 `span.pv-vprobe` 放在 `pre` **外**，作为同级兄弟，同字体、同 line-height，带 `aria-hidden`、`visibility:hidden`。mount 时用 `getBoundingClientRect().height` 测得行高（允许小数），之后挂 `observeResize(probe)`。测不到时（happy-dom 下为 0）回落 `13 × fsScale × 1.5`。组件开放 `rowHeight` / `viewportHeight` 两个注入 prop 给测试用。
- 锁高：`.pv-virtual .pv-line { height: var(--pv-row-h); }`，`--pv-row-h` 用 CSSOM 写在 spacer 上。块的 `top = blockIndex × 32 × rowH`，取整误差只落在块内，不累积。
- **行数上限**：`maxLines = min(500_000, floor(VIRTUAL_MAX_PX / rowH))`，`VIRTUAL_MAX_PX = 15_000_000`（低于 Firefox 约 1.78e7 和 Chromium/WebKit 约 3.3e7 的元素尺寸上限）。19.5 px 时约 76.9 万，取 50 万；58.5 px（300% 字号）时约 25.6 万。超出部分不渲染，流尾显示一行「已加载 N 行，超过本视图上限，其余请用完整视图 / 复制全部 / 下载」。复制和查找仍覆盖全部已加载文本。行高变化导致上限变小时，同样按这条规则截断显示。
- **行高重测时的滚动锚点**：ResizeObserver 回调里，先用**旧** rowH 求出 `anchorLine = floor(scrollTop / oldH)` 和 `frac = (scrollTop mod oldH) / oldH`，再写入新的 spacer 高度和 `--pv-row-h`，然后同步设置 `scrollTop = (anchorLine + frac) × newH`，最后重算窗口。整个过程发生在同一次 RO 回调里，即 layout 之后、paint 之前。字号切换（80% / 100% / 300%）、浏览器缩放、字体加载完成都走这条路径，§6 有对应测例。

### 4.4 宽度与 gutter

- **gutter 全文件统一**：spacer 设置 `--pvline-w: <lineNumberDigits(lineCount)>ch`，块根不设，由行继承。流式行数跨过 9 999 等位数边界时只重设一次，整体对齐。
- **横向宽度**：spacer 的 `min-width` 由 JS 算成纯 `ch` 字面量写入，不引用 var：`calc(<digits + 1.5 + maxDisplayCols>ch + 2 × var(--sp-3))`。`--sp-3` 是在 `:root` 上定义的 token，spacer 可以读到。
- `maxDisplayCols` 是**上界估计**，只对**屏显前缀**（≤4096 码元）加截断标记的长度（按 12 列计）计算：
  - ASCII 可见字符记 1；
  - tab 按 8 列制表位展开（`.preview-text-body` 未设 `tab-size`，CSS 默认 8；PB 校验）；
  - 其余所有非 ASCII 码点一律记 2，包括 emoji、CJK、组合字符；
  - 总量封顶 `4096 × 8 + 12` 列。

  因为是上界，已挂载行的实际宽度不会超过它，远处最长行挂载或卸载时 `scrollWidth` / `scrollLeft` 保持稳定（§6.3 测例）。代价是含大量非 ASCII 的文件右侧会多出空白，可以接受。这里不做 Unicode 排版引擎。

### 4.5 窗口、调度与选区（r2 收窄后的承诺）

- **块与窗口**：32 行一块。`computeWindow({ scrollTop, viewportH, rowH, lineCount, overscan, retain })` 返回**连续**的块区间 `[lo, hi]`（纯函数，P1）。overscan 取 1 屏（`pointer: coarse` 时 1.5 屏），并带半块滞回。
- **调度（不用 rAF）**：passive `scroll` 监听加 `observeResize(scrollEl)`，同步计算，块区间变化时才写 `shallowRef`，Vue 在微任务里打补丁。`requestIdleCallback` 只用于 §5 的分词调度，滚动路径不用。
- **选区活跃判定（同步，不依赖 `selectionchange`）**：`selectionActive()` 满足以下任一条件即为真：
  - `pointerdown`（button 0，在虚拟体内）之后、`pointerup` 之前；
  - `getSelection()` 非折叠，且其 Range 与虚拟体相交（`range.intersectsNode(spacer)`）。

  每次计算窗口前、每次准备打补丁前都**同步**调用它。

- **只增不减规则**：选区活跃时，新窗口为 `[min(lo, prevLo), max(hi, prevHi)]`，只扩展不卸载，保持连续，上限 `VIRTUAL_SELECTION_MAX_LINES = 2048`（64 块）。到达上限后恢复正常窗口；此时选区可能被浏览器调整，`role=status` 提示「选区超过 2048 行，无法保持；请用 Ctrl+A 复制全部或切换完整视图」。选区不再活跃时（由 `selectionchange` 检测到折叠或离开虚拟体，异步即可，这里只用于收缩），下一次滚动时收缩回正常窗口。
- **冻结已挂载内容**：选区活跃期间，**已挂载块的 props 引用保持不变**，Vue 因此跳过子组件重渲染，文本节点不被替换。这时：
  - 高亮到达（`lastChange.kind === "highlight"`）和最后一行的增长（append 改变未完成行）都排队；
  - 新挂载的块按当前 revision 渲染；
  - 选区不再活跃时 flush 队列。
- **由此覆盖的原生行为**，P4 在 Chromium / Firefox / WebKit 以及 iOS Safari 真机（有条件时）验证：
  - 区间内拖选，包括边缘自动滚动、反向拖选；
  - Shift + 方向键 / PageDown 扩选；
  - 触屏选择手柄；
  - 原生复制，结果等于屏显文本，截断行只有前缀，标记不被复制。
- **明确不保证**：选区已折叠、滚走后起点块被卸载，再 Shift+点击远处，按新选区处理；跨度超过 2048 行的选区。UI 文案和 §7 都登记了这两条。
- **逻辑全选（Ctrl/⌘+A，焦点在虚拟体内）**：
  - 处理：`preventDefault`，`allSelected = true`，`removeAllRanges()`，spacer 加类 `.is-all-selected`（行背景用 `Highlight` / `HighlightText` 系统色），`role=status` 播报「已选中全部 N 行（已加载内容），Ctrl+C 复制」；
  - 复制：`copy` 事件中若 `allSelected`，`setData("text/plain", source.text())`，取的是复制当下的全部已加载文本，含后来追加的部分；
  - **取消条件**只限明确的新选择动作：虚拟体内 `pointerdown`、Shift 系选择键、Esc，以及 `selectionchange` 产生了新的非折叠选区。滚动、追加、高亮到达、失焦都**不**取消；
  - 状态不依赖任何 DOM 边界，r1 用 live Range 当 token 的做法删除。
- **复制语义区分**（文案与 tooltip 同步）：
  - 原生选区复制 = 屏显文本；
  - Ctrl+A 加复制、头部「复制」按钮 = **已加载全文**；
  - 「下载」= 磁盘文件。

### 4.6 窗口内查找（Ctrl/⌘+F）

- **拦截规则（写实）**：以下条件同时满足时，`PreviewWindow` 面板根的 keydown 才 `preventDefault` 并打开或聚焦查找框（全选输入）：
  - 焦点在该预览窗口内，包括头部按钮和工具栏；
  - 当前视图是虚拟源码视图（`update:findable`）；
  - 焦点**不在**查找输入框里；
  - 不在输入法组合中（`!ev.isComposing && ev.keyCode !== 229`）；
  - 事件尚未被 `defaultPrevented`。

  焦点在查找框内时再按 Ctrl/⌘+F 会放行给浏览器的**页面查找**。查找栏常驻说明里写明：「页面查找只能找到当前可见的行；要找全文请用本查找框，或开完整视图后再用浏览器查找」。完整视图开着、或焦点不在窗口内时，一律不拦截。

- 查找栏常驻说明，一行灰字：「范围：本文件已加载内容 · Enter / F3 下一个 · Shift+Enter / Shift+F3 上一个 · Esc 关闭」。Mac 上显示 ⌘G / ⇧⌘G。
- 键位：Enter / Shift+Enter、F3 / Shift+F3、Ctrl/⌘+G / Shift+Ctrl/⌘+G。组合输入中的 Enter 一律忽略。Esc 在查找框内 `preventDefault + stopPropagation`，只关查找框，焦点回到滚动容器；PreviewHost 的 Esc 分支会检查 `ev.defaultPrevented`，所以不会顺带关窗。
- **匹配语义（`logic/previewFind.ts`，P1）**：
  - 大小写敏感：直接在 `source.text()` 上做 `indexOf`。
  - 大小写不敏感：使用**保持长度的折叠** `foldSameLength(s)`。按码点逐个 `toLowerCase()`，结果的 UTF-16 长度与原码点相同才采用，否则保留原码点。因此 `İ`、`ẞ` 等长度会变的映射按原样比较，`Σ` 逐码点折叠，与上下文无关。查询串用同一个函数折叠。折叠串与原文**逐码元等长**，命中偏移可以直接用于原文。语义登记在 UI tooltip 中。
  - 匹配不重叠，上限 10 000（超出显示 `10000+`），输入有 120 ms 去抖（`setTimeout`）。
- **匹配的规范定义（r3）**：命中是**贪心不重叠**序列，与全量搜索一致：
  - `h₁ = indexOf(q, 0)`，`hₖ₊₁ = indexOf(q, hₖ + |q|)`，直到找不到；
  - 达到 `FIND_MAX = 10 000` 时停止，并做**一次**「是否还有更多」探测：`more = indexOf(q, h₁₀₀₀₀ + |q|) ≥ 0`；
  - `q` 为空时没有命中。

  大小写不敏感时，在**稳定折叠前缀**上搜索（定义见下）。

- **缓存与 revision 协议（r3 重写，§R2 #2）**：
  - **折叠的码点 carry**：
    - 折叠缓存保存 `folded` 与 `stableLen`。`stableLen` 是已经按完整码点折叠完毕的前缀长度：原文末尾若是**孤立的高代理项**，它暂不折叠，此时 `stableLen = length − 1`，否则 `stableLen = length`。
    - `append` 时从 `stableLen` 起重新折叠 `[stableLen, newLength)`，拼到 `folded.slice(0, stableLen)` 之后，然后同样重算新的 `stableLen`。
    - 流式到达终态（`done` / `cap` / `changed`），或非流式一次建成时，末尾的孤立高代理项按原样计入（`stableLen = length`），这一步叫 **flush**。
    - 因此任意切点追加（包括把代理对切在两次 append 之间）后，`folded[0, stableLen)` 都等于 `foldSameLength(text)[0, stableLen)`。
    - 不要求调用方保证 append 码点完整。PreviewText 传入的 `copyValue` 来自整段 UTF-8 解码，通常码点完整，但 carry 不依赖这一点，由 P1 自己保证。
    - 大小写敏感模式没有折叠，同一协议退化为 `stableLen = length`。
  - **增量补搜**：
    - 只保留 `end ≤ stableLen_new` 的旧命中，正常情况下就是全部。旧命中 `end > stableLen_new` 只会在「旧文本末尾的孤立高代理项本身被命中」时出现，这类命中丢弃后重搜。
    - 补搜起点：`resume = max(stableLen_old − |q| + 1, lastKept.end)`，其中没有保留命中时 `lastKept.end = 0`，起点再与 0 取 max；然后从 `resume` 起继续贪心扫描，直到 `stableLen_new`。
    - 正确性：贪心序列具有**前缀性质**。文本只在尾部增长时，已保留的命中仍然是新文本的贪心前缀。任何新命中都必须越过旧的稳定边界（否则旧扫描早已找到），而且贪心语义要求它从 `lastKept.end` 之后开始，所以上式不会漏掉命中，也不会产生重叠。
    - 反例 `q = "aa"`：旧文本 `"aaaa"` 的命中是 `[0, 2]`，`lastKept.end = 4`；追加 `"a"` 后，`resume = max(3, 4) = 4`，`"a"` 不足一次命中，结果仍是 `[0, 2]`，与全量一致。r2 公式会从 3 开始，得到与 2 重叠的错误命中。
  - **去重与上限**：补搜只往末尾追加，起点不小于 `lastKept.end`，按构造不会重复；实现里断言 `hᵢ ≥ hᵢ₋₁ + |q|`。旧命中已达 `FIND_MAX` 时**不再补搜**，只重做 `more` 探测，起点仍是 `h₁₀₀₀₀ + |q|`，范围扩到新的 `stableLen`。截取前 10 000 个贪心命中同样满足前缀性质，所以与全量结果一致。
  - **当前项保持**：当前项用**起点偏移**标识。append 后它仍在保留列表中，索引不变。只有它恰好因 carry 被丢弃时，才改为「起点 ≥ 原起点的第一个命中」，找不到就落到最后一个命中。
  - `highlight` 不改变文本，只重建可视范围的高亮 Range；
  - 查询或大小写开关变化时全量重搜，当前项落到「第一个 ≥ 当前视口首行」的命中；
  - 流式 `changed` / `cap` / `error` 状态不影响已加载文本上的查找。
- **命中显示**：先 `scrollToLine(line, "center")`，在下一次 post-flush 回调里为已挂载块重建 Range。
  - 首选 **CSS Custom Highlight**，由单例 `composables/useFindHighlights.ts`（模块级）注册文档级的 `pv-find` / `pv-find-cur` 两个 `Highlight`。各窗口通过 `setRanges(ownerId, all, cur)` 提交自己的 Range，管理器取并集；`release(ownerId)` 只移除该 owner 的 Range。两个窗口同时查找、关闭其中一个，有测例覆盖。
  - 不支持 Custom Highlight 时，只把当前项设为原生 selection。这会让 §4.5 的选区规则生效，属于预期行为。
  - 命中位于截断区时，标到截断点，计数旁注「超出显示部分」，并提示用完整视图查看。

### 4.7 完整视图（窗口级逃生口，已拍板 ③）

- `PreviewWindow` 持有每个窗口的 `fullView`（默认 false，窗口关闭前一直保留，跨文件导航仍然有效），作为 prop 传给 PreviewText。虚拟源码视图可用时，头部显示「完整视图」按钮（`aria-pressed`，tooltip：「渲染全部已加载内容，便于读屏连续阅读、浏览器原生查找与选择；大文件下拖动和缩放会变慢；只影响本窗口」）。
- `fullView=true` 时，渲染器的选择等同于行号关（legacy 单文本 DOM 或 legacy 段）。全局行号开关不变，其他窗口不受影响。查找快捷键不再拦截。
- 虚拟体的 `aria-describedby` 指向 sr-only 说明：「大文件按需渲染，读屏只能读到当前可见部分。按『完整视图』按钮（只影响本窗口）可以连续阅读整份已加载内容；Ctrl+F 在文件内查找；Ctrl+A 再 Ctrl+C 复制全部」。

### 4.8 流式（行号开）

- PreviewText 继续用现有的 source segmenter 和 ANSI carry 产出 `copyValue`，内容语义不变。每次 `copyValue` 变化时调用 `source.append(copyValue)`。P1 断言旧文本是新文本的前缀，只扫描新增部分。
- 新的不变式替代 chunked-plan D9 在本路径上的字面约束：
  - 只扫描新增内容；
  - 稳定的行不重算；
  - append 只改动「最后一个未完成行所在的块」和新增的块，其余已挂载块的 props 引用不变；
  - 总高只在底部增长；
  - 选区活跃时最后一行的变化排队（§4.5）。
- 哨兵 `.preview-stream-sentinel` 放在 spacer 之后、滚动容器之内。IO 的 `root` 仍是该滚动容器，800 px 预读和 `more` / `loading` / `waiting` / `cap` / `changed` / `error` 的状态行全部保持（§6.3 回归）。
- legacy 段路径（行号关或完整视图）和 Markdown 流式视图：契约完全不变。

---

## 5. 高亮

### 5.1 P3 阶段（Worker 之前）：维持原闸门

- 虚拟模式沿用 `shouldHighlight` 的默认闸门（100 KiB / 3000 行 / 20k token）。>600 行的高亮文件可能是 601～3000 行、≤100 KiB；超过闸门的保持纯文本。
- 调度：首帧渲染纯文本 `DisplayLine`，然后 `scheduleIdle(cb, { timeout: 500 })`：有 `requestIdleCallback` 时用它，否则 `setTimeout(cb, 50)`。回调里如果手势正在进行（`body.pwh-pw-dragging`）或 150 ms 内有过 scroll，就重新排队。随后在主线程分词一次，产出 `HighlightSpans`，调用 `source.setHighlight`，只重绘可视块。
- 成本口径：桌面上约 20 ms（100 KiB），发生在空闲期，不与手势重叠，但**不保证低于 50 ms 长任务阈值**（手机和慢机），所以 PB 单独计量，不计入「交互期零长任务」（§6.2）。

### 5.2 非虚拟（≤600 行）：首帧即高亮（修 Minor 11）

- `highlight-core.ts` 增加模块级 `resolvedPrism: PrismLike | null | undefined`，在 `loadPrism()` 的 promise 落定时同步写入（undefined 表示未落定）。`useHighlightParts(source, { debounceMs })` 在 setup 中执行 `prism = ref(resolvedPrism ?? null)`；当 `debounceMs === 0` 且引擎已就绪时，**在 setup 里同步算出 parts**，第一次 render 就是高亮 VNode。冷加载（未落定）时仍先出纯文本，到达后替换一次；加载失败时永久纯文本。
- PreviewText 的一次性调用方（`NumberedCode`，以及 legacy 体里的 `HighlightedCode`）传 `debounceMs: 0`，需要新增透传 prop。transcript 的 CodeBlock 不传，维持 150 ms 不变。
- 测例分别覆盖已加载、未加载、加载失败三种情况，断言的是**首次 render 的 VNode**，不是最终 DOM。

### 5.3 P5：Worker 兑现「256 KiB / 80k token」（已拍板 ①）

- 新建 `components/shared/highlight-worker.ts`，只 import `highlight-impl.ts`（Prism 加语言包）和 `@logic/highlight.js`。在 Worker 内执行整篇 `Prism.tokenize`，跨行语法状态完整保留，不做按行独立分词。`flattenTokens(tree, { maxTokens: 80_000 })` 也在 Worker 内执行，然后直接把结果编码成 `HighlightSpans`（`Uint32Array` 三元组，通过 transfer 回传，主线程零拷贝）。
- 主线程：`new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" })`，懒创建、全局复用一个 Worker。每个请求带 id，并有 3 s 截止时间，超时就 `terminate()` 并重建，该文件保持纯文本。闸门为 `shouldHighlight(text, { maxBytes: 256 KiB, maxLines: Infinity })`，只用于虚拟模式。
- 回落：`Worker` 构造抛错、`error` / `messageerror` 事件、或者 CSP 拒绝时，进程内粘滞标记为不可用，回落到 §5.1 的原闸门主线程路径。
- 单行 part 超过 1000 个的行，在 `displayLine` 中按纯文本显示。这一条在主线程做，只影响渲染，不影响分词成本。
- 前置核对（P5 自测）：
  - CSP 为 `default-src 'self'; script-src 'self'`，没有 `worker-src`，按规范回落到 `script-src`，同源 module worker 应被允许。在 `csp-probe` 增加一个 worker 用例，Chromium 和 Firefox 都要实测通过。
  - Worker chunk 输出为 `assets/*.js`，满足 `ui-manifest.ts` 的 `ASSET_RE`；`build-info-plugin` 会自动收录。
  - 计入 lazy JS 预算（128 KiB）；Prism 约 21 KB gz 会多出一份。
  - password / LAN 模式下 Worker 脚本请求是同源请求，与懒加载 chunk 等价，在 P4 真机验证。
- 只用于预览的虚拟模式。transcript 和 ≤600 行的路径仍在主线程（tokenize ≤5 ms）。流式仍不高亮。

---

## 6. 验收：真实构建探针（PB）+ 单测 + 真机

### 6.1 PB：`npm run probe:preview-perf`

- **构建**：沿用 csp-probe 的先例。在 `src/web-hub/ui/csp-probe/` 新增入口 `preview-perf.html` + `preview-perf.ts`，加入 `vite.config.ts` 的 csp-probe 模式 `rollupOptions.input`。同一份 vite 配置和 CSS 管线，生产构建，输出到 `node_modules/.cache/pwh-csp-probe/`。
- **页面**：挂载**真实的** `PreviewHost` + `usePreviewWindows` + `PreviewWindow` / `PreviewText` / `VirtualCode`。`PREVIEW_CTX` 由页面提供：transport 是内存假实现，参照 `tests/web-hub/ui/helpers/preview-windows-fake.ts` 和 `use-preview-windows.test.ts` 的 fake，`fetch` 按 path 返回语料，支持 `chunk` / `offset` / `ident` 以驱动真实的流式状态机；hub state 带 `preview.abs.v1` / `preview.chunk.v1` caps。页面还要渲染一段含 PathText 的假 transcript，让「点击路径 → 开窗」走真实链路。全局样式按 `main.ts` 的顺序 import。
- **服务**：沿用 `csp-probe.ts` 的静态服务器和真实 `CSP` 头（从 `hub/http.ts` import）。runner 为 `scripts/web-hub/preview-perf-probe.ts`，用 `lib/playwright.ts` 驱动 Chromium（必测）、Firefox 和 WebKit（功能与帧隙）。退出码规则与 csp-probe 相同：0 通过、1 门槛失败、2 浏览器不可用。
- **固定环境**：
  - viewport 1440×900，DPR 1；
  - 字号 `pwh_fontscale` 为 1 和 3 两档（页面加载前写 localStorage）；
  - headless 参数写入报告；
  - 报告里记录 `getComputedStyle(pre).fontFamily` 实际解析出的字体，以及 `document.fonts.status`；
  - 每项 7 次，报 median / p95；打开分 cold（新 context，Prism 未加载）和 warm 两种。
- **语料**：`tests/fixtures/preview-perf/`，`manifest.json` 记录每个文件的 sha256，内容不匹配时 runner 拒跑。
  - `stack-3609.ts`：当前 `src/stack.ts` 的定版拷贝；
  - `hl-600.ts`：截取 uploads.ts 的前 600 行，恰好在阈值上；
  - `hl-601.ts`；
  - `uploads-2292.ts`；
  - `longline.js`：合成，含一行 200 KB 和 700 行常规代码；
  - `wide-1200.md`：合成，含 CJK、emoji、tab、组合字符、`İ`、`Σ`、surrogate 截断点；
  - `log-8mib`：运行时用固定种子生成，用于流式。
- **计时起止**（注入的测量脚本属于测试代码，可以用 rAF，不受产品 source-scan 约束）：
  - **打开**：t0 为 PathText 按钮 `click` 的 `ev.timeStamp`（capture 监听器）；t1 为滚动容器出现首个 `.pv-line` 之后的第 2 个 rAF（近似已 present）。指标名为 **open-to-frame**。
  - **拖动 / 缩放**：`page.mouse.down` 后做 60 步 `page.mouse.move`（标题栏，以及 `.pw-rz[data-dir=e|s|se]`）。计时从第一次写入之前开始，同时采帧隙 p95 / max 和 longtask。
    - Chromium 取 CDP `Performance.getMetrics` 的前后差值（`RecalcStyleDuration + LayoutDuration + ScriptDuration`）除以步数，得到 **「每轮平均每步成本」**（r3 正名，§R2 #3）。跨 7 轮报 median / p95。它是**轮内平均**，不代表单步的 p95。
    - **单步峰值**另外约束：同一轮用 CDP `Tracing`（categories `devtools.timeline`）录制，取每个 `pointermove` 对应的 `EventDispatch` 加随后的 `UpdateLayoutTree` / `Layout` 段之和作为单步成本，报 max / p95。同时以帧隙 max 和 longtask 计数作为独立证据。
  - **激活**：6 个窗口轮流点击 20 次，取每次点击的 style + layout + script。
  - **滚动**：`mouse.wheel` 40 步，每步 400 px，再加 5 次滚动条远跳（在页面内设置 `scrollTop`），同样取「每轮平均每步成本」、trace 单步峰值和帧隙。
  - **高亮**：从打开到 `setHighlight` 完成之间的 longtask 列表，以及到达后那次补丁的 script + layout。
  - **选区与查找（功能断言，三引擎）**：
    - 拖选 500 行（带边缘自动滚动），复制结果与 `slice` 一致；
    - 选区期间追加和高亮到达，选区保持；
    - Ctrl+A，然后滚动、追加，再复制，等于全文；
    - 查找 `İ` / `Σ` / 跨 token、跨块命中，当前项可见；
    - 两个窗口同时查找后关闭其中一个；
    - 字号 1→3→1，`topLine` 不变；
    - 300% 字号下滚到底能看到最后一行，或看到上限提示；
    - **截断行布局与复制**：§4.2 的 (a)–(e)，三引擎，fs-scale 1 和 3 各跑一次，语料 `longline.js` 与 `wide-1200.md`；
    - **查找增量与全量一致**：流式 `log-8mib` 一边加载一边查找，每个 chunk 到达后与对已加载全文做的全量搜索比对命中数组；语料中预置 `aaaa`、`a` 连续段，以及恰好跨 chunk 边界的代理对（fixture 生成器保证 chunk 切点落在代理对中间至少一次）。
- **门槛**（Chromium，fs-scale 1，warm）。「每轮平均每步」类指标：跨轮 median ≤ 门槛，跨轮 p95 ≤ 1.5× 门槛；**单步峰值**（trace）≤ 4× 门槛，且不超过 16 ms；帧隙 max ≤ 33 ms：

| 指标                                      | 语料                           | 门槛                              |
| ----------------------------------------- | ------------------------------ | --------------------------------- |
| 拖动·每轮平均每步 style+layout+script     | stack-3609（虚拟）             | ≤1 ms                             |
| 激活每次点击                              | 6 窗口 × stack-3609            | ≤2 ms                             |
| 横 / 竖缩·每轮平均每步                    | stack-3609（虚拟）             | ≤2 ms                             |
| 横缩·每轮平均每步                         | hl-600（非虚拟、高亮、软换行） | ≤8 ms（不达标时调阈值，回报用户） |
| open-to-frame                             | stack-3609 warm / cold         | ≤50 ms / ≤80 ms                   |
| open-to-frame                             | hl-600 warm                    | ≤50 ms                            |
| 滚动·每轮平均每步 / 远跳（单次）          | stack-3609                     | ≤4 ms / ≤10 ms                    |
| 交互期 longtask（拖、缩、滚、激活窗口内） | 全部                           | **0**                             |
| 打开后分词任务                            | uploads-2292（P3：主线程）     | 报告值；桌面 ≤30 ms               |
| 打开后分词任务                            | stack-3609（P5：Worker）       | 主线程 0 个 >50 ms 的长任务       |
| 窄屏 390×844（手机带）open-to-frame       | stack-3609                     | ≤80 ms                            |

- Firefox / WebKit：没有 Long Tasks API 和 CDP，只报帧隙 p95 / max 和功能断言。门槛改用「帧隙 p95 ≤ 33 ms」；**观察不到不等于 0**，报告里如实写明。
- **基线**：PB 先在改动前的 dev HEAD（只含 P0）上跑一次，把基线写进 `docs/dev/preview-perf/PB-report.md`。此后每个包都附 before/after 对比。

### 6.2 r1 微基准的去向

`/tmp/preview-perf/` 下的脚本不提交，也不作为验收依据。PB 可以复用其中注入式帧隙和 longtask 的采集代码片段。

### 6.3 单测（vitest；happy-dom 下测量值一律注入）

| 文件                                            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logic-preview-line-index.test.ts`（P1）        | 任意切点追加与一次建成等价（属性测试）；前缀断言；`lineStart` / `lineOf` 互逆；末尾 `"\n"` 不产生幻影行；`displayLine` 截断的 surrogate 安全、**`eol` 独立且 `parts` 不含 `"\n"`（含跨行 token 被切开的情况）**、`clipped` 计数正确；`maxDisplayCols` 为上界（随机串对比逐码点上界）且单调                                                                                                                                                                                                                                                                                                                                      |
| `logic-preview-virtual.test.ts`（P1）           | `computeWindow`：顶、底、中段、视口大于全文、滞回、`retain` 只增不减且连续、2048 上限；`chooseSourceRenderer` 全表（**含 `virtualEnabled=false` 下委托 r0 的三条分支：非流式 ≤8000 / >8000 / 流式**）；`maxLines(rowH)` 在 19.5 / 58.5 px 下的取值；锚点重定位 `reanchor(scrollTop, oldH, newH)`                                                                                                                                                                                                                                                                                                                                |
| `logic-preview-find.test.ts`（P1）              | `foldSameLength` 等长性（属性测试，含 `İ`、`ẞ`、`Σ`、surrogate）；**增量与全量的差分属性测试**（r3）：字母表 `{a, b, Σ, İ, 𐐀(D801 DC00), 𐐨, 孤立 D801, 孤立 DC00}`，随机文本，随机切成 1～8 次 append（切点允许落在代理对中间），查询从同一字母表随机取 1～3 个码元，两种大小写模式下，每次 append 后都断言增量命中等于对 `text[0, stableLen)` 做的全量贪心搜索，flush 后等于对全文的全量搜索；固定反例 `aaaa + a / q=aa ⇒ [0,2]`、`aaa + a / q=aa ⇒ [0,2]`、`x\uD801 + \uDC00y / q=𐐨（不敏感）⇒ [1]`；上限：构造超过 10 000 个命中的文本并增量追加，命中数组保持前 10 000 个，`more` 正确；当前项保持（含因 carry 丢弃的情况） |
| `logic-highlight.test.ts`（P1 扩展）            | limits 参数缺省时与常量逐值一致；`HighlightSpans` 编解码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `virtual-code.test.ts`（P2）                    | 初始只挂窗口内的块；**每个可见 `.pv-line` 的 textContent 与 counter 起点都等于 `source.displayLine(i)` / `i+1`**；scroll 后块集合变化，旧块节点身份保持；append 只重绘最后一块和新块，其余块节点 identity 和文本节点不变；高亮到达只重绘可视块；选区活跃（注入的判定）时块只增不减、props 引用冻结、队列在折叠后 flush；Ctrl+A 逻辑全选的取消矩阵；copy 事件在全选时写入全文；**截断行 DOM 结构**：`.pv-vclip` 为空 span，位于 parts 之后、`eol` 文本节点之前，`eol` 是行元素的最后一个子节点，标记不在 textContent 中；`data-clip` 和 alt label；`scrollToLine`；行数上限提示；gutter 位数跨边界                               |
| `use-find-highlights.test.ts`（P3）             | 两个 owner 取并集；release 只移除自己；`CSS.highlights` 缺失时 no-op                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `preview-find.test.ts`（P3）                    | 拦截矩阵（窗口内 / 外、查找框内、组合输入中、已 defaultPrevented、完整视图开着）；F3 / Ctrl+G / Mac 键位；Esc 只关查找框、不关窗（与 PreviewHost 联测）；计数 live region；说明文案                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `preview-full-view.test.ts`（P3）               | 窗口级开关：只影响本窗口；DOM 与行号关时逐字节相同；导航后保持；findable 置为 false                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `preview-line-numbers.test.ts`（P3 改）         | **legacy（行号关）与渲染 Markdown 的断言原样保留**；「>8000 行降级」**原样保留**并改在 `virtualEnabled=false` 下运行，同时新增「开关为 true 时 >600 行 ⇒ `.pv-virtual`，并且可见块内容和编号等于全文对应切片」；流式「段连续编号 / 续行头 / 超过 cap 降级」三条**原样保留**并改在 `virtualEnabled=false` 下运行（r3：不再迁到 `code-lines.test.ts`；`virtualEnabled` 以 PreviewText 的测试专用 provide/prop 注入，生产代码读常量）；流式虚拟路径新增：编号跨 chunk 连续、强切行合并为一行、IO 的 root 和哨兵位置、`cap` / `changed` / `error` 状态行回归                                                                        |
| `highlight-core` 首帧测（P3）                   | §5.2 的三种情况                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `preview-text.test.ts` / `preview-host.test.ts` | 读大文本 `textContent` 的用例改为「可见块内容等于切片」再加「copyValue 等于全文」两条断言，不用后者替代前者                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `source-scan.test.ts`                           | 不改；新代码不得出现 rAF、`<Transition>`、`content-visibility`、`v-html`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 6.4 真机与读屏（P4，`docs/dev/preview-perf/acceptance.md`）

- 用户常用浏览器配合真实 hub：打开 stack.ts，DevTools Performance 录制拖动、8 向缩放、甩动滚动、6 窗口激活；拖选 1000 行后复制比对；Ctrl+A 复制；查找；完整视图；行号关；字号 300%。
- iOS Safari（有设备时）：触屏手柄选择、惯性滚动露底观察。
- **读屏**：Orca + Firefox（必做）。
  - 虚拟体：能听到 sr-only 说明，能找到「完整视图」按钮。
  - 完整视图：连续朗读整份已加载内容。
  - 记录行号 `::before` 和截断标记的实际朗读表现，用来判断 alt text 是否生效。
  - NVDA / Chromium、VoiceOver / Safari 有条件时再做（已拍板 ⑤）。

### 6.5 CI 门

`format:check → typecheck → test → build → build:web + check:web`。PB 和 P4 不进 CI，与 `probe:mermaid` 同类，是合入前的人工门。check:web 只记录实测值和通过与否：

- 首屏 JS（512 KiB 告警线）预计 +8～10 KiB gz；
- P5 的 Worker chunk 计入 lazy（128 KiB）；
- CSS（64 KiB）+≈1.5 KiB。

不拆懒块，不调预算。

---

## 7. 契约变化与残留风险

**契约变化**（在各自 plan 的修订记录里登记，由 P4 执行）

1. preview-windows §7.1：几何变量注册为非继承（P0，在途）。R2 不变。
2. chunked-plan D9 / P2b「旧段从不重打补丁」：在行号开的流式源码视图上，替换为 §4.8 的新不变式。legacy 段和 Markdown 流式视图不变。`content-visibility` 禁令不变。`seg-parity-snippet.js` 继续覆盖 legacy 段。
3. line-numbers（72fa2abe）：
   - 行号开的路径不再到达 8000 行降级；
   - 虚拟模式下 `pre.textContent` 只包含已挂载块；
   - 「已加载全文」只来自 copyValue 和逻辑全选；
   - CodeLines 零改动；其 `continuation` 能力只在 `PREVIEW_VIRTUAL_ENABLED=false` 的 r0 流式分支中使用。
4. highlight：preview 的一次性调用方首帧即高亮；虚拟模式的放宽只在 P5 Worker 可用时生效；transcript 不变；`shouldHighlight` / `flattenTokens` 的默认值不变。

**残留风险**

| #   | 风险                                                      | 处置                                                  |
| --- | --------------------------------------------------------- | ----------------------------------------------------- |
| K1  | 页面查找（原生）找不到未挂载的行                          | 窗内查找、常驻说明、完整视图                          |
| K2  | 读屏在虚拟体内只能读到可见部分                            | sr-only 说明，加窗口级完整视图（P4 实测）             |
| K3  | 合成器快速甩动时露出一帧底色                              | overscan 1～1.5 屏；PB 记录帧隙；真机观察             |
| K4  | 不换行后长行需要横向滚动                                  | 已拍板接受；完整视图可以软换行阅读                    |
| K5  | P3 阶段主线程分词在慢机上可能超过 50 ms                   | 空闲调度加手势回避；PB 计量；P5 消除                  |
| K6  | 选区跨度超过 2048 行、Shift+点击已卸载位置时不保证        | 状态提示；Ctrl+A 和完整视图                           |
| K7  | 截断行的原生复制只得到前缀                                | 复制全部、完整视图、下载（已拍板 ②）                  |
| K8  | 非 ASCII 较多的文件右侧有多余空白                         | 上界估计的代价，接受                                  |
| K9  | 不支持 `@property`、alt text 或 Custom Highlight 的旧引擎 | 各自回落：变慢、读出标记、只用原生 selection 标当前项 |
| K10 | Worker 被企业策略或扩展拦截                               | 粘滞回落到原闸门主线程路径                            |
| K11 | 非虚拟路径的行号 `::before` 可能被读屏读出（现状即如此）  | P4 实测后另立小包，本期不动 `preview.css`             |

---

## 8. 分包、估时与回滚

### 8.1 包与文件域（独占）

| 包                     | 文件域                                                                                                                                                                                                                                                                                                                                                                      | 依赖                                                     | 估时               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| **P0**（在途）         | `styles/preview.css` 的 @property 段等（§3）                                                                                                                                                                                                                                                                                                                                | —                                                        | —（已另派）        |
| **PB** 性能探针 + 基线 | `src/web-hub/ui/csp-probe/preview-perf.{html,ts}`、`vite.config.ts`（只在 csp-probe input 里加一项）、`scripts/web-hub/preview-perf-probe.ts`、`package.json`（一条 script）、`tests/fixtures/preview-perf/**`、`docs/dev/preview-perf/PB-report.md`                                                                                                                        | 只依赖现有组件；VirtualCode 落地后由 P3 补开相应用例开关 | 1.5 天             |
| **P1a** 冻结接口       | `logic/previewVirtualTypes.ts`（§4.2 全部类型和常量：`PREVIEW_VIRTUAL_ENABLED` / 600 / 32 / 2048 / 4096 / 15e6 / 50 万 / 80k / 1000 / `FIND_MAX`）                                                                                                                                                                                                                          | —                                                        | 0.5 天，**先提交** |
| **P1** 纯逻辑          | `logic/previewLineIndex.ts`（`VirtualSourceFactory` 实现）、`logic/previewVirtual.ts`（`computeWindow` / `chooseSourceRenderer` / `maxLines` / `reanchor`）、`logic/previewFind.ts`、`logic/highlight.js`（可选 limits，`HighlightSpans` 编解码）、上述 4 个 logic 测试                                                                                                     | P1a                                                      | 2.25 天            |
| **P2** 虚拟渲染        | `components/shared/VirtualCode.vue`、`components/shared/VirtualBlock.vue`、`styles/preview-virtual.css`（组件内 import）、`tests/web-hub/ui/virtual-code.test.ts` 及**仅限该测试目录内的** source 桩 `tests/web-hub/ui/helpers/virtual-source-stub.ts`                                                                                                                      | P1a（P1 合入后去掉桩，改用真实现）                       | 3.25 天            |
| **P3** 接线            | `components/preview/PreviewText.vue`、`PreviewWindow.vue`（Ctrl+F、查找和完整视图按钮、findable 通道、fullView 状态）、新建 `components/preview/PreviewFind.vue`、`composables/useFindHighlights.ts`、`components/shared/{NumberedCode,HighlightedCode}.vue` + `highlight-core.ts`（§5.1 / §5.2）、`i18n/{zh,en}/preview.ts`、§6.3 中 P3 名下的测试，以及 PB 的虚拟用例开关 | P1 + P2                                                  | 3 天               |
| **P5** Worker 高亮     | 新建 `components/shared/highlight-worker.ts`、`components/shared/highlight-worker-client.ts`（懒创建、超时、回落）、`highlight-core.ts` 的虚拟入口（与 P3 串行，不并行）、`csp-probe` 的 worker 用例、测试                                                                                                                                                                  | P3                                                       | 2 天               |
| **P4** 验收与登记      | `docs/dev/preview-perf/{acceptance,P*-report}.md`，以及 chunked-plan、line-numbers、preview-windows 的修订行                                                                                                                                                                                                                                                                | P3（P5 部分在 P5 之后）                                  | 1.5 天             |

- 唯一 owner：共享类型归 P1a；`highlight-core.ts` 先由 P3 改，再由 P5 改，串行；`CodeLines.vue` 不归任何包，零改动。
- 并行：PB ∥ P1a → P1 ∥ P2 → P3 → P5 ∥ P4（真机部分在 P5 之后补测）。每包返回后立即派 verifier，验收模型与开发模型不同。

### 8.2 估时汇总

合计 14 人日（不含 P0；r3 +0.5，见 §0），墙钟约 8～9 天。r1 的 7.5 人日漏算了以下几项，r2 已计入：

- 真实构建探针（PB）；
- 选区冻结与全选状态机（P2 +0.5 天）；
- 完整视图和查找细节（P3 +1 天）；
- Worker（P5）；
- 三引擎、读屏验收（P4 +0.5 天）。

### 8.3 回滚与降级

- 没有持久数据迁移，每个包一个或多个独立 commit。
- **运行时逃生**：窗口级完整视图、全局行号关。
- **构建期关停开关**（r3 修正）：`PREVIEW_VIRTUAL_ENABLED = false` 后重新构建，`chooseSourceRenderer` 首先判断它，整体委托 r0 选择（§4.1 第一行）。非流式的 8000 行降级、流式的逐段 `CodeLines` 都由保留的 r0 分支提供，原有用例在 `virtualEnabled=false` 下持续回归。`PREVIEW_VIRTUAL_MIN_LINES` 只是阈值，**不再**宣称 `Infinity` 等于关停。
- **精确回滚**：
  - 只回滚 P3，接线撤回，新组件不再可达，行为回到 P0 之后；
  - 只回滚 P5，回到原闸门主线程高亮；
  - 只回滚 P0，几何变量恢复为继承型。
- 故障降级：Worker 不可用时回落主线程原闸门；Custom Highlight 不可用时只用原生 selection 标当前项；ResizeObserver 不可用时按 mount 时测得的行高固定，不再跟随变化。

---

## 9. 拍板汇总

- 已拍板项见 §0。
- 2026-10-23 用户接受 r2 的五项收窄与工期。r3 只修正确性，其中 §R2 #1 / #2 / #4 是对已拍板方案的实现层纠错，不改变任何产品承诺；工期因此 +0.5 人日（§0）。
- **r3 无新增待拍板项。**

---

## §R1 评审处置表（r1 → r2，评审：gpt-6.1-sol，`/tmp/preview-perf-review-r1.json`）

| #   | 严重度  | 问题                                                                                                                                           | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 只钉住 anchor/focus 所在块不能保证原生选区存活：高亮、追加会替换文本节点；`selectionchange` 是异步的；Shift+点击、自动滚动、反向、触屏都未定义 | **已改 §4.5（缩小承诺）**：选区活跃改为**同步**判定（pointerdown 期间，或 `getSelection()` 非折叠且与虚拟体相交），在算窗口、打补丁前调用；活跃期间窗口只增不减、保持连续、上限 2048 行；已挂载块 props 引用冻结，高亮和最后一行增长排队，到折叠后再 flush。这样文本节点不被替换，原生复制成立。Shift+点击已卸载位置和超过 2048 行的情况明确不保证，提示走 Ctrl+A / 完整视图（§4.7）。三引擎 + iOS 真机验证列入 §6.1、§6.4（已拍板 ④）                                                                                      |
| 2   | Major   | Ctrl+A 用 live Range 充当 token 不稳定；端点换算没有覆盖元素边界、反向选区和截断映射                                                           | **已改 §4.5**：Ctrl+A 改为与 DOM 无关的逻辑状态 `allSelected`，只在明确的新选择动作时取消；复制取复制当下的 `source.text()`。原生选区复制交给浏览器（区间连续、文本节点不变），**删除** DOM→模型端点换算；截断标记改为 CSS 生成内容，不进入复制（§4.2）。复制语义分三档写明。测例见 §6.1、§6.3                                                                                                                                                                                                                              |
| 3   | Blocker | 冻结接口不足：`VirtualLineSource` 没有全文 slice；CodeLine 无法表达截断标记和 aria；「CodeLines 零改动」与需求冲突                             | **已改 §4.2**：冻结 `VirtualTextSource`（含 `text` / `slice` / `revision` / `lastChange` / `lineStart` / `lineOf` / `displayLine` / `maxDisplayCols`）、`MutableVirtualSource`（`append` / `setHighlight`）、`VirtualSourceFactory`、`DisplayLine`（`clipped`）、`HighlightSpans`；由 P1a 单一 owner 先提交。虚拟模式改用新渲染器 `VirtualBlock.vue`，与 CodeLines 同一套 DOM 语法，加 `data-clip`、`data-clip-label`、块根 `data-start`；**CodeLines 确实零改动，因为虚拟模式不用它**，这一点写明；禁止绕过 Vue 改 DOM     |
| 4   | Major   | 主动引入约 60 ms 主线程分词，与零长任务矛盾；延后 30 ms 不能隔离手势；80k / 1000 两道闸门都在分词之后，限制不了分词成本                        | **已改 §5**：P3 阶段维持原闸门（100 KiB / 3000 / 20k），分词走 `requestIdleCallback`，回落为 `setTimeout` 50 ms，并回避手势和滚动；该任务单独计量，不计入交互零长任务（§6.1）。放宽到 256 KiB / 80k 改由 **P5 Worker** 兑现（整篇分词、Worker 内执行预算、transferable 结果、3 s 截止、粘滞回落）；更正 r1「CSP 不允许 Worker」的说法（同源 module worker 由 `script-src 'self'` 覆盖，P5 用 csp-probe 实测）（已拍板 ①）                                                                                                   |
| 5   | Major   | harness 不代表真实产品：计时口径错误，600 行是插值，没有 Vue、事件、测量、高亮、选区                                                           | **已改 §2 / §6**：r1 数据降级为「同步 flush 微基准，只看方向」，口径缺陷逐条登记。新增 **PB 包**：csp-probe 模式下生产构建真实的 PreviewHost / usePreviewWindows / PreviewText / VirtualCode，在真实 CSP 下由 Playwright 驱动 Chromium、Firefox、WebKit，输入是真实鼠标和键盘事件；CDP `Performance.getMetrics` 从写入前开始计时；open-to-frame 的起止点有明确定义；冷 / 热、median / p95；字体、DPR、视口、字号固定；语料用 sha256 定版，真实覆盖 600 / 601 行高亮、长行、宽字符、窄屏、6 窗口、8 MiB 流；先在改动前跑基线 |
| 6   | Major   | spacer 的 `min-width` 引用后代上的 `--pvline-w`（变量不会向上传播）；`maxCols` 按未截断全文计算；各块 gutter 位数不一致                        | **已改 §4.4**：spacer 自己设置全文件统一的 `--pvline-w`，块根不设；`min-width` 由 JS 写成纯 `ch` 字面量，不引用后代变量；`maxDisplayCols` 只算屏显前缀加标记，并取上界（非 ASCII 记 2，tab 按制表位展开，有封顶），保证 `scrollWidth` 稳定；位数跨边界只重设一次。测例见 §6.3                                                                                                                                                                                                                                               |
| 7   | Major   | 50 万行安全高度没考虑 300% 字号；rowH 重测后没有滚动锚点                                                                                       | **已改 §4.3**：上限改为 `min(500k, floor(15e6 / rowH))`，58.5 px 时约 25.6 万行，超出部分给出提示；rowH 变化时在同一个 RO 回调里按旧 rowH 求逻辑行和行内比例，再按新 rowH 重新定位；字号 80% / 100% / 300%、浏览器缩放、字体加载都有测例（§6.1、§6.3）                                                                                                                                                                                                                                                                      |
| 8   | Major   | 默认虚拟化让读屏丢失内容；复制、下载不是等价路径；行号关是全局开关；没有读屏验收                                                               | **已改 §4.7 / §6.4**：新增**窗口级完整视图**（只影响本窗口，DOM 与行号关相同），并在 sr-only 说明和可见 tooltip 里写明入口；纠正「`::before` 不进入可访问树」的错误推论（§4.2：虚拟模式用 alt text 隐藏行号，非虚拟路径实测后另议）；读屏验收最低 Orca + Firefox（已拍板 ③⑤）                                                                                                                                                                                                                                               |
| 9   | Major   | 对小写副本搜索后直接用偏移不可靠（`İ` 会变长）；流式缓存失效规则未定义                                                                         | **已改 §4.6**：大小写不敏感改为**保持长度的逐码点折叠**，偏移与原文 1:1，语义登记在 UI 中；冻结 revision 驱动的增量折叠和补搜协议，以及当前项保持规则；Unicode、跨行、跨 token、跨块、追加、截断区都有测例                                                                                                                                                                                                                                                                                                                  |
| 10  | Minor   | `CSS.highlights` 是文档级的，多个窗口会互相覆盖                                                                                                | **已改 §4.6**：单例 `useFindHighlights` 管理器，按 owner 取并集；测例「两个窗口同时查找、关闭其一」                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | Minor   | `debounceMs = 0` 不等于 setup 同步高亮                                                                                                         | **已改 §5.2**：模块级 `resolvedPrism` 同步缓存，setup 内初始化并同步计算；已加载、未加载、失败三种情况断言首次 render                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12  | Minor   | 「第二次 Ctrl+F」实际是焦点规则；原生查找不是文件查找的逃生口；缺 IME、F3、Mac、工具栏焦点                                                     | **已改 §4.6**：规则写实为焦点规则；原生查找改称「页面查找（只含可见部分）」，真正的逃生口是完整视图；常驻范围和快捷键说明；补上 IME 组合、F3 / Ctrl+G / ⌘G、工具栏焦点、Esc 回归                                                                                                                                                                                                                                                                                                                                            |
| 13  | Minor   | `textContent` 断言换成 copyValue 削弱了覆盖；行号关路径承接不了编号测试；分包缺接口 owner、桩归属、回滚和真实选区工期                          | **已改 §6.3 / §8**：legacy 和渲染 Markdown 的断言原样保留；虚拟路径新增「可见块内容和编号等于切片」「append 不改无关块」、IO 哨兵和状态回归；编号与续行头测试迁到直接挂 CodeLines 的单元测；P1a 单一 owner；桩只放在 P2 测试目录；§8.3 回滚和降级；工期重估为 13.5 人日                                                                                                                                                                                                                                                     |

---

## §R2 第三轮裁定处置（r2 复审 → r3，`/tmp/preview-perf-review-r2.md`；按 dev-flow 收敛规则由主会话裁定、主会话核对闭合）

| #                  | 严重度                     | 问题                                                                                                            | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                  | 严重（主会话裁定：必须修） | 截断标记 `::after` 生成在保留的 `"\n"` 之后，在 `white-space: pre` 下掉到第二个视觉行，破坏固定行高、盖住下一行 | **已改 §4.2**：<br>• `DisplayLine` 改为 `parts`（不含终止符）+ `eol` + `clipped`，跨行 token 携带的 `"\n"` 切到 `eol`；<br>• 行结构固定为「parts → 空 `span.pv-vclip` → `eol` 文本节点（块末，被浏览器吞掉）」，标记由 `.pv-vclip::before` 生成，不是 DOM 文本，不进入选区和复制，与行同字体、继承行高、基线对齐，固定行高由构造保证；<br>• 定位式伪元素方案因依赖宽度估算而不采用，理由已写明；<br>• 补真实浏览器断言 (a)–(e)：单行盒、行盒高 = rowH、标记在该行文本之后、下一行 top = 本行 top + rowH 且不相交、复制不含标记、普通行同样只有一个行盒。三引擎 × fs-scale 1/3 都跑（§6.1），happy-dom 结构断言见 §6.3                                                                                                                                                         |
| 2                  | 严重（主会话裁定：必须修） | 增量补搜起点没有考虑最后一个命中的 end（反例 `aaaa+a / q=aa`）；代理对跨追加边界时分段折叠不等价                | **已改 §4.6**：<br>• 冻结贪心不重叠的规范定义；<br>• 补搜起点 = `max(stableLen_old − \|q\| + 1, lastKept.end)`，附前缀性质论证和反例推演；<br>• 去重靠构造加断言 `hᵢ ≥ hᵢ₋₁ + \|q\|`；<br>• 10 000 上限：截取前 10k 个贪心命中满足前缀性质，满额后不再补搜，只重做 `more` 探测；<br>• 当前项按起点偏移保持，因 carry 丢弃时有回落规则；<br>• 折叠的码点 carry：末尾孤立高代理项暂不折叠（`stableLen`），下次 append 从 `stableLen` 重新折叠，终态 flush；命中只在稳定前缀上，`end > stableLen_new` 的旧命中丢弃后重搜。不要求调用方保证码点完整，由 P1 自己负责；<br>• §6.3 新增增量与全量的差分属性测试（字母表含代理对、孤立代理项、`İ`、`Σ`，切点可以落在代理对中间，两种大小写模式）和固定反例 `aaaa+a`、`aaa+a`、跨边界 `𐐀`；§6.1 新增流式边加载边查找的真实浏览器差分项 |
| 3                  | 一般                       | CDP 总量差值除以步数得到的是轮内平均，跨轮 p95 不代表单步 p95                                                   | **已改 §6.1**：指标正名为「每轮平均每步成本（跨 7 轮 median / p95）」；单步峰值另用 CDP `Tracing` 的事件分段（`EventDispatch` + `UpdateLayoutTree` / `Layout`）取 max / p95，门槛为不超过 4× 门槛且不超过 16 ms，另以帧隙 max ≤ 33 ms 和 longtask 计数作为独立证据。harness 结构不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4                  | 一般                       | 把 `Infinity` 当作关停开关与渲染选择表不一致：流式路径一律虚拟，8000 行降级也不会自动恢复                       | **已改 §4.1 / §8.3 / §6.3**：<br>• 作废「`PREVIEW_VIRTUAL_MIN_LINES = Infinity` 回到 r0」的承诺；<br>• 新增独立构建期常量 `PREVIEW_VIRTUAL_ENABLED`，`chooseSourceRenderer` 首先判断它，为 false 时整体委托 r0 选择（非流式 ≤8000 / >8000 降级加提示 / 流式逐段 CodeLines 加累计 8000 降级）；<br>• P3 必须保留这三条 r0 分支，不得删除；<br>• 原有的 8000 降级和流式编号、续行头、cap 降级用例**原样保留**，改在 `virtualEnabled=false` 下运行。这也收回了 r2 「迁到 `code-lines.test.ts`」的安排，§R1 #13 的这一句以本条为准；<br>• 说明开关是构建期常量，需要重新构建，运行时出口仍是完整视图和行号关                                                                                                                                                                      |
| r2-#6（部分闭合）  | Major                      | 宽度和截断的组合问题                                                                                            | 随 #1 闭合：`maxDisplayCols` 仍只按屏显前缀加 12 列标记上界计算（§4.4），标记位于行内、不另占行，与宽度模型一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| r2-#9（部分闭合）  | Major                      | 查找增量协议                                                                                                    | 随 #2 闭合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| r2-#13（部分闭合） | Minor                      | 回滚开关与选择表不一致                                                                                          | 随 #4 闭合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 其余               | —                          | r2 复审判为已闭合的各项（#1–5、#7、#8、#10–12）                                                                 | 不改。§0「需用户复核」五项按用户 2026-10-23 的决定改为「已拍板」；P0 章节未动；工期 13.5 → 14 人日（+0.5，§0 已说明来源）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
