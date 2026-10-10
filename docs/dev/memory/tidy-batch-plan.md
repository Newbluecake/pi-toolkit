# `/mem tidy --batch` 施工方案 v3.2（终版）

> 状态：**方案 v3.2，终版**。不再安排完整评审轮：主会话核对 §17.4 处置表，实现阶段由 verifier 逐项核对代码。
>
> 评审记录：
>
> - v1 被 `r_0JVVABFR` 打回。
> - v2 被 `r_GMW1FVT0` 打回。
> - v3 被 `r_5HKF5EZ1` 打回。
> - v3.1 被 `r_64QH0GD9` 打回（1 个阻塞、6 个 Major）。该复审同时确认 B1 真值表和 B2 原语契约已基本完整。
>
> 有约束力的主会话裁定见 §18（M-T1..M-T9），不再重开。处置表见 §17.3（v3.1）和 §17.4（v3.2）。
>
> 用户裁定：保留 v1 的完整范围，即批量归档加批量模型改写；跨批合并不做。
>
> 行号以 HEAD `9db94cf` 为准。`src/config/{settings,setting-specs}.ts`、`src/core/types.ts`、`src/service/request-threading.ts` 目前带有 sysload P0 的修改，或已被它冻结，这几个文件的行号只算「附近」。

## 0. v3.2 相对 v3.1 的变化

1. **父目录 TOCTOU（M-T9，原阻塞）**：
   - 写入威胁模型的非目标部分（§1）；
   - 每次改动磁盘的 syscall 之前，都重新 `lstat` 所在目录，核对 `(dev, ino)`，不一致就把该 op 判为 conflict 并中止所在 step；
   - 验证之后新出现的 symlink 目录一律不跟随；
   - 不采用 fd 锚定方案。
2. **单一 tmp 命名语法（Major 1）**：只有一个 `TMP_RE`，一个模块 `src/memory/tmp-names.ts`。锁、lease、manifest、op 的 tmp 名都由它生成（§9.1）。
3. **不支持硬链接时 fail closed（Major 2）**：`createLocExclusive` 和 `moveLocNoClobber` 在 `link()` 不可用（EPERM/ENOTSUP/EOPNOTSUPP/ENOSYS）或遇到 EXDEV 时，一律带着可操作的错误失败，不再静默退化为非独占的 rename。batch 启动前先做一次硬链接探测（§9.3）。
4. **成功后核验 `(dev, ino)` 与 sha，并强制最终观测（Major 3）**：每个 op 的 `result` 事件都带 `final`，即该 op 所有位置的最终观测，判定以它为准（§9.2、§9.3）。
5. **派发开销实测（Major 4）**：去掉 `HOOK_MARGIN` 这个假设。权威测量点改为子会话 `before_provider_request` 拿到的**完整 provider payload**，超预算就在发送前中止 run。另外列出 tidy 子会话里所有 `before_agent_start` 贡献者，作为交叉核对（§4.5）。
6. **journal 事件边界（Major 5）**：
   - 逐一定义 run/intent/staged/result 每条边界上崩溃后的认领规则；
   - 新增 `attempt` 事件来落实 M-T3：没有 result 的 intent，补偿动作**最多执行一次**；之后只观测、不再动作，直接进入终态（§9.2、§9.4.4）。
7. **`--break-lock` 的 owner epoch（Major 6）**：打破锁时递增 `.owner-epoch`。每个改动磁盘的 op 都在目录锁内复查 epoch；旧持有者被拒绝，并看到明确的提示（§10.2）。

## 1. 范围

**v1 包含**：

- `/mem tidy --batch [--dry-run | --status] [--triage] [--archive-only] [file…]`；
- `/mem tidy --break-lock`（M-T4，只在 TUI 下可用）；
- 用确定性信号挑选候选，通过有界勾选列表批量归档到 `archive/<name>`，文件字节不变；
- 确定性修剪索引，并追加写入 `ARCHIVE.md`；
- 有界模型规整：只处理 agent 文件，按字节和文件数双重约束分批，最后统一审阅一次；
- 所有写入走 §9 的事务模型，产出 v2 manifest。v1 manifest 只读（M-T2）；
- run lease、锁持有者身份、中断后恢复。

**v1 不包含**：跨批合并；改动 `--frontmatter` 的判定逻辑（它的 apply 改走事务层）；多次 triage；切分超过 `maxInputBytes` 的单文件；RPC 或 web hub 驱动交互流程；改动 `TIDY_SCHEMA` 的结构（只把 `maxItems` 替换成常量 `TIDY_MAX_FILES`，值不变，M-T7）；近似查重；模型提案在崩溃后持久化。

**非目标：持久性承诺（M-T1）**

- 事务模型只保证**进程崩溃 / `kill -9`** 之后能收敛，**不保证断电或内核崩溃**。
- 目录 fsync 只是尽力而为：每次 journal 追加之后、每次 rename/link/unlink 之后，各对父目录做一次 fsync；失败只记 WARN，不影响任何正确性声明。
- 断电可能导致最后一次 journal 追加或目录项变更丢失。此时恢复可能看到「没有 intent 记录、但磁盘已经变了」，表现为孤儿对象。这类情况不在承诺范围内，`--status` 会把它们作为无主对象报告，供人工处理。

**非目标：父目录 TOCTOU（M-T9）**

- Node 22 没有 `openat`/`renameat2`，所以 link/rename/unlink 在 `verifyDir` 之后仍然只能按**路径字符串**执行。在 `verifyDir` 和 syscall 之间，攻击者可以把父目录换掉，这个窗口**不在威胁模型内**。
- 原因：要换掉 `~/.pi/agent/memory/<slug>/` 下的目录，必须是同一个 uid，而这本身就等于已经被完全攻陷。这与现有 memory 模块的模型一致：slug 目录只 canonicalize 一次并视为用户可信，只拒绝文件级 symlink 和非普通文件（AGENTS.md 的 `src/memory/` 条目；`safe-fs.ts:62-128`、`:182-228`）。
- 仍然要做的（best effort）：
  - 每次 mutating syscall 之前重新 `lstat` 所在目录，核对 `(dev, ino)`，并确认它是普通目录、不是 symlink；不一致就中止该 op，判为 conflict。
  - 验证之后被换成 symlink 的目录，`verifyDir` 会拒绝，不会跟随。
  - 残余窗口是「最后一次 `verifyDir` 到这次 syscall 之间」，在同步代码里只有几微秒到几毫秒。这里明确声明：不防护，也不承诺。

## 2. 读码事实

| 编号 | 事实                                                                                                                                                                                | 位置                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| E1   | `TIDY_SCHEMA.files.maxItems: 24`；宿主侧另有 `SCHEMA_LIMITS.maxFiles = 24`，超出就整份作废。`JsonSchema` 类型只是 `Record<string, unknown>`，所以从里面读 `maxItems` 要做运行时校验 | `contracts.ts:203-206`；`validate.ts:47-55,129-133`；`src/core/types.ts:49`                                      |
| E2   | `renameNoClobber` 的实现是先 `linkSync` 再 `unlinkSync`，两步之间会出现两个名字指向同一 inode；不支持硬链接时退化为 `renameSync`                                                    | `safe-fs.ts:452-482`（`:458`、`:476`）                                                                           |
| E3   | `createExclusive` 也是先 link 再 unlink tmp；`writeTempRegular` **在函数内部随机生成** tmp 名（`.${name}.${pid}.${rand8}.tmp`），调用方事先拿不到名字                               | `safe-fs.ts:410-450`、`:372-373`                                                                                 |
| E4   | `backupLiveFile` 是**移动**活文件；`recreateFromBackup`、`copyLiveFileToBackup`、`vacateLiveFile` 都只接受平铺的 `name`                                                             | `manifest.ts:56-59,63-67,73-80,199-203`                                                                          |
| E5   | 现行 restore 先在锁外 `planRestore`，用户确认后 `applyRestore` 持锁直接 vacate 加重建，中间不再比对 sha，也没有进度记录                                                             | `command.ts:609-640`；`restore.ts:64-99,108-115,138-188`                                                         |
| E6   | 现行 apply 会给文件打 `source: agent` 和 `updated`；它的移动式备份会造成「live 缺失」中间态，失败时靠 catch 里尽力回滚                                                              | `apply.ts:75,91-94,102,117,138-148`                                                                              |
| E7   | `abort()` 只是发出一个协作式请求                                                                                                                                                    | `src/service/spawn-service.ts:1114-1148`                                                                         |
| E8   | cap watcher 只在回合边界检查；最后一回合即使越过上限，run 也会正常完成                                                                                                              | `src/consult/watcher.ts:20-34,58-71`                                                                             |
| E9   | 现行 tidy 对超出上限的结果只标 `(over cost cap)`，仍允许 Apply                                                                                                                      | `command.ts:192-198,375`                                                                                         |
| E10  | RPC UI 只实现了 `select/confirm/input`                                                                                                                                              | pi `dist/modes/rpc/rpc-mode.js:84-86,161-165`                                                                    |
| E11  | `ui.select/confirm/input` 接受 `ExtensionUIDialogOptions { signal, timeout }`；`ui.editor(title, prefill?)` **没有** opts 参数；`ui.custom` 可以自己调用 `done`                     | pi `dist/core/extensions/types.d.ts:40-45,74-78,121-139`                                                         |
| E12  | web hub 下 `/mem tidy` 一律走 `confirm` 策略；判断是否 web 调用用 `isWebInvocation`；现成的 TUI 判定写法是 `canOpenSettingsEditor`                                                  | `src/web-hub/agent/command-policy.ts:121-127`；`command-capture.ts:486-488`；`src/ui/settings-editor.ts:496-498` |
| E13  | 目录锁：body 必须同步；锁文件 mtime 超过 30 s，**任何人**都可以 break，即使持有者还活着；默认等锁 2 s；`LockPayload` 只有 `{pid, host, token, at}`                                  | `lock.ts:22-28,56-58,66-79`；`safe-fs.ts:744-800`                                                                |
| E14  | `/proc/<pid>/stat` 的 starttime 解析函数                                                                                                                                            | `src/web-hub/protocol/proc-identity.ts:56-68`                                                                    |
| E15  | 宿主侧的 JSON Schema 校验器                                                                                                                                                         | `src/core/json-schema.ts:59`                                                                                     |
| E16  | 默认快照会排除 `status: archived`，显式点名的文件除外                                                                                                                               | `snapshot.ts:54-59,106`                                                                                          |
| E17  | `Model` 带有 `contextWindow` / `maxTokens`；`ctx.modelRegistry.find` 可以查到                                                                                                       | `command.ts:261`；pi-ai `dist/types.d.ts:930-931`                                                                |
| E18  | `listRegular` 是平铺扫描，看不到 `archive/`；`MAX_BACKUPS = 10`，prune 要求备份目录是平铺的                                                                                         | `safe-fs.ts:198`；`manifest.ts:27,149-170`                                                                       |
| E19  | legacy 的 write/append **原地**改写同一个 inode（`O_TRUNC` / `O_APPEND`）                                                                                                           | `safe-fs.ts:484-540`                                                                                             |
| E20  | restore 分派时没有传 `onAfterWrite`                                                                                                                                                 | `command.ts:105-108`                                                                                             |
| E21  | 现行 tidy 的 prompt 只算了正文；子会话实际还会带上 agent type 的 system prompt、四个只读工具、StructuredOutput 和 schema                                                            | `command.ts:240-266`；optimize-plan §7.0                                                                         |
| E22  | agent type 注册表（含 system prompt 正文）                                                                                                                                          | `src/config/agent-types.ts:9,157`                                                                                |

补充事实（v3.1）：

| 编号 | 事实                                                                                                                                                                                        | 位置                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| E23  | `unlinkRegular`：先做 `isSafeName` 检查，再 lstat 确认是普通文件，然后 `unlinkSync`。注释说明 lstat 与 unlink 之间的 TOCTOU 窗口最多只会删掉目录内的那个条目，不会穿透 symlink              | `safe-fs.ts:541-555`                                                                   |
| E24  | `renameNoClobber` 的回退路径：`EPERM/ENOTSUP/EXDEV` 时先 lstat 确认目标不存在，再 `renameSync`（非原子 no-clobber）；两端用同一个 `dir` 拼接路径                                            | `safe-fs.ts:452-482`                                                                   |
| E25  | `replaceAtomic` 就是 `renameSync(join(dir,tmp), join(dir,name))`；`writeTempRegular` 只 fsync 文件本身，不 fsync 目录                                                                       | `safe-fs.ts:372-401`                                                                   |
| E26  | Node `fs` 没有 `renameat2`/`RENAME_NOREPLACE` 的绑定，本包没有运行时依赖、也不允许 native addon（AGENTS.md「There are no runtime dependencies」），所以 no-clobber 只能用 `link()+unlink()` | AGENTS.md Conventions；`safe-fs.ts:458,476`                                            |
| E27  | `AgentSession` 暴露 `get systemPrompt(): string` 和 `getAllTools()`（带 `sourceInfo`）；session-driver 在 `prompt()` 之前就持有 session                                                     | pi `dist/core/agent-session.d.ts:391`；`src/runtime/session-driver.ts:450-456,459-470` |
| E28  | `lockCreate` 先用 `O_EXCL` 创建，再写 payload，崩溃会留下空的或半写的锁文件；`lockRead` 读不出 payload 时返回 `payload: undefined`                                                          | `safe-fs.ts:754-770,772-800`                                                           |

