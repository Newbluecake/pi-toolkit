# B5 · 晋升 V2 + fork 去重修复 — 交付报告

> #25 包 B5；开发基线 dev / `dc036048`；B0 契约基线 `cd1d6c4a`。
> 依据：`README.md`、`backtest-plan.md` B5、`backtest-arch.md` §4.7、`B0-report.md`、AGENTS I8。
> 仅实现本包声明文件域；没有 git 写操作，没有全量或 secure 测试。

## 1. 三个步骤与实现

1. **fork 去重**：新增 `core/shadow-dedupe.ts`。`createRowDeduper()` 返回闭包内的接受函数（首次 true、复制品 false），键为 `entryId\0at\0digest`；无 id 时为 `at\0digest\0scriptKey`。不使用模块级可变状态。
2. **追加 V2 API**：`promotion.ts` 新增 `PROMOTION_GATE_V2`、`LiveEvidenceRow`、`accumulateV2`、`portReliabilityV2`、`batchValidity`、`lastRevisedAt`、`admitBatch`、`buildLiveEvidence`、`evaluateMergedPromotion`。旧文件全文 7,482 字节保持为新文件的原样前缀；旧导出及旧用例不改。
   - 按 `identityKey(lineage + templateHash)` 汇总；纠正通过 `targetTemplateHash` 或 catalog 身份解析。草案改写为 builtin 后，通过 builtin 的 `lineage` 反查已删除草案的 port，纠正仍归同一身份。
   - `judged` 只计 agree/no-tool/diverge；unknown、ambiguous 不稀释分歧率。AUTO answer 计 port 成功，不伪造模型 agreement。
   - `buildLiveEvidence` 在所有统计之前去重，同时汇总实时问法、零容忍项、跨会话重复、port 可靠性；未知 session/answer at 的重复证据保持未判定。
   - port 统计不复用不同 `portVer` 的成功。shadow/fallback 执行记录及 AUTO answer 参与 port 统计；repeat/ambiguous 未执行 port，不计 missing；unavailable 单独记账，不进 runs。
   - 缺结果没有版本：放入 **`port@0 missing`**，不是成功池。missing 保守投影到同 port 每个已观察版本；目标版本没有 bucket 时，调用方用 `@0.missing` 构造目标版本 `{runs:0, ok:0, missing, unavailable:0}`。**旧版成功绝不填进新版 runs/ok**；missing>0 结论为 undetermined。
   - 已删除草案的缺结果可从同 id/ver/templateHash 的其它记录反查 portId；冲突提示不猜测。当前加载的 catalog/drafts 也可提供 port 绑定。
   - `batchValidity` 只看本 batchId、同 lineage 的暴露；其它 hash 作废，同 hash 不作废；其它批次不影响；manifest 缺失失败。从未暴露的旧批次不会因修订时间自动作废。
   - `lastRevisedAt`：同 hash 的第一条 firstSeenAt 胜出，不被后写覆盖；gitCommitAt 可收紧截止；所有 hash 取最大值。`admitBatch` 拒绝 `at <= cutoffAt`，以及任何已暴露批次（不分 lineage）中出现过的 digest。
   - 合并判定只用 confirmed 回测率或实时率，review 覆盖与 misfire 另外守卫；传入的无效 backtest 仍阻断晋升。**作废批次只作回归时，B3 不应把它作为 backtest 传入**，而应仅传实时证据。无 live 的完整回测证据可依赖回测已判定的跨会话重复；存在 live 而其重复未判定时仍失败关闭。
3. **shadow CLI**：使用 `scanReflexLine` 与去重器，按 `portId@portVer` 打印可靠性小节（含 missing）。结论来自唯一 `buildLiveEvidence + evaluateMergedPromotion`；当前 port 版本从 port factories 的 registry 读取，不复制版本常量，不执行 port。
   - JSON 保留所有原有字段与旧统计结构，仅追加 `scanComplete`、`scanErrors`、`ports`、`identities`。旧 `eligible/reasons` 的值按要求改为 V2 结论；不是保留旧判定算法。
   - 任意文件读取失败、目录遍历失败、非法 JSON、非法 reflex 行或无效时间都使 `scanComplete=false`，继续给出失败关闭的部分报告。原先缺 session 根目录产生空报告的语义保留。

