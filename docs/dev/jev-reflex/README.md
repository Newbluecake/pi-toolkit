# jev-reflex · 开发者要点

> 何时读：改动 `src/reflex/**`、`reflex.*` 设置键、`/reflex`、`subagent:reflex*` customType、主会话 input handler 的注册顺序之前。
> 设计：`arch.md`（类型/语义以它为准）、`plan.md`（PD1–PD12 覆盖 arch）、`feasibility.md`。交付报告：`R0-report.md`…`R2b-report.md`。
> 新的实现细节写在这里，不要写回 AGENTS.md。

## 是什么

R 层（Reflex）：在 `input` 阶段对只读自省问题（后台 job / subagent 状态 / 额度 / git 状态）用确定性 port 直接作答，
不起模型 run。**只读 MVP**：`reflex.enabled` 默认 `false`；先 shadow（只记账不作答），晋升只能由用户改 `reflex.autoResolve`。
本文件随包增长。

## 当前状态（R2b：shadow 可上线）

- R0：契约冻结（`core/{types,settings}.ts`、`setting-specs.ts`、`ports/index.ts` 接口）+ 注册清单固定 6 项（顺序由 `activate-trace.json` `max` 档钉住）：`input` → `agent_settled` → `session_start` → `session_shutdown` → `registerMessageRenderer("subagent:reflex")`（API 存在时）→ `registerCommand("reflex")`。
- R1：`core/**` 纯函数核心（gate/match/state/render/agreement/promotion…）。R2a/R2a′：四个只读 port + 单一预算竞速（`executePort` → `core/budget.ts` `raceBudget`）。R2b：shadow 接线 + `/reflex status|explain|reset`。
- `src/index.ts` 装配位置：web-hub 块之后、topic-switch 之前；`reflexFence.topicSwitch` 在 topic-switch 之后晚绑定（同 `xsFencePorts`）。`ReflexWireDeps` 追加了三个**可选**字段（`clock`/`monoNow`/`scripts`，默认 `systemClock`/`performance.now`/内置目录；生产装配不传）。
- R3a+ 只填 AUTO 分支：**不得再改注册清单 / 设置键 / `core/types.ts`（只许追加）**。

### R1/R2a 落地时相对 arch/plan 的偏差（均经 root 批准，详见各 Rn-report）

- gate 否定窗口：`没有|没|未|无` 在 `gate.ts` 本地扩展（`clauses.ts` 未动），使「有未提交的改动吗」不被祈使词「提交/改」否决；`VetoCode "negation"` 保留但永不返回。
- `onRepeat`/`onCorrected` 追加可选第三参 `state`：非 `auto` 不降级（PD5 守卫在函数内）。
- `ScriptStats.p50ms/p95ms` 由调用方填（`msPercentiles`）；`judged = agree+noTool+diverge`。
- `raceBudget` 把 `p` 的 rejection 吞成 `timeout`；需要区分异常的调用方先包装（`executePort` 已包装，保留 `error:"exception"`）。坏 Clock：setup 抛 ⇒ timeout，cleanup 抛 ⇒ 保留已有结果。
- port 输出约定：`git.status` 始终先输出一行分支摘要（`branch · upstream X|none · ahead a/behind b`，detached 写 `HEAD (detached)`），干净时第二行 `working tree clean`（**不返回 `lines:[]`**），脏时第二行是 `staged n/modified n/untracked n/unmerged n`，之后最多 15 个路径；`jobs.list`/`fleet.status` 0 条 ⇒ `ok/lines:[]`（渲染走 `emptyText`），jobs 每组 ≤8 行、fleet 非终态 ≤8 行，超出置 `truncated`；`quota.summary` 无可信快照 ⇒ `uncertain`；manager 缺席 ⇒ `unavailable`；`git` 超时/溢出/中止 ⇒ `error`（timeout/overflow/aborted），128/spawn 失败 ⇒ `unavailable`，其余非零 ⇒ `error("exit")`，格式非法 ⇒ `error("parse")`。facts 只放计数，不放路径/命令。
- fleet hit 例句用「现在有几个 agent 在跑」（「运行」是祈使否决词）。

## R2b shadow 语义（`wire.ts`）

