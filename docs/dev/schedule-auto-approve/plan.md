# schedule-auto-approve · 实施计划（r2：彻底移除批准概念）

> **拍板（2026-11-04 用户令，项目记忆 `schedule-auto-approve` #1/#2/#4/#5）**
>
> 1. **彻底移除定时任务的批准概念**：AI 或用户创建、修改的任务都**立即可执行**。删除人工 approve/reject、confirm offer、TUI 确认框、Web 审阅/批准 UI、飞书确认卡，以及相关命令、文案和测试。
> 2. **存量待批准任务不处理**：本机 3 个任务里 0 个待批准。旧批准代码不再维护兼容，只保证旧账本**能读、不坏**。
> 3. **保留并继续做**：Todo 与定时任务的聚合展示（detail 面板 + 输入框左上角聚合按钮，分区显示）；运行实例跳到 fleet/subagent 详情，不混进 todo；保留暂停/删除。
>
> r1（`approval.auto` 自动批准方案）**作废**。r1 的 P3（`src/web-hub/ui/src/logic/schedule.js`，已提交 9110b7bb）可以复用，但要去掉对 pending 的展示依赖（见 §6-W1）。
>
> 调查日期 2026-11-04，只读，本文件是唯一产出。前置阅读：`AGENTS.md`、`docs/dev/scheduled-reports/README.md`、`docs/dev/todo-web/README.md`、`docs/dev/feishu-bot/README.md`「#61」两节。

---

## 0. 范围

**做**

- **执行门**：`isExecutable ⇔ enabled`。所有入口（timer、sweep、manual/`run_now`、Feishu `sched_run`、message dispatch 发送 CAS）都不再看 approval。
- **删批准链**：`approveTask` / `rejectTask`、`/schedule approve|reject`、confirm 模块（TUI 框、`sched_offers` 生产、`sched_decide` 消费）、hub offer 投影、飞书审批卡、Web 审阅/批准/拒绝 UI、offer 自动弹窗、AgentCard 的 `⏰!` 待确认徽标、状态栏 `pending n`、`pi_schedules` 段的 `pending` 标记、工具和命令里的批准文案。
- **删 `/schedule __put` 子命令**（用户拍板，2026-11-04）：`put()` handler、`PUT_KEYS`、文件头冻结契约与 USAGE 行、`FEISHU_REFUSED` 条目、command-policy 的 allow 分支（⇒ `default: deny`），以及随之变成死参数的 `ops.ts` `CreateOpts.expectHash` / `UpdateOpts.{baseHash,expectHash,approveReviewed,onBase}`。
- **兼容**：旧账本里的 `approval` 字段照常读取和校验，新代码不读它做任何决策，也不写它。wire 侧只停止生产，保留容忍解析（I10）。
- **可视化**：TasksPanel（detail）+ composer 聚合 chip。run 行可跳 fleet。在 detail 和 SchedulePanel 上可暂停/继续/删除。

**不做**

- 存量 pending 任务的迁移或通知（用户令）。
- 删除 wire 帧的 schema 或常量（I10 只能追加）。
- `defHash` 规则改动：删掉 `__put` 之后 `defHash` 仍用于 `occ.defHash` 换定义作废、`sched_run` 帧的 `defHash` CAS 与 run 绑定（`dispatch.stillAuthorized`）；只是不再有「表单加载 hash / 审阅绑定」这条死路径。
- 跨会话总览，以及新增设置键。
- cron 最小间隔限制（见 §5 残留，列为可选后续）。

---

## 1. 现状要点（文件级证据）

