# workflow isolation 调用的「校验分支后回放」（todo #13，选项 C，L2）— 方案 v1

> 状态：v1，待评审。前置：`docs/dev/workflow-worktree/plan.md` v2.1 已全部实施（§0 决定 4 选了回放方案 A，并把「校验分支后回放」另记 todo，也就是本方案）。
> 本方案只包含本文件。实现按 §5 的两个包**串行**进行。

## 0. 结论速览

1. **H3 记录 commit sha**：`committed` disposition 新增 `commit`（40/64 位 hex），一路透传到 `ChildWorktreeInfo`。dirty 路径调整 git 命令顺序，让「报告前最多 5 条命令」不变，`late` 时域的推导（5×reapMs+1s）保持成立。
2. **隔离调用写 journal**：只有 `status:"completed"` 且 settle 时 disposition 为 `committed`（带 branch 和 commit）或 `clean` 的调用才写。条目新增可选字段 `worktree: { state, branch?, commit?, isoId }`。`kept`、`pending`、`none`、晚到的 disposition、缺 sha 的 `committed` 一律不写，行为回到方案 A。
3. **校验在 journal 加载时一次性完成**：`buildJournalConfig` 收集索引里需要校验的隔离条目，执行**一条** `git for-each-ref`（exec 超时 + host 侧 `withDeadline` 双重上限）。得到「已校验通过的条目 digest 集合」后，`decideReplay` 保持同步。探测失败、超时或端口缺失时集合为空，所有需要校验的条目都走 live（fail-closed）。
4. **判定规则**：`clean` 条目不跑 git，直接回放；`committed` 条目要求 `refs/heads/<branch>` 存在且**精确指向**记录的 commit。分支被删、rebase、强推、在分支上追加提交，都判为不通过，当次走 live。
5. **下游链规则改写（关键）**：chain scope 下，隔离调用不再给下游染色，改为把它的结果身份 `isoId` 折叠进链摘要。回放命中时 `isoId` 取条目里记录的值，live 时每次新生成。下游条目因此天然绑定到「上游是哪一次隔离结果」：上游回放同一个结果时下游能命中，上游重跑时下游自然 miss，并且**首跑就能写下游条目**。content scope 没有链可以折叠，保留方案 A 的染色，只有校验通过的回放命中才不染色。
6. **设置** `workflow.isolationReplay: "verify" | "off"`，推荐默认 `verify`。`off` 与现状（方案 A）逐字节一致：不折叠、染色、不写、不探测。

## 1. 现状证据

