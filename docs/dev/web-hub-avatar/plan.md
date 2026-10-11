# web-hub 自定义用户头像 — 实施方案（v2.1）

> 状态：方案（未实施）。v1 被评审 r_MDTV4EK0（gpt-6.1-sol）**打回**（2 阻塞 / 9 严重 / 2 一般 / 1 建议，#1–#14），v2 逐条处置，处置表见 §10；v2 复审 r_R9KE2GPX 给出 **CONDITIONAL PASS**（0 阻塞 / 8 条），v2.1 并入 #1–#7、#8 列为实施期闸门（§7.5），处置表见 §11。
>
> 行号基线：`c238090`（master HEAD）+ 工作区里 sysload P0 的未提交改动（`git status`：`src/config/{settings,setting-specs}.ts`、`src/core/types.ts`、`src/service/request-threading.ts`、`src/web-hub/agent/index.ts`、`src/web-hub/hub/ports.ts`、`src/web-hub/protocol/{http-contract,messages}.ts`、`src/web-hub/ui/src/logic/contract.js`、`src/web-hub/ui/src/{types,transport/types}.ts` 等）。sysload 合入后行号会漂移，每包开工时按 §8.1 闸门重核。
>
> 用户裁定（2026-10-10，不得偏离）：**U-A1** 用户自己消息旁的头像（今为固定 `user` AppIcon，`src/web-hub/ui/src/components/transcript/TxUser.vue:42`）改为**上传图片**自定义；**U-A2** **存 hub 侧**，所有设备/浏览器看到同一张。前提：唯一用户、LAN 走密码鉴权（AGENTS.md web-hub 段 U1）。
>
> 主会话方向（2026-10-10）：接受 #14 的 v1 简化——单一开关、**一个**面向浏览器的 cap、单一固定头像文件、**完整 sha256** 作 ETag 与传播版本、无 loopback-only 三态、不新增 agent 侧 cap；保留严格格式校验、LAN 鉴权 + CSRF 矩阵、限流 + 在途上限、有界 IO、无路径审计。
>
> 基线（§8.1）：sysload P0–P5 已全部合入（最后 `22d32e7`），**`AVATAR_BASE=6694048`**（2026-10-11）。各包开工前按 §8.1 闸门重核行号。
>
> 车道：**L2 标准**（protocol / hub / UI / settings 四域，LAN 可写面）。

---

## 0. 结论速览（v2.1）

| 议题     | v2 结论                                                                                                                                                                                                                                 | 处置                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 开工顺序 | **sysload P0–P5 全部合入之后**才开 A0；每包有基线/rebase 闸门                                                                                                                                                                           | #1，§8.1                     |
| 开关     | 单布尔 `webHub.avatar`（默认 `true`）；`webHub.control:false` ⇒ 视为关；关 = `HubConfig.avatar` 键缺失 ⇒ hub 字节级不变                                                                                                                 | #11/#14，§2.6                |
| cap      | 仅 `avatar.v1` 一个，由 hub 宣告；经既有 `extraHubCaps` 出现在 `HubInfo.caps` 与 `hello_ack.caps` 两个既有面，agent 收到但忽略、自身不新增 cap                                                                                          | #14，v2.1 #6，§4.2           |
| 存储     | `<stateDir>/avatar/avatar.png` **单一固定文件**（0600），临时文件固定名 `avatar.png.tmp`；一次 `rename` 即原子替换；**无 meta 文件**（PNG 自身即全部状态：类型恒为 PNG、尺寸在 IHDR、版本 = 字节 sha256）                               | #6/#10/#14，§1               |
| 格式     | **只收 PNG**（方形 16–256px、8-bit RGB/RGBA、非隔行）；严格 chunk 走查（CRC、长度、定长白名单、无 iCCP、拒 APNG、IHDR/IEND 唯一且位置正确、无尾随）+ hub 侧 zlib **恰好一个流完整消费**（`bytesWritten === idat.length`）且解压长度精确 | #4，v2.1 #3，§3              |
| 客户端   | 解码前纯 JS 解析源图尺寸（PNG/JPEG/GIF/WebP 头），超预算不解码；`createImageBitmap` → canvas 居中裁方 → `toDataURL("image/png")` → 与 hub **同一个**纯函数校验器自检 → 上传；无原字节退路                                               | #5，§3.4                     |
| 版本     | `v` = 完整 64 位 hex sha256；ETag `"<v>"`；`HubInfo.avatar = { gen, v? }`，`gen` 为本 hub 进程单调计数；客户端按 `(hub 身份, gen)` 排序，旧观测一律丢弃                                                                                 | #7/#8，§4                    |
| IO       | 专用 `hub/avatar/fs.ts`：fs 步骤经 `racePreviewIo` + `createPreviewIoTracker(1)` 计 zombie；迟到 open 自动 close；`pending` + 惰性 30s 上限转 `disabled`；`epoch` 栅栏：close 后迟到回调只回收 fd                                       | #2/#3，v2.1 #1，§1.4         |
| 提交语义 | **rename（或 unlink）成功 = 成功**；identity 检查放在提交点**之前**（计入预算），提交点后无请求内 fs；目录 fsync 后台 best-effort；超时 ⇒ 504 `unknown` + 唯一 reconcile                                                                | #3，v2.1 #2，§1.4            |
| 预算     | 总 14s；PUT 六步上限 `[250,500,1000,1500,250,500]` 合计 4000 = 存储保底；每步发起前 `remaining ≥ 后缀和`，不足即 504；请求路径无重试、无 chmod；`readBody` 408 ⇒ 504                                                                    | #9，v2.1 #4 #7，§1.4.2、§2.3 |
| 并发     | 写在途全局 = 1，在**读 body 之前**取槽；第二个并发写**确定性** 503 `inflight`；GET 槽 ≤ 8：鉴权后取、`finish\|close` 一次性释放、10s 发送截止                                                                                           | #10/#12，v2.1 #5，§2.4       |
| 审计     | 冻结 schema，每请求恰好一行（429 例外：每主体 60s 一行），`finally` 单点写出；从不写路径、原始 error message、内容                                                                                                                      | #13，§2.7                    |

---

## 1. 存储

### 1.1 作用域：每 hub 一张（沿用 v1，理由不变）

loopback 无用户身份（token cookie，`hub/auth.ts:1-12`；主体退化为 `"token"`，同 `upload-http.ts:527`），按 LAN 用户分会让本机与手机看到不同头像，违反 U-A2。任一已鉴权主体可读写；多 LAN 用户时代的风险登记 §9 R1。

### 1.2 信任边界与布局（#6）

```
<stateDir>/                      # 信任根：hub 启动时 ensurePrivateDir(STATE_DIR_POLICY)（hub.ts:282）
└── avatar/                      # 本功能唯一目录：lstat 必须是真目录（非 symlink）、uid=getuid、模式修到 0700
    ├── avatar.png               # 0600；存在且通过 §3 校验 ⇔ 有头像
    └── avatar.png.tmp           # 写入中；固定名 + O_EXCL；启动时按名删除
```

- **信任模型（明确写死）**：`stateDir` 自身及其祖先是信任根——`STATE_DIR_POLICY.allowOwnedSymlink = true`（`protocol/paths.ts:66-71`），`ensurePrivateDir` 对它用 `stat`（跟随链接，`paths.ts:292-310`）是用户可选的既有信任（上传方案 §2.1 同口径）。同 uid 进程不在威胁范围（它能直接改 hub 的一切）。
- **`avatar/` 只有一级**，由新 `hub/avatar/fs.ts` 的 `ensureAvatarDir` 校验：`lstat`（从不 `stat`）→ ENOENT 则非递归 `mkdir(0o700)`（EEXIST 再 lstat 一次）→ 必须 `isDirectory() && !isSymbolicLink()`、`uid === getuid()`、`(mode & 0o777) !== 0o700` 时 `chmod 0o700`（父是我们的 0700 stateDir，同 `upload-fs.ts:217-233` `validatePrivateDir` 的修复理由）→ 记录 `{dev, ino}`。v1 所说「逐级 lstat」不成立（评审 #6 正确）：本版只声明这一级。
- **每次写**在打开 tmp 前（P1）与提交点前（P5；DELETE 为 D1）各 `lstat(avatar/)` 一次比对 `{dev, ino}`，均计入请求预算；不一致 ⇒ store 转 `disabled{reason:"dir-swapped"}`，零提交、不按路径删除任何东西（v2.1：取消 v2 的「rename 后再比对」，见 §1.4.2）。
- **文件**：两个固定名，常量冻结在 `protocol/avatar.ts`（`AVATAR_FILE = "avatar.png"`、`AVATAR_TMP = "avatar.png.tmp"`）；不再有任何由哈希/输入派生的路径（v1 的 `img-<sha>` 取消）。打开一律 `O_NOFOLLOW`；读路径 `fstat` 必须 `isFile()`、`uid === getuid()`、`nlink === 1`（拒硬链接到别处的文件）、`(mode & 0o077) === 0`、`size ≤ AVATAR_MAX_BYTES`；任一不符 ⇒ 视为无头像 + 一条 warn（reason 词表见 §2.7），不 chmod、不删。tmp 以 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`、`0o600` 创建。
- 伪造路径测试见 §7.1（symlink 目录、symlink 文件、硬链接文件、他人属主、宽模式、FIFO）。

### 1.3 为什么不需要 meta 文件（#14 简化）

v1 的 `meta.json` 存的 mime / 宽高 / sha 在「只收 PNG」后全部可从字节推出：mime 恒为 `image/png`、尺寸在 IHDR、版本 = `sha256(bytes)`（load 时算一次、commit 时算一次，≤ 512 KiB，亚毫秒）。单文件 + 单 rename 就是原子替换，没有「两个文件之间的崩溃窗口」可言——比「单文件 + 原子 meta」更少一个提交点；主会话要求的「原子 meta」在此退化为「文件本身即 meta」。

### 1.4 IO 层与状态机（#2 #3 #9 #10；v2.1 #1 #2 #4 修订）

**IO 内核** `hub/avatar/fs.ts`（avatar 侧唯一 import `node:fs/promises` 的文件；源码扫描钉住，§7.1）：

- 每个 fs 调用经 `racePreviewIo(p, deadlineAt, undefined, now, tracker)`（`hub/preview/fs.ts:174-227`：竞速输掉的调用记为 zombie，底层落定时减回）；store 私有 `tracker = createPreviewIoTracker(1)`（`fs.ts:114-128`）——**存在 1 个 zombie 时任何新的 avatar fs 操作直接快速失败**（`fs.ts:255-257` 的 `busy` 语义），不排队、不等待。只 import、不修改 preview/fs.ts。
- **迟到 open 回收**：`open` 竞速输掉时，对底层 promise 挂 `.then(fh => fh.close())`（preview admit 的「迟到回收」先例，`hub/preview/admit.ts:19,392`）。`upload-fs.ts:60-81` 的 `fsStep` 没有这条，故 avatar 不复用 `fsStep`/`openFileNoFollow`。
- **close** 一律走「底层操作落定后再 close」链：`writeP.finally(() => fh.close())`，close 自己有独立 1s 预算并计 zombie（同 `boundedClose`，`fs.ts:553-565`，不受请求 abort 影响）。fd 回收是唯一**不受** §1.4.3 栅栏限制的迟到动作。
- 只用于 hub 内的有界读：load 用定位 `read` 循环读至 `AVATAR_MAX_BYTES + 1` 字节为止（多读 1 字节即判超限）。

#### 1.4.1 store 状态机（`hub/avatar/store.ts`，无定时器、无后台循环）

```
           load ok                       put/delete 取槽
