# #36 记忆块化改造 + 治理 · 架构设计（r5）

> 版本 **r5**（2026-11-06；r1–r4 同日；r4 = 第 1 轮评审处置；r5 = root 第 2 轮复审的 13 条裁定）· 基线 dev@122de638 · 作者：架构子 agent
> 输入：`explore.md`（现状调研）、`../memory/predict-eval-2026-11-05.md`（注入评测）、`../memory/README.md`（不变式/门禁）、`skills/memory-jev/SKILL.md`、AGENTS.md（I3/I4/I5/I8/I9/I10/I11/I12、Frozen artifacts）、`src/memory/**`。
> 用户拍板的内容是本文前提，**不再重新讨论**：块化、治理四原则、预测注入修复，以及 2026-11-06 对 r1 §9.2、r2 §9.2 的裁定。本文只回答「怎么落」。r3 起**没有待确认项**（§9.2）。实施方案见同目录 `plan.md`（r3）。
> 行号以 HEAD 122de638 为准，会漂；以函数名为准。

> **2026-11-07 用户新裁定优先**：本文件保留早期裁定历史；任何「conflict 自动」旧措辞不再是现行规则。当前只允许新块完整覆盖或明确废弃旧块全部有效信息时自动取代，partial conflict 仅建议；显式路径及其余权限/安全边界不变。

## r5 变更摘要（相对 r4；root 第 2 轮复审后的 13 条裁定）

用户已定事项一条未改。下面每条都是对 r4 实现层的收紧；r4/r3/r2 摘要和第 1 轮处置表保留备查，**与本节冲突的旧表述一律以本节和正文 r5 内容为准**。逐条落点见文末「r5/r3 处置表（root 裁定）」。

1. **目录操作入口**（裁定 1）：`src/memory/safe-fs.ts` **只新增**三个受审导出 `renameDirNoClobber`、`removeTreeNoFollow`、`fsyncDir`，其余导出字节不变；safe-fs 仍是 `src/memory/**` 唯一的 fs 导入点（`tests/memory/fs-guard.test.ts` 不放宽）。这三个导出归 **P1** 实现并单测。rename 遇到 EXDEV 或不支持 ⇒ fail closed，绝不降级为复制 + 删除（§4.2.1、§4.3.3）。
2. **回滚与代际令牌**（裁定 2）：memDir 根新增 `.blocks-state.json`（单调递增的 `gen`）。回滚顺序固定为「先 bump gen → 持久写 hold（含回滚意图与新 gen）并 fsync → 再 rename `blocks/`」。提交在锁内复核「hold 不存在 ∧ gen 未变 ∧ `blocks/` 不存在 ∧ 源 sha 未变 ∧ 暂存身份与清单一致」五项，任一不符即丢弃暂存区。`dirFormat` 中 hold 优先于 `blocks/`。无锁读者每次读取只解析一次布局并固定使用（§3.2.1、§3.2.3、§4.3.3、§4.3.5、§4.3.8）。
3. **暂存区清理**（裁定 3）：不再按年龄判断无主。暂存目录在锁内创建并立刻写入 `owner.json`；只在锁内清理「本进程自己的」或「owner 确认已死」的暂存区，先 rename 为 `.<name>.trash-<runId>` 隔离再删除；提交前核对 runId 与 `.layout.json` 中的完整文件清单（§4.3.3）。
4. **混合权威**（裁定 4）：whole 兜底只允许用于整文件权威一致的文件。混合权威文件照常拆出条目，覆盖不到的片段各自生成「残留块」（`authority: agent`、`residue: true`、`origin: <file>#L<a>-L<b>`），迁移报告逐条列出，供 P8 过目；残留块不作为自动取代的目标（§4.3.2 第 4 步、§5.4）。
5. **回滚承诺与 archive 命名**（裁定 5）：回滚恢复的是「根目录当前的旧布局内容」（包括迁移后旧会话的写入）；迁移前的原始字节由 P8 的 tar 快照保证。archive 重名使用合法的 v2 名 `<topic>.<seq>.r<n>.md`，并由 `blocks/archive/index.json` 记录「存储名 → 原 id」（§4.3.5、§4.5）。
6. **heading 契约**（裁定 6）：`BlockMeta.heading` 落盘为 frontmatter `heading`，解析、渲染、适配全链路一致；adapter 输出 `MemEntry.heading = meta.heading`；`MemEntry.block` 不再重复声明 heading（§3.2.2、§4.2、§4.4）。
7. **secure 构建与清理**（裁定 7）：选择「逐操作闸门复检」——暂存区的每个 mkdir/write/rename/delete 之前都调用 `memoryWriteGate.check`。持有目录 fd 的方案不可行：Node 没有 `openat`/`mkdirat`/`renameat`/`unlinkat`。显式路径新建 memDir 后立即 `capture`，之后自动路径才允许写入（§4.7）。
8. **常驻账本**（裁定 8）：`delivered` 拆成 `snapshot`（实际在 system prompt 里的常驻集合，从 hub 持久化 snapshot 文本解析）与 `ledger`（snapshot ∪ R 已通知新增 − R 已通知移除）。R 层用「应常驻集合」与 ledger 做差分，**到期标注变化也发变更通知**；`residentBlocks = ledger`；每次 `before_agent_start` 以「corpus 指纹 + 当天日期 + snapshot 指纹」判定是否重算；异步 U/E 结果提交时块 rev 已变 ⇒ 丢弃该项（§3.3.3、§3.3.5、§3.3.6）。
9. **JevWritePort**（裁定 9）：P0 一次写齐。沿用现有方法名 `afterWrite`/`checkInline`/`touchedUserEntries`，只追加可选入参 `block`/`askScope` 与可选返回 `relations`，不另造 `runAfterWrite`；BlockMeta、marker、corpus 的字段声明与示例统一（§4.2、§4.4）。
10. **派单正文统一**（裁定 10）：P6a/P6b 冻结面删去「predict/model off 时 wire 字节不变」，改为引用 X1–X6 例外与开关差分；governance-off 差分写明比较对象，排除独立 Jev 打标带来的合法侧车变化（§7.2）。
11. **迁移全阶段预算**（裁定 11）：快照、构建、提交复核、清理共用一个 deadline 与操作数上限；锁外每 32 个操作检查预算与 abort，并用 `setImmediate` 让出；超预算 ⇒ 丢弃暂存区、记录连续次数，连续 3 次 ⇒ doctor D25（§4.3.4、附录 A）。
12. **离线门禁调参归属**（裁定 12）：G1 不达标改 P5a 的阈值常量，G2 不达标改 P6b 的召回参数，都在实现包内修改后重跑 PG，评测脚本只读取生产常量；G3 相邻轮按 `redeemPending` 代码规则区分「承接短语全权重」与「普通新指令 0.6 封顶」（§7.4）。
13. **门禁口径**（裁定 13）：「tidy 零 diff」限定为 P2 提交范围；P5a 对 `tidy/command.ts` 只做一处改动（blocks 目录禁用提示）；已取消的旧验收（根目录无 core、MEMORY.md→archive、restore 路径）在 plan r3 中全部换成新模型对应的验收。

---

## r4 变更摘要（相对 r3；第 1 轮评审 GPT-6.1 Sol 打回 9 Blocker / 7 Major / 1 Minor 的处置）

用户已定事项一条未改。所有 Blocker 都优先用**简化**来消除，而不是叠加机制。逐条处置见文末「评审处置表」。主要变化如下。

1. **迁移改为「暂存区构建 + 单次原子 rename + 旧布局原地保留」**（B1–B4、B6、B15）
   - 新布局整体放在子目录 `<memDir>/blocks/`。迁移过程：在 `<memDir>/.blocks-staging-<runId>/` 里完整构建 → fsync → 一次 `rename(staging, blocks)` 完成提交。
   - 根目录的旧文件**一个字节都不动**，作为不可修剪的旧布局快照原地保留。
   - 回滚就是一次 `rename(blocks, .blocks-rolledback-<ts>)`，同时写入 `.blocks-hold`。
   - 迁移**不再复用 tidy txn**，txn/safe-fs 命名空间零改动；读者在任何时刻都只会看到完整的旧布局或完整的新布局。
   - 增量迁移改为「漂移检测 + 显式导入」，迁移报告只写一次、之后不再修改。
   - 迁移前做源字节覆盖审计：有未覆盖内容或拆出零条目的文件，整体保留为一个超限块（fail closed）。
2. **跨版本写隔离靠目录隔离**（B5）
   - 旧代码的 v2 工具文件名不允许含 `/`，所以物理上改不到 `blocks/` 里的块。
   - 旧代码只能改根目录旧文件，这些改动会被漂移检测发现，再经显式导入进入块布局。
   - 因此不需要两阶段发布。
3. **取代关系改为单边记录**（B7）
   - 只在旧块上记 `supersededBy`；`supersedes=` 只作为写入语法，不落盘。
   - 一次取代 = 对旧块做一次单文件原子替换。执行前在锁内复核新、旧两块的 rev/authority/active 状态，新块必须仍为 active（这一条同时排除了自环和循环）。
   - 判定迟到或任一方已变化 ⇒ 不执行，改为出建议。
4. **迁移暂停开关**：新增设置 `memory.migrate.auto`（默认 true，保留用户定的惰性迁移）。P8 在默认布局翻转**之前**就设为 false 并验证（B8）。
5. **secure 写闸门** `memoryWriteGate`：所有自动写入口（启动迁移、sweep、取代、漂移导入）都要先过闸门（B9）。
   - locked ⇒ 零读写；secure ⇒ 逐操作复检挂载状态与路径身份；
   - 自动路径永不创建目录；
   - `--all` 和备份都使用有效的 memory root。
6. **常驻区与 stable snapshot 的兼容协议**：常驻集合以「本段实际已交付」为准；之后发生的变更通过 Jev 消息通道下发一次性的「常驻变更通知」（新层 `R`）（M10）。
7. **统一 eligibility 判定**：所有注入层（U/A/E/B/P/S/R）以及 external renderer，在选择时和最终提交时各校验一次（M11）。
8. **契约与侧车**：P0 一次补齐全部新字段。块布局使用独立侧车 `blocks/.jev/index.json`，按 hash 多对一；dismiss 带到期时间（M12）。
9. **门禁与证明**：
   - harness 只钉依赖默认布局的四个配置（M13）；
   - I9 写明用户已批准的兼容例外清单，用开关差分测试证明（M14）；
   - 写明执行总预算、自触发屏蔽和 shutdown 中止（M15）；
   - 新增三项实施前离线门禁（M16）；
   - 文件域与 golden 等级补齐（m17）。

---

## r3 变更摘要（相对 r2）

用户 2026-11-06 裁定了 r2 §9.2：

1. **N1 = 只用自动摘要**。
   - 删除 `.blocks.json` 主题登记表、工具 `update <topic>`、`/mem topic` 命令（r2 的 §3.2.3 作废，改为「布局标记」）。
   - Topics 索引行改为：`<topic> — tags: a, b, c · N blocks · D decisions · E expired`。标签取不到时（jev off 或未打标），改用块的 `section` 名，按频次取前 3；再取不到就只显示计数。
   - 旧 frontmatter 里人工写的 `description/read_when` **不作为一次性摘要种子**。种子必须落盘到某处才能在之后的渲染中使用，这在实质上就是登记表，与「只用自动摘要」冲突，所以丢弃。它们只保留在只读的迁移报告（r4 起为 `blocks/.migration-report.json`）以及原地保留的根目录旧文件里，供审计和回滚，**任何渲染路径都不读取**。
   - CC 单事实文件的 description/read_when 写进**块自身**的 `title/when`。这是块级元数据，描述的是那一条事实本身，不是主题描述，所以保留；它不进入索引，只在 `view <topic>` 列表中显示。
2. **N2 = 允许**：新用户令可以自动取代冲突的 agent 块。原裁定阈值为 supersedes≥0.85 / conflict≥0.90（历史记录）；**2026-11-07 用户新裁定覆盖自动条件：仅完整取代的 supersedes≥0.85，每次写入合计 ≤2 条；conflict 永远只建议**，可恢复。§5.4 矩阵已定稿，相关的「N2 开关」措辞已删除。
3. **§9.2 清空**：无待确认项。§8 分包移除登记表相关工作；风险 R12 改写。

## r2 变更摘要（相对 r1，保留备查；其中第 5 条与「N1/N2 待确认」已被 r3 取代）

用户 2026-11-06 裁定了 r1 §9.2，其中 **Q1 推翻了 r1「core.md 常驻 + 主题卡」方案**。r2 据此重写：

1. **取消 core.md 的特殊地位，也取消主题卡**（r1 §3.2.3/§3.3 整体作废）。目录里只有 block 一种记忆文件。
2. **用户令分两类**（`scope` 字段，只对 `authority:user` 有意义）：
   - `scope: global`（常设规则）：每轮常驻 system prompt；
   - `scope: topic`（决策记录，**默认值**）：和 agent 块一样由 Jev 按相关性注入，并通过「每主题一行」的 Topics 索引按需打开。
   - 两类都受用户令保护：永不自动归档、永不被 agent 条目取代、到期后仍注入但带标注。
3. **常驻区预算**：`memory.residentBytes = 2048`。超额**不截断**，生成「合并 / 降级为 topic」整理建议，并在启动提醒里提示（§3.3）。
4. **迁移规则**：
   - `core.md` 的用户令 → `scope: global`（实测 3 条 / 524 B）；
   - `core.md` 的 agent 条目 → 主题 `general` 下的普通块，交给 Jev；
   - 其余文件的用户令 → `scope: topic`；
   - 手写文件里的隐式用户令 → topic；
   - 纯指针的用户令 → topic（§4.3）。
5. ~~Topics 索引描述来自 `.blocks.json` 主题登记表（N1）~~ → r3：只用自动摘要（§3.3.3）。
6. **写入时的 scope**：新用户令默认 topic。可以显式写 `scope=global`；分类器只**建议**（回显「是否设为常设规则」），**从不自动升 global**（§4.1.5、§5.3）。
7. **自动取代矩阵（Q6）**：
   - 用户令↔用户令：自动；
   - agent↔agent：自动；
   - agent → 用户令：**永不**；
   - 用户令 → agent：自动（r3 定稿，原 N2）。

   以上都有阈值、每次写入上限 2 条，可恢复，并在回显中说明（§5.4）。

8. **`isStaticCore` 改为按常驻块集合判定**，U/A/P/E 四个调用点同步调整（§3.3.4）。
9. **其余裁定定稿**：
   - Q2：块化为默认布局；A′ jev-off golden 的 harness 显式钉 `layout:"tiered"`，golden 字节不动；
   - Q3：>1 KB 的存量条目豁免，出整理建议；
   - Q4：CC 导入按前缀聚合主题；
   - Q5：已迁移目录禁用 `/mem tidy`；
   - Q7：audience 在迁移时写入，其余从 Jev 标签推导；
   - Q8：惰性迁移 + `--all`；
   - Q9：`waitS` 改为 1.0；
   - Q10：疑似指针留存 + 出建议，纯指针才自动移出。
10. **§8 分包、§9 风险同步更新**；已定项移出开放问题清单；新增待确认项 N1、N2（§9.2）——r3 已全部定稿。

---

## 0. 一页摘要

- **块模型**：
  - 一个 `.md` 文件 = 一个 block，正文 ≤1024 UTF-8 字节；
  - 文件名就是 id：`<topic>.<seq>.md`（如 `quota.007.md`），主题由前缀决定；
  - 元数据全部放在 frontmatter；行内 `<!-- mem … -->` 只作为写入语法保留。
- **注入分三路**：
  - **常驻区**：active 的 `authority:user ∧ scope:global` 块，经受众过滤后全部注入，不截断。2048 B 预算只用于报警和出建议。
  - **Jev 相关性注入**（U/A/E/B/P）：其余全部 active 块，包括 topic 类用户令，它们在候选排序里优先。
  - **Topics 索引**：每主题一行（自动摘要：标签/section + 块数、决策数、到期数）；模型可以用 `memory view <topic>` 主动打开。
- **工具 v3**：
  - 保留 `view / create / update / delete / search`；
  - `update` 整块替换，必须带 `rev` 做 CAS；
  - 旧命令（insert/str_replace/rename/write/append）报错并给出改法；
  - `memory-tool-surface.json` 只新增 key，不动已有 key。
- **迁移**：
  - 主会话 `session_start` 时对当前 cwd 惰性执行，另提供 `/mem migrate --all`；
  - r4：在暂存区构建，经一次原子 rename 生成 `blocks/` 子目录；根目录旧文件原地不动，作为回滚快照；
  - r5：代际令牌 `gen` + 「先写 hold 再 rename」的回滚；暂存区按 owner 身份清理；混合权威文件拆分并生成残留块；
  - 条目边界复用 `splitEntries` 并做覆盖审计，hash 不变，侧车标签直接继承；
  - `memory.migrate.auto` 可以暂停自动迁移；回滚用 `/mem migrate --rollback`。
- **治理**：
  - 到期在渲染时按当天日期计算，不需要定时器；
  - 写盘动作只在事件点 sweep 时执行，不新增 `pi.on`，activate-trace 不变；
  - 用户令永不被自动归档；取代按 §5.4 矩阵执行。
- **注入修复**：
  - P2 根因是单模型链每档只给 1500 ms，3 s 预算从来用不满。改为最后一档用满剩余预算，`waitS` 改为 1.0；
  - 受众过滤；
  - 时效降权 + 点名要求；
  - E 层不再处理只读工具失败；
  - 高危 tag 冷却饿死时给出降级出口。
- **主要风险**：
  - 32 条用户令改为按相关性注入，可能漏注入；
  - 自动取代可能误判；
  - 没有 `/reload` 的旧代码会话可能写入已迁移目录。

  各自的缓解措施见 §9。

---

## 1. 背景与目标

### 1.1 要解决的问题

`explore.md` §C 的五个缺口，加上评测 §9 的注入问题，可以归为两类：

1. **粒度错位**：
   - 应该被治理的单元是「一条事实」，现在却是「文件里的一段文字」；
   - 到期、权威、冲突只能写成行内注释，jev on 时还会被 `stripInlineMeta` 剥掉，在 prompt 里看不见；
   - 侧车以内容 hash 为键，文本一改就留下孤儿（27%）；
   - `str_replace/insert` 只做局部编辑，没法表达「这条事实的寿命」。
2. **只有空间压力，没有时间压力**：
   - `expires/until/temporal` 全是只读信号，唯一的执行者是手动 `/mem expired`；
   - core 已用到 98.7%，却没有规则决定挤掉谁；
   - 互相推翻的用户令同时存在（`core.md:13` 与 `pitfalls.md:33`）；
   - core.md 把常设规则、指针和 agent 经验混在一起常驻。

### 1.2 目标（用户已拍板，逐条可验收）

| #   | 目标                                                                                                      | 验收口径                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| G1  | 一文件 = 一 block，单块正文 ≤1 KB                                                                         | 新写入超限即拒绝；存量超限块豁免，并有 doctor 提示和整理建议 |
| G2  | `update` 整块替换 + 版本号/CAS；保留 create/delete/view/search；去掉 insert/str_replace/rename            | schema 与 golden 新 key 一致；旧命令报错并给出改法           |
| G3  | 去掉 core.md 特殊地位与主题卡；global 用户令常驻；其余由 Jev 注入；Topics 每主题一行                      | §3.3 渲染契约；目录里没有卡片文件                            |
| G4  | 用户令分 global / topic（默认）；两类都受用户令保护；常驻区约 2 KB，超额不截断，出建议并提醒              | §3.3、§5                                                     |
| G5  | 现有条目自动拆成 block，mem 注释转 frontmatter，旧文件可恢复；core.md 用户令→global，其余→topic           | 原子 rename；旧文件原地不动；`--rollback` 即时还原           |
| G6  | 治理四原则（到期 / 触发 / 写入 / 冲突），取代范围按 Q6 执行                                               | §5                                                           |
| G7  | 预测注入：`model.enabled` 保持开启，修复窗口/预算错配；补上受众过滤、时效降权、E 层只读失败、冷却饿死出口 | §6 + 复评指标                                                |

### 1.3 约束

- I1/I5：不新增常驻定时器；所有等待都有上限（锁沿用 `withMemoryDirLock` 的 unref 重试 + `timeoutMs`）。
- I2：`src/index.ts` 不加逻辑。
- I3：memory 仍在 pre-guard；迁移与 sweep 只在主会话（`!isChildSession`）执行。
- I4：状态放在 `wireMemory`/`wireJev` 闭包里；不新增 `Symbol.for` 全局。
- I8：新增的纯逻辑模块（`src/memory/blocks/**`、`src/memory/govern/**`）不 import pi，并加入 `tests/boundary/pi-free.test.ts` 白名单。
- I9：显式 `layout:"tiered"|"legacy"` + 未迁移目录 ⇒ 输出与 HEAD 逐字节相同（§7.2）。
- I10：`subagent:memory-inject` 的 details 和 `kind:"call"` 记账只追加可选字段。
- I11：secure 域下 Jev 仍强制关闭。治理是确定性逻辑、只写 vault 内的 memDir，允许运行；不新增 D8 项。
- I12：机制写在工具描述里，策略写在 skill 里。

---

## 2. 现状摘要（相关模块）

