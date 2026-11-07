# Jev Reflex · #25 历史回测、草案生成与运行时草案加载 · 架构设计

> 状态：架构设计（无代码）· **r3**（2026-11-05：r2 闭合 GPT 评审第 1 轮 15 条；r3 按 root 裁定闭合复审未闭合的 #1/#4/#8/#10/#12，处置表见 `backtest-plan.md` §10「r3」栏）
> 上游：`arch.md`（A）、`plan.md`（P）、`feasibility.md`（F）、`README.md`（R-I1…R-I12）。
> 冲突时以本文为准；本文**只**改写 R-I12，另外覆盖 U5（P §0）。其余不变式原样有效。

## 0. 用户拍板（2026-11-05，不再讨论；r2 含评审后重新拍板）

1. **离线生成 + 回测**：从历史会话聚类意图并生成草案。草案只能映射到已有 4 个 port（`jobs.list` / `fleet.status` / `quota.summary` / `git.status`）。内置脚本加草案一起回放历史问句，输出命中 / 模糊 / 否决 / 未命中与疑似误命中清单；agree / diverge 用模型**当轮**工具形状计算。改模板后能快速重测。
2. **运行时加载草案**（`reflex.drafts.enabled`，默认关）：草案只跑 shadow，任何情况下都不自动作答（id 写进 `autoResolve` 也不行）。
3. **晋升口径（覆盖 U5）**：问法证据 = 回测**留出集**样本 ≥50、分歧 ≤5%、误命中有评审记录；port 可靠性 = 实时 shadow **按 port（同 `portVer`）** ≥10 次且全部成功（`uncertain` 算不成功，`ok===runs`）；纠正与重复提问 = 0（历史侧只计命中轮次，可在评审记录里豁免）。
4. **留出集**：按 fork 家族根会话哈希 60/40；草案只用训练集生成；晋升只计留出集。
5. **人工评审（r2 重新拍板）**：`reviews/*.json` 只是**未认证**的统计建议 / 记录。同 UID 的 agent 能执行任意 shell，TTY、0600、`listHash` 都**不能**证明是人看过的。真正的人工把关 = 用户批准把草案改写进 `catalog.ts` 的 PR，或用户明确确认。
6. **留出集污染（r2 重新拍板）**：草案一旦在看过某留出批次的失败之后被修改，该批次对修改后的模板**作废**，不再作为晋升证据，改用之后新产生、未暴露的批次（新历史或实时 shadow）；旧样本保留为回归集。证据绑定不可变的 corpus manifest、模板 hash 与评估批次。
7. 草案放全局 `<agentDir>/reflex/drafts/`（目录 0700、文件 0600——用于隐私与跨 UID 防护，不用于认证）。

## 1. 背景与目标

- **问题**：R3b 的晋升证据只能来自实时 shadow，≥50 条要攒约 2 周，且每次改模板（升 `scriptVer`）清零；内置 4 个脚本的问法是人写的，覆盖面没有数据依据。
- **目标**：①历史会话 → 可反复回放的问句语料，快速给出「模板 × 历史」命中 / 误命中；②从训练集机器起草问法草案（`origin:"extracted"`）；③草案在本机以 shadow 加载，积累实时 port 证据；④合并判定只出**建议**，由人落 PR。
- **约束**：I4、I8（`core/**`、`ports/*`、`drafts/*` pi-free 值闭包）、I9（drafts 关 ⇒ 字节不变，§6）、I11/D8、I1/I5、PD10（pi 进程内不扫语料目录）、R-I3。

## 2. 现状摘要

| 能力                    | 坐标                                                                                                                                                                                          | 本设计如何用                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 归一化 / 摘要 / S0 / S1 | `src/reflex/core/{normalize,digest,gate,match}.ts`                                                                                                                                            | 原样复用；草案另编译一个 matcher                                                  |
| 一致性                  | `core/agreement.ts`（`judgeAgreement`：零工具 ⇒ `no-tool`）                                                                                                                                   | 复用；`toBranchLike` 从 `wire.ts:95` 下沉到 core                                  |
| 纠正 / 重复             | `core/state.ts` `detectCorrection`、`effectiveState(id,…)`（接受任意 id）；`core/promotion.ts`                                                                                                | 复用；AUTO 准入另加 builtin 白名单（§4.6）                                        |
| 晋升                    | `core/promotion.ts`（`accumulate`/`evaluatePromotion`，按 `scriptId@scriptVer`）、`core/shadow-scan.ts`、`scripts/dev/reflex-shadow.mjs`                                                      | 旧 API 不变；V2 用独立汇总器（§4.7）                                              |
| 运行时                  | `wire.ts`：`scheduleShadowPort`（`:236-275`，port 执行后**无条件** `stateOf`/`onExecOutcome`/写 `runtimes`）；`agent_settled`（`:509-531`，只从 `scriptById` 取脚本）                         | 拆成「port 执行 + 挂接」与「builtin 状态记账」（§4.6）                            |
| 安全打开                | `src/session-nav/session-head.ts:119-139` `openSessionNoFollowAsync`（`O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY` + 同 fd `stat`）                                                           | 草案加载照此模式（镜像常量，不 import：该文件值导入 `web-hub/protocol/spawn.js`） |
| 脱敏 / 形状             | `src/memory/jev/{redact,predict/shape}.ts`（pi-free）                                                                                                                                         | 报告首行、examples                                                                |
| agentDir                | `src/core/agent-dir.ts` `resolveAgentDir(env, home).dir`                                                                                                                                      | 草案 / 缓存 / 账本根                                                              |
| fork 头                 | pi `session-manager.js:1242-1248,1398-1404`：fork 头 `parentSession` = **父会话文件路径**（`resolvedSourcePath` / `previousSessionFile`），新文件名 `<ts>_<newId>.jsonl`，header `id` 为新 id | 家族根解析（§4.2）                                                                |

