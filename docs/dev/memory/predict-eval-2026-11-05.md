# 记忆预测预注入（memory jev predict）· 真实会话准确率评测报告

> 日期：2026-11-05 · 评测人：只读评测子 agent（单评估者）· 对象：`model.enabled=true` 默认开启（2026-11-04 起）后的真实会话注入
> 性质：D7 豁免（plan §12.2）后补评测的**第一步现场数据**，不是方案定义的 ≥160 轮分层标注门禁——无冻结保留集、无用户逐条确认，判定为本报告单评估者的相关性判断。
> 数据源：`~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/`（1126 个会话文件）+ `~/.pi/agent/memory/-home-bluecake-ai-pi-toolkit/`（含 `.jev/` 侧车）。中间脚本与底表在 `/tmp/memeval/`（随机器清理）。

## 0. 一页摘要

- **样本**：窗口 2026-11-04T00:00Z 起。主会话仅 1 个有注入（当前会话 `01a1a42f`，56 事件 / 106 条目，**全量判定**）；子会话 189/234（81%）有注入，其中 **P 层全部 19 事件 / 35 条目全量判定**，U 层抽样 30 事件 / 82 条目，E 层抽样 12 事件 / 13 条目。合计判定 236 条。
- **精确率（useful / neutral / irrelevant / harmful）**：
  - 主会话全量：**37% / 28% / 35% / 0**；
  - 子会话 P 层（唯一真实 P 注入样本，全部 rules 来源）：**14% / 17% / 69% / 0**；
  - 子会话 U 抽样：18% / 50% / 32% / 0；E 抽样：8% / 38% / 54% / 0；
  - 合计：25% / 35% / 40% / **0 harmful**（无过时/误导性注入，这是最大的正面结论）。
- **P2 模型通路实际无效**：主会话 9 次 deepseek 调用仅 3 次及时成功（33%），6 次在 ~1.5s 等待窗口关闭时中止（flight 预算 3000ms 从未用满）；**零次模型驱动的 P 注入**。主会话 P 层注入为 **0**（规则 3 次命中 deletion=0.9 也未产出注入，见 §5.4）。
- **召回**：30 个主会话用户回合抽样，明显漏注入 4 个（13%）+ 弱漏 1 个；最痛的两类：主题偏好轮（预览格式）与报错释义轮（jev not tagged）。
- **Top 问题**：①「主会话调度卫生」类条目大量注入子会话（P 层 69% irrelevant 的主因）；②线路状态类过时事实（copilot-response 暂停、droid 已关）反复撞入；③E 层对只读工具失败做关键词撞词（`删除只用精确路径` 在 read/grep/ls 失败时注入 18 次）；④窗口/预算错配让模型通路全军覆没；⑤U 层对「这是什么报错/我的偏好」类轮次召回不足。

## 1. 注入机制速览（从代码与会话文件核实）

