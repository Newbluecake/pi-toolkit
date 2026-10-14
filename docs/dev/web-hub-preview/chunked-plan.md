# web-hub「内容预览」大文本分段续读 · 施工方案（chunked-plan v1）

> 规划产物（planning subagent，只读调研后成稿）。上位文档：`plan.md`（v3，PV1–PV6）、`dir-plan.md`（v3.1，A/B/C 三项增强）、`acceptance.md`。
> 范围：文本预览（含 Markdown 渲染视图与源码视图）超过 `PREVIEW_TEXT_MAX_BYTES`（256 KiB）时，**滚动到底自动加载下一段**；顺带修正截断提示文案 bug。
> 兼容原则沿用前两份方案：**只增不改**。新行为走 opt-in 查询参数，由新 cap `preview.chunk.v1` 门控；旧端两两组合都回落到现有「一次性截断」行为，旧 UI 收到的响应逐字节不变。
> 代码坐标以 HEAD `1e50685` 为准。
> **r2（2026-10-14）**：按评审 r1（`chunked-review-r1.md`，kimi-k3，有条件通过）修订：Major #1 源码分段切分规则重写（§4.3.4）并补不变式测试与真浏览器渲染一致性检查；#2–#6 一并处置。逐条见文末「修订记录 r2」。

---

## 0. 决策摘要（需用户拍板的项带 ★）

| #    | 取舍                             | 推荐                                                                                                                                                                                                                                        |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ★D1  | 总上限                           | **hub 硬顶 16 MiB**（协议常量，loopback/LAN 一致）；**UI 默认上限：桌面 8 MiB，触屏（`pointer: coarse`）4 MiB**，不按 listener 区分。理由见 §2.5                                                                                            |
| D2   | 是否新增 cap                     | **要**：`preview.chunk.v1`。旧 hub 不认识 `offset`，会忽略它并从 0 开始返回首段，UI 会把重复内容拼上去。所以 UI 只在看到这个 cap 时才发续读请求，另外还要校验响应回显的 offset（§2.4）                                                      |
| D3   | 身份令牌                         | `X-PWH-Preview-Ident: i1.<22 位 base64url>`，取 `sha256("dev:ino:size:ctimeMs")` 的前 128 bit。用 ctime 不用 mtime：`utimes` 能伪造 mtime，改不了 ctime。令牌不需要密钥，hub 重启后仍然有效                                                 |
| D4   | 请求形态                         | 自定义查询参数 `chunk=1&offset=N&ident=…`，**不用** HTTP `Range`/`If-Match`。这样不会出现 206，也不会被 LAN 反代的缓存或 Range 语义干扰；续读响应带 `Cache-Control: no-store`                                                               |
| D5   | 续读是否重走准入                 | **重走全部步骤**。续读请求进入的仍是同一个 `handle()`，⓪–⑩ 每一步照常执行（含重新 sniff 头部），只多出参数校验和 ident 比对两步。测试逐步钉住（§6.1 R-walk）                                                                                |
| D6   | Markdown 切分                    | 只在**顶层空行**处切：不在围栏内，也不在被表格吞掉的行里。判定由 `markdown.js` 新增的 `scanMarkdownTail` 完成，它直接复用解析器的私有 helper，作为镜像扫描。用属性测试钉住「分段解析结果拼接 ≡ 整篇解析」（§4.3）                           |
| D7   | 引用式链接                       | **不用处理**。现有白名单解析器本来就不支持 `[x][ref]` / `[ref]: url`（`LINK_RE` 只认内联链接），整篇解析和分段解析都把它当字面文本，结果一致。属性测试兼作绊线：以后如果解析器加了引用定义，测试会失败并提醒补渲染（§4.3.5）                |
| D8   | 节点预算                         | 每段沿用 `PREVIEW_MD_NODE_MAX = 20 000`，超了只把**该段**降级成源码。另设**全局** `PREVIEW_MD_STREAM_NODE_MAX = 160 000`，超过后后续所有段都按源码显示（粘滞，不会来回切换），用来卡住 DOM 总量                                             |
| D9   | 滚动与 DOM                       | 段只追加，旧段从不替换。**严禁 `content-visibility`**。哨兵和状态行设 `overflow-anchor: none`，进度状态放在滚动容器**外**的底部操作行里，滚动区上方没有任何会变高的元素（§4.6）                                                             |
| ★D10 | 首屏 JS                          | 预计增加 **+4 ~ +5 KiB gz**。HEAD 前的旧 dist 实测 251 157 B，预算 259 072 B（253 KiB），余量约 7.7 KiB，够用。超预算的后备方案：把流式渲染器拆成 `defineAsyncComponent` 懒块（§7）。推荐先放主包，实测后再定                               |
| ★D11 | 顺带修「下载按钮只下载 256 KiB」 | 现状：`PreviewHost.download()` 对 text 相位调的是 `preview.fetch` 拿 `out.text`，大文本会**静默保存成截断文件**。推荐本期一起修：hub 声明 `preview.download.v1` 时改走 `preview.download`（`download=1`，上限 256 MiB）。约 10 行，放在 P2b |
| ★D12 | 持续追加的日志                   | size 一变 ident 就跟着变，正在增长的日志第二段就会进入 changed（「文件已变更」）。这是需求「绝不拼接」的直接后果。推荐**本期接受**，changed 状态提供「重新打开」；「append-only 证明」（首段 sha256 前缀复核）放到下期                      |

---

## 1. 现状与问题（核对过的坐标）

- 协议：`src/web-hub/protocol/preview.ts`。`PREVIEW_TEXT_MAX_BYTES = 256 KiB`，`PREVIEW_HDR = {kind,size,bytes,truncated,dims}`（`tests/web-hub/protocol/preview.test.ts:65` 用 `toEqual` 钉住了整张表）。
- hub 管线：`hub/preview/routes.ts` 的 `handle()` 依次是 ⓪closing → ①CSRF → ②auth → ③参数 → ④限流（令牌桶 20、每 250 ms 补 1）加在途上限（每个 principal 2、全局 8）→ ⑤–⑦ `openAdmittedPath`（`open.ts`：会话校验 → upload/fs 分类 → `FsAdmitter` 或 `UploadStore.openForPreview`）→ ⑧ `readSample` + `sniff` → ⑨ `readAndStream`（`stream.ts`）→ ⑩ 收尾与审计。
- 文本写出：`stream.ts:streamText` 读 `[0, min(size, textMax))`，用 `utf8SafeCut` 截断；cwd 类用 pre/post `stat` 比对身份，upload 类走 `verifyWhole`（有身份缓存，并且单飞）。全部完成后才写 head，然后可选 gzip。`Identity = {dev, ino, size, ctimeMs}`（`verify.ts:27`）。
- 零卡死原语：`fs.ts` 的 `racePreviewIo`（unref 定时器、abort 监听即时移除、tracker 可选）、`previewFsStep`（tracker 必选、单步 ≤2 s）、`PREVIEW_FS_ZOMBIE_MAX = 2`。按现有约定，`stream.ts` 的读不计入 tracker。
- UI：`logic/preview.js` 的 `checkPreviewHeaders`（先校验头再读 body，`X-PWH-Preview-Bytes` 作为 gzip 下的完整性判据）；`logic/token-client.js` / `password-client.js` 的 `previewFetch`（40 s 单一 deadline，`new TextDecoder().decode(buf)`）；`composables/usePreview.ts` 状态机（seq 加一个 AbortController，导航栈上限 64）；`PreviewHost.vue` → `PreviewText.vue`（`:key="view.path"`，Markdown/源码切换，B5 `prepareMarkdownPreview`，B7 节点预算）；`MdBlock.vue`。
- **文案 bug**：`PreviewHost.vue:463` 传的是 `:size-label="formatBytes(view.size)"`，`view.size` 来自 `X-PWH-Preview-Size`，也就是**全文大小**。`PreviewText` 的 prop 注释写的是「shown body」。i18n 文案 `truncatedNote: "仅显示前 {size}"` 会显示成「仅显示前 2.3 MiB」，实际只显示了 256 KiB。另外 transport 的 text outcome 丢掉了 body 字节数（`chk.size`），UI 目前根本拿不到「已显示多少」。
- 约束：source-scan 禁用 `requestAnimationFrame`、`v-html`、`<style>` 和 `style=`；UI 里还没有任何地方用 `IntersectionObserver`（只有 `ResizeObserver`）；`HIGHLIGHT_MAX_BYTES = 100 KiB`，超过的文本本来就按纯文本渲染。

---

## 2. 协议（`src/web-hub/protocol/preview.ts`、`protocol/version.ts`）

### 2.1 新增常量与纯函数（全部只增）

```ts
/** chunked-plan §2: opt-in 续读查询参数名（只有精确值 "1" 才生效，同 dir/download 规则）。 */
export const PREVIEW_CHUNK_QUERY = "chunk";
export const PREVIEW_OFFSET_QUERY = "offset";
export const PREVIEW_IDENT_QUERY = "ident";

/** 每段正文上限 = 现有文本上限（每段的 deadline/内存与今天的首段完全同型）。 */
export const PREVIEW_TEXT_CHUNK_BYTES = PREVIEW_TEXT_MAX_BYTES;

/** hub 硬顶：分段模式下 hub 永不送出 offset ≥ 此值的字节（loopback/LAN 同宽，U1）。 */
export const PREVIEW_TEXT_STREAM_HUB_MAX_BYTES = 16 * 1024 * 1024;

/** UI 默认总上限（D1）：桌面 8 MiB、触屏 4 MiB；必须 ≤ hub 硬顶（关系测试钉住）。 */
export const PREVIEW_TEXT_STREAM_CLIENT_MAX_BYTES = { fine: 8 * 1024 * 1024, coarse: 4 * 1024 * 1024 } as const;

/** UI 两次续读之间的最小间隔：≥ hub 令牌桶补充周期 250ms，留余量给并行的普通预览点击。 */
export const PREVIEW_CHUNK_MIN_GAP_MS = 300;

/** 身份令牌格式（D3）。 */
export const PREVIEW_IDENT_RE = /^i1\.[A-Za-z0-9_-]{22}$/;

/** `offset` 解析：十进制、无前导零（"0" 除外）、safe integer、< 硬顶；否则 null。永不 throw。 */
export function parsePreviewOffset(raw: string | null): number | null;
/** ident 校验：string 且匹配 PREVIEW_IDENT_RE。 */
export function validatePreviewIdent(raw: unknown): raw is string;
```

