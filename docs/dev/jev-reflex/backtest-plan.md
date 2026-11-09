# Jev Reflex · #25 历史回测 / 草案生成 / 运行时草案加载 · 实施计划

> 状态：实施计划（无代码）· **r3**（2026-11-05：r2 闭合 GPT 评审第 1 轮 15 条；r3 按 root 裁定闭合复审未闭合的 #1/#4/#8/#10/#12，不再开第三轮评审，由 root 核对；处置表见 §10「r3」栏）· 车道 **L3**
> 设计以 `backtest-arch.md` r3（下称 BA）为准。先例：`plan.md`（R0–R3 分包、X1–X6）、`README.md`（R-I1…R-I12、门禁）。
> 实施前必读：AGENTS.md（I1–I12、Frozen artifacts）、`docs/dev/jev-reflex/README.md`、`docs/dev/data-encryption/README.md`（D8）。

## 0. 用户已拍板（实施不再开问；r2 含评审后重新拍板，覆盖 r1 选项）

| #        | 决策                                                                                                                                                                                                                                    | 落点                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| U1       | 离线生成 + 回测；运行时加载草案（`reflex.drafts.enabled`，默认关，**只跑 shadow**）                                                                                                                                                     | B1/B2/B3、B4                         |
| U2       | 晋升：回测**留出集** ≥50、分歧 ≤5%、误命中有评审记录；port 实时 shadow **按 port（同 portVer）** ≥10 次且全部成功（`uncertain` 算不成功，`ok===runs`）；纠正与重复提问 = 0                                                              | B5 V2                                |
| U3       | 留出集：按（fork 家族根）会话哈希 60/40；草案只用训练集生成；晋升只计留出集                                                                                                                                                             | B1、B2、B5                           |
| U4       | 历史重复提问 / 纠正计入，只算 high 命中轮次；可在评审记录里豁免（豁免同样是未认证记录，最终以 PR 把关）                                                                                                                                 | B1 evidence                          |
| U5       | 草案放全局 `<agentDir>/reflex/drafts/`，目录 0700、文件 0600                                                                                                                                                                            | B0、B3、B4                           |
| U6（r2） | **人工评审**：`reviews/*.json` 只是未认证的统计建议 / 记录，不声称 TTY、0600 或 hash 能证明人看过、agent 无法伪造。真正的人工把关 = 用户批准把草案改写进 `catalog.ts` 的 PR，或用户明确确认。威胁模型：同 UID 下 agent 能执行任意 shell | B0 README R-I14、B3                  |
| U7（r2） | **留出集污染**：草案在看过某留出批次的失败后被修改 ⇒ 该批次对修改后的模板作废，改用之后新产生、未暴露的批次（新历史或实时 shadow）；旧样本保留为回归集。证据绑定不可变 corpus manifest、模板 hash、评估批次                             | B0 类型、B5 `batchValidity`、B3 账本 |

## 1. 本计划新增决策

| #    | 决策                                                                                                                                                                                                                                     | 理由                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| BD1  | **B0 一次性落全部跨包契约**：`core/types.ts` 追加所有类型；新建 `core/{branch-like,port-defaults,draft-regex,draft-schema,identity}.ts`、`drafts/load.ts` 骨架（含 `DraftFs` 接口）、drafts-off parity 测试与 fixture                    | 消除 B4→B2、B1→B5、B4/B5 共改 `shadow-scan.ts` 三处交集 |
| BD2  | `shadow-scan.ts` 新字段宽进 + 新导出 `scanReflexLine(line) → { entryId?, row }` 归 B0（旧 `extractReflexRows` 委托，行为不变）                                                                                                           | fork 去重需要 entry id                                  |
| BD3  | 负样本回灌 `refineDrafts(…, replayFn)` 注入 replay                                                                                                                                                                                       | 解除 B2→B1                                              |
| BD4  | 家族根：第一遍读全部 header 建 `byPath`/`byId` 双索引；`parentSession` 先按规范化路径、再按文件名抽 id 兜底；unresolved ⇒ `split:"unscored"`（不进训练也不进留出）                                                                       | pi 写入的 `parentSession` 是文件路径（Blocker 3）       |
| BD5  | fork 去重冲突保留 header 时间戳最早的文件                                                                                                                                                                                                | 与遍历顺序无关                                          |
| BD6  | `SuspectCode` 含 `reasked`/`corrected`；评审 `ok` 豁免、`misfire` 不可豁免                                                                                                                                                               | U4                                                      |
| BD7  | 自动回灌只吃训练集；留出失败只能经暴露账本 + 新批次路径处理                                                                                                                                                                              | U3/U7                                                   |
| BD8  | 草案加载：每次 `session_start` 若无结果且无在飞加载 ⇒ 启动；shutdown abort；完成结果跨 re-arm 保留到 `/reload`                                                                                                                           | PD11                                                    |
| BD9  | 草案目录由 `wire.ts` 内部计算；测试经可选 `ReflexWireDeps.draftsDir?` / `draftFs?` 覆盖                                                                                                                                                  | `src/index.ts` 冻结                                     |
| BD10 | README / AGENTS.md / data-encryption D8 清单在 B0 按目标契约一次写完；偏差记 `B*-report.md`，如需改由 B3′ 收口                                                                                                                           | 热点只碰一次                                            |
| BD11 | builtin 记录**一个新字段都不写**（`portId` 由 `scriptId` 经 catalog 反查）；新字段只写在草案记录 / 以草案为目标的纠正上                                                                                                                  | drafts 关 ⇒ 逐字节不变（Major 12）                      |
| BD12 | 暴露 = 脚本**展示任何留出失败明细**（report suspect 行 / review / show）时自动追加 `exposure.jsonl`；批次只因**自身**的暴露记录作废（同 lineage、hash 不同）；新批次须过 `admitBatch`（晚于 `lastRevisedAt`、digest 不在任何已暴露批次） | U7 的机械化口径（见 §9 Q1）                             |
| BD13 | port 结果缺失（模型先 settled / 槽替换 / 迟到丢弃）单列 `missing`，`missing>0` ⇒ port 可靠性 undetermined；不新增落盘事件类型                                                                                                            | Major 13；不扩大 R-I9 输出面（见 §9 Q2）                |

## 2. 冲突规避与共享面

