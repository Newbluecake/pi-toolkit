# preview-perf P1（纯逻辑）报告

- 日期：2026-10-23 · 分支 dev · 方案 `plan.md` r3（§4.1/§4.2/§4.3/§4.4/§4.5/§4.6、§5、§6.3 P1 行、§8.1 P1 行）
- 状态：**完成**。冻结接口 `logic/previewVirtualTypes.ts`（3c0deb88）零改动，仅消费。

## 交付物

| 文件                                                | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/previewLineIndex.ts`      | `createVirtualSourceFactory()`：`VirtualSourceFactory`/`MutableVirtualSource` 实现。行索引用 `starts[]`（文本尾 `"\n"` 时带一条 pending 起点 entry，`lineStart(lineCount) === length` 由它成立，下次 append 自动晋升为真实行）；append 只扫 `[oldLen, newLen)`；`displayLine` 截断（surrogate 安全）+ 高亮 + `eol` 独立 + `clipped` 计数，缓存按行 FIFO 封顶 8192、append 只失效 `≥ fromLine` 的行、高亮清空；`maxDisplayCols` 为 §4.4 上界（ASCII 1、tab 到下一 8 列制表位、非 ASCII 码点 2、截断标记 +12、封顶 4096×8+12），append 增量维护、单调 |
| `src/web-hub/ui/src/logic/previewVirtual.ts`        | `chooseSourceRenderer`（§4.1 全表，kill switch 首判，false ⇒ r0 三分支原样委托）、`computeWindow`（连续块区间、overscan 以屏计、半块滞回、选区只增不减 + 2048 行/64 块上限、`capped` 标记）、`maxLines`（§4.3）、`reanchor`（§4.3 锚点重定位）                                                                                                                                                                                                                                                                                                      |
| `src/web-hub/ui/src/logic/previewFind.ts`           | `foldSameLength`（等长逐码点折叠）、`findAll`（贪心不重叠全量参考实现 + FIND_MAX + 一次 more 探测）、`createPreviewFinder()`（增量引擎：码点 carry 的 stableLen 协议、`resume = max(stableLen_old − \|q\| + 1, lastKept.end)` 补搜、满额只重探测、flush、当前项按起点偏移保持与回落）                                                                                                                                                                                                                                                               |
| `src/web-hub/ui/src/logic/highlight.js`（改）       | `shouldHighlight(text, limits?)` / `flattenTokens(tree, limits?)` 可选闸门（`Infinity` 合法=不封顶；缺省与常量逐值一致，行为不变）；新增 `encodeHighlightSpans` / `decodeHighlightSpans`（HighlightSpans 编解码，decode 二分起点、子窗口切片、classIdx 越界降纯文本、坏输入返 null 不抛）                                                                                                                                                                                                                                                           |
| `tests/web-hub/ui/logic-preview-line-index.test.ts` | 任意切点追加 ≡ 一次建成（属性，切点可落在代理对中间）；前缀断言；`lineStart`/`lineOf` 互逆；尾 `"\n"` 无幻影行；displayLine 截断/eol/parts 无 `"\n"`（含跨行 span 切开）/clipped/超 1000 parts 塌纯文本/坏 spans 降级；maxDisplayCols 与逐码点 naive oracle 差分 + 单调                                                                                                                                                                                                                                                                             |
| `tests/web-hub/ui/logic-preview-virtual.test.ts`    | computeWindow 顶/中/底/视口大于全文/空态；半块滞回（下滚迟挂、上滚立即）；「窗口 ⊇ target 且每边至多多 1 块」属性；选区只增不减/恰好 64 块不封/越界 capped 回正常窗/并集性质属性；chooseSourceRenderer 全表（含 `virtualEnabled=false` 三条 r0 分支）；maxLines 19.5/58.5/边界/非法；reanchor                                                                                                                                                                                                                                                       |
| `tests/web-hub/ui/logic-preview-find.test.ts`       | fold 等长性属性（İ/ẞ/Σ/代理）；纯 ASCII ≡ toLowerCase；固定反例 `aaaa+a / q=aa ⇒ [0,2]`、`aaa+a ⇒ [0,2]`、跨边界代理对 `x\uD801+\uDC00y / q=𐐨 ⇒ [1]`、carry 单独覆盖；**增量 ≡ 全量差分属性**（字母表 {a,b,A,Σ,İ,𐐀,𐐨,孤立 D801,孤立 DC00}，1–8 次任意切点 append，每次 append 断言 ≡ 稳定前缀全量贪心、flush 后 ≡ 全文全量；大小写中途切换 ≡ 新引擎）；FIND_MAX 增量路径；当前项保持；契约守卫                                                                                                                                                      |
| `tests/web-hub/ui/logic-highlight.test.ts`（改）    | limits 缺省/空对象与常量逐值一致（逐字节不变）；worker 闸门形状 `{maxBytes: 256KiB, maxLines: Infinity}`（字节上限按含边界值语义）；flattenTokens 预算覆盖；编解码 round-trip、子窗口、二分长表、越界 classIdx、坏输入                                                                                                                                                                                                                                                                                                                              |

## 自验（全部通过）

```text
npx vitest run tests/web-hub/ui/logic-preview-*.test.ts "tests/web-hub/ui/*highlight*" --maxWorkers=2
  → Test Files 10 passed, Tests 172 passed
npx vitest run tests/web-hub/ui/logic-preview-{lines,probe,stream}.test.ts tests/web-hub/ui/logic-preview.test.ts \
  tests/web-hub/ui/preview-line-numbers.test.ts tests/web-hub/ui/preview-virtual-types.test.ts --maxWorkers=2
  → 357 passed（受影响邻居回归：previewLines/高亮消费方/冻结接口用例）
