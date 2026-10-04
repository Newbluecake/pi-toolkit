# web-hub「选择工作目录建会话」真机验收（acceptance v1，随 plan v2 建立）

> 配套：`arch.md`（v2）、`plan.md`（v2）。本文是 SP13 的交付物之一，实测数据（耗时、截图）在施工时补进「实测记录」。
> **S1 合入硬门槛**：A1–A8 全部通过（对应 plan §4 SP13 的 H1–H8）。S2 项另行验收，不阻塞 S1。

## 0. 平台矩阵

| 平台                                             | 预期                                                                                                                      | 验收                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Linux x86_64（Ubuntu 22.04，内核 5.15）          | 全功能                                                                                                                    | 本文全部步骤                                 |
| WSL2                                             | 全功能                                                                                                                    | A1、A2、A5（抽检）                           |
| Linux，`/proc` 以 `hidepid=2` 挂载或缺 `boot_id` | fail closed：`GET /api/headless` ⇒ `policy.allowed=false, reason:"platform"`；POST ⇒ 403 `E_SPAWN_DENIED`；无 reaper 进程 | 单测覆盖（SP2 `probePlatform`）；真机可选    |
| macOS                                            | fail closed，同上                                                                                                         | 有条件的话跑 §1 第 5 步 + A8；否则以单测为准 |

## 1. 前置条件（每轮验收开始前）

1. 隔离环境：`export HOME=$(mktemp -d /tmp/pwh-acc-XXXX)`、`export XDG_RUNTIME_DIR=$HOME/run && mkdir -m700 $XDG_RUNTIME_DIR`。
2. 用正规方式安装本包（**禁止 `pi -e`**，否则拉起的子进程里没有扩展，见 arch §3.2 前提 1）：`pi install /home/bluecake/ai/pi-toolkit`。
3. `~/.pi/agent/pi-subagent.json` 写入：
   ```json
   {
     "webHub": {
       "enabled": true,
       "spawn": { "enabled": true, "roots": ["~/acc-roots"], "maxProcesses": 4, "maxPerPrincipal": 2 }
     }
   }
   ```
   建目录：`mkdir -p ~/acc-known ~/acc-roots/sub ~/acc-outside`。在 `~/acc-known` 里先用 tmux 跑一次 `pi` 再退出，让它成为「已知目录」。
4. 启动宿主：`tmux new-session -d -s pwhacc -x 220 -y 55 -c ~/acc-known "pi"`，再执行 `/webhub open` 取得带 token 的 URL。
5. 确认 caps：浏览器开发者工具里 SSE `hub` 帧的 `caps` 以 `"spawn.v1"` 结尾；`curl -s -H 'X-PWH: 1' -b "<cookie>" http://127.0.0.1:<port>/api/headless | jq .policy` 显示 `allowed:true`。
6. 记下基线进程：`pgrep -u $USER -fa 'pi|node' > /tmp/pwh-acc-baseline.txt`。

每个用例的「超时」是判定失败的上限，不是期望耗时。

## 2. S1 硬门槛

### A1 正常闭环

| 步  | 操作                                                                                                              | 超时 | 预期                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 网页「新建会话 ▾ → 选择目录新建…」，选最近目录 `~/acc-known`，首条消息填 `只回复 OK 并 touch acc-umask.txt`，提交 | 2s   | 不弹确认（loopback + 已知目录）；列表顶部出现 `starting` 行                                                |
| 2   | 等待                                                                                                              | 30s  | 出现 `kind:rpc` 卡片并带 `web` 徽标；占位行消失；页面自动跳到该卡片                                        |
| 3   | 观察 transcript                                                                                                   | 60s  | 出现用户消息 `只回复 OK 并 touch acc-umask.txt` 和模型回复；`spawns` 里 `firstPrompt.state` 为 `delivered` |
| 4   | 在 tmux 外执行 `ls -l` 查看 pi 在 `~/acc-known` 新建的 `acc-umask.txt`（首条消息已要求模型 touch）                | 30s  | 权限为 `-rw-r--r--`（继承 shell 的 umask 022），**不是** 0600（arch §4.2）                                 |
| 5   | `cat /proc/<pid>/cmdline \| tr '\0' ' '`                                                                          | —    | 显示 `pi` 加空白，不含 `--mode`（arch §7.4，只作记录）                                                     |
| 6   | 卡片详情头「停止会话」→ 确认                                                                                      | 13s  | 卡片下线，记录 `exited{user}`；`pgrep -P` 查不到该 pid                                                     |

