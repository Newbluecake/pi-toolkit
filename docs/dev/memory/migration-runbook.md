# 记忆迁移 runbook（TUI 主会话）

适用状态：以 `2f7a3658` 的 blocks 默认布局及 C4 命令实现为基准（2026-11-09 更新）；最初编写基线为 `eb105111494a1ee99308d6bfa0fa636bfdb85edc`。以下 `/mem` 和 `/reload` 是在 pi 的 TUI 输入框中输入，**不是 shell 命令**；标为 shell 的命令在普通终端运行。先读完回退段再开始。

> **升级后首次启动前：先暂停自动迁移并备份。** 默认 `memory.layout=blocks` 且 `memory.migrate.auto=true`，主会话一启动就可能迁移当前项目；自动启动迁移**不要求 TUI**，RPC/print 等主会话也可能触发。先停止目标项目的旧写入者，在启动前将目标配置中的 `memory.migrate.auto` 设为 `false`，按第 2 节用同一环境完成并核对备份；若未能确认实际路径或设置，先停止，不要启动目标会话。
>
> 在启动环境对应的设置文件（默认 `~/.pi/agent/pi-toolkit.json`，或绝对路径 `PI_CODING_AGENT_DIR` 下的同名文件；尚未迁移时可能读取 `pi-subagent.json`）中，**合并** `"memory": { "migrate": { "auto": false } }`，不要覆盖其他已有设置；确认目标进程实际读取该文件。设置在 activate 时读取，已有进程不会因文件修改自动改变行为；旧进程需先停止写入。
>
> 完成备份后才启动目标会话核对 `/mem path`；若与预先备份的路径不一致，停止并先备份实际根。显式执行 `/mem migrate`、回退、导入或 `--all` 则要求真正的 **TUI 主会话**，与启动时自动迁移的准入条件不同。

## 1. 前提与影响

- 迁移规划是确定性规则，不调用模型；它按文件、元数据和现有索引拆分或保留整文件，不是语义分类。迁移会改变记忆的组织和注入内容，必须逐项核验。
- 迁移成功后该目录使用 `blocks/` 布局，`/mem tidy` 禁用，改用 `/mem review`；旧根目录 Markdown 文件**不修改、不删除**，供回退参考。但迁移后新增或编辑的 blocks 不会自动写回旧文件。
- 完成第 2 节备份并确认 auto 已关闭后，在**目标项目目录**启动 pi 的交互式 TUI **主会话**。写迁移、回退、导入以及任何 `--all` 要求 `hasUI && mode === "tui" && !isWebInvocation`；child 会话拒绝迁移。部分只读命令不要求 TUI：Web 的独立只读执行器只实现精确的 `migrate --dry-run` 和 `migrate --report`，不是完整迁移入口。安全门禁未通过会报 `E_GATE: <reason>`。见 `src/memory/command.ts:290-328,612-614`、`src/memory/command-readonly.ts:101-123`。
- 备份前在同一环境中按以下规则确定记忆根；备份后才在目标会话执行 `/mem path` 确认实际项目记忆目录。默认根是 `/home/bluecake/.pi/agent/memory`（以当前用户 home 为准）；若启动 pi 的环境设置了 `ARMORY_MEMORY_ROOT`，实际根使用该值。项目目录名将 cwd 尾部 `/` 去掉、其余 `/` 替换为 `-`；例如 `/home/bluecake/ai/pi-toolkit` → `-home-bluecake-ai-pi-toolkit`。worktree 会先解析到主仓库 cwd；slug 可能有歧义，以 `/mem path` 为准（`src/memory/paths.ts:20-48`、`src/memory/command.ts:80-85,374-375`）。
- 每个显式迁移目录的预算为 60 秒、120,000 操作、20,000 个源文件、64 MiB 源文件总量；触限可能显示 `memory: over-budget — Error: E_BUDGET...`。预演快照也有文件数和字节上限，但其报错形式可能是 `memory error: E_BUDGET: source count` 或 `source bytes`（`src/memory/blocks/migrate.ts:108-127,151-169,410-414,564-618`）。

## 2. 第 0 步：备份

在与 pi **相同环境**的 shell 运行，先停止所有记忆写入并确认磁盘空间足够；下面用 Bash 和 GNU coreutils。默认根来自 `HOME`，**不是** `PI_CODING_AGENT_DIR`；若启用了 secure vault，以 `/mem path` 和 vault 的实际根为准，备份必须留在已解锁的加密边界内。备份前依据相同启动环境确定实际根；若不确定，停止并先核实，不能为查 `/mem path` 而先启动目标会话。备份后若与 `/mem path` 不一致，停止并在同一 shell 显式设置 `ARMORY_MEMORY_ROOT` 为实际根后再次备份。

