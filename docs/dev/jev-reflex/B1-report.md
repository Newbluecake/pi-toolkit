# B1 · 回测核心 — 交付报告

> 包：#25 jev-reflex B1（`backtest-plan.md` §「B1 · 回测核心」5 个步骤）
> 依赖文档：`backtest-arch.md`（BA r3，§4.2–§4.3、BD5）、`B0-report.md`（契约提交 **`cd1d6c4a`**）
> 分支 dev，开工基线 `dc036048`。文件域严格遵守派单：只新建下述 13 个文件，未改任何既有文件、无 git 写操作。

## 1. 实现范围（对照方案 B1 五步）

| 步骤 | 内容                                                                                                                                                                                         | 状态 | 落点                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `markers.ts`：`ORIGIN_MARKERS` / `INJECTED_PREFIXES` / `MARKERS_VERSION` / `HUD_TUI_GATE_SINCE` / `HUD_TIME_ENTRY_TYPE` / `SUBAGENT_CHILD_MARKER` / `SUBAGENT_RUN_MARKER` / `isInjectedText` | ✅   | 值导入三个闭包 pi-free 的源常量（topic-switch `ENTRY_TYPE`、fabric `WAKE_LEVEL_CUSTOM_TYPE`、hud `LLM_TIME_ENTRY_TYPE`），镜像 `subagent:web-origin`（源值导入 pi-tui）、`subagent:child` / `subagent:run`（沿 provenance.ts 先例镜像）；存活测试逐字面量锚定                                                                                                                                                                                          |
| 2    | `split.ts` + `corpus.ts` 的 `buildFamilyIndex`                                                                                                                                               | ✅   | `splitOfRoot`（sha256 前 4 字节 BE mod 100 < 60）、`splitForRoot`（无根 ⇒ unscored）；`parseSessionHeader`（真实 header 形状，ISO 时间戳）、`buildFamilyIndex`（byPath/byId/duplicateIds）、`resolveFamily`（路径 → basename 抽 id 兜底 → missing-parent/cycle/duplicate-id/not-in-index）                                                                                                                                                             |
| 3    | `createCorpusBuilder`：轮次归属 / 来源 / 子会话排除 / 去重（BD5）/ `unknownFacts`（受理确证度 r3）                                                                                           | ✅   | 纯函数无 fs；来源按父链 customType（web/wake/topic-switch）+ 注入前缀 + toolUse/toolResult ⇒ steer；子会话双通道（`subagent:child` 自标记 + 主会话 `subagent:run` 的 `diag.sessionFile`，相对路径按 provenance 口径 resolve）；跨文件按 `entryId\0entryTimestamp` 声明归属，header 时间戳最早者胜，乱序 steal+revoke（`takeRevoked()`）；unknownFacts 六事实逐轮计算（idle/pendingMessages、topicSwitchActive、goalBusy、sourceMode；inFlight 恒可推） |
| 4    | `replay.ts`：两层匹配、acceptance、reasked、memo 语义重放 corrected、suspect                                                                                                                 | ✅   | builtin 先、miss 才跑草案（K2）；gate 用理想 TUI 事实（真实 imageCount/text）；reasked 键 = V2 identityKey+digest、按会话、REPEAT_WINDOW_MS；corrected 按实时单槽 memo（settledAt 置槽、origin∈{tui,replay}、90s 窗、一次性、中间输入不清槽）；suspect 优先级 corrected > reasked > write-turn/other-port/diverge；veto 行带 `wouldHit`                                                                                                                |
| 5    | `evidence.ts`：`parseReviewFile`、`backtestEvidence`                                                                                                                                         | ✅   | 只计 `turnKeys ∈ batch ∧ split==="holdout"`；confirmed/lenient 分账（lenient 附各 GateFactName 计数）；reasked/corrected 只计 high、评审 ok 豁免计入 waived；suspects/reviewed/misfires（digest+portId 匹配、misfire 去重）；unscored 单列；crossSessionRepeats 复用 B0 `countCrossSessionRepeats`（只读调用 promotion.ts，未改一字）；另导出 `turnKeyOf`（批次键唯一定义，B3/B5 复用）与 `highIdentityOf`（行 → V2 身份，供调用方按契约预过滤）       |

新增源码 5 + 测试 7 + 共享 fixtures 1，合计约 2,530 行（B1 文件域内；同目录 B2 的 cluster/draft-gen/regex-safe 系并行包产物，未触碰）。

## 2. `HUD_TUI_GATE_SINCE` 取值方法与 git 证据

定值 = **`1_789_715_067_000`**（ms）。推导过程（可复核）：

