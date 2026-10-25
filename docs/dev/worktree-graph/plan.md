# web-hub「worktree 面板 · git graph」施工方案（worktree-graph plan v2 · 评审第一轮修订）

> 范围：web 详情头 worktree 面板（`WorktreePanel.vue`）的 worktree 列表下方，加一个默认折叠、展开时按需拉取的 VS Code「Git Graph」风格提交图：
> 左侧彩色 lane（竖线、提交点、分叉/合并弧线），每行一个提交：ref 芯片（本地分支 + 附着 `origin` 段、`origin/HEAD`、tag）+ subject；merge 行变暗；
> 右侧列：绝对日期（`23 Sep 2026 09:55`）、作者、短 hash；当前检出提交高亮。参考稿 `~/snap/chromium/common/pwh-gitgraph/varA.html`（**merge 行按用户要求变暗**，与稿中加粗相反）。
> **v2** = v1 + 评审（2 Blocker / 9 Major / 3 Minor）处置 + 用户裁定，见 §0.2 与末尾处置表 §11。基线 HEAD `d19ade5`。

## 0. 结论与裁定

### 0.1 决策速览

| #   | 题目      | v2 拍板                                                                                                                                                                                      |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 数据通路  | hub 侧端点 `GET /api/worktree-graph`，复用 wtdiff membership + 三 fd 钉住 + `envPolicy:"minimal"`；cap `wtgraph.v1` 与 `wtdiff.v1` 同门                                                      |
| G2  | git 命令  | **两条**钉住命令：Gr 一次有界 `for-each-ref` 快照 → 去重、类型校验的显式 commit tips → Gl `log --date-order <tips…>`（**不再解析任何 ref**）；全部带 `--no-lazy-fetch`，不支持即 fail-closed |
| G3  | 条数      | **固定 N=200**，无「加载更多」、无分页缓存、**无默认序回退**（date-order 超时 ⇒ 可重试 504）；协议留 `n` 字段供以后扩展，v1 不规定分页                                                       |
| G4  | lane 布局 | `ui/src/logic/gitGraph.ts` 以「边」为单位路由（每条父边一条 path），上界按 N、E 推导；超出可见 lane 用**折叠标记**，绝不画成连通 lane                                                        |
| G5  | UI        | 面板内二级折叠区，默认折叠、不记忆；独立有界滚动视口；row pitch 随字号缩放且 SVG 按实测行中心对齐；组件 + 布局逻辑在懒 chunk                                                                 |
| G6  | 预算      | 合并时按实测 main / 懒 chunk / 总 gzip 三项定 JS 预算（不预写数字）；响应 ≤512 KiB；时间按 §2.4 逐步总账                                                                                     |

### 0.2 用户裁定 2026-10-10（逐字记录）

- **Q1 LAN**：LAN has the same access as loopback, gated by the existing `webHub.preview` (`"loopback"` turns it off for LAN).
  暴露面（精确）：up to N commits' subjects, author names, author times, hashes, ref names across local branches / remote-tracking branches / tags /
  detached worktree HEADs; no dedicated email field collected, no file contents read; free text (subjects, author names, ref names) MAY itself contain
  emails/paths/secrets — residual accepted by the user (sole LAN user, password auth, U1 precedent).
  - **2026-10-25 补充裁定**：允许 Gm 读取对象内容计算 patch-id（已中和，见 `merged-plan.md` r3）；上文「no file contents read」原文不改，Gm 是唯一例外。
    补注：`wtHeads[].path` 是 worktree 绝对路径，与 `StatusInfo.worktrees` 已广播的同一资产（worktree-web Q1），非新增。
- **Q2 refs**：local branches + remote-tracking branches + tags + detached worktree HEADs (no `--all`, no stash/notes).
- **Q3 mobile (≤480px)**：up to 4 lanes + subject + short hash.
- **Q4**：expansion state not remembered; default collapsed.

## 1. 现状与约束（引用已逐条核对）

- 面板：`components/detail/WorktreePanel.vue:68` `const open = ref(false)`；列表 `:279-351`；wtdiff scope `ui/src/logic/wtdiff.js:85`（无 cap ⇒ DOM 逐字节回落，I8）；挂载 `DetailHeader.vue:280`。
  `.wt-list` 有界滚动先例 `styles/worktrees.css:60-69`（`max-height: min(40vh, 320px)`、无 `overscroll-behavior: contain`）。
- 主题：`styles/tokens.css` 三处——`:root`（light，`:27-56`）、`@media (prefers-color-scheme: dark) { :root:not(.theme-light) }`（`:148-149`）、`:root.theme-dark`（`:212`）。
- 字号：`composables/useFontScale.ts:21-22`（80%–300%，写 `--fs-scale`）；`.btn` `min-height: 32px`（`styles/primitives.css:13`）；`CopyButton.vue:70` 用 `.btn btn-icon`。
- status：`StatusInfo.worktrees`（`protocol/messages.ts:182/330`），行 `head` 仅 7 位（`agent/worktrees.ts:94`），故不可用于精确匹配。
- wtdiff 先例：`hub/worktree-diff/membership.ts:62/256`（成功 `{ok, W, pinSet}`）、`:147`（C1 完整 porcelain rows）；`git.ts:126` `WtGitCmd`、`:147-160` `classify`（overflow ⇒ `capped`）、
  `:228-270` `createPinnedGit`（**每条命令 spawn 前一次 ≤2 s 的三 pin fstat**）；`changeset.ts:95` `SingleFlightCache`；`routes.ts:234` `wtCsrfOk`；
  `protocol/worktree-diff.ts:76/91/94/97`（ADMIT 8 s / CLOSE 1 s / TRANSFER 10 s / CLIENT 35 s）；装配 `hub.ts:307/868/911/929/1345`、`http.ts:1379-1401/2712-2731`、`ports.ts:630/731`、`audit.ts:506`；
  boundary `tests/web-hub/boundary.test.ts:26`（hub 只可 import `src/git/{run,worktrees,diff}.ts`，闭包常量表）。R11 规则 `AGENTS.md:420-425`；驱动正则 `src/git/diff.ts:203/292`。