### A2 孤儿：hub 被 SIGKILL，且之后不再启动 hub

前置：把 fake 换成真实 pi 时无法让它忽略 EOF，所以本用例分两段。

| 步  | 操作                                                                                                                                                                             | 超时 | 预期                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| 1   | 真实 pi：按 A1 建一个会话；记下子进程 pid `P` 与 hub pid `H`（`jq .pid ~/.pi/agent/web-hub/hub.json`）；关掉宿主 pi 的 tmux（防止它重新拉起 hub）：`tmux kill-session -t pwhacc` | —    | —                                                                                              |
| 2   | `kill -9 H`                                                                                                                                                                      | 3s   | `P` 退出（stdin EOF ⇒ 有序 shutdown）                                                          |
| 3   | 用集成测试的 fake（`tests/integration/fixtures/fake-rpc-pi.mjs --ignore-eof`）重复：`npx vitest run tests/integration/web-hub-headless.test.ts -t H2`                            | 30s  | 通过：hub `kill -9` 后 fake 在 ≤12s 内消失；reaper 在 ≤10s 内退出；整个过程没有任何新 hub 进程 |
| 4   | `pgrep -u $USER -fa 'fake-rpc-pi\|pi-webhub\|--disable-warning=ExperimentalWarning -e'`                                                                                          | —    | 空                                                                                             |

### A3 孤儿：hub 与 reaper 同时被杀，下次启动回收

| 步  | 操作                                                              | 超时 | 预期                                                                                                                                |
| --- | ----------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H3` | 60s  | 通过：新 hub 启动后 ≤4s 内 TERM、再 3s 内 KILL；记录 `exited{orphan}`、审计行 `identity:"ok"`；starttime 被篡改的那一轮不发任何信号 |
| 2   | 检查 `~/.pi/agent/web-hub/hub.log` 里的 `audit:"spawn"` 行        | —    | 有 `phase:"state", endReason:"orphan"`；不含任何首条消息正文                                                                        |

### A4 身份判定（真实 pi）

`npm run test:conformance -- tests/conformance/rpc-spawn.test.ts`，超时 60s。预期全绿：真实 pi 注册为 `kind:"rpc"`，`/proc/<pid>/cmdline` 不含 `--mode`，`verifySpawnedIdentity` 返回 ok，stdin EOF 后 8s 内退出。

### A5 超长 UI 请求不挂起

| 步  | 操作                                                                    | 超时 | 预期                                                                                             |
| --- | ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| 1   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H5`       | 30s  | 1 MiB 的 select / confirm / editor 都在 1s 内收到 `cancelled`；坏头部 ⇒ `failed{protocol_error}` |
| 2   | 真机：在 A1 的会话里让模型调用 `ask_user`（1 个问题），在网页对话框作答 | 60s  | 网页出现对话框、作答后模型继续；hub 没有替它应答 `cancelled`（marker 挂起生效）                  |
| 3   | 同上，但在对话框出现后把宿主 hub `kill -9`                              | 15s  | 子进程随 EOF 退出，不挂起                                                                        |

### A6 资源上限