```sh
$ git log --follow --format='%H %ct %ad %s' --date=iso -- src/hud/index.ts | head -8
ed85e2842943a7d6960bc6f38348da37021413ef 1793718488 2026-11-03 23:08:08 +0800 chore(ui): drop pi-subagent ...
228631bcb02dc98e9b06859793ea7ca8b647c78f 1793695702 2026-11-03 16:48:22 +0800 refactor(core): locate the package root ...
7d67dbc8b72c673626e88cd2403a609923a2d923 1790350574 2026-09-25 23:35:06 +0800 fix(hud): do not double-count nested run cost ...
e8c9dee30e2024608570206bd310ea76169b43ca 1790317532 2026-09-25 14:25:32 +0800 feat(hud): show plugin version, commit ...
845d698658f724e6257982c7f9d442fa94874e1e 1790141609 2026-09-23 13:33:29 +0800 feat(hud): give tool stats their own footer line
9d0ef54660be279b9b3e0025482cbf72b7e2e170 1789970163 2026-09-21 13:56:03 +0800 feat(hud): periodic git fetch ...
78d71adcfbd97f4f2c269375196bcb647a623b97 1789715067 2026-09-18 15:04:27 +0800 feat(hud): merge pi-hud footer HUD as src/hud

$ git log --format='%H %ct %ad %s' --date=iso -S '非 tui 会话不再产生 HUD 计时条目' -- src/hud/
78d71adcfbd97f4f2c269375196bcb647a623b97 1789715067 2026-09-18 15:04:27 +0800 feat(hud): merge pi-hud footer HUD as src/hud
```

- S3「单一 live 门」（`HudSession.live = ctx.mode === "tui"`，非 tui 不落 `pi-hud-llm-time`）随 `78d71adcfbd9` 首次进入仓库；`git show 78d71adc:src/hud/index.ts` 已含门注释与 `live = ctx.mode === "tui"` 代码（本报告附核验：`markers.test.ts` 的存活测试持续断言这两处仍在）。
- 该文件此后 6 个提交（autoFetch / tool stats / plugin version / nested cost / package root / 文案）均未触及 tui 门语义 ⇒ 门生效起点 = 该提交时间 `%ct = 1789715067` ⇒ `1789715067_000` ms。
- 早于该时刻开始的轮次，其区间内的 HUD 计时条目**不采信**（`corpus.ts` closeOpen 的 `turn.at >= HUD_TUI_GATE_SINCE` 检查；r3 判据④，测试 `④ HUD entries inside turns that START before HUD_TUI_GATE_SINCE are not admitted`）。

## 3. BA 未明说处的设计裁定（问题 + 默认做法；已 message_agent finding 发 root）

> **root 裁定（2026-11-05）：D1–D4 四条默认做法全部接受**；D4 按裁定升格为 §3.1「给 B3 的调用约定」。

| #   | 问题                                                                                                                                           | 默认做法（已实现）                                                                                                                                                                                                                                                                     | 理由                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | BA §4.2 说 fence「推出当时状态 ⇒ 可确证」，但**推出为 active**（hold/goal 活跃）时受理实为可证伪，BA 未给通道（`Turn` 类型冻结，无法携带真值） | 导出为 active ⇒ 该事实计入 `unknownFacts`（lenient）                                                                                                                                                                                                                                   | 与 K11 同向：宁少算不虚算；若视为已确证受理，会把运行时必被 fence-topic/fence-goal 否决的轮次计入 confirmed 分母，稀释分歧率语义反转 |
| D2  | steer/replay 来源轮次在运行时必被 gate 行 1/3 否决（source=extension / streamingBehavior），回测是否保留                                       | replay 对所有轮次用**理想 TUI 事实**（`/reflex explain` 同口径）——回测的问题是「若在 TUI 空闲敲出会否命中」；来源分类只服务语料筛选与聚类（web/injected 排除、replay/steer 保留）                                                                                                      | BA §4.3 的 counterfactual 语义；B2 聚类需要这些样本                                                                                  |
| D3  | `CorrectionFact` 是否受 `until` 上界                                                                                                           | 只受 `since` 下界，不受 `until` 上界                                                                                                                                                                                                                                                   | 晚于 until 的纠正可能指向窗口内轮次；截断只会少计纠正（少计违反保守原则，BA §4.3「离线只会多计纠正（保守）」）；memo 90s 窗天然兜底  |
| D4  | 跨文件去重与喂入次序                                                                                                                           | 编排层**按 header timestamp 升序喂入**（§3.1 正式约定）；builder 的 claim map 在乱序时仍 steal+revoke（`takeRevoked()` 返还被撤回的 Turn/CorrectionFact），**turn 级完全次序无关**（BD5）；唯 sourceMode 证据归属在轮关闭时定格，乱序 steal 不回溯已返回轮次（按序喂入时该缝隙不可达） | BD5「与遍历顺序无关」在 turn 级成立；调用约定见 §3.1                                                                                 |

