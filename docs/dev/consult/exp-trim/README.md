# 实验 6：consult fork 裁剪早期工具输出——价值与质量影响

> **预注册**（写于任何数据产生之前）：2026-09-25T21:14+08:00（目录 mtime 21:14:08；Part A 首次运行 21:16）。
> 本节（§0–§6）在看到任何 Part A / Part B 数据后**不得修改**；后续补充只能以带时间戳的新节追加
> （§7 E-code 题目集、§8 臂的最终选择都必须在跑 Part B 之前追加）。

## 0. 问题

consult 现为 B 形态：fork 专家持久化会话 → 以只读工具（read/grep/find/ls）续跑短 run 作答。工具块与专家不同 ⇒
首请求整段按写入单价重写。拟议优化：fork 时把**较早、较大的工具输出**替换为占位，其余（user 消息、assistant 文本、
工具调用参数、最近 K 轮完整内容、小工具结果）保留；toolCall/toolResult 成对保留（只替换 toolResult 的内容）。

- **Q1 价值**：裁剪能省多少首请求 token / 美元？
- **Q2 影响**：回答质量是否下降、是否编造、专家是否需要重读；重读的轮次/成本/时延会不会吃掉节省、会不会撞生产上限（150s / maxTurns=3）？

## 1. 裁剪规则（Part A 模拟与 Part B TRIM 臂共用同一实现）

- 上下文 = `SessionManager.open(file).buildSessionContext().messages`（即真正发给模型的消息序列）。
- **轮** = 一条 assistant 消息（一次 LLM 调用）。受保护集合 = 上下文中**最后 K=2 条 assistant 消息**，以及回答它们的 toolCall 的 toolResult。
- **T1**：估算 token > 1000 且不受保护的 toolResult → 占位。
- **T2**：所有不受保护的 toolResult → 占位。
- **T3**：T1 + 删除除最后一条 assistant 以外所有 assistant 消息里的 thinking 块。
- 占位文本（替换 toolResult 的全部 content，`isError`/`toolCallId`/`toolName` 不变）：
  `[elided by consult fork: <L> lines / ~<T> tokens of <toolName> <参数预览≤120字符> output — re-read with the read tool if you need the exact content]`
- token 估算：每会话一个 chars→tokens 比例 r（§2 校准）；占位本身的 token 计入裁剪后的上下文。

## 2. Part A：离线测算（零 LLM 调用）

**样本**：`~/.pi/agent/sessions/**` 中被**另一个会话**的 `subagent:run` 条目以 `diag.sessionFile` 引用、且该条目 `status=completed`
的会话文件（⇒ 子 agent 会话，排除主会话）；排除 `~/.pi/agent/cache/consult-sessions/` 下的 consult fork、含 `compaction`
条目的会话、上下文不在 30k–300k token（按最后一条 assistant 的 prompt token）者。按 agent 类型分层，每类型最多 5 个，
类型内按上下文大小分档（30–60k / 60–120k / 120–300k）轮流取，按文件名排序确定性选取，目标 ≥20 个、≥4 种类型。

**校准**：P(msg) = assistant 消息 usage 的 `input + cacheRead + cacheWrite`（三者都算，防漏算缓存）。
r = (P_last − P_first) / chars(第一条 user 消息之后、最后一条 assistant 之前的上下文消息)；
system+工具定义开销 O = P_first − r × chars(第一条 user 消息)。thinking 块是否被回传因 provider 而异：每会话算两个候选
（计入 / 不计入 thinking 字符），取「逐轮 ΔP 预测误差（MAPE）」更小者，并报告选择与误差。若选定「不计入」，该会话 T3 节省记为 0。

**首请求模型**：consult 首请求 token ≈ O + 上下文消息 token + 提问（固定按 400 token 计）。节省比例 = (裁剪前 − 裁剪后) / 裁剪前。
美元按 opus 级写入单价 **$6.25/M**（B 形态全量写入）折算。另报「只计消息部分」的节省比例。

