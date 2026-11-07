# B2 · 草案生成 — 交付报告

> 包：#25 jev-reflex B2（`docs/dev/jev-reflex/backtest-plan.md` §「B2 · 草案生成」3 步）
> 架构依据：`backtest-arch.md`（BA）§4.4（+ §4.5 DRX/校验只读复用）
> 开工基线：dev `dc036048`（B0 = `cd1d6c4a` 已合入）；B1/B4/B5 同目录并行在途，未触碰其文件。
> 性质测试种子：**`0x62533242`**（mulberry32，写死在 `draft-gen.property.test.ts`；失败可逐字节复现）。

## 1. 实现范围（plan B2 三步逐条）

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 状态                                   | 落点                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `regex-safe.ts`：只经 DRX AST + `drxToSource` 产出源；`<n>` → `\d{1,4}`（每 branch ≤1、两侧非数字）；尾缀 `(?:吗                                                                                                                                                                                                                                                                                                                                                                                                    | 呢)?`；产物 round-trip `parseDrx` 必过 | ✅                                                                                                                                             | `branchSource(parts, {tail?})` / `literalSource(text, role)`；不接受即返回 `{ok:false,problem}`，绝不发射 |
| 2    | `cluster.ts`：骨架化（path→`<path>`、引号→`<q>`、数字串→`<n>`，该序）；含 `<path>`/`<q>` 骨架不进 strong；token；`portLabel`（只对有签名 port，恰交一个 ∧ `!hasWrite` ∧ `toolCount≤3`；`TOOLLESS_PORTS` 永不自动标注）；`clusterTurns`（入参只收 train，混入 ⇒ 抛）                                                                                                                                                                                                                                                 | ✅                                     | 骨架常量导出 `SKELETON_N/PATH/Q`；leader 贪心 Jaccard ≥0.6、(count desc, skeleton asc) 稳定排序；nonCandidates 计数（origin/veto/builtinHigh） |
| 3    | `draft-gen.ts`：`generateDrafts(clusters, corpusStats, assign?) → {drafts, needsPort, skips}`；有签名 port 自动；`toolCount===0` 众数 ∧ 与 TOOLLESS builtin weak 词法相交 ⇒ `needsPort`（簇 id、规模、脱敏骨架样本 ≤24cp、建议 port），`assign` 后才生成；examples.hit 代表值实例化 + `redactForJev` + 自身 matcher 复核 + 去重 + 小簇补全（`<n>` 代表值 / 纯字面量加 吗/呢 尾缀变体）；`tightenDraft`（单调）；`refineDrafts(…, replayFn, maxRounds=3)`（BD3 注入）；终检 `validateDraft`，不过 ⇒ `skips.validate` | ✅                                     | 见 §3 决策与偏差                                                                                                                               |

**导出面**：`regex-safe.ts`（2 函数 + `StrongPart`/`SafeSource`）、`cluster.ts`（`clusterTurns`/`skeletonize`/`skeletonTokens`/`portLabel` + 常量与结果类型）、`draft-gen.ts`（`generateDrafts`/`refineDrafts`/`tightenDraft`/`emptySkips` + `CorpusStats`/`ReplayFn`/`NeedsPortCandidate`/`SkipCounts`/结果类型 + `DEFAULT_MIN_GROUP`/`REPRESENTATIVE_VALUES`/`SYNTHETIC_MISSES` 等常量）。B3 只需这些；未新增任何 B0 类型（types.ts 零改动）。

## 2. 门禁输出（真实输出，tee 于 /tmp）

### 2.1 方案 B2 vitest 门禁

```
$ npx vitest run tests/reflex/core/backtest/cluster.test.ts \
    tests/reflex/core/backtest/draft-gen.test.ts \
    tests/reflex/core/backtest/draft-gen.property.test.ts \
    tests/reflex/core/backtest/draft-gen.pipeline.test.ts \
    tests/reflex/core/backtest/regex-safe.test.ts \
    tests/boundary/pi-free.test.ts

 ✓ |tier1| tests/reflex/core/backtest/regex-safe.test.ts (13 tests) 10ms
 ✓ |tier1| tests/reflex/core/backtest/cluster.test.ts (20 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.pipeline.test.ts (6 tests) 19ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.test.ts (22 tests) 63ms
 ✓ |tier1| tests/boundary/pi-free.test.ts (31 tests) 700ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.property.test.ts (5 tests) 2803ms
 Test Files  6 passed (6)
 Tests      97 passed (97)
 Duration   3.61s
```