## 3. 命令与支持面（沿用 v2，钉死）

| 调用形态                                    | `--batch`（交互）                                                              | `--batch --dry-run`       | `--batch --status` |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------- | ------------------ |
| TUI（`ctx.mode === "tui"` 且不是 web 调用） | ✅                                                                             | ✅                        | ✅                 |
| RPC（`ctx.mode !== "tui"` 且 `hasUI`）      | ❌ 可操作的拒绝提示：`needs the terminal UI; --dry-run and --status work here` | ✅                        | ✅                 |
| web hub（`isWebInvocation`）                | ❌ 同上                                                                        | ✅（command-policy 放行） | ✅                 |
| print / 子会话                              | ❌（`command.ts:93-96`）                                                       | ❌                        | ❌                 |

- 拒绝发生在任何 IO **之前**：不 spawn、不写盘、不碰 lease。
- `--status` 只读，展示内容：lease 及持有者、最近一个 batch/restore manifest 的 `run.state`、需要人工处理的冲突数量。它**不会触发恢复**（恢复要写盘，只在交互流程里进行）。
- `command-policy.ts` 的 `mem()` 新增放行规则：tokens 恰好等于 `["tidy","--batch","--dry-run"]` 或 `["tidy","--batch","--status"]` 时 ⇒ `allow`（`:123-127`）。

## 4. Phase 0：规划（零成本、只读）

### 4.1 前置检查（依次执行）

1. 支持面检查（§3）。
2. `batch` 可用性：需要 `memory.tidy.batch.enabled` 为真。`BATCH_MAX_FILES = TIDY_MAX_FILES − 4` 是编译期常量（M-T7，§12 P0），不再在运行时读取 schema。
3. lease 检查（§10.1）：有其他存活的持有者 ⇒ 拒绝；是本进程持有且 `draining[]` 不为空 ⇒ 拒绝并说明原因（§8.4）。
4. **恢复**（§9.6）：扫描所有 v2 manifest，找出 `run.state ∈ {applying, interrupted}` 且持有者已不存在（§10.3）的，持锁执行 `recoverRun`，它必然以 `recovered` 或 `conflict-reported` 结束。随后用一个有界对话框报告结果（`ok` / `View conflicts` / `Cancel`），用户选 `ok` 后**本次命令继续往下规划**，不需要重新执行命令。如果 manifest 校验失败（§9.8），这一份 manifest 不参与恢复，只报告 `invalid manifest <id>: <reason>`，而且**本次 batch 拒绝开始**——因为无法确认现场是否一致。修复方式只有两种：用户手动处理，或运行 `/mem restore` 查看列表。

### 4.2 候选快照（v2 #6，不变）

在 `SnapshotOptions` 里加 `includeArchived?: boolean`（`snapshot.ts:54-59`），值为 `true` 时绕过 `:106`。归档候选用 `includeArchived: true` 的快照；规整用默认快照，并且在 Phase 2 apply **之后**重新取一次。

### 4.3 确定性信号（v2 不变）

`archive-signals.ts` 产出以下信号：

- S1：顶层文件已经是 `status: archived`。默认勾选。
- S2：`status: stale`。
- S3：日期过旧。取 frontmatter 日期和文件名里的日期两者中较新的一个，**不看 mtime**。
- S4：文件里有表示完成 / 已被取代的措辞。
- S5：孤儿文件，只展示不勾选。
- T：`--triage` 判为高置信度。默认勾选（仅 P3b）。

以下文件永远不进候选：core、primary core（`snapshot.ts:46-52`）、`pin`、索引文件。如果 `archive/` 里已有同名文件，列为 `conflict`，不可勾选。

### 4.4 规整分批（v2 #1，补 fail-closed）

- 输入：Phase 2 之后重新取的快照里的 agent 文件，再剔除本 run 已经触碰过的位置（§9.2 的 I-B1）。按 `k1` 族分组，各族内部 next-fit，族之间不混装。
- 每批的硬约束：
  - `Σbody ≤ capBytes = min(targetBytes, maxInputBytes, headroomBytes(model, overhead))`
  - `files ≤ BATCH_MAX_FILES = TIDY_MAX_FILES − 4 = 20`（M-T7：schema、校验器、规划器共用同一个常量）
  - `otherNames` ≤ 4 KiB
- 单个文件体积 ≥ `topicMaxBytes` ⇒ 单独成一批；单个文件 > `capBytes` ⇒ 标 `oversized`，只能 archive 或手工处理。
- 分批结果确定：同样的输入得到逐字节相同的计划；按码点序排序。超出 `maxModelRuns` 的部分截断（§8.2）。

### 4.5 单位、超时与派发开销实测（M-T5；v3.2 去掉 HOOK_MARGIN 假设）

- 展示统一用 `fmtKiB`，代码内部统一用字节。
- **规划期下限**：`overheadFloorBytes = OVERHEAD_FLOOR_BYTES + byteLen(JSON.stringify(TIDY_SCHEMA))`。这个值只用来给第一批分批，G-overhead 用真实 pi 钉住它 ≤ 实测值。
- **两段实测**：
  - `SpawnRequest.inputBudget?: { maxInputTokens; bytesPerToken: 2 }`（★`src/core/types.ts`，P-RT）。
  - **第一段：早期粗筛（runtime driver，在 `prompt()` 之前）**
    - 计算 `pre = byteLen(session.systemPrompt) + byteLen(JSON.stringify(activeToolDefs)) + byteLen(schema) + byteLen(prompt)`（E27）。
    - 只要 `ceil(pre/2) > maxInputTokens` 就零成本失败。这一段只能拒绝，不能放行：通过它不代表最终 payload 一定在预算内。
  - **第二段：权威测量（子会话 `before_provider_request`，在 provider HTTP 请求之前）**
    - pi 在发请求前会 await 所有 `before_provider_request` 处理器，传入的是完整 provider payload，里面已经包含所有 `before_agent_start` 的追加内容、工具声明、schema 和消息（pi `dist/core/sdk.js:213-218,262`；`dist/core/extensions/runner.js:1066-1094`）。
    - 本包在子会话里的 child wiring（`src/child/wire.ts`）注册一个处理器，**只对登记了 `inputBudget` 的 run 生效**。登记方式：runtime 在 `prompt()` 之前，把 `sessionId → { maxInputTokens, onMeasure }` 写入一个进程级 `Symbol.for` 注册表，先例是 `src/cache-ttl/child-registry.ts`。
    - 处理器计算 `measured = byteLen(JSON.stringify(payload))`，回调 `onMeasure(measured)`，测量值写入 `diag.dispatchMeasure.payloadBytes`。
    - 如果 `ceil(measured/2) > maxInputTokens`：在 handler 返回**之前**同步调用该 run 的 abort（run 的 `AbortController`）。随后 provider 拿到的是已经 aborted 的 signal，fetch 会直接拒绝、不会发出请求。run 以 `failed(config, "input-budget: measured N tokens > M")` 结束。
    - 注意：处理器抛出的异常会被 pi 吞掉（`runner.js:1081-1090`），所以中止只能靠 abort，不能靠 throw。
    - **残余风险**：自定义 provider 如果不把 signal 传给 fetch，可能已经发出一次请求。由 conformance 门 G-measure-real 钉住：用 pi 内置 provider 加本地假 HTTP 端点，断言请求数为 0。
  - **子会话扩展缺失（todo #27 的 `child_extension_missing`）**：这时第二段测量拿不到。设了 `inputBudget` 的 run 一律 fail closed，以 `input-budget: child extension missing — measurement unavailable` 失败。tidy 会把整个 batch 拒掉，并给出与 AGENTS.md runtime 条目相同的修复提示（用 `pi install`）。
  - **处理器的位置**：本包的处理器之后，第三方扩展的 `before_provider_request` 仍可能替换 payload。这一点写入残余风险 R12：tidy 子会话的 payload 最终由第三方扩展决定的那部分，不在本包控制范围内。
- **交叉核对**：tidy 子会话（`toolDomain: "readonly"`）里所有 `before_agent_start` 贡献者如下。只用于解释测量值，**不参与放行判断**。
  1. **本包的 prompt-section hub**：pre-guard 注册（`src/index.ts:166`、`src/sysprompt/hub.ts:357`）。子会话里只注册了 memory section（`src/index.ts:183`）；agent types 和 models 是 post-guard 注册（`:599`），子会话里没有。memory section 受 `memory.blockBytes`（tiered）或 `byteCap`（legacy）约束；`memory.injectInChildSessions=false` 时为 0。
  2. **本包的 title 和 feishu-notify**：都是 post-guard 注册（`src/index.ts:897,905`；`src/title/index.ts:234`；`src/feishu-notify/index.ts:504`），子会话里**不存在**。
  3. **pi 本体**：不经过钩子，已经算在 `session.systemPrompt` 里。
  4. **用户安装的第三方扩展**：数量和体积未知，**无法列举**，这正是要实测、不能靠假设的原因。
- **学习用于重排**：每个 run 结束后，取 `learnedOverhead = max(learnedOverhead, payloadBytes − promptBytes)`，用它重排剩余批次的 `capBytes`。因 `input-budget` 失败的那一批标为 `headroom`，并按新的 overhead 重新切分。
- token 估算和超时计算与 v3 相同（`cost.ts:24-30`），`outTokBound ≤ maxTokens` 的预检保留。

## 5. Phase 1：分诊 triage（可选，P3b，只跑一次，有上界；v2 不变）

只在传 `--triage` 时运行，最多一次。摘要放不下就**直接跳过、不拆分**。输出用 `TRIAGE_SCHEMA` 加 `validateAgainstSchema`（E15）校验。triage 的开销计入成本账本和 run 数，消耗的是同一份预留额度（§8）。triage 失败时降级为只用确定性信号。

## 6. Phase 2：批量归档 + 索引修剪

### 6.1 有界勾选列表（Major 3：不用 `ui.editor`）

纯逻辑放在 `src/memory/tidy/selection.ts`（pi-free），交互基于 `select` 循环：

- 选项依次是：
  - `"✓ Continue — archive N selected (X KiB)"`
  - `"Select suggested"`
  - `"Clear all"`
  - 每个候选一项：`"NN [x] name · 1.8KiB · S1 S3 — reason"`，选中即切换勾选
  - `[-]` 冲突项也列出，但选中时只提示 `cannot select: exists in archive/`
  - `"View a file…"`：打开 §6.3 的查看器显示该文件
  - `"Cancel"`
- 选项标签都带唯一的两位序号前缀，`select` 返回值严格按标签映射回动作，**映射不到 ⇒ 当作 Cancel**（fail-closed）。
- 每次 `select` 都传 `{ signal }`（§8.5 的空闲计时器）。超时或拿到 `undefined` ⇒ 跳过整个 Phase 2，不写任何文件。
- 选完后汇总确认：`ui.confirm(..., { signal })`，内容为：`Move N files (X KiB) to archive/? Index: MEMORY.md −k lines (hand-written), archive/ARCHIVE.md +k lines; m references need manual edits.`

### 6.2 索引链接语法（v2 #14，不变）

规则在 `index-edit.ts`：

- **识别规则**：内联链接 `[t](target)` 和 `[t](<target>)`。target 依次处理：去掉 `"title"`，去掉 `#anchor` 和 `?query`，去掉开头的 `./`，再做 `decodeURIComponent`。结果是一个满足 `isV2Name` 的文件名，或者 `archive/<isV2Name>`。
- **只报告、不改动**：引用式链接及其定义行、反引号里的名字、裸文件名、HTML 链接、带 `../` 或绝对路径的引用。
- **删行规则**：只删单行列表项。要求下一行不是续行或子项，并且该行只链接到一个被归档的记忆文件，没有其他引用。其余情况都进 `manual[]`。

### 6.3 diff 与有界查看器

`src/memory/tidy/ui/bounded-viewer.ts` 只在 TUI 下使用。它基于 `ui.custom`：只读、可滚动，按 `q` 或 `Esc` 关闭。打开时同时启动一个 deadline 计时器（unref），到期自动调用 `done()`。范式参照 `src/ask-user/component.ts:33`。

每个索引文件对应一个 `select(..., { signal })` 菜单：

- 未查看 diff 前：`["View diff", "Skip"]`
- 查看过 diff 后：`["Apply (hand-written — diff reviewed)", "View diff", "Skip"]`

diff 由 `renderTidyDiff`（`diff.ts:68`）生成，`ARCHIVE.md` 的追加内容拼在同一视图里。

### 6.4 应用（全部走 §9；Major 1：索引只认 done 的归档）

Phase 2 是一个 step，内含有序的 op：

