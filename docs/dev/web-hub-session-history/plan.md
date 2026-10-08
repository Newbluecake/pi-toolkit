# web-hub「历史会话浏览与恢复」实施方案（plan v3.1，2026-10）

> 输入：`docs/dev/web-hub-session-history/arch.md`（arch v1），**含 §14 与 §14.1 用户裁定，具约束力**：做 H0 子会话标记；`maybe` 档也强制 fork；`moved` 置灰；开放「复制为新会话」；`webHub.spawn.history` 默认开；带 session 时禁 `--model`；`stats.files===0` 时提示自定义 sessionDir 不支持；**U-H2 放宽为「尽力检测」**——能检测到或判不清的占用一律 fork + 警告，残余窗口写进文档并在 UI 提示，不做协作式持有锁。
> v1 → v2 被 `r_9BKDG4S5` 打回，v2 → v3 被 `r_EANRRJTT` 打回（2 个 Blocker + 5 项）。v3 由新的 planner 接手，**在 §14.1 授权下做了减法**；相对 v2 的全部变化见 §0，评审项 1–7 的逐条处置见文末「修订记录（v2 → v3）」。/tmp 实测见 §10（脚本与原始结果：`/tmp/pwh-hist-exp/`，新增 E6、E7）。
> 代码基线 `26114df`，行号只作定位，动手前用 `rg` 重新确认。pi 版本 `@earendil-works/pi-coding-agent@1.0.2`（全局安装与 devDependency 同版本）。
> **v3 → v3.1**（评审 r_EANRRJTT 复审，窄口打回）：① 枚举错误进入可恢复状态，`incomplete` 覆盖一切遗漏（§4.5.3）；② 枚举改为 fd/inode 锚定，目录被换成 symlink 绝不跟随（§4.5.3，E8 实测）；③ restore 的路径 pin 与首次 resume 同一套检查（含 realpath、须在 sessionsRoot 下），捕获失败 ⇒ 拒绝该次 restore（§4.5.6、§4.6.3、§6.4）；④ PD23：未完成 gen 的页按 mtime 倒序排本页 items（dispatcher 裁定）；⑤ `ioFailures`/`enumRetry` 定义为**连续**计数；⑥ UI 常驻说明补 W5/W7。逐项处置见文末「修订记录（v3 → v3.1）」。
> 本文按**文件域**分包，跨包契约集中在 §3「冻结面」，内容逐字给出。与 arch 冲突时，以本文 §1 为准，每条都附理由。

---

## 0. v3 相对 v2 改了什么、为什么

§14.1 把 U-H2 从「硬保证」改成「尽力检测 + 披露残余」。这改变了成本收益：v2 为了把漏检窗口压到最小而堆出来的那部分机器（卡片首见 starttime 账本、10 个 `ProofGap`、`foreign-uid`、readdir 差分式 `reprove`），每一件都只覆盖微秒级或超出观察域的场景，却各自需要独立的状态、测试和 UI 文案。v3 的原则：**保留能以低成本检测到真实占用的部分，砍掉只能缩小「理论窗口」的部分，并把砍掉的每一项写成残余窗口（§4.5.5 W 表）披露到文档和 UI。**

| #   | 变化                                                                                                                                                                                                                                                                                                                  | 为什么                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **占用检测改为 best-effort 口径**（PD10'）：结论从「正面证明无人持有」改为「没有检测到任何占用，且检测本身是完整的」。保留 kind 门、C1 卡片、C2 受管记录、C3 完整 `/proc` 扫描、sync 复核、hub pid 排除                                                                                                               | §14.1。C3 的本质就是「每个同 uid 的运行中 pi 要么是一张已上报 session 的 live 卡片 / 一条受管记录，否则 fork」——实现它的最小代价就是一次有界扫描（E4/E6：3–8 ms）。再砍就是不扫，而「未连 hub 的 TUI 打开着同一会话」是用户最可能撞上的真实场景                  |
| C2  | **`reprove` 改为「全量同步重 stat」**：token 记录扫描时看到的**每个** pid 的 `starttime/uid/comm`；sync 段对 `/proc` 重新 readdir 并对每个 pid 重读 `stat`，starttime 变化、消失后重现、comm/state 异常、新出现的同 uid `pi`/`node*` 一律 ⇒ 不 free                                                                   | 评审 #1（Blocker）：v2 只对「新 pid」做差分，被复用的 pid 不在差分里。全量重 stat 不需要任何差分逻辑，E6 实测 310 个 pid 全量 5–8 ms（同 uid 2.2 ms），50 ms 预算可覆盖约 3000 个 pid，超出 ⇒ `proc-partial` ⇒ fork                                              |
| C3  | **砍掉卡片「首见 starttime 账本」**；候选进程只按 pid 对卡片、按 pid + `procStartTicks` 对受管记录                                                                                                                                                                                                                    | registry 在 socket EOF 时立即摘卡（`registry.ts:12`），卡片 pid 被一个新 pi 复用而卡片仍在的窗口是微秒级；账本要在 liveness 里旁听 registry 事件并在卡片生命周期内读 `/proc`，换来的只是这一个窗口。记为残余 W5                                                  |
| C4  | **砍掉 `foreign-uid`、`platform` gap，`card-not-live`/`card-no-session`/`identity` 合并为 `card-unproven`**；`ProofGap` 从 10 个减到 5 个                                                                                                                                                                             | root / 其他 uid / 其他 namespace 的 pi 本来就是 §14.1 列出的残余（W3），为它单独设 gap 既检测不到真实占用，又要维护文件 mode 判定；非 Linux 时 spawn 整体 fail-closed，`/proc` 读不到归入 `proc-partial`；三个卡片 gap 的用户动作完全一样（fork），UI 文案也一样 |
| C5  | **扫描代可续枚举**（PD9'）：gen 保存枚举检查点（目录序号 + 目录内文件偏移），枚举未完成的 gen 在每次请求时先续枚举、再出页；首页请求复用未完成的 gen 而不是新建；每次请求至少推进 1 个目录或 64 个文件                                                                                                                | 评审 #2（Blocker）：v2 的 partial gen 是一个被截断的快照，之后的刷新可能在同一位置再次截断，部分文件永远到不了。E7 实测本机全量枚举 107 ms（warm），`enumPartial` 是冷缓存 / NFS 事件而非常态，但一旦发生必须能收敛                                              |
| C6  | **skipped 语义显式化**：`stats.skipped` 为 gen 内累计值，页面带 `incomplete:true`，UI 常驻横幅；只在新 gen 里重试                                                                                                                                                                                                     | 评审 #6                                                                                                                                                                                                                                                          |
| C7  | **`session-swapped` 复核加严**：上报的 `sessionFile` 必须存在且**逐字节等于**传给 pi 的字面路径；`R`、`R/dir`、文件三级 lstat 都不是 symlink 且 dev/ino 与 pin 一致；文件 `nlink === 1`（pin 时与复核时都要求）；`realpathSync(file) === file`。restore 用 `--session <file>` 重 fork 时在 history 开启下做同样的复核 | 评审 #3：dev/ino 单独放过「目录被换、文件是同一 inode 的硬链接」——pi 会从 `dirname` 推导 sessionDir 并把 `/new` 写进攻击者的目录                                                                                                                                 |
| C8  | **restore 重 fork 不重跑占用检测，明示为产品例外**（PD21'），RH4 以「记录限制」的方式断言它                                                                                                                                                                                                                           | 评审 #4 + §14.1 原文                                                                                                                                                                                                                                             |
| C9  | W-resume 两种形态分别验收：「换走且不换回」⇒ 必须停（HH10）；「换走又换回」⇒ 不可检测，HH10b 只断言「照常 live、无误报」并写入文档                                                                                                                                                                                    | 评审 #5                                                                                                                                                                                                                                                          |
| C10 | `historyProcFs` seam 保留，新增 `wrapHistory` 观察 seam + service 的 `diag().procFsSource`，装配测试证明生产走真实 procFs 且 env/config 改不了它                                                                                                                                                                      | 评审 #7                                                                                                                                                                                                                                                          |
| C11 | UI：弹窗底部与 fork 确认框新增一行**常驻**的「尽力检测」说明（§4.7.2），内容逐字对应 W 表                                                                                                                                                                                                                             | §14.1「在 UI 上提示」                                                                                                                                                                                                                                            |

**没有变**：fd 锚定解析（PD11，E5）、fork 走 hub 快照（PD12，E1/E2）、history 本地 IO 闸（PD4/PD20）、标题 v1 范围（PD19）、H0 标记（PD2）、`cursor-expired`（UI 自动重来 1 次）、全部闸门顺序、关闭时逐字节一致（§5）。

**考虑过但没采纳的更大减法**：完全不扫 `/proc`，只用 C1/C2。理由见 C1——那会让「TUI 里开着同一会话」这个最常见的真实占用变成漏检，而扫描本身的成本（约 120 行 + 一个 fake procFs）低于为它写免责文案的代价。

---

## 0'. 速览

| 包          | 内容                                                                                                                             | 文件域（独占）                                                                                                                                                         | 依赖                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **P-conf**  | 真实 pi 的一致性测试：`--session`、从快照 `--fork … --session-id`、实证 fork 会改写源文件。**fork 路径的第一道闸门**             | `tests/conformance/rpc-spawn.test.ts`                                                                                                                                  | 无                           |
| **P0**      | 冻结面：protocol 的类型、schema、常量、cap、路径，以及 hub 侧 `HistoryService` 端口                                              | `protocol/session-history.ts`（新）、`protocol/spawn.ts`、`protocol/version.ts`、`protocol/paths.ts`、`hub/spawn/history/ports.ts`（新）                               | 无                           |
| **H0**      | 子会话写入 `subagent:child` 标记                                                                                                 | `src/runtime/session-driver.ts`、新增一个集成测试                                                                                                                      | 无                           |
| **P-cfg**   | 设置项 `webHub.spawn.history` 及其下发                                                                                           | `src/config/{settings,setting-specs}.ts`、`src/web-hub/agent/index.ts`、`hub/spawn/config.ts`                                                                          | P0                           |
| **P-scan**  | fd 锚定解析、**可续枚举的扫描代**、头部索引、cwd 状态、**best-effort 占用检测**、fork 快照、history 本地 IO 闸                   | `hub/spawn/history/*`（ports.ts 除外）、`hub/spawn/restore-plan.ts`                                                                                                    | P0、H0（只依赖一个常量对拍） |
| **P-route** | 列表端点、POST 的 `session` 分支、admit sessionBacked、supervisor（argv/快照清理/live 后 swapped 复核）、投影、审计              | `hub/spawn/{routes,supervisor,project,dirs}.ts`、`hub/audit.ts`、`tests/web-hub/http/spawn-kit.ts`                                                                     | P0                           |
| **P-ui**    | 历史弹窗、搜索、置灰、fork 警告/确认、跳转、**尽力检测说明**                                                                     | `src/web-hub/ui/**`（清单见 §4.7）                                                                                                                                     | P0                           |
| **P-int**   | hub 装配与 caps、fake pi 扩展、真进程集成测试、**真 pi + 真 hub 的 restore 测试（含 RH4 限制断言）**、starvation、装配测试、文档 | `hub/hub.ts`、`tests/integration/**`、`tests/conformance/history-restore.test.ts`（新）、`tests/web-hub/hub/hub-history-assembly.test.ts`（新）、`AGENTS.md`、验收文档 | 全部                         |

合并顺序：**P-conf（必须先绿）→ P0 → H0 → P-cfg → P-scan → P-route → P-ui → P-int**。P0 合并后，P-cfg、P-scan、P-route、P-ui 同时开发。

---

## 1. 方案级决策（相对 arch 的细化或偏离）

| #         | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 理由                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PD1       | `SPAWN_HISTORY_HUB_CAP = "spawn.history.v1"` 放在 `protocol/version.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 与其他 hub cap 放在一起                                                                                |
| PD2       | H0 标记在 **driver 侧**写入：`PiSessionDriver.create()` 里 `SessionManager.create(cwd)` 之后调用 `appendCustomEntry("subagent:child",{v:1})`，条件是 `persist && !isConsultForkSpec`，失败只吞掉不影响 run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 子扩展没有激活时（todo #27）也能写；pi 懒落盘，标记固定在文件第 2 行；`resume()` 和 consult 不经过这里 |
| PD3       | `session-unexpected` / `session-swapped` 写进 owner-only 的 `hintDetail`，另记一条审计 state 行。**不扩展** `SpawnHint` / `SpawnEndReason` 等持久化枚举                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | restore D11：持久化枚举扩值后，回滚的旧 hub 会把整个 spawns.json 判为损坏                              |
| PD4       | **只声明 history 本地的 IO 上限**：history 的每个 fs 操作在 `inflight + zombies < HISTORY_FS_SLOTS(=2)` 时才放行。**不承诺**跨子系统共享上限，§6.5 列出线程池的其他使用者，并补 starvation 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | v1 评审 #5                                                                                             |
| PD5       | `hub.ts` 的装配和 caps 归 P-int                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P-route 只依赖 P0 的端口类型                                                                           |
| PD6       | GET 处理器写在 `hub/spawn/routes.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 复用文件里现有的审计、限速、鉴权闭包                                                                   |
| PD7       | 首行不是合法 session header 的文件不出行，计入 `stats.invalid`（并消费掉）；`blocked:"invalid"` 只留给 header 合法、但 id 不满足 `RESTORE_SESSION_ID_RE` 的行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 没有 header 就拿不到 id 和 cwd                                                                         |
| PD8       | 头部只有找到首条 user 消息才算 `complete`。重读条件：`ino/dev` 变化 ∨ size 变小 ∨（`!complete` ∧ size 变大）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 写入中的新会话之后还能补出标题                                                                         |
| **PD9'**  | **可续枚举的扫描代 + 位置游标**：gen = 冻结的目录清单 + 枚举检查点 + 只追加的 `files[]`。游标 `v1.<genId>.<pos>`。枚举未完成的 gen 在每次请求时先续枚举再出页，首页请求复用它；gen 内每个文件恰好出现一次；IO 失败的文件不消费（3 次后 skipped）；gen 过期 ⇒ 409 `cursor-expired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 评审 #2；§4.5.3                                                                                        |
| **PD10'** | **占用检测 best-effort（§4.5.5）**：原地 `--session` 的条件是「kind 正面为 `main`，且 C1/C2 无命中，且一次完整无错的 `/proc` 扫描里每个同 uid pi 候选都对得上一张 live 且已上报 session 的卡片（按 pid）或一条非终态受管记录（按 pid + `procStartTicks`），且 sync 段全量重 stat 没有发现 starttime 变化或新同 uid `pi`/`node*`」。其他情况一律 fork + 警告（`forkReason:"open"\|"maybe"\|"subagent"\|"unverified"`）。残余窗口 W1–W7 写进文档和 UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §14.1；评审 #1                                                                                         |
| **PD11**  | **fd 锚定解析（§4.5.6）**：sessionsRoot 固定为目录 fd，逐级 `openSync("/proc/self/fd/<n>/<name>", O_DIRECTORY\|O_NOFOLLOW)`，末级 `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK`，fstat 校验 dev/ino/uid/regular/**nlink===1**。header 和快照**只经由已固定的 fd 读取**。resume 必须把字面路径交给 pi，所以 spawn 前在 sync 段做三级 lstat 链 + realpath 复核，live 后再做 §4.5.6 的事后复核                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | v1 评审 #2；评审 #3                                                                                    |
| **PD12**  | **fork 不直接对源文件运行**：hub 先经已固定的 fd 做一份有界快照（只含完整行，0600，`<stateDir>/spawn/fork-src/`），再执行 `pi --fork <快照> --session-id <newId>`。新 header 的 `parentSession` 指向快照路径，清理后悬空；hub **不修补**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | v1 评审 #3；E1/E2                                                                                      |
| PD13      | 带 session 的请求**不应用** hub 的默认模型偏好，`effectiveModel` 强制为 `""`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | §14 Q6 / D10                                                                                           |
| PD14      | UI 在没有 `spawn.history.v1` cap 时绝不把 session 字段静默丢掉；本地直接失败                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 丢掉 session 后发出的就是一个全新会话                                                                  |
| PD15      | `SpawnRow` 对带 `from` 的记录隐藏「重试」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 现有重试是 `submit({cwd})`，语义不对                                                                   |
| PD16      | POST gate 8 的拒绝优先级：先 resolve 的 `session-*`，再 admit 的错误                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 前者更具体                                                                                             |
| PD17      | 用户在 UI 里选择 fork 时，本地确认一次后**一次性**发送 `mode:"fork", confirm:true, expectCwd`；LAN 的明文警告合并进同一个确认框                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 避免连续两层确认                                                                                       |
| PD18      | 列表请求成功时不写日志；zombie 熔断时每 60s 最多 `warn` 一次，只含数字                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `HubLog` 没有 debug 级别                                                                               |
| PD19      | 标题 v1 只做：卡片实时名字 → 头部窗口里的 `session_info.name` → 首条 user 消息（skill 信封清洗、空白折叠、截断）。**不做** tail 名字探测和附件尾注剥离                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | v1 评审 #9                                                                                             |
| PD20      | history 的所有 open 都带 `O_NONBLOCK`，open 之后用 fstat 确认 `isFile()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | E5d：被换成 FIFO 的文件不加这个标志会卡住一个 libuv 线程                                               |
| **PD21'** | **restore 交互（§6.4）**：restore 关闭时就是普通受管会话；打开时 goLive 采纳 pi 上报的 sessionFile，重启时 `--session <该文件>` 恢复。**restore 的重 fork 不重跑占用检测——这是 §14.1 明示的产品例外**：重启间隙里有谁打开了同一文件，hub 不会知道，照常 `--session`。RH4 把这个限制作为「记录限制」断言下来（不是 bug 修复目标）。history 开启时，重 fork 也做 §4.5.6 的 swapped 事后复核                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 评审 #4；§14.1                                                                                         |
| **PD23**  | **返回页按 mtime 倒序（dispatcher 裁定）**：`files[]` 保持枚举顺序，`page()` 只对**本页 items** 按 `(mtimeMs desc, key asc)` 排序；`complete` 在首次 `advance` 内达成时（E7 常态）则在首次出页前把 `files[]` 整体排一次。未完成期间 UI 显示「排序在枚举完成前为近似」。不加候选排序层。这是对 arch §4.1.1 全局倒序的有意偏离，只在 `enumPartial` 发生时可见                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 评审 v3.1 #4                                                                                           |
| **PD24**  | **restore 路径 pin 与首次 resume 同规**（history 开启时）：`captureSessionPathPin(abs, uid, R)` 要求 `abs` 形如 `R/<dir>/<file>`、三级 lstat 链、regular、`nlink===1`、uid、`realpathSync(abs)===abs`；**捕获失败 ⇒ `failRestorePreflight(rec, "session-invalid", detail)`**（有界失败，记录在 restore 的 attempts 里），不再 `--session`。history 关闭 ⇒ 走原 restore 路径，**不携带任何 history 路径 pin 保证**（§5 明示）。代价：history 开启时，sessionFile 不在 `realpath(agentDir/sessions)` 下的会话（自定义 sessionDir，arch §1.3 非目标）不能被 restore 重 fork，需关闭 history 开关。**调度方修正（v3.1a，2026-10-09）**：「须在 R 下」只对 history 来源的记录（持久化字段 `rec.historyOrigin` 存在：首次 resume / fork 产生，见 v3.2 V3）生效；其他托管会话（目录启动的普通 spawn）的 restore 仍做三级 lstat 链 / regular / `nlink===1` / uid / `realpathSync(abs)===abs`，但不要求在 R 下——因此自定义 sessionDir 的普通托管会话照常 restore，不收窄现状 | 评审 v3.1 #3                                                                                           |
| **PD22**  | **`historyProcFs` 只能以编程方式注入**：`HubDeps.spawnSeams.historyProcFs`；`main.ts` 不设置，不从 env / `HubConfig` 读取；`HubDeps.spawnSeams.wrapHistory` 让测试观察到构造出的 service；service 暴露只读 `diag()`（`procFsSource:"default"\|"seam"`）。装配测试 + 源码扫描钉住                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 评审 #7；开发机和 CI 上跑着无关的真实 pi，不注入 seam 的话任何 resume 测试都会被迫 fork                |

---

## 2. 共享文件与冻结面的唯一 owner

| 文件 / 契约                                                                                                                                                                                                                                                         | owner    | 规则                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `protocol/session-history.ts`（新）、`protocol/spawn.ts`（追加）、`protocol/version.ts`（追加）、`protocol/paths.ts`（追加 `forkSrcDir`）、`hub/spawn/history/ports.ts`（新，只有类型）                                                                             | P0       | 其他包只读；需要修改时回到 P0 重新冻结                                          |
| `hub/http.ts`                                                                                                                                                                                                                                                       | **不改** | `/api/headless/*` 已整体分发给 `spawnRoutes.handle`；P-int 用测试断言这一点     |
| `hub/registry.ts`                                                                                                                                                                                                                                                   | **不改** | v3 不再需要卡片 starttime 账本（§0 C3），registry 零改动，liveness 也不再旁听它 |
| `hub/spawn/{routes,supervisor,project,dirs}.ts`、`hub/audit.ts`                                                                                                                                                                                                     | P-route  | —                                                                               |
| `hub/spawn/restore-plan.ts`（抽出 `checkSessionHeader`，行为逐字节不变）                                                                                                                                                                                            | P-scan   | —                                                                               |
| `hub/hub.ts`、`hub/main.ts`（**不改**，由源码扫描钉住不含 `historyProcFs`/`wrapHistory`）                                                                                                                                                                           | P-int    | —                                                                               |
| `src/config/{settings,setting-specs}.ts`、`src/web-hub/agent/index.ts`、`hub/spawn/config.ts`                                                                                                                                                                       | P-cfg    | —                                                                               |
| i18n `ui/src/i18n/{zh,en}/history.ts`（新命名空间）                                                                                                                                                                                                                 | P-ui     | —                                                                               |
| `tests/web-hub/http/spawn-kit.ts`、`headless-matrix.test.ts`                                                                                                                                                                                                        | P-route  | —                                                                               |
| `tests/integration/fixtures/fake-rpc-pi.mjs`、`tests/integration/web-hub-headless.test.ts`、`tests/integration/web-hub-history-starvation.test.ts`（新）、`tests/conformance/history-restore.test.ts`（新）、`tests/web-hub/hub/hub-history-assembly.test.ts`（新） | P-int    | —                                                                               |
| `tests/conformance/rpc-spawn.test.ts`                                                                                                                                                                                                                               | P-conf   | —                                                                               |
| `tests/integration/child-session-marker.test.ts`（新）                                                                                                                                                                                                              | H0       | —                                                                               |
| `tests/web-hub/ui/source-scan.test.ts`                                                                                                                                                                                                                              | P-ui     | 只追加 localStorage 白名单                                                      |
| `AGENTS.md`、`docs/dev/web-hub-spawn/acceptance.md`                                                                                                                                                                                                                 | P-int    | —                                                                               |

---

## 3. 冻结面（P0，逐字）

### 3.1 `src/web-hub/protocol/session-history.ts`（新；纯 TS，**不 import typebox、不 import `node:*`**，浏览器可直接用）

```ts
export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 100;
export const HISTORY_Q_MAX_CHARS = 128; // after trim, UTF-16 units
export const SESSION_KEY_MAX_BYTES = 512; // UTF-8
export const HISTORY_TITLE_MAX = 200; // UTF-16 units, never splits a surrogate pair
export const HISTORY_CURSOR_MAX_CHARS = 64;
/** H0 marker customType — pinned equal to src/runtime/session-driver.ts's SUBAGENT_CHILD_CUSTOM_TYPE by source scan. */
export const HISTORY_CHILD_MARKER_TYPE = "subagent:child";
export const SESSION_OPEN_REASON = "session-open";
export const CURSOR_EXPIRED_REASON = "cursor-expired";

