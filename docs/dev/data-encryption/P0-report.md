# P0 报告 — gocryptfs 实测探针（2026-10-23）

环境：Ubuntu 22.04 / 5.15，`gocryptfs 1.8.0-1ubuntu0.1`（go-fuse 2.0.3，go1.18.1），`fuse3 3.10.5`（`/usr/bin/fusermount` → `fusermount3`），pi 1.3.0。

## 结论

**gocryptfs 1.8.0 满足方案全部所需行为，版本下限放宽为 ≥1.8（apt 版即可）。** 无设计级问题；无需官方静态二进制、无需启动器选择 `~/.local/bin` 路径。

## 逐项实测（均由 `scripts/dev/secure-probe.sh` 自动断言）

| 项目                     | 实测                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `-init` 经 TTY           | 提示 `Password:`、`Repeat:`；随后打印 master key（64 hex，8 组×8，折两行，ANSI dim）并报成功    |
| `-init -q`               | **不打印 master key**（TTY 下仍提示口令）⇒ 生产 init 禁用 `-q`                                  |
| 已有 cipherdir 再 init   | exit 7                                                                                          |
| 挂载经 TTY               | 提示 `Password:`；`-q` 时仍提示，但不打印 "mounted and ready"                                   |
| `-nonempty`              | 可挂到含哨兵文件的目录；缺省 exit 10（"not empty"）                                             |
| 口令错误                 | exit 12（`-passfile` 与 TTY 一致；`script -e` 透传退出码）；不留挂载                            |
| 挂载点不可写（0500）     | exit 19（fusermount: no write access）                                                          |
| `-passfile` / `-extpass` | 均可用（仅测试）                                                                                |
| `-q` / 非 `-q`           | `-q` 无输出；非 `-q` 打印 passfile/Decrypting/mounted                                           |
| 守护化 / `-fg`           | 默认返回后留 `gocryptfs -fg -notifypid=… ` 子进程；`-fg` 前台至卸载后 exit 0                    |
| 卸载                     | `fusermount3 -u` 成功；挂载根 0500 不影响卸载；守护被 KILL 后 ENOTCONN，`fusermount3 -u` 可清理 |
| cwd 在挂载内             | `fusermount3 -u` 报 `Device or resource busy`，仍挂载                                           |
| mountinfo                | `… - fuse.gocryptfs <cipherdir 绝对路径> rw,user_id=…`                                          |
| `flock -o`               | unlock 返回后 `flock -n mount.lock` 立即成功；**不加 `-o` 则守护进程长期占锁**（`-o` 必须）     |
| 卸载后哨兵               | `mkdir -p mnt/state/x` → ENOTDIR；写 `mnt/work/y` 失败；`work` 恢复为 0 字节普通文件            |

## C1–C5

- C1/C2/C3：通过（见上表；conformance 通过探针脚本逐组断言）。
- C4：通过。额外发现：`--session-dir ""` 字段存在（空串），而 pi `main.js` 把空串当未设置；**末尾悬空的 `--session-dir`/`--fork`/`--session` 不被消费，进入 `unknownFlags`** ⇒ 启动器审查须一并拒绝；`--` 之后全是 message/`@file`。
- C5：通过。真实 pi（`--no-extensions -p`，最小环境无凭据 ⇒ "No API key"，零模型请求），`--session-dir`+`--fork`+`--name` 只写 sessionDir（cwd/agentDir/HOME 无 jsonl，源文件不变）；对 sessionDir 内已有会话 `--session`+`--name` 原地追加；`--no-session` 不写任何会话。

## 方案调整（已回填 plan.md）

1. 版本下限 ≥2.0 → ≥1.8（文首、§2.2、§3）；§1 增 P0 实测行；文末新增「§P0 回填」表。
2. 施工口径：init 不得 `-q`；§2.2.1 审查须拒绝 `unknownFlags` 含 `session-dir/fork/session`；`flock -o` 必须；卸载统一 `fusermount3 -u`；判活用 mountinfo 而非进程名。
3. §6：conformance 改为自门控（工具可用即跑）。

## 交付文件

- `/home/bluecake/ai/pi-toolkit/scripts/dev/secure-probe.sh`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/secure-gocryptfs.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/plan.md`（回填）
- `/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/P0-report.md`

## 自验

见任务最终回复。探针 ~15s，全程私有 0700 mktemp 目录 + 假口令，EXIT trap 卸载并清理；跑后无残留挂载/目录。

## 遗留

- C5 仅用 devDependency 的 pi（及 PATH 上 `pi` 若 realpath 不同则一并测）；真实模型请求路径未测（不需要）。
- 探针脚本为 bash，prettier 无 shell 解析器，未格式化（`prettier --check` 仅覆盖 ts/md）。
