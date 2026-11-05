# B3 · 编排、账本与回测脚本 — 交付报告

> #25 B3；dev，开工及交付 HEAD `34e19878`。B0 `cd1d6c4a`、B1 `cc8b39b6`、B2 `34e19878`、B4 `852332ec`、B5 `23391eda` 只读调用。
> 依据：`backtest-plan.md` B3 四步骤、`backtest-arch.md` §4.2/4.7/4.8、五份上游报告、reflex/secure README、AGENTS I8/I11。
> **状态：指定门禁全绿；只新建获准的 10 个文件；无 git 写操作，无全量/secure 测试。**

## 1. 四步骤实现

| 步骤 | 实现                                                                                                                                                                                                                                                                   | 文件                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1    | I/O 注入的两遍扫描（全 cwd headers → header timestamp 升序、同刻按文件名稳定排序）；消费 `takeRevoked`；晚发现的 child 引用再过滤；读/解析/并发文件变化失败 ⇒ `scanComplete:false`；cold/warm；B1 replay、B2 generate/refine、freeze、review/show 数据准备、B5 promote | `orchestrate.ts`                                      |
| 2    | 带完结校验的 JSONL 私有缓存，Turn + 全量 CorrectionFact + header/file metadata + live envelopes；全局失效键；manifest/batch/review/exposure/revision 编解码；先登记 first-seen revision，immutable manifest/batch、append journals                                     | `cache-format.ts`、`ledger-format.ts`、脚本存储适配器 |
| 3    | 明确投影的导出 DTO（不 stringify Turn/cache），聚合/过滤计数、digest、≤24cp 脱敏首行、身份元组、unknownFacts、unresolved/skip、冷/热标注；本机 show 只给脱敏问句与工具形状，无 argv                                                                                    | `report.ts`                                           |
| 4    | `scan`、`generate --assign/--emit`、`batch freeze --lineage`、`review <port>`、`show <digest>`、`--promote <id> --batch`；secure env 在任何 I/O 前 exit 3、缺 dist exit 2、show/export 拒绝；0700/0600；tmp + rename，immutable 先 wx 独占占位；无网络/设置写入        | `reflex-backtest.mjs`                                 |

### 上游调用约定逐项

1. **B1 升序喂入**：第一遍读所有 header，第二遍按 `timestamp ASC / file ASC` 喂 builder；每文件结束消费 `takeRevoked()`；warm 复用解析产物不再喂 builder。
2. **B5 不传作废证据**：`batchValidity` 无效、manifest 与本次扫描不一致、当前窗口缺少批次轮次 ⇒ 回归批次，不传 `backtest`；实时分支仍经过唯一 V2 evaluator。有效当前批次若 review 不全或有 misfire，仍传入并被 B5 拒绝，即使 live 足够。
3. **B5 唯一实时入口**：`buildLiveEvidence(scan.liveRows, builtin, drafts)`；当前 portVer 没有 bucket 时读取 `port@0.missing`，构造零 runs/ok 的目标版本 bucket，旧成功不补新版。没有改 `reflex-shadow.mjs`。
4. **B4 权限**：reflex/drafts/cache/drafts-out/reports/manifests/batches/reviews 一律 0700；所有新文件 0600。既有目录/文件若 symlink、foreign uid、group/other 有权限就拒绝，不自动放宽/修复。

### 公开入口（本包局部类型，不改 types.ts）

- `scanCorpus(deps, filter, noCache?)`：deps = listFiles、readLines（支持 headerOnly）、cache、ledger、clock。
- `replayScan`、`generate`、`freezeBatch`、`promote`、`registerRevisions`、`applyReviews`、`prepareDetails`。
- `cacheVersions`、`invalidationKey`、`encodeCache/decodeCache`、`createManifest/createBatch`、`encodeLedger/decodeLedger`。
- `buildReport/renderReport`、`renderShow`、`safeText`。

`scanCorpus` 缓存的是不受 days/cwd 限制的、已去重/排除 child/web/injected、单行≤120cp Turn；CorrectionFact 不做短句过滤。读取时再做时间/cwd 选择，因此连续运行的 now 变化不会令缓存失效。实时 rows 保留 entryId/session/at，供 B5 自行去重。扫描结束重取 stamps，发现并发 append/replace 不写 warm cache。

