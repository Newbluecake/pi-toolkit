# Jev 核心 memory 架构 · 实施方案（jev-plan v2）

> 状态：实施方案 v2（2026-10-30），未动代码。v1 经评审 r1（`jev-plan-review-r1.md`）判「有条件通过」，用户第九轮拍板 Q34–Q35；v2 据此修订，处置表见 §11，变更记录见 §12。
> 输入：架构定稿 `jev-arch.md` v2（下称「架构稿」，坐标写 `arch §x`）、需求与拍板 `hygiene-flow.md`（Q1–Q35，第七至九轮优先；**Q33**：partial 下证据档生效；**Q34**：`classifiers` 为空列表 = off，非空但全部非法要提示；**Q35**：web 端改状态的 `/mem` 子命令需确认）、现状 `jev-current-state.md`、评审 `jev-arch-review-r1.md` / `-r2.md`、`AGENTS.md`、`docs/dev/memory/README.md`、`skills/dev-flow/`。
> 本方案只细化 arch §15 的 J0–J9，不改任何架构决策；实施层面落不了地或需要架构稿补字的地方集中在 §10「需回架构稿处理」（9 条，已由架构师在架构稿 v2.1 勘误）。
> 读者：主会话（调度）、各包 dev、verifier。每包一节，verifier 按「验收标准」出矩阵。
> **实施状态**（J9，2026-11-01）：J0–J9 全部合入 dev（HEAD `e59b272d`），全量测试绿。

## 0. 结论速览

| 项       | 结论                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 车道     | **L3**（>5 文件、跨模块、新 wire 面、外发数据、门禁可拦工具调用）；按 dev-flow L3：每包返回即派异源 verifier，全部通过后主会话收尾全量测试                                                                                               |
| 批次     | 7 批：B1 J0 → B2 {J1 ∥ J3} → B3 J2 → B4 J4 → B5 {J5 ∥ J6 ∥ J8} → B6 J7 → B7 J9（B7 前主会话做整合验证，见 §7）。评测基线 E0 与基线后小改动 E1 是主会话旁路任务，不阻塞任何批次（§3）                                                     |
| 关键路径 | J0 → J1 → J2 → J4 → J6 → J7 → J9（7 步串行；J3/J5/J8 在旁路）                                                                                                                                                                            |
| 与 §15   | 依赖图一致；细化两处：`src/memory/index.ts` 只有 J6、J7 两个写入方——`commandPort` 由 J6 接线，write 端口、doctor 端口与工具描述变体由 J7 接线；web 命令策略文件由 J4→J8 串行持有（§10 #3）                                               |
| 新增文件 | 全在 `src/memory/jev/`（除 `src/memory/secret-patterns.ts`、`skills/memory-jev/SKILL.md`、测试与评测资产）；除 `wire.ts`、`segment.ts` 外全部 pi-free                                                                                    |
| 金样本   | 新增 A′ `tests/fixtures/memory/jev-off-golden.json`（J0，永不重生）；B 级只刷新 `governance/activate-trace.json`（J6，必要时 J7）；契约 `memory-tool-surface.json` 只新增 key（J5）；tiered / legacy / doctor 三份 golden 预期逐字节不变 |
| 规模     | 合计约 新增 src 8.5k 行 + 测试 8k 行 + 数据/文档 1.5k 行；修改现有 src 约 600 行（明细见 §4 每包）                                                                                                                                       |

## 1. 全局约束（每个包的 prompt 原样带上）

### 1.1 Jev 是否接线：`jevWired`

- 判定函数 `resolveJevWiring(memory: MemorySettings, domainKind: "plain" | "secure" | "locked")`（J6 新建 `src/memory/jev/config.ts`，pi-free，纯函数）：
  - `on` ⇔ `memory.jev.enabled && memory.layout === "tiered" && memory.toolSurface === "v2" && domainKind === "plain" && memory.jev.classifiers.length > 0`；
  - 否则 `{ on: false, reason: "disabled" | "legacy" | "secure" | "empty-list" }`。
- `on:false` ⇒ `wireMemory` 的行为与今天逐字节相同：不调用 `wireJev`，**不向任何现有模块传 `jev` 端口**（arch §9.2）。
- `empty-list`（Q34）：`classifiers` 解析后为空 ⇒ 与总开关关闭等同，零调用部分与确定性部件也不生效，与今天逐字节一致。唯一例外：用户写了非空列表但**全部非法**被丢弃时，主会话启动提醒给一条英文 token 提示（J3 解析记录、J8 渲染、J7 接线），这是 Q34 明确要求的反馈，不在 off golden 的四个设置期配置内。
- `off(pi-api)`（ctx 上的 `modelRegistry` 缺 `classify`/`getAvailableOfType`/`getModelOfType`）只能在运行时得知：钩子已注册，但每个 handler 首行检查状态后直接返回，零注入、零 block、零调用；`/mem` 显示 `jev: off (pi-api)`（§10 #2）。该情形由 off golden 的第 5 个重放配置 `pi-api` 做逐字段比对证明（J0 录制，J6/J7 维护允许差异清单，见 J0 第 4 条）。
- **端口在场 = jev 开**：所有被改动的现有文件（`tool-v2.ts`、`command.ts`、`doctor.ts`、`doctor-command.ts`、`inject.ts`、`tidy/*.ts`）只新增一个可选依赖 `jev?: …`；`undefined` 时走原代码路径，不得产生任何新输出分支。这是 I9 的实现手法，J0 的 off golden 负责证明。

### 1.2 不变式落点（verifier 每包都查）

| 不变式 | 本项目要求                                                                                                                                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1     | 所有 deadline 经 `clampSpanMs`（`src/core/deadline.ts`）；长延时（探测计时器）用 `createSegmentedClock`（`src/core/clock.ts`）；外层 `withDeadline(+500ms)`                                                                                                                            |
| I2     | `src/index.ts` 只加参数与 `attach*` 调用，无逻辑                                                                                                                                                                                                                                       |
| I3     | jev 随 `wireMemory` 在 pre-guard 注册（子会话同样注册，由 `memory.jev.childSessions` 控制运行）；主会话专属（探测计时器、通知、批量打标、周期整理、写侧车、bashJobs 端口）在 handler 内按 `isChildSession` 分流                                                                        |
| I4     | 模块作用域零可变状态。仅两张进程级表：`Symbol.for("pi-subagent:memory-jev-health")`（≤32 项，TTL=隔离截止）、`Symbol.for("pi-subagent:memory-jev-bucket")`（30 次/60 秒）。其余缓存（条目索引、判定缓存、段记录、可用集缓存）都是 `wireJev` 闭包里的实例                               |
| I5     | 每个 `setTimeout`/`setInterval`、代理 socket 超时计时器都 `unref()`                                                                                                                                                                                                                    |
| I6     | 子会话不做：探测计时器、批量打标、周期整理、通知、写侧车（arch §8）                                                                                                                                                                                                                    |
| I7     | customType `subagent:memory-inject`、entry type `subagent:memory-recall`、Symbol 前缀 `pi-subagent:`、日志前缀 `[pi-subagent]`                                                                                                                                                         |
| I8     | `src/memory/jev/*.ts` 除 `wire.ts`、`segment.ts` 外全部 pi-free（不 import `@earendil-works/*`，类型也不行，因为它们是 pi-free 根）；需要 UI 的命令处理器用 `contracts.ts` 里的结构化接口 `MemCommandUiLike`。J1 把 glob 根加进 `tests/boundary/pi-free.test.ts`，后续新文件自动受约束 |
| I9     | 见 §1.1；`src/memory/settings.ts` 不新增 import（`tests/web-hub/boundary.test.ts:197` 白名单只许收紧）                                                                                                                                                                                 |
| I11    | `applySecureDomainOverrides` 强制 `memory.jev.enabled=false`（J3）+ `wireMemory` 收到非 plain 域不接线（J6）                                                                                                                                                                           |
| I12    | 机制写进工具描述变体（J5），策略写进 `skills/memory-jev/SKILL.md`（J5）                                                                                                                                                                                                                |

### 1.3 冻结面

- A 级永不改：`tests/fixtures/` 下 AGENTS.md「Frozen artifacts」A 行全部文件，外加 J0 生成后的 `tests/fixtures/memory/jev-off-golden.json`。
- B 级只在下表声明的包、以声明的理由刷新；其余包发现需要刷新 ⇒ **停下 `message_agent` 上报 root**，不得自改。

| 文件                                                                                                        | 允许改动的包                                      | 理由                                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `tests/fixtures/memory/jev-off-golden.json`                                                                 | J0（新建）                                        | A′，此后永不重生                                 |
| `tests/fixtures/governance/activate-trace.json`                                                             | J6（J7 仅当 phase2 因端口接线变化，需在报告说明） | memory jev hooks 注册                            |
| `tests/fixtures/memory-tool-surface.json`                                                                   | J5                                                | 只新增 jev 描述变体 key，旧 key 字节不变         |
| `tests/config/__corpus__/setting-specs-pin.json`                                                            | J3                                                | 追加 14 个 `memory.jev.*` spec                   |
| `tests/config/__corpus__/settings-corpus.json`                                                              | J3                                                | `DEFAULT_SETTINGS` 序列化变化（先例 `4758bae5`） |
| `tests/fixtures/memory-legacy-golden.json`、`memory/tiered-golden/*`、`memory/doctor-golden/current-5.json` | 无                                                | 预期不变；任何 diff 都是 bug                     |

- 每包自验必须包含 `git diff --stat origin/dev -- tests/fixtures/`，输出只能出现上表中属于本包的文件。

### 1.4 写包 prompt 通用段（主会话派单时原样附上）

- 文件域、允许新建范围、冻结面见本方案对应小节；**必须越界时停下用 `message_agent` 发给 root**，写明问题与默认做法，然后先推进其余部分。
- 禁用全树破坏性 git 命令：`git stash`（含 `-u`）、`git clean`、`git checkout -- .`、`git restore`、`git reset --hard`；需要基线对照用 `git show origin/dev:<path>`。
- dev 不 commit；verifier 通过后由主会话按精确路径 commit（禁止 `git add -A`），subject 形如 `feat(memory): [J4] jev sidecar index and /mem jev`。
- 长命令一律加 `timeout`；只跑定向测试，不跑全量。报告里每个数字必须来自真实命令输出。
- **自验收窄的理由**：arch §10 的每包门禁含 `tests/conformance` 与 `tests/governance`。本方案有意收窄为定向测试：只有 J6、J7 改注册（这两包的自验带 `tests/governance`），只有 J0 新增 conformance；conformance 套件依赖真实 `AgentSession`、耗时长，放到 §7 整合验证统一跑一次。
- 自验命令模板（每包在此基础上加定向文件）：

```sh
timeout 600 npx vitest run <本包测试文件…> tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts
timeout 600 npm run typecheck
timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/
```

## 2. 接口冻结总表（谁定义、谁先合入、谁消费）

> 规则：本节签名中出现、但下表没有单列冻结文件的命名类型，**一律由 J1 在 `src/memory/jev/contracts.ts` 定义**（只定义类型，实现在对应包）。例外只有两个：`GitRunner`（现有 `src/git/run.ts:36`，只读复用）与 `OffRecord`/`OffConfigName`（J0 测试辅助 `tests/memory/jev/helpers/off-harness.ts`）。

| 接口 / 类型                                                                                                                                                                                                        | 冻结文件                                                        | 定义包 | 消费包                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `MemEntry` `InlineMeta` `EntryHash` `EntryType` `Importance`                                                                                                                                                       | `jev/contracts.ts`                                              | J1     | J2–J8                                                                |
| `TagDef` `Taxonomy` `JevIndexV1` `EntryTags` `ReviewState` `ReviewSuggestion` `DismissedPair`                                                                                                                      | `jev/contracts.ts`                                              | J1     | J2、J4–J8                                                            |
| `JevQuestion` `JevAnswer` `ClassifierRegistryLike` `FetchLike` `JsonObject`                                                                                                                                        | `jev/contracts.ts`                                              | J1     | J0 评测脚本对照、J2                                                  |
| `JevDuty` `JevRequest` `JevOutcome` `JevClient` `JevStatus` `JevStatusReason` `JevUsage`                                                                                                                           | `jev/contracts.ts`                                              | J1     | J2、J4–J7                                                            |
| `JevConfig`（从 `MemorySettings.jev` 映射出的纯配置）                                                                                                                                                              | `jev/contracts.ts`                                              | J1     | J2、J6                                                               |
| `InjectLayer` `MemoryInjectDetailsV1` `MemoryRecallEntryV1` 与两个 customType 常量                                                                                                                                 | `jev/contracts.ts`                                              | J1     | J6、J7、J9（web）                                                    |
| `GateDecision` `GateCandidate` `GateEvidence` `VerdictKey`                                                                                                                                                         | `jev/contracts.ts`                                              | J1     | J2、J7                                                               |
| 端口 `JevWritePort` `JevCommandPort` `JevDoctorPort` `JevBashJobsPort` `JevRenderInfo` `MemCommandUiLike`                                                                                                          | `jev/contracts.ts`                                              | J1     | J4–J8                                                                |
| 常量（候选上限 360、批 12,000 token、判定缓存 64/10min、段上限 30、健康表 32、令牌桶 30/60s、侧车 2000/1MB、标签 64、`/proc` 4096/2s）                                                                             | `jev/contracts.ts`                                              | J1     | 全部                                                                 |
| 无名类型补登：`TagDefInput` `TaxonomyFileV1` `ReviewSuggestionView` `IndexPatch` `BulkResult` `NotifyKind` `HealthTable` `TokenBucket` `JevReportView` `RedactField` `SimpleCommand` `EffectiveMeta` `ExpiredKind` | `jev/contracts.ts`（类型）                                      | J1     | J2、J4–J8                                                            |
| `expiredEntries(entries, today)` / `untilEntries(entries)`（到期判定纯函数，r1 #3）                                                                                                                                | `jev/entries.ts`                                                | J1     | J6（`doctorPort.extraReminder` 的到期数）、J8（D17、`/mem expired`） |
| `GitRunner`                                                                                                                                                                                                        | `src/git/run.ts`（现有）                                        | —      | J7                                                                   |
| `OffRecord` `OffConfigName` `recordMemoryOff` `PI_API_ALLOWED_DIFF`                                                                                                                                                | `tests/memory/jev/helpers/off-harness.ts`、`off-golden.test.ts` | J0     | J6、J7（只扩充允许差异清单）                                         |
| `MemorySettings.jev: MemoryJevSettings`（含 `classifiersRejected`）                                                                                                                                                | `src/memory/settings.ts`                                        | J3     | J6（映射为 `JevConfig`）、J7（启动提醒提示）                         |
| `createJevClient` / `classifyError` / `createProxyFetch` / `build*Questions` / `decide*`                                                                                                                           | `jev/{client,health,proxy-fetch,questions,decide}.ts`           | J2     | J4–J7                                                                |
| `readIndex` / `writeIndexPatch` / `tagOne` / `tagBulk` / `runReviewPass` / `createJevCommandPort`                                                                                                                  | `jev/{index-store,tagging,review,command-port}.ts`              | J4     | J5–J8                                                                |
| `resolveJevWiring` / `wireJev` 返回值 `{ commandPort, writePort?, doctorPort, attachBashJobs }`                                                                                                                    | `jev/{config,wire}.ts`                                          | J6     | J7                                                                   |

关键签名（J1 落在 `contracts.ts`，下游不得改形状；需要加字段 ⇒ 上报 root，由主会话在 contracts 追加可选字段并单独 commit）：

