# #37 Web UI `write` 工具专用渲染 — L2 实施方案

状态：待异源 review + 用户确认后开发。**设计预览（静态 HTML，非已上线）：`/tmp/pi-previews/write-tool-card/index.html`（desktop.png / mobile.png）；正式实现须用户确认该预览后才派开发包。**分数 ≈5（L2），单实现包。先读：`docs/dev/web-hub/README.md`（UI 不变式）、`logic/diff.js` + ToolCard 的 `editDiff` 分支（edit 专用渲染，本方案的同构先例）。

## 1. 需求

web UI 里 `write` 调用现走 ToolCard 通用 `argsText = safeJson(args)`：`content` 变成带 `\n` 转义的一长行 JSON，不可读；`endLabel` 取**结果**行数，成功文案 "Successfully wrote to <path>" 恒显示 1 行，误导。

目标（仅 UI 层）：

1. `write` 的完整 args 解码为**保留换行**的代码块，头部摘要 `path`（PathText）· 紧凑英文 token `N lines · M KB`（<1KB 用 `M B`）。
2. 复制 = 完整**已收到**的 content（CopyButton，非高亮后文本）。
3. 「代码 / 原始 JSON」可切换（默认代码）。
4. 大内容默认折叠（ClampToggle/useCoarseClamp）；超 HIGHLIGHT_MAX_* 时 HighlightedCode 自行降级为纯文本。
5. 结果：标准成功输出可隐藏；**错误与自定义结果原样展示**，原始结果始终可查看。

## 2. 非目标

不改 write 工具/TUI/协议/wire/reducer；不改 `logic/tools.js` 的 `toolView`（它优先 `call.arguments`，流式时 `arguments:{}` 遮住 `partialJson`——本次不修）；不承诺逐 token 代码流；不新增依赖、不动 fixtures；不改 edit/其它工具渲染。

## 3. 精确文件域（7 个）

| 文件                                                                | 动作                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/writeView.ts`                             | 新：纯函数 `buildWriteView(toolName, args, result?)`                              |
| `src/web-hub/ui/src/components/transcript/ToolCard.vue`             | 加 `writeView` computed + 模板分支（`editDiff` 分支之后，约 214–260 行区）        |
| `src/web-hub/ui/src/styles/transcript.css`                          | `.write-*` 样式（复用 diff 的 mono/clamp 变量，窄屏换行/横滚）                    |
| `src/web-hub/ui/src/i18n/zh/transcript.ts`、`i18n/en/transcript.ts` | 新 key：`tool.write.{code,raw,bytes,lines,received,copy,resultRaw}`（zh/en 对齐） |
| `tests/web-hub/ui/logic-write.test.ts`                              | 新                                                                                |
| `tests/web-hub/ui/tool-card.test.ts`                                | 增 write 用例                                                                     |

只读复用（不改）：`shared/HighlightedCode.vue`（props `text/lang/immediate`）、`detail/CopyButton.vue`（`CopyButtonProps`，先核对 value/label 字段名）、`composables/useCoarseClamp`、`transcript/ClampToggle.vue`、`preview/PathText.vue`、`logic/highlight.js` 的 `resolveFileLang(basename)`。主会话与子 agent 链共用 ToolCard，自动同时生效。

## 4. 实现步骤

1. **writeView.ts**（total 函数，永不抛）：返回 `null` ⇒ 走旧渲染。条件：`toolName==="write"` 且 args 为对象（或可 `JSON.parse` 成对象的 string，解析失败/非对象 ⇒ null）、`typeof content==="string"`、`typeof path==="string"`（**path 缺失时仍以代码块展示，摘要省略 path**；string 化 JSON 的解析是有意的超集——历史/流式 args 可能是字符串，解析失败走 raw 旧渲染）。返回 `{ path, lang, content, lines, bytes }`。
   - `lines`：按 `\r\n|\n|\r` 切分；`""`⇒0；末尾恰有一个终止换行不多算一行（`"a\n"`⇒1，`"a\n\n"`⇒2，`"a\r\nb"`⇒2）。
   - `bytes`：UTF-8 字节数，优先用 codepoint 步进累加（<0x80→1、<0x800→2、<0x10000→3、否则 4；孤立代理按 3，与 TextEncoder 的 U+FFFD 一致），不为大内容分配 `TextEncoder.encode` 大缓冲（CJK/emoji 按真实字节，测试对照 TextEncoder 结果）。
   - `lang`：`path` 取 basename（同时按 `/` 与 `\` 切，Windows 路径安全）→ `resolveFileLang`；未知 ⇒ null（纯文本）。
2. **ToolCard.vue**：`writeView = computed(...)`；非 null 时 Input 区渲染：头部（PathText · `N lines · M KB` · 「收到的内容」；折叠语义：`>18` 行默认折叠，ClampToggle 展开全部、再点收起；折叠只影响显示，复制恒为完整 content）、代码/Raw 切换（`ref`，Raw 即原 `argsText`）、CopyButton(content)、`HighlightedCode` 放 `<pre translate="no" tabindex="0">`，包 useCoarseClamp + ClampToggle。**不使用 v-html**，仅 HighlightedCode VNode。
   - 流式：args 未成对象/无完整 content（含 `arguments:{}`、partial 兜底）⇒ writeView 为 null ⇒ 沿用旧 partial/argsText 兜底；完整后自动切代码。
   - 传输截断：args 级无截断标记，故不显示「总行数/总字节」，一律标「收到的内容」；保留既有 `view.truncated` 徽章与 `truncatedTitle`（其口径是结果截断，文案不改）。
   - 结果：`state==="done"` 且 result **精确匹配** pinned pi 的成功文案 `Successfully wrote to ${path}`（**不含字节数**，path 与 args.path 一致；不用宽松正则）⇒ 默认不渲染 Result 区、`endLabel` 置空，但提供「原始结果」折叠项；精确匹配只隐藏标准成功输出；custom 文本与 error 状态一律走原 Result 区不变，error 的 `endLabel` 保持。
3. i18n zh/en 同步；CSS 用现有 token，窄屏 `pre` 横向滚动、头部 flex-wrap。
4. 测试（见 §5）。

## 5. 可核实验收

**logic-write.test.ts**（断言具体值，禁恒真）：

- 非 write ⇒ null；args `undefined`/`null`/数组/数字/`{}`/content 非 string ⇒ null；string 化合法 JSON ⇒ 解析成功，非法 JSON ⇒ null。
- 空 content ⇒ `lines 0, bytes 0`（仍渲染，显示空代码块）。
- 行数：`"a"`1、`"a\n"`1、`"a\n\n"`2、`"a\r\nb\r\n"`2、`"a\rb"`2。
- 字节：`"中"`3、`"😀"`4、`"é"`2。
- 语言：`/x/a.ts`→ts 系、`C:\x\a.py`→py、`a.unknownext`/无扩展名 ⇒ null；`.env` 等点文件不抛。
- `content` 原样保留（不 trim、不改 `\r`）。

**tool-card.test.ts**：write 完整 args ⇒ 出现多行 `<pre>`、无 `\n` 字面转义、摘要含真实 `N lines`/`M KB`、不显示 "1 行" 的结果行数；Raw 切换显示 JSON；流式 `arguments:{}`+partialJson ⇒ 旧兜底；错误结果与自定义结果原样可见；成功标准结果隐藏且「原始结果」可展开；超大 content（> HIGHLIGHT_MAX_BYTES）默认折叠且不报错；CopyButton value === 完整 content（mock clipboard）；content 含 `<script>`/`</pre>`/`javascript:` 链接串 ⇒ 仅作文本节点，DOM 中无 script/新元素（XSS）；`view.truncated` 徽章保留。

**其它**：`source-scan.test.ts` 通过（writeView/ToolCard 无 `v-html`/`innerHTML`/`eval`、无内联 style 字符串、CSP 不变）；`i18n-parity.test.ts` 通过（zh/en key 全对齐，文案不混中英于 compact 标记——按 AGENTS 约定摘要用英文 token `N lines · M KB`（<1KB 用 `M B`））。移动端：375px 宽头部不溢出、代码横滚、复制/切换按钮 ≥ 触控尺寸。

## 6. 命令（门禁）

```sh
npm run typecheck
npx vitest run tests/web-hub/ui/logic-write.test.ts tests/web-hub/ui/tool-card.test.ts \
  tests/web-hub/ui/i18n-parity.test.ts tests/web-hub/ui/source-scan.test.ts