1. 每个被勾选的文件生成一个 `MOVE(live:n → archive:n)`，期望 `live:n = sha_snap`，`archive:n = absent`。
2. **全部归档 op 执行完、拿到结论之后**，才去计算索引的新内容：只删除**结论为 `done` 的**归档 op 对应的链接行。被 CAS 跳过、`conflict` 或 `rolled-back` 的文件，它的链接**保留**。这个子集的改动严格小于用户看过的 diff，所以不再确认，但会在报告里列出差异：`2 archive moves skipped — their index lines were kept`。
3. 每个索引文件生成一个 `REPLACE(live:idx, raw)`，期望 `live:idx` 等于展示 diff 时读到的 sha（base sha）；结果原样写入，不调 `upsertFrontmatterFields`。
4. `ARCHIVE.md`：文件已存在 ⇒ `REPLACE(archive:ARCHIVE.md)`，带 base sha；不存在 ⇒ `CREATE(archive:ARCHIVE.md)`，期望它 `absent`。追加内容同样只包含 `done` 的那些行。
5. 某个 op 的 CAS 不满足 ⇒ 跳过并报告，**绝不**整文件覆盖。所有归档都被跳过 ⇒ 不生成索引 / `ARCHIVE.md` 的 op。

## 7. Phase 3：有界规整（v2 不变，UI 改为有界）

- 规划：重新取快照、重新分批，用 `confirm(..., { signal })` 确认：`Normalize 14 files in 2 batches (reserve ≤$1.30, ≤25 min)?`。加了 `--archive-only` 就跳过这一阶段。
- 派发：
  - 用 `buildTidyPrompt` 加 `batch` 字段。
  - 迁移模式只出现在一批里，其余批写明 `Do not create core.md`。
  - 用 `validateTidyProposal` 加 `existingNames` 校验。
  - 每个 run 都设 `toolDomain: "readonly"`，`totalMs` 受剩余总时限约束（§8.2）。
- 汇总审阅，基于 `select`：
  - `"Apply suggested (N)"`
  - `"Toggle items…"`：进入 §6.1 那样的切换列表
  - `"View diff…"`：先选一项，再用有界查看器打开
  - `"Discard all"`
  - 以下几类不进入可选集合：手写文件、`!canApply`、超出上限的 run、没有到达终态的 run。
- 应用：提案逐个翻译成 op：
  - `rewrite` ⇒ `REPLACE(live:n, stamp)`，`stamp` = 现行的 `source: agent` + `updated` 语义
  - `create` ⇒ `CREATE(live:n)`
  - `delete` ⇒ `MOVE(live:n → backup:b)`
  - `rename` ⇒ `CREATE(live:new, content)` 加 `MOVE(live:old → backup:b)`，组成同一组（`group` 字段，§9.2）

## 8. 运行预算与有界交互

### 8.1 成本：有界上限（bounded cap，M-T6）

账本放在 `run-ledger.ts`，是纯函数，结构与 v3 相同（预留 + 结算），本版只有两处改动：

- `watcherCap = max(0, min(tidy.maxCostUsd, cap − spent − Σreserved_{others}))`。值 ≤ 0 时不派发。
- `settle` 只接受有限且非负的 `costUsd`；否则按 `max(reservation, est)` 记账，并停止派发。

**这个上限承诺什么（如实表述，不称「硬上限」）**：

- 派发前先预留；一旦 `spent + Σreserved + est > cap`，就停止派发。
- **最大超支 ≤ 一个仍在运行的 run 的最后一回合**。原因：watcher 只在回合边界判定（`watcher.ts:20-34,58-71`），回合内部无法中止。
- 单回合上界 `maxTurnCost = 0.9·contextWindow·max(input, cacheWrite) + maxTokens·output`，预览中显示为：`bounded cap $5.00 (max overshoot ≤ one turn, ≤$X)`。
- 无价模型没有美元闸，所有展示面一律写 `no cost guarantee`。
- 超过上限的结果一律丢弃（与 v3 相同）。

### 8.2 命令级上限

- `maxModelRuns`：默认 6，triage 和 normalize 合并计数，规划和派发阶段各检查一次。
- `totalTimeoutMs`：默认 45 min，是一个**活动时钟**——只要有模型 run 在跑、或者在 `waitOutcome`、abort 后等终态、排空，就计时。每个 run 的 `totalMs = min(timeoutFor(b), remaining − 60_000)`；`remaining < 60 s` 时不再派发（`stopped = "deadline"`）。对话框里的停留时间不计入活动时钟，但对话框本身有上界（§8.5）。

### 8.3 超上限结果

见 §8.1 的「结果丢弃」。报告格式：`batch 3 discarded: cost $2.31 over cap`。

### 8.4 abort 协议（v2 #4，不变）

1. 依次调用 `abort` 和 `waitOutcome(runId, 15_000)`，等待时间同时受活动时钟约束。
2. 若 run 到达终态：先 `settle`，再进入下一阶段。
3. 若仍未到达终态：
   - 把 runId 写入 lease 的 `draining[]` 和 manifest 的 `run.unsettledRuns`；
   - 本阶段不 apply，也不进入下一阶段；
   - lease 不释放，预留不释放；
   - 本进程注册一个 unref 的 waiter，上界为该 run 的 `hardDeadlineAt + 30 s`。run 到达终态后执行 `settle` 并移除 runId；`draining[]` 清空后释放 lease。

### 8.5 对话框上界（Major 3）

- 所有决策都走 `select` / `confirm`（E11），每次调用都传 `{ signal: dialogSignal() }`。
  - `dialogSignal` 是一个 `AbortController`，带 unref 计时器，单个对话框上限 `DIALOG_MAX_MS = 600_000`（10 min）。
  - 所有对话框累计上限 `UI_TOTAL_MS = 3_600_000`（60 min），超过后后续对话框直接视为取消。
- 不传 `timeout`，以免 TUI 显示倒计时。
- 查看器是 §6.3 的 `ui.custom`，用同一个 deadline 调 `done()`。
- **完全不用 `ui.editor`**。v2 里的「Edit selection」和「Edit then apply」在 batch 流程中都删掉了；需要手工修改的，用现行 `/mem tidy <file>` 处理。
- 对话框超时或取消 ⇒ 按所在阶段 fail-closed：
  - Phase 2：一个文件都不归档；
  - Phase 3：一个提案都不应用；
  - 已经 apply 完的 step 保持不变。
- 由此得到 lease 的最长持有时间：`totalTimeoutMs + UI_TOTAL_MS + 15 s + 排空上界`，且有限。`--status` 会显示这个值。

## 9. 事务模型：写前日志（核心）

### 9.1 位置、身份与 tmp 名（v3.2：单一命名语法）

`contracts.ts` 是下列类型的唯一归属（v3.1 已定），其他地方只能 `import type`：

```ts
type Area = "live" | "archive" | "backup" | "trash";
type Loc = { area: Area; name: string } | { area: "tmp"; within: Area | "root"; name: string };
interface Ident {
  dev: number;
  ino: number;
  sha: Sha;
  size: number;
}
type Obs =
  | { kind: "absent" }
  | ({ kind: "file" } & Ident)
  | { kind: "other"; reason: "symlink" | "not-file" | "unreadable" | "racing" | "too-large" };
```

**tmp 命名（M-T8；v3.2 Major 1：全仓唯一语法）**

新模块 `src/memory/tmp-names.ts`，pi-free，不触碰 fs，因此不受 `fs-guard` 限制：

```ts
export const TMP_KINDS = {
  b: "op-backup",
  c: "op-content",
  m: "manifest",
  l: "lock",
  e: "lease",
  p: "probe",
  o: "epoch",
} as const;
export const TMP_RE = /^\.pt-([0-9a-f]{8})-(\d{1,6})-([bcmlepo])\.tmp$/;
export function tmpNameFor(nonce8: string, seq: number, kind: keyof typeof TMP_KINDS): string; // 生成结果必须通过 TMP_RE，否则抛错
export function parseTmpName(name: string): { nonce8: string; seq: number; kind: TmpKind } | undefined;
```

- `nonce8`：op 类 tmp 用 run id 随机段的前 8 位 hex；非 op 类（lock/lease/epoch/probe/manifest）每次调用新取 `randomBytes(4)`。
- `seq`：op 序号；非 op 类固定为 `0`。
- **所有** tidy、事务、锁、lease、epoch 相关的 tmp 都只能通过 `tmpNameFor` 生成，其中包括 v3.1 里的 `lockCreate` tmp——原先的 `.pt-lock-<8hex>.tmp` 不符合 `TMP_RE`，v3.2 统一为 `tmpNameFor(nonce, 0, "l")`。
- `resolveLoc` 与 `parseManifestStrict` 都只认 `TMP_RE`。
- 现有的 `writeTempRegular`（`safe-fs.ts:372-373`）继续给 v2 工具和 import 路径用 `.${name}.…tmp`，这部分**不改**。这类旧格式 tmp 只由它们各自的写入方产生和清理，事务层永远不会去碰。
- **G-tmpgrammar**：
  - 全部生成器（op b/c、manifest、lock、lease、epoch、probe）各取 10⁴ 个样本，必须全部匹配 `TMP_RE`；
  - 对仓库源码做 grep，断言 `src/memory/**` 中只有 `tmp-names.ts` 定义了 `.pt-` 前缀和 `TMP_RE`。

撞名（`O_EXCL` 返回 EEXIST）⇒ `TMP_COLLISION`，该 op 在改动磁盘之前就失败（M-T8）。

### 9.2 journal 结构与事件边界（v3.2 Major 5）

manifest v2 由两部分组成：头部 `{ v: 2, id, kind, createdAt }`，加一个只追加的 `events: JournalEvent[]`。每次追加都走 §9.3 的 `appendJournal`：先写 `.pt-…-m.tmp`，再 rename，最后对目录做一次 best-effort fsync。

```ts
type JournalEvent =
  | { ev: "run"; state: RunState; owner?: Owner; epoch: number; recoveryOwner?: Owner }
  | { ev: "intent"; opId: string; seq: number; step: number; group?: number; phase: Phase; op: OpSpec }
  | { ev: "staged"; opId: string; which: "backup" | "content"; tmp: Loc; ident: Ident }
  | { ev: "attempt"; opId: string; by: "owner" | "recovery"; n: 1 } // v3.2：补偿或恢复动作开始前必须先写这一条
  | {
      ev: "result";
      opId: string;
      state: "done" | "rolled-back" | "skipped" | "conflict";
      reason?: string;
      final: { loc: Loc; obs: Obs }[]; // v3.2 Major 3：强制写入的最终观测
      leftovers?: { loc: Loc; obs: Obs }[];
    };
type OpSpec =
  | { prim: "MOVE"; src: Loc; dst: Loc; obj: Ident } // obj = 源对象身份（规划期观测，CAS 复核）
  | { prim: "CREATE"; target: Loc; afterSha: Sha; tmpContent: Loc }
  | { prim: "REPLACE"; target: Loc; before: Ident; afterSha: Sha; backup: Loc; tmpBackup: Loc; tmpContent: Loc };
```

**各边界的崩溃语义与认领规则**

| 崩溃点（最后成功追加的事件）                                        | 磁盘可能的状态                           | 恢复方的认领与处理                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 还没有 manifest                                                     | 未动（第一个 `intent` 之前不做任何改动） | 无需恢复                                                                                                                                 |
| `run(applying)` 之后、第一个 `intent` 之前                          | 未动                                     | 认领（规则见表下），没有 op ⇒ `run(recovered)`                                                                                           |
| `intent` 之后、CAS 之前或 CAS 期间                                  | 未动                                     | 按 §9.4 判定，结果是 B/∅ ⇒ `rolled-back`                                                                                                 |
| `intent` / `staged` 之后、有改动但没有 `attempt`、也没有 `result`   | 处于 §9.3 列出的某个中间态               | 先写 `attempt(by: recovery)`，再执行**一次**判定动作，然后写 `result`                                                                    |
| 已有 `attempt`、没有 `result`（上一次补偿或恢复进行到一半就崩溃了） | 动作可能执行了一部分                     | **只观测，不动作**（M-T3）：观测已经干净（主位置是 B 或 A，且没有遗留对象）⇒ `rolled-back` / `done`；否则 ⇒ `conflict`，列出全部遗留对象 |
| 已有 `result`                                                       | 已收敛                                   | 跳过                                                                                                                                     |
| 所有 op 都有 `result`，但缺终态 `run` 事件                          | 已收敛                                   | 只追加终态：有任何 conflict ⇒ `conflict-reported`，否则 `recovered`                                                                      |

认领规则：

- **谁能认领**：只有当 manifest 最后一个 `run` 事件是 `applying` 或 `interrupted`，并且其中的 owner / recoveryOwner **已死或已被撤销**（§10.3；撤销即 epoch 落后，见 §10.2），恢复方才能认领。
- **怎么认领**：恢复方先按 §10.1 拿到 lease，再在目录锁内追加 `run(interrupted, recoveryOwner = 自己, epoch = 当前)`。
- 两个恢复方的并发由 lease 的 `O_EXCL` 互斥保证。

**M-T3 的落实方式**