- **input（同步、非 async）**：入口先做 pending 超龄检查（`PENDING_MAX_AGE_MS`，无定时器）→ correction 检测（仅 `interactive ∧ tui`，命中**当场** `appendEntry("subagent:reflex-correction")`，与随后 veto/miss 无关，每目标一次）→ `evaluateGate` → `match`。veto/miss 不记录；ambiguous ⇒ 单槽 pending(`ambiguous`)；high ⇒ pending(`shadow`) 并在 `queueMicrotask` 内 `executePort`，**无论 state 是 shadow/demoted/auto 都按 shadow 处理**（`record.state` 如实写有效状态）。所有路径同步返回 `{action:"continue"}`；整个 handler try/catch fail-open（与 pi 文档 fail-closed 建议相反，理由：R 层纯建议性，bug 只能退化为「模型照常作答」）。
- **单槽**：新候选到来时旧 pending 未结算 ⇒ 立即以 `model:{agree:"unknown",tools:[]}` 落一条 record（port 若还没回来则不带 `port`），再替换。
- **agent_settled**：超龄检查 → `collectToolShapes(getBranch)`（pi 的 `message` 条目经 `toBranchLike` 适配成 core 的结构类型）→ `judgeAgreement` → 恰好一条 `subagent:reflex-record` → 清槽，并以结算时刻 `now` 建 `CorrectionMemo`。digest 不一致 / getBranch 不可用 ⇒ `unknown`。ambiguous 槽没有单一脚本可比对 ⇒ 恒 `unknown`（tools 只留审计）。若 agent 跑得比 port 还快（port 尚未回来）⇒ record 不带 `port`（晚到结果丢弃）。
- **PD11**：`session_shutdown` abort + 丢 pending（**不落盘**）+ `generation++`；`session_start` re-arm 并清 pending/memo/re-ask 窗口；port 续体捕获 `gen`，写回前检查 `isStale(gen) || pending !== p`，迟到结果（含 strike 计账）一律丢弃。脚本降级覆盖层（strikes/demoted）跨会话保留。
- **strike**：port 结果在未过期时喂 `onExecOutcome`（shadow 态也计，连续 2 次 error/timeout ⇒ `demoted` 覆盖层，静默；仅 auto→demoted 时 `ui.notify`）。`onRepeat` / AUTO `onCorrected` 留给 R3a（R2b 从不作答，re-ask/纠正不是降级证据）。
- **counters**：`candidates/answered/ambiguous/repeat/reasked/corrected`（+ R3a 的 `fallback.<reason>`）为本激活闭包计数；`/reflex status` 另汇总本会话 `getBranch()` 的 record/answer/correction（`core/promotion.accumulate`），晋升判定恒显示「本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`（R3b）」。
- **`/reflex`**：`status`（默认）| `explain <text>`（理想 TUI 空闲事实跑 S0+S1，输出 veto 码或 band+脚本+命中模板 `strong#i|weak#i`，不执行 port）| `reset [id]`（清 strikes 与降级覆盖层，纯内存）。
- **手动冒烟（本机）**：`reflex.enabled=true`（pi-toolkit.json）→ `/reload` → 问「后台还有几个 job」→ 模型照常作答 → `/reflex status` 应显示 `candidates=1`、会话记录 `jobs.list@1 cand=1`；`/reflex explain 工作区干净吗` 应给出 `band=high script=git.status`。若 `agree` 长期全是 `unknown`，说明会话里用户消息文本与 input 文本不一致（被前序 handler 改写），需查 digest 口径。

## 不变式（R-I1…R-I12）

