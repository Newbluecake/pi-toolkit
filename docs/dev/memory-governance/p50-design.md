# #50 增量后台修正设计稿（v4）

> 基线：`9e1a83d0`；2026-11-09。本文只设计 #50，不修改源码、测试或 fixture。
> Q2、Q3 已于 2026-11-09 获批；Q1 仍为**有条件待批**。Q1 未批准前不得实现或接线 generate，更不得提交模型生成正文；Q2/Q3 不构成对 generate 的独立授权。

## 1. 一页摘要

#50 在现有 blocks 治理上增加三件事：按 canonical memDir 聚合的增量调度、受限模型正文修订、逐动作审计与恢复。它不新造分类客户端、建议系统、目录锁或多文件事务。

- **P50.1**：把短时间内的多次外部写合并为一次后台任务；计数阈值或 task-done 只赋予运行资格，安静期、宿主实时空闲和冷却仍分别必须通过。
- **P50.2**：先冻结输入块的 `id/rev` 与原始字节，再由唯一 `JevClient` 的受限 generate seam 产出一个候选正文；默认只写建议。Q2 批准的窄条件自动必须另有**可核对实际 provenance 的异源 whole-coverage 完整覆盖证据**，且复核通过的单文件动作才可自动提交。
- **P50.3**：每个动作拥有独立的 `audit.json/before.md/after.md`；数据写入前持久化精确预期 after，提交是单文件 CAS，普通撤销只接受 `committed` 审计并用 raw-byte CAS 恢复原文字节。

与 #36 已完成部分的分界：

- #36 继续拥有同步关系判定、确定性归档/取代、周期建议、review/dismiss、恢复与 secure gate。
- #50 不重写 `sweep-plan` 的到期规则，不改 `supersede` 的关系图语义，不新建第二套分类器或建议列表。
- #36 原 P5b/P7 欠账仍按原编号验收；#50 不得用增量任务掩盖其覆盖缺口。

与 #74 B3 的分界：#50 负责生成、冻结证据、预算、审计和本地获批自动动作；B3 负责 web 展示、用户确认及 web 提交。两边只能调用本文唯一的 `commitAction`，不得各自实现锁内权限复核。B3 不调用模型生成正文，#50 不实现 web UI。

建议新增实现模块控制在三个：`govern/incremental.ts`（调度）、`govern/revision.ts`（提案、共享输出校验、提交协调）、`govern/revision-audit.ts`（审计/恢复）。模型方法仍加在现有 client 上，建议存储仍由 `review-lite.ts` 独占。下文标为“新增”的函数是设计契约，不声称已经存在；未标“新增”的 `replaceBlockLocked`、`replaceGovernBlockLocked`、`trashBlockLocked`、`archiveBlockLocked`、`governanceGate`、`fsyncDir` 等均为现有原语。

## 2. P50.1 触发

### 2.1 状态与不变量

调度状态按 `(canonical realpath, dev, ino, sessionEpoch)` 隔离；目录身份或 epoch 改变即废弃旧状态。所有回调均在既有异步机会中启动，不阻塞 memory 工具写路径，不调用 `sendMessage` / `triggerTurn`。

每个目录另保存：`pendingCount`、`taskDoneEligible`、`quietSatisfied`、`lastExternalWriteAt`、`cooldownUntil` 和最新 corpus 指纹。`taskDoneEligible` 只替代 `pendingCount >= changeThreshold`，不表示安静、空闲或 cooldown 已满足。

| 状态         | 含义                                              | 可接受事件                                                                   |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `idle`       | 无待处理变更                                      | `external-write`、`task-done`（无 pending，no-op）                           |
| `quiet-wait` | 已累计变更，等待安静期或运行资格                  | `external-write`、`quiet-elapsed`、`task-done`、`cooldown-elapsed`、`cancel` |
| `idle-wait`  | 安静期与运行资格已满，等待宿主连续空闲及 cooldown | `external-write`、`host-idle`、`task-done`、`cooldown-elapsed`、`cancel`     |
| `running`    | 一个目录任务正在判定/生成/提交                    | `external-write`、`settled`、`cap-reached`、`abort`                          |
| `cooldown`   | 上次任务已结算，抑制频繁后台调用                  | `external-write`、`cooldown-elapsed`、`task-done`                            |
| `stopped`    | 设置关闭、epoch 失效、shutdown 或 secure 不准入   | 无；旧状态不可复活                                                           |

### 2.2 转移

1. `idle --external-write--> quiet-wait`：`pendingCount=1`、`taskDoneEligible=false`、`quietSatisfied=false`，记录 `lastExternalWriteAt` 与最新 corpus 指纹。
2. `quiet-wait --external-write--> quiet-wait`：累加计数并**重新计时**，清 `quietSatisfied`；达到计数阈值也只表示有资格，不能跳过安静期。
3. `quiet-wait --quiet-elapsed--> idle-wait`：指纹仍有效，且 `pendingCount >= changeThreshold || taskDoneEligible` 才转移，并置 `quietSatisfied=true`。若安静期虽满但仍低于计数阈值且无 task-done，则留在 `quiet-wait`、仅记 `quietSatisfied=true`，**不得启动**；后续新写会重新清零该标志并重计时。
4. `idle-wait --host-idle--> running`：必须同时满足 `(pendingCount >= changeThreshold || taskDoneEligible)`、`quietSatisfied`、宿主连续空闲达到窗口、`now >= cooldownUntil`，以及队列、调用、费用、并发预算均允许。任何一个条件缺失都不得运行。
5. `idle-wait --external-write--> quiet-wait`：新写一律重新等待并清 `quietSatisfied`，不能在运行前夹带最新但未判定的 rev。
6. `cooldown --external-write--> quiet-wait`：保留 `cooldownUntil` 和变更证据，安静期照常计算；即使进入 `idle-wait`，转移 4 仍拒绝在 cooldown 结束前运行。
7. `quiet-wait/idle-wait/cooldown --task-done--> 原状态或 idle-wait`：仅在有 pending 时置 `taskDoneEligible=true`。在 `quiet-wait` 中，只有 `quietSatisfied=true`（或 `now-lastExternalWriteAt >= quietMs`）才允许转入 `idle-wait`，且转入时必须置 `quietSatisfied=true`；否则留在 `quiet-wait`。在 `idle-wait` 中仍须满足宿主空闲与 cooldown；在 `cooldown` 中不得离开冷却状态。`idle` 无 pending 时 task-done 为 no-op。
8. `cooldown-elapsed` 是真实释放事件：无 pending 的 `cooldown --> idle`；有 trailing pending 的 `cooldown --> quiet-wait`，按已有 `lastExternalWriteAt` 重算安静状态。`quiet-wait/idle-wait --cooldown-elapsed--> 原状态`，只更新冷却已释放的事实并重新评估既有 quiet/host-idle 条件，**不直接运行**。因此转移 6 离开 `cooldown` 后也不会丢失释放事件。
9. `running --external-write--> running`：只记一个 trailing 变更批次；不并发启动第二个任务，也不把新 rev 注入当前批次。
10. `running --settled--> cooldown`：若有 trailing 变更，只保留一个待处理批次；冷却结束后仍走安静/空闲检查。
11. 任意活跃状态 `--cap-reached--> quiet-wait`：本批不再发起模型 attempt；保留一次外部变更证据，等待下一自然触发，不自动重试空转。
12. 任意状态 `--abort/shutdown/reload--> stopped`：取消等待与运行中的 client attempt；迟到结果只能记限频诊断，不能写建议或正文。

每个 session 最多一个 unref'd 调度计时器；它只是唤醒检查，不是绕过事件准入的后台循环。Jev off 时不运行 P50.2；已有确定性 sweep 语义不变。

### 2.3 默认参数建议

| 参数              | 建议默认         | 约束                                                               |
| ----------------- | ---------------- | ------------------------------------------------------------------ |
| `changeThreshold` | 5                | 与 task-done-eligible 是 OR 资格；两者都不跳过安静、空闲、cooldown |
| `quietMs`         | 15000            | 每次外部写重置                                                     |
| `idleMs`          | 2000             | 无输入、工具调用和 memory 写的连续窗口                             |
| `cooldownMs`      | 300000           | 从上次任务 settle 起算；`cooldownUntil` 不随状态迁移丢失           |
| `taskDoneTrigger` | true             | 只替代计数阈值                                                     |
| 目录并发          | 1                | trailing 变更只合并一次                                            |
| 全局并发          | 沿用 client 上限 | P50 不另建 worker pool                                             |

