# bash 自动转后台

默认开启（仅 POSIX；win32 不覆盖，内置 `bash` 原样保留）。以同名方式覆盖 pi 内置 `bash`，短命令行为与内置**逐字节一致**。只有跑过阈值的命令改变行为：调用提前返回 `job_id`，**进程不杀**、输出继续落日志，退出时以 `bash-job:notification` 注入完成通知（带输出尾巴，并触发新 turn）。明知是长命令可直接传 `run_in_background: true`。阈值默认 290 秒，刻意低于 5 分钟 prompt 缓存 TTL。

## `bash_job` 工具

`job_id` 支持唯一前缀：

- `status` — 状态 + 日志尾部 + 路径。
- `wait` — 有界阻塞，默认 30s，硬顶 120s。
- `kill` — 杀整个进程组，幂等，带 pid 复用防护。
- `list` — 列出 job。
- `extend` — 给已进入宽限的 job 续期（见下）。

没有 `output` 动作：日志就是 `~/.pi/agent/bash-jobs/<sessionId>/<job>.log` 普通文件，直接用 `read` / `tail` / `grep`。进程终态时日志尾部追加一行结论（形如 `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s`），写满 `maxLogBytes` 也照样追加。

## 设置

| 键                                  | 默认                     | 含义                                                                        |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `bashJobs.autoBackgroundS`          | `290`                    | 前台 bash 超过该时长转后台；`0` = 整个功能关闭（内置 bash 零变化）          |
| `bashJobs.maxLogBytes`              | `10485760`               | 单 job 日志上限；写满停写并标记截断，**进程继续跑**                         |
| `bashJobs.maxBackgroundJobs`        | `8`                      | 并发后台 job 上限                                                           |
| `bashJobs.retentionS`               | `86400`                  | 终态 job 的 JSON/日志保留时长；`<=0` 关闭清理                               |
| `bashJobs.shutdownPolicy`           | `"keep"`                 | pi 真退出时对仍在跑的 job：`keep` / `kill`；reload/new/resume/fork 一律保留 |
| `bashJobs.dir`                      | `~/.pi/agent/bash-jobs`  | job 状态与日志根目录（按 `<sessionId>/` 分层）                              |
| `bashJobs.shellPath`                | `$SHELL`(白名单)→ `bash` | 执行命令的 shell（`$SHELL` 仅 basename ∈ {bash, zsh, sh} 时采用）           |
| `bashJobs.timeoutGraceS`            | `60`                     | 已转后台的 job 到达显式 `timeout` 时的宽限时长；`0` = 关宽限                |
| `bashJobs.maxExtensions`            | `3`                      | `bash_job(action:"extend")` 最大续期次数；`0` = 禁 extend                   |
| `bashJobs.maxTimeoutFactor`         | `3`                      | 宽限 + 续期的硬上限 = 原 `timeout` 的几倍；`1` = 不可续、无宽限             |
| `bashJobs.childSessions`            | `true`                   | 子（subagent）会话是否注册自己的 `bash` / `bash_job`                        |
| `bashJobs.childSettleHold`          | `true`                   | 子会话收尾时若仍有非终态后台 job，是否提醒并推迟结束                        |
| `bashJobs.childSettleHoldMaxRounds` | `0`                      | 收尾提醒轮数上限；`0` = 按 run 自己的截止/续期预算自动推导                  |

## 行为要点

- **目录清理**：session 启动时扫一次，之后每次新建 job 时最多每 10 分钟再扫一次（不新增定时器）。只碰 `.json` / `.log` / `.tmp`，非终态 job 永不删。
- **敏感输出会落盘**（0600/0700，与 session 文件同威胁模型），直到 `retentionS` 过期——敏感输出仍应重定向。
- **重启 / reload 后收养**：仍在跑的 job 在下一个 session 被重新接管并继续通知；pid 归属无法确认的 job 只标记不杀。
- **job 级到期宽限 + 续期**（仅已转后台且带显式 `timeout` 的 job）：到期先进入 `timeoutGraceS` 宽限并提醒（主会话 `bash-job:timeout` 消息 + TUI），由调用方用 `bash_job(action:"extend", job_id, extend_s)` 续命。
- **子会话收尾**：若轮到结束时仍有非终态后台 job，会被有界轮数地提醒而非立即结束；run 结束时强制封存并杀掉全部未结束的 job，终态通知里会带上它们。
- Web hub 的会话详情有只读的后台 job 面板，fleet 徽标也会计入运行中的 bash（见 [Web Hub](web-hub.md)）。

设计：[bash-auto-background](../dev/bash-auto-background/plan.md)、[bash-timeout-grace](../dev/bash-timeout-grace/plan.md)。