| 区域           | 文件                                                                                                                                                                                 | 与本改造的关系                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 存储 / fs 安全 | `safe-fs.ts`（`listRegular`/`readRegular`/`createExclusive`/`replaceAtomic`/`renameNoClobber`/v2 名校验）、`lock.ts`（`withMemoryDirLock`）、`paths.ts`、`frontmatter.ts`、`meta.ts` | **全部复用**（r5：另新增三个目录原语，§4.2.1）：block 就是扁平目录里的普通 `.md`，symlink/非常规文件拒绝和 trash 命名不变式原样成立 |
| 渲染           | `tiered.ts`（`renderTiered`）、`inject.ts`（`memorySection`、render cache、`jevRenderInfoOf`、`stripInlineMeta`）                                                                    | tiered **不改**（钉住 tiered golden）；新增 `blocks/render.ts`，`inject.ts` 按有效布局分派                                          |
| 工具           | `tool-surface.ts`、`tool-v2.ts`（七命令；`prepareJevGuard`/`notifyUserRuleChange`/`finishJevWrite`）、`normalize.ts`                                                                 | v2 留给未迁移目录或显式 tiered；新增 `tool-v3.ts`，复用 v2 的 Jev 守卫、回显和通知辅助                                              |
| 事务           | `tidy/{txn,journal,manifest,restore}.ts`（MOVE/CREATE/REPLACE + CAS + owner epoch + 恢复真值表；`TidyManifestKind`；`pruneBackups(10)`）                                             | r4：**不再复用**（迁移改用暂存区 + rename，归档改为单文件 rename）；零改动                                                          |
| Jev 条目       | `jev/entries.ts`（`splitEntries` 规则 1–5、`parseInlineMeta`、`entryHash`）、`jev/contracts.ts`（冻结、只追加）                                                                      | 迁移的条目边界 = `splitEntries`；block 经适配器变为单条 `MemEntry`                                                                  |
| 侧车           | `jev/index-store.ts`（hash 为键、`review`、`aInjectedAt/pInjectedAt`；`gcIndex` 只在超上限时触发）                                                                                   | 保留 hash 为键，追加 `block`；改为精确 GC                                                                                           |
| 召回/预测      | `jev/wire.ts`（U `recallCandidates`、A `tool_call`、E `recallE`、P `predictCandidatesFor`、`isStaticCore`、`racePredictWindow`）、`predict/{flight,select}.ts`                       | §3.3.4 改造静态判定；§6 四项改进 + P2 修复                                                                                          |
| 写后打标       | `jev/write-port.ts`（`createJevWritePort` 返回的 `afterWrite`、内部 `relationPicks`）、`jev/format.ts`                                                                               | 按取代矩阵重建 compare 池；新增 scope 建议问句与 superseded/snapshot 回显                                                           |
| 命令           | `command.ts`（`/mem` 描述被 jev-off golden 钉住）、`jev/{review-command,expired-command}.ts`、`doctor.ts`（D01–D19）、`init-command.ts`                                              | 增加 `/mem migrate`、`/mem restore --block`；描述字符串按布局分派                                                                   |
| 设置           | `settings.ts`（`layout`、`coreBytes 1600`、`blockBytes 2400`、28 个 `memory.jev.*`）、`setting-specs.ts`                                                                             | `layout` 增加 `"blocks"`（新默认）；新增 `memory.residentBytes`、`memory.governance.enabled`；`waitS` 默认 1.0                      |

**数据画像（2026-11-06 只读复核）**：

- 全机：21 个项目目录、133 个文件、约 900 条条目。
- 正文长度：中位数 173 B、p90 386 B、p99 741 B；超过 1 KB 的约 7 条（pi-toolkit 1 条，1041 B）。
- 133 个文件中 78 个没有 `source: agent`（手写），多为 CC 导入的单事实文件，例如 claude2api 的 58 个 `project_*/feedback_*`。
- pi-toolkit：17 文件 / 179 条 / core 1579 B；用户令 35 条 / 约 11.7 KB，其中 core.md 只有 3 条 / 524 B。

---

## 3. 总体设计

### 3.1 模块划分与依赖方向

```
                         src/index.ts（只装配，不改）
                                  │ wireMemory(...)
                                  ▼
 src/memory/index.ts（pi-facing 装配；闭包持有全部状态）
   ├─ session_start（已有 handler）──► blocks/migrate.ts（暂存区构建 + 原子 rename）
   │                                └► govern/sweep（reason:"startup"|"reload"）
   ├─ onAfterWrite（已有）────────────► govern/sweep（reason:"write"，轻量）
   ├─ sections.register(pi_project_memory) ─► inject.ts ─┬─► tiered.ts（未迁移 / 显式 tiered，不改）
   │                                                     └─► blocks/render.ts（常驻区 + 每主题一行索引）
   ├─ registerTool(memory) ──► tool-v3.ts（layout=blocks）│ tool-v2.ts / tool.ts（其它）
   │                              └─► blocks/store.ts、govern/{snapshot,supersede}.ts、jev write-port
   ├─ registerCommand(mem) ──► command.ts（+ migrate[--status/--rollback/--import-legacy] / restore --block / review 治理类）
   └─ wireJev(..., governancePort) ─► jev/wire.ts
          ├─ corpus：blocks/adapter.ts（block → MemEntry）
          ├─ 静态判定：JevRenderInfo.residentBlocks
          ├─ tool_call / tool_result / turn_end（已有 handler）── 治理信号 ─► governancePort
          └─ U/A/E/P 选择：audience 过滤、govern/decay、E 只读规则、冷却饿死出口

 pi-free（I8 白名单新增）：
   src/memory/blocks/{format,naming,rev,store,marker,adapter,render,migrate-plan}.ts
   src/memory/govern/{sweep-plan,snapshot,decay,audience,supersede,review-lite}.ts
 依赖方向：govern → blocks → (safe-fs, frontmatter, lock, jev/entries 纯函数)
           jev/wire → blocks/adapter, govern/{decay,audience}（只依赖纯函数）
           blocks/** 不 import jev/wire、tool-*、inject
```

### 3.2 块模型

#### 3.2.1 目录布局（r4 子目录 + r5 代际与暂存身份）

```
~/.pi/agent/memory/<slug>/            ← memDir（secure 域下为 <state>/memory/<slug>/）
├─ core.md, quota.md, …               ← 旧布局文件：迁移后一个字节都不动；新代码只读它们做漂移检测，永不写入
├─ .jev/                              ← 旧布局侧车：新代码不读也不写
├─ .trash/ .backup/ archive/          ← 旧布局的 tidy/trash/archive：新代码不碰
├─ .blocks-state.json                 ← r5：迁移状态 {v:1, gen, overBudgetStreak, lastOutcome, lastAt}；只在锁内读写并 fsync
├─ .blocks-hold                       ← 可选：存在 ⇒ 本目录禁止自动迁移，dirFormat 视为 held（回滚时先于 rename 写入）
├─ .blocks-staging-<runId>/           ← 迁移构建中的暂存区（读者永不读取）
│  └─ owner.json                      ← r5：{v:1, runId, pid, startTicks, bootId?, hostname, createdAt}，锁内随 mkdir 一起写入
├─ .blocks-staging-<runId>.trash-<cleanerRunId>/  ← r5：已判定为垃圾、正在删除的暂存区（锁内 rename 隔离后才删）
├─ .blocks-rolledback-<ts>/           ← 回滚后保留的块布局（永不自动删除）
└─ blocks/                            ← 块布局（只能通过一次原子 rename 出现）
   ├─ .layout.json                    ← 布局标记 + 提交时文件清单（暂存区里写好，随 rename 一起出现，之后不改写）
   ├─ .migration-report.json          ← 本次迁移报告（只写一次）
   ├─ .legacy-import.json             ← 漂移导入台账（每次显式导入时追加）
   ├─ general.001.md …                ← 块
   ├─ archive/                        ← 块的归档区（扁平）
   │  └─ index.json                   ← r5：存储名 → 原 id（§4.5）
   ├─ .trash/                         ← 块的软删区（沿用 .trash 命名不变式）
   └─ .jev/index.json                 ← 块布局独立侧车（与旧侧车隔离）
```