这些值是起始调参建议，不改变现有 sweep 的 1000ms/50 写成本限制；P50 的模型阶段另受第 7 节预算约束。

### 2.4 连续编辑时间线

- `t=0s`：用户编辑块 A，进入 `quiet-wait`，`pendingCount=1`，计划于 `t=15s` 检查。
- `t=8s`：用户编辑块 B，计数合并为 2，检查点推迟到 `t=23s`；A/B 尚未外发。
- `t=14s`：一个任务完成，只置 `taskDoneEligible=true`；计数仍为 2，安静期仍未满。
- `t=16s`：用户又编辑 A，计数为 3，检查点推迟到 `t=31s`，`quietSatisfied=false`，旧判定输入作废。
- `t=29s`：宿主仍有工具活动，不启动后台修订。
- `t=31s`：安静期届满；此时 `count=3 < 5`，仅因 `taskDoneEligible=true` 才进入 `idle-wait`。若没有此前 task-done，则保持等待，不得运行。
- `t=33s`：已连续空闲 2s，且 `now >= cooldownUntil`，才以最新冻结快照启动一次任务。

因此连续快速编辑会不断重置等待；计数阈值和 task-done 都只是运行资格。cooldown 尚未结束时，即使 `t=33s` 已空闲，也必须等 `cooldown-elapsed` 后重新通过宿主空闲检查。

### 2.5 activity port：连续空闲的真实来源

`idleMs` 不能由一次 `isIdle()` 推导。唯一活动状态 owner 是 host-only `createHumanDispatchProof` 的闭包，新增只读 `MemoryActivityPort` 视图；`incremental.ts` 只消费视图，不注册 hook、不另存第二份 running/tools 状态。**无 activity owner 时 P50 不运行**，不能退回瞬时 idle 猜测。

v4 采用最小依赖，不为 P50 顺带打开 scopes：只有 `settings.enabled=true`、plain 主会话、`(settings.scopes.session || settings.scopes.hub)===true`，且 `wireMemoryScopes.current()` 返回存活 runtime 时，才存在可用 owner；scopes 全关、locked/secure、runtime 未创建或已 dispose 时，P50 保持 stopped，零调度 timer、零 client 调用、零 revision 写盘，并每 epoch 最多诊断一次 `p50: activity owner unavailable; incremental revision disabled`。既有确定性 sweep 不因此改变，P50 自身 off 仍满足 I9。owner 的创建/销毁完全复用 scopes group 生命周期。

```ts
interface MemoryActivitySnapshot {
  generation: number;
  lastActivityAt: number;
  running: boolean;
  toolsInFlight: number;
  liveIdle: boolean | undefined;
  hasPendingMessages: boolean | undefined;
}
interface MemoryActivityPort {
  snapshot(now: number): MemoryActivitySnapshot;
}
interface MemoryActivityRecorder {
  noteToolCall(toolCallId: string, now: number): void;
  noteToolResult(toolCallId: string, now: number): void;
  noteMemoryWrite(now: number): void;
}
```

- **现有 hook 与新增 recorder 分离**：`createHumanDispatchProof` 已有闭包 `generation`（`revoke` 时递增，覆盖 input/dispatch-error/abort/handled/session/tree 等撤销原因）；`MemoryActivitySnapshot.generation` **复用该现有字段**作为 lease 代际，不新增同名状态，不改变其原有权限撤销语义。`lastActivityAt`/`toolsInFlight` 才是本设计新增闭包字段，由既有入口与新增 recorder 更新：现有 `deps.context()` 与 `onInput/onBeforeAgentStart/onAgentStart/onSettled` 更新 `lastActivityAt`，新增 `noteToolCall/noteToolResult/noteMemoryWrite` 更新在飞集合与时间戳。现有 `jev/wire.ts::tool_call/tool_result` hook 不新增注册，但须新增调用 `noteToolCall/noteToolResult`；`memory/index.ts::onAfterWrite` 新增调用 `noteMemoryWrite`。重复 result 不重复扣减，未知 result 将实时门标为 unknown。宿主通过参数注入组合 port，memory 不 import web-hub。
- **timer 到期实时门**：`incremental.ts` 的 timer 只触发 `snapshot(now)`。必须同时满足 `running=false`、`toolsInFlight=0`、实时 `ctx.isIdle()===true`、实时 `ctx.hasPendingMessages()===false`，且 `now-lastActivityAt>=idleMs`。context 缺失/抛错、任一状态 unknown、存在未关联 tool result 或长工具在飞，均不运行。
- **idle lease 撤权**：满足条件后只发 `{generation,lastActivityAt}` lease；每个 await 后及 `commitAction` 前重新读取 snapshot。新 input、agent start、tool activity、memory write 或 pending message 改变 generation/实时状态即撤销 lease，旧结果只能建议，不能自动提交。
- **task-done 来源不扩大**：v4 只复用 `jev/wire.ts::governanceCandidate/governanceResult` 与 `govern/signals.ts` 已接线的“成功 `TaskUpdate` 将既有任务转为 completed”信号。普通 subagent 完成、bash 完成、模型声称完成或未知任务完成都不是 task-done；新增来源必须另行申报，不在本设计隐式扩张。

### 2.6 activity 验收钉子

1. 长工具 Promise 未 settle 时，即使 quiet 与 2s timer 均满，`toolsInFlight>0`，client 零调用。
2. quiet 已满但 `isIdle()===false`、`hasPendingMessages()===true` 或 context 未知，分别零运行。
3. idle lease 签发后、generate 返回前注入新 input，generation 改变，自动提交权被撤销；commit 前再次注入也必须拒绝。
4. 只有真实成功 `TaskUpdate completed` 置 eligible；重复 completed、failed result、普通 subagent 完成均不置位。
5. `scopes.session=false && scopes.hub=false` 时，即使 quiet/task-done 齐备也无 owner、无 timer/client/revision 写入，仅每 epoch 一次有界诊断；既有 sweep 输出不变。

## 3. 自写不再入队

只保留现有 write-origin 抑制链，并让它服务 sweep 与 #50。调用方的 `origin` 可缺省，**undefined 表示外部写**；不得再用 `origin === "external"` 作为唯一入队条件。

```ts
const INTERNAL_WRITE_ORIGINS: ReadonlySet<string> = new Set(["sweep", "revision", "p50-auto"]);
function isExternalWriteOrigin(origin: string | undefined): boolean {
  return origin === undefined || !INTERNAL_WRITE_ORIGINS.has(origin);
}
```

- `sweep` / `revision` / `p50-auto` 是内部 origin 白名单：只做渲染和缓存失效，不增加 P50 计数、不重置 quiet，也不再次触发 sweep/P50。
- `undefined`、显式 `"external"` 以及白名单外的其它值一律按外部写处理，保持未知来源 fail-open 于“重新复核”，而不是 fail-closed 成永不治理。
- `index.ts::onAfterWrite` 和 `sweep.runSweep` 必须使用同一谓词；P50 自动正文/元数据写传 `revision` 或 `p50-auto`，不得依赖正文 hash 猜自写。
- 不另建 `selfRev` 集合、正文 hash 去重表或第二个 self-write suppression queue。origin 是“是否入队”的唯一依据。

批次幂等键和 rev 有不同职责，不能替代 origin：

- `batchId = SHA256(sessionEpoch, directoryIdentity, frozenActionSet, policyVersion)`；同一冻结输入重放只对应一个批次。
- `actionId = SHA256(batchId, actionKind, targetId, expectedRev)`；审计文件名与提交去重均使用它。
- `expectedRev` 在提交锁内防止旧判定覆盖新编辑；CAS 失败转建议，不重新入队。
- 审计另存精确 `origin:"p50-auto" | "p50-suggestion" | "web-b3"`，用于追责；它不是第二套触发抑制机制。

## 4. P50.2 提案与提交

### 4.1 generate seam 契约

