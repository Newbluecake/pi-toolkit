# web-hub：把 ```mermaid 代码块渲染成图——实施方案（r2）

> 落盘位置：`docs/dev/web-hub-mermaid/plan.md`（覆盖 r1）。本次调研只读，仓库零改动。
> 证据来源分两轮：
>
> - **r1 spike**：`/tmp/mmspike/{spike,dist-spike,run.cjs}`。mermaid@12.2.0，vite@5.4.21，CSP 与 `hub/http.ts` 一致，Playwright 跑 Chromium 1243 和 Firefox。
> - **r2 spike**（2026-10-21，本次新增）：
>   - `/tmp/mmspike/r2/` + `vite.r2.config.js` + `run-r2.cjs`：保留 ELK、stub KaTeX，测资源加载路径、DOMPurify 白名单、全图类型语料和大图耗时；
>   - `/tmp/mmspike/r3/` + `prov-plugin.mjs` + `vite.r3.config.js`：验证 Rollup 归属插件、`mmd-` 命名和许可证清单。
>
> WebKit 在本机缺系统库、起不来，所以 iOS 只能留到真机验收。正文里写「已实测」的结论都出自上面两轮 spike。

---

## r2 修订记录

| 编号       | 处理方式                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 所在章节          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 用户 D1    | 保留 ELK（mermaid 12 的默认布局），删除 ELK stub、`subGraphTitleMargin` 及「ELK 签名不得出现」类断言。dagre 保留为作者可选的非默认布局（`layout` 不再锁定）。按实测重算体积和 manifest 常量。EPL-2.0 改为合法分发，义务逐条落实到三种分发物，许可证白名单加入 EPL-2.0                                                                                                                                                                                           | §0、§2、§7.4、§8  |
| 用户 D2    | 不打包 KaTeX。如实写明：含 `$$…$$` 的部分图类型（已实测 sequence）会整体回落源码，flowchart 则把公式当普通文本显示                                                                                                                                                                                                                                                                                                                                              | §2.3、§11 第 5 项 |
| 用户 D3–D6 | 按原推荐：宽图默认适应宽度，另给「原尺寸」按钮；所有经 MdBlock 的地方都生效；上调常量并保留按图类型懒加载；图跟随亮/暗主题                                                                                                                                                                                                                                                                                                                                      | §6、§7.4          |
| 用户 iOS   | 首版不做 iframe 退路。真机失败就回落源码，另立项评审。原 (b) 降级为附录备忘                                                                                                                                                                                                                                                                                                                                                                                     | §1、附录 A        |
| #1 Blocker | 豁免限域整体重做：构建期 Rollup 插件按模块图计算「mermaid 独占模块集」，独占 chunk 命名为 `assets/mmd-*`，混合 chunk 直接让构建失败。插件写出一份按文件 sha256 绑定的归属清单，check:web 拒绝陈旧清单。豁免只按文件生效，不再按可达性推导。首屏集合改为始终递归静态依赖，并在相减之前断言与 mermaid 集不相交。补 6 个反例测试。r3 spike 已验证可行                                                                                                              | §7.2、§7.3、§10.3 |
| #2 Blocker | 新增 §3「主文档阶段资源防线」。实测确认三条请求路径：flowchart `@{img}`、sequence actor `properties.icon`，以及 classDiagram `style … fill:url(...)`（Chromium 真发请求）。防线分层，全部在 DOM 插入和请求**之前**生效：词法预检（CSS 资源函数）→ 用 mermaid 自己的解析器预解析，检查 DB 和作者配置 → DOMPurify 白名单 → 图类型白名单。monkeypatch、惰性文档、meta CSP 等方案已评估并否决。补真实浏览器的网络与 DOM 副作用门禁。修正「CSP + strict 兜底」的说法 | §3、§9、§10.4     |
| #3 Major   | `svgToImage` 改为受限解析根标签：数值有限、宽高为正、边长和面积有上限，`width`/`height`/`style` 不重复，viewBox 原样保留。定义 UTF-8 输出预算和缓存预算（编码后 URL + key，按 JS 码元计），明确它**不是**图像内存预算。补异常用例                                                                                                                                                                                                                               | §5                |
| #4 Major   | 冻结 runtime 生命周期契约：计时起点、单请求总期限、队列上限、同 key 合并、取消、熔断 drain、「调用方已结算」与「引擎仍占槽」分离、哪些结果可缓存，组件侧用请求代次防止旧结果覆盖。全部写进接口文本                                                                                                                                                                                                                                                              | §4                |
| #5 Major   | 采纳：不自动扩大 hub 安全面。(b) 移到附录 A，补全将来另立项需要评审的 framing/CSP/认证/消息校验清单                                                                                                                                                                                                                                                                                                                                                             | 附录 A            |
| #6 Major   | 许可证落实到 npm 包、总 zip、独立 UI zip（独立 zip 在受校验根目录之外附 `web-hub-ui/<ver>.licenses/`）。清单按**实际输出模块**收集（同一份归属清单），离线检查条目、版本、SPDX、版权行和 Apache NOTICE。缺 license 字段的包走带人工核实记录、按版本钉死的例外表。顺带补齐现有遗漏（Vue 系、typebox）                                                                                                                                                            | §8、§10.5         |
| #7 Major   | stage CSS 移进 P1 共享基础（`styles/mermaid-stage.css`，由 runtime 引入）。probe 显式引入生产 `tokens.css` 的字体栈。S0 最小入口只依赖 P1，作为 P1 的合入门禁                                                                                                                                                                                                                                                                                                   | §6.1、§10.4、§12  |
| #8 Minor   | 写明同版本重新部署必须重启 hub，区分旧 agent / 新 UI / 旧 daemon 三种组合。`ui-root.test.ts` 里硬编码的 65 改为基于 `UI_MAX_FILES` 构造，并补上下边界和降级占位测试                                                                                                                                                                                                                                                                                             | §7.5、§10.5       |
| #9 Minor   | 收窄「字体一致」的承诺。规定作者配置的允许范围（字体族变体一律拒绝，字号变体限数值区间）。一致性由 probe 用真实渲染逐图类型验证（label 必须落在 shape 内），不靠配置推理                                                                                                                                                                                                                                                                                        | §2.2、§10.4       |
| #10 Minor  | 同 D2：跨图类型数学用例写进 probe 期望表，验收如实写明                                                                                                                                                                                                                                                                                                                                                                                                          | §2.3、§10.4       |
| #11 Minor  | 图视图下复制失败时：先切到源码 → `nextTick` → 选中。选中失败不显示「已选中」。补组件测试                                                                                                                                                                                                                                                                                                                                                                        | §6.3、§10.2       |
| #12 Minor  | 验收条款改为可测：区分冷启动/热启动、排队、设备；给锚点漂移设容差；区分页面刷新、会话重新挂载和缓存淘汰                                                                                                                                                                                                                                                                                                                                                         | §11               |
| #13 Minor  | web 构建工具链最低 Node 22.12，CI 加一个 22.12.0 最低版本 job。运行时下限保持 `>=22`。git 安装用 `--omit=dev`（已核 pi 源码），用户侧不受影响                                                                                                                                                                                                                                                                                                                   | §2.4、§12         |
| #14 Nit    | 采纳：许可证与归属合并为一份 digest 绑定的 sidecar，不再单独做许可证插件；probe 复用 `csp-probe.ts` 的服务器；图类型白名单收窄首版面；保留字节预算和最小真实浏览器门禁；先冻结 §4 契约，再让 P1/P2 并行                                                                                                                                                                                                                                                         | §7、§10、§12      |

---

## 0. 结论速览

**路线**：主文档调用 `mermaid.render(id, text, stage)` 拿到 SVG 字符串，后处理后转成 `data:image/svg+xml` 交给 `<img>` 显示。CSP 一字不改（`img-src 'self' data:` 已经支持这种显示方式）。

**硬约束**（均已实测）：

- `htmlLabels:false`；
- 根标签按属性改写成 px 宽高；
- 扩展后的 `secure` 列表能挡住 `%%{init}%%` 和 frontmatter 对 `htmlLabels`/`themeCSS`/`dompurifyConfig`/`fontFamily`/`fontSize` 的覆盖。

**r2 新结论 1：stage 不是隔离边界。** 主文档渲染阶段确实会发出同源请求（r2 spike，`/probe/*` 记录服务器）：

| 输入                                                   | 资源路径                                        | Chromium                        | Firefox |
| ------------------------------------------------------ | ----------------------------------------------- | ------------------------------- | ------- |
| `A@{ img: "/probe/x.png" }`（含 YAML 转义 `"\x69mg"`） | `new Image()` + `decode()`                      | 发请求                          | 发请求  |
| sequence `properties A: {"icon": "/probe/x.png"}`      | `<image xlink:href>` 插入 stage                 | 发请求                          | 发请求  |
| classDiagram `style A fill:url(/probe/x.svg#g)`        | CSS 外部引用                                    | 发请求（type=other）            | 未发    |
| architecture `service s "<img src=…>"`                 | `.html(sanitizeText(…))` 不受 `htmlLabels` 控制 | 默认 DOMPurify 配置放行 `<img>` | 同左    |

前三类在「预解析拒绝」之后均为零请求（实测）。第四类用 DOMPurify 白名单封住（实测零请求，22 种常见图类型照常渲染）。详见 §3。

**ELK 保留（D1）**：

| 项                                     | 数值                             |
| -------------------------------------- | -------------------------------- |
| ELK 块                                 | 1,476,025 B raw / 约 450 KB gzip |
| 首张 flowchart（core + ELK + flow 块） | 约 650 KB gzip                   |
| 首张 sequence                          | 约 200 KB gzip                   |
| 500 边链状 flowchart（桌面）           | 约 2.45 s                        |
| 60 节点 480 边稠密图                   | 约 1.2 s                         |
| 20 个 subgraph 共 200 节点             | 约 1.1 s                         |

触屏设备另设复杂度预算（§2.1）。

**体积与常量（实测）**：

- mermaid 闭包：61 个文件，4,885,370 B raw，约 1.41 MB gzip。
- 现有 UI：18 个文件，1,353,192 B。
- 合计约 79 个文件、约 6.24 MB。
- 常量：`UI_MAX_FILES` 64 → **128**，`UI_MAX_TOTAL_BYTES` 4 MiB → **12 MiB**，新增 `MERMAID_JS_BUDGET_GZIP_BYTES = 2 MiB`。

**门禁**：

- check:web 的豁免只给归属清单证明为「mermaid 独占」的 `assets/mmd-*` 文件；
- 首屏集合与 mermaid 集在相减之前断言不相交；
- 许可证检查覆盖实际输出模块，EPL-2.0 合法分发。