## 2. B3 对接签名

```ts
type LiveEvidenceRow = PromotionRow & { entryId?: string; session?: string; at?: number };
accumulateV2(rows: readonly PromotionRow[], resolve: (row: IdentityRow) => EvidenceIdentity | undefined): Map<string, StatsV2>;
portReliabilityV2(rows: readonly PromotionRow[]): Map<`${PortId}@${number}`, PortReliability>;
batchValidity(batch: EvalBatchV1, identity: EvidenceIdentity, exposures: readonly ExposureRecordV1[], manifests: readonly CorpusManifestV1[]): BatchValidity;
lastRevisedAt(lineage: string, revisions: readonly RevisionRecordV1[]): number;
admitBatch(candidate: readonly Pick<Turn, "at" | "digest">[], lineage: string, revisions: readonly RevisionRecordV1[], batches: readonly EvalBatchV1[], exposures: readonly ExposureRecordV1[]): { ok: boolean; reason?: "before-revision" | "reused-exposed-turns"; cutoffAt: number };
buildLiveEvidence(rows: readonly LiveEvidenceRow[], catalog: readonly RScriptV1[], drafts: readonly RScriptV1[]): { stats: Map<string, StatsV2>; ports: Map<`${PortId}@${number}`, PortReliability> };
evaluateMergedPromotion(e: MergedEvidence): PromotionVerdictV2;
```

`portReliabilityV2` 本身是 fold；需要 fork 去重时使用 `buildLiveEvidence`（两脚本共用入口）。V2 verdict 携带 identity，传入 backtest 时追加 batchId/manifestHash，仅供人工批准 catalog PR 的建议，不认证本地账本，不改设置。

## 3. 问题、默认做法与 root 裁定

使用 `message_agent(to:"root", kind:"finding")` 上报，无冻结面修改：

| 问题                                  | 默认做法                                                                                        | 裁定 / 状态                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 实时行需要 envelope 元数据，B0 不应改 | 在 promotion.ts 本地追加交叉类型，返回 `{stats, ports}` 两个 Map                                | root 明确同意；已实施                                         |
| 缺结果没有 portVer                    | `@0 missing`，保守投影目标版本，不复用旧成功；CLI 从 factories 读当前版本                       | root 明确同意，并要求新版 + 旧版 10/10 + missing 测试；已覆盖 |
| admitBatch candidate/返回结构未规定   | `readonly Pick<Turn,"at"                                                                        | "digest">[]`，返回 `{ok,reason?,cutoffAt}`                    | root 明确同意；已实施 |
| OR 判定与传入的无效 backtest          | 按 B5 矩阵 review 不全 / misfire 必拒；作废批次只作回归、不传为证据；无 live 时允许完整回测路径 | 已 finding 上报；按默认实施，需 B3 遵守调用约定               |

README 的既有 V2 流程已涵盖规则；本包文件域不含 README，新的 API 细节在此报告交付 root，由集成方按需要同步子系统 README。

## 4. 测试矩阵