Q1 未批准、当前 client 无 revision adapter、模型注册不可用、输出校验器未接线或预算无法预留时，统一返回 `revision-unavailable`。此时不得把正文交给任何提交器；可保留不含生成正文的确定性建议。**当前默认态没有 revision adapter，且 Q1 未批准，所以 generate 永远不可用。**

在现有 `JevClient` 增加一个受限方法，不创建第二个客户端：

```ts
interface RevisionBlockInput {
  id: string;
  rev: string;
  authority: "user" | "agent";
  topic: string;
  section?: string;
  body: string; // 仅 client 内部的冻结原文；不得直接交给 adapter
}

interface RevisionGenerateRequest {
  instruction: "rewrite-single" | "merge-survivor";
  target: RevisionBlockInput;
  context?: RevisionBlockInput;
  relation?: { kind: "conflict" | "supersedes"; p: number };
  maxOutputTokens: number; // 来自 provider/adapter 的已核上限
}

type RevisionGenerateResult =
  | { kind: "ok"; body: string; outputDigest: string; provenance: ClientProvenance }
  | { kind: "unavailable"; reason: "revision-unavailable" | "invalid-output" };
```

准入、出站与输出约束：

- 仅 `private !== true` 且原始完整正文未被 `looksSecret` 命中的块可进入 `target/context`；敏感性未知、解析异常或元数据不完整时拒绝外发。
- 外发对象只含上述 allowlist 字段。禁止完整 corpus、原始文件路径、frontmatter 全文、工具输出、会话正文、环境变量、凭据和其他 project/Hub 数据。
- **Q1 硬约束①**：client 在调用 adapter 前的最后一边界，必须分别对 target/context 正文再执行 `redactForJev(body, "entry")`；冻结原文只用于本地 digest/CAS，adapter 只能拿脱敏副本。不得在 revision 模块提前脱敏后让 client 信任一个 `redacted:true` 标志。
- 一次请求最多两个块；`context` 仅用于 `merge-survivor`，不能隐式扩大为任意上下文包。
- provider/adapter 必须提供并实际传递有界 `maxOutputTokens`，供 worst-cost 预留与请求硬约束共同使用；未知即 `revision-unavailable`。本地 `BLOCK_BODY_MAX_BYTES=1024` 只是写入门，**不得冒充 provider 输出 token 上限**。
- 输出只能是**一个块的 Markdown body**，不含 frontmatter、文件操作、关系指令或额外建议。空正文、超 `BLOCK_BODY_MAX_BYTES`、含 frontmatter/schema 多字段、含 `[REDACTED]`/`[PEM]`/`[EMAIL]` 回填或无法规范化的结果均为 `invalid-output`，零提交。
- **Q1 硬约束②**：唯一输出校验器是新增的 `govern/revision.ts::validateRevisionOutput(raw: unknown)`。client 在 adapter 返回后、把结果发送给 revision 模块之前就调用它；revision 在持久化建议和提交前调用**同一个函数**复核。
- `outputDigest` 只对校验通过的规范化正文计算；client 负责统一 abort、超时、attempt 预留、并发和费用记账，revision 模块不得绕过它直接调 provider。
- `generateRevision(request)` 内部创建 attempt reservation，调用方不得自备 reservation 绕过准入；模型不返回提交权限。whole-coverage 由 §4.3 的异源证据给出，生成文本或其自我声明不能提高置信度或充当 coverage 证据。

### 4.2 冻结 rev 的时机

1. 调度器开始批次时只确定候选，不把候选列表当提交授权。
2. 在任何关系判定或 generate 调用之前，读取双方完整文件，保存 `rawBefore`、`id/rev`、authority/status 与 allowlist 输入摘要；这就是冻结点。
3. 模型调用期间不持有目录锁。新写只形成 trailing 批次，不更新当前请求的 rev。
4. generate 返回后先由 client 的共享校验器校验，再以 frozen rev 建建议或候选自动动作；需要自动时，再对**冻结旧正文 + 校验后的候选正文**取得 §4.3 的异源 coverage 证据。
5. 提交时在目录锁内重读 target/context；任一 rev、允许的 status/位置、authority、目录身份、epoch 或 gate 不符即 `stale`，零提交并转为建议。
6. `rawBefore` 只来自冻结点，不用提交前的新文件悄悄替换，否则审计、关系证据与 coverage 证据会指向不同正文。
7. 数据写入前必须在锁内生成精确 `expectedAfterRaw/expectedAfterDigest/expectedAfterRev`（delete 为 expected missing），写入本动作自己的 `after.md` 与 proposed 审计并完成 §5.2 持久化屏障。提交器与审计必须使用同一份 after 字节，禁止提交后按当前文件反推预期 after。

### 4.3 Q2 自动资格、异源判定与可信 provenance

**2026-11-09 用户重裁已批准 Q2。** 新口径推翻 2026-11-07 对 #50 的“conflict 只建议、绝不自动”旧口径：旧口径防止的是“仅凭 conflict 概率就自动”的误改；新口径不是放松成 conflict-only，而是增加独立的完整覆盖证据、高于 review 0.75 与 supersedes 0.85 的 0.90 关系阈值、单文件原子、先审计、可撤销和每批 ≤2 的复合门槛。`CONFLICT_AUTO_P` 数值仍为 0.90；提高的是证据门槛，不把同一个概率换名复用。

#50 的 conflict 自动分支必须同时满足：

1. 定向 `RelationVerdict` 为 `conflict`，`p >= CONFLICT_AUTO_P`（0.90），并带完整实际 provenance。
2. `WholeCoverageEvidence.verdict === "complete"`，且 `independentCoverageSources(...)=true`；partial、conflict-only、unknown、缺失、过期或来源不可证明分离一律只建议。
3. 六项权限矩阵允许，Q1/Q2/Q3、activity lease 及运行时 auto 开关均允许；agent 永不取代/改写 user 规则，每批自动动作 ≤2。
4. 动作是单文件原子提交，写前审计、原文与预期 after 已按 §5.2 持久化，且可按 §5 恢复原文。

唯一 client 必须在实际成功边界生成 provenance，不能由 revision/UI 自报：

```ts
interface ClientProvenance {
  provider: string; // 实际成功 provider
  model: string; // 实际成功 model，不是首选档位
  adapterId: string;
  chainVersion: string;
  routeIdentity: string; // registry 别名解析后的 canonical route digest；失败为 unknown，不得放行
  routeAliases: readonly string[]; // 解析后的 canonical alias 集，用于交叉检查
  requestChainId: string; // 配置/实际请求的链 id，仅作路由证据，不冒充实际返回身份
  requestDigest: string; // 实际出站 DTO digest
}

interface RelationEvidence {
  kind: "conflict" | "supersedes";
  p: number;
  inputDigest: string; // 冻结双方 id/rev/raw digest
  provenance: ClientProvenance;
}

interface WholeCoverageEvidence {
  v: 1;
  verdict: "complete";
  targetRev: string;
  beforeDigest: string;
  candidateDigest: string;
  promptVersion: string;
  provenance: ClientProvenance;
  evidenceDigest: string;
}
```

- 现有 `JevOutcome.ok.model` 是**请求链 id**，且当前 `callOnce` 丢弃了 `classify` 返回的 `result.provider/result.model`，不能当作实际成功身份。新 provenance 必须从实际成功结果保留 `result.provider/result.model`，另存请求链 id，并与 registry canonical route 核对；generate/coverage 同样在唯一 client 成功边界生成。请求 id 与返回身份不同只有在 canonical alias 可证明一致时才接受；无法解析、返回身份与 canonical route 不一致或字段缺失均降级建议。旧数据或普通建议可以没有 provenance，自动路径缺任一项即拒绝。
- relation、generate、coverage 分别绑定自己的冻结 input/request digest；三者 provenance 都持久化到 proposal 与 audit。failover 后记录**实际成功档**，不得只存配置首选链或 coverage 的 `judgeChain`。
- coverage judge 对冻结旧正文和候选正文逐项核对：每项有效约束/事实/操作必须被完整保留，或被明确废弃且没有仍有效的矛盾遗留。它不得读取 relation kind/p、复用 `cN/wholeRelation` 答案或使用 generate 自评。
- 异源比较函数为 `independentCoverageSources(relation, generation, coverage)`：三者 provenance 必须完整且 request/input digest 匹配；coverage 的 `routeIdentity` 不得等于 relation 或 generation，canonical `routeAliases` 与二者不得相交，adapter/chain 版本必须可解析。coverage 与 relation/generate 任一实际成功 provider/model 相同也算同源。别名解析失败、registry 身份缺失、链交叉无法判定或 digest 不符均返回 false。
- 该比较证明的是可审计的路由分离，不宣称统计独立。实现前必须用 fake registry 做别名、同链交叉 failover、不同首选档但落到同一实际 model 的测试；证明不了就保持建议模式。
- coverage judge 仍经唯一 `JevClient` 的 attempt/费用/abort 通道，不新建 client。输入经脱敏后发生截断/遮蔽而无法证明“完整正文已判定”时只建议。

