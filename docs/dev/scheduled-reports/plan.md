# 定时任务（会话可感知）— 架构方案 · r3

> **状态**：r3（2026-10-24），方案定稿候选。
>
> - r1 评审打回（4 Blocker / 16 Major / 2 Minor），r2 处置见文末 §R1。
> - r2 复审打回（1 Blocker + 6 Major + 1 Minor + 1 Nit 未闭合），按 dev-flow 第三轮由主会话裁定，r3 处置见文末 §R2。
> - 用户在 r0–r2 各轮的拍板全部是定案（§0），本版不新增离线执行、hub 写代理或开机自启。
>
> **主轴**：会话可感知——AI 工具 + 上下文尾部提示 + TUI/web 面板 + 结果回流。
>
> **执行模型**：执行只发生在归属会话内，而且只在交互式主会话里。到点时归属会话没开着，就跳过这一次。
>
> **总体思路**：能整类消除的问题优先靠简化消除（§3.2）：
>
> - **S1 单文件事务**：每会话一个 `state.json`，原子替换写入，消除多文件提交窗口。
> - **S2 批准 = 定义哈希**：消除各种绕过批准的路径。
> - **S3 报告只由 hub 投递，自有回执台账；agent 侧维护独立的「待投递报告索引」**：消除 agent 报告 outbox、协调者切换状态、历史轮转丢索引三类问题。
> - **S4 复用 `suppressDelivery` + `callerOwned`**：消除对 SpawnRequest / reducer / journal 的改动，以及 notifier「已投递」的歧义。
>
> r3 新增一条贯穿规则：**写入证明只认会话文件里的条目**。内存状态和 `message_start` 都不算证明（§6.3）。

---

## 0. 已拍板（定案）

### r1 轮

| #        | 拍板                                                                                                        | r2 落点          |
| -------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| D1/D2/D5 | 到点时归属会话没开着 ⇒ 跳过，不补跑、不拉临时会话；hub 开着时推飞书「已错过」；下次打开会话时提示错过了哪些 | §4.4、§5.5、§7.2 |
| D3       | 后台结果默认**不叫醒**主会话（只写入）；任务可设「完成后让主会话接手」（`handoff`）                         | §6.1、§6.3       |
| D4       | AI 创建的任务先「待确认」，用户在终端或网页批准后生效；用户自己用 `/schedule` 创建的直接生效                | §4.3、§5.1、§5.2 |
| D6       | 飞书 `/schedule` 只读列表 + 立即运行（要求归属会话在线，否则回复不在线）                                    | §7.4             |
| D7       | 定时消息的结果默认不推飞书；后台任务默认推                                                                  | §4.1             |
| D9       | 首期不提供开机自启 hub，文档写明                                                                            | §8.4             |
| D10      | 未启用 web-hub ⇒ 本地运行：会话自己计时、文件锁跨进程去重、结果回会话；无面板、无飞书                       | §3               |
| D11      | 默认不 consult 归属会话，任务可开                                                                           | §6.1             |
| D12      | 运行中归属会话被关 ⇒ 记「结果未知」并通知，不重跑                                                           | §4.5、§6.4       |
| D13      | 会话忙时同一任务只留最新一条，计错过次数                                                                    | §6.2             |

### r1 §13 三项（用户确认）

| #   | 拍板                                                                                                            | r2 落点    |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| E1  | 「已错过」**所有任务都推**，每个任务每小时合并；**固定行为，不设设置项**                                        | §7.2       |
| E2  | AI 修改关键字段 ⇒ 退回待确认（r2 用定义哈希实现：任何来源修改执行定义，都会使批准失效，见 §4.3）                | §4.3       |
| E3  | 离线会话的任务在网页上**首期只读**；需要管理时，到任意本地终端执行 `/schedule … --all`（只读之外的范围见 §5.2） | §5.2、§5.6 |

### 其他（含 r2 新增两项的拍板）

| #   | 拍板                                                                                                              | 落点                |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| N1  | hub 停机或本地模式期间完成的后台报告：**hub 恢复后补推 24h 内的报告**（归属会话关闭也补推；每份报告至多入队一次） | §4.2、§7.1、§14/SC7 |
| N2  | 定时消息和「接手」触发的主会话运行**最长 3600 秒**，到时自动中止；期间有人工插话即解除上限。固定值，不提供设置项  | §6.2、§10.3         |

- 范围：一次做全，hub、飞书、网页面板和本地模式同期交付。
- 待用户拍板的事项：**无**（§13）。

## 1. 背景与目标

用户场景：「每天早上几点跑一个任务，跑完把报告主动发到我的飞书。」核心诉求：

1. **归属**：任务属于创建它的那个 pi 会话（sessionId）。
2. **AI 可感知**：AI 能感知任务，工具可以增删改查；上下文里有稳定提示，但**不能破坏 system prompt 缓存**。
3. **用户可见**：TUI 状态栏与 web-hub 详情页面板。
4. **结果回流**：每次运行的结果写回归属会话（AI 之后能引用），并按任务设置推送飞书。

两种到点动作，共用同一个定时核心：

- **background**：派一个子 agent 在干净的上下文里执行。可选 consult 归属会话（`consult-main`）。结果写回会话；可选「接手」，即让主会话接着处理结果。默认推飞书。
- **message**（定时消息）：给归属会话发一条消息。会话空闲时执行，忙时排队；同一任务只保留最新一条。

约束：

- 零挂起不变量：所有定时器都 unref，所有等待都有界，投递可确认。
- 默认关闭；关闭时以下各项字节不变：工具表、命令表、system prompt、HubConfig、旧文件写入行为（旧引擎退役是唯一预期的差异，见 I1 golden）。
- 加密域禁用（D8）。
- 不新增运行时依赖。

## 2. 现状摘要（已复核，含评审补充的坐标）

### 2.1 旧 `src/schedule/`

- `scheduler.ts:37-146`：cron / interval / once 三种触发，到点执行 `spawn`（`:83`）。
  - 时序是**先 save 后 spawn**（`:73-87`），存在崩溃窗口——**不能当作正确性先例**。
  - 错过的触发直接跳过（`:91-98`）。
- **没有生产代码调用 `register()`**。装配点：
  - `src/stack.ts:176`、`:3319`、`:3576`
  - `src/index.ts:1360`、`:1492`（stop）
  - `src/index.ts:1464`（仅 plain 域才 `start()`）
- 写盘行为：每次 `start()` 都会 `save()`（`:114`），把加载到的任务写回全局文件 `~/.pi/agent/pi-subagent-schedules.json`（`store.ts:22-24`）。文件不存在时写入 `[]`。
- 全局 store 一旦接上入口，开着几个进程就会触发几次。
- `cron.ts:78-90`：用本地 `Date` 逐分钟同步扫描，最多 366 天，没有时区参数。

### 2.2 可复用的部分与真实契约

| 能力                         | 真实位置与契约                                                                                                                                                                                                                                                                                                                                                                                                                          | r2 用法                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 程序派发、调用方自行汇报完成 | `SpawnRequest`（`core/types.ts:426-582`）真实字段：`type`、`modelOverride`、`thinkingOverride`、`consultExperts`、`label`、`title`、`budgetOverride`、`timeoutPolicy`、`suppressDelivery`、`callerOwned` 等；`service/request-threading.ts:52-95` 是穷尽分类；`suppressDelivery` 的含义是「caller owns completion reporting」（`:63`），`spawn-service.ts:608` 的失败兜底也会遵守它；`callerOwned` = 结果归程序所有（wake 排除，`:95`） | background 设置 `suppressDelivery:true` 和 `callerOwned:true`，由执行器自己负责结果（§6.1）。**不新增 SpawnRequest 字段，不改 reducer / journal / threading** |
| 运行与等待                   | `spawn-service.ts:93` `spawnAndWait`、`:107/:1301` `waitOutcome(runId, waitMs)`（有界，返回 `BoundedWaitResult`）                                                                                                                                                                                                                                                                                                                       | 用 `spawn()` 拿到 runId，再循环有界调用 `waitOutcome`                                                                                                         |
| consult 归属会话             | `consult/index.ts:57/379` `resolveExperts(["main"])`；`:154-168`：没有持久化 session 文件时失败                                                                                                                                                                                                                                                                                                                                         | 派发前显式解析，解析结果填入 `consultExperts`                                                                                                                 |
| 跨进程锁                     | `memory/lock.ts:58-132`：同步锁体、默认等待 2s、同机进程身份判死、M-T4 不按年龄拆锁；**不提供多文件原子性，也不中断慢锁体**；原语见 `memory/safe-fs.ts:1296/1473/1551/1616`                                                                                                                                                                                                                                                             | 单文件事务（S1），锁体内只做 O(小) 的工作                                                                                                                     |
| 会话变更 fence               | `fabric/xs/fence.ts:140` `createSessionFence`（pi-free；覆盖 compaction / tree / switch / web_exec / topic_switch / goal 窗口；`beginDispatch` / `verifyDispatch` 同步块协议）                                                                                                                                                                                                                                                          | 定时消息调度器各自创建实例（§6.2）                                                                                                                            |
| 触发归属                     | `adapters/pi-compat.ts:275` `readBeforeAgentStartTrigger`；`fabric/root-wake.ts:84-113` 的孤儿 abort 模式                                                                                                                                                                                                                                                                                                                               | 绑定 token，迟到触发直接 abort（§6.2）                                                                                                                        |
| custom message 写入证据      | `service/background-completions.ts:18-24`：custom message 进入会话时发 `message_start`；pi 在 streaming 期间把 quiet custom message 暂存在内存的 pending 队列（`agent-session.js:1843-1856`）                                                                                                                                                                                                                                           | 以 `message_start` 作为「已写入」的证明（§6.3）                                                                                                               |
| 稳定段                       | `sysprompt/hub.ts:46-73/182-213`；`prompt-sections/stable-section.ts:5/7`；`store.ts:90-109`（read-back 在 fork 时会恢复快照）；`fold.ts` 跳过空段                                                                                                                                                                                                                                                                                      | 新段 `pi_schedules`，作用域按会话（§5.3）                                                                                                                     |
| hub 帧                       | `protocol/messages.ts:1017-1121`（帧联合类型）、`:2246-2252`（解码表）；`hub/agent-server.ts:228`（`fsb_req` 拦截先例）；`hub/ports.ts:432` `HubConfig`                                                                                                                                                                                                                                                                                 | §10.1                                                                                                                                                         |
| 飞书 outbox                  | `hub/feishu/outbox.ts:742-852`：组结算后**删除**记录；final 最长保留 24h，notice 10min；不确定重试的安全窗口 50min；`enqueueFinal` 可能返回 `ok:true, durable:false`                                                                                                                                                                                                                                                                    | **不依赖** outbox 长期去重；在飞书 `state.json` 里另设 schedule 回执（§7.1）                                                                                  |
| 飞书预算与预留               | `feishu/security.ts`（notify 与安全告警共享预算）；`feishu/xs-mirror.ts:24-40,258-265`（outbox / state 余量预留）；`feishu/runtime.ts:33-63`                                                                                                                                                                                                                                                                                            | §7.3                                                                                                                                                          |
| 飞书 done 通知               | `feishu/service.ts:1547-1575`；`:1550` `p.owned                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                               | = …` | 按运行绑定，精确抑制（§7.5） |
| web 确认                     | `web-hub/agent/builtin-bridge.ts:411-413`、`ui/.../CommandConfirm.vue:1-63`：**不渲染服务端正文**；`command-capture.ts:383-435`：在 web capture 下 `ctx.ui.confirm` 合成取消                                                                                                                                                                                                                                                            | 网页上的批准只走专用审阅对话框（§5.6）                                                                                                                        |
| 加密域                       | `secure/domain.ts:136` `canonicalPath`、`:190` `inVaultDir`（入参必须是 canonical 路径）；`secure/guards.ts:54-64`（字面路径 + canonical 双检）                                                                                                                                                                                                                                                                                         | §11                                                                                                                                                           |
| 导入边界                     | `tests/web-hub/boundary.test.ts:26-29`（按文件列白名单）                                                                                                                                                                                                                                                                                                                                                                                | 只读 reader 和 cron 核心加入白名单                                                                                                                            |

## 3. 架构：会话侧计时 + 单文件账本 + hub 只读协调

### 3.1 结论（维持 r1 方向，补齐一致性协议）

时钟放在哪里，有三种方案：

| 方案                                    | 评价                                           |
| --------------------------------------- | ---------------------------------------------- |
| A：hub 计时 + 本地兜底                  | 需要计时权交接协议，窗口内可能双发或漏发。否决 |
| C：只有 hub 计时                        | 与 D10（本地模式）冲突。否决                   |
| **B：会话侧计时（推荐，评审同意保留）** | 见下                                           |

方案 B 的分工：

- **执行**：只有归属会话所在的进程（交互模式，见 §3.3）计时并执行。
- **裁决**：本地 `state.json` 的**单文件事务**是唯一裁决点。它同时决定「这个时间点是否已裁决」，并建立「运行占位 + 执行意图」。
- **hub 的角色**：只读协调者，负责：
  - 面板投影；
  - 「已错过」与「结果未知」的观察与推送；
  - 报告投递（自有回执台账）；
  - 飞书 `/schedule`。
- **hub 绝不触发执行，也绝不写 agent 存储。**

由此得到三个性质：

- hub 起停只影响旁观功能，不影响执行。
- 本地模式 = 没有 hub 的方案 B，没有第二条代码路径。
- 本地模式下完成的报告不会立刻推送；hub 在 24h 内恢复后会补推（N1 定案，§7.1）。

### 3.2 四项简化，以及它们消除的问题类

| 简化                                      | 做法                                                                                                                                                                                                                                                                                  | 整类消除                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 单文件事务**                         | 每个会话一个 `state.json`，内容包括任务、批准、occurrence 水位、运行记录、手动请求台账、digest 水位。所有变更都是「持锁 → 读 → 校验 → 一次原子替换写」                                                                                                                                | 多文件提交顺序与恢复窗口（Blocker 3）、claim 与占位分离的问题（Blocker 2）                                                                    |
| **S2 批准 = 定义哈希**                    | `defHash = sha256(规范化(执行定义字段))`；任务可执行 ⇔ `approval.hash === defHash`                                                                                                                                                                                                    | `create → resume / run_now` 绕过、暂停后修改再恢复、确认期间被并发改版（Blocker 1、Major 5）                                                  |
| **S3 报告只由 hub 投递**                  | agent 把「运行终态 + 报告文件」写进 `state.json`，需要推送时在同一次原子写里加入独立的 `pendingReports` 索引（§4.2.1，不受 runs 轮转影响，回执回传或 24h 后移除）；hub 只读该索引后投递，以飞书 `state.json` 里的 `scheduleReceipts` 做幂等，回执与 outbox 组在**同一次 commit** 落盘 | agent 侧报告 outbox、Null / Hub 协调者切换的状态问题、fork 复制 outbox 的问题、ack 语义问题（Blocker 4、Major 13/14，以及 Major 11 的一部分） |
| **S4 `suppressDelivery` + `callerOwned`** | 定时运行不进通用 notifier；执行器拿到终态后自己写结果消息（附写入证明）                                                                                                                                                                                                               | SpawnRequest / reducer / journal / threading 改动（Major 10）、notifier 提前标记 delivered（Major 9）                                         |