- **为什么用子目录**：
  - **原子性**：`rename(2)` 对目录是原子操作，读者要么看到旧布局、要么看到完整的新布局；
  - **跨版本写隔离**：旧代码 v2 工具的文件名规则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$` 不允许出现 `/`，`resolveMemoryFile` 不可能定位到 `blocks/*`；旧代码的 `listRegular` 只列普通 `.md` 文件，看不到 `blocks/` 目录，也看不到 `.blocks-state.json`/`.blocks-hold`（不以 `.md` 结尾）；
  - **回滚零拷贝**：旧文件从来没有被移动过。
- `blocks/` 自身也按「memory 目录」规则处理：`canonicalDir` 要求它是真实目录（是 symlink 则 fail closed），且与 memDir 同 dev；块文件沿用 v2 安全名与常规文件检查；所有写操作都持有 **memDir 级**的同一把目录锁（`withMemoryDirLock(memDir)`，下文称「迁移锁」，新旧代码共用）。
- **代际 `gen`**（r5，裁定 2）：`.blocks-state.json` 中的非负整数，缺失视为 0，只增不减。以下状态转换在迁移锁内各 +1 并 fsync：提交（rename 暂存区之前）、回滚（写 hold 之前）、显式清除 hold（删除 hold 之前）。构建开始时记录 `gen`，提交时复核（§4.3.3）。
- **命名**：
  - 块名为 `^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}\.md$`，id = 文件名去掉 `.md`，主题 = 第一个 `.` 之前的部分；
  - archive 区额外允许 `<topic>.<seq>.r<n>.md`（`n` 为 1–999），它不满足块名正则，但满足 v2 安全名（§4.5）；
  - id 不可变；frontmatter 不存 topic；
  - seq 在锁内取 `blocks/`、`blocks/archive/`（含 `.r<n>` 名）、`blocks/.trash/` 中同主题已用 seq 的最大值 + 1，不回收。
- **游离文件**：`blocks/` 中不符合块名或缺少 `kind: block` 的文件。只有手工放入时才会出现，旧代码写不进来。doctor 报告（D23），sweep 不自动处理。
- **旧布局漂移**：根目录旧文件的字节与迁移报告中记录的 sha256 不一致，或者出现了新的根目录 `.md`。来源可能是未 reload 的旧代码会话，或者用户手改。处理见 §4.3.6。

#### 3.2.2 block 文件格式

```md
---
kind: block
authority: user
scope: global
audience: main
expires: 2026-12-01
until: "v0.9 发布"
supersededBy: general.012
status: active
section: 用户决策
heading: 验收 › 模型选择
tags: +release,-docs
private: true
title: spec-dev 进 worktree 需手动 git worktree add
when: spec-dev 进 worktree 时
created: 2026-11-05T11:11:50.838Z
updated: 2026-11-05T11:11:50.838Z
version: 3
---

- 验收选 deepseek 系时优先 `deepseek/deepseek-flash`，不默认 v4-pro（2026-11-05 用户令）。
```

| 字段                | 值域                             | 缺省                      | 写入方                                         | 说明                                                                                         |
| ------------------- | -------------------------------- | ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kind`              | `block`                          | 必填                      | 工具/迁移                                      | 没有该字段的文件 ⇒ 游离文件                                                                  |
| `authority`         | `user`/`agent`                   | `agent`                   | 写入语法 `mem user`/`mem lesson`；迁移按原规则 | `lesson` → `agent`                                                                           |
| `scope`             | `global`/`topic`                 | `topic`                   | 写入语法 `scope=`；迁移（§4.3）                | **只对 user 有意义**；agent 块写了会被忽略（D23）                                            |
| `audience`          | `all`/`main`/`child`             | `all`（Jev 可推导，§6.1） | 写入语法；迁移时只给 global 块写               | 受众过滤                                                                                     |
| `expires`           | `YYYY-MM-DD`                     | —                         | 写入语法                                       | 当天仍有效                                                                                   |
| `until`             | ≤120 B                           | —                         | 写入语法                                       | 条件失效，只进建议                                                                           |
| `supersedes`        | —（**不落盘**，r4）              | —                         | 只作为写入语法                                 | 单边关系，见 §5.4                                                                            |
| `supersededBy`      | id                               | —                         | **只由服务端写**                               | 有它 ⇒ `status: superseded`                                                                  |
| `status`            | `active`/`superseded`/`archived` | `active`                  | **只由服务端写**                               | `expired` 不落盘，读时计算；`archived` 只出现在 `archive/` 里                                |
| `section`           | ≤80 B                            | —                         | 迁移（原 `## ` 标题）                          | 只用于 `view <topic>` 时分组                                                                 |
| `heading`           | ≤120 B                           | —                         | 迁移（原 `### ` 路径 `A › B`，r5）             | `view <topic>` 时按 `section › heading` 分组；adapter 输出 `MemEntry.heading`；`update` 继承 |
| `residue`           | `true`                           | —                         | **只由迁移写**（r5）                           | 混合权威文件中覆盖不到的片段（§4.3.2 第 4 步）；`update` 后服务端清除                        |
| `origin`            | `<file>#L<a>-L<b>`               | —                         | **只由迁移写**（r5）                           | 残留块的来源文件与行号；只用于报告与 `view`                                                  |
| `tags`              | `+a,-b`                          | —                         | 写入语法                                       | 手工标签优先                                                                                 |
| `private`           | `true`                           | —                         | 写入语法                                       | 永不外发                                                                                     |
| `title`/`when`      | ≤110 B / ≤70 B                   | —                         | 迁移（CC 单事实文件）；写入语法可选            | 只在主题内列表中显示                                                                         |
| `created`/`updated` | ISO                              | —                         | **只由服务端写**                               | 迁移时依次取侧车 `at` → 文件 `updated` → mtime                                               |
| `version`           | 正整数                           | 1                         | **只由服务端写**                               | 每次写入 +1                                                                                  |

- **正文计量**：`Buffer.byteLength(stripFrontmatter(raw).replace(/\s+$/, ""), "utf8") ≤ 1024`（常量 `BLOCK_BODY_MAX_BYTES`，不做设置）。frontmatter 另受 `MAX_FRONTMATTER_BYTES 2048 / 40 行` 约束。
- **正文不得残留 `<!-- mem … -->`**：工具写入时会把它搬进 frontmatter；手写残留的，渲染时剥掉，doctor 报 D23。迁移时丢弃 `gate*`。

#### 3.2.3 布局标记 `blocks/.layout.json`（N1：不含主题元数据；r5：含代际与提交清单）

```json
{
  "v": 1,
  "migratedAt": "2026-11-06T00:00:00.000Z",
  "runId": "20261106T000000000Z-1234-ab12cd",
  "source": "migrate",
  "gen": 6,
  "files": [{ "path": "general.001.md", "sha256": "…", "size": 412 }]
}
```

- 标记**在暂存区里最后写入**，随整个目录的 rename 一起出现，所以「标记存在 ⇔ 块布局完整」。之后永不改写。
- `source` 取值为 `migrate`（迁移生成）或 `fresh`（目录原本没有旧文件，首次显式写入时用同一套暂存区 + rename 流程直接创建空布局）。
- `gen` = 构建开始时记录的 gen + 1，即提交成功后 `.blocks-state.json` 的值。
- `files`：暂存区内除 `.layout.json` 自身和 `owner.json` 之外的**全部**文件（相对路径，含 `archive/`、`.trash/`、`.jev/` 下的文件），用于提交前逐一核对（§4.3.3）。它记录的是提交时的清单，提交后块会继续变化，这个列表只作历史记录，任何读路径都不使用它。
- `owner.json` 在提交前（锁内）删除，不进入 `blocks/`。
- `dirFormat(memDir)` 的判定（r5：hold 优先）：
  - 存在 `.blocks-hold` ⇒ `held`（不论 `blocks/` 是否还在，回滚可能停在 hold 已写、rename 未做的中间态）；
  - 否则 `blocks/` 是真实目录、与 memDir 同 dev，且其中有 `.layout.json` ⇒ `blocks`；
  - 否则根目录有 v2 合法的 `.md` ⇒ `files`；
  - 否则 ⇒ `absent`。
  - 判定失败（不可读、`blocks` 是 symlink、跨 dev 等）⇒ `files`，并记 diag。这是 fail closed：失败时不动用新布局，自动迁移也不会运行。
- 旧 frontmatter 的 `description/read_when` 只写进 `.migration-report.json` 的 `files[].frontmatter`，**任何渲染路径都不读取**（N1）。

#### 3.2.4 版本号与 CAS

- **rev** = `` `${version}-${sha1(整个文件字节).slice(0,6)}` ``。`view/create/update/search` 都输出 rev。
- `update` **必须**带 rev，并在锁内复核；不一致 ⇒ `E_CONFLICT`（附当前 rev 和正文）。用户手改文件时 version 不变但 sha 会变，所以也拦得住。
- `delete` 的 rev 可选（软删可以从 trash 找回）。
- 服务端改元数据（取代、归档、恢复、降级 scope）同样 version+1，并走 CAS。

#### 3.2.5 侧车（r4：块布局使用独立侧车，按 hash 多对一）

- 块布局的侧车放在 `blocks/.jev/index.json`，格式仍为 `JevIndexV1`，与根目录旧侧车完全隔离：未 reload 的旧代码只会读写旧侧车，不可能覆写块布局的侧车。
- 迁移时在暂存区里生成新侧车：从旧侧车拷贝「正文 hash 仍存在于新块集合」的 `EntryTags` 和冷却表。迁移不改正文，所以标签直接继承，不会触发重打标。
- **键仍然是正文 hash，允许多对一**：多个块的正文完全相同（例如复制粘贴的条目）时共享同一条 `EntryTags`。标签本来就由内容派生，相同正文得到相同标签是正确的。不需要也不存在「块 ↔ 记录 1:1」这一约束。
- **精确 GC**（只在块布局启用，每次侧车合并时在锁内执行）：
  - 一条记录保留，当且仅当至少有一个 active 或 archived 的块正文 hash 等于它的键；
  - 删除多个同正文块中的一个，不影响其余块的记录；
  - 冷却表（`aInjectedAt/pInjectedAt`）按同样规则修剪；
  - review 建议引用了不存在的 hash ⇒ 删除；
  - `dismissed` 中 `until` 已过期的项 ⇒ 删除。
  - 不变式：`|entries| ≤ |块布局中不同正文 hash 的个数|`。
- **sanitizer 兼容**：`sanitizeEntryTags` 保留 `globalP`；`sanitizeSuggestions` 接受新的 kind；`sanitizeDismissed` 接受 `kind` 与 `until`。这些都在 P0 完成。未知字段一律丢弃（原有行为）；旧 kind 的处理逐字节不变。
- 否决方案（改用 block id 作键）：`wire.ts`、segment 去重、冷却表、review、details 的语义都要跟着改，还会破坏 B 层「文本改过就重新注入」的行为。

### 3.3 注入模型：常驻区 + Jev + Topics 索引（Q1 重设计）

#### 3.3.1 三路注入

| 路              | 内容                                                                            | 机制                                                           | 预算                                                     |
| --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| **常驻区**      | `authority:user ∧ scope:global ∧ status:active`，受众匹配（到期的也在，带标注） | system prompt `## Memory`，每轮都在                            | 软预算 `memory.residentBytes`（默认 2048 B），**不截断** |
| **Jev 相关性**  | 其余全部 active 块：agent 块 + `scope:topic` 用户令（到期 agent 块除外，§5.1）  | U/A/E/B/P 各层（消息通道），topic 类用户令在候选排序里**优先** | 沿用各层预算（U 4096 B/3 条，P 2048 B/2 条…）            |
| **Topics 索引** | 每主题一行                                                                      | system prompt `## Memory` 尾部；模型可 `memory view <topic>`   | 常量 `INDEX_MAX_BYTES = 2048`，溢出时退化为 compact 列表 |

- **常驻判定只看 frontmatter**，不读侧车，所以渲染器不依赖 Jev。jev off 和 secure 域下行为一致。
- **topic 类用户令「优先」的具体含义**：
  - P 层 40 槽优先入池的排序本来就是「用户令 → `max p × importance` → file」；
  - U 层在 `RECALL_MAX_CANDIDATES` 裁剪时，topic 类用户令先入池；
  - **不放宽阈值**，避免噪音回潮。

#### 3.3.2 常驻区预算与超额策略

- **预算值**：`memory.residentBytes` 默认 **2048 B**（取值 512–16384）。依据：
  - pi-toolkit 实测 global 只有 3 条 / 524 B，约占 25%；
  - 2048 B 约合 680 个中文 token，与原 core 区（1600 B）的常驻成本在同一量级；
  - 按典型长度约 300 B/条，可以容纳 6–8 条常设规则。
- **计量**：所有被渲染的常驻块正文字节之和（含到期标注），每块另加 2 B 分隔符。
- **排序**（只决定显示顺序，**不决定取舍**）：
  1. 未到期的在前；
  2. `importance` 降序（读侧车，缺省视为 2）；
  3. `updated` 降序；
  4. id 升序。
- **超额不截断**：常驻块**全部渲染**，不会出现「+N more」。超额时：
  1. 常驻区末尾追加一行：`- resident: 2.6k/2.0k over budget — consolidate (/mem review)`。
  2. sweep 生成 `resident-budget` 建议，候选为排序靠后的 global 块。可选动作：
     - 降级为 topic（用户在 `/mem review` 里执行，属于用户动作）；
     - 与相似 global 块合并；
     - 保持（dismiss 7 天）。
  3. 启动提醒（主会话 TUI）：`memory: global user rules 2.6k/2.0k — consolidate or demote to topic → /mem review`。
  4. doctor D21：超过预算报 warn，超过 4 倍报 error；只报告，不拦截。
- **受众过滤在计量之前**：子会话只看 `audience ∈ {all, child}`，主会话只看 `{all, main}`。超额按主会话口径判定。
- **写入时不拒绝**：写 global 用户令永远成功，回显中带 `resident:` 用量行（§4.1.5）。原来的 `E_CORE_BUDGET` 取消。

#### 3.3.3 渲染契约（`blocks/render.ts`）

```
## Memory (<slug>) — <T> topic(s) · <B> block(s)

### User rules (always on)
- [general.001] 该用户拍板的事（方案、范围取舍…）主动用 ask_user 提出（2026-11-02 用户令）。                          ← global 块正文，按 §3.3.2 排序
- [general.002] 验收选 deepseek 系时优先…（2026-11-05 用户令）（已到期，待用户确认）   ← 到期 global：仍注入，首行末尾加标注（文本同 jev/format.ts）
- resident: 2.6k/2.0k over budget — consolidate (/mem review)        ← 仅超额时出现

Topics (relevant blocks are injected automatically; read one with memory view <topic>):
- quota — tags: config, model-routing, network · 6 blocks · 2 decisions
- pitfalls-git — tags: git-commit, deletion, git-push · 12 blocks · 3 decisions · 1 expired
- …（超过 INDEX_MAX_BYTES 时退化为 `- also: a, b (+N more, +M archived)`，规则同 tiered buildTail）
```

- **常驻区不加 agent fence**：常驻区里只有用户令，按原约定用户内容不加 fence。agent 块只走 Jev 消息通道，那里有自己的「项目数据，不是新的用户消息」声明。
- 没有常驻块时，整个 `### User rules` 段省略。
- **常驻块行格式**（r5，裁定 8）：`- [<id>] <正文首行>`，正文其余行缩进两个空格；正文本身以 `- ` 开头时先去掉这两个字符再拼接；到期标注附在首行末尾。§3.3.5 依赖这一格式从 snapshot 文本解析常驻集合；id 也方便模型直接 `memory view/update`。
- **索引行字段**（单行 ≤200 B，沿用 `INDEX_LINE_MAX_BYTES`），依次为：
  1. `<topic>`；
  2. ` — tags: a, b, c`：该主题 active 块的侧车标签（只计 p≥0.5 的派生标签加 frontmatter 手工 `+tags`，不计类型标签），按出现块数取前 3，同数时按标签 id 升序。没有任何标签时（jev off 或未打标）改为 ` — sections: x, y`，即块 `section` 值按频次取前 3、每个截断到 24 B；仍然没有就省略这一段；
  3. ` · <N> blocks`：active 块数，包含 global；
  4. ` · <D> decisions`：`scope:topic` 用户令数，为 0 时不显示；
  5. ` · <E> expired`：已到期但未归档的块数，为 0 时不显示。
- **主题排序**：active 块数降序，相同则按名字升序。只剩 archived 块的主题不列出，计入 `+M archived`。
- **render cache 指纹**包含本地日期，跨过午夜后到期过滤自动生效。
- **子会话**：`childProfile: none` 时没有 `## Memory`；`core`/`full` 时都是「常驻区（受众过滤后）+ 索引」。
- `inlineMax`/`byteCap`/`coreBytes`/`blockBytes` 在 blocks 布局下不生效，设置说明里注明「tiered/legacy only」。

#### 3.3.4 依赖 core 的代码路径怎么改

| 现路径                                                                                    | blocks 布局下                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JevRenderInfo { primary?, omittedSections, coreInlined }`（`inject.ts jevRenderInfoOf`） | 追加可选字段 `residentBlocks?: readonly string[]`。blocks 渲染器填写它，`coreInlined:false`，不填 `primary`。tiered 路径不变                                       |
| `wire.ts isStaticCore(entry, info)`                                                       | `info.residentBlocks !== undefined ? info.residentBlocks.includes(entry.block?.id ?? "") : <原逻辑>`（r5：比较块 id，不比较 `entry.file`）。保留函数名，缩小改动面 |
| U 层 `recallCandidates`（~1247）                                                          | 通过 `isStaticCore` 自动排除常驻块；topic 类用户令照常作为候选                                                                                                     |
| A 层 `tool_call`（~1639）                                                                 | 同上。效果：已常驻的 global 用户令不会再被 A 层重复注入（「删除只用精确路径」这类 topic 用户令仍由 §6.3 的 E 层规则降噪）                                          |
| P 层 `predictCandidatesFor`（~1770，`select.ts isStaticCore`）                            | 同上；§6.4 中「已在 prompt」= 常驻                                                                                                                                 |
| E 层 `recallE`                                                                            | 原来不判断 static core；blocks 布局下同样排除常驻块                                                                                                                |
| `doctor.ts` D01 / D02 / D09                                                               | blocks 目录下不报，由 D21 接替                                                                                                                                     |
| `init-command.ts`                                                                         | blocks 目录下不生成文件，只提示 `blocks layout has no core file — write an always-on user rule with memory create … <!-- mem user scope=global -->`                |
| `tool-v2.ts assertWithinHardLimit`（coreBytes）                                           | 只在 v2 中使用                                                                                                                                                     |
| `tidy/*` 中的 primary/pin 逻辑                                                            | blocks 目录禁用 `/mem tidy`（Q5），不会走到                                                                                                                        |
| `pin: true`                                                                               | blocks 布局下没有 pin 语义；迁移时丢弃，并写入报告                                                                                                                 |

#### 3.3.5 常驻区与两层冻结：snapshot + ledger 协议（r5 重写，裁定 8）

**问题**：`## Memory` 是 sysprompt hub 的 stable section（注册名 `pi_project_memory`），存在两层冻结：

- **hub 冻结**：段落开头把 provider 的 live 值冻结为 snapshot，之后最多发送 `maxCount` 次尾部更新，超限后变为 `POINTED`；
- **provider 冻结**：`freezeInjectionAfterWrite=true` 时，provider 自己持续返回写入前的旧块。

所以「当前渲染」≠「模型实际看到的」，`residentBlocks` 不能取当前渲染结果。

**hub 生命周期（已核对 `src/sysprompt/hub.ts` 与 `src/prompt-sections/stable-section.ts`）**：

| 事件                                | hub 行为                                                                                                                       | 对本协议的含义                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `session_start` reason `new`/未找到 | `resetToFresh()`：snapshot 为 undefined，下一轮 `resolveAtTurn` 刷新                                                           | 本轮 snapshot = 本轮 provider 输出                      |
| `session_start` resume/fork         | 从分支读回持久化的 `SectionState`，`forgetAnnounced`（snapshot 原样保留）                                                      | snapshot = 读回的文本；ledger 从分支恢复（见下）        |
| `session_start` reload 且 exact     | 原样恢复 state（snapshot 不变）                                                                                                | 同上                                                    |
| `session_tree`                      | 读回分支 state 并 `forgetAnnounced`                                                                                            | 同上                                                    |
| 压缩后的新段                        | `markStale` ⇒ 下一轮刷新                                                                                                       | 新 snapshot ⇒ ledger 重置为新 snapshot                  |
| mode `live`                         | 每轮 `markStale` ⇒ 每轮刷新                                                                                                    | 每轮 ledger 都重置为当轮 snapshot                       |
| `resolveAtTurn`                     | `stale ∨ snapshot===undefined` ⇒ 用 live 刷新；否则 snapshot 不变，live 不同则发尾部更新（超 `maxCount/maxBytes` ⇒ `POINTED`） | snapshot 只在刷新时变；尾部更新是额外送达，可能造成重复 |

**定义**：

1. **渲染行带 id**（§3.3.3 的修订）：常驻区每个块渲染为 `- [<id>] <正文首行>`，后续行缩进两个空格；到期标注附在首行末尾。`blocks/render.ts` 导出 `parseResidentSection(text): Map<id, renderKey>`：在 `### User rules` 段内以 `^- \[(<块 id 正则>)\] ` 切分条目，`renderKey = sha1(该条目全部渲染行)`。标注变化、正文变化都会改变 renderKey。
2. **`snapshot`**：本轮实际位于 system prompt 中的常驻集合 = `parseResidentSection(snapshotText)`。`snapshotText` 的取法：
   - 读 `sections._state("pi_project_memory")`（`PromptSectionHub` 已有的接口成员，**不改 hub**）；
   - Jev 的 `before_agent_start` 在 hub 之后注册（`src/memory/index.ts` 已有注释说明），所以读到的是 hub 本轮已决定的 state；
   - 若 state 为 `stale` 或 snapshot 为 undefined（hub 本轮尚未刷新的防御分支），则取本轮 provider 输出，因为 hub 刷新时采用的正是它。
   - 生产接线：`src/memory/index.ts` 调用 `wireJev` 时传入 `getSectionSnapshot`（读上述 `_state`，P4 完成）；P3 阶段该依赖缺失时取本轮 provider 输出（blocks 布局在 P5b 前不进入生产）。
3. **`ledger`**（模型实际已被告知的常驻集合）= snapshot ∪ R 已通知的新增/变更 − R 已通知的移除，形如 `Map<id, renderKey>`。
   - `snapshotKey = sha1(snapshotText)`。snapshotKey 与上次不同（新会话、压缩新段、live 每轮刷新、provider 冻结解除）⇒ ledger 重置为 snapshot。
   - **恢复**：每条 R 消息的 `details` 携带 `{snapshotKey, ledger: [[id, renderKey], …]}`（常驻区 ≤ 约 2 KB，条目很少）。resume/reload/tree 之后的第一轮，从分支上找最近一条 `snapshotKey` 等于当前 snapshotKey 的 R details，用它的 `ledger` 恢复；找不到 ⇒ ledger = snapshot。这与 hub 自己从分支读回 snapshot 的生命周期完全对齐。
4. **应常驻集合 `want`** = 当前 corpus 中 `isResident(b) ∧ eligible(b, layer:"R")` 的块，按同一渲染函数计算 `Map<id, renderKey>`。
5. **重算判定**：每次 `before_agent_start` 计算 `key = (corpusFingerprint, today, snapshotKey)`；与上次相同则复用结果，否则重算 `want` 与差分。`corpusFingerprint` = `blocks/` 目录下所有 `*.md` 的 `(name, size, mtimeMs, ino)` 排序后的 sha1（只做 lstat，不读正文），因此其它进程的写入和跨日都能被发现，**不依赖本会话的失效回调**。

**R 层差分**（新注入层 `R`，jev on 时运行）：

| 差分                                   | 通知                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `id ∈ want ∖ ledger`                   | 新增规则：`- 新增 <id>：<渲染文本>`                                                   |
| `id ∈ want ∩ ledger` 且 renderKey 不同 | 变更：`- 已变更 <id>（以此为准）：<渲染文本>`。正文修改与**到期标注变化**都走这一行   |
| `id ∈ ledger ∖ want`                   | 移除：`- 已移除 <id>（已删除/已取代/降为 topic/受众不符）`；被取代时附 `→ 见 <新 id>` |

```
[memory · R] 常驻规则已变更（以此为准）：
- 新增 general.004：<正文>
- 已变更 general.002（以此为准）：<正文>（已到期，待用户确认）
- 已移除 general.003 → 见 general.012
```

- 下发后，按通知内容更新 ledger，并把新 ledger 写进本条 R 消息的 details。同一 `(id, renderKey 或 removed)` 在一个 ledger 生命周期内只通知一次。
- hub 尾部更新也可能送达同样的新内容，造成的重复可以接受；遗漏不可接受。
- **Jev 的常驻排除**：`JevRenderInfo.residentBlocks = ledger 的 id 集合`。新增的 global 在 R 通知送达之前不在 ledger 中，仍可作为 U/P 候选。
- **jev off**：没有消息通道，也就没有 R 通知，只依赖 hub 尾部更新；`POINTED` 或 provider 冻结时常驻区可能要到下一段才更新（残留 R13）。

**异步结果的提交规则**：U/E 层（以及 P 层的模型结果）在等待分类器期间，块可能被改写。候选在选择时记录 `rev`；提交时逐项重读块：rev 不同（被改写、取代、删除、降级）⇒ **丢弃该项**，既不注入旧内容，也不在本轮替换成新内容（新内容由下一轮正常选择处理）。

**生产 hub 接线测试**（P3，`tests/memory/blocks/hub-wiring.test.ts`，使用真实 `createPromptSectionHub`）：

- 矩阵：{stable 不变、变化 1/2/3 次、第 4 次 ⇒ POINTED、mode live} × {freeze on/off} × {resume、reload(exact)、tree、压缩、跨午夜、另一进程写入}；
- 每个格子断言：
  1. `snapshot` 等于 `parseResidentSection(hub._state(...).snapshot)`；
  2. 该轮结束后 `ledger == want`（模型可见内容 = snapshot + 已发 R 通知，覆盖每个应常驻块的当前 renderKey，无遗漏）；
  3. `residentBlocks` 等于 ledger 的 id 集合；
  4. 跨午夜标注变化 ⇒ 恰好一条「已变更」；
  5. resume/reload 后 ledger 从 R details 恢复，不重复通知已通知过的项；
  6. 异步 U 结果提交前块被 update ⇒ 该项被丢弃。

#### 3.3.6 统一 eligibility（r4，评审 M11）

**`govern/eligibility.ts`**（pi-free）是所有注入出口共用的唯一判定：

```ts
export interface EligibilityCtx {
  today: string;
  isChild: boolean;
  ledger: ReadonlySet<string>; // r5：§3.3.5 ledger 的 id 集合
  layer: "U" | "A" | "E" | "B" | "P" | "S" | "R" | "external";
}
export function eligible(
  b: ParsedBlock,
  tags: EntryTags | undefined,
  ctx: EligibilityCtx,
): { ok: true } | { ok: false; why: string };
```

**判定规则**（按顺序）：

1. `status === active`，且没有 `supersededBy`；
2. 文件此刻仍然存在于 `blocks/`；
3. agent 块没有过期；
4. `effectiveAudience` 与当前会话是主会话还是子会话相匹配；
5. 不是 `private`/secret（external、外发相关的层）；
6. 消息层（U/A/E/B/P/S）中 `id ∉ ledger`。R 层只下发 global，external 只渲染常驻区和索引。

**两处校验**：

- **选择时**：候选池构建阶段校验。
- **最终提交时**：`commit()`、B 层重注、异步 U/E 结算后，用最新的 corpus（失效后重读）**再校验一次**，剔除在等待期间被取代、删除、过期或降级的块。
- **异步结果**（r5，裁定 8）：U/E/P 候选在选择时记录块 rev；提交时 rev 已变 ⇒ 丢弃该项，不注入旧内容，也不在本轮替换为新内容（§3.3.5）。

**接入清单**（补充 §3.3.4）：

| 出口                                                 | r4 处理                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| U / A / E / P                                        | 选择时 + 提交时两次 `eligible`                                                                |
| **B 层**（压缩后按旧 hash/anchor 重找）              | 找到条目后调用 `eligible`（包括 ledger 排除），不通过则丢弃                                   |
| **S 状态候选**（发版进行中）                         | 同上                                                                                          |
| **R 层**                                             | 只取 `isResident ∧ eligible(layer:"R")`                                                       |
| **external renderer**（`renderExternalMemoryBlock`） | blocks 布局下走 `renderBlocks`（常驻区 + 索引，按子会话口径做受众过滤），不再落入 legacy 分支 |

### 3.4 有效布局与工具表面选择（r4）

```ts
// blocks/naming.ts（pi-free）
export type DirFormat = "blocks" | "files" | "absent" | "held";
export type EffectiveLayout = "blocks" | "tiered" | "legacy";
export function effectiveLayout(settingsLayout: "blocks" | "tiered" | "legacy", dirFormat: DirFormat): EffectiveLayout;
export function toolSurfaceFor(settings: MemorySettings, dirFormatAtActivate: DirFormat): "v3" | "v2" | "legacy";
```

**`effectiveLayout`**：

| 设置 \ 目录            | `blocks`                        | `files`（未迁移）                                                            | `held`（回滚后） | `absent`                                                   |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `blocks`（**新默认**） | blocks                          | tiered（`migrate.auto=true` 时在 session_start 迁移；迁移成功后变为 blocks） | tiered           | blocks（首次写入时以 `source:"fresh"` 原子创建 `blocks/`） |
| `tiered`               | **blocks**（数据格式优先）+ D24 | tiered                                                                       | tiered           | tiered                                                     |
| `legacy`               | **blocks** + D24                | legacy                                                                       | legacy           | legacy                                                     |

**`toolSurfaceFor`**：工具在 activate 时注册，schema 是静态的。

- **输入**：`dirFormat(memoryDirFor(process.cwd()))`。
- **结果为 v3**：设置为 `blocks`，且满足下面任一条件：
  - 目录为 `blocks` 或 `absent`；
  - 目录为 `files`，且 `migrate.auto=true`，且不处于 secure-locked（本会话的 session_start 会迁移它）。
- **其余情况**（files+auto=false、held、tiered/legacy 设置）按原 `toolSurface` 注册 v2/legacy。这样迁移暂停期间，记忆写入**照常可用**。
- **漂移兜底**：
  - v3 遇到 files 目录（迁移失败或锁忙）⇒ 写命令报 `E_UNMIGRATED`，提示执行 `/mem migrate`；
  - v2 遇到 blocks 目录（本会话中途执行了 `/mem migrate`，或 cwd 变化）⇒ 写命令报 `E_BLOCKS_DIR`，提示 `/reload`。
  - 两者都不会写错地方。
- **约束**：registerTool 的次数和名字不变；activate-trace 必须逐字节不变（trace 同时记录生命周期副作用，P5b 要验证）。

---

## 4. 接口契约

### 4.1 memory 工具 v3

#### 4.1.1 Schema（`tool-surface.ts` 新增导出；已有导出不改）

```ts
export const MemoryToolParamsV3 = Type.Object({
  command: lit(["view", "create", "update", "delete", "search"]),
  path: S(), // block id（quota.007 / quota.007.md / /memories/quota.007.md）；view 时也可为主题名（quota / quota.md）；不给 = 列表
  topic: S(), // create：[a-z0-9-]{1,48}
  text: S(), // create/update：整块正文，首行可带 <!-- mem … -->
  rev: S(), // update 必填，delete 可选
  query: S(), // search
});
export const MEMORY_TOOL_V3_TEXT = {
  description:
    "Project memory as blocks (one fact per file, body ≤1024B). User rules with scope=global are always injected; " +
    "other blocks are injected when relevant; a topic index is shown. view [path] (omit = list; <topic> = its blocks) · " +
    "search query · create topic text · update path rev text (whole-block replace; rev from view) · delete path [rev]. " +
    "Never store secrets.",
  promptSnippet: "Project memory: view/search; one fact per block",
  promptGuidelines: [
    "memory: fix a stale fact with update (view first for rev) instead of creating a duplicate; one durable fact per block; mark user orders with <!-- mem user -->.",
  ],
} as const;
export const MEMORY_TOOL_V3_TEXT_JEV = {
  ...MEMORY_TOOL_V3_TEXT,
  description:
    `${MEMORY_TOOL_V3_TEXT.description} Entries are tagged automatically. Meta on the text's first line: ` +
    '<!-- mem user|lesson scope=global audience=main|child expires=YYYY-MM-DD until="…" supersedes=id tags=+a,-b private -->.',
};
```

- `toolSurfaceBytes ≤ 1700 B`，P4 实测后写入 golden。
- v3 不再带 `action/name/content/old_str/new_str/insert_*/old_path/new_path/view_range/section`。模型如果仍然传这些字段，由 `normalizeV3` 拦下并给出改法。
- 写入语法在 jev off 时同样有效（`parseInlineMeta` 是纯函数）；只是 jev off 时工具描述里不展示这串语法。

#### 4.1.2 命令语义

| 命令              | 输入            | 行为                                                                                                                                                                                                                              | 成功输出首行                                                 |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `view`（无 path） | —               | 预算行（`resident 0.5k/2.0k · index 1.4k/2.0k`）+ 主题表（每主题的 active/decisions/global/expired/superseded/archived 计数）+ doctor 摘要                                                                                        | `topics: 17 · blocks: 179 · global: 3`                       |
| `view <topic>`    | path=主题名     | 主题自动摘要行（同索引行）+ 名下 active 块。每块先输出头行 `#### <id> · rev <r> · <authority>[ · global][ · audience x][ · expires d][ · expired][ · until "…"]`，再输出正文，按 `section` 分组；superseded/archived 只列一行存根 | —                                                            |
| `view <id>`       | path=block      | 头行（另含 created/updated/supersedes/supersededBy）+ 正文                                                                                                                                                                        | —                                                            |
| `search`          | query           | 搜索 active 块（复用 `search.ts`），每个命中输出 `<id> · rev <r>` + 命中行                                                                                                                                                        | —                                                            |
| `create`          | topic, text     | 解析元数据 → 校验 → 锁内分配 seq，`createExclusive` → 锁外做 Jev 打标、scope 建议、取代判定                                                                                                                                       | `created quota.007 (topic quota) · rev 1-3fa9c2 · 412/1024B` |
| `update <id>`     | path, rev, text | 读取 → CAS → 元数据合并（§4.1.4）→ 锁内复核 → `replaceAtomic`，version+1；正文 hash 变化时重新打标并判定取代                                                                                                                      | `updated quota.007 · rev 4-…(was 3-…) · 530/1024B`           |
| `delete <id>`     | path [, rev]    | 软删到 `.trash`。删的是用户令 ⇒ voided 回显 + 通知；该块取代过别的块 ⇒ 提示被取代者仍处于 superseded 状态                                                                                                                         | `deleted quota.007 → .trash (restore: /mem restore --trash)` |

#### 4.1.3 错误语义（`MemoryError`，工具结果 `isError`）

