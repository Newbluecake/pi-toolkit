# jev-reflex · 开发者要点

> 何时读：改动 `src/reflex/**`、`reflex.*` 设置键、`/reflex`、`subagent:reflex*` customType、主会话 input handler 的注册顺序之前。
> 设计：`arch.md`（类型/语义以它为准）、`plan.md`（PD1–PD12 覆盖 arch）、`feasibility.md`；#25 回测/草案：`backtest-arch.md`（BA）+ `backtest-plan.md`（B0–B3′ 分包）。交付报告：`R0-report.md`…`R3b-report.md`、`B0-report.md`…。
> 新的实现细节写在这里，不要写回 AGENTS.md。

## 是什么

R 层（Reflex）：在 `input` 阶段对只读自省问题（后台 job / subagent 状态 / 额度 / git 状态）用确定性 port 直接作答，
不起模型 run。**只读 MVP**：`reflex.enabled` 默认 `false`；先 shadow（只记账不作答），晋升只能由用户改 `reflex.autoResolve`。
#25 起增加离线回测与运行时草案加载：`reflex.drafts.enabled`（默认关、非 live）从 `<agentDir>/reflex/drafts/` 加载
离线生成的草案脚本（恒 shadow，永不 autoResolve）；回测/生成/晋升全链见下文「离线回测与草案（#25）」。
本文件随包增长。

## 当前状态（R3b：AUTO 分支与跨会话报告已就绪，默认仍 shadow）

- #25 B0：跨包契约冻结——`core/types.ts` 追加回测/草案类型；`core/{branch-like,port-defaults,draft-regex,draft-schema,identity}.ts`、`drafts/load.ts` 骨架（恒空）；`shadow-scan.ts` 宽进草案字段 + `scanReflexLine`；`wire.ts` 仅改 `toBranchLike` 的 import；A 级新金身 `reflex-drafts-off-parity.json`（改 wire 前捕获）。B1–B5/B3 按 `backtest-plan.md` 落实现。
- R0：契约冻结（`core/{types,settings}.ts`、`setting-specs.ts`、`ports/index.ts` 接口）+ 注册清单固定 6 项（顺序由 `activate-trace.json` `max` 档钉住）：`input` → `agent_settled` → `session_start` → `session_shutdown` → `registerMessageRenderer("subagent:reflex")`（API 存在时）→ `registerCommand("reflex")`。
- R1：`core/**` 纯函数核心（gate/match/state/render/agreement/promotion…）。R2a/R2a′：四个只读 port + 单一预算竞速（`executePort` → `core/budget.ts` `raceBudget`）。R2b：shadow 接线 + `/reflex status|explain|reset`。R3a：AUTO 全链路（命中即作答、`subagent:reflex` 命中消息、TUI 紧凑卡片、repeat/correction 即时降级）+ `render-tui.ts`。R3b：跨会话离线报告（`scripts/dev/reflex-shadow.mjs` + `core/shadow-scan.ts`），脚本不自动晋升。
- `src/index.ts` 装配位置：web-hub 块之后、topic-switch 之前；`reflexFence.topicSwitch` 在 topic-switch 之后晚绑定（同 `xsFencePorts`）。`ReflexWireDeps` 追加了三个**可选**字段（`clock`/`monoNow`/`scripts`，默认 `systemClock`/`performance.now`/内置目录；生产装配不传）。
- R3a/R3b 之后冻结面：**注册清单 / 设置键 / `core/types.ts`（只许追加）/ `src/index.ts`（X2）一律不再动**。

### R1/R2a 落地时相对 arch/plan 的偏差（均经 root 批准，详见各 Rn-report）

