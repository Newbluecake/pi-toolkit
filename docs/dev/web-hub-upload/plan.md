# web-hub composer 文件粘贴上传 — 实施方案（v1）

> 状态：方案（未实施）。需求已拍板：浏览器 composer 粘贴 / 拖入 / 选择任意文件 → 上传到 hub →
> hub 落盘到受管临时目录 → 把**绝对路径**拼进 prompt 文本交给 pi。**只传路径**，不做
> ImageContent 内联；`cmd` 帧 `op:"prompt"` 协议（`protocol/messages.ts:179`）一个字节不改。
>
> 行号基于 `59793aa`（master HEAD，含工作区里另一个 UI 包的未提交改动）。

---

## 0. 结论速览

| 议题          | 结论                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上传通道      | **新 HTTP 端点、分块上传**：`POST /api/upload/{begin,chunk,commit,abort}`，chunk 用 `application/octet-stream` 原始字节；不走 cmd 帧 base64       |
| 分块大小      | hub 在 `begin` 回包里下发：loopback 4 MiB，LAN 1 MiB（受 15s `requestTimeout` 约束，见 §1.3）                                                     |
| 落盘          | `~/.pi/agent/web-hub/uploads/<bucket>/<uploadId>/<safeName>`，目录 0700、文件 0600；`bucket = s-<sessionId>`（无 session 时 `a-<agentKey>`）      |
| 上限          | 单文件 100 MiB；单 bucket 未发送+已提交 512 MiB；全局 2 GiB；单主体并发未完成上传 4，hub 全局 16；单条消息附件 ≤ 20 个                            |
| TTL           | 已提交文件 7 天（mtime）；未完成 `.part` 闲置 10 min 作废；hub 启动时扫一遍 + 每 30 min unref 定时扫                                              |
| prompt 格式   | 用户正文 + 空行 + 固定英文附件块（与 UI 语言无关，见 §3）                                                                                         |
| 鉴权          | 复用 `/api/cmd` 同一条写端点管线（strict CSRF + 两次 authorize + 令牌桶）；agent 须同时具备 `cmd.v1` 和 `upload.v1`（LAN 再要求 `upload.lan.v1`） |
| 类型白/黑名单 | **不做**，只做体积/数量/并发限制 + 文件名消毒 + 永不回传（无 GET 下载端点）                                                                       |
| 新设置        | `webHub.uploads: "on" \| "loopback" \| "off"`，默认 `"on"`（见 §8 待确认）                                                                        |

---

## 1. 上传通道选型

### 1.1 方案对比

| 维度                 | A. cmd 帧内联 base64（`op:"prompt"` 携带附件，或新 op）                                                                                                                                                                                                               | B. 新 HTTP 端点，单请求整文件                                                                         | **C. 新 HTTP 端点，分块（选定）**                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 体积上限             | 受 `MAX_BODY_BYTES=64 KiB`（`hub/http.ts:113`）、`PROMPT_TEXT_MAX_BYTES=48 KiB`（`hub/http.ts:1297`）、agent 侧 `PROMPT_MAX_BYTES`（`agent/commands.ts:95`）、NDJSON `MAX_FRAME_BYTES=4 MiB`（`protocol/ndjson.ts:10`）四重夹击；放大任何一个都牵动已冻结的 §3.3 预算 | 受 15s `requestTimeout`（`hub/http.ts:489` LAN、`:2209` loopback）约束：LAN Wi-Fi 下 100 MiB 必然超时 | 每块独立请求，单块 ≤ 4 MiB / 1 MiB，任何链路速度下都远低于 15s               |
| +33% 编码膨胀        | 是                                                                                                                                                                                                                                                                    | 否                                                                                                    | 否                                                                           |
| 对 agent 的影响      | 大文件走 unix socket，**队头阻塞** ev/status 帧；agent ledger 按 payload digest 去重（`agent/ledger.ts`），大 payload 进内存；文件要由 pi 进程落盘                                                                                                                    | 无（hub 落盘，agent 只收路径）                                                                        | 无                                                                           |
| 进度                 | 无（单帧）                                                                                                                                                                                                                                                            | `fetch` 无上传进度；XHR 有但 transport 层全是注入的 `fetch`                                           | 块级进度（每块一次回包），粒度足够                                           |
| 取消                 | 只能整体 abort，已发帧无法收回                                                                                                                                                                                                                                        | `AbortController` 可中断，但 hub 侧半截文件需清理                                                     | 每块 `AbortController` + 显式 `abort` 端点；hub 侧原子清理                   |
| 断点续传 / 重试      | 无                                                                                                                                                                                                                                                                    | 整文件重传                                                                                            | `chunk` 带 `offset`，hub 回 `received`，同块重试幂等（§2.5）                 |
| 与现有安全管线复用度 | 高                                                                                                                                                                                                                                                                    | 中                                                                                                    | 中（JSON 端点完全复用 `strictCsrfOk`，chunk 端点新增一个 octet-stream 变体） |

**结论：C。** A 与「prompt cmd op 协议不动」的拍板直接冲突，且把大字节流塞进 agent socket 违反 zero-hang
设计（ev 帧被阻塞）；B 在 LAN 上不可靠，而放大 `requestTimeout` 会破坏 `tests/web-hub/hub/deadline-nesting.test.ts:70-76`
钉住的 `WRITE_TOTAL_MS(13s) < requestTimeout(15s) < 浏览器 CMD_REQUEST_TIMEOUT_MS(16s)` 嵌套不变量。

### 1.2 端点定义（新增 `protocol/upload.ts` 冻结）

全部为 `POST`（落在现有 `handleApi`/LAN router 的 POST 分支里，见 §5 包 U3）：

```
POST /api/upload/begin    JSON  { agentKey, id, name, size, mime? }
  200 { id, chunkBytes, maxBytes, received }          // 同 id 重复 begin（参数一致）⇒ 同回包，received 为当前已收字节
  4xx { error, message? }

POST /api/upload/chunk?id=<id>&offset=<n>
  Content-Type: application/octet-stream ; X-PWH: 1 ; body ≤ chunkBytes
  200 { received }                                    // offset+len === received（已应用过的重发）⇒ 200 { received, dup:true }
  409 { error:"E_UPLOAD_OFFSET", received }           // offset ≠ received ⇒ 客户端从 received 续传

POST /api/upload/commit   JSON  { id }
  200 { id, path, name, size, mime, sha256, dedup? }  // received !== size ⇒ 409 E_UPLOAD_OFFSET

POST /api/upload/abort    JSON  { id }
  200 { ok:true }                                     // 未完成 ⇒ 删 .part；已提交且仍在本主体名下 ⇒ 删文件（用户在托盘里移除了未发送的附件）
```