**语料事实**（`~/.pi/agent/sessions`：95 个 cwd 目录、1385 文件、1.6 GB）：user 消息无 source 字段；web/飞书输入父条目为 `custom:subagent:web-origin`，topic-switch 重放为 `custom:subagent:topic-switch`，wake 注入为 `custom:subagent:wake-level`；fork 会话整段复制祖先条目（`id`、`timestamp` 不变），现有 `reflex-shadow.mjs` 会把 fork 副本算成跨会话重复（既有缺陷，B5 修）；单行 ≤120cp 约 75%。`quota.summary` 的 `agreement.tools` 与 `bashShapes` **都为空**：模型对额度问题通常不调工具，签名无法自动标注它（§4.4）。

## 3. 总体设计

```
离线（Tier 3，pi 进程外）                                   运行时（pi 进程内，reflex.drafts.enabled）
scripts/dev/reflex-backtest.mjs ──► core/backtest/orchestrate.ts（I/O 注入，可确定性测试）
  core/backtest/corpus.ts    行 → Turn + CorrectionFact（双索引家族根、去重、来源、受理确证度）
  core/backtest/split.ts     家族根 → train | holdout | unscored
  core/backtest/replay.ts    Turn × Matcher → ReplayRow（confirmed / lenient 分账）
  core/backtest/cluster.ts / draft-gen.ts / regex-safe.ts（只吃 train）
  core/backtest/evidence.ts  批次内 holdout → BacktestEvidence
  core/promotion.ts          accumulateV2 / portReliabilityV2 / evaluateMergedPromotion（V2 唯一判定）
scripts/dev/reflex-shadow.mjs ──► 同一 V2 判定（backtest 缺省）
        │ 写（0700/0600，未认证记录）                         src/reflex/wire.ts
        ▼                                                     ├ builtin matcher（不变）─ miss ─► draft matcher（shadow only）
<agentDir>/reflex/{cache/, manifests/, batches/, exposure.jsonl, │      runPortAttach（共用）· accountBuiltin（仅 builtin）
                   reviews/, drafts-out/, drafts/, reports/}    └ src/reflex/drafts/load.ts（no-follow fd、有界、fail-closed）
```

- 依赖方向：`scripts → dist/reflex/core/**`；`wire.ts → drafts/load.ts → core/{draft-schema,draft-regex,identity}`。`core/backtest/**` 自动进入现有 `src/reflex/core/**` pi-free 门禁；`drafts/*.ts` 新增同款门禁。
- 不在 pi 内做 `/reflex backtest`：1.6 GB I/O 不可控（PD10），会话文本不进 pi 进程。pi 内只有 `/reflex drafts`。

## 4. 接口契约

### 4.1 共享适配器下沉

`wire.ts` 的 `toBranchLike(entries)` 逐字移到 `core/branch-like.ts`；`wire.ts` 改 import，行为逐字节不变。

### 4.2 语料：`core/backtest/corpus.ts`

```ts
export type TurnOrigin = "tui" | "web" | "replay" | "injected" | "steer";
export type Split = "train" | "holdout" | "unscored";
export type GateFactName = "idle" | "pendingMessages" | "topicSwitchActive" | "goalBusy" | "inFlight" | "sourceMode";
export interface Turn {
  session: string;
  familyRoot?: string;
  split: Split; // familyRoot 缺省 ⇔ unresolved ⇔ split="unscored"
  entryId: string;
  at: number;
  settledAt: number;
  cwd: string;
  text: string;
  digest: string; // text 只在内存与 0600 缓存
  imageCount: number;
  origin: TurnOrigin;
  shapes: readonly string[];
  toolCount: number;
  hasWrite: boolean;
  unknownFacts: readonly GateFactName[]; // 离线推不出、按宽松假设填入的 gate 事实；空 ⇔ 可确证受理
}
export interface CorrectionFact {
  // 所有 user 条目都产（任意 origin / 长度 / 行数），不存原文
  session: string;
  entryId: string;
  at: number;
  origin: TurnOrigin;
  corrHit: boolean;
}
export interface SessionHeaderFact {
  file: string;
  id: string;
  parentSession?: string;
  timestamp: number;
  cwd: string;
}
export function buildFamilyIndex(headers: readonly SessionHeaderFact[]): FamilyIndex; // 第一遍
export function createCorpusBuilder(
  f: CorpusFilter,
  families: FamilyIndex,
): {
  beginFile(file: string, header: unknown): "skip-child" | "ok";
  line(raw: string): void;
  endFile(): { turns: readonly Turn[]; corrections: readonly CorrectionFact[] };
};
```

**家族根（第一遍只读每个文件的 header 行，扫描范围 = 全部 cwd 目录，不受 `--cwd` 过滤）**：建立双索引——`byPath`：`path.resolve(file)` → header；`byId`：header `id` → header（同一 id 出现在 ≥2 个文件 ⇒ 该 id 标记 `duplicate`）。`parentSession` 解析顺序：① `byPath.get(path.resolve(parentSession))`；② 移位兜底：取 `basename(parentSession)` 按 `^.+_(<uuid>)\.jsonl$` 抽 id，查 `byId`（`duplicate` 不采用）；③ 都失败 ⇒ unresolved。沿父链上溯至无 `parentSession` 的根；访问集合检测环（环 ⇒ 链上全部 unresolved）；链上任一节点 unresolved / duplicate ⇒ 本文件 unresolved。**unresolved 文件的 Turn 记 `split:"unscored"`**：只进回归报告，不进训练集也不进留出集（防止它其实是留出会话的 fork 而泄漏）。报告页眉打印 unresolved 文件数与原因分布（`missing-parent`/`cycle`/`duplicate-id`）。

**轮次归属 / 来源 / 子会话排除 / 时间 cwd 过滤**：同 r1（继承父 turnId；来源表 `ORIGIN_MARKERS`——web⇒排除、wake/注入前缀⇒排除、topic-switch⇒`replay` 保留、父为 `toolUse` assistant 或 `toolResult` ⇒ `steer`、其余 `tui`；子会话由自标记或主会话 `subagent:run` 引用判定，口径镜像 `session-nav/provenance.ts`）。marker 字面量有存活治理测试。

