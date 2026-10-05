# todo list 上 web 页：实施方案 v1（任务 #10）

> 状态：T1–T4 已落盘并验收（T1-T3 `183f825`、T4 `09cbeec`）；T5（卡片徽标）可选未做；v1 只读定案。
> 需求：用户想在 web（web-hub 浏览器 UI）上看到主会话的 todo list（`src/todo/` 的 Task* 工具维护的任务列表，TUI 侧为 aboveEditor 小组件）。
> **基线：`fa0395d`（master HEAD，fleet-drawer F5 已合入）**。本文引用代码一律以符号名为准，行号只作参考；只写方案，不改实现。
>
> **在途线**（开工前必须重新核对）：
>
> - **fleet-drawer F6（UI 抽屉）未开工**：文件域含 `detail/AgentDetail.vue`（模板重构）、`contracts.ts`、`styles/detail.css`、`transcript/*`、`drawer/*`（新）。本方案 T4 已按「不碰 F6 文件域」设计（TodoPanel 挂 `DetailHeader.vue`，后者不在 F6 域内），仅 `styles/detail.css` 有低风险追加（见 §8）。
> - **@文件包（file mention / 文件搜索线）在途**（编写本方案时工作区可见未提交改动）：`hub/http.ts`、`hub/ports.ts`、`hub/file-search.ts`（新）、`ui/src/logic/file-mention.js`（新）等。本方案 T1–T6 的文件域与其**零交集**（本方案不碰任何 hub/ 文件，也不碰 Composer/mention 逻辑）；唯 `protocol/messages.ts`（T2）为双向热点，同期合入时后提交方 rebase 追加段即可（两侧均为 append-only）。
> - F5（UI runTx 状态机与传输层）已合入 `fa0395d`，`logic/state.js`、`ui/src/types.ts`、`composables/useHub.ts` 已稳定，不再是冲突面。

## 0. 结论速览

| 决策点      | 结论                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 数据通道    | **搭乘 `StatusInfo.todo`**（可选字段，status slot 既有的整条生命周期免费复用）；不开新帧、不开拉取端点、不让 hub 读盘                                                    |
| 范围        | **主会话 todo only**（todo 是会话级状态；子 agent 会话各有独立 todo 态，但 web-hub 接线是 post-guard 主会话专用，聚合子 agent 留给 v2）                                  |
| 只读/可操作 | **v1 只读**。无勾选、无编辑（理由见 §2.3）                                                                                                                               |
| 展示        | 详情页 `DetailHeader` 下方**可折叠区块** `TodoPanel.vue`（新组件；常驻一行摘要 `Tasks 3/8 · 2 active`，点击展开任务列表；空态整个区块不渲染）；AgentCard 徽标为可选包 T5 |
| 更新时延    | agent 侧 1Hz tick 内轻量指纹比对，变化 ⇒ `publishStatus()`，最坏 1s 时延（与 fleet 行同级）                                                                              |
| 设置        | **零新增设置**。门控 = `todo.enabled` ∧ `webHub.enabled`（均默认 true；任一关闭 ⇒ `status.todo` 字段整个缺失）                                                           |
| 预算        | 投影封顶 32 任务、description 截 240 字节（UTF-8 安全），最坏 ~32 KiB，常态 < 2 KiB；空任务列表 ⇒ 字段省略，字节级等价于现状                                             |
| 拆包        | T1 源出口 → T2 协议+投影 → T3 agent 接线 → T4 UI 区块 →（T5 卡片徽标，可选）→ T6 文档收尾；除 `styles/detail.css` 追加外**与 F6 文件域零交集**                           |

## 1. 现状核对（HEAD `fa0395d`）