**输出**：`part-a.tsv`（逐会话：类型、模型、上下文、r、O、各类别 token（user / assistant 文本 / thinking / toolCall 参数 / toolResult）、
T1/T2/T3 节省比例与美元）+ 本 README 汇总（中位数 / P90）。

## 3. Part B：在线质量对照

### 3.1 臂

- **FULL**：现行 B 形态——完整 fork + 只读工具（read/grep/find/ls）。
- **TRIM**：FULL + T1 裁剪。**例外**：若 Part A 中 T1 节省中位数 < 25% 且 T2 中位数 ≥ T1 中位数 + 15 个百分点，改用 T2（须在跑 Part B 前追加 §8 记录）。
- 两臂共同：模型 = 专家原会话模型（`cloudrouter-*` → `cr-*`）；thinking = 原会话 `thinking_level_change`；system prompt =
  专家 agent 类型的 replace 正文（E-doc 用存档 `docs/dev/fabric-v2/exp5/upstream-analyst.md`，E-code 用 `~/.pi/agent/agents/<type>.md`）；
  扩展全部禁用（避免 project memory 注入成为专家知识）；工具 = read/grep/find/ls；
  prompt = `src/consult/prompt.ts#buildConsultPrompt({question, maxAnswerChars: 2000, budgetNote: false})` 逐字。
  TRIM 臂在 prompt 末尾追加一行：`Note: some earlier large tool outputs in your history were elided to placeholders; before citing their exact content, re-read the file with the read tool.`
- fork = 源会话文件复制到 `/tmp/exp6-forks/`（源文件 sha256 前后校验不变），TRIM 在副本上改写 toolResult；用完删除。
- 生产上限：**不截断**，让每次跑完（安全上限 8 轮 / 600s），但标记 `>150s` 或 `>3 轮`（「生产中会被截断」）。

### 3.2 E-doc（知识在工具输出里，最坏情况）

- 专家：实验 5 被真实请教过的 3 个 upstream-analyst 会话（`--tmp-exp5-repo--/` 下 `03-27-04-794Z`、`03-27-10-800Z`、`03-48-14-477Z`），
  **截断到原任务最终回复为止**（去掉实验 5 续写进去的请教问答，否则专家上下文里已有答案）。第 i 次重复用第 i 个专家，两臂配对（每臂 n=3）。
- cwd `/tmp/exp5-repo`（`git archive 14e28c0` 重建）。**源文件可用条件**：按实验 5 setup 把 `plan.md`（仓库 `docs/dev/fabric-v2/plan.md`，
  自实验 5 前未改动）与 `brief-A.md` 还原到原路径 `/tmp/.p5x/`（模拟生产中专家读过的文件仍在），实验后删除。
- 题目：`docs/dev/fabric-v2/exp5/consult-qa.md` 中 e1-r1 的提问原文（10 问合为 1 条）。
- 评分（盲评，§4）：对照 `exp3/judge-rubric.md` 的 7 条决策，每条判「正确（回答明确给出与决策一致的表述）/ 错误（与决策矛盾，
  自相矛盾按错误）/ 未涉及」，正确计 1 分（满分 7）；另判：
  ① **作废 urgent 当现行**（是/否：把 urgent/优先级标记当作现行设计，而非「已作废」）；
  ② **编造数**：对照参考文档（plan.md 全文随评审 prompt 提供）找不到依据的具体断言（章节号、引文、字段名、数值）的条数。
- 评审对象为**未截断**的完整回答；另记录字符数与是否会被生产 2000 字符硬截断。

### 3.3 E-code（典型探索专家）

- **选取规则**（在 Part A 之后、Part B 之前执行，结果追加 §7）：从 Part A 样本中选 2 个会话，条件：类型属于代码探索/验收/评审类
  （Explore / verifier / reviewer / general 中做探索的）、上下文 40k–150k、T1 消息部分节省 ≥ 40%、会话读过的仓库文件自会话结束后
  在工作树中未改动（git log + git status 检查）、按原模型估算 6 次运行总成本 ≤ $5、内容与本实验无关；满足者中取 T1 节省最大且类型不同的两个。
