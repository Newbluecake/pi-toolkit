# web-hub「内容预览」三项增强 · 施工方案（dir-plan v3 · 评审第一轮修订）

> 规划产物（planning subagent）。文件名沿用 `dir-plan.md`，覆盖三项需求：
> **A. 目录预览** · **B. Markdown 渲染预览（默认渲染、可切源码）** · **C. 预览范围放宽到任意绝对路径（用户拍板 U4，2026-10-08）**。
> 依据：`dir-explore.md`（现状测绘，行号以其为准）+ 只读核对。上位：`plan.md`（v3 + 2026-10-07 probe 修订）、`acceptance.md`。
> v3 = v2 + 评审（7 Major / 6 Minor / 1 Nit）逐条处置，见文末 §10「评审处置表」。**U1/U4 范围不变**：任意绝对路径、LAN 与 loopback 同宽、防线不拆。
> **v3.1（第二轮定向修订）**：#1 / #4 / #5 / #12 四条契注定稿（接口签名与迁移表、tracker 签名与参数流转、完整伪代码与等价性、`PreviewProbeKind` 唯一来源与折叠语义），落点 §2.1 / §2.4 / §2.5.2 / §1.3，§10 有「第二轮闭合」行。其余章节未动。
> 兼容原则：只增不改。A 走 opt-in，C 的识别放宽由 cap 门控，B 是纯客户端功能。刻意改变的线上行为只有 C：cwd 外的绝对路径由 403 `outside` 变为正常准入；1 段路径由 400 变为进入准入。

---

## 0. 决策摘要（呈用户确认）

### 0.1 C · 准入范围（U4 最终口径）

| #   | 取舍         | 推荐                                                                                                                                                                                                                                                                     |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | 分类         | 「upload / cwd」→ **「upload / 全局 fs」**。⑥ 仍按字面前缀分出 upload 类，走原 `openForPreview` 全链；其余走统一的 fs admitter（原 cwd admitter 去掉 root 包含判定）。审计 `cls` 为 `upload \| cwd \| abs`，按字面前缀计算，零 fs，只用于统计                            |
| C2  | 防线         | **一条不拆**：虚拟根（字面 + realpath）、denylist（字面 + realpath）、realpath、`O_NOFOLLOW` 打开、fstat dev/ino、`/proc/self/fd` 复核、每步 ≤2 s / 总 8 s、迟到 fd 回收、`O_NONBLOCK`。新增：realpath 结果为 `/` ⇒ `root-too-broad`                                     |
| C3  | denylist     | 按 §2.3 扩充（系统级 + 用户级凭据位置）；home/agentDir 相关规则同时按 **literal 与 canonical 两种表示**检查，并尽量改写成不依赖 home 字符串的子路径规则（§2.6）；用必拒/必放语料测试做回归、规则带版本号、指定维护责任（§2.7）                                           |
| C4  | 识别层       | 作用域带 `abs:true`（cap `preview.abs.v1`）⇒ `isClickable` = 通过 `validatePreviewPath`（仍要求 ≥2 段，`/help` `/reload` 不成为候选）；**scope 为 null ⇒ 一律不可点（不变）**；`cwd` 为 null 时绝对路径可点、相对路径不启用；`findPathRefs` 改为可证明的线性算法（§2.5） |
| C5  | probe        | 协议形状不变，cwd 外路径走同一条准入链；准入失败一律折叠为 `missing`                                                                                                                                                                                                     |
| C6  | 会话可见性   | **保留**：⑤ agentKey 必须存在、sessionId 必须匹配（404/409），probe 在请求级和逐条两处都查。放宽的是路径范围，不是谁能调                                                                                                                                                 |
| C7  | 审计         | 不变：永不落原始路径或文件名，只记长度 / `ext` / HMAC-12 `pathTag` / `cls` / `kind` / `total` / `code` / `reason`                                                                                                                                                        |
| C8  | 运维防线     | ① 僵尸 fs 操作熔断：封装为单一原语 `PreviewIoTracker`，超过 2 个即快速失败（§2.4）；② hub 以 uid 0 运行时，启动阶段写**一次**稳定事件 `preview.root_uid` 的 WARN（§2.9）                                                                                                 |
| C10 | 安全边界声明 | 显式写入方案：**已认证用户（含 LAN）可读取 hub 进程用户能读到、且未命中 denylist 的任何文件，并能浏览目录**；路径存在性 / 类型可被推断（oracle 规则见 §2.8）。这是 U1/U4 有意接受的边界，不是防线遗漏                                                                    |

> **★ C9 · LAN 与 loopback 同宽（单列，请一眼确认）**
> 推荐 **两侧一致放宽到任意绝对路径**，依据 U1（唯一 LAN 用户、密码保护、风险已明示接受）。LAN 仍受 `webHub.preview` 三态约束：`"on"`（默认）LAN 可用；`"loopback"` 时 LAN 上 `/api/preview*` 一律 404（与未启用逐字节一致）。**不新增按 listener 区分的范围开关**。

### 0.2 A · 目录预览

| #   | 取舍     | 推荐                                                                                                                                                                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | 展示     | 名称 / 类型 / 大小（仅文件）/ mtime；目录在前、按名称排序（大小写折叠比较 + 码点兜底，与 locale 无关）；dotfiles 显示但置灰；**denylist 命中的条目不列出，也不计数**（静态脚注「受保护条目不显示」，避免成为存在性 oracle，§2.8）                                                                |
| A2  | 上限     | 三重上限，截断优先级固定：**扫描 10 000 dirent → 条目 1 000 → 响应 512 KiB**；`limits` 标志指明是哪一层触发的截断（§3.2）                                                                                                                                                                        |
| A3  | 交互     | 对话框内导航：「返回」走对话框内历史栈（上限 64），「上级」可走到一段路径（`/home`），`/` 本身不可列；符号链接条目可点，交给完整准入链判定；名字有损（含 U+FFFD）或类型为 FIFO/socket/设备的条目不可点；点子项时重新走完整单路径准入                                                             |
| A4  | 协议     | 复用 `GET /api/preview` 加 opt-in `dir=1` ⇒ 200 JSON + `X-PWH-Preview-Kind: dir`；probe body 加 `dirs:true` ⇒ 目录条目答 `"dir"`；cap `preview.dir.v1`，**仅在 hub 启动时 `/proc/self/fd` 可用才声明**；不升 PROTO；未 opt-in ⇒ 逐字节同今天                                                     |
| A5  | 识别     | 作用域带 `dirs` 时新增三条，均由 probe 把关：(a) 绝对路径去掉一个尾部 `/`；(b) 以 `/` 结尾的相对路径；(c) 成对 `"…"`、`'…'`、`` `…` `` 包住的无扩展名相对路径（反引号在非 markdown 上下文由扩展起点集处理，在 markdown 上下文由 `pathRefOfCode` 处理，§2.5.3）。裸写的 `src/components` 仍不识别 |
| A6  | 安全     | 同一条 `openAdmittedPath`，只在 `allowDir` 时放宽 step 11；**仅经 `/proc/self/fd/N` 列举**（绑定到已复核的 inode）；条目 `lstat("/proc/self/fd/N/<name>")`，不跟随条目自身的链接；没有 `/proc` 的平台 **fail-closed**：不声明 cap，admitter 对目录照旧 415（§3.6）                               |
| A7  | 预算     | 准入 8 s（与文件预览相同）**加** 列举 5 s，独立追加，墙钟上限 13 s；与客户端 40 s 超时的关系由测试钉住（§3.4）                                                                                                                                                                                   |
| A8  | 生命周期 | opendir / readBatch / lstat / close 各自有 step deadline 与 abort 语义；close 有上限、可迟到回收、计入 tracker；释放顺序固定（§3.3）                                                                                                                                                             |

### 0.3 B · Markdown 渲染

| #   | 取舍       | 推荐                                                                                                                                                                               |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 判定       | 客户端按已知路径扩展名判定（`.md` / `.markdown`，大小写不敏感，不含 `.mdx`）；仍是 `kind:"text"`；协议和 hub 零改动                                                                |
| B2  | 管线       | 复用 `MarkdownView` → `MdBlock` / `MdInline`（`@logic/markdown.js` 白名单解析器，无 `v-html`）；不引新库                                                                           |
| B3  | 切换       | `PreviewText` 工具栏加「渲染 / 源码」分段按钮（`aria-pressed`），默认渲染；源码模式就是今天的 `HighlightedCode lang=markdown`，不变                                                |
| B4  | 状态作用域 | 每打开一个文件都重置为渲染（`PreviewHost` 以 `view.path` 作 `:key`）；同一文件 retry 保持当前选择；不持久化                                                                        |
| B5  | 截断       | 截断的 md 仍默认渲染：去掉被切断的最后一行，加「结尾可能不完整」提示；复制按钮始终复制已显示部分的源码                                                                             |
| B6  | md 内路径  | 照常走 PathText（probe 把关）；在对话框里点击 ⇒ 对话框内 navigate（可返回）；相对路径按会话 cwd 解析                                                                               |
| B7  | 性能（新） | **把 `parseInline` 的失败搜索改成摊还线性**（加失败位置 memo，输出不变）+ **AST 节点预算 20 000**，超出时自动降级为源码模式并提示；用固定 256 KiB 病态输入做基准和增长测试（§4.3） |

---

## 1. 协议契约（P0 一次冻结，两端共享类型）

### 1.1 `src/web-hub/protocol/preview.ts`（只增）

```ts
// —— 路径 ——
export function validatePreviewPath(p: string, opts?: { minSegments?: 1 | 2 }): boolean; // 默认 2（识别层冻结口径）；hub ③ / probe 逐条 / UI 导航用 1

// —— 响应 kind ——
export type PreviewResponseKind = "text" | "image" | "dir"; // X-PWH-Preview-Kind 的全部取值

// —— probe 线上形状（hub 用 satisfies 钉住，UI parser 以它为准）——
export type PreviewProbeKind = "text" | "image" | "dir" | "missing"; // "dir" 只在 dirs:true 时出现
export interface PreviewProbeRequestBody {
  paths: string[];
  dirs?: true;
}
export interface PreviewProbeResponseBody {
  results: Array<{ kind: PreviewProbeKind }>;
}
export const PREVIEW_PROBE_KINDS = ["text", "image", "dir", "missing"] as const; // 唯一来源；hub/transport/UI parser 只用这一份（§1.3）

// —— 目录 ——
export const PREVIEW_DIR_QUERY = "dir"; // 仅 "1" 生效
export const PREVIEW_DIR_SCAN_MAX = 10_000; // ① 最多读取的 dirent 数
export const PREVIEW_DIR_ENTRIES_MAX = 1_000; // ② 最多返回的条目数
export const PREVIEW_DIR_BODY_MAX_BYTES = 512 * 1024; // ③ 响应 JSON 的 UTF-8 字节上限（未压缩）
export const PREVIEW_DIR_NAME_MAX_BYTES = 1_024; // 单个名字的 UTF-8 字节上限（超出丢弃，计入 dropped）
export const PREVIEW_DIR_LIST_MS = 5_000; // 列举阶段独立预算（§3.4）
export const PREVIEW_DIR_STAT_CONCURRENCY = 8;
export const PREVIEW_DIR_CLOSE_MS = 1_000; // dir handle close 的上限（§3.3）
export type PreviewDirEntryType = "dir" | "file" | "symlink" | "other";
export interface PreviewDirEntry {
  name: string;
  type: PreviewDirEntryType;
  size?: number;
  mtimeMs?: number;
  lossy?: true;
}
export interface PreviewDirListing {
  entries: PreviewDirEntry[]; // 已排序（dir 在前，再按名称）
  total: number; // 已扫描部分中通过过滤的条目数（≥ entries.length）
  scanned: number; // 实际读取的 dirent 数（≤ SCAN_MAX）
  complete: boolean; // 是否读到目录末尾（scan 上限未触发且无 readdir 错误）
  truncated: boolean; // = entries.length < total || !complete
  limits: { scan: boolean; entries: boolean; bytes: boolean }; // 各层是否触发
  vanished: number; // readdir 与 lstat 之间消失的条目数
  dropped: number; // 名字超长被丢弃的条目数
  statPartial?: true; // lstat 阶段预算耗尽，部分条目缺 size/mtime
}
/** 严格校验 + 聚合大小检查（byteLength = 解码后 body 的 UTF-8 字节数）。不合法 ⇒ null。 */
export function parsePreviewDirListing(raw: unknown, byteLength: number): PreviewDirListing | null;
```

`parsePreviewDirListing` 的拒绝条件（任一即 null）：`byteLength > PREVIEW_DIR_BODY_MAX_BYTES`；`entries` 不是数组或长度 > ENTRIES_MAX；名字为空、含 `/` 或 NUL、UTF-8 字节数 > NAME_MAX_BYTES；`type` 不在枚举内；`size`/`mtimeMs` 不是非负有限数；`total < entries.length`；`scanned > SCAN_MAX`；`truncated !== (entries.length < total || !complete)`；`limits` 三个字段不是布尔值；`vanished`/`dropped` 不是非负整数。未知字段忽略（为后续扩展留余地）。

