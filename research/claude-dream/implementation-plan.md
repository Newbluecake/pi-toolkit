# Dream shadow 与后续受控治理实施方案

> **设计提案，未实施，等用户再次授权。** 本文不是开发、真实数据读取、模型调用、迁移、调度或应用许可。事实基线为 `cebf26f240467fc7e35a298fc88922119962900e`，日期 2026-11-11。下列未来文件域/接口均为提案，不表示代码已存在。本次按 Kimi 独立评审的三点合同缺口修订，不扩大实施范围。

## 1. 背景与目标

### 1.1 问题与目标

在多 agent 编码场景，把新增可核证据与当前记忆比对，发现重复、冲突、时效与组织问题，输出**可核验、可拒绝、可过期的候选**。衡量后续任务正确性与审查成本，不追求删除数量。

外部研究没有证明“Claude 默认 nightly 清理”；本仓已有 #36 确定性治理与 #50 受控 revision。最小增量是**证据窗口与候选报告层**，写入仍归现有领域 owner。

### 1.2 最小首期

- 独立离线 **read-only Dream shadow**：获批输入快照 → 本地确定性规划 → 可读报告及可校验 manifest。
- 无模型模式可独立运行。语义候选/建议正文只有后续批准模型、外发字段、provider 与预算后才启用；否则标 `not-evaluated`，不伪造答案。
- read-only 指真实 memory/session/config **零写入，包括不创建 `.lock` 或 `.jev`**，不是禁止写 shadow artifact；获批的独立私有 shadow 输出目录可持久化报告、review 和 cursor。仅用纯 parser/planner，不 activate、不构造 wireMemory。
- 确定性本地规划可读**本页已获批 raw**以构造原 `BlockCorpus`；private/secret 预排除、本页≤512KiB。模型则只收提名候选的最小 DTO，不接收整页 corpus。
- 不新增 slash（命令体系正另审）、工具或 schedule。未来首期是离线 runner/夹具，入口名需在包批准时确定，不占用户命令名。
- **本轮只有文档，连 runner 都不创建。** 文档不代表 Dream 是 0.12.0 已实现功能。

### 1.3 不做

不改模型权重；不复制未公开算法；不全量扫私有 session；不跨项目或治理 Hub/session memory；不外发 private/secret；不自动改用户令正文或 scope/authority/audience；不自动执行自然语言 until；不擦除历史上下文；不迁移真实布局；不翻 cap/auto/provider；不创建 cron、自唤醒或新工具。

## 2. 现状摘要与复用边界

详细文件坐标见 [现状地图](current-state.md)，本节只列依赖合同。修订时从固定 commit 的 `git show` 核对 `planSweep`：它实际使用 body 做 entryHash、snapshot 与字节判断，不能假装 metadata-only；并发 writer 的工作树变更不改变本文基线。

| 复用项                                                       | 职责                                        | 禁止的替代                                               |
| ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| `blocks/format.ts`、`blocks/rev.ts`、`govern/eligibility.ts` | 解析、实际 rev、日期与权限规则              | 用 LLM 判 expires，以年龄/低频作废                       |
| `govern/sweep-plan.ts::planSweep`                            | 确定性到期/核对建议，需要本页正文           | 调 `runSweep` 获取只读计划，或另造 metadata-only planner |
| `jev/index-store.ts::revisionSemanticSuppression`            | 既有语义 dismiss/resolved                   | 换 reason/action/batch 绕拒绝                            |
| 原 `jev/client.ts` / P50 A ledger                            | 唯一模型通路、预算、deadline、abort、zombie | 第二 SDK client、第二费用账、直接 HTTP 或 legacy 逃逸    |
| D `revision.ts`、C `revision-audit.ts`                       | 真冻结/custody、raw 审计与恢复              | 报告 JSON 重授 LIVE，摘要冒充完整信息                    |
| E `revision-commit.ts`                                       | 唯一 revision 提交、锁内复核                | 直接 store 写、旧 explicit supersede 绕 E                |
| 原 scopes owner/Web review/commands ledger                   | 当前 owner 确认、once 结算、历史只读        | 新确认系统/命令账，origin 字符串当真人证明               |
| `withMemoryDirLock` / safe-fs                                | 实际应用单写者、安全 I/O                    | 第二 memory 锁、按锁龄破锁、锁内等人/模型                |

P50 当前 producer 仅 merge-survivor/retire；E 支持更多不等于已有 producer。普通 CRUD、旧 supersede、sweep 的审计不等于 C/E raw 审计。**stock provider 未认证、`auto=false/cap0`、G1 `10<20` BLOCKED、P8 每步现场授权全部保留。** 源码接线不证明现场 ready。

## 3. 总体设计

### 3.1 职责与依赖方向

```text
用户批准的离线输入快照（不是自动会话爬虫）
  ├─ inventory + 本页获批 raw（预排除 private/secret，≤512KiB）
  └─ evidence manifest：已结束来源、边界、引用、完整性
                    ↓
Dream evidence/window（新增薄层，pi-free）
  权限/完整性/稳定性 → 有界分页 → 稳定 windowKey
                    ↓
Dream planner/report（新增薄层，pi-free）
  #36 纯 plan + 输入的 shadow ReviewRecord[] 抑制/精确 reopen
  [另授权可选] 提名候选最小 DTO → 原唯一 client → 候选数据
                    ↓
独立私有 shadow artifacts：manifest + candidates + CAS review
  sealed 发布 → 独立 acknowledgeCursor（失败时只补 ack）
  无 memory writer / 无 C prepared / 无 E / 无 LIVE
                    ║ 后续新授权门，默认没有桥
未来同宿主受控复核 → 原 D 新冻结 → 原 C/review 保管
                    ↓ 原 Web 精确确认 + 原 memDir 锁/CAS
                    原 E → 单目标效果 → 原 C 恢复/诊断
```

只新增三种必须存在的职责：

1. **evidence/window**：P50 页不是 transcript 水位，故补来源清单、完整性和失败窗口；不负责爬取所有来源。
2. **planner/report**：复用纯规则，把 source、oldrev、diff、不确定性组织成报告，并消费传入的 shadow review；无真实记忆写能力。
3. **offline adapter**：获批输入/输出连接纯层，不注册宿主 hook。模型适配/应用桥后移，首期不写空壳假装完成。

