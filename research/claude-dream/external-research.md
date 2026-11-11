# Claude Dream 外部机制核查（归档）

> 研究截至 2026-11-11（Asia/Shanghai）。这是公开资料研究的精炼归档，不是本仓实现说明，也不是对第三方代码或生产服务的独立复现。

## 1. 背景与证据分级

核查问题：Claude 是否“每天晚上自动清理记忆”，Dream 实际读取什么、怎样整理、谁可修改用户规则、如何审核与恢复，以及哪些机制可供本仓借鉴。

| 标记              | 含义与限制                                                            |
| ----------------- | --------------------------------------------------------------------- |
| **官方接口**      | 官方文档/SDK 的公开接口和行为；不证明未公开内部算法                   |
| **官方承诺/示例** | 公告、研究文章、cookbook 的结果承诺或示范实现；示例不等于服务内部代码 |
| **用户报告**      | 官方 GitHub 仓库的用户 issue；不是 Anthropic 确认或普遍发生率         |
| **第三方分析**    | 发布 bundle 阅读/逆向或第三方项目；不能升级为官方产品合同             |
| **未知**          | 未找到公开证据，或资料相互冲突；保留未知，不填补推断                  |

**结论：未找到任何官方产品承诺“默认每天晚上定时清理记忆”。** Dream 至少指三类不同机制；普通 Claude Chat/Cowork memory 还要另算。

## 2. 产品与触发不能混同

| 对象                                         | 已证实的触发/状态                                                                                    | 不能推出的结论                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Chat/Cowork memory                           | **官方接口**：当前体验在聊天过程中保存 topic；部分 Team/Enterprise 的 legacy summary 每 24h 更新     | 不是称为 Dream 的默认夜间清理                                      |
| Claude Code auto-dream / `/dream`            | **用户报告 + 第三方分析**：历史灰度存在；在生命周期事件检查间隔、新 session 数、锁等；当前可用性不明 | 不是墙钟 nightly cron，也不能保证当前账号有 `/dream`               |
| Managed Agents Dreams API                    | **官方接口**：research preview，需 `dreaming-2026-04-21` beta header；调用方显式创建异步 job         | 公告说 scheduled process 不等于默认夜间调度；创建 API 无 cron 字段 |
| 官方 dynamic-workflow cookbook（2026-11-02） | **官方示例**：“You choose when it runs”；示例每晚 1 AM 由用户 cron 执行                              | 不是原生 Dreams API 的内部实现或所有用户默认行为                   |
| dream-skill / vexjoy auto-dream              | **第三方实现**：前者 Stop hook + pending flag、下次 session 跑；后者给 02:07 cron 示例               | 不是 Anthropic 官方机制                                            |

来源：