- **todo 状态模型与持久化**（`src/todo/state.ts`、`src/todo/index.ts`）：
  - `TodoState = { tasks: Task[]; nextId: number }`；`Task` 含 `id/subject/description/status/owner/activeForm/blocks/blockedBy/createdAt/updatedAt`。subject ≤ 200 字符、description ≤ 4000 字符（`createTask` 的 `requiredText` 上限）。
  - 每次变更经 `pi.appendEntry(STATE_ENTRY, cloneState(state))` 全量落盘，`STATE_ENTRY = "claude-code-todo-state"`，pi 侧为 **`CustomEntry`（type:"custom"）**——不进 LLM 上下文，data 本体只存在于会话文件与进程内存。
  - `replayState(branch)` 在 `session_start/session_tree/session_compact` 时从 `sessionManager.getBranch()` 重建闭包态 `state`。**todo 是会话级状态**，子 agent 会话（todo 工具 pre-guard 注册，child 也可用）各自持有独立的 `state` 闭包与各自的 session 文件。
  - `wireTodo(pi)` 已有返回值先例：nudge 启用时返回 `getTrackerSnapshot`（`TodoWireResult`），由 `src/index.ts` 捕获并穿线给 `createSwitchContextTool`。
- **wire 投影不透传 custom data**（`src/web-hub/protocol/keys.ts` 的 `projectSessionEntry`）：`custom(data)` 条目投影为 `{type:"custom", customType, dataKey, display:false}`——**data 本体刻意不下发**（对账用内容键，显示层不需要）。因此「hub 从会话文件读 todo」天然不通，见 §2.1-D。
- **status 通道全链路**（本方案免费复用的部分）：
  - agent：`readStatus(ctx, tap, fleet, queueMirror?)` → `StatusInfo`（`agent/status.ts`）；`publishStatus()` 以 `setSlot("status", …)` 覆盖式发布（`agent/index.ts`），触发点 = `STATUS_EVENTS`（agent_start/end/settled、turn_end、session_compact）+ 1Hz tick 内 `leafId` 变化 + `connectWith`（连接建立/复用）。
  - slot 语义（`agent/connection.ts`）：overwrite-only，断线重连进入 live 时按 `SLOT_ORDER` 重放，无需 agent 记忆「谁订阅了」。
  - hub：`registry.ts` 的 `case "status"` 存 `r.status` 并 publish `HubEvent "status"` → `http.ts` `onHubEvent` → `sse.publish("status", {agentKey, status})`；`toCard()` 白名单已含 `status` ⇒ 迟到的浏览器经初始 `agents` 帧 / `agent_up` 拿到同一份。
  - 浏览器：`logic/state.js` `case "status"` 整体替换 `a.status`；`newAgent(card)` 初始化 `status: card.status`。**`StatusInfo` 增加可选字段对 hub 与 reducer 完全透明。**
  - 校验：`StatusFrameSchema = Type.Object({t, ...StatusInfoSchema.properties})`（`protocol/messages.ts`）**没有 `additionalProperties:false`** ⇒ 旧 hub 解码带 `todo` 字段的 status 帧照常通过（前向兼容，无需 proto bump；upload/spawn/preview 加 caps/端点不 bump 的同一惯例——本方案连帧种类都不加）。
- **`StatusInfo` 已有「带正文的列表」先例**：`status.queue: QueueItemWire[]` 携带用户提交的队列文本（多条、任意内容）。todo 摘要与它同级，不引入新的载荷类别。
- **快照/详情路径**：`buildSnapshotReply`（`agent/snapshot.ts`）内嵌 `readStatus` 产物 ⇒ `snapshot_reply.status` 自动携带 todo；hub 订阅时的 `history` 快照与 `AgentCard.status` 同源。
- **1Hz tick 与指纹先例**：`onTick`（`agent/index.ts`）已有 `lastFleetFp`（`fleetFingerprint`，`agent/status.ts`）比对——仅真实变化才 `setSlot("fleet", …)`。本方案照抄该模式（§3.3）。
- **UI 挂载点**：`DetailHeaderProps = { agent: AgentState; narrow: boolean }`（`ui/src/contracts.ts`）——**整个 AgentState 已经传给 DetailHeader**，读 `agent.status["todo"]` 不需要动任何冻结 props；`AgentDetail.vue` 模板挂 `<DetailHeader :agent="agent" …>`。`DetailHeader.vue` 不在 F6 文件域。
- **会话边界序**：`wireTodo` 的 `session_start` 处理器先于 `wireWebHub` 的（pre-guard 注册在前，pi 按注册序派发）；且 web-hub 的 session_start 里 `publishStatus` 本就延迟到 `setImmediate`。todo restore 先于 status 采样，无序依赖。
- **信息暴露等级不变**：`TaskList` 工具调用的结果文本（含全部任务行）本来就进 transcript、本来就在 web 上可见；web todo 面板不暴露任何 transcript 里没有的内容。

