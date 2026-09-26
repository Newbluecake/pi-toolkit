# workflow isolation 调用的「校验分支后回放」（todo #13，选项 C，L2）— 方案 v2.1

> 状态：v2.1。v2 复审「有条件通过」，3 条条件的处置见文末「v2→v2.1 处置」。v1（`25980d3`）评审打回 7 条（严重 3、一般 4），本版逐条处置，见文末「v1→v2 评审处置」。文末「用户确认（2026-09-26）」的四条决定**原样保留、不变**。前置：`docs/dev/workflow-worktree/plan.md` v2.1 已全部实施（§0 决定 4 选了回放方案 A，并把「校验分支后回放」另记 todo，也就是本方案）。
> 本方案只包含本文件。实现按 §5 的两个包**串行**进行，并且与 child-context-switch 的合入顺序按 §5.2 约定。

## 0. 结论速览

1. **H3 记录 commit sha**：`committed` disposition 新增 `commit`（40/64 位 hex），透传到 `ChildWorktreeInfo`。dirty 路径调整 git 命令顺序，让「报告前最多 5 条命令」不变，`late` 时域的推导（5×reapMs+1s）仍然成立。**这是 live 结果形状的新增键，与开关无关**（D1.3）。
2. **隔离调用写 journal**：只有 `status:"completed"`，并且 settle 时 disposition 为 `committed`（带 branch 和 commit）或 `clean` 的调用才写。条目新增可选字段 `worktree: { state, branch?, commit?, isoId }`。`kept`、`pending`、`none`、晚到的 disposition、缺 sha 的 `committed` 一律不写。
3. **校验时机是 journal 加载时的快照**：`buildJournalConfig` 在 boot 之前，于本次 run **钉住的 cwd**（D4.1）执行**一条**可中止的 `git for-each-ref`，得到「已校验通过的条目 digest 集合」，`decideReplay` 保持同步。探测失败、超时或端口缺失时集合为空，所有需要校验的条目都走 live（fail-closed）。run 结束时再做一次有界复核，**只做诊断**，把快照之后被删除或移动的分支标出来（D4.4）。
4. **判定规则**：`committed` 条目要求 `refs/heads/<branch>` 在快照时刻存在，并且**精确指向**记录的 commit（用户确认 2）。`clean` 条目不跑 git：与普通 `agent()` 调用的回放一样，**不校验仓库状态**，这是 journal 的既有语义（D3.1，附证据）。
5. **下游链规则**：chain scope 下，accepted 的隔离调用不再给下游染色，改为把它的结果身份 `isoId` 折叠进链摘要（用户确认 4）。v2 给出同步伪代码、插入点和七条不变量（D6）。content scope 保留染色。
6. **设置** `workflow.isolationReplay: "verify" | "off"`，默认 `verify`（用户确认 1）。**off 的保证收窄为「回放语义与方案 A 逐字节一致」**：判定、journal 读写、链摘要序列、染色、探测次数都不变。live 结果里新增的 `commit` 键不在这项保证之内，由 `Object.keys` 回归测试钉住（D9）。

## 1. 现状证据

