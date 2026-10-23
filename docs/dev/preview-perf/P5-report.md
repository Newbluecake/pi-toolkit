# preview-perf P5 实施报告 — Worker 高亮（闸门放宽）+ immediate 尺寸闸门

- 日期：2026-10-23 · 分支 dev · 方案：`plan.md` r3（§0 已拍板 ①、§5.3、§6.1/§6.3、§8.1 P5 行）+ 主会话追加的 immediate 尺寸拍板（见 §6）
- 依赖（已提交）：P1a 冻结接口 `3c0cdeb88` · P1 纯逻辑 + HighlightSpans 编解码 `a229c3d4` · PB 探针 `edb8639a` · P3 接线 `8ab06bb4`
- 交付：虚拟源码视图的高亮闸门由 **Worker** 兑现放宽（256 KiB / 行数不限 / 80k token，`flattenTokens` 的预算在 Worker 内执行）；Worker 不可用 / 超时 / 出错一律回落 §5.1 原闸门（100 KiB / 3000 行 / 20k）主线程空闲分词，绝不阻塞、绝不白屏。生产 CSP（`script-src 'self'`，无 `worker-src` ⇒ 规范回落到 `script-src`）经真实构建 + 真实 CSP 头 + Chromium/Firefox 实测放行同源 module worker，**CSP 零放宽**。

## 1. 文件清单（全部在 P5 独占域内）