pi-free 31 例含 `core/backtest/**` 值闭包（本包 3 个源文件 + `memory/jev/redact.js` 引入自动受检）。

**注意**：`npx vitest run tests/reflex/core/backtest`（整目录）会连带 B1 在途测试（`corpus/replay/evidence/...`），本轮快照下 18 red / 130 green——全部位于 B1 文件域（其开发进行中），与本包无关；本包门禁按方案用显式文件清单。

### 2.2 `npm run typecheck`

```
$ npm run typecheck            # tsc(tsconfig.json) && tsc(tsconfig.typecheck.json) && vue-tsc
→ 本包文件 0 错误；全局 typecheck 当时被在途 #34 的 src/fabric/wake.ts 阻断
```

过程说明：19:08 快照时 `tsc -p tsconfig.build.json` 曾报 `backtest/evidence.ts(73)` / `backtest/replay.ts(122,127)` 3 条 —— 全部在 **B1 在途文件**（当时正被 B1 并行写入），随后自行修复；验收时点的全局 typecheck 则被在途 #34 的 `src/fabric/wake.ts` 阻断。两个阻断源都在其他包的文件域，本包 3 个源文件从未出现在任何 error 里。

### 2.3 FX 门禁（X4，派单命令逐字）

```
$ git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json' \
    ':!tests/fixtures/web-hub/reload-result-compat-golden.json' \
  && git diff --quiet cd1d6c4a -- tests/fixtures/reflex-drafts-off-parity.json; echo FX=$?
FX=0
```

### 2.4 prettier（本包 8 文件）

```
$ npx prettier --check src/reflex/core/backtest/{cluster,draft-gen,regex-safe}.ts \
    tests/reflex/core/backtest/{cluster,draft-gen,draft-gen.property,draft-gen.pipeline,regex-safe}.test.ts
All matched files use Prettier code style!   (rc=0)
```

（`src/reflex/core/backtest/*.ts` 通配会扫到 B1 在途文件并因其中途状态报 parse error，故按精确文件清单执行。）

## 3. 设计决策与偏差（BA 未定死处的落法）