**去重**：跨文件按 `${entryId}\0${timestamp}`；冲突保留 header `timestamp` 最早的文件（与遍历顺序无关）。同一家族内去重后 split 一致（split 按家族根）。

**受理确证度（Major 8）**：每个 Turn 计算 `unknownFacts`：

- `idle` 可确证 ⇔ 第一条祖先 `message` 是 assistant 且 `stopReason ∉ {toolUse}`（agent 已停），或为会话首条；`idle` 可确证时 `pendingMessages=false` 一并可确证（pi 空闲前排空队列）；
- `topicSwitchActive` / `goalBusy` 可确证 ⇔ 本会话内能从 `subagent:topic-switch*` / goal 条目推出当时状态（推不出 ⇒ unknown）；
- `inFlight` 可确证 ⇔ 本会话内该时刻前无未结算的 `subagent:reflex` AUTO 作答（离线恒可推）；
- `sourceMode`（r3）：marker 只能排除已知注入，排除不了 print/json/rpc 模式；**会话级**证据（如「会话里有任意 reflex-record」）不成立——fork 会复制祖先条目，一次 TUI 受理也证明不了其他运行阶段。确证必须绑定**目标轮次本身**（从该 user 条目到下一条 user 条目之前的本轮条目区间），且证据条目必须是**本文件原生**的（按 `${entryId}\0${timestamp}` 去重后归属本文件，即不是 fork 复制品）。可接受的轮次证据只有两种：①本轮区间内的原生 `pi-hud-llm-time` 条目（HUD 只在 `mode==="tui"` 的 live 会话写计时条目，见 `src/hud/index.ts:10-16` 的「非 tui 会话不再产生 HUD 计时条目」；仅对 `turn.at ≥ HUD_TUI_GATE_SINCE` 的轮次有效，该常量 = 引入 tui 门的 commit 时间，B1 用 `git log` 定值并写进 `markers.ts`，早于它一律不采信）；②本轮区间内的原生 `subagent:reflex-record` / `subagent:reflex` 作答，且其 `requestDigest === turn.digest`。两者都没有 ⇒ `sourceMode` unknown ⇒ lenient。逐轮判定天然覆盖「同一会话中途换运行模式」：哪一轮有证据哪一轮才确证。
- `unknownFacts` 为空 ⇒ **confirmed**；否则 **lenient**（按宽松假设放行）。晋升率**只用 confirmed**；lenient 只进覆盖率统计（§4.3）。

**纠正时间线（Major 9）**：`CorrectionFact` 对**所有** user 条目产生（含长句、多行、web、注入），`corrHit = CORRECTION_RE.test(normalizeInput(text).norm)`；缓存里单独存这条时间线（不受「单行 ≤120cp」过滤）。

**缓存**：`<agentDir>/reflex/cache/corpus-v2.jsonl`（0600）：Turn 行（origin∈{tui,replay,steer} ∧ 单行 ∧ ≤120cp）+ 全量 CorrectionFact 行 + header 索引；失效键 = `{cacheV, normalizeVersion, markersVersion, CORRECTION_RE.source 的 hash}` 任一变化 ⇒ 全量重建；文件级 `{size, mtimeMs, dev, ino}` 变化 ⇒ 该文件重解析，且**家族索引整体重建**（父链可能跨文件变化）。cold 与 warm 产出必须逐行相等（测试钉住）。

### 4.3 回放：`core/backtest/replay.ts`

```ts
export type Acceptance = "confirmed" | "lenient";
export type ReplayClass =
  | { k: "veto"; code: VetoCode; wouldHit?: string }
  | { k: "miss" }
  | { k: "ambiguous"; candidates: readonly string[] }
  | { k: "high"; scriptId: string; layer: "builtin" | "draft"; agree: Agreement };
export interface ReplayRow {
  turn: Turn;
  cls: ReplayClass;
  acceptance: Acceptance;
  reasked: boolean;
  corrected: boolean;
  suspect?: SuspectCode;
}
export type SuspectCode = "diverge" | "write-turn" | "other-port" | "reviewed-misfire" | "reasked" | "corrected";
export function replay(turns, corrections: readonly CorrectionFact[], cat, caps): readonly ReplayRow[];
```

- 两层语义同运行时（builtin 先、miss 才跑草案）；`acceptance = unknownFacts.length === 0 ? "confirmed" : "lenient"`。
- **reasked**：同会话、同脚本身份（§4.7 identityKey）+ digest，在 `REPEAT_WINDOW_MS` 内再次成为 high；跨会话用去重后的 `countCrossSessionRepeats`。
- **corrected（按实时 memo 语义重放）**：每个会话按 append 顺序推进一个 memo——high 候选在其 `settledAt` 设置 memo（覆盖旧 memo，同实时单槽）；之后**任何** `CorrectionFact`（不只下一条），只要 `origin ∈ {tui, replay}`（实时只受理 interactive+tui；`web`/`injected`/`steer` 不计）∧ `corrHit` ∧ `at - memo.settledAt ≤ CORRECTION_WINDOW_MS` ∧ `!memo.corrected` ⇒ 记该 memo 目标 corrected，置 `memo.corrected`。不命中的中间输入不清 memo。已知偏差：实时在进程重启（`session_start`）时清 memo，离线看不到重启 ⇒ 离线只会**多计**纠正（保守）。
- `reasked`/`corrected` 只在 high 命中轮次计（用户拍板）；命中轮次上的 reasked/corrected 同时以 `suspect:"reasked"|"corrected"` 进清单，供评审记录豁免。

### 4.4 草案生成：`core/backtest/{cluster,draft-gen,regex-safe}.ts`