`tagging` 的 conflict/supersedes 互斥，因此不得写成“conflict≥0.90 且 supersedes≥0.85”。#36 既有 supersedes 0.85 自动路径保持不变；未达 Q2 复合条件的 conflict 只建议，绝不能改标为 supersedes。

### 4.4 单文件提交与共享 `commitAction`

**正文修订选择复用 `blocks/store` 的整块 CAS 更新，不选择 `supersede` 作为正文提交器。** `replaceGovernBlockLocked` 保留 `old.body`，不能表达正文替换；`replaceBlockLocked` 只做 rev/CAS，不保证 authority/status/权限，所以必须由受控包装调用。

本地自动路径与 #74 B3 共用新增入口：

```ts
interface CommitActionRequest {
  origin: "p50-auto" | "web-b3";
  actionId: string;
  expectedRev: string;
  proposalDigest: string;
  signal?: AbortSignal;
}
type CommitActionResult =
  | { kind: "committed"; actionId: string; afterRev?: string }
  | { kind: "skipped"; actionId: string; reason: "stale" | "permission" | "gate" | "digest" | "unavailable" }
  | {
      kind: "effect-unknown";
      actionId: string;
      dataApplied: boolean | "unknown";
      expectedAfterRev?: string;
      reason: "post-apply-failure" | "observation-mismatch" | "finalization-failure";
    };
async function commitAction(
  memDir: string,
  request: CommitActionRequest,
  deps: RevisionCommitDeps,
): Promise<CommitActionResult>;
```

唯一锁内协议：

1. 从本地 proposal/audit owner 读取可信动作，核对 actionId/rev/proposalDigest、完整 action payload、generate/relation/coverage provenance；web 输入不携带可替换正文或 expires 日期。
2. 进入一个 `withMemoryDirLock`，复核 `governanceGate`、目录身份、sessionEpoch/owner、activity lease、abort、运行时开关、审计状态及 suggestion 未 dismiss/resolve。锁内不得等待模型或 UI。
3. 按下表重读 target/context，复核 rev、rawBefore digest、authority、scope、storageScope 和证据；任何不符均 stale/permission，零提交。

| action                                             | 本版允许的 live status 与位置                                 | applier                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| rewrite-single / merge-survivor / expires / delete | 仅 `active`，仅 `blocks/<id>.md`                              | 正文用受控 `replaceRevisionBodyLocked`；expires 用 `replaceGovernBlockLocked`；delete 用 `trashBlockLocked` |
| retire                                             | old/new 均 `active`，均位于 blocks 根                         | 从现有 `supersede` 提取的 `supersedeOneLocked`                                                              |
| 已 `archived` 的 agent                             | **不允许 P50 提交**；只能经 `readArchiveIndex` 定位并展示建议 | 本版无 archived delete/restore applier                                                                      |

4. 在数据写入前，以同一 `now/meta/body/action payload` 构造精确 expected after；delete 的 expected after 为 missing。调用 §5.2 `persistExpectedAfterBarrier` 成功后才允许 applier 执行一次单文件 CAS。
5. 只有 §4.4.1 的受控 applier 能提供 `not-applied` 或同步 rename 成功的 `applied` 观察。写前证明 not-applied 才能记 skipped；rename 后的 gate/fsync/audit 异常、观察不一致或无法判定均返回 `effect-unknown`，记 commit-unknown，保留 before/expected-after 和当前实际字节，拒绝盲重试与补偿覆盖。只有可信 applied 观察、expected after 核对和数据目录 fsync 全部完成后才可 finalized/committed。

`replaceRevisionBodyLocked` 在 `replaceBlockLocked` 前额外检查：current rev/raw digest 等于冻结值、authority/scope 不变、`storageScope!=="hub"`、context 未变、共享输出校验与 candidate digest 通过。首版拒绝 residue/origin 块，避免 store 的清理语义被静默触发。`next.meta` 取锁内 current.meta，正文动作不得改 authority/scope/status/private/expires；expectedAfterRaw 必须与该 applier 在同一 `now` 下产生的字节完全一致。`replaceBlockLocked` 在 rename 后的 gate/fsync 异常同样属于 effect-unknown，不能按 stale/未写处理。

#### 4.4.1 统一受控 applier adapter

所有正文/expires/delete/retire 动作经过同一 adapter，不能从原语返回值猜提交结果：

```ts
type ApplyObservation =
  | { kind: "not-applied" } // 仅能用于已证明尚未到数据 rename/create 的失败
  | { kind: "applied"; expectedAfterDigest: string; expectedAfterRev?: string; proof: "rename-observed" }
  | { kind: "unknown"; reason: string };
interface ControlledApplier {
  applyLocked(expected: ExpectedAfter): {
    observation: ApplyObservation;
    dataDirectories: readonly string[]; // 成功观察后、committed 前必须逐一 fsync
  };
}
```

- adapter 以同一 now/meta/body/action payload 预构造 expected after，并把同一序列化参数交给原语；`replaceGovernBlockLocked` 返回 void 且保留 old.body，expires/retire 不能伪称它返回了提交字节。
- 对现有原语做最小 refactor，在数据 `replaceAtomic/renameNoClobber` 成功点增加同步 observer。observer 必须核对实际被 rename 的临时文件/来源、目标名与 prepared 对象，file 动作在 rename 前即时计算的来源 digest 必须等于 expectedAfterDigest；随后将**预先冻结的 expected raw/digest/rev**记为“已提交观察”，而不是事后读取当前文件充当证明。delete 则绑定 expected missing、来源 rev 与 trash 目标。无法提供该观察的原语不得进入 P50 提交；事后读取只用于 stale/崩溃分类。
- **no-clobber 的 data-applied 落到 link/unlink 内部**：delete 经 `renameNoClobber`、delete 恢复经 `createExclusive`，二者都是 `linkSync→unlinkSync`，且硬链接不可用时退化为非原子 check-then-rename。观察必须细分到 syscall 边界：
  - 恢复创建的 data-applied 点是 `linkSync(tmp, target)` 成功（目标路径已出现），而非整个 helper 返回；link 成功后 unlink 抛错仍返回 `applied` 并附双路径证据，不得当作 not-applied。
  - 删除的 `linkSync(from, trash)` 成功但 `unlinkSync(from)` 失败 ⇒ 源与 trash 目标并存，返回 `unknown` 并持久化双路径证据，绝不报告 not-applied；重复扫描必须识别并存状态，不自动清理任一路径。
  - `EPERM/ENOTSUP/EXDEV`（硬链接不可用，退化 check-then-rename 非原子）⇒ 拒绝该 no-clobber 动作，不进入 P50 提交/恢复；不得用非原子降级路径执行恢复或删除。
- `applied` 观察后、写 committed 前，adapter 必须逐一 `fsyncDir(dataDirectories)`：正文/expires/retire 为 blocks，delete 同时包含 blocks 与 `.trash`。随后才写 committed audit 并 fsync action 目录。任何写后错误都按 effect-unknown，不得把异常统一映射成未写。
- expires 与 retire 各用真实文件验证“同一 now/meta/body → expected after → rename 观察 → 数据目录 fsync → committed”的顺序，并在 rename 后注入 gate/fsync/audit 失败，断言保留实际字节、返回 effect-unknown、重试零再次 applier。

一个动作只改一个 target 文件。“更新 survivor 正文”和“退役另一块”绝不放在同一原子动作里；首步只出正文建议，退役是另一个独立受控步骤。每批最多 2 个动作不表示存在跨文件事务。

### 4.5 建议存储唯一 owner 与判别联合