### 1.2 `src/web-hub/protocol/version.ts`

```ts
/** A：目录 opt-in 可用。与 PREVIEW_ABS_HUB_CAP 一样，由同一个 feature gate（config.preview 存在）
 *  同步声明，另外要求 hub 启动时 /proc/self/fd 可用（§3.6）。cap 不是独立的配置开关，
 *  只用于客户端识别和版本兼容。 */
export const PREVIEW_DIR_HUB_CAP = "preview.dir.v1";
/** C：hub 准入任意绝对路径（UI 据此放开识别）。同上，与 preview.v1 同步声明，不是独立开关。 */
export const PREVIEW_ABS_HUB_CAP = "preview.abs.v1";
```

### 1.3 端口与契约钉（第二轮 #12 定稿：唯一来源 + 三层同步 + 折叠语义）

- **唯一来源**：`PreviewProbeKind`（含 `"dir"`）与其常量元组 `PREVIEW_PROBE_KINDS` **只**定义在 `src/web-hub/protocol/preview.ts`（§1.1）。hub 应答构造、UI transport 类型、UI parser 三处一律 import，不得再出现本地字面量联合。
- **三层同步机制**：
  1. **类型 import 链**：hub `probe.ts` 的应答构造 `satisfies PreviewProbeResponseBody`；`ui/src/transport/types.ts` 的 `PreviewProbeOutcome.results` 元素类型 `import type { PreviewProbeKind }`（删除本地联合）；`ui/src/logic/previewProbe.js` 的 `parseProbeResults` 改用 `PREVIEW_PROBE_KINDS.includes(kind)` 判型（删除现 L91 的手写 `"text" && … "image"` 联合）。
  2. **类型级契约**（`tests/web-hub/contract/types.test-d.ts`，vue-tsc 跑得到）：transport results 元素类型 ≡ `PreviewProbeKind`；`PreviewOutcome` dir 变体的 `listing` ≡ `PreviewDirListing`。
  3. **运行时契约**：`probe.test.ts` 把 hub 真实应答交给 UI 的 `parseProbeResults` 必须 ok；`logic-preview-probe.test.ts` 遍历 `PREVIEW_PROBE_KINDS` 断言 parser 逐个接受、对任意其他字符串拒绝。
- **`dirs:false`/缺省却收到 `"dir"` ⇒ 折叠为 `missing`，不报错**。落点：两个 logic client 的 `probePost`（它们知道 `req.dirs`）在 `req.dirs !== true` 时把 `"dir"` 映射为 `"missing"` 后再返回——单点、两 client 对称，`transport-contract.test.ts` 钉一致。理由：(a) 这种应答只会来自版本错配（旧 bundle × 新 hub）或 transport 缺陷，是**条目级**事件，而 `E_BAD_RESPONSE` 会把**整批**候选降级成纯文本，杀伤面大一个数量级；(b) 对这个客户端而言「点击确实不可能成功」（它不会带 `dir=1` 去 GET，只会得到 415）——恰好就是 probe 既有语义里 `missing` 的定义。**fetch 路径不同**：`checkPreviewHeaders` 在无 opt-in 时收到 `Kind: dir` 仍回 `E_BAD_RESPONSE`——那是单个内容响应的契约违约，影响面只有这一个请求，且客户端本就 abort 掉了 body。两条路径的差别各钉一条测试（`transport-contract.test.ts`）。
- **旧 parser 迁移 = 编译验收**：删除 `previewProbe.js` 的手写 kind 联合与 `transport/types.ts` 的本地联合后，`npm run typecheck`（含 vue-tsc）必须绿；UI source-scan 新增两条规则：`ui/src/logic/previewProbe.js` 必须 import `PREVIEW_PROBE_KINDS` 且不得含 `!== "image"` 这类手写判型片段；`ui/src/transport/types.ts` 不得声明 `"text" | "image"` 字面量联合。
- **hub 端类型化发送器**：`routes.ts` 内部新增 `sendDirListing(io, res, listing: PreviewDirListing, headers)` 与 `sendProbeResults(io, res, body: PreviewProbeResponseBody)`——`io.sendJson` 的 `body: unknown` 抓不住两端漏改，这两个薄封装让 typecheck 抓得住。
- `hub/ports.ts`：`PreviewRoutes.handle` / `handleProbe` 的注释改为引用 `PreviewResponseKind` / `PreviewProbeRequestBody` / `PreviewProbeResponseBody` / `PreviewDirListing`。
- **hub 输出 ⇄ UI parser 运行时契约**：`dir.test.ts` 把 hub 实际产出的 listing 序列化后交给 `parsePreviewDirListing`，必须非 null（§3.2 的防御性断言之外的第二道钉）。

### 1.4 线上形态变化一览

| 请求                                     | 今天              | 之后                                                  |
| ---------------------------------------- | ----------------- | ----------------------------------------------------- |
| `GET path=<cwd 外的绝对文件>`            | 403 `outside`     | 正常准入（200 / 403 / 404 …）                         |
| `GET path=/one`（1 段）                  | 400               | 进入准入                                              |
| `GET path=<目录>`（无 `dir`）            | 415 `not-regular` | 不变                                                  |
| `GET path=<目录>&dir=1`                  | 415               | 200 JSON（cap 已声明时）；没有 `/proc` 的平台仍为 415 |
| `POST probe {paths}` 中 cwd 外的路径     | `missing`         | 按真实结果                                            |
| `POST probe {paths, dirs:true}` 中的目录 | `missing`         | `dir`                                                 |
| upload 类 + `dir`/`dirs`                 | —                 | 忽略                                                  |

---

## 2. C · 准入管线重构

### 2.1 `admit.ts`：`createCwdAdmitter` → `createFsAdmitter`（第二轮 #1 定稿接口）

**最终接口**（`admit.ts`）：

```ts
// 旧导出 CwdAdmitter / CwdAdmitInput / CwdAdmitResult / CwdAdmitterDeps / createCwdAdmitter
// 全部删除（决策与编译验收见下方迁移表）。
export interface FsAdmitterDeps {
  denyCtx: PreviewDenyContext; // §2.6：homes[] / agentDirs[]（literal + canonical 去重）
  tracker: PreviewIoTracker; // §2.4：realpath / stat / open / fstat / readlink 每步过 tracker
  fs?: Partial<PreviewFs>;
  log: HubLog;
  now(): number;
  stepCapMs?: number; // 仅供测试
}
export interface FsAdmitInput {
  path: string; // 请求原样绝对路径
  allowDir?: boolean; // 仅 /proc 可用时生效（§3.6）
}
export type FsAdmitResult =
  | { ok: true; fh: PreviewHandle; size: number; realpath: string; dir?: true }
  | { ok: false; status: number; code: string; reason?: string }; // status 0 = E_ABORT（不应答）
export interface FsAdmitter {
  admit(input: FsAdmitInput, deadline: ReqDeadline, signal: AbortSignal): Promise<FsAdmitResult>;
}
export function createFsAdmitter(deps: FsAdmitterDeps): FsAdmitter;
export function denyCtxOf(home: string, agentDir: string): PreviewDenyContext; // 纯字面构造（零 fs），测试用
```

**错误码表**（与今天同一码空间，仅 `outside` 不再产生；`PreviewDenyReason` 类型保留 `outside` 以兼容旧 UI 的 i18n）：

| 阶段                                              | status / code                   | reason                    |
| ------------------------------------------------- | ------------------------------- | ------------------------- |
| 字面 denylist（steps 1–3，零 fs）                 | 403 `E_PREVIEW_DENIED`          | `denylist`                |
| 字面虚拟根                                        | 403 `E_PREVIEW_DENIED`          | `virtual-fs`              |
| realpath ENOENT / ENOTDIR                         | 404 `E_NOT_FOUND`               | —                         |
| realpath EACCES / EPERM                           | 403 `E_PREVIEW_DENIED`          | `unreadable`              |
| realpath ELOOP                                    | 409 `E_PREVIEW_CHANGED`         | —                         |
| realpath 超时 / 熔断                              | 504 `E_DEADLINE` / 503 `E_BUSY` | —                         |
| `rp === "/"`（step 5）                            | 403 `E_PREVIEW_DENIED`          | `root-too-broad`          |
| realpath 后 denylist / 虚拟根（step 5）           | 403 `E_PREVIEW_DENIED`          | `denylist` / `virtual-fs` |
| stat / open / fstat（`mapFsError` 表）            | 404 / 403 / 409 / 503 / 504     | 同现有                    |
| fstat 非普通文件且非（`allowDir` ∧ 目录 ∧ /proc） | 415 `E_PREVIEW_UNSUPPORTED`     | `not-regular`             |
| dev/ino 漂移 / `/proc/self/fd` 复核失败           | 409 `E_PREVIEW_CHANGED`         | —                         |
| 请求 abort                                        | status 0 `E_ABORT`              | 由调用方决定不应答        |

**步骤表**（fs 类；renumber 后 step 8/9 是 §3.1 allowDir 与 /proc 复核的落点）：

| 步骤                  | 内容                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3 字面判定（零 fs） | `denyListHit(path, denyCtx)`；`isVirtualFsPath(path)`                                                                                                          |
| 4 realpath(path)      | 保留（原 step 6）                                                                                                                                              |
| 5 复查                | `rp === "/"` ⇒ `root-too-broad`；`denyListHit(rp, denyCtx)`；`isVirtualFsPath(rp)`                                                                             |
| 6–9                   | 原 stat / `open(rp, O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY)` / fstat dev/ino + 普通文件（`allowDir` 时目录放行，§3.1）/ `/proc/self/fd` 复核，**全部保留** |

删除：root 相关判定（原 1–2）、`realpath(root)`（原 5）、`withinRoot` 包含判定（原 7）。

**调用方迁移表**（`createCwdAdmitter` 现有引用逐一列出；行号为当前工作树）：

| 现调用点                                                                       | 现写法                                              | 迁移后                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `routes.ts:42`                                                                 | `import { createCwdAdmitter, type CwdAdmitter, … }` | `import { createFsAdmitter, type FsAdmitter, … }`                                                                                         |
| `routes.ts:194`                                                                | `PreviewRoutesDeps.admitter?: CwdAdmitter`          | `admitter?: FsAdmitter`                                                                                                                   |
| `routes.ts:201`                                                                | 默认 `createCwdAdmitter({ home, log, now })`        | 默认 `createFsAdmitter({ denyCtx, tracker, log, now })`；**`PreviewRoutesDeps.home: string` 字段删除**（它唯一用途就是构造默认 admitter） |
| `open.ts:23 / :75`                                                             | `type CwdAdmitter`                                  | `type FsAdmitter`（仅类型名）                                                                                                             |
| `admit.ts:58–218`                                                              | 定义处                                              | 重命名 + 输入/依赖替换（本表上面的接口）                                                                                                  |
| `hub.ts` L643–660                                                              | `createPreviewRoutes({ home: config.home, … })`     | 先 `await resolvePreviewDenyContext(...)`（§2.6），改传 `denyCtx`；`uploadsRoot` 仍用 `config.home`（不受影响）                           |
| `tests/web-hub/hub/preview/admit.test.ts` / `routes.test.ts` / `probe.test.ts` | `createCwdAdmitter({ home, … })` 或注入 admitter    | 用 `denyCtxOf(home, agentDir)` 构造（纯字面）；canonical 表示的用例改由注入预构造 `PreviewDenyContext` 覆盖                               |
| `file-search.ts`                                                               | 只 import `isVirtualFsPath`（非 admitter）          | 不动                                                                                                                                      |

**旧接口删除，不保留别名**。理由：(a) 旧签名以 `home: string` + root 包含判定为语义核心，新接口没有任何「照旧工作」的兼容语义——别名要么接受 `home` 却忽略 containment（撒谎），要么 typecheck 不过；(b) `createCwdAdmitter` / `CwdAdmitter*` 无包根导出（`index.ts` 只导出 agent 侧 wiring），全部引用在 `hub/preview/` 内部 + 3 个测试文件，一个 PR（P1a）改完；(c) 留一个语义不同的别名正是「两套准入」复活入口。**编译验收**：P1a 合入后 `npm run typecheck` 绿，且 `tests/web-hub/hub/preview/source-scan.test.ts` 新增规则——`src/web-hub/hub/` 与 `src/web-hub/hub/preview/` 内不得再出现 `CwdAdmitter` / `createCwdAdmitter` 字样（防重新引入）。

**`denyListHit` 输入语义**：