| 码                                       | 条件                                                               | 消息要点                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E_TOO_LARGE`                            | 正文 >1024 B（包括对遗留超限块的 update）                          | `block body is 1310B > 1024B — split it into several blocks (one fact each)`                                                                                |
| `E_CONFLICT`                             | rev 不匹配                                                         | 当前 rev + 当前正文（≤1024 B）+ `merge and retry update with the current rev`                                                                               |
| `E_REV_REQUIRED`                         | update 缺 rev                                                      | 附当前 rev                                                                                                                                                  |
| `E_NOT_FOUND`/`E_BAD_TOPIC`/`E_BAD_PATH` | 路径非法或不存在                                                   | 给出合法格式                                                                                                                                                |
| `E_READONLY`                             | 子会话且 `allowWriteInChildSessions=false`                         | 沿用原文案                                                                                                                                                  |
| `E_UNMIGRATED`/`E_BLOCKS_DIR`            | §3.4                                                               | 附 `/mem migrate` 或改设置的提示                                                                                                                            |
| `E_LOCK_BUSY`                            | 沿用 M-T4                                                          | 原文案                                                                                                                                                      |
| `E_UNSUPPORTED_COMMAND`                  | `insert`/`str_replace`/`rename`/`action:"write"`/`action:"append"` | `"str_replace" is not available: memory is block-based — view <id> for rev, then update path rev text (whole block ≤1024B); a new fact → create topic text` |

- `action:"list"` 按 `view` 处理。
- 旧命令只报错，**不做隐式翻译**（理由见 §5.6 D7）。每次报错在 `.jev/diag.jsonl` 记一行 `unsupported:<cmd>`，用来观察模型何时改掉旧习惯。

#### 4.1.4 写入元数据语法与合并规则

- `text` 首个非空行的末尾可以带 `<!-- mem … -->`，由扩展后的 `parseInlineMeta` 解析。新增键：
  - `scope=global|topic`、`audience=all|main|child`；
  - `supersedes=id[,id]`、`title="…"`、`when="…"`；
  - 清除用：`expires=none`、`until=none`。
- 注释先剥离，再计量 1 KB。注释里出现服务端字段时一律忽略，并回显 `ignored: … (server-owned)`。
- **update 的合并规则 = 继承 + 覆盖**：没写的键继承旧值，写了的键覆盖旧值。目的是防止整块重写时，因为漏写注释而悄悄降级权威或 scope。
- **#26 用户令变更判定域**：以下改动直接写入，同时输出 `voided user rule:` 回显（字节不变）、发主会话 TUI warning、经过 CAS/abort 检查点，**不弹确认**：
  - 改写或删除用户令；
  - 显式 `mem lesson` 把权威从 user 降为 agent；
  - **模型**把 scope 从 global 改为 topic（用户在 `/mem review` 里做的不算）。
- 从 topic 升为 global **只能显式写 `scope=global`**，系统从不自动升级。

#### 4.1.5 回显（成功写入后逐行输出，没有的项省略）

```
created general.004 (topic general) · rev 1-3fa9c2 · 412/1024B
budget: resident 0.9k/2.0k · index 1.4k/2.0k
jev: rule · importance 3 · tags workflow,communication
scope: topic (decision record — injected when relevant). Looks like a standing rule (p=0.82) — add scope=global to inject it every turn
resident: 2.3k/2.0k over budget — still injected; merge or demote to topic (suggestion queued)
looks like a user order — if the user said it, add <!-- mem user -->
state snapshot: run id / quota reading / progress — add expires=YYYY-MM-DD or until="…", or rewrite as a durable conclusion
superseded: general.003 (user · global, p=0.91) — no longer injected; undo: /mem restore --block general.003
  note: general.003 was global; this block is topic — add scope=global if it should stay always-on
not superseded: pitfalls.012 is a user rule — agent blocks never supersede user rules (conflict p=0.91; review suggested)
conflict: pitfalls.020 (p=0.78) — below auto threshold; review suggested
audience: looks main-session-only (dispatch) — add audience=main if so
voided user rule: …
```

每行的出现条件：

| 行                                              | 出现条件                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `scope:`                                        | user 块、没有显式 scope、分类器 `globalP ≥ 0.7`（§5.3）             |
| `resident:`                                     | 写的是 global 块，或写入导致常驻区超额                              |
| `looks like a user order`                       | 只对 agent 块（原 userLike 逻辑）                                   |
| `state snapshot`                                | 只对 agent 块；取代 v2 的 `looks temporary`，**永不对 user 块出现** |
| `superseded`/`note`/`not superseded`/`conflict` | §5.4                                                                |
| `audience:`                                     | §6.1                                                                |
| `voided user rule:`                             | #26 原有行                                                          |

v2 路径的回显保持原样（I9）。

#### 4.1.6 `memory-tool-surface.json` 的申报式更新

- **只新增** key：`blocks`（description、promptSnippet、promptGuidelines、parameters 的 canonicalJson）、`blocksJev`（description）、`bytes.blocks`、`bytes.blocksJev`。
- 已有的 `legacy`/`v2`/`jev`/`bytes.*` 一字节不动。
- `tool-surface.test.ts` 追加 v3 用例；commit 正文写明「#36 申报：新增 v3 block 工具表面（2026-11-05 用户批准）」。

### 4.2 块存储 API（`src/memory/blocks/*`，pi-free）

> 下文的 `realDir` 一律指 `<memDir>/blocks` 的 canonical 路径（必须是真实目录且与 memDir 同 dev，否则 fail closed）。所有写操作都持有迁移锁（memDir 级目录锁），并且每个写操作之前调用 `memoryWriteGate.check`（§4.7）。

```ts
// format.ts
export interface BlockMeta {
  kind: "block";
  authority: "user" | "agent";
  scope?: "global" | "topic"; // 只对 user 有效；缺省 = topic
  audience?: "all" | "main" | "child";
  expires?: string;
  until?: string;
  supersededBy?: string; // 单边关系只落这一侧；写入语法 supersedes= 不进 BlockMeta（见 InlineMeta）
  status: "active" | "superseded" | "archived";
  section?: string; // ≤80 B，原 `## ` 标题
  heading?: string; // r5：≤120 B，原 `### ` 路径（`A › B`）；frontmatter 键 `heading`
  residue?: true; // r5：迁移残留块（§4.3.2 第 4 步）
  origin?: { file: string; lines: readonly [number, number] }; // r5：残留块来源，frontmatter 写作 `origin: core.md#L12-L18`
  tags?: { add: readonly string[]; remove: readonly string[] };
  private?: true;
  title?: string;
  when?: string;
  created: string;
  updated: string;
  version: number;
}
export interface ParsedBlock {
  id: string;
  topic: string;
  seq: number;
  meta: BlockMeta;
  body: string;
  raw: string;
  rev: string;
  errors: readonly string[];
}
export function parseBlockFile(name: string, raw: string): ParsedBlock | { stray: true; name: string };
export function serializeBlock(meta: BlockMeta, body: string): string; // 字段顺序固定，同 §3.2.2 表格顺序
export const BLOCK_BODY_MAX_BYTES = 1024;
export function bodyBytes(body: string): number;
export function isExpired(meta: BlockMeta, today: string): boolean; // expires < today
export function isResident(meta: BlockMeta): boolean; // authority=user ∧ scope=global ∧ status=active
export function computeRev(version: number, raw: string): string;

// naming.ts
export const BLOCK_NAME_RE: RegExp; // ^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}\.md$
export const ARCHIVE_NAME_RE: RegExp; // r5：BLOCK_NAME_RE 或 ^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}\.r[1-9][0-9]{0,2}\.md$
export function parseBlockName(name: string): { topic: string; seq: number } | undefined;
export function parseArchiveName(name: string): { topic: string; seq: number; r?: number } | undefined;
export function canonicalTopic(stem: string): string | undefined; // 小写、_→-、去非法字符、合并 -、截到 48
export function nextSeq(topic: string, used: Iterable<string>): number;
export function dirFormat(memDir: string): "blocks" | "files" | "absent" | "held"; // §3.2.3（hold 优先）

// marker.ts（blocks/.layout.json；N1：不含主题元数据）
export interface BlocksMarkerV1 {
  v: 1;
  migratedAt?: string;
  runId?: string;
  source?: "migrate" | "fresh";
  gen?: number;
  files?: readonly { path: string; sha256: string; size: number }[]; // 提交时清单，只用于提交前核对
}
export function readMarker(realDir: string): BlocksMarkerV1 | undefined; // 存在但不可解析 ⇒ {v:1}

// state.ts（r5，P1 实现：memDir/.blocks-state.json 与 .blocks-hold；写函数只在迁移锁内调用）
export interface BlocksStateV1 {
  v: 1;
  gen: number;
  overBudgetStreak: number;
  lastOutcome?: "committed" | "over-budget" | "aborted" | "drift" | "superseded-by-other";
  lastAt?: string;
}
export interface BlocksHoldV1 {
  v: 1;
  at: string;
  reason: "rollback" | "manual";
  gen: number; // 写 hold 时 bump 后的 gen
  rollback?: { from: "blocks"; to: string; done: boolean }; // to = .blocks-rolledback-<ts>
}
export function readBlocksState(memDir: string): BlocksStateV1; // 缺失 ⇒ {v:1, gen:0, overBudgetStreak:0}
export function writeBlocksStateLocked(memDir: string, next: BlocksStateV1): void; // writeTempRegular + replaceAtomic + fsyncDir
export function readHold(memDir: string): BlocksHoldV1 | undefined;
export function writeHoldLocked(memDir: string, hold: BlocksHoldV1): void; // 同上，持久化后才返回

// store.ts —— 写操作要求调用方已持有迁移锁
export interface LegacyFingerprint {
  files: readonly { name: string; sha256: string }[];
}
export interface BlockCorpus {
  blocks: readonly ParsedBlock[];
  strays: readonly string[];
  archivedByTopic: ReadonlyMap<string, number>;
  marker: BlocksMarkerV1 | undefined;
  legacy: LegacyFingerprint; // 根目录旧文件指纹（漂移检测）
  fingerprint: string; // §3.3.5 的 corpusFingerprint
}
export function topicSummary(corpus: BlockCorpus, index: JevIndexV1 | undefined, topic: string): string; // §3.3.3 第 2 段
export function readCorpus(realDir: string): BlockCorpus; // 无锁读者规则见 §4.3.8
export function createBlockLocked(
  realDir: string,
  topic: string,
  meta: Omit<BlockMeta, "created" | "updated" | "version" | "status" | "kind">,
  body: string,
  now: Date,
): ParsedBlock;
export function replaceBlockLocked(
  realDir: string,
  id: string,
  expectRev: string,
  next: { meta: BlockMeta; body: string },
  now: Date,
): ParsedBlock; // 抛 E_CONFLICT
export function trashBlockLocked(realDir: string, name: string, expectRev?: string): { trashName: string };

// adapter.ts —— Jev corpus 适配
export function blockToEntry(b: ParsedBlock, today: string): MemEntry;
// file=<id>.md · section=b.meta.section ?? "" · heading=b.meta.heading（undefined 时省略该键）· ordinal=b.seq
// block={id, scope, audience, status, supersededBy, snapshot, updated}（不含 heading，heading 只在 MemEntry.heading）
// inline 由 meta 合成；body/hash 与 splitEntries 对同一正文的结果完全相同
```

- `MemEntry` 追加可选字段 `block?: { id; scope?; audience?; status; supersededBy?; snapshot?; updated }`（§4.4）。jev/contracts 冻结表要求追加字段需报告 root，本文即为该报告。
- **heading 全链路**（r5，裁定 6）：迁移从 `splitEntries` 得到 `entry.heading` ⇒ 写入 frontmatter `heading` ⇒ `parseBlockFile` 读回 `meta.heading` ⇒ `blockToEntry` 输出 `MemEntry.heading` ⇒ `view <topic>` 按 `section › heading` 分组显示。tool-v3 写入语法不提供 heading（模型写的新块没有 heading）；`update` 继承旧块的 heading。
- `entryAnchor`：有 `block` 时返回 `block.id`（如 `quota.007`），模型可以直接用它去 `view`。
- `EntryIndex`：blocks 目录下每个 block 文件恰好对应一条 entry，`fileStatus` 固定为 `active`。

#### 4.2.1 safe-fs 新增的三个目录原语（r5，裁定 1，P1 实现）

`src/memory/safe-fs.ts` 仍是 `src/memory/**` 唯一允许 import `node:fs` 的文件（`tests/memory/fs-guard.test.ts` 不改、不放宽）。P1 **只新增**以下三个导出，既有导出的源码字节不变（verifier 用 `git diff -U0 -- src/memory/safe-fs.ts` 确认只有新增行）。

```ts
/** 同父目录内的目录 rename，目标必须不存在。任何不满足 ⇒ 抛 MemoryError，绝不降级为复制+删除。 */
export function renameDirNoClobber(parent: CanonicalDir, from: string, to: string): void;
// 1. from/to 都必须是 isSafeName 的单段名（不含 "/"、不为 "." ".."）；
// 2. lstat(parent/from)：必须是真实目录（不是 symlink），且 st.dev === parent 的 dev；记下 dev/ino；
// 3. lstat(parent/to) 必须 ENOENT（调用方持有迁移锁，协作写者之间无竞争；rename(2) 会覆盖空目录，所以这一步不可省）；
// 4. renameSync；EXDEV / ENOTSUP / EPERM / EINVAL / ENOSYS 等任何错误 ⇒ 抛 MemoryError("E_RENAME_UNSUPPORTED" 或原 code)，不重试、不复制；
// 5. 再 lstat(parent/to)：dev/ino 必须等于第 2 步记录的值，否则抛 MemoryError("identity-changed")。

/** 删除 parent/childName 整棵树：不跟随 symlink、不跨 dev、有操作数上限。 */
export function removeTreeNoFollow(
  parent: CanonicalDir,
  childName: string,
  opts: { maxOps: number; beforeOp?: () => boolean }, // beforeOp 返回 false ⇒ 立即停止（用于闸门/预算/abort）
):
  | { removed: true; ops: number }
  | { removed: false; ops: number; reason: "budget" | "stopped" | "not-dir" | "symlink" | "xdev" | "bad-name" };
// 根：lstat 必须是真实目录且与 parent 同 dev；遍历时每个条目先 lstat：
//   symlink ⇒ unlink 链接本身（从不跟随）；普通文件 ⇒ unlink；目录 ⇒ 同 dev 才递归，跨 dev ⇒ 整体停止并返回 xdev；
//   递归前后对目录做 dev/ino 复核，不一致 ⇒ 停止返回 not-dir。
// 每个 unlink/rmdir 计 1 op，到达 maxOps ⇒ 返回 budget（已删部分不回滚，剩余部分下次继续）。
// 只允许用于已在锁内 rename 成隔离名的目录（见 §4.3.3 清理协议），调用方保证。

/** 严格版目录 fsync：失败即抛（与既有 fsyncDirBestEffort 并存，后者不改）。 */
export function fsyncDir(path: string): void;
```

- 单测（P1，新建 `tests/memory/safe-fs-dir.test.ts`，tier1）：目标已存在（含空目录）⇒ 拒绝；from 是 symlink ⇒ 拒绝；名字含 `/` ⇒ 拒绝；模拟 EXDEV（通过注入的 rename 失败钩子或跨 tmpfs 绑定不可得时用 `vi.spyOn` 包装）⇒ 抛错且源目录原样存在、没有任何复制产物；removeTree 遇到指向外部目录的 symlink ⇒ 只删链接，外部文件完好；`maxOps` 截断后再次调用能删完；`beforeOp` 返回 false 立即停止；`fsyncDir` 对不存在路径抛错。
- **为什么不复用 `renameNoClobber`/`removeFlatDir`**：前者只接受普通文件，且在 EXDEV/EPERM 时降级为非原子 rename，正是本裁定禁止的行为；后者只删扁平目录，而暂存区含 `archive/`、`.trash/`、`.jev/` 子目录。

### 4.3 迁移（r4 重写：暂存区构建 + 单次原子 rename）

#### 4.3.1 触发、暂停与并发

| 触发 | 条件                                                                                                                                                                | 说明                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动 | 主会话 `session_start`（复用已有 handler，**不新增注册**）；`settings.layout==="blocks"`；`settings.migrate.auto===true`；`dirFormat==="files"`；写闸门通过（§4.7） | 惰性：只处理当前 cwd。有执行总预算（§4.3.4），超出预算就放弃并清理暂存区，提示执行 `/mem migrate`                                                                                                                                            |
| 手动 | `/mem migrate [--dry-run] [--all] [--report] [--status] [--import-legacy] [--rollback]`                                                                             | 显式 `/mem migrate`（不带 `--dry-run`）会清除本目录的 `.blocks-hold`，并且**无视 `migrate.auto`**，这就是「显式解除」。`--all` 遍历**有效 memory root**（`paths.memoryRoot`，secure 域下为 `<state>/memory`）下的全部 `files` 目录，仅限 TUI |
| 状态 | `/mem migrate --status`                                                                                                                                             | 只读，web 可用。输出：`auto: on/off (source)` · `layout setting` · `dir: blocks/files/held/absent` · `legacy drift: N` · 最近一次 runId                                                                                                      |

- **暂停手段**：
  - 全局：`memory.migrate.auto=false`（旧代码的设置解析是容忍式的，会忽略这个未知键，所以可以在升级之前就写好）；
  - 单目录：`.blocks-hold`。
- **并发**：
  - 构建阶段不持锁；
  - 只在短临界区持有迁移锁（r5）：快照 + 建暂存区（含 owner.json）、提交前五项复核 + rename、清理（§4.3.3）；
  - rename 的目标 `blocks` 已经存在 ⇒ 失败，说明别的会话已经迁移完成，丢弃自己的暂存区即可。
  - 同一目录不会同时存在两个完整的块布局。

#### 4.3.2 规划（`migrate-plan.ts`，纯函数，支持 dry-run）

**输入**：根目录全部 v2 合法 `.md` 的字节（含 sha256/size/mtime）、旧侧车、今天的日期。
**输出**：`MigrationPlan { blocks: {name, content}[]; sidecar; report; whole: string[] }`。

1. **范围**：根目录 `.md`（`archive/`、`.trash/`、`.backup/` 不迁移）。CC 索引 `MEMORY.md` 不拆分，也不生成块，在报告中标为「保留在旧布局」。
2. **主题归属**：
   - `core.md`（或充当 primary 的 pin 文件）⇒ `general`；
   - frontmatter 有合法 `topic` ⇒ 用它；否则用 `canonicalTopic(词干)`；
   - CC 单事实文件 ⇒ 用前缀作主题，原 description/read_when 写进块级 `title/when`（Q4）；
   - 多个文件映射到同一主题 ⇒ 合并，写入报告。
3. **条目边界**：用 `splitEntries(file, raw, fileInfo)`（jev-arch §4.1 规则 1–5）。每个块记录：
   - `section`（最近的 `## `）和 `heading`（`A › B`，有 `### ` 时才有）；
   - `expires/until/tags/private` 取自 `entry.inline`，`gate*` 丢弃；
   - `created/updated` 依次取侧车 `at` → 文件 `updated` → mtime。
4. **源字节覆盖审计与权威一致性**（评审 B6；r5 按裁定 4 修订）：对每个文件计算「已覆盖行」= 各 entry 的 `lineStart..lineEnd`、frontmatter 行、H1/H2/H3 标题行（这些已经作为 `section/heading` 元数据保留，H1 写进报告）、空行。「未覆盖片段」= 极大连续的非空未覆盖行段（例如独立的 fenced code、`splitEntries` 规则之外的结构）。
   - **整文件权威一致**的定义：文件默认权威（第 5 步表格按文件类型得出）与该文件每个 entry 的 `entry.authority` 全部相同。拆出 0 个条目的文件视为一致（只有默认权威）。
   - **一致**且（存在未覆盖片段，或拆出 0 个条目但正文非空）⇒ **whole 兜底**：该文件整体生成一个块，正文 = 去掉 frontmatter 后的完整正文；`whole: true` 写入报告；允许超过 1 KB（豁免）并生成 `oversize` 建议；authority/scope 取该一致权威（即第 5 步的结果）。
   - **不一致**（混合权威，例如 `source: agent` 文件里有 `mem user` 条目，或手写默认 user 的文件里有 `mem lesson`）⇒ **不做 whole 兜底，不选文件默认权威**：
     - 每个 entry 照常成为独立块，保留各自的 authority、scope（第 5 步）、期限和标签；
     - 每个未覆盖片段单独生成一个**残留块**：`authority: agent`、`status: active`、`residue: true`、`origin: <文件名>#L<起>-L<止>`，`section/heading` 取片段之前最近的标题；超过 1 KB 时豁免并生成 `oversize` 建议；
     - 迁移报告 `residue[]` 逐条列出 `{id, origin, bytes, 前 80 字符}`，P8 的 dry-run 过目必须包含这一节；
     - 残留块**不作为自动取代的目标**（§5.4 复核条件），也不进入常驻区；用户用 `update` 改写后 `residue` 标记由服务端清除。
   - 这就是 fail closed：任何时候都不丢字节，也不静默提升或降低权威；旧文件本身也原样留在根目录。
5. **authority 与 scope**（用户裁定 + Q4）：

   | 来源                                                                 | authority | scope                            |
   | -------------------------------------------------------------------- | --------- | -------------------------------- |
   | `core.md` 中的显式 `mem user`，以及手写 core.md 中默认为 user 的条目 | user      | **global**（纯指针除外）         |
   | 其它文件中的显式 `mem user`                                          | user      | topic                            |
   | 手写文件中默认为 user 的条目（CC 前缀文件除外）                      | user      | topic                            |
   | CC `feedback_*` / `user_*`                                           | user      | topic                            |
   | CC `project_*` / `reference_*`                                       | agent     | —                                |
   | `source: agent` 文件中的非 user 条目、`mem lesson`                   | agent     | —                                |
   | 原来带 `pin: true` 的其它文件中的用户令                              | user      | topic，另生成 `scope-check` 建议 |

6. **指针**（Q10）：
   - 纯指针（侧车 `type==="pointer" ∧ typeP≥0.7`，或正则命中且剩余文本 ≤30 码点）+ 本应为 global 的用户令 ⇒ 改为 topic；
   - 疑似指针 ⇒ 保持原样，生成 `pointer` 建议；
   - agent 指针照常迁移。
7. **受众**（Q7）：只给 global 块播种 `audience: main`（规则见 r3），其余块交给 Jev 推导。
8. **超过 1 KB**（Q3）：原样保留并豁免，生成 `oversize` 建议。
9. **报告** `.migration-report.json`：
   - `files[]`：`{name, sha256, size, mtimeMs, frontmatter, h1, blocks: [ids], whole, mixedAuthority}`；
   - 以及 global 清单、指针、超限、受众播种、合并、inline 解析错误、残留块 `residue[]`（r5）。
   - 报告**只写一次**，之后不再修改。

#### 4.3.3 执行与提交（`migrate.ts`；r5 重写，裁定 1/2/3/7）