| 位置                                                                                            | 事实                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/dev/workflow-worktree/plan.md:11`、`:84-88`（§0 决定 4、D3）                              | 方案 A：带 isolation 的调用，以及其后提交的调用，都不读也不写 journal；`journal.ts` 不改，taskKey 仍含 `isolation`。                                                                                                                                                     |
| `src/workflow/replay.ts:147-155`                                                                | 判定顺序：`experts` → `tainted`（`chain_tainted`）→ `isolation`（`skip:isolation_worktree`），三者都在 `index.lookup` **之前**。                                                                                                                                         |
| `src/workflow/replay.ts:164`                                                                    | 旧条目（D3 之前落盘，带 `isolation:"worktree"`）在 lookup 之后仍会被 RP7 否决。                                                                                                                                                                                          |
| `src/workflow/replay.ts:52-73`                                                                  | `buildReplayIndex`：chain scope 的键是 `nextChainDigest(entry.chainDigestBefore, entry.key)`；同一个 `(键, occurrence)` 只保留 `completedAt` 最大的一条。                                                                                                                |
| `src/workflow/journal.ts:73-85`                                                                 | `taskKeyOf` 已经包含 `isolation`，隔离调用的 taskKey 与同 prompt 的普通调用不同。                                                                                                                                                                                        |
| `src/workflow/journal.ts:104-127`                                                               | `buildEntry` 已有 `isolation?` 参数，但写入点没有传它（D3 之后隔离调用根本不写）。                                                                                                                                                                                       |
| `src/workflow/journal.ts:136-174`                                                               | `parseEntry` 是**白名单重建 + digest 复算**：任何未知字段都不参与复算，结果是 digest 不符 ⇒ 记为 corrupt 行。旧版本读到新字段时会把整行当 corrupt（fail-closed）。                                                                                                       |
| `src/workflow/journal.ts:88-90`                                                                 | `nextChainDigest(before, taskKey) = sha256(before + ":" + taskKey)`，这是链摘要唯一的计算入口。                                                                                                                                                                          |
| `src/workflow/host.ts:446-452`                                                                  | 每个 run 一条 `chainDigest`；`journalMetaOf` 只存 `taskKey / chainDigestBefore / occurrence / agentType`。                                                                                                                                                               |
| `src/workflow/host.ts:833-868`                                                                  | journal 块：先算 taskKey 和 occurrence，然后**无条件**推进链（`:868`），再调用 `decideReplay`（`:870`）。                                                                                                                                                                |
| `src/workflow/host.ts:893-930`                                                                  | 命中路径：`recordSettled({source:"replay"})`，`host_settle` 只带 `value`，没有 runId、label、worktree；然后提前 return，**不经过** D2 门（`:985`）。                                                                                                                     |
| `src/workflow/host.ts:942-949`                                                                  | `!declaresExperts && !replayTainted && isolation === undefined` 时才写 `journalMetaOf`，隔离调用永不写。                                                                                                                                                                 |
| `src/workflow/host.ts:985-998`                                                                  | D2 门在 journal 块**之后**；门通过后 `replayTainted = true`，被拒绝的隔离调用不染色。                                                                                                                                                                                    |
| `src/workflow/host.ts:1016-1022`                                                                | experts 解析成功同样 `replayTainted = true`，从此永不清除。                                                                                                                                                                                                              |
| `src/workflow/host.ts:1274-1291`                                                                | 只有 `outcome.status === "completed"` 且 `journalMetaOf` 有记录时才 `append`（RP3）。                                                                                                                                                                                    |
| `src/workflow/host.ts:1324-1340`                                                                | 隔离调用在 `onOutcome` 之前先等 settle 时域的 disposition，拿不到就是 `pending`（D5）。所以写 journal 时 `wt` 已经可用。                                                                                                                                                 |
| `src/workflow/host.ts:710-728`                                                                  | `forceSettleActive` 强制 settle 为 `aborted` + `worktree:{state:"pending"}`，不写 journal。                                                                                                                                                                              |
| `src/workflow/types.ts:139-159`                                                                 | `JournalEntry` 目前的字段：没有任何 worktree 信息。                                                                                                                                                                                                                      |
| `src/workflow/types.ts:162-178`                                                                 | `WorkflowReplayStats` 有 `tainted?: true`。                                                                                                                                                                                                                              |
| `src/workflow/types.ts:233-237`                                                                 | `ChildWorktreeInfo = { state: committed/clean/kept/pending/none; branch?; path? }`，没有 commit sha。                                                                                                                                                                    |
| `src/core/types.ts:376-385`                                                                     | `WorktreeDisposition` 和 `WorktreeDisposal` 同样没有 sha。                                                                                                                                                                                                               |
| `src/extensions/worktree.ts:404-445`                                                            | H3 的顺序：`rev-parse HEAD` → `status`；clean 且 HEAD 前进 ⇒ `branch <b> HEAD` ⇒ `committed`；clean 且 HEAD 没变 ⇒ `clean`；dirty ⇒ `switch -c` → `add -A` → `commit` ⇒ `committed`；任一步失败 ⇒ `kept`（带 path）。**报告时没有 sha**，dirty 路径报告前恰好 5 条命令。 |
| `src/service/spawn-service.ts:205-206`                                                          | `settle = reapMs + 1s`，`late = 5 × reapMs + 1s`（按报告前最多 5 条命令推导）。                                                                                                                                                                                          |
| `src/service/spawn-service.ts:738-747`、`:755-770`                                              | `markWorktreeDisposition` / `waitWorktreeDisposition` 逐字段复制 `state/branch/path`。                                                                                                                                                                                   |
| `src/service/runtime-adapter.ts:373-386`                                                        | stack 已 dispose 时，晚到 disposition 逐字段复制进 `writeLateWorktreeDisposition`。                                                                                                                                                                                      |
| `src/workflow/spawner-adapter.ts:153-168`                                                       | `awaitWorktree` 逐字段映射 `settled` 结果。                                                                                                                                                                                                                              |
| `src/workflow/worker-source.ts:367-374`                                                         | `fullResult` 的形状是 `{ text, runId: runId \|\| null, label: label \|\| null }`，settle 带 worktree 时多一个 `worktree` 键。                                                                                                                                            |
| `src/workflow/orchestrator.ts:208-225`、`:549-550`                                              | `buildJournalConfig` 在 boot **之前**被 await：load → `buildReplayIndex`。这里是唯一的「脚本开跑之前、可以 await」的位置。                                                                                                                                               |
| `src/tools/workflow-tool.ts:78-79`                                                              | 工具描述：「An isolated call's result is never journaled or replayed, and every call submitted afterward … is skipped from replay too」。                                                                                                                                |
| `src/tools/workflow-tool.ts:318-331`                                                            | `worktreeLineFor` 的 expected branch 用 `c.runId ?? c.callId`，对回放的调用（没有 runId）会拼出错误的分支名。                                                                                                                                                            |
| `src/tools/workflow-tool.ts:404`                                                                | outcome 渲染 `replay: N hit, N miss, N skipped, N corrupt`。                                                                                                                                                                                                             |
| `src/config/settings.ts:89-98`、`:543-549`、`:1411-1440`；`src/config/setting-specs.ts:408-416` | `WorkflowSettings`（`replayTtlMs`、`replayScope` 等）、默认值、逐字段 parse、`/agent settings` 的 spec。                                                                                                                                                                 |
| `src/stack.ts:2201-2210`                                                                        | `createWorkflowChildSpawner(spawn, types, { resolveExperts, worktreeAvailable })`：新端口在这里接入，改动很小。                                                                                                                                                          |
| `docs/dev/workflow-background/plan.md:167`                                                      | workflow 工具的参数 schema（`journal/noReplay/replayScope`）不变。本方案同样不改 schema。                                                                                                                                                                                |

## 2. 设计

### D1 H3 产出 commit sha（P1）

- `WorktreeDisposal` 和 `WorktreeDisposition` 增加 `commit?: string`，只在 `committed` 时由扩展填写。`ChildWorktreeInfo` 同样增加 `commit?`；`LateWorktreeDisposition` 增加 `commit?`（sink 条目只是多一个键，read-back 不参与）。
- `worktree.ts` 的 `beforeReap` **调整命令顺序**：
  - 先 `status`。
  - clean ⇒ `rev-parse HEAD`，与 `baseHead` 比较（数据丢失修复的判定不变）。HEAD 前进 ⇒ `branch <b> HEAD`，`commit = currentHead`（不需要额外命令）；没变 ⇒ `clean`。rev-parse 失败 ⇒ `kept`（与现状相同）。
  - dirty ⇒ `switch -c` → `add` → `commit` → `rev-parse HEAD`。**最后这条 rev-parse 失败不降级为 `kept`**：工作已经安全落在分支上，照样报告 `committed`，只是不带 `commit`（这样的结果不写 journal，见 D3）。
  - 报告前的命令数：clean 路径最多 3 条，dirty 路径 5 条。所以 `late = 5×reapMs+1s` 与 D5a 的 tombstone 推导**都不用改**。
  - 替代方案「保持顺序、再加一条 rev-parse、把 late 改成 6×」被否决：它改动了已经验证过的零 hang 时域和 D5a 测试，收益为零。
- 透传点逐个加 `commit`：`spawn-service.ts` 的 mark 和 wait，`runtime-adapter.ts` 的晚到 sink，`spawner-adapter.ts` 的 `awaitWorktree`。
- 可观察的变化：live settle 的 `fullResult.worktree` 在 `committed` 时多一个 `commit` 键（顶层键集合不变）。

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
  - `state ∈ {committed, clean}`，不认识的 state 视为 corrupt；
  - `branch` 必须匹配 `/^pi-agent-[A-Za-z0-9._-]{1,200}$/`（与 `safeRunId` 的字符集一致，同时防止 git 参数注入和 for-each-ref 的 glob 字符）；
  - `commit` 必须匹配 `/^[0-9a-f]{40}$|^[0-9a-f]{64}$/`；`isoId` 必须匹配 `/^[0-9a-f]{32}$/`；
  - `worktree` 对象里有多余的键 ⇒ corrupt。
- `v` 保持为 1：非隔离条目逐字节不变，现有 journal 全部可用。
- **兼容矩阵**：
  - 新代码读旧条目：非隔离条目行为不变。带 `isolation` 但没有 `worktree` 的旧条目（D3 之前写的）继续 `skip:isolation_worktree`：没有 sha，无从校验。
  - 旧代码读新条目：`worktree` 不参与复算 ⇒ digest 不符 ⇒ corrupt 行，永不回放（fail-closed，只是 `corruptLines` 计数上升）。chain scope 里折叠过 `isoId` 的下游条目，旧代码的 live 链算不出同样的键，只会 miss。
  - 升级后已有命中不受影响：方案 A 从未写过隔离调用之后的条目（全部被染色），`isoId` 折叠只影响隔离调用之后的链，所以升级前后的已有条目命中率完全一致。

### D3 各 disposition 是否可以回放

写 journal 的条件（在 `host.ts` 的 `onOutcome` 里判断，这时 `wt` 已经确定）：`outcome.status === "completed"`，**并且** `wt` 满足下表的「写」。

| settle 时的 disposition                                                                     | 写 journal                   | 回放条件                                             | 理由                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `committed` + `branch` + `commit`                                                           | 写                           | 分支存在且精确指向 `commit`（D4）                    | 副作用完全落在一个可寻址、可校验的 ref 上。校验通过，说明下游当初依赖的世界仍然成立。                                                                                          |
| `committed`，缺 `commit`（dirty 路径末尾的 rev-parse 失败，或者 P1 之前的 H3）              | 不写                         | —                                                    | 没有校验依据。行为与方案 A 相同（content 染色；chain 下 `isoId` 每次新生成，下游只能 miss）。                                                                                  |
| `clean`                                                                                     | 写                           | 无条件（不跑 git，只受 TTL、truncated 和 D2 门约束） | 子 agent 没有改动任何被跟踪的内容，也就不存在需要校验的副作用。与普通调用回放一样，不检查仓库状态（HEAD 可能已经前进）。例外见 §7：违反只读约定、写进 linkPaths 的改动不可见。 |
| `kept`（提交链失败，worktree 保留在磁盘上）                                                 | 不写                         | —                                                    | 改动没有落在任何 ref 上，磁盘目录随时可能被用户处理，文本描述的改动无法复现。                                                                                                  |
| `pending`（settle 等待放弃）                                                                | 不写                         | —                                                    | 写入时不知道结果。脚本看到的是 `pending`，与晚到结果不一致。                                                                                                                   |
| `completed` + `pending`，之后晚到 `committed`                                               | 不写（**不做**「晚到补写」） | —                                                    | 晚到时下游早已按照 `pending` 继续执行。补写会产生一个「脚本从未见过的形状」的条目，而且写入可能发生在 `flushJournal` 之后甚至进程退出之后。见 §8 Q3。                          |
| `aborted`/`failed`/`timed_out`（包括 force-settle 的 `aborted`+`pending` 晚到 `committed`） | 不写                         | —                                                    | RP3：只有 completed 才写。晚到的 `committed` 只进入 `worktreeFinal`、run log 和 outcome，与现状一致。                                                                          |
| `none`（没有报告过 `diag.worktree`，或者端口缺失）                                          | 不写                         | —                                                    | 无法证明隔离真的发生过。                                                                                                                                                       |
| 将来新增的未知 state                                                                        | 不写（白名单）               | parse 时视为 corrupt                                 | fail-closed。                                                                                                                                                                  |

### D4 校验方法（P2）

**时机：journal 加载时预校验，不在命中时校验。** 原因：

- chain scope 的 `isoId` 折叠（D6）要求在提交的同步段里就知道命中与否。
- `handleAgent` 在 journal 块和 D2 门之间没有任何 await，这正是链摘要和 occurrence 顺序不被打乱的前提。在这里插入一个 await git，后续调用就可能读到过期的 `chainDigest`。

**流程**（`orchestrator.ts` 的 `buildJournalConfig`，新增模块 `src/workflow/isolation-verify.ts`）：

1. `buildReplayIndex` 额外暴露 `isolatedCandidates(): readonly JournalEntry[]`：去重**之后**仍然有效、`worktree.state === "committed"`、没有 truncated、在 TTL 内的条目。
2. 满足以下任一条件时**不探测**，零 git 调用：`isolationReplay !== "verify"`、`noReplay`、候选为空、`spawner.worktreeAvailable?.() !== true`（这种情况下命中本来就会被 D2 门拒绝）。
3. 否则取候选里去重后的 branch，最多 256 个，超出部分记为不通过。执行 `spawner.probeAgentBranches(refs, { timeoutMs })`，stack 把它接成：
   `pi.exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", ...refs.map(b => "refs/heads/" + b)], { cwd: process.cwd(), timeout })`
   - cwd 与 H2 为 workflow 子 run 解析出的 cwd 一致（`spec.cwd ?? process.cwd()`，workflow 不传 cwd，D1）。
   - 分支名已经过 D2 的正则校验，不含 `-` 前缀和 fnmatch 字符。for-each-ref 对没有匹配的 pattern 返回 0，所以非 0 退出一律视为探测错误。
   - 输出按行解析，只认**完全相等**的 refname（for-each-ref 的字面 pattern 也会匹配 `refs/heads/<b>/…`，要过滤掉）。解析上限 1 MiB 或 4096 行。