### 3.3 运行模式矩阵（Major 12/13）

| 会话类型                                                                      | 计时 / 执行 | 工具 `schedule`                                          | `/schedule`             | 段 / 状态栏         | 说明                                                                                |
| ----------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- | ----------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| TUI 主会话（有持久化文件）                                                    | ✅          | 全部动作                                                 | 全部                    | ✅                  |                                                                                     |
| RPC 主会话（web 托管，有持久化文件）                                          | ✅          | 全部动作                                                 | 全部（受 web 策略约束） | ✅                  |                                                                                     |
| print / json 主会话                                                           | ❌ 不 arm   | 只允许 `list` / `get` / `history`，其他动作返回 `E_MODE` | `list` / `show` / `log` | 段 ✅、状态栏不适用 | print 模式不 arm 定时器，不会因定时任务产生新的主轮；退出不受影响（ref 定时器为零） |
| `--no-session`                                                                | ❌          | `create` 返回 `E_EPHEMERAL`，其余视为空                  | 同左                    | 空段                | 没有可恢复的会话，不允许产生永久归属                                                |
| 子会话 / consult fork（宿主内，`HOST_KEY` 已占用）                            | —           | 不注册                                                   | —                       | —                   | 沿用 post-guard 惰性                                                                |
| **独立打开的子会话文件**（line-2 `subagent:child` 标记、consult fork 目录内） | ❌          | 注册（schema 每次 activate 冻结），调用时返回 `E_CHILD`  | 只读                    | 空段                | 归属校验不只依赖 `HOST_KEY`：stack 构建时读取会话头标记（session-nav 同款判定）     |
| 加密域（secure / locked）                                                     | ❌          | 返回 `E_SECURE`                                          | 同左                    | 空段                | 沿用 `cronRefusal`                                                                  |

## 4. 数据模型与单文件账本（`src/schedule/core/`）

### 4.1 任务定义

```ts
export type ScheduleForm = "background" | "message";
export type ScheduleWhen =
  | { kind: "cron"; expr: string; tz: string } // tz 是任务定义的一部分（IANA），所有进程和 hub 都用它计算
  | { kind: "once"; at: string; tz: string }; // at 为本地墙钟时间 "YYYY-MM-DDTHH:mm"，按 tz 解释

export interface ScheduleTask {
  id: string; // "s_" + base32(8)
  name: string; // ≤40
  form: ScheduleForm;
  when: ScheduleWhen;
  prompt: string; // ≤8 KiB
  feishu: boolean; // 默认 background=true / message=false（D7）
  bg?: {
    type: string; // AgentTypeName，默认 "general-purpose"（以 agent 注册表为准）
    model?: { provider: string; id: string }; // → modelOverride（严格 provider/id，创建时按 spawn 准入校验）
    thinking?: ThinkingLevel; // → thinkingOverride
    timeoutS: number; // 默认 1800，上限 14400 → budgetOverride.totalMs，timeoutPolicy:"fixed"
    consultMain: boolean; // 默认 false（D11）
    handoff: boolean; // 默认 false（D3）
    isolation?: "worktree";
  };
  enabled: boolean; // true=启用 / false=暂停。与批准无关（S2）
  approval?: { hash: string; by: "user"; via: "tui" | "web"; at: number };
  createdBy: "user" | "agent";
  createdVia: "tui" | "web" | "tool";
  createdAt: number;
  ownerCwd: string; // 创建时的 canonical cwd（§11 校验）
}
```

**执行定义字段**是参与 `defHash` 的字段，包括：

- `form`、`when`、`prompt`、`feishu`；
- `bg` 的全部字段；
- `ownerCwd`。

`name` 和 `enabled` 不参与。规范化规则：键排序，去掉 undefined，然后 JSON 序列化，再取 sha256，全长 64 位 hex。

### 4.2 `state.json` 结构（每会话一个文件，原子替换写入，0600，≤256 KiB）

```ts
interface ScheduleStateFile {
  v: 1;
  sessionId: string; // 必须等于目录所属的 sid，否则按 degraded 处理
  rev: number; // 每次写入 +1
  tasks: ScheduleTask[]; // ≤8
  occ: Record<
    TaskId,
    {
      defHash: string; // 当前水位所依据的定义版本（when 变更时先结算旧定义，见 §4.4）
      decidedThrough: number; // 自动 occurrence 的已裁决水位（UTC epoch ms），只增不减
      firedTotal: number; // 自动触发次数（manual 不计入，§4.5b）
      missedTotal: number; // = missedLog 各条 count 之和（含已截断部分），永不清零
      skippedTotal: number; // 重叠跳过、D13 合并
      missedLog: MissedEntry[]; // 错过的唯一事实源（§4.4），保留最近 64 条
    }
  >;
  manualTotal: Record<TaskId, number>; // 立即运行次数，单独计数（§4.5b）
  runs: RunRecord[]; // 只是 UI 历史：每任务保留 ≤20 条终态，非终态永不淘汰
  pendingReports: PendingReport[]; // 待投递报告索引，独立于 runs（§4.2.1），≤64 条
  reportStats: { droppedIndexCap: number; lastDroppedAt?: number }; // 索引溢出计数（进 digest 与飞书通知）
  manualReqs: Record<ReqId, { runKey?: string; refused?: string; at: number }>; // ≤32 条，TTL 24h
  digest: {
    shownMissedTotal: Record<TaskId, number>;
    shownRunsThrough: number;
    inflight?: Holder & { id: string; at: number };
  };
}
interface MissedEntry {
  seq: number; // 每任务单调递增
  defHash: string; // 裁决时使用的定义版本
  from: number; // 区间左端（不含）
  to: number; // 区间右端（含）：(from, to] 内当前定义的全部 occurrence 都已被判为错过
  count: number; // = countOccurrences(def, from, to)，与 hub 使用同一函数（§4.4）
  totalAfter: number; // 写入本条后的 missedTotal
  at: number;
  cause: "offline" | "late" | "once-past";
}
interface PendingReport {
  reportId: string; // sha256(sid + "\0" + runKey)
  runKey: string;
  taskId: string;
  form: ScheduleForm;
  endedAt: number;
  expiresAt: number; // endedAt + 24h（N1）
  reportFile: string; // reports/<h>.md
  status: string; // 终态摘要，用于卡片标题
}
interface Holder {
  pid: number;
  start: number;
  host: string;
  boot: string;
  epoch: string;
} // epoch 在每次 stack 构建时随机生成
interface RunRecord {
  runKey: string; // auto 形如 `${taskId}@${T}`；manual 形如 `${taskId}@m-${hash8(reqId)}`
  taskId: string;
  kind: "auto" | "manual";
  form: ScheduleForm;
  scheduledAt: number; // auto 为 T；manual 为请求时刻（只作展示，不参与水位）
  defHash: string;
  state:
    | "dispatching"
    | "running" // background 非终态
    | "queued"
    | "dispatched"
    | "bound"
    | "aborting" // message / handoff 非终态（§6.2）
    | "completed"
    | "failed"
    | "timed_out"
    | "aborted" // background 终态，与 RunOutcome.status 一一对应（§6.1）
    | "refused" // 准入失败（spawn 拒绝），终态
    | "settled"
    | "continued" // message / handoff 终态
    | "unknown"
    | "dropped"; // 两种形式共用的终态
  reason?: string; // 静态枚举，例如 aborted 的 stopCause、unknown 的 owner-closed|crash|reload|start-timeout
  holder: Holder;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  reportFile?: string;
  note: "none" | "pending" | "written" | "unverified"; // 结果消息的落盘状态（§6.3）
  noteId?: string; // 结果消息 details.noteId（全局唯一）
  noteHolder?: Holder; // 发送该消息的进程
  noteFileOffset?: number; // 发送前 stat 到的会话文件大小（核验时从这里往后读）
  lateOutcome?: string; // 终态之后才到的结果，只做审计
}
```

#### 4.2.1 待投递报告索引（r3，复审 R2-1）

**写入**

- 运行到终态且需要推送时，按以下顺序处理：
  1. 先写报告文件；
  2. 在同一次锁内原子写里，同时提交 RunRecord 终态和 `pendingReports` 的一条记录。
- 「需要推送」= `task.feishu` 为真，而且（background 进入终态）或（message 进入 `settled`）。
- 这条索引**不受** runs 的「每任务 20 条」淘汰影响：runs 只是 UI 历史，hub 发现待推报告**只看**本索引（§7.1）。

**移除**（满足其一即可）

1. **hub 回执已确认**：hub 向在线的归属会话推送 `sched_receipts{sessionId, reportIds}`，内容是已进入 `accepted / sent / failed / uncertain / refused` 任一回执状态的报告（§7.1）。agent 收到后在锁内移除对应条目。
   - hub 自己的回执表保留 7 天，所以即使 agent 一直没移除，hub 也不会重复投递。
2. **过期**：`now ≥ expiresAt`，即完成后 24h（N1）。agent 在每次写事务中顺手清理过期条目。会话一直不打开时，hub 也会跳过过期条目（只读判断）。

**容量与超限**

- 上限 64 条/会话。粗算：8 个任务，hub 每任务每小时最多推 6 份，hub 正常时每 60s 扫描一次、几分钟内就能确认，所以正常情况下远达不到上限。只有 hub 长时间停机时才可能积压。
- 超限时**不拒绝新运行**（拒绝新运行等于让飞书积压阻断定时任务本身，不可接受），改为丢弃**最旧**的一条：
  - `reportStats.droppedIndexCap++`，记 `lastDroppedAt`；
  - 被丢条目对应的 RunRecord（如果还在）标 `reason: "report-skipped(index-cap)"`。
- 通知：
  - 本地：下次 digest 写明「N 份报告因积压未推送，请在会话或网页查看」；
  - 飞书：hub 读到 `droppedIndexCap` 增长后，把增量并入该会话下一条通知（「另有 N 份报告因积压未推送」）。

**与报告文件 GC 的关系**：被 `pendingReports` 引用的报告文件**不得**被回收（§4.7）。

### 4.3 批准状态机（Blocker 1、Major 5）

- **可执行**的条件：`enabled && approval?.hash === defHash(task)`，三者同时成立。
  - 定时 claim、`run_now`、飞书立即运行、`resume` 之后的每一次触发，都在**锁内**检查这个条件。
- **待确认**（UI 文案）= `approval` 缺失，或 `approval.hash !== defHash`。这是推导出来的状态，不单独存储。

各来源的写入规则：

| 动作                    | 用户（TUI `/schedule`）                                                                           | 用户（web）                                                   | AI 工具                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| create                  | 写入定义，并写 `approval = 新 hash`（用户亲自创建即视为批准，D4）                                 | 走专用审阅对话框，创建即批准，hash 绑定对话框里展示的内容     | 只写定义，**不写** approval ⇒ 待确认                                            |
| update（执行字段）      | 写入，并写 `approval = 新 hash`                                                                   | 同上（审阅对话框）                                            | 写入后 hash 变化，**原批准自动失效**（无论任务是启用还是暂停）                  |
| update（只改 name）     | 允许                                                                                              | 允许                                                          | 允许（不影响批准）                                                              |
| approve `<id> <hash>`   | 先展示完整定义并确认；**确认前**采样 hash，锁内 CAS（当前 hash ≠ 采样值 ⇒ `E_REV`，要求重新审阅） | 只能通过审阅对话框发出，附带对话框里展示的那个 hash，CAS 同上 | **没有这个动作**                                                                |
| pause / resume / delete | 允许                                                                                              | 允许（策略见 §5.2）                                           | 允许。**resume 只把 enabled 置为 true，不批准**；未批准的任务恢复后仍然不会执行 |
| run_now                 | 要求可执行                                                                                        | 要求可执行                                                    | 要求可执行；未批准返回 `E_UNAPPROVED`                                           |

`update` 的 schema 禁止写入 `approval`、`createdBy`、`createdVia`、`createdAt`、`ownerCwd`、`id`。

**能力边界（Minor 22）**：D4 是**受控工具和命令面**上的批准流程。它防的是两类情况：

- 误操作；
- 提示注入诱导 AI 通过 `schedule` 工具**静默**创建或改写任务。

它**不能**在同一 uid 下对抗一个持有 write / edit / bash 的恶意模型——这样的模型可以直接改 `state.json`，或者借其他本地入口。r2 不承诺这种隔离；需要的话，另立权限隔离方案。

### 4.4 occurrence 语义与错过裁决（Major 6/7；复审 R2-2、R2-3）

**计算**（`core/cron.ts` 重写，按 tz 计算）：

- 5 段 cron 在任务 `tz` 下逐字段枚举（日 → 时 → 分，只遍历命中的集合）。每个本地墙钟时间通过 `Intl.DateTimeFormat(tz)` 解析成 UTC 瞬间。
- **DST 规则**：
  - 本地时间不存在（拨快那一段）⇒ 这一分钟不产生 occurrence；
  - 本地时间有歧义（拨回那一段）⇒ 只取**较早**的偏移；
  - 因此每个本地墙钟时间至多对应一个 UTC 瞬间，这一点由算法保证。
- **唯一的计数函数**：`countOccurrences(def, a, b)` 返回 `(a, b]` 内的 occurrence 数，上限 10 000，超过记 `≥10000` 并标 `capped`。agent 写 `MissedEntry.count` 和 hub 对账（§7.2）调用的是**同一个函数**、同一份定义（按 `defHash` 匹配）。
- **预算**：
  - `next` 的视野 ≤400 天，候选评估 ≤50 000 次，超出返回 `undefined`，任务标 `degraded:never`；
  - 所有计算都在锁外完成。
- 创建时校验：400 天内至少命中一次；tz 必须是 Intl 支持的 IANA 时区。进程 tz 与任务 tz 不同不影响结果。

**标识与水位**：

- occurrence 的标识 `T` 是 UTC epoch ms（落在整分钟）。
- `decidedThrough` 是自动 occurrence 的已裁决水位：`≤ decidedThrough` 的 T 都已经被判定为「执行 / 错过 / 跳过」中的一种。
- manual 运行**不读也不写**这个水位（§4.5b）。

**三种裁决（互斥）**：

