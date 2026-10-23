# 加密会话（pi-secure）真机验收清单

对应 [plan.md](./plan.md) §6「真机验收」与 §2.2–§2.5 的守护点。自动化覆盖在 `tests/secure/**`（含真 gocryptfs 的 `launcher-fuse.test.ts`）与 `tests/conformance/secure-gocryptfs.test.ts`；本清单覆盖**真机手动路径**。这是流程文档，不是「已验收」的声明：逐项勾选并记录实际输出，偏离预期即记 FAIL 与证据。

## 环境与准备

- [ ] Linux（本清单按 Ubuntu 22.04 编写），`gocryptfs --version` ≥ 1.8，`fusermount3`、`flock` 在 `/usr/bin`。
      预期：三条命令都有版本/路径输出；缺失时 `pi-secure init|unlock|run` 报 exit 69（`status` 照常输出并标出缺失项，`lock` 不做前置检查）。
- [ ] `pi-secure` 已安装（`ln -s <仓库路径>/src/secure/bin/pi-secure ~/.local/bin/pi-secure`；配置过保险库后 `/secure status` 也会打印它）。
      预期：`command -v pi-secure` 输出该符号链接；`pi-secure` 无参数时报用法（exit 2）。
- [ ] 准备金丝雀串：`CANARY=$(uuidgen)`（或手抄一个唯一串）。后续所有敏感写入都用它，最后做全盘 grep。
- [ ] 建议在普通（非加密）目录另开一个 pi 会话作对照组；两边的 `pi --version` 一致。

约定：下文 `<name>` 统一用示例名 `acme`；`<state>` = `~/.local/share/pi-toolkit-secure/acme/mnt/state`；`<dir>` = `~/.local/share/pi-toolkit-secure/acme`。

## A. init

- [ ] `pi-secure init acme`（**真实 TTY，不要在管道/重定向下跑**）。
      预期：提示输入两次新口令 → gocryptfs 在终端打印一次 master key（64 个十六进制字符，8 组 × 8）→ 首次挂载再提示一次口令 → 自动建目录、写项目 sessionDir → 结束时自动卸载 → 提示执行 `clear` / `tmux clear-history`。
- [ ] master key 已离线抄写保存（丢失口令且无 master key = 数据不可恢复）。
- [ ] `pi-secure status acme`。
      预期：`not mounted`（locked）· layout ok · 入口链接 ok；无 gocryptfs/swap/core/traffic-record 异常告警（swap/core 视本机配置，可能有提示）。
- [ ] 登记与链接：`grep -n acme ~/.pi/agent/pi-subagent.json` 与 `ls -l ~/secure/acme`。
      预期：settings 里有 `secure.vaults.acme`；`~/secure/acme` 是指向 `<dir>/mnt/work` 的符号链接，且此时 `cd ~/secure/acme` 失败（未挂载时链接目标是哨兵普通文件）。
- [ ] 反例：非 TTY 下 `echo | pi-secure init acme2`。
      预期：exit 2，提示需要 TTY，不留任何产物（`~/.local/share/pi-toolkit-secure/` 下无 `acme2`）。

## B. 迁移已有项目

- [ ] `pi-secure unlock acme` → 输入口令。
      预期：挂载成功；`mountinfo` 含 `fuse.gocryptfs`（`grep gocryptfs /proc/self/mountinfo`）；`<work>/.pi/settings.json` 的 `sessionDir` 指向 `<state>/sessions/default`。
- [ ] `rsync -a ~/ai/acme/ ~/secure/acme/`（含 `.git`）。
- [ ] `pi-secure run acme --version`（冒烟；注意**不带** `--` 分隔）。
      预期：pi 版本输出后立即退出（`--version` 不写会话文件），结束后自动卸载（若有 shell 停在库内，会列出占用 pid 并不卸载）。
- [ ] 库内 git 检查：`cd ~/secure/acme && git status && git rev-parse --git-common-dir`。
      预期：输出路径位于 `~/secure/acme` 内；若是 linked worktree / `.git` 指向库外，加密会话启动时会收到 common-dir 警告（R9）。
- [ ] （可选）旧会话导入：`pi-secure run acme --fork /abs/旧会话.jsonl`（**绝对路径**）。
      预期：会话复制进 `<state>/sessions/default`；相对路径会按库内 cwd 解析而找不到。