- 每会话 5 个事实题，**题目与标准答案在跑 Part B 前追加 §7**：3 题答案只出现在会被 T1 省略的早期工具输出里（文件:行号、函数名、字段），
  2 题答案在 assistant 结论文本里（不会被省略）。
- 评分：逐题「正确 / 部分 / 错误 / 编造」（编造 = 给出标准答案与会话中都不存在的具体细节并当作事实陈述；说「不确定」算错误不算编造）；
  正确 = 1、部分 = 0.5，满分 5。每会话每臂 n=3（共 12 次）。

### 3.4 记录

首请求 input / cacheWrite / cacheRead token；每轮 usage 与总成本（pi 按路由单价计算的 `usage.cost.total`）；
另按 opus 单价（input 5 / output 25 / cacheRead 0.5 / cacheWrite 6.25 $/M）折算「opus 等价成本」以便与 Part A 可比；
轮数、工具调用（重读了哪些文件）、墙钟时长、是否 >150s / >3 轮。

## 4. 盲评

所有回答随机重命名（映射表单独保存，评审看不到臂别），交两位独立评审：`cr-anthropic/claude-sonnet-5` 与 `zai/glm-5.3`。
每位评审对同一专家类别的全部回答在一个 prompt 中评分（E-doc 6 份一批；E-code 每会话 6 份一批）。
每份回答分数 = 两位评审均值；报告逐条一致率。评审用 pi SDK 无工具会话实现（`scripts/exp/exp6-judge.ts`）。

## 5. 判据（预注册）

- **价值**：Part A T1 首请求 token 节省中位数 ≥ 50% ⇒ 值得；< 25% ⇒ 不值得；之间 ⇒ 边际。
- **质量可接受**：E-doc 与 E-code **各自**满足 TRIM 均分 ≥ FULL 均分 − 0.5，且编造数（两评审均值，按臂求和）TRIM ≤ FULL。
  E-doc TRIM 若出现「作废 urgent 当现行」≥ 1 次（任一评审标出且执行者人工复核确认）⇒ **严重回归**（质量不可接受）。
- **综合**：
  - 质量可接受 **且** TRIM 含重读的平均总成本 ≤ FULL 的 60% **且** 生产上限（≤150s 且 ≤3 轮）内完成率 TRIM ≥ FULL ⇒ **建议实现**
    （若只有一类专家满足成本条件 ⇒ 建议按专家类型开）；
  - 质量可接受但 TRIM 总成本节省 < 20% ⇒ **不建议**；
  - 质量不可接受 ⇒ **不建议**（至少不按该规则）；
  - 其余情形 ⇒ **不下结论**，报告缺什么证据。
  - 成本比较以「opus 等价成本」为主（与 Part A 口径一致），路由实价为辅。

## 6. 约束与污染规则

- 在线总花费上限 **$25**（含评审），每次调用后累计，超限立即停止并如实报告；≤4 并发。
- 专家运行中若读取 `~/.pi/agent/{sessions,memory,agents}`、其它 `/tmp/exp*` 或 `/tmp/w*` 目录 ⇒ 该轮标记污染、不计分（如实报告）。
- 产品代码零改动；脚本 `scripts/exp/exp6-*.ts`；中间文件 `/tmp/exp6-*`；fork 副本用完删除；不写任何密钥。

## 7. E-code 专家与题目集（追加于 2026-09-25T21:22+08:00，Part A 之后、Part B 之前）

### 7.1 选取规则的一处修订（在任何 Part B 数据之前，如实记录）

§3.3 的「会话读过的文件自会话结束后在工作树中未改动」在实际样本上几乎无人满足（`scripts/exp/exp6-select-ecode.ts` 输出：
19 个同类型候选中只有 1 个通过，且它是实现任务、不读文件，不是探索/验收专家）——被选仓库（apistrike、bunker）此后一直在开发。
该条件的目的是「专家在 fork 里重读时看到的内容与它当初看到的一致」。改用一个**更强且可验证**的等价条件：