先检测尾斜杠并规范化，避免 `memory/` 拼接 `.backup` 后变成 `memory/.backup` 而自复制。`readlink -f` 同时解析根目录 symlink；命令失败或源为 `/` 时停止：

```bash
raw=${ARMORY_MEMORY_ROOT:-${HOME:?HOME 未设置}/.pi/agent/memory}
printf 'raw root: %s\n' "$raw"
case "$raw" in */) echo '检测到尾斜杠，将规范化';; *) echo '无尾斜杠';; esac
linkcheck=$raw
while [ "$linkcheck" != / ] && [ "${linkcheck%/}" != "$linkcheck" ]; do linkcheck=${linkcheck%/}; done
[ -L "$linkcheck" ] && printf '根是 symlink: %s -> %s\n' "$linkcheck" "$(readlink -f -- "$raw")"
src=$(readlink -f -- "$raw") || { echo '无法解析源'; return 1 2>/dev/null || exit 1; }
[ -d "$src" ] && [ "$src" != / ] || { echo '源不是有效目录或是 /'; return 1 2>/dev/null || exit 1; }
printf 'normalized source: %s\n' "$src"
```

核对输出与目标启动环境的实际根相符后，继续在**同一 shell**运行；启动会话并获得 `/mem path` 后再复核。备份目录使用解析后源目录的兄弟目录，`mktemp` 不覆盖已有备份；若兄弟目录不在安全 vault 内，停止，不要运行，改在 vault 内选择位于源目录外的安全位置：

```bash
backup=$(mktemp -d "${src}.backup-$(date +%Y%m%d-%H%M)-XXXXXX") || { echo '无法创建备份'; return 1 2>/dev/null || exit 1; }
printf 'source: %s\nbackup: %s\n' "$src" "$backup"
cp -a -- "$src/." "$backup/" && diff -r --no-dereference -- "$src" "$backup" && echo '根目录备份核对通过' || { echo '备份失败或不一致，停止迁移'; return 1 2>/dev/null || exit 1; }
find "$src" -type l -print
```

最后一条列出根内 symlink；`cp -a` 只保存链接本身，**不保存其目标数据**。无输出才可直接认为根备份完整（仍需确保没有单独挂载或并发修改）；有输出时逐项检查。对每个链接目录，以下示例把 `link` 改为 `find` 输出的一个绝对路径，并检查 `readlink -f` 实际目标。刻意只保留链接时，必须另行确认目标本身已有独立备份并记录目标路径；否则备份目标内容：

```bash
link='/替换为/find/列出的链接目录'
[ -L "$link" ] || { echo '不是 symlink，停止'; return 1 2>/dev/null || exit 1; }
target=$(readlink -f -- "$link") || { echo '链接无有效目标，停止'; return 1 2>/dev/null || exit 1; }
printf 'link: %s\ntarget: %s\n' "$link" "$target"
[ -d "$target" ] && [ "$target" != / ] || { echo '目标不是目录或是 /，停止并单独处理'; return 1 2>/dev/null || exit 1; }
case "$backup/" in "$target/"*) echo '备份在链接目标内部，停止'; return 1 2>/dev/null || exit 1;; esac
find "$target" -type l -print
```

若最后一条有输出，目标内部还有链接，须逐个检查并另做独立备份，不能声称此副本包含其目标；若目标跨安全边界或不在已解锁 vault 内，停止并在相同安全边界内备份。确认后在同一 shell 继续（每个链接都运行一次）：

```bash
linkcopy=$(mktemp -d "$backup-link-target-XXXXXX") || { echo '无法创建链接目标备份'; return 1 2>/dev/null || exit 1; }
cp -a -- "$target/." "$linkcopy/" && diff -r --no-dereference -- "$target" "$linkcopy" && printf '已核对: %s -> %s; 数据副本: %s\n' "$link" "$target" "$linkcopy" || { echo '目标备份失败，停止迁移'; return 1 2>/dev/null || exit 1; }
```

记录每个 `link`、解析后的 `target` 和 `linkcopy` 的对应关系，保存在同一安全边界内。恢复时不要只恢复根备份中的链接：先停止写入，核实原目标路径仍正确且安全，将对应数据副本恢复到经核实的目标，或重建指向新恢复目录的链接；先检查目的地且不要覆盖迁移后的新增数据。备份可能含私密数据，权限和存放位置按原记忆同等保护。