- `src/git/run.ts:54-66` minimal env（无 `GIT_NO_LAZY_FETCH`）——lazy fetch 必须由 argv 关闭。
- UI 预算 `scripts/web-hub/check-ui-dist.ts:69/183`（所有 chunk 合计）；CSP `style-src 'self'`（`hub/http.ts:138`），`:style` 对象绑定先例 `QuotaCard.vue:223`。

## 2. hub 侧设计

### 2.1 数据通路（同 v1 结论）

(a) agent cmd 通道：需新 `CmdOp` + agent cap + 两跳超时 + 旧 agent 不可用 + 继承环境；(c) `StatusInfo`：200 提交远超 16 KiB 槽、广播放大——均否。
**(b) hub 端点**：零 agent 改动、复用已过 H1–H5 闸门的准入/钉住/环境/审计。离线 agent 同 wtdiff（registry + sessionId 匹配即服务）。

### 2.2 git 命令（冻结 argv，`src/git/graph.ts` 的 `wtGraphArgs` 产出，单测逐字节钉）

`GB = PINNED_PREFIX + --no-lazy-fetch --no-replace-objects --no-pager -c core.hooksPath=/dev/null`（run.ts 另前置 `--no-optional-locks -c core.fsmonitor=false`）。

| #   | 用途      | argv                                                                                                                                                                                                                                              | 上限                                         |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Gr  | refs 快照 | `GB for-each-ref --count=2001 --format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(symref) refs/heads refs/remotes refs/tags`                                                            | 2 s；stdout `WTGRAPH_REFS_MAX_BYTES` 256 KiB |
| Gl  | 提交      | `GB -c log.showSignature=false -c log.mailmap=false -c i18n.logOutputEncoding=UTF-8 log --no-show-signature --no-use-mailmap --no-notes --no-decorate --no-color --date-order -z --max-count=201 --format=%H%x1f%P%x1f%an%x1f%at%x1f%s <tip…> --` | 6 s；stdout `WTGRAPH_LOG_MAX_BYTES` 512 KiB  |

- **tips（#3）**：只来自 Gr 这一份快照 + membership 已跑的 C1 porcelain：`objecttype==commit` ⇒ `objectname`；`objecttype==tag && *objecttype==commit` ⇒ `*objectname`（2.53 实测嵌套 tag 也全剥到 commit）；
  其它类型 / 非法 oid / 长度与仓库格式不一致 / ref 名 >200 B ⇒ 不进 tips、计 `refsSkipped`；symref（`origin/HEAD`）只作芯片不作 tip；再并入本 worktree HEAD 与其它 worktree 的
  detached HEAD（porcelain `HEAD <oid>`，全零 = unborn 跳过，≤32 个，超出 `wtHeadsCapped`）。去重后 ≤ `WTGRAPH_TIPS_MAX`=2048，作为 Gl 的显式参数——Gl 不含 `--branches/--remotes/--tags/HEAD`，
  因此「快照 → 日志」严格一致，Gr 之后 ref 移动只会让结果略旧，不会错配。tips 为空 ⇒ 不跑 Gl，200 空图（`empty:true`）。
- **快照截断（#3）**：for-each-ref 按 refname 排序 ⇒ heads → remotes → tags；行数 >2000 或字节截断 ⇒ 只用完整行，`refsTruncated:true`（遍历范围缩小为这些 refs 的可达集），UI 显示降级。
- **格式**：仓库对象格式取 tips 的 oid 长度（40|64）；混长 ⇒ 少数派丢弃计 `refsSkipped`。HEAD 取自 membership 的 porcelain 自身行（仅决定「当前」高亮，与 Gr 有毫秒级时差、只影响外观）。
- **浅克隆**：不 spawn——hub 在 `/proc/self/fd/<common.fd>/shallow` 上一次 `previewFsStep` stat（ENOENT ⇒ 非浅），同 membership 读 `worktrees/<name>` 的手法。
- **字段与隐私措辞（#10）**：格式串冻结为 `%H %P %an %at %s`——**不采集专用 email 字段**（无 `%ae/%ce/%cn/%b/%N/%G*`），**不读取任何文件正文**（唯一例外：Gm 的 patch-id 判定读对象，见 `merged-plan.md` §5）；自由文本可能自带邮箱/路径/秘密，属 §0.2 已接受残余。
  解析 `parseGraphLogZ`：NUL 切记录、前四个 `\x1f` 切字段、余为 subject；h/p 须为同格式 hex、t 非负整数，否则丢弃计 `badRecords`；subject ≤200 B、作者 ≤64 B（`truncateText`），C0 控制符 → U+FFFD；父 >8 截断并标 `pT`。
- **date-order 正确性（#5）**：无回退；`--date-order` 保证集内任何父都排在其所有子之后（拓扑约束），布局测试逐条核验（§3.4）。
  巨型仓库无 commit-graph ⇒ 6 s 超时 ⇒ 504 `E_DEADLINE{reason:"log-timeout"}`，UI 提示「可运行 `git commit-graph write` 后重试」。

### 2.3 执行面 / 读取面矩阵（#2 #12）