loading ──────────────► ready ◄──────────────────────────► writing
   │ load io 失败            ▲   提交成功 / 提交前失败              │
   ▼                         │                                     │ rename/unlink 竞速超时
disabled ◄──── 惰性检查：pending 超过 AVATAR_PENDING_CEILING_MS ─── pending(op, expected)
   ▲                                       │ 底层落定：成功⇒采纳 expected；失败⇒保持旧值
   └── 提交前 identity 不符(dir-swapped)    └──► ready（发布真值 + reconcile 审计行）
任何状态 ──close()──► closing（终态；epoch 递增，见 §1.4.3）
```

#### 1.4.2 PUT / DELETE 步骤与逐步预算（v2.1 #2 #4）

**规则**：每步 `i` 有固定上限 `cap_i`；**发起第 `i` 步之前**必须 `deadline.remaining() ≥ Σ_{j≥i} cap_j`（剩余所有步骤上限之和，即「后缀和」），否则不发起、直接 504 `E_DEADLINE{effect:"none"}`；第 `i` 步以恰好 `cap_i` 竞速。由此提交点（rename/unlink）一定拿到完整预算，且任何 fs 调用都不会在预算不足时被启动。请求路径上**不 chmod、不重试、不 unlink-重建**。

| PUT 步 | 动作                                                                              | `cap`  | 失败处置                                                                                                                                |
| ------ | --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | `lstat avatar/`，比对 load 时记录的 `{dev, ino}` + 仍是目录、非 symlink、uid 相符 | 250ms  | 不符 ⇒ `disabled{dir-swapped}`，零后续 fs；超时 ⇒ 504 none                                                                              |
| P2     | `open(avatar.png.tmp, O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW, 0o600)`              | 500ms  | **`EEXIST` ⇒ 503 `E_BUSY{reason:"tmp-exists"}`，请求内不重试**（tmp 只由启动 load 或它自己的落定链删除）；其它 ⇒ 500/504 none           |
| P3     | 写全量（循环防 short write）                                                      | 1000ms | 504/500 none，tmp 走落定链删除                                                                                                          |
| P4     | `datasync`                                                                        | 1500ms | 同上                                                                                                                                    |
| P5     | `lstat avatar/` 再比对 identity——**提交前闸门**（v2.1 #2：取「提交前」方案）      | 250ms  | 不符 ⇒ `disabled{dir-swapped}`，**不按路径删除 tmp**（目录已被替换，按路径删会删错对象；留给下次启动）；超时 ⇒ 504 none，tmp 落定链删除 |
| P6     | `rename(tmp → avatar.png)`——**提交点**                                            | 500ms  | 失败 ⇒ 500 none + tmp 落定链删除；**竞速超时 ⇒ 504 `effect:"unknown"` + `pending`**                                                     |
| —      | 合计 `AVATAR_STORE_MIN_MS = 4000`                                                 |        |                                                                                                                                         |

| DELETE 步 | 动作                                                | `cap` | 失败处置                                          |
| --------- | --------------------------------------------------- | ----- | ------------------------------------------------- |
| D1        | `lstat avatar/` identity 闸门                       | 250ms | 不符 ⇒ `disabled{dir-swapped}`，不 unlink         |
| D2        | `unlink(avatar.png)`——提交点（ENOENT = 成功，幂等） | 500ms | 竞速超时 ⇒ 504 `unknown` + `pending{op:"delete"}` |
| —         | 合计 `AVATAR_DELETE_MIN_MS = 750`                   |       |                                                   |

- **提交点之后没有任何请求内 fs 步骤**（v2 的「rename 后再 lstat」删除——评审 r_R9KE2GPX #2 指出它无法回滚且无处理语义）。残余窗口：P5 与 P6 之间目录被替换只可能来自同 uid 进程，属 §1.2 信任模型之外；它会在下一次写的 P1 或下一次启动 load 时被发现。
- 落定链上的 close / tmp-unlink、以及提交后的后台目录 fsync 都**不在**请求预算内：各自独立有界（1s / 500ms / 1s）、计 zombie、失败只写审计 `io` 字段。
- `chmod` 只出现在 load（启动、5s 总预算内的 `ensureAvatarDir` 模式修复），请求路径没有。

#### 1.4.3 提交语义、pending、栅栏（v2.1 #1）

- **提交语义（决定：rename/unlink 成功即成功）**：P6/D2 resolve ⇒ 同步执行 `commit()`：`memory = {bytes, v}`（或 `null`）、`gen += 1`、`onChange` 发布 `hub` 帧、回 200；随后**后台** best-effort `fsync(avatar/)`。理由同 v2：rename 是可见性原子点；目录 fsync 只影响掉电持久性，`upload-fs.ts:384-390` 已定为 advisory。
- **pending**：P6/D2 竞速超时 ⇒ 回 504 `effect:"unknown"`、store 进 `pending{op, expected, since, epoch}`、**立即释放写槽**；底层落定时走同一个 `commit()`（成功）或保持旧值（失败），写一行 `phase:"reconcile"` 审计后回 `ready`（若已 `disabled`，保持 `disabled` 但仍更新内存并发布）。`pending` 期间写 503 `E_BUSY{reason:"pending"}`；请求到达时惰性检查 `now − since > AVATAR_PENDING_CEILING_MS (30s)` ⇒ `disabled{zombie}`。
- **栅栏（新）**：store 持有 `epoch: number`，`close()` 第一步 `state = "closing"; epoch += 1`。所有**迟到回调**——load 完成、reconcile 落定、后台 fsync 结果——在起点捕获 `const e = epoch`，在回调里先判 `if (state === "closing" || e !== epoch)`：成立则**只回收资源**（关 fd；不做 tmp unlink，留给下次启动），**不改内存、不加 gen、不调 `onChange`、不写审计/日志**。`commit()` 本身也先过这道栅栏。hub.ts 侧的 `onChange` 包装再以 hub 自己的 `closing` 变量（`hub.ts` `shutdown` 段）做第二道栅栏。
- **load**：`store.load()` 在入口把自身 promise 注册为 `loadP`（重复调用返回同一 promise；`closing` 后调用直接 resolve、零 fs）。总 5s：`ensureAvatarDir`（可 chmod）→ 按名 unlink tmp（ENOENT 忽略）→ open/fstat/read `avatar.png`（§1.2 检查）→ §3 校验 → `memory`；完成后（过栅栏）`gen = 1`、发布、写一行 `op:"load"` 审计。文件不存在 / 校验失败 ⇒ `ready` 空；目录/IO 超时 ⇒ `disabled{load-io|dir}`。hub.ts 以 `void store.load()` 启动，不阻塞 listen（同 uploads 的 `void uploads.recover()`，`hub.ts:1040`）。
- **close()**：`closing` + `epoch++` → 在**同一个** 1s 截止内依次 `await race(loadP ?? done, …)`、`await race(writingP ?? done, …)`，到点即返回，不等 zombie、不等 pending 落定。之后写 503 `E_HUB_RESTARTING`、GET 503 `E_HUB_RESTARTING`。在 hub 运行期 `close()` 里放在 `fe.close()` 之后、与 `uploads.close()` 相邻（`hub.ts:1451`），并包进既有 `bounded(...)`。
- **同内容重传**：`sha256` 等于当前 `v` ⇒ 不碰盘、不加 `gen`、不发布、回 200 `dedup:true`。
- **GC**：无扫描。固定 tmp 名只在两处删除：启动 load 时按名 unlink；提交前失败（且未判 dir-swapped）时走落定链按名删除。

---

## 2. API

### 2.1 端点（冻结于 `protocol/avatar.ts`）

```
GET  /api/avatar                 X-PWH: 1 ; If-None-Match 可选
  200 <png bytes>  Content-Type: image/png ; ETag: "<64 hex>" ; Cache-Control: private, no-cache
  304              （If-None-Match 与完整 ETag 精确相等）
  404 E_NOT_FOUND  （ready 且无头像）
  503 E_BUSY{reason:"loading"|"disabled"|"inflight"} · 503 E_HUB_RESTARTING
POST /api/avatar                 Content-Type: application/octet-stream ; X-PWH: 1 ; body ≤ 512 KiB
  200 { avatar:{ v, gen, side, bytes, dedup? }, hub:{ pid, startedAt } }
  413 E_AVATAR_TOO_LARGE{max} · 415 E_AVATAR_UNSUPPORTED{reason}
  503 E_BUSY{reason:"inflight"|"pending"|"loading"|"disabled"|"tmp-exists"} · 504 E_DEADLINE{effect:"none"|"unknown"}
POST /api/avatar/delete          Content-Type: application/json ; X-PWH: 1 ; body `{}`（≤256 B，additionalProperties:false）
  200 { avatar:{ gen }, hub:{ pid, startedAt } }   （幂等）