- **X1（全包永不触碰）**：`src/index.ts`、`src/{fabric,web-hub,schedule,sysprompt,tools,commands,topic-switch,memory,session-nav,git,bash,quota,service,ui}/**`、`tests/fixtures/**` 既有文件（含 `reflex-off-golden.json`、`activate-trace.json`）、`tests/governance/trace-profiles.ts`、`tests/integration/stack-teardown-matrix.test.ts`、`src/reflex/core/catalog.ts`。从 `memory`/`session-nav`/`topic-switch` 取常量只值导入（受 pi-free 门禁）或镜像。
- **X2（热点，只归 B0）**：`src/config/settings.ts`、`src/reflex/core/{settings,types,schema,shadow-scan}.ts`、`src/reflex/setting-specs.ts`、`tests/config/__corpus__/{setting-specs-pin,settings-corpus}.json`、`tests/config/reflex-settings.test.ts`、`tests/secure/settings-override.test.ts`、`tests/boundary/pi-free.test.ts`、`tests/web-hub/boundary.test.ts`（预期**不改**：`core/settings.ts` 仍零 import，pin `[]` 不变；B0 只跑）、`docs/dev/jev-reflex/README.md`、`docs/dev/data-encryption/README.md`、`AGENTS.md`。
- **X3（开工前置）**：在役改动须与 B0 文件域、`src/reflex/**`、`src/index.ts`、`tests/fixtures/` 均无交集（§6.1 实测满足）；主会话先精确提交 `backtest-arch.md` 与本文件；`git log origin/dev..HEAD` 为空（否则 fixtures 门禁对 `origin/dev` 比较会误红）。
- **X4 冻结产物**：`reflex-off-golden.json`（A）与 `activate-trace.json`（B，含 phase 2 start/shutdown 可观察调用）全程字节不变；新 fixture `tests/fixtures/reflex-drafts-off-parity.json` 由 B0 **在改 `wire.ts` 之前**于 dev 上捕获（`PI_TOOLKIT_REFLEX_PARITY_CAPTURE=1`，文件存在则拒绝覆盖），登记为 A 级。
  - **FX 门禁（r3，各包统一引用）**：`git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json' && git diff --quiet "$B0_COMMIT" -- tests/fixtures/reflex-drafts-off-parity.json`。第一段：既有冻结文件继续对 `origin/dev`；第二段：新 parity fixture 以 **B0 的固定提交**为基线（`origin/dev` 在整个任务结束前不含它，不能当基线）。`B0_COMMIT` 由 root 在 B0 验收提交后写入 `B0-report.md` 并放进后续每个派单 prompt。
  - **B0 自身**只跑第一段，另加「parity fixture 已在改 `wire.ts` 之前捕获、`drafts-off-parity.test.ts` 绿」。pin/corpus 只因 `reflex.drafts.enabled` 刷新一次。
- **X5**：并行前主会话真跑 `node skills/dev-flow/scripts/conflict-check.mjs - --cwd /home/bluecake/ai/pi-toolkit`（spec 见 §6）。
- **X6**：精确路径提交；dev **禁跑全量 `npm test`**，只跑定向 vitest；全量由主会话 `bash_job` 后台跑一份；全部包完成后一次 push。

## 3. 包总览

```
B0 契约 ──┬─► B1 回测核心（corpus/markers/split/replay/evidence）        ┐
          ├─► B2 草案生成（cluster/draft-gen/regex-safe）                │ 并行（§6 预检无交集）
          ├─► B4 运行时加载（drafts/load + wire 拆分 + /reflex drafts） │
          └─► B5 晋升 V2（accumulateV2/portReliabilityV2/batchValidity + fork 去重）┘
               B1 + B2 + B5 ──► B3 脚本与编排（orchestrate/cache/ledger/report + reflex-backtest.mjs）──► B3′（可选 docs）
```

| 包  | 依赖     | dev / 异源 verifier（非 GPT、避开 Kimi） | 回退                                  | 规模      |
| --- | -------- | ---------------------------------------- | ------------------------------------- | --------- |
| B0  | —        | sonnet / glm-5.3                         | verifier deepseek-flash               | ~1,000 行 |
| B1  | B0       | glm-5.3 / deepseek-flash                 | verifier sonnet                       | ~1,100 行 |
| B2  | B0       | gpt-6.1-sol / sonnet                     | dev glm-5.3 → verifier deepseek-flash | ~900 行   |
| B4  | B0       | sonnet / glm-5.3                         | verifier deepseek-flash               | ~900 行   |
| B5  | B0       | glm-5.3 / deepseek-flash                 | verifier sonnet                       | ~550 行   |
| B3  | B1 B2 B5 | gpt-6.1-sol / sonnet                     | dev sonnet → verifier glm-5.3         | ~900 行   |
| B3′ | B3       | 原 B3 run resume / 原 verifier resume    | —                                     | <60 行    |

> verifier 一律 `schema:"verdict/v1"`；GLM 开发不派 GLM 验收；GPT 开发派 Claude 系验收；任何包不派 Kimi、不派 GPT 系验收。B0 规模较 r1 增大（DRX 解析器 + 隔离进程测试 + parity），若主会话判定过大，可把 `draft-regex.ts` 拆成 B0a（先合入）而不改变后续包。
> （该约束已于 2026-11-09 解除：GPT 系可参与验收，仍须与开发模型异源）

## 4. 分包细则

### B0 · 契约冻结（独占热点面）

**新建**：`src/reflex/core/{branch-like,port-defaults,draft-regex,draft-schema,identity}.ts`、`src/reflex/drafts/load.ts`（骨架）；测试 `tests/reflex/core/{branch-like,port-defaults,draft-regex,draft-schema,identity}.test.ts`、`tests/reflex/core/draft-regex-redos.test.ts`、`tests/reflex/drafts-off-parity.test.ts`、`tests/fixtures/reflex-drafts-off-parity.json`、`tests/reflex/helpers/turn.ts`（共享构造器：`makeTurn`/`makeHeader`/`makeRecord`/`makeDraft`，后续包只读 import）、`docs/dev/jev-reflex/B0-report.md`。
**修改**：X2 全部 + `src/reflex/wire.ts`（**只**改 `toBranchLike` 的 import）+ `tests/reflex/core/{schema,shadow-scan}.test.ts`（追加）。
**冻结面**：X1；`wire.ts` 除 import 外一字不动；`promotion/match/gate/state.ts` 不动。

**步骤**

