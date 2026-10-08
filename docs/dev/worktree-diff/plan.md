# web-hub「worktree 文件 diff 查看」· 施工方案（worktree-diff plan v3 · 评审第二轮修订）

> 规划产物（架构设计 subagent，只读调研 + 只写本文档；§2.3 / §2.6 / §2.7 / §2.10 的 git 行为结论来自 `/tmp` 临时仓库实测，git 2.53.0 / Node 22.22.1，实验目录已删除）。
> 上位：`docs/dev/worktree-web/plan.md`（worktree 面板 W1–W4）、`docs/dev/web-hub-preview/{plan,dir-plan}.md`（preview 安全模板，U1/U4）。格式对齐 `dir-plan.md`。
> 交互基线：用户已批准的 mockup `/home/bluecake/shots/diff-mockup.html`。
> 行号以 2026-10-08 工作树（P1b `deeed44`、P3 `83d6fc0` 已合入）为准。
> **v2** = v1 + 评审第一轮（1 Blocker / 6 Major / 5 Minor / 1 Nit）处置。**v3** = v2 + 评审第二轮六条未闭合项处置（§9.2）：HEAD 唯一读取点 + 窗口关闭点（#1）；驱动中和改为「收缩属性来源 + 无条件置空 + 事后复核」三层（#2）；准入阶段（membership + 三 fd 钉住）进入显式预算总账（#3）；PATH 固定为常量（#4）；gitdir 与 commondir 一并 fd 钉住、`.git` 指针在 membership 后不再被 git 读取（#5，实测）；A1 已由用户拍板 (a)（#6）。
> 兼容原则：**只增不改**。新端点由新 cap 门控、没有新设置、StatusInfo 线上形状零改动、新旧 UI × 新旧 hub 都逐字节回落到今天的只读面板。

---

## 0. 决策日志与不变量

### 0.1 决策表

| #   | 题目                           | 拍板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 备选与否决理由                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 数据通路                       | **(a) hub 侧直接跑有界 git**（同机、同 uid 守护进程，按需拉取，不经 agent）——**条件接受**（主会话裁定）：§2.6 驱动中和三层、§2.7 环境 allowlist（含固定 PATH）、§2.3 三 fd 钉住（worktree / gitdir / commondir）、§2.10 无 index 写入、§1.9 预算总账五项落地为 D3 硬前置（H1–H5，§5）                                                                                                                                                                                                                                                                                                                                                  | (b) agent 采样推送：diff 塞不进 16 KiB 的 `StatusInfo.worktrees`（`agent/worktrees.ts:38`），要新帧 + 协议升级；(c) hub→agent 转发：新 cmd op + agent cap + 旧 agent 不支持 + agent 忙时排队                                                                                                                               |
| D2  | 端点形态                       | 两个 `GET`：`/api/worktree-diff/files`（清单 JSON）、`/api/worktree-diff/file`（JSON 信封内含 raw unified patch）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 单端点 + `op=`：两种响应形状 / 上限 / 审计 phase 都不同；POST：纯读幂等，GET + `X-PWH: 1` 与 preview 同口径                                                                                                                                                                                                                |
| D3  | 文件清单走哪条路               | 端点拉取（展开行时才拉）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 扩 `StatusInfo.worktrees`：状态通道 16 KiB / 24 行预算、每次指纹变化广播给全部订阅端、要动 agent 采样器——否                                                                                                                                                                                                                |
| D4  | worktree 准入与钉住            | hub 自行派生成员资格（完整有界 `git worktree list --porcelain` 上匹配，§2.3），通过后钉住**三个目录 fd**——worktree `W`（子进程 fd 3）、该 worktree 的 gitdir（fd 4）、仓库 commondir（fd 5）——并以 dev/ino 交叉校验三者的从属关系；每条 git 以 `-C /proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3` + `GIT_COMMON_DIR=/proc/self/fd/5` 启动（实测可行）⇒ `.git` 指针文件与 gitdir 内的 `commondir` 文件在 membership 之后**不再被 git 读取**；`StatusInfo.worktrees` 只作 UI 入参                                                                                                                                | 只钉 `W`（v2）：linked worktree 的 `.git` 指针与 `commondir` 文件仍按路径二次定位，可被偷换（评审第二轮 #5）——否；逐命令前按路径复核 gitdir：复核与 git 自身读取之间仍有窗口——否；StatusInfo 准入：path 会被削、有采样延迟、开放 schema——否                                                                                |
| D5  | 文件准入                       | 目标路径与 `orig` 过 preview 同一 `denyListHit`（字面 + canonical）与 `isVirtualFsPath`；未跟踪内容只经 preview 的 `FsAdmitter` 读取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 让 git 读未跟踪内容：绕开 preview 的 fs 防线——否                                                                                                                                                                                                                                                                           |
| D6  | mode 门 / LAN                  | 骑 `webHub.preview` 三态，不加新设置：`config.preview` 存在 **且 `/proc/self/fd` 可用**（D21）⇒ 声明 `wtdiff.v1`；LAN 仅 `mode:"on"` 分派；**LAN 与 loopback 同宽，含当前变更文件的 HEAD 版本——用户 2026-10-08 拍板（附录 A1 选 (a)，依据 U1）**                                                                                                                                                                                                                                                                                                                                                                                       | 新开关 `webHub.worktreeDiff`：多一维组合矩阵；按 listener 区分范围：U4 已否决；A1 (b)/(c) 用户未选                                                                                                                                                                                                                         |
| D7  | payload                        | raw patch + 客户端解析（hub 薄）；JSON 信封经 `sendJson`（自动 gzip）；parser 在 `protocol/worktree-diff.ts`，防御性校验 + 契约测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 服务端结构化 JSON：体积膨胀 3–5 倍、两端模型同步演进；raw body + 头部元数据：patch 无需流式                                                                                                                                                                                                                                |
| D8  | diff 基准与请求绑定（#1）      | 基准 = **本请求现解析的当前 HEAD**：HEAD 的唯一读取点是本请求在钉住的 gitdir 上执行的 C0；之后所有命令以显式 oid 运行、不再解析符号引用（窗口关闭点见 §1.7）。`file` 请求的 `base` 与**本请求 C0 的结果**比对（不是缓存键里的旧值），不等 ⇒ `409 E_STALE_CTX{base}`（UI 自动重拉清单）；`(path, orig)` 必须恰好是服务端为 `(W, C0 oid)` 算出的变更集中的可请求条目，否则 `409 E_STALE_CTX{entry}`。变更集缓存键含 C0 oid（§1.10），只可能在 oid 相等时命中；不签发服务端快照                                                                                                                                                           | 只校验 hex：任意 OID + 任意路径 = 读整个历史（评审第一轮 #1）——否；先解析 HEAD 再在另一条未钉住的链上 diff（v2 隐含形态）：两次解析之间 HEAD 可移动（评审第二轮 #1）——否；服务端签发快照 token：多一套签名 / 过期 / 存储——否                                                                                               |
| D9  | 特殊文件                       | §3.3 全表：未跟踪 ⇒ FsAdmitter 读 + 服务端合成全增 patch；二进制 ⇒ 提示不渲染；重命名 ⇒ 清单带 `orig`；删除 ⇒ 全删；filter 管理的文件 ⇒ 列出但不可请求；**子模块 v1 整体忽略**（D20）                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 客户端合成未跟踪 patch：两个请求、两套错误面——否                                                                                                                                                                                                                                                                           |
| D10 | 分屏对齐                       | mockup 算法即 v1；行以单元素承载左右两格（同一 grid 行），长行换行时两侧天然等高                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 块内 LCS 再对齐：git 已给最小编辑脚本——否；mockup 的 `pre` + `overflow: visible`：长行溢出到对侧栏——改为换行                                                                                                                                                                                                               |
| D11 | 行内高亮 / 语法色              | v1 都不做（§3.6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                          |
| D12 | UI 落位                        | 面板行内展开文件列表；对话框是新组件 `components/diff/WorktreeDiffDialog.vue`；壳层行为放 **diff 局部** `components/diff/diffModal.ts`（不抽共享 composable，不改 PreviewHost）                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 改造 PreviewHost：状态机绑定 `usePreview`；抽共享壳层：牵动 preview 测试面，留给以后单独立项                                                                                                                                                                                                                               |
| D13 | 刷新                           | 清单：展开中行签名变化 ⇒ 去抖 3 s 自动重拉；对话框：不自动刷新，签名变化显示「工作区已变化」横幅 + 手动刷新；收到 `E_STALE_CTX` ⇒ 自动重拉清单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 对话框跟随刷新：阅读中内容跳动——否；fs watch：常驻资源——否                                                                                                                                                                                                                                                                 |
| D14 | denylist 命中项（#6，撤回 v1） | **对齐 dir-plan §2.8**：命中项（path 或 orig 任一命中）**不列出、不计入 `total`、不产生任何派生元数据**；UI 始终显示静态脚注「受保护条目不显示」；面板 `*N` 与清单条数可能不一致，脚注解释                                                                                                                                                                                                                                                                                                                                                                                                                                             | v1「列名、不计数」：文件名本身即 oracle（评审 #6）——撤回                                                                                                                                                                                                                                                                   |
| D15 | hub 执行 git                   | 修订 worktree-web §6「hub 进程不执行任何 git」（`docs/dev/worktree-web/plan.md:374`）为：hub 仅在「会话 repo 的注册 worktree」（三 fd 钉住）内执行 §1.8 冻结 argv 的 git 子命令；**不称「只读 git」**——仓库 / 用户配置的外部驱动在中和前可执行（§2.6）。条件同 D1（H1–H5）                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                          |
| D16 | 视图偏好持久化                 | 不持久化（会话内 ref，默认 split）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | localStorage：UI source-scan 限定只有主题 / 令牌可用（`tests/web-hub/ui/source-scan.test.ts:179`）——否                                                                                                                                                                                                                     |
| D17 | diff 命令（新，实测）          | 计数与单文件 diff 用 **plumbing `git diff-index`**，不用 porcelain `git diff`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | porcelain `git diff <commit>`：实测即使 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0` 仍**写 index**（mtime 变化）并触发 `post-index-change` hook（§2.10）——否                                                                                                                                                            |
| D18 | 外部驱动（#2）                 | **三层（§2.6.2）**：**L1 收缩属性来源**——`--attr-source=<空树>`（按仓库对象格式取常量）+ `-c core.attributesFile=/dev/null` + `GIT_ATTR_NOSYSTEM=1`，实测使已提交 / 工作区 `.gitattributes` 全部失效，唯一残留的活动属性来源是 `$GIT_COMMON_DIR/info/attributes`；**L2 无条件置空**——对「配置中声明的全部驱动名 ∪ info/attributes 中出现的全部驱动名」一律下发 `-c` 置空，不论该名此刻有无命令；**L3 事后复核**——命令结束后重读 info/attributes 并重扫驱动，任一变化即丢弃结果答 503 `attr-changed`。驱动名不安全 / 超限 / 读取失败 ⇒ 415 `filter-config`；`check-attr --source=<base>` 只用于标记 filter 管理的条目（不执行任何东西） | v2 两段式「扫描再按结果置空」：扫描与执行之间新增配置命令（如恰逢 `git lfs install` 写全局配置）对已提交 `.gitattributes` 引用的名字立即生效（评审第二轮 #2）——否；只用 `GIT_CONFIG_NOSYSTEM=1` + `attributesFile=/dev/null`：不覆盖仓库配置与 `.gitattributes`——不足；临时遮蔽 info/attributes：要写仓库文件，违反 I9——否 |
| D19 | 环境（#3、二轮 #4）            | 最小 allowlist：**`PATH` 固定为常量 `/usr/bin:/bin`**（实测本机 git `/usr/bin/git`、exec-path `/usr/lib/git-core` 在此 PATH 下可用；本方案只用内建子命令，不调外部 helper）；`HOME`、`XDG_CONFIG_HOME`（若存在）继承；强制 `LC_ALL=C`、`LANG=C`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_ATTR_NOSYSTEM=1`；`GIT_COMMON_DIR=/proc/self/fd/5` 只由 run.ts 在钉住模式下写入；其余一律不带（§2.7）                                                                                                                                                                                                                           | 继承宿主 PATH：可指向替身 git / helper（评审第二轮 #4）——否；启动时按宿主 PATH 解析 git 绝对路径：信任根仍是宿主 PATH——否；黑名单剔除：git 环境变量随版本增长——否                                                                                                                                                          |
| D20 | 子模块                         | `--ignore-submodules=all`（status 与 diff-index）：v1 不展示子模块变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 展示：git 会在子模块里再拉起 git，子模块自身配置的驱动名不在预扫描结果里，中和不完整——否（§8）                                                                                                                                                                                                                             |
| D21 | 平台与 git 版本                | `wtdiff.v1` 仅在 `previewProcFdAvailable()`（`hub/preview/fs.ts:570`）为真时声明——三 fd 钉住依赖 `/proc/self/fd`；git 须在固定 PATH 中且支持 `--attr-source` / `check-attr --source`（不支持 ⇒ 首条用到它的命令以 129 退出 ⇒ 503 `git-too-old`，运行时探测，不在启动期 spawn）                                                                                                                                                                                                                                                                                                                                                         | 无 `/proc` 时按路径重验：留交换窗口——否；启动期探测 git 版本：hub 启动多一次 spawn 且探测结果可能随包管理器升级而过期——否                                                                                                                                                                                                  |

### 0.2 不变量

- **I1 零 agent 改动**：`src/web-hub/agent/**`、`StatusInfo` / `WorktreesWire` 形状、PROTO 版本均不变。
- **I2 同一准入纪律**：任何可能流出文件内容的路径先过 `denyListHit`（`hub/preview/admit.ts:228`）+ `isVirtualFsPath`（`admit.ts:97`）；未跟踪内容只经 `createFsAdmitter`（`admit.ts:312`）。
- **I3 git 只在三 fd 钉住的注册 worktree 内跑**：除 membership 的两条（C1a `rev-parse --git-common-dir`、C1 `worktree list`，在 `session.cwd`，不读工作区内容）外，每条 git 都以 `-C /proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3` + `GIT_COMMON_DIR=/proc/self/fd/5` 运行，三个 fd = membership 验证过 dev/ino 与从属关系的目录句柄（§2.3）。
- **I4 argv 白名单**：git 参数全部来自 §1.8 冻结构造器；请求派生值只能出现在 `--` 之后（全局 `--literal-pathspecs`）或作为通过 `WTDIFF_BASE_RE` 且等于当前 HEAD 的 oid；`-c` 驱动名只来自 git 自己的配置输出且过 `WTDIFF_DRIVER_NAME_RE`。
- **I5 硬上限**：每条 git 独立超时（`run.ts` 进程组 SIGKILL，`unref` 定时器）+ stdout 上限；每请求两阶段 deadline（准入 `WTDIFF_ADMIT_MS` + 独立追加的 git 阶段 `WTDIFF_GIT_PHASE_MS`，§1.9 总账）+ finally 独立有界关闭；fs 步骤走 `previewFsStep` + 实例 tracker。
- **I6 无内容缓存、单飞**：hub 只缓存「变更集」（路径 + 状态 + 标记，≤5 s，§1.10），从不缓存 git 输出正文或文件内容。
- **I7 审计**：每个请求一行 `audit:"wtdiff"`，白名单字段、路径只以 HMAC-12 出现；**唯一例外**：429 按 60 s 窗口每 principal 至多一行（窗口内后续 429 照常应答、不记行），测试钉住（§2.9）。
- **I8 cap 门控逐字节回落**：无 `wtdiff.v1`（或 LAN 无 `preview.lan.v1`）⇒ 面板 DOM 与今天逐字节一致。
- **I9 无写操作**：不提供 stage / discard / checkout；**git 进程不写 index**（I12）。
- **I10 生命周期**：路由实例 `dispose` ≤1 s、幂等；钉住的目录 fd、未跟踪文件句柄都有唯一关闭责任（§2.3、§3.1.1）。
- **I11 请求绑定（#1）**：`file` 请求只可能读到「当前 HEAD」与「当前变更集中可请求条目」的交集内容；任意 OID / 任意路径都不可达。
- **I12 无 index 写入**：只用 `status --no-optional-locks`（`run.ts` 前置）与不写 index 的 plumbing / 只读子命令（`diff-index`、`rev-parse`、`check-attr`、`config`、`worktree list`），外加 `core.hooksPath=/dev/null`；集成测试断言 index mtime 不变、hook 不触发。
- **I13 驱动中和三层**：所有读工作区内容的 git 命令（C2、C3、C4）都带 L1 属性来源收缩 + L2 全部已知驱动名置空；命令结束后 L3 复核，变化即丢弃结果；中和参数无法构造 ⇒ 不执行（§2.6.2）。
- **I14 仓库身份钉住（二轮 #5，v3.1 收窄）**：membership 之后，git 不再按路径读取 `W/.git` 指针文件——gitdir 与 commondir 的 index / HEAD symref / `config.worktree`（fd 4）以及 **objects / 仓库 config**（`GIT_COMMON_DIR` ⇒ fd 5）都经继承的 fd / env 访问；但 git 2.53 的 refs 后端**仍读 `<gitdir>/commondir` 文件**（见 §2.3 实测修正）：其被改写只能让 **OID 解析**重定向（同 uid 残余），对象内容读取 fail-closed。每条命令 spawn 前 `fstat` 三个 pin 的 dev/ino 与 membership 记录一致。
- **I15 HEAD 唯一读取点（二轮 #1）**：每个请求恰好一次把符号引用 `HEAD` 解析为 oid（C0，经钉住的 gitdir）；之后的 C2 只用其 `# branch.oid` 做一致性复核（不等即 409），C3 / C4 只接受显式 oid。

### 0.3 与既有拍板的关系