- `id`：客户端生成，复用 `newCmdId()`（`ui/src/logic/control.js:39`，`getRandomValues`，K18 规则：LAN 明文无 `randomUUID`），
  hub 用 `CMD_ID_RE=/^[A-Za-z0-9_-]{16,64}$/`（`hub/http.ts:1295`）校验——字符集天然安全，直接当目录名。
- `id` 绑定首个 `begin` 的 **主体**（`${listener}:${user ?? "token"}`，同 `dispatchCmdOrDialog` 的 `principalKey`，`hub/http.ts:1649`）
  和 `agentKey`；其他主体用同 id ⇒ 404 `E_NOT_FOUND`（不泄露存在性）。
- `name`：仅作展示 + 消毒后作为文件名（§2.3）；`mime`：仅透传进 prompt 附件块，**不用于任何判定**。
- 新错误码（`protocol/http-contract.ts` 的 `API_ERRORS` 末尾追加，前端 `logic/contract.js:33` 是同一数组的 re-export，自动同步）：
  `E_UPLOAD_TOO_LARGE`(413)、`E_UPLOAD_QUOTA`(507)、`E_UPLOAD_OFFSET`(409)、`E_UPLOAD_DISABLED`(409)。

### 1.3 HTTP body 限制现状与放大策略

现状：

- `readBody()`（`hub/http.ts:292-326`）默认 `MAX_BODY_BYTES = 64 KiB`，`Content-Length` 超限直接 413，流式累计超限也 413；
  413/408 时 `onRequest`（`:2174`）/ `handleLanRequest`（`:1278`）会 `Connection: close` 并 destroy。
- 写端点 body 预算 `BODY_CAP_MS=4s`（`hub/req-deadline.ts`），读端点 `BODY_DEADLINE_MS=10s`（`hub/http.ts:116`）。
- 两个 listener 的 Node `requestTimeout = 15s`（`:489`、`:2209`），`headersTimeout = 10s`。

策略（**不改任何现有常量**）：

- `begin`/`commit`/`abort`：JSON，沿用 `MAX_BODY_BYTES` 与写端点预算。
- `chunk`：只对这一条路由调用 `readBody(req, chunkBytes, bodyMs)`。chunk 请求自建 `reqDeadline = createReqDeadline(now, UPLOAD_TOTAL_MS)`，
  `UPLOAD_TOTAL_MS = 14_000 < requestTimeout(15s)`；预算分配：首次 authorize ≤ `min(LAN_AUTH_CAP_MS=3s, remaining - 11s)`，
  body 读 `bodyMs = min(UPLOAD_CHUNK_BODY_MS=12s, remaining - 1s)`，二次 authorize 与写盘共用剩余 ≥ 1s（不足 ⇒ 504，块未写入，客户端按 §2.5 续传）。
  `deadline-nesting.test.ts` 追加断言 `UPLOAD_CHUNK_BODY_MS < UPLOAD_TOTAL_MS < LAN_REQUEST_TIMEOUT_MS < CMD_REQUEST_TIMEOUT_MS`。
- `chunkBytes`：loopback 4 MiB（本机内存拷贝，12s 足够），LAN 1 MiB（12s 内只需 ≈0.7 Mbps）。由 hub 下发，前端不硬编码。
- 内存上界：全局 16 个在途上传 × 单块 ≤ 4 MiB ⇒ 最坏 64 MiB 缓冲，可接受；块读完即写盘释放。

---

## 2. 临时目录管理

### 2.1 落盘位置

```
~/.pi/agent/web-hub/                 # stateDir，0700（protocol/paths.ts:158，hub.ts:128 已 ensurePrivateDir）
└── uploads/                         # 新增，0700，ensurePrivateDir(STATE_DIR_POLICY)
    └── s-<sessionId>/               # bucket：按 pi 会话分组；session 未知时 a-<agentKey>
        └── <id>/                    # 每次上传独占目录，mkdir 0700 非递归（EEXIST ⇒ 409，杜绝重用）
            ├── <safeName>.part      # 传输中：open(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0o600)
            └── <safeName>           # commit：fsync → rename（同目录，无覆盖可能）
```

理由：

- 放在 stateDir 下继承 0700 与属主校验；不放项目 cwd（污染仓库、可能被 git add）；不放 `/tmp`（多用户机器可见性 + systemd tmp 清理不可控）。
- 按 session 而非 agentKey 分组：agentKey 形如 `a<pid>-<nonce6>`（`hub/registry.ts:225-231`）随进程变化，sessionId 稳定，
  便于未来「随会话清理」与人工排查。sessionId 消毒为 `[A-Za-z0-9_-]{1,64}`，不符合则退回 `a-<agentKey>`。
- 每次上传独占 `<id>/` 子目录 ⇒ 同名文件不冲突，文件名可保持用户可读（模型 / 用户在 transcript 里看得懂）。
- 新增路径 helper：`protocol/paths.ts` 追加 `export function webHubUploadsDir(home)`（纯函数，additive，不改冻结的 `HubPaths` 接口）。

### 2.2 hub 侧组件 `hub/uploads.ts`（新文件，纯 fs，不碰 HTTP）

```ts
export interface UploadStore {
  begin(p: { principal; agentKey; bucket; id; name; size; mime? }): Promise<BeginResult>;
  chunk(p: { principal; id; offset; bytes: Buffer }): Promise<{ received: number; dup?: true }>;
  commit(p: { principal; id }): Promise<CommitResult>;
  abort(p: { principal; id }): Promise<void>;
  sweep(reason: "startup" | "tick" | "quota"): Promise<SweepReport>;
  inflight(): number;
  close(): Promise<void>; // hub 关闭：删所有 .part、清内存表
}
export function createUploadStore(deps: {
  root;
  now;
  log;
  limits?: Partial<UploadLimits>;
  fs?: Partial<FsDeps>;
}): UploadStore;
```

