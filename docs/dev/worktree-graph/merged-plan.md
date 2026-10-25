# worktree graph · 「已合入分支」标注与默认折叠（merged-plan r3 · 车道 L3）

## 0. 修订记录与用户拍板

| 版本 | 日期       | 内容                                                                                                                                                                                              |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r1   | 2026-10-25 | UI 侧 `(作者, 作者时间, 标题)` 三元组匹配。评审打回（13 条）                                                                                                                                      |
| r2   | 2026-10-25 | 按用户拍板改为 hub 侧 patch-id（`rev-list --cherry-mark`）、新 cap、R11 门禁。复审打回（2 Blocker / 3 Major / 6 Minor；上轮 #1 #3 #4 #5 #6 #9 #10 #12 #13 闭合，#2 #7 #8 #11 部分闭合）           |
| r3   | 2026-10-25 | 最后一轮（评审收敛规则：主会话自行核对闭合，不再开评审）。逐条处置 R2-1 … R2-11 见 §0.2；实验按「文件头路径 / 完整 blob 路径」重做（§2）；排期改为 #40 全部合入之后（§8.2）。基线 HEAD `302223c5` |

**用户拍板（2026-10-25，逐字转述）**

1. 改用 `git cherry`（patch-id，内容级判定）做准确判定，**可以默认折叠**；接受打破 graph「不读文件内容」约束、新增 hub 侧 git 命令、走 R11 升级门禁与新 cap。
2. 标签文字**跟随界面语言**：中文界面「已合入」/「部分已合入 k/n」，英文 `merged` / `merged k/n`；tooltip 说明判定依据。
   （这是对 AGENTS.md「紧凑内联标记只用英文 token」规则的**显式用户豁免**，仅限这两个徽章；脚注等其它紧凑标记仍用英文。）

**需求摘要**：子 agent 的隔离分支 `pi-agent-<runId>` 被主会话 cherry-pick 进 dev（线性历史、无合并边），网页 worktree graph 上旧分支是孤立平行轨道，看不出已合入。
分支照留；graph 标注「已合入」，默认折叠已合入分支，提供「显示已合入的 N 个分支」开关。
**结论**：`/api/worktree-graph` 增加可选参数 `merged=1`，新 UI 仅在 hub 声明 `wtgraph.merged.v1` 时发送。hub 在 Gl 之后追加独立预算的 **M 阶段**：
对最多 24 个窗内候选分支逐个运行钉住、中和后的 `rev-list --cherry-mark --right-only <HEAD>...<tip>`，每条结果先做属性与浅边界复核再入缓存，阶段末再整体复核一次，最后写入 payload 可选字段 `merged`。
完整响应 JSON 最终再检 512 KiB。UI 只在信息完整时折叠「明确属于已合入分支、且没有其它保留依赖」的提交。

### 0.1 决策速览

| #   | 题目     | r3 结论                                                                                                                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | 判定命令 | `rev-list --cherry-mark --right-only <H>...<B> --`。plumbing，`=`/`+` 前缀是稳定契约，分支内的 merge 提交计 `+`。`git cherry` 会跳过 merge，判得更宽；`patch-id --stable` 要管道并读全量 patch。两者都不选 |
| M2  | 位置     | 同一请求内、Gl 之后的独立 M 阶段（默认折叠需要首帧就有判定）。不带 `merged=1` 的旧请求，其路径、预算与响应逐字节不变                                                                                       |
| M3  | 中和     | L1 `--attr-source=<空树>` + `core.attributesFile=/dev/null` + 环境 `GIT_ATTR_NOSYSTEM=1`；L2 对 Cc 扫描结果 ∪ info/attributes 中的驱动名无条件置空；固定 `-c diff.external= -c core.bigFileThreshold=512m` |
| M4  | 一致性   | 每条 Gm 后复核 info/attributes 与浅边界，通过才入缓存；阶段末对全部结果（含缓存命中）再复核一次，变化或无法确认 ⇒ 整体 `skipped`、不缓存。这是「检测并丢弃」，不撤销已发生的执行                           |
| M5  | 兼容     | 新 cap `wtgraph.merged.v1`；可选顶层键 `merged` 只在请求带 `merged=1` 时出现；条目数 ≤24 + 汇总 `omitted`；`e` 全局 ≤200 个且按 tip 去重；完整响应超 512 KiB 时先裁 `e`，再整体降级为 `skipped:"bytes"`    |
| M6  | 折叠     | 只删「hub 判 `eq` 的目标分支的窗内独有提交 \ 全部保留 tip 的窗内祖先」。refs / worktree / 提交信息不完整时停止折叠、只标注                                                                                 |
| M7  | 排期     | #40（consult 删除）I4 全部合入之后再开工；冻结检查改为「本任务 diff ⊆ 声明文件域」                                                                                                                         |

### 0.2 r3 处置（复审 R2-1 … R2-11 + 部分闭合项）

| #     | 复审要点                                                                                      | r3 处置                                                                                                                                                                                                                                                                                                                     | 落点         |
| ----- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| R2-1  | >24 候选输出 `unk:"cap"`，与解析器「≤24 条」矛盾，25 个候选会让新 UI 拒收整个 payload         | 分开「最多执行 Gm 数」与「最多下发条目数」，二者都是 24；被截掉的候选**不逐条下发**，只给汇总 `omitted: n`。`skipped` 的 wire 形状固定为 `{v:1, base?, skipped, branches:[]}`；`base` 当且仅当 payload 有 `head` 时出现，且必须等于 `head.h`。测试覆盖 24 / 25 / 400 个候选                                                 | §3.2 §6      |
| R2-2  | 32 KiB 预留推导错误：`e` 按分支重复，评审构造的响应达 743,677 B                               | `e` 按 tip 去重，只挂在同 tip 的第一条目上；全体条目 `e` 合计 ≤ `WTGRAPH_MERGED_E_MAX` = 200 个；允许取子集（带 `eP:true`）。超限时先裁 `e`、保留分支判定。最后对**完整响应 JSON** 再检 512 KiB：先去掉全部 `e`，仍超则整体降级为 `skipped:"bytes"`。最坏情况算术与评审构造都进测试                                         | §3.4 §6 §9   |
| R2-3  | E5 结论不成立：完整 patch-id 路径会读 `core.bigFileThreshold`                                 | 更正 E5，保留固定 threshold。实验拆成「文件头路径 / 完整 blob 路径」：6 类驱动 × 3 个属性来源 × 2 条路径共 36 组，每组独立计数、配一个确实消费该配置的正对照、断言预期 `=`/`+`。补 strace 证据：硬化后不打开任何工作区文件和 index。§3.5 只对已验证的 git 2.53 下结论，未来版本交给 R11 门禁                                | §2 §3.5 §4   |
| R2-4  | 预算账本：首个 Gm 前已耗 6 s + fstat，不能承诺「恰好两个」；单飞等待者不受自身 deadline 约束  | 账本改为头 / 循环 / 尾三段，最坏情况可能**零个**候选得出判定，全部 `unk:"budget"`。单飞等待者用自己的 M deadline（扣掉尾段预留）竞速，超时就 `release()` 退出 join、记 unknown，不影响领头者。补测试：晚加入者、阶段末 fstat、client abort、hub dispose、pin loan 清理                                                      | §3.4 §9      |
| R2-5  | hub 先读 info/attributes、git 之后自己再读，其间变化会以旧签名入缓存；patch-id 消费二进制属性 | 实证 info/attributes 里的 `-diff` 会把 `=` 翻成 `+`（E11）。每条 Gm 后复核（重读 info/attributes 字节 + 浅边界 stat），通过才入缓存。阶段末再整体复核一次，缓存命中也要过这一关；变化或无法确认 ⇒ `skipped:"attr-changed"\|"unconfirmed"\|"shallow"`、本次结果全丢、不缓存。措辞为「检测并丢弃」。用假 fs / runner 注入测试 | §3.4 §3.6 §9 |
| R2-6  | 缓存需加总字节上限与单项拒存                                                                  | 复用 `SingleFlightCache` 的 `totalBytes`（1 MiB）；新增可选 `itemMaxBytes`（16 KiB，加法改动，缺省等于 `totalBytes`，wtdiff 行为不变）。测试覆盖淘汰、超大项不入、dispose 清空                                                                                                                                              | §3.6         |
| R2-7  | 展开态显示「隐藏 0 个」                                                                       | 分开「当前实际隐藏数 `hiddenNow`」与「收起后将隐藏数 `wouldHide`」：开关文案用后者，脚注用前者（为 0 不显示）。测试断言双向切换后的精确文案                                                                                                                                                                                 | §7.2 §7.3    |
| R2-8  | `fold off` 与 DOM 不变条件冲突                                                                | 只有「确有 `eq` 目标、但因信息不完整被阻止折叠」时才显示 `fold off`。这时必然存在 `eq`，已不在 DOM 不变条件内，两者自洽。补「全部 none + degraded」用例：DOM 与基线逐字节一致                                                                                                                                               | §7.2 §7.5    |
| R2-9  | 冻结检查与 #40 的授权改动冲突                                                                 | 排期在 #40 I4 全部合入之后，基线记作 `B40`（I4 所在提交）。冻结检查改为「`git diff --name-only B40...HEAD` ⊆ 本任务声明文件域」；bundle 增量以 `B40` 为基准；fixtures 按冻结等级核对（本任务不授权任何 fixture 改动）。写明为什么不能与 #40 并行                                                                            | §8.2 §8.3    |
| R2-10 | 暴露面不能写成「仅一比特」                                                                    | 改为如实登记：完整历史上的计数 `t/k`、补丁等价关系、部分窗内逐提交标记 `e`，可能涉及 denylist 路径下的改动；依据用户 2026-10-25 拍板（文件开头）记为已接受残余                                                                                                                                                              | §5.1         |
| R2-11 | UI 失效键：merged 能力变化不触发重拉                                                          | `useWorktreeGraph.ts` 新增 `mergedKeyOf(scope)` 监听：能力变化 ⇒ abort 在途请求，失去 cap 时立即清掉显示中的 `merged`，展开状态下立即重拉（切换 35 s / 48 s 超时）。测试：同一 agent/session 下 cap 增减                                                                                                                    | §7.1 §9      |
| #2    | 浅边界 M 阶段复核                                                                             | 随 R2-5：每条 Gm 后 + 阶段末都重 stat `shallow`                                                                                                                                                                                                                                                                             | §3.4         |
| #7    | 候选数 vs 实际隐藏数                                                                          | 随 R2-7                                                                                                                                                                                                                                                                                                                     | §7.2         |
| #8    | DOM 不变条件                                                                                  | 随 R2-8                                                                                                                                                                                                                                                                                                                     | §7.5         |
| #11   | 冻结基线                                                                                      | 随 R2-9                                                                                                                                                                                                                                                                                                                     | §8.3         |
| 文案  | patch-id 忽略空白、表达的是补丁等价；解冲突后的 cherry-pick                                   | tooltip 与 i18n 固定写「按补丁等价判定（git patch-id，忽略空白差异）」，以及「解冲突或修改后的 cherry-pick 可能计为未合入」                                                                                                                                                                                                 | §7.3         |