- **只吃训练集**：候选 = `split==="train"` ∧ origin∈{tui,replay} ∧ S0 通过 ∧ builtin miss/ambiguous。负样本回灌也只用训练集 suspect（BD7）。
- **port 标注**：`PORT_SIGNATURES`（从 builtin 派生）只对**有工具签名**的 port（`jobs.list`/`fleet.status`/`git.status`）有效：签名恰交一个 ∧ `!hasWrite` ∧ `toolCount ≤ 3` ⇒ 该 port。**无工具 port（`quota.summary`，签名为空）不做自动标注**：簇众数 `toolCount===0` 且与任一无工具 port 的 builtin `weak` 词表词法相交 ⇒ 输出 `needs-port` 候选（簇 id、规模、脱敏骨架样本、建议 port），**不出草案**；人用 `generate --assign <clusterId>=quota.summary` 指定后才生成。不声称 4 个 port 都能全自动生成。
- **聚类**：骨架 = `norm` 依次做路径 → `<path>`、数字串 → `<n>`、引号内容 → `<q>`；含 `<path>`/`<q>` 的骨架不进 strong（无法用安全语法表达），只参与 weak 统计。leader 贪心、Jaccard ≥0.6、`minGroup` 默认 3，稳定排序保证确定性。
- **模板**（全部由 `regex-safe.ts` 按 §4.5 语法生成）：strong = 不同骨架的全句字面量 alternation，`<n>` → `\d{1,4}`（每条至多 1 个，且两侧必须是非数字字面字符或边界），可选尾缀只允许 `(?:吗|呢)?`；每簇 ≤12 条。weak = 覆盖率 ≥60% 且全语料出现率 ≤2% 的 1–3 个纯字面量 n-gram。exclude = 训练集负样本的整句纯字面量。
- **examples（Major 11）**：`examples.hit` 用**代表值实例化**的骨架：`<n>` 依次替换为 `2`、`3`、`10`…（保证匹配 `\d{1,4}`，脱敏不会改写这些数字），再过 `redactForJev(…,"user")`，**生成后逐条用该草案自身 matcher 复核必须 high**，不 high 即丢弃。去重按实例化后的 norm。小簇补全：同一 strong 条目可用不同代表值实例化补足到 5 条（`<n>` 骨架）；纯字面量小簇（无 `<n>`）不足 5 个不同 hit ⇒ 加句尾尾缀变体（`吗`/`呢`，仍需复核 high）；仍不足 ⇒ `skip:"examples"`。`examples.miss` = 训练集负样本 + 必被 S0 否决的合成句，补足到 ≥5。
- 生成结果是 `{ drafts, needsPort, skips: Record<SkipReason, number> }`，`SkipReason = "small" | "low-purity" | "unmapped" | "examples" | "regex" | "exclude-cap" | "validate"`；报告打印 skip 分布。
- 其余字段取 `PORT_DEFAULTS`；不写 `budgetMs`；`version:1`；`id = "draft." + slug`；`lineage` 缺省（= id）；**永不输出 argv**。

### 4.5 草案文件、正则语法与校验：`core/{draft-regex,draft-schema,identity}.ts`

**草案正则语法 DRX（Blocker 1，解析器校验，不再黑名单扫描）**：

```
strong  := seq ('|' seq){0,11}            匹配时包成 ^(?:…)$
seq     := unit+ tail?
unit    := LIT | DIGITS
LIT     := 非元字符 | '\' 元字符           元字符 = \ ^ $ . | ? * + ( ) [ ] { }
DIGITS  := '\d{1,4}'                       每个 seq 至多 1 个；前后相邻 unit 必须是非数字 LIT 或 seq 边界
tail    := '(?:吗|呢)?'                    固定字面量集合，只能在 seq 末尾，每 seq 至多 1 个
weak / exclude := LIT{1,40}                纯字面量，子串匹配
```

- `parseDrx(src, role) → { ok: true; ast } | { ok: false; problem }`：递归下降，接受 = 能完整解析，**不在语法内的一切拒绝**（`+`、`*`、`?`（尾缀外）、`{`（`\d{1,4}` 外）、字符类、分组（尾缀外）、反向引用、lookaround、`.`）。长度 ≤160。
- **安全性论证**：每个 seq 至多一个有界量词 `\d{1,4}`，其字符集与相邻字面字符不相交 ⇒ 每个起点的分配方式 ≤4 种；尾缀是两选一的定长字面量 ⇒ ×3；alternation ≤12 ⇒ 每个起点最多 12×4×3 条路径，总工作量 O(12·12·n)，n ≤120cp（S0 #9）。weak/exclude 为纯字面量，线性。**不存在依赖输入长度的指数回溯**，因此不需要（也无法）用计时器打断主线程上的同步匹配——500 ms 加载预算只约束 I/O，不约束匹配。
- 反例（必须被拒，B0 测试）：`"a+".repeat(20)+"b"`、`(a|a)+`、`\d+\d+`、`\d{1,4}\d{1,4}`、`x?x?x?…`、`[a-z]+`、`.*`、`(?=a)`、`\1`。测试编排（r3，三类彼此独立）：
  1. **拒绝集**：主测试进程内只断言 `parseDrx` 拒绝，**不执行**这些正则。
  2. **危险演示**（可选、仅作说明）：单独起一个子进程（`spawnSync(process.execPath, ["-e", …], { timeout: 2000 })`）用原生 RegExp 跑 `"a+".repeat(20)+"b"` × 120 个 `a`；允许它被截止，断言只有「被截止或耗时 >1 s」二选一（证明该反例真的危险），失败不影响其他两类。
  3. **接受集**：另起一个独立子进程（硬截止 5 s），经 stdin 传入 1,000 个 DRX 接受的随机源与对抗失败输入（`2`×120、`吗`×120、交替串、strong 前缀 + 噪声），断言子进程**正常退出**（`status===0`、未被信号终止）且子进程自报总耗时 < 2 s。

