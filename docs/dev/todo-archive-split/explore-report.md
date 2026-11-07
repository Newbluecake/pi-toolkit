# todo 持久化 · 归档任务分离存储可行性报告（#92 探索）

探索：Explore (deepseek/deepseek-flash) r_8FRXV8QA，2026-10-29。只读，未改任何文件。行号基于当时工作区。

## 0. 结论先行

**有条件可行。** 拆分是纯存储层改动（web wire 一行不改、TUI/投影模型一行不改）。最大的两个坑不在「怎么写」而在：**归档任务并非不可变**（`archive-dedup-plan.md` §4 的待核实前提，核实结果：**前提不成立**）和**跨存储依赖边 + 校验不变式**（`validateState` 要求所有 `blockedBy/blocks` 目标在同一个 `tasks` 数组里，否则整条快照判脏、`restoreState` 返回 undefined、状态整段丢失）。

**正交且收益更大、成本更低的快赢**：每次 Task\* 调用的 toolResult `details.state` 里都塞了一份全量快照并被 pi 写进会话文件（§1.4）——变更双份、只读一份。

## 1. 持久化机制

- customType `"claude-code-todo-state"`（常量 `STATE_ENTRY`，merge-plan D3 钉死字符串，I7）；data 形状 `TodoState = { tasks: Task[]; nextId: number }`，**没有 `v` 版本字段**（`src/todo/state.ts:28-31,50`）。
- 写入 `pi.appendEntry(STATE_ENTRY, cloneState(state))`（`src/todo/index.ts:272-274`）。
- 归档表示：**没有独立列表/布尔——存在 `archivedAt` 即已归档**（presence-based，`state.ts:77-81`）；只有 completed 才有意义。归档任务与普通任务在快照里结构完全相同（含完整 description/metadata/依赖边）——这就是「39KB 里 92% 是归档」的直接原因。
- 读回唯一入口 `replayState(entries)`（`state.ts:376-393`，纯函数，最后合法候选胜出），识别两种历史形状：custom entry 和 toolResult `details.state`（旧形状，**现在仍在写**）。`restoreState`（:310-373）白名单重建 → `validateState`（:395-465：id 唯一、依赖存在且双向一致、无环）→ 抛错即候选作废。
- **第二个独立读者**：`src/context-switch/session-facts.ts:78-85` 自己 `getBranch()` + `replayState`（switch_context 交接的未完成 todo）——格式改动必须让它零改动通过。
- 写触发点：TaskCreate / TaskUpdate(changed) / TaskDelete / `/tasklist clear` / sweep（压缩时 + 第 N 轮 turn_end）；TaskList/TaskGet 不写；restore 不写。

### 1.4 写放大账

每次 Task\* 工具调用返回值带 `details: { action, state: cloneState(state), ... }`（`index.ts:352,392`）——**包括只读的 TaskList/TaskGet**；pi 把 toolResult（含 details）落盘。⇒ 每次变更 = 1 custom entry + 1 toolResult（双份全量）；每次只读 = 1 toolResult（一份全量）。实测主会话 `claude-code-todo-state` 444 条/8.44MB，最后一条 39.2KB/90 task/84 归档占 92%。hub 侧还要对每条 custom entry 做 `canonicalJson+fnv1a` 哈希（`web-hub/protocol/keys.ts:36-91`）。

**快赢**：`details.state` 唯一消费者是 `replayState` 的第 2 种历史形状（全仓仅 tests/todo 引用）。新写入不带 `state`（读回端保留兼容读）即砍掉重复份，读回语义不变。

## 2. 归档任务语义（可变更性核实：不是不可变！）

- 进入归档：只有 `archiveCompleted(state, ids|"all", now)`（`state.ts:129-142`）；触发 = 压缩时 + 第 N 轮 sweep；**无手动归档工具**。
- **归档后可变更**：`TaskUpdate` 改 subject/description/owner/metadata 允许且保持归档（`updateTask` 无 isArchived 守卫）；unarchive 唯一路径 = TaskUpdate status→非 completed（清 completedAt+archivedAt）；TaskDelete 允许；加/删依赖边允许（会给归档任务写对向边）；TaskGet 允许（行尾 ` [archived]`）。
- 展示/消费：aboveEditor widget 完全不出现不计数；`/tasklist` 折叠模式只给计数；TaskList 页脚计数；web TodoPanel 只有计数（需 hub cap `todo.archive.v1`）；**依赖/阻塞计算必须吃全量 tasks**（D7 不变式）。
- **数量帽：没有。** 归档任务无限增长（O(N²) 根源）。对照：fleet 归档有 `ARCHIVE_ENTRIES_CAP=256`。

## 3. 快照消费方全清单