`scannedBytes` = 本 manifest 文件的逻辑总字节数，cold/warm 相同；`bodyReadBytes` = cold 的正文扫描量、warm 为 0（不含第一遍 header 读量）。`rawUsers` 是去重前所有 user 条目数；`parsedTurns` 是 builder 去重/来源/child 排除后轮次；`singleShort` 是单行≤120cp 后数量；`windowCwd` 是窗口/cwd 选择后数量。`childFiles` 只数此次输入集合内的 child，`childReferences` 另数 builder 所有引用（包括缺失的历史路径）。

## 2. 向 root 提问与默认做法（均用 finding 发出）

| 问题                                                          | 默认落法                                                                                                                | 状态/偏差                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 单文件重解析无法重建跨文件 claims/sourceMode/child provenance | 任一 size/mtime/dev/ino、增删/父链变化 ⇒ **全量重解析 + 家族索引重建**；warm 完整复用                                   | 已发 root；未收到反对。比 BA 文件级重解析更保守，cold 性能仍达手动目标。                             |
| normalize.ts 无 normalizeVersion 导出，冻结面禁止补           | 本包以 `sha256(normalizeInput.toString())` 作为 normalizeVersion；MARKERS_VERSION、CORRECTION_RE.source hash 各自独立   | 已发 root；不改上游。未来仅修改 normalizer 的外部常量而不改函数体时，须手动升本包 cacheV（见遗留）。 |
| 不可变 manifest 变化后不能把本次新语料冒充旧批次              | 当前 manifestHash 不同或批次 turnKeys 不全 ⇒ 过期回归，不传 backtest；走实时分支                                        | 已发 root，遵守 B5 作废证据调用约定；保守地放弃不完整批次。                                          |
| 无 batchId 的留出失败无法登记暴露                             | report 仅展示已冻结批次的留出失败；show 对未批次化留出失败拒绝，review 仅准备已批次化失败                               | 已发 root；防展示后重新打包规避暴露。聚合、train/unscored 本机 show 不受影响。                       |
| first-seen 初次初始化意味着旧历史不能作新批次                 | revision 用真实 now，freeze 先自动选 `at > lastRevisedAt` 且 digest 未暴露的 holdout，再调 `admitBatch`；无候选不写批次 | 随上条已发 root；这是准入设计的保守结果，不伪造过去 firstSeen。                                      |

记录均未认证；0700/0600、hash、interactive review 不证明人看过。认证仍只在用户批准 catalog PR/明确确认。报告/脚本不自动改 catalog、autoResolve 或 settings。

## 3. Tier 1 行为测试

新增 **4 文件 / 48 用例**（验收修复后：orchestrate 24、cache 11、ledger 8、report 5），全部 Tier 1 默认归属，无 proc/socket/长 sleep/mount 词法，不改 `tests/tiers.ts`。

- 扫描失败/invalid JSON，即使实时证据 50 条成功也不能 eligible；并发 file stamp 复核失败不缓存。
- fork cold/warm Turn、CorrectionFact、ReplayRow、promote 逐项相等；实际 body 喂入顺序断言祖先先于 fork；warm 不重读。
- 四个 file stamp 字段逐个改变 ⇒ 重建；normalize/markers/correction/cacheV 键分别变化 ⇒ 失效。补充端到端：先写入校验完整、旧 markersVersion/correctionHash 的缓存，再调用 scanCorpus，断言 header/body 重读、cold 结果逐项一致及下一次 warm 不再读取；父链改变 ⇒ unscored/家族重建；no-cache 与冷产物相等；live envelope 与共享 evidence 相等。
- 当前有效 batch 中新 suspect 未评审 ⇒ review-incomplete，即使 live 足够；misfire 也拒。manifestHash 不一致、batch 暴露后作废、turnKeys 不全三种情形分别深等断言**整个结论对象**与直接 B5 live-only 判定一致；同一批次恢复有效后，结论不同并带 batchId/manifestHash，证明回测证据不是始终被忽略。
- 相同 live rows 的 orchestrate promote 与 `evaluateMergedPromotion(buildLiveEvidence(...))` 完全一致；另读源码断言 shadow CLI 调同一入口；新版 port + 旧成功 + @0 missing ⇒ undetermined。
- revision 先写、first-seen 不覆盖；新 hash 新记录；freeze 选新 holdout + admit；拒绝时无 batch 写；manifest/batch 覆盖 EEXIST。
- 留出 suspect detail 产生 exposure、聚合与 train 不产生；已评审 misfire 即使本次 replay agree 也会被标 `reviewed-misfire` 并暴露。
- 晚发现 child 引用移除已收割 child Turns/Corrections；长多行纠正仍保留。
- generate 只喂 train + 真 B1 replay/B2 refinement，holdout 不进入草案。
- report 1,000 次 seeded 性质循环：JSON/Markdown 均无 `/`、`~/`、`.jsonl`、argv 或密码值，head≤24cp。

