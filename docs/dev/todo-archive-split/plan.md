# todo 持久化 · 归档任务分离存储：实施方案 v1（#92）

> **需求摘要**
>
> - 问题：todo 每次变更都写一份全量快照（实测最新一条 39.2 KB，其中 92% 是归档任务；444 次写入里 420 次只改了 1 个 task），toolResult 的 `details.state` 里还内嵌一份全量（变更写两份，只读调用写一份）。
> - 目标：① 主快照 `claude-code-todo-state` 只含 live 任务；② 归档任务改为增量分离存储（新 customType）；③ 同包做两个正交快赢：新写入不再带 `details.state`（读回兼容保留），live 快照内容相同就不写。
> - 不做：不改 `claude-code-todo-state` 的字符串与"最后合法候选胜出"读语义（I7/D3）；不动 wire（I10）；`todo.enabled=false` 保持 byte-identical（I9）；不把归档任务压成墓碑。
> - 依据：`explore-report.md`（机制、约束、先例都以它为准）、`../todo-archive/plan.md` D1–D9、`../todo-web/README.md`。
> - 待拍板：§9 OD1–OD4。**OD1 降级口径推荐 (c)**：持久化时剥离跨存储边，读回时从归档侧复接。

## 0. 现状要点（file:line，基于 dev 当前工作区）