共有：401 E_AUTH · 403 E_CSRF · 429 E_RATE(+Retry-After) · 503 E_HUB_RESTARTING
```

- `AvatarRejectReason`（冻结联合 + 常量数组，UI i18n 一一对应）：`"signature" | "ihdr" | "dims" | "color" | "chunk" | "crc" | "animated" | "order" | "trailing" | "idat" | "size"`。
- 新错误码尾追加到 `protocol/http-contract.ts` 的 `API_ERRORS`（append-only 规则见该数组内注释；**排在 sysload 追加的码之后**）：`E_AVATAR_TOO_LARGE`(413)、`E_AVATAR_UNSUPPORTED`(415)。前端 `logic/contract.js` 是同一数组 re-export（`tests/web-hub/ui/logic-contract.test.ts:16-30`）。
- 写用 POST：两 listener 只在 POST 分支派发写端点（LAN `http.ts:1455`、loopback `http.ts:2806`），`OPTIONS` 一律 404（`http.ts:1261`）。
- **服务端不做 CAS**：最后写者胜（唯一用户；客户端排序见 §4.3）。v2 明确不提供 `If-Match`。

### 2.2 管线（POST /api/avatar，冻结顺序）

| 步  | 动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 失败             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| ①   | 方法/路径；`createReqDeadline(now, AVATAR_TOTAL_MS)`；`reqId = randomBytes(8)`                                                                                                                                                                                                                                                                                                                                                                                                                        | 404              |
| ②   | CSRF（闭包注入，先于鉴权）：`uploadCsrfOk(req, expectedOrigin)`（`http.ts:1894-1908`）                                                                                                                                                                                                                                                                                                                                                                                                                | 403 `E_CSRF`     |
| ③   | `authorize#1`：loopback 同步 cookie（`http.ts:2814-2820` 原样）；LAN `requireLanSession` 竞速 `deriveBudget(remaining, AVATAR_AUTH_CAP_MS, AVATAR_BODY_MIN_MS + AVATAR_AUTH2_CAP_MS + AVATAR_STORE_MIN_MS)`                                                                                                                                                                                                                                                                                           | 401 / 503 `E_DB` |
| ④   | 写令牌桶（路由私有 `createCmdLimit`，键 `${listener}:${principal}:avatar-w`，容量 10、每 6s +1）                                                                                                                                                                                                                                                                                                                                                                                                      | 429              |
| ⑤   | store 闸门：`closing` ⇒ 503 `E_HUB_RESTARTING`；`loading/disabled/pending` ⇒ 503 `E_BUSY{reason}`；**取全局写槽（=1），已占 ⇒ 503 `E_BUSY{reason:"inflight"}`**——在读 body 之前                                                                                                                                                                                                                                                                                                                       | 503              |
| ⑥   | `Content-Length > AVATAR_MAX_BYTES` ⇒ 413；`remaining < AVATAR_BODY_MIN_MS + auth2 + AVATAR_STORE_MIN_MS` ⇒ 504 `effect:"none"`                                                                                                                                                                                                                                                                                                                                                                       | 413 / 504        |
| ⑦   | `io.readBody(req, AVATAR_MAX_BYTES, min(AVATAR_BODY_CAP_MS, remaining − auth2 − AVATAR_STORE_MIN_MS))`。路由**自己捕获** `readBody` 的两种 `HttpError`（`http.ts:337,353` 抛 413，`:356` 抛 `408 "E_DEADLINE"`）：413 ⇒ 413 `E_AVATAR_TOO_LARGE{max}`；**408 ⇒ 504 `E_DEADLINE{effect:"none"}`**（v2.1 #7）。两者都设 `Connection: close` 并 `res.once("finish", () => req.destroy())`——与外层兜底 `http.ts:2930-2937` 对 413/408 的连接处置一致，但状态码按本端点契约改为 504，绝不让 408 冒泡到外层 | 413 / 504        |
| ⑧   | `validateAvatarPng(bytes)` + hub 侧 zlib 精确核对（§3.2，同步 CPU）                                                                                                                                                                                                                                                                                                                                                                                                                                   | 415              |
| ⑨   | `authorize#2`（仅 LAN，上限 `min(AVATAR_AUTH2_CAP_MS, remaining − AVATAR_STORE_MIN_MS)`；慢 body 期间会话可能被吊销）                                                                                                                                                                                                                                                                                                                                                                                 | 401              |
| ⑩   | `remaining < AVATAR_STORE_MIN_MS` ⇒ 504 `effect:"none"`，**不发起任何 fs 操作**                                                                                                                                                                                                                                                                                                                                                                                                                       | 504              |
| ⑪   | `store.put(bytes, v, deadline)`（§1.4.2 逐步后缀和预算）                                                                                                                                                                                                                                                                                                                                                                                                                                              | 见 §1.4          |
| ⑫   | `finally`：释放写槽（恰一次）、写审计行（恰一次）                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                |

**DELETE**：①、② `strictCsrfOk`（`http.ts:1875-1888`）、③（reserve = `AVATAR_DELETE_MIN_MS`）、④、⑤、读 ≤256 B JSON（同样自捕 408 ⇒ 504 none）并严格校验、⑩（`remaining < AVATAR_DELETE_MIN_MS` ⇒ 504 none）、`store.remove()`（§1.4.2 D1/D2）、⑫。

**GET**（v2.1 #5，冻结顺序）：

1. ① 总 `AVATAR_GET_TOTAL_MS = 8000`；② `previewCsrfOk` 同规则（`hub/preview/routes.ts:125-134`：X-PWH 必须；Origin / Sec-Fetch-Site 若在必须匹配 / same-origin）；③ 鉴权；读令牌桶（`avatar-r`，30、每 1s +1）；store 闸门（`loading/disabled/closing` ⇒ 503）。
2. **取 GET 槽**：全局计数 `getInflight < AVATAR_GET_INFLIGHT (8)`，否则 503 `E_BUSY{reason:"inflight"}`（不写 body）。取槽在鉴权之后、发送之前。
3. 取槽后**先**注册释放：`const release = once(() => { getInflight -= 1; clearTimeout(t); })`；`res.once("finish", release)`、`res.once("close", release)`（Node 在正常结束时两者都会触发，`once` 包装保证恰减一次）。
4. 启动响应截止 `t = setTimeout(() => res.destroy(), AVATAR_GET_SEND_MS = 10_000).unref()`——慢客户端/不读 socket 的连接在 10s 后被销毁，`close` 事件触发 `release`。
5. 发送：304（`If-None-Match` 完整相等）或 200 + 内存字节（`res.end(bytes)`）；`ETag` 取**发送时刻**的内存快照，不跨 await。
6. ⑫ 审计在 `release` 内写（恰一次；带 `ok = res.writableFinished`，被截止销毁的记 `io:"deadline"`，客户端中断的记 `io:"abort"`）。

### 2.3 预算（#9；v2.1 #4 修订，冻结常量，全部写进 `protocol/avatar.ts`）