```ts
export interface PreviewDenyContext {
  homes: string[];
  agentDirs: string[];
} // 各为 literal + canonical 去重
export function denyListHit(p: string, ctx: PreviewDenyContext): boolean;
```

- `p` 是**单个**待判定的绝对路径字符串。admitter 恰好调用它两次：字面阶段传**请求原样路径**（steps 1–3，零 fs），realpath 阶段传**解析结果 `rp`**（step 5）。两次传的是同一规则集、不同字符串——不存在「literal 传一路、canonical 传另一路」的分支；两种拼法的覆盖由 ctx 的数组承担。
- 规则分两层：**上下文前缀层**（`<agentDir>/{web-hub,auth.json,models.json}`、`<home>/.config/pi`）对 `ctx.homes` / `ctx.agentDirs` 的**每个**成员做段对齐前缀匹配（`p === base || p.startsWith(base + "/")`）——无论请求写的是 literal 拼法还是 canonical 拼法、无论传的是字面路径还是 rp，四种组合都被覆盖；**全局层**（绝对前缀 / 段 / 连续子路径 / basename / 模式 / 扩展名，§2.3）与 home 无关，直接匹配 `p`。
- **不变量**（`denylist-corpus.test.ts` 钉住）：每条上下文前缀规则都有同义的全局子路径孪生（§2.3），因此 ctx 缺哪一种表示都不会漏。

**realpath 失败的确定行为（两类都 fail-closed）**：

- **启动时 deny-ctx 的 realpath 失败**（§2.6 降级）：该成员只保留 literal 表示；防护由上面的全局孪生不变量兜底，并写 `preview.deny_ctx_degraded` WARN（无路径）。准入管线本身不因降级变宽——字面 / realpath 两次 denylist 检查照常执行。
- **请求时 `realpath(path)` 失败**（step 4）：请求**绝不**在没有 `rp` 的情况下继续——后续 open / fstat / `/proc` 复核全部以 `rp` 为锚，`rp` 缺失即在该步终止，映射即上面的错误码表（404 / 403 `unreadable` / 409 / 504 / 503），与今天 `realpath(path)` 失败的行为一致；今天 `realpath(root)` 的失败行随 root 步骤一起删除。即：**fail-closed 到 step 4 为止，任何失败路径都不可能走到 step 6 的 open**。

### 2.2 `open.ts` / `routes.ts` / `probe.ts` / `audit.ts`

- `open.ts`：⑤⑥ 不动；⑦ fs 分支调用 `admitter.admit({ path, allowDir })`。
- `routes.ts` ③：`validatePreviewPath(path, { minSegments: 1 })`；`cls` 三值，按字面计算。
- `probe.ts`：逐条校验用 `minSegments: 1`。
- `audit.ts`：`cls` 增加 `"abs"`，`kind` 增加 `"dir"`，白名单 key 不变。

### 2.3 denylist 清单（`admit.ts`，`PREVIEW_DENYLIST_VERSION = 2`）

- **绝对前缀**：`/etc/shadow` `/etc/shadow-` `/etc/gshadow` `/etc/gshadow-` `/etc/sudoers` `/etc/sudoers.d` `/etc/ssl/private` `/etc/NetworkManager/system-connections` `/etc/wireguard` `/root` `/var/lib/sss`
- **上下文前缀**（§2.6，literal + canonical 都检查）：`<agentDir>/web-hub`、`<agentDir>/auth.json`、`<agentDir>/models.json`、`<home>/.config/pi`
- **段**（任意位置）：既有 `.ssh .gnupg .aws .azure .kube .docker .password-store .mozilla .thunderbird .terraform.d`，新增 `.pki`
- **连续子路径**（任意位置，与 home 字符串无关）：既有 + 新增 `.pi/agent/web-hub` `.pi/agent/auth.json` `.pi/agent/models.json` `.config/pi` `.config/op` `.config/rclone` `.config/sops` `.config/age` `.config/github-copilot` `.claude/.credentials.json` `.codex/auth.json` `.local/share/password-store`
- **basename**：既有 + `.vault-token` `kubeconfig` `.terraformrc`；模式新增 `^ssh_host_.*_key$`、`\.tfstate(\.backup)?$`
- **扩展名**：不变（`.pem .key .p12 .pfx .kdbx`）

### 2.4 `PreviewIoTracker`：僵尸 fs 熔断原语（`fs.ts`）

```ts
export interface PreviewIoTracker {
  readonly zombies: number; // 已放弃（超时/abort）但底层 promise 尚未 settle 的操作数
  readonly max: number; // 熔断阈值，默认 PREVIEW_FS_ZOMBIE_MAX = 2
}
export function createPreviewIoTracker(max?: number): PreviewIoTracker;
/** 哨兵：max = Infinity，永不熔断。引用范围被 source-scan 限制在 fs.ts 与 tests/（见下）。 */
export const NO_TRACKER: PreviewIoTracker;

// —— 改造后的完整签名（第二轮 #4 定稿）——
export function racePreviewIo<T>(
  p: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  now: () => number,
  tracker?: PreviewIoTracker, // 可选：verify/stream 这两个已声明不纳入的既有调用方零改动
): Promise<T>;

export interface PreviewFsStepOpts {
  stepCapMs?: number; // 默认 PREVIEW_FS_STEP_MS
  now(): number;
  tracker: PreviewIoTracker; // 必填：调用 lazy 前检查熔断，并接管本 step 的计数
}
export function previewFsStep<T>(
  lazy: () => Promise<T>,
  deadline: { remaining(): number },
  signal: AbortSignal | undefined,
  opts: PreviewFsStepOpts,
): Promise<T>;
```

**「禁止绕过 tracker」的双层验收（类型层 + source-scan）**：`previewFsStep` 的 `tracker` 是**必填**参数——忘传直接编译错；不想熔断的调用方必须显式写 `tracker: NO_TRACKER`，而哨兵的引用范围由 source-scan 限制在 `fs.ts` 与 `tests/`，两级合起来使**生产代码不可能静默绕过**。`racePreviewIo` 的 tracker 保持可选（`verify.ts` 5 处、`stream.ts` 1 处既有调用不传 ⇒ 不计数、不熔断，语义与今天一致，与下方「未纳入」清单一致）。

**状态机**（每个被 race 的底层 promise 一份，闭包局部变量 `state`）：

```
running ──(底层 settle，早于 race 结束)────────────────────────▶ settled   （不计数）
running ──(deadline/abort 先触发；done 标志保证只触发一次)──▶ abandoned  （tracker.zombies += 1）
abandoned ──(底层 settle：then/catch 任一分支)─────────────────▶ settled   （tracker.zombies -= 1）
```

- 转移只由 `racePreviewIo` 内部的 `finish()`（race 侧）和 `p.then(onOk, onErr)`（底层侧）触发，`state` 检查保证每条边最多走一次 ⇒ 不会重复计数；重复的 abort 事件被已有的 `done` 标志吞掉。
- `previewFsStep` 在调用 `lazy()` **之前**检查：`tracker.zombies >= tracker.max` ⇒ `PreviewIoError("busy")`（`PreviewIoFail` 增加 `"busy"`），`mapFsError` 映射为 503 `E_BUSY`，retryAfterS 为 1；probe 中折叠为 `missing`。`lazy` 没被调用就不存在底层操作，所以也不计数。
- `lazy()` 同步抛错：`Promise.resolve().then(lazy)` 已经把它转成 rejection ⇒ `running→settled`，不计数。
- JS 单线程，`+=`/`-=` 天然原子；计数器不会为负（只有 `abandoned→settled` 一条边会减）。
- **实例归属**：每个 `createPreviewRoutes` 实例一个 tracker，经 deps 传给 admitter、`readSample`、probe 的 `readHead`、`dir.ts` 的全部 step 以及 close。不放模块作用域 ⇒ `/reload` 或 hub 重启后新实例从 0 开始；旧实例的迟到 settle 只改旧计数器（已不可达），无副作用。
- **未纳入的调用点**（写明理由）：`stream.ts` / `verify.ts` 的读（只在准入成功之后运行，文件已证明可响应，且有各自的 deadline）；`uploads.openForPreview`（上传根在本地 home 下）；`file-search.ts`（独立端点、cwd 范围）。
- **与线程池其他使用者的关系**：阈值 2 是相对于 libuv 默认 4 线程而言，保证至少还剩 2 个线程给上传、gzip、db 握手等。tracker 只限制 preview，不管理其他使用者。（可选加固、不在本方案内：在 agent 拉起 hub 子进程的环境里设 `UV_THREADPOOL_SIZE=8`。）
- **调用点参数流转表**（每个 preview fs step 的实参来源；tracker 实例 = `createPreviewRoutes` 创建、经 deps 下发的那一个）：

| 调用点                                                                     | lazy / 底层 promise                        | deadline 对象                                                                                      | stepCapMs                 | signal                                                           | tracker                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `admit.ts` realpath / stat / open / fstat / readlink                       | 对应 `PreviewFs` 方法                      | 请求 `r`（8 s）                                                                                    | 2 s                       | 请求 signal                                                      | routes 实例                                                        |
| `routes.ts` `readSample`（两个 read 循环）                                 | `fh.read(...)`                             | `r`                                                                                                | 2 s                       | 请求                                                             | 同上                                                               |
| `probe.ts` `readHead`                                                      | `fh.read(...)`                             | probe 请求 `r`                                                                                     | 2 s                       | 请求                                                             | 同上（probe 与 preview 共用实例）                                  |
| `dir.ts` opendir / readBatch / lstat                                       | `fs.opendir` / `dh.readBatch` / `fs.lstat` | 列举 deadline（5 s，§3.4）                                                                         | 2 s                       | 请求                                                             | 同上                                                               |
| `dir.ts` / `routes.ts` `boundedClose`（`dh.close`、目录请求的 `fh.close`） | `handle.close()`                           | **独立** `createReqDeadline(now, PREVIEW_DIR_CLOSE_MS)`（1 s；请求 deadline 可能已耗尽，不能复用） | —（整个 deadline 即上限） | **不接请求 signal**（close 必须尝试），只接 dispose 的 hub-close | 同上；超时 ⇒ 这次竞速自己计 abandoned                              |
| `fs.ts` `resolvePreviewDenyContext`（启动，§2.6）                          | `fs.realpath(home / agentDir)`             | 启动 deadline（2 s）                                                                               | 2 s                       | `startHub` signal                                                | 启动期独立 tracker（`createPreviewIoTracker()`，不与请求实例共享） |
| `verify.ts`（5 处 `racePreviewIo`）/ `stream.ts`（race 包装）              | —                                          | —                                                                                                  | —                         | —                                                                | **不传**（§2.4 未纳入清单；行为与今天一致）                        |
| `uploads.openForPreview` / `file-search.ts`                                | —                                          | —                                                                                                  | —                         | —                                                                | 不纳入（理由见上）                                                 |

**计数归属原则（late-close 由哪次竞速负责）**：**每次竞速只为自己 race 的那一个 promise 计数**。`boundedClose` 超时的计数由 close 自己的那次有界竞速负责；`admit.ts` 现有的「迟到 open 回收」路径（`closeQuiet`）**不新开计数**——那个 open 已由它自己的竞速计为 abandoned，回收 close 只是消费它 settle 的结果。任何为回收而补发的新 I/O 若也要有界，必须自己开一次新的 `previewFsStep` / `racePreviewIo`（如 `dir.ts` 的 `lateClose`），由新竞速自己计数——不存在「由别人的竞速代管」的计数。

**source-scan 验收**（`tests/web-hub/hub/preview/source-scan.test.ts` 新增三条规则）：

1. `previewFsStep(` 在 `KERNEL_FILES`（含 `dir.ts`）+ `routes.ts` 的每个调用点，其后 400 字符的实参区必须出现 `tracker`；
2. `NO_TRACKER` 仅允许出现在 `fs.ts` 与 `tests/`（全 `src/` 扫描 + 白名单）；
3. `racePreviewIo(` 在 `admit.ts` / `fs.ts` / `dir.ts` 的每个调用点必须显式传 tracker（`verify.ts` / `stream.ts` 白名单豁免，文件名写死）。

**测试**（`fs.test.ts`）：手动 deferred 的慢 promise 超时 ⇒ `zombies=1`，settle 后 ⇒ 0；两个并发超时 ⇒ 第三个 step 立即 busy 且 `lazy` 未被调用；同一 step 上重复 abort ⇒ 只计一次；`lazy` 同步抛错 ⇒ 不计数；底层 reject（而不是 resolve）同样会减计数；新的 routes 实例 tracker 为 0（模拟 `/reload`）；迟到的 open 回收路径仍然会关闭 fd。

### 2.5 识别层（`ui/src/logic/preview.js`）

#### 2.5.1 作用域