| 位置                                                                                            | 事实                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dev/workflow-worktree/plan.md:11`、`:84-88`（§0 决定 4、D3）                              | 方案 A：带 isolation 的调用，以及其后提交的调用，都不读也不写 journal；`journal.ts` 不改，taskKey 仍含 `isolation`。                                                                                                                                                                                                        |
| `docs/dev/workflow-experts/plan.md:68`、`:70`（D13、D15）                                       | experts 的 chain-taint 用独立标记，**明确否决**「把不可复现标记混进 chain digest」，理由是会静默变成 miss，并且把条目写到随机链下面成为 journal 垃圾。本方案的 `isoId` 折叠与此不同，见 D6.5。                                                                                                                              |
| `src/workflow/replay.ts:147-155`                                                                | 判定顺序：`experts` → `tainted`（`chain_tainted`）→ `isolation`（`skip:isolation_worktree`），三者都在 `index.lookup` **之前**。                                                                                                                                                                                            |
| `src/workflow/replay.ts:164`                                                                    | 旧条目（D3 之前落盘，带 `isolation:"worktree"`）在 lookup 之后仍会被 RP7 否决。                                                                                                                                                                                                                                             |
| `src/workflow/replay.ts:14-22`                                                                  | 模块注释：RP10/RP11（MCP 工具集哈希、content scope 风险横幅）是 genuine gap。回放**没有**任何仓库状态相关的 RP。                                                                                                                                                                                                            |
| `src/workflow/replay.ts:52-73`                                                                  | `buildReplayIndex`：chain scope 的键是 `nextChainDigest(entry.chainDigestBefore, entry.key)`；同一个 `(键, occurrence)` 只保留 `completedAt` 最大的一条。                                                                                                                                                                   |
| `src/workflow/types.ts:98-115`、`:116-133`                                                      | `TaskSemantics` 的注释写明 `effort/tools/cwd/schema/gate` 不在键里；键只有 agentType、configHash、prompt、model、thinking、isolation、workflowArgs，**没有 cwd、HEAD 或任何仓库状态**。                                                                                                                                     |
| `src/workflow/types.ts:139-159`                                                                 | `JournalEntry` 没有任何仓库或 worktree 字段。                                                                                                                                                                                                                                                                               |
| `src/tools/workflow-tool.ts:97-116`                                                             | 参数描述：journal 是「replay/caching across runs」；chain scope 只针对**同一次运行内**兄弟调用之间的隐式文件系统因果；content scope 会 WARN。两者都不承诺跨运行的仓库状态一致。                                                                                                                                             |
| `src/workflow/orchestrator.ts:551-565`                                                          | content scope 的 WARN 文案：「can reuse a result even when a prior sibling call in this run changed the workspace」，说的也是运行内的因果。                                                                                                                                                                                 |
| `src/workflow/orchestrator.ts:542-550`                                                          | `buildJournalConfig` 在 boot **之前**被 await，是唯一「脚本开跑之前、可以 await」的位置。注释写明 `store.load()` **有意不设 deadline**（既有简化）。                                                                                                                                                                        |
| `src/workflow/orchestrator.ts:805-816`、`:838`                                                  | 终态流程：先 `flushJournal(journalFlushMs ?? 2_000)`（有界），再 terminate worker，最后在 `:838` 读取 `hostHandler.children`。                                                                                                                                                                                              |
| `src/workflow/journal.ts:73-85`                                                                 | `taskKeyOf` 已经包含 `isolation`，隔离调用的 taskKey 与同 prompt 的普通调用不同。                                                                                                                                                                                                                                           |
| `src/workflow/journal.ts:88-90`                                                                 | `nextChainDigest(before, taskKey) = sha256(before + ":" + taskKey)`，链摘要唯一的计算入口。                                                                                                                                                                                                                                 |
| `src/workflow/journal.ts:104-127`                                                               | `buildEntry` 已有 `isolation?` 参数，但写入点没有传它（D3 之后隔离调用根本不写）。                                                                                                                                                                                                                                          |
| `src/workflow/journal.ts:136-174`                                                               | `parseEntry` 是**白名单重建 + digest 复算**：未知字段不参与复算 ⇒ digest 不符 ⇒ corrupt 行。                                                                                                                                                                                                                                |
| `src/workflow/host.ts:446-452`                                                                  | 每个 run 一条 `chainDigest`；`journalMetaOf` 只存 `taskKey / chainDigestBefore / occurrence / agentType`。                                                                                                                                                                                                                  |
| `src/workflow/host.ts:833-868`                                                                  | journal 块：先算 taskKey 和 occurrence，然后**无条件**推进链（`:868`），再调用 `decideReplay`（`:870`）。                                                                                                                                                                                                                   |
| `src/workflow/host.ts:893-930`                                                                  | 命中路径：`recordSettled({source:"replay"})`，`host_settle` 只带 `value`；然后提前 return，**不经过** D2 门（`:985`）。                                                                                                                                                                                                     |
| `src/workflow/host.ts:942-949`                                                                  | `!declaresExperts && !replayTainted && isolation === undefined` 时才写 `journalMetaOf`。                                                                                                                                                                                                                                    |
| `src/workflow/host.ts:958-976`                                                                  | maxChildren、BW2 拒绝时执行 `journalMetaOf.delete`。                                                                                                                                                                                                                                                                        |
| `src/workflow/host.ts:985-998`                                                                  | D2 门；门通过后 `replayTainted = true`。                                                                                                                                                                                                                                                                                    |
| `src/workflow/host.ts:1005-1022`                                                                | experts 解析：失败 ⇒ `experts_unresolved` ack 失败；成功 ⇒ `replayTainted = true`。                                                                                                                                                                                                                                         |
| `src/workflow/host.ts:1026-1071`                                                                | 构造 `QueuedAgentCall`；满载 ⇒ 入队（ack `queued:true`，同步返回）。                                                                                                                                                                                                                                                        |
| `src/workflow/host.ts:1073-1078`                                                                | 立即派发：`await deps.spawner.spawn(...)`，这是 handleAgent 里**第一个** await。从 journal 块到这里都是同步段。                                                                                                                                                                                                             |
| `src/workflow/host.ts:1079-1103`                                                                | spawn error ⇒ `withheld` + ack 失败（异步，发生在同步段之后）。                                                                                                                                                                                                                                                             |
| `src/workflow/host.ts:1274-1291`                                                                | 只有 `outcome.status === "completed"` 且 `journalMetaOf` 有记录时才 `append`（RP3）。                                                                                                                                                                                                                                       |
| `src/workflow/host.ts:1324-1340`                                                                | 隔离调用在 `onOutcome` 之前先等 settle 时域的 disposition，拿不到就是 `pending`。写 journal 时 `wt` 已经可用。                                                                                                                                                                                                              |
| `src/workflow/host.ts:1159-1178`                                                                | `spawnRequestFor` 不带 `cwd`，只转发 `isolation`。                                                                                                                                                                                                                                                                          |
| `src/workflow/host.ts:710-728`                                                                  | `forceSettleActive`：`aborted` + `worktree:{state:"pending"}`，不写 journal。                                                                                                                                                                                                                                               |
| `src/workflow/types.ts:233-237`                                                                 | `ChildWorktreeInfo = { state; branch?; path? }`，没有 sha。                                                                                                                                                                                                                                                                 |
| `src/core/types.ts:376-385`                                                                     | `WorktreeDisposition` 和 `WorktreeDisposal` 没有 sha。                                                                                                                                                                                                                                                                      |
| `src/extensions/worktree.ts:265`                                                                | H2：`cwd = resolve(spec.cwd ?? request.cwd ?? process.cwd())`，然后 `rev-parse --show-toplevel`。                                                                                                                                                                                                                           |
| `src/service/spawn-service.ts:340`                                                              | `SpawnRequest.cwd` ⇒ `spec.cwd`。workflow 不传，所以 H2 用的是**每个子 run 创建时**的 `process.cwd()`。                                                                                                                                                                                                                     |
| `src/extensions/worktree.ts:404-445`                                                            | H3：`rev-parse HEAD` → `status`；clean 且 HEAD 前进 ⇒ `branch <b> HEAD`；clean 且 HEAD 没变 ⇒ `clean`；dirty ⇒ `switch -c` → `add -A` → `commit`；失败 ⇒ `kept`。**报告时没有 sha**；dirty 路径报告前 5 条命令。这里的 `baseHead` 比较是**单次运行内**的数据丢失防护（判断子 agent 有没有自己提交），不是跨运行的仓库校验。 |
| `src/service/spawn-service.ts:205-206`                                                          | `settle = reapMs + 1s`，`late = 5 × reapMs + 1s`。                                                                                                                                                                                                                                                                          |
| `src/service/spawn-service.ts:738-747`、`:755-770`                                              | mark 和 wait 逐字段复制 `state/branch/path`。                                                                                                                                                                                                                                                                               |
| `src/service/runtime-adapter.ts:373-386`                                                        | stack 已 dispose 时，晚到 disposition 逐字段复制进 durable sink（只用于展示和 run log，从不进 journal）。                                                                                                                                                                                                                   |
| `src/workflow/spawner-adapter.ts:62-98`、`:153-168`                                             | spawn 逐字段转发（没有 cwd）；`awaitWorktree` 逐字段映射。                                                                                                                                                                                                                                                                  |
| `src/workflow/worker-source.ts:367-374`                                                         | `fullResult = { text, runId: runId \|\| null, label: label \|\| null }`，settle 带 worktree 时多一个 `worktree` 键，内容原样透传。                                                                                                                                                                                          |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:304-306`           | `pi.exec` 不传 cwd 时默认用的是扩展加载时的会话 cwd，**不是** `process.cwd()`。                                                                                                                                                                                                                                             |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js:10-80`                          | `execCommand`：`signal` 中止或 `timeout` 到期 ⇒ SIGTERM，5 秒后 SIGKILL；Promise 在子进程退出后**只 resolve 一次**，永不 reject。                                                                                                                                                                                           |
| `src/tools/workflow-tool.ts:78-79`、`:318-331`、`:404`                                          | 工具描述中「never journaled or replayed」；`worktreeLineFor` 的 expected branch 用 `c.runId ?? c.callId`（回放调用会拼错）；`replay:` 统计行。                                                                                                                                                                              |
| `src/config/settings.ts:89-98`、`:543-549`、`:1411-1440`；`src/config/setting-specs.ts:408-416` | `WorkflowSettings`、默认值、逐字段 parse、`/agent settings` 的 spec。                                                                                                                                                                                                                                                       |
| `src/stack.ts:2201-2211`                                                                        | `createWorkflowChildSpawner(spawn, types, { resolveExperts, worktreeAvailable })` 与 `workflowJournalRootDir`：新端口在这里接入。                                                                                                                                                                                           |
| `docs/dev/child-context-switch/plan.md` §7                                                      | 在途方案：P0 已合入（`e7775ff`，`core/types.ts` 等）；P1 改 `settings.ts`；P2 改 `settings.ts` 以及 `stack.ts` 的 compact-hint 区（`:668-700`、`:838` 附近）；P3 改 `runtime-adapter.ts`、`index.ts`、`tool-scope.ts` 等。                                                                                                  |

## 2. 设计

### D1 H3 产出 commit sha（P1）

1. **类型**：`WorktreeDisposal` 和 `WorktreeDisposition` 增加 `commit?: string`，只在 `committed` 时填写；`ChildWorktreeInfo` 增加 `commit?`。
2. **`worktree.ts` 的 `beforeReap` 调整命令顺序**：
   - 先 `status`。
   - clean ⇒ `rev-parse HEAD` 并与 `baseHead` 比较（数据丢失修复的判定不变）。HEAD 前进 ⇒ `branch <b> HEAD`，`commit = currentHead`；没变 ⇒ `clean`。rev-parse 失败 ⇒ `kept`（与现状相同）。
   - dirty ⇒ `switch -c` → `add` → `commit` → `rev-parse HEAD`。**最后这条 rev-parse 失败不降级为 `kept`**：照样报告 `committed`，只是不带 `commit`（不写 journal，见 D3）。
   - 报告前的命令数：clean 路径最多 3 条，dirty 路径 5 条，所以 `late = 5×reapMs+1s` 与 D5a 的 tombstone **都不改**。
3. **wire 形状与开关的关系（评审 #1 的选择：收窄 off 的保证，不按开关隐藏）**：
   - live settle 的 `fullResult.worktree` 在 `committed` 时多一个 `commit` 键，**不论开关取值**。顶层键集合不变（非隔离调用仍然严格等于 `["text","runId","label"]`）。
   - 理由：
     - ① `commit` 是 H3 disposition 的事实，由 spawn-service、runtime-adapter 这一层产出，它们不知道 workflow 的回放开关。按开关隐藏只能在 host settle 时再剥掉一次，结果是 live 结果的形状取决于一个回放设置，耦合方向不对。
     - ② 调度方按 sha 合并可以免疫分支之后被移动（D4.4 的 TOCTOU 论证依赖这一点），这个价值在 off 下同样成立。
     - ③ 这是对象内部的新增键，已有脚本只读 `state/branch/path`，不会被破坏。
   - outcome 文本（worktrees 段）的 live 行**不渲染** sha，所以 off 下 outcome 文本逐字节不变；只有回放行（off 下不存在）会出现 `@sha7`。
   - 回归测试见 §6 第 6 条。
4. **透传点**：`spawn-service.ts`（mark、wait）、`spawner-adapter.ts`（`awaitWorktree`）。**v2 不再改** `runtime-adapter.ts` 的晚到 sink 和 `worktree-disposition-sink.ts`：晚到的 disposition 从不进 journal，只用于展示和 run log，不需要 sha。这样 P1 与 child-context-switch P3 的 `runtime-adapter.ts` 冲突也就消失了（§5.2）。

### D2 journal 条目新增字段与兼容（P2）

```ts
// src/workflow/types.ts
interface JournalEntry {
  …
  readonly isolation?: "worktree";
  /** 选项 C：只出现在 isolation:"worktree" 的条目上。 */
  readonly worktree?:
    | { readonly state: "committed"; readonly branch: string; readonly commit: string; readonly isoId: string }
    | { readonly state: "clean"; readonly isoId: string };
}
```

- `buildEntry` 和 `parseEntry` 都按白名单处理 `worktree`，并纳入 digest。`parseEntry` 的形状校验：
  - `worktree` 只能在 `isolation === "worktree"` 时出现；
  - `state ∈ {committed, clean}`，未知 state 视为 corrupt；
  - `branch` 必须匹配 `/^pi-agent-[A-Za-z0-9._-]{1,200}$/`；
  - `commit` 必须匹配 `/^[0-9a-f]{40}$|^[0-9a-f]{64}$/`；
  - `isoId` 必须匹配 `/^[0-9a-f]{32}$/`；
  - 有多余的键 ⇒ corrupt。
- `v` 保持为 1：非隔离条目逐字节不变。
- **兼容矩阵**：
  - 新代码读旧条目：非隔离条目行为不变；带 `isolation` 但没有 `worktree` 的旧条目继续 `skip:isolation_worktree`。
  - 旧代码读新条目：digest 不符 ⇒ corrupt 行，永不回放（fail-closed）。
  - 升级后已有命中不受影响：方案 A 从未写过隔离调用之后的条目，`isoId` 折叠只影响隔离调用之后的链。

### D3 各 disposition 是否可以回放

写入条件（在 `onOutcome` 里判断，这时 `wt` 已经确定）：`outcome.status === "completed"` **并且** `wt` 满足下表的「写」。

| settle 时的 disposition                                                | 写 journal         | 回放条件                                      | 理由                                        |
| ---------------------------------------------------------------------- | ------------------ | --------------------------------------------- | ------------------------------------------- |
| `committed` + `branch` + `commit`                                      | 写                 | 快照时刻分支存在，并且精确指向 `commit`（D4） | 副作用完全落在一个可寻址、可校验的 ref 上。 |
| `committed`，缺 `commit`                                               | 不写               | —                                             | 没有校验依据。                              |
| `clean`                                                                | 写                 | 不跑 git，只受 TTL、truncated 和 D2 门约束    | 见 D3.1：与普通调用回放同等语义。           |
| `kept`                                                                 | 不写               | —                                             | 改动不在任何 ref 上。                       |
| `pending`                                                              | 不写               | —                                             | 写入时不知道结果。                          |
| `completed` + `pending`，之后晚到 `committed`                          | 不写（用户确认 3） | —                                             | 脚本当时看到的是 `pending`。                |
| `aborted`/`failed`/`timed_out`（包括 force-settle 后晚到 `committed`） | 不写               | —                                             | RP3。                                       |
| `none`                                                                 | 不写               | —                                             | 无法证明隔离发生过。                        |
| 未知 state                                                             | 不写（白名单）     | parse 时视为 corrupt                          | fail-closed。                               |

#### D3.1 `clean` 不校验 HEAD：论证与结论（评审 #2）

问题是：普通（非隔离）`agent()` 调用的 journal 回放本身校验仓库状态吗？逐项核对：

1. **键**：`taskKeyOf`（`journal.ts:73-85`）和 `TaskSemantics`（`types.ts:98-133`）里没有 cwd、HEAD、工作区哈希；注释明确写了 `cwd` 不在键里。
2. **条目**：`JournalEntry`（`types.ts:139-159`）没有任何仓库字段，无从比较。
3. **判定**：`decideReplay`（`replay.ts:141-175`）的 RP 门里没有仓库检查；模块注释（`replay.ts:14-22`）列出的已知缺口是 RP10/RP11，也与仓库无关。
4. **文档**：工具描述（`workflow-tool.ts:97-116`）和 orchestrator 的 WARN（`orchestrator.ts:551-565`）只把 chain scope 定义为「同一次运行内兄弟调用之间的隐式因果」，没有承诺跨运行的仓库一致；`workflow-background/plan.md:167` 保持 schema 不变。
5. **H3 的 `baseHead` 比较**（`worktree.ts:404-420`）只是单次运行内的数据丢失防护（子 agent 有没有自己提交），与跨运行回放无关。

**结论**：普通调用回放不看仓库状态，这是 journal 的既有语义。`clean` 隔离调用只是在一个与主 checkout 同 HEAD 的副本里跑，没有留下任何被跟踪的改动，它依赖源码版本的程度与一个在主 checkout 里跑的只读普通调用相同，所以按同等语义处理：**不记录、也不校验 base HEAD**。这一点写进工具描述和 AGENTS.md：「journal replay never checks repository state; isolated calls only additionally verify their own pi-agent branch」。

- `committed` 的分支校验保护的是**这次调用自己的副作用**（它产出的分支），不是「源码版本」，二者不矛盾。
- 如果以后要给 journal 加「源码版本」维度，应该对所有调用统一加（例如把 HEAD 并入 `TaskSemantics`），不应只给 `clean` 隔离调用加。这列为非目标。

### D4 校验方法（P2）

#### D4.1 钉住的 cwd（评审 #4）

- 每个 workflow run 启动时捕获一次 `isolationCwd = resolve(deps.isolationCwd?.() ?? process.cwd())`，放进 `JournalRunConfig.isolationReplay.cwd`。stack 把 `isolationCwd` 接成 `() => process.cwd()`，这正是 H2 在不传 cwd 时的回落基准（`worktree.ts:265`）。**不用 `pi.exec` 的默认 cwd**：那是扩展加载时的会话 cwd，可能与 H2 不同（`loader.js:304-306`）。
- **verify 模式下**，隔离调用的 spawn 请求显式带 `cwd: isolationCwd`：`ChildSpawner.spawn` 请求增加 `cwd?`，`spawnRequestFor` 只在 `call.isolation && isolationReplay` 时设置，`spawner-adapter` 转发给 `SpawnRequest.cwd`，再经 `spawn-service.ts:340` 成为 `spec.cwd`，H2 就用它。这样探测、H2、终态复核三处用的是同一个 cwd，即使 run 中途 `process.chdir` 也一样。
  - 对 H2 来说只有它所在的仓库有意义（worktree 由它自己生成路径，session cwd 会被 H2 改写为 worktree）；D10 consult 的 `preH2Cwd` 取同一个值。
  - off 模式和非隔离调用的 spawn 请求**逐字节不变**（不带 cwd），保住 off 的保证。
- 探测只需要 cwd，不需要 toplevel：`for-each-ref` 在子目录里也能工作。换一个 clone 运行时，探测在那个 clone 里执行 ⇒ 分支不存在 ⇒ live。

#### D4.2 加载时探测（快照）

1. `buildReplayIndex` 额外暴露 `isolatedCandidates()`：去重**之后**仍然有效、`worktree.state === "committed"`、没有 truncated、在 TTL 内的条目。
2. 以下任一条件成立时**不探测**，零 git 调用：`isolationReplay !== "verify"`、`noReplay`、候选为空、`spawner.worktreeAvailable?.() !== true`。
3. 否则取去重后的 branch，最多 256 个，超出部分记为不通过。调用 `spawner.probeAgentBranches(branches, { cwd, timeoutMs, signal })`，stack 把它接成：
   `pi.exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", ...branches.map(b => "refs/heads/" + b)], { cwd, timeout: timeoutMs, signal })`
   - 分支名已经过 D2 的正则校验。非 0 退出或 `killed:true` ⇒ 探测错误。
   - 只认**完全相等**的 refname；解析上限 1 MiB 或 4096 行。