`PREVIEW_HDR` 追加两个键（同步更新 `preview.test.ts:65` 的 `toEqual`）：

```ts
offset: "X-PWH-Preview-Offset", // 本段起始字节偏移（仅分段模式响应）
ident: "X-PWH-Preview-Ident",   // 文件身份令牌（仅分段模式响应）
```

`protocol/version.ts` 新增 `export const PREVIEW_CHUNK_HUB_CAP = "preview.chunk.v1";`。注释写明：门控与 `PREVIEW_DOWNLOAD_HUB_CAP` 相同，只看 `config.preview` 是否存在；不依赖 `/proc`，因为文件预览本身不依赖 `/proc`；不加帧，所以不升 PROTO。`tests/web-hub/contract/types.test-d.ts` 加字面量类型断言。

### 2.2 请求（`GET /api/preview`）

| 场景                | 查询串                                                   | 说明                                                                                                         |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 旧行为              | `agentKey&sessionId&path`（可带 `dir=1` / `download=1`） | 不变，响应逐字节不变                                                                                         |
| 首段（分段 opt-in） | `…&chunk=1`                                              | 相当于 offset 0，不比对 ident；文本响应额外带 Offset/Ident 头。sniff 为 image 时**照常返回图片**，忽略 chunk |
| 续读                | `…&chunk=1&offset=N&ident=i1.xxx`                        | N 等于上一段的 offset 加上一段的 `X-PWH-Preview-Bytes`；ident 用首段拿到的值                                 |

hub 在第③步按以下顺序校验，任何一条不满足 ⇒ 400 `E_BAD_REQUEST`：

1. `chunk` 不等于 `"1"`，却带了 `offset` 或 `ident`（拒绝半截协议）；
2. `chunk=1` 和 `dir=1` 或 `download=1` 同时出现（互斥）；
3. `chunk=1` 时 `offset` 和 `ident` 只出现一个（必须成对）；
4. `parsePreviewOffset(offset) === null`，即格式错或 offset ≥ 16 MiB 硬顶；
5. `!validatePreviewIdent(ident)`。

`offset=0` 加 ident 是合法的（带身份校验重读首段）。不检查 offset 是否落在 UTF-8 字符边界：已认证用户本来就能读任意字节（U4），这条检查没有安全收益；而且 UI 端的解码器会把非法序列替换成 U+FFFD。

### 2.3 响应

**200（分段模式文本）**：在现有头之外追加：

| 头                        | 值                                         | 备注                                        |
| ------------------------- | ------------------------------------------ | ------------------------------------------- |
| `X-PWH-Preview-Kind`      | `text`                                     | 不变                                        |
| `X-PWH-Preview-Size`      | 文件总大小                                 | 语义不变，是总大小                          |
| `X-PWH-Preview-Bytes`     | 本段 body 解压后的字节数                   | 不变，完整性判据                            |
| `X-PWH-Preview-Truncated` | `offset + bytes < size` 时为 `1`，否则 `0` | 分段模式下的含义是「后面还有内容」          |
| `X-PWH-Preview-Offset`    | 本段起点                                   | **新**，必须等于请求里的 offset（首段为 0） |
| `X-PWH-Preview-Ident`     | `i1.…`                                     | **新**，用流开始时的 `pre` stat 计算        |
| `Cache-Control`           | `no-store`                                 | **新**，只在分段模式下加                    |

gzip 协商不变，每段独立压缩。非分段请求**一个头都不加**，旧 UI 拿到的响应逐字节不变（有测试快照）。

**错误（续读特有的映射；首段沿用现有矩阵）**：

| 条件                                                            | 响应                                               |
| --------------------------------------------------------------- | -------------------------------------------------- |
| ident 与当前 `pre` stat 算出的不一致                            | 409 `E_PREVIEW_CHANGED`（未写 head）               |
| 分段模式下 `pre.size !== opened.size`（准入和写出之间文件变了） | 409 `E_PREVIEW_CHANGED`                            |
| 续读请求的 sniff 结果不是 `text`（文件变成了图片或二进制）      | 409 `E_PREVIEW_CHANGED`（续读时不返回 415 或图片） |
| ident 匹配但 `offset ≥ size`（客户端算错）                      | 400 `{error:"E_BAD_REQUEST", reason:"offset"}`     |
| 分段模式下读操作触发了 tracker 熔断                             | 503 `E_BUSY` + `Retry-After: 1`                    |
| 其余（准入拒绝、会话变更、429、503、504）                       | 与首段完全相同                                     |

### 2.4 为什么一定要 cap，以及 UI 的双保险

- 旧 hub 会忽略未知参数并从 0 返回首段。UI 如果不先看 cap 就发续读，会把首段重复拼上去，所以 cap 必须有。
- 双保险：UI 对每个分段响应都要求 `X-PWH-Preview-Offset` 等于请求的 offset，并且 `X-PWH-Preview-Ident` 合法；续读时 ident 还必须等于流里保存的 ident。任一不满足 ⇒ `E_BAD_RESPONSE`，状态机进入 error（不可重试），**不追加任何内容**。首段响应如果缺这两个头（例如被反代剥掉），就按旧版一次性截断显示，不建流。

### 2.5 总上限取值理由（D1）

- **UI 的内存和渲染才是瓶颈，带宽不是**。每段 256 KiB，在滚动时按需拉取，LAN 上 1 MiB/s 级别的节奏也没有压力；listener 类型和设备内存并不相关。所以**不按 loopback/LAN 区分**（同 U1 的同宽原则），改按 `pointer: coarse` 区分（与图片的 20 MP / 40 MP 预算同一思路，`clientImageBudget` 是先例）。
- 8 MiB 文本 ≈ 32 段；源码视图约 32 个块级 div；渲染视图另有全局 16 万 AST 节点上限（约 32 万 DOM 节点）。考虑到 #11 Aw Snap（Edge/Win10 渲染进程崩溃），取保守值。
- **常驻内存如实估算（r2，#3）**。同一份文本在 UI 中会被持有多次，下表按 8 MiB UTF-8 文本计：

  | 持有者                                                                  | 份数 | 说明                                                                                       |
  | ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
  | `stream.chunks`（usePreview）                                           | 1×   | V8 对纯 Latin-1 文本用单字节串（约 8 MiB）；混有 CJK/emoji 时整串变为双字节（约 6–16 MiB） |
  | 源码分段器的段字符串                                                    | ≈1×  | `pending +=` 生成 cons string，`slice` 时被拍平，通常是独立副本                            |
  | Markdown 分段器：归一化后的 pending、`src` 段文本、AST 里的 text 字符串 | ≈1×  | pending ≤ 512 Ki 字符（约 1 MiB），其余与文本量同阶                                        |
  | AST 对象（≤16 万节点 × 约 100–200 B）                                   | —    | 约 16–32 MiB；只有渲染视图惰性追赶过的部分才存在                                           |
  | DOM 文本与布局对象（只计当前视图）                                      | ≈1×  | Blink 自己持有一份文本，另加行盒/布局对象                                                  |

  合计：**桌面典型约 50 MiB、最坏约 100 MiB**（全双字节且 AST 满额）；**触屏（4 MiB）典型约 25 MiB、最坏约 50 MiB**。这远低于渲染进程的 V8 堆上限（64 位为 GiB 级）。#11 的根因是排版振荡，不是内存，所以上限数值**不改**，仍由 §10 真机验收兜底观察任务管理器内存。本期不做「消费后释放 chunks」的优化：`stream.chunks` 的唯一写者是 usePreview，组件不得回写；而且渲染视图的惰性追赶依赖这些 chunk。

- 超过 8 MiB 的文本基本是日志或数据，这种情况应该下载（下载上限 256 MiB）。到上限后的提示文案会引导用户去下载。
- hub 硬顶定为 16 MiB，以后 UI 想放宽到 16 MiB 不必改 hub。hub 自己保证永不越过硬顶（单段读取长度 = `min(textMax, size − offset, 硬顶 − offset)`）。
- 上限判定在**发起请求前**做：`loaded < cap` 才继续请求，所以实际加载量 < cap + 256 KiB（文档和测试都写明这一点）。

---

## 3. hub 实现

### 3.1 `hub/preview/ident.ts`（新，纯函数，带 `node:crypto`）

```ts
export function previewIdentOf(id: Identity): string {
  const h = createHash("sha256").update(`${id.dev}:${id.ino}:${id.size}:${id.ctimeMs}`).digest("base64url");
  return `i1.${h.slice(0, 22)}`;
}
```

`ctimeMs` 是浮点数，对同一个 stat 做 `String()` 结果是确定的。upload 类的 adapter 在 fake 下可能拿到 `ctimeMs: 0`，没关系，upload 类另有 sha256 闸门。

### 3.2 `hub/preview/stream.ts`