1. **先捕获 drafts-off parity（X4）**：在未改代码的 dev HEAD 上写 `drafts-off-parity.test.ts`：真 `activate()` + `{reflex:{enabled:true}}`，固定输入序列（builtin high→shadow→settled、AUTO 命中、miss、ambiguous、单槽替换、correction、repeat，末尾执行 `/reflex status`）+ FakeClock，只记录 reflex 自身的可观察调用（`appendEntry`/`sendMessage` 中 `subagent:reflex*` 的 customType 与 JSON、`setStatus("reflex", …)`、reflex 发出的 `notify`，含 `/reflex status` 的完整输出文本），写 fixture——过滤到 reflex 面，使其不受其他在役子系统影响；之后的断言为逐字节相等。
2. `core/types.ts`（只追加）：`RScriptV1.lineage?`；`ReflexRecordV1.origin?:"draft"`/`draftHash?`/`templateHash?`/`port.portId?`；`ReflexCorrectionV1.targetOrigin?:"draft"`/`targetTemplateHash?`；BA §4.2–§4.7 全部类型（`TurnOrigin`、`Split`、`GateFactName`、`Turn`、`CorrectionFact`、`SessionHeaderFact`、`FamilyIndex`、`CorpusFilter`、`Acceptance`、`ReplayClass`、`ReplayRow`、`SuspectCode`、`SkipReason`、`DraftRejectCode`、`LoadedDraft`、`DraftLoadResult`、`EvidenceIdentity`、`PortReliability`、`StatsV2`、`BacktestEvidence`、`MergedEvidence`、`BatchValidity`、`PromotionVerdictV2`、`CorpusManifestV1`、`EvalBatchV1`、`ExposureRecordV1`、`RevisionRecordV1`、`ReviewFileV1`（带 `unverified: true`））。
3. 设置：`core/settings.ts` 加 `drafts:{enabled}`（默认关；每次 parse 新对象；**保持零 import**）；`src/config/settings.ts` 默认值新对象 + `applySecureDomainOverrides` 改为 `reflex: { ...settings.reflex, enabled:false, drafts:{enabled:false} }`；`setting-specs.ts` 末尾追加 `"reflex.drafts.enabled"`（`bool`，非 live，英文描述）。
4. pin/corpus 刷新（R0 先例）：`GOV_SPECS_GENERATE=1 npx vitest run tests/config/setting-specs-pin.test.ts`；corpus 用 `origin/dev` 的 `captured[i].input` → `GOV_CORPUS_GENERATE=<tmp>` → 程序化比对只多 `.reflex.drafts` → prettier；比对输出贴 B0-report。`settings-override.test.ts` secure/locked 各加 `drafts.enabled===false`；`reflex-settings.test.ts` 补 drafts 解析与别名隔离。
5. `core/branch-like.ts`：逐字搬 `wire.ts:95` `toBranchLike`；`wire.ts` 改 import。
6. `core/port-defaults.ts`：`MVP_PORTS`、`PORT_DEFAULTS`、`PORT_SIGNATURES`、`TOOLLESS_PORTS`（签名为空的 port，今日 = `quota.summary`）、`portOfScript(id)`；全部从 `BUILTIN_SCRIPTS` 派生，同 port 多脚本不一致 ⇒ 加载即抛。
7. `core/draft-regex.ts`：BA §4.5 DRX 递归下降解析器 `parseDrx(src, "strong"|"weak"|"exclude")` + `drxToSource(ast)`（规范化输出，供生成器复用）。
8. `core/draft-schema.ts`：`validateDraft`（BA §4.5 ①–⑦，⑥用 `parseDrx`）、`DRAFT_CAPS`、`DRAFT_LOAD_BUDGET_MS=500`、`DIR_SCAN_CAP=64`、`DRAFT_NAME_RE`。
9. `core/identity.ts`：`templateHash`、`draftHash`、`identityKey`、`resolveIdentity`（BA §4.5）。
10. `core/schema.ts`：`RScriptV1Schema` 加可选 `lineage`；`validateCatalog` 拒 `draft.` 前缀 id。`core/shadow-scan.ts`：三个 record 字段 + 两个 correction 字段宽进；`scanReflexLine`（BD2）。
11. `drafts/load.ts` 骨架：导出 `DraftFs`、`DRAFT_READ_FLAGS`（镜像 `SESSION_READ_FLAGS`）、`loadDrafts` 签名，实现恒空结果。
12. `pi-free.test.ts` 新增 `reflex drafts/** value closure stays pi-free`（`globSync("src/reflex/drafts/*.ts")`，≥1）。
13. 文档（BD10）：README 改写 R-I12、新增 R-I13/R-I14（BA §6）、**威胁模型**一节（同 UID agent 可执行任意 shell ⇒ 本地记录全部未认证；认证点 = catalog PR / 用户明确确认；0700/0600 只防其他 UID）、回测 / 批次 / 暴露 / V2 晋升流程、性能手动测法、门禁表补 drafts 闭包门禁与 parity fixture；data-encryption D8 清单补 `reflex`（含 drafts）；AGENTS.md：`src/reflex/` 行尾补离线回测与 `reflex.drafts.enabled`，Frozen artifacts A 级补 `reflex-drafts-off-parity.json`（改前先读 `tests/docs/agents-md.test.ts`，复核 ≤32 KiB）。

**测试**：DRX——接受集（字面量、`\d{1,4}` 单个且两侧非数字、尾缀、≤12 alternation）与拒绝集（`"a+".repeat(20)+"b"`、`(a|a)+`、`\d+\d+`、`\d{1,4}\d{1,4}`、`\d{1,4}2`、`x?`×9、`[a-z]+`、`.*`、`(?=a)`、`\1`、未转义元字符、超 160 字符）；`draft-regex-redos.test.ts`（r3，三类独立，BA §4.5）：①拒绝集只在主进程断言 `parseDrx` 拒绝、不执行；②（可选）危险演示单独一个子进程（`timeout: 2000`），允许被截止，只断言「被截止或耗时 >1 s」；③接受集另一个独立子进程（`timeout: 5000`），stdin 传 1,000 个 DRX 接受源 × 120cp 对抗失败输入（`2`×120、`吗`×120、交替串、strong 前缀 + 噪声），断言 `status===0`、无终止信号、自报总耗时 < 2 s；`draft-schema` 规则 ①–⑦ 正反例；`identity`（改 id/ver 不变 hash、改任一模板必变、键序无关、legacy 身份）；`port-defaults`（派生一致、`TOOLLESS_PORTS = ["quota.summary"]`）；shadow-scan 新字段 + `entryId`；branch-like 搬迁。
**门禁**：`npx vitest run tests/reflex tests/config tests/secure/settings-override.test.ts tests/boundary tests/web-hub/boundary.test.ts tests/governance tests/integration/reflex-off-golden.test.ts tests/docs/agents-md.test.ts`；FX 门禁第一段（X4）+ parity 测试绿；`npm run format:check && npm run typecheck && npm run build`。
**回滚**：单个 revert。
**验收**：reflex-off golden、activate-trace 字节不变；parity fixture 在改 wire 之前捕获且改后通过；pin/corpus 只多一键 / 一子树；DRX 反例全拒且隔离进程测试绿；README 写明威胁模型且不含「TTY/0600/hash 可证明人工」类表述。

### B1 · 回测核心

**新建（独占）**：`src/reflex/core/backtest/{corpus,markers,split,replay,evidence}.ts`；`tests/reflex/core/backtest/{corpus,family,markers,split,replay,corrections,evidence}.test.ts`、`tests/reflex/core/backtest/fixtures-b1.ts`。
**冻结面**：X1、X2、B2/B4/B5 文件域、`promotion.ts`（只读调用 `countCrossSessionRepeats`）。缺类型 ⇒ 停下上报，不自改 `types.ts`。

**步骤**

1. `markers.ts`：`ORIGIN_MARKERS`、`INJECTED_PREFIXES`、`MARKERS_VERSION`；值导入仅限闭包 pi-free 的源常量，否则镜像；存活测试（字面量仍在 `src/**`，排除 `src/reflex/**`）。
2. `split.ts` + `corpus.ts` 的 `buildFamilyIndex`（BA §4.2）：`byPath`（`path.resolve`）/ `byId`（重复 id 标 duplicate）；解析顺序路径 → 文件名抽 id → unresolved；环检测；`splitOf(root)`：`sha256(root)` 前 4 字节 mod 100 < 60 ⇒ train；unresolved ⇒ `unscored` 并给原因。
3. `corpus.ts` 的 `createCorpusBuilder`：轮次归属、来源、子会话排除、去重（BD5）、`unknownFacts`（BA §4.2 受理确证度；r3：`sourceMode` 只认本轮区间内**原生**的 `pi-hud-llm-time`（`turn.at ≥ HUD_TUI_GATE_SINCE`）或 digest 相同的原生 reflex 记录，「原生」= 去重后归属本文件）、全量 `CorrectionFact`。`markers.ts` 增加 `HUD_TUI_GATE_SINCE`（B1 用 `git log` 查 `src/hud/index.ts` 引入 tui 门的提交时间定值，写进 B1-report）。纯函数，无 fs。
4. `replay.ts`：两层匹配、`acceptance`、`reasked`、memo 语义重放 `corrected`（BA §4.3）、`suspect`。
5. `evidence.ts`：`parseReviewFile`（坏数据 ⇒ undefined）；`backtestEvidence(rows, batch, identity, review)`：只计 `turnKeys ∈ batch` 且 `split==="holdout"` 的行；confirmed / lenient 分账，lenient 附各 `GateFactName` 计数；reasked/corrected 只计 high 并扣评审 `ok` 豁免（计入 `waived`）；`suspects`/`reviewed`/`misfires`；`unscored` 计数。