| 既有拍板                                        | 本方案                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| preview U1 / U4                                 | 沿用同宽与 mode 门（D6）；HEAD 旧版本（新资产类别）经用户 2026-10-08 拍板接受（A1 (a)） |
| worktree-web Q1（下发绝对路径）                 | 沿用：UI 用 `row.path` 作请求入参                                                       |
| worktree-web D4「只读、无 fetch、无 preview」   | 无写操作、无 fetch 保持；「无 preview」有意放宽为「有 diff 读路径」                     |
| worktree-web §6「hub 进程不执行任何 git」       | 条件修订（D15），D6 包在原文追加修订注记                                                |
| dir-plan §2.8 / A1「denylist 条目不列出不计数」 | **完全对齐**（D14）                                                                     |

---

## 1. 协议与端面

### 1.1 数据流

```
浏览器 WorktreePanel ── row.path（来自 StatusInfo.worktrees，仅作入参）
   │ GET /api/worktree-diff/files?agentKey&sessionId&wt[&untracked=no]
   │ GET /api/worktree-diff/file ?agentKey&sessionId&wt&base&path[&orig][&untracked=no]
   ▼
hub/http.ts（loopback 恒分派；LAN 仅 mode==="on"）
   ▼
hub/worktree-diff/routes.ts
   准入阶段（≤ WTDIFF_ADMIT_MS）：⓪closing ①CSRF ②auth ③params ④rate/inflight ⑤session ⑥membership + 三 fd 钉住
   git 阶段（独立追加 ≤ WTDIFF_GIT_PHASE_MS）：⑦C0 head ⑧Cc 驱动 + info/attributes ⑨changeset ⑩分支处理 ⑪L3 复核
   ⑫应答  ⑬finally：并行 boundedClose（≤ WTDIFF_CLOSE_MS）→ 释放名额 → 审计
   ├─ membership.ts ── src/git/run.ts（C1a/C1）+ src/git/worktrees.ts（parseWorktreePorcelain）+ preview fs（realpath/open/fstat/stat/read）
   ├─ changeset.ts  ── C0、Cc、info/attributes 读取、C2、Ca；≤5 s TTL 单飞缓存
   ├─ git.ts        ── C3 numstat、C4 diff-index -p；src/git/diff.ts 的构造器、中和参数、-z 解析
   └─ untracked.ts  ── preview/admit.ts（createFsAdmitter）+ preview/fs.ts（previewFsStep/boundedClose）+ preview/sniff.ts
   ▼
protocol/worktree-diff.ts（类型 + parser，hub 与 UI 共用）
```

依赖方向：`hub/worktree-diff/* → {src/git/{run,worktrees,diff}.ts（精确文件 allowlist，§5 D1）, hub/preview/{admit,fs,sniff}, hub/spawn/dirs.ts（withinRoot）, hub/{cmd-limit,req-deadline,audit,ports}, protocol/*}`；反向无依赖。

### 1.2 端点与参数

| 端点                           | 参数（全部 query）                                                                                                                                                 | 成功                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `GET /api/worktree-diff/files` | `agentKey`（`/^[A-Za-z0-9_-]{1,64}$/`）、`sessionId`（1–128 可打印 ASCII）、`wt`（`validatePreviewPath(wt,{minSegments:1})`）、`untracked`（可选，仅 `"no"` 生效） | 200 `WtDiffFileList`    |
| `GET /api/worktree-diff/file`  | 前三项 + `base`（`WTDIFF_BASE_RE`）+ `path`、`orig`（可选），二者过 `validateWtRelPath`；另带 `untracked`（与产生该条目的清单请求一致，参与变更集键）              | 200 `WtDiffFilePayload` |

都要求 `X-PWH: 1`；响应头 `Cache-Control: no-store`、`Cross-Origin-Resource-Policy: same-origin`。正则沿用 `hub/preview/routes.ts:86,89`。

### 1.3 `src/web-hub/protocol/worktree-diff.ts`（新文件，D0 冻结）

```ts
// —— 端点 ——
export const WTDIFF_FILES_PATH = "/api/worktree-diff/files";
export const WTDIFF_FILE_PATH = "/api/worktree-diff/file";

// —— 上限 ——
export const WTDIFF_FILES_MAX = 1_000;
export const WTDIFF_STATUS_MAX_BYTES = 512 * 1024;
export const WTDIFF_NUMSTAT_MAX_BYTES = 256 * 1024;
export const WTDIFF_LIST_BODY_MAX_BYTES = 256 * 1024;
export const WTDIFF_PATCH_MAX_BYTES = 512 * 1024;
export const WTDIFF_FILE_BODY_MAX_BYTES = 1024 * 1024;
export const WTDIFF_UNTRACKED_READ_MAX_BYTES = 384 * 1024;
export const WTDIFF_PARSE_LINES_MAX = 50_000; // parser 处理的 patch 行（含 hunk 头）上限
export const WTDIFF_PARSE_HUNKS_MAX = 10_000; // 独立 hunk 数上限（#8）
export const WTDIFF_WT_LIST_MAX_BYTES = 256 * 1024; // worktree list --porcelain 上限
export const WTDIFF_WT_REALPATH_FANOUT_MAX = 64; // membership realpath 扇出上限（只限扇出，#9）
export const WTDIFF_DRIVERS_MAX = 16; // 可中和的驱动名个数上限
export const WTDIFF_CHANGESET_TTL_MS = 5_000;

// —— 预算（两阶段 + finally，§1.9 总账）——
export const WTDIFF_ADMIT_MS = 8_000; // 准入阶段：认证 + 参数 + 会话 + membership + 三 fd 钉住（同 preview 8 s 准入）
export const WTDIFF_AUTH_RESERVE_MS = 5_000; // 认证后准入阶段至少剩余（LAN 认证 ≤ 3 s）
export const WTDIFF_STEP_MS = 2_000; // 单步上限：每个 git 小命令 / fs 步骤（同 PREVIEW_FS_STEP_MS）
export const WTDIFF_GIT_PHASE_MS = 14_000; // git 阶段：准入结束后独立追加
export const WTDIFF_GIT_CMD_MS = 5_000; // C2 / C3 / C4 单条上限
export const WTDIFF_CLOSE_MS = 1_000; // finally：三个 pin + 未跟踪句柄并行 boundedClose，独立 deadline
export const WTDIFF_TRANSFER_RESERVE_MS = 10_000;
export const WTDIFF_CLIENT_TIMEOUT_MS = 35_000;

// —— 校验 ——
export const WTDIFF_BASE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** repo 相对路径：非空、不以 / 开头、≤4096 UTF-8 字节、无 NUL/CR/LF、各段非空且非 . / ..、任何段不为 ".git"。 */
export function validateWtRelPath(p: string): boolean;

// —— 清单 ——
export type WtDiffStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";
export const WTDIFF_STATUSES = ["M", "A", "D", "R", "C", "T", "U", "?"] as const; // 唯一来源
export interface WtDiffFileEntry {
  path: string; // repo 相对路径（git -z 原样 UTF-8 解码；可含 CR/LF/TAB/U+FFFD，见「可展示但不可请求」）
  orig?: string; // 仅 R/C
  status: WtDiffStatus;
  add?: number; // numstat；binary / untracked / filtered / numstat 缺失时不出现
  del?: number;
  binary?: true;
  filtered?: true; // 由 filter 驱动管理（如 LFS），或 check-attr 未覆盖（fail-closed）：不可请求
}
export interface WtDiffFileList {
  base: string; // 当前 HEAD 全长 oid
  entries: WtDiffFileEntry[]; // 顺序 = git status 输出序
  total: number; // 已解析且**未隐藏**的条目数（denylist 命中项从不计入，D14）；limits.status 时为下界
  truncated: boolean; // === entries.length < total || limits.status
  limits: { status: boolean; files: boolean; bytes: boolean };
  untrackedSkipped?: true;
  numstatPartial?: true;
  attrPartial?: true; // check-attr 未全覆盖：未覆盖条目已标 filtered
}
/** 「可展示但不可请求」的唯一判定（#7）：UI 用它禁用条目，hub 用它筛变更集。 */
export function isWtRequestableEntry(e: WtDiffFileEntry): boolean;
// = validateWtRelPath(e.path) && (e.orig === undefined || validateWtRelPath(e.orig))
//   && !e.path.includes("\uFFFD") && !(e.orig ?? "").includes("\uFFFD") && e.filtered !== true
export function parseWtDiffFileList(raw: unknown, byteLength: number): WtDiffFileList | null;

// —— 单文件 ——
export type WtDiffFileKind = "patch" | "binary" | "empty";
export interface WtDiffFilePayload {
  base: string;
  path: string;
  orig?: string;
  kind: WtDiffFileKind; // empty：变更集中有该条目但相对 base 内容无差异（如仅 stat 变化后被还原）
  untracked?: true;
  patch: string; // kind!=="patch" 时恒为 ""
  bytes: number;
  truncated: boolean;
}
export function parseWtDiffFile(raw: unknown, byteLength: number): WtDiffFilePayload | null;

// —— 错误 reason ——
export type WtDiffDenyReason = "not-repo" | "not-worktree" | "denylist" | "virtual-fs";
export type WtDiffUnsupportedReason = "unborn" | "symlink" | "git-unavailable" | "git-too-old" | "filter-config";
export type WtDiffBusyReason = "inflight" | "fs" | "attr-changed";
export type WtDiffStaleReason = "base" | "entry";

// —— unified patch 解析（§3.2）——
export interface PatchLine {
  k: "ctx" | "del" | "add";
  o: number | null;
  n: number | null;
  text: string;
  noEol?: true;
}
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: PatchLine[];
}
export interface PatchFileMeta {
  newFile?: true;
  deleted?: true;
  renameFrom?: string;
  renameTo?: string;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  binary?: true;
}
export interface PatchFile {
  meta: PatchFileMeta;
  hunks: PatchHunk[];
}
export interface ParsedPatch {
  files: PatchFile[];
  add: number;
  del: number;
  complete: boolean; // 末个 hunk 计数闭合
  malformed: boolean;
  lineCap: boolean; // 命中 WTDIFF_PARSE_LINES_MAX
  hunkCap: boolean; // 命中 WTDIFF_PARSE_HUNKS_MAX（#8）
}
export function parseUnifiedPatch(text: string): ParsedPatch; // 纯函数、线性、永不抛
```

**`parseWtDiffFileList` 拒绝条件**（任一 ⇒ null）：`byteLength` 非安全非负整数或 > `WTDIFF_LIST_BODY_MAX_BYTES`；`base` 不匹配；`entries` 非数组或 > `WTDIFF_FILES_MAX`；`path`/`orig` 非非空字符串、含 NUL 或 UTF-8 > 4096；`status` 不在 `WTDIFF_STATUSES`；`orig` 出现但 `status ∉ {R,C}`；`add`/`del` 非非负安全整数；`binary/filtered/untrackedSkipped/numstatPartial/attrPartial` 出现但不为 `true`；`filtered` 与 `add/del` 同时出现；`total < entries.length`；`limits` 三字段非布尔；`truncated !== (entries.length < total || limits.status)`。未知字段忽略。**注意**：parser 允许 CR/LF/TAB/U+FFFD（可展示），是否可请求只由 `isWtRequestableEntry` 决定——这是「可展示但不可请求」的协议定义。

**`parseWtDiffFile` 拒绝条件**：`byteLength` > `WTDIFF_FILE_BODY_MAX_BYTES`；`base` 非法；`path`/`orig` 不过 `validateWtRelPath`；`kind` 不在枚举；`kind!=="patch"` 而 `patch!==""`；`bytes` ≠ `patch` 的 UTF-8 字节数或 > `WTDIFF_PATCH_MAX_BYTES`；`truncated`/`untracked` 类型不对。

### 1.4 `protocol/version.ts` 与 `protocol/http-contract.ts`（只追加）

```ts
// version.ts
/** worktree-diff：/api/worktree-diff/* 可用。随 config.preview 存在 **且** /proc/self/fd 可用时
 *  同步声明（D21），不是独立开关；LAN 可用性沿用 PREVIEW_LAN_HUB_CAP。 */
export const WTDIFF_HUB_CAP = "wtdiff.v1";
```

`API_ERRORS` 尾部（`E_AGENT_ONLINE` 之后，只追加不重排）：`"E_WTDIFF_DENIED"`（403）、`"E_WTDIFF_UNSUPPORTED"`（415 / 503）。`E_STALE_CTX` 复用已有码（409，body `reason: WtDiffStaleReason`）。`ui/src/logic/contract.js` 的 `API` 追加两个路径（从 protocol import）。

### 1.5 错误矩阵（统一，#9）

| 情形                                                                                                                                     | status / code                                       | reason                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| hub 关闭中                                                                                                                               | 503 `E_HUB_RESTARTING`                              | —                         |
| CSRF                                                                                                                                     | 403 `E_CSRF`                                        | —                         |
| 认证失败                                                                                                                                 | listener 自答（401）                                | —                         |
| 参数非法                                                                                                                                 | 400 `E_BAD_REQUEST`                                 | —                         |
| 令牌桶 / 在途上限                                                                                                                        | 429 `E_RATE` / 503 `E_BUSY`                         | `inflight`                |
| agentKey 不存在                                                                                                                          | 404 `E_NOT_FOUND`                                   | —                         |
| sessionId 不匹配                                                                                                                         | 409 `E_SESSION_CHANGED`                             | —                         |
| `session.cwd` 不在 repo / C1 失败 / `/proc/*/fd` cwd                                                                                     | 403 `E_WTDIFF_DENIED`                               | `not-repo`                |
| `wt` 不在完整 porcelain 输出的非 bare 非 prunable 行中（含 bare / prunable 命中、输出截断未命中、realpath 扇出超限未命中、dev/ino 不符） | 403 `E_WTDIFF_DENIED`                               | `not-worktree`            |
| `W` 或文件路径命中 denylist / 虚拟根（字面判定，先于任何 git）                                                                           | 403 `E_WTDIFF_DENIED`                               | `denylist` / `virtual-fs` |
| HEAD 未诞生（C0 非零退出）                                                                                                               | 415 `E_WTDIFF_UNSUPPORTED`                          | `unborn`                  |
| 驱动名不安全 / 超过 16 个 / Cc 失败                                                                                                      | 415 `E_WTDIFF_UNSUPPORTED`                          | `filter-config`           |
| info/attributes 不可读（非 ENOENT）/ 超过 64 KiB / 出现不安全驱动名                                                                      | 415 `E_WTDIFF_UNSUPPORTED`                          | `filter-config`           |
| git 不认识 `--attr-source` / `check-attr --source`（退出 129）                                                                           | 503 `E_WTDIFF_UNSUPPORTED`                          | `git-too-old`             |
| gitdir / commondir 定位或从属校验失败（§2.3）                                                                                            | 403 `E_WTDIFF_DENIED`                               | `not-worktree`            |
| L3 事后复核：info/attributes 或驱动集合在命令执行期间变化（结果已丢弃）                                                                  | 503 `E_BUSY`                                        | `attr-changed`            |
| spawn 前 pin 的 dev/ino 复核不符（实现缺陷防线）                                                                                         | 500 `E_INTERNAL`                                    | —                         |
| 未跟踪路径含符号链接（admit realpath ≠ `W/rel`）                                                                                         | 415 `E_WTDIFF_UNSUPPORTED`                          | `symlink`                 |
| git 无法启动                                                                                                                             | 503 `E_WTDIFF_UNSUPPORTED`                          | `git-unavailable`         |
| `base` ≠ 当前 HEAD                                                                                                                       | 409 `E_STALE_CTX`                                   | `base`                    |
| `(path, orig)` 不是当前变更集中的可请求条目（含：已提交 / 已还原 / 被隐藏 / filtered / 不存在）                                          | 409 `E_STALE_CTX`                                   | `entry`                   |
| 准入阶段或 git 阶段 deadline 耗尽 / git 超时                                                                                             | 504 `E_DEADLINE`                                    | —                         |
| tracker 熔断                                                                                                                             | 503 `E_BUSY`                                        | `fs`                      |
| git 其他非零退出                                                                                                                         | 500 `E_INTERNAL`（日志只记 cmd、exit、stderrBytes） | —                         |
| 请求 abort                                                                                                                               | 不应答 / 503 `E_HUB_RESTARTING`                     | —                         |

v1 的「bare 行 ⇒ 415 bare」分支删除（bare 行在过滤后不可能命中，统一为 `not-worktree`）。`entry` 不区分「被隐藏」与「不存在」——零 oracle（§2.8）。numstat / check-attr 失败不是错误（降级标记）。

### 1.6 hub 端面

- **`hub/ports.ts`**（`FileSearchRoutes` 之后，`ports.ts:712-715` 附近）：

```ts
export interface WorktreeDiffRoutes {
  readonly mode: "on" | "loopback";
  handleFiles(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  handleFile(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, io: PreviewRouteIo): Promise<void>;
  /** 幂等；abort 全部 in-flight（kill git 进程组、关闭钉住的 fd），≤1 s。 */
  dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void>;
}
```

`FrontendDeps` 追加 `worktreeDiff?: WorktreeDiffRoutes`（`ports.ts:624` 之后）。缺省 ⇒ 回落未启用矩阵。

- **`hub/http.ts`**：`LanRuntime` 追加字段（`http.ts:990` 之后）、LAN 装配同实例透传（`http.ts:2348` 之后）；四处分派紧随 file-search 分支——LAN（`http.ts:1347` 分支之后）仅 `mode === "on"`，`authorize` 照抄 preview LAN 段、用 `WTDIFF_AUTH_RESERVE_MS`；loopback（`http.ts:2627` 分支之后）同步 cookie 校验。
- **`hub/hub.ts`**：`config.preview !== undefined` 块内（`hub.ts:666-700`）、`previewRoutes` 之后以**同一 `denyCtx`** 构造 `createWorktreeDiffRoutes({ mode, denyCtx, registry, run: deps.gitRunner ?? createGitRunner(), fs?, log, now })`；`frontend({...})` 透传（`hub.ts:739` 附近）；启动失败回退在 preview dispose 之后 push（`hub.ts:752` 附近）；运行时 close 在 preview dispose 之后、`fe.close()` 之前（`hub.ts:1150` 附近）；`extraHubCaps`（`hub.ts:243-247`）在 preview 分支内追加 `...(previewProcFdAvailable() ? [WTDIFF_HUB_CAP] : [])`；无 `/proc` 时不构造路由。`StartHubDeps` 追加可选 `gitRunner?: GitRunner`。

