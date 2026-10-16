# 项目记忆（memory）

cwd 为键的被动项目记忆：记忆文件放在 `~/.pi/agent/memory/<cwd-slug>/`，每个会话自动把它注入 system prompt（子 agent 会话同样生效，`memory.injectInChildSessions` 默认 `true`）。`memory.enabled` 默认 `true`。worktree 子会话读写的是**主仓库**的记忆目录。

## 注入方式（tiered，默认）

`memory.layout` 默认 `tiered`：

- 整文件 / 整段落准入，受 UTF-8 字节预算约束；放不下的只留索引。
- topic 文件的索引行带 `description` / `read_when` 元数据，模型据此决定是否打开；打开用 `memory` 工具。
- 空目录不注入；注入块带尾部哨兵防重复；渲染按目录指纹缓存。
- frontmatter `pin: true` 让重要文件始终留在注入区。
- 动态更新经 system prompt 稳定化 hub 处理：写入后的变化走对话尾部更新消息，不让开头字节变化而废掉 prompt cache（见 [上下文与缓存](context.md)）。

旧版行为（索引 ≤15 条 + 最新 3 个文件内联、4KB 预算）对应 `memory.layout: "legacy"`，保留为逐字节兼容的退出选项；`inlineMax`（3）/ `byteCap`（4000）只在该模式下使用；`indexMax`（15）两种布局都用。

## `memory` 工具

`memory.toolSurface` 默认 `v2`（官方字段风格）：`view [path]` / `search` / `create` / `str_replace` / `insert` / `delete` / `rename`，并兼容旧的 `list` / `write` / `append`。

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

## 其他常用设置

| 键                                        | 默认         | 含义                                                          |
| ----------------------------------------- | ------------ | ------------------------------------------------------------- |
| `memory.childProfile`                     | `core`       | 子会话的注入档位：`core` / `full` / `none`（主会话恒为 full） |
| `memory.coreBytes` / `blockBytes`         | 1600 / 2400  | tiered 的核心 / 单块字节预算                                  |
| `memory.topicWarnBytes` / `topicMaxBytes` | 8192 / 16384 | topic 文件体积告警 / 上限                                     |
| `memory.tidy.maxCostUsd`                  | `2`          | 单次 tidy 的成本上限                                          |

设计：[memory-plan](../dev/memory/memory-plan.md)、[optimize-plan](../dev/memory/optimize-plan.md)、[tidy-batch-plan](../dev/memory/tidy-batch-plan.md)。