export type HistoryKind = "main" | "sub" | "unknown";
export type HistoryCwdState = "ok" | "gone" | "not-dir" | "no-access" | "moved" | "unknown";
export type HistoryBlocked = Exclude<HistoryCwdState, "ok" | "unknown"> | "invalid";
/** Why a session must be forked. Priority when several hold: open > subagent > maybe > unverified. */
export type ForkReason = "open" | "maybe" | "subagent" | "unverified";
/**
 * Why the hub could NOT establish "no occupancy detected" (§4.5.5; best-effort per arch §14.1).
 * forkReason "maybe" ⇔ gap "unconnected-pi"; every other gap ⇒ forkReason "unverified".
 */
export type ProofGap =
  | "kind" // target not positively kind "main" (unknown)
  | "proc-partial" // /proc scan incomplete: budget / PID cap / zombie breaker / unreadable same-uid entry / no procfs
  | "unconnected-pi" // a same-uid pi candidate matches no live card (pid) and no managed record (pid+startTicks)
  | "card-unproven" // candidate matches a card that is claiming/stale, or live but never reported a session
  | "new-process"; // the sync re-stat right before spawn saw a changed starttime or a new same-uid pi/node* pid

export interface HistoryLiveWire {
  state: "open" | "maybe";
  by: "card" | "managed" | "proc";
  agentKey?: string;
  pid?: number;
}

export interface HistoryItemWire {
  key: string; // "<dir>/<file>" relative to realpath(sessionsRoot); sole source of SessionRefWire.key
  id: string;
  cwd: string; // header cwd, verbatim
  cwdLabel: string;
  startedAt: string;
  mtimeMs: number; // as captured when the generation enumerated the file
  size: number; // as captured when the generation enumerated the file
  title?: string;
  titleSource: "name" | "first" | "none";
  kind: HistoryKind;
  forked?: true;
  cwdState: HistoryCwdState;
  startable: boolean;
  blocked?: HistoryBlocked;
  live?: HistoryLiveWire;
  forkOnly?: ForkReason; // advisory (≤5s-old scan); the POST re-scans fresh
  proofGap?: ProofGap; // present iff forkOnly ∈ {"maybe","unverified"}
  indexed: true;
}

export interface HistoryEnumStats {
  complete: boolean; // enumeration CURSOR finished (PD9'); says nothing about omissions — see HistoryPage.incomplete
  dirsDone: number;
  dirsTotal: number; // frozen at generation creation (≤ HISTORY_DIR_LIMIT)
  dirsSkipped?: number; // dirs given up after HISTORY_IO_RETRY_MAX consecutive readdir/open failures (file count unknown)
  dirsTruncated?: true; // root had more than HISTORY_DIR_LIMIT dirs — the rest are never listed
  filesTruncated?: true; // HISTORY_FILE_LIMIT reached — remaining files of the current dir are never listed
}

export interface HistoryPage {
  items: HistoryItemWire[];
  next?: string; // opaque cursor "v1.<genId>.<pos>"; absent ⇔ enumeration complete AND pos reached files.length
  partial?: { reason: "budget" | "enum" | "zombie" | "io" };
  /** Present whenever THIS generation may be missing sessions — i.e. unless every file enumerated so far AND
   *  every file of every dir landed in one of {row, filtered, invalid, vanished}:
   *  `!enum.complete || skipped > 0 || enum.dirsSkipped > 0 || changed > 0 || enum.dirsTruncated || enum.filesTruncated`.
   *  Retry = a NEW generation (refresh without cursor after HISTORY_GEN_REUSE_MS, or after the gen expires).
   *  Items of a page are sorted (mtimeMs desc, key asc) per page (PD23); while `!enum.complete` the ORDER ACROSS
   *  pages is approximate. */
  incomplete?: true;
  liveness?: "partial" | "no-proc";
  stats: {
    files: number; // enumerated so far in this generation
    indexed: number;
    invalid?: number; // header-less files consumed in this generation (cumulative)
    vanished?: number; // ENOENT at open, consumed in this generation (cumulative)
    skipped?: number; // files given up after HISTORY_IO_RETRY_MAX CONSECUTIVE failures (enumeration lstat + paging reads), cumulative
    changed?: number; // files whose directory's dev/ino no longer matches the pinned one (dir replaced/symlinked) — never followed
    enum: HistoryEnumStats;
  };
}

export interface SessionRefWire {
  key: string;
  id: string;
  mode?: "resume" | "fork";
}

export interface HistoryQueryWire {
  q?: string;
  kind?: "main" | "all";
  cursor?: string;
  limit?: number;
}

export type SessionSpawnRejectReason =
  | "session-ref" // 400 E_BAD_REQUEST
  | "model-with-session" // 400 E_BAD_REQUEST
  | "session-missing" // 400 E_DIR
  | "session-mismatch" // 400 E_DIR
  | "session-invalid" // 400 E_DIR (incl. nlink !== 1, non-regular, symlink level)
  | "session-too-large" // 400 E_DIR (fork snapshot cap)
  | "moved" // 400 E_DIR
  | "session-changed"; // 409 E_DIR (sync re-verify failed)

/** `<dir>/<file>`: exactly one `/`; each segment 1..255 chars, no NUL/CR/LF, not "."/".."; file ends with
 * ".jsonl" and is longer than it; whole key ≤ SESSION_KEY_MAX_BYTES UTF-8. Never throws. */
export function isValidSessionKey(s: string): boolean;
/** `v1.<genId>.<pos>`: genId = /^[A-Za-z0-9_-]{11}$/, pos = decimal 0..999999. */
export function encodeHistoryCursor(genId: string, pos: number): string;
/** null on any shape violation (prefix, length > HISTORY_CURSOR_MAX_CHARS, genId/pos pattern). Never throws. */
export function decodeHistoryCursor(s: string): { genId: string; pos: number } | null;
```

### 3.2 `protocol/version.ts`（追加）

```ts
export const SPAWN_HISTORY_HUB_CAP = "spawn.history.v1"; // only when config.spawn?.history === true; no PROTO bump
```

### 3.3 `protocol/spawn.ts`（只追加；不带 session 的旧行为逐字节不变）

```ts
import { isValidSessionKey, SESSION_KEY_MAX_BYTES, type SessionRefWire } from "./session-history.js";
export interface SpawnRecordPublic { /* … */ from?: "history" | "fork"; } // memory/projection only, never persisted
export interface SpawnRequestBody { /* … */ session?: SessionRefWire; }
export interface SpawnAccepted { /* … */ session?: { mode: "resume" | "fork"; id: string }; }
export interface HubSpawnConfig { /* … */ history?: boolean; } // absent ⇒ false hub-side
export const SessionRefSchema = Type.Object(
  {
    key: Type.String({ minLength: 3, maxLength: SESSION_KEY_MAX_BYTES }),
    id: Type.String({ pattern: RESTORE_SESSION_ID_RE.source }),
    mode: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("fork")])),
  },
  { additionalProperties: false },
);
export const SpawnRequestSchemaWithSession = Type.Object(
  { ...SpawnRequestSchema.properties, session: Type.Optional(SessionRefSchema) },
  { additionalProperties: false },
);
export type SpawnBodyError = /* existing */ | "session-ref" | "model-with-session";
/** opts absent / opts.session !== true ⇒ EXACT pre-feature path (SpawnRequestSchema). opts.session === true ⇒
 * WithSession schema, then after the existing checks: !isValidSessionKey ⇒ "session-ref"; session ∧ model !== undefined
 * (ANY value incl. "") ⇒ "model-with-session". */
export function parseSpawnRequestBody(raw: unknown, opts?: { session?: boolean }): /* unchanged result type */;
```

新增 schema 的编译期双向漂移守卫，与现有的 `_SpawnRequestStaticMatches` 写法相同。`HubSpawnConfig` 的解析器（`hub/spawn/config.ts`）对 `history` 以外的任何新键照旧拒绝整个 spawn 块——**config 里不存在任何能影响 procFs 的键**（PD22）。

### 3.4 `protocol/paths.ts`（追加）

`webHubSpawnFiles()` 的返回值追加 `forkSrcDir: \`${stateDir}/spawn/fork-src\``（hub 自有，0700，只存 fork 快照）。

### 3.5 `hub/spawn/history/ports.ts`（新，只有类型）