### 1.7 路由管线

```
—— 准入阶段：A = createReqDeadline(now, WTDIFF_ADMIT_MS)，每步 min(A.remaining, WTDIFF_STEP_MS) ——
⓪ closing ⇒ 503
① CSRF（同 previewCsrfOk，routes.ts:124）—— 先于认证
② io.authorize(A)（LAN 用 WTDIFF_AUTH_RESERVE_MS 推导认证预算）
③ 参数校验（§1.2）
④ limit.admit(`${principal}:wtdiff`, 20, 250ms)；在途 per-principal 2 / global 4
⑤ registry.get(agentKey) ⇒ 404；sessionId 不符 ⇒ 409（同 open.ts:128-134）
⑥ membership + pin（§2.3）⇒ { W, pins: {wt, git, common}, ids }；字面 denylist（W / wtReq）⇒ 403
   file 端点：denyListHit(W/path)、(W/orig)、(wtReq/path)、(wtReq/orig) 任一命中 ⇒ 403 denylist（字面，先于任何 git）
   —— 从 ⑥ 返回起，三个 pin 由本请求的 ⑬ finally 唯一负责关闭 ——
—— git 阶段：G = createReqDeadline(now, WTDIFF_GIT_PHASE_MS)（准入结束时创建，独立于 A）——
   每条 git spawn 前：fstat 三个 pin（一次 previewFsStep）⇒ dev/ino 必须与 ids 相等
⑦ C0 = rev-parse --show-object-format HEAD（钉住链上）⇒ { format, oid }；非零退出 ⇒ 415 unborn
   ★ 窗口关闭点：本请求对符号引用 HEAD 的**唯一**解析就在这里，读取的是钉住的 gitdir（fd 4）里的 HEAD；
     此后 C2 / C3 / C4 只接受显式 oid（C2 读到的 `# branch.oid` 仅用于复核），任何后续 HEAD 移动都不会改变本请求的内容来源。
   file 端点：base !== C0.oid ⇒ 409 E_STALE_CTX{base}（以本请求 C0 为准，从不以缓存值为准）
⑧ drivers：Cc 驱动扫描 + 读 info/attributes（经 hub 自持的 common pin：/proc/self/fd/<common.fd>/info/attributes）
   ⇒ N = neutralizeArgs(配置驱动名 ∪ info/attributes 驱动名)；attrSig = sha256(info/attributes 字节) + 驱动名集合
   不安全 / 超限 / 读取失败 ⇒ 415 filter-config
⑨ cs = changeset(key = ids \0 C0.oid \0 indexStat(git pin) \0 attrSig \0 untracked)
       缓存命中 ⇒ 复用（键含 C0.oid ⇒ 必然与本请求 HEAD 一致）
       未命中 ⇒ 单飞：C2 status（L1 + N）⇒ `# branch.oid` ≠ C0.oid ⇒ 409 base（HEAD 在本请求内移动）
                ⇒ 解析 + combinedStatus ⇒ 隐藏 denylist 命中项 ⇒ 有驱动时 Ca check-attr --source=<C0.oid> 标 filtered
                ⇒ 截断（FILES_MAX）⇒ 缓存 { base: C0.oid, entries（无计数）, flags }
—— files ——
⑩f ns = C3 diff-index --numstat（L1 + N，<C0.oid>；G 剩余 < 1 s 跳过）⇒ 合并计数
—— file ——
⑩p e = cs 中 path/orig 完全相等的条目；!e || !isWtRequestableEntry(e) ⇒ 409 E_STALE_CTX{entry}
    e.status === "?" ⇒ untracked.ts（§3.1.1）；否则 C4 diff-index -p（L1 + N，<C0.oid>）⇒ patch | binary | empty
⑪ L3 复核（本请求执行过 C2 / C3 / C4 任一条时）：重读 info/attributes + 重跑 Cc ⇒ attrSig 变化 ⇒ 丢弃结果、503 attr-changed、
   log.warn(event:"wtdiff.attr_changed")（无路径、无驱动名）
⑫ files：字节预算 ⇒ sendFileList；file：序列化上限裁剪 ⇒ sendFilePayload
⑬ finally：Promise.all(boundedClose(pin) × 3 [+ 未跟踪句柄])（各自独立 WTDIFF_CLOSE_MS）→ 释放名额 → active.delete → 审计
```

### 1.8 git 命令表（冻结 argv，`src/git/diff.ts` 构造器产出，单测逐字节钉）

`run.ts` 前置 `--no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false`（`run.ts:93`）。本功能所有调用带 `envPolicy: "minimal"`（§2.7）与请求 `signal`；C0 / Cc / C2 / Ca / C3 / C4 另带 `pins: { wt, git, common }`——run.ts 把三者映射为子进程 fd 3 / 4 / 5、`cwd: "/"`、在 env 中写入 `GIT_COMMON_DIR=/proc/self/fd/5`，并**强制** argv 以 `PINNED_PREFIX` 开头（否则不 spawn、返回 `spawnError`）。

- `PINNED_PREFIX = ["-C", "/proc/self/fd/3", "--git-dir=/proc/self/fd/4", "--work-tree=/proc/self/fd/3"]`（`src/git/run.ts` 导出常量）
- `B = PINNED_PREFIX + --literal-pathspecs -c core.hooksPath=/dev/null -c core.quotePath=true`
- `L1 = --attr-source=<空树> -c core.attributesFile=/dev/null`（空树按 C0 的对象格式取 `WTDIFF_EMPTY_TREE.sha1 | .sha256`；`GIT_ATTR_NOSYSTEM=1` 在环境里）
- `X = -c core.bigFileThreshold=16m -c diff.suppressBlankEmpty=false`
- `N` = L2 中和参数（§2.6.2，对每个驱动名无条件下发）

| #   | 用途        | argv                                                                                                                               | 单步上限               | stdout 上限                    |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------ |
| C1a | 仓库定位    | `-C <session.cwd> rev-parse --path-format=absolute --git-common-dir`（不钉 fd，准入阶段）                                          | `min(A, STEP_MS)`      | 8 KiB                          |
| C1  | membership  | `-C <session.cwd> worktree list --porcelain`（不钉 fd，准入阶段；只读 `$GIT_COMMON_DIR/worktrees` 元数据）                         | `min(A, STEP_MS)`      | `WTDIFF_WT_LIST_MAX_BYTES`     |
| C0  | head        | `B rev-parse --show-object-format HEAD`                                                                                            | `min(G, STEP_MS)`      | 8 KiB                          |
| Cc  | 驱动扫描    | `B config --null --get-regexp ^(filter\|diff)\..+\.(clean\|smudge\|process\|required\|textconv\|command)$`（退出码 1 = 无匹配）    | `min(G, STEP_MS)`      | 64 KiB（超限 ⇒ filter-config） |
| C2  | 变更集      | `B L1 X N -c status.renames=true status --porcelain=v2 -z --branch --untracked-files=<all\|no> --ignore-submodules=all`            | `min(G, GIT_CMD_MS)`   | `WTDIFF_STATUS_MAX_BYTES`      |
| Ca  | filter 标记 | `B check-attr -z --source=<C0.oid> filter -- <paths…>`（仅当驱动 ≥1；每批 ≤200 路径且 argv ≤128 KiB，≤5 批）                       | 每批 `min(G, STEP_MS)` | 256 KiB                        |
| C3  | 计数        | `B L1 X N diff-index --numstat -z -M --no-textconv --no-ext-diff --ignore-submodules=all <C0.oid>`                                 | `min(G, GIT_CMD_MS)`   | `WTDIFF_NUMSTAT_MAX_BYTES`     |
| C4  | 单文件      | `B L1 X N diff-index -p -M --unified=3 --no-color --no-textconv --no-ext-diff --ignore-submodules=all <C0.oid> -- [<orig>] <path>` | `min(G, GIT_CMD_MS)`   | `WTDIFF_PATCH_MAX_BYTES`       |

说明：三 fd 钉住实测（linked worktree）：`--git-dir=/proc/self/fd/4` + `GIT_COMMON_DIR=/proc/self/fd/5` 下 `rev-parse --git-common-dir` 输出 `/proc/self/fd/5`——但该输出只是对 env 值的回显；`GIT_COMMON_DIR` 的实际生效面是 objects / 仓库 config，refs 仍读 `<gitdir>/commondir` 文件（§2.3 v3.1 修正）。只给 `--git-dir` 不给 `GIT_COMMON_DIR` 时 git 连 objects 也按 `commondir` 文件解析（v2 的偷换面，他库内容可整块读出），故 `GIT_COMMON_DIR` 必须由 run.ts 写入。`--attr-source=<空树>` 实测使已提交 `.gitattributes` 引用的 filter 不再触发；`check-attr --source=<oid>` 读取的是不可变的提交树（只用于显示标记）。`<oid>` 只可能是本请求 C0 的输出；请求派生值只出现在 `--` 之后；`--ignore-submodules=all` 见 D20。

### 1.9 预算关系（协议测试钉住）

**总账**（复用 preview「8 s 准入 + 每步 2 s」切分；git 阶段像 dir-plan 的列举阶段一样独立追加；finally 的关闭用各自独立的有界 deadline）：

| 阶段 / 步骤                                                                                               | 单步上限                                                             | 计入      |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------- |
| ② 认证（LAN `requireLanSession`）                                                                         | `min(A − AUTH_RESERVE, LAN_AUTH_CAP_MS=3 s)`                         | A（8 s）  |
| ⑥a C1a 仓库定位                                                                                           | `min(A, 2 s)`                                                        | A         |
| ⑥b C1 worktree list                                                                                       | `min(A, 2 s)`                                                        | A         |
| ⑥c fs：realpath(wtReq)、open W、fstat W                                                                   | 每步 `min(A, 2 s)`                                                   | A         |
| ⑥d fs：lstat `W/.git`；目录 ⇒ open；文件 ⇒ 读 ≤4 KiB + realpath + open；fstat gitdir                      | 每步 `min(A, 2 s)`                                                   | A         |
| ⑥e fs：realpath + open commondir、fstat；从属校验 stat（`<common>/worktrees/<name>` 或 gitdir≡commondir） | 每步 `min(A, 2 s)`                                                   | A         |
| ⑥f fs：目标匹配的 realpath 扇出（≤64，并发 4）+ stat(row.path)                                            | 每步 `min(A, 2 s)`                                                   | A         |
| ⑦ C0                                                                                                      | `min(G, 2 s)`                                                        | G（14 s） |
| ⑧ Cc + 读 info/attributes                                                                                 | 各 `min(G, 2 s)`                                                     | G         |
| ⑨ C2（缓存未命中）                                                                                        | `min(G, 5 s)`                                                        | G         |
| ⑨ Ca（有驱动时）                                                                                          | 每批 `min(G, 2 s)`；未覆盖 ⇒ filtered                                | G         |
| ⑩ C3 或 C4 / 未跟踪读取                                                                                   | `min(G, 5 s)`；G < 1 s ⇒ C3 跳过 / C4 答 504                         | G         |
| ⑪ L3：重读 info/attributes + 重跑 Cc                                                                      | 各 `min(G, 2 s)`；G 不足 ⇒ 视同变化（fail-closed，503 attr-changed） | G         |
| 每条 git spawn 前的 pin fstat×3                                                                           | 一次 `min(G, 2 s)`                                                   | G         |
| ⑬ 三个 pin + 未跟踪句柄 `boundedClose`                                                                    | 并行，各 `WTDIFF_CLOSE_MS`（1 s）独立 deadline，不受请求 abort 影响  | finally   |

关系钉（`tests/web-hub/protocol/worktree-diff.test.ts`）：

- `WTDIFF_ADMIT_MS − WTDIFF_AUTH_RESERVE_MS ≥ LAN_AUTH_CAP_MS`（8 − 5 ≥ 3，`hub/req-deadline.ts:32`）；
- `2 × WTDIFF_STEP_MS ≤ WTDIFF_AUTH_RESERVE_MS`（C1a + C1 在认证后必有完整单步预算；fs 步骤典型为微秒级，耗尽 ⇒ 504，与 preview 准入同口径）；
- `4 × WTDIFF_STEP_MS + WTDIFF_GIT_CMD_MS ≤ WTDIFF_GIT_PHASE_MS`（C0 + Cc + attrs 读 + pin fstat + C2：8 + 5 ≤ 14——变更集必有完整预算；L3 与 C3 / C4 吃剩余）；
- 服务端墙钟上限 `WTDIFF_ADMIT_MS + WTDIFF_GIT_PHASE_MS + WTDIFF_CLOSE_MS = 23 s`，`23 s + WTDIFF_TRANSFER_RESERVE_MS ≤ WTDIFF_CLIENT_TIMEOUT_MS`（23 + 10 ≤ 35）；
- `WTDIFF_PATCH_MAX_BYTES < WTDIFF_FILE_BODY_MAX_BYTES`；`WTDIFF_UNTRACKED_READ_MAX_BYTES < WTDIFF_PATCH_MAX_BYTES`；`WTDIFF_PARSE_HUNKS_MAX < WTDIFF_PARSE_LINES_MAX`。

典型路径（清单刚展开、紧接着点文件）：`file` 命中变更集缓存，git 阶段只付 C0 + Cc + attrs 读 + C4 + L3。

### 1.10 变更集缓存、单飞、并发、dispose

- **变更集缓存（#1 方向）**：键 = `ids（W、gitdir、commondir 的 dev:ino） \0 C0.oid \0 indexStat \0 attrSig \0 untracked`。`C0.oid` 是**本请求**现解析的 HEAD——缓存因此只可能在 oid 相等时命中，`file` 的 base 校验永远以本请求 C0 为准；`indexStat` = hub 经自持 git pin 访问 `/proc/self/fd/<git.fd>/index` 的 `mtimeMs:size:ino`（stat 失败 ⇒ 该段为空，退化为纯 TTL）；`attrSig` 使中和参数变化时缓存自然失效。值 = `{ base, entries（无计数）, untrackedSkipped?, attrPartial?, limitsStatus, totalVisible }`，**不含任何文件内容 / git 输出正文**。TTL `WTDIFF_CHANGESET_TTL_MS`（5 s），LRU 8 键，总量 ≤ 2 MiB。工作区内容 5 s 内的变化不影响安全（C4 每次现跑），只影响「路径是否在集内」的判定新鲜度。
- **单飞**：变更集计算按键单飞；`file` 的 C4 按 `(键, path, orig)` 单飞。值为结果数据，每个 HTTP 请求各自应答、各自审计（`joined:true`）。共享执行持有自己的 `AbortController`，加入者断开 refcount−1，归零即 abort；共享执行的 deadline 取首个请求的。
- **在途**：per-principal 2、global 4（每请求同一时刻至多 1 条 git）⇒ 全 hub ≤4 个 git 进程；令牌桶 20 / +1 每 250 ms，自有 `CmdLimit` 实例。
- **fs 熔断**：路由实例自有 `createPreviewIoTracker()`（`hub/preview/fs.ts:114`），membership 的 realpath / open / fstat / stat、index stat、未跟踪读取全部经 `previewFsStep(..., { tracker })`。
- **dispose**：置 `closing`；abort 全部共享执行与请求（reason `hub-close`，git 进程组 SIGKILL 同步 settle，`run.ts:34-49,113-131`）；各请求 finally 的 `boundedClose(pin)` 照常执行；等待 active 至多 1 s；幂等。

---

## 2. 安全准入

### 2.1 威胁模型（重写，#2）

**前提声明**：hub 执行的 git 命令**不是天然只读**。在本方案的加固之前，`status` / `diff` 会执行仓库或用户配置声明的外部命令（filter 驱动、textconv）、porcelain `diff` 会写 index 并触发 hook（§2.6.1、§2.10 实测）。下表的「防线」是本方案让它们不发生的手段，而不是「git 本来就安全」。

| 面                        | 威胁                                                                                                                                    | 防线                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 任意历史读取（#1）        | 调用者用任意已知 OID + 任意路径经 diff 读出历史内容                                                                                     | D8 / I11：base 必须等于当前 HEAD，path 必须在当前变更集                                                                       |
| 文件内容外泄              | 凭据文件内容经上下文 / 全删 / 合成全增流出                                                                                              | denylist 双表示 + 隐藏（§2.5）；未跟踪走 FsAdmitter；OS 权限                                                                  |
| 外部命令执行              | `filter.*.clean/process`（status、diff-index 读工作区内容时）、`diff.*.textconv`、外部 diff、hooks、fsmonitor；扫描与执行之间新增的驱动 | §2.6.2 三层：属性来源收缩 + 无条件置空 + 事后复核；`--no-textconv --no-ext-diff`；hooks→`/dev/null`；fsmonitor 关；子模块忽略 |
| 仓库状态写入              | index 刷新写回、`index.lock` 与 agent 的 git 操作冲突、hook                                                                             | §2.10：只用 `status --no-optional-locks` 与 plumbing；集成测试断言 index mtime 不变                                           |
| argv 注入                 | 请求值被当成 git 选项                                                                                                                   | I4                                                                                                                            |
| 环境劫持                  | 继承的 `PATH`（替身 git / helper）、`GIT_DIR` / `GIT_CONFIG_GLOBAL` / `GIT_ATTR_SOURCE` / `GIT_SSH*` / `LD_PRELOAD` …                   | §2.7 最小 allowlist，PATH 固定常量                                                                                            |
| 路径 / 仓库竞态（TOCTOU） | membership 通过后 W 路径被换；linked worktree 的 `.git` 指针或 `<gitdir>/commondir` 被改指别的仓库；HEAD 在请求内移动                   | §2.3 三 fd 钉住（I14）；§1.7 HEAD 唯一读取点（I15）                                                                           |
| 资源耗尽                  | 超大仓库 / 超大文件 / 洪水                                                                                                              | 每命令超时 + stdout 上限 + 在途 / 令牌桶 + bigFileThreshold + 单飞                                                            |
| 存在性 oracle             | 由响应推断路径存在 / 受保护文件名                                                                                                       | §2.8                                                                                                                          |

**背景（不是缓解）**：agent 的 worktree 采样器每 30 s 在同一批 worktree 里跑 `git status`（`src/git/worktrees.ts:191`），没有驱动中和——即 filter 执行面在今天已经存在于 agent 进程。这只说明本功能没有开辟「全新」的执行面，**不作为本方案的安全论据**；采样器的同类加固列入 §8 后续。

### 2.2 会话可见性（不变）

同 preview ⑤（`hub/preview/open.ts:128-134`）：agentKey 必须在 registry、sessionId 必须等于当前会话。

### 2.3 worktree 成员资格与三 fd 钉住（#4、#9、二轮 #5）

```
membership(cwd, wtReq, A, signal):           // 全部步骤在准入 deadline A 内，每步 ≤ WTDIFF_STEP_MS
  /^\/proc\/(?:self|\d+)\/fd\// 匹配 cwd ⇒ DENIED not-repo                              // 同 worktrees.ts:37
  common0 = run(C1a).stdout.trim()；失败 ⇒ DENIED not-repo（spawnError ⇒ 503 git-unavailable；timeout ⇒ 504）
  out = run(C1)；同上映射
  rows = parseWorktreePorcelain(out.stdout, out.stdoutCapped).filter(!bare && !prunable)  // worktrees.ts:54，完整有界输出
  W = step(realpath(wtReq))；ENOENT/ENOTDIR ⇒ DENIED not-worktree
  denyListHit(W) || denyListHit(wtReq) || isVirtualFsPath(W) ⇒ DENIED denylist / virtual-fs
  owned = []                                   // 本函数持有的 pin；任何失败路径在 finally 里全部 boundedClose
  wt  = step(open(W, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)); owned.push(wt); wtSt = step(wt.stat())
  // —— 目标匹配（#9）：全部行上零 fs 的字面匹配；realpath 只用于扇出 ——
  cand = rows.filter(r => r.path === wtReq || r.path === W)
  if cand 为空: rows.length > WTDIFF_WT_REALPATH_FANOUT_MAX ⇒ DENIED not-worktree；否则 cand = realpath(r.path) === W 的行（并发 4）
  ∄ r ∈ cand: stat(r.path).(dev,ino) === wtSt.(dev,ino) ⇒ DENIED not-worktree
  main = (命中的行是 rows[0])                  // porcelain 第一行恒为主 worktree
  // —— commondir：会话 repo 的仓库身份根 ——
  C  = step(realpath(common0)); common = step(open(C, O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)); owned.push(common); cSt = step(common.stat())
  // —— gitdir：经钉住的 W 读 .git，不再按 W 路径 ——
  dotgit = step(lstat(`/proc/self/fd/${wt.fd}/.git`))
  if main:
     dotgit 必须是目录；git = step(open(`/proc/self/fd/${wt.fd}/.git`, O_DIRECTORY|O_NOFOLLOW)); owned.push(git)
     gSt = step(git.stat())；要求 gSt.(dev,ino) === cSt.(dev,ino)                           // 主 worktree：gitdir ≡ commondir
  else:
     dotgit 必须是普通文件；text = step(read ≤4 KiB)；必须匹配 /^gitdir: (.+)\n?$/ ⇒ g0
     G = step(realpath(g0)); git = step(open(G, O_DIRECTORY|O_NOFOLLOW)); owned.push(git); gSt = step(git.stat())
     name = basename(G)；s = step(stat(`/proc/self/fd/${common.fd}/worktrees/${name}`))
     要求 s.(dev,ino) === gSt.(dev,ino)                                                       // gitdir 确实是本 commondir 名下的 worktree 条目
  任一不满足 ⇒ DENIED not-worktree
  ids = { wt: wtSt, git: gSt, common: cSt }；owned 所有权随返回值转移给调用方（membership 自身不再关闭）
  返回 { W, pins: { wt, git, common }, ids }