**测试**：**家族**（真实 header 形状 `{type:"session",version,id,timestamp,cwd,parentSession:"<abs>/<ts>_<id>.jsonl"}`）：正常父子孙、移位路径（父文件已搬目录 ⇒ 文件名兜底命中）、父文件缺失、跨 cwd fork（父在另一 cwd 目录）、环、重复 id、`--cwd` 过滤下家族仍按全量 header 解析；家族同侧；1 万随机根占比 60±2%。**去重**：fork 两文件同条目计 1、保留最早。**来源表**每行 1 个 fixture。**纠正**：长句 / 多行纠正被计、中间夹无关输入后再纠正被计、web/injected 纠正不计、窗口外不计、同目标只计一次、不命中轮次的纠正不计。**稀释反例**：50 条 confirmed 中 3 条 diverge（6%）+ 50 条 lenient no-tool ⇒ `confirmed` 率仍 6%、不达标；lenient 计数单列。**确证判据（r3）**：①fork 文件带着从祖先复制来的 TUI `pi-hud-llm-time` 与 reflex-record，fork 自身在 print/json 下运行（本轮无原生证据）⇒ fork 的轮次全部 `sourceMode` unknown；祖先文件中同一批条目仍确证；②同一会话前半段 TUI（每轮有原生 HUD 条目）、后半段 print（无）⇒ 前半确证、后半 lenient；③会话里只有别的轮次有 reflex-record ⇒ 本轮不确证；④`turn.at < HUD_TUI_GATE_SINCE` 的 HUD 条目不采信；⑤reflex-record digest 与本轮不同 ⇒ 不采信。replay 与 `wire.ts` 同输入同 band。
**门禁**：`npx vitest run tests/reflex/core/backtest tests/boundary/pi-free.test.ts && npm run typecheck`；FX 门禁（X4）；format:check。
**回滚**：revert。**验收**：上列全绿；core/backtest 无 fs 调用、闭包 pi-free。

### B2 · 草案生成

**新建（独占）**：`src/reflex/core/backtest/{cluster,draft-gen,regex-safe}.ts`；`tests/reflex/core/backtest/{cluster,draft-gen,regex-safe}.test.ts`、`draft-gen.property.test.ts`、`draft-gen.pipeline.test.ts`。
**冻结面**：X1、X2（含 B0 的 `draft-regex/draft-schema/port-defaults/identity`，只读）、B1/B4/B5 文件域。

**步骤**

1. `regex-safe.ts`：只经 `draft-regex.ts` 的 AST 构造与 `drxToSource` 产出源；`<n>` → `\d{1,4}`（每 seq ≤1，两侧非数字字面）；尾缀 `(?:吗|呢)?`；产物 `parseDrx` 必过。
2. `cluster.ts`：骨架化（含 `<path>`/`<q>` 的骨架不进 strong）、token、`portLabel`（只对有签名 port；`TOOLLESS_PORTS` 不自动标注）、`clusterTurns`（入参只收 train；混入非 train ⇒ 抛）。
3. `draft-gen.ts`：`generateDrafts(clusters, corpusStats, assign?: Map<clusterId, PortId>) → { drafts, needsPort, skips }`（BA §4.4）：有签名 port 自动；`toolCount===0` 众数且与无工具 port builtin weak 词法相交 ⇒ `needsPort`，`assign` 指定后才生成；examples.hit 代表值实例化 + 自身 matcher 复核 + 去重 + 小簇补全；`tightenDraft`（单调）、`refineDrafts(…, replayFn, maxRounds=3)`；终检 `validateDraft`，不过 ⇒ `skips.validate`。

**测试**：确定性 / 乱序同输出；性质测试 ≥1,000 随机簇 ⇒ 产物 100% 过 `validateDraft` 与 `parseDrx`、无未知键 / argv；`tightenDraft` 单调；**数字簇**（`后台第 3 个 job 呢` 等）产出草案且 hit 全 high、hit 无字面 `<n>`；**小簇**（3 条纯字面）补全到 5 或给出 `skip:"examples"`；**每个有签名 port**（jobs/fleet/git）各至少 1 份草案；**无工具额度链路**（`pipeline.test`，r3 换样本）：样本必须命中入口（含 builtin quota 的 weak 词 `额度`/`quota`）、通过 S0、且不被 builtin 判 high——用「quota 这周用得怎么样」「额度大概还够几天」「额度最近消耗快吗」等（对照 `src/reflex/core/catalog.ts` 的 quota strong 模板 `额度(还)?剩多少` / `还剩多少额度` / `额度(已经)?用了多少(了)?` / `quota ?还有多少` / `quota (剩余|余量|还剩多少)` / `\d+h…` / `\d+小时…` 均不整句匹配；exclude `换`/`不够`/`重置`/`花` 均不含；不含 `IMPERATIVE_VETO` 与 `这个`/`那个` 等指代词——r2 的「这个月 token 还剩多少」会被指代否决、且不含 weak 词，已弃用）。测试先断言每个样本 `evaluateGate` 通过且 builtin match 为 `ambiguous`（非 high），再 `toolCount=0` ⇒ `needsPort` 含 `quota.summary` 建议、**零草案**；加 `assign` 后产出 `port.id==="quota.summary"` 的草案并过校验；skip 原因计数快照。
**门禁**：`npx vitest run tests/reflex/core/backtest/cluster.test.ts tests/reflex/core/backtest/draft-gen.test.ts tests/reflex/core/backtest/draft-gen.property.test.ts tests/reflex/core/backtest/draft-gen.pipeline.test.ts tests/reflex/core/backtest/regex-safe.test.ts tests/boundary/pi-free.test.ts && npm run typecheck`；FX 门禁（X4）；format:check。
**回滚**：revert。**验收**：生成物全过 B0 校验；不宣称 quota 可全自动。

### B4 · 运行时草案加载（shadow-only）

**修改（独占）**：`src/reflex/drafts/load.ts`、`src/reflex/wire.ts`、`src/reflex/command.ts`、`tests/reflex/governance.test.ts`（G5）。
**新建（独占）**：`tests/reflex/drafts/{load,load-race,perf}.test.ts`、`tests/reflex/drafts/load-fifo.test.ts`（Tier 2）、`tests/reflex/wire-drafts.test.ts`、`tests/reflex/command-drafts.test.ts`、`docs/dev/jev-reflex/B4-report.md`。
**冻结面**：X1、X2、`core/**`、`ports/**`、`render-tui.ts`、`wire-shadow`/`wire-auto` 测试（必须不改且全绿）。

**步骤**

1. `load.ts`：BA §4.6 步骤 1–5（受信目录、`opendir` 流式 ≤64、名字白名单、no-follow fd + 同 fd `stat` + 读 cap+1、结束复核 dev/ino、预算 / abort 清理），全部经 `DraftFs`。
2. `wire.ts`：`draftsDir?`/`draftFs?` 可选依赖（BD9）；BD8 加载时机；`scheduleShadowPort` 拆成 `runPortAttach` + `accountBuiltin`（builtin 路径调用顺序与今天逐字等价）；`Pending.origin`；`agent_settled` 按 origin 取脚本；`admitAuto`；草案纠正写带 `targetOrigin/targetTemplateHash` 的条目、不调 `onCorrected`；草案记录写 `origin/draftHash/templateHash/port.portId`；**builtin 记录不加任何字段**（BD11）。
3. `command.ts`：`/reflex drafts`；`status` 的草案计数与「`draft.*` 不可自动作答」提示**只在 drafts 开启时**输出，drafts 关闭时 `status` 文本逐字节不变（r3）；`reset draft.x` 报错。
4. G5：`runAuto(` 单调用点；`catalog.ts` 无 `draft.`；`accountBuiltin(` 每个调用点位于 `origin === "builtin"` 分支内（源码扫描）；G4 覆盖 `drafts/`。