- **落盘形态**：`type:"custom_message"` + `customType:"subagent:memory-inject"`；`content` 以 `[memory · <L> jev]` 开头（legacy G 层为 `[memory · G unjudged]`）；`details = {v:1, layer, trigger, model?, items:[{file,anchor,hash,authority,p?}], partial?, parts?, predict?}`。P+U 合并时顶层 layer 为 `"P"`、`details.parts=[P,U]`（本窗口未出现合并样本）。
- **通道**：`U`（用户轮，`before_agent_start`，分类器 `opencode/jev-1.13[-free]`，条目 p≥0.6、≤3 条、≤4096B；`MIN_PROMPT_CODEPOINTS=8` 以下或 ACK 短语跳过）；`A`（tool_call 快速通道，仅 risk:high tag，2026-11-03 收窄 + `aInjectedAt` 24h 跨会话冷却）；`E`（tool_result 失败：bash/read/edit/grep/ls/message_agent）；`B`（压缩后重注）；`P`（轮首预测，规则 origin:`rules` / 模型 origin:`model`）；`S`（发版进行中，本窗口 0 次）。`G` 是 gate 时代遗留（ff5400bc 2026-11-04 13:11+0800 移除）。
- **去重**：「本段上下文内不会重复注入」按 segment 去重；A 层 24h 冷却实测生效（同一 trio 恰好 24h 后重注，主会话 #12→#39）；压缩清空 segment，B 层随之重注（by design）。
- **诊断持久化**：会话内 `subagent:memory-recall`（layer+keys）、`subagent:memory-predict`（`kind:"final"` 含逐 tag score/sources/rules；`kind:"call"` 含 at/model/ms/ok/reason/timely/reserveUsd/costUsd/costSource）；`.jev/index.json`（227 条目 + aInjectedAt 38 / pInjectedAt 35）；`.jev/diag.jsonl`（48 行，全为 2026-11-05 分类器 timeout）。**未持久化**：未注入候选列表与分数、注入自身延迟——只能从注入条目自带的 `p` 与 call 记录侧面估算。
- **关键时间线**（解释主会话无 P 注入）：根会话进程 2026-11-04T01:32Z 启动，加载的是当时的工作区代码（gate 未移除、P 未合入），**直到 2026-11-05T03:40Z 用户重启后才运行 P1b+P2 代码**（predict final 记录从 03:42Z 开始；G 层记录止于 02:29Z）。因此主会话 11-04 全天 + 11-05 凌晨的注入均来自旧代码路径。

## 2. 方法与口径

1. **抽取**：解析全部会话 jsonl 的 memory-inject / memory-predict / memory-recall 条目；对每条注入回溯触发上下文（≤6s 内最近的用户消息 / 工具调用）。子会话按头部 `subagent:child` 标记识别（driver 写入，line 2）。
2. **精确率四档**：`useful`（与当轮请求直接相关，或后续回复确实用到）/ `neutral`（同领域但当轮用不上）/ `irrelevant`（无关）/ `harmful`（过时或错误、可能误导）。判定以「条目文本 × 触发上下文」为主，对高信号样本（如 #51）核对了后续动作。
3. **召回**：主会话 131 个真实用户回合（剔除 switch_context 横幅/skill 注入）均匀抽 30 个；「当时存在」以 `.jev/index.json` 的 `at`（首次打标时间）+ 条目内嵌日期为准。
4. **子会话处理**：子会话注入是设计内行为（`predict.childSessions`），且 89% 的会话流量在子会话——**P 层唯一真实样本也在子会话**，故子会话单列且 P 全量判定；合并数字仅作参考。
5. **局限**：单评估者、无 P on/off 对照回放（覆盖率增量指标不可算）、G 层 7 条属已移除代码路径（计入但单列）、子会话 U/E 为分层抽样（按文件均衡）。

## 3. 窗口内注入总量（全部会话）

| 层          | 记录数 | 条目数 | 判定覆盖                      |
| ----------- | ------ | ------ | ----------------------------- |
| U           | 243    | 636    | 主会话全量 + 子会话抽样 82 条 |
| A           | 32     | 64     | 主会话全量（57 条）           |
| E           | 35     | 37     | 抽样 13 条                    |
| B           | 6      | 18     | 主会话全量（15 条）           |
| P           | 19     | 35     | **全量**                      |
| G（legacy） | 17     | 18     | 主会话全量（7 条）            |

体量：354 条记录 / 376.9KiB（U 平均 1246B/条 ≈ 0.4–0.6k token）。日均约 180 条记录，主会话单进程 2 天 56 条（每 ~7 个用户回合 1 条），噪音压力主要在子会话。

## 4. 精确率明细

### 4.1 主会话（56 事件 / 106 条目，全量）