- gate 否定窗口：`没有|没|未|无` 在 `gate.ts` 本地扩展（`clauses.ts` 未动），使「有未提交的改动吗」不被祈使词「提交/改」否决；`VetoCode "negation"` 保留但永不返回。
- `onRepeat`/`onCorrected` 追加可选第三参 `state`：非 `auto` 不降级（PD5 守卫在函数内）。
- `ScriptStats.p50ms/p95ms` 由调用方填（`msPercentiles`）；`judged = agree+noTool+diverge`。
- `raceBudget` 把 `p` 的 rejection 吞成 `timeout`；需要区分异常的调用方先包装（`executePort` 已包装，保留 `error:"exception"`）。坏 Clock：setup 抛 ⇒ timeout，cleanup 抛 ⇒ 保留已有结果。
- port 输出约定：`git.status` 始终先输出一行分支摘要（`branch · upstream X|none · ahead a/behind b`，detached 写 `HEAD (detached)`），干净时第二行 `working tree clean`（**不返回 `lines:[]`**），脏时第二行是 `staged n/modified n/untracked n/unmerged n`，之后最多 15 个路径；`jobs.list`/`fleet.status` 0 条 ⇒ `ok/lines:[]`（渲染走 `emptyText`），jobs 每组 ≤8 行、fleet 非终态 ≤8 行，超出置 `truncated`；`quota.summary` 无可信快照 ⇒ `uncertain`；manager 缺席 ⇒ `unavailable`；`git` 超时/溢出/中止 ⇒ `error`（timeout/overflow/aborted），128/spawn 失败 ⇒ `unavailable`，其余非零 ⇒ `error("exit")`，格式非法 ⇒ `error("parse")`。facts 只放计数，不放路径/命令。
- fleet hit 例句用「现在有几个 agent 在跑」（「运行」是祈使否决词）。

## shadow / AUTO 语义（`wire.ts`，R2b → R3a）

- **input（普通同步函数，非 async）**：入口先做 pending 超龄检查（`PENDING_MAX_AGE_MS`，无定时器）→ correction 检测（仅 `interactive ∧ tui`，命中**当场** `appendEntry("subagent:reflex-correction")`，与随后 veto/miss 无关，每目标一次）→ `evaluateGate` → `match`。整个 handler try/catch fail-open（与 pi 文档 fail-closed 建议相反，理由：R 层纯建议性，bug 只能退化为「模型照常作答」）。veto/miss 不记录；ambiguous ⇒ 单槽 pending(`ambiguous`)；high ⇒ 单槽 pending，`state` 在每次 input **现读**（`autoResolve` 经 `/agent settings` 改动下一问即生效，I8 live）：
  - `state==="auto"` 且同一 `id@ver\0digest` 在 `REPEAT_WINDOW_MS` 内**已被作答**过 ⇒ 交回模型、`onRepeat`（3 参）立即降级 + `ui.notify` 一次、槽 `kind:"repeat"`（`reasked:false`，避免 promotion 双计），**同步** continue。
  - 其余 `state==="auto"` ⇒ 置 `inFlight`（单飞：await 期间的输入被 S0 in-flight 否决）后返回 `runAuto(...)` 的 Promise —— **唯一的 thenable 分支**（`.catch` 兜底，永不 reject）：预算内 `ok` ⇒ `renderAnswer` → `pi.sendMessage({customType:"subagent:reflex",content,display:true,details})`（单实参、无 options，C-R3）⇒ `answered` 计数 + 答案窗口记账 + `memo{kind:"answer"}` ⇒ `{action:"handled"}`（**作答不产 record**）；非 ok（`uncertain`/`unavailable`/`error`/`timeout`，含 `sendMessage` 异常）⇒ strike + `fallback.<kind>` + 槽改 `kind:"fallback"` ⇒ continue。
  - `shadow` / `demoted` ⇒ 旧 R2b 路径：`queueMicrotask` 内 `executePort`，**同步** continue，`record.state` 如实写有效状态。
