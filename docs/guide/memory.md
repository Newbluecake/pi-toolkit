# 项目记忆（memory）

项目记忆以 cwd 为键，默认保存在 `~/.pi/agent/memory/<cwd-slug>/`（`ARMORY_MEMORY_ROOT` 可覆盖根目录）。`memory.enabled` 默认 `true`；worktree 会解析到**主仓库**的记忆目录，实际路径用 `/mem path` 查看。记忆是项目数据，不是替代当前用户指令的系统命令；不要存密钥等秘密。

本文先说明**当前默认 blocks 布局 / `memory` 工具 v3**；显式配置 tiered/legacy 且仍为 files 目录的旧行为放在文末。session/Hub 记忆由另一个 `scoped_memory` 工具管理，不等同于项目里的 `scope: global`。

## 默认布局：blocks

每条事实一个块，文件位于项目记忆目录的 `blocks/` 下，例如 `quota.007.md`。文件名就是块 ID，前缀是 topic；正文上限 **1024 UTF-8 字节**，元数据和版本在 frontmatter。历史超限内容可读，不会为了符合新上限自动改写原文件。

### 哪些内容会注入

- **常驻用户令**：active 的 `authority: user` 且 `scope: global` 块，经受众过滤后每轮常驻。`memory.residentBytes` 默认 2048 B，是软预算；超额提示合并或降级，**不截断、不擅自降级**。这里的 global 只限当前项目，不是跨项目共享。
- **主题决策与经验**：新用户令默认 `scope: topic`，与 agent 块一样按相关性召回；Topics 索引每主题一行，可按需打开。只有用户明确要求本项目每次遵守/每轮常驻，或确认 scope 建议后，才改为 global。
- **受众**：main 只向主会话注入，child 只向子会话注入；显式 audience 优先，否则 Jev 的规则标签可推导 main，其余为 all。常驻区按显式元数据过滤，Jev 候选还使用标签推导。`view` / `search` 不受受众过滤影响，所以这不是保密边界。
- **过期与取代**：已取代/归档/删除的块不参与正常注入；过期 agent 块退出召回并可被治理归档。过期用户令仍保留并标注，不能把到期当成模型自行删除的授权；`until` 是待核对条件，不代表事件已发生。
- **子会话**：`memory.injectInChildSessions` 默认 `true`，`childProfile` 默认 core。项目写入默认不开放；默认开启的 scopes 还会强制 child 的 project/Hub 内容只读，即使旧 `allowWriteInChildSessions=true` 也不能绕过。

注入经 system prompt 稳定化 hub 处理，写后变化通过尾部更新及常驻变更通知衔接，不代表每次写入都立即重建开头快照；详见 [上下文与缓存](context.md)。`memory.freezeInjectionAfterWrite` 默认 `false`。

### 旧目录如何进入 blocks

`memory.layout` 默认 `blocks`，`memory.migrate.auto` 默认 `true`。主会话启动时，在安全门允许的情况下可能惰性迁移当前项目旧文件，**不限于 TUI**；旧根 Markdown 保留，迁移后修改块不会自动写回旧文件。

升级前需要受控迁移时，**先在启动目标会话前关闭 auto、停止旧 writer 并备份**，不要为查看状态而提前触发自动迁移。完整步骤、预算、试点和回退见 [迁移 runbook](../dev/memory/migration-runbook.md)。

配置为 blocks、磁盘仍是 files 时，注入暂按 tiered 回退；已有合法 blocks 目录则优先于 tiered/legacy 的渲染配置。工具表面在 activation 时选择，配置/迁移发生变化后可能需要 `/reload`，以实际工具描述为准；不要仅凭配置值推断磁盘状态。

## 默认 `memory` 工具：v3

v3 提供以下五种操作，具体参数以工具描述为准：

| 操作     | 用途                                                              |
| -------- | ----------------------------------------------------------------- |
| `view`   | 无路径看主题表；指定 topic 看该主题块；指定块看正文、元数据和 rev |
| `search` | 搜索 active 块                                                    |
| `create` | 在 topic 下创建一条新事实                                         |
| `update` | 用 `view` 得到的最新 rev，整块替换正文                            |
| `delete` | 软删除块，建议同时带 rev 以防并发覆盖                             |

先查后写：同一事实过时优先 `update`，不是再建一块；更新冲突时重读、合并后再提交。v3 **没有** `str_replace` / `insert` / `rename` / `append`，也不会暗中翻译旧操作。`memory.toolSurface: v2` 是 files 表面的设置默认值，不表示默认 blocks 使用 v2。