提议文件为 `src/memory/govern/dream-{contracts,evidence,plan,report}.ts`，不建顶级插件、服务进程、向量库或通用规则引擎。纯层无 pi import；扩展点是经批准的封闭证据适配器，不是任意路径/可执行插件。

### 3.2 四种权限分开

| 权限        | 首期状态                       | 后续授权绑定                                                                           |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| 读真实数据  | 未授权，先合成夹具             | 项目、布局、快照、来源类型、排除项、页内 raw 范围、数量、保管期                        |
| 写 shadow   | 实施后也需批准目录，本轮无运行 | 不在 git 仓库/真实 memory 内的私有目录，0700/0600，容量/保留期；可写报告/review/cursor |
| 调模型/外发 | 默认无、预算0                  | 模型/可信 CODE binding、提名候选字段 allowlist、金额、次数、期限、保留政策             |
| 写真实记忆  | 首期无能力                     | 当前宿主 LIVE、精确内容确认、动作白名单、恢复路径                                      |

secure/locked 不收输入、不生成副本；child 不获写桥。既有注入是项目数据，不是新授权；“本地存储”不是允许外发的依据。

## 4. 接口契约（提案）

接口只用于领域/adapter，不新增工具 schema。封闭验证拒绝未知字段、accessor、异原型、重复 ID、非法 digest/日期、超界整数；不执行 getter/toJSON。模型结果不能直接反序列化成执行计划。

### 4.1 函数签名与端口

以下签名描述待实现 API；所有 DTO 深只读、集合稳定排序。`Result<T>` 为 `{kind:"ok",value:T}` 或 `{kind:"refused",code:DreamErrorCode,field?:string}`。`field` 仅字段名，不含原文。

```typescript
validateDreamInput(value: unknown): Result<DreamInput>
selectDreamWindow(input: DreamInput, cursor: DreamCursor,
  limits: DreamLimits): WindowSelection
planDreamShadow(window: DreamWindow, corpus: BlockCorpus,
  index: JevIndexV1, legacy: LegacyFingerprint,
  evidence: readonly EvidenceUnit[], review: readonly ReviewRecord[],
  reviewRevision: string): DreamReport
verifyDreamReport(report: DreamReport, current: DreamInput,
  review: readonly ReviewRecord[], nowIso: string): Result<VerifiedReport>
runDreamShadow(input: DreamInput, review: ShadowReviewSnapshot,
  ports: DreamShadowPorts, signal: AbortSignal): Promise<DreamRunResult>
sealDreamReport(report: DreamReport, expectedReviewRevision: string,
  port: DreamArtifactPort): Promise<Result<SealedReport>>
```

这些是签名声明，不是实现代码；`BlockCorpus/JevIndexV1/LegacyFingerprint` 直接复用现有类型。`DreamWindow` 持有本次显式日期/时区、inventory/evidence 范围和 snapshot/permission 摘要，不隐读当前时间。`VerifiedReport` 仅返回 reportDigest、当前 snapshotDigest、verifiedAt，不授 LIVE。

`ShadowReviewSnapshot` 为 `{namespaceKey, revision, records: readonly ReviewRecord[]}`，revision 为整份封闭 review 内容的 SHA256。runner 的显式输入携带这个快照，传其 records/revision 给 planner；入口先与 `readReview()` 核对，同 namespace、同 revision 才准入。读取或校验失败不能按空 review 继续。planner 在提名及可选模型调用前消费这些拒绝/reopen记录，报告发布前再核 reviewRevision；等待中发生 review CAS 变化则 stale，禁止发布旧决定或自动重发模型。

`DreamShadowPorts` 只包含三种 capability：

- `snapshot.readBlock(id,expectRev): Promise<Result<ReadonlyBlockSnapshot>>`：只读批准范围本页 raw，返回精确 raw/rev/digest；不解析任意路径。private/secret 预排除，本页累计≤512KiB，供原 `BlockCorpus` 本地规划。对象不可自动序列化外发。
- `artifacts: DreamArtifactPort`：仅获批 shadow namespace；见下表。它可写报告/review/cursor，不具备真实 memory 权限。
- `judge?`：缺省不存在；`evaluate(dto: NominatedCandidateDto,signal): Promise<Result<SemanticDraft[]>>`。只接提名候选的批准最小 DTO，**不是 window/corpus/raw 整页**；draft 无权限字段/路径/命令，只有 target/source 引用、理由和可选正文，过第4.3节验证和确定性 diff 后才进报告。

`DreamArtifactPort` 方法均返回异步 `Result`，无任意路径参数：

| 方法                                                                 | 返回与效果                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `readCursor()`                                                       | DreamCursor，只读                                                                                |
| `readSealed(windowKey)`                                              | SealedReport或明确missing；读完整 manifest/文件并核digest，不把损坏当missing                     |
| `readReview()`                                                       | ShadowReviewSnapshot；有界、完整读取，不返回截断快照                                             |
| `appendReview(record: ReviewRecord, expectedReviewRevision: string)` | 新ShadowReviewSnapshot；仅shadow review锁内CAS写一条，经第4.4节约束，不改报告或cursor            |
| `markAttempt(attempt)`                                               | 持久attempt标记引用，不是费用账                                                                  |
| `publish(report, expectedCursorDigest, expectedReviewRevision)`      | SealedReport；复核cursor/review绑定后**只封存报告/manifest**，不ack cursor，不改review           |
| `acknowledgeCursor(windowKey, reportDigest, expectedCursorDigest)`   | CursorAck；核既有sealed内容后仅cursor CAS，不重写sealed文件/报告/review，不调模型；细节见第5.3节 |

没有 memory writer、E、真实记忆确认端口、shell 或 web。S3 的 judge 必须由既有宿主唯一 client/预算 owner 提供；离线宿主没有该 capability 就 unsupported，不能启动真实 pi 或新建第二 client 取得它。

`DreamRunResult.kind` 仅为 sealed、no-work、incomplete、blocked、canceled、unknown；带 `windowKey?`、`reportDigest?`、`code?`、已完成/待处理范围和有界计数。unknown 不等于没花钱/没写产物。