4. 条目通过的条件：`tips.get("refs/heads/" + branch) === entry.commit`。通过的条目 digest 放入 `verified`。

#### D4.3 可中止与零 hang（评审 #5）

- `isolation-verify.ts#runBoundedProbe(probe, { timeoutMs, clock })`：
  - 创建 `AbortController`，用 `clock.setTimer(timeoutMs)` 触发 `abort()`，同时把 `timeoutMs` 交给 exec 的 `timeout`（双重杀进程）。
  - 外层 `withDeadline(timeoutMs + 500)` 保证即使端口不遵守 signal 和 timeout 也能按时返回。
  - **单次结算**：一个 `settled` 标记，先到者生效；晚到的 resolve 或 reject 被吞掉（reject 还要 `.catch` 防止 unhandled），不会产生第二次回调或第二次写 `verified`。
  - 返回后清掉 timer，`vi.getTimerCount()` 回到基线。
- `timeoutMs = min(settings.worktree.gitTimeoutMs, 5_000)`。
- **保证的是「workflow 不 hang」，不是「返回时进程已清理」**：
  - `runBoundedProbe` 在约 `timeoutMs + 500`（最多约 5.5 秒）时一定返回，这与子进程是否已经退出无关。
  - 子进程的回收由 `pi.exec` 自己负责（`exec.js:21-31`）：abort 或 timeout 时先发 SIGTERM，如果进程不响应，**再等 5 秒**才发 SIGKILL；而 `exec.js:43-46` 的 Promise 要等进程真正退出才 resolve。所以一个不理会 SIGTERM 的 git，最坏会在 probe 返回之后再存活约 5 秒，然后被 SIGKILL 回收；它那次晚到的 resolve 被单次结算吞掉。
  - pi 那个 5 秒的 SIGKILL timer 是 ref 的，属于 pi 自身的代码；workflow 只在主会话运行（非 print 模式），不会因此卡住 `pi -p`，列入 §7。
- 失败、超时、端口缺失（老的或假的 spawner）⇒ `verified` 为空，记录 `probeError`，**workflow 照常启动**，候选按 `worktree_unverified` 走 live。
- **范围收窄：本方案只保证「新增的 probe 不 hang」**。它**不**保证带 journal 的 workflow 启动整体有界：probe 之前的 `store.load()` 没有时间上限（既有简化，`orchestrator.ts:542-548` 注释写明有意如此），由已立的 **todo #21「workflow journal.load() 加硬时间上限」** 处理，本方案不改动它，也不依赖它。