- 内存表 `Map<id, Rec>`：`{ principal, agentKey, dir, partPath, finalPath, size, received, hash: crypto.Hash, lastAt, lock: Promise }`。
- **串行化**：每个 id 一把 promise 锁，块严格按序（`offset === received`）；增量 `sha256` 依赖顺序。
- 每块写入：`open(partPath, O_WRONLY|O_NOFOLLOW)` → `write(buf, 0, len, offset)` → `close`（不跨请求持 fd，崩溃/超时无泄漏）。
- `commit`：`received === size` 校验 → `fsync` → `rename(part, final)` → 计算 sha256 → **内容去重**：同 bucket 内已有相同
  `sha256 + safeName` 的已提交文件 ⇒ 删除新文件、返回旧路径（`dedup:true`）。去重索引仅存内存（hub 重启后丢失只意味着少去重一次）。
- 全部定时器 `unref()`；所有 fs 调用经 `withDeadline` 包裹（5s），超时按失败处理并删 `.part`（zero-hang）。

### 2.3 文件名消毒 `sanitizeUploadName(raw)`（放 `protocol/upload.ts`，hub 与 UI 共用、可单测）

1. 非 string / 空 ⇒ `"file"`；`String.prototype.normalize("NFC")`。
2. 取最后一段：按 `/` 与 `\` 切分取末段（防 `../../x`、Windows 路径）。
3. 字符白名单：Unicode 字母/数字（`\p{L}\p{N}`）+ `._-`；其他（空格、控制字符、`:*?"<>|`、零宽、bidi 覆写 U+202E 等）全替换为 `_`，连续 `_` 折叠。
4. 去掉开头的 `.` 和 `-`（防隐藏文件、防模型执行 shell 时被当成选项），结尾去 `.`。
5. 保留扩展名截断：UTF-8 总长 ≤ 120 字节，扩展名（≤ 16 字节、仅 `[A-Za-z0-9]`）优先保留。
6. 结果为空或 `.`/`..` ⇒ `"file" + ext`。
7. hub 最终防线：`path.resolve(finalPath).startsWith(path.resolve(root) + "/")`，且 `lstat` 每级 bucket/id 目录非 symlink。

截图粘贴（`image.png` 或无名 Blob）由前端改名为 `pasted-YYYYMMDD-HHMMSS[-n].png`（`logic/upload.js`），扩展名按 MIME 映射。

### 2.4 体积与并发上限（`protocol/upload.ts` 常量，第一版不进 settings）

| 常量                            | 值                                           | 触发                                                                                                    |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `UPLOAD_FILE_MAX_BYTES`         | 100 MiB                                      | `begin` 的 `size` 超限 ⇒ 413 `E_UPLOAD_TOO_LARGE`；chunk 越界同样拒                                     |
| `UPLOAD_BUCKET_MAX_BYTES`       | 512 MiB                                      | 同 bucket 已提交 + 在途 `size` 合计                                                                     |
| `UPLOAD_TOTAL_MAX_BYTES`        | 2 GiB                                        | 全局；超限先 `sweep("quota")`（先 TTL 过期，再淘汰 >24h 的最旧已提交文件），仍超 ⇒ 507 `E_UPLOAD_QUOTA` |
| `UPLOAD_INFLIGHT_PER_PRINCIPAL` | 4                                            | 未 commit 的上传数 ⇒ 429 `E_RATE`                                                                       |
| `UPLOAD_INFLIGHT_HUB`           | 16                                           | 全局未 commit 数                                                                                        |
| `UPLOAD_ATTACH_MAX_PER_MSG`     | 20                                           | 前端托盘上限；附件块 ≤ 20×~200 B ≈ 4 KiB，远低于 48 KiB prompt 上限                                     |
| 令牌桶                          | `${principal}:upload` 容量 64 / 100ms 回填 1 | 复用 `createCmdLimit`（`hub/http.ts:1820`）同一实例，键空间不冲突                                       |

### 2.5 并发去重 / 幂等

- **begin 幂等**：同主体同 id、参数（agentKey/name/size）一致 ⇒ 返回同一结果与当前 `received`（网络超时后重试安全）；参数不一致 ⇒ 400。
- **chunk 幂等**：`offset + len === received` ⇒ 视为已应用的重发，200 `dup:true`（不重写、不重算 hash）；其余 `offset ≠ received` ⇒ 409 + `received`，前端从 `received` 续传。
- **commit 幂等**：已提交 ⇒ 返回同一结果。
- **前端去重**：同一 `File`（`name+size+lastModified+type`）在同一 agent 托盘里重复粘贴/拖入 ⇒ 只保留一份（`logic/upload.js` 的 `fileFingerprint`）。
- **内容去重**：见 §2.2 commit 步骤。

### 2.6 TTL 清理

| 对象                              | 规则                                         | 谁清                  | 何时                                                                                                   |
| --------------------------------- | -------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| 在途（内存表有、`.part`）         | `lastAt` 闲置 > 10 min                       | `UploadStore`         | 每 60s unref tick（只扫内存表，便宜）                                                                  |
| 孤儿 `.part`（hub 崩溃/重启遗留） | 一律删除                                     | `sweep("startup")`    | hub 启动，`ensurePrivateDir` 之后、`fe.listen()` 之前（`hub/hub.ts:317` 附近），失败只 warn 不阻断启动 |
| 已提交文件                        | mtime > 7 天                                 | `sweep("tick")`       | 启动 + 每 30 min unref 定时器                                                                          |
| 空的 `<id>/`、bucket 目录         | 删                                           | 同上                  | 同上                                                                                                   |
| 用户在托盘移除未发送附件          | 立即删                                       | `abort` 端点          | 前端 best-effort 调用；调用失败就等 TTL                                                                |
| hub 正常关闭                      | 删所有 `.part`、清内存表；**不删**已提交文件 | `UploadStore.close()` | `cleanup.push` 注册                                                                                    |

说明：

