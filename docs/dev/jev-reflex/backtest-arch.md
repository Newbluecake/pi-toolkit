# Jev Reflex · #25 历史回测、草案生成与运行时草案加载 · 架构设计

> 状态：架构设计（无代码）· 2026-11-05 · 上游：`arch.md`（A）、`plan.md`（P）、`feasibility.md`（F）、`README.md`（R-I1…R-I12）。
> 冲突时以本文为准；本文**只**改写 R-I12，另外覆盖 U5（P §0）。其余不变式原样有效。

## 0. 用户拍板（2026-11-05，不再讨论）

1. **离线生成 + 回测**：从历史会话聚类意图并生成草案。草案只能映射到已有 4 个 port（`jobs.list` / `fleet.status` / `quota.summary` / `git.status`）。内置脚本加草案一起回放历史问句，输出命中 / 模糊 / 否决 / 未命中，以及疑似误命中清单；agree / diverge 用模型**当轮**工具形状计算。改模板后几秒内能重测。
2. **运行时加载草案**（实验开关，默认关）：草案只跑 shadow，任何情况下都不自动作答（id 写进 `autoResolve` 也不行）。允许打破 R-I12，但要加额外校验和安全门禁。
3. **晋升口径（覆盖 U5）**：问法与分歧的证据可以用回测样本（≥50 条、分歧 ≤5%、误命中经人工看过）；port 可靠性只需实时 shadow ≥10 次且全部成功；纠正和重复提问仍须为 0。草案要自动作答，仍须由人改写进 `catalog.ts`（`origin:"builtin"`、升版本），走 PR。

## 1. 背景与目标

- **问题**：R3b 的晋升证据只能来自实时 shadow。≥50 条候选要攒约 2 周，而且每次改模板（升 `scriptVer`）都会清零。内置 4 个脚本的问法是人写的，覆盖面没有数据依据。
- **目标**：①把历史会话变成可反复回放的问句语料，几秒内给出「模板 × 历史」的命中 / 误命中结果；②从语料机器起草新问法，产出草案（`origin:"extracted"`）；③草案可以在本机以 shadow 方式加载，积累实时证据；④晋升判定合并回测证据和实时证据，结论仍只是建议，由人落 PR。
- **约束**：I4（无模块态）、I8（`core/**` 与 `ports/*.ts` pi-free 值闭包）、I9（关 ⇒ 字节不变）、I11/D8（secure / locked 强制关）、I1/I5（加载有界、计时器 unref）、PD10（pi 进程内不扫目录）、R-I3（草案路径同样不 `sendUserMessage` / transform）。

## 2. 现状摘要

| 能力               | 坐标                                                                                           | 本设计如何用                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 归一化 / 摘要      | `src/reflex/core/{normalize,digest}.ts`                                                        | 原样复用：回测 digest 与实时 record 同口径                         |
| S0 否决            | `core/gate.ts` `evaluateGate(GateFacts)`                                                       | 原样复用，事实由离线近似填入（§4.2）                               |
| S1 匹配            | `core/match.ts` `compileCatalog`                                                               | 原样复用；草案另编译一个 matcher                                   |
| 一致性             | `core/agreement.ts` `collectToolShapes`/`judgeAgreement`                                       | 原样复用；`BranchEntryLike` 适配器从 `wire.ts` 下沉到 core（§4.1） |
| 纠正 / 重复        | `core/state.ts` `detectCorrection`；`core/promotion.ts` `countCrossSessionRepeats`             | 原样复用                                                           |
| 校验               | `core/schema.ts` `validateScript`/`validateCatalog`/`regexSourceProblems`                      | 复用，并新增 `validateDraft`（更严）                               |
| 晋升               | `core/promotion.ts`（U5 唯一实现）、`scripts/dev/reflex-shadow.mjs`、`core/shadow-scan.ts`     | 新增合并判定，旧函数保留                                           |
| 形状 / 脱敏 / 子句 | `src/memory/jev/predict/{shape,clauses}.ts`、`src/memory/jev/redact.ts`（均 pi-free）          | 聚类签名、报告首行脱敏                                             |
| agentDir           | `src/core/agent-dir.ts` `resolveAgentDir`（pi-free）                                           | 草案 / 缓存 / 评审文件根                                           |
| 运行时             | `src/reflex/wire.ts`（`scriptById`、`stateOf`、`scheduleShadowPort`、`runAuto`）、`command.ts` | 新增草案 shadow 分支与 `/reflex drafts`                            |
| D8                 | `src/config/settings.ts:453` `applySecureDomainOverrides`                                      | 追加一行                                                           |

**本次实读得到的语料事实**（`~/.pi/agent/sessions`：95 个 cwd 目录、1385 个文件、1.6 GB；F §3.2 的统计口径可以复用）：