## 2. 设计决策

### 2.1 D1 数据通道：搭乘 `StatusInfo.todo`

**结论**：`StatusInfo` 增加可选字段 `todo?: TodoWire`（§3.1），随 status slot 的既有生命周期流动。

**理由**：

1. **数据特性匹配**：todo 更新频率低（只在 Task* 工具调用时变化，一轮对话通常 0–3 次）、体小（封顶后最坏 ~32 KiB、常态 < 2 KiB）、无需分页/订阅粒度控制。「低频小数据 + 全量快照语义」正是 overwrite-only slot 的理想载荷。
2. **全链路零改动面**：slot 发布/重放、hub 转发与存储、`AgentCard` 镜像、SSE `status` 事件、reducer `case "status"`、`newAgent(card.status)`——六段管线全部现成， StatusInfo 加字段后**自动**到达浏览器与迟到订阅者。改动集中在 agent 侧 4 个文件（§6）。
3. **前向兼容零成本**：`StatusFrameSchema` 无 `additionalProperties:false`，旧 hub + 新 agent 共存无碍；无新帧种类 ⇒ 不动 `SlotKind`/`HubEvent`/`SSE_EVENTS`/`PROTO`。
4. **一致性语义免费**：todo 与 busy/leafId/queue 在同一帧内原子采样（`readStatus` 单次调用），浏览器不会看到「新 leaf + 旧 todo」的错位。

**备选与否决**：

- **B. 独立 `todo` 帧 + SlotKind**（dialogs/commands 模式）：语义更干净、StatusInfo 不膨胀。否决于 v1：需改 `protocol/messages.ts`（帧+schema 表）、`agent/connection.ts`（SlotKind/SLOT_ORDER）、`hub/registry.ts`/`ports.ts`/`http.ts`（HubEvent+SSE+toCard）、`http-contract.ts`（SSE_EVENTS+AgentCard）、`logic/state.js`（新 case）——约 12 文件的热面，换来的隔离收益对 ≤32 KiB 载荷不成立。**保留为升级路径**：未来若要 per-task 分页、子 agent todo 聚合、或 description 全文，按 dialogs 模式平移（届时 minor bump）。
- **C. 拉取端点**（`GET /api/todo` → hub `todo_req` → agent `todo_reply`，branch_req 模式）：为「按需」付出 request 机制 + 缓存失效 + 迟到者冷启动的复杂度；todo 无人看时也在变（模型自驱更新），拉取模式反而要处理「正在看的人如何知道该重拉」。否决。
- **D. hub 读会话文件**（run-file-reader 模式）：`projectSessionEntry` 刻意丢 custom data 本体（`dataKey` 对账不变量，`protocol/keys.ts` 头注释），为 todo 开「透传 raw data」后门破坏该冻结约定；且 agent 内存里已有权威态，读盘引入第二真源（brand-new 会话首条消息前甚至没有文件）。否决。

### 2.2 D2 范围：主会话 todo only

**结论**：v1 只投影主会话（hub 所附着的那个 pi 进程会话）的 todo。

**理由**：

1. **存储维度查证**：todo 状态是会话级——`claude-code-todo-state` 条目写进该会话自己的 jsonl，`replayState` 从该会话的 `getBranch()` 恢复；不存在全局 todo 存储。
2. **接线维度事实**：`wireWebHub` 是 post-guard（HOST_KEY 之后）主会话专用；子 agent 会话从不连 hub，其 todo 态无出口。本方案的数据源是 `wireTodo` 闭包的活内存（经 `src/index.ts` 穿线），天然只有主会话一份。
3. **价值判断**：子 agent 的任务规划对「会话总览」有价值但非首需；且子 agent 通常不用 Task* 工具（todo widget 是 TUI 主会话专属）。

