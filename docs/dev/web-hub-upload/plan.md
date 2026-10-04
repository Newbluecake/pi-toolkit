# web-hub composer 文件粘贴上传 — 实施方案（v3）

> 状态：方案（未实施）。需求已拍板：浏览器 composer 粘贴 / 拖入 / 选择任意文件 → 上传到 hub →
> hub 落盘到受管临时目录 → 把**绝对路径**拼进 prompt 文本交给 pi。**只传路径**，不做
> ImageContent 内联；`cmd` 帧 `op:"prompt"` 协议（`protocol/messages.ts:179`）一个字节不改。
>
> 基线：`060c33b`（七项 UI 改进）**已合入** master；行号基于 `5afa90d`。U5 开工前须过 §6 的 diff 闸门。

## v2 修订记录（评审 r_DW78DCMQ：1 blocker / 12 major / 2 minor / 1 nit）

| #   | 级别    | 意见                                                        | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 落点                      |
| --- | ------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | blocker | LAN 明文上传风险，默认不应 on                               | **用户裁定：维持默认 `on`**。新增「威胁模型与已接受风险」一节，写明可嗅探/可篡改、sha256 的证明范围、缓解手段；记为用户决策，复审不再争论                                                                                                                                                                                                                                                                                                                                        | §5.0                      |
| 2   | major   | `mime` 进正文可注入                                         | hub 侧 RFC 7230 token 严格校验（type/subtype 各 ≤ 64、总 ≤ 127、拒控制字符/换行/参数），不合格**丢弃**；附件块只用 hub 回包的已校验 mime，`formatAttachmentBlock` 再校验一次；补注入用例                                                                                                                                                                                                                                                                                         | §1.2、§3.1、U1/U2         |
| 3   | major   | uploads 根 / 中间目录 symlink                               | 不再用 `ensurePrivateDir(STATE_DIR_POLICY)`（它用 `stat` 跟随链接，`paths.ts:257-265`）；新增 `hub/upload-fs.ts` 的 `ensureUploadDir`：每级 `lstat`、拒 symlink、属主/模式校验、记录 dev/ino，打开文件用 `O_NOFOLLOW`，打开后 `fstat` + 父链 dev/ino 复核                                                                                                                                                                                                                        | §2.2.1、U2                |
| 4   | major   | commit `rename` 可覆盖                                      | 改为 no-replace：`link(part, final)` + `unlink(part)`（先例 `memory/safe-fs.ts:410-449` `createExclusive`），`EEXIST` ⇒ `E_UPLOAD_CONFLICT`；无硬链接时退化为持锁 check-then-rename 并记 `note`；补目标已存在用例                                                                                                                                                                                                                                                                | §2.2.3、U2                |
| 5   | major   | 崩溃一致性                                                  | 每个上传目录一个 `meta.json`（commit 最后一步原子写入）；不变量「回包成功 ⇔ 磁盘为 committed 形态」；启动全量扫描按状态表恢复并**重建配额/去重/引用索引**，扫描完成前 begin 返回 503                                                                                                                                                                                                                                                                                             | §2.2.4、§2.6、U2          |
| 6   | major   | short write                                                 | `writeAllAt(fh, buf, pos)` 循环（等价 `safe-fs.ts:355-367` `writeAll`，异步版）；完整写入后才更新 `received`/hash；失败 `ftruncate(received)`，截断也失败则作废；注入 short write 用例                                                                                                                                                                                                                                                                                           | §2.2.2、U2                |
| 7   | major   | deadline 未传进存储层                                       | `UploadStore` 每个方法收请求绝对 deadline，每步 fs 用 `min(FS_STEP_CAP_MS, remaining)`；到期 ⇒ 该上传**作废**（poison），迟到的 fs 结果不再改状态，待在途操作落定后删目录；慢 fs/断连用例                                                                                                                                                                                                                                                                                        | §2.2.5、U2/U3             |
| 8   | major   | 配额淘汰与引用生命周期冲突                                  | hub 在 `/api/cmd` prompt/steer 成功（或 effect unknown）后解析附件块，把命中的上传标记 `referencedAt`；**已引用文件不被配额淘汰**，只按 7 天 TTL 过期；未引用文件 24h TTL、超配额时可淘汰（>1h）；淘汰写审计                                                                                                                                                                                                                                                                     | §2.6、U3                  |
| 9   | major   | 去重未绑定主体                                              | 去重键 `principal + bucket + sha256 + safeName`，返回前复核主体；不同主体同内容各存一份；跨用户边界写清                                                                                                                                                                                                                                                                                                                                                                          | §2.5、§5.1                |
| 10  | major   | `toCard()` 白名单遗漏                                       | `hub/http.ts:338-360` `toCard()` 纳入 U1 文件域；验收覆盖初始 `agents` 帧（`:767`）、`agent_up`（`:667`）、断线重连三条路径一致                                                                                                                                                                                                                                                                                                                                                  | U1                        |
| 11  | major   | 审计 schema 未定义                                          | `hub/audit.ts` 新增 `UploadAuditRecord` + `auditUpload()`（运行时白名单裁剪），定义 phase/op/字节/关联字段与周期性 `upload stats` 聚合行                                                                                                                                                                                                                                                                                                                                         | §5.4、U3                  |
| 12  | major   | 发送校验不唯一                                              | `Composer.vue` 引入 `sendGate()`，`doSend()` 首行即调用，按钮 `:disabled` 与键盘 Enter/Alt+Enter 共用；三路径用例                                                                                                                                                                                                                                                                                                                                                                | §3.2、§4、U5              |
| 13  | major   | 正常 close 不清理                                           | 现状：运行期 `close()`（`hub/hub.ts:635-661`）**不执行** `cleanup` 数组（只在启动失败 `:677` 执行）。v2 在 `close()` 里 `fe.close()` 之后显式 `await bounded(uploads.close())`；覆盖正常/SIGTERM/crash 三路径                                                                                                                                                                                                                                                                    | §2.6、U3                  |
| 14  | minor   | 路径 shell 转义承诺不成立                                   | 撤回「路径无需引号」：只保证路径可原样交给 `read`；附件块明示 shell 使用需加引号（home 前缀可能含空格/元字符）                                                                                                                                                                                                                                                                                                                                                                   | §3.1                      |
| 15  | minor   | 基线 commit 过时                                            | 基线改为「`060c33b` 已合入」；新增 U5 开工前 diff 闸门（另有 CommandPalette/Transcript 改动在途）                                                                                                                                                                                                                                                                                                                                                                                | 文档头、§6                |
| 16  | minor   | 故障注入/恢复测试应为硬门槛                                 | U2/U3 验收单列「硬门槛」小节，不通过不得合入                                                                                                                                                                                                                                                                                                                                                                                                                                     | U2、U3                    |
| 17  | nit     | chunk 双档与令牌桶缺依据                                    | 保留双档，写明带宽/超时/内存推导与两档都要跑通的验收；令牌桶保留并列出观测指标（stats 聚合行）                                                                                                                                                                                                                                                                                                                                                                                   | §1.3、§2.4、§5.4          |
| 4   | v3      | 复审：退化路径 lstat+rename 仍有检查后创建窗口              | **删除退化路径**（二选一取「不支持硬链接即禁用」）：hub 构造 `UploadStore` 时在 uploads 根做一次 `link` 探针，失败 ⇒ 本次生命周期上传禁用（`E_UPLOAD_DISABLED`，reason `no-hardlink`）；commit 时 `link` 意外返回 EPERM/ENOTSUP ⇒ 作废删目录、回 `E_UPLOAD_DISABLED`，**从不 rename 到 final**；EXDEV 不可能（同目录）；并发同 id commit 由 per-id 锁串行，第二个得幂等结果；附带改动：§5.4 `note` 字段删去 `non-atomic-commit` 取值                                             | §2.2.3、§5.4、U2 硬门槛 2 |
| 8   | v3      | 复审：markReferenced 在回包后异步执行，sweep 可在窗口内淘汰 | 拆成「同步内存保护 + 有界持久化」：转发前在 `http.ts:1717-1759` 的既有同步区 `pinForPrompt()` 钉住附件（已在淘汰中/不存在 ⇒ 409 `E_UPLOAD_GONE` 且不转发）；`commands.request()` 返回后、`sendCmdResult` 之前同步 `settlePins()` 写内存 `referencedAt`，再有界等待 meta 持久化 ≤ `min(1s, remaining-300ms)`；超时/失败**不阻塞成功回包**，记 `dirty` 由 tick 重试，内存引用期间 sweep 一律豁免；淘汰端在 per-id 锁内同步「复核 pin/referenced + 置 evicting」；新增 6 条竞态用例 | §1.2、§2.6、U3            |

---

## 0. 结论速览

| 议题          | 结论                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上传通道      | **新 HTTP 端点、分块上传**：`POST /api/upload/{begin,chunk,commit,abort}`，chunk 用 `application/octet-stream` 原始字节；不走 cmd 帧 base64                      |
| 分块大小      | hub 在 `begin` 回包里下发：loopback 4 MiB，LAN 1 MiB（依据见 §1.3）                                                                                              |
| 落盘          | `~/.pi/agent/web-hub/uploads/<bucket>/<id>/{<safeName>, meta.json}`，目录 0700、文件 0600，根以下每级拒 symlink；`bucket = s-<sessionId>`（无则 `a-<agentKey>`） |
| 提交语义      | `link`+`unlink` no-replace；`meta.json` 最后原子落盘；启动全量扫描恢复并重建索引                                                                                 |
| 上限          | 单文件 100 MiB；单 bucket 512 MiB；全局 2 GiB；单主体未完成上传 4、hub 全局 16；单条消息附件 ≤ 20                                                                |
| 生命周期      | 已被 prompt 引用：7 天 TTL、不被配额淘汰；未引用：24h TTL、超配额时 >1h 可淘汰；未完成：闲置 10 min 作废                                                         |
| prompt 格式   | 用户正文 + 空行 + 固定英文附件块（§3）；只保证路径可直接给 `read`                                                                                                |
| 鉴权          | strict CSRF + 两次 authorize + 令牌桶；agent 须具备 `cmd.v1` + `upload.v1`（LAN 另需 `upload.lan.v1`）                                                           |
| 类型白/黑名单 | **不做**；mime 只做格式校验（防注入），不做判定；永不回传（无 GET 下载端点）                                                                                     |
| 新设置        | `webHub.uploads: "on" \| "loopback" \| "off"`，默认 `"on"`（**用户裁定**，§5.0）                                                                                 |