```ts
export interface JevConfig {
  readonly classifiers: readonly string[]; // provider/id，已去重保序
  readonly proxy: string; // "" = 不传 fetch
  readonly childSessions: boolean;
  readonly recall: { threshold: number; maxEntries: number; maxBytes: number; waitMs: number };
  readonly gate: { enabled: boolean; threshold: number };
  readonly reviewIntervalDays: number;
  readonly maxCostUsd: number;
  readonly maxCalls: number;
  readonly confirmTimeoutMs: number;
}

export type JevStatus =
  | { kind: "off"; reason: "disabled" | "secure" | "legacy" | "pi-api" | "empty-list" }
  | { kind: "probing" }
  | { kind: "full"; model: string }
  | { kind: "partial"; reason: string; retryAt?: number; inactive: boolean };

export interface JevWritePort {
  /** 写入提交后、锁外调用；永不 reject；返回回显行与 usage（C-J12 决定 usage 放哪个字段）。 */
  afterWrite(input: {
    cwd: string;
    file: string;
    before: string | undefined;
    after: string;
    signal?: AbortSignal;
    registry: ClassifierRegistryLike | undefined;
  }): Promise<{ echo: readonly string[]; usage?: { costUsd: number; calls: number } }>;
  /** 写前同步校验：新引入的行内注释错误 ⇒ 返回错误文本（拒写）。 */
  checkInline(file: string, before: string | undefined, after: string): string | undefined;
  /** 用户令守卫：返回被删改的 user 条目（guardHash 配对，arch §6.2.5 / v4.1 §3.2）。 */
  touchedUserEntries(file: string, before: string, after: string, handWritten: boolean): readonly MemEntry[];
  readonly confirmTimeoutMs: number;
}

export interface JevCommandPort {
  statusLine(cwd: string): string; // `/mem` 默认 list 追加的一行
  report(cwd: string, registry: ClassifierRegistryLike | undefined): Promise<string>; // `/mem jev`
  probe(registry: ClassifierRegistryLike | undefined): Promise<string>;
  retag(cwd: string, all: boolean, registry: ClassifierRegistryLike | undefined): Promise<string>;
  resetIndex(cwd: string): Promise<string>;
  tags: {
    list(cwd: string): string;
    add(cwd: string, def: TagDefInput): Promise<string>;
    remove(cwd: string, id: string): Promise<string>;
    setEnabled(cwd: string, id: string, enabled: boolean): Promise<string>;
  };
  review: {
    list(cwd: string): readonly ReviewSuggestionView[]; // 含 stale 标记
    run(cwd: string, registry: ClassifierRegistryLike | undefined): Promise<string>;
    dismiss(cwd: string, id: string): Promise<void>;
    resolve(cwd: string, id: string): Promise<void>;
  };
  readonly isChildSession: boolean;
}

export interface JevDoctorPort {
  /** D17–D19 开关 + 启动提醒追加项（到期数、core 用量、待审建议数、Jev 状态）。 */
  extraReminder(cwd: string): readonly string[];
}

export interface JevBashJobsPort {
  list(): readonly { id: string; status: string; command: string; startedAt: number }[];
}

export interface JevRenderInfo {
  readonly primary?: string; // primary core 文件名
  readonly omittedSections: readonly string[]; // 取自 TieredRenderResult.omittedSections
  readonly coreInlined: boolean;
}
```

## 3. 批次与关键路径

```text
B1  J0 基线（测试/golden/conformance/评测脚本）        旁路 E0：主会话跑评测基线与 C-J15（凭证可用时；J9 前完成）
     │
B2  J1 纯域 ───────────────┐        J3 设置与 secure（∥ J1）
     │                     │          │
B3  J2 引擎 ◄──────────────┘          │
     │                                │
B4  J4 侧车/打标/命令 ◄───────────────┘（J4 需要 J2 + J3）
     │
B5  J5 写入路径 ∥ J6 召回运行时 ∥ J8 整理与到期   （三包文件域互不相交，见 §6 spec）
     │              │                 │
B6               J7 门禁 + 端口生产接线 ◄─ J5、J6、J8 全部合入
                    │
—— 主会话整合验证（§7：全量测试、build、fixtures diff）——
B7               J9 收尾（文档、e2e、web 紧凑分支、AGENTS.md 清单）

旁路 E1（主会话，E0 之后、J9 之前）：若基线建议改阈值默认值或加 openrouter 项 ⇒ 回架构稿 + ask_user ⇒ 改 settings.ts 默认值、重 pin 两份 corpus，单独 commit
```

- 关键路径：J0 → J1 → J2 → J4 → J6 → J7 → J9。J6 是最大包，派最强开发模型。
- J3 只等 J0 合入（不等基线），只阻塞 J4（设置类型）与 J6（映射）；J5、J8 不在关键路径，但 J7 需等它们合入后才能接线。
- E0、E1 不在关键路径：凭证不可用时 E0 可以一直推迟到 J9 之前；E1 若触发，只改默认值与 corpus，不影响已合入包的接口。
- **L3 流程闸门由主会话负责**（dev-flow）：本方案经评审与用户确认（HARD GATE）后才开派 B1；开派前 `TaskCreate` 建 todo，每包一条（`blockedBy` 按本节批次），另建 E0、E1、§7 整合验证、§8 真机验收、§10 架构稿勘误核对各一条；todo 只在核实结果后标 completed。
- 每包返回立即派 verifier；B5 三包任一被打回只重派该包，J7 等三包都通过再开工。

| 包  | 名称           | 新增 src          | 修改 src              | 新增测试 | 备注                                         |
| --- | -------------- | ----------------- | --------------------- | -------- | -------------------------------------------- |
| J0  | 基线           | 0                 | 0                     | ~900     | + golden JSON、评测集 ~400 行数据、脚本 ~350 |
| J1  | 纯域           | ~1,600            | ~40（doctor.ts 搬家） | ~1,400   | shell-parse 表驱动 ≥60 例                    |
| J2  | 引擎           | ~1,300            | 0                     | ~1,300   | 含假代理/假上游服务器                        |
| J3  | 设置与 secure  | ~140              | ~30                   | ~150     | + 两份 corpus 重 pin                         |
| J4  | 侧车/打标/命令 | ~950              | ~120                  | ~900     |                                              |
| J5  | 写入路径       | ~350              | ~180                  | ~650     | + skill ~120                                 |
| J6  | 召回运行时     | ~1,400            | ~80                   | ~1,300   | 最大、最难                                   |
| J7  | 门禁 + 接线    | ~650              | ~60                   | ~800     |                                              |
| J8  | 整理与到期     | ~800              | ~150                  | ~750     |                                              |
| J9  | 收尾           | ~120（web，可选） | ~10                   | ~300     | + 文档 ~400                                  |

## 4. 包详述

---

### J0 · 基线（只加测试、golden、conformance 与评测脚本）

1. **目标**：在**未改动的 dev** 上钉住 off 行为（A′ golden），用 conformance 钉住 pi 行为前提（C-J1–C-J15），交付评测脚本与数据集（基线由主会话在旁路任务 E0 中跑，不属于 J0 验收）。架构坐标：arch §9.2、§10、§5.2（默认列表 #8）、§4.5。
2. **文件域**：
   - 新建：`tests/memory/jev/off-golden.test.ts`、`tests/memory/jev/helpers/off-harness.ts`、`tests/fixtures/memory/jev-off-golden.json`、`tests/conformance/memory-jev-channels.test.ts`、`scripts/dev/jev-eval.mjs`、`docs/dev/memory/eval/jev-recall.json`、`jev-gate.json`、`jev-tag.json`、`jev-review.json`。（`docs/dev/memory/eval/jev-baseline.md` 由主会话在 E0 中新建，不属于 J0。）
   - 禁止：`src/**` 任何文件；`tests/fixtures/` 除新建的那一个文件外全部；`package.json`。
3. **依赖**：无。单独成批（B1）。
4. **接口契约**：
   - `off-harness.ts` 导出 `recordMemoryOff(config: OffConfigName): OffRecord`，下游 J6/J7 的 wire 测试可复用它的 fake pi（`recordingPi()`、`fakeHub()`）。
   - `OffConfigName = "disabled" | "legacy-layout" | "legacy-tool" | "secure-sim" | "pi-api"`。五种配置在 dev 上各自录一份（legacy 的输出本来就和 tiered 不同，所以按配置分段，不是一份共用）：
     - `disabled`：`parseMemorySettings({ jev: { enabled: false } })`；
     - `legacy-layout`：`{ layout: "legacy", jev: { enabled: true } }`；
     - `legacy-tool`：`{ toolSurface: "legacy", jev: { enabled: true } }`；
     - `secure-sim`：默认设置 + `jev.enabled=true`，`wireMemory` 额外传 `{ secureDomainKind: "secure" }`（dev 上用 `as never` 传入、被忽略；J6 之后生效）；
     - `pi-api`（r1 #5）：默认设置 + `jev.enabled=true` + plain 域，fake pi 与 fake ctx **都没有 `modelRegistry`**。dev 上它与 `disabled` 的录制结果相同。
   - 前四种配置的断言是「录制 = golden」逐字节相等。`pi-api` 的断言是逐字段比对加允许差异清单 `PI_API_ALLOWED_DIFF`（导出自 `off-golden.test.ts`，J0 写成空清单）：
     - `render`、`doctor`、`tidyPrompt` 三个字段必须与 golden 逐字节相等（fixture 无行内注释、primary 已有 D02，D17–D19 不会出现）；
     - `registrations`：golden 序列必须是实际序列的子序列；多出的项只能是清单里声明的 jev 注册名，`memory` 工具只允许描述换成 `MEMORY_TOOL_V2_TEXT_JEV`（J6 填注册名，J7 填描述变体）；
     - `command`：只允许 `/mem`、`/mem list` 末尾多一行 `jev: off (pi-api)`、补全多出 `jev`/`tags`/`review`/`expired`（J6 填状态行，J8 合入后由 J7 填补全）；
     - `tool`、`reminder`：只允许确定性部件的声明差异（append 写入 `updated`/`source: agent`；回显 `jev: not tagged (off: pi-api)`；启动提醒的 jev 追加行）（J7 接线时填）。
     - 清单之外的任何差异都让测试失败。清单只许追加，每次追加在 commit message 写明理由。
   - golden JSON 结构：`{ baseline: <dev HEAD sha>, cases: Record<OffConfigName, OffRecord> }`；`OffRecord` 含：
     - `registrations`：fake pi 上 `on/registerTool/registerCommand/registerMessageRenderer/events.on` 的有序调用（工具记录 name + description + promptSnippet + promptGuidelines + `canonicalJson(parameters)`）；hub `sections.register` 的名字；
     - `render`：`current-5` 与一个合成 core（`tests/fixtures/memory/synthetic/`，不含 `<!-- mem`）在主会话、子会话下 section provider 的输出；
     - `tool`：固定脚本（view 目录、view 文件 + section、create、str_replace、insert、append（legacy 别名）、delete、rename、search、write 别名）的逐步输出文本和每步之后的目录文件字节（`updated:` 日期、trash id、绝对路径做确定性掩码）；
     - `command`：`/mem`、`/mem list`、`/mem doctor`、`/mem path` 的 notify 文本；`getArgumentCompletions` 对 `""`、`"t"`、`"tidy "`、`"restore "`、`"j"`、`"r"` 的结果；
     - `doctor`：`collectDoctorFindings` + `formatDoctorReport` 文本；
     - `reminder`：`session_start`（hasUI、主会话）时启动提醒的 notify 序列；
     - `tidyPrompt`：`buildTidyPrompt` 对 current-5 的输出。
   - 生成闸：`UPDATE_JEV_OFF_GOLDEN=1` 且文件不存在才写；文件已存在时测试直接 fail（照 `tests/memory/legacy-golden.test.ts:55-66`）。
5. **验收标准**：
   - [ ] `git diff --stat origin/dev -- src package.json` 为空；golden 的 `baseline` 等于生成时的 `git rev-parse HEAD`。
   - [ ] off-golden 测试在 dev 上五个配置全绿（`pi-api` 在 dev 上与 `disabled` 逐字段相同）；人为改一个字节（本地试验后还原）会红。
   - [ ] golden 里 `grep -c "<!-- mem"` 为 0；路径、时间戳已掩码，换机器重跑稳定（连跑 3 次一致）。
   - [ ] conformance 文件里不依赖网络的项全绿；依赖凭证/网络的项在未设 `PI_TOOLKIT_JEV_CONFORMANCE=1` 时 `skip` 且说明原因。
   - [ ] `node scripts/dev/jev-eval.mjs --help` 与 `--dry-run --set recall` 无网络运行成功（后者打印第一批问题 JSON）。
   - [ ] 四个评测集条数：召回 40（含指代型消息、core 重复注入反例）、门禁 24（含 `git checkout -b`、`git stash` 正例与 `echo "git commit"` 干扰）、打标 30、整理 20 对；全部经过人工脱敏（无 token、邮箱、内网地址）。
6. **测试清单**：
   - `tests/memory/jev/off-golden.test.ts`：四个设置期 off 配置各一例「录制 = golden」；`pi-api` 一例「逐字段比对 + `PI_API_ALLOWED_DIFF`」；一例「生成闸拒绝覆盖」。
   - `tests/conformance/memory-jev-channels.test.ts`（真实 `AgentSession`，复用 `tests/conformance/agent-session-harness.ts`）：

| 编号  | 断言（一句话）                                                                                                                            | 门控                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| C-J1  | `before_agent_start` handler 被 await；返回的 `message` 位于用户消息之后、第一次 LLM 请求可见；handler 抛错被吞                           | 离线                       |
| C-J2  | `tool_call` 返回 block ⇒ 工具不执行、模型收到 isError 结果、`tool_result` 不触发；handler 抛错的后果（记录现状）                          | 离线                       |
| C-J3  | 同一 assistant 消息里两个工具调用时 `tool_call` 的派发顺序与并发性（记录现状）                                                            | 离线                       |
| C-J4  | `tool_call` 内 `sendMessage(…, {triggerTurn:false})` 落在本 turn 工具结果之后、下一次 LLM 调用可见、不起额外一轮                          | 离线                       |
| C-J5  | `tool_result` 事件带 `input`、`isError`；内置 bash 带 `structuredContent.exit_code`                                                       | 离线                       |
| C-J6  | `bash-job:notification` 两种到达方式（空闲 → `before_agent_start` custom；streaming → `message_start`）的落点                             | 离线                       |
| C-J7  | `ctx.modelRegistry` 在 tool/command/event ctx 上的可用性与三个方法签名（类型级 + 假 registry）；真实调用时 `fetch` 透传、abort 生效       | 类型级离线；真实调用需门控 |
| C-J8  | 错误文本格式 `<Provider> API error (<status>): …`；上下文超限的真实措辞                                                                   | 门控                       |
| C-J9  | skill 展开块在 `event.prompt` 中的格式（剥离规则依据）                                                                                    | 离线                       |
| C-J10 | 子会话 compaction / switch 产生的条目与 `turn_end` 检查点                                                                                 | 离线                       |
| C-J11 | 嵌套 `ctx.executeTool` 也经过 `tool_call`/`tool_result`                                                                                   | 离线                       |
| C-J12 | 工具结果携带模型 usage 的字段与展示（定 `JevWritePort.afterWrite` 的 usage 落点）                                                         | 离线                       |
| C-J13 | `registerMessageRenderer` 对 `subagent:memory-inject` 的渲染调用与折叠行为                                                                | 离线                       |
| C-J14 | `ctx.ui.setEditorText` 在命令 ctx 中可用                                                                                                  | 离线                       |
| C-J15 | opencode / openrouter 上 `jev-1.13-free`、`jev-1.13`、`typesafe/jev-1.13`、`typesafe/jev-1.14` 能否被 `getModelOfType` 找到、能否实际调用 | 门控                       |

- 门控变量：`PI_TOOLKIT_JEV_CONFORMANCE=1`（可配 `PI_TOOLKIT_JEV_PROXY=http://…`），照 `droid-protocol.test.ts` 的自门控写法。
- 无金样本刷新（只新建 A′）。