`PathScope` 增加可选的 `abs?: true`、`dirs?: true`；`previewScopeOf` 只在对应 cap 存在时才**加上**这两个键（旧的 `toEqual` 用例不受影响）；`scopeKeyOf` 在两者为 true 时分别追加 `|abs`、`|dir`（cap 变化 ⇒ 作用域失效，probe LRU 自然分区；不带标志时格式不变）。`isClickable` 在 `abs` 下 = `validatePreviewPath(path)`（≥2 段）；否则保持原规则。

#### 2.5.2 线性算法（完整伪代码 + 等价性 + 验收；第二轮 #5 定稿）

**不变量**

- (I1) 所有段的 `text` 拼接后恒等于输入；
- (I2) 每个输出的 ref 满足 `validatePreviewPath(ref.path)`（≥2 段、每段非空且非 `.`/`..`、无 NUL、UTF-8 字节数 ≤ 4096）与作用域路由（abs / cwd 前缀 / uploads marker）；
- (I3) 新算法对每个候选的判定 ≡ 朴素参考实现（逐候选独立重算终点与 `isClickable`，无任何 memo）。

**完整伪代码**（可直接照抄实现；`START_CHARS` / `START_CHARS_EXT` 见 §2.5.3）：

```
// —— 调用级（每次 findPathRefs 一次）——
abs = scope.abs === true;  dirs = scope.dirs === true
START = (abs || dirs) ? START_CHARS ∪ { "`" } : START_CHARS
cwd、cwdPrefix、uploads、markerNext：与现状完全一致（cwd 前缀串 / uploads 布尔 / marker 前向游标）

// —— run 级（进入新 run 计算一次；s0 = run 内第一个 '/'）——
// ① 既有扫描（不变）：end/spanEnd（终止符正向扫描）、spanStrippedEnd（尾部 [.:!?] 剥离，
//    保留 >1 字符守卫）、spanLineColStart/spanLine/spanCol（LINE_COL_RE，无则 -1）
// ② 统一终点 P（run 级常量；引理保证对 run 内一切合法起点 s 有 P(s) = P）：
hasLC = spanLineColStart !== -1 && s0 < spanLineColStart
P0    = hasLC ? spanLineColStart : spanStrippedEnd
P     = (dirs && !hasLC && P0 - 1 > s0 && text[P0-1] === "/") ? P0 - 1 : P0
//    dirs=false 时 P 恒等于现状的 pathEnd(s)；s ≥ P 的起点不产生候选（slice 为空）
// ③ 四个 run 级常量（对 [s0, P) 做一次正向扫描，slashes 顺便收集）：
slashes = []; lastBad = -1; lastNul = -1
for q in [s0, P):
    if text[q] === "/":
        segEnd = [q+1, P) 内下一个 '/' 的位置，无则 P            // 与 slashes 推进共用一次扫描
        if text[q+1, segEnd) ∈ {"", ".", ".."}: lastBad = max(lastBad, q)
        slashes.push(q)
    if text[q] === "\0": lastNul = q
secondLastSlash = slashes.length >= 2 ? slashes[len-2] : -1
// ④ minStart：从 P 反向累加 UTF-8 字节数（代理对 4；BMP 码点 1/2/3），找满足
//    bytes(j, P) ≤ 4096 的最小 j；回看至多 4097 字节且不越过 s0（O(1) 上限）

// —— 候选级（主循环；每个 '/' 起点 O(1)）——
i = 0
while i < n && refs < PREVIEW_MAX_REFS_PER_NODE:
    slash = text.indexOf("/", i)
    if slash >= spanEnd: 重算 run（①–④），继续本轮用新 run 数据
    strippedEnd = max(spanStrippedEnd, slash + 1)                  // 现状公式（含守卫）
    startOk = isStartContext(text, slash, START)
    if startOk && slash < P:
        fastOk = slash > lastBad && slash > lastNul && slash <= secondLastSlash && slash >= minStart
        // —— 路由一：绝对候选 ——
        if fastOk && P - slash <= 4096:                            // 现状的廉价 UTF-16 前置
            route = abs ? true
                  : (cwdPrefix !== null && text.startsWith(cwdPrefix, slash))  // 现状快速路径
                  : (uploads && markerHit(slash, P))                            // 现状 marker 游标
            if route:
                path = text.slice(slash, P)                        // dirs 的尾斜杠已含在 P 的推导里
                emitRef(text = text.slice(slash, strippedEnd), path, lineCol?)
                i = strippedEnd; continue
    // —— 路由二：相对候选（每 run 仅在 s0 试一次；位置与现状一致）——
    if slash === s0 && cwdPrefix !== null:
        ws = 从 s0 反向扫到 isWordBoundary(text, ws, START)        // 现状反向扫描；边界集同步换 START
        if ws < s0 && relativeStartContext(text, ws, START) && P - ws <= 4096:
            seg0ok = text[ws, s0) 非空 ∧ ≠ "."/".." ∧ 不含 ':' ∧ 不含 NUL ∧ lastBad < s0
                     //（lastBad ≥ s0 ⇒ 绝对段有坏段 ⇒ resolved 必非法，提前剪枝；最终仍由 isClickable 兜底）
            shape  = 现状 looksLikeRelativePath(text[ws, P))       // 末段扩展名形状
            dirsEx = dirs && (text[P-1] === "/"                                     // (b) 尾斜杠
                              || (text[ws-1] ∈ {"\"", "'", "`"} && text[strippedEnd] === text[ws-1]))  // (c) 成对包住
            if seg0ok && (shape || dirsEx):
                rel = text[ws, P)；若尾斜杠则剥掉最后一个 "/"
                resolved = cwdBase + "/" + rel
                if isClickable(resolved, scope):                   // 每 run 一次 O(len) ⇒ 总量线性
                    emitRef(text = text.slice(ws, strippedEnd), resolved, lineCol?)
                    i = strippedEnd; continue
    i = slash + 1
```

**等价性论证（abs / cwd / uploads 三种路由，含与现状快速路径的关系）**

- `fastOk(s) ⇔ validatePreviewPath(text.slice(s, P))`（减去前导 `/` 与 CR/LF 两项：CR/LF 是终止符，run 内不存在；前导 `/` 由扫描结构保证）。逐项：段合法 ⇔ `s > lastBad`——`lastBad` 是**全 run**坏段起点的最大值，坏段起点 `< s` 时该段不在 slice 内，`≥ s` 时 `lastBad ≥ s`，故「slice 内无坏段 ⇔ s > lastBad」；≥2 段 ⇔ `s ≤ secondLastSlash`（slice 内斜杠 = run 内 ≥ s 的斜杠，其倒数第二个存在 ⇔ 数量 ≥ 2）；NUL ⇔ `s > lastNul`；字节 ≤ 4096 ⇔ `s ≥ minStart`（bytes(s,P) 随 s 单调不增）。
- **cwd 路由（现状语义）**：`dirs=false` 时 `P = 现状 pathEnd(s)` 对 run 内一切合法起点成立（引理：行列号后缀与句读尾部都不含 `/`，故任何可作起点的 `/` 都满足 `s < P`；`strippedEnd` 的 `max(…, slash+1)` 守卫不改变这一点）。`startsWith(cwdPrefix)` 与 marker 前向游标**原样保留**，只是把现状 `isClickable` 里的 `validatePreviewPath` 调用换成了等价的 O(1) `fastOk` ⇒ 判定谓词逐点相同 ⇒ legacy 作用域下输出与旧实现**深相等**（差分测试钉住，见验收 1）。
- **abs 路由（新）**：同一 `fastOk`；`route` 恒真（`isClickable(abs)` 的定义就是 `validatePreviewPath`）。
- **uploads 路由（现状）**：marker 命中要求 marker 落在 `[slash, P)` 内，游标逻辑不动；`validatePreviewPath` 同样由 `fastOk` 覆盖。
- 公开 `isClickable` / `pathRefOfCode` 函数本体不变（`pathRefOfCode` 照旧逐个调用慢校验）；主循环内不再重复调用 `validatePreviewPath`。

**正确性门（差分测试为主）**（`tests/web-hub/ui/logic-preview.test.ts` + 新增 `tests/web-hub/ui/fixtures/preview-findpathrefs-ref.js`）：

1. **legacy 作用域**：旧 `findPathRefs` 原样拷贝为参考实现，在「全部既有冻结用例（一条不改）+ 固定 seed 模糊语料 2 000 例（字母表 `/ . a 1 : = 空格 " ' \` é 😀 \0`，长度 0–200）」上断言新旧输出**深相等**；
2. **abs / dirs / abs+dirs 作用域**：与测试内的**朴素 oracle**（I3：对每个 `/` 位置独立重算终点 P 并逐段慢校验，无 memo）在同样语料上**深相等**；
3. 性质测试：拼接恒等（I1）在四种作用域下各跑一遍。

**性能门（机器无关的操作计数，不写绝对毫秒）**：`logic/preview.js` 导出测试专用统计 `__previewScanStats = { charScans }`（`__resetPreviewScanStats()` 清零；在 run 正/反向扫描、`startsWith`、slice 长度处累加）。对下表每个输入断言 `charScans ≤ 10·n + 10_000`，并对 `"=/./"` 配对断言 `charScans(1 MiB) / charScans(64 KiB) ∈ [8, 24]`（线性 ≈16）。另设一条 5 s 墙钟**卡死哨兵**（只防指数级回归，不作为性能验收本身）：

| 输入                                                                                                           | 规模           |
| -------------------------------------------------------------------------------------------------------------- | -------------- |
| `"=/./".repeat(16384)` 与 `"=/./".repeat(262144)`（比值对）                                                    | 64 KiB / 1 MiB |
| `"/".repeat(1<<20)`、`"=/".repeat(1<<19)`、`"/a".repeat(1<<19)`、`"é/".repeat(1<<19)`、`"😀/=".repeat(≈1 MiB)` | 1 MiB          |

四种作用域各跑一遍。

#### 2.5.3 反引号（修正评审 #6）

- **markdown 上下文**（助手消息经 `MdInline`）：反引号 span 被解析器转成 `code` 节点，再由 `PathText` 的 code 模式交给 `pathRefOfCode`——整段就是候选，**不需要起点上下文**。dirs 作用域下，`pathRefOfCode` 接受含 `/` 的无扩展名相对路径（以及尾部 `/`）。
- **非 markdown 上下文**（`TxUser` 气泡、ToolCard 参数 `<pre>`、diff path——反引号保持字面）：dirs 或 abs 作用域下使用**扩展起点集** `START_CHARS_EXT = START_CHARS ∪ {"\`"}`，绝对路径的 `isStartContext`与相对路径的`relativeStartContext` 都用它；反引号本来就是终止符，候选在闭合反引号处结束。无扩展名相对路径的成对规则 (c)：`text[ws-1]`与`text[strippedEnd]`是同一种字符，取值为`"`、`'` 或 `` ` ``。旧作用域下起点集不变（冻结用例不受影响）。
- **测试**：`` `src/components` `` 在两种上下文下都可点；`` `src/foo.ts:12` `` 显示保留 `:12`、请求路径去掉；`` `/abs/dir/` `` 可点；散文中 ``foo`bar/baz`` 不可点（反引号不成对）；`` `and/or` `` 会成为候选（交给 probe，它会答 missing）——记为已接受的代价；旧作用域下 `` `/abs/x` `` 的行为与今天一致。

### 2.6 home / agentDir 的规范路径（修正评审 #1）

问题：`config.home` 或 `PI_CODING_AGENT_DIR` 本身可能是符号链接，此时 realpath 结果与 `${home}/.pi/agent/auth.json` 这类字面规则对不上，全局准入下就成了绕过路径。

处理：

1. **启动解析**：`fs.ts` 新增 `resolvePreviewDenyContext({ home, agentDir }, { tracker, now }): Promise<PreviewDenyContext>`，返回 `{ homes: string[]; agentDirs: string[] }`，每个都是 literal 与 realpath 去重后的结果。realpath 走 `previewFsStep`（2 s）；失败时只保留 literal，并 `log.warn("preview deny context: realpath failed", { event: "preview.deny_ctx_degraded", which: "home"|"agentDir" })`，不带路径。`hub.ts` 在 `createPreviewRoutes` 之前（L643 附近，`startHub` 的 async 装配段内）`await withSignal(...)`；agentDir 与 hub.ts L512 同源：`process.env.PI_CODING_AGENT_DIR ?? \`${config.home}/.pi/agent\``。
2. **规则双表示**：`denyListHit(p, ctx)` 对每个上下文前缀，按 `ctx.homes × 规则`、`ctx.agentDirs × 规则` 全部检查；字面请求路径和 realpath 结果都要过一遍（§2.1 第 1–3、5 步）。
3. **不依赖 home 的语义规则**：`.pi/agent/{web-hub,auth.json,models.json}`、`.config/pi` 同时作为**任意位置的连续子路径规则**（§2.3），即使 ctx 降级也不会漏。
4. **测试**（`admit.test.ts`，真实 tmpdir）：home 是 symlink（`T/home-link → T/real-home`）：请求 `T/real-home/.pi/agent/auth.json` ⇒ denied；请求 `T/home-link/.pi/agent/auth.json` ⇒ denied；经第三个 symlink（`T/x → T/real-home/.config/pi`）访问 `T/x/web-search.env` ⇒ realpath 命中 ⇒ denied；`PI_CODING_AGENT_DIR=T/custom-agent`（本身也是 symlink）下的 `auth.json` 两种表示都 denied；ctx 降级（realpath 失败）时子路径规则仍然命中。