- `StreamSrc` 新增可选字段 `chunk?: { offset: number; ident?: string; ceiling: number }`；`StreamOpts` 新增可选字段 `tracker?: PreviewIoTracker`（**只有分段模式传**）。
- `StreamFailReason` 增加 `"range" | "busy"`。**`busy` 只来自分段分支自己的前置检查**（r2，#4）。`racePreviewIo` 永远不会产生 `PreviewIoError("busy")`，它只出自 `previewFsStep` 的前置检查，所以 **`classify` 不新增分支**。分段分支在每个 race（stat、read、`verifyWhole`、gzip）之前先判断 `opts.tracker !== undefined && opts.tracker.zombies >= opts.tracker.max`，成立就直接 `return fail("busy")`。race 本身把 tracker 作为第 5 个参数传入，被 deadline 或 abort 放弃的底层操作因此计为 zombie。
- `streamText` 分段分支（**`src.chunk === undefined` 时代码路径与今天逐字节相同**）：
  1. 先做 tracker 前置检查（见上条），通过后才执行 `pre = race(stat)`。分段模式下的 race 是 `racePreviewIo(p, deadlineAt, signal, now, opts.tracker)`，后面每个 race 之前都重复这一前置检查。
  2. `identNow = previewIdentOf(identityOf(pre))`。若 `chunk.ident !== undefined && chunk.ident !== identNow` 或 `pre.size !== src.size`，则 `fail("identity-changed")`。
  3. 若 `chunk.offset >= src.size && !(chunk.offset === 0 && src.size === 0)`，则 `fail("range")`。
  4. `start = chunk.offset`，`want = min(src.size − start, textMax, chunk.ceiling − start)`。只有 `start === 0` 时复用 sniff 样本，否则从 `start + got` 处开始 positional read。
  5. `cut = (start + want === src.size) ? want : utf8SafeCut(body, want)`。**推进规则**：`cut === 0 && want > 0` 时令 `cut = want`。这样可以避免「末尾悬空的前导字节」或「全是续字节的垃圾数据」导致 0 字节响应，进而让 UI 死循环。
  6. 校验分支不变：upload 类走 `verifyWhole`（身份缓存命中时成本约为一次 stat），cwd 类比较 post/pre 身份。**`verifyWhole` 仍然只出现在 `streamText` 内、`writeHead` 之前**，现有源码顺序断言照样成立。
  7. 头：`baseHeaders(..., truncated = start + cut < src.size, bodyBytes = cut)` 加 `Offset`/`Ident`/`Cache-Control: no-store`。
- 内存：每个请求只有一个 ≤256 KiB 的 body、一个 ≤64 KiB 的样本，加上可选的 gzip 输出，与今天的首段同型。

### 3.3 `hub/preview/routes.ts`

- ③ 按 §2.2 解析参数：`wantChunk`、`chunkOffset: number | undefined`、`chunkIdent: string | undefined`，`isCont = chunkOffset !== undefined`。
- ④ **限流沿用同一个桶** `${principal}:preview`，续读也计费，不另开桶，也不享受豁免。
- ⑤–⑦ **原样调用** `openAdmittedPath`，不跳过任何一步，不加缓存，不加快速路径。
- ⑧ 照常执行 `readSample` + `sniff`。续读时若 `sniffed.kind !== "text"`，返回 409 `E_PREVIEW_CHANGED`，并且这个判断放在 binary 415 和 image 分支**之前**。首段（`wantChunk && !isCont`）遇到 image，照旧走图片分支。
- ⑨ `wantChunk && sniffed.kind === "text"` 时，向 `readAndStream` 传 `chunk: {offset: chunkOffset ?? 0, ident: chunkIdent, ceiling: PREVIEW_TEXT_STREAM_HUB_MAX_BYTES}` 和 `tracker`（routes 实例自己的那个）。结果映射增加两条：`range` → 400 `{error:"E_BAD_REQUEST", reason:"offset"}`；`busy` → 503 `E_BUSY` + `Retry-After: 1`。两者都只在 head 发出之前出现。
- 审计：`AuditAcc` 加 `offset?: number`（只在分段模式下写，是统计用的整数，不涉及路径）；`hub/audit.ts` 的 `PreviewAuditRecord` 和 `PREVIEW_AUDIT_KEYS` 追加 `"offset"`。其余审计规则不变：不落原始路径或文件名。

### 3.4 `hub/hub.ts`

`extraHubCaps` 的 `config.preview` 分支，在 `PREVIEW_DOWNLOAD_HUB_CAP` 后面加 `PREVIEW_CHUNK_HUB_CAP`（两个 cap surface 共用同一个源数组，§4.7 不变式自动满足）。

### 3.5 零卡死与 IO 预算（每个续读请求）

| 阶段                                    | 上界                                          | 机制                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 准入（①–⑦）                             | 总计 8 s，每个 fs 步骤 ≤2 s                   | 现有 `createReqDeadline` + `previewFsStep`，计入 tracker                                                                                                                                                                                                                                                                                                                           |
| sniff 样本（64 KiB）                    | 在准入预算内                                  | 现有 `readSample`，计入 tracker                                                                                                                                                                                                                                                                                                                                                    |
| 写出（stat、read、verify、gzip、drain） | `PREVIEW_STREAM_MS`：loopback 15 s / LAN 30 s | `racePreviewIo`，unref；**分段模式额外计入 tracker**，熔断即快速失败（503）                                                                                                                                                                                                                                                                                                        |
| upload 类 `verifyWhole`                 | ≤30 s，且受写出 deadline 约束                 | 现有单飞加身份缓存，首段算过之后续读几乎都是 `cached`                                                                                                                                                                                                                                                                                                                              |
| 并发                                    | 每个 principal 2 / 全局 8                     | 现有在途槽；UI 保证每个对话框同一时刻最多 1 个续读在途                                                                                                                                                                                                                                                                                                                             |
| 速率                                    | 桶容量 20，每 250 ms 补 1（4 次/s）           | **单流**：UI 两次续读至少间隔 300 ms（约 3.3 次/s），低于补充速率，桶不会被耗尽，普通点击仍有 token。**双流**（同一 principal 的两个标签页同时续读，在途上限恰好允许 2 个）：约 6.7 次/s，超过补充速率，约 7.5 s 后桶空，开始持续出现 429。这时退化为 §4.2 的 429 退避节流：waiting → 按 Retry-After 重试 → 成功后清零连续计数。行为安全，但是**预期内**的现象，不是 bug（r2，#2） |
| 关停                                    | ≤1 s                                          | 现有 `active` 集合加 `dispose()`，续读请求同样登记                                                                                                                                                                                                                                                                                                                                 |
| 客户端                                  | 每段 40 s                                     | 现有 `PREVIEW_CLIENT_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                                                   |

所有新增定时器都在 `racePreviewIo` 内部（unref），hub 侧不加任何模块级状态。

---

## 4. UI 实现

### 4.1 transport 与 logic（`logic/preview.js`、`token-client.js`、`password-client.js`、`transport/types.ts`、`types.ts`）

- `PreviewTransport.fetch` 的 req 加可选字段 `chunk?: true | { offset: number; ident: string }`：`true` 拼出 `&chunk=1`，对象拼出 `&chunk=1&offset=…&ident=…`（`encodeURIComponent`）。`dir`/`download` 与 `chunk` 同时出现时，客户端在本地直接返回 `E_BAD_REQUEST`，不发请求。
- `checkPreviewHeaders(headers, opts)` 增加 `opts.chunk?: { offset: number; ident?: string }`，text 分支额外检查：`X-PWH-Preview-Offset` 必须等于 `opts.chunk.offset`；`X-PWH-Preview-Ident` 必须通过 `validatePreviewIdent`，续读时还必须等于 `opts.chunk.ident`。不满足 ⇒ `E_BAD_RESPONSE`。**首段（`offset === 0` 且没有 ident）缺这两个头时不报错**，返回值不带 `chunk`，UI 退回旧版显示。未 opt-in 的请求完全忽略这两个头。成功返回值加 `chunk?: { offset, ident }`。
- text outcome（`PreviewOutcome` 的 text 半边，只增可选字段）加 `bytes?: number`（来自 `chk.size`，也就是本段解压后的字节数；**对旧 hub 同样有效**，文案修复依赖它）和 `chunk?: { offset: number; ident: string }`。
- `previewScopeOf`：caps 包含 `PREVIEW_CHUNK_HUB_CAP` 时设 `scope.chunks = true`；`PreviewPathScope` 加 `readonly chunks?: true`。
- `logic/preview.js` 新增 `clientTextStreamCap({coarse})`，触屏返回 4 MiB，其余返回 8 MiB，与 `clientImageBudget` 同型。
- `types.ts` 的 `PreviewView` text 相位加 `readonly bytes?: number`（只增可选字段）。

### 4.2 状态机（`composables/usePreview.ts` 持有，`PreviewText` 只负责渲染）

`PreviewHandleDir` 新增两个方法：`loadMore(): void`（幂等的「需要下一段」信号）和 `reopen(): void`（不动导航栈，重载当前路径）。text 相位视图加 `stream?: PreviewTextStream`：

```ts
interface PreviewTextStream {
  // shallowReactive，usePreview 唯一写者
  readonly ident: string;
  readonly total: number; // 首段 X-PWH-Preview-Size
  readonly cap: number; // clientTextStreamCap
  readonly firstBytes: number;
  chunks: readonly string[]; // 只追加：每次 append 换新数组（旧元素同引用）
  loaded: number; // = 下一段 offset = Σ bytes
  state: "more" | "loading" | "waiting" | "done" | "cap" | "changed" | "error";
  error?: string;
  retryable?: boolean;
  retryAt?: number;
  autoRetries: number;
}
```

建流条件：`scope.chunks === true`，请求时没有走 dir（dir 请求不带 chunk），首段 outcome 是 `text`，且 `truncated === true && chunk !== undefined`。如果 `loaded >= cap`，直接进入 `cap`。

转移表（纯函数 `nextChunkAction` / `classifyChunkOutcome` 放在 `logic/previewStream.js`，可做单测）：

| 当前状态             | 事件                                                                  | 下一状态 / 动作                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| more                 | `loadMore()`，距上次结束 ≥ 300 ms 且 `loaded < min(total, cap)`       | loading：发续读（独立的 `streamCtl`，记录 `streamSeq`）                                                                                                                   |
| more                 | `loadMore()`，未满 300 ms                                             | 保持 more，只排一个合并定时器，到点再判断                                                                                                                                 |
| loading              | `loadMore()`                                                          | 不做任何事（防重复请求）                                                                                                                                                  |
| loading              | 200 且头校验通过，`bytes > 0`，`size === total`                       | 追加 chunk，`loaded += bytes`；若 `!truncated` ⇒ done（并断言 `loaded === total`，不等 ⇒ changed）；若 `loaded >= cap` ⇒ cap；否则 ⇒ more                                 |
| loading              | 200 但 `bytes === 0 && truncated`，或 `size !== total`                | `bytes === 0 && truncated` ⇒ error（不可重试，协议违约）；`size !== total` ⇒ changed                                                                                      |
| loading              | 409 `E_PREVIEW_CHANGED`、404、415                                     | changed（终态；「重新打开」⇒ `reopen()`）                                                                                                                                 |
| loading              | 409 `E_SESSION_CHANGED`                                               | `close()`（沿用现有语义）                                                                                                                                                 |
| loading              | 429 / 503（`E_RATE` / `E_BUSY` / `E_HUB_RESTARTING`）                 | 连续自动重试 < 3 次 ⇒ waiting（按 Retry-After 秒排定时器，到点回到 loading）；否则 ⇒ error（可重试）。**任一段成功即把 `autoRetries` 清零**；手动「重试」也清零（r2，#2） |
| loading              | `E_DEADLINE` / `E_NETWORK` / 500 / `E_AUTH`                           | error（可重试，「重试」按钮回到 loading）                                                                                                                                 |
| loading              | 403 / 400 / `E_BAD_RESPONSE`                                          | error（不可重试）                                                                                                                                                         |
| loading 或 waiting   | 取消：`close` / `navigate` / `back` / `open` / 作用域变化 / `dispose` | abort `streamCtl`，清掉定时器；state 回到 more（不显示错误）；seq 失配的晚到结果直接丢弃                                                                                  |
| done / cap / changed | 任何 `loadMore()`                                                     | 不做任何事                                                                                                                                                                |

- 取消一律走 `abortInFlight()`（扩展为同时 abort 主 ctl 和 `streamCtl`，并清掉流定时器）。晚到的结果要同时满足 `streamSeq === 当前值` 和 `view.value.stream === s` 才能写入，否则丢弃。
- **入栈降级**：`navigate()` 把带流的 text 视图压入历史栈之前，先把这个流降级为 `chunks = [chunks[0]]`、`loaded = firstBytes`、`state = "more"`。这样栈里的内存上限仍是 64 × 256 KiB，与今天相同；`back()` 回来后可以继续续读，有 ident 保证一致。
- `reopen()` 等价于 `load(lastPath, lastDir)`，可以从任何相位调用。

### 4.3 Markdown 分段算法（`logic/markdown.js` 追加 `scanMarkdownTail`；`logic/previewStream.js` 的 `createMarkdownSegmenter`）

#### 4.3.1 不变式

令 `seg = text.slice(0, cut)`，`rest = text.slice(cut)`。当 `cut` 由 `scanMarkdownTail` 给出时，必须满足 `parseMarkdown(seg) ++ parseMarkdown(rest)` 与 `parseMarkdown(text)` 深相等。

依据（逐个核对过 `parseBlocks`）：解析器在顶层空行处会 flush 掉 `para` 和 `list`；能跨多行的结构只有三种：fence（会跨空行，所以围栏内不能切）、quote（`collectQuote` 遇到裸空行就 `break`）、table（`tryParseTable` 遇到空行就 `break`）；唯一的前视是表头行 `i+1`，看到的是空行，不构成表格。不支持 setext 标题、缩进代码、HTML 块、引用定义。

#### 4.3.2 `scanMarkdownTail(text)`（追加在 `markdown.js` 里，复用私有的 `FENCE_RE` / `HEADING_RE` / `QUOTE_RE` / `collectQuote` / `tryParseTable`；`parseMarkdown` 一行不改）

```js
/**
 * @param {string} text  已做 \r\n?→\n 归一、起点位于顶层边界的待处理尾部
 * @returns {{ cut: number, lineEnd: number, openFence: string | null }}
 *   cut      最后一个「顶层空行」之后一行的起点（-1 = 无安全切点）
 *   lineEnd  最后一个 "\n" 之后的位置（完整行的末端；无 "\n" 时为 0）
 *   openFence  lineEnd 处若有未闭合围栏，返回其开栏行（供强制切分闭合/重开）
 */
