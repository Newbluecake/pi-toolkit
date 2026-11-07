# #89 会话文件水份治理：`subagent:archive` / `claude-code-todo-state` — 方案（Plan, 2026-10-28）

> 输入：`explore-report.md` §「文件为何 193MB」。本方案只读代码 + 对主会话文件
> `~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/2026-10-22T06-18-24-491Z_01a16242-….jsonl`
> （206.9 MB / 31,744 行，18:40 采样）做逐条 diff 实测。车道：**L1**（单模块、≤2 个源文件 + 测试）。

## 0. 背景（≤5 行）

主会话文件里 `subagent:archive` 有 5,525 条、91.5 MB、单条 16.5 KB，自 10-24 起几乎每分钟写一条；`claude-code-todo-state` 有 444 条、8.4 MB。
原任务假设这些是「内容几乎全同」的重复快照，想靠内容去重或增量写入来压增长。
**实测推翻了这个前提**：相邻两条快照没有一对 JSON 完全相同。每分钟一条的写入来自 sweep 超 256 帽导致的不收敛 bug，**`cd57bdf9`（10-27 23:34）已修复**。
10-28T01:35Z 这次 /reload 生效后，archive 写入从每天约 24 MB 降到 9 小时 6 条、约 0.1 MB。
因此 #89 的范围要收窄：archive 只做防回归加固；todo 是另一种 O(N²) 问题，另开。

## 1. 每分钟一条的触发源（代码 + 数据证据）

### 1.1 逐条 diff 结果（5,524 对相邻快照）

| 指标                                                                   | 数量           |
| ---------------------------------------------------------------------- | -------------- |
| JSON 完全相同                                                          | **0**          |
| id 集合相同、仅 `at` 变化（256 条 `at` 全部等于本轮 now，Δ=60,001 ms） | 4,790（86.7%） |
| id 集合整体互换（256+/256−，即 A/B 翻转）                              | 659（11.9%）   |
| 小幅真实变化（1+/1− 等）                                               | 75             |

按小时分桶看，有两个阶段：

- **阶段 1**：10-24 05:47Z 到 10-27 14:00Z，每分钟 1 条，**只改 `at`**。这段跑的是 `998dce27` 的代码。
- **阶段 2**：10-27 14:00Z 到 10-28 01:34Z，每分钟 1 条，**整组互换**。这段跑的是 `43d892fd` 的 keep-count 代码。
- **修复后**：10-28T01:35Z 之后共 6 条，都是手动归档或 `archive_omitted` 批量操作，`auto` 数从 256 降到 251。

### 1.2 根因：sweep 选中的条目数超过 `ARCHIVE_ENTRIES_CAP`

两个阶段的根因相同：sweep 每轮选中的条目超过 256 帽，FIFO 淘汰掉的条目下一轮又被重新选中，状态永远收敛不了。

- **阶段 1（`998dce27:src/archive/control.ts` sweep）**
  - sweep 在循环里对 `next` 逐条判断 `autoArchiveDue`，再调 `archiveItem`。
  - 687 个终态 run 逐个入列，`capTail` 在同一轮内把先入列的挤掉。
  - 最终留下的总是候选顺序里最后 256 个，id 集合不变，但每个都重新写了 `at=now`。
  - 上一轮被挤掉的条目在下一轮又是「未归档 + 到期」，于是每轮都 `changed=true`，每轮都写。
- **阶段 2（`43d892fd`）**
  - `selectAutoArchives` 基于起始状态选出全部 excess，有 431 个以上。
  - FIFO 只留下其中 256 个，下一轮选中的是另外那一组，形成 A/B 翻转。
- **修复（`cd57bdf9`，现行 `src/archive/sweep.ts:58-95`、`src/archive/control.ts:257-286`）**
  - `selectAutoArchives` 的选中数不超过 `archiveRoom`（空位数 + 已不在 live 列表里的条目数）。
  - `makeArchiveRoom` 优先淘汰 gone 条目。
  - 达到稳态后 `selected.length === 0`，直接 return（`control.ts:273`），不写。
  - 测试 `tests/archive/control.test.ts:259`「converges … neither change the set nor write entries」已钉住这一点。

### 1.3 去重能消掉多少