| 面                                          | Gr   | Gl   | 关闭手段                                                                                         | 证据（git 2.53 本机实测）                                                                                                   |
| ------------------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| promisor lazy fetch → transport/ssh/helper  | 是   | 是   | `--no-lazy-fetch`（全局选项，git 2.45.0 引入，更早版本无 ⇒ 129 ⇒ fail-closed，禁止去掉选项重试） | 部分克隆夹具 + 恶意 `core.sshCommand`：未硬化 `for-each-ref` 剥缺失 tag 目标 ⇒ marker 2 次；硬化 ⇒ 0 次、exit 128 `bad tag` |
| gpg（`log.showSignature`）                  | 否   | 是   | `-c log.showSignature=false --no-show-signature`；不用 `%G*`                                     | 签名提交夹具 + 绝对 `gpg.program`：未硬化 ⇒ marker 1；硬化 ⇒ 0                                                              |
| mailmap 文件/blob 读取                      | 否   | 是   | `-c log.mailmap=false --no-use-mailmap`                                                          | P1 测试钉                                                                                                                   |
| replace refs / notes                        | 是   | 是   | `--no-replace-objects` / `--no-notes`                                                            | P1 测试钉                                                                                                                   |
| filter / textconv / attributes / 工作区读取 | 否   | 否   | argv 白名单：禁 `-p --stat --name-* -S -G --follow` 与 pathspec                                  | source-scan 钉 argv 只来自 `wtGraphArgs`                                                                                    |
| hooks / fsmonitor / pager                   | 否   | 否   | `core.hooksPath=/dev/null`、run.ts 前置、`--no-pager` + 无 PAGER env                             | P1 测试钉                                                                                                                   |
| 对象 / ref / index 写入                     | 否   | 否   | 只读子命令                                                                                       | 测试：`.git/objects` 文件清单、`packed-refs`、index 的 mtime/size 前后相等                                                  |
| trace2 目标（system/global 配置）           | 可能 | 可能 | 不处理（用户自有配置，同 wtdiff 残余）                                                           | 残余登记                                                                                                                    |

- **结果分类顺序（复审 #7）**：先看 runner 的 `capped`（stdout 撞上限时 `src/git/run.ts` 返回 `code:null`，`hub/worktree-diff/git.ts` 包装为 `capped:true, code:-1`）——Gl 撞上限 ⇒ 丢弃末条不完整记录，按 `logCapped` 降级照常返回 200；Gr 撞上限 ⇒ `refsTruncated` 降级。只有未 capped 时才按退出码分类如下；P1 测试钉真实 runner overflow → 完整记录保留 → 降级 payload。
- 缺失对象（硬化后）：Gr/Gl 非零退出，stderr 只做匹配不记录 ⇒ `missing-object`（503，可重试无意义，UI 文案说明部分克隆）；其它非零 ⇒ `git-failed`（500）；退出 129 ⇒ `git-too-old`（503）。
- **升级门禁（R11 式维护规则，写进 AGENTS.md）**：升级 git 基线或给 Gr/Gl 加任何参数时，复核 `git help config` 中这两个子命令新读取的、可执行外部程序 / 触发传输 / 写文件的键，
  在矩阵加行并补「未硬化对照 + 硬化」成对测试，重跑 `tests/integration/git-graph.test.ts`；**不得**为此放宽 `WTDIFF_DRIVER_NAME_RE` 或 Cc 正则（graph 不碰驱动，那是 wtdiff 的表面）。

### 2.4 时间预算逐步总账（#4）

准入阶段 A = `WTDIFF_ADMIT_MS` 8 s（membership 原样，含 LAN 认证预留，wtdiff §1.9 已证）。git 阶段 G = `WTGRAPH_GIT_PHASE_MS` = **14 s**，每步 `min(G.remaining, cap)`：

| 步  | 内容                                   | cap                     |
| --- | -------------------------------------- | ----------------------- |
| S1  | shallow stat（previewFsStep）          | 2 s（`WTDIFF_STEP_MS`） |
| S2  | createPinnedGit 三 pin fstat（Gr 前）  | 2 s                     |
| S3  | Gr                                     | 2 s                     |
| S4  | 三 pin fstat（Gl 前）                  | 2 s                     |
| S5  | Gl                                     | 6 s（`WTGRAPH_LOG_MS`） |
| —   | 解析 + 投影（同步 CPU，输入 ≤768 KiB） | 不计时，测试钉 ≤50 ms   |

关系钉（真实算术）：`4 × WTDIFF_STEP_MS + WTGRAPH_LOG_MS = 14 s ≤ WTGRAPH_GIT_PHASE_MS`（⇒ 各步总能拿到完整 cap，Gl 永不被前序挤压）；
服务端墙钟 `8 + 14 + WTDIFF_CLOSE_MS(1) = 23 s`，`23 + WTDIFF_TRANSFER_RESERVE_MS(10) = 33 ≤ WTGRAPH_CLIENT_TIMEOUT_MS(35)`。`budget.test.ts` 用假时钟让每步恰好用满 cap，断言 S5 仍拿到 6 s，
再让 S1–S4 各卡死，断言 S5 拿到的 = `min(剩余, 6 s)` 且总时长不超过 23 s。

### 2.5 并发、缓存、降级状态、字节预算（#7）

- 在途 per-principal 1 / global 2，自有 `createCmdLimit`：10 令牌、+1/500 ms。**仅单飞 join，不存储**（`SingleFlightCache` `store:false`，同 wtdiff C4），键 = `pin ids \0 sha256(sorted tips) \0 shallow`——Gl 是 tips 的纯函数，键与内容恒一致。
- 降级状态彼此独立（都在 payload，都在 UI 显示）：`more`（有效记录 >200，仅在未 `logCapped` 时可信）、`logCapped`（原始 stdout 撞 512 KiB，末条丢弃，「是否还有更多」未知）、
  `badRecords:n`、`parentsTruncated:n`（`pT` 提交数）、`refsTruncated`、`refsSkipped:n`、`refsOmitted:n`、`trimmed:n`、`wtHeadsCapped`。`complete` = 以上全无（`more` 除外，它只是「仅显示前 200」）。
- JSON 预算 `WTGRAPH_BODY_MAX_BYTES` 512 KiB 三段削：① 字段截断（已在解析）；② 超限按 tags → remotes → heads 逆序删 refs 计 `refsOmitted`（refs 先限 ≤400）；
  ③ 仍超限从尾部删提交计 `trimmed`。**每次删提交后重过滤** refs / wtHeads / head 到剩余提交集。最坏估算：201 × (65 + 8×67 + 330) ≈ 190 KB + refs 400 × 300 B ≈ 120 KB。

### 2.6 文件与装配

