# R1 报告 · pi-free 核心

日期 2026-11-05 · 分支 dev（R0 = ab14948b；并行包 R2a 已提交 18aad043）· 无任何 git 写操作。
任务：plan §4「R1 · pi-free 核心」，语义以 arch.md 为准；root 对 4 项偏差已裁定（2026-11-05，全部按默认做法 + 补充测试要求）。

## 1. 文件清单（全部新建，未修改任何已跟踪文件）

`src/reflex/core/`（plan R1 允许新建的 11 个文件，逐一对应）：

| 文件           | 行数 | 覆盖的 plan 步骤                                                                                                                                                                       |
| -------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.ts`    | 100  | 步骤 1：8 个常量（1200/120/600_000/90_000/2/24/2048/PENDING=REPEAT）+ `raceBudget`（clampSpanMs + 注入 Clock + abort + 拒绝吞掉）                                                      |
| `normalize.ts` | 36   | 步骤 2：NFKC→小写→折叠空白→trim→去尾标点（`?？。.!！~` 可叠加）；码点计数；raw 行数                                                                                                    |
| `digest.ts`    | 12   | 步骤 3：`node:crypto` sha256 前 16 hex                                                                                                                                                 |
| `gate.ts`      | 131  | 步骤 4：15 行按序否决 + `IMPERATIVE_VETO` 冻结数组（26 词，arch §4.3 原表）+ `CORRECTION_RE` 导出 + 否定豁免（见偏差 1）                                                               |
| `catalog.ts`   | 158  | 步骤 5：4 条 builtin 脚本（arch §4.5 表例句全部原文收录）、origin/version/risk、deep freeze、模块加载即 `validateCatalog` 自检                                                         |
| `schema.ts`    | 111  | 步骤 6：typebox `RScriptV1Schema` + `validateScript` + `validateCatalog`（拒 extracted/重复 id/超预算/序列化字面量/嵌套量词）+ `regexSourceProblems`                                   |
| `match.ts`     | 56   | 步骤 7：`compileCatalog`（strong 隐式 `^…$`、weak/exclude 子串、无 flag 编译）；单 strong 且无他命中 ⇒ high，否则 ambiguous                                                            |
| `state.ts`     | 110  | 步骤 8：`effectiveState` / `onExecOutcome`（strike 矩阵）/ `onRepeat` / `onCorrected`（PD5）/ `reset` / `detectCorrection`（PD12，纯函数）                                             |
| `render.ts`    | 112  | 步骤 9 + §5.1：逐字节格式、`redactForJev`（Q 行 "user"、端口行 "command"）、24 行/2048 B 截断 + `[truncated N lines]`                                                                  |
| `agreement.ts` | 120  | 步骤 10：`collectToolShapes`（倒序找最近 user + digest 核验；bash→`allShapes`、bash_job→`bash_job:<action>`、其他→工具名）+ `judgeAgreement`（edit/write 永不 agree）                  |
| `promotion.ts` | 195  | 步骤 11：`PROMOTION_GATE`（U5 冻结值）、`ScriptStats`、`accumulate`（口径全按 plan）、`countCrossSessionRepeats`、`evaluatePromotion`（中文 reasons，只建议不改设置）、`msPercentiles` |

`tests/reflex/core/`（Tier 1，全部内联断言，零 fixture 文件）：

| 文件                    | 测试数 | 覆盖                                                                                                                                                                                                                      |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize.test.ts`     | 7      | 归一化管线次序、码点/行数                                                                                                                                                                                                 |
| `budget.test.ts`        | 10     | FakeClock：1200 边界（1199 定时器 resolve / 恰 1200 超时）、>1200 钳位、非法预算立即超时且零定时器、settle 清定时器、abort（入口 + 中途）、早/晚拒绝吞掉、坏时钟                                                          |
| `gate.test.ts`          | 26     | 15 行逐行命中码与优先级；SHORT_REPLY_TABLE 全表（含尾标点/空白变体）、ANAPHORA_CJK/EN 全表拼句、取消句、IMPERATIVE_VETO 逐词前缀；root 裁定的否定四例；`negation` 保留码永不返回                                          |
| `gate.property.test.ts` | 2      | 种子性质（mulberry32 固定种子）：2,400 例「随机 hit 句 + 随机否决词随机位置插入」复合永不 high；500 例前缀插入在 gate 层必然否决                                                                                          |
| `match.test.ts`         | 12     | 例句语料端到端（hit ⇒ 恰好该脚本 high；miss ⇒ 永不 high 且分类有因）、caps 过滤、exclude 压 strong/weak、weak-only/跨脚本 ambiguous（自建 mini-catalog）、归一化喂入                                                      |
| `catalog.test.ts`       | 13     | 4 脚本、arch 表例句逐字在场、≥5/≥5、requires/agreement 对表、深冻结（改写抛错）、`validateCatalog` 通过；regex 卫生扫描（catalog + IMPERATIVE_VETO 无序列化字面量/无嵌套量词/无元字符；matcher 无状态可重入）             |
| `schema.test.ts`        | 16     | typebox 结构拒绝矩阵、extracted/重复 id/未知 port/capability、/g 序列化字面量、嵌套量词（含 `{n,m}` 尾、转义/字符类剥除）、不编译源                                                                                       |
| `state.test.ts`         | 16     | strike 矩阵（连击降级一次通告、ok 清 strike 不清覆盖层、uncertain/unavailable 不计、非连续不清零）、PD5（两参/带 state）、reset、detectCorrection（窗口边界 90s 含、corrected-once、无 memo、deltaMs、correctionDigest）  |
| `render.test.ts`        | 12     | §5.1 逐字节 `toBe` 快照、空行⇒emptyText、24 行截断、2048B 截断（CJK 行）、port truncated OR、脱敏（sk-/Bearer/base64≥32 打码、Q 行 120cp 上限）、非 ok 抛 TypeError                                                       |
| `agreement.test.ts`     | 11     | 四种结局、digest 不一致、无 user、user 之前工具不计、bash 形状去重、无 command 回退工具名                                                                                                                                 |
| `promotion.test.ts`     | 25     | 门槛全边界（49/50、0.99 恰过/0.9898 拒、5% 恰过/5.5% 拒、reasked/crossSessionRepeats(undefined 或 ≥1)/corrected=1 拒、unknown 不进分母）、accumulate 口径逐条、countCrossSessionRepeats 四例 + 链式 + 乱序、msPercentiles |
| `perf.test.ts`          | 1      | 1 万条随机输入 `evaluateGate+match` p99（断言 ≤5ms = 目标 1ms × CI 宽容系数，注释写明）                                                                                                                                   |