1. **执行**：由 claim 完成（§4.5a），条件是 `armedSince ≤ T` 且 `now ≤ T + tol`，其中 `tol = fireToleranceS = 60s`。
2. **错过**：只能由 sweep 或 claim 的迟到分支写入，并且**只对已越过在线容差截止时刻的 T 生效**，即 `now > T + tol`。
3. **跳过**：重叠或 D13 合并（§4.5a、§6.2），计入 `skippedTotal`，**不算错过**。

**sweep 规则**（复审 R2-3，与 claim 共用同一套 eligible 判定）：

- sweep 的截止点 `cut = now − tol`，只裁决 `decidedThrough < T ≤ cut` 的 occurrence。
- 仍在容差窗口内（`T > cut`）的 T，sweep **一律不动**：
  - 如果本进程 `armedSince ≤ T`，交给定时器 claim；
  - 否则（会话是在 T 之后才打开的），由 sweep 在 `T + tol + 1s` 安排一次 unref 的补充 sweep，届时再判错过。
- 因此，一个仍然有权执行的在线触发，不会被另一个视图或 rev 重扫抢先关闭。
- 已有非终态 run 占位的 T 也不会被 sweep 改判：claim 先推进了水位，sweep 只处理水位之后的区间。
- sweep 判错过时，在锁内追加一条 `MissedEntry{from: decidedThrough, to: 最后一个 ≤ cut 的 occurrence, count: countOccurrences(...), cause}`，然后设 `decidedThrough = to`，`missedTotal += count`。
  - 区间 `(from, to]` 里**全是未裁决的 occurrence**：执行过的 T 都 ≤ 旧水位，所以**不可能有成功运行混在错过区间里**。
- **claim 迟到分支**（`now > T + tol` 时才拿到锁）：追加 `MissedEntry{from: decidedThrough, to: T, count: countOccurrences(...), cause: "late"}`。这里的 count 也包括中间未裁决的 occurrence。

**定义变更**：任务的 `when / form / prompt` 等执行字段发生修改时，按顺序处理：

1. 先用**旧定义**做一次 sweep（截止 `cut`）；
2. 再写新定义，`occ.defHash = 新 hash`，`decidedThrough = max(decidedThrough, now)`；
3. 新定义从「现在」开始计，旧定义未到期的时间点作废，**不算错过**。

resume（从暂停恢复）同理，`decidedThrough = max(decidedThrough, now)`，暂停期间不算错过。

**once 任务**：`T = at`，与 cron 走同一套规则：

- 在线且 `armedSince ≤ T` ⇒ 由 claim 执行；
- 否则，等越过 `T + tol` 后由 sweep 判错过（`cause: "once-past"`）。

once 裁决后任务置 `enabled: false`，并标 `reason: "once-done"` 或 `"once-past"`。

**墙钟跳变**：

- SessionClock 用分段的 unref 定时器 arm 最近的到期点，另有一个每 60s 的 unref 心跳，比较 `Date.now()` 与 `performance.now()` 的差值。
- 偏差 >60s ⇒ 立即 sweep，再 rearm。
- 往回跳：水位只增不减，不会重复执行。
- 往前跳或休眠：越过容差的 T 由 sweep 判为错过。

**missedLog 截断**：每任务只保留最近 64 条。截断不影响 `missedTotal`（它是累计值）。hub 对账在截断时使用 `totalAfter` 差值（§7.2）。

### 4.5 claim 事务：裁决 + 占位 + 意图三合一（Blocker 2/3；复审 R2-7）

claim 有两种，都在**同一个单文件锁内事务**里完成：持锁时只做同步工作，不 await；一次原子写入。cron 计算全部在锁外进行。

#### 4.5a 自动 claim（定时器到期）

**锁外**：基于读到的快照，算出 T 是不是当前定义的 occurrence，以及 `countOccurrences(decidedThrough, T)`。

**锁内**，按顺序检查：

1. **重读 `state.json`**。`rev` 与快照不一致 ⇒ 出锁重算，最多重试 3 次，之后返回 `E_BUSY`。
2. **校验执行条件**：任务存在、**可执行**（§4.3）、T 仍是当前定义（`occ.defHash`）的 occurrence、`armedSince ≤ T`、本 stack 的 epoch 没有被 dispose、模式矩阵允许执行（`assertExecutable`）。
   - 任一不满足 ⇒ 本次不执行。T 合法时不在这里写入，留给 sweep 按 §4.4 规则处理。
3. `T ≤ decidedThrough` ⇒ 返回 `lost`，不写入。
4. **迟到**：`now > T + tol` ⇒ 追加 `MissedEntry(cause: "late")`，`decidedThrough = T`，`missedTotal += count`，写入，返回 `missed`。
5. **任务级占位**：该任务已有非终态 run（无论 auto 还是 manual）时：
   - background ⇒ `skippedTotal++`，`decidedThrough = T`，写入，返回 `overlap`；
   - message ⇒ 按 D13 处理（§6.2）。
6. **正常执行**：追加 `RunRecord{kind: "auto", state: background 为 "dispatching"、message 为 "queued", holder, defHash}`，同时 `decidedThrough = T`、`firedTotal++`，**同一次原子写**。

**锁外**：拿到 run 之后，才 spawn 或入队。

**崩溃语义**：

- 第 6 步写入前崩溃 ⇒ T 未被裁决，越过容差后由 sweep 判为错过；
- 写入后崩溃 ⇒ 留下非终态 run，§4.6 将其转为 `unknown`。

两种情况都会留下证据，不会被静默吞掉。

#### 4.5b 立即运行 claim（manual：`/schedule run`、工具 `run_now`、飞书或网页触发）

与自动 claim 是**两条独立的路径**。

**跳过**：occurrence 判定、`armedSince`、自动水位 `decidedThrough` 的读写、`firedTotal`、`missedLog`。manual 不要求当前时刻落在 cron 命中的分钟上。

**保留并在锁内检查**：

1. 重读 `state.json`（rev 规则同上）。
2. `reqId` 已在 `manualReqs` 里 ⇒ 原样返回已记录的结果（幂等）。
3. 任务存在、**可执行**（approval hash 等于 defHash），且等于调用方携带的 `defHash`（飞书或网页调用时必须携带，§7.4）。
4. `assertExecutable`：当前 sid 是归属会话、会话在线、模式允许、不在加密域。
5. **任务级占位**：已有任何非终态 run（auto 或 manual）⇒ 返回 `E_OVERLAP`，并把这个结果记入 `manualReqs`。
6. 追加 `RunRecord{kind: "manual", runKey: "<taskId>@m-<hash8(reqId)>", scheduledAt: now}`，`manualTotal[taskId]++`，写入 `manualReqs[reqId] = {runKey}`，**同一次原子写**。

**验收断言**：在不落在 cron 命中分钟的时刻立即运行可以成功，且运行前后 `decidedThrough / firedTotal / missedTotal` 完全不变。

**跨进程的暂停与修改**：两种 claim 都在锁内重读最新定义，所以另一个进程的旧定时器会被拦下。各进程每 30s 做一次 unref 的 `stat`，并在 `turn_start` 时比较 rev 来 rearm。rearm 迟到不影响正确性。

### 4.6 恢复与 `unknown`（D12、Major 11）

**持有者已失效**的判定（满足其一）：

- `holder` 在同主机上的 pid + starttime 已不存在，或 `boot` 已变；
- 同一进程，但 `epoch` 不是当前 stack 的 epoch，且那个旧 epoch 已 dispose（本进程自己知道）。

满足时，非终态 run 转为 `unknown(owner-closed | crash | reload)`。

**执行恢复的时点**：归属会话的 stack 构建（`session_start`），以及持有该会话的进程每 30s 的轮询。

**跨主机持有者**：无法证明已失效，因此不转换；返回 `E_BUSY`，`/schedule repair` 只显示，不强拆（沿用 M-T4）。

**终态单调**：第一次写入的终态胜出。之后到达的结果只写 `lateOutcome` 做审计，不覆盖终态，也不发报告、不写会话。

**正常关闭**：`session_shutdown` 或 stack dispose 时，执行器**最先**执行以下步骤：

1. 置 `disposed`；
2. 在锁内把本 epoch 的非终态 run 写成 `unknown(owner-closed)`。锁等待上限 500ms；拿不到锁就留给下次恢复处理。

子 agent 随 stack 一起被中止。`/reload` 同样处理；在 `reload.defer` 开启时，reload 会等运行结束。

### 4.7 目录、上限与回收（Major 18）

```
<storeDir>/                  默认 <agentDir>/schedules/（0700）
  <sanitize(sid)>/           （0700）
    state.json               0600，≤256 KiB
    .lock                    O_EXCL 锁文件（复用 memory 的锁原语，或复制其最小子集）
    reports/<h>.md           0600，单份 ≤256 KiB（超出部分截断并标 truncated）
```

| 维度                      | 上限 / 处理                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话目录数                | ≤64 个；超出后，新会话第一次创建任务返回 `E_LIMIT`                                                                                                                                                               |
| 每会话任务数              | ≤8 个                                                                                                                                                                                                            |
| 待投递报告索引            | ≤64 条/会话；超出时丢弃最旧的一条并记录通知（§4.2.1）                                                                                                                                                            |
| 报告文件（每会话 / 全局） | 每会话 ≤8 MiB 且 ≤200 份；全局 ≤128 MiB 且 ≤2 000 份。超出时先淘汰**未被 `pendingReports` 引用**的最旧报告；仍然超出 ⇒ 新报告**不写文件**：run 标 `report-skipped(cap)`，不进索引，摘要仍留在结果消息里          |
| 报告保留                  | 14 天，**被 `pendingReports` 引用的文件不回收**                                                                                                                                                                  |
| 删除任务                  | 锁内删除定义、`occ`、`manualTotal`。该任务的终态 runs 与**未被索引引用**的报告由 agent 惰性回收；非终态 run 保留到进入终态；该任务的 `pendingReports` 条目保留，直到回执确认或过期（删除任务不撤回已产生的报告） |
| 空目录                    | 同时满足「无任务、无非终态 run、无 `pendingReports`、无 24h 内报告」⇒ agent 回收整个目录                                                                                                                         |
| 锁体工作量                | 只做解析、校验、一次写入（state ≤256 KiB）；cron 计算全部在锁外                                                                                                                                                  |

## 5. 会话可感知（主轴）

### 5.1 AI 工具 `schedule`

- 注册条件：主会话、post-guard、`schedule.enabled`。schema 每次 activate 冻结，描述文本固定。
- 动作：`list`、`get`、`create`、`update`、`pause`、`resume`、`delete`、`run_now`、`history`。
- 语义按 §4.3：
  - `create` 产生待确认任务；
  - 修改执行字段会使批准失效；
  - `resume` 不等于批准；
  - `run_now` 要求可执行。
- 只能操作本会话的任务（`E_NOT_OWNER`），并受模式矩阵限制（§3.3）。
- 工具结果写明三件事：「待确认，需用户在终端 `/schedule approve` 或网页面板批准」「只在本会话打开时运行」「结果会作为消息出现在本会话」。
- TUI 有 UI 时，**不在工具调用里弹确认框**。审阅统一走 `/schedule approve`，避免工具执行被交互框阻塞（零挂起）。

### 5.2 `/schedule` 命令（用户发起）

**本会话**：

| 子命令                       | 用途                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `[list]`                     | 列出任务                                                  |
| `add`                        | 分步输入，或一行参数；创建即批准                          |
| `edit <id>`                  | 修改；改动执行字段时重新批准                              |
| `show <id>`                  | 展示完整定义与 hash                                       |
| `approve <id>`               | 展示完整定义，在 `ctx.ui.confirm` 之前采样 hash，锁内 CAS |
| `pause \| resume \| rm <id>` | 暂停 / 恢复 / 删除                                        |
| `run <id>`                   | 立即运行                                                  |
| `log <id>`                   | 运行历史                                                  |
| `repair`                     | 修复                                                      |

**`--all`**（任意本地 TUI 会话，管理其他会话的任务，持锁写对方的 `state.json`）：

| 子命令                                            | 是否允许                                                   |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `list --all`、`show <id> --all`、`log <id> --all` | 允许                                                       |
| `pause <id> --all`、`rm <id> --all`               | 允许                                                       |
| `resume <id> --all`                               | 允许（不批准）                                             |
| `approve <id> --all`                              | 允许（本地终端用户可信，同样走审阅 + hash CAS）            |
| `edit --all`                                      | **禁止**（修改应在归属会话里做）                           |
| `run --all`                                       | **禁止**（执行只发生在归属会话内，不能在非归属会话里代跑） |

**web**：`webCommandPolicy.schedule` 子命令表：

| 子命令                         | 策略                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `list`、`show`、`log`          | allow                                                                                                           |
| `pause`、`resume`、`rm`、`run` | confirm（通用确认只是防误触）                                                                                   |
| `approve <id> <hash>`          | 只有带 hash 的形式为 allow：hash 只能从审阅对话框获得，内容批准由对话框保证；不带 hash ⇒ deny                   |
| `add`、`edit`                  | deny（网页创建 / 编辑走面板的审阅表单，表单提交带 hash 的内部命令 `/schedule __put <json> <hash>`，策略 allow） |
| `repair` 与 `--all` 写操作     | deny                                                                                                            |

**飞书**：§7.4。

### 5.3 上下文尾部提示 `pi_schedules`（Major 12）

- 在 `SectionName` 中加入这个段，注册在最后一位。
- provider 同步读取本会话 `state.json` 的缓存（按 mtime、rev 失效）；读失败返回 `SKIP`。
- **只放定义**：名称、id、时间表达式和 tz、形式、是否推飞书、是否待确认。下次运行时间、运行状态等**不放进段里**。
- 没有任务时为 `""`：fold 跳过空段，字节不变。
- **按会话作用域**：
  - `SectionRegistration` 新增可选项 `sessionScoped: true`；
  - `prompt-sections/store.ts` 只为 scoped 段在持久化条目里额外记录 `sid`（其他段的序列化字节不变）；
  - read-back 时，scoped 段的 `sid` 不等于当前 sid，或缺少 `sid` ⇒ 用 `initialSectionState()`。
  - 效果：fork / new 出来的子会话不会继承父会话的任务段，冷启动时为空段，system prompt 字节不变。
  - 用 wire 前缀测试钉住「父会话有任务、子会话无任务」的情形。
- live / legacy 模式不承诺稳定模式下的缓存保证（沿用 hub 语义）。

### 5.4 TUI 状态栏

- 状态键：`pi-subagent:schedule`。
- 显示：`sched 2 · next 08:00`；必要时追加 ` · run 1`、` · pending 1`、` · busy`（锁持有者跨主机时）。
- 只在交互模式下显示；英文 token。

### 5.5 打开会话时的 digest（D1、Major 9；复审 R2-5）

在 `session_start` 之后依次执行：sweep（§4.4）、恢复（§4.6）、note 核验（§6.3）。然后：

