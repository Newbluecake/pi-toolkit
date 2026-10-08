# 会话仓库 git worktree 列表上 web 页：实施方案 v1.1（r1 评审修订）

> 状态：**已实施**（W1 482e54b、W2 04021a9、W3 40f2e37、W4 fd234eb、W5 文档；各包 verifier 通过；W6 HUD 迁移为后续项）。方案 v1.1。v1 经 `review:worktree-web`（r1：0 Blocker / 5 Major / 3 Minor）打回，本版按主会话裁定逐条修订，处置见 §12「r1 评审处置」；用户最终决策见文末「用户拍板」（以它为准）。
> 需求：在 web-hub 浏览器 UI 的会话详情页看到「该会话 cwd 所在仓库的 git worktree 列表」。
> **基线：`c6bc7b3`（master HEAD）**。行号只作参考，以符号名为准；本文只写方案，不改实现。
> **照抄先例**：todo 上网页（`docs/dev/todo-web/plan.md`，T1–T4 已合入 `183f825`/`09cbeec`）——
> agent 侧投影 → 可选 `StatusInfo.<slot>`（append-only，不 bump PROTO）→ 详情头可折叠只读面板。
>
> **在途线（开工前必须重新核对 `git status` / `git log`）**：
>
> - **web 删除会话**（`docs/dev/web-hub-delete-session/plan.md`，未开工/在写）：P0 `protocol/http-contract.ts`、
>   `protocol/spawn.ts`；P1 `hub/registry.ts`、`hub/http.ts`、`hub/ports.ts`、`hub/hub.ts`…；P2 `ui/src/logic/state.js`、
>   `ui/src/types.ts`、`useHub.ts`、`components/agents/*`、`DashboardView.vue`、**`i18n/{zh,en}/detail.ts`**、`styles/agents.css`。
> - **web 关闭托管会话**（`docs/dev/web-hub-close-session/explore.md`，探索阶段）：可能动 `DetailHeader.vue` 中部（停止按钮 `:76-124,165-181`）。
> - 工作区当前有 title 线未提交改动：`src/index.ts`、`src/config/{settings,setting-specs}.ts`、`src/title/*`——**本方案不碰这些文件**。
>
> 本方案冲突面见 §8；设计目标：零 hub 文件、零 `state.js`/`types.ts`/`contracts.ts`、零 `src/index.ts`、零 settings 文件、零 `src/hud/**` 改动。

## 0. 结论速览

| 决策点      | 结论                                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据源      | **不复用 HUD 的 `HudSession`**（只在 `ctx.mode==="tui"` 且 `hud.enabled` 时存在，RPC/托管会话没有）。新建 **pi-free 共享采集层 `src/git/`**，web-hub agent 侧**自己低频采集**；HUD v1 一行不改（迁移为后续 W6）                                                                                       |
| 执行层      | **不用 `pi.exec`**（abort 只发 SIGTERM、5s 后才 SIGKILL，且 stdout 无上限）。自建 `src/git/run.ts`：`child_process.spawn` + 独立进程组，超时/abort/输出超限一律**立即 SIGKILL 整组并立即 settle**；stdout/stderr 字节上限；固定 env/`-c` 加固                                                         |
| 硬 deadline | sampler 用**独立硬 deadline（8s）包住整个 scan**（`Promise.race`），到期立即返回 `error`、abort 底层命令；迟到结果按 sampleId/generation 丢弃；僵尸 scan（未 settle）存在时不起新 scan。观察到的返回时间上限 = 8s + 一个事件循环 tick（与 git 是否忽略 SIGTERM 无关）                                 |
| 采集时机    | 后台、单飞：session_start 后首采 + `turn_end`/`agent_settled`/fleet 指纹变化触发的**去抖 kick**（最小间隔 5s）+ **30s 兜底**（慢仓库/连续失败自适应退避至 5min）；hub 连接非 live 时不采                                                                                                              |
| 大仓库      | `status --porcelain=v2 --branch --untracked-files=normal`，**输出上限 64 KiB 流式截断**：头部（分支/↑↓）照常解析，截断 ⇒ `dirty=已数条数 + dirtyCapped`（UI `*N+`，绝不报 clean/伪精确）；超时 ⇒ 该 worktree 后续降级为 `-uno`（`untrackedSkipped`，UI `~`）；再超时 ⇒ `unprobed:"timeout"`（UI `?`） |
| current     | cwd 与 worktree 路径**统一 realpath**；`current ⇔ realpath(row.path) === realpath(git rev-parse --show-toplevel)`；任一侧 realpath 失败退回原字符串比较；无匹配 ⇒ 无 current 行（不按前缀猜）；`/proc/<pid\|self>/fd/` 形态的 cwd fail-closed（视为 not-repo）                                        |
| 新鲜度      | wire 带 `sampledAt`（agent 时钟）与 agent 侧计算的 `staleMin`（>90s 未成功采样才出现，整数分钟，无浏览器时钟偏差问题）；UI 摘要尾 `·stale 2m`、展开区 `last sample HH:MM`                                                                                                                             |
| 推送策略    | 指纹 = 内容（不含 `sampledAt`）+ `sampledAt` 的分钟桶 + `staleMin`；**变化才 `publishStatus()`**（内容不变时每分钟至多 1 帧）；`readStatus` 只读缓存，**永不在热路径跑 git**                                                                                                                          |
| 每行字段    | `label`（`~` 缩写）、`path`（绝对）、`branch`、`head`、`current`、`main`、`agentRunId`、`bare/locked/prunable`、`dirty`/`dirtyCapped`/`untrackedSkipped`、`ahead/behind`（有 upstream 时）、`unprobed`（未探测原因）                                                                                  |
| 排序与上限  | current → main → 普通（按 path）→ `pi-agent-*`（按 path）→ prunable；≤24 行；16 KiB 三段预算（截字段 → 削 `path` → 削行进 `omitted`），current 行永不被削                                                                                                                                             |
| 协议        | `StatusInfo.worktrees?`；顶层与行对象 **additionalProperties 开放**（Q4），已知字段带 `maxLength`/`maxItems`/`minimum` 硬安全上限（宽于投影口径，留演进余量）；hub 只在内存透传、不落盘；跨版本 fixture 测试                                                                                          |
| UI          | 详情头 `TodoPanel` 之下新增 **`WorktreePanel.vue`**：默认折叠一行 `⎇ master@053387d ↑1 · worktrees 3 · 1 dirty ·stale 2m ›`（英文紧凑 token），展开列每行；≤480px 两行布局；只读，不接 preview                                                                                                        |
| 隐私口径    | **新增资产类别：同仓库所有 worktree 的绝对路径**（v1 曾误写「不新增」，r1 纠正）。风险由用户接受（2026-10-06 ask_user Q1；LAN 单用户 + 密码认证，与 preview U1 同一裁定基础）                                                                                                                         |
| 设置        | **零新增设置**（门控 = `webHub.enabled`，默认关；Q3）                                                                                                                                                                                                                                                 |
| 拆包        | W1 共享采集（执行层 + 解析 + 扫描 + 路径缩写 + 真实 git 集成测试）→ W2 协议+投影 → W3 采样器+接线 ∥ W4 UI 面板 → W5 文档；W6 HUD 迁移（后续）。**硬 deadline 与输出上限测试是 W1/W3 的合入门槛**                                                                                                      |

## 1. 现状核对（HEAD `c6bc7b3`）

### 1.1 HUD 已采集的 git / worktree 数据（`src/hud/`）

- `src/hud/git.ts`（86 行，pi-free，`ExecFn` 注入）：
  - `readRepoState(exec, cwd)`（`:27-59`）：`git -C cwd status --porcelain=v2 --branch --untracked-files=normal`，3s 超时；解析 `branch.head`、`branch.oid`（7 位，`(initial)` ⇒ 缺）、`branch.ab`、非 `#` 行计数为 `dirty`（含 untracked）。**缺陷**：无 `branch.ab` 行（无 upstream）时 ahead/behind 记 0，与「同步」不可区分；未用 `--no-optional-locks`（周期 `git status` 会刷新并写 index，和用户的 git 操作抢 `index.lock`）；输出无上限。
  - `readWorktrees(exec, cwd)`（`:61-86`）：`git worktree list --porcelain`，只解析 `worktree`/`HEAD`/`branch refs/heads/`；**忽略 `detached`/`bare`/`locked`/`prunable` 行**；对前 10 个 worktree **并发**跑 `readRepoState`（无并发上限、无总 deadline）。
  - 类型：`GitState{branch, localOid?, ahead, behind, dirty}`、`WorktreeInfo{path, branch?, oid?, state?}`（`:12-25`）。
