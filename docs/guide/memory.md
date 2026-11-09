# 项目记忆（memory）

cwd 为键的被动项目记忆：记忆文件放在 `~/.pi/agent/memory/<cwd-slug>/`，每个会话自动把它注入 system prompt（子 agent 会话同样生效，`memory.injectInChildSessions` 默认 `true`）。`memory.enabled` 默认 `true`。worktree 子会话读写的是**主仓库**的记忆目录。

## 注入方式（blocks，默认）

`memory.layout` 默认 `blocks`：用户全局规则常驻，其他块按主题索引和相关性召回；每块单独存储。主会话启动时，`memory.migrate.auto` 默认开启并在安全门允许时惰性迁移当前项目的旧文件；旧文件保留。使用 `/mem migrate --status` 查看状态、`/mem doctor` 查看提示；需要回退时用 `/mem migrate --rollback` 再 `/reload`，并核对保留的 blocks 快照中迁移后新增的内容。配置 blocks 但实际仍为 files 时按 tiered 回退。

显式 `memory.layout: "tiered"` 的 files 注入方式：

- 整文件 / 整段落准入，受 UTF-8 字节预算约束；放不下的只留索引。
- topic 文件的索引行带 `description` / `read_when` 元数据，模型据此决定是否打开；打开用 `memory` 工具。
- 空目录不注入；注入块带尾部哨兵防重复；渲染按目录指纹缓存。
- frontmatter `pin: true` 让重要文件始终留在注入区。
- 动态更新经 system prompt 稳定化 hub 处理：写入后的变化走对话尾部更新消息，不让开头字节变化而废掉 prompt cache（见 [上下文与缓存](context.md)）。

旧版行为（索引 ≤15 条 + 最新 3 个文件内联、4KB 预算）对应 `memory.layout: "legacy"`，保留为逐字节兼容的退出选项；`inlineMax`（3）/ `byteCap`（4000）只在该模式下使用；`indexMax`（15）两种布局都用。

## `memory` 工具

`memory.toolSurface` 默认 `v2`（files 布局官方字段风格；blocks 布局使用 v3）：`view [path]` / `search` / `create` / `str_replace` / `insert` / `delete` / `rename`，并兼容旧的 `list` / `write` / `append`。

- 写入有目录围栏、文件名白名单、字节上限（单文件 `maxFileBytes` 262144，单次写 `maxWriteBytes` 65536）、权限 0600；写入自动带 `source: agent` 溯源，注入时加"数据非指令"围栏。
- slug 目录可以是用户信任的符号链接；文件级符号链接和非常规文件被拒绝。
- 所有 v2 写入、导入、tidy、restore 在目录锁下串行。
- **子会话默认只读**（`memory.allowWriteInChildSessions` 放开）。
- `memory.freezeInjectionAfterWrite`（默认 `false`）：写入后冻结本会话注入块，减少 prompt cache 失效。

## `/mem` 命令

```
/mem                         概览（含 doctor 摘要）
/mem list | path
/mem import [--force] [slug|all]   把 ~/.claude/projects/*/memory/ 复制进来（幂等，原件不动）
/mem doctor                  健康检查 D01–D14（过期、体积、元数据缺失等）
/mem tidy [--batch] [--dry-run] [--status] [--frontmatter] [--break-lock]
/mem restore [--legacy|--trash] 从 tidy 备份还原
```

- `doctor`：`memory.doctor.notifyOnStart`（`true`）启动时提示，`memory.doctor.staleDays`（60）判定过期。
- `tidy`：由子 agent 整理记忆，是**带日志的事务**（先记录完整计划，再逐项 CAS 校验写入；中断可恢复）。`--batch` 归档过期条目到 `archive/` 并分批重写，受 `memory.tidy.batch.*` 的成本/次数上限约束；`--dry-run` / `--status` 只读。`--break-lock` 仅 TUI 可用，用于清理无法证明持有者已死的目录锁。
- 不支持硬链接的文件系统会拒绝事务式 tidy（失败即关闭）。

## Jev（自动分类器）

