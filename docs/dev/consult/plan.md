# consult：轮内同步请教 —— 实施方案 v2

> 状态：v2，评审 `review-1.md` 打回后修订（21 条逐条处置见 §13）。输入：`requirements.md`（F1–F7、§6 开放问题）、`explore-handoff.json`（代码探索交接包）、`review-1.md`（评审，含「已核查项」）。
> v2 相对 v1 的主轴变化：**fork 由工具侧同步完成、经受信字段交给既有 `driver.resume` 接缝**（删掉了 `driver.fork` 三态分派）；**spawn 准入为 fork 请求开专用分支**（跳过 canSpawn）；**experts 白名单在派发时即解析成 runId**；**新增轮次/成本/并发/上下文预检四道闸门**；**专家工具集取舍改为数据驱动（P0 探针）+ v1 默认只读**（§5.4，待用户重新确认，见 §12 ⚠️）。
> 所有行号引用以评审「已核查项」+ 本次抽验为准（施工前以符号名为准重核）。

## 1. 背景与目标

多 agent 串行协作中，下游 agent 需要上游掌握但环境里读不到的知识（已拍板决策、被否决方案及理由、用户偏好）。
实验（fabric-v2 baseline §15/§17/§19）证明：**轮内同步请教**是唯一被验证有效的获取形态（自发请教 8/8，质量 2.25→7.0）。
本方案落地最小形态：专用工具 `consult({ expert, question })`，fork 已结束专家的会话副本，同一次工具调用内返回答案。

约束（来自 AGENTS.md 与需求 §5）：零挂死不变量（分层 deadline + watchdog + reaper + 可确认投递）、timer 全 unref、
无模块级可变状态（`/reload` 同进程重激活）、HOST_KEY 守卫、TS strict 全套、typebox 参数、pi peer `>=0.84.0 <0.86.0`。

**v1 非目标**（评审 #14 决议）：`SubagentWorkflow` 派发路径不支持 `experts`（`workflow/spawner-adapter.ts:46-60` 逐字段组装，穿透留待后续）；主会话不注册 consult 工具。

### F1–F7 回应总表

| 需求                                                             | 方案落点                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 专用工具、expert 只指向已结束持久化 run、无「新起 agent」退路 | `consult` 工具（§4.1）；白名单在 `Agent({experts})` 派发时即解析校验（§4.2/§5.3），解析不到当场 throw 配置错；consult 时解析缺失/会话缺失/类型已删/仍在运行一律 nack，**从不** spawn 全新会话（fork 是唯一建会话路径）                                               |
| F2 不污染、可并发                                                | `SessionManager.forkFrom` 静态 fork（新 id + `flag:"wx"` + parentSession 溯源 + 原文件零写入，§5.1）；**fork 由工具侧同步完成**、fork 副本经 `driver.resume` 接缝打开（§4.4）；并发请教同一专家 = 各自 fork 各自文件                                                 |
| F3 跨 `/reload` 可用                                             | `ExpertIndex` 从主会话 `subagent:run` 条目重建（§4.5/§5.3）；白名单在派发时解析成 `{runId, sessionFile}` 存进 `SpawnRequest.consultExperts`，consult 按 runId 匹配，reload 后同名 label 不会问错人                                                                   |
| F4 有界、零挂死                                                  | 显式 `budgetOverride.totalMs` 硬顶（默认 150s）+ **轮次上限 maxTurns（默认 3）+ 成本上限 maxCostUsd（默认 $0.5）+ 提问方级并发上限（默认 2）+ 专家上下文占用预检（≥75% 快速 nack）**（§4.1/§4.6/§5 F4）+ 现有 watchdog/reaper 全覆盖 + 真 parentRunId 级联中止（§7） |
| F5 回答格式                                                      | 问题 prompt 注入「结论先行、≤N 字」指令 + `truncateResultText` 硬截断兜底（**不传 sessionFile**，§5.5）；超时/被帽有已流出文本时返回部分答案（§4.1）；**专家 run 默认只读工具域**（§5.4，待用户重新确认）                                                            |
| F6 可观测、不打扰                                                | parentRunId = 提问方真 runId → CC2 三路径通知抑制自动生效 + fleet 嵌套行自动出现 + 成本经工具结果 usage 回传（§8）；顺手修 `notifyTerminalFailure` 缺口（理由已更正，§6 包 B-7）                                                                                     |
| F7 谁能被问、谁能问                                              | `Agent({ experts: [...] })` 派发时白名单 + **派发时解析校验**（写错立即报错给调度方）；consult 只注入给带白名单的子 run；主会话与工作流派发 v1 不支持（§5.2）                                                                                                        |

## 2. 现状摘要（与方案相关的既有件）

- **resume 全链路**（`src/tools/agent-tool.ts:288` → `src/service/spawn-service.ts:371-418` → `src/runtime/runner.ts:465-470` → `src/runtime/session-driver.ts:324-331`）：`driver.resume` 用 `SessionManager.open(sessionFile, undefined, cwd)` 打开既有文件再注入 `createAgentSession`。**v2 关键：fork 副本就是一个「既有会话文件」，直接复用此接缝，driver 零改动。**
- **pi SDK fork 能力**（`session-manager.js:1237-1276`，评审已核查）：`static forkFrom(sourcePath, targetCwd, sessionDir?, options?)` 同步执行——读源条目、在 `sessionDir` 下用 `flag:"wx"` 写新文件（新 id、header 带 `parentSession=源路径`）、逐条 append、返回新实例；**源文件零写入**，F2 论证成立。注意其实例构造时会再全量读一遍 fork 文件（`_setSessionFile`），fork 本身是同步、短耗时操作，适合工具侧直接调用。
- **spawn 准入的 canSpawn 闸**（评审 #1，已核查）：`spawn-service.ts:335-345`——`parentRunId` 在 nesting 里查得到（每个 run 准入时都会 `nesting.set`，:430）就要求 `parent.canSpawn?.includes(req.type)`，否则返回 `config` 错误「nested delegation is not permitted」；`spawnAndWait` 对此 **throw**（:447）。**v1 方案漏了这闸，请教会一律被拒——v2 在 §4.4 开 fork 专用分支。**
- **label 注册表**（评审 #5/#11，已核查）：`labels` 是进程内 Map、只写不删（:427）；`deriveUniqueLabel` 只和当前 Map 比较（:371-380），base ≤36 码点、最多 999 个后缀（`core/labels.ts:4-6`）。⇒ reload 后同名 label 会撞、consult 高频调用会耗尽显式 base 的后缀空间。v2 对策：白名单在派发时解析成 runId（label 仅显示用），consult run 的 label base 带随机后缀（§4.1）。
- **resumeLocks 双键**（`spawn-service.ts:411-416`）：targetId + sessionFile；`Agent({resume})` 续跑是**新 runId、同一 sessionFile**——consult 的「仍在运行」判断必须同时按 sessionFile 查（§4.5）。
- **run 记录持久化**：`wrapWithRunLog`（`src/adapters/pi-run-log.ts:24-40`）把终态 RunSnapshot 整体 `appendEntry("subagent:run", snapshot)` 进**主会话**文件；`buildSessionStack` 的 `prefetchedEntries`（`src/stack.ts:850`）含这些条目，读取形状 `entry.type === "custom" && entry.customType === "subagent:run"`、负载在 `entry.data`（fabric 树 `stack.ts:263-273` 为先例）。`session-manager.js:982-984`：`getEntries()` 返回全部 fileEntries、`open()` 全量加载——评审据此把「/resume 后条目不全」风险降级（§5.3）。
- **嵌套工具注入**（`src/service/runtime-adapter.ts:384-471`）：customTools + grantedReserved 按序注入（message_agent 386-412 / set_model 421-429 / 嵌套 Agent 430-442 / StructuredOutput 444-457），M1 合并（470-471）防 pi 注册表过滤。consult 走同一模式注入给**提问方**；同时 adapter 在此按 `forkSessionFrom` 识别**请教 run** 并施加只读工具域（§5.4）。
- **thinkingLevel 不持久化**（评审 #3，已核查）：`runtime-adapter.ts:371` `thinkingLevel = spec.request.thinkingOverride ?? spec.type.thinkingLevel`；RunDiagnostics 无 thinking 字段（`core/types.ts:395-440`）——专家若覆盖过 thinking，请教 run 无法对齐。
- **tool-scope**（`src/runtime/tool-scope.ts:21-45, 78-88`）：`RESERVED_TOOL_NAMES` 默认 deny、granted 豁免；enforcer 在 bind 与每 turn_end 重放。
- **CC2 通知抑制**（`runtime-adapter.ts:343/237/312/107`）：`parentRunId !== undefined` 即拦完成/config-failure/deadline 三类顶层通知。
- **级联中止三链**：abort→cascadeChildren（`spawn-service.ts:522-535`）；任何取消→onChildAbort→`stack.ts:1109` 接线；前台工具 signal 直连 turn 中止。
- **`spawnAndWait` 错误形态**（评审 #8）：准入错误返回 `{error}` → `spawnAndWait` **throw**（`spawn-service.ts:447`），不会变成 outcome。consult 工具必须 try/catch 映射成 nack（§4.1）。
- **runner finally 的 reap 是异步的**（评审 #2c，已核查）：`runner.ts:603` `void runReap().catch(...)` fire-and-forget，**没有完成回调**；`spawnAndWait` 在 finish 时就返回。RunnerDeps（`runner.ts:187`，含 `beforeReap`/`onExtensionError` 先例）新增 `onReaped` 回调即补上此缝（§4.4）。
- **`_persist` 是 `appendFileSync`**（`session-manager.js:726-755`，已核查）：文件被删后再写会重新生成**无 header 的残片 jsonl**——所以 fork 文件删除必须排在 reap 之后（§5.1）。
- **快照订阅缝**：`spawn-service.ts:64/179/216` `deps.onSnapshot` 每个快照触发（含终态），stack.ts:1201 已消费——轮次/成本闸门经此挂 tap（§4.1），**不新增 timer**。RunDiagnostics 有 `turns`、`usage.costUsd`（X9 生命周期累加）、`contextUsage{tokens,contextWindow,percent}`（`core/types.ts:241-257, 390-403`）。
- **worktree-origin 注册表**（`src/core/worktree-origin.ts`，pi-free）：worktree 路径 → 原仓库 cwd，`Symbol.for` 全局、FIFO 256、per-reap 清理——worktree 专家被回收后映射可能已不在，cwd 解析链要兜底（§5.1）。
- **`truncateResultText` 实际行为**（`src/tools/result-text.ts:14-45`，评审 #9）：保留头部 70% + 尾部、省略中段；**传了 sessionFile 会追加 "full session transcript: … use the read tool"**——consult 调用时不传（§5.5）。
- **超时保留部分文本**（`state-machine.ts:769-773` 注释，评审 #10）：failed/aborted/timeout 的 run 保留已流出的 deltas——「结论先行」下前半段最有价值，超时 nack 应带回部分答案（§4.1）。
- **线程穿透编译门**：`src/service/request-threading.ts` THREADED/NOT_THREADED + never 穷尽断言——SpawnRequest 加字段不分类就编译失败。
- **`RunnerSpec.request` 是完整 SpawnRequest**（`src/service/ports.ts:38-46`）：adapter 可直接读 `spec.request.consultExperts` / `forkSessionFrom`。
- **预算硬顶**：`budgetOverride.totalMs` 显式 → `applyBudgetPolicy` 钳 `maxTotalFactor=1`（无宽限无延长，`src/core/deadline.ts:96-110`）。
- **外部入口不泄漏**：RPC `SpawnParams` `additionalProperties:false`（`rpc/protocol.ts:15-48`）、workflow 逐字段组装（`spawner-adapter.ts:46-60`）——`forkSessionFrom`/`consultExperts` 无法从这两条路径注入（评审已核查）。
- **测试基础设施现状**（评审 #7，已核查）：`tests/integration/` 没有任何真正跑 pi 会话的测试（helpers 仅 `home-sandbox.ts`）——fork 单元测试用**真实** `SessionManager.forkFrom` 操作临时目录 + `vi.mock` `createAgentSession`；准入测试用**真实** `createSpawnService`（§9）。
- **cache-ttl 只挂主会话**：子 run/fork 会话不经任何 ttl 重写钩子；5m/1h 是分离命名空间，1h 实测存活 7–13.6min；判命中锚「读占上一次前缀 token 数」，不看 `cacheRead>0`（跨会话共享 system/tools 块恒命中）。