- 执行期出错时，本 owner 在同一个锁块内的补偿（§9.4.4）也要先写 `attempt(by: owner)`。
- 不论动作来自 owner 还是 recovery，任何 opId 一旦出现过 `attempt`，后续都不会再执行动作。G-boundaries 会对每条边界注入崩溃，并断言 `attempt` 事件不超过 1 次、动作调用次数不超过 1 次。

### 9.3 safe-fs 原语契约（v3.1 的 B2 已基本认可；v3.2 修订部分加粗）

**共同约定**

- 只能在 `withMemoryDirLock` 的同步 body 里调用。
- 失败统一抛 `TxnFsError { code, mutated }`。
- 所有读取都用 `O_NOFOLLOW`。
- 每次 link/rename/unlink 之后，对父目录做 best-effort fsync（M-T1）。
- 不存在 `renameat2`（E26）。
- **每个 mutating syscall 之前都要执行两项检查**：
  - `verifyDir(containingDir)`（M-T9）：重新 `lstat`，要求是目录、不是 symlink，`(dev, ino)` 与 `openRunDirs` 时记录的一致；
  - `assertEpoch(runEpoch)`（§10.2）。
  - 任一不符 ⇒ 抛 `DIR_SWAPPED` 或 `EPOCH_REVOKED`。执行器把这两种情况一律当作当前 op 的 **conflict**（`EPOCH_REVOKED` 时连 journal 都不写，见 §10.2），并中止所在 step。

**`openRunDirs(liveReal, id, { createArchive, createBackup }) → RunDirs`**

为每个区域记录 `RunDirs[area] = { path, dev, ino }`：

- `live`：canonical 路径。
- `root`：同 `live`，用于存放 lock / lease / epoch 的 tmp。
- `archive`：`join(liveReal, "archive")`。要求 `lstat` 结果是目录、不是 symlink，并且 `realpathSync(path) === path`。目录不存在时，只有传了 `createArchive` 才执行 `mkdir 0o700`；已存在的目录不改权限。
- `backup`：`.backup/<id>`，用 `ensurePrivateDir` 创建（`safe-fs.ts:122-128`）。
- `trash`：`.trash`，只读，不创建。

`verifyDir(d)`：重新 `lstat(d.path)`，必须是目录、不是 symlink，且 `(dev, ino)` 与记录一致。否则抛 `DIR_SWAPPED(mutated:false)`，执行器把当前 op 判为 conflict，并中止所在 step（M-T9）。

**`resolveLoc(dirs, loc) → { dir: RunDir; name }`**

纯查表并校验名字，是**唯一**的路径拼接点。各区域的名字规则：

- live / archive：`isV2Name`（`safe-fs.ts:170`）。
- backup：`^s\d{1,3}-\d{1,5}-(live|archive|trash)--<v2name>$`。
- trash：`listTrashEntries` 的格式（`manifest.ts:177-193`）。
- tmp：**只认 `TMP_RE`**，解析到 `within` 所指的目录（`root` 即 memory 目录本身）。

不符合规则则抛 `INVALID_LOC`。

**`observeLoc(dirs, loc) → Obs`**

基于 `openRegular`（`:286-320`）和 `readRegular`（`:327-337`），不改动磁盘：

1. `verifyDir`；
2. `lstat`：ENOENT ⇒ `absent`；symlink ⇒ `other:symlink`；不是普通文件 ⇒ `other:not-file`；
3. `open(O_RDONLY|O_NOFOLLOW)`：ELOOP ⇒ `other:symlink`；
4. `fstat` 与 `lstat` 比较 `(dev, ino)`：不一致就重试一次，仍不一致 ⇒ `other:racing`；
5. 读取全部内容，上限为 `maxFileBytes × 2`，超出 ⇒ `other:too-large`；
6. 计算 sha256，关闭文件。

**`writeTmpLoc(dirs, tmp, bytes) → Ident`**

调用方提供名字，基于 `writeTempRegular`（`:372-397`）：

1. `verifyDir(within)`、`assertEpoch`；
2. `open(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0o600)`：EEXIST ⇒ `TMP_COLLISION(false)`；
3. `writeAll`，`fsyncSync(fd)`；
4. `fstat` 取得 `(dev, ino)`，关闭文件；sha 由 `bytes` 计算。

写入失败时：先确认 `lstat` 得到的 `(dev, ino)` 与 `fstat` 一致，再 unlink，然后抛 `IO(false)`；如果这次清理也失败，抛 `IO(true)`，并把残留文件记入 leftovers。

崩溃时可能留下「tmp 已存在但没有 `staged` 记录」的状态，按 §9.4 的「X 不删、判 conflict」处理。

**`unlinkObservedLoc(dirs, loc, expect: { dev; ino; sha })` → `"unlinked" | "absent"`**

基于 `unlinkRegular`（`:541-555`）。**v3.2 起 `sha` 为必填。**

1. `verifyDir`、`assertEpoch`；
2. `lstat`：ENOENT ⇒ 返回 `"absent"`（幂等）；symlink 或不是普通文件 ⇒ `OWNERSHIP`；`(dev, ino)` 不一致 ⇒ `OWNERSHIP`；
3. `open(O_NOFOLLOW)`，`fstat` 确认 `(dev, ino)` 一致，计算 sha 并要求相等，否则 `OWNERSHIP`；
4. 再次 `verifyDir`；
5. `unlinkSync`，然后对父目录做 best-effort fsync。

残余 TOCTOU 与 E23 相同（M-T9）。

**`fsyncDirBestEffort(path)`**

依次 `open(O_RDONLY|O_DIRECTORY)`、`fsync`、关闭。出错时每个 run 只 WARN 一次（M-T1）。

**`probeHardlinks(dirs) → void`（v3.2 新增，Major 2）**

batch、restore 和 txn 化之后的 tidy 在**写入第一个 `intent` 之前**都要调用一次。对 live、archive、backup 这三个目录，每个目录依次执行：

1. `writeTmpLoc(tmpNameFor(n, 0, "p"))`
2. `link` 到另一个 `p` 类名字
3. 对两个名字各执行一次 `unlinkObservedLoc`

任何一步出现 EPERM、ENOTSUP、EOPNOTSUPP、ENOSYS 或 EXDEV，都抛出 `NO_HARDLINK(mutated:false)`，命令以下面的提示退出：

`memory dir <path> is on a filesystem without hard-link support (<code>) — /mem tidy --batch and restore need link(2) for no-clobber moves; move ~/.pi/agent/memory to a local filesystem or use plain /mem tidy <file>`

如果探测残留的 tmp 清理失败，这些 tmp 会列为无主对象，在 `--status` 中报告。

**`moveLocNoClobber(dirs, from, to, expect: Ident)`（v3.2：去掉 rename 回退）**

1. 两个目录都执行 `verifyDir` 和 `assertEpoch`。
2. `lstat(from)`：必须是普通文件，且 `(dev, ino, size)` 与 `expect` 一致；sha 已由同一锁块中做 CAS 的 `observeLoc` 核对过。
3. `lstat(to)`：必须是 ENOENT。
4. `link(from, to)`：
   - EEXIST ⇒ `EXISTS(false)`；
   - EPERM / ENOTSUP / EOPNOTSUPP / ENOSYS / EXDEV ⇒ **`NO_HARDLINK(false)`，fail closed，不做任何回退**。v3.1 里「先 lstat 再 rename」的非原子 no-clobber 回退和风险 R11 一并删除。
5. 后验：`lstat(to).(dev, ino) === expect`。
6. 再次 `verifyDir` 并 `lstat(from)`，`(dev, ino)` 仍等于 `expect` 时才 `unlink(from)`，否则抛 `OWNERSHIP(true)`。

可能的崩溃状态有三种，都只需 `intent` 即可覆盖（对象身份在 intent 里已经提前记下）：

- (a) link 之前：处于 before 状态；
- (b) link 之后、unlink 之前：同一个 ident 有两个名字（§9.4.1 的 M2）；
- (c) unlink 之后：处于 after 状态。

**`createLocExclusive(dirs, target, tmp, bytes, onStaged)`（v3.2 Major 2/3）**

1. `ident = writeTmpLoc(tmp)`。tmp 必须与 target 在**同一目录**。
2. `onStaged(ident)`：追加一条 `staged`。
3. `verifyDir`，然后 `assertEpoch`。
4. `link(tmp, target)`：
   - EEXIST ⇒ `EXISTS(true)`；
   - EPERM / ENOTSUP / EOPNOTSUPP / ENOSYS / EXDEV ⇒ **`NO_HARDLINK(true)`**。这种情况本来已经被 `probeHardlinks` 预先拦住；如果仍然出现，执行器会写 `attempt` 并回滚——tmp 已经 staged，所以由 C2 删除它——然后以 `NO_HARDLINK` 的提示中止整个 step。**绝不退化为非独占写入。**
5. **后验（Major 3）**：执行 `observeLoc(target)`，`(dev, ino)` 和 **sha** 必须都等于 `ident`，否则抛 `OWNERSHIP(true)`。
6. 再次 `verifyDir`，然后 `unlinkObservedLoc(tmp, ident)`。

**`replaceLocAtomic(dirs, target, tmp, bytes, expect: Ident, onStaged)`（v3.2 Major 3）**

1. `writeTmpLoc(tmp)`。tmp 必须与 target 在同一目录。
2. `onStaged(ident)`。
3. `verifyDir`，然后 `assertEpoch`。
4. 再做一次 `observeLoc(target)`，结果必须等于 `expect`，否则抛 `CAS_FAILED(true)`。
5. `renameSync(tmp, target)`。
6. **后验**：执行 `observeLoc(target)`，`(dev, ino)` 和 **sha** 必须都等于 `ident`，否则抛 `OWNERSHIP(true)`。

**`appendJournal(dirs, manifestName, event)`（v3.2 明确）**

1. 持锁读取当前 manifest，用 `parseManifestStrict` 解析。
2. **`assertEpoch(runEpoch)`**。
3. 追加事件，写入 `tmpNameFor(nonce, 0, "m")`。
4. `verifyDir`，然后 `renameSync` 覆盖 `manifest.json`。
5. best-effort 地 fsync 目录。

被撤销的 owner 不能再追加任何事件（§10.2）。

**强制最终观测（Major 3）**

op 的结论写进 `result` 之前，执行器（正常路径和恢复路径都一样）必须先对该 op 的**所有**位置（src/dst/target/backup/tmpBackup/tmpContent）各调用一次 `observeLoc`，结果写入 `result.final`。`state` 由最终观测按 §9.4 的规则重新判定：

- `done` 要求最终观测中主位置全部是 A，且不存在遗留对象；
- `rolled-back` 要求主位置全部是 B 或 ∅，且不存在遗留对象；
- 其余情况一律为 `conflict`。

执行过程中记下的「成功」不能代替最终观测。G-final-observe 用 hook 在后验与 `result` 之间篡改 target，断言 op 被判为 conflict。

**op 与原语的对应关系**：每个 op 依次执行 `intent` → 锁内 CAS（所有位置都做 `observeLoc`）→ 原语序列 → **最终观测** → `result`。

| op      | 原语序列                                                                                                          | 中间追加的 `staged`       |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| MOVE    | `moveLocNoClobber(src, dst, obj)`                                                                                 | 无                        |
| CREATE  | `createLocExclusive(target, tmpContent, bytes)`                                                                   | `content`                 |
| REPLACE | `createLocExclusive(backup, tmpBackup, beforeBytes)` → `replaceLocAtomic(target, tmpContent, afterBytes, before)` | 先 `backup`，后 `content` |

### 9.4 恢复判定 `decide(events, obs) → Verdict`（B1）

`decide` 是纯函数（`journal.ts`）。它的输入包括：该 op 的 `intent`、所有已追加的 `staged`，以及**每个 op 名下位置**的观测值（src/dst/target/backup/tmpBackup/tmpContent）。

**分类**：对每个位置，把观测值归入以下五类之一：

- `B`：与该位置的 before 对象身份一致（MOVE 的 src = `obj`；REPLACE 的 target = `before`；其余位置的 before 都是 absent）；
- `A`：与该位置的 after 对象身份一致（MOVE 的 dst = `obj`；target = staged content；backup = staged backup）；
- `S`：与某个 staged tmp 的身份一致（只对 tmp 位置适用）；
- `∅`：不存在；
- `X`：除上述之外的一切，包括：位置上有文件、但它没有 staged 记录（**无法证明归属**），或者它的身份或 sha 与记录都不符。

**总原则**（v3.2 增补：`DIR_SWAPPED`、`EPOCH_REVOKED`、`NO_HARDLINK` ⇒ conflict 并中止所在 step，见 §9.4.4）

- 主位置有任何一个落在 `X` ⇒ **conflict**：不回滚，也不当作无操作处理。
- 处理遗留对象时，只能对**身份已证明**（属于 `S` 或本 op 的 `A`/`B` 副本）的对象调用 `unlinkObservedLoc(expect = 记录的身份)`。属于 `X` 的对象一律不动，把它连同 `obs` 写进 `leftovers`，op 判 conflict。
- 补偿性的 unlink 本身失败（M-T3）⇒ 该 op 判 conflict，把遗留对象写进 `leftovers`，**不重试**。