---

## 1. 上传通道选型

### 1.1 方案对比

| 维度               | A. cmd 帧内联 base64                                                                                                                                                                                                     | B. 新 HTTP 端点，单请求整文件                                          | **C. 新 HTTP 端点，分块（选定）**                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 体积上限           | 受 `MAX_BODY_BYTES=64 KiB`（`hub/http.ts:113`）、`PROMPT_TEXT_MAX_BYTES=48 KiB`（`hub/http.ts:1297`）、agent `PROMPT_MAX_BYTES`（`agent/commands.ts:95`）、NDJSON `MAX_FRAME_BYTES=4 MiB`（`protocol/ndjson.ts:10`）夹击 | 受 15s `requestTimeout`（`hub/http.ts:489` LAN、`:2209` loopback）约束 | 每块独立请求，远低于 15s                                         |
| 编码膨胀           | +33%                                                                                                                                                                                                                     | 无                                                                     | 无                                                               |
| 对 agent 的影响    | 大帧走 unix socket，队头阻塞 ev/status；ledger 按 payload digest 去重（`agent/ledger.ts`）大 payload 进内存                                                                                                              | 无                                                                     | 无                                                               |
| 进度 / 取消 / 续传 | 无 / 整体 / 无                                                                                                                                                                                                           | 无（`fetch` 无上传进度）/ 可中断但需清理 / 整文件重传                  | 块级进度 / 每块 `AbortController` + `abort` 端点 / `offset` 续传 |

**结论：C。** A 与「prompt 协议不动」冲突且把字节流塞进 agent socket（违反 zero-hang）；B 在 LAN 上不可靠，放大
`requestTimeout` 又会破坏 `tests/web-hub/hub/deadline-nesting.test.ts:70-76` 钉住的 `13s < 15s < 16s` 嵌套不变量。

### 1.2 端点定义（`protocol/upload.ts` 冻结）

```
POST /api/upload/begin    JSON  { agentKey, id, name, size, mime? }
  200 { id, chunkBytes, maxBytes, received }   // 同主体同 id 且参数一致 ⇒ 同回包（received 为当前值）
POST /api/upload/chunk?id=<id>&offset=<n>     Content-Type: application/octet-stream ; X-PWH: 1 ; body ≤ chunkBytes
  200 { received } | 200 { received, dup:true } | 409 { error:"E_UPLOAD_OFFSET", received }
POST /api/upload/commit   JSON  { id }
  200 { id, path, size, mime?, dedup? }        // received !== size ⇒ 409 E_UPLOAD_OFFSET
POST /api/upload/abort    JSON  { id }
  200 { ok:true }
```

- `id`：客户端 `newCmdId()`（`ui/src/logic/control.js:39`，K18：LAN 明文无 `randomUUID`）；hub 用 `CMD_ID_RE`（`hub/http.ts:1295`）校验后直接当目录名。
  `id` 绑定首个 `begin` 的主体（`${listener}:${user ?? "token"}`，同 `hub/http.ts:1649` 的 `principalKey`）与 `agentKey`；他人用同 id ⇒ 404（不泄露存在性）。