```

- **钉住后 git 如何定位仓库**（实测，v3.1 修正）：`-C /proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3` + `GIT_COMMON_DIR=/proc/self/fd/5`。git 不再读 `W/.git` 指针（显式 `--git-dir`），也不受 gitdir 内 `core.worktree` 影响（命令行 `--work-tree` 优先）。HEAD / index / `config.worktree` 经 fd 4；`GIT_COMMON_DIR` 在 git 2.53 实际覆盖的是 **objects 与仓库 config**（经 fd 5）——refs 后端**仍会读取 `<gitdir>/commondir` 文件**来解析 `refs` / `packed-refs`（`rev-parse --git-common-dir` 输出 `/proc/self/fd/5` 只是对 env 值的回显，不代表 refs 也走 fd）。因此 commondir 文件被改写的实际效果分两层：**OID 解析可被重定向**（C0 可能解析出他库 ref 指向的 OID——同 uid 完整性/可用性残余，落入下条同 uid 范畴）；**内容读取 fail-closed**（被重定向的 OID 在钉住的对象库里不存在 ⇒ `bad object` 非零退出，他库文件内容不可达）。不写 `GIT_COMMON_DIR` 的对照（v2 形态）才会把他库 objects 一并读出——D1 集成测试已双向钉住（`tests/integration/git-wtdiff.test.ts`）。
- **实测**：钉住后把 W 改名并在原路径新建空目录，钉住链上的 `status` 仍输出原仓库状态，按路径执行报 `not a git repository`；linked worktree 只给 `--git-dir` 时 `rev-parse --git-common-dir` 输出的是从 `commondir` 文件解析出的真实路径字符串（v2 的偷换面），加上 `GIT_COMMON_DIR=/proc/self/fd/5` 后输出 `/proc/self/fd/5`。
- **spawn 前复核**：每条钉住命令前 `fstat` 三个 pin，dev/ino 必须等于 `ids`（fd 不会换 inode，此复核防的是实现错误传错 fd），不符 ⇒ 500 + 日志。
- **信任根与残余**：仓库身份的信任根是「判定时刻 `session.cwd` 所属仓库的 commondir」（C1a / C1 不钉 fd，按路径执行——这正是「会话 repo」的定义时刻）。钉住之后剩余的按路径解析只有：commondir 内部的相对结构（`objects/info/alternates` 指向的对象库——内容按哈希寻址，被换也只能提供哈希一致的对象；`refs`、`packed-refs`——已被 I15 约束为 C0 一次读取）。能在毫秒窗口内改写这些的只有同 uid 进程，而同 uid 进程本可直接读取这些文件，不构成提权。
- **所有权**：membership 内任一步失败 ⇒ 其 finally 并行 `boundedClose` 已打开的 pin、不返回 pin；成功返回后三个 pin 由请求 handler 的 ⑬ finally 唯一负责（`hub/preview/fs.ts:553` 的 `boundedClose`，各自独立 1 s deadline）。
- **StatusInfo 结论（不变）**：hub 能拿到 `registry.get(k).status.worktrees`（`hub/registry.ts:445-448`）但不可靠，只作 UI 入参。

### 2.4 相对路径校验与「可展示但不可请求」（#7）

`validateWtRelPath`：非空；不以 `/` 开头；UTF-8 ≤ 4096；无 NUL / CR / LF；每段非空、非 `.`、非 `..`、非 `.git`；`W + "/" + rel` 再过 `validatePreviewPath`。git `-z` 输出里可能出现含 CR / LF / 非 UTF-8 字节（解码为 U+FFFD）的文件名：它们**进入清单（可展示）**，但 `isWtRequestableEntry` 为假 ⇒ hub 不放进可请求集（`file` 请求答 409 entry）、UI 禁用。含 TAB 的文件名**可请求**（协议层 JSON 编码无损、行格式无歧义），由 UI 的 `displayPath` 可见化渲染（v3.1 勘误：本段与 §4.2 曾把 TAB 与 CR/LF 并列写成不可请求，以 §1.3 冻结公式为准——D0 验收 r_FX096FBZ 裁定）。以 `-` 开头的文件名（`-rf`）是合法可请求路径，只出现在 `--` 之后。

### 2.5 denylist 应用点

| 对象                                                         | 检查                                           | 命中后                                                  |
| ------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| `wtReq` 与 `W`                                               | `denyListHit(·, denyCtx)` + `isVirtualFsPath`  | 403 denylist / virtual-fs                               |
| 变更集条目（`W/path`、`W/orig`、`wtReq/path`、`wtReq/orig`） | `denyListHit` × 4                              | **隐藏**：不进 entries、不计 total、不进可请求集（D14） |
| `file` 请求的 `path` / `orig`                                | 同上，字面判定先于任何 git                     | 403 denylist（与路径是否存在无关）                      |
| 未跟踪内容                                                   | `createFsAdmitter` 全链 + `realpath === W/rel` | 403 / 415 symlink                                       |

`denyCtx` 是 hub 启动时为 preview 解析的同一对象（`hub.ts:668-679`）。已跟踪文件不再单独 realpath：git 不跟随已跟踪符号链接、拒绝越过符号链接目录，W 已是 canonical。

### 2.6 外部驱动：触发条件、缓解与残余（#2）

#### 2.6.1 触发矩阵（git 2.53 实测，临时仓库 + 记录调用次数的 marker 脚本）

| 命令                                                                     | clean / process filter                                                                            | textconv                        | 写 index / `post-index-change` hook                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `status --porcelain=v2`（`--no-optional-locks`）                         | **触发**：已跟踪文件 stat 失配且大小相同时重新哈希内容（touch 后 1 次）；大小已变则直接判脏不哈希 | 否                              | 否（index mtime 不变）                                                          |
| `diff HEAD`（porcelain）                                                 | **触发**（2 次）                                                                                  | **触发**（默认开，2 次）        | **写 index + 触发 hook**（即使 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`） |
| `diff HEAD --numstat`（porcelain）                                       | 触发                                                                                              | 否                              | 写 + hook                                                                       |
| `diff-index -p / --numstat HEAD`（plumbing）                             | **触发**（2 次，读工作区内容时 convert_to_git）                                                   | 由 `--no-textconv` 关闭（0 次） | 否（mtime 不变、hook 未触发）                                                   |
| 上两行加中和参数 `N`                                                     | **0 次**（clean、process、`required=true` 三种配置都验证过）                                      | 0                               | 否                                                                              |
| `rev-parse` / `worktree list` / `config --get-regexp` / `check-attr`     | 不读工作区内容，不触发                                                                            | 否                              | 否                                                                              |
| `status` + `--attr-source=<空树>`，filter 由已提交 `.gitattributes` 引用 | **0 次**（属性来源被替换为空树）                                                                  | —                               | 否                                                                              |
| `status` + `--attr-source=HEAD`（已提交树仍引用 filter）                 | 触发（1 次）——故 L1 必须用空树而非 HEAD                                                           | —                               | 否                                                                              |
| `status` + 空树，filter 改由 `$GIT_COMMON_DIR/info/attributes` 引用      | **仍触发**——info/attributes 不受 `--attr-source` 影响                                             | —                               | 否                                                                              |
| 上一行再加 `GIT_ATTR_NOSYSTEM=1` + `-c core.attributesFile=/dev/null`    | 仍触发——info/attributes 无法用选项关闭（⇒ L2 必须覆盖其中出现的驱动名）                           | —                               | 否                                                                              |
| info/attributes 用宏间接引用（`[attr]m filter=p` + `*.txt m`）           | 触发——L2 的名字提取必须覆盖宏定义行                                                               | —                               | 否                                                                              |
| `required=true` + 只清空 clean/process、不覆盖 required                  | —                                                                                                 | —                               | git 以 128 退出（`clean filter 'probe' failed`）⇒ fail-closed                   |

#### 2.6.2 缓解：三层，无「扫描再条件置空」的两段式（D18，二轮 #2）

执行一个驱动需要同时满足：(i) 某个**属性来源**把路径映射到驱动名；(ii) 某个**配置层**为该名定义了命令。v2 只在 (ii) 侧做「扫描 → 按结果置空」，扫描与执行之间新增的配置命令对已提交 `.gitattributes` 里引用的名字立即生效（例如恰逢 `git lfs install` 写入全局配置）。v3 改为两侧同时收口：

1. **L1 收缩属性来源（关闭 (i) 的绝大部分）**：C2 / C3 / C4 一律带 `--attr-source=<空树>`（`WTDIFF_EMPTY_TREE[C0.format]`）+ `-c core.attributesFile=/dev/null`，环境 `GIT_ATTR_NOSYSTEM=1`。实测：已提交与工作区（任意目录、含未跟踪 / 被忽略）的 `.gitattributes` 全部失效、全局与系统属性文件失效。**唯一残留**的活动属性来源是 `$GIT_COMMON_DIR/info/attributes`（实测不受上述任何选项影响）——一个位置固定的单文件，经 hub 自持的 common pin 读取（`/proc/self/fd/<common.fd>/info/attributes`，≤64 KiB，ENOENT = 空）。
2. **L2 无条件置空（关闭 (ii)）**：驱动名集合 = Cc 扫描到的配置驱动名 ∪ info/attributes 中出现的全部驱动名（对整个文件做 `(?:^|\s)[-!]?(filter|diff)=(\S+)` 超集匹配，宏定义行 `[attr]m filter=p` 也被覆盖）。对集合中**每个**名字无条件下发 `-c filter.<n>.clean= -c filter.<n>.smudge= -c filter.<n>.process= -c filter.<n>.required=false` 与 `-c diff.<n>.textconv= -c diff.<n>.command=`——**不论该名此刻在配置里有没有命令**。于是：一个被 info/attributes 引用、扫描时尚无命令、执行前才被写入配置的名字，依旧被命令行 `-c`（最高优先级）置空。名字须匹配 `WTDIFF_DRIVER_NAME_RE`，集合 ≤ `WTDIFF_DRIVERS_MAX`，否则 415 `filter-config`。
3. **L3 事后复核（检测残余）**：C2 / C3 / C4 结束后重读 info/attributes 并重跑 Cc，`attrSig` 变化 ⇒ 丢弃结果、503 `attr-changed`、写 `wtdiff.attr_changed` 告警。
4. **其余执行面**：`--no-textconv --no-ext-diff`、`core.fsmonitor=false`、`core.hooksPath=/dev/null`、`--ignore-submodules=all`、无网络子命令。
5. **显示标记**：L1 让 git 不再按属性处理 filter 文件（如 LFS 指针按原始字节比较）。有驱动时 Ca 以 `check-attr --source=<C0.oid>`（读不可变的提交树 + info/attributes，不执行任何东西）找出 `filter` 属性为已知驱动名的条目，标 `filtered`（不可请求）；未覆盖条目 fail-closed 标 `filtered` 并置 `attrPartial`。

**为何不扫描全部 attributes 来源**（维持 v2 的部分反驳，但机制换成 L1）：attributes 来源无法有界穷举，而 L1 直接把它们替换为空树，比「扫描后降级」更强、且可测；剩下的 info/attributes 是单文件，可以完整读取。

**残余（明示）**：同一 uid 的进程在 ⑧ 读取与 C2/C3/C4 执行之间的毫秒窗口内**同时**做到 ① 往 info/attributes 写入一个**新**驱动名、② 在配置里为该新名定义命令——则该命令会被执行一次；L3 会检测到并丢弃结果、告警，但无法撤销执行。同 uid 进程本可直接执行任意命令，不构成提权。以下情形**不再能**引发执行（均有测试）：已提交 / 工作区 `.gitattributes` 的任意变化；全局 / 系统属性文件；为任何已被引用或已被配置的名字新增 / 修改命令。

**副作用（已知限制）**：L1 同时让已提交的 `eol` / `text` / `working-tree-encoding` / `ident` / `-diff` 属性失效：`eol=crlf`、`working-tree-encoding`、`ident` 文件在 stat 失配时可能被误报为修改或显示原始字节差异；`-diff` 标记的文件按 git 自身的 NUL 启发式判定 binary。Linux 工作树上影响面小，列入 §3.3 与 §8。

**版本**：`--attr-source` 与 `check-attr --source` 需要较新的 git（本机 2.53 实测可用）；不支持时命令以 129 + `unknown option` 退出 ⇒ 503 `git-too-old`（运行时探测，不在启动期 spawn）。

#### 2.6.3 驱动场景集成测试设计（D1 构造器层 + D6 端点层）

真实 git、`describe.skipIf(!hasGit)`、临时 `HOME`；驱动是向 marker 文件追加一行的脚本；每例先 `touch` 已跟踪文件制造 stat 失配。**「窗口注入」**：测试用包装 runner 在 Cc（及 info/attributes 读取）完成之后、C2 spawn 之前执行一个回调去改写配置 / 属性——用真实 git 精确复现 TOCTOU 时序，可证伪。