- user 消息**没有 source 字段**（只有 `role/content/timestamp`），来源只能从结构上推断。
- user 条目的 `parentId` 通常指向 `pi-hud-llm-time` 这类 custom 条目，而不是 assistant。web / 飞书输入的直接父条目是 `custom:subagent:web-origin`（大会话里约 20%）。topic-switch 重放的父条目是 `custom:subagent:topic-switch`，wake 注入的父条目是 `custom:subagent:wake-level`。
- **fork 会话（header 带 `parentSession`）会整段复制祖先条目，`id` 和 `message.timestamp` 都不变。** 不去重的话，同一问句会重复计数。现有 `reflex-shadow.mjs` 也受影响：fork 出来的 record 会被当成「跨会话重复」（delta=0），导致永远判不合格。这是既有缺陷，B5 顺手修掉。
- 单行且 ≤120cp 的 user 消息约占 75%，多行约 19%（多行会被 S0 #10 直接否决）。

## 3. 总体设计

```
离线（Tier 3，pi 进程外）                                    运行时（pi 进程内，reflex.drafts.enabled）
scripts/dev/reflex-backtest.mjs                             src/reflex/wire.ts
  │ import dist/reflex/core/backtest/*.js                     ├─ builtin matcher（不变）── miss ──► draft matcher
  ▼                                                           │                                     │ high/ambiguous
core/backtest/corpus.ts   jsonl 行 → Turn（去重/来源/形状）     │                                     ▼
core/backtest/replay.ts   Turn × Matcher → ReplayRow          │                   pending{state:"shadow",origin:"draft"}
core/backtest/cluster.ts  Turn[] → Cluster[]                  │                   → scheduleShadowPort（不进 runAuto）
core/backtest/draft-gen.ts Cluster → RScriptV1(extracted)     └─ src/reflex/drafts/load.ts（异步一次性、有界、fail-closed）
core/backtest/evidence.ts 回测统计 + 实时统计 + 评审 → 合并输入        ▲ 读 <agentDir>/reflex/drafts/*.json
core/promotion.ts         evaluateMergedPromotion（唯一判定）         │
        │ 写                                                         │ 人工复制或由脚本 --emit 写入
        ▼                                                            │
<agentDir>/reflex/{cache/corpus-v1.jsonl, drafts/*.json, reviews/*.json, reports/*.md}  (0700 目录 / 0600 文件)
```

- **依赖方向**：`scripts → dist/reflex/core/**`（pi-free），`wire.ts → drafts/load.ts → core/draft-schema`。`core/backtest/**` 位于 `src/reflex/core/**` 之下，**自动**纳入现有值闭包 pi-free 门禁（`tests/boundary/pi-free.test.ts:178` 的 glob），不需要改门禁。`src/reflex/drafts/load.ts` 只用 `node:fs`，为它新增一条同款值闭包门禁。
- **为什么不在 pi 内做 `/reflex backtest`**：语料扫描 1.6 GB，I/O 不可控（PD10），而且会话文本不该被加载进 pi 进程。pi 内只提供 `/reflex drafts`（列出已加载 / 被拒的草案），不扫描语料。

## 4. 接口契约

### 4.1 共享适配器下沉（消除复制）

`wire.ts` 里的 `toBranchLike(entries)` 原样移到 `src/reflex/core/branch-like.ts`，导出 `toBranchLike(entries: readonly unknown[]): BranchEntryLike[]`。`wire.ts` 改为 import，行为逐字节不变（现有 `wire-shadow` 测试兜底）。离线 corpus 与实时 `agent_settled` 从此共用一份「条目 → 工具形状」逻辑。

### 4.2 语料：`core/backtest/corpus.ts`

```ts
export type TurnOrigin = "tui" | "web" | "replay" | "injected" | "steer";
export interface Turn {
  session: string; // 会话 id（header.id），不放文件路径
  entryId: string;
  at: number;
  settledAt: number; // settledAt = 本轮最后一个 assistant 条目的时间
  cwd: string; // 只用于 --cwd 过滤，报告里不输出
  text: string; // 原文（仅在内存和 0600 缓存里），报告永不输出
  digest: string; // requestDigest(normalizeInput(text).norm)
  imageCount: number;
  origin: TurnOrigin;
  shapes: readonly string[]; // collectToolShapes(toBranchLike([user, ...本轮 assistant]))
  toolCount: number;
  hasWrite: boolean; // edit/write/Agent/ask_user
}
export interface CorpusFilter {
  since: number;
  until: number;
  cwd?: string;
}
/** 逐文件喂行，内部按 parentId 归属轮次；跨文件按 `${entryId}\0${message.timestamp}` 去重（先到先得）。 */
export function createCorpusBuilder(f: CorpusFilter): {
  beginFile(session: string, header: unknown): "skip-child" | "ok";
  line(raw: string): void;
  endFile(): readonly Turn[];
};
```

**轮次归属**：每个条目继承父条目的 turnId；遇到 user 条目开新轮。分叉和 compaction 天然正确，复杂度 O(n)。

**来源判定**（冻结常量表 `ORIGIN_MARKERS`，每一项配一个 fixture 测试；另加一条治理测试：每个 marker 字面量必须仍出现在 `src/**` 里，防止改名后静默失效）：

