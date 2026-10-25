# S0 契约包报告 — 定时任务 + 飞书主动推送（#32）

> 依据：`docs/dev/scheduled-reports/plan.md` r3（§0 拍板 N1/N2、§4 数据模型、§5.2 命令表、§10 接口契约、§12 S0 行）。
> 范围：只冻结契约，不实现行为。所有新增字段和帧都是可选的，默认关闭；schedule 关闭时零面。

## 1. 改动文件

| 文件                                             | 内容                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/protocol/schedule.ts`（新）         | cap、5 个 `sched_*` 帧（typebox 严格 schema + TS 接口）、wire 级 id/hash 正则、定义/运行词汇类型、`HubScheduleConfig` + 归一化器、hub 投影类型                       |
| `src/web-hub/protocol/messages.ts`               | 只做并入：`AgentFrame`/`HubFrame` 联合加 5 个帧类型，两张解码表展开 `SCHED_{AGENT,HUB}_FRAME_SCHEMAS`，类型 re-export                                                |
| `src/web-hub/hub/ports.ts`                       | `HubConfig.schedule?: HubScheduleConfig`（只有类型）                                                                                                                 |
| `src/config/settings.ts`                         | `ScheduleSettings` / `DEFAULT_SCHEDULE_SETTINGS` / `parseScheduleSettings`，接入 `AgentSettings`、`DEFAULT_SETTINGS`、`parseSettingsSource`、`TIME_SETTING_MS_PATHS` |
| `src/config/setting-specs.ts`                    | `schedule.enabled`、`schedule.defaultTimeoutS`、`schedule.maxTimeoutS` 三个键                                                                                        |
| `src/web-hub/agent/command-policy.ts`            | `/schedule` 子命令表（导出 `schedulePolicy`，挂在 `PI_TOOLKIT_TABLE.schedule`）                                                                                      |
| `src/schedule/core/spec.ts`（新）                | 存储规格：状态文件、运行记录、missedLog、pendingReports 等类型；固定常量；错误码；`canonicalJson`/`defHash`/批准推导/runKey/reportId 纯函数                          |
| `tests/web-hub/protocol/schedule.test.ts`        | 帧往返、方向、非法帧拒收、cap、PROTO 未升、HubConfig 归一化                                                                                                          |
| `tests/web-hub/protocol/schedule-policy.test.ts` | `/schedule` web 策略表（放在这里是因为文件域只允许 `tests/web-hub/protocol/schedule*.test.ts`）                                                                      |
| `tests/schedule/core/spec.test.ts`               | defHash 确定性向量、规范化规则、批准推导、key 辅助函数、词汇表                                                                                                       |
| `tests/config/schedule-settings.test.ts`         | 默认值、逐字段解析、*S⇄*Ms、上下限收敛、spec 表、与 spec.ts 的字面量镜像一致性                                                                                       |

零 git 写操作；没有碰 fixtures、AGENTS.md，也没有碰并行包（cmd-history）的文件。

## 2. 契约清单（冻结面）

### 2.1 cap 与帧（§10.1）

- `SCHED_HUB_CAP = SCHED_AGENT_CAP = "sched.v1"`（另有 `SCHED_HUB_CAPS`、`SCHED_AGENT_CAPS` 数组）。S0 里这几个常量是惰性的，还没有被折进任何 caps 数组。
- **PROTO 不升**（仍是 1.2，测试钉住），只加可选帧，并且只在 cap 下发送。
- agent→hub：
  - `sched_changed{sessionId}`
  - `sched_bound{agentKey, runKey}`
  - `sched_run_ack{reqId, result:"started"|"refused", reason?}`
- hub→agent：
  - `sched_run{reqId, sessionId, taskId, defHash, expiresAt}`
  - `sched_receipts{sessionId, reportIds[1..64]}`
- 所有 schema 都是 `additionalProperties:false`。字段约束：
  - `sessionId` `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
  - `reqId` `^[A-Za-z0-9_-]{16,64}$`（同时覆盖 web cmdId 和飞书 `fs…` cmdId）
  - `taskId` `^s_[a-z2-7]{8}$`
  - `defHash` / `reportId` 为 64 位小写 hex
  - runKey `^s_[a-z2-7]{8}@(0|[1-9]\d{0,15}|m-[0-9a-f]{8})$`
  - `expiresAt` 为非负整数；`reason` 1..128 字符；`agentKey` 1..256 字符