### 2.7 安全边界、denylist 维护与回归（修正评审 #7）

- **边界声明**：写入 `plan.md` 修订节与 `AGENTS.md`——「web-hub preview 允许已认证用户（含 LAN，U1）读取 hub 进程 uid 可读、且未命中 denylist 的任意文件，并浏览目录。denylist 是**尽力而为的凭据黑名单**，不是白名单边界；它不完整是**已知的残余风险**（例如未知应用的 token 文件、浏览器以外的 cookie 库）。需要更严格时，使用 `webHub.preview:"loopback"` 或 `"off"`。」
- **版本与责任**：`admit.ts` 导出 `PREVIEW_DENYLIST_VERSION`，规则文件头部维护变更记录；改动 denylist 的 PR 必须同时更新语料测试（下一条），评审清单在 `AGENTS.md` 的 web-hub 段落写明。
- **回归机制**：
  - 新增 `tests/fixtures/preview-denylist-corpus.json`：`mustDeny` 约 60 条（每条规则至少一条，覆盖 home 与 `/home/other/...` 两种前缀）、`mustAllow` 约 40 条正常文件（`README.md`、`src/index.ts`、`.gitignore`、`.github/workflows/ci.yml`、`docs/keys.md`、`src/auth/session.ts`、`/etc/hostname`、`~/.bashrc`、`~/.config/nvim/init.lua`、`terraform/main.tf`、`id_rsa_notes.txt` 等易误伤的名字）。
  - 新增 `tests/web-hub/hub/preview/denylist-corpus.test.ts`：纯函数遍历两张表，再断言 `PREVIEW_DENYLIST_VERSION` 与语料文件的 `version` 字段相等（改了规则却没更新语料 ⇒ 测试红）。
- **发布前人工扫描**：新增 `scripts/dev/preview-denylist-audit.mjs`（只读）：在 `$HOME` 下遍历至多 4 层（跳过 `node_modules` / `.git` / `.cache`），列出「当前 uid 可读、未被 denylist 拒绝、且名字命中凭据启发式（`token|secret|credential|passw|auth|\.pem$|\.key$|cookies`）」的文件，只打印到本地终端，供人工判断是否需要补规则。`acceptance.md` 的发布检查加一步「运行 audit，确认没有需要补的规则」。

### 2.8 存在性 / 类型 oracle（修正评审 #8，有意保留的行为）

| 面           | 行为                                                                                                                                                                                                   | 结论                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `GET` 错误码 | 404（不存在）/ 403 `denylist`（**字面阶段：与文件是否存在无关**）/ 403 `denylist`（realpath 阶段：仅对经符号链接到达的路径暗示存在）/ 403 `virtual-fs` / 403 `unreadable`（暗示存在）/ 415 / 409 / 200 | **保留区分**：UX 需要（U1）；可从中推断存在性是已接受的 |
| probe        | 所有失败折叠为 `missing`（不变）                                                                                                                                                                       | 保留                                                    |
| 目录清单     | denylist 命中的条目**既不列出也不计数**（v2 的 `hidden.denied` 已删除）；UI 始终显示静态脚注                                                                                                           | **折叠**：避免一次性暴露整个目录中凭据文件的存在        |
| 审计         | 每个请求一行，含 `cls`/`kind`/`code`/`reason`，不含路径                                                                                                                                                | LAN 验收时抽查（§6 E4）                                 |

### 2.9 uid 0 告警（修正评审 #13）

- 时机：`startHub` 中、`config.preview !== undefined` 且 `createPreviewRoutes` 成功之后，执行一次。
- 判定：`deps.getuid?.() ?? process.getuid?.()` 等于 0。`getuid` 作为 `startHub` deps 的可选注入点，测试用。
- 输出：`log.warn("web-hub preview: hub is running as root — OS permission checks no longer limit preview; only the denylist applies", { event: "preview.root_uid", mode: config.preview })`。只带 `event` 和 `mode` 两个字段，不带路径或用户名。
- 去重：每个 hub 进程启动时一次（`startHub` 只调用一次；`/webhub restart` 产生新进程，再告警一次是预期行为）。
- 测试（`hub-preview.test.ts`）：注入 `getuid: () => 0` ⇒ 恰好一行，字段完全相等；`() => 1000` ⇒ 没有；`getuid` 未定义 ⇒ 没有；preview 关闭 ⇒ 没有。

---

## 3. A · 目录预览（hub）

### 3.1 准入与 fs 面

- `admit.ts` step 8：`fst.isDirectory() && allowDir && procFdAvailable` ⇒ 标记 `dir:true`，继续执行 step 9 的 `/proc` 复核后返回；其余非普通文件仍 415。`PreviewStat` 增加 `isDirectory()`。open flags 不加 `O_DIRECTORY`。
- `fs.ts`：`toPreviewStat` 增加 `isDirectory`；`PreviewFs` 增加：
  - `opendir(p)` → `PreviewDirHandle { readBatch(max): Promise<Array<{name: string; type: PreviewDirEntryType}> | null>; close(): Promise<void> }`：封装 `fs.promises.opendir`；`close` 幂等；**在途操作未完成时调用 `close`，会排在在途操作之后执行**（由封装内部串行化，不依赖 Node 的 Dir 队列语义）。
  - `lstat(p)`。
  - 导出同步的 `previewProcFdAvailable()`（供 hub.ts 声明 cap 用）。
- `fs.ts` 仍是 `hub/preview/` 下唯一 import `node:fs` 的文件。

### 3.2 新 `dir.ts`：`listPreviewDir(input, deps, signal)`

```
input = { fh, realpath, requestPath }；deps = { fs, now, log, tracker, denyCtx }
deadline = createReqDeadline(now, PREVIEW_DIR_LIST_MS)          // §3.4
dirPath  = `/proc/self/fd/${fh.fd}`                             // 只走 proc（§3.6）
dh       = step(opendir(dirPath))                               // 迟到 resolve 的句柄 ⇒ 交给 lateClose（§3.3）
raw = []; scanned = 0; complete = false
loop:
  if scanned >= SCAN_MAX: limits.scan = true; break
  batch = step(dh.readBatch(min(256, SCAN_MAX - scanned)))      // 超时 ⇒ E_DEADLINE（504）；abort ⇒ abort
  if batch === null: complete = true; break
  scanned += batch.length; raw.push(...batch)
filtered = raw 去掉：denyListHit(realpath/name) || denyListHit(requestPath/name)（不计数，§2.8）；
           UTF-8 字节数 > NAME_MAX_BYTES 的名字（dropped++）；含 U+FFFD 的名字标 lossy
total  = filtered.length
sorted = 按（dir 组优先，toLowerCase 比较，码点兜底）排序
kept   = sorted.slice(0, ENTRIES_MAX)；limits.entries = sorted.length > ENTRIES_MAX
lstat 阶段：对 kept 并发 8 执行 step(lstat(`${dirPath}/${name}`))，共用同一个 deadline：
  ENOENT ⇒ 移除，vanished++（total 同步减 1）；其他 errno ⇒ 只保留 dirent 类型；
  成功 ⇒ type 以 lstat 为准，file 补 size，补 mtimeMs = floor；
  deadline 耗尽或 busy ⇒ 停止发起新的 lstat，剩余条目保持 dirent 类型，statPartial = true；
  abort ⇒ 返回 abort
字节预算：ENVELOPE_RESERVE = 1 KiB；bytes = ENVELOPE_RESERVE
  依次处理 kept 中的每个 e：b = utf8Len(JSON.stringify(e)) + 1
    if bytes + b > BODY_MAX_BYTES：limits.bytes = true；把 entries 截到当前位置；break
    bytes += b
truncated = entries.length < total || !complete
返回 listing；serialize 后断言 utf8Len ≤ BODY_MAX_BYTES（防御性；越界 ⇒ E_INTERNAL 并记日志）
```

**截断优先级与语义**：scan（读取阶段，决定 `complete`）→ 过滤 → entries（排序后）→ bytes（序列化预算）。`total` 始终是「已扫描部分中通过过滤的条目数」；`complete:false` 时 UI 显示「≥ total」。UI 文案按 `limits` 选择：scan ⇒「目录过大，只读取了前 10 000 项」；entries ⇒「只显示前 1 000 项（共 N 项）」；bytes ⇒「名字过长，只显示前 K 项」。

**最坏情况推算**：单条序列化约等于名字的 UTF-8 字节数（≤1 024；控制字符经 JSON 转义可放大到约 6 倍，即 ≤ 6 KiB）加约 80 字节的字段，所以 1 000 条可能远超 512 KiB，此时由 bytes 层截断。常规目录约 80 B/条，1 000 条约 80 KiB，不会触发。

### 3.3 生命周期：dir handle 与 fd 的关闭（修正评审 #3）

| 操作                                     | step deadline                                                                    | 请求级 deadline | abort                                 | 迟到处理                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------- | --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `opendir`                                | `min(2 s, 列举剩余)`                                                             | 列举 5 s        | 立即放弃                              | 迟到 resolve 的句柄 ⇒ `lateClose(dh)`；tracker 计 1，settle 后减 1                                      |
| `readBatch`                              | 同上                                                                             | 同上            | 立即放弃                              | 在途的读迟到 ⇒ tracker 计数；`close` 在封装内排在它之后                                                 |
| `lstat`                                  | 同上                                                                             | 同上            | 停止发起新的                          | 迟到 settle ⇒ tracker 减 1，结果丢弃                                                                    |
| `dh.close()`                             | `PREVIEW_DIR_CLOSE_MS`（1 s），**用独立 deadline**（请求 deadline 可能已经耗尽） | 不适用          | close 不受请求 abort 影响（必须尝试） | 超时 ⇒ tracker 计 1，响应路径不再等待；底层迟到 settle 后减 1；rejection 吞掉并 `log.debug`（不带路径） |
| 准入得到的目录 fd（`opened.fh.close()`） | 同 `dh.close` 的有界规则（目录请求才启用；文件请求保持现状）                     | —               | —                                     | 同上                                                                                                    |

`dir.ts` 内部在 `finally` 中调用 `boundedClose(dh)`。路由 ⑩ 的**释放顺序固定**为：

1. 应答（JSON 已 `end`，或错误已发送）；
2. `boundedClose(opened.fh)`，最多等 1 s；
3. 释放 in-flight 名额；
4. `active.delete`；
5. 写审计。

**dispose**：`ctl.abort("hub-close")` ⇒ 列举停止发起新 step；未发送应答头的 ⇒ 503；dispose 自身仍然最多等 1 s（现有契约）。之后迟到的 close 照常 best-effort 执行，计数只落在已废弃的实例 tracker 上，不抛异常，也没有 unhandled rejection。

**测试**（`dir.test.ts` / `routes.test.ts`，假 fs + deferred）：

- readBatch 成功但 `close` 永不 settle ⇒ 200 照常发出；名额在约 1 s 内释放；tracker=1；随后让 close settle ⇒ 0；
- opendir 迟到（超时后才 resolve）⇒ 句柄被关闭，tracker 回到 0；
- dispose 期间 close 迟到 ⇒ `dispose()` 在 1 s 内返回；之后的 settle 不抛错，没有 unhandled rejection（vitest `onUnhandledRejection` 钉住）；
- 在途 readBatch 期间调用 close ⇒ close 在读完成之后才执行；
- 名额释放顺序：注入一个可观察的 slot 释放回调，断言它晚于 close 的尝试、早于审计。

### 3.4 预算（修正评审 #9）

- 目录请求墙钟 = 准入（≤ `PREVIEW_ADMIT_TOTAL_MS` 8 s，含认证）**+** 列举（≤ `PREVIEW_DIR_LIST_MS` 5 s，**独立追加**）+ 发送（`sendJson` 一次性写入 ≤ 512 KiB，无服务端流式 deadline）。服务端阶段上限 13 s。
- 关系钉（`tests/web-hub/protocol/preview.test.ts`）：`PREVIEW_ADMIT_TOTAL_MS + PREVIEW_DIR_LIST_MS + 20_000 ≤ PREVIEW_CLIENT_TIMEOUT_MS`（8 + 5 + 20 ≤ 40，至少留 20 s 给 LAN 传输）。
- 错误码：opendir/readBatch 超时 ⇒ 504 `E_DEADLINE`（可重试）；lstat 阶段超时 ⇒ 200 + `statPartial`；熔断 ⇒ 503 `E_BUSY`；dispose ⇒ 503 `E_HUB_RESTARTING`（应答头未发送时）。
- 测试：列举阶段用到第 4.9 s 仍返回 200；readBatch 卡到超过 5 s ⇒ 504；准入用掉 7 s 之后列举仍然有完整的 5 s。