## 3. 总体设计

```
调度方(主会话/嵌套 canSpawn 调度方)
  │ Agent({ experts: ["X"], ... })                       ← Agent 工具新参数
  ▼
agent-tool execute：resolveExperts(experts)  ← 派发时解析（评审 #5）
  │   每项 → {runId, label, sessionFile, agentType, model, contextPercent}
  │   解析不到 → throw 配置错（立即反馈）；仍在运行 → 接受 + 工具结果附警告行
  ▼
SpawnRequest.consultExperts: ConsultExpertRef[]（受信、已解析）
  ▼
runtime-adapter.run()：spec.request.consultExperts?.length →
  注入 consult 工具（customTools + grantedReserved + M1 合并）
  │ consult({ expert:"X", question })
  ▼
src/consult/consult-tool.ts execute：
  ① 匹配白名单（expert ↔ resolved ref 的 runId/label；否则 throw）
  ② 并发闸门：每提问方 in-flight ≥ maxConcurrent → nack busy（评审 #13）
  ③ 存活检查：runId live 终态？无运行中 run 指向同一 sessionFile？否则 nack still_running（评审 #12）
  ④ 上下文预检：contextPercent ≥ 75% → nack context_too_large（评审 #19）
  ⑤ fork-store.forkExpertSession(sourceFile) 同步 fork → forkFile（路径已知！）
     cwd 解析链：header cwd → existsSync → worktree-origin → 提问方 cwd（评审 #6）
  ⑥ try { spawn.spawnAndWait({ type: ref.agentType, modelOverride: ref.model,
        forkSessionFrom: forkFile, cwd, parentRunId: selfRunId, slotless: true,
        budgetOverride:{totalMs}, signal, label:"consult-<rand4>" }) }
     catch（准入 throw）→ 立即删 forkFile（此时尚无任何 run 碰过它）→ nack（评审 #8）
  ⑦ 轮次/成本 watcher 经 onSnapshot tap 挂到 consultRunId，超帽 abortRun（评审 #4）
  ⑧ outcome → 截断（不传 sessionFile）→ 工具结果（+usage 回传；超时/被帽有文本则 partial）
     fork 文件删除：登记 pendingDeletions[consultRunId]=forkFile，
     runner reap 完成后经 onReaped 回调删除；buildSessionStack TTL sweep 兜底（评审 #2）
                                  ▼
        spawn-service 准入：fork 专用分支（评审 #1）
          forkSessionFrom 存在 ⇒ 跳过 canSpawn 检查；depth = parent.depth+1 照常计并受
          maxNestedDepth 约束；existsSync+isFile 校验；与 resumeFrom 互斥；不进 resumeLocks；
          该 run 的 nesting 条目不带 canSpawn（不可再往下派）
                                  ▼
        runner session_create 相位：forkSessionFrom → driver.resume(forkFile, req)
          （复用既有 open+注入接缝，driver 零改动，无三态分派）
                                  ▼
        请教 run：只读工具域（read/grep/find/ls；不注入 Agent/message_agent/
        StructuredOutput/set_model —— adapter 按 forkSessionFrom 识别，§5.4）
                                  ▼
        runner finally：runReap() 完成后 onReaped(runId) → 删 forkFile
```

**新模块 `src/consult/`**（唯一新增目录；其余全部为现有文件的小改动）：

| 文件              | 职责                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expert-index.ts` | 纯函数 + 闭包状态：`createExpertIndex({ consultDir })` → `rebuildFromEntries(entries)` / `resolve(ref)`；pi-free，可单测                                                                                                                                                         |
| `consult-tool.ts` | `createConsultTool(deps)`：typebox schema + execute（匹配→闸门→fork→spawn→watcher→截断→nack 语义）                                                                                                                                                                               |
| `fork-store.ts`   | **pi-facing fs/SDK 适配层**：`forkExpertSession(sourceFile, fallbackCwd)`（包 `SessionManager.forkFrom` + cwd 解析链 + header 有限字节读取）、`consultSessionDir()`（`join(getAgentDir(),"cache","consult-sessions")`）、`sweepForkDir(dir, ttlMs, now)`、`removeForkFile(path)` |
| `index.ts`        | 装配：`wireConsult({...})` → `{ depsFactory, expertIndex, resolveExperts, sweep(), onReaped(runId), snapshotTaps }`；闭包持有 pendingDeletions、并发计数器、watcher 注册表（全部随栈重建）                                                                                       |

依赖方向：`core/types` ← `consult/*`；`consult/fork-store` → pi SDK（SessionManager/getAgentDir）+ `core/worktree-origin`；`consult/*` → `service/spawn-service`（仅经 NestedSpawnPort + 窄端口）；driver/runner **不依赖** consult（评审 #16 随方案①消解——header 读取留在 fork-store，cwd 经 `SpawnRequest.cwd` 传入）。`stack.ts` 装配。

## 4. 接口契约

### 4.1 consult 工具（模型面）

```ts
// src/consult/consult-tool.ts
export const ConsultToolParams = Type.Object({
  expert: Type.String({
    description:
      "Which expert to consult: a label or run_id from this run's expert whitelist " +
      "(resolved and validated at dispatch time). The expert must be a FINISHED subagent run; " +
      "consult forks its persisted session and asks your question. There is no fallback to a " +
      "fresh agent — if the expert is unavailable you get a clear negative answer and should " +
      "investigate yourself.",
  }),
  question: Type.String({
    description: "The question, self-contained. The expert sees its own history plus this question.",
  }),
  // 评审 #20：v1 去掉 timeout_s / max_answer_chars 两个模型面旋钮，上限全在 settings（§4.6）。
});
export type ConsultToolParams = Static<typeof ConsultToolParams>;

export interface ConsultDeps {
  /** 本 run（提问方）的 runId —— parentRunId 与并发闸门键。 */
  selfRunId: RunId;
  /** 派发时已解析的白名单（SpawnRequest.consultExperts）。 */
  whitelist: readonly ConsultExpertRef[];
  spawn: NestedSpawnPort; // 复用 agent-tool 的端口类型
  /** 窄端口：中止本工具自己派生的 consult run（轮次/成本帽用）。 */
  abortRun: (runId: RunId) => void;
  /** 窄端口：订阅 run 快照（spawn-service deps.onSnapshot 的 tap），返回退订函数。 */
  watchRun: (runId: RunId, cb: (s: RunSnapshot) => void) => () => void;
  query: QueryService; // live 状态/终态快照（存活检查用）
  forkStore: ForkStore; // forkExpertSession / removeForkFile / pendingDeletions
  now: () => Millis;
  settings: () => ConsultSettings;
}
```

**问题 prompt 构造**（拼进 run prompt，不进 system prompt）：

```
[consult] You are being consulted by a downstream agent that cannot see your session.
Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.
Hard limit: <= {maxAnswerChars} characters. Prefer not to call tools unless the answer strictly requires a fresh environment fact.