export function scanMarkdownTail(text) {
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return { cut: -1, lineEnd: 0, openFence: null };
  const lines = text.slice(0, nl).split("\n"); // 只看完整行
  const starts = lineStartsOf(lines); // starts[i] = lines[i] 的字符偏移
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line); // 与 parseBlocks 同序：fence 最先
    if (fence) {
      const j = findFenceClose(lines, i, fence[1]); // 与 parseBlocks 同一闭合规则（同字符、长度 ≥）
      if (j === -1) return { cut, lineEnd: nl + 1, openFence: line };
      i = j;
      continue;
    }
    if (line.trim() === "") {
      cut = i + 1 < lines.length ? starts[i + 1] : nl + 1;
      continue;
    }
    if (HEADING_RE.test(line)) continue;
    if (QUOTE_RE.test(line)) {
      i = collectQuote(lines, i, [], 0);
      continue;
    } // 吞掉的行不可能是 fence
    if (line.includes("|") && i + 1 < lines.length) {
      const t = tryParseTable(lines, i); // 表格行可能“长得像”fence，必须镜像吞掉
      if (t) {
        i = t.end;
        continue;
      }
    }
    // list item / 续行 / 段落：单行判定，不产生跨空行的状态
  }
  return { cut, lineEnd: nl + 1, openFence: null };
}
```

`findFenceClose` 从 `parseBlocks` 的闭合循环中抽成一个内部 helper，并让 `parseBlocks` 也改为调用它。这是纯重构，由现有的固定种子差分测试（`fixtures/markdown-ref.js`）兜底。如果不想动 `parseBlocks`，也可以让 `scanMarkdownTail` 内联一份同样的闭合逻辑，由属性测试兜底。推荐前者。

扫描范围只覆盖完整行：表格前视看不到未完成行，闭合围栏如果落在未完成行里也看不到。这两种情况都只会让扫描**少给切点**，不会给出错误的切点，属于保守方向。

#### 4.3.3 分段器（`createMarkdownSegmenter`，DOM-free）

- `push(chunkText)`：
  - 先做归一化：`\r\n?` 替换为 `\n`。若 pending 以 `\r` 结尾，**扣住这个 `\r`** 等下一段，避免跨段的 `\r` + `\n` 被归一成两个换行。
  - `pending += 归一后文本`，然后调用 `scanMarkdownTail(pending)`；有 `cut > 0` 就产出 `pending.slice(0, cut)` 这一段，把剩余部分留作 pending。
  - **强制切分**：`pending.length > PREVIEW_MD_PENDING_MAX`（推荐 512 Ki 字符，约 1 MiB）且没有切点时触发：
    - `openFence` 不为 null：产出 `pending.slice(0, lineEnd) + 闭栏标记 + "\n"`，新的 pending 为 `openFence + "\n" + pending.slice(lineEnd)`。巨大代码块因此显示为相邻的两个代码块。
    - `lineEnd > 0`：在最后一个完整行处切，该段标记 `forced`。剩余部分可能误渲染，例如表格续行变成带 `|` 的段落，已接受。
    - `lineEnd === 0`（单行超过 1 MiB 且没有换行）：整段作为源码段，`reason: "forced"`。
- 每产出一段：`nodes = parseMarkdown(text)`，`n = countMdNodes(nodes)`。
  - `n > PREVIEW_MD_NODE_MAX`：产出 `{kind:"src", reason:"node-budget", text}`；
  - `renderedTotal + n > PREVIEW_MD_STREAM_NODE_MAX`：产出 `{kind:"src", reason:"total-budget"}`，**并且之后所有段都按源码显示（粘滞）**；
  - 否则产出 `{kind:"md", nodes}`，`renderedTotal += n`。
  - 段对象一律 `markRaw`，每段带自增 `id`。
- `flush(mode)`：
  - `"eof"`（done）：把 pending 整体作为最后一段，结果精确；
  - `"stop"`（cap 或 changed）：按 B5 语义丢掉不完整的末行（`pending.slice(0, lineEnd)`；`lineEnd === 0` 时原样保留），段标记 `tailIncomplete`，渲染时附注「结尾可能不完整」；
  - error 状态不 flush，pending 留给重试后续用。

#### 4.3.4 源码分段器（`createSourceSegmenter`，md 的源码视图和非 md 文件共用）

> **r2 重写（评审 r1 Major #1）**。r1 的规则是「在最后一个 `\n` 处切，段 = `slice(0, nl)`」，跨段的空行会丢失。例如 `"a\n\nb"` 在第二个 `\n` 处切，得到 `"a\n"` 和 `"b"`。一个独立 `pre-wrap` 块末尾的单个 `\n` 不会产生额外一行，中间的空行就消失了。r1 的「视觉上无缝」从未实测过，复制守恒测试也掩盖了这个缺陷。下面是定稿规则。

**渲染模型**：每段是一个块级 `pre-wrap` 元素，块边界恰好**代替一个**被消费掉的 `\n`。因此要让「分段渲染 ≡ 单个 `<pre>` 渲染」，需要满足两条：

- 段**不得以 `\n` 结尾**：块尾的单个换行不显示，这个换行会被吞掉；
- 段**不得为空**：空块高度为 0，被它消费的换行同样会消失。

段**可以以 `\n` 开头**：块首的换行会稳定渲染成一个空行。runtime 文本节点不会像 HTML 解析器那样剥掉 `<pre>` 后的首个换行，而且源码段用的是 `<div>`，不是 `<pre>`。

**切点规则**：切点 `p` 是 pending 中**最后一个满足 `p > 0` 且 `pending[p − 1] !== "\n"` 的 `\n` 的位置**。

```js
// createSourceSegmenter(): pending 为原始文本（不归一化，复制保真）
function takeSegments() {
  const out = [];
  let p = pending.lastIndexOf("\n");
  while (p > 0 && pending[p - 1] === "\n") p = pending.lastIndexOf("\n", p - 1); // 跳过连续换行
  if (p > 0) {
    // p === 0 或 -1：无合法切点 ⇒ 扣住
    out.push({ id: nextId++, text: pending.slice(0, p), sep: "\n" }); // 段以非 \n 字符结尾、非空
    pending = pending.slice(p + 1); // 余下若以 \n 开头 ⇒ 下一段块首空行
  } else if (pending.length > SOURCE_FORCE_CHARS && /[^\n]/.test(pending)) {
    // 强制切分：无合法切点却有非换行字符 ⇒ pending 形如 "\n*" + 无换行长串，末字符必非 \n
    out.push({ id: nextId++, text: pending, sep: "", forced: true });
    pending = "";
  }
  return out;
}
// flush("eof" | "stop")：pending 非空则整体输出 { text: pending, sep: "", final: true }
//（可以以 \n 结尾，也可以只含换行，与单个 <pre> 末尾的行为一致）；pending 为空则不输出。
```

- **只剩换行的 pending 扣住**：形如 `"\n\n"` 时找不到合法切点（`p = 0` 被排除，`p = 1` 的前一字符是 `\n`），等下一段或 EOF 再处理。强制切分条件要求至少有一个非换行字符，所以全换行的 pending 永不强制切。这种 pending 最长受总上限约束；到上限时由 `flush("stop")` 输出。
- **`\r` 当作普通字符**：只有 `\n` 是切分依据。CRLF 文本的段可能以 `\r` 结尾，例如 `"a\r\n\r\nb"` 切成 `"a\r\n\r"` 和 `"b"`。逐行字符与单个 `<pre>` 完全相同，所以渲染一致；空行检测不受影响，因为前一字符 `\r` 不是 `\n`。
- **强制切分**（`SOURCE_FORCE_CHARS` = 512 Ki 字符，约 1 MiB）只在超长单行上发生，`sep: ""` 表示边界上没有被消费的换行。视觉上这一行会在块边界处多折一行，这是已接受的偏差，§6.2 有测试单独钉住，渲染一致性检查（§6.5）排除这一情形。
- **`flush("eof")` 与 `flush("stop")` 行为相同**，都输出剩余全部。源码视图向来允许显示半行，与 legacy 非 md 文件一致。
- **复制内容**是 `segments.map(s => s.text + s.sep).join("")`，**严格等于已消费的原文**，强制切分也不例外（r1 的 `join("\n")` 在强制切分时会凭空多出换行，一并修正）。用 Vue `computed` 惰性计算，`CopyButton` 只在点击时读取 `value`（`CopyButton.vue:57`），平时零成本。

**用例推演**（`|` 表示块边界）：

| 原文                       | 分段                             | 渲染与单个 `<pre>` 对照                  |
| -------------------------- | -------------------------------- | ---------------------------------------- |
| `a\n\nb`                   | `a` \| `\nb`                     | a / 空 / b ✓                             |
| `a\n\n\nb`                 | `a` \| `\n\nb`                   | a / 空 / 空 / b ✓                        |
| `a\nb\n`（EOF）            | `a` \| `b`，pending 为空，不输出 | a / b ✓（单个 pre 末尾的 `\n` 也不显示） |
| `x\n\n\n`（EOF）           | `x` \| EOF 段 `\n\n`             | x / 空 / 空 ✓                            |
| `\n\nb\nc`                 | `\n\nb` \| `c`                   | 空 / 空 / b / c ✓                        |
| 只到达 `a\n\n`，等待下一段 | `a`，pending `\n` 扣住           | 下一段到达后接上                         |

#### 4.3.5 边界用例（全部进 §6.2 单测）

1. 围栏跨多个 chunk（``` 和 ~~~ 两种；闭栏更长；闭栏字符不同不算闭合）；
2. 未闭合围栏一直到 EOF（`flush("eof")` 的结果与整篇解析相同）；
3. 围栏内有空行（不能作为切点）；
4. 表头 + 分隔行之后有一行形如 ` ```a|b `（被表格吞掉，不能当作开栏）；
5. quote 带 lazy continuation 后接裸空行；quote 内部有 `>` 空行（不是顶层空行）；
6. list 带缩进续行后接空行；ordered 和 unordered 交替出现；
7. CRLF 和孤立 CR 恰好落在 chunk 末尾；
8. 全文没有空行，强制在行边界切；
9. 强制切点落在围栏内（闭合加重开，两个代码块的文本拼起来等于原文）；
10. 超过 1 MiB 的单行；
11. 空 chunk；首个 chunk 带 BOM；
12. done 时 flush、cap 时 flush（丢不完整的末行）；
13. 段超过节点预算（只降级这一段）；累计超过全局预算（粘滞）；
14. 引用式链接 `[a][r]` 在前、`[r]: https://x` 在文末：分段解析和整篇解析都输出字面文本，一致（D7 的绊线）。