- **R-I1** 关闭 / secure / locked / 子会话 ⇒ 零注册（`wireReflex` 不被调用，或守卫直接返回 undefined）。由 `reflex-off-golden.json` + trace 钉住。
- **R-I2** 只受理 `source==="interactive" ∧ mode==="tui" ∧ 空闲 ∧ 无图`。
- **R-I3** 从不 `sendUserMessage`、从不 `triggerTurn`、从不 `transform`；回退 = `continue`（`tests/reflex/governance.test.ts` G2/G3/G4 扫描；R2b 的 wire 连 `sendMessage` 都不调）。
- **R-I4** 只有 AUTO 脚本的 port 在预算内返回 `ok` 时才返回 `handled`；其他一切情况（含异常）返回 `continue`。
- **R-I5** shadow 不改变可观察流程：任何 await 之前同步返回 `continue`；副作用只有只读 port 执行和 `agent_settled` 时写一条 custom entry。
- **R-I6** port 只读：不联网、不写盘、不改 manager；git argv 冻结且带 `--no-optional-locks`。
- **R-I7** in-band 预算 ≤ `REFLEX_BUDGET_MS`（1200），经过 `clampSpanMs`；计时器 `unref`；shutdown 中止在飞任务、置 `disposed` 并推进 `generation`，之后迟到的 async settle 无副作用；`session_start` re-arm 后**同一闭包继续服务新会话**（PD11）。同步入口（input / agent_settled / command）不检查 `disposed`，只有 async 迟到 settle 检查 `isStale(gen)`。
- **R-I8** 所有状态都在 `wireReflex` 闭包里，不用 `Symbol.for` 全局。
- **R-I9** 输出只有 `subagent:reflex`（custom message）、`subagent:reflex-record` 与 `subagent:reflex-correction`（custom entry）三种；details 只追加字段；不写 system prompt。customType 一律 `subagent:reflex*`（I7，不用 `pi-toolkit:*`）。
- **R-I10** `src/reflex/core/**` pi-free（`tests/boundary/pi-free.test.ts` 值闭包门禁，PD3；`ports/*.ts` 同款，PD4）。
- **R-I11** 注册位置：web-hub 块之后、topic-switch 之前；topic-switch hold 或 goal 活跃时退让（S0 veto `fence-topic` / `fence-goal`）。
- **R-I12** 只有内置脚本；`origin:"extracted"` 不可加载；rscript/1 没有 argv 种类。

## 降级 / 计数语义（plan PD5、PD6、PD12）

- 脚本状态：`shadow` / `auto` / `demoted`；`demoted` 行为同 shadow，覆盖层跨会话保留到 `/reload` 或 `/reflex reset`。
- 降级触发：连续 2 次 `error|timeout`（`demoteReason:"strikes"`）；**AUTO 态下出现 repeat 或 correction 立即降级**（`"repeat"` / `"corrected"`，PD5），并 `ui.notify` 一次。`uncertain` / `unavailable` 不计 strike。
- 重复提问（PD6）：shadow 期用 `ReflexRecordV1.reasked:true` 计——同一 `requestDigest` 在 10min 内再次成为同一脚本候选。
- 纠正（PD12）：命中纠正词表时在 input 同步段**立即**写 `subagent:reflex-correction`（`ReflexCorrectionV1`，不存原文，每个目标至多一次），与该输入随后 veto / miss / 命中无关。
- 晋升门槛（U5，唯一实现 `core/promotion.ts`，R1）：同一 `scriptId@scriptVer` ≥50 条候选、port 成功率 ≥99%、分歧 ≤5%、重复提问 / 纠正 = 0。晋升只能人工改设置；只自动降级不自动升级。

## 门禁