- `src/hud/index.ts`：
  - `HudSession.live = ctx.mode === "tui"`（`:332`），非 tui 直接 `return`，**不采集、不起定时器**；整个 `wireHud` 只在 `settings.hud.enabled` 时调用（`src/index.ts:866`，post-guard）。
  - 采集时机：session_start 首次 `refresh` + 5s `refreshTimer`（`:45`、`:360-364`，已 unref）+ 每个 `turn_end`（`:481-486`）；`refresh`（`:208-226`）单飞、await 后查 `s.active`、cwd 在 await 前快照。
  - `maybeAutoFetch`（`:196-206`）：`hud.autoFetchMinutes` 周期 `git fetch --quiet --prune`（30s 超时）。
- `src/hud/footer.ts`：`renderWorktreeLines`（`:37-64`）worktree <2 时不显示；`isCurrent` 用 `cwd === wt.path || cwd.startsWith(wt.path + sep)`（**嵌套 worktree 时 main 也会被误判为 current**；`ctx.cwd` 经符号链接时与 git 输出路径不等）；`MAX_VISIBLE_WORKTREES = 10`（`:22`）；路径缩写 `formatCwdForFooter`（`src/hud/format.ts:15-25`）。
- `tests/hud/` 无 `git.ts` 的直接单测。

**结论**：HUD 的采集在 RPC/headless 托管会话（`webHub.spawn` fork 的 `pi --mode rpc`）、以及 `hud.enabled=false` 时**根本不存在**；而 web-hub 在 `tui` 与 `rpc` 下都会 attach（`src/web-hub/agent/index.ts:697`）。数据源必须与 HUD 解耦。

### 1.2 两种做法比较

| 方案                                                                 | 优点                                                                | 缺点                                                                                                                            | 结论     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A. HUD 暴露 `HudSession.worktrees` 给 web-hub（跨模块读）            | TUI 下零额外 git 调用                                               | RPC 会话 / hud 关闭时无数据（核心场景失效）；要给 HUD 加「非 TUI 也采集」分支 = 破坏 S3 单一 live 门；web-hub 依赖 HUD 生命周期 | **否决** |
| B1. 把 HUD 采集抽成共享模块，HUD 与 web-hub 各自调用（HUD 同步迁移） | 单一解析器；HUD 也拿到锁/upstream/输出上限等修复                    | 本功能顺带改 HUD 行为（footer 渲染依赖 `GitState` 形状），扩大回归面                                                            | 后续 W6  |
| **B2. 新建共享 pi-free 采集层，v1 只有 web-hub 用；HUD 不动**        | RPC/TUI 一致可用；HUD 零回归；模块可独立单测；以后 HUD 迁移是纯替换 | TUI+HUD 同开时两路采集（HUD 5s、web 30s）——实测本仓库 `git status` ≈10ms，增量 <20%，可接受；解析/缩写逻辑暂时并存（W6 消除）   | **采纳** |
| C. 进程级共享缓存（`Symbol.for` 键，cwd→结果，TTL 4s）给两路去重     | 去重                                                                | 跨模块全局态、TTL 语义与 HUD 5s 节拍耦合，对 10ms 级成本过度设计                                                                | 不做     |

### 1.3 status 通道（与 todo 同一条，免费复用）

- agent：`readStatus(ctx, tap, fleet, queueMirror?, todo?)`（`src/web-hub/agent/status.ts:23-65`）；调用点仅 2 处：`publishStatus`（`agent/index.ts:377-383`）与 `onSnapshotReq`（`:537`）。`publishStatus` 由 `STATUS_EVENTS`（`:223`）、1Hz `onTick` 的 leaf/todo 指纹（`:393-428`）、`connectWith`（`:678`）、session_start 的 setImmediate（`:709-714`）触发。
- 指纹先例：`lastTodoFp`/`lastFleetFp`（`:249-252`），session_start 重置（`:704-705`）。
- hub：`registry.ts:418-421` `case "status"` 整存 `r.status`（**进程内 Map，不落盘**——`registry.ts` 无任何 write/append 调用）并 publish；`toCard` 带 `status`（`:193`）⇒ SSE `status` / `agents` / `agent_up` 自动携带。
- 校验：`StatusFrameSchema = Type.Object({t, ...StatusInfoSchema.properties})`（`protocol/messages.ts:671`）**顶层无 `additionalProperties:false`** ⇒ 旧 hub 放行新顶层字段；嵌套体 `TodoWireSchema`/`QueueItemSchema` 是 closed（`:549-588`）。`decodeWith` 校验失败 = **整帧丢弃**（`:1168-1176`）。帧上限 `MAX_FRAME_BYTES = 4 MiB`（`protocol/ndjson.ts:10`）。
- 浏览器：`logic/state.js` `case "status"` 整体替换 `a.status`（`:347-365`）；`components/detail/agentViews.ts` 的 `statusOf(agent)` 已把 `agent.status` 窄化为 `StatusInfo`（`@protocol/messages.js` 别名）。**新面板直接读 `statusOf(agent)?.worktrees`，不需要在 `state.js` 加镜像字段、不动 `types.ts`**（两者都在删除会话 P2 域内）。
- 子 agent worktree：`src/extensions/worktree.ts:107,271-272`——根目录 `join(tmpdir(), "pi-subagent-worktrees")/<safeRunId>`，分支 `pi-agent-<safeRunId>`。数量可能较多，是「行数上限 + 探测上限」的主要理由。
- `pi.exec`（`node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js:10-72`）：`spawn(shell:false)`；`timeout`/`signal` ⇒ `proc.kill("SIGTERM")`，**5s 后才 SIGKILL**（`:21-32`），promise 只在 `close` 时 resolve ⇒ abort 后最多再挂 5s+；stdout/stderr 全量拼接**无上限**；`ExecOptions` 无 `env`。**r1 结论：采集层不能用 `pi.exec`**（§4.1）。
- pi 的会话 cwd 取自 `process.cwd()`（`node_modules/@earendil-works/pi-coding-agent/dist/main.js:464`），即内核 `getcwd()` 的规范路径。托管 spawn 以 `cwd = /proc/self/fd/<fd>` 启动子进程（`src/web-hub/hub/spawn/dirs.ts:20-23`、`supervisor.ts:1100`）——`chdir` 后子进程的 `getcwd()` 返回该 inode 的真实路径，不会是 `/proc` 别名（§4.1 第 1 步的论证 + fail-closed 防御）。

### 1.4 路径暴露现状（隐私口径依据）

- `AgentCard.cwd`（`protocol/http-contract.ts:108`）与 `SessionInfo.cwd` 为绝对路径，下发给所有通过鉴权的浏览器（含 LAN password 明文）；`SessionInfo.vue:61-62` 直接展示完整 cwd 并带复制按钮。
- `docs/dev/web-hub/lan-plan.md:39`：通过鉴权的网页主体彼此完全信任（等价本机用户远程 shell）。
- preview（`docs/dev/web-hub-preview/plan.md` §4.3）只准入 `session.cwd` 子树；v1 面板不接 preview。
- **r1 纠正**：当前 cwd 已公开 ≠ 兄弟 worktree 路径已公开。本功能把「同仓库所有 worktree 的绝对路径」（含 `/tmp/pi-subagent-worktrees/<runId>`、仓库外任意位置）新广播给全部 status 订阅者——这是**新增资产类别**，口径见 §6。

## 2. 设计决策

### D1 数据源：共享 pi-free 采集层 + web-hub 自采（§1.2 方案 B2）

新目录 `src/git/`（无 pi import，与 `src/core/` 同纪律；允许 `node:child_process`/`node:fs`，同 `src/bash/` 先例）。web-hub agent 侧持有采样器（per-activate 闭包），运行器取 `deps.gitRunner ?? createGitRunner()`——**测试缝放在 `WebHubDeps`，生产不需改 `src/index.ts`**（规避 title 线在途改动）。