- **单槽**：新候选到来时旧 pending 未结算 ⇒ 立即以 `model:{agree:"unknown",tools:[]}` 落一条 record（port 若还没回来则不带 `port`），再替换。
- **agent_settled**：超龄检查 → `collectToolShapes(getBranch)`（pi 的 `message` 条目经 `toBranchLike` 适配成 core 的结构类型）→ `judgeAgreement` → 恰好一条 `subagent:reflex-record` → 清槽，并以结算时刻 `now` 建 `CorrectionMemo`。digest 不一致 / getBranch 不可用 ⇒ `unknown`。ambiguous 槽没有单一脚本可比对 ⇒ 恒 `unknown`（tools 只留审计）；R3a 起 `shadow`/`fallback`/`repeat` 槽都指向单一脚本，均参与 `judgeAgreement`（`kind:"answer"` 不产 record）。若 agent 跑得比 port 还快（port 尚未回来）⇒ record 不带 `port`（晚到结果丢弃）。
- **PD11**：`session_shutdown` abort + 丢 pending（**不落盘**）+ `generation++`；`session_start` re-arm 并清 pending/memo/re-ask 窗口；port 续体捕获 `gen`，写回前检查 `isStale(gen) || pending !== p`，迟到结果（含 strike 计账）一律丢弃。脚本降级覆盖层（strikes/demoted）跨会话保留。
- **strike**：port 结果在未过期时喂 `onExecOutcome`（shadow / fallback 路径都计，连续 2 次 error/timeout ⇒ `demoted` 覆盖层；仅 auto→demoted 时 `ui.notify`）。repeat / correction 的降级在 input 同步段由 `onRepeat` / `onCorrected` 直接触发（见下节）。
- **counters**：`candidates/answered/ambiguous/repeat/reasked/corrected`（+ R3a 的 `fallback.<reason>`）为本激活闭包计数；`/reflex status` 另汇总本会话 `getBranch()` 的 record/answer/correction（`core/promotion.accumulate`），晋升判定恒显示「本会话样本不足以判定，跨会话请跑 `node scripts/dev/reflex-shadow.mjs`（R3b）」。
- **`/reflex`**：`status`（默认）| `explain <text>`（理想 TUI 空闲事实跑 S0+S1，输出 veto 码或 band+脚本+命中模板 `strong#i|weak#i`，不执行 port）| `reset [id]`（清 strikes 与降级覆盖层，纯内存，未知 id 报错不静默）。
- **TUI 卡片**（`render-tui.ts`，R3a）：命中消息对人眼折叠为 `reflex · <scriptId> · <ms>ms` + `Q:` + port 正文，剥掉 `<reflex …>` 外壳与末尾中文提示（正则锚定 §5.1 形状）；header 数字取自 `details`（权威审计），不重解析外壳。`details` 缺失/畸形、content 非字符串或外壳不匹配 ⇒ 返回 `undefined`，pi 回退默认渲染（用户仍看到原文）。
- **`/reflex status`**：每个脚本一行 `<id> <state> strikes=n [demote=<reason>]`，`demote=` 即降级原因（`strikes|repeat|corrected`）；另打印本激活计数（含 `fallback.<kind>`）与本会话 record/answer/correction 汇总。`/reflex reset [id]` 清 strikes 与降级覆盖层（纯内存），reset 后该脚本下一条 input 即恢复 `auto`；`/reload` 同样清空覆盖层。
- **手动冒烟（本机）**：`reflex.enabled=true`（pi-toolkit.json）→ `/reload` → 问「后台还有几个 job」→ 模型照常作答 → `/reflex status` 应显示 `candidates=1`、会话记录 `jobs.list@1 cand=1`；`/reflex explain 工作区干净吗` 应给出 `band=high script=git.status`。若 `agree` 长期全是 `unknown`，说明会话里用户消息文本与 input 文本不一致（被前序 handler 改写），需查 digest 口径。

## 威胁模型（#25，R-I14 的依据）

同 UID 的 agent（pi 的 bash 工具、子 agent）可以执行任意 shell，能读写 `<agentDir>` 下所有文件、改 `pi-toolkit.json`、伪造任何评审 / 暴露 / 批次 / manifest / 修订记录。因此：

1. `0700`/`0600` 与 uid 检查只防**其他 UID** 与误共享，不防同 UID；
2. `reviews/*.json`、`exposure.jsonl`、`manifests/`、`batches/`、`revisions.jsonl` 都是**未认证记录**：脚本照常读取用于统计（豁免、misfire 计数），但输出处标注「unverified」，任何本地机制（TTY、文件权限、hash）都**不能**证明「人看过」；
3. **唯一的人工认证点**是用户批准把草案改写进 `catalog.ts` 的 PR（或用户在对话中明确确认），PR 描述须引用 `--promote` 输出的身份元组（`{lineage, templateHash, portId@portVer, batchId, manifestHash}`）；
4. 运行时安全性不依赖任何离线记录：草案恒 shadow，port 只读，`reflex.drafts.enabled` 不改变任何作答行为。

## 离线回测与草案（#25）

设计 `backtest-arch.md`（BA），分包 `backtest-plan.md`（B0 契约 → B1 回测核心 ∥ B2 草案生成 ∥ B4 运行时加载 ∥ B5 晋升 V2 → B3 编排/账本/`scripts/dev/reflex-backtest.mjs`）。要点：