---

## 1. 渲染路线

### (a) 主文档渲染 → SVG 字符串 → `<img src="data:image/svg+xml,…">`（采用）

**渲染阶段**：

- mermaid 往 svg 里插 `<style>`，d3 设置 `style` 属性。CSP `style-src 'self'` 只拦它们**生效**，序列化出的字符串完整保留。
- 到了 img 里，SVG 是独立的图像文档，样式正常生效。
- 实测违规报告只有 `style-src-elem` / `style-src-attr` 两类，是控制台噪声，不出现 `script-src` 违规。

**但这不等于安全**：主文档阶段的 `<image href>`、`new Image()`、CSS 外部引用、CSSOM 写样式、SVG 表现属性（`fill="url(...)"`）都不受 `style-src` 约束。CSP 只把请求**限制**在同源和 `data:`，并不**阻止**请求。r1 的说法「CSP + strict 足够兜底」**撤回**，资源防线见 §3。

**测量与字体**：

- 被拦的 `<style>` 在测量阶段不生效，getBBox 用的是继承来的字体。
- 所以 stage 容器用我们自己的 CSS（`styles/mermaid-stage.css`，`'self'` 允许）设 `font-family: var(--font-sans); font-size:16px`。
- 同时把 mermaid 的 `fontFamily` 设为运行时读到的 `--font-sans` 值。
- r1 的「只差 2–5 px」是用 Trebuchet 字体栈量的，**不移植**。生产字体栈下的一致性改由 probe 逐图类型实测（§10.4 的 F 组）。

**显示阶段**：img 里的 SVG 文档没有脚本、外部请求、交互和链接。

### (b) iframe 渲染：首版不做

见附录 A。真机上若出现结构性失败（图片解码失败等），处置是**回落源码**，另立项评审。

### (c) 放宽全站 CSP：否决

同 r1：放宽会让整个应用对 CSS 注入敞开，抵消 csp-probe 和 source-scan 的保证。

---

## 2. mermaid 配置与上限（集中在 `logic/mermaid.ts`，纯函数、可测）

### 2.1 站点配置 `mermaidConfig(theme, fontFamily)`