**一次迁移 run** 的身份：`runId = newTidyId()`（`<ts>-<pid>-<hex6>`），`owner = {v:1, runId, pid: process.pid, startTicks, bootId?, hostname: os.hostname(), createdAt}`，其中 `startTicks/bootId` 取自既有 `readProcIdentity(process.pid)`（`os.hostname` 由调用方以端口注入，blocks/** 保持 pi-free 且不新增 fs 导入）。

1. **快照 + 建暂存区**（迁移锁内，临界区 1）：
   1. 读 `hold`：存在 ⇒ 放弃（自动路径）；显式 `/mem migrate` 先按 §4.3.5 第 4 步清除 hold。
   2. `lstat(blocks)` 存在 ⇒ 放弃（已迁移）。
   3. 读 `.blocks-state.json` 得 `gen0`。
   4. 读取全部根目录 `.md` 的字节与 sha256（受 §4.3.4 预算约束）。
   5. 运行清理协议（下文「清理」），只处理本临界区剩余预算允许的部分。
   6. `gate.check` 后 `mkdir .blocks-staging-<runId>`（0700），`gate.check` 后写 `owner.json` 并 fsync 文件。mkdir 与 owner 写入在同一把锁内完成，所以任何持锁的清理者看到的暂存区要么不存在、要么已有 owner.json。
   7. 释放锁。
2. **构建**（锁外）：在暂存区内写全部块、`archive/`、`.trash/`、`.jev/index.json`、`.migration-report.json`，最后写 `.layout.json`（含 `gen: gen0+1` 与完整 `files` 清单）。**每个** mkdir/write/fsync 之前调用 `gate.check(memDir)`（§4.7），拒绝 ⇒ 立即停止，暂存区留给清理协议。每个文件写完 fsync，最后 `fsyncDir` 暂存目录及其子目录。每 32 个操作检查预算与 abort，并 `await` 一次 `setImmediate` 让出事件循环（§4.3.4）。
3. **提交**（迁移锁内，临界区 2）。下列条件**全部**满足才提交，任一不符 ⇒ 不 rename，本 run 的暂存区按清理协议隔离：
   1. `hold` 不存在；
   2. `.blocks-state.json` 的 gen 仍等于 `gen0`；
   3. `lstat(blocks)` 为 ENOENT；
   4. 根目录 `.md` 集合与每个文件的 sha256 和快照一致（不一致：自动触发提示「旧文件变化，稍后重试」；手动触发自动重做 1 次）；
   5. **暂存身份**：`owner.json.runId === runId` 且 pid/startTicks 与本进程一致；**清单**：遍历暂存区（no-follow，同 dev），文件集合与 `.layout.json.files` 完全相等，且逐个 sha256 一致；暂存区内没有 symlink、没有清单外条目。
   - 全部满足 ⇒ `gate.check` ⇒ `gen0+1` 写入 `.blocks-state.json`（fsync）⇒ unlink `owner.json` ⇒ `renameDirNoClobber(memDir, ".blocks-staging-<runId>", "blocks")` ⇒ `fsyncDir(memDir)`。`fsyncDir` 失败只记 warn（rename 已完成，提交点已过）。
   - **rename 就是唯一的提交点**。rename 抛错（EXDEV、不支持、身份变化）⇒ fail closed：暂存区保持原样、目录仍是 `files`，记 diag 与 `lastOutcome:"aborted"`，自动路径不再重试本会话；绝不尝试复制。
4. **收尾**（锁外，失败无害）：通知 `memory: migrated N files → B blocks / T topics (global G, whole W, residue R, oversize K) — /mem migrate --report · undo: /mem migrate --rollback`；`overBudgetStreak` 归零。

**清理协议**（只在迁移锁内运行；**不看年龄**）：

- 候选：memDir 下名字**精确匹配** `^\.blocks-staging-(<runIdRe>)$` 或 `^\.blocks-staging-(<runIdRe>)\.trash-(<runIdRe>)$` 的条目（`<runIdRe>` = `newTidyId` 的格式）。`blocks`、`.blocks-rolledback-*`、其它任何名字都不是候选。
- 对 `.blocks-staging-<id>`（尚未隔离）：no-follow 读 `owner.json`，按以下规则分类：
  - **本进程**：`pid === process.pid ∧ startTicks` 与本进程一致 ∧（bootId 相同或双方都缺）且 `runId !== 当前正在构建的 runId` ⇒ 可清；
  - **已确认死亡**：`hostname` 与本机相同，且（`bootId` 都存在且不同 ⇒ 已重启）或（`isProcessAlive(pid) === false`）或（`readProcIdentity(pid).startTicks !== owner.startTicks`）⇒ 可清；
  - 其余（活着的其它进程、其它主机、owner.json 缺失或不可解析、symlink、跨 dev）⇒ **不动**。owner.json 缺失的暂存区由 doctor D25 报告，交给用户手工删除。
- 可清的暂存区：`gate.check` ⇒ `renameDirNoClobber(memDir, ".blocks-staging-<id>", ".blocks-staging-<id>.trash-<runId>")`。改名在锁内完成后，原 owner 即使复活也找不到自己的暂存区，提交第 5 条必然失败。
- 删除：对 `*.trash-*` 条目调用 `removeTreeNoFollow(memDir, name, {maxOps, beforeOp: () => gate.check(memDir).ok ∧ 预算未尽 ∧ !signal.aborted})`，仍在锁内执行。一次清理最多 500 op，剩余部分留到下次。`*.trash-*` 是已在锁内判定为垃圾的目录，任何后来的持锁清理者都可以继续删除。

**各崩溃点下的状态**（独立进程读目录的测试逐一覆盖）：

| 崩溃点                   | 磁盘状态                               | 读者看到   | 下次启动                                 |
| ------------------------ | -------------------------------------- | ---------- | ---------------------------------------- |
| 建暂存区时（锁内）       | 可能有不带 owner.json 的空暂存区       | 完整旧布局 | 不清理（无 owner），D25 报告             |
| 构建中                   | 旧文件 + 不完整暂存区（有 owner.json） | 完整旧布局 | owner 已死 ⇒ 隔离并删除，重新迁移        |
| 构建完、提交前           | 旧文件 + 完整暂存区                    | 完整旧布局 | 同上（暂存区不复用）                     |
| gen 已 bump、rename 前   | 同上，gen 已变                         | 完整旧布局 | 同上；其它 run 的 gen 复核也会失败，无害 |
| rename 后、fsync/收尾前  | 旧文件 + 完整 `blocks/`                | 完整新布局 | 无需处理                                 |
| 清理中（已隔离、删一半） | `*.trash-*` 残留                       | 不受影响   | 下次持锁清理继续删                       |

- **不需要 recoverRun，也不需要 durable continuation**：暂存区是纯派生数据，可以随时丢弃重建；提交点之前所有改动都不可见。
- **不再复用 tidy txn**：safe-fs 的 txn resolver、backup/trash 命名、manifest 校验**都不改**；safe-fs 只新增 §4.2.1 的三个目录原语；`TidyManifestKind` 不追加。回滚依赖的「旧布局」就是根目录的原文件，没有任何代码会修剪它们（块布局下禁用 `/mem tidy`，v3 工具不操作根目录）。

#### 4.3.4 执行预算（r5 重写，裁定 11）

一次 run 从开始到结束共用**一个** deadline 和一个操作计数器，覆盖快照、构建、提交前复核、清理四个阶段，包括等锁时间。所有 deadline 经 `clampSpanMs`；不新增计时器（用 `Date.now()` 比较）。

| 项                                                                             | 自动触发（session_start）                        | 显式 `/mem migrate`（TUI 显示进度） |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------- |
| 总墙钟（含等锁）                                                               | 3000 ms                                          | 60 000 ms                           |
| 源文件数 / 源总字节                                                            | ≤ 2000 / ≤ 4 MiB（快照时超出即放弃，不建暂存区） | ≤ 20 000 / ≤ 64 MiB                 |
| fs 操作总数（每次 open/read/write/fsync/mkdir/rename/unlink/rmdir/lstat 计 1） | ≤ 12 000                                         | ≤ 120 000                           |
| 单次等锁                                                                       | `min(500 ms, 剩余预算)`                          | `min(5000 ms, 剩余预算)`            |
| 一次清理                                                                       | ≤ 500 op                                         | ≤ 5000 op                           |

- **检查与让出**：所有同步 fs 循环每 32 个操作检查一次「deadline、操作数、`signal.aborted`、闸门」。在**锁外**（构建阶段）检查后 `await new Promise((r) => setImmediate(r))` 让出事件循环；在**锁内**（快照、提交复核、清理）只检查不让出，超限即中止并释放锁。`setImmediate` 不是计时器，不会让 `pi -p` 挂住（I5）。
- **超预算或 abort** ⇒ 丢弃本次结果：本 run 的暂存区若已建立，在一个额外的有界锁段（等锁 ≤ 200 ms、≤ 3 op）内隔离为 `.trash-<runId>`；拿不到锁就留给下次的「本进程」清理。随后在同一锁段内把 `overBudgetStreak + 1` 与 `lastOutcome:"over-budget"` 写入 `.blocks-state.json`（拿不到锁则不记，宁可少计）。会话照常以 tiered 运行。
- **连续 3 次超预算**（`overBudgetStreak ≥ 3`）⇒ doctor D25 与启动提醒：`memory: automatic migration exceeded its budget 3 times — run /mem migrate (TUI, larger budget)`。自动路径仍会在之后的启动中尝试（每次都有界）。
- **shutdown/reload**：`session_shutdown` 触发 abort；检查点见上，最迟 32 个操作内停止。
- pi-toolkit 实测约 200 个块、约 900 个 fs 操作，预计 < 200 ms。

#### 4.3.5 回滚 `/mem migrate --rollback`（r5 重写，裁定 2/5）

1. **顺序固定**（迁移锁内，每步之前 `gate.check`）：
   1. `gen1 = gen + 1` 写入 `.blocks-state.json`，fsync；
   2. 写 `.blocks-hold` = `{v:1, at, reason:"rollback", gen: gen1, rollback:{from:"blocks", to:".blocks-rolledback-<ts>", done:false}}`，fsync 文件与 memDir；
   3. `renameDirNoClobber(memDir, "blocks", ".blocks-rolledback-<ts>")`，`fsyncDir(memDir)`；
   4. 把 hold 改写为 `done:true`，fsync。
   - 第 2 步一旦持久化，`dirFormat` 立刻是 `held`，读者回到旧布局，即使第 3 步还没做。
   - **续做**：之后任何持有迁移锁的入口（主会话 session_start 的迁移检查、任何 `/mem migrate*` 命令）看到 `hold.rollback.done===false` 且 `blocks/` 仍存在 ⇒ 补做第 3–4 步。
   - hold 存在时一律不自动迁移。
2. **回滚承诺**（与 P8 的分工）：
   - 回滚恢复的是**根目录当前的旧布局内容**。根目录文件迁移后从未被新代码写过，所以它们就是迁移前的字节，再加上迁移后未 reload 的旧会话写入的漂移；
   - **迁移前的原始字节**由 P8 第 4 步的 tar 快照保证（迁移报告里的 sha256 可用来核对），回滚命令本身不承诺；
   - 迁移后新建或修改过的块全部保留在 `.blocks-rolledback-<ts>/`（**永不自动删除**，也不进入限量的 trash）；命令会列出「与迁移报告相比新增或变化的块」，方便用户手工处理。
3. **崩溃点**：第 1 步后崩溃 ⇒ 只是 gen 变了，块布局照常使用，正在构建的其它 run 会在提交复核时放弃；第 2 步后、第 3 步前崩溃 ⇒ held，下次续做；第 3 步后、第 4 步前崩溃 ⇒ held，续做第 4 步。每个边界都有崩溃测试（plan P2）。
4. **再次迁移**：用户执行 `/mem migrate` ⇒ 锁内先完成未完成的回滚续做 ⇒ `gen + 1` 写入 state ⇒ 删除 `.blocks-hold`、fsync ⇒ 释放锁，然后按 §4.3.3 重新快照、构建、提交（快照记录的是删 hold 之后的 gen）。旧的 rolledback 目录保持不动。
5. **双进程交错**（A 构建 → B 提交并回滚 → A 尝试提交）：A 的 `gen0` 是 B 提交前的值；B 提交 +1、回滚 +1，hold 存在 ⇒ A 的提交复核第 1、2 条都失败 ⇒ A 丢弃暂存区。即使用户随后清除 hold（gen 再 +1），A 的 gen 也对不上。
6. 回滚之后需要 `/reload`，工具表面才会回到 v2（在此之前，v3 遇到 held 目录会报 `E_UNMIGRATED`）。

#### 4.3.6 旧布局漂移与显式导入（取代 r3 的「游离文件增量迁移」，评审 B4/B5）

- **检测**（sweep 执行，只读）：根目录 `.md` 的 sha256 与「迁移报告 + `.legacy-import.json` 中最近一次导入的 sha」不一致，或出现了新文件 ⇒ 视为漂移。
  - 启动提醒：`memory: legacy files changed after migration (N) — likely an un-reloaded pi session; /mem migrate --import-legacy`；
  - 生成 `legacy-drift` 建议。
- **导入** `/mem migrate --import-legacy [--dry-run]`（显式执行，仅主会话）：
  1. 对漂移文件重新运行规划第 3–8 步；
  2. 只为**正文 hash 不在现有块集合中**的条目调用 `createBlockLocked` 新建块（每个块都是一次原子 create，逐个独立，中断后重跑是幂等的，按 hash 去重）；
  3. 不修改、不删除任何已有的块。旧文件里被删掉或改写的条目**不会**反向作废现有块，只在报告中列出，由用户处理；
  4. 在 `.legacy-import.json` 中追加 `{at, files: [{name, sha256}], created: [ids]}`。
  - 根目录旧文件始终不动。
- **没有自动增量导入**：旧会话写入的内容是否还有效，只有用户知道。

#### 4.3.7 幂等与可重入

- 规划是确定性的；构建可以随时丢弃重建；提交是单次 rename；导入按 hash 去重。三者都可以重复执行，结果不变。
- 已迁移的目录：自动迁移直接 no-op；`/mem migrate`（非 `--rollback`/`--import-legacy`）提示 already migrated。

#### 4.3.8 无锁读者（r5，裁定 2）

渲染、`readCorpus`、`view/search`、Jev corpus 重建、doctor 都不持迁移锁。规则：

1. **每次读取只解析一次布局**：入口调用一次 `dirFormat(memDir)`；结果为 `blocks` 时立即 `canonicalDir(<memDir>/blocks)` 并记下 `{real, dev, ino}`。本次读取之后的所有目录列举和文件读取都使用这个 `real` 路径；**同一次读取中不再重新判定布局，也绝不回退去读根目录旧文件**。
2. **读到一半目录消失或被替换**（任一 `ENOENT`/`ENOTDIR`，或读完后 `lstat(<memDir>/blocks)` 的 dev/ino 与开始时不同）⇒ 本次读取作废：
   - 渲染返回该 cwd **上一次成功的渲染结果**（render cache 中已有的值）；没有就返回空段；
   - corpus/view/search 返回上一次成功的 corpus，没有则返回空 corpus 与 `E_UNMIGRATED` 提示；
   - 记一次 warn（每会话每 cwd 只记一次）：`memory: blocks/ changed during read (rollback or migration in progress) — using previous result`。
3. 结果为 `files`/`held`/`absent` 时，同样只按这一结果读完整次读取。
4. 这条规则保证读者永远不会把新旧两种布局、或两个代际的块目录混在一次结果里。

### 4.4 契约增量（P0 一次补齐，后续包不得再改，评审 M12）

```ts
// src/memory/jev/contracts.ts —— 只追加可选字段 / 联合成员
export interface InlineMeta {
  // …既有字段
  readonly scope?: "global" | "topic";
  readonly audience?: "all" | "main" | "child";
  readonly supersedes?: readonly string[]; // 写入语法，不落盘
  readonly title?: string;
  readonly when?: string;
  readonly clearExpires?: true; // expires=none
  readonly clearUntil?: true; // until=none
}
export interface EntryTags {
  // …既有字段
  readonly globalP?: number; // §5.3 g1 问句答案（按正文 hash，多块共享）
}
export type ReviewSuggestionKind =
  | "duplicate"
  | "supersedes"
  | "conflict"
  | "obsolete"
  | "user-like" // 既有
  | "expired-user"
  | "until-check"
  | "snapshot"
  | "pointer"
  | "oversize"
  | "resident-budget"
  | "scope-check"
  | "legacy-drift"; // 追加
export interface DismissedPair {
  // …既有 hashKey / anchorKey（单条建议的 hashKey 为单个 hash）
  readonly kind?: ReviewSuggestionKind; // 缺省 = 旧的成对 dismiss
  readonly until?: string; // ISO 日期；缺省 = 永久（与旧语义一致）
}
export type InjectLayer = "U" | "A" | "E" | "B" | "P" | "R"; // 追加 R（常驻变更通知）
export interface JevRenderInfo {
  // …既有字段
  readonly residentBlocks?: readonly string[]; // = ledger 的 id 集合（§3.3.5），不是当前渲染结果
}
export interface MemEntry {
  // …既有字段
  readonly block?: {
    id: string;
    scope?: "global" | "topic";
    audience?: "all" | "main" | "child";
    status: "active" | "superseded" | "archived";
    supersededBy?: string;
    snapshot?: boolean;
    updated: string;
  }; // r5：不含 heading（heading 只在 MemEntry.heading，§4.2）
}
// MemoryInjectDetailsV1.predict 追加 bypass?: true；PredictCallEntry 追加 windowMs?: number、attempts?: number
// MemoryInjectDetailsV1 追加 resident?: { snapshotKey: string; ledger: readonly (readonly [string, string])[] }（R 层，§3.3.5，r5）
```

```ts
// src/memory/jev/contracts.ts —— JevWritePort（r5，裁定 9）：沿用现有三个方法名，只追加可选入参/返回字段。
// 缺省（不传 block/askScope）时行为与 HEAD 逐字节相同，v2 调用方无需改动。
export interface JevWritePort {
  afterWrite(input: {
    cwd: string;
    file: string; // blocks 布局下为 "<id>.md"
    before: string | undefined; // blocks 布局下为旧块文件全文（create 时 undefined）
    after: string; // blocks 布局下为新块文件全文
    signal?: AbortSignal;
    registry: ClassifierRegistryLike | undefined;
    // ── #36 追加 ──
    readonly block?: {
      readonly id: string;
      readonly rev: string; // 写入后的 rev，供取代判定记录
      readonly authority: "user" | "agent";
      readonly scopeExplicit: boolean; // 本次写入是否显式写了 scope=
    };
    readonly askScope?: boolean; // true ⇒ 本次打标问句集合中加入 g1（§5.3）；缺省 false
    readonly wholeRelation?: boolean; // 2026-11-07：治理完整取代问句，独立于 askScope
  }): Promise<{
    echo: readonly string[];
    usage?: { costUsd: number; calls: number };
    // ── #36 追加 ──
    readonly relations?: readonly RelationVerdict[]; // 只判定不执行；执行在 govern/supersede.ts（P5a）
  }>;
  checkInline(file: string, before: string | undefined, after: string): string | undefined; // 不变
  touchedUserEntries(file: string, before: string, after: string, handWritten: boolean): readonly MemEntry[]; // 不变
}
export interface RelationVerdict {
  readonly kind: "supersedes" | "conflict";
  readonly newId: string;
  readonly newRev: string;
  readonly oldId: string;
  readonly oldRev: string; // 判定时读到的旧块 rev，执行时锁内复核
  readonly p: number;
  readonly auto: boolean; // 是否达到自动执行阈值（矩阵 + 阈值 + 每次 ≤2 已在判定侧应用）
}
```

- **P4 调用链**（名称以此为准）：`tool-v3` 写盘成功、释放锁之后调用 `jevWritePort.afterWrite({…, block, askScope})` → `write-port.ts` 在 `input.block !== undefined` 时用 `blockToEntry` 得到 entry（不走 `splitEntries`），compare 池按取代矩阵构造 → `tagging.tagOne({…, askScope})` → `questions.buildTagQuestions(entry, taxonomy, compare, { includeScope: askScope })`（第 4 个参数为追加的可选参数）。`g1` 与打标问句在**同一次** `askAll` 中发出，答案写入 `EntryTags.globalP`；relation 问句的答案组装成 `relations` 返回。
- **2026-11-07 接线补充**：仅 tool-v3 自动 `afterWrite` 在 `governance.enabled=true` 时传 `wholeRelation:true`；off 不传。write-port blocks → `tagOne` 同名可选键 → builder 第四参数组合 `{includeScope?, wholeRelation?}`；不得复用 askScope 开关。只有 `wholeRelation===true` 使用新 cN criteria；其余问句逐字节不变，g1 不变。v2、bulk、wire、jev-eval 不传新键，不改 taxonomyRev、不全量 retag。
- **缓存核证（2026-11-07）**：生产 `write-port.runAfterWriteBlocks` 正文 hash 未变只跳过；正文变更调用 fresh `tagOne`。`decideTagging` 仅持久化 m/t 标签与 scope 答案，不存 cN；`client.callOnce` 直接 `registry.classify`，仅 availability/health 等调度缓存，无生产 cN 答案重放缓存。本次完整 question 文本变化使以完整 request/question 为键的评测 replyKey 自然失效；不清私有缓存，不触碰真实数据。
- `askScope` 的取值由 tool-v3 决定：`block.authority === "user" ∧ !block.scopeExplicit ∧ jev full`。
- `checkInline` 在 v3 中对模型写入的原始 content（含行内注释）调用一次，语义不变。v3 的用户令守卫直接比较新旧 `BlockMeta.authority`（#26 判定域），不调用 `touchedUserEntries`；该方法保留给 v2。
- P5a 只消费 `relations`，**不再修改** `JevWritePort` 的签名。

- `src/memory/jev/index-store.ts` 的 sanitizer 兼容改动也放在 P0（见 §3.2.5）。P0 的测试要覆盖：
  - 新字段往返；
  - 旧侧车（没有新字段）读入后逐字节等价；
  - dismiss `until` 到期后被修剪；
  - 同 hash 多块时删除其中一块。
- `TidyManifestKind` **不追加**（r4 不再复用 txn）。

### 4.5 治理 sweep 契约（r4：预算、自触发、中止、闸门，评审 M15）

```ts
// govern/sweep-plan.ts（pi-free）
export type SweepReason = "startup" | "reload" | "write" | "task-done" | "push" | "release" | "budget";
export interface SweepPlan {
  archive: readonly { id: string; rev: string }[]; // 只含 authority:agent ∧ expires < today
  suggestions: readonly ReviewSuggestion[]; // 新增（已去重、未被 dismiss 或 dismiss 已过期）
  drift: readonly string[]; // 旧布局漂移文件（只用于提醒）
}
export function planSweep(
  corpus: BlockCorpus,
  index: JevIndexV1,
  legacy: LegacyFingerprint,
  today: string,
  reason: SweepReason,
  render?: { residentBytes: number; residentBudget: number; indexOverflow: boolean },
): SweepPlan;
```

- **执行模型**：`runSweep(memDir, reasons, signal)` 在已有回调（`session_start`、`onAfterWrite` 之后、Jev `turn_end`）里以 promise 方式启动，**不在工具调用的同步路径上**，不新增计时器。
- **单次预算**：
  - 最多 50 个**写类安全原语的保守成本单位**，不是所有 read + write 合计 50 次，也不是最多归档 50 个块。P5a 的 `SweepResult.operations` 使用此口径：一次完整归档计 6（archive 目录确保、映射临时写、映射替换、块移动、归档正文临时写、正文替换），一次治理侧车 index 写计 3（目录确保、临时写、替换）；已有目录的确保仍保守计费。它不是底层 syscall 精确计数；安全原语内部的 open/write/fsync 等不另逐次计数。
  - **读与写共同受总墙钟 ≤ 1000 ms 约束**，不是把读排除在时间预算之外。线性快照扫描逐个正文读取前检查 deadline、write gate 和 AbortSignal，每读 128 个块 yield 一次；写类原语之间也检查 deadline/gate/abort。同步文件系统原语本身不能被 JavaScript 在执行中抢占，检查发生在原语边界。
  - 锁等待 `timeoutMs: 500`（同时受本轮剩余墙钟预算收紧），拿不到锁就放弃本轮（置位保留，下一个信号再跑），**不重试循环**。
  - **快照与 CAS 的职责分离**：扫描只捕获一次目录身份和列表，线性读取 no-follow 常规块文件，末尾复核目录 dev/ino；不再为每个块重新枚举全目录。扫描结果不是写入授权：每个归档仍在目录写锁内复核旧 rev、authority、active 和 expires，并在移动前再核对 rev。目录身份改变或读取时 gate/abort/deadline 失败即停止本轮。
  - **P5a 实测（2026-11-06，临时目录 2000 块）**：开发复跑 371 ms，独立验收复跑 418/419/457 ms；均为 48 个上述写成本单位、归档 8 块（8 × 6），其余留待后续信号。该基准不是任意存储介质上的延迟保证，50/1000/500 的生产门槛未调高。
- **归档**（r5，裁定 5）：在锁内复核 rev，然后把 `blocks/<id>.md` 移入 `blocks/archive/`，存储名按以下规则确定：
  - `archive/<id>.md` 不存在 ⇒ 存储名 = `<id>.md`；
  - 已存在 ⇒ 存储名 = `<id>.r<n>.md`，`n` 取 1–999 中最小的未占用值（例如 `quota.007.r1.md`）。它满足 v2 安全名 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$` 与 `ARCHIVE_NAME_RE`，不满足块名正则，所以永远不会被误当成 active 块；
  - 999 个都被占用 ⇒ 本操作跳过并记 diag（不可能在正常使用中出现）。
  - **顺序**：先把 `{storedName → {id, archivedAt, reason}}` 合并写入 `blocks/archive/index.json`（`writeTempRegular` + `replaceAtomic`），再 `renameNoClobber(blocks, <id>.md → archive/<storedName>)`（同 dev 文件 rename），最后把 archive 内文件的 frontmatter 改为 `status: archived`。index 先写，所以崩溃后最多留下一条「存储文件不存在」的 index 记录，下次 sweep 在锁内删除它。
  - `/mem restore --block <id>` 在 index 中按原 id 查找；只有一条 ⇒ 直接恢复到 `blocks/<id>.md`（目标存在 ⇒ 拒绝并提示）；多条 ⇒ 列出存储名，要求用 `--block <storedName>` 指定。恢复成功后删除对应 index 记录。
  - 每个操作都是单文件原子操作，中断不会留下需要恢复的中间态：最坏情况是「已移入 archive 但 status 还是 active」，渲染时以所在目录为准，下次 sweep 补写 status。
- **自触发屏蔽**：sweep 自己的写入调用 `onAfterWrite(cwd, {origin:"sweep"})`，**不再**触发 sweep，只用来让渲染失效。
- **重入**：闭包里维护 `sweepInFlight`；运行期间到达的信号合并为一个 `pending`，结束后最多再跑一次。
- **去抖**：`{corpus 指纹, today, legacy 指纹}` 与上次相同时跳过（startup/reload 除外）。
- **无进展保护**：本轮所有操作都因 CAS 失败 ⇒ 记 diag，本会话不再为同一批目标重试，直到 corpus 指纹变化。
- **中止**：`session_shutdown`（含 reload）时 abort，每个操作之间检查 signal。
- **闸门**：每个写操作之前调用 `memoryWriteGate.check(memDir)`（§4.7）。

#### 4.5.1 #50 增量后台修正（子项，未启动）

#50 合并为 #36 的子项，保留编号与独立验收。#36 已覆盖策略、确定性执行、同步关系判定和周期建议；#50 只新增增量聚合调度、模型修订正文及受控提交/撤销：

1. **增量聚合调度器**：按 canonical memDir 汇聚变更，支持计数阈值、安静期 debounce、空闲窗口、冷却周期及任务完成触发。
2. **修订提案与提交器**：模型生成修正正文而非仅分类；冻结双方 rev，受控提交。默认**建议模式**，仅获批动作自动提交。
3. **修正审计与可恢复**：记录 origin、批次幂等键、输入/输出摘要，支持原文恢复。

必须复用、禁止双实现：`govern/supersede.ts` 的权限/阈值、`govern/review-lite.ts` 的交互/dismiss、`govern/sweep-plan.ts` 的到期规则、`jev/tagging.ts` + `jev/client.ts` 分类器（勿新造客户端），以及目录锁/CAS/单边恢复。事件入口与建议存储各只能有一个 owner。

前置缺陷：#66（sweep/review 共享运行状态导致建议被覆盖）和 #67（判定 rev 与提交 rev 不一致）必须先修；#68（Jev 120s 只 race 不 abort、队列无上限）作为作业级 abort 的基础。六类权限已由 root 于 2026-11-08 拍板（用户令允许窄条件自动取代、agent 块与已过期块可自动删除、同/跨主题合并可自动、低置信仅建议、agent 块 expires 可自动、跨 project/Hub 仅建议），详见 [plan 权限表](plan.md#权限表2026-11-08-root-已拍板)；所有自动动作仍须走既有阈值 + CAS + 审计快照 + 原文恢复。

**验收钉子**：N 次变更合并一次；安静窗口内新写重置等待；自写不再入队；超时/abort/旧 rev 零提交；队列/调用/费用/并发达 cap 停止；撤销可恢复原文字节。

### 4.6 新增 / 变更设置（r4）

| 键                               | 变更                | 默认                        | 说明                                                                                                                              |
| -------------------------------- | ------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `memory.layout`                  | 值域增加 `"blocks"` | **`"blocks"`**（原 tiered） | 非 live；§3.4                                                                                                                     |
| `memory.migrate.auto`            | **新增（r4）**      | `true`                      | `false` ⇒ session_start 永不自动迁移（显式 `/mem migrate` 仍可用）；保持用户定的惰性迁移默认行为；P8 用它在翻转默认值之前暂停迁移 |
| `memory.residentBytes`           | 新增                | `2048`（512–16384）         | 常驻区软预算                                                                                                                      |
| `memory.governance.enabled`      | 新增                | `true`                      | `false` ⇒ 不做 sweep 写盘、不自动取代、不生成治理建议、不发治理通知；渲染时的到期过滤仍然生效                                     |
| `memory.jev.predict.model.waitS` | 默认值              | `1.0`（原 0.5）             | Q9                                                                                                                                |

### 4.7 secure 写闸门 `memoryWriteGate`（r4，评审 B9）

```ts
// src/memory/contracts.ts（P0 追加类型）
export interface MemoryWriteGate {
  /** 每个自动写操作前调用；false ⇒ 本操作及本轮剩余操作全部跳过，不读不写、不 mkdir。 */
  check(
    memDir: string,
  ): { ok: true } | { ok: false; reason: "locked" | "unmounted" | "path-escaped" | "identity-changed" };
  /** activate 时捕获 memDir 的 realpath + dev/ino（目录不存在则不捕获，之后的自动路径一律视为 identity-changed）。 */
  capture(memDir: string): void;
}
// src/secure/memory-gate.ts（新建，P2）：secureMemoryWriteGate(domain) —— plain 域恒 ok；
// locked ⇒ 恒 {ok:false,"locked"}；secure ⇒ 每次 readProcMountinfo() + vaultMountState(...) === mounted
// ∧ inVaultWriteZone(canonicalPath(memDir)) ∧ dev/ino 未变。
```

- **接线**：由 `src/index.ts` 把 `secureMemoryWriteGate(secureDomain)` 作为 `wireMemory` 的 `writeGate` 选项传入。这只是装配，符合 I2。
- **必须过闸门的自动写入口**：
  - 启动自动迁移：快照前、提交前各检查一次；
  - 显式 `/mem migrate`（`--all` 按目录逐个检查）；
  - `--import-legacy`、`--rollback`；
  - sweep 的每个操作；
  - 自动取代：锁内执行前检查；
  - 侧车写入（打标、冷却戳）。
  - 迁移暂存区构建与清理的每一个 mkdir/write/fsync/rename/unlink/rmdir（r5）。
- **工具写入**：已经有 secure 每次 `tool_call` 的挂载复检（失败会把会话翻转为 LOCKED）。v3 在锁内写盘前**再调用一次** `check`，以覆盖「tool_call 检查之后、写盘之前挂载消失」这段窗口。
- **locked**：自动路径零读零写，连 `dirFormat` 都不探测；渲染器在 locked 会话里本来就不会运行（input 被 handled）。
- **自动路径永不创建目录**：`ensureMemoryDir` 只允许显式路径（工具写入、`/mem init`、显式 `/mem migrate`）调用；自动路径遇到目录缺失或身份变化就直接跳过。防止在挂载点消失后，在明文底层目录里创建替代目录。
- **暂存区与清理的闸门方式**（r5，裁定 7）：二选一中选择「**逐操作闸门复检**」。暂存区构建与清理中的每个 mkdir/write/fsync/rename/unlink/rmdir 之前都调用 `check(memDir)`，拒绝 ⇒ 立即停止本 run，不再做任何写操作（已写的暂存文件留给之后的清理协议）。
  - 不选「持有目录 fd 的受控方式」的理由：Node 的 `fs` 没有 `openat`/`mkdirat`/`renameat`/`unlinkat` 等以目录 fd 为基准的 API，持有 fd 并不能让后续按路径的操作绑定到同一个目录，这个方案在本项目的运行时里无法实现。
  - 代价：secure 域每次检查读一次 `/proc/self/mountinfo`（约 50–200 µs），计入 §4.3.4 的预算；pi-toolkit 规模约 900 次检查，< 200 ms。plain 域 `check` 恒为 O(1)。
  - **构建期挂载消失**：check 在下一个操作前失败 ⇒ 停止；由于 memDir 本身没有被重建，后续操作也不会落到明文底层（自动路径从不 mkdir memDir）。P2 的 `tests/secure/memory-gate.test.ts` 覆盖「构建进行到一半卸载 vault」。
- **自动路径与目录创建**（r5 澄清）：自动路径**不创建 memDir 及其祖先**；在已通过闸门的 memDir 内创建暂存子目录是允许的，且每次 mkdir 前复检。
- **新目录的 capture**（r5，裁定 7）：memDir 不存在时，只有显式路径（工具写入、`/mem init`、显式 `/mem migrate`）可以 `ensureMemoryDir`。创建成功后**立即**调用 `gate.capture(memDir)`（与 activate 时的规则相同：记录 realpath + dev/ino，并要求位于 vault 写区内），之后自动路径（sweep、取代、侧车写入）才允许在该目录写入。在 capture 之前，自动路径对该目录的 `check` 一律返回 `identity-changed`。
- **`--all` 与备份**：遍历和备份都使用有效 root（`paths.memoryRoot`，secure 域下为 `ARMORY_MEMORY_ROOT=<state>/memory`）。P8 的 tar 备份写到有效 root 的同级目录：plain 为 `~/.pi/agent/`，secure 为 `<state>/`，保证备份留在加密边界之内。
- **测试**：
  - tier1：用伪造的 mountinfo 文本对闸门纯逻辑做单测；
  - secure 项目真实挂载接线测试 `tests/secure/memory-gate.test.ts`（P2 新建，并注册到 `tests/tiers.ts` 的 `SECURE_MOUNT_FILES`——这是本任务**唯一一次**修改 tiers.ts）：
    - sweep 进行到一半卸载 vault ⇒ 之后零写入，且明文侧没有新目录；
    - locked 会话 session_start ⇒ 不迁移；
    - `--all` 只遍历 `<state>/memory`。
    - r5：迁移构建进行到一半卸载 vault ⇒ 停止、零后续写入、明文侧无新目录；
    - r5：在 gocryptfs 真实挂载上完成一次暂存区构建 + `renameDirNoClobber` 目录提交，以及一次回滚。

---

## 5. 治理四原则的落地

### 5.1 原则① 到期

| 对象                        | system prompt                                    | Jev U/A/E/B/P                                                                    | 落盘                                            |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| agent 块，`expires < today` | 不常驻；计入所在主题索引行的 `expired`           | 从候选池剔除                                                                     | 下次 sweep 自动归档（可恢复）                   |
| user·global，到期           | **仍常驻**，首行末尾加「（已到期，待用户确认）」 | 已常驻，不进入 Jev                                                               | 生成 `expired-user` 建议；**永不自动处理**      |
| user·topic，到期            | 不常驻；计入索引行的 `expired`                   | **仍是候选**，被注入时带「（已到期，待用户确认）」（沿用 `jev/format.ts:46-58`） | 生成 `expired-user` 建议；永不自动处理          |
| 任意块，带 `until`          | 照常                                             | 照常                                                                             | 生成 `until-check` 建议，同一块 14 天内最多一次 |
| superseded 块               | 不注入                                           | 剔除                                                                             | 原地保留，用 `/mem restore --block` 恢复        |

- **判定方式**：`isExpired(meta, localToday(now))`，读时计算，**零定时器**。跨过午夜时，render 指纹里的日期变化会触发重新渲染。
- **`/mem expired`**（blocks 目录）列出四组：expired-user、尚未归档的 expired-agent、superseded、until。可做的动作：续期、删除、恢复。

### 5.2 原则② 触发（事件 + 分级自动）

**触发信号**（全部复用已有 handler，不新增 `pi.on`）：

| 信号           | 来源                                                                                 | 执行                              | jev off 时                             |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------- |
| reload/startup | wireMemory 的 `session_start`（`index.ts:141`）                                      | 迁移完成后立即 sweep              | ✔                                      |
| 写入后         | `onAfterWrite`                                                                       | 工具返回后执行轻量 sweep          | ✔                                      |
| 任务完成       | Jev `tool_result`：`TaskUpdate` 且 `status === "completed"`                          | 置位 → 下一个 Jev `turn_end` 执行 | ✘（只剩上面两类和预算告急）            |
| 推送           | Jev `tool_call/tool_result`：shell-parse 解析出 `git push`                           | 置位                              | ✘                                      |
| 发版           | 同上，命中 `release.sh`/`gh release`；或 predict S 状态 `release-in-progress` 刚结束 | 置位                              | ✘                                      |
| 预算告急       | `memorySection.onRender`：常驻区超额或索引溢出                                       | 置位；生成 `resident-budget` 建议 | ✔（下一次 session_start 或写入时执行） |

**分级自动**：

| 等级           | 范围                                                                                                                                                     | 动作                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 自动（可恢复） | agent 块且 `expires < today`                                                                                                                             | 归档 + 非阻塞通知 `memory: archived 2 expired agent blocks (undo: /mem restore --block quota.007)` |
| 自动（维护）   | 侧车 GC（游离文件只报 D23；旧布局漂移只提醒，导入必须显式执行）                                                                                          | 增量迁移 / 清理 / GC                                                                               |
| 只建议         | agent 块带 `until`；状态快照超过 7 天仍无期限；`temporal ∈ {dated,event}` 超过 30 天；疑似指针；超限块；常驻超额；原 pin 文件中的用户令（`scope-check`） | 写入 `review.suggestions`；启动提醒里显示计数                                                      |
| 永不           | 任何 `authority:user` 块（global、topic 两类）                                                                                                           | 只建议                                                                                             |

**建议队列**：复用 `.jev/index.json` 的 `review` 侧车（pi-free，jev off 时也能读写）。jev off 时，`/mem review` 退化为 `govern/review-lite`，只处理治理类建议。新增 kind 的可选动作：

| kind                 | 可选动作                                                        |
| -------------------- | --------------------------------------------------------------- |
| `expired-user`       | 续期 / 删除 / 保持（dismiss 30 天）                             |
| `until-check`        | 归档 / 保持（dismiss 14 天）                                    |
| `snapshot`           | 归档 / 补 expires / 保持                                        |
| `pointer`/`oversize` | 打开 / 保持                                                     |
| `resident-budget`    | 把 X 降级为 topic / 与 Y 合并（打开对比）/ 保持（dismiss 7 天） |
| `scope-check`        | 设为 global / 保持 topic（永久 dismiss）                        |

**零定时器**：执行点都在已有回调里；锁的重试用 unref 定时器（I5）。

### 5.3 原则③ 写入：用户令豁免 + 状态快照强提示 + scope 建议

**用户令豁免**：`authority:user`（两类都算）

- 不出 snapshot/temporary 提示；
- 不做时效降权；
- 不产生 `snapshot`/`obsolete` 建议；
- 侧车 `temporal` 对 user 块一律忽略。只在消费端忽略，不改打标问句，因此不会触发全量重打标。

**状态快照识别**（`govern/snapshot.ts`，确定性，pi-free）：结果放进 `MemEntry.block.snapshot`，不落盘。

| 模式        | 正则（示意）                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------ |
| run id      | `\br_[A-Za-z0-9]{6,}\b`                                                                          |
| 提交/HEAD   | `\b(HEAD\|@)\s*[0-9a-f]{7,40}\b`，或 8–40 位 hex 且同句出现「当前/现在/目前」                    |
| 额度读数    | `\d+(\.\d+)?%`，且 30 字以内出现 `quota\|额度\|5h\|7d\|week\|窗口`                               |
| 进度/状态词 | `进度\|已完成\s*\d+\s*/\s*\d+\|进行中\|修复中\|待办\|暂停\|已关\|目前\|当前(?!会话)\|还没\|尚未` |

命中、没有 `expires/until`、且是 agent 块时：回显强提示，写入照常成功。7 天后仍未补期限 ⇒ 生成 `snapshot` 建议。

**scope 建议**（用户裁定：分类器只建议，不自动升级）：

- **触发条件**：user 块、没有显式 `scope`、jev 为 full。
- **问法**：写后打标在同一次 `askAll` 里多问一个问题 `g1`：「这条用户令是适用于所有工作的常设规则（global），还是针对某个功能/子系统的决策（topic）？」。这个问题只在写入时问，**不改 taxonomy**，不会触发重打标。
- **结果**：答案存入侧车 `globalP`。`globalP ≥ 0.7` ⇒ 回显 `scope:` 提示；skill 要求模型把提示转述给用户，由用户决定。
- jev off 或拿不到答案时不提示。

### 5.4 原则④ 冲突：自动取代矩阵与执行协议（r4，评审 B7；2026-11-07 用户新裁定）

**现行自动条件**：仅新块整体覆盖或明确废弃旧块全部有效信息才是完整取代。部分冲突/重叠保留旧块 active，只出建议；不引入 scope-dominance、历史恢复或新后台任务。下表的「自动」均受此条件约束；显式人指定边界、agent→user 永禁及既有 CAS/cycle/residue/dismissed/每写最多 2 条不变。

| 新块 \ 旧块 | user（global/topic）                                 | agent               |
| ----------- | ---------------------------------------------------- | ------------------- |
| **user**    | **自动**（已定）                                     | **自动**（N2 已定） |
| **agent**   | **永不**（已定）：只回显 `not superseded:`，并出建议 | **自动**（已定）    |

**关系只单边落盘**：

- 只在旧块上写 `supersededBy: <新块 id>`（同时 `status: superseded`）。新块**不存** `supersedes`：写入语法里的 `supersedes=` 只是一条输入指令，执行完就丢弃。查询「X 取代了谁」靠扫描 `supersededBy === X` 得到。
- 好处：
  - 一次取代 = 对旧块做**一次单文件原子替换**，不需要多文件事务；
  - 一对多（新块取代 2 个旧块）= 两次独立的单文件操作，部分完成也是一致状态，可以重跑；
  - 恢复 = 对旧块做一次单文件替换。

**判定**（锁外，沿用 relation 问句）：

- compare 池：
  - 新块是 user：跨主题 active user 块的词法 top-8 + 同主题 user 块 + agent 块词法 top-4，合计 ≤12；
  - 新块是 agent：同主题 agent 块 + 跨主题 agent 块词法 top-6，合计 ≤12；外加 user 块词法 top-2，只用来产生 `not superseded:` 回显。
- 每个候选记录**判定时看到的 rev**。
- 阈值（2026-11-07）：只有 `supersedes` p ≥ 0.85 才进入自动执行；`conflict` 即使 p=1 也不自动，p ≥ SUGGEST_P 仍回显建议。`CONFLICT_AUTO_P` 保留为历史 cutoff（评测参数读取兼容），不再控制执行。
- 治理 cN 问句定向比较「新块 → 旧块」：`duplicate` 也必须新含旧的全部有效信息（新块是旧块子集不合格）；`supersedes` 必须整体覆盖或明确废弃全部有效信息；部分重叠/冲突属于 `conflict` 或 `complementary`，不能自动。
- 每次写入最多执行 2 条（user/agent 合计），超出部分只出建议。
- 阈值是否合适以 §7.4 离线门禁 G1 的结果为准。门禁不达标时**只能提高阈值**，不能改变矩阵。

**执行**：对每个通过阈值的候选，在锁内依次复核以下条件，任一不满足就跳过，改为出建议，并在回显中注明原因（`skipped: …`）：

1. 写闸门通过（§4.7）；
2. **新块**的当前 rev 等于本次写入返回的 rev（新块在判定期间被 update、delete 或降级 ⇒ 判定作废）；
3. 新块 `status === active` 且没有 `supersededBy`；
4. **旧块**的当前 rev 等于判定时看到的 rev；旧块 active，且没有 `supersededBy`；
5. 新旧不是同一个块；
6. 权限合法：不能是 agent → user；自动路径下旧块不能是残留块（`residue: true`，r5 裁定 4；显式 `supersedes=` 不受此限）；
7. 以上全部满足 ⇒ 对旧块做 CAS 替换：`supersededBy`、`status: superseded`、version+1、`updated`。

- **为什么不会出现自环和循环**：条件 3 要求新块未被取代，条件 5 排除自取代。如果 A 取代 B 之后 B 再取代 A，执行 B→A 时 B 已经是 superseded，条件 3 不满足，直接跳过。所以 `supersededBy` 图恒为森林。
- **双会话并发**：两个会话分别判定「A 取代 B」「B 取代 A」，两次执行在锁内串行。后执行的一方会因为条件 3 或条件 4 失败而跳过。
- **链式取代**：A 被 B 取代，B 又被 C 取代 ⇒ A、B 都处于 superseded（各自记录自己的 `supersededBy`）。恢复 B 不会自动恢复 A。被取代状态不随目标块的状态变化而变化；目标块被删除时，doctor 报 D22（悬空引用），旧块仍保持 superseded，直到用户显式恢复。
- **恢复** `/mem restore --block <id>`：锁内 CAS 清除该块的 `supersededBy`，状态改回 active。只影响这一个块，一对多时逐个恢复。如果恢复后与取代它的块同时处于 active，属于用户的有意选择，不再自动判定（同一对块会被记入 dismissed，永久生效）。
- **新块不继承 scope**：新用户令取代 global 旧令时，回显 `note: … was global …`，**不会自动升为 global**。
- **通知**：
  - user 块被取代 ⇒ 主会话 TUI warning：`memory: user rule general.012 superseded general.003 (p=0.91) — undo: /mem restore --block general.003`（只含 id）；
  - agent↔agent ⇒ 只在回显中说明（降噪）；
  - 回显中列出每个候选的结果：`superseded` / `not superseded` / `skipped: <原因>` / `conflict`。
- **显式路径**（jev off 也可用）：
  - `supersedes=<id>` 走上面同一套锁内复核（条件 1–6），不需要分类器；
  - agent 块写 `supersedes=<user 块>` ⇒ 被忽略，回显 `supersedes ignored: … is a user rule`。
- **jev off**：只有显式路径。
- **崩溃**：每一次取代都是单文件原子替换，没有中间态。
- **测试**：
  - 迟到判定：判定后新块被 update，或旧块被 update；
  - 双进程并发互相取代（integration）；
  - 自取代；
  - A→B→C 链与恢复；
  - 一对多部分完成后重跑；
  - 阈值边界与上限；
  - 每一条复核条件各自的负例。
- **范围外**：迁移前就存在的 user↔user 冲突不自动处理。迁移后首次只跑 user↔user 的 review pass，结果只作为建议。

### 5.5 `/mem tidy` 在 blocks 目录（Q5 已定）

blocks 目录下 `/mem tidy`（交互式和 `--batch`）直接返回 `not available in block layout — use /mem review (suggestions) and governance (auto-archive)`。files 目录行为不变。

### 5.6 关键决策汇总

| #   | 决策                                                                  | 备选（未选）                                             | 理由                                                                          |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D1  | 文件名即 id，主题由前缀决定，frontmatter 不存 topic                   | frontmatter 存 topic                                     | 不会出现名字和字段不一致；工具本来也没有 rename                               |
| D2  | 是否常驻只看 frontmatter 的 `user ∧ global`                           | 读侧车 importance 决定取舍                               | 渲染器不依赖 Jev；jev off 与 secure 域下行为一致                              |
| D3  | 常驻超额不截断，靠建议和提醒                                          | 截断 / 自动降级                                          | 用户裁定；静默截断等于静默作废用户令                                          |
| D4  | 块布局使用独立侧车，hash 作键、多对一，做精确 GC（r4）                | 改用 block id 作键                                       | 消费方零改动；保留 B 层「改过就重注」的语义                                   |
| D5  | 到期读时计算，`expired` 不落盘                                        | 定时改 status                                            | 零定时器；跨日自动生效                                                        |
| D6  | 超限存量豁免                                                          | 自动拆分                                                 | 自动拆分可能破坏语义；这类条目数量很少                                        |
| D7  | 旧命令报错，不做翻译                                                  | 把 str_replace 自动翻成 update                           | 隐式翻译会绕过 rev/CAS 和 1 KB 规则；报错反而能让模型学会新用法               |
| D8  | 迁移 = 暂存区构建 + 单次原子 rename，旧文件原地保留（r4）             | 复用 tidy txn 逐文件 MOVE（r3）                          | 读者只会看到完整的布局；不需要恢复协议；txn 命名空间零改动；回滚零拷贝        |
| D9  | 治理信号挂在已有 handler 上                                           | 新增 `agent_settled` 等注册                              | activate-trace 不变；符合 I5                                                  |
| D10 | Topics 索引描述只用自动摘要（标签 → section → 仅计数）（N1 已定）     | `.blocks.json` 主题登记表；用旧 frontmatter 一次性做种子 | 用户裁定；种子必须落盘才能在之后使用，等同于登记表；自动摘要不会和块内容漂移  |
| D11 | core.md 改名为主题 `general`                                          | 保留 `core` 这个主题名                                   | core 已无特殊语义，保留原名会误导人和模型以为它仍常驻                         |
| D12 | secure 暂存区用逐操作闸门复检（r5）                                   | 持有目录 fd 的受控方式                                   | Node 没有 openat/mkdirat/renameat/unlinkat，fd 方案在本运行时不可实现         |
| D13 | 用 `gen` 代际令牌 + 提交前五项复核防止过期构建提交（r5）              | 只靠「`blocks/` 是否存在」判断                           | 回滚后 `blocks/` 不存在，过期构建会被误提交；gen 让任何布局转换都使旧构建失效 |
| D14 | 暂存区按 owner 身份清理，先锁内隔离再删（r5）                         | 按 mtime 年龄清理                                        | 年龄无法区分「被暂停的活进程」与「已死进程」，误删活构建                      |
| D15 | 混合权威文件拆分 + 残留块（r5）                                       | 整文件按默认权威保留                                     | 默认权威会静默改变部分条目的权威（user 降为 agent 或反之）                    |
| D16 | 常驻 snapshot 从 hub 持久化文本解析，ledger 随 R details 持久化（r5） | inject.ts 闭包内维护交付集合                             | 闭包在 resume/reload/跨进程后丢失；hub 文本是唯一可靠的「模型实际看到」来源   |

---

## 6. 注入改进

### 6.1 受众过滤

- **`effectiveAudience(entry)`**（`govern/audience.ts`），按顺序判定：
  1. frontmatter 写了 `audience` ⇒ 用它；
  2. 否则，如果侧车 `type === "rule"`，且 `dispatch`/`model-routing` 的 p ≥ 0.7 并且是该块最高分的标签 ⇒ `main`；
  3. 否则 ⇒ `all`。
- **过滤**：子会话剔除 `main`，主会话剔除 `child`。
  - 作用于常驻区（只看 frontmatter）和 Jev 各层候选池（三条规则都用）；
  - `view/search` 不受影响。
- 写入时如果第 2 条规则命中但没写 audience ⇒ 回显 `audience:` 提示。

### 6.2 时效降权（`govern/decay.ts`）

- **对象**：agent 块，没有期限，且为状态快照或 `temporal ∈ {dated,event}`。
- **乘子** `m(age)`（按 `updated` 算天数）：≤7 天为 1.0，≤30 天为 0.8，>30 天为 0.6。
  - U 层：p × m 后再和阈值比较；
  - P 层：候选排序键乘以 m。
- **点名要求**（P 与 A 层）：当前这一轮的文本必须和块首行有至少 1 个区分性 token 重合（复用 `match.ts prefilter`）。
- 常量写在代码里，不做设置。

### 6.3 E 层：只读工具失败不再撞词

- `recallE` 入口：`tool ∈ {read, grep, ls, find}` ⇒ 直接返回，不消耗 `E_MAX_PER_SEGMENT`。
- 其它工具：如果一个块的标签全部是 risk:high 动作类，且和失败命令的 `hitTags` 没有交集，就从候选池剔除。
- 与 §3.3.4 叠加后，global 用户令不再进入 E 层。

### 6.4 高危 tag 冷却饿死的降级出口

- **触发条件**（同时满足）：
  - P 预测出 risk:high 的 tag t，score ≥ 0.85；
  - t 下的合格候选全部被 `pInjectedAt` 冷却挡住；
  - 这些候选既不在当前 segment 的已注入集合里，也不是常驻块。
- **动作**：
  - 绕过冷却，注入排序最高的 1 条；
  - 每轮最多绕过 1 次；同一块每个 segment 最多绕过 1 次；
  - details 中写 `predict.bypass: true`。

### 6.5 P2 窗口 / 预算错配修复（Q9 已定）

**根因**（已核实）：

- `flight.ts` 中 `attemptBudgetMs = min(剩余, ceil(budget/2))`。默认链只有一档，所以唯一一次尝试在 1500 ms 时被掐断，结果为 `failed`。
- 等待窗口 `max(500, U≈1.5s)` 恰好也约等于 1.5 s，表面上看像是窗口在中止请求。

**修复**：

1. `attemptBudgetMs(budget, remaining, isLastAttempt)`：最后一档直接用 `remaining`；
2. `model.waitS` 默认值改为 1.0；
3. 窗口外才返回的结果写入 `pendingModel`，在相邻一轮兑现（规则不变）；
4. `kind:"call"` 追加 `windowMs`、`attempts`。

**复评指标**：

| 指标                               | 目标         | 现状 |
| ---------------------------------- | ------------ | ---- |
| 主会话及时率                       | ≥50%         | 33%  |
| 「单档 1500 ms 超时」造成的 failed | 0            | —    |
| 模型驱动的 P 注入                  | >0           | 0    |
| 子会话 P 层 irrelevant             | ≤35%         | 69%  |
| E 层 irrelevant                    | ≤30%         | 54%  |
| 用户令相关漏注入（新增监控项）     | 不高于迁移前 | —    |

---

## 7. 冻结物、门禁与离线门禁

### 7.1 逐项清单（r4）

| 冻结物                                                                                                                                     | 等级                           | 影响                                                                                                                                                                             | 处理                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-legacy-golden.json`                                                                                                                | B                              | 测试显式使用 legacy                                                                                                                                                              | **不得改**                                                                                                                                                                                                                          |
| `memory/tiered-golden/*.txt`                                                                                                               | B                              | `renderTiered` 不改                                                                                                                                                              | **不得改**                                                                                                                                                                                                                          |
| `memory/doctor-golden/current-5.json`                                                                                                      | B                              | files 格式的 fixture                                                                                                                                                             | **不得改**                                                                                                                                                                                                                          |
| `memory/jev-off-golden.json`                                                                                                               | A′                             | harness 的四个配置依赖默认布局                                                                                                                                                   | **golden 字节不动**。harness `settingsFor` 中：`disabled`、`legacy-tool`、`secure-sim`、`pi-api` **四个**配置显式加上 `layout:"tiered"`；`legacy-layout` **保持 `layout:"legacy"` 原值**（评审 M13）。P0 改完后逐配置比对，禁止重录 |
| `memory-tool-surface.json`                                                                                                                 | B（只能加 key）                | 新增 `blocks`/`blocksJev`/`bytes.*`                                                                                                                                              | 申报式更新                                                                                                                                                                                                                          |
| `governance/activate-trace.json`                                                                                                           | B                              | trace 同时记录注册顺序和生命周期副作用（session_start startup/new、shutdown 期间的 setStatus/autocomplete 等调用）                                                               | **必须逐字节不变**。不能只凭「注册次数不变」来断言；自动迁移和 sweep 在 trace 环境（memory 目录不存在）中不得产生任何被记录的调用。只要有任何差异，就停下报 root                                                                    |
| 新 golden：`memory/migrate-golden/**`、`memory/blocks-golden/*.txt`、`memory/doctor-golden/blocks-*.json`、`memory/blocks-off-golden.json` | **B（契约 golden）**，生成一次 | 统一规则：实现完成并经 verifier 审阅后，在同一包内用 `PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1` 录制一次（文件已存在则拒写）；之后的变化等同于申报式更新，commit 里写明原因（评审 m17） | P2 / P3 / P5b 录制；P7 把它们登记进 AGENTS.md 的 B 级行                                                                                                                                                                             |
| `tests/config/__corpus__/{setting-specs-pin,settings-corpus}.json`                                                                         | 测试钉                         | 新键、值域、默认值                                                                                                                                                               | 按规则刷新（P0、P5b）                                                                                                                                                                                                               |
| 其它 A 级 golden                                                                                                                           | A                              | 无关                                                                                                                                                                             | 不动                                                                                                                                                                                                                                |