### D2 数据通道：`StatusInfo.worktrees`

与 todo D1 同理由：低频小数据 + 全量快照语义 = overwrite-only slot 的理想载荷；hub/SSE/reducer/迟到订阅者/snapshot 全链路零改动。备选「独立 worktrees 帧」「拉取端点」「hub 自己跑 git」均否决（hub 不该对会话 cwd 执行子进程；后两者理由同 todo §2.1 B/C）。

### D3 范围：主会话 cwd 所在仓库

web-hub 接线 post-guard 主会话专用；子 agent 的隔离 worktree 本就出现在该仓库的 `git worktree list` 里（`pi-agent-*` 行），无需另行聚合。

### D4 只读、无 fetch、无 preview（Q5）

- 只读：无「删除/prune worktree」按钮——写操作是新权限级别，需控制平面评审（§11）。
- 不 fetch：有网络/凭据副作用；TUI 下 HUD 已按 `hud.autoFetchMinutes` fetch 同一个 `.git`（remote-tracking ref 仓库级共享，web 侧自然受益）。ahead/behind 口径 = 「相对本地 remote-tracking ref」，UI tooltip 注明。
- preview：不做，列 v2。

### D5 展示：详情头折叠面板

挂 `DetailHeader.vue` 模板 `TodoPanel` 之后一行；`DetailHeaderProps` 已传整个 `AgentState`，零冻结 props 改动。面板自包含（props 只有 `WorktreesWire`）。

### D6 新鲜度：显示 stale 而非承诺固定 SLA（r1 #4）

保留慢仓库自适应退避（保护用户机器），但不再承诺「任何仓库 ≤30s」：正常仓库 ≤30s 可见；慢仓库/连续失败时按退避上限（≤5min）刷新，并由 agent 侧算出 `staleMin`，UI 显示 `·stale Nm` 与 `last sample HH:MM`。

## 3. 协议（W2，`src/web-hub/protocol/messages.ts`）

### 3.1 类型（追加在 `TodoWire` 之后、`StatusInfo` 之前）

```ts
/** worktree-web plan §3.1: one row of `StatusInfo.worktrees` (ranked: current → main → others → pi-agent-* → prunable). */
export interface WorktreeRowWire {
  label: string; // home-abbreviated path (`~/ai/pi-toolkit`), projection cap 200 B
  path?: string; // absolute path, projection cap 1024 B; FIRST field dropped under budget pressure (pass 2)
  branch?: string; // `refs/heads/` stripped, projection cap 200 B; absent ⇒ detached or bare
  head?: string; // 7-char short sha; absent for bare / unborn
  current?: true; // realpath(row.path) === realpath(toplevel) — §4.1 step 3
  main?: true; // first entry of `git worktree list` (the main worktree)
  agentRunId?: string; // branch `pi-agent-<id>` ⇒ `<id>` (safeRunId form), projection cap 64 B
  bare?: true;
  locked?: true;
  prunable?: true; // never probed
  dirty?: number; // status probe produced a count (exact, or a lower bound when dirtyCapped)
  dirtyCapped?: true; // status stdout hit the 64 KiB cap: dirty is a LOWER BOUND (UI `*N+`)
  untrackedSkipped?: true; // degraded probe (`-uno`): untracked files not counted (UI `~`)
  ahead?: number; // probe OK AND upstream configured only
  behind?: number;
  unprobed?: "cap" | "timeout" | "error"; // no dirty/ab: beyond probe cap / probe timed out / probe failed
}
/** `StatusInfo.worktrees`' body. Absent ⇒ cwd not in a git repo / not sampled yet / web-hub off. */
export interface WorktreesWire {
  rows: WorktreeRowWire[]; // ≤ WT_MAX_ROWS (24), ranked
  total: number; // full parsed `git worktree list` population (a lower bound when listCapped)
  listCapped?: true; // `worktree list` stdout hit its cap; only complete records were parsed
  omitted?: number; // total - rows.length, when > 0
  probed: number; // full-population rows with a dirty count
  dirtyCount: number; // probed rows with dirty > 0
  agentCount: number; // full-population pi-agent-* rows
  sampledAt: number; // agent-clock epoch ms of the successful sample that produced this content
  staleMin?: number; // agent-computed: whole minutes since sampledAt, present only when > 90 s
}
// StatusInfo 追加：
//   /** worktree-web plan §3 (W2): optional git-worktree summary of the session cwd's repo … */
//   worktrees?: WorktreesWire;
```

- `?: true` 旗标与 `descTruncated` 同惯例（省字节、无 `false` 歧义）。
- **时间语义**：`sampledAt` 只用于展示（`last sample HH:MM`，agent 时钟）；是否 stale 由 agent 计算为 `staleMin`（agent 与浏览器可能跨机器，避免浏览器时钟偏差）。

### 3.2 Schema（`StatusInfoSchema` 追加 `worktrees: Type.Optional(WorktreesWireSchema)`）

- **对象开放**（Q4 拍板）：`WorktreeRowSchema`、`WorktreesWireSchema` **不设** `additionalProperties:false`。理由：`decodeWith` 失败丢**整个** status 帧；hub 替换最长等 30 min（control-plan D25），期间新 agent 会连旧 hub——closed 体会让以后加行字段冻结整个会话状态。
- **已知字段硬安全上限**（r1 #6；schema 上限 **宽于** 投影口径，给后续版本留余量，避免旧 hub 因上限收紧拒帧）：

  | 字段                                                                     | schema 约束                                                                                     | 投影实际口径 |
  | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------ |
  | `rows`                                                                   | `maxItems: 64`                                                                                  | ≤24          |
  | `label`                                                                  | `maxLength: 512`                                                                                | ≤200 B       |
  | `path`                                                                   | `maxLength: 4096`（PATH_MAX）                                                                   | ≤1024 B      |
  | `branch`                                                                 | `maxLength: 512`                                                                                | ≤200 B       |
  | `head`                                                                   | `maxLength: 64`                                                                                 | 7            |
  | `agentRunId`                                                             | `maxLength: 128`                                                                                | ≤64 B        |
  | `unprobed`                                                               | `Type.String({ maxLength: 32 })`（开放枚举，旧 hub 不因新原因值拒帧；UI 未知值按 `error` 显示） | 3 个值       |
  | `dirty/ahead/behind/total/omitted/probed/dirtyCount/agentCount/staleMin` | `Type.Integer({ minimum: 0 })`                                                                  | —            |
  | `sampledAt`                                                              | `Type.Number({ minimum: 0 })`                                                                   | —            |
  | 旗标                                                                     | `Type.Optional(Type.Literal(true))`                                                             | —            |

  （`maxLength` 按 UTF-16 码元计；投影按 UTF-8 字节截断，字节 ≥ 码元，故投影输出恒满足 schema——W2 用属性测试钉住。）

- **未知字段**：数量/大小只受 `MAX_FRAME_BYTES`（4 MiB）约束——开放对象的固有代价；hub 只在内存 `r.status` 透传、不落盘；UI 只按已知字段文本插值，未知字段永不渲染。
- 顶层 `StatusFrameSchema` 本就开放 ⇒ 旧 hub 放行带 `worktrees` 的帧；旧 UI 忽略；新 UI 遇旧 agent（无字段）⇒ 面板不渲染。**不 bump `PROTO`、不加 cap**。跨版本组合由 §7 fixture 测试钉住。

## 4. agent 侧

### 4.1 W1 共享采集层 `src/git/`（新，pi-free）

**`src/git/run.ts` —— 有界执行器（r1 #1/#2）**

```ts
export interface GitRunOptions {
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number; // default 8 KiB
  signal?: AbortSignal;
}
export interface GitRunResult {
  code: number | null; // null when killed
  stdout: string; // ≤ maxStdoutBytes (utf8, decoded once at settle)
  stdoutCapped: boolean; // true ⇒ output hit the cap and the process group was killed
  stderr: string;
  killed?: "timeout" | "abort" | "overflow";
  spawnError?: string; // ENOENT (git missing) etc.
}
export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;
export function createGitRunner(deps?: {
  gitBinary?: string /* tests: fake git script */;
  spawnImpl?: typeof spawn;
}): GitRunner;
```

