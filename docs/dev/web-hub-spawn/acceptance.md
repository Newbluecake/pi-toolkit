# web-hub「选择工作目录建会话」真机验收（acceptance v2，SP13 交付）

> 配套：`arch.md`（v2）、`plan.md`（v2.1）。本文是 SP13 的交付物之一。
> **S1 合入硬门槛**：A1–A8 全部通过（对应 plan §4 SP13 的 H1–H8）。S2 项另行验收，不阻塞 S1。
>
> v2 变更：H 系列自动化状态表（§0.5）、真机验证清单（§2 前言）、实测记录（§6）落填；A2/A3/A5/A6/A8
> 的自动化部分已在 SP13 落地，真机步骤保留为最终裁定。

## 0. 平台矩阵

| 平台                                             | 预期                                                                                                                      | 验收                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Linux x86_64（Ubuntu 22.04，内核 5.15）          | 全功能                                                                                                                    | 本文全部步骤                                 |
| WSL2                                             | 全功能                                                                                                                    | A1、A2、A5（抽检）                           |
| Linux，`/proc` 以 `hidepid=2` 挂载或缺 `boot_id` | fail closed：`GET /api/headless` ⇒ `policy.allowed=false, reason:"platform"`；POST ⇒ 403 `E_SPAWN_DENIED`；无 reaper 进程 | 单测覆盖（SP2 `probePlatform`）；真机可选    |
| macOS                                            | fail closed，同上                                                                                                         | 有条件的话跑 §1 第 5 步 + A8；否则以单测为准 |

## 0.5 H1–H8 自动化状态（SP13 落地，2026-10-05）

自动化载体：`tests/integration/web-hub-headless.test.ts`（真实 hub 子进程 + 真实 fake-pi 子进程；
`tests/integration/fixtures/fake-rpc-pi.mjs`）与 `tests/conformance/rpc-spawn.test.ts`（真实 pi）。
断言边界相对 wire 常量放宽（真实调度器），如 L3 的 12s 界断言为 ≤14s。

| #   | 自动化断言（已全绿）                                                                                                                                                                                                                                                              | 载体                       | 真机仍需（终裁）      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------- |
| H1  | hub `kill -9` ⇒ 响应 EOF 的子进程 ≤4s 退出                                                                                                                                                                                                                                        | 集成（jiti 子进程 hub）    | A1 步 1–4（真 pi）    |
| H2  | hub `kill -9` + 子进程 ignore-eof/ignore-term + 不再启动 hub ⇒ 孤儿 ≤14s 消失（reaper 5s 宽限 + TERM +3s KILL），reaper 自身 ≤11s 退出（硬顶 10s）                                                                                                                                | 集成                       | —                     |
| H3  | hub+reaper 同时 `kill -9` ⇒ 新 hub 启动回收：记录 `exited{orphan}`，孤儿经 TERM→KILL ≤12s 死亡；把 spawns.json 的 starttime 改错再跑 ⇒ 不发任何信号（孤儿存活），记录仍终态                                                                                                       | 集成（两轮）               | —                     |
| H4  | 真实 `pi --mode rpc`（临时 HOME、settings 列本包）：`kind:"rpc"` + 自身 pid + 钉住 cwd 的 hello、session 帧、cmdline 无 `--mode`、`verifySpawnedIdentity` ok（另钉 pgrp-mismatch 退化）、EOF ≤8s 退出、V1 帧序（实测帧 + 源码双钉）                                               | conformance                | —                     |
| H5  | 1 MiB 的 select/confirm/editor 单行 ⇒ 头部 ≤512B 立即回 `cancelled`（实测延迟 ≤1.5s）且会话继续；坏头（无可提取 id）⇒ 记录终态 `endReason:"protocol_error"` + `hint:"protocol-error"`，子进程被停                                                                                 | 集成                       | A5 步 2–3（真对话框） |
| H6  | `maxPerPrincipal=1` ⇒ 第二次确认后 POST 409 `E_LIMIT{principal}`；`maxProcesses=2` ⇒ 第三次 409 `E_LIMIT{global,max:2}`；运行时限（测试钩子 3s）⇒ `exited{lifetime}`；50 MiB stderr 洪泛 ⇒ 日志文件 ≤256KiB+截断标记，真实 hub 进程 VmRSS 边际增长 <32MiB（预热基线法，见 §6 注） | 集成（两段）               | A6 步 1–2（速率）     |
| H7  | LAN 双用户：B 对 A 的记录只见 Public 投影 + §6.4 豁免的 cwd（live 绑卡后卡片本就公开的值），`stderrTail`/`hintDetail`/`origin.user`/`firstPrompt.textLen` 不可见；B 停 A 的会话 ⇒ 202；首条消息正文不出现在 SSE、GET、hub.log、spawns.json、子进程 stderr 日志                    | 集成（真实 SQLite LAN 栈） | A7（浏览器双开）      |
| H8  | 未启用矩阵在真实装配 hub 上：loopback GET 401(未登录)/404(登录)/404(无 X-PWH)；POST 401/501 `{"error":"E_NOT_IMPLEMENTED"}`；SSE 无 `spawns` 帧；`hub` 帧 caps 与 `HubInfo.caps` 均无 `spawn.v1`；stateDir 无 spawns.json。LAN 列与 SP9 `headless-matrix.test.ts` 同表（前端层）  | 集成 + SP9 单测            | A8 步 1–3             |