| 常量                                                                 | 值                                 | 说明                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AVATAR_TOTAL_MS`                                                    | 14 000                             | < 两 listener `requestTimeout = 15 000`（`http.ts:153,538,2968`）< 浏览器 16 000（`token-client.js:46`） |
| `AVATAR_AUTH_CAP_MS`                                                 | 2 000                              | LAN 首次鉴权上限（低于通用 `LAN_AUTH_CAP_MS = 3000`，`req-deadline.ts:32`）                              |
| `AVATAR_BODY_MIN_MS` / `AVATAR_BODY_CAP_MS`                          | 1 000 / 5 000                      | 实际 body < 280 KiB（§3.3）                                                                              |
| `AVATAR_AUTH2_CAP_MS`                                                | 1 000（loopback 0）                | 二次鉴权                                                                                                 |
| `AVATAR_PUT_STEP_CAPS`                                               | `[250, 500, 1000, 1500, 250, 500]` | P1–P6（§1.4.2）                                                                                          |
| `AVATAR_STORE_MIN_MS`                                                | 4 000                              | **= `sum(AVATAR_PUT_STEP_CAPS)`**（测试钉等式）；⑥⑩ 与每步发起前的后缀和校验                             |
| `AVATAR_DELETE_STEP_CAPS` / `AVATAR_DELETE_MIN_MS`                   | `[250, 500]` / 750                 | D1–D2；同样等式                                                                                          |
| `AVATAR_GET_TOTAL_MS` / `AVATAR_GET_SEND_MS` / `AVATAR_GET_INFLIGHT` | 8 000 / 10 000 / 8                 | GET 准入预算 / 发送截止 / 全局槽                                                                         |
| `AVATAR_LOAD_TOTAL_MS` / `AVATAR_CLOSE_WAIT_MS`                      | 5 000 / 1 000                      | load 总预算 / close 等待上限                                                                             |
| `AVATAR_PENDING_CEILING_MS`                                          | 30 000                             | pending → disabled 的惰性上限                                                                            |
| 最坏链                                                               | 2 + 5 + 1 + 4 = 12s ≤ 14s          | 余 2s 给调度/回包                                                                                        |

请求路径上只有 P1–P6 / D1–D2 这些 fs 调用（无重试、无 chmod）；`deriveBudget` 只做 `max(0, min(cap, remaining − reserve))`（`req-deadline.ts:57-59`），保底完全由 ⑥⑩ 与 §1.4.2 的后缀和校验实现，测试逐步断言（§7.1）。

### 2.4 并发语义（#10 #12；v2.1 #5 补 GET 槽）

- 写（PUT + DELETE 共用）：全局在途槽 = 1，在 ⑤ 取得、⑫ 释放；**第二个并发写一律 503 `E_BUSY{reason:"inflight"}` + `Retry-After: 1`**，绝不排队、绝不读它的 body。内存上界：同时最多 1 个 body（≤ 512 KiB）在读。
- `pending` / `disabled` / `loading` 时写一律 503，reason 区分；`tmp-exists`（P2 EEXIST）同为 503。
- GET：全局槽 ≤ 8，鉴权后取、`finish|close` 一次性释放、10s 发送截止（§2.2 GET 2–6）；慢客户端最多占槽 10s，无主体级在途上限（令牌桶已足）。
- 测试严格验收：并发两写 ⇒ 恰一个 200、恰一个 503 `inflight`；第 9 个并发 GET ⇒ 503；槽在 `finish`、`close`、截止销毁三条路径上都恰释放一次。

### 2.5 下发头部（GET 200）

`Content-Type: image/png`（常量，不来自任何输入）；`X-Content-Type-Options: nosniff` 已由 `setSecurityHeaders` 全局设置（`http.ts:300-305`）；CSP 不变 `img-src 'self' data:`（`http.ts:139-140`）；`Content-Disposition: inline; filename="avatar.png"`；`Cross-Origin-Resource-Policy: same-origin`（先例 `preview/routes.ts:230`）；`Cache-Control: private, no-cache`（覆盖 `/api` 统一的 `no-store`，`http.ts:1290,2656`）；`ETag: "<64 hex>"`（**完整** sha256，#7）；`Content-Length`。304 只带 ETag + Cache-Control。

### 2.6 开关、`control:false`、listener 矩阵（#11 #14）

- 设置：`webHub.avatar: boolean`，默认 `true`（`src/config/setting-specs.ts` 新 `boolean` 项；`src/config/settings.ts` 的 webHub 解析段按 `typeof === "boolean"` 容错，同 `steerRecall`；非 live：`/reload` + `/webhub restart`）。
- **`control:false` ⇒ 视为关**：`buildHubConfig`（`src/web-hub/agent/index.ts`）只在 `settings.avatar !== false && settings.control !== false` 时写 `config.avatar = true`。先例：`webHub.uploads` 在 `control:false` 时按 off 处理（`agent/index.ts:124-127` 注释）。理由：`control:false` 的含义是「web 只读」，上传头像是写；整功能关（含 GET）最简单、最可预期。
- `HubConfig.avatar?: true`（`hub/ports.ts` `HubConfig`，`:370` 起）；`hub/main.ts` 对它做同 preview 的 fail-soft 重校验（非 `true` 即删键）。
- **为何不「挂在 preview/LAN 闸门后面常开」**：preview 是读任意文件的面，语义与头像无关，复用它的门会让「关预览」意外关掉头像、「开头像」意外要求开预览；而 LAN 闸门本来就自然生效（无 LAN listener 就只有 loopback）。单布尔 + 键缺失 = 关，既保住「关 = 字节一致」（现有测试的 `config()` 不带该键，`agent-server-admin.test.ts:115-125` 等钉死 caps 序列），又只多一个开关。
- **无 loopback-only 三态**：开 ⇒ 两个 listener 都提供（若 LAN listener 存在）；关 ⇒ 都 404。
- 关闭时：不建 store、不建路由、不声明 cap、`HubInfo` 无 `avatar` 字段；两 listener 三端点响应与「未知 `/api` 路径」字节一致。

### 2.7 审计（#13，冻结 schema）

`hub/audit.ts` 尾追加 `AvatarAuditRecord` / `AVATAR_AUDIT_KEYS` / `auditAvatar()`，形状照 `auditRemove`（`audit.ts:403-439`：运行时白名单裁剪，`log.info("avatar", { audit:"avatar", ... })`）：

```ts
interface AvatarAuditRecord {
  reqId: string; // 16 hex；reconcile/load 行用触发它的 reqId 或 "load"
  op: "get" | "put" | "delete" | "load";
  phase: "request" | "reject" | "reconcile";
  ok: boolean;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string; // "u<id>" | 缺省(token)
  code?: string; // API_ERRORS 成员
  reason?: string; // AvatarRejectReason ∪ {"inflight","pending","loading","disabled","tmp-exists","dir","dir-swapped","zombie","load-io","file-mode","file-owner","file-nlink","file-type"}
  effect?: "none" | "unknown";
  io?: "deadline" | "busy" | "abort" | "errno";
  errno?: string; // 仅当匹配 /^E[A-Z0-9]{2,15}$/，否则省略
  bytes?: number;
  side?: number;
  v?: string /* 64 hex */;
  gen?: number;
  dedup?: boolean;
  ms: number;
}
```

- **恰一次**：路由每个请求在 `finally` 单点写一行（`audited` 标志防重入）；GET 在槽释放回调里写（§2.2 GET 6，量很小：每页面每版本一次）。`closing` 之后迟到的 load/reconcile 不写（I8）。**唯一例外**：429 每 `avatar:${principal}` 60s 一行（同 `upload-http.ts:538-565` 的节流）。store 的 reconcile 与 load 各写恰一行。
- **脱敏**：从不写路径（含 stateDir）、`err.message`、`String(err)`、请求体/文件内容、文件名；errno 只取 `code` 且过正则；`log.warn/error` 的 store 诊断同样只带 reason/errno。
- 覆盖：§7.1 对 ②–⑫ 每个早退出口与 reconcile/load 各断言「恰一行 + 只含白名单键 + 不含 `/`」。

---

## 3. 图片格式（#4 #5）

### 3.1 决定：v1 只收客户端重编码出的 PNG

- 评审 #4 指出 JPEG（仅 SOI/EOI）与 WebP（仅 RIFF/VP8X 位）的 v1 检查远不是有限状态解析。为 JPEG/WebP 写严格解析器 + 恶意语料，成本远高于收益；而头像的生产者就是我们自己的浏览器代码。故：**客户端总是 canvas 重编码为 PNG**，服务器**只收 PNG**，且只收该产物的形状。原字节上传退路（v1 §3.4）取消；GIF/JPEG/WebP/SVG/APNG 一律在服务器侧 415。
- 校验器是**一个纯函数**，放 `src/web-hub/protocol/avatar-png.ts`（无 `node:*` import，UI 经 `@protocol` 别名导入——先例 `token-client.js` 导入 `@protocol/preview.ts`）：hub 在 ⑧ 用它，客户端在上传前、以及取图后转 `data:` URL 前各用它一次。

### 3.2 严格 PNG 走查（`validateAvatarPng(bytes) → {ok, side} | {ok:false, reason}`；v2.1 #3 修订）

1. `bytes.length ≤ AVATAR_MAX_BYTES`，否则 `size`；前 8 字节 = PNG 签名，否则 `signature`。
2. 逐 chunk：读 `len`（u32be，必须 ≤ 剩余字节 − 12，且 ≤ 2³¹−1）、`type`（4 个 ASCII 字母）、`data`、`crc`；**CRC32 必须匹配**（纯 JS 查表实现，不依赖 `zlib.crc32` 的 Node 小版本）否则 `crc`；chunk 数 ≤ 64 否则 `chunk`。
3. 首块必须 `IHDR` 且 `len = 13`，否则 `ihdr`；**第二次出现 `IHDR` ⇒ `ihdr`**；`w === h` 且 `16 ≤ w ≤ 256` 否则 `dims`；`bitDepth = 8`、`colorType ∈ {2, 6}`、`compression = 0`、`filter = 0`、`interlace = 0` 否则 `color`。
4. 白名单（其余任何块 ⇒ `chunk`）：`IHDR`、`IDAT`、`IEND`，以及**无载荷、定长**的辅助块 `sRGB`(1)、`gAMA`(4)、`cHRM`(32)、`pHYs`(9)、`sBIT`(3|4)、`bKGD`(6)、`tRNS`(6，仅 colorType 2)；长度不符 ⇒ `chunk`；每种辅助块最多一次。**`iCCP` 从白名单移除**（v2.1 #3：客户端重编码从不需要它；它是唯一能携带压缩任意字节的块，严格校验 ICC 不值得）⇒ `chunk`。`acTL`/`fcTL`/`fdAT` ⇒ `animated`；`tEXt`/`zTXt`/`iTXt`/`eXIf` ⇒ `chunk`。
5. 顺序：辅助块只能在首个 `IDAT` 之前；`IDAT` 必须连续且 ≥ 1 个，否则 `order`/`idat`。
6. **`IEND` 恰好出现一次且是最后一块**：任何不在末尾的 `IEND`（含 `IEND` 之后再出现任何块、第二个 `IEND`）⇒ `order`；`IEND.len ≠ 0` ⇒ `chunk`；其 CRC 之后还有字节 ⇒ `trailing`。

**hub 侧 zlib 精确核对**（`hub/avatar/validate.ts`，Node 内置 zlib，不是图像库；协议纯函数不含此步，因为浏览器端无同步 inflate）：

- `idat = concat(所有 IDAT.data)`；`expected = side × (1 + side × channels)`（`channels` = 3 / 4）。
- `const r = inflateSync(idat, { info: true, maxOutputLength: expected })`；任何抛错（含输出超过 `maxOutputLength` 的 `RangeError`、截断流的 `Z_BUF_ERROR`、预置字典）⇒ `idat`。
- **输入必须被恰好一个 zlib 流完整消费**：`r.engine.bytesWritten === idat.length`，否则 `idat`（v2.1 #3）。实测（本机 Node v22.22.1，`node -e` 只读实验）：`inflateSync` 对「合法 deflate 17 B + 15 B 尾随」返回成功且 `bytesWritten = 17`、输入 32；两个 zlib 流首尾相接时同样只消费第一个（`bytesWritten = 17`、输入 34）——即 Node **默认静默接受尾随字节**，必须用 `bytesWritten` 比对拒绝。
- `r.buffer.length === expected`，且每行首字节（filter type）≤ 4，否则 `idat`。
- `side ≤ 256` ⇒ `expected ≤ 262 400` 字节，CPU/内存有界。
- 结果：所有字节都有确定含义——签名、定长头/辅助块、恰好一个消费完全的 zlib 流（解出恰是像素）、IEND；不存在可藏任意载荷的位置。

### 3.3 尺寸上界推导

256×256 RGBA 原始 = 262 144 B + 256 行过滤字节；zlib 最坏（stored 块）每 64 KiB 多 5 B；块头与定长辅助块 < 200 B ⇒ **< 280 KiB** < `AVATAR_MAX_BYTES = 512 KiB`。合法客户端永远不会撞 413。

### 3.4 客户端处理（#5：解码前先查尺寸）

`ui/src/composables/useAvatarEditor.ts`（注入缝：`createBitmap` / `createCanvas` / `readSlice`，同 `useAttachmentPreview.ts:30-31,67-70` 的注入方式）：

1. `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">` 取 `File`；`file.size > 20 MiB` ⇒ 本地拒绝（不读）。
2. **解码前**：`file.slice(0, 1 MiB).arrayBuffer()`（不生成任何 URL），纯 JS `sourceDims(bytes)`（新 `ui/src/logic/avatarSource.ts`：PNG IHDR、GIF 逻辑屏幕描述符、WebP VP8/VP8L/VP8X、JPEG marker 走查到首个 SOF；任一字段不可解析 / 格式未知 ⇒ 拒绝「无法识别的图片格式」）。预算：每边 ≤ 8192 且 `w·h ≤ 16 MP`（低于预览的触屏 20 MP / 桌面 40 MP，`logic/preview.js:800` `clientImageBudget`），超出 ⇒ 本地拒绝，**绝不调用 `createImageBitmap`**。JPEG 取首个 SOF 与浏览器解码器一致；残余见 §9 R4。
3. `createImageBitmap(file)`；位图实际 `width/height` 超出第 2 步解析值 ⇒ 立即 `close()` 并拒绝（防头部撒谎）。
4. 居中裁方：`s = min(w, h)`，`E = min(256, s)`，`s < 16` ⇒ 拒绝；9 参 `drawImage(bmp, (w−s)/2, (h−s)/2, s, s, 0, 0, E, E)`；`toDataURL("image/png")`（所有浏览器都支持 PNG 编码，不再需要 WebP 退路）。
5. `atob` → `Uint8Array` → **`validateAvatarPng` 自检**（同一个协议纯函数；不过 ⇒「此浏览器生成的图片不受支持」+ 把 reason 放进调试文案）→ POST。卡片预览直接用该 `data:` URL。