1. **生成条件**：以下任一项比 digest 水位新，就生成一条 digest：
   - `missedTotal > shownMissedTotal`；
   - 有新的 `unknown` / `dropped` / `refused` 运行；
   - `reportStats.droppedIndexCap` 增加。
2. **领取**：锁内写 `digest.inflight = {id, holder, fileOffset}`。如果已有 inflight：
   - 持有者仍有效 ⇒ 跳过；
   - 持有者已失效 ⇒ 先按 §6.3 读会话文件核验 `details.digestId`：
     - 找到 ⇒ 只推进水位；
     - 确认缺失 ⇒ 重新领取并发送。
3. **发送**：quiet 消息（`customType: "subagent:schedule"`，`details: {kind: "digest", digestId, covers}`，`triggerTurn: false`）。
4. **推进水位**：只认 §6.3 的落盘证明，即在会话文件里读到该 entry，才在锁内把水位推进到 `covers` 并清掉 inflight。
   - 同一 epoch 内只在会话空闲时核验；迟迟没有证明就保持 inflight，不在同一进程内重发。
5. 同时 `ctx.ui.notify`（交互模式）。

`missedTotal` 本身**不清零**，hub 对账不受 digest 影响。

### 5.6 web-hub 面板（Major 5）

**数据**：

- hub 用只读 reader 扫描 `<storeDir>`（§7.6），投影成 SSE `schedules` 事件（cap `sched.v1`，带指纹门控），另提供 `GET /api/schedules?sessionId=`。
- 投影内容：任务定义（含完整 prompt 与 defHash）、可执行状态、下次运行时间（hub 用同一个 cron 核心按 tz 计算）、最近的运行记录、回执状态。

**UI**：

- 详情页头部加「定时」按钮，打开懒加载的 `SchedulePanel.vue`。
- **专用审阅对话框** `ScheduleReview.vue`：
  - 展示完整 prompt、时间（含 tz 与人类可读形式）、形式、模型、thinking、超时、consult、接手、隔离、是否推飞书、hash 前 8 位；
  - 「批准」按钮发出 `/schedule approve <id> <fullHash>`；
  - 编辑或新建使用同一个表单，提交 `/schedule __put <json> <hash-of-rendered>`；
  - agent 锁内 CAS，失败返回 `E_REV`，对话框提示「内容已变更，请重新审阅」，并自动刷新。
- **离线会话**：只读（E3），页面提示到任意本地终端执行 `/schedule … --all`。
- AgentCard 徽标：`⏰2`；有待确认任务时显示 `⏰!`。

### 5.7 结果回流汇总

| 情形               | 写入会话的方式                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| background 完成    | §6.3 结果消息（默认 quiet；`handoff` 时交给 §6.2 调度器，作为接手消息）                |
| message 运行       | 消息本身就在会话里；`settled` 的结果按 `feishu` 设置进入 `pendingReports`，由 hub 推送 |
| 错过 / 未知 / 丢弃 | §5.5 digest                                                                            |

AI 查看全文的途径：`get_subagent_result <runId>`，或直接读 `reportFile`。

## 6. 执行（只在归属会话内）

### 6.1 background 执行器（`src/schedule/agent/bg.ts`；复审 R2-6）

1. claim 返回 `dispatching`（§4.5a），或 manual claim 成功（§4.5b）后，在锁外构造请求：

   ```ts
   const req: SpawnRequest = {
     type: task.bg.type,
     prompt: header(task, T) + task.prompt, // 固定头：[定时任务 <name> · <T 本地时间 | 立即运行>]，并说明「本次为定时运行，最终回复即为报告」
     label: `sched:${task.name}`,
     cwd: task.ownerCwd,
     ...(task.bg.model ? { modelOverride: task.bg.model } : {}),
     ...(task.bg.thinking ? { thinkingOverride: task.bg.thinking } : {}),
     budgetOverride: { totalMs: task.bg.timeoutS * 1000 },
     timeoutPolicy: "fixed",
     suppressDelivery: true, // 结果由执行器负责（S4）
     callerOwned: true, // 结果归程序所有：fabric wake 不得 revive
     ...(task.bg.isolation ? { isolation: task.bg.isolation } : {}),
     ...(consultRefs ? { consultExperts: consultRefs } : {}),
   };
   ```

   `consultMain` 为真时，先调用 `consult.resolveExperts(["main"])`：
   - 成功 ⇒ 写入 `consultExperts`；
   - 失败（consult 已关闭，或会话没有持久化文件）⇒ **继续运行但不带 consult**，在报告和结果消息里显著标注原因。

2. **准入失败**：`spawn()` 抛错或被拒（quota、未知模型、负载等）⇒ 锁内写入终态 `refused`，`reason: "admission:<code>"`。load gate 对 cron 豁免；池满时排队，不设 `poolFullPolicy`。

3. **运行与等待**：spawn 成功 ⇒ 锁内写 `running(runId)`。然后循环 `waitOutcome(runId, 60_000)`：
   - 返回 `BoundedWaitResult.kind === "pending"` ⇒ 继续等；
   - 返回 `kind === "settled"` ⇒ 读取 `outcome`；
   - 累计等待超过 `timeoutS + 宽限硬上限` 仍是 pending ⇒ 写 `unknown`，`reason: "no-outcome"`。这是防御分支，正常情况下 runner 的 deadline 会先到。

4. **终态映射**：以真实 `RunOutcome.status` 为准，只有 `completed | failed | timed_out | aborted` 四种（`core/types.ts:1227`）。`user_stop` 等是 `diag.stopCause` 的取值（`:36`），只作为原因。映射用 `switch` 穷尽并以 `never` 收尾，编译期保证不漏。

   | `RunOutcome.status`    | RunRecord.state | reason                                                                                                            | 报告 / 结果消息内容            |
   | ---------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
   | `completed`            | `completed`     | —                                                                                                                 | 最终回复全文（`outcome.text`） |
   | `failed`               | `failed`        | `error.kind`（例如 `model` / `auth` / `config`）                                                                  | 错误摘要 + 部分输出            |
   | `timed_out`            | `timed_out`     | `timeoutReason`（例如 `queue_timeout` / `session_create` / …）                                                    | 部分输出                       |
   | `aborted`              | `aborted`       | `diag.stopCause`（`user_stop` / `shutdown` / `parent_abort` / `parent_gone` / `timeout`），缺失时记 `unspecified` | 「已中止：<原因>」 + 部分输出  |
   | （准入失败）           | `refused`       | `admission:<code>`                                                                                                | 拒绝原因                       |
   | （pending 超过硬上限） | `unknown`       | `no-outcome`                                                                                                      | 「结果未知」                   |

   **写入顺序**：
   1. 先写报告文件（需要时）；
   2. 再在锁内**单调**写入：终态、`reportFile`、`note: "pending"`；如果需要推送，同时写入 `pendingReports` 条目（§4.2.1）。

   `shutdown` 导致的 `aborted` 与 §4.6 关闭时写入的 `unknown(owner-closed)` 遵守**先写者胜**：关闭流程先写，所以通常落到 `unknown`，迟到的 outcome 只记 `lateOutcome`。

5. **owner / epoch 隔离**：所有回调都检查 `!disposed && epoch === 当前`。已 dispose 的执行器只允许写本 sid 的 `state.json`（受单调规则约束），**绝不**通过旧 ctx 写会话或发帧。

### 6.2 消息调度器（`src/schedule/agent/dispatch.ts`）：定时消息与接手共用（Major 8；复审 R2-4、N2）

**能力门控**（fail closed，判据是触发形状，不看版本号，I14）

- 复用进程级形状证据 `getXsHostCapability()`（`fabric/xs/host-cap.ts`；底层判定为 `pi-compat.ts:257-291` 的 `readTriggerShape`）。证据来自真实发生的 `before_agent_start`（任何一次用户提问都会产生），不发探测请求。
- 状态与行为：
  - **`observed` / `verified`**（pi ≥1.2 的 union 形状）⇒ 启用调度器。
  - **`absent`**（pi 1.0/1.1 的 legacy 形状，或缺少 custom 的 details）⇒ 调度器**禁用**：
    - 工具与命令创建 / 修改 message 形式、开启 `handoff`，返回 `E_UNSUPPORTED`，并说明「当前 pi 不提供定时消息所需的触发能力」；
    - 已排队的 message 以 quiet 方式写入「定时消息未执行：pi 能力不足」，run 记 `dropped(capability)`；
    - handoff 降级为 quiet 结果消息；
    - 状态栏追加 `· msg off`；只提示一次 `ctx.ui.notify`。
  - **`unknown`**（本进程还没出现过任何 `before_agent_start`）⇒ 先不调度，消息留在队列里（状态栏 `· msg ?`）：
    - 证据到达后立即按上面两种情况处理；
    - 排队超过 30 分钟仍是 unknown ⇒ 按 `absent` 的降级方式写入并记 `dropped(capability-unknown)`。
    - 这是已披露残留：会话刚打开、用户还没输入过任何内容时，第一条定时消息可能被降级。

**入队与 D13**

- 来源：message 由 claim 写入 `queued`；handoff 在 background 终态后入队一条「接手消息」（结果摘要 + 「请接手处理」）。
- D13：每个任务至多一条 `queued`。新的入队时：
  - 旧的 `queued` 转为 `dropped(coalesced)`，`skippedTotal++`；
  - 已经 `dispatched` / `bound` 的运行照常继续，新消息留在队列里。

**状态机**（每个进程同时只有一个在途调度；进程级占位 `Symbol.for("pi-subagent:sched-dispatch")`；所有状态都写进 `state.json` 的 RunRecord）：

```
queued ─(调度条件满足，同一同步块内 verifyDispatch + send)─▶ dispatched{token, epoch, sentAt}
  dispatched ─(before_agent_start：触发者 = 本 customType 且 token 有效)─▶ authorized{authorizedAt}
  dispatched ─(sentAt+60s 仍未 authorized)─▶ token 作废 ⇒ unknown(start-timeout)（之后若触发仍启动，由孤儿检查 abort）
  authorized ─(本消息 message_start)─▶ bound（开始记录归属；这只说明进入了上下文，不说明已落盘，§6.3）
  authorized/bound ─(sentAt+60s 时仍未进入首次模型调用，即卡在 prepare 中)─▶ ctx.abort() ⇒ aborting
  aborting ─(该运行 agent_settled)─▶ 期间无 assistant 输出 ⇒ dropped(start-timeout)；有输出 ⇒ unknown(start-timeout)
  bound ─(agent_settled)─▶ settled（取最后一条 assistant 回复）
  bound ─(本轮出现人工输入)─▶ continued（交给人，解除 deadline，不推报告）
  authorized/bound ─(authorizedAt + 3600s，N2)─▶ ctx.abort() ⇒ aborting ⇒ 该运行 settled 后记 settled(reason: "run-max")，带部分输出
  queued ─(会话切换或进程退出)─▶ dropped(owner-closed)（进 digest，不转投、不补跑）
```

**调度条件**（在同一个同步块内检查，然后立即发送）

- 调用点不在 `agent_settled` 处理器里，也不在同一 tick：由 settled 之后的 unref 定时器驱动，并要求**静默期**——最近一次 `agent_settled` 已过 ≥1s，且之后没有 `agent_start`。
- `ctx.isIdle()` 为真，且 `!ctx.hasPendingMessages()`。
- 进程级占位空闲；`RootWakeController`（若存在）不忙；xs wake 账本里本会话没有 owner。
- 没有打开着的 ask_user 对话。
- 本模块自有的 `createSessionFence()` 实例：`beginDispatch()` 返回 ok，并且 `verifyDispatch(gen)` 与 `sendMessage` 在同一同步块内。
  - 真实 pi 事件由本模块转发给 fence；web_exec / topic_switch / goal 三个端口与 xs 相同接法。
  - goal 运行中只延后调度，不拒绝。
- 能力门控为启用状态。

**发送**

```ts
sendMessage(
  {
    customType: "subagent:schedule",
    content,
    display: true,
    details: { kind: "message" | "handoff", runKey, token, noteId },
  },
  { triggerTurn: true },
);
```

token 只在签发它的那个 epoch 内有效。`/reload` 之后，新 stack 会把旧 epoch 的 token 一律视为作废。

**孤儿检查与授权复核**（时序写明）

1. **`before_agent_start`**（每次运行启动时都会经过）：读取触发者（`readBeforeAgentStartTrigger`）。
   - 如果 customType 是 `subagent:schedule`：token 有效且属于本 epoch ⇒ 记 `authorized`，并把「当前运行 → token」绑定保存在内存；
   - 否则（token 已作废、已过期、不属于本 epoch、找不到）⇒ **同步 `ctx.abort()`**（与 root-wake 的 B1 模式相同）。
2. **每次模型调用前**（pi 的 `context` 事件，`context-switch/child.ts:484` 已经在用；它在 `before_agent_start` 处理器链和 pre-start 压缩之后、provider 请求之前触发）：如果当前运行绑定的 token 已作废（比如 60s 启动超时已经过了），**`ctx.abort()`**。
   - 这一步覆盖的场景：`before_agent_start` 时 token 还有效，但随后被别的处理器或压缩拖过了超时。不能只依赖已经执行过的那个钩子。
3. **启动超时定时器**（sentAt+60s，unref）：
   - 还没 authorized ⇒ 作废 token；
   - 已 authorized 但第 2 步还没出现过（运行仍在 prepare 中）⇒ 作废 token 并 `ctx.abort()`，进入 `aborting`，直到该运行 settle。
4. **运行上限定时器**（authorizedAt+3600s，unref，N2 固定值）：到时 `ctx.abort()`。人工插话（`classifyHumanInput`）⇒ 转 `continued` 并取消这个定时器。

**归属与结果**

- 运行 bound 之后，以最后一条 assistant 回复作为结果；如果本消息被合并进了别的触发启动的运行，结果标注 `merged`。
- `feishu: true` 时，`settled` 的结果写入报告文件并进入 `pendingReports`（§4.2.1）。`continued` / `aborting` 产生的终态不推报告。

**取舍**：不复用 xs 的 `RootWakeController`，因为它绑死了 `subagent:xs` 的消息类型、账本、策略和配额，并且受 C-X 一致性测试冻结。本调度器实现了与它同等的必要机制，并与它互斥：发送前占位、fence 与代次、真实触发授权、模型调用前复核、启动超时中止、deadline、人工交接、孤儿 abort。

### 6.3 结果消息与落盘证明（Major 9；复审 R2-5）

**唯一的证明来源：会话文件里的 entry。** 结果消息（以及 digest、handoff）是否已写入，**只认**归属会话的 jsonl 文件（`ctx.sessionManager.getSessionFile()`）中是否存在下面这样一行：

- `type` 为 custom_message；
- `customType` 为 `"subagent:schedule"`；
- `details.noteId` 等于本条消息的 `noteId`（全局唯一的随机 id）。