**备选（v2 展望，§9）**：聚合子 agent todo——用 fleet-drawer 已建立的 `RunDiagnostics.sessionFile` + 终态 run 读盘链路，但需为 `claude-code-todo-state` 单开「custom data 透传」的受限投影（仅此 customType），是一份独立评审的工作量。

### 2.3 D3 只读 v1（不做 web 勾选完成）

**结论**：v1 web 端零写路径，纯展示。

**理由**：

1. **无既有变更入口**：todo 模块的变更全部走工具调用的 `enqueue()` 串行队列（五个 Task* 工具体内部闭包变更）；外部没有任何受控写 API，web 写路径要先在 `TodoWireResult` 上开 mutation 端口并定义并发语义。
2. **与模型计划的竞态**：todo 是模型的作战计划；web 远端改 `status` 而模型不知道（除非再注入消息），下一次 `TaskList` 就出现「计划自己变了」——一致性成本高于收益。写路径必须与模型的工具调用在同一队列串行化并考虑「正在 in-flight 的 TaskUpdate 冲突」策略，这是控制平面级别的评审量。
3. **LAN 安全面保持只读**：与 transcript 同级的信息暴露已是用户接受的边界（lan-plan/fleet-drawer §7.0 的明文裁定），写能力是新的权限等级，不应搭只读展示的车悄悄引入。
4. **TUI 对称性**：TUI 侧用户同样只能看（`/tasklist clear` 除外），web 超前于 TUI 提供操作没有先例支撑。

**v2 写路径草描**（不承诺）：`CmdArgs` 新 op `"todo_update"`（如 `{action:"set_status", taskId, status}`），agent 侧经 `TodoWireResult` 新增的 `applyRemoteUpdate()` 汇入 `enqueue()` 队列并 `persist()`；caps `todo.v1` + `webHub.control` 双门控。届时需单独评审冲突策略与通知模型的机制。

### 2.4 D4 展示位置与形态

**结论**：

- **主展示**：新组件 `components/detail/TodoPanel.vue`，挂载在 `DetailHeader.vue` 模板底部（SessionInfo/metrics 行之后），详情页常驻。
  - **折叠态**：一行摘要按钮 `Tasks 3/8 · 2 active`（口径与 TUI widget 标题一致，`todo.counts` 驱动；`aria-expanded`，开合状态存 localStorage `webhub.todoPanel.open`，默认展开——注意与 fleet-drawer 的 `webhub.fleetDrawer.open` 同 key 前缀惯例）。
  - **展开态**：任务列表（`orderTasks` 顺序：open 保持创建序、completed 沉底），每行 = 状态图标（`✓`/`✳`/`○`，与 TUI `formatTaskLine` 同款）+ `#id subject` + status 文本 + owner 后缀 + `blocked by #n` chip + 可选截断 description 二级行；超出 `tasks` 上限时尾行 `… +N more`（`omitted`）。
  - **空态**：`status.todo` 字段缺失（无任务或 todo/webHub 关闭）⇒ 整个区块不渲染——与 TUI widget「empty ⇒ unmount」行为对称。
- **可选补充（T5）**：`AgentCard.vue` 徽标 `3/8`（`todo.counts` 驱动，`agentCardModel.ts` 派生字段），一眼看穿各会话进度。独立成包，价值独立验收。

**理由**：todo 是**会话级**属性，放详情页（会话上下文内）语义正确；header 区常驻满足「瞄一眼进度」，展开满足「看细节」。`DetailHeaderProps` 已传整个 `AgentState`，挂载点零冻结面改动。

**备选与否决**：

- 挂 `AgentDetail.vue` 模板（transcript 与 dock 之间）：位置语义更好，但该文件是 **F6 在途热点**（模板重构），v1 规避；若 F6 先合入，T4 可改挂此处（一行）。
- Dashboard/侧栏全局面板：todo 非全局属性，否决。
- 仅卡片徽标不做区块：信息密度不足（看不到 subject），否决为唯一形态，保留为 T5 增强包。
- transcript 内嵌任务卡（像 ToolCard）：把「当前计划」埋进历史流，滚动即失焦，否决。

### 2.5 D5 拆包与在途冲突（详见 §6/§8）