Question:
{question}
```

**label**：`consult-<rand4>`（base36 随机 4 字符后缀，评审 #11：不再用固定 `consult:X` base——`deriveUniqueLabel` 的 999 后缀会被高频请教耗尽；labels Map 只写不删，随机 base 使撞名概率可忽略）。fleet 行仍以 `consult-` 前缀可辨。

**watcher**（评审 #4）：execute 内 `watchRun(consultRunId, cb)`，`cb` 读 `snap.diag.turns` / `snap.diag.usage?.costUsd`；`turns > maxTurns` 或 `costUsd > maxCostUsd`（>0 才启用）→ 记 `capReason` 并 `abortRun(consultRunId)`（幂等，只触发一次）；finally 退订。

**返回**（成功）：`content: [{type:"text", text: 截断后的回答}]`，
`details: { expertRunId, expertLabel, consultRunId, model?, costUsd?, truncated, partial?, durationMs, turns, outcome }`，
`usage: toPiToolUsage(outcome.usage)`（成本回传父会话总账，同 Agent 工具先例）。

**错误与 nack 约定**（统一版，评审 #8 消除了 §1/§4.1 的不一致）：

| 情形                                                                                                              | 行为                                                | 文案（要点）                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| expert 不在白名单 / 空问题                                                                                        | **throw**（调用方错误，同 Agent allowedTypes 先例） | `consult: expert "X" is not in this run's expert whitelist (allowed: a, b). Ask your dispatcher to add it, or answer from your own context.`                                                                            |
| 会话文件缺失 / 类型已删 / 解析失效（reload 后条目丢失等）                                                         | nack                                                | `Expert "X" could not be consulted: <reason>. Fall back to your own investigation.` + `details.outcome="unavailable"`                                                                                                   |
| 专家仍在运行（runId live 非终态，**或有运行中 run 指向同一 sessionFile**——覆盖 `Agent({resume})` 续跑，评审 #12） | nack                                                | `Expert "X" is still running; use steer_subagent-style follow-up via your dispatcher instead.` + `details.outcome="still_running"`                                                                                      |
| 上下文预检超标（专家终态 contextUsage.percent ≥ 75%，评审 #19）                                                   | nack                                                | `Expert "X" session is ~{p}% of its context window; a consult would likely force compaction and blow the {timeout}s budget. Ask your dispatcher for a targeted resume instead.` + `details.outcome="context_too_large"` |
| 并发闸门（本提问方 in-flight consult ≥ maxConcurrent，评审 #13）                                                  | nack                                                | `Too many concurrent consults (max {n}). Wait for one to finish or ask sequentially.` + `details.outcome="busy"`                                                                                                        |
| 超时 / 被帽 / 失败 / 中止，**且 outcome.text 为空**                                                               | nack                                                | `Expert "X" did not answer within {timeout}s (consult run <id>, reason: <...>). Fall back to your own investigation.` + `details.outcome="timeout"\|"turn_cap"\|"cost_cap"\|"failed"\|"aborted"`                        |
| 超时 / 被帽 / 失败，**但 outcome.text 非空**（评审 #10）                                                          | **返回部分答案**                                    | 截断后的部分文本 + 尾部一行 `⚠ partial answer — consult ended early (<reason>).` + `details.partial=true`                                                                                                               |
| spawn 准入 throw（`spawnAndWait` 的 config 错误：深度超限、quota 闸门、模型未知等，评审 #8）                      | try/catch → nack                                    | `Expert "X" could not be launched: <error.message>` + `details.outcome="unavailable"`, `details.configError=<message>`；**同时立即删除 forkFile**（此时尚无 run 触碰它，删除无竞态）                                    |

约定：throw 只用于「提问方自己错了」（白名单外、空问题）；其余一律**正常工具结果**（模型可见、可继续）。T-4 断言「从不 throw（白名单内）、从不新 spawn（forkSessionFrom 之外的 spawn 调用数 = 0）」由这层 try/catch 兑现。

### 4.2 Agent 工具新参数（F7 入口）+ 派发时解析（评审 #5）

`AgentToolParams`（`src/tools/agent-tool.ts:117`）加：

```ts
experts: Type.Optional(Type.Array(Type.String(), {
  description:
    "Optional whitelist of subagent runs (labels or run_ids) this subagent may consult in-turn via the " +
    "consult tool — e.g. an upstream agent whose decisions it needs. Entries are resolved at dispatch " +
    "time: unresolvable entries fail the dispatch; still-running entries are accepted with a warning " +
    "and become consultable once they finish. List only runs whose sessions still exist.",
})),
```

execute 内调新 dep `resolveExperts(refs)`（stack 注入，内部 = live query + ExpertIndex，§4.5）：

- **解析不到**（无此 run / 无 sessionFile / 非终态且拿不到 sessionFile）→ **throw 配置错**，列出失败项与可解析候选——调度方当场拿到反馈，不再是「写错一个字到下游才暴露」。
- **仍在运行**（live 非终态但有 sessionFile）→ 接受，resolved ref 标记 `pending:true`，Agent 工具结果文本附警告行 `⚠ expert "X" is still running; consult will nack until it finishes.`
- 通过项 → `baseRequest.consultExperts = resolvedRefs`（`ConsultExpertRef[]`，§4.3）。

**主会话的 Agent 工具同样获得该参数**；consult 工具本身不注册进主会话（§5.2）。
**工作流派发 v1 不支持**（非目标，§1）：`spawner-adapter.ts` 逐字段组装不带 `consultExperts`，workflow 子 run 永远拿不到 consult 工具——行为正确（无白名单即无工具），文档显式声明。

### 4.3 SpawnRequest / 穿透（冻结面，包 A）

```ts
// src/core/types.ts
/** 派发时解析过的可请教专家（agent-tool 产出，受信）。label 仅显示用；匹配以 runId 为准。 */
export interface ConsultExpertRef {
  runId: RunId;
  label?: string;
  sessionFile: string;
  agentType: string;
  model?: { provider: string; id: string };
  /** 派发时快照的上下文占用（0-100）；consult 时以最新快照/live 复核。 */
  contextPercent?: number;
  /** 派发时仍在运行：consult 需等其终态（仍按 §4.1 still_running 处理）。 */
  pending?: boolean;
}

// SpawnRequest 增加：
/** F7: 已解析的可请教专家列表；runtime-adapter 据此注入 consult 工具。 */
consultExperts?: ConsultExpertRef[];
/**
 * consult 专用：fork 副本的 session 文件绝对路径。仅由 consult 工具内部产出
 * （fork-store 刚创建的副本），与 resumeFrom 互斥；spawn 准入只做 existsSync+isFile
 * 校验并走 fork 专用分支（跳过 canSpawn），runner 经 driver.resume 打开。
 */
forkSessionFrom?: string;
```

`src/service/request-threading.ts`：`THREADED += "forkSessionFrom"`（runner 分派要用）；`NOT_THREADED += "consultExperts"`（adapter 消费，schema 同款先例）。编译门自动强制。

`ResolvedSpawnRequest`（`src/runtime/runner.ts:37`）+= `forkSessionFrom?: string`；adapter 构造 runner 字面量处加一行穿透。

### 4.4 fork 路径：spawn 准入分支 + 复用 driver.resume + onReaped（评审 #1/#2 方案①）

**driver 零改动**——`PiSessionDriver.resume(sessionFile, spec)`（`session-driver.ts:324-331`）的 `SessionManager.open(file) + createAgentSession({sessionManager})` 对 fork 副本天然成立（fork 副本就是合法会话文件；`cwd` 经 `SpawnRequest.cwd` → SessionSpec 传入，覆盖 header cwd）。

```ts
// src/runtime/runner.ts — session_create 分派（465-470 处）改为：
const openFile = req.forkSessionFrom ?? req.resumeFrom;
createP = openFile
  ? this.d.driver.resume
    ? this.d.driver.resume(openFile, req)
    : Promise.reject(new Error("session driver does not support resume"))
  : this.d.driver.create(req);
```

```ts
// src/runtime/runner.ts — RunnerDeps（187 处）加：
/** consult fork 清理缝：reap（含 beforeReap）结束后触发；reap 失败也触发（文件总要删）。 */
onReaped?: (runId: RunId) => void;

// finally 内（603 处）：
void runReap()
  .catch(() => undefined)
  .then(() => {
    try { this.d.onReaped?.(req.runId); } catch { /* 清理回调不得影响 runner */ }
  });
```