| 文件                                                              | 改动                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/shared/highlight-worker.ts`        | **新建**：Worker 入口。全篇 `Prism.tokenize` + `flattenTokens({maxTokens: 80_000})` + `encodeHighlightSpans` 都在 Worker 内执行；结果以 `Uint32Array` 三元组 + 类表回传（buffer **transfer**，主线程零拷贝）。导出纯函数 `computeWorkerReplyWith(Prism, msg)`（引擎注入，测试同步驱动）；消息胶水守卫式注册（node/vitest 下无 `self.postMessage` 则不注册） |
| `src/web-hub/ui/src/components/shared/highlight-worker-client.ts` | **新建**：主线程客户端。懒创建、进程内全局复用一个 Worker（`getHighlightWorkerClient()` 单例）；每请求带单调 id + 3 s 截止；协议常量 `HIGHLIGHT_WORKER_MAX_BYTES = 256 KiB`、`HIGHLIGHT_WORKER_TIMEOUT_MS = 3_000`；结局四态 `spans / plain / fallback / cancelled`                                                                                         |
| `src/web-hub/ui/src/components/shared/highlight-core.ts`          | 虚拟入口（P5 行）：`createVirtualHighlighter(deps)`——P3 内联在 PreviewText 的 §5.1 编排整体迁入并加 Worker 腿。另含追加拍板的 `PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES/BYTES` + `isImmediateHighlightSize()`（§6）                                                                                                                                            |
| `src/web-hub/ui/src/components/preview/PreviewText.vue`           | 最小改动：删除 P3 的 §5.1 内联块（epoch/调度/apply 六十余行），换成 `createVirtualHighlighter` 依赖注入（text/lang/active/apply/busy）；`NumberedCode`/`HighlightedCode` 的 `immediate` 从字面量改为 `immediateHl` computed（§6）                                                                                                                           |
| `src/web-hub/ui/vite.config.ts`                                   | `worker: { format: "es" }` 一行 + 注释（§4：Worker 入口需要动态引擎 import，iife 格式装不下；输出仍是 `assets/<name>-<hash>.js`，清单/预算自动覆盖）                                                                                                                                                                                                        |
| `src/web-hub/ui/csp-probe/Probe.vue` + `probe.css`                | worker 用例：页面驱动**真实** `highlight-worker-client`（真实 module worker 分块、真实 transfer 回传），把结局发布到 `window.__PWH_WORKER_RESULT__`；仅当回传 spans 能 `decodeHighlightSpans` 解出 `tok-keyword` 才记 `spans-ok`                                                                                                                            |
| `scripts/web-hub/csp-probe.ts`                                    | ① 正向套件（Chromium）加 worker 断言（放在 violations 读取**之前**，CSP 拒绝会同时以 `fallback` + 违规记录两路暴露）；② 新增 **Firefox** 通道（worker 用例 + 零违规），Firefox 现为 probe:csp 硬要求（缺缓存构建 ⇒ exit 2，与 mermaid 套件同语义）；③ 全部 `waitForFunction` 由字符串谓词改为函数谓词（§5 的坑）                                            |
| 测试                                                              | 新建 `highlight-worker.test.ts`（归约：真实 Prism、跨行语法状态、80k 预算、畸形消息）、`highlight-worker-client.test.ts`（协议/取消/超时重建/粘滞四种入口/垃圾回复）、`highlight-worker-virtual.test.ts`（highlighter：放宽闸门、epoch 作废、dispose、回落原闸门、busy 规避）、`highlight-worker-immediate.test.ts`（§6 拍板）                              |

**未动**：P1/P2/P3 的文件（`previewLineIndex/previewVirtual/VirtualCode/CodeLines` 等）、`previewVirtualTypes.ts`（冻结接口零改动）、`highlight-impl.ts`/`prism-global.ts`、transcript 的 CodeBlock、任何 i18n 文案、`package.json`。

## 2. 行为规格（对照方案 §5.3 逐条）

- **闸门**：虚拟体调度时先过 `shouldHighlight(text, { maxBytes: 256 KiB, maxLines: Infinity })`。该闸门严格宽于 §5.1（100 KiB/3000 行），**在此被拒的文本回落路径也必拒**——直接纯文本，不发 Worker 请求。流式仍不高亮（§5.3 原文）。`PREVIEW_VLINE_MAX_PARTS`（单行 >1000 part 纯文本显示）是 P1 已实现的 displayLine 行为，本包不碰。
- **Worker 路径**：请求 `postMessage({kind:"tokenize", id, text, lang})`（结构化克隆）；Worker 内整篇 tokenize（跨行语法状态完整，测试钉了多行模板字符串是**一个跨 "\n" 的 span**）、80k 预算 flatten、编码、回传 `{kind:"spans", classes, spans}` 且 transfer `spans.buffer`。主线程收到后 `setHighlight` → 只重绘已挂载块（P2 契约）。Worker 路径**不加载主线程 Prism**（引擎只在 Worker 分块里跑），打开大文件的页面不再为高亮拉主线程引擎分块。
- **超时（非粘滞）**：每请求 3 s 截止。超时 ⇒ `terminate()` + 下次请求**惰性重建**（`unavailable` 仍为 false）；被终止的共享 Worker 上所有 pending 一并 `fallback`。
- **粘滞不可用**：`new Worker` 构造抛错、Worker `error` 事件（脚本加载失败 / CSP 拒绝 / Worker 内未捕获错误）、`messageerror` ⇒ 进程内永久 `fallback`（K10：企业策略/扩展拦截 ⇒ 回到 P3 行为）。
- **回落路径 = §5.1 逐字**：`loadPrism()` → `requestIdleCallback`（缺省 `setTimeout 50ms`，timeout 500）→ 手势（`body.pwh-pw-dragging`）或 150 ms 内有 scroll 则重排队 → **原闸门** `shouldHighlight(text)` → 主线程 tokenize → `setHighlight`。超时回落的文件同样走这条（§5 详述与方案原文的调和）。
- **epoch 作废**：每次 `schedule()` 自增内部 epoch（文本变化/重试/视图切换都经由它）；旧请求的回传在 then 里按 epoch 丢弃。
- **窗口关闭终止任务**：`dispose()`（unmount）取消在途 Worker 请求（id 摘除，迟到回执静默丢弃）并取消 idle 排队；Worker 内已在跑的分词不可中断，但其结果必被丢弃，且受 3 s 截止兜底。共享 Worker 本身**不**因单窗关闭而终止（全局复用是方案要求）。
- **不进首屏包**：Worker 入口 + 其引擎分块均为 lazy 资产（`check:web` lazy 口径实测 75,765B gz / 128 KiB 预算，含 Worker 侧第二份 Prism ~21KB gz——方案已预告）。

## 3. 与方案原文的偏离 / 内部化决策（逐条）

1. **「超时 ⇒ 该文件保持纯文本」vs 任务简报「超时 ⇒ 回落旧闸门主线程」**：实现取任务简报口径——超时后一律进入 §5.1 回落路径；对超闸门文件（>100 KiB，超时最常见的原因）该路径自然拒绝 ⇒ 纯文本，与方案原文在实际上完全一致；仅「≤100 KiB 但 Worker 超时」的罕见情形会晚一点在主线程补上高亮（更符合「绝不白屏/不丢能力」的总要求）。粘滞不可用则无条件回落（方案原文）。
2. **Worker 的引擎改为动态 import（引出 vite `worker.format:"es"`）**：这不是风格选择，是 **prismjs 的硬约束**——prism 核心在求值时注册自己的 legacy「worker 内高亮」`self` message 监听器（`prism.js:1154`），它对**每条**进来的消息做 `JSON.parse(evt.data)`；我们的对象协议会让它抛未捕获 `SyntaxError`，该错误以 Worker `error` 事件浮上主线程，正好撞上「error ⇒ 粘滞不可用」的回落规则（首次 probe:csp 实测即如此：worker 正常回了 spans，但 error 事件先到）。唯一关闭办法是让 `_self.Prism.disableWorkerMessageHandler` 在 prism 核心**求值之前**就存在（`prism.js:78` 读的是预置全局），因此引擎不能静态 import（静态导入先于模块体求值）——入口模块顶部播种该全局，引擎在消息处理器内 `import()` 惰性加载（无 top-level await：构建 target 是 es2020）。副产物：Worker 入口分块只有胶水+编解码（~2KB），Prism 落在 Worker 自己的 lazy 引擎分块里。
3. **probe:csp 的 `waitForFunction` 全部改函数谓词**：字符串谓词在「条件第一次求值时尚未成立」需要轮询时，Playwright 会在页面内 `eval` 谓词字符串——被生产 CSP（无 `unsafe-eval`）拒绝（EvalError）。这是预先存在的地雷（旧调用一直靠「标志位恰好已置位」侥幸通过，Firefox 慢启动一撞就爆）；worker 用例必然需要轮询，顺手把全部 5 处改为函数谓词（CDP `callFunctionOn` 序列化，不受 CSP 管）。行为零变化。
4. **probe:csp 新增 Firefox 硬要求**：方案 §5.3 要求 worker 用例「Chromium 和 Firefox 都要实测通过」；本机有缓存的 Firefox（1543），按 mermaid 套件先例缺缓存 ⇒ exit 2。
5. **Worker 引擎分块加载失败**（如 404）：Worker 不死，每个格式合法的请求直接回 `plain`（文件纯文本）；不制造 3 s 超时-终止-重建循环。这是内部化决策，登记为残留。
6. **`highlight-worker.test.ts` 驱动的是 `computeWorkerReplyWith(Prism, msg)`（引擎注入）**而非模块级单例路径：胶水本身由 csp-probe 在真实浏览器驱动（更强的证据），单测覆盖纯归约。

## 4. vite 配置改动（任务允许的「最小改动」）

`worker: { format: "es" }` 一行 + 注释。原因见 §3.2：Worker 入口需要动态引擎 import，Vite 默认 `worker.format: "iife"` 不支持代码分割。输出验证：`assets/highlight-worker-<hash>.js`（入口）+ `assets/highlight-impl-<hash>.js`（Worker 侧引擎分块），均满足 `ui-manifest.ts` 的 `ASSET_RE` 与 ≥8 位哈希规则，`build-info-plugin` 自动收录进清单（84 个文件），hub `verifyUiRoot` 通过（check:web 末步）。

## 5. csp-probe worker 用例（方案前置核对，实测结论）

- **页面**（`Probe.vue`）：onMounted 用**真实单例客户端**请求一段 TypeScript 样本；`spans-ok` 要求：Worker 在生产 CSP 下成功构造（module、同源）、脚本加载并执行、tokenize、transfer 回传，且 `decodeHighlightSpans` 在全文窗口解出含 `tok-keyword` 的 part。其余结局（`fallback`/`plain`/`spans-bad`）一律失败并把状态串写进断言 detail。
- **runner**：正向套件先等 worker 结局再读违规清单（被 CSP 拒绝会同时表现为 `fallback` + `script-src`/`worker-src` 违规记录）；Firefox 通道独立加载同一页面，断言 `spans-ok` + 零违规。
- **实测**（2026-10-23，Chromium 1243 + Firefox 1543，均 headless，真实 `CSP` 头自 `hub/http.ts`）：**PASS**——`P5 worker: module worker + HighlightSpans transfer OK under the production CSP (Chromium + Firefox)`。种子修复前同套件稳定复现 `worker outcome: fallback`（§3.2 的 error 事件路径），修复后两引擎一致通过。

## 6. 追加拍板：`immediate` 只给小文件（首帧前高亮尺寸闸门）

- **依据**（主会话转达的用户拍板 2026-10-23 + `PB-report.md` §7.3）：§5.2 的 `immediate` 把闸门内文件的分词搬进首帧后，hl-600（600 行 / 22.6 KB）warm open **64.6→97.6 ms** 稳定回归；行号关 / 完整视图下 2292 行 body **113→247 ms**。
- **实现**：`highlight-core.ts` 导出 `PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES = 200`、`PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES = 8 KiB`（UTF-8 字节，与 `shouldHighlight` 同一套记账：代理对 4、孤立代理 3）与谓词 `isImmediateHighlightSize(text)`（先以 UTF-16 单元数短路，再数行、再精确字节，全部早退，大文件零全扫）。`PreviewText` 的 `immediateHl` computed 只在谓词为真时给 `NumberedCode` / `HighlightedCode` 传 `immediate`；超出的闸门内文件回到「纯文本首帧 + 150 ms 去抖后高亮到达」（§5.2 之前的原行为）。**transcript CodeBlock 不传 immediate，契约不变**；**Worker 路径零交集**——虚拟体（>600 行/流式）从来不走这两个组件，其高亮由 Worker/§5.1 回落负责（测试 `highlight-worker-immediate.test.ts` 钉了正交性：650 行 ⇒ `pre.pv-virtual`，与 `immediate` 无关）。
- **测试**：谓词边界（200/201 行、8 KiB±1 字节、CJK/代理对按字节计）；组件级：小文件首帧即高亮（同步断言）、>200 行首帧纯文本后到达（NumberedCode 与行号关两条路径）、>600 行进虚拟路径不受影响。

## 7. 自验（2026-10-23，本机）

| 命令                                             | 结果                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/web-hub/ui --maxWorkers=2` | **5589/5589 通过**（248 文件；其中本包新增 38 例，其余为存量回归——含 P3 的 §5.1 空闲高亮用例，在 happy-dom（无 `Worker` ⇒ 粘滞回落）下继续覆盖回落路径）                                                                                                                                              |
| `npm run typecheck`                              | **通过，零输出**（本次运行未出现 src/traffic 并行包报错，无忽略项；`scripts/` 不在任何 tsconfig include 内——预先存在的缺口——我的 runner 改动另以独立 `tsc --noEmit` 严格档通过）                                                                                                                      |
| `npm run build:web && npm run check:web`         | **通过**（84 files；first-screen JS 346,062B gz / 512KiB——比 P3 实测 +≈1.0 KiB gz（客户端+highlighter+尺寸闸门），远低于方案预估 +8~10 KiB 的余量；lazy JS 75,765B gz / 128KiB（含 Worker 入口 + Worker 侧 Prism 副本）；CSS 35,126B / 64KiB 不变；manifest 含两个 worker 资产，`verifyUiRoot` 通过） |
| `npm run probe:csp`                              | **PASS**（Chromium + Firefox；§5）                                                                                                                                                                                                                                                                    |
| `npx prettier --check`（本包全部触碰文件）       | **通过**                                                                                                                                                                                                                                                                                              |
| `npm run probe:preview-perf`                     | **按任务要求未运行**（baseline.json 由另一包在修）                                                                                                                                                                                                                                                    |

