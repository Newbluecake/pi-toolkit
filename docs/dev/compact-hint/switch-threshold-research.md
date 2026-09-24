# switch_context 触发阈值研究

> 研究范围：只读分析 pi 会话日志、`models.json`、`traffic.db`、现有源码和设计文档；本报告不改变 `src/` 或 `~/.pi/`。分析脚本在生成报告后删除。

## 结论摘要

最小化“缓存读成本 + 固定切换成本”的连续模型确实给出：

\[
C^* = S_0 + \sqrt{\frac{2Kg}{r}}
\]

其中 `C` 是切换前上下文 token 数，`S0` 是切换后首轮起点，`g` 是每轮上下文增长，`r` 是每个上下文 token 的 cache-read 价格，`K` 是一次切换相对于继续运行的固定成本。这个形式在 `K` 与 `C` 近似无关、价格没有跨档时严格成立；真实系统还要在 TTL、分档价格、闲置概率和质量惩罚下做分段候选比较。

本机历史数据的主信号不是“等到 88% 再切”：

- 全部 `~/.pi/agent/sessions/`：4,658 个 JSONL 会话、约 2.49 GB、2026-04-30 至 2026-09-24；235,572 条带 usage 的 assistant 消息。
- 主会话 4,090 个，子 agent 568 个。子 agent 作为不主动切换对照，context 增长中位数 719 token/轮、P90 4,018；主会话为 779/P90 4,223。
- 真实 `switch_context` 工具调用 5 次，其中 4 次有可完整关联的压缩后 usage；4 次均为 1M 窗口 Claude 会话，触发点为 395,862、424,489、446,421、483,138 token，即 39.6%--48.3%。切换后首轮 `S0` 为 92,501--101,535 token。
- 所有压缩条目 125 次：可识别为 `compact_context` 的 21 次、自动压缩 103 次、hook 交接 4 次；119 次能看到压缩后首轮 usage。已知窗口的 46 次压缩触发上下文中位数为 261,208 token、P90 459,819，比例中位数 46.1%、P90 95.6%。这说明现有真实工作流集中在约 40%--50% 附近，但样本中自动压缩、旧模型别名和不同窗口混在一起，不能把 46.1% 当成普适最优常数。
- 纯成本模型在代表性参数下的 `C*` 通常约为 120k--161k（1M 窗口的 11.5%--16.1%）；这明显早于 500k/50% 或 75% hint。原因是每轮都为长前缀付 cache-read，而切换首轮成本只有约 $0.3--$0.5。这个结论只适用于“交接质量损失和再发现风险已经计入 K”的成本口径；若漏算质量风险，公式会过早触发。
- 实际建议：不要直接把纯成本 `C*` 作为用户可见阈值。用 `C*` 作为下界候选，再加模型/任务质量上限、最小冷却、`S0`/`g` 在线 EWMA 和 TTL 状态。初始落地可把主会话 hint 放在 `max(C*, 35%W)` 到质量上限之间；对目前记录中的 1M Claude 主力，会落在约 40%--50%，与真实 4 次 `switch_context` 事件一致。force 仍必须低于 pi 自动压缩保留线，作为安全网，而非成本最优线。

> 注意：当前仓库 HEAD 的 `src/compact-hint/threshold.ts` 实际常量是 `DEFAULT_HINT_THRESHOLD_PERCENT = 75`，不是背景描述中的 50；`settings.json` 当前未设置覆盖。若运行环境显式配置了 50%，下面按 50% 对照；若采用源码默认，则绝对 500k hint 线仍可能先触发。

## 1. 现有实现边界

已读模块和文档：

- `src/compact-hint/threshold.ts`：hint/force 百分比、绝对 token 线、非线性 tick、窗口缩放。
- `src/config/settings.ts`：默认 `hintThresholdPercent=75`、`forceAtPercent=88`、`hintThresholdTokens=500`（500k）、`forceAtTokens=0`、`forceScaling=true`。
- `src/context-switch/` 和 `docs/dev/context-switch/context-switch-plan.md`：`switch_context` 写交接、由 `session_before_compact` 接管摘要；`keep_recent=false` 用哨兵丢掉旧历史，默认保留最近上下文。
- `src/cache-ttl/` 与 `docs/dev/cache-ttl-adaptive/`：5m/1h 缓存、保活、自适应升级、entry fee、尾巴重写和熔断。