### 4.4 渲染结构（`components/preview/PreviewText.vue`）

- **非流模式**（小文件、旧 hub，或首段缺 ident）：DOM 与今天逐字节相同（现有测试不动），只改截断提示文案（§4.7）。
- **流模式**（`stream` prop 存在）：
  - 源码视图：`<div class="preview-text-body preview-stream" tabindex="0">`，里面每段一个 `<div class="preview-seg">{{ seg.text }}</div>`（继承 `white-space: pre-wrap`；段的首尾换行形态由 §4.3.4 的切分规则保证，渲染与单个 `<pre>` 一致），末尾放 `<div class="preview-stream-sentinel" aria-hidden="true">`。**pre→div 样式等价（r2，#6）**：`.preview-text-body` 的全部样式都写在类选择器上（`preview.css:399-413`：flex/min-height/margin:0/padding/overflow:auto/background/radius/color/`--font-mono`/font-size/line-height/`white-space: pre-wrap`/`overflow-wrap: anywhere`），`:focus-visible` 规则（`:415`）同样是类选择器，所以 div 也能命中。`<pre>` 的 UA 默认样式（margin、monospace、`white-space: pre`）本来就全被这个类覆盖，换成 div 没有任何语义或样式差异。`tabindex="0"` 保留，键盘可聚焦和焦点环与今天一致。`.preview-seg` **不得**另设 `white-space`、`margin`、`padding`，只能继承，否则块边界会多出间距，破坏 §6.5 的一致性检查。**流模式不做语法高亮**：段大于 100 KiB 时 `shouldHighlight` 本来就会关闭高亮，如果只有小段被高亮，颜色前后不一致，还会在 150 ms 后替换 DOM。
  - 渲染视图：`<div class="preview-md md preview-stream" tabindex="0">`，里面 `md` 段为 `<div class="preview-seg"><MdBlock :nodes="seg.nodes" /></div>`，`src` 段为 `<div class="preview-seg"><p class="preview-md-note">此段以源码显示（原因）</p><pre class="preview-seg-src">{{ text }}</pre></div>`（模板里 `<pre ...>{{ text }}</pre>` 必须写在同一行，不能在 `<pre>` 后换行，避免模板编译器剥离首个换行的规则介入；`.preview-seg-src` 显式设 `margin: 0`，覆盖 UA 默认）。注释和段**作为一个整体同时追加**，不会事后插入。
  - `segments` 用 `shallowRef<readonly Segment[]>`，追加时换新数组，旧段对象引用不变。`v-for :key="seg.id"` 加上 `markRaw`，保证旧段的 VNode 和 DOM 不会被 patch。
  - 增量处理：`watch(() => stream.chunks.length)`，只喂入新增的 chunk；两个分段器各自维护游标，渲染视图的分段器**惰性追赶**，即只在当前处于渲染模式时才解析，切回来时从游标处继续。
  - B7（整篇节点预算禁用渲染按钮）只在非流模式下生效；流模式下渲染按钮始终可用，改为按段降级。

### 4.5 滚动触发

- `IntersectionObserver`：`root` 设为当前的滚动容器（`.preview-stream` 元素），`rootMargin: "0px 0px 800px 0px"`（提前约一屏预取，体验接近整篇显示），`threshold: 0`；哨兵高 1px，避免零面积目标在不同浏览器上表现不一致。
- 回调里记录 `visible` 标志，变为 `true` 时 `emit("load-more")`。另外 `watch(stream.state)`：当状态回到 `more`、`visible` 仍为 `true` 时再 emit 一次。原因是 IO 只在相交状态变化时触发，如果新段很短，哨兵一直可见，就需要这样补发，Markdown 尾部被扣住时也属于这种情况。
- 节流和防重复请求都在 controller 里（§4.2：最多 1 个在途、两次至少间隔 300 ms、合并定时器），组件可以随便发 emit。
- 生命周期：在 `onMounted`、`effectiveMode` 变化（`nextTick` 后重新 observe 新容器）以及状态回到 `more`、`loading`、`waiting` 时 observe；进入终态（done、cap、changed）以及 `onBeforeUnmount` 时 `disconnect()`。
- `IntersectionObserver` 不存在时（测试环境或老浏览器）不报错。状态行里**常驻「加载更多」按钮**，同时照顾键盘和读屏用户，按钮在 loading 时禁用。
- 不用 `requestAnimationFrame`（source-scan 已禁用），也不监听 scroll 事件。

### 4.6 防止跳动（D9）