npx vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json        → exit 0
npx prettier --check <8 个交付文件>                          → All matched files use Prettier code style!
npm run build:web                                            → exit 0（import.meta.env / @logic 导入经生产构建验证；
                                                               >500kB chunk 警告为既有项，§6.5 预算不变）
```

- 属性测试均用 fast-check（devDeps 已有 ^4.9.0，未新增依赖）；`fc.string` 的 unit 只用 `grapheme-ascii`/`binary`（fc v4 无 `ascii` unit）。
- 未跑全量 `npm test`（任务纪律）；未 commit。

## 决策与实现说明（方案留白处的落点）

1. **`chooseSourceRenderer` 返回字符串联合**（`"legacy" | "numbered" | "numbered-capped" | "stream-lines" | "virtual"`）——方案只定判定表未定返回形状；P3 的 r0 分支保留要求不受影响。`virtualEnabled=false` 时忽略 `fullView` 之外无任何新语义（fullView=true 也按 §4.7「等同行号关」处理，r0 模式下实际不可达）。
2. **`computeWindow` 入参加了一个可选 `selectionActive`**（方案 §4.5 列了六个字段但 2048 上限/只增不减语义必须区分「有无选区」才能表达；§6.3 测试行本身要求测 2048 上限）。P3 在选区活跃时传 `retain=上次窗口 + selectionActive:true`，平时传 `retain=上次窗口`（滞回）或 `null`。
3. **半块滞回的实现**：目标行区间（可见行 ± overscan 屏）对**上一次已挂载区间**做边级滞回——收缩方向上，旧边缘在目标边缘进入其 `B+16` 行邻域内时保留（量化后表现为：下滚时旧块比纯目标多挂至多 1 块、上滚增长立即），「窗口 ⊇ target 且每边 ≤ +1 块」有属性测试钉住。`retain=null` 时为纯目标窗口（无滞回）。
4. **选区上限语义**：并集 > 64 块 ⇒ 返回**正常窗口**并 `capped:true`（§4.5「到达上限后恢复正常窗口」）；恰好 64 块不封。正常窗口本身不受 64 块约束（上限是选区承诺，不是渲染约束）。
5. **`maxLines` 对非法 rowH**（未测得/退化）回落 `VIRTUAL_MAX_LINES`（px 项无法求值时只保留行数界）；`reanchor` 对非法高度原样透传 `max(0, scrollTop)`——都已在 JSDoc 写明，由 P2/P3 的测量兜底先行。
6. **find 引擎为工厂闭包 `createPreviewFinder()`**（与 `createMarkdownSegmenter` 同风格）。`search()` 在文本+大小写模式未变时**复用折叠缓存**（查找框逐键重搜不重折 16 MiB）；命中数组是引擎内部活数组（只读约定，接口注释已写明）。
7. **carry 丢弃命中的场景在本协议下结构性不可达**（命中只收在稳定前缀上，而稳定前缀只增长）：§4.6 的 `end ≤ stableLen_new` 过滤与当前项「≥ 原起点的第一个命中」回落作为防御性代码保留并直接单测了回落解析规则。`flush()` 大小写敏感模式为 no-op（无折叠无 carry），与方案「退化为 stableLen = length」一致。
8. **`displayLine` 缓存 FIFO 封顶 8192 行**（≥ 选区挂载上限 2048 + 视口余量；方案只说 "Cached per (i, revision class)"，未定上限）。跨行 token 的 `"\n"` 切到 `eol`（§R2 #1）有固定用例。
9. **`shouldHighlight` 字节上限为含边界值语义**（`> cap` 才拒，与原实现一致）；limits 的 `Infinity` 合法（§5.3 明确用于关行数上限），`undefined/NaN/非数`回退常量。
10. **`HighlightSpans` 编解码放在 `highlight.js`**（纯 JS/JSDoc，checkJs false；类型侧由 `previewVirtualTypes.ts` 结构兼容）。`decodeHighlightSpans` 被 `previewLineIndex.displayLine` 复用（二分定位 + 行窗口切片 + 相邻同类合并），`previewLineIndex.ts` 是第一个 logic→logic 的 `@logic/*` 导入（别名在 vite/vitest/vue-tsc 三处均已验证）。

## 给 P2/P3 的接口备忘

- `factory.fromText(text)` revision 1 / `{kind:"init"}`；`factory.forStream()` revision 0；append 契约违反 dev 抛 / prod 重建（`{kind:"init"}`）。
- `chooseSourceRenderer(input, { virtualEnabled })`：P3 生产调用可省 options（读常量）；测试注入 `false` 钉 r0 分支（§6.3 `preview-line-numbers.test.ts` 的改法）。
- find 接线：`search(q, cs, source.text())`（查询/大小写变化）→ 之后每个 `append` revision 调 `finder.append(source.text())`，流终态（done/cap/changed）调 `flush()`；视口定位当前项用 `setCurrent(startOffset)` + `currentIndex()`。
- `maxDisplayCols` 已含截断标记 12 列与 §4.4 封顶，P2 的 spacer `min-width` 直接用它。

## 遗留问题

- 无阻塞项。工作区同时存在 PB（csp-probe、vite.config.ts）与 P2（VirtualCode/VirtualBlock/stub）的在途文件，本包未触碰；`build:web` 在两者共存下已验证通过。
- 方案 §6.1 中「查找增量与全量一致」的真实浏览器差分项属 PB/P4 的真机验收，不在 P1 单测范围。