### 0.3 r2 评审处置（r1 → r2，留档；r3 对其中 #2 #7 #8 #11 的补完见 §0.2）

| #   | 评审要点（转述，严重度以评审原文为准）                                              | r2 处置                                                                                                                                                                                                                   | 落点      |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | 三元组是启发式、非内容级，误折叠风险                                                | **按用户拍板改为 patch-id**；三元组彻底移出判定（只作 §12 F1 的可选弱提示候选）                                                                                                                                           | §3        |
| 2   | 200 窗口 / 浅克隆下判定不完整                                                       | 判定在 hub 对**完整历史**计算，窗口只决定「哪些分支是候选」（窗外分支本就不渲染）；浅克隆 ⇒ M 阶段跳过（`skipped:"shallow"`），不做推断；部分克隆缺对象 ⇒ 该分支 `unk:"missing-object"`                                   | §3.2 §3.6 |
| 3   | 折叠可能删掉非目标提交；信息不完整时仍折叠                                          | 删除集 = ⋃ 目标分支窗内独有提交 \ anc_win(全部保留 tip)；`refsTruncated`/`refsOmitted`/`wtHeadsCapped`/`badRecords`/`parentsTruncated` 任一存在 ⇒ 不折叠只标注；性质测试「非目标提交不得消失」                            | §7.2 §9   |
| 4   | 其它 attached worktree 检出的分支未受保护（payload `wtHeads` 只含 self + detached） | hub 用 membership 全部 porcelain 行给检出分支打 `co:true`；UI 再用 `props.rows[].branch` 交叉保护；两者任一命中 ⇒ 永不折叠                                                                                                | §3.2 §7.2 |
| 5   | 降灰（40% 不透明度）合成后对比度可能 <3:1；与 merge 样式优先级                      | 改用三主题各一个实色令牌 `--gg-lane-landed`，按现有 route `stroke-opacity: .85`（`graph.css:104-105`）合成后断言 ≥3:1；`.is-landed` 禁止再叠 opacity（source-scan）；merge 规则在源码顺序上后于 landed 规则               | §7.4 §9   |
| 6   | 漏报边界（解冲突后的 cherry-pick）                                                  | patch-id 对解冲突/微调的 cherry-pick 判 `+`：单提交分支 ⇒ 不标（`none`），多提交 ⇒「部分已合入 k/n」；本仓库 `TRB8S8P8` 0/1、`PWJGMSN3` 3/5；夹具逐类钉住；是否加弱提示见 F1                                              | §2 §9 §12 |
| 7   | 候选数与实际隐藏数混用                                                              | 开关与脚注的 N = **实际被隐藏**的分支数（tip 落入删除集）；候选数、判定数只进审计                                                                                                                                         | §7.2 §7.3 |
| 8   | 「DOM 逐字节不变」的条件写错                                                        | 重写为：无 `wtgraph.merged.v1` cap ∨ payload 无 `merged` ∨（无 `eq`/`part` 判定 ∧ 无 `skipped` ∧ 无 `unk`）⇒ 与基线逐字节一致；测试按此三条钉                                                                             | §7.5      |
| 9   | 引用了不存在的「HEAD 外环 / worktree 虚线环」                                       | 改为代码实际语义：当前行 = 单元格底色（`graph.css:161-162` `tr[data-current="true"] > .gg-cell`），其它 worktree HEAD = 正文内文字徽章 `.gg-wtbadge`；SVG 无任何环（`graph.css:19-20` 注释过时，P5 顺手改正）；补几何测试 | §7.4 §9   |
| 10  | 缺性能夹具                                                                          | UI：复用两套 1000 节点压力夹具 + 400 refs + 24 判定，操作计数上界 + 耗时；hub：假时钟预算测试 + 真实 git 冒烟（24 候选 × 3 提交 / 2000 提交仓库）+ 缓存命中零 spawn                                                       | §9        |
| 11  | 冻结检查基线不固定                                                                  | 冻结路径统一 `git diff --quiet 302223c5 -- <路径>`；`tests/fixtures/` 仍按 AGENTS 原规则 `git diff --quiet origin/dev -- tests/fixtures/`                                                                                 | §8.3      |
| 12  | 预算不得自动上调                                                                    | 不上调；报告首屏 JS / lazy JS / CSS 三项增量（`vite.config.ts:105` `cssCodeSplit: false` ⇒ graph.css 进唯一 CSS 文件）；超标停工请示                                                                                      | §8.4      |
| 13  | 统计错、表格竖线未转义、章节引用错                                                  | 统计重算（§2：39 个独有提交，r1 误为 36；在窗 13 个，r1 误为 12）；表格内竖线一律 `\|`；章节引用逐条核对                                                                                                                  | 全文      |

## 1. 现状（代码坐标 @302223c5）

- 管线：`hub/worktree-graph/routes.ts` ⓪ closing → ① CSRF → ② auth（A = `WTDIFF_ADMIT_MS` 8 s）→ ③ 参数（只读 `agentKey/sessionId/wt`，其它 query 键忽略）→ ④ 限流/在途（每 principal 1、全局 2）→ ⑤ 会话 → ⑥ `createMembership`（三 fd 钉住）→
  G = `WTGRAPH_GIT_PHASE_MS` 14 s：S1 shallow stat → S2/S3 Gr → S4/S5 Gl（`SingleFlightCache`，`ps.withLoan`）→ `projectGraph` → `sendJson`。`createPinnedGit` 每条命令 spawn 前做一次 ≤2 s 的三 pin fstat。
- membership 给出 `m.rows`（全部 porcelain 行，含 attached worktree 的 `branch`）和 `m.selfIndex`；但 payload `wtHeads` 只放 self 与 detached 行（`routes.ts` `wtHeadCandidates`）。
- 可复用的 wtdiff 件：`src/git/diff.ts` 导出纯函数 `wtDiffArgs.driverScan()`（Cc）、`parseDriverScan`、`driverNamesFromAttributes`、`neutralizeArgs`、`attrSourceArgs`、`WTDIFF_EMPTY_TREE`；
  `hub/worktree-diff/git.ts` 导出 `readProcFdFile`、`attrSigOf(infoBytes, drivers)`、`WtGitCmd`（`:129`，已含 `"Gr" | "Gl"`）。wtdiff 的 `scanDriverSet` 是 `worktree-diff/routes.ts:533-567` 里的局部闭包，没法直接复用。
- `hub/worktree-diff/changeset.ts:95` `SingleFlightCache`：`ttlMs / lruMax / totalBytes / store`，超过 `totalBytes` 的单项本来就不存（`:191`），LRU 加字节淘汰（`:194`）；join 方 `release()` 后 refcount 归零就 abort（`:131-139`）；`abortAll`（`:181`）。
- `run.ts:63` minimal env 已强制 `GIT_ATTR_NOSYSTEM=1`。
- 协议严格解析：`parseWtGraphPayload` 在任意层遇到未知键 ⇒ `null`（`protocol/worktree-graph.ts:16/224-241`）。预算常量在 `:108-116`；协议测试钉 `8 + 14 + 1 = 23` 与 `23 + 10 ≤ 35`（`tests/web-hub/protocol/worktree-graph.test.ts:112-131`）。
- cap：`hub/hub.ts:492`；UI 门 `logic/gitGraphScope.ts`（main chunk）；`composables/useWorktreeGraph.ts:63-65` `scopeKeyOf` 只比 `agentKey/sessionId`，`:187-195` 键变化 ⇒ abort + idle + 收起。
- source-scan：`tests/web-hub/hub/worktree-graph/source-scan.test.ts:42-48` 要求「argv 只经 `wtGraphArgs.*`」。
- UI：`components/detail/GraphPanel.vue` 在 main chunk，懒挂 `components/graph/WorktreeGraph.vue`。`GraphLanes.vue` 只画 route / stub / fold 桩 / 点 / 折叠菱形，**没有任何环**。当前行 = 单元格底色（`graph.css:161-162`）；其它 worktree HEAD = 正文里的 `.gg-wtbadge` 文字徽章（`graph.css:234`）。
  `graph-panel.test.ts:74-84` 钉面板不 import `@logic/gitGraph`；`refChipsOf` 的输出被 `toEqual` 钉死 ⇒ 不改它。`vite.config.ts:105` `cssCodeSplit: false`。