```ts
import type {
  ForkReason,
  HistoryKind,
  HistoryLiveWire,
  HistoryPage,
  ProofGap,
  SessionRefWire,
} from "../../../protocol/session-history.js";
import type { HubLog } from "../../ports.js";
import type { ReqDeadline } from "../../req-deadline.js";
import type { SpawnRegistryPort } from "../ports.js";

export interface HistoryListQuery {
  q?: string;
  kind: "main" | "all";
  cursor?: { genId: string; pos: number };
  limit: number;
}
export type HistoryPageResult = { ok: true; page: HistoryPage } | { ok: false; reason: "cursor-expired" };

/** dev/ino of one lstat/fstat level. */
export interface InodeRef {
  readonly dev: number;
  readonly ino: number;
}
/** The three levels pi will re-walk by PATH on `--session <abs>`: realpath(sessionsRoot), its `<dir>`, the file. */
export interface SessionPathPin {
  readonly abs: string; // the literal path handed to pi — byte-equal to what pi must report back as sessionFile
  readonly root: InodeRef;
  readonly dir: InodeRef;
  readonly file: InodeRef; // nlink was 1 at pin time (otherwise session-invalid)
}

/** The fd-pinned session (§4.5.6). Owns three open fds until release(); release() is idempotent. */
export interface SessionPin extends SessionPathPin {
  readonly id: string;
  readonly cwd: string; // header cwd (=== request body cwd)
  readonly kind: HistoryKind;
  readonly size: number;
  release(): void;
}
export type ResolveResult =
  | { ok: true; pin: SessionPin }
  | { ok: false; status: 400; code: "E_BAD_REQUEST"; reason: "session-ref" }
  | { ok: false; status: 400; code: "E_DIR"; reason: "session-missing" | "session-mismatch" | "session-invalid" }
  | { ok: false; status: 504; code: "E_DEADLINE" };

/** One scanned /proc entry as captured by the async scan (§4.5.5). */
export interface ProcSeen {
  readonly startTicks: number;
  readonly uid: number;
  readonly comm: string;
  readonly cls: "pi" | "node-other" | "other"; // pi = candidate (comm "pi", or node* whose cmdline says pi cli)
}
/** The async scan's full pid picture, consumed by the SYNC re-stat (`reprove`). Plain data, not opaque. */
export interface ProcScanToken {
  readonly at: number; // deps.now() when the scan finished
  readonly complete: boolean; // false ⇒ prove already returned gap proc-partial; reprove must not be called
  readonly pids: ReadonlyMap<number, ProcSeen>; // EVERY numeric /proc entry seen, any uid
}

/** Result of the occupancy check (§4.5.5). free ⇔ in-place resume allowed. */
export type OccupancyProof =
  | { free: true; scan: ProcScanToken }
  | { free: false; reason: ForkReason; gap?: ProofGap; live?: HistoryLiveWire; scan?: ProcScanToken };

export type SnapshotResult =
  | { ok: true; snapshot: ForkSnapshot }
  | { ok: false; status: 400; reason: "session-too-large" }
  | { ok: false; status: 504 };
export interface ForkSnapshot {
  readonly path: string; // <forkSrcDir>/snap-<rand>.jsonl, 0600, complete lines only
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  discard(): void; // unlink (sync, best effort) — used when the request fails before start()
}

export interface HistoryService {
  page(q: HistoryListQuery, deadline: ReqDeadline): Promise<HistoryPageResult>;
  resolve(ref: SessionRefWire, cwd: string, deadline: ReqDeadline): Promise<ResolveResult>;
  /** Async, bounded: kind + C1/C2 + FRESH full /proc scan. Never rejects (deadline ⇒ free:false, gap proc-partial). */
  prove(pin: SessionPin, deadline: ReqDeadline): Promise<OccupancyProof>;
  /** Post-second-authorize SYNC stretch: C1/C2 + FULL /proc re-stat compared against `scan` (§4.5.5). No await. */
  reprove(pin: SessionPin, scan: ProcScanToken): OccupancyProof;
  /** SYNC: three-level lstat chain + nlink===1 + realpathSync(abs)===abs against the pinned fds (resume only). */
  verifyForSpawn(pin: SessionPin): { ok: true } | { ok: false; reason: "session-changed" };
  /** Async, bounded: copy complete lines from the PINNED fd into forkSrcDir (fork only). */
  snapshot(pin: SessionPin, deadline: ReqDeadline): Promise<SnapshotResult>;
  /** SYNC: snapshot still the file we wrote (lstat dev/ino/size, regular, 0600). */
  verifySnapshot(s: ForkSnapshot): boolean;
  /** Read-only diagnostics for assembly tests (PD22). */
  diag(): { procFsSource: "default" | "seam"; fsSource: "default" | "seam" };
}

/**
 * SYNC helper for supervisor `restoreForkSync()` (restore re-fork, history on) — the SAME checks the first resume's
 * pinSession+verifyForSpawn impose, by PATH: `abs` must be `R/<dir>/<file>` with a valid session key (R =
 * realpathSync(agentDir/sessions)); lstat R, R/<dir>, abs — none a symlink, dir is a directory, file regular,
 * nlink === 1, uid match; `realpathSync(abs) === abs`. Failure ⇒ the restore is REFUSED (PD24), never `--session`.
 * Lives in history/pin.ts; supervisor imports it.
 */
export type CaptureSessionPathPin = (
  abs: string,
  uid: number,
  sessionsRoot: string,
) => { ok: true; pin: SessionPathPin } | { ok: false; detail: string };
/**
 * SYNC post-live check (§4.5.6): `reported === pin.abs` byte-equal, three-level lstat chain dev/ino equal,
 * no symlink, regular, nlink === 1, `realpathSync(pin.abs) === pin.abs`. Any failure ⇒ "session-swapped".
 */
export type VerifySessionPathPin = (
  pin: SessionPathPin,
  reported: string | undefined,
) => { ok: true } | { ok: false; detail: string };

export interface ManagedSessionView {
  spawnId: string;
  state: "launching" | "starting" | "live" | "stopping" | "exited" | "failed";
  agentKey?: string;
  pid?: number;
  procStartTicks?: number;
  sessionId?: string;
  sessionFile?: string;
  sessionTarget?: { id: string; file?: string };
}
export type DeathVerdict = "confirmed" | "alive" | "unknown";
export interface HistoryServiceDeps {
  agentDir: string; // process.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`
  forkSrcDir: string;
  registry: Pick<SpawnRegistryPort, "list">;
  managed(): readonly ManagedSessionView[]; // read LIVE per call
  deathOf(spawnId: string): DeathVerdict | undefined;
  uid: number;
  hubPid: number;
  now(): number;
  log: HubLog;
}
// createHistoryService(deps, seams?) lives in ./service.ts (P-scan); HistorySeams is P-scan-owned, not frozen:
//   { fs?: Partial<HistoryFs>; procFs?: Partial<ProcFs>; gate?: HistoryIoGate }
```

### 3.6 HTTP 契约（逐字）

**`GET /api/headless/history`**

- 请求头 `X-PWH: 1`；查询参数 `q?`（trim 后 1..128，空串视为未传）、`kind?`（`main`|`all`，默认 `main`）、`cursor?`、`limit?`（1..100，默认 50）。未知参数忽略。
- 闸门顺序：LAN `lan:"off"` ⇒ 鉴权前 404 → 缺 `X-PWH` ⇒ 403 `E_CSRF` → authorize → 限速桶 `${principal}:spawn-history`（容量 4，每 500ms 补 1；耗尽 ⇒ 429 + `Retry-After`）→ 查询参数校验（失败 ⇒ 400 `{"error":"E_BAD_REQUEST","reason":"q"|"kind"|"cursor"|"limit"}`）→ `page()`：gen 过期 ⇒ **409 `{"error":"E_BAD_REQUEST","reason":"cursor-expired"}`**，正常 ⇒ 200 `HistoryPage`。若 `policy.allowed === false`，所有行 `startable:false`。
- 拒绝时写审计（`endpoint:"history"`），成功时不写审计也不写日志。关闭 ⇒ 不进这个分支，与 `/api/headless/<未知>` 相同，返回 404。

**`POST /api/headless`（扩展）** 新增响应：

| 状态 | body                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `{"error":"E_BAD_REQUEST","reason":"session-ref","message":"bad session ref"}`                                                                |
| 400  | `{"error":"E_BAD_REQUEST","reason":"model-with-session","message":"model cannot be set when resuming a session"}`                             |
| 400  | `{"error":"E_DIR","reason":"session-missing"\|"session-mismatch"\|"session-invalid"\|"session-too-large"\|"moved"}`                           |
| 409  | `{"error":"E_CONFIRM_REQUIRED","resolvedCwd":…,"reason":"session-open","forkReason":ForkReason,"proofGap"?:ProofGap,"live"?:HistoryLiveWire}` |
| 409  | `{"error":"E_DIR","reason":"session-changed"}`                                                                                                |
| 202  | 现有 `SpawnAccepted` 加上 `"session":{"mode","id"}`（fork 时 id 为 newId；dup 重放时同样带上）                                                |

### 3.7 设置键（P-cfg 实现，这里冻结语义）

`webHub.spawn.history`：布尔，设置层默认 `true`，非 live。只在 `spawn.enabled` 打开时作为 `HubSpawnConfig.history` 下发；hub 侧缺失 ⇒ `false`；值不是布尔 ⇒ 整个 spawn 块被拒（与 `restore` 同一规则）。有效开关 `H = config.spawn?.history === true`。

---

## 4. 各包详述

### 4.1 P-conf — 真实 pi 一致性（fork 路径第一道闸门）

**文件**：`tests/conformance/rpc-spawn.test.ts`，新增一个 describe「history argv tails (session-history plan HC1–HC7)」。复用 CR 段的 `prepareHome`/`launch`/`until`/`allJson`/`messagesOf`（提到文件级 helper），`launch` 额外记录 `hello` 帧。`home = realpathSync(mkdtempSync(…))`。源会话一律用 pi 自己的 `SessionManager.create(workdir, sessionDir)` + `appendMessage` 生成。

| 用例                                                                                                                                                                                          | 断言                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HC1 `--session <abs>`                                                                                                                                                                         | session 帧 `sessionId === header.id`、**`sessionFile === abs` 逐字节**（pi 的 `resolvePath` 对已归一的绝对路径是恒等，`PI/utils/paths.js:83-87`；这是 §4.5.6 事后复核的前提）；`hello.cwd === header.cwd`；stdout 全是 JSON；没有 `Fork this session`；EOF 后 ≤8s 退出                                                     |
| HC1b `--session <abs>`，进程 cwd ≠ header cwd                                                                                                                                                 | `hello.cwd === header.cwd` 字面值相等（E10，是 moved 置灰的依据）                                                                                                                                                                                                                                                          |
| HC2 **从快照 fork**：按 hub 的规则做快照（只取完整行，0600，放在 `<home>/hubstate/fork-src/` 下，不在 sessionsRoot 里）→ `--fork <snap> --session-id <randomUUID()>`，cwd = realpath(workdir) | session 帧 `sessionId === uuid`；新文件位于 `<agentDir>/sessions/<cwd 编码>/` 下，在 live 之前就已存在；header `{type:"session", id:uuid, cwd:realpath(workdir), parentSession:<snap>}`；`RESTORE_SESSION_ID_RE`/`isValidRestoreSessionFile` 都通过；**源文件和快照的 sha256 都不变**；`get_messages` 含源会话的 user 文本 |
| HC3 `--session <abs>`，header cwd 已被删除                                                                                                                                                    | 15s 内 exit≠0；没有 session 帧；stderr 含 missing-cwd 提示（子串匹配）                                                                                                                                                                                                                                                     |
| HC4 `--fork <snap> --session-id <已存在的 id>`                                                                                                                                                | exit 1，stderr 含 `Session already exists with id`                                                                                                                                                                                                                                                                         |
| HC5（说明性）源 header cwd 已被删除时，从快照 fork                                                                                                                                            | live（fork 不依赖源 cwd；但用户裁定 gone 一律置灰）                                                                                                                                                                                                                                                                        |
| **HC6** 源文件尾部是半行（模拟写者正在写），hub 做快照后 fork                                                                                                                                 | **源文件字节完全不变**（sha256 + size）；快照不含那半行；新文件每一行都能 `JSON.parse`                                                                                                                                                                                                                                     |
| **HC7（反证，钉住 E1）** 直接 `--fork <源文件>`，源文件尾部是半行                                                                                                                             | 源文件**被改写**：多了 1 字节 `\n`。pi 哪天修了这个行为，测试会变红提醒复查（届时可以放宽 PD12，但仍保持快照路径）                                                                                                                                                                                                         |

**验收**：`npm run test:conformance` 全绿（缺 CLI 时 skip）。**P-route 的 fork argv 必须在 HC2/HC6/HC7 都绿之后才能合并。**

---

### 4.2 P0 — 冻结面

**文件**：§3.1–§3.5 的五个文件；测试 `tests/web-hub/protocol/session-history.test.ts`（新）、`tests/web-hub/protocol/spawn.test.ts`（追加）、`tests/web-hub/protocol/paths.test.ts`（追加 `forkSrcDir`）。

**步骤**：照 §3 原样落地；`parseSpawnRequestBody` 不带 opts 时走原来的代码路径（用一个 `schema` 变量选择 schema，其余检查共用）。`ports.ts` 同样受 `hub/spawn/**` 零 `as` 扫描约束。

**测试锚点**：`isValidSessionKey` 矩阵（合法样例；`""`、没有 `/`、两个 `/`、`..`、`.`、`a/.jsonl`、非 `.jsonl`、NUL/CR/LF、单段 256、总长 513 B、绝对路径）；游标 encode/decode 往返，非法 genId/pos/前缀/超长返回 null；`parseSpawnRequestBody` 的矩阵：不带 opts 时带 session ⇒ `schema`；带 opts 时合法；`session-ref`；`model:""` ⇒ `model-with-session`；session 多出字段 ⇒ `schema`；`hub/spawn/config.ts` 对 spawn 块里任何非 `history` 的新键 ⇒ 拒绝（PD22 的 config 面）。

**验收**：`npm run typecheck && npm test` 全绿，protocol 现有测试零改动。

---

### 4.3 H0 — 子会话 `subagent:child` 标记

**文件**：`src/runtime/session-driver.ts`；测试 `tests/runtime/session-driver-child-marker.test.ts`（新，单元）、`tests/integration/child-session-marker.test.ts`（新，真实 driver）。

**步骤**

1. 导出 `SUBAGENT_CHILD_CUSTOM_TYPE = "subagent:child"`。
2. 导出 `markChildSession(sm: unknown, spec: SessionSpec, persist: boolean): void`：满足 `persist && !isConsultForkSpec(spec)` 且 `appendCustomEntry` 是函数时才调用，整体 try/catch 吞掉异常。
3. `create()` 在 `SessionManager.create(cwd)` 之后立即调用；`resume()` 不改。

**单元测试锚点**（`session-driver-child-marker.test.ts`）：用真实 devDep `SessionManager.create(tmpCwd, tmpDir)` → mark → `appendMessage(user)` 后，文件第 2 行以 `{"type":"custom","customType":"subagent:child"` 开头；只 mark 不发消息 ⇒ 文件不存在（懒落盘）；`persist=false`、consult spec、`appendCustomEntry` 抛错三种情况都不写入且不抛出；源码扫描确认 `resume(` 函数体里没有 `markChildSession`。

**集成测试锚点**（`tests/integration/child-session-marker.test.ts`，以 `readonly-domain-shadow-real-session.test.ts` / `child-bash-jobs-real-session.test.ts` 的真实 driver + 假 provider 夹具为模板）：

| 用例                       | 断言                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 create 路径             | 跑完一轮之后：第 1 行 header，第 2 行是标记；`subagent:prompt-sections` 快照条目只有 `pi_project_memory`（不含 `pi_subagent_types`）；首条 user 消息在 `SessionManager.open(file).getBranch()` 的真实分支上，标记是该分支的祖先；`buildSessionContext().messages` 里**没有**标记（不进入 LLM 上下文） |
| M2 resume 路径             | 对 M1 的文件 `driver.resume()` 再跑一轮 ⇒ 文件里标记行**恰好 1 条**                                                                                                                                                                                                                                   |
| M3 consult 路径            | 在现有 `tests/integration/consult.test.ts` 中追加断言：consult fork 文件里**没有**标记                                                                                                                                                                                                                |
| M4 child-extension-missing | 扩展未激活时 create ⇒ 标记照样存在；`child_extension_missing` 事件和诊断与修改前一致                                                                                                                                                                                                                  |
| M5 投影不受影响            | 用 `src/web-hub/hub/run-file-reader.ts`（或 `tests/web-hub/hub/run-transcript.test.ts` 的夹具）投影带标记的子会话 ⇒ 卡片和条目与不带标记时相同，只多出 1 条被忽略的 custom；session-nav 的 `[sub:type]` 标题不受影响                                                                                  |

**验收**：`npm test` 全绿；真机上 `head -2` 一个新子代理的 jsonl，第 2 行是标记。

---

### 4.4 P-cfg — 设置项与下发

**文件**：`src/config/settings.ts`、`setting-specs.ts`、`src/web-hub/agent/index.ts`、`hub/spawn/config.ts`；测试 `tests/config/web-hub-settings.test.ts`、`tests/web-hub/agent/wiring-spawn.test.ts`、`tests/web-hub/hub/spawn/config.test.ts`。

**步骤**（以 `restore` 为模板）：`DEFAULT_WEBHUB_SPAWN_SETTINGS.history = true`；解析时非布尔值回落到默认；setting spec 用 `bool("webHub.spawn.history", "web-hub spawn: browse all past sessions and resume/fork them from the web (default on; change: /reload then /webhub restart)")`；`WebHubSpawnSettings.history: boolean`；`buildHubConfig` 在 spawn 块里写入第九个字段 `history`；hub 侧 config.ts 遇到非布尔值拒绝整个块，字段缺失时保持缺省。

**测试锚点**：默认值 true；垃圾值 ⇒ true；键列表从 8 个变为 9 个，且为非 live；wiring 的字段数 +1；hub 侧 config 原样保留 / 缺省 / 拒绝三种情况。

**验收**：三个测试文件绿，typecheck 绿。

---

### 4.5 P-scan — 扫描、索引、占用检测、fd 锚定、快照

**文件**（`hub/spawn/history/` 下全部新建；零 `as`；boundary 规则：只 import `node:*` 和 `src/web-hub/{protocol,hub}` 内的路径）

| 文件            | 职责                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budget.ts`     | §6.1 的常量表；`createHistoryIoGate()`：实现 `inflight + zombies < HISTORY_FS_SLOTS` 准入，复用 preview 的 `createPreviewIoTracker`/`racePreviewIo`（`hub/preview/fs.ts`），但用独立的 tracker 实例；`historyStep(lazy, deadlineAt)` 不满足准入时抛 `busy`                                                                                                               |
| `head.ts`       | 纯函数 `createHeadParser()`（§4.5.1）                                                                                                                                                                                                                                                                                                                                    |
| `title.ts`      | 纯函数 `cleanFirstMessage(text, cwd)`（§4.5.2）                                                                                                                                                                                                                                                                                                                          |
| `fs.ts`         | `HistoryFs` 注入接口（异步版：`realpath/readdir(withFileTypes)/lstat/open/read/close/readlink/readFile`；同步版：`openSync/fstatSync/lstatSync/realpathSync/readdirSync/readFileSync/closeSync/statSync`）+ 默认实现；**所有 open 都带 `O_NONBLOCK`**；枚举与翻页读取只以 `/proc/self/fd/<fd>/<name>` 形式的路径调用（E8），fake fs 可以据此断言从不出现 `R/` 前缀的路径 |
| `pin.ts`        | fd 锚定解析：`pinSession`（异步，有界）/`SessionPin` 实现 / `verifyForSpawn`（同步）/ **`captureSessionPathPin` / `verifySessionPathPin`（同步，supervisor 共用）**（§4.5.6）                                                                                                                                                                                            |
| `generation.ts` | 扫描代：**可续枚举**（目录清单冻结 + 检查点）、只追加的 `files[]`、LRU、IO 重试计数、skipped（§4.5.3）                                                                                                                                                                                                                                                                   |
| `index.ts`      | 头部索引 + `page()`（§4.5.3）                                                                                                                                                                                                                                                                                                                                            |
| `cwd.ts`        | cwd 状态缓存（§4.5.4）                                                                                                                                                                                                                                                                                                                                                   |
| `proc.ts`       | `/proc` 扫描：`scanAsync(deadline) → ProcScanToken`（含 node* 的 cmdline 分类）+ `rescanSync(token) → RescanVerdict`（全量重 stat，无 cmdline）（§4.5.5）                                                                                                                                                                                                                |
| `occupancy.ts`  | `prove`/`reprove`：kind + C1/C2/C3（§4.5.5）                                                                                                                                                                                                                                                                                                                             |
| `snapshot.ts`   | fork 快照、启动时清扫（§4.5.7）                                                                                                                                                                                                                                                                                                                                          |
| `service.ts`    | `createHistoryService(deps, seams?)` 组合上述模块；`HistorySeams = { fs?: Partial<HistoryFs>; procFs?: Partial<ProcFs>; gate?: HistoryIoGate }`；`diag()` 报告每个 seam 是否被注入；`dispose()` 关闭所有 gen 的 rootFd/pending.fd（hub 关停时调用）                                                                                                                      |

另外修改 `restore-plan.ts`：抽出 `checkSessionHeader(head, {id, cwd})`，`detail` 字符串与现有的完全一致（`header is not JSON|header is not an object|header type mismatch|header id mismatch|header cwd mismatch`），restore 测试零改动。

#### 4.5.1 `head.ts`（逐行增量解析；先做前缀判定，再决定是否 JSON.parse）

- 第 1 行必须在前 4 KiB 内出现换行，否则 `too-long-header`；内容必须是对象，且 `type==="session"`、`id` 为字符串、`cwd` 为绝对路径且 ≤4096 B、`timestamp` 为字符串，否则 `bad-header`；文件空或首行不完整 ⇒ `no-header`。`parentSession` 存在时设 `forked:true`；`idValid = RESTORE_SESSION_ID_RE.test(id)`。
- 以 `{"type":"custom","customType":"subagent:child"` 开头 ⇒ `sub-marker`；以 `…"subagent:prompt-sections"` 开头 ⇒ 行内出现未转义的 `"pi_subagent_types":` 记 `main`，否则记 `sub-heuristic`；以 `…"pi-hud-session-start"` 或 `…"subagent:web-origin"` 开头 ⇒ `main`。
- 以 `{"type":"session_info"` 开头 ⇒ parse，取 `name`（保留最后一条）。
- 以 `{"type":"message"` 开头且前 256 字符内含 `"role":"user"` ⇒ parse，得到 `firstMessage`，`complete=true`，`push` 返回 `"done"`；system 和 assistant 行跳过。窗口在首条 user 行中间截断 ⇒ 用宽松正则提取，`complete` 仍为 false。
- kind 判定：`sub-marker` ⇒ sub；否则有任一 `main` 信号 ⇒ main；否则有 `sub-heuristic` ⇒ sub；否则 unknown。

#### 4.5.2 `title.ts`（PD19）

`stripSkillEnvelope` 逐字移植 `src/session-nav/skill-titles.ts:17-32`，再把空白折叠为一个空格、trim，截断到 `HISTORY_TITLE_MAX`（不切开代理对）。`search = (cwd + " " + display + " " + firstMessage).normalize("NFKC").toLowerCase()`，截到 1 KiB。标题优先级：卡片实时 `session.name`（卡片的 `sessionId === id`）> 头部窗口的 `session_info.name` > `firstMessage` > 无。

#### 4.5.3 可续枚举的扫描代与分页（PD9'；`generation.ts` + `index.ts`）

**gen 的数据结构**（v3.1：目录按 **fd/inode** 固定，不按名字；枚举错误是可恢复状态）

```ts
interface DirRef {
  name: string;
  dev: number;
  ino: number;
} // the dir as PINNED at first open (fstat of its O_DIRECTORY|O_NOFOLLOW fd)
interface FileStat {
  key: string;
  dir: DirRef;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
interface Gen {
  genId: string; // base64url(8 random bytes)
  createdAt: number;
  lastUsed: number;
  R: string; // realpath(agentDir/sessions) at creation
  rootFd: number; // open(R, O_RDONLY|O_DIRECTORY|O_NOFOLLOW) at creation; fstat uid === hub uid; held for the gen's lifetime
  root: { dev: number; ino: number };
  dirs: readonly string[]; // FROZEN NAMES from one readdir("/proc/self/fd/<rootFd>", withFileTypes), isDirectory() only, ≤ HISTORY_DIR_LIMIT
  dirsTruncated: boolean;
  cursorDir: number; // next dir index to enumerate
  pending?: { ref: DirRef; fd: number; names: readonly string[]; next: number }; // the dir being enumerated: PINNED fd, its .jsonl names, stat offset
  files: FileStat[]; // APPEND-ONLY; order = enumeration order (see PD23 for how pages are sorted)
  filesTruncated: boolean; // HISTORY_FILE_LIMIT reached
  complete: boolean; // enumeration cursor finished: cursorDir === dirs.length && pending === undefined
  enumRetry: Map<string, number>; // CONSECUTIVE failures per dir ("<dir>") or per file key ("<dir>/<file>") during enumeration; success ⇒ delete
  ioFailures: Map<string, number>; // CONSECUTIVE head-read failures per key during paging; success ⇒ delete
  dirsSkipped: number; // dirs given up after HISTORY_IO_RETRY_MAX consecutive readdir/open failures (file count UNKNOWN)
  filesSkipped: number; // files given up during enumeration (stat) — counted into stats.skipped together with paging skips
  changed: number; // dir dev/ino no longer matches its DirRef at a later access ⇒ the file is consumed as "changed", never followed
  skipped: number;
  invalid: number;
  vanished: number;
}
```

**fd 锚定机制（E8，`/tmp/pwh-hist-exp/fd-enum-exp.mjs`）**：Node 没有 `openat`，所以用 Linux 的 `/proc/self/fd/<fd>` 魔法链接做「相对 fd 的路径解析」：`open("/proc/self/fd/<rootFd>/<dir>", O_DIRECTORY|O_NOFOLLOW)`、`readdir("/proc/self/fd/<dirFd>", {withFileTypes})`、`lstat("/proc/self/fd/<dirFd>/<name>")`、`open("/proc/self/fd/<dirFd>/<name>", O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`。实测：(a) 三者都按原 inode 工作；(b) gen 创建后把 `R/d1` 换成指向 `/etc` 的 symlink，已固定的 `d1Fd` 的 `readdir` 仍列出原目录内容，而经 `rootFd` 重新打开 `d1` 得到 `ENOTDIR`（v3 的按路径 `readdir(R/d1)` 则会列出 `/etc/passwd`——这就是评审 #2 的漏洞）；(c) 目录内文件被换成 symlink：经 dirFd 的 `lstat` 显示 symlink，`O_NOFOLLOW` open 得到 `ELOOP`；(d) 目录被 rename + 重建后经 rootFd 重开，fstat ino 变化可检测；(f) 1000 次经 fd 的 lstat 36 ms，与按路径 35 ms 持平。与 §4.5.6 的 `pinSession` 和 preview/dir.ts 是同一套模式。

**创建**：`R = realpath(agentDir/sessions)`；`rootFd = open(R, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，fstat 必须是目录且 uid 相符，记 `root{dev,ino}`；`readdir("/proc/self/fd/<rootFd>", withFileTypes)` 一次（E7：208 项 0.2–0.7 ms），只取 `isDirectory()`（symlink 的 `isDirectory()` 为 false，自然跳过），超过 `HISTORY_DIR_LIMIT=4096` 的部分丢弃并置 `dirsTruncated`。任一步失败或超时 ⇒ **不创建 gen**（关闭 rootFd），返回空页 + `partial:{enum}`，下次请求重试。gen 失效（LRU 淘汰 / 空闲 / 超龄 / service dispose）时关闭 `rootFd` 和 `pending.fd`。最多 4 个 gen ⇒ 最多 8 个常驻目录 fd。

**续枚举 `advance(gen, deadline)`**（每次 `page()` 在出页之前先调用，`complete` 时为空操作）：

1. 若 `pending` 为空：取 `dir = dirs[cursorDir]`，`dirFd = open("/proc/self/fd/<rootFd>/<dir>", O_DIRECTORY|O_NOFOLLOW)`，fstat 记 `ref{name,dev,ino}`（uid 必须相符），`readdir("/proc/self/fd/<dirFd>", withFileTypes)` 只取 `isFile()` 且以 `.jsonl` 结尾的名字，置 `pending = {ref, fd, names, next:0}`。
   - `ENOENT`（gen 后目录被删）⇒ 消费：`cursorDir++`，不计错误（目录不存在就没有文件可漏）。
   - `ENOTDIR`/`ELOOP`（目录被换成 symlink 或非目录，E8b）⇒ 消费：`cursorDir++`，`gen.changed++`，**绝不按路径跟随**。
   - 其他失败（EACCES、EIO、超时、`busy`）⇒ **可恢复错误状态**：`enumRetry["<dir>"]++`，**不推进** `cursorDir`，本次 `advance` 结束，页面 `partial:{reason:"io"}`；连续达到 `HISTORY_IO_RETRY_MAX=3` 次 ⇒ 消费：`cursorDir++`，`gen.dirsSkipped++`，`enumRetry.delete`。成功 ⇒ `enumRetry.delete("<dir>")`。
2. 对 `pending.names[next..]` 逐个 `lstat("/proc/self/fd/<pending.fd>/<name>")`：`isFile()` 且不是 symlink ⇒ 得到 `{dev, ino, size, mtimeMs}`，收集到 `batch`，`next++`，`enumRetry.delete(key)`；`isSymbolicLink()` 或非普通文件 ⇒ 消费并 `gen.invalid++`；`ENOENT` ⇒ 消费并 `gen.vanished++`；其他失败 ⇒ **可恢复**：`enumRetry[key]++`，**不推进** `next`，本次 `advance` 结束，`partial:{io}`；连续第 3 次 ⇒ 消费，`gen.filesSkipped++`。`files.length` 达到 `HISTORY_FILE_LIMIT=50 000` ⇒ 置 `filesTruncated`，停止。
3. `pending` 读完 ⇒ 关闭 `pending.fd`，`cursorDir++`，`pending = undefined`。
4. **预算**：整体 `min(HISTORY_ENUM_BUDGET_MS=1500, remaining)`；每一步经 `historyStep`。预算耗尽时在**文件边界**停下（`pending.next` 记住偏移）。**保证推进**：每次调用至少「完成 1 个目录」或「64 个文件的 lstat」或「记录 1 次错误计数」（取先到者），即使已超预算；zombie 熔断时例外（不推进，返回 `partial:{zombie}`）。错误计数也算推进，所以每个阻塞点最多拖 3 个请求。
5. 本次新收集的 `batch` **按枚举顺序 append** 到 `files`（v3.1 不再在批内排序，见 PD23）。`complete = cursorDir === dirs.length && pending === undefined`。

**PD23（dispatcher 裁定，v3 行为偏离）——返回页的排序**：`files[]` 是枚举顺序（目录顺序），所以未完成的 gen 的前几页不是「最新优先」。v3.1 的处理：`page()` 在出页前把**本页的 items** 按 `(mtimeMs desc, key asc)` 排序（只排返回的 items，不动 `files[]` 和 `pos`——游标语义不变），同时 `stats.enum.complete === false` 期间 UI 显示「排序在枚举完成前为近似」。不再加候选排序层。这是对 arch §4.1.1「全局按 mtime 倒序」的有意偏离，只在 `enumPartial` 发生时可见（E7：warm 下全量枚举 ≈107 ms，一次 `advance` 内就 `complete`，此时 `files[]` 在 `page()` 第一次出页前已完整，可以**整体排一次**：`complete` 在首次 `advance` 内达成 ⇒ `files.sort((mtime desc, key asc))` 后再出页，首页就是全局最新优先；否则不排 `files[]`）。

**gen 的生命周期**：最多保留 `HISTORY_GEN_MAX=4` 个（LRU）；空闲超过 60s 或创建满 5 分钟即失效（关闭 fd）。首页请求（不带 cursor）：**若最新 gen 未 `complete`，总是复用它**（续枚举是唯一能让它收敛的途径）；若 `complete` 且未满 `HISTORY_GEN_REUSE_MS=10s`，复用；否则新建。带 cursor 时 `genId` 找不到 ⇒ `cursor-expired`（UI 自动从头重来一次，§4.7）。

**页内遍历**：`advance` 之后，从 `pos` 开始依次处理 `files[pos..]`。每次访问文件都先重新 `open("/proc/self/fd/<rootFd>/<dir>", O_DIRECTORY|O_NOFOLLOW)` + fstat 比对 `file.dir.{dev,ino}`（E8d），再经该 dirFd 打开文件（`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`）+ fstat `isFile()`；同一页内同一目录的 dirFd 复用，页结束时关闭。每个文件得到下面一种结果：

| 结果                                                                 | 是否消费（pos+1）                                                      | 输出                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 已索引且有合法 header                                                | 是                                                                     | 经 kind/q 过滤后输出为行，或被过滤掉；`ioFailures.delete(key)`   |
| 格式错误（`no-header/bad-header/too-long-header`，按 ino/size 缓存） | 是                                                                     | `gen.invalid++`                                                  |
| 目录 fstat 的 dev/ino ≠ `file.dir`，或目录 open 得 ENOTDIR/ELOOP     | 是                                                                     | `gen.changed++`（目录被换/重建；**不跟随**，E8b/E8d）            |
| 文件 open 返回 ENOENT/ENOTDIR（gen 之后文件被删）                    | 是                                                                     | `gen.vanished++`                                                 |
| 文件 open 返回 ELOOP，或 fstat 不是普通文件（symlink/FIFO）          | 是                                                                     | 记为 invalid（E8c / E5d）                                        |
| IO 失败（超时、EIO、EACCES、`busy`），且 `ioFailures[key] < 3`       | **否**：本页在这个文件之前截断，`partial:{reason:"io"}`，`next` 指向它 | `ioFailures[key]++`                                              |
| IO 失败，且 `ioFailures[key]` 达到 3（**连续**）                     | 是                                                                     | `gen.skipped++`；页面 `incomplete:true`；文件留到下一个 gen 再试 |
| 预算已经耗尽（还没尝试）                                             | 否：截断，`partial:{reason:"budget"}`                                  | —                                                                |
| zombie 熔断（无法尝试）                                              | 否：截断，`partial:{reason:"zombie"}`                                  | —                                                                |

规则：

- **`ioFailures`/`enumRetry` 都是「连续」计数**：任一次成功就 `delete(key)`。失败、成功、失败、失败 ⇒ 计数 2，不 skipped。
- **每个请求至少尝试 1 个文件**（zombie 熔断除外）。IO 失败照样计数，所以最坏 3 个请求后一定前进；加上 `advance` 的最少推进量，**翻页与枚举都必然收敛**。
- 凑满 `limit` 行，或累计响应体积 ≥192 KiB 时结束本页；返回前按 PD23 排序本页 items。
- `next`：`pos < files.length` 或 `!complete` ⇒ 给出；两者都不成立 ⇒ 省略（到底）。
- **gen 内的变化**：gen 创建之后被追加内容（mtime 变大）或被替换（同目录内 ino 变化）的文件，仍按它在 gen 里的位置出现，`mtimeMs/size` 字段取 gen 里的值；头部按当前 inode 重新校验（PD8）。所以同一个 gen 内**不会重复，也不会丢**。目录级替换 ⇒ `changed`，不再读。
- `stats` 全部取 gen 累计值（不是本页增量）：`stats.skipped = filesSkipped + skipped`（枚举期 + 翻页期）、`stats.changed`、`stats.enum = {complete, dirsDone: cursorDir, dirsTotal: dirs.length, dirsSkipped, dirsTruncated?, filesTruncated?}`。
- **`HistoryPage.incomplete`（评审 #1）** `= !complete ∨ stats.skipped > 0 ∨ dirsSkipped > 0 ∨ changed > 0 ∨ dirsTruncated ∨ filesTruncated`。也就是：**只要有任何「存在却没被放进行/过滤/invalid/vanished 四个桶」的可能，就不省略 `incomplete`**。`complete` 只表示枚举游标走完，不表示没有遗漏。
- 头部索引 `Map<key, Entry{dev, ino, size, head?, formatError?}>` 跨 gen 共享；IO 失败永远不进索引，所以**新 gen 一定会重试 skipped / dirsSkipped / changed 的内容**。
- 跨 gen 可能重复（同一文件在旧 gen 的页和新 gen 的页都出现）——这是 keyset 换成 gen 的已知代价，UI 按 key 去重（§4.7.1）。

**属性测试声明（必须与上面的设计一致）**：对任意生成的目录/文件集合（含一个 ≥2600 文件的大目录），以及「随机枚举预算截断（含每次只够 1 个目录或 64 个文件）、**随机注入 readdir / lstat 错误（瞬时：失败 k<3 次后成功；永久：一直失败）**、gen 创建后随机修改 mtime/ino、随机删除、随机把目录换成 symlink、随机注入翻页期 IO 失败、随机索引预算截断」的组合，**沿着同一个 gen 的 `next` 一直翻到 `next` 消失**，结果满足：① gen 创建时存在的每个文件**恰好**落入一个桶：行、被过滤、invalid、vanished、skipped、changed、或「所属目录 dirsSkipped」；② 只有连续 3 次失败之后，才可能落入 skipped / dirsSkipped（瞬时错误**永不**导致 skipped）；③ 每一页的 items 按 `(mtime desc, key asc)` 有序（PD23）；④ gen 创建之后的修改不改变成员和顺序；⑤ `complete` 最终为 true，且翻页次数 ≤ `dirs + ceil(files/64) + 3·(错误注入点数) + ceil(files/limit) + 常数`；⑥ **`incomplete` 省略 ⇔ 所有文件都落在行/被过滤/invalid/vanished 四个桶里**（任何 skipped/dirsSkipped/changed/truncated ⇒ 每一页都带 `incomplete:true`，包括最后一页）；⑦ **任何页上，`incomplete` 省略 ⇒ 此时不存在「存在于磁盘但尚未进入 `files[]` 且不在错误桶」的文件**（即 `complete` 为 true 且无错误桶）。

**规模测试（评审 #2 的硬门）**：fake fs 夹具 250 目录 / 5 616 文件（其中一个目录 2 625 个，复刻 E7 分布），把枚举预算钉成「每次 `advance` 只允许 1 次 readdir 或 64 次 lstat」：从首页起不断按 `next` 翻页，断言所有页的 key 并集 **等于**全部文件集合、无重复、最终 `stats.enum.complete === true` 且末页 `incomplete` 省略；再把中途的「首页请求」（不带 cursor）插进去 3 次，断言它复用了同一个 genId 而不是新建。**目录替换测试（评审 #2）**：真实 tmp fs，gen 创建后（`cursorDir` 停在 d1 之前）把 `R/d1` 换成指向另一个目录（含一个合法 header 的 `.jsonl`）的 symlink 并把真目录改名 ⇒ 后续页**不包含**那个外部文件、`stats.changed === 1`、`incomplete:true`；fake fs 断言 `readdir`/`open` 收到的路径全部以 `/proc/self/fd/` 开头（**从不**以 `R/` 开头）。

#### 4.5.4 `cwd.ts`

`realpath`：ENOENT/ENOTDIR ⇒ `gone`，其他错误 ⇒ `no-access`。然后 `stat.isDirectory()`，否 ⇒ `not-dir`；`access(R_OK|X_OK)`，失败 ⇒ `no-access`；`rp !== cwd` ⇒ `moved`；否则 `ok`。单步 200ms，单请求 500ms，按 cwd 缓存 30s；预算外或熔断 ⇒ `unknown`（不缓存）。行字段：`startable = idValid ∧ cwdState ∈ {ok, unknown}`；`blocked` 按 v1 的规则。

#### 4.5.5 占用检测：best-effort（PD10'；`proc.ts` + `occupancy.ts`）

**口径（§14.1）**：hub 不证明「无人持有」，只回答「有没有检测到占用，检测本身完不完整」。两者都否定时才允许原地 `--session`；任何肯定都 fork + 警告。

**`prove(pin, deadline)`**（异步，有界，`PROC_SCAN_BUDGET_MS=300`）：

1. **kind**：`pin.kind === "sub"` ⇒ `{reason:"subagent"}`；`"unknown"` ⇒ `{reason:"unverified", gap:"kind"}`。依据：运行中的子会话由父进程在进程内持有，fleet 行不带文件路径，无法按文件匹配（E19）；只有正面判定为主会话的文件，才能用「卡片 session」这个信号排除占用。
2. **C1 卡片**（同步）：任一卡片（任意状态）的 `session.sessionId === pin.id`，或 `session.sessionFile ∈ {pin.abs, agentDir + "/sessions/" + key}` ⇒ `{reason:"open", live:{state:"open", by:"card", agentKey, pid}}`。
3. **C2 受管记录**（同步）：非终态记录的 `sessionTarget.id/file` 或 `sessionId/sessionFile` 命中 ⇒ `{reason:"open", live:{by:"managed"}}`；终态记录命中且 `deathOf !== "confirmed"` ⇒ 同样处理。
4. **C3 完整 `/proc` 扫描**（`proc.ts::scanAsync`）：
   - `readdir("/proc")` 取数字项；超过 `PROC_SCAN_PID_MAX=8192`、预算耗尽、zombie 熔断、`/proc` 不可读 ⇒ `{reason:"unverified", gap:"proc-partial"}`（token `complete:false`，列表侧 `liveness:"partial"|"no-proc"`）。
   - 对**每个** pid：`stat("/proc/<pid>")` 取 uid；读 `/proc/<pid>/stat`，解析 `comm`（第一个 `(` 与**最后一个** `)` 之间）、`state`、`starttime`（复用 `protocol/proc-identity.ts` 的 `parseStartTicks`）。ENOENT/ESRCH ⇒ 进程已退出，不记录；**同 uid** 进程得到其他错误 ⇒ `gap:"proc-partial"`；其他 uid 的错误忽略（只记 `cls:"other"`，starttime 记 −1）。state `Z`/`X` ⇒ 记录但 `cls:"other"`。
   - **候选分类（E4）**：同 uid 且 `comm === "pi"` ⇒ `cls:"pi"`；同 uid 且 `comm` 以 `node` 开头 ⇒ 读 `/proc/<pid>/cmdline`（**只在异步段**；计入 IO 闸），`basename(argv[1]) === "pi"` 或 `argv[1]` 以 `/pi-coding-agent/dist/cli.js` 结尾 ⇒ `cls:"pi"`，否则 `cls:"node-other"`；其余 ⇒ `cls:"other"`。排除 `hubPid`。其他 uid 的进程**不分类**（§0 C4，残余 W3）。
   - token = `{at, complete:true, pids: Map<pid, ProcSeen>}`——**所有** pid，不只候选。
5. **候选对号**：每个 `cls:"pi"` 的 pid 必须满足其一：(a) 一张 `state==="live"` 且 `session !== undefined` 的卡片 `agentId.pid === pid`；(b) 一条非终态受管记录 `pid === pid && procStartTicks === startTicks`。对上 `claiming/stale` 卡片，或 live 但无 session 的卡片 ⇒ `{reason:"unverified", gap:"card-unproven", live:{by:"card", pid}}`；对不上任何东西 ⇒ `{reason:"maybe", gap:"unconnected-pi", live:{state:"maybe", by:"proc", pid}}`。多个候选同时失败时按 `open > subagent > maybe > unverified` 取最严重的一个上报。
6. 以上都没有肯定 ⇒ `{free:true, scan}`。

**`reprove(pin, scan)`**（同步，auth2 之后、`start()` 之前，中间零 await；`proc.ts::rescanSync`）：

1. 重跑 C1/C2（同步）。
2. **全量重 stat**（评审 #1 的闭合点）：`readdirSync("/proc")`，对每个数字 pid `statSync("/proc/<pid>")` + `readFileSync("/proc/<pid>/stat")`（**不读 cmdline**：读 cmdline 要拿目标进程的 mmap 锁，D 状态进程会把读取方一起卡住；`stat` 不取该锁，supervisor 的 L5 身份复核已在同步段这样读）。对每个 pid：
   - 在 token 里：`starttime` 不同，或 `comm` 不同，或 `uid` 不同 ⇒ **pid 被复用**；若现在是同 uid 且 `comm ∈ {"pi"} ∪ node*` ⇒ `{reason:"unverified", gap:"new-process", live:{by:"proc", pid}}`；否则忽略（被别的东西复用）。state 变为 `Z`/`X` 的 token 候选 ⇒ 忽略（它退出了，不构成占用）。
   - 不在 token 里（新 pid）：同 uid 且 `comm === "pi"` 或以 `node` 开头 ⇒ `gap:"new-process"`（node* 不读 cmdline，一律保守判定——同步段里新出现的任何 node 进程都让这次 resume 变成 fork，UI 文案说明）。
   - 读 `stat` 得到 ENOENT/ESRCH ⇒ 进程已退出，忽略；同 uid 的其他错误 ⇒ `gap:"proc-partial"`。
   - **预算**：`performance.now()` 计时，超过 `PROC_SYNC_MS=50` 或 pid 数超过 `PROC_SCAN_PID_MAX` ⇒ `gap:"proc-partial"`。E6：310 个 pid 全量 5–8 ms，同 uid 过滤后 2.2 ms；50 ms 约覆盖 3000 个 pid（线性外推），超出就 fork。
   - token `complete:false` 时**不得**调用 `reprove`（路由在 `prove` 返回 gap 时已经 409）。
3. 都没有肯定 ⇒ `{free:true, scan}`。

**为什么全量重 stat 而不是 readdir 差分**：差分只看「新 pid」，一个在首扫里被看到、随后退出、pid 被新 pi 复用的进程不在差分里（评审 #1 的场景）。token 里带 starttime 后，差分还得对「仍在的 token pid」逐个重读 stat——那就是全量重 stat 减去新 pid 部分，省不了什么；全量重 stat 没有任何集合运算，单元测试只需要「两张 pid 表」就能穷举。

**残余窗口（§14.1 要求披露；写进文档、AGENTS.md、UI 常驻说明）**

| #   | 窗口                                                                                                            | 量级 / 理由                                                                | 检测/后果                      |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| W1  | `reprove` 结束之后，到我们的 pi 子进程 open 会话文件之间，有新的 pi 进程启动并打开了同一个文件                  | ≈ pi 启动时间（0.3–2s）；与用户同时在两个终端里打开同一会话等价            | 不可检测；会话树分叉，不丢数据 |
| W2  | 一个已连接的 pi 刚在 TUI 里 `/resume` 到目标，但 session 帧还没到 hub                                           | 毫秒级（本机 Unix socket）                                                 | 同上                           |
| W3  | root 进程、其他 uid、其他 pid namespace（容器）里的 pi                                                          | 超出 hub 的观察域；v2 的 `foreign-uid` 只覆盖「uid 0 或文件 g/o+w」这一角  | 同上                           |
| W4  | 启动器既不是 `pi` 也不是 `node*`（bun、单文件可执行）且**尚未改写 title**（改写后 `comm="pi"`，可见）           | 只在该进程的启动窗口内                                                     | 同上                           |
| W5  | 一张 live 卡片的进程已死、socket EOF 还没被 hub 处理、pid 已被一个未连接的 pi 复用                              | 微秒级；v2 的「首见 starttime 账本」只覆盖这一条，v3 砍掉                  | 同上                           |
| W6  | **restore 重 fork 不重跑占用检测**（PD21'）：hub 重启间隙里别的进程打开了同一文件，重启后 hub 照常 `--session`  | §14.1 明示的产品例外；RH4 断言                                             | 同上                           |
| W7  | **W-resume「换走又换回」**：`verifyForSpawn` 之后、pi open 之前文件被换，pi 打开的是替身，goLive 复核前又被换回 | 需要同 uid 写权限 + 两次精准竞态；「换走不换回」能被 §4.5.6 复核抓住并停掉 | HH10b 记录为不可检测           |

#### 4.5.6 fd 锚定解析与路径复核（PD11；`pin.ts`）

**`pinSession(ref, cwd, deadline)`**：异步，有界，单次总预算 `min(800, remaining)`；所有 open 都经 `historyStep`；超时后才到达的 fd 由 lateClose 回收（照 preview/admit 的写法）。步骤：

1. `isValidSessionKey` 不通过 ⇒ `session-ref`。
2. `R = realpath(agentDir/sessions)`；`rootFd = open(R, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，fstat 必须是目录且 uid 相符，记 `root:{dev,ino}`。
3. `dirFd = open("/proc/self/fd/<rootFd>/<dir>", O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`：ENOENT ⇒ `session-missing`；ENOTDIR/ELOOP ⇒ `session-invalid`（E5b）。fstat uid 相符，记 `dir:{dev,ino}`。
4. `fileFd = open("/proc/self/fd/<dirFd>/<file>", O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`：ENOENT ⇒ `session-missing`；ELOOP ⇒ `session-invalid`（E5c）。fstat 必须 `isFile()`、uid 相符、**`nlink === 1`**（pi 从不硬链接会话文件；>1 ⇒ `session-invalid`），记 `file:{dev,ino}`、`size`。
5. 经 `fileFd` pread 前 4 KiB，交给 `checkSessionHeader(head, {id: ref.id, cwd})`：id 或 cwd 不符 ⇒ `session-mismatch`，其他错误 ⇒ `session-invalid`。
6. kind 优先用索引里同 dev/ino 条目的结果；没有就**经 fileFd** 读不超过 256 KiB 的头部窗口来判定。
7. 返回 `SessionPin`（持有三个 fd，`abs = R + "/" + key`）。**路由必须在 `finally` 里调用 `release()`**，覆盖所有退出路径，包括 202。

**`verifyForSpawn(pin)`**：同步，只用于 resume。`fstatSync(fileFd).nlink === 1`；`lstatSync(R)`、`lstatSync(R/dir)`、`lstatSync(abs)` 都不是 symlink，dev/ino 分别等于 `root/dir/file`；`lstatSync(abs).nlink === 1`；`realpathSync(abs) === abs`（同时覆盖 R 的祖先被换成 symlink）。任一不满足 ⇒ `session-changed`。

**`captureSessionPathPin(abs, uid, R)`**（同步，按**路径**；供 supervisor 在 `restoreForkSync` 里对 `--session <file>` 使用，history 开启时；PD24，评审 v3.1 #3）——与首次 resume 的 `pinSession` + `verifyForSpawn` **同一套检查**，只是按路径而非 fd：

1. `R = realpathSync(agentDir/sessions)`；`abs` 必须以 `R + "/"` 开头，剩余部分必须通过 `isValidSessionKey`（恰好 `<dir>/<file>`）；否则 `detail:"session file outside sessions root"`。
2. `lstatSync(R)`、`lstatSync(R/dir)`、`lstatSync(abs)`：都不是 symlink；前两者 `isDirectory()`；文件 `isFile()`、`nlink === 1`、`uid === uid`；记三级 dev/ino。
3. `realpathSync(abs) === abs`（覆盖任何祖先层的 symlink）。
4. 全部通过 ⇒ `{ok:true, pin}`；任一失败 ⇒ `{ok:false, detail}`，detail 只含固定英文短语（不含路径）。

**失败语义**：supervisor 调 `failRestorePreflight(rec, "session-invalid", detail)`——与 `planSessionArgv` 失败走同一条路（restore 的 attempts/有界重试/`restoreFailure` 审计都照旧），**不**再以 `--session` 启动。代价：history 开启时，`sessionFile` 不在 `R` 下的受管会话（pi 自定义 sessionDir，arch §1.3 非目标）不能被 restore 重 fork；用户要么关闭 `webHub.spawn.history`（回到原 restore 路径——该路径**不携带** history 的路径 pin 保证，§5），要么接受。

**`verifySessionPathPin(pin, reported)`**（同步；supervisor 在 goLive 时调用）——评审 #3 的全部要求：

1. `reported !== undefined && reported === pin.abs`（**逐字节**；HC1 证明 pi 对已归一的绝对路径原样上报）。否则 `detail:"sessionFile differs from launched path"`。
2. `lstatSync(dirname(dirname(pin.abs)))`、`lstatSync(dirname(pin.abs))`、`lstatSync(pin.abs)`：都不是 symlink；dev/ino 分别等于 `pin.root/dir/file`；文件 `isFile()` 且 **`nlink === 1`**（硬链接：同 ino 的硬链接放在被换掉的目录里，dev/ino 单独会放过，目录级 dev/ino + nlink 一起才挡得住）。
3. `realpathSync(pin.abs) === pin.abs`。
   任一失败 ⇒ `{ok:false, detail}` ⇒ supervisor 记 `hintDetail:"session-swapped"` + 审计 state 行（detail 只含上述英文短语，不含路径）+ `enterStopping(rec, "protocol_error")`（PD3：不扩展枚举）。

**为什么不能把 fd 交给 pi**：跨 exec 只能传路径。`/proc/<hubPid>/fd/N/<file>` 或继承来的 `/proc/self/fd/3/<file>` 都能打开，但 pi 会从 `dirname(path)` 推导 sessionDir，并把这个路径当作 sessionFile 上报和持久化：hub 一重启路径就失效，restore、C1 路径匹配和 /resume 都会坏。所以 resume 只能传字面路径 `abs`。剩余风险：

- **W-resume**：从 `verifyForSpawn` 到 pi 自己 open 文件（spawn 加 node 启动，约 0.3–2s）。需要同 uid 用户替换 `~/.pi/agent/sessions` 下的路径，信任等级与 restore 相同。两种形态：**换走且不换回** ⇒ goLive 的 `verifySessionPathPin` 抓住并停掉（HH10）；**换走又换回** ⇒ 不可检测（W7，HH10b）。
- **W-fork**：源文件**没有**窗口，快照是经 fileFd 读出来的（§4.5.7）。快照放在 hub 自有的 0700 目录，sync 段 `verifySnapshot` 之后到 pi open 快照之间，只有同 uid 用户能篡改。

#### 4.5.7 fork 快照（PD12；`snapshot.ts`）

- 目录 `forkSrcDir`：首次使用时 `mkdir(0700)`，lstat 确认不是 symlink、uid 相符、mode 为 0700，否则 fork 返回 503 `E_LAUNCHER{reason:"persist"}`。
- 文件 `snap-<base64url(12B)>.jsonl`，用 `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` 创建。从 **fileFd** 以 64 KiB 为块 pread `[0, pin.size)`，每块经 `historyStep`；超过 `HISTORY_SNAPSHOT_MAX_BYTES = 128 MiB` ⇒ `session-too-large`（本机最大的会话 47 MB）；总预算 `min(4000, remaining - 3000)`，超时 ⇒ 504，并删除半成品。写入内容截到**最后一个 `\n`**，只保留完整行。写完 fstat 记下 dev/ino/size。
- 清理（supervisor，P-route）：记录上的 `forkSnapshot` 字段只在内存里。goLive 时 pi 早已完成 forkFrom，此时同步 unlink 快照；`finalizeTerminal` 时也 unlink；supervisor `init()` 时清扫 `forkSrcDir`：lstat，只删普通文件，从不跟随 symlink。请求在 `start()` 之前失败时，路由调用 `discard()`。
- `parentSession` 悬空：PD12 已接受。在 AGENTS.md 和 acceptance 里写明。

#### 4.5.8 P-scan 测试锚点（`tests/web-hub/hub/spawn/history/`）

| 文件                                                       | 钉住的内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `head.test.ts`                                             | header 矩阵；跨块；system/assistant 行跳过；截断行宽松提取；转义串 `\"pi_subagent_types\":` 不算 main；标记优先；session_info 取最后一条；EOF ⇒ incomplete；**属性测试**：任意分块结果相同；性能：120 KiB 的快照行不会被 JSON.parse（parse 计数 seam）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `head-pins.test.ts`                                        | 源码对拍：`PROMPT_SECTIONS_ENTRY_TYPE`/`NAMES`（`src/prompt-sections/store.ts:3,21`）、`SESSION_START_ENTRY_TYPE`、`WEB_ORIGIN_ENTRY_TYPE`、`SUBAGENT_CHILD_CUSTOM_TYPE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `title.test.ts`                                            | 与 `stripSkillEnvelope` 对拍（≥12 条语料）；代理对截断；优先级：卡片名 > 头部名 > 首条消息                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `generation.test.ts`                                       | §4.5.3 的**属性测试**（声明逐字照抄，含 ⑥⑦：**注入 readdir/lstat 瞬时与永久错误后，`incomplete` 省略 ⇔ 无任何遗漏；瞬时错误永不 skipped**）、**连续计数**（fail, success, fail, fail ⇒ `ioFailures=2`、不 skipped；枚举期 `enumRetry` 同理）、**fd 锚定**（fake fs 记录 `readdir`/`open`/`lstat` 收到的路径全部以 `/proc/self/fd/` 开头；gen 失效时 rootFd/pending.fd 被关闭——fd 计数回到基线）、**目录替换**（真实 tmp fs：gen 创建后把未枚举的 `R/d1` 换成指向外部目录的 symlink ⇒ 外部文件不出现、`stats.changed===1`、`incomplete:true`；已枚举目录被 rename+重建 ⇒ 翻页时该目录的文件记 `changed`，E8d）、**PD23 排序**（未完成 gen 的每一页 items 按 mtime 倒序；一次 advance 内 complete ⇒ 首页全局倒序）与**规模测试**（250 目录 / 5 616 文件 / 枚举预算钉成 1 readdir 或 64 stat ⇒ 并集 = 全集、无重复、`complete` 收敛、首页请求复用未完成 gen）；gen 复用、过期、LRU；IO 失败不消费，第 3 次才 skipped；ENOENT ⇒ vanished；换成 FIFO ⇒ invalid 且不挂（真实 mkfifo）；每请求至少推进 1 个文件；zombie ⇒ 不推进；根目录 readdir 失败 ⇒ 不建 gen；`dirsTruncated/filesTruncated` 置位且 `complete` 仍能为 true；**skipped 语义**：fake fs 让文件 X（内容含 `q="needle"`）open 失败 3 次 ⇒ 带 `q=needle` 的翻页返回 0 行、`stats.skipped===1`、`incomplete:true`；fs 恢复后**同一 gen** 内再翻 ⇒ 仍 0 行（已消费）；新 gen（时钟 +11s 的首页请求）⇒ 命中 1 行且 `incomplete` 省略 |
| `index.test.ts`                                            | 重读条件（计数 seam）；格式错误缓存，IO 错误不缓存；q/kind 过滤；卡片名覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cwd.test.ts`                                              | 六种状态；缓存；熔断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `proc.test.ts`（fake procFs：两张可编程 pid 表）           | `scanAsync`：comm 含 `)`；hub pid 排除；node* 读 cmdline 后判为非 pi（jiti-cli 样例，E4）⇒ `node-other`；`node …/dist/cli.js` ⇒ `pi`；其他 uid 不分类；ESRCH 跳过；同 uid EACCES ⇒ partial；8192 上限 ⇒ partial；token 含**全部** pid。`rescanSync`：**PID 复用矩阵**——token 候选 pid 的 starttime 变了（新 pi）⇒ new-process；starttime 变了但现在是 bash ⇒ 忽略；token 里的 `other` pid（bash）退出后被新 pi 复用（同 pid、不同 starttime）⇒ **new-process**（这就是评审 #1 的场景）；token 里的其他 uid pid 被同 uid pi 复用 ⇒ new-process；候选变 `Z` ⇒ 忽略；新 pid comm `node` ⇒ new-process；新 pid comm `bash` ⇒ 忽略；pid 数或耗时超限 ⇒ partial；**源码扫描**：`rescanSync` 函数体里没有 `await`、没有 `cmdline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `occupancy.test.ts`（fake procFs + fake registry/managed） | kind unknown ⇒ unverified/kind；kind sub ⇒ subagent；C1（id / abs / 字面 agentDir 路径 / stale 卡片）；C2（launching 的 target、live 的 sessionId、终态 + deathOf 三种值）；proc-partial ⇒ unverified；unconnected-pi ⇒ maybe + pid；card-unproven（claiming / stale / live 无 session）；受管子进程按 pid+procStartTicks 对上 ⇒ 不阻断；live 卡片按 pid 对上 ⇒ 不阻断；全部满足 ⇒ free + token；多候选取最严重；`reprove` 把 `rescanSync` 的裁决映射成 OccupancyProof；token `complete:false` 时调用 `reprove` 抛出（防御）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pin.test.ts`（真实 tmp 文件系统）                         | key 矩阵；dir 层被换成 symlink（E5b）⇒ session-invalid；文件是 symlink（E5c）⇒ session-invalid；**文件 nlink===2** ⇒ session-invalid；ENOENT ⇒ session-missing；owner 不符（fake fstat）；header id 或 cwd 不符 ⇒ session-mismatch；**resolve 之后 rename 掉 dir 并换成 symlink** ⇒ `verifyForSpawn` 返回 `session-changed`，且已固定的 fd 读到的仍是原文件（E5a）；R 的祖先被换成 symlink ⇒ realpath 复核失败；`release()` 可重复调用；超时之后到达的 fd 被关闭。**`captureSessionPathPin` 矩阵**（真实 tmp fs）：`R/<dir>/<file>` 正常 ⇒ ok 且三级 dev/ino 正确；`abs` 在 R 之外 ⇒ `outside sessions root`；`R/<dir>/sub/<file>`（三段）⇒ 同上；R 的祖先是 symlink（abs 以字面 R 开头但 `realpathSync(abs) !== abs`）⇒ 失败；dir 是 symlink ⇒ 失败；文件 nlink 2 ⇒ 失败；uid 不符（fake）⇒ 失败；`R=""` ⇒ 失败。**`verifySessionPathPin` 矩阵**：reported undefined ⇒ 失败；reported 多一个 `/` 或大小写不同 ⇒ 失败；原文件被 rename 走、同名位置放一个它的硬链接且父目录被换成另一个目录（dev/ino 同、dir ino 不同）⇒ 失败；父目录换成 symlink ⇒ 失败；不同 ino ⇒ 失败；原样 ⇒ ok                                                                                                                                                                                                                                                                                                      |
| `snapshot.test.ts`                                         | 半行尾不复制；源文件 sha 不变；0600；O_EXCL；超过上限 ⇒ too-large；超时删除半成品；目录是 symlink 或 mode 不对 ⇒ 拒绝；启动清扫只删普通文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `budget.test.ts`                                           | 准入条件 `inflight + zombies < 2`（并发第 3 个立即 busy）；底层操作 settle 之后恢复；所有 timer 都 unref                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `service.test.ts`                                          | `diag()`：无 seams ⇒ `{procFsSource:"default", fsSource:"default"}`；注入 `procFs` ⇒ `"seam"`；构造后不存在任何后台 timer 或任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `restore-plan.test.ts`                                     | 零改动 + `checkSessionHeader` 的 5 个 detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**验收**：上述测试全绿；`source-scan`（零 `as`）、`boundary` 测试零改动通过；service 构造后不存在任何后台 timer 或任务。

---

### 4.6 P-route — 路由、准入、supervisor、投影、审计

**文件**：`hub/spawn/{routes,supervisor,project,dirs}.ts`、`hub/audit.ts`；测试 `tests/web-hub/http/spawn-kit.ts`、`api-headless-history.test.ts`（新）、`headless-matrix.test.ts`、`lan-headless.test.ts`、`tests/web-hub/hub/spawn/{supervisor,dirs,project}.test.ts`、`routes-digest.test.ts`（新）、`tests/web-hub/hub/audit.test.ts`。

#### 4.6.1 `dirs.ts`

`AdmitRejection` 加 `"moved"`。`admit(raw, scope, deadline, opts?: {sessionBacked?: true})`：sessionBacked 时，步骤 2 之后若 `rp !== expanded` ⇒ `moved`；否则跳过 scan，直接返回 `known:true`。不带 opts 时代码路径不变。

#### 4.6.2 `routes.ts`

- `SpawnRoutesDeps.history?: HistoryService`；`historyOn = cfg.history === true && deps.history !== undefined`。
- 导出 `intentDigest`/`SpawnIntent`。`intent.session = {key, id, mode}`（mode 归一化）；只在有 session 时，在 firstPrompt 段之后追加 `"session":{"id","key","mode"}`。
- `handle`：`historyOn` 时 `/api/headless/history` 的 GET 走 `handleHistory`，其他方法返回 404；关闭时整段跳过。
- `handleHistory`：按 §3.6 的顺序；`page()` 返回 `cursor-expired` ⇒ 409；policy 不允许 ⇒ 所有行 `startable:false`。
- **`handleSpawn` 的 session 分支**（不带 session 时逐行等价于现状；现有 gate 编号见 `routes.ts:412-683`）：

```
gate 5  parse(opts.session = historyOn)；session-ref / model-with-session ⇒ 400
gate 6  dup 命中 ⇒ 202（带 session，取自记录）
gate 7  rate
gate 8  [admitted, resolved] = Promise.all([dirs.admit(cwd, scope, dl, {sessionBacked:true}), history.resolve(ref, cwd, dl≤800)])
        拒绝优先级：resolved 失败（含 504）> admitted 失败（含 moved）。从这里起 pin 由 try/finally 释放
gate 8' proof = await history.prove(pin, dl = deriveBudget(remaining, 300, 3000))
        mustFork = !proof.free；forkReason/gap/live 取自 proof
gate 9' mustFork ∧ mode≠"fork" ⇒ 409 session-open {resolvedCwd, forkReason, proofGap?, live?}（不写 LRU）
gate 9  原 confirm（LAN 下恒为 always；session-backed 恒为 known）
gate 9" mode==="fork" ⇒ snap = await history.snapshot(pin, dl)；too-large ⇒ 400；504 ⇒ 504
gate 10 auth2（失败时 snap?.discard()）
—— 同步段，零 await ——
  mode==="resume": p2 = history.reprove(pin, proof.scan)（proof.free 为真时 scan 必然 complete）
                   !p2.free ⇒ 409 session-open（用 p2 的 reason/gap/live）
                   history.verifyForSpawn(pin) 失败 ⇒ 409 E_DIR{session-changed}
  mode==="fork":   !history.verifySnapshot(snap) ⇒ 409 E_DIR{session-changed}（并 discard）
  newId = mode==="fork" ? randomUUID() : undefined；effectiveModel = ""（PD13）
gate 11 supervisor.start({…, session:{mode, abs: mode==="resume" ? pin.abs : snap.path,
        id: pin.id, newId?, pathPin: {abs, root, dir, file}（仅 resume）, snapshot?: snap.path}})
        start 失败 ⇒ snap?.discard()
202     body.session = {mode, id: newId ?? pin.id}；request 审计行加 session/sessionLive/sessionKind/forkReason/proofGap
finally pin.release()
```

#### 4.6.3 `supervisor.ts`

- `SpawnAuditRecord`：`endpoint` 加 `"history"`；新增字段 `session?: "resume"|"fork"`、`sessionLive?: "open"|"maybe"|"none"`、`sessionKind?: HistoryKind`、`forkReason?: ForkReason`、`proofGap?: ProofGap`；`code` 联合追加 `"session-swapped" | "session-unexpected"`（审计 state 行的 code 是内存/日志枚举，不进 spawns.json）。
- `SpawnSupervisorDeps` 追加可选 `sessionPathPin?: { capture: CaptureSessionPathPin; verify: VerifySessionPathPin; sessionsRoot(): string }`（hub.ts 在 history 开启时从 `history/pin.ts` 注入；**缺省 ⇒ 不做 capture/verify，行为逐字节同现状，且不携带 history 的路径 pin 保证**）。
- `AdmittedRequest.session?: {mode; abs; id; newId?; pathPin?: SessionPathPin; snapshot?: string}`。
- `InternalRecord` 加可选的运行时字段（不进入 `toStored`）：`sessionTarget?`、`from?`、`sessionPathPin?: SessionPathPin`、`forkSnapshot?: string`。
- `start()` 的防御检查：session 与 model 同时存在 ⇒ `E_DIR model-with-session`；abs 不是以 `/` 开头、以 `.jsonl` 结尾且不含 NUL/CR/LF ⇒ `E_DIR session-invalid`；fork 时 newId 不满足 `RESTORE_SESSION_ID_RE` ⇒ 同上。argvTail：resume ⇒ `["--session", abs]`；fork ⇒ `["--fork", snapshotPath, "--session-id", newId]`。`sessionTarget`：resume 为 `{id, file: abs}`，fork 为 `{id: newId}`；`from` 相应取值；`sessionPathPin = req.session.pathPin`。
- **`restoreForkSync()`**（`supervisor.ts:2201+`）：`plan.tail[0] === "--session"` 且 `deps.sessionPathPin` 存在 ⇒ `r = capture(plan.tail[1], uid, deps.sessionPathPin.sessionsRoot())`；`r.ok` ⇒ `rec.sessionPathPin = r.pin`；**`!r.ok` ⇒ `return failRestorePreflight(rec, "session-invalid", r.detail)`**（PD24：拒绝这次 restore，有界失败，不 `--session`；审计 `restoreFailure:"session-invalid"` + detail 短语）。`--session-id` 形式没有字面路径，不 capture（pi 会新建文件，没有可被换的目标）。**不重跑占用检测**（W6）。`deps.sessionPathPin` 的形状：`{ capture, verify, sessionsRoot(): string }`（`sessionsRoot` 由 hub.ts 用 `realpathSync(agentDir/sessions)` 提供，10s 缓存，失败时返回 `""` ⇒ capture 必然失败 ⇒ 拒绝）。
- **`goLive()`**（`supervisor.ts:1285`）：
  1. `sessionTarget` 存在且 `session.sessionId !== sessionTarget.id` ⇒ `hintDetail:"session-unexpected"` + 审计，照常 live。
  2. `rec.sessionPathPin` 存在（history resume **或** history 开启下的 restore 重 fork）⇒ `deps.sessionPathPin.verify(rec.sessionPathPin, session.sessionFile)`；失败 ⇒ `hintDetail:"session-swapped"` + 审计 state 行（`code:"session-swapped"`，detail 短语）+ `enterStopping(rec, "protocol_error")`，**不**调用 `adoptSessionCoords`（不把替身坐标持久化为 restore 目标）。成功 ⇒ 删除 `sessionPathPin`（一次性）。
  3. fork 记录：同步 unlink `forkSnapshot`，然后删除该字段。
  4. 其余同现状。
- `finalizeTerminal()`：`forkSnapshot` 还在就 unlink。
- `init()`：清扫 `forkSrcDir`，有界：最多 256 项，lstat 只删普通文件。
- `publicItem()` 加 `from`。

#### 4.6.4 `project.ts` / `audit.ts`

`toPublic`/`toViewer` 加 `from`。`SPAWN_AUDIT_KEYS` 加 `"session","sessionLive","sessionKind","forkReason","proofGap"`。

#### 4.6.5 `spawn-kit.ts`

`FakeDirs` 记录 opts；新增 `fakeHistory()`，实现 `HistoryService` 的每个方法都可编程并记录调用顺序；`reprove`/`verifyForSpawn`/`verifySnapshot` 是同步实现；`fakeSessionPin()` 统计 release 次数；`fakeSessionPathPin()`（capture/verify 可编程）。`spawnKit(cfg, clock, prefs?, history?)`；`KIT_CFG` 不变。

#### 4.6.6 P-route 测试锚点

| 文件                                                 | 钉住的内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes-digest.test.ts`                              | 改代码**之前**先算出三个不带 session 的 digest 的 hex 写进测试；改完之后必须相等；带 session 时 digest 不同，mode 不同时也不同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `api-headless-history.test.ts`                       | GET：403/401/429/四种 400/`cursor-expired` 返回 409/policy 拒绝时 `startable:false`/`incomplete` 与 `stats.enum` 原样透传。POST：**闸门顺序**（fake 记录的调用顺序：admit∥resolve → prove → confirm → snapshot（fork）→ auth2 → reprove → verifyForSpawn / verifySnapshot → start）；`prove` 不 free 且 mode=resume ⇒ 409，带 forkReason/proofGap/live，LRU 未写、start 未调；改为 `mode:fork` 加 confirm 用同一 id 重发 ⇒ 202，`startCalls[0]` 的 argv 素材是快照路径；**sync 段 `reprove` 返回 new-process ⇒ 409 且 start 未调**；`verifyForSpawn` 失败 ⇒ 409 session-changed；`verifySnapshot` 失败 ⇒ 409 且已 discard；`snapshot` too-large ⇒ 400；**每条退出路径上 pin 恰好 release 1 次**（参数化遍历全部拒绝分支）；`start` 失败 ⇒ 快照被 discard；`model-with-session` ⇒ 400；即使设置了 prefs，带 session 时 `startReq.model` 也是 undefined；dup 重放带 session；resolve 与 admit 同时失败 ⇒ 返回 resolve 的错误；`startReq.session.pathPin` 等于 pin 的三级 dev/ino |
| `headless-matrix.test.ts`                            | §5 的六行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lan-headless.test.ts`                               | `lan:"known"`：GET 返回 200；resume ⇒ 409 always，带 confirm 重发 ⇒ 202；fork 加 confirm ⇒ 一次 202；`roots` 走明文 HTTP 时 sessionBacked 仍允许                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `supervisor.test.ts`                                 | argv 精确值（resume / fork 带快照路径），都不含 `--model`；不带 session 的基线原样不变；spawns.json 不含 `from/sessionTarget/sessionPathPin/forkSnapshot`；goLive 时 unlink 快照；终态时 unlink 快照；init 清扫；`session-unexpected`；**`session-swapped` 矩阵**（fake verify 返回失败 ⇒ stopping + hintDetail + 审计 code，`hint` 不变，`sessionFile` 未被采纳为 restore 坐标；verify 成功 ⇒ live 且 `sessionPathPin` 被清掉）；**restore 重 fork**：`deps.sessionPathPin` 存在且 tail 为 `--session` ⇒ capture 被调用、goLive 时 verify 被调用；tail 为 `--session-id` ⇒ 都不调用；**capture 返回 `{ok:false}` ⇒ `failRestorePreflight("session-invalid")`、`forkInto` 未被调用、记录进入 restore 失败路径（attempts +1、`restoreFailure` 审计）**；sessionFile 在 R 之外（fake sessionsRoot）⇒ 同上；**`deps.sessionPathPin` 缺省 ⇒ 现有 restore RS/HR 测试零改动通过**                                                                                                    |
| `dirs.test.ts` / `project.test.ts` / `audit.test.ts` | 同 v1，审计白名单加上 `proofGap`；`code` 新值不进 spawns.json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**验收**：上述测试全绿；`api-headless.test.ts`、restore 系列、SP7 系列零改动通过。

---

### 4.7 P-ui — 历史弹窗与恢复流程

**文件**（相对 `src/web-hub/ui/src/`）：新建 `logic/sessionHistory.ts`、`components/spawn/SessionHistoryDialog.vue`、`components/spawn/HistoryForkConfirm.vue`、`i18n/{en,zh}/history.ts`、`styles/history.css`；修改 `logic/spawn.js`、`logic/token-client.js`、`logic/password-client.js`、`transport/{types,token,password}.ts`、`composables/{useSpawn,useHub,useNewSession}.ts`、`types.ts`、`components/spawn/{NewSessionMenu,SpawnRow}.vue`、`components/agents/AgentList.vue`；测试见 §4.7.3；`tests/web-hub/ui/source-scan.test.ts` 的 localStorage 白名单加上弹窗文件。

#### 4.7.1 逻辑与传输

- 传输层：`SpawnOutcome` 的错误分支加 `live?/forkReason?/proofGap?`；新增 `SpawnHistoryOutcome = {ok:true; page} | {ok:false; error; status; reason?}`；`SpawnTransport.history?(q)`。两个 client 都发 `GET /api/headless/history`（带 `X-PWH`），对 200 的结果做结构收窄（丢弃不合规的项；`stats.enum` 缺失 ⇒ 视为 complete）；409 时保留 `reason`（`cursor-expired`）。
- `useSpawn` 在缺少 `history` 时降级为 `E_UNSUPPORTED`；`useHub` 透传，并为 `createNewSession` 提供 `historyCap()`。
- `types.ts`：`NewSessionInput.session?`；confirming flow 加 `live?/forkReason?/proofGap?`；`NewSessionFailKind` 加 `"session"`。
- `useNewSession`：带 session 但没有 cap ⇒ 本地失败，不发请求（PD14）；带 session 的 body 永远不含 model；`mode:"fork"` 时同时带上 `confirm:true, expectCwd:input.cwd`（PD17）；`confirm()` 时如果 `reason === "session-open"`，把 mode 改成 fork，用同一个 id 重发；session 类的错误 reason ⇒ `failed{kind:"session", code}`。
- `logic/spawn.js`：`history` 动作只在有 cap 时出现；`classifySpawnError` 遇到 session 类 reason 返回 `"session"`。
- `logic/sessionHistory.ts`（纯）：`toRowModel`；`historyListReducer`（事件：`query` / `more` / `page` / `error` / `expired`：重置并按同一个查询从头开始，**每个查询最多自动重来 1 次**）；**按 key 去重**（同一文件可能出现在旧 gen 的页和新 gen 的页，§4.5.3）；`nextRequest`：只在 `partial.reason ∈ {budget, enum, io}` **或 `stats.enum.complete === false`** 时自动续扫，每次输入最多 3 轮，`zombie` 不续扫；`historyErrorKey`；`forkConfirmKey(reason, by, gap)`；`incompleteNotice(stats, incomplete)` 返回要显示的提示 key 列表（枚举中 / 有 skipped / 有 dirsSkipped / 有 changed / 被截断，可组合）；**UI 不再对跨页结果做排序**（服务端已按 PD23 排好本页；跨页近似由文案说明）。

#### 4.7.2 组件

- `NewSessionMenu` 加入「历史会话…」；`AgentList` 在菜单项和 EmptyState 两处都提供入口，并挂载弹窗。
- `SessionHistoryDialog`：搜索防抖 250ms、kind 开关（持久化到 `localStorage["pwh_history_kind"]`）、listbox 语义、只用 textContent 渲染、置灰行、主动作、溢出菜单里的「复制为新会话」、`gotoKey` 用链接实现。flow 渲染：`confirming` 且 reason 为 `session-open` 时显示 `HistoryForkConfirm`，其他 reason 显示 `SpawnConfirm`；`failed{kind:"session"}` 时在行内显示文案并刷新列表；进入 `awaiting` 后关闭弹窗。底部依次是：加载更多 / 自动续扫；`partial` 时「已索引 X / Y…」（`io` 时加「部分文件读取失败，正在重试」）；**`stats.enum.complete===false` 时「正在枚举会话目录（dirsDone/dirsTotal），排序在枚举完成前为近似」**；**`stats.skipped>0` 时常驻横幅「N 个会话文件读取失败，未包含在结果中；刷新列表后重试」**；`liveness` 提示；`files===0` 时 sessionDir 提示；**`stats.enum.dirsSkipped>0 / stats.changed>0 / truncated` 时同一横幅追加「N 个目录无法读取」「N 个会话所在目录已被更改」「列表已达上限」**；**最底部一行常驻小字（§14.1，逐条对应 W1–W7）**：「占用检测为尽力而为：无法检测 root / 容器内 / 非 pi 启动器的进程（W3/W4），检测完成后才打开该会话的进程（W1/W2），**刚退出的 pi 其 pid 被新进程复用的瞬间（W5）**；hub 重启后的自动恢复不重新检测（W6）；**启动期间会话文件被替换又换回无法察觉（W7）**。双开只会使会话树分叉，不会丢失或损坏数据。」——i18n key `history.bestEffortNote`，文案测试断言其中包含 `W5`/`W7` 对应短语（「pid 被新进程复用」「替换又换回」）。
- `HistoryForkConfirm`：文案覆盖 `open/card`、`open/managed`、`maybe/proc`、`subagent`、`manual`、`unverified`：「无法确认此会话当前没有被其他 pi 进程打开（{gapText}）。为避免两个进程同时写入，将复制一份新会话继续，原会话不受影响。」。`gapText` 按 `proofGap` 映射：`kind`「无法判定这是主会话」；`unconnected-pi`「有未连接到 hub 的 pi 进程 (pid N)」；`card-unproven`「有尚未上报会话的 pi 进程 (pid N)」；`proc-partial`「进程扫描未完成」；`new-process`「检测期间有新的 pi/node 进程启动」。确认框底部复用上面的尽力检测小字。plaintext 时附加明文警告。
- `SpawnRow`：带 `from` 时隐藏重试按钮，显示提示和 from 徽标。

#### 4.7.3 测试锚点（`tests/web-hub/ui/`）

`session-history-logic.test.ts`（动作矩阵、`expired` 最多重来 1 次、io/budget/enum-incomplete 续扫、zombie 不续扫、跨 gen 按 key 去重、错误 key、每种 gap 都有文案 key、`incompleteNotice` 三种组合）、`session-history-dialog.test.ts`（各项 + `cursor-expired` 重新加载 + skipped/dirsSkipped/changed 横幅 + 枚举中提示 + unverified 确认 + **尽力检测小字始终渲染，且包含 W5「pid 被新进程复用」与 W7「替换又换回」短语**（en/zh 各一份 copy test））、`history-fork-confirm.test.ts`（六种文案 + 五种 gap 映射 + plaintext + 焦点）、`use-new-session.test.ts`、`logic-spawn.test.ts`、`transport-contract.test.ts`、`logic-client{,-password}.test.ts`、`spawn-row.test.ts`、`agent-list.test.ts`、`source-scan.test.ts`。i18n 的 en/zh 一致性由 `i18n-parity.test.ts` 自动覆盖。

**验收**：typecheck（含 vue-tsc）、`npm test`、`npm run build:web && npm run check:web` 全绿。

---

### 4.8 P-int — 装配、集成、restore、starvation、装配测试、文档

**文件**：`hub/hub.ts`；`tests/integration/fixtures/fake-rpc-pi.mjs`；`tests/integration/web-hub-headless.test.ts`；`tests/integration/web-hub-history-starvation.test.ts`（新）；`tests/conformance/history-restore.test.ts`（新）；`tests/web-hub/hub/hub-history-assembly.test.ts`（新）；`tests/web-hub/hub/{hub-spawn,caps-coexist}.test.ts`；`tests/web-hub/contract/types.test-d.ts`；`AGENTS.md`；`docs/dev/web-hub-spawn/acceptance.md`。

**步骤**

1. `hub.ts`：`extraHubCaps` 在 `config.spawn?.history === true` 时追加 cap。`createHistoryService({agentDir, forkSrcDir: webHubSpawnFiles(stateDir).forkSrcDir, registry, managed: () => (spawnSup?.records() ?? []).map(toManagedView), deathOf: (id) => spawnSup?.deathOf(id), uid: process.getuid?.() ?? -1, hubPid: process.pid, now, log}, { procFs: deps.spawnSeams?.historyProcFs })`，只在 history 打开时构造；`toManagedView` 逐字段拷贝（含 `procStartTicks`）。`HubDeps.spawnSeams` 追加 `historyProcFs?: Partial<ProcFs>` 与 `wrapHistory?: (svc: HistoryService) => HistoryService`（PD22）。supervisor deps 在 history 打开时注入 `sessionPathPin: { capture: captureSessionPathPin, verify: verifySessionPathPin }`。通过 `createSpawnRoutes({…, history})` 注入。
2. `fake-rpc-pi.mjs`：
   - `--session <abs>`：hello 的 cwd 用 header 的 cwd；session 帧的 `sessionFile` **原样回传 argv 里的字符串**（HC1 证明真 pi 如此）。
   - `--fork <src> --session-id <id>`：先确认 `src` 在 `forkSrcDir` 下，否则 stderr `FAKE-PI fork-src-outside-forkdir` 并退出 3；然后按 pi 的格式写出新文件（`parentSession = src`）。
   - `--delay-open <ms>`：读取会话文件之前先等待；**`--delay-session <ms>`**：打开文件之后、发 session 帧之前再等待（HH10b 用：给测试把文件换回去的时间）；打开后对文件 `appendFileSync` 一行 `{"type":"custom","customType":"fake-pi:touch"}`（让测试能看出 fake pi 写的是哪一个 inode）。
   - `--title-only`：只设置 `process.title = "pi"` 并保持存活，不连 socket（未连接 pi 的样本）。
3. 集成测试 HH（真实 hub 子进程 + fake pi，`describe.skipIf(!IS_LINUX)`；需要 resume 成功的用例一律用**进程内 hub** + `historyProcFs` 只暴露测试自己启动的 pid，排除开发机上的真实 pi）：

| 用例                                     | 断言                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HH1                                      | 列表、置灰 gone、kind 过滤、q 搜索；`stats.enum.complete === true`                                                                                                                                                                                                                                                                                                                                                                            |
| HH2                                      | resume 的 argv 尾部是 `["--session", abs]`；live；带 `from`；spawns.json 不含 `from`                                                                                                                                                                                                                                                                                                                                                          |
| HH3                                      | 先启动一个连上 hub、上报同一 sessionId 的 fake TUI ⇒ 409 `open/card` ⇒ 改 fork ⇒ argv 尾部 `["--fork", <forkSrcDir 下的快照>, "--session-id", uuid]`；源文件 sha 不变；live 之后快照已删除                                                                                                                                                                                                                                                    |
| HH4                                      | 并发两个 resume ⇒ 一个 202，一个 409 `open/managed`                                                                                                                                                                                                                                                                                                                                                                                           |
| HH5                                      | 删除源文件 ⇒ 400 session-missing，且没有发生 fork                                                                                                                                                                                                                                                                                                                                                                                             |
| HH6                                      | header cwd 是 symlink ⇒ 列表显示 moved；POST ⇒ 400 moved                                                                                                                                                                                                                                                                                                                                                                                      |
| HH7                                      | 开关关闭 ⇒ caps、404、schema 都与关闭前逐字节一致                                                                                                                                                                                                                                                                                                                                                                                             |
| **HH9（unconnected-pi）**                | 启动一个 `--title-only` 的 fake pi（未连接），把它的 pid 加入 `historyProcFs` 的可见集合 ⇒ resume ⇒ 409，`forkReason:"maybe"`、`proofGap:"unconnected-pi"`、`live.pid` 等于它的 pid；kill 掉它之后再 resume ⇒ 202                                                                                                                                                                                                                             |
| **HH9b（PID 复用）**                     | `historyProcFs` 是可编程的：`prove` 阶段暴露 pid P 为 bash（`other`）；在 auth2 期间（`wrapSupervisor`/seam 钩子）把 P 改成同 uid、comm `pi`、不同 starttime ⇒ `reprove` 返回 `new-process` ⇒ 409，`start` 未被调用                                                                                                                                                                                                                           |
| **HH10（换走且不换回）**                 | 用 `--delay-open 500` 做 resume，202 之后测试用 rename 换掉会话文件 ⇒ 记录进入 stopping/terminal，带 `hintDetail:"session-swapped"`，审计含 `code:"session-swapped"`；替身文件**没有**被 fake pi 追加 `fake-pi:touch` 之外的内容——准确地说：fake pi 的 touch 落在替身上，原文件 sha 不变；spawns.json 的 `sessionFile` 未被写成替身                                                                                                           |
| **HH10b（换走又换回）**                  | `--delay-open 300 --delay-session 700`：202 后换掉文件，等 fake pi 打开并 touch 了替身，在 session 帧发出前把原文件换回 ⇒ 记录 **live、无 hintDetail**；替身文件带 touch，原文件不带。**这是 W7 的「记录限制」断言**：测试名里写明 `documented limitation (W7): swap-and-restore is undetectable`                                                                                                                                             |
| **HH11（F13）**                          | fake pi 用 `--no-hello` 加一个很大的源文件 ⇒ `failed{register_timeout}`，没有残留进程，快照已清理                                                                                                                                                                                                                                                                                                                                             |
| **HH12（F20）**                          | 会话目录里的某个 `.jsonl` 在 gen 生成之后被换成 FIFO ⇒ 列表在预算内返回，该文件记为 invalid；hub 仍能响应 `/api/hub`                                                                                                                                                                                                                                                                                                                          |
| **HH13（可续枚举，真实 fs）**            | 临时 sessionsRoot 里生成 **5 616** 个最小会话文件（250 目录，其中一个 2 625 个，E7 分布），进程内 hub 的 history seam 把 `HISTORY_ENUM_BUDGET_MS` 钉成 1 ms（通过 `fs` seam 对每次 readdir/stat 注入 2 ms 延迟亦可）⇒ 首页 `stats.enum.complete === false`；沿 `next` 翻到底 ⇒ 所有页 key 并集 === 全部 5 616 个文件、无重复、末页 `complete === true` 且 `incomplete` 省略、每页 items 按 mtime 倒序（PD23）；总请求数 ≤ 250 + 88 + 113 + 10 |
| **HH14（目录被换成 symlink，真实 hub）** | HH13 的夹具，首页之后（gen 未完成）把一个尚未枚举的目录换成指向 `<tmp>/outside/`（内含一个合法 header、首条消息为 `SECRET-TITLE` 的 `.jsonl`）的 symlink 并把真目录改名 ⇒ 翻到底后任何页都不含 `SECRET-TITLE`、`stats.changed === 1`、`incomplete:true`；`q=SECRET` 返回 0 行                                                                                                                                                                 |

4. **starvation 测试**（`web-hub-history-starvation.test.ts`，子进程运行，`UV_THREADPOOL_SIZE=4`）：同 v2——history 的 `fs.open` seam 指向一个**不带** `O_NONBLOCK` 的阻塞 FIFO；连续发 20 次 page/resolve；断言 preview 风格读取、uploads 风格写入、`crypto.scrypt` 都在 2s 内完成；history 被阻塞的线程数 ≤ `HISTORY_FS_SLOTS`。再加「preview 也熔断时的行为只记录不保证」用例。
5. **真 pi + 真 hub restore 测试**（`tests/conformance/history-restore.test.ts`，CLI 缺失或非 Linux 时 skip）：进程内真实 hub（与 HR1 同构造；launcher = `[process.execPath, <devDep pi>/dist/cli.js]`；`historyProcFs` 只暴露这个 hub 的受管子进程 + 用例显式加入的 pid；`restoreStableMs` 短值），`spawn.enabled + history + restore`；hub 环境变量带 `NODE_OPTIONS=--import <tmp>/argv-log.mjs`，每个子进程把 `process.argv` 以 JSON 行写入 `$ARGV_LOG`。

| 用例                        | 断言                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RH1（restore 打开，resume） | 真实 main 会话（含 `pi_subagent_types` 标记）→ resume → live，记下 `spawns.json` 的 `sessionFile`（等于 abs）→ graceful `/webhub restart` → 同一个 spawnId 再次 live；ARGV_LOG 中新子进程的 argv 尾部**精确等于** `["--session", <该 sessionFile>]`，不含 `--model`；重启后记录**没有** `session-swapped`                                                                            |
| RH2（restore 打开，fork）   | fork → live → `sessionFile` 等于 pi 生成的新文件（不在 forkSrcDir 下），快照已删除 → restart ⇒ argv 尾部 `["--session", <新文件>]`                                                                                                                                                                                                                                                   |
| RH3（restore 关闭）         | resume → live → restart ⇒ 记录变为 `exited{hub}`，ARGV_LOG 中没有新的 fork；之后从 history 列表重新 resume 仍然能成功                                                                                                                                                                                                                                                                |
| **RH4（W6 记录限制）**      | RH1 的流程，但在 hub 停止之后、新 hub 启动之前，启动一个 `--title-only` 进程（或 `node -e 'process.title="pi";setInterval(()=>{},1e6)'`）并把它的 pid 加入新 hub 的 `historyProcFs` 可见集合 ⇒ 新 hub 仍然用 `--session <sessionFile>` 重 fork，记录 live，**没有** 409、没有 fork 快照。测试名写明 `documented product exception (§14.1 / W6): restore does not re-prove occupancy` |

6. **装配测试**（`tests/web-hub/hub/hub-history-assembly.test.ts`，PD22 / 评审 #7）：
   - `startHub(config{spawn:{…, history:true}}, { spawnSeams: { wrapHistory: capture } })`（不传 `historyProcFs`）⇒ 捕获到的 service `.diag().procFsSource === "default"` 且 `.fsSource === "default"`。
   - 同上但进程环境里设置 `PI_WEBHUB_HISTORY_PROCFS=/tmp/x`、`PI_WEBHUB_SPAWN_SEAMS=…` 等任意变量 ⇒ 仍为 `"default"`（hub 不读它们）。
   - `HubConfig.spawn` 里塞入 `historyProcFs`/`procFs`/`seams` 键 ⇒ `hub/spawn/config.ts` 拒绝整个 spawn 块（现有「未知键拒绝」规则）。
   - 传 `historyProcFs` ⇒ `"seam"`（证明 seam 本身可用，测试才有意义）。
   - 源码扫描：`src/web-hub/hub/main.ts` 不含 `historyProcFs`、`wrapHistory`、`spawnSeams`；`src/web-hub/hub/spawn/history/**` 不含 `process.env`。
7. caps 与类型测试：同 v1。另外写一个测试断言 http.ts 不需要修改。
8. 文档：AGENTS.md 的 web-hub 小节追加「Session history」一段：开关和 cap；**best-effort 占用检测与残余窗口 W1–W7（含 restore 产品例外）**；fd 锚定 + 三级路径复核；fork 快照与悬空的 parentSession；history 本地 IO 上限；`historyProcFs` 只能编程注入；HC/HH/RH 三组闸门。acceptance 文件新增「H：history」一节（§7.3）。

**验收**：`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web` 全绿，`npm run test:conformance` 全绿，真机清单全部勾选。

---

## 5. 关闭时逐字节一致（`webHub.spawn.history` 关闭，或 spawn 未启用）

| 面                                | 关闭时的表现                                                                                                                                                                                       | 机制                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| caps                              | 不含 `spawn.history.v1`                                                                                                                                                                            | hub.ts 的条件尾部               |
| `GET /api/headless/history`       | 与访问 `/api/headless/<未知路径>` 完全相同                                                                                                                                                         | `historyOn` 门                  |
| 带 `session` 的 POST              | 400 `bad spawn request body`，与带任意未知字段的请求相同                                                                                                                                           | 不带 opts 的 parse              |
| `intentDigest`                    | 不带 session 时不变                                                                                                                                                                                | golden 测试                     |
| `SpawnRecordPublic` / spawns.json | 不出现 `from`；spawns.json 从不含新增字段                                                                                                                                                          | `toStored` 逐字段拷贝           |
| restore 重 fork                   | **不做** `captureSessionPathPin`/`verifySessionPathPin`（`deps.sessionPathPin` 未注入）——原 restore 路径，**不携带任何 history 路径 pin 保证**（W-resume 窗口按 restore plan §6.5 的既有口径接受） | hub.ts 条件注入                 |
| IO / timer / 文件                 | 不构造 service；**不创建 `forkSrcDir`**（只在 fork 时惰性创建）；supervisor 的 init 清扫只在 history 打开时执行                                                                                    | hub.ts 与 supervisor 的条件判断 |

**测试**：在 `headless-matrix.test.ts` 新增 describe「history rows」：①未启用：`/api/headless/history` 的响应与 `/api/headless/dirs` 的现状逐字节一致；②启用但 history 缺省：GET 返回 404，与 `/zzz` 逐字节一致；带 session 的 POST 与带 `bogus` 字段的 POST 逐字节一致；③`history:true` 但没有注入 service：同②；④`lan:"off"`：LAN 返回 404；⑤缺 X-PWH ⇒ 403，未鉴权 ⇒ 401；⑥现有矩阵行原样通过。集成层由 HH7 覆盖；`supervisor.test.ts` 断言 `history` 关闭时 init 不访问 `forkSrcDir`、restore 不调用 capture。

---

## 6. 零 hang 预算、缓存、IO 池、restore、失败模式

### 6.1 预算表（`budget.ts`，逐字）

| 常量                                                                                          | 值                                         | 超限行为                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `HISTORY_REQ_TOTAL_MS`                                                                        | 3000                                       | 已有结果按 partial 返回，列表从不 504                                                                                      |
| `HISTORY_ENUM_BUDGET_MS`                                                                      | 1500                                       | `partial:{enum}`；gen 记住检查点，下次请求续枚举（PD9'）                                                                   |
| `HISTORY_ENUM_MIN_PROGRESS`                                                                   | 1 目录 或 64 文件                          | 每次 `advance` 的最少推进量（超预算也推进；zombie 熔断除外）                                                               |
| `HISTORY_DIR_LIMIT` / `HISTORY_FILE_LIMIT`                                                    | 4096 / 50 000                              | `dirsTruncated` / `filesTruncated`                                                                                         |
| `HISTORY_GEN_REUSE_MS` / `HISTORY_GEN_IDLE_MS` / `HISTORY_GEN_MAX_AGE_MS` / `HISTORY_GEN_MAX` | 10 000 / 60 000 / 300 000 / 4              | 过期 ⇒ `cursor-expired`；**未完成的 gen 在 REUSE 期后仍被首页复用**                                                        |
| `HISTORY_IO_RETRY_MAX`                                                                        | 3（**连续**；成功即清零）                  | 枚举期 readdir/lstat（`enumRetry`）与翻页期读取（`ioFailures`）共用；达到后记为 dirsSkipped/skipped（gen 内），新 gen 重试 |
| gen 常驻 fd                                                                                   | ≤ 2 / gen（rootFd + pending.fd），≤ 8 总计 | gen 失效时关闭                                                                                                             |
| `HISTORY_HEADER_LINE_MAX` / `HISTORY_HEAD_MAX_BYTES` / 块大小                                 | 4 KiB / 256 KiB / 32 KiB                   | —                                                                                                                          |
| `HISTORY_HEAD_FILE_MS`                                                                        | 400                                        | 记为 IO 失败（不消费）                                                                                                     |
| `HISTORY_INDEX_BUDGET_MS` / `HISTORY_INDEX_BYTES_MAX`                                         | 1500 / 64 MiB                              | `partial:{budget}`（每个请求至少推进 1 个文件）                                                                            |
| `HISTORY_FS_SLOTS`                                                                            | 2                                          | 准入条件 `inflight + zombies < 2`；不满足 ⇒ busy，记为 IO 失败                                                             |
| `HISTORY_CWD_STEP_MS` / `HISTORY_CWD_BUDGET_MS` / `HISTORY_CWD_CACHE_MS`                      | 200 / 500 / 30 000                         | `unknown`                                                                                                                  |
| `PROC_SCAN_PID_MAX` / `PROC_SCAN_BUDGET_MS` / `PROC_SCAN_CACHE_MS`（只用于列表）              | 8192 / 300 / 5 000                         | `proc-partial` ⇒ fork                                                                                                      |
| `PROC_SYNC_MS`                                                                                | 50                                         | `proc-partial` ⇒ 409（E6：310 pid ≈ 5–8 ms；≈3000 pid 内可完成）                                                           |
| `PIN_BUDGET_MS`                                                                               | 800                                        | 504                                                                                                                        |
| `HISTORY_SNAPSHOT_MAX_BYTES` / `HISTORY_SNAPSHOT_BUDGET_MS` / 块大小                          | 128 MiB / 4000 / 64 KiB                    | 400 too-large / 504                                                                                                        |
| `FORK_SRC_SWEEP_MAX`                                                                          | 256                                        | init 清扫的上限                                                                                                            |
| `HISTORY_INDEX_MAX` / `HISTORY_PAGE_BYTES_MAX`                                                | 50 000 / 192 KiB                           | —                                                                                                                          |
| 后台任务 / timer                                                                              | **没有**（只有 race 里使用的 unref timer） | —                                                                                                                          |

### 6.2 缓存失效

| 缓存                  | 失效条件                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| sessionsRoot realpath | 10s                                                                                                                              |
| gen                   | 见 §6.1；`dirs[]` 冻结，`files[]` 只追加；未完成的 gen 被首页请求复用直到完成或过期                                              |
| 头部索引              | `ino/dev` 变化 ∨ size 变小 ∨（incomplete ∧ size 变大）；IO 失败永不入缓存；仅在一次 `complete` 的 gen 之后，才删除不在其中的条目 |
| cwd 状态              | 30s；`unknown` 不缓存                                                                                                            |
| `/proc` 扫描          | 列表 5s；`prove` 每次都重新扫；`reprove` 全量重 stat（无缓存）                                                                   |

### 6.3 失败模式 ↔ 测试（含对抗用例）

| #       | 场景                                                                                     | 结果                                                                                                 | 测试                                                                       |
| ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| F1      | 会话被删除                                                                               | vanished；POST 返回 session-missing                                                                  | `generation.test.ts`、`pin.test.ts`、HH5                                   |
| F2      | 同名文件被替换                                                                           | 头部重读；id 不符 ⇒ mismatch                                                                         | `index.test.ts`、`pin.test.ts`                                             |
| F3      | resolve 之后、spawn 之前路径被换                                                         | `verifyForSpawn` ⇒ 409 session-changed；fork 走快照，不受影响                                        | `pin.test.ts`、`api-headless-history.test.ts`                              |
| **F4a** | spawn 之后、pi open 之前被换且**不换回**                                                 | goLive `verifySessionPathPin` ⇒ session-swapped，进程被停，替身坐标不持久化                          | `supervisor.test.ts`、`pin.test.ts`、**HH10**                              |
| **F4b** | 换走**又换回**（W7）                                                                     | **不可检测**：照常 live；记录限制                                                                    | **HH10b**（限制断言）                                                      |
| **F4c** | 目录被换、文件是原 inode 的硬链接                                                        | 目录级 dev/ino 不等 ⇒ session-swapped；pin 时 `nlink>1` ⇒ session-invalid                            | `pin.test.ts`（verifySessionPathPin 矩阵）                                 |
| F5      | header cwd 被删除                                                                        | 置灰；POST 返回 not-found                                                                            | `cwd.test.ts`、HC3                                                         |
| F6      | header cwd 变成 symlink                                                                  | moved                                                                                                | `cwd.test.ts`、`dirs.test.ts`、HH6、HC1b                                   |
| F7      | admit 之后 cwd 被换                                                                      | 现有的 spawn_error                                                                                   | supervisor 现有测试                                                        |
| F8      | 两个标签页同时恢复                                                                       | C2 ⇒ 409                                                                                             | `occupancy.test.ts`、HH4                                                   |
| **F9**  | 检测之后才有 pi 打开同一会话                                                             | `reprove` 看到在复核之前启动的进程 ⇒ fork（new-process / unconnected-pi）；复核之后才启动的属于 W1   | `proc.test.ts`、`api-headless-history.test.ts` 的 sync 失败分支、HH9、HH9b |
| **F9b** | 首扫看到的 pid 退出后被新 pi 复用                                                        | 全量重 stat：starttime 不同 ⇒ new-process ⇒ 409                                                      | `proc.test.ts` PID 复用矩阵、**HH9b**                                      |
| F10     | 未连接的 pi 打开了旧会话但还没写入                                                       | 任何未连接的 pi 候选都强制 fork                                                                      | `occupancy.test.ts`、HH9                                                   |
| F11     | fork 后上报的 sessionId ≠ newId                                                          | `session-unexpected`                                                                                 | `supervisor.test.ts`                                                       |
| F12     | pi 早退                                                                                  | `exited_early`；快照被清理                                                                           | supervisor 现有测试 + 清理断言                                             |
| **F13** | 大 transcript 或卡住的子进程                                                             | `register_timeout`；快照清理；快照超过上限 ⇒ 400                                                     | **HH11**、`snapshot.test.ts`                                               |
| F14     | sessions 根目录不可读                                                                    | 返回空列表 + `enum`，不建 gen                                                                        | `generation.test.ts`                                                       |
| F15     | NFS 挂死                                                                                 | IO 闸 + 熔断 ⇒ partial / `unknown` / fork                                                            | `budget.test.ts`、starvation 测试                                          |
| F16     | hub 重启                                                                                 | gen 丢失 ⇒ `cursor-expired` ⇒ UI 自动从头来                                                          | `generation.test.ts`、`session-history-logic.test.ts`                      |
| **F17** | 恢复出来的会话遇到 hub 重启                                                              | restore 接管（打开时），或 exited（关闭时）；**重启间隙的占用不重检（W6）**                          | **RH1–RH4**                                                                |
| F18     | pi 迁移并重写会话文件                                                                    | 索引重建                                                                                             | `index.test.ts`                                                            |
| F19     | 子会话被误判为 main                                                                      | 只有 kind 正面为 main 才允许原地恢复；main 标记不会出现在子会话里                                    | `head.test.ts`、`occupancy.test.ts`                                        |
| **F20** | 单个文件读取超时或被换成 FIFO                                                            | 超时 ⇒ IO 失败（不消费，第 3 次 skipped）；FIFO ⇒ O_NONBLOCK 下立即返回，记为 invalid                | `generation.test.ts`（真实 mkfifo）、**HH12**                              |
| F21     | `/proc` 扫描被截断                                                                       | `proc-partial` ⇒ fork                                                                                | `proc.test.ts`、`occupancy.test.ts`                                        |
| F22     | zombie 熔断                                                                              | 不推进，UI 不自动续扫                                                                                | `budget.test.ts`、logic 测试                                               |
| F23     | 游标非法或过期                                                                           | 400 / 409                                                                                            | `api-headless-history.test.ts`                                             |
| F24     | newId 撞车                                                                               | pi exit 1                                                                                            | HC4                                                                        |
| F25     | 写入中的会话（头部未完整）                                                               | 重读                                                                                                 | `index.test.ts`                                                            |
| F26     | 直接对正在写的源文件 fork                                                                | **设计上不会发生**：fake pi 收到 `forkSrcDir` 之外的 `--fork` 参数会退出 3                           | HC7（证明必要性）、HC6、HH3                                                |
| F27     | pin 持有的 fd 泄漏                                                                       | 每条退出路径都 release                                                                               | `api-headless-history.test.ts` 的参数化用例、`pin.test.ts`                 |
| F28     | 快照目录被篡改（symlink 或 mode）                                                        | 503 persist                                                                                          | `snapshot.test.ts`                                                         |
| **F29** | 枚举被预算截断（冷缓存 / NFS）                                                           | gen 记住检查点；后续请求续枚举；首页复用未完成 gen；最终 `complete`                                  | `generation.test.ts` 规模/属性测试、**HH13**                               |
| **F31** | 枚举期 readdir/lstat 失败（EACCES/EIO/超时）                                             | 可恢复：检查点不动，连续 3 次后 dirsSkipped/skipped；`incomplete:true` 直到新 gen；瞬时错误不丢文件  | `generation.test.ts` 属性 ⑥⑦                                               |
| **F32** | gen 创建后目录被换成 symlink / 重建                                                      | fd 锚定：pinned dirFd 仍读原目录；经 rootFd 重开得 ENOTDIR 或 dev/ino 不等 ⇒ `changed`，**绝不跟随** | `generation.test.ts` 目录替换、**HH14**、E8                                |
| **F33** | history 开启时 restore 的 sessionFile 不合规（R 外 / symlink / nlink>1 / realpath 不等） | `failRestorePreflight("session-invalid")`，不 `--session`                                            | `supervisor.test.ts`、`pin.test.ts` capture 矩阵                           |
| **F30** | 搜索命中落在 skipped 文件里                                                              | 本 gen 内 0 命中 + `stats.skipped` + `incomplete:true` + UI 横幅；新 gen 重试后命中                  | `generation.test.ts` skipped 语义、`session-history-dialog.test.ts`        |

### 6.4 restore 交互（PD21'）

| `webHub.spawn.restore` | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关闭                   | history 恢复或 fork 出来的会话就是普通受管记录：`goLive` 不采纳会话坐标；hub 重启或关闭 ⇒ 子进程收到 EOF ⇒ `exited{hub}`；没有自动恢复。用户可以从 history 列表重新打开，此时占用检测会重新跑一遍。`from`/`sessionPathPin`/`forkSnapshot` 都只在内存里                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 打开                   | `goLive` 调用 `adoptSessionCoords`，持久化 `sessionId` 和 `sessionFile`：resume 时 = pi 上报的 abs（字面路径，已被 `verifySessionPathPin` 证明等于我们传入的），fork 时 = pi 新建的文件，**永远不会是快照**。graceful 重启或崩溃后，restore 按它自己的规则 kill 旧进程，再 fork `--session <sessionFile>`。**产品例外（§14.1 / W6）：restore 的重 fork 不重跑占用检测**——重启间隙里有谁打开了同一文件，hub 不会知道，照常 `--session`；后果是会话树分叉，不丢数据。RH4 把它作为记录限制断言。history 开启时，重 fork 在 `restoreForkSync` 里 `captureSessionPathPin(abs, uid, R)`（PD24：与首次 resume 同规——须在 R 下、三级链、nlink、realpath），**捕获失败 ⇒ 拒绝该次 restore（有界失败）**；goLive 时 `verifySessionPathPin`（相同的事后复核）；history 关闭时不做，restore 行为逐字节同现状且不携带路径 pin 保证 |

测试：RH1–RH4（§4.8）。现有的 restore RS/HR 测试原样通过（`deps.sessionPathPin` 缺省）。

### 6.5 libuv 线程池的诚实声明（PD4）

- **保证**：history 自身在任何时刻最多占用 `HISTORY_FS_SLOTS = 2` 个线程池线程，包括已经被放弃但还没 settle 的 zombie 操作。理由：准入条件同时计入 inflight 和 zombie，且所有 open 都带 `O_NONBLOCK`。
- **不保证**：hub 范围内的总体上限。线程池的其他使用者：preview（自己的 tracker）、uploads、file-search、gzip、LAN 登录的 kdf（`crypto.scrypt`）、静态 UI、headless 的 stderr sink。history 和 preview 同时挂死时，最多可能占满 4 个线程。
- **测试**：starvation 测试（§4.8 第 4 步）。
- **后续可选**（不在 v1 范围内）：hub 启动器为 hub 子进程设置 `UV_THREADPOOL_SIZE=8`，或引入 hub 级共享信号量。

---

## 7. Conformance、集成、真机

- **7.1 Conformance**：HC1–HC7（§4.1）是 fork 路径的第一道闸门；RH1–RH4（§4.8）用真 pi + 真 hub 验证 restore（RH4 是限制断言）。pi peer 升级之前必须先跑 `npm run test:conformance`。
- **7.2 集成**：HH1–HH14、starvation 测试、装配测试（§4.8）。
- **7.3 真机清单**（写入 `docs/dev/web-hub-spawn/acceptance.md` 的「H：history」节）：
  1. 本机 5000+ 个会话：首屏耗时 ≤3s，记录 `stats.enum.complete` 是否首请求即为 true（E7 预期 warm 下为 true）、partial 收敛的轮数；搜索三个月前的会话能找到。
  2. TUI 正在打开 X 时在网页上「继续」X ⇒ fork 警告（open/card）；确认后得到新卡片，原会话字节不变（sha256）。
  3. 开一个 `webHub.enabled:false` 的 pi（未连接）⇒ **任意**会话的「继续」都只能 fork，提示「有未连接到 hub 的 pi 进程 (pid N)」；关掉它之后，main 会话可以原地恢复。
  4. 在点击「继续」的同时（≤1s 内）在另一个终端启动任意 `node` 进程 ⇒ 大概率得到「检测期间有新的 pi/node 进程启动」的 fork 警告（new-process；这是预期的保守行为，不是 bug）。
  5. 删除或 symlink 化 cwd ⇒ 置灰 gone / moved。
  6. 子会话默认隐藏、只能 fork；`head -2` 新子代理的 jsonl，第 2 行是标记。
  7. 没有 main 标记的旧会话 ⇒ unverified（kind）⇒ 只能 fork。
  8. LAN 下列表全量可见，resume 时有明文确认；`lan:"off"` ⇒ 入口消失、接口 404。
  9. 审计日志里没有 id、key、标题、搜索词。
  10. fork 之后 `ls ~/.pi/agent/web-hub/spawn/fork-src/` 为空；在 pi 的 `/resume` 里能看到 fork 出来的会话（不嵌套在原会话下，PD12）。
  11. restore 打开时，resume 后执行 `/webhub restart` ⇒ 同一张卡片恢复、无 `session-swapped`；restore 关闭时 ⇒ 记录变为 exited。**W6 手工复现**：restart 期间在 TUI 里 `/resume` 同一会话 ⇒ 重启后仍是原地 `--session`，两边同时写（预期行为，已披露）。
  12. 关闭开关后执行 `/reload` 和 `/webhub restart` ⇒ 入口消失、caps 中没有该 cap。
  13. 弹窗底部与 fork 确认框都能看到「尽力检测」说明。

---

## 8. 安全 / LAN / 审计

| 维度                                        | 测试                                                                                                                                                                                                                                                                 | 位置                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `lan:"off"` / `"known"` / `"roots"`（明文） | 404 / 全量 + confirm / sessionBacked                                                                                                                                                                                                                                 | headless-matrix、`lan-headless.test.ts`                 |
| CSRF、限速                                  | 403 / 429（独立的桶）                                                                                                                                                                                                                                                | `api-headless-history.test.ts`                          |
| 路径逃逸                                    | key 矩阵；dir 或 file 是 symlink；**resolve 之后换成 symlink** ⇒ verify 失败；R 的祖先被换 ⇒ realpath 复核失败；FIFO；owner；**nlink>1**；**目录换 + 硬链接**；**列表枚举经 fd 锚定，gen 后目录换 symlink 不跟随**（HH14）；**restore capture 须在 R 下 + realpath** | `pin.test.ts`、`generation.test.ts`、HH14               |
| 不能凭空建会话                              | ENOENT ⇒ 400，不发生 fork                                                                                                                                                                                                                                            | HH5、CR3                                                |
| 源文件完整性                                | fork 绝不对源文件执行；源文件 sha 不变                                                                                                                                                                                                                               | HC6、HC7、HH3、F26                                      |
| 占用判定（best-effort）                     | `proc.test.ts` PID 复用矩阵；`occupancy.test.ts` 全部 gap；HH9/HH9b；**装配测试**证明 procFs 不可被 env/config 改写；源码扫描 `main.ts`                                                                                                                              | §4.8 第 6 步                                            |
| argv 注入                                   | abs 或快照路径必定以 `/` 开头；newId 由 hub 生成；每个参数都是独立的数组元素                                                                                                                                                                                         | `supervisor.test.ts`                                    |
| 审计不泄露                                  | 所有 history 和 session 相关的日志行里，不出现 id、key、标题、q、游标、快照路径、sessionFile；`session` 字段的取值只有 `resume\|fork`；`proofGap`/`code` 只取枚举值；`session-swapped` 的 detail 只含固定英文短语                                                    | `api-headless-history.test.ts`、`audit.test.ts`         |
| 渲染                                        | 只用 textContent；没有 v-html                                                                                                                                                                                                                                        | `session-history-dialog.test.ts`、`source-scan.test.ts` |

**需要更新的既有测试**：`tests/web-hub/protocol/{spawn,paths}.test.ts`（P0）；`tests/config/web-hub-settings.test.ts`、`tests/web-hub/agent/wiring-spawn.test.ts`、`tests/web-hub/hub/spawn/config.test.ts`（P-cfg）；`tests/web-hub/hub/audit.test.ts`、`spawn-kit.ts`、`headless-matrix.test.ts`、`lan-headless.test.ts`、`tests/web-hub/hub/spawn/{supervisor,dirs,project}.test.ts`（P-route）；`restore-plan.test.ts`（P-scan，零改动加新用例）；`hub-spawn.test.ts`、`caps-coexist.test.ts`、`types.test-d.ts`、`web-hub-headless.test.ts`、`fake-rpc-pi.mjs`（P-int）；`tests/integration/consult.test.ts`（H0 追加断言）；`rpc-spawn.test.ts`（P-conf）；UI 的 10 个文件（P-ui）。

---

## 9. 完成定义

1. 本包的测试锚点都已存在并通过，包外零回归。
2. `npm run format:check && npm run typecheck && npm test` 全绿；涉及 UI 时加跑 `build:web && check:web`；涉及 session/fork argv 或 restore 时加跑 `test:conformance`。
3. 不修改其他包独占的文件；需要改冻结面时先回 P0。
4. 按 dev-flow 规则：验收模型与开发模型不同；只提交精确路径；commit 使用 Conventional Commits。

---

## 10. /tmp 实测（2026-10-08，pi 1.0.2 devDependency，Linux；脚本与原始结果见 `/tmp/pwh-hist-exp/`）

| #      | 实验                                                                              | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 结论                                                                                                                                |
| ------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| E1     | `fork-exp.mjs`：对尾部为半行的源文件直接 `pi --mode rpc --fork <源>`              | exit 0，**源文件被改写**：784 → 785 B，末尾多了 `\n`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PD12 快照必做；HC7 钉住                                                                                                             |
| E2     | `fork-exp.mjs`：从 hub 规则做出的快照 fork                                        | exit 0；header `id=newId` ✓、`cwd=realpath(workdir)` ✓、`version=3`、`parentSession=<快照路径>`；user 消息已复制 ✓；源文件和快照都不变 ✓                                                                                                                                                                                                                                                                                                                                                                                            | PD12 可行                                                                                                                           |
| E4     | `proc-exp.mjs`：同 uid 的 `/proc` 扫描（v3 复跑）                                 | 3.7 ms；3 个 pi 进程都是 `comm=pi`、`exe=node`、`cmdline=["pi",""]`；9 个 `node*` 中 1 个匹配宽松规则，是 hub 自己（jiti-cli）                                                                                                                                                                                                                                                                                                                                                                                                      | 候选规则收紧到 `argv[1]` 以 `/dist/cli.js` 结尾或 basename `pi`，排除 hub pid                                                       |
| E5     | `fd-exp.mjs`：fd 锚定（v3 复跑）                                                  | (a) 已固定 dir fd 在路径换成 symlink 后仍指向原目录 ✓；(b) 被换层级 `O_DIRECTORY\|O_NOFOLLOW` ⇒ `ENOTDIR`；(c) 末级 symlink + `O_NOFOLLOW` ⇒ `ELOOP`；(d) FIFO + `O_NONBLOCK` 0 ms，`isFile=false`                                                                                                                                                                                                                                                                                                                                  | PD11、PD20 可行                                                                                                                     |
| **E6** | `sync-rescan-exp.mjs`：**全量同步**重 stat（readdir + 每个 pid 的 stat/uid）      | 310 个 pid：全量 5–8 ms（5 次重复 4.4–5.2 ms）；同 uid 过滤后 2.2 ms（68 个同 uid）；两次连续扫描之间 starttime 差异 0、新 pid 0                                                                                                                                                                                                                                                                                                                                                                                                    | `reprove` 做全量重 stat 可行，50 ms 预算 ≈ 3000 pid；差分式 reprove 不必要（§0 C2）                                                 |
| **E8** | `fd-enum-exp.mjs`：**fd 锚定枚举**（Node 无 `openat`，用 `/proc/self/fd/<fd>/…`） | (a) `open(/proc/self/fd/<rootFd>/d1, O_DIRECTORY\|O_NOFOLLOW)` → `readdir(/proc/self/fd/<d1Fd>, withFileTypes)` → `lstat`/`open(O_NOFOLLOW\|O_NONBLOCK)` 经 d1Fd 都按原 inode 工作；(b) gen 后把 `d1` 换成 `/etc` 的 symlink：pinned d1Fd 的 readdir 仍只列 `a.jsonl`，经 rootFd 重开 `d1` ⇒ `ENOTDIR`，而按路径 `readdir(R/d1)` **会列出 `passwd`**（v3 漏洞复现）；(c) 目录内文件换成 symlink：lstat 显示 symlink，open ⇒ `ELOOP`；(d) 目录 rename+重建后重开 fstat ino 变化可检测；(f) 1000 次 lstat 经 fd 36 ms vs 按路径 35 ms | §4.5.3 的机制成立且零额外成本；每个 gen 常驻 ≤2 个目录 fd                                                                           |
| **E7** | `enum-exp.mjs`：真实 sessions 树（208 目录 / 5 615 文件）全量枚举                 | 根 readdir 0.2–0.7 ms；async 并发 2：107 ms（两次 105–107）；sync：32 ms；最大目录 2 625 个文件占 90 ms，p50 目录 0.1 ms                                                                                                                                                                                                                                                                                                                                                                                                            | warm 下 `enumPartial` 不会发生；冷缓存/NFS 下可能，所以检查点按「目录 + 目录内文件偏移」记（§4.5.3）；HH13 用 250/5616 复刻这个分布 |

未在 /tmp 验证、交由测试兜底的：真 pi + 真 hub 的 restore 链路（RH1–RH4）、starvation、`/proc/<pid>/stat` 同步读取不会因目标进程 mmap 锁阻塞（只用 `stat()` 文件和 `stat` 伪文件，**cmdline 只在异步扫描中读取**；supervisor 的 L5 已在同步段这样做）。

---

## 修订记录（评审 r_9BKDG4S5 打回 → v2）

| 评审意见                                                                              | 级别    | 处置（v2，v3 保留）                                                                                                     | 位置            |
| ------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| #1 占用检测必须 fail-closed；spawn 前复核；写明剩余窗口；正面信号；枚举 pi 进程的方法 | Blocker | kind 门 + 完整 `/proc` 扫描 + 候选对号 + sync 复核 + 残余窗口表（v3 按 §14.1 改为 best-effort 口径并简化，见下表）      | PD10'、§4.5.5   |
| #2 路径逃逸 TOCTOU：根目录 fd 固定 + fd 锚定解析；交给 pi 的路径要复核                | Blocker | `pin.ts` 三级 NOFOLLOW + fstat；header/快照只经 fd；sync 段 lstat 链 + realpath；live 后事后复核（v3 加严，见下表）；E5 | PD11、§4.5.6    |
| #3 `--fork` 会改写源文件                                                              | Major   | hub 经 fd 做有界快照后 `--fork <快照>`；清理时机；parentSession 悬空；HC6/HC7；E1/E2                                    | PD12、§4.5.7    |
| #4 游标与 partial 语义                                                                | Major   | 扫描代 + 位置游标；IO 失败不消费，3 次后 skipped；gen 内去重；`cursor-expired`（v3 补上可续枚举，见下表）               | PD9'、§4.5.3    |
| #5 IO 预算                                                                            | Major   | history 本地上限 + 诚实声明 + starvation 测试 + O_NONBLOCK                                                              | PD4、PD20、§6.5 |
| #6 restore 交互                                                                       | Major   | 两种行为分别写明；真 pi + 真 hub 测试（v3 加 RH4 限制断言）                                                             | PD21'、§6.4     |
| #7 H0 driver 集成测试                                                                 | Minor   | M1–M5                                                                                                                   | §4.3            |
| #8 安全类失败模式的对抗测试                                                           | Minor   | F4 → HH10，F9 → reprove 单元 + HH9，F13 → HH11，F20 → mkfifo + HH12                                                     | §6.3            |
| #9 砍掉 tail 名字探测和附件尾注                                                       | Nit     | 标题 = 卡片名 → 头部 session_info → 首条消息                                                                            | PD19            |

## 修订记录（评审 r_EANRRJTT 打回 → v3）

| #   | 评审意见                                                                                                                                                                                                                   | 级别    | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 位置                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | **PID 复用绕过**：token 必须存每个候选 pid 的 starttime，`reprove` 对每个仍在的 token pid 重读 `/proc/<pid>/stat`（starttime 变化 / 消失重现 / comm、state 异常 ⇒ 不 free）；U-H2 按 §14.1 改为 best-effort 口径并披露残余 | Blocker | `ProcScanToken` 改为**全部** pid 的 `Map<pid, {startTicks, uid, comm, cls}>`（不只候选——被复用的可能是任何 pid）；`reprove` 改为**全量同步重 stat**，对每个 pid 比对 starttime/uid/comm：变化且现在是同 uid `pi`/`node*` ⇒ `new-process`；新 pid 同规则；候选变 `Z/X` ⇒ 忽略；50 ms / 8192 上限 ⇒ `proc-partial`。E6 实测 5–8 ms。PD10' 全文改为「没有检测到占用且检测完整」；砍掉只覆盖微秒级窗口的账本与 gap（§0 C3/C4）；残余 W1–W7 写进 §4.5.5、AGENTS.md、UI 常驻说明           | §0 C1–C4、PD10'、§3.5、§4.5.5、`proc.test.ts` PID 复用矩阵、HH9b、§4.7.2 |
| 2   | **enumPartial 的 gen**：部分枚举必须可经游标续接，并用 5600+ 文件 + 截断枚举证明连续游标最终覆盖全部文件                                                                                                                   | Blocker | 选「服务端在同一 gen 内续枚举」：gen 冻结目录清单、保存检查点（目录序号 + 目录内文件偏移），`files[]` 只追加，每次 `page()` 先 `advance` 再出页，最少推进 1 目录 / 64 文件；首页请求复用未完成的 gen；`HistoryPage.stats.enum{complete,dirsDone,dirsTotal}` + `incomplete`；排序不变量降级为「批内有序」并在 UI 说明。规模测试：250 目录 / 5 616 文件（E7 分布）、枚举预算钉成 1 readdir 或 64 stat ⇒ 并集 = 全集、无重复、`complete` 收敛（`generation.test.ts` + 真实 fs 的 HH13） | PD9'、§3.1、§4.5.3、§6.1、HH13、F29                                      |
| 3   | **`session-swapped`**：上报的 sessionFile 必须存在且逐字节等于传给 pi 的字面路径；lstat 链 + dev/ino；硬链接不得通过；restore 读持久化坐标时同样约束                                                                       | —       | `SessionPathPin{abs, root, dir, file}` 三级 dev/ino；pin 时与复核时都要求 `nlink===1`；`verifySessionPathPin`：`reported === pin.abs` 逐字节（HC1 钉住 pi 原样上报）→ 三级 lstat 非 symlink + dev/ino → `realpathSync(abs)===abs`；失败 ⇒ `session-swapped` + stopping，且**不**采纳替身坐标。restore：history 开启时 `restoreForkSync` 对 `--session <file>` 做 `captureSessionPathPin`，goLive 同样复核；`deps.sessionPathPin` 缺省 ⇒ 现状不变                                     | §0 C7、§3.5、§4.5.6、§4.6.3、`pin.test.ts` 矩阵、F4a/F4c、§6.4           |
| 4   | **restore 重 fork**：按 §14.1 是产品例外（不重跑证明），要明说，并把「重启间隙外部进程打开文件」的 RH 测试写成记录限制断言                                                                                                 | —       | PD21' / §6.4 / W6 明文写为产品例外；RH4：重启间隙加入一个 `comm=pi` 的未连接进程 ⇒ 新 hub 仍 `--session` 重 fork、live、无 409，测试名标注 `documented product exception`                                                                                                                                                                                                                                                                                                            | PD21'、§4.5.5 W6、§4.8 RH4、§6.4、真机 11                                |
| 5   | **W-resume 残余窗口**：「换走且不换回」（必须停）与「换走又换回」（记录为不可检测）分别验收和测试                                                                                                                          | —       | HH10（换走不换回 ⇒ `session-swapped`、停、替身坐标不持久化）与 HH10b（`--delay-open/--delay-session`，换走又换回 ⇒ live、无 hint，测试名标注 `documented limitation (W7)`）；F4a/F4b 分列；fake pi 打开后 `touch` 一行，让测试能证明 fake pi 写的是哪一个 inode                                                                                                                                                                                                                      | §4.5.5 W7、§4.5.6、§4.8 fake pi 开关 + HH10/HH10b、F4a/F4b               |
| 6   | **skipped 语义**：搜索要显示 incomplete/skipped 状态；定义新 gen 上的重试；测试「命中落在 skipped 文件里」                                                                                                                 | —       | `stats.skipped` 为 gen 累计；`HistoryPage.incomplete:true`（`!complete ∨ skipped>0`）；UI 常驻横幅 + 「刷新重试」；IO 失败永不入索引 ⇒ 新 gen 必然重试；同一 gen 内已消费不重试。测试：fake fs 让含 `needle` 的文件 open 失败 3 次 ⇒ 0 行 + skipped=1 + incomplete；同 gen 再翻仍 0；新 gen 命中                                                                                                                                                                                     | §0 C6、§3.1、§4.5.3、`generation.test.ts`、§4.7.2、F30                   |
| 7   | **`historyProcFs` seam**：保留，并用装配测试证明生产用真实 procFs 且 env/config 改不了                                                                                                                                     | —       | PD22：seam 只在 `HubDeps.spawnSeams` 上；新增 `wrapHistory` 观察 seam 与 service `diag().procFsSource`；装配测试：无 seam ⇒ `default`；设任意 env ⇒ 仍 `default`；config 塞键 ⇒ 整块被拒；有 seam ⇒ `seam`；源码扫描 `main.ts` 不含 seam 名、`history/**` 不含 `process.env`                                                                                                                                                                                                         | PD22、§3.5 `diag()`、§4.8 第 6 步、§8                                    |

## 修订记录（评审 r_EANRRJTT 复审 → v3.1）

| #   | 评审意见                                                                                                                                                        | 级别    | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 位置                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | 枚举期 readdir/stat 错误被静默计入未定义的计数并推进游标，`complete:true`/无 `incomplete` 下文件静默丢失；属性测试只约束 stat 成功的文件                        | Blocker | readdir/lstat 失败进入**可恢复错误状态**：`enumRetry[dir\|key]`（连续计数）、检查点不动、`partial:{io}`；连续 3 次才消费为 `dirsSkipped`/`filesSkipped`（后者并入 `stats.skipped`）。`HistoryPage.incomplete = !complete ∨ skipped>0 ∨ dirsSkipped>0 ∨ changed>0 ∨ truncated`；`complete` 只表示游标走完。属性 ⑥⑦：注入瞬时/永久 readdir/lstat 错误，`incomplete` 省略 ⇔ 无遗漏；瞬时错误永不 skipped；错误计数也算「最少推进」，收敛上界含 3·错误点数                                                                                                                                                                           | §3.1、§4.5.3（Gen、advance、规则、属性）、§4.5.8、F31                         |
| 2   | gen 冻结的是目录**名字**，续枚举按路径读 `R/dir`，目录被换成 symlink 后扫描会跟出 sessionsRoot 把元数据给 LAN 用户；POST 的 pinSession 不保护 GET               | Severe  | 枚举改为 **fd/inode 锚定**：gen 持有 `rootFd`（`O_DIRECTORY\|O_NOFOLLOW`，fstat uid）；每个目录经 `/proc/self/fd/<rootFd>/<dir>` 以 `O_DIRECTORY\|O_NOFOLLOW` 打开并记 `DirRef{dev,ino}`；`readdir("/proc/self/fd/<dirFd>")`、`lstat`/`open(O_NOFOLLOW\|O_NONBLOCK)` 都经 dirFd；翻页时每次访问先重开目录并比对 dev/ino，不等 ⇒ `changed`，**绝不按路径跟随**。机制经 E8 实测（Node 无 openat，`/proc/self/fd` 魔法链接可做 readdir/lstat/open；换 symlink 后 pinned fd 仍读原目录、重开得 ENOTDIR、按路径会跟随）。测试：fake fs 断言所有路径以 `/proc/self/fd/` 开头；真实 fs 目录替换；HH14 真实 hub 的 `SECRET-TITLE` 不泄露 | §4.5.3（机制段、创建、advance、页内遍历表）、§4.5.8、§4.8 HH14、§10 E8、F32   |
| 3   | restore 的 `captureSessionPathPin` 只做三级 lstat/regular/uid/nlink，无 `realpathSync(abs)===abs`，不要求仍在 sessionsRoot 下；捕获失败「照常 fork」            | Severe  | PD24：capture 签名加 `sessionsRoot`，要求 `abs` 形如 `R/<dir>/<file>`（`isValidSessionKey`）、三级链、dir 是目录、regular、`nlink===1`、uid、`realpathSync(abs)===abs`——与首次 resume 同规；**失败 ⇒ `failRestorePreflight(rec,"session-invalid",detail)`**（有界失败，走 restore 既有失败路径），不再 `--session`；删除 `session-pin-unavailable` 审计码。history 关闭 ⇒ 原 restore 路径，§5 明示**不携带 history 路径 pin 保证**。代价（自定义 sessionDir 会话不可 restore）写在 PD24/§4.5.6/§6.4                                                                                                                              | PD24、§3.5、§4.5.6、§4.6.3、§4.6.6、§5、§6.4、F33、`pin.test.ts` capture 矩阵 |
| 4   | 未完成 gen 的 `files[]` 是目录顺序，前几页不是最新优先。**dispatcher 裁定**：每页按 mtime 倒序排本页 items + 「排序近似」提示，不加候选排序层；记为 v3 行为偏离 | Normal  | PD23：`page()` 只排**本页 items**（不动 `files[]`/`pos`）；一次 `advance` 内 `complete`（E7 常态）⇒ 首次出页前把 `files[]` 整体排一次；`!complete` 期间 UI 显示近似提示；UI 不再排序。写入 §1 决策表为对 arch §4.1.1 的有意偏离，属性 ③ 与 HH13 断言每页有序                                                                                                                                                                                                                                                                                                                                                                     | PD23、§3.1 注释、§4.5.3（PD23 段、规则）、§4.7.1、HH13                        |
| 5   | `ioFailures` 要定义为**连续**：成功 ⇒ `delete(key)`；测试 fail,success,fail,fail ⇒ 不 skipped                                                                   | Normal  | `ioFailures` 与 `enumRetry` 都定义为连续计数，任一成功 `delete(key)`；§6.1 常量行注明；`generation.test.ts` 加 fail,success,fail,fail ⇒ 计数 2、不 skipped（翻页期与枚举期各一例）                                                                                                                                                                                                                                                                                                                                                                                                                                               | §4.5.3 Gen 注释 + 规则、§6.1、§4.5.8                                          |
| 6   | UI 常驻说明没有覆盖 W5（卡片 EOF / pid 复用竞态）与 W7（换走又换回）                                                                                            | Normal  | 常驻小字逐条对应 W1–W7，新增「刚退出的 pi 其 pid 被新进程复用的瞬间（W5）」「启动期间会话文件被替换又换回无法察觉（W7）」；i18n key `history.bestEffortNote`；dialog 与 fork-confirm 的 copy test 断言包含两条短语（en/zh）                                                                                                                                                                                                                                                                                                                                                                                                      | §4.7.2、§4.7.3                                                                |
| 7   | seam 设计接受                                                                                                                                                   | —       | 保留 PD22 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                             |

> v3.1a（调度方修正）：PD24 的 sessionsRoot 归属要求限定为 history 来源记录，见 PD24 行；其余检查对所有 restore 记录相同。

## v3.2 增补（调度方修订，评审 r_R741YPKY → v3.2，2026-10-09）

本节对 v3.1 正文**有优先权**：与正文冲突处以本节为准，实施时同步改正文对应段落。

### V1 — generation 并发与 fd 生命周期（评审 #1，阻塞）

- **每个 gen 一把异步互斥**（`gen.lock`：promise 链，FIFO）：`advance()` 与 `page()` 对同一 gen 的**全部**状态读写（`rootFd`、`pending`、`files[]`、`cursorDir`、`enumRetry`、`ioFailures`）都在锁内完成；锁内每一步仍受请求 `ReqDeadline` 约束，排队等锁也算请求时间（等锁超时 ⇒ 本页 `partial:{busy}`，checkpoint 不动，不消费任何条目）。不同 gen 互不阻塞。
- **租约（lease）**：请求进入某 gen 时 `gen.active++`，`finally` 中 `active--`。gen 过期/LRU 淘汰只把 gen 标记 `retired`（不再接新请求，新请求另建 gen）；**只有 `retired && active === 0` 时**才关闭 `rootFd` 与 `pending.fd`。关闭由最后一个离开的请求或淘汰扫描执行，二者 CAS 于 `gen.closed` 标志，保证恰好关闭一次。
- **临时 fd 一律 `try/finally close`**：page 内为读标题而开的文件 fd、advance 内重开目录的 dirFd，包括错误、超时、`busy` 路径。迟到的 fd（操作在截止后才返回）由 IO gate 的 late 回调关闭——与预览的 zombie-IO 处理同一纪律。
- **fd 预算**：常驻 ≤ 2 个/gen（`rootFd` + `pending.fd`）× gen 上限 `HISTORY_GEN_MAX = 4` ⇒ 常驻 ≤ 8；临时 fd ≤ `HISTORY_FS_SLOTS`（已有的并发槽，每槽同时至多 1 个临时 fd）。总上界 = 8 + `HISTORY_FS_SLOTS`，写进 `diag().fds`（常驻/临时计数）。
- **EMFILE/ENFILE**：按可重试 IO 错误处理（进入 `enumRetry`/`ioFailures` 的连续计数，同 v3.1 #1 语义），不丢、不标完成。
- **测试**：同一 gen 并发 8 个 page（fake-fs 注入随机延迟）⇒ `files[]` 无重复、无遗漏、`cursorDir` 单调；淘汰发生在活动请求中途 ⇒ 请求正常完成，结束后 fd 回到基线；注入 EMFILE ⇒ `incomplete`，恢复后续扫补齐；`diag().fds` 在全部请求结束后 == 0 临时。

### V2 — `dispose()` 进入冻结接口并装配（评审 #2）

- `HistoryService` 冻结接口新增 `dispose(): Promise<void>`：置 `disposed`（之后的 `page/resolve/prove/snapshot` 立即返回 503 `busy`，`reprove/verify*` 返回失败结论），把所有 gen 标 `retired`，有界等待活动租约（≤ 2 s，unref 定时器），超时后强制关闭剩余 fd（活动请求随后在锁内读到 `closed` ⇒ `partial:{busy}`），并关闭 IO gate 的 late fd。幂等。
- **装配**：`hub.ts` 在构造 history service 处把 `dispose` 推入 hub 既有的 shutdown/cleanup 栈（与 spawn supervisor 的 stop 同一阶段，早于 HTTP server close 完成）。`webHub.spawn.history` 运行时关闭（重建 service）同样先 `dispose` 旧实例。
- **测试**：集成测试——跑若干 page 后 `dispose()`，`/proc/self/fd` 计数回到基线；dispose 期间有在途请求 ⇒ 请求以 `busy` 有界结束；dispose 两次无异常。

### V3 — history 来源标记必须持久化（评审 #3）

- 评审建议「只放内存」不可行：restore 发生在 **hub 重启之后**，由新 hub 读持久化记录，内存字段已丢失。因此在 `StoredRecord`（`src/web-hub/hub/spawn/store.ts`）增加可选持久化字段 `historyOrigin?: "resume" | "fork"`，只由 history POST 的 resume/fork 分支写入（intent 落盘同一次 `saveNow`），之后不再改写。
- 兼容：沿用 restore plan D11 的规则——旧 hub 不认识该字段，写回时丢弃，不升版本。字段缺失 ⇒ 视为普通托管会话。
- `restoreForkSync()`：`rec.historyOrigin !== undefined` ⇒ 走 PD24 全量检查（含 sessionsRoot 归属）；否则走普通托管会话分支（三级 lstat 链 / regular / `nlink===1` / uid / `realpathSync(abs)===abs`，**不**要求在 R 下）。正文所有 `rec.history` 一律改读 `rec.historyOrigin`。
- **测试**：两类 restore 各一条——history 来源 + 会话文件在 R 外 ⇒ 拒绝（`session-invalid`）；普通托管会话 + 自定义 sessionDir ⇒ 正常 restore；以及旧记录（无该字段）按普通分支处理。

## v3.3 增补（调度方修订，评审 r_K0Y96DY8 → v3.3，2026-10-09）

优先级高于 v3.2 增补与正文；冲突处以本节为准。

### W1 — 全局 fd 账本取代「按槽位计数」（评审 #1）

- `FdLedger`（history service 私有，闭包内）：按**实际 fd 个数**预留/释放，`reserve(n, kind)` 同步返回 `boolean`（不排队、不阻塞），`release(n, kind)` 只能在持有方 `finally` 中调用；种类 `gen | pin | temp`。上限 `HISTORY_FD_MAX = 32`。
- 预留规则：gen 常驻（`rootFd` + `pending.fd`）每次打开前 `reserve(1,"gen")`；`SessionPin` 一次 `reserve(3,"pin")`，另设 `HISTORY_PIN_MAX = 4`（并发持有的 pin 数）；page 读标题 `reserve(2,"temp")`（dirFd + fileFd 同时持有的最坏情况）；snapshot 输出 `reserve(1,"temp")`。
- 预留失败 ⇒ 列表页 `partial:{busy}`（checkpoint 不动）、POST 返回 503 `busy`；**绝不**在没预留的情况下打开 fd。EMFILE/ENFILE 仍按可重试 IO 错误（账本只是上界的主保证，EMFILE 是兜底）。
- `diag().fds = { gen, pin, temp, max }`；测试：并发 resolve × 8 ⇒ 第 5 个起 `busy`；所有请求结束后 `pin == temp == 0`；随机延迟 + 并发 page/resolve/snapshot 的属性测试中账本计数从不超过 32、最终回到 gen 常驻数。

### W2 — 可取消的锁节点（评审 #2）

- gen 锁是显式队列而不是裸 promise 链：节点状态 `queued → running → done` 或 `queued → cancelled`。等锁截止（请求 deadline）⇒ 节点置 `cancelled` 并从逻辑队列移除；轮到 `cancelled` 节点时直接跳过，**不读也不写 gen**。
- holder 一律 `try { … } finally { release() }`；锁内异常只影响本请求，队列继续；锁本身从不 reject。等锁定时器 `unref()`。
- **提交前复检**：holder 每次 `await` 返回后先查 `service.disposed || gen.closed || deadline 已过`，任一成立 ⇒ 放弃本次的所有状态修改（不推进 cursor、不追加 files），以 `partial:{busy}` 结束。
- 测试：前一请求等锁超时、后一请求正常推进且被取消者从未修改 gen；锁内抛异常后后续请求可用；租约与账本在异常路径上都归零。

### W3 — dispose 的两条关闭路径（评审 #3）

- **运行时关闭**：`hub.ts` 的 runtime `close()` 里显式 `await bounded(history.dispose(), 2500)`，位置在 spawn supervisor stop 之后、`fe.close()`（HTTP front end）之前。**启动失败回滚**：`cleanup` 数组同样登记 `() => history.dispose()`。dispose 幂等，两条路径都调用也安全。
- dispose 覆盖账本里**所有**种类：gen、`SessionPin`、temp，以及 IO gate 的 late fd。超时强关后，在途 holder 由 W2 的「提交前复检」拒绝提交（`service.disposed` 已置位），所以不依赖它「恰好在锁内」。所有在途请求在 dispose 上限内以 `busy` 结束。
- 测试：在途 resolve（持 pin）+ page（持锁）时 dispose ⇒ 2.5 s 内全部结束，`/proc/self/fd` 回到基线，账本归零。

### W4 — history 来源改用旁路文件，失败即关闭（评审 #4、#5；取代 v3.2 V3 的 `StoredRecord.historyOrigin`）

- **不改 `StoredRecord`**（也就不需要改 `toStored`/`revive`/shape validator）。新增旁路文件 `<stateDir>/spawn/history-provenance.json`（0600，原子写：tmp + rename），内容 `{ v: 1, ids: { [spawnId]: "resume" | "fork" } }`。旧 hub 不认识也不会改写这个文件，因此来源标记不会因跨版本写回而丢失。
- **写入时序（冻结）**：history POST 在准入通过、**写 intent（L1 `saveNow`）之前**同步写入 provenance；provenance 写入失败 ⇒ 503 `busy`，不 fork、不写 intent。记录被删除（delete-session）或被 GC 时同步移除对应条目；孤儿条目（没有对应记录）在 hub 启动时清掉。
- **restore 读取**：`origin = provenance.ids[spawnId]`。provenance 文件存在但**读取/解析失败** ⇒ 对所有 restore 记录 fail-closed：拒绝 restore（`session-invalid`，detail `provenance-unreadable`），不降级为普通分支。文件不存在 ⇒ 视为没有任何 history 来源记录（只有从没启用过 history 的环境才会这样）。
- **restore 内的时序（冻结）**：`restoreForkSync()` 先做 capture（PD24 或普通分支的检查）→ 成功才 `attempts+1` 并写 restore intent（`saveNow`）→ fork。capture 失败 ⇒ `failRestorePreflight`，不写 intent、不 fork。
- 测试：新 hub 写 provenance → 用旧版 store 逻辑写回 `spawns.json` → 新 hub restore 仍走 PD24；provenance 文件损坏 ⇒ 所有 restore 被拒并记录原因；provenance 写入失败 ⇒ POST 503 且 `spawns.json` 无新记录；删除会话后 provenance 条目消失。

## v3.4 增补（调度方裁定，评审 r_JNDG2M4E → v3.4，2026-10-09）

优先级高于 v3.3/v3.2 增补与正文；冲突处以本节为准。

### X1 — 取消「history 来源」区分；所有 restore 统一检查（取代 v3.1a、v3.2 V3、v3.3 W4 的 provenance 部分）

- **裁定**：restore 不再区分 history 来源与普通托管会话，**不需要任何来源标记**（不加 `StoredRecord` 字段，不建 `history-provenance.json`）。history 开启时，**所有** `--session <file>` 形式的 restore 都做同一套 capture：三级 lstat 链（无 symlink、目录是目录）、regular、`nlink===1`、uid 匹配、`realpathSync(abs)===abs`；**不要求**文件位于 sessionsRoot 下。capture 失败 ⇒ `failRestorePreflight(rec, "session-invalid", detail)`，不 `--session`。history 关闭 ⇒ restore 行为逐字节同现状。
- **理由**：restore 重启的会话文件路径，对每一条托管记录都来自 pi 自己上报并经 goLive 采纳的 `sessionFile`——history 来源的记录在 goLive 之后与普通记录没有任何区别（pi 内 `/resume` 也会改变它）。sessionsRoot 归属检查唯一防御的是「`spawns.json` 被篡改指向任意文件」，而能写 `spawns.json` 的只有同一 uid，按 U1（唯一局域网用户、同 uid 不在威胁模型内）本就超出防御范围。为了这条检查引入来源标记，会制造「标记丢失 ⇒ 降级」这一类新问题（评审 #6），得不偿失。
- PD24 行、§4.5.6、§6.4、F33 中「须在 R 下」的表述一律以本节为准删除；`captureSessionPathPin` 签名去掉 `sessionsRoot` 参数。

### X2 — restore 时序（保留 v3.3 W4 的时序部分，限定范围）

- 新增的 session capture 放在 `restoreForkSync()` **写 restore intent（`attempts+1` + `saveNow`）之前**：capture 失败 ⇒ 不增加 attempts、不写 intent、不 fork。
- **现有的 cwd pin / launcher 检查顺序不动**（仍在 intent 之后，沿用 restore plan 的 L6 语义与既有测试），本方案不重排现有步骤。

### X3 — 评审 r_JNDG2M4E 的实施条件（全部接受，作为开发验收项）

1. W1：每次 `reserve` 先于对应 `open`；open 失败 / 超时 / late callback / dispose 强关都恰好 `release` 一次，账本不会出现负数或重复释放。
2. W1/W3：被强关的 fd 有 owner + CAS 状态，活动 holder 的 `finally` 不会二次关闭（避免 fd 编号复用后误关无关 fd）。
3. W2：取消的锁节点从逻辑队列跳过；holder 每次 await 返回后复检 `disposed/closed/deadline`；**所有**中间写入（`pending/files/enumRetry/ioFailures`）先写到局部变量，复检通过后一次性提交，复检失败整体丢弃。
4. W3：`HistoryService.dispose` 改为返回 Promise；runtime `close()` 中位于 spawn shutdown 之后、`fe.close()` 之前 `await` 它（当前 `hub.ts:1200` 的同步调用与顺序要改）；startup cleanup 等待同一个幂等 Promise。dispose 超时后所有在途请求在有界时间内以 `busy` 返回，不留永不 settle 的 Promise。
5. X2：capture 失败不得增加 attempts、写 intent 或 fork；intent 写成功后的 cwd pin / fork 失败沿用现有可恢复语义。