**草案文件**：`<agentDir>/reflex/drafts/*.json`，单个 `RScriptV1`（`origin:"extracted"`）。`validateDraft(raw, builtinIds) → RScriptV1 | DraftReject`（纯函数、不抛）：①`validateScript` 通过且逐层无白名单外键；②`origin==="extracted"`、`risk==="readonly"`；③`id` 匹配 `^draft\.[a-z0-9-]+$`、不在 builtinIds、草案间不重复；`lineage`（可选）匹配 `^[a-z0-9.-]+$`；④`port.id` ∈ `MVP_PORTS`，`requires/agreement/render` 逐字段等于 `PORT_DEFAULTS[port]`；⑤无 `budgetMs`，条目数 strong ≤12、weak ≤8、exclude ≤32、hit/miss 各 5–20；⑥每条正则源 `parseDrx` 通过（并仍过 `regexSourceProblems`）；⑦例句自检：单独编译，hit 全 high，miss 全被理想 TUI 事实的 S0 否决或非 high。`validateCatalog` 追加：builtin id 不得以 `draft.` 开头。

**身份与谱系（Major 7）**：`core/identity.ts`

```ts
/** 匹配语义 hash：只覆盖 {port.id, match.strong/weak/exclude}（键排序 JSON → sha256 前 16 hex）。改 id/version 不变；改任何模板必变。 */
export function templateHash(s: RScriptV1): string;
/** 文件 hash：整份规范化 JSON；仅用于审计（手改未升版本可见）。 */
export function draftHash(s: RScriptV1): string;
export interface EvidenceIdentity {
  lineage: string;
  templateHash: string;
  portId: PortId;
  portVer: number;
}
export const identityKey = (i: EvidenceIdentity): string => `${i.lineage}#${i.templateHash}`;
/** 由 (scriptId, scriptVer, 可选 templateHash) 解析身份：draft 行自带 hash；builtin 行按「当前 catalog 中 id@ver 一致 ⇒ 取其 hash 与 lineage」，否则 legacy 身份 `${id}@${ver}#legacy`（不与任何新身份合并）。 */
export function resolveIdentity(
  row: { scriptId: string; scriptVer: number; templateHash?: string },
  catalog: readonly RScriptV1[],
  drafts: readonly RScriptV1[],
): EvidenceIdentity | undefined;
```

- `RScriptV1` 追加可选 `lineage?: string`（缺省 = id）。人把 `draft.x` 改写进 catalog 时写 `lineage: "draft.x"`（PR 可见）；之后 `foo@2`（lineage `draft.x`）与 `draft.x` 只要 templateHash 相同即同一身份——**改 id 不抹掉此前的重复与纠正**；改了模板但没升版本 ⇒ hash 不同 ⇒ 证据分开。
- 写入面（仅 drafts 开启且目标为草案时；builtin 记录逐字节不变，§6）：`ReflexRecordV1` 追加 `origin?:"draft"`、`draftHash?`、`templateHash?`、`port.portId?`；`ReflexCorrectionV1` 追加 `targetOrigin?:"draft"`、`targetTemplateHash?`。

### 4.6 运行时加载

**设置**：`ReflexSettings.drafts: { enabled: boolean }`，默认关，键 `reflex.drafts.enabled`，`bool`，非 live，追加在 `REFLEX_SETTING_SPECS` 末尾；`applySecureDomainOverrides` 加 `drafts:{enabled:false}`。

**加载（`src/reflex/drafts/load.ts`，Major 5）**：

```ts
export type DraftRejectCode =
  | "dir-untrusted"
  | "dir-cap"
  | "dir-changed"
  | "cap"
  | "name"
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
  | "timeout"
  | "aborted";