| 关注点                      | 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 现状                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行门                      | `src/schedule/core/spec.ts:389-401`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `isApproved ⇔ approval.hash === defHash`；`isExecutable ⇔ enabled ∧ isApproved`；另有 `isPendingApproval`                                                         |
| 门的消费者（agent）         | `core/claim.ts:140`（autoClaim）、`:281`（manualClaim `E_UNAPPROVED`）、`:394-405`（changeTask 的 `!wasExecutable && isExecutable` 作废 backlog）、`core/occurrence.ts:173`（planSweep）、`agent/clock.ts:190`、`agent/dispatch.ts:772`（stillAuthorized `!isApproved`）、`agent/status.ts:39/68`、`agent/view.ts:32/68`、`sysprompt/schedule-section.ts:28`、`tools/schedule-tool.ts:331/351`、`commands/schedule.ts:241/340/621/762`                                                                                                     | —                                                                                                                                                                 |
| 门的消费者（hub）           | `hub/schedule/project.ts:94-100`（`executable`/`pendingApproval`/`offer`）、`hub/schedule/service.ts:403`（offer 可见性）、`:839/:883`（observePass/armObserve 只看可执行任务）、`:1034`（飞书卡 ledger 证据）、`:1136`（Feishu `/schedule` 行 `approved`）                                                                                                                                                                                                                                                                                | hub 直接 import 共享的 `spec.ts`，改门的语义 hub 会自动跟随                                                                                                       |
| 批准写入                    | `core/claim.ts:436-500`（approveTask/rejectTask）、`agent/ops.ts`（user create 写 approval；user edit 条件重批；`approveReviewed`；`onBase`；`expectHash`/`baseHash` 仅 `__put` 调用）                                                                                                                                                                                                                                                                                                                                                     | 工作区里还有未提交的 r1 改动（AI 写 `auto:true`），见 §3                                                                                                          |
| 账本读取                    | `core/reader.ts:111-116`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | approval 存在时严格校验 `hash/by/via/at`，**不检查未知键**。`manualReqs[].refused` 是任意 ≤128 字符串（`:252`）⇒ 旧账本里残留的 `refused:"E_UNAPPROVED"` 照常可读 |
| confirm 模块                | `agent/confirm.ts`（592 行）、`agent/surface.ts:83-105`（为它注册的 `input`/`before_agent_start`/`ui_prompt_start`/`ui_prompt_end` 四个转发钩子 + `agent_settled` 里的 `onAgentSettled`）、`agent/coordinator.ts`（`offers`/`confirmReady`/`onSchedDecide`）、`agent/wire.ts:213/318/339/505`、`src/index.ts:575-609`（三处 `confirm:` 参数）、`web-hub/agent/index.ts:1370-1378`（`confirmReady`）、`:1708`（caps 推 `SCHED_CONFIRM_CAP`）、`web-hub/agent/connection.ts:777`（`sched_decide` 分派）                                      | —                                                                                                                                                                 |
| wire                        | `web-hub/protocol/schedule.ts:86-107`（`ScheduleApproval`、`approval?`）、`:204-266`（`SCHED_CONFIRM_*`、offers/decide 帧类型）、`:315-374`（schema 在 decode 表里）、`:422-437`（投影必填 `executable`、`pendingApproval`；可选 `offer?`）                                                                                                                                                                                                                                                                                                | 投影把整个 `task`（含 `approval`）透传给 UI                                                                                                                       |
| hub 帧路由                  | `web-hub/hub/agent-server.ts:281-290`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `sched_offers`/`sched_decide_ack` 进 `deps.schedule.onAgentFrame`。**该文件处在 fabric #14 的脏区**                                                               |
| hub cap                     | `web-hub/hub/assembly-channels.ts:215`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `[SCHED_HUB_CAP, SCHED_CONFIRM_CAP]`。**该文件处在 fabric #14 的脏区**                                                                                            |
| 对端 cap 门                 | hub `service.ts:450`（收 offers 要求 agent caps ∋ confirm）、`:1077`（发 `sched_decide` 要求 agent caps ∋ confirm）；agent `index.ts:1378`（offers 要求 hub caps ∋ confirm）                                                                                                                                                                                                                                                                                                                                                               | 两端都由 cap 守门 ⇒ 任一端不再声明，就零新帧（#61 原设计已验证这一点）                                                                                            |
| 飞书                        | `hub/feishu/schedule-confirm.ts`（692 行）、`hub/feishu/service.ts:64/391/416-417/805/896-948/1020-1040/1081/1689/1925/1943/2089/2290/2306/2364-2366`、`hub/feishu/schedule.ts:122-178`（Offer/Decide 类型、`approved` 行字段）、`:601-605`（「待批准」）、`:632`（`not-approved` 回复）                                                                                                                                                                                                                                                   | 未知 nonce action 会落进 `inboundIntent` 的 else-if 链，被静默忽略（`service.ts:1723-1782`）                                                                      |
| web 命令策略                | `web-hub/agent/command-policy.ts:150-185`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `approve/reject <id> <hash>` = allow；`__put <json> <hash>` = allow；pause/resume/rm/run = confirm。r2 删掉这三条 ⇒ 落 `default: deny`                            |
| `__put`                     | `commands/schedule.ts:55-63/814-880`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 是 web 表单的 hash 绑定写入，**当前 UI 没有任何调用方**（`SchedulePanel.vue:9-12` 明说 W1 不做）。批准语义只在 `approveReviewed` 里；r2 随批准概念一起整体删除    |
| Web UI                      | `ScheduleReview.vue`（审阅 + 批准 + 拒绝，同时也是只读的完整定义视图）、`SchedulePanel.vue`（`initialReviewTaskId`、pending 计数）、`DetailHeader.vue:400-470`（offer 自动弹窗 + `pwh_sched_offer_seen` 存储键）、`AgentCard.vue:265-383`（`⏰!`）、`logic/schedule.js`（`offerOf`/`approveArgs`/`rejectArgs`/`scheduleBadgeOf.pending`/`panelView.pendingApproval\|executable\|pendingCount`/`taskRowsOf.pendingApproval`/`schedSummaryOf.pending`）、`i18n/schedule-extra.ts:33-126/217-232`、`i18n/{en,zh}/agents.ts schedBadgePending` | TasksPanel 和 composer 聚合尚未实现（工作区没有 UI 改动）                                                                                                         |
| activate-trace（B 级）      | `tests/fixtures/governance/activate-trace.json` 的 `max`、`thread-main` 画像                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 含 surface 的 `on(input)`、`on(before_agent_start)`、`on(ui_prompt_start)`、`on(ui_prompt_end)`（#61 C1 刷入），删除 confirm 后这四条会消失                       |
| schedule-off golden（A 级） | `tests/fixtures/schedule-off-golden.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 关闭时只有 orphan guard，与 confirm 无关 ⇒ **必须不变**                                                                                                           |

---

## 2. 决策（实施时不再开问；需要用户拍板的只列在 §11）

### D1 执行门

- `spec.ts`：`isExecutable(task) = task.enabled`。注释改为「approval 已移除（schedule-auto-approve r2），旧账本里的 `approval` 字段被容忍并忽略」。
- `claim.ts` manualClaim 删除 `if (!isApproved(task)) return refuse("E_UNAPPROVED")`。
- `dispatch.ts` stillAuthorized 删除 `|| !isApproved(t)`，其余条件（defHash 绑定、handoff、enabled / once 例外）不动。
- `changeTask` 的 `(!wasExecutable && isExecutable)` 分支保留：它现在只在 `resume`（enabled false→true）时触发，语义与今天的 resume 一致，作废暂停期间的 backlog。
- `SCHEDULE_ERROR_CODES` **保留** `"E_UNAPPROVED"`，加注释「legacy，不再产生；旧账本的 manualReqs replay 可能回放它」。理由：manualReqs 的 replay 返回 `prior.refused`，删掉 union 成员后类型会窄化，而真实字符串仍可能出现。

### D2 账本：`approval` 只读不写、不删、不迁移

- 新代码在任何路径都**不写** `task.approval`（AI/user create、AI/user update），也**不剥离**已有的 `approval`（不做迁移写）。
- `reader.ts` **恢复到 HEAD**（丢弃 r1 的 `auto` 软检查）：approval 若存在仍按旧规则严格校验。之前合法的账本都由旧代码写出，不会因此 degraded；新代码不写 approval，也不会产生新的非法值。旧 reader 本来就不检查未知键，所以本地开发期可能写进账本的 `auto:true` 照样能通过。
- `ScheduleApproval` 类型和 `ScheduleTask.approval?` 保留，标 `@deprecated legacy — ignored, never written`。
- 已否决的 **B 方案「兼容戳」**（新代码继续写 `approval={hash,by:"user",…}`，让旧 hub 和回滚后的旧 agent 认为任务已批准）。否决理由：
  1. 这等于把批准概念换个名字留在账本里，和用户令「彻底移除」矛盾；
  2. 给 AI 写入的任务盖 `by:"user"` 是虚假记录；
  3. 回滚后 fail-closed（新任务变待批准）在安全上更可取；
  4. 旧 hub 共存只是 `/reload` 到 `/webhub restart` 之间的短窗口（见 §4）。

  如果用户更看重「回滚后任务继续跑」，见 §11-Q1。

### D3 wire（I10：只停产、不删除、容忍解析）

- `ScheduleTaskProjectionWire.executable` / `pendingApproval` 是必填字段，**保留**。新 hub 输出 `executable = task.enabled`（经新的 `isExecutable`），`pendingApproval = false`（常量）。旧 UI（缓存的标签页）读到 false，就不显示待确认或审阅按钮，不会坏。
- `offer?`：不再生产。字段和 JSDoc 保留，标 deprecated。
- `task`（含旧 `approval`）照旧整体透传，hub 不剥离字段（剥离是 wire 形状变化）。
- `SCHED_CONFIRM_CAP`、`SCHED_CONFIRM_*` 常量、`SchedOffers/Decide/DecideAck` 类型与 schema，以及它们在 `SCHED_AGENT_FRAME_SCHEMAS` / `SCHED_HUB_FRAME_SCHEMAS` 里的条目，**全部保留**并标 deprecated（「不再生产；保留是为了容忍旧对端的帧」）。`tests/web-hub/protocol/schedule-confirm.test.ts` 保留，它继续钉住 decode 契约。
- **cap 停止声明**：
  - agent 侧：`web-hub/agent/index.ts:1708` 去掉 `SCHED_CONFIRM_CAP`（`SCHED_AGENT_CAPS` 不变）。该文件处在 fabric #14 脏区，**A 不碰它**，与 `:1370-1378` 的 `confirmReady` 一起交 F 包（见 §6-F/§7）。F 之前 agent 仍声明这个 cap，但 A 已删掉 offer 生产者 ⇒ 零新帧。
  - hub 侧：`assembly-channels.ts:215` 去掉 `SCHED_CONFIRM_CAP`。该文件同在 fabric #14 脏区，**必须等 fabric #14 提交后**由 F 包改（见 §7）。在此之前即使 hub 仍声明这个 cap，新 agent 也不发 offers；旧 agent 发来的 offers 会被新 hub 丢弃（见下条），无害。
- **容忍旧帧**：
  - 新 hub 的 `service.onAgentFrame` 收到 `sched_offers` / `sched_decide_ack` 时，只 `counters.offersDropped++` 然后丢弃，不投影、不发卡。`agent-server.ts` 的路由**不改**，避开 fabric #14 冲突。
  - 新 agent 的 `coordinator.onSchedDecide` 保留为存根：对未过期的帧恰好回一个 `sched_decide_ack{result:"refused", reason:"unsupported"}`，守住「每帧恰好一个 ack」契约。对端 cap 门（hub `service.ts:1077`）保证这个分支在正常情况下不可达。`connection.ts:777` 不改。

### D4 command policy 与命令面

- `/schedule approve|reject` 子命令删除（不在 `SUBS` 里 ⇒「未知子命令」）。
- `/schedule __put` 子命令**整体删除**（用户拍板，2026-11-04）：
  - `commands/schedule.ts`：删 `put()` handler 与 `PUT_KEYS`、文件头「`__put` contract (frozen here…)」整段、`SUBS`/分派分支、USAGE 行、`FEISHU_REFUSED` 里的 `"__put"`，以及 `PREVIEW`/`OK <id> defHash=…` 回执与 `E_REV` 文案。
  - `ops.ts`：删 `CreateOpts.expectHash`、`UpdateOpts.{baseHash,expectHash,approveReviewed,onBase}`（唯一调用方就是 `__put`）及其在 create/update 里的 CAS 与重批分支；create/update 不再接受任何 hash 参数。
  - 理由：它是 web 审阅表单的 hash 绑定写入，**当前 UI 没有任何调用方**（`SchedulePanel.vue:9-12` 明说 W1 不做），批准语义又全部集中在 `approveReviewed`；审阅/批准 UI 一走它就是死代码 + 一条 allow 命令面。
  - `defHash` 本身**不删**：`occ.defHash` 换定义作废、`sched_run` 帧的 `defHash` CAS、run 绑定（`dispatch.stillAuthorized`）继续用它。
- `command-policy.ts`：删除 `approve` / `reject` 两个 case **和 `__put` 的 allow 分支**（连同其 JSON/空格解析），三条都落到 `default: deny`；头注释同步。这是**收紧**方向：旧 UI 缓存页误发的 `approve` / `__put` 会被 policy deny，不会执行。
- `FEISHU_REFUSED` 去掉 `approve`、`reject`、`__put` 三项（已是未知子命令）。
- `pause/resume/rm/run` 的 policy 维持 `confirm`（通用防误点，与批准无关）。

### D5 TUI 与提示文案

- 不再有确认框（confirm 模块删除）。
- 工具 create/update 成功后，用 `ctx.ui.notify` 发一行（保留 r1 的 `notifyActive`，try/catch 包住，print/RPC 下静默）：「定时任务 s_x「name」已创建/更新并启用，下次运行 …」。
- 状态栏去掉 `pending n`。
- `pi_schedules` 段：去掉 `pending` 标记，文案改为「They run only while this session is open. Tasks you create or change take effect immediately; the user can pause or delete them at any time.」（不出现 approve / auto-approved 字样）。
- 工具描述（冻结在缓存前缀里）**有意改一次**，提交信息里声明：

  > IMPORTANT: tasks you create or change take effect immediately and keep running on schedule until paused or deleted. Only create or change a scheduled task when the user asked for it, and tell the user the task id and its next run.

  这句同时承担安全补偿，见 §5。`promptGuidelines` 同步修改。

### D6 Web IA（聚合部分沿用 r1 D6，去掉 pending）

- detail：新建 `TasksPanel.vue`，取代 `TodoPanel.vue` 的挂载点。summary 合并显示（`Tasks 3/8 · ⏰ 2`），展开后分「待办」「定时任务」两区。定时分区每行显示：名称 · when · 下次运行 · 状态 chip（`paused` / `running`）· 最近 run（有 `runId` 时可点 ⇒ `hub.selectRun`）· 暂停/继续/删除（`runCommand` 走 confirm 策略；离线或只读时隐藏）。尾部的「详情 »」打开 SchedulePanel。
- SchedulePanel 保留（历史与完整定义）。`ScheduleReview.vue` 用 `git mv` 改名为 `ScheduleTaskDetail.vue`，只保留只读的完整定义，删除批准、拒绝、hash 提示和 offer 相关的一切。
- composer：单个 chip 分两段，`✓{open}` 与 `⏰{count}`（有 live run 时图标旋转）。展开后两区，定时区只读。`queueAbove` 时隐藏的规则不变。
- AgentCard ⏰ 徽标只显示计数，`!` 变体删除。

### D7 回滚语义（文档化，不写代码）

整体 revert 本特性提交后：

- 升级期间**新建或修改**的任务在账本里没有匹配的 approval ⇒ 旧代码判为 pending ⇒ 不执行，直到用户 `/schedule approve`（旧代码里有这个命令）。这是 fail-closed。
- 升级前已批准、之后没改过的任务，approval 仍然匹配（D2 不剥离）⇒ 照常执行。
- 旧代码的 confirm 只在 AI 写入那一刻发 offer，不会为这些任务补弹窗；用户需要主动在终端 `/schedule list` 查看后批准。这一点写进 scheduled-reports README 的回滚说明。

### D8 存量 pending 任务（用户令：不考虑）

升级后，旧的 pending 任务如果 enabled，会**直接变为可执行**。它待批准期间 sweep 没有推进 `decidedThrough`，所以首轮 sweep 会把那段时间的 occurrence 记为 missed，并在 digest 里出现一次（有界：`CHANGE_BACKLOG_ROUNDS`/chunk 上限、missedLog 有上限）。本机 0 个 pending，不做处理，只在 README 里写明「升级前可先 `/schedule list` 确认，不想要的 pending 任务先 rm 或 pause」。

---

## 3. 工作区未提交的 r1 改动：逐项处置

> 工作区同时有 fabric #14、Jev 的脏文件。**禁止** `git stash` / `git checkout .` / `git reset`。只允许对下表中的精确路径执行 `git restore --source=HEAD -- <path>`，或手工编辑。

| 文件                                                                                                                        | r1 改动                                                                                                | 处置                                                                                                                                                                                                                                              | 归属包 |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/web-hub/protocol/schedule.ts`                                                                                          | `ScheduleApproval.auto?`                                                                               | **丢弃**（restore HEAD），之后按 D3 加 deprecated JSDoc                                                                                                                                                                                           | H      |
| `src/schedule/core/reader.ts`                                                                                               | `auto` 软检查                                                                                          | **丢弃**（restore HEAD），D2                                                                                                                                                                                                                      | A      |
| `src/schedule/agent/ops.ts`                                                                                                 | AI create/update 写 `auto:true` 的 approval；改头注释                                                  | **丢弃**后按 §6-A 改写（不写 approval；删 `expectHash`/`baseHash`/`approveReviewed`/`onBase`）                                                                                                                                                    | A      |
| `src/schedule/agent/view.ts`                                                                                                | `· auto`                                                                                               | **丢弃**；按 §6-A 删除 approval 行和 `pending` flag                                                                                                                                                                                               | A      |
| `src/sysprompt/schedule-section.ts`                                                                                         | 文案里有「auto-approved」                                                                              | **改写**（D5 文案，去掉 pending 标记）                                                                                                                                                                                                            | A      |
| `src/tools/schedule-tool.ts`                                                                                                | 去掉 offer/onBase；加 `notifyActive`、`ACTIVE_NOTE`；`details.pending:false`；`confirm?` 标 deprecated | **部分保留**：保留去 offer/onBase 和 `notifyActive`；**改写**描述、snippet、guidelines、`ACTIVE_NOTE`（去掉「auto-approved」）；**删除** `PENDING_NOTE`、`E_UNAPPROVED` 提示、`statusNote` 的 pending 分支、`details.pending` 键、`confirm?` 依赖 | A      |
| `tests/schedule/core/reader.test.ts`                                                                                        | auto 三态用例                                                                                          | **改写**：旧 approval（含 `auto:true`/`auto:false`/任意未知键）都可读；无 approval 可读；畸形的旧 approval 仍拒绝（钉住 HEAD 行为）                                                                                                               | A      |
| `tests/schedule/agent/a3-helpers.ts`                                                                                        | `makeLegacyPending`                                                                                    | **保留**，改名 `stripApproval`，用于构造「无 approval 的旧账本」，证明它照样执行                                                                                                                                                                  | A      |
| `tests/schedule/agent/confirm.test.ts`                                                                                      | 包装器                                                                                                 | **丢弃**（整个文件删除）                                                                                                                                                                                                                          | A      |
| `tests/schedule/agent/{ops,status,surface}.test.ts`、`tests/tools/schedule-tool.test.ts`、`tests/commands/schedule.test.ts` | 按 auto 语义改的断言                                                                                   | **改写**为 r2 语义（§6-A）                                                                                                                                                                                                                        | A      |
| `docs/dev/schedule-auto-approve/preview.html`（未跟踪）                                                                     | r1 的 UI 预览                                                                                          | 不动；W2 可参考，但要去掉 pending chip                                                                                                                                                                                                            | —      |