- **`src/git/graph.ts`（新，pi-free）**：`wtGraphArgs.{refs(), log(tips)}`（import `WT_PINNED_PREFIX` from `./diff.js`）、`parseForEachRefZ`、`tipsFromRefs`、`parseGraphLogZ`、`classifyGraphExit(code, stderr)`。
  boundary：`GIT_FILE_ALLOWLIST` 加 `graph`；闭包表加 `"src/git/graph.ts": [{ spec: "./diff.js", typeOnly: false }]`。
- **`hub/worktree-graph/project.ts`（新，纯）**：`projectGraph(...)` → `WtGraphPayload`（§2.5 状态与三段削）。
- **`hub/worktree-graph/routes.ts`（新）** `createWorktreeGraphRoutes`：⓪ closing ⇒ 503 → ① CSRF（复用导出的 `wtCsrfOk`）→ ② `io.authorize` → ③ 参数（agentKey/sessionId/wt 正则同 wtdiff）→
  ④ 限流 → ⑤ registry + sessionId → ⑥ `createMembership` → S1–S5 → 投影 → `sendJson`（gzip、`no-store`、CORP same-origin）→ finally `pinSet.release()`（单飞 `withLoan`）+ 审计；`dispose` ≤1 s 幂等。
- **wtdiff 文件仅追加**：`membership.ts:62/256` 成功分支加 `rows: readonly PorcelainWorktree[]`、`selfIndex: number`；`git.ts:126` `WtGitCmd` 加 `"Gr" | "Gl"`；`routes.ts:234` `export wtCsrfOk`。
- **装配**：`ports.ts` 加 `WorktreeGraphRoutes { mode; handle; dispose }` 与 `FrontendDeps.worktreeGraph?`；`http.ts` LAN 紧随 `:1379-1401`（仅 `mode==="on"`）、loopback 紧随 `:2712-2731`；
  `hub.ts:868` 之后同 `run`/`denyCtx` 构造，`:307` caps 加 `WTGRAPH_HUB_CAP`，`:911` 透传，`:929/:1345` dispose。无 `/proc` ⇒ 不构造。
- **审计**：`audit.ts` 加 `auditWorktreeGraph` + `WTGRAPH_AUDIT_KEYS` = `phase, listener, ip, user, agentKey, ok, code, reason, commits, refs, tips, complete, bytes, ms, joined, wtTag`；429 每 principal 60 s 一行。
- **D15 注记**：`docs/dev/worktree-web/plan.md` 末尾追加——hub 可执行 argv 扩到 Gr/Gl（同钉住、同 env、不读工作区）。

## 3. 协议（新 `src/web-hub/protocol/worktree-graph.ts`，P0 冻结）

```ts
export const WTGRAPH_PATH = "/api/worktree-graph"; // GET + X-PWH: 1；query: agentKey, sessionId, wt
export const WTGRAPH_N = 200;
export const WTGRAPH_PARENTS_MAX = 8;
export const WTGRAPH_SUBJECT_MAX_BYTES = 200;
export const WTGRAPH_AUTHOR_MAX_BYTES = 64;
export const WTGRAPH_REFNAME_MAX_BYTES = 200;
export const WTGRAPH_REFS_SCAN_MAX = 2000; // Gr --count=2001
export const WTGRAPH_REFS_MAX = 400; // payload
export const WTGRAPH_TIPS_MAX = 2048;
export const WTGRAPH_WT_HEADS_MAX = 32;
export const WTGRAPH_REFS_MAX_BYTES = 256 * 1024;
export const WTGRAPH_LOG_MAX_BYTES = 512 * 1024;
export const WTGRAPH_BODY_MAX_BYTES = 512 * 1024;
export const WTGRAPH_LOG_MS = 6_000;
export const WTGRAPH_GIT_PHASE_MS = 14_000;
export const WTGRAPH_CLIENT_TIMEOUT_MS = 35_000;

export interface WtGraphCommit {
  h: string;
  p: string[];
  pT?: true;
  a: string;
  t: number;
  s: string;
}
export interface WtGraphRef {
  k: "branch" | "remote" | "tag";
  n: string;
  h: string;
  up?: string;
  sym?: true;
}
export interface WtGraphWtHead {
  h: string;
  path: string;
  b?: string;
  self?: true;
}
export interface WtGraphDegrade {
  more?: true;
  logCapped?: true;
  badRecords?: number;
  parentsTruncated?: number;
  refsTruncated?: true;
  refsSkipped?: number;
  refsOmitted?: number;
  trimmed?: number;
  wtHeadsCapped?: true;
}
export interface WtGraphPayload {
  v: 1;
  n: number;
  format: "sha1" | "sha256";
  shallow?: true;
  empty?: true;
  head?: { h: string; b?: string }; // 缺省 = unborn
  commits: WtGraphCommit[];
  refs: WtGraphRef[];
  wtHeads: WtGraphWtHead[];
  degrade: WtGraphDegrade;
  complete: boolean;
}
export type WtGraphErrorReason = "log-timeout" | "missing-object" | "git-too-old" | "git-failed";
export function parseWtGraphPayload(raw: unknown): WtGraphPayload | null; // 键白名单 + hex/长度/上限 + complete 与 degrade 一致性
```

- `version.ts` 尾追加 `WTGRAPH_HUB_CAP = "wtgraph.v1"`（与 wtdiff 同条件，`hub.ts:307`）；无新帧、无 PROTO bump。错误码全部复用（`E_WTDIFF_DENIED/UNSUPPORTED`、`E_DEADLINE`、`E_INTERNAL` 等），`reason` 取上表。

## 4. UI 设计

### 4.1 布局算法（`ui/src/logic/gitGraph.ts`，纯、never throws；#5 #6）