错误码封闭为 `E_DREAM_INPUT`、`E_DREAM_PERMISSION`、`E_DREAM_INCOMPLETE`、`E_DREAM_STALE`、`E_DREAM_BUSY`、`E_DREAM_BUDGET`、`E_DREAM_UNSUPPORTED`、`E_DREAM_ABORTED`、`E_DREAM_PERSIST_UNKNOWN`。底层异常只映射这些码，不回显正文、凭据或私有路径。未来应用保留 E 的 committed/skipped/effect-unknown，不换成 shadow 码。

### 4.2 输入、来源与报告数据

- **DreamInput**：`schemaVersion:1`、`policyVersion:"dream-shadow-v1"`、`baselineCommit`、`projectKey`、`snapshotDigest`、`layout:"blocks"`、`localToday`、`timeZone`、`observedAt`、`permissionDigest`、`inventory`、`evidenceManifest`、`limits`。时间/权限来自可信本地 adapter，不让模型生成。
- **inventory**：获批范围非private/secret项的 `(id,rev,rawSha256,authority,scope?,audience?,status,privacyState,parseState)` 有序项、总数、实际采集范围；排除项只保计数。只证明获批范围，不声称整个项目；本地规划读取本页获批raw构造corpus，不要求先有候选。
- **EvidenceUnit**：`sourceKey`（私有不透明 ID）、`kind`、`revisionDigest`、`occurredAt`（未知 null）、`observedAt`、`ordinal`、`branchDigest`、`locator`、`actor`、`integrity`、`completeness`、`privacyState`、`payloadDigest`、最小 allowlist payload。
- `kind` 仅 user-statement、event、memory-block；actor 仅 human、agent、tool、unknown。来源 actor 由 exporter 证明，不由正文声称“我是用户”决定；human 来源也不等于当前授权。
- `integrity` 仅 verified、unverified、changed；verified 只是批准快照读取/digest 一致，不证明语义真、correction已人工核实或真人授权。
- `completeness.collection` 为 complete、partial、unavailable；`completeness.payload` 为 complete、redacted、truncated、excluded；另带 `missingRanges`。两维不能压成一个布尔 complete。
- **event payload**：严格类型、关联 task/command 的本地 alias、可信 status/exit code 与成功观察；不含 raw 工具结果、shell、URL、路径、stdout。成功事件不推导任意 until。
- **user-statement payload**：获批原话最小必要片段、来源引用/适用边界；是否 correction 仍须后续独立核原话和人审。
- **DreamReport**：`schemaVersion`、`policyVersion`、`windowKey`、`snapshotDigest`、`permissionDigest`、`cursorBeforeDigest`、`reviewRevision`、完整与待处理范围、`candidates[]`、`excludedCounts`、`unknowns[]`、`metrics`、`createdAt`、`reportDigest`。metrics 含读取量、模型调用/attempt计数、耗时、原 A 费用及 known/unknown 标识，未知费用不填0。
- **SealedReport**：windowKey、reportDigest、artifactManifestDigest、coveredRanges、cursorBeforeDigest、**cursorAfter及其cursorAfterDigest**；预期cursorAfter与报告一同封存以供独立ack使用，不靠重新规划推导。是持久产物引用，不是应用凭证。
- **CursorAck**：`{status,windowKey,reportDigest,cursorDigest}`，status仅acknowledged或already-acknowledged；表示报告水位，不表示已审核/应用。

所有 digest 为小写64位 SHA256（原 rev 不改格式）；日期 YYYY-MM-DD 经有效性验证，时间使用规范 ISO8601，非负整数均有第8节硬界。source locator 只在本次 manifest 解析，拒绝绝对路径、`..`、symlink/非正规文件/超界文件；不从坏引用回退全盘搜索。

projectKey/sourceKey 只在批准私有产物稳定。公开汇总用随机 alias，不能把 sessionId 简单散列就称匿名；不把私有路径带入 repo 文档或通用 DTO。

### 4.3 每项 Candidate 必备字段

| 字段组      | 必需内容                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| 身份        | candidateId、semanticKey、windowKey、policyVersion、createdAt、reviewBy                                            |
| 目标        | targets[]：每项 id、**oldrev**、rawSha256、authority、scope?、audience?、status；不能由摘要/旧报告伪造             |
| 证据        | sourceRefs[]：sourceKey/revisionDigest/locator/payloadDigest/completeness；S1/S2的explicitCorrection固定unverified |
| 理由        | kind、reasonCode、rationale、preservedFacts[]、possiblyLostFacts[]、unknowns[]；每个事实链接source                 |
| 建议 diff   | beforeDigest、afterDigest、完整 proposedBody或null、metadataDelta、统一 diff；无正文改动也标“无变更/仅核查”        |
| 完整性/权限 | coverage、blockers[]、approvalRequired:true、executable:false；private/secret/excluded 不附正文                    |
| 恢复说明    | recoveryKind、expectedEffect；没有执行审计就不能填写可执行 restore actionId                                        |

枚举固定：

- kind：date-expired、until-check、snapshot、duplicate、conflict、explicit-correction、budget、diagnostic；reasonCode 第一版直接等于 kind，不另造自由文本规则码。
- suggestedAction：keep、verify、archive-proposal、rewrite-proposal、merge-proposal、retire-proposal、scope-review。它不是 E action，也无 delete。
- coverage：complete、partial、unknown。
- **S1/S2的explicitCorrection只允许unverified**；未找到correction时在unknowns注明no-explicit-correction；有疑似原话也只是待核提名，不能据此宣称替代已获证。首期codec拒绝reviewer-verified，模型/人写的普通ReviewRecord均不能升级此字段。
- recoveryKind：none、block-archive、block-superseded、revision-raw。

未来若需reviewer-verified，必须另批独立 **evidence-review** 合同/授权：前置人工记录按 `(sourceKey, revisionDigest, payloadDigest)` 绑定，在候选生成前就可存在，不能依赖candidateId/reportDigest。其来源真实性、过期、CAS与消费规则留后期评审；S1/S2不实现、不调用、不用ReviewRecord替代。这样不存在“先构造候选才能获得构造候选所需证据”的循环。