## 2. 实证（git 2.53.0，本机临时仓库 + marker 脚本）

**路径定义**：Gm 先按「文件头」（只含改动文件名）比较 patch-id，文件集合碰撞时才读 blob 算完整 patch-id。
「文件头路径」夹具：分支改 `a.txt`，HEAD 侧只改 `z.txt`，预期 `+`。「完整 blob 路径」夹具：HEAD 侧先改 `z.txt`，再 cherry-pick 分支提交，预期 `=`。
（注：HEAD 不分叉直接 cherry-pick，会在同一秒生成与原提交完全相同的 oid，对称差为空——夹具必须先分叉。）

| #   | 实验                                                                                                                                                                                                                                                                               | 结果                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 部分克隆（promisor + `core.sshCommand` 指向 marker），两侧都改 `a.txt`，删掉右侧 blob；未硬化的 `rev-list --cherry-mark` / `git cherry`                                                                                                                                            | **marker=2**，exit 128。完整路径会读 blob 并触发 lazy fetch                                                                                                                                                                               |
| E2  | 同 E1，加 `--no-lazy-fetch`                                                                                                                                                                                                                                                        | marker=0，exit 128「unable to read <oid>」（被 `MISSING_OBJECT_RE` 覆盖）                                                                                                                                                                 |
| E3  | 同 E1，但左侧只改 `z.txt`（文件头路径）                                                                                                                                                                                                                                            | 未硬化 marker=0，exit 0：文件集不碰撞就不读 blob                                                                                                                                                                                          |
| E4  | 驱动矩阵：`filter.f.clean` / `filter.f.smudge` / `filter.f.process` / `diff.x.textconv` / `diff.external` / `diff.x.command` × 属性来源（工作区 `.gitattributes`、`info/attributes`、`core.attributesFile`；`diff.external` 不需要属性）× 两条路径，共 36 组，未硬化与硬化各跑一次 | **36 组全部 marker=0**；输出全部符合预期（文件头路径 `+`、完整路径 `=`）。每组的正对照 marker=1：clean 用 `hash-object --path`，smudge/process 用 `cat-file --filters`，textconv 用 `cat-file --textconv`，external/command 用 `git diff` |
| E5  | **更正**：`-c diff.algorithm / diff.renames / diff.context / diff.submodule / log.showSignature = bogus`                                                                                                                                                                           | 照常输出，说明不加载 diff UI 配置。**但完整路径会读 `core.bigFileThreshold`**：值为 `bogus` 时 exit 128（r2 只在文件头路径上试过，结论错了）；值为 `1` 时空白变体的 `=` 翻成 `+` ⇒ argv 固定 `512m`（git 默认值）                         |
| E6  | 分支里有一个「把 main 合进分支」的 merge                                                                                                                                                                                                                                           | `--right-only`（不加 `--no-merges`）把 merge 列为 `+`，偏保守；`git cherry` 跳过 merge                                                                                                                                                    |
| E7  | `-c diff.external=`（空值）                                                                                                                                                                                                                                                        | 正常运行，可作为固定置空项                                                                                                                                                                                                                |
| E8  | 本仓库：29 个 `pi-agent-*` 分支，39 个独有提交                                                                                                                                                                                                                                     | `=` 34 / `+` 5；`+` 里 3 个是解冲突或微调过的 cherry-pick（`bbf961af`、`b740bb3a`、`8ad6fa16`），2 个确实未合入（`b0210d2d`、`2a8eda6e`）                                                                                                 |
| E9  | 本仓库 200 窗                                                                                                                                                                                                                                                                      | 13 个 tip 在窗：`eq` 10、`part` 1（`PWJGMSN3` 3/5）、`none` 2（`GGSHPTC3` 0/1、`TRB8S8P8` 0/1）；13 条命令直接 spawn 共 798 ms                                                                                                            |
| E10 | 用真实 `layoutGraph`/`foldLayout` 模拟折叠（只拿 heads + worktree HEAD 作保留 tip）                                                                                                                                                                                                | 行 200 → 185，`laneCount` 6 → 3，≤480px 下的折叠泳道行 8 → 0                                                                                                                                                                              |
| E11 | 属性消费（完整路径，空白变体，预期 `=`）                                                                                                                                                                                                                                           | `info/attributes` 写 `*.txt -diff` ⇒ `+`，**L1 下也是 `+`**（info/attributes 是唯一残留来源）。工作区 `.gitattributes` 写 `-diff` ⇒ 未硬化 `+`、L1 下 `=`。`diff=x` + `diff.x.binary=true` ⇒ 仍是 `=`（不消费）                           |
| E12 | `strace -f -e trace=%file`：完整路径，工作区根与 `sub/` 下都放 `.gitattributes`                                                                                                                                                                                                    | 未硬化会打开工作区 `.gitattributes`（1 次）。**硬化后 0 次打开工作区文件或 `.git/index`**；只打开 `.git/{config,commondir,packed-refs,info/attributes,info/grafts}`、refs、`objects/**`、pack 与 commit-graph                             |

**命令选择**：`rev-list` 是 plumbing；`--right-only` 只列分支侧；不加 `--no-merges`，让 merge 计 `+`（E6）。`git cherry` 跳过 merge，判得更宽。
`git patch-id --stable` 要先跑 `log -p` 再走管道——否决。`--cherry-mark` 只对一个对称差有定义，所以每个候选单跑一条。

## 3. hub 侧判定（M 阶段）

### 3.1 触发条件

只有请求 query 含 `merged=1` 且路由以 `mergedEnabled` 构造（与 cap 同条件）时才进入 M 阶段。不含 `merged=1` ⇒ 完全不做（旧路径）。

| 前置不满足        | wire                                                         |
| ----------------- | ------------------------------------------------------------ |
| payload 无 `head` | `{v:1, skipped:"no-head", branches:[]}`（无 `base`）         |
| 浅克隆（S1 判定） | `{v:1, base, skipped:"shallow", branches:[]}`                |
| payload 提交为空  | `{v:1, skipped:"no-head", branches:[]}`（空仓库必然无 head） |

### 3.2 候选与条目上限（新文件 `hub/worktree-graph/merged.ts`，纯函数 `mergedCandidates(payload, rows)`）

输入是 **`projectGraph` 之后**的 payload（只看真正下发的提交与 refs）以及 `m.rows`：

1. `refs` 中 `k === "branch"` 且 `h ∈ commits`；
2. 去掉 `n === head.b` 和 `h === head.h`；
3. 去掉窗内祖先（`h ∈ anc_win(head.h)`）。窗内可达判定是精确的：date-order 前缀对子代封闭，窗内两点之间任一路径上的节点都是终点的子代，因此都在窗内。这些分支没有独有提交，不跑命令、不下发条目；
4. `co:true` 标记：`n` 等于 `m.rows` 任一行的 `branch`（**包括其它 attached worktree**）。照常判定（可以标注），但 UI 永不折叠；
5. 按行号升序（最新在前）排序，取前 `WTGRAPH_MERGED_MAX = 24` 个作为「被选候选」，其余计入 `omitted`。**被截掉的候选不逐条下发**。

同 tip 的多个分支共享一次 Gm（按 `h` 去重执行），但各自都有条目。argv 里的值只来自 git 自己的输出：`head.h` 来自 membership porcelain，`h` 来自 Gr 快照，都已过 hex 校验（I3 不变）。

### 3.3 冻结 argv（`src/git/graph.ts`，逐字节单测）

```
Gm = GB                                              # 现有：WT_PINNED_PREFIX --no-lazy-fetch --no-replace-objects --no-pager -c core.hooksPath=/dev/null
     + attrSourceArgs(format)                        # L1：--attr-source=<WTDIFF_EMPTY_TREE[format]> -c core.attributesFile=/dev/null
     + neutralizeArgs(drivers)                       # L2：每个驱动名 filter.<n>.{clean,smudge,process}= filter.<n>.required=false diff.<n>.{textconv,command}=
     + -c diff.external= -c core.bigFileThreshold=512m
     + rev-list --cherry-mark --right-only <H>...<B> --
```

- `wtGraphArgs.cherry(head, tip, format, drivers)`：`head`/`tip` 不是 `format` 长度的 hex ⇒ 抛异常（调用方 bug，fail-closed）。
- `wtGraphArgs.driverScan()`：逐字节委托 `wtDiffArgs.driverScan()`，使 source-scan 规则「argv 只经 `wtGraphArgs.*`」继续成立。
- `parseCherryMark(stdout, capped, format)` → `{ eq: string[]; plus: string[] } | { bad: true }`：逐行匹配 `^[=+]<hex>$`，任何异常行 ⇒ `bad`；`capped` 由调用方判为 `unk:"too-many"`。
- boundary：`graph.ts` 仍只 import `./diff.js`（新增值导入 `attrSourceArgs`、`neutralizeArgs`、`WTDIFF_EMPTY_TREE`、`wtDiffArgs`），闭包表不变。

### 3.4 步骤、预算账本与一致性复核

S5 Gl → `projectGraph(…, maxBodyBytes: WTGRAPH_BODY_MAX_BYTES − WTGRAPH_MERGED_MAX_BYTES)`（只有 `merged=1` 时缩小；旧路径参数不变）→ 新建 **M = `WTGRAPH_MERGED_PHASE_MS` 14 s**，与 G 互相独立（同 G 独立于 A 的做法）：