- [ ] 迁移收尾：确认新路径一切正常后删除原目录与旧备份，更新 IDE / 脚本绝对路径（SSD 上删除≠擦除，见 R17）。

## C. run 日常

- [ ] `pi-secure run acme`：提示口令 → pi 启动，pi 的 cwd 为物理路径 `<dir>/mnt/work`（`~/secure/acme` 的 realpath）。
      预期：状态栏出现 `secure`；`/secure status` 显示 `加密会话：secure（经 PI_SECURE_VAULT 判定）`、项目根/私有区路径、`TMPDIR=<state>/tmp`、已关闭列表（feishu-notify、xs、droid、cron；worktree 隔离会被拒绝）。
- [ ] pi 退出后 `pi-secure status acme`。
      预期：`not mounted`（自动卸载成功）。
- [ ] `pi-secure run acme -C sub`（项目子目录）。
      预期：pi 的 cwd 为 `<work>/sub`，正常可用。
- [ ] 对照（R6/§2.3）：保持挂载，直接 `cd ~/secure/acme && pi`。
      预期：项目根直接 `pi` 照常落在 vault 内（sessionDir 生效）；而在**子目录**直接 `pi` 会被 LOCKED（见 E 节现象）。用完 `pi-secure lock acme`。

## D. 守护点手测（在 `pi-secure run acme` 的会话内）

- [ ] **D3 写库外**：让模型用 write/edit 写 `/tmp/d3-<canary>.txt`。
      预期：工具被 block，提示目标不在保险库写入区；`/tmp` 下无该文件。（注意 TMPDIR 在库内，shell 的 `>` 重定向属 bash 尽力而为范围，见 R8。）
- [ ] **D3 写入区边界**：write 到 `~/secure/acme/`（= `mnt/work` 哨兵路径本身）与 `<dir>/mnt/` 根层任意新文件。
      预期：都被 block（只允许严格位于 `mnt/work`、`mnt/state` 之下的路径）。
- [ ] **D4 普通会话读库**：对照组（库外目录的普通 pi）里 read/grep/find `~/secure/acme/...` 或 `<dir>/cipher/...`。
      预期：路径类工具被 block；bash 命令文本里出现 vault 路径前缀也被 block（尽力而为）。
- [ ] **D2 worktree**：加密会话内派 `Agent({ isolation: "worktree" })`（或 workflow 的 `isolation:"worktree"`）。
      预期：被拒，报「加密会话不支持 worktree 隔离」类 failed(config)；不产生任何 git 调用/分支。
- [ ] **D8**：`/agent schedule` 新建 cron；`/watch`；如已配置则试 xs/droid。
      预期：cron 创建被拒绝（scheduler 未启动）；设置覆盖使 xs/droid/feishu-notify 呈关闭状态（`/secure status` 的「已关闭」行）。
- [ ] **子会话落盘**：加密会话内派一个子 agent，完成后查 `<state>/sessions/default/`。
      预期：子会话 jsonl 在 `<state>/sessions/default` 下；`~/.pi/agent/sessions/` 无新增对应目录。
- [ ] **跨域打开会话**：普通 pi 进程用 `pi --session <vault 内会话文件>` 启动；反向 `pi-secure run acme --session /abs/库外.jsonl`。
      预期：前者进入会话即 LOCKED（输入与工具被拦，可 `/quit`）；后者 exit 64，在挂载前被拒。（会话中途的跨域切换由 `session_before_switch` 取消，单测已覆盖。）
- [ ] **`--no-session`**：`pi-secure run acme --no-session -p "hi"`。
      预期：正常运行，不写任何会话文件，不被 LOCKED，结束后自动卸载。
- [ ] **参数审查**：`pi-secure run acme --session-dir /tmp/x`（及 `--no-extensions`、`-e path`、`--export`、末尾悬空的 `--session`）。
      预期：exit 64，**不提示口令、不挂载、pi 未被启动**。
- [ ] **D5 traffic-record**：如装有 traffic-record，`/secure status` 底部。
      预期：v0.2.1+ 显示「已声明遵守」；旧版显示 R10 警告；远端安装显示「远端安装，无法在本地核验」提示。

## E. 外部 lock 中途卸载 → LOCKED

- [ ] 会话运行中另开终端：`pi-secure lock acme`（此时 pi 的 cwd 在库内）。
      预期：exit 76「vault 被占用」，列出占用 pid（含 pi 进程），挂载保留。