1. **严禁 `content-visibility`**（#11 根因）。DOM 只追加，内存由总上限控制。
2. 滚动容器**内部**唯一的变化是「在哨兵之前追加一个段」，追加点在所有已有内容的下方。滚动锚定（Chrome/Edge/Firefox）会选视口内已有的节点作锚点，不会产生位移；Safari 不支持锚定，但追加在下方本来也不会位移。
3. `.preview-stream-sentinel` 设 `overflow-anchor: none`。否则当视口里只剩哨兵时，Chrome 可能把它选为锚点，新段插到它上面后，浏览器为了保持锚点位置会把 scrollTop 往下推，形成「黏在底部、无限连续加载」的经典 bug。
4. 进度、加载中、错误等状态全部放在滚动容器**外**的 `.preview-text-actions` 行（底部，单行 `nowrap` + `ellipsis`，高度由按钮决定，不随内容变化）。流模式**不显示**顶部的 `.preview-truncated` 提示，滚动区上方没有任何元素会改变高度。
5. 段一旦插入，降级决定就不再改变（节点预算在插入前算好）。流模式不做高亮，所以不会在插入后替换 DOM。

### 4.7 文案（`i18n/zh/preview.ts`、`i18n/en/preview.ts`；`i18n-parity.test.ts` 自动校验）

- 修 bug（非流模式）：`truncatedNote: "仅显示前 {loaded}（共 {total}）——复制只取已显示部分。"`、`truncatedRenderNote: "仅显示前 {loaded}（共 {total}）——结尾可能不完整。"`，英文同步修改。`PreviewHost` 改传 `loaded-label = formatBytes(view.bytes ?? utf8Len(view.text))` 和 `total-label = formatBytes(view.size)`；`sizeLabel` prop 改名为两个新 prop，注释同步更新。`view.bytes` 由新字段提供，旧 hub 也能拿到 `X-PWH-Preview-Bytes` 或 `Content-Length`。
- 新增流模式文案：
  - `streamProgress: "已加载 {loaded} / 共 {total}"`
  - `streamLoading: "正在加载下一段…"`
  - `streamLoadMore: "加载更多"`
  - `streamWaiting: "服务繁忙，{n} 秒后重试…"`
  - `streamCap: "已加载 {loaded} / 共 {total}，已达预览上限——完整内容请下载"`
  - `streamChanged: "文件在预览期间已变更，已停止加载"`
  - `streamReopen: "重新打开"`
  - `streamError: "继续加载失败（{code}）"`
  - `streamRetry: "重试"`
  - `streamSegSource: "此段过于复杂，以源码显示"`
  - `streamBudgetSource: "后续内容过多，已改为源码显示"`
  - `streamTailIncomplete: "结尾可能不完整"`
- done 状态下状态文本整体消失（只剩切换按钮和复制按钮，行高不变）。

### 4.8 `PreviewHost.vue`

- 向 `PreviewText` 透传 `:stream="view.stream"`，事件 `@load-more="nav?.loadMore?.()"`、`@reopen="nav?.reopen?.()"`、`@retry-stream="nav?.loadMore?.()"`（error 可重试时，controller 允许从 error 回到 loading）。
- D11：`download()` 处理 text 相位时，若 `downloadCap` 为真则改调 `hub.preview.download`（完整文件），否则维持旧逻辑。

### 4.9 样式（`styles/preview.css`）

- `.preview-seg { }`：块级，没有额外边距，不加 `contain` 或 `content-visibility`。
- `.preview-seg-src`：与 `.preview-text-body` 的字体、换行规则一致，但**不是**滚动容器。
- `.preview-stream-sentinel { height: 1px; overflow-anchor: none; }`。
- `.preview-stream-status`：放在 actions 行左侧，`flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`，`margin-right: auto`。这会改变非 md 文件里复制按钮靠右的布局，所以流模式下才渲染。
- CSS 增量预计 < 0.4 KiB gz，当前余量约 1.9 KiB（26 727 / 28 672 B）。

---

## 5. 兼容矩阵

| hub                                                 | UI   | 行为                                                                             |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| 新（声明 cap）                                      | 新   | 分段续读                                                                         |
| 新                                                  | 旧   | 旧 UI 不会发 `chunk=1`，响应**逐字节不变**，仍是一次性截断                       |
| 旧（无 cap）                                        | 新   | 不发 chunk 参数，一次性截断；文案修复同样生效（`bytes` 取自旧 hub 已有的头）     |
| 新，`webHub.preview = "loopback"`                   | LAN  | 端点 404（现有矩阵），scope 为 null                                              |
| 新，`webHub.preview = "off"`                        | 任意 | 无 cap，无端点                                                                   |
| 新 hub，但首段响应缺 Offset/Ident（反代剥头或 bug） | 新   | 不建流，按旧版显示                                                               |
| 续读响应回显的 offset 或 ident 不符                 | 新   | `E_BAD_RESPONSE`，流进入 error，不追加                                           |
| upload 类文件                                       | 新   | 同样分段（`verifyWhole` 身份缓存让续读很便宜）                                   |
| 平台没有 `/proc`                                    | 新   | cap 照常声明（文件预览不依赖 `/proc`）                                           |
| hub 重启后续读                                      | 新   | ident 是确定性的，无密钥，文件没变就能继续；hub 关停期间的请求得到 503，自动重试 |

---

## 6. 测试计划

### 6.1 hub（`npx vitest run tests/web-hub`）

- `tests/web-hub/protocol/preview.test.ts`：
  - `PREVIEW_HDR` 表加入新键；
  - `parsePreviewOffset` 正反例（`"0"`、`"01"`、`"-1"`、`"1e3"`、超过 safe int、等于硬顶、等于硬顶 −1）；
  - `validatePreviewIdent`；
  - 常量关系：client 上限 ≤ hub 硬顶，`PREVIEW_TEXT_CHUNK_BYTES === PREVIEW_TEXT_MAX_BYTES`，`PREVIEW_CHUNK_MIN_GAP_MS ≥ 250`。为此把 routes 里的桶补充常量导出，或在 routes 测试里钉住。
- `tests/web-hub/hub/preview/ident.test.ts`（新）：确定性；dev、ino、size、ctimeMs 任一变化都会改变 ident；格式匹配 `PREVIEW_IDENT_RE`。
- `tests/web-hub/hub/preview/stream.test.ts`：
  - offset 读取：positional read 的位置；
  - 段末恰好落在 3 字节或 4 字节字符中间时截在字符边界；
  - EOF 处不截断；
  - 推进规则（末尾悬空的前导字节、全是续字节）；
  - ident 不符、`pre.size !== src.size` ⇒ `identity-changed`，且没写 head；
  - `range`；
  - 硬顶钳制（offset 接近硬顶时读取长度被截短）；
  - tracker 熔断 ⇒ `busy`；
  - 分段模式 gzip 正常，`Bytes` 头等于 cut；
  - **非分段模式头集合快照不变**；
  - 源码顺序断言（`verifyWhole` 在 `writeHead` 之前）保持通过。
- `tests/web-hub/hub/preview/routes.test.ts`：
  - §2.2 参数矩阵五类 400；
  - **R-walk（D5）**：同一个续读请求逐步验证都会执行：
    - CSRF 失败 ⇒ 403；
    - auth 被调用；
    - 令牌桶扣费（第 21 个请求 ⇒ 429）；
    - 在途槽占用；
    - `registry.get` 换了 sessionId ⇒ 409 `E_SESSION_CHANGED`；
    - `admitter.admit` 被调用（spy 计数等于请求数）；
    - denylist 命中，即便 ident 正确也 ⇒ 403；
    - 末段 symlink 被替换 ⇒ `O_NOFOLLOW` 拒绝；
    - `readSample` 每次都执行；
    - upload 类续读调用 `openForPreview`；
  - 续读时 sniff 出 image 或 binary ⇒ 409；
  - `range` ⇒ 400 `reason:"offset"`；
  - `busy` ⇒ 503 + Retry-After；
  - 审计行带 `offset`，不含路径；
  - `dispose()` 能中止在途续读。
- `tests/web-hub/http/api-preview.test.ts`（真实 fs 端到端）：
  - 约 1.2 MiB 的混合文本（ASCII、CJK、emoji，也包含跨段的 CRLF），按段走到底，拼接后的解码结果严格等于原文；
  - 中途 `appendFile`、改写同长内容（ctime 变化）、`rename` 替换 ⇒ 409；
  - `Cache-Control: no-store` 只出现在分段响应上；
  - 带 gzip 的 Accept-Encoding。
- `tests/web-hub/http/lan-preview.test.ts`：LAN 下分段行为与 loopback 相同；`"loopback"` 模式下 LAN 带 `chunk=1` 同样 404。
- `tests/web-hub/hub/hub-preview.test.ts`：cap 集合里有 `PREVIEW_CHUNK_HUB_CAP`（preview 开启时），preview 关闭时没有。
- `tests/web-hub/contract/types.test-d.ts`：cap 字面量类型。

### 6.2 UI 逻辑（node 环境）

- `tests/web-hub/ui/logic-markdown.test.ts`：
  - `scanMarkdownTail` 单测覆盖 §4.3.5 的 1–11 和 14；
  - **属性测试**：用种子生成器（沿用 `logic-markdown-perf` / `markdown-ref` 的生成方式）生成文档，对每个返回的 cut 检查 `parse(prefix) ++ parse(suffix)` 深相等 `parse(whole)`；
  - 如果做了 `findFenceClose` 重构，原有差分测试保持绿。