| 层          | n   | useful       | neutral  | irrelevant | 亮点/问题                                                                                                                                      |
| ----------- | --- | ------------ | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| U           | 25  | 11 (44%)     | 6        | 8          | #51 message_agent 排查轮注入 pitfalls-subagent#17（kind 语义）**正中答案**；#55 记忆治理轮注入 cache-ttl 条目属主题撞车                        |
| A           | 57  | 20 (35%)     | 18       | 19         | 真跑 git/release 时极准：#32（release.sh 运行）注入中断恢复 trio 全 useful；但「dispatch 卫生 trio」在 TaskUpdate/派单上重复出现，多为 neutral |
| B           | 15  | 7 (47%)      | 3        | 5          | 压缩后重注整体最稳，因复选的是当期活跃主题                                                                                                     |
| E           | 2   | 1            | 1        | 0          | #28（查 .git/index.lock 竞态）注入「同仓库并发提交」p=0.87，正中                                                                               |
| G（legacy） | 7   | 0            | 2        | 5          | bash-tail 用户令在 rm/prettier 等无关触发撞入；该层已移除                                                                                      |
| 合计        | 106 | **39 (37%)** | 30 (28%) | 37 (35%)   | harmful = 0                                                                                                                                    |

### 4.2 子会话 P 层（19 事件 / 35 条目，全量，origin 全部 `rules`）

- useful 5 / neutral 6 / **irrelevant 24（69%）**。典型 useful：#16「只读排查 fabric 运行时问题」注入 pitfalls-subagent#17（正是被排查的 message_agent 现象）；#11（B3 开发）注入 typebox 别名坑；#10（测试提速方案）注入 secure 挂载撞锁事实。
- 典型 irrelevant：8/19 个事件把**主会话调度卫生**（concurrencyLimit 槽位、watchdog 超时、verifier worktree、≥2 写包 conflict-check）注入了**子会话**——子会话既不派单也不验收，这些规则对它无动作价值。
- 19 事件中 14 个无同轮 U 注入 ⇒ P 的「额外注入」≈ 25 条 / 窗口内 131 个 predict turn ≈ 0.19/轮（plan 门槛 ≤0.3/轮，量上未超，质上 69% irrelevant）。
- tag 侧观察：`docs/git-commit/git-push/credentials/release` 等 tag 在「只写文档、禁止 git」的派单上频繁 ≥0.85（prompt 含 commit 哈希、发版词被 shape 提取），但对应 tag 无合格条目所以未注入——**tag 误报本身没造成伤害，条目选择才是伤害点**。

### 4.3 子会话 U（30 事件 / 82 条）与 E（12 事件 / 13 条）抽样

- U：useful 15 / neutral 41 / irrelevant 26。中性大池由固定几条构成（并行禁全量 npm test、bash/zsh 差异、结构化交接、verifier 提醒）——对执行型子会话普遍「有一点用但非必需」。exact hit 样本：childU#28（排查 sent·unconfirmed）注入「排障先核对 hub 代码快照时间」p=0.85。
- E：useful 1 / neutral 5 / irrelevant 7。**`pitfalls-git › #4 删除只用精确路径`（用户令）在 read/grep/ls/find/edit 失败时注入 18 次（全窗口），抽样 7 条 6 条无关**；`绝对路径` 用户令在 find 无匹配时注入 5 次全 neutral。E 层对只读工具失败的语义匹配基本是撞词。

### 4.4 harmful 复核

0 条 harmful。最接近的两类已单列：`pitfalls-subagent › #11 resume 不可靠（修复中）`（10-28 写、无解决日期）在 11-05 仍被注入 2 次——若 #30 已修则属潜在过时；`copilot-response 暂停`（10-23）与全局「GPT 已解禁（10-21）」存在表述张力，但因更晚且限定单线路，未判 harmful。

## 5. 召回（30 个主会话用户回合 + 1 个独立短问会话）

30 回合中 3 个有 U 注入（其中 #29「记住」注入的 2 条均 irrelevant——注了但注错）。明显漏注入 4 个、弱漏 1 个：