| 段   | 步骤                                                                                                                                                                                                       | cap                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 头   | H1 三 pin fstat → H2 Cc（`wtGraphArgs.driverScan()`，stdout ≤64 KiB）→ H3 读 `/proc/self/fd/<common.fd>/info/attributes`（`readProcFdFile` ≤64 KiB，ENOENT = 空）⇒ 快照 `sig0 = attrSigOf(info0, drivers)` | 各 `min(M.remaining − TAIL, 2 s)`；头段失败或超时 ⇒ 整阶段 `skipped:"unconfirmed"`                                              |
| 循环 | 按 §3.2 顺序逐个去重后的 tip：缓存命中直接用；未命中 ⇒ 单飞 compute = 三 pin fstat → Gm → **逐条复核**（重读 info/attributes 字节 = `info0`，且 `shallow` 仍为 ENOENT）→ 通过才返回（返回即入缓存）        | fstat 与 Gm 各 `min(M.remaining − TAIL, WTGRAPH_CHERRY_MS 2 s)`；复核两个 fs 步各 ≤2 s；剩余 < 250 ms ⇒ 余下候选 `unk:"budget"` |
| 尾   | T1 重读 info/attributes → T2 重 stat `shallow`                                                                                                                                                             | 预留 `WTGRAPH_MERGED_TAIL_MS` 4 s（两步各 ≤2 s）                                                                                |

- **整体复核（尾段）**：`info` 字节 ≠ `info0` ⇒ `skipped:"attr-changed"`；`shallow` 出现 ⇒ `skipped:"shallow"`；任一步超时、io 失败或被 abort ⇒ `skipped:"unconfirmed"`。三种情况都 `branches:[]`，**本次结果全部丢弃（包括缓存命中）**，并写 `wtgraph.merged_discarded` 告警。
  逐条复核失败 ⇒ compute 抛 `MergedRecheckError` ⇒ 该 tip 记 `unk:"attr-changed"` 且不入缓存（`SingleFlightCache` 只在 compute 成功时 `store`，见 `changeset.ts:154`）。
  这是**检测并丢弃**：复核无法撤销已经发生的执行，只保证被改动的属性快照下算出的结果不会被缓存或下发。
- **为什么只复核 info/attributes 与 shallow**：L1 之后影响结果的属性来源只剩 info/attributes（E11）；`diff.<n>.binary` 不被消费（E11）；`core.bigFileThreshold` 已由 argv 固定；textconv / 命令 / filter 已被 L2 置空，且 E4 显示今天本就不执行。
- **结果分类**（先看 capped/killed，再看退出码；同 §2.3 纪律）：capped ⇒ `unk:"too-many"`；Gm 超时 ⇒ `unk:"timeout"`；`classifyGraphExit` = `missing-object` ⇒ `unk:"missing-object"`；129 ⇒ 整阶段 `skipped:"git-too-old"`；其它非零或 `bad` ⇒ `unk:"git-failed"`。**任何失败都是未知，永不当作已合入。**
- **判定**：`t = |eq| + |plus|`，`k = |eq|`。`t = 0` ⇒ `anc`（请求期间 HEAD 前进了）；`k = t` ⇒ `eq`；`0 < k < t` ⇒ `part`，附 `e` = `eq ∩ commits`；`k = 0` ⇒ `none`。
- **单飞等待者（R2-4）**：缓存键见 §3.6。join 方 `await race(acquired.promise, ownDeadline(M.remaining − TAIL), signal)`；自身先超时 ⇒ `acquired.release()`、该 tip 记 `unk:"timeout"`。领头者的执行只受领头者自己的 deadline 与剩余 refcount 约束（`changeset.ts:131-139`），执行期间由 `ps.withLoan` 持有 pin。
  client abort ⇒ 本请求 release 全部 join；refcount 归零 ⇒ abort 共享执行。hub dispose ⇒ `abortAll("hub-close")`。
- **账本**（协议测试按真实算术钉）：头段最坏 6 s（fstat 2 + Cc 2 + 读 2），尾段 4 s，循环最少 `14 − 6 − 4 = 4 s`；每个候选最坏要 fstat 2 + Gm 2 + 复核 4，所以**最坏情况可能零个候选得出判定**（全部 `unk:"budget"`），不对数量做任何承诺。
  服务端墙钟 `8 + 14 + 14 + 1 = 37 s`；`37 + WTDIFF_TRANSFER_RESERVE_MS(10) = 47 ≤ WTGRAPH_MERGED_CLIENT_TIMEOUT_MS = 48 s`。只有 `merged=1` 的请求用这个超时，旧的 `23`、`33 ≤ 35` 关系不动。典型情况下各步都是毫秒级（E9：13 条直接 spawn 共 798 ms）。
- **字节（R2-2）**：先组装 `merged`：`e` 按 tip 去重，只挂在同 tip 第一条目上；全局按条目顺序累计，最多 `WTGRAPH_MERGED_E_MAX = 200` 个，被裁的条目加 `eP:true`（表示 `e` 只是子集）。
  然后对**完整响应**做一次 `JSON.stringify` 量字节：> `WTGRAPH_BODY_MAX_BYTES` ⇒ 去掉全部 `e`（各 `part` 条目标 `eP:true`）后重量；仍超 ⇒ `merged = {v:1, base, skipped:"bytes", branches:[]}`。
  最坏情况：基础 payload ≤ 512 KiB − 32 KiB = 491,520 B；`merged` ≤ 24 × (200 B 名 + 66 B oid + 约 90 B 字段) + 200 × 67 B + 约 120 B 外壳 ≈ 22.1 KB < 32 KiB。降级只是兜底，测试会断言它在构造出的最坏情况下也成立。

### 3.5 中和的依据与边界（只对 git 2.53 成立）

E4 在 git 2.53 上表明：两条路径下 Gm 都不执行任何 filter / textconv / 外部 diff / diff 命令；E12 表明硬化后不读工作区与 index。但 Gm 确实读 blob（E1），也确实消费属性（E11）。
所以：L1 去掉仓库提交可控的属性来源（还使结果不受工作区 `.gitattributes` 影响，E11）；L2 把配置与 info/attributes 中出现的全部驱动名置空，外加 `diff.external=`；argv 固定 `core.bigFileThreshold`。
以上结论**只针对已验证的 git 2.53**，不对未来版本做任何保证。新版本由 §4.2 的 R11 门禁复核：E4 的 36 组矩阵连同正对照、E12 的文件访问跟踪、E1/E2 配对，在同一 PR 重跑。

### 3.6 缓存（R2-6）

- 实现：复用 `SingleFlightCache<MergedValue>`（`store:true`，`ttlMs` 10 min，`lruMax` 1024，`totalBytes` 1 MiB）。在 `hub/worktree-diff/changeset.ts` 的构造参数里**加法新增**可选 `itemMaxBytes`：缺省等于 `totalBytes`，wtdiff 两处实例不传，行为逐字节不变；graph 传 16 KiB，超过的结果照常返回但不入缓存。
  每次 `createWorktreeGraphRoutes` 新建一个实例（I4）；`dispose` 调 `abortAll` 并清空。
- 键 = `ids.common(dev:ino) \0 format \0 H \0 B \0 sig0`，其中 `sig0 = attrSigOf(info0, drivers)`，已含 info/attributes 字节摘要与排序后的驱动名。值 = `{ eq: string[]; plus: number }`。键与值都不进日志。
- 只缓存「exit 0、未 capped、逐条复核通过」的结果；未知结果从不缓存。缓存命中照样要过尾段整体复核才会下发。
- 为什么 TTL 可以比 wtdiff 的 5 s（`WTDIFF_CHANGESET_TTL_MS`）长：Gm 结果是两个不可变 oid 的纯函数，对象不变、replace 关闭，属性来源被钉住并进了键，threshold 由 argv 固定。wtdiff 的 TTL 短是因为工作区会变。残余：`.git/info/grafts` 改写历史（E12 显示会被读取；Gl 同样受影响，属同一残余）。
- 典型重拉（status 变化后 3 s 去抖）：头段 + 全部缓存命中 + 尾段 ⇒ 零 Gm spawn（测试钉）。

### 3.7 审计（`hub/audit.ts`，只追加计数键）

`WTGRAPH_AUDIT_KEYS` 尾部追加 `mergedReq, mergedCand, mergedOmitted, mergedRun, mergedHit, mergedUnk, mergedSkip, mergedMs`；永不记分支名、oid、驱动名。
`WtGitCmd`（`hub/worktree-diff/git.ts:129`）追加 `"Gm"`（Cc 已在联合内）。告警事件：`wtgraph.merged_discarded`（字段只有 `reason`）。

## 4. 执行 / 读取面矩阵与 R11 门禁

### 4.1 plan §2.3 矩阵：新增 Gm 列