已知实现口径（非缺陷，验收时按此判读）：

- **H5 坏头的终态**是 `exited{protocol_error}`（会话已 live 过）而非 `failed`——SP7 的
  terminalState 语义（`failed` 保留给从未 live 的记录）。
- **H6 运行时限**的真实 hub 子进程形态按配置下限要等 ≥10 分钟，自动化用 in-process 装配的
  sub-floor 钩子（`maxLifetimeMinutes: 0.05`）覆盖同一状态机路径（真实 fork、真实信号、真实时限）。
- **H6 stderr 洪泛**的「吸收完成」信号是 sink 自己的 `[truncated N bytes]` 截断标记——fake 的
  收尾行永远写不进被截断的文件。
- **H7 的 cwd**：live 记录绑定 agent 卡片后，非 owner 也能看到 cwd（arch §6.4 豁免行：卡片本就
  公开）；live 前不可见。owner 专有字段（stderrTail 等）任何时刻都不可见。

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

**真机验证清单（手机/浏览器，`/webhub restart` 后统一做一遍）**：手机浏览器打开 `/webhub open`
的 URL（LAN 或反代均可）→「新建会话 ▾ → 选择目录新建…」→ 选最近目录 → 提交 → 30s 内卡片出现
`web` 徽标并自动跳转 → transcript 可见首条消息往返 → 卡片详情头「停止会话」可用 → 停止后 13s 内
卡片下线。中断链路（飞行模式 30s 再恢复）后页面自愈、状态以快照为准、无重复首条消息。

## 2. S1 硬门槛

### A1 正常闭环

| 步  | 操作                                                                                                              | 超时 | 预期                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 网页「新建会话 ▾ → 选择目录新建…」，选最近目录 `~/acc-known`，首条消息填 `只回复 OK 并 touch acc-umask.txt`，提交 | 2s   | 不弹确认（loopback + 已知目录）；列表顶部出现 `starting` 行                                                |
| 2   | 等待                                                                                                              | 30s  | 出现 `kind:rpc` 卡片并带 `web` 徽标；占位行消失；页面自动跳到该卡片                                        |
| 3   | 观察 transcript                                                                                                   | 60s  | 出现用户消息 `只回复 OK 并 touch acc-umask.txt` 和模型回复；`spawns` 里 `firstPrompt.state` 为 `delivered` |
| 4   | 在 tmux 外执行 `ls -l` 查看 pi 在 `~/acc-known` 新建的 `acc-umask.txt`（首条消息已要求模型 touch）                | 30s  | 权限为 `-rw-r--r--`（继承 shell 的 umask 022），**不是** 0600（arch §4.2）                                 |
| 5   | `cat /proc/<pid>/cmdline \| tr '\0' ' '`                                                                          | —    | 显示 `pi` 加空白，不含 `--mode`（arch §7.4，只作记录；H4 自动化已钉）                                      |
| 6   | 卡片详情头「停止会话」→ 确认                                                                                      | 13s  | 卡片下线，记录 `exited{user}`；`pgrep -P` 查不到该 pid                                                     |

### A2 孤儿：hub 被 SIGKILL，且之后不再启动 hub

前置：把 fake 换成真实 pi 时无法让它忽略 EOF，所以本用例分两段。