### 7.2 I9 证明（r4：先列用户已批准的兼容例外，再用开关差分测试证明，评审 M14）

**用户已批准的行为变化**（D-2 预测注入修复、D-3/D-4 注入模型）。这些变化在 Jev 开启时，对**所有布局**都生效，**不属于** I9 的字节不变范围：

| #   | 例外                                                                | 生效条件                  |
| --- | ------------------------------------------------------------------- | ------------------------- |
| X1  | E 层对只读工具失败不注入；高危动作类标签必须与失败命令有交集        | jev on                    |
| X2  | P 层高危 tag 冷却饿死出口（bypass）                                 | jev on ∧ predict on       |
| X3  | flight 最后一档使用剩余预算；`waitS` 默认 1.0；call 记账新字段      | jev on ∧ predict.model on |
| X4  | 受众过滤（frontmatter 或 Jev 推导）                                 | jev on                    |
| X5  | 时效降权与点名要求                                                  | jev on                    |
| X6  | 统一 eligibility（含 ledger 排除、提交前再校验、异步 rev 变则丢弃） | jev on                    |

**I9 适用面与证明方式**：

| 开关 / 场景                                                      | 必须字节不变的面                                                                                                       | 证明（差分测试，不靠单份 golden）                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 显式 `layout:"tiered"` 或 `"legacy"` + files 目录                | 注册、system prompt 渲染、工具表面与输出、`/mem` 命令、doctor、启动提醒、tidy prompt（即 jev-off golden 覆盖的全部面） | jev-off golden（四配置钉 tiered、`legacy-layout` 保持原值）+ tiered / legacy / doctor golden。Jev 注入消息属于 X1–X6 例外                                        |
| `memory.jev.predict.model.enabled=false`                         | **修复后**的规则路径输出 ≡ 关掉 model 时的输出                                                                         | 差分测试：同一场景跑 model on（但模型调用被拒、无结果）与 model off 两次，P 层输出逐字节相同；并且 model off 时没有 flight、没有 `kind:"call"` 记录              |
| `memory.jev.predict.enabled=false`                               | 与「新代码去掉 P 层」逐字节相同（U 单独输出不变）                                                                      | 沿用 `wire-predict.test.ts` 的逐字节断言（基线是新代码，不是 HEAD）                                                                                              |
| `memory.governance.enabled=false`（blocks 布局，所有模块都接线） | 治理副作用为零，非治理行为与 on 相同（比较对象见下表）                                                                 | 差分测试：同一 fixture，依次发出全部 SweepReason，执行一次会触发自动取代的写入、一次跨午夜、一次使 global 块到期的写入；在 on/off 两种设置下逐项比较下表中的对象 |
| `memory.migrate.auto=false`                                      | session_start 不迁移，不创建 `blocks/` 或暂存区；工具表面按 v2 注册                                                    | 差分测试：同一 files 目录分别以 auto on/off 运行 session_start，off 时目录快照完全不变                                                                           |
| `memory.jev.enabled=false`（blocks 布局）                        | 没有 Jev 注册；常驻区和索引照常；只有显式取代                                                                          | `blocks-off-golden.json`                                                                                                                                         |
| `memory.enabled=false`                                           | 零注册                                                                                                                 | jev-off golden 的 `disabled` 配置                                                                                                                                |