```
layoutGraph(commits) → { nodes: {lane, color}[], routes: Route[], stubs: Stub[], laneCount }
  Route = { from: i, to: j, lane: k, color }   // 一条集内父边：从 (lane_i, i) 出发，在 lane k 里走 i+1..j-1，末端弧入 (lane_j, j)
  Stub  = { from: i, lane: k, color }          // 父不在集内（N 截断/浅克隆边界）：从 i 向下短虚线淡出
  lanes: ({ want: parentOid, color } | null)[]
  for row i, c:
    lane_i = 已在等 c.h 的最左 lane，否则最左空位（新色 nextColor++ % 8）；其余在等 c.h 的 lane 各成一条 Route 终点 = i，释放
    p0：集内 ⇒ lanes[lane_i] = {want:p0}（继承色）；集外 ⇒ Stub
    pk(k≥1)：已有 lane 在等 pk ⇒ 新 Route 汇入该 lane；集内 ⇒ 最左空位开新 lane（新色）；集外 ⇒ Stub
  Route 记录 {from, to, lane} 在登记与终结时写入；边色 = 父侧 lane 色（VS Code 一致）
```

- **上界（N=200、P≤8）**：集内父边 E ≤ N·P = 1600；任一行边界的活跃 lane 数 ≤ 跨越该边界的边数 ≤ E；布局时间 O(Σ 活跃 lane) ≤ N·(E+1)；SVG：圆 N 个、path = |routes| + |stubs| ≤ E + N·P，
  每条 path ≤ 3 段（起弧 / 直线 / 终弧）。测试用操作计数器断言 ≤ N·(E+1)。
- **折叠（#6）**：可见 lane 上限桌面 12、≤480px 4。lane ≥ 上限的点画在折叠列为**空心菱形** `gg-fold-node`；落在隐藏 lane 的 route 段不画，跨越可见/隐藏边界处画带箭头短桩 + 折叠列竖排 `⋮` 标记，
  **绝不画成连通竖线**；行内 sr 文本注明「位于折叠泳道」。
- **topo 验证（#5）**：测试对每条集内父边断言 `to > from`，且 route 端点真实落在 `nodes[from]` 与 `nodes[to]` 的 lane 上，中间段 lane 在 (from,to) 区间内无其它节点占用（无假连接）。
- `pathD(route, centers, laneX)`：用**实测行中心** `centers[i]`（§4.3），直线 `M…L`、弧线 `C`（控制点 `min(Δy/2, pitch/2)`）。

### 4.2 芯片、日期、匹配（#14）

- `refChipsOf(payload)`：本地 `X` 与同 oid 的 `R/X` 合并为「`X` | `R`」；否则远程单独描边芯片；`R/HEAD`（`sym`）小芯片；tag 带图标；当前分支加粗 + `HEAD`；detached ⇒ 独立 `HEAD` 芯片；每行 ≤3 + `+n`（`title` 全名）。
- **worktree 环按完整 oid**：`wtHeads[].h === commit.h`；label = `StatusInfo.worktrees.rows` 中 `path` 全等的行的 `label`，否则 `path` basename——不再用 7 位 `head`。
- `formatCommitDate(tSec, lang, parts?)`：en `23 Sep 2026 09:55`（固定月份表）、zh `2026-09-23 09:55`；本地时区，`parts` 可注入。作者时间 `%at`（VS Code 默认）。

### 4.3 组件与样式（#8 #9 #13 #14）

- **拆两层以守懒加载**：`ui/src/logic/gitGraphScope.ts`（极小：`wtgraphScopeOf`、`pickGraphWt`、`graphSigOf`）供面板（main chunk）；`gitGraph.ts`（布局/芯片/日期）**只被** `components/graph/*` import。
  `WorktreePanel.vue` 经自写 loader `loadGraph()`（失败时清空缓存的 promise ⇒ 可重试）+ `defineAsyncComponent` 挂载 `WorktreeGraph.vue`；加载失败显示错误态 + 重试按钮。
- **落位**：`.wt-list`（`:279-351`）之后、`<section>` 内、`open` 时：`<WorktreeGraph v-if="graphScope && graphWt" …/>`；无 cap ⇒ DOM 与今天逐字节一致（I8）。头部按钮 `graph · 200`（`aria-expanded`），默认折叠，不记忆（Q4）。
  `pickGraphWt` = `current` 行 `path` → 主 worktree 行 → null（隐藏）。展开才请求；折叠/卸载/scope 或 wt 变化 ⇒ abort；展开中 `graphSigOf(rows)` 变化 ⇒ 3 s 去抖重拉；重拉保留旧数据 + `aria-busy`。
- **视口（#9）**：`.gg-viewport { max-height: min(32vh, calc(var(--gg-row) * 12)); overflow-y: auto; overflow-x: hidden }`，沿用 `.wt-list` 不加 `overscroll-behavior: contain` 的裁定；
  表格 `table-layout: fixed; width: 100%`，subject/芯片列 `min-width:0` + 省略号，≤480px 无横向溢出。
- **行距与对齐（#8）**：`--gg-row: max(calc(22px * var(--fs-scale, 1)), var(--gg-row-min, 0px))`，`@media (pointer: coarse) { --gg-row-min: 32px }`；`tr { height: var(--gg-row) }`，所有单元格 `white-space: nowrap`。
  SVG 不假设行高：`ResizeObserver` 观察 tbody，读每行 `offsetTop + offsetHeight/2` 得 `centers[]`，lane 间距 = `round(pitch × 14/22)`、点半径同比——字号 100/200/300%、长 refs、粗指针下均按实测对齐。
- **复制控件**：不用 `CopyButton`（32px `.btn` 会撑破行）；hash 单元格本身是 `<button class="gg-hash">`（无 `.btn`，高度 = 行高，粗指针下行高 ≥32px 即命中区），点按 `useClipboard` 复制完整 oid，`useAnnouncer` 播报。
- **行结构**：`<table>` + `<caption class="sr-only">`；首个 tbody 行 `<td class="gg-lanes" :rowspan="n" aria-hidden="true"><GraphLanes/></td>`；列 lane | 芯片 + subject（`title` 全文）| 日期 | 作者 | hash；
  ≥768 全列，481–767 去作者，≤480 仅 lane(≤4) + subject（只留 HEAD/当前分支芯片）+ hash（Q3）。merge 行 `.is-merge`：subject `--c-text-3`、空心点；当前行 `data-current` 底色 + 外环；其它 worktree HEAD 虚线环 + 徽章。