- **语料与家族**：第一遍全量 session header 建 `byPath`/`byId` 双索引（`parentSession` 是**文件路径**，按规范化路径解析，失败再从文件名抽 id 兜底；环 / 重复 id / 缺失 ⇒ unresolved ⇒ `split:"unscored"` 只进回归报告）；家族根 `sha256` 前 4 字节 mod 100 < 60 ⇒ train，否则 holdout。
- **受理确证度（confirmed/lenient）**：每个 Turn 计算 `unknownFacts`（idle/pendingMessages/topicSwitchActive/goalBusy/inFlight/sourceMode）；`sourceMode` 只认**本轮区间内原生**（去重后归属本文件）的 `pi-hud-llm-time`（≥ `HUD_TUI_GATE_SINCE`）或同 digest 的 reflex 记录——fork 复制品、会话级证据一律不算。`unknownFacts` 空 ⇔ confirmed；**晋升率只用 confirmed**，lenient 只进覆盖率统计（K11）。
- **DRX（K4）**：草案 intent 正则受 `core/draft-regex.ts` 有限语法约束（纯字面量 + 单个 `\d{1,4}` + 固定尾缀 + ≤12 alternation；解析器拒绝一切其余形状——`(a|a)+`、相邻 `+`、字符类、反向引用、lookaround 等在语法层即拒）。安全性 = 每起点 ≤12·4·3 条路径的语法论证，不依赖运行时计时器。
- **身份（K8）**：证据身份 = `lineage + templateHash`（只覆盖 port.id 与 strong/weak/exclude）；`draft.x` 改写进 catalog 时保留 `lineage:"draft.x"`，改 id 不抹掉此前的重复/纠正；改模板不升版也会分开证据。旧版本 builtin 落 `id@ver#legacy` 身份，永不与新身份合并。
- **草案文件**：`<agentDir>/reflex/drafts/*.json`，单个 `RScriptV1`（`origin:"extracted"`、id `^draft\.[a-z0-9-]+$`、requires/agreement/render 逐字段等于 `PORT_DEFAULTS[port]`、无 budgetMs、条目数 caps、正则过 DRX、例句自检 hit 全 high）；加载见 R-I13。builtin 记录**一个新字段都不写**（`portId` 由 `scriptId` 经 `portOfScript` 反查，BD11）。
- **晋升 V2（BA §4.7）**：门槛 = 回测侧（`batchValid.ok ∧ confirmed.judged ≥50 ∧ 分歧 ≤5% ∧ 评审覆盖 suspect ∧ misfire=0`）或实时侧（`live.judged ≥50 ∧ 分歧 ≤5%`）；port 可靠性按 `(portId, portVer)`，`runs ≥10 ∧ ok===runs ∧ missing===0`，`missing>0` ⇒ undetermined；零容忍（重复/纠正/跨会话重复 = 0）按身份汇总；`scanComplete:false` ⇒ 否。结论只是建议，最终认证 = catalog PR（见威胁模型）。
- **批次 / manifest / 暴露账本（K9）**：`batch freeze` 写不可变 `manifests/<hash>.json` 与 `batches/<batchId>.json`（`wx`，永不覆盖，只含 holdout 轮次的 `sha256(entryId\0at)` 键与 digest）；**展示任何留出失败明细**（suspect 行 / review / show）时自动追加 `exposure.jsonl`（只展示聚合计数不算暴露）；`batchValidity`：本批次在**其它 hash** 下被暴露过 ⇒ `exposed-then-modified` 作废，manifest 缺失 ⇒ `manifest-missing`；被拒批次转回归集。新批次须过 `admitBatch`（每个轮次晚于 `lastRevisedAt(lineage)`、digest 不在任何已暴露批次）。模板修订时间来自追加型 `revisions.jsonl`（first-seen + catalog git 提交时间取 max）。
- **上线流程（摘要）**：B3 合入后本机 `npm run build && node scripts/dev/reflex-backtest.mjs` → `generate`（无工具 port 候选用 `--assign` 人工指定，`TOOLLESS_PORTS` 不自动标注）→ 人工挑选 `drafts-out/` → `reflex.drafts.enabled=true` + `/reload` 攒 shadow 证据 → `batch freeze` → `review`（未认证记录，展示即暴露）→（若据失败修改模板 ⇒ 该批次对新 hash 作废，等新批次或实时证据）→ 人把草案改写进 `catalog.ts`（builtin id、`lineage`、升 version）→ `--promote <id> --batch <batchId>` 出身份元组 → PR → 用户批准即认证 → 用户把 id 加进 `reflex.autoResolve`。