`memory.jev.*` 控制一个分类器模型（叫 Jev），它不写字，只做选择题、打分题和是非题，并给出把握。**默认开启**（有分类器凭证即启用）。它在四个时刻出场：

1. 你说话时：挑出把握 ≥60% 的相关条目，最多 3 条，最多等 2 秒（`memory.jev.recall.waitS`），来不及就晚点补发。
2. agent 写记忆时：判断类型、重要度、场景（约 22 个，固定清单，`/mem tags add` 可自己加），并检查与旧记忆的重复/矛盾。
3. 每 7 天一次：后台找重复、矛盾、过时的条目，只给建议，不自动执行。
4. agent 要做危险动作时：先用便宜规则粗筛，真有相关规则才问 Jev，必要时拦下这个动作。

**首次启用**：第一次进入 `full` 状态会提示一次：用的哪个模型、你的消息和记忆摘录会脱敏后发给它、怎么关闭（`memory.jev.enabled=false` 或 `memory.jev.classifiers=""`）。关闭后连零调用部分（快通道、压缩重注）也一起停，行为与升级前一致。代理键 `memory.jev.proxy` 只支持 `http://`，输出中的凭证总显示为 `http://***@host:port`。

**状态**（`/mem`、`/mem jev` 显示）：

| 状态            | 含义                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `full`          | 全部正常，现场问 Jev                                                                                                        |
| `partial(原因)` | 现场判定停了（没额度/被限制/分类器全不可用），但快通道、压缩重注照常；注入标记带 `·partial`                                 |
| `inactive`      | 从未配过分类器凭证，行为与升级前完全一致                                                                                    |
| `off`           | 总开关关、`layout: legacy`、secure 域、`classifiers` 为空列表或全部非法时                                                   |
| `off (pi-api)`  | 设置开着，但宿主没给分类器 API（缺 `classify`/`getAvailableOfType`/`getModelOfType`）：钩子已注册但全部空转，零注入、零调用 |

**行内权威注释语法**（写在条目首行行尾）：

```md
- GPT 系模型临时禁用 <!-- mem user expires=2026-11-30 -->
```

| 键                              | 含义                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `user` / `lesson`               | 覆盖默认归属。`user` = 用户令，只有用户能作废                                             |
| `expires=YYYY-MM-DD`            | 到期进 `/mem expired` 和启动提醒，只提示不自动删                                          |
| `until="事件"`                  | 事件型失效条件，只列为待确认，不进启动提醒                                                |
| `gate` / `gate=hold` / `nogate` | **已无行为**（高危拦截功能 2026-11 移除）；旧文件里的这些键仅保留解析兼容，新写入不要再加 |
| `tags=+a,-b`                    | 手工增删标签，优先级高于 Jev 的判定，Jev 不可用时同样生效                                 |
| `private`                       | 永远不发给 Jev（不打标、不召回、不整理）                                                  |

手写文件里没写 `source: agent` 的条目默认算 `user`；agent 建的文件里默认算 `agent`（**`memory` 工具 `append` 新建的文件归属 agent**）。agent 改写/删除带 `user` 标记的条目**不再弹确认框，直接写入**（2026-11 #26，此前的确认框、Web 弹卡与超时拒绝均已移除）；覆盖 `str_replace`/`insert`/`write`/`append`/`create` 覆写与 `delete`，`rename` 不改内容、不触发。写入成功后：主会话 TUI 弹一条 warning 通知（只含条目序号与行号，不含标题/正文），工具结果里带 `voided user rule:` 回显；**Web/headless/print 会话没有通知**，只有工具结果回显。除了直接改写用户令，下面两类写入也同样直写并通知：

- 把一个手写文件的 `source` 改成 `source: agent`（provenance 翻转，默认权威从 `user` 变成 `agent`，等于绕过了上面的守卫）；
- 把一个未归档文件写成 `status: archived`（归档会让该文件的条目退出索引与注入，等于悄悄作废了里面的用户令）。

**已知残留**（R1/R2）：