其余实现口径（无歧义，仅记录）：`splitOfRoot` 哈希**根会话 header id**（文件改名不影响家族同侧）；`beginFile` 唯一 skip 通道 `"skip-child"` 同时承载「header 不可解析」（B3 预解析 header，正常不会触达）；cwd 不匹配的文件仍可喂入（收割为空，家族索引照常全量解析）——B3 可自行预过滤省 I/O；`wouldHit` 取两层匹配器本会命中的 scriptId（high 或 ambiguous 首候选）；fence 状态在**轮开启时快照**（区间内 hold 被 outcome 解除不改写历史，与运行时 input 时读一致）；fence 的 malformed 条目使后续轮 lenient，直到下一条合法条目重新定格状态。

### 3.1 给 B3 的调用约定（createCorpusBuilder 喂入次序）——root 裁定 D4

**编排层（B3 `orchestrate.ts`）必须把会话文件按 header `timestamp` 升序喂给 `createCorpusBuilder`（祖先先于 fork）**：

1. 第一遍全量读 header 建 `FamilyIndex` 后，第二遍的喂入序列按 `SessionHeaderFact.timestamp` **升序稳定排序**（同刻并列按 `file` 字典序稳定化，保证 cold/warm 逐字节一致）；
2. 按序喂入时 claim 首次声明即最早者胜（fork 复制件全部让给祖先），`takeRevoked()` 恒为空——**B3 仍必须消费它**（把撤回项从早前 `endFile()` 结果中减去），以钉住次序无关语义并在异常乱序时自愈；
3. `sourceMode` 证据归属在轮关闭时定格：只要遵守本款升序约定，不存在「已返回轮次的证据事后被 steal」的缝隙；若编排因故乱序喂入，turn/纠正仍自洽（steal+revoke 兜底），但 confirmed/lenient 划分可能偏松（多计 lenient，保守方向），报告应如实标注喂入次序；
4. 热缓存回放（cold/warm 等价测试）不经过 builder，不受本约束影响；缓存失效后的全量重扫路径必须与冷扫使用同一排序。

## 4. 门禁输出（真实输出，全文 tee 于 /tmp/b1-*.log）

### 4.1 定向 vitest + pi-free

```
$ npx vitest run tests/reflex/core/backtest tests/boundary/pi-free.test.ts
 ✓ tests/reflex/core/backtest/corpus.test.ts (27 tests)
 ✓ tests/reflex/core/backtest/corrections.test.ts (8 tests)
 ✓ tests/reflex/core/backtest/evidence.test.ts (9 tests)
 ✓ tests/reflex/core/backtest/family.test.ts (9 tests)
 ✓ tests/reflex/core/backtest/markers.test.ts (7 tests)
 ✓ tests/reflex/core/backtest/split.test.ts (4 tests)
 ✓ tests/reflex/core/backtest/replay.test.ts (18 tests)
 ✓ tests/boundary/pi-free.test.ts (18 tests)      ← 值闭包含新 backtest/*.ts 与三个外部值导入
（并行情形：同目录 B2 的 cluster/draft-gen/regex-safe 6 个文件亦绿）
 Test Files  13 passed (13)
      Tests  179 passed (179)
```

B1 专属 7 文件 82 用例全绿。测试覆盖对照方案清单：家族（真实 header 形状：正常父子孙 / 移位路径兜底 / 父缺失 / 跨 cwd fork / 环 / 重复 id / `--cwd` 过滤下全量解析 / 家族同侧）、1 万随机根 60±2pp（split.test，seeded mulberry32）、去重（同条目计 1、保留最早、乱序 steal+revoke）、来源表每行 1 fixture（web / wake / 注入前缀×4 / topic-switch / toolUse 父 / toolResult 父 / tui）、纠正六例（长句多行被计 / 中间夹无关输入 / web·injected 不计 / 窗口外 / 同目标一次 / 无 memo 不计）、稀释反例（3/50 confirmed diverge 保持 6%，lenient 50 单列）、确证判据 ①–⑤（fork 复制证据 / 前半 TUI 后半 print / 他轮 reflex-record / 早于 gate 的 HUD / 同 digest reflex-record 正例）、replay 与 wire 同输入同 band（builtin 全部 examples.hit 高命中 + 全部 miss 逐条与 evaluateGate+compileCatalog 结果比对）。

### 4.2 FX 门禁（X4，B0_COMMIT=`cd1d6c4a`）

```
$ git diff --quiet origin/dev -- tests/fixtures/ ':!tests/fixtures/reflex-drafts-off-parity.json' \
    ':!tests/fixtures/web-hub/reload-result-compat-golden.json' \
  && git diff --quiet cd1d6c4a -- tests/fixtures/reflex-drafts-off-parity.json; echo FX=$?
FX=0
```

### 4.3 `npm run typecheck`