| 步  | 操作                                                                                                                                                                                             | 超时 | 预期                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------- |
| 1   | 真实 pi：按 A1 建一个会话；记下子进程 pid `P` 与 hub pid `H`（`jq .pid ~/.pi/agent/web-hub/hub.json`）；关掉宿主 pi 的 tmux（防止它重新拉起 hub）：`tmux kill-session -t pwhacc`                 | —    | —                                                                                              |
| 2   | `kill -9 H`                                                                                                                                                                                      | 3s   | `P` 退出（stdin EOF ⇒ 有序 shutdown）                                                          |
| 3   | 用集成测试的 fake（`tests/integration/fixtures/fake-rpc-pi.mjs --ignore-eof`，开关写在 spawn 目录的 `.fake-pi-switches`）重复：`npx vitest run tests/integration/web-hub-headless.test.ts -t H2` | 30s  | 通过：hub `kill -9` 后 fake 在 ≤14s 内消失；reaper 在 ≤11s 内退出；整个过程没有任何新 hub 进程 |
| 4   | `pgrep -u $USER -fa 'fake-rpc-pi\|pi-webhub\|--disable-warning=ExperimentalWarning -e'`                                                                                                          | —    | 空                                                                                             |

### A3 孤儿：hub 与 reaper 同时被杀，下次启动回收

| 步  | 操作                                                              | 超时 | 预期                                                                                                        |
| --- | ----------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H3` | 60s  | 通过：新 hub 启动后 ≤4s 内 TERM、再 3s 内 KILL；记录 `exited{orphan}`；starttime 被篡改的那一轮不发任何信号 |
| 2   | 检查 `~/.pi/agent/web-hub/hub.log` 里的 `audit:"spawn"` 行        | —    | 有 `phase:"state", endReason:"orphan"`；不含任何首条消息正文                                                |

### A4 身份判定（真实 pi）

`npm run test:conformance -- tests/conformance/rpc-spawn.test.ts`，超时 60s。预期全绿（C1–C6）：真实 pi
注册为 `kind:"rpc"`，`/proc/<pid>/cmdline` 不含 `--mode`，`verifySpawnedIdentity` 返回 ok（外加
非 detached 子进程的 `pgrp-mismatch` 退化钉），stdin EOF 后 8s 内退出，实测 `extension_ui_request`
帧全部 type-first/id-second（V1）。

### A5 超长 UI 请求不挂起

| 步  | 操作                                                                    | 超时 | 预期                                                                                              |
| --- | ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| 1   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H5`       | 30s  | 1 MiB 的 select / confirm / editor 都在 1.5s 内收到 `cancelled`；坏头部 ⇒ 记录终态 protocol_error |
| 2   | 真机：在 A1 的会话里让模型调用 `ask_user`（1 个问题），在网页对话框作答 | 60s  | 网页出现对话框、作答后模型继续；hub 没有替它应答 `cancelled`（marker 挂起生效）                   |
| 3   | 同上，但在对话框出现后把宿主 hub `kill -9`                              | 15s  | 子进程随 EOF 退出，不挂起                                                                         |

### A6 资源上限