## 性能手动测法（Tier 3，不进 CI）

- **草案失败匹配（B4）**：`tests/reflex/drafts/perf.test.ts`——S0 通过且 builtin miss 的输入 × 16 份满额草案（strong 12 / weak 8 / exclude 32）的失败匹配，1 万次记录 p99 与 max（断言 p99 ≤1 ms ×5 宽容），另含对抗输入集；**不能替代 DRX 语法证明**。
- **DRX 隔离验证（B0）**：`tests/reflex/core/draft-regex-redos.test.ts`——拒绝集只解析不执行；危险演示（`"a+"×20+"b"` × 120 个 `a`）在独立子进程硬截止下断言「被截止或 >1 s」；接受集 1,000 个 DRX 源 × 120cp 对抗输入在独立子进程断言干净退出且 <2 s。
- **回测脚本冷/热（B3）**：删 `<agentDir>/reflex/cache/` 后 `/usr/bin/time -v node scripts/dev/reflex-backtest.mjs --days 30` 记「应用缓存冷」（手动目标 ≤90 s，不保证）；随后连跑 3 次取中位数记「热」（≤3 s）；记录 manifestHash、扫描字节数、各过滤阶段计数、峰值 RSS、`uptime`。不达标只记录交主会话，不算门禁失败。

## 不变式（R-I1…R-I14）

- **R-I1** 关闭 / secure / locked / 子会话 ⇒ 零注册（`wireReflex` 不被调用，或守卫直接返回 undefined）。由 `reflex-off-golden.json` + trace 钉住。
- **R-I2** 只受理 `source==="interactive" ∧ mode==="tui" ∧ 空闲 ∧ 无图`。
- **R-I3** 从不 `sendUserMessage`、从不 `triggerTurn`、从不 `transform`；回退 = `continue`（`tests/reflex/governance.test.ts` G2/G3/G4 扫描）。AUTO 命中的唯一外发是 `pi.sendMessage({customType:"subagent:reflex"})`：全 reflex 树仅 `wire.ts` 允许出现 `.sendMessage(`，调用点必须单对象实参、无 `triggerTurn`/`deliverAs`。
- **R-I4** 只有 AUTO 脚本的 port 在预算内返回 `ok` 时才返回 `handled`；其他一切情况（含异常）返回 `continue`。
- **R-I5** shadow 不改变可观察流程：任何 await 之前同步返回 `continue`；副作用只有只读 port 执行和 `agent_settled` 时写一条 custom entry。
- **R-I6** port 只读：不联网、不写盘、不改 manager；git argv 冻结且带 `--no-optional-locks`。
- **R-I7** in-band 预算 ≤ `REFLEX_BUDGET_MS`（1200），经过 `clampSpanMs`；计时器 `unref`；shutdown 中止在飞任务、置 `disposed` 并推进 `generation`，之后迟到的 async settle 无副作用；`session_start` re-arm 后**同一闭包继续服务新会话**（PD11）。同步入口（input / agent_settled / command）不检查 `disposed`，只有 async 迟到 settle 检查 `isStale(gen)`。
- **R-I8** 所有状态都在 `wireReflex` 闭包里，不用 `Symbol.for` 全局。
- **R-I9** 输出只有 `subagent:reflex`（custom message）、`subagent:reflex-record` 与 `subagent:reflex-correction`（custom entry）三种；details 只追加字段；不写 system prompt。customType 一律 `subagent:reflex*`（I7，不用 `pi-toolkit:*`）。
- **R-I10** `src/reflex/core/**` pi-free（`tests/boundary/pi-free.test.ts` 值闭包门禁，PD3；`ports/*.ts` 同款，PD4）。
- **R-I11** 注册位置：web-hub 块之后、topic-switch 之前；topic-switch hold 或 goal 活跃时退让（S0 veto `fence-topic` / `fence-goal`）。
- **R-I12**（#25 BA §6 改写）：auto 只可能来自内置 catalog（`origin:"builtin"`）；`validateCatalog` 拒绝 `extracted` 与 `draft.*` id。草案只能在 `reflex.drafts.enabled` 下经 `validateDraft` 加载，恒为 shadow；AUTO 准入只认 `scriptById` 中的 builtin id，草案不调用状态机。rscript/1 没有 argv 种类，草案正则受 DRX 语法约束（`core/draft-regex.ts`，拒绝 = 解析器拒绝而非黑名单）。
- **R-I13**（#25 新增）：草案加载有界、no-follow、fail-closed（受信目录 0700/属主校验 → `opendir` 流式 ≤64 → 名字白名单 → no-follow fd 同 fd stat → 读 cap+1 → dev/ino 复核 → `clampSpanMs(500)` 预算），不影响内置脚本；secure/locked/子会话不可达（D8 + HOST_KEY + `secureDomainKind` 三重门）。
- **R-I14**（#25 新增）：离线评审 / 暴露 / 批次 / manifest / 修订记录都是**未认证记录**（同 UID agent 可读写任意文件）；人工认证只发生在用户批准把草案改写进 `catalog.ts` 的 PR（或用户在对话中明确确认）。运行时安全不依赖任何离线记录：草案恒 shadow，port 只读。