T1–T6 线性依赖；T1/T2 与 UI 线完全并行安全；唯一在途线 F6 与 T4 的交集仅 `styles/detail.css` 的追加（规避方案：TodoPanel 样式放组件 scoped style 或独立 `styles/todo.css`，则零交集）。

### 2.6 D6 零新增设置

**结论**：不新增任何 settings 键。

**理由**：`todo.enabled`（默认 true）关闭 ⇒ `wireTodo` 不运行 ⇒ getter 缺失 ⇒ 字段恒缺；`webHub.enabled` 关闭 ⇒ 无 hub。两层既有门控已完备。信息暴露等级不变（§1 末条），无理由新增开关负担。TUI 设置编辑器（`tui-settings`）与 settings 文档均零改动。

## 3. 数据通道实施细节

### 3.1 wire 形状（`protocol/messages.ts`）

```ts
export interface TodoTaskWire {
  id: number;
  subject: string; // ≤200 字符（todo 自身校验封顶，原样透传）
  status: "pending" | "in_progress" | "completed";
  owner?: string; // 原样透传（≤200 字符）
  activeForm?: string;
  blockedBy: number[]; // 仅保留仍处 open 状态的 blocker id（activeBlockers）
  description?: string; // 截 240 字节（UTF-8 码点安全），空串省略
  descTruncated?: true; // 发生截断时
}
export interface TodoWire {
  tasks: TodoTaskWire[]; // orderTasks 顺序，≤ TODO_WIRE_MAX_TASKS (32)
  total: number; // 全量任务数（含被 cap 裁掉的），恒 = counts 三者之和
  counts: { open: number; inProgress: number; completed: number; blocked: number }; // 全量口径
  omitted?: number; // total - tasks.length > 0 时存在
  updatedAt: number; // 所含任务 max(updatedAt)，展示“最近更新”用
}
// StatusInfo 增加可选字段：
export interface StatusInfo {
  /* …现有字段… */ todo?: TodoWire;
}
// StatusInfoSchema 增加：todo: Type.Optional(TodoWireSchema)（两处 schema 表同步）
```

- `metadata`、`blocks`、`createdAt` **不进 wire**（展示用不上；metadata 是任意 agent 数据，不透传减小注入面）。
- `blockedBy` 用 `activeBlockers`（open blocker）而非原始数组——与 TUI `formatTaskLine` 的 `[blocked by #n]` 同口径。

### 3.2 投影（新文件 `src/web-hub/agent/todo.ts`）

```
projectTodo(state: TodoState): TodoWire | undefined   // tasks 为空 ⇒ undefined（字段省略）
todoLightFingerprint(state: TodoState): string        // JSON.stringify([{id,status,updatedAt}, …]) + total
```

- 依赖 `orderTasks`/`activeBlockers`（`../../todo/state.js`，纯函数、无 pi import，合法跨目录依赖）与 `truncateText`（`../protocol/keys.js` 已导出，UTF-8 码点安全截断）。
- **字节预算**：32 KiB 总预算。超预算时先逐条削 description（保 subject），再削任务条数（`omitted` 计数兜底）。常观数据（≤32 任务）不会触底。
- **轻量指纹的安全性**：todo 的每次持久化变更必伴随某个任务 `updatedAt` 前进或 `total` 变化（`createTask`/`updateTask`/`deleteTask` 都如此；`updateTask` unchanged 不 persist）。指纹只看 `{id,status,updatedAt}` + `total`，subject/description 变更不可能不带动 updatedAt ⇒ 无漏报；误报（updatedAt 变而内容等价）只多推一帧，无害。

### 3.3 agent 侧接线