restore() 恢复（需要归档，否则校验爆炸）；session-facts（走同一格式，须零改动通过）；TUI widget/面板（闭包内存态）；web StatusInfo.todo 投影（只需计数）；web 转写（custom 只发 dataKey 哈希；toolResult 会把 details.state 截断发到浏览器）；nudge/compact-hint tracker（不需要归档）；依赖/orderTasks/计数（需要全量）。

## 4. 分离存储设计空间

形态：A 全量归档快照（先例 src/archive）/ **B 增量包+墓碑（推荐：op add/drop，按分支顺序 fold）** / C 副本保留（无收益）。

写路径 7 个场景（含易漏点）：普通变更只写 live；sweep 归档**先写 archive add 包再写 live 快照**（顺序不能反）；归档任务被编辑 → archive add（upsert）；被重开 → live 快照 + archive drop；被删除 → archive drop；**`/tasklist clear` 必须同时写 archive drop-all（易漏）**；live 任务新增指向归档 id 的边 → 只写 live（归档侧边失同步可接受或 upsert）。

读路径：合并收口在 `replayState` 一处：先 fold 归档、再取最后合法 live 快照、合并（**id 冲突 live 胜**，重开天然自愈）、`nextId = max(...)`、**合并后才 validateState**。旧会话兼容：无归档 entry ⇒ 与今天逐字节一致。

**最硬约束（§4.4）**：`validateState` 要求依赖目标同在一个 tasks 数组；现实里跨边是常态（pending blockedBy 已归档的 completed）。解法三选一，**推荐 (c) 合并后校验**：restoreState 只做字段白名单重建、图校验挪到合并后跑 `(validateState(merged))`。(a) 归档剪边（改变语义）；(b) 给 validateState 加外部 id 集参数（侵入纯函数契约）。

/reload、分支回退、跨会话一致性：两类 entry 都是分支条目，合并只读分支；归档事件两条 entry 相邻写入；分支切到中间点 → live 胜 → 表现为未归档（良性）。「session 文件即真相」仍成立，真相变成两类 entry 的 fold，必须 replayState 一处收口。

先例：src/archive（独立 customType、全量+最后合法、A1 相同不写、FIFO 帽+held、写入率不变式测试）；prompt-sections/store.ts（`v:1` + 逐字段 sanitize + fail-closed）；state.ts 自身的「单字段可丢、候选仍有效」。

## 5. 冻结面与不变式

- tests/fixtures 无 todo golden；撞不到 A 级。沾边的都是 B 级（activate-trace 钉注册顺序——纯存储拆分不新增注册 ⇒ 不用动）或名字清单。
- I9 安全（todo.enabled=false 时零 entry）；I10：存储格式不是 wire，零 wire 影响；未来若要在 web 列归档行走既有 cap 门先例（不升 PROTO）。
- customType `claude-code-todo-state` 不能改语义；归档包用**新** customType。新 customType 在 TUI 无 renderer 不污染转写；web 走 tombstone 但每条仍付哈希成本（增量包小，净收益）。
- **降级兼容（最尖锐）**：旧版扩展只认最后一条 `claude-code-todo-state`：live 快照不含归档 id，但 live 任务 blockedBy 指向归档 id ⇒ 旧版 validateState 抛错 ⇒ **整段 todo 状态丢失**（数据在盘上、升级即恢复）。

## 6. 可行性判定：有条件可行

必要条件：

1. 合并收口 replayState 一处 + id 冲突 live 胜 + 图校验挪到合并后（§4.4c）。
2. 写顺序固定（归档包先、live 后）；clear 写 drop-all；归档任务的编辑/删除/重开/加边四路径都更新归档包。**不能假设归档任务不可变**。
3. 降级口径拍板二选一：(a) 接受旧版读新会话整段丢失（升级即恢复）；(b) 归档剪边保持 live 自足（unarchive 后依赖丢失）。探索者倾向 (a) + 给 state.ts 加「引用未知 id 时降级为丢该边而非整条作废」的宽容读（顺手修掉今天的脆弱点）。
4. 两类 entry 加 `v: 1` + sanitize。
5. 归档集加上限 + 收敛守卫（照 src/archive），否则归档包本身变成新的 O(N²)——**这条决定选形态 B 增量**。
6. 正交快赢建议同包做（<40 行）：toolResult `details.state` 新写入去掉（读回兼容保留）+ live 快照「内容相同不写」守卫。

不建议：归档任务压成墓碑（去 description）——只省 61% 且破坏「TaskGet still works on them」承诺。

改动面（估）：src/todo/state.ts（类型+fold/merge+校验重排）、src/todo/index.ts（persist 双写 + 写路径 + sweep/clear）、session-facts.ts（理论零改动需回归）；tests/todo/\* + tests/conformance/todo-archive.test.ts + 新增 tests/todo/archive-store.test.ts + todo-projection 计数不变；文档 todo-archive/plan.md（D10+）、todo-web/README.md、refresh-slow/archive-dedup-plan.md §4 回填「前提已核实：可变」。
