# dir-explore.md — web-hub preview 目录（文件夹）预览 · 现状测绘与改动点地图

> 只读探索产物（explore:preview-dirs, r_DWS1XR61, 2026-10-08）。目标：为「preview 支持预览目录」提供精确改动点地图。行号基于当时工作树。

## 1. 路径识别层（UI 纯逻辑）

文件：`src/web-hub/ui/src/logic/preview.js`（纯函数，vitest/浏览器双跑）

**绝对路径候选对「无扩展名/目录」完全友好**——识别规则是形状无关的：

- `findPathRefs(text, scope)`（**L253**）：逐 `/` 扫描，候选须满足 rule 1 起始上下文（`isStartContext` **L139**，`START_CHARS` **L78**：行首/空白/`([{<"'=` 等开括号）、rule 2 终止符（`TERMINATOR_CHARS` **L81**）、尾部句读剥离（`TRAILING_PUNCT_RE` **L111** `/[.:!?]$/`——**不含 `/`**，尾部斜杠会留在候选里）与 `:line[:col]` 剥离（`LINE_COL_RE` **L112**，display-only）。
- `isClickable(path, scope)`（**L200**）只查两件事：`validatePreviewPath(path)` + （cwd 前缀段对齐 **L204–209** 或 uploads marker **L203**）。**没有任何扩展名要求** ⇒ `/home/u/proj/subdir`（无尾部 `/` 的目录）今天就会被识别为 ref 并进入 probe。

**两个关键负例（改目录支持时的决策点）：**

1. **尾部 `/` 的目录路径永远不会被识别**：`validatePreviewPath`（`src/web-hub/protocol/preview.ts` **L172–190**）要求 `p.slice(1).split("/")` 的每段非空——`"/a/b/"` 末段为空 ⇒ false ⇒ 不 clickable。现状：带尾斜杠写法的目录路径在 UI 就是纯文本。
2. **无扩展名的相对路径不识别**（已文档化的取舍）：`RELATIVE_EXT_RE`（**L163** `/\.[A-Za-z0-9_-]{1,10}$/`）要求末段有「点+1–10 个合法字符」；`looksLikeRelativePath`（**L172**）不过 ⇒ `src/components` 这类相对目录名不识别（`logic-preview.test.ts:307` 钉死 "no extension … never recognized (accepted trade-off)"）。**若要目录可点，绝对路径已通，相对路径需改这条规则（或维持取舍只支持绝对路径）。**

**probe 流程（先探测后标记，2026-10-07 修订）**：`PathText.vue`（`src/web-hub/ui/src/components/preview/PathText.vue`）对每个识别出的候选调 `probe.ensure(paths)`（watch，L92–98），`clickable(path)`（L82–85）要求 `stateOf(path) === "confirmed"`。`usePreviewProbe.ts` 的 `stateOf/ensure` → `logic/previewProbe.js` 的 `PreviewProbeStore`（pending→confirmed/missing/failed）批量 POST `/api/preview/probe`。**目录路径今天 probe 结果必为 `missing`**（见 §2 probe 内核），所以在启用 probe 的 UI 里目录永远渲染纯文本、不可点；无 probe 的旧路径（transport 无 `probe`）则是「可点但点了报 unsupported/not-regular」。

## 2. hub 端链路（GET /api/preview / POST /api/preview/probe）

**路由分发**（`src/web-hub/hub/http.ts`）：

- LAN：`rt.preview.mode === "on"` 且 `GET + PREVIEW_PATH` → `previewRoutes.handle`（**L1306–1320**）；probe 同门（**L1326–1340**）。`mode:"loopback"` ⇒ LAN 直接落到原 404。
- loopback：路由存在即分发（GET **L2591–2605**，probe **L2609–2623**）。
- 装配：`hub.ts` **L643–660** `createPreviewRoutes({mode, home, uploadsRoot, registry, uploads})`；caps 声明 **L229–233**（`preview.v1` 恒有、`preview.lan.v1` 仅 mode on）。