**测试**：**状态隔离**——`autoResolve=["draft.x"]` 且草案 high ⇒ 同步 continue、返回值非 thenable、零 `sendMessage`、record `state:"shadow"`；草案 port error×2 ⇒ `runtimes` 无 `draft.x`、无 notify、builtin 同 port 状态不变；草案目标 correction ⇒ 写条目、无降级；`reset draft.x` 报错；settled 时草案参与 agreement（agree/no-tool/diverge 三例非 unknown）；builtin 与草案交替占用单槽 ⇒ 各自 origin 正确落盘、builtin strike 只算 builtin。**加载**：替换竞态（`DraftFs` 钩子在 open 前把文件换成 symlink ⇒ `not-regular`；stat 后增长 ⇒ 读 cap+1 ⇒ `size`）、目录被整体替换 ⇒ `dir-changed`、目录 0755/symlink ⇒ `dir-untrusted`、65 个 dirent ⇒ `dir-cap` 且 `read()` 调用 ≤65、超时后所有 handle 已 `close`、timer 已清、后续文件未打开、abort 同理；FIFO（Tier 2，`mkfifo` 不可用则 skip）⇒ open 不阻塞、`not-regular`。**drafts 关** ⇒ 零 fs 访问（`DraftFs` spy）且 `drafts-off-parity`（含 `/reflex status` 文本）逐字节通过；drafts 开 ⇒ status 出现草案行（对照用例）；secure/locked 不加载。**perf**：S0 通过且 builtin miss 的输入 × 16 份满额草案（strong 12 / weak 8 / exclude 32）的失败匹配，1 万次记录 p99 与 max（断言 p99 ≤1 ms，×5 宽容注释），另含对抗输入集；报告注明「不能替代 DRX 语法证明」。
**门禁**：`npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts tests/governance && npm run typecheck`；FX 门禁（X4）；format:check。
**回滚**：revert；运行时 `reflex.drafts.enabled=false` + `/reload` 或删除 `drafts/*.json`（精确路径）。
**验收**：上列全绿；本机冒烟：1 份合法 + 1 份 0644 草案 ⇒ `/reflex drafts` 1 loaded / 1 `perm`；问草案例句 ⇒ 模型照常作答、settled 后 `origin:"draft"` 记录 agreement 非 unknown。

### B5 · 晋升 V2 + fork 去重修复

**修改（独占）**：`src/reflex/core/promotion.ts`（只追加；旧导出逐字节不变）、`scripts/dev/reflex-shadow.mjs`。
**新建（独占）**：`src/reflex/core/shadow-dedupe.ts`；`tests/reflex/core/{promotion-v2,batch-validity,shadow-dedupe,identity-e2e}.test.ts`、`docs/dev/jev-reflex/B5-report.md`。
**冻结面**：X1、X2、B1/B2/B4 文件域。

**步骤**

1. `shadow-dedupe.ts`：`createRowDeduper()`（键 `entryId\0at\0digest`；无 entryId 退化 `at\0digest\0scriptKey`）。
2. `promotion.ts` 追加：`PROMOTION_GATE_V2`；`accumulateV2(rows, resolve)`（按 `identityKey`，correction 经 `targetTemplateHash` 或 catalog 解析到身份）；`portReliabilityV2(rows)`（键 `portId@portVer`，builtin 由 `portOfScript` 反查；`missing` = 有 port 候选却无 `port` 结果的记录）；`batchValidity(batch, identity, exposures, manifests)`（r3：只看 `exposure.batchId === batch.batchId`）；`lastRevisedAt(lineage, revisions)`；`admitBatch(candidate, lineage, revisions, batches, exposures)`（BA §4.7：`before-revision` / `reused-exposed-turns`）；`buildLiveEvidence(rows, catalog, drafts)`（两个脚本共用的唯一实时证据入口）；`evaluateMergedPromotion`（BA §4.7，含 `scanComplete`、`review-incomplete`、`missing ⇒ undetermined`）。
3. `reflex-shadow.mjs`：`scanReflexLine` + 去重器；按 `port@portVer` 可靠性小节（含 missing）；结论改用 `buildLiveEvidence` + `evaluateMergedPromotion`；扫描任何文件出错 ⇒ `scanComplete:false`；`--json` 只追加字段。

**测试**：证据矩阵——confirmed 49/50、diverge 5%/5.1%、lenient 不进率、review 不全 ⇒ 否、misfire=1 ⇒ 否、`scanComplete:false` ⇒ 否；port：9 次 ⇒ 否、10 次含 1 uncertain ⇒ 否、10/10 ⇒ 是、`portVer` 升级后旧版本 10/10 不复用 ⇒ 否、`missing=1` ⇒ undetermined、迟到失败（槽替换后结果丢弃）计 missing、fork 去重后 runs 不重复；`batchValidity`：同 hash 暴露 ⇒ 有效、他 hash 暴露 ⇒ `exposed-then-modified`、manifest 缺失 ⇒ 无效、**另一批次**的暴露不影响本批次、从未暴露的旧批次在修订后仍有效；**批次准入 e2e（r3）**：批次 B1 在 H1 下展示失败 → 模板改为 H2（`revisions` 记 H2）⇒ ①B1 对 H2 `exposed-then-modified`；②把 B1 的同一批轮次换 batchId 重新打包 ⇒ `admitBatch` 拒绝 `reused-exposed-turns`；③含 `at ≤ lastRevisedAt` 的轮次 ⇒ `before-revision`；④修订之后新产生、digest 从未进过任何已暴露批次的 holdout 轮次 ⇒ 准入通过且对 H2 有效；`lastRevisedAt` 取 `max(firstSeenAt, gitCommitAt)`、first-seen 不被后写覆盖；**identity-e2e**：①同 id 同 ver 改模板（hash 变）⇒ 两份身份证据不混；②`draft.x` 的纠正 1 条，改写成 builtin `foo@1`（`lineage:"draft.x"`、同模板）⇒ `foo` 零容忍项仍为 1、不合格；旧 `evaluatePromotion` 用例不改仍绿。
**门禁**：`npx vitest run tests/reflex/core/promotion.test.ts tests/reflex/core/promotion-v2.test.ts tests/reflex/core/batch-validity.test.ts tests/reflex/core/shadow-dedupe.test.ts tests/reflex/core/identity-e2e.test.ts tests/reflex/core/shadow-scan.test.ts && npm run typecheck`；FX 门禁（X4）；format:check；Tier 3：`npm run build && node scripts/dev/reflex-shadow.mjs --days 14`，输出贴报告。
**回滚**：revert。**验收**：V2 为唯一合并判定；fork 副本不再产生跨会话重复。

### B3 · 编排、账本与回测脚本

**新建（独占）**：`scripts/dev/reflex-backtest.mjs`、`src/reflex/core/backtest/{orchestrate,cache-format,ledger-format,report}.ts`；`tests/reflex/core/backtest/{orchestrate,cache-format,ledger-format,report}.test.ts`、`docs/dev/jev-reflex/B3-report.md`。
**冻结面**：其余全部（B1/B2/B5 产物只读调用；`reflex-shadow.mjs` 不改——共用入口由 B5 的 `buildLiveEvidence` 提供）。

**步骤**