首次定向测试 1 red 是测试预期误写为 `port-results-missing`，上游真实 reason 是 `port-missing`；修正预期后重跑全绿。没有绕过断言或改上游。

## 4. 门禁真实输出

所有长命令 `timeout`，输出 tee `/tmp`，未用 tail/head 截断。以下追加的是实际日志。指定 gates 最终全部 exit 0；typecheck/build 没有在途 #34 错误，因此无需域内错误例外。FX 命令使用派单给的五项 exclusions；其余冻结 fixture 对 origin/dev，drafts parity 对 B0。

## 5. Tier 3 手动清单 ①–⑥

### ① 应用缓存冷/热性能

临时 agentDir `/tmp/reflex-b3-perf-Sbcsdf`。先将真实 sessions **复制快照**到该目录（1.6G，1480 文件），避免活跃会话在冷扫描中 append 导致缓存无效；没有写用户真实 reflex 目录。保留原 header/entry，移动后的 parentSession 用 B1 文件名 id fallback；绝对 child 引用可能指向原路径，此处数据是快照而非真实路径恒等扫描，性能/计数按该快照如实记录，不声称严格代表实时 corpus。

执行：

```sh
rm -r /tmp/reflex-b3-perf-Sbcsdf/reflex/cache
uptime
/usr/bin/time -v timeout 180 env PI_CODING_AGENT_DIR=/tmp/reflex-b3-perf-Sbcsdf node scripts/dev/reflex-backtest.mjs --days 30
# 随后三次同命令（timeout 30）
```

| 模式         | wall       | peak RSS KB | exit |
| ------------ | ---------- | ----------- | ---- |
| 应用缓存冷   | 33.59 s    | 328492      | 0    |
| 应用缓存热 1 | 0.39 s     | 88992       | 0    |
| 应用缓存热 2 | 0.35 s     | 89100       | 0    |
| 应用缓存热 3 | 0.38 s     | 90308       | 0    |
| 热中位数     | **0.38 s** | —           | —    |

手动目标 ≤90s / ≤3s 本机达到；不是运行时保证，也不控制 OS page cache。manifestHash = `e5f9d3cfb147e43360d513cdaf21269e4c35cd8f381358956c46ad191a9c954f`；逻辑扫描字节 = **1679523594**。过滤：rawUsers 4853 → parsedTurns 1038 → singleShort/windowCwd 846；train 502 / holdout 334 / unscored 10；confirmed 564 / lenient 282；unknown sourceMode 51 / idle 238 / pendingMessages 238；unresolved missing-parent 6；classes veto 281 / miss 521 / ambiguous 42 / high 2。实时不足，四个 builtin 无 eligible。

完整日志 `/tmp/b3-cold.log`、`/tmp/b3-hot-{1,2,3}.log`；冷日志与 uptime 追加在下文，热三次 stdout 计数/manifest 全同冷，差异只有 cache 标注/bodyReadBytes=0，time 指标见表。

### ② secure、③ show/export、④ 可导出隐私、⑤ 权限

实际执行并记录 `/tmp/b3-manual-gates.log`：secure exit3；show --report/--json exit1；复制脚本到 dist 不存在的临时位置 exit2（未改/移走仓库 dist）；`grep -E '(/home|~/|\.jsonl)'` 对**含真实 suspect detail 的烟测报告**为空，grep exit1；stat 核全部目录700、缓存/账本/评审/草案/报告600。