| 步  | 操作                                                              | 超时 | 预期                                                                                        |
| --- | ----------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 1   | 同一浏览器连续创建 3 个会话（`maxPerPrincipal=2`）                | 10s  | 第 3 个返回 409 `E_LIMIT{limit:"principal"}`，界面提示上限；已有 2 个会话不受影响           |
| 2   | 1 分钟内第 4 次提交（`ratePerMinute=3`）                          | 2s   | 429，带 `Retry-After`                                                                       |
| 3   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H6` | 60s  | 全局上限、运行时限（测试钩子 2s）、stderr 洪泛（日志 ≤256 KiB、hub RSS 增长 <32 MiB）均通过 |

### A7 权限与可见性（LAN）

前置：`webHub.lan.enabled=true`，`webHub.spawn.lan="known"`，`/webhub passwd` 建两个用户 `ua`、`ub`；两个浏览器（或无痕窗口）分别登录。

| 步  | 操作                                                                              | 超时 | 预期                                                                                                                     |
| --- | --------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ua` 在 `~/acc-known` 建会话                                                      | 30s  | LAN 下即使是已知目录也弹确认，并有明文警告                                                                               |
| 2   | `ua` 尝试 `~/acc-roots/sub`                                                       | 2s   | 400 `E_DIR{not-allowed}`（明文直连时封顶为 known）                                                                       |
| 3   | `ub` 打开开发者工具看 SSE `spawns` 帧和 `GET /api/headless`                       | —    | 能看到记录和 `cwdLabel`；看不到 `cwd`（会话 live 前）、`stderrTail`、`hintDetail`、`origin.user`；`uiCancelled` 只有计数 |
| 4   | `ub` 停止 `ua` 的会话                                                             | 13s  | 成功（用户裁定：同 hub 全信任）；`hub.log` 审计行记录 `user:"u<ub 的 id>"`                                               |
| 5   | `grep -c '只回复 OK' ~/.pi/agent/web-hub/hub.log ~/.pi/agent/web-hub/spawns.json` | —    | 都是 0（正文从不落盘）                                                                                                   |
| 6   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H7`                 | 30s  | 通过                                                                                                                     |

### A8 未启用 / LAN off 响应矩阵

1. 把 `webHub.spawn.enabled` 改成 `false`，`/reload` 后 `/webhub restart`。
2. 按 arch §8.2 的矩阵逐格 `curl`（loopback 与 LAN，GET 与 POST，带 / 不带 cookie、`X-PWH`、`Origin`），状态码与响应体逐格与矩阵一致；SSE 没有 `spawns` 帧；caps 没有 `spawn.v1`。
3. 改回 `enabled:true`、`lan:"off"`：LAN 面与第 2 步逐格一致，loopback 正常。
4. 自动化对照：`npx vitest run tests/integration/web-hub-headless.test.ts -t H8`。

## 3. S1 非门槛项

| #   | 项目                                             | 预期                                                                                               |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| B1  | 未知目录（roots 内）在 loopback 下               | 弹确认，显示 realpath；确认后创建                                                                  |
| B2  | roots 外目录 `~/acc-outside`                     | 400 `E_DIR{not-allowed}`                                                                           |
| B3  | 符号链接 `~/acc-roots/ln -> ~/acc-outside`       | 400 `E_DIR{not-allowed}`                                                                           |
| B4  | 提交后立即关闭标签页，30s 后重新打开             | 会话已 live，首条消息 `delivered`（hub 转发与浏览器无关）                                          |
| B5  | live 后断网（浏览器 DevTools offline）30s 再恢复 | SSE 重连，快照状态正确，没有重复的首条消息                                                         |
| B6  | 首条消息送达前在 tmux 里 `/webhub restart`       | 记录变为 `exited{hub}`，`firstPrompt` 为 `expired{hub_restart}`；发起页把正文放回 DirPicker        |
| B7  | 冷启动耗时（V3）                                 | 记录 10 次「POST 到 live」的 p50/p95，写进实测记录；p95 > 20s 时重新评估 `registerTimeoutS` 默认值 |
| B8  | 带一个运行中 subagent 时停止（V4）               | 记录是否进入 SIGTERM 阶段与总耗时                                                                  |
| B9  | supersede：网页会话忙时安装新版本                | banner 提示「N 个网页会话将结束」；会话空闲后才替换（或 30 分钟强制）                              |

## 4. S2 验收（不阻塞 S1）

| #   | 项目                       | 预期                                                                          |
| --- | -------------------------- | ----------------------------------------------------------------------------- |
| C1  | 子目录浏览                 | roots 内补全，≤200 项；明文 LAN 不可用                                        |
| C2  | reopen                     | 终态记录可以重新打开；同一会话文件已有 live 进程时返回 409 `E_SESSION_IN_USE` |
| C3  | 空闲回收                   | 忙碌的 agent 不被回收；空闲满 `idleMinutes` 后结束，`endReason:"idle"`        |
| C4  | 模型选择                   | 非法模型字符串被拒；合法时子进程以该模型启动                                  |
| C5  | `setpriv --pdeathsig` 加固 | hub 与 reaper 同时 `kill -9` 时子进程立即收到 SIGTERM                         |

## 5. 收尾

`tmux kill-session -t pwhacc`；对比 `pgrep -u $USER -fa 'pi|node'` 与基线，不得多出进程；按确切路径删除 `$HOME`（`/tmp/pwh-acc-XXXX`）。

## 6. 实测记录

（施工时填写：日期、提交、平台、各用例结论、B7 耗时分布。）