- **读屏（#14）**：每行一个 `sr-only` 单元：「合并提交，父提交 abc1234、def5678」「当前检出」「worktree HEAD：<label>」「位于折叠泳道」「父提交在列表外」——不依赖 SVG 也能读出拓扑要点。
- **状态**：loading / ready / empty（仅 `empty && complete`）/ degraded（任一 degrade 标记：脚注逐项列出，**零提交但不完整时显示「已降级」而非「暂无提交」**）/ error（按 `reason`：log-timeout、missing-object、git-too-old、
  git-failed、not-worktree、session-changed、busy、chunk-load ⇒ 重试按钮）。常驻脚注 `200 commits · date-order · local refs, no fetch`，`more` 时「仅显示最近 200 条」。
- **样式与令牌**：新 `styles/graph.css`（`gg-` 前缀）；`tokens.css` 三个主题块都加 `--gg-lane-0..7`（线）与 `--gg-chip-fg-k/--gg-chip-bg-k`（芯片）；线对 `--c-surface` ≥3:1，**芯片文字对芯片底 ≥4.5:1**；lane 列宽 `:style="{ '--gg-w': px }"`。
- **i18n**：`i18n/{en,zh}/graph.ts`；紧凑 token 英文（`date-order`、`+3`、`HEAD`），提示/aria/sr 文本中文散文。

### 4.4 传输

`transport/types.ts` 加 `WorktreeGraphTransport { graph(req: WtDiffScope & { wt: string }, opts?): Promise<WtDiffOutcome<WtGraphPayload>> }` 与 `Transport.worktreeGraph?`；`token-client.js`/`password-client.js` 新 `wtgraphGet`
（复用 `wtdiffGet` `:1028`，上限 `WTGRAPH_BODY_MAX_BYTES`、超时 `WTGRAPH_CLIENT_TIMEOUT_MS`）；`transport/{token,password}.ts` 包装；`contract.js` `API.wtgraph`；`useHub.ts:115/791` 透传。

## 5. 预算（#13）

- JS：不预写数字。P5 合入前在合并基线上 `npm run build:web` 报告三项——main chunk gzip、`assets/WorktreeGraph-*.js` 懒 chunk gzip、总 gzip——三项及增量写进 `check-ui-dist.ts:69` 上方的 dated 注记，
  预算取「总 gzip 实测 + ≥4 KiB 余量」向上取整 KiB；**main 增量须 ≤1.5 KB gz**（只多 scope helper + loader），超出即说明布局逻辑漏进 main，打回。
- CSS：实测基线 23,109 B / 25,600 B；graph.css 实测后若超限同包上调并注记。
- 时间与字节见 §2.4 / §2.5。

## 6. 不变量

- **I1** 零 agent / `StatusInfo` 改动；无新帧、无 PROTO bump；无 cap ⇒ 面板 DOM 逐字节回落。
- **I2** 只读、不读工作区；对象内容只在 Gm 内读取且已中和（L1 + L2）；无 lazy fetch / transport / gpg / hook / pager；对象、ref、index 不写。
- **I3** 所有 graph git 走 `createPinnedGit`，argv 只来自 `wtGraphArgs`；请求派生值为零（`wt` 只进 membership；tips 来自 git 自己的输出且过 hex 校验）。
- **I4** Gl 的 tips 只来自同一请求的 Gr 快照 + porcelain；Gl 不解析 ref。
- **I5** 有界：§2.4 总账、stdout 上限、单飞、在途/令牌桶、响应 ≤512 KiB、渲染 ≤200 行 / 可见 lane ≤12。
- **I6** 审计只记白名单计数字段，永不记 subject / 作者 / ref 名 / oid / 路径。

## 7. 分包（文件域互斥）

```
Wave 1：P0 协议 ∥ P1 git 层    Wave 2：P2 hub（P0+P1）∥ P3 UI 逻辑（P0）∥ P4 UI 传输（P0）    Wave 3：P5 UI 组件（P3+P4）    Wave 4：P6 集成 + 文档
```