| 条件（沿 parentId 向上，跳过非 `message` 条目，直到遇到第一个 `message`）                                                                                | origin     | 回测处理                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| 途经 `custom:subagent:web-origin`（web / 飞书 / 托管 spawn）                                                                                             | `web`      | 排除（等价 S0 #1）                                                                    |
| 途经 `custom:subagent:wake-level`；或文本命中 `INJECTED_PREFIXES`（goal / compact-hint / reload / context-switch 的固定文案，从源码常量 import，不复制） | `injected` | 排除                                                                                  |
| 途经 `custom:subagent:topic-switch`                                                                                                                      | `replay`   | **保留**：原句是人在 TUI 输入的，实时链路里 reflex 排在 topic-switch 之前，能看到原句 |
| 第一个 `message` 是 assistant 且 `stopReason==="toolUse"`，或是 `toolResult`                                                                             | `steer`    | 填 `streamingBehavior:"steer"` ⇒ S0 #3 否决                                           |
| 其余                                                                                                                                                     | `tui`      | 进入回放                                                                              |

**文件级排除**：header 后约 64 行内出现 `subagent:child` 自标记，或文件名出现在任一主会话 `subagent:run` 条目的 session 引用里（两遍扫描，复用 `session-nav/provenance.ts` 的判定口径，实现时先确认值闭包 pi-free，不满足就镜像一份），即子会话，整文件跳过。`/命令` 不产 user 消息；skill / 模板展开后是多行，由 S0 #10 / #11 否决。带图输入取 `imageCount`，交给 S0 #5。

**时间 / cwd**：`--days`（默认 30）按 `message.timestamp` 过滤；`--cwd <abs>` 按 header `cwd` 精确匹配（同 R3b，不做 `~` 展开）。

**缓存**：`<agentDir>/reflex/cache/corpus-v1.jsonl`（0600）。只缓存「origin∈{tui,replay,steer} ∧ 单行 ∧ ≤120cp」的 Turn，另附 `{file, size, mtimeMs}` 清单；文件 size 或 mtime 变化才重新解析。缓存与会话文件同属本机明文域，不扩大暴露面；`--no-cache` 可以跳过。缓存格式带 `v` 和 `normalizeVersion`（normalize / shape 改动时手动 bump ⇒ 全量重建）。

### 4.3 回放：`core/backtest/replay.ts`

```ts
export type ReplayClass =
  | { k: "veto"; code: VetoCode; wouldHit?: string } // wouldHit：跳过 S0 直接匹配时的命中脚本（用于调模板）
  | { k: "miss" }
  | { k: "ambiguous"; candidates: readonly string[] }
  | { k: "high"; scriptId: string; layer: "builtin" | "draft"; agree: Agreement };
export interface ReplayRow {
  turn: Turn;
  cls: ReplayClass;
  reasked: boolean;
  corrected: boolean;
  suspect?: SuspectCode;
}
export type SuspectCode = "diverge" | "write-turn" | "other-port" | "reviewed-misfire";
export function replay(
  turns: readonly Turn[],
  cat: { builtin: Matcher; drafts?: Matcher; byId: ReadonlyMap<string, RScriptV1> },
  caps: ReadonlySet<Capability>,
): readonly ReplayRow[];
```

- **两层语义与运行时一致**：先跑 builtin，miss 时才跑 drafts（§4.6）。一致性用 `judgeAgreement(script, turn.shapes)`。
- **离线无法还原的 gate 事实**（报告页眉逐项列出「按宽松假设填入」）：`idle`（取 `origin!=="steer"`）、`pendingMessages=false`、`topicSwitchActive=false`、`goalBusy=false`、`inFlight=false`。`source/mode` 由 origin 推出。这些近似只会**高估**命中，不会低估误命中，方向保守。
- **reasked**：同会话内、同 `scriptKey + digest`，在 `REPEAT_WINDOW_MS` 内再次成为 high 候选，口径同 PD6。**跨会话**用 `countCrossSessionRepeats`（输入已去重，fork 不再误计）。
- **corrected**：用下一条 user Turn（不论 origin）跑 `detectCorrection(norm, memo{settledAt}, at)`，口径同 PD12。注意它衡量的是「模型答错被纠正」，作为问法不贴切的代理信号（见 §8 Q2）。
- **suspect（疑似误命中）**：high 命中且满足任一条件：`agree==="diverge"`；本轮 `hasWrite`；本轮签名映射到**另一个** port（§4.4 签名表）；或评审文件已把这条标为 misfire。
- **耗时**：缓存热时，2 万条 Turn × (gate + match) ≈ 0.2 s（A 的目标 p99 ≤ 1 ms/条，实测远低于此）。

### 4.4 草案生成：`core/backtest/{cluster,draft-gen,regex-safe}.ts`