diff **必须由确定性 renderer 从冻结前后生成**，不接 LLM 自报 diff；afterDigest 绑定建议正文及 metadataDelta，无变更时等于 beforeDigest。改写/合并仍过1024B和现有严格 meta/parser/正文 validator，超限阻塞、不截断。模型 p 只排序，不授权限。

metadataDelta 对 user 的 scope/authority/audience 必为空，范围取舍仅出 scope-review；首期不为模型提供任意元数据修改。明显无效信息也先报告核查/可恢复归档建议，不给自动删除入口。

新覆盖旧要求双方完整有效事实与 **explicit correction**；较晚时间、词汇相近、低频、搜索未命中、高p都不够。S1/S2未核correction就留conflict/verify，不宣称旧令已被覆盖；partial overlap/complementary不退役。未来核实用户规则correction也仅做人审候选，不自动执行。

### 4.4 身份、shadow review CAS、精确reopen与过期

复用 `revisionCanonicalJson` 规范，以 SHA256 对有序 canonical JSON 哈希；不把运行时间/nonce/重试次数放入工作身份。

- windowKey：policyVersion、permissionDigest、projectKey、snapshotDigest、cursorBefore、选中source版本/ordinal及inventory页摘要；用户explicit reopen触发的新窗口另绑定所消费的具体reopen recordId，不因普通review时间戳重跑模型。
- semanticKey：projectKey、kind、suggestedAction、有向target ID列表；无rev/batch，merge有方向、conflict规范无向。
- candidateId：windowKey、semanticKey、targets旧rev/raw、source摘要及before/after/diff摘要。
- reportDigest：报告除自身digest外全部规范内容，包括reviewRevision；artifactManifestDigest覆盖发布文件名与字节digest，不递归包含自身。报告中的时间不改变windowKey，重复运行优先读取既有sealed版本。

**ReviewRecord** 为 `{recordId,semanticKey,candidateId,reportDigest,decision,reviewedAt,reviewerBindingDigest,rejectionRecordId?,comment?}`：