4. 条目通过的条件：`tips.get("refs/heads/" + branch) === entry.commit`。通过的条目 digest 放入 `verified: ReadonlySet<string>`。
5. **超时与零 hang**：`timeoutMs = min(settings.worktree.gitTimeoutMs, 5_000)` 同时交给 exec（杀进程）和 host 侧的 `withDeadline(timeoutMs + 500, clock)`（端口不遵守 timeout 时也能返回）。端口抛错、超时、非 0 退出、端口缺失（老的或假的 spawner）⇒ `verified` 为空，记录 `probeError`，**workflow 照常启动**，所有候选按 `worktree_unverified` 走 live。
6. 结果放进 `JournalRunConfig.isolationReplay = { mode: "verify", verified, nonce, stats }`。

**已接受的时间窗**：校验发生在 boot 之前，命中可能在几十分钟之后。其间用户删除或改写分支，命中照样发生（返回的分支名可能已经失效）。本方案不在命中时重新校验（理由见上），写入风险与文档。

### D5 判定顺序（`decideReplay`）

新的输入字段：`isolationReplay?: "verify"`（缺省即 off）、`isolationVerified?: (entry) => boolean`。

`noReplay` → `deterministic` → `experts` → `tainted` → **`isolation && mode off` ⇒ `skip:isolation_worktree`**（与现状相同）→ `configHashAvailable` → lookup → miss → **隔离条目的检查**：