- 以会话所见的提交 `git archive` 到 `/tmp/exp6-snap-<repo>-<commit>`，会话内**每一个 read 结果都必须与快照逐行一致**
  （`scripts/exp/exp6-snapshot-verify.ts`）；
- fork 副本里把仓库绝对路径改写为快照路径、cwd 设为快照（两臂完全相同的改写，改写在 TRIM 裁剪之前）。

其余条件（类型、上下文 40k–150k、T1 消息部分节省 ≥ 40%、6 次估算 ≤ $5、与本实验无关）不变；在满足者中按 T1 节省降序、类型不同取两个：

| 专家                                                   | 会话                                                                   | 模型                         | 上下文 | T1 消息部分节省 | 快照                                           | read 一致 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------- | ------ | --------------- | ---------------------------------------------- | --------- |
| EC1（Explore：apistrike seed→mutator→runner 链路调查） | `--home-bluecake-ai-apistrike--/2026-09-21T07-38-13-933Z_…b1bb9ce87`   | cr-anthropic/claude-sonnet-5 | 93.6k  | 70.9%           | `70dbf25`（会话内 `git log` 所示 master HEAD） | 19/19     |
| EC2（verifier：apistrike 修复包 R 验收）               | `--home-bluecake-ai-apistrike--/2026-09-21T08-37-21-619Z_…b384ad5e7e3` | cr-anthropic/claude-sonnet-5 | 69.9k  | 66.4%           | `55e1bfe`（验收后提交的同一改动）              | 3/3       |

（排在 EC1 之后的 Explore `…933Z` 同批的 `…932Z` 因类型相同不取；EC2 的 bash 输出——git diff、go test——在 fork 里无法用只读工具重现，这正是「知识在不可重读的工具输出里」的真实情形。）

### 7.2 题目与标准答案（评分只以此为准）

标注：〔T1 省略〕= 答案只出现在 T1 会省略的早期工具输出里；〔可重读〕= 快照里能用 read/grep 找回；〔不可重读〕= 只在 bash 输出里；〔结论〕= 在 assistant 最终报告里（不会被省略）。
已用 `exp6-dump.ts` 生成的「T1 可见部分」核对：〔T1 省略〕题的关键答案串在 T1 可见部分中不出现。

**EC1**（问题合为一条 prompt，按编号作答）

1. 〔T1 省略·可重读〕mutator 包的 `Placement` 类型定义了哪几个取值？
   标准：5 个——`value`、`name`、`header`、`body`、`path`（`PlacementValue/Name/Header/Body/Path`）。部分：列出 ≥3 个且无虚构取值。
2. 〔T1 省略·可重读〕runner 给每个请求加的追踪 header 叫什么？值由哪个函数、怎么生成？
   标准：`X-ApiStrike-Trace`；`newTraceID()` 生成 8 个随机字节的 16 位 hex（rand 失败时退化为 `"00000000"+时间`，提到与否不影响）。部分：header 名或函数名二者对一。
3. 〔T1 省略·可重读〕按 `docs/design.md`：L2 Sink 探针把命中上报到 ApiStrike 的哪个 API 端点？L3 OOB 的 DNS 监听端口是多少？
   标准：`POST /api/v1/sinks/report`；DNS listener `:8053`（用户自行把 53 转发到 8053）。部分：二者对一。
4. 〔结论〕你列的 P0-1 是什么问题？定位在哪个文件哪一行？
   标准：`DictionaryMutator.Mutate` 的 payload 游标 `cursors` 是局部变量，每次调用重置为 0；runner 反复把同一 seed 重新入队 ⇒ 每参数只用 corpus 前几条 payload 且无限重复；`internal/mutator/dictionary.go:91`。部分：问题对、行号缺失或错。