- `tests/web-hub/ui/logic-preview-stream.test.ts`（新）：
  - Markdown 分段器：把一篇文档按随机字节长度切成多个 chunk 喂入，在关闭强制切分和预算时，各段 nodes 拼接深相等整篇解析；
  - 强制切分（闭合加重开的文本守恒）；
  - `\r` 被扣住；
  - 两种 flush；
  - 段预算和全局预算（粘滞）；
  - 源码分段器（r2，#1）：
    - **不变式属性测试**：种子生成的文本，其中空行、连续空行、CRLF、超长单行、全换行片段占较高比例；按随机字节长度切成 chunk 喂入，最后执行 `flush("eof")`。断言：
      - (a) 除 `final` 段以外，每段 `text !== ""` 且 `!text.endsWith("\n")`；
      - (b) `segments.map(s => s.text + s.sep).join("") === 原文`，严格逐字符相等；
      - (c) `sep === "\n"` 当且仅当段不是 `forced` 且不是 `final`；
      - (d) 关闭强制切分时，没有 `forced` 段。
    - **固定用例**：§4.3.4 推演表的六行逐条断言；只含换行的 pending 被扣住，直到 EOF 才输出；`flush("stop")` 的输出；强制切分的 `sep: ""` 与复制守恒；
    - 复制文本（`text + sep` 拼接）等于已消费的原文；
  - `nextChunkAction` 和 `classifyChunkOutcome` 的转移表穷举（§4.2 每一行）。
- `tests/web-hub/ui/logic-preview.test.ts`：
  - `checkPreviewHeaders` 的 chunk 分支（缺头、offset 回显不符、ident 回显不符、首段缺头时降级、未 opt-in 时忽略）；
  - `previewScopeOf` 的 `chunks` 键（无 cap 时 scope 与改动前深相等）；
  - `clientTextStreamCap`。
- `tests/web-hub/ui/logic-client.test.ts`、`logic-client-password.test.ts`、`transport-contract.test.ts`：URL 拼接、`chunk` 与 `dir`/`download` 互斥在本地拒绝、outcome 的 `bytes`/`chunk` 字段、两个 client 一致。

### 6.3 UI 组件（happy-dom，`IntersectionObserver` 用 `vi.stubGlobal` 注入可控 fake）

- `use-preview.test.ts`：
  - 有 cap 时首段带 `chunk: true`，dir 请求不带；
  - 建流条件；
  - `loadMore` 单飞和 300 ms 合并（fake timers）；
  - 达到上限停止；
  - close、navigate、open、作用域变化都会让 `streamCtl.signal.aborted` 变为 true，晚到结果被丢弃；
  - `back()` 后流已降级且可以继续；
  - 409 ⇒ changed，`reopen()` 不动导航栈；
  - 429 ⇒ waiting ⇒ 自动重试 ⇒ 第 3 次之后进入 error；
  - **双流抢桶（r2，#2）**：fake transport 先连续返回 429（`Retry-After: 1`）两次，再返回成功。断言流程为 waiting → loading → waiting → loading → more，**成功后 `autoRetries` 归零**。接着再连续三次 429：前两次进入 waiting，第三次 ⇒ error（可重试）；点「重试」后回到 loading，且计数重新从 0 开始。用 fake timers 推进 Retry-After，断言 waiting 期间不发请求，`loadMore()` 也不会提前触发请求；
  - 没有 cap ⇒ 不建流。
- `preview-text.test.ts`：
  - 非流模式 DOM 快照不变；
  - 流模式追加后**旧段元素引用不变**（`toBe` 比较 DOM 节点）；
  - 按段降级的注释和全局预算注释；
  - 状态行在每个状态下的文案；
  - done 时状态文本消失；
  - 哨兵带 `preview-stream-sentinel` 类；
  - fake IO 相交时 emit `load-more`；
  - 回到 more 且仍相交时补发；
  - 「加载更多」按钮；
  - 渲染和源码切换后 IO 重新 observe。
- `preview-host.test.ts`：**文案回归**：text 相位 `size = 2.3 MiB`、`bytes = 256 KiB` 时显示「仅显示前 256 KiB（共 2.3 MiB）」；D11 text 下载在有 cap 时走 `download`。
- `i18n-parity.test.ts`：新键在中英文两侧都存在。

### 6.4 钉住「禁止 content-visibility」

- `tests/web-hub/ui/source-scan.test.ts` 加两条：
  - `SOURCE_BANNED` 增加 `["content-visibility", /content-visibility|contentVisibility/]`（作用于 `.vue/.ts/.js`，注释已剥离）；
  - 新增一个 it：glob `src/web-hub/ui/src/**/*.css`，剥离 `/* */` 注释后不得出现 `content-visibility`（`transcript.css:37` 的说明性注释会被剥掉，不会误报）。
- `scripts/web-hub/visual/checks-body.ts` 新增 `ui-no-content-visibility-rule`：在任意已加载页面上遍历 `document.styleSheets` 的所有 `CSSStyleRule`（含 `@media` 嵌套），只要有 `style.contentVisibility !== ""` 就判失败。这一检查不依赖预览对话框打开，所有场景都适用。同步更新 `tests/web-hub/ui/checks-body-applicability.test.ts` 和 `checks-body.test.ts` 里的检查名单。

### 6.5 源码分段渲染一致性（r2，#1；需要真排版引擎）

**happy-dom 不排版**：没有布局引擎，`offsetHeight` 和行盒都是 0，量不出高度和行数。所以这一项**不能**只放在 node/happy-dom 层，必须在真浏览器里测。分两层：

- **自动化替身**：在 `scripts/web-hub/visual/checks-body.ts` 新增 `preview-seg-render-parity`，同步更新 `checks-body-applicability.test.ts` 和 `checks-body.test.ts` 的名单。
  - 在 node 侧 import `logic/previewStream.js`，用**真实的** `createSourceSegmenter` 和小 chunk 尺寸，为一组固定语料算出分段。语料包括：段边界落在 `\n\n`、落在 `\n\n\n`、段以空行开头、CRLF 空行、EOF 以 `\n` 结尾、EOF 尾部只有换行、多个连续边界。
  - 通过 `page.evaluate` 在已加载的 hub 页面里插入两个同宽（例如 `width: 480px`，样式经 CDP 设置，不属于应用源码，source-scan 不适用）、`height: auto`、`overflow: visible` 的容器：
    - A：`<pre class="preview-text-body">`，内容为原文；
    - B：`<div class="preview-text-body">`，内容为各段 `<div class="preview-seg">`。
  - 断言 A、B 的 `scrollHeight` 差 ≤ 1px，且 `Math.round(高度 / 计算出的 line-height)` 行数相等；另取 A、B 各行 `Range.getClientRects()` 的行数做交叉验证。
  - 局限需写明：visual harness 只有**无头 Chromium**（`scripts/web-hub/visual.ts:450`，Linux、软件合成、版本可能落后两个大版本），只能作为 Blink 行为的替身，代表不了 Edge/Win10 的真实合成，也覆盖不了 Gecko。
- **真浏览器**：Edge（Win10）和 Firefox 各跑一遍，见 §10 第 7 项。用同一份语料生成的控制台片段 `scripts/web-hub/visual/seg-parity-snippet.js`：自包含，内嵌预先算好的分段 JSON，不依赖构建。粘贴到 hub 页面的 DevTools Console 运行，输出每个语料的 A/B 高度、行数和 PASS/FAIL。这沿用了 #11 排查总结的经验：真机 DevTools Console 最有效。

---

## 7. 首屏 JS 预算（D10）

- 基线（旧 dist，构建时间早于 HEAD，**施工前须在 HEAD 上重新 `build:web` 再测**）：首屏 JS 251 157 B gz，预算 259 072 B（253 KiB）；lazy 28 107 / 43 008；CSS 26 727 / 28 672。
- 估算增量（gz）：

| 模块                                           | 增量           |
| ---------------------------------------------- | -------------- |
| `markdown.js` 的 `scanMarkdownTail`            | 约 0.6 KiB     |
| `previewStream.js`（两个分段器加状态机纯函数） | 约 1.5 KiB     |
| `usePreview` 的 controller                     | 约 0.8 KiB     |
| `PreviewText` 流模式模板与 IO                  | 约 1.0 KiB     |
| headers、两个 client、协议常量                 | 约 0.5 KiB     |
| **合计**                                       | **约 4–5 KiB** |

在余量（约 7.7 KiB）之内。

- 交付要求：P2b 收尾时附上 `npm run check:web` 的 summary 行（改动前后两次），差值写进 commit body。
- 后备方案（只有实测超过预算才启用，不必先问）：把流模式的渲染部分（`PreviewTextStream.vue`，连同 `previewStream.js` 的分段器）拆成 `defineAsyncComponent` 懒块（先例：`GraphPanel.vue:31`），首屏只保留 controller 和 transport（约 +1.5 KiB）。lazy 余量约 14.6 KiB，够用。懒块加载期间沿用首段的非流 DOM，加载完成后整体替换。替换发生在首段时，内容等长、只是结构不同，可能出现一次轻微跳动，所以这只是后备方案。

---

## 8. 风险与回滚

| 风险                                                            | 缓解                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码分段渲染与单个 `<pre>` 不一致（r1 Major #1）                | §4.3.4 定稿规则（段非空、不以 `\n` 结尾，块边界代替一个被消费的换行）；§6.2 不变式属性测试；§6.5 无头 Chromium 自动检查，加 Edge/Firefox 控制台片段 |
| Markdown 分段与整篇解析不一致                                   | 镜像扫描直接复用解析器私有 helper；属性测试加差分测试；最坏情况只是视觉上把一个块拆成两个，没有安全影响                                             |
| 追加时跳动或无限加载                                            | 哨兵 `overflow-anchor: none`；状态行放在滚动区外；只追加；真机验收（§10）                                                                           |
| 渲染进程内存或崩溃（#11 前科）                                  | 总上限 8/4 MiB；全局节点预算 16 万；禁用 `content-visibility`（source-scan 加视觉巡检双钉）；不做高亮；入栈降级                                     |
| 和普通预览抢令牌桶或在途槽                                      | 300 ms 最小间隔、单飞、429/503 按 Retry-After 退避，最多自动重试 3 次                                                                               |
| 增长中的日志无法续读（D12）                                     | 已知接受，changed 状态提供「重新打开」；append-only 证明留到下期                                                                                    |
| inode 被复用产生误判（删掉后重建，dev/ino/size/ctime 全部相同） | 实际不可达，新文件的 ctime 必然不同                                                                                                                 |
| 冷盘或网络文件系统在任意 offset 读取慢                          | 分段读取计入 tracker 熔断并受写出 deadline 约束，最坏得到 503 或 504，UI 显示可重试错误                                                             |
| 解码                                                            | hub 保证段边界落在 UTF-8 字符边界；推进规则下可能出现非法序列，`TextDecoder` 替换为 U+FFFD；续读段如果恰好以 BOM 开头会被吞掉，极罕见，已接受       |