1. `orchestrate.ts`：注入 `{ listFiles, readLines, cache, ledger, clock }` 的纯编排——两遍扫描、缓存命中 / 失效、`generate`、`batch freeze`、`review` 数据准备、`show` 数据准备、`promote`；任一读错误 ⇒ `scanComplete:false`；展示留出失败明细时返回需追加的暴露记录（由脚本写）。
2. `cache-format.ts`：BA §4.2 缓存行（Turn + CorrectionFact + header）编解码与失效键；`ledger-format.ts`：manifest / batch / exposure / revision / review 编解码（`unverified:true`），manifest/batch 只允许新建（`wx`），`revisions.jsonl`/`exposure.jsonl` 只追加；orchestrate 在任何命令解析身份时先补 revision 记录（BA §4.7）。
3. `report.ts`：可导出报告渲染（聚合、digest、≤24cp 脱敏首行、身份元组、页眉：manifestHash、扫描字节数、各过滤阶段计数、train/holdout/unscored、confirmed/lenient 与 unknownFacts 分布、unresolved 原因、skip 原因、「应用缓存冷/热」标注）；`show` 渲染（本机，仅原文脱敏 + 工具形状，无 argv）。
4. `reflex-backtest.mjs`：BA §4.8 子命令；secure env ⇒ 3、缺 dist ⇒ 2；`show` 与 `--report/--json` 组合 ⇒ 拒绝；目录 0700 / 文件 0600、tmp + rename；不联网。

**测试（Tier 1）**：orchestrate 用内存 fs——扫描失败（某文件读抛）⇒ 结论非 eligible；评审过期（新 suspect 未评审）⇒ `review-incomplete`；同一组实时 rows 下 orchestrate 的 promote 结论与 `evaluateMergedPromotion(buildLiveEvidence(rows))` 完全一致（另源码断言 `reflex-shadow.mjs` 调用 `buildLiveEvidence`）；缓存失效依赖（`normalizeVersion`/`MARKERS_VERSION`/`CORRECTION_RE`/文件 size·mtime·ino 各改一个 ⇒ 对应重建，父链文件变化 ⇒ 家族索引重建）；cold 与 warm 的 Turn/CorrectionFact/ReplayRow/证据逐项相等；展示留出 suspect ⇒ 产生暴露记录，只展示聚合 ⇒ 不产生；`batch freeze --lineage L` 走 `admitBatch`，被拒时不写批次文件；首次见到新 templateHash ⇒ 先写 revision 再评估；manifest/batch 覆盖写被拒；report 永不含 `/`·`~/`·`.jsonl`·argv（性质测试）。
**Tier 3 手动清单（贴 B3-report）**：①性能：删 `<agentDir>/reflex/cache/` 后 `/usr/bin/time -v node scripts/dev/reflex-backtest.mjs --days 30` 记「应用缓存冷」；随后连跑 3 次取中位数记「应用缓存热」；同时记录 manifestHash、扫描字节数、各过滤计数、峰值 RSS、`uptime`。≤90 s / ≤3 s 是**手动目标、不保证**，不达标只记录交主会话。②secure env ⇒ exit 3。③`show <digest> --report` ⇒ 拒绝。④`--report` 产物 `grep -E '(/home|~/|\.jsonl)'` 为空。⑤`stat -c %a` 核 700/600。⑥`generate` 产物在 B4 已合入时经 `/reflex drafts` 全部 loaded。
**门禁**：`npx vitest run tests/reflex/core/backtest && npm run typecheck && npm run build`；FX 门禁（X4）；format:check。
**回滚**：revert；本机 `rm -r` 精确路径清 `<agentDir>/reflex/{cache,drafts-out,reports}`（账本 `manifests/ batches/ exposure.jsonl reviews/` 由用户决定是否保留）。
**验收**：Tier 1 全绿；Tier 3 六项有输出。

### B3′ ·（可选）docs 收口

仅当 B1–B5 报告记录了 README 偏差时开：文件域 `docs/dev/jev-reflex/README.md`；门禁 format:check；verifier 核对 README 与代码一致。

## 5. 门禁汇总

| 门禁                                                                                            | 包                 | Tier |
| ----------------------------------------------------------------------------------------------- | ------------------ | ---- |
| FX 门禁（X4：既有冻结文件对 `origin/dev`，新 parity fixture 对 `B0_COMMIT`）                    | 每包               | 1    |
| `reflex-drafts-off-parity.json`（A，新；drafts 关逐字节）                                       | B0 捕获，B4 起必绿 | 1    |
| pin/corpus 只多 `reflex.drafts.enabled` / `.reflex.drafts`                                      | B0                 | 1    |
| secure/locked 强制 drafts 关                                                                    | B0                 | 1    |
| pi-free：`core/**`、`ports/*`、`drafts/*`（新）；web-hub boundary：`core/settings.ts` 零 import | B0 建，全程        | 1    |
| DRX 拒绝集（主进程只解析）+ 接受集独立子进程（正常退出、<2 s）；危险演示另进程可选              | B0                 | 1    |
| governance G2–G5                                                                                | B4                 | 1    |
| `drafts/perf.test.ts`（p99 ≤1 ms，记录 max）                                                    | B4                 | 1    |
| `load-fifo.test.ts`                                                                             | B4                 | 2    |
| `reflex-backtest.mjs` 冷 / 热、`reflex-shadow.mjs` 跑通                                         | B3 / B5            | 3    |
| 每包：format:check + typecheck + 定向 vitest；全量 `npm test` + build 由主会话后台一份          | 每包               | —    |

## 6. 冲突预检 spec（2026-11-05 已实跑，见 §6.1 结果）

B0 开工前（`inflight` 按届时 `git status --short` 填，X3 满足时为空）：

```json
[
  {
    "id": "B0",
    "globs": [
      "src/config/settings.ts",
      "src/reflex/core/settings.ts",
      "src/reflex/setting-specs.ts",
      "src/reflex/core/types.ts",
      "src/reflex/core/schema.ts",
      "src/reflex/core/shadow-scan.ts",
      "src/reflex/core/branch-like.ts",
      "src/reflex/core/port-defaults.ts",
      "src/reflex/core/draft-regex.ts",
      "src/reflex/core/draft-schema.ts",
      "src/reflex/core/identity.ts",
      "src/reflex/drafts/load.ts",
      "src/reflex/wire.ts",
      "tests/config/__corpus__/setting-specs-pin.json",
      "tests/config/__corpus__/settings-corpus.json",
      "tests/config/reflex-settings.test.ts",
      "tests/secure/settings-override.test.ts",
      "tests/boundary/pi-free.test.ts",
      "tests/reflex/core/schema.test.ts",
      "tests/reflex/core/shadow-scan.test.ts",
      "tests/reflex/core/branch-like.test.ts",
      "tests/reflex/core/port-defaults.test.ts",
      "tests/reflex/core/draft-regex.test.ts",
      "tests/reflex/core/draft-regex-redos.test.ts",
      "tests/reflex/core/draft-schema.test.ts",
      "tests/reflex/core/identity.test.ts",
      "tests/reflex/drafts-off-parity.test.ts",
      "tests/fixtures/reflex-drafts-off-parity.json",
      "tests/reflex/helpers/turn.ts",
      "docs/dev/jev-reflex/README.md",
      "docs/dev/data-encryption/README.md",
      "AGENTS.md"
    ]
  },
  { "id": "inflight", "globs": ["<git status --short 实测路径>"] }
]
```

B0 合入后 B1 ∥ B2 ∥ B4 ∥ B5（全部精确文件名；工具不支持 `{a,b}`；同目录 `core/backtest/` 下 B1/B2 只靠文件名区分）：