- hub 会 idle exit（`idleExitMinutes`），定时清理不可靠，所以**启动扫描是主清理点**，定时器只是补充。
- 已发送消息引用的文件 7 天后会被删；之后 resume 会话让模型去 read 会得到 ENOENT——接受此退化，附件块文案里不承诺永久保存。
- sweep 本身有总时限（10s）与单次删除数上限（2000），超出留给下一轮，绝不卡住 hub 启动。

---

## 3. prompt 注入格式

### 3.1 格式（`protocol/upload.ts` 的 `formatAttachmentBlock(items)`，纯函数）

```
<用户正文>

[web-hub attachments] The user attached 2 file(s), saved on this machine:
- /home/u/.pi/agent/web-hub/uploads/s-3f2a…/Xy7…/screenshot.png (image/png, 182 KB)
- /home/u/.pi/agent/web-hub/uploads/s-3f2a…/Ab9…/report_v2.pdf (application/pdf, 1.4 MB)
```

- 固定英文标记 `[web-hub attachments]`，**不随 UI 语言变化**：给模型的稳定锚点，也便于测试与将来在 transcript 里识别折叠。
- 路径独占一行、不加引号/反引号：消毒后的文件名不含空格与 shell 元字符（§2.3），路径可被模型原样复制给 `read`/`bash`。
  pi 的 `read` 工具能直接读图片，模型自然获得视觉输入，无需 ImageContent 内联。
- MIME 缺失时写 `unknown type`；大小用 `format.ts` 的同款 1024 进位格式化。
- 正文为空、只有附件 ⇒ 只发附件块（去掉开头空行）。

### 3.2 与 steer / followUp / 命令模式的交互

- 拼接发生在 **Composer 内部** `doSend()`（`Composer.vue:108-117`），emit 出去的仍是 `send(text, deliver)`（冻结的
  `ComposerEmits`，`contracts.ts:159-161`）——`DetailDock.onSend`（`DetailDock.vue:196-210`）、`useControl.sendPrompt`、
  hub、agent 全部零改动。steer 与 followUp 完全同构，附件块对两者一视同仁。
- 队列重试（`DetailDock.vue:225-236` 用 `item.text` 重发）天然带上附件块；文件 7 天内仍在 ⇒ 重试有效。
- **命令模式**：`parseSlash(text) !== undefined`（`logic/control.js:56`）且托盘非空 ⇒ `canSend=false` 并在托盘提示
  「附件只能随普通消息发送：移除附件，或用 `//` 开头按文本发送」。理由：`DetailDock.onSend` 会对整段文本再跑一次 `parseSlash`
  并走 `runCommand`，把路径拼进命令 args 语义不明。`//` 前缀走文本分支，与现状一致。
- **字节上限**：拼接后 `Buffer`-等价的 UTF-8 长度（`TextEncoder`）> 48 KiB ⇒ 禁止发送并提示（与 hub `PROMPT_TEXT_MAX_BYTES`、
  agent `PROMPT_MAX_BYTES` 对齐，前端只是提前拦）。
- 发送时机：托盘内存在 `uploading`/`failed` 项 ⇒ `canSend=false`，按钮 tooltip「等待上传完成 / 有上传失败的附件」。
  只有全部 `ready` 才拼接发送。发送后清空托盘（与正文同样乐观清空，`doSend` 现有语义）。

---

## 4. composer UX

### 4.1 三个入口

1. **粘贴**（`@paste` on textarea）：`classifyPaste(dt)`（`logic/upload.js`，纯函数，可用假 `DataTransfer` 单测）：
   - 收集 `dt.items` 中 `kind === "file"` 的 `getAsFile()`（兼容回落 `dt.files`）。
   - 无文件 ⇒ 不干预，默认文本粘贴。
   - 有文件且 `getData("text/plain")` 为空 ⇒ `preventDefault()`，全部作为附件。
   - 有文件**且**有文本（Office/表格复制会同时给出图片和文本；Finder 复制会给出文件名文本）⇒ 文件作为附件，文本照常粘贴（不 preventDefault）。
     第一版接受「Excel 单元格复制会多出一张截图附件」的副作用，用户可一键移除；在测试里钉住这一行为。
2. **拖拽**：在 `.composer` 根元素上 `dragenter/dragover/dragleave/drop`，用计数器避免子元素闪烁，`dataTransfer.types` 含 `Files`
   时显示「松开以添加附件」遮罩。`webkitGetAsEntry()?.isDirectory` ⇒ 拒收并提示「不支持文件夹」。只在 Composer 内部生效（不劫持整页）。
3. **附件按钮**：`composer-row` 左侧回形针图标按钮 + 隐藏 `<input type="file" multiple>`（`AppIcon` 新增 `paperclip` 图标；
   若 icons 目录需新增 svg，属于本包文件域）。移动端唯一可靠入口。

全部入口在 `!enabled`（只读）或 `!uploadAvailable`（§5 能力判定）时禁用/隐藏；拖拽遮罩不出现。

### 4.2 待发送附件托盘 `components/control/AttachmentTray.vue`（新）

- 位置：`composer-row` 之上（与 `CommandPalette` 同级，Composer 模板 `:149` 根 div 内部）。
- 每项：缩略图（仅 `image/*` 且 ≤ 10 MiB：`createImageBitmap` → 64px canvas → `toDataURL("image/jpeg")`；CSP
  `img-src 'self' data:`（`hub/http.ts:111`）允许 `data:`，**不引入 `blob:`、不改 CSP**）/ 其他类型显示扩展名图标、文件名（中间省略）、大小、状态、移除按钮。
- 状态：`queued` → `uploading(进度 %)` → `ready` | `failed(原因, 可重试)`；`removing`。
- 失败原因映射（i18n `upload.err.*`）：`E_UPLOAD_TOO_LARGE`「超过 100 MB」、`E_UPLOAD_QUOTA`「hub 临时空间已满」、`E_UPLOAD_DISABLED`「该 agent 未开启附件」、
  `E_AGENT_GONE`「agent 已离线」、`E_NOT_FOUND`（hub 重启后上传表丢失）「hub 已重启，请重试」、网络/超时「网络中断」。重试 = 新 id 从头 begin。