---

## 4. 新旧混跑矩阵（agent × hub；Web UI 由 hub 提供，与 hub 同版本）

| 组合                    | 发生时机                                      | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 结论                                                                          |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 新 × 新                 | 目标态                                        | 门 = enabled；无 offer、无卡；UI 无待确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✓                                                                             |
| 新 agent × 旧 hub       | `/reload` 之后、`/webhub restart` 之前        | 新 agent 不声明 confirm cap ⇒ 旧 hub 不投影 offer、不发卡、不发 `sched_decide`（`service.ts:450/1077` 的 cap 门）。新任务没有 approval ⇒ 旧 hub 投影 `pendingApproval:true`，旧 UI 显示「待确认」和审阅按钮；点批准 ⇒ `/schedule approve …` ⇒ 新 agent 的 policy deny 或报未知子命令（无副作用）。旧 hub 的 Feishu `/schedule` 列表显示「待批准」，但 `/schedule run` ⇒ `sched_run` ⇒ 新 agent 照跑（agent 是唯一执行者）。旧 hub 的 observePass 跳过「不可执行」的新任务 ⇒ 会话离线期间漏掉 missed 的飞书提示 | 只有外观和提示降级，**任务照常执行**；README 写明「升级后 `/webhub restart`」 |
| 旧 agent × 新 hub       | `/webhub restart` 之后、旧会话 `/reload` 之前 | 新 hub 不声明 confirm cap（F 包落地后）⇒ 旧 agent 的 `confirmReady=false` ⇒ 只走 TUI（旧行为），零 offers 帧。即使 hub 仍声明（F 之前），旧 agent 发来的 offers 也会被新 hub 丢弃。新 hub 投影 `pendingApproval:false`、`executable=enabled` ⇒ 新 UI 把旧 agent 里的 pending 任务显示为「启用」，但旧 agent 仍要等 TUI 批准才执行；新 hub 的 observePass 可能为这类任务在离线时记 missed                                                                                                                       | 短窗口内的显示失真，`/reload` 即消除；可接受（残留 R3）                       |
| 旧 × 旧                 | —                                             | 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✓                                                                             |
| 回滚（revert）          | —                                             | 见 D7：升级期间新建或修改的任务 fail-closed 为 pending                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 文档化                                                                        |
| 旧浏览器缓存页 × 新 hub | 页面未刷新                                    | 新 hub 给 `pendingApproval:false`、无 `offer` ⇒ 不显示审阅/批准；残留的 `approve` 调用被 policy deny                                                                                                                                                                                                                                                                                                                                                                                                           | ✓                                                                             |
| 飞书上残留的旧审批卡    | 升级前 2 h 内发出过 offer                     | 新 hub 没有 `sched-ok/no` 处理器 ⇒ 点击后 nonce 被兑现，落进通用链并被静默忽略；nonce 按 TTL 过期                                                                                                                                                                                                                                                                                                                                                                                                              | 本机 0 pending，可接受（残留 R4）                                             |