- `entry.isolation === "worktree"` 且 `entry.worktree` 不存在 ⇒ `skip:isolation_worktree`（旧条目）；
- mode off ⇒ `skip:isolation_worktree`（off 模式下即使 journal 里有新条目也不读）；

→ `truncated` → TTL → **`entry.worktree.state === "committed"` 且没通过校验 ⇒ `skip:worktree_unverified`（新 reason）** → hit。

- 校验放在 TTL 之后，这样 `worktree_unverified` 只统计「本来可以命中」的条目，与 D4 候选的筛选口径一致。
- `clean` 条目在 TTL 检查通过后直接 hit。
- 非隔离调用不可能查到隔离条目（taskKey 不同），不需要额外防护。

### D6 下游链规则（核心改动）

**问题**：严格照 todo 原文（「校验通过才回放并不污染下游链；失败则重跑并按现有规则污染链」），首跑时隔离调用一定是 live，按现有规则会染色 ⇒ 下游不写 journal ⇒ 第二次运行时即使隔离调用命中，下游也没有条目 ⇒ 回放价值**要到第三次运行才出现**。最常见的「中途失败后续跑」场景因此拿不到收益。反过来，如果 live 的隔离调用干脆不染色，下游条目就会与「上游是哪一次隔离结果」脱钩：run 2 上游 `pending` 没写，run 3 上游命中了 run 1 的条目，但下游最新的条目来自 run 2，结果不一致。

**解法：`isoId` 折叠（只用于 chain scope）**

- 每个被接受（通过 D2 门）的隔离调用都有一个 `isoId`：
  - 回放命中 ⇒ `entry.worktree.isoId`；
  - live ⇒ `sha256(nonce + ":" + chainKey + ":" + occurrence).slice(0, 32)`，其中 `nonce` 是每次 run 的 `randomUUID()`，由 `buildJournalConfig` 生成。