- 计数与总量：托盘头部「3 个附件 · 12.4 MB」；超 20 个时新加入的直接拒并提示。
- LAN 明文提示：`CONTROL_ENV.plaintext === true`（`App.vue:131`）时托盘底部常驻一行 warning：
  「明文 HTTP：附件内容在局域网内未加密传输」。**不改 `ControlNotice.vue`**（另一包在改）。
- a11y：托盘 `role="list"`，每项 `aria-label` 含文件名与状态；进度用 `aria-valuenow`；移除按钮可键盘操作；上传完成/失败经 `useAnnouncer` 播报。

### 4.3 状态归属

- 附件状态是 Composer 局部 UI 状态（与 drafts 同类，`useControl.ts:46` 的 `drafts` Map），**不进 reducer**：
  新 `composables/useUploads.ts` 持有 `Map<agentKey, ShallowRef<Attachment[]>>`，切换 agent 保留托盘、后台上传继续；刷新页面丢失（与 drafts 一致，无 localStorage——`source-scan.test.ts:163` 规则不变）。
- 纯状态机 `attachmentReduce(list, action)` 放 `logic/upload.js`，组件只调度。
- 上传调度：每个 agent 同时最多 2 个文件在传，块顺序上传；每块 `CMD_REQUEST_TIMEOUT_MS=16s` 超时（`logic/token-client.js:28`），超时后以 `begin` 幂等查询 `received` 续传，同块最多重试 3 次。

### 4.4 移动端限制（写进 i18n 帮助文案与本文档）

- iOS Safari 16+：长按粘贴图片会触发 `paste` 且带 file item，可用；从「文件」App 复制的非图片文件通常不可粘贴。
- Android Chrome：Gboard 剪贴板图片走 IME `commitContent`，网页 textarea **通常收不到** `paste` file item ⇒ 只能用附件按钮。
- 移动端无拖拽。⇒ `pointer: coarse` 时附件按钮始终显示且放大触控区（≥ 44px）。

---

## 5. 安全

1. **鉴权前提**：上传端点走与 `/api/cmd` 相同的写端点管线（`dispatchCmdOrDialog`，`hub/http.ts:1586-1774` 的同一套步骤）：
   strict CSRF → `authorize()` → 主体 pre 桶（30/s）→ hub 在途上限 → body 预算 → 解析 → upload 桶 → **再次 `authorize()`**（`:1688-1692` 同款，覆盖 logout / token 轮换竞态）。
   - 能力门槛（hub 侧强制，不信前端）：`registry.get(agentKey)` 存在且 live，`getCaps(agentKey)` 含 `cmd.v1` 与 `upload.v1`；
     LAN listener 额外要求 `upload.lan.v1`。缺失 ⇒ 409 `E_UPLOAD_DISABLED`。只在 `begin` 判定；后续块只验 id 归属（agent 中途下线不影响已开始的上传落盘，commit 时再验一次 agent 仍在，否则 410 `E_AGENT_GONE` 并删文件）。
   - agent 侧能力由 `capsExtra()`（`agent/index.ts:506-514`）发布：`control !== false` 且 `uploads === "on"` ⇒ `upload.v1` + `upload.lan.v1`；
     `uploads === "loopback"` ⇒ 仅 `upload.v1`；`"off"` ⇒ 都不发。旧 agent 不发 ⇒ 前端按钮隐藏，hub 拒绝。
   - hub 侧能力：新增 `UPLOAD_HUB_CAPS = ["upload.v1"]`（`protocol/version.ts`，不改 `P2_HUB_CAPS` 以免牵动 `agent-server-admin.test.ts`），
     在 `hub/hub.ts:227`（浏览器 `hub` 帧）与 `hub/agent-server.ts:153`（`hello_ack`）两处同时追加，保持两者逐字节一致的既有约定。
2. **CSRF（chunk 端点）**：新增 `uploadCsrfOk(req, expectedOrigin)`，与 `strictCsrfOk`（`hub/http.ts:1481-1493`）逐条相同，仅 `Content-Type`
   要求 `application/octet-stream`。`octet-stream` 与 `X-PWH` 自定义头都不是 CORS-safelisted ⇒ 跨源必须预检，而 hub 对 `OPTIONS` 一律 404（`:1095`），跨站无法发起。
3. **LAN 明文风险**：密码模式 + `http:` 时文件内容与 cookie 一样明文过局域网；同网段可嗅探、可篡改上传内容（但 commit 返回 sha256，可在 UI 详情里显示供人工核对，第一版不做比对）。
   缓解：设置项 `webHub.uploads: "loopback"` 可只允许本机上传；托盘常驻明文提示（§4.2）；`/webhub status` 里显示 uploads 模式。
   有反代 HTTPS（`webHub.lan.trustProxyFrom`）时 `plaintext=false`，不显示提示。
4. **类型白/黑名单：不做。** 理由：需求是「任意文件」；浏览器给的 MIME 与扩展名都可伪造，白名单只会误伤；hub 永不执行、永不解压、
   **永不通过 HTTP 回传**上传内容（不提供 GET 下载端点 ⇒ 不存在存储型 XSS / 内容嗅探问题）；文件 0600、无可执行位；
   真正的资源风险由体积 / 数量 / 并发 / 配额限制兜住。文件内容对模型而言是不可信数据（prompt injection 与用户粘贴文本同等风险，不新增攻击面），附件块措辞只陈述「用户附加了文件」。
5. **审计**（`hub/audit.ts`）：`ControlAuditRecord.endpoint` 追加 `"upload"`，新增白名单字段 `uploadId`、`bytes`、`ext`（消毒后扩展名）、`dedup`；
   每次上传只记 `begin` / `commit` / `abort` / `reject` 四种 phase（不逐块记，避免刷爆 hub.log）。**不记原始文件名、不记 sha256**（沿用 U7「不记正文，也不记正文哈希」）。
   reject 429 复用 `rejectAudit429` 节流（`:1627-1633`）。
6. **磁盘安全**：`O_NOFOLLOW` + `O_EXCL`、每级目录 `lstat` 非 symlink 且属主为当前 uid、`resolve` 前缀校验；uploads 根目录被替换成 symlink 指向别处 ⇒ `ensurePrivateDir` 的 owner 校验拒绝，上传整体禁用（`E_UPLOAD_DISABLED` + hub.log error）。