- **R1**：`rename` 本身不弹确认（不改文件内容）；但如果被改名的是**没有 `pin: true`** 的核心文件 `core.md`（例如 memory 工具 `create` 出来、含 `<!-- mem user -->` 条目的那种），改名会让它退出常驻静态块——静态核心块先找名为 `core.md` 的文件，找不到再取带 `pin: true` 的文件（`src/memory/tiered.ts:706-709`）。`/mem init` 生成的 `core.md` 自带 `pin: true`，改名后仍常驻。退出静态块的条目仍在索引里、仍可被召回，只是不再每轮必定出现；恢复方式是改回 `core.md`，或给该文件加 `pin: true`。
- **R2**：`delete` 只是软删，移进 `.trash`，`/mem restore --trash` 可以找回，但只保留最近 20 份删除快照（`src/memory/tool-v2.ts:477,1048-1052`）；超出的旧快照会被自动清理、无法再还原。

**命令**：

```
/mem jev [probe | retag [--all] | reset-index]   查看状态 / 强制探测可用性 / 重打标签 / 重建侧车索引
/mem tags [list | add … | rm … | disable … | enable …]   查看或管理场景标签
/mem review [--run | --list]                     执行或只列出整理建议
/mem expired                                      查看/延期到期条目
```

**web 端口径**（Q35，`src/web-hub/agent/command-policy.ts:199-225`）：裸 `/mem jev`（状态报告）、`/mem tags`、`/mem tags list` 直接执行（只读）；`/mem jev probe|retag|reset-index`、`/mem tags add|rm|disable|enable` 先弹确认（防误触）；`/mem review --list` 直接执行（只读清单）；裸 `/mem review`、`/mem review --run`、`/mem expired` 先确认，确认后也只降级为只读清单（不做改动），提示去终端逐条处理。

成本量级：每条用户消息约 $0.0005；首次批量打标约 $0.02（约 172 次调用）。

## 其他常用设置

| 键                                        | 默认         | 含义                                                          |
| ----------------------------------------- | ------------ | ------------------------------------------------------------- |
| `memory.childProfile`                     | `core`       | 子会话的注入档位：`core` / `full` / `none`（主会话恒为 full） |
| `memory.coreBytes` / `blockBytes`         | 1600 / 2400  | tiered 的核心 / 单块字节预算                                  |
| `memory.topicWarnBytes` / `topicMaxBytes` | 8192 / 16384 | topic 文件体积告警 / 上限                                     |
| `memory.tidy.maxCostUsd`                  | `2`          | 单次 tidy 的成本上限                                          |

`memory.jev.*` 共 14 个键，默认值以代码为准（`src/memory/settings.ts`）：

| 键                               | 默认                                       | 含义                                          |
| -------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `memory.jev.enabled`             | `true`                                     | 总开关；legacy/secure 域强制视为 `false`      |
| `memory.jev.classifiers`         | `opencode/jev-1.13-free,opencode/jev-1.13` | 分类器有序列表；空列表或全部非法 = 关闭       |
| `memory.jev.proxy`               | `""`                                       | 专用代理，只支持 `http://`                    |
| `memory.jev.childSessions`       | `true`                                     | 子会话是否接线 Jev                            |
| `memory.jev.recall.threshold`    | `0.6`                                      | 召回判定阈值（0.5–0.99）                      |
| `memory.jev.recall.maxEntries`   | `3`                                        | 单次注入条目上限（1–10）                      |
| `memory.jev.recall.maxBytes`     | `4096`                                     | 单次注入字节预算                              |
| `memory.jev.recall.waitS`        | `2`                                        | 同步等待上限秒数（0–3，0 = 纯异步）           |
| `memory.jev.review.intervalDays` | `7`                                        | 整理周期天数（0 = 只能手动）                  |
| `memory.jev.maxCostUsd`          | `0.5`                                      | 单 activation 的 Jev 总美元预算（0.01–5）     |
| `memory.jev.maxCalls`            | `800`                                      | 单 activation 的 Jev 总调用次数上限（0–5000） |

设计：[memory-plan](../dev/memory/memory-plan.md)、[optimize-plan](../dev/memory/optimize-plan.md)、[tidy-batch-plan](../dev/memory/tidy-batch-plan.md)、[jev-arch](../dev/memory/jev-arch.md)、[jev-plan](../dev/memory/jev-plan.md)。