export interface DraftFs {
  lstat;
  opendir;
  open;
} // node:fs/promises 子集，可注入
export function loadDrafts(
  dir: string,
  builtinIds: ReadonlySet<string>,
  clock: Clock,
  signal: AbortSignal,
  fs?: DraftFs,
): Promise<DraftLoadResult>;
```

1. **受信目录**：`lstat(<agentDir>/reflex)` 与 `lstat(drafts)` 都必须是真目录（非 symlink）、`uid === getuid()`、`mode & 0o077 === 0`；否则整体 `dir-untrusted`。记下 drafts 的 `{dev, ino}`。
2. **有界枚举**：`opendir` 流式读取，最多读 `DIR_SCAN_CAP = 64` 个 dirent；读到第 65 个 ⇒ 整体 `dir-cap` 并立即 `close`（不全量 readdir）。名字须匹配 `^[a-z0-9.-]{1,64}\.json$`（否则 `name`）；排序后取前 16 个，余者 `cap`。
3. **逐文件 no-follow fd**：`open(join(dir,name), O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)`（常量镜像 `SESSION_READ_FLAGS`，测试断言二者相等）；**同一 fd** `stat`：非普通文件 ⇒ `not-regular`（FIFO/设备/被换成 symlink 的 ELOOP 都落这里）；`uid`/`mode & 0o077` ⇒ `perm`；`size > 16 KiB` ⇒ `size`；随后从该 fd 最多读 `16 KiB + 1` 字节，读满 cap+1 ⇒ `size`（防止 stat 后增长）。`finally` 关闭 fd。
4. **结束复核**：再 `lstat(drafts)`，`{dev, ino}` 变化 ⇒ 全部丢弃 `dir-changed`（防目录被整体替换）。
5. **预算**：`clampSpanMs(DRAFT_LOAD_BUDGET_MS=500)` 经注入 Clock（unref）；超时或 abort ⇒ 停止后续文件、关闭当前 fd、`clearTimer`、结果全部丢弃（`timeout`/`aborted`）。永不抛、永不 reject。
6. **时机**（BD8）：`drafts.enabled ∧ plain` 时，每次 `session_start` 若无结果且无在飞加载 ⇒ 启动；`session_shutdown` abort 在飞加载；完成结果跨 re-arm 保留到 `/reload`。被拒只在 `/reflex drafts|status` 显示，不 notify、不 setStatus（trace phase2 不变，§6）。

**wire 拆分（Major 6）**：

- `runPortAttach(p, script, cwd) → void`：现 `scheduleShadowPort` 的 port 执行 + `isStale/pending!==p` 检查 + 写 `p.port`（含 `portVer`）；**不碰状态**。返回结果给可选回调。
- `accountBuiltin(script, outcome, notify)`：`stateOf`/`onExecOutcome`/`runtimes.set`/降级 notify——只在 `p.origin === "builtin"` 时调用；内部断言 `scriptById.has(script.id)`。
- `Pending` 追加 `origin: "builtin" | "draft"`。`agent_settled` 取脚本：`p.origin === "draft" ? draftById.get(id) : scriptById.get(id)`，草案同样参与 `judgeAgreement`（否则 agreement 恒 unknown）。
- **AUTO 准入**：`admitAuto(id) = scriptById.has(id) && stateOf(id) === "auto"`；草案分支从不调用 `stateOf`/`effectiveState`。`autoResolve` 中的 `draft.*` 计入 `unknownAutoResolve`。status 里所有草案相关增量（草案计数、「`draft.*` 不可自动作答」提示）**只在 drafts 开启时**输出；drafts 关闭时 `/reflex status` 与改动前逐字节相同（r3，由 parity 钉住）。
- 纠正：memo 追加 `origin`；目标为草案时照写 `subagent:reflex-correction`（带 `targetOrigin/targetTemplateHash`），**不**调 `onCorrected`。`/reflex reset draft.x` ⇒ 报错「草案没有降级状态」。
- 草案与 builtin 共用单槽：替换时按被替换槽自己的 origin 落记录。
- **保证方式**：草案与 builtin 同为 `RScriptV1`，**类型上无法区分**；shadow-only 由「准入白名单 + 状态隔离测试 + 治理扫描（`runAuto(` 单调用点、`accountBuiltin(` 只在 origin 判断之后）」共同保证，不宣称类型不可达。

**`/reflex drafts`**：列 `loaded <id>@<ver>#<templateHash8> port=<p>` 与 `rejected <file> <code>`；关闭时 `drafts: disabled`。

### 4.7 晋升 V2

```ts
export const PROMOTION_GATE_V2 = Object.freeze({ minIntentSamples: 50, maxDivergeRate: 0.05, minPortRuns: 10 });
export interface PortReliability {
  portId: PortId;
  portVer: number;
  runs: number;
  ok: number;
  missing: number;
  unavailable: number;
}
export interface StatsV2 {
  identity: EvidenceIdentity;
  judged: number;
  diverge: number;
  reasked: number;
  crossSessionRepeats?: number;
  corrected: number;
}
export interface BacktestEvidence {
  batchId: string;
  manifestHash: string;
  identity: EvidenceIdentity;
  confirmed: { judged: number; diverge: number };
  lenient: { judged: number; diverge: number; unknownFacts: Record<GateFactName, number> };
  reasked: number;
  crossSessionRepeats: number;
  corrected: number;
  waived: number;
  suspects: number;
  reviewed: number;
  misfires: number;
  unscored: number; // reviewed/misfires 来自未认证评审记录
}
export interface MergedEvidence {
  identity: EvidenceIdentity;
  backtest?: BacktestEvidence;
  batchValid?: BatchValidity;
  live?: StatsV2;
  port?: PortReliability;
  scanComplete: boolean;
}
export function accumulateV2(rows, resolve: (row) => EvidenceIdentity | undefined): Map<string, StatsV2>; // 独立于旧 accumulate
export function portReliabilityV2(rows): Map<`${PortId}@${number}`, PortReliability>;
export function evaluateMergedPromotion(e: MergedEvidence): PromotionVerdictV2;
```

- **问法**：(a) 回测 `batchValid.ok ∧ confirmed.judged ≥50 ∧ confirmed.diverge/confirmed.judged ≤5% ∧ reviewed===suspects（否则 review-incomplete）∧ misfires===0`（lenient 不进分子分母，Major 8）；或 (b) 实时 `live.judged ≥50 ∧ 分歧 ≤5%`。
- **port**：按 `(portId, portVer)`，只复用**当前** portVer 的证据；`runs` 计 ok|uncertain|error|timeout；`ok` 只计 ok；`missing` = 有 port 却无结果的候选记录（模型先 settled、槽被替换、迟到结果被丢）；合格 ⇔ `runs ≥10 ∧ ok===runs ∧ missing===0`；`missing>0` ⇒ **undetermined**（Major 13：迟到的失败可能藏在缺失里）。
- **零容忍**：`live.reasked + live.corrected + live.crossSessionRepeats（必须已判定）+ backtest.reasked + backtest.crossSessionRepeats + backtest.corrected === 0`，均按**身份**（lineage+templateHash）汇总，跨 id/版本改名延续；回测侧已扣除评审记录的豁免。
- `scanComplete=false`（任一文件读失败 / 解析中断）⇒ 不合格（Minor 14）。
- 结论只是**建议**，附完整身份元组 `{lineage, templateHash, portId@portVer, batchId, manifestHash}`，供 PR 描述引用、由人核对。

**批次、manifest 与暴露账本（Blocker 4）**：

- `CorpusManifestV1 { v:1; normalizeVersion; files: {sessionId; pathHash; size; mtimeMs; lines; lastEntryId}[]; manifestHash }`：`batch freeze` 时写 `manifests/<manifestHash>.json`（`wx`，永不覆盖）。
- `EvalBatchV1 { v:1; batchId; lineage; manifestHash; cutoffAt; since; until; turnKeys: string[] /* sha256(entryId\0at) */; turnDigests: string[] /* requestDigest */; createdAt }`，`batchId = sha256(lineage + sorted turnKeys)`；只含 `split==="holdout"` 的 Turn；`batches/<batchId>.json`（`wx`）。
- `exposure.jsonl`（追加）：`{ lineage, templateHash, batchId, at, via: "report" | "review" | "show" }`——**展示任何留出失败明细**（suspect 行、diverge、misfire、命中轮次的 reasked/corrected）时由脚本自动追加；只展示聚合计数不算暴露（残留风险）。
- **模板修订时间**（r3，可核查来源）：本地追加账本 `revisions.jsonl`：`RevisionRecordV1 { v:1; lineage; templateHash; firstSeenAt; gitCommitAt?; source: "draft-file" | "drafts-out" | "catalog" }`。脚本在**任何**命令解析身份时，若 `(lineage, templateHash)` 尚无记录就先追加一条（first-seen 胜出，永不改写）；catalog 来源另记 `git log -1 --format=%ct -- src/reflex/core/catalog.ts`。`revisedAt(rec) = max(firstSeenAt, gitCommitAt ?? 0)`；`lastRevisedAt(lineage) = max(revisedAt)`（取最晚 ⇒ 只会让新批次准入更严）。不在草案文件里放 `revisedAt`：草案可被随意手改，账本至少是追加写（同样未认证，U6）。
- `batchValidity(batch, identity, exposures) → { ok, reason? }`（r3）：**只看 `exposure.batchId === batch.batchId` 的暴露记录**——其中存在同 lineage 且 `templateHash ≠ identity.templateHash` 的 ⇒ 作废（`exposed-then-modified`）；批次 manifest 缺失 ⇒ `manifest-missing`。别的批次的暴露**不影响**本批次；从未暴露过的批次即使早于修订也仍有效。作废批次转为**回归集**：报告照常回放但不计证据。
- `admitBatch(candidate, lineage, revisions, batches, exposures) → { ok, reason? }`（r3，`batch freeze` 时调用，冻结前必须通过）：①每个轮次 `at > lastRevisedAt(lineage)`（否则 `before-revision`）；②每个轮次的 `requestDigest` 都**不在任何已暴露批次**（有任一暴露记录的批次，不分 lineage）的 `turnDigests` 中（否则 `reused-exposed-turns`）——只换 batchId、重新打包旧样本、或旧问句原文在新会话里重现都会被拒；③`cutoffAt` 记为 `lastRevisedAt(lineage)`。新证据只能来自通过 `admitBatch` 的新批次，或实时 shadow。

### 4.8 评审记录、本机查看与迭代体验

**威胁模型**：同 UID 的 agent（pi 的 bash 工具、子 agent）可以执行任意 shell，能读写 `<agentDir>` 下所有文件、改 `pi-toolkit.json`、伪造任何评审 / 暴露 / 批次记录。因此：①0700/0600 与 uid 检查只防**其他 UID** 与误共享，不防同 UID；②`reviews/*.json` 是**未认证记录**，脚本照常读取用于统计（豁免、misfire 计数）但输出处标注「unverified」；③**唯一的人工认证点**是用户批准把草案改写进 `catalog.ts` 的 PR（或用户在对话中明确确认），PR 描述须引用 `--promote` 输出的身份元组；④运行时安全性不依赖任何离线记录：草案恒 shadow，port 只读。

- `review <portId>`：交互式便利工具（不再声称 TTY 认证）；逐条显示留出 suspect（digest + 脱敏首行 + suspect 码），写 `reviews/<portId>.json` `{v:1, entries:[{digest, portId, verdict:"ok"|"misfire", at}], unverified:true}`，并追加暴露记录。
- `show <digest>`：**仅本机**的完整轮次查看：打印该轮 user 原文（脱敏）、本轮工具形状序列（**无 argv**）、来源、split、unknownFacts；拒绝与 `--report`/`--json` 组合；追加暴露记录。
- **可导出报告** `--report`（`reports/<date>.md`）：只含聚合计数、digest、≤24cp 脱敏首行、身份元组；永不含路径、argv、session 文件名。
- 命令：`reflex-backtest.mjs [--days N] [--cwd <abs>] [--drafts <dir>] [--only <id>] [--json] [--no-cache]` · `generate [--min-group 3] [--assign <cluster>=<port>] [--emit]` · `batch freeze --lineage <L>`（自动按 `admitBatch` 选轮次） · `review <portId>` · `show <digest>` · `--promote <scriptId> --batch <batchId>`。secure env ⇒ exit 3；缺 dist ⇒ exit 2；不联网。
- **性能目标（手动，不保证）**：应用缓存冷（删 `cache/`）全量 ≤90 s、应用缓存热 ≤3 s；OS 页缓存不受控，报告标注；测量记录 manifestHash、扫描字节数、各过滤阶段计数。

## 5. 关键决策

| #   | 决策                                                         | 否决的备选                     | 理由                                                                             |
| --- | ------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| K1  | 回测逻辑全在 `core/backtest/**`，编排也是可注入 I/O 的纯模块 | 在 `.mjs` 里重写               | 单一实现；pi-free 门禁；编排可确定性测试                                         |
| K2  | 草案只在 builtin miss 时参与                                 | 两层统一定 band                | builtin 行为与数据逐字节不变                                                     |
| K3  | 草案 agreement/render/requires 强制等于 port 规范值          | 允许自定义                     | 防刷 agree                                                                       |
| K4  | 正则用 DRX 有限语法 + 解析器                                 | 黑名单扫描（r1）               | 黑名单放过相邻重叠 `+`（41 字符 >2 s）；同步匹配无法用计时器打断，只能靠语法证明 |
| K5  | 加载 no-follow fd、有界枚举、一次性                          | 热重载 / lstat→readFile        | TOCTOU；I1 有界                                                                  |
| K6  | port 可靠性按 `(port, portVer)`，缺失结果 ⇒ 未判定           | 按脚本 / 缺失视为无证据        | 同 port 同代码；缺失可能藏迟到失败                                               |
| K7  | 评审 = 未认证记录，人工认证 = PR                             | TTY/0600/listHash 防伪造（r1） | 同 UID agent 能执行任意 shell，任何本地机制都可伪造                              |
| K8  | 身份 = lineage + templateHash                                | `id@ver#draftHash`（r1）       | 改 id 不抹证据；改模板不升版也能分开                                             |
| K9  | 暴露账本 + 批次作废                                          | 留出集长期复用                 | 看过失败再改模板 ⇒ 该批次已被「用答案出题」                                      |
| K10 | 无工具 port 走 `needs-port` 人工指定                         | 词法自动标注 quota             | 签名为空无法安全区分；误标会产出错误 port 的草案                                 |
| K11 | 晋升率只用 confirmed 受理                                    | 宽松事实全部计入（r1）         | 宽松放进的 agree/no-tool 稀释分歧率（3/50=6% → 3/100=3%）                        |

## 6. 对现有面的影响

- **R-I12 改写为**：「auto 只可能来自内置 catalog（`origin:"builtin"`）；`validateCatalog` 拒绝 `extracted` 与 `draft.*` id。草案只能在 `reflex.drafts.enabled` 下经 `validateDraft` 加载，恒为 shadow；AUTO 准入只认 `scriptById` 中的 builtin id，草案不调用状态机。rscript/1 没有 argv 种类，草案正则受 DRX 语法约束。」新增 **R-I13**：「草案加载有界、no-follow、fail-closed，不影响内置脚本；secure/locked/子会话不可达。」新增 **R-I14**：「离线评审 / 暴露 / 批次记录都是未认证记录；人工认证只发生在 catalog PR。」
- **`reflex-off-golden.json`（A）**：不变（`reflex.enabled=false` 时 `wireReflex` 不被调用）。
- **`activate-trace.json`（B）**：不变。trace 记录的是 phase 1 的有序注册调用，**以及** phase 2 在 `session_start → shutdown → start → shutdown` 中的可观察调用（`sendMessage`/`appendEntry`/`setStatus`/`setWidget`/`notify`/`addAutocompleteProvider`，见 `tests/governance/activate-trace.test.ts:9-12,83-93`）。`max` 档 drafts 默认关 ⇒ session_start 不启动加载；即使开启，加载也不产生这 6 类调用；无新增注册。
- **drafts-off 字节（Major 12）**：`reflex-off-golden` 覆盖不了 `reflex.enabled=true ∧ drafts.enabled=false`。新增 `tests/reflex/drafts-off-parity.test.ts` + 冻结 fixture `tests/fixtures/reflex-drafts-off-parity.json`（B0 在**改 wire 之前**于 dev 上捕获，同 reflex-off 先例：环境变量闸、存在即拒绝覆盖）：固定输入序列（builtin high/shadow、AUTO、miss、correction、ambiguous、单槽替换，以及 `/reflex status`）下 reflex 自身的 `appendEntry`/`sendMessage`/`setStatus`/`notify` 全序列逐字节记录（含 `/reflex status` 的完整输出文本）。B4 之后 drafts 关闭时必须逐字节相等；基线：该 fixture 不在 `origin/dev` 上（整个任务最后才 push 一次），B0 提交后以 **B0 的固定提交**为基线校验（`git diff --quiet <B0_COMMIT> -- tests/fixtures/reflex-drafts-off-parity.json`），其余既有冻结文件继续对 `origin/dev` 校验：builtin 记录**不写** `port.portId` 等任何新字段（portId 由 `scriptId` 经 catalog 反查）。
- **pin/corpus**：仅因追加 `reflex.drafts.enabled` 重 pin（程序化比对）。
- **web-hub boundary**：`core/settings.ts` 仍零 import，现有 pin `[]` 不变。
- **pi-free**：`core/backtest/**`、`core/{branch-like,draft-regex,draft-schema,identity,port-defaults}.ts` 自动受约束；`drafts/*.ts` 新增门禁。
- **governance**：G2–G4 照旧；新增 G5（`runAuto(` 单调用点、`catalog.ts` 无 `draft.` 字面量、`accountBuiltin(` 调用点前必有 origin 判断）。
- **D8**：`applySecureDomainOverrides` 一行；脚本 secure env 拒绝；data-encryption README 的 D8 清单补 `reflex`（含 drafts）。

## 7. 实施要点

### 7.1 分包

分包、文件域、冲突预检与验收见 `backtest-plan.md`（r3）。要点：B0 一次性落全部跨包契约（类型、`draft-regex`/`draft-schema`/`identity`/`port-defaults`、`shadow-scan` 扩展、`drafts/load.ts` 骨架、drafts-off parity fixture）；B1 ∥ B2 ∥ B4 ∥ B5 并行；B3 收尾。

### 7.2 风险

1. 来源推断不完备：`sourceMode` 只认本轮原生 HUD 计时条目或 reflex 记录；HUD 关闭、早于 `HUD_TUI_GATE_SINCE` 的轮次一律 lenient——回测问法证据可能主要来自较新的会话；这是 K11 的有意代价。
2. 暴露只追踪「展示失败明细」，聚合计数不算；同 UID agent 可伪造或删除账本（K7，残留）。
3. `uncertain` 算不成功、`missing` 算未判定：`quota.summary` 与快模型场景可能长期达不到 port 门槛（有意保守）。
4. 缓存含原句：与会话文件同域同权限；secure env 拒绝。
5. 离线 memo 看不到进程重启 ⇒ 纠正只会多计（保守）。
6. 家族根 unresolved 的会话不计分：报告给 unresolved 数，比例过高时先修索引再谈晋升。
7. DRX 表达力低：含路径 / 引号内容的问法无法进 strong（只能 weak），覆盖面让位于可证明安全。

## 8. 开放问题

r1 的三个开放问题已由用户拍板（§0）。r2 新增的待拍板项见 `backtest-plan.md` §9；r3 为 root 裁定，不新增待拍板项。