```
tsconfig.json        exit=1
tsconfig.typecheck   exit=1
（vue-tsc 段因 && 短路未执行）
两个 tsc 项目的全部错误（各 2 条，内容相同）：
src/tools/message-agent-tool.ts(113,61): error TS2345: Argument of type '"directive" | "finding" | "progress"' is not assignable to parameter of type '"directive" | "progress"'.
src/tools/message-agent-tool.ts(114,61): error TS2345: （同上）
```

**B1 文件域 0 错误**：`grep -c reflex /tmp/b1-tc-a.log /tmp/b1-tc-b.log` ⇒ `0 / 0`。上述 TS2345 全部位于**在途 fabric-kind 包**的 `src/tools/message-agent-tool.ts`（开工时 `git status` 即为 `M`，见派单「git status 里出现它们属正常」；运行期间还观察到同包 `src/fabric/mailbox.ts` 的 5 条 TS2367 出现又消失——对方包正在迭代）。禁改。

### 4.4 prettier

```
$ npx prettier --check src/reflex/core/backtest/*.ts \
    tests/reflex/core/backtest/{corpus,family,markers,split,replay,corrections,evidence}.test.ts \
    tests/reflex/core/backtest/fixtures-b1.ts
All matched files use Prettier code style!        PRETTIER=0
```

### 4.5 附加（未要求，防 CI 红）：tier 治理

```
$ npx vitest run tests/governance/test-tiers.test.ts
 Tests  11 passed (11)
```

B1 新测试无 child_process/socket/sleep/mount 词法，不需登记 `tests/tiers.ts`（tier1 默认）。

## 5. 冻结面核对

| 冻结面                        | 状态           | 证据                                                                                                                                                                                                                                                |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1 / X2                       | ✅ 未触碰      | `git status` 中 B1 只新增 `src/reflex/core/backtest/{corpus,markers,split,replay,evidence}.ts` 等本包文件；既有文件零改动                                                                                                                           |
| B0 契约（types.ts 等）        | ✅ 只读 import | `types.js` / `promotion.js`（`countCrossSessionRepeats`）/ `shadow-scan.js`（`scanReflexLine`）/ `port-defaults.js` / `identity.js` / `digest.js` / `normalize.js` / `gate.js`（`CORRECTION_RE`）/ `match.js` / `agreement.js` / `budget.js` 均未改 |
| B2/B4/B5 文件域               | ✅ 未触碰      | 同目录 B2 文件（cluster/draft-gen/regex-safe + 其测试）为并行包产物，`git status` 属预期，未碰                                                                                                                                                      |
| `promotion.ts` 只读调用       | ✅             | 仅 `evidence.ts` import `countCrossSessionRepeats`                                                                                                                                                                                                  |
| pi-free（I8/R-I10）           | ✅             | `core/backtest/**` 自动入值闭包门禁（4.1 绿）；外部值导入仅 topic-switch/records、fabric/wake-level、hud/timing（均仅类型依赖 pi，值闭包干净）与 memory/jev/predict/shape（agreement.ts 同款先例）                                                  |
| 纯函数、无 fs、无模块态（I4） | ✅             | corpus/replay/evidence/markers/split 均为注入式纯逻辑；marker 存活测试的 fs 读取在测试文件                                                                                                                                                          |

## 6. 遗留问题

1. **`npm run typecheck` 因在途 fabric-kind 包不绿**（§4.3）——非本包文件，按派单禁改；该包合入后自然全绿。
2. ~~D1–D4 四项裁定待 root 知悉~~ → **root 已全部接受（2026-11-05）**；D4 落为 §3.1 的 B3 调用约定（升序喂入），实现无需改动（corpus.ts 头注释已写明推荐次序）。
3. **`subagent:reflex`（custom_message 答案路径）作为 sourceMode 证据②** 的解析走 `scanReflexLine`（B0 已验证 answer 形状），B1 测试以 `subagent:reflex-record`（custom 路径）覆盖为主，answer 路径未单独出用例——同一函数同一解析器，风险低；B3/B5 若需要可补。
4. `highIdentityOf` 的 `portVer` 恒为 0（回测侧无 port 运行；identityKey 只绑 lineage+templateHash，不影响合并）——B5 `resolveIdentity` 是运行时侧的权威解析。

## 7. 附：文件清单（绝对路径，B1 文件域全部新建）

**源码（5）**

```
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/corpus.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/markers.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/split.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/replay.ts
/home/bluecake/ai/pi-toolkit/src/reflex/core/backtest/evidence.ts
```

**测试（7）+ 共享 fixtures（1）**

```
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/corpus.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/family.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/markers.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/split.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/replay.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/corrections.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/evidence.test.ts
/home/bluecake/ai/pi-toolkit/tests/reflex/core/backtest/fixtures-b1.ts
```

**报告**：本文件。