- **port 签名表**（`PORT_SIGNATURES`，从 `BUILTIN_SCRIPTS` 按 port 汇总 `agreement.tools ∪ bashShapes` **派生**，不手写）。一条 Turn 的 `portLabel` 定义为：签名与恰好一个 port 相交、`!hasWrite`、`toolCount ≤ 3`；否则为 `unmapped`。
- **候选集**：replay 结果为 miss / ambiguous（**内置未覆盖**）的 `tui|replay` Turn，并且 S0 通过。
- **聚类**（确定性，不调模型）：骨架 = `norm` 依次做路径 → `<path>`、数字 → `<n>`、引号内容 → `<q>`；token = CJK 二元组加拉丁词。按频次降序做 leader 贪心聚类，Jaccard ≥ 0.6。簇大小 < `--min-group`（默认 3）丢弃。
- **出草案门槛**：簇内众数 `portLabel` 占比 ≥ 80%（签名同构率），且众数不是 `unmapped`。不达标的簇只在报告里列意图（digest 加截断首行），不出草案。
- **模板生成**（全部由 `regex-safe.ts` 的 `literal()` 转义生成，结构上就能保证合法）：
  - `strong` = 簇内**不同骨架**的全句字面量 alternation。`<n>` → `\d+`，句尾 `(吗|呢)?`。每簇最多 12 条，每条 ≤ 120 字符。
  - `weak` = 簇内覆盖率 ≥ 60%、且在全语料其余部分出现率 ≤ 2% 的 1–3 个 n-gram 字面量。
  - `exclude` = 负样本回灌（见下）。
  - `examples.hit` = 簇成员经 `redactForJev(…,"user")` 加骨架化后的文本，≥ 5 条。`examples.miss` = 负样本文本，不足 5 条时用「`帮我` + hit[0]」这类必被 S0 否决的合成句补齐。
- **负样本回灌**：用草案对全语料做 replay。所有 suspect 行，以及评审文件中 `verdict:"misfire"` 的 digest（通过缓存找回原句）都会生成 `exclude` 字面量（整句转义，作为子串锚点），然后迭代至多 3 轮，直到 suspect 中不再有新出现的。回灌只会**收紧**模板，不会放宽。
- **其余字段**：`port.id`、`requires`、`agreement`、`render` 全部取该 port 的规范值（`PORT_DEFAULTS`，从 builtin 派生）；不写 `budgetMs`；`version: 1`；`id = "draft." + slug(port, 簇序号)`。**永不输出 argv**：rscript/1 根本没有这个字段，`validateDraft` 也会拒绝未知字段。
- **安全子集 `draftRegexProblems(src)`**（`validateDraft` 在 `regexSourceProblems` 之上追加）：长度 ≤ 160；禁止 `*`、`{`、反向引用 `\1-9`、lookaround `(?=` `(?!` `(?<`；`+` 只允许紧跟单原子（`\d`、`\s`、字符类、单个字面字符）；每条源最多 8 个 `?`。这样就没有可回溯的重复组，单条匹配的路径数 ≤ 2⁸，加上 S0 #9 的 120cp 上限，ReDoS 有界。生成器只产出这个子集，手改草案时由校验兜底。

### 4.5 草案文件与校验：`core/draft-schema.ts`

- **位置**：`<agentDir>/reflex/drafts/*.json`（`resolveAgentDir(process.env, homedir())`）。目录 0700，文件 0600。脚本 `--emit` 写入时用 tmp + rename；`--emit` 默认关闭，默认只写到 `reports/` 旁边的 `drafts-out/` 供人挑选后复制。
- **格式**：单个 JSON 对象，就是一个 `RScriptV1`，`origin:"extracted"`。不加信封，元数据（簇统计、生成时间）写进报告。
- **`validateDraft(raw, builtinIds) → RScriptV1 | DraftReject`**（纯函数，不抛异常）的规则：
  1. `validateScript` 通过，且对象**没有** schema 之外的键（白名单逐层比对，防止夹带 argv / env 等字段）；
  2. `origin==="extracted"`，`risk==="readonly"`；
  3. `id` 匹配 `^draft\.[a-z0-9-]+$`，不在 `builtinIds` 里，草案之间不重复；
  4. `port.id` ∈ 4 个 MVP port（排除 `sessions.recent`）；`requires`、`agreement`、`render` 与 `PORT_DEFAULTS[port]` **逐字段相等**，杜绝通过改 agreement 刷出 agree；
  5. 没有 `budgetMs`；条目数 strong ≤ 12、weak ≤ 8、exclude ≤ 32、hit / miss 各 5–20 条；
  6. 每条正则源通过 `regexSourceProblems` 和 `draftRegexProblems`；
  7. **例句自检**：单独编译这一份草案，`examples.hit` 必须全部为 `high`，`examples.miss` 必须全部被 `evaluateGate`（理想 TUI 事实）否决或匹配为非 high。耗时 < 1 ms，加载时必跑。
- **配套**：`validateCatalog` 追加一条规则：builtin 的 id 不得以 `draft.` 开头（命名空间双向隔离；人把草案改写进 catalog 时必须换 id 或并入现有脚本，并升 version）。
- **文件级上限**：最多 16 个文件，单文件 ≤ 16 KiB。必须是普通文件（`lstat`，拒绝 symlink），`uid === process.getuid()`，`mode & 0o077 === 0`。超出上限的按文件名排序截断，并计 `rejected:"cap"`。
- **`draftHash`**：对规范化 JSON（键排序）做 sha256，取前 16 hex。离线证据按 `id@ver#hash` 分组：手改草案却忘了升 version 时，证据不会混在一起。

