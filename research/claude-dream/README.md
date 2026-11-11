# Claude Dream 调研与本仓落地提案

> **设计提案，未实施，等用户再次授权。** 本目录仅交付研究与方案；没有新增工具、slash 命令、schedule、设置或真实记忆变更。

- 整理日期：2026-11-11（Asia/Shanghai）；同日完成独立文档评审后三点合同修订。
- 当前事实基线：`cebf26f240467fc7e35a298fc88922119962900e`（下文简写 `cebf26f2`）。源码路径均相对仓库根目录；行号仅对该 commit 有效，后续推进须重核符号与约束。并发 writer 的工作树修改不并入本研究事实，修订定向用 `git show cebf26f2:<path>` 核验。
- 创建前仓库没有 `research/`，故采用独立主题目录 `research/claude-dream/`，不覆盖历史材料。
- 当前发版目标为 **0.12.0**；本目录不表示 Dream 已实现、已启用或纳入该版本功能承诺。

## 1. 阅读入口

| 文档                                   | 内容                                                        | 面向下一步                            |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| [外部机制与证据](external-research.md) | 产品区分、官方接口/示例、历史灰度、第三方与未知             | 防止把“每晚自动清理”当现成产品合同    |
| [本仓现状与缺口](current-state.md)     | 基线源码事实、精确坐标、已有接线与现场未认证的区别          | 后续设计/开发定向复核，不重复全盘探索 |
| [实施方案](implementation-plan.md)     | 目标、不做、模块/契约、证据窗口、审核/应用/恢复、分包及验收 | 用户再次授权后方可逐包实施            |

输入报告已完整读取后精炼归档：`claude-dream-mechanism-research-20261111.md` 与 `pi-memory-dream-fit-20261111.md`。归档保留关键引用、日期、来源等级和未知，不复制原始会话数据、用户会话标识、生产配置或无必要的本机私有路径。上游报告中的历史测试自报不是本轮重跑证据。

## 2. 一页结论

1. **没有证据支持“Claude 默认每天晚上自动清理记忆”。** Managed Agents Dreams 是显式异步 API（research preview）；官方 nightly cookbook 是用户自建 cron；Claude Code auto-dream 是历史灰度，当前可用性未知。普通 Chat/Cowork memory 另算。
2. 借鉴的是“离线证据 → 可审阅候选 → 精确批准 → 有界 CAS 应用与恢复”，不是复制不公开算法，也不是让后台模型取得真实记忆写权。
3. 最小首期是**独立、离线、只读 Dream shadow 报告**：本地规划可读本页已获批 raw（private/secret 预排除、≤512KiB），保留原 BlockCorpus/planSweep；模型另授权且只收提名最小 DTO。只读是不改真实 memory，不是禁止写批准的 shadow 报告/review/cursor。
4. 复用 #36 日期/建议规则与 #50 P50 的唯一 client、费用 ledger、D 私有 custody、C raw 审计、E 提交和现有 Web review；**不新建第二套真实写入/计费/确认系统**。首期不接真实宿主、不调用这些写入口。
5. 用户令 `scope/authority/audience` 自动不动；`until` 只建议；只有可核实的 **explicit correction** 才可提议“新覆盖旧”，否则保留 conflict。S1/S2 的 correction 一律 unverified；未来 source 三元组的前置 evidence-review 留待独立合同/授权，普通候选后置 review 不自证核实。用户令正文改动必须逐项由用户决定。
6. stock provider 未认证、`auto=false`、`jobCostCapUsd=0`、G1 正例 `10<20` 的 BLOCKED、P8 现场授权均保留，不为 Dream 降门槛。源码闭环不证明现场已加载或具备运行能力。

## 3. 独立评审与三点修订

Kimi 独立评审 `r_SKWEYJGV` 条件通过；依 root 给出的三点清单定向修订 [实施方案](implementation-plan.md)，未重新扩展计划：

1. **review 合同闭合（§4.1、§4.3–4.4、§7.1、S1/S2）**：runner 显式输入含 ReviewRecord[] 的快照，planner消费数组；shadow review 有界读取/CAS追加、明确reopen仅解除具体candidate/rejection记录。S1/S2只产unverified，不用依赖candidateId/reportDigest的后置review构造前置证据；未来evidence-review另授权。
2. **sealed后补ack（§4.1–4.2、§5.3、S2）**：publish只封存，增加 `acknowledgeCursor(windowKey,reportDigest,expectedCursorDigest)`；复核sealed后只cursor CAS，重调幂等，不重跑模型、不重写产物，补失败矩阵和调用计数断言。
3. **本地raw/外发边界（§1.2、§3、§4、§5.2、§6.1、S1/S3、验收矩阵）**：本地确定性规划可读本页批准raw，不新增metadata-only架构；private/secret预排除、512KiB上限，模型只收提名DTO；readonly不排斥shadow artifact写。

本次仅写本页和实施方案；现状与外部调研正文无需改动。root后续核对三点闭合并按授权精确commit，本作者不commit；这不是新一轮实现许可。

## 4. 本轮边界与自验记录

- 只新增/修订本主题 Markdown；未改 `src/`、`tests/`、全局 README、AGENTS、配置或真实 memory，也未触碰另一 writer 的修改。
- 没有启动/reload pi、采集真实样本、外发模型数据、创建定时任务、安装依赖、执行全量门、提交或推送。
- 原始交付检查及本次修订复验均限定四个明确文件的本地 Prettier、`git diff --check`，以及对未跟踪新文件逐一 `git diff --no-index --check`；该命令可因新增内容返回1，核无空白诊断后接受。
- 本次 Markdown只读复验：**23个仓内链接**全部存在（初稿22个，修订增加一处同文档引用），表格列数一致，无无必要本机路径；36个外部引用保留上游结果，未在本轮重新联网验证。当前无仓内片段锚点链接。
- 修订开始HEAD仍为`cebf26f2`；工作树另有memory writer的未提交变更，保持原样，不用全树diff作为本包归属证明。未运行build/typecheck/test实现门，上游测试自报不算本轮执行。
- 待拍板项留在实施方案末尾，**不是现在请求实现许可**。用户开发/现场授权、真实样本、provider验收和任何Dream实现均未执行。