```ts
// src/service/spawn-service.ts — spawn() 准入加 fork 分支（389-418 区）：
if (req.forkSessionFrom) {
  if (req.resumeFrom)
    return {
      error: { kind: "config", message: "forkSessionFrom and resumeFrom are mutually exclusive", retryable: false },
    };
  if (!existsSync(req.forkSessionFrom) || !statSync(req.forkSessionFrom).isFile())
    return {
      error: { kind: "config", message: `fork session file missing: ${req.forkSessionFrom}`, retryable: false },
    };
  // 不进 resumeLocks：fork 副本是本 run 私有文件，无互斥需求（并发 consult 各自有副本）。
}
```

**canSpawn 分支**（335-345 区，评审 #1）：

```ts
if (req.parentRunId) {
  const parent = nesting.get(req.parentRunId);
  if (parent && !req.forkSessionFrom) {
    // 既有 canSpawn 检查不变
  }
  if (parent) depth = parent.depth + 1; // fork 请求照常计深、照常受 maxNestedDepth 约束
}
```

- **深度口径（明确写死）**：请教 run **计入** `parent.depth + 1` 并受 `maxNestedDepth` 约束——它真实占用一层嵌套关系（fleet 树、级联中止都按此），超限走 §4.1 的 config→nack 路径。
- **请教 run 自身的 nesting 条目不带 canSpawn**（:430 处 `config.canSpawn` 来自类型注册——adapter 侧不为请教 run 注入嵌套 Agent 工具，§5.4；nesting 条目自然无 canSpawn，它再派任何子 agent 都会被 335-345 拒掉）。双重保险，无需特判。
- `label` 走正常注册（`consult-<rand4>` base，§4.1）。

### 4.5 ExpertIndex（F3 + 评审 #5/#11/#12/#21）

```ts
// src/consult/expert-index.ts（pi-free）
export interface ExpertRecord {
  runId: RunId;
  label?: string;
  sessionFile: string;
  agentType: string;
  model?: { provider: string; id: string };
  status: "completed" | "failed" | "timed_out" | "aborted";
  contextPercent?: number;
  updatedAt: Millis;
}
export interface ExpertIndex {
  /** 从主会话 prefetchedEntries 重建（buildSessionStack 调用一次）。 */
  rebuildFromEntries(entries: readonly unknown[]): void;
  /** 三级解析：runId 精确 → runId 唯一前缀 → label 精确（与 resolve-target.ts 语义对齐，评审 #21）。 */
  resolve(ref: string): { ok: true; record: ExpertRecord } | { ok: false; reason: string };
}
```

- `rebuildFromEntries`：过滤 `entry.type === "custom" && entry.customType === "subagent:run"`，`entry.data as RunSnapshot`；只收终态 + `diag.sessionFile` 非空。
- **请教 run 排除（评审 #11，结构化判据）**：`diag.sessionFile` 位于 `consultDir`（构造时注入）之下的记录一律不收——fork 副本必落该目录（§5.1），专家会话永不落该目录；不依赖 label 前缀（用户可自起 `consult:*`、base 截断 36 码点都影响不到它）。live 查询路径用同一判据。
- **解析语义对齐 `resolve-target.ts`**（评审 #21 的廉价部分）：id 精确 → 唯一前缀（多候选报 ambiguous）→ label；同 label 后来者覆盖（与 spawn-service labels 语义一致）。若 `resolve-target` 的 `matchRunId` 可直接复用则 import 之；deps 形状不合则对齐实现，并用同一 fixture 参数化两个实现的一致性测试锁定（§9 T-1）。
- **resolveExperts（派发时，§4.2）**：先查 live（`query.list()`：本进程 run，覆盖刚结束与仍在运行的专家）再查 index（reload 前的专家）；产出 `ConsultExpertRef`。
- **consult 时存活复核（评审 #12）**：按 runId 查 live 状态非终态 → still_running；再按 sessionFile 扫 live 运行中 run（`diag.sessionFile === ref.sessionFile`）→ 命中即 still_running（覆盖 `Agent({resume})` 新 runId 续跑同文件）。已知残余窗口：resume 准入后、`session_created` 写入 diag.sessionFile 前（秒级）扫不到——接受并在文档声明（fork 到半截回合的最坏后果是答案基于稍早上下文，不破坏源文件）。

### 4.6 设置（`src/config/settings.ts` + `setting-specs.ts`，评审 #20 收敛后）

```ts
export interface ConsultSettings {
  enabled: boolean; // default true（暴露面由 experts 白名单控制）
  timeoutMs: number; // default 150_000（totalMs 硬顶）
  maxAnswerChars: number; // default 2_000（截断兜底 + prompt 指令）
  maxTurns: number; // default 3（评审 #4：超过即 abort，返回部分答案）
  maxCostUsd: number; // default 0.5（评审 #4：0 = 关闭成本帽）
  maxConcurrent: number; // default 2（评审 #13：每提问方 in-flight consult 上限）
}
```

内部常量（不进 settings，防旋钮 creep）：`FORK_TTL_MS = 24h`（sweep 窗口）、`CONSULT_MAX_CONTEXT_PERCENT = 75`（评审 #19 预检阈值）。
`AgentSettings` 加 `consult: ConsultSettings`；`DEFAULT_SETTINGS` 给默认值；`setting-specs.ts` 加 `consult.*` 条目（TUI 设置编辑器自动可见）。

## 5. 关键决策（OQ1–OQ7 逐条）

### OQ1 fork 机制 → **工具侧同步 `SessionManager.forkFrom` + `driver.resume` 接缝**（评审 #2 方案①，采纳）

- **机制不变**：forkFrom 新 id、`flag:"wx"` 防覆盖、`parentSession` 溯源、源文件零写入、返回独立新实例（并发 fork 同一专家天然安全，F2）。
- **v2 变化（为什么）**：v1 让 driver 在 runner 内部 fork，导致 ① 工具拿不到 fork 路径（`diag.sessionFile` 要等 `session_created`，建会话失败/超时/Esc 就丢路径、只能等 24h TTL）；② finally 删文件与异步 reap 的 `_persist` 竞态（删后重写出无 header 残片）。方案①把 fork 移到工具侧同步执行：**路径在 spawn 前已知**，建会话失败根本不会发生在这条路径之前——fork 成功的文件经 `forkSessionFrom` 交给**既有** `driver.resume` 打开，`driver.fork`/三态分派/运行时对 consult 的反向依赖（评审 #16）全部消失。
- **fork 文件生命周期（单一事实源）**：
  1. fork 成功、spawn 准入 throw（或任何 spawnAndWait throw）→ 工具 catch 里**立即删**（尚无 run 触碰，无竞态）；
  2. run 启动过（任何终局）→ 登记 `pendingDeletions[consultRunId]=forkFile`，**runner `onReaped` 回调里删**（reap 之后，无 `_persist` 竞态；reap 失败也触发）；
  3. 崩溃/强杀/回调遗漏 → `buildSessionStack` 时 `sweepForkDir(dir, FORK_TTL_MS)` 兜底（同步扫，目录常态为空或极小）。
     **不新增任何 timer。**
- **落点**：`join(getAgentDir(), "cache", "consult-sessions")`（评审 #15：`getAgentDir` 是 pi 官方访问器，session-driver 已在 import；不再从 `getSessionDir()` 上推两级——自定义 session 目录/`PI_CODING_AGENT_DIR` 下不会算错）。pi `/resume` 只扫 `<agent>/sessions/`，此目录在其外，不污染列表。
- **cwd 解析链（评审 #6）**：`readHeaderCwd(sourceFile)`（**只读首行、上限 8KB** 的受限读，不整文件读）→ `existsSync(cwd)` 失败 → `resolveWorktreeOrigin(cwd)`（worktree 专家被 `beforeReap` 删掉 worktree 后映射回原仓库；注册表 per-reap 清理，可能已失效）→ 仍失败 → 回退**提问方 cwd**（工具侧已知）。解析结果经 `SpawnRequest.cwd` 传入。
- **否决项维持 v1**（交接包 ruledOut）：`createBranchedSession`（原地 mutate、落点在专家 sessionDir 污染 `/resume`）、`branch/branchWithSummary`（只移 leaf 仍写原文件）、手复制 jsonl（同 id、无 parentSession、无 wx）。

### OQ2 专家指定 → **派发时白名单 `Agent({experts})` + 派发时解析；主会话与工作流 v1 不支持**（§4.2）

- 白名单理由同 v1（最小攻击面：实验 3 Q2 证明「有信息但读不到」时模型会越权翻文件）。评审 #5 的加固（派发时解析）同时带来调度方即时反馈，一并采纳。
- **安全模型（显式声明，评审 #14b）**：`AgentToolParams` 由主会话与嵌套 canSpawn 调度方共用（`agent-tool.ts:117`）——**任何能调用 Agent 工具的上下文都能把任意可解析的已终态 run 授权给自己派发的子 agent**，信任等级与既有 `Agent({resume})` 完全同级（resume 本来就能打开任意可解析会话并续写，比 consult 的只读 fork 更强）。不采纳「只能授权自己子树内的 run」：主用法恰是调度方把**兄弟**上游授权给下游，子树限制会杀掉主用法；授权者（能派发 agent 的上下文）即信任边界。
- 主会话不提供 consult（同 v1）；workflow 穿透列为后续（非目标，§1）。