- [ ] 再执行 `pi-secure lock acme --lazy`（有占用者仍延迟卸载），回到加密会话内发一条消息或调一次工具。
      预期：状态栏切到 `secure:locked`；输入被拦截并给出修复提示；工具被 block；`/quit` 仍可正常退出（不会自动 shutdown）。
- [ ] 恢复：`pi-secure unlock acme` 后重开 `pi-secure run acme`。
      预期：新会话判定为 `secure`，一切正常；被锁的旧进程不可解锁（判定按进程冻结），其会话文件完好，需要时用 `pi-secure run acme --session <id>` 恢复。

## F. hub 派生普通会话不受影响（hubSafeEnv）

- [ ] 前提：`webHub.enabled:true`。在加密会话内执行 `/webhub restart`（或首次自动拉起 hub）。
      预期：hub 正常启动；`/webhub status` 正常。
- [ ] 浏览器打开 web，在一个**普通目录**（库外）新开托管会话并发一条消息。
      预期：普通会话正常回复，**不被 LOCKED**、不被误判 secure；hub 侧该会话的临时文件不在 vault 内（vault 卸载后 web 仍可用）。
- [ ] 反向：在 web 上打开/恢复挂载中的 vault 会话（已挂载时）。
      预期：按 D1 照常可见（明文副本属已接受的 R12）；卸载后再 restore/relaunch 可能失败属 R13，报普通目录错误即可。

## G. /secure status 的 web 面板

- [ ] 浏览器会话输入 `/secure status`。
      预期：返回与 TUI 一致的状态文本（web 命令策略 allow）。
- [ ] 浏览器会话输入 `/secure foo`。
      预期：被拒绝（deny），提示不可用（唯一子命令是 `status`）。

## H. 卸载后磁盘无明文 grep 检查

- [ ] 金丝雀流转：在加密会话内让 `CANARY` 依次经过 read/edit/write、bash（含后台 job）、子 agent、workflow（如启用）、consult、memory 写入，然后正常退出（自动卸载）。
- [ ] `pi-secure status acme` 确认 `not mounted` 后执行（预期：**零命中**——`<dir>/cipher` 是密文不会命中；`<…>/mnt` 未挂载时读不进）：

  ```sh
  grep -rFa "$CANARY" ~/.pi /tmp /var/tmp ~/.local/share/pi-toolkit-secure/*/mnt 2>/dev/null
  ```

注：这只是**终态**检查，不能证明运行期间没写过明文。若执行过 F 节（hub）并经 web / 飞书发送过正文或附件，`~/.pi/agent/web-hub/` 下的明文副本命中属**已接受的 R12**——记录命中路径与数量即可，不算 FAIL；同理 R1（crashes.json）、R4（`/debug`）类命中记录为残留证据。

- [ ] （可选，strace 路线）用假数据 vault 与假口令：`strace -f -e trace=%file pi-secure run acme …`，trace 输出到 0700 目录，检查无 vault 外的创建/写入（只记路径不记缓冲，见 plan §6 第 3 条）。

## I. 故障路径（顺手各验一次）

- [ ] 口令连错 3 次：`pi-secure unlock acme` 故意输错。
      预期：三次尝试（间隔约 1s/2s/4s），exit 77，未挂载，锁未被长期占用（随后正确口令可立即解锁）。
- [ ] stale 挂载：`pkill -9 gocryptfs` 后 `pi-secure status acme`。
      预期：显示 stale（ENOTCONN）；`unlock` 或 `lock` 能清理并恢复。
- [ ] 残留挂载 exit 75：模拟收尾超时（或直接观察一次真实超时）。
      预期：stderr 一行「卸载未完成，保险库 acme 可能仍挂载」，exit 75；`pi-secure status` / `lock` 后续能收敛。
- [ ] `pi-secure lock acme` 在另一个 pi-secure 持有 mount.lock 时执行。
      预期：exit 73「另一个 pi-secure 正在挂载或卸载」，不阻塞超过约 10s。

## 记录

| 节  | 结果（pass/fail/未执行） | 证据（输出摘录 / 截图路径） | 备注 |
| --- | ------------------------ | --------------------------- | ---- |
| A   |                          |                             |      |
| B   |                          |                             |      |
| C   |                          |                             |      |
| D   |                          |                             |      |
| E   |                          |                             |      |
| F   |                          |                             |      |
| G   |                          |                             |      |
| H   |                          |                             |      |
| I   |                          |                             |      |