冻结面核验：`core/types.ts` **零改动**（只读引用）；`ports/**`、`git-status-parse.ts`、`wire/command/render-tui.ts`、X1/X2 全部、`tests/fixtures/**` 均未触碰（`git status` 仅新增上列文件；R2a 的 18aad043 是其自己的提交）。

## 2. 对 arch / plan 的偏差（1–4 已经 root 2026-11-05 裁定通过）

| #   | 偏差                                                          | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | gate 否决 #15 的否定豁免扩展                                  | arch §4.5 binding 例句「有未提交的改动吗」含祈使词 提交/改，clauses.ts 的 `negationWithinWindow` 词表（不要/别/不用…）无「未」族。在 **gate.ts 本地**（clauses.ts 未动）加扩展否定窗口 `没有\|没\|未\|无`，同 8 码点窗口形状。测试按 root 补充要求覆盖：放行「有未提交的改动吗 / 没提交的有哪些 / 不用提交的文件有哪些 / 先别改了，只看状态」；否决「把改动提交了 / 帮我提交 / 未来…提交吗（窗口外）/ 别一直…提交了吧（窗口外）」。 |
| 2   | `onRepeat`/`onCorrected` 追加可选第三参 `state?: ScriptState` | 落实 PD5「仅在 state 为 auto 时 ⇒ demoted」为函数内守卫（≠"auto" 直接原样返回），防未来调用方误用；AUTO 上下文的两参调用行为不变（无条件降级、首因保留、不重复通告）。                                                                                                                                                                                                                                                              |
| 3   | `ScriptStats.p50ms/p95ms` 由调用方填充                        | `accumulate` 不持有样本缓冲（不给计划外接口加字段）；导出 `msPercentiles(samples)` 供 R3b / `/reflex status` 用。`judged` 字段由 accumulate 维护（= agree+noTool+diverge），`evaluatePromotion` 读字段。                                                                                                                                                                                                                            |
| 4   | `VetoCode` 的 `"negation"` 在 R1 不返回                       | 16 行表中无独立否定行（第 16 行是 handler 异常兜底，归 R2b）；否定只调节第 15 行。代码注释 + 测试钉住「永不返回 negation」。                                                                                                                                                                                                                                                                                                        |
| 5   | `details.truncated` = 渲染截断 OR port 自身 `truncated`       | port 已截短但渲染未再切时，审计标志仍如实为 true；`[truncated N lines]` 标记行只报告渲染侧丢弃数（行/字节上限之外的附加行，不占额度）。                                                                                                                                                                                                                                                                                             |
| 6   | `details.lines` = 最终 content 的物理行数（含外壳与尾注）     | plan 只给字段名；选整条消息口径，快照测试钉住。                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | `raceBudget` 吞掉 `p` 的 rejection ⇒ `{kind:"timeout"}`       | 输入阶段的竞速绝不挂死绝不抛；需要区分异常的调用方（R2a′）先 `p.then(o=>({ok:o}),()=>({ok:false}))` 包装再进来（R2a 现版 executePort 的 error:"exception" 分类即靠包装保留）。                                                                                                                                                                                                                                                      |
| 8   | fleet 第 5 条 hit 例句用「现在有几个 agent 在跑」             | arch 词表把「运行」列为祈使否决词，任何含「运行」的输入过不了 S0；strong 模板中的 `运行` 死分支同步删除。另：latin 词（subagent/agent）与 CJK 交界处补 ` ?`（「子 agent 状态」这类空格形态）。                                                                                                                                                                                                                                      |
| 9   | schema「/g 语义」落为「拒绝序列化字面量形态 `/…/flags`」      | 正则源是字符串，flag 无从附着；编译辅助一律不传 flag，`regexSourceProblems` 拒绝字面量形态 + 嵌套量词形状扫描（`(x+)+`/`(x*)*`/`(?:…+){n,m}`/`(a{2,})+`，剥转义与字符类后检测），测试含 `x(\++)*`（真嵌套，正确命中）。                                                                                                                                                                                                             |
| 10  | `countCrossSessionRepeats` 映射所有出现过的 key（含 0）       | 未出现的 key 留 absent ⇒ 上游视作未判定（undefined ⇒ 永不 eligible）；「再次出现」对照**最近一次**前驱出现（链式 a→b→a 计 2），不同 `scriptId@scriptVer` / digest 各自成序列。                                                                                                                                                                                                                                                      |