5. 〔结论〕`SchemaMutator` 在生产链路里有没有被用到？依据是什么？
   标准：没有；`cmd/apistrike/main.go:224` 只 `NewDictionaryMutator`；且 SchemaMutator 是唯一读 KnowledgeBase 的 mutator（`schema.go:40`），故反馈学习闭环失效。部分：结论对、依据缺失。

**EC2**

1. 〔T1 省略·可重读〕审计报告里 P1-1 是什么问题？证据定位在哪些文件:行号？
   标准：finding 落库静默丢弃——`SaveFindings` 批内一条失败即 return err 中断整批，runner 侧 `_ =` 吞掉错误；证据 `runner/runner.go:623`、`manager/manager.go:449-461`。部分：问题对、行号缺失或错。
2. 〔T1 省略·**不可重读**〕你跑 `go test -count=1 -run 'Baseline' ./internal/detect/ ./internal/runner/ -v` 时，`internal/runner` 包通过了几个测试？该包耗时多少？
   标准：7 个（`TestRunnerBaselineWiresStatusDiffTiming`、`…DisabledProducesNoBaselineFindings`、`…EndpointKeyIncludesMethod`、`TestRunnerFeedsBaselineBeforeMutations`、`TestRunnerBaselineDisabledWithNegativeSamples`、`TestRunnerBaselineOncePerEndpoint`、`TestRunnerSkipsBaselineWhenEngineLacksFeeder`）；`ok … 2.550s`。部分：二者对一。明确说「记不清/无法从现有信息确认」= 错误（非编造）；给出具体但错误的数字或测试名 = 编造。
3. 〔T1 省略·可重读〕`BaselineFeeder.FeedBaseline` 的方法签名是什么？单个基线请求 HTTP 失败时 `ensureBaseline` 怎么处理？
   标准：`FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`；单请求失败 ⇒ 中止该 endpoint 的基线阶段（视为 endpoint 可能已死，交给变异循环暴露），不致命；只有 ctx 取消才返回 error。部分：二者对一。
4. 〔结论〕你的总体验收结论？有无 Blocker / Major？Minor 是什么？
   标准：通过；Blocker 无、Major 无；Minor 两条：path 参数 endpoint 的 baseline key 不匹配（已知、如实注释）；baseline 请求过限速但不计入 MaxRequests/sent 预算。部分：结论对、Minor 缺一或错。
5. 〔结论〕真实 runner 集成测试里各检测器产出的 finding 数分别是多少？
   标准：`map[diff:17 status:17 timing:1]`。部分：两项对。

## 8. 臂的最终选择（追加于 2026-09-25T21:22+08:00，Part B 之前）

Part A：T1 首请求节省中位数 38.1%（≥ 25%）⇒ §3.1 的 T2 例外不触发，**TRIM = T1**，K = 2。

---

## 9. 结果（追加于 2026-09-25T21:45+08:00；§0–§8 未改）

原始数据：`part-a.tsv` / `part-a-summary.json`（Part A）；`part-b.tsv` / `part-b-summary.json` / `judge-scores.tsv` /
`judge-map.json` / `answers.md` / `raw/{runs,judge}/`（Part B）。重跑：`npx tsx scripts/exp/exp6-part-a.ts`；
`EXP6_RUNS=docs/dev/consult/exp-trim/raw/runs EXP6_JUDGE=docs/dev/consult/exp-trim/raw/judge npx tsx scripts/exp/exp6-analyze.ts`
（两者都已验证重跑逐字节一致）。**在线总花费 $5.05**（18 次专家运行 $3.88 + 6 次评审 $1.17），远低于 $25 上限。零越界读取（18/18 `leakCalls=0`），源会话 sha256 前后一致。

### 9.1 Part A：离线测算（59 个子 agent 会话，12 种类型，上下文 31.5k–247.7k，中位 77k）

校准：逐轮 ΔP 预测的中位绝对误差 12.5%；工具结果占首请求 token 的中位 49%。