以下**都不算**证明：`sendMessage` 的返回值、pi 内存里的 pending 队列、`message_start` / `message_end` 事件、`getBranch()` 的内存视图。原因有二：

- streaming 期间，quiet 消息会在 pi 内存里滞留到本轮结束；
- `triggerTurn: true` 的消息，pi 是在 `message_end` 的扩展事件**之后**才追加落盘的（复审核对：pi `agent-session.js:752-768,1843-1858`）。

**发送**（background 到达终态且 `note === "pending"`）：

1. 锁内记录 `noteId`、`noteHolder`（本进程本 epoch），以及发送前 `stat` 得到的会话文件大小 `noteFileOffset`；
2. 发送：
   - **quiet**（默认，D3）：`sendMessage({customType: "subagent:schedule", content: 头 + 摘要(≤4 KiB) + "全文：get_subagent_result <runId> 或 <reportFile>", display: true, details: {kind: "result", runKey, runId, noteId}}, {triggerTurn: false})`；
   - **handoff**：交给 §6.2 的调度器（消息里带同一个 `noteId`）。

**核验**（读会话文件）：

- **读取范围**：从 `noteFileOffset` 往后读到文件末尾（O_NOFOLLOW，单次 ≤16 MiB）。逐行查找包含 `"subagent:schedule"` 的行，再做 JSON 解析，比对 `noteId`。
  - 超过 16 MiB ⇒ 记为 `unverified`，**不重发**，并在 `/schedule log` 里显示。
- **核验时机**：
  - **本进程**：发送之后，在会话空闲时（`agent_settled` 加静默期且 `isIdle`）核验：读到 ⇒ 锁内改为 `written`；读不到 ⇒ **保持 pending，同一进程内永不重发**。原因：pi 进程还活着，原消息可能仍在它的内存队列里；即便 `/reload`，AgentSession 也会保留下来，之后仍可能写入。
  - **跨进程**：归属会话在**另一个进程**里构建 stack 时，如果 `noteHolder` 的 pid+starttime 已经不存在（或 boot 已变化）——说明原进程的内存队列不可能再写入——就读会话文件核验：读到 ⇒ `written`；**确认缺失** ⇒ 在锁内领取（更新 `noteHolder` 与 `noteFileOffset`）后，用**同一个 `noteId` 重发一次** quiet 消息。
  - **handoff 例外**：重发时**不重新触发运行**（那一轮已经执行过了），改为补写一条 quiet 结果消息，`details.kind` 为 `"handoff-recap"`。
- **同一会话被两个进程同时打开**：`noteHolder` 仍然存活 ⇒ 另一个进程不核验、不重发。
- **次数上限**：每条最多重发 2 次（跨两个不同进程），之后记 `unverified`。

**与通用 notifier 的关系**：定时运行设置了 `suppressDelivery`，不进入 notifier；通用投递行为一律不改。

**已披露残留**：同一进程里先 `/new` 再 `/resume` 回到原会话时，原 pending 是否被丢弃没有证据，所以不在本进程补发，要等下一次 pi 启动才补写。

### 6.4 归属会话运行中被关闭（D12）

见 §4.6。

- background：子 agent 随 stack 中止，结果为 `unknown(owner-closed)`；
- message / handoff：dispatched / authorized / bound / aborting 的运行随会话结束，结果为 `unknown(owner-closed)`；排队中的为 `dropped(owner-closed)`。会话关闭时的 pending token 随 epoch 一起作废，之后哪怕触发仍然启动，也会被孤儿检查 abort（§6.2）。

两者都进 digest。hub 观察到后推送「结果未知」（§7.2）。**不重跑。**

## 7. hub 协调者与飞书

### 7.1 报告投递：hub 是唯一投递者，回执自有台账（Blocker 4、Major 13/14；复审 R2-1、N1）

**发现**：hub reader **只读取** `state.json` 的 `pendingReports` 索引（§4.2.1），不再看 runs。一条记录同时满足以下条件才投递：

- `now < expiresAt`，即完成后 24h 内（N1）；
- `endedAt ≥ 机器人凭据安装时间`；
- 回执表中没有这个 `reportId`；
- 报告文件通过 reader 的校验。

**投递去重**：`reportId = sha256(sid + "\0" + runKey)`。回执存在飞书 `state.json` 新增的 `scheduleReceipts` 表里：

- 已有回执 ⇒ 不入队。
- 没有回执 ⇒
  1. 读报告文件；
  2. 渲染（`renderReply`，超过 4 段时第 1 段后附 md）；
  3. 在**同一个同步段**里，先把 `receipt{state: "accepted", at}` 写进内存，再调用 `enqueueFinal({requestId: "sch:" + reportId 前缀})`；
  4. 两者由**同一次** `state.commit()` 落盘。
- `enqueueFinal` 返回 `ok:false`，或返回 `durable:false` 且随后 commit 失败 ⇒ 回执记为 `refused(<code>)`，不重试。
- outbox 结算时（`settled()` 里的 `sch:` 分支不再提前返回）⇒ 回执更新为 `sent`、`failed(code)` 或 `uncertain`。

**回执回传**：回执一旦进入 accepted 或之后任一状态，hub 就向**在线**的归属会话推送 `sched_receipts{sessionId, reportIds}`：

- 推送时机：会话 `hello` 时补推一次，之后每次状态变化都推；
- agent 收到后，在锁内从 `pendingReports` 中移除这些条目；
- 归属会话离线时不推。条目留到过期为止，期间 hub 靠自己的回执表跳过，**不会重复投递**。

**hub 重启对账**：回执为 `accepted`，但 outbox 里已经没有这个 requestId 的组 ⇒ 改为 `uncertain`（可能已送达），不重发。

**回执表容量**：保留 7 天（大于 24h 投递窗口加余量），上限 4 096 条。满了以后：新报告不投递，记 `sched-receipt-cap`，面板显示「未推送（容量）」。

**投递语义**：

- 同一个 `reportId` **至多入队一次**；
- outbox 内部在 uuid 安全窗口内至少发送一次，过期按 `expired-uncertain` 处理（沿用现有逻辑）；
- **不承诺 exactly-once**。

**状态区分**：

| 状态       | 判定                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 永久未配置 | 从未装过机器人凭据 ⇒ 显示 `n/a`，之后也不补推（`endedAt` 早于凭据安装时间的报告不推） |
| 暂时断连   | 凭据存在但状态不是 `open` ⇒ 等待；24h 内恢复就投递，超过显示 `expired`                |
| hub 已接管 | `accepted`                                                                            |
| 飞书终态   | `sent` / `failed` / `uncertain` / `refused`                                           |

面板和 `/schedule log` 从 hub 投影读取这些状态；hub 不可达时显示 `feishu: ?`。

**本地模式与 hub 停机期间（N1 定案）**：报告只留在 `state.json` 的索引和报告文件里。hub 在 24h 内恢复（且机器人已配置）就补推；归属会话是否打开不影响补推，因为 hub 直接读文件。

### 7.2 「已错过」与「结果未知」通知（Major 6、E1；复审 R2-2）

**唯一事实源**：agent 写入的 `missedLog`（§4.4）。每条记录表示区间 `(from, to]` 内当前定义（`defHash`）的**全部** occurrence 都已被判为错过。成功运行的 T 都小于等于写入时的旧水位，所以**不可能落进错过区间**。agent 写入时和 hub 对账时，用的是**同一个** `countOccurrences(def, from, to)`。

**hub 观察**（hub 在线、归属会话离线时的即时提醒）：

- hub 用同一个 cron 核心算出每个启用且可执行任务的下一个 T，在 `T + tol + 30s` 时读取水位。
- 若 `decidedThrough < T`，并且归属会话**没有任何在线视图**，这个 T 必然会被判错过（离线不补跑，后来打开的会话 `armedSince > T`，不可能再执行它）。hub 记一条观察 `{T, defHash}`，计入通知。
- 观察集合每任务最多 64 条，TTL 7 天，存放在 hub 自己的 `<hubStateDir>/schedule/state.json`。

**对账算法**：hub 每个任务维护 `consumedSeq`、`consumedTotal`、`observed[]`，并以 `missedLog` 的 `seq` 为游标：

1. 对每条新记录 e（`e.seq > consumedSeq`），计算
   `notify_e = e.count − |{ o ∈ observed : e.from < o.T ≤ e.to ∧ o.defHash = e.defHash }|`，
   然后从 `observed` 中删掉命中的那些观察。这些 T 已经在观察时通知过，扣掉以免重复。
2. **截断处理**：最旧的保留记录满足 `e₀.seq > consumedSeq + 1`，说明有记录被截断了。截断部分的错过数为
   `gap = (e₀.totalAfter − e₀.count) − consumedTotal`，
   再减去 `observed` 中 `T ≤ e₀.from` 的观察（这些必然属于截断部分），然后删掉它们。
3. 处理完后，`consumedSeq` 和 `consumedTotal` 前进到最新一条记录。
4. **observed 过期**：TTL 到期仍没有被任何 store 记录匹配上（例如会话一直没打开），直接丢弃。它在观察当时已经通知过，丢弃不会造成漏报。

**等价性**：

- 观察到的 T 一定会在之后某条 store 记录的区间里出现：会话打开时，sweep 会覆盖从旧水位到当前时刻的整段区间。
- 所以每个错过的 occurrence 恰好被通知一次：要么在观察时，要么在对账时。

§14 用具体数字覆盖以下组合：「成功 / 错过交错」「先观察后 sweep」「先 sweep 后观察」「迟到 claim」「hub 重启」「截断」。

**合并（E1：同一任务每小时一条）**：

- 每个任务在每个整点小时内**最多发一条**飞书通知。
- 该小时内第一次产生待通知数时立即发送，内容包含之前结转的数量；之后同一小时内再产生的，全部结转。
- 进入下一个整点时，如果有结转，就立即发一条汇总，这条算作新小时的那一条。
- 合并状态 `{hour, sentInHour, carry}` 持久化在 hub 状态里，hub 重启后恢复。
- hub 启动时，观察时钟只补看最近 10 分钟内的观察点；store 记录不受这个限制，同样走合并。

**结果未知**：reader 发现以下任一情况，且该 runKey 不在 `notifiedUnknown` 中：

- run 处于 `state: "unknown"`；
- 持有者已失效的非终态 run（hub 只读判定，判据同 §4.6）。

hub 推送「结果未知：<任务> <时间>（运行中会话被关闭）」，然后把 runKey 加入集合（TTL 7 天）。这类通知也受「每任务每小时一条」约束，与错过的通知共用同一个合并槽。

**索引溢出**：`reportStats.droppedIndexCap` 增加 ⇒ 增量并入该会话下一条通知（§4.2.1）。

**投递语义**：通知类消息用 `enqueueNotice` 发送，key 为 `schm:<hash>`，**至多一次**：先写 hub 状态再入队，崩溃最多丢一条。会话里的 digest 才是可靠通道。

### 7.3 飞书生产端预算与隔离（Major 17；复审 Minor N-1）

| 维度                | 上限                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 报告                | 全局每小时 ≤20 份，每任务每小时 ≤6 份。超出不推送：回执记 `refused(budget)`（索引条目随回执回传移除），计数并入该任务的下一条通知（「本小时另有 N 份报告未推送，请到会话或网页查看」） |
| 通知（错过 / 未知） | **每任务每小时 1 条**（E1，§7.2）；全局每小时 ≤30 条                                                                                                                                   |
| 上传                | 报告 md 上传并发 ≤1；单个 md ≤256 KiB                                                                                                                                                  |
| outbox 余量         | 同时满足以下三条才入队：outbox 占用低于上限的 50%；`state.json` 剩余空间 ≥512 KiB；工作通道有余量（规则同 xs-mirror）。否则记 `refused(headroom)`                                      |
| 共享 notice 预算    | 通知走 `NoticeBudget` 的 **schedule 通道**，必须为关键通道（安全告警、审批）留出余量，见下方接口变更；报告不占 notice 预算                                                             |
| 可见性              | `info().counters.dropped` 里的 `sched-<reason>` 计数；面板显示每份报告的回执原因                                                                                                       |

**`NoticeBudget` 接口变更**（`src/web-hub/hub/feishu/security.ts:27-66`，归 F1）：

```ts
export type NoticeLane = "critical" | "normal" | "schedule";
export interface NoticeBudget {
  /** opts 缺省 ⇒ lane "normal"，行为与旧接口逐字节一致（旧调用点不改）。 */
  reserve(key: string, gapMs: number, opts?: { lane?: NoticeLane }): boolean;
  /** 本分钟窗口内剩余的全局额度（只读，供可见性与测试使用）。 */
  remaining(): number;
  dispose(): void;
}
```

各通道的规则（共享 `FEISHU_NOTIFY_LIMITS.globalPerMin`，下文记作 G，按分钟窗口计）：

- **`critical`**（安全告警、2FA / 飞书审批）：可以用满 G。
- **`normal`**（现有的 done / failed / owner 通知，也就是旧调用的默认）：行为不变，可以用满 G。
- **`schedule`**：同时满足两条才放行：
  - 放行后剩余额度仍 ≥ `CRITICAL_RESERVE_PER_MIN`（5）；
  - 本分钟 schedule 通道已用量 < `max(1, G − 5 − 2)`。

安全告警的调用点改为显式传 `lane: "critical"`。注意，旧行为里安全告警与 notify 共享同一额度，这次改动只让 schedule 通道让路，不改变其他通道之间的关系。新增单测覆盖：

- 三个通道的配额；
- 不传 `opts` 时字节级等价于旧行为；
- schedule 洪峰下，critical 仍然能拿到额度。

**隔离测试**：64 个任务在同一分钟触发时，正常回复、2FA 审批、安全告警、xs mirror 都不被饿死（§14）。

### 7.4 飞书 `/schedule`（D6、Major 15）

- 在 `router.ts:26/53` 的语法里加入 `/schedule` 和 `/schedule run <n>`。仅名单内的发送者、仅私聊可用。
- `/schedule`：编号列表，来自 hub 投影。列表生成后 10 分钟有效。每一项冻结 `{sid, taskId, defHash}`。
- `/schedule run <n>`：
  1. 取出列表中冻结的那一项；
  2. 要求归属会话**恰好一个在线视图**，且该视图声明了 `sched.v1`；否则回复「归属会话不在线（<label>）」或「会话在多处打开」。
  3. `reqId` 取该飞书请求的确定性 cmdId（`fs…`，由 batchId 派生，重投递时保持不变）。
  4. hub 发送：

     ```
     sched_run{reqId, sessionId: sid, taskId, defHash, expiresAt: now + 30s}
     ```

  5. agent 处理：
     - 检查 `sessionId` 是否等于当前 sid，未过期；
     - 锁内事务：先查 `manualReqs[reqId]`，命中就返回已有结果；否则校验「可执行」且 `defHash` 相等（不等就拒绝：「任务已修改，请重新 /schedule」），再走 §4.5b 的立即运行 claim（不要求 cron 命中，不读写自动水位，不计入 `firedTotal`），写入 `manualReqs`；
     - 回复 `sched_run_ack{reqId, started | refused(reason)}`。
  6. hub 最多等待 10s：
     - 收到 ack ⇒ 回复「已开始」或拒绝原因；
     - 超时 ⇒ 回复「执行结果未确认，请稍后用 /schedule 查看」。**不自动重发**。