### OQ3 reload 重建 → **ExpertIndex + live 查询合并**（§4.5），降级路径显式化（评审 #17）

- 重建与解析同 v1；新增：**reload 后新派发的提问方在派发时经 index 解析**——label 撞名不可能问错人（resolved ref 里是 runId + 绝对路径 sessionFile，consult 按 runId/路径操作，label 仅显示）。
- **降级路径（写清 + nack 文案）**：
  - `rememberAgents=false`：专家 run 无 sessionFile → 派发时解析即失败，throw 文案含 `agent type runs without persisted sessions (rememberAgents=false)`；
  - readBack 探测失败 → `prefetchedEntries=[]`（`stack.ts:849-850`）→ index 为空 → reload 后所有 consult nack `unavailable`（reload 前 live 路径仍可用），文案建议「重新派发（run 在当前进程内可解析）」；
  - 主会话 `/resume`（非 reload）：评审已核查 `getEntries()` 返回全部 fileEntries、`open()` 全量加载（`session-manager.js:982-984`）——v1 的高估风险解除；T-9 保留为行为锁定测试但**降为非阻塞**，P0 不再依赖它。

### OQ4 模型/thinking/工具 → **数据驱动：v1 默认只读工具域，P0 探针定最终取舍（⚠️ 待用户重新确认，§12）**

模型与 type 沿用专家原配置不变（`type: ref.agentType` + `modelOverride: ref.model`；换模型=缓存键全换，无争议）。**工具集**是 v1 与用户已确认决策（§12 OQ4）冲突、被评审 #3 质疑前提的点，两种做法对比：

| 维度       | A. 保留专家原工具集（用户已确认）                                                                                                                                                                                                                                                                                                                                                                                                                                            | B. 只读 allow 列表（评审 #3 建议，v2 推荐）                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缓存前缀   | **可能**命中，但有四个独立失效前提：① 专家带过 schema → 注入过 `StructuredOutput`（444-457）、带过 experts → 注入过 consult，工具块从头不同；② `thinkingOverride` 未持久化（RunDiagnostics 无 thinking 字段），专家覆盖过 thinking 即回退类型默认，请求参数不同 → 全 miss；③ memory 块 pre-guard 注册、子会话 system prompt 也含动态 memory 块，内容一变前缀从该处 miss；④ 默认 5m 命名空间窗口，主用法（上游结束后调度方才派发下游）经常已过期（1h 实测存活也仅 7–13.6min） | **必然全量重写**（工具块在请求前缀头部，裁剪=从头 miss），成本约 $1.5/次（长上下文专家）vs 命中时 ~$0.1/次                                                  |
| 副作用风险 | 请教 run 150s 内持有 write/edit/bash（可改提问方正在用的工作区）、canSpawn 类型注入嵌套 Agent（可派子 agent）、fabric 开启时注入 message_agent（可发消息）；F5「默认不需要工具」不成立                                                                                                                                                                                                                                                                                       | 零写能力；不注入 Agent/message_agent/StructuredOutput/set_model；攻击面 = 只读                                                                              |
| 实现       | adapter 无需特判                                                                                                                                                                                                                                                                                                                                                                                                                                                             | adapter 按 `spec.request.forkSessionFrom !== undefined` 识别请教 run：跳过全部注入 + `buildToolScopePolicy` 改为 allow `{read, grep, find, ls}`（约 15 行） |
| 可逆性     | 出事故才能发现                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 若 P0 数据显示保留工具能稳定命中，翻转点 = adapter 这一个分支（约 10 行 delta），可后补 `consult.expertTools: "readonly" \| "preserve"` 旋钮                |

**v2 推荐 B（只读）**：A 的省钱前提需要四个条件同时成立，而主用法的时序（下游派发通常晚于上游结束 5 分钟以上）使条件④在常见路径上天然不成立——即大概率「付了全价还承担了写风险」。但这是数据问题，不应靠论证拍板：

- **P0 探针新增必测项**：fork 后首个请求的 `cacheRead` 占专家最后一次前缀 token 数的比例（**锚前缀 token 数，不看 `cacheRead>0`**——跨会话共享 system/tools 块 ~11.3k tok 恒命中）。在「专家带 schema / thinkingOverride / 结束 >5min 后请教」三种场景各测一次；全保留工具（A 形态）下实测。
- **判定线**：命中率 ≥60% 且主时序场景下窗口常活 → 提供 `consult.expertTools` 旋钮并默认 preserve；否则 B 为终态。
- **决策权**：用户已确认过 A（§12 OQ4），评审 #3 质疑的是该确认的**前提**。v2 方案默认按 B 施工，但**不擅自推翻用户决策**——由主会话把对比表与 P0 探针设计带回给用户重新确认（§12 ⚠️）。

### OQ5 回答长度上限 → **指令自控 + 硬截断兜底**（评审 #9/#10 修正）

- prompt 注入「结论先行 ≤3 行、总长 ≤N 字」（N = settings.maxAnswerChars，默认 2000；不再有模型面参数，评审 #20）。
- 截断用 `truncateResultText(text, max)` **且不传 sessionFile**（评审 #9：传了会追加 "full session transcript: … use the read tool"，等于把提问方引去读一个马上要被删的 fork 文件，正是本设计杜绝的越权翻记录）。注意其实际形态是**保留头部 70% + 尾部、省略中段**（marker：`… [middle X of Y chars omitted — showing first A + last B]`），与「结论先行」指令相容（头部保大头）。
- 超时/被帽/失败但 `outcome.text` 非空 → 返回部分答案 + `details.partial=true`（评审 #10；`state-machine.ts:769-773` 保证非正常终态保留已流出文本）。

### OQ6 集成点 → §8。OQ7 测试策略 → §9（评审 #7 重写）。

### F4 默认值与闸门汇总（评审 #4 补齐后）

| 闸门       | 值                                                                      | 机制                                                                                                                              |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 时间硬顶   | `consult.timeoutMs` 默认 150s                                           | `budgetOverride.totalMs` 显式 → `maxTotalFactor=1`，无宽限无延长（`deadline.ts:96-110`）                                          |
| 轮次上限   | `consult.maxTurns` 默认 3                                               | onSnapshot tap 数 `diag.turns`，超帽 `abortRun`（§4.1）；请教是单轮问答，>3 轮说明专家在跑工具，边际价值低                        |
| 成本上限   | `consult.maxCostUsd` 默认 $0.5（0=关）                                  | 同 tap 读 `diag.usage.costUsd`（X9 生命周期累加）；默认值为实验成本 $0.08–0.12 的 ~4–6 倍                                         |
| 并发上限   | `consult.maxConcurrent` 默认 2（每提问方）                              | wireConsult 闭包计数器，超额立即 nack busy（§4.1）；slotless 不再等于无上限扇出                                                   |
| 上下文预检 | 常量 75%                                                                | 专家终态 `contextUsage.percent` 超阈 → 快速 nack（避免触发 pi 自动压缩——压缩相位预算 5 分钟 ≫ 150s，必然超时+额外成本，评审 #19） |
| slotless   | `true`（同 v1）                                                         | 150s 短前台任务不占并发槽；queue-timeout 保护的缺失由 totalMs 硬顶 + 并发上限覆盖                                                 |
| 深度       | 计入 parent.depth+1，受 `maxNestedDepth` 约束（§4.4，评审 #1 要求写死） | 超限 → config → nack                                                                                                              |

## 6. 文件级改动清单（函数名级）

> 引用优先符号名；行号仅供定位，可能与并行改动漂移。

**包 A — 冻结面（types/settings/threading）**

1. `src/core/types.ts`：`ConsultExpertRef` 接口；`SpawnRequest` += `consultExperts?: ConsultExpertRef[]`、`forkSessionFrom?: string`（doc 注释见 §4.3）。
2. `src/service/request-threading.ts`：`THREADED += "forkSessionFrom"`；`NOT_THREADED += "consultExperts"`。不改断言机制。
3. `src/config/settings.ts`：`ConsultSettings`（§4.6 六字段）、`AgentSettings.consult`、`DEFAULT_SETTINGS.consult`、解析段（615 一带同款 number 校验模式）。
4. `src/config/setting-specs.ts`：`SETTING_SPECS` 加 `consult.enabled/timeoutMs/maxAnswerChars/maxTurns/maxCostUsd/maxConcurrent`。

**包 B — fork 路径（spawn 准入 / runner / 复用 driver.resume）**

5. `src/runtime/runner.ts`：`ResolvedSpawnRequest` += `forkSessionFrom?: string`；session_create 分派加 fork→`driver.resume` 分支（§4.4，~3 行）；`RunnerDeps` += `onReaped?`；finally 的 `runReap()` 链上回调（§4.4，~5 行）。**`session-driver.ts` 零改动。**
6. `src/service/spawn-service.ts`：
   - spawn() 准入加 `forkSessionFrom` 分支（§4.4：互斥校验、existsSync+isFile、不进 resumeLocks）；
   - canSpawn 检查加 `!req.forkSessionFrom` 豁免（§4.4）；深度照常计；
   - **顺手修缺口**：`start()` catch 的 `notifyTerminalFailure`（243 一带）加 `req.parentRunId === undefined` 判据。**理由（评审 #18 更正版）**：该 catch 捕获的是 `runner.run()` 自身抛异常（非返回失败 outcome）的路径——此路径上子 run 会漏发顶层通知；session_create 失败走 runner 内部 catch → `prompt_settled`（`state-machine.ts:760` 合法），不可达此处。修复本身无害且值得做，T-8 锁定。