#### 9.4.1 MOVE(src→dst, obj)

| #   | src                            | dst                             | 判定                                   | 动作                                                       |
| --- | ------------------------------ | ------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| M1  | B                              | ∅                               | 尚未执行，**两个位置都还是 before**    | 无动作 → `rolled-back`                                     |
| M2  | B                              | A，且与 src 是同一 `(dev, ino)` | link 已做，unlink 还没做               | 前滚：`unlinkObservedLoc(src, obj)` → `done`               |
| M3  | ∅                              | A                               | 已完成                                 | `done`                                                     |
| M4  | B                              | X（外来对象）                   | dst 被他人占用                         | **conflict**，不动任何东西（v3 判回滚，现已改为 conflict） |
| M5  | X（src 已变化，同 inode 也算） | ∅                               | src 被他人改动                         | **conflict**（v3 判回滚，现已改为 conflict）               |
| M6  | X                              | A 或 X                          | 内容被原地改写，或者两边都有别人的东西 | conflict                                                   |
| M7  | ∅                              | X                               | 移动之后 dst 被改                      | conflict                                                   |
| M8  | ∅                              | ∅                               | 被外部删除                             | conflict(missing)                                          |
| M9  | 任一位置 `other`               | —                               | —                                      | conflict                                                   |

#### 9.4.2 CREATE(target, tmpContent)

| #   | target | tmpContent                | 判定 / 动作                                                                         |
| --- | ------ | ------------------------- | ----------------------------------------------------------------------------------- |
| C1  | ∅      | ∅                         | 尚未执行 → `rolled-back`                                                            |
| C2  | ∅      | S                         | 回滚：`unlinkObservedLoc(tmp, staged)` → `rolled-back`                              |
| C3  | ∅      | X（未入账或身份不符）     | **conflict**：target 处于 before，tmp 不动，记入 leftovers（没有入账的 tmp 不能删） |
| C4  | A      | S，且与 target 同一 inode | 前滚：`unlinkObservedLoc(tmp)` → `done`                                             |
| C5  | A      | ∅                         | `done`                                                                              |
| C6  | A      | X                         | target 处于 after，但 tmp 名下是外来对象 ⇒ **conflict**，记入 leftovers（不删）     |
| C7  | X      | 任意                      | conflict：若 tmp 属于 S，用 `unlinkObservedLoc` 删除，target 不动                   |

#### 9.4.3 REPLACE(target, before, backup, tmpBackup, tmpContent)

前提：after 状态要求 `target=A` **且** `backup=A(staged backup)`。

| #   | target     | backup     | tmpBackup                           | tmpContent | 判定 / 动作                                                                                                |
| --- | ---------- | ---------- | ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| R1  | B          | ∅/A        | ∅/S（S 与 backup 可能是同一 inode） | ∅/S        | **回滚**：对存在的 tmpContent、tmpBackup、backup，按 `staged` 身份逐个 `unlinkObservedLoc` → `rolled-back` |
| R1x | B          | 任一属于 X | 或 X                                | 或 X       | **conflict**：只删 S/A 类对象，X 类不动，记入 leftovers；target 仍是 before，内容一致                      |
| R2  | A(content) | A(backup)  | ∅/S                                 | ∅          | **前滚**：删除属于 S 的遗留对象 → `done`（这就是 backup(old) + live(after) 的情形）                        |
| R2x | A          | A          | X                                   | X          | 前滚完成，但存在外来遗留对象 ⇒ conflict(leftover)，target 保持 after                                       |
| R3  | A          | ∅/X        | —                                   | —          | conflict(backup-missing)，不动 target                                                                      |
| R4  | X          | 任意       | —                                   | —          | conflict：只删 S 类 tmp；**不删 backup**（它可能是 before 内容唯一的副本）                                 |
| R5  | ∅          | 任意       | —                                   | —          | conflict(missing)，保留 backup                                                                             |
| R6  | `other`    | —          | —                                   | —          | conflict                                                                                                   |

#### 9.4.4 group、执行期失败与 M-T3

- **group**（rename 拆成 `CREATE(new)` + `MOVE(old→backup)`，两个 op 相邻且顺序固定）：
  - CREATE 判为 `done`，且 MOVE 处于 M1 ⇒ 在锁内做 CAS 后，继续执行这个 MOVE。这一步本身是一个动作，所以要先写 `attempt`。
  - CREATE 判为 `rolled-back` ⇒ MOVE 必然处于 M1 ⇒ 标记为 `rolled-back`。
  - 其他组合 ⇒ 两个 op 都判 conflict。
- **执行期失败**：原语抛错且 `mutated: true` 时，执行器在同一个锁块内依次执行：
  1. 追加 `attempt(by: owner)`；
  2. 观测；
  3. `decide`；
  4. 执行判定出的动作，**只执行一次**；
  5. 做最终观测并写 `result`。

  `mutated: false` 时，直接做最终观测并写 `result(skipped)`。
  以下错误一律判为 conflict，并中止所在 step（不只是当前 op），因为这说明运行环境已经不可信：`DIR_SWAPPED`、`EPOCH_REVOKED`、`NO_HARDLINK`。

- **M-T3**：同一个 opId，最多只有一次 `attempt`，动作也最多执行一次（见 §9.2 的边界表）。补偿动作失败时，op 判为 conflict，并在 `leftovers` 中列出未清理的对象；run 的终态为 `conflict-reported`。

#### 9.4.5 安全性质（v3.2 增补）

v3.1 的性质 1–5 继续有效，另外新增：

6. 每个 `result` 都带 `final`，`state` 与 `final` 按 §9.4 重新判定的结果一致（G-final-observe）。
7. 在 §9.2 的每条边界上注入崩溃，然后反复恢复（最多 3 次）。断言每个 opId 的 `attempt` 不超过 1 次、动作调用不超过 1 次，最终都进入终态（G-boundaries）。
8. epoch 被撤销之后，旧 owner 不会再产生任何 fs 变更，包括 journal 追加（G-epoch）。

### 9.5 执行器与分块（v3 不变）

- `txn.ts` 的 `runStep`：在一个锁块内，耗时 ≥ `BLOCK_BUDGET_MS = 2000`（journal 追加的时间也算在内）或已执行 20 个 op，就结束这一块。
- 现行 `/mem tidy` 和 `--frontmatter` 的 apply 也改为走它；对外行为不变（§15 Q7）。

### 9.6 run 状态机（v3.1 + v3.2：撤销视同死亡）

| 从            | 事件                                                             | 到                                  | 由谁   |
| ------------- | ---------------------------------------------------------------- | ----------------------------------- | ------ |
| （无）        | 追加 `run(applying, owner, epoch)`                               | `applying`                          | 发起方 |
| `applying`    | 全部 op 都有 result，且全是 done / rolled-back / skipped         | **`complete`**                      | 发起方 |
| `applying`    | 用户停止、触及上限或出错，所有 op 都已出 result，且没有 conflict | **`aborted`**                       | 发起方 |
| `applying`    | 任意 op 判为 conflict（含 M-T3、`DIR_SWAPPED`、`NO_HARDLINK`）   | **`conflict-reported`**             | 发起方 |
| `applying`    | owner 已死，**或 epoch 已被撤销**（§10.2）                       | `interrupted`（记录 recoveryOwner） | 恢复方 |
| `interrupted` | recoveryOwner 已死或被撤销                                       | `interrupted`（重新认领）           | 恢复方 |
| `interrupted` | 全部判定完毕，没有 conflict                                      | **`recovered`**                     | 恢复方 |
| `interrupted` | 存在 conflict                                                    | **`conflict-reported`**             | 恢复方 |

- 终态有四个：`complete | aborted | recovered | conflict-reported`。到达终态后，可以发起新 run，也可以 restore；终态的 manifest 里不能有缺少 result 的 op。
- `interrupted` 只是在途标记，不会永久停留在这个状态。
- 被撤销的 owner 不能写入终态事件（它连 journal 都写不了），它的 run 一律交给恢复方收尾。G-state 测试覆盖上表每一条转移，以及「恢复完成后可以立刻发起新 run」。

### 9.7 restore（v3 的多位置设计已认可；加入 M-T2）

- **v2 源**：沿用 v3 的逆操作表。逆操作的期望值由「规划时的观测」与「源 op 的 after 身份」一起决定，现在带 `(dev, ino, sha)`：
  - 撤销归档 = `MOVE(archive:n → live:n, obj = 观测到的 archive:n 身份)`，并要求观测身份的 sha 等于源 `obj.sha`，同时 `live:n = ∅`；
  - 撤销 REPLACE = `REPLACE(T, before = 观测到的 T，且 sha 必须等于源 afterSha, 内容取自源 backup)`；backup 用 `observeLoc` 核对，必须等于源中 staged 的 backup 身份；
  - 其余逆操作同理。
  - `Overwrite` 只对 REPLACE 提供，并且以用户看到的内容身份作为期望值。restore 自己会写 manifest（kind `restore`），可以恢复，也可以再撤销。成功后调用 `onAfterWrite`（`command.ts:105-108`）。
- **v1 源（M-T2）**：
  - 只读列出，标记 `legacy (no sha) — restore requires --legacy`；
  - 恢复需要 `/mem restore <id> --legacy`，外加一次显式确认：`Legacy backup has no content hashes; every overwritten target will be backed up first. Continue?`；
  - 执行时，**每个会被覆盖的目标**都先由事务层 REPLACE 生成一份备份（期望值取当时的观测）；在目标原本不存在的位置上执行 CREATE；
  - 不会把 v1 manifest 自动转换或改写成 v2。
- **`--trash`**：沿用 v3 的做法，`MOVE(trash → live)`，期望 `trash` = 观测身份、live 不存在。覆盖时组成 group：`MOVE(live → backup′)` + `MOVE(trash → live)`。

### 9.8 manifest 严格校验（v3 Major 6，按事件格式更新）

`parseManifestStrict(raw, dirId)` 替换 `manifest.ts:95-102` 的类型断言，规则如下：

- **公共字段**：`id` 必须等于目录名，并且满足 `BACKUP_ID_RE`（`:130`）。
- **v1**：按字段类型校验，未知字段忽略；成功解析后标记为 legacy。
- **v2**：严格模式，出现未知字段即拒绝：
  - `events` 中：
    - `intent` 的 `seq` 从 1 开始连续递增，`opId` 唯一，`step` 不递减；
    - 每个 `staged` 或 `result` 都必须引用一个已经出现过的 `opId`；
    - 每个 op 至多一个 `result`，`staged` 的 `which` 不能重复；
    - **v3.2**：每个 opId 至多一个 `attempt`，且 `attempt` 必须出现在该 op 的 `result` 之前；每个 `result` 必须带 `final`，并且 `final` 的位置集合恰好等于该 op 的全部位置；每个 `run` 事件必须带非负整数 `epoch`，且在同一份 manifest 内不递减；
  - `OpSpec` 各原语的字段齐全，不允许多余字段；
  - `Loc` 用 `resolveLoc` 同一套规则校验，tmp 必须满足 `TMP_RE`；
  - `Ident` 中 `dev`/`ino`/`size` 为非负整数，`sha` 为 64 位 hex；
  - group 必须是两个相邻的 op，顺序为 CREATE 在前、MOVE 在后；
  - `run` 事件的状态转移必须与 §9.6 的表一致；
  - 处于终态时，不能有缺少 `result` 的 op。
- **校验失败时**：该 manifest 不参与恢复，不能被 restore，`--batch` 拒绝启动；`/mem restore` 列表里显示 `(invalid: reason)`。

## 10. lease、目录锁与持有者身份

### 10.1 run lease（v3 已认可）

- 位置 `.tidy-run.json`，用 `O_EXCL` 创建，内容写入方式见 §10.2 的原子写入。
- **会挡住**：其他 tidy/restore/batch。
- **不挡**：v2 工具和 import；它们与本 run 的冲突由 CAS 处理。
- `draining[]` 不为空时不释放 lease。
- 持有者身份的判定见 §10.3。

### 10.2 目录锁（M-T4）与 `--break-lock` 的 owner epoch（v3.2 Major 6）

**锁的创建（v3.2 修正 tmp 名）**

- `lockCreate` 依次执行：`writeTmpLoc(root, tmpNameFor(rand, 0, "l"), payload)` → `link(tmp, ".lock")` → `unlinkObservedLoc(tmp)`。`.lock` 一旦出现，内容就是完整的（E28）。
- 不支持 hard link 的文件系统**只对锁**走降级路径：使用旧的 `O_EXCL` 先创建再写入（`safe-fs.ts:754-770`）。这样做的代价是：进程崩溃时可能留下空 payload，按 M-T4 的规则这算「持有者不明」，必须用 `--break-lock` 处理。之所以接受这个降级，是因为不能让整个 memory 目录在这类文件系统上无法写入。txn 操作在这类文件系统上本来就已经被 `probeHardlinks` 拒绝了。
- `LockPayload` 增加两个字段 `startTicks?` 和 `bootId?`（`safe-fs.ts:744-749`；`lockRead` 的校验在 `:788-795`）。`lock.ts:66-79` 的 stale 判定改为：