- 全链路无 `createObjectURL`/`blob:`（`tests/web-hub/ui/source-scan.test.ts:63` 禁止），与 `useAttachmentPreview.ts:13-16,156-157` 同纪律。canvas 重编码顺带去掉 EXIF/GPS 等全部元数据（v1 R4 消失）；EXIF 方向由 `createImageBitmap` 默认的 `from-image` 处理。

---

## 4. 变更传播与客户端排序（#7 #8）

### 4.1 `HubInfo.avatar`

- `HubInfo`（`hub/ports.ts:558` 起）追加 `avatar?: { gen: number; v?: string }`：功能开启且 load 完成后恒存在；`v` 缺省 = 无头像；`gen` 为本 hub 进程内单调递增（load 完成置 1，每次真正提交 +1，dedup 不加）。
- 发布沿用既有机制：改 `info.avatar` + `registry.publish({ type: "hub" })`（先例 `hub.ts` 的 `info.state = "stopping"` + publish）；`http.ts` `onHubEvent` 的 `case "hub"` 向两个 listener 的全部 SSE 客户端广播（`http.ts:825-829`；两 listener 各自订阅 bus），连接时 `openEvents` 先发一帧（`http.ts:868`）。
- 前端 reducer 已把整帧存为 `state.hub`（`ui/src/logic/state.js:483-489`）⇒ `state.js` 不改（sysload P4 拥有它的 load 分支）。
- 无新帧、无新 SSE 事件 ⇒ **不 bump `PROTO`**（`protocol/version.ts:10-15`）。

### 4.2 cap（v2.1 #6 更正表述）

`protocol/version.ts` 追加唯一 cap `AVATAR_HUB_CAP = "avatar.v1"`，`config.avatar` 存在即由 **hub 宣告**。准确描述：它经 `extraHubCaps`（`hub.ts:329` 起）出现在 hub **两个既有 cap 面**上——浏览器面 `HubInfo.caps`（`hub.ts:499-507` 展开 `extraHubCaps`）与 agent 面 `hello_ack.caps`（`agent-server.ts:172-190` 展开同一 `deps.extraHubCaps`）；两面集合相等是既有冻结不变量（`tests/web-hub/hub/caps-coexist.test.ts`）。**agent 收到它但忽略**：agent 代码不读取、不据此分支，agent 自己的 `hello.caps` 也不新增任何 avatar 项。v2 「仅浏览器 cap / 无 agent cap」的说法不准确，以本节为准。替代方案（零 cap、只看 `HubInfo.avatar` 是否存在）仍记 §9 Q3。

### 4.3 客户端排序规则（`ui/src/composables/useAvatar.ts`）

- 观测来源三种：SSE `hub` 帧（`{pid, startedAt}` + `avatar`）、POST/DELETE 回包（`hub:{pid,startedAt}` + `avatar:{gen, v?}`）、GET 结果（ETag）。
- 维护 `best = { id: "pid:startedAt", gen, v | null }`。
  - **R1** SSE 帧：`id ≠ best.id` ⇒ 新 hub 进程，无条件采纳（重置基线）；`id === best.id` 且 `gen > best.gen` ⇒ 采纳；否则丢弃。
  - **R2** 写回包：仅当 `id === best.id` 且 `gen > best.gen` 时采纳；`id` 不同（旧进程的迟到回包）一律丢弃。回包里的 `v` 与本地刚上传的 `data:` URL 一起放进本地缓存 `Map<v, dataUrl>`（容量 2）。
  - **R3** 采纳后：`v === null` ⇒ `src = null`、中止在途取图；本地缓存有该 `v` ⇒ 直接用；否则中止旧取图、按 `v` 发起新取图。
  - **R4** 取图完成时：仅当响应 ETag === `"${best.v}"`（**完整** 64 hex 精确比较）且字节过 `validateAvatarPng` 才写 `src`；否则丢弃。取图失败：仅当目标仍是 `best.v` 时置 `src = null`（显示 icon），永不影响一个 `v` 已不同的 `src`；无定时器重试，下一次被采纳的观测或重连首帧再取。
- 结果：A→B→A 也能正确排序（靠 `gen` 而不是内容）；两个浏览器交错写时，每个浏览器最终都收敛到 hub 最后一次提交（SSE 帧最终到达且 `gen` 最大）。

---

## 5. UI（沿用 v1 布局，按 v2 规则收紧）

- **设置入口**：新组件 `components/shell/SettingsAvatarCard.vue`（自带 `styles/avatar.css`），`components/shell/SettingsView.vue` 只加一行挂载 + import，`v-if` 看 `hubCaps` 含 `avatar.v1`（同默认模型卡读 caps 的方式，`SettingsView.vue:144-149`）。单 cap ⇒ loopback 与 LAN 行为一致，不再有「LAN 禁用 + 提示」分支。
- 卡片：72px 预览（当前 `src` / 处理中的新图 / 默认 icon）；「上传图片」（视觉隐藏 `<input type="file">`，`@change`）；「移除」（有头像才显示，两步确认用 `composables/useArmedConfirm.ts:12`）；说明「显示在你自己的消息旁，所有设备同步；图片会被居中裁成正方形并缩放到 256px」；`role="status"` 状态行逐码映射（`E_AVATAR_TOO_LARGE`、`E_AVATAR_UNSUPPORTED` × 11 个 reason、`E_BUSY` × reason、`E_RATE`（秒数）、`E_AUTH`、`E_DEADLINE`（`effect:"unknown"` 时文案为「结果未知，稍后刷新确认」）、本地 `source-too-large / source-unknown / source-dims / decode / encode`）；进行中按钮 `disabled`；粗指针目标 ≥ 44px（`styles/settings.css:193-203` 同规则）。
- 禁用清单（`source-scan.test.ts:38-64,75-77`）：无 `v-html`、`<Transition>`、`requestAnimationFrame`、`createObjectURL`、`randomUUID`、`localStorage`。
- i18n：新 `i18n/en/avatar.ts` + `i18n/zh/avatar.ts`（zh `satisfies Messages<typeof en>`）；`i18n/index.ts` 由 `import.meta.glob` 自动收录（`:1-17`），不改；`i18n-parity.test.ts` 自动覆盖。
- **取图**：`useAvatar` 由 App.vue 构造一次并 `provide(AVATAR_CTX, …)`（新 InjectionKey 放新文件 `components/transcript/avatarContext.ts`，不改冻结的 `controlContext.ts`）；`fetch`（X-PWH）→ `FileReader.readAsDataURL`（`usePreview.ts:161-171` 的 `readDataUrl` 写法，FileReader 可注入）→ 必须匹配 `^data:image/png;base64,`。
- **transcript**：`TxUser.vue` `inject(AVATAR_CTX, null)`；有 `src` 且本实例未出错 ⇒ `.avatar.avatar-user` 内 `<img class="avatar-img" :src alt="" decoding="async" @error="failed = true">`，否则原 icon；`src` 变化重置 `failed`；**无 ctx ⇒ DOM 与今天字节一致**。样式全在 `styles/avatar.css`（由 TxUser import），不改 `transcript.css`（`.avatar` 28px 规则在 `:149-158,194-197`，<481px 隐藏在 `:944-946`）。
- **子 agent 抽屉**：`RunTranscript.vue` 照其覆盖 `CONTROL_VIEW` 的先例（`:33-37`）加 `provide(AVATAR_CTX, null)` ⇒ 抽屉里的「user」（父 agent 派发的提示词）保持 icon。
- **传输**：`transport/types.ts` 增 `AvatarTransport { fetch(opts:{signal}) ; upload(bytes, opts?) ; remove() }` 与 `HubTransport.avatar?`（可选，同 `preview?`，`types.ts:125`）；`logic/{token,password}-client.js` 实现（GET 10s + X-PWH + `withRelogin`；POST 16s、octet-stream、**不重放**）；`transport/{token,password}.ts` 用既有 `withAuthNotice`（`token.ts:74`）包装；`composables/useHub.ts` 透传一行（`:794-800` 同处）。

---

## 6. 不变量

- **I1** 关（`webHub.avatar:false` 或 `control:false`）⇒ hub caps / `HubInfo` / 两 listener 的 `/api/avatar*` 响应与功能不存在时字节一致。
- **I2** 服务端只持久化、只下发通过 §3.2（含 zlib 恰好消费 + 长度核对）的 PNG；`Content-Type` 恒为 `image/png`。
- **I3** 回 200 ⇔ 提交点（rename/unlink）已 resolve，且提交点之后没有请求内 fs 步骤；`effect:"unknown"` 的结果在底层落定后必有一次 reconcile（除非已 `closing`）。
- **I4** 任何时刻 avatar fs zombie ≤ 1；有 zombie 时不发起新 fs 操作；请求路径之外的定时器只有 GET 发送截止（unref、随释放清除）；所有 fd 在落定链上关闭。
- **I5** 写在途 ≤ 1，且在读 body 前判定；每个 fs 步骤发起前剩余预算 ≥ 剩余步骤上限之和，否则零 fs 调用；请求路径无 chmod、无重试。
- **I6** 客户端永不采纳 `(id, gen)` 更旧的观测；`src` 只来自 ETag 与目标 `v` 完整相等且通过校验的字节，或本客户端自己上传的同 `v` 数据。
- **I7** 每请求恰一行审计（429 节流例外），无路径/错误原文/内容。
- **I8**（v2.1 #1）`close()` 之后：不改内存、不加 gen、不发布 `hub` 帧、不写审计/日志；迟到回调只回收 fd；`close()` 自身 ≤ `AVATAR_CLOSE_WAIT_MS`。
- **I9**（v2.1 #5）GET 槽：取得次数 = 释放次数（`finish` / `close` / 截止销毁任一路径恰一次），在途 ≤ 8。