**请求流水**（`src/web-hub/hub/preview/routes.ts` `handle()`）：⓪ closing → ① CSRF（`previewCsrfOk`）→ ② authorize → ③ 参数校验（**L292** `validatePreviewPath(path)` 不过 ⇒ 400）→ ④ 令牌桶+in-flight → ⑤–⑦ **`openAdmittedPath`（L346）** → ⑧ sniff（L387）+ 图片字节/像素上限 → ⑨ `readAndStream`（L446）→ ⑩ 审计/收尾。状态表 `PREVIEW_STATUS`（L88–104）。

**共享准入管线**（`src/web-hub/hub/preview/open.ts` `openAdmittedPath` **L100–166**）：⑤ session 可见性（L116–121，agent 404 / session 不匹配 409）→ ⑥ 分类（**L124** 字面前缀 `uploadsRoot/` ⇒ upload 类，零 fs）→ ⑦ upload 类走 `UploadStore.openForPreview`（`hub/uploads.ts` **L2084**：byPath 索引、结构复核 L2099–2113、U3 可见性 L2116–2122、`openFileNoFollow` 链复核+尺寸复核 L2125–2184、返回 sha256 供流式/整读复核）；cwd 类走 `createCwdAdmitter`（L162）。

**cwd 类 13 步防线**（`src/web-hub/hub/preview/admit.ts`）：steps 1–4 零 fs 字面判定（L228–234：root 非绝对/`/`/虚拟根、path 不在 `root/` 前缀、denylist、虚拟根）；step 5–6 realpath×2（L238、L243）；steps 7/8 `withinRoot` 段对齐 + **`rp === rootRp` 拒绝（L246，预览 cwd 根本身 = "outside"）** + resolved denylist/虚拟根（L247–248）；step 9 stat；step 10 `open(PREVIEW_READ_FLAGS)`（L256–266；flags 在 `fs.ts` **L33**：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`，含迟到 fd 回收）；**step 11 fstat 身份 + 普通文件判定——目录的拒绝点：`if (!fst.isFile())` ⇒ 关闭 fd、415 `E_PREVIEW_UNSUPPORTED reason:"not-regular"`（L274–276）**；step 12 `/proc/self/fd/N` readlink 复核（L279–296，fail-closed）；step 13 返回 `{fh, size, realpath}`。纵深：`mapFsError` 的 `EISDIR → 415 not-regular`（`fs.ts` L179）——现状不可达（fstat 先拦），属防御性冗余。

**probe 内核**（`src/web-hub/hub/preview/probe.ts`）：`probeOne`（L172–190）对每条路径走**同一条** `openAdmittedPath`，失败一律折叠 `"missing"`（L174 形状错、L181 sniff 非 text/image、L185 读头失败）；成功再读头 8 KiB sniff 出 `text|image`。**目录 ⇒ open 失败（not-regular）⇒ `missing`**。

**写出与响应头**（`src/web-hub/hub/preview/stream.ts`）：`baseHeaders`（**L117**）的 kind 联合**只有 `"image" | "text"`**；`X-PWH-Preview-Kind/Size/Bytes/Truncated/Dims` 由 `protocol/preview.ts` `PREVIEW_HDR`（L105–121）冻结。文本全量校验后截断 256 KiB（UTF-8 安全切点）可选 gzip；图片流式+末块扣留+sha256。协议侧取值集合：`PreviewUnsupportedReason = "binary"|"not-regular"|"dims-unknown"`（protocol L159）、`PreviewProbeKind = "text"|"image"|"missing"`（L34）。**新增目录 kind 需同时动：protocol 常量/类型、checkPreviewHeaders 的 kind 门（preview.js L493，现硬拒非 image|text 为 `E_BAD_RESPONSE`）、stream/routes 的 ⑧ 分支、audit `kind` 字段（routes.ts `AuditAcc.kind: "text"|"image"`）。**

## 3. UI 渲染层

- **状态机**：`composables/usePreview.ts` `open()`（L~145–200）：seq guard + AbortController；`settleError` 用 `classifyPreviewError`；成功分 `kind:"text"`（→ phase text）/ `kind:"image"`（FileReader→data: URL→phase image）。`PreviewView`（`ui/src/types.ts` **L354–387**）：`closed|loading|image|text|unsupported|tooLarge|error`——**无目录相**；`PreviewHandle` L390–405（含可选 `probe`）。
- **传输**：`transport/types.ts` `PreviewOutcome`/`PreviewTransport`（L~350–405）、`PreviewProbeOutcome`；两适配器 `transport/token.ts` L168–178、`transport/password.ts` L146–155 都是 logic client 的薄封装；实现在 `logic/token-client.js previewFetch`（L717–800：`checkPreviewHeaders` 先于 body、字节完整性比对 `chk.size`）与 `logic/password-client.js` L973+。
- **头校验/错误分类**：`logic/preview.js` `checkPreviewHeaders`（**L488**；kind 门 L493；gzip 时以 `X-PWH-Preview-Bytes` 为完整性 oracle L493–510）、`previewOutcomeFromResponse`（**L544**，非 200 映射）、`classifyPreviewError`（**L589**：unsupported/tooLarge/session-changed/error(+retryable)）。
- **渲染**：`components/preview/PreviewHost.vue` 按 phase 分支（loading/`PreviewImage`/`PreviewText`/unsupported/tooLarge/error）；`unsupportedReason` 对 `binary/not-regular/dims-unknown` 三种 reason 有 i18n（`ui/src/i18n/{en,zh}/preview.ts` 的 `reasonNotRegular` 等）。`PreviewText.vue` 高亮走 `logic/highlight.js resolveFileLang`。目录列表渲染需要新组件 + 新 phase/kind 分支 + i18n；App 级 provide 在 `App.vue` L174–177（`PREVIEW_CTX`）。

## 4. 测试面（新增目录支持时必改清单）

| 测试文件                                                                                                                                       | 覆盖                                                                                                                             | 目录支持改动点                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tests/web-hub/protocol/preview.test.ts`                                                                                                       | validatePreviewPath 正反例、四错误码、PREVIEW_HDR、常量关系                                                                      | 新 kind/头字段、（若放宽）尾斜杠规则                                     |
| `tests/web-hub/hub/preview/admit.test.ts` (619 行)                                                                                             | §4.3 全行、TOCTOU、FIFO、not-regular、home-as-cwd                                                                                | **必改**：目录从 415 not-regular 改为放行/新分支                         |
| `tests/web-hub/hub/preview/routes.test.ts` (1231 行)                                                                                           | ⓪–⑩ 全拒绝映射、dispose、限流、fd 泄漏、审计                                                                                     | ⑧ 分支新目录路径 + 审计 kind                                             |
| `tests/web-hub/hub/preview/probe.test.ts` (485 行)                                                                                             | 每类失败 ⇒ missing；请求级拒绝镜像                                                                                               | **必改**：目录条目的 kind（现 missing）                                  |
| `tests/web-hub/hub/preview/source-scan.test.ts` (81 行)                                                                                        | **钉死文件集**：`KERNEL_FILES = [sniff,admit,stream,verify,routes,open,probe]+fs.ts`；仅 fs.ts 可 import node:fs；禁 `readFile(` | **必改**：新内核文件（如 dir.ts/readdir 面）必须加入且 fs 访问只经 fs.ts |
| `tests/web-hub/hub/preview/stream.test.ts` / `fs.test.ts` / `verify.test.ts` / `memory.test.ts`                                                | 流式/复核/内存上限                                                                                                               | 若列表经 stream.ts 则改；HP3 式 RSS 上限适用于目录列举                   |
| `tests/web-hub/http/api-preview.test.ts` (721 行)、`lan-preview.test.ts` (428 行)、`api-preview-probe.test.ts`、`preview-e2e.test.ts` (745 行) | HTTP 矩阵、LAN gate、HP8 篡改、全真链路 e2e                                                                                      | 目录请求的 200/头/LAN 行为                                               |
| `tests/web-hub/hub/hub-preview.test.ts`、`tests/web-hub/agent/wiring-preview.test.ts`                                                          | caps 三态、settings→wire 下发                                                                                                    | 大概率不动（除非新 cap）                                                 |
| `tests/web-hub/ui/logic-preview.test.ts` (792 行)                                                                                              | **冻结识别规则**（含 :307 无扩展名相对路径不识别、:138 cwd 本身不可点）                                                          | 若放宽相对目录识别/尾斜杠，冻结用例必改                                  |
| `tests/web-hub/ui/logic-preview-probe.test.ts`、`use-preview-probe.test.ts`                                                                    | probe 纯逻辑/组合式                                                                                                              | 新 kind                                                                  |
| `tests/web-hub/ui/use-preview.test.ts`                                                                                                         | 全相位迁移、seq guard                                                                                                            | 新 phase                                                                 |
| `tests/web-hub/ui/preview-host.test.ts`、`preview-text/image.test.ts`、`preview-probe-path-text.test.ts`、`preview-wiring.test.ts`             | overlay/组件/接线                                                                                                                | 新分支渲染                                                               |