`review-lite.ts` 是所有用户可见建议的唯一 owner，继续复用现有 `.jev/index.json` 的 review/dismiss 生命周期。P50 不新建建议 JSON、通知队列或 dismiss 表。现有 `ReviewSuggestion` 追加可选 `revision` 子结构；sanitizer 遇到非法 revision 必须丢弃整条建议，旧建议语义不变。

```ts
interface RevisionProposalBase {
  v: 1;
  actionId: string;
  batchId: string;
  targetId: string;
  expectedRev: string;
  contextId?: string;
  contextExpectedRev?: string;
  reason: "conflict" | "supersedes" | "expired" | "duplicate" | "budget";
  relation?: RelationEvidence;
  coverage?: WholeCoverageEvidence;
  proposalDigest: string;
  autoEligible: boolean;
}
type ExpiryPayload =
  | { op: "set"; nextExpires: string; dateRuleVersion: string } // nextExpires 为 canonical YYYY-MM-DD
  | { op: "clear"; dateRuleVersion: string };
type RevisionProposal =
  | (RevisionProposalBase & {
      action: "rewrite-single" | "merge-survivor";
      generatedBody?: string;
      outputDigest?: string;
      generationProvenance?: ClientProvenance;
    })
  | (RevisionProposalBase & { action: "retire" | "delete" })
  | (RevisionProposalBase & { action: "expires"; expiry: ExpiryPayload });
```

- `ReviewSuggestion.id="revision:"+actionId`，`a` 指向 target，merge/retire 时 `b` 指向 context；基础 kind 继续沿用 conflict/supersedes/duplicate/expired-user/until-check/oversize。
- `proposalDigest` 覆盖完整判别联合：action、双方 id/rev、generatedBody/outputDigest、全部 provenance、relation、coverage、policyVersion，以及 expires 的 `op/nextExpires/dateRuleVersion`。同 actionId/rev 但日期被改，digest 必须改变。generatedBody 一旦存在，outputDigest 与 generationProvenance 必须同时存在并绑定其 input/request digest。
- B3 与本地 review 必须展示精确 expires 操作（set 的日期或 clear）及 dateRuleVersion；`commitAction` 只应用冻结 payload，不得在确认后调用 `governanceToday`、临时加 30 天或重新推导日期。当前活动日期规则版本与冻结值不同即 stale。
- `suggestionKey` 对 revision 建议为 `JSON.stringify(["revision", action, ...[targetId, ...(contextId ? [contextId] : [])].sort()])`；单块 dismiss 不依赖 batchId/actionId/rev/正文 hash。`DismissedPair` 同写 suggestionKey/hashKey/anchorKey/kind。
- upsert、自动生成和迟到提交前都检查 dismissed/resolved；target rev 变化后旧建议 stale，新 rev 也不能绕过 dismiss 自动提交。

## 5. P50.3 审计与可恢复

### 5.1 每动作独立目录与字段

每个 action 使用独立目录，禁止同批动作共享快照文件：

```text
blocks/.jev/revisions/<batchId>/<actionId>/
  audit.json
  before.md          // 冻结原文件的精确字节
  after.md           // file 动作的精确【预期】after；delete 无此文件
```

`audit.json` 至少包含：

```ts
interface RevisionAudit {
  v: 1;
  origin: "p50-auto" | "p50-suggestion" | "web-b3";
  batchId: string;
  actionId: string;
  directoryIdentityDigest: string;
  action: RevisionProposal["action"];
  targetId: string;
  expectedRev: string;
  contextId?: string;
  contextExpectedRev?: string;
  inputDigest: string;
  proposalDigest: string;
  expiry?: ExpiryPayload;
  relation?: RelationEvidence;
  generationProvenance?: ClientProvenance;
  outputDigest?: string;
  coverage?: WholeCoverageEvidence;
  beforeDigest: string;
  expectedAfterDigest?: string;
  expectedAfterRev?: string;
  expectedAfter?: { kind: "file"; digest: string; rev: string; file: "after.md" } | { kind: "missing" };
  beforeFile: "before.md";
  policyVersion: string;
  state: "prepared" | "proposed" | "committed" | "skipped" | "failed" | "commit-unknown" | "restored";
  reason?: string;
  createdAt: string;
  settledAt?: string;
}
```

`after.md` 是提交前冻结的预期结果，不是崩溃后从当前文件补造的实际证据。摘要均对精确字节做 SHA-256；rev 由同一预期 raw/version 计算。审计不进入模型上下文。非法、超限、符号链接或 digest 不符的记录按损坏处理，不能视为 committed/restored。

**重放不覆盖**：action 目录/audit 已存在时，必须核对 batch/action/target、proposalDigest、beforeDigest、before.md 字节，以及已存在的 after.md 与 expectedAfterDigest。全部一致才可按原状态继续；任一不一致即 corrupted，禁止覆盖快照、禁止模型提交、禁止撤销。两个动作即使同 batch，也只能读各自 actionId 目录。

### 5.2 file + directory fsync 屏障与写入顺序

`writeTempRegular` 只 fsync 文件，`replaceAtomic` 只 rename，因此新增 `revision-audit.ts` 的两个屏障：

1. `persistPreparedBarrier`：为 batch/action 新建私有目录时，对每一级新建父目录执行 `fsyncDir`；写 before.md 与 prepared audit 的临时文件并 file fsync，rename 后再 fsync action 目录、batch 目录、revisions 目录及所有新建父目录。任一步失败，禁止 generate 进入提交阶段。
2. `persistExpectedAfterBarrier`：写 file 动作的 expected after.md 和 proposed audit；delete 只写 expected missing 的 proposed audit。file fsync + rename 后，再 fsync 上述所有相关目录。屏障失败，**零正文 CAS**。
3. **线性化边界为 prepare → data-applied → finalized**：prepare 屏障完成后，受控 applier 的数据 rename/create 成功点是 data-applied；随后先 fsync 数据目录（delete 为 blocks 与 `.trash`），再写 committed audit、file fsync + rename + action 目录 fsync，才是 finalized。data-applied 不保证能同步持久化，崩溃仍按 proposed 扫描。
4. 只有数据替换/创建前的失败才承诺零修改。data-applied 后的 gate/fsync/committed-audit 失败返回 effect-unknown/“已生效但未完成确认”，保留证据和实际字节，拒绝盲重试，不做补偿覆盖；committed 屏障失败按 §5.3 扫描，不把当前字节直接当提交证据。

该契约提供的是进程崩溃下的顺序与已请求 fsync 的持久化屏障，不宣称抵御所有机器掉电、文件系统 bug、存储虚报 flush 或跨文件事务。子进程 kill 只证明 half-state 分类，不证明掉电持久性。故障注入分两组：prepared/expected-after 屏障的 file/directory fsync 或审计 rename 失败必须证明数据 CAS 未调用；数据 rename/create 结果无法证明 not-applied、或写后 fsync/audit 失败，必须保留实际字节并进入不确定状态，禁止再要求“零 CAS”。

### 5.3 崩溃扫描全函数与写后重试

扫描只处理未决 `prepared/proposed`；`committed/restored/skipped/failed` 是终态，不得被后续扫描降级。`commit-unknown` 只允许幂等重读诊断，不自动改 committed、不自动回滚、不进入普通恢复列表。重复扫描不得改变已确定分类或覆盖证据。

对未决记录，只能比较 before、**预期 after** 和当前状态，禁止以 `currentDigest != beforeDigest` 推断 P50 已提交：

| 当前目标状态                                                                        | 扫描处理                                                                                              | 普通 `/mem restore --revision`    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| file 动作当前字节 `== before.md`；delete 目标仍等于 before                          | 记 `skipped/no-commit-observed`，不得写 after 证据                                                    | 无需撤销；不得改变文件            |
| 完整 proposed 的 file 动作当前字节 `== after.md` 且 digest/rev 一致                 | 记 `commit-unknown/expected-after-without-commit-marker`；只使用已有 expected after，不重算当前 after | **禁止**                          |
| 完整 proposed delete 且 `expectedAfter.kind==="missing"`，目标缺失                  | 记 `commit-unknown/expected-missing-without-commit-marker`                                            | **禁止**；不能据此认定是 P50 删除 |
| 其它所有情况：其它字节、非 delete 缺失、**prepared/无完整 proposed 的 delete 缺失** | 记 `commit-unknown/unexpected-current`，保留当前状态与已有证据，禁止补造 actualAfterRev               | **禁止**；可能是用户后续编辑/删除 |