### 权威、期限与写后建议

写入语法见工具描述；常用元数据表达如下意图：

| 元数据       | 使用原则                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------- |
| user / agent | user 忠实记录用户原话/决定；模型经验保持 agent，不得伪装为用户决定                       |
| scope        | 用户令默认 topic；global 表示本项目每轮常驻，升级/降级须有用户明确决定                   |
| expires      | 日期型失效；临时事实应有真实期限                                                         |
| until        | 事件型失效；由人核对条件是否满足                                                         |
| audience     | 仅在职责确实只适用主/子会话时收窄，不能为省 token 滥填                                   |
| supersedes   | 新事实完整覆盖或明确废弃旧块全部有效信息时的显式取代意图，不是相关性标记；以执行回显为准 |
| tags         | 经核实的手工标签可补充/覆盖分类结果                                                      |
| private      | 不向 Jev 外发；不是存储秘密的理由                                                        |

**项目用户令没有写前确认框**：agent 改写、删除、降权或把 global 降为 topic 可直接写入。工具的直写能力不等于策略授权：没有用户明确决定就应先提议。写入后 `voided user rule:` 必须向用户转述；主会话 TUI 的 warning 不能代替转述，Web/headless/print 也不能依赖该通知。`scoped_memory` 的 session/Hub 权限另有确认机制，不能套用项目直写规则。

其他重要回显：

- `scope:` 只是建议，当前块仍为 topic；询问用户是否常驻，不能自动升级。`resident: ... over budget` 也不能成为自动降级的依据。
- `state snapshot:` 表示刚写的无期限 agent 块像运行状态；应补真实 expires/until，或改为持久结论。写入已经成功，并不会被系统自动修好。
- `superseded: <旧 id> by <新 id>` 表示已执行取代，旧块不再注入；逐项告诉用户结果。若 `note:` 提示旧块原为 global、新块仍为 topic，说明常驻变化并询问，不能继承 scope。
- `not superseded:` 表示旧块是用户令，agent 新块不能取代它；说明冲突并等待用户决定，不得改权威来绕过。
- `skipped:` / `conflict:` 只是未执行原因或建议，不是取代成功。`jev: not tagged (partial: …)` / `(off: …)` 则表示内容已写入，但没有成功打标，不能依赖快速通道。

具体写入策略见 [memory-jev skill](../../skills/memory-jev/SKILL.md)。

## 治理：自动动作与只读建议分开

`memory.governance.enabled` 默认 `true`，复用 startup、写后及可信 task-done/push/release、预算等自然机会执行有界 sweep，不新增定时器或主动唤醒。后台 bash job 终态关联尚未接生产，复杂 shell 不推断成功。

自动取代只允许**完整取代**：user→user、user→agent、agent→agent 可按高置信规则执行（每次写入最多 2 条）；agent→user 永禁。部分冲突即使高置信也只建议。新块不继承旧块 global；误取代可单块恢复。Jev off 时只有显式 supersedes 路径，显式路径仍不能绕过权威/CAS 校验。

到期 agent 块可自动归档，用户令不自动归档；until、状态快照、常驻超额等产生核对建议。迁移后的首次 user↔user review 只给建议，不自动取代历史用户令。自动取代仍有误判风险，离线 G1 数据不足的风险已被接受，不能宣称有误判率数据背书。

## `/mem`：默认 blocks 的常用命令

以下在 pi 的输入框执行，**不是 shell 命令**：

```text
/mem                              概览（含诊断/可用的 Jev 摘要）
/mem list                         项目记忆列表
/mem path                         实际项目记忆目录
/mem doctor                       按布局做健康检查和元数据诊断
/mem review [--list|--run]         只读展示建议，--run 也不启动整理
/mem expired                      只读展示到期日期与待核对条件
/mem restore --block <id or stored name>
/mem migrate --status              配置、磁盘格式与迁移状态
/mem migrate --dry-run             只读规划旧源，不发布 blocks
/mem migrate --report              查看已发布迁移报告
```