**governance-off 差分的比较对象**（r5，裁定 10）：

| 对象                                                                                                                                                                                           | on                     | off 期望                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| 取代：块文件中的 `supersededBy`/`status: superseded` 写入                                                                                                                                      | 有                     | 自动取代无；显式 `supersedes=` 与 on 相同（照常执行）                                 |
| 归档：`blocks/archive/` 中的文件、`archive/index.json`、`status: archived` 写入                                                                                                                | 有                     | 无                                                                                    |
| 治理建议：侧车 `suggestions` 中 kind ∈ {expired-user, until-check, snapshot, pointer, oversize, resident-budget, scope-check, legacy-drift} 的条目，以及 user↔user 首次 review pass 产生的条目 | 有                     | 无                                                                                    |
| 治理通知：`memory: archived …`、`memory: user rule … superseded …`、常驻超额与建议计数的启动提醒行                                                                                             | 有                     | 无                                                                                    |
| 迁移入口：session_start 自动迁移、`/mem migrate*`                                                                                                                                              | 由 `migrate.auto` 决定 | **与 on 完全相同**（迁移不属于治理开关）                                              |
| R 层：常驻变更通知                                                                                                                                                                             | 有                     | **与 on 的同一事件序列相同**，只是不会出现由取代/归档引起的通知（因为这些动作不发生） |
| 工具自身写入的块文件                                                                                                                                                                           | 有                     | 与 on 相同                                                                            |

- **排除项（不比较）**：独立 Jev 打标产生的侧车变化——`entries`（EntryTags，含 `globalP`）、冷却表 `aInjectedAt/pInjectedAt`、非治理 kind 的 review 建议（`duplicate/supersedes/conflict/obsolete/user-like`，由既有 `/mem review` 生成）。它们由 `jev.enabled` 控制，不属于治理副作用。
- 快照比较方式：目录快照（名字 + 字节，不比较 mtime）、侧车按上表字段投影后比较、通知与回显按行比较。

### 7.3 secure 域（D8）

- 不新增 D8 项。Jev 被强制关闭 ⇒ 打标、召回、自动取代、`g1` 建议、R 通知都不运行。
- 常驻区、到期过滤、自动归档、显式取代、迁移照常工作，但**全部经过 `memoryWriteGate`**（§4.7）。
- `tests/secure/settings-override.test.ts` 追加断言：`memory.migrate.auto`、`memory.governance.enabled`、`memory.residentBytes` 都不在强制关闭清单里。
- 真实挂载测试 `tests/secure/memory-gate.test.ts` 见 §4.7。

### 7.4 实施前离线门禁（r4，评审 M16）

三项门禁都在 **P5b 翻转默认值之前**完成并达标（G3 放在 P6a，G1/G2 放在 P5b 开工前的 PG 包）。数据集不入仓库，存放在 `~/.pi/agent/memory-reports/eval36/`，因为其中包含私有记忆正文；评测脚本入仓库。

**G1 取代困难负例集**

- **样本来源**：pi-toolkit 与 claude2api 的真实记忆迁移成块之后（使用 dry-run 的规划结果，不写盘），用词法 `prefilter` 取最相似的块对，由 verifier 人工标注。
- **组成**：
  - **困难负例** ≥ 60 对：相似但不冲突。其中 agent↔agent ≥ 30、user↔user ≥ 15、user→agent ≥ 15。例如同一子系统的互补事实、同一工具的不同坑。
  - **正例** ≥ 20 对：确实被新块完整覆盖或明确废弃全部有效信息（2026-11-07；旧「或相互冲突」定义不再适用，部分冲突是负例）。例如「验收优先 deepseek-flash」对「验收走 v4-pro」、阈值改动前后、已推翻的线路状态。
- **测法**：脚本 `scripts/dev/memory36-gate.mjs g1`（Tier 3，真实调用由 `PI_TOOLKIT_MEMORY36_GATE_LIVE=1` 门控；回答缓存到数据集目录以便复跑）。对每一对用生产 relation 问句与生产阈值判定「是否会自动执行」。
- **门槛**：
  - 负例的误自动取代率 ≤ 1/60，并且 agent↔agent 子集为 0/30；
  - 正例的自动取代召回率 ≥ 50%。未自动取代的正例会落入 conflict 建议，所以召回不要求高。
- **不达标时**（r5，裁定 12）：生产调参必须回到实现包修改，**不得只改评测脚本**：
  1. 派 **P5a-fix**（文件域只限 `src/memory/govern/supersede.ts` 中的阈值常量 `SUPERSEDE_AUTO_P`/`CONFLICT_AUTO_P` 及其单测 `tests/memory/govern/supersede.test.ts`），历史阶梯为 (0.85/0.90) → (0.90/0.93) → (0.95/0.97)；2026-11-07 起仅 supersedes 自动阈值可按阶梯提高，conflict cutoff 不再决定自动执行；
  2. 合入后重跑 PG 的 G1；
  3. 最高一档仍超标 ⇒ 停下报告 root，由用户决定（不擅自关闭矩阵中的任何一格）。
- 评测脚本**只读取**生产常量与生产判定函数：先 `npm run build`，再从 `dist/memory/govern/supersede.js` 导入；脚本源码中不得出现阈值字面量（`gate-script.test.ts` 用正则断言）。

**G2 topic 用户令召回集**

- **样本来源**：主会话 transcript（`~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/`）。抽取 ≥ 30 个用户轮，每轮至少命中一条 pi-toolkit 的 topic 用户令（迁移后 32 条中的任意一条），由 verifier 标注「相关的用户令 id 集合」。分母 = 所有标注的（轮, 用户令）对。
- **测法**：同一脚本的 `g2` 模式离线回放 U+P 两层：
  - **基线 HEAD**：旧文件布局 + 旧选择逻辑；
  - **新管线**：块布局 + 用户令优先 + eligibility + 受众/降权。
  - 判定结果缓存后可复跑。