- 方向严格：hub 解码器不认 agent 帧，反之亦然（测试钉住）。
- 相关常量：`SCHED_RUN_TTL_MS = 30_000`、`SCHED_RUN_ACK_WAIT_MS = 10_000`、`SCHED_RECEIPTS_PER_FRAME = 64`。

### 2.2 HubConfig（§10.3）

- `HubConfig.schedule?: { dir: string; toleranceS: 60 }`。key 不存在就是关闭。
- `normalizeHubScheduleConfig(raw)`：要求 `dir` 是绝对路径、不含 NUL、≤4096 字符，并且 `toleranceS === 60`；否则返回 `undefined`，由调用方丢弃整个 key。多余的键忽略、不拷贝。

### 2.3 settings（§10.3，全部非 live）

| 文件键                     | 内部字段           | 默认                                        | 校验                                                                       |
| -------------------------- | ------------------ | ------------------------------------------- | -------------------------------------------------------------------------- |
| `schedule.enabled`         | `enabled`          | `false`                                     | 必须是 boolean                                                             |
| `schedule.dir`             | `dir?`             | 缺省（由 A0 解析为 `<agentDir>/schedules`） | 不含 NUL 的绝对路径，≤4096；非法时 key 缺省。JSON-only，不进 SETTING_SPECS |
| `schedule.defaultTimeoutS` | `defaultTimeoutMs` | 1800s                                       | 整秒，60..14400；最后收敛到 ≤ max                                          |
| `schedule.maxTimeoutS`     | `maxTimeoutMs`     | 14400s                                      | 整秒，60..14400                                                            |

`webHub.webCommandPolicy.schedule` 不需要新增设置：已有的 `webCommandPolicy` 整名覆盖机制直接生效（测试钉住），默认走 §5.2 的子命令表。

### 2.4 command-policy（§5.2 web 列）

| 形式                                                      | 策略    |
| --------------------------------------------------------- | ------- |
| 裸命令 / `list` / `show` / `log`（含只读的 `--all` 形式） | allow   |
| `pause` / `resume` / `rm` / `run`                         | confirm |
| 以上四个带 `--all`                                        | deny    |
| `approve <id> <64hex>`（恰好 3 个 token）                 | allow   |
| 其他任何 `approve`（含 `--all`）                          | deny    |
| `__put <json…> <64hex>`（只校验最后一个 token）           | allow   |
| 无尾随 hash 的 `__put`                                    | deny    |
| `add` / `edit` / `repair` / 未知子命令                    | deny    |

### 2.5 spec.ts（§4）

- **类型**：
  - `ScheduleTask`（就是 wire 上的 `ScheduleTaskDef`）
  - `ScheduleStateFile`（v1）、`OccState`、`MissedEntry`、`RunRecord`、`PendingReport`
  - `ReportStats`、`ManualReq`、`DigestState`、`Holder`、`NoteState`、`MissedCause`、`ScheduleErrorCode`
- **常量**：
  - §4.4/§4.7/§10.3 的全部固定值：容差 60s、N2 3600s、启动超时 60s、静默期 1s、能力 unknown 30min
  - 数量与容量：8 任务 / 64 会话目录；名称 ≤40、prompt ≤8KiB；超时 1800/60/14400
  - state ≤256KiB、runs 每任务 20、pendingReports 64、missedLog 64、manualReqs 32 / 24h
  - 报告：24h 窗口、14d 保留、各类字节和份数上限
  - 回执 7d / 4096；文件证明 16MiB、最多重发 2 次；cron 预算 10k / 400d / 50k
- **固定名称**：`state.json`、`.lock`、`reports/`、customType `subagent:schedule`、状态键 `pi-subagent:schedule`、段名 `pi_schedules`、调度占位 `Symbol.for` key、报告路径正则 `^reports/[0-9a-f]{64}\.md$`。
- **纯函数**：
  - `canonicalJson`、`executionDefinition`、`defHash`
  - `isApproved`、`isPendingApproval`、`isExecutable`
  - `hash8`、`autoRunKey`、`manualRunKey`、`parseRunKey`
  - `reportIdOf`、`reportFileOf`、`isHash`、`isTerminalRunState`、`emptyStateFile`
- **词汇常量**：`SCHED_UNKNOWN_REASONS`、`SCHED_DROPPED_REASONS`、`SCHED_REPORT_SKIPPED_REASONS`、`SCHED_EXECUTION_FIELDS`、`SCHED_UPDATE_FORBIDDEN_FIELDS`。