- 同一条飞书消息被重投递时，`reqId` 相同，由 agent 侧台账去重；用户重新发一条新消息 ⇒ 新的 reqId ⇒ 新的一次手动运行，受任务级占位约束。
- 手动 runKey 为 `<taskId>@m-<hash8(reqId)>`，与 `Date.now` 无关。
- web 上的 `/schedule run <id>` 由 command op 的 cmdId 作为 `reqId`，走同一个台账。

### 7.5 done 通知抑制：按运行绑定（Major 16）

1. agent 在本调度器的消息出现 `message_start`（bound）时，**同步**发送 `sched_bound{agentKey, runKey}`。它与 `ev` 事件走同一条有序 socket，所以 hub 一定先收到该运行的 `agent_start`，再收到它，再收到 `agent_settled`。
2. hub 在 proactive 表中当前运行的条目上设置 `p.sched = runKey`，只作用于这一次运行，`agent_settled` 时清除。
3. 如果同一运行里之后出现**非本消息的人工 user `message_start`** ⇒ 清除 `p.sched`，恢复正常的 done 通知（对应调度器的 `continued`，这时也不推报告）。
4. `p.sched` 存在 ⇒ done 通知跳过（已有定时报告，或用户没开 `feishu` 时有意不推）。
5. 没有时间窗，也不给整个 agentKey 设 TTL。重连导致缺帧 ⇒ 没有标记 ⇒ 保守发送 done（宁可重复，不可压掉）。
6. background quiet 结果**不触发主会话的运行**，因此本来就不会产生 done 通知。
7. 与 `src/feishu-notify` 的重复卡片属于已披露残留，不处理。

### 7.6 hub 只读 reader 与路径安全（Major 18/19）

**纯只读**：`src/schedule/core/reader.ts` 不备份、不修复、不清理、零写入（用测试钉住）。损坏的文件只返回 `{degraded: reason}`，面板显示「需在终端 `/schedule repair`」。备份为 `.bak` 等修复动作只由 agent 端的 writer 执行。

**路径**：

- `storeDir` 在 hub 启动时 `realpath`；启动和每次扫描时都做以下检查：
  - 字面路径与 canonical 路径都不在任何已登记 vault 内（`canonicalPath` + `inVaultDir`）；
  - 记录 dev/ino。
- 逐级以 `O_DIRECTORY | O_NOFOLLOW` 打开 `storeDir` → `sid` 目录（基于目录 fd 的相对打开）→ 文件（`O_NOFOLLOW`）。
- 对每一级 `fstat`：类型正确、属主 uid 与 hub 一致、不可被组或其他用户写入；文件大小在上限之内。
- 报告路径必须是 `reports/<h>.md`（只允许这个形态）。
- 任何一项不满足 ⇒ 该会话 degraded；`storeDir` 的 dev/ino 变化 ⇒ 整体 degraded。

**扫描预算**：

- single-flight，每轮 deadline 2s；
- 物理 IO 台账 ≤2 个并发文件操作；
- 用代次（generation）屏蔽迟到结果；
- 每轮最多 64 个会话；
- 触发条件：`sched_changed` 推动（只扫对应会话），或 60s 兜底全量扫描。

**agent 侧**：

- `storeDir` 在 stack 构建时做同样的 realpath、vault 双检与属主检查。
- 每个**执行点**（定时 claim、手动运行、飞书立即运行、调度器发送）都调用统一的 `assertExecutable()`：
  - plain 域，且未 locked；
  - 模式矩阵允许；
  - 当前 sid 等于归属 sid；
  - `ownerCwd` 的 realpath 不在 vault 内。

  定时回调不经过 `tool_call` / `input` 守卫，所以这里必须显式检查。

## 8. 预算、并发、时间

1. **预算**：`timeoutS` 默认 1800，上限 14400；定时消息与接手运行固定最长 3600s（N2，§6.2）；成本计入归属会话（fleet / HUD）。单次成本上限列为扩展项。
2. **并发**：
   - 同一任务不叠加（§4.5 第 5 步）；
   - 不同任务之间走 SpawnService 槽池排队；
   - 消息调度器每个进程同时只有一个在途。
3. **错过、休眠、时间跳变、DST、时区**：见 §4.4。
4. **D9（不自启 hub）**：
   - 执行不依赖 hub；
   - pi 在 webHub 开启时会拉起 hub，所以只要有会话开着，hub 通常就在；
   - 机器重启后、打开任何 pi 之前，没有 hub ⇒ 这段时间的「已错过」不推送，改由打开会话时的 digest 提示；
   - hub 恢复后补推 24h 内的报告（N1 定案，§7.1）。

## 9. 扩展点（不做，留口子）

1. **离线时由 hub 恢复会话执行**：
   - 在 `RunRecord.state` 或执行器类型上预留 `resumed`；
   - 在 hub 观察时钟的错过分支上预留策略位（当前固定为 `notify`）；
   - 风险：pi 不锁会话文件，可能出现两个写者。
2. **离线运行的前情**：expert 引用 `session:<file>`。
3. **其他**：`maxCostUsd`；interval 类型；hub 写代理（让离线任务在网页上可写）；开机自启。
4. **root-wake 泛化**：把 xs 控制器和本调度器的公共部分抽出来（需要重跑 C-X 测试）。

## 10. 接口契约

### 10.1 帧

- 位置：`src/web-hub/protocol/schedule.ts` 定义类型，并接入 `messages.ts` 的帧联合类型与解码表。
- cap：`sched.v1`。两侧都声明，caps 折叠时包含它；不升 PROTO，只增加可选帧。

```ts
// agent → hub
| { t: "sched_changed"; sessionId: string }                          // 推动：只重扫这个会话
| { t: "sched_bound"; agentKey: string; runKey: string }             // §7.5
| { t: "sched_run_ack"; reqId: string; result: "started" | "refused"; reason?: string }
// hub → agent
| { t: "sched_run"; reqId: string; sessionId: string; taskId: string; defHash: string; expiresAt: number }
| { t: "sched_receipts"; sessionId: string; reportIds: string[] } // §4.2.1/§7.1：回执已确认，agent 据此移除 pendingReports（每帧最多 64 条）
```

- 报告正文**不走帧**（S3）：hub 从文件读取。
- 所有帧都用 typebox 校验，非法帧丢弃并记审计。
- agent 只在 `hello_ack.caps ∋ sched.v1` 时发送这些帧，否则用 NullCoordinator（不做任何事、不持久化任何东西）。

### 10.2 错误码

| 错误码          | 含义                                                    |
| --------------- | ------------------------------------------------------- |
| `E_DISABLED`    | 功能未启用                                              |
| `E_MODE`        | 当前运行模式不允许（print / json）                      |
| `E_EPHEMERAL`   | `--no-session` 会话                                     |
| `E_CHILD`       | 独立打开的子会话文件                                    |
| `E_SECURE`      | 加密域                                                  |
| `E_LIMIT`       | 超出数量上限                                            |
| `E_INVALID`     | cron 永不命中、模型未知、tz 不合法、字段超长等          |
| `E_REV`         | 并发修改冲突，或审阅时的 hash 与当前不一致              |
| `E_UNAPPROVED`  | 任务未批准                                              |
| `E_NOT_OWNER`   | 不是归属会话                                            |
| `E_OVERLAP`     | 同一任务已有运行                                        |
| `E_BUSY`        | 锁被占用，或持有者无法证明已失效                        |
| `E_DEGRADED`    | 存储损坏，需修复                                        |
| `E_UNSUPPORTED` | pi 未提供定时消息 / 接手所需的触发能力（§6.2 能力门控） |

### 10.3 settings 与 HubConfig

所有设置都**不是 live 的**：改完后需要 `/reload`，涉及 hub 的项还要 `/webhub restart`。

| 键                                         | 默认                   | 说明                      |
| ------------------------------------------ | ---------------------- | ------------------------- |
| `schedule.enabled`                         | `false`                | 总开关                    |
| `schedule.dir`                             | `<agentDir>/schedules` | storeDir（做 vault 校验） |
| `schedule.defaultTimeoutS` / `maxTimeoutS` | 1800 / 14400           |                           |
| `webHub.webCommandPolicy.schedule`         | 子命令表（§5.2）       |                           |

固定值，不提供设置项：

- `fireToleranceS` = 60
- 定时消息 / 接手运行上限 = 3600s（N2，人工插话解除）
- 待投递报告索引 = 64 条/会话（§4.2.1）
- 每会话任务数 = 8
- 报告保留 14 天
- `reportMaxAgeH` = 24
- 已错过的通知策略（E1）
- 飞书预算（§7.3）

**HubConfig**：`HubConfig.schedule = { dir: string; toleranceS: 60 }`，只在 `schedule.enabled ∧ webHub.enabled ∧ control !== false` 时写入（`hub/ports.ts:432`；写入点在 `web-hub/agent/index.ts:1456` 附近）。key 不存在 ⇒ hub 字节不变。`main.ts` 会重新校验，非法时整个 key 丢弃。

**已知残留**：拉起 hub 的那个 pi 的配置决定 hub 的行为（与 alias R11 同类）。

## 11. 安全

**谁能做什么**：

| 来源                                  | 权限                                        |
| ------------------------------------- | ------------------------------------------- |
| 本地终端用户                          | 直接生效                                    |
| web 用户                              | 创建、编辑、批准都走审阅对话框，并绑定 hash |
| AI                                    | 只能提交，修改执行定义会使批准失效（§4.3）  |
| 子会话、consult、独立打开的子会话文件 | 不能（§3.3）                                |
| 飞书                                  | 只读列表 + 绑定版本的立即运行               |

**能力边界**：见 §4.3，D4 不对抗同 uid 的恶意模型。

**审计**：所有变更都记录 `{id, 动作, 来源, rev}`，不记录正文。

**加密域**：

- agent 在 secure 或 locked 状态下全部拒绝；
- `storeDir`、`ownerCwd`、报告路径都做字面路径与 canonical 路径的双重 vault 检查，并逐级 `O_NOFOLLOW`（§7.6）；
- private-ns 下 hub 不会被拉起。

**飞书**：只发给 owner 私聊；不附带任意文件，报告 md 由 reader 校验其形态。

**hub 只读**：web 和飞书都无法借 hub 改写任务。

## 12. 分包与估工（契约冻结后并行；每个真实共享文件只有一个写入包）

| 包                            | 内容                                                                                                                                                                                                                                                                                                | 写入的文件（独占）                                                                                                                                                                                       | 依赖                         | 估工  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----- |
| **S0** 契约                   | 帧类型和 typebox 定义，接入 messages.ts 的联合与解码表（新增 `sched_receipts`）；caps；HubConfig 类型；settings 段；command-policy 子命令表；`spec.ts`，内容是任务、运行、状态文件（含 `missedLog` 与 `pendingReports`）、defHash 规范化                                                            | `src/web-hub/protocol/{schedule,messages}.ts`、`src/web-hub/hub/ports.ts`（HubConfig 字段）、`src/config/settings.ts`（schedule 段）、`src/web-hub/agent/command-policy.ts`、`src/schedule/core/spec.ts` | —                            | 1.5d  |
| **S1** 核心                   | 带 tz 的 cron（DST、预算、唯一 `countOccurrences`）；单文件 writer：锁、事务、自动与手动两种 claim、带容差截止的 sweep、`missedLog`、恢复判定、`pendingReports` 写入/移除/过期/溢出、回收；纯只读 reader（逐级 O_NOFOLLOW、vault 双检）；会话文件 entry 核验函数（有界读取，§6.3）；boundary 白名单 | `src/schedule/core/{cron,occurrence,writer,claim,recovery,reader,paths,lock,session-proof}.ts`、`tests/web-hub/boundary.test.ts`                                                                         | S0（类型）                   | 4.0d  |
| **A0** agent 骨架             | `wire.ts`；SessionClock（armedSince、心跳、rev 轮询、容差补充 sweep）；模式矩阵与 `assertExecutable`；Coordinator（Hub/Null，负责推送与帧收发，并处理 `sched_receipts`）；index/stack 装配；HubConfig 写入；**退役旧引擎**                                                                          | `src/schedule/agent/{wire,clock,mode,coordinator}.ts`、`src/index.ts`、`src/stack.ts`、`src/web-hub/agent/index.ts`、删除 `src/schedule/{scheduler,store}.ts`                                            | S0、S1                       | 2.0d  |
| **A1** background             | `bg.ts`：SpawnRequest 映射、consult 解析、真实四态终态映射（穷尽 switch）、owner/epoch 隔离、关闭时写 unknown、报告文件与索引；`note.ts`：结果消息、会话文件核验、跨进程补投                                                                                                                        | `src/schedule/agent/{bg,note,report-file}.ts`                                                                                                                                                            | A0                           | 2.5d  |
| **A2** 调度器                 | `dispatch.ts`：能力门控（`getXsHostCapability`）、状态机、占位、fence、静默期、`before_agent_start` 授权与孤儿 abort、`context` 复核、启动超时中止、3600s 上限与交接、D13、结果锚定                                                                                                                 | `src/schedule/agent/{dispatch,message}.ts`                                                                                                                                                               | A0                           | 3.5d  |
| **A3** 感知面                 | 工具（批准语义、模式拒绝、`E_UNSUPPORTED`）；`/schedule`（审阅 + hash、`--all` 矩阵、`__put`、repair）；`pi_schedules` 段及 `sessionScoped`；状态栏；digest（领取 + 文件证明）                                                                                                                      | `src/tools/schedule-tool.ts`、`src/commands/schedule.ts`、`src/sysprompt/{schedule-section,hub}.ts`、`src/prompt-sections/{stable-section,store}.ts`、`src/schedule/agent/digest.ts`                     | A0；S1                       | 3.0d  |
| **H1** hub 协调者             | reader 扫描（预算、代次）；投影（SSE + GET）；hub 调度状态；观察时钟；**`missedLog` 对账算法**与每小时合并；结果未知检测；`pendingReports` 发现交给 F1；回执回传；帧处理；装配                                                                                                                      | `src/web-hub/hub/schedule/**`、`src/web-hub/hub/{hub,agent-server,main,http}.ts`（各一处挂接）                                                                                                           | S0、S1                       | 3.0d  |
| **F1** 飞书                   | `scheduleReceipts`（state.ts schema，与 outbox 同一次 commit）；`pushScheduleReport`；`sch:` 结算回写与重启对账；通知预算与余量；**`NoticeBudget` 通道/预留接口**（安全告警改为 `lane:"critical"`）；`/schedule` 列表与立即运行；`sched_bound` 精确抑制                                             | `src/web-hub/hub/feishu/{state,service,render,router,inbound,notify,security}.ts`                                                                                                                        | S0；联调需 H1                | 3.25d |
| **W1** web                    | `SchedulePanel.vue`、`ScheduleReview.vue`、离线只读、徽标、`logic/schedule.js`、useHub 订阅                                                                                                                                                                                                         | `src/web-hub/ui/src/**`（schedule 相关）                                                                                                                                                                 | S0（可先用 mock）；联调需 H1 | 2.5d  |
| **I1** 集成、故障注入、一致性 | off golden；集成测试；故障注入矩阵；真实 pi 一致性测试 C-S1…C-S8；验收清单                                                                                                                                                                                                                          | `tests/integration/schedule*`、`tests/conformance/schedule.test.ts`、`tests/fixtures/schedule*`、`docs/dev/scheduled-reports/acceptance.md`                                                              | 全部                         | 4.5d  |