## 降级 / 计数语义（plan PD5、PD6、PD12）

- 脚本状态：`shadow` / `auto` / `demoted`；`demoted` 行为同 shadow，覆盖层跨会话保留到 `/reload` 或 `/reflex reset`。
- 降级触发：连续 2 次 `error|timeout`（`demoteReason:"strikes"`）；**AUTO 态下出现 repeat 或 correction 立即降级**（`"repeat"` / `"corrected"`，PD5），并 `ui.notify` 一次（中文散文，点名 `/reflex reset` 或 `/reload` 可恢复）。`uncertain` / `unavailable` 不计 strike。降级后行为同 shadow（只记账不作答），下一条 input 现读生效。
- 重复提问（PD6）：shadow 期用 `ReflexRecordV1.reasked:true` 计——同一 `requestDigest` 在 10min 内再次成为同一脚本候选。
- 纠正（PD12）：命中纠正词表时在 input 同步段**立即**写 `subagent:reflex-correction`（`ReflexCorrectionV1`，不存原文，每个目标至多一次），与该输入随后 veto / miss / 命中无关。若纠正目标是 AUTO 的 `kind:"answer"` ⇒ `onCorrected` 立即降级 + notify 一次；`memo.corrected` **只在 `appendEntry` 成功时翻转**（落盘失败则窗口保留、后续纠正可重试补账；降级以「检测到」为准照常发生）。
- 晋升门槛（U5，唯一实现 `core/promotion.ts`，R1）：同一 `scriptId@scriptVer` ≥50 条候选、port 成功率 ≥99%、分歧 ≤5%、重复提问 / 纠正 = 0。晋升只能人工改设置；只自动降级不自动升级。

## 门禁