| 规则                                     | 首请求节省 中位 | P10   | P90   | 只计消息部分 中位 | 美元节省/次（$6.25/M）中位 | P90   | 均值  |
| ---------------------------------------- | --------------- | ----- | ----- | ----------------- | -------------------------- | ----- | ----- |
| **T1**（>1k 且非最近 2 轮的 toolResult） | **38.1%**       | 19.1% | 57.5% | 48.4%             | $0.19                      | $0.44 | $0.26 |
| T2（所有非最近 2 轮的 toolResult）       | 44.3%           | 25.3% | 66.6% | 60.1%             | $0.22                      | $0.50 | $0.29 |
| T3（T1 + 丢非末轮 thinking）             | 50.4%           | 28.9% | 67.4% | 66.7%             | $0.25                      | $0.60 | $0.32 |

按上下文档：T1 中位 30–60k 32%（$0.10）/ 60–120k 38%（$0.22）/ 120–300k 44%（$0.48）。按类型：Explore 54%、upstream-analyst 42%、
Plan 42%、reviewer 39%、verifier 36%、general 27%、architect 23%、frontend-dev 24%、general-purpose 19%（每类 n=4–5）。

### 9.2 Part B：行为与成本（每专家每臂 n=3）

「opus 等价」按 §3.4 的逐 token 类别单价折算（与 Part A 同一口径）；「路由实价」= pi 按实际路由单价计的 `usage.cost.total`。

| 组              | 首请求 token  | 首请求 opus 等价 | 含重读总成本 opus 等价 | 路由实价       | 轮数 | 工具调用 | 墙钟 均/最大 | >150s | >3 轮 | 生产上限内完成 |
| --------------- | ------------- | ---------------- | ---------------------- | -------------- | ---- | -------- | ------------ | ----- | ----- | -------------- |
| E-doc FULL      | 55.6k         | $0.36            | **$0.361**             | $0.092         | 1.0  | 0        | 75s / 79s    | 0     | 0     | 3/3            |
| E-doc TRIM      | 30.2k（−46%） | $0.17            | **$0.406（113%）**     | $0.120（130%） | 5.0  | 5.0      | 90s / 115s   | 0     | **3** | **0/3**        |
| EC1 FULL        | 96.2k         | $0.62            | $0.618                 | $0.371         | 1.0  | 0        | 18s / 22s    | 0     | 0     | 3/3            |
| EC1 TRIM        | 46.7k（−51%） | $0.30            | $0.415（67%）          | $0.249         | 3.0  | 5.0      | 27s / 37s    | 0     | 1     | 2/3            |
| EC2 FULL        | 61.0k         | $0.39            | $0.395                 | $0.237         | 1.0  | 0        | 14s / 18s    | 0     | 0     | 3/3            |
| EC2 TRIM        | 36.3k（−40%） | $0.23            | $0.372（94%）          | $0.223         | 3.0  | 4.3      | 31s / 45s    | 0     | 1     | 2/3            |
| **E-code FULL** | 78.6k         | $0.51            | **$0.506**             | $0.304         | 1.0  | 0        | 16s          | 0     | 0     | 6/6            |
| **E-code TRIM** | 41.5k（−47%） | $0.27            | **$0.394（78%）**      | $0.236         | 3.0  | 4.7      | 29s          | 0     | 2     | **4/6**        |

- **FULL 9/9 次都是 1 轮、0 次工具调用就作答**（consult prompt 的「能不调工具就别调」完全生效）；**TRIM 9/9 次都去重读**。
- 首请求确实省了 40–51%（与 Part A 同一会话的离线估算 38–53% 吻合），但重读的轮次把节省吃掉大半：E-code 只剩 22%，
  E-doc 反而**贵 13%**（glm 高 thinking 下每多一轮都要重新产出推理 token）。