- 固定前缀：`git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false …`（不写 index、不抢 `index.lock`；`core.fsmonitor` 可配置为任意命令，禁掉以免仓库配置借采样执行外部程序）。
- 固定 env：`{ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }`。
- `spawn(bin, args, { cwd, shell: false, stdio: ["ignore","pipe","pipe"], detached: true })`——独立进程组，便于整组击杀（git 的子进程/钩子也一并带走）。
- **终止**：超时（`setTimeout`，`unref`）/ `signal` abort / stdout 超限 ⇒ `process.kill(-pid, "SIGKILL")`（失败退回 `child.kill("SIGKILL")`），**同步 settle**（不等 `close`；销毁 stdout/stderr 流、摘全部监听），故返回时间不受「进程忽略 SIGTERM」或「孙进程持有管道」影响。只读 git 命令被 SIGKILL 是安全的（`--no-optional-locks` 下不写 index）。
- **输出上限**：`data` 事件按字节累计，超出部分丢弃并立即触发 overflow 击杀；stderr 同理（只截断不击杀）。内存上界 = `maxStdoutBytes + maxStderrBytes`。
- 平台：POSIX（同 `src/bash/`；web-hub spawn 本身 Linux-only）。

**`src/git/path-label.ts` —— 路径缩写（r1 #7）**

`abbreviateHome(path, home)`：逻辑复制自 `src/hud/format.ts:15-25` 的 `formatCwdForFooter`（pi-free）；**HUD 保持原样**，文件头注明「W6 去重：HUD 改为 import 本函数」。web-hub 不再 import `src/hud/**`。

**`src/git/worktrees.ts` —— 解析 + 扫描**

```ts
export interface PorcelainWorktree {
  path: string;
  head?: string /*full oid*/;
  branch?: string;
  detached?: true;
  bare?: true;
  locked?: true;
  prunable?: true;
}
export interface RepoProbe {
  dirty: number;
  dirtyCapped: boolean;
  untrackedSkipped: boolean;
  upstream: boolean;
  ahead: number;
  behind: number;
}
export interface ScannedWorktree extends PorcelainWorktree {
  main: boolean;
  current: boolean;
  agentRunId?: string;
  probe?: RepoProbe;
  unprobed?: "cap" | "timeout" | "error";
}
export type ScanResult =
  | { kind: "ok"; toplevel: string; worktrees: ScannedWorktree[]; listCapped: boolean } // ranked
  | { kind: "not-repo"; reason: "rev-parse" | "proc-fd-cwd" }
  | { kind: "error"; reason: "timeout" | "abort" | "spawn" | "list" }; // 调用方保留上次结果

export function parseWorktreePorcelain(stdout: string, capped: boolean): PorcelainWorktree[]; // capped ⇒ 丢弃最后一条可能不完整的记录
export function parseStatusV2(stdout: string, capped: boolean): Omit<RepoProbe, "untrackedSkipped">; // capped ⇒ 丢弃末行残片
export function rankWorktrees<T extends ScannedWorktree>(list: T[]): T[];
export async function scanWorktrees(
  run: GitRunner,
  cwd: string,
  opts: {
    signal: AbortSignal;
    realpath?: (p: string) => Promise<string>; // 测试缝，默认 fs.promises.realpath
    degraded?: ReadonlySet<string>; // sampler 维护：需改用 -uno 的 worktree realpath 集合
    maxProbes?: number /*8*/;
    concurrency?: number /*4*/;
    cmdTimeoutMs?: number /*3000*/;
  },
): Promise<ScanResult>;
```

各命令输出上限：`rev-parse` 4 KiB；`worktree list` 256 KiB（≈1000+ 条记录）；`status` 64 KiB。单次采样内存上界 ≈ 4 + 256 + 8×64 KiB ≈ 772 KiB。

`scanWorktrees` 步骤：

1. **cwd 防御**：cwd 匹配 `^/proc/(self|\d+)/fd/` ⇒ `not-repo{proc-fd-cwd}`（fail-closed，不猜）。论证：pi 的 cwd 来自 `process.cwd()`（`getcwd()` 规范路径，§1.3），托管子进程经 `chdir(/proc/self/fd/N)` 后 `getcwd()` 同样返回真实路径，正常不会命中；若命中，该路径在 git 子进程里会指向 git 自己的 fd，任何推断都是错的。
2. `rev-parse --show-toplevel`（`-C cwd`）⇒ `toplevel`；`code≠0` 且未被 kill ⇒ `not-repo{rev-parse}`；被 kill/spawn 失败 ⇒ `error`。
3. **realpath 规范化（r1 #3）**：`topKey = realpath(toplevel) ?? toplevel`；`worktree list --porcelain`（`-C cwd`）解析后对每条 `rowKey = realpath(path) ?? path`（并发 4；prunable 行跳过 realpath）；`current ⇔ rowKey === topKey`；最多一行 current；**无匹配 ⇒ 没有 current 行**（UI 省摘要首段），绝不按路径前缀推断（嵌套 worktree 时 main 不会被误判）。首条 `main:true`；`branch` 匹配 `/^pi-agent-(.+)$/` ⇒ `agentRunId`。v1 不用 `-z`（需 git ≥2.36）：含换行的路径会被拆成畸形记录——解析器丢弃没有 `HEAD`/`bare` 行的残片记录，不崩溃；完整支持列 v2。
4. `rankWorktrees` 后，对前 `maxProbes` 个**非 bare、非 prunable** 行以并发 `concurrency` 探测：
   - 默认 `status --porcelain=v2 --branch --untracked-files=normal`；该行 realpath 在 `degraded` 集合中 ⇒ 改用 `--untracked-files=no`（`untrackedSkipped:true`）。
   - 输出超限 ⇒ 头部（`# branch.*`，总在最前）照常解析，`dirty = 已完整解析的条目数`、`dirtyCapped:true`（必然 dirty：超限本身意味着条目极多）。
   - 超时 ⇒ `unprobed:"timeout"`（sampler 据此把该行加入 `degraded`）；其它失败 ⇒ `unprobed:"error"`；排名在探测上限之外 ⇒ `unprobed:"cap"`。
5. `signal` abort ⇒ 不再起新命令，返回 `error{abort}`。

**大仓库降级口径**（对用户可见的语义）：精确计数 `*3` → 输出超限 `*N+`（下限）→ 超时后降级 `-uno` `*2~`（只算已跟踪改动）→ 降级仍超时 `?`（tooltip：timed out）。`degraded` 集合在 session_start / cwd 变化时清空。

### 4.2 W2 投影 `src/web-hub/agent/worktrees.ts`（新，纯函数）

```ts
export const WT_MAX_ROWS = 24,
  WT_LABEL_MAX_BYTES = 200,
  WT_PATH_MAX_BYTES = 1024,
  WT_BRANCH_MAX_BYTES = 200,
  WT_RUNID_MAX_BYTES = 64,
  WT_WIRE_BUDGET_BYTES = 16 << 10;
export function projectWorktrees(
  scan: Extract<ScanResult, { kind: "ok" }>,
  home: string | undefined,
  sampledAt: number,
): WorktreesWire;
export function worktreesFingerprint(wire: WorktreesWire | undefined): string; // 内容(去 sampledAt) + floor(sampledAt/60s) + staleMin
```

- `label = abbreviateHome(path, home)`（`src/git/path-label.ts`）；`head = oid.slice(0,7)`；字段经 `truncateText`（`protocol/keys.ts:169`，UTF-8 码点安全）截断。
- `probed/dirtyCount/agentCount/total` 全量口径（同 todo `counts`）。
- 三段预算（照 `projectTodo.fitBudget`）：① 单字段字节上限；② 超 16 KiB ⇒ 自尾向前删 `path`；③ 仍超 ⇒ 自尾删行计入 `omitted`，**下标 0（current，若存在）永不删**。

### 4.3 W3 采样器 `src/web-hub/agent/worktree-sampler.ts`（新）