| 面                                                        | Gm（git 2.53）                                   | 关闭 / 约束手段                                      | 证据 / 测试                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| promisor lazy fetch → transport/ssh                       | **是**（完整路径读 blob）                        | `--no-lazy-fetch`（GB 已有）                         | E1/E2 配对：未硬化 marker=2，硬化 0 + `missing-object`                                                                                                                   |
| filter clean / smudge / process                           | 否（E4，两条路径 × 三个来源）                    | L1 + L2                                              | 36 组矩阵，每组配正对照（`hash-object --path` / `cat-file --filters`）                                                                                                   |
| diff textconv / `diff.<n>.command` / `diff.external`      | 否（E4）                                         | L1 + L2 + `-c diff.external=`                        | 同上（`cat-file --textconv` / `git diff` 正对照）                                                                                                                        |
| 属性读取                                                  | **是**（E11：`-diff` 改变结果）                  | L1 收缩到只剩 info/attributes；逐条 + 尾段复核其字节 | E11 断言；假 fs 注入「Gm 期间 info/attributes 变化」⇒ 不缓存、`skipped:"attr-changed"`                                                                                   |
| `core.bigFileThreshold`                                   | **是**（E5 更正）                                | argv 固定 `512m`                                     | 用户配置 `=1` 时结果仍与默认一致（测试）                                                                                                                                 |
| diff UI 配置（algorithm / renames / context / submodule） | 否（E5）                                         | —                                                    | bogus 值不报错（测试钉住，便于升级时发现变化）                                                                                                                           |
| gpg / mailmap / notes                                     | 否                                               | —                                                    | `log.showSignature=true` + 绝对路径 `gpg.program` marker=0                                                                                                               |
| replace refs                                              | 是                                               | `--no-replace-objects`                               | 配对：`git replace` 一个等价提交，未硬化判定改变、硬化不变                                                                                                               |
| 工作区 / index 读取                                       | 未硬化读工作区 `.gitattributes`；硬化后否（E12） | L1；不带 pathspec，以 `--` 终止                      | 集成测试：`strace -f -e trace=%file`（无 strace 时 skip 并注明原因）断言 0 次打开工作区路径与 `.git/index`；外加 `chmod 000` 工作区 `.gitattributes` 与 index 后判定不变 |
| hooks / fsmonitor / pager                                 | 否                                               | GB + run.ts 前置                                     | 沿用                                                                                                                                                                     |
| 对象 / ref / index 写入                                   | 否                                               | 只读子命令                                           | `.git/objects` 清单、packed-refs、index 前后相等                                                                                                                         |
| `info/grafts`、trace2                                     | 读 grafts（E12）/ 可能写 trace2                  | 不处理                                               | 残余（与 Gr/Gl/wtdiff 相同）                                                                                                                                             |

### 4.2 R11 条目（写入 `docs/dev/worktree-diff/README.md` 的「Worktree graph」段）

升级 git 基线，或改动 Gr / Gl / Gm / Cc 任一 argv 时：

1. 复核 `git help config` 中 rev-list、patch-id 与 diff 机器新增的键：会执行外部程序的、会触发传输的、会写文件的、会改变 patch-id 结果的（参照 `core.bigFileThreshold` 这类）；
2. 更新 §4.1 矩阵，补「未硬化对照 + 硬化」配对测试；
3. 重跑 E4 的 36 组驱动矩阵（任一正对照 < 1 ⇒ 夹具失效、测试无效，必须先修夹具）、E11 属性消费、E12 文件访问跟踪；
4. 同一 PR 跑 `tests/integration/{git-graph,git-graph-cherry,web-hub-worktree-graph}.test.ts`。

graph 现在**消费**（但不扩展）`WTDIFF_DRIVER_NAME_RE` 与 Cc 正则：为 wtdiff 扩展它们时自动覆盖 Gm；不得为 graph 单独放宽。

## 5. 威胁模型与措辞改写

### 5.1 暴露面（R2-10，与 wtdiff A1 (a) 对齐）

- **LAN 同宽**：`wtgraph.merged.v1` 与 `wtgraph.v1` 同条件声明；`webHub.preview:"loopback"` ⇒ LAN 无 cap、端点 404。不新增设置。
- **当前 HEAD 钉住**：上游 = 本请求 membership 读到的 HEAD oid（`merged.base`，解析器校验它等于 `head.h`）。请求方不能指定任意上游或分支。
- **服务端计算、不回传内容**：不返回路径、行内容或 patch 文本。
- **新增资产（如实登记）**：每个被选分支在**完整历史**上的计数 `t`（分支侧提交数）与 `k`（补丁等价数）；分支与 HEAD 之间的**补丁等价关系**；`part` 分支在窗内的逐提交等价标记 `e`；以及 `co`（是否被某个 worktree 检出）。
  这些量由 blob 内容推导而来，**可能涉及 denylist 路径下的改动**：比如一个只改了 denylist 文件的提交可以被标为「已合入」，从而透露「两次改动的补丁等价」。wtdiff 的 denylist 作用于「列出的路径与内容」，Gm 两者都不产生，无法也不做逐文件过滤。
  用户 2026-10-25 已拍板接受服务端 patch-id 判定（见文件开头），此项记为**已接受残余**。
- **为什么仍要中和驱动**：威胁是执行，不是外泄。被 fetch 进来的分支可以在提交里的 `.gitattributes` 写 `diff=<任意名>`，用户全局配置里也常有 textconv / LFS filter；Gm 在 hub 进程里读这些分支的 blob。
  git 2.53 下 patch-id 不走这些路径（E4），但这正是 R11 要盯的「升级后悄悄变化」。L1 让提交可控的属性来源失效，L2 让配置里的命令无事可做。

### 5.2 「graph never reads file contents」等表述的改写清单（P6）

| 位置                                                        | 处理                                                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dev/worktree-diff/README.md:45`                       | 改为：graph 只在 Gm（`rev-list --cherry-mark`）里读取 commit/tree/blob 对象，带 L1 + L2 中和与属性复核；不读工作区文件或 index，不回传路径或内容，不采集专用 email 字段 |
| `docs/dev/worktree-graph/plan.md:25`（§0.2 Q1 逐字裁定）    | 原文不改；后面追加「2026-10-25 补充裁定：允许 Gm 读取对象内容计算 patch-id，见 merged-plan r3」                                                                         |
| `docs/dev/worktree-graph/plan.md:69`（§2.2 字段与隐私措辞） | 追加一句，指向 Gm 例外                                                                                                                                                  |
| `docs/dev/worktree-graph/plan.md:264`（I2）                 | 改为「只读、不读工作区；对象内容只在 Gm 内读取且已中和；无 lazy fetch / transport / gpg / hook / pager」                                                                |
| `docs/dev/worktree-graph/plan.md:326`（#10 处置表）         | 历史记录不改，表后加脚注                                                                                                                                                |
| `docs/dev/worktree-graph/acceptance.md:33`                  | 重写暴露面段落，按 §5.1 列出新增资产                                                                                                                                    |
| `src/git/graph.ts` 文件头「Two frozen, pinned commands」    | 改为四条（Gr / Gl / Gm / Cc 委托），并说明 Gm 读对象                                                                                                                    |

## 6. 协议与兼容（P0，`src/web-hub/protocol/worktree-graph.ts` 只追加）

```ts
export const WTGRAPH_MERGED_QUERY = "merged"; // 值固定为 "1"
export const WTGRAPH_MERGED_MAX = 24; // 最多执行的去重 tip 数 = 最多下发的条目数
export const WTGRAPH_MERGED_E_MAX = 200; // 全体条目 e 元素合计上限
export const WTGRAPH_CHERRY_MS = 2_000;
export const WTGRAPH_CHERRY_MAX_BYTES = 64 * 1024;
export const WTGRAPH_MERGED_PHASE_MS = 14_000;
export const WTGRAPH_MERGED_TAIL_MS = 4_000;
export const WTGRAPH_MERGED_MAX_BYTES = 32 * 1024; // merged=1 时从 512 KiB 中预留
export const WTGRAPH_MERGED_CLIENT_TIMEOUT_MS = 48_000;
export type WtGraphMergedKind = "eq" | "part" | "none" | "anc" | "unk";
export type WtGraphMergedUnknown = "budget" | "timeout" | "too-many" | "missing-object" | "git-failed" | "attr-changed";
export type WtGraphMergedSkip =
  "no-head" | "shallow" | "filter-config" | "git-too-old" | "attr-changed" | "unconfirmed" | "bytes";
