# bash 自动后台 · 开发者要点

> 何时读：改动 `src/bash/**`、`bashJobs.*` 设置键、`bash_job` 工具之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`./`（本目录其它文档）、`../bash-auto-background/`、`../bash-jobs-session-isolation/`

## src/bash/

`src/bash/` — bash auto-background: the same-name `bash` override, `BashJobManager` (spawn →
log tee → settle → notify → recover after restart), persisted job store. POSIX only; when the
setting is off, pi's built-in bash stays untouched. Job-level timeout grace (`bashJobs.timeoutGraceS`,
`maxExtensions`, `maxTimeoutFactor`; pure arithmetic in `src/bash/deadline.ts`) lets a background job
with an explicit `timeout` enter one grace-window notice instead of dying outright, extendable via
`bash_job(action:"extend")`. Child (subagent) sessions additionally get `src/bash/child.ts`
(`wireChildBashJobs`, lazily built per session, not on `session_start`): an `agent_before_settle`
settle-hold keeps a run with non-terminal jobs alive across bounded reminder rounds
(`bashJobs.childSettleHold`, `childSettleHoldMaxRounds` — `0` auto-derives the cap from the run's own
deadline/extension budget plus outstanding job grace, §3.5's `R_wait`/`G0`). Design:
`docs/dev/bash-timeout-grace/plan.md`.

## `shutdownPolicy=keep` 真正保住进程与日志（#73，方案 A+）

**问题**：旧实现里 job 的 stdout/stderr 是接到 pi 进程的管道，日志由 pi 从管道 tee 出来。pi 一退出（`/quit`、Ctrl+C、`kill -9` 都一样），管道读端关闭，job 下一次写 stdout 就收到 SIGPIPE：shell 内建 `echo` 直接让 shell 死掉，外部程序则是写者被杀、输出丢失；`sleep N; echo done` 这类「先沉默再输出」的命令日志是**空**的。退出码只有 `wait()` 能拿到，pi 死后永久丢失，重启后只能报 `gone (its process disappeared, exit code lost)`，且 `logBytes` 恒为 0。`keep` 的承诺此前只在 `/reload`（同进程，管道由 live handle 移交）成立。

**现在的形态**（`src/bash/process.ts` / `manager.ts` / `job-store.ts`）：

- spawn：`/bin/sh -c WRAP _ <command> <exitPath> <ddBlocks> <shell> <exitDir>`，`stdio: ["ignore", logFd, logFd]`（`logFd = openSync(logPath, "a", 0o600)`，spawn 后 pi 立即关掉自己那份）。用户命令是位置参数 `$1`，**不拼接**，引号/`$()`/换行都进不了包装脚本语法。
- 包装脚本（`JOB_WRAPPER`）：`{ "$4" -c "$1"; c=$?; mkdir -p "$5"; printf "%s\n" "$c" > "$2.tmp" && mv "$2.tmp" "$2"; } 2>&1 | { dd bs=512 count="$3"; cat >/dev/null; }; IFS= read -r c < "$2"; exit "${c:-1}"`。
  - 内层 shell 的状态码原子写进 `<jobId>.exit`（tmp + rename）；`mkdir -p` 是因为 fork/handoff 会 GC 旧 session 目录而 job 仍在跑；
  - 封顶在 job 树**内部**：`dd` 写满后 `cat >/dev/null` 继续排空，命令不会收到 SIGPIPE，沿用「写满后进程继续跑」语义。用 `dd bs=512` 而不是 `head -c`：GNU `head` 按 8KiB 块缓冲，job 的日志在攒够一块前外部不可读，会废掉实时性；
  - 外层 `exit` 取自 exit 文件，pi 在线时 `exit` 事件里的 code 与文件一致。
- 日志**由 job 树自己写**。pi 侧 `stdout` 是日志文件的 tail 读取器（`createLogTail`，unref 的轮询：有数据 50ms、空闲 250ms，`exit` 事件立即唤醒；进程退出后读到第一个 EOF 即结束，因为外层 `sh` 只在 `dd | cat` 流水线结束后才退出，此刻文件已定稿）。`stderr` 是自行结束的空流。`manager.teeChunk` 在 `logWrittenByChild` 时只做 `onData` 中继与计数，**不再写数据**；WriteStream 只用于 footer 与截断提示（O_APPEND，与 job 写者共用偏移）。
- 退出码权威来源是 exit 文件（`readJobExitFile`：缺失/空/非整数/越界都视作「没有」，绝不猜）。
- `JobRecord` schema 不变（`v:1`）；exit 路径由 jobId 派生：`store.exitPath(jobId)`。`remove`/`pruneExpired` 认识 `.exit` 与 `.exit.tmp`（后者与 `.tmp` 同为 1h TTL 的崩溃碎片）。

**恢复路径**（所有判 `dead` 的地方先读 exit 文件，`settleFromExitFile`）：

1. `recover()` 的 `dead` 分支：有 exit 文件 → `completed`/`failed(exitCode)`，补 footer、截断提示，`logBytes` 取自文件，补 `backgroundedAt`，进入正常的启动摘要通知；`RecoverSummary.recovered` 记录这类 job。无 → `exited_unknown`。
2. 轮询 `tick`（`probeAdopted`，adopt 之后 pid 才死）：同上。
3. `kill()` 无本地 handle 且 pid 已死：同上；`recover()` 的 subagent 分支经由它，已自行结束的 job 不会被误计为 `subagentKilled`。
4. `killForDeadline` 的兜底 dead 分支：同上。

- 另：终态记录的 `logBytes` 过期（pi 在「持久化状态」与「持久化日志统计」之间死掉）时，`recover()` 以文件为准对账，并在封顶但缺提示的日志末尾补上提示。
- exit 文件候选路径：live handle 用 spawn 时烘进包装脚本的路径；恢复时依次试 `record.logPath` 同目录、`store.exitPath`。

**已知且接受的语义变化**：

- 外部 `kill -TERM <shell>` 现在是 `failed (exit 143)`，不再是 `killed`：内层 shell 的信号死亡被折算为 `$?=128+n` 并记录，外层 `sh` 正常退出。manager 自己发起的 kill/timeout 走 `handle.termination`，不受影响；`bash_job kill` 杀整个进程组，外层 `sh` 一起死、不留 exit 文件，仍是 `killed`。
- 进程树多了 `sh` / `dd` / `cat`（`ps`/`pstree` 可见；`dd`/`cat` 可用 `command -v` 探测，缺失时降级为不封顶的 `JOB_WRAPPER_UNCAPPED` 并告警一次）。每个命令约 +4ms；前台快命令的完整收尾约 10ms，与改动前持平。
- 日志可能比 `maxLogBytes` 多至多一个 `dd` 块（512B，多出的那一字节是「是否被截断」的见证）。
- `kill()` 对已终态 job 的判定改为「handle 是否仍开着」：handle 在 tail 读到 EOF 前保持打开，会比 leader 多活一两个轮询周期，所以这段窗口内的 `kill` 会真的问一次进程组（空组返回 `already-dead` → 对调用方仍是 `already-terminal`）。

**残余风险**（诚实记录）：

- pi 不在场时**没人执行 `timeout`/grace**：job 的 deadline 只存在于 pi 内存里，重启后 adopt 的 job 不再有 deadline（既有行为，#73 没有改变，只是 job 现在真的活得到那时）。
- 整组被 SIGKILL（OOM、`kill -9 -pgid`）时外层 `sh` 来不及写 exit 文件，仍是 `exited_unknown`。
- 无 `dd`/`cat` 的降级包装下，外层 `sh` 退出后遗留的后代仍可能写日志，tail 在第一个 EOF 就结束，之后的字节不会进 `onData`（但在文件里）。
- `recover()` 的 `adopted` 路径此前几乎无法在生产里被触发，现在会成为常态路径，需要真机冒烟（adopt 后的完成通知、`bash_job kill`、再次退出）。

测试：`tests/integration/bash-crash-recovery.test.ts`（子 node 进程里跑真实 manager → `SIGKILL` → 新 manager `recover()`；覆盖「静默到结束才输出」「外部写者」「输出封顶」「崩溃后仍在跑 + 无 exit 文件」）；`tests/bash/process.test.ts`（file-fd 模式、tail、包装脚本、封顶、SIGTERM 语义）；`tests/bash/manager.test.ts`（exit 文件恢复各分支）；`tests/bash/job-store.test.ts`（`.exit` 清理）。