```ts
export interface WorktreeSampler {
  current(): WorktreesWire | undefined; // readStatus 同步读，零 I/O
  start(cwd: string): void;             // session_start：起兜底定时器(unref) + 立即 kick
  kick(): void;                         // 去抖：距上次开始 <5s ⇒ 排一个 trailing（unref）
  tick(now: number): boolean;           // web-hub 1Hz onTick 调：重算 staleMin，变化返回 true
  stop(): void;                         // session_shutdown：清定时器、abort 在途、代际+1
}
export function createWorktreeSampler(deps: {
  run: GitRunner; home: string | undefined; now: () => number;
  isLive: () => boolean;                 // conn?.status().state === "live"；非 live 时跳过
  onChange: () => void;                  // 指纹变化 ⇒ publishStatus()
  hardDeadlineMs?: number;               // 默认 8000
  setTimer?/clearTimer?: …;              // 测试缝（默认 setTimeout + unref）
  realpath?: (p: string) => Promise<string>;
}): WorktreeSampler;
```

规则：

- **硬 deadline（r1 #1，合入门槛）**：每次采样 `sampleId++` 并新建 `AbortController`；`Promise.race([scanWorktrees(…), deadline(hardDeadlineMs)])`。deadline 先到 ⇒ 立即 `abort()`（执行器同步 SIGKILL 进程组）、本次结果记为 `error{timeout}`、**立即释放单飞锁**；scan promise 之后才 settle 的结果按 `sampleId`/`generation` 丢弃。sampler 的可观察返回时间 ≤ `hardDeadlineMs` + 一个 tick，与底层 git 是否响应 SIGTERM、`realpath` 是否卡住无关。
- **僵尸防护**：被 deadline 放弃但尚未 settle 的 scan（如 NFS 上 `realpath` 卡在 libuv 线程池）计数 `zombies`；`zombies ≥ 1` 时不起新 scan（避免占满 4 线程线程池拖垮 pi 的全部 fs 操作），保持缓存并让 `staleMin` 增长；僵尸 settle 后自动恢复。
- **单飞**：在途时的 kick 只置 `rerun`，完成后补跑一次。
- **代际**：`start/stop` 递增 `generation`；`stop()` 立即 abort 在途。
- **结果处理**：`ok` ⇒ 投影（`sampledAt = now()`）→ 指纹比对 → 变化才替换缓存并 `onChange()`；超时行加入 `degraded`；`not-repo` ⇒ 缓存清为 `undefined`（变化则 `onChange`）；`error` ⇒ **保留上次结果**（stale-while-error）。
- **新鲜度（r1 #4）**：`tick(now)`：`age = now - cache.sampledAt`；`age > 90s` ⇒ `staleMin = floor(age/60s)`（≥1），否则删除；`staleMin` 变化 ⇒ 返回 true（调用方 `publishStatus()`）——stale 期间每分钟至多 1 帧。90s = 3× 基础间隔，正常仓库永不出现 stale。
- **自适应退避**：采样耗时 > 1.5s 或结果为 `error` ⇒ 兜底间隔翻倍（上限 5min）；耗时 < 500ms 且成功 ⇒ 复位 30s。kick 不受退避影响但受 5s 最小间隔与僵尸防护约束。
- **cwd 变化**：`start(cwd)` 与上次不同 ⇒ 清缓存与 `degraded`；相同 ⇒ 保留（/new 同 cwd 不闪）。
- 所有 timer `unref()`；不订阅 `pi.events`。

### 4.4 W3 接线（`agent/status.ts`、`agent/index.ts`）

- `status.ts`：`readStatus(ctx, tap, fleet, queueMirror?, todo?, worktrees?: () => WorktreesWire | undefined)`——第 6 个可选参数；`const w = worktrees?.(); if (w !== undefined) status.worktrees = w;`。不传 ⇒ 字节级等价现状。
- `index.ts`：
  - `WebHubDeps` 追加测试缝 `gitRunner?: GitRunner`（同 `netConnect` 段：生产不设）。
  - 闭包内 `const wtSampler = createWorktreeSampler({ run: deps.gitRunner ?? createGitRunner(), home, now, isLive: () => conn?.status().state === "live", onChange: () => publishStatus() })`。
  - 两个 `readStatus` 调用点透传 `() => wtSampler.current()`。
  - `session_start`（`:696` 起，mode 门之后）：`wtSampler.start(safe(() => c.cwd, ""))`。
  - `session_shutdown`（`:728` 起）：`wtSampler.stop()`。
  - `connectWith` 末尾：`wtSampler.kick()`。
  - `STATUS_EVENTS` 分支中 `turn_end`/`agent_settled`：`wtSampler.kick()`。
  - `onTick`：fleet 指纹变化分支（`:421-424`）内 `wtSampler.kick()`；另加 `if (wtSampler.tick(now())) publishStatus();`。
- **不改 `src/index.ts`**；print/json 模式在 session_start 第一行已 return，采样器永不启动。

## 5. UI（W4）

- **`components/detail/worktreesView.ts`（新）**：`worktreesOf(agent: Pick<AgentState,"status">): WorktreesWire | undefined`——基于 `statusOf`，浅校验 `Array.isArray(w.rows) && w.rows.length > 0`。
- **`components/detail/WorktreePanel.vue`（新）**：
  - props（本地 interface，不进 `contracts.ts`）：`{ readonly worktrees: WorktreesWire }`；类型 `import type … from "@protocol/messages.js"`（**不改 `types.ts`**）。
  - 折叠态（默认折叠，本地 `ref`，不持久化——source-scan 的 localStorage 白名单）：一行 button `aria-expanded`：
    `[branch 图标] {cur.branch ?? "detached"}@{cur.head} ↑a ↓b · worktrees {total}{listCapped ? "+" : ""} · {dirtyCount} dirty · {agentCount} agent ·stale {staleMin}m ›`
    - 段落按需出现：无 current 行 ⇒ 省首段；ahead/behind 为 0 或缺 ⇒ 省；计数为 0 ⇒ 省；无 `staleMin` ⇒ 省。
    - **紧凑标记英文 token**（AGENTS.md 约定）：en/zh 的这些 key 值相同；i18n-parity 只比键集。
  - 展开态 `<ul>`：每行 = 标记（`●` current / `○` 其它）+ `label`（等宽、末尾省略、`title` = `path ?? label`，`translate="no"`）+ 分支 chip（`detached@sha` 兜底）+ `head` + 状态 token：`*3` / `*N+`（`dirtyCapped`）/ `*2~`（`untrackedSkipped`）/ `clean` / `?`（`unprobed`，tooltip 区分 `cap`「beyond probe limit」/ `timeout`「timed out」/ `error` 及未知值）+ `↑a ↓b` + 旗标 chip `main`/`agent`/`locked`/`prunable`/`bare`；`omitted` ⇒ 尾行 `(+N more)`；列表尾一行 muted `last sample HH:MM`（`sampledAt`，agent 时钟，tooltip 注明）。ahead/behind tooltip：相对本地 remote-tracking ref，未 fetch。
  - 纯文本插值，无 `v-html`、不进 `markdown.js`、不挂 `PathText.vue`；未知字段永不读取。
- **`styles/worktrees.css`（新）**：token-only，照 `styles/todo.css`；≤480px 行改两行（第 1 行 标记+分支+token，第 2 行 label 小号 muted），chip 可换行，`min-height: 32px`；无 JS 媒体查询。
- **`DetailHeader.vue`**：import `WorktreePanel` 与 `worktreesOf`；`const worktrees = computed(() => worktreesOf(props.agent))`；模板 `<TodoPanel …/>` **之后**一行 `<WorktreePanel v-if="worktrees" :worktrees="worktrees" />`。只动 import 段与模板尾。
- **i18n**：`i18n/{en,zh}/detail.ts` 新增 `worktreesBranchDetached`、`worktreesCount`、`worktreesDirty`、`worktreesAgent`、`worktreesStale`、`worktreesLastSample`、`worktreesToggleAria`、`worktreesUnprobedCap/Timeout/Error`、`worktreesDirtyCapped`、`worktreesUntrackedSkipped`、`worktreesAbHint`、`worktreesMore`、`worktreesFlagMain/Agent/Locked/Prunable/Bare`。**插入位置：`todoTitle` 键之前**，与删除会话 P2 尾部追加隔开 ≥7 行。

### 5.1 单 worktree 时也显示（Q2 拍板）

web 上没有别处展示 git 分支/dirty/↑↓，RPC 托管会话尤其需要；1 行时折叠摘要即足够。不在 git 仓库 ⇒ 字段缺失 ⇒ 不渲染。

## 6. 隐私 / 安全口径