#### D4.4 保证语义：加载时快照 + 终态诊断（评审 #6）

- **保证**：一个 `committed` 条目回放命中，当且仅当它在本次 run 的**加载快照**里通过了精确 sha 校验。用户确认 2 的口径（只认分支精确指向记录的 sha，其他情况重跑）定义的是**判据**；判据在快照时刻评估一次，整个 run 内保持一致。于是同一次 run 里，隔离调用和它的下游看到的是同一个世界，这正是 D6 链一致性需要的。
- 为什么不在命中前轻量复核：
  - 复核需要 await git，而命中路径和 `isoId` 折叠必须在 handleAgent 的同步段里完成（D6 不变量 I2）。
  - 把命中改成异步，要么打乱后续提交读取链摘要的顺序，要么需要重排整个提交队列，与 workflow-agent-queue 的「按到达顺序分配 occurrence 和链摘要」冲突。
  - 否决。
- **TOCTOU 的实际影响有限**：
  - 命中返回给脚本的是 `commit`（D7），调度方按 sha 合并时，结果与分支之后是否被移动无关（只要对象还在，而一个刚在快照里存在过的 commit 不会立刻被 gc）；
  - 分支名只是便利信息。
- **终态诊断**：run 进入终态时，如果本次有 ≥1 个 `committed` 回放命中，就在 `orchestrator.ts:811` 的 `flushJournal` 旁边**并行**执行一次 `hostHandler.recheckReplayedIsolation(deadline)`：
  - 同一个 cwd、同一个 `runBoundedProbe`，上限为 `min(2_000, journalFlushMs ?? 2_000)`，与 flush 并行，因此不增加终态延迟；
  - 发现分支消失或移动的，给对应 child summary 加上 `replayStale: "gone" | "moved"`（`:838` 读取 children 之前已经写好）；
  - outcome 行渲染为 `(replayed @abc1234, branch gone)` 或 `(replayed @abc1234, branch moved)`，统计 `replay.isolation.stale`；
  - 复核失败或超时 ⇒ 不标注（未知），也不 hang。
  - 只做诊断，从不改变已经发出的结果。

### D5 判定顺序（`decideReplay`）

新的输入字段：`isolationReplay?: "verify"`（缺省即 off）、`isolationVerified?: (entry) => boolean`。

`noReplay` → `deterministic` → `experts` → `tainted` → **`isolation && mode off` ⇒ `skip:isolation_worktree`**（与现状相同）→ `configHashAvailable` → lookup → miss → **隔离条目检查**：

- 没有 `worktree` 的旧条目 ⇒ `skip:isolation_worktree`；
- mode off ⇒ `skip:isolation_worktree`；

→ `truncated` → TTL → **`committed` 且没通过校验 ⇒ `skip:worktree_unverified`** → hit。`clean` 条目在 TTL 之后直接 hit。

### D6 下游链规则：`isoId` 折叠（评审 #3）

#### D6.1 术语

- **lookup 键**：`chainKey = nextChainDigest(chainDigestBefore, taskKey)`，其中 `chainDigestBefore` 是本调用进入 journal 块时的 `chainDigest`，**不含本调用自己的折叠**。
- **accepted 的隔离调用**：带 `isolation`、处于 chain scope、verify 模式，并且满足下面二者之一：
  - (a) 命中路径真正返回了 hit；
  - (b) 同步通过了全部准入：maxChildren、BW2、D2、experts 解析，然后入队（ack `queued:true`）或进入立即派发的 `await spawn` 之前。
- **折叠**：`chainDigest = nextChainDigest(chainDigest, "iso:" + isoId)`。

#### D6.2 同步伪代码（对照 `host.ts` 现有行号）

```ts
// —— journal 块 host.ts:833-949 ——（同步段开始）
const verify = journal.isolationReplay?.mode === "verify";           // 新
const foldable = isolation !== undefined && verify && journal.scope === "chain"; // 新
const chainDigestBefore = chainDigest;                               // :863 不变
const chainKey = nextChainDigest(chainDigestBefore, taskKey);        // 新：显式命名，即 lookup 键
const kForOccurrence = journal.scope === "content" ? taskKey : chainKey; // :864 不变（值相同）
const occurrence = occCounters.get(kForOccurrence) ?? 0; occCounters.set(…, occurrence + 1); // :865-866 不变
chainDigest = chainKey;                                              // :868 不变（§6.2 step 5，未折叠）
const decision = decideReplay({ …, isolation: isolation !== undefined,
  ...(verify ? { isolationReplay: "verify", isolationVerified: (e) => journal.isolationReplay!.verified.has(e.digest) } : {}) }); // :870

if (decision.kind === "hit") {                                       // :893
  const isoHitBlocked = isolation !== undefined && deps.spawner.worktreeAvailable?.() !== true; // 新（D7）
  if (!isoHitBlocked) {
    if (foldable) chainDigest = nextChainDigest(chainDigest, "iso:" + decision.entry.worktree!.isoId); // 新 F1：命中折叠用 entry.isoId
    … 原命中体（:894-930），settle 与 recordSettled 额外带 worktree（D7）…
    return ack;
  }
  // 被阻止的隔离命中：不折叠，按 skipped 计数，继续往下走，由 D2 门拒绝
}
count miss/skipped;                                                  // :932-933
const isoIdLive = isolation !== undefined && verify
  ? sha256Hex(`${journal.isolationReplay!.nonce}:${kForOccurrence}:${occurrence}`).slice(0, 32) : undefined; // 新
if (!declaresExperts && !replayTainted && (isolation === undefined || verify)) {   // :942 改
  journalMetaOf.set(callId, { taskKey, chainDigestBefore, occurrence, agentType,
    ...(isoIdLive !== undefined ? { isolation: "worktree", isoId: isoIdLive } : {}) });
}
pendingFold = foldable ? isoIdLive : undefined;                      // 新：局部变量，尚未折叠

// —— 准入 host.ts:958-1022 ——（仍在同步段）
maxChildren 拒绝 → journalMetaOf.delete; return                        // :960 不变，pendingFold 丢弃（不折叠）
BW2 拒绝 → journalMetaOf.delete; return                                // :971 不变，不折叠
D2 拒绝 → journalMetaOf.delete(callId); return                         // :985 新增 delete，不折叠
if (isolation !== undefined && !foldable) replayTainted = true;        // :991-998 改：content/off 仍染色
experts 解析失败 → return                                              // :1010 不变，不折叠（journalMetaOf 在 declaresExperts 时本来就没设置）
experts 成功 → replayTainted = true                                    // :1021 不变
if (pendingFold !== undefined) chainDigest = nextChainDigest(chainDigest, "iso:" + pendingFold); // 新 F2：唯一的 live 折叠点
// —— :1026 构造 QueuedAgentCall，之后是入队（同步返回）或 :1077 await spawn ——（同步段结束）
```

写入点 `host.ts:1274-1289`：

```ts
if (journal && outcome.status === "completed") {
  const jm = journalMetaOf.get(callId);
  if (jm) {
    if (jm.isolation === "worktree") {
      const w = replayableWorktree(wt, jm.isoId!);  // committed+branch+commit（正则通过）⇒ {committed,…,isoId}；clean ⇒ {clean,isoId}；否则 undefined
      if (w) journal.store.append(journal.dir, buildEntry({ …jm 字段…, isolation: "worktree", worktree: w, value, completedAt, durationMs }));
    } else {
      /* 原有写入不变 */
    }
  }
}
```

#### D6.3 不变量