| 包                     | 文件域                                                                                                                                                                                                    | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 验收命令                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 协议（L1）          | 新 `protocol/worktree-graph.ts`；`protocol/version.ts`（尾追加）                                                                                                                                          | 新 `tests/web-hub/protocol/worktree-graph.test.ts`：parser 每条拒绝条件一例（未知键、hex 长度/格式不一致、t 非整数、超上限 ±1、`complete` 与 `degrade` 矛盾）；§2.4 两条关系钉（真实算术）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `npx vitest run tests/web-hub/protocol && npm run typecheck`                                                                                                                            |
| P1 git 层（L2）        | 新 `src/git/graph.ts`；`tests/web-hub/boundary.test.ts`                                                                                                                                                   | 新 `tests/git/graph.test.ts`：argv 逐字节快照（含 `--no-lazy-fetch` 等全部硬化项、格式串恰为 `%H%x1f%P%x1f%an%x1f%at%x1f%s`、无 `--branches/--all/HEAD`、tips 只为 hex）；`tipsFromRefs`（嵌套 tag、tag→tree、symref、混长 oid、去重、2048 上限）；`parseForEachRefZ`/`parseGraphLogZ`（截断末条、`\x1f`、控制符、非 UTF-8、父 >8）；`classifyGraphExit`。新 `tests/integration/git-graph.test.ts`（`skipIf(!hasGit)`，真实临时仓库：分支、merge、连续章鱼 merge、annotated/嵌套/轻量 tag、bare `origin`、linked worktree detached、浅克隆、sha256、unborn）：**§2.3 每行成对测试**——部分克隆夹具（`repositoryformatversion=1`、`extensions.partialClone=origin`、`remote.origin.promisor=true`、`url=ssh://example.invalid/x`、`core.sshCommand=<绝对路径 marker>`）删除父提交与 annotated tag 目标的松散对象：未硬化对照（从真实 argv 去掉硬化项）marker>0，硬化 marker=0、非零退出、`.git/objects` 清单与 refs/index mtime 不变；签名提交夹具（`hash-object -t commit` 含 `gpgsig`）+ `log.showSignature=true` + 绝对 `gpg.program`：对照 marker=1、硬化 0；`.mailmap` 对照/硬化；`--date-order` 下逐条父边「父行号 > 子行号」 | `npx vitest run tests/git tests/integration/git-graph.test.ts tests/web-hub/boundary.test.ts && npm run typecheck`                                                                      |
| P2 hub（L2）           | 新 `hub/worktree-graph/{routes,project}.ts`；`hub/{ports,http,hub,audit}.ts`；`hub/worktree-diff/{membership,git,routes}.ts`（仅 §2.6 三处追加）                                                          | 新 `tests/web-hub/hub/worktree-graph/{routes,project,budget,source-scan}.test.ts`：错误矩阵逐行（log-timeout 504、missing-object、git-too-old、git-failed）；tips 为空 ⇒ 不跑 Gl；Gr 与 Gl 之间 ref 移动（假 runner）⇒ Gl argv 仍是快照 tips；`refsTruncated` 传到 payload；单飞 join / 全断开 abort / 不存储；§2.5 每个降级状态独立触发且 `complete=false`；三段削后 refs/wtHeads/head 均 ⊆ 剩余提交；审计键白名单 + 429 节流；dispose ≤1 s；source-scan：只经 `createPinnedGit`、argv 只来自 `wtGraphArgs`。`tests/web-hub/http/api-worktree-graph.test.ts`：loopback 401、LAN `mode:"loopback"` 404 逐字节同未启用、`mode:"on"` 可用、无 `/proc` 无 cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `npx vitest run tests/web-hub/hub tests/web-hub/http tests/integration/git-wtdiff.test.ts tests/integration/web-hub-worktree-diff.test.ts && npm run typecheck && npm run format:check` |
| P3 UI 逻辑（L1）       | 新 `ui/src/logic/{gitGraph,gitGraphScope}.ts`                                                                                                                                                             | 新 `tests/web-hub/ui/logic-git-graph.test.ts`：varA 数据集逐行快照；§4.1 topo 验证（每条父边端点真实、无假连接）；连续 8 父章鱼 merge × 125 与 100 路并行宽 DAG（各 1000 节点，5× 余量）：操作计数 ≤ N·(E+1)、path ≤ E + N·P、单次布局 ≤100 ms（中位数 ×3）；折叠：隐藏 lane 不产生连通段、折叠节点/桩标记正确；`refChipsOf`、完整 oid 环匹配、`formatCommitDate`、scope 真值表；固定 seed 1000 例随机 DAG 性质测试（never throws）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `npx vitest run tests/web-hub/ui/logic-git-graph.test.ts && npm run typecheck`                                                                                                          |
| P4 UI 传输（L2）       | `transport/{types,token,password}.ts`；`logic/{token,password}-client.js`；`logic/contract.js`；`composables/useHub.ts`                                                                                   | `transport-contract`/`logic-contract` 追加：成功、401 relogin、超时、外部 abort、body 超上限、坏 JSON/schema、错误体透传                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `npx vitest run tests/web-hub/ui tests/web-hub/contract && npm run typecheck`                                                                                                           |
| P5 UI 组件（L2，前端） | 新 `composables/useWorktreeGraph.ts`、`components/graph/{WorktreeGraph,GraphLanes}.vue`、`styles/graph.css`、`i18n/{en,zh}/graph.ts`；`WorktreePanel.vue`；`tokens.css`（仅追加）；`check-ui-dist.ts`     | `worktree-panel.test.ts`：无 cap DOM 逐字节不变、默认折叠且无请求、展开一次请求、`WorktreePanel.vue` 不 import `gitGraph.ts`（静态扫描）；新 `worktree-graph.test.ts`：五态 + degraded（零提交不完整 ≠ empty）、merge/当前/环/折叠的 sr 文本、chunk 加载失败 ⇒ 重试成功、去抖重拉、折叠 abort、≤480 列（`useMedia` 注入）、centers 注入时 SVG 坐标与行中心一致；新 `graph-tokens-contrast.test.ts`：解析 tokens.css 三个主题块，芯片文字 ≥4.5:1、线 ≥3:1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `npx vitest run tests/web-hub/ui && npm run typecheck && npm run build:web && npm run check:web`                                                                                        |
| P6 集成 + 文档（L1）   | 新 `tests/integration/web-hub-worktree-graph.test.ts`、`docs/dev/worktree-graph/acceptance.md`；`docs/dev/worktree-web/plan.md`（D15 注记）；`AGENTS.md`（web-hub「Worktree graph」小节 + §2.3 升级门禁） | 真实 hub + 临时仓库：payload 与 `git log --date-order` 交叉校验；payload 键集合 = 协议白名单、提交字段恰为 `h/p/pT/a/t/s`；审计行键集合 ⊆ `WTGRAPH_AUDIT_KEYS`；非成员 `wt` 403；hub close 无残留 git、pin 已关；部分克隆夹具端点层 marker=0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `npm test && npm run typecheck && npm run build && npm run build:web && npm run format:check`                                                                                           |

共享文件：`hub/worktree-diff/**` 只 P2、只三处追加且 P2 验收必跑两套 wtdiff 集成闸门；`hub/preview/**`、`src/git/{run,worktrees,diff}.ts`、`agent/**` 冻结；`WorktreePanel.vue`/`tokens.css`/`check-ui-dist.ts` 只 P5；`AGENTS.md` 只 P6。

## 8. 真机验收（P6 写入 `acceptance.md`）