1. **R#2（11-04 01:53）「我不要 ascii 的预览，我要图片或 html（需要记住）」→ 漏**。`pitfalls-subagent › #5`（预览一律 HTML/CSS/内联 SVG，10-10 起在库）正是该偏好，未注入；该轮之后模型才新写 ui-preview.md。
2. **R#19（11-04 14:06）「按照建议修复打tag的问题…」→ 漏**。正在处理发版 tag 问题，`release.sh 中断恢复`条目组（10-29 起在库）未注入；次日真正跑 release.sh 时 A 层才注入同组 3 条（#32，全 useful）——**A 兜住了执行时刻，但讨论时刻漏了**。
3. **R#26（11-05 06:16）「jev: not tagged (partial: transient) 这个报错是什么意思」→ 漏**。`memory-predict › #2`（11-04 批准的打标可靠性修复，正含 partial/transient 语义）未注入；同条目 4 小时后在另一轮被注入（#51 里的 irrelevant 项）。
4. **R#25（11-05 03:56）「新建任务：删除修改记忆需要手动确认的环节」→ P 命中未投递**。规则给出 deletion=0.9（≥0.85），但 P/U 均零注入：deletion 标签下的合格条目两条 10–13 分钟前刚被 P 注入（pInjectedAt 冷却内），core.md 规则属 static-core（已在 system prompt，排除），其余候选未过门槛。高危 tag 命中却「冷却全饿死」是设计空档。
5. 弱漏：R#17（webui 会话上限改设置）未注入「改 web-hub 设置需先 /reload」。

独立短问会话（11-05 03:32，「todo list 支持持久化吗？」16 码点）零注入：经核当时库内确无 todo 持久化条目，**不算漏**（MIN_PROMPT_CODEPOINTS=8 也没拦它）。

## 6. 分项与 Top 榜

**按条目性质**（主会话 106 条）：用户令 10 条 → useful 4 / neutral 2 / irrelevant 4（40% useful，低于整体——用户令多经 G/E 撞词通道进入）；pitfall/rule 经验类是 useful 主力；**「线路状态/ dated 事实」类（copilot 暂停、droid 已关、resume 修复中）是 irrelevant 重灾区**。B 层（47% useful）与 A 层真执行时刻（git/release）质量最高。

**Top 5 误注入（按 irrelevant 贡献）**：

| 条目                                                | 次数（窗口）      | 判定                        | 原因猜测                                                        |
| --------------------------------------------------- | ----------------- | --------------------------- | --------------------------------------------------------------- |
| pitfalls-subagent › #3 并行 agent 禁跑全量 npm test | 子会话 109 + 主 2 | 抽样多为 neutral/irrelevant | 主会话调度卫生规则成为子会话「万能注入」，dispatch tag 命中即选 |
| pitfalls-subagent › #2 copilot-response 暂停调度    | 主会话 5          | 5/5 irrelevant              | 线路状态类 dated 事实无时效降权，任何派单都撞                   |
| pitfalls-git › #4 删除只用精确路径                  | E 层 18           | 抽样 6/7 irrelevant         | E 层对只读工具失败做关键词撞词（失败文本无删除语义）            |
| pitfalls-runtime › web-hub 运行时 #3 hub jiti 快照  | 主会话 4          | 4/4 irrelevant              | prompt 含「web-hub」字样即撞                                    |
| pitfalls-subagent › #15 droid 已关                  | 3                 | 3/3 irrelevant              | 同 #2，已停线路备忘反复入场                                     |

**最常漏注入**：见 §5；另注意「用户当面陈述偏好/报错释义」两类轮次是系统性弱区。

## 7. 代价

- **模型调用**（仅主会话，子会话无）：9 次 deepseek/deepseek-flash，3 次及时成功（756–1524ms），6 次在 ~1.5s 窗口关闭时中止（`reason:"failed"`，ms≈窗口时长；flight 预算默认 3000ms 从未用满——U 分类器自身常跑 ~1.5s，窗口=U 完成时刻即关闭）。费用合计 **$0.00716**，其中失败按预留计费 $0.00653（91%）——**花的钱 9 成买到了 abort**。日额 $0.14 / 60 次上限远未触及。
- **及时命中率 33%（3/9）**，低于 plan §13.5 的悲观估计区间下限；且 3 次成功也**没有一次产出注入**（分数未过门槛或条目被 U/冷却认领）。
- **分类器（U 层）故障**：diag.jsonl 48 行全为 2026-11-05 的 `opencode/jev-1.13[-free] timeout`（2000–3000ms），对应当日多次 U 判定降级。
- **注入体量**：376.9KiB / 2 天 / 全部会话；主会话 56 条对上下文的压力可接受，子会话端 U 层 636 条目/2 天是主要噪音面。
- **延迟**：注入自身延迟未持久化（无字段）；可观测代理：模型调用 ms 与分类器 timeout。