**合计约 29.75 人日**（r2 为 27.5，+2.25）。r3 的增量：

| 增量来源                        | 落在哪个包 | 人日  |
| ------------------------------- | ---------- | ----- |
| 待投递报告索引与回执回传        | S1、A1、H1 | +0.5  |
| `missedLog` 统一对账            | S1、H1     | +0.5  |
| 调度器能力门控与 `context` 复核 | A2         | +0.5  |
| 会话文件核验（取代分支扫描）    | S1、A1     | +0.25 |
| `NoticeBudget` 通道             | F1         | +0.25 |
| 新增一致性测试 C-S7/C-S8        | I1         | +0.5  |
| 各项相互抵消的零碎改动          | —          | −0.25 |

**施工顺序**（同期交付，只调整内部先后）：

1. 第 1–2 天：S0。
2. 第 2–6 天：S1（4d）；W1 先用 mock 开工。
3. 第 6–8 天：A0、H1、F1、W1 并行。
4. 第 8–11.5 天：A1、A2、A3 并行。
5. 第 11.5–16 天：I1。

**关键路径**：S0 → S1 → A0 → A2 → I1 ≈ 1.5 + 4 + 2 + 3.5 + 4.5 = **15.5 天**（日历时间，3–4 路并行）。

**车道**：dev-flow L3。实施阶段评审的重点是以下几处：

- §4.4 sweep 截止规则；
- §4.5a/§4.5b 两种 claim；
- §6.2 授权与复核时序；
- §6.3 文件证明；
- §7.2 对账算法。

## 13. 待用户拍板

**无。** r2 新增的 N1（hub 恢复后补推 24h 内的报告）和 N2（自动触发的轮次最长 3600 秒，人工插话即解除上限）已由用户拍板，记录在 §0。

## 14. 测试与验收

### 单元测试

**cron 与时区**

- 两个 DST 方向：本地时间不存在 / 有歧义两种情况；
- once 过期；永不命中的表达式；预算截断；count 上限；
- 进程 tz 与任务 tz 不同时，计算结果相同。

**批准**

- create 之后执行 resume / run_now，被拒；
- pause → AI 修改 prompt → resume，任务仍不执行；
- 审阅期间被并发改版，返回 `E_REV`；
- update 写入内部字段，被拒。

**自动 claim**

- lost / missed(late) / overlap / fired 四种结果；
- 跨进程 pause 后，旧定时器被拦下；
- rev 冲突时重试。

**manual claim（R2-7）**

- 在**不落在 cron 命中分钟**的时刻立即运行，成功，且 `decidedThrough / firedTotal / missedTotal / missedLog` 前后完全不变，`manualTotal` +1；
- manual 与 auto 之间的任务级占位互斥；
- 相同 reqId 重放，结果幂等；
- 携带过期的 defHash，被拒。

**sweep 容差截止（R2-3）**

- 进程 A `armedSince ≤ T`，定时器拿锁偏晚（T+10s）；进程 B 在 T+5s 因为 rev 变化触发 sweep；断言 B 不裁决 T，A 最终执行 T；
- 会话在 T+30s 打开：T 在 T+61s 时由补充 sweep 判为 missed，不早于这个时间；
- once 任务在线时执行，离线时越过容差后判为错过。

**missedLog 对账（R2-2，具体数字）**

每小时一次的 cron，08:00 成功、09:00 错过（离线）、10:00 成功、11:00 与 12:00 错过（会话 12:30 打开时 sweep）：

1. store 中应有两条记录：`{(08:00,09:00], count 1}`；`{(10:00,12:00], count 2}`；`missedTotal = 3`；
2. hub 在 09:01:30 观察到 09:00，立即通知 1 次；
3. 对账时：第一条扣除观察，通知 0 次；第二条通知 2 次；
4. 总计通知 3 次，等于 `missedTotal`，且没有任何一次成功运行被计入。

在此基础上，再组合以下情形：先观察后 sweep、先 sweep 后观察、迟到 claim、hub 在中途重启、`missedLog` 截断（`totalAfter` 差值路径）、定义变更（`defHash` 不匹配的观察不扣减）。

**每小时合并（E1）**

- 同一任务一小时内出现 5 次待通知，只发 1 条，结转 4；
- 下一个整点立即发 1 条汇总；
- hub 重启后，结转数量能恢复。

**待投递报告索引（R2-1）**

- 一份需要推送的报告产生后，关闭该任务的飞书推送，再完成 25 次不需要推送的运行（runs 已轮转）；hub 在 23h 后恢复，仍能从索引发现这份报告并推送 1 次；
- 回执回传后，索引条目被移除；
- 24h 过期后，条目被清理，hub 跳过；
- 第 65 条到来时，最旧一条被丢弃，`droppedIndexCap` +1，下一次 digest 与飞书通知中带出提示；
- 被索引引用的报告文件不被 GC。

**终态映射（R2-6）**

- `completed / failed / timed_out / aborted` 四种状态各一例：分别断言 RunRecord 状态、reason（含 `stopCause`）、报告内容、note 状态与单调性；
- `refused` 与 `unknown(no-outcome)` 各一例；
- 穷尽 switch 的编译期断言。

**调度器（R2-4）**

- 静默期；占位互斥；fence 窗口；合并（merged）；孤儿 abort；D13；
- **已通过 `before_agent_start` 授权，但运行卡在 prepare（慢 handler 或压缩）超过 60s**：断言作废 token 并 `ctx.abort()`，进入 aborting，运行 settle 后记为 dropped 或 unknown，且之后的 `context` 复核拦下了首次模型调用；
- 3600s 上限触发 abort；人工插话后解除上限；
- 能力状态为 absent / unknown 时的降级，以及 unknown 状态 30min 后的降级。

**note / digest（R2-5）**

- quiet 消息在 streaming 期间滞留超过 10 分钟：同一进程不重发，空闲后核验文件找到该条，标为 written，**文件里只有 1 条**；
- triggerTurn 的消息：在 `message_start` 时核验文件，读不到（还没落盘）；`agent_settled` 之后核验，能读到；
- 原进程死亡且文件里确认缺失：新进程补发 1 次（noteId 不变）；
- 原进程仍存活：另一个进程不补发；
- 读取超过 16 MiB 时记为 unverified，不重发；
- 两个视图同时尝试领取，只有一个成功。

**其他**

- 故障注入（子进程夹具，在每个写入点 kill）：claim 写入前后、running 写入前、终态写入前、报告文件写入后但索引写入前、索引写入后。断言结果只可能是 missed / unknown / 未入索引（报告写入但未引用的文件会被 GC），绝不出现静默丢失。
- 恢复判定：持有者死亡、boot 变化、同进程旧 epoch、跨主机。
- reader 零写入；路径中某级祖先是指向 vault 的符号链接、属主不符、权限位不符，三种情况都判为 degraded。
- 回执：重复的 reportId 不再入队；`durable:false`；回执为 accepted 但 outbox 中已无对应组 ⇒ uncertain；hub 重启后重放不重复。
- `NoticeBudget`：三通道配额；不传 opts 时与旧行为字节一致；schedule 洪峰下 critical 仍能拿到额度。
- 预算隔离：64 个任务同时触发。
- 段：空段字节不变；fork 的 wire 前缀正确；scoped 段的序列化不影响其他段。
- 模式矩阵：print / json 不 arm 且能退出；`--no-session` 与子会话文件被拒。

### 集成测试

`tests/integration/schedule-*.test.ts`，组合为真实 hub 子进程 + fake-rpc-pi + fake 飞书。

| 编号 | 场景                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| SC1  | 本地模式下，两个进程打开同一会话，任务只执行一次                                             |
| SC2  | background 的 quiet 结果 + 飞书报告；回执回传后，索引条目被移除                              |
| SC3  | handoff：调度器触发主会话运行，done 通知被精确抑制                                           |
| SC4  | message：忙时排队、D13、人工抢先输入 ⇒ continued                                             |
| SC5  | 离线：hub 推「已错过」并按每任务每小时一条合并；打开会话后 digest 只出现一次，对账不重复推送 |
| SC6  | 运行中关闭会话：推送 unknown + digest                                                        |
| SC7  | hub 停机期间正常执行；hub 在 24h 内恢复后补推（N1 定案），归属会话关闭也补推；超过 24h 不推  |
| SC8  | 飞书 `/schedule run`：在线、离线、版本变化、ack 超时、重投递去重、非 cron 时刻运行不改变水位 |
| SC9  | gate 关闭时字节不变                                                                          |
| SC10 | vault 内路径被拒                                                                             |
| SC11 | web 审阅对话框 + hash CAS                                                                    |

### 真实 pi 一致性测试

`tests/conformance/schedule.test.ts`，与 C-X 系列同级，pi peer 升级前必须运行。

| 编号 | 断言                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-S1 | streaming 期间的 quiet custom message 会滞留在内存，本轮结束后才追加到会话文件；空闲时的 quiet 消息先追加、后发 `message_start`                                                |
| C-S2 | settled 期间的延迟触发与本调度器的静默期：不会出现双触发                                                                                                                       |
| C-S3 | `session_before_switch` / fork / tree 窗口下 fence 生效；旧 ctx 迟到的回调不起作用                                                                                             |
| C-S4 | 人工输入抢先 ⇒ 交接                                                                                                                                                            |
| C-S5 | 在 pre-start compaction 期间的授权与复核                                                                                                                                       |
| C-S6 | print 模式下没有 ref 定时器，能正常退出                                                                                                                                        |
| C-S7 | `context` 事件在 `before_agent_start` 处理器链和 pre-start 压缩之后、首次 provider 请求之前触发；在其中调用 `ctx.abort()`，provider 不会收到请求（用本地 Anthropic stub 验证） |
| C-S8 | `triggerTurn:true` 的 custom 消息在 `message_end` 扩展事件之后才落盘；union 触发形状中带 custom 的 details（pi ≥1.2）。legacy 形状下，能力状态判为 absent 并降级               |

### off golden

钉住以下内容：工具表、命令表、system prompt、HubConfig 不含该 key、不再写旧文件。现有的 fabric、consult、off 系列 golden 保持不变，**绝不重新生成**。

### 真机验收清单（`acceptance.md`）

1. 在 tmux 里的 TUI 执行 `/schedule add`，两分钟后触发。依次确认：状态栏变化 → fleet 中出现 `sched:` → 会话里出现 quiet 结果（不新开一轮）→ 手机收到报告卡片，长报告附 md。
2. 关闭 TUI，等它跨过触发点：飞书收到「已错过」；同一小时内再次错过，不会再收到消息，到下一个整点收到一条汇总；重新打开会话，digest 只出现一次，AI 能引用其中内容。
3. AI 用工具创建任务，状态栏出现 `pending 1`；在网页审阅对话框看到完整内容并批准。审阅期间如果有另一个终端改了 prompt，批准会被拒绝，要求重新审阅。
4. 对话进行中定时消息到点：不打断当前这一轮；settled 并过了静默期才执行；执行中途插话 ⇒ continued；若无人插话，到 60 分钟上限时自动中止。
5. 后台任务运行中执行 `/quit`：飞书推送「结果未知」；重开会话后 digest 中有记录。
6. 飞书 `/schedule` 能列出任务；对离线会话执行 `run`，回复不在线；在终端修改任务后再 `run`，回复「已修改」；在非 cron 时刻执行 `run`，能正常运行。
7. 关闭 web-hub（本地模式）：执行、去重、digest 都正常；随后启动 hub（24h 内），刚才的报告被补推。
8. 用 traffic.db 确认 system prompt 字节不变；fork 出的子会话没有父会话的任务段。

## 15. 风险

| #   | 风险                             | 缓解与残留                                                                                 |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | 同 uid 恶意模型绕过批准          | 能力边界已披露（§4.3），D4 只覆盖受控工具和命令面                                          |
| R2  | 同一会话被两个进程打开           | claim、digest、note 都有锁内领取，保证只执行一次；同一会话文件被两个进程写是 pi 自身的风险 |
| R3  | 用户以为会话关了也会执行         | 文案、段、工具结果都写明；错过时推送并在 digest 中提示                                     |
| R4  | 没有 hub ⇒ 不推「已错过」        | D9 已接受，digest 兜底                                                                     |
| R5  | 锁持有者无法证明已失效（跨主机） | M-T4：返回 `E_BUSY`，人工处理                                                              |
| R6  | 尾部段退化为 pointer             | 只放定义；每会话 ≤8 个任务                                                                 |
| R7  | 飞书报告可能重复或丢失           | 至多入队一次；`uncertain` 如实标注；不承诺 exactly-once                                    |
| R8  | 与 feishu-notify 重复卡片        | 已披露，不处理                                                                             |
| R9  | hub 配置由拉起它的 pi 决定       | `/webhub status` 显示 `sched on/off`                                                       |
| R10 | Intl 时区数据依赖 Node ICU       | Node ≥22 默认是 full-icu；tz 不被支持 ⇒ 创建时返回 `E_INVALID`                             |
| R11 | 通知至多一次                     | digest 是可靠通道；hub 通知只是提醒                                                        |

---

## §R1 评审处置（r1 → r2，gpt-6.1-sol，22 条）