---

## 5. 安全影响

- **失去的控制**：AI 写入的任务（含 `feishu:true` 推送、`background` 指定模型/thinking/timeout、`handoff` 唤醒会话）不再需要人工确认就会执行。这也意味着一次 prompt 注入可以借定时任务获得**跨回合的持久化**（任务在会话打开期间按 cron 持续运行）。属于用户已拍板的行为变更。
- **仍在的边界**（不变，验收要逐条确认）：
  - `schedule.enabled` 默认关，关时零表面（A 级 golden）；
  - 只有主会话有该工具，child 会话碰不到注册（I6）；
  - secure/locked 域强制关闭（D8/`E_SECURE`）；
  - 每会话最多 8 个任务；
  - 同一任务不重叠（`E_OVERLAP`/coalesced）；
  - bg 的 timeout 上限 14400 s，而且 spawn 仍过 quota/load 准入门；
  - message 派发走 fence、能力门、token 授权；
  - web 侧 `add/edit/--all/repair` 仍 deny；`approve`/`reject`/`__put` 由 allow 收紧为 deny（`__put` 子命令本身也删了）；
  - Feishu 入口仍不能修改任务（`FEISHU_REFUSED`）；
  - `pause`/`rm` 会撤销已排队的 run（`revokeTask` + `finishRun(dropped)`）；
  - hub 仍是只读协调者，不写账本。
- **补偿控制**（本计划交付）：
  - 工具描述和 guidelines 要求「只在用户要求时创建或修改，并告知 id 与下次运行时间」；
  - TUI 即时 notify；
  - 状态栏 `sched n · next …`；
  - `pi_schedules` 段让模型每轮都看得见；
  - Web TasksPanel/composer chip 让用户看得见，并能一键暂停或删除；
  - AgentCard ⏰ 计数。
- **攻击面减少**：删除了 `sched_decide` 消费路径、飞书审批卡的 owner 证明和 nonce 链、`approve`/`reject`/`__put` 的 web allow 规则（连同 `__put` 的 hash 绑定写入面），以及 confirm 的 UI-prompt 计数（#61 R1「pi 共用对话框槽」导致的 promise 泄漏和 dispatch 栅栏多算的问题随之消失）。
- **可选后续（不在本计划内）**：cron 最小间隔，或者 `feishu:true` 任务每小时的推送上限复核（E1 已有每小时预算）。

---

## 6. 分包（每包唯一 owner，文件域精确；包内 TDD；每包返回后派异源 verifier）