### 2.6 defHash 规范化（冻结，测试向量在 `tests/schedule/core/spec.test.ts`）

1. **执行定义**恰好是 `form, when, prompt, feishu, bg, ownerCwd` 这几个字段。`bg` 整体参与；任务没有 `bg` 时就不出现。
2. **canonicalJson**：
   - 键按 UTF-16 code unit 升序；
   - 值为 `undefined` 的属性丢弃；数组保序；
   - 标量与 `JSON.stringify` 一致；无空白；
   - 非有限数、bigint、函数、symbol、非 plain 对象一律抛 TypeError；
   - **不做 Unicode 规范化**（NFC 与 NFD 的哈希不同，测试钉住）。
3. **defHash** = `sha256(UTF-8(canonical))`，小写 hex，64 位。

三条向量另用 Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` + hashlib 独立复算，结果一致：

| 场景                                | defHash                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| background 最小 bg（含中文与 `\n`） | `fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9` |
| message once（引号、é）             | `1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655` |
| background 全部 bg 字段             | `903e09819b62a8a998043f26eb9ddc52b736e783a207b767c6a1da07c9051c32` |

其他向量：

- `hash8("fsAbCdEfGhIjKlMnOpQrStUvWxYz0123") = 20f1cd92`
- `reportIdOf("019a0000-aaaa-7bbb-8ccc-dddddddddddd", "s_abcd2345@1761350400000") = 9c128a4c…9c70`

## 3. 冻结面与零面验证

- schedule 关闭（默认）时，没有任何代码读取新字段或新帧：cap 没有折进 caps，帧没有路由，`HubConfig.schedule` 没有写入点，工具、命令、段都未注册。
- 下列 golden 与相关测试全部通过，`tests/fixtures/**` 零改动（`git status` 无 fixtures 变更）：
  - 三份 fabric off golden（`fabric-xs-off` / `fabric-wake-off` / `fabric-xs-reply-off`）
  - `fabric-xs-channel-compat`、`secure/off-golden`、`web-hub/ui/keepalive-golden`
  - `tests/web-hub/boundary.test.ts`
- 新增的 settings 键没有让任何 off golden 变红，所以不需要「在测试里显式关闭正交特性」。
- `settings.ts` **没有新增 value import**（boundary 冻结了它的 import 闭包）。超时上下限在 settings.ts 里是字面镜像，与 `spec.ts` 的 `SCHED_BG_TIMEOUT_*` 一致，由 `tests/config/schedule-settings.test.ts` 钉住。

## 4. 与方案的偏差及处理

| #   | 方案                                                                              | 现状 / 冲突                                                                                                                                      | 处理                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | §12 写的是「spec.ts 含任务、运行类型」                                            | hub 投影（§5.6）要携带任务定义和运行状态，而 `src/web-hub/{protocol,hub}` 只能 import 自身目录内的文件（boundary.test）                          | 定义与运行的**词汇类型**（`ScheduleTaskDef`/`ScheduleWhen`/`ScheduleBg`/`ScheduleRunState`/回执状态……）以及 id/hash 正则放在 `protocol/schedule.ts`；`spec.ts` 原名 re-export（`ScheduleTask = ScheduleTaskDef`）。存储专属的类型（Holder/RunRecord/StateFile/MissedEntry/PendingReport…）仍在 spec.ts |
| 2   | §10.3 键名 `schedule.defaultTimeoutS` / `maxTimeoutS`                             | 仓库约定是文件键用 `*S` 秒，内部字段用 `*Ms`（`TIME_SETTING_MS_PATHS`，settings-editor 测试有不变量约束）                                        | 文件键与方案一致；内部字段是 `defaultTimeoutMs` / `maxTimeoutMs`。A0 用 `ms / 1000` 得到 `bg.timeoutS`。下限定为 60s（方案没写下限）；default 收敛到 ≤ max                                                                                                                                             |
| 3   | §1「加密域禁用（D8）」                                                            | §3.3 矩阵要求加密域下工具照常注册、调用时返回 `E_SECURE`。如果在 `applySecureDomainOverrides` 里强制 `enabled=false`，工具就不注册了，与矩阵矛盾 | S0 **不**在 settings 层强制关闭（测试钉住），由 A0 的 `assertExecutable` / 模式矩阵拒绝。`schedule.dir` 在加密域也不重定向（反正不会执行）                                                                                                                                                             |
| 4   | §5.2 写「`--all` 是任意本地 TUI 会话可用」，web 表只写「`--all` 写操作 deny」     | web 上 `list/show/log --all` 的归属没有写明                                                                                                      | 按 web 表字面：只读的 `--all` 为 allow。如果 A3 认定 `--all` 只限本地 TUI，在 handler 里拒绝即可（handler 比策略更严是允许的）                                                                                                                                                                         |
| 5   | §4.2 `digest.inflight: Holder & {id, at}`；§5.5 写的是 `{id, holder, fileOffset}` | 两处不一致                                                                                                                                       | `DigestState.inflight = Holder & { id; at; fileOffset? }`（fileOffset 可选）                                                                                                                                                                                                                           |
| 6   | `reports/<h>.md` 里的 `<h>` 未定义；`hash8` 未定义                                | —                                                                                                                                                | `<h>` = `reportIdOf(sid, runKey)`（`reportFileOf`），不管是否推送都用这个名字；`hash8(x)` = `sha256(UTF-8 x)` 的前 8 位 hex                                                                                                                                                                            |
| 7   | `bg.thinking?: ThinkingLevel`                                                     | protocol 不能 import core                                                                                                                        | 字面镜像 `SCHEDULE_THINKING_LEVELS = off/low/medium/high`，与 `core/types.ts` 的 `THINKING_LEVELS` 一致，测试钉住                                                                                                                                                                                      |
| 8   | §12 的 S0 行没有列 hub 投影 / SSE 形状                                            | W1 要先用 mock 开工，H1 与 W1 需要对齐                                                                                                           | 额外冻结了只有 TS 类型的投影：`SchedulesPayloadWire` / `ScheduleSessionProjectionWire` / `ScheduleTaskProjectionWire` / `ScheduleRunProjectionWire`，加上 `SCHED_SSE_EVENT = "schedules"`、`SCHED_API_PATH = "/api/schedules"`。H1 只能追加可选字段                                                    |
| 9   | §5.2 没有给 command-policy 指定测试位置                                           | 文件域只允许 `tests/web-hub/protocol/schedule*.test.ts`                                                                                          | 放在 `tests/web-hub/protocol/schedule-policy.test.ts`（policy 模块本身在 agent/ 下）。以后如需搬到 `tests/web-hub/agent/`，交给拥有该目录的包                                                                                                                                                          |
| 10  | cap 常量的位置                                                                    | 既有 cap 多在 `protocol/version.ts`（不在本包文件域）                                                                                            | 沿用 xs 先例，放在 `protocol/schedule.ts`                                                                                                                                                                                                                                                              |
| 11  | 方案里的行号坐标（messages.ts:1017-1121/2246-2252、ports.ts:432）                 | 行号有漂移，但结构一致                                                                                                                           | 无影响                                                                                                                                                                                                                                                                                                 |

**schema 收紧**（在方案字面之上额外加严）：

- `sched_receipts.reportIds` 至少 1 条（空帧没有意义）；
- `sched_run_ack.reason` 在两种 result 下都可选（按 §10.1 字面）。约定只在 refused 时带，不在 schema 层强制。

## 5. 给下游包的接口说明

### S1（核心）

- writer、reader 一律以 `spec.ts` 的 `ScheduleStateFile` 为准。`state.json` 的运行时校验（不可信输入）由 S1 自己实现，例如 `validateStateFile`；S0 没有提供 schema。
- 字段上限用 `SCHED_*` 常量。
- 批准判定一律走 `isExecutable` / `isApproved`，禁止自己算 hash；defHash 只能用 `defHash()`。
- runKey 用 `autoRunKey` / `manualRunKey`，reportId 和报告路径用 `reportIdOf` / `reportFileOf`；reader 用 `SCHED_REPORT_FILE_RE` 校验报告路径。
- boundary 白名单：hub 侧如果 import `spec.ts`，它的 value import 闭包是 `node:crypto` + `../../web-hub/protocol/schedule.js`。
- 旧的 `tests/schedule/{cron,scheduler,store}.test.ts` 属于旧引擎（A0 退役时一并处理）。

### A0（agent 骨架）

- 只有在 `schedule.enabled` 时，才在 `hello.caps` 里加 `SCHED_AGENT_CAP`。
- 仅当 `schedule.enabled ∧ webHub.enabled ∧ control !== false` 时写 `HubConfig.schedule = { dir: <realpath storeDir>, toleranceS: SCHED_TOLERANCE_S }`。
- `bg.timeoutS` 的默认值和上限取 `settings.schedule.{default,max}TimeoutMs / 1000`。
- 加密域的拒绝由 A0 实现（见偏差 #3）。
- 只有 `hello_ack.caps ∋ sched.v1` 时才发 `sched_*` 帧，否则用 NullCoordinator。
- `sched_receipts` 收到后，在锁内移除对应的 pendingReports。

### A2 / A3

- customType、details kind（`SchedMessageKind`）、状态键、段名、调度占位 key 都用 spec.ts 的常量。
- 工具和命令的错误码限定在 `SCHEDULE_ERROR_CODES` 内。
- `update` 拒绝写 `SCHED_UPDATE_FORBIDDEN_FIELDS` 中的字段。
- 网页 `__put` 的最后一个 token 必须是 defHash；approve 恰好是 `<id> <hash>`。

### H1（hub 协调者）

- `hub/main.ts` 用 `normalizeHubScheduleConfig` 重新校验，非法时丢弃整个 key。
- 只有 `config.schedule` 存在时，才把 `SCHED_HUB_CAP` 折进两个 cap 面（`HubInfo.caps` / `hello_ack.caps`）。
- 帧已经在 `decodeAgentFrame` / `decodeHubFrame` 里，registry 的 `onFrame` 加 case 即可。
- SSE 事件和 GET 路径用 `SCHED_SSE_EVENT` / `SCHED_API_PATH`，载荷是 `SchedulesPayloadWire`。
- 每帧最多 64 个回执 id，超出就拆成多帧。

### F1（飞书）

- 回执状态集合是 `SCHEDULE_RECEIPT_STATES`；`reportId` 用 `reportIdOf`。
- `sched_run` 的 TTL 和 ack 等待分别是 `SCHED_RUN_TTL_MS` / `SCHED_RUN_ACK_WAIT_MS`。
- `reqId` 用飞书确定性 cmdId（`fs` + 30 位 base64url，满足 `SCHED_REQ_ID_RE`）。
- 回执保留 `SCHED_RECEIPT_TTL_MS`，上限 `SCHED_RECEIPTS_MAX`。

### W1（web）

- 按 `SchedulesPayloadWire` 写 mock，忽略未知键。
- 审阅对话框展示 `defHash` 前 8 位，提交时用完整 hash：`/schedule approve <id> <hash>` 或 `/schedule __put <json> <hash>`。
- 只有 hub caps 含 `sched.v1` 时才显示面板，否则 UI 保持字节不变。
- 飞书显示状态用 `ScheduleFeishuDisplay`（其中 `?` 只由前端在 hub 不可达时渲染）。

## 6. 自验

| 命令                                                                                                                                                                 | 结果                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npx vitest run tests/web-hub/protocol tests/schedule tests/config --maxWorkers=3`                                                                                   | 91 个文件全部通过，2323 passed / 3 skipped                      |
| 三份 fabric off golden（`fabric-xs-off` / `fabric-wake-off` / `fabric-xs-reply-off`）                                                                                | 3 个文件全部通过，7 passed                                      |
| 附加：`secure/off-golden`、`keepalive-golden`、`fabric-xs-channel-compat`、`boundary`、`tests/ui`、`tests/web-hub/agent`、`tests/commands`、`tests/web-hub/contract` | 126 个文件全部通过，2249 passed                                 |
| `npm run typecheck`（tsc ×2 + vue-tsc）                                                                                                                              | 通过                                                            |
| `npx prettier --check`（全部改动文件 + 本报告）                                                                                                                      | 通过                                                            |
| 全量 `npx vitest run --maxWorkers=4`                                                                                                                                 | 1490 个文件中 1488 个通过；28546 passed / 4 failed / 24 skipped |

全量里的 4 个失败与本包无关：用 `git archive HEAD` 导出的干净基线（不含本包改动）同样复现。

- `tests/integration/background-status-wiring.test.ts` ×3：`TypeError: off is not a function`；
- `tests/integration/web-hub-feishu-bot.test.ts`「off: same legacy caps…」×1：caps 列表不一致，疑与 HEAD 上 cmd-history 新增 `cmd.history.v1` 静态 cap 有关，属于并行包的范围。

本包没有往任何 caps 数组里加东西。