| 方案                           | 对历史 5,524 次写入的消除比例                          |
| ------------------------------ | ------------------------------------------------------ |
| 内容哈希 / 结构相等去重        | **0%**（没有任何一对相邻快照完全相同）                 |
| 「忽略 `at` 的语义相等」去重   | 86.7%（只能挡住阶段 1，挡不住阶段 2）                  |
| 收敛修复（`cd57bdf9`，已上线） | **≈100%**：修复后 9 h 内 0 次自动写，只有 6 次真实变更 |

**结论**：内容去重对这次事故无效。真正生效的是收敛修复，而它已经上线。
现行代码里也找不到「内容没变却写」的路径：

- `archiveItem`/`unarchiveItem` 在无变化时返回 `undefined`（`state.ts:128-161`）。
- `setArchived` 在 `next===undefined` 时不 commit（`control.ts:160-170`）。
- `setArchivedMany` 只在 `next!==this.state` 时 commit（`control.ts:214`）。
- sweep 只在 `changed` 为真时 commit（`control.ts:285`）。

全机核查：18:40 时，最近 3 h 内有写入的所有会话文件中，10-28T08Z 之后带 archive 写入的只有主会话 1 条。没有任何旧代码进程还在刷屏。

## 2. 方案（archive，必须做的部分 = 防回归加固）

### A1. `commit()` 加「与最后一次持久化相同则不写」守卫

本身价值很小，属于纵深防御；主要是给 A2 的不变式提供一个可断言的实现面。

- **`src/archive/state.ts`（在 `:161` 后新增）**
  - 新增纯函数 `sameArchiveState(a, b): boolean`。
  - 对 `entries` 与 `held` 做**有序、逐字段**比较（kind/id/at/auto，以及 hold 的 kind/id/at）。
  - **不用哈希**：256×4 个标量的比较是微秒级；哈希反而要先 canonicalize，正是 explore 报告里 `canonicalJson` 那个热点。
- **`src/archive/control.ts`**
  - 新增实例字段 `private lastPersisted: ArchiveState = emptyArchiveState()`。
  - `restore()`（`:79-83`）里写 `this.lastPersisted = this.state`：read-back 出来的就是盘上最后一条合法快照。
  - `commit()`（`:220-229`）改成：
    ```ts
    private commit(next: ArchiveState): void {
      if (!sameArchiveState(next, this.state)) { this.state = next; this.rev++; }
      if (sameArchiveState(next, this.lastPersisted)) return;      // 盘上已是此内容
      try {
        this.deps.appendEntry("subagent:archive", { entries: next.entries, held: next.held });
        this.lastPersisted = next;                                 // 仅成功才推进
      } catch { /* best-effort：lastPersisted 不动 ⇒ 下次 commit 自动补写 */ }
    }
    ```
- **哈希/基线放哪（I4）**：放 ArchiveControl 的实例字段，**不放 `Symbol.for`**。
  - ArchiveControl 每次 `session_start` 都会重建（`src/stack.ts:1393-1410`）。
  - `session_tree`/`session_compact` 时 `src/index.ts:304-315` 会调 `restore(getBranch())` 重新播种。
  - 「会话文件是唯一真相」：`/reload` 后基线从 branch 重建，和内存状态天然一致，不需要跨 activate 共享。
  - 用 Symbol.for 反而有风险：/new 或 /resume 换文件后，会拿旧文件的基线误判新文件。
- **失败语义**：与现状一致，并且更强。
  - 现状是 append 抛错就吞掉，等下一次变更再全量补写（`control.ts:225-227` 注释）。
  - 加守卫后，append 失败时 `lastPersisted` 不前进，下一次 commit 即使状态和内存相同也会补写。
  - rev 只在内存状态真变时才 bump，不会多出一次空帧。

### A2. 写入率收敛不变式测试（真正的回归闸）

这条测试同时能抓住阶段 1 和阶段 2，A1 抓不住。新增 `tests/archive/write-rate.test.ts`，用 fake timers + 种子化 LCG 候选流。场景如下：

