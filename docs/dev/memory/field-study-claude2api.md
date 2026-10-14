# Memory 插件实地研究：一个 83 文件生产记忆库的诊断（2026-10-14）

对一个真实生产记忆库（83 个 v2 可见文件、267K 活跃区 + 50 文件 archive + 手工 `MEMORY.md`
索引，2026-07 由 `/mem import` 从 Claude Code 导入后独立维护）跑了一次只读全量诊断：直接调用
`src/memory/doctor.ts` 的 `runDoctor`（快照构建复刻 `doctor-command.ts`）+ `renderTiered`
（默认 coreBytes=1600 / blockBytes=2400 / indexMax=15 / access=memory+read），另做结构与内容审计。
本文只保留统计与抽象问题；另一份含项目细节的治理提案在用户的 memory-reports 目录。

## 实测基线数据

- doctor：**114 findings = 0 error · 44 warn · 70 info**。构成：D06×83（缺 description 40 warn +
  缺 read_when 43 info）、D07×27（description 超 160B）、D04×4（4 个文件 8–16K 超 topicWarnBytes）。
  其余规则（D01/D02/D03/D05/D08/D09/D11/D13/D14）全部沉默。
- 渲染：**level=L1、注入 2,396/2,400B**。无 core.md、无 pin ⇒ primary core 不存在，**0 字节常驻内容**；
  83 个文件里 15 个得到带描述的索引行（其中 10 行是 `(no description)`），19 个只剩裸名字进
  `also:` 尾行，**49 个连名字都不出现**（`+49 more`）。
- frontmatter 覆盖率（82 个非索引文件）：头部可解析 68%，description 52%，**read_when 0%**，
  updated 24%，pin 0%，status≠active 0%，显式 topic 0%。
- 结构漂移：手工索引 60 条链接 vs **23 个孤儿文件**；索引的「归档」节误列 2 个活跃文件；
  8 个活跃文件正文含「已修复/已完成」等完结标记；最老 mtime 95 天，D08 一条没报。
- archive 区很健康（50/50 有索引、0 孤儿），`.backup` 3 代 17K 正常。

## 问题清单（现象 → 根因 → 建议 → 车道/优先级）

### F1. `/mem import` 的横幅放在 frontmatter 之前，使解析整体失效 —— P0 / L1

现象：32%（26/82）的文件以 `> **pi copy** …` 横幅开头、frontmatter 紧随其后。这些文件的
description 对插件不可见 ⇒ 贡献了约半数 D06 warn 和 10 行 `(no description)` 索引行（索引退化为
H1 兜底，无 H1 的文件直接显示 "(no description)"）。

根因：`src/memory/store.ts` `importProject` 写 `DRIFT_HEADER + body`；而
`src/memory/frontmatter.ts` 的 `parseFrontmatter` 用 `^---\r?\n` 锚定文件头。渲染侧有
`stripDriftHeader`（render.ts）但 meta 解析侧（`parseMemoryMeta`、`MetaCache.read`）没有先剥横幅。

建议：① `parseMemoryMeta` 与 `MetaCache.read` 在解析前先 `stripDriftHeader`（单向兼容，立即修复
存量库）；② `importProject` 改为把横幅写到 frontmatter **之后**（或改用 HTML 注释）；
③ tidy 增加一个机械 fixup op「横幅归位」迁移存量。三件套一次做完。

### F2. 最差的渲染状态（无 primary core）反而零告警 —— P0 / L1

现象：库里既没有 core.md 也没有任何 pin，常驻内容注入为 0，但 doctor 对此完全沉默：
D01 只在「无 core.md **且**有 pin 替身」时触发（`doctor.ts`）；D02/D09 整体被
`if (snapshot.render && primary !== undefined)` 门掉。同时手工维护的 `MEMORY.md`（9.3K 分组索引）
被当普通 topic 处理：自己吃一行索引 + 一条 D04 warn，其内容永不注入——用户以为「注入的是我的索引」，
实际注入的是插件自动生成的残缺的索引。

建议：① 新增（或改造 D01 为）「no primary core」finding：无 core.md 且无 pin 时给出
「创建 core.md / 对某文件加 pin: true」的具体指引；② 检测到 `MEMORY.md`/`memory.md` 且其内容形如
链接清单时，提示它不会被当索引注入，建议迁移为 core.md 或删除；③ D02/D09 的门改成按
「render 存在」而非「primary 存在」，level≥1 本来就该报。

### F3. D06/D07 粒度过细 + description 长度口径 ASCII 中心且自相矛盾 —— P1 / L1