7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts tests/conformance/memory-jev-channels.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
node scripts/dev/jev-eval.mjs --help && node scripts/dev/jev-eval.mjs --dry-run --set recall | head -40
git diff --stat origin/dev -- src package.json tests/fixtures/
```

8. **风险 / 问父 agent**：
   - fake pi 漏录某个注册面 ⇒ off 证明有洞。拿不准哪些 pi 方法会被调用时，用 Proxy 记录全部属性访问。
   - conformance 某项现状与 arch 假设相反（如 C-J4 的落点）⇒ 不改测试去迁就，**原样记录并上报 root**，主会话决定是否回架构稿。
   - 评测需要真实凭证与代理：dev 只交付脚本与数据；`jev-baseline.md` 由主会话在 E0 运行填写（§3），不阻塞 J1/J3。
   - `.mjs` 脚本要内联问题模板；J2 会加一条一致性测试对照 `questions.ts`，所以模板构造函数需 `export`。

---

### J1 · 纯域

1. **目标**：落地全部不依赖 pi 的基础模块：契约、条目切分、标签体系、脱敏、shell 解析、匹配、用户令守卫、文案。架构坐标：arch §3.1、§4.1–§4.3、§6.2.4 文案、§6.4.2 点名程序、§6.4.4/§6.4.5 文案、§7.1、§9.4。
2. **文件域**：
   - 新建：`src/memory/jev/contracts.ts`、`entries.ts`、`taxonomy.ts`、`redact.ts`、`shell-parse.ts`、`match.ts`、`guard.ts`、`format.ts`；`src/memory/secret-patterns.ts`；测试 `tests/memory/jev/{entries,taxonomy,redact,shell-parse,match,guard,format,contracts}.test.ts`、`tests/memory/secret-patterns.test.ts`。
   - 修改：`src/memory/doctor.ts`（**只**把 `SECRET_PATTERNS` 与 `findSecrets` 搬到 `secret-patterns.ts` 并改为 import，纯搬家）；`tests/boundary/pi-free.test.ts`（新增根）。
   - 禁止：`src/memory/` 其它现有文件、`src/memory/settings.ts`（J3 持有）、全部 fixtures。
3. **依赖**：blockedBy J0。与 J3 同批（B2）并行，文件域不相交。
4. **接口契约**（`contracts.ts` 冻结，见 §2；以下为各模块导出）：
   - `entries.ts`：`splitEntries(file: string, raw: string, fileInfo: { status: "active" | "stale"; handWritten: boolean }): MemEntry[]`；`normalizeBody(s)`；`entryHash(body): EntryHash`；`parseInlineMeta(line): { meta: InlineMeta; errors: string[] }`；`stripInlineMeta(text): string`；`expiredEntries(entries: readonly MemEntry[], today: string): readonly MemEntry[]`（`inline.expires` 早于 `today`（`YYYY-MM-DD`，本地日期）即到期；`expires` 当天仍有效）；`untilEntries(entries): readonly MemEntry[]`（只写了 `until`、没有 `expires`）；`class EntryIndex { constructor(readFile?: …); get(dir: string): readonly MemEntry[]; invalidate(dir?: string): void }`（指纹 = name+size+mtime，只重切变化的文件；实例由 wire 持有，I4）。
   - `taxonomy.ts`：`ENTRY_TYPES`、`IMPORTANCE_LABELS`、`PRESET_TAGS`（arch §4.3.2 的 22 个，J1 定稿 description）；`mergeTaxonomy(file?: TaxonomyFileV1): Taxonomy`；`validateTagDef(input): { ok: true; def } | { ok: false; error }`；`taxonomyRev(tags)`；`tagCriteria(tag): JevQuestion`。
   - `redact.ts`：`redactForJev(text: string, field: RedactField): string`（`RedactField = "user" | "previousUser" | "command" | "error" | "entry" | "running" | "staged"`，先匹配后截断，arch §7.1 表）。
   - `shell-parse.ts`：`parseShell(cmd: string): { ok: boolean; commands: readonly SimpleCommand[] }`；`programIdentity(argv): string`（解释器取脚本名）——照搬 `hygiene-plan.md` §2.7.1 全部规则（8KB 截断、深度 ≤2、永不抛错）。
   - `match.ts`：`matchTags(call: { tool: string; input: unknown; parsed?: … }, tax: Taxonomy): readonly string[]`；`matchCommandPattern(pattern, cmd)`；`globMatch(glob, path)`；`lexicalScore(query, text)`；`prefilter<T>(items, query, n, tieBreak)`；`namedPrograms(body): readonly string[]`（剔除通用程序表，arch §6.4.2）。
   - `guard.ts`：`touchedUserEntries(before, after, handWritten): MemEntry[]`（guardHash 多重集合配对，v4.1 §3.2 三例）。
   - `format.ts`：`formatInjectMessage(layer, items, opts)`、`formatInjectMarker(…)`（含 `·partial`）、`formatGateReason(kind: "once" | "hold" | "hold-evidence", …)`、`formatUnjudged(…)`、`formatWriteEcho(…)`、`formatStatusLine(status, coverage)`、`formatJevReport(view)`。文案与 arch §5.3 通知表、§6.1.6、§6.2.4、§6.4.4、§6.4.5、§9.4 逐字一致（UI 英文 token、中文只在散文块，AGENTS.md「UI text language split」）。
   - `secret-patterns.ts`：`export const SECRET_PATTERNS`、`export function findSecrets(text)`、`export function looksSecret(text): boolean`（加宽松键值规则，arch §4.1 `secret` 字段）。
5. **验收标准**：
   - [ ] arch §4.1 切分规则 1–5 全覆盖（列表项 + 续行、整段条目、未缩进 GFM 表格整表、引用块、HTML 块、≥40 码点段落独立、短段并入下一条），规则写进 `contracts.ts` 注释。
   - [ ] `hash` 只哈希 body（改行内注释不变）、`guardHash` 哈希 raw（改 `user` 标记会变）。
   - [ ] `parseInlineMeta` 对任意输入不抛错（种子属性测试 ≥500 例）；`stripInlineMeta` 幂等；未知键、重复键、`expires` 非法日期、超 200B 均进 `errors`。
   - [ ] 默认归属：手写文件 ⇒ user，agent 文件 ⇒ agent，行内覆盖优先。
   - [ ] `expiredEntries`：`expires` 早于 today 才算到期、当天不算、非法日期不算（进 `inlineErrors`）；`untilEntries` 不含同时写了 `expires` 的条目。
   - [ ] `EntryIndex` 指纹不变不重读（计数断言）；单文件变化只重切该文件；`secret`、`namedPrograms` 随之重算。
   - [ ] 标签：22 个预置、启用上限 64、`rev` 只随 description 变化、预置可停用不可删、id 正则。
   - [ ] 脱敏：arch §7.1 每条规则一例 + 截断表每个字段一例；进程命令行 token 掩码（D7 条件 ①）。
   - [ ] shell-parse 表驱动 ≥60 例（`git -C x push` 命中、`echo "git push"` 不中、`FOO=1 git push`、`cd x && git commit`、`bash -c`、heredoc、解释器取脚本名）+ 随机字节模糊不抛错。
   - [ ] doctor 搬家后 `tests/memory/doctor.test.ts`（含 doctor golden）原样全绿，`git diff origin/dev -- tests/fixtures/` 为空。
   - [ ] `tests/boundary/pi-free.test.ts` 新增一例：根 = `globSync("src/memory/jev/*.ts")` 去掉 `wire.ts`、`segment.ts`，加 `src/memory/secret-patterns.ts`；全绿。
6. **测试清单**：
   - `entries.test.ts`：切分（列表、续行、围栏、表格、引用块、HTML 块、短段并入、`### ` 拼接 heading、`section` 记录与文件头 `""`）；两种哈希；行内注释位置（首行行尾 / 标题下首个非空行）；归属；`EntryIndex` 缓存与失效；`secret`/`namedPrograms` 计算；`expiredEntries`/`untilEntries` 边界（前一天、当天、后一天、非法日期、只有 until）。
   - `taxonomy.test.ts`：合并、停用、上限、校验错误、rev 稳定性、criteria 形状。
   - `redact.test.ts`：每条规则、`$HOME→~`、ANSI/C0 去除、8KB 窗口、截断（含尾部截断「首个错误行优先」）。
   - `shell-parse.test.ts`：≥60 表驱动 + 模糊。
   - `match.test.ts`：命令前缀、glob（含 `**`、`*release*.sh`）、tool 匹配、词面预筛（ASCII + CJK 二元组，同分用户令优先）、`namedPrograms`（`release.sh` 入、`git` 不入）。
   - `guard.test.ts`：顶部插行不触发、改一个字触发、删重复行之一触发。
   - `format.test.ts`：每段文案逐字比对 arch 原文。
   - `secret-patterns.test.ts`：与 D13 同源（同一组样本 doctor 与 `looksSecret` 结论一致）。
   - 无 C-J；无金样本刷新。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/jev tests/memory/secret-patterns.test.ts tests/memory/doctor.test.ts tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/