| 需求                                       | 真实断言覆盖                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| confirmed 49/50、lenient 不进率            | promotion-v2：49 拒绝、50 通过；lenient 1000 不补样本、不稀释分歧                                                               |
| 分歧 5%/5.1%                               | 实时与回测各以 50/1000、51/1000 验证                                                                                            |
| review 不全、misfire=1、scanComplete=false | 各断言 not-eligible 与具体 reason                                                                                               |
| port 9/10、uncertain、unavailable          | 9 拒绝、10 通过、10 次含 uncertain 拒绝；unavailable 单列                                                                       |
| 版本升级、missing、迟到失败                | 旧版 10/10 不支持新版；缺 port 结果记 @0；旧版 10/10 + @0 missing 对新版仍 undetermined                                         |
| fork 去重                                  | scanner → 去重 → V2：复制品不增加 runs/repeats；真正新条目仍增加跨会话重复                                                      |
| batchValidity                              | 同 hash 有效；他 hash 无效；manifest 缺失失败；另一 batch / lineage 不影响；未暴露旧 batch 有效                                 |
| 批次准入 e2e                               | B1/H1 展示 → H2 修订 → B1 对 H2 作废；重新打包旧 digest 拒绝；at 等于截止拒绝；新时间/新 digest 准入并有效；跨 lineage 也防复用 |
| first-seen                                 | 后写 firstSeenAt 1000 不覆盖第一条 200；git 250 收紧截止；新 hash 300 继续收紧                                                  |
| 身份 e2e                                   | 同 id/ver 改模板分成两个 stats；draft.x 纠正改写 foo（同 lineage/hash）后仍为 1 并拒绝晋升                                      |
| 草案删除 / missing                         | 同模板记录反查 port；缺结果仍计 missing，不能被草案文件删除抹掉                                                                 |
| 旧 API / pi-free                           | 旧 promotion 25 用例不改且绿；pi-free 闭包与 reflex governance 全绿                                                             |

## 5. 门禁真实输出

日志均 tee 到 `/tmp`，没有 tail/head 截断。以下为实际输出（完整日志保留于所列路径）。

### 5.1 B5 方案门禁

```sh
PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/reflex/core/promotion.test.ts tests/reflex/core/promotion-v2.test.ts tests/reflex/core/batch-validity.test.ts tests/reflex/core/shadow-dedupe.test.ts tests/reflex/core/identity-e2e.test.ts tests/reflex/core/shadow-scan.test.ts && npm run typecheck
```

日志 `/tmp/b5-gate.log`：

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ |tier1| tests/reflex/core/promotion.test.ts (25 tests) 11ms
 ✓ |tier1| tests/reflex/core/shadow-scan.test.ts (23 tests) 25ms
 ✓ |tier1| tests/reflex/core/promotion-v2.test.ts (19 tests) 11ms
 ✓ |tier1| tests/reflex/core/identity-e2e.test.ts (4 tests) 10ms
 ✓ |tier1| tests/reflex/core/shadow-dedupe.test.ts (3 tests) 6ms
 ✓ |tier1| tests/reflex/core/batch-validity.test.ts (5 tests) 5ms

 Test Files  6 passed (6)
      Tests  79 passed (79)
   Start at  18:55:54
   Duration  1.12s (transform 178ms, setup 155ms, collect 742ms, tests 67ms, environment 1ms, prepare 311ms)


> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

exit 0。

### 5.2 FX 与旧文件前缀

```sh
git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json' ':!tests/fixtures/web-hub/reload-result-compat-golden.json' && git diff --quiet cd1d6c4a -- tests/fixtures/reflex-drafts-off-parity.json; echo FX=$?
```

```text
FX=0
PROMOTION_OLD_BYTES=IDENTICAL (prefix 7482 bytes)
```

前缀核对使用 `git show cd1d6c4a:src/reflex/core/promotion.ts` 与当前文件 bytes.startswith 断言，不改工作树。FX 日志 `/tmp/b5-fx.log`。

### 5.3 pi-free / governance 补充门禁

```sh
PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/boundary/pi-free.test.ts tests/reflex/governance.test.ts
```

日志 `/tmp/b5-boundary.log`：

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ |tier1| tests/reflex/governance.test.ts (5 tests) 6ms
 ✓ |tier1| tests/boundary/pi-free.test.ts (31 tests) 608ms

 Test Files  2 passed (2)
      Tests  36 passed (36)
   Start at  18:54:35
   Duration  1.32s (transform 56ms, setup 87ms, collect 406ms, tests 614ms, environment 0ms, prepare 101ms)