### ⑥ generate → B4 loader → `/reflex drafts`

`timeout 60 node /tmp/b3-cli-smoke.mjs`，最终临时 agentDir `/tmp/reflex-b3-smoke-gAiKf1`；脚本产物/日志 `/tmp/b3-cli-smoke.log`。

- 创建真实形状 train JSONL，运行实际 `generate --emit --json`，生成 1 份 `draft.6fe13282ad`，skips 全0。
- **真实 B4 `loadDrafts` + 真实 `createReflexCommand(...).handler('drafts', ctx)`**：loaded1 / rejected0；所有生成产物 loaded。
- ctx 仅 mock ui.notify/sessionManager；**没有真实 TUI + 模型**，不把此项声称为 live wire/model 验收。B4 shadow-only 仍由上游已合入测试保证。
- 补实际 CLI 全链：初始化 first-seen 后创建新 holdout → batch freeze1条 → show write-turn → exposure journal1条 → stdin `misfire` 写 unverified review → --report 的 suspect detail 与隐私断言 → 700/600断言。

## 6. 冻结面与遗留

1. 只新建下面10个获准文件；`git diff --name-only -- src/reflex scripts/dev/reflex-shadow.mjs tests/reflex` 空（本包文件均 untracked）。没有修改上游 types/catalog/promotion/loader/wire/shadow CLI；#34/#30 文件未触碰。未 add/commit/stash/reset/checkout/push。
2. §2 默认做法已 finding 发 root，交付时无进一步裁定；whole-cache rebuild、过期批次只走 live、未批次化失败不展示是本包保守细化。
3. cacheV=2 是解析格式/语义版本。未来改 corpus/backtest 语义、或仅改 normalizeInput 的外部常量时须升 cacheV；normalizer 函数体 hash 不能捕捉其所有外部依赖。此细节应在可选 B3′ 同步 README（本包 README 冻结）。
4. wx占位后 tmp rename 遭进程崩溃可能留下空的 immutable 文件，后续 decode 拒绝并 fail-closed；由人检查/恢复，不自动覆盖。journal 截断/坏数据同样拒绝，不静默忽略以求 eligible。账本同 UID 可伪造的威胁模型保持。
5. 性能使用会话快照/OS页缓存未控制；⑥无真TUI/模型。没有其他门禁失败。临时 raw session 快照/烟测目录将在交付前精确清理，完整非原文日志仍在 `/tmp/b3-*.log`。

## 7. 改动文件（绝对路径，全部新建）

```text
/home/bluecake/ai/pi-toolkit/scripts/dev/reflex-backtest.mjs
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/orchestrate.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/cache-format.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/ledger-format.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/report.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/orchestrate.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/cache-format.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/ledger-format.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/report.test.ts
/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/B3-report.md
```

## 附：真实日志