| #   | 不变量                                                                                                                                                                                                              | 如何保证 / 由哪条测试钉住                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 每个调用（包括隔离调用）的 lookup 键和 occurrence 键都用**未折叠**的 `chainDigestBefore` 计算；折叠只影响**之后**提交的调用。                                                                                       | 伪代码 `chainKey` 在任何折叠之前算出；§6 第 14 条（a）。                                                                                                                                                                                                   |
| I2  | `chainDigest` 只在同步段里被修改：:868 的推进、F1、F2。从 journal 块开始到 F2 之间没有 await。                                                                                                                      | 代码注释与 lint 式测试：`handleAgent` 源码里 journal 块到 F2 之间不出现 `await`（读源码断言），以及并发提交的属性测试；§6 第 14 条（f）。                                                                                                                  |
| I3  | 只有 accepted 的隔离调用会折叠，每次调用最多折叠一次（F1 与 F2 互斥）。                                                                                                                                             | 命中后提前 return；§6 第 14 条（b）。                                                                                                                                                                                                                      |
| I4  | 以下路径**不折叠**：invalid_args（:770-790，在 journal 块之前，链本来就不推进）、maxChildren、BW2、D2 `isolation_unavailable`、worktree 关闭时被阻止的命中、experts 未解析、off 模式、content scope、没有 journal。 | §6 第 14 条（c）：这些路径下，该调用之后的 `chainDigest` 恰好等于 `nextChainDigest(before, taskKey)`（taskKey 仍是含 `isolation` 的隔离 taskKey，`journal.ts:68-78`），并且与「同一隔离 taskKey、只关闭 iso 折叠」的基线运行里后续调用的键序列逐字节相同。 |
| I5  | accepted 之后的**异步**失败（入队后被 withheld、phase 超时、stopOwned、spawn error :1079-1103、orphaned、子 run failed/aborted/timed_out）**保留折叠，不回滚**。回滚会让已经读到折叠后摘要的后续提交错位。          | 这些路径都在同步段之后；§6 第 14 条（d）。沿用现有先例：D2 染色和 experts 染色同样在准入时置位，派发失败也不撤销。                                                                                                                                         |
| I6  | fail-safe：一个 live 的 `isoId` 只有在带着它的条目被写入时，未来运行里才可能被命中；写入需要 completed 且 `committed`（带 sha）或 `clean`。所以 I5 保留下来的折叠最多造成未来的 miss，永远不会造成错误命中。        | nonce 是每次 run 的 `randomUUID()`；§6 第 14 条（d）（e）。                                                                                                                                                                                                |
| I7  | 命中时折叠用的是 `entry.worktree.isoId`，与写下该条目的那次 live 运行折叠的值相同，所以下游命中的条目一定来自「上游就是这个结果」的运行。                                                                           | §6 第 14 条（e），三次运行的序列。                                                                                                                                                                                                                         |
| I8  | off、没有 journal、content scope 时，`chainDigest` 序列与方案 A 逐字节相同。                                                                                                                                        | §6 第 15 条：在同一段脚本上记录每次提交的 `chainDigestBefore`，与 v1 前的基线对比。                                                                                                                                                                        |

#### D6.4 效果

run N 上游 live（X）⇒ 下游写在含 X 的链下；run N+1 上游命中 X ⇒ 下游命中；上游没有命中 ⇒ 新的 Y ⇒ 下游 miss，并写在 Y 下；run N 上游 `pending` 没写、run N+1 命中更早的 X ⇒ 下游只会命中写在 X 下的条目。chain scope 下隔离调用不再设置 `replayTainted`。content scope：live 的隔离调用仍然染色；校验通过的命中不染色；隔离调用自身照样写入。

#### D6.5 与 experts D15 的区别

experts D15 否决「把不可复现标记混进 digest」，理由有三：会静默 miss、会写垃圾条目、无法与普通 miss 区分。这里的差异：

1. 专家调用**永远**不可复现，混进 digest 的标记永远不会再被命中；而 `isoId` 在上游命中时**可以复现**（I7），这正是用户确认 4 要的收益。
2. 垃圾条目只出现在「上游 live 但最终没写」（`pending`/`kept`/失败）的情况下，数量不超过这些运行的下游调用数，并受 journal 的 TTL 约束，而且永远不会被错误命中（I6）。
3. 可区分性：统计新增 `replay.isolation.freshFolds`（本次 live 折叠的次数）。下游 miss 发生在一次 live 折叠之后，诊断上就能看出来。

### D7 回放命中时返回给脚本的形状

- `host_settle` 增加 `worktree`：`committed` ⇒ `{ state, branch, commit }`；`clean` ⇒ `{ state }`。永远不带 `path`，也不暴露 `isoId`。
- `fullResult` ⇒ `{ text, runId: null, label: null, worktree }`；普通调用返回字符串。`worker-source.ts` 不用改。
- `recordSettled({ source: "replay", …, worktree })`；`worktreeLineFor` 对回放行渲染 `label → <branch> (replayed @<sha7>[, branch gone|moved])`，不拼 expected branch；回放的 `clean` 不列出。
- 回放命中不启动晚到监听，不占槽位，不写新条目。
- `worktreeAvailable()` 在命中时为 false ⇒ 不返回 hit，按 skipped 计数，不折叠，落到 D2 门以 `isolation_unavailable` 拒绝（见 D6.2）。

### D8 与 experts 规则的交互

- experts 染色（`host.ts:1016-1022`）**不变**，仍然同时作用于读和写，并且先于隔离检查。
- experts 染色之后提交的隔离调用 ⇒ `skip:chain_tainted`，不写 journal。如果它通过了准入，照样执行 F2 折叠（I3 统一规则）；链已经被染色，这次折叠不影响任何结果，但让代码只有一条路径。
- 同时带 experts 和 isolation 的调用 ⇒ `skip:experts`，不写；experts 解析失败 ⇒ 不折叠（I4）。
- 回放的隔离调用没有 runId：后续 `experts:[该 label]` 按现有规则拒绝。
- `replay-taint.property`：chain scope 下，accepted 的隔离调用不再是染色源；content scope 和 off 模式下仍是。

### D9 设置开关

- `workflow.isolationReplay: "verify" | "off"`，默认 `verify`（用户确认 1）。`settings.ts` 逐字段 parse，非法值回落并 WARN；`setting-specs.ts` 增加一项 `choice`。
- stack 把 `() => settings.workflow.isolationReplay` 和 `isolationCwd` 传给 `createWorkflowChildSpawner`，由 `buildJournalConfig` 每个 run 读取一次。
- **off 的保证（收窄后）**：回放语义与方案 A 逐字节一致，包括：
  - 判定结果与 skip reason；
  - journal 读写（不写隔离条目，隔离调用之后的调用照样染色）；
  - `chainDigest` 序列（I8）；
  - 零 git 探测、零终态复核；
  - spawn 请求（不带 cwd）；
  - outcome 文本。
- **不在保证之内**：live 结果 `fullResult.worktree` 以及 child summary 与 run log 里的 `commit` 新增键（D1.3）。

### D10 零 hang

- 新增的 await 只有两处：加载时探测（≤ `timeoutMs + 500`，最多约 5.5 秒），以及终态复核（≤ 2 秒，与 flush 并行）。两处都可中止、单次结算、失败时降级；「有界」指这两处 await 本身按时返回，被中止的子进程由 `pi.exec` 在其后最多约 5 秒内以 SIGKILL 回收（D4.3）。`store.load()` 不在此列（todo #21）。
- H3 仍然是报告前最多 5 条命令，D5 和 D5a 的时域不变。
- 命中路径和折叠都是同步的；journal 写入仍是 fire-and-forget（JS1）。

### D11 文档与描述

- `workflow-tool.ts:78-79`：隔离调用的结果只在 `committed`（run 开始时分支仍然精确指向记录的 commit）或 `clean` 时写入并回放；否则当次重跑，并且在 chain scope 下只让依赖它的下游重跑；journal 回放从不检查仓库状态。
- AGENTS.md 的 `src/workflow/` 段改写；`skills/dev-flow/references/subagent-workflow.md` 同步。
- `docs/dev/workflow-worktree/plan.md` 的 §0 决定 4 后面追加一行「已由 replay-verify-plan.md 取代（off 时仍为方案 A）」，只追加。

## 3. 场景

| 场景                                          | 结果                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 分支完好，指向记录的 commit                   | 通过，命中，下游（chain）继续命中。                                                                          |
| 合并了分支但没删                              | 通过。再合并一次是「Already up to date」。                                                                   |
| 合并后删除分支（包括 squash、rebase 合并）    | 不通过 ⇒ live（用户确认 2），重复一次子 run。                                                                |
| 分支被 rebase、强推，或者追加了提交           | 不通过 ⇒ live，下游（chain）随之 miss。                                                                      |
| 仓库整体移动了目录                            | ref 跟着仓库走，cwd 是新位置 ⇒ 通过。                                                                        |
| 在仓库子目录里启动 workflow                   | 探测在子目录执行（for-each-ref 照常工作）；H2 收到同一个 cwd ⇒ 同一个仓库。                                  |
| run 中途 `process.chdir` 到别处               | 探测、H2、终态复核都用启动时钉住的 cwd（D4.1），不受影响。                                                   |
| 在另一个 clone 里使用同一个 journal namespace | 分支不存在 ⇒ live；如果恰好有同名分支并且 sha 相同，通过是正确的（内容相同）。                               |
| 不是 git 仓库                                 | 探测非 0 ⇒ live ⇒ H2 按现有规则 `failed(config)`。                                                           |
| git 卡住（锁、NFS）                           | abort 加 SIGTERM；约 5.5 秒后返回并降级为 live；不响应 SIGTERM 的进程由 `pi.exec` 再过约 5 秒 SIGKILL 回收。 |
| 快照之后、命中之前分支被删或强推              | 仍然命中（快照语义，D4.4），返回的 `commit` 仍然可以合并；outcome 标注 `branch gone` 或 `branch moved`。     |
| 同一个键有多条隔离条目，最新一条校验失败      | live，不回退到更早的条目。                                                                                   |
| 手工编辑 journal                              | 正则校验不通过 ⇒ corrupt；digest 不是 MAC，不在威胁模型内。                                                  |

## 4. 接口变更汇总