- **K1** 展开面板 → graph 折叠、无请求；展开 → 一次请求，图与 `git log --graph --date-order -n 200 <同 refs>` 一致；Network 面板确认懒 chunk 在真实 CSP 下加载、无 CSP 违规。
- **K2** devtools 阻断懒 chunk URL → 错误态 + 重试；解除后重试成功。
- **K3** `master`/`origin/master` 同 oid ⇒「master | origin」；分叉 ⇒ 两芯片；`origin/HEAD`、tag 正确；merge 行变暗；当前行高亮；`pi-agent-*` worktree 环按完整 oid 挂对。
- **K4** 字号 100% / 200% / 300%、长 ref 名、手机粗指针：SVG 点与文字行逐行对齐，hash 按钮可点；≤480px（390×844）无横向溢出，只剩 lane(≤4) + subject + hash。
- **K5** graph 展开 + worktree 列表展开时 transcript 仍可见可滚（≥20vh），graph 视口内部滚动、页面不冻结（粗指针）。
- **K6** light / 系统暗色 / `.theme-dark` 三态 lane 与芯片可辨；读屏读出 merge 父提交、当前检出、折叠泳道。
- **K7** 巨型仓库无 commit-graph ⇒ 「日期序超时，可 `git commit-graph write` 后重试」；写入后重试成功。
- **K8** 部分克隆缺对象 ⇒ `missing-object` 文案、无 ssh/helper 进程（`strace -f -e execve` 抽查）；配置 `log.showSignature=true` + 绝对 `gpg.program` marker ⇒ marker 不出现。
- **K9** `check:web` 通过，报告的 main 增量 ≤1.5 KB gz。

## 9. 风险

| #   | 风险                                      | 缓解                                                     |
| --- | ----------------------------------------- | -------------------------------------------------------- |
| R1  | 自由文本内含邮箱/路径/秘密经 LAN 外流     | 用户已接受（§0.2）；`webHub.preview:"loopback"` 一键收紧 |
| R2  | 新 git 版本给 log/for-each-ref 增加执行面 | §2.3 升级门禁 + 成对测试                                 |
| R3  | 巨型仓库 date-order 超时                  | 可重试 504 + commit-graph 提示；v1 不做回退              |
| R4  | trace2 全局配置写文件                     | 用户自有配置残余，同 wtdiff                              |

## 10. 不做（v1）

分页 / 加载更多 / 默认序回退、提交详情与 wtdiff 联动、过滤搜索、头像、fetch、虚拟滚动、stash/notes、非 Linux。

## 11. 评审处置表（第一轮，gpt-6.1-sol）

| #   | 级别    | 处置                                                                                                                                                                                                            | 落点                  |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | Blocker | **接受**：取得用户裁定（2026-10-10），逐字记录精确暴露面与残余；P0 冻结以此为前提                                                                                                                               | §0.2、R1              |
| 2   | Blocker | **接受**：Gr/Gl 一律 `--no-lazy-fetch`，129 ⇒ fail-closed；本机实测对照（未硬化剥缺失 tag 目标执行恶意 `core.sshCommand` 2 次）；缺失 commit / tag 目标 + 恶意 transport 配置的成对测试，断言零执行、零对象写入 | §2.2、§2.3、P1/P6/K8  |
| 3   | Major   | **接受**：单次有界 Gr 快照 → 去重、类型校验的显式 tips → Gl 不解析 ref；截断 ⇒ `refsTruncated` + UI 降级；缓存改为不存储的单飞，键 = tips 摘要                                                                  | §2.2、§2.5、P2        |
| 4   | Major   | **接受**：逐步总账（含每条命令的 fstat 步、shallow 改为 fs stat 不 spawn），4×2 + 6 = 14 = G，测试用真实算术                                                                                                    | §2.4、P0/P2           |
| 5   | Major   | **接受**：删除默认序回退，超时 ⇒ 可重试 504；逐条父边端点测试（集成 + 布局）                                                                                                                                    | §2.2、§4.1、P1/P3     |
| 6   | Major   | **接受**：按 N、E 推导上界；1000 节点宽 DAG / 连续章鱼测试 + 操作计数 + 耗时；溢出用折叠标记、不画连通线                                                                                                        | §4.1、P3              |
| 7   | Major   | **接受**：raw-cap / 坏记录 / 父截断 / refs 截断与略过 / JSON 削尾各自独立；削尾后重过滤 refs；UI 显示降级、零提交不完整不显示「空」；N 固定后 `more` 仅表示「仅前 200」                                         | §2.5、§3、§4.3        |
| 8   | Major   | **接受**：`--gg-row` 随 `--fs-scale` 缩放 + 粗指针下限，SVG 按实测行中心；hash 单元格即复制按钮、不用 32px `CopyButton`；验收 100/200/300%                                                                      | §4.3、K4              |
| 9   | Major   | **接受**：独立有界视口 `min(32vh, 12 行)`，沿用 `.wt-list` 裁定；验收 transcript 可用、手机无横向溢出                                                                                                           | §4.3、K5              |
| 10  | Major   | **接受**：措辞改为「不采集专用 email 字段、不读取文件正文」，残余进 Q1；测试改为字段选择（格式串、payload 键白名单）与审计白名单                                                                                | §2.2、§0.2、P1/P6     |
| 11  | Major   | **接受**：签名提交夹具 + 绝对 `gpg.program` + 未硬化对照（本机实测对照 1 / 硬化 0）；P2 验收必跑 `git-wtdiff` 与 `web-hub-worktree-diff` 两套集成闸门                                                           | §2.3、P1/P2           |
| 12  | Minor   | **接受**：执行/读取面矩阵 + R11 式升级门禁，明确不放宽 wtdiff 驱动正则                                                                                                                                          | §2.3、P6（AGENTS.md） |
| 13  | Minor   | **接受**：预算按合并时实测三项定、不预写；布局逻辑与 scope helper 拆文件守懒 chunk + main 增量闸门；真实 CSP 懒加载与失败重试验收                                                                               | §4.3、§5、K1/K2/K9    |
| 14  | Minor   | **接受**：环按完整 `wtHeads.h`（hub 下发 path 与 StatusInfo 精确匹配 label）；暗色三处选择器（含 `.theme-dark`）；芯片文字 4.5:1 测试；sr 文本承载 merge/折叠/父提交                                            | §4.2、§4.3、P5、K6    |

驳回项：无。

> 脚注（#48）：上表 #10「不读取文件正文」为当时的历史处置，保持原样；Gm 例外见 `merged-plan.md` §5.1（暴露面与 r3 裁定）。