### 3.5 路由 / probe 接线

- `open.ts`：`OpenPathInput.allowDir?`，只转发给 fs admitter；`Opened.dir?: true`。
- `routes.ts`：`allowDir = query.get(PREVIEW_DIR_QUERY) === "1"`；`opened.dir` ⇒ `listPreviewDir` ⇒ `sendDirListing(...)`，headers 为 `X-PWH-Preview-Kind: dir`、`Cache-Control: no-store`、`Cross-Origin-Resource-Policy: same-origin`；审计 `kind:"dir"`、`total`、`truncated`，**不含名字**。
- `probe.ts`：`parseProbeBody` 返回 `dirs: raw.dirs === true`；`probeOne`：`allowDir: dirs`；`opened.dir` ⇒ 有界关闭后返回 `"dir"`（不读头）；应答经 `sendProbeResults`。
- `hub.ts`：caps 追加 `PREVIEW_ABS_HUB_CAP`；在 `previewProcFdAvailable()` 为真时再追加 `PREVIEW_DIR_HUB_CAP`（两处 cap 面一致）；启动时解析 deny context（§2.6）；uid 0 告警（§2.9）。

### 3.6 没有 /proc 的平台（修正评审 #10：fail-closed）

只要 `procFdAvailable()` 为假：admitter 对目录**照旧返回 415 `not-regular`**（`allowDir` 不生效）；hub 不声明 `preview.dir.v1` ⇒ UI 不发 opt-in、不识别目录候选。按路径列举 + 事后验证的方案存在「A→B→A」交换窗口，无法在不依赖目录 fd 的前提下线性化，所以不实现。测试：注入 `procFdAvailable: () => false` ⇒ 目录 415、probe 答 missing、cap 中没有 `preview.dir.v1`。

---

## 4. B · Markdown 渲染

### 4.1 UI

- `logic/preview.js`（只追加）：`isMarkdownPath(path)`；`prepareMarkdownPreview(text, truncated)`（截断时去掉最后一个 `\n` 之后的部分；全文没有 `\n` 时原样返回）；`countMdNodes(nodes)`（递归计数，带早停：超过上限即返回）。
- `PreviewText.vue`：`isMd` 为真时工具栏显示分段按钮，`mode = ref("rendered")`：
  - rendered：`nodes = parseMarkdown(prepared)`；`countMdNodes(nodes) > PREVIEW_MD_NODE_MAX(20_000)` ⇒ 强制源码模式并显示 `mdTooComplex` 提示，按钮置灰并附说明；否则 `<div class="preview-md" tabindex="0"><MdBlock :nodes="nodes" /></div>`（直接用 `MdBlock`，避免在 `MarkdownView` 中重复解析）；
  - source：今天的 `<pre><HighlightedCode>`，不变；
  - 截断提示按模式区分。非 md 文件的 DOM 与今天一致。
- `PreviewHost.vue`：`<PreviewText :key="view.path" …>`。P3 再加：子树 `provide(PREVIEW_CTX, { ...ctx, handle: { ...ctx.handle, open: navigate ?? open } })`。
- css：`.preview-md`；i18n：`viewRendered` `viewSource` `viewToggleLabel` `truncatedRenderNote` `mdTooComplex`。
- 安全：没有 `v-html`；HTML / 图片 / `javascript:` 链接按字面文本显示。

### 4.2 解析器线性化（`ui/src/logic/markdown.js`，输出不变）

现状问题：`parseInline` 中，`findClose` 在找不到闭合时会扫到 src 末尾；`"*a ".repeat(n)` 每个 `*` 都触发一次全量扫描 ⇒ O(n²)。未闭合的反引号（`src.indexOf(fence, …)`）同理。

**修法：失败位置 memo**（每次 `parseInline` 调用一个局部 `Map`）。

- 正确性：闭合候选的有效性只取决于候选自身位置周围的字符以及 `at > from`，所以「从 `from` 开始不存在有效闭合」⇒「从任何 `from' ≥ from` 开始也不存在」。
- 落地：`noClose.get(mark) ≤ from` ⇒ 直接返回 -1；一次失败后记录 `noClose.set(mark, min(已有值, from))`。
- 反引号：按 fence 长度 n 记录 `noFence[n]`。`indexOf(fence)` 匹配的是「包含至少 n 个连续反引号」的位置，与起点单调，同样成立。
- 递归：子节点在不相交的子串上，有各自的 memo；深度 ≤ `MAX_DEPTH`(6) ⇒ 每个字符至多被处理 7 次 ⇒ O(7n)。
- `LINK_RE` 匹配本身有长度上限（每个 `[` 至多约 3.3 KiB 的窗口）。最坏情况 `"[a]([a]("` 这类重复，要靠下表中的基准来确认。

**测试**（`tests/web-hub/ui/logic-markdown-perf.test.ts`，新增）：

| 256 KiB 输入                                                                                                   | 上限（中位数，3 次）                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `"*a ".repeat`、`"_a ".repeat`、`"~~a ".repeat`、``"`a ".repeat``、`"**a ".repeat`                             | 各 ≤ 200 ms                                       |
| `"[a](".repeat`、`"[a]([a](".repeat`、`"> ".repeat(…)+"x"`（逐行）、`"\| a \|\n".repeat`、`"- [ ] x\n".repeat` | 各 ≤ 200 ms                                       |
| 增长判据：上述每个输入在 64 KiB 与 256 KiB 下                                                                  | t(256 K) / t(64 K) ≤ 8（线性约为 4，二次约为 16） |

另加**差分测试**：把修改前的 `parseMarkdown` 拷贝为测试内的参考实现（`tests/web-hub/ui/fixtures/markdown-ref.js`），在固定 seed、2 000 例随机 markdown 片段上断言新旧输出深相等；现有 markdown 测试全部保持绿。

### 4.3 渲染预算与降级

- 解析时间由 §4.2 保证线性；DOM 规模由节点预算保证（20 000 个 AST 节点大约对应 ≤ 40 000 个 DOM 节点）。
- 超出 ⇒ 源码模式（`HighlightedCode` 对大文本本来就有既有的上限和降级策略）。
- `preview-text.test.ts`：`"*a* ".repeat(30000)` ⇒ 自动显示源码并给出提示；正常的大 md（如本仓库的 `AGENTS.md`）⇒ 渲染。

---

## 5. 分包实施计划（共享文件已排序）

```
Wave 1:  P0 协议冻结  ∥  PM Markdown（含解析器线性化）
Wave 2:  P1a 全局准入 + denylist(含 §2.6/2.7) + tracker + uid 告警   ∥   P2 UI 逻辑/传输（PM 合入之后开始）
Wave 3:  P1b 目录列举（与 P1a 共享 hub 文件 ⇒ 串行）
Wave 4:  P3 UI 组合式/组件
Wave 5:  P4 集成 + 文档
```

| 共享文件                                                                              | 先                         | 后  |
| ------------------------------------------------------------------------------------- | -------------------------- | --- |
| `ui/src/logic/preview.js`                                                             | PM（末尾追加 md 相关函数） | P2  |
| `ui/src/logic/markdown.js`                                                            | PM 独占                    | —   |
| `components/preview/PreviewText.vue`                                                  | PM 独占                    | —   |
| `components/preview/PreviewHost.vue`、`i18n/{zh,en}/preview.ts`、`styles/preview.css` | PM                         | P3  |
| `composables/usePreview.ts`                                                           | P3 独占                    | —   |
| `hub/preview/{admit,fs,open,probe,routes}.ts`、`hub/audit.ts`、`hub/hub.ts`           | P1a                        | P1b |

### P0 · 协议冻结（小，L1）

- 改：`protocol/preview.ts`（§1.1）、`protocol/version.ts`（§1.2，含 Nit 注释）、`tests/web-hub/contract/types.test-d.ts`（只加与 protocol 相关的断言；transport 部分由 P2 补）。
- 测：`tests/web-hub/protocol/preview.test.ts`：minSegments 正反例（默认行为不变）；`parsePreviewDirListing` 每条拒绝条件一例，含 512 KiB 边界 ±1、1 024 字节名字的 ±1、多字节名字、`truncated` 不一致；预算关系钉（§3.4）；`ENTRIES_MAX ≤ SCAN_MAX`。
- 冻结面：其余所有文件。验收：`npx vitest run tests/web-hub/protocol && npm run typecheck`。

### PM · Markdown（小 → 中，L2，前端车道；与 P0 并行）

- 改：`ui/src/logic/markdown.js`（§4.2，输出不变）、`ui/src/logic/preview.js`（末尾追加）、`components/preview/PreviewText.vue`、`components/preview/PreviewHost.vue`（只加 `:key` 与 path 传递）、`i18n/{zh,en}/preview.ts`、`styles/preview.css`。
- 测：新增 `logic-markdown-perf.test.ts` 与 `fixtures/markdown-ref.js`（§4.2）、`logic-preview.test.ts`（md 纯函数）、`preview-text.test.ts`（默认渲染 / 切换 / `aria-pressed` / 非 md 的 DOM 不变 / 截断去掉不完整行 / 复制值为源码 / 节点预算降级）、`preview-host.test.ts`（换 path 后重置为渲染）、`i18n-parity`、UI `source-scan`，以及现有全部 markdown / transcript 测试。
- 冻结面：`transcript/**`、`usePreview.ts`、hub、protocol。验收：`npx vitest run tests/web-hub/ui && npm run typecheck && npm run build:web`。

### P1a · 全局准入 + denylist + tracker + uid 告警（中，L2）

- 改：`hub/preview/admit.ts`（§2.1、§2.3、§2.6 的 `denyListHit(p, ctx)`）、`hub/preview/fs.ts`（§2.4 tracker、`resolvePreviewDenyContext`、`previewProcFdAvailable`）、`hub/preview/open.ts`、`hub/preview/routes.ts`（③ minSegments、`cls`、tracker 实例、`sendProbeResults`）、`hub/preview/probe.ts`、`hub/audit.ts`、`hub/hub.ts`（abs cap、deny context 解析、uid 告警、`getuid` 注入点）、`hub/ports.ts`（注释）；新增 `tests/fixtures/preview-denylist-corpus.json`、`scripts/dev/preview-denylist-audit.mjs`。
- 测：`admit.test.ts`（原 `outside` 行改为放行，逐行注明 U4；虚拟根和 denylist 的字面/realpath 双查行全部保留；§2.6 的 symlink home 真实 tmpdir 用例；`rp==="/"`）、新增 `denylist-corpus.test.ts`、`fs.test.ts`（§2.4 全部用例）、`routes.test.ts`（cwd 外 200、审计 `cls:"abs"` 无路径、1 段路径、busy ⇒ 503）、`probe.test.ts`（cwd 外 text、denylist ⇒ missing、busy ⇒ missing、应答能被 UI parser 接受）、`hub-preview.test.ts`（abs cap、uid 告警 4 例、deny ctx 降级 WARN 无路径）、`caps-coexist.test.ts`、`http/api-preview.test.ts`、`lan-preview.test.ts`（`mode:on` 时 LAN 可读 cwd 外；`mode:loopback` 时 LAN 404 逐字节同未启用）。
- 冻结面：`http.ts`、`stream.ts`、`verify.ts`、`sniff.ts`、`uploads.ts`、`file-search.ts`、`protocol/*`、`ui/**`。验收：`npx vitest run tests/web-hub/hub tests/web-hub/http && npm run typecheck && npm run format:check`。

### P1b · 目录列举（中，L2；在 P1a 之后）

- 改：`hub/preview/admit.ts`（step 8 allowDir + proc 门）、`hub/preview/fs.ts`（opendir 封装、lstat、boundedClose）、新增 `hub/preview/dir.ts`、`hub/preview/open.ts`、`hub/preview/routes.ts`（dir 分支、`sendDirListing`、⑩ 释放顺序）、`hub/preview/probe.ts`、`hub/hub.ts`（dir cap 的 proc 门）、`hub/ports.ts`。
- 测：`admit.test.ts`（allowDir 矩阵、无 allowDir 时 415 不变、无 proc 时 415、open 与 fstat 之间被换成 symlink ⇒ 409）、新增 `dir.test.ts`（§3.2 每一行、§3.3 全部生命周期用例、字节上限：1 000 条 × 1 024 字节名字 ⇒ `limits.bytes` 且序列化 ≤ 512 KiB、多字节名字、控制字符转义放大、输出能被 `parsePreviewDirListing` 接受）、`fs.test.ts`（真实 Linux：`opendir("/proc/self/fd/N")`、`lstat` 不跟随链接、封装的 close 排在在途读之后）、`routes.test.ts`（200 + 头 + 审计无名字；无 `dir` ⇒ 415；§3.4 预算用例；dispose）、`probe.test.ts`、`source-scan.test.ts`（`KERNEL_FILES` 加 `dir.ts`）、`memory.test.ts`（10 万条目的假目录 RSS 有界）、`http/api-preview.test.ts`、`api-preview-probe.test.ts`。
- 冻结面与验收：同 P1a。