```ts
// src/core/types.ts
WorktreeDisposition.commit?: string ; WorktreeDisposal.commit?: string        // 只在 committed 时填写
// src/workflow/types.ts
ChildWorktreeInfo.commit?: string
JournalEntry.worktree?: { state:"committed"; branch; commit; isoId } | { state:"clean"; isoId }
WorkflowChildSummary.replayStale?: "gone" | "moved"
WorkflowReplayStats.isolation?: { probed; verified; unverified; freshFolds; stale; probeError?: string }
// src/workflow/journal.ts
BuildEntryInput.worktree? ; parseEntry 白名单 + 形状校验
// src/workflow/replay.ts
ReplayDecision.skip.reason += "worktree_unverified"
DecideReplayInput.isolationReplay?: "verify" ; isolationVerified?: (e: JournalEntry) => boolean
ReplayIndex.isolatedCandidates(): readonly JournalEntry[]
// src/workflow/isolation-verify.ts（新）
collectProbeBranches(candidates, cap) ; parseForEachRef(stdout, wanted) ; runBoundedProbe(probe, { timeoutMs, clock })
verifyIsolatedEntries(candidates, probe, { cwd, timeoutMs, clock }) ; recheckBranches(replayed, probe, { cwd, timeoutMs, clock })
// src/workflow/host.ts
ChildSpawner.spawn({ …, cwd? })                                              // 只在 verify + isolation 时设置
ChildSpawner.probeAgentBranches?(branches, { cwd, timeoutMs, signal }): Promise<{ ok: true; tips: ReadonlyMap<string,string> } | { ok: false; error: string }>
ChildSpawner.isolationReplayMode?(): "verify" | "off" ; ChildSpawner.isolationCwd?(): string
JournalRunConfig.isolationReplay?: { mode: "verify"; cwd: string; verified: ReadonlySet<string>; nonce: string; stats }
HostCallHandler.recheckReplayedIsolation(deadlineMs): Promise<void>
HostSettleEnvelope.worktree 在回放命中时同样携带
// src/config/settings.ts
WorkflowSettings.isolationReplay: "verify" | "off"
```

## 5. 包拆分与合入顺序

### 5.1 包与文件域（串行 P1 → P2）

- **P1 `wt-commit-sha`**：D1（H3 调整顺序并产出 sha，spawn-service 与 spawner-adapter 透传，`ChildWorktreeInfo.commit`）。
- **P2 `wf-replay-verify`**：D2 到 D11。

两包共用 `src/workflow/types.ts` 和 `src/workflow/spawner-adapter.ts`，并且 P2 依赖 P1 的 `commit`，所以串行。

```json
[
  {
    "id": "wt-commit-sha",
    "globs": [
      "src/core/types.ts",
      "src/extensions/worktree.ts",
      "src/service/spawn-service.ts",
      "src/workflow/spawner-adapter.ts",
      "src/workflow/types.ts",
      "tests/extensions/worktree.test.ts",
      "tests/extensions/worktree-git-integration.test.ts",
      "tests/service/spawn-worktree-wait.test.ts",
      "tests/workflow/spawner-adapter.test.ts",
      "tests/workflow/host-worktree.test.ts",
      "tests/workflow/worker-host-call.test.ts"
    ]
  },
  {
    "id": "wf-replay-verify",
    "globs": [
      "src/workflow/journal.ts",
      "src/workflow/replay.ts",
      "src/workflow/host.ts",
      "src/workflow/types.ts",
      "src/workflow/orchestrator.ts",
      "src/workflow/spawner-adapter.ts",
      "src/workflow/isolation-verify.ts",
      "src/config/settings.ts",
      "src/config/setting-specs.ts",
      "src/stack.ts",
      "src/tools/workflow-tool.ts",
      "tests/workflow/journal.test.ts",
      "tests/workflow/replay.test.ts",
      "tests/workflow/replay-taint.property.test.ts",
      "tests/workflow/host-iso-fold.property.test.ts",
      "tests/workflow/host-replay-verify.test.ts",
      "tests/workflow/journal-replay-e2e.test.ts",
      "tests/workflow/orchestrator.test.ts",
      "tests/workflow/isolation-verify.test.ts",
      "tests/config/workflow-settings.test.ts",
      "tests/tools/workflow-tool.test.ts",
      "tests/integration/workflow-worktree-replay.test.ts",
      "skills/dev-flow/references/subagent-workflow.md",
      "docs/dev/workflow-worktree/plan.md",
      "AGENTS.md"
    ]
  }
]
```

注意：P1 的 `host-worktree.test.ts` 和 `worker-host-call.test.ts` 只增加 D1.3 的 `Object.keys` 回归用例；P2 的新用例放进新文件 `host-replay-verify.test.ts` 和 `host-iso-fold.property.test.ts`，避免两包在同一个测试文件上冲突。

### 5.2 与 child-context-switch 的串行依赖与合入顺序（评审 #7）

逐文件的交点（ccs 即 child-context-switch）：

| 本方案 | ccs 包                 | 文件                             | 性质                                                                                                                                                                                                                               |
| ------ | ---------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | P0（已合入 `e7775ff`） | `src/core/types.ts`              | ccs 这部分已在 master 上，P1 从最新 master 开工即可，**没有在途冲突**。                                                                                                                                                            |
| P1     | P3                     | `src/service/runtime-adapter.ts` | **v2 已消除**（D1.4 不再改这个文件）。                                                                                                                                                                                             |
| P2     | P1、P2                 | `src/config/settings.ts`         | 同文件不同段（本方案只改 `WorkflowSettings`、`DEFAULT_SETTINGS.workflow`、`parseWorkflowSettings`；ccs 改 keepalive 和 compact 的键）。文本冲突概率低，但属于同文件。                                                              |
| P2     | P2                     | `src/stack.ts`                   | 不同区域（本方案改 `:2201-2211` 的 workflow spawner；ccs 改 `:668-700`、`:838` 的 compact-hint）。                                                                                                                                 |
| P2     | P3                     | —                                | ccs P3 的文件（`index.ts`、`child/wire.ts`、`tool-scope.ts`、`runtime-adapter.ts`、`commands/`）与本方案 P2 **没有交集**。ccs P3 开工闸门的 diff 检查范围里有 `stack.ts`，如果 ccs P3 最终也改了 `stack.ts`，按下面的规则 3 处理。 |

**合入顺序**（比「等 ccs P3 合入之后」更早，但同样安全）：

1. **本方案 P1**：与 ccs 没有文件交集，可以立即在隔离 worktree 里开发；合入前 rebase 到最新 master。
2. **本方案 P2**：可以与 ccs 并行开发（在隔离 worktree 里），但**合入必须晚于 ccs P1 和 P2**。合入前 rebase，并处理 `settings.ts`、`stack.ts` 的冲突。
3. 如果到本方案 P2 合入时，ccs P3 正在进行且它的 diff 改了 `stack.ts` 或 `settings.ts`（用 `git diff --stat master..<ccs-p3分支> -- src/stack.ts src/config/settings.ts` 判断），那就**排在 ccs P3 之后**再 rebase 合入（即评审建议的保守顺序）；否则不必等待 ccs P3。
4. 每次 rebase 合入之后，在干净的 worktree 里运行：
   - `npx vitest run tests/workflow tests/tools/workflow-tool.test.ts tests/integration/workflow-worktree*.test.ts tests/extensions/worktree*.test.ts tests/service/spawn-worktree-wait.test.ts`（replay 与 worktree）；
   - `npx vitest run tests/context-switch tests/cache-ttl tests/compact-hint tests/child tests/config`（ccs 与设置；目录以 ccs 实际落地为准，不存在的目录去掉）；
   - 然后全量门禁：`npm run format:check && npm run typecheck && npm test && npm run build`。

### 5.3 开工前冲突预检

````sh
# ① 两包之间的交集只能是已声明的串行重叠
awk '/^```json/{f=1;next} /^```/{f=0} f' docs/dev/workflow-worktree/replay-verify-plan.md > /tmp/wf-rv-spec.json
timeout 60 node skills/dev-flow/scripts/conflict-check.mjs /tmp/wf-rv-spec.json
# ② 本包文件在工作区里不能有别人的未提交改动（以 P2 为例）
node -e 'const s=require("/tmp/wf-rv-spec.json").find(p=>p.id===process.argv[1]);console.log(s.globs.join("\n"))' wf-replay-verify \
  | xargs git status --short --
# ③ 与 ccs 在途包：把它的 {id,globs} 追加进 spec，只保留「本包 + 该 ccs 包」再跑一次
````

**失败判据**：

- ① 退出码为 1，交集**只能是** `src/workflow/types.ts` 和 `src/workflow/spawner-adapter.ts`。
- ② 有任何输出 ⇒ 停下来。
- ③ 交集只能是 §5.2 表中列出的那些；出现表外的交集 ⇒ 停下来修订方案。
- 前一个包必须已经 `--ff-only` 合入 master，并在干净的 worktree 里通过四道门禁。

## 6. 测试清单

**P1 `wt-commit-sha`**：