1. **稳定大舰队**：700 个终态 run + 40 个终态 bash 保持 live，sweep 1,440 次（24 h）⇒ `appended.length ≤ 1`。
2. **滚动淘汰**：每 10 个 sweep 新出 1 个终态 run，同时最老的 1 个 run 从 live 消失（模拟 registry 回收）⇒ `appended.length ≤ 新增终态数 + 1`。
3. **相邻快照语义差异**：对任意相邻两条 appended 快照，要么 id 集合不同，要么 auto/held 不同。**禁止只有 `at` 变化**，这是阶段 1 的形态。同时断言没有一对 `sameArchiveState` 为真（A1）。
4. **翻转检测**：任意 3 条连续快照，第 1 条与第 3 条的 id 集合不得相同而第 2 条不同，即不允许 A/B/A。
5. **恢复等价（reload 后基线重建）**：
   - 把 appended 数据包装成 branch（`{type:"custom",customType:ARCHIVE_ENTRY_TYPE,data}` 的序列）。
   - 断言 `readArchiveState(branch)` 与 `control` 内存状态 deep-equal。
   - 再用同一个 branch `restore()` 一个**新** control，跑同样的候选再 sweep 60 次 ⇒ 新 control 的 `appended.length === 0`。也就是 reload 本身不触发写入，基线重建正确。
6. **失败补写**：`appendEntry` 第 1 次抛错，之后正常。手动归档 X（append 失败）后再手动归档 Y ⇒ 第 2 次 append 的快照里同时含 X 和 Y。把 Y 改成一次 no-op 调用时（例如 `setArchived` 一个已归档 id），断言不会产生写入，但也不丢 X：在下一次真实变更时补写。

`tests/archive/state.test.ts` 补 `sameArchiveState` 的单测：顺序敏感、`auto` 缺省与 `false` 等价、`at` 不同则判为不等、held 也参与比较。

### A3（可选）`scripts/dev/session-entry-stats.mjs`

把本方案的分析脚本固化下来：流式读 jsonl，按「日 × type:customType」统计字节与条数，再对指定 customType 做相邻 diff 分类（identical / at-only / id-swap / small）。
用途：verifier 验收时复测；以后再怀疑「水份」时一条命令出数。只依赖 `node:*`，不进 `src/`，不碰 I8 边界。

## 3. 消费者兼容性（问题 3）

| 消费者                                                                                                                          | 读什么                                                                  | 依赖「定期快照心跳」吗           |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| `ArchiveControl.restore`（stack build `stack.ts:1399-1403`；`session_tree`/`session_compact` `index.ts:304-315`）               | `readArchiveState`：branch 上**最后一条合法**快照（`state.ts:102-110`） | 否。读的是最后一条，不是最近一条 |
| web `StatusInfo.archived`（`web-hub/agent/status.ts:163`）、TUI fleet widget（`stack.ts:1538` → `view()`）、UI `archiveView.ts` | 内存 `wire()`/`view()` + 单调 `rev`                                     | 否。不读会话文件                 |
| hub history 投影（`protocol/keys.ts:136-190`）                                                                                  | 按条目算 `dataKey`、display:false 墓碑                                  | 否。条目少了只会更快             |
| 其他                                                                                                                            | `rg 'subagent:archive' src/` 只有 state/control/stack/messages 注释     | —                                |

- **恢复语义变不变**：A1/A2 不改恢复逻辑，也不改条目格式。写得少只意味着「最后一条」更老，但内容仍等于最后一次真实变更后的状态，和以前每分钟心跳的内容去掉 `at` 刷新之后一致。
- `/tree` 或 fork 回到旧点时，拿到的是那个点之前最后一次真实变更的状态，语义与现在相同。
- compaction 不会从 path 上删掉 custom 条目，所以 `session_compact` 之后 `getBranch()` 照样能找到很久以前写的那条。
- 旧插件 × 新数据、新插件 × 旧数据：格式不变，双向逐字节兼容（I10 不涉及 wire）。

## 4. todo-state（问题 4）：另开，不同包

实测数据：

- 444 条 / 8.44 MB；相邻快照完全相同的 **0** 对；420/443 次写入恰好只改 1 个 task，都是真实变更。
- 形态是 **O(N²)**：快照随累计 task 数线性变大（最后一条 39.2 KB，90 个 task，其中 84 个已归档）。**已归档 task 占快照 92%**（36.2 KB / 39.2 KB）。
- 日写入量 0.5–2.0 MB。修复后的 9 h 里它是第二大来源（1.96 MB，占 15%），第一是 toolResult 5.83 MB。