7. `src/service/ports.ts`：`RunnerSpec` 不动（request 是完整 SpawnRequest）。

**包 C — consult 模块与注入**

8. `src/consult/expert-index.ts`（新）：§4.5（pi-free）。
9. `src/consult/fork-store.ts`（新）：`consultSessionDir()`（getAgentDir）、`readHeaderCwd(path)`（≤8KB 受限读）、`resolveForkCwd(sourceFile, fallbackCwd)`（§5.1 解析链）、`forkExpertSession(sourceFile, fallbackCwd)`（包 `SessionManager.forkFrom`）、`sweepForkDir`、`removeForkFile`、pendingDeletions 登记/`onReaped` 消费。全部同步 fs + try/catch 静默降级。
10. `src/consult/consult-tool.ts`（新）：`createConsultTool(deps)`（§4.1 全部语义：并发闸门、存活复核、上下文预检、try/catch→nack、watcher、partial 答案、截断不传 sessionFile）。
11. `src/consult/index.ts`（新）：`wireConsult({ settings, query, spawn, spawnFull, hostSessionFile access, prefetchedEntries })` → `{ depsFactory(selfRunId, whitelist), expertIndex, resolveExperts(refs), sweep(), onReaped(runId), snapshotTap(runId, cb) }`；闭包持有并发计数器与 watcher 注册表。
12. `src/service/runtime-adapter.ts`：
    - deps += `consult?: (selfRunId: RunId, whitelist: readonly ConsultExpertRef[]) => ToolDefinition | undefined`；
    - `run()` 内 set_model 注入后加：`if (spec.request.consultExperts?.length && deps.consult && settingsEnabled) { customTools.push(...); grantedReserved.push("consult"); }`（M1 合并与 toolScope granted 自动生效）；
    - **请教 run 只读域**（§5.4-B）：`if (spec.request.forkSessionFrom !== undefined)` → 跳过 message_agent/set_model/Agent/StructuredOutput 四处注入，`toolScope = buildToolScopePolicy({ tools: ["read","grep","find","ls"], granted: [] })`。
13. `src/runtime/tool-scope.ts`：`RESERVED_TOOL_NAMES` += `"consult"`（注释同 set_model 先例；`index.ts:107` 的引用注释同步）。
14. `src/tools/agent-tool.ts`：`AgentToolParams` += `experts`（§4.2）；deps += `resolveExperts?`；execute 内解析校验（失败 throw、running 警告行）+ `baseRequest.consultExperts` 穿透。

**包 D — stack 接线与文档**

15. `src/stack.ts`（buildSessionStack）：
    - `const consult = wireConsult({...})`；`consult.expertIndex.rebuildFromEntries(prefetchedEntries)`；`consult.sweep()`；
    - runner deps += `onReaped: consult.onReaped`；
    - spawn-service 的 `onSnapshot`（1201 处）尾部加 `consult.dispatchSnapshot(snapshot)`（tap 分发）；
    - runtime-adapter deps（1107 一带）+= `consult: consult.depsFactory`；agent-tool deps += `resolveExperts: consult.resolveExperts`。
16. `docs/dev/consult/plan.md` 本文件；CHANGELOG 由 conventional commit 生成。
17. `src/index.ts`：**不改**（主会话不注册 consult；Agent 工具改动在 agent-tool.ts 内）。

规模估算：新增 ~750 行（consult 模块 ~500），改动 ~120 行（runner/spawn/adapter/tool-scope/agent-tool/settings/stack），测试 ~900 行。

## 7. 零挂死论证（逐条不变量 → 保证代码）

| 不变量                     | 保证点                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每个 run 有总预算硬顶      | consult 必传 `budgetOverride.totalMs = settings.consult.timeoutMs` → `applyBudgetPolicy` 钳 `maxTotalFactor=1`：无宽限、无延长、到时必死（`deadline.ts:96-110`）                          |
| 轮次/成本不失控（评审 #4） | onSnapshot tap 超帽即 `abortRun`；abort 走既有级联（L0→L4 升级 + abortGrace 10s），与 totalMs 硬顶叠加——帽失效时硬顶仍兜底                                                                |
| 准入不被误拒（评审 #1）    | fork 专用分支跳过 canSpawn；深度照常计；**请教 run 自身 nesting 无 canSpawn**（不注入嵌套 Agent），无法再往下派                                                                           |
| 子阶段 watchdog            | EventWatchdog 1Hz tick 对请教 run 同等生效；各相位预算 < 150s 时相位先杀，> 时 totalMs 先杀——两条链都在                                                                                   |
| 精确 deadline 第二生产者   | runner `guardUntil`（含宽限重臂）对 fork 路径无差别生效（fork 只改 session_create 相位的文件来源，后续相位与 resume 完全同路径）                                                          |
| reaper 孤儿回收            | fork 建会话超时/取消 → 既有 `driver.onLateArrival` → `reaper.disposeLate`；fork 文件删除挂在 `onReaped`（reap 完成后），崩溃残留由 TTL sweep 兜底——**无 `_persist` 残片竞态**（评审 #2c） |
| 提问方中止级联             | 三条既有链全部命中（cascadeChildren / onChildAbort / 工具 signal 透传 spawnAndWait——**不用** `detachSignalOnStart`）                                                                      |
| 可确认投递                 | 工具内同步 await，结果随工具结果返回，不经 outbox                                                                                                                                         |
| 不产生顶层通知             | CC2 自动生效 + notifyTerminalFailure 修复（§6 包 B-6，理由已更正）                                                                                                                        |
| timer unref                | **不新增任何 timer**（watcher 走 onSnapshot tap；sweep 只在 build 时同步执行）                                                                                                            |
| 无模块级可变状态           | ExpertIndex/pendingDeletions/并发计数器/watcher 注册表全在 wireConsult 闭包内，随栈重建                                                                                                   |
| 子会话惰性                 | consult 不经 index.ts 注册；子会话激活被 HOST_KEY 守卫短路；注入仅发生在 adapter（本进程内）                                                                                              |
| forkSessionFrom 不可伪造   | RPC `additionalProperties:false`、workflow 逐字段组装（评审已核查）；进程内唯一产出者是 consult 工具（fork-store 刚创建的路径）                                                           |

## 8. 与现有子系统的集成

- **嵌套 Agent / tool-scope**：consult 注入走 customTools+grantedReserved 既有管线；M1 合并让声明了 `tools:` 白名单的类型也拿得到 consult；enforcer 在 bind/turn_end 重放防 MCP 同名冒名。**请教 run 反向走只读域**（§5.4-B）：`forkSessionFrom` 存在即跳过全部注入 + allow 仅 `{read,grep,find,ls}`——write/edit/bash/Agent/message_agent/StructuredOutput/set_model 全部不在定义里。
- **通知抑制**：CC2 + notifyTerminalFailure 修复。请教 run 终态仍写 `subagent:run` 条目（ExpertIndex 按 consultDir 排除之，§4.5）与 fleet 行——特性（可观测），不是泄漏。
- **fleet widget**：`parentRunId` 使 toRow `nested=true`、treeOrder 自动缩进；label `consult-<rand4>`。二层以上嵌套渲染未实测 → 验收步骤 §10。
- **成本归集**：工具结果 `usage: toPiToolUsage(outcome.usage)` 进 pi 总账；fleet `usageTotal`、HUD `subagent:usage` 广播自动覆盖。
- **cache-ttl**：无代码交互（子会话不经 wireCacheTtl 钩子）。机制层提示写进工具描述：**可能**命中共享前缀，命中条件（评审 #19 要求的清单）——① 同模型；② 专家结束在 5m 命名空间窗口内（`PI_CACHE_RETENTION=long` 时 1h，实测存活 7–13.6min）；③ memory 块等动态段未变；④ 专家无 schema/experts 注入差异、未覆盖 thinking；⑤ 保留原工具集（若 §5.4 最终采纳只读域，此条必然不成立、按全价计）。调度方应「趁热请教」。判命中锚前缀 token 数比例，不看 `cacheRead>0`。
- **bash_jobs / delivery / workflow**：请教 run 是标准嵌套 run，backgroundBusy 计数在请教期间为忙——feishu 完成卡与 keepalive 判忙被按住，语义正确。

## 9. 测试锚点（评审 #7 重写版）

**单元（tests/consult/）——fork 用真实 `SessionManager.forkFrom` 操作临时目录，`createAgentSession` 不需要（工具侧 fork 不经它）；准入用真实 `createSpawnService`**