特别是 `prepared delete → 用户自行删除 → crash、P50 零 CAS` 必须落入最后的 fail-closed 分支，不得视为 P50 删除或允许恢复。`prepared → 用户编辑 → crash` 同样保留用户新字节。

写后 effect-unknown 的重试只重读 audit/当前证据并再次返回 effect-unknown，零 applier、零补偿写。若 audit 已是 committed，可按 committed 幂等返回但不得再次写数据；若 audit 是 commit-unknown，不得因当前字节碰巧等于 before/after 就自动改态。

### 5.4 普通恢复与 raw-byte CAS

- 普通 `/mem restore --revision <actionId>` 只接受 `state==="committed"`。file 动作要求当前精确字节 digest/rev 等于 expected after；delete 要求 expected missing 且目标确实缺失。`commit-unknown/prepared/proposed/skipped/failed/restored` 一律拒绝。
- file 恢复调用新增 `restoreRevisionRawLocked`：锁内用 `safe-fs` 的 no-follow 原始字节读取（新增 `readRegularBytes`，与 `readRegular` 同一 `openRegular` 守卫）复核当前 digest；将 before.md 的 **Buffer** 写入临时文件并 file fsync；再次读取复核 current digest 未变；`replaceAtomic` 后 `fsyncDir(blocks)`。不得调用 `replaceBlockLocked`、`serializeBlock` 或递增 version，恢复后的 rev 就是原 beforeRev。
- delete 恢复在同一锁内以 no-clobber 恢复 before.md 原始字节：`createExclusive` 的 `linkSync(tmp, target)` 成功即 data-applied；目标并发出现（EEXIST）只记 not-applied 且不覆盖；link 成功而 unlink 失败返回 `unknown` 并保留双路径证据；`EPERM/ENOTSUP/EXDEV` 拒绝恢复。随后 directory fsync，最后写 restored audit。
- 恢复同样遵循 prepare → data-applied → finalized：只有 replace/create 前失败才保证零修改。replace/create 后 fsync 或 restored-audit 失败返回 `RestoreRevisionResult{kind:"effect-unknown",dataApplied:true}`，保留已恢复/可能已恢复的实际字节，不补偿覆盖 after、不盲重试。若无法取得数据应用观察则 dataApplied=unknown；原 committed/restored 审计不被扫描降级。
- `/mem restore --block` 继续负责 archive/superseded 关系恢复；本版 archived agent 只建议，不提供 P50 archived 删除或精确恢复协议。
- `.backup` 与 `/mem --rollback` 属于布局迁移级回滚，不用于单块修订撤销。

### 5.5 审计与恢复验收钉子

1. 同批两个不同块各产生独立 before/after；分别撤销第一个、第二个均只影响目标，再按逆序撤销也逐字节正确。
2. 同 action 重放遇到一致快照可继续；篡改 before/after/proposalDigest 后零覆盖、零提交。
3. 故障序列 `prepared → 用户编辑 → crash` 中 spy 证明 P50 数据 CAS 零调用；扫描为 unexpected-current，用户字节不变，普通恢复拒绝。
4. 分别构造 before-equal、expected-after-equal、其它字节、delete-missing 四类，状态与恢复资格严格等于 §5.3 表。
5. raw restore 使用非 ASCII、CRLF、frontmatter 与旧 version，恢复后 Buffer 与 before.md 完全相等；spy 断言未调用 replaceBlockLocked/serializeBlock。
6. 写前故障组：在 prepared/expected-after 的 file fsync、directory fsync、审计 rename 点注入失败，数据 CAS spy 均为零调用。
7. 线性化及写后故障组：数据 rename/create 无法证明 not-applied 时即 effect-unknown；在数据 rename 后的 gate、数据目录 fsync、committed/restored audit 点注入失败，实际字节保留，重试零 applier、零补偿覆盖；expires/retire/delete 各自覆盖数据目录 fsync 顺序。
8. `prepared delete → 用户删除 → crash` 落入 unexpected-current；连续扫描两次结果与字节不变，committed/restored 终态不被降级。子进程 kill 只用于分类，不作为掉电证明。
9. no-clobber link/unlink 三组：① 恢复创建 link 成功、unlink 失败 ⇒ `applied`（目标已现）+ 双路径证据；② 删除 link 成功、源 unlink 失败 ⇒ `unknown` + 双路径证据，重试零 applier；③ 硬链接不支持（EPERM/ENOTSUP/EXDEV）⇒ 拒绝该动作；目标并发出现 ⇒ not-applied 不覆盖。

## 6. 六项权限到代码检查点

| 权限                    | 具体函数/守卫（“新增”为本文拟增）                                                                                                                             | 必须行为                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户令窄条件自动取代    | `revision.ts::commitAction` 复核 relation/generation/coverage provenance 与 `independentCoverageSources`；`supersedeOneLocked` 执行 retire                    | Q2 复合条件缺一不可；仅符合矩阵的 user↔user；≤2；先快照与 expected-after 屏障；agent→user 永禁；user 删除仍禁止                                   |
| 自动删除 agent/已过期块 | `sweep-plan.ts::planSweep` 提供到期证据；`sweep.ts::archiveBlockLocked` 归档 active expired agent；`store.ts::trashBlockLocked` 只删 blocks 根的 active agent | **v3 缩减 archived 范围**：已 archived agent 只经 `readArchiveIndex` 出建议，不自动删除、不走 P50 恢复；不得宣称该部分权限已覆盖。user 永远只建议 |
| 同/跨主题合并           | `revision.ts::planRevisionActions` 限定同一 canonical memDir；`commitAction` 复核 target/context 目录与 Q2 证据                                               | 同/跨 topic 不新增阈值档；跨 topic 仅限同目录；`readGovernBlock` 只能读当前 blocks 根，绝不读另一 memDir 正文生成                                 |
| 低置信冲突              | `review-lite.ts` revision upsert；`commitAction` 重算 p 与异源比较                                                                                            | `p<0.90`、partial/conflict-only、coverage unknown、provenance 缺失/同源均只建议；不占自动动作 cap                                                 |
| agent 块 expires        | `commitAction` 检查 active agent/rev 和冻结 `ExpiryPayload` 后调用 `replaceGovernBlockLocked`                                                                 | 仅 agent 自动写精确 nextExpires/clear；user 只提案；确认后日期规则版本变化、payload/digest 不符均拒绝                                             |
| 跨 project/Hub          | `incremental.ts` 目录键；`planRevisionActions` 排除 foreign root 与 `storageScope:"hub"`；`commitAction` 绑定 directoryIdentityDigest                         | 跨 canonical memDir 或 Hub 一律不自动落盘；跨目录建议无 generatedBody，不跨目录读取正文；任何落盘需用户确认且受目标目录权限约束                   |

这些检查必须位于 `commitAction` 实际提交调用链，而非只在 UI 隐藏按钮。authority、目录身份、rev、status/位置与 gate 要在写锁内再次验证。

## 7. 预算与上限

### 7.1 每批 cap

| 项目                        | 建议 cap                                                                                      | 达 cap 行为                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 自动动作                    | 2，沿用 `AUTO_PER_WRITE_MAX`                                                                  | 其余只建议                                                                                                       |
| generate 调用               | 2 个高层 generate 请求                                                                        | 不再创建 reservation；failover 的 provider attempt 另按 maxCalls 记账                                            |
| 队列                        | 每 session 8 个目录、16 个待处理动作                                                          | 合并同目录证据，拒绝新增低优先级工作                                                                             |
| 逻辑请求并发                | 现有 active 限额 sync=3 / background=4；**新增**每通道有界 queue，各 4                        | 现有 queue 是无界数组，本设计新增 `SYNC_QUEUE_LIMIT=4`、`BACKGROUND_QUEUE_LIMIT=4`；超限拒绝，不新增 worker pool |
| provider outstanding/zombie | 同一 client 另记未实际 settle 的 provider attempt；`zombie>0` 时 sync/background 均拒绝新请求 | abort race 返回不等于 provider 已 settle；直到原 Promise settle 才解除                                           |
| 费用                        | `min(jobCostCap, clientRemainingCost)` 作为预留准入门                                         | 无足够预留不调用；实际超额如实入账并停止后续准入                                                                 |