### 4.6 运行时加载

**设置**：`ReflexSettings` 追加 `drafts: { enabled: boolean }`，默认 `{enabled:false}`，键 `reflex.drafts.enabled`，`bool(...)`，**非 live**（`/reload` 生效），追加在 `REFLEX_SETTING_SPECS` 末尾。`applySecureDomainOverrides` 追加 `reflex: { ...settings.reflex, enabled:false, drafts:{enabled:false} }`（D8 双保险，并加入 `tests/secure/settings-override.test.ts`）。子会话本来就是 post-guard，不可达。

**加载**（`src/reflex/drafts/load.ts`）：

```ts
export interface DraftLoadResult {
  drafts: readonly LoadedDraft[];
  rejected: readonly { file: string; code: DraftRejectCode }[];
}
export interface LoadedDraft {
  script: RScriptV1;
  hash: string;
}
export type DraftRejectCode =
  | "cap"
  | "not-regular"
  | "perm"
  | "size"
  | "json"
  | "schema"
  | "namespace"
  | "port-mismatch"
  | "regex"
  | "examples"
  | "duplicate"
  | "timeout";
/** 永不抛、永不 reject；总预算 DRAFT_LOAD_BUDGET_MS=500，经 clampSpanMs + 注入 Clock（unref）；超时 ⇒ 全部丢弃（rejected:"timeout"）。 */
export function loadDrafts(
  dir: string,
  builtinIds: ReadonlySet<string>,
  clock: Clock,
  signal: AbortSignal,
): Promise<DraftLoadResult>;
```

- **时机**：在 `wireReflex` 里，`deps.settings().drafts.enabled ∧ secureDomainKind==="plain"` 时启动**一次**（不 await）。结果写进闭包里的 `drafts` 变量（I4 / R-I8）。加载完成前 `draftMatcher` 为 `undefined`，相当于没有草案。不提供进程内重扫：要改草案就 `/reload`，模板迭代在离线脚本里完成（§4.8）。
- **fail-closed**：单个草案被拒只影响它自己，计入 `rejected` 并记 `counters["drafts.rejected"]`，内置脚本不受任何影响。整体异常或超时等同于零草案。被拒的草案在 `/reflex drafts` 和 `/reflex status` 里各报一次，不 notify 刷屏。
- **wire 分支**（插在 `if (m.kind === "miss") return CONTINUE;` 处）：

```ts
if (m.kind === "miss") {
  const dm = draftMatcher?.match(gate.norm.norm, registry.capabilities());
  if (dm === undefined || dm.kind === "miss") return CONTINUE;
  // 草案路径：state 恒为字面量 "shadow"；不查 stateOf/autoResolve；不进 runAuto；不计 strike。
  return enterDraftShadow(dm, gate.norm, now, ctx); // 同步 CONTINUE；high ⇒ scheduleShadowPort；ambiguous ⇒ 只建 pending
}
```

- **shadow-only 硬保证**（分层）：①草案只存在于 `draftById` / `draftMatcher`，**永不**进入 `scriptById` / `catalog`。`runAuto`、`stateOf`、`runtimes` 的输入只来自这两者，因此类型上不可达。②`enterDraftShadow` 内 `state` 是字面量 `"shadow"`。③id 命名空间：`autoResolve` 里的 `draft.*` 会落进 `unknownAutoResolve`，status 显示「草案不可自动作答」。④测试：`autoResolve=["draft.x"]` 且草案 high 命中时，必须同步 `continue`、零 `sendMessage`、record 的 `state:"shadow"`；另加治理扫描：`runAuto(` 只能有一个调用点，且参数来自 `scriptById`。
- **记录区分**（`ReflexRecordV1` 只追加可选字段，旧读者照常工作）：`origin?: "draft"`（builtin 不写，保持旧形状逐字节不变）、`draftHash?: string`，以及 `port.portId?: PortId`（**所有**新 record 都写，供按 port 统计；旧 record 的 portId 由离线侧经 `BUILTIN_SCRIPTS` 反查）。纠正条目 `ReflexCorrectionV1` 不改，target 是 `draft.*` id 时就能区分。`shadow-scan.ts` 追加对这三个字段的类型校验（宽进：缺省合法）。
- **`/reflex drafts`**：列出 `loaded <id>@<ver>#<hash8> port=<p>` 与 `rejected <file> <code>`。在现有 `registerCommand("reflex")` 内解析子命令，**不改**命令描述、不新增注册。

### 4.7 晋升改造

`core/promotion.ts` 保留 `evaluatePromotion`（`/reflex status` 的本会话视图继续用它），新增唯一的合并判定：