| 步  | 操作                                                              | 超时 | 预期                                                                                                                                                   |
| --- | ----------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 同一浏览器连续创建 3 个会话（`maxPerPrincipal=2`）                | 10s  | 第 3 个返回 409 `E_LIMIT{limit:"principal"}`，界面提示上限；已有 2 个会话不受影响                                                                      |
| 2   | 1 分钟内第 4 次提交（`ratePerMinute=3`）                          | 2s   | 429，带 `Retry-After`                                                                                                                                  |
| 3   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H6` | 90s  | 全局上限（409 principal/global）、运行时限（测试钩子 3s ⇒ `exited{lifetime}`）、stderr 洪泛（日志 ≤256 KiB、真实 hub 进程 RSS 边际增长 <32 MiB）均通过 |

### A7 权限与可见性（LAN）

前置：`webHub.lan.enabled=true`，`webHub.spawn.lan="known"`，`/webhub passwd` 建两个用户 `ua`、`ub`；两个浏览器（或无痕窗口）分别登录。

| 步  | 操作                                                                              | 超时 | 预期                                                                                                                                             |
| --- | --------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `ua` 在已知目录建会话（需先用真实会话把目录变成 known，或走 roots+https）         | 30s  | LAN 下即使是已知目录也弹确认，并有明文警告                                                                                                       |
| 2   | `ua` 尝试 roots 内未知目录（明文直连时封顶为 known ⇒ 不可达）                     | 2s   | 400 `E_DIR{not-allowed}`（自动化对 known 域内目录断言 400；roots 直连受信代理路径见 SP9 `lan-headless.test.ts`）                                 |
| 3   | `ub` 打开开发者工具看 SSE `spawns` 帧和 `GET /api/headless`                       | —    | 能看到记录和 `cwdLabel`；live 前 `cwd`、`stderrTail`、`hintDetail`、`origin.user` 不可见（live 后 cwd 是 §6.4 卡片豁免）；`uiCancelled` 只有计数 |
| 4   | `ub` 停止 `ua` 的会话                                                             | 13s  | 成功（用户裁定：同 hub 全信任）；`hub.log` 审计行记录 `user:"u<ub 的 id>"`                                                                       |
| 5   | `grep -c '只回复 OK' ~/.pi/agent/web-hub/hub.log ~/.pi/agent/web-hub/spawns.json` | —    | 都是 0（正文从不落盘）                                                                                                                           |
| 6   | `npx vitest run tests/integration/web-hub-headless.test.ts -t H7`                 | 30s  | 通过                                                                                                                                             |

### A8 未启用 / LAN off 响应矩阵

1. 把 `webHub.spawn.enabled` 改成 `false`，`/reload` 后 `/webhub restart`。
2. 按 arch §8.2 的矩阵逐格 `curl`（loopback 与 LAN，GET 与 POST，带 / 不带 cookie、`X-PWH`、`Origin`），状态码与响应体逐格与矩阵一致；SSE 没有 `spawns` 帧；caps 没有 `spawn.v1`。
3. 改回 `enabled:true`、`lan:"off"`：LAN 面与第 2 步逐格一致，loopback 正常。
4. 自动化对照：`npx vitest run tests/integration/web-hub-headless.test.ts -t H8`（loopback 列，真实装配 hub）与 `tests/web-hub/http/headless-matrix.test.ts`（全矩阵，前端层）。

## 3. S1 非门槛项

| #   | 项目                                             | 预期                                                                                               | 自动化                                                                      |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| B1  | 未知目录（roots 内）在 loopback 下               | 弹确认，显示 realpath；确认后创建                                                                  | 集成（两步确认贯穿全部用例）                                                |
| B2  | roots 外目录 `~/acc-outside`                     | 400 `E_DIR{not-allowed}`                                                                           | SP9 单测（`api-headless`）                                                  |
| B3  | 符号链接 `~/acc-roots/ln -> ~/acc-outside`       | 400 `E_DIR{not-allowed}`                                                                           | SP3 单测（`dirs`）                                                          |
| B4  | 提交后立即关闭标签页，30s 后重新打开             | 会话已 live，首条消息 `delivered`（hub 转发与浏览器无关）                                          | 集成（browser-off 用例）                                                    |
| B5  | live 后断网（浏览器 DevTools offline）30s 再恢复 | SSE 重连，快照状态正确，没有重复的首条消息                                                         | SP11 单测（`use-new-session` (a)/(c)）；真机可选                            |
| B6  | 首条消息送达前在 tmux 里 `/webhub restart`       | 记录变为 `exited{hub}`，`firstPrompt` 为 `expired{hub_restart}`；发起页把正文放回 DirPicker        | 集成（hub close 用例：exited{hub} + 全终态落盘）                            |
| B7  | 冷启动耗时（V3）                                 | 记录 10 次「POST 到 live」的 p50/p95，写进实测记录；p95 > 20s 时重新评估 `registerTimeoutS` 默认值 | 待真机（fake 本地路径 p95 ≪1s，无参考价值）                                 |
| B8  | 带一个运行中 subagent 时停止（V4）               | 记录是否进入 SIGTERM 阶段与总耗时                                                                  | 待真机                                                                      |
| B9  | supersede：网页会话忙时安装新版本                | banner 提示「N 个网页会话将结束」；会话空闲后才替换（或 30 分钟强制）                              | 单测（supersede `managedBusy`；SP13 已并入首条消息在途分量 `sendingCount`） |

## R：restore（受管会话跨 hub 重启恢复）

设计：`docs/dev/web-hub-spawn-restore/plan.md`（§12.4）。前置：`webHub.spawn.enabled: true`，`webHub.spawn.restore`
保持默认 `true`；沿用 §1 的 tmux 会话与临时 `$HOME`。每步结束都用 §5 的方法对比进程基线，并核对
`pgrep -fa PI_WEBHUB_SPAWN_ID`（或 `/proc/*/environ`）中同一 spawnId 的 pi 进程**任何时刻至多一个**（L6）。

| #   | 步骤                                                            | 预期                                                                                                                                                                         |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 网页起两个会话（两个目录），各聊一轮 → TUI 里 `/webhub restart` | 两行 `restoring` SpawnRow（阶段提示 reaping → forking → registering）后，两张卡片回到 live（`web` + `restored` 徽标）；历史完整、模型未变；新 pid ≠ 旧 pid；记录实测恢复耗时 |
| R2  | `kill -9 <hub pid>`（至少一个 TUI 在线，等它自动拉起 hub）      | 自动拉起后恢复到 live；旧 pi 被核验后 TERM（必要时 KILL）结束，不出现两个同 spawnId 的 pi                                                                                    |
| R3  | 恢复进行中刷新浏览器                                            | 只看到 `restoring` 行，没有重复卡片；旧卡片若短暂重连，显示 `restoring` 徽标且 composer 只读（「会话正在恢复中，恢复完成前无法发送。」）                                     |
| R4  | `/webhub stop` → `/webhub start`                                | **不恢复**：记录照旧结局（`exited{hub}`），`<stateDir>/spawn/restore.veto` 被新 hub 消费删除；随后再 `/webhub restart` 时恢复功能照常（restart 先删 veto）                   |
| R5  | 正在查看某受管会话详情时 `/webhub restart`                      | 详情页先显示「正在恢复会话」，恢复完成后自动切到新卡片（URL `#/agent/<新 key>`），不出现「已删除」空态；发起该会话的其它标签页不会被拽走                                     |
| R6  | 失败路径抽查：恢复前手动移走某会话文件后 `/webhub restart`      | 该记录显示 `failed` + 「会话文件已不存在，无法恢复」；其它会话照常恢复                                                                                                       |
| R7  | `webHub.spawn.restore: false` → `/reload` → `/webhub restart`   | 行为与恢复功能上线前一致：受管会话随旧 hub 结束（`exited{hub}`），`spawns.json` 中不出现 `sessionId`/`restore` 等新字段                                                      |

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

- **2026-10-05（SP13 自动化首轮，Linux x86_64 / Node 22.22.1 / 内核 WSL2 环境）**：
  `tests/integration/web-hub-headless.test.ts` **15/15 绿**（H1–H3、H5–H8 + 闭环/幂等/浏览器无关/
  no-hello/flood/停止升级/hub close）；`tests/conformance/rpc-spawn.test.ts` **5/5 绿**（H4）。
  fake 本地 fork→hello→session→live 全链路 <300ms（B7 真机数据仍待补）。
- **H6 RSS 方法注**：50 MiB stderr 洪泛后真实 hub 子进程 VmRSS 首测 +32.6 MiB——其中 ~30 MiB 是 V8
  对约 800 个 64 KiB 管道分片的分配器滞留（GC 前的常态），非 sink 滞留（sink 自身 ring+队列 ≤128 KiB）。
  验收口径改为「预热基线后的边际增长 <32 MiB」（10 MiB 预热洪泛落定后取基线，再过 50 MiB 实测），
  实测边际远低于阈值。若要恢复「首测即 <32 MiB」的字面口径，需要给 hub 进程 `--expose-gc` 或压测式
  堆压力触发 major GC——记为后续可选项，不阻塞。
- **SP13 施工副产品**：fake 夹具曾因 hub 死亡后 stderr EPIPE 触发未捕获异常而「无声退出」，一度让
  H2/H3 的孤儿语义假绿（EOF-IGNORED 的日志写本身撞上断管）。夹具现已加 `stdout/stderr error` 监听
  与 uncaughtException 落盘诊断（`.fake-pi-diag`），并给 `--ignore-eof` 加了 ref'd 保活定时器
  （对齐真实 rpc-mode 的 `new Promise(() => {})`）。任何后续「孤儿提前消失」的排查先看 diag 文件。