### 定向 vitest · npx vitest run tests/reflex/core/backtest

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ |tier1| tests/reflex/core/backtest/cluster.test.ts (20 tests) 20ms
 ✓ |tier1| tests/reflex/core/backtest/replay.test.ts (18 tests) 24ms
 ✓ |tier1| tests/reflex/core/backtest/evidence.test.ts (9 tests) 30ms
 ✓ |tier1| tests/reflex/core/backtest/corpus.test.ts (27 tests) 24ms
 ✓ |tier1| tests/reflex/core/backtest/family.test.ts (9 tests) 11ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.test.ts (25 tests) 68ms
 ✓ |tier1| tests/reflex/core/backtest/regex-safe.test.ts (13 tests) 9ms
 ✓ |tier1| tests/reflex/core/backtest/orchestrate.test.ts (20 tests) 122ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.pipeline.test.ts (6 tests) 21ms
 ✓ |tier1| tests/reflex/core/backtest/corrections.test.ts (8 tests) 14ms
 ✓ |tier1| tests/reflex/core/backtest/report.test.ts (5 tests) 217ms
 ✓ |tier1| tests/reflex/core/backtest/markers.test.ts (7 tests) 489ms
 ✓ |tier1| tests/reflex/core/backtest/ledger-format.test.ts (8 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/cache-format.test.ts (11 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.property.test.ts (5 tests) 2772ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > 100% of generated drafts (auto + assigned) pass validateDraft & DRX & key whitelist 744ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > refine survivors are still 100% valid 1226ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > determinism: a second identical run is byte-identical 443ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > tightenDraft is monotone on 300 random cases 356ms
 ✓ |tier1| tests/reflex/core/backtest/split.test.ts (4 tests) 49ms

 Test Files  16 passed (16)
      Tests  195 passed (195)
   Start at  20:01:18
   Duration  3.81s (transform 855ms, setup 501ms, collect 3.20s, tests 3.90s, environment 3ms, prepare 889ms)
```

### npm run typecheck · exit 0

```text

> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### npm run build · exit 0

```text

> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.6 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=3baa3f7ebde4b7f9 size=4.75 MB time=228 ms inputs=705
```

### 补充 pi-free / tier governance · exit 0

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ |tier1| tests/governance/test-tiers.test.ts (11 tests) 280ms
 ✓ |tier1| tests/boundary/pi-free.test.ts (31 tests) 826ms

 Test Files  2 passed (2)
      Tests  42 passed (42)
   Start at  19:57:52
   Duration  1.71s (transform 111ms, setup 119ms, collect 524ms, tests 1.11s, environment 0ms, prepare 124ms)
```

### FX / 精确文件域

```text
FX=0
?? scripts/dev/reflex-backtest.mjs
?? src/reflex/core/backtest/cache-format.ts
?? src/reflex/core/backtest/ledger-format.ts
?? src/reflex/core/backtest/orchestrate.ts
?? src/reflex/core/backtest/report.ts
?? tests/reflex/core/backtest/cache-format.test.ts
?? tests/reflex/core/backtest/ledger-format.test.ts
?? tests/reflex/core/backtest/orchestrate.test.ts
?? tests/reflex/core/backtest/report.test.ts
```

### uptime

```text
 19:58:39 up 26 days,  5:48,  3 users,  load average: 11.10, 7.60, 4.84
```

### 应用缓存冷 · /usr/bin/time -v · exit 0

````text
# reflex backtest · unverified

manifestHash: e5f9d3cfb147e43360d513cdaf21269e4c35cd8f381358956c46ad191a9c954f
scannedBytes: 1679523594
应用缓存冷 (OS page cache uncontrolled)
scanComplete: true

```json
{
  "title": "reflex backtest",
  "unverified": true,
  "manifestHash": "e5f9d3cfb147e43360d513cdaf21269e4c35cd8f381358956c46ad191a9c954f",
  "scanComplete": true,
  "scanErrors": 0,
  "scannedBytes": 1679523594,
  "bodyReadBytes": 1679523594,
  "cache": "应用缓存冷 (OS page cache uncontrolled)",
  "filters": {
    "files": 1480,
    "headers": 1480,
    "rawUsers": 4853,
    "parsedTurns": 1038,
    "singleShort": 846,
    "childFiles": 1384,
    "childReferences": 2951,
    "windowCwd": 846,
    "train": 502,
    "holdout": 334,
    "unscored": 10
  },
  "unresolved": {
    "missing-parent": 6
  },
  "classes": {
    "veto": 281,
    "miss": 521,
    "ambiguous": 42,
    "high": 2
  },
  "confirmed": 564,
  "lenient": 282,
  "unknownFacts": {
    "sourceMode": 51,
    "idle": 238,
    "pendingMessages": 238
  },
  "skips": {},
  "needsPort": [],
  "identities": [
    {
      "identity": {
        "lineage": "jobs.list",
        "templateHash": "7de89225a00289ba",
        "port": "jobs.list@1"
      },
      "verdict": "undetermined",
      "reasons": [
        "intent-evidence-insufficient",
        "port-runs-insufficient",
        "cross-session-undetermined"
      ]
    },
    {
      "identity": {
        "lineage": "fleet.status",
        "templateHash": "8a7cfc444521f269",
        "port": "fleet.status@1"
      },
      "verdict": "undetermined",
      "reasons": [
        "intent-evidence-insufficient",
        "port-runs-insufficient",
        "cross-session-undetermined"
      ]
    },
    {
      "identity": {
        "lineage": "quota.summary",
        "templateHash": "f5dbed62936836a7",
        "port": "quota.summary@1"
      },
      "verdict": "undetermined",
      "reasons": [
        "intent-evidence-insufficient",
        "port-runs-insufficient",
        "cross-session-undetermined"
      ]
    },
    {
      "identity": {
        "lineage": "git.status",
        "templateHash": "24eb6185ada9992f",
        "port": "git.status@1"
      },
      "verdict": "not-eligible",
      "reasons": [
        "intent-evidence-insufficient",
        "port-runs-insufficient"
      ]
    }
  ],
  "suspects": [],
  "note": "未认证统计建议；人工认证仅在用户批准 catalog PR。草案恒 shadow，不自动晋升。"
}
```

	Command being timed: "timeout 180 env PI_CODING_AGENT_DIR=/tmp/reflex-b3-perf-Sbcsdf node scripts/dev/reflex-backtest.mjs --days 30"
	User time (seconds): 29.47
	System time (seconds): 3.81
	Percent of CPU this job got: 99%
	Elapsed (wall clock) time (h:mm:ss or m:ss): 0:33.59
	Average shared text size (kbytes): 0
	Average unshared data size (kbytes): 0
	Average stack size (kbytes): 0
	Average total size (kbytes): 0
	Maximum resident set size (kbytes): 328492
	Average resident set size (kbytes): 0
	Major (requiring I/O) page faults: 0
	Minor (reclaiming a frame) page faults: 1181907
	Voluntary context switches: 99091
	Involuntary context switches: 11956
	Swaps: 0
	File system inputs: 1313352
	File system outputs: 2984
	Socket messages sent: 0
	Socket messages received: 0
	Signals delivered: 0
	Page size (bytes): 4096
	Exit status: 0
````

### ②–⑤ 手动门禁

```text
reflex backtest disabled in secure environment
SECURE=3
reflex backtest failed: show is local only; --report and --json are forbidden
SHOW_REPORT=1
reflex backtest failed: show is local only; --report and --json are forbidden
SHOW_JSON=1
缺少 dist：先 npm run build
MISSING_DIST=2
PRIVACY_GREP=1
700 /tmp/reflex-b3-smoke-gAiKf1/reflex
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/cache
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/drafts
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/drafts-out
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/reports
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/manifests
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/batches
700 /tmp/reflex-b3-smoke-gAiKf1/reflex/reviews
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/drafts/draft.6fe13282ad.json
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/cache/corpus-v2.jsonl
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/manifests/1d149293a62f2814b53ff4a7140a078772140dd4dfded683ab40da94ddfe0ae4.json
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/batches/8afc5ee4a171e85e2de50f13db4083c9e79673369776077119745a08776b2b9b.json
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/reviews/jobs.list.json
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/reports/2026-11-05T11-59-15-931Z.md
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/exposure.jsonl
600 /tmp/reflex-b3-smoke-gAiKf1/reflex/revisions.jsonl
```

### ⑥ 实际 generate / B4 command / batch / review / export 链路

```text
generate --emit: generated files=1; skips={"small":0,"low-purity":0,"unmapped":0,"examples":0,"regex":0,"exclude-cap":0,"validate":0}
reflex drafts: enabled · loaded 1 · rejected 0 · dir=/tmp/reflex-b3-smoke-gAiKf1/reflex/drafts
  loaded draft.6fe13282ad@1#66482eec port=jobs.list
草案恒 shadow；改动草案文件后需 /reload 才会重新加载。
⑥ real B4 loader + /reflex drafts command handler: all generated products loaded; fake ctx only, no TUI/model
batch=8afc5ee4a171e85e2de50f13db4083c9e79673369776077119745a08776b2b9b manifestHash=1d149293a62f2814b53ff4a7140a078772140dd4dfded683ab40da94ddfe0ae4 turns=1
digest=6192195e5308e5b8 origin=tui split=holdout
unknownFacts=none
Q: 后台还有几个 job
tools: write
6192195e5308e5b8 后台还有几个 job write-turn · unverified
ok / misfire / skip:
④ report with ACTUAL suspect detail: no /home, ~/, .jsonl or argv; exposure journal appended before display
⑤ all generated and ledger/report directory modes 700 and file modes 600 asserted
SMOKE_ROOT=/tmp/reflex-b3-smoke-gAiKf1
```

### 本包十文件 prettier check · exit 0

```text
Checking formatting...
All matched files use Prettier code style!
```

## 8. Sonnet 有条件验收修复（2026-11-05 20:12）

仅改本包 orchestrate.test.ts、reflex-backtest.mjs、本报告，无 git 写操作。

1. **minor**：原来的 eligible-only 用例改为三条参数化用例（manifest-mismatch / batch-invalid / turnKeys-incomplete）。每条用同一组 liveRows 调权威 `buildLiveEvidence + evaluateMergedPromotion`（不传 backtest），再用 `toEqual` 深比较 promote 的完整结论对象。每条附有效批次反例：恢复原 scan / 去掉 exposure 后，结论与 live-only 不同，含 review-incomplete 及确切 batchId、manifestHash，防“始终忽略回测证据”伪通过。
2. **nit**：atomic 非 immutable 分支移除无用局部 old 与 void old，改为直接 await privateRead(file)。**保留既有文件权限、属主、no-follow 验证及异常行为**，不因清理空操作而删除安全检查。
3. **可选 nit**：补 markersVersion / correctionHash 两条端到端缓存失效测试。模拟旧版本有效缓存（验证 codec 校验通过），实际 scanCorpus 重扫后校验产物与下一次 warm，无修改上游常量/类型或生产编排。

自验：指定 vitest **17 文件 / 230 用例通过**（backtest 199 + pi-free 31）；orchestrate 24 用例。补充完整 typecheck/build 均 exit 0。以下是真实 tee 日志；历史 §附日志保留为首次交付记录。

### 修复后指定 vitest · exit 0

```text

 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ |tier1| tests/reflex/core/backtest/cluster.test.ts (20 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/corpus.test.ts (27 tests) 25ms
 ✓ |tier1| tests/reflex/core/backtest/replay.test.ts (18 tests) 26ms
 ✓ |tier1| tests/reflex/core/backtest/evidence.test.ts (9 tests) 29ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.test.ts (25 tests) 69ms
 ✓ |tier1| tests/reflex/core/backtest/orchestrate.test.ts (24 tests) 140ms
 ✓ |tier1| tests/reflex/core/backtest/regex-safe.test.ts (13 tests) 9ms
 ✓ |tier1| tests/reflex/core/backtest/family.test.ts (9 tests) 14ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.pipeline.test.ts (6 tests) 20ms
 ✓ |tier1| tests/reflex/core/backtest/corrections.test.ts (8 tests) 14ms
 ✓ |tier1| tests/reflex/core/backtest/markers.test.ts (7 tests) 446ms
 ✓ |tier1| tests/boundary/pi-free.test.ts (31 tests) 726ms
 ✓ |tier1| tests/reflex/core/backtest/report.test.ts (5 tests) 229ms
 ✓ |tier1| tests/reflex/core/backtest/ledger-format.test.ts (8 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/cache-format.test.ts (11 tests) 17ms
 ✓ |tier1| tests/reflex/core/backtest/draft-gen.property.test.ts (5 tests) 2839ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > 100% of generated drafts (auto + assigned) pass validateDraft & DRX & key whitelist 763ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > refine survivors are still 100% valid 1265ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > determinism: a second identical run is byte-identical 439ms
   ✓ seeded property: ≥1,000 random clusters → safe, valid drafts > tightenDraft is monotone on 300 random cases 370ms
 ✓ |tier1| tests/reflex/core/backtest/split.test.ts (4 tests) 48ms

 Test Files  17 passed (17)
      Tests  230 passed (230)
   Start at  20:11:46
   Duration  3.89s (transform 873ms, setup 430ms, collect 3.64s, tests 4.69s, environment 3ms, prepare 919ms)
```

### 修复后 typecheck · exit 0

```text

> pi-toolkit@0.10.6 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### 修复后 build · exit 0

```text

> pi-toolkit@0.10.6 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.6 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=3baa3f7ebde4b7f9 size=4.75 MB time=208 ms inputs=705
```

### 修复后精确三文件 prettier check · exit 0

```text
Checking formatting...
All matched files use Prettier code style!
```