```ts
export const PROMOTION_GATE_V2 = Object.freeze({ minIntentSamples: 50, maxDivergeRate: 0.05, minPortRuns: 10 });
export interface PortReliability {
  portId: PortId;
  runs: number;
  ok: number;
} // 按 port 汇总所有 shadow record（builtin + draft）
export interface ReviewCoverage {
  suspects: number;
  reviewed: number;
  misfires: number;
  listHash: string;
  stale: boolean;
}
export interface MergedEvidence {
  key: string; // 待晋升的 scriptId@ver（builtin 新版本）
  backtest?: {
    judged: number;
    diverge: number;
    reasked: number;
    crossSessionRepeats: number;
    corrected: number;
    review: ReviewCoverage;
  };
  live?: ScriptStats; // 来自 accumulate（可缺）
  port: PortReliability;
}
export function evaluateMergedPromotion(e: MergedEvidence): PromotionVerdict;
```

- **问法证据**：满足以下任一即可。(a) 回测 `judged ≥ 50 ∧ diverge/judged ≤ 5% ∧ review 完整（reviewed===suspects ∧ !stale）∧ misfires===0`（有 misfire 必须先回灌 exclude、升版本、重测）；(b) 实时口径 `live.judged ≥ 50 ∧ divergeRate ≤ 5%`（即旧 U5 的问法部分）。
- **port 可靠性**：**按 port 统计**（推荐、采用）。同一 port 被多个脚本共享时执行的是同一段代码，按 port 统计才能让新版本或新脚本复用已有证据。条件：`runs ≥ 10 ∧ ok === runs`。`runs` 口径沿用 `ok|uncertain|error|timeout`，`unavailable` 不计入（与 P R1-11 一致）。注意 `uncertain` 算「不成功」（§7 风险 3）。
- **零容忍项**：`live.reasked + live.corrected + live.crossSessionRepeats(必须已判定) + backtest.reasked + backtest.crossSessionRepeats + backtest.corrected === 0`（回测侧是否计入见 §8 Q2）。
- **「误命中已人工看过」怎么落地**：评审文件 `<agentDir>/reflex/reviews/<portId>.json`（0600），内容为 `{v:1, entries:[{digest, portId, verdict:"ok"|"misfire", at}], listHash}`。**按 (portId, digest) 记录**，与脚本 id 无关：草案改写成 builtin 后，同一批问句的评审可以沿用。合并判定要求：当前回测的 suspect 集合 ⊆ 已评审集合（`stale` = 有 suspect 不在评审里）。**防伪造**：评审文件只能由 `reflex-backtest.mjs review` 写入；该子命令要求 `process.stdin.isTTY && process.stdout.isTTY`（pi 的 bash 工具和子 agent 都不是 TTY，因此无法代答）；逐条显示截断首行，等人按 y/n；其他模式和任何代码路径都不写这个文件。手改 JSON 属于人的主动行为，不在防护范围内（残留，§7）。
- **脚本分工**：`reflex-backtest.mjs --promote <scriptId>` 一次扫描同时提取 Turn 与 reflex record（复用 `extractReflexRows`），组装 `MergedEvidence` 并调用 `evaluateMergedPromotion`。`reflex-shadow.mjs` 改为：①按 `(entry.id, at, digest)` 去重（修 fork 缺陷）；②新增按 port 的可靠性小节；③结论改用 `evaluateMergedPromotion`（`backtest` 缺省，问法证据只能来自实时口径），JSON 字段只追加。两个脚本调用同一判定，结论不会分叉。
- **流程**：草案（shadow 加回测）→ 人把它改写进 `catalog.ts`（builtin id、升 version）→ `npm run build` → `reflex-backtest.mjs --promote <id>`（对新 builtin 版本重放历史即得问法证据；port 证据按 port 取；评审按 digest 沿用）→ PR → 用户把 id 加进 `autoResolve`。**脚本从不改设置，也不写 catalog。**

### 4.8 迭代体验

```
node scripts/dev/reflex-backtest.mjs [--days 30] [--cwd <abs>] [--drafts <dir>] [--only <id>] [--json] [--no-cache]
node scripts/dev/reflex-backtest.mjs generate [--min-group 3] [--emit]     # 聚类 → drafts-out/（--emit 才写 drafts/）
node scripts/dev/reflex-backtest.mjs review <portId>                        # TTY 专用，写 reviews/
node scripts/dev/reflex-backtest.mjs --promote <scriptId>                   # 合并判定（需先 build）
```

- `--drafts` 默认取 `<agentDir>/reflex/drafts`，草案 JSON 在**运行时读取**，不需要 build。改模板 → 重跑，热缓存 ≤ 3 s（目标）；冷启动全量解析 1.6 GB ≤ 90 s，只需一次。改了 `src/reflex/core/**` 才要 `npm run build`，缺 dist 时 exit 2（同 R3b）。
- **输出**（stdout；`--report` 写 `<agentDir>/reflex/reports/<date>.md`，0600，永不进仓库）：每个脚本一行 `id@ver[#hash] high=… ambiguous=… veto{code:n…} wouldHitButVetoed=… agree/noTool/diverge reasked xs corrected`；再列 suspect 清单，每行 `digest · sessionId8 · entryId · "<首行 ≤24cp，redactForJev+骨架化>" · shapes`。**不输出**路径、命令参数或 session 文件路径（`--locate <digest>` 只在本机打印定位）。
- 拒绝条件：`PI_SECURE_SESSION=1` 或 `PI_SECURE_VAULT` 已设置时 exit 3「secure 域禁用」（D8 精神）。扫描根固定为明文 agentDir 的 `sessions/`，不跟随 symlink（同 R3b）。不联网。