| #   | 决策                                                                                                                                                                                       | 理由 / 影响                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **CJK token = 单字 + 相邻 bigram**（ascii 词整词、占位符单 token），Jaccard 阈值 0.6 不变                                                                                                  | 纯 bigram 会把「quota 今天用得怎么样 / quota 这周用得怎么样」这类换前缀的同义句拆开（0.556）。加单字后：bare↔前缀句 0.714、同核心不同尾缀 0.714、前缀↔前缀仍只有 0.556——**换前缀的成对句依然不聚**，leader 聚类按"对 leader 的相似度"收敛：pipeline 的 quota 家族成 4 句一簇（bare/吗/呢 句都挂上「今天」leader），「最近」句成单例。跨主题误聚（quota vs subagent 同尾句 ≈0.7–0.8）由 port 纯度 / needsPort / refine / 人审兜底  |
| D2  | **每个 strong 模板 = 1 个 branch、1 个 source**（≤12 sources，非 12×12 交替）                                                                                                              | tighten 时删整项即可、无需重组交替；两个 cap（≤12 条 / 每源 ≤160）同时天然满足（单句 ≤120cp）                                                                                                                                                                                                                                                                                                                                     |
| D3  | **`PORT_PURITY = 0.6`**：模态 port 标签占比 ≥0.6 ⇒ 自动 port；有 ≥2 个 port 有标签但不达纯度 ⇒ `low-purity`；零标签 ⇒ `unmapped`（除非命中 needsPort 条件）                                | BA 只给了"签名恰交一个 ⇒ 该 port"，簇级聚合口径由本包定。`low-purity` 同时收编 refine 死亡（见 D7）                                                                                                                                                                                                                                                                                                                               |
| D4  | **refine 死亡的 skip 归因**：`empty-strong` ⇒ `low-purity`（簇的整个 pattern 都吃到误命 ⇒ 意图不纯）；`exclude-cap` ⇒ `exclude-cap`（有 ≤40cp 误命句想手术排除但 32 格已满、又无分支可弃） | 7 个 SkipReason 的测试覆盖：`small`/`unmapped`/`low-purity`/`examples`/`regex` 有生成器侧直接用例（`regex` 含全 `<path>` 簇与混合簇两态）；`exclude-cap` 由 `tightenDraft` 单元用例钉住；`validate` 经 `refineDrafts` 公共入口（喂入损坏草案，终检 belt 拒收）钉住——生成路径自身的 `validate` 计数是同一条 belt 的防御位，当前公共 API 输入下不会自然触发（生成器先经 `buildExamples`/miss 池自筛，终检理论上恒过），不虚构伪测试 |
| D5  | **negatives 内部规范排序**（codepoint asc，`excludeSources` 与 miss 池都先 `[...new Set()].sort()`）                                                                                       | 使输出对调用方传入顺序不变（乱序同输出的强化；B3 传任何顺序都得到同一份草案/排除表）                                                                                                                                                                                                                                                                                                                                              |
| D6  | **refine 时不做 examples 补全**，只重过滤（<5 ⇒ `skip:"examples"`）                                                                                                                        | 生成期已把 12 个代表值 / 尾缀变体用满；refine 只会缩。生成期补全全按 plan（`<n>` 代表值 `[2,3,10,5,20,8,99,123,1000,7,42,16]`，纯字面量小簇升级 branch 为带 `(?:吗                                                                                                                                                                                                                                                                | 呢)?`尾缀并补 吗/呢 例句，仍不足 5 ⇒`skip:"examples"`——两条路径都有测试） |
| D7  | **misfire 判据**：band high ∧ (`hasWrite` ∨ `judgeAgreement(draft, shapes)==="diverge"`)                                                                                                   | 与 B1 SuspectCode 的 `write-turn`/`diverge` 对齐；ambiguous 永不作答故不收紧（有测试）。`maxRounds` 耗尽仍被举报 ⇒ 丢稿记 `low-purity`（单调性保证正常路径 1 轮收敛，rounds 通常 =1）                                                                                                                                                                                                                                             |
| D8  | **参考 replay 适配器**（builtin 先、**miss 才跑草案层**、high-only 上报）只存在于测试文件                                                                                                  | BD3：B2 不 import B1；B3 将用 B1 的真 replay 注入同一 `ReplayFn` 签名                                                                                                                                                                                                                                                                                                                                                             |
| D9  | **测试句避开 builtin weak 词**（jobs 用「后台第 3 个**任务**呢」而非 plan 例句「…个 job 呢」；fleet 用「…个**代理**在跑吗」；git 用「有 3 个**新文件**吗」）                               | 两层语义下 builtin weak（job/agent/未提交…）命中的句子恒 ambiguous、草案层不可达——含 weak 词的草案运行时永远不触发。生成/校验机制测试用非遮蔽句更真实；plan 例句的机制（数字模板、hit 无字面 `<n>`）全部保留                                                                                                                                                                                                                      |
| D10 | `SYNTHETIC_MISSES` 固定 5 句（各被 S0 硬否决：帮我/前缀 `/`/短回复/多行/跑一下）                                                                                                           | 任何草案的 miss 池恒 ≥5 且永不误 high；miss 池 = negatives 中对本草案非 high 者 + 合成句，≤20                                                                                                                                                                                                                                                                                                                                     |
| D11 | **骨架占位符防伪**：norm 里用户手打的 `<n>`/`<path>`/`<q>` 先被替换为全角 `〈n〉` 再骨架化                                                                                                 | 防止字面占位符伪装成真占位符破坏模板（有测试）                                                                                                                                                                                                                                                                                                                                                                                    |
| D12 | weak n-gram 候选 = 簇内 norm 的 token（单字/bigram/ascii 词），门槛 覆盖 ≥0.6 ∧ 全语料出现率 ≤0.02 ∧ `literalSource` 可表达；排序 coverage↓, rate↑, 长度↓, 字典序；取 ≤3                   | 小语料（无填充）下 rate 恒超 2% ⇒ weak=[]（合法，schema 允许；有测试钉住两态）。语料 token 索引每次 generate 建一次，线性                                                                                                                                                                                                                                                                                                         |

## 4. 性质测试（SEED `0x62533242`）

世界：1,050 个随机簇 → 3,715 turns（40 会话、5% write、15% 跨 port 工具形状）+ 40 negatives（30% 超 40cp）+ 200 filler；`clusterTurns` 合并后 **183 个 TurnCluster**（290 句被 lenient S0 否决——前缀池里「帮我看看」类被祈使否决，属真实混合）。