依赖图：`A ∥ H ∥ W1` → `W2` → `W3` → `F`（F 还要等 fabric #14 已提交）。A 与 H 共享 `spec.ts`，约定如下：**A 是 `spec.ts` 唯一 owner**，A 把 `isApproved`/`isPendingApproval` 标 `@deprecated` 但**保留导出**（H 合入前 hub 还在用）；F 在 grep 确认零调用方后删除它们。

**并行纪律（A/H/W1 同树并行）**：三包共用一个工作区。

- 只跑本包定向测试（`npx vitest run <本包涉及的目录>`），**不跑全量 `npm test`**（pitfalls-subagent #3）；全量由主会话在所有包收齐后串行跑一次（§8.1）。
- 每包返回时先 `git status --short` 核对改动全落在自己的文件域内；越界文件不自行删除，报给主会话裁定。
- 禁 `git stash` / `git checkout .` / `git reset`（含子 agent 自作主张的基线对照，pitfalls-git #2/#5）；需要基线用 `git show HEAD:<path>`。

### A — agent 侧移除批准（owner：Dev-A）

**改**

- `src/schedule/core/spec.ts`：按 D1 修改 `isExecutable`；`isApproved`/`isPendingApproval` 标 deprecated（agent 侧不再有调用方）；`SCHEDULE_ERROR_CODES` 注释 legacy `E_UNAPPROVED`；`ScheduleApproval`/`approval?` 标 deprecated。
- `src/schedule/core/claim.ts`：manualClaim 删除 `E_UNAPPROVED` 那行；**删除** `approveTask`、`rejectTask`、`RejectRevertTo`；更新 changeTask 头注释（删「Approval is NEVER touched here…」）。
- `src/schedule/core/reader.ts`：restore HEAD（§3）。
- `src/schedule/agent/ops.ts`：重写头注释（「No approval: every write takes effect immediately; `defHash` only binds runs/occ」）；createTask 删两条 approval 写入、删 `CreateOpts.expectHash` 及其 CAS；updateTask 删 `wasApproved`、全部 approval 写入、`UpdateOpts` 的 `baseHash`/`expectHash`/`approveReviewed`/`onBase` 及其 CAS/重批/基线观察回调；删除 `isApproved` import。
- `src/schedule/agent/dispatch.ts`：stillAuthorized 删 `!isApproved(t)`，同步更新注释。
- `src/schedule/agent/view.ts`：`taskFlags` 只剩 `paused`；`taskDetail` 删 approval 行，保留 `defHash:` 行。
- `src/schedule/agent/status.ts`：删 `pending n` 段。
- `src/sysprompt/schedule-section.ts`：按 D5；删 `isApproved` import。
- `src/tools/schedule-tool.ts`：按 §3 和 D5；删 `ScheduleToolDeps.confirm`；`statusNote` 只区分 paused 与 scheduled；`run_now` 删 `E_UNAPPROVED` 提示。
- `src/commands/schedule.ts`：删 `approve`/`reject`/`approveFlow`/`reject()`/`confirm` 依赖与 `ScheduleConfirm`/`approveTask` import；`SUBS`、`USAGE`、`SCHEDULE_COMMAND_DESCRIPTION`、`FEISHU_REFUSED`、文件头说明同步修改；`add` 回执改为「已创建并启用」；`edit` 回执改为「已修改」（不再出现「仍待确认」）；`resume` 回执与 `run` 拒绝映射删掉 pending 分支；`--all` 帮助行去掉 approve。**`__put` 按 D4 整体删除**：`put()` handler、`PUT_KEYS`、文件头契约段（`:55-64`）、`SUBS`/分派分支（`:419`）、USAGE 行、`FEISHU_REFUSED` 里的 `"__put"`、`ZERO_HASH`/`SCHED_HASH_RE`/`previewHash` 等只服务于它的局部。
- `src/web-hub/agent/command-policy.ts`：按 D4。
- **删除** `src/schedule/agent/confirm.ts`。
- `src/schedule/agent/surface.ts`：删 confirm 创建、`ScheduleSurface.confirm()`、`ConfirmCoordinatorPort`、`input`/`before_agent_start`/`ui_prompt_start`/`ui_prompt_end` 四个钩子，以及 `agent_settled` 里的 `confirm?.onAgentSettled()`（保留 `turn_start`、`agent_settled` 的 status/digest）。
- `src/schedule/agent/coordinator.ts`：删 `offers`/`confirmReady`/`confirm` 依赖；`onSchedDecide` 改为 D3 存根（refused `unsupported`，未过期的帧恰好回一个 ack，已过期的照旧处理）；改头注释。**`ScheduleLinkPort.confirmReady?()`（`:40`）暂时保留为 deprecated 可选成员**（实现不读它）——否则 A 就必须改 fabric #14 脏区里的 `web-hub/agent/index.ts:1376`；F 包连同 index.ts 一起删。
- `src/schedule/agent/wire.ts`：删 `confirm?` 选项透传（`:213/318/339/505`）。
- `src/index.ts`：删三处 `confirm:` 参数和 `ScheduleConfirm` import（仍是纯装配，I2）。
- **不改（fabric #14 脏区）**：`src/web-hub/agent/index.ts`、`src/web-hub/agent/connection.ts`。`confirmReady` 与 `SCHED_CONFIRM_CAP` 留在原处（由 `ScheduleLinkPort` 的可选成员兼容，零行为影响），全部交 F 包。

**测试**

- 删除：`tests/schedule/agent/confirm.test.ts`、`tests/integration/schedule-confirm.test.ts`。
- 改写：
  - `tests/schedule/core/{spec,claim,reader}.test.ts`：门 = enabled；删 approve/reject 用例；manual run 不再 `E_UNAPPROVED`；changeTask 的 resume 作废 backlog 仍成立。
  - `tests/schedule/agent/{ops,status,surface,coordinator,webhub-wiring,wire,clock,dispatch,message}.test.ts`：凡是断言「未批准 ⇒ 不执行/被拒」的改为「无 approval/stale approval ⇒ 照常执行」；webhub-wiring 的 `sched_decide` 用例改为「恰好一个 refused ack」。**hello caps 断言暂不改**（A 不碰 `web-hub/agent/index.ts`，hello 仍带 `sched.confirm.v1`），与 cap 断言一起留给 F。
  - `tests/schedule/agent/ops.test.ts`：删 `expectHash`/`baseHash`/`E_REV` 的参数用例（参数已不存在）。
  - `tests/tools/schedule-tool.test.ts`：描述与结果文本；details 只有 `{ok,id}`；notify；不写 approval。
  - `tests/commands/schedule.test.ts`：approve/reject ⇒ 未知子命令；**`__put` ⇒ 未知子命令、账本零写入**；show 不再有 approval 行；list 没有 pending。
  - `tests/sysprompt/schedule-section.test.ts`、`tests/web-hub/protocol/schedule-policy.test.ts`（approve/reject/`__put` ⇒ deny）。
  - `tests/web-hub/agent/command-capture-recorder.test.ts` 的「D1 regression」：`/schedule approve` 不复存在，改用一个合成命令 `ctx.ui.confirm(title, message)`，钉住「observed ui 仍把第二参数原样送达」。
  - `tests/integration/schedule-wiring.test.ts`：去掉 `approve` 步骤，「AI 创建 ⇒ 立即可 run」。
  - `tests/integration/schedule-surface-wiring.test.ts`：钩子差分去掉 #61 的 +1 input、+1 before_agent_start、+1 ui_prompt_start、+1 ui_prompt_end；工具结果 details、状态栏 `sched 1`（无 pending）、段落正则去掉 `· pending`。
  - `tests/integration/schedule-hub.test.ts`：只改注释（`create → approve` 改为 `create`）；`approve()` fixture 继续使用（它构造的是带旧 approval 的账本，正好证明容忍）。