- 所有超 3 轮的运行（E-doc 3/3、E-code 2/6），**最终答案都出在最后一轮**——生产中第 4 轮开始即被 turn_cap 中止，拿不到答案。
  墙钟没撞 150s（最长 115s），但 E-doc TRIM 离上限只剩 35s。

### 9.3 盲评（两评审逐条一致率 97/102 = 95%；E-doc 38/42，E-code 59/60）

| 组              | 均分（sonnet / glm）       | 编造（两评审均值，按臂求和） | 作废 urgent 当现行 | 回答字数 |
| --------------- | -------------------------- | ---------------------------- | ------------------ | -------- |
| E-doc FULL      | **6.50** / 7（6.0 / 7.0）  | 2.5                          | 0 / 3              | 2404     |
| E-doc TRIM      | **6.83** / 7（6.67 / 7.0） | 4.0                          | 0 / 3              | 2548     |
| EC1 FULL        | 5.00 / 5                   | 0                            | —                  | 1290     |
| EC1 TRIM        | 4.75 / 5                   | 0.5                          | —                  | 1444     |
| EC2 FULL        | 5.00 / 5                   | 0                            | —                  | 1282     |
| EC2 TRIM        | 4.00 / 5                   | 2.0                          | —                  | 1480     |
| **E-code FULL** | **5.00** / 5               | 0                            | —                  | —        |
| **E-code TRIM** | **4.375** / 5              | **2.5**                      | —                  | —        |

执行者人工复核（逐条核对原文与快照，结论与评审一致）：

- **EC2 Q2（答案只在 go test 输出里、不可重读）**：FULL 3/3 答对（7 个测试、`2.550s`）；TRIM 0/3——一次如实说「无法核实」，
  两次**编造**了耗时（`1.266s`、`约 1.2~1.3s`），其中一次还捏造了测试名 `TestRunnerBaseline` 并把个数说成「3–4 个」。
- **EC1 Q2（可重读）**：TRIM r2 用 grep 找回了 `runner.go:551` 的 header 设置行，却没看到上一行 `traceID := newTraceID()`，
  于是把 traceID 错接到了 `marker.Generate()`（`runner.go:513`）——**部分重读导致的张冠李戴**，比不知道更糟。
- **E-doc**：TRIM 均分反而略高，差异全在 D7（sonnet 判 FULL 3/3「未涉及」nack，TRIM 重读 plan.md 后 2/3 提到了）；
  两臂都 0 次把作废 urgent 当现行。E-doc 的「编造」多为细节口径（如「mailbox 硬编码分支 4 处」两臂都出现、原文处置后为 3 处）；
  剔除两条明显的评审误判（glm 把真实存在的 `/tmp/.p5x/plan.md` 路径、以及来自仓库 AGENTS.md 的规则当成编造）后，FULL 1.5 vs TRIM 3.0，方向不变。

### 9.4 按预注册判据判定

| 判据                                                        | 结果                                                                   | 判定              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| 价值：T1 首请求节省中位数 ≥ 50% 值得 / < 25% 不值得         | 38.1%                                                                  | **边际**          |
| 质量·E-doc：TRIM ≥ FULL − 0.5 且编造不增加；urgent 误用 = 0 | 6.83 ≥ 6.0 ✓；编造 4.0 > 2.5 ✗；urgent 0 ✓                             | ✗                 |
| 质量·E-code：TRIM ≥ FULL − 0.5 且编造不增加                 | 4.375 < 4.5 ✗；编造 2.5 > 0 ✗                                          | ✗                 |
| ⇒ 质量可接受？                                              | 两类都不满足                                                           | **不可接受**      |
| 综合：含重读总成本 ≤ FULL 60%                               | E-code 78%、E-doc 113%                                                 | ✗                 |
| 综合：生产上限内完成率 TRIM ≥ FULL                          | E-code 4/6 vs 6/6，E-doc 0/3 vs 3/3                                    | ✗                 |
| **结论**                                                    | 质量不可接受（§5：⇒ 不建议）；且含重读的总成本节省 < 60%（E-doc 为负） | **不建议实现 T1** |