## 8. 与方案门槛对比（plan §12.2，D7 豁免后未执行）

| 指标                       | 门槛       | 实测                                                   | 结论              |
| -------------------------- | ---------- | ------------------------------------------------------ | ----------------- |
| P 总体精确率               | ≥0.85      | useful 14%（non-irrelevant 31%），n=35                 | 远未达            |
| 误注条目率                 | ≤20%       | P 层 69%；主会话全层 35%                               | 未达              |
| 逐 tag 精确率（支持数 ≥5） | 每个 ≥0.75 | 单 tag 样本不足，无法计算                              | 未评估            |
| 额外注入量（P 独有）       | ≤0.3/轮    | ≈0.19/轮（量达标）                                     | 达标（但质差）    |
| deepseek 增量覆盖率        | ≥+5pp      | 及时 33%，0 次模型驱动注入                             | 无法评估/实际为零 |
| 否定/只读误注写动作        | 0          | 未观察到（只读派单上 git-commit tag 误报未转化为注入） | 该路径未受伤      |
| ≥160 轮分层标注集          | 前置       | 不存在（本报告 66 事件/236 条为首个现场标注）          | 门禁仍欠          |

**结论**：D7 豁免时「没有真实数据前不得声称准确率达标」的前提依然成立——不仅未达标，模型通路在默认参数下近乎空转（钱花了、注入为零），P 层现有价值全部来自规则路径，且其 69% 的无关率主要由「主会话规则进子会话」这一结构性错配贡献。

## 9. 改进方向（均有上述证据支撑；按预期收益排序）

1. **子会话 audience 过滤**：P/A 候选选择时按「条目受众」降权——dispatch/concurrencyLimit/verifier-worktree 类主会话调度规则在子会话（`isChild`）不入选或只保留明确通用的条目。可直接消掉 P 层 8/19 个事件与 U 抽样里的大片 neutral。
2. **dated 事实时效降权**：`index.json` 已有 `temporal` 字段——线路状态类（暂停/已关/修复中）在轮次未点名该线路时降权或要求 tag 命中该线路名。消除 Top2/Top5（主会话 8 次 irrelevant）。
3. **E 层证据收紧**：只读工具（read/grep/ls/find）的失败结果不再走 tag 撞词，或要求失败文本含条目核心语义（如删除/路径错误字样）；E 层当前 54% irrelevant 基本全部来自这里。
4. **修模型通路的窗口错配**：等待窗口随 U 完成即关（~1.5s）而 flight 预算 3000ms——要么把 `model.waitS` 提到上限 1.5s 并允许「U 早回时仍等到 min(waitS×k, budget)」，要么接受模型通路只做下一轮兑现；否则 66% 中止率 + 91% 费用买 abort 会持续。当前参数组合下建议干脆把 `model.enabled` 关回 false（规则层照常），等窗口策略改完再开。
5. **高危 tag 冷却饿死的降级出口**：R#25 型（deletion=0.9、候选全在冷却/static-core）可考虑「冷却期减半注入 1 条最高分」或在注入头标注同 tag 还有 N 条被冷却——避免高危预测完全静默。同时补 U 层召回弱区：报错释义类问句（"这个报错是什么意思"）加错误短语直查候选。

## 10. 复现与底表

- 抽取/判定底表：`/tmp/memeval/{sessions.json,root_events.json,childP.json,childU_sample.json,childE_sample.json,items_root.txt,items_childP.txt,recall_sheet.txt}`；脚本 `scan2.py / extract_events.py / show_sample.py`。
- 离线评测入口（未使用，需标注集）：`node scripts/dev/predict-eval.mjs`（Tier 3）。
- 本报告未改任何源码/记忆/设置；仓库内唯一写入即本文件。会话引用均截断 ≤80 字，未含私密正文。