- `src/todo/index.ts`：`TodoWireResult` 无条件新增 `getTodoSnapshot: () => TodoState`（返回闭包态引用；投影同步读取所需字段并新建对象，与 `TodoWidget` 的 `() => state.tasks` 同一模式）。**不再像 `getTrackerSnapshot` 那样只在 nudge 分支返回**——todo 关闭时 `wireTodo` 根本不被调用，天然缺席。
- `src/index.ts`：`wireWebHub(pi, { …, todo: todoWiring ? () => todoWiring.getTodoSnapshot() : undefined })`。
- `agent/status.ts`：`readStatus(ctx, tap, fleet, queueMirror?, todo?)`——第 5 个可选参数；`const t = todo?.(); const w = t && projectTodo(t); if (w) status.todo = w;`（undefined ⇒ 字段缺失，todo.enabled=false 时字节级等价于现状）。现有 2 个调用点（`agent/index.ts` 的 `publishStatus` 与 `onSnapshotReq`；`connectWith` 经 `publishStatus`）不传即维持旧行为。
- `agent/index.ts`：
  - `deps.todo` 存入闭包，`readStatus` 两个直接调用点（`publishStatus`、`onSnapshotReq`）统一透传（`connectWith`/STATUS_EVENTS 均经 `publishStatus`）；
  - `onTick` 增加轻量指纹比对：`lastTodoFp` 变化 ⇒ `publishStatus()`（与 `lastFleetFp` 相邻、同构）；`session_start` 时 `lastTodoFp = undefined`（与 `lastFleetFp` 同步重置，首个 tick 自然对齐）。
- 时延：todo 变更（模型工具调用）→ 下一秒 tick → status slot → SSE。最坏 ~1s + 传输，与 fleet 行同级，满足「瞄进度」场景。

### 3.4 生命周期矩阵

| 场景                    | 行为                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 首任务创建              | tick 指纹变 ⇒ status 帧带 `todo` ⇒ 区块从无到有                                                                     |
| 任务更新/删除           | 同上，覆盖式替换                                                                                                    |
| 清空（/tasklist clear） | 投影 undefined ⇒ 字段缺失 ⇒ 区块卸载                                                                                |
| /new · /resume · /fork  | todo restore（session_start，先于 web-hub 采样）⇒ session_start 的 publishStatus 已带新会话 todo；`lastTodoFp` 重置 |
| 断线重连（agent→hub）   | slot 重放 ⇒ hub `r.status` 更新 ⇒ SSE `status`                                                                      |
| 浏览器新开/重连         | `agents` 帧 / `agent_up` 的 `card.status.todo`                                                                      |
| 订阅时刻                | `snapshot_reply.status.todo`（history 快照同帧）                                                                    |
| todo.enabled=false      | getter 缺失 ⇒ 字段恒缺 ⇒ UI 区块永不出现                                                                            |
| 旧 hub / 旧 agent 混布  | 多余字段被旧 hub 放行（schema 无 additionalProperties:false）；旧 agent 无字段，新 UI 不渲染                        |

## 4. UI 实施细节（T4）

- `components/detail/TodoPanel.vue`（新）：
  - props：`{ todo: TodoWire }`（TodoWire 类型从 `@protocol/messages.ts` import——`contracts.ts` 不动）；组件内部用 `record()` 风格窄化 `agent.status["todo"]`（`agentCardModel.ts` 同款）。
  - 结构：`<section class="todo-panel">` > 摘要 `<button aria-expanded>` + `<ul v-if=open>` 任务行。样式用 scoped style（规避 F6 的 `styles/detail.css`；若评审倾向集中样式则新建 `styles/todo.css` 并在 §8 记录冲突预案）。
  - 无交互写路径：整块 `aria-readonly` 语义，不渲染任何 checkbox/button 型任务行。
- `components/detail/DetailHeader.vue`：import TodoPanel + 模板底部一行 `<TodoPanel v-if="todoOf(agent)" :todo="todoOf(agent)" />`（`todoOf` 为本地窄化 helper）。**不动 `contracts.ts`、不动 `AgentDetail.vue`**。
- i18n：`i18n/{en,zh}/detail.ts` 新增 `todo.title` / `todo.more` / `todo.blockedBy` / `todo.a11y` 键（i18n-parity 测试强制两侧同步）。
- `types.ts`：`AgentState.status` 已是 `Record<string, unknown>`，**零改动**。

## 5. 安全与权限