### 9.5 解读

1. **裁剪省下的是首请求，但把专家从「凭记忆一次答完」变成了「先去重读再答」。** FULL 下专家 9/9 次零工具调用作答；
   TRIM 下 9/9 次重读，平均多 2–4 轮。首请求省 40–51%，含重读的总成本只省 22%（E-code）甚至多花 13%（E-doc）。
   B 形态的首请求虽然全量写入，但后续轮次读缓存很便宜——**真正贵的是多出来的轮次（每轮的输出/思考 token 和新增写入）**。
2. **质量损失集中在「不可重读」和「部分重读」两类知识上。** bash 输出（go test、git diff）在只读 fork 里找不回，
   专家在「被告知已省略」的情况下仍有 2/3 次给出了具体但错误的数字；可重读的内容，grep 式的局部重读也会漏掉关键的相邻行。
   FULL 的专家没有这些问题（E-code 6/6 满分，零编造）。
3. **撞上限才是生产里的致命问题。** consult 的 maxTurns=3 是按「专家凭上下文作答」设计的；TRIM 专家有 5/9 次需要 4–7 轮，
   生产中会在第 4 轮开始时被截断、拿不到最终答案。要让裁剪可用，必须同时放宽轮次上限——那又会进一步抬高成本与时延。
4. **Part A 的节省本身也只是「边际」**：中位 38%、每次首请求约省 $0.19（opus 写入价）；按上下文 120k+ 才接近 44% / $0.48。

**推荐的默认规则：不裁剪（维持现行 B 形态的完整 fork）。** 本实验不支持 T1/T2/T3 中任何一个作为默认；K=2 的保护窗口也不够。
如果将来还想压首请求成本，更有希望的方向是（均未经本实验检验）：

- 只丢 thinking（T3 的增量部分）：不删除任何事实内容，不诱发重读；但要先确认各路由是否本来就不回传历史 thinking
  （Anthropic 在新 user 轮会自行剥离，Part A 的 T3 增量在这类路由上可能不存在）；
- 只省略**可重读且极大**的 read 结果（如 > 8k token），bash/grep 输出一律保留，并且不在 prompt 里提示「请重读」；
- 或把省下的预算换成「首请求更便宜的模型」而不是删上下文。

### 9.6 局限

- n 小：每专家每臂 3 次，E-doc 3 个专家、E-code 2 个专家；E-code 的 FULL 全部满分（天花板效应），差异只来自少数题。
- 样本选择：E-code 两个专家都来自 apistrike、同一模型（sonnet-5）；E-doc 只有 glm-5.3。其它路由（gpt-5.6 / kimi / opus）未测。
  E-code 选取条件做过一处预先记录的修订（§7.1：「文件未改动」→「快照逐行一致 + 路径改写」），路径改写对两臂相同。
- 题目设计偏向检验裁剪：E-code 每专家 5 题里 3 题的答案特意放在会被省略的工具输出里；真实提问里这类题的比例未知。
- 单价假设：Part A 与「opus 等价」都用 opus 单价（写入 $6.25/M）；glm 路由不报告 cacheWrite，其未缓存输入按 input $5/M 计；
  若把未缓存输入也按写入价计（`part-b.tsv` 的 `totalOpusB` 列），E-doc 为 FULL $0.429 vs TRIM $0.463，结论不变。
- Part A 的 thinking 是否回传按「逐轮 ΔP 误差更小」逐会话判定；Anthropic 路由在 consult 的新 user 轮会剥离历史 thinking，
  因此这些会话的 T3 增量与首请求基数可能被高估。
- 评审之一（glm-5.3）同时是 E-doc 的被试模型；E-doc 的编造判定有评审误判（已在 §9.3 做剔除敏感性分析）。
- 生产截断是按「超 3 轮 ⇒ 最终答案在第 4 轮之后」推断的，本实验没有真的在第 4 轮截断，未记录中间轮次的文本。