---

## 6. 文件域拆包与验收标准

依赖顺序：**U1 → (U2 ∥ U4a) → U3 → U4b → U5**。U2 与 U4a 无共享文件，可并行；U5 只依赖 U4 的接口。

### 与进行中 UI 包的冲突隔离

另一 dev 包（七项 UI 改进）当前工作区已改：`AgentList.vue`、`ControlNotice.vue`、`AgentDetail.vue`、`FleetPanel.vue`、`Transcript.vue`、
`TxCustom.vue`、`i18n/{en,zh}/{agents,control}.ts`、`styles/{agents,control,fleet}.css` 及对应测试。本方案**全部避开**这些文件：

- 不改 `AgentDetail.vue`/`controlContext.ts`：上传可用性在 Composer 内由 `@logic/upload.js` 的 `uploadAvailability({ hubCaps, card, authMode })`
  计算（`HUB_CTX.state.hub.caps` + `CONTROL_VIEW.agent.card.upload*` + `CONTROL_ENV.authMode`），`card` 原样透传（`state.js` 的 `mergeCard`），无需新 ControlView 字段。
- 不改 `control.css`：新建 `styles/upload.css`，由 `Composer.vue` 自行 `import`（同 `FleetPanel.vue:27` 的做法）。
- 不改 `i18n/*/control.ts`：新建 `i18n/{en,zh}/upload.ts` 命名空间（`i18n/index.ts:16-17` 用 `import.meta.glob` 自动收录，`i18n-parity.test.ts` 自动覆盖）。
- 不改 `DetailDock.vue`：拼接在 Composer 内完成，emit 签名不变。
- `Composer.vue` 主体由本方案独占；若对方包合入后 Composer 有冲突，以 rebase 解决（预计只有模板根 div 一处相邻）。
- **U5 必须在另一包提交后再开工**（同为 `components/control/**`，避免同时改 `Composer.vue`/同目录测试快照）。

---

### 包 U1 — 协议与设置（小）

文件域：

- `src/web-hub/protocol/upload.ts`（新）：端点路径常量、§2.4 限额常量、`UPLOAD_CHUNK_BYTES_{LOOPBACK,LAN}`、`UPLOAD_CHUNK_BODY_MS`、`UPLOAD_TOTAL_MS`、
  `sanitizeUploadName`、`formatAttachmentBlock`、`bucketFor(sessionId, agentKey)`、请求/回包 TS 类型。纯函数，无 node 依赖（UI 也 import）。
- `src/web-hub/protocol/version.ts`：`UPLOAD_HUB_CAPS`、`UPLOAD_AGENT_CAPS = ["upload.v1", "upload.lan.v1"]`。
- `src/web-hub/protocol/http-contract.ts`：`API_ERRORS` 追加 4 个码；`AgentCard` 追加 `upload?: boolean; uploadLan?: boolean`。
- `src/web-hub/protocol/paths.ts`：追加 `webHubUploadsDir(home)`。
- `src/web-hub/hub/registry.ts:175`：`card()` 追加 `upload: r.caps.includes("upload.v1"), uploadLan: r.caps.includes("upload.lan.v1")`。
- `src/web-hub/agent/index.ts:506-514`：`capsExtra()` 按 `settings.uploads` 发布能力。
- `src/config/settings.ts`：`WebHubSettings.uploads`、默认 `"on"`（`:807-818`）、解析（`:1500-1512` 同款三元）。
- `src/config/setting-specs.ts`：`"webHub.uploads": choice("webHub.uploads", ["on","loopback","off"], "web-hub: browser file attachments")`（`:272-279` 旁）。

验收：

- `tests/web-hub/protocol/upload.test.ts`（新）：消毒表驱动（`../../etc/passwd`、`C:\a\b.txt`、`.bashrc`、`-rf`、`a b?.png`、U+202E、超长中文名保扩展名、空串、`..`）；
  `formatAttachmentBlock` 快照（单/多文件、无 MIME、空正文）；`bucketFor` 非法 sessionId 回退。
- `tests/web-hub/hub/registry.test.ts` 追加 card `upload`/`uploadLan` 断言；`tests/web-hub/agent/wiring-control.test.ts` 追加三种设置下的 hello caps。
- `tests/web-hub/ui/logic-contract.test.ts` 仍绿（API_ERRORS 同源 re-export）。
- `npm run typecheck && npx vitest run tests/web-hub/protocol tests/web-hub/hub/registry.test.ts tests/web-hub/agent/wiring-control.test.ts tests/config`。

### 包 U2 — hub 上传存储（中）

文件域：`src/web-hub/hub/uploads.ts`（新）、`tests/web-hub/hub/uploads.test.ts`（新）。

内容：§2.2 `createUploadStore`、§2.5 幂等、§2.6 sweep、配额/并发计数、fs 超时包裹、`close()`。

验收（真实 tmpdir + 注入 `now`/假 fs）：

- 顺序写 + commit 后文件内容/大小/sha256 正确，权限 0600、目录 0700。
- 重发最后一块 ⇒ `dup`，乱序 ⇒ 抛 `E_UPLOAD_OFFSET` 带 `received`；跨主体同 id ⇒ `E_NOT_FOUND`。
- 超单文件 / bucket / 全局上限 ⇒ 对应错误；全局超限时先淘汰 TTL 过期与 >24h 最旧文件再判定。
- 内容去重：同 bucket 同 sha256+名 ⇒ 返回旧路径、新文件被删。
- 预置 symlink 的 bucket / id 目录 / `.part` ⇒ 拒绝且不写到链接目标。
- `sweep("startup")` 删除孤儿 `.part`、过期文件、空目录，且受 10s/2000 条上限约束（假 fs 计数）。
- 闲置 10 min 的在途上传被 tick 作废；所有 timer 均 unref（`vi.useFakeTimers` + 断言 `hasRef() === false`）。
- `close()` 后 `.part` 全删、已提交文件保留。

### 包 U3 — hub HTTP 路由与装配（中）

文件域：