- **信息等级不变**：`TaskList` 工具结果全文（所有 subject/description/status）已进 transcript 并在 web 可见；`status.todo` 是其子集（description 还截断了）。无新增资产。
- **LAN（password 明文）**：与 transcript、`status.queue` 文本同等级暴露，落在 fleet-drawer §7.0 / lan-plan 已接受的边界内；只读，无新写能力。
- **注入面**：subject/owner/description 均为模型产出的文本，TodoPanel 一律文本插值（Vue 默认转义），不进 `markdown.js`、不用 `v-html`（source-scan 白名单纪律）。
- **metadata 不透传**：任意 agent 数据结构不出 agent 进程。
- **无新端点/帧/cap**：鉴权矩阵、conn-guard、ratelimit 全部零变化。

## 6. 拆包

| 包                      | 文件域                                                                                                                                                                                                                                | 热点                                         | 依赖                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| **T1 源出口**           | `src/todo/index.ts`（TodoWireResult + getTodoSnapshot）；测试 `tests/todo/tools.test.ts`（或新 `tests/todo/web-export.test.ts`）                                                                                                      | 否                                           | 无                                                          |
| **T2 协议+投影**        | `src/web-hub/protocol/messages.ts`（TodoWire/TodoTaskWire 类型 + StatusInfo.todo + schema 两处）；新 `src/web-hub/agent/todo.ts`；测试 `tests/web-hub/protocol/messages.test.ts`、新 `tests/web-hub/agent/todo-projection.test.ts`    | 是（messages.ts，但 F0 已合、无在途 owner）  | T1（仅类型依赖，可并行）                                    |
| **T3 agent 接线**       | `src/web-hub/agent/status.ts`、`src/web-hub/agent/index.ts`、`src/index.ts`（穿线一处）；测试 `tests/web-hub/agent/snapshot.test.ts`（readStatus）、`tests/web-hub/agent/wiring.test.ts`（todo getter → status slot + tick 指纹）     | 是                                           | T1、T2                                                      |
| **T4 UI 区块**          | 新 `src/web-hub/ui/src/components/detail/TodoPanel.vue`；`src/web-hub/ui/src/components/detail/DetailHeader.vue`（一行挂载）；`i18n/{en,zh}/detail.ts`；测试 新 `tests/web-hub/ui/todo-panel.test.ts`、`i18n-parity` 现有测试自动覆盖 | 是（DetailHeader.vue，不在任何在途线文件域） | T2（TodoWire 类型）；与 T3 可并行（UI 可用假 fixture 先行） |
| **T5 卡片徽标（可选）** | `src/web-hub/ui/src/components/agents/agentCardModel.ts`、`AgentCard.vue`、`ui/src/types.ts`（AgentCardView 追加 `todoLabel`）、`i18n/{en,zh}/agents.ts`；测试 `tests/web-hub/ui/agent-list.test.ts`                                  | 是                                           | T4 或仅 T2                                                  |
| **T6 文档收尾**         | `AGENTS.md`（`src/todo/` 条目追加一句：todo 摘要经 `StatusInfo.todo` 上 web）、本 plan 状态行                                                                                                                                         | 否                                           | 全部                                                        |

顺序：T1 → T2 → T3 → T4 →（T5）→ T6。T1/T2 无 UI 依赖可立即开工；每个包验收即 commit（精确路径）。

## 7. 验收点

**T1**

- [ ] `wireTodo` 无 nudge 配置时也返回 `getTodoSnapshot`；返回值与 Task* 工具变更同步（create 后立即可见新任务）。

**T2**

- [ ] `projectTodo`：空态 ⇒ undefined；orderTasks 顺序（completed 沉底）；blockedBy 仅含 open blocker；description 截 240B 且不切 UTF-8 码点（CJK 用例）+ `descTruncated`；>32 任务 ⇒ `omitted` 正确、`total`/`counts` 为全量口径；32 KiB 预算触发时先削 description 再削条数。
- [ ] `decodeAgentFrame`：status 帧带 `todo` 通过；不带 `todo` 通过（存量用例天然覆盖）；`todo` 非对象 ⇒ 整帧拒绝（schema `Type.Optional(Type.Object(...))` 行为）。

**T3**

- [ ] `readStatus`：带 todo getter ⇒ `status.todo` 存在；无 getter ⇒ 字段缺失（`toMatchObject` 断言无 `todo` 键）。
- [ ] wiring：TaskCreate 变更后 ≤2 个 tick 内发出带新 `todo` 的 status slot；无变更的 tick 不发（指纹门）；`session_start` 重置指纹。
- [ ] `snapshot_reply.status.todo` 与 status slot 一致（snapshot 测试补一例）。