## 8. 残留 / 风险登记

- **Worker 侧引擎分块加载失败 ⇒ 每文件 `plain`**（§3.5）：不重试、不粘滞、不超时循环；文件保持纯文本。真机 P4 若观察到该形态再议（例如降级为粘滞）。
- **共享 Worker 的排队**：多窗口同时请求时分时串行（Worker 消息循环天然如此），队尾请求可能因队头耗时撞 3 s 截止而回落主线程——行为正确（回落路径兜底），仅损失一点并行度；预览场景实际一次只开一个大文件，影响可忽略。
- **取消不中断 Worker 内在跑的分词**：只保证结果丢弃 + 3 s 兜底（方案允许；「窗口关闭终止任务」以主线程任务终止为准）。
- **worker 引擎副本体积**：`assets/highlight-impl-<hash>.js`（Worker 侧）+ 主线程 `highlight-impl-<hash>.js` 两份 Prism，方案 §5.3 已预告（~21 KB gz）并计入 lazy 预算。
- **probe:csp 现在要求本机缓存 Firefox**：无缓存的环境 exit 2（文档化；与 probe:mermaid 同语义）。
- **PB 的 P5 用例**（`打开后分词任务： stack-3609（Worker）主线程 0 个 >50ms 长任务`）与 §6 尺寸闸门的真机复测归 PB/P4 侧（本包不动 preview-perf 探针——另一包在修）；`plan.md` §7 契约登记行归 P4。