---

## 7. 测试

### 7.1 hub 单元（新目录 `tests/web-hub/hub/avatar/`）

- `avatar-png.test.ts`（协议纯函数，hub 与 UI 共用）：Chrome/Firefox/Safari 真实 canvas 产出的 PNG 样本（作为 fixture 入库）通过；逐条拒绝：错签名、IHDR 非首块/长度错、非方形、15/257 边、16-bit、调色板/灰度/隔行、CRC 错、len 越界、未知块、`tEXt`/`zTXt`/`iTXt`/`eXIf`、`acTL`/`fcTL`/`fdAT`、辅助块在 IDAT 后、IDAT 不连续、无 IDAT、IEND 非末尾、IEND 后 1 字节、PNG+ZIP、PNG+HTML、SVG、JPEG、WebP、GIF、空；种子随机变异 fuzz（固定种子，≥ 2000 例）：永不抛、永不放行非法输入。
- `validate.test.ts`：zlib 长度不等（多/少 1 字节）、filter 字节 5、zlib 炸弹（压缩 1 KiB → 声称 256² 但解压超长）⇒ `idat`，且 `maxOutputLength` 生效（不分配超额）。
- `fs.test.ts`：迟到 open 被关闭（fake open 在竞速后 resolve，断言 close 被调用）；zombie 计数与 tracker(1) 快速失败；落定链 close 恰一次；close 不受 abort 影响。
- `store.test.ts`（注入 `AvatarFsDeps` 假体）：PUT P1–P6 每步失败/超时 ⇒ 旧头像仍被服务、`gen` 不变、无发布、tmp 走落定链删除（dir-swapped 除外）；rename 超时 ⇒ 504 `unknown` + `pending`，底层随后成功/失败两分支各自 reconcile 正确并恰一次发布/审计；`pending` 期间写 503；惰性 30s 上限转 `disabled` 且之后迟到落定仍更新内存；dedup 不加 gen；DELETE 幂等 + 超时同语义；`dir-swapped` 检测；load：symlink 目录、他人属主、宽模式目录（修复）、symlink 文件、硬链接文件（nlink 2）、宽模式文件、FIFO、超大文件、校验失败 ⇒ 各自 reason；残留 tmp 被按名删除；`close()` 后写 503 且不等 zombie。
- `avatar-fs-guard.test.ts`：`src/web-hub/hub/avatar/*.ts` 中只有 `fs.ts` 可 import `node:fs*`（照 `tests/web-hub/hub/upload-fs-guard.test.ts`）。
- `audit.test.ts` 追加：白名单裁剪；errno 正则；含 `/` 的值从不出现。
- `deadline-nesting.test.ts` 追加：`AVATAR_TOTAL_MS < 15000 < 16000`（其余等式见下方 v2.1 追加）。
- `caps-coexist.test.ts` 追加：`config.avatar` ∈ {缺失, true} × 既有组合，两面集合相等；缺失时与今天完全一致。

- **v2.1 追加（hub 单元）**：
  - `avatar-png.test.ts`：重复 `IHDR`、`IEND` 在 `IDAT` 之前、两个 `IEND`、`IEND` 后再跟 `tEXt`、`iCCP`（任意长度）⇒ 对应 reason。
  - `validate.test.ts`：**「合法 deflate + 尾随字节」样本**（IDAT = `deflateSync(raw) ++ 16 B`，CRC 正确，解压长度恰为 `expected`）⇒ `idat`；两个 zlib 流首尾相接 ⇒ `idat`；尾随字节被拆进最后一个 IDAT 块 ⇒ `idat`；断言拒绝依据是 `engine.bytesWritten !== idat.length`（而非输出长度）。
  - `store.test.ts` 栅栏：**close-during-load**（load 的 read 挂住 → `close()` ≤ 1s 返回 → 之后 read resolve：零内存变化、零 `onChange`、零审计/日志调用、fd 被关）；**close-during-pending**（rename 超时进 pending → `close()` → rename 随后成功/失败：均零发布零审计）；close-during-writing（≤ 1s 返回，迟到 commit 被栅栏拦下）；`close()` 后再 `load()` ⇒ 零 fs 调用；后台 fsync 在 close 后落定 ⇒ 零审计。
  - `store.test.ts` identity：P1 不符 ⇒ `disabled{dir-swapped}` 且 open 零调用；**P5 不符（tmp 已写好）⇒ `disabled`、rename 零调用、tmp 未被 unlink**；D1 不符 ⇒ unlink 零调用；均无发布、审计 reason = `dir-swapped`。
  - `store.test.ts` 预算：注入假时钟 + 记录每次 fs 调用发起时的 `remaining`，断言 PUT 第 i 步 `remaining ≥ Σ_{j≥i} cap_j`、DELETE 同理；逐个把剩余预算压到「后缀和 − 1ms」⇒ 该步及之后零调用、504 `none`；P2 `EEXIST` ⇒ 503 `tmp-exists` 且 open 只被调用 1 次、unlink 零调用；源码扫描 `store.ts` 请求路径不出现 `chmod`。
  - `deadline-nesting.test.ts`：`AVATAR_STORE_MIN_MS === sum(AVATAR_PUT_STEP_CAPS)`、`AVATAR_DELETE_MIN_MS === sum(AVATAR_DELETE_STEP_CAPS)`、`AVATAR_AUTH_CAP_MS + AVATAR_BODY_CAP_MS + AVATAR_AUTH2_CAP_MS + AVATAR_STORE_MIN_MS ≤ AVATAR_TOTAL_MS − 2000`。
  - `routes.test.ts`（新，假 `io`）：`io.readBody` 以 `HttpError(408, "E_DEADLINE")` 拒绝 ⇒ 响应 504 `{error:"E_DEADLINE", effect:"none"}`、`Connection: close`、`finish` 后 `req.destroy()` 被调用、审计 `io:"deadline"`、写槽释放；413 同法 ⇒ 413 `E_AVATAR_TOO_LARGE`；DELETE 的 408 同样 504。GET 槽：假 `res` 只发 `finish` / 只发 `close` / 两者都发 / 都不发（截止到点 ⇒ `destroy()` ⇒ `close`）四种，计数恰减一次；第 9 个并发 ⇒ 503 且不写 body。

### 7.2 HTTP 路由（新 `tests/web-hub/http/api-avatar.test.ts`、`lan-avatar.test.ts`，用 `helpers.ts`/`lan-helpers.ts`）

- **开关矩阵**：`avatar` 缺失（含 `control:false` 经 `buildHubConfig` 的单元断言放 `tests/config/web-hub-settings.test.ts` 追加）⇒ 三端点两 listener 与未知路径字节一致。
- **鉴权矩阵**：loopback 无/错 cookie 401；LAN 无会话、过期、吊销 401；LAN 慢 body 期间吊销 ⇒ ⑨ 401 且零 fs 调用；db 超时 ⇒ 503 `E_DB`。
- **CSRF 矩阵（#11）**，每端点：
  - loopback：`Origin: http://127.0.0.1:<port>` / `http://localhost:<port>` 通过（`expectedOrigin` 由 Host 推导，`http.ts:2833`）；缺 X-PWH、错 Origin、写端点缺 Origin、`Sec-Fetch-Site: same-site|cross-site`、POST /api/avatar 用 `application/json`/`image/png` ⇒ 403，均先于鉴权。
  - LAN 直连 HTTP：Origin = `http://<ip>:<port>` 且无 `Sec-Fetch-Site` ⇒ 通过（K16，`http.ts:1870-1874` 注释）。
  - LAN 受信代理 HTTPS：`X-Forwarded-Proto/Host` 推出的 origin 必须 ∈ `webHub.lan.externalOrigins`，否则在建上下文阶段 421（`http.ts:452-459`）；Origin 必须等于该 https origin。
  - LAN 非受信对端伪造 `X-Forwarded-*`：被忽略（`proxy.ts:34-36`），按直连 Host/Origin 判定（伪造的 https Origin ⇒ 403）。
  - GET：缺 X-PWH ⇒ 403；无 Origin 通过；有 Origin 须匹配。
- **尺寸/预算**：`Content-Length: 524289` ⇒ 413 不读 body；chunked 超限 ⇒ 413；body 1B/s ⇒ ≤ 14s 内 504 且写槽释放；注入慢鉴权使剩余 < 4000ms ⇒ 504 `effect:"none"` 且 store 零调用。
- **格式**：§7.1 拒绝样本各取一例端到端 ⇒ 415 + reason；SVG 与 PNG+HTML 必测。
- **GET 头部**：Content-Type、nosniff、CSP 原值、CORP、Disposition、Cache-Control、完整 ETag；`If-None-Match` 精确命中 304、只差末位 1 hex ⇒ 200。
- **并发（#12）**：首个 POST 只发头和半个 body 挂住 ⇒ 第二个 POST 确定性 503 `inflight` 且其 body 未被读；GET 第 9 个并发 503。
- **限流**：写第 11 次 429 + Retry-After，审计 60s 一行。
- **传播**：上传/删除后两 listener SSE 收到 `hub` 帧，`avatar.gen` 递增、`v` 为完整 digest；dedup 不发帧。
- **审计**：每个出口恰一行、键集合 ⊆ 白名单。

- **v2.1 追加（HTTP）**：慢客户端——真实 socket 发 GET 后 `pause()` 不读（响应体 + 用小 `highWaterMark` 的服务端 socket 或 >socket 缓冲的 fixture）⇒ 10s 截止后连接被销毁、槽释放、第 9 个 GET 随后可进；客户端中途 abort ⇒ 槽立即释放；body 1B/s ⇒ 504 `E_DEADLINE{effect:"none"}`（不是 408）且连接关闭。