- 在 D2 门通过之后（仍在同一个同步段内）执行 `chainDigest = nextChainDigest(chainDigest, "iso:" + isoId)`。
  - 隔离调用自身的查找键不受影响：`nextChainDigest(chainDigestBefore, taskKey)` 不变，`occurrence` 的计数键也不变。
  - 被拒绝的隔离调用（maxChildren、BW2、D2）**不折叠**，与方案 A「被拒绝的不染色」一致。
  - live 调用的 `isoId` 存进 `journalMetaOf`，在 settle 写入时进入 `entry.worktree.isoId`。
- 效果：
  - run N，隔离调用 live（`isoId` = X），下游**正常写 journal**，链里含 X。
  - run N+1，隔离调用命中 X（校验通过）⇒ 链与 run N 相同 ⇒ 下游命中。一致：下游当初依赖的正是 X 对应的、仍然完好的分支。
  - run N+1，隔离调用没有命中（未写、校验失败、TTL 过期、`noReplay`、`deterministic:false`）⇒ 新的 `isoId` Y ⇒ 下游全部 miss、live，并写到 Y 这条链下面。不需要显式染色，链自己保证了一致性。
  - run N 的上游 `pending` 没写，run N+1 上游命中更早的 X：下游只会命中 X 那一轮写的条目，而不是 run N 写在另一个 `isoId` 下面的条目。上文的不一致问题因此消除。
- chain scope 下，隔离调用（不论 live 还是命中）都**不再设置** `replayTainted`。

**content scope**：键里没有链，折叠无处可放。

- live 的隔离调用在 D2 门通过后仍然 `replayTainted = true`，与方案 A 相同，下游不读也不写；
- 校验通过的回放命中不染色；
- 隔离调用自身照常写 journal（D3），供下一次运行命中。
- 代价：content scope 下的收益仍然要到第三次运行才出现。content scope 本来就是非默认、会 WARN 的弱模式（`orchestrator.ts:557`），接受这一点。

**off 模式**：完全保持方案 A：不折叠、染色、不写、不探测。

### D7 回放命中时返回给脚本的形状

- `host_settle` 增加 `worktree`：
  - `committed` ⇒ `{ state: "committed", branch, commit }`；
  - `clean` ⇒ `{ state: "clean" }`；
  - 永远不带 `path`（`kept` 不写 journal），也不暴露 `isoId`。
- 普通调用（没有 `fullResult`）⇒ 字符串，与现在一致。
- `fullResult` ⇒ `{ text, runId: null, label: null, worktree }`。`runId: null` 已经是「这是回放」的现有信号，不再新增 `replayed` 键。`worker-source.ts` 已经会复制 `worktree`，**不用改**。
- `recordSettled({ source: "replay", …, worktree })`，outcome 的 worktrees 段因此能列出分支。`worktreeLineFor` 对 `source === "replay"` 渲染为 `label → <branch> (replayed @<sha7>)`，**不再**拼 `expected branch pi-agent-<callId>`；回放的 `clean` 与现在一样不列出。
- 回放命中不启动晚到监听，不占 maxParallel 槽位，也不写新的 journal 条目（与普通命中相同）。
- 如果 `worktreeAvailable()` 在命中时为 false ⇒ 不返回 hit，计入 skipped，落到 D2 门，以 `isolation_unavailable` 拒绝。这样「worktree 关闭时隔离调用一律拒绝」（v2.1 决定 1）不因 journal 里有没有条目而变化。实现上在 hit 分支开头判断 `isolation !== undefined && deps.spawner.worktreeAvailable?.() !== true`；这时**不折叠** `isoId`，因为这个调用随后会被拒绝。

### D8 与 experts 规则的交互

- experts 的染色（`host.ts:1016-1022`）**完全不变**，它仍然同时作用于读和写，并先于隔离检查。
- 已被 experts 染色之后提交的隔离调用 ⇒ `skip:chain_tainted`，不写 journal（`journalMetaOf` 条件仍然包含 `!replayTainted`），也不折叠。chain 已经被染色，折叠没有意义，但为了让代码路径简单，照样折叠也不影响结果。实现时统一为「D2 通过就折叠」。
- 同时带 `experts` 和 `isolation` 的调用 ⇒ `skip:experts`，不写 journal，并由 experts 染色。
- 回放的隔离调用没有 runId：后续 `experts:[该 label]` 按现有规则拒绝（expert-scope 会拒绝没有 completed run 的同名调用），这与任何回放调用的现有行为一致（工具描述里「pass noReplay: true to force the whole run live」同样适用）。
- `replay-taint.property` 需要改写：chain scope 下，被接受的隔离调用不再是染色源；content scope 下，live 的隔离调用仍是染色源。

### D9 设置开关

- `workflow.isolationReplay: "verify" | "off"`，推荐默认 `verify`（§8 Q1）。
- `settings.ts`：`WorkflowSettings` 增加字段、设置默认值、逐字段 parse，非法值回落到默认值并 WARN 一次。`setting-specs.ts` 增加一项 `choice`。
- 读取时机：`stack.ts` 把 `() => settings.workflow.isolationReplay` 传给 `createWorkflowChildSpawner`（与 `worktreeAvailable` 的写法相同，每次调用都读实时值）。每个 workflow run 在 `buildJournalConfig` 时读取一次，整个 run 期间不变。
- 不新增工具参数：只有 `journal` 已开启的 run 才受影响，逐 run 关闭用现有的 `noReplay`。

### D10 零 hang