### P2 · UI 逻辑 + 传输（中，L2；PM 合入后开始，可与 P1a/P1b 并行）

- 改：`logic/preview.js`（§2.5 全部内容；`childPreviewPath` / `parentPreviewPath`；`checkPreviewHeaders` 的 dir 门；`formatPreviewBytes`）、`logic/previewProbe.js`（接受 `"dir"`）、`logic/token-client.js` + `logic/password-client.js`：
  - `req.dir` ⇒ `&dir=1`；
  - dir 分支：在同一个 40 s deadline 内**有上限地读取 body**：有 `r.body.getReader()` 时累计解码字节，超过 `PREVIEW_DIR_BODY_MAX_BYTES` ⇒ abort 并返回 `E_BAD_RESPONSE`；没有时用 `arrayBuffer()` 读完再检查 `byteLength`；然后 `TextDecoder` → `JSON.parse` → `parsePreviewDirListing(json, byteLength)`；
  - `probePost` 在 `req.dirs` 时 body 加 `dirs:true`；
  - 两个 client 逐字对称；
- 以及 `transport/types.ts`、`types.ts`（PreviewHandle 新成员全部可选）、`tests/web-hub/contract/types.test-d.ts`（transport 部分）。
- 测：`logic-preview.test.ts`（旧用例不改；新增 abs 组、dirs 组、§2.5.2 perf 组、差分性质测试、§2.5.3 反引号组、导航函数真值表、header 门）、`logic-preview-probe.test.ts`、`transport-contract.test.ts`（两个 client 在 dir 成功、超过 512 KiB ⇒ abort + `E_BAD_RESPONSE`、gzip 场景、JSON 坏、schema 坏、无 opt-in 却收到 dir、`dirs` 透传 下表现一致）。
- 冻结面：`components/**`、`composables/**`、hub、protocol。验收：`npx vitest run tests/web-hub/ui && npm run typecheck`。

### P3 · UI 组合式 + 组件（中，L2，前端车道；依赖 P2 + PM）

- 改：`composables/usePreview.ts`（open 清栈；navigate / back / up；fetch 带 `dir`；dir 相；栈上限 64）、`composables/usePreviewProbe.ts`（透传 `dirs`）、新增 `components/preview/PreviewDir.vue`（行用原生 `<button>`；名称用 `<bdi>` 且 `translate="no"`；`.is-dot`；按 `limits` 选提示文案；静态脚注「受保护条目不显示」；显示 vanished/dropped/statPartial 提示；无 innerHTML）、`components/preview/PreviewHost.vue`（dir 分支、返回 / 上级、子树 provide 覆盖、焦点处理）、`i18n/{zh,en}/preview.ts`、`styles/preview.css`。
- 测：`use-preview.test.ts`、`use-preview-probe.test.ts`、`preview-host.test.ts`（含 md 内路径 navigate 后可返回）、新增 `preview-dir.test.ts`、`preview-probe-path-text.test.ts`、`i18n-parity`、UI `source-scan`。
- 冻结面：`logic/**`、`PathText.vue`、`PreviewText.vue`、hub、protocol。验收：`npx vitest run tests/web-hub/ui && npm run typecheck && npm run build:web`。

### P4 · 集成 + 文档（小，L1）

- `tests/web-hub/http/preview-e2e.test.ts`：cwd 外文件；目录 → 子文件；`.ssh` 不出现在清单中，直接 GET ⇒ 403；gzip 下 JSON 解码；`/proc/self/environ` ⇒ 403；symlink home 下 `auth.json` 两种表示都 403。
- 文档：`plan.md` 追加修订节（U4 安全边界声明原文，§2.7）；`acceptance.md` 追加 E/D/M 系列和发布前 denylist audit 步骤；`AGENTS.md` web-hub「Content preview」段落改写（边界声明、denylist 维护规则、`dir=1` / caps、md 渲染）。
- 验收：`npm test && npm run typecheck && npm run build && npm run build:web && npm run format:check`。

---

## 6. 真机验收（追加到 acceptance.md）

- **E1** cwd 外的 `/etc/hostname`、`/tmp/x.log` 可点并能预览；`/etc/shadow`、`~/.ssh/id_ed25519`、`/proc/self/environ` 保持纯文本，直接 GET 返回 403。
- **E2** 手机 LAN（`mode:on`）同 E1；`mode:"loopback"` 时手机端全部是纯文本。
- **E3** `/reload`、`/help` 不会被标成路径。
- **E4（oracle 与审计）** 在 LAN 上依次请求一个不存在的路径、一个字面 denylist 路径、一个不可读文件，确认分别得到 404 / 403 denylist / 403 unreadable（这是有意保留的区分，§2.8）；打开一个含 `.ssh` 的目录，清单和计数中都看不到它；hub 日志中这些请求的审计行不含任何路径或文件名。
- **E5** uid 0 告警：普通用户运行时日志中没有 `preview.root_uid`（root 场景由自动化覆盖，真机不要求）。
- **D1** 绝对目录路径（含尾斜杠写法）可点 ⇒ 清单（目录在前，dotfiles 置灰）。
- **D2** ToolCard 里的 `"path": "src/components"`、用户气泡和助手消息里的 `` `src/components` `` 都可点；散文里的 `and/or` 不可点。
- **D3** 下钻 → 打开文件 → 返回 → 返回；「上级」可以走到 `/home`，之后置灰。
- **D4** 2 万文件的目录：显示「只读取了前 10 000 项」，本地盘 < 1 s。
- **D5** 浏览 `~`：没有 `.ssh/.gnupg/.env`，也没有它们的计数，只有静态脚注。
- **D6** 旧标签页（hub 升级前加载）：目录仍为纯文本，没有错误面板。
- **D7** 名字很长的目录显示「名字过长，只显示前 K 项」。
- **M1** 打开 `README.md` 默认渲染（表格、任务列表、围栏代码高亮）；切到源码是 markdown 高亮；关闭后重新打开仍是渲染。
- **M2** 在 md 里点击引用的源码路径 ⇒ 对话框内打开 ⇒ 「返回」回到渲染视图。
- **M3** 300 KiB 的 md：截断徽标 + 「结尾可能不完整」，没有残缺的半行。
- **M4** md 里的 `<script>`、`![img](x)`、`[a](javascript:…)` 都以字面文本显示。
- **M5** 病态 md（`"*a ".repeat`，约 250 KiB）打开时界面不卡顿（< 0.5 s 出结果，或降级为源码并给出提示）。
- **发布前** 运行 `node scripts/dev/preview-denylist-audit.mjs`，人工确认没有需要补的规则。

---

## 7. 风险清单

| #   | 风险                                                                            | 等级             | 缓解                                                                                         |
| --- | ------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| R1  | U4 + 目录浏览：已认证的 LAN 端可以读取和浏览 hub uid 可读的所有非 denylist 文件 | 高（已拍板接受） | §2.7 边界声明；denylist 扩充 + 字面/realpath 双查 + home 规范路径；`"loopback"` 一键关闭 LAN |
| R2  | denylist 不完整                                                                 | 中（残余）       | 版本号 + 语料回归 + 发布前 audit 脚本 + 维护规则（§2.7）；OS 权限作为第二道防线              |
| R3  | 挂死的 NFS/autofs 拖垮线程池                                                    | 中               | tracker 熔断（§2.4）；probe 中降级为 missing                                                 |
| R4  | findPathRefs 或 markdown 解析器二次方退化                                       | 高（若漏做）     | §2.5.2 与 §4.2 都有可证明的线性算法 + 固定规模的基准与增长判据 + 差分测试，列为硬验收        |
| R5  | 目录响应过大                                                                    | 低               | 三重上限 + 服务端断言 + 客户端有上限读取 + parser 聚合检查                                   |
| R6  | dir handle / fd 泄漏或 close 挂起                                               | 中               | §3.3 有界 close + 迟到回收 + tracker + 固定释放顺序 + 专项测试                               |
| R7  | 以 root 运行                                                                    | 中               | 一次性稳定事件告警；系统级 denylist                                                          |
| R8  | 存在性 oracle                                                                   | 低（已接受）     | §2.8：GET 保留区分；目录清单和 probe 折叠                                                    |
| R9  | 没有 /proc 的平台                                                               | 低               | fail-closed（§3.6）                                                                          |
| R10 | 版本错配                                                                        | 低               | opt-in + cap 门控                                                                            |
| R11 | 冻结用例被破坏                                                                  | 中               | 新规则全部由作用域标志门控；admit 中 `outside` 行的变更逐条注明 U4                           |
| R12 | probe 流量 / LRU 抖动                                                           | 低               | 批次 100 条；斜杠命令不成候选；验收时观察                                                    |

## 8. 不做（v1 范围外）

目录分页、过滤、重排；PathText 对目录 ref 显示文件夹图标；列出 `/`；没有 /proc 的平台上的目录列举；md 相对路径按文档所在目录解析；md 图片；file-search 范围放宽；按 listener 区分的范围开关；`UV_THREADPOOL_SIZE` 调整。

---

## 10. 评审处置表（第一轮，7 Major / 6 Minor / 1 Nit）

| #   | 严重度 | 处置                                                                                                                                                                                                                                                                                                                                           | 落点                        |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | Major  | **修**：启动时解析 home/agentDir 的 literal + canonical（`resolvePreviewDenyContext`，失败时降级并写稳定 WARN）；`denyListHit(p, ctx)` 对两种表示都检查；pi 相关规则同时改写为不依赖 home 的连续子路径规则；新增 symlink home、`PI_CODING_AGENT_DIR` 自定义、第三方链接、ctx 降级的真实 tmpdir 用例                                            | §0.1 C3、§2.3、§2.6、P1a    |
| 2   | Major  | **修**：新增 `PREVIEW_DIR_BODY_MAX_BYTES = 512 KiB` 与 `NAME_MAX_BYTES = 1 024`；截断优先级固定为 scan → filter → entries → bytes；定义 `limits` / `total` / `complete` / `truncated` 的语义和对应 UI 文案；服务端按条累加序列化字节并在发送前断言；客户端有上限读取 body；parser 带 `byteLength` 做聚合检查；删除「最坏约 300 KiB」的错误估算 | §1.1、§3.2、P0/P1b/P2 测试  |
| 3   | Major  | **修**：逐操作给出 step / 请求 deadline、abort、迟到处理表；close 用独立的 1 s 上限，不受请求 abort 影响，超时计入 tracker，迟到后回收；封装内部把 close 串行化在在途读之后；⑩ 释放顺序固定为 应答 → 有界 close → 名额 → active → 审计；补「close 永不 settle」「dispose 期间 close 迟到」「close 排在在途读之后」等测试                       | §0.2 A8、§3.3、P1b          |
| 4   | Major  | **修**：tracker 封装为单一原语，给出 running → abandoned → settled 一次性状态机、`done` 标志防重、同步抛错与 lazy 未调用时不计数、实例归属与 `/reload` 后归零、全部调用点和未纳入的调用点（附理由）、与线程池其他使用者的关系；补慢 promise、并发超时、重复 abort、reject 分支、新实例等契约测试                                               | §2.4、P1a                   |
| 5   | Major  | **修**：给出不变量 I1–I3、「run 内终点 P 相同」的引理，从而 `lastBad`/`lastNul`/`secondLastSlash`/`minStart` 都是 run 级常量；给出伪代码与复杂度论证；验收固定 64 KiB / 1 MiB / repeat(1e5) 等输入，给出毫秒上限和增长比判据；保留拼接恒等测试、旧负例、Unicode 用例，并新增对比朴素参考实现的差分性质测试                                     | §2.5.2、P2                  |
| 6   | Major  | **修**（并澄清）：markdown 上下文中反引号 span 本来就走 `pathRefOfCode`，不需要起点上下文；非 markdown 上下文在 dirs/abs 作用域下新增扩展起点集（含反引号），成对规则扩展到反引号；补成功、散文误报、带/无扩展名、行列号后缀、旧作用域不变等测试                                                                                               | §0.2 A5、§2.5.3、P2         |
| 7   | Major  | **修**：显式写出安全边界与残余风险声明；denylist 带版本号与维护责任；新增必拒/必放语料与版本一致性测试；新增发布前只读 audit 脚本并纳入验收流程                                                                                                                                                                                                | §0.1 C10、§2.7、P1a、P4、§6 |
| 8   | Minor  | **修**：给出 oracle 处置表，GET 保留区分（有意行为），probe 与目录清单折叠（删除 `hidden.denied` 计数，改为静态脚注）；LAN 验收新增 E4（oracle 与审计）                                                                                                                                                                                        | §2.8、§3.2、§6 E4           |
| 9   | Minor  | **修**：明确为准入 8 s **加** 列举 5 s 的独立追加，服务端 ≤ 13 s；新增与客户端 40 s 超时的关系钉；给出错误码与 dispose 验收                                                                                                                                                                                                                    | §0.2 A7、§3.4               |
| 10  | Minor  | **简化修**：没有 /proc 的平台 fail-closed（不声明 cap，目录仍 415），不实现按路径列举的退化方案；理由与测试已写明                                                                                                                                                                                                                              | §0.2 A6、§3.6               |
| 11  | Minor  | **修**：把 `parseInline` 的失败搜索改为摊还线性（失败位置 memo，并论证输出不变）；新增 AST 节点预算与源码降级；固定 256 KiB 病态输入基准 + 增长判据 + 新旧实现差分测试，列入 PM 包的硬验收                                                                                                                                                     | §0.3 B7、§4.2、§4.3、PM     |
| 12  | Minor  | **修**：probe 请求/应答体、响应 kind、目录 listing 都作为共享协议类型；hub 用类型化发送器包住 `sendJson`；新增类型级（`types.test-d.ts`）和运行时（hub 输出 ⇄ UI parser）契约测试；更新端口注释                                                                                                                                                | §1.1、§1.3                  |
| 13  | Minor  | **修**：定义事件名 `preview.root_uid`、日志字段、启动时机、每进程去重、`getuid` 注入点；补 4 个测试；真机验收确认告警中无路径或凭据                                                                                                                                                                                                            | §2.9、§6 E5                 |
| 14  | Nit    | **修**：cap 注释写明由同一 feature gate 同步声明、不是独立开关                                                                                                                                                                                                                                                                                 | §1.2                        |