| 锁的状态                                                                       | 判定                                    |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| 同 host、带 `startTicks`，pid 已死（ESRCH），或 `startTicks` / `bootId` 不一致 | 已死 ⇒ break                            |
| 同 host、带 `startTicks`，持有者存活                                           | **永不 break**，无论锁存在多久          |
| 同 host、旧格式（没有 `startTicks`），pid 已死（ESRCH）                        | 已死 ⇒ break                            |
| 同 host、旧格式，pid 存活（可能是 pid 被复用）                                 | 无法证明已死 ⇒ 不 break，等待超时后拒绝 |
| 跨 host，或 payload 无法读取                                                   | 持有者不明 ⇒ 不 break，等待超时后拒绝   |

- 拒绝时的提示（扩展 `lock.ts:80-84`）：`memory dir locked by pid N on <host> since <t> (owner cannot be verified) — if no pi process holds it, run /mem tidy --break-lock`。
- 影响面：上述规则作用于所有 memory 写入方（R9）；apply 的分块预算仍为 ≤ 2 s（§9.5）。

**owner epoch**

- epoch 记录在 `<dir>/.owner-epoch`，内容为 `{ "epoch": n, "at": iso, "by": { pid, host }, "reason": "break-lock" }`。文件不存在时视为 `epoch = 0`。写入方式与 manifest 相同：`tmpNameFor(rand, 0, "o")` 加 rename。
- **记录**：每个 txn run（batch、restore、txn 化后的 tidy / frontmatter）在追加 `run(applying)` 时，把当前 epoch 写进事件和 lease；之后的 recoveryOwner 也同样记录。
- **复查**：`assertEpoch(runEpoch)` 会在目录锁内读取 `.owner-epoch`，它大于 `runEpoch` 时抛出 `EPOCH_REVOKED`。调用位置有三类：
  - 每个 mutating syscall 之前（§9.3 共同约定）；
  - 每次 `appendJournal` 之前；
  - 每次刷新 lease 之前。
- **`/mem tidy --break-lock`**（只在 TUI 下可用，执行前需逐项 `confirm({signal})`）：
  1. 显示 `.lock` 和 `.tidy-run.json` 的持有者信息；
  2. 先写入 `.owner-epoch = old + 1`。这一步不需要拿目录锁，因为锁可能正被卡住的持有者占着；写入本身是原子的 rename；
  3. `lockBreak`（`safe-fs.ts:805-820`）；
  4. `leaseBreak`；
  5. 报告结果：`lock broken; owner epoch 3 → 4; run <id> will be recovered on the next /mem tidy --batch`。

  epoch 必须在打破锁之前递增。这样旧持有者不论在哪一步醒来，下一次复查都会失败。

- **旧持有者看到的结果**：
  - 当前 op 以 `EPOCH_REVOKED` 中止；
  - 不再追加任何 journal 事件，lease 不刷新，也不释放（lease 已被 break，`leaseRelease` 只按 token 删除）；
  - 有 UI 时弹出 `notify("tidy run <id> stopped: ownership was revoked by /mem tidy --break-lock (epoch 3 → 4) at <t>. Nothing more was written by this run; its journal will be recovered by the next /mem tidy --batch.", "warning")`；
  - 命令随即返回，状态栏被清空。
- **恢复**：manifest 中 `run.epoch < 当前 epoch` 的 run，按「owner 已撤销」处理（§9.6），恢复方可以认领。
- **残余窗口（明确声明）**：旧持有者在最后一次 `assertEpoch` 和随后那个 syscall 之间，仍然可能完成一次改动。这一次改动已经被写入它的 journal 中间态（intent / staged），恢复方会按真值表正常收敛。非 txn 写入方（v2 工具、import）本身不检查 epoch，它们的锁 body 只有毫秒级，这一窗口按 M-T9 的口径不在威胁模型内。

### 10.3 持有者身份（v3 已认可）

- `readProcIdentity(pid)` 读取 `/proc/<pid>/stat`，用 `parseStartTicks` 解析（`src/web-hub/protocol/proc-identity.ts:56-68`），再读取 `boot_id`。
- 同一 host 上，pid 存活且 starttime 一致 ⇒ 视为存活，永不 break。
- 非 Linux 或跨 host ⇒ 不自动 break，只能通过 `--break-lock` 处理。
- lease、run owner、recoveryOwner、目录锁四者使用同一套判定。

## 11. 设置（`memory.tidy.batch.*`；**★热点文件，硬门：sysload P0 合入之后才能施工**；内容与 v2 相同）

| 键                                           | 默认值    | 取值范围                                     |
| -------------------------------------------- | --------- | -------------------------------------------- |
| `enabled`                                    | `true`    | bool                                         |
| `targetBytes`                                | 32768     | 8192 – `maxInputBytes`（超出则钳到上限）     |
| `maxModelRuns`                               | 6         | 1–20                                         |
| `maxTotalCostUsd`                            | 5.0       | 0.1–100，不能为 0                            |
| `totalTimeoutMs`（文件里存 `totalTimeoutS`） | 2 700 000 | 300–7200 s；需登记到 `TIME_SETTING_MS_PATHS` |
| `outputTokPerSec`                            | 40        | 5–500                                        |

- `DIALOG_MAX_MS`、`UI_TOTAL_MS`、`BLOCK_BUDGET_MS` 都是代码常量，**不**做成设置项，免得再去碰热点文件（见 §15 Q6）。
- 解耦方式与 v2 相同：新建 pi-free 的 `batch-settings.ts`（`DEFAULT_TIDY_BATCH_SETTINGS`、`resolveTidyBatchSettings`）。P4 之前全部使用默认值。
- P4 需要改动的位置（行号均为「附近」，以届时 HEAD 为准）：`settings.ts` 的 `MemoryTidySettings.batch?` 定义、默认值和解析；`TIME_SETTING_MS_PATHS`；`setting-specs.ts` 的 memory.tidy 段。P4 只能在 sysload P0 合入 master 之后开工，并且要重新核对行号和 fixture。不得与 sysload 任何一个包并行修改这两个文件。

## 12. 拆包与文件域（★ 热点共享文件 / ◆ 共享装配点）

| 包                       | 内容                                                                                                                                                                                                                                                                                                                                                                                              | 独占文件                                                                                                                                                                                                              | 依赖                                                                                                                                 | 合并门                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 冻结面**            | 导出 `TIDY_MAX_FILES = 24`（M-T7）：`TIDY_SCHEMA` 的 `maxItems`（`contracts.ts:205`）与 `SCHEMA_LIMITS.maxFiles`（`validate.ts:48`）都改为引用它；新增 `Loc`/`Ident`/`Obs`/`JournalEvent`/`OpSpec`/manifest v2/`TRIAGE_SCHEMA`/账本类型；`batch-settings.ts`                                                                                                                                      | `src/memory/contracts.ts`、`src/memory/tidy/validate.ts`（仅常量这一行）、`src/memory/tidy/batch-settings.ts`、`tests/memory/tidy-batch-contracts.test.ts`                                                            | —                                                                                                                                    | **G-maxfiles**：`TIDY_SCHEMA.files.maxItems === TIDY_MAX_FILES === SCHEMA_LIMITS.maxFiles`，且 `BATCH_MAX_FILES === TIDY_MAX_FILES − 4`              |
| **P1 纯逻辑**            | `journal.ts`（`decide` + 状态机 + 事件折叠）；`batch-plan`、`archive-signals`、`index-edit`、`selection`、`run-ledger`；对 `snapshot`/`prompt`/`validate` 的小改                                                                                                                                                                                                                                  | `src/memory/tidy/{journal,batch-plan,archive-signals,index-edit,selection,run-ledger}.ts`、`snapshot.ts`、`prompt.ts`、`validate.ts` 及对应测试                                                                       | P0                                                                                                                                   | **G-decide**、**G-state**、G-pack、G-schema、G-headroom、G-grammar、G-selection、G-ledger、**G-tmpname**                                             |
| **P2 存储层**            | 按 §9.3 契约实现原语（`openRunDirs`、`resolveLoc`、`observeLoc`、`writeTmpLoc`、`moveLocNoClobber`、`createLocExclusive`、`replaceLocAtomic`、`unlinkObservedLoc`、`fsyncDirBestEffort`、`readProcIdentity`、`lease*`、原子 `lockCreate`）；`lock.ts` 改用 M-T4 规则；`txn.ts`（执行器 + `recoverRun`）；`manifest.ts` 严格解析；`apply.ts` 和 `restore.ts` 改走 txn（含 v1 `--legacy` 与 trash） | `src/memory/safe-fs.ts`、`src/memory/lock.ts`、`src/memory/tidy/{txn,manifest,apply,restore,lease}.ts` 及对应测试                                                                                                     | P0；P1 的 `journal.ts`                                                                                                               | **G-prims**、**G-txn**、G-CAS、G-nested、G-lease、**G-lock**、G-chunk、**G-manifest**、**G-legacy**、G-v1-compat、**G-fsync**；`fs-guard` 不新增例外 |
| **P-RT 派发实测 ★**      | `SpawnRequest.inputBudget`（★`src/core/types.ts`）；★`src/service/request-threading.ts` 字段分类；runtime-adapter 与 runner 的透传；`src/runtime/session-driver.ts` 在 `prompt()` 前测量，写入 `diag.dispatchMeasure`，超预算就 fail；`TidySpawnRequest.inputBudget`；◆`src/index.ts:1062-1077` 的映射                                                                                            | ★`src/core/types.ts`、★`src/service/request-threading.ts`、`src/service/runtime-adapter.ts`、`src/runtime/{session-driver,runner}.ts`、`src/memory/contracts.ts`（只加 `TidySpawnRequest` 一个字段）、◆`src/index.ts` | **sysload P0 合入之后**（`core/types.ts` 与 `request-threading.ts` 都在 sysload P0 冻结面里，见 `docs/dev/sysload/plan.md` §P0）；P0 | **G-measure**、**G-overhead**（conformance）                                                                                                         |
| **P3a 编排/UI**          | `batch-command.ts`、`ui/bounded-viewer.ts`；`command.ts` 中的路由、`--break-lock`、`--legacy`，以及 restore 传 `onAfterWrite`；`src/memory/command.ts` 的补全；`command-policy.ts` 放行                                                                                                                                                                                                           | `src/memory/tidy/{batch-command,command}.ts`、`src/memory/tidy/ui/bounded-viewer.ts`、`src/memory/command.ts`、`src/web-hub/agent/command-policy.ts`                                                                  | P1 + P2 + **P-RT**                                                                                                                   | G-abort、G-cost、G-bounds、G-dialog、G-surface、G-index-skip、**G-breaklock**、G-e2e                                                                 |
| **P3b triage（可裁剪）** | `triage.ts`                                                                                                                                                                                                                                                                                                                                                                                       | `src/memory/tidy/triage.ts` 以及 `batch-command.ts` 中的一个调用点                                                                                                                                                    | P3a                                                                                                                                  | G-triage                                                                                                                                             |
| **P4 设置 ★**            | batch 段                                                                                                                                                                                                                                                                                                                                                                                          | ★`src/config/settings.ts`、★`src/config/setting-specs.ts`、`tests/config/*` 中与 memory 相关的部分                                                                                                                    | **sysload P0 合入之后**                                                                                                              | G-settings                                                                                                                                           |
| **P5 文档 / 真机**       | 改 `optimize-plan.md` §7 中的指针；`AGENTS.md` 的 memory 条目（journal 模型、M-T4 锁规则、`--break-lock`）；更新本文状态                                                                                                                                                                                                                                                                          | 文档                                                                                                                                                                                                                  | P3a + P4                                                                                                                             | 真机清单                                                                                                                                             |

**热点规则（Minor 12）**

- P-RT 与 P4 必须在**独立 worktree** 中施工。
- 两者都要等 sysload P0 合入 master 之后，基于届时的 HEAD 重新确定基线，并重新核对行号和 fixture。
- 不得与 sysload 的任何包并行修改这些文件，也不得对它们执行批量格式化或生成式改写（prettier 只能作用于本包修改过的文件）。
- P1 与 P2 不受这条门限制，可以立即开工。

**v3.2 对文件域和合并门的增补**

- **P0**：新增 `src/memory/tmp-names.ts`，包含 `TMP_RE`、`tmpNameFor`、`parseTmpName`。
  - 合并门：**G-tmpgrammar**。
- **P2**：
  - 在 `safe-fs.ts` 中新增 `probeHardlinks`、`assertEpoch`、`readEpoch`、`bumpEpoch`；`lockCreate` 改用 `tmpNameFor`。
  - `txn.ts` 增加 `attempt` 事件、强制最终观测，以及 epoch 复查。
  - 合并门：**G-nohardlink**、**G-final-observe**、**G-boundaries**、**G-epoch**、**G-dirswap**。