| 场景                                                                                       | 断言                                                                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| T1 已提交 `.gitattributes` 引用 `filter=p`，扫描时**无**配置；窗口注入 `filter.p.clean`    | marker=0（L1）                                                                                 |
| T2 info/attributes 引用 `filter=q`，扫描时无配置；窗口注入 `filter.q.clean`                | marker=0（L2 无条件置空）                                                                      |
| T3 info/attributes 宏 `[attr]m filter=r` + `*.txt m`，配置 r                               | marker=0（宏行被提取）                                                                         |
| T4 全局 `core.attributesFile` 引用 `filter=s` + 全局配置 s                                 | marker=0（`attributesFile=/dev/null`）                                                         |
| T5 repo / 全局配置 `filter.lfs.{clean,smudge,process,required=true}` + 已提交 `filter=lfs` | marker=0；清单 200；LFS 条目 `filtered`；请求该条目 409 entry                                  |
| T6 `diff.t.textconv` + `diff=t`；`diff.external` / 父进程 `GIT_EXTERNAL_DIFF`              | marker=0                                                                                       |
| T7 `.git/hooks/post-index-change`                                                          | marker=0；index `mtimeMs/size/ino` 前后相等（H4）                                              |
| T8 子模块自身配置 filter                                                                   | marker=0（子模块被忽略）                                                                       |
| T9 **残余复现**：窗口内同时注入 info/attributes 新名 `filter=z` 与配置 `filter.z.clean`    | marker=1（证明残余真实存在）**且**响应 503 `attr-changed`、告警事件一条、结果未发送（L3 生效） |
| T10 info/attributes 出现不安全名（`filter=a=b`）/ 17 个驱动 / 文件 >64 KiB                 | 415 filter-config，且 C2 从未执行                                                              |
| T11 假 runner 让含 `--attr-source` 的命令以 129 + `unknown option` 退出                    | 503 git-too-old                                                                                |
| T12 sha256 仓库（`git init --object-format=sha256`）                                       | C0 报 `sha256`，L1 用 sha256 空树，清单 200                                                    |
| T13 系统属性文件无法在测试里写入 `/etc` ⇒ 单测断言 env 含 `GIT_ATTR_NOSYSTEM=1`            | 键值存在                                                                                       |

### 2.7 环境变量策略（#3、二轮 #4，`run.ts` 的 `envPolicy: "minimal"`）

| 变量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `minimal` 策略                                                                     | 理由                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **固定常量 `WTDIFF_GIT_PATH = "/usr/bin:/bin"`**（`src/git/diff.ts` 导出），不继承 | Node 用子进程 env 的 PATH 查找 `git`；固定后宿主 PATH 无法把调用导向替身 git。本方案所用子命令（`rev-parse`、`config`、`status`、`check-attr`、`diff-index`、`worktree list`）均为内建，git 不需要经 PATH 查找 helper（helper 走编译期 exec-path，本机 `/usr/lib/git-core`）；驱动被置空、hooks 指向 `/dev/null`，没有 `sh` 需求。实测本机在 `env -i PATH=/usr/bin:/bin` 下 `status` 正常 |
| `HOME`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 继承                                                                               | 全局配置与全局 excludes——与 agent 采样器的 untracked 判定一致；全局驱动由 L2 置空                                                                                                                                                                                                                                                                                                         |
| `XDG_CONFIG_HOME`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 存在则继承                                                                         | 同上（`$XDG_CONFIG_HOME/git/{config,ignore}`）                                                                                                                                                                                                                                                                                                                                            |
| `LC_ALL`、`LANG`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 强制 `C`                                                                           | 输出语法稳定                                                                                                                                                                                                                                                                                                                                                                              |
| `GIT_OPTIONAL_LOCKS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 强制 `0`                                                                           | 不取可选锁                                                                                                                                                                                                                                                                                                                                                                                |
| `GIT_TERMINAL_PROMPT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 强制 `0`                                                                           | 永不交互                                                                                                                                                                                                                                                                                                                                                                                  |
| `GIT_ATTR_NOSYSTEM`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 强制 `1`                                                                           | L1：系统级属性文件失效                                                                                                                                                                                                                                                                                                                                                                    |
| `GIT_COMMON_DIR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **仅钉住模式**由 run.ts 写入 `/proc/self/fd/5`；调用方不可传、宿主值不继承         | I14                                                                                                                                                                                                                                                                                                                                                                                       |
| 其他一切（含其余全部 `GIT_*`：`GIT_DIR` `GIT_WORK_TREE` `GIT_INDEX_FILE` `GIT_OBJECT_DIRECTORY` `GIT_ALTERNATE_OBJECT_DIRECTORIES` `GIT_NAMESPACE` `GIT_CONFIG_GLOBAL` `GIT_CONFIG_SYSTEM` `GIT_CONFIG_NOSYSTEM` `GIT_CONFIG_PARAMETERS` `GIT_CONFIG_COUNT/KEY_*/VALUE_*` `GIT_ATTR_SOURCE` `GIT_EXTERNAL_DIFF` `GIT_DIFF_OPTS` `GIT_PAGER` `GIT_EXEC_PATH` `GIT_SSH` `GIT_SSH_COMMAND` `GIT_ASKPASS` `GIT_TRACE*` `GIT_CEILING_DIRECTORIES`；以及 `LD_*` `SSH_*` `TMPDIR` `USER` …） | **不带**                                                                           | allowlist：未列出即缺席                                                                                                                                                                                                                                                                                                                                                                   |

- **非标准安装**：git 不在 `/usr/bin` 或 `/bin`（如 linuxbrew、nix profile）⇒ spawn `ENOENT` ⇒ 503 `git-unavailable`，功能在该机不可用（§8 不做「可配置 git 路径」）。
- `envPolicy` 缺省 `"inherit"`（今天的行为，`run.ts:85-90`）⇒ 采样器零变化。
- **测试**（`tests/git/run.test.ts`）：以 `process.execPath` 作假 git（同 `run.test.ts:150` 的手法）打印 `process.env`；父环境预置上表全部「不带」变量 + 一个指向含假 `git` 目录的 `PATH` ⇒ 子进程键集合**恰好等于** `{PATH, HOME, XDG_CONFIG_HOME?, LC_ALL, LANG, GIT_OPTIONAL_LOCKS, GIT_TERMINAL_PROMPT, GIT_ATTR_NOSYSTEM}`（钉住模式再加 `GIT_COMMON_DIR`），`PATH === "/usr/bin:/bin"`；任何 allowlist 外的 `GIT_*` 键即失败；**替身测试**：宿主 PATH 首位放一个会写 marker 的假 `git`，`minimal` 下 marker 不出现；`"inherit"` 时与今天逐键一致。

### 2.8 存在性 oracle（#6 对齐 dir-plan §2.8）

| 面                    | 行为                                                             | 结论                                                         |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| membership 错误码     | `not-repo` / `not-worktree` 区分                                 | 只暴露「某路径是否是本会话 repo 的 worktree」——面板已广播    |
| 清单                  | denylist 命中项不列出、不计 total、不影响任何字段；脚注静态常显  | **折叠**，同 dir-plan                                        |
| `file` 409 entry      | 不存在 / 已提交 / 被隐藏 / filtered / 不可请求 一律同码同 reason | 零 oracle                                                    |
| `file` 403 denylist   | 字面判定，先于任何 git / fs                                      | 与存在性无关                                                 |
| 面板 `*N` vs 清单条数 | 可能不一致（`*N` 来自 agent 采样，含隐藏项与子模块）             | 已知、由静态脚注解释；`*N` 是 agent 侧既有信息，非本端点新增 |

### 2.9 审计（`hub/audit.ts` 追加，对齐 `auditPreview` `audit.ts:350-380`）

```ts
export interface WtDiffAuditRecord {
  phase: "files" | "file";
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  agentKey?: string;
  ok: boolean;
  code?: string;
  reason?: string;
  status?: WtDiffStatus;
  kind?: WtDiffFileKind | "untracked";
  files?: number;
  truncated?: boolean;
  bytes?: number;
  ms?: number;
  ext?: string;
  wtTag?: string;
  pathTag?: string;
  joined?: boolean;
  cached?: boolean;
  drivers?: number;
}
export const WTDIFF_AUDIT_KEYS = [
  "phase",
  "listener",
  "ip",
  "user",
  "agentKey",
  "ok",
  "code",
  "reason",
  "status",
  "kind",
  "files",
  "truncated",
  "bytes",
  "ms",
  "ext",
  "wtTag",
  "pathTag",
  "joined",
  "cached",
  "drivers",
] as const;
export function auditWorktreeDiff(log, record: WtDiffAuditRecord): void; // log.info("wtdiff", { audit: "wtdiff", ...pick })
```

- 每请求一行（⑫ finally）；**例外（#13）**：429 按 `RATE_AUDIT_WINDOW_MS`（60 s，同 `routes.ts:83`）每 principal 至多一行，窗口内其余 429 照常应答但不记行。测试：窗口内连发 5 个 429 ⇒ 1 行；跨窗口 ⇒ 第 2 行；非 429 请求每个都恰好 1 行。
- `files` = 可见条目数（隐藏项不进入任何字段）；`drivers` = 中和的驱动个数（只计数，不记名字）。
- `wtTag` = HMAC-12(W)，`pathTag` = HMAC-12(W + "\0" + rel)，key 每实例随机（同 `routes.ts:254`）。
- **永不记录**：wt / path / orig 原文、驱动名、分支名、oid、patch / 内容、git stderr 正文。git 非零退出 `log.warn("wtdiff git failed", { event:"wtdiff.git_failed", cmd, exit, stderrBytes })`，`cmd` ∈ `C1a|C1|C0|Cc|C2|Ca|C3|C4`。L3 复核发现变化时另写 `log.warn("wtdiff attr changed", { event:"wtdiff.attr_changed" })`（无路径、无驱动名）。

### 2.10 index 写入与 hooks（新，实测）

- porcelain `git diff <commit>` 实测会刷新并**写回 index**（mtime 变化）、触发 `post-index-change`，`--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0` 都不能阻止 ⇒ 改用 plumbing `diff-index`（D17），实测 index mtime 不变、hook 不触发。`status --no-optional-locks` 实测不写。
- 写 index 的后果不只是 hook：它要取 `index.lock`，会让 agent 同时进行的 `git add` / `commit` 报 `Unable to create index.lock`。
- 叠加 `core.hooksPath=/dev/null` 作为第二层（实测可阻止 hook）。
- plumbing `diff-index` 不刷新 index 的副作用：stat 失配但内容未变的文件不会出现在 `--numstat` 与 `-p` 输出中（实测正确）；它在 status 里也不会被列出（status 会内容比较），所以清单与 diff 一致。

---

## 3. diff 解析与对齐

### 3.1 hub 侧薄处理

- **截断**：C4 `stdoutCapped` ⇒ 截到最后一个 `\n`（同时去掉截断点的半个 U+FFFD），`truncated:true`。
- **binary 判定**：第一个 `@@` 之前出现 `^Binary files .* differ$` 或 `^GIT binary patch$` ⇒ `kind:"binary"`、`patch:""`。
- **empty**：C4 输出为空 ⇒ `kind:"empty"`（条目仍在变更集但内容相对 base 无差异）。
- **序列化上限**：`JSON.stringify(payload)` UTF-8 > `WTDIFF_FILE_BODY_MAX_BYTES` ⇒ 从 patch 尾部按行裁剪，`truncated:true`；发送前断言。

#### 3.1.1 未跟踪文件读取与句柄所有权（#10）

```
readUntracked(W, rel, deps{admitter, tracker, now, log}, r, signal):
  a = await admitter.admit({ path: `${W}/${rel}` }, r, signal)        // 迟到 open 的回收由 admitter 内部负责（不计入本函数）
  if !a.ok ⇒ status 0 ⇒ abort；否则映射 403/404/409/415/503/504
  // —— 从这里起 a.fh 的唯一关闭责任方 = 本函数 ——
  try:
    if a.realpath !== `${W}/${rel}` ⇒ return 415 symlink              // W 为 canonical；任何符号链接段都会让二者不等
    buf = []；pos = 0
    while pos < min(a.size, UNTRACKED_READ_MAX):
      n = await previewFsStep(() => a.fh.read(…, pos), r, signal, { now, tracker })   // abort/超时 ⇒ 抛出 ⇒ finally
      if n === 0 break；pos += n
    sniff(buf, a.size) ⇒ binary | text ⇒ 合成 patch（下）
  finally:
    await boundedClose(() => a.fh.close(), { now, tracker, log })     // 独立 1 s deadline，不接请求 signal；超时由该竞速自己计 zombie
```

- abort / dispose：`signal` 触发 ⇒ 在途 `previewFsStep` 立即拒绝（底层 read 迟到 settle 由 tracker 计数并在 settle 时减回）⇒ finally 关闭。read 迟到完成写入的 buffer 被丢弃。
- 合成：`diff --git a/<rel> b/<rel>\nnew file mode 100644\n--- /dev/null\n+++ b/<rel>\n@@ -0,0 +1,<N> @@\n+<line>…`，不以 `\n` 结尾时追加 `\ No newline at end of file`；`N` = 实际输出行数；按 `PATCH_MAX` 截到行边界；空文件只有头部、零 hunk；读满上限时先 `utf8SafeCut`（`hub/preview/sniff.ts:240`）。
- **测试**（`untracked.test.ts`，假 fs + deferred）：正常路径 close 恰好 1 次；read 抛错 / 超时 / 请求 abort / dispose 各路径 close 恰好 1 次且 tracker 最终归 0；close 永不 settle ⇒ 应答照常发出、1 s 后 tracker=1、随后 settle ⇒ 0；read 迟到 settle 无 unhandled rejection；真实 tmpdir：符号链接 ⇒ 415 且 fd 已关（`/proc/self/fd` 计数前后相等）。

#### 3.1.2 `src/git/diff.ts` 冻结接口

```ts
export const WTDIFF_GIT_PATH = "/usr/bin:/bin"; // §2.7
export const WTDIFF_EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const; // 两者均经 `git hash-object -t tree --no-filters /dev/null` 实测
export interface StatusV2ZEntry {
  path: string;
  orig?: string;
  xy: string;
  kind: "1" | "2" | "u" | "?";
}
export interface StatusV2Z {
  oid: string | "(initial)" | undefined;
  entries: StatusV2ZEntry[];
  capped: boolean;
}
export function parseStatusV2Z(stdout: string, capped: boolean): StatusV2Z; // capped ⇒ 丢弃末尾不完整记录；"!" 忽略
export interface NumstatZEntry {
  path: string;
  orig?: string;
  add: number | null;
  del: number | null;
}
export function parseNumstatZ(stdout: string, capped: boolean): NumstatZEntry[];
export function combinedStatus(e: StatusV2ZEntry): "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | null;
export function parseHeadProbe(stdout: string): { format: "sha1" | "sha256"; oid: string } | null; // C0 两行输出
export const WTDIFF_DRIVER_NAME_RE: RegExp; // /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export function parseDriverScan(stdout: string, capped: boolean): { names: string[] } | { unsafe: true }; // Cc
export function driverNamesFromAttributes(text: string): { names: string[] } | { unsafe: true }; // info/attributes 超集提取（含宏行）
export function neutralizeArgs(names: readonly string[]): string[]; // L2：对每个名字无条件下发 filter.* 与 diff.* 置空
export function attrSourceArgs(format: "sha1" | "sha256"): string[]; // L1
export function parseCheckAttrZ(stdout: string): Map<string, string>; // path → filter 属性值
export const wtDiffArgs: {
  commonDir(cwd: string): string[]; // C1a
  worktreeList(cwd: string): string[]; // C1
  head(): string[]; // C0（含 PINNED_PREFIX）
  driverScan(): string[]; // Cc
  status(l1: string[], n: string[], untracked: "all" | "no"): string[]; // C2
  checkAttr(oid: string, paths: string[]): string[][]; // Ca，已分批
  numstat(l1: string[], n: string[], oid: string): string[]; // C3
  diff(l1: string[], n: string[], oid: string, path: string, orig?: string): string[]; // C4
};
```

`src/git/run.ts` 追加（全部可选，缺省行为逐字节不变）：

```ts
export const PINNED_PREFIX: readonly string[]; // ["-C","/proc/self/fd/3","--git-dir=/proc/self/fd/4","--work-tree=/proc/self/fd/3"]
export interface GitRunOptions {
  // …既有字段
  envPolicy?: "inherit" | "minimal"; // §2.7；minimal 时 PATH = WTDIFF_GIT_PATH 由调用方以 pathOverride 传入，run.ts 不 import diff.ts
  pathOverride?: string; // 仅 minimal 生效
  pins?: { wt: number; git: number; common: number }; // stdio[3..5]、cwd:"/"、env.GIT_COMMON_DIR=/proc/self/fd/5、强制 argv 以 PINNED_PREFIX 开头
}
```

（`run.ts` 不 import `diff.ts`，保持 §5 D1 的闭包常量表不变；`src/git/` 不 import web-hub protocol，状态字面量联合在 hub 侧用 `satisfies` 对齐。）

### 3.2 `parseUnifiedPatch` 规则（线性、永不抛）

1. 按 `\n` 切行（`\r` 保留在 text 中）。
2. 遇 `diff --git ` 开新 `PatchFile`；扩展头识别集：`new file mode`、`deleted file mode`、`old mode`、`new mode`、`similarity index`、`rename from`、`rename to`、`copy from`、`copy to`、`index `、`--- `、`+++ `、`Binary files … differ`、`GIT binary patch`；未知扩展头忽略。
3. hunk 头 `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/`，缺省计数 1，数字须安全整数，否则 `malformed` 并停止。
4. hunk 体**计数驱动**：`" "` ctx、`"-"` del、`"+"` add、`"\"` 给上一行置 `noEol`（不计数）、空行 ⇒ ctx；计数归零即结束。**计数未归零前，`---`/`+++`/`diff ` 开头的行一律按首字符当内容**（删除行 `-- x` 呈现为 `--- x`，必测）。
5. 计数未归零时遇不合语法的行 ⇒ `malformed:true`，丢弃其后；输入结束计数未归零 ⇒ `complete:false`（非 malformed）。
6. 行号：ctx `o=oldCur++`、`n=newCur++`；del `o=oldCur++`；add `n=newCur++`。
7. 处理行数（含 hunk 头与扩展头）达 `WTDIFF_PARSE_LINES_MAX` ⇒ `lineCap:true` 停止；hunk 数达 `WTDIFF_PARSE_HUNKS_MAX` ⇒ `hunkCap:true` 停止（**#8**：两个上限独立判定、先到先停；512 KiB 的 `-U3` patch 理论上可产生约 2.6 万个单行 hunk，每个 hunk 在 UI 多一行 hunk 头且是独立的分页单元，单靠行数上限不能约束 hunk 元数据的规模，故独立设限）。两种 cap 的 UI 降级 = 截断横幅（同 `truncated`）。
8. 多个 `diff --git` 块 ⇒ `files.length > 1`，UI 逐块渲染并插入块头。