- **门槛**：新管线的召回率 ≥ 基线召回率（非劣），且新管线绝对召回率 ≥ 60%。
- **不达标时**（r5，裁定 12）：
  1. 先查漏召回条目，把「几乎每轮都需要」的条目列为 `scope-check` 候选，交用户确认是否升为 global（不自动升级）；
  2. 派 **P6b-fix**（文件域只限 `src/memory/govern/decay.ts` 中的召回参数常量 `TOPIC_USER_POOL_CAP` 与 `tests/memory/govern/decay.test.ts`、`tests/memory/jev/wire-recall.test.ts` 中对应断言），把 U 候选裁剪阶段 topic 用户令的入池上限提到 2 倍，合入后重跑 G2；
  3. 仍不达标 ⇒ 报告 root，P5b 不得翻转默认值。
- G2 的回放同样从 `dist/` 导入生产的选择函数与 `TOPIC_USER_POOL_CAP`，脚本内不复制参数。

**G3 预测注入的及时 / 迟到 / 兑现**（P6a 内，确定性单测，假时钟；r5 按 `cache.ts redeemPending` 的代码规则拆分相邻轮）：

| 用例 | 场景                                                                                            | 期望                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | U 在 1500 ms 结束，模型 800 ms 返回                                                             | `timely:true`，本轮合并                                                                                            |
| 2    | U 在 1500 ms 结束，模型 1700 ms 返回（单模型链，预算 3000）                                     | 窗口内未及时；**不被 1500 ms 截断**；结果写入 pendingModel；记 `kind:"call"` 时 `timely:false`                     |
| 3a   | 紧接着的下一轮（`turnSeq` 相邻、TTL 内），prompt 是承接短语（`isCarryPhrase` 为真，如「继续」） | `redeemPending` 返回 `full`：pending 的全部 tag 按**原 p** 兑现，不封顶                                            |
| 3b   | 紧接着的下一轮，prompt 是普通新指令                                                             | 返回 `capped`：只保留「当轮规则也命中，或有 T/W 状态来源支撑」的 tag，p 封顶 `PENDING_CAP_P`（0.6）；其余 tag 丢弃 |
| 3c   | 紧接着的下一轮，prompt 带 cancel 修饰                                                           | 返回 `dropped`，不兑现                                                                                             |
| 4    | 隔一轮再到来                                                                                    | 返回 `none`，不兑现；单槽已清空                                                                                    |
| 5    | 模型 3600 ms 仍不返回                                                                           | 外层期限结算为 timeout 或 zombie，不迟到投递                                                                       |
| 6    | U 被跳过（短 prompt）                                                                           | 窗口 = waitMs（1000 ms），900 ms 返回则及时                                                                        |

- **门槛**：8/8 通过。用例 3a/3b/3c 直接导入 `PENDING_CAP_P` 与 `isCarryPhrase`，不在测试里复制常量。
- 窗口关闭**不会**取消 flight，迟到的结果走 pendingModel，这是原本就有的行为。修复点只在「单档 1500 ms 截断」（评审已核实）。

**现场复评**（P8 之后，属于持续观察，不作为合入门禁）：

- 按 `predict-eval-2026-11-05.md` 的方法执行。指标：主会话及时率 ≥ 50%；模型驱动的 P 注入 > 0；子会话 P 层 irrelevant ≤ 35%；E 层 irrelevant ≤ 30%；topic 用户令漏注入率不高于 G2 新管线结果 + 10pp。
- **未达标处置**：
  - 及时率不达标 ⇒ 记录窗口分布，评估把 `waitS` 调到 1.5（报用户）；
  - 漏注入不达标 ⇒ 把 scope-check 候选交给用户；
  - irrelevant 不达标 ⇒ 补受众或降权规则（另开任务）。
  - 都不改变用户已定事项。

---

## 8. 分包建议（r4）

分包、文件域、测试清单、门禁命令、验收矩阵**以 `plan.md` r3 为准**。r5 的分包变化：P1 增加 safe-fs 三个目录原语（§4.2.1）；P0 补齐 JevWritePort 追加字段与 `resident` details；P1 另含 `blocks/state.ts`；P2 增加代际、owner/清理协议、残留块与对应崩溃/交错测试；P3 改为 snapshot + ledger；PG 不达标时回到 P5a/P6b 调参。r4 相对 r3 的分包变化：

- **P0** 一次补齐契约与 sanitizer（§4.4），新增 `memory.migrate.auto` 键与 `MemoryWriteGate` 类型；harness 只钉四个配置。
- **P2** 改为暂存区迁移、回滚、漂移导入、写闸门（新建 `src/secure/memory-gate.ts`，装配点在 `src/index.ts`，在 `tests/tiers.ts` 中登记一个 secure 文件），不再改 tidy 的 txn/manifest/restore。
- **P3** 增加 §3.3.5 的常驻交付协议（r4 为 `delivered`，r5 改为 snapshot + ledger）+ R 层、§3.3.6 的 eligibility，以及 external renderer。
- 新增 **PG**（离线门禁 G1/G2），排在 P5b 之前；G3 并入 P6a。
- **P5a** 的取代改为单边协议；sweep 增加预算、屏蔽自触发、支持中止。
- **P5b** 的测试白名单由确定性命令生成。

---

## 9. 风险、残留与待确认问题

### 9.1 风险与残留（r4；r5 增补 R15–R18）

| #   | 风险                                                           | 缓解                                                                                       | 残留                                                                 |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| R1  | topic 用户令改为按相关性注入后漏注入                           | 用户令优先；`decisions` 计数；`scope-check` 建议；**G2 离线门禁**（非劣且 ≥60%）；现场复评 | 下限取决于 Jev                                                       |
| R2  | 自动取代误判                                                   | **G1 困难负例门禁**；阈值；每次 ≤2；锁内复核；单边关系；一条命令恢复；总开关               | agent↔agent 只回显；print、子会话、Web 下没有通知                    |
| R3  | global 规则膨胀（不截断）                                      | 软预算 + 建议 + 启动提醒 + D21                                                             | 长期不处理时成本线性增长                                             |
| R4  | 未 reload 的旧会话继续写旧文件                                 | 目录隔离：旧代码写不到 `blocks/`；漂移检测 + 显式导入；P8 先停旧 writer 再迁移             | 漂移内容需要用户显式导入才会生效                                     |
| R5  | 根目录同时存在旧文件与 `blocks/`，人看起来混乱                 | D24 提示「旧布局快照（N 个文件），留作回滚」；文档说明                                     | 旧文件长期留在原处（是否清理由用户另行决定，本任务不提供删除命令）   |
| R6  | 默认值翻转后需要钉住大量测试                                   | P5b 先用确定性命令生成白名单，只允许机械钉住                                               | 改动面大                                                             |
| R7  | `jev/wire.ts` 被多个包修改                                     | 严格串行                                                                                   | —                                                                    |
| R8  | 自动摘要索引丢掉了人工 when                                    | 标签/sections 摘要；Jev 主动注入                                                           | 旧 when 只存在于报告中                                               |
| R9  | 时效降权、快照正则带来的漏注入或噪音                           | 只作用于 agent ∧ 无期限的块；只提示不拦截                                                  | 少量                                                                 |
| R10 | 迁移改坏数据                                                   | 暂存区 + 原子 rename + 旧文件原地不动 + 覆盖审计 + 预算 + P8 dry-run/过目/tar              | —                                                                    |
| R11 | 中间提交里 `layout:"blocks"` 尚无完整实现                      | 默认值在 P5b 翻转；P2 合入后立即设置 `migrate.auto=false`；不 push                         | —                                                                    |
| R12 | secure 域挂载在自动写入期间消失                                | `memoryWriteGate` 逐操作复检；自动路径永不 mkdir；真实挂载测试                             | 只读路径（渲染）在挂载消失后可能读到空目录，从而渲染出空的 Memory 段 |
| R13 | jev off 时没有 R 通知                                          | 依赖 hub 尾部更新                                                                          | POINTED 或 provider 冻结时，常驻区要到下一段才更新                   |
| R14 | 工具表面在 activate 时按 `process.cwd()` 决定                  | 两个方向都有错误码兜底（`E_UNMIGRATED`/`E_BLOCKS_DIR`），提示 `/reload`                    | resume 到另一个 cwd 时需要 reload 一次                               |
| R15 | 文件系统不支持目录 rename（EXDEV/ENOTSUP，例如异常的叠加挂载） | `renameDirNoClobber` fail closed，不降级为复制；记 diag，自动路径本会话不再重试            | 该目录无法迁移，只能保持 tiered；doctor 可见                         |
| R16 | 暂存区的 owner.json 缺失（建目录时崩溃）或 owner 在其它主机    | 不按年龄清理；D25 报告，由用户手工删除                                                     | 极少量磁盘残留                                                       |
| R17 | 混合权威文件的残留块权威被定为 agent                           | 报告逐条列出，P8 过目；残留块不作为自动取代目标、不常驻；`update` 后清除标记               | 用户不处理时，残留内容以 agent 身份参与 Jev 注入                     |
| R18 | 逐操作闸门复检的开销（secure 域）                              | 计入迁移预算；超预算 ⇒ 改用显式 `/mem migrate`（60 s 预算）                                | 大目录在 secure 域可能需要一次手动迁移                               |

### 9.2 需用户确认的问题

**#36 原范围无待确认项。** #50 的六类权限（用户令、删除、跨主题合并、低置信冲突、expires、跨 project/Hub）仍待正式设计时通过 `ask_user` 确认；见 [§4.5.1](#451-50-增量后台修正子项未启动) 与 [plan 权限待确认表](plan.md#权限待确认表)。 r5 的 13 条为 root 裁定，全部是实现层收紧，未改变用户已定事项。r4 新增的 `memory.migrate.auto` 默认值为 true，保持了用户定的惰性迁移，只作为运维暂停开关，不改变任何已定事项；其余改动都是对评审意见的实现层修订。已定项落点：r1 Q1→§3.3、Q2→§7.1、Q3/Q4/Q7/Q10→§4.3、Q5→§5.5、Q6→§5.4、Q8→§4.3.1、Q9→§6.5；r2 N1→§3.2.3/§3.3.3、N2→§5.4。

---

## 附录 A · doctor 新码（只在 blocks 目录）

| 码  | 级别                     | 条件                                                                                                                                                                  |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D20 | warn                     | 块正文 >1024 B（迁移遗留的豁免块）                                                                                                                                    |
| D21 | warn / error（>4× 预算） | 常驻区（user·global）超过 `residentBytes`                                                                                                                             |
| D22 | warn                     | `supersededBy`/`supersedes` 指向不存在的块，或形成环                                                                                                                  |
| D23 | warn                     | 正文残留 `<!-- mem … -->`；frontmatter 值不合法；agent 块写了 `scope`；`blocks/` 中存在游离文件                                                                       |
| D24 | info                     | 设置为 tiered/legacy，但目录已经是 blocks 格式；根目录保留旧布局快照（N 个文件，留作回滚）；旧布局漂移（N 个）                                                        |
| D25 | warn                     | r5：`overBudgetStreak ≥ 3`（自动迁移连续 3 次超预算）；存在缺少 owner.json 的 `.blocks-staging-*`；存在未完成的回滚续做（hold.rollback.done=false 且 `blocks/` 仍在） |

- D17 在 blocks 目录下只统计 user 块（agent 块到期交给治理处理）。
- D01/D02/D09 在 blocks 目录下不报。

## 附录 B · pi-toolkit 迁移预演（按本设计手工推演）

- 17 个文件 ⇒ 17 个主题（`core.md` → `general`），约 179 个块；不生成主题描述（17 个旧 description/read_when 只进报告）。
- 常驻区（global）：core.md 中的 3 条 `mem user`，共 524 B / 2048 B（约 26%）。其中的主会话规则会被写入 `audience: main`。
- core.md 中的 8 条 agent 条目 ⇒ `general` 下的普通块，交给 Jev：
  - 「考古…」是纯指针，照常迁移；
  - 「发版细则见…」是疑似指针，迁移并出建议。
- 其它文件中的 32 条用户令 ⇒ topic 类决策记录。
- 超限：`pitfalls` 中 1 条（1041 B）豁免。
- 侧车：226 条 ⇒ 精确 GC 后 ≤179 条，约 62 条孤儿被清理。
- 迁移后的首次 user↔user review 预计会把以下两条列为 `conflict/supersedes` 建议，交给用户确认：
  - 「验收优先 deepseek-flash」（general，global）；
  - 「验收走 v4-pro」（pitfalls，topic）。

---

## 评审处置表（第 1 轮，GPT-6.1 Sol）

| #   | 严重度  | 处置                                                                                                                                                                                                                                                                                      | 改在哪里                     |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Blocker | 迁移不再复用 tidy txn，改为暂存区构建 + 单次原子 rename；控制文件位于 `blocks/` 子目录与 memDir 根目录（`.blocks-hold`），不经过 txn resolver。safe-fs/manifest/txn 零改动，问题从根上消失                                                                                                | §3.2.1、§3.2.3、§4.3.3       |
| 2   | Blocker | 提交点之前的一切都不可见、可以丢弃（暂存区是纯派生数据），所以不需要整次 run 撤销、durable continuation 或补偿事务；回滚是一次 rename；崩溃点表逐一给出                                                                                                                                   | §4.3.3 崩溃点表、§4.3.5      |
| 3   | Blocker | 读者在任何时刻只看到完整的旧布局（rename 前）或完整的新布局（rename 后）；`dirFormat` 以 `blocks/.layout.json` 判定，标记随目录原子出现；没有待恢复的 run，因此不需要「先恢复再判布局」；补充独立进程在各崩溃点读目录的测试                                                               | §3.2.3、§4.3.3、plan P2      |
| 4   | Blocker | 取消自动增量迁移，改为漂移检测 + 显式导入（逐块原子 create，按 hash 去重），报告只写一次；旧布局快照就是根目录原文件，永不修剪；回滚把整个 `blocks/` 改名保留（不进入限量 trash）；archive 重名追加后缀                                                                                   | §4.3.5、§4.3.6、§4.5         |
| 5   | Blocker | 子目录隔离：旧 v2 工具文件名不允许含 `/`，物理上无法改写块；旧代码的写入只会落到根目录旧文件 → 漂移 → 显式导入。选择这个方案而不是两阶段发布，因为它不依赖「所有旧 writer 已停止」这一前提，且零额外发布步骤。补充旧版真实路径（str_replace/insert/append/create）与 v3 update 并发的测试 | §3.2.1、§4.3.6、plan P2      |
| 6   | Blocker | 源字节覆盖审计：存在未覆盖的非空行或拆出零条目时，整个文件保留为一个块（`whole`，豁免 1 KB）；`heading` 作为独立元数据保存；H1 写进报告；旧文件本身也原地保留                                                                                                                             | §4.3.2 第 3–4 步             |
| 7   | Blocker | 关系只单边记录（只在旧块写 `supersededBy`），一次取代 = 单文件 CAS；锁内复核新旧两块的 rev、active、权限、非自身，新块必须未被取代（同时排除了环）；定义了迟到判定、双会话、链式取代、一对多、恢复规则与测试                                                                              | §5.4                         |
| 8   | Blocker | 新增 `memory.migrate.auto`，P2 合入后（默认值翻转之前）就设为 false 并通过 `/mem migrate --status` 验证；P8 顺序固定为：暂停 → 停旧 writer → tar → dry-run → 过目 → 显式 `/mem migrate` 解除 → 迁移                                                                                       | §4.3.1、§4.6、plan §4 P8、§8 |
| 9   | Blocker | `memoryWriteGate`：所有自动写入口逐操作复检（locked 时零读写；secure 时检查挂载、写区、dev/ino）；自动路径永不 mkdir；`--all` 与备份使用有效 root，备份留在加密边界内；补真实挂载测试                                                                                                     | §4.7、§7.3                   |
| 10  | Major   | 常驻集合以本段实际交付的 `delivered` 为准；之后的变更由 R 层一次性通知下发；跨午夜只变标注；补充生产 hub 接线测试矩阵（stable/live/第 4 次 POINTED × freeze × resume/reload/压缩/跨午夜）                                                                                                 | §3.3.5                       |
| 11  | Major   | `govern/eligibility.ts` 统一判定，在选择时与最终提交时各校验一次；B 层、S 候选、R 层、external renderer 全部接入；补充各层 × 状态变化反例测试                                                                                                                                             | §3.3.6                       |
| 12  | Major   | P0 一次补齐 InlineMeta 新键、`globalP`、新 review kind、带 `kind/until` 的 dismissed、R 层、`writeGate` 类型以及 sanitizer；块布局使用独立侧车，按 hash 多对一，GC 规则重写                                                                                                               | §3.2.5、§4.4                 |
| 13  | Major   | harness 只钉四个依赖默认值的配置，`legacy-layout` 保持 legacy                                                                                                                                                                                                                             | §7.1                         |
| 14  | Major   | 列出 X1–X6 用户已批准的兼容例外；I9 改为「jev-off golden 覆盖的面」逐字节不变，再加 model-off / predict-off / governance-off / migrate.auto-off 四组开关差分测试                                                                                                                          | §7.2                         |
| 15  | Major   | 迁移与 sweep 都写明操作数上限、总墙钟预算、锁等待与执行分离、shutdown 时中止、自触发屏蔽、合并重入、无进展保护；request path 不运行无上界的事务                                                                                                                                           | §4.3.4、§4.5                 |
| 16  | Major   | 新增 G1（≥60 个困难负例 + ≥20 个正例，误取代 ≤1/60 且 agent↔agent 为 0）、G2（≥30 轮，召回非劣且 ≥60%）、G3（6 个确定性用例）三项离线门禁，写明不达标时的处置；现场复评保留为持续观察                                                                                                     | §7.4                         |
| 17  | Minor   | 补齐 tagging.ts 调用链；P5b 测试白名单用确定性命令生成；新 golden 统一为 B 级、生成一次、变更走申报；P3 只录制不依赖 Jev 的渲染契约                                                                                                                                                       | §7.1、plan P3/P4/P5b         |

评审中的「其他已核查结论」已同步采纳：§6.5 与 G3 明确写为「单档 1500 ms 截断」是根因，「窗口关闭不取消 flight」是原有行为；activate-trace 按「逐字节不变（含生命周期副作用）」验证，不再写成只看注册次数。

---

## r5/r3 处置表（root 裁定，第 2 轮复审后）

| #   | 裁定                    | arch r5 落点                                                                                                    | 要点                                                                                                                                 |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 目录操作入口            | §4.2.1、§4.3.3（提交与清理）、§9.1 R15                                                                          | safe-fs 只新增 `renameDirNoClobber`/`removeTreeNoFollow`/`fsyncDir`（P1）；fs-guard 不放宽；EXDEV/不支持 ⇒ fail closed，不复制       |
| 2   | 回滚与代际              | §3.2.1（`.blocks-state.json`）、§3.2.3（hold 优先）、§4.2 `state.ts`、§4.3.3 第 3 步、§4.3.5、§4.3.8            | gen → hold(fsync) → rename；提交五项复核；续做；双进程交错；无锁读者单次解析布局、不混读                                             |
| 3   | 暂存区清理              | §3.2.1（owner.json、`.trash-<runId>`）、§4.3.3「清理协议」                                                      | 锁内建目录并写 owner；只清本进程或确认已死的 owner；先隔离再删；提交前核对 runId 与完整清单；受闸门、no-follow、同 dev、op 上限约束  |
| 4   | 混合权威                | §4.3.2 第 4 步、§4.2 `BlockMeta.residue/origin`、§5.4 条件 6、§9.1 R17                                          | 只有权威一致才 whole；混合文件拆分 + 残留块（agent、residue、origin），报告逐条列出；残留块不作自动取代目标                          |
| 5   | 回滚承诺与 archive 命名 | §4.3.5 第 2 步、§4.5「归档」、§3.2.1 命名、§4.2 `ARCHIVE_NAME_RE`                                               | 回滚 = 根目录当前旧布局；迁移前原始字节 = P8 tar；冲突名 `<id>.r<n>.md`；`archive/index.json` 先写                                   |
| 6   | heading 契约            | §3.2.2 表格、§4.2 `BlockMeta.heading` 与 heading 全链路、§4.4 `MemEntry.block`                                  | frontmatter `heading`；adapter 输出 `MemEntry.heading`；`block` 内不再重复                                                           |
| 7   | secure 构建与清理       | §4.7「暂存区与清理的闸门方式」「新目录的 capture」、§4.3.3 第 2 步、§5.6 D12                                    | 选逐操作复检（Node 无 dirfd API，fd 方案不可行）；构建期 mount-loss 测试；显式建目录后立即 capture                                   |
| 8   | 已交付账本              | §3.3.5（重写）、§3.3.3 渲染行 `[id]`、§3.3.4 `isStaticCore`、§3.3.6 `ledger`、§4.4 `resident` details、§5.6 D16 | snapshot 解析自 hub 持久文本；ledger 随 R details 恢复；差分含到期标注变化；corpus 指纹 + 日期 + snapshotKey 重算；异步 rev 变则丢弃 |
| 9   | JevWritePort            | §4.4 JevWritePort 代码块与 P4 调用链、§4.2 marker/corpus 声明                                                   | 沿用 `afterWrite`；追加 `block`/`askScope`/`relations`；`buildTagQuestions` 第 4 参 `includeScope`；字段声明统一                     |
| 10  | 派单正文统一            | §7.2（governance-off 行与比较对象表）                                                                           | 比较对象：取代、归档、治理建议、治理通知、迁移入口、R 层；排除 Jev 打标侧车变化                                                      |
| 11  | 迁移全阶段预算          | §4.3.4（重写）、附录 A D25                                                                                      | 单一 deadline + 操作数上限；锁外每 32 op `setImmediate` 让出；超预算丢弃并计数，连续 3 次 D25                                        |
| 12  | 离线门禁调参归属        | §7.4 G1/G2「不达标时」、G3 表                                                                                   | G1 改 P5a 阈值常量、G2 改 P6b 召回参数后重跑 PG；脚本只读生产常量；G3 拆 3a/3b/3c                                                    |
| 13  | 门禁口径与旧验收        | 本文无对应正文（属 plan）；§4.3.3 末段改为「safe-fs 只新增三个目录原语」                                        | 落点在 plan r3 P2/P5a/§7                                                                                                             |