`jobCostCap` 默认 0。模型/价目、已核 `maxOutputTokens` 或输入上界缺失，无法计算 worst-cost 或 `clientRemainingCost` 时，可用报价额度视为 0，返回 `revision-unavailable`。费用 cap 是**条件性估算准入上限**，不是多进程、provider 超报或迟到 usage 下的绝对金额硬上限。

### 7.2 attempt、zombie 与真实费用对账

在 `createJevClient` 闭包内新增同一套函数，generate 与既有 classify 共用：

```ts
interface ClientAttemptReservation {
  id: string;
  jobId?: string;
  maxProviderCalls: number;
  reservedCostUsd: number;
}
reserveClientAttempt(input: {
  mode: "sync" | "background";
  jobId?: string;
  maxProviderCalls: number;
  worstCostUsd: number;
  queuedLimit: number;
}): ClientAttemptReservation | undefined;
settleClientAttempt(
  reservation: ClientAttemptReservation,
  actual: { providerCalls: number; costUsd?: number; costKnown: boolean },
): void;
releaseClientAttempt(reservation: ClientAttemptReservation): void;
```

1. `generateRevision` 在进入对应 Semaphore 前同步 reserve；检查 queuedCount、maxCalls、maxCostUsd、job 余额及 `zombie===0`。sync 使用 sync=3 通道，background 使用 background=4 通道；不得跨通道借用额度。当前无界 queue 必须新增每通道 4 的有界准入，超过立即拒绝，不得先入队再溢出。
2. reserve 不是永久准入：**获取逻辑槽后**以及**每次 provider dispatch 前**都必须同步执行 `assertDispatchAdmission`，复核 disposed/abort/zombie、调用余额、maxCostUsd 与 budgetExhausted；检查与 outstanding++ 之间不得有 await。排队期间出现 zombie/费用超额、或同请求 failover/拆半期间出现 zombie，都不得新增 dispatch。
3. 未 dispatch 的排队工作在上述复核失败时取消并 release 未使用预留、释放逻辑槽；已 dispatch 部分按 outstanding/实际 usage 结算，不能按未发生释放。maxCalls 按实际 provider dispatch 计，reservation 覆盖整个 failover 链及 classify context 拆半。
4. **outstanding 定义**：provider Promise dispatch 时 `outstanding++`，只有原 Promise 实际 resolve/reject 才 `outstanding--`。timeout/abort race 让高层请求返回时可释放逻辑 Semaphore 槽，但只要 outstanding 未归零就记 zombie；`zombie>0` 拒绝 sync/background 所有新准入，不创建第二个 worker pool。shutdown/reload dispose 后永不重新准入。
5. `callOnce` 只返回 provider 结果/usage，不另建一套账。高层结束时 `settleClientAttempt` 原子移除 reserved、增加 settled；重复 settle/release 幂等。普通 `ask/askInner` 与 generate 共用 settled+reserved 准入门，不能绕过排队预留。
6. usage/价目有效时，`settledCostUsd += actualCostUsd`，**不得 min 到 reserved**。`actualCostUsd>reservedCostUsd` 时如实记录 `overReservedUsd=actual-reserved`、costSource=usage，并置 budgetExhausted/停止后续新准入；已 outstanding 的请求按 zombie 门处理，不伪称可撤回费用。
7. usage/价目未知、abort 后结果未知时先按 reserved 估算入账并标 costSource=reserve。迟到 provider settle 若带回可用 usage，必须以一次幂等 adjustment 用 actual 替换该 reserve 估算（记录差额，可能为正或负），实际超额同样停止后续准入；没有可用 usage 才保留 reserve。`usage()` 同时暴露 settled、reserved、outstanding/zombie 与 costSource，audit 使用同一口径。不得再出现实际超预留被账面裁掉，或 flight 报 0 而账本扣预留的背离。
8. 本地正文 1KB 校验不参与 token 估算；worst-cost 必须由实际出站 input 上界和 provider/adapter 已核 `maxOutputTokens` 计算。

### 7.3 停止语义

- 生成前达 cap 或 zombie>0：不生成、不写 generatedBody、不提交。
- 两个动作之间达 cap/abort：后续动作不启动新写；已完成动作保留完整审计。
- 单动作进入 CAS 后不再发起模型调用；只有受控 adapter 证明 not-applied 才记 skipped/stale，写后失败或结果不明一律 effect-unknown，不降级为无 CAS 写。
- 费用超预留或 usage 迟到：真实入账并停止后续准入，不用“先提交再裁账”伪装硬上限，不以多文件 rollback 模拟预算事务。

### 7.4 预算验收钉子

1. fake provider 忽略 abort 且 Promise 不 settle：高层 timeout 返回后逻辑槽可释放，但 zombie=1，sync/background 新调用均被拒；原 Promise settle 后才解除。
2. 分别验证 sync=3、background=4 与各自 queue 上限，不能用另一通道空位放行。
3. fake usage 实际费用大于预留：audit/usage 记录完整 actual 与 overReserved，后续调用零 dispatch；未知 usage 先按 reserve 估算，迟到真实 usage 再以幂等 adjustment 对账且不重复计 calls。
4. maxOutputTokens 缺失时零外发；仅正文小于 1KB 不能绕过该门。
5. 请求先排队、随后另一请求留下 zombie：出队复核拒绝且零新增 dispatch；同请求首档 timeout 留 zombie 后，failover/拆半同样零新增 dispatch。
6. 请求先排队、随后另一请求实际费用超额：出队复核取消未用预留并释放槽位，零新增 dispatch。

### 7.5 共享 client 改造的实施开关边界

有界队列、zombie 阻止 failover、calls 改按 dispatch 计数、费用改预留结算，都可能改变既有 classify 的可观察行为，不能只凭“未新增 hook”宣称 P50 off 满足 I9。门控如下：

- **P50 off（`memory.governance.incremental.enabled=false` 或未接 owner）时，classify 保留原可观察行为**：无界队列、超时后按原语义 failover、原 calls 计数口径、原费用结算口径、原工具回显均不变；P50 的新预算通道不被 classify 触及。
- **P50 on 时**，classify 与 generate 才共同进入新预算通道（有界队列、dispatch 前复核、zombie 门、dispatch 计数、预留结算）。
- 若要把共享 client 行为改造独立于 P50 全局启用，必须另行申报契约变更，不得隐含在“P50 off”里。
- 除既有 golden 外，新增 **“Jev 开、P50 关”对照验收**：饱和队列、超时 failover、调用/费用上限、工具回显四项与 P50 未引入前的既有行为一致；P50 on 后再验证新通道生效。

## 8. 与 #74 B3 的接口边界

#50 向 B3 提供只读 proposal/audit 视图及恢复所需元数据；B3 返回用户确认后的提交意图。最小边界为：

- #50 输出：完整判别联合（含 `expiry`）、`generatedBody/outputDigest`、relation/generation/coverage 的 `ClientProvenance`、`proposalDigest/autoEligible/auditDigest`。B3 必须展示精确 expires 操作和日期规则版本。
- B3 输入确认：`actionId + expectedRev + 用户确认时的 proposalDigest`；不接受 web 正文、nextExpires、clear 操作、日期规则版本或 wholeCoverage 覆盖已审计 proposal。
- **唯一提交路径**：本地自动与 B3 都调用 §4.4 `commitAction`。B3 不得直接调用 store/supersede，不得另写锁内重验；commitAction 统一验证 payload/digest、rev、权限、provenance 异源比较、activity lease、gate 与 audit。
- B3 确认过期、日期规则版本变化或 digest 不匹配只刷新展示，不自动提交；effect-unknown 必须原样展示并禁止盲重试/补偿覆盖，重复确认只在 committed 时幂等返回。审计 origin 为 web-b3，web 不另建账本。
- #50 不依赖 web 在线才能生成本地建议；B3 不触发 generate，不实现第二套自动资格判定。

## 9. 测试策略