- 新增的 await 只有 D4 的探测：exec 超时和 `withDeadline` 双重上限，最多约 5.5 秒，失败时降级为 live。
- H3 仍然是报告前最多 5 条命令，D5 和 D5a 的时域不变。
- 命中路径保持同步。journal 写入仍是 fire-and-forget（JS1）。

### D11 文档与描述

- `workflow-tool.ts:78-79` 的描述改为：隔离调用的结果只有在 `committed`（分支仍然精确指向记录的 commit）或 `clean` 时才会被写入和回放；否则当次重跑，并且只让依赖它的下游重跑。
- AGENTS.md 的 `src/workflow/` 段：「an accepted isolation call taints the rest of the run's replay chain … never journaled/replayed」改为选项 C 的描述。
- `skills/dev-flow/references/subagent-workflow.md`：更新 journal 与 isolation 的说明。
- `docs/dev/workflow-worktree/plan.md` 的 §0 决定 4 后面追加一行「已由 replay-verify-plan.md 取代（设置 off 时仍为方案 A）」。只追加，不改动已定决定的原文。

## 3. 场景

| 场景                                                   | 结果                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支完好，指向记录的 commit                            | 通过，命中，下游（chain）继续命中。                                                                                                                                               |
| 用户合并了分支但没删                                   | 通过（ref 没变）。调度方再合并一次会得到「Already up to date」，无害。                                                                                                            |
| 合并后删除分支（包括 squash 和 rebase 合并）           | 不通过 ⇒ live。子 run 基于已经包含这些改动的 HEAD 重做，通常得到 `clean` 或很小的 diff，会产生新分支。代价是重复一次子 run。见 §8 Q2（是否把「commit 已是 HEAD 祖先」也算通过）。 |
| 分支被 rebase 或强推（指向别的 commit）                | 不通过 ⇒ live，下游（chain）随之 miss。                                                                                                                                           |
| 分支上追加了提交（tip 是记录 commit 的后代）           | 默认不通过（精确相等）。见 §8 Q2。                                                                                                                                                |
| 仓库整体移动了目录                                     | ref 随仓库一起移动，cwd 是新位置 ⇒ 照常通过。journal 按 namespace 存放，与路径无关。                                                                                              |
| 在另一个 clone 里用同一个 journal namespace            | 分支不存在 ⇒ live；如果恰好有同名分支并且 sha 相同，说明内容相同，通过也是正确的。                                                                                                |
| 在不是 git 仓库的目录里运行                            | for-each-ref 非 0 退出 ⇒ `verified` 为空 ⇒ live，随后 H2 按现有规则 `failed(config)` ⇒ `null`。                                                                                   |
| 探测期间 git 卡住（锁、NFS）                           | 5 秒后降级为 live，workflow 不受影响。                                                                                                                                            |
| 手工编辑 journal，塞进任意分支名                       | 正则校验不通过 ⇒ corrupt；能通过校验的名字只会进入 for-each-ref 的 refname 参数，不会被当成 git 选项。digest 不是 MAC，能伪造条目的人本来就能伪造 value，这不在威胁模型内。       |
| 校验通过后、命中之前，分支被删                         | 仍然命中（已接受的时间窗，D4）。                                                                                                                                                  |
| 同一个键有多条隔离条目，最新一条校验失败、更早一条完好 | live（索引只保留最新一条），不回退到旧条目。                                                                                                                                      |

## 4. 接口变更汇总

```ts
// src/core/types.ts
WorktreeDisposition.commit?: string ; WorktreeDisposal.commit?: string          // 只在 committed 时填写
// src/adapters/worktree-disposition-sink.ts
LateWorktreeDisposition.commit?: string
// src/workflow/types.ts
ChildWorktreeInfo.commit?: string
JournalEntry.worktree?: { state:"committed"; branch; commit; isoId } | { state:"clean"; isoId }
WorkflowReplayStats.isolation?: { probed: number; verified: number; unverified: number; probeError?: string }
// src/workflow/journal.ts
BuildEntryInput.worktree? ; parseEntry 白名单 + 形状校验
// src/workflow/replay.ts
ReplayDecision.skip.reason += "worktree_unverified"
DecideReplayInput.isolationReplay?: "verify" ; isolationVerified?: (e: JournalEntry) => boolean
ReplayIndex.isolatedCandidates(): readonly JournalEntry[]
// src/workflow/isolation-verify.ts（新）
collectProbeRefs(candidates, cap) ; parseForEachRef(stdout, wanted) ; verifyIsolatedEntries(candidates, probe, { timeoutMs, clock })
// src/workflow/host.ts
ChildSpawner.probeAgentBranches?(branches: readonly string[], o: { timeoutMs: number }): Promise<{ ok: true; tips: ReadonlyMap<string,string> } | { ok: false; error: string }>
ChildSpawner.isolationReplayMode?(): "verify" | "off"
JournalRunConfig.isolationReplay?: { mode: "verify"; verified: ReadonlySet<string>; nonce: string; stats }
HostSettleEnvelope.worktree 在回放命中时同样携带
// src/config/settings.ts
WorkflowSettings.isolationReplay: "verify" | "off"
```

## 5. 包拆分（串行 P1 → P2）

`src/workflow/types.ts` 和 `src/workflow/spawner-adapter.ts` 两个包都要改，而且 P2 依赖 P1 产出的 `commit`，所以串行进行。