## 5. 关键决策

| #   | 决策                                                      | 否决的备选                             | 理由                                                                                                                                          |
| --- | --------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | 回测逻辑全在 `core/backtest/**`，脚本只做 I/O 编排        | 在 `.mjs` 里重写 gate / match          | 单一实现；自动进入 pi-free 门禁；可做单元测试                                                                                                 |
| K2  | 草案层**只在 builtin miss 时**参与匹配                    | 两层并行、统一定 band                  | builtin 的 pending、agreement、晋升数据与今天逐字节相同；草案和 builtin 重叠部分由离线回测衡量；按 port 统计后，port 证据不依赖草案自己的命中 |
| K3  | 草案的 agreement / render / requires 强制等于 port 规范值 | 允许草案自定义                         | 防止草案通过改 agreement 刷出 agree；草案唯一可调的只有问法                                                                                   |
| K4  | 正则安全子集（无重复组），比 builtin 更严                 | 只用现有嵌套量词扫描                   | 草案来源是机器加手改，可信度低于 builtin；生成器本来也只需要字面量 alternation                                                                |
| K5  | 异步、一次性、有界加载；不做热重载                        | 设置 live 加 `/reflex drafts reload`   | I1 有界；PD10；迭代闭环在离线完成，没必要承担进程内 I/O                                                                                       |
| K6  | port 可靠性按 port 统计                                   | 按脚本统计                             | 同一 port 是同一段代码；按脚本统计会让每个新草案或新版本从 0 攒                                                                               |
| K7  | 评审按 (portId, digest) 记录，靠 TTY 门禁写入             | 按 scriptId 记录 / 允许 `--accept-all` | 改写成 builtin 后评审可沿用；非 TTY 的 agent 无法伪造                                                                                         |
| K8  | 草案文件就是纯 `RScriptV1`                                | 加 `rdraft/1` 信封                     | 与 catalog 同构，人工晋升时直接粘贴改写；元数据放报告                                                                                         |
| K9  | 语料缓存只存单行 ≤120cp 的问句                            | 不缓存，每次全扫                       | 「几秒重测」做不到；缓存内容与会话文件同权限同域                                                                                              |

## 6. 对现有面的影响

- **R-I12 改写为**：「auto 只可能来自内置 catalog（`origin:"builtin"`）；`validateCatalog` 拒绝 `extracted` 和 `draft.*` id。草案（`origin:"extracted"`、`draft.*`）只能在 `reflex.drafts.enabled` 下经 `validateDraft` 加载，**恒为 shadow**，结构上不可达 `runAuto` / `autoResolve`。rscript/1 没有 argv 种类。」README 同步新增 R-I13：「草案加载有界、fail-closed，不影响内置脚本；secure / locked / 子会话不可达。」
- **A 级 `reflex-off-golden.json`**：**不变**。`reflex.enabled=false` 时 `wireReflex` 不被调用；golden 不记录设置对象（已核实：不含 `autoResolve`）。`git diff --quiet origin/dev -- tests/fixtures/` 必须为空。
- **`activate-trace.json`（B）**：**不变**。没有新增注册，`max` 档的 drafts 默认关，trace 只记录注册名。
- **`setting-specs-pin.json` / `settings-corpus.json`**：因追加 `reflex.drafts.enabled` 重 pin。按 README 的规矩：`captured[i].input` 取自 `origin/dev`，生成后程序化比对，只接受新增这一项。
- **`stack-teardown-matrix`**：不变（不新增 shutdown / start 步骤；加载 promise 由 `abort` 联动，迟到结果按 `isStale` 丢弃）。
- **pi-free**：`core/backtest/**`、`core/branch-like.ts`、`core/draft-schema.ts` 自动受门禁约束；`drafts/load.ts` 新增一条值闭包门禁。
- **governance G2 / G3 / G4**：全部仍然适用。G3 要求 `load.ts` 的超时走注入的 Clock；G4 要求草案路径不出现 `sendMessage`（扫描范围扩展到 `drafts/`）。新增 G5：`runAuto(` 只有一个调用点；`draft.` 字面量不出现在 `catalog.ts`。
- **D8**：`applySecureDomainOverrides` 加一行；`wireReflex` 的 `secureDomainKind` 守卫已有；脚本侧做 secure env 拒绝。数据加密 README 的 D8 清单补「reflex.drafts」。
- **types.ts**：只追加 `ReflexRecordV1.origin?` / `draftHash?` / `port.portId?`，以及 `ReflexSettings.drafts`（settings.ts）。

## 7. 实施要点

### 7.1 分包