| 键                                         | 值                                                                                                                                                                                         | 理由                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startOnLoad`                              | `false`                                                                                                                                                                                    | 只走手动 render                                                                                                                                                    |
| `securityLevel`                            | `"strict"`                                                                                                                                                                                 | 不用 `sandbox`：它产出的 `data:text/html` iframe 会被 `default-src` 拦掉                                                                                           |
| `htmlLabels`                               | `false`                                                                                                                                                                                    | foreignObject 里的 HTML 放进 img 解码失败；同时关掉多数图的 HTML 标签路径（实测 sequence/state/class 的 note 里写 `<img>` 不再进 DOM）                             |
| `layout`                                   | `"elk"`                                                                                                                                                                                    | 显式钉住（D1），防止 mermaid 以后改默认值。**不锁定**，作者可写 `layout: dagre`                                                                                    |
| `theme`                                    | 亮 `"default"` / 暗 `"dark"`                                                                                                                                                               | 跟随 UI（D6）                                                                                                                                                      |
| `fontFamily` / `themeVariables.fontFamily` | 运行时读 `--font-sans` 并压缩空白                                                                                                                                                          | 测量和显示用同一字体栈                                                                                                                                             |
| `fontSize`                                 | `16`                                                                                                                                                                                       | 与 stage CSS 一致                                                                                                                                                  |
| `maxTextSize`                              | `20000`                                                                                                                                                                                    | 与预检一致                                                                                                                                                         |
| `maxEdges`                                 | `500`                                                                                                                                                                                      | mermaid 默认值；触屏另有更严的预算                                                                                                                                 |
| `suppressErrorRendering`                   | `true`                                                                                                                                                                                     | 解析失败直接抛错，不往 DOM 插错误图                                                                                                                                |
| `dompurifyConfig`                          | `{ ALLOWED_TAGS: ["b","strong","i","em","u","s","del","sub","sup","small","mark","code","br","span","p","div"], ALLOWED_ATTR: ["class"], ALLOW_DATA_ATTR: false, FORBID_TAGS: ["style"] }` | 见 §3 的 G3。白名单会**替换**默认的 `{FORBID_TAGS:["style"]}`，所以要显式带上 `style`                                                                              |
| `secure`                                   | `["secure","securityLevel","startOnLoad","maxTextSize","suppressErrorRendering","maxEdges","htmlLabels","themeCSS","dompurifyConfig","fontFamily","fontSize"]`                             | 自定义 `secure` 会**整体替换**默认列表，默认六项必须写上。按键名递归删除，`flowchart.htmlLabels`、`themeVariables.fontSize` 一并删掉。`layout`/`theme`/`look` 不锁 |

### 2.2 作者配置的允许范围（#9；由 §3 的 G2 执行，基于 `mermaid.parse()` 返回的**已解码**配置）

- **允许**：`theme`、`look`、`layout`、`themeVariables` 中的颜色类值（mermaid 自己限定字符集为 `[\d "#%(),.;A-Za-z]`），以及各图类型小节里的非字体数值/枚举项。
- **拒绝**（判 `unsupported`，显示源码并附简短原因）：
  1. 任一字符串值命中 CSS 资源函数（`url(`、`image-set(`、`-webkit-image-set(`、`cross-fade(`、`-webkit-cross-fade(`），或者含反斜杠；
  2. 除 `fontFamily` 外，任何键名匹配 `/fontfamily/i`（`altFontFamily`、`actorFontFamily`、`messageFontFamily` 等）；
  3. 除 `fontSize` 外，键名匹配 `/fontsize$/i` 但值不是 8–40 之间的数字（或 `^\d+(px)?$`）；
  4. 键名匹配 `/fontweight$/i` 但值不在 `{normal, bold, 100…900}` 内。
- `fontFamily`/`fontSize` 不判拒绝：mermaid 的 secure 删除会处理（包括嵌套的同名键）。

**承诺收窄**：方案**不再**宣称「靠配置保证测量与显示一致」。站点默认的字体变体（例如 sequence 的 `actorFontFamily` 默认值）在测量和显示时是否一致，由 probe 的 F 组逐图类型实测；不一致的图类型要么修配置，要么移出白名单（§3 的 G4）。

### 2.3 数学公式（D2）

KaTeX 不打包，构建期把 `katex` 别名到 `vendor-stubs/katex.ts`：只导出会抛 `pwh-mermaid: KaTeX math is not bundled` 的 `render`/`renderToString`。**不能用 Proxy 全拦截**：r1 实测这样会连普通 flowchart 都失败。

实测行为：

- flowchart 的 `["$$x^2$$"]` 按字面文本显示；
- sequence 的消息/Note/participant 含 `$$` 时**整张图失败**。

runtime 把 stub 抛出的错误映射为 `unsupported`，提示「图中含数学公式（未支持），已显示源码」。各图类型的实际表现由 probe 记录成期望表（§10.4 的 M 组），验收如实列出。

### 2.4 上限与预算常量（`logic/mermaid.ts`）

| 常量                           | 值                                               | 说明                                                                                          |
| ------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `MAX_TEXT_CHARS` / `MAX_LINES` | 20 000 / 2 000（触屏 800 行）                    | 预检，超了不加载引擎                                                                          |
| `MAX_FLOW_EDGES`               | 500（触屏 200）                                  | G2 用解析后的 DB 计数；超了判 `too-large`。触屏 = `matchMedia("(pointer: coarse)")`，每页固定 |
| `MAX_SVG_UTF8_BYTES`           | 2 MiB                                            | §5                                                                                            |
| `MAX_SRC_CHARS`                | 4 Mi 码元                                        | 编码后的 data URL 长度上限                                                                    |
| `MAX_SIDE_PX` / `MAX_AREA_PX`  | 16 384 / 25 000 000（CSS px）                    | §5                                                                                            |
| 缓存                           | 48 条，`Σ(src.length + key.length) ≤ 16 Mi` 码元 | §5.3                                                                                          |
| 时间常量                       | 见 §4                                            |                                                                                               |

**工具链版本（#13）**：

- devDependency 精确锁定 `"mermaid": "12.2.0"`，`elkjs` 跟随它的锁文件（0.9.3）。
- mermaid 声明 `engines.node >=22.12.0`，所以 **web 构建工具链（`build:web`/`check:web`/probe）的最低版本是 Node 22.12**。
- 包的运行时下限 `engines: >=22` 不变：pi 的 git 安装用 `npm install --omit=dev`（已核 `package-manager.js`），npm 用户也不会装 devDependencies。

---

## 3. 主文档阶段资源防线（#2）

### 3.1 威胁与证据

stage 在主文档里，并且必须在文档里，否则 getBBox 无法布局。任何在 stage 里设置的 `<image href>`、`<img src>`、外部 CSS 引用，以及游离的 `new Image()`，都会在属性赋值或插入的那一刻发起请求。MutationObserver 是微任务，发现时已经晚了。

CSP 把这些请求限制在同源和 `data:`。残余危害有三类：

- 对 hub 同源 GET 的副作用和探测；
- 解码不可信的 `data:` 图片（CPU/内存）；
- 一个永不完成的 `decode()` 拖住引擎槽。

源码盘点（mermaid 12.2.0 `dist/chunks/mermaid.core`）：

| 路径                                                                                                                                                            | 坐标                                                                                     | 是否受 strict / htmlLabels 约束             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| flowchart shape data `img` → `imageSquare`：`new Image(); img.src=node.img; await img.decode()` + `<image href>`                                                | `chunk-NQOKRVIF.mjs:255,852`；`chunk-HAGFOTED.mjs:2850–2891`                             | 否                                          |
| sequence actor `properties.icon` → `drawImage`（`<image xlink:href=sanitizeUrl(…)>`）                                                                           | `sequenceDiagram-BLEHNHQU.mjs:2238–2243,2336–2340,2439–2445`；`chunk-55XCU76K.mjs:66–72` | 否（`sanitizeUrl` 只挡 `javascript:` 一类） |
| CSS 值里的 `url()`：CSSOM `.style()`、表现属性、style 属性                                                                                                      | 多处                                                                                     | 只有 style 属性被 CSP 拦                    |
| 绕过 `htmlLabels` 的 `.html()` 汇点：architecture `iconText`（`architectureDiagram-ZHVYKT53.mjs:813`）、eventmodeling（`diagram-PFBEJUXE.mjs:621`）、KaTeX 输出 | —                                                                                        | 否，只过 `sanitizeText`（DOMPurify）        |
| 全库唯一的 `new Image(`；无 `fetch(`、XHR、Worker、`importScripts`                                                                                              | grep 结论                                                                                | —                                           |

### 3.2 分层防线：全部在 DOM 插入和请求之前

- **G1 词法预检**：`logic/mermaid.ts` 的 `precheckMermaid`，在主包里运行，不加载引擎。
  - 先判 `too-large`。
  - 再对文本做**两路**归一化。CSS 路：解码 CSS 转义 `\hex{1,6}␠?` 和 `\X`。JS/YAML 路：解码 `\xHH`、`\uHHHH`、`\u{…}`、`\UHHHHHHHH`。两路都解码 `&#…;`、`&#x…;` 以及 mermaid 自己的 `#123;`/`#x7b;`；把命名实体 `&name;`/`#name;` 替换为通配符 U+FFFD；去掉 `/*…*/`；转小写。最多迭代 3 轮。
  - 任一路命中 `/(?<![\w-])(?:-webkit-)?(?:url|image-set|cross-fade)(?:\(|\ufffd)/`，就判 `unsupported`（资源引用语法）。
  - 这是对 CSS 解析器所见内容的**过近似**：会误伤字面写着 `url(` 的标签（例如类图里名为 `url()` 的方法），这类图显示源码。误伤面已收窄：不含 `src(`/`image(`/`element(`，也不匹配 `getUrl(` 这类前缀词。
  - 拦截对象是 classDef/style/linkStyle/cssClass/C4 `UpdateElementStyle` 等写进 CSS 的文本。
- **G2 语义预检**：在 `mermaid-impl.ts` 里，用 mermaid **自己的**解析器，在 `render` 之前执行：
  1. `mermaid.parse(text)` → `{diagramType, config}`。config 是 YAML/JSON **解码后**的值，按 §2.2 遍历判定，不受转义写法影响。
  2. `mermaid.mermaidAPI.getDiagramFromText(text)` → `diag.type`、`diag.db`，按图类型检查：
     - flowchart 系（`flowchart-v2`/`flowchart`/`flowchart-elk`）：任一 `db.getVertices()` 的值带 `img` → 拒绝；`db.getEdges().length > MAX_FLOW_EDGES` → `too-large`；
     - sequence：任一 `db.getActors()` 的值带 `properties.icon` → 拒绝；
     - 其余白名单类型：已审计，没有 DB 级的 URL 资源字段，检查为空操作，但仍要过 G4。
  3. 两次预解析都不碰 DOM：DB 只存数据，`new Image()` 只出现在形状渲染器里。已实测：预解析拒绝后 `/probe/flowimg.png`、`/probe/flowimgesc.png`（YAML 转义写法）、`/probe/seqicon.png` 都是零请求。
  4. **前提与残余**：预解析和 render 喂的是同一个字符串。mermaid 的语法与运行时配置无关，二次解析结果相同。probe 用带指令的变体覆盖这一点。代价是多两次纯解析，耗时在 P1 报告里记录。
- **G3 DOMPurify 白名单**（§2.1 的 `dompurifyConfig`，属于 secure 键，作者改不了）：`sanitizeText` 是所有 HTML 标签汇点的必经之路（`chunk-DSNLSHJZ.mjs:5355–5367`）。白名单只留排版标签和 `class` 属性，`<img>`/`<image>`/`<video>`/`<use>`/`src`/`href`/`style` 一律去掉。
  - 已实测：architecture `iconText` 里写 `<img>` 不再发请求；22 种图类型照常渲染。
  - 不加 DOMPurify hook（hook 是全局的，会连最终 SVG 清洗一起影响）。
- **G4 图类型白名单** `MERMAID_ALLOWED_TYPES`：`flowchart-v2`/`flowchart`/`flowchart-elk`、`sequence`、`classDiagram`/`class`、`stateDiagram`/`state`、`er`、`gantt`、`pie`、`gitGraph`、`mindmap`、`journey`、`timeline`、`quadrantChart`、`xychart`、`sankey`、`block`、`architecture`、`kanban`、`packet`、`radar`、`treemap`、`c4`、`requirement`。确切的类型字符串以 P1 probe 实测冻结为准。
  - 其余类型判 `unsupported`：eventmodeling、usecase、cynefin、wardley、venn、ishikawa、railroad/abnf/ebnf/peg、swimlanes、info、treeView 等。
  - 目的是闭世界：每个放行的类型都经过汇点审计和 probe 覆盖。升级 mermaid 时新增的类型默认不放行。
- **G5 输出扫描**（显示阶段的纵深防御，不是请求防线）：`svgToImage` 拒绝含 `<image`、`<img`、`<script`、`<iframe`、`<object`、`<embed`、`<video`、`<audio`、SMIL（`<animate`/`<set`），以及非 `#` 开头的 `url(` 的输出，判 `output-invalid`。
  - 命中说明 G1–G4 漏了一条路径，runtime 记一次 `gateBreach`（`console.warn`，不带文本内容）。
  - probe 断言 `gateBreach === 0`。

### 3.3 评估后否决的手段

| 手段                                                                                                                  | 否决理由                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| render 期间 monkeypatch 全局 `Image` / `HTMLImageElement.prototype.src` / `CSSStyleDeclaration.prototype.setProperty` | render 是异步的，窗口内应用其它代码（头像、预览、`useMdImageLoader`）会被误伤；打补丁和还原本身也有竞态 |
| stage 放进 `document.implementation.createHTMLDocument()` 或 `<template>`                                             | 不做布局，getBBox 全是 0                                                                                |
| 动态插入 `<meta http-equiv=CSP>` 收紧策略                                                                             | 对整页永久生效，无法撤销                                                                                |
| MutationObserver 事后清理                                                                                             | 请求在属性赋值时就已发出                                                                                |
| 生产环境的资源计时 / CSP 违规侦测（tripwire）                                                                         | 会把应用并发加载的资源误判为泄漏。只在 probe 里用 Playwright 的 request 事件做权威判定                  |

### 3.4 修正后的安全表述

- 主文档要执行脚本，仍然需要同时绕过 DOMPurify（G3 白名单 + mermaid strict 对最终 SVG 的清洗）和 CSP `script-src 'self'`。
- 主文档阶段的**资源加载**由 G1–G4 在请求前拒绝。CSP 只是第二道限域（同源 / `data:`），不是兜底。
- stage 不是隔离边界。

---

## 4. runtime 生命周期契约（#4，冻结，P1/P2 据此并行）

### 4.1 接口（`components/shared/mermaid-runtime.ts`）

```ts
export type MermaidTheme = "light" | "dark";
export type MermaidErrorReason =
  | "parse"
  | "render"
  | "too-large"
  | "unsupported"
  | "timeout"
  | "busy"
  | "load-failed"
  | "engine-unavailable"
  | "output-invalid";
export type MermaidOutcome =
  | { kind: "ok"; src: string; width: number; height: number; diagramType: string; title: string | null }
  | { kind: "error"; reason: MermaidErrorReason; message: string } // message ≤160 字符，单行，不含原文
  | { kind: "cancelled" };
export interface MermaidRequest {
  text: string;
  theme: MermaidTheme;
  signal?: AbortSignal;
}

/** 契约：永不 reject；对每次调用恰好 resolve 一次；最迟在 min(t0+CALLER_DEADLINE_MS, start+RENDER_TIMEOUT_MS) resolve。 */
export function requestMermaid(req: MermaidRequest): Promise<MermaidOutcome>;
/** 同步查询；只返回可缓存的结果（见 4.4），否则 undefined。不触发加载。 */
export function peekMermaidCache(text: string, theme: MermaidTheme): MermaidOutcome | undefined;
export function mermaidEngineState(): "idle" | "loading" | "ready" | "load-failed" | "broken";
/** 仅测试：清空队列/缓存/状态与计时器。 */
export function __resetMermaidRuntimeForTests(): void;
```

```ts
// components/shared/mermaid-impl.ts（懒加载；唯一 import mermaid 的地方）
export type ImplResult =
  | { kind: "svg"; svg: string; diagramType: string }
  | { kind: "rejected"; reason: "unsupported" | "too-large"; detail: string }; // G2/G4 拒绝
/** parse/render 失败时抛错（runtime 负责分类）；不保证在超时后终止。 */
export function renderSvg(input: {
  id: string;
  text: string;
  theme: MermaidTheme;
  fontFamily: string;
  coarse: boolean;
}): Promise<ImplResult>;
```

### 4.2 时间与容量常量

| 常量                 | 值              | 起点 → 终点                                                                                  |
| -------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `LOAD_TIMEOUT_MS`    | 20 000          | 首次 `import("./mermaid-impl.js")` 开始 → 模块就绪（全页共享一个 promise）                   |
| `CALLER_DEADLINE_MS` | 30 000          | 调用 `requestMermaid` 的时刻 t0 → 尚未开始执行就 resolve `timeout`（覆盖加载等待和排队等待） |
| `RENDER_TIMEOUT_MS`  | 8 000           | 任务**开始执行** → 调用方 resolve `timeout`（引擎可能仍占着槽）                              |
| `ZOMBIE_BREAK_MS`    | 30 000          | 任务开始执行 → 底层 promise 仍未 settle，熔断为 `broken`                                     |
| `MAX_QUEUE`          | 32              | 排队中的不同任务数（不含正在执行的那个）                                                     |
| 让出主线程           | `setTimeout(0)` | 两个任务之间（rAF 被 source-scan 禁用）                                                      |

### 4.3 语义

1. **入口顺序**：
   - `signal` 已 aborted → 下一个微任务 resolve `cancelled`，不建任务、不触发加载；
   - `precheckMermaid`（G1）失败 → 直接 resolve，结果可缓存，不加载引擎；
   - 缓存命中 → 直接返回；
   - 引擎状态是 `load-failed` 或 `broken` → 立刻 resolve 对应错误（缓存命中仍然优先返回）。
2. **同 key 合并**：key 为 `theme + "\n" + text`。已有同 key 任务在排队或执行时，新请求挂成该任务的订阅者，不新建任务。每个订阅者有自己的 signal、自己的 `CALLER_DEADLINE`、自己的结算。
3. **排队**：串行 FIFO，并发 1（mermaid 的全局配置和 id 不能并发使用）。
   - 队列满时，新的不同任务立刻 resolve `busy`（不缓存）。
   - 引擎在加载时，任务照常入队，就绪后开始执行。
4. **取消**：订阅者 abort → 该订阅者立刻 resolve `cancelled`，并移除监听。
   - 排队中的任务订阅者降为 0 → 移出队列。
   - **正在执行**的任务不中止，执行完照常写入缓存（结果正确）。
   - `cancelled` 永不写入缓存。
5. **超时**：
   - 执行满 8 s，所有订阅者 resolve `timeout`（会缓存，见 4.4），但执行槽要等底层 promise 真正 settle 才释放，下一个任务继续排队。
   - 底层晚到的结果丢弃，不写缓存。
6. **熔断 drain**：执行 30 s 仍未 settle → 状态 `broken`。所有排队任务的订阅者立刻 resolve `engine-unavailable`，之后的请求也立刻得到它，直到页面刷新。僵尸任务即使后来 settle，也不恢复。
7. **加载失败**：超时或 import 抛错 → 状态 `load-failed`。所有等待中的订阅者 resolve `load-failed`，本页不重试（hub 升级后旧页面里懒加载块 404 是同一种表现）。
8. **错误分类**（runtime 内，纯函数 `classifyMermaidError`）：
   - mermaid 的 parse/lexical 错误或 `UnknownDiagramError` → `parse`；
   - KaTeX stub 抛的错 → `unsupported`；
   - 其余 → `render`。
   - `ImplResult.rejected` 原样透传；`svgToImage` 返回 `null` → `output-invalid`。
9. **写缓存在先，resolve 在后**：任务完成时先写缓存（如果可缓存），再按订阅顺序 resolve。
10. **永不 reject**：所有分支包在 try/catch 里；`finally` 保证每个订阅者恰好结算一次（`settled` 标志）。

### 4.4 缓存（`logic/mermaid.ts` 的 `ByteBudgetLru`，纯类）

- **可缓存**：`ok`、`parse`、`render`、`too-large`、`unsupported`、`output-invalid`，以及执行期超时产生的 `timeout`。
- **不缓存**：`cancelled`、`busy`、`load-failed`、`engine-unavailable`（后两者是全局状态），以及 `CALLER_DEADLINE` 超时（属于等待类）。
- **预算**：最多 48 条，`Σ(key.length + (ok ? src.length : message.length)) ≤ 16 Mi` JS 码元。单条超过 4 Mi 码元时不缓存（`MAX_SRC_CHARS` 已经保证 ok 结果不会超）。
- **范围**：这是**字符串保留预算**，不是图像解码内存预算（位图由浏览器管理）。

### 4.5 组件侧代次（P2 必须遵守）

- `MermaidBlock` 维护 `gen` 计数和当前 `AbortController`。每次发起请求（挂载可见、text 变、主题变）都先 abort 上一个、`gen++`，再带新的 signal 发请求。
- 结果只在 `gen === 发起时的 gen` 且组件未卸载时才应用。卸载时 abort。
- 主题往返（亮 → 暗 → 亮）走两个不同的 key，各自命中各自的缓存。旧主题的结果被代次校验丢弃。

---

## 5. `svgToImage` 受限解析与预算（#3）

`svgToImage(svg): { src, width, height, diagramType, title } | null`，纯函数，位于 `logic/mermaid.ts`。

1. **输入预算**：`new TextEncoder().encode(svg).length ≤ MAX_SVG_UTF8_BYTES`，否则返回 `null`。
2. **根标签**：
   - 字符串必须以 `<svg` 加空白开头（mermaid 输出没有前导内容）；
   - 根标签结束位置 = 第一个不在引号内的 `>`，根标签总长 ≤ 4 KiB；
   - 不能是自闭合（`/>`）。
3. **属性语法**（逐字符扫描，不用宽松正则）：
   - 只接受 `name="value"` 或 `name='value'`，name 匹配 `^[A-Za-z_:][-A-Za-z0-9_:.]*$`，属性之间用空白分隔，值里不能有 `<`；
   - 裸属性、无引号值、重复的属性名、超过 64 个属性 → `null`；
   - 必须有 `xmlns="http://www.w3.org/2000/svg"`。
4. **viewBox**：
   - 必须存在，拆分后**恰好 4 个**数字（以空白和/或逗号分隔），每个都匹配 `^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$`；
   - `Number()` 后全部有限；`|minX|`、`|minY| ≤ 1e6`；`w`、`h > 0`；
   - `W = ceil(w)`、`H = ceil(h)` 满足 `1 ≤ W,H ≤ MAX_SIDE_PX` 且 `W·H ≤ MAX_AREA_PX`。否则返回 `null`。
5. **重写**：删除原有的 `width`、`height`、`style`，其余属性按原顺序**原样保留**（包括 viewBox），在最后追加 `width="W" height="H"`。正文不动。
6. **元数据**：
   - `aria-roledescription` 必须匹配 `^[A-Za-z0-9-]{1,32}$`，否则记为 `"unknown"`；
   - 第一个 `<title …>…</title>` 取文本，只解码 `&lt; &gt; &amp; &quot; &#N; &#xN;`，截到 200 字符；没有则为 `null`。
7. **输出扫描**：§3.2 的 G5。
8. **编码**：`"data:image/svg+xml;charset=utf-8," + encodeURIComponent(重写后的串)`。结果长度 `≤ MAX_SRC_CHARS`，否则返回 `null`（高膨胀输入，例如全 CJK，最坏约 4.5 倍）。
9. **已知残余**：mermaid 的边动画（`animate:true`）会在 img 里以 CSS 动画运行，属于正常渲染开销。SMIL 已在第 7 步拒绝；滤镜（neo look 的阴影）允许，靠面积上限约束。

单测用例：`width="100%"` 改写；已有 `height`（journey 回归）不重复；根上有 `style` 时删除；无 viewBox；3 个或 5 个数字；`NaN`/`Infinity`/`1e400`/`-0`/`0`/负宽高；科学计数法 `1.2e3` 合法；超边长、超面积；无引号属性、重复属性、`/>` 自闭合、引号内含 `>`、根标签超 4 KiB；缺 `xmlns`；全中文和 `#`/`%` 字符的编码与膨胀；超 `MAX_SRC_CHARS`；G5 的每个关键字；aria-roledescription 注入。

---

## 6. 组件

### 6.1 新增文件

| 文件                                                        | 所在包         | 职责                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/logic/mermaid.ts`                       | P1             | `isMermaidFence`、常量、`precheckMermaid`（G1）、`mermaidConfig`、`MERMAID_SECURE_KEYS`、`MERMAID_ALLOWED_TYPES`、`checkAuthorConfig`（§2.2，纯函数，供 impl 调用）、`svgToImage`、`classifyMermaidError`、`ByteBudgetLru`、`shortMermaidError` |
| `src/web-hub/ui/src/components/shared/mermaid-runtime.ts`   | P1             | §4 的契约实现；`import "../../styles/mermaid-stage.css"`（保证 stage CSS 进入主 CSS）                                                                                                                                                           |
| `src/web-hub/ui/src/components/shared/mermaid-impl.ts`      | P1（懒加载块） | 首次调用时创建 stage（`createElement` + `className="pwh-mmd-stage"` + `aria-hidden` + `document.body.append`）；主题或字体变化时重新 `initialize`；G2/G4；`render(id, text, stage)`；`finally` 里 `stage.replaceChildren()`；id 用 `pwh-mmd-N`  |
| `src/web-hub/ui/src/vendor-stubs/katex.ts`                  | P1             | §2.3                                                                                                                                                                                                                                            |
| `src/web-hub/ui/src/styles/mermaid-stage.css`               | P1             | `.pwh-mmd-stage{position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;font-family:var(--font-sans);font-size:16px;line-height:normal}`                                                                                             |
| `src/web-hub/ui/mermaid-provenance-plugin.ts`               | P1             | §7.2                                                                                                                                                                                                                                            |
| `src/web-hub/ui/csp-probe/mermaid.{html,ts}`                | P1             | S0 / probe 页面（§10.4），只依赖 P1 产物                                                                                                                                                                                                        |
| `src/web-hub/ui/src/components/transcript/MermaidBlock.vue` | P2             | 显示组件                                                                                                                                                                                                                                        |
| `src/web-hub/ui/src/composables/useEffectiveDark.ts`        | P2             | 是否暗色 = `html.theme-dark`，或（没有 `theme-light` 且 `prefers-color-scheme: dark`）；MutationObserver + mql，多实例共享，引用计数释放                                                                                                        |
| `src/web-hub/ui/src/styles/mermaid.css`                     | P2             | `.mmd-*` 显示样式（由 MermaidBlock 引入；`cssCodeSplit:false` 会并进唯一的 CSS 文件）                                                                                                                                                           |

### 6.2 修改文件（P2）

- **`components/transcript/MdBlock.vue`**：`BlockView` 新增 `{kind:"mermaid"; lang; text}`；`case "code_block"` 遇到 `isMermaidFence(n.lang)` 时走 mermaid 分支。模板加 `<MermaidBlock v-else-if="b.kind==='mermaid'" :lang :text />`。非 mermaid 的围栏仍走 `CodeBlock`，零差异。
- **`CodeBlock.vue`、`logic/markdown.js` 零改动**。`markdown-ref.js` 的差分契约不受影响。
- `contracts.ts`：新增 `MermaidBlockProps { lang; text }`。
- `i18n/{zh,en}/transcript.ts`：`mermaidShowSource`、`mermaidShowDiagram`、`mermaidRendering`、`mermaidError`、`mermaidTooLarge`、`mermaidUnsupported`、`mermaidMath`、`mermaidLoadFailed`、`mermaidBusy`、`mermaidAlt`、`mermaidFitWidth`、`mermaidActualSize`、`mermaidCopySelectFailed`。
- `components/preview/previewContext.ts`：只加注释，说明 `PATH_REFERENCES_SUSPENDED` 也被 MermaidBlock 用作「消息仍在流式」的信号。

### 6.3 MermaidBlock 的状态与 DOM

- **流式中**（`inject(PATH_REFERENCES_SUSPENDED, ref(false))` 为真）：原样渲染 `<CodeBlock :lang :text/>`，DOM 与现在逐字节相同。
- **settled 后**：`idle → (可见) loading → ok | error`。
  - 挂载时先同步 `peekMermaidCache`，命中就直接显示终态，不闪源码。
  - 可见性：`IntersectionObserver` 的 rootMargin 为 800px；环境里没有 IO 就立即请求。
- **DOM**：
  - 外层 `<div class="codeblock mmd" :data-mmd-state>`；
  - 头部：`mermaid` 标签、`role="status"` 文本、「源码 ⇄ 图」切换（`aria-pressed`，error 时隐藏）、「原尺寸 ⇄ 适应宽度」（只在 `naturalWidth >` 显示宽度且 `width ≤ 8192` 时出现，D3）、复制按钮（复制的始终是源码）。
  - 图视图：`<div class="mmd-figure"><img :src :width :height :alt decoding="async" @error></div>`，CSS 设 `max-width:100%; height:auto`；原尺寸模式下容器 `overflow-x:auto` 加 `tabindex="0"`。
  - 源码视图：`<pre tabindex="0" translate="no"><code>{{text}}</code></pre>` 加 `useCoarseClamp` + `ClampToggle`。
- **状态文字**：loading 显示源码视图和「渲染中…」；error 显示源码视图加一行 `.mmd-error`（按 reason 选 i18n 文案）；img 的 `@error` 视为 `output-invalid`。
- **复制（#11）**：组件内的小 composable `useCopyText`。
  1. `clipboard.copy(text)` 成功 → 「已复制」。
  2. 失败时，如果当前是图视图，先切到源码视图，`await nextTick()`。
  3. 取 `<pre>` 引用并选中内容：`createRange` 不存在、引用为空或 `getSelection()` 为 null → 状态「复制失败，请手动选择」；成功 → 「已选中」。
  4. 状态 2 s 后清空。
- **alt 文本**：有 accTitle 就用它，否则用「Mermaid {diagramType} 图」。
- **主题 / 文本变化**：按 §4.5 的代次机制；文本变化防抖 300 ms。
- **高度变化**：源码视图（≤420 px）→ 图、主题重渲染、源码/图切换都会改变高度。
  - 贴底跟随由 `Transcript.vue` 已有的 ResizeObserver 处理；
  - 视口上方块变高依赖原生 scroll anchoring；
  - 验收按 §11 第 7 项的容差。

### 6.4 生效面（D4）

所有经过 MdBlock 的地方：TxAssistant 文本、ToolCard 的 Markdown 结果路径、TxCustom、VersionPanel 发布说明、文件预览 `.md`（渲染模式和分段提交）。TxUser、ThinkingBlock 不经过 MarkdownView，不生效。

---

## 7. 打包、归属、构建门禁

### 7.1 构建

- `vite.config.ts` 两种模式都追加：
  - `resolve.alias`：`^katex$` → `vendor-stubs/katex.ts`；
  - 插件 `mermaidProvenancePlugin()`；
  - `rollupOptions.output.chunkFileNames: provenance.chunkFileNames`。
- csp-probe 模式的 inputs 加入 `csp-probe/mermaid.html`。
- **不用** `manualChunks`，保持 mermaid 按图类型懒加载（D5）。
- ELK 不 stub（D1）。

### 7.2 归属插件 `src/web-hub/ui/mermaid-provenance-plugin.ts`（#1；r3 spike 已验证）

1. **`buildEnd`**：基于 `this.getModuleIds()` 和 `getModuleInfo` 计算三个集合：
   - `M` = 从 `components/shared/mermaid-impl.ts` 出发、沿静态与动态 import 可达的模块；
   - `A` = 从所有入口出发、**不穿过** mermaid-impl 可达的模块；
   - 独占集 `E = M \ A`。
   - 「mermaid 被静态引入首屏」时 `E` 为空，后续断言必然失败。
2. **`chunkFileNames(chunkInfo)`**：`moduleIds` 非空且全部属于 `E` → `assets/mmd-[name]-[hash].js`，否则 `assets/[name]-[hash].js`。`isAllowedUiPath` 和 `HASHED_ASSET_RE` 都兼容，无需改动。
3. **`generateBundle`**：
   - 对每个 chunk 取 `renderedLength > 0` 的模块：一部分属于 `E`、一部分不属于 → `this.error("mixed chunk …")`，构建失败；
   - 对包含 `elkjs/lib/elk.bundled.js` 的 chunk，在代码最前面加 EPL 通知横幅（§8.3）。esbuild 已经剥掉了 legal comments，所以横幅加在压缩之后。
4. **`writeBundle`**：从磁盘读最终字节，写出 `node_modules/.cache/pwh-ui-provenance.json`（csp-probe 模式写到 `pwh-csp-probe-provenance.json`）：

```ts
interface UiProvenance {
  v: 1;
  chunks: Record<
    string /* dist 相对路径 */,
    {
      sha256: string;
      mermaidExclusive: boolean;
      containsImpl: boolean;
      packages: Array<{ name: string; version: string; license: string | null }>; // 按模块 id 的 node_modules 归属
    }
  >;
}
```

### 7.3 `scripts/web-hub/check-ui-dist.ts` 改动

- **修复 `classifyJsAssets`**：首屏集合 = 入口 script + modulepreload，**始终**沿静态 import 递归（删掉 `if (modulePreloads.length === 0)` 守卫）。
- **新增纯模块 `scripts/web-hub/lib/ui-provenance.ts`**：
  - `verifyProvenance(prov, jsFiles: Map<path, Buffer>)`：dist 里每个 `.js` 都必须在清单里且 sha256 一致，清单里也不能有多余条目，否则报「provenance 陈旧或缺失，请重跑 build:web」。
  - `exemptionsFor(path, prov)`。
- **断言**（按顺序）：
  1. 归属清单校验通过。
  2. 命名与归属一致：路径以 `assets/mmd-` 开头 ⇔ `mermaidExclusive`。
  3. `containsImpl` 恰好一个，并且它是独占 chunk。
  4. **相减之前**断言：首屏集合 ∩ 独占集 = ∅。
  5. `scanForbiddenPatterns(source, file, exempt)`：只有独占文件获得 `MERMAID_EXEMPTIONS`：
     - 模式豁免 `static style= attribute`（mermaid core / architecture / eventmodeling 的标签模板）和 `Function("`（lodash 取全局对象，见于 cynefin、cytoscape、graph 块）；
     - URL 允许列表追加 `https://chevrotain.io/`、`https://langium.org/`、`https://en.wikipedia.org/`、`http://www.eclipse.org/elk/`、`http://www.eclipse.org/emf/`、`http:///org/eclipse/emf/`（都是文档链接或 EMF 命名空间标识符，r2 实测）；
     - `eval(`、`new Function(`、`<style`、`<script`、`on*=` 不豁免（实测都不出现）。
  6. 预算：`LAZY_JS_BUDGET` 不计独占集；新增 `MERMAID_JS_BUDGET_GZIP_BYTES = 2 MiB`（实测约 1.41 MB）。
  7. 所有 chunk 的 `packages` 里不能出现 `katex`（D2 的归属式断言，替代签名字符串断言）。
  8. 许可证门禁（§8.4）。
- 原 r1 的 `mermaidChunkSet`（可达闭包减首屏）和 ELK/KaTeX 签名断言**全部删除**。

### 7.4 manifest 常量与 hub（D5）

- `protocol/ui-manifest.ts`：`UI_MAX_FILES` 64 → **128**（实测约 79，余量约 60%），`UI_MAX_TOTAL_BYTES` 4 MiB → **12 MiB**（实测约 6.24 MB，约 1.9 倍）。注释写明测量值和日期。
- `MAX_BUILD_INFO_BYTES` 64 KiB 足够：128 条 × 约 170 B ≈ 21 KB。
- hub 侧：`static.ts` 组装时 `gzipSync` 增加约 112 ms（r3 实测整个 mermaid 闭包），常驻内存增加约 6.3 MB（raw 加 gz）。哈希资源已是 `immutable` 缓存。
- npm 包和发布 zip 压缩后增大约 1.4 MB。

### 7.5 部署与新旧交叉（#8）

| 组合                                                      | 行为                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常升级（新版本号）                                      | 旧 daemon 由版本 supersede 替换，新常量和新 UI 一起生效                                                                                     |
| 同版本重新构建 UI（开发期 `build:web`），旧 daemon 仍在跑 | hub 按指纹重新校验 UI 根，旧常量（64 文件 / 4 MiB）判 `too-large`，返回「未构建」占位页。**必须 `/webhub restart`**，写进 acceptance 和本节 |
| 旧 agent + 新 UI + 新 daemon                              | 无影响（UI 常量只在 hub 侧使用，协议不变，不升协议）                                                                                        |
| 新 UI 页面 + hub 升级后旧懒加载块 404                     | `load-failed` 回落源码；现有的 stale-UI 提示会覆盖                                                                                          |

---

## 8. 许可证与分发（D1、#6）

### 8.1 实际输出清单（r3 实测，46 个包 + 现有 UI 依赖）

| 许可证                  | 数量 / 包                                                                        |
| ----------------------- | -------------------------------------------------------------------------------- |
| MIT                     | 19                                                                               |
| ISC                     | 18                                                                               |
| Apache-2.0              | 4（chevrotain、@chevrotain/{utils,gast,regexp-to-ast}）                          |
| BSD-3-Clause            | 2（d3-sankey、d3-ease）                                                          |
| (MPL-2.0 OR Apache-2.0) | 1（dompurify，选 Apache-2.0）                                                    |
| EPL-2.0                 | 1（elkjs 0.9.3，内嵌 `web-worker` 的 Apache-2.0 头 `Copyright 2020 Google LLC`） |
| license 字段缺失        | 1（khroma 2.1.0）                                                                |
| 现有遗漏，一并补齐      | Vue 系（`vue`、`@vue/*`）、`@sinclair/typebox`，以清单实测为准                   |

### 8.2 EPL-2.0 义务（elkjs 以压缩后的目标代码形式分发，未修改）

1. **§3.2(a) 源码获取**：随分发物附上声明——elkjs 的源码按 EPL-2.0 提供，获取途径是 `https://github.com/kieler/elkjs` 的 tag `0.9.3`；该版本构建自 Eclipse Layout Kernel 源码 `https://github.com/eclipse-elk/elk`（具体版本以 elkjs 发布说明为准，P1 核实后写入）。
2. **§3.2(b)**：elkjs 部分仍按 EPL-2.0 授权，不并入本项目的 MIT，也不限制接收者依 §3.2(a) 享有的源码权利。notices 中明确写出这一点。
3. **§3.3 保留通知**：不得删除程序中的版权与免责声明。压缩时这些注释被剥掉，因此：
   - (i) 在 ELK chunk 头部重新加横幅；
   - (ii) 在 THIRD_PARTY_NOTICES.md 的 elkjs 条目里逐字复制 `Copyright (c) 2017 Kiel University and others.`、`Copyright (c) 2021 Kiel University and others.`、`Copyright 2020 Google LLC` + Apache-2.0 声明，并附 EPL-2.0 全文。
4. **许可证全文**：THIRD_PARTY_NOTICES.md 内含 EPL-2.0 全文（取自 `node_modules/elkjs/LICENSE.md`）。
5. 本节是按 EPL-2.0 条文落实的工程做法，不构成法律意见。

### 8.3 ELK chunk 横幅（`generateBundle` 里前置）

```
/*! Contains elkjs 0.9.3 — SPDX-License-Identifier: EPL-2.0 — Copyright (c) 2017, 2021 Kiel University and others; includes web-worker, Copyright 2020 Google LLC (Apache-2.0). Unmodified, minified. Source: https://github.com/kieler/elkjs (tag 0.9.3). Full notices and license texts: THIRD_PARTY_NOTICES.md shipped with pi-toolkit. */
```

URL 落在现有允许列表 `^https://github.com/…` 之内，不用扩大白名单。版本号由插件从 `node_modules/elkjs/package.json` 读取，不写死。

### 8.4 THIRD_PARTY_NOTICES.md 与离线检查

- **新增生成器** `scripts/web-hub/gen-third-party-notices.ts`（开发工具，手动运行）：
  - 按 provenance 清单生成条目：`## <name>`、`- **Version**:`、`- **License**:`、包内 LICENSE 全文的 fenced block；
  - Apache-2.0 包如果带 NOTICE 文件，NOTICE 内容进条目；Apache-2.0 全文在附录里放一份；
  - EPL-2.0 条目附全文和 §8.2 的源码声明。
- **新增 `scripts/web-hub/third-party-overrides.json`**：处理缺失 license 字段的包，按 `name@version` 钉死，例如 `{"khroma@2.1.0": {"license":"MIT","evidence":"node_modules/khroma/license 全文为 MIT，<日期> <核实人>"}}`。版本一变就失效，必须重新人工核实。
- **check:web 的许可证门禁**（读 provenance + node_modules + notices）：
  1. 每个输出包都有对应条目，版本一致，SPDX 一致；
  2. SPDX 在白名单 {MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, (MPL-2.0 OR Apache-2.0), EPL-2.0} 内；
  3. `license: null` 必须命中 overrides；
  4. 包内 LICENSE 文件里所有含 `Copyright` 的行逐字出现在该条目中；
  5. 包内存在 `NOTICE` 时，其内容出现在条目中；
  6. ELK chunk 以 §8.3 的横幅开头。

### 8.5 三种分发物

| 分发物                             | 落实                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm 包                             | `files` 已包含 `THIRD_PARTY_NOTICES.md` 和 `LICENSE`；`dist/web-hub-ui/` 里的 ELK chunk 带横幅                                                                                                                                                                           |
| 总 zip（`package.sh`）             | 已复制 `THIRD_PARTY_NOTICES.md`、`LICENSE`。补测试断言 zip 内的 notices 含 `## elkjs` 和 `Eclipse Public License - v 2.0`                                                                                                                                                |
| 独立 UI zip（`package-web-ui.sh`） | 另外暂存 `web-hub-ui/<ver>.licenses/{THIRD_PARTY_NOTICES.md,LICENSE}`，放在受校验的 UI 根 `web-hub-ui/<ver>/` **之外**：hub 只按版本号精确查找 `<ver>/`，不扩大静态路径白名单，也不进 manifest。源文件缺失时脚本失败。`README` 的解压说明不变（`unzip -d ~/.pi/agent/`） |

---

## 9. 安全总结与不变量

1. 主文档阶段的资源加载由 §3 的 G1–G4 在请求前拒绝，G5 是显示阶段的纵深防御。CSP 是限域，不是兜底；stage 不是隔离边界。
2. 主文档执行脚本仍需同时绕过 DOMPurify（白名单 + strict 最终清洗）和 `script-src 'self'`。
3. 显示阶段：data SVG 放在 img 里，没有脚本、请求、交互和链接。残余风险：图框内可以画出以假乱真的界面，但出不了 img 边界。
4. 配置：secure 锁定，加上 §2.2 的作者配置范围检查（基于解码后的值）。
5. DoS：
   - 输入上限、`maxEdges`、触屏复杂度预算、串行队列、§4 的超时与熔断、可见性门控；
   - 主线程同步卡死无法抢占（ELK 大图在桌面上就要 2.45 s），属残余风险，由上限约束；
   - 图像位图内存由面积上限间接约束。
6. 不变量：
   - CSP 和 `hubCsp` 不改；不新增端点或网络请求；
   - mermaid 永不进首屏（check:web 第 4 条）；
   - source-scan 规则适用于所有新文件（无 `innerHTML`/`v-html`/`DOMParser`/rAF/`.onload=`）；
   - 不调用 mermaid 的 `bindFunctions`（不建 tooltip、不往 body 追加节点），probe 断言 body 的子节点在渲染前后不变。
7. **每次升级 mermaid 前**：查 GHSA；对 `new Image(`、`.html(`、`href`、`xlink:href`、`url(` 重做汇点 grep 审计并更新 §3.1 表；更新 `MERMAID_ALLOWED_TYPES`；重跑 `probe:mermaid`。

---

## 10. 测试计划

### 10.1 单元（vitest，node 环境）

- `tests/web-hub/ui/logic-mermaid.test.ts`：
  - `isMermaidFence`；预检边界（字符数、行数、触屏行数）；
  - G1 归一化：`url(`、`URL(`、`u\72 l(`、`u\rl(`、`\x75rl(`、`\u0075rl(`、`&#117;rl(`、`#117;rl(`、`url&lpar;`、`image-set("x" 1x)`、`-webkit-cross-fade(`、`url/**/(` 判为过近似拒绝；`getUrl(` 不拒绝；
  - `checkAuthorConfig`：§2.2 每条的接受/拒绝边界（含嵌套和数组）；
  - `svgToImage`：§5 的全部用例；
  - `mermaidConfig` 快照、`secure` 含默认六项、`dompurifyConfig` 快照；
  - `classifyMermaidError`；
  - `ByteBudgetLru` 的条数与码元预算、单条超限不入。
- `tests/web-hub/ui/mermaid-runtime.test.ts`：`vi.mock("…/mermaid-impl.js")` + fake timers。
  - 串行（同一时刻只有一个任务执行）；
  - 预先 abort（不加载、不建任务）；
  - 排队中 abort（移出队列，其它订阅者不受影响）；
  - 执行中 abort（照常写缓存，cancelled 不缓存）；
  - 同 key 合并（只调一次 impl，N 个订阅者各自结算）；
  - `MAX_QUEUE` 溢出 → `busy`；
  - `CALLER_DEADLINE`（加载慢或排队久）→ `timeout`，且不缓存；
  - `RENDER_TIMEOUT` → `timeout`，缓存，槽位直到底层 settle 才释放；
  - impl 永不 settle → 30 s 熔断，排队订阅者 drain 为 `engine-unavailable`，之后快速失败，缓存命中照常返回；
  - 加载失败 / 加载超时；
  - 晚到结果不写缓存；
  - 主题往返；
  - impl 抛非 Error 值；
  - 永不 reject、恰好 resolve 一次（property 测试：随机交错调用、abort、计时器推进）。

### 10.2 组件（happy-dom，mock `mermaid-runtime.js`）

`tests/web-hub/ui/mermaid-block.test.ts`：

- 流式中 `innerHTML` 与直接挂载 CodeBlock 完全相同；
- settled：先显示源码再切成 img（检查 width/height/alt）；缓存命中直接出图；
- 「源码 ⇄ 图」切换和 `aria-pressed`；
- 各类 error 回落源码并显示对应文案；数学错误显示 `mermaidMath`；
- 没有 IO 时立即请求；
- **代次**：text 改了以后，旧请求晚到的结果不生效；卸载后晚到的结果不生效；主题往返时后发先至的旧结果被丢弃；
- 卸载时 abort；img `@error` → `output-invalid`；
- **复制**：图视图 + clipboard 失败 → 切到源码、`nextTick`、选中，状态为「已选中」；`createRange` 不存在 → 状态为「复制失败，请手动选择」；
- 「原尺寸」按钮的出现条件。

既有测试补充：`markdown-view` / `preview-text` / `tool-card`：`js` 围栏仍是 CodeBlock，mermaid 围栏渲染成 MermaidBlock。`source-scan`、`i18n-parity` 自动覆盖新增内容。happy-dom 下绝不加载真 mermaid。

### 10.3 构建门禁的反例（`tests/web-hub/check-ui-dist-provenance.test.ts`，合成 bundle 和 HTML）

1. mermaid-impl 被入口静态引入 → 独占集为空 / `containsImpl` 的 chunk 不独占 → 失败。
2. HTML 有 modulepreload，入口静态链式引到某个 `mmd-` 文件 → 首屏递归能发现 → 失败（覆盖原 `classifyJsAssets` 的缺陷）。
3. 共享入口里动态 import 一个业务懒加载块，该块含 `style=` → 它不独占、没有豁免 → 失败。
4. 业务模块与 mermaid 共用 vendor，Rollup 把它和 `E` 模块合进同一 chunk → 插件报 mixed chunk（插件纯函数测试）。
5. 清单陈旧（某 js 的 sha 不匹配 / 少一条 / 多一条）→ 失败。
6. 文件名是 `mmd-` 但清单里不独占，或反过来 → 失败。
7. `packages` 含 `katex` → 失败。
8. 正例：合成的正确产物全部通过，`style=` 只在 `mmd-` 文件里被豁免。

另外 `tests/web-hub/ui/mermaid-provenance-plugin.test.ts` 用模拟的 `getModuleInfo` 图测 `E` 的计算（菱形依赖、循环、经共享模块的动态 import）。

### 10.4 真实浏览器门禁 `npm run probe:mermaid`

**实现方式**：`scripts/web-hub/csp-probe.ts --suite mermaid`，复用它的构建、静态服务器、真实 `CSP` 常量和 `lib/playwright.ts`。

- 服务器新增 `/probe-sink/*` 记录路由（返回 404，并记下路径）。
- `--lan` 绑定 0.0.0.0，供 S0 真机测试；会打印警告：只服务 probe 构建产物，无认证，仅限开发。
- 页面 `csp-probe/mermaid.ts` 引入生产的 `styles/tokens.css`、`styles/mermaid-stage.css`、`logic/mermaid.ts` 和真实的 `components/shared/mermaid-runtime.ts` → `mermaid-impl.ts`，把语料渲染成 `<img>`。

**用例组（Chromium + Firefox 全过才算通过）**：

- **R 渲染**：白名单里每种图类型至少一张（含用户的 subgraph + 中文 + `<br/>` flowchart、ELK 默认、`layout: dagre`），亮/暗主题各一遍。断言 outcome 为 ok，img 解码成功，`naturalWidth > 0`。journey 若解码失败，P1 修正后处理或把它移出白名单。
- **N 网络与 DOM 副作用**：
  - 资源语料：flowchart `@{img}` 和 YAML 转义写法、sequence `properties icon`、classDiagram/state/C4 的 `url()`/`image-set()` 各种转义写法、architecture `iconText <img>`、note/label 里的 `<img>`、`themeVariables` 与 frontmatter 中的 url、iconify 未注册图标；
  - 断言 `/probe-sink/` 命中数为 0；Playwright `request` 事件只允许 `/assets/*` 引擎块和页面自身；
  - stage 上的 MutationObserver 从未见到 img/image/video/audio/source/iframe/object/embed/use[href^≠#] 节点；
  - `document.body` 的子节点在渲染前后集合不变；
  - 除 `style-src-*` 外没有其他 CSP 违规（特别是 `script-src`、`img-src`、`worker-src`）；`gateBreach === 0`。
- **C 有效配置**：`%%{init}%%` 和 frontmatter 尝试 `htmlLabels:true`、`themeCSS`、`dompurifyConfig`、`securityLevel:loose`、`themeVariables.fontSize`、`flowchart.htmlLabels`。渲染后读 `mermaid.mermaidAPI.getConfig()`（probe 专用钩子），断言生效值仍是站点值；输出无 foreignObject（architecture `iconText` 除外，它会解码）。§2.2 的拒绝项得到 `unsupported`。
- **F 字体与测量**：用生产 `--font-sans` 渲染 flowchart、sequence、state、class 的长中英文标签。把同一份 SVG 通过 probe 服务器的无 CSP 路由 `/probe-svg/<n>` 内联渲染（与 img 内部一样样式全部生效），检查每个 `text`/`tspan` 的 bbox 落在所属节点的 shape bbox 内，容差 2 px。
- **M 数学**：flowchart、sequence、class、state、er 各含 `$$x^2$$`。记录 outcome 并与冻结的期望表比对（flowchart 为 ok 并显示字面文本，sequence 为 `unsupported`，其余以实测为准写入表）。
- **L 限额**：超长文本 → `too-large`（不加载引擎）；500 边链状图记录耗时；模拟触屏下 201 边 → `too-large`；巨大 viewBox（通过 mock 输出）→ `output-invalid`。
- **记录**（不设阈值，写入报告）：首张 flowchart / sequence 加载了哪些块、多少 gzip 字节、冷/热渲染耗时、预解析开销。

**门禁定位**：需要浏览器，不进 CI。**P1 合入前、P2 合入前、升级 mermaid 或 vite 前必须跑**，verifier 把报告附到包报告里。

### 10.5 发布与 hub 测试

- `tests/release/web-ui-zip.test.ts`：zip 条目包含 `web-hub-ui/1.2.3.licenses/THIRD_PARTY_NOTICES.md`；条目判定放宽为 `web-hub-ui/1.2.3/…` 或 `web-hub-ui/1.2.3.licenses/…`；notices 源文件缺失时脚本失败。
- `tests/release/package-zip.test.ts`：总 zip 内的 notices 含 `## elkjs` 和 EPL-2.0 全文标题。
- `tests/web-hub/hub/ui-root.test.ts:427–444`：硬编码的 65 改为 `UI_MAX_FILES + 1`。新增：恰好 `UI_MAX_FILES` 个文件且字节合法时接受；字节恰好等于 `UI_MAX_TOTAL_BYTES` 时接受、超 1 字节拒绝。
- `tests/web-hub/hub/static*.test.ts`：verify 返回 `too-large` 时服务 200 占位页，loopback 能看到原因（即同版本重新部署的降级行为）。已有覆盖就确认并引用，没有就补。
- `ui-manifest.test.ts` 引用常量，自动跟随。

---

## 11. 验收清单（写入 `docs/dev/web-hub-mermaid/acceptance.md`）

- **设备**：桌面 Chrome/Firefox；iPhone Safari（记录型号和 iOS 版本）；Android Chrome（记录型号）。每台都测亮、暗主题，并分别走 loopback 和 LAN 明文 http。
- **样本**：「用户 flowchart」= `csp-probe/mermaid.ts` 语料中的 `user-flow`。
- **冷/热定义**：冷 = 页面刷新后首次渲染（含引擎块加载）；热 = 引擎已加载、缓存未命中。

1. 用户 flowchart：标题与节点不重叠，文字不截断（目视，附截图）。
2. sequence（含 `<br/>` 和 Note）、state、class、er、gantt（宽图）、pie、gitGraph、mindmap、architecture、C4 各一张：ok 并正确显示。
3. **耗时**（从消息 settle 到 img `decode` 完成，同屏只有这一张图，不排队）：

   | 设备          | 冷                                  | 热      |
   | ------------- | ----------------------------------- | ------- |
   | 桌面 loopback | ≤ 3 s                               | ≤ 1.5 s |
   | 手机 LAN      | ≤ 8 s（超出记录但不阻塞，转风险项） | ≤ 4 s   |

   有排队时不考核单图时延，只要求不超过 `CALLER_DEADLINE`。

4. **缓存语义**：
   - 同一页面里切换会话再切回（keepalive 内、条目未被淘汰）→ 直接出图，不闪源码；
   - **页面刷新后会重新渲染**（内存缓存，属预期）；
   - 第 49 张不同的图挂载后，最早那张再挂载时重新渲染（淘汰，属预期）。
5. **回落**：
   - 写错语法 → 源码加简短错误；超大输入 → 「图表过大」；
   - sequence 含 `$$…$$` → 源码加「含数学公式（未支持）」；flowchart 含 `$$…$$` → 出图，公式按字面文本显示（D2，如实）；
   - 白名单之外的图类型 → 源码加「暂不支持此图类型」；
   - 含 `@{img}` / `url(` → 源码加「含资源引用，已显示源码」。
6. 设置里切换亮/暗主题，图在 ≤2 s 内（热）随之重新渲染；来回切换 3 次后显示的始终是当前主题。
7. **阅读锚点**：把锚点消息固定在视口顶部，上方 3 张图分别完成渲染、主题重渲染、源码/图切换时，测锚点 `getBoundingClientRect().top` 的漂移：

   | 浏览器             | 容差                                              |
   | ------------------ | ------------------------------------------------- |
   | Chromium / Firefox | 每次 ≤ 8 px                                       |
   | iOS Safari         | ≤ 24 px；超出则记为已知风险并开 issue，不阻塞首版 |

   文件预览的分段提交场景同样测量。

8. 「源码 ⇄ 图」切换；复制（LAN http 下：自动切到源码并选中）；宽图「原尺寸」横向滚动；手机双指缩放。
9. 文件预览打开含 mermaid 的 `.md`：渲染模式出图，切到源码模式恢复原文。
10. **同屏 10 张图**（语料 `ten-pack`）：手机上页面在 30 s 内全部结算（ok 或 error），无白屏、无标签页崩溃；控制台没有 `script-src` 违规；DevTools 网络面板只有 `/assets/` 请求。
11. **iOS**：任何一项出现结构性失败（解码失败、字体严重错位），处置是回落源码，在 acceptance 里记录，另立项评审附录 A，不阻塞桌面和 Android 发布。
12. 同版本重新部署：开发期重新 `build:web` 后，未重启 hub 时看到占位页，`/webhub restart` 后恢复。

---

## 12. 拆包

| 包                              | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 依赖                                | 合入门禁                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 引擎、防线、构建与许可证** | `package.json`/lock（mermaid 12.2.0 精确锁定，script `probe:mermaid`）、`src/web-hub/ui/vite.config.ts`、`ui/mermaid-provenance-plugin.ts`、`ui/src/vendor-stubs/katex.ts`、`logic/mermaid.ts`、`components/shared/mermaid-{runtime,impl}.ts`、`styles/mermaid-stage.css`、`csp-probe/mermaid.{html,ts}`、`scripts/web-hub/{check-ui-dist.ts,csp-probe.ts,lib/ui-provenance.ts,gen-third-party-notices.ts,third-party-overrides.json}`、`protocol/ui-manifest.ts`、`THIRD_PARTY_NOTICES.md`、`scripts/release/package-web-ui.sh`、`.github/workflows/ci.yml`（新增 Node 22.12.0 job：`npm ci && npm run build:web && npm run check:web`）、`AGENTS.md`（Commands 加一行：web 工具链需 Node ≥22.12）、§10.1/10.3/10.5 的测试 | 无                                  | typecheck / test / build:web / check:web 全绿，外加 **probe:mermaid 的 R/N/C/F/M/L 组在 Chromium + Firefox 全过**（即 S0 桌面部分）。S0 真机：P1 合入后立即用 `--lan` 跑一轮，结果写入 acceptance |
| **P2 组件与接线**               | `MermaidBlock.vue`、`MdBlock.vue`、`styles/mermaid.css`、`useEffectiveDark.ts`、`contracts.ts`、`i18n/{zh,en}/transcript.ts`、`previewContext.ts`（注释）、§10.2 的测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 只依赖 §4 的冻结接口（测试中 mock） | 组件测试，外加在 P1 已合入的分支上重跑一遍 probe:mermaid（确认接线后仍过）                                                                                                                        |
| **P3 验收**                     | `docs/dev/web-hub-mermaid/acceptance.md`，按 §11 执行真机验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | P1 + P2                             | 用户真机确认                                                                                                                                                                                      |

- P1 与 P2 文件域不重叠，可以并行；`vite.config.ts` 只由 P1 修改。
- 规模估计：P1 约 1 100 行（含测试，归属/许可证/防线占大头），P2 约 450 行，P3 只有文档。
- 车道 L2。P1 涉及 hub 协议常量、安全门禁和许可证，验收从严：verifier 模型不同于开发模型，并须附 probe 报告。

---

## 13. 风险与明确不做

### 13.1 风险

1. **iOS 未实测**：SVG-in-img 的字体、内存和锚点表现未知。由 §11 第 7、11 项把关，失败就回落源码。
2. **ELK 体积与耗时**：首张 flowchart 约 650 KB gzip；大图在主线程同步布局（桌面最长 2.45 s，手机估计 3–5 倍）。由触屏复杂度预算、`RENDER_TIMEOUT` 和熔断缓解，主线程卡顿无法抢占。
3. **G1 的过近似误伤**：字面写着 `url(` 的标签会显示源码。§2.2 的字体配置拒绝也可能误伤少量作者配置。
4. **预解析的残余假设**：预解析与 render 对同一字符串的解析结果相同（语法与运行时配置无关）；probe 用带指令的变体覆盖。
5. **升级脆弱性**：新的资源汇点、新图类型、KaTeX 的 import 形态、`getDiagramFromText`/`parse` 的 API 变化。由白名单、§9 第 7 条的审计流程和 probe 守护。
6. **体积与 hub**：协议常量上调；hub 组装时多约 112 ms gzip、多约 6.3 MB 内存；npm 包压缩后多约 1.4 MB。
7. **测量偏差**：classDef/style 里自定义的字号在测量阶段被 CSP 拦掉，可能截断文字（已知限制）。站点默认的字体变体以 probe F 组为准。
8. **控制台噪声**：每页上百条 `style-src` 违规报告，功能无害。
9. **同版本重新部署需要重启 hub**（§7.5）。

### 13.2 明确不做

- 流式过程中渲染；
- click、tooltip、链接跳转等交互；
- 平移缩放查看器、导出 PNG/SVG；
- KaTeX 数学（D2）；
- fontawesome/iconify 外部图标；
- 白名单之外的图类型；
- TxUser、ThinkingBlock、HTML 预览 `/pv` 内的 mermaid；
- 改 CSP、改 `markdown.js`、服务端渲染、把 mermaid 配置暴露为用户设置；
- **iframe 渲染退路**（附录 A，另立项）。

---

## 附录 A：iframe 渲染备忘（不在首版范围，另立项时须评审）

r1 的 (b)「同源专用文档渲染后 postMessage 回传 SVG」不能作为 S0 失败后的自动退路。另立项时至少要评审这些点：

1. **framing**：hub 现在对所有文档发 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`（`src/web-hub/hub/http.ts:383–387`），专用文档需要单独的头策略（`frame-ancestors 'self'`、去掉 XFO），并证明不影响其它路径。
2. **CSP**：专用文档的完整 CSP（`style-src 'self' 'unsafe-inline'` 只限该文档；`script-src 'self'`；`img-src`/`connect-src` 尽量收紧，最好为 `'none'`，避免主文档阶段那样的资源加载问题在这里重演）。
3. **sandbox**：`allow-scripts allow-same-origin` 能加载同源模块，但**不提供**可靠的同源脚本隔离；不带 `allow-same-origin` 的 opaque origin 又需要 hub 发 ACAO。两条路各自的取舍要明确。
4. **认证**：专用文档的 cookie/LAN 认证、对 `/api/*` 的可达性、HTML 预览 capability 的类比（不变量 I1–I4）。
5. **消息协议**：origin 校验、`event.source` 校验、请求 id 和 nonce、大小上限、超时、结果仍要经过 `svgToImage` 受限解析。
6. 成本：用户需要重启 hub，每页多一个文档的内存，`TOP_LEVEL_ALLOW` 加文件，`static.ts` 对单路径换头。

## 附录 B：r2 spike 摘要

| 项                                                 | 数值或结论                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 构建（ELK 保留、KaTeX stub、`legalComments:none`） | mermaid 闭包 61 个文件，4,885,370 B raw，约 1.41 MB gzip；最大块 ELK 1,476,025 B / 约 450 KB gzip                                 |
| 归属插件（r3）                                     | 61 个 `mmd-*` 独占 chunk；`shared.js`（app 与 impl 共用）正确落入入口 chunk；业务懒加载块不带 `mmd-` 前缀；无混合 chunk           |
| 首次加载（Chromium，资源计时）                     | flowchart 10 个块，约 487 KB gzip（不含 core）；state 8 个块，约 480 KB；sequence 3 个块，约 33 KB；core 约 166 KB                |
| 渲染耗时（桌面，Chromium / Firefox）               | 用户 flowchart 347 / 494 ms（含 ELK 首载）；500 边链 2454 / 2474 ms；60 节点 480 边 1233 / 1369 ms；20 个 subgraph 1111 / 1156 ms |
| 资源请求（不设防线）                               | Chromium：flowimg、flowimgesc、seqicon、classfill.svg；Firefox：前三者                                                            |
| 资源请求（G2 预解析 + G3 白名单）                  | 两种浏览器都只剩 classDiagram 的 `fill:url()`（由 G1 词法预检覆盖），其余为 0                                                     |
| DOMPurify 白名单                                   | 22 种图类型渲染正常；architecture `iconText <img>` 零请求                                                                         |
| 数学                                               | flowchart 正常（按文本）；sequence 整图失败                                                                                       |
| hub 组装 gzip                                      | 61 个块共约 112 ms                                                                                                                |

---

## 仍需用户拍板

以下三点方案已按推荐项写死。用户不同意时，只需改对应常量或白名单，不影响架构：

1. **图类型白名单范围**（§3.2 的 G4）：推荐首版只放行 22 类常见图；eventmodeling、usecase、cynefin、wardley、venn、ishikawa、railroad 系、swimlanes 等显示源码。另一选项是全部放行，但这些类型没有经过汇点审计，其中 eventmodeling 存在 `.html()` 拼接路径。
2. **触屏复杂度预算**（§2.4）：推荐 flowchart 边数 200、行数 800，超出显示源码以免手机冻屏。另一选项是与桌面一致（500 边、2000 行），但大图可能卡住页面 10 s 左右后超时。
3. **EPL 源码获取方式**（§8.2）：推荐在 notices 和横幅里指向上游精确 tag（`kieler/elkjs@0.9.3` 及对应的 ELK 源码）。另一选项是每次发版额外把 elkjs/ELK 源码归档作为 release 附件，更稳妥，但发版成本更高。

---

## r3 主会话裁定（2026-10-21，评审收敛规则：两轮打回后主会话逐条分诊，不再开第三轮评审）

复审意见原文：`review-r2.md`。以下裁定**优先于正文**，开发与验收以此为准。

| 编号         | 裁定                   | 落实要求（开发必须照做）                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-1 Blocker | **必须修**             | §4 冻结契约改为：每个订阅者有自己的绝对期限 `deadline = t0 + CALLER_DEADLINE_MS(30s)`，**开始执行后仍然有效**；订阅者在 `min(deadline, start + EXEC_TIMEOUT_MS(8s))` 较早者到期时以 `timeout` 结算。单个订阅者到期不影响其他订阅者、不释放底层占槽、**不写 timeout 缓存**（只有任务级执行超时才缓存）。发布结果前用单调时钟复核期限。时间保证仅指「事件循环可调度时」，不承诺抢占同步布局。补测试：第 29s 才开始执行、不同加入时刻的合并订阅者。 |
| R2-2 Major   | **必须修**             | 归属清单枚举 dist 磁盘上**全部** `.js`：`public/` 原样复制的文件（现有 `theme-init.js`）记为 `exclusive:false, containsImpl:false, packages:[]` 并绑定 sha256，照常接受普通扫描；不得放宽为「未记录文件跳过」。加带真实 `theme-init.js` 的正例测试。修正 §7.2 中「静态引入 impl 会使 E 为空」的说明（靠 mixed/首屏断言发现）。                                                                                                                   |
| R2-3 Major   | **必须修**             | 增加**布局白名单**：仅 `elk`、`dagre`。检查全局与各图类型小节的有效 `layout`，其余在 render 前拒绝（回落源码，reason `parse`）。补「白名单图类型 + 非白名单布局（如 swimlane）」反例。                                                                                                                                                                                                                                                           |
| R2-4 Major   | **修，取最简方案**     | 作者配置里**禁止覆盖布局计算参数**（`numIter` 及各布局的迭代/尺寸类数值键，按 mermaid 12.2.0 实际键名列表钉死），出现即拒绝。flowchart 再加**顶点数上限**（桌面 1000 / 触屏 400）。边数/行数/顶点数上限如实表述为「常见情形的保护」，同步布局无法抢占仍列为已知风险。                                                                                                                                                                            |
| R2-5 Major   | **必须修（最小修订）** | G2 拒绝会读取主文档状态的语法：sequence `details` 指令（以及审计中发现的同类 `getElementById`/`document.*` 读取路径）。删除「语法与运行时配置无关、同字符串必然等价」的表述，改为：三次解析使用同一份站点配置 + 同一作者配置，且校验 `detectType` 结果与实际渲染类型一致，不一致即拒绝。DOM 审计区分引擎允许的临时节点（如 architecture 的 `#cy`）与非预期副作用。                                                                               |
| R2-6 Major   | **缩范围**             | 首版图类型白名单**移除 `architecture`**（22 → 21 类），它显示源码；G3 白名单保持严格，不为内置图标开放 SVG 图元。probe 的 F 组断言区分节点标签与边标签（sequence 消息、flowchart 边标签不要求落在 shape 内）。architecture 图标支持另立项（需审计过的无资源 SVG 图元白名单）。                                                                                                                                                                   |
| R2-7 Major   | **必须修**             | 新增 `src/web-hub/ui/vendored-bundled.json`：按外层包「名称@版本 + 产物文件 sha256」钉住的预打包组件补充清单，首批至少 `fastdom@1.0.12`、`js-yaml@4.3.0`、`@mermaid-js/parser` 内的 langium/vscode 系（开发时用 grep 版权头实际枚举）。每项保留版权行、完整许可证文本与适用 NOTICE；外层包版本或摘要变化时 check:web 失败、强制复核。三种分发物的声明由「模块清单 ∪ 补充清单」生成。§8.2 的引用改为 EPL **§3.1(a)**。                            |
| R2-8 Minor   | **修**                 | 横幅改在参与 chunk hash 的阶段加入，或用 `augmentChunkHash` 把横幅内容计入 hash；补「仅横幅变化 ⇒ 文件名变化」测试。                                                                                                                                                                                                                                                                                                                             |

用户补充拍板（同日）：首版图类型白名单（R2-6 后为 21 类）；触屏复杂度预算 200 边 / 800 行（R2-4 另加顶点数）；EPL 源码获取指向上游精确 tag `kieler/elkjs@0.9.3`（已核实存在）。

**范围外、不再要求**：无。所有条目均在既定威胁模型内，按上表修；不开第三轮评审，由主会话在开发验收时核对闭合。

### r3 补充（demo 实测发现，2026-10-21，`/tmp/mmd-demo`）

- **不要在站点配置里全局钉 `layout:"elk"`**：mermaid 12.2.0 全局 `layout:"elk"` 会让 mindmap 崩溃（`Cannot read properties of null (reading 're')`）。12.x 默认布局本就是 ELK，站点配置省略该键；R2-3 的布局白名单只做「作者给出的 layout 必须 ∈ {elk, dagre}」的拒绝检查，不向配置注入 layout。probe F 组加 mindmap 用例守住。
- **并发 render 必崩**（`firstChild of null`），§4 单槽串行队列是硬要求，不是优化。

### r3 补充二（跨方案依赖，来自预览多窗方案复审 #13，2026-10-21）

- 预览窗口可缩放（`docs/dev/web-hub-preview-windows/plan.md` §13），所以 MermaidBlock 的「原尺寸 ⇄ 适应宽度」按钮不能只在渲染时比较一次 naturalWidth：P2 必须对 `.mmd-figure` 容器挂 **ResizeObserver**，容器宽度变化时重新判定按钮是否出现（卸载时 disconnect）。补组件测试（模拟容器缩窄/放宽）与联合验收：在可缩放的预览窗口里打开含宽图的 `.md`，拖窄、拖宽窗口，按钮随之出现/消失。