## 3. 自验命令与真实输出

```
$ npx vitest run tests/reflex tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts
 Test Files  20 passed (20)
      Tests  256 passed (256)
（含 R2a 已提交的 ports 套件与 wire-skeleton/off-golden/pi-free 闭包门禁；全文 /tmp/r1-final.log）

$ npx vitest run tests/reflex/core        # R1 自身
 Test Files  12 passed (12)   Tests  161 passed (161)

[reflex perf] n=10000 p50=0.0107ms p99=0.0317ms max=0.9376ms   # 目标 p99 ≤1ms，×5 宽容断言 ≤5ms

$ npx prettier --check "src/reflex/core/*.ts" "tests/reflex/core/*.test.ts"
All matched files use Prettier code style!

$ npm run typecheck        # tsc×2 (strict) + vue-tsc
exit=0（全文 /tmp/r1-typecheck.log，零输出）

$ git status --short       # 仅上列新增文件；零已跟踪文件改动；tests/fixtures 未触碰
```

pi-free 值闭包门禁（PD3）随 20 文件通过：新 11 文件的值依赖 = topic-switch/filters、memory/jev/predict/{clauses,shape}、memory/jev/redact（连带 shell-parse/secret-patterns）、core/{clock(type),deadline}、`@sinclair/typebox`（非 pi，peer）。

## 4. 遗留 / 给后续包的接口备注

- **R2a′**：收敛 `executePort` 内联竞速到 `raceBudget` 时注意偏差 7 的包装约定（保留 error:"exception" 分类）；`REFLEX_BUDGET_MS` 常量已就位（ports 现版的裸 `1200` 应替换）。
- **R2b**：`PENDING_MAX_AGE_MS` 只在 input / agent_settled 入口检查（budget.ts 常量 + 注释）；`detectCorrection` 的 memo 形状见 `state.ts` `CorrectionMemo`；`CORRECTION_RE` / `IMPERATIVE_VETO` 从 gate.ts 导入。
- **R3a**：`renderAnswer` 参数 `{script, outcome(ok), question, ms, portVer}`，content 逐字节即所发消息体；`onRepeat/onCorrected` 带 `state` 调用（AUTO 分支可省）。
- **R3b**：`shadow-scan` 逐行喂 `accumulate`，`(session, at, key, digest)` 收集喂 `countCrossSessionRepeats` 后回填 `crossSessionRepeats`；ms 样本用 `msPercentiles`。
- 残留（非 R1 引入）：`IMPERATIVE_VETO` 的 EN 词为子串匹配（"skillfully" 会误否决）——否决方向保守、按 arch 词表原样，未收窄。
