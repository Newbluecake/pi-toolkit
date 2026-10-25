# A3 感知面包报告：定时任务（#32）

> 依据：`docs/dev/scheduled-reports/plan.md` r3 §12 A3 行，重点 §0（D4/E2 拍板）、§4.3（批准状态机）、§5.1/§5.2/§5.3/§5.4/§5.5、§3.3、§6.3、§14 A3 测试。
> 契约基线：S0 `ec4297b0`、S1 `47d07e95`、A0 `85961b04`。`spec.ts`、`protocol/schedule.ts`、S1 core、A0 的 `wire/clock/coordinator/mode.ts`、`command-policy.ts` **均未改**。
> 本包零 git 写操作；没有碰 A1（`bg/note/report-file`）、A2（`dispatch/message`）、H1（`web-hub/hub/**`）、secure 包的文件，也没有碰任何 fixture / golden / AGENTS.md。

## 1. 改动清单

| 文件                                      | 内容                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompt-sections/stable-section.ts`   | `SectionName` 加 `pi_schedules`                                                                                                                                                                                                                                                                                             |
| `src/prompt-sections/store.ts`            | `PersistedSectionV1.sid?`；`SectionScope`；`serializeSectionStates(states, scope?)` 只给 scoped 段写 `sid`；`readBackSectionStates(…, scope?)`：scoped 段 `sid` 不等于当前 sid / 缺 sid / 当前 sid 未知 ⇒ 初始态。无 scope 参数 ⇒ 字节同前                                                                                  |
| `src/sysprompt/hub.ts`                    | `SectionRegistration.sessionScoped?: true`；hub 在 `session_start` / `session_tree` / `before_agent_start` 记下当前 sid，`persist` / read-back 传 scope。无 scoped 段时 `scope()` 为 undefined，路径与改前一致                                                                                                              |
| `src/sysprompt/schedule-section.ts`（新） | `pi_schedules` 段：**只放定义**（id、名称、时间 + tz、形式、feishu、pending），无任务 ⇒ `""`；child / secure / ephemeral ⇒ `""`；读失败 ⇒ `SKIP`；按 sid + state.json 的 stat 做缓存                                                                                                                                        |
| `src/schedule/agent/view.ts`（新）        | 文本渲染（`whenText`、`taskLine`、`taskDetail`、`runLine`），工具 / 命令 / 段 / digest 共用                                                                                                                                                                                                                                 |
| `src/schedule/agent/ops.ts`（新）         | 工具与命令共用的任务操作：`resolveDef`（校验 + 合并）、`createTask`、`updateTask`、`setTaskEnabled`、`deleteTask`、`previewHash`。**批准规则集中在这里**（见 §2.1）                                                                                                                                                         |
| `src/tools/schedule-tool.ts`（新）        | `schedule` 工具：list/get/create/update/pause/resume/delete/run_now/history；冻结的描述与 schema（`additionalProperties:false`）；模式拒绝 `actionRefusal`；禁写字段运行时再拒一次                                                                                                                                          |
| `src/commands/schedule.ts`（新）          | `/schedule`：list/add/edit/show/log/approve/pause/resume/rm/run/repair + `--all` 矩阵 + `__put`（冻结契约，见 §2.3）+ 飞书硬拒 + 关闭时只回 `E_DISABLED`                                                                                                                                                                    |
| `src/schedule/agent/digest.ts`（新）      | 打开会话的 digest：纯函数 `computeDigest` / `deriveCoversAt` + 控制器（领取 `digest.inflight`、会话文件证明、跨进程判死、不重发）                                                                                                                                                                                           |
| `src/schedule/agent/status.ts`（新）      | 状态栏：`renderStatus`（英文 token）+ 控制器（变化才写、unref 的 15 s 定时器、dispose 清栏）                                                                                                                                                                                                                                |
| `src/schedule/agent/surface.ts`（新）     | 装配胶水 `wireScheduleSurface`：`opsPorts`、每会话 `start`（状态栏 + 在 `agent.start()` 之后跑 digest）、`shutdown`；注册 `turn_start`（刷新状态栏）与 `agent_settled`（刷新 + digest tick，5 s 节流）                                                                                                                      |
| `src/index.ts`（+38/−2）                  | `schedule.enabled` 时：建 surface、`registerTool(schedule)`、`promptHub.register("pi_schedules")`（排在 models 之后）；`/schedule` **总是**注册；`void stack.schedule?.start()` 换成 `void scheduleSurface?.start(ctx, stack.schedule)`；shutdown 里先 `scheduleSurface?.shutdown()` 再 `stack.schedule.shutdown()`。无逻辑 |
| `src/stack.ts`                            | **未改**（A0 已有 `scheduleWiring` 参数，A3 全部走 holder 晚绑定）                                                                                                                                                                                                                                                          |
| 测试（新）                                | `tests/prompt-sections/session-scoped.test.ts`、`tests/sysprompt/schedule-section.test.ts`、`tests/tools/schedule-tool.test.ts`、`tests/commands/schedule.test.ts`、`tests/schedule/agent/{ops,digest,status}.test.ts`、`tests/schedule/agent/a3-helpers.ts`、`tests/integration/schedule-surface-wiring.test.ts`           |

文件域说明：任务给出的独占域里没有 `ops/view/status/surface`。它们是**新文件**，名称不与 A1/A2 的 `bg/note/report-file/dispatch/message` 冲突；工具和命令必须共享校验和批准规则，状态栏 / 装配也需要落脚点，所以放在 `src/schedule/agent/`。

## 2. 关键设计

### 2.1 批准语义（S2，`ops.ts`）

| 来源 / 动作                         | 行为                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| AI create                           | 只写定义，**没有 approval** ⇒ 待确认                                                                                      |
| AI update 执行字段                  | 不碰 approval；`defHash` 变了，旧批准自然不匹配（无论启用还是暂停）；只改 name 不影响                                     |
| AI pause / resume / delete          | 允许；`resume` 只置 `enabled=true`，**不批准**                                                                            |
| AI run_now                          | 经 `agent.runNow`；未批准 ⇒ `E_UNAPPROVED`（工具文案带「待用户批准」提示）                                                |
| 用户 `add`                          | 写 `approval = defHash`                                                                                                   |
| 用户 `edit`                         | **仅当该任务编辑前已批准**才写新 hash；待确认的任务编辑后仍是待确认（见 §4 #1）                                           |
| `/schedule approve <id>`            | 展示完整定义 + hash，**在 `ctx.ui.confirm` 之前采样 hash**，确认后 `approveTask` 锁内 CAS；审阅期间被改 ⇒ `E_REV`、不批准 |
| `approve <id> <hash>`（网页对话框） | 不弹确认，直接 CAS；hash 不符 ⇒ `E_REV`                                                                                   |
| `__put`                             | 见 §2.3；是**已审阅写入**：create 即批准，edit 批准存储的定义                                                             |

工具层另有一道防线：`approval / createdBy / createdVia / createdAt / ownerCwd` 以及 create 时的 `id` 即使宿主没按 schema 拒绝，也会在 `execute` 里返回 `E_INVALID`。

### 2.2 `pi_schedules` 段与 `sessionScoped`

- 段内容不含下次运行时间、运行状态、暂停状态，所以时间推移不会改变它；创建任务后，冻结的系统提示不变，定义经 hub 的尾部 update message 出现（集成测试断言了「同一会话内 system prompt 字节不变」）。
- fork / new 出来的会话：hub 读回时 sid 不同 ⇒ 该段初始态，`pi_schedules` 为空段 ⇒ system prompt 字节不变；同 sid 的 resume / reload 逐字节恢复。
- scoped 段持久化条目多一个 `sid`；其他段的序列化字节不变（测试断言）。

### 2.3 `__put` 冻结契约（W1 报告要求 A3 冻结）

```
/schedule __put <json> <64位hex hash>
json = { id?, baseHash?, name, form, when:{kind:"cron",expr,tz}|{kind:"once",at,tz}, prompt, feishu?, bg? }
```

- `id` 缺省 ⇒ 创建（不得带 `baseHash`）；`id` 存在 ⇒ 编辑，**必须带 `baseHash`**（表单加载时的 `defHash`），与当前定义不符 ⇒ `E_REV`。
- 末尾 hash = 将要存储的定义的 `defHash`（创建时 ownerCwd 取本会话 cwd）。不符 ⇒ `E_REV`、**什么都不写**。
- **全零 hash = 预览**：不写入，回复首行 `PREVIEW defHash=<hash>`——浏览器在明文 LAN 上没有 `crypto.subtle`，靠它拿到要绑定的 hash，**不需要改 `command-policy.ts`**（全零是合法的 64 位 hex，`schedulePolicy` 照常 allow）。
- 成功回复 `OK <id> defHash=<hash>`；失败 `E_CODE: detail`。
- 未知字段、坏 JSON、坏 id、创建带 `baseHash` 都返回 `E_INVALID`。

### 2.4 `--all` 矩阵

`list/show/log/pause/resume/rm/approve --all` 允许（持目标会话的账本锁写入，`approve` 同样走审阅 + hash CAS；resume 不批准）；`edit/run/add/repair --all` 拒绝。同一任务 id 出现在多个会话 ⇒ 歧义拒绝、不写。写其他会话账本需要 `agent.self`（`/proc` 身份），否则 `E_UNSUPPORTED`。

### 2.5 digest

- 触发条件：某任务 `missedTotal > shownMissedTotal`；有新的 `unknown/dropped/refused` 终态 run（`endedAt > shownRunsThrough`）；`reportStats.lastDroppedAt > shownRunsThrough`。
- 发送：锁内写 `digest.inflight`（含会话文件大小）→ quiet 的 `subagent:schedule` 消息（`details.kind="digest"`、`digestId`、`covers`、`triggerTurn:false`）+ `ctx.ui.notify`。
- 水位只在**会话文件里读到该 entry** 之后推进：同进程只在空闲时核验、永不重发；活着的他人持有者 ⇒ 尊重其领取；持有者已判死 ⇒ 先读文件：找到 ⇒ 只推进水位（covers 由 `deriveCoversAt` 按领取时刻推导）、确认缺失 ⇒ 重新领取并重发、`too-large` ⇒ 推进水位不重发。
- `missedTotal` 不清零；`tick()`（`agent_settled`）只核验、不产生新 digest。

## 3. 与方案的偏差及处理

| #   | 方案                                                    | 实际                                                                                                                                                                                                         | 理由                                                                                                                                                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §4.3 表：用户 update 执行字段 ⇒ `approval = 新 hash`    | 仅当任务**编辑前已批准**才重新批准；待确认任务（典型：AI 创建、用户没审阅过）被用户改一个字段后仍待确认                                                                                                      | 否则用户用 `--cron` 改一下时间，就会把 AI 写的、从未审阅的 prompt 一并批准，绕过 D4/S2。`__put` 因为对话框展示了完整内容且 hash 绑定，才批准                                      |
| 2   | §1「命令表字节不变」                                    | 初版在关闭时也注册 `/schedule`（只回 `E_DISABLED`）                                                                                                                                                          | **已由主会话更正**：`registerCommand` 挪进 `scheduleSurface` 分支，关闭时命令表字节不变；OFF 集成用例改为断言命令不存在。`createScheduleCommand` 内的 `E_DISABLED` 分支保留为防御 |
| 3   | §5.2/§7.4 web `run` 以 cmdId 作 reqId                   | 命令里 `run` 用随机 reqId                                                                                                                                                                                    | 命令处理函数拿不到 cmdId（capture 层没暴露）；web 命令账本本身已按 cmdId 幂等。`agent.runNow` 的 reqId 台账对飞书 / hub 路径照常工作                                              |
| 4   | §5.5 `reportStats.droppedIndexCap` 增加 ⇒ 生成 digest   | 用 `reportStats.lastDroppedAt > digest.shownRunsThrough` 判断                                                                                                                                                | S0 冻结的 `DigestState` 没有「已展示的 droppedIndexCap」字段；时间戳水位等价且不动契约                                                                                            |
| 5   | S1 建议的 `noteAnchor/digest.inflight.anchor`           | 同进程核验用内存里的 `FileAnchor`；跨进程核验走 offset 0 全量扫描（≤16 MiB，超出 ⇒ 不重发）                                                                                                                  | S0 未加字段（S1 报告已记）                                                                                                                                                        |
| 6   | §5.1 ephemeral：`create` 返回 `E_EPHEMERAL`，其余视为空 | 命令面里 ephemeral 的非读子命令（pause/rm…）也统一回 `E_EPHEMERAL`（工具面遵循 §3.3 原样）                                                                                                                   | 该会话本来就不可能有任务，简化了命令面                                                                                                                                            |
| 7   | §5.2 `add` 「分步输入，或一行参数」                     | 一行参数 + 缺项时 `ctx.ui.input` 逐项补问（名称 / 时间 / prompt）；form/feishu 等高级项只能用 flag                                                                                                           | web 策略对 `add/edit` 是 deny，终端分步只服务本地                                                                                                                                 |
| 8   | §5.4 `msg off` 提示「只提示一次 `ctx.ui.notify`」       | 状态栏只加 `· msg off` / `· msg ?` 标记；一次性 notify 留给 A2（能力降级的产生方）                                                                                                                           | 降级发生在调度器，A3 没有那个事件                                                                                                                                                 |
| 9   | TDD 纪律                                                | sessionScoped、ops 批准规则、`approve` 的 CAS、digest 证明，以及 `--all`/`__put` 门禁是**先写测试看红再实现**（sessionScoped）或**写完后做撤销验证**（其余）；工具 / 状态栏 / 段的测试是实现后补的，如实披露 | —                                                                                                                                                                                 |

## 4. 撤销验证（临时改回实现，跑测试，再还原）

| 被验证的行为                     | 临时改动                                   | 结果                                                               |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| scoped 段读回校验 sid            | `foreign = false`                          | `session-scoped` 2 条失败（store 读回、hub fork 的 wire 前缀）     |
| 用户 edit 不批准待确认任务       | 去掉 `wasApproved &&`                      | 1 条失败（USER edit 那条）                                         |
| 任何 edit 都重新批准（AI 也能）  | 去掉 `origin.by === "user" && wasApproved` | 3 条失败（AI 改执行字段失效、pause→改→resume 仍不执行、user edit） |
| approve 的 hash 在确认**前**采样 | 改成确认后重新读 hash                      | 1 条失败（审阅期间被改 ⇒ E_REV）                                   |
| `edit --all` 被拒                | 放开                                       | 1 条失败                                                           |
| `__put` 全零预览                 | 去掉预览分支                               | 3 条失败                                                           |
| digest 水位只认文件证明          | 发送后立刻 `advance`                       | 2 条失败                                                           |
| digest 尊重他人活着的领取        | 去掉 busy 判断和 `liveness` 判断           | 1 条失败（两视图）                                                 |

## 5. 自验

| 命令                                                                                                                                                                                                                                                                                                                                                                | 结果                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/schedule tests/sysprompt tests/prompt-sections tests/tools tests/commands --maxWorkers=3`                                                                                                                                                                                                                                                     | 本包新增测试全部通过；整体仅见两处**非本包**的偶发失败：A1 施工中的 `tests/schedule/agent/bg.test.ts`，以及 S1 的 `session-proof` / `fault-injection`（负载下偶发，单跑 3/3 通过，A0 报告 §7 已记） |
| off golden：`fabric-xs-off` / `fabric-wake-off` / `fabric-xs-reply-off` / `external-disabled-bytes` / `compact-dynamic-off` / `merged-plugins-wiring` / `entry-loader` / `web-hub-disabled` / `command-policy` / `real-command-matrix` / `web-hub/boundary` / `secure/off-golden` / `secure/guard-points` / `memory/legacy-golden` + 新增 `schedule-surface-wiring` | 15 个文件 144 passed；`tests/fixtures/**` **零改动**，没有任何 off 测试变红，不需要「显式关闭正交特性」处理                                                                                         |
| `npx tsc --noEmit -p tsconfig.json`（过滤 `web-hub/hub/schedule`）                                                                                                                                                                                                                                                                                                  | 无输出（通过）；`tsconfig.typecheck.json` 对本包新增的源码 / 测试文件也 0 错误                                                                                                                      |
| `npx prettier --check`（全部改动文件）                                                                                                                                                                                                                                                                                                                              | 通过                                                                                                                                                                                                |
| 全量 `npx vitest run --maxWorkers=3`                                                                                                                                                                                                                                                                                                                                | 见主会话汇总（本报告写作时仍在跑；结果附在回复里）                                                                                                                                                  |

## 6. 遗留与提示

- **未做真机验收**（TUI 状态栏、`confirm` 对话框观感、web `__put` 往返）：属于 I1 的 `acceptance.md` / 真机清单。
- **W1 的「首期只有批准」**：`__put` 契约已冻结，W1 后续包可直接接表单；预览往返用全零 hash，不需要改 policy。
- **AGENTS.md** 的 `src/schedule/`、`/schedule`、`pi_schedules` 描述按约定留给 I1。
- `/schedule` 的 `getArgumentCompletions` 只补子命令名（纯函数、无 IO）；任务 id 补全需要读账本，没做（slash-arg 规则要求补全函数是纯的）。
- 状态栏的 `busy` 来自 `clock.status().degraded` 或账本不可读；跨主机锁持有者是否一定映射到 `degraded` 取决于 A0 的 clock，没有端到端用例。
- `run` 的幂等性（飞书 / 网页重投递）由 hub 与 command ledger 保证，命令内没有再做一层 cmdId 台账（偏差 #3）。
- 工具 / 命令输出文案：工具结果英文（面向模型），命令输出中文（面向用户），状态栏英文 token——符合 AGENTS.md 的 UI 语言分工。