| 断言                                                                                                                                              | 结果                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 100% 生成稿（自动 108 + assign 后 143 中的新增）过 `validateDraft`（deep-equal 返回原对象）∧ 逐源 `parseDrx` ∧ 键白名单 ∧ 无 `argv`、无字面 `<n>` | ✅                                                                                                           |
| refine（抽样 100 份 × 全量 turns × 参考适配器）：97 幸存全部过同套不变式；3 份死亡 = 2×`exclude-cap` + 1×`examples`，skips 与 幸存+死亡 严格对账  | ✅                                                                                                           |
| tightenDraft 单调（300 随机案例：tightened.high ⇒ original.high，探针含 badNorms/例句/负样本）                                                    | ✅                                                                                                           |
| 乱序确定性（turns 全量反转 + negatives 反转 ⇒ 两次 generate 输出 deep-equal）                                                                     | ✅                                                                                                           |
| 运行时长                                                                                                                                          | 单文件 2.8s（<10s testTimeout；纯进程内，无 proc/socket/sleep 标记，tier1 词法门禁无需登记——人工复核过 D4a） |

refine 实测：rounds=1 收敛、120 个 misfire 全部被 exclude-first/branch-drop 消化——与 D7 的单调性论证一致。

## 5. 冻结面核对

| 冻结面                                                                         | 状态                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1（`src/index.ts`、fabric/web-hub/…、`catalog.ts`、`tests/fixtures/**` 既有） | ✅ 未触碰（`catalog.ts` 只读 import）                                                                                                                                                                       |
| X2（含 B0 五文件 + `types.ts`）                                                | ✅ 只读 import（`draft-schema` 的 `DRAFT_CAPS`/`validateDraft`、`draft-regex` 的 `drxToSource`/`parseDrx`、`port-defaults`、`gate`/`match`/`normalize`/`agreement`/`catalog`）；`types.ts` 零改动、零新类型 |
| B1/B4/B5 文件域                                                                | ✅ 未创建未修改（同目录 B1 文件属其并行工作，见 §2.1/§2.2 说明）                                                                                                                                            |
| `tests/tiers.ts`                                                               | ✅ 未触碰（本包测试无 D4 词法标记）                                                                                                                                                                         |
| git 写操作                                                                     | 无（无 add/commit/stash；全部新文件 untracked）                                                                                                                                                             |

## 6. 遗留 / 给 root 的事项

1. **无阻塞性缺类型**——B0 契约完备，本包未需要任何新类型。
2. **D1 的聚类粒度事实**（换前缀句不成对相聚，leader 决定簇形）已随本报告发给 root（kind=finding）；若真实语料上 quota 类簇太碎，调 token 化或阈值是 B3′/后续微调，不动 B2 冻结面也可在 B3 侧换适配（`ClusterOptions.jaccard` 已可注入）。
3. **B1 并行噪声**：整目录 vitest / 通配 prettier 会踩到 B1 在途文件；验收与后续跑 CI 请用文件清单（§2.1 命令）。B1 合入后整目录自然收敛。
4. refine 的 `maxRounds` 在单调收紧下通常 1 轮即净；保留 3 轮上限是对"replay 实现不满足"的兜底（测试用 stub 钉住 3 轮耗尽 ⇒ low-purity）。

## 6b. 修订记录（验收修复轮，2026-11-05 19:40）

1. **minor · 手拼正则**：`tightenDraft` 的 branch 匹配不再 `new RegExp(\`^(?:${src})$\`)`——改为每个 branch 经**唯一运行时编译入口 `compileCatalog`** 编译单源 matcher（与运行时匹配同一锚定语义）；`rg -n "new RegExp\(" src/reflex/core/backtest/{cluster,draft-gen,regex-safe}.ts` 无输出。
2. **minor · 报告/测试对齐**：补 3 条生成器侧用例（全 `<path>` 簇 ⇒ `skip regex`；混合簇 `<path>` 骨架计入 size 但不进 strong；损坏草案经 `refineDrafts` 终检 belt ⇒ `skip validate`）；D4 行改为如实的覆盖表述；§2.2 typecheck 结论改为「本包 0 错误；全局当时被在途 #34 的 `src/fabric/wake.ts` 阻断」。

修复轮自验：6 文件 vitest **100 例全绿**（97→100）；rg 无输出；prettier（8 文件 + 本报告）全过；`npm run typecheck` 本轮快照 rc=0（#34 已推进，与「本包 0 错误」一致）。

## 7. 文件清单（绝对路径，全部新建）

```
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/regex-safe.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/cluster.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/draft-gen.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/regex-safe.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/cluster.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/draft-gen.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/draft-gen.property.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/draft-gen.pipeline.test.ts
/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/B2-report.md
```