- **P-RT（★，依赖 sysload P0 合入）**：
  - 新增 `src/runtime/input-budget-registry.ts`：进程级 `Symbol.for` 注册表，记录 `sessionId → { maxInputTokens, onMeasure, abort }`。
  - 在 `src/child/wire.ts` 中注册 `before_provider_request` 测量处理器。
  - `session-driver` 做第一段粗筛，`child_extension_missing` 时 fail closed。
  - 合并门：**G-measure**、**G-measure-real**（conformance）、G-overhead。
- **P3a**：`--break-lock` 改为执行 epoch 递增流程。旧 owner 收到的提示文案由 **G-breaklock** 钉住。

## 13. 测试（各包合并门；v3 已有的门沿用，下面只列新增或改动的）

**P0**

- **G-maxfiles**：见上表。

**P1**

- **G-decide**：对 §9.4 每张表，在 B/A/S/∅/X/other × 同 inode 与否 的全部组合上做穷举，结果与表逐行一致。重点断言：
  - M4、M5 判 conflict；
  - C3 判 conflict，并且不删除 tmp；
  - R1x 只删除属于 S 的对象；
  - R2 前滚；
  - R4 保留 backup。
- **G-state**：§9.6 中每条转移都要覆盖，其中包括 `applying → conflict-reported`。
- **G-tmpname**：`tmpNameFor` 的输出只含 `[A-Za-z0-9._-]` 并符合 `TMP_RE`；不受任何记忆文件名影响；撞名时返回 `TMP_COLLISION` 且磁盘零变化。

**P2（使用真实临时目录）**

- **G-prims**：§9.3 的每个原语逐一覆盖以下内容：
  - 每种错误码及其 `mutated` 值；
  - 用 hook 模拟：link 不被支持（EPERM）时走回退路径、EXDEV、目录被换成 symlink（`DIR_SWAPPED`）、目标被换成 symlink（返回 `OWNERSHIP`/`other`）；
  - 后验时 `(dev, ino)` 不一致；
  - `unlinkObservedLoc` 遇到不同 inode 或同 inode 但 sha 不同时一律拒绝；
  - `moveLocNoClobber` 跨 `archive/` 与 live、跨 trash 与 live 的往返。
- **G-txn**：
  - 在每个原语、每个步骤边界注入崩溃（包括 `onStaged` 前后），恢复后满足 §9.4.5 的五条性质；
  - 往 tmp 或 backup 的名下放外来对象（同名不同 inode、同 inode 但改过内容），断言它们**永远不会被删**；
  - 注入补偿 unlink 失败，断言 op 判 conflict、run 状态为 `conflict-reported`、只尝试一次。
- **G-lock**：
  - 旧格式锁、pid 存活、锁已存在 60 s ⇒ 不 break，并在 2 s 后报出可操作的错误；
  - 跨 host 或 payload 读不出 ⇒ 同样不 break；
  - 同 host 下 pid 已死、或 starttime 不一致 ⇒ break；
  - 原子创建的锁文件不可能出现空的 payload；
  - 两个真实子进程并发争抢。
- **G-legacy**：
  - v1 manifest 只能只读列出；
  - 不带 `--legacy` 执行 restore 会被拒绝；
  - 带 `--legacy` 时，每个被覆盖的目标在覆盖前都先产生一份 txn 备份；
  - v1 manifest 文件本身不被改写。
- **G-fsync**：通过 hook 让目录 fsync 抛错，断言只产生 WARN 一次，判定结果与不抛错时完全一致。
- **G-manifest**：按 §9.8 的格式做逐字段模糊测试，每一种变异都必须被拒绝。

**P-RT**

- **G-measure**：用 fake session 和真实 session-driver：
  - `diag.dispatchMeasure` 的各个字段都要填上；
  - 超出预算时，run 以 `failed(config, input-budget:…)` 结束，`usage` 为 0，且一次模型请求都没有发出；
  - 不设置 `inputBudget` 时，行为与改动前逐字节一致（现有 runtime 测试全部通过）。
- **G-overhead**（conformance，真实 pi）：`OVERHEAD_FLOOR_BYTES ≤` 最小只读子会话实测值，并记录实测值。

**P3a**

- **G-breaklock**：`--break-lock` 只在 TUI 可用；会显示持有者并确认后才 break；取消则零变化；任何自动路径都不会调用 `lockBreak`（spy）。
- 其余门：G-abort、G-cost、G-bounds、G-dialog、G-surface、G-index-skip、G-e2e。G-e2e 中增加两个场景：一是在 `onStaged` 之后 kill，重启后恢复，再执行 restore，最终逐字节回到初始状态；二是 v1 manifest 的 `--legacy` restore 路径。

**P4**：G-settings。

**真机**：在 v3 清单基础上增加两项：一次 `kill -9`，时机要落在 REPLACE 的 `staged` 与 `rename` 之间；以及一次 `--break-lock` 的人工演练，对象是用旧格式锁伪造的残留锁。

**v3.2 新增门**

- **G-tmpgrammar（P0）**：见 §9.1。
- **G-nohardlink（P2）**：用 hook 让 `link` 返回 EPERM、ENOTSUP、EOPNOTSUPP、ENOSYS、EXDEV，逐一验证以下两点：
  - 从 `probeHardlinks` 起都 fail closed，不写 `intent`，磁盘零变化，提示文案逐字匹配；
  - 如果 `createLocExclusive` / `moveLocNoClobber` 在执行中途遇到这类错误，结果是回滚加 conflict，并且**从不调用 `renameSync` 作为回退**（spy 计数为 0）。
  - 锁的降级路径单独测：不支持硬链接时，`lockCreate` 仍然可用。
- **G-final-observe（P2）**：在后验与 `result` 之间篡改 target（同 inode 但改了内容，或者换成另一个 inode），断言判为 conflict，并且 `final` 记录了篡改后的观测值。另外断言每个 `result` 都带 `final`。
- **G-boundaries（P2）**：对 §9.2 边界表的每一行注入崩溃，然后反复恢复 1–3 次，断言：
  - 每个 opId 的 `attempt` 不超过 1 次，动作 spy 不超过 1 次；
  - 「已有 attempt、没有 result」的 op 只观测、不动作；
  - 最终状态是终态；
  - 两个恢复方并发时，只有一方能认领。
- **G-epoch（P2/P3a）**：
  - 旧 owner 执行到一半时，另一个进程运行 `--break-lock`：旧 owner 下一次执行 `assertEpoch` 就失败，fs 没有任何变更，journal 没有新追加，用户收到的提示文案逐字匹配；
  - 恢复方能认领这个已撤销的 run 并收敛它；
  - epoch 文件不存在时视为 0；
  - `--break-lock` 必须先递增 epoch、再打破锁，用调用顺序 spy 验证。
- **G-dirswap（P2）**：在两个 syscall 之间用 hook 把 `archive/` 换成 symlink，或换成 `(dev, ino)` 不同的另一个目录，断言 `DIR_SWAPPED` 导致 conflict 并中止该 step，且永远不会跟随这个 symlink。
- **G-measure-real（P-RT，conformance）**：用真实 pi、内置 provider，加一个统计请求次数的本地假 HTTP 端点：
  - payload 超出预算 ⇒ run 以 `failed(input-budget)` 结束，端点收到的请求数为 0；
  - payload 在预算内 ⇒ 请求数为 1，`diag.dispatchMeasure.payloadBytes` 等于端点实际收到的请求体长度，允许 ±JSON 序列化差异。
  - 子会话缺少本包扩展时 ⇒ fail closed。

## 14. 风险

- **R1 / R2 / R3**：与 v3 相同，分别是归档后不可见、手写索引的例外、信号偏弱。
- **R4**：持久性只覆盖进程崩溃（M-T1）。断电可能留下无主对象，`--status` 会报告它们。
- **R5**：cost 是「有界上限」，最多超出一回合（M-T6）。
- **R6**：draining 期间，同一进程内的 tidy 会被拒绝，有时间上限。
- **R7**：v2 manifest 不能被旧版读取；现行 tidy 也会改写成 v2 格式（写进 commit body 和 release notes）。
- **R8**：restore 的语义收紧为 CAS；v1 manifest 只能通过 `--legacy` 恢复。
- **R9**：lock 规则（M-T4）作用于所有 memory 写入方。旧版 pi 留下的锁，或跨 host 的锁，需要用 `--break-lock` 人工处理；在此之前，写入方会收到带指引的 busy 错误，数据不会损坏。
- **R10**：在「tmp 已写出但尚未 staged」的窗口崩溃，会产生无法证明归属的 tmp，结果是 conflict 并需要人工删除（按 B1 的设计有意为之）。这个窗口只有一次 fsync 加一次 manifest 追加。
- **R11**（v3.2 撤销）：v3.1 中「不支持硬链接时 MOVE 退化为非原子 no-clobber」的风险已不存在，因为现在一律 fail closed（§9.3）。
- **R12**：在本包的 `before_provider_request` 测量处理器之后，第三方扩展仍可能替换 payload；不把 abort signal 传给 fetch 的自定义 provider，在超出预算时仍可能已经发出一次请求（§4.5）。
- **R13**：残余窗口（明确声明）：最后一次 `verifyDir` 或 `assertEpoch` 到下一次 syscall 之间（M-T9、§10.2）。
- **R14**：在不支持硬链接的文件系统上，batch、restore 和 txn 化的 tidy 不可用，只能使用普通的 `/mem tidy <file>`（旧路径）。

## 15. 待用户决策（v3 的 Q1–Q7 沿用；已被 M-T 裁定覆盖的不再列出）

- **Q1**：归档是否只做 `archive/` 子目录。
- **Q2**：手写索引删行这一例外是否追认。
- **Q3**：是否保留 `--triage`。
- **Q4**：默认值是否合适。
- **Q6**：对话框上限和块预算保持为常量，还是做成设置项。
- **Q7**：现行 tidy 和 `--frontmatter` 是否一起迁移到 txn。
- v3 的 Q5（restore 的 CAS 范围）已由 M-T2 裁定，删除。

## 16. 实施顺序

1. **P0**：`TIDY_MAX_FILES` 和各项类型。
2. **P1 / `journal.ts`**：完成 `decide` 与状态机，G-decide、G-state 通过后**冻结**。
3. **P2**：原语（G-prims）→ `lock.ts`（G-lock）→ `txn.ts`（G-txn）→ `manifest.ts`（G-manifest）→ 把 `apply.ts`/`restore.ts` 迁移到 txn（G-legacy、G-v1-compat）。P1 的其余部分可以与这一步并行。
4. 等 **sysload P0 合入**之后，在独立 worktree 中依次做 **P-RT**（G-measure、G-overhead）和 **P4**（G-settings）。
5. **P3a**：编排、UI、`--break-lock`、G-e2e。
6. **P3b**（可选）。
7. **P5**：真机验收与文档。

## 17. 评审处置

### 17.1 v1 评审（r_0JVVABFR）——v2 的处置在 v3 中的状态

| #   | v2 的处置                       | v3 中的状态                                                     |
| --- | ------------------------------- | --------------------------------------------------------------- |
| 1   | `files ≤ maxItems − 4`          | 保留；v3.1 改为统一常量 `TIDY_MAX_FILES`（M-T7）                |
| 2   | 写前日志 + 双位置收敛           | **重做**：§9 的统一事务模型和真值表                             |
| 3   | restore CAS                     | **重做**：多位置 CAS，并带 journal（§9.7）                      |
| 4   | abort 后等待终态，处理 draining | 保留（§8.4）；draining 期间继续占用预留                         |
| 5   | 索引写入带 base sha             | 保留；另外只对 done 的 op 删行（§6.4）                          |
| 6   | 重新快照 + `includeArchived`    | 保留（复审认可）                                                |
| 7   | 单一成本账本 + 丢弃超上限结果   | **加强**：改为预留制，并如实说明保证范围（§8.1）                |
| 8   | `maxModelRuns` + 总时限         | 保留；总时限改为活动时钟，对话框单独设上界（§8.2、§8.5）        |
| 9   | 交互只在 TUI，RPC 和 web 只读   | 保留（复审认可）                                                |
| 10  | 统一 Loc                        | 保留；`Loc` 唯一归属 `contracts.ts`，新增 trash area            |
| 11  | KiB、吞吐超时、余量             | 保留；余量计入完整开销（§4.5）                                  |
| 12  | 各包合并门                      | 保留并扩充（§12、§13）                                          |
| 13  | lease 用 pid+starttime          | 保留；**目录锁同样改用该身份规则**（§10.2）                     |
| 14  | 链接语法                        | 保留（复审认可）                                                |
| 15  | 范围收缩                        | 按用户裁定调整：保留批量归档 + 批量模型改写；consolidate 仍不做 |

### 17.2 v2 复审（r_GMW1FVT0）