### 3.3 文件类型处理表

| 类型                                                            | 清单                                                                                    | 单文件                             | UI                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| 修改                                                            | `M`，+a −d                                                                              | C4 patch                           | 分屏 / unified                                     |
| 类型变化（T）                                                   | `T`                                                                                     | C4（删 + 增两块）                  | 多块                                               |
| 暂存新增                                                        | `A`，+a −0                                                                              | C4（`new file mode`）              | 左栏全空位                                         |
| 删除                                                            | `D`，+0 −d                                                                              | C4（全删，**HEAD 内容**，附录 A1） | 右栏全空位                                         |
| 暂存重命名 / 复制                                               | `R`/`C` + `orig`                                                                        | C4 两个 pathspec                   | `orig → path`；无 hunk 时「仅重命名（相似度 N%）」 |
| 未暂存重命名（D + ?）                                           | 两条独立                                                                                | 各自                               | v1 不配对（§8）                                    |
| 冲突（`u`）                                                     | `U`                                                                                     | C4（带冲突标记）                   | 「冲突中」chip                                     |
| 未跟踪（`?`，`--untracked-files=all` 逐文件列出，**#5**）       | `?`，无计数                                                                             | §3.1.1；符号链接 ⇒ 415 symlink     | 左栏全空位 + 横幅                                  |
| 二进制 / >16 MiB                                                | `binary:true`                                                                           | `kind:"binary"`                    | 提示不渲染                                         |
| filter 管理（LFS 等）                                           | `filtered:true`                                                                         | 409 entry（UI 不会请求）           | 不可点 + 文案                                      |
| 依赖已提交 `eol` / `working-tree-encoding` / `ident` 属性的文件 | 可能出现（stat 失配时按原始字节比较）                                                   | C4 显示原始字节差异                | 已知限制（§2.6.2 副作用），脚注不单列              |
| 仅模式变化                                                      | `M`/`T`，+0 −0                                                                          | 零 hunk                            | 「仅权限变化」                                     |
| 子模块                                                          | **不出现**（D20）                                                                       | —                                  | 脚注解释 `*N` 差异                                 |
| CR/LF/非 UTF-8 文件名（U+FFFD）                                 | 正常列出（控制字符以可见符号渲染）                                                      | 不可请求                           | 禁用 + title                                       |
| 含 TAB 文件名（v3.1 勘误：可请求）                              | 正常列出（TAB 可见化）                                                                  | 可请求                             | 正常可点                                           |
| denylist 命中                                                   | **不出现**                                                                              | 403（字面）/ 409 entry             | 静态脚注                                           |
| HEAD 未诞生                                                     | 415 unborn                                                                              | —                                  | 「仓库尚无提交」                                   |
| `?` 目录                                                        | 不出现：`all` 模式下 git 不产生目录条目；解析器对以 `/` 结尾的 `?` 记录（防御）直接丢弃 | —                                  | —                                                  |

`--untracked-files=all` 的规模风险（大量未忽略的生成文件）由 `WTDIFF_STATUS_MAX_BYTES` / `WTDIFF_FILES_MAX` / 字节预算三层兜底，截断时 `limits.status`/`limits.files`/`limits.bytes` 告知 UI。`combinedStatus`：`?` ⇒ `?`；`u` ⇒ `U`；`2` ⇒ X 为 R/C；`1`：X=`A` 且 Y=`D` ⇒ null（丢弃）；X=`A` ⇒ `A`；X 或 Y=`D` ⇒ `D`；X 或 Y=`T` ⇒ `T`；其余 `M`。

### 3.4 分屏对齐（`ui/src/logic/wtdiff.js` 的 `buildSplitRows`）

```
rows = []
for file in parsed.files:
  if parsed.files.length > 1: rows.push({ t: "file", meta: file.meta })
  for hunk in file.hunks:
    rows.push({ t: "hunk", text: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@ ${section}` })
    i = 0; L = hunk.lines
    while i < L.length:
      if L[i].k === "ctx": rows.push({ t: "ctx", o, n, text, noEol }); i++; continue
      dels = []; adds = []
      while i < L.length && L[i].k !== "ctx": (L[i].k === "del" ? dels : adds).push(L[i]); i++
      for j in 0 ..< max(dels.length, adds.length):
        rows.push({ t: "pair", l: dels[j] ?? null, r: adds[j] ?? null })
```

够用论证：git 的 unified 输出是最小编辑脚本，「段内第 j 个删除 ↔ 第 j 个新增」即 VSCode / GitHub 分屏的配对口径；ctx 行保证两侧在每个上下文处重新对齐，空位只在段内出现、不跨段累积。DOM：每 row 一个元素，四格 `lnL | txL | lnR | txR` 同一 grid 模板，文本 `pre-wrap; overflow-wrap:anywhere`。

### 3.5 unified 行

每个 `PatchLine` 一行：`lnOld | lnNew | sign | text`；hunk 头跨四格；多文件块头同分屏。

### 3.6 不做行内高亮 / 语法高亮

行内高亮：v1 照 mockup 只给符号着色；`ui/src/logic/diff.js` 的配对前后缀裁剪（edit 卡片在用）可作 v1.1 零新算法升级。语法高亮：diff 是不连续片段，跨行结构着色错误，且 DOM 成本翻倍——不做。

### 3.7 渲染上限（UI）

首屏 `WTDIFF_RENDER_PAGE_ROWS = 2_000` 行，「显示更多（剩余 N 行）」每次追加 2 000；单行 `WTDIFF_LINE_DISPLAY_MAX = 2_000` 字符截断 + `…(+N)`；行尾 `\r` 渲染为暗色 `␍`；`truncated` / `complete:false` / `lineCap` / `hunkCap` ⇒ 截断横幅，`malformed` ⇒ 解析中断横幅。两个常量在 `ui/src/logic/wtdiff.js`。

---

## 4. UI

### 4.1 入口与面板改动（`components/detail/WorktreePanel.vue`）

- `DetailHeader.vue:226` 改为 `<WorktreePanel v-if="worktrees" :worktrees="worktrees" :agent-key="agent.agentKey" :session="session" />`；两个新 prop 可选。
- WorktreePanel `inject(HUB_CTX)`（`components/control/controlContext.ts:25`）取 `worktreeDiff` 与 hub caps、`inject(CONTROL_ENV)` 取 `authMode`/`plaintext`，算 `scope = wtdiffScopeOf(...)`（对齐 `previewScopeOf`，`ui/src/logic/preview.js:661-681`：password 模式额外要求 `preview.lan.v1`）。
- `rowDiffable(row)`：`scope !== null` ∧ `typeof row.path === "string"` ∧ 非 bare 非 prunable ∧（`dirty > 0` ∨ `dirtyCapped` ∨ `unprobed` 存在）。
- 可展开行的 `.wt-status`（`WorktreePanel.vue:160-166`）改为 `<button class="wt-status wtd-toggle" :aria-expanded :aria-controls>`（`*N` + chevron）；不可展开行保持原 `<span>`（I8，快照钉）。整行不可点（与行内 CopyButton 冲突）。
- 展开状态 `ref(new Set<string>())`（键 `row.path`，不持久化），`li.wt-item.is-expanded` 换行，内嵌 `<WorktreeFileList>`。

### 4.2 文件列表（`components/diff/WorktreeFileList.vue`）

- 每条原生 `<button class="wtd-file">`：状态徽章（`M/A/D/R/C/T/U/?`）、路径（`<bdi dir="ltr">`、`translate="no"`、控制字符以 `␊ ␍ ␉` 可见替换，仅显示层）、`+a −d`；R/C 显示 `orig → path`；`binary`/`U` 小 chip。
- **禁用规则（#7）**：`!isWtRequestableEntry(entry)` 的条目一律 `disabled`（覆盖 CR/LF/超长/非法段/U+FFFD/filtered，不只 lossy），`title` 按原因区分（「文件名含特殊字符，无法请求 diff」/「由 Git 过滤器管理」）。
- 列表底部**常显**静态脚注「受保护条目不显示；子模块变化不在此列出」（D14 / D20，不随数据条件显示——避免成为 oracle）。
- 状态：loading / ok / error（code+reason 映射 + 重试）/ empty（「没有可显示的变更」）。`truncated`、`untrackedSkipped`、`numstatPartial`、`attrPartial` 各有提示；刷新按钮；>200 条时容器限高滚动。

### 4.3 对话框（`components/diff/WorktreeDiffDialog.vue` + `DiffRows.vue` + `diffModal.ts`）

- **壳层（D12，diff 局部）**：`components/diff/diffModal.ts` 导出 `useDiffModal({ isOpen, panelEl, onClose })`——焦点进入 / Tab 循环 / 归还、Esc（`preventDefault + stopPropagation`）、backdrop 关闭、`acquireBodyScrollLock()`（`composables/useScrollLock.ts:25`，引用计数）、关闭 / 卸载必释放。逻辑参考 `PreviewHost.vue:128-197` 但**独立实现、不抽共享**、不改 PreviewHost。Tab 循环的可聚焦集只取已渲染且可见的元素。
- **头部**：徽章、标题、`+a −d`、视图分段按钮（`aria-pressed`；**移动视口用 `v-if` 移除而非 CSS 隐藏**，保证不进 Tab 循环——#11 测试钉）、刷新、CopyButton（`W/path`）、关闭；password+http 时显示明文传输提示。
- **侧栏头**（split）：`旧 · <base 前 7 位>` / `新 · 工作区`，sticky。
- **主体**：loading / binary / empty / symlink / error / patch；`DiffRows`（props `rows`/`mode`/`pageRows`），sr-only 前缀「删除」/「新增」，空位格 `aria-hidden`，行号 `user-select:none`。
- **横幅**：untracked、截断类、malformed、「工作区已变化」、仅重命名 / 仅权限 / 空文件。

### 4.4 移动降级

`useMedia(window, "(max-width: 767px)")`（`composables/useMedia.ts:28`）⇒ `effectiveMode = mobile ? "unified" : mode`；≤767px 对话框全屏、`100dvh`、safe-area（照 `styles/preview.css:79` 的写法）；行号列 `3.5ch`；文件条目最小高 40px。

### 4.5 状态机与刷新（`composables/useWorktreeDiff.ts`）

```ts
interface ListState {
  phase: "idle" | "loading" | "ok" | "error";
  data?: WtDiffFileList;
  error?: { code: string; reason?: string; retryable: boolean };
  sig: string;
  refreshing?: true;
}
type DialogState =
  | { phase: "closed" }
  | {
      phase: "loading" | "ok" | "error";
      wt: string;
      entry: WtDiffFileEntry;
      base: string;
      untracked?: "no";
      payload?: WtDiffFilePayload;
      parsed?: ParsedPatch;
      error?: { code: string; reason?: string };
      stale: boolean;
    };
