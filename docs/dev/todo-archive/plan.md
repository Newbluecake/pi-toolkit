# Todo 列表收纳与自动归档：实施方案 v2

> 范围（用户已批准）：①显示折叠 ②`TaskList` 默认只列未完成 ③自动归档已完成任务。
> 不在范围：④增量持久化、⑤分组。车道 **L2**。
> v2 修订了评审（gpt-6.1-sol）提出的 1 个 Blocker、4 个 Major、3 个 Minor，逐条处置见 §7。

## 0. 现状地图（file:line）

| 位置                                                                           | 现状                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/todo/state.ts:7-19`                                                       | `Task` 无完成时间、无归档字段；`TodoState={tasks,nextId}`                                                                                                                                                   |
| `state.ts:60,64`                                                               | `emptyState()` 的 nextId=1；`cloneState` 用展开复制，新增可选标量字段会自动带上                                                                                                                             |
| `state.ts:109-181` `updateTask`                                                | 用 `JSON.stringify` 前后比较得到 `changed`；只要有修改就刷新 `updatedAt`（`:179`），所以 `updatedAt` **不等于**完成时间                                                                                     |
| `state.ts:204` `orderTasks`                                                    | 未完成任务保持创建顺序，completed 沉底                                                                                                                                                                      |
| `state.ts:213-262` `restoreState`                                              | 按字段白名单重建，不认识的字段丢掉                                                                                                                                                                          |
| `state.ts:275` `replayState`                                                   | 读两种历史形状：custom 条目，以及 toolResult 的 `details.state`；取最后一个合法候选                                                                                                                         |
| `state.ts:366-375` `activeBlockers/isBlocked`                                  | 从**传入的数组**里计算已完成 id 集合。传子集进去会把被过滤掉的已完成前置任务误判为阻塞                                                                                                                      |
| `src/todo/index.ts:91`                                                         | `TaskListSchema = Type.Object({})`                                                                                                                                                                          |
| `index.ts:191-211` `restore()`                                                 | 在 `session_start` / `session_tree` / `session_compact` 上调用（`:469-471`）；会重置 nudge，并 replay 分支                                                                                                  |
| `index.ts:213` `persist()`                                                     | 每次变更 `appendEntry(STATE_ENTRY, cloneState(state))`                                                                                                                                                      |
| `index.ts:217-252` `refreshWidget`                                             | `tasks.length===0` 时卸载组件                                                                                                                                                                               |
| `index.ts:254-263` `enqueue`                                                   | 先 `noteTodoTouch()`（重置 nudge），再串行执行                                                                                                                                                              |
| `index.ts:363-374,386-411`                                                     | TaskList 返回全量；TaskUpdate 在 handler 里直接 `state = result.state`                                                                                                                                      |
| `index.ts:440-449`                                                             | `/tasklist clear` 执行 `state = emptyState()`，会把 nextId 重置为 1                                                                                                                                         |
| `index.ts:530-571`                                                             | nudge 的 `turn_end` 和 `getTrackerSnapshot` 都注册在 `if (nudgeTrackingEnabled)` 里面                                                                                                                       |
| `index.ts:592-624`                                                             | `formatTaskLine` / `formatTaskList` / `formatToolText`                                                                                                                                                      |
| `src/todo/ui.ts:10-11,19-38,44-116,118,149`                                    | 组件上限 6、面板上限 10；`renderTaskLines(task, tasks)`；`selectWidgetTasks`                                                                                                                                |
| `src/web-hub/agent/todo.ts:39-51,81-93,95-122`                                 | `projectTodo`；`countsOf(all)` 同时用 all 做计数和查阻塞；`fitBudget` 第 3 段先判断字节、后改 `omitted`                                                                                                     |
| `src/web-hub/agent/status.ts:80-83`                                            | `readStatus` 里调用 `projectTodo(todo())`                                                                                                                                                                   |
| `src/web-hub/agent/index.ts:630,953`                                           | `readStatus` 的两个调用点：status 帧和 snapshot_reply                                                                                                                                                       |
| `agent/index.ts:476-490`                                                       | **先例**：只有 `hello_ack.caps ∋ quota.pools.v1` 时才发新形状（纯读，不缓存）                                                                                                                               |
| `agent/index.ts:717-721,1172`                                                  | todo 的 1Hz 指纹门；`session_start` 时清掉 `lastTodoFp`                                                                                                                                                     |
| `src/web-hub/protocol/messages.ts:1051-1075`                                   | `TodoTaskSchema` / `TodoWireSchema`，**均为 `additionalProperties:false`**，且没有导出                                                                                                                      |
| `messages.ts:1339,1424,1448`                                                   | StatusInfoSchema 内嵌 todo；status 帧和 snapshot_reply 共用这一份                                                                                                                                           |
| `messages.ts:1953-1969`                                                        | `decodeAgentFrame` 用 `Value.Check` 校验，不通过返回 undefined                                                                                                                                              |
| `src/web-hub/hub/agent-server.ts:186-198`                                      | 对 undefined 帧**静默丢弃**；`hello_ack.caps` 展开 `QUOTA_POOLS_HUB_CAPS`                                                                                                                                   |
| `src/web-hub/hub/hub.ts:563-564`                                               | `HubInfo.caps` 是第二个 cap 面，用同一个源数组展开                                                                                                                                                          |
| `src/web-hub/protocol/version.ts:159-164`                                      | `QUOTA_POOLS_HUB_CAP` 的定义与文档（本方案照抄这个模式）                                                                                                                                                    |
| `tests/web-hub/protocol/quota-pools-schema.test.ts` + `legacy-quota-schema.ts` | 用 legacy schema 的逐字拷贝证明 cap 门必要                                                                                                                                                                  |
| `tests/web-hub/hub/caps-coexist.test.ts:117`                                   | 两个 cap 面的集合相等断言                                                                                                                                                                                   |
| `tests/conformance/pi-boundary.test.ts:42-160`                                 | 已有真实 `AgentSession` 的测试 harness：脚本化模型、`extensionFactories`、`persist`，以及 `SessionManager.inMemory(cwd, undefined, fileEntries)` 重建。`npm test` 包含 `tests/**`，conformance 测试也是门禁 |
| pi `agent-session.js:2200-2280`                                                | `compact()`：先 `appendCompaction`，再 `_refreshFinalizedContext`，最后 **await** `session_compact` 处理器；扩展返回 `{compaction}` 时不调摘要 LLM                                                          |
| pi `agent-session.js:3231`                                                     | `navigateTree(targetId)` 会触发 `session_tree`                                                                                                                                                              |

不需要改的：`nudge.ts`、`context-switch/session-facts.ts:78-85`（只列未完成任务）、`topic-switch/hold.ts:138`、`tools/switch-context-tool.ts`。归档任务的 status 仍是 `completed`，这些地方本来就不统计它。nudge 在压缩时依旧由 `restore()` 重置，**不承诺**计数能跨压缩保留。

## 1. 设计决策

- **D1 归档触发**（已拍板，见 §6）
  - (a) `session_compact`：先 `restore()`，再清扫全部已完成任务。
  - (b) 完成后满 `afterTurns`（默认 30）次 `turn_end` 即归档；设为 0 则关闭。
  - 新增设置：`todo.archive.onCompact`（bool，默认 true）、`todo.archive.afterTurns`（count，min 0，默认 30）。
  - 两项都非 live，需要 `/reload` 生效。
  - (b) 的处理器**注册在 nudge 条件之外**，主会话和子会话都注册。
- **D2 数据模型**：`Task` 新增两个可选字段，只在 `status==="completed"` 时有效。
  - `completedAt?: number`：状态转入 completed 时设为 now；编辑其他字段时保留；重开时删除。
  - `archivedAt?: number`：存在即表示已归档；重开时一并删除。
  - 不另开归档列表。依赖边、`validateState`、`getTask`、nextId 都保持不变。
  - `restoreState`：这两个字段是有限数且任务为 completed 时保留；否则**只丢弃该字段**，候选状态仍然有效。
  - 旧快照兼容：完成时间取 `completionTime(t) = t.completedAt ?? t.updatedAt`。代价是旧会话里完成后又被编辑过的任务会排得偏新，属于一次性的、文档化的不精确。
- **D3 `TaskList`**：新增 `includeCompleted?: boolean`。
  - 默认只列未完成任务。如有已完成或已归档任务，追加一行页脚，例如：`Completed: 12 hidden (latest #13, #14, #15; includeCompleted:true lists all) · Archived: 5 (TaskGet <id> still works)`。
  - "latest" 按 `completionTime` 取。计数为 0 的分句省略。
  - 只有未完成任务时，输出与现在逐字节一致。只有已完成/已归档任务时首行为 `No open tasks.`；完全没有任务时仍为 `No tasks.`。
  - `true` 时输出旧版全量，已归档任务行尾加 ` [archived]`。
- **D4 最近完成**（展示语言已拍板，见 §6）
  - 组件显示最近 2 条，面板显示 3 条。按 `completionTime` 降序选取（相同时比 id），显示时按升序。
  - TUI 的折叠行用 `✓ N done`；web 走 i18n。
- **D5 web 端**：在投影层做折叠，并加 **hub cap 协商**。
  - 投影排除已归档任务。行为 `[...open, ...recent3]`，取前 32 行，未完成任务优先。
  - `TodoWire` 只追加 `completedHidden?` 和 `archived?` 两个字段；接口和**运行时 TypeBox schema** 都要加。
  - 只有 `hello_ack.caps ∋ todo.archive.v1` 时才发这两个字段（照抄 quota.pools.v1 的做法），细节见 §4。
  - `omitted` 保持 `total − tasks.length`，包含被折叠的已完成任务。
- **D6 已归档任务上的 `TaskUpdate`**
  - 改为非 completed 状态：清掉 `archivedAt` 和 `completedAt`，任务重新出现。
  - 改其他字段：保持归档。
  - `TaskDelete`、`TaskGet` 照常工作；`TaskGet` 行尾加 ` [archived]`。
- **D7 计数**
  - nudge、tracker、交接附录不改代码。
  - 组件和面板标题的 `done/total`，以及 `refreshWidget` 的隐藏判断，都只看未归档任务。
  - **所有阻塞计算都基于完整的 `state.tasks`**。分区结果只决定显示哪些行、算哪些数，不能拿去查依赖。
- **D8 串行化**
  - 拆成 `serialize(work)`（只串行）和 `enqueue = noteTodoTouch + serialize`。
  - 自动归档走 `serialize`，因此不会重置 nudge。
  - 所有对 state 的赋值都经过 `commit(next)`，在同一处维护完成年龄（规则见 §2）。
- **D9 `/tasklist clear`**：改为 `{ tasks: [], nextId: state.nextId }`，保留 nextId 的最高水位，同一分支/会话内 ID 永不复用。

## 2. 逐文件改动

### `src/todo/state.ts`（纯函数）

1. `Task` 加 `completedAt?` 和 `archivedAt?`；新增导出 `completionTime(t)`、`isArchived(t)`。
2. `restoreState` 按 D2 透传两个字段。
3. `updateTask` 的状态分支：
   - 先记 `const was = task.status === "completed"`；
   - `!was && 新状态 completed`：`task.completedAt = now`；
   - `was && 新状态非 completed`：`delete task.completedAt; delete task.archivedAt`；
   - 其他字段的编辑不碰这两个字段。
4. 新增 `partitionTasks(tasks, recentCount)`，返回 `{visible, open, completed, recentCompleted, hiddenCompleted, archived}`。docstring 注明："只选行，查依赖必须传完整的 tasks"。
5. 新增 `archiveCompleted(state, ids | "all", now)`：只处理"completed 且未归档"的任务；**不改 `updatedAt`**；没有可归档任务时返回同一引用。
6. 新增 `clearTasks(state)`，返回 `{tasks: [], nextId: state.nextId}`。
7. `orderTasks` 改为三段：未完成 → 已完成未归档 → 已归档。没有归档任务时结果与现在相同。

### `src/todo/index.ts`

1. 拆分 `serialize` 和 `enqueue`（D8）。
2. 闭包新增 `turnSeq = 0` 和 `doneSince = new Map<number, number>()`（id → 观察到它进入"已完成未归档"时的 turnSeq）。
3. 新增 `commit(next)`，它是**唯一**给 state 赋值的地方，只在串行任务内或 restore 内调用。逐个任务对账：
   - 在 next 中满足"已完成未归档"：如果 prev 里不满足，或者两边 `completedAt` 不同，置为 `turnSeq`；否则保留原值。
   - 在 next 中不满足：从 map 删除。
   - 在 next 中已不存在：从 map 删除。

   TaskCreate / Update / Delete / clear 的 handler 一律改用 `commit(result.state)`。这样每次工具调用都单独对账，同一轮内 completed→pending→completed 会重新计龄。

4. `restore(ctx)`：replay 之后执行 `doneSince.clear()`，并把当前所有"已完成未归档"任务登记为当前 `turnSeq`（重新计数）。nudge 重置的逻辑保持不变。
5. 新增 `sweep(ids | "all")`，只在串行任务内调用：`archiveCompleted` → `commit` → 有变化才 `persist()` → `refreshWidget()`；出错时 try/catch 并 `console.warn`。
6. `session_compact` 处理器改为 `return serialize(() => { restore(ctx); if (onCompact) sweep("all"); })`，排在已入队的工具变更之后，并返回 promise（pi 会 await 它）。`session_start` / `session_tree` 只做同步 restore，不清扫。
7. `afterTurns > 0` 时注册归档用的 `turn_end`，**与 nudge 和是否子会话无关**：
   ```
   return serialize(() => { turnSeq++; const due = [...doneSince].filter(([, s]) => turnSeq - s >= N).map(([id]) => id); if (due.length) sweep(due); })
   ```
   语义：任务完成后的第 N 次 `turn_end` 时归档。被折叠、不显示的已完成任务同样计龄。
8. `/tasklist clear` 改用 `clearTasks`。
9. TaskList schema 加 `includeCompleted`，并更新工具描述；`formatTaskList(state, {includeCompleted})` 按 D3 实现。`formatTaskLine(task, state.tasks)` 对已归档任务加 ` [archived]`，阻塞查询基于完整列表。非 TUI 或 web 方式调用的 `/tasklist` 用折叠格式。
10. `refreshWidget` 改为 `partitionTasks(...).visible.length === 0` 时卸载。
11. deps 加 `archive?: {onCompact, afterTurns}`，默认 `{true, 30}`。

### `src/todo/ui.ts`

- 常量 `WIDGET_RECENT_COMPLETED=2`、`PANEL_RECENT_COMPLETED=3`。
- **所有 `renderTaskLines`、`isBlocked`、`activeBlockers` 调用都传完整的 `getTasks()`**；分区只用来挑行。
- `TodoWidget`：
  - 标题只统计未归档任务；
  - 行为 `selectWidgetTasks(open, 6 − recentShown)` 加最近完成；
  - 有被隐藏的已完成任务时显示 `✓ N done`；
  - 未完成任务溢出时仍显示 `… K more · /tasklist to view all`；
  - 组件里不提归档。
- `TodoPanel`：
  - 新增 `showAll` 状态，用 `matchesKey(data, "a")` 切换；Ctrl+A / Alt+A 不触发。切换时 offset 归零。
  - 用 `rows()` 统一偏移钳制。
  - 折叠模式：未完成 + 最近 3 条，再加一行 `✓ N done · M archived`。
  - 全部模式：`orderTasks(all)`，已归档任务 dim 显示并带 ` · archived`。
  - 底部提示在两种模式下分别为 `↑↓ scroll · PgUp/PgDn jump · a show all · Esc close` 和 `… · a collapse · Esc close`。

### `src/web-hub/agent/todo.ts`

- 签名改为 `projectTodo(state, opts: { archiveFields: boolean })`。
  - `p = partitionTasks(all, 3)`；没有可见任务时返回 `undefined`。
  - `rows = [...p.open, ...p.recentCompleted].slice(0, 32).map(t => projectTask(t, all))`。
  - `updatedAt` 取截断前各行的最大值，口径不变。
- 新增 `finalize(rows)`，**每次字节判断前都先算出完整 wire**：
  - `total = visible.length`；
  - `counts = countsOf(p.visible, all)`（计数基于可见任务，阻塞基于全量）；
  - `omitted = total − rows.length`，值 > 0 时才写；
  - `completedHidden = counts.completed − rows 中 completed 的数量`、`archived = p.archived.length`：仅当 `archiveFields` 为真且值 > 0 时写入。
- `fitBudget` 第 2、3 段都用 `byteSize(finalize(rows))` 判断，最后返回 `finalize(rows)`。
- `todoLightFingerprint` 的每行加 `a`（是否已归档）。

### `src/web-hub/agent/status.ts` / `agent/index.ts`

- `readStatus` 的 todo 参数改为 `() => TodoWire | undefined`，与 quota 的形状一致。
- `index.ts` 新增 `todoArchiveCap = () => conn?.status().state === "live" && (conn?.caps.includes(TODO_ARCHIVE_HUB_CAP) ?? false)` 和 `todoProjection = () => projectTodo(deps.todo!(), { archiveFields: todoArchiveCap() })`，`:630` 和 `:953` 两处都改用它，但**必须保留可选源门**：传 `deps.todo !== undefined ? todoProjection : undefined`（`todo.enabled=false` 时组装层不传 `deps.todo`，readStatus 收到 undefined 才会跳过 todo；照 quota 先例保留可选源检查）。回归测试：`webHub.enabled=true` + `todo.enabled=false` 时 status 帧与 snapshot_reply 都正常生成且不含 todo。
- `:717` 的指纹改为 `todoLightFingerprint(...) + (todoArchiveCap() ? "|a1" : "|a0")`，这样换到新 hub 后的下一个 1Hz tick 会重新发布。

### `src/web-hub/protocol/version.ts` / `messages.ts` / hub

- 新增 `TODO_ARCHIVE_HUB_CAP = "todo.archive.v1"` 和 `TODO_ARCHIVE_HUB_CAPS`，docstring 照抄 `:159-164`。
- `hub.ts:564` 和 `agent-server.ts:188` 在 `QUOTA_POOLS_HUB_CAPS` 后面无条件展开该 cap。
- `messages.ts`：
  - `TodoWireSchema` 加 `completedHidden: Type.Optional(Type.Integer({minimum:0}))` 和 `archived: Type.Optional(Type.Integer({minimum:0}))`，`additionalProperties:false` 保持不变；
  - `export` 该 schema；
  - `TodoWire` 接口同步加字段，并更新注释：`total/counts` 不含已归档任务，`omitted` 包含被折叠的已完成任务；
  - 不升 PROTO。

### `src/web-hub/ui/src/components/detail/TodoPanel.vue` + `i18n/{en,zh}/detail.ts`

- 列表尾部依次显示：
  1. `todoCompletedHidden`（en `✓ {n} done`，zh `已完成 {n} 项`）；
  2. `todoMore(max(0, omitted − (completedHidden ?? 0)))`；
  3. `todoArchived`（en `{n} archived`，zh `已归档 {n} 项`）。
- i18n 新 key 只追加在文件末尾。

### 设置、组装与文档

- `src/config/settings.ts`：加 `TodoArchiveSettings`，默认值写在 `:1122`，新增 `parseTodoArchiveSettings`，逐字段回退，`afterTurns` 接受 ≥0 的整数。
- `setting-specs.ts`：在 `:425-446` 加 2 条。
- `src/index.ts:161-165`：传入 `archive: preGuardSettings.todo.archive`。
- `AGENTS.md`：在 `src/todo/` 段落补一句，并引用本文件。

## 3. 测试计划

- **`tests/todo/state.test.ts`**
  - `completedAt`：转入 completed 时设置；编辑 subject 时保留，且**不会把旧完成排成最新**；重开时与 `archivedAt` 一起清除。
  - `archiveCompleted`：幂等，无变化时返回同一引用，不改 `updatedAt`。
  - `partitionTasks`：recent 的排序与相同时间的处理；旧快照回退到 `updatedAt`。
  - `orderTasks` 的三段顺序。
  - `clearTasks` 保留 nextId。
- **`tests/todo/replay.test.ts`**
  - 两种历史形状（custom 条目、toolResult `details.state`）都要**正向**带回 `archivedAt` 和 `completedAt`。
  - 非 completed 任务带了这两个字段时，字段被丢弃但候选有效。
  - 旧条目往返后完全一致。
  - 已归档快照之后跟一份未归档快照时，以最后一份为准。
- **`tests/todo/tools.test.ts`**
  - TaskList：只有未完成任务时逐字节不变；页脚内容；`No open tasks.`；`includeCompleted` 全量输出；TaskGet 能取到已归档任务。
  - 压缩时清扫且只写盘一次，没有可归档任务时不写盘；`session_tree` / `session_start` 不清扫。
  - **年龄**：
    - 第 N 次 `turn_end` 时批量归档，只写盘一次；
    - 在第 N−1 轮的同一轮内先 reopen 再 recomplete，会重新计龄；
    - 同一轮内多次工具调用；
    - 一个已入队但尚未完成的 TaskUpdate(reopen) 与并发的 `turn_end`：按队列顺序执行，不会误归档；
    - 删除或归档后 map 被清理；
    - 被折叠、不显示的已完成任务同样计龄；
    - `afterTurns=0` 时不注册处理器；
    - `isChildSession:true` 且关闭 nudge 时，归档照常生效。
  - **clear**：create → 完成 → 归档 → 删除 → clear → create 拿到新 id；replay 后 nextId 正确。
  - 全部任务归档后组件卸载。
- **`tests/todo/nudge-wiring.test.ts`**：已归档任务不计入 `openTaskCount` 和 precondition；按轮清扫后 `turnsSinceTouch` 不归零。
- **`tests/todo/ui.test.ts`**（新建，用 stub theme）
  - 组件：折叠行、2 条最近完成、标题计数。
  - **回归**：pending #2 `blockedBy:[1]`，#1 已完成且已归档 ⇒ 组件和面板都不显示 ⊘，不显示 `blocked by`，blocked 计数为 0。
  - 面板：`a` 能切换；`\x01`（Ctrl+A）和 `\x1ba`（Alt+A）不切换；底部提示随模式变化；offset 重置并钳制。
- **`tests/web-hub/agent/todo-projection.test.ts`**
  - 排除已归档任务；未完成任务优先占满 32 行。
  - 同一个已归档前置任务的回归：`blockedBy` 为 `[]`，`counts.blocked` 为 0。
  - `archiveFields:false` 时不出现两个新字段。
  - **边界**：32 个未完成任务 + 长描述 + 已完成任务，逼到第 3 段裁剪。断言最终 UTF-8 字节 ≤ 32768；`omitted === total − tasks.length`；`completedHidden === counts.completed − 已发出的 completed 行数`；`0 ≤ completedHidden ≤ omitted`。
  - 只改归档状态时指纹也变化；只剩已归档任务时返回 `undefined`。
- **`tests/web-hub/protocol/todo-archive-schema.test.ts`**（新建，结构照 quota-pools-schema）
  - `legacy-todo-schema.ts` 是改动前 `TodoWireSchema` 的逐字拷贝。
  - 用 legacy schema 校验：带任一新字段即被拒（证明需要 cap 门）；旧形状 wire 在新旧两个 schema 下结果相同。
  - 用真实 `decodeAgentFrame` 跑两条路径：**status 帧**和 **snapshot_reply.status**。每条路径分别测 `completedHidden`、`archived`、两者同时存在，都能解码；负数或非整数被拒。
- **`tests/web-hub/hub/caps-coexist.test.ts`**：在两个 cap 面的期望集合里加入 `todo.archive.v1`。
- **`tests/web-hub/agent/*`**：cap 关时投影不含新字段，cap 开时含；连接到新 hub 后指纹变化，触发重新发布。
- **`tests/web-hub/ui/todo-panel.test.ts`**：三种尾行的渲染；不含新字段的旧 wire 渲染结果不变。i18n 中英 key 一致性测试同步补上。
- **`tests/config/`**：设置的默认值、非法值回退、`afterTurns=0`；setting-specs 覆盖新的叶子。
- **新建 `tests/conformance/todo-archive.test.ts`**（真实 `AgentSession` + `SessionManager`）
  - 把 `pi-boundary.test.ts` 文件内的 `fakeModel` / `fakeModelRuntime` / `withSession` **原样搬到** `tests/conformance/agent-session-harness.ts`，两边都从这里导入，pi-boundary 必须继续通过。不另造新 harness。
  - **压缩前置条件**：pi 默认 `keepRecentTokens=20000`，小会话会让 `prepareCompaction` 返回 undefined，`compact()` 在调用测试钩子之前就抛 “Nothing to compact”。harness 新增可选参数（例如 `compaction: { keepRecentTokens }`，原调用方不传则默认不变），本测试设成很小的值（或预先写入足够长的确定性历史），保证第一次和第二次 `compact()` 都能准备出可摘要区间。
  - `extensionFactories` 包含：`(pi) => wireTodo(pi, { archive: { onCompact: true, afterTurns: 0 } })`，以及一个测试用的 `session_before_compact` 处理器，返回 `{compaction:{summary, firstKeptEntryId, tokensBefore}}`。它与 switch_context 走同一条 `fromExtension` 路径，也不用调摘要 LLM。
  - 用参数化覆盖 `keep_recent` 的两种值：`firstKeptEntryId` 分别取 `preparation.firstKeptEntryId`，以及一个不存在的哨兵值（即 hook.ts 的 keep_recent=false 实现）。
  - 场景：
    1. 脚本化轮次调用 TaskCreate ×2、TaskUpdate(#1 completed)。若 `createAgentSession` 的 `tools` 白名单会屏蔽扩展工具，就把工具名也列进去。
    2. `session.compact()` 之后，分支末尾依次是 `compaction` 和一条 todo custom 条目；`replayState` 得到 #1 有 `archivedAt`，#2 是 open。
    3. 归档条目写入前后，`buildSessionProjection().messages` 不变（不产生额外的上下文内容）。
    4. `persist:true` 时，读回 session 文件，用 `SessionManager.inMemory(cwd, undefined, fileEntries)` 重建，`replayState(getBranch())` 仍带 `archivedAt` 和 `completedAt`。
    5. 再跑一个脚本化轮次后做第二次 `compact()`：成功，并且因为没有新的已完成任务，**不再追加** todo 条目。
    6. `session.navigateTree(<归档前的条目>)` 后状态为未归档；`navigateTree(<归档后的叶子>)` 后状态为已归档。
  - fork 与 `navigateTree` 走同一套 `getBranch` 逻辑，不单独测。
- **Golden**：没有 todo 相关的 golden；`compact-hint-golden.json` 不受影响。

## 4. 向后兼容与 hub 升级窗口

- **会话数据**
  - 旧 `claude-code-todo-state` 条目不带新字段，加载结果不变（只有 UI 折叠）。
  - 旧版插件读到新条目时，白名单会丢掉新字段，退化为全部显示。
  - 旧会话里 clear 过的状态（nextId=1）原样 replay。
  - 字符串常量一律不改。
- **新 agent + 旧 hub 进程**（升级了 pi，但 hub 守护进程还是旧版本）
  - 旧 hub 的 `TodoWireSchema` 是封闭 schema。**如果不做 cap 门**，status 帧和 snapshot_reply 会被 `Value.Check` 拒绝并静默丢弃，web 卡片冻结、快照失败。
  - 旧 hub 不会在 `hello_ack.caps` 里宣告 `todo.archive.v1`，所以 agent 不发两个新字段，帧依然合法。
  - 这段窗口里用户看到的是旧 UI：未完成任务加最多 3 条最近完成；被折叠的已完成任务计入 `(+N more)`；已归档任务不显示，也不计入 `Tasks total`。不丢帧。
  - 窗口在两种情况下结束：一是版本替换（高版本 agent 连上后，hub 在静默期被替换，最多等 30 分钟就强制替换），二是用户手动 `/webhub restart`。重连后 cap 生效，指纹里带 cap 位，下一个 tick 就会补发。
- **旧 agent + 新 hub**：两个字段不存在；新 UI 在 `completedHidden` 为 undefined 时不显示折叠行，`todoMore` 退回原来的口径。

## 5. 风险

- **R1** 每次清扫会多写一份全量快照。写盘次数有上限：每次压缩最多 1 次；按轮清扫是批量的，每轮最多 1 次。根治属于范围 ④。
- **R2** turn 的粒度比用户请求小，N=30 可以调；这一点在设置说明里写清楚。
- **R3** TaskList 默认输出变了。页脚给出数量、最近的 id 和参数用法来缓解。
- **R4** 工具结果的 `details.state` 仍是全量快照（replay 依赖它），属于范围 ④。
- **R5** cap 门依赖 hub 和 agent 两个 cap 面同步更新；caps-coexist 测试和 legacy schema 测试是门禁。
- **R6** 同一轮内状态变化的计龄由 `commit` 逐次对账来保证。`restore` 在 `session_start` / `session_tree` 上是同步执行的，和 v1 一样不进入串行队列（会话边界上不存在在途的 Task 调用）。只有压缩路径改为串行。

## 6. 用户拍板（2026-10-15）

- D1：压缩时归档 + 完成后 30 轮归档（`todo.archive.onCompact=true`，`todo.archive.afterTurns=30`，0 关闭按轮归档）。
- D4：TUI 折叠行用英文 token（`✓ 12 done`），web 端走 i18n（zh「已完成 12 项」）。
- 其余决策按方案推荐项执行，待方案评审结论。

## 7. v1→v2 处置表

| #   | 级别         | 问题                                                                                                       | v2 处置                                                                                                                                                                                                                                                                                                                                    | 位置                      |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 1   | Blocker      | 只改了 TS 接口，运行时 `TodoWireSchema` 是封闭的，新字段会让 status/snapshot 帧被静默丢弃；旧 hub 同样会丢 | 两个字段同时加进接口和运行时 schema，并导出 schema；新增 cap `todo.archive.v1`，hub 的两个 cap 面无条件宣告（照 quota.pools.v1）；agent 只在 live 且收到该 cap 时才发新字段；指纹带 cap 位；legacy schema 测试 + 真实 `decodeAgentFrame` 的两条路径 × 三种字段组合；写明旧 hub 窗口里的表现，以及版本替换或 `/webhub restart` 两条升级路径 | D5、§2 协议/agent、§3、§4 |
| 2   | Major        | 用过滤后的子集查阻塞，已归档的前置任务被误判为阻塞                                                         | 分区只用来挑行；`countsOf(visible, all)`、`projectTask(t, all)`，TUI 和 formatTaskLine 都基于完整 tasks；web 和 TUI 各加回归测试                                                                                                                                                                                                           | D7、§2、§3                |
| 3   | Major        | 只在 `turn_end` 对账，看不到同一轮内的 reopen/recomplete，而且清扫没有串行化                               | `commit()` 是唯一赋值点，每次变更都对账；`turn_end` 和压缩清扫都在 `serialize` 内部，并返回 promise；删除/归档的 id 及时清理；被折叠的已完成任务也计龄；补齐 N−1 轮内同轮 reopen、排队竞争、多次调用、子会话等测试                                                                                                                         | D8、§2 index、§3          |
| 4   | Major        | `updatedAt` 不代表完成顺序                                                                                 | 新增 `completedAt`（转入 completed 时设置，编辑时保留，重开时清除），旧快照回退到 `updatedAt` 并写入文档；测试编辑旧的完成任务不会被提升                                                                                                                                                                                                   | D2、D4、§2 state、§3      |
| 5   | Major        | `/tasklist clear` 把 nextId 重置为 1                                                                       | 新增 `clearTasks` 保留最高水位；测试 create → 归档/删除/clear → create → replay                                                                                                                                                                                                                                                            | D9、§2、§3                |
| 6   | Minor        | 用了 `data === "a"`，底部提示固定不变                                                                      | 改用 `matchesKey(data, "a")`，Ctrl+A / Alt+A 不触发；底部提示在 `a show all` 和 `a collapse` 之间切换，并有测试                                                                                                                                                                                                                            | §2 ui、§3                 |
| 7   | Minor        | 字节判断时元数据还没定稿                                                                                   | 每次判断都先 `finalize(rows)` 得到完整 wire；断言最终字节 ≤ 32 KiB 及四条不变式，并有边界用例                                                                                                                                                                                                                                              | §2 todo.ts、§3            |
| 8   | Minor        | 生命周期缺少验收测试                                                                                       | replay 对两种历史形状做正向保留测试；新增一个 conformance 测试，用真实 AgentSession/SessionManager，复用搬出来的 pi-boundary harness，覆盖压缩 → 归档条目 → 重建 replay → 第二次压缩、keep_recent 两种值、归档前后的 navigateTree、上下文不受影响                                                                                          | §3                        |
| —   | 评审确认无误 | 持久化模型、压缩后追加条目的顺序、交接 facts、nudge 隔离、子会话接线、TaskList 字节一致性、保持简单        | 全部保留。另外明确两点：nudge 在压缩时被重置，不承诺跨压缩；归档的 `turn_end` 注册在 nudge 条件之外                                                                                                                                                                                                                                        | §0、D1、D8                |

## 8. v2→v2.1 主会话裁定（评审第 2 轮，按评审收敛规则直接修订）

| #   | 级别    | 问题                                                                                             | 处置                                                                             |
| --- | ------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| B1  | Blocker | `todoProjection` 无条件调用 `deps.todo!()`，`todo.enabled=false` 时整个 status/snapshot 生成失败 | §2 agent/index.ts：两个调用点保留可选源门，并补 `todo.enabled=false` 回归        |
| 8   | Minor   | conformance 测试未保证 `compact()` 有可摘要区间                                                  | §3：harness 加可选压缩保留预算参数（默认不变），本测试调小，保证两次压缩都可准备 |

原 1–7 项评审已确认在方案层面关闭。