| 门禁                                                        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/reflex-off-golden.json`（A 级）             | R0 在 dev 上**未改代码前**捕获（`PI_TOOLKIT_REFLEX_GOLDEN_CAPTURE=1`，文件存在则拒绝覆盖）；`default` / `explicit-off` / `secure` / `child` 四场景：工具表、命令表、逐事件 handler 计数、renderer 列表、system prompt、input 链结果、`subagent:reflex*` 写入数（必须 0）。永不重生                                                                                                                                                                                                                                                                   |
| `tests/fixtures/reflex-drafts-off-parity.json`（A 级，#25） | B0 在**改 `wire.ts` 之前**于 dev 上捕获（`PI_TOOLKIT_REFLEX_PARITY_CAPTURE=1`，存在即拒绝覆盖）；真 `activate()` + `reflex.enabled=true ∧ drafts 关`，冻结时钟（Date+performance）下的固定输入序列（shadow / AUTO / miss / ambiguous / 单槽替换 / correction / repeat / `/reflex status`），只记录 reflex 自身可观察面（`subagent:reflex*` entry/message、`setStatus("reflex")`、reflex notify、status 全文；序列只用同步内存 port，git 子进程的时延进不了金身）。B4 起 drafts 关闭时必须逐字节相等；基线是 B0 的固定提交（FX 门禁第二段）。永不重生 |
| `activate-trace.json`（B 级）                               | 只改 `max` 档（`trace-profiles.ts` 的 `max` 加 `reflex:{enabled:true}`），共 6 行；其余档逐字节不变。刷新：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance/activate-trace.test.ts`                                                                                                                                                                                                                                                                                                                                                        |
| `stack-teardown-matrix`                                     | FULL 档 `session_shutdown` 15→16、`session_start` 17→18（reflex shutdown abort / re-arm）；BASELINE 档不变                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setting-specs-pin.json` / `settings-corpus.json`           | 仅因新增 `reflex.enabled` / `reflex.autoResolve`（追加在末尾）/ `.reflex` 模板子树 / `reflex.drafts.enabled` / `.reflex.drafts`（#25）而重 pin；先 `captured[i].input` 取自 `origin/dev` 再生成并程序化比对                                                                                                                                                                                                                                                                                                                                          |
| pi-free 闭包                                                | `src/reflex/core/**`、`src/reflex/ports/*.ts`、`src/reflex/drafts/*.ts`（#25 新增）                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D8                                                          | `applySecureDomainOverrides` 强制 `reflex.enabled=false` 与 `reflex.drafts.enabled=false`（`tests/secure/settings-override.test.ts`）+ `wireReflex` 内 `secureDomainKind !== "plain"` 守卫（`tests/reflex/wire-skeleton.test.ts`）                                                                                                                                                                                                                                                                                                                   |
| conformance                                                 | `tests/conformance/reflex.test.ts` C-R1…C-R8（pi peer bump 必跑）：C-R1 handled 无 run；C-R2 async await / 短路 / continue 原文；C-R3 idle `sendMessage` 为 user 角色上下文；C-R4 `appendEntry` 不进上下文；C-R5 无 source 的 `prompt()` 报 interactive；C-R6 引用 `topic-switch-hop.test.ts` S5（`it.todo` + 存在性断言）；C-R7 TUI 主循环串行（`mode.run()` 在 init 之上启主循环，真实 `InteractiveMode`）；C-R8 `ctx.mode` TUI 为 `"tui"`、SDK 不是                                                                                               |

## 晋升流程（plan §7）

1. R0 → (R1 ∥ R2a) → R2a′ → R2b 合入 ⇒ 用户本机 `reflex.enabled=true` + `/reload`（`autoResolve` 为空 ⇒ 全部 shadow）。
2. R3a ∥ R3b 合入（不改变 shadow 行为）。
3. shadow 约 2 周 ⇒ `npm run build && node scripts/dev/reflex-shadow.mjs --days 14`（R3b，详见下节）。
4. 对 `eligible` 的脚本人工抽查 diverge 样本，**由用户**把 id 加进 `reflex.autoResolve`（live）。建议顺序：`quota.summary`、`jobs.list` → `fleet.status` → `git.status`。
5. 晋升后任一 error/timeout×2、repeat、correction ⇒ 自动降回 shadow；`scriptVer` 变更 ⇒ 统计重新从 0 计。

### 跨会话离线报告（R3b）

`npm run build && node scripts/dev/reflex-shadow.mjs --days 14`：只读、离线、逐行扫描
`$PI_CODING_AGENT_DIR/sessions`（未设置时 `~/.pi/agent/sessions`）；`--cwd <path>` 仅扫描该工作区会话目录，
`--json` 输出机器可读统计。记录/纠正按 `at`、AUTO answer 按会话 entry 的 `timestamp` 进入时间窗口。
每个 `scriptId@scriptVer` 单独汇总；shadow 候选与 AUTO answer 都参与跨会话重复判定，
纠正从独立 `subagent:reflex-correction` 条目累计，不依赖下一条候选。

报告包含 `reasked / crossSessionRepeats / corrected`、成功率、分歧率、p50/p95 与晋升原因；
缺少重复判定证据显示 `undetermined`（JSON 为 `null`），不能晋升。
`diverge` 样本仅列 session 文件与 entry id，不输出正文；`eligible` 仅表示统计门槛通过，
仍须用户人工抽查，再由用户把脚本 id 加入 `reflex.autoResolve`（live）。脚本不会修改设置或自动晋升。
缺 dist 时提示“先 npm run build”并退出 2；真实目录没有 reflex 条目时输出空结果，不虚构晋升依据。

使用注意：`--cwd` 的值经 `path.resolve` 直接使用，**不做 `~` 展开**——必须传绝对路径
（写 `--cwd ~/x` 会被当成 cwd 下的字面量 `~` 目录）。脚本是 **Tier 3 手动工具**（不进 CI，也不属
`npm test`），且从 `dist/reflex/core/{shadow-scan,promotion}.js` 加载冻结的 promotion API，
因此每次改完 `src/reflex/**` 都要先 `npm run build` 再跑，否则 exit 2。

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