各方案对历史 8.44 MB 的估算：

| 方案                                        | 估算总量         | 代价 / 契约冲突                                                                                                                                           |
| ------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容去重                                    | 8.44 MB（0%）    | 无效                                                                                                                                                      |
| 增量（只写变化的 task，周期 checkpoint）    | ≈0.27 MB（−97%） | `replayState`（`todo/state.ts:375-394`）要从 checkpoint 起 fold；旧插件只认最后一个全量，降级时会拿到陈旧状态                                             |
| 快照里剔除已归档 task                       | ≈1.26 MB（−85%） | 破坏 `TaskGet <id> still works`（`todo/index.ts:725`）、web TodoPanel 的 archived 计数（`web-hub/agent/todo.ts:91/157`）、TUI showAll（`todo/ui.ts:133`） |
| 已归档 task 压成墓碑（去掉 description 等） | ≈3.31 MB（−61%） | TaskGet 对已归档 task 不再返回全文                                                                                                                        |

**决定：另开 issue，不并入 #89。** 理由：

1. 根因不同：archive 是 bug 导致的心跳写，todo 是正确的全量快照随规模膨胀。
2. 所需方案（增量 + checkpoint）要改 replay 和 TaskGet/归档契约，要先读 `docs/dev/todo-archive/`、`docs/dev/todo-web/` 的不变式。
3. 改动面在 `src/todo/`，和 archive 不重叠，放在一起没有协同收益。

建议新 issue 的方向：

- 推荐「已归档 task 一次性落 `claude-code-todo-archive` 增量条目，主快照只带 open 与未归档的 completed」。
- 前提：archiveCompleted 只设置 `archivedAt`，已归档 task 不可变。~~此前提需在新 issue 里核实~~。**回填（2026-10-29，#92）：已核实，前提不成立**——已归档 task 可编辑（TaskUpdate 改 subject/description/owner/metadata）、可重开（status→非 completed）、可删除（TaskDelete）、可加/删依赖边（对向边会写到归档 task 上），见 `../../todo-archive-split/explore-report.md` §2。最终方案见 `../../todo-archive-split/plan.md`（增量 upsert/drop 包 + live 胜合并 + 256 驱逐帽，不是本节当初没写完的墓碑方案）。
- 这样主快照稳定在约 3 KB，而且不破坏 TaskGet。

## 5. 增量 vs 去重的取舍（问题 5）

| 维度                     | A1 去重守卫 + A2 不变式（推荐）                                                                                           | archive 增量（`subagent:archive-delta` + 周期全量 checkpoint）                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 实现复杂度               | ≈30 行源码 + 1 个测试文件                                                                                                 | 新 entry 类型、checkpoint 策略、fold 回放、FIFO 帽在 delta 下的语义、`makeArchiveRoom` 产生的批量 drop 也要编码   |
| 恢复逻辑改动面           | 零                                                                                                                        | `readArchiveState` 改成从最后一个 checkpoint 起正向 fold；`session_tree` 回到旧点、fork 都要复验                  |
| 降级兼容                 | 完全兼容                                                                                                                  | 旧插件忽略 delta，只读最后一个 checkpoint，会**静默拿到陈旧归档集**。只能通过高频 checkpoint 缓解，这又抵消了收益 |
| 修复后剩余写入量         | 实测 9 h 6 条 ≈0.1 MB。最坏估算：每个越过 keep 的终态 run/bash 各占一次 sweep 写，100–200 条/天 × 16.5 KB ≈ 1.6–3.3 MB/天 | 同样的条数 × ≈150 B ≈ 15–30 KB/天                                                                                 |
| 对 256 MB 悬崖的推迟效果 | 已由 `cd57bdf9` 拿到（−24 MB/天）；A1/A2 只防止回退                                                                       | 在已修复的基础上再省 ≤3 MB/天，相对当前约 34 MB/天的总增长（修复后 9 h 12.8 MB 外推）只占 ≤9%                     |

**悬崖判断（如实说明）**：主会话 206.9 MB，离 256 MB 还差约 49 MB。修复后增长的主体是对话本身（toolResult、`subagent:run`），archive 已不是主因。
无论选去重还是增量，悬崖都只能推迟数小时级，**真正拆悬崖靠 P0/P1**（`plan.md`：尾读 + tail 路径不吃 maxFileBytes）。
已经写进文件的 91 MB 历史快照也无法回收，因为会话文件 append-only，本方案不做改写。