- **新增资产类别（r1 #5 如实记录）**：同仓库**所有** worktree 的绝对路径（含 `/tmp/pi-subagent-worktrees/<runId>`、仓库外任意位置的 worktree）、分支名、HEAD 短 sha、dirty 计数，经 status slot 广播给全部通过鉴权的浏览器（含 LAN password 明文 HTTP）。v1 文中「不新增资产类别」的表述是错误的，已删除。
- **风险接受**：用户 2026-10-06 ask_user Q1 裁定下发绝对路径；裁定基础与 web-hub preview U1 相同（AGENTS.md web-hub 节：LAN 唯一用户、密码认证、风险明示接受）。**若 LAN 上出现其他使用者**，应重新评估本字段（备选：只发 `label`，或 hub 侧按 listener 脱敏——后者需改 hub，届时单独立项）。
- **不经 preview**：面板路径不可点击；`webHub.preview` 准入面零变化。
- **注入面**：branch/path 是本机文件系统/ref 名（可含任意 Unicode），一律文本插值；`translate="no"`；字节截断 + schema `maxLength` 双重约束。
- **副作用面**：只跑只读 git 子命令；`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0` 不写 index；`core.fsmonitor=false` 防止仓库配置借采样执行外部命令；`GIT_TERMINAL_PROMPT=0`；不 fetch、无网络；hub 进程不执行任何 git；hub 不持久化 status。
- **无新端点/帧/cap/设置**：鉴权矩阵、conn-guard、ratelimit、审计零变化。

## 7. 测试计划

**合入门槛（★）**：W1 的执行器硬终止与输出上限测试、W3 的 sampler 硬 deadline 测试——未全绿不得合入。真实 git 测试用 `describe.skipIf(!hasGit)`，CI（ubuntu）上必须实跑。

| 层                      | 文件                                                                                                                                                | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ★ 执行器（真实进程）    | 新 `tests/git/run.test.ts`                                                                                                                          | `gitBinary` 指向测试时写入 tmp 的 sh 脚本：① `trap '' TERM; while :; do sleep 1; done`，`timeoutMs=300` ⇒ 返回耗时 < 300+200ms、`killed:"timeout"`、进程已死（`kill -0` 失败）；② 脚本后台起 `sleep 100 &` 孙进程持有 stdout ⇒ 仍按时返回且孙进程被整组击杀；③ `head -c 10485760 /dev/zero \| tr '\0' x`（10 MiB）+ `maxStdoutBytes=64KiB` ⇒ `stdoutCapped`、`stdout.length ≤ 64KiB`、`killed:"overflow"`、耗时 < 1s；④ abort signal ⇒ 同步击杀；⑤ ENOENT ⇒ `spawnError`；⑥ 参数前缀与 env 断言；⑦ timer `hasRef()===false`                                                                                                                                                                                                                                                                        |
| 解析（纯函数）          | 新 `tests/git/worktrees.test.ts`                                                                                                                    | porcelain：main/branch/detached/bare/`locked <reason>`/`prunable <reason>`/尾空行/capped 时丢弃末条残片/换行路径残片被丢弃不崩溃；status v2：无 `branch.ab` ⇒ `upstream:false`、`(initial)`、untracked 计入、capped 时丢弃末行残片并保留头部；`rankWorktrees` 顺序；`/proc/self/fd/7` 与 `/proc/123/fd/7` cwd ⇒ `not-repo{proc-fd-cwd}` 且零命令；realpath 缝：`realpath("/proc-alias/x") → "/real/x"` 等价时 current 正确；realpath 失败退回原字符串                                                                                                                                                                                                                                                                                                                                              |
| ★ 真实 git 集成         | 新 `tests/integration/git-worktrees.test.ts`                                                                                                        | tmp 下 `git init` 真实仓库：① main + 链接 worktree + detached worktree；② `git worktree lock --reason x` ⇒ `locked`；③ `rm -rf` 链接 worktree 目录 ⇒ `prunable` 且不探测；④ 同路径删除后 `git worktree prune && git worktree add` 重建 ⇒ 恢复正常行、不重复；⑤ `git init --bare` + `worktree add` ⇒ main 为 `bare`、不探测；⑥ **cwd 为指向链接 worktree 子目录的符号链接** ⇒ 仅该行 current；⑦ **嵌套 worktree**（`<main>/.wt/x`），cwd 在内层 ⇒ 仅内层 current、main 非 current；⑧ 本地 bare remote + push + 新提交 ⇒ `ahead:1`，无 upstream 分支 ⇒ 无 ahead/behind；⑨ ★ 3000 个顶层 untracked 文件 + 测试注入 `status` 上限 4 KiB ⇒ `dirtyCapped`、`dirty` 为下限且 >0、分支头仍正确；⑩ 采样期间另起 `git commit` 不报 `index.lock`；⑪ 换行路径：`it.skip` 并注明「v1 不用 -z，见 §4.1 第 3 步」 |
| 投影                    | 新 `tests/web-hub/agent/worktrees-projection.test.ts`                                                                                               | label `~` 缩写；`head` 7 位；`agentRunId`；旗标仅 `true` 出现；全量计数；>24 行 ⇒ `omitted`；CJK 分支名 UTF-8 截断；预算 ②删 path ③删行、current 永不删；**属性测试：随机扫描结果的投影输出恒通过 `WorktreesWireSchema`**；指纹：`sampledAt` 同分钟变化不改指纹、跨分钟改、`staleMin` 改、任一行 dirty 改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ★ 采样器                | 新 `tests/web-hub/agent/worktree-sampler.test.ts`                                                                                                   | fake timers：首采 ⇒ `onChange` 1 次；同结果不触发；kick 5s 去抖 + trailing；单飞 + rerun；**★ runner 永不 resolve ⇒ 8s 时 sampler 返回 `error`、signal 已 aborted、单飞锁已释放**；**★ 真实计时版：真实执行器 + 忽略 SIGTERM 的假 git 脚本 + `hardDeadlineMs=500` ⇒ 观察到的返回耗时 < 500+250ms**；迟到结果（deadline 后 resolve）被丢弃；僵尸存在时不起新 scan、settle 后恢复；`not-repo` 清缓存；`error` 保留缓存；超时行进入 `degraded`、下次用 `-uno`；`stop()` abort 在途；cwd 变化清缓存与 `degraded`；`isLive()` false 不调 runner；`tick()`：≤90s 无 `staleMin`、150s ⇒ `2`、同分钟内不重复返回 true；退避翻倍封顶 5min、成功快采复位；全部 timer `hasRef()===false`                                                                                                                      |
| agent 接线              | `tests/web-hub/agent/wiring.test.ts`（追加 describe，照 `:248` todo 段）                                                                            | `deps.gitRunner` fake：live 后 status slot 带 `worktrees`；无变化不重发；`turn_end`/fleet 变化触发 kick；stale 跨分钟触发重发；print 模式零 runner 调用；session_shutdown 后零调用；不设 `gitRunner` 时现有用例零改动通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| readStatus              | `tests/web-hub/agent/snapshot.test.ts`                                                                                                              | 带 getter ⇒ `status.worktrees`；无 getter/undefined ⇒ 无该键；`snapshot_reply.status.worktrees` 与 slot 一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 协议                    | `tests/web-hub/protocol/messages.test.ts`                                                                                                           | 带/不带 `worktrees` 均可解码；`rows` 非数组 / `dirty` 负数或非整数 / `path` 超 4096 / `rows` 超 64 ⇒ 整帧拒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 跨版本 fixture（r1 #6） | 新 `tests/web-hub/protocol/worktrees-compat.test.ts` + `tests/fixtures/web-hub-worktrees/{v1-status.json,future-row-field.json,legacy-status.json}` | ① 旧 hub + 新 agent：用测试内构造的「不含 `worktrees` 键的旧 `StatusInfoSchema` 副本」解码 `v1-status.json` ⇒ 通过；② 新 hub + 旧 agent：`legacy-status.json`（无字段）解码通过，`worktreesOf` ⇒ undefined、面板不渲染；③ 新 agent + 旧 UI：`logic/state.js` reducer 吃 `v1-status.json` 后 `a.status` 原样替换、其它镜像（todo/queue）不受影响；④ 未来行字段：`future-row-field.json`（行内 `foo` + `unprobed:"slow-fs"`）解码通过、hub 透传对象深相等、`WorktreePanel` 渲染不报错且 `slow-fs` 显示为 `?`、`foo` 不出现在 DOM；⑤ `v1-status.json` 由投影函数生成后提交，测试比对防漂移（不得静默重生成，同 compact-hint golden 惯例）                                                                                                                                                             |
| UI 组件                 | 新 `tests/web-hub/ui/worktree-panel.test.ts`；`detail-header.test.ts` 补 1 例                                                                       | 无字段 ⇒ 不渲染；摘要各段按需出现（含 `·stale 2m`、`worktrees 12+`）；默认折叠、`aria-expanded` 切换；current 标记、chip、`*N+`/`*2~`/`?` 三种 tooltip、`(+N more)`、`last sample`；`title` 为绝对路径；DetailHeader 在 `status.worktrees` 存在时挂面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 自动守卫                | `i18n-parity.test.ts`、`source-scan.test.ts`、`logic-state.test.ts`                                                                                 | 零改动全绿（state.js 未动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| HUD 回归                | `tests/hud/*`                                                                                                                                       | `src/hud/` 零 diff，现有用例全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 8. 拆包、文件域与冻结面