- **review**：合并现有 Jev 侧车建议（包括非治理类型）与即时治理建议，核对锚点并去重。不是只看 review-lite 治理子集；查看不会运行 sweep/分类器，不会交互式改写。
- **expired**：展示 active 块的已过期 expires 和所有 until，区分 user/agent；同一块可占两行。已取代/归档的块不参与；命令本身不延期、不删除。
- **restore --block**：恢复已取代或归档的单块。恢复不会递归恢复它曾取代的其他块，删除取代者也不会自动撤销其关系。
- **删除恢复另走 trash**：已删除块在 `blocks/.trash/`，`/mem restore --trash` 自 `e0993f03` 起按实际布局分派（blocks 读 `blocks/.trash`、files 读根 `.trash`，互不混合）。不要把两种布局的 trash 或 `--block` 混用。
- **tidy 在 blocks 禁用**：不能用旧 `/mem tidy`（含 batch）整理 blocks；改用 review 建议与治理。
- **doctor**：不再仅 D01–D14；包含 blocks 漂移、悬空取代、迁移/回退等诊断。启动提示受 `memory.doctor.notifyOnStart` 控制；历史软元数据超限在 doctor 按需展示，不在启动刷警告。

显式 `/mem migrate`、`--all`、导入旧漂移及回退等写迁移要求真实 TUI 主会话和安全门通过。回退用 `/mem migrate --rollback` 后 `/reload`，会保留 blocks 快照并设置 hold；迁移后的新内容须人工核对，不会自动合回旧文件。`--all` 不是默认试点步骤；请按 runbook 操作。

**Web 端不能与 TUI 等同**：Web 的独立只读端口只支持明确列出的命令子集，不能因为 native review/expired 已是只读就推断 Web 也能执行；不支持会拒绝。session add 有单独的可选确认写端口，不代表项目写入或其他 scoped 写入已放开。支持面与限界见 [开发者 README](../dev/memory/README.md)。

## Jev（自动分类与召回）

`memory.jev.enabled` 默认 `true`，有可用分类器/宿主能力时启用。它做分类、打分与建议，**不生成项目记忆正文**；scope 建议不能代替用户决定。主要通路包括用户输入相关性召回、写入打标/关系判断、周期 review 建议、tool_call 快通道、压缩重注和预测预注入。

**高危动作拦截已于 2026-11 移除**，Jev 不会因为记忆规则拦下 shell/工具动作；历史 gate/gate=hold/nogate 标记只解析兼容，新内容不要再写。快通道按风险标签与冷却准入，不是遇到任何相同关键词都注入。

| 状态          | 含义                                                        |
| ------------- | ----------------------------------------------------------- |
| full          | 可现场调用分类器                                            |
| partial(原因) | 现场判定暂不可用，已有标签的快通道/压缩重注等降级路径仍可用 |
| inactive      | 未配置可用分类器凭证                                        |
| off           | 开关关闭、legacy 配置、secure 域、分类器空或非法等关闭条件  |
| off (pi-api)  | 设置开启但宿主缺分类器 API；不会因此伪造调用或结果          |

关闭 Jev 不会抹掉 blocks 常驻区、主题索引或显式取代能力；不能把“Jev 关闭”理解成整个记忆停用。secure 域强制关闭 Jev，不能通过其他设置重新开启。专用 `memory.jev.proxy` 只支持 `http://`，诊断会遮蔽凭证。

可用时的维护命令：

```text
/mem jev [probe|retag [--all]|reset-index]
/mem tags [list|add …|rm …|disable …|enable …]
```

它们不等同于 review：probe/retag 等可能调用分类器或修改派生索引，不能当作零副作用读命令；命令可用性取决于实际 Jev 接线和通道。

## 常用设置

默认值以 `src/memory/settings.ts` 为准；设置非 live 时修改后需 `/reload`。下表是常用子集，不是完整设置清单。