**推荐**：A1 + A2（+ 可选 A3）。archive 增量暂不做，设一个触发条件：A3 统计显示 archive 在任一会话的日增长占比超过 5% 时再立项。

## 6. 风险与回退

| 风险                                                                                                                                 | 概率 / 影响                                                                | 缓解 / 回退                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A1 守卫误判「相等」导致漏写（例如字段比较遗漏 `auto`）                                                                               | 低 / 中：reload 后丢失一次变更                                             | A2 场景 5、6 加 `sameArchiveState` 单测覆盖每个字段；回退 = 删除 commit 里的两行守卫                              |
| `restore()` 播种 `lastPersisted` 后，sanitize 截断（`slice(-256)`）导致基线与盘上不一致                                              | 低 / 低：最多多写一次                                                      | 不一致的方向只会多写、不会漏写，可接受                                                                            |
| 并发工作区冲突：P0/P1 包同期改 `docs/dev/web-hub/README.md`（方案撰写时曾有未提交改动，现已提交）                                    | 中 / 低                                                                    | 开发前先确认 P0/P1 包是否已提交；README 只追加一句，提交时精确路径 add                                            |
| 副作用发现（**不在本包范围**）：修复后 256 帽被仍在 live 列表里的条目占满时，`archiveRoom=0`，自动归档会**静默停止**归档新完成的 run | 推断自写入日志（修复后 9 h 里 0 次自动写，10:03 一次手动批量），**未复现** | 记为新 issue：可能需要允许淘汰最老的 auto 条目，或提高 cap。用户可以用 drawer 的 `(+N more)` 手动批量归档临时规避 |

## 7. 测试计划（问题 6）

- **新增 `tests/archive/write-rate.test.ts`**：§2 A2 的 6 个场景。用种子化 LCG（种子写进 describe 名，失败可复现），fake timers 跑 1,440 次 sweep。
- **`tests/archive/state.test.ts`**：补 `sameArchiveState` 单测。
- **`tests/archive/control.test.ts`**：原有用例全部保持不动。flip-flop 回归、`setArchivedMany` 的 appended 计数这些现有断言，在 A1 下语义不变：凡是现在会写的都是真实变更，守卫不会挡住它们。
- **回归集**：`npx vitest run tests/archive tests/web-hub/agent/commands-archive.test.ts tests/ui/fleet-widget-archive.test.ts tests/web-hub/protocol/archive-schema.test.ts tests/web-hub/ui/fleet-archive.test.ts`，然后跑全量 `npm test`、`npm run typecheck`、`npm run format:check`。
- **冻结面**：不碰 `tests/fixtures/`，提交前跑 `git diff --quiet origin/dev -- tests/fixtures/`。entry 格式不变，所以 `history.perf.test.ts` 的合成 archive 负载无需改动。
- **活体验收（verifier，可选）**：`/reload` 后跑 A3，或直接 `grep -c '"customType":"subagent:archive"'` 隔 30 min 采样两次，增量应等于这段时间内真实手动/自动归档的次数。

## 8. 改动文件清单

| 文件                                  | 改动                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/archive/state.ts`                | 新增 `sameArchiveState`；头注释 `:17-20` 补一句「与最后一次持久化相同的 commit 不写」                     |
| `src/archive/control.ts`              | 新增字段 `lastPersisted`；`restore()`（`:79-83`）播种；`commit()`（`:220-229`）加守卫、只在成功时推进基线 |
| `tests/archive/write-rate.test.ts`    | 新增（A2）                                                                                                |
| `tests/archive/state.test.ts`         | 补 `sameArchiveState` 用例                                                                                |
| `docs/dev/web-hub/README.md`          | 「Cap-stable sweep」节（`:246-251`）追加写入率不变式与本方案链接                                          |
| `scripts/dev/session-entry-stats.mjs` | 可选（A3）                                                                                                |
| 新 issue（不在本包）                  | ① todo-state 增量化（§4）；② 256 帽被 live 条目占满后自动归档停摆（§6）                                   |