- **P1 `wt-commit-sha`**：D1 全部内容（H3 调整顺序并产出 sha，四处透传，`ChildWorktreeInfo.commit`）。
- **P2 `wf-replay-verify`**：D2 到 D11（journal、replay、host、orchestrator、新模块、设置、stack 端口接线、渲染、描述与文档）。

```json
[
  {
    "id": "wt-commit-sha",
    "globs": [
      "src/core/types.ts",
      "src/extensions/worktree.ts",
      "src/service/spawn-service.ts",
      "src/service/runtime-adapter.ts",
      "src/adapters/worktree-disposition-sink.ts",
      "src/workflow/spawner-adapter.ts",
      "src/workflow/types.ts",
      "tests/extensions/worktree.test.ts",
      "tests/extensions/worktree-git-integration.test.ts",
      "tests/service/spawn-worktree-wait.test.ts",
      "tests/adapters/worktree-disposition-sink.test.ts",
      "tests/integration/worktree-late-dispose.test.ts",
      "tests/workflow/spawner-adapter.test.ts"
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
      "tests/workflow/host-worktree.test.ts",
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

### 5.1 开工前冲突预检

在仓库根目录执行，每条命令都加 timeout：

````sh
# ① 提取 spec；两包之间的交集只能是已声明的串行重叠
awk '/^```json/{f=1;next} /^```/{f=0} f' docs/dev/workflow-worktree/replay-verify-plan.md > /tmp/wf-rv-spec.json
timeout 60 node skills/dev-flow/scripts/conflict-check.mjs /tmp/wf-rv-spec.json
# ② 本包文件在工作区里不能有别人的未提交改动（以 P2 为例）
node -e 'const s=require("/tmp/wf-rv-spec.json").find(p=>p.id===process.argv[1]);console.log(s.globs.join("\n"))' wf-replay-verify \
  | xargs git status --short --
# ③ 与在途的 child-context-switch 包（docs/dev/child-context-switch/plan.md）同时进行时：把它的 {id,globs} 追加进 spec，只保留「本包 + 它」再跑一次
````

**失败判据**：

- ① 预期退出码为 1，交集**只能是** `src/workflow/types.ts` 和 `src/workflow/spawner-adapter.ts`（wt-commit-sha × wf-replay-verify）。出现其他交集或退出码 2 ⇒ 停下来修订方案。
- ② 有任何输出 ⇒ 停下来，弄清是谁的改动，改到 worktree 里开发（见 memory pitfalls）。
- ③ 已知潜在重叠：child-context-switch 方案涉及 `src/stack.ts`、`src/service/runtime-adapter.ts`、`src/core/types.ts`、`src/config/settings.ts`。退出码不为 0 ⇒ 不能并行，排队进行，或者在 worktree 里开发之后 rebase。本方案对这四个文件的改动都很小（新增字段、复制键、一段端口接线），rebase 成本低。
- 前一个包必须已经 `--ff-only` 合入 master，并在干净的 worktree 里通过四道门禁，下一个包才能开工。

## 6. 测试清单

**P1 `wt-commit-sha`**：

1. worktree.test（exec spy）：
   - dirty 路径的命令序列为 `status → switch -c → add → commit → rev-parse HEAD`，报告 `{committed, branch, commit}`；
   - 末尾的 rev-parse 非 0 或抛错 ⇒ 仍是 `committed`，没有 `commit` 键，`worktree remove` 照常执行；
   - clean 且 HEAD 前进 ⇒ `status → rev-parse → branch`，`commit === currentHead`；
   - clean 且 HEAD 没变 ⇒ `clean`，没有 `commit`；
   - clean 路径的 rev-parse 失败 ⇒ `kept`（与现状相同）；
   - `baseHead` 缺失 ⇒ 走 committed 路径；
   - linkPaths 的排除 pathspec 仍然存在。
2. worktree-git-integration（真实 git）：`commit` 等于 `git rev-parse pi-agent-<id>`；子 agent 自己提交的场景下 `commit` 等于它的 HEAD；已有的慢 hook 用例（`kept`，以及调大 reapMs 后 `committed`）仍然是绿的。
3. spawn-worktree-wait：mark 与 wait 都保留 `commit`；`late` 时域的数值不变（reapMs=2000 ⇒ 11000）。
4. worktree-disposition-sink 与 integration/worktree-late-dispose：晚到的 sink 条目包含 `commit`。
5. spawner-adapter：`awaitWorktree` 映射 `commit`；缺失时没有这个键。

**P2 `wf-replay-verify`**：

6. journal.test：
   - 带 `worktree` 的条目往返时 digest 稳定；
   - 分别篡改 `branch`、`commit`、`isoId`、`state` ⇒ corrupt；
   - 非法分支名（`-x`、`pi-agent-a*`、`pi-agent-../x`）、非 hex 的 commit、多余的键、没有 `isolation` 却有 `worktree` ⇒ corrupt；
   - 非隔离条目的字节与现状一致（fixture 对比）；
   - 「旧解析器」（按 v1 白名单复算，不认识 `worktree`）读新条目 ⇒ corrupt。
7. replay.test：
   - 判定顺序全表：off 模式下 `isolation:true` 从不调用 lookup；verify 模式下 lookup 之后的顺序是 旧条目 → off → truncated → TTL → 未校验 → hit；
   - `clean` 不需要校验就命中；
   - `worktree_unverified` 是新的 skip reason；
   - `isolatedCandidates` 只返回去重后仍有效、committed、没有 truncated、在 TTL 内的条目。
8. isolation-verify.test：
   - `parseForEachRef` 只认精确相等的 refname（`refs/heads/pi-agent-a/x` 不算）；
   - 上限：256 个 ref、1 MiB 或 4096 行；
   - 端口抛错、非 0 退出、端口缺失、永不 resolve（FakeClock 推进到 timeout+500）⇒ `verified` 为空并带 `probeError`，而且 promise 按时返回；
   - 候选为空、off、`noReplay`、`worktreeAvailable` 为 false ⇒ 端口调用次数为 0。
9. host-worktree（chain scope）：
   - **首跑写下游**：run 1 隔离调用 live 并 `committed` ⇒ 写入隔离条目（带 branch、commit、isoId），**下游也写入**，`stats.tainted` 不存在；
   - run 2 校验通过 ⇒ 隔离调用命中，settle 带 `worktree:{committed, branch, commit}`，下游全部命中，spawner 调用次数为 0；
   - run 2 校验失败 ⇒ 隔离调用 live（新的 `isoId`），下游全部 miss、live，并写到新链下面；
   - 隔离调用 `pending`、`kept` 或缺 `commit` ⇒ 不写隔离条目，下游照写；run 3 上游命中 run 1 的条目时，下游命中的是 run 1 的条目而不是 run 2 的（`completedAt` 比较）；
   - 被拒绝的隔离调用（D2 门、maxChildren、BW2）不折叠：下游的键与「该调用不存在的一次运行」中的键逐字节相同；
   - 命中时 `worktreeAvailable` 为 false ⇒ 以 `isolation_unavailable` 拒绝，计入 skipped，不折叠；
   - `clean` 的条目命中不跑探测。
10. host-worktree（content scope）：live 的隔离调用仍是染色源，下游不写；校验通过的命中不染色；隔离调用自身照样写入。
11. host-worktree（experts 交互）：experts 染色之后提交的隔离调用 ⇒ `chain_tainted`，不写；同时带 experts 和 isolation 的调用 ⇒ `skip:experts`；回放的隔离调用的 label 被后续 `experts` 引用 ⇒ 按现有规则拒绝。
12. host-worktree（off 模式）：与方案 A 逐字节一致。已有的 D3 用例全部原样保留，并以 off 模式参数化运行。
13. replay-taint.property（改写）：随机生成的提交序列上满足以下不变量：
    - 任何命中的下游，其前面每个被接受的隔离调用在本次运行中都命中了与记录时相同的 `isoId`；
    - content scope 下 live 的隔离调用是染色源；
    - experts 规则不变。
14. journal-replay-e2e（真实 journal 文件 + 假 spawner + 假探测）：跑三次（live、命中、删除分支后），检查 journal 行数和各次命中数；换成旧解析器读取同一个文件时，新条目计为 corrupt。
15. orchestrator.test：`buildJournalConfig` 只在有候选时调用探测；探测挂住时，boot 在 timeout+500 之后照常开始；`outcome.replay.isolation` 统计正确。
16. workflow-tool.test：回放行渲染为 `label → pi-agent-x (replayed @abcdef1)`，不带 expected branch；描述里不再出现「never journaled or replayed」；`replay:` 行在有 `isolation` 统计时追加 `, N wt-verified, N wt-unverified`（英文标记）。
17. workflow-settings：`isolationReplay` 的默认值、合法值、非法值回落并 WARN；setting-specs 里有这一项。
18. **integration/workflow-worktree-replay（真实 git + 真实 worktree 扩展 + 假 driver）**：
    - run 1 隔离子 run 改一个文件 ⇒ 生成 `pi-agent-*` 分支，journal 带 sha；
    - run 2 命中，并且 `git worktree list` 里没有新增的 worktree；
    - `git branch -f` 把分支指向别的 commit ⇒ run 3 live，生成新分支；
    - `git branch -D` ⇒ live；
    - 把仓库 `mv` 到新目录并以新 cwd 运行 ⇒ 命中；
    - 在非 git 目录运行 ⇒ 降级且不 hang。

**门禁**：每个包在干净的 worktree 里通过 `npm run format:check && npm run typecheck && npm test && npm run build`。

## 7. 风险

- **行为变化**：`verify` 默认开启后，带 journal 的 workflow 在隔离调用之后开始回放（这正是本需求的目的）。需要旧行为时设为 `off`，或者逐 run 使用 `noReplay`。
- **回放拿到的分支来自上一次运行**：它可能已经被调度方合并过，也可能基于较旧的 HEAD。与普通调用回放「不检查仓库状态」的现有语义一致。outcome 用 `(replayed @sha7)` 明确标出。
- **校验到命中之间的时间窗**：见 D4，已接受。
- **`clean` 与 linkPaths**：违反只读约定、写进 linkPaths（例如 node_modules）的改动不被跟踪，H3 会判为 `clean`，回放时不会重现这一副作用。这是 D9 已接受风险的延伸。
- **journal 降级不兼容**：旧版本把新条目当成 corrupt 行，`corruptLines` 上升，但不会错误回放。
- **content scope 仍要第三次运行才有收益**：弱模式，已接受。
- **squash 或 rebase 合并后删除分支**：会重复一次子 run（§8 Q2）。
- **H3 命令顺序调整**：P1 改动了经过数据丢失修复的代码路径。测试 1 和 2 用真实 git 锁定「HEAD 前进但工作区干净」时照样生成分支。

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