```

8. **风险 / 问父 agent**：
   - 预置标签 description 定稿（措辞即 criteria）：先照 arch §4.3.2 要点写中英双语，J0 基线若显示某标签召回差，主会话再调。
   - 「短段（<40 码点）并入下一个条目」在文件末尾没有下一个条目时怎么办 ⇒ 默认并入上一个条目，写进注释并上报。
   - `format.ts` 的 `/mem jev` 报告需要的数据形状（`JevReportView`）先在 contracts 定义；J4 实现时若不够用，上报 root 追加可选字段。

---

### J2 · 引擎

1. **目标**：Jev 客户端（故障转移、错误分级、预算、令牌桶、分批）、可用性状态机与通知判定、专用代理 fetch、六类问题构造、全部决策纯函数（含判定缓存与证据档）。架构坐标：arch §5.1–§5.5、§6.1.1/§6.1.4 决定、§6.2.2、§6.3.3、§6.4.3–§6.4.5、§4.4 有效元数据。
2. **文件域**：
   - 新建：`src/memory/jev/client.ts`、`health.ts`、`proxy-fetch.ts`、`questions.ts`、`decide.ts`；测试 `tests/memory/jev/{client,health,proxy-fetch,questions,decide,questions-eval-parity}.test.ts`、`tests/memory/jev/helpers/fake-registry.ts`、`tests/memory/jev/helpers/fake-proxy.ts`。
   - 禁止：J1 文件（只读；发现缺口上报）、`src/memory/` 其它文件、fixtures。
3. **依赖**：blockedBy J1。单独成批（B3）。不依赖 J3（`JevConfig` 在 J1 contracts）。
4. **接口契约**：
   - `client.ts`：`createJevClient(deps: { config: JevConfig; isChild: boolean; now: () => number; health?: HealthTable; bucket?: TokenBucket; makeFetch?: (proxy: string) => FetchLike | undefined; log?: (line: string) => void }): JevClient & { usage(): JevUsage; onStatusChange(cb: (prev: JevStatus, next: JevStatus) => void): () => void; abortBackground(): void; markInactive(inactive: boolean): void }`。`ask` 永不 reject；sync 最多 3 批并行、background 最多 4；可用集缓存 10 分钟，`probe()` 强制刷新；每档超时 `min(剩余, max(1000, ⌈budget/2⌉))`。
   - `health.ts`：`classifyError(msg: string): "unavailable" | "transient" | "context"`（`API error (` 字面量取码；关键词兜底；`proxy error:` 优先瞬态）；`getHealthTable(): HealthTable`（进程级 Symbol 表，≤32）；`clearHealthTable()`（`/reload` 调用）；`createTokenBucket()`（进程级）；`summarizeStatus(input): JevStatus`；`notifyFor(prev, next, ctx: { firstFullNotified: boolean; notifiedPartialReasons: Set<string>; hasCredentials: boolean }): NotifyKind | undefined`；`coverage(entries, index): { tagged: number; total: number; pending: number }`。
   - `proxy-fetch.ts`：`parseProxyUrl(s)`、`createProxyFetch(proxy, opts?): FetchLike`、`redactProxyUrl(s)`——只用 `node:http`/`node:tls`/`node:net`，照搬 `hygiene-plan.md` §2.4.1「代理」格的实现约束。
   - `questions.ts`：`estimateTokens(q)`、`splitBatches(state, questions, cap = 12_000)`、`buildRecallQuestions({ userMessage, previousUserMessage?, session, today, candidates })`、`buildErrorQuestions(...)`、`buildTagQuestions(entry, taxonomy, compare)`（5×`m_*` + ≤64×`t_*` + ≤20×`c*`）、`buildTagMajorQuestions(tag, entries)`、`buildReviewQuestions(pairs, staleCands)`、`buildGateQuestions(state, guardEntries)`；问题 id 规则写注释（`e<n>`、`m_*`、`t_<id>`、`c<n>`、`p<n>`、`o<n>`、`g<n>`）。
   - `decide.ts`：`effectiveMeta(entry, tags, taxonomy)`；`decideRecall(answers, cands, cfg)`；`decideErrorRecall(...)`（前 2）；`decideTagging(answers, taxonomy, model, now): EntryTags`（只存 p≥0.3）；`decideGate({ a, v, hold, latched, threshold }): GateDecision`；`evidenceTier(cands, running): GateDecision[]`；`createVerdictCache(now)`（64 项、10 分钟、`clear()`）；`verdictKey(entryHash, evidence, shape)`；`strictest(decisions)`；`decideReview(answers, pairs)`。
5. **验收标准**：
   - [ ] 同一次 `ask` 内 `451 → 402 → 成功`：前两档各隔离 1h，返回 ok，model 为第三档（arch §5.2 实测形状，错误文本照搬 `System One API error (451): …`）。
   - [ ] 瞬态逐模型熔断：连续 3 次隔离 10 分钟，其它档不受影响；成功清零；到期回 `unknown`（fake clock）。
   - [ ] context 类：拆半重试一次，不计熔断。漏答进 `missing`。
   - [ ] 整列不可用 ⇒ `{ok:false, reason:"all-failed"}` 且状态 `partial`；预算（美元/次数）耗尽 ⇒ `partial(budget)`，之后零调用。
   - [ ] `status()` 同步零 IO；`partial` 时 `ask` 立即返回不发请求（只有到 `until` 的模型会被真调）。
   - [ ] 子会话令牌桶 30/60s 进程级共享；健康表跨 client 实例共享、`clearHealthTable` 清空。
   - [ ] 通知判定：首次 `full` 每 activation 一次；`full→partial` 同原因一次；`partial→full` 每次；启动即 partial 且有凭证通知一次；`inactive`（全部 no-auth/not-found）不通知。
   - [ ] 代理 12 例（`hygiene-plan.md` P5b ①–⑫）+ URL 表驱动全绿；无悬挂 socket（测试结束 `process._getActiveHandles` 不增）。
   - [ ] 分批：边界恰好 12,000 / 12,001 token；`previous_user_message` 600 码点截断、脱敏、剥 skill 块。
   - [ ] 门禁判定表四行自上而下；证据档两行；判定缓存：同指纹命中不调 Jev、指纹变化重判、`clear()` 后重判、第 65 项淘汰最旧、10 分钟过期；多条命中取最严。
   - [ ] `effectiveMeta`：侧车 p≥0.6 ∪ 行内 `+` − 行内 `-`；`guarded`、`hold` 规则与 arch §4.4 一致；pending 条目只有行内 tags 时按 p=1、重要度 2。
   - [ ] 所有计时器 `unref`、所有时长经 `clampSpanMs`（grep 自查结果贴报告）。
6. **测试清单**：
   - `client.test.ts`：链式故障转移、隔离到期、context 拆批、漏答、预算/次数、令牌桶、sync/background 并发上限、abort、永不 reject、`probe` 刷新可用集、可用集 10 分钟缓存、`makeFetch` 只在 proxy 非空时传入 `fetch`。
   - `health.test.ts`：错误分级表（401/402/403/451/429/500/503/超时/`proxy error:`/无码关键词/无码无关键词）；状态汇总四态 + `inactive`；通知判定全表；覆盖率。
   - `proxy-fetch.test.ts`：12 例 + URL 表（`https://`、`socks5://`、乱码 ⇒ 未配置）。
   - `questions.test.ts`：六类问题形状、分批边界、截断与脱敏调用、id 规则。
   - `questions-eval-parity.test.ts`：`scripts/dev/jev-eval.mjs` 导出的模板构造器与 `questions.ts` 对同一输入产出相同 `questions`。
   - `decide.test.ts`：阈值 0.69/0.70、top-k 与字节预算、同分排序（用户令 > 重要度 > 文件名）、门禁表、证据档、判定缓存、最严合并、打标落盘过滤。
   - C-J：消费 C-J7/C-J8 的结论（错误措辞）；如 C-J8 记录的上下文超限措辞与 arch 不同，按 C-J8 实测写关键词。无金样本刷新。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/jev tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
grep -n "setTimeout\|setInterval" src/memory/jev/*.ts   # 每处旁边必须有 unref
git diff --stat origin/dev -- tests/fixtures/
```

8. **风险 / 问父 agent**：
   - C-J8 门控未跑（无凭证）时上下文超限措辞未知 ⇒ 先用 arch 列的三个关键词，报告里列为遗留。
   - 美元成本来自 `usage.cost.total`，模型无价格时为 0 ⇒ 只受次数上限约束（照 v4.1）。
   - `markInactive` 需要覆盖率，覆盖率依赖侧车（J4）——J2 只提供纯函数，wire（J6）把结果喂回 client。

---

### J3 · 设置与 secure

1. **目标**：14 个 `memory.jev.*` 设置键（内联解析、逐字段容错）、`/agent settings` 表面、secure/locked 域强制关闭（D8）。架构坐标：arch §9.1、§7.3、§4.5（pin）。
2. **文件域**：
   - 修改：`src/memory/settings.ts`（类型 + 解析 + 默认值，**不新增 import**）、`src/memory/setting-specs.ts`（在现有 memory 块末尾追加）、`src/config/settings.ts`（`applySecureDomainOverrides` 加 `memory.jev.enabled=false`；`TIME_SETTING_MS_PATHS` 加 `"memory.jev.confirmTimeoutMs"`）、`docs/dev/data-encryption/README.md`（D8 清单补 `memory.jev`）。
   - 测试：`tests/config/memory-settings.test.ts`、`tests/secure/settings-override.test.ts`、`tests/config/__corpus__/setting-specs-pin.json`、`tests/config/__corpus__/settings-corpus.json`。
   - 禁止：`src/memory/jev/**`、`tests/fixtures/**`（含 `secure-off-golden.json`、`secure-contract-parity.json`，A 级）、其它 `src/config/*`。
3. **依赖**：blockedBy J0（只等 J0 的测试脚手架合入，保证 off golden 在未改动的 dev 上录制；**不等评测基线**）。与 J1 同批（B2）并行。默认列表先用架构稿 §5.2 两个已实测的 opencode id；openrouter 项与阈值微调属于基线之后的独立小改动 E1，由主会话负责（§3、§10 #5）。
4. **接口契约**（`src/memory/settings.ts`）：

```ts
export interface MemoryJevSettings {
  enabled: boolean; // 默认 true（Q27）
  classifiers: string[]; // 默认 ["opencode/jev-1.13-free", "opencode/jev-1.13"]（arch §5.2）；openrouter 项留给 E1
  classifiersRejected: string[]; // 解析时丢弃的非法项（原文，≤10 项、每项 ≤80 码点）；只供提示用，不是设置键，默认 []
  proxy: string; // ""
  childSessions: boolean; // true
  recall: { threshold: number; maxEntries: number; maxBytes: number; waitMs: number }; // 0.7 / 3 / 4096 / 1500（Q37 起为 waitS=2）
  gate: { enabled: boolean; threshold: number }; // true / 0.6
  review: { intervalDays: number }; // 7
  maxCostUsd: number; // 0.5
  maxCalls: number; // 800
  confirmTimeoutMs: number; // 60_000（文件键 confirmTimeoutS）
}
// MemorySettings 增加 `jev: MemoryJevSettings`，DEFAULT_MEMORY_SETTINGS 增加对应默认值。
```

- `classifiers` 解析：逗号串或字符串数组；逐项 trim，`^[^/\s]+/\S+$` 严格匹配，非法项丢弃并记入 `classifiersRejected`，去重保序；`""`、`[]` 或全非法 ⇒ `[]`（⇒ `off(empty-list)`，Q34）。
- specs：`memory.jev.classifiers` 用 `csvString`；`proxy` 用 `kind:"string"`；`confirmTimeoutS` 用 `seconds("memory.jev.confirmTimeoutMs", {min:10, max:600, …})`；浮点阈值与美元用 `kind:"number"` + min/max；全部非 live。

5. **验收标准**：
   - [ ] 14 键默认值与范围逐一符合 arch §9.1；越界/错类型逐字段回落默认，不影响其它字段；`parseMemorySettings` 永不抛错。
   - [ ] Q34：`classifiers: ""`、`[]` ⇒ `[]` 且 `classifiersRejected` 为空；`"foo, bar baz"` ⇒ `[]` 且 `classifiersRejected = ["foo", "bar baz"]`；混合合法与非法 ⇒ 保留合法项、记录非法项。`classifiersRejected` 不出现在 `SETTING_SPECS`。
   - [ ] `loadSettings` 在 secure 与 locked 域下 `memory.jev.enabled === false`（即使文件写 true），其余 memory 字段不变；plain/无判决时返回同一对象（identity，`secure-off-golden.json` 不变）。
   - [ ] `SETTING_SPECS` 中 14 个新 key 紧跟现有 memory 块之后；pin 与 corpus 只因新增键变化（报告贴 `GOV_CORPUS_DUMP` 对比：除新增 `jev` 子对象外无差异）。
   - [ ] `tests/web-hub/boundary.test.ts` 绿（settings.ts import 未变）。
   - [ ] `docs/dev/data-encryption/README.md` D8 列表含 `memory.jev`。
6. **测试清单**：
   - `memory-settings.test.ts`：默认值；每键越界回落；classifiers 串/数组/非法项/去重/空/全非法（`classifiersRejected`）；`confirmTimeoutS` 秒 → 毫秒；14 个 spec 存在且非 live。
   - `settings-override.test.ts`：secure/locked 强制关；plain identity；不改 `DEFAULT_SETTINGS`。
   - 重 pin：`setting-specs-pin.json`（`GOV_SPECS_GENERATE=1 npx vitest run tests/config/setting-specs-pin.test.ts`）、`settings-corpus.json`（按 `4758bae5` 的做法；不确定流程先问 root）。两者在 `tests/config/__corpus__/`，不属于 `tests/fixtures/` 冻结检查。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/config tests/secure/settings-override.test.ts tests/secure/off-golden.test.ts tests/web-hub/boundary.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/   # 必须为空
```

8. **风险 / 问父 agent**：
   - `settings-corpus.json` 注释写「只在 baseline 上生成」，但已有 `4758bae5` 先例 ⇒ 按先例重 pin，报告写清命令与 diff 摘要；若 captured 输入文件缺失，问 root。
   - E0 基线建议改阈值默认值或加 openrouter 项 ⇒ 不由 J3 自改；主会话在 E1 中处理（回架构稿并 `ask_user` 后单独 commit，§10 #5）。

---

### J4 · 侧车索引、打标编排、`/mem jev` 与 `/mem tags`

1. **目标**：侧车读写、标签文件、单条/批量打标编排（Q28）、整理的纯逻辑（配对、建议、dismissed 双键、过期判定）、命令端口实现，以及 `/mem jev`、`/mem tags` 分支与 web 只读放行。架构坐标：arch §4.3.1、§4.4、§4.5、§6.2.3、§6.3.2–§6.3.4（纯部分）、§9.4。
2. **文件域**：
   - 新建：`src/memory/jev/index-store.ts`、`review.ts`、`tagging.ts`、`command-port.ts`；测试 `tests/memory/jev/{index-store,review,tagging,command-port}.test.ts`、`tests/memory/command-jev.test.ts`。
   - 修改：`src/memory/command.ts`（`CreateMemCommandDeps.jev?: JevCommandPort`；`jev`、`tags` 分支；有端口时默认 list 追加状态行、补全表追加 `jev`/`tags`）；`src/web-hub/agent/command-policy.ts`（`mem()` 放行 `jev`（无参）与 `tags`/`tags list`）；`tests/web-hub/agent/command-policy.test.ts`。
   - 禁止：J1/J2 文件（只读）、`src/memory/index.ts`（J6）、`src/web-hub/agent/command-usage.ts`（保 I9，不改）、fixtures。
3. **依赖**：blockedBy J2、J3。单独成批（B4）。**`command.ts` 与 `command-policy.ts` 由 J4 先改，J8 在其后追加**。
4. **接口契约**：
   - `index-store.ts`：`readIndex(dir): { index: JevIndexV1; rebuilt: boolean }`；`writeIndexPatch(dir, patch: IndexPatch): Promise<"ok" | "busy">`（`withMemoryDirLock` 内同步读 → 按 hash 合并 → `writeTempRegular` + `replaceAtomic`；锁忙返回 busy）；`gcIndex(index, liveHashes)`（2000 条 / 1MB）；`readTaxonomyFile(dir)` / `writeTaxonomyFile(dir, file)`；目录 0700（`ensurePrivateDir`）、文件 0600。
   - `tagging.ts`：`tagOne({ client, registry, entry, taxonomy, compare, mode }): Promise<{ tags?: EntryTags; outcome: JevOutcome }>`；`tagBulk({ client, registry, entries, taxonomy, onlyTag?, signal }): Promise<BulkResult>`（标签为主每标签一次 + 条目为主只问 5 个 `m_*`，后台并发 4，partial 时停、余下保持 pending）。
   - `review.ts`：`buildPairs(entries, index, dismissed, cap = 600)`；`staleCandidates(entries, index)`；`runReviewPass({ client, registry, entries, index, today }): Promise<ReviewState | JevOutcome>`；`suggestionsFrom(answers, pairs)`；`isDismissed(pair, dismissed)`（hashKey 或 anchorKey 任一相同）；`anchorOf(entry)`；`markStale(suggestions, liveHashes)`。
   - `command-port.ts`：`createJevCommandPort(deps: { client: JevClient; entryIndex: EntryIndex; dirFor: (cwd) => string | undefined; now; isChildSession; triggerBulk: (cwd) => void; platform: NodeJS.Platform }): JevCommandPort`。
   - **实施时契约补充**（root 批准，均可选、向后兼容，J9 已回写架构稿 §19 #13）：`tagBulk` 增 `onEntryTags?: (tags: EntryTags) => void` / `base?`；`runReviewPass` 增 `project?` / `signal?`（返回型收窄为 `ReviewPassResult = ReviewState | Extract<JevOutcome, { ok: false }>`）；`createJevCommandPort` 的 deps 增 `config?` / `usage?` / `segment?` / `health?`。
   - `command.ts` 分支语法：`/mem jev [probe | retag [--all] | reset-index]`、`/mem tags [list | add <id> --label … --desc "…" [--risk high] [--commands a,b] [--paths a,b] [--tools a,b] | rm <id> | disable <id> | enable <id>]`；`add/rm/disable/enable/retag/reset-index` 仅主会话且 `ctx.hasUI`。
5. **验收标准**：
   - [ ] 坏 JSON ⇒ 空索引 + `rebuilt`，`/mem jev` 显示 `index rebuilt`；锁忙 ⇒ `busy`、不抛；同一 hash 合并不丢其它条目；GC 先清不在语料里的 hash。
   - [ ] 权限：`.jev/` 0700、`index.json`/`taxonomy.json` 0600；文件枚举（`safe-fs.ts:202` 只看 `*.md`）不受影响：`/mem doctor`、tidy 快照对含 `.jev/` 的目录输出不变。
   - [ ] 批量打标：150 条 + 22 标签的 fixture ⇒ 恰好 172 次 `ask`，全部计入 `maxCalls`；并发 ≤4；中途转 partial ⇒ 停止、未完成条目保持 pending；`session_shutdown` abort。
   - [ ] 新增/改 description 的单个标签 ⇒ 只跑该标签的标签部分。
   - [ ] dismissed：改正文开头 24 码点之外 ⇒ 仍视为已忽略；改开头或改 section ⇒ 重新提示。过期建议（hash 不在语料）标 stale。
   - [ ] `/mem jev` 输出各行与 arch §9.4 结构一致（jev/models/stopped/running/tags/evidence/usage/segment/review）；非 Linux 显示 `process evidence: bash jobs only (non-Linux)`。
   - [ ] **无端口时** `command.ts` 的 DESCRIPTION、补全、每个分支输出与 J0 off golden 一致（off-golden 测试绿）。
   - [ ] web 策略（Q35，§10 #9）：只读的 `mem jev`、`mem tags`、`mem tags list` ⇒ allow；改状态的 `mem jev probe|retag|reset-index`、`mem tags add|rm|disable|enable` ⇒ confirm（与 `mem()` 现有 confirm 惯例一致）；本包不新增 deny 行（这些子命令都有文本输出，不属于「纯终端交互、无文本回退」）；其余原有行为不变。
6. **测试清单**：
   - `index-store.test.ts`：坏 JSON、锁忙、合并、GC、权限、taxonomy 文件校验与上限。
   - `tagging.test.ts`：单条打标问题数（5 + 启用标签数 + ≤20 比较）、结果落盘过滤、172 次调用计数、并发上限、partial 中断、abort、单标签补打。
   - `review.test.ts`：配对（共享标签 + Jaccard 前 5）、600 截断优先级（用户令、非 permanent）、dismissed 双键、stale、疑似用户令建议。
   - `command-port.test.ts`：report 各行、probe 强制刷新、retag/reset-index、tags 增删停启。
   - `command-jev.test.ts`：分支路由、子会话/无 UI 拒绝写操作、有端口时状态行、无端口时补全与输出不变。
   - `command-policy.test.ts`：新增 allow/confirm 行。
   - 无 C-J（C-J14 留给 J8）；无金样本刷新。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/jev tests/memory/command-jev.test.ts tests/memory/command.test.ts tests/memory/jev/off-golden.test.ts tests/web-hub/agent/command-policy.test.ts tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/
```

8. **风险 / 问父 agent**：
   - `/mem tags add` 的参数解析需要处理带空格的 `--desc "…"`：复用 web-hub 的 `cmdArgs` 规则还是自写？默认自写最小引号解析并上报。
   - 侧车写入撞上 tidy 事务的锁：只会返回 busy；tidy 的 epoch/lease 语义不碰。

---

### J5 · 写入路径

1. **目标**：`memory` 工具在 jev 开时写后打标与回显、partial 回显、append 刷新 `updated`、用户令守卫、行内注释错误拒写、工具描述变体；skill。架构坐标：arch §6.2.1、§6.2.4、§6.2.5、§9.3、I12。
2. **文件域**：
   - 新建：`src/memory/jev/write-port.ts`（`createJevWritePort`，pi-free）、`skills/memory-jev/SKILL.md`；测试 `tests/memory/tool-v2-jev.test.ts`、`tests/memory/jev/write-port.test.ts`。
   - 修改：`src/memory/tool-v2.ts`（`MemoryToolV2Deps.jev?: JevWritePort`，有端口时选 `MEMORY_TOOL_V2_TEXT_JEV`）、`src/memory/tool-surface.ts`（新增常量，旧常量与 schema 不动）、`tests/fixtures/memory-tool-surface.json`（新增 key）、`tests/memory/tool-surface.test.ts`。
   - 禁止：`src/memory/index.ts`（接线在 J7）、J1/J2/J4 文件、其它 fixtures。
3. **依赖**：blockedBy J2、J4（`tagOne`、`writeIndexPatch`）。与 J6、J8 同批（B5）。
4. **接口契约**：
   - `write-port.ts`：`createJevWritePort(deps: { client: JevClient; entryIndex: EntryIndex; dirFor: (cwd: string) => string | undefined; taxonomyFor: (dir: string) => Taxonomy; confirmTimeoutMs: number; now: () => number }): JevWritePort`。
   - `tool-v2.ts` 在有 `deps.jev` 时：
     - 写前：`checkInline` 有错 ⇒ 抛 `MemoryError`（新引入的错误才拒）；`touchedUserEntries` 非空 ⇒ 两阶段确认（锁外算 → `ctx.ui.confirm(…, {timeout: confirmTimeoutMs})` → 进锁比 stat → 写），子会话/无 UI/拒绝/超时 ⇒ 抛「用户令只有用户能作废…」；
     - 写后（锁外）：`afterWrite` ⇒ 回显行插在预算行之前；usage 按 C-J12 结论放入结果；
     - `doAppend` 锁内对非手写文件 `upsertFrontmatterFields({source:"agent", updated})`；append 新建文件带 `source: agent`。
   - 无 `deps.jev` 时：上述全部不发生，输出与 off golden 一致。
5. **验收标准**：
   - [ ] create/str_replace/insert/append/write 成功后各回显 arch §6.2.4 首两行；四种条件附加行各一例。
   - [ ] partial ⇒ 写入成功 + 回显 `jev: not tagged (partial: …)`，条目 pending。
   - [ ] Jev 调用不在锁内（测试：锁回调内调用计数为 0）；单次写入打标总时限 3000ms（fake clock）。
   - [ ] 守卫三例（v4.1）+ 子会话拒绝 + 超时拒绝 + 并发修改提示；rename 不触发。
   - [ ] 新引入的行内注释错误拒写，原有错误不阻止写入。
   - [ ] append 刷新 `updated`；append 新建文件带 `source: agent`。
   - [ ] `MEMORY_TOOL_V2_TEXT_JEV` = 原描述 + arch §9.3 那句（约 250B）；schema `canonicalJson` 与原版逐字节相同；`memory-tool-surface.json` 只新增 key（`git diff` 只有加行）；字节预算断言更新在同一测试。
   - [ ] `skills/memory-jev/SKILL.md`：先查后写、用户令当场写、经验收尾写、回显转述给用户、行内注释语法示例、partial 下用 `tags=+…`、不要反复重试被 hold 的调用；不重复工具描述里的机制（I12）。
   - [ ] off-golden 测试仍绿。
6. **测试清单**：
   - `write-port.test.ts`：changed-entry 识别（前后 hash 差集）、并行打标、回显各条件、partial 回显、usage 汇总、`checkInline`、`touchedUserEntries`。
   - `tool-v2-jev.test.ts`：五种写操作 × 回显；守卫六条路径；append 刷新；锁外调用断言；无端口时与 `tool-v2.test.ts` 现有期望一致（复跑）。
   - `tool-surface.test.ts`：新 key、预算、schema 不变。
   - C-J12（消费）；金样本：`memory-tool-surface.json` 新增 key（契约级，理由「jev description variant」）。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/tool-v2-jev.test.ts tests/memory/tool-v2.test.ts tests/memory/tool-surface.test.ts tests/memory/jev tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/   # 只允许 memory-tool-surface.json
```

8. **风险 / 问父 agent**：
   - append 新建文件归属改为 agent 是行为变化（agent 之后可覆写/删除）；只在 jev 开时生效，skill 与 J9 用户指南需写明。
   - `ctx.ui.confirm` 的 timeout 参数在 pi 1.4 的签名需核对 d.ts；不支持时用 `Promise.race` + unref 计时器。

---

### J6 · 召回运行时（wire 与段记录）

1. **目标**：`wireJev` 装配与全部运行时：U/E/A/B 四层召回、消息格式与渲染器、段内去重与回扫播种、状态机接线与通知、探测与恢复计时器、首次 full 后批量打标、pending 补打、周期整理触发、静态 core 排除、行内注释剥离、secure 参数、命令端口接线。架构坐标：arch §5.3、§6.1.1–§6.1.6、§6.2.3（触发）、§6.3.1（周期）、§8、§9.2；**静态 core 映射是显式风险点（r1 #10）**。
2. **文件域**：
   - 新建：`src/memory/jev/wire.ts`、`segment.ts`、`config.ts`；测试 `tests/memory/jev/{wire-recall,wire-status,segment,config}.test.ts`、`tests/memory/inject-jev.test.ts`、`tests/integration/memory-jev-recall.test.ts`。
   - 修改测试：`tests/memory/jev/off-golden.test.ts`（**只**追加 `PI_API_ALLOWED_DIFF` 的 jev 注册名与 `/mem` 状态行，不改其它断言、不碰 golden）。
   - 修改：`src/memory/index.ts`（`WireMemoryOpts.secureDomainKind?`；`resolveJevWiring` ⇒ `wireJev`；`onRender` 带 `JevRenderInfo`；把 `commandPort` 传给 `createMemCommand`；返回值加 `attachJevBashJobs(port)`（本包内为占位，记录端口即可））、`src/memory/inject.ts`（`MemorySectionDeps.onRender` 第三参 `JevRenderInfo`；`stripInlineMeta?: boolean` 为真时对输出块剥注释）、`src/index.ts`（`wireMemory(…, { secureDomainKind: secureDomain?.kind ?? "plain" })`）、`tests/fixtures/governance/activate-trace.json`（按声明刷新）。
   - 禁止：`src/memory/tool-v2.ts`、`command.ts`、`doctor*.ts`（B5 其它包持有）、`src/memory/tiered.ts`（不改静态块，arch §5.6）、tiered/legacy/doctor golden。
3. **依赖**：blockedBy J2、J3、J4。与 J5、J8 同批（B5）。**`src/memory/index.ts`、`src/index.ts`、`jev/wire.ts` 由 J6 先改，J7 在其后追加**。
4. **接口契约**：
   - `config.ts`：`resolveJevWiring(memory, domainKind): { on: true; config: JevConfig } | { on: false; reason }`（§1.1）。
   - `wire.ts`：`wireJev(pi, deps: { config: JevConfig; settings: MemorySettings; isChildSession: boolean; dirFor: (cwd) => string | undefined; getRenderInfo: (cwd) => JevRenderInfo | undefined; onAfterWriteHook: (fn: (cwd) => void) => void }): { commandPort: JevCommandPort; makeWritePort(): JevWritePort; doctorPort: JevDoctorPort; attachBashJobs(port: JevBashJobsPort | undefined): void; client: JevClient }`（`makeWritePort`/`doctorPort` 本包只构造不接线；J7 接线）。
   - 注册（全部在 `wireJev` 内、hub 之后）：`before_agent_start`（U、E 唤醒轮、播种、子会话派单召回）、`tool_call`（A 层；J7 在同一 handler 前插门禁）、`tool_result`（E，返回 `undefined`）、`message_start`（bash-job steer 情形）、`session_start`（主会话探测、周期整理、批量打标）、`session_compact`/`turn_end`（B、清判定缓存、子会话检查点）、`session_shutdown`（abort 后台、reload 时清健康表）、`registerMessageRenderer("subagent:memory-inject")`、`pi.events.on("bash-job:notification")`（如 C-J6 证明需要）。具体事件以 C-J1/C-J4/C-J6/C-J10 结论为准。
   - `segment.ts`：`createSegmentState()`：`seed(branch)`、`markInjected(layer, hashes)`、`isInjected(hash)`、`latch(hash, turnSeq)`、`isLatched(hash, turnSeq)`、`resetOnCompaction(compactionId)`、`lastInjected(n)`、`count()`（上限 30）；`appendEntry("subagent:memory-recall", MemoryRecallEntryV1)`。
5. **验收标准**：
   - [ ] 四个设置期 off 配置（disabled、legacy-layout、legacy-tool、secure-sim）⇒ 零新注册、逐字节等于 golden；`pi-api` 配置在本包追加的允许差异内通过；`tests/memory/jev/off-golden.test.ts` 绿。
   - [ ] `doctorPort.extraReminder` 的到期数用 J1 的 `expiredEntries`，不自行解析 `expires`。
   - [ ] U 闸门四条；候选排除（private、secret、已注入、archived、静态 core）；>360 本地预筛并在 `/mem jev` 显示 `recall truncated N→360`。
   - [ ] 静态 core：primary 文件中 `section ∉ omittedSections` 的条目被排除；还没渲染过不排除；L4/L5 降级（core 未内联）时不排除——每种一例。
   - [ ] 1500ms（Q37 起为 waitS=2）内返回 ⇒ 作为本次 `message`；超时 ⇒ 后台继续，代际仍当前时 `sendMessage(triggerTurn:false)` 补发；新 prompt abort 旧调用；失败只记日志。
   - [ ] `previous_user_message` 来自 `getBranch()` 回扫，截断脱敏剥 skill；子会话 `session:"child"`、派单 prompt 2000 码点、不带上一条。
   - [ ] A 层零调用：命中标签匹配器 → 有效标签 → importance≥2、type 过滤（pending 手工标签放行）→ ≤3 条 4KB；partial 下继续且标记 `·partial`；`inactive` 下零 `sendMessage`。
   - [ ] E 层：失败判定三级退出码来源；同签名每段一次、每段 ≤10；>150 预筛；前 2 条；唤醒轮作为 `before_agent_start` message。
   - [ ] B 层：compaction 后重注上一段最近 ≤3 条，已删跳过，hash 变化注「（已修改）」；闩锁不带入新段。
   - [ ] 去重：每次注入 `appendEntry`；`/reload`、resume 后回扫播种不重复注入；段累计 30 条后停。
   - [ ] 状态：主会话 `session_start` 后后台探测一次；首次 full 通知一次（文案逐字）；full→partial、partial→full、启动即 partial（有凭证）通知；inactive 不通知；最早 `until` 安排一次性探测（segmented clock、unref）；`/reload` 清健康表。
   - [ ] 首次进入 full 后后台 `tagBulk`（只主会话）；之后 full 期间对 pending 条目后台补打；周期整理条件（full、≥intervalDays、corpusFp 变化）满足时后台 `runReviewPass`，`intervalDays=0` 不跑。
   - [ ] 子会话：`memory.jev.childSessions=false` ⇒ handler 惰性；子会话不探测、不打标、不整理、不通知、不写侧车；共享健康表与令牌桶。
   - [ ] jev 开时静态块剥掉行内注释；tiered golden 测试（直接调 `renderTiered`）不变；`inject-jev.test.ts` 证明含注释 fixture 被剥、jev 关时保留。
   - [ ] `before_agent_start` 只返回 `message`，绝不返回 `systemPrompt`；`tool_result` 恒返回 `undefined`。
   - [ ] `activate-trace.json` 刷新：diff 只含 jev 新注册（default/max/child 等启用 memory 的 profile 的 phase1）；phase2 不变（fakeCtx 无 `modelRegistry` ⇒ `off(pi-api)` 不通知）。commit 说明「memory jev hooks」。
6. **测试清单**：
   - `config.test.ts`：五种 off 原因与 on。
   - `segment.test.ts`：播种、去重、闩锁按 turnSeq 生效、compaction 重置、上限 30。
   - `wire-recall.test.ts`（fakePi + fake-registry）：U 同步/晚到/abort/失败；静态 core 三例；上一条消息；子会话派单；A 层（partial、pending 手工标签、inactive）；E 层（三种退出码、签名去重、10 次上限、唤醒轮）；B 层。
   - `wire-status.test.ts`：探测、通知全表、恢复计时器、批量打标触发、周期整理触发、reload 清表、子会话惰性。
   - `inject-jev.test.ts`：`onRender` 第三参、剥注释开关。
   - `tests/integration/memory-jev-recall.test.ts`：完整 session：消息 → U 注入 → 工具命中 A → compaction → B → `/reload` 播种不重复。
   - C-J1、C-J4、C-J5、C-J6、C-J9、C-J10、C-J13（消费）；金样本：`activate-trace.json`（B 级，按声明刷新）。
7. **自验命令**：

```sh
timeout 900 npx vitest run tests/memory/jev tests/memory/inject-jev.test.ts tests/memory/inject.test.ts tests/memory/tiered.test.ts tests/memory/legacy-golden.test.ts tests/memory/wire.test.ts tests/integration/memory-jev-recall.test.ts tests/boundary/pi-free.test.ts
PI_TOOLKIT_UPDATE_TRACE=1 timeout 600 npx vitest run tests/governance && timeout 600 npx vitest run tests/governance
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/   # 只允许 governance/activate-trace.json
```

8. **风险 / 问父 agent**：
   - **静态 core 映射**：`TieredRenderResult.omittedSections` 的粒度与 `MemEntry.section` 是否完全同名（含 `### ` 拼接、CJK、重复标题）——写对照测试；对不上就退化为不排除，并上报。
   - C-J1/C-J4 若显示落点与 arch 假设不同 ⇒ 停下上报，不自行换钩子。
   - `before_agent_start` 被 hub 之后注册：hub 的 handler 在 `src/index.ts:204` 创建，`wireMemory` 在其后调用，注册序天然满足；勿在 hub 之前注册。
   - wire.ts 体量大，内部按「status / recall / segment-hooks」拆私有函数；首派时不在 wire.ts 外另建 pi-facing 文件。
   - **拆包预案（r1 #10）**：触发条件——dev 运行超过 `timeout_s` 的 1.5 倍仍未收尾，或被 verifier 打回两次。触发后主会话 `abort` 或收下已完成部分，按下面拆成两个串行包重派（共用本节文件域，排除清单由主会话在重派前单独 commit）：
     - **J6a 状态与装配**：`config.ts`、`wire.ts`（装配骨架 + 新文件 `wire-status.ts`：状态机接线、探测与恢复计时器、通知、批量打标/pending 补打/周期整理触发、`commandPort`）、`src/memory/index.ts`、`src/index.ts`、`activate-trace.json`；测试 `wire-status.test.ts`、`config.test.ts`。
     - **J6b 召回**：新文件 `wire-recall.ts`（U/E/A/B 四层、渲染器）、`segment.ts`、`src/memory/inject.ts`；测试 `wire-recall.test.ts`、`segment.test.ts`、`inject-jev.test.ts`、`memory-jev-recall.test.ts`；`wire.ts` 只追加一行 `registerRecall(pi, deps)` 调用。
     - `tests/boundary/pi-free.test.ts` 的排除清单由主会话在重派前追加 `wire-status.ts`、`wire-recall.ts` 并单独 commit；J6b 合入后再刷新 `activate-trace.json`（若注册序变化）。

---

### J7 · 门禁（④）与端口生产接线

1. **目标**：`tool_call` 门禁全链路（粗筛、现场证据、Jev 判定档、证据档、判定缓存、文案、闩锁）、bashJobs 端口绑定，以及把 J5 写入端口、J8 doctor 端口、工具描述变体接入生产装配。架构坐标：arch §6.4.1–§6.4.6、§7.1（进程命令行脱敏断言）、§8、§16.4；Q29、Q30、Q33。
2. **文件域**：
   - 新建：`src/memory/jev/probes.ts`；测试 `tests/memory/jev/{probes,wire-gate}.test.ts`、`tests/integration/memory-jev-gate.test.ts`、`tests/integration/memory-jev-release-guard.test.ts`、`tests/integration/memory-jev-write.test.ts`。
   - 修改（追加）：`src/memory/jev/wire.ts`（门禁分支插在 A 层之前；`attachBashJobs` 生效）、`src/memory/index.ts`（`createMemoryToolV2({ …, jev: jevWiring.makeWritePort() })`、`createStartupReminder`/`doctorSummary`/`createMemCommand` 传 `jev` doctor 端口；Q34：`resolveJevWiring` 返回 `empty-list` 且 `settings.jev.classifiersRejected` 非空时，给 `createStartupReminder` 传 `settingsWarnings`）、`src/index.ts`（post-guard：`memoryWiring?.attachJevBashJobs({ list: () => holder.current?.bashJobs?.list() ?? [] })`）、`tests/memory/jev/off-golden.test.ts`（**只**追加 `PI_API_ALLOWED_DIFF` 的描述变体、补全、tool/reminder 确定性差异）。
   - 禁止：`jev/segment.ts`（只消费闩锁 API；缺能力上报）、J1/J2/J4/J5/J8 文件、tiered/legacy/doctor golden。
3. **依赖**：blockedBy J5、J6、J8。单独成批（B6）。
4. **接口契约**：
   - `probes.ts`：`collectEvidence({ cands, command, platform, bashJobs?, isChild, git: GitRunner, cwd, procRoot = "/proc", now }): Promise<GateEvidence>`（并行、最坏 1.5s、任一项失败省略）；`scanProc(procRoot, uid, wanted: Set<string>, cache)`（仅 Linux，4096 pid、2s 缓存、永不抛）；`readGitHead(cwd)`（支持 worktree `gitdir:`）；`stagedFiles(git, cwd)`（仅 git commit 且候选正文有路径样式词，≤50）；`evidenceFingerprint(ev)`；`clearProcCache()`（收到 `bash-job:notification` 时）。
   - 门禁 handler 结构（硬约束）：整体 try/catch，异常一律放行并记日志；粗筛五步在第一个 `await` 之前完成，不通过 ⇒ 零 await 返回；判定按条目 hash 串行，同批同条目只问一次。
5. **验收标准**：
   - [ ] 粗筛：只读工具集合放行；未命中高危匹配器放行；无守护条目放行；已闩锁且非 hold 放行——均零 await（测试断言 handler 同步返回）。
   - [ ] Jev 判定档四行 + 判定缓存命中不调 Jev；hold 拦截时正文只注入一次、后续只返回 reason；拦一次后 `turnSeq` 前进才放行；同批两个相同调用都被拦、正文只注入一次。
   - [ ] 证据档（Jev 超时/出错/漏答/partial，Q33）：`gate=hold` + 点名程序在 running ⇒ 拦截，reason 含「Jev 未判定，按证据拦截」；其余 ⇒ 放行 + `[memory · G unjudged]` 注入（每段每条目一次）。
   - [ ] `nogate` 永不拦；行内 `gate*` 对任何高危命中都是候选；静态 core 条目不重复注入、reason 引用标题。
   - [ ] 证据：running 只收录点名程序（`vim …/release.sh` 不算——身份取 argv0/脚本名）、他人 uid 忽略、pid 遍历中消失跳过；非 Linux（mock `process.platform`）只用 bashJobs、子会话无进程证据；收录命令行已脱敏（token 掩码断言，D7 ①）。
   - [ ] 粗筛通过且缓存未命中时同步等待 ≤2500ms（fake clock）。
   - [ ] release.sh 验收场景（integration）：后台 `bash scripts/release/release.sh 0.10.3` 运行中，`git add -A && git commit` 被 hold 拦；重试命中缓存、不调 Jev、不再注入正文；`git -C . commit` 被拦；`echo "git commit"` 放行；收到完成通知后下一次提交重判并放行；Jev 超时版本按证据拦。
   - [ ] 生产接线后：jev 开时工具描述为变体、写后回显生效、`/mem doctor` 出现 D17–D19、启动提醒追加项生效；四个设置期 off 配置 golden 仍逐字节绿，`pi-api` 配置只在声明的允许差异内。
   - [ ] Q34：`classifiers: "foo"`（全非法）⇒ jev 不接线，主会话 `session_start` 的启动提醒出现一行 `memory.jev.classifiers: all entries invalid (foo) — jev off`（每 session 去重）；`classifiers: ""` ⇒ 不提示，行为与 `disabled` 相同。
   - [ ] 跑 `tests/governance`：若 phase1/phase2 有 diff，只允许由本包接线引起且在报告逐条说明（预期无 diff：本包不新增 `pi.on`/`register*`）。
6. **测试清单**：
   - `probes.test.ts`：假 `/proc` 目录树（release.sh 在跑、vim 打开 release.sh、他人 uid、pid 消失、readdir 失败）、git HEAD（分支/detached/worktree/非 git）、staged（假 GitRunner：列表、退出 128、超时、输出超限）、指纹稳定性、非 Linux 路径。
   - `wire-gate.test.ts`：粗筛五步、判定档、证据档两行、缓存、闩锁、多条最严、`nogate`、handler 抛错放行。
   - `memory-jev-gate.test.ts`：partial/inactive 行为边界（arch §9.2 三条）、子会话门禁。
   - `memory-jev-release-guard.test.ts`：上面的验收场景全套。
   - `memory-jev-write.test.ts`：生产装配下写入 → 打标 → 回显 → 侧车落盘 → A 层可见。
   - C-J2、C-J3、C-J11（消费）；无金样本刷新（除非报告说明的 trace 变化）。
7. **自验命令**：

```sh
timeout 900 npx vitest run tests/memory/jev tests/integration/memory-jev-gate.test.ts tests/integration/memory-jev-release-guard.test.ts tests/integration/memory-jev-write.test.ts tests/integration/memory-jev-recall.test.ts tests/governance tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/
```

8. **风险 / 问父 agent**：
   - C-J2 若证明 handler 抛错会让工具失败 ⇒ try/catch 是硬要求；C-J3 若显示同批并发派发 ⇒ 按条目 hash 的串行锁必须是 Promise 链，不得用同步标志。
   - `/proc` 扫描最坏耗时：在报告里贴本机 4096 pid 级别基准（只记录不断言）。
   - 接线改 `src/memory/index.ts` 时若发现 J5/J8 端口形状对不上 ⇒ 不改 J5/J8 文件，上报 root。

---

### J8 · 整理与到期

1. **目标**：`/mem review`（逐条确认、执行删改与 dismissed）、`/mem expired`、doctor D17–D19、启动提醒扩集合、tidy prompt 保留行内注释规则、web 只读放行 `review --list`。架构坐标：arch §6.3.4、§6.3.5、§1.4（doctor/启动提醒/tidy 行）、§4.5 doctor golden。
2. **文件域**：
   - 新建：`src/memory/jev/review-command.ts`、`expired-command.ts`、`entry-edit.ts`（均 pi-free，UI 用 `MemCommandUiLike`）；测试 `tests/memory/jev/{review-command,expired-command,entry-edit}.test.ts`、`tests/memory/doctor-jev.test.ts`、`tests/memory/tidy/prompt-jev.test.ts`。
   - 修改：`src/memory/contracts.ts`（`DoctorId` 追加 `"D17" | "D18" | "D19"`）、`src/memory/doctor.ts`（`runDoctor` 新可选参数 `jev?: { today: string }`，有才跑 D17–D19，`ID_ORDER` 末尾追加）、`src/memory/doctor-command.ts`（`collectDoctorFindings`/`createStartupReminder`/`handleMemDoctorCommand` 透传可选 `jev?: JevDoctorPort`；`createStartupReminder` 另加可选 `settingsWarnings?: readonly string[]`，Q34 的提示从这里出）、`src/memory/command.ts`（在 J4 之后追加 `review`、`expired` 分支与补全；有 `deps.jev` 时 doctor 分派带 jev 参数；tidy 分派带 `preserveInlineMeta`）、`src/memory/tidy/prompt.ts`（`TidyPromptInput.preserveInlineMeta?: boolean`）、`src/memory/tidy/command.ts`、`src/memory/tidy/batch-command.ts`（只透传该布尔）、`src/web-hub/agent/command-policy.ts`（放行 `review --list`）、`tests/web-hub/agent/command-policy.test.ts`、`tests/memory/doctor.test.ts`（仅追加用例，不改 golden）。
   - 禁止：`src/memory/index.ts`（接线在 J7）、`jev/review.ts`（J4 持有；需要新纯函数时只能追加导出，不改既有签名）、`tests/fixtures/memory/doctor-golden/current-5.json`。
3. **依赖**：blockedBy J4。与 J5、J6 同批（B5）。`command.ts`、`command-policy.ts` 在 J4 之后改。
4. **接口契约**：
   - `entry-edit.ts`：`deleteEntry(dir, entry, opts): Promise<"ok" | "stale" | "busy">`（锁内 CAS，先复制原文件进 `.trash`，可 `/mem restore --trash` 恢复）；`setInlineMeta(dir, entry, patch: Partial<InlineMeta>)`（写 `expires`、`user`、去期限）；手写文件同样允许（这是用户在 UI 中的显式操作）。
   - `review-command.ts`：`handleMemReview(args, ui: MemCommandUiLike, port: JevCommandPort, deps)`：`--list`（只读，web 允许）、`--run`、默认逐条 `ui.select`（arch §6.3.4 选项表）；「交给 agent」⇒ `ui.setEditorText`（C-J14 不可用时改为显示指令）。
   - `expired-command.ts`：`handleMemExpired(args, ui, deps)`：删除 / 延期 30 天 / 去掉期限 / 跳过。
   - `doctor.ts`：D17（用 J1 `expiredEntries` 判 warn、`untilEntries` 判 info，不自行解析日期）、D18（行内注释语法错，取 `MemEntry.inlineErrors`）、D19（core 用量 ≥80%，已有 D02/D03 时不报）。
5. **验收标准**：
   - [ ] `tests/memory/doctor.test.ts` 原有用例与 doctor golden **逐字节不变**（`runDoctor` 不传 jev 时零差异）；`git diff origin/dev -- tests/fixtures/memory/doctor-golden/` 为空。
   - [ ] D17/D18/D19 规则、ID 顺序、D19 抑止各一例。
   - [ ] 启动提醒（有端口时）追加：到期条目数、core 用量、`jev N suggestions — /mem review`、Jev 状态；仍按 session + cwd 指纹去重；无端口时输出与 off golden 一致。
   - [ ] `settingsWarnings` 非空 ⇒ 启动提醒多一行（英文 token，`memory.jev.classifiers: all entries invalid (…) — jev off`），不依赖 `jev` 端口；为空或缺省 ⇒ 字节不变。
   - [ ] web 降级（Q35）：web 端（`ctx.hasUI` 为假或无 `select`）执行 `/mem review`、`/mem expired` 时不报错，输出等同 `--list` 的文本清单加一句「在终端执行 /mem review 逐条处理」，不做任何写入。
   - [ ] `/mem review`：五类建议 × 选项均可执行；stale 建议跳过；删除走 `.trash` 且可恢复；「保留」写 dismissed；partial 下 list/执行照常、`--run` 提示 Jev 不可用。
   - [ ] `/mem expired` 四选项；延期写 `expires=今天+30`。
   - [ ] tidy prompt：`preserveInlineMeta` 为真且语料含 `<!-- mem` ⇒ 追加一条「原样保留行内注释」规则；否则字节不变（off golden 的 `tidyPrompt` 绿）。
   - [ ] 子会话 ⇒ review 执行/expired 拒绝（`--list` 除外）；web 策略：`mem review --list` allow，`mem review`、`mem review --run`、`mem expired` confirm（Q35，§10 #9）。
6. **测试清单**：
   - `doctor-jev.test.ts`：D17–D19 与抑止；不传 jev 时与现状一致。
   - `entry-edit.test.ts`：CAS 冲突返回 stale、锁忙、trash 复制与恢复、行内注释写入位置（首行行尾/标题下首个非空行）。
   - `review-command.test.ts`：每类建议每个选项（fake UI）、stale、dismissed 落盘、setEditorText 回退。
   - `expired-command.test.ts`：四选项；无 UI 降级为清单。
   - `doctor-command` 用例（并入 `doctor-jev.test.ts`）：`settingsWarnings` 有/无。
   - `prompt-jev.test.ts`：规则追加条件。
   - `command-policy.test.ts`：新增行。
   - C-J14（消费）；无金样本刷新。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/memory/doctor.test.ts tests/memory/doctor-jev.test.ts tests/memory/jev tests/memory/tidy tests/memory/tidy.test.ts tests/memory/command.test.ts tests/memory/jev/off-golden.test.ts tests/web-hub/agent/command-policy.test.ts tests/boundary/pi-free.test.ts
timeout 600 npm run typecheck && timeout 300 npm run format:check
git diff --stat origin/dev -- tests/fixtures/   # 必须为空
```

8. **风险 / 问父 agent**：
   - `ID_ORDER` 追加会不会改变 doctor 报告的排序文本：没有 D17–D19 发现时不应有任何变化；如 golden 变化即为 bug。
   - 删除整段条目（`## ` 小节）时标题是否一起删 ⇒ 默认：整段条目连标题删除；列表项只删该项及续行。拿不准上报。

---

### J9 · 收尾

1. **目标**：用户与开发者文档、release note、web 紧凑分支（可选）、端到端用例、peer bump 清单登记；主会话的整合验证在本包前完成（§7）。架构坐标：arch §6.1.6（web）、§8（release note #16）、§15 J9 行、§13（C-J 进 peer bump 清单）。
2. **文件域**：
   - 修改：`docs/dev/memory/README.md`、`docs/guide/memory.md`、`AGENTS.md`（只改两处：「pi peer bump checklist」第 2 条加 `memory-jev-channels.test.ts` 与门控变量；「Frozen artifacts」B 级行登记 `tests/fixtures/memory-tool-surface.json`（契约 golden，只许新增 key，r1 #12）；布局表 `src/memory/` 行不动）、`docs/dev/memory/jev-arch.md`（只追加「实施状态」一行，不改设计正文）。
   - 可选（主会话决定是否做）：`src/web-hub/ui/src/components/transcript/Transcript.vue` 或对应 logic 文件中 `subagent:memory-inject` 紧凑分支 + `src/web-hub/ui/src/logic/memMarker.ts` + 测试；需跑 `npm run build:web && npm run check:web`。
   - 新建：`tests/integration/memory-jev-e2e.test.ts`。
   - 禁止：`src/memory/**`（发现缺陷 ⇒ 上报，打回对应包）、fixtures、CHANGELOG（由 release.sh 生成）。
3. **依赖**：blockedBy J0–J8 全部 + 主会话整合验证通过。B7。
4. **接口契约**：无新增；web 分支只读 `MemoryInjectDetailsV1`（I10：只追加字段，不改既有字段）。
5. **验收标准**：
   - [ ] `docs/dev/memory/README.md` 新增 §9 所列不变式与门禁。
   - [ ] `docs/guide/memory.md` 覆盖 §9 用户指南要点（含非 Linux 退化、首次启用外发说明、关闭方式、代理键、`partial`/`inactive` 释义、行内注释语法）。
   - [ ] release note 素材：commit body 写明「默认开启 ⇒ 工具描述变体使 system prompt 前缀一次性变化、缓存失效一次」（CHANGELOG 由 commit 生成，不手改）。
   - [ ] e2e：从空目录开始 `/mem init` → 写入 → 打标 → U/A 注入 → 门禁拦一次 → `/mem review` → `/mem jev`，全程 fake registry。
   - [ ] web 分支（若做）：折叠成一行标记；`check:web` 通过。
   - [ ] `AGENTS.md` 冻结面表 B 级行出现 `memory-tool-surface.json`，规则写「只在声明的工具描述变体时新增 key，旧 key 字节不变」；`npm run format:check` 绿。
6. **测试清单**：`memory-jev-e2e.test.ts`（上述全链路一例 + partial 版本一例）；web（若做）`tests/web-hub/ui/logic-mem-marker.test.ts`。无金样本刷新。
7. **自验命令**：

```sh
timeout 600 npx vitest run tests/integration/memory-jev-e2e.test.ts
timeout 300 npm run format:check && timeout 600 npm run typecheck
# 若做 web：timeout 600 npm run build:web && timeout 300 npm run check:web
```

8. **风险 / 问父 agent**：文档里涉及默认阈值、默认分类器列表的数字以 J3 合入的代码为准，不以架构稿为准；冲突时上报。

## 5. 车道内的模型分工建议（按 `skills/dev-flow/SKILL.md` 阶段表）

| 包                 | 开发                                       | 验收（≠ 开发模型，禁 GPT 系）         |
| ------------------ | ------------------------------------------ | ------------------------------------- |
| J0、J3             | glm-5.3（订阅）或 sonnet                   | kimi-k3（订阅）/ deepseek-flash       |
| J1、J2、J4、J5、J8 | glm-5.3 / sonnet / gpt-6.1-sol 按包分摊    | 开发用 GLM ⇒ kimi-k3；用 GPT ⇒ sonnet |
| J6、J7             | sonnet 或 opus-5.5（关键路径、最难）       | kimi-k3（订阅）                       |
| J9                 | sonnet；web 分支派 frontend-dev（kimi-k3） | deepseek-flash / glm-5.3              |

thinking：J6/J7 开发 `high`，其余 `medium`，验收 `medium`。dev 的 `timeout_s` 约 900，J6/J7 可给 1800。

## 6. 冲突预检 spec

- 脚本在仓内：`skills/dev-flow/scripts/conflict-check.mjs`（任务描述里的 `~/.agents/skills/dev-flow/scripts/` 在本机不存在）。只有 B2、B5 两批是多写包并行，各一份 spec；其余批次单包，无需预检。
- v1 起草时已对当前 dev 实跑两份 spec：两批均「无交集，可同树并行」，exit 0。
- v2 文件域变化：J6 新增 `tests/memory/jev/off-golden.test.ts`（只扩充允许差异清单）；J7（单包批次）同样会追加该文件，排在 J6 之后串行。v2 修订后已对当前 dev 重跑两份 spec（结果见下方「v2 实跑记录」）。
- `tests/memory/jev/off-golden.test.ts` 的持有顺序：J0 新建 → J6 追加 → J7 追加（串行，均只改 `PI_API_ALLOWED_DIFF`）。
- 串行共享文件不放进同一份 spec（它们按批次先后持有）：`src/memory/command.ts` 与 `src/web-hub/agent/command-policy.ts`（J4 → J8）、`src/memory/index.ts`、`src/index.ts`、`src/memory/jev/wire.ts`（J6 → J7）、`src/memory/doctor.ts`（J1 → J8）。

B2（J1 ∥ J3）：

```json
[
  {
    "id": "J1",
    "globs": [
      "src/memory/jev/contracts.ts",
      "src/memory/jev/entries.ts",
      "src/memory/jev/taxonomy.ts",
      "src/memory/jev/redact.ts",
      "src/memory/jev/shell-parse.ts",
      "src/memory/jev/match.ts",
      "src/memory/jev/guard.ts",
      "src/memory/jev/format.ts",
      "src/memory/secret-patterns.ts",
      "src/memory/doctor.ts",
      "tests/memory/jev/entries.test.ts",
      "tests/memory/jev/taxonomy.test.ts",
      "tests/memory/jev/redact.test.ts",
      "tests/memory/jev/shell-parse.test.ts",
      "tests/memory/jev/match.test.ts",
      "tests/memory/jev/guard.test.ts",
      "tests/memory/jev/format.test.ts",
      "tests/memory/jev/contracts.test.ts",
      "tests/memory/secret-patterns.test.ts",
      "tests/boundary/pi-free.test.ts"
    ]
  },
  {
    "id": "J3",
    "globs": [
      "src/memory/settings.ts",
      "src/memory/setting-specs.ts",
      "src/config/settings.ts",
      "docs/dev/data-encryption/README.md",
      "tests/config/memory-settings.test.ts",
      "tests/config/__corpus__/setting-specs-pin.json",
      "tests/config/__corpus__/settings-corpus.json",
      "tests/secure/settings-override.test.ts"
    ]
  }
]
```

B5（J5 ∥ J6 ∥ J8）：

```json
[
  {
    "id": "J5",
    "globs": [
      "src/memory/tool-v2.ts",
      "src/memory/tool-surface.ts",
      "src/memory/jev/write-port.ts",
      "skills/memory-jev/**",
      "tests/fixtures/memory-tool-surface.json",
      "tests/memory/tool-surface.test.ts",
      "tests/memory/tool-v2-jev.test.ts",
      "tests/memory/jev/write-port.test.ts"
    ]
  },
  {
    "id": "J6",
    "globs": [
      "src/memory/jev/wire.ts",
      "src/memory/jev/segment.ts",
      "src/memory/jev/config.ts",
      "src/memory/index.ts",
      "src/memory/inject.ts",
      "src/index.ts",
      "tests/fixtures/governance/activate-trace.json",
      "tests/memory/jev/wire-*.test.ts",
      "tests/memory/jev/segment.test.ts",
      "tests/memory/jev/config.test.ts",
      "tests/memory/jev/off-golden.test.ts",
      "tests/memory/inject-jev.test.ts",
      "tests/integration/memory-jev-recall.test.ts"
    ]
  },
  {
    "id": "J8",
    "globs": [
      "src/memory/contracts.ts",
      "src/memory/doctor.ts",
      "src/memory/doctor-command.ts",
      "src/memory/command.ts",
      "src/memory/tidy/prompt.ts",
      "src/memory/tidy/command.ts",
      "src/memory/tidy/batch-command.ts",
      "src/memory/jev/review-command.ts",
      "src/memory/jev/expired-command.ts",
      "src/memory/jev/entry-edit.ts",
      "src/web-hub/agent/command-policy.ts",
      "tests/web-hub/agent/command-policy.test.ts",
      "tests/memory/doctor.test.ts",
      "tests/memory/doctor-jev.test.ts",
      "tests/memory/jev/review-command.test.ts",
      "tests/memory/jev/expired-command.test.ts",
      "tests/memory/jev/entry-edit.test.ts",
      "tests/memory/tidy/prompt-jev.test.ts"
    ]
  }
]
```

用法：`node skills/dev-flow/scripts/conflict-check.mjs <spec.json> --cwd /home/bluecake/ai/pi-toolkit`；B5 开派前在 J4 合入后的 HEAD 上重跑一次。

v2 实跑记录（2026-10-30，当前 dev HEAD `5ac3627c`，直接从本节两个 JSON 块抽取）：B2 {J1 ∥ J3} ⇒「无交集，可同树并行」exit 0（J1 匹配 2 个已存在文件、J3 匹配 8 个）；B5 {J5 ∥ J6 ∥ J8} ⇒「无交集，可同树并行」exit 0（J5 4 个、J6 4 个、J8 10 个）；无潜在交集警告。

## 7. 全量测试与收尾（J7 通过后、J9 开工前，由主会话执行）

1. **整合检查**（主会话，`bash_job` 后台跑，测试期间并行派 J9 以外不写代码的只读复核）：

```sh
git status --short                      # 只应有已 commit 的内容，工作区干净
timeout 300 npm run format:check
timeout 900 npm run typecheck
PI_TOOLKIT_TEST_WORKERS=2 timeout 3600 npm test
timeout 900 npm run build
git diff --stat origin/dev -- tests/fixtures/
```

2. **`tests/fixtures/` 预期例外清单**（`git diff --name-status origin/dev -- tests/fixtures/` 只能出现这些行）：

| 状态 | 文件                                                | 来源                            |
| ---- | --------------------------------------------------- | ------------------------------- |
| A    | `tests/fixtures/memory/jev-off-golden.json`         | J0                              |
| M    | `tests/fixtures/governance/activate-trace.json`     | J6（J7 若有，须在其报告中说明） |
| M    | `tests/fixtures/memory-tool-surface.json`（只加行） | J5                              |

`tests/config/__corpus__/{setting-specs-pin,settings-corpus}.json` 在 fixtures 之外，J3 的变化另行核对。任何其它 fixtures 变化 ⇒ 定位到包、打回。

3. **专项复跑**（全量里已覆盖，这里单跑一遍确认无抖动）：`npx vitest run tests/memory tests/conformance/memory-jev-channels.test.ts tests/boundary tests/governance tests/config tests/secure/settings-override.test.ts tests/web-hub/boundary.test.ts`。
4. **门控 conformance**（用户在场、凭证与代理可用时）：`PI_TOOLKIT_JEV_CONFORMANCE=1 PI_TOOLKIT_JEV_PROXY=http://127.0.0.1:7890 npx vitest run tests/conformance/memory-jev-channels.test.ts`。
5. **评测复跑**（E0 已完成时）：`node scripts/dev/jev-eval.mjs --set all --model <default[0]>`，与 `jev-baseline.md` 对比，阈值不变则通过；显著退化回到对应包。
6. Tier 2 失败按 AGENTS.md「Test tiers and flake triage」处理；Tier 1 失败一律是 bug。
7. **架构稿勘误核对**（r1 #8，J9 合入前必须完成）：确认 `jev-arch.md` 已是 v2.1 且 §10 九条全部落回对应章节（§3.1 模块表、§3.3 措辞、§4.5 金样本表、§5.3 off 行、§9.1、§9.4 web 行、§13/§15、§14.2）；对照方法：逐条打开 §10 的「架构稿落点」列。缺任何一条 ⇒ 主会话补勘误后再合 J9。
8. **E0/E1 完成核对**：`docs/dev/memory/eval/jev-baseline.md` 存在且写明结论；E1 若触发已单独 commit。
9. 收尾：J9 合入后再跑一次 `format:check` + 定向 e2e；push 与发版等用户确认（核心规则）。

## 8. 真机验收清单（用户在场时做）

前置：`pi install` 本地分支或 `/reload`；准备一个项目目录（已有 `core.md`）；记下 `~/.pi/agent/memory/<slug>/`。

| #   | 场景                                             | 操作步骤                                                                                                                                                                                                              | 期望现象                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首次可用（full）                                 | 有 opencode 凭证、配好 `memory.jev.proxy`（若需），新开 pi                                                                                                                                                            | 弹一次 `jev on · opencode/jev-1.13 — …脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭`；`/new` 不再弹；`/reload` 后的新 activation 再弹一次                                                                                                                                             |
| 2   | 存量打标                                         | 首次 full 后等 1 分钟，`/mem jev`                                                                                                                                                                                     | `tags x/y tagged` 增长到接近总数；`usage` 约 172 次、约 $0.02；`.jev/index.json` 存在，权限 0600，目录 0700                                                                                                                                                                                              |
| 3   | U 召回                                           | 发「帮我把 dev 推到 GitHub」，再发「那发版呢？」                                                                                                                                                                      | 第一条后出现 `── mem U: pitfalls-git › #… ──` 一行标记；第二条召回发版规则（指代生效）；同段不重复注入                                                                                                                                                                                                   |
| 4   | 写入打标回显                                     | 让 agent 写一条「gh 命令也要走代理」                                                                                                                                                                                  | 工具结果出现 `jev: pitfall … · tags network …` 与 `similar:` 行；`/mem jev` pending 不增加                                                                                                                                                                                                               |
| 5   | A 快速通道                                       | agent 执行 `gh pr create --help`（或 `git push --dry-run`）                                                                                                                                                           | 工具结果后出现 `── mem A: … ──`，不调 Jev（`/mem jev` 的 calls 不变）                                                                                                                                                                                                                                    |
| 6   | 门禁拦一次（gate 已于 2026-11 移除，以下为历史） | `core.md` 有「push 需用户确认」规则；让 agent `git push --dry-run`                                                                                                                                                    | 第一次被 `[memory gate]` 拦，规则正文以 `[memory]` 消息给出；agent 看过后重试放行                                                                                                                                                                                                                        |
| 7   | release.sh hold（gate 已移除，历史）             | 写规则 `<!-- mem user gate=hold -->`「release.sh 运行期间禁止 commit/tag/切分支」；后台跑 `bash scripts/release/release.sh --dry-run`（或一个 `sleep` 冒充的 `release.sh`），让 agent `git commit --allow-empty -m t` | 被 `[memory gate·hold]` 拦，reason 带脱敏后的 job 命令行；重复重试立即被拦且不再出现规则正文；`/mem jev` 的 calls 不增长；任务结束后再提交放行                                                                                                                                                           |
| 8   | release.sh 在另一终端                            | 同 7，但在另一个终端（Linux）手动跑                                                                                                                                                                                   | Linux：同样被拦；macOS：不拦，`/mem jev` 显示 `process evidence: bash jobs only (non-Linux)`                                                                                                                                                                                                             |
| 9   | partial（451/402）                               | 去掉代理（或用余额为 0 的凭证）后 `/reload`                                                                                                                                                                           | 弹一次 `jev partial (451) — …（142/150）`；`/mem` 显示 `jev: partial (451) · fast path …`；`/mem jev` 分「stopped / running」两栏；用户消息不再等待；第 5 步仍注入且标记带 `·partial`；第 7 步仍按证据拦，reason 写「Jev 未判定，按证据拦截」；没写 `gate=hold` 的规则放行并出现 `[memory · G unjudged]` |
| 10  | 恢复                                             | 恢复代理，`/mem jev probe`                                                                                                                                                                                            | 提示 `jev recovered · …`；partial 期间新写的条目在后台补打（pending 归零）                                                                                                                                                                                                                               |
| 11  | inactive                                         | 在没有任何分类器凭证的机器/账户上开 pi                                                                                                                                                                                | 不弹任何 jev 通知；`/mem` 显示 `jev: inactive (no classifier credentials)`；行为与升级前一致                                                                                                                                                                                                             |
| 12  | off：总开关                                      | `memory.jev.enabled=false`，`/reload`                                                                                                                                                                                 | `/mem` 无 jev 行；`/mem jev` 落到默认列表；工具描述无 `<!-- mem` 语法句；无任何 `mem U/A` 标记                                                                                                                                                                                                           |
| 13  | off：legacy                                      | `memory.layout="legacy"`（jev 保持默认 true），`/reload`                                                                                                                                                              | 与 12 相同的「无 jev」现象                                                                                                                                                                                                                                                                               |
| 14  | secure 域强制关闭                                | `pi-secure run <vault>` 进入加密会话，设置文件写 `memory.jev.enabled=true`                                                                                                                                            | 无 jev 通知、无 `.jev/` 目录、`/mem` 无 jev 行；`/agent settings` 显示的值即使为 true 也不生效（D8）                                                                                                                                                                                                     |
| 15  | 代理键                                           | `memory.jev.proxy="http://user:pass@127.0.0.1:7890"`，`/reload`，`/mem jev`                                                                                                                                           | 可用；任何输出中代理凭证显示为 `http://***@127.0.0.1:7890`；改成 `socks5://…` ⇒ 视为未配置并提示                                                                                                                                                                                                         |
| 16  | 整理                                             | 把 `memory.jev.review.intervalDays` 设为 0 后 `/mem review --run`（或等周期触发）                                                                                                                                     | 启动提醒/结果出现 `jev N suggestions — /mem review`；选「删除被取代的一条」后文件更新、`/mem restore --trash` 可找回；选「保留」后不再提示                                                                                                                                                               |
| 17  | 到期                                             | 写一条 `<!-- mem expires=2026-10-01 -->`                                                                                                                                                                              | 新会话启动提醒含到期数；`/mem doctor` 出现 D17；`/mem expired` 可延期 30 天                                                                                                                                                                                                                              |
| 18  | 用户令守卫                                       | 让 agent 改写一条手写文件里的规则                                                                                                                                                                                     | 弹确认框；拒绝后工具报「用户令只有用户能作废…」，文件不变                                                                                                                                                                                                                                                |
| 19  | 子会话                                           | 派一个子 agent 做「推一下 dev」                                                                                                                                                                                       | 子会话首轮出现派单召回标记；子会话不弹通知、不写 `.jev/`；子会话的 push 同样受门禁                                                                                                                                                                                                                       |
| 20  | web（若做 J9 web 分支）                          | web-hub 打开该会话                                                                                                                                                                                                    | 注入显示为一行紧凑标记；`/mem jev` 在 web 执行允许，`/mem jev probe`、`/mem tags add …` 需确认（Q35）                                                                                                                                                                                                    |
| 21  | classifiers 为空 / 全非法（Q34）                 | ① `memory.jev.classifiers=""`，`/reload`；② 改成 `"foo, bar baz"`，`/reload`；③ 恢复默认                                                                                                                              | ① 与第 12 行相同的「无 jev」现象，无任何提示；② 同样无 jev，但新会话启动提醒出现一行 `memory.jev.classifiers: all entries invalid (foo, bar baz) — jev off`；③ 恢复正常                                                                                                                                  |
| 22  | 预算耗尽 partial(budget)                         | `memory.jev.maxCalls=5`，`/reload`，连发几条消息直到超过 5 次调用                                                                                                                                                     | 弹一次 `jev partial (budget) …`；`/mem jev` 显示 `partial (budget)` 与 `usage 5 calls`；之后消息不再等待、calls 不再增长；A 层与证据档照常；`/reload` 后预算重置                                                                                                                                         |
| 23  | `nogate` 逃生口                                  | 在第 6 行的「push 需用户确认」规则行尾加 `<!-- mem user nogate -->`，再让 agent `git push --dry-run`                                                                                                                  | 不再被拦，也不注入「未判定」；去掉 `nogate` 后恢复拦一次                                                                                                                                                                                                                                                 |
| 24  | web 端 `/mem review`                             | web-hub 中执行 `/mem review`、`/mem review --list`、`/mem expired`                                                                                                                                                    | `--list` 直接执行并显示建议清单；`/mem review` 与 `/mem expired` 先弹确认，确认后不报错，输出清单加「在终端执行 /mem review 逐条处理」，文件不变                                                                                                                                                         |

## 9. 文档交付

### 9.1 `docs/dev/memory/README.md`（J9 追加一节「Jev（`src/memory/jev/`）」）

- **不变式**：
  1. Markdown 记忆文件是唯一权威数据源；`.jev/` 是可丢弃的派生侧车，以条目内容哈希为键，Jev 从不写行内注释。
  2. `jevWired` 判定（§1.1）为假时，`wireMemory` 与 Jev 之前逐字节相同——由 `tests/fixtures/memory/jev-off-golden.json`（A′，永不重生）证明；唯一例外是 Q34 的「classifiers 全部非法」启动提醒一行。`off(pi-api)` 由同一 golden 的 `pi-api` 配置加只许追加的允许差异清单证明。
  3. 全仓只有 `jev/client.ts` 调用 `classify()`；`ctx.modelRegistry` 每次从 ctx 取，不跨 activation 缓存。
  4. `jev/*` 除 `wire.ts`、`segment.ts` 外 pi-free（`tests/boundary/pi-free.test.ts`）；`settings.ts` 不新增 import。
  5. 进程级共享只有健康表（32 项）与令牌桶；其余缓存属于 `wireJev` 闭包。
  6. `tool_call` handler 整体 try/catch、粗筛在第一个 await 前完成；异常放行。`before_agent_start` 只返回 `message`；`tool_result` 恒返回 `undefined`。
  7. 侧车合并只在 `withMemoryDirLock` 内同步完成，Jev 调用绝不进锁。
  8. 外发先截断后脱敏；文件正文、成功工具结果、system prompt、助手消息与推理永不外发；`private`/`secret` 条目整条剔除；进程证据只收录被点名程序且仅 Linux。
  9. secure/locked 域双重关闭（D8 + 不接线）。
  10. 注入只走消息通道、只追加；customType `subagent:memory-inject` 的 details 只追加字段。
- **门禁**：`tests/memory/jev/**`、`tests/memory/{tool-v2-jev,command-jev,doctor-jev,inject-jev}.test.ts`、`tests/integration/memory-jev-*.test.ts`、`tests/conformance/memory-jev-channels.test.ts`（C-J1–C-J15；C-J7 真实调用 / C-J8 / C-J15 由 `PI_TOOLKIT_JEV_CONFORMANCE=1` 门控）、`tests/boundary/pi-free.test.ts`、`tests/governance`；评测 `node scripts/dev/jev-eval.mjs`（Tier 3）。
- **残留风险**：非 Linux 无跨终端进程证据；Jev 判断质量依赖评测；默认开启使工具描述一次性变化；dismissed 改写开头会重新提示。
- 「何时读」头部加 `src/memory/jev/**`、`memory.jev.*`。

### 9.2 `docs/guide/memory.md`（J9，面向用户，中文）

- Jev 是什么、四个出场时刻（取 arch §16.2 精简）；首次启用会提示、数据会脱敏外发、如何关闭（`memory.jev.enabled=false`）。
- 状态 `full / partial / inactive / off` 各自含义与 `/mem`、`/mem jev` 怎么看；`·partial` 标记的意思。
- 行内注释语法表（`user|lesson`、`expires`、`until`、`gate|gate=hold|nogate`、`tags=+a,-b`、`private`）与两个示例。
- 命令：`/mem jev [probe|retag [--all]|reset-index]`、`/mem tags …`、`/mem review [--run|--list]`、`/mem expired`。
- 设置键 14 个（默认值以代码为准）；代理键只支持 `http://`。
- **平台退化**：非 Linux 只看本会话后台任务，另一个终端里的 `release.sh` 检测不到。
- 成本量级：每条用户消息约 $0.0005；首次打标约 $0.02。

### 9.3 其它

- `skills/memory-jev/SKILL.md`（J5）。
- `AGENTS.md` peer bump checklist 第 2 条追加 `memory-jev-channels.test.ts`（J9；§10 #4）。
- `docs/dev/data-encryption/README.md` D8 清单（J3）。

## 10. 需回架构稿处理

以下各条均不改变设计意图，只是架构稿表述与实施现实之间的落差。不设「备案」选项：每条都必须落回架构稿；本轮已由架构师先行勘误为**架构稿 v2.1**，主会话在 J9 合入前按 §7 第 7 步逐条核对。

| #   | 架构稿落点                | 问题                                                                                                                                                                                                                                                                                                                                                                                          | 本方案的处理                                                                                                                                                    | 状态                  |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | §4.5 金样本表             | 漏列 `tests/config/__corpus__/settings-corpus.json`：它逐字节 pin `DEFAULT_SETTINGS` 与 `loadSettings` 输出，新增 `memory.jev` 必然变化                                                                                                                                                                                                                                                       | J3 按 `4758bae5` 先例重 pin                                                                                                                                     | 已勘误（架构稿 v2.1） |
| 2   | §5.3 状态表 `off(pi-api)` | 表中 `off` 一律「不注册」，但 `pi-api` 只能在 ctx 上判出，此时注册已发生                                                                                                                                                                                                                                                                                                                      | 设置期 off（disabled / legacy / secure / empty-list）不注册；`pi-api` 已注册但 handler 惰性、`/mem` 显示 off(pi-api)；off golden 第 5 配置证明（§1.1、J0）      | 已勘误（架构稿 v2.1） |
| 3   | §3.1 模块表、§15 文件域   | (a) web 策略要改 `src/web-hub/agent/command-policy.ts` ⇒ J4→J8 串行；`command-usage.ts` 不改以保 I9。(b) J5、J8 端口的生产接线必须改 `src/memory/index.ts` ⇒ 放到 J7（J6 之后串行）。(c) tidy 规则要穿过 `tidy/command.ts`、`tidy/batch-command.ts` ⇒ 列入 J8。(d) 新增 pi-free 文件 `jev/{config,tagging,command-port,write-port,review-command,expired-command,entry-edit}.ts` 未列在模块表 | 按本方案执行                                                                                                                                                    | 已勘误（架构稿 v2.1） |
| 4   | §13、§15                  | §13 说 C-J1–C-J15 纳入 peer bump 清单，但没有包改 `AGENTS.md`                                                                                                                                                                                                                                                                                                                                 | J9 改 checklist 第 2 条（并按 r1 #12 登记 `memory-tool-surface.json`）                                                                                          | 已勘误（架构稿 v2.1） |
| 5   | §9.1 默认值、§10          | §10 写「J0 先跑出基线，再据此定阈值」，与 §9.1 已给出的 0.7 / 0.6 默认值、默认列表的先后关系不清                                                                                                                                                                                                                                                                                              | J3 不等基线，先用架构稿默认值与 §5.2 两个 opencode id；基线（E0）建议调整时主会话在 E1 回架构稿 + `ask_user` 后单独改                                           | 已勘误（架构稿 v2.1） |
| 6   | §9.1 `confirmTimeoutS`    | 秒键需登记 `TIME_SETTING_MS_PATHS`（内部 `confirmTimeoutMs`）                                                                                                                                                                                                                                                                                                                                 | J3 登记                                                                                                                                                         | 已勘误（架构稿 v2.1） |
| 7   | §14.2 N1                  | 已由 Q33 拍板为 (a)，架构稿仍标「新待拍板」                                                                                                                                                                                                                                                                                                                                                   | J7 验收标准按 (a)                                                                                                                                               | 已勘误（架构稿 v2.1） |
| 8   | §3.3、§5.3 `empty-list`   | §3.3「确定性部件只受总开关控制」与 §5.3「off(empty-list) 不注册」对空列表时确定性部件是否生效有歧义                                                                                                                                                                                                                                                                                           | Q34 拍板：空列表 = 总开关关闭；非空但全部非法 ⇒ 启动提醒一行提示（J3/J8/J7）                                                                                    | 已勘误（架构稿 v2.1） |
| 9   | §9.4 web 端               | 架构稿写「其余拒绝」；方案让改状态的子命令走 confirm，且放行只读的 `mem tags` 裸形式                                                                                                                                                                                                                                                                                                          | Q35 拍板「需确认」：只读子命令 allow，改状态子命令 confirm；只有纯终端交互、无文本回退的子命令才 deny（本期无此类；review/expired 在 web 降级为清单）（J4、J8） | 已勘误（架构稿 v2.1） |

## 11. 评审 r1 处置表

| #   | 处理                                                                                                                               | 落点                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | 采纳：J3 只等 J0 合入、不等基线；默认列表用 §5.2 两个 opencode id；阈值微调与 openrouter 项拆成主会话旁路 E1；批次数与关键路径不变 | §0、§3、§4 J0/J3、§7 第 8 步、§10 #5 |
| 2   | 采纳（Q35 拍板「需确认」）：保留 confirm 做法，列为第 9 条回架构稿，架构师已勘误 §9.4                                              | §4 J4/J8 验收、§8 #20/#24、§10 #9    |
| 3   | 采纳：`expiredEntries` / `untilEntries` 前移到 J1 `entries.ts` 并冻结，J6 与 J8 都消费                                             | §2、§4 J1/J6/J8                      |
| 4   | 采纳：表头声明「无名类型一律由 J1 contracts 定义」并逐个补登，例外只有 `GitRunner` 与 `OffRecord`                                  | §2                                   |
| 5   | 采纳：off-harness 增加第 5 个配置 `pi-api`，逐字段比对 + 只许追加的允许差异清单（J0 建、J6/J7 追加）                               | §1.1、§2、§4 J0/J6/J7、§6、§9.1      |
| 6   | 采纳（Q34）：空列表 = off；非空但全部非法 ⇒ 启动提醒一行；J3 解析记录 `classifiersRejected`，J8 渲染，J7 接线                      | §1.1、§4 J3/J7/J8、§8 #21            |
| 7   | 采纳：改「7 批」；接线表述改为「commandPort 由 J6 接线，write/doctor 端口与描述变体由 J7 接线」                                    | §0                                   |
| 8   | 采纳：去掉「或备案」；九条已由架构师勘误为 v2.1，主会话在 J9 合入前逐条核对                                                        | §7 第 7 步、§10                      |
| 9   | 采纳：真机验收补 #21 classifiers 空/全非法、#22 partial(budget)、#23 `nogate`、#24 web 端 `/mem review` confirm 与降级             | §8                                   |
| 10  | 采纳：J6 拆包预案（触发条件、J6a 状态与装配 / J6b 召回、排除清单由主会话先行 commit）                                              | §4 J6 第 8 条                        |
| 11  | 采纳：§1.4 注明自验收窄理由；§3 写明 L3 HARD 闸门与 todo 由主会话负责                                                              | §1.4、§3                             |
| 12  | 采纳：J9 把 `tests/fixtures/memory-tool-surface.json` 登记进 AGENTS.md「Frozen artifacts」B 级行                                   | §4 J9                                |

## 12. v2 变更记录（2026-10-30）

| 位置     | 变更                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 头部、§0 | 版本升 v2；输入加 Q34/Q35；「8 批」改「7 批」；新增旁路 E0/E1 说明；端口接线表述改为按端口分 J6/J7                          |
| §1.1     | 补 Q34 `empty-list` 语义与「全部非法」提示例外；`off(pi-api)` 指向 off golden 第 5 配置                                     |
| §1.4     | 注明自验收窄为定向测试的理由                                                                                                |
| §2       | 表头声明无名类型归属；补登 13 个类型、`expiredEntries`/`untilEntries`、`GitRunner`、off-harness 导出、`classifiersRejected` |
| §3       | 批次图加 E0/E1 旁路；J3 不等基线；L3 闸门与 todo 由主会话负责                                                               |
| §4 J0    | 第 5 个重放配置 `pi-api` 与 `PI_API_ALLOWED_DIFF`；评测基线移出 J0 验收（归 E0）                                            |
| §4 J1    | 新增 `expiredEntries`/`untilEntries` 及验收与测试                                                                           |
| §4 J3    | 依赖改为只等 J0 合入；新增 `classifiersRejected` 字段与 Q34 验收                                                            |
| §4 J4    | web 策略验收按 Q35 改写（只读 allow、改状态 confirm、无 deny）                                                              |
| §4 J6    | 文件域加 off-golden 测试（只扩充允许差异清单）；到期数用 J1 纯函数；拆包预案                                                |
| §4 J7    | 接线加 Q34 `settingsWarnings`；文件域加 off-golden 测试；验收加 Q34 与 pi-api 允许差异                                      |
| §4 J8    | `createStartupReminder` 加 `settingsWarnings`；D17 改用 J1 纯函数；web 降级与策略验收按 Q35                                 |
| §4 J9    | AGENTS.md 增加 B 级登记 `memory-tool-surface.json`                                                                          |
| §6       | J6 spec 加 off-golden 测试；记录 v2 重跑结果；写明该测试文件的串行持有顺序                                                  |
| §7       | 新增第 7 步架构稿勘误核对、第 8 步 E0/E1 核对；评测复跑以 E0 完成为前提                                                     |
| §8       | #20 补 `/mem tags add` 需确认；新增 #21–#24                                                                                 |
| §9.1     | 不变式 2 补 Q34 例外与 pi-api 证明方式                                                                                      |
| §10      | 新增第 9 条（web 端 confirm，Q35）；#5、#8 按拍板改写；九条状态均为「已勘误（架构稿 v2.1）」；去掉「或备案」                |
| §11、§12 | 新增 r1 处置表与本变更记录                                                                                                  |