现象：114 条 finding 里 110 条是 D06/D07 的逐文件罗列——信噪比极低，`/mem doctor` 直接溢出到
编辑器（>20 条的既有行为），用户看到的是一堵墙。其中 D07×27 全部是 `description exceeds 160B`：
160B ≈ 53 个 CJK 字符，中文一句话很容易超；而且渲染层 `DESCRIPTION_MAX_BYTES=110`
（tiered.ts）反正会截断到 110B——151B 的 description 过了 doctor 却照样被截成 "…"，两个口径互相矛盾。

建议：① doctor 报告默认按规则聚合（每规则计数 + 前 3 个样例），`--full` 才逐文件；
② D06 缺 read_when（info）考虑降级为聚合计数甚至默认关闭——实测 0% 采用率说明它是
「推荐实践」而非「健康指标」；③ 统一 description 上限：meta 校验与渲染截断用同一常量
（建议 110–120B），文档注明这是字节数、CJK 约 40 字。

### F4. 默认预算下索引容量与库规模失配，且无任何提示 —— P1 / L1

现象：blockBytes=2400 / indexMax=15 默认下，83 文件的库只有 15 行完整索引，59% 的文件
（49/83）在注入里连名字都没有。用户没有任何途径发现「一半记忆不可见」。compact 尾行按码点序
贪心，与文件重要性/新近度无关。

建议：① doctor 新增「index coverage」finding：完整索引行占比 <50% 时提示调大
blockBytes/indexMax（给出具体设置值）；② 文档（memory-plan 或 README 段）给「库规模 → 建议预算」
对照表；③（可选，L2）compact 尾行按 mtime 倒序取名，让最近动的文件优先留名。

### F5. 陈旧检测依赖的字段在真实库中覆盖率过低 —— P2 / L1

现象：D08 只看 frontmatter `updated` 与 `status: stale`；实测覆盖率 24% / 0%，于是一批
mtime 95 天、正文写着「已修复/已完成」的文件完全躲过检测。治理提案里 14 个归档候选全靠人工
正文审计发现。

建议：① D08 在 `updated` 缺失时回退到文件 mtime（快照已能拿到，doctor-command 补传即可）；
② 阈值用 `staleDays` 同一设置；③（可选）正文完结标记（已修复/已完成/fixed 等）命中且 mtime
超阈值时升级为 warn。注意保持纯函数边界：mtime 走 `DoctorSnapshotFile` 新增可选字段，additive-only。

### F6. tidy 能力缺口：merge、横幅迁移、core 引导 —— P2 / L2

现象：本次治理 6 类动作里，归档+frontmatter 改写能直接用 `/mem tidy --batch`（且其
index-edit 会正确剪枝 MEMORY.md 链接、维护 ARCHIVE.md，txn/CAS 语义完好），但三类不行：
合并文件（无 merge 原语，只能「改写产出 + 归档源」两步绕）、横幅归位（F1③）、core.md 引导
（「从现有库提炼常驻规则」是最该被辅助的动作，却是纯手工）。

建议：① tidy 增加机械 fixup op 类型（非模型批次）：横幅归位、frontmatter 字段补默认值；
② `--batch` 的 prompt 模板加入「合并建议」提案类型（产出 = 一个 CREATE + 若干归档）；
③ `/mem tidy` 在无 core.md 时主动提案「生成 core.md 草稿」。

### F7. 启动提醒与报告呈现 —— P2 / L0–L1

现象：启动提醒只数 error（本次修复后已归零，行为合理）；但修复前「9 error findings」+
编辑器「↑ 341 more」的实际体验是：9 条全是同一规则的误报，341 条里 83% 是同一规则的信息缺失。
按文件平铺的排序（`sortFindings` 同 id 按文件名）让同类问题散成几十行。

建议：① 启动提醒文案带上按规则的分解（如 `9 error (all D13) · 44 warn (D06×40 …)`），一行说清
「是不是同类问题」；② 报告默认聚合视图（同 F3①）；③ 编辑器标题带上 error/warn 计数便于扫读。

## 推荐落地顺序（前 3 项可直接派开发）

1. **F1（L1）**：`parseMemoryMeta`/`MetaCache.read` 解析前先 `stripDriftHeader`；`importProject`
   横幅改写到 frontmatter 之后；补回归测试（banner-first 文件的 description 必须可见）。
   验收：样本库 `(no description)` 索引行从 10 行归零、D06 warn 减半——无需用户迁移。
2. **F2+F3①（L1）**：doctor 增加 no-primary finding 与 MEMORY.md 角色提示；D02/D09 改按 render
   存在触发；报告改聚合视图。验收：样本库 doctor 输出从 114 行降到 <20 行且第一条就是
   「no core.md」指引。
3. **F4①+F3③（L1）**：description 上限统一为一个常量；新增 index-coverage finding（阈值 50%，
   附建议设置值）。验收：样本库触发 coverage finding 并打印 `memory.blockBytes=4096` 建议。

F5/F6/F7 随后；F6 的 merge/fixup op 是 L2，建议单独开 plan。