| 验收钉子                           | 测试类型与关键断言                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N 次变更合并一次                   | 调度单测，fake clock + 计数 client；同目录只启动一次                                                                                                                        |
| 计数阈值是硬闸门                   | `taskDoneEligible=false` 时 count=3 且 quiet/host-idle 均满仍零运行；count=5 才可进入后续检查。count=3 有/无 task-done 成对验证：无 task-done 零运行，有 task-done 才有资格 |
| task-done 只替代计数               | count=3 + task-done 可获资格，但 quiet、cooldown、host-idle 任一未满均零运行；quiet 先满后 task-done 可进入 idle-wait                                                       |
| 安静窗口新写重置等待               | fake clock 状态机测试；新写清 quietSatisfied，旧 rev 不夹带                                                                                                                 |
| cooldown 有释放路径                | 覆盖 cooldown 内 elapsed、转移 6 后 quiet-wait/idle-wait 接收 elapsed；三种路径最终都能运行且都不会提前运行                                                                 |
| activity 实时门与撤权              | 按 §2.6 五项验证长工具、宿主忙/未知、idle 后新 input、窄 task-done、scopes-off 无 owner                                                                                     |
| 自写不再入队                       | 真实 write-origin 接线：undefined/external 入队，sweep/revision/p50-auto 抑制，未知非白名单按外部处理                                                                       |
| 模型阶段超时/abort 零提交          | 可控 adapter + 真实 store/audit 文件；queued/running 两阶段覆盖，另按 §7.4 验 zombie；数据写后失败按 effect-unknown                                                         |
| 旧 rev/authority/status/位置零提交 | 真实文件集成：冻结后改 target/context、authority、status；archived 目标也只建议                                                                                             |
| Q2 实际 provenance                 | fake registry 覆盖别名、链交叉 failover、不同首选但同一实际 model；特别构造请求链 id 与 classify 返回 provider/model 不同，canonical 可证才接受，不一致即建议               |
| 出站脱敏与共享输出校验             | fake adapter 只收到再次 redactForJev 的 DTO；非法输出在 client 返回前即 invalid-output                                                                                      |
| 队列/调用/费用/outstanding         | 按 §7.4 验证两通道、zombie、实际超预留、未知报价与 maxOutputTokens                                                                                                          |
| P50 关闭行为不变                   | Jev 开、P50 关时，饱和队列、超时 failover、调用/费用上限、工具回显与 P50 未引入前一致；P50 on 后新通道生效                                                                  |
| 单批 ≤2 与低置信不占自动额         | 策略单测 + 提交 spy；第三个只能成为建议                                                                                                                                     |
| expires payload                    | 同 actionId/rev 篡改 nextExpires/op/dateRuleVersion 必使 digest 不同；确认后活动规则版本变化拒绝，commit 不重新推导日期                                                     |
| 建议 schema 与单块 dismiss         | 真实 sanitizer/mergeReview：判别联合往返；非法 revision 整条丢弃；单块 dismiss 后新 batch/rev 不复活                                                                        |
| 每动作快照与撤销                   | 按 §5.5 第 1/2 项验证同批两块分别撤销、逆序撤销和重放不覆盖                                                                                                                 |
| 崩溃四分类与用户编辑反例           | 按 §5.5 第 3/4 项验证；commit-unknown 全部拒绝普通 revision 撤销                                                                                                            |
| raw-byte 恢复                      | 按 §5.5 第 5 项验证 Buffer 逐字节恢复且不走 replaceBlockLocked                                                                                                              |
| 写前/写后故障与扫描重试            | 按 §5.5 第 6–8 项分别验证写前零 CAS、写后 effect-unknown、prepared delete missing 与重复扫描；expires/retire/delete 覆盖数据目录 fsync                                      |
| 双会话并发                         | 多进程真实目录锁/CAS，后写者 stale，不覆盖先写或用户编辑                                                                                                                    |
| private/secret 零外发              | client 边界测试，fake transport 收到的对象严格等于脱敏 allowlist                                                                                                            |
| off/secure/child                   | 真实 gate 与注册接线测试；off 无 hook/文件/通知差异，旧 epoch 不复活                                                                                                        |
| B3 唯一提交入口                    | 本地/B3 均经过同一 commitAction；篡改正文、expires、provenance 或重复确认均拒绝，B3 零直接 store 调用                                                                       |

不能用 mock 替代的部分：真实文件原子替换与字节恢复、目录锁/双进程 CAS、no-follow/secure gate、client 的真实 Semaphore/outstanding、崩溃 half-state 与 fsync 顺序故障注入。模型正文质量可用 fake adapter；provenance 必须用 fake registry 跑真实 client 路由解析，至少再对真实 adapter 做一次 provider/model/usage 对照。

## 10. 风险与回滚

最坏情况仍是 relation 与 coverage 同时误判、崩溃审计落后，或把用户后续编辑误当 P50 结果。v4 以实际返回 provenance、独立快照、预期 after、全函数扫描、effect-unknown 禁止盲重试及 raw-byte CAS 收窄风险，但不宣称模型判断或存储持久性绝对可靠。

- **单动作恢复**：仅 committed 可 `/mem restore --revision <actionId>`；后续编辑、commit-unknown/effect-unknown 或 digest 不符均停止。数据替换/恢复已发生后失败只保留证据，不补偿覆盖、不盲重试。
- **关系恢复**：继续 `/mem restore --block <id>`；本版 archived 只建议，不级联恢复其他块。
- **批次恢复**：按 audit 逐动作逆序执行，不提供跨文件“一键原子回滚”假象。
- **全局关闭**：`memory.governance.enabled=false` 停止 sweep 写盘、P50 生成/自动动作与建议；新增 P50 设置关闭必须满足 I9 byte-identical。
- **紧急停止自动提交**：`memory.governance.incremental.auto=false`（建议默认 false）只保留建议。Q1 未批准时 generate 永远不可用；Q2/Q3 获批不覆盖 Q1 与该开关。
- **代码回滚**：关闭设置后保留每动作审计与快照，不删除用户唯一恢复证据。

已知取舍：zombie>0 停新准入可能让不遵守 abort 的 provider 使本 activation 后续调用不可用，但避免实际 provider 并发失控；真实费用可能超估算 cap，选择如实入账并停后续而不是裁账；directory fsync 增加写成本，仍是进程崩溃顺序保证而非所有掉电场景的绝对证明。

## 附录：开放项与批准门

### Q1：是否批准在同一 JevClient 上增加受限 generate seam？

**状态：有条件待批。** 只有选择 A 且同时接受下列两条硬约束，才允许实现/接线 generate；当前不得把 Q2/Q3 的批准解释为 Q1 已批准。

- **A（Recommended）**：批准本文 allowlist、非 private/secret、attempt 预留和单正文输出契约；无 adapter 时 `revision-unavailable`。附加硬约束：① adapter 出站前必须再过 `redactForJev`；② client 与 revision 共享 `validateRevisionOutput`，client 在向 revision 返回前先校验。
- B：不批准；#50 只做调度与确定性建议，不生成正文。
- C：另建 revision client；不推荐，会绕开统一并发/费用/abort 语义。

**批准门**：Q1=A 且两项硬约束进入同一实现包才允许 generate；在此之前任何路径不得外发正文或提交生成正文。

### Q2：是否批准 #50 的 whole-coverage + conflict 0.90 自动口径？

**状态：已批准（2026-11-09 用户重裁，推翻 2026-11-07「conflict 只建议」的旧口径）。**

批准内容：仅当**独立、异源的 whole-coverage 判定为完整覆盖**，且关系置信度 `>=0.90` 时允许窄条件自动；partial/conflict-only 仍只建议。单文件原子动作、先写审计快照、可撤销恢复原文、每批 ≤2、agent 永不取代 user 规则均为不变式。

推翻旧口径的理由：旧口径针对“仅凭 conflict 概率自动”的风险；新口径不允许 conflict-only 自动，而以独立证据、0.90 复合高门槛和可恢复单文件提交限制最坏情况。异源必须由 relation/generation/coverage 的实际 client provenance 可判定；别名/failover/路由身份无法证明来源分离时，视同未获自动资格，降级为建议。

### Q3：是否批准自动提交仅限单文件原子动作？

**状态：已同意（A）。** 每批 ≤2 个独立单文件动作；survivor 正文更新与另一块退役拆开，首步只建议。不得要求 survivor 更新与退役组成跨文件事务，也不得借 Q3 绕过 Q1、Q2、权限矩阵或运行时 auto 开关。