| 位置                                  | 现状                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/todo/state.ts:50`                | `STATE_ENTRY = "claude-code-todo-state"`；data = `{tasks, nextId}`，无 `v`                                               |
| `state.ts:310-373` `restoreState`     | 逐 task 白名单重建（任一 task 坏 ⇒ 整条 undefined）→ `validateState` → 抛错 ⇒ undefined                                  |
| `state.ts:376-393` `replayState`      | 单遍扫描，custom 条目与 toolResult `details.state` 两种形状，**最后一个合法候选胜出**                                    |
| `state.ts:395-410` `validateState`    | id 唯一、依赖目标必须在同一数组、双向一致、无环（`validateDependencyGraph` :428）                                        |
| `src/todo/index.ts:244-269` `restore` | `commit(replayState(branch) ?? emptyState())`，不写盘                                                                    |
| `index.ts:272-274` `persist`          | `pi.appendEntry(STATE_ENTRY, cloneState(state))`（`appendEntry` 同步，返回 void）                                        |
| `index.ts:335-345` `sweep`            | `archiveCompleted` → `commit` → `persist` → `refreshWidget`，try/catch                                                   |
| `index.ts:347-353` / `:383-394`       | `successfulResult` 和 `registerMutation.execute` 都把 `state: cloneState(state)` 塞进 `details`（TaskList/TaskGet 也带） |
| `index.ts:385`                        | `if (persistState && result.changed !== false) persist();`                                                               |
| `index.ts:526-533`                    | `/tasklist clear`：`commit(clearTasks(state)); persist();`                                                               |
| `index.ts:559-564`                    | `session_compact`：`serialize(() => { restore(ctx); if (onCompact) sweep("all"); })`                                     |
| 读者 ①                                | `index.ts:262` restore                                                                                                   |
| 读者 ②                                | `src/context-switch/session-facts.ts:78-85`（只列未完成任务）                                                            |
| 读者 ③（探索报告漏列）                | `src/topic-switch/hold.ts:138` `buildBranchView` → `todoInProgress`                                                      |

三个读者都只调 `replayState(branch)`。只要合并逻辑收口在 `replayState` 内部，②③ 不用改代码。

## 1. 总体设计（一句话）

**内存模型完全不变**：闭包里的 `state` 仍是含归档任务的完整 `TodoState`，所以 UI、投影、TaskGet、依赖计算、D7 全都不动。**只改持久化形态**：

- live 任务写 `claude-code-todo-state`；
- 归档任务按增量包写新的 `claude-code-todo-archive`；
- 读回时在 `replayState` 里按 fold → merge → 复接 → 校验的顺序还原出完整 state。

## 2. Entry 设计

### 2.1 归档包（新）

- customType：`ARCHIVE_ENTRY = "claude-code-todo-archive"`。沿用 `claude-code-todo-*` 家族前缀，不用 `subagent:*`，因为它属于 todo 插件的数据命名空间。在 `state.ts` 导出常量。
- payload v1：

```ts
interface TodoArchiveEntryV1 {
  v: 1;
  reset?: true; // fold 时先清空归档集（/tasklist clear 用）
  put?: Task[]; // upsert：整条 task 覆盖（归档包里存的是完整 task，不是墓碑）
  drop?: number[]; // 从归档集删除
}
```

- **fold 语义**：同一个包内按 `reset → put → drop` 的顺序应用；包与包之间按分支顺序应用。写入方保证同一个包里同一 id 不会既 put 又 drop。
- **sanitize**（`sanitizeArchiveEntry(raw)`，fail-closed，照 `prompt-sections/store.ts` 的 `v:1` 先例）：
  - 不是对象，或 `v !== 1` ⇒ 整包忽略（视为没见过这个包，见 §3 的 `sawArchive`）；
  - `reset` 必须 `=== true`，否则只丢这个字段；
  - `put` 必须是数组，否则只丢这个字段。数组里每个元素走 `restoreTask`（从 `restoreState` 里抽出来的逐 task 白名单，§4.1），并额外要求 `status === "completed"` 且 `archivedAt` 是有限数。**不合格的元素逐个丢弃**，包仍有效，沿用 D2 "单字段可丢、候选仍有效"的口径；
  - `drop` 必须是数组，否则只丢这个字段。元素只保留正整数 id 并去重；
  - 读回时不对 put 数量设帽（截断就是丢数据），上限只在写入侧执行（§6）。
- 前向兼容规则：v1 读者遇到 `v:2` 会整包忽略。所以将来升到 v2 时，必须保证"被 v1 读者忽略也安全"，否则换新 customType。这一条写进代码注释。

### 2.2 live 快照（字符串不变，内容收窄）

- data = `{ v: 1, nextId, tasks }`。`tasks` 只放**未归档**任务（open 加未归档的 completed）。**跨存储边被剥离**：live 任务的 `blocks/blockedBy` 只保留指向 live 集合内 id 的边（§5 的 OD1-c）。
- `v: 1` 只是标记，读者从不依赖它。`restoreState` 的白名单只读 `tasks/nextId`，旧版读者会自然忽略它。是否加这个标记见 OD3（推荐加）。
- `nextId` 仍是高水位（D9），旧版读者回落时也不会复用 id。

### 2.3 toolResult `details`（快赢 ①）

- `ToolDetails`（`index.ts:128`）删掉 `state` 字段。`successfulResult`（:352）和 `execute`（:392）不再写 `state: cloneState(state)`，`action/task/changed/error/unblocked` 照旧。
- 读回端 `replayState` **保留**第 2 种历史形状（toolResult `details.state`）的兼容读：旧会话还在用，新写入里没有这个字段，自然跳过。
- 消费面核实：`renderResult` 只读 `details.error/task`；web 转写对 details 只做截断展示，不解析 state；仓内除 `tests/todo` 外没有别的读者。

## 3. 读路径：`replayState` 的三段 fold + merge + 校验

### 3.1 API 形状

- 新增导出 `replayTodo(entries) → { state: TodoState | undefined; archived: ReadonlyMap<number, Task>; degraded: boolean }`，供 `index.ts` 的 restore 使用（要拿归档基线，§4.2）。
- `replayState(entries) = replayTodo(entries).state`，签名不变。session-facts 与 hold.ts 都不用改。
- `restoreState` 的**导出行为不变**（白名单 + `validateState`），现有 `state.test.ts` 的 restoreState 用例一条不动。内部拆成 `restoreTask(raw)` + `restoreShape(value)`（白名单，不做图校验）+ `validateState`。
- `validateState` 函数本体一行不改。所谓"重排"只是**调用点**变了：从"每个候选单独校验"挪到"合并后再校验"。

### 3.2 精确语义

```
replayTodo(entries):
  // 段 1：单遍扫描，按分支顺序
  A = Map<id, Task>(); sawArchive = false; candidates = []
  for entry of entries:
    custom & ARCHIVE_ENTRY      → e = sanitizeArchiveEntry(data); if e: sawArchive = true; fold(A, e)
    custom & STATE_ENTRY        → c = restoreShape(data);          if c: candidates.push(c)
    toolResult(!isError).details → c = restoreShape(details.state); if c: candidates.push(c)

  // 段 2：旧会话路径（没有任何合法归档包）——与今天逐字节一致
  if !sawArchive:
    for c of candidates from last: if valid(c) return { state: c, archived: A(空), degraded: false }
    return { state: undefined, ... }

  // 段 3：分离会话路径
  for c of candidates from last: m = merge(c, A); if valid(m) return { state: m, archived: A, degraded: false }
  // 降级：忽略归档集，按今天的规则只读 live（"绝不比不读归档更差"）
  for c of candidates from last: if valid(c) return { state: c, archived: A, degraded: true }
  return { state: undefined, archived: A, degraded: true }