- T-1 expert-index：只收终态+sessionFile；**consultDir 下记录被排除**（评审 #11）；三级解析与 `resolve-target` 语义一致（同一 fixture 参数化两边，评审 #21）；label 覆盖；缺字段容错。
- T-2 consult-tool 解析/闸门失败面：白名单外 → throw 含 allowed 列表；会话缺失 → nack unavailable；**按 sessionFile 命中运行中 run → nack still_running**（评审 #12）；**上下文占用 ≥75% → nack context_too_large**（评审 #19）；**并发超帽 → nack busy**（评审 #13）。
- T-3 consult-tool 成功面：mock spawnAndWait 返回 completed → 文本 + usage 回传 + `details.truncated`；**截断 marker 为「保留头 70%+尾」形态且不含 session transcript 指引**（评审 #9）。
- T-4 consult-tool 失败面：timed_out/aborted/failed 无文本 → nack；**有文本 → partial 返回 + `details.partial=true`**（评审 #10）；**spawnAndWait throw（config）→ nack + forkFile 已删**（评审 #8）；断言白名单内从不 throw、从不发无 forkSessionFrom 的 spawn。
- T-5 级联与入参：工具 signal → spawnAndWait 收到同一 signal；parentRunId = selfRunId；slotless=true；budgetOverride.totalMs = settings.timeoutMs；cwd = 解析链结果。
- T-6 fork-store（**真实 forkFrom**，tmp 目录）：fork 后**源文件 sha256 不变**（F2 核心断言落在这里，真实 SDK 路径）；fork 文件 header 含 `parentSession`、新 id 与源不同、落在 consultDir；`wx` 不覆盖已有文件；**cwd 解析链：header cwd 存在用之 / 不存在走 worktree-origin（预先 recordWorktreeOrigin）/ 注册表 miss 回退 fallback**（评审 #6）；`readHeaderCwd` 截断与坏行容错；sweep TTL 与容错。
- T-7 spawn-service 准入（**真实 createSpawnService**，评审 #1/#7）：**父类型无 canSpawn + forkSessionFrom → 准入通过**；无 forkSessionFrom 的同型嵌套 → 仍被拒（防回归）；fork+resumeFrom 同现 → config 错误；路径不存在 → config 错误；不进 resumeLocks（同专家两 consult 并行不互斥）；深度超限 → config 错误；**请教 run 的 nesting 条目无 canSpawn（它再派子 agent 被拒）**。
- T-8 notifyTerminalFailure 修复：`runner.run` 自身抛异常 + parentRunId 非空 → 不发顶层通知（回归锁定；触发路径按 §6 包 B-6 的更正版理由构造）。
- T-9 行为锁定（**非阻塞**，评审 #17）：主会话 jsonl 含 `subagent:run` 条目 → `getEntries()` 返回包含它们；红则记录 issue，不触发备选方案 B（评审已核查 `getEntries` 全量语义）。
- T-10 request-threading：never 断言编译门已覆盖；fixture 级防回退断言（可选）。
- T-11 watcher（评审 #4）：快照 `turns > maxTurns` → abortRun 恰好一次；`costUsd > maxCostUsd` → 同上；maxCostUsd=0 不触发；终态后退订（注册表为空）。
- T-12 adapter 只读域（评审 #3）：`forkSessionFrom` 存在 → customTools 无 Agent/message_agent/StructuredOutput/set_model，toolScope allow = {read,grep,find,ls}；普通子 run 不受影响（对照）。

**集成（tests/integration/consult.test.ts，spawn-service+runner 级 + mock driver；真实 pi 会话端到端由 P0 探针一次性覆盖——仓库无假模型/录制层惯例，评审 #7）**

- T-13 端到端（mock driver 的 `resume` 断言被以 forkFile 调用）：派发专家（带 experts 的提问方）→ consult → 答案返回；**断言 runner 收到 forkSessionFrom 且走了 driver.resume 分支**。
- T-14 并发：同专家两 consult 并行 → 各自 forkFile、各自返回、源文件字节不变（fork-store 层真实 fork，driver mock）。
- T-15 fork 文件清理三路径：正常终局 → `onReaped` 后文件已删；建会话超时（mock driver resume 挂起）→ reap 后已删；准入 throw → catch 立即删（评审 #2 要求的失败矩阵）。
- T-16 reload 后 consult：冻结条目 → 重建栈（records/labels 空）→ **新 run 起同名 label**（评审 #5 的失败模式）→ 派发时解析仍命中旧专家 runId、consult 成功且不问错人。
- T-17 提问方中止：consult 进行中 abort 提问方 → consult run aborted 且 forkFile 经 onReaped 清理。
- T-18 fleet：consult run toRow `nested===true` 且 parentRunId 指向提问方。
- T-19 零通知：全程主会话 `subagent:notification` 条目数为零、无 triggerTurn。
- T-20 派发时校验（评审 #5）：experts 含不存在项 → Agent 工具 throw 含候选列表；含运行中项 → 派发成功且结果文本含警告行。

## 10. 实施顺序与分包