| #   | 严重度  | 摘要                                                                 | 处置             | 理由                                                                                                                                                                                                                                                                                                                     | 落点                                                                                                             |
| --- | ------- | -------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 待确认任务可以经 resume / run_now 绕过；暂停后修改没有重新批准       | **采纳（简化）** | S2：批准 = `approval.hash === defHash`，`enabled` 与批准分离；所有执行入口在锁内检查「可执行」；AI 改执行字段 ⇒ hash 变化 ⇒ 批准自动失效，与启用 / 暂停无关；resume 不批准；update schema 禁止写内部字段                                                                                                                 | §4.1、§4.3、§4.5、§5.1                                                                                           |
| 2   | Blocker | claim 不校验最新状态 / 版本，与占位分离                              | **采纳（简化）** | S1：单文件锁内事务：重读最新定义 → 校验可执行与 occurrence → 任务级占位 → 建立 run → 推进水位，一次写完；锁外才 spawn；30s rev 轮询加 turn_start 及时 rearm，迟到的 rearm 也会被锁内校验拦下                                                                                                                             | §4.5                                                                                                             |
| 3   | Blocker | 先推进水位、后记运行意图，崩溃后静默吞掉                             | **采纳（简化）** | 水位推进与 `RunRecord(dispatching / queued)` 在同一次原子写里（单文件，不存在多文件顺序问题）；写入前崩溃 ⇒ 按 occurrence 语义判为 missed；写入后崩溃 ⇒ 恢复为 unknown；故障注入矩阵覆盖每个写入点                                                                                                                       | §4.5、§4.6、§14                                                                                                  |
| 4   | Blocker | 飞书 outbox 结算后删除记录，不能长期去重                             | **采纳（简化）** | S3：只由 hub 投递；`scheduleReceipts` 存在飞书 state.json 中，与 outbox 组同一次 commit，TTL 7 天，大于 24h 投递窗口；重启对账：`accepted` 而 outbox 中无组 ⇒ `uncertain`；语义写明「至多一次入队 + 窗口内去重发送」，不承诺 exactly-once；agent 不再需要 ack                                                            | §7.1                                                                                                             |
| 5   | Major   | 网页确认框不展示正文；批准没有绑定版本                               | 采纳             | 专用 `ScheduleReview.vue` 展示完整定义；approve / `__put` 带 hash，锁内 CAS；TUI 在确认前采样 hash；通用确认框只用于防误触；web 下不依赖 `ctx.ui.confirm`                                                                                                                                                                | §5.2、§5.6                                                                                                       |
| 6   | Major   | hub 的 `W<T` 判定与 agent 侧 missed 冲突，会漏推                     | 采纳             | 分离「已裁决水位」与累计且永不清零的 `missedTotal / lastMissedAt`；hub 自有 `notifiedThrough` 与小时桶，store 事实与观察时钟共用同一个上界；全排列测试                                                                                                                                                                   | §4.2、§5.5、§7.2                                                                                                 |
| 7   | Major   | 时钟跳变、启动容差、DST、时区语义缺失                                | 采纳             | tz 写进任务定义（所有参与者计算一致）；DST 取早偏移 / 跳过不存在时间（算法保证）；`armedSince` 边界，在线容差绝不用于离线补跑；once 过期必定记 missed；wall / monotonic 心跳检测偏移并全区间 sweep                                                                                                                       | §4.4                                                                                                             |
| 8   | Major   | 定时消息缺少占位、fence、归属与 deadline                             | 采纳             | 实现最小调度状态机：进程级占位、与 RootWake / xs 互斥、`createSessionFence` 实例、静默期规避 settled 期间的延迟触发、用 message_start 绑定与合并、孤儿 abort、`runMaxS` deadline 与人工交接；真实 pi 一致性测试 C-S2…C-S5                                                                                                | §6.2、§13-N2、§14                                                                                                |
| 9   | Major   | quiet 消息的 sendMessage 返回不等于已写入；notifier 提前标 delivered | **采纳（简化）** | S4：定时运行设置 `suppressDelivery`，不进入 notifier；执行器自发结果消息，以 `message_start` 为写入证明；stack 构建时扫分支补投，锁内领取；digest 同样走领取与证明；不改全局 notifier                                                                                                                                    | §6.3、§5.5                                                                                                       |
| 10  | Major   | SpawnRequest 契约引用错误；scheduleOrigin 的贯通路径不完整           | **采纳（简化）** | 改用真实字段映射（`type`、`modelOverride`、`thinkingOverride`、`consultExperts`、`budgetOverride`、`timeoutPolicy`）；consult 先显式 `resolveExperts`，失败时降级并标注；去掉 `scheduleOrigin`，改用现有的 `suppressDelivery` 与 `callerOwned`（threading 中已分类），reducer / journal / threading / 异常通知兜底零改动 | §2.2、§6.1                                                                                                       |
| 11  | Major   | 报告挂钩没有覆盖所有终态；onReaped 会多次回调；旧 stack 迟到回调     | 采纳             | 唯一的业务终态入口 = `spawn()` 拒绝或 `waitOutcome` 结果（终态映射表含准入失败）；物理 reap 只作为证据；终态单调（首次写入胜出，迟到的只写 `lateOutcome`）；holder 加 `epoch`，已 dispose 的执行器只能写本 sid 的文件，不碰 ctx                                                                                          | §4.6、§6.1                                                                                                       |
| 12  | Major   | fork 会复制报告 outbox 和段快照                                      | 采纳（部分简化） | 报告不再存在会话条目里（S3），状态文件按 sid 存储，fork 天然不继承；段新增 `sessionScoped`，sid 不同则丢弃快照（只影响 scoped 段）；wire 前缀测试                                                                                                                                                                        | §3.3、§5.3                                                                                                       |
| 13  | Major   | print / json、`--no-session`、子会话文件的策略未定义                 | 采纳             | 模式矩阵：只在交互式 TUI / RPC 且有持久化文件的主会话中执行；print / json 不 arm；`--no-session` 拒绝创建；独立打开的子会话文件通过头标记识别并拒绝（不只依赖 `HOST_KEY`）                                                                                                                                               | §3.3、§7.6                                                                                                       |
| 14  | Major   | 断线重发与「未连通记 n/a」矛盾；Null / Hub 切换状态不统一            | **采纳（简化）** | S3：交付意图只有一份（state.json 中的 `report:"wanted"` 加报告文件），hub 是唯一投递者；NullCoordinator 不持久化任何东西；区分永久未配置、暂时断连、已接管、飞书终态四类状态；会话关闭不影响补推（hub 读文件）                                                                                                           | §7.1、§10.1                                                                                                      |
| 15  | Major   | 飞书立即运行缺少绑定、去重、deadline、unknown 处理                   | 采纳             | `sched_run` 携带 sessionId、defHash、expiresAt；reqId 取飞书确定性 cmdId；agent 侧 `manualReqs` 持久台账，锁内领取；10s 等待，超时回复「未确认」，不自动重发；手动 runKey 由 reqId 派生                                                                                                                                  | §4.5、§7.4                                                                                                       |
| 16  | Major   | done 抑制用时间窗，无法证明归属                                      | 采纳             | `sched_bound` 在 message_start 时同步发送，同一 socket 的顺序保证它落在该运行之内；`p.sched` 只作用于本运行；出现人工输入即清除；缺帧时保守发送                                                                                                                                                                          | §7.5                                                                                                             |
| 17  | Major   | 飞书生产端预算与资源预留不足                                         | 采纳             | 报告、通知分别设生产配额；上传并发 1；outbox 与 state 余量门槛；安全告警与审批的预留；溢出计数与面板可见；洪峰隔离测试                                                                                                                                                                                                   | §7.3、§14                                                                                                        |
| 18  | Major   | cron、扫描、存储缺少计算与 IO 预算                                   | 采纳             | cron 改为按字段枚举，视野 400 天、候选 5 万次、count 上限 1 万，计算在锁外；hub 扫描 single-flight、2s deadline、IO 台账 2 并发、代次屏蔽；报告按单份、每会话、全局分别限字节与份数，并定义回收职责                                                                                                                      | §4.4、§4.7、§7.6                                                                                                 |
| 19  | Major   | 只读 reader 与损坏备份混在一起；vault 路径校验不足                   | 采纳             | 纯只读 reader（零写入并有测试）；`.bak` 只在 agent writer 中做；逐级 `O_DIRECTORY                                                                                                                                                                                                                                        | O_NOFOLLOW`、fstat 属主与模式、字面与 canonical 双重 vault 检查、dev/ino 固定；所有执行点调用 `assertExecutable` | §7.6、§11 |
| 20  | Major   | 分包遗漏真实共享文件；验收缺少故障窗口                               | 采纳             | 每个共享文件只有一个写入包：messages.ts、ports.ts 归 S0；agent/index.ts 归 A0；feishu state.ts 归 F1；threading / journal 因简化不再需要改动。补充故障注入矩阵与真实 pi 一致性 C-S1…C-S6；重新估工                                                                                                                       | §12、§14                                                                                                         |
| 21  | Minor   | 已拍板项仍列为待定；`--all` 不完整                                   | 采纳             | §0 收录 E1–E3 为定案，删除 `feishuMissed` 设置（固定行为）；`--all` 的允许 / 禁止矩阵写全（禁止 `run --all` 与 `edit --all`）；HubConfig 只传真正需要的字段                                                                                                                                                              | §0、§5.2、§10.3                                                                                                  |
| 22  | Minor   | D4 的能力边界                                                        | 采纳             | 写明 D4 是受控工具和命令面上的批准流程，不对抗同 uid 且持有 write / bash 的恶意模型；如有需要另立权限隔离方案                                                                                                                                                                                                            | §4.3、§11、R1                                                                                                    |

---

## §R2 复审处置（r2 → r3，主会话裁定，dev-flow 第三轮）

复审结果：原 22 条里 15 条已闭合，处置维持不变；本节处理未闭合的 1 Blocker + 6 Major + 1 Minor + 1 Nit，全部采纳。

| #    | 严重度                         | 摘要                                                                                           | 裁定 / 处置 | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                     | 落点                                       |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| R2-1 | Blocker（新，关联旧 #14 / N1） | 报告发现依赖 runs，每任务只保留 20 条终态，导致丢失索引                                        | 采纳        | 新增独立的 `pendingReports` 待投递报告索引（不受 runs 条数上限约束），与终态在同一次原子写中提交。条目在两种情况下移除：hub 回执经 `sched_receipts` 回传确认，或 24h 过期。上限 64 条/会话；超限时**不拒绝新运行**（否则飞书积压会阻断定时任务本身），改为丢弃最旧一条，记 `droppedIndexCap`，并在 digest 和飞书通知里告知。被索引引用的报告文件不回收。hub 只读这份索引                                                                 | §4.2、§4.2.1、§4.7、§7.1、§7.2、§10.1、§14 |
| R2-2 | Major（旧 #6）                 | `missedTotal` 差额与区间枚举不是同一算法；每小时 2 条                                          | 采纳        | 以 `missedLog` 中每次错过裁决的记录作为唯一事实源：区间 `(from, to]` 内全部为未裁决的 occurrence，按构造不可能包含成功运行。agent 与 hub 共用同一个 `countOccurrences`。hub 对账公式为 `count − 匹配到的观察数`；截断时用 `totalAfter` 差值。合并改为**同一任务每小时一条**（E1）。测试用具体数字断言                                                                                                                                    | §4.2、§4.4、§7.2、§7.3、§14                |
| R2-3 | Major（旧 #7）                 | sweep 会抢先把仍在在线容差窗口内的 occurrence 判为错过                                         | 采纳        | sweep 的截止点 `cut = now − tol`，只裁决 `T ≤ cut` 的 occurrence。仍在容差内的交给定时器，或在 `T + tol + 1s` 再补一次 sweep。sweep 与 claim 共用同一套 eligible 规则。补充竞争测试                                                                                                                                                                                                                                                      | §4.4、§14                                  |
| R2-4 | Major（旧 #8 / N2）            | 未 bound 超时只作废 token，不终止已进入 prepare 的运行；孤儿检查时序未定义；旧 pi 缺少相应能力 | 采纳        | 区分 authorized 与 bound。启动超时时，若已授权但还没有进入首次模型调用，则 `ctx.abort()`，进入 aborting，等 settle 后再定终态。在每次模型调用前（`context` 事件）复核 token，覆盖「`before_agent_start` 授权钩子已经过去」的情况。四个检查点（授权、复核、启动超时、运行上限）的时序逐条写清。能力门控复用 `getXsHostCapability()` 的形状证据：absent 时禁用并提示，unknown 时排队，30min 后降级。N2 定为固定 3600s。新增一致性测试 C-S7 | §6.2、§10.3、§14                           |
| R2-5 | Major（旧 #9）                 | quiet 消息在内存中滞留时会被重发；`message_start` 不能证明已落盘                               | 采纳        | **唯一证明来源是会话文件中带 `noteId` 的 entry**，有界读取（从发送前记录的 offset 开始，≤16 MiB）。同一进程内永不重发（原消息可能还在 pi 的内存队列里，`/reload` 后仍可能写入）。只有在原持有进程已死，且读文件确认缺失时，才由新进程用同一 `noteId` 重发一次；handoff 只补写一条 quiet recap，不重新触发运行。digest 用同样的证明规则。新增一致性测试 C-S8                                                                              | §5.5、§6.3、§14                            |
| R2-6 | Major（旧 #11）                | 终态映射与真实 `RunOutcome` 不符                                                               | 采纳        | 映射改为真实的四态 `completed / failed / timed_out / aborted`（`core/types.ts:1227`）；`stopCause`（`:36`）、`timeoutReason`、`error.kind` 只作为 reason。先判断 `BoundedWaitResult`，再读 outcome。用穷尽 switch 收口。RunRecord 的状态集合同步修改                                                                                                                                                                                     | §4.2、§6.1、§14                            |
| R2-7 | Major（旧 #15）                | manual 套用了 occurrence 判定和自动水位                                                        | 采纳        | 拆成独立的 §4.5b manual claim：跳过 occurrence 判定、`armedSince`、`decidedThrough`、`firedTotal`、`missedLog`；保留批准哈希（含调用方携带的 defHash）、reqId 台账、owner / 在线 / 模式检查、任务级占位。单独计 `manualTotal`。验收断言：非 cron 时刻也能运行，且水位不变                                                                                                                                                                | §4.2、§4.5b、§7.4、§14                     |
| N-1  | Minor（新）                    | `NoticeBudget` 缺少优先级和预留接口；F1 文件域未包含 security.ts                               | 采纳        | `reserve(key, gapMs, opts?: {lane})` 增加 `critical / normal / schedule` 三个通道，并新增 `remaining()`。schedule 通道必须为关键通道留出每分钟 5 条余量。不传 opts 时与旧行为字节一致，安全告警改为显式传 `lane: "critical"`。security.ts 加入 F1 文件域                                                                                                                                                                                 | §7.3、§12/F1                               |
| N-2  | Nit（新）                      | N1 / N2 仍标为待定，SC7 带条件                                                                 | 采纳        | §0 增加 N1 / N2 定案；§13 改为「无」；`message.runMaxS` 改为固定的 3600（不再作为设置项）；SC7 与真机验收第 7 条改为无条件                                                                                                                                                                                                                                                                                                               | §0、§10.3、§13、§14                        |

**工时**：27.5 → 约 29.75 人日（+2.25）；关键路径 14 → 约 15.5 天。