| 编号 | 级别  | 问题                                                             | 处置                                                                                                                                                                       | 落点                              |
| ---- | ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| B1   | 阻塞  | 恢复时把 backup(old)+live(after) 误判为冲突；tmp 靠 pid 模式扫描 | 统一事务模型：精确的 tmp 名和备份名在执行前写进 journal；REPLACE 改为「复制备份 + 原子 rename」；真值表 R2 前滚、R1 回滚、只在 sha 都对不上时才判 conflict；不再做模式扫描 | §9.1–§9.4，G-decide，G-txn        |
| B2   | 阻塞  | `interrupted` 会导致永久重复退出                                 | 状态机给出终态 `recovered` / `conflict-reported`；`interrupted` 只是在途认领标记；恢复后同一次命令继续执行                                                                 | §9.6，§4.1，G-state               |
| B3   | 阻塞  | restore 只按单一位置做 CAS，且自身不可恢复                       | restore 也由 journal 原语组成，每个逆操作带多位置期望，并有自己的 manifest 和崩溃恢复，可被再次撤销                                                                        | §9.7，G-CAS，G-e2e                |
| M1   | Major | 归档被 CAS 跳过后，索引里的链接仍被删除                          | 索引内容在所有归档 op 都有结论之后才计算，只删 done 对应的行                                                                                                               | §6.4，G-index-skip                |
| M2   | Major | 成本不是硬上限                                                   | 派发前预留，`spent + reserved + est > cap` 就不派发；cost 必须是有限非负数；如实说明单个回合内的超支无法拦截                                                               | §8.1，G-ledger                    |
| M3   | Major | 总时限与 UI 等待相互矛盾；editor 没有上界                        | 总时限只计模型活动时间；所有对话框都是带 `signal` 的 `select` / `confirm` 或 bounded custom；不再使用 `ui.editor`；对话框有单个上限和总上限，lease 的最长持有时间可以算出  | §8.2，§8.5，§6.1，§6.3，G-dialog  |
| M4   | Major | 目录锁过 30 s 会被别人打破                                       | 锁 payload 带 pid+starttime(+bootId)，持有者存活就永不按时长打破；块预算按实测 ≤2 s                                                                                        | §10.2，§9.5，G-lock，G-chunk      |
| M5   | Major | headroom 没有计入完整上下文                                      | 计入 `overheadBytes`（agent prompt 走端口获取，工具和基础 prompt 由 conformance 测量后定为常量，再加 schema）                                                              | §4.5，G-overhead，G-headroom      |
| M6   | Major | manifest 只做了类型断言                                          | `parseManifestStrict` 对每个 JournalOp、Loc、sha、seq、tmp 逐项校验，v2 不允许未知字段，校验失败即拒绝                                                                     | §9.8，G-manifest                  |
| M7   | Major | archive 同 inode 收敛时没有比对内容                              | MOVE 真值表 M2 要求 sha = h，M6（同 inode 但 sha 已变）判为 conflict                                                                                                       | §9.4.1，G-decide，G-txn           |
| m1   | Minor | restore 之后没有刷新注入                                         | 透传 `onAfterWrite`，restore 和 trash 成功后调用一次                                                                                                                       | §9.7，`command.ts:105-108`，G-e2e |
| m2   | Minor | Loc 的归属不清                                                   | 只在 `contracts.ts` 定义                                                                                                                                                   | §9.1，§12 P0                      |
| m3   | Minor | 动态读取 `maxItems` 时缺少 fail-closed                           | 读取失败或值 < 8 ⇒ 禁用 batch                                                                                                                                              | §4.1，G-schema-const              |

### 17.3 v3 复审（r_5HKF5EZ1）

| 编号 | 级别  | 问题                                                    | 处置                                                                                                                                                                                                                                                                    | 落点                                  |
| ---- | ----- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1    | 阻塞  | M4/M5 被判为回滚；R1/C1/C3 只按路径清理，没有验证所有权 | 新增对象身份 `Ident(dev, ino, sha, size)`，在 `intent` 或 `staged` 事件里先于磁盘操作入账；判定时把观测分成五类 B/A/S/∅/X，X 一律判 conflict；清理只能通过 `unlinkObservedLoc` 按记录的身份进行                                                                         | §9.1、§9.2、§9.4，G-decide，G-txn     |
| 2    | 阻塞  | 跨区域原语没有定义                                      | 逐个原语写出契约：签名、前置条件、syscall 顺序、lstat/fstat 校验、`O_NOFOLLOW`、用 link+unlink 实现 no-clobber（Node 没有 renameat2）、EXDEV 与不支持硬链接时的回退、错误码与 `mutated` 标记、会留下哪些崩溃状态以及由哪个 journal 阶段覆盖；并标明各自基于哪个现有原语 | §9.3，E23–E26，G-prims                |
| 3    | Major | v1 manifest 缺 sha，转换方式没有定义                    | M-T2：只读；必须加 `--legacy` 并显式确认；覆盖前先备份；不做自动转换                                                                                                                                                                                                    | §9.7，G-legacy                        |
| 4    | Major | 没有目录 fsync，持久性承诺不清                          | M-T1：只承诺进程崩溃，目录 fsync 尽力而为                                                                                                                                                                                                                               | §1 非目标，§9.3，G-fsync              |
| 5    | Major | 恢复动作失败后没有终态                                  | M-T3：判 conflict，进入终态 `conflict-reported`，列出遗留对象，不重试                                                                                                                                                                                                   | §9.4、§9.6，G-txn                     |
| 6    | Major | 旧格式或跨 host 的锁仍按存在时长被 break                | M-T4：持有者无法证明已死就不 break，拒绝时给出指引，只能显式执行 `--break-lock`；锁 payload 改为原子写入                                                                                                                                                                | §10.2，G-lock，G-breaklock            |
| 7    | Major | headroom 用常量估算，不可靠                             | M-T5：派发时在子会话里实测，测量点在 `prompt()` 之前，超预算的 run 零成本失败；常量只作下限；新增 P-RT 包（★，排在 sysload 之后）                                                                                                                                       | §4.5、§12 P-RT，G-measure，G-overhead |
| 8    | Major | 不是严格意义上的支出上限；watcherCap 没有钳位           | M-T6：改称「有界上限」，如实写明最多超出一回合；`watcherCap` 用 `max(0, …)` 钳位                                                                                                                                                                                        | §8.1，G-ledger                        |
| 9    | Major | 真值表没有覆盖补偿失败，以及 tmp/backup 的各种组合      | 观测分类扩展为 B/A/S/∅/X/other，与 inode 是否相同交叉穷举；增加补偿失败注入测试                                                                                                                                                                                         | §9.4.5，G-decide，G-txn               |
| 10   | Minor | 规划器动态读取 maxItems，而校验器把 24 写死             | M-T7：统一使用一个常量 `TIDY_MAX_FILES`                                                                                                                                                                                                                                 | §12 P0，G-maxfiles                    |
| 11   | Minor | 「目标名转义」没有定义                                  | M-T8：tmp 名只由 opId 加 phase 生成，字符集限定为 `[A-Za-z0-9._-]`，不需要转义                                                                                                                                                                                          | §9.1，G-tmpname                       |
| 12   | Minor | 热点文件规则                                            | P-RT 与 P4 都在独立 worktree 施工；等 sysload P0 合入后重新确定基线；禁止并行的格式化或生成式写入                                                                                                                                                                       | §12 热点规则                          |

### 17.4 v3.1 复审（r_64QH0GD9）

本轮复审因 consult 首次请求的成本超过上限（约 $2.15，上限 $2）而无法调用。所以下表依据主会话转述的结论编写：1 个阻塞、6 个 Major；B1 的真值表和 B2 的原语契约已经基本完整。

| 编号 | 级别  | 问题                                                                 | 处置                                                                                                                                                                                                                                                                      | 落点                                |
| ---- | ----- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| B    | 阻塞  | 父目录 TOCTOU：`verifyDir` 之后仍按路径字符串执行 link/rename/unlink | **M-T9**：列入威胁模型之外。每个 mutating syscall 之前重新 `lstat` 目录的 `(dev, ino)`，若不是普通目录、是 symlink 或不一致，就判 conflict 并中止该 step；在非目标部分写明残余窗口；不采用 fd 锚定                                                                        | §1 非目标，§9.3 共同约定，G-dirswap |
| 1    | Major | `lockCreate` 的 tmp 名不符合 `TMP_RE`                                | 全仓库只保留一套命名语法：`tmp-names.ts`，类型取值 `[bcmlepo]`；锁、lease、epoch、probe、manifest 都通过 `tmpNameFor` 生成；测试 grep 确认没有第二个定义                                                                                                                  | §9.1，§10.2，G-tmpgrammar           |
| 2    | Major | `createLocExclusive` 在 EPERM/ENOTSUP/EXDEV 下的回退行为没有定义     | 启动前用 `probeHardlinks` 预检；执行中途遇到这类错误就 `NO_HARDLINK` fail closed，给出可操作的提示，并回滚已经暂存的 tmp；`moveLocNoClobber` 一并删除 rename 回退（R11 随之消失）；只有锁保留旧的 `O_EXCL` 降级路径，理由已写明                                           | §9.3，§10.2，G-nohardlink           |
| 3    | Major | 成功路径只核对了 inode，最终状态没有记录                             | CREATE/REPLACE 的后验同时比较 `(dev, ino)` 和 sha；每个 `result` 强制带 `final`，即全部位置的最终观测，state 依据 `final` 重新判定                                                                                                                                        | §9.2，§9.3，§9.4.5，G-final-observe |
| 4    | Major | `HOOK_MARGIN` 是假设值                                               | 改为两段实测：driver 粗筛只负责拒绝；在子会话的 `before_provider_request` 中测量完整 payload，超出预算就在发送前 abort（因为 throw 会被 pi 吞掉）；扩展缺失时 fail closed；列出 tidy 子会话中所有 `before_agent_start` 贡献者，仅作交叉核对；第三方扩展的残余影响写入 R12 | §4.5，P-RT，G-measure-real          |
| 5    | Major | journal 事件边界的崩溃语义不清楚，M-T3 也没有落实手段                | 给出边界表和认领规则；新增 `attempt` 事件：动作执行前先写入，此后同一 op 只观测、不再动作，因此每个 op 的动作最多执行一次                                                                                                                                                 | §9.2，§9.4.4，G-boundaries          |
| 6    | Major | `--break-lock` 之后，旧 owner 仍可能继续写入                         | 引入 `.owner-epoch`：先递增 epoch、再打破锁；每个 mutating syscall、journal 追加、lease 刷新之前都检查 epoch；旧 owner 一个字节都不再写，并收到逐字固定的提示；被撤销的 run 交给恢复方处理                                                                                | §10.2，§9.6，G-epoch，G-breaklock   |

## 18. 主会话裁定（有约束力，不再重开）

- **M-T1**：持久性只承诺进程崩溃或 `kill -9`，不覆盖断电。目录 fsync 尽力而为：每次 journal 追加之后、每次 rename 之后，各对父目录 fsync 一次；失败只记录日志，不作为任何正确性声明的依据。→ §1、§9.3
- **M-T2**：v1 restore manifest（没有 sha）只读列出。要从它恢复，必须显式 `--legacy` 并确认，且每个会被覆盖的目标都先做恢复前备份；不做自动转换。→ §9.7
- **M-T3**：补偿 unlink 失败时，该 op 以终态 `conflict-reported` 结束，并列出遗留对象；绝不循环重试。→ §9.4、§9.6
- **M-T4**：旧格式锁或跨 host 锁，只要无法证明持有者已死，就绝不按存在时长 break；跨 host 或持有者不明时拒绝，并给出可操作的提示；只能通过显式的 `/mem tidy --break-lock` 打破。→ §10.2
- **M-T5**：headroom 改为在派发时测量 tidy 子会话实际的 system prompt、工具声明和 schema 的字节数（来自 spawn 请求或 session spec），常量只作下限。→ §4.5、P-RT
- **M-T6**：成本如实表述：保证内容是「派发前预留，到达上限即停止派发；最大超支不超过一个在途 run 的最后一回合」；称为 bounded cap，不称硬性支出上限。→ §8.1
- **M-T7**：`maxItems` 统一使用一个导出常量 `TIDY_MAX_FILES`，schema、校验器和规划器共用，由测试钉住三者相等。→ §12 P0
- **M-T8**：tmp 名只由 `[A-Za-z0-9._-]` 字符组成（opId 加 phase），绝不从记忆文件名派生；撞名则该 op 失败。→ §9.1

- **M-T9**：父目录 TOCTOU 不在威胁模型内。原因是 Node 22 没有 `openat`/`renameat2`，在 `verifyDir` 之后，link/rename/unlink 只能以路径字符串调用；而要替换 `~/.pi/agent/memory/<slug>/` 下的目录，必须拥有同一个 uid，这本身就意味着已被完全攻陷。这与现有 memory 模块的模型一致：slug 目录只 canonicalize 一次并视为用户可信，文件级 symlink 和非普通文件一律拒绝。作为替代，执行以下措施：
  - 每个 mutating syscall 之前，重新 `lstat` 所在目录的 `(dev, ino)`（best effort），不一致就判 conflict 并中止该 op；
  - 验证完成之后才出现的 symlink 目录，一律不跟随；
  - 在非目标部分明确写出残余窗口；
  - 不采用 fd 锚定。

  落点：§1、§9.3。