### 7.3 UI（新文件）

- `avatar-source.test.ts`：各格式头部解析、截断头、SOF 在 1 MiB 之外 ⇒ unknown、超预算 ⇒ 拒绝且 `createBitmap` 从未被调用。
- `use-avatar-editor.test.ts`：裁剪坐标（横/竖/<256/<16）；位图尺寸大于头部声明 ⇒ 拒绝并 `close()`；自检失败路径；错误码 → i18n key 完备。
- `use-avatar.test.ts`：R1–R4 全覆盖——乱序（回包先于帧 / 帧先于回包 / 旧 gen 帧迟到）、hub 身份变化重置、旧进程迟到回包丢弃、A→B→A、ETag 不等丢弃、取图失败不清掉别的 `v`、中止旧取图；两浏览器交错写模拟（两个 composable 实例共享一条假 SSE）最终收敛。
- `transport-avatar-contract.test.ts`：token / password 两客户端 outcome 对等；GET 带 X-PWH；POST 不重放。
- `settings-avatar-card.test.ts`、`tx-user-avatar.test.ts`：同 v1（无 ctx 字节一致、`@error` 回退、RunTranscript 内恒 icon、cap 缺失不渲染、两步移除、44px class、en/zh）。

### 7.4 集成（新 `tests/integration/web-hub-avatar.test.ts`，真实 hub）

参照 `tests/integration/web-hub-worktree-graph.test.ts:1-25` 装配（`startHub` + `createHttpFrontend`，真实 socket/HTTP/临时 HOME）：loopback 上传 → SSE `gen/v` → GET 字节相等；磁盘模式 0700/0600、无 tmp；重启同 HOME ⇒ 加载后补发帧、`v` 不变、`gen` 重置为 1 且客户端按身份变化采纳；开 LAN 密码会话取到同一张（U-A2）；并发两写恰一 200 一 503；删除 → 404 → 重启仍无；手工把文件改成 symlink / 追加尾随字节 ⇒ 重启后无头像 + warn，其它端点正常。

### 7.5 实施期验收闸门（r_R9KE2GPX #8）

本方案（含 §10/§11 处置表）只是设计；**处置表不等于已验证**。每包的异源 verifier 必须逐项亲自跑过/读过以下证据才可判通过（缺一项即打回），T 包结束时主会话再总核一次：

1. 源码扫描：`hub/avatar/*.ts` 只有 `fs.ts` import `node:fs*`；`store.ts` 请求路径无 `chmod`；UI 无 `createObjectURL`/`v-html`/`<Transition>`/`requestAnimationFrame`/`localStorage`（既有 `source-scan.test.ts` 通过即可，不改它）。
2. 真实 PNG 语料：三大浏览器 canvas 产出样本通过；「合法 deflate + 尾随字节」、两流拼接、`iCCP`、重复 IHDR、早/重复 IEND 全部 415，且拒绝依据与 §3.2 一致（verifier 抽查 `bytesWritten` 比对代码）。
3. close-during-load / close-during-pending / close-during-writing 三个用例存在且断言「零内存变化、零发布、零审计」。
4. 提交前 identity 闸门：P1/P5/D1 不符的故障注入用例存在，断言 rename/unlink 零调用且 tmp 未按路径删除。
5. 预算：逐步 `remaining ≥ 后缀和` 的断言用例存在；EEXIST ⇒ 503 无重试。
6. GET 槽：`finish` / `close` / 截止三路径恰释放一次的单元用例 + 慢客户端/中途 abort 的真实 socket 用例。
7. HTTP 映射：readBody 408 ⇒ 504 `E_DEADLINE{effect:"none"}` 的路由单元用例 + 1B/s 的 HTTP 用例。
8. 全量 `npm run format:check && npm run typecheck && npm test && npm run build`，UI 包另跑 `npm run build:web && npm run check:web`。

---

## 8. 顺序、包拆分与文件域

### 8.1 顺序与基线闸门（#1）

- **avatar 全部包排在 sysload（`docs/dev/sysload/plan.md` §10 的 P0–P5）全部合入之后**。理由：sysload 的 P0 正在改 `config/{settings,setting-specs}.ts`、`protocol/{messages,http-contract}.ts`、`hub/ports.ts`、`agent/index.ts`、`ui/src/{types,transport/types}.ts`（当前工作区脏改），P3 改 `hub/{hub,http,main}.ts`，P4 改 `logic/{token,password}-client.js`、`transport/{token,password}.ts`、`useHub.ts`——与 avatar 的 A0/W/C 文件域全部重叠。git graph 兄弟面板包已提交（`c238090`），不再冲突。
- **基线**：sysload P5 合入后记录 `AVATAR_BASE=<sha>` 写进本文修订记录；此后每包开工前执行闸门：① `git merge-base --is-ancestor $AVATAR_BASE HEAD`；② 本包文件域 `git status --short` 为空；③ 若 HEAD 自上包以来有新提交触及本包文件域 ⇒ 先 rebase、重核本文引用行号（尤其 `hub/ports.ts` `HubConfig`/`HubInfo`、`http.ts` 两处插入点、`API_ERRORS` 尾部）再开工；④ 主会话持有的热文件同一时刻只允许一个包在改。

### 8.2 包

| 包                      | 内容                                                                     | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 依赖                    |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **A0 冻结面**（主会话） | 常量/类型/路径名/预算/reason 词表；PNG 校验纯函数；cap；错误码；端口接口 | 新 `protocol/avatar.ts`、新 `protocol/avatar-png.ts`（+ `tests/web-hub/hub/avatar/avatar-png.test.ts` 与 fixtures）；`protocol/version.ts`；`protocol/http-contract.ts`；`hub/ports.ts`（`HubConfig.avatar?`、`HubInfo.avatar?`、`FrontendDeps.avatar?`、`AvatarRoutes`）；`ui/src/transport/types.ts`（`AvatarTransport`）                                                                                                                                                                                                     | sysload P5 后           |
| **H 服务端**            | IO 内核、store、validate（zlib）、routes、审计                           | 新 `hub/avatar/{fs,store,validate,routes}.ts`；`hub/audit.ts`（尾追加，H 独占）；§7.1/§7.2 新测试                                                                                                                                                                                                                                                                                                                                                                                                                               | A0                      |
| **C 传输**              | 逻辑客户端、适配器、useHub 透传                                          | `ui/src/logic/{token-client,password-client}.js`、`ui/src/transport/{token,password}.ts`、`ui/src/composables/useHub.ts`；`transport-avatar-contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                   | A0；与 H、U 并行        |
| **U 界面**              | composables、卡片、transcript                                            | 新 `ui/src/composables/{useAvatar,useAvatarEditor}.ts`、新 `ui/src/logic/avatarSource.ts`、新 `components/shell/SettingsAvatarCard.vue`、新 `components/transcript/avatarContext.ts`、新 `styles/avatar.css`、新 `i18n/{en,zh}/avatar.ts`；`TxUser.vue`、`drawer/RunTranscript.vue`（一行）、`shell/SettingsView.vue`（一行）；§7.3 新测试                                                                                                                                                                                      | A0；对假 transport 开发 |
| **W 装配**（主会话）    | hub 组装、两 listener 分发、设置链路、文档                               | `hub/hub.ts`（store 构造、`onChange`→`info.avatar`+publish、`extraHubCaps`、`void load()`、运行期 `close()`）；`hub/http.ts`（LAN：agentRemove 分支后、`if (method === "POST")` 前；loopback：agentRemove 分支后、`if (method === "POST")` 前；`LanRuntime.avatar` + 透传）；`hub/main.ts`；`config/{settings,setting-specs}.ts`；`agent/index.ts`（`buildHubConfig`）；`ui/src/App.vue`；`tests/web-hub/hub/{caps-coexist,deadline-nesting}.test.ts`、`tests/config/web-hub-settings.test.ts` 追加；`AGENTS.md` web-hub 段一段 | H、C、U 后              |
| **T 集成**              | §7.4                                                                     | 新 `tests/integration/web-hub-avatar.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | W 后                    |

- **热共享文件（主会话独占、串行）**：`hub/hub.ts`、`hub/http.ts`、`hub/ports.ts`、`hub/main.ts`、`protocol/version.ts`、`protocol/http-contract.ts`、`ui/src/App.vue`、`ui/src/transport/types.ts`、`src/config/{settings,setting-specs}.ts`、`src/web-hub/agent/index.ts`。`protocol/messages.ts`、`i18n/index.ts`、`logic/state.js`、`transcript.css`、`controlContext.ts`、`preview/fs.ts`、`upload-fs.ts`、`sniff.ts` **本方案不改**。
- 每包返回立即派异源 verifier；验收通过按精确路径提交；不碰 `CHANGELOG.md`。

---

## 9. 风险与待确认

- **R1** 共享写权限：任一已鉴权主体可换/删共享头像；U1 下接受。
- **R2** 明文 LAN 可嗅探/篡改（同上传方案 §5.0）；篡改上限是「换一张通过 §3.2 的 PNG」。
- **R3** 浏览器 PNG 解码器漏洞：服务端已把输入压到「方形 ≤256、8-bit、无元数据、IDAT 长度精确」的最窄形状，残余为解码器自身 bug，与任何 `<img>` 同级。
- **R4** 源图解析与浏览器解码器分歧（例如多 SOF 的畸形 JPEG）：第 3 步「位图尺寸 ≤ 头部声明」兜底，但解码本身已发生；预算 16 MP 限定了最坏内存。
- **R5** 某浏览器 canvas 产出白名单外的辅助块（v2.1 起含 `iCCP`）⇒ 上传被拒。缓解：A0 入库三大浏览器真实样本，真机验收覆盖 iOS Safari / Android Chrome / 桌面 Firefox；若真遇到，扩白名单（只加无载荷块）。
- **R6** 首帧闪变：load 完成前 `HubInfo.avatar` 缺失，页面先显示 icon。
- **Q1** 子 agent 抽屉保持 icon（方案默认）。**Q2** 移动端 <481px 不显示头像列（沿用 2026-10-09 裁定）。**Q3** 是否改为「零 cap、只看 `HubInfo.avatar` 存在」以彻底不碰 `hello_ack`？默认保留单 cap（符合 caps 约定与集合相等不变量）。**Q4** 是否需要交互式裁剪框？v1 自动居中裁。