## 3. 第 1 步：只读预演

在目标项目的 TUI 主会话依次输入：

```text
/mem path
/mem migrate --status
/mem migrate --dry-run
```

`--status` 显示配置 `auto`、`layout`、目录实际格式 `dir`、状态、`hold`、旧文件漂移计数 `legacyDrift` 和可用时的 `runId`；`--dry-run` 对当前旧根文件做规划，输出 JSON，不发布 blocks。已经迁移的目录要以 `--report` 查看当次已发布报告；再跑普通 dry-run 是对**当前旧文件**重新规划，并非已发布内容的快照。

**怎么看报告：**

- `files` 中逐个核对原文件、`blocks` 数量、`whole`（整文件保留为一个块）、`mixedAuthority` 与 `retained`。`MEMORY.md` 标记 retained，不生成块；不应误以为它已按条迁移。
- 按块 ID 前缀与 `merged` 检查 topic 归类是否合理；核对 `global`、`audience` 和每份源文件的权限来源。规划默认 authority 的规则见 `src/memory/blocks/migrate-plan.ts:68-106,132-162`；报告不列出每个块的 authority，不能仅凭报告证明正确，试点后需检查块文件元数据。
- 检查 `oversize`（超过 1 KiB，仍迁移并产生建议）、`pointers`、`inlineErrors`、`wholeInline`；不要把建议当成自动修正。`residue` 非空时核对 origin/preview，确认未识别文本没有被误归类；整文件回退亦需核对。见 `src/memory/blocks/migrate-plan.ts:125-130,173-215,218-257`。
- 不合理、信息不足或报错时停止，保留报告；不要进入全量。若 `hold` 存在，先读回退章节；若已是 blocks，先核验当前状态，不要把它当新试点。

## 4. 第 2 步：单目录试点

先只选择当前这一个目录，**不要加 `--all`**。确认备份与预演后输入：

```text
/mem migrate
```

预期提示 `memory: committed`；`already-migrated`、`absent`、`aborted` 或 `over-budget` 不是新迁移成功，先检查。完成后依次输入：

```text
/mem migrate --status
/mem doctor
/mem migrate --report
/mem list
/mem review
```

验收清单：

- **切换与状态**：不需要手工修改 layout 文件或设置。迁移先在暂存目录生成 `blocks/.layout.json` 所需的 marker，单次原子 rename 发布 `blocks/`，这就是目录格式切换点。`layout` 是配置值，`dir` 是磁盘格式：迁移前 `layout: legacy/tiered` + `dir: files` 合法；也可配置 `blocks` 但仍为 `files`（尚未迁移，实际回退 tiered）。迁移后 `dir: blocks`，即使 `layout` 仍为 `legacy/tiered`，实际渲染也以 blocks 为准；`/mem doctor` 的 D24 会提示配置不一致，并不代表迁移失败。配置值不会由迁移自动改写，工具表面也不一定随之改变。`held` 表示回退 hold，`absent` 表示无可迁移目录/源，不能当作成功。
- 在 shell 将下面变量替换为 `/mem path` 输出的项目目录，只读查看 marker 和代际；不要手工创建或编辑它们：

  ```bash
  project='/替换为/mem path/输出的项目目录'
  test -f "$project/blocks/.layout.json" && cat "$project/blocks/.layout.json"
  test -f "$project/.blocks-state.json" && cat "$project/.blocks-state.json"
  ```

  marker 的 `gen` 是提交代际；状态文件 `gen` 用于阻止并发迁移/回退的过期提交，并非块数量或配置版本。正常新提交时两者应相同，marker 的 `runId` 应与 `--status` 一致；中断或回退期间状态代际可先增加，不能只凭 gen 断定已发布。若缺 marker、状态异常、hold 存在或核对不一致，停止并调查；`/mem doctor` 还用于检查 D24 漂移和 D25 未完成回退等诊断，不要只看 marker。

- `--status` 的 `dir` 为 `blocks`，查看 runId、hold 和 legacyDrift；`--report` 与预演对照，检查全部源文件、归类和异常。报告在 `blocks/.migration-report.json`，只有成功发布过迁移报告才可读取。
- `/mem list` 的条目符合预期；`/mem review` 只读合并现有 Jev 侧车建议（含非治理类型）与即时治理建议，并核对锚点、去重和已处理状态。查看不执行建议；`--run` 也只展示现有建议，不触发分类或 sweep。
- 在主会话发一个与已知记忆有关的普通请求，检查会话中实际注入的记忆是否正确、重要用户令及隐私范围没有异常；不要只以模型回答正确与否代替检查注入内容。
- 用 `/mem path` 输出的目录在文件管理器中只读检查：临时 `.blocks-staging-<runId>` 构建完成后原子发布为 `blocks/`；其中应有 `topic.NNN.md`、`archive/`、`.trash/`、`.jev/index.json`、`.migration-report.json` 和 `.layout.json`。旧根 `.md` 仍在。中断可能留下 staging 或隔离残留，先调查，不要手动删除（`src/memory/blocks/migrate.ts:186-229,437-481,485-564`）。