| 键                               | 默认                                     | 用途                                              |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| memory.layout                    | blocks                                   | 默认块布局；tiered/legacy 为显式旧布局选择        |
| memory.migrate.auto              | true                                     | 启动时惰性迁移当前旧项目，受主会话/安全门限制     |
| memory.residentBytes             | 2048                                     | 常驻用户令软预算，不截断                          |
| memory.governance.enabled        | true                                     | 自动治理开关                                      |
| memory.childProfile              | core                                     | 子会话注入档位 core/full/none                     |
| memory.doctor.notifyOnStart      | true                                     | 启动诊断提示                                      |
| memory.jev.enabled               | true                                     | Jev 总开关，仍受配置与安全域限制                  |
| memory.jev.classifiers           | opencode/jev-1.13-free,opencode/jev-1.13 | 分类器有序列表                                    |
| memory.jev.childSessions         | true                                     | 子会话是否接线 Jev                                |
| memory.jev.recall.threshold      | 0.6                                      | 相关性阈值                                        |
| memory.jev.recall.maxEntries     | 3                                        | 单次召回条目上限                                  |
| memory.jev.recall.maxBytes       | 4096                                     | 单次召回字节预算                                  |
| memory.jev.recall.waitMs         | 2000                                     | 同步等待上限，单位毫秒（不是旧文中的 waitS）      |
| memory.jev.review.intervalDays   | 7                                        | review 周期，0 表示只手动触发                     |
| memory.jev.maxCostUsd / maxCalls | 0.5 / 800                                | 单 activation 分类调用预算                        |
| memory.jev.fastPathCooldownH     | 24                                       | 快通道跨会话冷却                                  |
| memory.jev.predict.enabled       | true                                     | 预测预注入；独立模型子项另有预算                  |
| memory.scopes.session / hub      | true / true                              | session/Hub 产品默认开启；不改变项目 scope 的含义 |

scopes 在 plain 域且宿主能力满足时装配；secure/locked 不创建 scoped shell/工具/section/store。Hub 写入须按 `scoped_memory` 的真人确认规则执行，不能把项目用户令的“无确认框”当作跨层授权。

## 补充：显式配置 tiered/legacy 时的 files 布局

以下只适用于**磁盘仍为 files** 的旧项目；若已有 blocks，注入优先使用 blocks，不能仅改设置就认为回退完成。需要回退时使用 runbook 的正式流程。

### 注入与文件工具

- tiered：整文件/整段落准入，受 UTF-8 字节预算约束；放不下只留索引。topic 文件索引带 description/read_when；core.md 与 pin 文件参与核心区选择。`pin: true` 是旧文件布局的常驻约定，不是 blocks 的 global。
- legacy：保留旧的索引与最新文件内联方式（indexMax=15、inlineMax=3、byteCap=4000），作为显式兼容退出选项。
- files 的 `memory.toolSurface` 默认 v2：view/search/create/str_replace/insert/delete/rename，并保留 list/write/append 兼容入口。不要把这组操作用于 v3。
- 文件工具有目录围栏、文件名白名单、权限 0600、单文件 maxFileBytes=262144 与单次写 maxWriteBytes=65536 上限。所有 v2 写入、导入、tidy、restore 在目录锁内串行；用户信任的 slug 目录 symlink 可用，文件级 symlink/非常规文件拒绝。

files 条目可带行内 user/lesson、expires、until、tags、private 等标记；手写文件未标 source: agent 时条目默认 user，agent 创建文件默认 agent。改写/删除用户令、翻转 provenance 或归档用户文件都没有旧的确认框，仍须用户决定并转述 voided 回显。gate 标记不再有拦截行为。

### 旧命令与恢复

```text
/mem init                           初始化旧文件核心骨架
/mem import [--force] [slug|all]     从 Claude Code 复制旧文件，原件不动
/mem tidy [--batch] [--dry-run] [--status] [--frontmatter] [--break-lock]
/mem restore [--legacy]             查看/还原 tidy 备份
/mem restore --trash                查看/还原根 .trash 的删除快照
```

这些是 files 工作流，不是 blocks 的整理/创建入口；导入旧文件不等于更新已迁移的块，blocks 的旧文件漂移应核对后走 `migrate --import-legacy`。

tidy 是带日志的事务：先记录计划，再逐项 CAS 写入；中断可恢复。batch 按成本/次数上限归档和重写，dry-run/status 只读；无法确认已死的锁不会按锁龄强拆，break-lock 仅真实 TUI 可用。不支持硬链接的文件系统拒绝事务式 tidy。

files 的 review/expired 当前也只读展示，不能继续依赖旧版交互延期/删除语义。根 `.trash/` 的删除快照仅保留最近 20 份；超过保留数的快照不可恢复，编辑也没有自动备份。未 pin 的 core.md 改名可能退出旧核心常驻区；这是 files 的特定风险，不是 blocks 中重命名 topic 的做法。

设计与运维参考：[开发者 README](../dev/memory/README.md)、[块治理架构](../dev/memory-governance/arch.md)、[迁移 runbook](../dev/memory/migration-runbook.md)、[files 设计](../dev/memory/memory-plan.md)、[tidy 事务](../dev/memory/tidy-batch-plan.md)。