```

exit 0。

### 5.4 本包格式检查

```sh
npx prettier --check src/reflex/core/promotion.ts src/reflex/core/shadow-dedupe.ts scripts/dev/reflex-shadow.mjs tests/reflex/core/promotion-v2.test.ts tests/reflex/core/batch-validity.test.ts tests/reflex/core/shadow-dedupe.test.ts tests/reflex/core/identity-e2e.test.ts docs/dev/jev-reflex/B5-report.md
```

日志 `/tmp/b5-format.log`：

```text
Checking formatting...
All matched files use Prettier code style!
```

exit 0。

### 5.5 Tier 3（真实本机 14 天）

```sh
npm run build && node scripts/dev/reflex-shadow.mjs --days 14
```

日志 `/tmp/b5-tier3.log`：

```text
> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.6 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=303d89cc8aedf582 size=4.74 MB time=301 ms inputs=704
reflex shadow · days=14 files=1470 rows=1 invalidTimestamps=0
sessions: /home/bluecake/.pi/agent/sessions
scanComplete=true
port git.status@1 runs=0 ok=0 missing=0 unavailable=1
identity git.status#24eb6185ada9992f port=git.status@1 · not-eligible · intent-evidence-insufficient;port-runs-insufficient
git.status@1 cand=1 portRuns=0 ok=0 okRate=n/a unavailable=1 judged=1 agree=1 noTool=0 diverge=0 unknown=0 divergeRate=0.0% answered=0 fallback=0 repeat=0 reasked=0 crossSessionRepeats=0 corrected=0 p50=58ms p95=58ms · not eligible · intent-evidence-insufficient；port-runs-insufficient
仅供离线判定，不自动晋升；eligible 仍需人工抽查 diverge，且仅由用户修改 reflex.autoResolve。
```

exit 0。

真实目录仅有一条 git.status 记录，unavailable=1，样本不足；报告正确拒绝晋升，不虚构证据。

### 5.6 Tier 3 隔离 CLI 行为断言（额外）

临时脚本 `/tmp/b5-cli-probe.mjs`（不进仓库）创建临时 session 根，调用真实 CLI 的 `--json`：50 个原生条目 + 50 个 fork 副本；检查旧 JSON 字段全集仍存在；随后添加缺结果、非法 JSON、真实无读权限文件。每一步断言统计值/结论，不是“不抛异常就算过”。临时目录 finally 精确清理。

```sh
node /tmp/b5-cli-probe.mjs
```

日志 `/tmp/b5-cli-probe.log`：

```text
CLI fork + additive JSON: rows=50 (100 envelopes), runs=50, crossSessionRepeats=0, eligible=true; all legacy keys retained
CLI missing result: port@0 missing=1; verdict=undetermined; eligible=false
CLI invalid JSON: scanComplete=false; no eligible identities
CLI actual file read error (EACCES): scanComplete=false; scanErrors recorded
```

exit 0。

## 6. 遗留与并行文件说明

- 最终所有指定门禁通过。首次 typecheck 曾报并行 B4 的 `src/reflex/wire.ts(719,7): TS2353 ... 'drafts' does not exist in type 'ReflexCommandDeps'`，未修改该文件；并行作者补齐后，完整 typecheck 重跑通过。没有本包编译错误。
- 其它包的 `src/reflex/{wire,command}.ts`、`src/reflex/drafts/load.ts`、`tests/reflex/core/draft-schema.test.ts`，以及 fabric/message-agent 文件的变更，不属于 B5，未触碰。`types.ts`、其它 B0 文件、`tests/tiers.ts`、`tests/fixtures/**` 全部未改。
- 同 UID 本地账本未认证的风险仍按架构保留。V2 输出只是建议，最终认证仍由用户批准 catalog PR；本包没有自动晋升或写配置行为。
- 未跑全量或 secure（按派单禁止）。未提交、未 stash、未 checkout/reset。

## 7. 改动文件（绝对路径）

```text
/home/bluecake/ai/pi-toolkit/src/reflex/core/promotion.ts
/home/bluecake/ai/pi-toolkit/scripts/dev/reflex-shadow.mjs
/home/bluecake/ai/pi-toolkit/src/reflex/core/shadow-dedupe.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/promotion-v2.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/batch-validity.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/shadow-dedupe.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/identity-e2e.test.ts
/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/B5-report.md
```