## 5. 第 3 步：观察

建议观察 1–2 天，正常使用项目并检查相关记忆注入、用户令、topic、隐私、review、`/mem migrate --status` 的 hold 与 legacyDrift。出现以下任一情况立即暂停全量：重要内容缺失或误注入、authority/隐私错误、异常重复或丢失、review/列表与预期不符、staging 残留持续存在、`aborted`、`over-budget`、锁或安全门禁报错。先保存错误和报告；必要时按回退操作。

## 6. 第 4 步：全量

只在试点验收通过且备份有效后，在 TUI 主会话输入：

```text
/mem migrate --all
```

该命令枚举记忆根下非隐藏、同设备且当前格式为 `files` 的目录，**逐目录串行**执行；不覆盖已迁移的 blocks，也不遍历子目录。单目录返回 `aborted` 或 `over-budget` 时循环会继续处理下一个，已成功目录不会自动回滚。注意命令外层抛出的 gate、枚举等异常会终止整个循环，不能假定任何错误都继续（`src/memory/command.ts:303-371`）。

执行期间不要并发编辑记忆、运行其他迁移或中途 `/reload`；逐条记录通知和失败目录。完成后进入每个目标项目，依次运行 `/mem migrate --status` 和 `/mem migrate --report`，核对成功情况；失败目录修复原因后可在该目录单独重试。不要把根路径下其他备份目录放入 memoryRoot 内，以免被枚举。

## 7. 回退

回到**要回退的项目**的 TUI 主会话，先保存其 `--status` 和 `--report`，然后输入：

```text
/mem migrate --rollback
/reload
```

回退基于**当时的旧根文件**恢复文件布局，把整个 `blocks/` 保留为 `.blocks-rolledback-<id>`，写入 hold，提示 changed/new blocks；这些变更不会自动合并到旧根文件，必须在保留目录和备份中核对，避免丢失迁移后的新增记忆。hold 阻止惰性自动迁移；明确再次运行 `/mem migrate` 会清除 hold 并尝试重新迁移，因此不要误操作。回退中断后可在门禁和目录恢复正常时重跑 `/mem migrate --rollback` 续做，再 `/reload`；迁移入口也会先续完未完成的回退（`src/memory/blocks/migrate.ts:289-361,391-405`、`src/memory/command.ts:357-366`）。全量回退需逐项目执行，不能假设一个命令回退全部。

## 8. 常见问题

- `memory migration requires the interactive main session`：写操作或 `--all` 不在真正 TUI 主会话，或是 child；改到目标项目的主 TUI。child 若被只读层先拦截也可能显示 `E_CHILD_READONLY: project memory is readonly`。
- `memory dir busy: lock … is held by … since … (owner cannot be verified) — if no pi process holds it, run /mem tidy --break-lock`：目录锁在等待期限内未取得。先停止同目录其他记忆写入并等待，确认持锁主机和进程；锁龄本身不是进程死亡证据。提示中的 `/mem tidy --break-lock` 在 blocks 目录禁用 tidy 时不可盲目使用；不要手动删锁，先核实并排查（`src/memory/lock.ts:29-33,71-115`）。迁移内的锁错误也可能包在 `memory: aborted — ...` 中。
- `over-budget` / `E_BUDGET`：超出时间、操作、文件数或字节预算。停止并保存输出，核对源目录规模及机器负载，先处理原因，再单目录重试；不要反复并发重试。dry-run 的文件数/字节报错也要处理。
- `E_GATE: locked`、`E_GATE: unmounted`、`E_GATE: identity-changed`：分别表示安全域锁定、vault 未挂载或目录身份无法确认/改变；停止操作，检查正确 vault 已解锁且挂载、路径身份未变，必要时安全重启会话。不要绕过 gate 或在卸载后的底层路径写入（`src/secure/memory-gate.ts:38-50`）。迁移过程中也可能作为 `aborted` 的 reason 出现。

## 9. 迁移后