### 第二轮定向修订（4 条，全部闭合）

| #   | 原严重度 | 处置（第二轮闭合）                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 落点       |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Major    | 定稿接口：`createFsAdmitter` 完整签名 + 错误码表；调用方迁移表逐行列出（旧接口**删除不留别名**，理由 + 编译验收：typecheck 绿 + source-scan 禁止 `CwdAdmitter` 字样回归）；`denyListHit(p, ctx)` 输入语义（两阶段传同一规则集、ctx 数组覆盖 literal/canonical 四种组合、全局孪生不变量）；realpath 失败两类确定行为（启动降级由孪生兜底 + WARN；请求时 fail-closed 到 step 4，无 rp 绝不 open）                                                                                                | §2.1       |
| 4   | Major    | 定稿签名：`racePreviewIo` 第 5 参可选 tracker、`previewFsStep` 的 `opts.tracker` **必填** + `NO_TRACKER` 哨兵；8 行调用点参数流转表（含 boundedClose 的独立 1 s deadline 与 signal 例外、启动期独立 tracker）；计数归属原则（每次竞速只计自己的 promise，回收 close 不代管、新回收 I/O 自己开新竞速）；「禁止绕过」= 类型层必填 + source-scan 三条规则（哨兵白名单 / previewFsStep 实参含 tracker / racePreviewIo 显式传）                                                                     | §2.4       |
| 5   | Major    | 完整可复制的伪代码（调用级 / run 级 / 候选级三层，`P` 的推导、`lastBad`/`lastNul`/`secondLastSlash`/`minStart` 的精确状态转移、相对候选的 `seg0ok/shape/dirsEx`）；等价性论证覆盖 abs/cwd/uploads 三路由与现状快速路径（`dirs=false` 时 P ≡ 现状 pathEnd ⇒ legacy 输出深相等）；正确性门改为差分测试为主（legacy 对旧实现逐字节相等、abs/dirs 对朴素 oracle 相等、固定 seed 2 000 例）；性能验收改为机器无关操作计数（`charScans ≤ 10n + 10 000`、增长比 ∈ [8,24]），绝对毫秒仅留 5 s 卡死哨兵 | §2.5.2     |
| 12  | 契约项   | `PreviewProbeKind`（含 `"dir"`）唯一来源 = `protocol/preview.ts` + `PREVIEW_PROBE_KINDS` 元组；三层同步（类型 import 链 / `types.test-d.ts` 类型契约 / hub 输出 ⇄ UI parser 运行时契约）；`dirs` 缺省收到 `dir` ⇒ probePost 单点折叠为 `missing`（理由：条目级错配不应整批降级，且对该客户端点击确实不可能成功），fetch 路径仍 `E_BAD_RESPONSE` 并说明差别；旧 parser 迁移 = typecheck（含 vue-tsc）+ UI source-scan 两条规则的编译验收                                                        | §1.1、§1.3 |

**主会话裁定申请：无**（第一轮 14 条 + 第二轮 4 条全部在方案内闭合；#10 采用评审允许的「简化方案」处置）。

---

## 11. 落地修订记录（P0–P4 合入后由 P4 追加；只增不改）

> 本节是收尾包（P4 集成 + 文档）落下的永久记录：上文 §0–§10 是评审定稿文本，一字未动。
> 内容：U4 安全边界声明原文存档、各包落地时的裁定缝隙 / 打回修复 / 偏离裁定的最终形态，
> 以及 P4 本包的落地摘要。各包提交：P0 `72c777e` · PM `65708f1` · P1a `ebc8f22` · P1b `deeed44` ·
> P2 `bf3cd2b` · P3 `83d6fc0` · P4 本包。注意上表按包号排列，**实际合入顺序**是
> P0 → PM → P1a → P2 → P3 → P1b（P1b 因 §11.3 的打回修复最后合入；P2/P3 与 P1b 的文件域
> 互斥，次序交换无影响）。

### 11.1 U4 安全边界声明（原文存档，§2.7 / §0.1 C10）

> 「web-hub preview 允许已认证用户（含 LAN，U1）读取 hub 进程 uid 可读、且未命中 denylist
> 的任意文件，并浏览目录。denylist 是**尽力而为的凭据黑名单**，不是白名单边界；它不完整
> 是**已知的残余风险**（例如未知应用的 token 文件、浏览器以外的 cookie 库）。需要更严格
> 时，使用 `webHub.preview:"loopback"` 或 `"off"`。」

同口径的 C10 存档：已认证用户（含 LAN）可读取 hub 进程用户能读到、且未命中 denylist 的任何
文件，并能浏览目录；路径存在性 / 类型可被推断（oracle 规则见 §2.8）。**这是 U1/U4 有意接受
的边界，不是防线遗漏。** 声明已同步写入 `AGENTS.md` 的 web-hub「Content preview」段与
`acceptance.md`（E4 判读口径）。

### 11.2 P1a 裁定缝隙 — `file-search.ts` 的 `NO_TRACKER` 3 行

§2.4 把 `previewFsStep` 的 `tracker` 定为必填后，遇到方案迁移表漏列的调用方：`file-search.ts`
（§2.1 迁移表标「不动」——它只 import `isVirtualFsPath`，不是 admitter 调用方，但 P1a 重构
`fs.ts` 后它调用的辅助函数签名带上了必填 tracker，编译不过）。**主会话裁定**（2026-10-08
amendment）：允许 `file-search.ts` 增加 3 行功能代码（`NO_TRACKER` import + 两个调用点显式传
`tracker: NO_TRACKER`），file-search 本身**仍不纳入熔断**（§2.4 未纳入清单原文有效：独立端点、
cwd 范围）；§2.4 source-scan 规则 2 的 `NO_TRACKER` 白名单因此加上该文件。Verifier（r_W9MA2SJE）
报告的第 8 条（file-search diff 体积超出冻结面预期）由主会话裁定接受。

### 11.3 P1b 打回修复 — statPartial 扇出守卫

首版实现的 lstat 阶段在预算耗尽后仍会发出新的 lstat（只在结果上标 `statPartial`）——verifier
（r_AEFZ6XMD）以 §3.2 伪代码不变量「deadline/busy ⇒ **停止发起新的 lstat**」打回；修复 run
（r_Q70W7ZN8）落下守卫 + mutation-tested 回归测试，主会话复跑全量绿。最终形态：deadline 耗尽
或熔断 ⇒ 不再发起新的 lstat，剩余条目保持 dirent 类型并标 `statPartial:true`——与 §3.2 原文
逐字一致，本条仅为存档（实现无偏离）。

### 11.4 P2 偏离裁定的最终形态（verifier r_YF3TG06H conditional pass，四条全部裁定接受）

四条偏离均由主会话裁定接受；落地记录（提交 `bf3cd2b` + 代码注释）可确证其中三条的最终形态：

1. **`PreviewDirOutcome` 过渡别名 + fetch 返回型两步翻转**：P2 的逻辑 client 运行时已能返回
   dir 变体，但 `PreviewOutcome` 保持 file-only（其唯一消费者 `usePreview` 当时冻结、只能窄化
   `kind !== "text" ⇒ image`）；P2 先定义 `PreviewDirOutcome = PreviewOutcome | {ok;kind:"dir";
listing}` 作为类型化过渡点，P3 重写 `usePreview` 时把 `fetch` 的声明返回翻转为它——两步各自
   有契约测试钉住，不存在无人看守的窗口。P3 如约落地（`PreviewTransport.fetch()` 返回
   `PreviewDirOutcome`）。
2. **`PreviewHandle` 的 `navigate`/`back`/`up` 成员提前到 P2 落型**（全部可选，冻结类型约定）：
   让 contract（`types.test-d.ts`）在 P2 就钉住 P3 组件要消费的面，而不是 P3 再改一次类型。
3. **`tsconfig.typecheck.json` 追加 `@protocol/*` paths 别名**（additive；生产 pass 与 Vite 构建
   不动）：contract pass 要解析 transport → protocol 的 import 链，而它不跑 Vite 的 alias 解析；
   代价（该 pass 因此能见到 DOM `Blob`/`AbortSignal`）由注释写明——src 误用 DOM 类型仍被第一道
   （无 DOM 的）pass 拦住。

第四条偏离同属该次裁定接受集，未单独改代码路径（见 P2 提交信息「all four reported deviations
adjudicated accepted」）。

### 11.5 P3 偏离裁定的最终形态（verifier r_AF3WXAN1 10/10，无打回）

P3 实现与 §5 P3 清单一致，两处「实现优于清单」的最终形态存档：

1. **目录判定零额外往返**：`usePreview` 直接用 probe 的 `kindOf(path) === "dir"` 决定 `dir=1`
   opt-in（probe 已确认候选，不再多打一 shot）；无 probe / kind 过期时的兑底是一次性的
   `415 not-regular ⇒ 带 dir=1 重取`（真非常规文件两次 415 后进错误相，不会循环）。
2. **`back` 零重取**：navigate 压栈的是快照，back 弹栈后字节级还原当前视图，不重新 fetch；
   在途加载在 back 时 abort。

### 11.6 P4 本包落地摘要

- **`tests/web-hub/http/preview-e2e.test.ts`**：在 PV7 同一 harness（真 hub / 真 tmpdir / 真
  socket agent）上追加 §5 P4 清单六例——cwd 外文件（`/etc/hostname` 与 home 外的兄弟 tmpdir）
  200；HTTP 级下钻链（`dir=1` 拿清单 → 子目录再列 → 取其中文件 200，含无 opt-in 时 415 逐字节
  不变）；`.ssh` 不在清单也不计数（`scanned=3 / total=2` 钉住「读到了但被过滤且不计数」）且直接
  GET ⇒ 403 denylist；gzip 下 ≥2 KiB 清单 `Content-Encoding: gzip` 且 gunzip 后过
  `parsePreviewDirListing`，无 offer 时逐字节 identity；`/proc/self/environ` ⇒ 403 virtual-fs
  （零 fs 字面步）；symlink home 下 `auth.json` 字面（经链接）与 realpath（直写）两种表示都
  403，且同 home 下良性 realpath 文件 200 作对照。kit 局部扩展：`preview(dir:true)` 拼
  `&dir=1`；`symlinkHome` 变体（`config.home` 本身是符号链接，realpath 树由 close 一并清理）。
- **`docs/dev/web-hub-preview/acceptance.md`**：追加 §7 ——E/D/M 系列真机步骤（§6 全文展开）
  与发布前 denylist audit 步骤。
- **`AGENTS.md`**：web-hub「Content preview」段改写——边界声明（U4 + 防线清单）、denylist
  维护规则（版本号 + 语料 + 发布前 audit）、`dir=1` / 双 cap / fail-closed、md 默认渲染 + 切换、
  目录下钻。
- 验收：`npm test` / `typecheck` / `build` / `build:web` / `format:check` 全绿（见提交信息）。