npm run format:check
npm run build:web && npm run check:web      # 体积/CSP/provenance 门；新增 CSS/组件不得破预算
git diff --quiet origin/dev -- tests/fixtures/   # 口径见下：以 #37 开工基线+自身文件域归因
```

**fixture 门禁口径**：以 #37 开工时的基线及 #37 自身文件域归因为准——#36 已申报的新增/工作树 fixture 不算 #37 变动；判据是 #37 文件域内无 `tests/fixtures/` 改动，而非整体 `git diff origin/dev` 必须为空。

`test:tier1` 在包验收前跑一次（日常门），**由 root 串行安排，不与 #36 verifier 并跑**；全量 `npm test` 不需要。

## 7. 浏览器截图验证（可执行方式）

不重启在用的 hub。**不能直接 `dev:hub` 现有 scenario（其中没有 write 样例）**。载体二选一：(a) /tmp 下 wrapper 脚本，编程调用 dev hub 的 `fixturesDir` 选项指向 /tmp 自带的 mock transcript fixtures（含 write 完整 args / 流式 / 错误结果 / 大内容；不改仓库 `tests/fixtures/`）；(b) 独立 mock 静态页挂载 `dist/web-hub-ui/` 与 mock transcript。均用独立临时端口，不碰在用 hub，无需 `PI_CODING_AGENT_DIR`。用 headless Chromium（snap 版需经 http 访问，截图输出到 `~/snap/chromium/common/` 再复制）截 375px 与 1280px 各一张存 /tmp，由主会话/验收者读图。**移动端与布局结论以真实截图为准**，DOM/vitest 断言只证明结构与文本（`<pre>` 含真实换行等），不得冒充布局验证。无真浏览器时在报告中声明未做。

## 8. 风险

- 流式 `arguments:{}` 遮蔽 partialJson：流式期间仍是旧外观，属已知限制（后续另开改 `toolView`）。
- 传输截断无 args 级标记：只能用「收到的内容」口径；若 content 被截断，复制的也是截断内容——文案已提示。
- 标准成功结果正则与工具输出文案耦合：不匹配则退化为显示结果（安全方向）；实现时对照真实输出并加测试固定。
- 大 content 的 Prism 开销：靠 HighlightedCode 既有限额与分批；折叠态仍渲染全文 DOM，超大时验证滚动性能，必要时对 >HIGHLIGHT 限额直接纯文本。
- bundle 预算：仅复用已有组件，预计增量 <2KB；`check:web` 兜底。