- blocks 目录禁用 tidy。`/mem review` 只读展示现有 Jev 建议与即时治理建议，不限于治理子集；`/mem expired` 独立展示 active 块的已过期 `expires` 和所有 `until` 条件，区分 user/agent（同一块可占两行），不包含已取代或归档块。两者均不运行 sweep、分类器或交互式修改；`until` 只供核对，不能据此断言事件已发生。当前实现见 [README 的只读展示说明](README.md#mem-review-与-mem-expired-只读展示)。
- 恢复归档或已取代的块用 `/mem restore --block <id or stored name>`，把占位符替换为实际 ID 或存储名；这不是删除恢复。已删除块保存在 `blocks/.trash/`，对应 `/mem restore --trash` 的 blocks 路由由另一包修复中，本 runbook 不承诺该路由已可用；files 布局仍使用根 `.trash/` 的原有恢复路径。
- Jev 已有标签按条目内容 hash 匹配沿用，未匹配不会因迁移重新调用模型分类；报告里的 oversize 等是规则建议（`src/memory/blocks/migrate-plan.ts:142-145,195-215`）。
- 旧根文件迁移后发生变化不会自动覆盖 blocks。`/mem migrate --import-legacy --dry-run` 只列出漂移文件；核对后 `/mem migrate --import-legacy` 才追加导入，以内容 hash 去重，需已是 blocks；不覆盖现有块。见 `src/memory/blocks/legacy.ts:44-56,58-124`。
- `memory.migrate.auto=false` 表示关闭 session_start 的惰性自动迁移，只显式迁移；**不能假设当前值为 false**：此 HEAD 默认 `true`，默认 layout 是 `blocks`，启动自动迁移还要求主会话、files 目录及安全门禁通过等，不要求 TUI。以 `/mem migrate --status` 的实际值为准；若要保证试点前不自动迁移，启动目标会话前应先核实设置。证据 `src/memory/settings.ts:475-482`、`src/memory/index.ts:254-274`。

### 开关速查及组合边界

| 输入                           | 行为与前置条件                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `/mem migrate`                 | 当前目录显式迁移；真实 TUI 主会话、gate 通过；已有 blocks 返回 `already-migrated`。 |
| `/mem migrate --dry-run`       | 当前旧源生成规划报告，不发布；受只读和 gate 限制。                                  |
| `/mem migrate --report`        | 读取已发布 blocks 内的迁移报告；无报告会报错。                                      |
| `/mem migrate --status`        | 显示当前状态；读取也要过 gate。                                                     |
| `/mem migrate --all`           | 枚举符合条件的 files 目录，真实 TUI 主会话；可与 `--dry-run` 组合逐目录预演。       |
| `/mem migrate --import-legacy` | 已迁移 blocks 中追加导入发生变化的旧文件；加 `--dry-run` 只列文件，不创建块。       |
| `/mem migrate --rollback`      | 当前 blocks 回退并保留 blocks 快照、写 hold；需要 `/reload`。                       |

`--report`、`--status`、`--import-legacy`、`--rollback` 互斥。不要混用 `--dry-run` 与 report/status/rollback，也不要混用 `--all` 与 report/status/import-legacy/rollback：命令策略会拒绝这些组合；TUI handler 本身的解析优先级并非严格互斥校验，依赖冲突组合可能导致非预期分支（`src/memory/command-policy.ts:18-26`、`src/memory/command.ts:290-300,330-366`）。

## 已知风险

迁移只规划项目记忆目录根部符合名称规则的 `.md`，不迁移旧 `archive/`、`.trash/` 等子目录；`MEMORY.md` 也只保留、不生成块。备份必须包含这些内容，试点时需人工核对是否有仍需使用的记忆，不能假定它们已进入 blocks。备份期间若仍有其他写入者，`cp` 和 `diff` 不构成一致性快照，须先停止写入再备份核验。

## 附录 A. 交接数据

```json
{
  "base_head": "2f7a3658",
  "original_base_head": "eb105111494a1ee99308d6bfa0fa636bfdb85edc",
  "deliverable": "docs/dev/memory/migration-runbook.md",
  "scope": "文档；用户在 TUI 主会话手动迁移",
  "critical_correction": "HEAD 的 memory.migrate.auto 默认 true，不能按 false 描述实际默认；status 显示生效值。默认 layout 为 blocks。",
  "limitations": [
    "迁移规则不调用模型；迁移结果与注入须人工验收",
    "回退不会自动合并迁移后对 blocks 的更改",
    "全量中返回 aborted 继续；外层抛错可中止循环",
    "review/expired 为只读展示，--run 不启动整理；删除块的 restore --trash 路由由另一包修复中"
  ]
}
```