**回滚**：hub 侧删掉 `extraHubCaps` 里的 `PREVIEW_CHUNK_HUB_CAP` 一行，新 UI 就自动回到一次性截断（旧 UI 本来不受影响）。完整回滚是 revert P1/P2 的提交。不新增 settings 开关，`webHub.preview = "off"` 仍是总闸。

---

## 9. 分包、文件域与门禁

| 包                | 文件域                                                                                                                                                                                                                                                                                                                                                         | 依赖                                           | 并行                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------- |
| **P0 协议**       | `src/web-hub/protocol/preview.ts`、`protocol/version.ts`、`tests/web-hub/protocol/preview.test.ts`、`tests/web-hub/contract/types.test-d.ts`                                                                                                                                                                                                                   | —                                              | 最先落地（冻结接口） |
| **P1 hub**        | `src/web-hub/hub/preview/{ident.ts(新),stream.ts,routes.ts}`、`src/web-hub/hub/audit.ts`、`src/web-hub/hub/hub.ts`；`tests/web-hub/hub/preview/{ident(新),stream,routes}.test.ts`、`tests/web-hub/http/{api-preview,lan-preview}.test.ts`、`tests/web-hub/hub/hub-preview.test.ts`                                                                             | P0                                             | 与 P2a 并行          |
| **P2a UI 逻辑**   | `src/web-hub/ui/src/logic/{markdown.js,previewStream.js(新),preview.js,token-client.js,password-client.js}`、`src/web-hub/ui/src/transport/{types.ts,token.ts,password.ts}`、`src/web-hub/ui/src/types.ts`；`tests/web-hub/ui/{logic-markdown,logic-preview-stream(新),logic-preview,logic-client,logic-client-password,transport-contract}.test.ts`           | P0                                             | 与 P1 并行           |
| **P2b UI 组件**   | `src/web-hub/ui/src/composables/usePreview.ts`、`components/preview/{PreviewHost.vue,PreviewText.vue}`、`styles/preview.css`、`i18n/{zh,en}/preview.ts`、`scripts/web-hub/visual/{checks-body.ts,seg-parity-snippet.js(新)}`；`tests/web-hub/ui/{use-preview,preview-text,preview-host,source-scan,checks-body-applicability,checks-body,i18n-parity}.test.ts` | P2a（UI 测试全部用 fake transport，不依赖 P1） | P2a 之后             |
| **P3 文档与验收** | `docs/dev/web-hub-preview/acceptance.md`（追加 §chunked 真机清单）；AGENTS.md「Content preview」段落追加一句 chunked 说明                                                                                                                                                                                                                                      | P1 + P2b                                       | 最后                 |

**每包门禁**：`npm run format:check`、`npm run typecheck`、`npx vitest run tests/web-hub`。P2a 和 P2b 另需 `npm run build:web && npm run check:web`，并附 summary（§7）。合入前跑一次全量 `npm test`。每包交付后按 dev-flow 派 verifier，验收模型与开发模型不同。

---

## 10. 真机验收（追加到 `acceptance.md`）

1. Edge（Win10，#11 同环境）loopback：打开 5 MiB 的 `.md`（含长代码块和表格）。分别用滚轮、拖滚动条、End 键滚到底，确认：①无跳动；②**不滚动时不在中段自动加载**；③滚到底后可以连续自动加载，这是设计行为，因为有 800px 预取，并且哨兵仍可见时会补发请求，但必须在明确的终态（done、cap 或 changed）后停止，状态行显示对应文案，之后不再发请求（可在 hub 审计行里核对）；④渲染进程不崩（观察 `edge://crashes`），任务管理器内存在 §2.5 估算的量级内（r2，#5、#3）。
2. 同一文件切到源码视图滚到底；复制内容与已显示内容一致。
3. 读到一半时 `echo x >> file`：显示 changed 文案和「重新打开」，已显示的内容不变，也没有拼接。
4. 12 MiB 日志：到 8 MiB 停止，显示上限文案和下载提示；D11 下载得到完整文件。
5. LAN 手机（触屏）：4 MiB 处停止；中途关闭对话框，hub 审计里没有残留在途请求。
6. 旧 hub（回退 cap）加新 UI：一次性截断，文案为「仅显示前 256 KiB（共 X）」。
7. **源码分段渲染一致性（r2，#1）**：在 Edge（Win10）和 Firefox 的 hub 页面 DevTools Console 中分别粘贴运行 `scripts/web-hub/visual/seg-parity-snippet.js`，全部语料都应 PASS（A/B 高度差 ≤ 1px，行数相等）。再用一份真实文件做肉眼核对：用脚本生成约 1 MiB 的源码文件，每行带行号，每隔若干行插入 1、2、3 个连续空行，并刻意让 256 KiB 段边界附近出现这些空行。在源码视图滚到底，抽查段边界附近的行号连续、空行数量正确。

---

## 11. 给用户的摘要

1. 超过 256 KiB 的文本预览（渲染视图和源码视图都支持）滚动到底会自动续读，每段 256 KiB，每段请求都完整重走现有准入链，没有任何豁免。
2. 首段返回文件身份令牌（dev/ino/size/ctime 的 hash），之后每段都要校验。文件一变就停止加载，提示「重新打开」，绝不把新旧内容拼在一起。
3. 总上限：桌面 8 MiB、触屏 4 MiB，hub 硬顶 16 MiB，loopback 和 LAN 一致。到上限后提示用户去下载。
4. Markdown 只在顶层空行处切分，用属性测试保证「分段渲染 ≡ 整篇渲染」。超出节点预算时只把该段降级为源码。全程不用 `content-visibility`，DOM 只追加，滚动区内不会跳动。
5. 新增 cap `preview.chunk.v1`，新旧 hub 与新旧 UI 任意组合都能工作；顺带修好「仅显示前 {全文大小}」的文案 bug，并建议一起修好「大文本下载只存 256 KiB」的问题。

## 用户拍板（2026-10-14）

- **D1 总上限**：UI 桌面 8 MiB / 触屏 4 MiB，hub 硬顶 16 MiB，loopback 与 LAN 一致（采纳推荐）。
- **D10 首屏 JS**：先放主包，施工前在 HEAD 重新构建实测；超预算才拆懒加载，不提预算（主会话按推荐裁定）。
- **D11 下载 bug**：本期一起修——hub 支持时「下载」改走 `download=1` 取完整文件（采纳推荐）。
- **D12 持续追加的日志**：本期接受「身份变更即停 + 重新打开」，只追加判定留到下期（采纳推荐）。

## 修订记录 r2（2026-10-14，依据 `chunked-review-r1.md`）

| #   | 严重度 | 处置                                                                                                                                                                                                                                                                                                                                                                                                               | 落点                                                |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1   | Major  | **采纳**。源码分段切点改为「最后一个 `p > 0` 且前一字符非 `\n` 的 `\n`」：段非空、不以 `\n` 结尾，块边界代替被消费的那个换行；只剩换行的 pending 扣住；EOF/stop 整体输出。段对象带 `sep`，复制改为 `text + sep` 拼接（顺带修正 r1 强制切分时 `join("\n")` 多出换行的问题）。新增不变式属性测试；新增真浏览器渲染一致性检查（无头 Chromium 自动替身，注明局限；Edge + Firefox 控制台片段），并注明 happy-dom 不排版 | §4.3.4、§4.4、§6.2、§6.5（新）、§8、§9、§10 第 7 项 |
| 2   | Minor  | **采纳**。速率表述改为「单流不耗桶；同一 principal 双流约 6.7 次/s，约 7.5 s 后进入 429 退避节流，属预期」；转移表写明成功或手动重试即清零 `autoRetries`；`use-preview.test.ts` 增加双流抢桶用例                                                                                                                                                                                                                   | §3.5、§4.2、§6.3                                    |
| 3   | Minor  | **采纳**。§2.5 补常驻内存表（chunks、源码段、md pending/AST/text、DOM）：桌面典型约 50 MiB、最坏约 100 MiB，触屏约 25 / 50 MiB；说明上限不改的理由，以及为何不做「消费后释放」                                                                                                                                                                                                                                     | §2.5                                                |
| 4   | Nit    | **采纳**。`busy` 只来自分段分支每个 race 之前的 tracker 前置检查，直接 `fail("busy")`，`classify` 不新增分支；race 传 tracker 只用于计 zombie                                                                                                                                                                                                                                                                      | §3.2                                                |
| 5   | Nit    | **采纳**。验收措辞改为「不滚动时不在中段自动加载；连续加载有明确终态（done/cap/changed）后停止」                                                                                                                                                                                                                                                                                                                   | §10 第 1 项                                         |
| 6   | Nit    | **采纳**。补充 pre→div 样式等价说明：样式和 `:focus-visible` 都在类选择器上，`tabindex` 保留；`.preview-seg` 不得另设 white-space、margin、padding；md 降级用的 `<pre class="preview-seg-src">` 模板写法与 `margin: 0`                                                                                                                                                                                             | §4.4                                                |

「用户拍板（2026-10-14）」一节（D1/D10/D11/D12）保持不变。