export interface WtGraphMergedEntry {
  n: string; // 本地分支短名；必须与 refs 中一条 k:"branch" 同名同 h
  h: string;
  v: WtGraphMergedKind;
  k?: number; // eq/part/none：等价数
  t?: number; // eq/part/none：分支侧提交总数（含 merge）
  e?: string[]; // 仅 part，且只出现在同 h 的第一条目上：落在 commits 内的等价提交 oid
  eP?: true; // e 是子集（被全局上限或字节降级裁过）
  co?: true; // 被某个 worktree 检出
  why?: WtGraphMergedUnknown; // 仅 unk
}
export interface WtGraphMerged {
  v: 1;
  base?: string; // 当且仅当 payload.head 存在；等于 head.h
  skipped?: WtGraphMergedSkip; // 存在 ⇒ branches 必须为 []
  branches: WtGraphMergedEntry[]; // ≤ WTGRAPH_MERGED_MAX
  omitted?: number; // 超出上限、未执行也未下发的候选数（>0 才出现）
}
// WtGraphPayload 追加 `merged?: WtGraphMerged`
```

- **解析器**：`TOP_KEYS` 加 `merged`，新增 `MERGED_KEYS` / `MERGED_ENTRY_KEYS` 白名单，并做以下一致性检查：
  - `base` ⇔ `head`，且 `base === head.h`；
  - `skipped` ⇒ `branches.length === 0`；`branches.length ≤ 24`；`omitted` 为正整数；
  - 每条的 `n/h` 对应 refs 中一条 branch，且 `n` 不重复；
  - `v` 与 `k/t/e/eP/why` 的搭配合法（`eq` ⇒ `k = t ≥ 1`；`part` ⇒ `0 < k < t`；`none` ⇒ `k = 0 < t`；`anc` / `unk` ⇒ 无 `k/t/e`；只有 `unk` 带 `why`）；
  - `t ≤ WTGRAPH_CHERRY_MAX_BYTES / 41`；`e` 只出现在 `part` 上，`e ⊆ commits[].h`，`|e| ≤ k`；同一 `h` 只有第一条目可带 `e`，且同 `h` 的条目 `v/k/t` 一致；
  - 全体 `Σ|e| ≤ 200`。
- `version.ts` 尾部追加 `WTGRAPH_MERGED_HUB_CAP = "wtgraph.merged.v1"`；`hub.ts:492` 在同一条件下追加。无新帧，不升 PROTO（I10）。

| 组合           | 行为                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧 UI × 新 hub | 旧 UI 不认识 cap，不发 `merged=1` ⇒ hub 走旧路径，响应与 `B40` 逐字节相同（集成测试钉）                                                     |
| 新 UI × 旧 hub | 无 cap ⇒ 不发 `merged=1`，用 35 s 超时，行为同今天；即使误发，旧 hub 也会忽略未知 query 键                                                  |
| 新 UI × 新 hub | 发 `merged=1`，用 48 s 超时。合法的 `merged` 永远能过新解析器（24/25/400 候选、`skipped` 各形状都有测试）；解析失败仍按现有严格语义进错误态 |

## 7. UI 设计

### 7.1 门、传输与失效键（P4，R2-11）

- `logic/gitGraphScope.ts`：`GraphScope` 加 `merged: boolean`（caps 含 `wtgraph.merged.v1`）。
- `transport/types.ts` 的 `graph(req & { merged?: true })`；`logic/{token,password}-client.js` 的 `wtgraphGet` 按 `merged` 附加 `&merged=1` 并改用 48 s 超时；`transport/{token,password}.ts`、`logic/contract.js`、`composables/useHub.ts` 透传。
- `composables/useWorktreeGraph.ts`：`scopeKeyOf` 保持不变（agent / session 变化仍走原逻辑：abort + idle + 收起）。新增 `mergedKeyOf(scope) = scope?.merged ? "1" : "0"` 监听，变化时：
  ① abort 在途请求；② 失去 cap ⇒ 立刻把显示中数据的 `merged` 去掉（`{...data, merged: undefined}`），UI 当即回到无标注、无折叠；③ 已展开 ⇒ 立即按新能力重拉（URL 与超时随之切换），不收起；未展开 ⇒ 只标脏，下次展开再拉。

### 7.2 逻辑（P3，新 `ui/src/logic/gitGraphMerged.ts`，纯函数、never throws，只被 `components/graph/*` import）

```ts
export interface MergedView {
  byBranch: Map<string, WtGraphMergedEntry>; // 只收 n/h 与 refs 一致的条目
  landed: Set<string>; // eq 分支的窗内独有提交 ∪ part 的 e
  targets: string[]; // 可折叠：v==="eq" 且不受保护
  foldBlocked?: "refs" | "wtheads" | "records" | "parents"; // 仅当 targets 非空且信息不完整时才有值
}
export function mergedViewOf(p: WtGraphPayload, rows: readonly WorktreeRowWire[]): MergedView;
export function foldMerged(
  p: WtGraphPayload,
  v: MergedView,
  show: boolean,
): { commits: WtGraphCommit[]; hiddenNow: string[]; wouldHide: string[]; hiddenCommits: number };
export function mergedBadgeOf(
  p: WtGraphPayload,
  v: MergedView,
  h: string,
): { kind: "eq" | "part"; k: number; t: number; branches: string[] } | null;
```

- **保护（永不进 targets）**：`head.b`；`co:true`；与 `props.rows[].branch` 任一相等；`h` 等于任一 `wtHeads[].h`。
- **停止折叠**：targets 非空时，若存在 `degrade.refsTruncated` 或 `refsOmitted`（→`refs`）、`wtHeadsCapped`（→`wtheads`）、`badRecords`（→`records`）、`parentsTruncated`（→`parents`），就设 `foldBlocked`，不删任何提交，徽章照常显示。
  `more` / `logCapped` / `trimmed` / `shallow` 只截尾部，前缀性质不变，不阻止折叠。targets 为空时 `foldBlocked` 恒为 undefined（R2-8）。
- **删除集**：`keepTips` = `head.h` ∪ `wtHeads[].h` ∪ 全部 tag ∪ 全部 remote（除了「与 target 同名同 h 的 `<R>/<n>`」）∪ 全部非 target 本地分支。
  `D = (⋃_{B∈targets} anc_win(B.h)) \ anc_win(keepTips)`；结果是 `commits.filter(c ∉ D)`，保持原顺序。
- **两个计数（R2-7）**：`wouldHide = targets.filter(B ⇒ B.h ∈ D)`，与 `show` 无关；`hiddenNow = show ? [] : wouldHide`。target 的 tip 因为被保留 tip 依赖而不在 D 里时，它不计数，照常显示（带徽章）。
- 复杂度：keep 集一次 BFS，每个 target 一次 BFS（遇到 keep 集即停）⇒ ≤ (targets + 1) × (N + E)；`ops` 计数器供上界测试。

### 7.3 呈现（P5）

- **工具行**（`.gg-merged-bar`，仅在 `wouldHide.length > 0` 时渲染）：按钮 `<button class="gg-merged-toggle" :aria-pressed="show">`。
  `show=false` 时文案为 `graph.mergedShow`「显示已合入的 {wouldHide} 个分支」；`show=true` 时为 `graph.mergedHide`「隐藏已合入的 {wouldHide} 个分支」。
  `show` 是组件内的 `ref(false)`，不记忆（F3）。组件收起后仍保持挂载（`GraphPanel.vue` `v-if="open || component !== null"`），所以同页收起再展开会保留选择。
- **脚注**（英文 token，紧凑规则不豁免）：`hiddenNow > 0` ⇒ ` · {hiddenNow} merged hidden`；有 `skipped` 或 `unk` ⇒ ` · merged ? {m}`（m = unk 条数，skipped 时为 `skipped`）；`foldBlocked` ⇒ ` · fold off`。
- **徽章**（用户拍板 ②，跟随界面语言）：`eq` ⇒ zh「已合入」/ en `merged`；`part` ⇒ zh「部分已合入 {k}/{t}」/ en `merged {k}/{t}`；`none` / `anc` / `unk` 不显示。放在分支芯片之后、`+n` 之前，不占 ≤3 芯片的名额。≤480px 不显示徽章（移动端本就只留 HEAD 芯片）。
- **tooltip**（`title`）：
  - eq：「按补丁等价判定（git patch-id，忽略空白差异）：本分支独有的 {t} 个提交在 {head} 中都有补丁等价的提交」；
  - part：「按补丁等价判定（git patch-id，忽略空白差异）：本分支独有的 {t} 个提交中有 {k} 个在 {head} 中有补丁等价的提交；解冲突或修改后的 cherry-pick 可能计为未合入」；
  - `eP` 时追加「（窗内逐提交标记不完整）」。
- **landed 行**（展开显示时）：`tr.is-landed .gg-sub { color: var(--c-text-2) }`；点和从该行出发的 route 改用 `--gg-lane-landed` 着色，几何不变；sr 追加 `graph.srLanded`「已合入 HEAD（补丁等价）」。
  `part` 分支只有 `e` 里的提交算 landed；`eP` 时未列出的提交按未合入显示。
- **i18n**（`i18n/{en,zh}/graph.ts`）新增键：`mergedShow`、`mergedHide`、`mergedBadge`、`mergedBadgePart`、`mergedTitle`、`mergedTitlePart`、`mergedTitlePartial`、`srLanded`、`footMergedHidden`、`footMergedUnknown`、`footFoldOff`。

### 7.4 对比度、优先级与几何

- 新令牌 `--gg-lane-landed`：在 `tokens.css` 三个主题块各加一个实色值（light `:root`、系统暗色 `@media … :root:not(.theme-light)`、`:root.theme-dark`）。
  `graph-tokens-contrast.test.ts` 追加两条：route 按现有 `stroke-opacity: .85`（`graph.css:104-105`）与 `--c-surface` 合成后 ≥3:1；点（不透明）直接 ≥3:1。
- source-scan（`graph.css`）：与 `.is-landed` 相关的规则不得出现 `opacity` / `stroke-opacity` / `fill-opacity`；`tr.is-merge .gg-sub` 规则在源码中位于 `tr.is-landed .gg-sub` 之后，且选择器特异性相同。构造上 merge ∩ landed = ∅（merge 恒为 `+`），规则顺序只是兜底。
- 现有语义以代码为准：当前行 = 单元格底色；其它 worktree HEAD = 正文里的 `.gg-wtbadge` 文字徽章；merge 行 = `--c-text-3` 正文 + 空心点；SVG 里没有环。P5 顺手修正 `graph.css:19-20` 中已过时的「SVG outer ring / dashed ring」注释。
- 几何测试（用 `injectedCenters`）：同一可见集上，landed 与否时点的 `cx/cy/r` 和 route 的 `d` 完全相同，只有颜色类不同；插入徽章不改变 `rowLaneExtent` 与 `subjectStyle` 的 padding；折叠视图里点的 `cy` 等于过滤后各行的注入中心。

### 7.5 DOM 不变条件（R2-8）

以下任一成立 ⇒ `WorktreeGraph` 的 DOM 与 `B40` 基线逐字节一致：

1. 没有 `wtgraph.merged.v1` cap；
2. payload 里没有 `merged`；
3. `merged` 没有 `skipped`，且所有条目的 `v ∈ {none, anc}`。

`foldBlocked` 只在 targets 非空时出现，而 targets 非空意味着存在 `eq`，已经不满足条件 3，因此与本条件不冲突。测试三条各一例，另加「全部 none + `refsOmitted` degraded」⇒ 逐字节一致、无 `fold off`。

## 8. 拆包、排期、冻结检查与预算

### 8.1 包（车道 L3；每包返回后立即派 verifier，验收模型 ≠ 开发模型）

```
Wave 1：P0 协议 ∥ P1 git 层      Wave 2：P2 hub 路由 ∥ P3 UI 逻辑 ∥ P4 UI 传输      Wave 3：P5 UI 组件      Wave 4：P6 文档与验收
```

| 包                 | 文件域                                                                                                                                                                                                                                                                                                                                                     | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 验收命令                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 协议            | `protocol/worktree-graph.ts`、`protocol/version.ts`（尾部追加）；`tests/web-hub/protocol/worktree-graph.test.ts`（追加）                                                                                                                                                                                                                                   | 解析器每条拒绝条件一例（§6 全部一致性规则）；合法形状：24 条、24 条 + `omitted:1`、24 条 + `omitted:376`、每种 `skipped` 的 `branches:[]`（有 / 无 `base`）、同 tip 共享 `e`、`eP`；旧 payload（无 `merged`）解析结果不变；账本 `37`、`47 ≤ 48` 与旧的 `23`、`33 ≤ 35` 并存                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `npx vitest run tests/web-hub/protocol && npm run typecheck`                                                                                                                                                                             |
| P1 git 层          | `src/git/graph.ts`；新 `tests/integration/git-graph-cherry.test.ts`；`tests/git/graph.test.ts`（追加）                                                                                                                                                                                                                                                     | argv 逐字节：L1 sha1/sha256 空树；L2 0/1/16 个驱动名；`diff.external=`、`bigFileThreshold=512m`、`<H>...<B> --`。`driverScan()` 与 `wtDiffArgs.driverScan()` 逐字节相等。`parseCherryMark`：`=`/`+`、坏行、capped、sha256。集成测试（`skipIf(!hasGit)`）：E1/E2 配对；E4 的 36 组 + 正对照 + 预期输出；E5 threshold 固定；E11 属性消费；E12 strace（`skipIf(!hasStrace)`）+ `chmod 000` 兜底；replace 配对；gpg；无写入；判定夹具见 §9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `npx vitest run tests/git tests/integration/git-graph.test.ts tests/integration/git-graph-cherry.test.ts tests/web-hub/boundary.test.ts && npm run typecheck`                                                                            |
| P2 hub 路由        | `hub/worktree-graph/routes.ts`；新 `hub/worktree-graph/merged.ts`；`hub/worktree-graph/project.ts`（只用已有的 `maxBodyBytes` 参数）；`hub/worktree-diff/changeset.ts`（`SingleFlightCache` 加法新增可选 `itemMaxBytes`）；`hub/worktree-diff/git.ts`（`WtGitCmd` 加 `"Gm"`）；`hub/hub.ts`（cap 一行 + 构造参数）；`hub/audit.ts`（键追加）；对应测试文件 | `routes.test`：无 `merged=1` ⇒ 假 runner 调用序列与响应字节同基线；`skipped` 全部七种的 wire 形状；候选规则（HEAD 分支、祖先、`co`、24/25/400 候选 ⇒ 条目 24 + `omitted`）；同 tip 只跑一次 Gm；各 `unk` 分类；逐条与尾段复核（假 fs 在 Gm 之后改 info/attributes / 创建 shallow / 读超时 ⇒ 不缓存 + 对应 skipped）；缓存（第二次零 Gm spawn、未知不缓存、`itemMaxBytes` 超大项不入、`totalBytes` 淘汰、TTL、dispose 清空）；字节（评审构造的「24 分支同一 part tip、各 150 窗内 oid」⇒ e 只出现一次、完整 JSON ≤512 KiB；人为放大基础 payload ⇒ 先去 e、再 `skipped:"bytes"`）；`budget.test` §3.4 假时钟（头段用满 6 s ⇒ 零个判定、全部 `unk:"budget"`、墙钟 ≤37 s；阶段末 fstat 卡死 ⇒ 该 tip `unk:"budget"`）；单飞（晚加入者共享结果；等待者自身 deadline 先到 ⇒ release + `unk:"timeout"`，领头者照常完成并入缓存；领头 client abort 而等待者仍在 ⇒ 执行继续；全部断开 ⇒ abort；hub dispose ⇒ abortAll；每种结局 pin loan 都释放）；`source-scan` 允许 `wtGraphArgs.cherry` / `driverScan`；`api-worktree-graph.test` 只在 preview + /proc 时声明 cap、LAN loopback 404；`hub-preview.test` 的 caps 期望追加；wtdiff 的 `SingleFlightCache` 用法不受影响 | `npx vitest run tests/web-hub/hub tests/web-hub/http tests/integration/git-wtdiff.test.ts tests/integration/web-hub-worktree-diff.test.ts tests/integration/web-hub-worktree-graph.test.ts && npm run typecheck && npm run format:check` |
| P3 UI 逻辑         | 新 `ui/src/logic/gitGraphMerged.ts`；新 `tests/web-hub/ui/logic-git-graph-merged.test.ts`                                                                                                                                                                                                                                                                  | 表驱动：保护四条；停止折叠五条（targets 为空时不产生 `foldBlocked`）；同名 remote 跟随；tag 保留；未合入分支建在 target 之上 ⇒ 被依赖的提交保留，且该 target 不计入 `wouldHide`；`hiddenNow` 与 `wouldHide` 双向；`eP`。性质测试（固定 seed，1000 例随机 DAG + 随机 refs / 判定）：被删提交 ⊆ ⋃ target 窗内独有提交 \ anc(keep)；**非目标提交一个都不能消失**，顺序不变；`layoutGraph(结果)` 的 stub 数 ≤ 原值。性能见 §9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `npx vitest run tests/web-hub/ui/logic-git-graph-merged.test.ts && npm run typecheck`                                                                                                                                                    |
| P4 UI 传输         | `logic/gitGraphScope.ts`、`transport/{types,token,password}.ts`、`logic/{token,password}-client.js`、`logic/contract.js`、`composables/{useHub,useWorktreeGraph}.ts`；对应测试                                                                                                                                                                             | scope 真值表加 merged 列；有 cap ⇒ URL 含 `merged=1` 且超时 48 s，无 cap ⇒ URL 与超时同基线（35 s）；同一 agent/session 下 cap 增加 ⇒ 展开态立即重拉且超时 48 s；cap 消失 ⇒ 立即去掉 `merged`、重拉且超时 35 s、不收起；未展开时 cap 变化不发请求；`transport-contract` 追加                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `npx vitest run tests/web-hub/ui tests/web-hub/contract && npm run typecheck`                                                                                                                                                            |
| P5 UI 组件（前端） | `components/graph/{WorktreeGraph,GraphLanes}.vue`、`styles/graph.css`、`styles/tokens.css`（只追加令牌）、`i18n/{en,zh}/graph.ts`；`tests/web-hub/ui/{worktree-graph,graph-panel,graph-tokens-contrast}.test.ts`（追加）                                                                                                                                   | §7.5 三条 + 「全部 none + degraded」DOM 逐字节不变；默认隐藏；开关往返的精确文案（「显示已合入的 2 个分支」⇄「隐藏已合入的 2 个分支」，脚注 `· 2 merged hidden` ⇄ 无）；徽章与 tooltip 中英文案（含「忽略空白差异」「可能计为未合入」）；≤480px 无徽章；`fold off` 仅在 targets 被阻止时出现；§7.4 对比度合成、source-scan、几何；`graph-panel.test.ts:74-84` 的正则扩为 `gitGraph(?:Merged)?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `npx vitest run tests/web-hub/ui && npm run typecheck && timeout 600 npm run build:web && timeout 300 npm run check:web && npm run format:check`                                                                                         |
| P6 文档与验收      | `docs/dev/worktree-diff/README.md`（Worktree graph 段：Gm、R11 条目、措辞）；`docs/dev/worktree-graph/{plan,acceptance}.md`（§5.2 清单、新增 K10）；本文件的状态                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `npm test && npm run typecheck && npm run build && npm run build:web && npm run format:check`                                                                                                                                            |

### 8.2 排期与冲突（R2-9）

- **本功能整体排在 #40（consult 删除，`docs/dev/consult-removal/plan.md`）全部合入之后**，即 PS2 合入且集成点 I4 全绿之后。把 I4 所在的提交记作 `B40`，作为本任务全部比较的基线。
- **为什么不能与 #40 并行**：
  - #40 的 PD 包验收命令里有 `git diff --exit-code <base> -- src/web-hub/protocol src/web-hub/hub`（consult-removal plan §4.2 PD），#40 §1 还声明 `src/web-hub/protocol/**`、`src/web-hub/hub/**` 不动。本任务的 P0/P2 若先合入，会让这条检查失败。
  - #40 的 PD 与本任务的 P5 都要跑 `build:web` + `check:web`，共用首屏 / lazy / CSS 预算，同时在途时两边的增量都没法单独量。
  - PS1b 改 `src/stack.ts` / `src/index.ts`，PS2 改 AGENTS.md 与 `docs/dev/*/README.md`。本任务不碰前三者；`docs/dev/worktree-diff/README.md` 当前没有 consult 命中（`grep -ci consult` = 0），不在 PS2 处理表里，但 PS2 开工时会重跑 rg 再确认，所以本任务的 P6 也放到 PS2 之后。
- **放行条件**（主会话在派发 Wave 1 前核对）：① `B40` 在 dev 祖先链上；② consult-removal plan 的 I4 全套命令在 `B40` 上已绿；③ `git status --short` 无在途改动落在本任务文件域内；
  ④ 在 `B40` 上重新核对 §1 的代码坐标（行号有变就更新本文件再派发）。
- **包内热点**：`hub/hub.ts`、`hub/audit.ts` 近一周被 schedule / fabric / feishu 等包频繁修改。P2 只做追加，派发前跑 `git log B40..origin/dev -- src/web-hub/hub/hub.ts src/web-hub/hub/audit.ts`；如有在途包，就串行等待。

### 8.3 冻结检查（R2-9 / 原 #11）

每包验收附带：

```sh
# ① 本任务的 diff 只落在声明的文件域内（allowlist = §8.1 各包文件域之并，存成 docs/dev/worktree-graph/merged-files.txt）
git diff --name-only B40...HEAD | grep -vxF -f docs/dev/worktree-graph/merged-files.txt && echo "域外改动" && exit 1
# ② fixtures：本任务不授权任何 fixture 改动（A/B/C 级都不碰）
git diff --quiet B40...HEAD -- tests/fixtures/
# ③ AGENTS 原规则（#40 授权的 golden 改动已在 B40 内）
git diff --quiet origin/dev -- tests/fixtures/
```

`merged-files.txt` 由 P0 派发时生成并随本文件提交，之后只允许由主会话修改。

### 8.4 预算（原 #12）

不自动上调任何预算。P5 在 `B40` 与施工分支的**独立 checkout** 上各跑一次 `npm run build:web`，报告三项增量：

- 首屏 JS gzip（P4 的 scope / transport + eager i18n 文案）；
- lazy JS gzip（`WorktreeGraph-*.js`，含 `gitGraphMerged`）；
- CSS gzip（`cssCodeSplit: false` ⇒ 并入唯一的 CSS 资产，对应 `CSS_BUDGET_GZIP_BYTES` 64 KiB）。

任一项超出 `check-ui-dist.ts:141/144/149` 现有预算 ⇒ 停工请示，不得自行修改预算。

## 9. 测试矩阵要点

- **判定夹具**（P1 集成，真实 git，sha1 与 sha256 各一套，HEAD 侧都先分叉再 cherry-pick）：
  - 普通 cherry-pick ⇒ `=`；`-x` cherry-pick ⇒ `=`；
  - 解冲突的 cherry-pick ⇒ `+`；cherry-pick 后又 amend 改了内容 ⇒ `+`；
  - 仅空白差异 ⇒ `=`（patch-id 忽略空白，作为已知行为钉住）；info/attributes `-diff` 下同一夹具 ⇒ `+`（E11）；
  - `rebase -i` 把两个提交 squash 成一个 ⇒ 两个原提交都是 `+`；`merge --squash` ⇒ `+`；
  - 把 HEAD 分支合进候选分支之后 ⇒ 被合回的副本不再在左侧，原提交变 `+`（E6 现象）；分支内的 merge 提交 ⇒ `+`；完全未合入 ⇒ `+`。
- **端点**（P2 + `tests/integration/web-hub-worktree-graph.test.ts` 追加）：真实 hub + 临时仓库。
  - `merged=1` 下 payload 能过新解析器，判定与直接跑 `git rev-list --cherry-mark` 一致；
  - 不带 `merged=1` 的响应与基线逐字节相同；
  - 部分克隆缺 blob ⇒ 该分支 `unk:"missing-object"`，ssh marker=0；浅克隆 ⇒ `skipped:"shallow"`；
  - 30 个候选分支 ⇒ 条目 24 + `omitted:6`，新 UI 解析通过；审计键 ⊆ 白名单。
- **性能**（原 #10）：
  - P3：在现有两套 1000 节点压力夹具上叠加 400 refs 与 24 条判定，断言 `ops ≤ 25 × (N + E)`，`mergedViewOf + foldMerged` 中位数 ×3 ≤ 20 ms；
  - P2：§3.4 假时钟预算；
  - P1：真实冒烟——2000 提交的仓库 + 24 个候选、各 3 个提交，M 阶段 < 14 s，第二次请求零 Gm spawn。

## 10. 真机验收（P6 写入 `acceptance.md` §K10）

- **K10a** 本仓库：展开 graph ⇒ 默认看不到已合入的平行轨道；工具行里的 N 等于 DevTools 中 `merged` 里 `eq` 且实际被隐藏的分支数；与 `git rev-list --cherry-mark --right-only dev...<b>` 逐分支对照一致。
- **K10b** 点开关 ⇒ 轨道回来，点和线变成 landed 色，分支芯片后出现中文「已合入」；`PWJGMSN3` 显示「部分已合入 3/5」且默认不藏；`GGSHPTC3`、`TRB8S8P8` 无徽章。
  切换到英文界面 ⇒ `merged` / `merged 3/5`；hover 能看到「按补丁等价判定（git patch-id，忽略空白差异）」以及「可能计为未合入」的说明。展开态开关文案为「隐藏已合入的 N 个分支」，脚注不再显示 hidden。
- **K10c** 手机 390×844：默认折叠下 lane ≤3，无折叠泳道菱形，无徽章，无横向溢出。
- **K10d** 三个主题下 landed 线与点都可辨；merge 行、当前行底色、worktree 文字徽章在折叠前后不变；读屏能读出「已合入 HEAD」。
- **K10e** 同页收起再展开，开关状态保留；刷新后恢复默认隐藏。
- **K10f** 展开时挂上 `strace -f -e execve -p <hub-pid>`：只看到 git 子进程，没有 ssh / textconv / filter 程序。另用一个旧版浏览器标签页（不认识新 cap 的旧 UI）请求，其响应与升级前逐字节相同。
- **K10g** `webHub.preview:"loopback"` ⇒ LAN 没有 `wtgraph.merged.v1`；`"off"` ⇒ 两边都没有。`/webhub restart` 切换 preview 后，已打开且已展开的页面在同一 agent 下按新能力重拉（R2-11）。

## 11. 风险

| #   | 风险                                                               | 缓解                                                                                              |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| R1  | 解冲突或修改后的 cherry-pick 漏报（本仓库 3 例）                   | 显示为「部分已合入」或不标、不折叠，宁可多显示；tooltip 写明「可能计为未合入」；F1 可选弱提示     |
| R2  | 仅空白差异的提交被判为等价                                         | patch-id 的既有语义；夹具钉住；tooltip 写明「忽略空白差异」                                       |
| R3  | 未来 git 让 patch-id 走 textconv / 外部 diff，或新增影响结果的配置 | L1 + L2 + 固定 threshold；R11 门禁重跑 36 组矩阵、E11、E12（§4.2）                                |
| R4  | 复核窗口外的竞态（复核之间同一 uid 进程改写属性并恢复原样）        | 检测并丢弃无法覆盖「改了又改回」；影响仅限一次判定结果，同 uid 进程本可直接执行任意命令；登记残余 |
| R5  | 大分支 / 巨型 blob 让 Gm 超时                                      | 每条 2 s、阶段 14 s，超时 ⇒ 未知（不折叠）；缓存让重拉不再付费                                    |
| R6  | `merged=1` 请求的最坏墙钟从 23 s 增到 37 s                         | 只影响新 UI；典型 M 阶段 < 1 s（E9）；客户端超时 48 s                                             |
| R7  | 与 #40 及热点文件冲突                                              | 排在 #40 I4 之后；放行条件与 allowlist 冻结检查（§8.2 §8.3）                                      |
| R8  | `info/grafts`、trace2 残余                                         | 与 Gl / wtdiff 相同的残余，登记                                                                   |

## 12. 待用户拍板（剩余，推荐项在前）

1. **F1 解冲突后的 cherry-pick（patch-id 判 `+`）**：(a) 只按 patch-id，`+` 不标注 **(Recommended)**——与「准确判定」的拍板一致；(b) 当 patch-id 为 `+`、但作者 / 作者时间 / 标题与 HEAD 历史中某提交一致时，加弱提示「已合入（有改动）」，不折叠。
2. **F2 祖先型合入（merge / fast-forward，如 `master`）**：(a) 不加徽章，图上已经连通可见 **(Recommended)**；(b) 也显示「已合入」。
3. **F3「显示已合入」开关是否记忆**：(a) 不记忆，刷新后恢复默认隐藏（同原 plan §0.2 Q4 的先例）**(Recommended)**；(b) 用 localStorage 记住。

## 13. 不做

三元组作为判定依据；`git patch-id` 管道方案；HEAD 以外的合入目标；窗口外分支的判定；压缩合入的精确识别；在 HEAD 侧副本上反向标注；删除分支的 UI 操作；新设置项；对 Cc 驱动配置做事后复核（不影响结果，见 §3.4）。

## 用户拍板（r3 后，2026-10-25）

- F1：不加「已合入（有改动）」弱提示，只按补丁等价（patch-id）判定。
- F2：merge / fast-forward 合入的分支不加标签。
- F3：「显示已合入」开关不记忆，刷新后恢复折叠。

## 开工记录（2026-10-25）

- `B40` = `adebe2d6`（#40 PS2 合入、I4 全绿：vitest 28757 过、conformance 32 文件、fixtures 零 diff）。
- §8.2 放行条件：① `B40` 在 dev 祖先链上；② I4 已绿；③ 工作区干净；④ §1 坐标复核——`302223c5..B40` 在 §1 涉及的 git/protocol/hub worktree-graph/worktree-diff/hub.ts/audit.ts/UI graph/scope/transport 文件上零改动，坐标沿用。
- 文件域白名单：`docs/dev/worktree-graph/merged-files.txt`（§8.3；之后只由主会话修改）。
- 并行方式：各包在主仓库工作区开发（文件域互不相交），主会话按精确路径提交；不开 worktree。