force 缩放的现状是：以 1M 窗口的 88% 为锚点，每缩小一个数量级提高 5 个百分点，再受 reserve cap 限制，文档示例为 1M→88、200k→91、37k→95。它解决“不同窗口下留出近似绝对余量”的安全问题，不是价格最优算法。

## 2. 成本模型推导

### 2.1 固定 K 时的严格推导

设一次切换后上下文从 `C` 回到 `S0`，每轮增长 `g>0`，令：

\[
m = \frac{C-S_0}{g}
\]

即一个周期包含约 `m` 轮。假设每轮都会按 cache-read 单价 `r` 重新读取当前前缀，且每轮平均输出 `y` token、输出单价为 `o`。一次切换固定成本为：

\[
K = h o + K_{write} + R
\]

- `h`：模型写出的交接 token 数；
- `h o`：交接输出成本；
- `K_write`：切换后新前缀的 cache write 成本（含 TTL/entry fee）；
- `R`：重新读文件、探索、恢复状态的再发现成本，可含 token 成本和工具工作损失。

第 `j` 轮（`j=0,...,m-1`）的上下文约为 `S0+jg`。每轮平均成本为：

\[
A(m)=\frac K m + r\left[S_0+\frac{g(m-1)}2\right]+o y + A_{other}
\]

其中 `Ay` 和其它与 `m` 无关的项不会影响最优点。求导：

\[
\frac{dA}{dm}=-\frac K{m^2}+\frac{rg}{2},\qquad
\frac{d^2A}{dm^2}=\frac{2K}{m^3}>0
\]

因此唯一极小点为：

\[
m_{\mathrm{opt}}=\sqrt{\frac{2K}{rg}},\qquad
C_{\mathrm{opt}}=S_0+g m_{\mathrm{opt}}=S_0+\sqrt{\frac{2Kg}{r}}.
\]

所以题目给出的形式成立，但前提很强：`K` 不随 `C` 变化，且没有质量项、TTL 事件或价格档位。

### 2.2 写入成本随 C 增长

如果新前缀写入是 `wC` 而不是固定 `K_write`，则：

\[
K(C)=K_0+wC,
\]

周期平均项中的 `K(C)/m` 可以拆成 `wg + (K_0+wS_0)/m`。常数 `wg` 不改变一阶条件，得到：

\[
C^*=S_0+\sqrt{\frac{2g(K_0+wS_0)}{r}}.
\]

这说明“写入整个新前缀”的成本主要应按 `S0` 计入固定项；不能把 `wC` 直接当成与 `m` 无关的 K 后再重复计费。

更一般地，对任意分段成本 `K(C)`，令 `m=(C-S0)/g`，候选点满足：