- `src/web-hub/hub/upload-http.ts`（新）：`handleUploadRequest(req, res, path, query, opts)`，`opts` 与 `dispatchCmdOrDialog` 的 opts 同形
  （`listener / ip / authorize / registry / limit / rejectAudit429 / log / now`）+ `store: UploadStore` + `expectedOrigin` + `io: { readBody, sendJson }`
  （从 `http.ts` 注入私有 helper，避免为导出而重构 `http.ts`）；错误以 `{ status, code, message?, extra? }` 返回，由 `http.ts` 转 `HttpError`。
- `src/web-hub/hub/http.ts`：
  - loopback `handleApi`（`:2081` 起的 POST 分支）：在 `if (!csrfOk(req))`（`:2103`）**之前**插入 `if (path.startsWith("/api/upload/")) return handleUploadRequest(…)`，`authorize` 闭包复制 `:2088-2094`。
  - LAN router（`:1124` 起）：在 `if (!csrfOkLan(req, ctx))`（`:1145`）**之前**插入同样分支，`authorize` 闭包复制 `:1130-1136`（`requireLanSession`）。
  - 新增 `uploadCsrfOk`（紧挨 `strictCsrfOk`，`:1481`）。
  - `createHttpFrontend`：读取 `deps.uploads`；缺省 ⇒ 上传路由 501 `E_NOT_IMPLEMENTED`（与 `commands === undefined` 同款，`:1647`）。
- `src/web-hub/hub/ports.ts`：`FrontendDeps` 追加可选 `uploads?: UploadStore`（additive，同 `commands?` 先例 `:482`）。
- `src/web-hub/hub/hub.ts`：`ensurePrivateDir(uploadsDir)` → `createUploadStore` → `await sweep("startup")`（`withDeadline` 10s、失败只 warn）→ 传入 `frontend({ …, uploads })`（`:317-335`）→
  30 min unref 定时 `sweep("tick")` → `cleanup.push(() => uploads.close())`；`:227` caps 追加 `UPLOAD_HUB_CAPS`。
- `src/web-hub/hub/agent-server.ts:153`：`hello_ack.caps` 追加 `UPLOAD_HUB_CAPS`。
- `src/web-hub/hub/audit.ts`：`endpoint` 联合追加 `"upload"`，新增白名单字段。

验收：

- `tests/web-hub/http/api-upload.test.ts`（新，loopback，沿用 `tests/web-hub/http/helpers.ts`）：完整 begin→chunk×N→commit 流程；未登录 401；
  缺 X-PWH / 错 Content-Type / 跨 Origin / `Sec-Fetch-Site: cross-site` ⇒ 403；agent 无 `upload.v1` ⇒ 409 `E_UPLOAD_DISABLED`；
  chunk 超 `chunkBytes` ⇒ 413 且连接关闭；`Content-Length` 撒谎（声明小、实发大）⇒ 413；body 读超时 ⇒ 408；
  logout 竞态（第二次 authorize 失败）⇒ 401 且无字节落盘；令牌桶 429 带 `Retry-After`；`deps.uploads` 缺省 ⇒ 501。
- `tests/web-hub/http/lan-upload.test.ts`（新，沿用 `lan-helpers.ts`）：LAN 会话鉴权；agent 只有 `upload.v1` 没有 `upload.lan.v1` ⇒ 409；chunkBytes = 1 MiB。
- `tests/web-hub/hub/audit.test.ts` 追加：upload 审计行不含原始文件名与 sha256（源码级 + 运行时双断言，沿用该文件已有的 U7 断言风格）。
- `tests/web-hub/hub/deadline-nesting.test.ts` 追加：`UPLOAD_TOTAL_MS < LAN_REQUEST_TIMEOUT_MS < CMD_REQUEST_TIMEOUT_MS`，`UPLOAD_CHUNK_BODY_MS < UPLOAD_TOTAL_MS`。
- `tests/web-hub/hub/agent-server-admin.test.ts` 与 `hub.test.ts` 更新 caps 期望（`hub` 帧与 `hello_ack` 一致）。
- `tests/web-hub/http/security.test.ts`：CSP 字符串**不变**的断言保持绿。

### 包 U4 — 前端传输与逻辑层（中；可拆 U4a 纯逻辑 ∥ U2，U4b transport 在 U3 后）

文件域：

- U4a `src/web-hub/ui/src/logic/upload.js`（新，纯 JS + JSDoc）：`classifyPaste`、`collectDrop`、`fileFingerprint`、`pastedName(mime, now)`、
  `attachmentReduce`、`planChunks(size, chunkBytes)`、`composePrompt(text, readyItems)`（调 `@protocol/upload.ts` 的 `formatAttachmentBlock`）、
  `canSendWithAttachments({ text, items, commandMode })`、`uploadAvailability({ hubCaps, card, authMode })`、`utf8Len`。
- U4b：
  - `src/web-hub/ui/src/logic/contract.js:36-46`：`API` 追加 `uploadBegin/uploadChunk/uploadCommit/uploadAbort`。
  - `src/web-hub/ui/src/logic/token-client.js`：新增 `uploadBegin/Chunk/Commit/Abort`，JSON 三个复用 `postRaw` + `withRelogin`；chunk 用 `request()`（`:87-107`）发
    `{ method:"POST", headers:{ "Content-Type":"application/octet-stream", "X-PWH":"1" }, body: blob.slice(a,b) }`，支持外部 `AbortSignal`（与内部超时 AC 合并）。
  - `src/web-hub/ui/src/logic/password-client.js`：同上，基于 `postApi`（`:265`）/`request`，401 走现有 `onConn("auth")` 路径，503 `E_BUSY` 复用现有退避重试。
  - `src/web-hub/ui/src/transport/{types,token,password}.ts`：`HubTransport` 追加**可选** `upload?: UploadTransport`（additive，旧测试替身不受影响）。
  - `src/web-hub/ui/src/composables/useUploads.ts`（新）：per-agent 托盘、调度（每 agent 2 文件并发、块重试 3 次、`begin` 幂等续传）、缩略图生成、`remove()` 调 abort。
  - `src/web-hub/ui/src/types.ts`（`ControlHandle`，`:129-145`）追加可选 `uploads?: UploadHandle`；`src/web-hub/ui/src/composables/useControl.ts` 在 `transport.upload` 存在时挂上 `useUploads(transport.upload)`。

验收：