**T4**

- [ ] TodoPanel：无 `status.todo` ⇒ 不渲染；摘要行 counts 正确；展开/折叠 + localStorage 持久化；`omitted` 尾行；键盘可达（button + aria-expanded）。
- [ ] i18n parity（en/zh 键集相等，现有测试自动盯住）。
- [ ] `logic-state.test.ts` 全绿零改动（status case 未动的主会话回归）。

**T5（若做）**

- [ ] 卡片徽标 `3/8` 只在有 todo 时出现；todo 关闭的 agent 无徽标。

**真机（手动，参照 live-acceptance-tmux 惯例）**

- [ ] TUI 建 3 个任务 → web 详情页 ≤2s 出现区块与摘要；TaskUpdate 完成 1 个 → 徽标/列表刷新；`/tasklist clear` → 区块消失。
- [ ] /new 新会话 → 区块随新会话状态变化；浏览器刷新 → 经 agents 帧恢复同一 todo。
- [ ] settings 关 `todo.enabled` 重启 → 全链路无 `todo` 字段、UI 无区块。

## 8. 风险与在途冲突

| 风险                                                          | 缓解                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status 帧膨胀（最坏 ~32 KiB，随每次 STATUS_EVENT 重发）       | 预算封顶 + description 截断 + 空态省略；与 `status.queue` 文本同级；浏览器整体替换 `a.status` 无累积。若现场仍嫌大 → 启用备选 B（独立帧）的平移路径已预留在 §2.1                                                                                                                                               |
| **F6（fleet-drawer UI 抽屉，未开工）**                        | T4 文件域（TodoPanel.vue 新文件 + DetailHeader.vue 一行 + i18n/detail.ts）与 F6 域（AgentDetail.vue 模板、contracts.ts、transcript/_、drawer/_、styles/detail.css、i18n/drawer.ts）零交集；TodoPanel 用 scoped style 连 styles/detail.css 也不碰。若 F6 先合入且重构波及 DetailHeader，T4 只需 rebase 一行挂载 |
| F6 若要求任务面板进抽屉/新布局                                | TodoPanel 是自包含展示组件（props 只有 TodoWire），任意重挂载一行完成；数据层（T1–T3）与布局无关                                                                                                                                                                                                               |
| **@文件包在途**（hub/http.ts、hub/ports.ts、file-mention 等） | 本方案零 hub 文件改动、零 Composer/mention 接触，文件域无交集；`protocol/messages.ts`（T2）为双向热点，append-only 冲突易解                                                                                                                                                                                    |
| 闭包态与 getter 并发读                                        | JS 单线程 + 投影同步新建对象；与 `TodoWidget` 的 `() => state.tasks` 同模式，无新竞态类别                                                                                                                                                                                                                      |
| 旧 hub 拒帧（假想）                                           | 已核对 `StatusFrameSchema` 无 `additionalProperties:false`；messages.test.ts 补一例钉住带 todo 帧可解码                                                                                                                                                                                                        |
| 轻量指纹漏报（内容变而 updatedAt 不变）                       | 不存在该路径：todo 全部变更 API 都推进 updatedAt 或 total（§3.2 论证 + T2 用例钉住）                                                                                                                                                                                                                           |
| todo 被恶意/意外塞大（metadata 巨对象等）                     | metadata 不透传；subject/description 有 todo 自身边界；投影另有 32 KiB 硬预算三段削                                                                                                                                                                                                                            |

## 9. v2 展望（不承诺）

- **子 agent todo 聚合**：fleet-drawer 的终态 run 读盘链路 + 仅针对 `claude-code-todo-state` 的受限 data 透传投影；卡片/详情按 run 维度分组展示。
- **写路径**：§2.3 的 `todo_update` cmd op 草案（enqueue 串行化 + caps 门控 + 冲突策略评审）。
- **description 全文/分页**：载荷超预算时切换备选 B（独立 todo 帧 + 按需拉取）。