```json
[
  {
    "id": "B1",
    "globs": [
      "src/reflex/core/backtest/corpus.ts",
      "src/reflex/core/backtest/markers.ts",
      "src/reflex/core/backtest/split.ts",
      "src/reflex/core/backtest/replay.ts",
      "src/reflex/core/backtest/evidence.ts",
      "tests/reflex/core/backtest/corpus.test.ts",
      "tests/reflex/core/backtest/family.test.ts",
      "tests/reflex/core/backtest/markers.test.ts",
      "tests/reflex/core/backtest/split.test.ts",
      "tests/reflex/core/backtest/replay.test.ts",
      "tests/reflex/core/backtest/corrections.test.ts",
      "tests/reflex/core/backtest/evidence.test.ts",
      "tests/reflex/core/backtest/fixtures-b1.ts"
    ]
  },
  {
    "id": "B2",
    "globs": [
      "src/reflex/core/backtest/cluster.ts",
      "src/reflex/core/backtest/draft-gen.ts",
      "src/reflex/core/backtest/regex-safe.ts",
      "tests/reflex/core/backtest/cluster.test.ts",
      "tests/reflex/core/backtest/draft-gen.test.ts",
      "tests/reflex/core/backtest/draft-gen.property.test.ts",
      "tests/reflex/core/backtest/draft-gen.pipeline.test.ts",
      "tests/reflex/core/backtest/regex-safe.test.ts"
    ]
  },
  {
    "id": "B4",
    "globs": [
      "src/reflex/drafts/load.ts",
      "src/reflex/wire.ts",
      "src/reflex/command.ts",
      "tests/reflex/governance.test.ts",
      "tests/reflex/wire-drafts.test.ts",
      "tests/reflex/command-drafts.test.ts",
      "tests/reflex/drafts/load.test.ts",
      "tests/reflex/drafts/load-race.test.ts",
      "tests/reflex/drafts/load-fifo.test.ts",
      "tests/reflex/drafts/perf.test.ts",
      "docs/dev/jev-reflex/B4-report.md"
    ]
  },
  {
    "id": "B5",
    "globs": [
      "src/reflex/core/promotion.ts",
      "src/reflex/core/shadow-dedupe.ts",
      "scripts/dev/reflex-shadow.mjs",
      "tests/reflex/core/promotion-v2.test.ts",
      "tests/reflex/core/batch-validity.test.ts",
      "tests/reflex/core/shadow-dedupe.test.ts",
      "tests/reflex/core/identity-e2e.test.ts",
      "docs/dev/jev-reflex/B5-report.md"
    ]
  }
]
```

**交集分析**：r1 的三处交集已前移 B0（BD1/BD2），B2 回灌依赖改注入（BD3）。r2 新增面同样归属唯一：DRX / identity / parity 归 B0；`buildLiveEvidence` 归 B5 并被 B3 只读调用，因此 B3 **不改** `reflex-shadow.mjs`；B4 不再改 `wire-shadow`/`wire-auto` 测试（BD11 后 builtin 记录不变）。剩余只读依赖（B1 读 `promotion.ts`、B4 读 `draft-schema.ts`）不构成写冲突。B0 → B4 都改 `wire.ts`，但为串行。

### 6.1 预检实跑结果

2026-11-05 实跑（`node skills/dev-flow/scripts/conflict-check.mjs - --cwd /home/bluecake/ai/pi-toolkit`，spec 经 stdin）：

- **B0 × inflight**：`inflight` = 当时 `git status --short` 的 30 个在役路径（另一任务的 fabric xs / web-hub outdated-reload 改动，含未跟踪 `tests/fixtures/web-hub/epoch-up-compat-golden.json`；已排除本两份文档）。结果：B0 命中 17 个已存在文件、inflight 30 个，**无交集**，exit 0。
- **B1 ∥ B2 ∥ B4 ∥ B5**：B1/B2 为纯新建（0 个已存在文件，工具提示确认前缀，属预期）、B4 命中 3 个、B5 命中 2 个，**无交集、无潜在交集**，exit 0。
- 派 B0 前、派四包并行前须按届时 `git status` 重跑；在役任务若在 B0 开工前提交了 `tests/fixtures/` 新文件，须已推到 `origin/dev`，否则 B0 的 fixtures 门禁会误红（X3）。

## 7. 上线流程

1. B0 → (B1 ∥ B2 ∥ B4 ∥ B5) → B3 →（B3′）⇒ 一次 push。
2. 本机：`npm run build && node scripts/dev/reflex-backtest.mjs`（应用缓存冷一次）→ `generate`（无工具候选用 `--assign`）→ 挑选 `drafts-out/` 或 `--emit` → `reflex.drafts.enabled=true` + `/reload` → 草案 shadow 攒 `port@portVer` 证据。
3. `batch freeze` 冻结留出批次 → `review <portId>`（未认证记录，展示即暴露）→ 若据此修改模板：该批次对新模板作废（新 hash 自动记入 `revisions.jsonl`），等新历史后 `batch freeze --lineage <L>`（`admitBatch` 只收修订之后、digest 未曾暴露的轮次）冻结新批次，或靠实时 shadow 的问法证据（b）。
4. 人把草案改写进 `catalog.ts`（builtin id、`lineage:"draft.x"`、升 version）→ `npm run build && node scripts/dev/reflex-backtest.mjs --promote <id> --batch <batchId>` → PR 描述贴身份元组与结论 → **用户批准 PR** 即人工认证 → 用户把 id 加进 `reflex.autoResolve`。

## 8. 残留风险

- 同 UID agent 可伪造 / 删除评审、暴露、批次、manifest 记录（U6 已接受）；运行时安全不依赖这些记录，晋升认证只在 PR。
- 暴露只追踪「展示失败明细」，聚合计数不算暴露（BD12）。`admitBatch` 按 digest 排除已暴露问句，常见问法会随暴露逐渐被挤出新批次（有意保守）。
- `sourceMode` 只认本轮原生 HUD 计时条目或 reflex 记录：HUD 关闭或早于 `HUD_TUI_GATE_SINCE` 的轮次一律 lenient；若 HUD 将来在非 tui 下也写计时条目，确证判据失效（B1 的 markers 存活测试同时断言 HUD 的 tui 门注释/代码仍在）。
- `uncertain` 算不成功、`missing` 算未判定：quota 与快模型场景可能长期达不到 port 门槛（有意保守，§9 Q2）。
- 离线 memo 看不到进程重启 ⇒ 纠正只会多计。
- DRX 不能表达路径 / 引号内容，相关问法只能进 weak。
- 缓存含原句：同域同权限；secure env 拒绝。

## 9. 仍需用户拍板

1. **「依据留出失败修改」的机械口径**（Recommended）：只要某留出批次的失败明细（suspect 行 / review / show）曾在模板 hash H 下被展示，之后同 lineage 出现任何新 hash，该批次对新 hash 一律作废（不判断修改是否真的「依据」这些失败）。备选：由人在修改时声明是否依据留出失败（未认证、可误报，但样本保留更多）。
2. **port 结果缺失的处理**（Recommended）：`missing>0` ⇒ 该 `port@portVer` 可靠性未判定，不新增落盘类型（最保守，快模型下可能难达标）。备选：drafts 开启时新增 `subagent:reflex-port` 完成事件条目，迟到结果也落盘、缺失可补齐（需改写 R-I9，输出面多一种 customType）。

## 10. 评审处置表（GPT 评审第 1 轮；「r3」栏 = 复审后 root 裁定的修订）