- `tests/web-hub/ui/logic-upload.test.ts`（新）：粘贴分类三种情形（仅文本 / 仅文件 / 文件+文本）、目录拒收、指纹去重、截图改名、
  状态机全转移表（含 failed→retry、removing、agent 切换保留）、`composePrompt` 与 48 KiB 边界、命令模式阻断、`uploadAvailability` 真值表（hub 无 cap / agent 无 cap / LAN 无 lan cap / 只读）。
- `tests/web-hub/ui/transport-contract.test.ts` 追加：两个 transport 都暴露同形 `upload`，同一套假 `fetch` 用例（chunk 的 header/body、409 续传、401、超时）对两者都过。
- `tests/web-hub/ui/use-control.test.ts` / 新 `use-uploads.test.ts`：调度并发上限、续传从 `received` 开始、abort 中断在途 fetch 并调用 abort 端点、hub 重启（404）⇒ failed。
- `tests/web-hub/ui/source-scan.test.ts` 保持绿（无 `randomUUID`、无 `localStorage`、无 `innerHTML`；`createObjectURL` 不使用）。

### 包 U5 — Composer UI（中；**等另一 UI 包提交后开工**）

文件域：

- `src/web-hub/ui/src/components/control/Composer.vue`：`@paste`（textarea `:159-172`）、根 div（`:149`）拖拽事件与遮罩、附件按钮 + 隐藏 file input、
  挂 `AttachmentTray`、`canSend`（`:80-85`）并入 `canSendWithAttachments`、`doSend`（`:108-117`）用 `composePrompt` 拼接后 emit 并清托盘、`import "../../styles/upload.css"`。
- `src/web-hub/ui/src/components/control/AttachmentTray.vue`（新）。
- `src/web-hub/ui/src/styles/upload.css`（新）。
- `src/web-hub/ui/src/i18n/en/upload.ts`、`src/web-hub/ui/src/i18n/zh/upload.ts`（新）。
- `src/web-hub/ui/src/icons/`：如需新增 `paperclip`/`file` 图标（仅追加）。

验收：

- `tests/web-hub/ui/composer-upload.test.ts`（新，happy-dom + `@vue/test-utils`，沿用 `composer.test.ts:1-60` 的注入替身）：
  粘贴图片 ⇒ 托盘出现、上传完成后 Send 可用、emit 文本含附件块；文件+文本粘贴 ⇒ 文本仍进 textarea；拖入目录 ⇒ 提示且托盘不变；
  上传中 / 失败 ⇒ Send 禁用；`/cmd` + 附件 ⇒ 禁用并显示提示，`//` 前缀 ⇒ 可发；只读 / 无能力 ⇒ 三入口全部不可用；
  plaintext ⇒ 显示明文提示；移除 ready 附件 ⇒ 调用 abort；steer 与 followUp（Alt+Enter）两条路径 emit 的文本一致；空正文 + 附件 ⇒ 可发。
- 原 `tests/web-hub/ui/composer.test.ts` 全绿（无附件时行为逐字节不变）。
- `i18n-parity.test.ts`、`source-scan.test.ts`（无 `<style>` 块、无静态 `style=`）绿。
- `npm run build:web && npm run check:web` 通过；CSP 不变下缩略图正常显示（`data:`）。
- 手工真机（tmux + 浏览器，参照 live-acceptance 流程）：loopback 粘贴截图 → pi 用 `read` 读到图片；LAN 手机端附件按钮上传 20 MB 文件；hub 重启后孤儿 `.part` 被清；`webHub.uploads:"loopback"` 时 LAN 页面无附件入口且直接 curl 被 409。

### 全局闸门（每包合入前）

`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

---

## 7. 测试策略汇总

| 层       | 新/改测试文件                                                                                                                            | 关键覆盖点                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| protocol | `tests/web-hub/protocol/upload.test.ts`                                                                                                  | 文件名消毒表、附件块格式快照、bucket 回退                                   |
| config   | `tests/config/*`（settings 解析 / spec）                                                                                                 | `webHub.uploads` 三值 + 非法值回落默认                                      |
| agent    | `tests/web-hub/agent/wiring-control.test.ts`                                                                                             | 三种设置下 hello caps；`control:false` 时一律不发 upload caps               |
| hub 存储 | `tests/web-hub/hub/uploads.test.ts`                                                                                                      | 幂等、配额、去重、symlink、sweep、unref、close                              |
| hub HTTP | `tests/web-hub/http/api-upload.test.ts`、`lan-upload.test.ts`、`audit.test.ts`、`deadline-nesting.test.ts`、`agent-server-admin.test.ts` | CSRF/鉴权/能力门槛/413/408/429/竞态 reauth、审计白名单、超时嵌套、caps 一致 |
| ui logic | `tests/web-hub/ui/logic-upload.test.ts`、`transport-contract.test.ts`、`use-uploads.test.ts`                                             | 粘贴分类、状态机、拼接与 48 KiB、两 transport 对称                          |
| ui 组件  | `tests/web-hub/ui/composer-upload.test.ts` + 既有 `composer.test.ts`                                                                     | 三入口、托盘状态、发送闸门、命令模式交互、无附件零回归                      |
| 构建     | `npm run build:web && npm run check:web`                                                                                                 | Vite 产物、manifest                                                         |

---

## 8. 待确认 / 开放问题

1. `webHub.uploads` 默认 `"on"`（LAN 也开）还是 `"loopback"`（LAN 默认关）？本方案按用户需求取 `"on"` + 明文提示；若更看重 LAN 默认安全可改默认值，代码无差异。
2. 限额（100 MiB / 512 MiB / 2 GiB / 7 天）第一版写死在 `protocol/upload.ts`。若需可配，需要把值经 `HubConfig`（`agent/index.ts:484-503` 的 `buildHubConfig`）传给 hub——hub 进程不读 settings.json，这是额外一包。
3. transcript 中用户消息里的 `[web-hub attachments]` 块是否折叠显示为附件 chip？涉及 `components/transcript/**`（另一包正在改），列为后续项。
4. 会话结束（`/new`、agent 退出）时是否提前删除该 bucket？当前只靠 7 天 TTL，因为 resume 旧会话时路径仍可能被需要。