```

- `valid(x)` = `validateState(x)` 不抛异常。
- **段 2 的等价性证明**：今天的实现是"`restoreState` = 白名单 + 校验，最后一个通过的候选胜出"；段 2 是"白名单通过的进候选列表，从后往前找第一个通过校验的"。两者在候选集合与胜出规则上完全相同，结果 deep-equal。§8 用一份冻结的旧实现副本做 fuzz 来证明。
- 段 2 里**不做**宽容修复、不排序、不修改 nextId。宽容读只对分离会话生效，这样旧会话的行为不会因为"顺手修复"而改变（OD4 说明为什么不扩大到旧会话）。

### 3.3 `merge(c, A)`

1. **id 冲突时 live 胜**：`tasks = clone(c.tasks)`，再加上 `A` 中 id 不在 `c` 里的任务（标记为 A 来源）。被 live 覆盖的归档副本整条忽略。重开（unarchive）因此可以自愈，崩溃窗口里出现的双份也由此消解。
2. 按 id 升序排序。今天的存储顺序本来就是创建顺序，也就是 id 升序（`createTask` 只会 push），所以合并结果与写盘前的内存顺序一致。
3. **复接 + 宽容**：只处理 **A 来源**任务 `y` 的边：
   - `y.blocks` / `y.blockedBy` 里指向合并集合中不存在的 id ⇒ **丢掉这条边**（宽容读）；
   - 指向 live 来源任务 `t` 的边 ⇒ 若 `t` 上缺少对向边，就补上（`t.blockedBy ∋ y.id` / `t.blocks ∋ y.id`，用 push）；
   - live 来源任务自己的边一律不动。新写入的 live 快照本来就不含跨边。旧形态的 live 快照里，跨边两端都在同一快照内。如果 live 侧出现悬空边，说明数据损坏，交给 `validateState` 拒绝，与今天一致。
4. `nextId = max(c.nextId, maxId + 1)`。
5. 复接只会补齐**已有边的对向**，不会凭空产生新的有向关系。所以只有损坏组合才可能成环，成环时由 `valid()` 拒绝并走回落。

**边数组顺序**：复接补上的边追加在数组末尾，所以 round-trip 只保证"边集合相等"，不保证顺序。这样做是安全的：复接的边一定指向归档任务，归档任务都是 completed，而所有展示面只用 `activeBlockers`（completed 不算阻塞），所以这类边的顺序在任何输出里都看不到（`web-hub/agent/todo.ts:101`、`index.ts` `formatTaskLine`、`ui.ts`）。

## 4. 写路径

### 4.1 纯函数（`src/todo/state.ts` 与新文件 `src/todo/persist-plan.ts`）

- `state.ts`：
  - 新增 `ARCHIVE_ENTRY`、`TODO_ARCHIVE_CAP`、`TodoArchiveEntryV1`；
  - 新增 `restoreTask`（由 `restoreState` 的循环体抽出，字段顺序固定，同时作为规范化序列化 `canonicalTask`）、`restoreShape`、`sanitizeArchiveEntry`、`foldArchive`、`mergeArchive`、`replayTodo`；
  - 新增 `evictArchived(state, cap)`；
  - `replayState` 改为包装 `replayTodo`。
- `persist-plan.ts`（只 import `state.ts`，避免循环依赖）提供：

```ts
planPersist(state, archiveBase: ReadonlyMap<number, string>, liveKey: string | undefined) → {
  pre?:  TodoArchiveEntryV1;  // puts + 消失 id 的 drop（或 reset）
  live?: { v: 1; nextId: number; tasks: Task[] };  liveKey: string;
  post?: TodoArchiveEntryV1;  // 移回 live 的 id 的 drop
}
```

`planPersist` 的计算规则（`key(t) = JSON.stringify(canonicalTask(t))`）：

- `archived = state.tasks.filter(isArchived)`；`ids` 为 state 中全部 id；`liveIds` 为未归档任务的 id。
- `puts = archived.filter(t => archiveBase.get(t.id) !== key(t))`：新归档的任务，以及内容有变化的归档任务（编辑、加/删边、邻居被删导致的边裁剪）。
- `gone = archiveBase` 中不在 `ids` 里的 id（被删除或被驱逐）。
- `moved = archiveBase` 中在 `liveIds` 里的 id（被重开）。
- 当 `archiveBase.size > 0`、`gone` 覆盖了整个 base、且 `moved` 为空时 ⇒ `pre = {v:1, reset:true, put?}`（典型场景是 clear）。否则当 `puts` 或 `gone` 非空时 ⇒ `pre = {v:1, put?, drop?: gone}`。
- live 快照 = 未归档任务经 `canonicalTask` 规范化，`blocks/blockedBy` 过滤到 `liveIds` 以内；`liveKey' = JSON.stringify(live)`；仅当 `liveKey' !== liveKey` 时输出 `live`（快赢 ②）。
- `moved` 非空 ⇒ `post = {v:1, drop: moved}`。

### 4.2 `index.ts` 闭包

- 新增 `let archiveBase = new Map<number, string>()`、`let liveKey: string | undefined`，作用域在闭包内（I4）。
- `persist()`：依次处理 `pre → live → post`。**每成功 append 一条，就立刻把它应用到对应基线上**。若中途 `appendEntry` 抛错，基线停在已写入的位置，下一次 persist 会自动补写剩余部分（幂等收敛）。
- `restore()`：`const r = replayTodo(branch)`，然后 `commit(r.state ?? emptyState())`。`archiveBase` 的设置分两种情况：
  - `degraded=false`：设为 `r.archived` 每项的 `key`，**包含被 live 覆盖的副本**，这样下一次 persist 会给它发 `moved` drop 来自愈；
  - `degraded=true`：设为**空 Map**，并 `console.warn` 一次。原则是"读不出来的东西绝不主动 drop"。
  - `liveKey` 一律设为 `undefined`，即 restore 之后的第一次 persist 一定写 live。这样可以覆盖三种情况：选中的候选不是最后一条、旧形态快照里含有归档任务（迁移）、toolResult 形状。restore 本身仍然不写盘。
- 与 `serialize()/commit()` 的关系：
  - `persist` 只在串行任务内被调用。现状已经满足：TaskCreate、各 mutation、clear 都走 `enqueue`，sweep 走 `serialize`。一次 persist 的 2–3 次 `appendEntry` 是同步连续调用，中间不会插入其他条目。
  - `commit` 仍是唯一给 `state` 赋值的地方，驱逐也经过 `commit`。
  - 两个基线只在 `persist`（串行内）和 `restore`（会话边界）里改写，与 R6 的论证一致。
- `sweep(ids)`：`next = evictArchived(archiveCompleted(state, ids, now), TODO_ARCHIVE_CAP)`；`next === state` 就直接 return；否则 `commit → persist → refreshWidget`。
- `registerMutation`（:385）的 `persist()` 调用点保持原样。persist 内部可能什么都不写（例如编辑归档任务时 live 不变，只写 put）。
- clear（:530）不需要单独加代码：`clearTasks` 之后，`planPersist` 会自然产出 `reset`（base 非空时）和空 live。**测试必须钉住这一点**，它是探索报告点名的易漏点。

### 4.3 写路径清单（统一顺序 **pre → live → post**）

顺序规则："把任务写进新位置"的条目先写，"把任务从旧位置移走"的条目后写。这样崩溃时最多出现双份（由 live 胜消解），不会丢。删除和驱逐的 drop 与邻居的 put 放在**同一个包**里，保证原子。

| #   | 场景                                                                                   | 写入                                                                                   | 崩溃在两条之间时的读回                                                       |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | 普通变更（live 任务的增/改/完成/删）                                                   | live（被删的 live 任务若与归档任务有边：pre put 邻居 → live）                          | pre 已写、live 未写：邻居已裁边，旧 live 里任务还在 ⇒ 等于删除尚未生效，无害 |
| 2   | sweep 归档（压缩时 / 第 N 轮）                                                         | pre `{put: 新归档任务, drop: 驱逐的 id}` → live（不含这些任务）                        | live 胜 ⇒ 表现为未归档的 completed，良性                                     |
| 3   | 编辑归档任务（subject/描述/owner/metadata）                                            | pre `{put:[X']}`；live 不变，由去重跳过                                                | 单条原子                                                                     |
| 4   | 重开归档任务 X                                                                         | live（含 X）→ post `{drop:[X]}`                                                        | A 中残留的 X 被 live 覆盖；下次 persist 的 `moved` 再补发 drop               |
| 5   | 删除归档任务 X                                                                         | pre `{put: 边被裁的归档邻居, drop:[X]}`；live 邻居的跨边本来就被剥离，live 不变 ⇒ 跳过 | 单条原子                                                                     |
| 6   | `/tasklist clear`                                                                      | pre `{reset:true}`（base 非空时）→ live `{tasks:[], nextId}`                           | 归档集已清空、live 还是旧的 ⇒ 部分清除，良性                                 |
| 7   | live 与归档之间加/删边（TaskCreate `blockedBy` 指向归档 id，或 TaskUpdate add/remove） | pre `{put:[X']}`；live 侧跨边被剥离 ⇒ 不变 ⇒ 跳过（Create 时 live 也有变化，照写）     | 复接从 X' 补齐边；live 那边新建的任务若还没落盘，X' 上指向它的边被宽容丢弃   |
| 8   | 旧会话首次 persist（迁移）                                                             | pre `{put: 全部归档任务}`（一次性，最多约 36 KB）→ live                                | 同 #2                                                                        |
| 9   | 驱逐（只在 sweep 中，随 #2 一起）                                                      | 合进 #2 的 pre 包                                                                      | 原子                                                                         |
| —   | restore / TaskList / TaskGet                                                           | 不写                                                                                   | —                                                                            |

## 5. 降级口径（OD1，需用户拍板）

| 方案                              | 做法                                                                                     | 旧版扩展读新会话                                                                                                                                                      | 代价                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) live 保留跨边 + 宽容读        | live 快照照原样带指向归档 id 的边                                                        | 旧版 `validateState` 碰到悬空边会拒收，于是回落到更早一条自洽的快照（通常是升级前的全量快照，也就是**过时状态**）；回落不到就整段为空。数据还在盘上，升级后恢复       | 旧版在过时状态上继续写，可能产生 nextId 回退 ⇒ **id 与归档任务冲突**，再升级时 live 胜会把同号的归档任务遮掉（真丢）                             |
| (b) 归档时剪掉跨边（语义改变）    | 内存里也把 live 与归档之间的边剪掉                                                       | live 自足，旧版读取正常                                                                                                                                               | 改变 D7 语义：重开后依赖消失；TaskGet 看不到边；还得处理"给归档任务加边"（要么禁止，要么立刻剪）                                                 |
| **(c) 推荐：落盘剥离 + 读回复接** | 内存语义不变；只是 live 快照落盘时剥离跨边，跨边的权威副本放在归档侧，读回时复接（§3.3） | live 自足，旧版正常读出全部 open 和未归档 completed 任务，只有归档任务暂时看不见（计数、`TaskGet <归档id>` 失效）；**nextId 高水位保留，不会复用 id**；升级后完整恢复 | 多约 25 行复接代码；新增不变式"跨边以归档侧为准"。依据：所有改跨边的操作（connect/remove/delete）都是双向修改，必然会改到归档任务 ⇒ 必然产生 put |

**推荐 (c) 的理由**：

1. 内存语义、D7、TaskGet 和重开都零变化；
2. 降级与代码回滚都是"归档暂时隐身"，不会出现 (a) 的过时状态加 id 冲突；
3. 跨边只存一份，崩溃窗口内不会出现两侧不一致（#3/#5/#7 都是单条原子写），宽容读只是兜底。

(a) 和 (b) 分别在降级安全和语义上吃亏，(c) 在这两方面都不吃亏。

(c) 的已知降级瑕疵（写进文档）：

- 旧版里执行的 `/tasklist clear` 不会写 reset，升级后归档任务会重新出现，需要再 clear 一次；
- 旧版看不到归档任务，所以无法编辑或删除它们。

## 6. 归档集上限与驱逐（OD2）

- `TODO_ARCHIVE_CAP = 256`，与 `src/archive` 的 `ARCHIVE_ENTRIES_CAP` 同量级。实测长会话 84 条归档，留出约 3 倍余量。内存上限约 256 × 0.5 KB（典型）/ 1 MB（每条描述都写满 4000 字符的极端情况）。做成常量，不做设置项：新增设置键会增加 I9 和设置面，没有必要。
- 形态 B 是增量写入，每个归档任务只在归档时和每次编辑时各写一次，文件增长是线性的。**这个上限约束的是内存态、replay 的 fold 规模、`TaskList includeCompleted`/TUI showAll 的输出大小**，不是用来防 O(N²) 写放大的（写放大靠增量形态 B 解决）。
- **驱逐语义**：`evictArchived(state, cap)` 是纯函数，`≤ cap` 时返回同一引用。超出时按 `(archivedAt 升序, id 升序)` 选出最旧的若干条，**按 `deleteTask` 的语义永久删除**：从所有剩余任务的 `blocks/blockedBy` 中裁掉这些 id。被删的是 completed 任务，不影响任何阻塞计算。邻居变化 ⇒ 产生 put，与驱逐的 drop 进同一个包（§4.3 #9）。
- **执行点只有 sweep**，因为只有 sweep 会让归档数增长。restore 不驱逐（不写盘）；编辑不驱逐，避免"刚编辑完就被删"。旧会话如果超出上限，首次 persist 的迁移包可能一次性超过上限，到下一次 sweep 时收敛到上限以内。
- **收敛守卫**（照 `src/archive` 的 A1）：
  - 基线 diff 保证没有变化时一条都不写；
  - 驱逐之后 ≤ cap，后续 sweep 返回同一引用 ⇒ 不写；
  - 写入率不变式测试见 §8。
- 被驱逐任务的 `TaskGet` 会返回 not found。TaskList 页脚 `TaskGet <id> still works` 的承诺只对仍保留的归档任务成立，需要在 `todo-archive/plan.md` 里注明。

## 7. 改动文件域

| 文件                                                              | 改动                                                                                                                                                                                                                                                   | 估算    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `src/todo/state.ts`                                               | §2.1/§3/§6：常量、类型、`restoreTask`/`restoreShape` 抽取（`restoreState` 外部行为不变）、`sanitizeArchiveEntry`、`foldArchive`、`mergeArchive`、`replayTodo`、`replayState` 改包装、`evictArchived`；docstring 写明 §3.2 三段语义与"跨边以归档侧为准" | +180    |
| `src/todo/persist-plan.ts`（新）                                  | `planPersist`、`canonicalKey`、基线应用函数 `applyArchiveEntryToBase`                                                                                                                                                                                  | +90     |
| `src/todo/index.ts`                                               | `ToolDetails` 去掉 `state`；:352/:392 不再写 state；新增两个基线；`persist` 改写；`restore` 改用 `replayTodo` 并设置基线；`sweep` 接入驱逐；更新文件头注释                                                                                             | +45/−10 |
| `src/context-switch/session-facts.ts`、`src/topic-switch/hold.ts` | **零改动**，只补回归测试                                                                                                                                                                                                                               | 0       |

不碰的部分：`ui.ts`、`web-hub/**`（wire/投影）、`config/**`（不加设置）、`src/index.ts`（不加注册 ⇒ `activate-trace.json` 不变）、`tests/fixtures/**`。

**打包建议**（OD5，可不问，默认这样做）：

- 包 1：快赢 ① + ②，即去掉 `details.state` + live 去重。约 30 行，可以独立发版，回滚零风险。
- 包 2：分离存储。
- 两个包分别提交：`perf(todo): stop embedding full state in tool results`、`perf(todo): persist archived tasks as incremental claude-code-todo-archive entries`。

## 8. 测试清单

### 8.1 会动的现有测试（影响面）

- `tests/todo/state.test.ts`、`tests/todo/replay.test.ts`：**一条不改**。restoreState 外部行为不变；没有归档包时走段 2，结果逐字节一致。这一点本身就是回归证据。
- `tests/todo/tools.test.ts`：
  - `:119`、`:161` 的 `details.state.tasks` 断言改为 `expect(details.state).toBeUndefined()`，任务数改用 `getTodoSnapshot()` 或 `replayState(branchOf(host))` 来断言；
  - `:163-165` 的快照计数改为只数 STATE_ENTRY；
  - 归档相关的计数和 `appended.at(-1).data` 断言（`:470-481`、`:525-536`、`:550-554`、`:565-568`、`:578-590`、`:601-610`、`:624-627`、`:638-641`、`:658`）统一改为两个 helper：`liveWrites(host)`（STATE_ENTRY 条目）和 `archiveWrites(host)`，状态断言改为 `replayState(branchOf(host))`。其中 sweep 场景的写入从 1 条变成 2 条（put + live），"第二次压缩不写"不变；
  - `:230-243`（clear，base 为空）仍然只写 1 条 live。
- `tests/conformance/todo-archive.test.ts`：
  - 第 2 步：分支末尾变为 `[compaction, archive(put #1), live]`，`compactionIdx + 2`；
  - `countTodoEntries` 拆成 live 和 archive 两种计数；
  - 第 5 步：第二次 compact 后两种条目都不增加；
  - 第 6 步：新增 `navigateTree(<archive put 条目 id>)`，此时位于 put 与 live 之间，断言 #1 为 completed、未归档、`archivedAt` 为 undefined（良性，live 胜）；另外 `navigateTree(<live 叶子>)` 断言已归档；
  - 第 3 步：两种新条目在投影里的 messages 都为 0。

### 8.2 新增 `tests/todo/archive-store.test.ts`（纯函数）

- **sanitize**：`v` 缺失、为 2 或为字符串 ⇒ 忽略；`reset: "yes"` ⇒ 只丢这个字段；`put` 中混入 pending 任务、缺 `archivedAt`、白名单不合格的元素 ⇒ 逐个丢弃，其余保留；`drop` 中有 `0`/`-1`/`"3"`/重复 ⇒ 过滤并去重。
- **fold**：包内按 reset→put→drop；跨包 upsert 覆盖；drop 后再 put ⇒ 重新存在。
- **merge**：
  - live 胜：同 id 时取 live 副本，A 副本整条忽略；
  - 按 id 排序；`nextId = max`；
  - 复接：A 中 `X.blocks ∋ P` ⇒ 合并后 `P.blockedBy ∋ X`；
  - 宽容：A 中 X 的边指向不存在的 id ⇒ 丢边，状态有效；
  - live 侧出现悬空边 ⇒ 该候选被拒，回落到上一个候选；
  - A 内部双向不一致或成环 ⇒ 所有 merge 都失败 ⇒ `degraded: true` 并返回 live-only 结果。
- **段 2 等价（冻结副本 fuzz）**：新建 `tests/todo/fixtures/legacy-replay.ts`，逐字拷贝改动前的 `restoreState`/`replayState`/`validateState`，按 `legacy-quota-schema.ts` 的先例冻结，文件头注明不可修改。用 seeded 随机生成只含旧形状的分支（custom 与 toolResult 交错，夹杂脏候选、悬空边、成环），断言 `replayState(b)` 与 `legacyReplay(b)` deep-equal。
- **降级（OD1-c）**：同一份冻结旧实现读新格式分支 ⇒ 结果非 undefined，open 任务集合与新读者一致，nextId 一致，归档任务缺席。这条直接证明 §5 的推荐方案成立。
- **evictArchived**：`≤ cap` 返回同一引用；超出时按 `(archivedAt, id)` 删除最旧的、裁掉邻居的边，且 live 任务的 `isBlocked` 不变。

### 8.3 新增 `tests/todo/persist-plan.test.ts` + `tools.test.ts` 新增用例（经由 fake host）

- §4.3 表中 #1–#9 每个场景各一个用例，**断言精确的条目序列**（customType 与 payload 形状）。其中 #6 clear 必须看到 `{v:1, reset:true}` 排在空 live 之前；#3 编辑归档任务只写 1 条 put。
- live 去重：在 TaskUpdate 不产生实际变化以外，再测"只改了归档任务"⇒ 不写 live；restore 后的第一次变更必定写 live。
- 迁移：用旧形态分支（live 中含已归档任务）restore，随后任意一次变更 ⇒ 写 put（全部归档任务）+ live，replay 等价。
- `appendEntry` 第 2 次调用抛错 ⇒ 下一次 persist 补写 live，最终 replay 等价。
- **round-trip 性质**：seeded 随机生成工具操作序列（create/update/complete/reopen/delete/加删边/sweep/clear/restore），每一步之后断言 `replayState(branchOf(host))` 与内存 state 在"边集合相等、其余字段相等"意义下一致。
- **崩溃窗口性质**：对每一次 persist 产生的 2–3 条条目，在条目之间截断分支并 replay，断言：结果不为 undefined，且（忽略 `archivedAt` 的有无后）等于操作前或操作后的状态之一。
- **写入率不变式**（照 archive A2）：随机序列中，没有实际变化的操作写入 0 条；任一 persist 写入 ≤ 3 条；连续两次 compact 之间如果没有新的完成任务，写入 0 条。
- `degraded` 路径下 restore 之后的 persist 不会发出 gone drop（archiveBase 为空）。

### 8.4 读者回归

- `tests/context-switch/session-facts.test.ts`：新增一个分离格式分支（live 加 archive 包，包含复接边），断言 `facts.todos` 列出全部 open 任务。
- `tests/topic-switch/`（`buildBranchView` 所在测试）：新增分离格式分支下 `todoInProgress=true` 的用例。
- `tests/todo/web-export.test.ts`、`tests/web-hub/agent/todo-projection.test.ts`、`ui.test.ts`：不改，跑通即可（内存模型不变）。
- I9：`tests/integration/merged-plugins-wiring.test.ts` 中 `todo.enabled=false` 的现有断言仍通过（不会产生任何新条目）。另外确认 `git diff --quiet origin/dev -- tests/fixtures/`。

## 9. 待用户拍板（ask_user）——已于 2026-10-29 全部按推荐拍板

- **OD1 降级口径**：✅ 拍板 **(c)** 落盘剥离 + 读回复接。
- **OD2 归档上限**：✅ 拍板 **256**，超出永久驱逐最旧。
- **OD3 live 快照加 `v:1` 标记**：✅ 拍板 **加**。
- **OD4 宽容读是否扩大到旧会话**：✅ 拍板 **不扩大**（守住「无归档包 ⇒ 逐字节一致」验收线）。

原始选项与理由（存档）：

- **OD1 降级口径**：(c) 落盘剥离 + 读回复接（Recommended）/ (a) live 保留跨边 + 宽容读 / (b) 归档剪边（语义改变）。理由见 §5。
- **OD2 归档上限**：256 并永久驱逐最旧（Recommended）/ 512 / 不设上限（只靠形态 B 的线性增长）。
- **OD3 live 快照加 `v:1` 标记**：加（Recommended，读者不依赖，便于以后迁移和统计脚本识别格式）/ 不加（data 形状与今天完全相同）。
- **OD4 宽容读是否扩大到旧会话**：不扩大（Recommended，保证"没有归档包 ⇒ 与今天逐字节一致"这条验收线）/ 扩大（顺手修掉今天"悬空边导致候选整条作废"的脆弱点，但旧会话的回落行为会改变）。

## 10. 风险与回滚

- **R1（最大风险）多条目写入与复接的正确性**：写入顺序错误，或某条改跨边的路径没有产出 put，都会导致读回时边丢失或回落到 degraded，表现为归档任务静默消失。缓解措施：
  - "跨边以归档侧为准"依赖的是 `connectDependencies` 和 remove/delete 的双向修改，而不是在每条路径上单独打补丁；
  - §8.3 的 round-trip 与崩溃窗口两个性质测试；
  - degraded 时空基线，保证不主动 drop。
- **R2 降级瑕疵**（OD1-c）：旧版看不到归档任务；旧版的 clear 不清归档集。写进 todo-archive 文档。
- **R3 驱逐会永久删除**超过 256 条以外的最旧归档任务。
- **R4 迁移**：每个旧会话一次性写入一个大 put（≤ 原快照中归档部分的大小）。
- **R5 前向兼容**：v1 读者忽略 v2 包（§2.1 的规则）。
- **R6 replay 开销**：O(条目数) 单遍 fold，加上候选回落时最多再做 O(候选数) 次 validate，与今天同阶。
- **回滚**：
  - 包 1 直接 revert，零风险（读回端从来就接受有或没有 `details.state`）；
  - 包 2 revert 后，旧代码读 live 快照能正常加载（OD1-c 保证自足、nextId 不回退），归档任务暂时看不见，但归档包仍在盘上，不会被旧代码改写或删除。再次升级后 merge 会恢复。期间旧代码自己 sweep 出来的归档任务会留在它写的全量快照里，再升级后由迁移 put 接管；
  - **不需要数据迁移脚本，也不需要清理步骤**；
  - 如果选了 OD1-a，回滚会回落到过时状态，所以选 (a) 时必须先把包 1 和包 2 拆开发版，并在 release notes 里写明"不可降级"。

## 11. 文档更新清单

- `docs/dev/todo-archive/plan.md`：追加 §9 "v3 分离存储（#92）"，内容如下：
  - **D10** 双 customType 与内存模型不变；
  - **D11** 读回的三段语义、live 胜、合并后校验；
  - **D12** 写入顺序 pre→live→post，以及删除/驱逐的原子包；
  - **D13** 跨边以归档侧为准（落盘剥离、读回复接，OD1）；
  - **D14** 归档上限 256 与驱逐语义（OD2），并修订 D6 的"TaskGet still works"为"对保留的归档任务成立"；
  - **D15** toolResult 不再带 `details.state`，live 去重；
  - 把 §5 R1、R4 标为已由 #92 解决。
- `docs/dev/todo-web/README.md`：`src/todo/` 段把 "Persists via the `claude-code-todo-state` session entry" 改为说明双条目（live 快照加 `claude-code-todo-archive` 增量包，读回收口在 `replayState`），并链接本文件。
- `docs/dev/web-hub/refresh-slow/archive-dedup-plan.md` §4：回填"前提已核实：**不成立**，归档任务可编辑、可重开、可删除、可加边（`explore-report.md` §2）；最终方案见 `../../todo-archive-split/plan.md`"。
- `AGENTS.md`：不改。仓规要求新细节写进 README，且 `src/todo/` 一行已经指向 todo-web README。