| 包                      | 内容                                                                                       | 依赖 | 可并行                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------- |
| **P0 验证**（阻塞一切） | §11-1 fork 探针（含 **cache 命中率实测**，§5.4）+ §11-2 大文件复制耗时                     | 无   | —                                                    |
| **A 冻结面**            | §6 包 A（types/threading/settings）                                                        | P0   | —                                                    |
| **B fork 路径**         | §6 包 B（runner 分派 + onReaped + spawn 准入分支 + notifyTerminalFailure 修复）            | A    | 与 C 并行                                            |
| **C consult 模块**      | §6 包 C（src/consult/* + adapter 注入/只读域 + tool-scope + agent-tool）                   | A    | 与 B 并行（冻结面 = §4.3 字段 + §4.4 onReaped 签名） |
| **D 接线收口**          | §6 包 D（stack.ts）+ 单元 T-1..T-12                                                        | B+C  | —                                                    |
| **E 集成验收**          | T-13..T-20 + fleet 二层嵌套手动验收 + `npm run format:check && typecheck && test && build` | D    | —                                                    |

包间冻结面 = §4.3 两个字段（含 `ConsultExpertRef` 形状）+ §4.4 `onReaped` 签名 + §4.5 `ExpertRecord` 形状，包 A 合并后不得再改。

## 11. 风险与待验证项

1. **fork 路径端到端从未跑过**（最高危，维持 v1）。**P0 探针** `scripts/exp/consult-fork-probe.mjs`（半天内）：真实已结束子会话文件 → `fork-store` 同款 `forkFrom` → `createAgentSession({...toCreateOptions 同款配置, sessionManager: SessionManager.open(forkFile)})`（即 driver.resume 同款注入）→ `session.prompt(...)` → 断言：① 有回答且看得见历史；② 源文件 sha256 前后一致；③ fork 文件落点与 header parentSession 正确；④ systemPrompt 组装不报错；⑤ **【新增，§5.4】记录 fork 后首个请求的 `cacheRead` 与其占专家最后前缀 token 数的比例**（锚前缀 token 数；覆盖「带 schema / thinkingOverride / 结束 >5min」三场景，全保留工具形态下测）。通过才允许包 B 开工；失败回退评审 `createBranchedSession`。
2. **forkFrom 同步全量复制的事件循环阻塞**：探针顺带造 ~10MB 会话文件测耗时；>100ms 则在 fork-store 内流式复制替代（保持 wx + 新 id + parentSession 语义手写，~40 行），接口不变。
3. **`onReaped` 时序**：回调在 `runReap()` 完成后触发，而 reap 内部 dispose 可能再触发 `_persist`——删除在其后，无竞态；但 reap 自身有 5s 预算（`budget.reapMs`），onReaped 不受其阻塞（链在 promise 上）。T-15 锁定。
4. **fleet 二层以上嵌套渲染**：E 阶段手动验收；渲染异常不阻塞功能，单列 issue。
5. **pi-ai 各 provider cache_control 细节未逐查**：不做精确成本预算；§5.4 的 P0 实测即量化手段。
6. **pi 核心按会话 id 的目录外索引未查**：fork 文件在 cache 目录且生命周期短（onReaped 即删），风险已消解。
7. **resume 续跑窗口**（评审 #12 残余）：resume 准入到 `session_created` 之间按 sessionFile 扫不到——秒级、后果有限（答案基于稍早上下文），接受。
8. **并行改动冲突**：触碰 spawn-service 准入段与 runtime-adapter 注入段两个热点；施工一律按符号名定位，不依赖行号。

## 12. 用户确认记录（2026-09-24；v2 追加）

- OQ2：**v1 只给子 agent**（主会话不注册 consult，需要时继续用 `Agent({resume})`）——确认。
- OQ4：**被请教的专家保留其原工具集**（换取缓存前缀命中，约 $0.1/次 vs 去掉工具约 $1.5/次；150s 硬上限兜底）——确认。
- 开工仍以 opus-5.5 评审结论为准（HARD GATE）。
- ⚠️ **待用户重新确认（v2）**：评审 #3 质疑了已确认的 OQ4 前提——缓存命中需要四个条件同时成立（无 schema/consult 注入差异、thinkingOverride 未持久化无法对齐、memory 块动态、主用法时序下 5 分钟窗口常已过期），且保留写工具有副作用风险（可改提问方工作区/派子 agent/发消息）。v2 的处置：§5.4 对比表 + **推荐默认只读** + P0 探针实测命中率后定终态。**请主会话把 §5.4 对比表与探针设计带回给用户，确认「默认只读、探针定终态」或坚持「保留原工具集」。**

- ✅ **用户最终确认（2026-09-24，v2 之后）：B「v1 默认只读工具域，P0 探针实测后再定」**——用户曾短暂改选 A（保留原工具），听取缓存前提/写风险/可逆性分析后改回 B。施工以 §5.4 的 B 为默认；P0 探针实测命中率 ≥60% 且主时序窗口常活时，再加 `consult.expertTools: "readonly" | "preserve"` 旋钮切回保留。

## 13. 评审处置表（review-1.md，21 条）

| #   | 严重度 | 处置              | 方案改动位置                                                                                                                        | 理由                                                                                                                                                                                                                                                                                                                                           |
| --- | ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞   | **采纳**          | §4.4（fork 准入分支跳过 canSpawn、深度计入 parent.depth+1、请教 run nesting 无 canSpawn）、§7、§9 T-7                               | 抽验 `spawn-service.ts:335-345/430/447` 属实：每个 run 都写 nesting，父类型无 canSpawn 时请教必被拒且 spawnAndWait throw。深度口径按评审要求写死为「计入并受 maxNestedDepth 约束」。T-7 用真实 createSpawnService                                                                                                                              |
| 2   | 严重   | **采纳（方案①）** | §3、§4.4、§5.1、§6 包 B/C、§9 T-6/T-15                                                                                              | 方案①同时消解 (a) 路径不可知、(b) 失败路径泄漏、(c) reap 竞态与 #16 依赖反转：工具侧同步 fork 路径先知；`driver.resume` 接缝复用使 driver 零改动；删除挂 `onReaped`（runner 新增 ~5 行回调），崩溃残留由 TTL sweep 兜底                                                                                                                        |
| 3   | 严重   | **部分采纳**      | §5.4（对比表+推荐只读+P0 探针+翻转点）、§4.4/§6 包 C-12（adapter 只读域）、§8（cache 措辞改「可能命中」+条件清单）、§9 T-12、§12 ⚠️ | 评审的四个前提质疑全部有代码证据（已抽验 444-457/371/395-440）。但用户已确认 A，不擅自推翻：v2 默认按只读施工并把决策连同 P0 探针数据设计交还用户。「保留定义、拦截执行」无现成接缝（toolScope 只有 allow/deny），不构成第三条路                                                                                                               |
| 4   | 严重   | **采纳**          | §4.1（watcher）、§4.6（maxTurns/maxCostUsd）、§5 F4 表、§9 T-11                                                                     | 仓库确无 run 级 maxTurns（仅 goal 有）。经 `deps.onSnapshot` tap 实现，不新增 timer；超帽 abort 后按 #10 返回部分答案                                                                                                                                                                                                                          |
| 5   | 严重   | **采纳**          | §4.2（派发时 resolveExperts：失败 throw、running 警告）、§4.3（consultExperts 改存 ConsultExpertRef）、§4.5、§9 T-16/T-20           | labels 只写不删 + reload 清空 + live 优先，确实会重放 e1-r2 问错人。准入时解析成 runId 后 label 仅显示用；解析失败当场反馈调度方                                                                                                                                                                                                               |
| 6   | 严重   | **采纳**          | §5.1（cwd 解析链 existsSync → worktree-origin → 提问方 cwd）、§9 T-6                                                                | `worktree.ts:90-123` beforeReap 删 worktree 属实；`core/worktree-origin.ts` 现成（pi-free、Symbol.for 全局），但 per-reap 清理后可能 miss，故需三级兜底                                                                                                                                                                                        |
| 7   | 严重   | **采纳**          | §9 全部重写；§10 P0                                                                                                                 | 核查属实（tests/integration 无真 pi 会话）。fork 单测改用真实 `forkFrom`+tmp 目录，F2 字节断言落在 T-6（真实 SDK）；准入用真实 createSpawnService（T-7）；评审列的缺失锚点全部补齐（T-7/T-4/T-15/T-6/T-16/T-12/T-2/T-11）                                                                                                                      |
| 8   | 一般   | **采纳**          | §4.1 错误表（spawn 准入 throw → try/catch → nack + 立即删 forkFile）、§1 F1 行                                                      | `spawnAndWait` throw（:447）属实；两处口径统一为「白名单外/空问题 throw，其余一律 nack」                                                                                                                                                                                                                                                       |
| 9   | 一般   | **采纳**          | §5.5、§9 T-3                                                                                                                        | 抽验 `result-text.ts:14-45`：确为头 70%+尾，且传 sessionFile 会追加读文件指引。调用时不传 sessionFile，文档写明实际截断形态                                                                                                                                                                                                                    |
| 10  | 一般   | **采纳**          | §4.1 错误表（partial 行）、§5.5、§9 T-4                                                                                             | `state-machine.ts:769-773` 注释属实；「结论先行」下部分答案正是最有价值的部分                                                                                                                                                                                                                                                                  |
| 11  | 一般   | **采纳**          | §4.1（label 改 `consult-<rand4>`）、§4.5（按 consultDir 排除，结构化判据）、§9 T-1                                                  | label 前缀排除三重不可靠（用户可仿冒/36 截断/live 路径未排除）属实；consultDir 判据两条路径通用且不可伪造；随机 base 消除 999 后缀耗尽                                                                                                                                                                                                         |
| 12  | 一般   | **采纳**          | §4.5（按 sessionFile 扫 live）、§4.1 still_running 行、§9 T-2、§11-7                                                                | resume=新 runId 同 sessionFile（`spawn-service.ts:411-416` 双键锁佐证）属实；resumeLocks 是 spawn-service 闭包私有，不为其开端口——live 扫描已覆盖主体，秒级残余窗口声明接受                                                                                                                                                                    |
| 13  | 一般   | **采纳**          | §4.1（busy nack）、§4.6（maxConcurrent 默认 2）、§9 T-2                                                                             | slotless 绕过槽位池属实；每提问方计数器在 wireConsult 闭包，随栈重建                                                                                                                                                                                                                                                                           |
| 14  | 一般   | **部分采纳**      | §1 非目标（workflow 不支持 experts）、§4.2 声明、§5.2 安全模型段                                                                    | (a) workflow 穿透评估为超出 v1 爆炸半径（spawner-adapter/ChildSpawnRequest/journal 回放三面都要动），显式列非目标；(b) 不采纳子树限制（杀掉兄弟授权主用法），但把「任何 Agent 调用方可授权任意可解析终态 run，与 resume 同级信任」写入安全模型                                                                                                 |
| 15  | 一般   | **采纳**          | §5.1、§6 包 C-9                                                                                                                     | `getAgentDir` 是 pi 官方访问器且 session-driver 已 import；上推两级在自定义 session 目录/`PI_CODING_AGENT_DIR` 下确实会算错                                                                                                                                                                                                                    |
| 16  | 一般   | **采纳**          | §3 依赖方向、§4.4                                                                                                                   | 随 #2 方案①自然消解：driver 零改动，`readHeaderCwd` 留在 consult/fork-store，cwd 经 `SpawnRequest.cwd` 传入；header 读取限定首行 ≤8KB                                                                                                                                                                                                          |
| 17  | 一般   | **采纳**          | §5.3（两条降级路径 + nack 文案）、§9 T-9 降非阻塞、§10 P0 不再依赖                                                                  | rememberAgents=false 无 sessionFile（session-driver.ts:312-313）与 readBack 失败 prefetchedEntries=[]（stack.ts:849-850）属实；`getEntries` 全量语义（session-manager.js:982-984）支持风险降级                                                                                                                                                 |
| 18  | 一般   | **采纳**          | §6 包 B-6（理由更正为「runner.run 自身抛异常」路径）、§9 T-8                                                                        | 抽验确认：driver 同步抛错走 runner 内部 catch → prompt_settled（`state-machine.ts:760` 合法相位），不可达 spawn-service.ts:243；修复保留                                                                                                                                                                                                       |
| 19  | 一般   | **采纳**          | §4.1（context_too_large nack）、§4.6（75% 常量）、§8（「可能命中」+条件清单）、§9 T-2                                               | 压缩相位预算 5min ≫ 150s 属实（`deadline.ts` DEFAULT_BUDGET）；`diag.contextUsage.percent` 现成（types.ts:248-252,403）                                                                                                                                                                                                                        |
| 20  | 建议   | **采纳**          | §4.1（schema 仅 expert/question）、§4.6（settings 收敛为 6 项；forkTtlMs/阈值转内部常量）                                           | 模型面旋钮与 settings 上下界重复属实；F4 上限由 settings 权威控制                                                                                                                                                                                                                                                                              |
| 21  | 建议   | **部分采纳**      | §4.5（三级解析与 resolve-target 语义对齐 + 一致性 fixture 测试）、§9 T-1                                                            | 不采纳「回灌 records/tombstones」为 v1 一部分：records 回灌会改变 fleet/query/outbox/backgroundBusy 等**全体消费者**的 reload 后行为，tombstone TTL 语义需凭空合成，爆炸半径远超 consult——但它确为「reload 后 `Agent({resume})` 失效」已知缺陷的正解方向，**单列为后续议题**（建议独立设计评审）。采纳其廉价部分：解析语义对齐，杜绝两边 drift |