---

## 10. 评审处置表（r_MDTV4EK0，14 条）

| #   | 级别 | 意见（摘要）                                                                       | 处置                                                                                                                                                                                                                  | 落点                 |
| --- | ---- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | 阻塞 | sysload 与 Graph UI 在途改动占用 avatar 热域，未定串行顺序/rebase                  | **接受**。Graph 兄弟面板已提交 `c238090`；avatar 全包排在 sysload P0–P5 之后，记录 `AVATAR_BASE`，每包四步闸门                                                                                                        | §8.1                 |
| 2   | 阻塞 | `fsStep` 超时后底层继续、迟到 open 不 close、无限等 rename 持锁、load/close 未纳管 | **接受**。专用 `hub/avatar/fs.ts`：`racePreviewIo` + `createPreviewIoTracker(1)` 计 zombie、迟到 open 回收、落定链 close；取消「持锁等落定」，改 `pending` + 30s 惰性上限转 `disabled`；load/close 同一内核、各自有界 | §1.4、I4             |
| 3   | 严重 | meta rename/unlink 后 syncDir 失败致内存/磁盘/SSE 分叉                             | **接受**，选「rename/unlink 成功即成功」：目录 fsync 后台 best-effort、有界、不改结果；超时 ⇒ `effect:"unknown"` + 唯一 reconcile 路径发布真值                                                                        | §1.4、I3             |
| 4   | 严重 | JPEG/WebP 校验远非有限状态解析，无 ANIM/边界校验                                   | **接受**，取「只收 PNG」：客户端恒 canvas→PNG，服务端严格 chunk 走查（CRC、长度、白名单、拒 APNG/文本块、IEND 末尾无尾随）+ zlib 长度精确核对；取消原字节退路                                                         | §3.1–3.2             |
| 5   | 严重 | 先 `createImageBitmap` 后查 40MP，小文件可伪造巨型尺寸                             | **接受**。解码前 `file.slice` + 纯 JS 头部解析，≤8192 边 / ≤16MP 才解码；解码后再核位图 ≤ 声明                                                                                                                        | §3.4                 |
| 6   | 严重 | 「逐级 lstat」不成立，父级允许属主 symlink，文件只验 regular，sha 路径未冻结       | **接受**。写明信任根 = stateDir（既有 owned-symlink 信任）；只校验 `avatar/` 一级（lstat/uid/0700 + identity 复核）；固定两个文件名，取消哈希派生路径；文件 O_NOFOLLOW + regular + uid + nlink=1 + 模式；伪造路径测试 | §1.2、§7.1           |
| 7   | 严重 | `sha256[0:16]` 截断强 ETag                                                         | **接受**。ETag 与传播版本均为完整 64 hex；304 与 R4 精确比较                                                                                                                                                          | §2.5、§4             |
| 8   | 严重 | POST 回包/SSE/GET 乱序，旧 setLocal 覆盖新图，迟到失败清图                         | **接受**。`HubInfo.avatar.gen` + hub 身份 `(pid,startedAt)`，客户端 R1–R4（旧观测丢弃、旧进程回包丢弃、ETag 完整相等才落 `src`、失败不影响其它 `v`、中止旧取图）；服务端明确 LWW 不做 CAS                             | §4.3、I6             |
| 9   | 严重 | 14s 预算下存储只剩约 2s，`deriveBudget` 无保底                                     | **接受**。重排：auth 2s / body 5s / auth2 1s / store 保底 4s（五步上限之和），⑥⑩ 两处显式校验，不足即 504 且零 fs 调用                                                                                                | §2.2–2.3、I5         |
| 10  | 严重 | GC 无上限/无 generation；读 body 前无 in-flight 上限                               | **接受**。固定 tmp 名 ⇒ 无扫描 GC，只按名删除且仅在 `loading`/提交前失败时；写槽全局 1 在读 body 前取；GET 在途 ≤ 8                                                                                                   | §1.4、§2.4           |
| 11  | 严重 | 未定义 `control:false`，缺受信代理 Origin 矩阵                                     | **接受**。`control:false` ⇒ 整功能关（同 uploads 先例）；CSRF 矩阵覆盖 loopback / LAN 直连 / 受信代理 HTTPS / 非受信伪造 forwarded / Sec-Fetch-Site / GET                                                             | §2.6、§7.2           |
| 12  | 一般 | 设计 E_BUSY 而测试接受两个 200                                                     | **接受**。唯一语义：第二个并发写确定性 503 `inflight`，测试严格「恰一 200 恰一 503」                                                                                                                                  | §2.4、§7.2、§7.4     |
| 13  | 一般 | 审计未冻结 exactly-once、reqId/ok、错误脱敏                                        | **接受**。冻结 `AvatarAuditRecord`；`finally` 单点恰一行（429 节流为唯一例外）；errno 正则、禁路径/原文/内容；覆盖全部出口与 reconcile/load                                                                           | §2.7、I7             |
| 14  | 建议 | 唯一用户 v1 过度设计                                                               | **接受**。单布尔开关、单 cap、单固定文件（无 meta）、完整 digest、无三态、无 agent cap；严格校验/鉴权/CSRF/限流/有界 IO 全保留                                                                                        | §0、§1.3、§2.6、§4.2 |

---

## 11. v2.1 处置表（复审 r_R9KE2GPX：CONDITIONAL PASS，0 阻塞 / 8 条）

| #   | 级别 | 意见（摘要）                                                                                            | 处置                                                                                                                                                                                                                                                                                                                       | 落点                                   |
| --- | ---- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | 严重 | `void load()`、close 只等 writing，未禁止迟到 load/reconcile 在 closing 后改内存/发布/写日志            | **接受**。store `epoch` 栅栏：`close()` 置 `closing` 并 `epoch++`；load/reconcile/后台 fsync 回调先过栅栏，被拦则只回收 fd；`commit()` 亦过栅栏；hub.ts `onChange` 再以 hub `closing` 二次栅栏；`load()` 注册 `loadP`，`close()` 在同一 1s 截止内有界等待 `loadP` 与 `writingP`；补 close-during-load/pending/writing 测试 | §1.4.3、I8、§7.1、§7.5-3               |
| 2   | 严重 | rename 已回 200，其后的 lstat 失败/dir-swapped 无法回滚、无语义                                         | **接受，取「提交前闸门」**：删除提交后 lstat；P5（PUT）/D1（DELETE）在提交点前做 identity 比对并计入预算，不符 ⇒ `disabled`、零提交、不按路径删 tmp；提交点后无请求内 fs 步骤；故障注入测试                                                                                                                                | §1.4.2、I3、§7.1、§7.5-4               |
| 3   | 严重 | 只核对 inflate 输出长度，Node 接受 deflate 流后的尾随字节；未拒重复 IHDR/早或重复 IEND；iCCP 未严格校验 | **接受**。`inflateSync(…, {info:true, maxOutputLength: expected})` 并要求 `engine.bytesWritten === idat.length`（本机 v22.22.1 实测：尾随 15 B / 双流拼接时 `bytesWritten` 均只计第一个流）；重复 IHDR ⇒ `ihdr`，非末尾/重复 IEND ⇒ `order`；**`iCCP` 移出白名单**；新增「合法 deflate + 尾随字节」等语料                  | §3.2–3.3、§7.1、§7.5-2                 |
| 4   | 严重 | 预算算术不成立：六步合计 4500 > 4000，另有 EEXIST unlink+重试与 chmod                                   | **接受**。重定六步上限 `[250,500,1000,1500,250,500]`，`AVATAR_STORE_MIN_MS = sum = 4000`（测试钉等式）；每步发起前 `remaining ≥ 后缀和`；EEXIST ⇒ 503 `tmp-exists` 不重试；chmod 只在启动 load；DELETE `[250,500]` = 750；逐步剩余预算断言                                                                                 | §1.4.2、§2.3、I5、§7.1、§7.5-5         |
| 5   | 严重 | GET ≤8 只定义准入、未定义释放；`res.end` 后释放会绕过慢客户端限制，等 finish 需处理竞态                 | **接受**。鉴权后取槽，先注册 `once` 释放于 `finish`/`close`，10s 发送截止 `res.destroy()`（unref，释放时清除）；审计在释放时恰写一次；单元四路径 + 真实 socket 慢客户端/abort 测试                                                                                                                                         | §2.2 GET、§2.4、I9、§7.1、§7.2、§7.5-6 |
| 6   | 一般 | 「仅浏览器 cap、无 agent cap」与 `extraHubCaps` 进 hello_ack 的事实不符                                 | **接受**。改述为「hub 宣告、出现在 `HubInfo.caps` 与 `hello_ack.caps` 两个既有面、agent 忽略、agent 自身不新增 cap」                                                                                                                                                                                                       | §4.2、§0                               |
| 7   | 一般 | `readBody` 超时抛 408、外层回 408，而方案验收要求 504                                                   | **接受**。avatar 路由自捕 `readBody` 的 408 ⇒ 504 `E_DEADLINE{effect:"none"}`、413 ⇒ `E_AVATAR_TOO_LARGE`，均 `Connection: close` + finish 后 `req.destroy()`；路由单元测试 + HTTP 1B/s 测试                                                                                                                               | §2.2 ⑦、§7.1、§7.2、§7.5-7             |
| 8   | 一般 | 尚无实现，处置表不能当作已验证                                                                          | **接受为实施期闸门**：§7.5 列出 verifier 必须亲验的 8 项证据，缺一项即打回                                                                                                                                                                                                                                                 | §7.5                                   |

---

## 实施记录（2026-10-11）

- 已按 A0 `680ce49`、C `1306fc1`、U `14bbd19`、H `b9cddd6` 之后实施 W（assembly）：单一 `webHub.avatar` 开关、两 listener 路由装配、`avatar.v1` cap、生命周期关闭、UI provider 与设置链路均保持键缺失即关闭的兼容语义。
- 接受 H 的 `readBody` 构造注入与必需 `hub()` 身份参数两个偏差；二者均由装配层明确传入。
- 按用户裁定，Firefox/Safari canvas 样本延后至真机验收（不安装 Firefox）；U 包的 JS 预算上调至 256 KiB。