1. worktree.test（exec spy）：
   - dirty 路径命令序列为 `status → switch -c → add → commit → rev-parse HEAD`，报告 `{committed, branch, commit}`；
   - 末尾 rev-parse 失败 ⇒ 仍是 `committed`，没有 `commit`，`worktree remove` 照常执行；
   - clean 且 HEAD 前进 ⇒ `status → rev-parse → branch`，`commit === currentHead`；
   - clean 且 HEAD 没变 ⇒ `clean`；clean 路径 rev-parse 失败 ⇒ `kept`；
   - `baseHead` 缺失 ⇒ 走 committed 路径；
   - linkPaths 的排除 pathspec 仍然存在。
2. worktree-git-integration（真实 git）：`commit` 等于 `git rev-parse pi-agent-<id>`；子 agent 自己提交时 `commit` 等于它的 HEAD；慢 hook 用例保持绿。
3. spawn-worktree-wait：mark 与 wait 都保留 `commit`；late 时域数值不变（reapMs=2000 ⇒ 11000）。
4. spawner-adapter：`awaitWorktree` 映射 `commit`，缺失时没有这个键。
5. （删除 v1 的 sink 与 late-dispose 项：P1 不再改那两个文件。）
6. **`Object.keys` 回归（评审 #1）**，放在 host-worktree.test 和 worker-host-call.test，分别在 verify 和 off 两种配置下运行：
   - 非隔离调用 `fullResult` 的顶层键严格等于 `["text","runId","label"]`，非 fullResult 时返回字符串；
   - 隔离调用顶层键为 `["text","runId","label","worktree"]`；
   - `worktree` 内部的键：committed 为 `["state","branch","commit"]`（缺 sha 时是 `["state","branch"]`），kept 为 `["state","path"]`，pending 为 `["state"]`，clean 为 `["state"]`；
   - off 下 outcome 文本与 P1 之前的基线快照逐字节相同（worktrees 段不含 sha）。

**P2 `wf-replay-verify`**：

7. journal.test：
   - 带 `worktree` 的条目往返时 digest 稳定；
   - 篡改任一字段 ⇒ corrupt；非法分支名、commit、多余键、缺 `isolation` ⇒ corrupt；
   - 非隔离条目字节不变；
   - 「旧解析器」读新条目 ⇒ corrupt。
8. replay.test：判定顺序全表；`clean` 不需要校验；`worktree_unverified`；`isolatedCandidates` 的筛选。
9. isolation-verify.test：
   - `parseForEachRef` 精确匹配；上限；
   - **`runBoundedProbe`（评审 #5）**：
     - 端口永不 resolve ⇒ 在 `timeoutMs` 时 `signal.aborted === true`，`timeoutMs + 500` 时按时返回空结果；
     - 端口在 abort 之后才 resolve 或 reject ⇒ 被吞掉，没有第二次回调，`verified` 不变，没有 unhandled rejection；
     - 返回后 `vi.getTimerCount()` 回到基线；
   - 候选为空、off、`noReplay`、`worktreeAvailable` 为 false ⇒ 端口调用次数为 0。
10. **真实子进程**（isolation-verify.test 的 integration 块；stack 的 probe 适配器，经真实 `pi.exec` 语义的 `execCommand`，PATH 前置假 `git` 脚本，脚本把自己的 pid 写进临时文件）：
    - (a) 普通 sleep 的假 git：probe 在 `timeoutMs + 500` 内返回空结果，SIGTERM 后进程随即退出；
    - (b) **SIGTERM-resistant** 的假 git（`trap '' TERM; sleep 60`）：probe 仍然在 `timeoutMs + 500` 内返回（断言返回时刻，而不是进程状态）；返回时进程**允许**还活着；在返回后约 5 秒（加宽限，轮询上限 8 秒）进程被 SIGKILL 回收（`process.kill(pid, 0)` 抛 ESRCH）；
    - (c) 两种情况下结果都只结算一次（回调计数为 1，`verified` 只写一次），晚到的 resolve 不产生第二次回调，也没有 unhandled rejection；
    - 真实计时，整条用例 `testTimeout` 设为 20 秒。
11. host-replay-verify.test（chain）：
    - 首跑写下游；
    - run 2 校验通过 ⇒ 隔离调用和下游全部命中，spawner 调用次数为 0；
    - 校验失败 ⇒ 隔离调用 live，下游 miss 并写到新链下；
    - `pending`/`kept`/缺 sha ⇒ 不写隔离条目、下游照写，run 3 下游命中 run 1 的条目；
    - `clean` 命中不探测；
    - verify 下隔离 spawn 请求带 `cwd === isolationCwd`，off 下不带（逐字节对比）。
12. host-replay-verify.test（content、experts、off）：
    - content：live 的隔离调用染色，命中不染色；
    - experts 交互三条（见 D8）；
    - off：已有 D3 用例以 off 参数化后全部原样通过。
13. **TOCTOU（评审 #6）**，host-replay-verify.test 与 orchestrator.test：
    - 探测通过后删除分支（假探测的第二次调用返回缺失）⇒ 命中照样发生，settle 带原 `commit`；
    - 终态复核标注 `replayStale:"gone"`，改指向时标注 `"moved"`，outcome 行出现 `branch gone`/`branch moved`，`stats.isolation.stale` 正确；
    - 复核挂住 ⇒ 2 秒内完成，不标注，终态不被延迟（与 flush 并行，用 FakeClock 断言）；
    - 没有 committed 命中 ⇒ 复核不执行（端口调用次数为 0）。
14. **`isoId` 折叠不变量（评审 #3）**，host-iso-fold.property.test，用 FakeClock、假 spawner，并记录每次提交的 `chainDigestBefore`：
    - (a) I1：隔离调用自身的 lookup 键与 occurrence 等于 `nextChainDigest(before, taskKey)`，与折叠无关；
    - (b) I3：一次调用至多折叠一次；命中折叠值 === `entry.worktree.isoId`；
    - (c) I4：maxChildren、BW2、D2 拒绝、worktree 关闭时被阻止的命中、experts 未解析这几条路径下，① 直接断言该调用之后 `chainDigest === nextChainDigest(before, isolatedTaskKey)`（没有 `iso:` 折叠）；② 与基线运行对比：同一段脚本、同一个隔离 taskKey，只通过测试钩子关闭 iso 折叠（F1/F2 置为 no-op），后续调用的键序列逐字节相同。注意：taskKeyOf 把 `isolation` 纳入 key（`journal.ts:68-78`），所以不能拿非隔离调用做基线；
    - (d) I5/I6：入队后被 withheld、spawn error、子 run failed 时折叠保留（后续键包含 `iso:`），并且下一次运行里这些下游全部 miss、不会错误命中；
    - (e) I7：三次运行（live → 命中 → 删除分支后 live）的命中与 miss 表完全符合预期；
    - (f) I2：随机交错的并发 `agent()` 提交（parallel 加排队）下，链摘要序列只取决于到达顺序；另有一条读源码的断言：`handleAgent` 从 journal 块到 F2 之间没有 `await`。
15. **I8 基线**：off、没有 journal、content 三种情况下，同一段脚本的 `chainDigestBefore` 序列与 P2 之前录下的 fixture 相同（fixture 在 P2 开工第一步从 master 录制，此后不得重新生成）。
16. replay-taint.property：改写为 D8 的规则。
17. journal-replay-e2e：三次运行，检查行数与命中数；旧解析器读取新条目 ⇒ corrupt。
18. orchestrator.test：只在有候选时探测；探测挂住时 boot 在 timeout+500 后开始；`isolationCwd` 在 run 开始时只读取一次（中途修改 getter 返回值，不影响本 run）。
19. workflow-tool.test：回放行、stale 标注、描述文案、`replay:` 行追加 `, N wt-verified, N wt-unverified[, N wt-stale]`。
20. workflow-settings：`isolationReplay` 的默认值、非法值回落并 WARN；spec 项存在。
21. **integration/workflow-worktree-replay（真实 git + 真实 worktree 扩展 + 假 driver）（评审 #4）**：
    - 基本三次运行，以及 `git branch -f` 和 `git branch -D` 的场景；
    - **子目录**：在 `repo/sub` 启动 ⇒ 命中；
    - **chdir**：run 开始后 `process.chdir(otherRepo)` ⇒ 隔离子 run 的 worktree 仍然建在原仓库，终态复核也在原仓库（测试结束恢复 cwd，沿用 `tests/integration/workflow-worktree.test.ts:415/525` 的写法）；
    - **不同 clone**：`git clone` 出 B，用同一个 journal namespace 在 B 里运行 ⇒ live；在 B 里 fetch 同名分支（同 sha）⇒ 命中；
    - 把仓库 `mv` 到新目录 ⇒ 命中；
    - 在非 git 目录运行 ⇒ 降级且不 hang。

**门禁**：每个包在干净的 worktree 里通过 `npm run format:check && npm run typecheck && npm test && npm run build`；按 §5.2 第 4 条，rebase 合入之后再跑一次。

## 7. 风险