- 新增用例：
  - AI/user create 后账本里的 task **没有** `approval` 键；
  - 带旧 approval（匹配、stale、`auto:true`）的任务在 pause/resume/update 之后 approval 原样保留，执行不受影响；
  - `stripApproval` 构造的旧账本任务被 timer/sweep/manual 正常 claim；
  - 旧账本里 `manualReqs.refused:"E_UNAPPROVED"` 的 replay 不崩；
  - `/schedule __put {…} <hash>` ⇒ 未知子命令，账本文件的 mtime/content 不变。
- **governance（B 级，声明刷新）**：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`。预期 diff **只有** `max`、`thread-main` 两个画像里 schedule 段删掉四条：`on(input)`、`on(before_agent_start)`、`on(ui_prompt_start)`、`on(ui_prompt_end)`。逐行核对 diff，任何额外变化都视为越界。提交信息写明原因（删除 #61 confirm presenter 的转发钩子）。
- **不得变**：`tests/fixtures/schedule-off-golden.json` 及其他 A 级文件。conformance `tests/conformance/schedule.test.ts` C-S1…C-S8 跑一遍，应保持绿（它用 `tests/schedule/core/fixtures.ts` 的 `approve()` 辅助构造函数写旧 approval 字段）。该 fixture **保留但不 import `isApproved`/`isPendingApproval`**（它只写账本数据），否则 F 包删导出时会断，grep 门禁也会误报。

**提交建议**：`feat(schedule): run created and edited tasks without user approval`。正文写明移除 `/schedule approve|reject`、TUI 确认框、工具描述有意变更、activate-trace 的 B 级刷新。是否加 `!` 见 §11-Q2。

### H — hub / 飞书 / 协议（owner：Dev-H；与 A 并行，文件不相交）

**改**

- `src/web-hub/protocol/schedule.ts`：先 restore HEAD（丢弃 `auto`），再只加 JSDoc：
  - `ScheduleApproval`/`approval?`：legacy，被忽略；
  - `executable`：「= `task.enabled` since r2」；
  - `pendingApproval`：「legacy, always false since r2; kept required for old UIs」；
  - `offer?`、`SCHED_CONFIRM_*`、offers/decide 帧：「no longer produced; schemas stay for tolerant decode」；
  - `SchedRunFrame` 注释去掉「and the approval hash」。

  **不删任何导出和 schema 条目。**

- `src/web-hub/hub/schedule/project.ts`：`pendingApproval: false`；`executable: isExecutable(task)`（语义随 A 改变；H 先落地时，项目内过渡期 hub 显示为「enabled∧approved」，A 合入后自动变为 enabled）；删 `offer` 投影和 `ProjectDeps.offerOf`；删 `isPendingApproval` import。
- `src/web-hub/hub/schedule/service.ts`：删 #61 offers 段（`offersBySid`、`offersOnline`、`offerOf`、visible/announce、`offersSeen`、`sched_decide` 等待器与 `decide`）；**删 `extras` 里的 `ledgerTask` 实现（`:1026-1039`）与 `offersSeen` 实现（唯一消费者是 schedule-confirm）**，以及只服务于它们的 `scannedAt`/`degradedSessions`/`isApproved` import；`onAgentFrame` 的 `sched_offers`/`sched_decide_ack` ⇒ `offersDropped++` 后丢弃；Feishu 行删 `approved`（`:1136`）；counters 只留 `offersDropped`（不是 wire，`rg` 确认只在本文件和测试里使用）；删 `SCHED_CONFIRM_CAP` import。
- `src/web-hub/hub/schedule/feishu-port.ts`：删 `offersChanged?`、`ScheduleDelivery` 里的 offer 接线、`ledgerTask` 与 `ScheduleLedgerEvidence`、`offersSeen` 与 `ScheduleOffersSeen`、`HubScheduleExtras`（两个成员都删后整接口无意义）、offers/decide 成员的类型导出。
- `src/web-hub/hub/feishu/schedule.ts`：删 `FeishuScheduleOfferRow`/`FeishuScheduleOfferClosed`/`ScheduleDecideRequest`/`ScheduleDecideResult`、`FeishuScheduleRow.approved`；列表 flag 改为「启用 / 已暂停」；`next` 改为 `enabled` 时显示；`scheduleRunReply` 删 `not-approved`/`pending-approval` 映射（旧 agent 回的 `E_UNAPPROVED` 走通用的「拒绝运行：E_UNAPPROVED」）。
- **删除** `src/web-hub/hub/feishu/schedule-confirm.ts`。
- `src/web-hub/hub/feishu/service.ts`：删 `createFeishuScheduleConfirm` 与 `scheduleConfirm` 的全部接线（§1 列出的行）、`emit` 里的 `sched-ok/no` 分支、`install()` 的 `oldScheduleAnchors`、`offersChanged` 接线、runtime 字段。
- **不改**：`agent-server.ts`（fabric 脏区，路由保持即可）、`assembly-channels.ts`（留给 F）。

**测试**

- 删除：`tests/web-hub/hub/schedule-confirm-hub.test.ts`（内含 `ledgerTask`/`offersSeen` 的整组断言，随实现一起删）、`tests/web-hub/hub/feishu/schedule-confirm.test.ts`；`tests/integration/web-hub-feishu-bot.test.ts` 的「#61 I2」describe 块，以及它专用的 helper/配置（`:177` 注释处）。
- 改写：`tests/web-hub/hub/{schedule-project,schedule-service,schedule-frames,schedule-f1}.test.ts`、`tests/web-hub/hub/feishu/{schedule-service,schedule-router,service,state}.test.ts` 中的 approved/offer 断言、`tests/web-hub/hub/schedule/http-stub.ts`。
- 保留：`tests/web-hub/protocol/schedule-confirm.test.ts`（decode 契约）。
- 新增：
  - 旧账本（无 approval / stale / 匹配）⇒ `pendingApproval:false`、`executable===enabled`，投影里没有 `offer`；
  - 旧 agent 发来 `sched_offers`/`sched_decide_ack` ⇒ 被丢弃、计数、无投影、无卡、不抛错；
  - Feishu `/schedule` 列表在任何状态下都不出现「待批准」；
  - 一个 `sched-ok` nonce 的卡片回调 ⇒ 静默无副作用（不发 `sched_decide`）。

**提交建议**：`refactor(web-hub): drop schedule approval projection and Feishu approval cards`。

### W1 — Web：移除审阅/批准 UI，清理 logic（owner：Dev-W；与 A/H 并行）

- `src/web-hub/ui/src/logic/schedule.js`：
  - 删 `offerOf`、`approveArgs`、`rejectArgs`、`shortHash`（确认无其他调用方）；
  - `scheduleBadgeOf` 返回 `{ count }`；
  - `panelView` 删 `executable`、`pendingApproval`、`defHash`、`pendingCount`；
  - `taskRowsOf` 删 `pendingApproval`；
  - `schedSummaryOf` 返回 `{ count, live }`；
  - 头注释去掉 ScheduleReview/approve；
  - **继续忽略**线上的 `pendingApproval`、`executable`、`offer`、`task.approval`。
- `components/schedule/ScheduleReview.vue` 用 `git mv` 改名为 `ScheduleTaskDetail.vue`：只读的完整定义（prompt 纯文本、when/tz、form、bg、feishu）；删 `useTrackedCommand`、`CommandConfirm`、批准/拒绝按钮、hash 提示、`fromOffer`、`decided`。
- `components/schedule/SchedulePanel.vue`：删 `initialReviewTaskId` 与 offer 打开路径、pending chip、pendingCount 横幅；「审阅」改为「详情」；类型镜像同步。
- `components/detail/DetailHeader.vue`：删 `:400-470` 的 offer 自动弹窗、`pwh_sched_offer_seen` 键、`offerOf` import、`:initial-review-task-id` 绑定。
- `components/agents/AgentCard.vue`：删 `data-pending` 与 `!`。删 `i18n/{en,zh}/agents.ts` 的 `schedBadgePending`。
- `i18n/schedule-extra.ts`：删 taskPending、taskExecutable、review、reviewHashNote、approve*、reject*、offer*；`reviewTitle` 改为 `detailTitle`。en/zh 保持 parity。
- `styles/schedule.css`（以及 agents 样式里 `chip-sched[data-pending]`）：删除对应样式。
- 测试：
  - `tests/web-hub/ui/{schedule-logic,schedule-panel,schedule-state,detail-header,agent-list}.test.ts`、`tests/web-hub/ui/fixtures/schedule.ts`：fixture 里**保留** `pendingApproval:true`、`offer` 等旧字段作为输入，断言 UI 忽略它们（旧 hub 兼容）；
  - offer 弹窗用例删除；
  - i18n parity、source-scan 照常绿。
- 门禁：`npx vitest run tests/web-hub/ui/ tests/commands/`（pitfalls-runtime #7）、`npm run build:web && npm run check:web`。

**提交建议**：`refactor(web-hub): remove schedule review and approval UI`。

### W2 — Web：detail 聚合 TasksPanel（owner：Dev-W；依赖 W1）

- 新建 `components/schedule/ScheduleRows.vue`：纯展示的行组件。props：`rows`、`compact`、`canWrite`；emit：`pause`/`resume`/`remove`/`open-run`/`open-detail`。样式放进 `styles/schedule.css`（不允许用 `<style>` 块）。
- 新建 `components/detail/TasksPanel.vue`：合并 summary 加两个分区；todo 分区**原样搬迁** `TodoPanel.vue` 的 markup 与折叠尾行逻辑；定时分区用 ScheduleRows；emit `open-schedule`。
- `DetailHeader.vue`：`<TodoPanel v-if="agent.todo">`（`:1071`）改为 `<TasksPanel>`，渲染条件为「todo 非空 或 `schedSummaryOf(...)` 有值」；写命令走 `view.control.runCommand(agentKey, "schedule", "pause|resume|rm <id>", { confirm: true })`；`open-run` ⇒ `hub.selectRun(agentKey, runId)`（先例 `FleetDrawer.vue:440`）；`open-schedule` ⇒ `schedOpen = true`。
- 删除 `TodoPanel.vue`；`tests/web-hub/ui/todo-panel.test.ts` 改写为 `tasks-panel.test.ts`，覆盖：todo 分区回归、定时分区、两区都空 ⇒ 不渲染、任一区有值 ⇒ 渲染、离线 ⇒ 没有操作按钮、旧 wire 没有 `runId` ⇒ 不出链接。
- `SchedulePanel.vue`：run 行在有 `runId` 时可跳 fleet；任务行补暂停/继续/删除（`canWrite` 门）。
- i18n：`i18n/{en,zh}/detail.ts` 加入 TasksPanel 文案（紧凑标记用英文 token，prose 可以用中文）。
- `docs/dev/todo-web/README.md`：补一段 TodoPanel 到 TasksPanel 的数据流（这一包里改）。

### W3 — Web：composer 聚合 chip（owner：Dev-W；依赖 W2，因为共享 `i18n/*/detail.ts`）

- `components/control/Composer.vue`：`schedWire = computed(() => schedSummaryOf(caps, schedules, sessionId))`；chip 增加 `⏰` 段（`composer-sched-btn`）；`todoChipOn` 改为 `chipOn = !queueAbove && (todoSeg || schedSeg)`；面板增加定时分区（ScheduleRows compact、只读）。只用 inject 已注入的 `CONTROL_VIEW`/`HUB_CTX`，**不动冻结的 ComposerProps/contracts**。
- `styles/composer-todo.css`：⏰ 段与分区样式。
- `tests/web-hub/ui/composer-todo.test.ts`：覆盖 gate、计数、live 旋转、`queueAbove` 联动、空态，以及只有定时没有 todo 的情况。

### F — 收尾（owner：主会话指派 Dev-A；**等 A、H、W3 合入，且 fabric #14 已提交**）

- `src/web-hub/hub/assembly-channels.ts:215`：去掉 `SCHED_CONFIRM_CAP`（改为 `[SCHED_HUB_CAP]`）；删掉不再使用的 import。同步更新 `tests/web-hub/hub/schedule-frames.test.ts` 等 hub caps 断言。
- `src/web-hub/agent/index.ts`（**A 因 fabric #14 脏区没碰它**，现在才改）：删 `bindLink` 的 `confirmReady`（`:1370-1378`）与 `SCHED_CONFIRM_CAP` import；caps 去掉 `SCHED_CONFIRM_CAP`（`:1708`）。`src/web-hub/agent/connection.ts` **不改**（`sched_decide` 分派保留；新 coordinator 存根保证恰好一个 ack）。同步改 `tests/schedule/agent/webhub-wiring.test.ts` 的 hello caps 断言（hello **不含** `sched.confirm.v1`）以及 agent caps 快照类断言。
- `src/schedule/agent/{coordinator,surface}.ts`：删除 deprecated 的 `ScheduleLinkPort.confirmReady?` 成员（此时零调用方）。
- `src/schedule/core/spec.ts`：`rg -n "isApproved|isPendingApproval" src tests` 为零后，删除这两个 deprecated 导出。
- 文档：
  - `docs/dev/scheduled-reports/README.md`：「当场确认 AI 创建/修改的任务（#61）」整节改为「已移除（schedule-auto-approve r2，2026-11-04）」短节，写明：wire 帧和 cap 常量保留（为了容忍解析）、混跑矩阵摘要、D7 回滚、D8 存量说明。「Approval = definition hash」段改写为「No approval: executable ⇔ enabled; defHash binds runs, occ and sched_run CAS」。门禁列表删掉 confirm 相关测试。
  - `docs/dev/feishu-bot/README.md`：`:44`、`:99`、`:175-182` 三处审批卡说明标注已移除。
  - `docs/dev/scheduled-reports/acceptance.md`：真机清单里的批准步骤同步修改（如果有）。
  - 本目录补 `acceptance.md`（验收记录）。
- 再跑一次 activate-trace 比对。如果 fabric #14 期间刷新过 trace，以合入后的 HEAD 为基线重刷，并且只允许出现 A 包声明过的那四条差异。

---

## 7. 冲突规避

- **fabric #14**（脏文件：`src/fabric/xs/receiver.ts`、`src/fabric/xs/stack.ts`、`src/fabric/xs/activation.ts`、`src/web-hub/agent/index.ts`、`src/web-hub/agent/connection.ts`、`src/web-hub/agent/xs.ts`、`src/web-hub/hub/agent-server.ts`、`src/web-hub/hub/assembly-channels.ts`、`src/web-hub/hub/audit.ts`、`src/web-hub/hub/xs/router.ts`、`src/commands/fabric-xs.ts`、`tests/web-hub/hub/xs-fixtures.ts`、`tests/commands/fabric-xs-progress.test.ts`、`tests/web-hub/hub/xs-*.test.ts`）：
  - 本计划**不碰** `agent-server.ts`（路由不改），也**不碰** `connection.ts`；
  - `src/web-hub/agent/index.ts` 也在脏区里（`confirmReady`/caps 两处就在该文件）⇒ **A 不碰它**，交 F 包在 fabric #14 提交后改；A 期间靠 `ScheduleLinkPort.confirmReady?` 可选成员维持编译与零行为差异。
  - `assembly-channels.ts` 只有 F 包的一行，**必须**等 fabric #14 提交之后；
  - `activate-trace.json` 两边都可能刷新，后合入的一方以 HEAD 为基线重刷，并核对只出现己方声明的差异。
- **Jev**（`src/memory/jev/*`、`docs/dev/memory/README.md`、`tests/memory/jev/*`）：无交集。
- **提交纪律**：每包用精确路径 `git add`（绝不 `-A`）；先跑 `git diff --quiet origin/dev -- tests/fixtures/`（A 的 trace 刷新是唯一允许的 fixtures 变化）；**整个任务完成后只 push 一次**。

---

## 8. 门禁（每包，以及最后的整体门禁）

1. `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web`。
2. `git diff origin/dev -- tests/fixtures/` 只能包含 `governance/activate-trace.json` 中声明的四条 × 两个画像；`schedule-off-golden.json` 字节不变。
3. 实际运行 `npx vitest run tests/commands/ tests/web-hub/ui/ tests/web-hub/agent/`（typecheck 盲区，pitfalls-runtime #7）。
4. `npx vitest run tests/conformance/schedule.test.ts`（C-S1…C-S8；C-S6 没有 tsx 时 skip）。
5. 残留 grep：

   ```sh
   rg -n "approveTask|rejectTask|isApproved|isPendingApproval|confirm\.js|ScheduleConfirm|offerOf|approveArgs|rejectArgs|schedule approve|approveReviewed|schedBadgePending|pwh_sched_offer_seen|createFeishuScheduleConfirm|PUT_KEYS|__put" src tests
   ```

   F 之后在 `src` **与** `tests` 都应为零。protocol 里的 `SCHED_CONFIRM_*`、offers schema 和 `ScheduleApproval` 允许保留，必须带 deprecated 注释。豁免：`tests/integration/schedule-hub.test.ts` 的 `approve()` fixture **名字**可以保留（它只是构造「带旧 approval 的账本」的辅助函数，正好证明容忍），但该文件不得 import `isApproved`/`isPendingApproval`，也不得把 `approve()` 接回执行门——否则 grep 门禁和语义都会复活依赖。

6. 兼容用例必须存在且为绿：
   - reader 容忍旧 approval（A）；
   - hub 丢弃旧 offers 帧（H）；
   - UI 忽略 `pendingApproval:true`、`offer`（W1）；
   - agent 回 `sched_decide` 存根 ack（A）。

---

## 9. 验收标准（用户可感知）

1. AI 用 `schedule` 工具 create/update 任意 form 的任务 ⇒ 工具结果明说「已生效、下次运行 …」；TUI 弹出 notify；到点真实触发（background 出 subagent run，message 进入会话）。**全程没有确认框、没有飞书卡片、没有 web 弹窗**；`run_now` 立即放行。
2. `/schedule` 帮助里没有 approve/reject/`__put`；`/schedule approve x` 与 `/schedule __put {…} <hash>` ⇒「未知子命令」，账本不变；web 侧对 `approve`/`reject`/`__put` 的 `runCommand` 一律 policy deny；`/schedule show` 里没有 approval 行；`/schedule list`、`pi_schedules` 段、状态栏都没有 `pending`。
3. 用户 `/schedule add`/`edit` ⇒ 立即生效；`pause`/`resume`/`rm` 行为不变（暂停期间不跑，恢复后作废暂停期间的 backlog，删除时撤销已排队的 run）。
4. Web：detail 头部一个面板同时看到待办分区和定时分区（下次运行、最近 run 状态）；暂停/删除按钮生效（带防误点确认）；点最近 run 进 fleet 的 run 详情；「详情 »」打开 SchedulePanel，看历史和完整定义；**任何地方都没有审阅、批准、拒绝、待确认**。
5. composer 左上角一个 chip 显示两段计数，hover/click 展开两个分区；steer/held 时整体隐藏。
6. 飞书 `/schedule` 列表里没有「待批准」；`/schedule run <n>` 对新任务直接运行。
7. 关闭 `schedule.enabled` ⇒ 与现状逐字节一致（off golden 绿）。
8. 升级步骤 `/reload` 然后 `/webhub restart`：中间窗口里任务照常执行（§4）。

---

## 10. 残留风险（接受）

- **R1 失去人工闸**：AI 写入后立即执行，prompt 注入可以借此持久化。补偿和边界见 §5；cron 最小间隔列为可选后续。
- **R2 回滚 fail-closed**：revert 后，升级期间新建或修改的任务变为 pending，需要 `/schedule approve`（D7）。
- **R3 混跑短窗口的显示失真**：旧 hub 显示「待确认」或漏掉离线 missed 提示；新 hub 把旧 agent 的 pending 任务显示为启用（§4）。`/reload` + `/webhub restart` 后消除。
- **R4 飞书残留审批卡**：点击后静默无效；nonce 按 TTL 过期（本机 0 pending）。
- **R5 存量 pending 任务**（用户令不处理）：升级即生效，首轮 sweep 把待批准期间的 occurrence 记为 missed，并在 digest 出现一次（D8）。
- **R6 账本里的 `approval` 化石字段永久留存**：它不进 `defHash`，没有任何读者；将来如果要剥离，需要单独做迁移（不在本计划）。
- **R7 deprecated 的 wire 常量和 schema 永久留存**（I10 的代价）。

---

## 11. 开放问题（主会话用 ask_user 向用户确认；推荐项排第一）

- **Q1 回滚语义**：
  - **(Recommended)** D2 方案：新代码不写 approval，回滚后升级期间的新任务 fail-closed 为待批准；
  - 备选：继续写一个对用户不可见的兼容戳，回滚后任务照跑。代价是账本里留着虚假的 `by:"user"` 批准记录，批准概念以数据形式残留。
- **Q2 提交是否标 BREAKING（`!`）**：
  - **(Recommended)** 不标：功能默认关闭，`/schedule approve` 删除后在 web 侧是收紧，影响面很小；
  - 备选：标 `feat(schedule)!:`。按发版规则，这会让下一次发版成为 major。

> Q3（`__put` 去留）已由用户拍板：**删除**（D4，2026-11-04）。