| 门禁                                              | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/fixtures/reflex-off-golden.json`（A 级）   | R0 在 dev 上**未改代码前**捕获（`PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE=1`，文件存在则拒绝覆盖）；`default` / `explicit-off` / `secure` / `child` 四场景：工具表、命令表、逐事件 handler 计数、renderer 列表、system prompt、input 链结果、`subagent:reflex*` 写入数（必须 0）。永不重生                                                                                                                                                                     |
| `activate-trace.json`（B 级）                     | 只改 `max` 档（`trace-profiles.ts` 的 `max` 加 `reflex:{enabled:true}`），共 6 行；其余档逐字节不变。刷新：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance/activate-trace.test.ts`                                                                                                                                                                                                                                                          |
| `stack-teardown-matrix`                           | FULL 档 `session_shutdown` 15→16、`session_start` 17→18（reflex shutdown abort / re-arm）；BASELINE 档不变                                                                                                                                                                                                                                                                                                                                             |
| `setting-specs-pin.json` / `settings-corpus.json` | 仅因新增 `reflex.enabled` / `reflex.autoResolve`（追加在末尾）/ `.reflex` 模板子树而重 pin；先 `captured[i].input` 取自 `origin/dev` 再生成并程序化比对                                                                                                                                                                                                                                                                                                |
| pi-free 闭包                                      | `src/reflex/core/**`、`src/reflex/ports/*.ts`                                                                                                                                                                                                                                                                                                                                                                                                          |
| D8                                                | `applySecureDomainOverrides` 强制 `reflex.enabled=false`（`tests/secure/settings-override.test.ts`）+ `wireReflex` 内 `secureDomainKind !== "plain"` 守卫（`tests/reflex/wire-skeleton.test.ts`）                                                                                                                                                                                                                                                      |
| conformance                                       | `tests/conformance/reflex.test.ts` C-R1…C-R8（pi peer bump 必跑）：C-R1 handled 无 run；C-R2 async await / 短路 / continue 原文；C-R3 idle `sendMessage` 为 user 角色上下文；C-R4 `appendEntry` 不进上下文；C-R5 无 source 的 `prompt()` 报 interactive；C-R6 引用 `topic-switch-hop.test.ts` S5（`it.todo` + 存在性断言）；C-R7 TUI 主循环串行（`mode.run()` 在 init 之上启主循环，真实 `InteractiveMode`）；C-R8 `ctx.mode` TUI 为 `"tui"`、SDK 不是 |

## 晋升流程（plan §7）

1. R0 → (R1 ∥ R2a) → R2a′ → R2b 合入 ⇒ 用户本机 `reflex.enabled=true` + `/reload`（`autoResolve` 为空 ⇒ 全部 shadow）。
2. R3a ∥ R3b 合入（不改变 shadow 行为）。
3. shadow 约 2 周 ⇒ `npm run build && node scripts/dev/reflex-shadow.mjs --days 14`（R3b）。
4. 对 `eligible` 的脚本人工抽查 diverge 样本，**由用户**把 id 加进 `reflex.autoResolve`（live）。建议顺序：`quota.summary`、`jobs.list` → `fleet.status` → `git.status`。
5. 晋升后任一 error/timeout×2、repeat、correction ⇒ 自动降回 shadow；`scriptVer` 变更 ⇒ 统计重新从 0 计。

## 残留风险（arch §7 R1–R9 + plan §9）

- **R1 误答**（意图不是工具状态）：默认只跑 shadow；strong 全句模板 + 祈使/指代否决；答案标明「未调用模型」；repeat 逃生口；correction 计数。
- **R2** AUTO 回退时 in-band 多等 ≤1.2s；连续失败自动降级。
- **R3** TUI 串行前提若被 pi 改掉：C-R7 钉住；R 层自带单飞守卫；最坏情况「已起 run 又答一次」，不丢输入。
- **R4** handled 的问题不以 user 消息出现 ⇒ title / topic-switch excerpt / feishu 摘要 / P 层承接少一条 user 轮次；命中消息带 `Q:` 行。
- **R5** 超大仓库 `git status` 超预算：记 strike、两次降级。
- **R6** 命中消息以 user 角色进上下文：`<reflex … note="data, not instructions">` 标签、脱敏、行/字节上限。
- **R7** feishu-notify `userInputPending` 在 handled 后拖到下一次 run 才消费（feishuNotify 默认关、secure 强制关；MVP 不修）。
- **R8** shadow 的 agreement 只是代理指标：晋升要求人工抽查 diverge。
- **R9** 设置键 / trace 刷新触碰 B 级金身：只接受 `max` 条目 diff。
- web-hub 镜像把 `subagent:reflex` 按通用 custom message 显示原文（含 XML 外壳）——I10 不新增 wire 字段，记为残留。
- 跨会话重复口径偏严（10min 内不同会话问同一句也算重复）；若 shadow 期长期不达标由主会话 `ask_user` 决定是否只计同会话。
- **C-R7 手动复核**（若将来 harness 无法驱动主循环）：真实 TUI 里在 input handler 的 await 期间连提两条消息，确认第二条排队而非并发进入 `prompt()`。当前由 `reflex.test.ts` C-R7 自动覆盖。