| #   | 级别    | 评审项                                                  | 处置                                                                                                                                                                     | 改在哪里                                                                           | r3                                                                                                                                                                                                                                                                                                                            |
| --- | ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 正则安全：相邻重叠 `+` 组合爆炸，计时器打断不了同步匹配 | 改为 DRX 有限语法 + 递归下降解析器；每 seq 至多一个 `\d{1,4}`、两侧非数字；尾缀固定；附路径数上界论证；反例与长失败输入在隔离子进程硬截止测试                            | BA §4.5、§5 K4；plan B0 步骤 7–8 与测试、B2 步骤 1、§5                             | 复审未闭合 → 已改：拒绝集只验证解析器拒绝、不执行；危险演示单独进程、允许被截止；接受集另一独立进程，断言正常退出且 <2 s。BA §4.5「测试编排（r3）」；plan B0 测试 `draft-regex-redos`、§5                                                                                                                                     |
| 2   | Blocker | 人工认证不成立                                          | 评审改为未认证记录；威胁模型写入 README；认证点 = catalog PR / 用户确认；删除 TTY/0600/listHash 认证表述                                                                 | BA §0.5、§4.8、§5 K7、§6 R-I14；plan §0 U6、B0 步骤 13、B3                         | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 3   | Blocker | `parentSession` 是文件路径                              | 第一遍全量 header 双索引（规范化路径 + id），文件名兜底，环 / 重复 id / 缺失 ⇒ unresolved ⇒ `unscored`，报告 unresolved 数；真实 header 形状测试                         | BA §2、§4.2；plan BD4、B1 步骤 2 与家族测试                                        | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 4   | Blocker | 留出集污染                                              | 不可变 manifest + 批次 + 暴露账本；`batchValidity` 作废规则；新批次 / 实时 shadow 接替；旧批次成回归集                                                                   | BA §0.6、§4.7；plan §0 U7、BD12、B0 类型、B5 `batchValidity`、B3 ledger、§7 步骤 3 | 复审未闭合 → 已改：`batchValidity` 只看本 batchId 的暴露；新增 `revisions.jsonl`（first-seen + catalog git 提交时间，取 max）作修订时间来源；`admitBatch` 要求晚于 `lastRevisedAt` 且 digest 不在任何已暴露批次，重新打包旧样本被拒；e2e 四例。BA §4.7；plan BD12、B0 类型、B5 步骤 2 与测试、B3 步骤 2 与测试、§7 步骤 3、§8 |
| 5   | Major   | 加载 TOCTOU                                             | 受信目录检查、`opendir` 流式 ≤64、no-follow+non-blocking fd、同 fd stat、读 cap+1、结束复核 dev/ino、超时 / abort 关 fd 清 timer；竞态 / FIFO / 增长 / 大目录 / 清理测试 | BA §4.6；plan B4 步骤 1 与加载测试                                                 | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 6   | Major   | 草案分支与共享 helper 不兼容                            | 拆 `runPortAttach` / `accountBuiltin`；按 origin 取脚本做 agreement；`admitAuto` 只认 builtin；状态隔离测试 6 项；删除「类型上不可达」                                   | BA §2、§4.6；plan B4 步骤 2、4 与测试                                              | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 7   | Major   | hash 与晋升身份                                         | `lineage` + `templateHash` 身份；correction 关联字段；独立 `accumulateV2`，旧 API 不变；两条端到端验收                                                                   | BA §4.5、§4.7、§5 K8；plan B0 步骤 2、9，B5 identity-e2e                           | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 8   | Major   | 宽松 gate 稀释分母                                      | `unknownFacts` + confirmed/lenient 分账，晋升率只用 confirmed；稀释反例测试                                                                                              | BA §4.2、§4.3、§4.7、§5 K11；plan B1 步骤 3、5 与测试                              | 复审未闭合 → 已改：弃用会话级 reflex-record 证据；`sourceMode` 只认本轮区间内原生（去重后归属本文件）的 `pi-hud-llm-time`（≥`HUD_TUI_GATE_SINCE`）或同 digest 的 reflex 记录，缺失即 unknown；补 fork 复制证据、会话内换模式等 5 例。BA §4.2、§7.2；plan B1 步骤 3 与测试、§8                                                 |
| 9   | Major   | 纠正证据不全                                            | 全量 `CorrectionFact` 时间线（不受单行过滤），按实时 memo 语义重放、只认 tui/replay；四类测试 + cold/warm 等价                                                           | BA §4.2、§4.3；plan B1 纠正测试、B3 cold/warm                                      | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 10  | Major   | quota 草案不可达                                        | `TOOLLESS_PORTS` 不自动标注，输出 `needs-port` 候选，`--assign` 人工指定；真实无工具额度链路测试                                                                         | BA §2、§4.4、§5 K10；plan B0 步骤 6、B2 步骤 2–3 与 pipeline 测试                  | 复审未闭合 → 已改：样本换成命中 weak 词、过 S0、builtin 判 ambiguous 的「quota 这周用得怎么样」「额度大概还够几天」「额度最近消耗快吗」，测试先断言 gate 通过且非 high；保留未 assign 零草案、assign 后生成。plan B2 测试                                                                                                     |
| 11  | Major   | 例句与 matcher 不一致                                   | `<n>` → `\d{1,4}`，hit 用代表值实例化 + 自身 matcher 复核；小簇补全与去重策略；数字簇 / 小簇 / 每 port 测试与 skip 统计                                                  | BA §4.4；plan B2 步骤 3 与测试                                                     | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 12  | Major   | drafts-off 字节                                         | 新 A 级 parity fixture（改 wire 前捕获）；builtin 记录不加任何字段，portId 反查                                                                                          | BA §6；plan BD11、X4、B0 步骤 1、B4 测试                                           | 复审未闭合 → 已改：status 草案增量只在 drafts 开启时输出；parity 输入序列含 `/reflex status`；新 fixture 以 `B0_COMMIT` 为基线，各包门禁统一为 FX 门禁。BA §4.6、§6；plan X4、B0 步骤 1 与门禁、B1–B5 门禁、B4 步骤 3 与测试、§5                                                                                              |
| 13  | Major   | port 汇总版本与缺失结果                                 | 按 `port@portVer`，`missing` 单列，`missing>0` ⇒ undetermined；版本升级 / 缺失 / 迟到失败 / 去重 runs 测试                                                               | BA §4.7、§5 K6；plan BD13、B5 步骤 2 与测试、§9 Q2                                 | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 14  | Minor   | 评审展示与 CLI 测试                                     | `show` 本机完整轮次（无 argv，拒绝导出）vs 可导出报告；`orchestrate.ts` 注入 I/O 的确定性编排测试（扫描失败、评审过期、两脚本结论一致、缓存失效依赖、cold/warm）         | BA §4.8；plan B3 步骤 1–4 与测试                                                   | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| 15  | Minor   | 性能测法                                                | B4 测 S0 通过 + builtin miss + 满额草案失败匹配，记 max 与对抗用例且注明不替代语法证明；B3 标「应用缓存冷/热」、固定 manifestHash / 扫描字节 / 过滤数，目标不保证        | BA §4.8；plan B4 perf、B3 Tier 3 ①                                                 | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| —   | 补充    | trace 描述不准                                          | 更正为「phase 1 注册顺序 + phase 2 start/shutdown 可观察调用」，并说明 drafts 不产生这些调用                                                                             | BA §6；plan X4                                                                     | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
| —   | 补充    | 冲突预检重跑                                            | spec 更新（B0 新增 DRX/identity/parity，B4 去掉 wire-shadow/auto，B5 加 batch-validity/identity-e2e），已实跑                                                            | plan §6、§6.1                                                                      | r2 已闭合，r3 无改动                                                                                                                                                                                                                                                                                                          |