| 包                      | 文件域（独占）                                                                                                                                                                                                                                                                                                                     | 依赖                                 | 建议执行者             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------- |
| **W1 共享采集层**       | 新 `src/git/run.ts`、`src/git/worktrees.ts`、`src/git/path-label.ts`；新 `tests/git/run.test.ts`、`tests/git/worktrees.test.ts`、`tests/integration/git-worktrees.test.ts`                                                                                                                                                         | —                                    | 后端 dev               |
| **W2 协议 + 投影**      | `src/web-hub/protocol/messages.ts`（类型 + schema，**仅追加**）；新 `src/web-hub/agent/worktrees.ts`；`tests/web-hub/protocol/messages.test.ts`；新 `tests/web-hub/protocol/worktrees-compat.test.ts`、`tests/fixtures/web-hub-worktrees/*.json`、`tests/web-hub/agent/worktrees-projection.test.ts`                               | W1（类型）                           | 后端 dev               |
| **W3 采样器 + 接线**    | 新 `src/web-hub/agent/worktree-sampler.ts`；`src/web-hub/agent/status.ts`；`src/web-hub/agent/index.ts`；新 `tests/web-hub/agent/worktree-sampler.test.ts`；`tests/web-hub/agent/{wiring,snapshot}.test.ts`                                                                                                                        | W1、W2                               | 后端 dev               |
| **W4 UI 面板**          | 新 `ui/src/components/detail/{WorktreePanel.vue,worktreesView.ts}`；新 `ui/src/styles/worktrees.css`；`ui/src/components/detail/DetailHeader.vue`（import + 1 computed + 1 模板行）；`ui/src/i18n/{en,zh}/detail.ts`（`todoTitle` 前插入）；新 `tests/web-hub/ui/worktree-panel.test.ts`；`tests/web-hub/ui/detail-header.test.ts` | W2（类型）；与 W3 并行（假 fixture） | frontend-dev           |
| **W5 文档收尾**         | `AGENTS.md`（`src/web-hub/` 条目在 todo 句后追加一句；layout 增 `src/git/` 一行：有界 git 执行器 + worktree 扫描，pi-free）；本 plan 状态行                                                                                                                                                                                        | 全部                                 | 主会话                 |
| W6 HUD 迁移（后续，Q6） | `src/hud/git.ts` 委托 `src/git/`；`src/hud/footer.ts` current 判定改 realpath/toplevel、缩写改 import `abbreviateHome`（删 `format.ts` 的重复实现）；`tests/hud/*`                                                                                                                                                                 | W1                                   | 独立评审，不在本功能内 |

顺序：W1 → W2 → (W3 ∥ W4) → W5。每包返回即派 verifier（验收模型 ≠ 开发模型），通过后精确路径 commit。

**本方案的冻结面**（W2 合入后 W3/W4 只读）：`WorktreeRowWire`/`WorktreesWire` 字段名与语义、schema 上限表（§3.2）、`StatusInfo.worktrees` 键名、`worktreesOf` 签名、`GitRunner` 接口（W1 合入后）。

**与在途线的共享文件**：

| 文件                                        | 另一方                                                           | 风险 | 规避                                                      |
| ------------------------------------------- | ---------------------------------------------------------------- | ---- | --------------------------------------------------------- |
| `ui/src/i18n/{en,zh}/detail.ts`             | 删除会话 P2（尾部追加 2 键）                                     | 低   | 本方案插在 `todoTitle` 之前，hunk 不相邻；后合入方 rebase |
| `ui/src/components/detail/DetailHeader.vue` | 关闭托管会话（可能动中部停止按钮）                               | 低   | 只动 import 段与模板尾行                                  |
| `src/web-hub/protocol/messages.ts`          | 删除会话 P0 **不改**此文件（只改 `http-contract.ts`/`spawn.ts`） | 极低 | append-only                                               |
| `AGENTS.md`（W5）                           | 任意收尾包                                                       | 低   | 最后合入，单句追加                                        |

**明确不碰**：`hub/**`、`ui/src/logic/state.js`、`ui/src/types.ts`、`ui/src/contracts.ts`、`components/agents/**`（AgentCard 徽标不做）、`src/index.ts`、`src/config/**`、`src/hud/**`。

## 9. 验收锚点

**W1**

- [ ] ★ 执行器：忽略 SIGTERM 的进程与持管道孙进程均在 `timeoutMs + 200ms` 内返回且整组被杀；10 MiB 输出在上限处截断、内存有界、`killed:"overflow"`。
- [ ] 每条命令带 `--no-optional-locks -c core.fsmonitor=false`、固定 env；探测 ≤8、并发 ≤4；not-repo/error 区分正确；`/proc/*/fd/` cwd fail-closed。
- [ ] ★ 真实 git：locked/prunable/bare/删除重建/符号链接 cwd/嵌套 worktree/upstream/untracked 超限全部按 §7 断言通过。

**W2**

- [ ] 排序、`omitted`、16 KiB 预算两段削、current 保留；投影输出恒通过 schema（属性测试）。
- [ ] 跨版本 fixture 五组合全绿；字段超 schema 上限整帧拒。

**W3**

- [ ] ★ sampler 硬 deadline：runner 不 resolve 时 8s 返回 `error`；真实忽略 SIGTERM 脚本下观察耗时 < `hardDeadlineMs + 250ms`；迟到结果丢弃；僵尸防护生效。
- [ ] `readStatus` 零 git 调用；内容不变时只在分钟桶/stale 变化时重发。
- [ ] session_shutdown/`/reload` 后零 runner 调用、在途被 abort；所有 timer unref；print 模式零调用。

**W4**

- [ ] 无字段不渲染；摘要只含英文 token；`·stale Nm`、`*N+`、`*N~`、`?` 正确；展开/折叠键盘可达。
- [ ] `i18n-parity`、`source-scan`、`logic-state` 全绿。

**真机（tmux，参照 live-acceptance-tmux 惯例；需 `pi install` 装载，见 AGENTS.md todo #27）**

- [ ] **正常仓库 ≤30s**：TUI 会话开 web-hub，详情页出现 `master@<sha> · worktrees 1`；`git worktree add /tmp/wt-x -b wt-x` 后 ≤30s（或下一次 turn_end 后 ≤5s）出现第 2 行；在 `/tmp/wt-x` 里 `touch a` ⇒ 该行 `*1`；`git worktree remove` ⇒ 行消失。
- [ ] **慢仓库按退避上限并显示 stale**：用一个 `status` 超过 1.5s 的大仓库（或临时把 `hardDeadlineMs`/阈值调小的调试构建），观察兜底间隔翻倍、≤5min 刷新一次，期间摘要显示 `·stale Nm`、展开区 `last sample HH:MM` 与实际一致；恢复后 stale 消失。
- [ ] 大量 untracked 文件的 worktree 显示 `*N+` 而非 clean；超时降级后显示 `*N~`。
- [ ] 派一个 `isolation:"worktree"` 的 Agent ⇒ 出现带 `agent` chip 的 `pi-agent-*` 行，run 结束 H3 清理后消失。
- [ ] `webHub.spawn` 托管的 RPC 会话（无 HUD）同样显示面板，current 行正确（验证 `/proc/self/fd` 启动路径下的 cwd 规范化）。
- [ ] 符号链接进入的 cwd 下 current 行正确；非 git 目录 ⇒ 无面板；`hud.enabled=false` 时 TUI 会话仍显示面板。
- [ ] 手机宽度（≤480px）折叠/展开布局正常。
- [ ] 采样期间在终端执行 `git commit` 不出现 `index.lock` 冲突。