- [Chat/Cowork memory 当前与 legacy 帮助](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)，[官方 Markdown legacy 段](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md#2)，[2026-08-25 官方记忆公告](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it)。当前原句为 “as you chat, rather than summarizing conversations after they end”；legacy 原句为 “is updated every 24 hours”。
- [Managed Agents 公告](https://claude.com/blog/new-in-claude-managed-agents)，[Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams)，[Dreams API](https://platform.claude.com/docs/en/api/beta/dreams)，[官方 Python SDK 创建参数](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/beta/dream_create_params.py)。公告页面标 2026-05-19，而博客索引与同期报道指向 5 月 6 日；保留元数据差异，不擅定唯一发布日期。
- [2026-11-02 官方 cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)，[对应源码提交](https://github.com/anthropics/claude-cookbooks/commit/d4bd2fb364a7daa77fa90390800ba3aafffd2d1f)。

“空闲触发”也不足以统一描述这些产品：异步 API、用户 cron、Claude Code 生命周期检查各不相同。“做梦/睡眠”可作离线计算类比，不是 OS idle 或固定夜间执行合同。

## 3. Managed Agents Dreams 的公开机制

### 3.1 输入、输出与状态（官方接口）

```text
调用方 POST /v1/dreams
  输入：一个现有 memory store + 同 workspace 的 1–100 个历史 session
  选择：支持模型、高层 instructions（至多 4096 字符）、output_behavior
    ↓ pending → running → completed / failed / canceled
底层可观察 session，可流式查看读写，终态 archive（不是删除）
    ↓
create_new（默认）：复制输入到独立输出库，输入不改
update_existing（显式）：写回原库，要求写权限；同库未停笔任务可返回 409
    ↓
调用方审查/挂载/保留，或归档/删除输出
```

官方描述结果为：duplicates merged、stale/contradicted entries replaced with latest value、new insights surfaced。但**原生 Dreams 的 prompt、阶段数、相似度阈值、冲突仲裁、访问频率/重要性评分与淘汰公式未公开**。“latest value”不是“任意新话永远覆盖旧话”的算法证明。

[2026-11-06 The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) 讨论 transcript 纠错、wiki、断链修复与注入层提升。这些是官方实验/能力说明，不证明模型权重发生自我训练；Dream 改的是外部记忆。

### 3.2 权限、审核与恢复（官方接口）

- 默认 `create_new` 提供可丢弃输出隔离；`update_existing` 不是事务性全库提交。失败/取消后输出可能保留部分写入，不能假设自动回滚。
- store 是 workspace 的文本文件集合；session 挂载可 `read_only` 或 `read_write`，默认后者。共享标准可独立放只读库。[Memory guide](https://platform.claude.com/docs/en/managed-agents/memory)
- 每次 mutation 产生 immutable version，通常保留 30 天；无专用 restore endpoint，需取回历史版本重新 write，可 redact 历史版本。[Audit memory changes](https://platform.claude.com/docs/en/managed-agents/memory#audit-memory-changes)
- Dreams 没有独立的“用户规则不可改”权限层；有相应权限的 API/Console/读写 agent 可修改。保护需靠只读挂载、输入/输出分离和人工采纳。store description 与 attachment instructions 可进入 system prompt，应按高权限配置审核。[Session resources](https://platform.claude.com/docs/en/api/beta/sessions/resources)

### 3.3 隐私与成本（官方接口/示例）

- Managed Agents 当时不属于 ZDR 或 HIPAA BAA 覆盖；有状态 session transcript 保存到删除，终态 archive 不等于擦除。输入库、输出库、失败 partial output 都要独立管理。[Overview](https://platform.claude.com/docs/en/managed-agents/overview)
- Dream 暴露 usage，未找到固定单价、免费 nightly 或 SLA。cookbook 的 11 个合成 transcript（283 KB）约 $0.36/2.5 分钟、50 个长 transcript（约 12 MB）约 $8/10 分钟，仅是示例量级，不能外推成本或承诺。

## 4. 官方 nightly cookbook：可复用的规则，不是原生内部算法

**官方示例**自己实现 dynamic workflow，不调用 `/v1/dreams`：

1. 导出已结束 session 的文本，只处理上次窗口以来的新输入。
2. lead 只编排；每 transcript 一个 analyzer，Verify → Enrich → Organize；全部结束后单 organizer 去重、修链接和索引。
3. 脚本维护窗口起点；失败夜不推进、下次重试；没有新 transcript 则跳过。运行前复制 store，正常消费者以只读挂载。
4. 分组约 20 个 analyzer、少 turns、较轻 organizer 与预算上限控制成本。
5. **只有明确的较新 correction 才替代旧值，保留双方日期/来源；否则显著标 `CONFLICT`，不猜答案。**“搜索没找到”或单次随口话不能推翻已记录决策。合并保留独立有效事实；写后读回；旧文件以 `MOVED TO` stub 退役。

示例将 transcript、memory、run result 当不可信数据；仅文件工具、无 shell/web、空网络 allowlist，不写 secrets。但 prompt 防注入不是安全控制：注入仍可污染 store 或消耗预算，夜间产物可能先被任务消费再被人阅读。[Cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)，[官方安全风险](https://platform.claude.com/docs/en/managed-agents/secure-deployment-risks)。

**本仓取舍**：借鉴证据、冲突保留与单写者；首期不借鉴 analyzer 直接写 store，也不全量导出 transcript、不创建 cron。

## 5. Claude Code 历史灰度与当前未知

### 5.1 历史证据及其等级

| 等级/日期或版本                         | 发现                                                                                     | 引用                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 用户报告，2026-03 起                    | `/memory` 曾显示 auto-dream、last ran、`/dream`；也有多个版本 `Unknown skill: dream`     | [#38426](https://github.com/anthropics/claude-code/issues/38426)、[#42015](https://github.com/anthropics/claude-code/issues/42015) |
| 用户报告，v2.1.228                      | rollout gate；样本参数 minHours=24、minSessions=3、remoteEnabled=false                   | [#86209](https://github.com/anthropics/claude-code/issues/86209)                                                                   |
| 第三方 bundle 分析，v2.1.78，2026-03-17 | 默认关闭的 feature flag、24h+5 sessions、锁、forked background query、四阶段整理         | [版本分析](https://changelogs.core-directive.com/v/2.1.78/full.md)                                                                 |
| 第三方分析，2026-03-31                  | gate→24h→10min 扫描节流→5 新 session→锁；Stop hook 异步；Orient/Gather/Consolidate/Prune | [lhl 分析](https://github.com/lhl/agentic-memory/blob/main/ANALYSIS-claude-code-memory.md)                                         |
| 第三方分析，v2.1.94                     | pruning/consolidation 两模式和更窄工具限制，说明曾演化                                   | [版本分析](https://changelogs.core-directive.com/v/2.1.94/e/memory-dream-mode-background-pruning-consolidation)                    |

不能固定声称所有版本都用 5 sessions，也不能给出未经官方确认的首发版。最准确的历史描述是：**生命周期事件到来时检查间隔、新 session 与锁，不是每天某个钟点必跑，关机也不保证运行。**

### 5.2 截止研究日的冲突

- 当前 [memory docs](https://code.claude.com/docs/en/memory)、[settings reference](https://code.claude.com/docs/en/settings-reference)、[commands reference](https://code.claude.com/docs/en/commands) 未给出当前 auto-dream 的完整可用合同。
- [power user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) 目录仍有 auto-dream/`/dream`，抓取正文只实际描述 auto-memory，不能证明当前命令可用。
- [第三方设置追踪](https://changelogs.core-directive.com/reference/setting/autodreamenabled) 称设置最后见于 v2.1.283、之后未见，但另有 v2.1.285 UI 条目；口径有冲突。[官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) 未找到明确移除声明。

**未知：是否移除、改名、并入 auto-memory、仅隐藏，以及账号开关和原因。不建议绕 feature gate。**

### 5.3 本地记忆不等于无风险

官方 auto-memory 是本地 Markdown；`MEMORY.md` 注入首 200 行或 25 KB，topic 按需读。旧 transcript 受 cleanupPeriodDays 影响，但 memory 文件不因该保留期自动消失。`CLAUDE.md` 用户指令与 auto-memory 学习笔记不同，强禁止需真实 hook，而不是只依赖 context。[Memory docs](https://code.claude.com/docs/en/memory)

未找到 auto-dream 专属官方恢复、审核、隐私或计费说明，不能套用 Managed Agents 的版本机制。删除 23 文件和不透明错误重组有**单用户报告**，足以提示治理风险但不是发生率统计：[#47959](https://github.com/anthropics/claude-code/issues/47959)、[#38493](https://github.com/anthropics/claude-code/issues/38493)。模型请求会发送 prompts/outputs，本地存储不等于不出机；transcript 默认明文。[Data usage](https://code.claude.com/docs/en/data-usage)

## 6. 第三方与论文

- [grandamenium/dream-skill](https://github.com/grandamenium/dream-skill)（初始提交 2026-03-24）：Stop hook 检查 24h、flag 后下次 session 执行，90 天归档是作者规则，不是官方策略。
- [vexjoy auto-dream](https://github.com/notque/vexjoy-agent/blob/main/skills/meta/auto-dream/SKILL.md)：02:07 cron、默认 dry-run、每轮修改上限、人审冲突、archive 非删除，均是第三方治理选择。
- Kevin Lin 等，**Sleep-time Compute: Beyond Inference Scaling at Test-time**，2025-04-17，[论文](https://arxiv.org/abs/2504.13171)、[原作者代码](https://github.com/letta-ai/sleep-time-compute)：query 前预计算未来可能有用内容，实验中同等准确率 test-time compute 约降 5 倍；不是记忆清理算法。Anthropic 研究文引用它是思想关联，不能说 Dreams 直接采用其代码或保证相同收益。

## 7. 已知取舍与未知保留

可借鉴：证据/派生物分层、默认隔离提案、完整 diff、人审、explicit correction、单写者、有新增信号才工作、成本/正确率联合衡量。

不能照搬或编造：原生内部 prompt/评分/淘汰公式、默认 nightly/时区、当前 Code 可用性、自动改用户规则的授权、失败必回滚、固定收益/费用，以及“做梦训练模型权重”。本仓具体映射见 [现状](current-state.md) 与 [实施方案](implementation-plan.md)，外部产品可写不代表本仓获准写。