- **行为变化**：带 journal 的 workflow 在隔离调用之后开始回放；需要旧行为时用 `off` 或 `noReplay`。live 的 `fullResult.worktree` 新增 `commit`（在 off 的保证范围之外，D1.3）。
- **回放拿到的分支来自上一次运行**：可能已经合并过，也可能基于较旧的 HEAD。这与 journal「不检查仓库状态」的既有语义一致（D3.1）。outcome 会标出 `(replayed @sha7)`。
- **快照语义**：快照之后分支被移动，命中照样发生，但结果带 `commit`，并在终态标注 `branch gone`/`branch moved`（D4.4）。
- **journal 垃圾条目**：上游 live 却最终没写（`pending`/`kept`/失败）时，下游条目写在不可达的链下，数量有界，受 TTL 约束，永不错误命中（D6.5）。
- **`store.load()` 没有 deadline**：既有问题，由 todo #21 处理；本方案只保证新增的 probe 不 hang（D4.3）。
- **pi exec 的 SIGKILL 回退 timer 是 ref 的**（pi 自身代码，5 秒）：不响应 SIGTERM 的 git 会在 probe 返回之后再存活最多约 5 秒；只影响主会话，workflow 不在 print 模式运行。
- **`clean` 与 linkPaths**：违反只读约定、写进 linkPaths 的改动不可见（D9 已接受风险的延伸）。
- **journal 降级不兼容**：旧版本把新条目当成 corrupt。
- **content scope 仍要第三次运行才有收益**：弱模式，已接受。
- **H3 命令顺序调整**：由真实 git 测试锁定。
- **与 ccs 的合入竞争**：按 §5.2 的规则执行；rebase 之后必须重跑两组测试和全量门禁。

## 8. 需用户确认的问题

1. **`workflow.isolationReplay` 的默认值**：`verify` 还是 `off`？**推荐 `verify`**。只有显式传了 `journal` 的 run 才受影响，失败时一律回落为 live，不存在错误回放的路径；默认 `off` 会让这项功能事实上无人使用。
2. **校验的严格程度**：只认「分支 tip 精确等于记录的 commit」，还是也接受「tip 是它的后代」和「分支已删但 commit 已是 HEAD 的祖先（合并过）」？**推荐 v1 只做精确相等**：一条 for-each-ref 就能完成，语义清楚。另外两种情况会返回一个已经不存在或已经变化的分支名，而 `gate("git merge <branch>")` 在重放时会失败。等有真实需求再加 `reachable` 模式（每个条目额外执行一次有上限的 `merge-base --is-ancestor`）。
3. **`completed` + `pending`、之后晚到 `committed` 的调用是否补写 journal**：**推荐不补写**。脚本当时看到的是 `pending`，补写会产生一个脚本从未见过的形状；而且写入可能晚于 `flushJournal` 甚至进程退出。这种情况按「未写」处理，下次运行重跑，chain 下只影响依赖它的下游。
4. **chain scope 用 `isoId` 折叠取代染色（D6）**：这偏离了 todo 原文「live 就按现有规则污染链」的字面意思，但可以让首跑就写下游条目，第二次运行即可获得收益，一致性由链摘要保证。**推荐采用折叠**；content scope 保留原有的染色规则。

## 用户确认（2026-09-26）

1. `workflow.isolationReplay` 默认 `verify`。
2. 校验口径：只认 `pi-agent-<runId>` 分支精确指向记录的 sha（删除 / rebase / 强推 / 加新提交 / 已合并删除 ⇒ 重跑）。
3. `pending` 后晚到 `committed` 的隔离调用不补写 journal。
4. chain scope 采用「isoId 并入链摘要」代替染色；content scope 仍染色，experts 规则不变。

## v1→v2 评审处置

| #   | 级别 | 评审意见                                                                  | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                         | 落点                          |
| --- | ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | 严重 | off 宣称逐字节一致，但 P1 无条件给 live `fullResult.worktree` 加 `commit` | **选择收窄 off 的保证**：off 的保证 = 回放语义（判定、journal 读写、链摘要序列、零探测、spawn 请求、outcome 文本）逐字节一致；`commit` 是与开关无关的 live 新增键。理由：sha 由不知道回放开关的服务层产出；按 sha 合并能抵御 TOCTOU，在 off 下同样有价值；这是对象内部的新增键，不破坏已有读取。补充 `Object.keys` 回归（顶层与 `worktree` 内部键、verify 与 off 两种配置、outcome 基线快照）。                                              | §0-1/6、D1.3、D9、§6 第 6 条  |
| 2   | 严重 | clean 回放完全不校验 HEAD                                                 | **论证后结论：不需要**。键、条目、判定、文档四处证据都表明普通调用回放不看仓库状态，这是 journal 的既有语义；H3 的 `baseHead` 比较只是单次运行内的数据丢失防护。`clean` 与普通调用同等语义，不记录也不校验 base HEAD，写进描述与 AGENTS.md。「源码版本维度」如果要加，应对所有调用统一加，列为非目标。                                                                                                                                       | §1、D3.1、D11                 |
| 3   | 严重 | `isoId` 折叠只有文字描述                                                  | 补充同步伪代码（对照 `host.ts:833-868/942-949/958-1022/1274-1289`）：lookup 键用未折叠的摘要；命中折叠 F1 用 `entry.isoId`；唯一的 live 折叠点 F2 放在 experts 解析成功之后、构造 `QueuedAgentCall` 之前；D2 拒绝新增 `journalMetaOf.delete`。给出不变量 I1–I8，明确拒绝路径不折叠，accepted 之后的异步失败保留折叠、不回滚（附错位论证与 fail-safe 论证）。补充 D6.5（与 experts D15 的区别，新增 `freshFolds` 统计）以及测试第 14、15 条。 | D6、§6 第 14、15 条           |
| 4   | 一般 | 探测固定用 `process.cwd()`，与 H2 的 cwd 不一致                           | 每个 run 启动时钉住 `isolationCwd`（stack 接成 `process.cwd()`，即 H2 的回落基准；不用 `pi.exec` 的默认 cwd）。verify 下隔离 spawn 显式带 `cwd` 传给 H2；探测和复核同样用它；off 和非隔离调用的请求不变。补充子目录、chdir、不同 clone 的集成测试。                                                                                                                                                                                          | D4.1、§3、§6 第 11、18、21 条 |
| 5   | 一般 | probe 不可取消；load 没有 deadline                                        | probe 改为 `AbortController`、exec timeout、`withDeadline` 三重保护，单次结算，晚到结果吞掉，timer 归零；补充假端口测试和真实进程清理测试。`store.load()` 没有 deadline 属于既有简化（有注释为证），本方案不改变它，列为非本包范围并说明理由，建议另开 todo。                                                                                                                                                                                | D4.3、§6 第 9、10 条、§7      |
| 6   | 一般 | 只在 boot 前探测一次，存在 TOCTOU                                         | 明确保证语义为「加载时快照」，并说明与用户确认 2（判据）的一致性。否决命中前复核（会破坏同步段，I2）。增加终态并行复核（≤2 秒，只做诊断），标注 `replayStale` 和 `branch gone/moved`，并以返回 `commit` 作为实际的 TOCTOU 缓解。补充 TOCTOU 测试。                                                                                                                                                                                           | D4.4、D7、§6 第 13 条         |
| 7   | 一般 | 与 child-context-switch 的冲突                                            | 逐文件列出交点。v2 让 P1 不再改 `runtime-adapter.ts`，消除与 ccs P3 的冲突。合入顺序：P1 随时合入；P2 晚于 ccs P1/P2；如果 ccs P3 改了 `stack.ts`/`settings.ts`，就排在 P3 之后。每次合入后重跑 replay 与 worktree 测试、ccs 测试和全量门禁。拆开测试文件，避免两包共用测试文件。                                                                                                                                                            | §5.1、§5.2、§5.3              |

用户确认的四条决定（默认 verify、精确 sha、不补写、chain 折叠）在 v2 中均未改变；v2 没有新增需要用户确认的问题。

## v2→v2.1 处置

| #   | 复审条件                                                                                            | 处置                                                                                                                                                              | 落点                           |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | I4 的「替换为同 taskKey 的非隔离调用」不成立（taskKeyOf 含 `isolation`，`journal.ts:68-78`）        | 改为两个断言：直接断言 `chainDigest === nextChainDigest(before, isolatedTaskKey)`；并与「同一隔离 taskKey、只关闭 iso 折叠」的基线运行对比键序列                  | D6.3 I4、§6 第 14 条（c）      |
| 2   | SIGTERM 不响应时 pi.exec 要再等 5 秒才 SIGKILL（`exec.js:21-31,43-46`），「返回时进程已清理」不成立 | 保证改为「workflow 不 hang（约 5.5 秒返回）」，残留进程由 pi.exec 之后的 SIGKILL 回收；增加 SIGTERM-resistant 子进程测试（按时返回、约 5 秒后被回收、只结算一次） | D4.3、D10、§3、§6 第 10 条、§7 |
| 3   | journal.load() 无上限已另立 todo #21                                                                | 文案收窄为「新增 probe 不 hang」，引用 todo #21，不再暗示带 journal 的 workflow 启动整体有界                                                                      | D4.3、D10、§7                  |

用户确认的四条决定不变；v2.1 没有新增需要用户确认的问题。