## 10. 用户拍板项（已全部决议，见文末）

| #   | 问题                              | 决议                       | 理由（摘要）                                                                                    |
| --- | --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| Q1  | wire 是否带绝对 `path`            | **带**（预算紧时先削）     | tooltip/复制/后续 preview 需要；风险由用户接受，口径见 §6（r1 #5 已如实改写为「新增资产类别」） |
| Q2  | 只有 1 个 worktree 时是否显示面板 | **显示**                   | web 上无别处展示分支/dirty/↑↓                                                                   |
| Q3  | 是否新增开关 `webHub.worktrees`   | **不加**                   | `webHub.enabled` 默认关已是门；成本有界                                                         |
| Q4  | 嵌套 schema 开放还是 closed       | **开放**（已知字段带上限） | 校验失败丢整帧；hub 替换窗口内新 agent 连旧 hub；r1 #6 补字段级上限与跨版本 fixture             |
| Q5  | web 侧是否周期 fetch              | **不 fetch**               | 网络/凭据副作用；TUI 下 HUD 已 fetch                                                            |
| Q6  | HUD 是否同期迁移到共享模块        | **不同期**，W6 后续        | 本功能 HUD 零回归                                                                               |

## 11. v2 展望（不承诺）

- 点击行 → 复制路径（`CopyButton.vue`）/ 当 worktree 位于 `session.cwd` 子树时接 `PathText`/preview。
- `pi-agent-*` 行关联 fleet 抽屉对应 run（`agentRunId` ↔ `safeRunId(runId)` 映射）。
- AgentCard 徽标（`⎇3 *1`）——待删除会话线（AgentCard.vue）合入后再做。
- 写路径（prune / remove worktree）：控制平面新 op + caps 门控，单独评审。
- `git worktree list -z`（git ≥2.36 探测 + 回退）支持换行路径。
- HUD 与 web 采集去重（W6 之后可共享同一 sampler 结果）。

## 12. r1 评审处置

评审：`review:worktree-web`（gpt-5.6-sol，r1：0 Blocker / 5 Major / 3 Minor）；裁定：主会话。

| #   | 级别  | 问题                                                                                               | 裁定                  | 处置（本版落点）                                                                                                                                                                                                                                                                                                                                  |
| --- | ----- | -------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Major | 8s 硬 deadline 不成立：`pi.exec` abort 只发 SIGTERM，最多再等 5s 才 SIGKILL，且 promise 等 `close` | 必须修                | 两层都改：采集层弃用 `pi.exec`，自建 `src/git/run.ts`（独立进程组 + 立即 SIGKILL + 同步 settle，§4.1）；sampler 外层 `Promise.race` 独立硬 deadline，到期立即 `error`、释放单飞锁，迟到结果按 sampleId/generation 丢弃，僵尸防护（§4.3）。★ 测试：忽略 SIGTERM 脚本 + 孙进程持管道（执行器）、runner 永不 resolve + 真实计时（sampler）（§7、§9） |
| 2   | Major | git stdout 无上限；`--untracked-files=normal` 可枚举海量 untracked                                 | 必须修                | 执行器字节上限（rev-parse 4K / list 256K / status 64K / stderr 8K），超限击杀；流式截断后头部照常解析，`dirtyCapped` ⇒ `*N+`（绝不报 clean/伪精确）；超时降级 `-uno`（`untrackedSkipped` ⇒ `*N~`）；再超时 `unprobed:"timeout"` ⇒ `?`；`listCapped`；降级口径写入 §4.1。★ 测试：10 MiB 输出、3000 untracked 真实仓库（§7）                        |
| 3   | Major | current 判定靠字符串相等                                                                           | 必须修                | cwd/toplevel/worktree 路径统一 realpath，失败退回原字符串；无匹配 ⇒ 无 current 行、不按前缀猜；`/proc/*/fd/` cwd fail-closed + 论证（pi cwd 来自 `getcwd()`，`main.js:464`；托管 `chdir` 后亦为规范路径）（§1.3、§4.1 第 1/3 步）。测试：真实仓库符号链接 cwd + 嵌套 worktree；realpath 缝单测覆盖 `/proc` 别名等价（§7）                         |
| 4   | Major | 退避到 5min 与「≤30s」验收矛盾                                                                     | 保留退避 + 显示 stale | 新增 `sampledAt` + agent 侧 `staleMin`（>90s 才出现，规避浏览器时钟偏差）；UI `·stale Nm` 与 `last sample HH:MM`；指纹含分钟桶/staleMin；`tick()` 每分钟至多 1 帧（§3.1、§4.3、§5、D6）。验收改为「正常仓库 ≤30s；慢仓库按退避上限并显示 stale」（§9）                                                                                            |
| 5   | Major | 广播所有 sibling worktree 绝对路径扩大暴露面                                                       | 不改设计、如实写明    | §0/§1.4/§6 改为「新增资产类别：同仓库所有 worktree 绝对路径；风险由用户接受（2026-10-06 ask_user Q1；与 preview U1 同一裁定基础）」，并写明 LAN 出现他人时的重评路径                                                                                                                                                                              |
| 6   | Minor | 开放 schema 无大小约束                                                                             | 修                    | 对象保持开放，已知字段加 `maxLength`/`maxItems`/`minimum`（宽于投影口径），`unprobed` 用有长度上限的开放字符串；hub 内存透传不落盘；属性测试保证投影恒合 schema；新增跨版本 fixture 测试五组合（§3.2、§7）                                                                                                                                        |
| 7   | Minor | web-hub 依赖 `src/hud/format.ts`                                                                   | 修                    | 复制为 `src/git/path-label.ts` 的 `abbreviateHome`，HUD 原样不动，W6 去重（§4.1、§8）                                                                                                                                                                                                                                                             |
| 8   | Minor | 测试过度依赖 fake exec                                                                             | 修                    | 新增 `tests/integration/git-worktrees.test.ts` 真实 git（locked/prunable/bare/删除重建/符号链接/嵌套/upstream/untracked 超限/index.lock），换行路径 `it.skip` 并注明；执行器测试用真实进程；硬 deadline 与输出上限列为 ★ 合入门槛（§7、§9）                                                                                                       |

---

## 用户拍板（2026-10-06，主会话 ask_user 记录）

Q1 下发绝对路径（预算紧时第一个被削）；Q2 只有 1 个 worktree 也显示；Q3 不加 `webHub.worktrees` 开关；
Q4 嵌套 schema 开放；Q5 web 侧不 fetch；Q6 HUD 迁共享模块放后续 W6。——全部采纳推荐。

---

## 修订注记 · worktree-diff（2026-10-08，D6 落地）

本面板（W1–W4 的只读 worktree 摘要）后来成为 worktree-diff 功能的入口面：行内 `*N` dirty token
升级为可展开按钮（`rowDiffable` + wtdiff scope），点击经 `/api/worktree-diff/{files,file}` 拉取并
渲染文件清单与单文件 diff。**D15 条件接受已闭合**：hub 执行 git 由主会话裁定「条件接受，H1–H5 为
D3 合入闸门」——H1（驱动中和三层）/H2（环境 allowlist）/H3（三 fd 钉住）/H4（无 index 写入）/H5
（预算总账）已全部落地并绿；端点层的驱动场景复跑、任意历史读取、hub close 残留探测见
`tests/integration/web-hub-worktree-diff.test.ts`。新增资产类别按附录 A1 拍板：**LAN（`mode:"on"`）
与 loopback 同宽**——LAN 上额外流出的只有「当前变更集中已修改文件在本请求解析的 HEAD 里的版本
（±3 行上下文）」与「已删除文件在该 HEAD 的全文」，任何更早历史、任何不在变更集中的路径、任何
denylist 命中项都不可达。设计全文与决策日志：`docs/dev/worktree-diff/plan.md`（含 §9.3 修订记录）。