## 5. 红线与约束（目录预览必须继承的不变量）

1. **单一准入源**：目录路径必须走 `open.ts openAdmittedPath` 同一条链（probe/preview 永不各自实现防线）。probe 语义：「点击不可能成功 ⇒ missing」——目录若可预览，probe 必须能区分目录（新 kind 或复用 confirmed）。
2. **validatePreviewPath**：尾斜杠=非法（空段）、≥2 段、无 `./..`、≤4096 字节、无 NUL/CR/LF。`rp === rootRp` 拒绝 ⇒ **预览 cwd 根本身今天被拒**——「列出 cwd 根」要么改 admit.ts L246，要么明确不支持。
3. **cwd 类 13 步全保留**：虚拟根 `/proc /sys /dev /run`（literal+realpath 双查）、denylist（段/子路径/basename/扩展名/hub 前缀）、realpath×2+段对齐、`O_NOFOLLOW` 打开、fstat dev/ino、`/proc/self/fd` 复核、迟到 fd 回收、每步 ≤2s/总 8s 预算。目录列举必须对**每个列出的子项**保持同等防线（或仅列名字、点击子项仍走单路径准入——推荐后者）。
4. **upload 类不可能是目录**（byPath 索引+结构复核+`not-regular`→409/404）⇒ 目录预览天然 cwd 类 only。
5. **上限**：文本 256 KiB 截断、图片 16/4 MiB per listener、40MP/20MP、probe 100 条/8 KiB/5s、client 40s。**目录列举需自定条目数+字节预算**（UI/协议双端），并遵守内存上限测试风格（HP3）。
6. **审计**：日志永不落原始路径/文件名——仅长度、`ext`（≤16 字母数字）、HMAC-12 `pathTag`。目录响应含大量名字，审计面不能新增泄露。
7. **source-scan**：`src/web-hub/hub/preview/` 内仅 `fs.ts` 可 import node:fs，禁 `readFile(`；readdir 面必须放 fs.ts/新内核并更新扫描测试的文件集。
8. **LAN/loopback 分支点**：设置 `webHub.preview`（`agent/index.ts` L118–123、L788–792，默认 `"on"`，off=键缺席）→ `PI_WEBHUB_CONFIG` → `hub/main.ts` L98–110 fail-soft 复核 → caps（hub.ts L231–232）→ LAN 门 `mode==="on"`（http.ts L1306/L1326）→ listener 差异：图片字节帽 `PREVIEW_IMAGE_MAX_BYTES[io.listener]`、流预算 `PREVIEW_STREAM_MS`、authorize 段。目录功能必须沿用同一 §4.7 矩阵（loopback 可用、`"loopback"` 模式 LAN 404）。
9. **UI 安全**：CSP 不放宽（无 `blob:`，data: URL 仅图片路径）、markdown/PathText 无 innerHTML、DOM 等价规则（无 scope/流式/probe 未确认 ⇒ 纯文本）、probe 失败整批降级纯文本不重试。

## 6. ruled-out 的排查路径

- **「目录已经能被识别为 ref」**——成立（绝对路径、无尾斜杠），识别层对绝对目录无需改动；卡点全在 hub 端 not-regular 与 probe missing。
- **经 upload 类进目录**——不可能（结构复核钉死普通文件），无需排查 uploads 侧。
- **`mapFsError` 的 EISDIR 分支**——现状不可达（fstat 先拦），无需为新功能专门改。
- **复用 `hub/file-search.ts`（@补全端点）**——它是独立端点（同 cwd 安全面、同 §4.7 门），不在 preview 链上；可作「JSON 列表端点」先例，非本功能改动点。
- **stream.ts 承载目录列表**——现 `baseHeaders` kind 联合只有 image|text 且设计为「已打开普通文件的字节流」；目录列表更可能走 routes 新分支（读目录→JSON/文本），stream.ts 无需强改（除非复用其 sink/deadline 模式）。