export function useWorktreeDiff(deps: { transport: WorktreeDiffTransport; scope: Ref<WtDiffScope | null> }): {
  lists: Reactive<Map<string, ListState>>;
  dialog: Ref<DialogState>;
  mode: Ref<"split" | "unified">;
  toggleRow(row: WorktreeRowWire): void;
  refreshList(wt: string): void;
  openFile(wt: string, entry: WtDiffFileEntry): void;
  refreshDialog(): void;
  closeDialog(): void;
  onRowsChanged(rows: readonly WorktreeRowWire[]): void;
};
```

- 每次拉取一个 `AbortController`；同 wt 新拉取 abort 旧的；关闭 abort；scope 变 null 全清。
- `sig(row) = head|dirty|dirtyCapped|untrackedSkipped`；展开中签名变化 ⇒ 去抖 3 s 重拉清单；对话框所属行签名变化 ⇒ `stale` 横幅，不自动重拉。
- **`E_STALE_CTX` 处理（#1）**：`file` 收到 409 stale（`base` 或 `entry`）⇒ 自动重拉该 wt 清单；新清单仍有同一 `(path, orig)` 的可请求条目 ⇒ 用新 `base` 自动重试一次（只一次，防循环）；否则对话框显示「此文件已无变更或不可查看」+ 关闭 / 返回列表。
- `refreshDialog`：重拉清单 ⇒ 同上分支。

### 4.6 传输面（`transport/types.ts` 追加）

```ts
export interface WtDiffScope {
  agentKey: string;
  sessionId: string;
}
export type WtDiffOutcome<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string; reason?: string; retryAfterS?: number };
export interface WorktreeDiffTransport {
  files(
    req: WtDiffScope & { wt: string; untracked?: "no" },
    opts?: { signal?: AbortSignal },
  ): Promise<WtDiffOutcome<WtDiffFileList>>;
  file(
    req: WtDiffScope & { wt: string; base: string; path: string; orig?: string; untracked?: "no" },
    opts?: { signal?: AbortSignal },
  ): Promise<WtDiffOutcome<WtDiffFilePayload>>;
}
// Transport 追加：readonly worktreeDiff?: WorktreeDiffTransport;
```

两个 logic client 对称实现（照 `previewFetch` 的 deadline / 外部 signal 合并 / `withRelogin` / 有上限读 body 模式，`ui/src/logic/token-client.js:726-`）：超上限 abort ⇒ `E_BAD_RESPONSE`；`JSON.parse` → parser（null ⇒ `E_BAD_RESPONSE`）；错误体 `{error, reason}` 透传。`useHub.ts:771` 旁透传 `worktreeDiff`。

### 4.7 i18n / CSS / 纪律

- i18n：新命名空间 `i18n/{en,zh}/diff.ts`（`import.meta.glob` 自动收录）；compact token 英文、提示中文。
- CSS：新文件 `styles/diff.css`，类名一律 `wtd-` 前缀（`.diff*` 已被 edit 卡片占用，`styles/transcript.css:535-`）；颜色复用 `--diff-{add,del}-{soft,strong}`（`styles/tokens.css:50-54`）；`worktrees.css` 仅追加 `.wt-item.is-expanded` 与 `.wtd-toggle`。
- source-scan：无 `v-html`、无 `<style>`、无静态 `style=`、无 localStorage；路径与 patch 全部插值；不经 `markdown.js` / `PathText.vue`。

---

## 5. 分包实施计划

```
Wave 1（立即，可并行）： D0 协议冻结  ∥  D1 git 层（diff.ts + run.ts 三个可选项 + boundary 精确 allowlist）
Wave 2（并行）：        D2 UI 纯逻辑（待 D0）  ∥  D3 hub 路由（待 D0 + D1）  ∥  D4 UI 传输面（待 D0）
Wave 3：               D5 UI 组件（待 D2 + D4）
Wave 4：               D6 集成 + 文档（待 D3 + D5；AGENTS.md 待 preview P4 文档改动合入）
```

**错峰现状**：P1b（`deeed44`）与 P3（`83d6fc0`）已合入，hub / UI 文件无在飞冲突。工作树当前未提交的是 preview P4 的文档改动（`AGENTS.md`、`docs/dev/web-hub-preview/{acceptance,dir-plan}.md`、`tests/web-hub/http/preview-e2e.test.ts`、`i18n/en/shell.ts`）——本方案只有 D6 触及 `AGENTS.md`，排在其后；其余包与之无交集。

| 共享文件                                                                                                              | 触及包 | 规则                           |
| --------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| `hub/preview/**`                                                                                                      | —      | **冻结**：D3 只 import         |
| `hub/{hub,ports,audit,http}.ts`                                                                                       | D3     | 仅 D3                          |
| `transport/types.ts`、`logic/{token,password}-client.js`、`useHub.ts`、`contract.js`                                  | D4     | 仅 D4                          |
| `components/preview/**`、`usePreview*.ts`、`i18n/*/{preview,shell,detail}.ts`、`styles/{preview,dock,transcript}.css` | —      | **冻结**                       |
| `protocol/{version,http-contract}.ts`                                                                                 | D0     | 只尾部追加                     |
| `src/git/run.ts`                                                                                                      | D1     | 只加可选项，缺省行为逐字节不变 |
| `components/detail/{WorktreePanel,DetailHeader}.vue`、`styles/worktrees.css`                                          | D5     | 仅 D5                          |
| `AGENTS.md`、`docs/dev/worktree-web/plan.md`                                                                          | D6     | 待 preview P4 文档合入         |

### D3 的硬前置（条件接受 D1 / D15）

D3 合入前必须全部绿，缺一不合：

- **H1 驱动中和三层**：§2.6.3 T1–T13 全部（构造器层在 D1，端点层在 D6 复跑）；T9 必须同时证明残余存在与 L3 检测生效。
- **H2 环境 allowlist**：§2.7 键集合恰好相等、`PATH` 为常量、替身 git 不被调用。
- **H3 三 fd 钉住**：§5 D1 的 rename / delete / 符号链接替换竞态 + **linked worktree 的 `.git` 指针改写与 `commondir` 改写竞态**（下）+ run.ts `pins` 强制 argv 前缀与 `GIT_COMMON_DIR` 写入测试；commondir 改写竞态的验收口径 = **OID 可被重定向但内容读取 fail-closed，且无 env 对照组确实读出他库内容**（v3.1，见 §2.3）。
- **H4 无 index 写入**：每个端点调用前后 index `mtimeMs/size/ino` 相等、`post-index-change` marker=0。
- **H5 预算总账**：§1.9 关系钉 + `budget.test.ts`（§5 D3）。

### D0 · 协议冻结（小，L1）

- **文件域**：新增 `protocol/worktree-diff.ts`（§1.3）；`protocol/version.ts`；`protocol/http-contract.ts`；新增 `tests/web-hub/protocol/worktree-diff.test.ts`。
- **冻结面**：其余全部。
- **测试**：`validateWtRelPath` 正反例（`.git`、`a/.git/b`、`..`、`./x`、`/abs`、NUL、CR、LF、4096/4097 字节、多字节、`-rf` 合法）；`isWtRequestableEntry` 真值表（CR/LF/TAB/U+FFFD/超长/非法段/filtered/orig 各一）；`WTDIFF_BASE_RE`；两个 envelope parser 每条拒绝条件一例 + 字节上限 ±1 + 「CR/LF 路径可解析但不可请求」；`parseUnifiedPatch`：常规 / 多 hunk / 新增 / 删除 / 重命名无 hunk / 仅模式 / binary 两种 / `\ No newline` 两侧 / **删除行以 `--` 开头** / 空白上下文空行 / 截断 / 非法行 / 非法 hunk 头 / 多文件块 / **hunk 上限边界：10 000 个 hunk ⇒ hunkCap=false、10 001 ⇒ true** / **行上限边界：50 000 / 50 001** / 性质测试（固定 seed 2 000 例：计数自洽、行号单调）/ 线性操作计数（比值法）；预算关系钉（§1.9 五条）。
- **验收**：`npx vitest run tests/web-hub/protocol && npm run typecheck && npm run format:check`。

### D1 · git 层（小→中，L2）

- **文件域**：新增 `src/git/diff.ts`（§3.1.2）；`src/git/run.ts`（`envPolicy?: "inherit" | "minimal"`、`pathOverride?`、`pins?: { wt, git, common }` + `PINNED_PREFIX` 导出与 argv 前缀强制 + 钉住模式写入 `GIT_COMMON_DIR`，§3.1.2）；新增 `tests/git/diff.test.ts`；`tests/git/run.test.ts`（追加）；新增 `tests/integration/git-wtdiff.test.ts`（真实 git）；`tests/web-hub/boundary.test.ts`（#12，见下）。
- **boundary（#12，精确 allowlist + 闭包断言）**：`src/web-hub/hub/**` 的相对 import 若解析到 `src/web-hub/{protocol,hub}` 之外，**只允许**精确落在 `src/git/run.ts`、`src/git/worktrees.ts`、`src/git/diff.ts` 三个文件之一（不是 `src/git/**`）；闭包断言：这三个文件的 import 集合必须**恰好**是 `run.ts → {node:child_process}`、`worktrees.ts → {node:fs, ./run.js(type)}`、`diff.ts → {}`（以测试内常量表写死，新增任何 import 即红）。删除 v1「src/git 只 import node:* 即隔离」的表述——`node:*` 本身包含 `child_process`/`fs` 等强能力，隔离靠的是精确文件表与闭包常量表。
- **冻结面**：`src/git/{worktrees,path-label}.ts`、`src/web-hub/agent/**`、`src/hud/**`。
- **测试**：`parseStatusV2Z`（四类记录、`!` 忽略、`# branch.oid` 三态、CR/LF/TAB/非 UTF-8 路径、capped 丢末条、`2` 缺 orig 丢弃、以 `/` 结尾的 `?` 丢弃）；`parseNumstatZ`；`combinedStatus` 真值表；`parseDriverScan`（正常、`[filter "a=b"]`、空白名、17 个、capped ⇒ unsafe）；`driverNamesFromAttributes`（普通行、宏定义行、`-filter`/`!filter`、`filter=a=b` ⇒ unsafe）；`neutralizeArgs` 快照（对无配置的名字同样下发）；`attrSourceArgs` 两种对象格式；`parseHeadProbe`；`wtDiffArgs` 逐字节快照（请求值只在 `--` 之后或 oid 位；`path="--output=/tmp/x"` 位于 `--` 之后）；`run.ts`：§2.7 env 键集合、`pins` 时 stdio[3..5]、`cwd:"/"`、env `GIT_COMMON_DIR=/proc/self/fd/5`（调用方传入的同名值被忽略）、argv 不以 `PINNED_PREFIX` 开头 ⇒ spawnError 且未 spawn；**真实 git（`skipIf(!hasGit)`）**：§2.6.3 的构造器层全部场景；`--untracked-files=all` 嵌套未跟踪目录逐文件列出（**#5**）；diff-index 前后 index stat 相等（H4）；**fd 钉住竞态（H3）**：钉住 → 把 W 改名并在原路径新建空目录 → `head()`/`status()` 仍返回原仓库结果；钉住 → 删除 W → 命令以非零退出、无挂起；钉住 → 原路径换成指向别的仓库的符号链接 → 仍是原仓库结果；**linked worktree 指针竞态（二轮 #5）**：钉住后把 `W/.git` 改写为 `gitdir: <另一仓库的 worktree 条目>` ⇒ C0 / C2 仍返回原仓库的 HEAD 与状态；钉住后把 `<gitdir>/commondir` 改写为指向另一仓库 ⇒ C0 可解析出他库 OID（refs 仍读 commondir 文件，§2.3 v3.1）但 C2 / C4 以 `bad object` 非零退出、输出不含他库内容；对照组（只给 `--git-dir`、不写 `GIT_COMMON_DIR`）在 `commondir` 改写后 C4 **确实读出他库文件内容**——证明该测试能发现 v2 的缺陷；**HEAD 竞态（二轮 #1）**：C0 后、C4 前把 HEAD 移到另一提交 ⇒ C4 输出仍是相对 C0 oid 的 diff（以 `diff-index <C0 oid>` 的期望输出逐字节比对）；C0 后、C2 前移动 HEAD ⇒ C2 的 `# branch.oid` 与 C0 不等，被识别；**PATH**：在 `PATH=/usr/bin:/bin` 下全部 argv 执行成功（git 不在该 PATH 时整组 skip 并打印原因）。
- **验收**：`npx vitest run tests/git tests/integration/git-wtdiff.test.ts tests/web-hub/boundary.test.ts && npm run typecheck`。

### D2 · UI 纯逻辑（小，L1；待 D0）

- **文件域**：新增 `ui/src/logic/wtdiff.js`（`wtdiffScopeOf`、`rowDiffable`、`rowSig`、`buildSplitRows`、`buildUnifiedRows`、`clipLine`、`displayPath`（控制字符可见化）、`statusBadge`、`formatStat`、两个渲染常量）；新增 `tests/web-hub/ui/logic-wtdiff.test.ts`。
- **冻结面**：`logic/diff.js`、`logic/preview.js`、组件、传输、protocol。
- **测试**：scope 真值表；`rowDiffable`；`buildSplitRows` 以 mockup FILES 数据转成的 patch 为 fixture 逐行快照 + 性质测试（`pair` 两侧不同时 null、两栏非空行号单调、左栏非空格数 = del+ctx）；`buildUnifiedRows` 行数守恒；`clipLine` 边界（代理对不切半）；`displayPath` 对 CR/LF/TAB。
- **验收**：`npx vitest run tests/web-hub/ui/logic-wtdiff.test.ts && npm run typecheck`。

### D3 · hub 路由 + 接线（中→大，L2/L3；待 D0 + D1，H1–H5 为合入闸门）

- **文件域**：新增 `hub/worktree-diff/{routes,membership,changeset,git,untracked}.ts`；`hub/ports.ts`；`hub/http.ts`；`hub/hub.ts`；`hub/audit.ts`；新增 `tests/web-hub/hub/worktree-diff/{routes,membership,changeset,untracked,budget,head-binding,source-scan}.test.ts`；`tests/web-hub/hub/{audit,caps-coexist,hub-preview}.test.ts`（追加）；新增 `tests/web-hub/http/api-worktree-diff.test.ts`。
- **冻结面**：`hub/preview/**`（只 import `denyListHit`、`isVirtualFsPath`、`createFsAdmitter`、`previewFsStep`、`createPreviewIoTracker`、`boundedClose`、`defaultPreviewFs`、`sniff`、`utf8SafeCut`、`previewProcFdAvailable`）、`hub/file-search.ts`、`hub/spawn/**`（只 import `withinRoot`）、`protocol/**`、`src/git/**`、`ui/**`、`agent/**`。
- **测试**：
  - `routes.test.ts`（假 runner + 假 fs）：§1.5 矩阵逐行；**#1 绑定**：base 为合法 hex 但 ≠ 当前 HEAD ⇒ 409 base 且 C4 从未执行；base = HEAD 但 path 不在变更集（含：历史上存在过的文件、被隐藏的 `.env`、filtered 条目、CR 文件名、`orig` 不匹配）⇒ 409 entry 且 C4 从未执行；变更集缓存命中 / TTL 过期 / HEAD 变化 / index stat 变化 ⇒ 重算；单飞（并发同键只算一次、加入者断开不影响、全断开 ⇒ abort）；numstat / check-attr 失败降级；字节上限截断；**隐藏项不影响 `total` / `truncated` / `limits` / `files` 审计字段**（构造 3 可见 + 2 隐藏 ⇒ total=3）；dispose（in-flight abort、钉住 fd 被关、≤1 s、幂等、之后 503）；hub 输出 ⇄ parser 运行时契约；**429 审计节流**（§2.9）。
  - `membership.test.ts`：字面命中 / realpath 扇出命中 / 64 行扇出上限外的字面命中仍成立（#9：匹配在完整输出上）/ 扇出超限未命中 ⇒ not-worktree / bare / prunable 命中 ⇒ not-worktree / porcelain 截断未命中 ⇒ not-worktree / dev/ino 不符 ⇒ not-worktree / open 后失败 ⇒ pin 被关闭且不返回 / C1 超时 / git 缺失；**gitdir / commondir（二轮 #5）**：主 worktree `.git` 是文件 ⇒ not-worktree；linked 的 `.git` 是目录 ⇒ not-worktree；`.git` 内容不匹配 `gitdir:` 格式 / 超过 4 KiB ⇒ not-worktree；gitdir 不在 `<common>/worktrees/` 名下（指向另一仓库的条目）⇒ not-worktree；主 worktree gitdir ≢ commondir ⇒ not-worktree；任一失败路径下已打开的 pin 全部关闭（假 fs 计数）；**commondir 语义（v3.1，吸收 D1 偏离 #1）**：git 2.53 的 refs 仍读 `<gitdir>/commondir` 文件，membership 的 fd 钉住只覆盖 index / HEAD symref / objects / 仓库 config——路由层不得以「C0 成功」推断内容可用：C0 解析出重定向 OID 后，后续 C2 / C4 会 fail-closed（`bad object` 非零退出），须映射为错误（git failed 日志）而非把失败输出当清单数据；`routes.test.ts` / `head-binding.test.ts` 须含「C0 成功但 C2 非零」分支。
  - `changeset.test.ts`：键构成、TTL、LRU、值中无内容字段（结构断言）。
  - `untracked.test.ts`：§3.1.1 全部所有权用例。
  - `budget.test.ts`（假时钟 + deferred runner / fs，H5）：认证用掉 3 s 后 membership 仍有完整 2 s 单步；准入阶段 C1 卡死 ⇒ 2 s 单步超时 ⇒ 504，且 git 阶段从未开始；准入阶段用满 7.9 s 后 git 阶段仍有完整 14 s（独立追加）；C0 + Cc + attrs + C2 用满 13 s 后 C4 答 504、C3 跳过并置 `numstatPartial`；L3 预算不足 ⇒ 503 attr-changed（fail-closed）；finally 的 `boundedClose` 在请求已 abort 时仍执行，且三个 pin 并行关闭总时长 ≤ 1 s + ε；任一 pin close 永不 settle ⇒ 应答照常、tracker 计 1、settle 后归 0。
  - `head-binding.test.ts`（#1）：缓存中存在 oid=X 的变更集、本请求 C0=Y ⇒ 不命中、重算；file 请求 base=X 而 C0=Y ⇒ 409 base 且 C4 未执行；C2 报 `# branch.oid` ≠ C0 ⇒ 409 base；C4 argv 中的 oid 恒等于本请求 C0（构造器调用记录断言）。
  - `source-scan.test.ts`：`hub/worktree-diff/**` 不 import `node:fs*` / `node:child_process`；每个 `run(` 调用点实参含 `envPolicy: "minimal"` 与 `signal`，C1a / C1 之外还含 `pins`；argv 只来自 `wtDiffArgs.*` 与 `neutralizeArgs`；审计只经 `auditWorktreeDiff`。
  - `api-worktree-diff.test.ts`（真实 http 前端 + 假 runner）：loopback 401；LAN `mode:"loopback"` 404 逐字节同未启用；LAN `mode:"on"` 可用；`worktreeDiff` 缺省回落；gzip；无 `/proc`（注入 `previewProcFdAvailable:false`）⇒ 无 cap、端点回落。
- **验收**：`npx vitest run tests/web-hub/hub tests/web-hub/http tests/git tests/integration/git-wtdiff.test.ts && npm run typecheck && npm run format:check`。

### D4 · UI 传输面（小，L2；待 D0）

- **文件域**：`ui/src/transport/types.ts`；`ui/src/logic/{token,password}-client.js`；`ui/src/transport/{token,password}.ts`；`ui/src/logic/contract.js`；`ui/src/composables/useHub.ts`；`tests/web-hub/ui/{transport-contract,logic-contract}.test.ts`；`tests/web-hub/contract/types.test-d.ts`。
- **冻结面**：组件、其余 composables、protocol、hub。
- **测试**：两个 client 在 files / file 成功、401 relogin 重放、超时、外部 abort、body 超上限、gzip、JSON 坏、schema 坏、409 stale 的 `{error, reason}` 透传、URL 编码（空格 / `#` / `%` / 中文 / 以 `-` 开头）逐字一致。
- **验收**：`npx vitest run tests/web-hub/ui tests/web-hub/contract && npm run typecheck`。

### D5 · UI 组件（中，L2，前端车道；待 D2 + D4）

- **文件域**：新增 `ui/src/composables/useWorktreeDiff.ts`；新增 `ui/src/components/diff/{WorktreeFileList.vue, WorktreeDiffDialog.vue, DiffRows.vue, diffModal.ts}`；新增 `ui/src/styles/diff.css`、`ui/src/i18n/{en,zh}/diff.ts`；`components/detail/WorktreePanel.vue`；`components/detail/DetailHeader.vue`（只改 L226）；`styles/worktrees.css`；测试见下。
- **冻结面**：同错峰表。
- **测试**：
  - `worktree-panel.test.ts`（追加）：无 scope / 无 path / clean 行 DOM 与旧快照逐字节一致；可展开行 `button[aria-expanded]`；展开拉一次、收起不重拉；签名变化 3 s 去抖重拉。
  - `worktree-file-list.test.ts`：所有 `!isWtRequestableEntry` 条目 disabled（CR、LF、U+FFFD、超长、filtered 各一）且 title 区分；控制字符可见化；**静态脚注在 0 条 / 有条目 / 错误态都存在**；截断与降级提示。
  - `worktree-diff-dialog.test.ts`：聚焦、Tab 循环、Esc 不冒泡、backdrop、面板内点击不关、归还焦点、释放滚动锁（关闭与卸载）；split/unified 切换；**移动视口：切换按钮不在 DOM 中、Tab 循环序列不含它（#11）**；六态主体；横幅；分页追加；无 `v-html`。
  - `use-worktree-diff.test.ts`：abort 规则；**409 stale ⇒ 自动重拉清单 ⇒ 条目仍在则以新 base 重试恰好一次、否则显示不可查看态**；stale 横幅不自动重拉。
  - `diff-modal.test.ts`：壳层语义（与 `preview-host.test.ts` 壳层用例同语义，但独立实现）。
  - `i18n-parity`、UI `source-scan` 自动覆盖。
- **验收**：`npx vitest run tests/web-hub/ui && npm run typecheck && npm run build:web`。

### D6 · 集成 + 文档（小，L1）

- `tests/integration/web-hub-worktree-diff.test.ts`（`skipIf(!hasGit)`，真实 hub 进程 + 真实临时仓库，主 worktree + 一个 linked worktree）：清单（M/A/D/R/?/嵌套未跟踪/binary）；`.env` 修改 ⇒ 清单不出现、`total` 不计、直接请求 403；**任意历史读取（#1）**：用更早提交的 OID 作 base ⇒ 409 base；用当前 HEAD + 一个历史上删除过、现已不在变更集的路径 ⇒ 409 entry；§2.6.3 端点层全部场景（H1）；H4 index stat 断言；非成员目录 ⇒ 403；hub close 时 in-flight 请求终止、无残留 git 进程（按进程组探测）、钉住 fd 已关。
- 文档：新增 `docs/dev/worktree-diff/acceptance.md`（§6）；`docs/dev/worktree-web/plan.md` 末尾追加修订注记（D15 条件 + H1–H5）；`AGENTS.md` web-hub 段新增「Worktree diff」小节（端点、cap、mode 门、Linux-only、hub 执行 git 的条件与中和机制、`diff-index` 而非 `diff` 的理由、驱动扫描正则的维护规则、新增资产类别（以附录 A1 的拍板结果为准））。
- **验收**：`npm test && npm run typecheck && npm run build && npm run build:web && npm run format:check`。

---

## 6. 真机验收（`docs/dev/worktree-diff/acceptance.md`）

- **W1 入口**：本仓库有改动时行显示 `*N` 按钮；展开后条目与 `git status --untracked-files=all`（减去受保护项与子模块）一致，计数与 numstat 一致。
- **W2 分屏**：多 hunk 修改文件：左旧右新、双栏行号、红删绿增、`@@` 头、段内配对 + 空位补齐，观感同 mockup；长行换行后两侧同行。
- **W3 单屏**：双行号 + 符号列；会话内记忆，刷新复位。
- **W4 手机**：LAN 手机（`mode:on`）：全屏、强制单屏、无切换按钮。
- **W5 文件类型**：未跟踪（含嵌套目录里的新文件）、删除、暂存重命名、二进制、仅 chmod、冲突各一。
- **W6 linked worktree**：`pi-agent-*` 行可查看；devtools 改 `wt` 为非成员目录 ⇒ 403。
- **W7 准入**：仓库内修改 `.env` ⇒ 清单不出现、脚注常显；devtools 直接请求 ⇒ 403；审计行无路径。
- **W8 历史读取**：devtools 把 `base` 改成更早的提交 ⇒ 409，对话框自动重拉后显示当前内容；把 `path` 改成不在清单里的文件 ⇒ 409 + 「不可查看」。
- **W9 大文件**：2 MB 生成文件 ⇒ 截断横幅不卡顿；>16 MiB ⇒ 二进制提示。
- **W10 刷新**：对话框打开时 agent 改该文件 ⇒「工作区已变化」横幅；刷新 ⇒ 新内容；文件被提交后刷新 ⇒「已无变更」；agent 提交导致 HEAD 前移 ⇒ 下一次点击自动重拉清单后正常显示。
- **W11 LFS**：在装有 git-lfs 的仓库修改 LFS 文件 ⇒ 条目标「由 Git 过滤器管理」不可点；`git lfs` 未被调用（`GIT_TRACE` 不可用时以 `strace -f -e execve` 抽查）。
- **W12 mode 门 / 版本错配 / 键盘**：`"loopback"` 下手机无入口；旧标签页 × 新 hub 无报错；Tab 循环与 Esc 归还焦点正常。
- **W13 版本与路径**：在本机确认 `git --version` 支持 `--attr-source`、`which git` 位于 `/usr/bin` 或 `/bin`；否则展开清单显示「git 版本过旧 / 不可用」文案而非报错面板。
- **发布前**：仓库配置 `filter.x.clean` 与 `diff.external` 指向 `touch /tmp/ran` 脚本、`.gitattributes` 绑定后打开 diff ⇒ `/tmp/ran` 不存在；`.git/index` mtime 不变。

---

## 7. 风险表

| #   | 风险                                                          | 等级                         | 缓解                                                                                      |
| --- | ------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| R1  | 外部驱动执行（filter / textconv / ext diff / hooks）          | 高（若漏做）                 | §2.6 预扫描 + 中和 + fail-closed + 子模块忽略 + hooksPath；H1 闸门                        |
| R2  | 任意历史读取                                                  | 高（若漏做）                 | D8 / I11；D3 / D6 专项测试                                                                |
| R3  | LAN 暴露当前变更文件的 HEAD 版本                              | 中（**已拍板接受**，A1 (a)） | 收窄后范围见附录 A1；`"loopback"` 可随时收紧                                              |
| R4  | index 写入 / `index.lock` 冲突                                | 中（若漏做）                 | plumbing + `--no-optional-locks` + hooksPath；H4 闸门                                     |
| R5  | 驱动残余：窗口内同时新增 info/attributes 驱动名与对应配置命令 | 低（残余，同 uid）           | L1 + L2 使其余全部时序失效；L3 检测并丢弃结果、告警；T9 复现                              |
| R6  | 大仓库 / `--untracked-files=all` 体量                         | 中                           | 三层上限 + 超时 504 + 行降级 `untracked=no`                                               |
| R7  | 巨型 diff 拖垮浏览器                                          | 中                           | 512 KiB + 行 / hunk 双上限 + 分页 + 单行截断                                              |
| R8  | git 进程 / fd 泄漏                                            | 低                           | 进程组 SIGKILL 同步 settle；pin 与未跟踪句柄唯一关闭责任 + boundedClose；集成测试探测残留 |
| R9  | argv / 环境注入                                               | 高（若漏做）                 | I4 + §2.7 allowlist + 构造器快照 + source-scan；H2 闸门                                   |
| R10 | 路径 / 仓库竞态                                               | 低                           | 三 fd 钉住（I14）+ HEAD 唯一读取点（I15）；残余见 §2.3                                    |
| R11 | git 新版本新增执行型配置                                      | 低                           | Cc 正则维护规则 + git 升级时跑 H1 集成测试                                                |
| R12 | `*N` 与清单条数不一致引起困惑                                 | 低                           | 静态脚注                                                                                  |
| R13 | 无 `/proc` 平台无此功能                                       | 低                           | fail-closed、不声明 cap（D21）                                                            |
| R14 | `.diff*` CSS 撞名                                             | 低                           | `wtd-` 前缀                                                                               |
| R15 | git 安装在固定 PATH 之外（linuxbrew / nix）                   | 低                           | 503 git-unavailable，功能不可用；§8 不做可配置路径                                        |
| R16 | L1 使已提交 eol / encoding / ident 属性失效导致误报           | 低                           | 已知限制，Linux 工作树影响面小；§8                                                        |
| R17 | git 过旧不支持 `--attr-source`                                | 低                           | 503 git-too-old，运行时探测                                                               |

## 8. 不做（v1 范围外）

行内高亮（v1.1 候选，复用 `logic/diff.js`）；语法高亮；暂存 / 未暂存分视图；可选 diff 基准（main / upstream / 任意提交——与 I11 冲突，需另行设计授权）；提交历史 diff；任何写操作；对话框内上一个 / 下一个文件；展开更多上下文；虚拟滚动；视图偏好持久化；图片 diff；**子模块变化展示**（需逐子模块驱动扫描）；未暂存重命名配对；HEAD 未诞生仓库；diff 内路径预览链接；内容缓存与 fs watch；对话框自动刷新；StatusInfo 承载清单；独立设置开关；按 listener 区分范围；壳层抽共享（PreviewHost 与 diffModal 合并，另立项）；无 `/proc` 平台；可配置 git 二进制路径 / PATH；对已提交 `eol` / `working-tree-encoding` / `ident` 属性的忠实处理（L1 的代价）；**agent 采样器的驱动中和加固**（同类问题，另立项）。

---

## 附录 A：用户拍板记录

| #   | 事项                                         | 结论                                                     | 依据                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | LAN（`mode:"on"`）上暴露变更文件的 HEAD 版本 | **(a) 接受，LAN 与 loopback 同宽**——用户 2026-10-08 拍板 | U1（LAN 唯一用户、密码认证、风险明示接受）。收窄后的暴露面：preview 之外额外流出 ① 当前变更集中已修改文件在**本请求 C0 解析的 HEAD** 里的版本（±3 行上下文）；② 已删除文件在该 HEAD 里的全文（仅当其路径在当前变更清单中）。任何更早的历史版本、任何不在变更集中的路径、任何 denylist 命中项都不可达（D8 / I11 / I15）。收紧路径：`webHub.preview:"loopback"`（LAN 上 preview 与 diff 一并关闭，零代码差异） |

**已由主会话裁定**：D15 hub 执行 git——条件接受，H1–H5 为 D3 合入闸门；D14 denylist 名称——撤回 v1 偏离，对齐 dir-plan。**当前无待决项。**

## 9. 修订记录

### 9.1 v2 · 评审第一轮处置（1 Blocker / 6 Major / 5 Minor / 1 Nit）

| #   | 严重度  | 处置                                                                                                                                                                                                                                                                                                                                                                                                            | 落点                                                             |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Blocker | **修**：base 逐请求比对当前 HEAD（409 base）；`(path, orig)` 必须恰好是服务端为 `(W, HEAD)` 刚算出的变更集中的可请求条目（409 entry）；变更集 ≤5 s TTL 单飞缓存（键 = W 的 dev:ino + HEAD + index stat + untracked 模式），不签发快照；UI 收到 stale 自动重拉、至多重试一次；写入协议契约 I11                                                                                                                   | §0.1 D8、§0.2 I11、§1.5、§1.7 ⑦⑨⑩p、§1.10、§4.5、§5 D3/D6、§6 W8 |
| 2   | Major   | **修 + 部分反驳**：威胁模型重写、删除「只读 git」表述；实测触发矩阵（含新发现：porcelain `diff` 写 index、触发 hook ⇒ 改 plumbing `diff-index`）；缓解改为「扫描配置驱动 + 空值中和 + fail-closed 降级 + check-attr 标 filtered」，**反驳「扫描 attributes 来源命中即降级」**：attributes 不执行任何东西、来源不可有界穷举，执行的唯一来源是配置驱动（理由见 §2.6.2）；「与采样器同面」降为背景；补集成测试设计 | §0.1 D15/D17/D18/D20、§0.2 I12/I13、§2.1、§2.6、§2.10、§5 H1/H4  |
| 3   | Major   | **修**：`envPolicy:"minimal"` 最小 allowlist（PATH / HOME / XDG_CONFIG_HOME 继承，四个强制值），完整策略表；测试断言子进程键集合恰好相等、任何白名单外 `GIT_*` 缺席                                                                                                                                                                                                                                             | §0.1 D19、§2.7、§5 D1/H2                                         |
| 4   | Major   | **修（实测可行）**：`open(W, O_DIRECTORY\|O_NOFOLLOW)` 钉住，`run.ts` `cwdFd` 映射为子进程 fd 3、强制 argv 以 `-C /proc/self/fd/3` 开头；spawn 前 dev/ino 复核；残余窗口明示；rename / delete / 符号链接替换三种竞态测试；无 `/proc` 平台 fail-closed 不声明 cap                                                                                                                                                | §0.1 D4/D21、§1.8、§2.3、§5 D1/H3                                |
| 5   | Major   | **修**：`--untracked-files=all` + 三层预算兜底；目录条目不出现（解析器防御性丢弃以 `/` 结尾的 `?`）；删除 C5；补真实 git 嵌套未跟踪目录测试                                                                                                                                                                                                                                                                     | §1.8 C2、§3.3、§5 D1                                             |
| 6   | Major   | **修（撤回 v1 偏离）**：命中项隐藏、不计 total、不进入任何派生字段与审计计数；静态脚注常显；`total` 语义改为「已解析且未隐藏」                                                                                                                                                                                                                                                                                  | §0.1 D14、§1.3、§2.5、§2.8、§4.2、§5 D3/D5                       |
| 7   | Minor   | **修**：协议新增 `isWtRequestableEntry` 作为「可展示但不可请求」唯一判定（parser 接受 CR/LF/TAB/U+FFFD，可请求性另判）；UI 对所有不可请求条目禁用；hub 只把可请求条目放入变更集；端到端契约测试                                                                                                                                                                                                                 | §1.3、§2.4、§4.2、§5 D0/D5                                       |
| 8   | Minor   | **修**：独立 `WTDIFF_PARSE_HUNKS_MAX`（10 000）+ `hunkCap`，论证为何行上限不足；边界测试 10 000 / 10 001 与 50 000 / 50 001                                                                                                                                                                                                                                                                                     | §1.3、§3.2 第 7 条、§5 D0                                        |
| 9   | Minor   | **修**：membership 在完整有界 porcelain 输出上做字面匹配，64 只限 realpath 扇出；删除不可达的「bare ⇒ 415」分支，统一为 not-worktree                                                                                                                                                                                                                                                                            | §1.5、§2.3、§5 D3                                                |
| 10  | Minor   | **修**：未跟踪读取的 `PreviewHandle` 唯一关闭责任 = `readUntracked` 的 finally（`boundedClose`）；pin 同样写死；abort / dispose / 迟到 I/O 的 fd 与 tracker 收敛测试                                                                                                                                                                                                                                            | §2.3、§3.1.1、§5 D3                                              |
| 11  | Minor   | **修**：P1b / P3 已合入，更新波次与冻结面；D2 / D3 / D4 并行（D3 待 D0+D1，D4 待 D0，D5 待 D2+D4）；壳层为 diff 局部 `diffModal.ts`；移动视口切换按钮 `v-if` 移除并测试不进 Tab 循环                                                                                                                                                                                                                            | §0.1 D12、§4.3、§5 波次 / 错峰表 / D5                            |
| 12  | Minor   | **修**：boundary 改为精确文件 allowlist（三文件）+ 闭包 import 常量表断言；删除「node:* 即隔离」表述                                                                                                                                                                                                                                                                                                            | §1.1、§5 D1                                                      |
| 13  | Nit     | **修**：I7 明确 429 例外（60 s 窗口每 principal 一行），测试钉住                                                                                                                                                                                                                                                                                                                                                | §0.2 I7、§2.9                                                    |

**新增发现（评审未列，实测得出）**：porcelain `git diff <commit>` 即使 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0` 仍写 index 并触发 `post-index-change`（git 2.53）——已改为 plumbing `diff-index`（D17 / §2.10 / H4）；子模块会在子模块内再拉起 git 读取其自身配置，驱动中和覆盖不到——v1 忽略子模块（D20）。

### 9.2 v3 · 评审第二轮未闭合项处置

| #   | 问题                      | 处置                                                                                                                                                                                                                                                                                                                                                                                                        | 落点                                             |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | HEAD→C4 竞态              | **修**（按裁定）：HEAD 的唯一读取点 = 本请求在三 fd 钉住链上执行的 C0；C3 / C4 只接受显式 oid、C2 的 `branch.oid` 只作复核（不等 ⇒ 409）；缓存键带本请求 C0 oid；`file` 的 base 以本请求 C0 为准；窗口关闭点写在管线 ⑦；HEAD 移动竞态测试                                                                                                                                                                   | D8、I15、§1.7 ⑦⑨、§1.10、§5 D1 / D3 head-binding |
| 2   | filter 配置 TOCTOU        | **修**（取裁定两条路的组合，选可证伪的）：去掉两段式——L1 `--attr-source=<空树>` + `attributesFile=/dev/null` + `GIT_ATTR_NOSYSTEM=1` 收缩属性来源（实测仅剩 info/attributes）；L2 对「配置驱动名 ∪ info/attributes 驱动名」无条件置空；L3 事后复核检测残余。未采用「临时遮蔽 info/attributes」（需写仓库文件，违反 I9）。窗口注入式测试 T1–T13，T9 证明残余存在且被检测                                     | D18、I13、§2.6.1 新行、§2.6.2、§2.6.3、R5        |
| 3   | 预算漏算 membership / pin | **修**：两阶段 + finally——准入阶段 8 s（认证 + C1a + C1 + 全部 fs 步骤与三 fd 钉住，每步 ≤2 s，同 preview）；git 阶段 14 s 独立追加（含每条命令前的 pin fstat 复核与 L3）；finally 关闭各自 1 s；总账表 + 关系钉 + `budget.test.ts`                                                                                                                                                                         | §1.3 预算常量、§1.9、§5 H5 / D3                  |
| 4   | PATH 未固定               | **修**：`PATH` 固定为 `/usr/bin:/bin`（实测本机最小集，全部子命令为内建）；替身 git 测试；非标准安装 ⇒ 503 git-unavailable                                                                                                                                                                                                                                                                                  | D19、§2.7、R15、§8                               |
| 5   | `.git` 指针未钉住         | **修（实测可行）**：membership 经钉住的 W 读 `.git`，定位并钉住 gitdir（fd 4）与 commondir（fd 5），dev/ino 校验从属（主 worktree：gitdir ≡ commondir；linked：`<common>/worktrees/<name>` ≡ gitdir）；git 以 `--git-dir=/proc/self/fd/4` + `GIT_COMMON_DIR=/proc/self/fd/5` 运行，指针文件与 `commondir` 文件在 membership 后不再被读取；写入 I14；指针 / commondir 改写竞态测试（含证明 v2 缺陷的对照组） | D4、I3、I14、§1.8、§2.3、§5 H3 / D1              |
| 6   | A1 已闭合                 | **改**：D6、§0.3、R3、附录 A 改为「用户 2026-10-08 拍板 (a)」并记录依据与收窄后的暴露面                                                                                                                                                                                                                                                                                                                     | D6、§0.3、R3、附录 A                             |

**反驳**：无。第 2 条在裁定给出的两个方向中取了组合而非二选一——单独「无条件置空已声明驱动名」仍无法覆盖「已提交 `.gitattributes` 引用、扫描后才出现配置命令」的名字（名字在扫描时不可见），单独「NOSYSTEM + attributesFile」不覆盖仓库级来源；L1（实测）消除前者，L2 覆盖唯一剩余的 info/attributes，二者叠加才能把残余收窄到 T9 所描述的「双文件同时改写」。

### 9.3 v3.1 · D1 实测修正（验收 r_ZWKWV6PC 打回项）

| #   | 事实                                                                                                                                        | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 落地                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `GIT_COMMON_DIR` env 只覆盖 objects / 仓库 config；git 2.53 的 refs 后端仍读 `<gitdir>/commondir` 文件解析 refs / packed-refs               | 收窄「commondir 在 membership 之后不再被 git 读取」的表述（原 §0.1 D4、§9.2 #5 中的该句由本条取代）：钉住链上 commondir 改写 ⇒ **OID 解析可被重定向**（同 uid 完整性/可用性残余，§2.3 同 uid 范畴已涵盖），**内容读取 fail-closed**（重定向 OID 不在钉住对象库 ⇒ `bad object` 非零，他库内容不可达）；不写 env 的对照（v2 形态）才会读出他库内容。H3 验收口径与 §5 D1 测试文字同步；D3 的 membership / routes / head-binding 须吸收「C0 成功但内容 fail-closed」分支（已在其测试清单注明）。双向钉住在 `tests/integration/git-wtdiff.test.ts`（commondir 改写 + 无 env 对照组） | §0.2 I14、§1.8 说明、§2.3、§5 H3 / D1 / D3 |
| 2   | D1 H4 夹具「same length」提交与改写字节数不等（12 ≠ 11），未真正覆盖「同尺寸 stat 失配」前置                                                | 改写为同字节长度不同内容（`same LENGTH\n`）并以 `utimes` 显式设置不同 mtime（快速连续写可能同 mtime）；驱动场景夹具同样加固（`rehashTouch`）                                                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/integration/git-wtdiff.test.ts`     |
| 3   | boundary 闭包扫描器只覆盖静态 `import/export … from` 与裸 side-effect import，且 NodeNext `.js` specifier 解析后与 `.ts` allowlist 永不相等 | 补齐动态 `import("spec")` 与 `require("spec")`（typeOnly 恒 false）；解析后 `.js`→`.ts` 源归一（对应源存在时）；扫描器单测钉住四种形式 + 归一行为 + 「allowlist 外必红」判定级证明；变异验证（动态 import 非 allowlist 文件 ⇒ 红，动态 import `../../git/diff.js` ⇒ 绿）                                                                                                                                                                                                                                                                                                        | `tests/web-hub/boundary.test.ts`           |