- `name`：只经 `sanitizeUploadName`（§2.3）后作为文件名；原始名不落盘、不进日志、不回包。
- **`mime`（#2）**：`normalizeMime(raw)`——trim、转小写，必须匹配
  `^[!#$%&'*+.^_`|~0-9a-z-]{1,64}/[!#$%&'*+.^_`|~0-9a-z-]{1,64}$`（RFC 7230 `token "/" token`），总长 ≤ 127 字节；含 `;`参数、空白、控制字符、
非 ASCII 一律**丢弃**（视为未提供，审计`mimeDropped:true`），不拒绝请求（浏览器 `File.type`常为空或怪值）。commit 回包里的`mime` 是唯一进入附件块的来源。
- 回包**不再返回 `sha256`**（v1 有）：sha256 仅 hub 内部用于去重，不暴露给浏览器（与 §5.1 跨用户侧信道一致）。
- 新错误码（追加到 `protocol/http-contract.ts` 的 `API_ERRORS`，前端 `logic/contract.js:33` 是同一数组 re-export）：
  `E_UPLOAD_TOO_LARGE`(413)、`E_UPLOAD_QUOTA`(507)、`E_UPLOAD_OFFSET`(409)、`E_UPLOAD_DISABLED`(409)、`E_UPLOAD_CONFLICT`(409，#4)、`E_UPLOAD_GONE`(409，v3 #8：`/api/cmd` 的 prompt 引用了已被淘汰/不存在的本人附件，`retryable:false, effect:"none"`)。
  另复用 `E_BUSY`(503，启动扫描未完成)、`E_DEADLINE`(504)、`E_HUB_RESTARTING`(503，closing)。

### 1.3 body 限制与分块双档依据（#17）

现状（不改任何现有常量）：`readBody()`（`hub/http.ts:292-326`）默认 64 KiB；写端点 body 预算 `BODY_CAP_MS=4s`（`hub/req-deadline.ts`）；两 listener
`requestTimeout=15s`、`headersTimeout=10s`。

- `begin/commit/abort`：JSON，沿用 `MAX_BODY_BYTES` 与写端点预算。
- `chunk`：自建 `reqDeadline = createReqDeadline(now, UPLOAD_TOTAL_MS=14_000)`（< 15s）；首次 authorize ≤ `min(LAN_AUTH_CAP_MS=3s, remaining-11s)`；
  body 读 `min(UPLOAD_CHUNK_BODY_MS=12s, remaining-1s)`；二次 authorize + 写盘共用剩余（< 1s ⇒ 504，块未写入）。`deadline-nesting.test.ts` 追加
  `UPLOAD_CHUNK_BODY_MS < UPLOAD_TOTAL_MS < LAN_REQUEST_TIMEOUT_MS < CMD_REQUEST_TIMEOUT_MS`。
- **双档依据**：
  - LAN 1 MiB：12s 内读完只需 ≈ 0.7 Mbps；若用 4 MiB 则需 ≈ 2.8 Mbps，手机弱信号/拥塞 2.4 GHz Wi-Fi 下有实际超时风险。LAN 每块要过 `requireLanSession`
    （SQLite 子进程 `touchSession`）两次，块数不宜过多：100 MiB = 100 块，可接受。
  - loopback 4 MiB：本机拷贝无带宽问题；100 MiB 从 100 块降到 25 块，减少 4× 请求/鉴权开销。内存上界 = hub 在途 16 × 4 MiB = 64 MiB。
  - 验收：U3 集成测试两档各跑一次 100 MiB 合成文件（loopback 真实 socket；LAN 档用 `lan-helpers.ts`），断言完成且 hub RSS 增量 < 128 MiB；commit 审计行的
    `chunks`/`ms` 字段给出现场观测数据。

---

## 2. 临时目录管理

### 2.1 落盘布局

```
~/.pi/agent/web-hub/              # stateDir（hub.ts:128 已 ensurePrivateDir；本身允许是属主 symlink，沿用既有信任）
└── uploads/                      # ensureUploadDir：lstat，必须是真目录（非 symlink），属主=uid，0700
    └── s-<sessionId>/            # 同上
        └── <id>/                 # mkdir 非递归 0700，EEXIST ⇒ 409（id 不复用）；同上校验
            ├── <safeName>.part   # 传输中
            ├── <safeName>        # commit：link(part→final) + unlink(part)
            └── meta.json         # commit 最后一步：tmp + fsync + rename；存在且有效 ⇔ committed
```

- 不放项目 cwd（污染仓库）、不放 `/tmp`（多用户可见、systemd 清理不可控）。
- 按 session 分组：agentKey 形如 `a<pid>-<nonce6>`（`hub/registry.ts:225-231`）随进程变；sessionId 消毒为 `[A-Za-z0-9_-]{1,64}`，否则退回 `a-<agentKey>`。
- 新增 `protocol/paths.ts` 纯函数 `webHubUploadsDir(home)`（additive，不改冻结的 `HubPaths`）。

### 2.2 hub 侧组件

拆两层，都在 U2：

- `hub/upload-fs.ts`（新）：**唯一**直接调用 `node:fs/promises` 的上传代码，全部可注入 `fs` 替身（故障注入用）。
- `hub/uploads.ts`（新）：`UploadStore` 状态机、配额、索引、sweep、恢复；只通过 `upload-fs.ts` 访问磁盘（加一条源码扫描测试，仿 `tests/memory/fs-guard.test.ts`）。

> 为何不直接 import `src/memory/safe-fs.ts`：它是同步 API（会阻塞 hub 事件循环）且依赖 `MemoryError`（`safe-fs.ts:38`），并受
> `tests/memory/fs-guard.test.ts` 的模块边界约束。v2 **按同一算法**写异步版，逐函数标注先例出处。

#### 2.2.1 目录与文件打开（#3）

```ts
// hub/upload-fs.ts
export interface DirId {
  dev: number;
  ino: number;
}
export async function ensureUploadDir(path: string, opts: { create: boolean }, fs?: UploadFsDeps): Promise<DirId>;
export async function verifyDirChain(chain: ReadonlyArray<{ path: string; id: DirId }>, fs?): Promise<void>;
export async function openFileNoFollow(dirChain, name: string, flags: number, mode?: number, fs?): Promise<FileHandle>;
```

- `ensureUploadDir`：`lstat`（**从不** `stat`）→ ENOENT 且 `create` ⇒ `mkdir(path, {mode:0o700})`（非递归；EEXIST 再 `lstat` 一次）→ 必须
  `isDirectory() && !isSymbolicLink()`、`uid === getuid()`、模式宽于 0700 ⇒ `chmod 0o700`（父目录都是我们自己的 0700 目录，同 `TMP_SOCKET_DIR_POLICY`
  的 repair 理由，`paths.ts:305-331`）→ 返回 `{dev, ino}`。失败抛 `PrivateDirError`（复用 `paths.ts:125` 词汇：`symlink`/`not-directory`/`owner-mismatch`/`io`）。
  先例：`paths.ts:277-301` `ensureXdgSocketDir`、`paths.ts:461-505` `checkTrustedEntry`。
- 链式校验：每次操作拿到的是 `[uploads, bucket, id]` 三级 `{path, DirId}` 链（创建时记录）。`openFileNoFollow` 用 `O_NOFOLLOW`（`.part` 创建再加
  `O_CREAT|O_EXCL`，读用 `TRUSTED_FILE_OPEN_FLAGS` 同款含 `O_NONBLOCK`，`paths.ts:514`）打开 → `fh.stat()` 必须 `isFile()` → **打开后**再
  `verifyDirChain`（逐级 `lstat` 比对 dev/ino，先例 `safe-fs.ts:657,700` `removeFlatDir` 的 identity 复核）；不一致 ⇒ 关闭句柄、该上传作废、`log.error`，
  **不按路径删除**（目录已被替换，按路径删会删错对象）。
- Node 没有 `openat`，父链替换存在残余 TOCTOU 窗口；上述「打开后复核」把它收窄到「写进了被替换的同 uid 目录」且会被检测并报警。威胁前提是
  同 uid 进程或误配置（stateDir 0700），记录为已知残余。
- uploads 根校验失败（例如被替换成 symlink）⇒ 整个上传功能本次 hub 生命周期内禁用（begin 回 `E_UPLOAD_DISABLED`），`hub.log` error；不影响 hub 其他功能。

#### 2.2.2 完整写入（#6）

```ts
export async function writeAllAt(fh: FileHandle, buf: Buffer, position: number, deadline: Deadline): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fsStep(fh.write(buf, off, buf.length - off, position + off), deadline);
    if (bytesWritten <= 0) throw new UploadFsError("short-write", `${off}/${buf.length}`);
    off += bytesWritten;
  }
}
```

等价 `safe-fs.ts:355-367` `writeAll`（异步 + 带位置 + 带 deadline）。chunk 处理顺序：`writeAllAt` 全部成功 → `hash.update(buf)` → `received += len`。
任一步失败 ⇒ `fh.truncate(received)`（有界）；截断成功 ⇒ 状态不变、回 500，客户端以 `begin` 取 `received` 续传；截断也失败 ⇒ 作废（§2.2.5）。
`.part` 每块都重新 `openFileNoFollow(O_WRONLY)` 再 `close`（不跨请求持 fd）。

#### 2.2.3 no-replace 提交（#4）

commit 步骤（每步都受 §2.2.5 deadline 约束，任一步失败 ⇒ 作废，**绝不发成功回包**）：

1. `received === size` 校验；`fh.datasync()` 后关闭 `.part`。
2. 计算 `sha256`（增量 hash 已有）；查去重索引（§2.5）——命中 ⇒ 删除本 `<id>/` 目录，回包旧路径 `dedup:true`，结束。
3. `link(<id>/<safe>.part, <id>/<safe>)`（**唯一**的 final 创建方式，v3）：
   - 成功 ⇒ `unlink(.part)`；
   - `EEXIST` ⇒ `E_UPLOAD_CONFLICT`，作废并删目录（理论上不可达：`<id>/` 独占；可达即说明有外部写入，`log.error`）；
   - `EPERM/ENOTSUP`（文件系统不支持硬链接）⇒ 作废删目录、回 `E_UPLOAD_DISABLED`、审计 `reason:"no-hardlink"`，**绝不退化为 rename**；
   - `EXDEV` 不可能（`.part` 与 final 在同一 `<id>/` 目录），若出现按 `EPERM` 同样处理。

   **v3 取舍（#4）**：v2 的「EPERM 时 lstat 后 rename」在检查与 rename 之间存在目标被创建的窗口。备选是「进程内 per-bucket 互斥锁内做
   lstat+rename」——它依赖「hub 是 uploads 目录唯一写者」的前提（单机单例 daemon，`hub/singleton.ts`；目录 0700；同 uid 外部进程不在威胁范围，§5.0），
   但锁只能排除本进程内的交错，**对前提之外的写者毫无作用**，而 `link(2)` 的 no-replace 是内核保证、与写者数量无关。家目录所在的常见文件系统
   （ext4/xfs/btrfs/tmpfs/apfs）都支持硬链接，不支持的多为少见的 FUSE/SMB 挂载；为这一少见场景保留一条非原子路径、一套额外测试不划算。故**删除退化路径**：
   - **启动探针**：`createUploadStore` 构造时在 uploads 根执行 `open(.probe-<rand>, O_CREAT|O_EXCL|O_NOFOLLOW)` → `link(.probe-<rand>, .probe-<rand>.l)` → 两者 `unlink`（有界 2s）；
     失败（EPERM/ENOTSUP/超时）⇒ store 进入 `disabled("no-hardlink")`，所有 `begin` 回 `E_UPLOAD_DISABLED`，`hub.log` error 一次，`/webhub status` 可见原因；hub 其他功能不受影响。
     `recover()` 同时清理残留的 `.probe-*`。
   - **并发同 id commit**：per-id 串行锁（§2.2.5）保证同一 `<id>/` 同时只有一个 commit 序列；第二个 commit 在锁内看到已 committed ⇒ 返回同一结果（幂等），看到 `poisoned` ⇒ 404。

4. 写 `meta.json`：`<id>/.meta.<rand>.tmp`（`O_CREAT|O_EXCL|O_NOFOLLOW`，0600）→ `writeAllAt` → `datasync` → `rename(tmp, meta.json)`
   （`<id>/` 内 `meta.json` 只会由这一步写，rename 覆盖语义在此无害）。
5. `fsync(<id>/ 目录)`（`open(dir, O_RDONLY)` + `fh.sync()`；Linux 支持，失败只 warn）。
6. 更新内存索引（配额、去重、path→id），发回包。

`meta.json`（v1 schema，`protocol/upload.ts` 定义 + 解析器严格校验）：

```json
{
  "v": 1,
  "id": "…",
  "principal": "lan:u3",
  "agentKey": "a123-ab12cd",
  "bucket": "s-…",
  "safeName": "shot.png",
  "size": 182344,
  "mime": "image/png",
  "sha256": "…",
  "committedAt": 1790000000000,
  "referencedAt": null
}
```

#### 2.2.4 崩溃一致性与启动恢复（#5）

**不变量**：commit 成功回包只在 §2.2.3 第 1–5 步全部完成后发出 ⇒ 任何非 committed 形态的磁盘状态**从未被浏览器得知**，删除安全。

committed 形态 ⇔ `meta.json` 解析有效 ∧ `final` 是常规文件且 `size` 一致 ∧ 无 `.part` ∧ 无 `.meta.*.tmp`。

启动恢复（`sweep("startup")`，对每个 `<id>/`）：

| 磁盘形态                                                    | 来源窗口                      | 处置                                      |
| ----------------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| 仅 `.part`                                                  | 上传中崩溃                    | 删目录，审计 `recover reason:orphan-part` |
| `.part` + `final`（同 ino 或不同）                          | link 后、unlink 前崩溃        | 删目录（未回包）                          |
| `final`，无 `meta.json`（可能带 `.meta.*.tmp`）             | unlink 后、meta rename 前崩溃 | 删目录（未回包）                          |
| `meta.json` + `final`，size 一致                            | 正常 committed                | 纳入索引（配额/去重/引用/TTL）            |
| `meta.json` 无效 / size 不符 / `final` 非常规文件或 symlink | 损坏或外部篡改                | 删目录，审计 `recover reason:anomaly`     |
| 目录本身是 symlink / 属主不符                               | 外部篡改                      | **不跟随不删除**，`log.error`，计入异常数 |
| 空 `<id>/`、空 bucket                                       | 清理残留                      | 删除                                      |

- 恢复后的已提交文件的 TTL 以 `meta.committedAt` / `referencedAt` 为准（不信 mtime）。
- 扫描是全量的（配额不能漏算）：单次总时限 10s，超时则**在后台继续**，期间 `begin` 回 503 `E_BUSY` + `Retry-After: 2`（chunk/commit 不受影响——重启后内存里没有在途上传）。
  扫描不阻塞 hub 启动/`listen()`，在 `hub.ts:317-335` 构造 frontend 之后以 `void store.recover()` 启动。

#### 2.2.5 deadline 传播与作废（#7）

- `UploadStore` 所有方法签名带 `deadline: { at: number }`（HTTP 层传请求的 `reqDeadline`，`hub/req-deadline.ts`）。每个 fs 调用经
  `fsStep(p, deadline)`：`withDeadline(p, min(FS_STEP_CAP_MS=5s, deadline.at - now()))`，剩余 ≤ 0 ⇒ 不发起。
- 任一 `fsStep` 超时 ⇒ 该上传进入 `poisoned`：立即从「可接受请求」集合移除（后续 chunk/commit 回 404，客户端从头重传新 id），**不再更新**
  `received`/hash/配额/索引，也不发成功回包（HTTP 回 504 `E_DEADLINE`）；后台等待在途 fs promise 落定（有界 30s，超时只记日志）后删除 `<id>/`。
  迟到完成的写入因此只会写进一个即将被删除的目录，永不改变对外状态。
- 断连（`req` aborted/close）：发生在读 body 期间 ⇒ `readBody` 拒绝，状态零变化；发生在写盘期间 ⇒ 写盘照常完成并更新状态（原子一步），客户端重试时
  `dup:true` 或 409 带 `received` 自愈。
- 每个 id 的串行锁保证同一上传同时只有一个 fs 序列；`poisoned` 后排队中的请求直接 404。

### 2.3 文件名消毒 `sanitizeUploadName(raw)`（`protocol/upload.ts`，hub 与 UI 共用）

1. 非 string / 空 ⇒ `"file"`；`normalize("NFC")`。
2. 按 `/` 与 `\` 切分取末段（防 `../../x`、Windows 路径）。
3. 白名单：`\p{L}\p{N}` + `._-`；其余（空格、控制字符、`:*?"<>|$`、反引号、零宽、bidi 覆写 U+202E 等）替换为 `_`，连续 `_` 折叠。
4. 去开头的 `.` 与 `-`，去结尾 `.`。
5. UTF-8 ≤ 120 字节截断，优先保留 `[A-Za-z0-9]{1,16}` 扩展名。
6. 结果为空或 `.`/`..` ⇒ `"file" + ext`；不得以 `.part` 结尾、不得等于 `meta.json`（追加 `_`）。
7. hub 最终防线：`path.resolve(final).startsWith(path.resolve(uploadsRoot) + "/")`。

截图/无名 Blob 由前端改名 `pasted-YYYYMMDD-HHMMSS[-n].<ext>`（ext 由已校验 mime 映射）。

### 2.4 上限与限流（`protocol/upload.ts` 常量）

| 常量                            | 值                     | 触发                                                              |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `UPLOAD_FILE_MAX_BYTES`         | 100 MiB                | begin `size` / chunk 越界 ⇒ 413                                   |
| `UPLOAD_BUCKET_MAX_BYTES`       | 512 MiB                | 同 bucket 已提交 + 在途；且单主体在单 bucket 内同样 ≤ 512 MiB     |
| `UPLOAD_TOTAL_MAX_BYTES`        | 2 GiB                  | 全局；超限按 §2.6 淘汰顺序处理，仍超 ⇒ 507                        |
| `UPLOAD_INFLIGHT_PER_PRINCIPAL` | 4                      | 未 commit 数 ⇒ 429                                                |
| `UPLOAD_INFLIGHT_HUB`           | 16                     | 全局未 commit 数 ⇒ 429                                            |
| `UPLOAD_ATTACH_MAX_PER_MSG`     | 20                     | 前端托盘上限；附件块 ≤ 20×~220 B，远低于 48 KiB                   |
| 令牌桶 `${principal}:upload`    | 容量 64，每 100ms 回 1 | 所有 upload 端点共用；复用 `createCmdLimit`（`hub/http.ts:1820`） |

令牌桶依据（#17）：持续 10 请求/s ⇒ loopback ≤ 40 MiB/s、LAN ≤ 10 MiB/s 的单主体写盘速率上界（100 MiB 文件分别 ≥ 2.5s / 10s，不影响正常使用），
容量 64 允许 4 个并发上传各自突发；目的是限制单主体对磁盘与 LAN 鉴权子进程的冲击。观测见 §5.4 的 stats 行（`rateLimited`、`retryAfterS`）。

### 2.5 幂等与去重（#9）

- begin / chunk / commit 幂等规则同 v1：同主体同 id 同参数 ⇒ 同结果；`offset + len === received` ⇒ `dup:true`；`offset ≠ received` ⇒ 409 + `received`。
- 前端：同一 `File`（`name+size+lastModified+type`）在同 agent 托盘重复加入 ⇒ 只保留一份（`logic/upload.js` 的 `fileFingerprint`）。
- **内容去重键 = `principal | bucket | sha256 | safeName`**（v1 只有后两者）。命中后返回旧路径前**再次复核**旧条目的 `meta.principal === 当前主体`
  且旧文件仍为 committed 形态（`lstat` size 一致），任一不符 ⇒ 不去重、正常提交新文件。
- 不同主体（如 LAN 两个用户、或 loopback token 与 LAN 用户）上传完全相同的内容到同一 session ⇒ **各存一份**，互不得知对方存在（回包不含 sha256、
  dedup 只在本主体命名空间内发生 ⇒ 无存在性侧信道）。`abort` 只能删除本主体名下的上传。

### 2.6 生命周期、淘汰与关闭（#8 #13）

**引用标记（#8，v3 改为「先保护、后回包」）**：hub 是浏览器 prompt 进入 pi 的唯一通道（`/api/cmd`）。v2 在回包后才异步标记，配额 sweep 可在
「agent 已接收 prompt → 标记落地」之间淘汰刚被引用的文件。v3 把保护拆成两层：**内存保护同步建立、且早于任何可能的淘汰决策**；磁盘持久化有界等待、失败不影响正确性。

`UploadStore` 新增三个**同步**方法（只读写内存索引，无 await）与一个异步方法：

```ts
pinForPrompt(p: { principal; text: string }): { ok: true; token: PinToken } | { ok: false; gone: string[] /* uploadId */ };
settlePins(token: PinToken, outcome: "referenced" | "released"): void;   // referenced ⇒ rec.referencedAt = now, rec.metaDirty = true
flushReferences(ids: readonly string[], deadline: Deadline): Promise<"ok" | "timeout" | "error">;  // 原子重写 meta.json（同 §2.2.3 第 4 步）
```

`dispatchCmdOrDialog`（`hub/http.ts:1586`）中、仅对 `op === "prompt" | "steer_subagent"` 且**非 dup**（`:1717` 的 `dup` 为假；dup 由原请求已处理）：

1. **转发前钉住**：在 `:1717`（peek）与 `:1759`（`commands.request`）之间那段**既有的同步区**（`:1684-1687` 与 `:1706-1716` 注释明确要求此区无 await）内调用
   `pinForPrompt()`：`parseAttachmentBlock(text)` 取路径 → 匹配 `path → id` 且 `meta.principal === 当前主体`（他人/未知路径忽略，不报错）→ 每个命中项 `rec.pins++`。
   命中项若处于 `evicting` 或已不在索引 ⇒ 不转发，回 409 `{ error:"E_UPLOAD_GONE", id, retryable:false, effect:"none" }` 并写 `reject` 审计；
   前端把该 pending 项显示为「附件已被清理，请重新上传」（i18n `upload.err.gone`）。
2. **转发**：`await commands.request(frame, agentKey)`（`:1759`）；期间被钉住的条目不会被任何 sweep 淘汰（见下）。
3. **回包前结算**（`try/finally` 保证每条路径都结算）：`reply.ok === true` 或 `effect === "unknown"`（含 catch 分支的 `E_AGENT_GONE`/`E_DEADLINE`/`E_INTERNAL`，按「可能已送达」保守处理）
   ⇒ `settlePins(token, "referenced")`；`effect === "none"` ⇒ `settlePins(token, "released")`。两者都是同步内存操作，紧接 `commands.request` 返回、与 `sendCmdResult` 之间无 await。
4. **有界持久化**：`"referenced"` 时 `await flushReferences(ids, { at: now() + min(REF_FLUSH_CAP_MS=1000, reqDeadline.remaining() - 300) })`，剩余 ≤ 0 则跳过等待；
   随后 `sendCmdResult(res, reply)`（`:1760`）。**语义：持久化超时/失败不改变回包**——prompt 已交给 agent、无法撤回，因此照常返回成功；
   条目保留 `metaDirty=true`，写 `reference ok:false` 审计；60s 在途 tick 与每次 sweep 开始时先重试 `flushReferences(全部 dirty)`。
   只要进程存活，内存里的 `referencedAt` 就是淘汰判定的唯一依据，**dirty 不影响保护**；唯一的退化是「回包后、持久化前 hub 崩溃」⇒ 重启后该文件按未引用处理（24h TTL、>1h 可被配额淘汰），该窗口长度 ≤ 一次 meta 原子写（正常 < 1s），记为已知残余（§8 第 5 条）。

**淘汰端**（`sweep("tick" | "quota")`、TTL 过期）对每个候选：取 per-id 锁 → **同步**复核 `rec.pins === 0 && rec.referencedAt === null`（TTL 过期分支复核按引用状态对应的 TTL）→
同一 tick 内置 `rec.state = "evicting"` → 才开始 `rm`。由于「复核 + 置 evicting」与 `pinForPrompt` 都是同一内存记录上的同步操作，JS 单线程保证二者不交错：要么 pin 先到（淘汰跳过），
要么 evicting 先置（prompt 得 `E_UPLOAD_GONE`、不转发）——不存在「已转发给 agent 的 prompt 引用了正在被删除的文件」。`rm` 完成后从索引移除；`rm` 失败 ⇒ `state` 回到 committed 并记日志。

TUI 用户手抄路径不会被标记（未引用规则处理）。

| 对象               | TTL                    | 配额淘汰                                | 谁清 / 何时                               |
| ------------------ | ---------------------- | --------------------------------------- | ----------------------------------------- |
| 在途（未 commit）  | 闲置 10 min ⇒ 作废删除 | 超配额时优先回收已作废/闲置项           | 60s unref tick                            |
| 已提交、**未引用** | `committedAt` + 24h    | 可淘汰：`committedAt` > 1h 的按最旧优先 | `sweep("tick")` 30 min / `sweep("quota")` |
| 已提交、**已引用** | `referencedAt` + 7 天  | **永不**被配额淘汰                      | `sweep("tick")`                           |
| 托盘里被用户移除   | 立即删除               | —                                       | `abort` 端点（失败则走未引用 TTL）        |

- 配额满且没有可淘汰对象 ⇒ 507 `E_UPLOAD_QUOTA`，message 给出最早一项的过期时间。
- 由此可声明：**被 prompt 引用的附件在 7 天内可靠可读**（除非人工删除 stateDir）。过期后 resume 会话、模型 `read` 得到 ENOENT——附件块文案写明保留期（§3.1）。
- 每次 TTL 过期/配额淘汰写一条 `upload evict` 审计（§5.4），含 `reason: "ttl" | "quota" | "idle"`、`referenced`、`bytes`、`ageS`。

**关闭（#13）**：现状 `close()`（`hub/hub.ts:635-661`）只顺序关闭 fe/history/agentServer/scope/owner，**不执行** `cleanup` 数组（后者只在启动失败 `:677`
逆序执行）。v2：

1. `close()` 中 `await bounded(fe.close())`（`:648`，先停新请求：`srv.close()` + `closeAllConnections()`，`http.ts:2241-2259`）之后，插入
   `await bounded(uploads.close())`（`STEP_DEADLINE_MS=3s`，`hub.ts:85`）。
2. `UploadStore.close()`：置 `closing`（新请求 503 `E_HUB_RESTARTING`）→ 把所有在途上传标 `poisoned` → 等在途 fs promise 最多 2s → 删除所有未提交
   `<id>/`（已提交保留）→ 清定时器与索引。返回后不得再有任何对上传目录的写入（作废语义保证迟到写入只落进待删目录，后台删除在 close 返回前已发起）。
3. 同时 `cleanup.push(() => uploads.close())` 覆盖启动失败路径。
4. 路径覆盖：正常 `/webhub stop`、idle exit、supersede ⇒ `close()`；SIGTERM/SIGINT ⇒ `installProcessHandlers` → `close("signal")`（`hub.ts:690-693`，`:705` 注册）；
   `uncaughtException` ⇒ `close("crash")` 但 3s 强制退出（`:694-702`），**不保证**完成 ⇒ 依赖下次启动 `sweep("startup")`（§2.2.4）；SIGKILL 同理。

---

## 3. prompt 注入格式

### 3.1 格式（`protocol/upload.ts` 的 `formatAttachmentBlock(items)` / `parseAttachmentBlock(text)`）

```
<用户正文>

[web-hub attachments] The user attached 2 file(s), saved on this machine and kept for at least 24 hours (7 days once sent):
- /home/u/.pi/agent/web-hub/uploads/s-3f2a…/Xy7…/screenshot.png (image/png, 182 KB)
- /home/u/.pi/agent/web-hub/uploads/s-3f2a…/Ab9…/report_v2.pdf (unknown type, 1.4 MB)
Paths can be passed to the read tool as-is; quote them when using a shell.
```

- 固定英文标记，不随 UI 语言变化（模型锚点 + `parseAttachmentBlock` 的解析依据）。
- **（#14）不再承诺「路径无需引号」**：`safeName`、`<id>`、bucket 是我们控制的安全字符集，但 home / stateDir 前缀可能含空格或 shell 元字符；
  只保证 `read` 可原样接收，shell 使用由尾行提示加引号。路径若含换行（理论上 home 可以）⇒ `formatAttachmentBlock` 拒绝生成，hub 在 `begin` 时就以
  `E_UPLOAD_DISABLED` + `log.error` 拒绝（uploads 根路径含 `\n`/`\r`/控制字符即视为不可用）。
- **（#2）mime 防注入**：每行括号内只能是 `formatAttachmentBlock` 对 `normalizeMime` 结果的再校验产物，不合格写 `unknown type`；路径、mime、大小三者都不可能含换行
  ⇒ 不能伪造额外的列表行或标记行。用例：`mime = "text/plain\n- /etc/passwd"`、`"image/png; x=1"`、`"图片/png"`、超长 ⇒ 输出均为 `unknown type`，块行数不变。
- 大小用 `format.ts` 同款 1024 进位；正文为空 ⇒ 只发附件块。

### 3.2 与 steer / followUp / 命令模式的交互（#12）

- 拼接在 Composer 内完成，emit 仍是冻结的 `send(text, deliver)`（`contracts.ts:159-161`）——`DetailDock.onSend`（`DetailDock.vue:196-210`）、
  `useControl.sendPrompt`、agent 零改动；队列重试（`DetailDock.vue:225-236` 用 `item.text`）天然带附件块。
- **唯一闸门 `sendGate()`**（`Composer.vue` 内，纯判定委托 `@logic/upload.js` 的 `canSendWithAttachments`）返回 `{ ok, reason }`：
  `enabled` ∧ ¬`sending` ∧（正文非空 ∨ 有 ready 附件）∧ 托盘无 `uploading/failed` ∧（命令模式 ⇒ 无附件 且 policy ∈ allow/confirm）∧ 拼接后 UTF-8 ≤ 48 KiB。
  - 按钮 `:disabled="!gate.ok"`；`doSend()`（`Composer.vue:108`）**首行** `if (!sendGate().ok) return`；`onKeydown`（`:118`）与 `onSendClick`（`:127`）
    都只调用 `doSend`。现有 `onKeydown` 里的 `policy === "deny"` 早退（`:123`）并入 `sendGate`。
  - 行为变化（有意）：v1 前键盘 Enter 在 `sending` 为真时仍可发送（`doSend` 不查 `sending`），v2 与按钮一致地拦下；`composer.test.ts:148` 已钉住按钮在
    sending 时禁用，新增键盘同语义用例。
- 命令模式（`parseSlash(text) !== undefined`，`logic/control.js:56`）+ 附件 ⇒ 拦下并提示「附件只能随普通消息发送：移除附件，或用 `//` 开头按文本发送」。
- 发送后清空托盘（与正文同样乐观清空）。

---

## 4. composer UX

### 4.1 三个入口

1. **粘贴**（textarea `@paste`）：`classifyPaste(dt)`（纯函数）——收集 `kind === "file"` 的 `getAsFile()`（回落 `dt.files`）；无文件 ⇒ 不干预；
   有文件且无 `text/plain` ⇒ `preventDefault()` 全作附件；有文件**且**有文本（Office/表格复制、Finder 文件名）⇒ 文件作附件、文本照常粘贴（用例钉住）。
2. **拖拽**：`.composer` 根元素 `dragenter/over/leave/drop`，计数器防闪烁，`types` 含 `Files` 才显示遮罩；`webkitGetAsEntry()?.isDirectory` ⇒ 拒收提示。
3. **附件按钮**：回形针按钮 + 隐藏 `<input type="file" multiple>`；移动端唯一可靠入口。

`!enabled` 或 `uploadAvailability(...)` 为假时三入口全部禁用。

### 4.2 附件托盘 `components/control/AttachmentTray.vue`（新）

- 位于 `composer-row` 之上。每项：缩略图（`image/*` 且 ≤ 10 MiB：`createImageBitmap` → 64px canvas → `toDataURL("image/jpeg")`；CSP
  `img-src 'self' data:`（`hub/http.ts:111`）允许 `data:`，**不引入 `blob:`、不改 CSP**）、文件名、大小、状态、移除。
- 状态：`queued → uploading(%) → ready | failed(原因, 可重试)`、`removing`。错误映射 i18n `upload.err.*`：`E_UPLOAD_TOO_LARGE`、`E_UPLOAD_QUOTA`（含过期时间）、
  `E_UPLOAD_DISABLED`、`E_UPLOAD_CONFLICT`、`E_AGENT_GONE`、`E_BUSY`（hub 正在整理临时空间，自动重试）、`E_NOT_FOUND`/`E_HUB_RESTARTING`（hub 已重启，请重试）、网络/超时。
- **明文警告**：`CONTROL_ENV.plaintext === true`（`App.vue:131`）时托盘底部**常驻且不可关闭**一行 warning「明文 HTTP：附件内容在局域网内未加密传输，可被同网段窃听或篡改」
  （区别于 `ControlNotice` 的可关闭横幅——后者在 `060c33b` 已改为 sessionStorage 可关闭；本警告只在托盘非空时出现，不改 `ControlNotice.vue`）。
- a11y：`role="list"`、每项 `aria-label`、进度 `aria-valuenow`、完成/失败经 `useAnnouncer` 播报。

### 4.3 状态归属与调度

- 附件状态是 Composer 局部 UI 状态（同 drafts，`useControl.ts:46`），不进 reducer：`composables/useUploads.ts` 持有 `Map<agentKey, ShallowRef<Attachment[]>>`；
  刷新丢失（无 localStorage，`source-scan.test.ts:163` 不变）。纯状态机 `attachmentReduce` 在 `logic/upload.js`。
- 调度：每 agent 同时 2 个文件；块顺序上传；每块超时 `CMD_REQUEST_TIMEOUT_MS=16s`（`logic/token-client.js:28`）；超时/网络错 ⇒ `begin` 幂等取 `received` 续传，
  同块最多 3 次；404（作废或 hub 重启）⇒ failed，重试 = 新 id 从头。

### 4.4 移动端限制

iOS Safari 16+ 长按粘贴图片可用，非图片文件通常不可粘贴；Android Chrome 的 Gboard 剪贴板图片走 `commitContent`，网页通常收不到 ⇒ 用附件按钮；移动端无拖拽。
`pointer: coarse` 时附件按钮常显、触控区 ≥ 44px。

---

## 5. 安全

### 5.0 威胁模型与已接受风险（#1，**用户裁定**）

> 本节为用户决策记录：`webHub.uploads` 默认 `"on"`，LAN 明文模式下同样启用。复审不再就默认值争论；如需变更须由用户重新拍板。

- **资产**：用户上传的文件内容；pi 会话据其做出的动作。
- **LAN 明文（password 模式 + `http:`）下已接受的风险**：
  1. 同网段攻击者可**嗅探**完整文件内容（与 cookie、prompt 文本同等暴露，见 `lan-plan.md` 的既有明文裁定）；
  2. 中间人可**篡改**上传字节，hub 无法分辨；`sha256` 只证明「hub 收到并落盘的内容」，**不证明**与浏览器原文一致（且 v2 不再向浏览器回传 sha256）；
  3. 被篡改的文件经 prompt 交给模型，等价于篡改 prompt 文本——该风险在 LAN 明文控制面启用时已存在，上传不新增质变。
- **缓解**：托盘常驻明文警告（§4.2）；`webHub.uploads: "loopback"` 只允许本机上传、`"off"` 全关；使用反代 HTTPS（`webHub.lan.trustProxyFrom`）时 `plaintext=false`。
- **不在范围**：同 uid 本地恶意进程（可直接改 stateDir，见 §2.2.1 残余窗口）；文件内容本身的 prompt injection（与用户粘贴文本同等，不新增攻击面）。

### 5.1 鉴权与能力门槛

1. 上传端点走与 `/api/cmd` 相同的写端点步骤（`dispatchCmdOrDialog`，`hub/http.ts:1586-1774`）：strict CSRF → `authorize()` → 主体 upload 桶 → hub 在途上限 →
   body 预算 → 解析 → **再次 `authorize()`**（`:1688-1692` 同款）。
2. 能力（hub 强制）：`begin` 时 `registry.get(agentKey)` live 且 `getCaps` 含 `cmd.v1` + `upload.v1`（LAN 另需 `upload.lan.v1`），否则 409 `E_UPLOAD_DISABLED`；
   `commit` 再验 agent 仍在，否则 410 `E_AGENT_GONE` 并删目录。agent 侧 `capsExtra()`（`agent/index.ts:506-514`）按设置发布：`on` ⇒ 两者，`loopback` ⇒ 仅 `upload.v1`，
   `off` 或 `control:false` ⇒ 都不发。hub 侧 `UPLOAD_HUB_CAPS = ["upload.v1"]`（`protocol/version.ts`，不改 `P2_HUB_CAPS`），在 `hub/hub.ts:227` 与 `hub/agent-server.ts:153` 同时追加。
3. **跨用户边界（#9）**：同一 hub 的不同主体可操作同一 agent/session（这是 LAN 多用户的既有模型）。上传按主体隔离：id 归属、abort、dedup、引用标记都只在本主体内生效；
   路径一旦随 prompt 发出就出现在共享 transcript 中，其他主体能**看到路径**但无法经 HTTP 读取（无下载端点），这与 transcript 共享的既有语义一致。

### 5.2 CSRF（chunk）

新增 `uploadCsrfOk(req, expectedOrigin)`：与 `strictCsrfOk`（`hub/http.ts:1481-1493`）逐条相同，仅 `Content-Type` 要求 `application/octet-stream`。
`octet-stream` 与 `X-PWH` 都不是 CORS-safelisted ⇒ 跨源必须预检，hub 对 `OPTIONS` 一律 404（`:1095`）。

### 5.3 类型白/黑名单：不做

理由：需求是任意文件；MIME/扩展名可伪造；hub 不执行、不解压、**不回传**；文件 0600 无执行位；资源风险由 §2.4 限额兜住。mime 只做 §1.2 的格式校验（防注入），不做准入判定。

### 5.4 审计 schema（#11 #17）

`hub/audit.ts` 新增：

```ts
export interface UploadAuditRecord {
  phase: "request" | "reject" | "evict" | "recover";
  op: "begin" | "chunk" | "commit" | "abort" | "reference" | "sweep";
  reqId?: string;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  uploadId?: string;
  bucket?: string;
  ok: boolean;
  code?: string | null;
  ms?: number;
  bytes?: number; // begin: 声明 size；commit/evict: 文件实际大小
  received?: number; // reject/作废时已收字节
  chunks?: number; // commit: 总块数
  dupChunks?: number; // commit: 幂等重发块数（重试观测）
  dedup?: boolean;
  ext?: string | null;
  mimeClass?: string | null;
  mimeDropped?: boolean;
  referenced?: boolean;
  ageS?: number;
  reason?:
    | "ttl"
    | "quota"
    | "idle"
    | "deadline"
    | "close"
    | "orphan-part"
    | "anomaly"
    | "conflict"
    | "short-write"
    | "no-hardlink"
    | null;
  note?: null; // v3 #4：退化路径已删除，保留字段占位以免 schema 变动
  retryAfterS?: number;
}
export function auditUpload(log, record: UploadAuditRecord): void; // log.info("upload", { audit: "upload", ...pick(record, UPLOAD_AUDIT_KEYS) })
```

- 写入点：`begin`/`commit`/`abort` 各一行 `request`；`reference` 每次标记一行（只记 uploadId 数，不记 prompt 文本）；所有拒绝一行 `reject`（429 复用 `rejectAudit429`
  节流，`hub/http.ts:1627-1633`）；**chunk 成功不逐块记**；evict/recover 每对象一行。
- **永不记录**：原始文件名、`safeName`、sha256、文件内容、prompt 文本（沿用 U7）。`ext` 取消毒后扩展名（≤ 16 ASCII），`mimeClass` 只取 `/` 前一段。
- `pick` 按 `UPLOAD_AUDIT_KEYS` 运行时裁剪，非白名单字段即使传入也丢弃（防未来误传）。
- **周期聚合行**（每次 `sweep("tick")`，30 min）：`log.info("upload stats", { audit: "upload-stats", active, inflightBytes, committedFiles, committedBytes,
referencedFiles, requests, rejects: {E_RATE, E_UPLOAD_QUOTA, E_DEADLINE, …}, rateLimited, maxRetryAfterS, timeouts, poisoned, evicted, p50Ms, p95Ms })`——
  令牌桶与双档 chunk 的现场观测依据（#17）。

### 5.5 磁盘安全

见 §2.2.1：根以下每级 `lstat` 拒 symlink、`O_NOFOLLOW|O_EXCL`、打开后 `fstat` + 父链 dev/ino 复核、`resolve` 前缀校验；校验失败禁用上传而非降级。

---

## 6. 文件域拆包与验收标准

依赖顺序：**U1 → (U2 ∥ U4a) → U3 → U4b → U5**。

### 冲突隔离与 U5 开工闸门（#15）

- `060c33b`（七项 UI 改进）已合入：`AgentList.vue`、`ControlNotice.vue`、`AgentDetail.vue`、`FleetPanel.vue`、`Transcript.vue`、`TxCustom.vue`、
  `i18n/*/{agents,control}.ts`、`styles/{agents,control,fleet}.css`。本方案仍**全部避开**这些文件（上传可用性在 Composer 内计算；css/i18n 新建命名空间；DetailDock 不动）。
- 撰写 v2 时工作区另有未提交改动：`components/control/CommandPalette.vue`、`components/transcript/{ThinkingBlock,Transcript,TxAssistant}.vue`、
  `tests/web-hub/ui/command-palette.test.ts`、`tests/web-hub/ui/thinking-block.test.ts`——同属 `components/control/**`，与 `Composer.vue` 相邻。
- **U5 开工前 diff 闸门**（执行者必须贴出结果）：

  ```sh
  git status --porcelain -- src/web-hub/ui/src/components/control src/web-hub/ui/src/styles src/web-hub/ui/src/i18n tests/web-hub/ui   # 必须为空
  git log --oneline 5afa90d..HEAD -- src/web-hub/ui/src/components/control/Composer.vue src/web-hub/ui/src/contracts.ts \
      src/web-hub/ui/src/components/detail/DetailDock.vue src/web-hub/ui/src/logic/control.js
  ```

  第一条非空 ⇒ 等对方提交；第二条非空 ⇒ 先按新 HEAD 重新核对本文 §3.2/§6-U5 引用的行号（`Composer.vue:80/108/118/123/127/149/159`、`DetailDock.vue:196-236`），再开工。

### 包 U1 — 协议、设置、能力透传（小）

文件域：

- `src/web-hub/protocol/upload.ts`（新）：端点常量、§2.4 限额、`UPLOAD_CHUNK_BYTES_{LOOPBACK,LAN}`、`UPLOAD_CHUNK_BODY_MS`、`UPLOAD_TOTAL_MS`、
  `sanitizeUploadName`、`normalizeMime`、`formatAttachmentBlock`、`parseAttachmentBlock`、`bucketFor`、`UploadMetaV1` 类型 + `parseUploadMeta`。纯函数，无 node 依赖。
- `src/web-hub/protocol/version.ts`：`UPLOAD_HUB_CAPS`、`UPLOAD_AGENT_CAPS`。
- `src/web-hub/protocol/http-contract.ts`：`API_ERRORS` 追加 6 码（含 v3 `E_UPLOAD_GONE`）；`AgentCard` 追加 `upload?: boolean; uploadLan?: boolean`。
- `src/web-hub/protocol/paths.ts`：`webHubUploadsDir(home)`。
- `src/web-hub/hub/registry.ts:175`：`card()` 追加两字段。
- **`src/web-hub/hub/http.ts:338-360` `toCard()`（#10）**：追加 `if (v.upload !== undefined) card.upload = v.upload; if (v.uploadLan !== undefined) card.uploadLan = v.uploadLan;`。
- `src/web-hub/agent/index.ts:506-514`：`capsExtra()`。
- `src/config/settings.ts`（默认 `:807-818`、解析 `:1500-1512`）、`src/config/setting-specs.ts`（`:272-279` 旁 `choice(...)`，`:87` 的 helper）。

验收：

- `tests/web-hub/protocol/upload.test.ts`（新）：消毒表（`../../etc/passwd`、`C:\a\b.txt`、`.bashrc`、`-rf`、`a b?.png`、`$(x)`、反引号、U+202E、超长中文保扩展名、
  空串、`..`、`x.part`、`meta.json`）；**`normalizeMime` 注入表（#2）**：`"text/plain\n- /etc/passwd"`、`"\r"`、`"image/png; charset=x"`、`"图片/png"`、
  65 字符 subtype、`" IMAGE/PNG "`（⇒ `image/png`）；`formatAttachmentBlock` 快照 + 「任意输入下行数 = 2 + 文件数」性质测试；`parseAttachmentBlock(format(x)) == x` 往返；
  路径含 `\n` ⇒ 拒绝生成；`parseUploadMeta` 拒绝缺字段/错类型/多余 `v`。
- **toCard 一致性（#10）**：`tests/web-hub/http/sse.test.ts`（或 `api.test.ts`）断言同一 agent 的 `upload/uploadLan` 在初始 `agents` 帧（`http.ts:767`）、
  `agent_up`（`:667`）、断开 SSE 后重连收到的 `agents` 帧三处一致；`tests/web-hub/hub/registry.test.ts` 断言 `card()`。
- `tests/web-hub/agent/wiring-control.test.ts`：`on/loopback/off` 与 `control:false` 四种 hello caps。
- `tests/config/*`：`webHub.uploads` 三值 + 非法值回落 `"on"`。
- `npm run typecheck && npx vitest run tests/web-hub/protocol tests/web-hub/hub/registry.test.ts tests/web-hub/http/sse.test.ts tests/web-hub/agent/wiring-control.test.ts tests/config`。

### 包 U2 — hub 上传存储（中偏大）

文件域：`src/web-hub/hub/upload-fs.ts`（新）、`src/web-hub/hub/uploads.ts`（新）、`tests/web-hub/hub/uploads.test.ts`（新）、`tests/web-hub/hub/upload-fs.test.ts`（新）、
`tests/web-hub/hub/upload-fs-guard.test.ts`（新：源码扫描，`uploads.ts` 不得 import `node:fs*`）。

```ts
export interface UploadStore {
  recover(): Promise<RecoverReport>; // §2.2.4，后台可续
  begin(p: BeginParams, deadline: Deadline): Promise<BeginResult>;
  chunk(p: { principal; id; offset; bytes: Buffer }, deadline: Deadline): Promise<{ received: number; dup?: true }>;
  commit(p: { principal; id }, deadline: Deadline): Promise<CommitResult>;
  abort(p: { principal; id }, deadline: Deadline): Promise<void>;
  pinForPrompt(p: { principal; text: string }): PinResult; // 同步（v3 #8）
  settlePins(token: PinToken, outcome: "referenced" | "released"): void; // 同步
  flushReferences(ids: readonly string[], deadline: Deadline): Promise<"ok" | "timeout" | "error">;
  sweep(reason: "tick" | "quota"): Promise<SweepReport>;
  stats(): UploadStats;
  inflight(): number;
  close(): Promise<void>; // §2.6
}
export function createUploadStore(deps: { root; now; log; audit; limits?; fs?: Partial<UploadFsDeps> }): UploadStore;
```

验收（常规）：顺序写 + commit 内容/大小正确、权限 0600/0700；`dup`/409/跨主体 404；三级配额与主体级配额；去重命中仅限同主体；引用标记后 TTL 变 7 天且不被配额淘汰；
未引用 >1h 可被配额淘汰、<1h 不可；所有 timer `unref`（`hasRef() === false`）。

**硬门槛（#16，任何一项失败不得合入）**——全部用注入的 `UploadFsDeps` 替身或真实 tmpdir：

1. **symlink（#3）**：uploads 根 / bucket / id 目录 / `.part` / final 任一被预置或在 `lstat` 与 `open` 之间（替身钩子）替换为 symlink ⇒ 拒绝、链接目标未被写入或删除、上传被禁用或作废。
2. **no-replace（#4，v3）**：commit 前预置同名 final ⇒ `E_UPLOAD_CONFLICT`、预置文件内容不变；替身让 commit 时 `link` 返回 `EPERM`/`ENOTSUP`/`EXDEV` ⇒ `E_UPLOAD_DISABLED`、目录被删、替身记录中**无任何 `rename` 指向 final**；启动探针 `link` 失败 ⇒ store `disabled("no-hardlink")`、`begin` 一律 409、`.probe-*` 不残留；**并发同 id commit 注入**：两个 commit 同时进入（替身让第一个的 `link` 挂起）⇒ 第二个等锁、拿到与第一个相同的结果，`link` 只被调用一次。
3. **崩溃恢复（#5）**：按 §2.2.4 表逐行构造磁盘形态 ⇒ `recover()` 处置正确；committed 文件进入配额与去重索引（重启后同主体同内容命中 dedup，异主体不命中）；
   扫描超时（替身让 `readdir` 慢）⇒ `begin` 返回 `E_BUSY` 直到扫描完成。
4. **short write（#6）**：替身 `write` 依次返回部分字节 / 0 / 抛错 ⇒ 前者循环写完且 hash 正确；0 与抛错 ⇒ `received` 不变、`.part` 被截断回 `received`；截断也失败 ⇒ 作废、目录被删。
5. **deadline（#7）**：替身 `write`/`link`/`rename` 挂起超过 deadline ⇒ 504、上传 `poisoned`、之后替身放行迟到完成，断言 `received`/配额/索引/meta 均未变化、目录最终被删、
   未发出成功结果；commit 中途超时 ⇒ 无 committed 形态残留。
6. **close（#13）**：`close()` 与一个挂起的 chunk 写并发 ⇒ `close()` 在 2s+ε 内返回、未提交目录全部删除、已提交保留、close 返回后不再有对上传目录的写调用（替身记录调用时序）。

### 包 U3 — hub HTTP 路由、引用标记与装配（中）

文件域：

- `src/web-hub/hub/upload-http.ts`（新）：`handleUploadRequest(req, res, path, query, opts)`；`opts` 与 `dispatchCmdOrDialog` 同形 + `store` + `expectedOrigin` + `io: { readBody, sendJson }`
  （从 `http.ts` 注入私有 helper）；把请求 `reqDeadline` 传给 store（#7）；错误以 `{ status, code, message?, extra? }` 返回。
- `src/web-hub/hub/http.ts`：loopback `handleApi` 在 `if (!csrfOk(req))`（`:2103`）之前插 `/api/upload/` 分支（authorize 复制 `:2088-2094`）；LAN router 在
  `if (!csrfOkLan(req, ctx))`（`:1145`）之前插同样分支（authorize 复制 `:1130-1136`）；`uploadCsrfOk` 紧挨 `strictCsrfOk`（`:1481`）；`deps.uploads` 缺省 ⇒ 501；
  **引用标记（#8，v3）**：`dispatchCmdOrDialog` 中 `:1717-1759` 同步区内 `pinForPrompt()`（失败 ⇒ 409 `E_UPLOAD_GONE`、不调用 `commands.request`）；`:1759` 返回后 `try/finally` 内同步 `settlePins()`，再有界 `await flushReferences()`（≤ `min(1s, remaining-300ms)`），最后 `sendCmdResult`（`:1760`）（仅 prompt/steer_subagent、非 dup，§2.6）。
- `src/web-hub/hub/ports.ts`：`FrontendDeps.uploads?: UploadStore`（additive，同 `commands?` 先例 `:482`）。
- `src/web-hub/hub/hub.ts`：构造 store（根校验失败 ⇒ 不传 store、上传 501/禁用，hub 照常启动）→ 传入 `frontend({...})`（`:317-335`）→ `void store.recover()` →
  30 min unref `sweep("tick")` + 60s unref 在途 tick → **`close()` 内 `fe.close()`（`:648`）之后 `await bounded(uploads.close())`（#13）** + `cleanup.push(() => uploads.close())`；
  `:227` caps 追加 `UPLOAD_HUB_CAPS`。
- `src/web-hub/hub/agent-server.ts:153`：`hello_ack.caps` 追加 `UPLOAD_HUB_CAPS`。
- `src/web-hub/hub/audit.ts`：`UploadAuditRecord`、`UPLOAD_AUDIT_KEYS`、`auditUpload`（#11）。

验收（常规）：`tests/web-hub/http/api-upload.test.ts`（loopback）与 `lan-upload.test.ts`（LAN）——完整流程；401；缺 X-PWH / 错 Content-Type / 跨 Origin / `Sec-Fetch-Site: cross-site` ⇒ 403；
无 `upload.v1` ⇒ 409；LAN 无 `upload.lan.v1` ⇒ 409；chunk 超 `chunkBytes` ⇒ 413 且连接关闭；`Content-Length` 撒谎 ⇒ 413；429 带 `Retry-After`；`deps.uploads` 缺省 ⇒ 501；
两档 chunk 各 100 MiB 跑通（§1.3）；`deadline-nesting.test.ts` 新断言；`agent-server-admin.test.ts`/`hub.test.ts` caps 期望一致；`security.test.ts` 的 CSP 断言不变。
引用标记（v3 #8，**列入 U3 硬门槛**）：prompt 成功 ⇒ 回包到达浏览器时内存 `referencedAt` 已置且 `meta.json` 已写；`effect:"none"` ⇒ 不标记且 pin 释放；他主体文本里出现我的路径 ⇒ 不钉不标；dup 重放 ⇒ 不重复钉。
竞态用例（替身控制时序）：
(a) `commands.request` 挂起 5s 期间触发 `sweep("quota")`（文件已满足 >1h 未引用）⇒ 被钉住，不淘汰；
(b) sweep 已对候选置 `evicting`、`rm` 被替身挂起时 prompt 到达 ⇒ 409 `E_UPLOAD_GONE`，`commands.request` 调用次数为 0；
(c) sweep 已选出候选、尚未取 per-id 锁时 prompt 先钉住 ⇒ sweep 复核后跳过；
(d) `flushReferences` 替身失败 ⇒ 回包仍 200、内存保持 referenced、之后一次 sweep 不淘汰且先重试持久化成功；
(e) `flushReferences` 替身挂起 > 1s ⇒ 回包在 `1s + ε` 内发出，`reference ok:false` 审计一行；
(f) `commands.request` 抛 `E_AGENT_GONE` ⇒ 按 referenced 结算（保守）；返回 `effect:"none"` ⇒ released，之后可被正常淘汰。
审计（#11）：`tests/web-hub/hub/audit.test.ts` 追加——各 phase/op 字段齐全；传入 `name`/`safeName`/`sha256`/`text` 等非白名单键被裁剪；chunk 成功无审计行；stats 行字段齐全。

**硬门槛（#16）**：

1. **竞态 reauth**：首次 authorize 通过、body 读期间 logout ⇒ 第二次 authorize 401，**无字节落盘**、`received` 不变。
2. **断连**：body 读一半客户端断开 ⇒ 状态零变化；写盘期间断开 ⇒ 重试得到 `dup:true` 或 409 + 正确 `received`。
3. **慢 fs 端到端**：注入慢 `UploadFsDeps` ⇒ HTTP 504 且在 `UPLOAD_TOTAL_MS` 内返回（不等到 Node `requestTimeout`）。
4. **关闭三路径（#13）**：(a) 正常 `close("stop")`：在途上传的 `.part` 目录全部消失、已提交保留；(b) `installProcessHandlers` 下发 SIGTERM（`process.emit("SIGTERM")`）⇒ 同 (a)；
   (c) 模拟 crash（不调用 close，直接丢弃 hub 实例）后以同一 stateDir 重启 ⇒ `recover()` 清掉孤儿并重建配额，审计 `recover` 行。
5. **重启后续传**：hub 重启后旧 id 的 chunk ⇒ 404，前端可据此判定重传（为 U4 契约提供依据）。

### 包 U4 — 前端传输与逻辑层（中；U4a ∥ U2，U4b 在 U3 后）

- U4a `src/web-hub/ui/src/logic/upload.js`（新）：`classifyPaste`、`collectDrop`、`fileFingerprint`、`pastedName`、`attachmentReduce`、`planChunks`、`composePrompt`
  （调 `@protocol/upload.ts` 的 `formatAttachmentBlock`）、`canSendWithAttachments`（§3.2 `sendGate` 的纯判定）、`uploadAvailability({ hubCaps, card, authMode })`、`utf8Len`。
- U4b：`logic/contract.js:36-46` `API` 追加 4 端点；`logic/token-client.js`（`postRaw`+`withRelogin`，chunk 用 `request()` `:87-107` 发 octet-stream，合并外部 `AbortSignal`）；
  `logic/password-client.js`（`postApi` `:265` / `request`，401 走 `onConn("auth")`，503 `E_BUSY` 复用退避）；`transport/{types,token,password}.ts` 追加可选 `upload?: UploadTransport`；
  `composables/useUploads.ts`（新）；`types.ts`（`ControlHandle` `:129-145`）追加可选 `uploads?`；`composables/useControl.ts` 在 `transport.upload` 存在时挂载。

验收：`tests/web-hub/ui/logic-upload.test.ts`（粘贴三情形、目录拒收、指纹、改名、状态机全转移表、`composePrompt` 48 KiB 边界、命令模式阻断、`canSendWithAttachments` 真值表、
`uploadAvailability` 真值表）；`transport-contract.test.ts` 两 transport 同形 upload 用例（header/body、409 续传、404 判失败、401、超时）；`use-uploads.test.ts`（并发上限、续传、
abort 中断 fetch 并调 abort 端点、`E_BUSY` 自动重试）；`source-scan.test.ts` 绿（无 `randomUUID`/`localStorage`/`innerHTML`/`createObjectURL`）。

### 包 U5 — Composer UI（中；**先过 diff 闸门**）

文件域：`components/control/Composer.vue`（`@paste`、拖拽、附件按钮、`AttachmentTray`、**`sendGate()` 作为唯一闸门**：`:80-85` 的 `canSend` 改为 `sendGate().ok`，
`doSend`（`:108`）首行调用，`onKeydown`（`:118`）删除自身的 deny 早退（`:123`）改由 `sendGate` 覆盖、`onSendClick`（`:127`）不变；`doSend` 用 `composePrompt` 拼接后 emit 并清托盘；
`import "../../styles/upload.css"`）、`components/control/AttachmentTray.vue`（新）、`styles/upload.css`（新）、`i18n/{en,zh}/upload.ts`（新）、`icons/`（仅追加）。

验收：`tests/web-hub/ui/composer-upload.test.ts`（新）：

- **三路径一致（#12）**：同一组条件（上传中 / 失败 / 命令模式 + 附件 / 超 48 KiB / sending / deny 命令 / 只读）下，Enter、Alt+Enter、点击按钮**均不 emit**；放行条件下三者 emit 的文本一致
  （Enter/点击用当前 deliver，Alt+Enter 为 followUp）；`coarse` 指针下 Enter 换行不受影响。
- 粘贴图片 ⇒ 托盘 ⇒ ready 后可发，emit 含附件块；文件+文本粘贴 ⇒ 文本仍进 textarea；拖入目录 ⇒ 提示；`//` 前缀 + 附件可发；空正文 + 附件可发；
  plaintext ⇒ 托盘非空时常驻警告且无关闭按钮；移除 ready 附件 ⇒ 调 abort。
- 原 `composer.test.ts` 全绿；「Enter 在 sending 时不发」为新增用例（§3.2 的有意行为变化）。
- `i18n-parity.test.ts`、`source-scan.test.ts` 绿；`npm run build:web && npm run check:web` 通过。
- 手工真机（tmux + 浏览器）：loopback 粘贴截图 → pi `read` 读到图片；LAN 手机附件按钮传 20 MB；hub 重启后孤儿被清；`uploads:"loopback"` 时 LAN 无入口且 curl 409。

### 全局闸门（每包合入前）

`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

---

## 7. 测试策略汇总

| 层       | 文件                                                                                                                                 | 关键覆盖点                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| protocol | `tests/web-hub/protocol/upload.test.ts`                                                                                              | 消毒、mime 注入、附件块格式/往返/行数性质、meta 解析                                                          |
| config   | `tests/config/*`                                                                                                                     | `webHub.uploads` 三值                                                                                         |
| agent    | `tests/web-hub/agent/wiring-control.test.ts`                                                                                         | caps 四种组合                                                                                                 |
| hub 存储 | `uploads.test.ts`、`upload-fs.test.ts`、`upload-fs-guard.test.ts`                                                                    | **硬门槛**：symlink、no-replace、崩溃恢复、short write、deadline、close                                       |
| hub HTTP | `api-upload.test.ts`、`lan-upload.test.ts`、`audit.test.ts`、`deadline-nesting.test.ts`、`sse.test.ts`、`agent-server-admin.test.ts` | **硬门槛**：reauth 竞态、断连、慢 fs、关闭三路径、重启续传；CSRF/能力/限流、引用标记、审计白名单、toCard 一致 |
| ui logic | `logic-upload.test.ts`、`transport-contract.test.ts`、`use-uploads.test.ts`                                                          | 粘贴分类、状态机、闸门真值表、两 transport 对称                                                               |
| ui 组件  | `composer-upload.test.ts` + `composer.test.ts`                                                                                       | 三入口、托盘、三发送路径一致、零回归                                                                          |
| 构建     | `npm run build:web && npm run check:web`                                                                                             | 产物与 manifest                                                                                               |

---

## 8. 待确认 / 开放问题

1. ~~`webHub.uploads` 默认值~~ —— **已由用户裁定为 `"on"`**（§5.0）。
2. 限额与 TTL 写死在 `protocol/upload.ts`；如需可配，经 `HubConfig`（`agent/index.ts:484-503`）下发，另立一包。
3. transcript 中 `[web-hub attachments]` 块折叠为附件 chip（涉及 `components/transcript/**`，有在途改动），后续项。
4. 会话结束时是否提前清理 bucket：当前不清（resume 需要），仅按 §2.6 TTL。
5. （v3 #8 已知残余）`/api/cmd` 成功回包后、`meta.referencedAt` 持久化前 hub 崩溃 ⇒ 重启后该附件按未引用处理（24h TTL）。进程存活期间无此问题；如需消除须把持久化改为回包前强制完成，代价是存储故障会让 prompt 回包失败（与「prompt 已送达」事实矛盾），故不采用。