| 包                | 文件域（独占）                                                                                                                                                                                                                                                                                | 依赖                        | 验收要点                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **B0 契约**       | `core/types.ts`（追加）、`core/settings.ts`、`setting-specs.ts`、`config/settings.ts`（D8 一行）、`core/branch-like.ts`（从 wire 下沉）、`wire.ts`（只改 import）、`core/schema.ts`（builtin 禁 `draft.`）、spec pin / corpus、`tests/secure/settings-override.test.ts`、README R-I12 / R-I13 | —                           | 现有 reflex 测试全绿；golden / trace 不变；pin 只多一项                                                                             |
| **B1 回测核心**   | `core/backtest/{corpus,replay,evidence}.ts` + 测试                                                                                                                                                                                                                                            | B0                          | fork 去重、来源表每行 fixture、steer 判定、轮次归属（含分叉）、宽松事实标注、reasked / corrected / 跨会话口径与实时同函数           |
| **B2 草案生成**   | `core/backtest/{cluster,draft-gen,regex-safe}.ts`、`core/draft-schema.ts` + 测试                                                                                                                                                                                                              | B0                          | 生成物 100% 通过 `validateDraft`；性质测试：随机簇 → 正则恒属安全子集；永无 argv / 未知键；负样本回灌单调收紧                       |
| **B3 脚本**       | `scripts/dev/reflex-backtest.mjs`（含缓存、generate、review、promote）                                                                                                                                                                                                                        | B1、B2、B5 的 evidence 类型 | Tier 3 手动：冷 / 热耗时记入报告；secure env 时 exit 3；`review` 在非 TTY 下拒绝；报告 grep 不到 `/`、`~/` 路径                     |
| **B4 运行时加载** | `src/reflex/drafts/load.ts`、`wire.ts`（草案分支）、`command.ts`（`drafts` 子命令）、`core/shadow-scan.ts`（追加字段校验）、测试 + governance G5                                                                                                                                              | B0、B2（`validateDraft`）   | shadow-only 矩阵（含 autoResolve 写 draft id）；单个坏文件只拒它自己；超时 → 零草案；perm / symlink / 超 cap 拒绝；关闭时零 fs 访问 |
| **B5 晋升合并**   | `core/promotion.ts`（追加 V2）、`scripts/dev/reflex-shadow.mjs`（去重 + 按 port + V2）、README 晋升流程                                                                                                                                                                                       | B0                          | 构造证据矩阵：回测达标但评审 stale ⇒ 不合格；port 9 次 / 有一次 uncertain ⇒ 不合格；fork 副本不产生跨会话重复                       |

可并行：B0 完成后，B1 ∥ B2 ∥ B4 ∥ B5 可同时进行（B4 只依赖 `draft-schema.ts`，建议 B2 先单独提交这一个文件，或者把它前移到 B0）。B3 最后做。

### 7.2 风险

1. **来源推断不完备**：print 模式和未打 marker 的注入会混进 `tui`。缓解：S0 的长度、多行、前缀规则会挡掉大部分注入文案；marker 有治理测试；报告页眉给出各 origin 计数，异常一眼可见。
2. **回测过拟合**：模板从同一批历史生成，再在同一批历史上回测，命中率天然偏高（§8 Q1）。
3. **`uncertain` 算不成功**：`quota.summary` 在没有可信快照时返回 uncertain，可能长期达不到「全部成功」。这是有意的保守取舍。若用户希望 uncertain 不计入，需要显式改口径。
4. **语料缓存含原句**：与会话文件同等暴露面，0600。secure 域会话不在扫描根下，脚本对 secure env 直接拒绝。
5. **评审伪造只防非 TTY agent**：人或 agent 直接手改 `reviews/*.json` 防不住，记为残留。评审文件带 `listHash`，内容不完整时 stale。
6. **gate 宽松近似高估命中**：只影响问法覆盖率的估计，不影响误命中方向；最终仍由实时 shadow 和 0 纠正 / 0 重复兜底。
7. **草案过多拖慢 S1**：上限 16 个文件 × 12 条 strong；草案只在 builtin miss 时才跑，正则走安全子集；`perf.test` 追加一个带满额草案的用例（p99 ≤ 1 ms）。

## 8. 开放问题（需用户拍板）

1. **回测证据是否要求留出集？**（Recommended）按会话 id 哈希 60/40 切分：草案只用训练集生成，晋升的回测样本只计留出集，防止「用答案出题」。备选：全语料都算（样本多，但命中率和分歧率偏乐观）。
2. **历史轮次里的 reasked / corrected 是否计入「=0」？**（Recommended）计入，但只算 high 命中轮次；同时在 suspect 清单里列出，人看过后在评审文件里标 `ok` 即可放行（标 ok 视同人工判定为与问法无关）。备选 A：严格计入、不可豁免（历史上模型答错导致的追问也会卡住晋升）。备选 B：只看实时（回测只提供问法和分歧证据）。
3. **草案默认存放位置？**（Recommended）全局 `<agentDir>/reflex/drafts/`（port 是全局能力，与 cwd 无关，`--cwd` 只影响回测语料）。备选：按项目放 `<cwd>/.pi/reflex/drafts/`（可以进版本库共享，但多了一个仓库内注入面，secure 域路径也要另行审计）。