- decision为keep/reject/defer/request-apply/**reopen**。recordId为其余规范字段的SHA256；candidateId/reportDigest必须绑定已sealed报告的实际候选。comment≤1024 UTF-8字节，其余字段封闭验证。
- 普通record在候选封存后产生，只记录本地人工阅读决定，不给候选构造提供correction已核实证明；request-apply只是意向，不是cap，reopen也不授真实memory权限。
- reject持续抑制同semanticKey；新source/rev不自动解除。keep/defer/request-apply不能隐式解除reject。
- **reopen必须指定一个确切rejectionRecordId**，且其semanticKey/candidateId/reportDigest与被引用reject完全相等；引用不存在、非reject、跨namespace或绑定不符均拒绝。它只解除那一条reject，不解除同目标/semanticKey的其他拒绝，更不清除原Jev dismiss/resolved。
- 同一reject重复reopen不叠加权利；若有新的reject必须另行指向该记录reopen。kind/action不能仅为绕拒绝重分类；已拒绝目标组合的新建议先显示关联拒绝并请求精确reopen。defer不制造timer。

**有界读写合同**：每namespace最多256条review事件、规范JSON≤256KiB；`readReview`整份校验，超限/损坏返回拒绝，不截断、不当空。达到上限拒绝追加，不自动逐旧淘汰reject/reopen或重建空表。仅该批准shadow namespace内短锁执行`appendReview`：核当前revision与expectedReviewRevision、目标sealed候选与reopen引用，再原子写新snapshot。CAS不符返回E_DREAM_STALE，调用者重读/人工决定，不盲重试。同recordId且全字段相同可幂等返回现snapshot（不重复追加）；同ID不同内容拒绝。持久结果未知返回E_DREAM_PERSIST_UNKNOWN，先readReview核实，不再追加替代记录掩盖未知。

planner消费显式传入的完整records，按事件顺序折叠active rejects及其精确reopen，存在任一未解除拒绝即抑制；既有review dismiss/resolved也先过滤。离线review只写shadow namespace、不重写Jev index；未来桥同时核两边。封存报告不随之后review改写，显示/复核/未来应用必须读最新review；不能把旧sealed报告中仍显示的候选当现行许可。

reviewBy取createdAt+24h与已知证据有效期的较早者；日期动作过本地午夜须重算。24h只是报告复核期限，不令历史事实自动失效。source不可复核，或rev/raw/目录身份/权限/policy/owner变更，立即stale；不能只靠TTL。未来确认意向最多120s且不超过原owner/command lease，等待不持领域锁。

## 5. 增量窗口、完整性、幂等与失败水位

### 5.1 不是 lastRunAt 扫描器

1. 首期输入为获批、已结束来源的immutable export；活跃来源pending，不把半段transcript算完整。不通过启动真实pi/wireMemory导出。
2. 稳定顺序为sourceKey、revisionDigest、ordinal；时间只展示/限频，不当唯一游标。同时间、迟到、旧source修订、fork分支必须可发现。
3. **DreamCursor**：schemaVersion、projectKey、permissionDigest、manifestGeneration、已封存source版本/ordinal ranges、pending/blocked ranges、inventory页位置、已发布windowKey及cursorDigest。每次比对批准manifest的集合差异，迟到历史时间仍入新窗口。
4. 超界分页显式pending，不声称前128块覆盖整个项目。缺页/坏块/读取变化标partial/unavailable，只给诊断/conflict，不授“全覆盖替代”。
5. collection=complete可以表示所有排除项都已记账，但payload=excluded不能证明语义完整；相关目标/原话范围全部完整且无脱敏信息损失才可coverage=complete。

### 5.2 只读快照一致性

优先用户批准的离线快照。未来如批准live read adapter：记录目录身份、布局marker、完整inventory；no-follow读取**本页获批且预排除private/secret的raw**，累计≤512KiB；构造原BlockCorpus；末尾重枚举并核目标rev/raw及身份。变化则stale、不消费水位，不创建真实`.lock`。这不是事务快照保证；精确应用才用原D锁内freeze。

### 5.3 水位、封存与独立ack

- **发现水位**：扫到哪里、哪些pending/blocked，不代表完成。
- **报告水位**：哪些完整ranges被durable sealed report覆盖，**不代表接受或应用**。
- 应用状态另引用真实C/E action，不能以cursor代替。

```text
selected → processing → publish/sealed(report + manifest + cursorAfter)
                                      ↓ acknowledgeCursor（三参数窄端口）
                                  cursor CAS ack
             failed/canceled/incomplete：失败范围不ack
```

`publish`在shadow短锁内核expectedCursorDigest/expectedReviewRevision，写并同步报告/manifest，原子发布sealed；它**不更新cursor**。sealed包含完整预期cursorAfter及其digest。`acknowledgeCursor(windowKey,reportDigest,expectedCursorDigest)`仅执行：

1. 有界读取既有sealed manifest/报告/文件，重算全部digest，核windowKey、reportDigest、cursorBeforeDigest=expectedCursorDigest和规范cursorAfter；缺失/损坏/不自洽拒绝，不能重规划或补写报告。
2. shadow短锁中重新复核sealed身份/digest与当前cursor。当前digest等于expectedCursorDigest时，只原子CAS写已封存的cursorAfter，返回acknowledged；已等于cursorAfterDigest且绑定同window/report时返回already-acknowledged，零写。
3. 当前cursor已被其他窗口推进或其他绑定不符则E_DREAM_STALE，不回退/覆盖；写cursor结果不能判定时E_DREAM_PERSIST_UNKNOWN，重读后只可调用同ack端口核实。

恢复入口先查已有sealed并执行上述ack分支；**不进入plan/judge/markAttempt/publish，不重跑模型、不重写任何sealed产物或review**。review随后改变不影响“证据已报告”的ack，但旧报告候选仍须按最新review过滤，ack不授应用权。

| 情况                                                    | 结果/重启                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 无新增源、inventory无变化、无explicit reopen、无待补ack | no-work；零模型、零memory锁、零memory/产物写，不新开回合                        |
| 全suppressed/无动作                                     | 可封存零候选报告再独立ack完整范围；零模型，本次不自动补下一页                   |
| 读取/完整性失败、超界未完成、取消/超时                  | 可存有界诊断，失败范围不消费；仅下一外部批准机会重试，不轮询                    |
| sealed成功、首次ack失败                                 | 仅调用同三参数ack，验证sealed后cursor CAS；plan/judge/publish调用计数均为0      |
| ack成功但返回丢失，重调同ack                            | 当前cursor等于封存after且绑定一致：already-acknowledged，零写/零模型/零产物重写 |
| sealed被改/缺失/digest错误                              | E_DREAM_PERSIST_UNKNOWN或输入绑定拒绝；cursor不动，不重建报告掩盖               |
| expectedCursorDigest过时/其他窗口已推进                 | E_DREAM_STALE；不倒退、不重跑模型、不覆盖新cursor                               |
| review CAS并发变化/坏review                             | 发布前stale或读取拒绝；不能当空review，不能借重试重发模型                       |
| 模型部分结果                                            | 只诊断/待审；未完成范围不ack，不把partial当完整                                 |
| dispatch或费用未知                                      | unknown，保留attempt fence；不自动重发、换windowKey或模型绕过                   |

模型dispatch前持久attempt标记，绑定windowKey/requestDigest/原A jobId。它只防重发，**不是第二费用账**，不估计/清零A ledger。崩溃在派发前后不可辨时保守unknown；provider无法恢复既有请求就不自动续发。A是单client/activation等既有限界，不夸大为跨进程绝对金额上限。

shadow cursor/manifest/review由一个离线writer持短artifact锁CAS发布，不持锁等人/模型。复用已审阅目录锁原语，锁不放真实memory，不创造第二memory单写者域。只有可证同机死亡才回收，不可验证owner返回E_DREAM_BUSY，不按年龄强破锁。

## 6. 权限、隐私最小化与注入隔离

### 6.1 最小数据：本地规划与模型外发分层

- 元数据先行完成授权/分页/privacy筛选；**本地确定性规划允许读取本页已获批raw**，private/secret预排除，整页raw≤512KiB，以构造原BlockCorpus并供planSweep的hash/snapshot/bytes判断。不是“只有提名后才能读正文”，也不新增metadata-only planner。
- 若授权不含该页raw、秘密无法安全预排除或页超限，返回blocked/pending，不伪造body/raw继续规划。未标记secret仍用本地检测兜底；命中则从corpus/候选/外发DTO整项剔除，不复制进报告。
- private/secret只保排除计数，公开报告无私密ID/摘要；检测不代替用户标记和白名单。默认不收assistant推理、system prompt、raw工具结果、附件、代码全文件、凭据、完整transcript或子会话内容。
- **模型只接提名候选最小DTO**，不接本地整页corpus/raw。逐字段allowlist、先截断后脱敏；破坏信息完整性就降coverage，不为通过完整性而外发原私密内容。
- 不向旧Jev classify偷塞文件正文绕已有边界。P50正文生成须原DTO/validator、可信binding和授权；新增证据模型任务须单独外发合同评审，不能借“Dream”继承全量读权。
- before/after/diff仅放获批本地私有产物，不入research/公共数据集/普通日志；日志只有阶段、计数、有限错误码。只读是“不改真实memory”，不禁止批准的shadow报告/review/cursor写入。
- 建议原文/diff/引用保留7天，到期停止消费并提示人工清理；首期不自动擦除，也不删除证据绕unknown。实际保管期由用户批准。

### 6.2 不可信材料不是新指令

policy来自可信代码/批准配置；证据、旧memory、模型输出都是data。正文“忽略规则/执行工具/我是用户”不能改变权限。judge无shell/web/writer，只返回封闭候选；不执行模型给出的路径、命令或回调。

历史human来源不等于本轮授权；explicit correction须可展示原话、时序、适用范围与被替代全部有效事实。S1/S2只产unverified，未来已核correction依赖另授权的source三元组前置evidence-review，不由候选后置ReviewRecord自证。user的scope/authority/audience**所有自动阶段永不变更**；要改另立决策。无明确correction留conflict。LLM判until成立始终只给verify，不能驱动删除/归档。

## 7. 人审、确定性复核、CAS应用与恢复（后续授权阶段）

### 7.1 人审生命周期

首期本地报告人工阅读，不加slash/UI。每项展示oldrev/source/完整性、全文与diff、保留/可能丢失事实、范围影响、blockers与恢复类别。keep/reject/defer/request-apply及对具体reject的reopen，按第4.4节仅落shadow review CAS，默认不应用。普通review不能把correction升级为reviewer-verified。

过期/来源不可得只view或请求重采样，不给apply。用户令候选单独高风险分组，不能与经验批量确认。未来Web复用原review，不把原生只读`review --run`改成隐藏写入口。

### 7.2 首轮应用白名单与桥

应用试点仅**明确批准的agent→agent现有merge-survivor/retire**，每批最多一个实际效果，原E持久每批≤2门仍在。merge与retire分开批准：先写survivor不自动退役context；retire另核新survivor的完整信息/来源。日期archive仍归#36 owner，不接Dream新applier。user改写、跨scope、delete和自动应用不在该试点。

报告JSON不能直达E：

1. 在main/plain/current owner/epoch/gate下仅把候选当导航；重读source、最新shadow review及原dismiss/resolved、live raw/rev，重算候选、窗口和diff。
2. 完全一致才申请原D**新的真实锁内freeze**；受支持的原action/policy不符就unsupported，不加自定义origin、伪造LIVE。
3. 原host/client取得真实generation/coverage/spec/provenance，经C/review保管。Dream sourceRef不是R/G/C来源；历史批准不是新LIVE。若新生成正文/digest变化，必须形成新候选重新完整确认。需已核correction的动作还须先完成未来独立evidence-review合同/授权。
4. 原Web current-custody/R4精确确认，原commands ledger once结算，原E origin为web-b3。不从导入文件构造receipt，不把离线reviewerBindingDigest或reopen当cap。
5. 基线host没有外部候选导入权；未来桥不能复用原owner准备合同时，须另审最小seam。**不得另建client/host/ledger或手工塞retained map**；缺桥就继续只读报告。

### 7.3 确定性计划复核与锁内提交

独立重算所有digest/完整性/权限/source/最新拒绝状态，不能照抄LLM给的expected。原E在canonical memDir锁内同步再核D私有input/proposal、raw SHA256+rev、目录身份、owner/epoch/lease、gate/abort、policy、authority/status/privacy、源审计、完整coverage、dismiss/resolved、review行和一次确认。source或任何绑定变化即stale/review，旧批准不能自动修补后复用。

原C prepared → expected-after屏障 → 一次data syscall → 真实观察 → finalize；无跨文件事务承诺。锁外等人/模型；CAS只防陈旧，不证明语义正确。普通store、旧supersede、直接Markdown写不是fallback。

### 7.4 失败与恢复

| 结果             | 语义                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| committed        | 记录真实actionId/afterRev与单目标效果；原onAfterWrite恰一次失效缓存，internal不自触发 |
| skipped          | 如stale/permission/gate/digest/unavailable，不报成功；重读/人审，不沿用批准或自动重试 |
| effect-unknown   | 保留before/expected-after/审计/attempt fence，停该批；不补偿、换action/batch重试      |
| 取消但效果已观察 | 取消不把applied/unknown变成未写，只停止后续；ledger保留真实效果                       |

revision仅合法committed审计走原`restore --revision`完整raw预览、一次确认、CAS；unknown不自动restore。archive/superseded用`restore --block`，删除是另一条`restore --trash`，不可混用。

恢复不续期、不恢复全链、不逆转已投递消息；原expires仍过期可再次不注入/归档。恢复失败也可unknown，保留原intent，不盲重试。普通edit无统一raw-before不能承诺一键恢复，试点不用该路径。shadow cursor的失败恢复只用第5.3节ack，不借用这些真实memory恢复入口。

## 8. 后台预算、期限、取消与零工作

首期offline不后台续跑。下列为提议上限，不是当前设置默认：

| 资源          | 上限与退化                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 范围/并发     | 单项目单run/单writer；一次固定页，不追下一页                                                                       |
| 输入页        | 最多128块元数据、8个evidence unit；本地规划可读本页获批raw，总计≤512KiB，private/secret预排除；超界pending         |
| shadow review | 每namespace≤256事件且≤256KiB；整份读/CAS追加；满则拒绝，不淘汰拒绝记录                                             |
| 产物          | 最多16候选/页、私有报告≤1MiB；超界明确分页或拒发布，不静默丢项                                                     |
| 时间          | 无模型2s总墙钟；另授权模型模式30s，含读取/排队/锁/模型/发布；每I/O边界查剩余，不声称可抢占同步syscall              |
| 模型次数      | 默认0；另批最多2次高层语义请求、1次generation、1次独立coverage（合计≤4）；provider attempts另受原A限制，不循环重试 |
| 费用          | maxCostUsd默认0；正额须用户给定并冻结在原named job；余额/价目不可信直接blocked，不用免费档或legacy逃逸             |
| 锁等          | shadow发布/review/ack≤250ms，实际应用原锁≤500ms，均按剩余收紧；不持锁等模型/确认                                   |
| 取消          | caller abort/owner变更/reload/shutdown/预算/期限撤发布与提交权；迟到仅由原A结算，不发布候选/效果                   |

所有deadline经`clampSpanMs`，长等待`createSegmentedClock`，timer全部unref；无module-scope可变状态/新hook。将来自然机会接入须另授权，复用原owner/incremental quiet/idle/cooldown，不建nightly scheduler。

无新证据/变化/explicit reopen且无待补ack时no-work；cap0、缺binding、全private、全reject时零模型。待补ack只调窄端口不重算/重写报告。锁忙不轮询、不自唤醒。非合作provider由原A zombie闭锁，不能换client清零。

## 9. 关键决策与取舍

| 决策                    | 理由与不选方案                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------- |
| 离线shadow先行          | 先验质量，避免完整startup/schedule的迁移/旧writer/模型副作用                        |
| manifest+内容版本水位   | 防同时间/迟到/fork/修订遗漏，不用单lastRunAt；sealed后独立ack防重算                 |
| 首期真实memory连锁不取  | 严格只读，不把创建.lock/诊断副作用混成只读；独立shadow可CAS写                       |
| 本地页raw与模型DTO分层  | 保原BlockCorpus/planSweep，不新增metadata-only架构；模型只收提名最小内容            |
| correction才提议替代    | 首期unverified留待核，未来source前置evidence-review另审，不用候选后置review循环自证 |
| source与provenance分离  | 历史证据不是执行权/实际模型身份，JSON不自证trusted/LIVE                             |
| 唯一A/D/C/E与review     | 不造第二预算/真实写者/确认旁路；shadow review不清原拒绝                             |
| 一目标一效果、unknown停 | 原系统非跨文件事务，不承诺批量回滚                                                  |
| 不造新命令/自动化承诺   | 命令体系另审，避免未经授权扩大范围                                                  |

代价：完整性保守会少出候选，private/partial导致unknown是正确结果；有界顺序吞吐有限，单低价模型也不能替代独立coverage。这些换可解释性与不越权，不预建分布式架构。

## 10. 分包实施、文件域、依赖与验收

**全部是未来包，当前无一实现。** 每包派发前重新确认授权、读README、核新HEAD。共享contracts、fixtures、wire/settings由单owner串行处理；冻结面只能上报。

### D0 文档（本轮）

- 文件域：本目录四Markdown；已完整读两份输入并精炼归档。
- Kimi独立评审条件通过；本次只闭合review/CAS与reopen、sealed补ack、本地raw与模型DTO三项合同，不实现。root后续核对并按授权精确commit，本作者不commit。
- 验收：四文件Prettier、diffcheck、Markdown链接检查。
- 停止：主题外改动、私密内容或把提案写成已实现。

### S1 合同与纯规则

- 依赖：D0+用户再次开发授权；只合成数据。
- 文件域：`src/memory/govern/dream-contracts.ts`、`dream-evidence.ts`、`dream-plan.ts`；对应`tests/memory/govern/dream-*.test.ts`。
- 产物：封闭合同、确定性分页/候选，复用parser/planSweep及本页获批raw；planner显式消费ReviewRecord[]/reviewRevision，S1/S2 correction只允许unverified；0模型/0真实领域写，不做前置evidence-review。
- 测试重点：传入reject抑制、仅具体rejectionRecordId被reopen、其他拒绝仍生效；缺/坏review不当空；拒绝reviewer-verified；本页body/raw可供hash/snapshot，private/secret/512KiB边界。
- 未来命令：`PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1 -- tests/memory/govern/dream-contracts.test.ts tests/memory/govern/dream-evidence.test.ts tests/memory/govern/dream-plan.test.ts tests/memory/govern/sweep-plan.test.ts`；`npm run typecheck`。
- 停止：需要改日期语义、用户权限、设置/wire/golden。

### S2 离线报告与窗口

- 依赖：S1合同冻结。
- 文件域：`src/memory/govern/dream-report.ts`、`dream-runner.ts`、`scripts/dev/memory-dream-shadow.ts`及对应测试；不动index/settings。
- 产物：显式review输入、shadow readReview/appendReview有界CAS、报告publish与独立acknowledgeCursor、失败重启；judge缺省无。runner只消费批准manifest，不发现私有目录。
- 测试重点：256事件/256KiB、CAS并发/重复record/满表不淘汰、reopen引用拒绝；review等待中变化阻止封存；publish成功ack失败只补ack，ack返回丢失幂等，损坏sealed/过时cursor不写，断言plan/judge/publish调用0和sealed字节不变。
- 未来命令：`PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1 -- tests/memory/govern/dream-report.test.ts tests/memory/govern/dream-runner.test.ts tests/memory/fs-guard.test.ts tests/boundary/pi-free.test.ts`；变更文件定向format check。
- 停止：memory目录任何写、窗口不幂等、取消后迟到发布、普通review被当correction已核实证据。

### V1 小规模真实dry-run

- 依赖：S2验收+单独批准真实读取/取样/保管；先无模型。
- 文件域：获批私有样本产物，仓库仅匿名研究汇总。
- 未来入口示例：`node --import tsx scripts/dev/memory-dream-shadow.ts --manifest <approved-manifest> --output <approved-private-output> --mode deterministic`。这是拟建脚本，基线不存在，本轮不执行。
- 批准范围明确包括本页非private/secret raw、≤512KiB。检查输入/真实memory前后字节和文件清单，核0真实memory写/0外发；允许的shadow artifact写单列，不把它误报为破坏只读。
- 停止：布局未知/需P8/来源或权限不清/私密泄漏，不为评测迁移。

### S3 可选语义shadow

- 依赖：S2+V1+模型/提名DTO/金额批准+可信provider认证。
- 文件域：原`jev/client.ts`及DTO的最小seam、dream runner、离线seam测试；该子系统README记录。只能原唯一A owner，不另建client。
- 未来门：定向dream-runner、现有`tests/memory/jev/client-p50-sdk.test.ts`、`client-p50-fallback.test.ts`、P50/off差分门、typecheck；断言模型只收提名最小DTO而非页corpus，补ack路径0模型。
- 本包不自动取得reviewer-verified能力；前置evidence-review仍需单独合同/授权，不借模型升级。
- 停止：stock unsupported/cap0/费用或实际身份不可信；保留deterministic，不补假cap/路线/证据。

### A1 只确认应用试点

- 依赖：S3质量达标+应用逐项批准+桥独立方案评审；凡需已核correction先完成另授权的source前置evidence-review合同，不用ReviewRecord绕过。
- 文件域：原`govern/revision-host.ts`最小准备seam、原Web review domain adapter、集成测试；无新工具/命令。只agent pair merge/retire。
- 未来门：revision-commit/security/faults定向门、`tests/integration/memory-revision-web-i1.test.ts`、`memory-revision-native.test.ts`、新增Dream桥双进程/恢复测试；相关Web离线probe另批。
- 停止：需绕LIVE/custody/E、影响用户字段、unknown、恢复未证。

### A2 可选受限自动化

- 依赖：A1真实质量证据+明确opt-in动作/次数/金额/窗口/撤销；原G1/P50/P8门不解除就不称自动就绪。
- 文件域：优先原owner/incremental；具体变化必须新方案，不预建空壳。
- 未来门：新授权真实质量评估+原门，候选/效果分别复核。
- 停止：任何用户令误改、注入成功、超预算、unknown或并发丢写，撤后续权而不掩盖已有效果。

S1后不同文件可依冻结合同分工；同一runner/report及其测试各有唯一owner。S3不能提前并行接生产，A1不能先写apply后补审核。新增测试若含子进程/socket/长等待按`tests/tiers.ts`分层；真实两进程竞态归integration/tier2，不伪装tier1。

全量实现门只在未来获批后由root统一跑，本轮不跑。frozen fixtures不重生，off golden原字节；需新outward surface就停上报，不能刷新golden掩盖行为变化。

## 11. 小规模真实样本dry-run验收矩阵（未运行）

建议一个获批项目、8–12个已结束来源、至多24个候选相关块，优先困难样本；不预读现场找样本。真样本不足报NOT-EVALUATED，不用合成冒充。留盲测片段，标注/生成分人；公开只放匿名计数和错误类型。

| 维度          | 样本/故障                                                                                       | 首轮准入标准                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 用户规则      | global/topic、user到期、不同authority、显隐correction、partial冲突、范围变化                    | 丢失/无授权改动/自动字段变化0；S1/S2 correction全unverified，无核实证据留conflict/verify；user到期不作废              |
| 准确率        | 重复、互补、旧但正确、过期agent、无证据经验                                                     | 可采纳建议精度≥90%，逐项误判；独立有效事实/日期/来源保留100%；小样本不冒充统计认证                                    |
| 召回/unknown  | 显式correction、跨页、迟到、同时间、缺源/private/截断                                           | 所有漏项/unknown解释，完整性不假真，不以少出候选掩盖遗漏                                                              |
| 本地读/外发   | 页内获批raw用于hash/snapshot，private/secret排除、超512KiB、提名DTO                             | 保留BlockCorpus签名；未授权页raw不读，模型只收提名最小DTO，补ack路径0raw规划/0模型                                    |
| shadow review | reject、多个拒绝、精确reopen、坏/满表、并发CAS、普通review声称已核实                            | 规划确实消费records；只解除指定reject，坏表不当空/满表不淘汰；不产生真实memory权或reviewer-verified                   |
| 恢复          | BOM/CRLF/非ASCII/version、merge/retire分开、仍过期、恢复时变更                                  | S阶段0真实领域写；A阶段own-temp精确raw往返100%；unknown不自动修；现场恢复再确认                                       |
| 注入/隐私     | 假用户令、工具伪authority、穿越路径、secret/private                                             | 0 shell/web/越权调用，0私密secret外发，0未知字段变权限；失败立停                                                      |
| 并发/幂等     | 同snapshot双run、等待中rev/review变、拒绝后新rev、sealed后ack失败、ack返回丢失、重启/source换代 | 同window不重复请求/效果；旧批准不执行；补ack断言plan/judge/publish=0、sealed字节不变；过时cursor不覆盖，unknown留栅栏 |
| 零工作/取消   | 空、全reject、cap0、unsupported、锁忙、超时、迟到provider                                       | 0新增模型/自唤醒；取消后0发布/效果；原A晚费用不抹除                                                                   |
| 成本/收益     | token、费用known/unknown、耗时、调用数、人工分钟、后续噪声                                      | 不超批准预算/次数/时间；未知费用不填0；对照无Dream，正确性/噪声无改善不进自动化                                       |

**不是KPI**：删多少、少多少块、把resident压到多少字节。主要指标为用户规则存活、证据准确、事实覆盖、后续收益、审核负担、恢复与成本。

G1仍要求真实正例≥20等原指标，24块试点不替代G1；G2 PASS不是自动改写许可。P8不因发现files布局或读取样本就默认执行。

## 12. 授权门、停止条件与待用户决策

### 12.1 分期授权

1. **现在文档阶段**：仅四文档；独立评审三点合同修订后root核对并按授权精确提交，不实施。
2. **开发S1/S2**：再次批准，只合成/获批离线输入；本页raw范围和shadow artifact写明确区分；无真实数据/模型默认许可，correction只unverified。
3. **真实样本V1**：单独批准项目、manifest、数量、页raw、导出与私有保管；触及P8每步另确认。
4. **语义S3**：批准模型、提名外发DTO、费用、期限；先可信provider认证，不为Dream解除stock阻塞或翻cap。独立source前置evidence-review若需要另审另授权，不塞进S1/S2。
5. **确认应用A1**：另审桥，逐项agent pair；原LIVE/E/C/恢复/once ledger齐备才执行。
6. **自动化A2可选**：优先不增加自动动作，沿用agent日期sweep；扩大语义自动处理须独立质量/来源/成本门和opt-in。user scope/authority/audience永不自动，用户正文仍人审，until不直接驱动删除。
7. **定时化最末可选**：明确任务、时区、权限、费用、错过窗口/取消语义后才讨论schedule。本设计不提供创建指令；已有schedule创建即生效，不是无副作用预演。

### 12.2 立即停止上报

权限/source不明；真实数据未批准；private/secret外发；想换authority或explicit supersedes绕保护；G1/provider/P8未满足却准备auto；raw/source绑定变化；审计/dispatch unknown；费用不可界定；需刷新冻结件、新工具/命令、配置翻转或跨项目。停止不回滚已观察效果，先报告真实状态再等新授权。

### 12.3 待root日后用ask_user收敛

- 是否批准S1/S2离线shadow开发（推荐先无模型）。
- 单项目真实样本的manifest、页raw范围、数量、私有输出位置与原文/报告保管期。
- 是否引入语义shadow；provider认证任务、提名允许字段、模型、明确金额与次数；是否另审source前置evidence-review。
- 是否进入agent pair确认应用，审核人、动作与精确恢复验收；用户令/范围字段另立决策，不夹带授权。
- 是否需要自然机会后台接入或更晚schedule；不需要则一直维持手动离线报告。

以上仅记录待决，不在本轮擅自开展。未获再次授权，保持**设计提案、未实施**；“后面需要再推进”不等于现在执行任何包。