\[
\frac{rg}{2}+\frac{g m K'(C)-K(C)}{m^2}=0,
\]

等价于：

\[
K(C)- (C-S_0)K'(C)=\frac{rgm^2}{2}.
\]

实践上应在每个价格档位内部求根，并把档位边界、reserve cap、质量上限都加入候选集合。

### 2.3 输出、工具结果和输入增长

`g` 不只是模型 output：上一轮 assistant 输出、tool result、用户消息和动态 system prompt 都可能进入下一轮上下文。日志中全量增长分布为：

| 样本                    | 轮间 context 增长 P50 |   P90 | 说明                                                 |
| ----------------------- | --------------------: | ----: | ---------------------------------------------------- |
| 全部 230,914 个相邻观测 |                   774 | 4,208 | 包含主/子会话和压缩后的跳变，须过滤负跳变再用于 EWMA |
| 主会话 211,718          |                   779 | 4,223 | 适合 hint 估计                                       |
| 子 agent 19,196         |                   719 | 4,018 | 不切换对照；子 agent 大多不注册切换工具              |

若每轮 output `y` 和工具输出比例随 context 增长，不能把它们当常数：使用在线估计的 `g_t`（或分别估计 `g_input`、`g_tool`、`g_output`），并将输出价格 `o` 计入 `K` 中的交接输出与质量惩罚。若 `y` 本身与 `C` 强相关，将其作为 `A_other(C)` 的斜率加入数值候选比较，而不是硬套闭式解。

### 2.4 TTL 过期、5m/1h 和闲置

Anthropic 路由在本项目文档使用的相对倍率是：cache read 约 `0.1p`、5m write 约 `1.25p`、1h write 约 `2.0p`，`p` 为 base input 单价。因此：

- 热路径 5m→1h 的边际写入约 `0.75p` 乘以新增 token；
- 首次未覆盖前缀的 1h entry fee 近似整段重写，不能按热增量成本估计；
- 1h 覆盖后，5m 尾巴在再次 1h 请求时可能重写，尾巴应按 entry-fee 口径计入。

设下一轮前空闲间隔超过 TTL 的概率为 `q_idle(C)`。继续长会话的下一次成本会从 `rC` 变成 `wC`；切换后成本约为 `K_warm` 或 `K_cold(C)`。可用：

\[
K_{eff}(C)= (1-q)K_{warm}+qK_{cold}(C)
-q\,[wC-rC]
\]

来表示“如果不切换，本来会因过期多付的成本”。`K_eff` 可能变小甚至为负：长空档发生后、下一轮真正发请求之前，是切换的好时机。实现上不应等到普通 hint 才处理这一状态，而应把 `lastRequestAt`、5m/1h proven hit、空闲间隔和 entry fee budget 作为独立信号。

### 2.5 分档价格

`models.json` 中 GPT-5.6 Sol/Terra 的价格在输入超过 272k 后翻倍（Sol 的 cacheRead 为 $0.4/M→$0.8/M，Terra 为 $0.2/M→$0.4/M）。因此成本曲线在 272k 有强拐点：候选切换点要比较 `C*`、272k、`50%W`、force line 和质量上限。不能用一个跨档平均 `r`。

## 3. 历史数据方法与结果

### 3.1 数据覆盖和分类

扫描：

- 路径：`~/.pi/agent/sessions/**/*.jsonl`；逐行 JSON 解析，没有把 2.49 GB 全部载入内存。
- 时间：2026-04-30T10:45:37Z 至 2026-09-24T11:14:22Z。
- 会话：4,658；主目录/主会话文件 4,090，子 agent 目录启发式分类 568（含 `subagent`、`pi-agent-*`、worktree 路径）。
- assistant usage：235,572；user 14,822；toolResult 288,253。
- context 估计：`input + cacheRead + cacheWrite`。这是请求侧上下文规模的可复现代理，不等同于 pi UI 的 percent；有些 provider 的 usage 字段不完整。
- 成本：优先使用 `usage.cost.total`；缺失时按 `models.json` 的 input/output/cacheRead/cacheWrite 和 tier 估算。报告不输出 `models.json` 中的凭据。

上下文规模分布：P10 24,898、P50 96,137、P90 258,972 token，均值 122,278。usage cost 分布：P10 $0.0307、P50 $0.1038、P90 $0.3609/assistant turn；output P50 236、P90 1,232 token。

子 agent 作为“不切换”对照：568 个子会话中 563 个没有检测到压缩条目，11 个压缩条目集中在 5 个子会话；全量主会话 4,090 个中 71 个含压缩条目。该对照不是随机实验组，任务复杂度和模型分布不同，只用于估计自然增长与工具开销。

### 3.2 真实切换/压缩事件

| 事件                        | 数量 | 识别口径                                             |
| --------------------------- | ---: | ---------------------------------------------------- |
| `switch_context` tool call  |    5 | assistant content 中的真实 toolCall                  |
| `compact_context` tool call |   21 | 同上                                                 |
| compaction 条目             |  125 | JSONL `type=compaction`                              |
| hook/交接可识别             |    4 | compaction `fromHook=true`；不保证全是同一种调用路径 |
| 自动/无前置工具可识别       |  103 | 没有紧邻切换/压缩工具调用的 compaction               |
| 有后续首轮 usage            |  119 | 可计算 `S0` 与压缩后成本                             |

事件检测使用“压缩前最近 assistant usage”和“压缩条目后的前 6 条 assistant usage”。`fromHook`、工具邻近关系和历史模型别名只能给触发方式近似，不能从日志反推出 hint/force custom message 的全部因果链；因此没有把未证明的事件标成“hint 后”或“force 后”。

已知模型窗口的 46 个压缩事件：触发上下文 P50 261,208、P90 459,819；占窗口 P50 46.1%、P90 95.6%。压缩后 `S0`（119 个完整事件）P50 50,579、P90 98,831；交接/摘要字符数 P50 10,491、P90 21,607。压缩后的前 5 个 usage 相对压缩前 4 轮平均成本的差值中位数为 -$1.54；这是“上下文变短后每轮变便宜”，不是再发现成本本身，不能把负值解释为质量收益。

真实 `switch_context` 的逐事件数据：

| 模型            | 触发 context | 窗口比例 | 首轮 S0 | 交接字符 | 首轮 cacheRead / cacheWrite |
| --------------- | -----------: | -------: | ------: | -------: | --------------------------: |
| Claude Opus 5   |      424,489 |   42.45% | 101,479 |    4,191 |             43,920 / 57,557 |
| Claude Opus 5.5 |      395,862 |   39.59% |  98,749 |    7,213 |             44,078 / 54,667 |
| Claude Opus 5.5 |      483,138 |   48.31% |  92,501 |    8,493 |                  0 / 92,501 |
| Claude Opus 5.5 |      446,421 |   44.64% | 101,535 |    7,579 |                 0 / 101,531 |

四次首轮 usage cost 为 $0.2858、$0.3870、$0.4755、$0.5138；这给出“真实切换首轮的现金尺度”约 $0.39--$0.48（中位数约 $0.43），但其中包含新前缀写入、输出和 provider 具体缓存命中，不能直接当纯 K。切换后的首 6 条 assistant 中，按可识别的 `read/rg/grep/sed/cat` 工具调用做重复读取代理，未形成稳定、可验证的增量信号：工具计数在历史条目中是累计快照，切换边界后常为 0 增量。结论是：日志可以证明切换后仍有大量工具活动，但不能可靠证明“重复读了同一文件”。

### 3.3 质量信号

全量 user 文本中匹配“错了/不对/不正确/纠正”等模式 151 条，但没有可靠的事件因果关联：它们可能与压缩无关。因此没有把它当作切换质量的数值估计。重复读同一文件也因 session 条目只存工具结果、工具计数是累计快照且路径可能被截断，未形成可信代理。

可用的负面证据是切换后的交接内容确实有限：真实四次交接只有 4,191--8,493 字符，而切换前有 395k--483k context。`keep_recent=true` 和 hook 的机械附录（fileOps、todo、active runs）能降低信息损失，但 `keep_recent=false` 必须把交接字段视为全部状态，不能只靠成本模型决定。

## 4. 代入主力模型

### 4.1 价格输入

以下价格来自只读的 `~/.pi/agent/models.json`，单位均为 USD/M token；同一模型不同 provider 可能不同，表中取实际 registry 代表项：

| 模型            |      窗口 | input | output | cacheRead | cacheWrite | tier               |
| --------------- | --------: | ----: | -----: | --------: | ---------: | ------------------ |
| Claude Opus 5.5 | 1,000,000 |     4 |     20 |       0.2 |          5 | 无                 |
| Claude Opus 5   | 1,000,000 |     5 |     25 |       0.5 |       6.25 | 无                 |
| Claude Sonnet 5 | 1,000,000 |     3 |     15 |       0.3 |       3.75 | 无                 |
| GPT-5.6 Sol     |   372,000 |     4 |     20 |       0.4 |          5 | >272k 后翻倍       |
| GPT-5.6 Terra   |   372,000 |     2 |     12 |       0.2 |        2.5 | >272k 后翻倍       |
| Kimi K3         | 1,048,576 |     3 |     15 |       0.3 |          0 | 无 cacheWrite 报价 |
| GLM 5.2         |   375,000 |   0.6 |    2.2 |      0.11 |          0 | 无 cacheWrite 报价 |

`cacheWrite=0` 可能表示 provider 不报告/不收费，不表示切换绝对没有写入或质量成本；对这类路由必须回退到实际 usage 或订阅/额度策略。

### 4.2 C* 数值

用历史主会话 `g=P50=774`、切换后 `S0=100k` 作为基准，并为每个模型取一次切换固定成本 K：Opus 5.5=$0.48（真实样本中位数附近）、Opus 5=$0.39；Sonnet、GPT、Kimi、GLM 是按价格和首轮写入规模缩放的敏感性假设，未声称被本机切换事件直接校准。价格单位换成 USD/token 后代入 `C*=S0+sqrt(2Kg/r)`：

| 模型          | K 假设 | C* token | 占窗口 | 50%/绝对 hint 对比 | 88% force 对比          |
| ------------- | -----: | -------: | -----: | ------------------ | ----------------------- |
| Opus 5.5      |  $0.48 |  160,952 |  16.1% | 500k 明显偏晚      | 880k 明显偏晚           |
| Opus 5        |  $0.39 |  134,748 |  13.5% | 500k 明显偏晚      | 880k 明显偏晚           |
| Sonnet 5      |  $0.36 |  143,100 |  14.3% | 500k 明显偏晚      | 880k 明显偏晚           |
| GPT-5.6 Sol   |  $0.48 |  143,100 |  38.5% | 186k，略晚         | 327k 且跨 272k 档，偏晚 |
| GPT-5.6 Terra |  $0.24 |  143,100 |  38.5% | 186k，略晚         | 327k 且跨档，偏晚       |
| Kimi K3       |  $0.08 |  120,317 |  11.5% | 524k，明显偏晚     | 922k，明显偏晚          |
| GLM 5.2       |  $0.05 |  126,526 |  33.7% | 187.5k，略晚       | 330k，偏晚              |

P90 `g=4,208` 时，C* 上升到：Opus 5.5 242k、Opus 5 181k、Sonnet 5 200k、GPT Sol/Terra 200k、Kimi 147k、GLM 162k。故在线 EWMA 比单点 P50 更重要。

成本差异的量级（每轮平均项，固定 K、S0=100k、P50 g；未加质量惩罚）：Opus 5.5 在 500k 相比 C* 多约 $0.029/轮，在 880k 多约 $0.066/轮；Opus 5 分别约 $0.083、$0.178；Sonnet 约 $0.048、$0.104；Kimi 约 $0.058、$0.117。GPT/GLM 因价格更低，差异较小，但 GPT force 进入 272k 高价档后，Sol 的额外项约 $0.059/轮、Terra 约 $0.030/轮，超过不跨档计算的结果。

这些是“无质量惩罚、每轮按 cache-read 计价”的方向性数字。把 `R` 从 $0.48 增加到 $10--$12（例如大量重新探索、错误修复的期望成本）时，Opus 5.5 的 C* 才会从约 161k 推到约 400k；这正是为什么质量/再发现风险决定最终 hint，而不是只看 cache price。

### 4.3 与现行阈值的判断

- 若运行时是用户背景所说的 50% hint：对 1M 模型等于 500k，纯成本上偏晚；对 372k 模型是 186k，接近 P90 `g` 的成本最优范围。
- 若使用仓库 HEAD 默认 75% 加 500k absolute line：1M 模型仍由 500k absolute line 先触发，依旧晚于纯成本 C*；372k 模型 absolute line 自动超窗，75% 为 279k，仍可能跨 GPT 272k 档。
- force 88%/窗口缩放 88--95% 是安全兜底，不应改成成本最优点；但其离成本最优很远，必须保证 hint/模型主动切换路径在此前有效，否则 force 会承担过多质量损失和写入成本。

## 5. 反事实阈值序列

选择四条长会话，使用真实 assistant usage 的 context 增长序列和 `usage.cost`。对每个 X=30/40/50/60/70/80/90，模拟：达到 X% 后把当前 context 重置到该会话观测 P10 与 50k--120k 之间的 `S0`，每次加实测首轮切换成本 K；重新计算 cache-read、output 和切换项。未改变真实序列中的用户/tool 内容，且未模拟 provider 具体 cache-write 分段，因此表格是“上下文成本分量的可比估计”，不是可审计的完整美元账单；原会话真实总账列单独给出。

| 会话（模型）           | assistant 数 | P50 g | 实际 usage.cost 总额 | X=30/40/50/60/70/80/90 的模拟成本分量（美元）         | 切换次数（对应 X）             |
| ---------------------- | -----------: | ----: | -------------------: | ----------------------------------------------------- | ------------------------------ |
| pi-toolkit（Opus 5.5） |     701 左右 | 1,149 |         约 $162--164 | 44.9 / 51.2 / 55.9 / 65.0 / 77.8 / 81.9 / 78.7        | 22 / 15 / 11 / 9 / 8 / 6 / 6   |
| apistrike（Kimi K3）   |          431 |   553 |               $87.45 | 26.2 / 28.7 / 38.9 / 54.9 / 46.4 / 35.8 / 35.8        | 5 / 4 / 3 / 3 / 2 / 2 / 2      |
| bunker（Opus 4.8）     |          869 | 1,173 |              $237.81 | 97.2 / 117.5 / 130.3 / 153.0 / 177.2 / 192.5 / 174.2  | 12 / 8 / 8 / 6 / 5 / 4 / 4     |
| claude2api（Opus 5）   |        2,756 |   646 |            $1,380.69 | 323.1 / 362.0 / 418.0 / 500.7 / 593.9 / 648.8 / 755.0 | 27 / 19 / 15 / 13 / 10 / 9 / 8 |

序列曲线不是单调函数，因为真实 growth 中有工具大输出、已有压缩、空档和模型切换；它们仍支持两点：极早的切换会支付很多 K，极晚的 X 会让每轮长前缀读成本和 tier 价格占主导，通常 30%--60% 比 80%--90% 更便宜。解析解的 120k--160k（约 12%--16%）低于表格起点，是因为 X 表只按题目要求列 30% 起，并且真实 `R`/质量成本没有完全可观测；二者不矛盾，说明真实落地需要质量惩罚把候选点向上推。

## 6. 质量约束和信息损失

### 6.1 公开证据

1. Liu 等人的 _Lost in the Middle_ 在 TACL 2024：相关信息位于上下文开头/结尾时表现较好，位于中间时明显下降，即使是长上下文模型也存在 U 形曲线。
   - https://aclanthology.org/2024.tacl-1.9/
   - https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Long
2. RULER 评估 17 个长上下文模型，指出 NIAH 近乎完美不能代表多跳、聚合等任务；随着长度和任务复杂度上升，几乎所有模型下降，声称 32k 以上的模型中只有一半在 32k 仍达到满意水平。
   - https://arxiv.org/abs/2404.06654
   - https://github.com/NVIDIA/RULER
3. Chroma 的 Context Rot 报告在 18 个模型上观察到输入变长时可靠性增加地下降，且简单任务也会发生；它明确提醒 NIAH 低估真实对话/记忆任务。
   - https://www.trychroma.com/research/context-rot
4. Anthropic context window 文档明确说明 system、所有消息、工具结果、图片和工具定义都计入上下文；上下文变大不等于效果变好，并建议通过 context engineering/compaction 管理长任务。
   - https://platform.claude.com/docs/en/build-with-claude/context-windows
   - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

这些公开证据没有给出本项目模型的精确质量拐点，因此只能定义约束形式，不能凭文献宣称“某模型在 47% 必须切换”。

### 6.2 公式表达

令 `D(C)` 为 context rot/lost-middle 的期望质量损失，`L_h` 为模型交接漏写关键信息的损失，`B` 为可接受质量损失预算。可以采用硬约束：

\[
D(C) + L_h(\text{handoff}, keep\_recent) \le B,
\qquad C \le C_{quality}.
\]

或采用惩罚项：

\[
A_{quality}(m)=A(m)+\lambda_D D(S_0+mg)+\lambda_hL_h.
\]

若把质量损失折算成美元，直接令 `K_quality = lambda_D D + lambda_h L_h` 加入 K；如果无法货币化，则用 `C_quality` 作为上限，候选点取：

\[
C_{hint}=\min(C_{cost/quality},C_{quality},C_{pi\ reserve}),
\]

其中 `C_cost/quality` 由离散候选计算，不是硬套闭式解。`keep_recent=true`、机械 fileOps/todo 附录、必填 goal/progress/next_steps 都应降低 `L_h`；`keep_recent=false` 则提高它，除非交接字段很完整。

历史数据目前没有足够的“用户纠正/重复读”配对样本来拟合 `D(C)`，所以建议先把 40%--50% 的真实 switch 事件作为质量先验，再用在线纠正、重复工具目标、任务回归测试更新模型，而不是把公开 benchmark 数字直接硬编码。

## 7. 可落地的动态规则草图

### 7.1 输入和状态

```text
model = {
  contextWindow: W,
  inputPrice: p_in,
  outputPrice: p_out,
  cacheReadPrice: r,
  cacheWrite5mPrice: w5,
  cacheWrite1hPrice: w1,
  tiers: [{inputTokensAbove, ...}],
  pricingKnown: boolean,
  subscriptionOrQuota: boolean,
}
observed = {
  gEwma, gP90,                  # 每轮 context 增长
  s0Ewma, s0P90,                # 历史切换后首轮起点
  handoffTokensEwma,
  rediscoveryProxy,             # 工具重读/重复问题/回归失败的加权代理
  correctionRate,
}
cache = {
  lastRequestAt,
  lastProvenReadAt,
  ttl: "5m" | "1h" | "unknown",
  coveredPrefixTokens,
  tail5mTokens,
  entryFeeBudgetRemaining,
  marginalWriteBudgetRemaining,
}
quality = {
  qualityCapPercent,            # 模型/任务校准值；未知时保守默认
  penaltyUsdPerQualityUnit,
}
pi = {
  reserveTokens,
  autoCompactionPercent,        # 由实际窗口/reserve 推导
  forceDemandTurns,
}
```

### 7.2 伪代码

```text
function threshold(model, observed, cache, quality, pi, now):
  W = model.contextWindow
  if W <= pi.reserveTokens or W is unknown:
      return fallbackPercentOrDisable()

  g = clamp(observed.gEwma, minGrowth, observed.gP90)
  S0 = max(observed.s0Ewma, mechanicalAppendixFloor)
  R = priceRediscovery(observed.rediscoveryProxy, model.outputPrice)
  H = observed.handoffTokensEwma * model.outputPrice / 1e6

  # Evaluate the real cost, not only the closed form.
  candidates = {S0 + sqrt(2 * (H + R + writeCost(S0, cache) ) * g / readPriceAt(S0))}
  candidates += tierBoundaries(model.tiers)
  candidates += {0.30W, 0.40W, 0.50W, 0.60W}

  for C in candidates:
      K = H + R + writeCost(C, cache)
      if idleGapWouldExpire(cache, now):
          K -= expectedExpiredCacheSaving(C, cache, model)
      cost[C] = cycleAverageCost(C, S0, g, model, K)
      cost[C] += qualityPenalty(C, quality, observed)

  qualityCap = quality.qualityCapPercent * W
  piCap = W - pi.reserveTokens - forceSafetyMargin
  hintTokens = argmin_C(cost[C]) subject to C <= qualityCap and C <= piCap

  # Avoid noisy switches and make the historical prior explicit.
  hintTokens = max(hintTokens, max(S0 + 2*g, 0.35*W))
  hintTokens = min(hintTokens, qualityCap, piCap)
  forceTokens = min(
      scaledForceLine(W, pi.reserveTokens),
      piCap,
      qualityCap,
  )
  forceTokens = max(forceTokens, hintTokens + forceHysteresisTokens)
  return {hintTokens, forceTokens}
```

实际代码不应直接固定 `0.35W` 永久不变：它是当前数据的保守启动先验。每次发生真实 `switch_context` 后，把 `S0`、handoff token、首轮写入和后续工具/纠正信号回写 EWMA；若质量信号稳定且 R 低，可下降接近 C*；若交接后重复探索/纠正升高，提高 `R` 或降低 `qualityCap`。

### 7.3 与现有 forceScaling 和 pi 自动压缩的关系

1. `forceScaling` 继续作为安全线的窗口缩放器，不应被成本算法替换。动态 force 只能取 `min(dynamicQualityCap, scaledForce, W-reserve-margin)`。
2. pi 自动压缩的 reserve line 是硬上限。hint 必须留出模型写交接、resume 消息和工具结果的余量；不能把 hint/force 推到自动压缩之后。
3. force demand 只给 `forceDemandTurns` 次机会要求模型主动 `switch_context`；仍越线则沿现有通用摘要安全网。动态算法不得关闭安全网。
4. `keep_recent=false` 要使用更大的 `L_h`/`R`；默认 `keep_recent=true` 可用较低 K。

### 7.4 建议新增配置（仅设计，不修改源码）

```text
compact.dynamicThreshold.enabled              = true
compact.dynamicThreshold.minHintPercent      = 35
compact.dynamicThreshold.maxQualityPercent    = 60 (或模型校准值)
compact.dynamicThreshold.ewmaAlpha            = 0.2
compact.dynamicThreshold.growthPctl          = 0.90
compact.dynamicThreshold.minHysteresisTokens = 2 * g
compact.dynamicThreshold.rediscoveryWeight   = 1.0
compact.dynamicThreshold.unknownPriceMode    = "quality" | "current"
compact.dynamicThreshold.subscriptionMode    = "quality" | "quota"
compact.dynamicThreshold.forceSafetyMargin   = reserve + resume budget
```

配置项数量应保持少：价格、窗口、`g`/`S0`、缓存状态应运行时读取；用户主要控制质量上下限、最小 hint、是否启用动态规则。

## 8. 退化与兜底

- **价格未知或 tier 未解析**：不执行激进的 C*；沿用当前 hint/force 和 reserve cap，记录 `pricingUnknown`，继续收集 usage。
- **订阅制/边际价格为零**：把 cache cost 设为 0 不代表可以无限增长。切换应由 `qualityCap`、额度消耗、响应延迟或任务回归质量触发；若有 quota，使用“每轮预计消耗/剩余额度”的惩罚项。
- **cache 状态未知、5m 已过期或 entry fee 未量化**：把当前请求按 cold 处理，并给 entry fee 单独预算；不要把热升级公式用于首次 1h entry。
- **`g`/`S0` 样本不足**：使用保守默认 `gP90` 和历史 `S0P90`，但限制最低 hint 不低于质量先验；有窗口变化时重新计算，不沿用旧百分比。
- **模型切换或 system/tool 定义变化**：清空/降权旧 EWMA，因为前缀谱系可能改变。已有 cache-ttl 现场记录显示，system prompt 动态变化会造成大段重写，不能只看对话 token。

## 9. traffic.db 独立核查

存在 `~/.pi/agent/records/traffic.db`，只读查询 schema：

- `sessions(id, started_at, last_seen, cwd, provider, model)`
- `requests(id, session_id, turn, ts, provider, model, payload, ... status, ... payload_bytes)`
- `messages(id, session_id, turn, ts, role, message)`
- `stream_chunks(id, request_id, session_id, seq, ts, elapsed_ms, data)`
- 以及 `rewrite_rules`、`rewrite_settings`。

计数为 16 sessions、154 requests、334 messages、20,606 stream_chunks，时间约 2026-08-11 至 2026-09-19。对 `messages.message` 和 request payload 做 `switch_context`/`compact_context` 关键词查询没有匹配；这不是“没有切换”的证据，只表示 traffic recorder 覆盖的是少量 provider 流量，且消息可能没有以 session JSONL 的完整形态落库。因此主结论以全量 session JSONL 为准。

## 10. 局限和下一步校准

1. 会话 JSONL 没有统一记录 context window/percent；对 provider 别名只做 registry 匹配，46/119 压缩事件能可靠换算百分比，其余只能给 token 数。
2. pi 的 compaction 是追加条目，不是删除历史；切换后首轮 `S0` 受 `keep_recent`、system prompt、工具定义和缓存前缀影响，不能仅由 summary 字符数预测。
3. 真实反事实需要重新构造 provider request，才能知道 cache hit/write、TTL 和 tier；本报告模拟固定真实增长序列，未声称重现完整 provider 账单。
4. `R` 是质量/重新探索的关键变量，而历史日志没有可靠的“同一文件重复读取”和“用户纠正归因”标签。下一轮实测应在 `switch_context` 前后记录结构化 `readFiles`、任务完成/回归结果、用户纠正和每次请求的 cacheRead/cacheWrite，至少积累 30--50 次真实切换再拟合 `R(C, model, taskType)`。

**最终建议**：先实现“价格/缓存感知的候选阈值 + 质量上限 + force 安全线”设计，不直接把现行 50%（或 HEAD 的 75%）替换为纯公式结果。对当前主力 1M Claude，实际历史切换在 40%--48%，可先以 40% 左右 hint 作为质量优先启动值；纯成本 C* 约 13%--16% 应视为下界和成本报警，而不是立即强制切换点。对 GPT 272k 分档模型，必须把 272k 当候选拐点；对未知价格/订阅模型，转为质量或额度策略。
